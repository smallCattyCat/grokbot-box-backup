import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "../../lib/facilitation-protocol";
import {
  AUTONOMY_POLICY_SCHEMA_VERSION,
  registerCourseAutonomyPolicy
} from "../../lib/autonomy/autonomy-policy";
import {
  claimExecutionPermit,
  hashPreExecutionTargetObservation,
  issueExecutionPermit,
  markExecutionAttemptSending,
  PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
  PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
  reconcileOutcomeUnknownExecutionAttempt,
  settleExecutionAttemptReal
} from "../../lib/autonomy/execution-permit";
import { acquire } from "../../lib/autonomy/execution-account-pool";
import {
  recordVerifiedExecutionStage
} from "../../lib/autonomy/execution-stage-receipt";
import {
  STAGE_COMPANION_RECEIPT_SCHEMA_VERSION,
  type StageCompanionReceipt
} from "../../lib/live-runtime/stage-companion";
import { appendExecutionStageVerifiedTape } from "../../lib/autonomy/one-shot-stage";

const COURSE_ALIAS = "outcome-unknown-transition";
const POLICY_VERSION = "outcome-unknown-policy.v1";
const EXECUTION_POLICY_VERSION = "outcome-unknown-execution.v1";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createTemporaryPrisma(): Promise<{
  prisma: PrismaClient;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "cmooc-outcome-unknown-"));
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

async function prepareUnknown(prisma: PrismaClient): Promise<{
  attemptId: string;
  decisionId: string;
  permitId: string;
  now: Date;
}> {
  const now = new Date("2026-08-09T12:00:00.000Z");
  const invocationId = "outcome-unknown-invocation";
  const decisionId = "outcome-unknown-decision";
  const threadKey = hash("outcome-unknown-thread");
  const targetVersionHash = hash("outcome-unknown-target-version");
  const eventSetHash = hash("outcome-unknown-events");
  const contentHash = hash("transient-content-never-persisted");
  const manifestHash = hash("outcome-unknown-manifest");
  const observation = {
    schemaVersion: "cmooc.outcome-unknown-observation.v1",
    threadKey,
    targetVersionHash,
    eventSetHash,
    containsForumText: false
  } as const;
  const observationReceiptHash = canonicalProtocolHash(
    observation.schemaVersion,
    observation as CanonicalJsonValue
  );

  await prisma.autonomyCourseManifest.create({
    data: {
      alias: COURSE_ALIAS,
      manifestHash,
      platformId: "synthetic.platform",
      platformCourseRefHash: hash("synthetic-course"),
      canonicalLocatorHash: hash("synthetic-locator"),
      identityKeyFingerprint: hash("synthetic-identity"),
      allowedOrigin: "https://synthetic.example.test",
      timeZone: "UTC",
      defaultMode: "SHADOW",
      policyVersion: POLICY_VERSION,
      enabled: true,
      realPublishEnabled: true
    }
  });
  await prisma.scheduledInvocation.create({
    data: {
      id: invocationId,
      invocationKey: hash("outcome-unknown-invocation-key"),
      courseAlias: COURSE_ALIAS,
      manifestHash,
      scheduledFor: now,
      mode: "SHADOW",
      status: "completed",
      phase: "completed",
      attempt: 1,
      startedAt: now,
      finishedAt: now,
      summaryJson: JSON.stringify({
        schemaVersion: "cmooc.outcome-unknown-invocation.v1",
        containsForumText: false
      })
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
      courseAlias: COURSE_ALIAS,
      decisionKey: hash("outcome-unknown-decision-key"),
      threadKey,
      authorKey: hash("outcome-unknown-author"),
      decision: "draft",
      decisionMode: "DRAFT_ELIGIBLE",
      reasonCode: "draft_eligible",
      observationReceiptHash,
      opportunityReceiptHash: hash("outcome-unknown-opportunity"),
      evidenceBundleHash: hash("outcome-unknown-evidence"),
      intentHash: hash("outcome-unknown-intent"),
      moveSpecHash: hash("outcome-unknown-move"),
      draftContentHash: contentHash,
      policyVersion: POLICY_VERSION,
      worldHash: hash("outcome-unknown-world"),
      candidateSetHash: hash("outcome-unknown-candidates"),
      evidenceAsOf: now,
      decisionJson: JSON.stringify({
        schemaVersion: "cmooc.outcome-unknown-decision.v1",
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
      courseAlias: COURSE_ALIAS,
      version: EXECUTION_POLICY_VERSION,
      mode: "AUTO",
      allowedActions: ["stage_editor", "forum_reply"],
      budget: {
        dailyActionLimit: 1,
        perTickActionLimit: 1,
        authorTouchLimit30d: 1
      },
      validFrom: "2026-08-09T11:55:00.000Z",
      validUntil: "2026-08-09T12:10:00.000Z",
      realPublishEnabled: true,
      containsForumText: false
    }
  });
  const stageReceipt: StageCompanionReceipt = {
    schemaVersion: STAGE_COMPANION_RECEIPT_SCHEMA_VERSION,
    grantHash: hash("outcome-unknown-stage-grant"),
    runNonceHash: hash("outcome-unknown-stage-nonce"),
    courseAlias: COURSE_ALIAS,
    courseLocatorHash: hash("outcome-unknown-stage-course"),
    pageIdentityHash: hash("outcome-unknown-stage-page"),
    driverSessionKey: hash("outcome-unknown-stage-session"),
    targetVersionHash,
    draftContentHash: contentHash,
    editorValueHash: contentHash,
    guardReceiptHash: hash("outcome-unknown-stage-guard"),
    observedAt: new Date(now.getTime() + 1_000).toISOString(),
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
    policyVersion: EXECUTION_POLICY_VERSION,
    receipt: stageReceipt,
    receiptHash: stageReceiptHash,
    now: new Date(now.getTime() + 1_500),
    expiresInSeconds: 300
  });
  await appendExecutionStageVerifiedTape({
    prisma,
    decisionId,
    executionPolicyVersion: EXECUTION_POLICY_VERSION,
    receipt: stageReceipt,
    receiptHash: stageReceiptHash,
    now: new Date(now.getTime() + 1_600)
  });
  const executionAccount = await acquire({
    prisma,
    courseAlias: COURSE_ALIAS,
    invocationId,
    decisionId,
    accounts: [
      {
        accountRefHash: hash("outcome-unknown-account"),
        credentialRefHash: hash("outcome-unknown-credential"),
        roleKey: "socratic_guide",
        courseAliases: [COURSE_ALIAS],
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
    courseAlias: COURSE_ALIAS,
    threadKey,
    targetVersionHash,
    eventSetHash,
    observedAt: new Date(now.getTime() + 2_000).toISOString(),
    containsForumText: false
  } as const;
  const preExecutionObservation = {
    receipt: preExecutionReceipt,
    receiptHash: hashPreExecutionTargetObservation(preExecutionReceipt)
  };
  const issued = await issueExecutionPermit({
    prisma,
    decisionId,
    now: new Date(now.getTime() + 2_100),
    executionPolicyVersion: EXECUTION_POLICY_VERSION,
    requireRealExecution: true,
    executionAccountLeaseId: executionAccount.leaseId
  });
  const claimed = await claimExecutionPermit({
    prisma,
    permitKey: issued.permit.permitKey,
    transport: "real_platform",
    now: new Date(now.getTime() + 2_200),
    preExecutionObservation
  });
  await markExecutionAttemptSending({
    prisma,
    attemptId: claimed.attempt.id,
    now: new Date(now.getTime() + 2_300)
  });
  const unknown = await settleExecutionAttemptReal({
    prisma,
    attemptId: claimed.attempt.id,
    state: "outcome_unknown",
    remoteEvidenceHash: hash("initial-unknown-remote-evidence"),
    now: new Date(now.getTime() + 2_400)
  });
  // Simulate the production hard relock after the one-shot send.  Reconcile
  // must work from the consumed historical facts without reopening anything.
  await prisma.autonomyPolicy.updateMany({
    where: { courseAlias: COURSE_ALIAS },
    data: {
      status: "revoked",
      revokedAt: new Date(now.getTime() + 2_500),
      emergencyHalt: true
    }
  });
  await prisma.autonomyCourseManifest.update({
    where: { alias: COURSE_ALIAS },
    data: { realPublishEnabled: false }
  });
  assert.equal(unknown.attempt.status, "outcome_unknown");
  return {
    attemptId: unknown.attempt.id,
    decisionId,
    permitId: unknown.permit.id,
    now: new Date(now.getTime() + 3_000)
  };
}

test("outcome_unknown 可在无发送的本地核对后转为 confirmed_not_published，并保留消费事实", async () => {
  await withTemporaryPrisma(async (prisma) => {
    const fixture = await prepareUnknown(prisma);
    const remoteEvidenceHash = hash("remote-detail-count-zero");
    const reconciled = await reconcileOutcomeUnknownExecutionAttempt({
      prisma,
      attemptId: fixture.attemptId,
      state: "confirmed_not_published",
      remoteEvidenceHash,
      now: fixture.now
    });
    assert.equal(reconciled.idempotent, false);
    assert.equal(reconciled.attempt.status, "confirmed_not_published");
    assert.equal(reconciled.permit.status, "used");
    assert.equal(reconciled.permit.usedAt !== null, true);
    assert.equal(reconciled.attempt.sentMutationCount, 1);
    assert.equal(reconciled.attempt.publishAttempted, true);
    assert.equal(reconciled.attempt.remoteOutcomeHash?.length, 64);
    const receipt = JSON.parse(reconciled.attempt.receiptJson) as Record<string, unknown>;
    assert.equal(receipt.schemaVersion, PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION);
    assert.equal(receipt.state, "confirmed_not_published");
    assert.equal(receipt.remoteEvidenceHash, remoteEvidenceHash);
    assert.equal(
      canonicalProtocolHash(
        PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
        receipt as CanonicalJsonValue
      ),
      reconciled.attempt.remoteOutcomeHash
    );
    const stage = await prisma.executionStageReceipt.findUniqueOrThrow({
      where: { decisionId: fixture.decisionId }
    });
    assert.equal(stage.status, "consumed");
    assert.equal(stage.usedAt !== null, true);
    assert.equal(stage.sentMutationCount, 0);
    assert.equal(stage.publishAttempted, false);
    assert.equal(stage.bodyPersisted, false);
    assert.equal(stage.containsForumText, false);
    assert.equal(
      (await prisma.budgetReservation.findFirstOrThrow({
        where: { decisionId: fixture.decisionId }
      })).status,
      "consumed"
    );
    assert.equal(
      (await prisma.autonomyDecision.findUniqueOrThrow({
        where: { id: fixture.decisionId }
      })).publishAttempted,
      true
    );
    const repeated = await reconcileOutcomeUnknownExecutionAttempt({
      prisma,
      attemptId: fixture.attemptId,
      state: "confirmed_not_published",
      remoteEvidenceHash,
      now: new Date(fixture.now.getTime() + 1_000)
    });
    assert.equal(repeated.idempotent, true);
    assert.equal(repeated.attempt.remoteOutcomeHash, reconciled.attempt.remoteOutcomeHash);
    await assert.rejects(
      () =>
        reconcileOutcomeUnknownExecutionAttempt({
          prisma,
          attemptId: fixture.attemptId,
          state: "confirmed_not_published",
          remoteEvidenceHash: hash("conflicting-remote-evidence"),
          now: new Date(fixture.now.getTime() + 2_000)
        }),
      /EXECUTION_OUTCOME_UNKNOWN_RECONCILIATION_STATE_CONFLICT/
    );
  });
});

test("outcome_unknown 可转为 confirmed_published 且并发核对至多一次改变", async () => {
  await withTemporaryPrisma(async (prisma) => {
    const fixture = await prepareUnknown(prisma);
    const remoteEvidenceHash = hash("remote-detail-published");
    const results = await Promise.allSettled(
      ["a", "b"].map((suffix) =>
        reconcileOutcomeUnknownExecutionAttempt({
          prisma,
          attemptId: fixture.attemptId,
          state: "confirmed_published",
          remoteEvidenceHash,
          now: new Date(fixture.now.getTime() + (suffix === "a" ? 1 : 2))
        })
      )
    );
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof reconcileOutcomeUnknownExecutionAttempt>>> =>
        result.status === "fulfilled"
    );
    assert.ok(fulfilled.length >= 1);
    assert.ok(fulfilled.some((result) => result.value.idempotent === false));
    assert.ok(
      fulfilled.length === 2 ||
        results.some(
          (result) =>
            result.status === "rejected" &&
            /EXECUTION_OUTCOME_UNKNOWN_RECONCILIATION_(STATE_CONFLICT|TRANSACTION_CONFLICT)/.test(
              String(result.reason)
            )
        )
    );
    const attempt = await prisma.executionAttempt.findUniqueOrThrow({
      where: { id: fixture.attemptId }
    });
    assert.equal(attempt.status, "confirmed_published");
    assert.equal(attempt.sentMutationCount, 1);
    assert.equal(
      (await prisma.budgetReservation.findFirstOrThrow({
        where: { decisionId: fixture.decisionId }
      })).status,
      "consumed"
    );
  });
});

test("回执、Permit 或 STAGE 漂移稳定拒绝，且不得把 outcome_unknown 改写", async () => {
  await withTemporaryPrisma(async (prisma) => {
    const fixture = await prepareUnknown(prisma);
    await prisma.executionAttempt.update({
      where: { id: fixture.attemptId },
      data: { receiptJson: "{}" }
    });
    await assert.rejects(
      () =>
        reconcileOutcomeUnknownExecutionAttempt({
          prisma,
          attemptId: fixture.attemptId,
          state: "confirmed_not_published",
          remoteEvidenceHash: hash("invalid-receipt-evidence"),
          now: fixture.now
        }),
      /EXECUTION_OUTCOME_UNKNOWN_RECONCILIATION_RECEIPT_INVALID/
    );
    assert.equal(
      (await prisma.executionAttempt.findUniqueOrThrow({
        where: { id: fixture.attemptId }
      })).status,
      "outcome_unknown"
    );
  });

  await withTemporaryPrisma(async (prisma) => {
    const fixture = await prepareUnknown(prisma);
    await prisma.executionPermit.update({
      where: { id: fixture.permitId },
      data: { revokedAt: fixture.now }
    });
    await assert.rejects(
      () =>
        reconcileOutcomeUnknownExecutionAttempt({
          prisma,
          attemptId: fixture.attemptId,
          state: "confirmed_published",
          remoteEvidenceHash: hash("invalid-permit-evidence"),
          now: fixture.now
        }),
      /EXECUTION_OUTCOME_UNKNOWN_RECONCILIATION_PERMIT_INVALID/
    );
  });

  await withTemporaryPrisma(async (prisma) => {
    const fixture = await prepareUnknown(prisma);
    await prisma.executionStageReceipt.update({
      where: { decisionId: fixture.decisionId },
      data: { containsForumText: true }
    });
    await assert.rejects(
      () =>
        reconcileOutcomeUnknownExecutionAttempt({
          prisma,
          attemptId: fixture.attemptId,
          state: "confirmed_not_published",
          remoteEvidenceHash: hash("invalid-stage-evidence"),
          now: fixture.now
        }),
      /EXECUTION_OUTCOME_UNKNOWN_RECONCILIATION_STAGE_INVALID/
    );
  });

  await withTemporaryPrisma(async (prisma) => {
    const fixture = await prepareUnknown(prisma);
    const attempt = await prisma.executionAttempt.findUniqueOrThrow({
      where: { id: fixture.attemptId }
    });
    const receipt = JSON.parse(attempt.receiptJson) as Record<string, unknown>;
    receipt.observedAt = fixture.now.toISOString();
    await prisma.executionAttempt.update({
      where: { id: fixture.attemptId },
      data: {
        receiptJson: JSON.stringify(receipt),
        remoteOutcomeHash: canonicalProtocolHash(
          PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
          receipt as CanonicalJsonValue
        )
      }
    });
    await assert.rejects(
      () =>
        reconcileOutcomeUnknownExecutionAttempt({
          prisma,
          attemptId: fixture.attemptId,
          state: "confirmed_not_published",
          remoteEvidenceHash: hash("mismatched-finish-time-evidence"),
          now: fixture.now
        }),
      /EXECUTION_OUTCOME_UNKNOWN_RECONCILIATION_RECEIPT_INVALID/
    );
  });
});
