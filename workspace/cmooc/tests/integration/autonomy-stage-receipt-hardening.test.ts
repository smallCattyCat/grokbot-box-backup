import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "../../lib/facilitation-protocol";
import {
  AUTONOMY_POLICY_SCHEMA_VERSION,
  hashCourseAutonomyPolicy,
  parseCourseAutonomyPolicy
} from "../../lib/autonomy/autonomy-policy";
import {
  assertExecutionStageTapeBinding,
  EXECUTION_STAGE_TAPE_INVALID_CODE,
  EXECUTION_STAGE_TAPE_REQUIRED_CODE,
  recordVerifiedExecutionStage
} from "../../lib/autonomy/execution-stage-receipt";
import {
  appendExecutionStageVerifiedTape,
  persistVerifiedBrowserStage
} from "../../lib/autonomy/one-shot-stage";
import {
  STAGE_COMPANION_RECEIPT_SCHEMA_VERSION,
  type StageCompanionReceipt
} from "../../lib/live-runtime/stage-companion";

const COURSE_ALIAS = "stage-receipt-hardening";
const INVOCATION_ID = "stage-receipt-hardening-invocation";
const DECISION_ID = "stage-receipt-hardening-decision";
const POLICY_VERSION = "stage-receipt-hardening.v1";
const ALTERNATE_POLICY_VERSION = "stage-receipt-hardening.v2";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type TapeRow = {
  sequence: number;
  entryHash: string;
  payloadHash: string;
  payloadJson: string;
  containsForumText: boolean;
};

function buildFixture() {
  const now = new Date("2026-08-09T12:00:00.000Z");
  const targetVersionHash = hash("stage-target");
  const draftContentHash = hash("stage-draft");
  const observation = {
    schemaVersion: "cmooc.synthetic-stage-observation.v1",
    threadKey: hash("stage-thread"),
    targetVersionHash,
    containsForumText: false
  } as const;
  const observationReceiptHash = canonicalProtocolHash(
    observation.schemaVersion,
    observation as unknown as CanonicalJsonValue
  );
  const decision = {
    id: DECISION_ID,
    invocationId: INVOCATION_ID,
    courseAlias: COURSE_ALIAS,
    decision: "draft",
    decisionMode: "DRAFT_ELIGIBLE",
    bodyPersisted: false,
    publishAttempted: false,
    draftContentHash,
    observationReceiptHash,
    threadKey: observation.threadKey,
    policyVersion: POLICY_VERSION
  };
  const policy = parseCourseAutonomyPolicy({
    schemaVersion: AUTONOMY_POLICY_SCHEMA_VERSION,
    courseAlias: COURSE_ALIAS,
    version: POLICY_VERSION,
    mode: "STAGE",
    allowedActions: ["stage_editor"],
    budget: {
      dailyActionLimit: 1,
      perTickActionLimit: 1,
      authorTouchLimit30d: 1
    },
    validFrom: "2026-08-09T11:00:00.000Z",
    validUntil: "2026-08-09T13:00:00.000Z",
    realPublishEnabled: false,
    containsForumText: false
  });
  const alternatePolicy = {
    ...policy,
    version: ALTERNATE_POLICY_VERSION
  };
  const policyRecord = (value: typeof policy) => ({
    courseAlias: value.courseAlias,
    version: value.version,
    mode: value.mode,
    allowedActionsJson: JSON.stringify(value.allowedActions),
    budgetJson: JSON.stringify(value.budget),
    policyHash: hashCourseAutonomyPolicy(value),
    validFrom: new Date(value.validFrom),
    validUntil: new Date(value.validUntil),
    status: "active",
    revokedAt: null,
    emergencyHalt: false,
    realPublishEnabled: value.realPublishEnabled
  });
  const policies = new Map([
    [POLICY_VERSION, policyRecord(policy)],
    [ALTERNATE_POLICY_VERSION, policyRecord(alternatePolicy)]
  ]);
  const stageReceipt: StageCompanionReceipt = {
    schemaVersion: STAGE_COMPANION_RECEIPT_SCHEMA_VERSION,
    grantHash: hash("stage-grant"),
    runNonceHash: hash("stage-nonce"),
    courseAlias: COURSE_ALIAS,
    courseLocatorHash: hash("stage-locator"),
    pageIdentityHash: hash("stage-page"),
    driverSessionKey: hash("stage-session"),
    targetVersionHash,
    draftContentHash,
    editorValueHash: draftContentHash,
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
  const receiptHash = canonicalProtocolHash(
    stageReceipt.schemaVersion,
    stageReceipt as unknown as CanonicalJsonValue
  );
  const state: {
    stageReceipt: Record<string, unknown> | null;
    tape: TapeRow[];
    failNextTapeCreate: boolean;
  } = {
    stageReceipt: null,
    tape: [],
    failNextTapeCreate: true
  };

  const transaction = {
    autonomyDecision: {
      findUniqueOrThrow: async () => decision,
      findUnique: async () => ({ invocationId: INVOCATION_ID })
    },
    autonomyPolicy: {
      findUnique: async ({ where }: { where: { courseAlias_version: { version: string } } }) =>
        policies.get(where.courseAlias_version.version) ?? null
    },
    autonomyObservation: {
      findUniqueOrThrow: async () => ({
        invocationId: INVOCATION_ID,
        threadKey: observation.threadKey,
        containsForumText: false,
        receiptJson: JSON.stringify(observation)
      })
    },
    executionStageReceipt: {
      findUnique: async () => state.stageReceipt,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.stageReceipt = {
          id: "stage-receipt-id",
          ...data
        };
        return state.stageReceipt;
      }
    },
    scheduledInvocation: {
      findUnique: async () => ({ id: INVOCATION_ID })
    },
    decisionTapeEntry: {
      findMany: async () => state.tape,
      findFirst: async () =>
        state.tape.length > 0
          ? state.tape[state.tape.length - 1]
          : null,
      create: async ({ data }: { data: TapeRow }) => {
        if (state.failNextTapeCreate) {
          state.failNextTapeCreate = false;
          throw new Error("SYNTHETIC_TAPE_APPEND_FAILED");
        }
        const row = {
          ...data,
          containsForumText: false
        };
        state.tape.push(row);
        return row;
      }
    }
  };
  const prisma = {
    ...transaction,
    $transaction: async <T>(callback: (tx: typeof transaction) => Promise<T>) =>
      callback(transaction),
    autonomyDecision: {
      ...transaction.autonomyDecision,
      update: async () => decision
    }
  } as unknown as PrismaClient;
  return {
    now,
    prisma,
    state,
    decision,
    stageReceipt,
    receiptHash
  };
}

test("同一 STAGE receipt 在 tape append 短暂失败后可重试并完成幂等审计绑定", async () => {
  const fixture = buildFixture();
  await assert.rejects(
    () =>
      persistVerifiedBrowserStage({
        prisma: fixture.prisma,
        decisionId: DECISION_ID,
        executionPolicyVersion: POLICY_VERSION,
        receipt: fixture.stageReceipt,
        receiptHash: fixture.receiptHash,
        now: new Date(fixture.now.getTime() + 2_000)
      }),
    /^Error: SYNTHETIC_TAPE_APPEND_FAILED$/
  );
  assert.equal(fixture.state.tape.length, 0);
  await assert.rejects(
    () =>
      assertExecutionStageTapeBinding({
        prisma: fixture.prisma,
        decisionId: DECISION_ID,
        receiptHash: fixture.receiptHash
      }),
    new RegExp(EXECUTION_STAGE_TAPE_REQUIRED_CODE)
  );

  const retried = await persistVerifiedBrowserStage({
    prisma: fixture.prisma,
    decisionId: DECISION_ID,
    executionPolicyVersion: POLICY_VERSION,
    receipt: fixture.stageReceipt,
    receiptHash: fixture.receiptHash,
    now: new Date(fixture.now.getTime() + 3_000)
  });
  assert.equal(retried.status, "verified_cleared");
  assert.equal(fixture.state.tape.length, 1);
  const repeated = await persistVerifiedBrowserStage({
    prisma: fixture.prisma,
    decisionId: DECISION_ID,
    executionPolicyVersion: POLICY_VERSION,
    receipt: fixture.stageReceipt,
    receiptHash: fixture.receiptHash,
    now: new Date(fixture.now.getTime() + 4_000)
  });
  assert.equal(repeated.status, "verified_cleared");
  assert.equal(fixture.state.tape.length, 1);
  const bound = await assertExecutionStageTapeBinding({
    prisma: fixture.prisma,
    decisionId: DECISION_ID,
    receiptHash: fixture.receiptHash
  });
  assert.equal(bound.status, "verified_cleared");
});

test("existing STAGE receipt 的 policyVersion 只接受当前输入版本", async () => {
  const fixture = buildFixture();
  fixture.state.failNextTapeCreate = false;
  await recordVerifiedExecutionStage({
    prisma: fixture.prisma,
    decisionId: DECISION_ID,
    policyVersion: POLICY_VERSION,
    receipt: fixture.stageReceipt,
    receiptHash: fixture.receiptHash,
    now: new Date(fixture.now.getTime() + 2_000)
  });
  await assert.rejects(
    () =>
      recordVerifiedExecutionStage({
        prisma: fixture.prisma,
        decisionId: DECISION_ID,
        policyVersion: ALTERNATE_POLICY_VERSION,
        receipt: fixture.stageReceipt,
        receiptHash: fixture.receiptHash,
        now: new Date(fixture.now.getTime() + 2_500)
      }),
    /^Error: EXECUTION_STAGE_IMMUTABILITY_CONFLICT$/
  );
});

test("STAGE tape 缺失、存在和畸形均使用稳定 fail-closed 结果", async () => {
  const fixture = buildFixture();
  fixture.state.failNextTapeCreate = false;
  await assert.rejects(
    () =>
      assertExecutionStageTapeBinding({
        prisma: fixture.prisma,
        decisionId: DECISION_ID,
        receiptHash: fixture.receiptHash
      }),
    new RegExp(EXECUTION_STAGE_TAPE_REQUIRED_CODE)
  );
  await appendExecutionStageVerifiedTape({
    prisma: fixture.prisma,
    decisionId: DECISION_ID,
    executionPolicyVersion: POLICY_VERSION,
    receipt: fixture.stageReceipt,
    receiptHash: fixture.receiptHash,
    now: new Date(fixture.now.getTime() + 2_000)
  });
  await assert.doesNotReject(() =>
    assertExecutionStageTapeBinding({
      prisma: fixture.prisma,
      decisionId: DECISION_ID,
      receiptHash: fixture.receiptHash
    })
  );
  fixture.state.tape[0].payloadJson = "{malformed";
  await assert.rejects(
    () =>
      assertExecutionStageTapeBinding({
        prisma: fixture.prisma,
        decisionId: DECISION_ID,
        receiptHash: fixture.receiptHash
      }),
    new RegExp(EXECUTION_STAGE_TAPE_INVALID_CODE)
  );
});
