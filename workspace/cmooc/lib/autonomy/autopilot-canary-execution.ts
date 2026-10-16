import type {
  AutonomyDecision,
  ExecutionAttempt,
  ExecutionPermit,
  PrismaClient,
  ScheduledInvocation
} from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  validateAutonomyPolicy,
  verifyAutonomyPolicyRecord
} from "./autonomy-policy";
import {
  EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
  claimExecutionPermit,
  issueExecutionPermit,
  settleExecutionAttemptNoWrite,
  validateExecutionPermit
} from "./execution-permit";

export const AUTOPILOT_CANARY_DEFAULT_ENABLED = false as const;
export const AUTOPILOT_CANARY_EXECUTION_SUMMARY_SCHEMA_VERSION =
  "cmooc.autopilot-canary-execution-summary.v1" as const;

const INPUT_KEYS = new Set([
  "prisma",
  "courseAlias",
  "invocationId",
  "decisionId",
  "executionPolicyVersion",
  "now"
]);
const TERMINAL_RECEIPT_KEYS = new Set([
  "schemaVersion",
  "permitKey",
  "idempotencyKey",
  "targetHash",
  "targetVersionHash",
  "contentHash",
  "state",
  "observedAt",
  "requestedMutationCount",
  "sentMutationCount",
  "publishAttempted",
  "realPublishEnabled",
  "bodyPersisted",
  "containsForumText"
]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export type AutopilotCanaryRecoveryState =
  | "none"
  | "permit_active"
  | "attempt_claimed"
  | "terminal";

export type AutopilotCanaryExecutionSummary = {
  schemaVersion:
    typeof AUTOPILOT_CANARY_EXECUTION_SUMMARY_SCHEMA_VERSION;
  courseAlias: string;
  invocationId: string;
  decisionId: string;
  executionPolicyVersion: string;
  attemptId: string;
  terminalReceiptHash: string;
  state: "completed_no_write";
  recoveredFrom: AutopilotCanaryRecoveryState;
  idempotent: boolean;
  requestedMutationCount: 0;
  sentMutationCount: 0;
  publishAttempted: false;
  realPublishEnabled: false;
  bodyPersisted: false;
  containsForumText: false;
};

type CanarySource = {
  invocation: ScheduledInvocation;
  decision: AutonomyDecision;
};

type SafeExecutionState =
  | { kind: "empty"; permit: null; attempt: null }
  | {
      kind: "permit_active";
      permit: ExecutionPermit;
      attempt: null;
    }
  | {
      kind: "attempt_claimed";
      permit: ExecutionPermit;
      attempt: ExecutionAttempt;
    }
  | {
      kind: "terminal";
      permit: ExecutionPermit;
      attempt: ExecutionAttempt;
    };

function assertExactKeys(
  value: Record<string, unknown>,
  expected: Set<string>,
  code: string
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new Error(code);
  }
}

function assertHash(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !HASH_PATTERN.test(value.toLowerCase())
  ) {
    throw new Error(code);
  }
  return value.toLowerCase();
}

function assertExactInput(input: {
  prisma: PrismaClient;
  courseAlias: string;
  invocationId: string;
  decisionId: string;
  executionPolicyVersion: string;
  now: Date;
}): void {
  assertExactKeys(
    input as unknown as Record<string, unknown>,
    INPUT_KEYS,
    "AUTOPILOT_CANARY_INPUT_KEYS_INVALID"
  );
  if (
    !input.courseAlias ||
    !input.invocationId ||
    !input.decisionId ||
    !input.executionPolicyVersion ||
    !(input.now instanceof Date) ||
    !Number.isFinite(input.now.getTime())
  ) {
    throw new Error("AUTOPILOT_CANARY_INPUT_INVALID");
  }
}

async function loadAndAssertCanarySource(input: {
  prisma: PrismaClient;
  courseAlias: string;
  invocationId: string;
  decisionId: string;
  executionPolicyVersion: string;
  now: Date;
}): Promise<CanarySource> {
  const [invocation, decision, manifest, policy] = await Promise.all([
    input.prisma.scheduledInvocation.findUnique({
      where: { id: input.invocationId }
    }),
    input.prisma.autonomyDecision.findUnique({
      where: { id: input.decisionId }
    }),
    input.prisma.autonomyCourseManifest.findUnique({
      where: { alias: input.courseAlias }
    }),
    input.prisma.autonomyPolicy.findUnique({
      where: {
        courseAlias_version: {
          courseAlias: input.courseAlias,
          version: input.executionPolicyVersion
        }
      }
    })
  ]);
  if (
    !invocation ||
    invocation.id !== input.invocationId ||
    invocation.courseAlias !== input.courseAlias ||
    invocation.mode !== "SHADOW" ||
    invocation.status !== "completed" ||
    invocation.phase !== "completed" ||
    !invocation.finishedAt ||
    invocation.leaseOwner !== null ||
    invocation.leaseExpiresAt !== null
  ) {
    throw new Error(
      "AUTOPILOT_CANARY_COMPLETED_SHADOW_INVOCATION_REQUIRED"
    );
  }
  if (
    !decision ||
    decision.id !== input.decisionId ||
    decision.invocationId !== input.invocationId ||
    decision.courseAlias !== input.courseAlias ||
    decision.decision !== "draft" ||
    decision.decisionMode !== "DRAFT_ELIGIBLE" ||
    decision.reasonCode !== "draft_eligible" ||
    !decision.authorKey ||
    !decision.intentHash ||
    !decision.moveSpecHash ||
    !decision.draftContentHash ||
    decision.policyVersion !== input.executionPolicyVersion ||
    decision.bodyPersisted ||
    decision.publishAttempted ||
    decision.editorWriteAttempted
  ) {
    throw new Error("AUTOPILOT_CANARY_EXACT_DRAFT_REQUIRED");
  }
  if (
    !manifest ||
    manifest.alias !== input.courseAlias ||
    !manifest.enabled ||
    manifest.realPublishEnabled ||
    manifest.manifestHash !== invocation.manifestHash ||
    manifest.policyVersion !== input.executionPolicyVersion
  ) {
    throw new Error("AUTOPILOT_CANARY_MANIFEST_LOCK_INVALID");
  }
  if (
    !policy ||
    policy.courseAlias !== input.courseAlias ||
    policy.version !== input.executionPolicyVersion ||
    policy.status !== "active" ||
    policy.revokedAt !== null ||
    policy.emergencyHalt ||
    policy.realPublishEnabled
  ) {
    throw new Error("AUTOPILOT_CANARY_POLICY_LOCK_INVALID");
  }
  const verified = verifyAutonomyPolicyRecord(policy);
  const validation = validateAutonomyPolicy({
    verified,
    courseAlias: input.courseAlias,
    policyVersion: input.executionPolicyVersion,
    action: "forum_reply",
    mode: "AUTO",
    now: input.now,
    requireRealPublish: false
  });
  if (!validation.valid) {
    throw new Error(
      `AUTOPILOT_CANARY_POLICY_INVALID:${validation.code}`
    );
  }
  return { invocation, decision };
}

async function loadAndAssertHistoricalCanarySource(input: {
  prisma: PrismaClient;
  courseAlias: string;
  invocationId: string;
  decisionId: string;
  executionPolicyVersion: string;
}): Promise<CanarySource> {
  const [invocation, decision] = await Promise.all([
    input.prisma.scheduledInvocation.findUnique({
      where: { id: input.invocationId }
    }),
    input.prisma.autonomyDecision.findUnique({
      where: { id: input.decisionId }
    })
  ]);
  if (
    !invocation ||
    invocation.id !== input.invocationId ||
    invocation.courseAlias !== input.courseAlias ||
    invocation.mode !== "SHADOW" ||
    invocation.status !== "completed" ||
    invocation.phase !== "completed" ||
    !invocation.finishedAt ||
    invocation.leaseOwner !== null ||
    invocation.leaseExpiresAt !== null
  ) {
    throw new Error(
      "AUTOPILOT_CANARY_HISTORICAL_INVOCATION_BINDING_INVALID"
    );
  }
  if (
    !decision ||
    decision.id !== input.decisionId ||
    decision.invocationId !== input.invocationId ||
    decision.courseAlias !== input.courseAlias ||
    decision.policyVersion !== input.executionPolicyVersion ||
    decision.decision !== "draft" ||
    decision.decisionMode !== "DRAFT_ELIGIBLE" ||
    decision.reasonCode !== "draft_eligible" ||
    !decision.authorKey ||
    !decision.intentHash ||
    !decision.moveSpecHash ||
    !decision.draftContentHash ||
    decision.bodyPersisted ||
    decision.publishAttempted ||
    decision.editorWriteAttempted
  ) {
    throw new Error(
      "AUTOPILOT_CANARY_HISTORICAL_DECISION_BINDING_INVALID"
    );
  }
  return { invocation, decision };
}

function assertSafePermit(
  permit: ExecutionPermit,
  input: {
    courseAlias: string;
    decisionId: string;
    executionPolicyVersion: string;
    now: Date;
  }
): void {
  if (
    permit.courseAlias !== input.courseAlias ||
    permit.decisionId !== input.decisionId ||
    permit.policyVersion !== input.executionPolicyVersion
  ) {
    throw new Error("AUTOPILOT_CANARY_PERMIT_BINDING_INVALID");
  }
  if (permit.realPublishEnabled) {
    throw new Error("AUTOPILOT_CANARY_REAL_PERMIT_FORBIDDEN");
  }
  if (
    permit.executionAccountLeaseId !== null ||
    permit.executionAccountRefHash !== null ||
    permit.credentialRefHash !== null
  ) {
    throw new Error("AUTOPILOT_CANARY_ACCOUNT_LEASE_FORBIDDEN");
  }
  if (
    permit.executionProofKind !== "trusted_stage" ||
    permit.actionPlanHash !== null
  ) {
    throw new Error("AUTOPILOT_CANARY_ACTION_PLAN_FORBIDDEN");
  }
  if (
    permit.revokedAt !== null ||
    !["active", "claimed", "used"].includes(permit.status)
  ) {
    throw new Error("AUTOPILOT_CANARY_PERMIT_STATE_INVALID");
  }
  if (
    permit.status === "active" &&
    permit.expiresAt.getTime() <= input.now.getTime()
  ) {
    throw new Error("AUTOPILOT_CANARY_PERMIT_EXPIRED");
  }
}

function assertSafeAttempt(
  attempt: ExecutionAttempt,
  permit: ExecutionPermit,
  decisionId: string
): void {
  if (
    attempt.decisionId !== decisionId ||
    attempt.permitId !== permit.id ||
    attempt.idempotencyKey !== permit.idempotencyKey ||
    attempt.mode !== "AUTO" ||
    attempt.transport !== "simulated_no_write" ||
    attempt.requestedMutationCount !== 0 ||
    attempt.sentMutationCount !== 0 ||
    attempt.publishAttempted ||
    attempt.remoteOutcomeHash !== null ||
    attempt.executionAccountRefHash !== null
  ) {
    throw new Error("AUTOPILOT_CANARY_MUTATION_STATE_FORBIDDEN");
  }
  if (
    attempt.status !== "claimed_no_write" &&
    attempt.status !== "completed_no_write"
  ) {
    throw new Error("AUTOPILOT_CANARY_ATTEMPT_STATE_INVALID");
  }
}

async function loadSafeExecutionState(input: {
  prisma: PrismaClient;
  courseAlias: string;
  decisionId: string;
  executionPolicyVersion: string;
  now: Date;
}): Promise<SafeExecutionState> {
  const [actionPlanCount, stageCount, leaseCount, permits, attempts] =
    await Promise.all([
      input.prisma.authorizedActionPlan.count({
        where: { decisionId: input.decisionId }
      }),
      input.prisma.executionStageReceipt.count({
        where: { decisionId: input.decisionId }
      }),
      input.prisma.executionAccountLease.count({
        where: { decisionId: input.decisionId }
      }),
      input.prisma.executionPermit.findMany({
        where: { decisionId: input.decisionId },
        orderBy: { createdAt: "asc" }
      }),
      input.prisma.executionAttempt.findMany({
        where: { decisionId: input.decisionId },
        orderBy: { createdAt: "asc" }
      })
    ]);
  if (actionPlanCount !== 0) {
    throw new Error("AUTOPILOT_CANARY_ACTION_PLAN_FORBIDDEN");
  }
  if (stageCount !== 0) {
    throw new Error("AUTOPILOT_CANARY_STAGE_FORBIDDEN");
  }
  if (leaseCount !== 0) {
    throw new Error("AUTOPILOT_CANARY_ACCOUNT_LEASE_FORBIDDEN");
  }
  if (permits.length > 1 || attempts.length > 1) {
    throw new Error("AUTOPILOT_CANARY_EXECUTION_CARDINALITY_INVALID");
  }
  if (permits.length === 0) {
    if (attempts.length !== 0) {
      throw new Error("AUTOPILOT_CANARY_ORPHAN_ATTEMPT_FORBIDDEN");
    }
    return { kind: "empty", permit: null, attempt: null };
  }
  const permit = permits[0];
  assertSafePermit(permit, input);
  const attempt = attempts[0] ?? null;
  if (attempt) {
    assertSafeAttempt(attempt, permit, input.decisionId);
  }
  if (permit.status === "active") {
    if (attempt || permit.usedAt !== null) {
      throw new Error("AUTOPILOT_CANARY_ACTIVE_STATE_INVALID");
    }
    return { kind: "permit_active", permit, attempt: null };
  }
  if (permit.status === "claimed") {
    if (
      !attempt ||
      attempt.status !== "claimed_no_write" ||
      attempt.finishedAt !== null ||
      permit.usedAt !== null
    ) {
      throw new Error("AUTOPILOT_CANARY_CLAIMED_STATE_INVALID");
    }
    return { kind: "attempt_claimed", permit, attempt };
  }
  if (
    !attempt ||
    attempt.status !== "completed_no_write" ||
    !attempt.finishedAt ||
    !permit.usedAt
  ) {
    throw new Error("AUTOPILOT_CANARY_TERMINAL_STATE_INVALID");
  }
  return { kind: "terminal", permit, attempt };
}

export function verifyAutopilotCanaryTerminalReceipt(input: {
  permit: ExecutionPermit;
  attempt: ExecutionAttempt;
}): string {
  let raw: unknown;
  try {
    raw = JSON.parse(input.attempt.receiptJson) as unknown;
  } catch {
    throw new Error("AUTOPILOT_CANARY_RECEIPT_JSON_INVALID");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("AUTOPILOT_CANARY_RECEIPT_INVALID");
  }
  const receipt = raw as Record<string, unknown>;
  assertExactKeys(
    receipt,
    TERMINAL_RECEIPT_KEYS,
    "AUTOPILOT_CANARY_RECEIPT_KEYS_INVALID"
  );
  const observedAt =
    typeof receipt.observedAt === "string"
      ? new Date(receipt.observedAt)
      : new Date(Number.NaN);
  if (
    receipt.schemaVersion !==
      EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION ||
    receipt.permitKey !== input.permit.permitKey ||
    receipt.idempotencyKey !== input.permit.idempotencyKey ||
    assertHash(
      receipt.targetHash,
      "AUTOPILOT_CANARY_RECEIPT_TARGET_HASH_INVALID"
    ) !== input.permit.targetHash ||
    assertHash(
      receipt.targetVersionHash,
      "AUTOPILOT_CANARY_RECEIPT_TARGET_VERSION_INVALID"
    ) !== input.permit.targetVersionHash ||
    assertHash(
      receipt.contentHash,
      "AUTOPILOT_CANARY_RECEIPT_CONTENT_HASH_INVALID"
    ) !== input.permit.contentHash ||
    receipt.state !== "completed_no_write" ||
    !Number.isFinite(observedAt.getTime()) ||
    !input.attempt.finishedAt ||
    observedAt.toISOString() !== input.attempt.finishedAt.toISOString() ||
    !input.permit.usedAt ||
    input.permit.usedAt.toISOString() !==
      input.attempt.finishedAt.toISOString() ||
    receipt.requestedMutationCount !== 0 ||
    receipt.sentMutationCount !== 0 ||
    receipt.publishAttempted !== false ||
    receipt.realPublishEnabled !== false ||
    receipt.bodyPersisted !== false ||
    receipt.containsForumText !== false
  ) {
    throw new Error("AUTOPILOT_CANARY_RECEIPT_BINDING_INVALID");
  }
  return canonicalProtocolHash(
    EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
    receipt as CanonicalJsonValue
  );
}

async function terminalSummary(input: {
  prisma: PrismaClient;
  courseAlias: string;
  invocationId: string;
  decisionId: string;
  executionPolicyVersion: string;
  permit: ExecutionPermit;
  attempt: ExecutionAttempt;
  recoveredFrom: AutopilotCanaryRecoveryState;
}): Promise<AutopilotCanaryExecutionSummary> {
  const terminalReceiptHash =
    verifyAutopilotCanaryTerminalReceipt({
      permit: input.permit,
      attempt: input.attempt
    });
  await loadAndAssertHistoricalCanarySource(input);
  return {
    schemaVersion:
      AUTOPILOT_CANARY_EXECUTION_SUMMARY_SCHEMA_VERSION,
    courseAlias: input.courseAlias,
    invocationId: input.invocationId,
    decisionId: input.decisionId,
    executionPolicyVersion: input.executionPolicyVersion,
    attemptId: input.attempt.id,
    terminalReceiptHash,
    state: "completed_no_write",
    recoveredFrom: input.recoveredFrom,
    idempotent: input.recoveredFrom !== "none",
    requestedMutationCount: 0,
    sentMutationCount: 0,
    publishAttempted: false,
    realPublishEnabled: false,
    bodyPersisted: false,
    containsForumText: false
  };
}

/**
 * Explicit, default-off canary for the persistent ExecutionPermit state
 * machine. It is reachable only through an explicitly installed worker
 * dispatcher and never imports a connector, browser, production committer,
 * editor driver, or network client.
 */
export async function runAutopilotCanaryExecution(input: {
  prisma: PrismaClient;
  courseAlias: string;
  invocationId: string;
  decisionId: string;
  executionPolicyVersion: string;
  now: Date;
}): Promise<AutopilotCanaryExecutionSummary> {
  assertExactInput(input);
  let state = await loadSafeExecutionState(input);
  let recoveredFrom: AutopilotCanaryRecoveryState =
    state.kind === "empty" ? "none" : state.kind;

  // A terminal no-write receipt is immutable evidence, and a claimed
  // no-write attempt is safe to close even if the control plane was paused or
  // relocked after the claim. Neither branch can create or send a mutation.
  if (state.kind === "terminal") {
    return terminalSummary({
      ...input,
      permit: state.permit,
      attempt: state.attempt,
      recoveredFrom
    });
  }
  if (state.kind === "attempt_claimed") {
    await loadAndAssertHistoricalCanarySource(input);
    await settleExecutionAttemptNoWrite({
      prisma: input.prisma,
      attemptId: state.attempt.id,
      now: input.now
    });
    state = await loadSafeExecutionState(input);
    if (state.kind !== "terminal") {
      throw new Error("AUTOPILOT_CANARY_STATE_MACHINE_STALLED");
    }
    return terminalSummary({
      ...input,
      permit: state.permit,
      attempt: state.attempt,
      recoveredFrom
    });
  }

  await loadAndAssertCanarySource(input);

  if (state.kind === "empty") {
    const issued = await issueExecutionPermit({
      prisma: input.prisma,
      decisionId: input.decisionId,
      executionPolicyVersion: input.executionPolicyVersion,
      requireRealExecution: false,
      now: input.now
    });
    if (
      issued.permit.realPublishEnabled ||
      issued.binding.executionAccountLeaseId !== undefined ||
      issued.binding.executionProofKind === "connector_reread" ||
      issued.binding.actionPlanHash !== undefined
    ) {
      throw new Error("AUTOPILOT_CANARY_ISSUED_UNSAFE_PERMIT");
    }
    if (issued.idempotent) {
      recoveredFrom = "permit_active";
    }
    state = await loadSafeExecutionState(input);
  }

  for (let transition = 0; transition < 4; transition += 1) {
    if (state.kind === "terminal") {
      return terminalSummary({
        ...input,
        permit: state.permit,
        attempt: state.attempt,
        recoveredFrom
      });
    }
    if (state.kind === "permit_active") {
      await loadAndAssertCanarySource(input);
      const validated = await validateExecutionPermit({
        prisma: input.prisma,
        permitKey: state.permit.permitKey,
        requireRealExecution: false,
        now: input.now
      });
      if (!validated.valid) {
        throw new Error(
          `AUTOPILOT_CANARY_PERMIT_INVALID:${validated.code}`
        );
      }
      if (
        validated.permit.realPublishEnabled ||
        validated.permit.executionAccountLeaseId !== null ||
        validated.permit.actionPlanHash !== null
      ) {
        throw new Error("AUTOPILOT_CANARY_VALIDATED_UNSAFE_PERMIT");
      }
      await claimExecutionPermit({
        prisma: input.prisma,
        permitKey: state.permit.permitKey,
        transport: "simulated_no_write",
        now: input.now
      });
      state = await loadSafeExecutionState(input);
      continue;
    }
    if (state.kind === "attempt_claimed") {
      await settleExecutionAttemptNoWrite({
        prisma: input.prisma,
        attemptId: state.attempt.id,
        now: input.now
      });
      state = await loadSafeExecutionState(input);
      continue;
    }
    throw new Error("AUTOPILOT_CANARY_STATE_MACHINE_STALLED");
  }
  throw new Error("AUTOPILOT_CANARY_TRANSITION_LIMIT_EXCEEDED");
}
