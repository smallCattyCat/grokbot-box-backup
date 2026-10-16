import { createHash, randomBytes } from "node:crypto";
import type {
  AutonomyCourseManifest,
  PrismaClient,
  ScheduledInvocation
} from "@prisma/client";
import {
  canonicalProtocolHash
} from "@/lib/facilitation-protocol";
import {
  issueStageCompanionToken,
  executeStageCompanionRun,
  type SignedStageCompanionToken,
  type StageCompanionReceiptV2,
  type TrustedStageCompanionDriver
} from "@/lib/live-runtime/stage-companion";
import {
  PrismaStageRunNonceRegistry
} from "@/lib/live-runtime/stage-run-nonce-registry";
import {
  loadOrCreateLocalEvidenceSecret
} from "@/lib/privacy/local-evidence-hmac";
import {
  hashTransientDraftBody
} from "@/lib/live-runtime/draft-content";
import { loadCourseManifest } from "./course-manifest";
import {
  locateTransientExecutionTarget
} from "./execution-target";
import {
  activateOneShotPolicy,
  recoverExpiredOneShotPolicy,
  relockOneShotPolicy,
  selectMechanicalDraft,
  type OneShotPublicationHandoff
} from "./one-shot-execution";
import {
  assertExecutionStageTapeBinding,
  EXECUTION_STAGE_VERIFIED_TAPE_SCHEMA_VERSION,
  recordVerifiedExecutionStage
} from "./execution-stage-receipt";
export {
  assertExecutionStageTapeBinding,
  verifyExecutionStageTapeBinding
} from "./execution-stage-receipt";
import {
  assertOneShotManifestBinding,
  appendOneShotDecisionTapeEntry,
  hashOneShotOpaque,
  inspectOneShotReadiness
} from "./one-shot-runner";

type ClosableTrustedStageCompanionDriver =
  TrustedStageCompanionDriver & {
    close: () => Promise<void>;
  };

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertSelectionHashStable(
  expectedSelectionHash: string,
  actualSelectionHash: string
): void {
  if (expectedSelectionHash !== actualSelectionHash) {
    throw new Error("L3_STAGE_SELECTION_CHANGED");
  }
}

function preserveStableL3Error(
  error: unknown,
  fallback: string
): never {
  if (
    error instanceof Error &&
    /^L3_[A-Z0-9_]+$/.test(error.message)
  ) {
    throw error;
  }
  throw new Error(fallback);
}

export type BrowserStagePayload = {
  targetUrl: string;
  transientBody: string;
  decisionId: string;
  executionPolicyVersion: string;
  selectionHash: string;
  token: SignedStageCompanionToken;
  /** In-process only; never serialize this payload to CLI output. */
  handoff: OneShotPublicationHandoff;
  expectedPage: {
    origin: string;
    courseAlias: string;
    courseLocatorHash: string;
    pageIdentityHash: string;
    driverSessionKey: string;
    targetVersionHash: string;
    containsForumText: false;
  };
};

export type TrustedBrowserStageBinding = {
  targetUrl: string;
  expectedPage: BrowserStagePayload["expectedPage"];
  containsForumText: false;
};

/**
 * Records the durable, redacted fact that the editor STAGE contract was
 * verified and cleared. The database receipt is written first; a tape failure
 * is intentionally surfaced so callers cannot report a verified stage whose
 * audit fact is missing.
 */
export async function appendExecutionStageVerifiedTape(input: {
  prisma: PrismaClient;
  decisionId: string;
  executionPolicyVersion: string;
  receipt: StageCompanionReceiptV2;
  receiptHash: string;
  now: Date;
}): Promise<void> {
  const decision =
    await input.prisma.autonomyDecision.findUnique({
      where: { id: input.decisionId },
      select: { invocationId: true }
    });
  if (!decision) {
    throw new Error("L3_STAGE_DECISION_NOT_FOUND");
  }
  const policyHash = hashOneShotOpaque(
    "cmooc.l3-execution-policy-version-opaque.v1",
    input.executionPolicyVersion
  );
  await appendOneShotDecisionTapeEntry({
    prisma: input.prisma,
    invocationId: decision.invocationId,
    kind: "execution_stage_verified",
    receiptHash: input.receiptHash,
    payload: {
      schemaVersion:
        EXECUTION_STAGE_VERIFIED_TAPE_SCHEMA_VERSION,
      receiptHash: input.receiptHash,
      policyHash,
      targetVersionHash: input.receipt.targetVersionHash,
      draftContentHash: input.receipt.draftContentHash,
      status: "verified_cleared",
      editorWriteCount: input.receipt.editorWriteCount,
      editorClearCount: input.receipt.editorClearCount,
      sentMutationCount: input.receipt.sentMutationCount,
      observedAt: input.receipt.observedAt,
      realPublishEnabled: input.receipt.realPublishEnabled,
      containsForumText: false
    }
  });
  await assertExecutionStageTapeBinding({
    prisma: input.prisma,
    decisionId: input.decisionId,
    receiptHash: input.receiptHash
  });
}

export async function persistVerifiedBrowserStage(input: {
  prisma: PrismaClient;
  decisionId: string;
  executionPolicyVersion: string;
  receipt: StageCompanionReceiptV2;
  receiptHash: string;
  now: Date;
}) {
  const stored = await recordVerifiedExecutionStage({
    prisma: input.prisma,
    decisionId: input.decisionId,
    policyVersion: input.executionPolicyVersion,
    receipt: input.receipt,
    receiptHash: input.receiptHash,
    now: input.now,
    expiresInSeconds: 300
  });
  await input.prisma.autonomyDecision.update({
    where: { id: input.decisionId },
    data: { editorWriteAttempted: true }
  });
  await appendExecutionStageVerifiedTape({
    prisma: input.prisma,
    decisionId: input.decisionId,
    executionPolicyVersion:
      input.executionPolicyVersion,
    receipt: input.receipt,
    receiptHash: input.receiptHash,
    now: input.now
  });
  return {
    receiptHash: stored.receiptHash,
    status: stored.status,
    editorWriteCount: stored.editorWriteCount,
    editorClearCount: stored.editorClearCount,
    sentMutationCount: stored.sentMutationCount,
    publishAttempted: stored.publishAttempted,
    containsForumText: false as const
  };
}

async function prepareBrowserStagePayload(input: {
  prisma: PrismaClient;
  courseAlias: string;
  now?: Date;
  authorizedDailyActionLimit?: number;
  validForMinutes?: number;
}): Promise<BrowserStagePayload> {
  const now = input.now ?? new Date();
  // The preflight is mandatory and must complete while the persistent
  // manifest, setting, policies, permits and attempts are cleanly locked.
  // It also performs the target re-read and write-auth check before AUTO is
  // activated below.
  let readiness: Awaited<
    ReturnType<typeof inspectOneShotReadiness>
  >;
  try {
    readiness = await inspectOneShotReadiness({
      prisma: input.prisma,
      courseAlias: input.courseAlias
    });
  } catch (error) {
    preserveStableL3Error(error, "L3_PREFLIGHT_FAILED");
  }
  let manifest: Awaited<ReturnType<typeof loadCourseManifest>>;
  let secret: Awaited<
    ReturnType<typeof loadOrCreateLocalEvidenceSecret>
  >;
  let selection: Awaited<ReturnType<typeof selectMechanicalDraft>>;
  try {
    [manifest, secret, selection] = await Promise.all([
      loadCourseManifest(input.courseAlias),
      loadOrCreateLocalEvidenceSecret(),
      selectMechanicalDraft({
        prisma: input.prisma,
        courseAlias: input.courseAlias
      })
    ]);
  } catch (error) {
    preserveStableL3Error(error, "L3_STAGE_PREPARATION_INPUT_INVALID");
  }
  assertSelectionHashStable(
    readiness.selectionHash,
    selection.selectionHash
  );

  // Re-bind the second disk read and DB state immediately before policy
  // activation. This closes the gap between preflight and AUTO promotion if
  // either the manifest file or selected invocation changed in the meantime.
  let preActivationManifestState:
    | Pick<
        AutonomyCourseManifest,
        | "alias"
        | "manifestHash"
        | "policyVersion"
        | "enabled"
        | "realPublishEnabled"
      >
    | null;
  let preActivationInvocation:
    | Pick<
        ScheduledInvocation,
        | "id"
        | "courseAlias"
        | "manifestHash"
        | "mode"
        | "status"
        | "phase"
      >
    | null;
  try {
    [preActivationManifestState, preActivationInvocation] =
      await Promise.all([
        input.prisma.autonomyCourseManifest.findUnique({
          where: { alias: input.courseAlias }
        }),
        input.prisma.scheduledInvocation.findUnique({
          where: { id: selection.decision.invocationId },
          select: {
            id: true,
            courseAlias: true,
            manifestHash: true,
            mode: true,
            status: true,
            phase: true
          }
        })
      ]);
  } catch {
    throw new Error("L3_STAGE_MANIFEST_BINDING_READ_FAILED");
  }
  if (!preActivationManifestState) {
    throw new Error("L3_MANIFEST_BINDING_MISMATCH");
  }
  if (!preActivationInvocation) {
    throw new Error("L3_SHADOW_INVOCATION_BINDING_MISMATCH");
  }
  assertOneShotManifestBinding({
    courseAlias: input.courseAlias,
    manifest,
    manifestState: preActivationManifestState,
    invocation: preActivationInvocation,
    decision: selection.decision,
    expectedDbRealPublishEnabled: false
  });

  let policy: Awaited<ReturnType<typeof activateOneShotPolicy>>;
  // Set only after activation commits a policy created by this invocation.
  // A preflight/activation loser leaves this null and must never relock a
  // concurrently-owned winner.
  let ownedPolicyVersion: string | null = null;
  try {
    policy = await activateOneShotPolicy({
      prisma: input.prisma,
      courseAlias: input.courseAlias,
      selectionHash: selection.selectionHash,
      now,
      dailyActionLimit: input.authorizedDailyActionLimit,
      validForMinutes: input.validForMinutes
    });
    ownedPolicyVersion = policy.version;

    // Re-select after activation as a race check. A changed candidate or
    // invocation is never allowed to inherit a staged receipt from another
    // invocation. No STAGE receipt exists yet for this invocation, so this
    // read intentionally uses the clean (unstaged) selection path.
    const reselected = await selectMechanicalDraft({
      prisma: input.prisma,
      courseAlias: input.courseAlias
    });
    assertSelectionHashStable(
      selection.selectionHash,
      reselected.selectionHash
    );
    selection = reselected;

    const [manifestState, invocation] = await Promise.all([
      input.prisma.autonomyCourseManifest.findUnique({
        where: { alias: input.courseAlias }
      }),
      input.prisma.scheduledInvocation.findUnique({
        where: { id: selection.decision.invocationId },
        select: {
          id: true,
          courseAlias: true,
          manifestHash: true,
          mode: true,
          status: true,
          phase: true
        }
      })
    ]);
    if (!manifestState) {
      throw new Error("L3_MANIFEST_BINDING_MISMATCH");
    }
    if (!invocation) {
      throw new Error("L3_SHADOW_INVOCATION_BINDING_MISMATCH");
    }
    assertOneShotManifestBinding({
      courseAlias: input.courseAlias,
      manifest,
      manifestState,
      invocation,
      decision: selection.decision,
      expectedDbRealPublishEnabled: true
    });

    const located = await locateTransientExecutionTarget({
      manifest,
      threadKey: selection.decision.threadKey,
      secret,
      observedAt: now
    });
    if (
      located.target.targetVersionHash !==
      located.preExecutionObservation.receipt.targetVersionHash
    ) {
      throw new Error("L3_STAGE_TARGET_INTERNAL_MISMATCH");
    }
    const observation =
      await input.prisma.autonomyObservation.findUnique({
        where: {
          receiptHash: selection.decision.observationReceiptHash
        }
      });
    if (!observation) {
      throw new Error("L3_STAGE_OBSERVATION_INVALID");
    }
    let persistedObservation: Record<string, unknown>;
    try {
      persistedObservation = JSON.parse(
        observation.receiptJson
      ) as Record<string, unknown>;
    } catch {
      throw new Error("L3_STAGE_OBSERVATION_INVALID");
    }
    if (
      typeof persistedObservation.targetVersionHash !==
        "string" ||
      typeof persistedObservation.eventSetHash !== "string" ||
      persistedObservation.targetVersionHash !==
        located.target.targetVersionHash ||
      persistedObservation.eventSetHash !==
        located.target.eventSetHash
    ) {
      throw new Error("L3_STAGE_TARGET_CHANGED_SINCE_DECISION");
    }
    let origin: string;
    try {
      origin = new URL(located.target.postUrl).origin;
    } catch {
      throw new Error("L3_STAGE_TARGET_ORIGIN_NOT_ALLOWED");
    }
    if (!manifest.allowedOrigins.includes(origin)) {
      throw new Error("L3_STAGE_TARGET_ORIGIN_NOT_ALLOWED");
    }
    const courseLocatorHash = canonicalProtocolHash(
      "cmooc.l3-course-locator.v1",
      manifest.canonicalUrl
    );
    const pageIdentityHash = canonicalProtocolHash(
      "cmooc.l3-stage-page.v1",
      {
        selectionHash: selection.selectionHash,
        threadKey: selection.decision.threadKey,
        targetVersionHash: located.target.targetVersionHash,
        containsForumText: false
      }
    );
    const driverSessionKey = hash(
      randomBytes(32).toString("base64url")
    );
    const guardReceiptHash = hash(
      randomBytes(32).toString("base64url")
    );
    const transientDraftHash = hashTransientDraftBody(
      selection.transientBody
    );
    if (
      transientDraftHash !==
      selection.decision.draftContentHash
    ) {
      throw new Error("L3_STAGE_DRAFT_HASH_MISMATCH");
    }
    const token = issueStageCompanionToken({
      courseAlias: input.courseAlias,
      allowedOrigin: origin,
      courseLocatorHash,
      pageIdentityHash,
      driverSessionKey,
      opportunityReceiptHash:
        selection.decision.opportunityReceiptHash,
      revalidationReceiptHash:
        selection.revalidationReceiptHash,
      afterObservationReceiptHash:
        located.preExecutionObservation.receiptHash,
      guardReceiptHash,
      targetVersionHash: located.target.targetVersionHash,
      draftContentHash: transientDraftHash,
      signingSecret: secret,
      now,
      expiresInSeconds: 300
    });
    return {
      targetUrl: located.target.postUrl,
      transientBody: selection.transientBody,
      decisionId: selection.decision.id,
      executionPolicyVersion: policy.version,
      selectionHash: selection.selectionHash,
      handoff: {
        decisionId: selection.decision.id,
        selectionHash: selection.selectionHash,
        policyVersion: policy.version
      },
      token,
      expectedPage: {
        origin,
        courseAlias: input.courseAlias,
        courseLocatorHash,
        pageIdentityHash,
        driverSessionKey,
        targetVersionHash: located.target.targetVersionHash,
        containsForumText: false
      }
    };
  } catch (error) {
    if (ownedPolicyVersion !== null) {
      try {
        const relocked = await relockOneShotPolicy({
          prisma: input.prisma,
          courseAlias: input.courseAlias,
          ownedPolicyVersion,
          now: new Date()
        });
        if (!relocked.manifestLocked || !relocked.globalHardLock) {
          throw new Error("L3_STAGE_RELOCK_FAILED");
        }
      } catch (relockError) {
        preserveStableL3Error(
          relockError,
          "L3_STAGE_RELOCK_FAILED"
        );
      }
    }
    preserveStableL3Error(error, "L3_STAGE_PREPARATION_FAILED");
  }
}

/**
 * Runs the signed STAGE contract through a trusted browser driver and persists
 * only the verified, cleared, zero-mutation receipt. Driver or readback
 * failures always relock the one-shot policy. A successful STAGE also relocks
 * by default; retaining the policy is an explicit handoff for an immediately
 * authorized publication call, never an implicit side effect.
 */
export async function executeTrustedBrowserStage(input: {
  prisma: PrismaClient;
  courseAlias: string;
  driverFactory: (
    binding: TrustedBrowserStageBinding
  ) =>
    | ClosableTrustedStageCompanionDriver
    | Promise<ClosableTrustedStageCompanionDriver>;
  authorizedDailyActionLimit?: number;
  validForMinutes?: number;
  retainPolicyForImmediatePublication?: boolean;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  let completed = false;
  let driver: ClosableTrustedStageCompanionDriver | null = null;
  let result:
    | Awaited<
        ReturnType<typeof persistVerifiedBrowserStage>
    >
    | null = null;
  let ownedPolicyVersion: string | null = null;
  try {
    // Recover a stale active policy before any readiness/preflight read or
    // AUTO activation.  The recovery helper is local-only and fail-closed;
    // if it cannot prove a clean hard relock, no browser driver is opened.
    await recoverExpiredOneShotPolicy({
      prisma: input.prisma,
      courseAlias: input.courseAlias,
      now: now()
    });
    const payload = await prepareBrowserStagePayload({
      prisma: input.prisma,
      courseAlias: input.courseAlias,
      now: now(),
      authorizedDailyActionLimit:
        input.authorizedDailyActionLimit,
      validForMinutes: input.validForMinutes
    });
    ownedPolicyVersion = payload.executionPolicyVersion;
    // Load the local signing secret before opening the browser.  Keeping these
    // operations sequential ensures a driver is never orphaned if secret
    // loading fails between Promise.all branches.
    const secret = await loadOrCreateLocalEvidenceSecret();
    const createdDriver = await input.driverFactory({
      targetUrl: payload.targetUrl,
      expectedPage: payload.expectedPage,
      containsForumText: false
    });
    if (typeof createdDriver.close !== "function") {
      throw new Error("L3_TRUSTED_STAGE_CLOSE_REQUIRED");
    }
    // Keep the driver in scope for the finally block.  A bridge owns the
    // browser/context/page lifecycle and must be closed after every path.
    driver = createdDriver;
    const staged = await executeStageCompanionRun({
      token: payload.token,
      signingSecret: secret,
      nonceRegistry: new PrismaStageRunNonceRegistry(
        input.prisma
      ),
      driver,
      transientDraft: payload.transientBody,
      now
    });
    // A trusted browser bridge owns external browser resources and its close
    // operation is the final audit barrier.  Persist the verified STAGE fact
    // only after the page/context/browser have all closed successfully; a
    // late blocked request, download, websocket, or close failure must never
    // become a durable verified receipt.
    await driver.close();
    driver = null;
    result = await persistVerifiedBrowserStage({
      prisma: input.prisma,
      decisionId: payload.decisionId,
      executionPolicyVersion:
        payload.executionPolicyVersion,
      receipt: staged.receipt,
      receiptHash: staged.receiptHash,
      now: now()
    });
    completed = true;
    return {
      ...result,
      policyRetainedForImmediatePublication:
        input.retainPolicyForImmediatePublication === true,
      // Keep the exact decision/selection/policy binding in process memory so
      // the caller can hand it directly to publication.  The CLI projection
      // deliberately strips these identifiers.
      handoff: payload.handoff,
      containsForumText: false as const
    };
  } finally {
    let closeFailed = false;
    try {
      await driver?.close?.();
    } catch {
      // Do not replace a stage/persistence failure with a cleanup failure.
      // On a successful stage, surface a stable close error after relock.
      closeFailed = completed;
    }
    if (
      !completed ||
      closeFailed ||
      input.retainPolicyForImmediatePublication !== true
    ) {
      // A payload is returned only after activation succeeded, so its policy
      // version is the ownership proof for cleanup after a driver/persistence
      // failure.  If preparation lost a race before returning a payload, no
      // relock is attempted here.
      if (ownedPolicyVersion !== null) {
        const relocked = await relockOneShotPolicy({
          prisma: input.prisma,
          courseAlias: input.courseAlias,
          ownedPolicyVersion,
          now: now()
        });
        if (
          !relocked.manifestLocked ||
          !relocked.globalHardLock
        ) {
          throw new Error("L3_TRUSTED_STAGE_RELOCK_FAILED");
        }
      }
    }
    if (closeFailed) {
      throw new Error("L3_TRUSTED_STAGE_CLOSE_FAILED");
    }
  }
}
