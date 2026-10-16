import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
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
import {
  assertRealForumWriteUnlocked,
  REAL_FORUM_WRITE_LOCK_CODE,
  REAL_FORUM_WRITE_LOCKED
} from "../../lib/forum/real-write-lock";
import {
  remotePublicationReceiptIsBound
} from "../../lib/autonomy/outcome-observer";
import {
  appendExecutionPermitIssuedTape,
  appendExecutionPolicyRelockedTape,
  appendExecutionReceiptCommittedTape,
  appendOneShotDecisionTapeEntry,
  appendOutcomeWindowsScheduledTape,
  appendPostExecutionObservedTape,
  appendPreExecutionRevalidatedTape,
  assertExecutionStageTapeRecorded,
  assertOneShotManifestBinding,
  assertOneShotTargetOrigin
} from "../../lib/autonomy/one-shot-runner";
import { verifyDecisionTape } from "../../lib/autonomy/decision-tape";
import {
  appendExecutionStageVerifiedTape,
  assertSelectionHashStable
} from "../../lib/autonomy/one-shot-stage";
import { relockOneShotPolicy } from "../../lib/autonomy/one-shot-execution";

const COURSE_ALIAS = "production-execution-integration";
const POLICY_VERSION = "production-execution.auto.v1";
const EXECUTION_POLICY_VERSION =
  "production-execution.one-shot.v1";
const TRANSIENT_BODY =
  "TRANSIENT_PRODUCTION_BODY_MUST_NEVER_ENTER_DATABASE";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("L3 readiness 将磁盘 manifest、数据库 manifest 与 completed SHADOW invocation 精确绑定", () => {
  const manifestHash = hash("bound-manifest");
  const base = {
    courseAlias: COURSE_ALIAS,
    manifest: {
      alias: COURSE_ALIAS,
      manifestHash,
      policyVersion: "manifest-policy.v1",
      realPublishEnabled: false as const
    },
    manifestState: {
      alias: COURSE_ALIAS,
      manifestHash,
      policyVersion: "manifest-policy.v1",
      enabled: true,
      realPublishEnabled: false
    },
    invocation: {
      id: "invocation-id",
      courseAlias: COURSE_ALIAS,
      manifestHash,
      mode: "SHADOW",
      status: "completed",
      phase: "completed"
    },
    decision: {
      id: "decision-id",
      invocationId: "invocation-id",
      courseAlias: COURSE_ALIAS,
      policyVersion: "manifest-policy.v1"
    },
    expectedDbRealPublishEnabled: false
  } as const;

  assert.doesNotThrow(() => assertOneShotManifestBinding(base));
  assert.throws(
    () =>
      assertOneShotManifestBinding({
        ...base,
        manifestState: {
          ...base.manifestState,
          manifestHash: hash("drifted-manifest")
        }
      }),
    /^Error: L3_MANIFEST_BINDING_MISMATCH$/
  );
  assert.throws(
    () =>
      assertOneShotManifestBinding({
        ...base,
        invocation: {
          ...base.invocation,
          courseAlias: "other-course"
        }
      }),
    /^Error: L3_SHADOW_INVOCATION_BINDING_MISMATCH$/
  );
});

test("L3 stage 在激活策略前拒绝 selectionHash 漂移", () => {
  assert.doesNotThrow(() =>
    assertSelectionHashStable("selection-a", "selection-a")
  );
  assert.throws(
    () => assertSelectionHashStable("selection-a", "selection-b"),
    /^Error: L3_STAGE_SELECTION_CHANGED$/
  );
});

test("L3 publish target origin 只接受 manifest allowlist，且错误不回显 URL", () => {
  assert.doesNotThrow(() =>
    assertOneShotTargetOrigin({
      postUrl: "https://cmooc.example.test/topic/1",
      allowedOrigins: ["https://cmooc.example.test"]
    })
  );
  for (const postUrl of [
    "https://evil.example.test/topic/1",
    "not-a-url"
  ]) {
    assert.throws(
      () =>
        assertOneShotTargetOrigin({
          postUrl,
          allowedOrigins: ["https://cmooc.example.test"]
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "L3_PUBLISH_TARGET_ORIGIN_INVALID" &&
        !error.message.includes(postUrl)
    );
  }
});

test("L3 去正文 tape helper 拒绝 permit/idempotency/target URL 字段", async () => {
  for (const [key, value] of [
    ["permitKey", "permit-secret"],
    ["idempotencyKey", "idempotency-secret"],
    ["targetUrl", "https://evil.example.test/topic/1"]
  ] as const) {
    await assert.rejects(
      () =>
        appendOneShotDecisionTapeEntry({
          prisma: {} as never,
          invocationId: "synthetic-invocation",
          kind: "synthetic_fact",
          receiptHash: hash(`unsafe-${key}`),
          payload: {
            schemaVersion: "cmooc.test-unsafe-tape.v1",
            receiptHash: hash(`unsafe-${key}`),
            [key]: value,
            containsForumText: false
          } as unknown as CanonicalJsonValue
        }),
      /^Error: L3_DECISION_TAPE_PAYLOAD_UNSAFE(?::|$)/
    );
  }
});

test("L3 相同 receiptHash 但 payload 事实冲突时不伪造幂等", async () => {
  const { prisma } = await import("../../lib/db");
  const invocationId = "production-tape-receipt-conflict";
  const now = new Date("2026-07-31T12:00:00.000Z");
  const receiptHash = hash("same-receipt-different-facts");
  const invocationKey = hash("production-tape-receipt-conflict-key");
  await prisma.decisionTapeEntry.deleteMany({
    where: { invocationId }
  });
  await prisma.scheduledInvocation.deleteMany({
    where: { id: invocationId }
  });
  await prisma.autonomyCourseManifest.deleteMany({
    where: { alias: COURSE_ALIAS }
  });
  await prisma.autonomyCourseManifest.create({
    data: {
      alias: COURSE_ALIAS,
      manifestHash: hash("production-tape-receipt-conflict-manifest"),
      platformId: "test.platform",
      platformCourseRefHash: hash("production-tape-receipt-conflict-course"),
      canonicalLocatorHash: hash("production-tape-receipt-conflict-locator"),
      identityKeyFingerprint: hash("production-tape-receipt-conflict-identity"),
      allowedOrigin: "https://cmooc.example.test",
      timeZone: "Asia/Shanghai",
      defaultMode: "SHADOW",
      policyVersion: POLICY_VERSION,
      enabled: true,
      realPublishEnabled: false
    }
  });
  await prisma.scheduledInvocation.create({
    data: {
      id: invocationId,
      invocationKey,
      courseAlias: COURSE_ALIAS,
      manifestHash: hash("production-tape-receipt-conflict-manifest"),
      scheduledFor: now,
      mode: "SHADOW",
      status: "completed",
      phase: "completed",
      attempt: 1,
      startedAt: now,
      finishedAt: now,
      summaryJson: JSON.stringify({
        schemaVersion: "cmooc.test-invocation.v1",
        containsForumText: false
      })
    }
  });
  try {
    const firstPayload = {
      schemaVersion: "cmooc.test-receipt-conflict.v1",
      receiptHash,
      state: "confirmed_published",
      containsForumText: false
    } as const;
    await appendOneShotDecisionTapeEntry({
      prisma,
      invocationId,
      kind: "execution_receipt_committed",
      receiptHash,
      payload: firstPayload
    });
    await assert.rejects(
      () =>
        appendOneShotDecisionTapeEntry({
          prisma,
          invocationId,
          kind: "execution_receipt_committed",
          receiptHash,
          payload: {
            ...firstPayload,
            state: "outcome_unknown"
          }
        }),
      /L3_DECISION_TAPE_RECEIPT_CONFLICT/
    );
  } finally {
    await prisma.decisionTapeEntry.deleteMany({
      where: { invocationId }
    });
    await prisma.scheduledInvocation.deleteMany({
      where: { id: invocationId }
    });
    await prisma.autonomyCourseManifest.deleteMany({
      where: { alias: COURSE_ALIAS }
    });
  }
});

async function clearFixture(
  prisma: (typeof import("../../lib/db"))["prisma"]
) {
  const decisions = await prisma.autonomyDecision.findMany({
    where: { courseAlias: COURSE_ALIAS },
    select: { id: true, invocationId: true }
  });
  const decisionIds = decisions.map(({ id }) => id);
  const invocationIds = decisions.map(
    ({ invocationId }) => invocationId
  );
  await prisma.proximalOutcome.deleteMany({
    where: { decisionId: { in: decisionIds } }
  });
  await prisma.executionAttempt.deleteMany({
    where: { decisionId: { in: decisionIds } }
  });
  await prisma.executionAccountLease.deleteMany({
    where: { decisionId: { in: decisionIds } }
  });
  await prisma.executionPermit.deleteMany({
    where: { decisionId: { in: decisionIds } }
  });
  await prisma.executionStageReceipt.deleteMany({
    where: { decisionId: { in: decisionIds } }
  });
  await prisma.authorizedActionPlan.deleteMany({
    where: { decisionId: { in: decisionIds } }
  });
  await prisma.budgetReservation.deleteMany({
    where: { decisionId: { in: decisionIds } }
  });
  await prisma.semanticRealization.deleteMany({
    where: { decisionId: { in: decisionIds } }
  });
  await prisma.decisionTapeEntry.deleteMany({
    where: { invocationId: { in: invocationIds } }
  });
  await prisma.autonomyDecision.deleteMany({
    where: { id: { in: decisionIds } }
  });
  await prisma.autonomyObservation.deleteMany({
    where: { invocationId: { in: invocationIds } }
  });
  await prisma.schedulingLedger.deleteMany({
    where: { invocationId: { in: invocationIds } }
  });
  await prisma.autonomyPolicy.deleteMany({
    where: { courseAlias: COURSE_ALIAS }
  });
  await prisma.scheduledInvocation.deleteMany({
    where: { courseAlias: COURSE_ALIAS }
  });
  await prisma.autonomyCourseManifest.deleteMany({
    where: { alias: COURSE_ALIAS }
  });
}

test("真实执行只接受已完成 STAGE 的 SHADOW DRAFT，并以一次发送消费 Permit、预算与 STAGE", async () => {
  const { prisma } = await import("../../lib/db");
  const now = new Date("2026-07-31T12:00:00.000Z");
  const invocationId = "production-execution-invocation";
  const decisionId = "production-execution-decision";
  const threadKey = hash("production-thread");
  const targetVersionHash = hash("production-target-version");
  const eventSetHash = hash("production-event-set");
  const contentHash = hash(TRANSIENT_BODY);
  const observation = {
    schemaVersion: "cmooc.test-safe-observation.v1",
    threadKey,
    targetVersionHash,
    eventSetHash,
    containsForumText: false
  } as const;
  const observationReceiptHash = canonicalProtocolHash(
    observation.schemaVersion,
    observation as CanonicalJsonValue
  );

  await clearFixture(prisma);
  try {
    await prisma.autonomyCourseManifest.create({
      data: {
        alias: COURSE_ALIAS,
        manifestHash: hash("production-manifest"),
        platformId: "test.platform",
        platformCourseRefHash: hash("production-course-ref"),
        canonicalLocatorHash: hash("production-locator"),
        identityKeyFingerprint: hash("production-identity"),
        allowedOrigin: "https://cmooc.example.test",
        timeZone: "Asia/Shanghai",
        defaultMode: "SHADOW",
        policyVersion: POLICY_VERSION,
        enabled: true,
        realPublishEnabled: true
      }
    });
    await prisma.scheduledInvocation.create({
      data: {
        id: invocationId,
        invocationKey: hash("production-invocation-key"),
        courseAlias: COURSE_ALIAS,
        manifestHash: hash("production-manifest"),
        scheduledFor: now,
        mode: "SHADOW",
        status: "completed",
        phase: "completed",
        attempt: 1,
        startedAt: now,
        finishedAt: now,
        summaryJson: JSON.stringify({
          schemaVersion: "cmooc.test-invocation.v1",
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
        decisionKey: hash("production-decision-key"),
        threadKey,
        authorKey: hash("production-author"),
        decision: "draft",
        decisionMode: "DRAFT_ELIGIBLE",
        reasonCode: "draft_eligible",
        observationReceiptHash,
        opportunityReceiptHash: hash("production-opportunity"),
        evidenceBundleHash: hash("production-evidence"),
        intentHash: hash("production-intent"),
        moveSpecHash: hash("production-move"),
        draftContentHash: contentHash,
        policyVersion: POLICY_VERSION,
        worldHash: hash("production-world"),
        candidateSetHash: hash("production-candidates"),
        evidenceAsOf: now,
        decisionJson: JSON.stringify({
          schemaVersion: "cmooc.test-decision.v1",
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
        validFrom: "2026-07-31T11:55:00.000Z",
        validUntil: "2026-07-31T12:10:00.000Z",
        realPublishEnabled: true,
        containsForumText: false
      }
    });

    const executionAccount = await acquire({
      prisma,
      courseAlias: COURSE_ALIAS,
      invocationId,
      decisionId,
      accounts: [
        {
          accountRefHash: hash("production-execution-account"),
          credentialRefHash: hash("production-execution-credential"),
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

    await assert.rejects(
      () =>
        issueExecutionPermit({
          prisma,
          decisionId,
          now,
          executionPolicyVersion: EXECUTION_POLICY_VERSION,
          requireRealExecution: true,
          executionAccountLeaseId: executionAccount.leaseId
        }),
      /EXECUTION_VERIFIED_STAGE_REQUIRED/
    );

    const stageReceipt: StageCompanionReceipt = {
      schemaVersion: STAGE_COMPANION_RECEIPT_SCHEMA_VERSION,
      grantHash: hash("stage-grant"),
      runNonceHash: hash("stage-nonce"),
      courseAlias: COURSE_ALIAS,
      courseLocatorHash: hash("stage-course-locator"),
      pageIdentityHash: hash("stage-page"),
      driverSessionKey: hash("stage-session"),
      targetVersionHash,
      draftContentHash: contentHash,
      editorValueHash: contentHash,
      guardReceiptHash: hash("stage-guard"),
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
    const staged = await recordVerifiedExecutionStage({
      prisma,
      decisionId,
      policyVersion: EXECUTION_POLICY_VERSION,
      receipt: stageReceipt,
      receiptHash: stageReceiptHash,
      now: new Date(now.getTime() + 1_500),
      expiresInSeconds: 300
    });
    assert.equal(staged.status, "verified_cleared");

    await appendExecutionStageVerifiedTape({
      prisma,
      decisionId,
      executionPolicyVersion: EXECUTION_POLICY_VERSION,
      receipt: stageReceipt,
      receiptHash: stageReceiptHash,
      now: new Date(now.getTime() + 1_600)
    });
    await appendExecutionStageVerifiedTape({
      prisma,
      decisionId,
      executionPolicyVersion: EXECUTION_POLICY_VERSION,
      receipt: stageReceipt,
      receiptHash: stageReceiptHash,
      now: new Date(now.getTime() + 1_600)
    });
    await assertExecutionStageTapeRecorded({
      prisma,
      decisionId
    });
    await prisma.decisionTapeEntry.deleteMany({
      where: {
        invocationId,
        kind: "execution_stage_verified"
      }
    });
    await assert.rejects(
      () =>
        assertExecutionStageTapeRecorded({
          prisma,
          decisionId
        }),
      /EXECUTION_STAGE_TAPE_REQUIRED/
    );
    await appendExecutionStageVerifiedTape({
      prisma,
      decisionId,
      executionPolicyVersion: EXECUTION_POLICY_VERSION,
      receipt: stageReceipt,
      receiptHash: stageReceiptHash,
      now: new Date(now.getTime() + 1_800)
    });

    const preExecutionReceipt = {
      schemaVersion: PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
      courseAlias: COURSE_ALIAS,
      threadKey,
      targetVersionHash,
      eventSetHash,
      observedAt: new Date(now.getTime() + 2_500).toISOString(),
      containsForumText: false
    } as const;
    const preExecutionObservation = {
      receipt: preExecutionReceipt,
      receiptHash: hashPreExecutionTargetObservation(
        preExecutionReceipt
      )
    };
    await appendPreExecutionRevalidatedTape({
      prisma,
      invocationId,
      receiptHash: preExecutionObservation.receiptHash,
      targetVersionHash,
      eventSetHash,
      observedAt: new Date(now.getTime() + 2_500)
    });
    const issued = await issueExecutionPermit({
      prisma,
      decisionId,
      now: new Date(now.getTime() + 2_000),
      executionPolicyVersion: EXECUTION_POLICY_VERSION,
      requireRealExecution: true,
      executionAccountLeaseId: executionAccount.leaseId
    });
    assert.equal(issued.permit.realPublishEnabled, true);
    await appendExecutionPermitIssuedTape({
      prisma,
      invocationId,
      permitKey: issued.permit.permitKey,
      binding: issued.binding as unknown as CanonicalJsonValue,
      expiresAt: issued.permit.expiresAt,
      idempotent: issued.idempotent,
      realPublishEnabled: issued.permit.realPublishEnabled,
      issuedAt: new Date(now.getTime() + 2_100)
    });
    const changedEventReceipt = {
      ...preExecutionReceipt,
      eventSetHash: hash("production-event-set-changed")
    };
    await assert.rejects(
      () =>
        claimExecutionPermit({
          prisma,
          permitKey: issued.permit.permitKey,
          transport: "real_platform",
          now: new Date(now.getTime() + 2_900),
          preExecutionObservation: {
            receipt: changedEventReceipt,
            receiptHash: hashPreExecutionTargetObservation(
              changedEventReceipt
            )
          }
        }),
      /EXECUTION_PERMIT_INVALID:target_stale/
    );
    const claimed = await claimExecutionPermit({
      prisma,
      permitKey: issued.permit.permitKey,
      transport: "real_platform",
      now: new Date(now.getTime() + 3_000),
      preExecutionObservation
    });
    assert.equal(claimed.idempotent, false);
    assert.equal(claimed.attempt.status, "prepared_real");
    assert.equal(claimed.attempt.requestedMutationCount, 1);
    assert.equal(claimed.attempt.sentMutationCount, 0);
    assert.equal(claimed.attempt.publishAttempted, false);

    const repeatedClaim = await claimExecutionPermit({
      prisma,
      permitKey: issued.permit.permitKey,
      transport: "real_platform",
      now: new Date(now.getTime() + 3_500),
      preExecutionObservation
    });
    assert.equal(repeatedClaim.idempotent, true);
    assert.equal(repeatedClaim.attempt.id, claimed.attempt.id);

    const sending = await markExecutionAttemptSending({
      prisma,
      attemptId: claimed.attempt.id,
      now: new Date(now.getTime() + 4_000)
    });
    assert.equal(sending.attempt.status, "sending_real");
    assert.equal(sending.attempt.sentMutationCount, 1);
    assert.equal(sending.attempt.publishAttempted, true);
    const repeatedSending = await markExecutionAttemptSending({
      prisma,
      attemptId: claimed.attempt.id,
      now: new Date(now.getTime() + 4_500)
    });
    assert.equal(repeatedSending.idempotent, true);
    assert.equal(repeatedSending.attempt.sentMutationCount, 1);

    const settled = await settleExecutionAttemptReal({
      prisma,
      attemptId: claimed.attempt.id,
      state: "confirmed_published",
      remoteEvidenceHash: hash("verified-remote-evidence"),
      now: new Date(now.getTime() + 5_000)
    });
    assert.equal(settled.attempt.status, "confirmed_published");
    assert.equal(settled.permit.status, "used");
    assert.equal(settled.permit.realPublishEnabled, true);
    assert.equal(
      (
        await prisma.executionAccountLease.findUniqueOrThrow({
          where: { id: executionAccount.leaseId }
        })
      ).status,
      "consumed"
    );
    assert.equal(
      (
        await prisma.executionStageReceipt.findUniqueOrThrow({
          where: { decisionId }
        })
      ).status,
      "consumed"
    );
    assert.equal(
      (
        await prisma.budgetReservation.findFirstOrThrow({
          where: { decisionId }
        })
      ).status,
      "consumed"
    );
    assert.equal(
      (
        await prisma.autonomyDecision.findUniqueOrThrow({
          where: { id: decisionId }
        })
      ).publishAttempted,
      true
    );
    assert.equal(
      JSON.parse(settled.attempt.receiptJson).schemaVersion,
      PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION
    );
    assert.equal(
      remotePublicationReceiptIsBound({
        attempt: settled.attempt,
        permit: settled.permit
      }),
      true
    );

    assert.ok(settled.attempt.remoteOutcomeHash);
    await appendExecutionReceiptCommittedTape({
      prisma,
      invocationId,
      attemptId: settled.attempt.id,
      permitKey: settled.permit.permitKey,
      remoteOutcomeHash: settled.attempt.remoteOutcomeHash,
      status: "confirmed_published",
      requestedMutationCount:
        settled.attempt.requestedMutationCount,
      sentMutationCount: settled.attempt.sentMutationCount,
      recoveredByReconciliation: false,
      committedAt: new Date(now.getTime() + 5_100)
    });
    const committedTape =
      await prisma.decisionTapeEntry.findFirstOrThrow({
        where: {
          invocationId,
          kind: "execution_receipt_committed"
        },
        orderBy: { sequence: "desc" }
      });
    const committedPayload = JSON.parse(
      committedTape.payloadJson
    ) as Record<string, unknown>;
    assert.equal(
      committedPayload.committedAt,
      settled.attempt.finishedAt?.toISOString()
    );
    await appendPostExecutionObservedTape({
      prisma,
      invocationId,
      attemptId: settled.attempt.id,
      remoteOutcomeHash: settled.attempt.remoteOutcomeHash,
      status: "confirmed_published",
      recoveredByReconciliation: false,
      observedAt: new Date(now.getTime() + 5_200)
    });
    await appendOutcomeWindowsScheduledTape({
      prisma,
      invocationId,
      eligiblePublicationCount: 1,
      createdWindowCount: 0,
      existingWindowCount: 0,
      ineligibleDecisionCount: 0,
      scheduleSucceeded: true,
      scheduledAt: new Date(now.getTime() + 5_300)
    });
    const scheduleTape =
      await prisma.decisionTapeEntry.findFirstOrThrow({
        where: {
          invocationId,
          kind: "outcome_windows_scheduled"
        },
        orderBy: { sequence: "desc" }
      });
    const schedulePayload = JSON.parse(
      scheduleTape.payloadJson
    ) as Record<string, unknown>;
    assert.equal(schedulePayload.scheduleSucceeded, true);
    assert.equal(schedulePayload.created, 0);
    assert.equal(schedulePayload.existing, 0);
    assert.equal(schedulePayload.windowsPresent, false);
    const relocked = await relockOneShotPolicy({
      prisma,
      courseAlias: COURSE_ALIAS,
      now: new Date(now.getTime() + 5_500)
    });
    assert.equal(relocked.manifestLocked, true);
    assert.equal(relocked.globalHardLock, true);
    await appendExecutionPolicyRelockedTape({
      prisma,
      invocationId,
      revokedPolicyCount: relocked.revokedPolicyCount,
      closedPermitCount: relocked.closedPermitCount,
      manifestLocked: relocked.manifestLocked,
      globalHardLock: relocked.globalHardLock,
      relockedAt: new Date(now.getTime() + 5_600)
    });

    const tapeEntries = await prisma.decisionTapeEntry.findMany({
      where: { invocationId },
      orderBy: { sequence: "asc" }
    });
    assert.deepEqual(
      tapeEntries.map((entry) => entry.kind),
      [
        "execution_stage_verified",
        "pre_execution_revalidated",
        "execution_permit_issued",
        "execution_receipt_committed",
        "post_execution_observed",
        "outcome_windows_scheduled",
        "execution_policy_relocked"
      ]
    );
    const tapeVerification = await verifyDecisionTape({
      prisma,
      invocationId
    });
    assert.equal(tapeVerification.valid, true);
    assert.equal(tapeVerification.entryCount, 7);
    for (const entry of tapeEntries) {
      assert.equal(entry.containsForumText, false);
      const payload = JSON.parse(entry.payloadJson) as Record<
        string,
        unknown
      >;
      assert.equal(payload.containsForumText, false);
      assert.equal(
        JSON.stringify(payload).includes(TRANSIENT_BODY),
        false
      );
      assert.equal(
        JSON.stringify(payload).includes(issued.permit.permitKey),
        false
      );
      assert.equal(
        JSON.stringify(payload).includes(settled.attempt.id),
        false
      );
    }

    const rows = await prisma.$queryRawUnsafe<unknown[]>(
      `SELECT * FROM "ExecutionStageReceipt" WHERE "decisionId" = ?`,
      decisionId
    );
    assert.equal(
      JSON.stringify({ issued, staged, settled, rows }).includes(
        TRANSIENT_BODY
      ),
      false
    );
    assert.equal(REAL_FORUM_WRITE_LOCKED, true);
    assert.throws(
      () => assertRealForumWriteUnlocked(),
      new RegExp(REAL_FORUM_WRITE_LOCK_CODE)
    );
  } finally {
    await clearFixture(prisma);
  }
});
