import path from "node:path";
import { prisma } from "@/lib/db";
import {
  executeTrustedBrowserStage,
} from "@/lib/autonomy/one-shot-stage";
import {
  relockOneShotPolicy,
  selectMechanicalDraft,
  TRUSTED_ONE_SHOT_DAILY_ACTION_LIMIT
} from "@/lib/autonomy/one-shot-execution";
import {
  inspectOneShotReadiness
} from "@/lib/autonomy/one-shot-runner";
import { CmoocQuillStageCompanionDriver } from "@/lib/live-runtime/cmooc-quill-stage-driver";
import { openCmoocQuillStageBrowserBridge } from "@/lib/live-runtime/cmooc-quill-stage-browser-bridge";
import {
  projectL3CliErrorCode
} from "@/lib/autonomy/l3-cli-error";
import {
  reconcileOneShotOutcomeUnknown
} from "@/lib/autonomy/one-shot-outcome-reconciliation";
import {
  loadOrCreateLocalEvidenceSecret
} from "@/lib/privacy/local-evidence-hmac";
import {
  assertTrustedStagePublishGuards,
  executeTrustedStageAndPublish,
  projectTrustedStageResult
} from "@/lib/autonomy/trusted-stage-publication";

const COURSE_ALIAS = "bnu-test";

const createTrustedDriver: Parameters<
  typeof executeTrustedBrowserStage
>[0]["driverFactory"] = async (binding) => {
  const bridge = await openCmoocQuillStageBrowserBridge({
    targetUrl: binding.targetUrl,
    allowedOrigin: binding.expectedPage.origin,
    storageStatePath: path.join(
      process.cwd(),
      "playwright",
      "auth-state.json"
    )
  });
  try {
    const driver = new CmoocQuillStageCompanionDriver({
      bridge,
      expectedPage: {
        ...binding.expectedPage,
        activeTab: true,
        pageReady: true,
        editorVisible: true
      },
      expectedTargetUrl: binding.targetUrl
    });
    return Object.assign(driver, {
      close: () => bridge.close()
    });
  } catch (error) {
    await bridge.close().catch(() => undefined);
    throw error;
  }
};

async function main() {
  const command = process.argv[2];
  if (command === "preflight") {
    return inspectOneShotReadiness({
      prisma,
      courseAlias: COURSE_ALIAS
    });
  }
  if (command === "stage-browser") {
    if (process.env.CMOOC_L3_TRUSTED_STAGE_BRIDGE !== "1") {
      throw new Error("L3_TRUSTED_STAGE_BRIDGE_GUARD_REQUIRED");
    }
    const staged = await executeTrustedBrowserStage({
      prisma,
      courseAlias: COURSE_ALIAS,
      retainPolicyForImmediatePublication: false,
      authorizedDailyActionLimit: TRUSTED_ONE_SHOT_DAILY_ACTION_LIMIT,
      driverFactory: createTrustedDriver
    });
    return projectTrustedStageResult(staged);
  }
  if (command === "stage-and-publish") {
    assertTrustedStagePublishGuards(process.env);
    return executeTrustedStageAndPublish({
      prisma,
      courseAlias: COURSE_ALIAS,
      driverFactory: createTrustedDriver
    });
  }
  if (command === "browser-payload") {
    throw new Error("L3_BROWSER_PIPE_DISABLED");
  }
  if (command === "record-stage") {
    throw new Error("L3_BROWSER_PIPE_DISABLED");
  }
  if (command === "publish") {
    throw new Error("L3_STANDALONE_PUBLISH_DISABLED");
  }
  if (command === "relock") {
    return relockOneShotPolicy({
      prisma,
      courseAlias: COURSE_ALIAS,
      now: new Date()
    });
  }
  if (command === "reconcile-outcome") {
    if (
      process.env.CMOOC_L3_OUTCOME_RECONCILIATION !== "1"
    ) {
      throw new Error(
        "L3_OUTCOME_RECONCILIATION_GUARD_REQUIRED"
      );
    }
    const secret = await loadOrCreateLocalEvidenceSecret();
    const reconciled = await reconcileOneShotOutcomeUnknown({
      prisma,
      courseAlias: COURSE_ALIAS,
      now: new Date(),
      secret
    });
    return {
      status: reconciled.status,
      attemptedReadCount: reconciled.attemptedReadCount,
      successfulReadCount: reconciled.successfulReadCount,
      emptyCommentReadCount: reconciled.emptyCommentReadCount,
      totalCommentCount: reconciled.totalCommentCount,
      transitionIdempotent: reconciled.transitionIdempotent,
      manifestLocked: reconciled.manifestLocked,
      globalHardLock: reconciled.globalHardLock,
      blockingRealAttemptCount:
        reconciled.blockingRealAttemptCount,
      containsForumText: false
    } as const;
  }
  if (command === "status") {
    const selection = await selectMechanicalDraft({
      prisma,
      courseAlias: COURSE_ALIAS
    });
    const [manifest, policies, permits, attempts, stages] =
      await Promise.all([
        prisma.autonomyCourseManifest.findUniqueOrThrow({
          where: { alias: COURSE_ALIAS }
        }),
        prisma.autonomyPolicy.count({
          where: {
            courseAlias: COURSE_ALIAS,
            realPublishEnabled: true,
            status: "active"
          }
        }),
        prisma.executionPermit.count({
          where: {
            courseAlias: COURSE_ALIAS,
            realPublishEnabled: true
          }
        }),
        prisma.executionAttempt.count({
          where: {
            decision: { courseAlias: COURSE_ALIAS },
            transport: "real_platform"
          }
        }),
        prisma.executionStageReceipt.count({
          where: { courseAlias: COURSE_ALIAS }
        })
      ]);
    return {
      courseAlias: COURSE_ALIAS,
      selectionHash: selection.selectionHash,
      candidateOrdinal: selection.candidateOrdinal,
      candidateCount: selection.candidateCount,
      manifestRealPublishEnabled:
        manifest.realPublishEnabled,
      activeRealPolicyCount: policies,
      realPermitCount: permits,
      realAttemptCount: attempts,
      stageReceiptCount: stages,
      containsForumText: false
    };
  }
  throw new Error("L3_COMMAND_UNKNOWN");
}

main()
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })
.catch((error) => {
    const code = projectL3CliErrorCode(error);
    process.stderr.write(
      `${JSON.stringify({ ok: false, code, containsForumText: false })}\n`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
