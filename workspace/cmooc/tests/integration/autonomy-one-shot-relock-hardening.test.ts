import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  activateOneShotPolicy,
  recoverExpiredOneShotPolicy,
  relockOneShotPolicy
} from "../../lib/autonomy/one-shot-execution";
import {
  AUTONOMY_POLICY_SCHEMA_VERSION,
  registerCourseAutonomyPolicy
} from "../../lib/autonomy/autonomy-policy";
import {
  abortPreparedExecutionAttempt,
  claimExecutionPermit,
  hashPreExecutionTargetObservation,
  issueExecutionPermit,
  markExecutionAttemptSending,
  PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
  revokeExecutionPermit
} from "../../lib/autonomy/execution-permit";
import { acquire } from "../../lib/autonomy/execution-account-pool";
import { recordVerifiedExecutionStage } from "../../lib/autonomy/execution-stage-receipt";
import {
  STAGE_COMPANION_RECEIPT_SCHEMA_VERSION,
  type StageCompanionReceipt
} from "../../lib/live-runtime/stage-companion";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "../../lib/facilitation-protocol";
import { executeTrustedBrowserStage } from "../../lib/autonomy/one-shot-stage";
import { appendExecutionStageVerifiedTape } from "../../lib/autonomy/one-shot-stage";

const COURSE_PREFIX = "one-shot-relock-hardening";

function nonce(label: string): string {
  return `${COURSE_PREFIX}-${label}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createTemporaryPrisma(): Promise<{
  prisma: PrismaClient;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "cmooc-one-shot-"));
  const databaseUrl = `file:${join(directory, "test.db")}`;
  execFileSync(
    process.execPath,
    [
      join(process.cwd(), "node_modules", "prisma", "build", "index.js"),
      "migrate",
      "deploy",
      "--schema",
      "prisma/schema.prisma"
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "ignore"
    }
  );
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } }
  });
  return { prisma, directory };
}

async function createManifest(
  prisma: PrismaClient,
  courseAlias: string
): Promise<void> {
  await prisma.autonomyCourseManifest.create({
    data: {
      alias: courseAlias,
      manifestHash: nonce(`${courseAlias}-manifest`),
      platformId: "synthetic.platform",
      platformCourseRefHash: nonce(`${courseAlias}-course`),
      canonicalLocatorHash: nonce(`${courseAlias}-locator`),
      identityKeyFingerprint: nonce(`${courseAlias}-identity`),
      allowedOrigin: "https://synthetic.example.test",
      timeZone: "UTC",
      defaultMode: "SHADOW",
      policyVersion: "synthetic.policy.v1",
      enabled: true,
      realPublishEnabled: false
    }
  });
}

async function withTemporaryPrisma<T>(
  callback: (prisma: PrismaClient) => Promise<T>
): Promise<T> {
  const { prisma, directory } = await createTemporaryPrisma();
  try {
    return await callback(prisma);
  } finally {
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}

type ExpiredCleanupFixture = {
  courseAlias: string;
  invocationId: string;
  decisionId: string;
  permitKey: string;
  permitId: string;
  leaseId: string;
  attemptId: string;
  cleanupNow: Date;
  preExecutionObservation: {
    receipt: {
      schemaVersion: typeof PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION;
      courseAlias: string;
      threadKey: string;
      targetVersionHash: string;
      eventSetHash: string;
      observedAt: string;
      containsForumText: false;
    };
    receiptHash: string;
  };
};

async function createExpiredCleanupFixture(
  prisma: PrismaClient,
  suffix: string,
  withPreparedAttempt: boolean
): Promise<ExpiredCleanupFixture> {
  const courseAlias = `${COURSE_PREFIX}-expired-${suffix}`;
  const now = new Date("2026-08-09T16:00:00.000Z");
  const cleanupNow = new Date(now.getTime() + 10 * 60_000);
  const invocationId = nonce(`${courseAlias}-invocation`);
  const decisionId = nonce(`${courseAlias}-decision`);
  const policyVersion = `${courseAlias}.v1`;
  const threadKey = hash(`${courseAlias}-thread`);
  const targetVersionHash = hash(`${courseAlias}-target-version`);
  const eventSetHash = hash(`${courseAlias}-event-set`);
  const contentHash = hash(`${courseAlias}-draft`);
  await createManifest(prisma, courseAlias);
  const manifest = await prisma.autonomyCourseManifest.update({
    where: { alias: courseAlias },
    data: {
      policyVersion,
      realPublishEnabled: true
    }
  });
  await prisma.scheduledInvocation.create({
    data: {
      id: invocationId,
      invocationKey: nonce(`${courseAlias}-invocation-key`),
      courseAlias,
      manifestHash: manifest.manifestHash,
      scheduledFor: now,
      mode: "SHADOW",
      status: "completed",
      phase: "completed",
      attempt: 1,
      startedAt: now,
      finishedAt: now,
      summaryJson: JSON.stringify({ containsForumText: false })
    }
  });
  const observation = {
    schemaVersion: "cmooc.expired-cleanup-observation.v1",
    threadKey,
    targetVersionHash,
    eventSetHash,
    containsForumText: false
  } as const;
  const observationReceiptHash = canonicalProtocolHash(
    observation.schemaVersion,
    observation as unknown as CanonicalJsonValue
  );
  await prisma.autonomyObservation.create({
    data: {
      invocationId,
      threadKey,
      receiptHash: observationReceiptHash,
      observedAt: now,
      receiptJson: JSON.stringify(observation),
      containsForumText: false
    }
  });
  await prisma.autonomyDecision.create({
    data: {
      id: decisionId,
      invocationId,
      courseAlias,
      decisionKey: hash(`${courseAlias}-decision-key`),
      threadKey,
      authorKey: hash(`${courseAlias}-author`),
      decision: "draft",
      decisionMode: "DRAFT_ELIGIBLE",
      reasonCode: "draft_eligible",
      observationReceiptHash,
      opportunityReceiptHash: hash(`${courseAlias}-opportunity`),
      evidenceBundleHash: hash(`${courseAlias}-evidence`),
      draftContentHash: contentHash,
      policyVersion,
      worldHash: hash(`${courseAlias}-world`),
      candidateSetHash: hash(`${courseAlias}-candidate-set`),
      evidenceAsOf: now,
      decisionJson: JSON.stringify({
        budget: {
          availableSlots: 1,
          workloadCost: 1,
          authorTouchLimit30d: 1
        },
        containsForumText: false
      }),
      bodyPersisted: false,
      publishAttempted: false,
      editorWriteAttempted: false
    }
  });
  await registerCourseAutonomyPolicy({
    prisma,
    allowRealPublishActivation: true,
    value: {
      schemaVersion: AUTONOMY_POLICY_SCHEMA_VERSION,
      courseAlias,
      version: policyVersion,
      mode: "AUTO",
      allowedActions: ["stage_editor", "forum_reply"],
      budget: {
        dailyActionLimit: 1,
        perTickActionLimit: 1,
        authorTouchLimit30d: 1
      },
      validFrom: "2026-08-09T15:55:00.000Z",
      validUntil: "2026-08-09T16:30:00.000Z",
      realPublishEnabled: true,
      containsForumText: false
    }
  });
  const stageReceipt: StageCompanionReceipt = {
    schemaVersion: STAGE_COMPANION_RECEIPT_SCHEMA_VERSION,
    grantHash: hash(`${courseAlias}-stage-grant`),
    runNonceHash: hash(`${courseAlias}-stage-nonce`),
    courseAlias,
    courseLocatorHash: hash(`${courseAlias}-stage-course`),
    pageIdentityHash: hash(`${courseAlias}-stage-page`),
    driverSessionKey: hash(`${courseAlias}-stage-session`),
    targetVersionHash,
    draftContentHash: contentHash,
    editorValueHash: contentHash,
    guardReceiptHash: hash(`${courseAlias}-stage-guard`),
    observedAt: new Date(now.getTime() + 500).toISOString(),
    state: "DRAFT_STAGED_VERIFIED_AND_CLEARED_NOT_PUBLISHED",
    editorWriteCount: 1,
    editorReadbackVerified: true,
    editorClearCount: 1,
    editorEmptyAfterClear: true,
    sentMutationCount: 0,
    publishAttempted: false,
    realPublishEnabled: false,
    bodyPersisted: false,
    containsForumText: false
  };
  const stageReceiptHash = canonicalProtocolHash(
    stageReceipt.schemaVersion,
    stageReceipt as unknown as CanonicalJsonValue
  );
  await recordVerifiedExecutionStage({
    prisma,
    decisionId,
    policyVersion,
    receipt: stageReceipt,
    receiptHash: stageReceiptHash,
    now: new Date(now.getTime() + 600),
    expiresInSeconds: 300
  });
  await appendExecutionStageVerifiedTape({
    prisma,
    decisionId,
    executionPolicyVersion: policyVersion,
    receipt: stageReceipt,
    receiptHash: stageReceiptHash,
    now: new Date(now.getTime() + 700)
  });
  const executionAccount = await acquire({
    prisma,
    courseAlias,
    invocationId,
    decisionId,
    accounts: [
      {
        accountRefHash: hash(`${courseAlias}-account`),
        credentialRefHash: hash(`${courseAlias}-credential`),
        roleKey: "socratic_guide",
        courseAliases: [courseAlias],
        dailyActionLimit: 5,
        cooldownMinutes: 0,
        disclosedAi: true,
        containsForumText: false
      }
    ],
    now
  });
  const preExecutionReceipt = {
    schemaVersion: PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
    courseAlias,
    threadKey,
    targetVersionHash,
    eventSetHash,
    observedAt: new Date(now.getTime() + 800).toISOString(),
    containsForumText: false
  } as const;
  const preExecutionObservation = {
    receipt: preExecutionReceipt,
    receiptHash: hashPreExecutionTargetObservation(preExecutionReceipt)
  };
  const issued = await issueExecutionPermit({
    prisma,
    decisionId,
    now: new Date(now.getTime() + 900),
    executionPolicyVersion: policyVersion,
    requireRealExecution: true,
    executionAccountLeaseId: executionAccount.leaseId
  });
  let attemptId = "";
  if (withPreparedAttempt) {
    const claimed = await claimExecutionPermit({
      prisma,
      permitKey: issued.permit.permitKey,
      transport: "real_platform",
      now: new Date(now.getTime() + 1_000),
      preExecutionObservation
    });
    attemptId = claimed.attempt.id;
  }
  await prisma.executionAccountLease.update({
    where: { id: executionAccount.leaseId },
    data: { expiresAt: new Date(cleanupNow.getTime() - 1_000) }
  });
  return {
    courseAlias,
    invocationId,
    decisionId,
    permitKey: issued.permit.permitKey,
    permitId: issued.permit.id,
    leaseId: executionAccount.leaseId,
    attemptId,
    cleanupNow,
    preExecutionObservation
  };
}

test("过期租约的 prepared_real 可事务中止并保持 expired，且重复中止幂等", async () => {
  await withTemporaryPrisma(async (prisma) => {
    const fixture = await createExpiredCleanupFixture(
      prisma,
      "prepared-abort",
      true
    );
    const aborted = await abortPreparedExecutionAttempt({
      prisma,
      attemptId: fixture.attemptId,
      evidenceHash: hash("expired-prepared-abort"),
      now: fixture.cleanupNow
    });
    assert.equal(aborted.idempotent, false);
    assert.equal(aborted.attempt.status, "aborted_before_send");
    assert.equal(aborted.permit.status, "used");
    assert.equal(
      (
        await prisma.executionAccountLease.findUniqueOrThrow({
          where: { id: fixture.leaseId }
        })
      ).status,
      "expired"
    );
    assert.equal(
      (
        await prisma.budgetReservation.findFirstOrThrow({
          where: { decisionId: fixture.decisionId }
        })
      ).status,
      "released"
    );
    const repeated = await abortPreparedExecutionAttempt({
      prisma,
      attemptId: fixture.attemptId,
      evidenceHash: hash("expired-prepared-abort-replay"),
      now: new Date(fixture.cleanupNow.getTime() + 1_000)
    });
    assert.equal(repeated.idempotent, true);
    await assert.rejects(
      () =>
        markExecutionAttemptSending({
          prisma,
          attemptId: fixture.attemptId,
          now: new Date(fixture.cleanupNow.getTime() + 2_000)
        }),
      /EXECUTION_REAL_ATTEMPT_STATE_CONFLICT/
    );
  });
});

test("过期租约的 unclaimed active Permit 可撤销并释放预算，claim 先行拒绝且重复撤销幂等", async () => {
  await withTemporaryPrisma(async (prisma) => {
    const fixture = await createExpiredCleanupFixture(
      prisma,
      "unclaimed-revoke",
      false
    );
    await assert.rejects(
      () =>
        claimExecutionPermit({
          prisma,
          permitKey: fixture.permitKey,
          transport: "real_platform",
          now: fixture.cleanupNow,
          preExecutionObservation: fixture.preExecutionObservation
        }),
      /EXECUTION_PERMIT_INVALID:account_lease_invalid/
    );
    const revoked = await revokeExecutionPermit({
      prisma,
      permitKey: fixture.permitKey,
      now: fixture.cleanupNow
    });
    assert.equal(revoked.status, "revoked");
    assert.equal(
      (
        await prisma.executionAccountLease.findUniqueOrThrow({
          where: { id: fixture.leaseId }
        })
      ).status,
      "expired"
    );
    assert.equal(
      (
        await prisma.budgetReservation.findFirstOrThrow({
          where: { decisionId: fixture.decisionId }
        })
      ).status,
      "released"
    );
    const repeated = await revokeExecutionPermit({
      prisma,
      permitKey: fixture.permitKey,
      now: new Date(fixture.cleanupNow.getTime() + 1_000)
    });
    assert.equal(repeated.status, "revoked");
  });
});

test("并发 AUTO 激活最多成功一次，并且重锁后的计数来自真实查询", async () => {
  await withTemporaryPrisma(async (prisma) => {
    const courseAlias = `${COURSE_PREFIX}-concurrent`;
    const now = new Date("2026-08-09T12:00:00.000Z");
    await createManifest(prisma, courseAlias);

    const activations = await Promise.allSettled([
      activateOneShotPolicy({
        prisma,
        courseAlias,
        selectionHash: "selection-a",
        now
      }),
      activateOneShotPolicy({
        prisma,
        courseAlias,
        selectionHash: "selection-b",
        now
      })
    ]);
    const successes = activations.filter(
      (result) => result.status === "fulfilled"
    );
    assert.equal(successes.length, 1);
    assert.equal(
      await prisma.autonomyPolicy.count({
        where: {
          courseAlias,
          status: "active",
          revokedAt: null,
          realPublishEnabled: true
        }
      }),
      1
    );

    const relocked = await relockOneShotPolicy({
      prisma,
      courseAlias,
      now: new Date(now.getTime() + 1_000)
    });
    assert.deepEqual(
      {
        manifestLocked: relocked.manifestLocked,
        forumSettingLocked: relocked.forumSettingLocked,
        activeRealPolicyCount: relocked.activeRealPolicyCount,
        openRealPermitCount: relocked.openRealPermitCount,
        blockingRealAttemptCount: relocked.blockingRealAttemptCount
      },
      {
        manifestLocked: true,
        forumSettingLocked: true,
        activeRealPolicyCount: 0,
        openRealPermitCount: 0,
        blockingRealAttemptCount: 0
      }
    );
    assert.equal(
      (await prisma.autonomyCourseManifest.findUniqueOrThrow({
        where: { alias: courseAlias }
      })).realPublishEnabled,
      false
    );
    assert.equal(
      (await prisma.forumSetting.findUnique({ where: { id: "default" } }))
        ?.realPublishEnabled ?? false,
      false
    );

    const repeated = await relockOneShotPolicy({
      prisma,
      courseAlias,
      now: new Date(now.getTime() + 2_000)
    });
    assert.equal(repeated.revokedPolicyCount, 0);
    assert.equal(repeated.closedPermitCount, 0);
    assert.equal(repeated.activeRealPolicyCount, 0);
    assert.equal(repeated.openRealPermitCount, 0);
    assert.equal(repeated.blockingRealAttemptCount, 0);
  });
});

test("未知真实 attempt 不能被重锁伪装成 clean，返回稳定 L3 错误", async () => {
  await withTemporaryPrisma(async (prisma) => {
    const courseAlias = `${COURSE_PREFIX}-unknown`;
    const now = new Date("2026-08-09T13:00:00.000Z");
    const invocationId = nonce(`${courseAlias}-invocation`);
    const decisionId = nonce(`${courseAlias}-decision`);
    await createManifest(prisma, courseAlias);
    await activateOneShotPolicy({
      prisma,
      courseAlias,
      selectionHash: "selection-unknown",
      now
    });
    await prisma.scheduledInvocation.create({
      data: {
        id: invocationId,
        invocationKey: nonce(`${courseAlias}-invocation-key`),
        courseAlias,
        manifestHash: nonce(`${courseAlias}-manifest`),
        scheduledFor: now,
        mode: "SHADOW",
        status: "completed",
        phase: "completed",
        attempt: 1,
        startedAt: now,
        finishedAt: now,
        summaryJson: JSON.stringify({ containsForumText: false })
      }
    });
    await prisma.autonomyDecision.create({
      data: {
        id: decisionId,
        invocationId,
        courseAlias,
        decisionKey: nonce(`${courseAlias}-decision-key`),
        threadKey: nonce(`${courseAlias}-thread`),
        authorKey: nonce(`${courseAlias}-author`),
        decision: "draft",
        decisionMode: "DRAFT_ELIGIBLE",
        reasonCode: "synthetic",
        observationReceiptHash: nonce(`${courseAlias}-observation`),
        opportunityReceiptHash: nonce(`${courseAlias}-opportunity`),
        evidenceBundleHash: nonce(`${courseAlias}-evidence`),
        policyVersion: "synthetic.policy.v1",
        worldHash: nonce(`${courseAlias}-world`),
        candidateSetHash: nonce(`${courseAlias}-candidate-set`),
        evidenceAsOf: now,
        decisionJson: JSON.stringify({ containsForumText: false }),
        bodyPersisted: false,
        publishAttempted: false,
        editorWriteAttempted: false
      }
    });
    await prisma.executionAttempt.create({
      data: {
        decisionId,
        mode: "AUTO",
        status: "outcome_unknown",
        transport: "real_platform",
        idempotencyKey: nonce(`${courseAlias}-attempt-key`),
        receiptJson: JSON.stringify({
          state: "outcome_unknown",
          containsForumText: false
        }),
        requestedMutationCount: 1,
        sentMutationCount: 1,
        publishAttempted: true
      }
    });

    await assert.rejects(
      () =>
        relockOneShotPolicy({
          prisma,
          courseAlias,
          now: new Date(now.getTime() + 1_000)
        }),
      /^Error: L3_RELOCK_POSTCONDITION_FAILED$/
    );
    assert.equal(
      (await prisma.autonomyCourseManifest.findUniqueOrThrow({
        where: { alias: courseAlias }
      })).realPublishEnabled,
      false
    );
    assert.equal(
      await prisma.executionAttempt.count({
        where: {
          decision: { courseAlias },
          transport: "real_platform",
          status: {
            notIn: [
              "aborted_before_send",
              "confirmed_not_published",
              "confirmed_published"
            ]
          }
        }
      }),
      1
    );
  });
});

test("重锁初始快照后 claim/mark 获胜时，不得撤销仍在发送的 Permit", async () => {
  await withTemporaryPrisma(async (prisma) => {
    const courseAlias = `${COURSE_PREFIX}-claim-wins`;
    const now = new Date("2026-08-09T14:00:00.000Z");
    await createManifest(prisma, courseAlias);
    const policy = await activateOneShotPolicy({
      prisma,
      courseAlias,
      selectionHash: "selection-claim-wins",
      now
    });
    const manifest = await prisma.autonomyCourseManifest.update({
      where: { alias: courseAlias },
      data: { policyVersion: policy.version }
    });
    const invocationId = nonce(`${courseAlias}-invocation`);
    const decisionId = nonce(`${courseAlias}-decision`);
    const threadKey = nonce(`${courseAlias}-thread`);
    const targetVersionHash = hash(`${courseAlias}-target-version`);
    const eventSetHash = hash(`${courseAlias}-event-set`);
    const observation = {
      schemaVersion: "cmooc.test-safe-observation.v1",
      threadKey,
      targetVersionHash,
      eventSetHash,
      containsForumText: false
    } as const;
    const observationReceiptHash = canonicalProtocolHash(
      observation.schemaVersion,
      observation as unknown as CanonicalJsonValue
    );
    await prisma.scheduledInvocation.create({
      data: {
        id: invocationId,
        invocationKey: nonce(`${courseAlias}-invocation-key`),
        courseAlias,
        manifestHash: manifest.manifestHash,
        scheduledFor: now,
        mode: "SHADOW",
        status: "completed",
        phase: "completed",
        attempt: 1,
        startedAt: now,
        finishedAt: now,
        summaryJson: JSON.stringify({ containsForumText: false })
      }
    });
    await prisma.autonomyObservation.create({
      data: {
        invocationId,
        threadKey,
        receiptHash: observationReceiptHash,
        observedAt: now,
        receiptJson: JSON.stringify(observation),
        containsForumText: false
      }
    });
    await prisma.autonomyDecision.create({
      data: {
        id: decisionId,
        invocationId,
        courseAlias,
        decisionKey: hash(`${courseAlias}-decision-key`),
        threadKey,
        authorKey: hash(`${courseAlias}-author`),
        decision: "draft",
        decisionMode: "DRAFT_ELIGIBLE",
        reasonCode: "draft_eligible",
        observationReceiptHash,
        opportunityReceiptHash: hash(`${courseAlias}-opportunity`),
        evidenceBundleHash: hash(`${courseAlias}-evidence`),
        draftContentHash: hash(`${courseAlias}-draft`),
        policyVersion: policy.version,
        worldHash: hash(`${courseAlias}-world`),
        candidateSetHash: hash(`${courseAlias}-candidate-set`),
        evidenceAsOf: now,
        decisionJson: JSON.stringify({
          budget: {
            availableSlots: 1,
            workloadCost: 1,
            authorTouchLimit30d: 1
          },
          containsForumText: false
        }),
        bodyPersisted: false,
        publishAttempted: false,
        editorWriteAttempted: false
      }
    });
    const stageTargetVersionHash = targetVersionHash;
    const stageContentHash = hash(`${courseAlias}-draft`);
    const stageReceipt: StageCompanionReceipt = {
      schemaVersion: STAGE_COMPANION_RECEIPT_SCHEMA_VERSION,
      grantHash: hash(`${courseAlias}-stage-grant`),
      runNonceHash: hash(`${courseAlias}-stage-nonce`),
      courseAlias,
      courseLocatorHash: hash(`${courseAlias}-stage-course`),
      pageIdentityHash: hash(`${courseAlias}-stage-page`),
      driverSessionKey: hash(`${courseAlias}-stage-session`),
      targetVersionHash: stageTargetVersionHash,
      draftContentHash: stageContentHash,
      editorValueHash: stageContentHash,
      guardReceiptHash: hash(`${courseAlias}-stage-guard`),
      observedAt: new Date(now.getTime() + 100).toISOString(),
      state: "DRAFT_STAGED_VERIFIED_AND_CLEARED_NOT_PUBLISHED",
      editorWriteCount: 1,
      editorReadbackVerified: true,
      editorClearCount: 1,
      editorEmptyAfterClear: true,
      sentMutationCount: 0,
      publishAttempted: false,
      realPublishEnabled: false,
      bodyPersisted: false,
      containsForumText: false
    };
    await recordVerifiedExecutionStage({
      prisma,
      decisionId,
      policyVersion: policy.version,
      receipt: stageReceipt,
      receiptHash: canonicalProtocolHash(
        stageReceipt.schemaVersion,
        stageReceipt as unknown as CanonicalJsonValue
      ),
      now: new Date(now.getTime() + 200),
      expiresInSeconds: 300
    });
    await appendExecutionStageVerifiedTape({
      prisma,
      decisionId,
      executionPolicyVersion: policy.version,
      receipt: stageReceipt,
      receiptHash: canonicalProtocolHash(
        stageReceipt.schemaVersion,
        stageReceipt as unknown as CanonicalJsonValue
      ),
      now: new Date(now.getTime() + 250)
    });
    const executionAccount = await acquire({
      prisma,
      courseAlias,
      invocationId,
      decisionId,
      accounts: [
        {
          accountRefHash: hash(`${courseAlias}-account`),
          credentialRefHash: hash(`${courseAlias}-credential`),
          roleKey: "socratic_guide",
          courseAliases: [courseAlias],
          dailyActionLimit: 5,
          cooldownMinutes: 0,
          disclosedAi: true,
          containsForumText: false
        }
      ],
      now
    });
    const issued = await issueExecutionPermit({
      prisma,
      decisionId,
      now,
      executionPolicyVersion: policy.version,
      requireRealExecution: true,
      executionAccountLeaseId: executionAccount.leaseId
    });

    let releaseInitialRead!: () => void;
    const initialReadReleased = new Promise<void>((resolve) => {
      releaseInitialRead = resolve;
    });
    let initialReadObserved!: () => void;
    const initialReadReady = new Promise<void>((resolve) => {
      initialReadObserved = resolve;
    });
    let gateUsed = false;
    const gatedPrisma = prisma.$extends({
      query: {
        executionPermit: {
          async findMany({ args, query }) {
            const result = await query(args);
            if (!gateUsed) {
              gateUsed = true;
              initialReadObserved();
              await initialReadReleased;
            }
            return result;
          }
        }
      }
    }) as unknown as PrismaClient;

    const relockPromise = relockOneShotPolicy({
      prisma: gatedPrisma,
      courseAlias,
      now: new Date(now.getTime() + 1_000)
    });
    await initialReadReady;

    const attempt = await prisma.$transaction(async (transaction) => {
      const claimed = await transaction.executionPermit.updateMany({
        where: {
          id: issued.permit.id,
          status: "active",
          usedAt: null,
          revokedAt: null
        },
        data: { status: "claimed" }
      });
      assert.equal(claimed.count, 1);
      return transaction.executionAttempt.create({
        data: {
          decisionId,
          permitId: issued.permit.id,
          mode: "AUTO",
          status: "prepared_real",
          transport: "real_platform",
          idempotencyKey: issued.permit.idempotencyKey,
          receiptJson: JSON.stringify({
            state: "prepared_real",
            containsForumText: false
          }),
          requestedMutationCount: 1,
          sentMutationCount: 0,
          publishAttempted: false,
          executionAccountRefHash: executionAccount.accountRefHash,
          startedAt: now,
          finishedAt: null
        }
      });
    });
    await markExecutionAttemptSending({
      prisma,
      attemptId: attempt.id,
      now: new Date(now.getTime() + 500)
    });
    releaseInitialRead();

    await assert.rejects(
      () => relockPromise,
      /^Error: L3_RELOCK_POSTCONDITION_FAILED$/
    );
    const finalPermit = await prisma.executionPermit.findUniqueOrThrow({
      where: { id: issued.permit.id }
    });
    const finalAttempt = await prisma.executionAttempt.findUniqueOrThrow({
      where: { id: attempt.id }
    });
    assert.equal(finalPermit.status, "used");
    assert.equal(finalPermit.revokedAt, null);
    assert.equal(finalAttempt.status, "outcome_unknown");
    assert.equal(finalAttempt.sentMutationCount, 1);
    assert.equal(finalAttempt.publishAttempted, true);
    await assert.rejects(
      () =>
        revokeExecutionPermit({
          prisma,
          permitKey: issued.permit.permitKey,
          now: new Date(now.getTime() + 2_000)
        }),
      /^Error: EXECUTION_PERMIT_ALREADY_USED$/
    );
    assert.equal(
      (await prisma.autonomyPolicy.findUniqueOrThrow({
        where: {
          courseAlias_version: {
            courseAlias,
            version: policy.version
          }
        }
      })).status,
      "revoked"
    );
    assert.equal(
      (await prisma.autonomyCourseManifest.findUniqueOrThrow({
        where: { alias: courseAlias }
      })).realPublishEnabled,
      false
    );
  });
});

test("过期 active one-shot policy 无 open 边界时可自动恢复并保持硬锁", async () => {
  await withTemporaryPrisma(async (prisma) => {
    const courseAlias = `${COURSE_PREFIX}-expired-recovery`;
    const now = new Date("2026-08-09T15:00:00.000Z");
    await createManifest(prisma, courseAlias);
    const policy = await activateOneShotPolicy({
      prisma,
      courseAlias,
      selectionHash: "selection-expired-recovery",
      now,
      validForMinutes: 5
    });
    const recovered = await recoverExpiredOneShotPolicy({
      prisma,
      courseAlias,
      now: new Date(now.getTime() + 6 * 60_000)
    });
    assert.equal(recovered.status, "recovered");
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.manifestLocked, true);
    assert.equal(recovered.forumSettingLocked, true);
    assert.equal(recovered.globalHardLock, true);
    assert.equal(recovered.activeRealPolicyCount, 0);
    assert.equal(recovered.openRealPermitCount, 0);
    assert.equal(recovered.blockingRealAttemptCount, 0);
    assert.equal(
      (await prisma.autonomyPolicy.findUniqueOrThrow({
        where: {
          courseAlias_version: {
            courseAlias,
            version: policy.version
          }
        }
      })).status,
      "revoked"
    );
    assert.equal(
      (await prisma.autonomyCourseManifest.findUniqueOrThrow({
        where: { alias: courseAlias }
      })).realPublishEnabled,
      false
    );
  });
});

test("未过期 active one-shot policy recovery 是 no-op 且不撤销现有策略", async () => {
  await withTemporaryPrisma(async (prisma) => {
    const courseAlias = `${COURSE_PREFIX}-unexpired-recovery`;
    const now = new Date("2026-08-09T16:00:00.000Z");
    await createManifest(prisma, courseAlias);
    const policy = await activateOneShotPolicy({
      prisma,
      courseAlias,
      selectionHash: "selection-unexpired-recovery",
      now
    });
    const summary = await recoverExpiredOneShotPolicy({
      prisma,
      courseAlias,
      now: new Date(now.getTime() + 60_000)
    });
    assert.deepEqual(summary, {
      status: "noop",
      reason: "policy_not_expired",
      activePolicyCount: 1,
      recovered: false,
      containsForumText: false
    });
    assert.equal(
      (await prisma.autonomyPolicy.findUniqueOrThrow({
        where: {
          courseAlias_version: {
            courseAlias,
            version: policy.version
          }
        }
      })).status,
      "active"
    );
    assert.equal(
      (await prisma.autonomyCourseManifest.findUniqueOrThrow({
        where: { alias: courseAlias }
      })).realPublishEnabled,
      true
    );
  });
});

test("多 active policy recovery 无写入，无法收束的 blocking attempt 阻止新的 Stage", async () => {
  await withTemporaryPrisma(async (prisma) => {
    const multiAlias = `${COURSE_PREFIX}-recovery-conflict`;
    const now = new Date("2026-08-09T17:00:00.000Z");
    await createManifest(prisma, multiAlias);
    const first = await activateOneShotPolicy({
      prisma,
      courseAlias: multiAlias,
      selectionHash: "selection-recovery-conflict",
      now,
      validForMinutes: 5
    });
    await registerCourseAutonomyPolicy({
      prisma,
      allowRealPublishActivation: true,
      value: {
        schemaVersion: AUTONOMY_POLICY_SCHEMA_VERSION,
        courseAlias: multiAlias,
        version: "synthetic.recovery.conflict.v2",
        mode: "AUTO",
        allowedActions: ["stage_editor", "forum_reply"],
        budget: {
          dailyActionLimit: 1,
          perTickActionLimit: 1,
          authorTouchLimit30d: 1
        },
        validFrom: now.toISOString(),
        validUntil: new Date(now.getTime() + 5 * 60_000).toISOString(),
        realPublishEnabled: true,
        containsForumText: false
      }
    });
    await assert.rejects(
      () =>
        recoverExpiredOneShotPolicy({
          prisma,
          courseAlias: multiAlias,
          now: new Date(now.getTime() + 6 * 60_000)
        }),
      /^Error: L3_EXPIRED_POLICY_RECOVERY_CONFLICT$/
    );
    assert.equal(
      await prisma.autonomyPolicy.count({
        where: {
          courseAlias: multiAlias,
          status: "active",
          revokedAt: null,
          realPublishEnabled: true
        }
      }),
      2
    );
    assert.equal(
      (await prisma.autonomyCourseManifest.findUniqueOrThrow({
        where: { alias: multiAlias }
      })).realPublishEnabled,
      true
    );
    assert.equal(first.status, "active");

    const blockingAlias = `${COURSE_PREFIX}-recovery-blocking`;
    const blockingNow = new Date("2026-08-09T18:00:00.000Z");
    await createManifest(prisma, blockingAlias);
    const blockingPolicy = await activateOneShotPolicy({
      prisma,
      courseAlias: blockingAlias,
      selectionHash: "selection-recovery-blocking",
      now: blockingNow,
      validForMinutes: 5
    });
    const invocationId = nonce(`${blockingAlias}-invocation`);
    const decisionId = nonce(`${blockingAlias}-decision`);
    await prisma.scheduledInvocation.create({
      data: {
        id: invocationId,
        invocationKey: nonce(`${blockingAlias}-invocation-key`),
        courseAlias: blockingAlias,
        manifestHash: nonce(`${blockingAlias}-manifest`),
        scheduledFor: blockingNow,
        mode: "SHADOW",
        status: "completed",
        phase: "completed",
        attempt: 1,
        startedAt: blockingNow,
        finishedAt: blockingNow,
        summaryJson: JSON.stringify({ containsForumText: false })
      }
    });
    await prisma.autonomyDecision.create({
      data: {
        id: decisionId,
        invocationId,
        courseAlias: blockingAlias,
        decisionKey: nonce(`${blockingAlias}-decision-key`),
        threadKey: nonce(`${blockingAlias}-thread`),
        authorKey: nonce(`${blockingAlias}-author`),
        decision: "draft",
        decisionMode: "DRAFT_ELIGIBLE",
        reasonCode: "synthetic",
        observationReceiptHash: nonce(`${blockingAlias}-observation`),
        opportunityReceiptHash: nonce(`${blockingAlias}-opportunity`),
        evidenceBundleHash: nonce(`${blockingAlias}-evidence`),
        policyVersion: blockingPolicy.version,
        worldHash: nonce(`${blockingAlias}-world`),
        candidateSetHash: nonce(`${blockingAlias}-candidate-set`),
        evidenceAsOf: blockingNow,
        decisionJson: JSON.stringify({ containsForumText: false }),
        bodyPersisted: false,
        publishAttempted: false,
        editorWriteAttempted: false
      }
    });
    await prisma.executionAttempt.create({
      data: {
        decisionId,
        mode: "AUTO",
        status: "outcome_unknown",
        transport: "real_platform",
        idempotencyKey: nonce(`${blockingAlias}-attempt-key`),
        receiptJson: JSON.stringify({
          state: "outcome_unknown",
          containsForumText: false
        }),
        requestedMutationCount: 1,
        sentMutationCount: 1,
        publishAttempted: true
      }
    });
    let driverStarted = false;
    await assert.rejects(
      () =>
        executeTrustedBrowserStage({
          prisma,
          courseAlias: blockingAlias,
          now: () => new Date(blockingNow.getTime() + 6 * 60_000),
          driverFactory: async () => {
            driverStarted = true;
            throw new Error("DRIVER_MUST_NOT_START");
          }
        }),
      /^Error: L3_RELOCK_POSTCONDITION_FAILED$/
    );
    assert.equal(driverStarted, false);
    assert.equal(
      (await prisma.autonomyPolicy.findUniqueOrThrow({
        where: {
          courseAlias_version: {
            courseAlias: blockingAlias,
            version: blockingPolicy.version
          }
        }
      })).status,
      "revoked"
    );
  });
});
