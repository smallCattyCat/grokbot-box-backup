import type {
  AutonomyDecision,
  ExecutionStageReceipt,
  Prisma,
  PrismaClient
} from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  STAGE_COMPANION_RECEIPT_SCHEMA_VERSION,
  type StageCompanionReceiptV2
} from "@/lib/live-runtime/stage-companion";
import {
  validateAutonomyPolicy,
  verifyAutonomyPolicyRecord
} from "./autonomy-policy";

type PrismaLike = PrismaClient | Prisma.TransactionClient;

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export const EXECUTION_STAGE_VERIFIED_TAPE_SCHEMA_VERSION =
  "cmooc.l3-execution-stage-verified.v1" as const;
export const EXECUTION_STAGE_TAPE_REQUIRED_CODE =
  "EXECUTION_STAGE_TAPE_REQUIRED" as const;
export const EXECUTION_STAGE_TAPE_INVALID_CODE =
  "EXECUTION_STAGE_TAPE_INVALID" as const;

type ExecutionStageTapeBinding = {
  readonly sequence: number;
  readonly entryHash: string;
  readonly payloadHash: string;
  readonly invocationId: string;
  readonly receiptHash: string;
  readonly status: "verified_cleared";
};

function hash(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !HASH_PATTERN.test(value.toLowerCase())
  ) {
    throw new Error(`${label}必须是 SHA-256 十六进制摘要。`);
  }
  return value.toLowerCase();
}

function failExecutionStageTape(
  code:
  | typeof EXECUTION_STAGE_TAPE_REQUIRED_CODE
  | typeof EXECUTION_STAGE_TAPE_INVALID_CODE
): never {
  throw new Error(code);
}

function parseExecutionStageTapePayload(
  payloadJson: string
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(payloadJson) as unknown;
  } catch {
    failExecutionStageTape(EXECUTION_STAGE_TAPE_INVALID_CODE);
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    failExecutionStageTape(EXECUTION_STAGE_TAPE_INVALID_CODE);
  }
  return value as Record<string, unknown>;
}

/**
 * Read-only proof that a persisted STAGE receipt is represented by the
 * matching, redacted Decision Tape fact.  A stage may be consumed only after
 * this binding succeeds; absent, malformed, or mismatched tape data always
 * fails with a stable code.
 */
export async function assertExecutionStageTapeBinding(input: {
  prisma: PrismaLike;
  decisionId: string;
  receiptHash: string;
}): Promise<ExecutionStageTapeBinding> {
  if (
    typeof input.decisionId !== "string" ||
    input.decisionId.length === 0 ||
    typeof input.receiptHash !== "string" ||
    !HASH_PATTERN.test(input.receiptHash.toLowerCase())
  ) {
    failExecutionStageTape(EXECUTION_STAGE_TAPE_INVALID_CODE);
  }
  let decision: { invocationId: string } | null;
  let entries: Array<{
    sequence: number;
    entryHash: string;
    payloadHash: string;
    payloadJson: string;
    containsForumText: boolean;
  }>;
  try {
    decision = await input.prisma.autonomyDecision.findUnique({
      where: { id: input.decisionId },
      select: { invocationId: true }
    });
    if (!decision) {
      failExecutionStageTape(EXECUTION_STAGE_TAPE_REQUIRED_CODE);
    }
    entries = await input.prisma.decisionTapeEntry.findMany({
      where: {
        invocationId: decision.invocationId,
        kind: "execution_stage_verified"
      },
      orderBy: { sequence: "asc" },
      select: {
        sequence: true,
        entryHash: true,
        payloadHash: true,
        payloadJson: true,
        containsForumText: true
      }
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === EXECUTION_STAGE_TAPE_REQUIRED_CODE ||
        error.message === EXECUTION_STAGE_TAPE_INVALID_CODE)
    ) {
      throw error;
    }
    // A read failure is indistinguishable from an unavailable audit fact to
    // the caller and must never permit STAGE consumption.
    failExecutionStageTape(EXECUTION_STAGE_TAPE_REQUIRED_CODE);
  }
  if (!Array.isArray(entries)) {
    failExecutionStageTape(EXECUTION_STAGE_TAPE_INVALID_CODE);
  }
  if (entries.length === 0) {
    failExecutionStageTape(EXECUTION_STAGE_TAPE_REQUIRED_CODE);
  }

  const matching: Array<ExecutionStageTapeBinding> = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      failExecutionStageTape(EXECUTION_STAGE_TAPE_INVALID_CODE);
    }
    const payload = parseExecutionStageTapePayload(
      entry.payloadJson
    );
    if (payload.receiptHash !== input.receiptHash) {
      continue;
    }
    if (
      entry.containsForumText !== false ||
      payload.schemaVersion !==
        EXECUTION_STAGE_VERIFIED_TAPE_SCHEMA_VERSION ||
      payload.receiptHash !== input.receiptHash ||
      payload.status !== "verified_cleared" ||
      payload.containsForumText !== false
    ) {
      failExecutionStageTape(EXECUTION_STAGE_TAPE_INVALID_CODE);
    }
    matching.push({
      sequence: entry.sequence,
      entryHash: entry.entryHash,
      payloadHash: entry.payloadHash,
      invocationId: decision.invocationId,
      receiptHash: input.receiptHash,
      status: "verified_cleared"
    });
  }
  if (matching.length !== 1) {
    failExecutionStageTape(
      matching.length === 0
        ? EXECUTION_STAGE_TAPE_REQUIRED_CODE
        : EXECUTION_STAGE_TAPE_INVALID_CODE
    );
  }
  return matching[0];
}

// Keep a verb-style alias available to callers that use validators rather
// than assertion naming; both functions are the same read-only check.
export const verifyExecutionStageTapeBinding =
  assertExecutionStageTapeBinding;

function observationTargetVersion(
  receiptJson: string,
  expectedThreadKey: string
): string {
  let value: unknown;
  try {
    value = JSON.parse(receiptJson) as unknown;
  } catch {
    throw new Error("EXECUTION_STAGE_OBSERVATION_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("EXECUTION_STAGE_OBSERVATION_INVALID");
  }
  const receipt = value as Record<string, unknown>;
  if (
    receipt.containsForumText !== false ||
    receipt.threadKey !== expectedThreadKey
  ) {
    throw new Error("EXECUTION_STAGE_OBSERVATION_UNSAFE");
  }
  return hash(
    receipt.targetVersionHash,
    "STAGE 目标版本"
  );
}

function assertVerifiedReceipt(
  receipt: StageCompanionReceiptV2,
  receiptHash: string
): void {
  if (
    receipt.schemaVersion !==
      STAGE_COMPANION_RECEIPT_SCHEMA_VERSION ||
    receipt.state !==
      "DRAFT_STAGED_VERIFIED_AND_CLEARED_NOT_PUBLISHED" ||
    receipt.editorWriteCount !== 1 ||
    receipt.editorReadbackVerified !== true ||
    receipt.editorClearCount !== 1 ||
    receipt.editorEmptyAfterClear !== true ||
    receipt.sentMutationCount !== 0 ||
    receipt.publishAttempted !== false ||
    receipt.realPublishEnabled !== false ||
    receipt.bodyPersisted !== false ||
    receipt.containsForumText !== false ||
    receipt.editorValueHash !== receipt.draftContentHash ||
    canonicalProtocolHash(
      receipt.schemaVersion,
      receipt as unknown as CanonicalJsonValue
    ) !== hash(receiptHash, "STAGE 回执")
  ) {
    throw new Error("EXECUTION_STAGE_RECEIPT_INVALID");
  }
  for (const [value, label] of [
    [receipt.grantHash, "STAGE grant"],
    [receipt.runNonceHash, "STAGE nonce"],
    [receipt.courseLocatorHash, "STAGE 课程定位"],
    [receipt.pageIdentityHash, "STAGE 页面身份"],
    [receipt.driverSessionKey, "STAGE 驱动会话"],
    [receipt.targetVersionHash, "STAGE 目标版本"],
    [receipt.draftContentHash, "STAGE 内容"],
    [receipt.guardReceiptHash, "STAGE 守卫"]
  ] as const) {
    hash(value, label);
  }
}

export async function recordVerifiedExecutionStage(input: {
  prisma: PrismaClient;
  decisionId: string;
  policyVersion: string;
  receipt: StageCompanionReceiptV2;
  receiptHash: string;
  now: Date;
  expiresInSeconds?: number;
}): Promise<ExecutionStageReceipt> {
  assertVerifiedReceipt(input.receipt, input.receiptHash);
  const observedAt = new Date(input.receipt.observedAt);
  if (
    !Number.isFinite(observedAt.getTime()) ||
    observedAt.getTime() > input.now.getTime() + 5_000 ||
    input.now.getTime() - observedAt.getTime() > 5 * 60_000
  ) {
    throw new Error("EXECUTION_STAGE_RECEIPT_STALE");
  }
  const ttlSeconds = Math.max(
    30,
    Math.min(600, Math.floor(input.expiresInSeconds ?? 300))
  );
  return input.prisma.$transaction(async (transaction) => {
    const decision =
      await transaction.autonomyDecision.findUniqueOrThrow({
        where: { id: input.decisionId }
      });
    if (
      decision.courseAlias !== input.receipt.courseAlias ||
      decision.decision !== "draft" ||
      decision.decisionMode !== "DRAFT_ELIGIBLE" ||
      decision.bodyPersisted ||
      decision.publishAttempted ||
      !decision.draftContentHash ||
      decision.draftContentHash !== input.receipt.draftContentHash
    ) {
      throw new Error("EXECUTION_STAGE_DECISION_MISMATCH");
    }
    const policy = await transaction.autonomyPolicy.findUnique({
      where: {
        courseAlias_version: {
          courseAlias: decision.courseAlias,
          version: input.policyVersion
        }
      }
    });
    if (!policy) {
      throw new Error("EXECUTION_STAGE_POLICY_NOT_FOUND");
    }
    const policyValidation = validateAutonomyPolicy({
      verified: verifyAutonomyPolicyRecord(policy),
      courseAlias: decision.courseAlias,
      policyVersion: input.policyVersion,
      action: "stage_editor",
      mode: "STAGE",
      now: input.now,
      requireRealPublish: false
    });
    if (!policyValidation.valid) {
      throw new Error(
        `EXECUTION_STAGE_POLICY_INVALID:${policyValidation.code}`
      );
    }
    const observation =
      await transaction.autonomyObservation.findUniqueOrThrow({
        where: {
          receiptHash: decision.observationReceiptHash
        }
      });
    if (
      observation.invocationId !== decision.invocationId ||
      observation.threadKey !== decision.threadKey ||
      observation.containsForumText ||
      observationTargetVersion(
        observation.receiptJson,
        decision.threadKey
      ) !== input.receipt.targetVersionHash
    ) {
      throw new Error("EXECUTION_STAGE_TARGET_MISMATCH");
    }
    const existing =
      await transaction.executionStageReceipt.findUnique({
        where: { decisionId: decision.id }
      });
    if (existing) {
      if (
        existing.receiptHash !== input.receiptHash ||
        existing.courseAlias !== decision.courseAlias ||
        existing.policyVersion !== input.policyVersion ||
        existing.targetVersionHash !==
          input.receipt.targetVersionHash ||
        existing.contentHash !==
          input.receipt.draftContentHash ||
        existing.containsForumText ||
        existing.bodyPersisted
      ) {
        throw new Error("EXECUTION_STAGE_IMMUTABILITY_CONFLICT");
      }
      return existing;
    }
    return transaction.executionStageReceipt.create({
      data: {
        decisionId: decision.id,
        courseAlias: decision.courseAlias,
        policyVersion: input.policyVersion,
        receiptHash: input.receiptHash,
        targetVersionHash: input.receipt.targetVersionHash,
        contentHash: input.receipt.draftContentHash,
        status: "verified_cleared",
        observedAt,
        expiresAt: new Date(
          input.now.getTime() + ttlSeconds * 1_000
        ),
        usedAt: null,
        editorWriteCount: 1,
        editorClearCount: 1,
        sentMutationCount: 0,
        publishAttempted: false,
        bodyPersisted: false,
        containsForumText: false
      }
    });
  });
}

export async function loadVerifiedExecutionStage(input: {
  prisma: PrismaLike;
  decision: AutonomyDecision;
  targetVersionHash: string;
  contentHash: string;
  policyVersion: string;
  now: Date;
}): Promise<ExecutionStageReceipt> {
  const receipt =
    await input.prisma.executionStageReceipt.findUnique({
      where: { decisionId: input.decision.id }
    });
  if (!receipt) {
    throw new Error("EXECUTION_VERIFIED_STAGE_REQUIRED");
  }
  if (
    receipt.courseAlias !== input.decision.courseAlias ||
    receipt.policyVersion !== input.policyVersion ||
    receipt.targetVersionHash !== input.targetVersionHash ||
    receipt.contentHash !== input.contentHash ||
    receipt.status !== "verified_cleared" ||
    receipt.usedAt ||
    receipt.expiresAt.getTime() <= input.now.getTime() ||
    receipt.editorWriteCount !== 1 ||
    receipt.editorClearCount !== 1 ||
    receipt.sentMutationCount !== 0 ||
    receipt.publishAttempted ||
    receipt.bodyPersisted ||
    receipt.containsForumText
  ) {
    throw new Error("EXECUTION_VERIFIED_STAGE_INVALID");
  }
  await assertExecutionStageTapeBinding({
    prisma: input.prisma,
    decisionId: input.decision.id,
    receiptHash: receipt.receiptHash
  });
  return receipt;
}

export async function consumeVerifiedExecutionStage(input: {
  prisma: PrismaLike;
  decisionId: string;
  now: Date;
  validAt?: Date;
}): Promise<ExecutionStageReceipt> {
  const receipt =
    await input.prisma.executionStageReceipt.findUniqueOrThrow({
      where: { decisionId: input.decisionId }
    });
  await assertExecutionStageTapeBinding({
    prisma: input.prisma,
    decisionId: input.decisionId,
    receiptHash: receipt.receiptHash
  });
  if (receipt.status === "consumed" && receipt.usedAt) {
    return receipt;
  }
  if (
    receipt.status !== "verified_cleared" ||
    receipt.usedAt ||
    receipt.expiresAt.getTime() <=
      (input.validAt ?? input.now).getTime()
  ) {
    throw new Error("EXECUTION_VERIFIED_STAGE_NOT_CONSUMABLE");
  }
  return input.prisma.executionStageReceipt.update({
    where: { id: receipt.id },
    data: { status: "consumed", usedAt: input.now }
  });
}
