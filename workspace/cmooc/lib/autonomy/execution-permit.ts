import {
  Prisma,
  type AutonomyDecision,
  type AutonomyCourseManifest,
  type AutonomyPolicy,
  type BudgetReservation,
  type ExecutionAttempt,
  type ExecutionPermit,
  type ExecutionAccountLease,
  type PrismaClient,
  type ScheduledInvocation
} from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  validateAutonomyPolicy,
  verifyAutonomyPolicyRecord,
  type VerifiedAutonomyPolicy
} from "./autonomy-policy";
import {
  computeBudgetReservationKey,
  consumeBudgetReservation,
  ensureBudgetReservation,
  loadActiveBudgetReservation,
  parseDecisionBudgetEvidence,
  releaseBudgetReservation
} from "./budget-reservation";
import {
  consumeVerifiedExecutionStage,
  loadVerifiedExecutionStage
} from "./execution-stage-receipt";
import {
  assertExecutionAccountLeaseBinding,
  consumeExecutionAccountLeaseInTransaction,
  releaseExecutionAccountLeaseInTransaction,
  type ExecutionAccountLeaseBinding
} from "./execution-account-pool";
import {
  connectorBindingHash,
  loadHistoricalAuthorizedActionPlanForPermit,
  loadAuthorizedActionPlanForPermit,
  markAuthorizedActionPlanPermitIssued,
  type ExecutionProofKind
} from "./authorized-action-plan";
import {
  loadCurrentCourseOperationGovernanceBinding
} from "./course-operation-governance";

export const EXECUTION_PERMIT_BINDING_SCHEMA_VERSION =
  "cmooc.execution-permit-binding.v1" as const;
export const EXECUTION_PERMIT_BINDING_SCHEMA_VERSION_V2 =
  "cmooc.execution-permit-binding.v2" as const;
export const EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION =
  "cmooc.execution-attempt-receipt.v1" as const;
export const PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION =
  "cmooc.production-execution-attempt-receipt.v1" as const;
export const PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION =
  "cmooc.pre-execution-target-observation.v1" as const;

type PrismaLike = PrismaClient | Prisma.TransactionClient;

export type ExecutionPermitBinding = {
  schemaVersion:
    | typeof EXECUTION_PERMIT_BINDING_SCHEMA_VERSION
    | typeof EXECUTION_PERMIT_BINDING_SCHEMA_VERSION_V2;
  decisionId: string;
  decisionKey: string;
  invocationId: string;
  courseAlias: string;
  policyVersion: string;
  policyHash: string;
  observationReceiptHash: string;
  targetHash: string;
  targetVersionHash: string;
  eventSetHash: string | null;
  contentHash: string;
  authorKey: string;
  workloadCost: number;
  reservationKey: string;
  idempotencyKey: string;
  executionAccountLeaseId?: string;
  accountRefHash?: string;
  credentialRefHash?: string;
  executionProofKind?: ExecutionProofKind;
  actionPlanHash?: string;
  containsForumText: false;
};

export type ValidatedExecutionPermit = {
  valid: boolean;
  code:
    | "valid"
    | "not_active"
    | "revoked"
    | "used"
    | "expired"
    | "binding_mismatch"
    | "policy_invalid"
    | "manifest_invalid"
    | "reservation_invalid"
    | "pre_execution_observation_required"
    | "pre_execution_observation_invalid"
    | "target_stale"
    | "real_publish_disabled"
    | "account_lease_required"
    | "account_binding_invalid"
    | "account_lease_invalid";
  reason: string;
  permit: ExecutionPermit;
  binding: ExecutionPermitBinding;
  policy: AutonomyPolicy;
  decision: AutonomyDecision;
};

export type PreExecutionTargetObservation = {
  schemaVersion:
    typeof PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION;
  courseAlias: string;
  threadKey: string;
  targetVersionHash: string;
  eventSetHash?: string;
  observedAt: string;
  containsForumText: false;
};

export type BoundPreExecutionTargetObservation = {
  receipt: PreExecutionTargetObservation;
  receiptHash: string;
};

export type ExecutionClaim = {
  attempt: ExecutionAttempt;
  permit: ExecutionPermit;
  idempotent: boolean;
};

const HASH_PATTERN = /^[a-f0-9]{64}$/;

function sha256(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !HASH_PATTERN.test(value.toLowerCase())
  ) {
    throw new Error(`${label}必须是 SHA-256 十六进制摘要。`);
  }
  return value.toLowerCase();
}

function isPermitTransactionConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  return (
    code === "P2028" ||
    code === "P2034" ||
    /database is locked|database table is locked|deadlock|write conflict/i.test(
      error.message
    )
  );
}

export function hashPreExecutionTargetObservation(
  receipt: PreExecutionTargetObservation
): string {
  return canonicalProtocolHash(
    receipt.schemaVersion,
    receipt as unknown as CanonicalJsonValue
  );
}

function verifyPreExecutionTargetObservation(input: {
  observation: BoundPreExecutionTargetObservation | undefined;
  decision: AutonomyDecision;
  expectedTargetVersionHash: string;
  expectedEventSetHash: string | null;
  now: Date;
}):
  | { valid: true }
  | {
      valid: false;
      code:
        | "pre_execution_observation_required"
        | "pre_execution_observation_invalid"
        | "target_stale";
      reason: string;
    } {
  if (!input.observation) {
    return {
      valid: false,
      code: "pre_execution_observation_required",
      reason: "真实执行前必须提供新鲜、去正文的目标重读回执。"
    };
  }
  const { receipt, receiptHash } = input.observation;
  let observedAt: number;
  try {
    observedAt = Date.parse(receipt.observedAt);
    if (
      receipt.schemaVersion !==
        PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION ||
      receipt.containsForumText !== false ||
      receipt.courseAlias !== input.decision.courseAlias ||
      receipt.threadKey !== input.decision.threadKey ||
      !Number.isFinite(observedAt) ||
      !HASH_PATTERN.test(receiptHash.toLowerCase()) ||
      hashPreExecutionTargetObservation(receipt) !==
        receiptHash.toLowerCase()
    ) {
      throw new Error("invalid");
    }
  } catch {
    return {
      valid: false,
      code: "pre_execution_observation_invalid",
      reason: "执行前目标重读回执无效或未绑定当前课程与目标。"
    };
  }
  if (
    observedAt > input.now.getTime() + 5_000 ||
    input.now.getTime() - observedAt > 2 * 60_000
  ) {
    return {
      valid: false,
      code: "pre_execution_observation_invalid",
      reason: "执行前目标重读回执已过期或时间异常。"
    };
  }
  let targetVersionHash: string;
  try {
    targetVersionHash = sha256(
      receipt.targetVersionHash,
      "执行前目标版本"
    );
  } catch {
    return {
      valid: false,
      code: "pre_execution_observation_invalid",
      reason: "执行前目标版本摘要无效。"
    };
  }
  if (targetVersionHash !== input.expectedTargetVersionHash) {
    return {
      valid: false,
      code: "target_stale",
      reason: "执行前重读发现目标版本已经变化。"
    };
  }
  if (input.expectedEventSetHash !== null) {
    let eventSetHash: string;
    try {
      eventSetHash = sha256(
        receipt.eventSetHash,
        "执行前事件集合"
      );
    } catch {
      return {
        valid: false,
        code: "pre_execution_observation_invalid",
        reason: "执行前重读缺少完整事件集合摘要。"
      };
    }
    if (eventSetHash !== input.expectedEventSetHash) {
      return {
        valid: false,
        code: "target_stale",
        reason: "执行前重读发现互动事件集合已经变化。"
      };
    }
  }
  return { valid: true };
}

function parseSafeObservation(input: {
  receiptJson: string;
  expectedReceiptHash: string;
  expectedThreadKey: string;
}): {
  targetVersionHash: string;
  eventSetHash: string | null;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(input.receiptJson) as unknown;
  } catch {
    throw new Error("EXECUTION_OBSERVATION_RECEIPT_INVALID_JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("EXECUTION_OBSERVATION_RECEIPT_INVALID");
  }
  const receipt = raw as Record<string, unknown>;
  if (
    typeof receipt.schemaVersion !== "string" ||
    receipt.containsForumText !== false ||
    receipt.threadKey !== input.expectedThreadKey
  ) {
    throw new Error("EXECUTION_OBSERVATION_RECEIPT_UNSAFE");
  }
  const receiptHash = canonicalProtocolHash(
    receipt.schemaVersion,
    receipt as CanonicalJsonValue
  );
  if (receiptHash !== input.expectedReceiptHash) {
    throw new Error("EXECUTION_OBSERVATION_RECEIPT_HASH_MISMATCH");
  }
  return {
    targetVersionHash: sha256(
      receipt.targetVersionHash,
      "目标版本"
    ),
    eventSetHash:
      receipt.eventSetHash === undefined
        ? null
        : sha256(receipt.eventSetHash, "事件集合")
  };
}

function buildBinding(input: {
  decision: AutonomyDecision;
  verifiedPolicy: VerifiedAutonomyPolicy;
  targetVersionHash: string;
  eventSetHash: string | null;
  allowPublishAttempted?: boolean;
  executionAccountLease?: {
    id: string;
    accountRefHash: string;
    credentialRefHash: string;
  };
  executionProofKind?: ExecutionProofKind;
  actionPlanHash?: string;
}): ExecutionPermitBinding {
  if (
    input.decision.decision !== "draft" ||
    input.decision.decisionMode !== "DRAFT_ELIGIBLE" ||
    !input.decision.draftContentHash ||
    input.decision.bodyPersisted ||
    (input.decision.publishAttempted &&
      input.allowPublishAttempted !== true)
  ) {
    throw new Error("EXECUTION_DECISION_NOT_ELIGIBLE");
  }
  if (!input.decision.authorKey) {
    throw new Error("EXECUTION_DECISION_AUTHOR_UNRESOLVED");
  }
  const policyHash = sha256(
    input.verifiedPolicy.policyHash,
    "策略哈希"
  );
  const targetVersionHash = sha256(
    input.targetVersionHash,
    "目标版本"
  );
  const contentHash = sha256(
    input.decision.draftContentHash,
    "草稿内容"
  );
  const executionProofKind =
    input.executionProofKind ?? "trusted_stage";
  if (
    (executionProofKind === "connector_reread" &&
      !input.actionPlanHash) ||
    (executionProofKind === "trusted_stage" &&
      input.actionPlanHash !== undefined)
  ) {
    throw new Error("EXECUTION_PROOF_ACTION_PLAN_BINDING_INVALID");
  }
  const actionPlanHash = input.actionPlanHash
    ? sha256(input.actionPlanHash, "Action plan")
    : undefined;
  const workloadCost =
    parseDecisionBudgetEvidence(input.decision).workloadCost;
  const reservationKey = computeBudgetReservationKey({
    decisionId: input.decision.id,
    invocationId: input.decision.invocationId,
    courseAlias: input.decision.courseAlias,
    policyHash,
    workloadCost
  });
  const targetHash = canonicalProtocolHash(
    "cmooc.execution-logical-target.v1",
    {
      courseAlias: input.decision.courseAlias,
      threadKey: input.decision.threadKey,
      observationReceiptHash:
        input.decision.observationReceiptHash,
      targetVersionHash,
      eventSetHash: input.eventSetHash
    }
  );
  const idempotencyKey = canonicalProtocolHash(
    "cmooc.execution-idempotency.v1",
    {
      decisionKey: input.decision.decisionKey,
      policyHash,
      targetHash,
      targetVersionHash,
      contentHash,
      reservationKey,
      ...(actionPlanHash
        ? {
            executionProofKind,
            actionPlanHash
          }
        : {}),
      ...(input.executionAccountLease
        ? {
            executionAccountLeaseId: sha256(
              input.executionAccountLease.id,
              "账号租约"
            ),
            accountRefHash: sha256(
              input.executionAccountLease.accountRefHash,
              "账号引用"
            ),
            credentialRefHash: sha256(
              input.executionAccountLease.credentialRefHash,
              "凭据引用"
            )
          }
        : {})
    }
  );
  const binding = {
    schemaVersion:
      actionPlanHash
        ? EXECUTION_PERMIT_BINDING_SCHEMA_VERSION_V2
        : EXECUTION_PERMIT_BINDING_SCHEMA_VERSION,
    decisionId: input.decision.id,
    decisionKey: input.decision.decisionKey,
    invocationId: input.decision.invocationId,
    courseAlias: input.decision.courseAlias,
    policyVersion: input.verifiedPolicy.policy.version,
    policyHash,
    observationReceiptHash:
      input.decision.observationReceiptHash,
    targetHash,
    targetVersionHash,
    eventSetHash: input.eventSetHash,
    contentHash,
    authorKey: input.decision.authorKey,
    workloadCost,
    reservationKey,
    idempotencyKey,
    ...(actionPlanHash
      ? {
          executionProofKind,
          actionPlanHash
        }
      : {}),
    containsForumText: false
  } as ExecutionPermitBinding;
  if (input.executionAccountLease) {
    binding.executionAccountLeaseId = sha256(
      input.executionAccountLease.id,
      "账号租约"
    );
    binding.accountRefHash = sha256(
      input.executionAccountLease.accountRefHash,
      "账号引用"
    );
    binding.credentialRefHash = sha256(
      input.executionAccountLease.credentialRefHash,
      "凭据引用"
    );
  }
  return binding;
}

async function loadExecutionContext(input: {
  prisma: PrismaLike;
  decisionId: string;
  now: Date;
  allowPublishAttempted?: boolean;
  executionPolicyVersion?: string;
  executionProofKind?: ExecutionProofKind;
  actionPlanHash?: string;
  executionAccountLease?: {
    id: string;
    accountRefHash: string;
    credentialRefHash: string;
  };
  /**
   * A claimed zero-write attempt may be closed after a later pause, revoke,
   * emergency halt, manifest disable, or policy expiry. This flag never
   * authorizes a claim or a mutation; it only rebuilds the immutable binding
   * at the attempt's original start time so the local no-write state cannot be
   * stranded by a subsequent control-plane change.
   */
  allowHistoricalNoWriteSettlement?: boolean;
}): Promise<{
  decision: AutonomyDecision;
  invocation: ScheduledInvocation;
  manifest: AutonomyCourseManifest;
  policy: AutonomyPolicy;
  verifiedPolicy: VerifiedAutonomyPolicy;
  binding: ExecutionPermitBinding;
  actionPlan: Awaited<
    ReturnType<typeof loadAuthorizedActionPlanForPermit>
  > | null;
}> {
  const decision =
    await input.prisma.autonomyDecision.findUnique({
      where: { id: input.decisionId }
    });
  if (!decision) {
    throw new Error("EXECUTION_DECISION_NOT_FOUND");
  }
  const invocation =
    await input.prisma.scheduledInvocation.findUnique({
      where: { id: decision.invocationId }
    });
  if (
    !invocation ||
    invocation.courseAlias !== decision.courseAlias ||
    (invocation.mode !== "AUTO" && invocation.mode !== "SHADOW")
  ) {
    throw new Error("EXECUTION_AUTO_PROMOTION_SOURCE_REQUIRED");
  }
  const manifest =
    await input.prisma.autonomyCourseManifest.findUnique({
      where: { alias: decision.courseAlias }
    });
  if (
    !manifest ||
    (!manifest.enabled &&
      input.allowHistoricalNoWriteSettlement !== true) ||
    manifest.manifestHash !== invocation.manifestHash ||
    manifest.policyVersion !== decision.policyVersion
  ) {
    throw new Error("EXECUTION_COURSE_MANIFEST_STALE");
  }
  const policy = await input.prisma.autonomyPolicy.findUnique({
    where: {
      courseAlias_version: {
        courseAlias: decision.courseAlias,
        version:
          input.executionPolicyVersion ?? decision.policyVersion
      }
    }
  });
  if (!policy) {
    throw new Error("EXECUTION_POLICY_NOT_FOUND");
  }
  const verifiedPolicy = verifyAutonomyPolicyRecord(policy);
  if (input.allowHistoricalNoWriteSettlement === true) {
    const historicalPolicy = verifiedPolicy.policy;
    if (
      historicalPolicy.courseAlias !== decision.courseAlias ||
      historicalPolicy.version !== policy.version ||
      historicalPolicy.mode !== "AUTO" ||
      !historicalPolicy.allowedActions.includes("forum_reply") ||
      input.now.getTime() < policy.validFrom.getTime() ||
      input.now.getTime() >= policy.validUntil.getTime()
    ) {
      throw new Error(
        "EXECUTION_POLICY_INVALID:historical_binding_invalid"
      );
    }
  } else {
    const policyValidation = validateAutonomyPolicy({
      verified: verifiedPolicy,
      courseAlias: decision.courseAlias,
      policyVersion: policy.version,
      action: "forum_reply",
      mode: "AUTO",
      now: input.now,
      requireRealPublish: false
    });
    if (!policyValidation.valid) {
      throw new Error(
        `EXECUTION_POLICY_INVALID:${policyValidation.code}`
      );
    }
  }
  const executionProofKind =
    input.executionProofKind ?? "trusted_stage";
  if (
    executionProofKind !== "trusted_stage" &&
    executionProofKind !== "connector_reread"
  ) {
    throw new Error("EXECUTION_PROOF_KIND_INVALID");
  }
  if (
    (executionProofKind === "connector_reread" &&
      !input.actionPlanHash) ||
    (executionProofKind === "trusted_stage" &&
      input.actionPlanHash !== undefined)
  ) {
    throw new Error("EXECUTION_PROOF_ACTION_PLAN_BINDING_INVALID");
  }
  const observation =
    await input.prisma.autonomyObservation.findUnique({
      where: { receiptHash: decision.observationReceiptHash }
    });
  if (
    !observation ||
    observation.invocationId !== decision.invocationId ||
    observation.threadKey !== decision.threadKey ||
    observation.containsForumText
  ) {
    throw new Error("EXECUTION_OBSERVATION_NOT_BOUND");
  }
  const safeObservation = parseSafeObservation({
    receiptJson: observation.receiptJson,
    expectedReceiptHash: decision.observationReceiptHash,
    expectedThreadKey: decision.threadKey
  });
  const actionPlan = input.actionPlanHash
    ? await loadAuthorizedActionPlanForPermit({
        prisma: input.prisma,
        decisionId: decision.id,
        planHash: input.actionPlanHash,
        policyVersion: policy.version,
        policyHash: verifiedPolicy.policyHash,
        manifestHash: manifest.manifestHash,
        connectorBindingHash: connectorBindingHash(manifest),
        governanceHash: decision.governanceHash,
        proofKind: executionProofKind,
        now: input.now,
        allowPermitIssued: true
      })
    : null;
  return {
    decision,
    invocation,
    manifest,
    policy,
    verifiedPolicy,
    actionPlan,
    binding: buildBinding({
      decision,
      verifiedPolicy,
      targetVersionHash: safeObservation.targetVersionHash,
      eventSetHash: safeObservation.eventSetHash,
      allowPublishAttempted: input.allowPublishAttempted,
      executionProofKind,
      actionPlanHash: input.actionPlanHash,
      executionAccountLease: input.executionAccountLease
    })
  };
}

function computePermitKey(input: {
  binding: ExecutionPermitBinding;
  expiresAt: Date;
  realPublishEnabled: boolean;
}): string {
  return canonicalProtocolHash(
    "cmooc.execution-permit.v1",
    {
      binding: input.binding as unknown as CanonicalJsonValue,
      expiresAt: input.expiresAt.toISOString(),
      realPublishEnabled: input.realPublishEnabled,
      containsForumText: false
    }
  );
}

function hasAnyExecutionAccountBinding(
  value: Pick<
    ExecutionPermit,
    "executionAccountLeaseId" | "executionAccountRefHash" | "credentialRefHash"
  >
): boolean {
  return (
    value.executionAccountLeaseId !== null ||
    value.executionAccountRefHash !== null ||
    value.credentialRefHash !== null
  );
}

function hasCompleteExecutionAccountBinding(
  value: Pick<
    ExecutionPermit,
    "executionAccountLeaseId" | "executionAccountRefHash" | "credentialRefHash"
  >
): value is Pick<
  ExecutionPermit,
  "executionAccountLeaseId" | "executionAccountRefHash" | "credentialRefHash"
> & {
  executionAccountLeaseId: string;
  executionAccountRefHash: string;
  credentialRefHash: string;
} {
  return (
    typeof value.executionAccountLeaseId === "string" &&
    typeof value.executionAccountRefHash === "string" &&
    typeof value.credentialRefHash === "string"
  );
}

async function loadPermitExecutionAccountLease(input: {
  prisma: PrismaLike;
  permit: ExecutionPermit;
  decision: AutonomyDecision;
  invocation: ScheduledInvocation;
  now: Date;
  status?: "active" | "consumed" | "released" | "expired";
}): Promise<ExecutionAccountLease | null> {
  const anyBinding = hasAnyExecutionAccountBinding(input.permit);
  if (!anyBinding) return null;
  if (!hasCompleteExecutionAccountBinding(input.permit)) {
    throw new Error("EXECUTION_ACCOUNT_PERMIT_BINDING_INVALID");
  }
  if (
    input.prisma === undefined ||
    !("executionAccountLease" in input.prisma)
  ) {
    throw new Error("EXECUTION_ACCOUNT_LEASE_TRANSACTION_REQUIRED");
  }
  return assertExecutionAccountLeaseBinding({
    prisma: input.prisma as Prisma.TransactionClient,
    executionAccountLeaseId: input.permit.executionAccountLeaseId,
    accountRefHash: input.permit.executionAccountRefHash,
    credentialRefHash: input.permit.credentialRefHash,
    decisionId: input.decision.id,
    invocationId: input.invocation.id,
    courseAlias: input.decision.courseAlias,
    now: input.now,
    status: input.status
  });
}

function permitBindingLeaseFromLease(
  lease: ExecutionAccountLease
): NonNullable<Parameters<typeof buildBinding>[0]["executionAccountLease"]> {
  return {
    id: lease.id,
    accountRefHash: lease.accountRefHash,
    credentialRefHash: lease.credentialRefHash
  };
}

function executionAccountLeaseBindingFromPermit(input: {
  permit: ExecutionPermit;
  decision: AutonomyDecision;
  invocation: ScheduledInvocation;
  now: Date;
}): ExecutionAccountLeaseBinding | null {
  if (!hasAnyExecutionAccountBinding(input.permit)) return null;
  if (!hasCompleteExecutionAccountBinding(input.permit)) {
    throw new Error("EXECUTION_ACCOUNT_PERMIT_BINDING_INVALID");
  }
  return {
    executionAccountLeaseId: input.permit.executionAccountLeaseId,
    accountRefHash: input.permit.executionAccountRefHash,
    credentialRefHash: input.permit.credentialRefHash,
    decisionId: input.decision.id,
    invocationId: input.invocation.id,
    courseAlias: input.decision.courseAlias,
    now: input.now
  };
}

function assertPersistedPermitBinding(
  permit: ExecutionPermit,
  binding: ExecutionPermitBinding
): void {
  if (
    permit.decisionId !== binding.decisionId ||
    permit.courseAlias !== binding.courseAlias ||
    permit.policyVersion !== binding.policyVersion ||
    permit.targetHash !== binding.targetHash ||
    permit.targetVersionHash !== binding.targetVersionHash ||
    permit.contentHash !== binding.contentHash ||
    permit.idempotencyKey !== binding.idempotencyKey ||
    permit.executionAccountLeaseId !==
      (binding.executionAccountLeaseId ?? null) ||
    permit.executionAccountRefHash !==
      (binding.accountRefHash ?? null) ||
    permit.credentialRefHash !==
      (binding.credentialRefHash ?? null) ||
    permit.executionProofKind !==
      (binding.executionProofKind ?? "trusted_stage") ||
    permit.actionPlanHash !==
      (binding.actionPlanHash ?? null) ||
    permit.permitKey !==
      computePermitKey({
        binding,
        expiresAt: permit.expiresAt,
        realPublishEnabled: permit.realPublishEnabled
      })
  ) {
    throw new Error("EXECUTION_PERMIT_BINDING_MISMATCH");
  }
}

export async function issueExecutionPermit(input: {
  prisma: PrismaClient;
  decisionId: string;
  now: Date;
  expiresInSeconds?: number;
  requireRealExecution?: boolean;
  executionPolicyVersion?: string;
  executionProofKind?: ExecutionProofKind;
  actionPlanHash?: string;
  preExecutionObservation?: BoundPreExecutionTargetObservation;
  executionAccountLeaseId?: string;
}): Promise<{
  permit: ExecutionPermit;
  binding: ExecutionPermitBinding;
  reservation: BudgetReservation;
  idempotent: boolean;
}> {
  const ttlSeconds = Math.max(
    10,
    Math.min(600, Math.floor(input.expiresInSeconds ?? 120))
  );
  const issueOnce = () =>
    input.prisma.$transaction(
      async (transaction) => {
        const baseContext = await loadExecutionContext({
          prisma: transaction,
          decisionId: input.decisionId,
          now: input.now,
          executionPolicyVersion: input.executionPolicyVersion,
          executionProofKind: input.executionProofKind,
          actionPlanHash: input.actionPlanHash
        });
        let executionAccountLease: ExecutionAccountLease | null = null;
        if (input.requireRealExecution && !input.executionAccountLeaseId) {
          throw new Error("EXECUTION_ACCOUNT_LEASE_REQUIRED");
        }
        if (input.executionAccountLeaseId) {
          sha256(input.executionAccountLeaseId, "账号租约");
          const candidateLease =
            await transaction.executionAccountLease.findUnique({
              where: { id: input.executionAccountLeaseId }
            });
          if (!candidateLease) {
            throw new Error("EXECUTION_ACCOUNT_LEASE_NOT_FOUND");
          }
          executionAccountLease = await assertExecutionAccountLeaseBinding({
            prisma: transaction,
            executionAccountLeaseId: input.executionAccountLeaseId,
            accountRefHash: candidateLease.accountRefHash,
            credentialRefHash: candidateLease.credentialRefHash,
            decisionId: baseContext.decision.id,
            invocationId: baseContext.invocation.id,
            courseAlias: baseContext.decision.courseAlias,
            now: input.now
          });
        }
        const context = executionAccountLease
          ? await loadExecutionContext({
              prisma: transaction,
              decisionId: input.decisionId,
              now: input.now,
              executionPolicyVersion: input.executionPolicyVersion,
              executionProofKind: input.executionProofKind,
              actionPlanHash: input.actionPlanHash,
              executionAccountLease: permitBindingLeaseFromLease(
                executionAccountLease
              )
            })
          : baseContext;
        if (context.actionPlan) {
          await loadCurrentCourseOperationGovernanceBinding({
            prisma: transaction,
            courseAlias: context.decision.courseAlias,
            manifestHash: context.manifest.manifestHash,
            expectedGovernanceHash: context.actionPlan.governanceHash,
            now: input.now
          });
        }
        const realPublishEnabled =
          context.policy.realPublishEnabled &&
          context.manifest.realPublishEnabled;
        if (
          input.requireRealExecution &&
          !realPublishEnabled
        ) {
          throw new Error("EXECUTION_REAL_PUBLISH_DISABLED");
        }
        if (input.requireRealExecution) {
          const proofKind =
            context.binding.executionProofKind ?? "trusted_stage";
          if (proofKind === "trusted_stage") {
            await loadVerifiedExecutionStage({
              prisma: transaction,
              decision: context.decision,
              targetVersionHash:
                context.binding.targetVersionHash,
              contentHash: context.binding.contentHash,
              policyVersion: context.binding.policyVersion,
              now: input.now
            });
          } else {
            const preExecution =
              verifyPreExecutionTargetObservation({
                observation: input.preExecutionObservation,
                decision: context.decision,
                expectedTargetVersionHash:
                  context.binding.targetVersionHash,
                expectedEventSetHash:
                  context.binding.eventSetHash,
                now: input.now
              });
            if (!preExecution.valid) {
              throw new Error(
                `EXECUTION_CONNECTOR_REREAD_INVALID:${preExecution.code}`
              );
            }
          }
        }
        const proposedExpiresAt = new Date(
          Math.min(
            input.now.getTime() + ttlSeconds * 1_000,
            context.policy.validUntil.getTime(),
            context.actionPlan?.validUntil.getTime() ?? Number.POSITIVE_INFINITY,
            executionAccountLease?.expiresAt.getTime() ?? Number.POSITIVE_INFINITY
          )
        );
        if (
          proposedExpiresAt.getTime() <= input.now.getTime()
        ) {
          throw new Error("EXECUTION_POLICY_EXPIRES_TOO_SOON");
        }
        const existing =
          await transaction.executionPermit.findUnique({
            where: {
              idempotencyKey:
                context.binding.idempotencyKey
            }
          });
        if (input.requireRealExecution) {
          const competing =
            await transaction.executionPermit.findFirst({
              where: {
                decisionId: context.decision.id,
                realPublishEnabled: true,
                status: { in: ["active", "claimed"] },
                usedAt: null,
                revokedAt: null,
                ...(existing ? { id: { not: existing.id } } : {})
              }
            });
          if (competing) {
            if (
              !hasCompleteExecutionAccountBinding(competing) ||
              competing.executionAccountLeaseId !==
                context.binding.executionAccountLeaseId ||
              competing.executionAccountRefHash !==
                context.binding.accountRefHash ||
              competing.credentialRefHash !==
                context.binding.credentialRefHash
            ) {
              throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
            }
            throw new Error("EXECUTION_PERMIT_ALREADY_ISSUED");
          }
        }
        if (existing) {
          assertPersistedPermitBinding(
            existing,
            context.binding
          );
          if (
            (existing.status !== "active" &&
              existing.status !== "claimed") ||
            existing.revokedAt ||
            existing.usedAt ||
            existing.expiresAt.getTime() <=
              input.now.getTime()
          ) {
            throw new Error("EXECUTION_PERMIT_NOT_ACTIVE");
          }
          const reservation =
            await loadActiveBudgetReservation({
              prisma: transaction,
              decision: context.decision,
              verifiedPolicy: context.verifiedPolicy,
              now: input.now
            });
          if (
            reservation.expiresAt.getTime() !==
            existing.expiresAt.getTime()
          ) {
            throw new Error(
              "EXECUTION_PERMIT_RESERVATION_EXPIRY_MISMATCH"
            );
          }
          return {
            permit: existing,
            binding: context.binding,
            reservation,
            idempotent: true
          };
        }
        if (
          context.actionPlan &&
          context.actionPlan.status !== "active"
        ) {
          throw new Error("AUTHORIZED_ACTION_PLAN_ALREADY_USED");
        }
        const reserved = await ensureBudgetReservation({
          prisma: transaction,
          decision: context.decision,
          invocation: context.invocation,
          verifiedPolicy: context.verifiedPolicy,
          expiresAt: proposedExpiresAt,
          now: input.now
        });
        const expiresAt = reserved.reservation.expiresAt;
        const permitKey = computePermitKey({
          binding: context.binding,
          expiresAt,
          realPublishEnabled
        });
        const permit = await transaction.executionPermit.create({
          data: {
            decisionId: context.decision.id,
            courseAlias: context.decision.courseAlias,
            permitKey,
            policyVersion: context.policy.version,
            targetHash: context.binding.targetHash,
            targetVersionHash:
              context.binding.targetVersionHash,
            contentHash: context.binding.contentHash,
            idempotencyKey:
              context.binding.idempotencyKey,
            status: "active",
            expiresAt,
            usedAt: null,
            revokedAt: null,
            realPublishEnabled,
            executionProofKind:
              context.binding.executionProofKind ?? "trusted_stage",
            actionPlanHash:
              context.binding.actionPlanHash ?? null,
            executionAccountLeaseId:
              context.binding.executionAccountLeaseId ?? null,
            executionAccountRefHash:
              context.binding.accountRefHash ?? null,
            credentialRefHash:
              context.binding.credentialRefHash ?? null
          }
        });
        if (context.binding.actionPlanHash) {
          await markAuthorizedActionPlanPermitIssued({
            prisma: transaction,
            planHash: context.binding.actionPlanHash,
            decisionId: context.decision.id,
            now: input.now
          });
        }
        return {
          permit,
          binding: context.binding,
          reservation: reserved.reservation,
          idempotent: reserved.idempotent
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 10_000
      }
    );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await issueOnce();
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? (error as Error & { code?: string }).code
          : undefined;
      if (
        attempt < 2 &&
        (code === "P2002" ||
          code === "P2034" ||
          code === "P2028")
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, 25 * (attempt + 1))
        );
        continue;
      }
      throw error;
    }
  }
  throw new Error("EXECUTION_PERMIT_ISSUE_RETRY_EXHAUSTED");
}

export async function validateExecutionPermit(input: {
  prisma: PrismaLike;
  permitKey: string;
  now: Date;
  requireRealExecution?: boolean;
  preExecutionObservation?: BoundPreExecutionTargetObservation;
}): Promise<ValidatedExecutionPermit> {
  const permit =
    await input.prisma.executionPermit.findUnique({
      where: { permitKey: input.permitKey }
    });
  if (!permit) {
    throw new Error("EXECUTION_PERMIT_NOT_FOUND");
  }
  const baseContext = await loadExecutionContext({
    prisma: input.prisma,
    decisionId: permit.decisionId,
    now: input.now,
    executionPolicyVersion: permit.policyVersion,
    executionProofKind:
      permit.executionProofKind as ExecutionProofKind,
    actionPlanHash: permit.actionPlanHash ?? undefined
  });
  const base = {
    permit,
    binding: baseContext.binding,
    policy: baseContext.policy,
    decision: baseContext.decision
  };
  const hasAccountBinding = hasAnyExecutionAccountBinding(permit);
  if (input.requireRealExecution && !hasAccountBinding) {
    return {
      ...base,
      valid: false,
      code: "account_lease_required",
      reason: "真实执行许可缺少账号租约绑定。"
    };
  }
  let accountLease: ExecutionAccountLease | null = null;
  if (hasAccountBinding) {
    try {
      accountLease = await loadPermitExecutionAccountLease({
        prisma: input.prisma,
        permit,
        decision: baseContext.decision,
        invocation: baseContext.invocation,
        now: input.now,
        status: input.requireRealExecution ? "active" : undefined
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      return {
        ...base,
        valid: false,
        code:
          code === "EXECUTION_ACCOUNT_LEASE_EXPIRED" ||
          code === "EXECUTION_ACCOUNT_LEASE_ALREADY_CONSUMED" ||
          code === "EXECUTION_ACCOUNT_LEASE_ALREADY_RELEASED"
            ? "account_lease_invalid"
            : "account_binding_invalid",
        reason: "执行许可账号租约绑定无效。"
      };
    }
  }
  const context = accountLease
    ? await loadExecutionContext({
        prisma: input.prisma,
        decisionId: permit.decisionId,
        now: input.now,
        executionPolicyVersion: permit.policyVersion,
        executionProofKind:
          permit.executionProofKind as ExecutionProofKind,
        actionPlanHash: permit.actionPlanHash ?? undefined,
        executionAccountLease: permitBindingLeaseFromLease(accountLease)
      })
    : baseContext;
  const contextualBase = {
    permit,
    binding: context.binding,
    policy: context.policy,
    decision: context.decision
  };
  try {
    assertPersistedPermitBinding(permit, context.binding);
  } catch {
    return {
      ...contextualBase,
      valid: false,
      code: "binding_mismatch",
      reason: "许可与当前策略、目标版本或内容绑定不一致。"
    };
  }
  if (permit.revokedAt || permit.status === "revoked") {
    return {
      ...contextualBase,
      valid: false,
      code: "revoked",
      reason: "执行许可已经撤销。"
    };
  }
  if (permit.usedAt || permit.status === "used") {
    return {
      ...contextualBase,
      valid: false,
      code: "used",
      reason: "执行许可已经消费。"
    };
  }
  if (permit.expiresAt.getTime() <= input.now.getTime()) {
    return {
      ...contextualBase,
      valid: false,
      code: "expired",
      reason: "执行许可已经过期。"
    };
  }
  if (permit.status !== "active" && permit.status !== "claimed") {
    return {
      ...contextualBase,
      valid: false,
      code: "not_active",
      reason: "执行许可当前不可用。"
    };
  }
  try {
    const reservation = await loadActiveBudgetReservation({
      prisma: input.prisma,
      decision: context.decision,
      verifiedPolicy: context.verifiedPolicy,
      now: input.now
    });
    if (
      reservation.reservationKey !==
        context.binding.reservationKey ||
      reservation.expiresAt.getTime() !==
        permit.expiresAt.getTime()
    ) {
      throw new Error("reservation binding mismatch");
    }
  } catch {
    return {
      ...contextualBase,
      valid: false,
      code: "reservation_invalid",
      reason: "许可没有对应的有效预算预留。"
    };
  }
  if (input.requireRealExecution) {
    const preExecution =
      verifyPreExecutionTargetObservation({
        observation: input.preExecutionObservation,
        decision: context.decision,
        expectedTargetVersionHash:
          context.binding.targetVersionHash,
        expectedEventSetHash: context.binding.eventSetHash,
        now: input.now
      });
    if (!preExecution.valid) {
      return {
        ...contextualBase,
        valid: false,
        code: preExecution.code,
        reason: preExecution.reason
      };
    }
  }
  const verifiedPolicy = verifyAutonomyPolicyRecord(
    context.policy
  );
  const policyValidation = validateAutonomyPolicy({
    verified: verifiedPolicy,
    courseAlias: context.decision.courseAlias,
    policyVersion: context.binding.policyVersion,
    action: "forum_reply",
    mode: "AUTO",
    now: input.now,
    requireRealPublish: input.requireRealExecution
  });
  if (!policyValidation.valid) {
    return {
      ...contextualBase,
      valid: false,
      code: "policy_invalid",
      reason: policyValidation.reason
    };
  }
  if (
    input.requireRealExecution &&
    (!permit.realPublishEnabled ||
      !context.manifest.realPublishEnabled)
  ) {
    return {
      ...contextualBase,
      valid: false,
      code: "real_publish_disabled",
      reason: "许可没有启用真实发布。"
    };
  }
  if (
    input.requireRealExecution &&
    permit.status === "active" &&
    permit.executionProofKind === "trusted_stage"
  ) {
    try {
      await loadVerifiedExecutionStage({
        prisma: input.prisma,
        decision: context.decision,
        targetVersionHash: context.binding.targetVersionHash,
        contentHash: context.binding.contentHash,
        policyVersion: context.binding.policyVersion,
        now: input.now
      });
    } catch {
      return {
        ...contextualBase,
        valid: false,
        code: "real_publish_disabled",
        reason: "许可没有对应的已验证且已清空 STAGE 回执。"
      };
    }
  }
  return {
    ...contextualBase,
    valid: true,
    code: "valid",
    reason: "执行许可有效且绑定未发生变化。"
  };
}

function attemptReceipt(input: {
  permit: ExecutionPermit;
  binding: ExecutionPermitBinding;
  state: "claimed_no_write" | "completed_no_write";
  observedAt: Date;
}): Record<string, CanonicalJsonValue> {
  return {
    schemaVersion: EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
    permitKey: input.permit.permitKey,
    idempotencyKey: input.permit.idempotencyKey,
    targetHash: input.binding.targetHash,
    targetVersionHash: input.binding.targetVersionHash,
    contentHash: input.binding.contentHash,
    state: input.state,
    observedAt: input.observedAt.toISOString(),
    requestedMutationCount: 0,
    sentMutationCount: 0,
    publishAttempted: false,
    realPublishEnabled: false,
    bodyPersisted: false,
    containsForumText: false
  };
}

function productionAttemptReceipt(input: {
  permit: ExecutionPermit;
  binding: ExecutionPermitBinding;
  state:
    | "prepared_real"
    | "sending_real"
    | "aborted_before_send"
    | "confirmed_published"
    | "confirmed_not_published"
    | "outcome_unknown";
  observedAt: Date;
  sentMutationCount: 0 | 1;
  publishAttempted: boolean;
  remoteEvidenceHash: string | null;
}): Record<string, CanonicalJsonValue> {
  return {
    schemaVersion:
      PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
    permitKey: input.permit.permitKey,
    idempotencyKey: input.permit.idempotencyKey,
    targetHash: input.binding.targetHash,
    targetVersionHash: input.binding.targetVersionHash,
    contentHash: input.binding.contentHash,
    state: input.state,
    observedAt: input.observedAt.toISOString(),
    remoteEvidenceHash: input.remoteEvidenceHash,
    requestedMutationCount: 1,
    sentMutationCount: input.sentMutationCount,
    publishAttempted: input.publishAttempted,
    realPublishEnabled: true,
    bodyPersisted: false,
    containsForumText: false
  };
}

type ReconciledExecutionState =
  | "confirmed_published"
  | "confirmed_not_published";

const OUTCOME_UNKNOWN_RECONCILIATION_PREFIX =
  "EXECUTION_OUTCOME_UNKNOWN_RECONCILIATION_" as const;

/**
 * Stable failure codes for the local, no-send outcome reconciliation path.
 * The path deliberately does not reuse the active-policy validators: a real
 * one-shot attempt is expected to have been hard-relocked before its remote
 * result is known, so the historical permit/stage facts must be checked
 * without reopening the policy or manifest.
 */
export const OUTCOME_UNKNOWN_RECONCILIATION_CODES = {
  INPUT_INVALID: `${OUTCOME_UNKNOWN_RECONCILIATION_PREFIX}INPUT_INVALID`,
  ATTEMPT_NOT_FOUND: `${OUTCOME_UNKNOWN_RECONCILIATION_PREFIX}ATTEMPT_NOT_FOUND`,
  ATTEMPT_PERMIT_MISSING: `${OUTCOME_UNKNOWN_RECONCILIATION_PREFIX}ATTEMPT_PERMIT_MISSING`,
  ATTEMPT_INVALID: `${OUTCOME_UNKNOWN_RECONCILIATION_PREFIX}ATTEMPT_INVALID`,
  STATE_CONFLICT: `${OUTCOME_UNKNOWN_RECONCILIATION_PREFIX}STATE_CONFLICT`,
  PERMIT_INVALID: `${OUTCOME_UNKNOWN_RECONCILIATION_PREFIX}PERMIT_INVALID`,
  BINDING_INVALID: `${OUTCOME_UNKNOWN_RECONCILIATION_PREFIX}BINDING_INVALID`,
  STAGE_INVALID: `${OUTCOME_UNKNOWN_RECONCILIATION_PREFIX}STAGE_INVALID`,
  RECEIPT_INVALID: `${OUTCOME_UNKNOWN_RECONCILIATION_PREFIX}RECEIPT_INVALID`,
  TRANSACTION_CONFLICT: `${OUTCOME_UNKNOWN_RECONCILIATION_PREFIX}TRANSACTION_CONFLICT`
} as const;

type HistoricalExecutionContext = {
  decision: AutonomyDecision;
  manifest: AutonomyCourseManifest;
  policy: AutonomyPolicy;
  binding: ExecutionPermitBinding;
  executionAccountLease: ExecutionAccountLease | null;
};

const PRODUCTION_ATTEMPT_RECEIPT_KEYS = new Set([
  "schemaVersion",
  "permitKey",
  "idempotencyKey",
  "targetHash",
  "targetVersionHash",
  "contentHash",
  "state",
  "observedAt",
  "remoteEvidenceHash",
  "requestedMutationCount",
  "sentMutationCount",
  "publishAttempted",
  "realPublishEnabled",
  "bodyPersisted",
  "containsForumText"
]);

function throwOutcomeUnknownReconciliation(
  code: keyof typeof OUTCOME_UNKNOWN_RECONCILIATION_CODES
): never {
  throw new Error(OUTCOME_UNKNOWN_RECONCILIATION_CODES[code]);
}

function validCanonicalSha256(value: unknown): value is string {
  return (
    typeof value === "string" &&
    HASH_PATTERN.test(value) &&
    value === value.toLowerCase()
  );
}

function assertReconciliationInput(input: {
  state: ReconciledExecutionState;
  attemptId: string;
  remoteEvidenceHash: string;
  now: Date;
}): string {
  if (
    (input.state !== "confirmed_published" &&
      input.state !== "confirmed_not_published") ||
    typeof input.attemptId !== "string" ||
    input.attemptId.length === 0 ||
    !(input.now instanceof Date) ||
    !Number.isFinite(input.now.getTime()) ||
    typeof input.remoteEvidenceHash !== "string" ||
    !HASH_PATTERN.test(input.remoteEvidenceHash.toLowerCase())
  ) {
    throwOutcomeUnknownReconciliation("INPUT_INVALID");
  }
  return input.remoteEvidenceHash.toLowerCase();
}

/**
 * Load the immutable binding facts needed to verify a historical real
 * attempt.  Unlike loadExecutionContext, this intentionally does not require
 * an active policy or an enabled real-publish manifest; relock is expected to
 * have changed those flags by the time a result is reconciled.
 */
async function loadHistoricalExecutionContext(input: {
  prisma: PrismaLike;
  attempt: ExecutionAttempt;
  permit: ExecutionPermit;
}): Promise<HistoricalExecutionContext> {
  const decision = await input.prisma.autonomyDecision.findUnique({
    where: { id: input.attempt.decisionId }
  });
  if (!decision) {
    throwOutcomeUnknownReconciliation("BINDING_INVALID");
  }
  if (
    decision.id !== input.permit.decisionId ||
    input.attempt.decisionId !== input.permit.decisionId ||
    input.permit.courseAlias !== decision.courseAlias ||
    decision.publishAttempted !== true ||
    decision.bodyPersisted ||
    decision.decision !== "draft" ||
    decision.decisionMode !== "DRAFT_ELIGIBLE" ||
    !decision.draftContentHash
  ) {
    throwOutcomeUnknownReconciliation("BINDING_INVALID");
  }
  const invocation = await input.prisma.scheduledInvocation.findUnique({
    where: { id: decision.invocationId }
  });
  if (
    !invocation ||
    invocation.courseAlias !== decision.courseAlias ||
    (invocation.mode !== "AUTO" && invocation.mode !== "SHADOW")
  ) {
    throwOutcomeUnknownReconciliation("BINDING_INVALID");
  }
  const manifest = await input.prisma.autonomyCourseManifest.findUnique({
    where: { alias: decision.courseAlias }
  });
  if (
    !manifest ||
    manifest.manifestHash !== invocation.manifestHash ||
    manifest.policyVersion !== decision.policyVersion
  ) {
    throwOutcomeUnknownReconciliation("BINDING_INVALID");
  }
  const policy = await input.prisma.autonomyPolicy.findUnique({
    where: {
      courseAlias_version: {
        courseAlias: decision.courseAlias,
        version: input.permit.policyVersion
      }
    }
  });
  if (
    !policy ||
    policy.courseAlias !== decision.courseAlias ||
    policy.version !== input.permit.policyVersion
  ) {
    throwOutcomeUnknownReconciliation("BINDING_INVALID");
  }
  let verifiedPolicy: VerifiedAutonomyPolicy;
  try {
    verifiedPolicy = verifyAutonomyPolicyRecord(policy);
  } catch {
    throwOutcomeUnknownReconciliation("BINDING_INVALID");
  }
  const observation = await input.prisma.autonomyObservation.findUnique({
    where: { receiptHash: decision.observationReceiptHash }
  });
  if (
    !observation ||
    observation.invocationId !== decision.invocationId ||
    observation.threadKey !== decision.threadKey ||
    observation.containsForumText
  ) {
    throwOutcomeUnknownReconciliation("BINDING_INVALID");
  }
  let safeObservation: {
    targetVersionHash: string;
    eventSetHash: string | null;
  };
  try {
    safeObservation = parseSafeObservation({
      receiptJson: observation.receiptJson,
      expectedReceiptHash: decision.observationReceiptHash,
      expectedThreadKey: decision.threadKey
    });
  } catch {
    throwOutcomeUnknownReconciliation("BINDING_INVALID");
  }
  let binding: ExecutionPermitBinding;
  let executionAccountLease: ExecutionAccountLease | null = null;
  if (hasAnyExecutionAccountBinding(input.permit)) {
    if (!hasCompleteExecutionAccountBinding(input.permit)) {
      throwOutcomeUnknownReconciliation("BINDING_INVALID");
    }
    try {
      executionAccountLease = await assertExecutionAccountLeaseBinding({
        prisma: input.prisma as Prisma.TransactionClient,
        executionAccountLeaseId: input.permit.executionAccountLeaseId,
        accountRefHash: input.permit.executionAccountRefHash,
        credentialRefHash: input.permit.credentialRefHash,
        decisionId: decision.id,
        invocationId: invocation.id,
        courseAlias: decision.courseAlias,
        now: input.permit.usedAt ?? new Date(0),
        status: "consumed"
      });
    } catch {
      throwOutcomeUnknownReconciliation("BINDING_INVALID");
    }
  }
  if (input.permit.executionProofKind === "connector_reread") {
    if (!input.permit.actionPlanHash) {
      throwOutcomeUnknownReconciliation("BINDING_INVALID");
    }
    try {
      await loadHistoricalAuthorizedActionPlanForPermit({
        prisma: input.prisma,
        decisionId: decision.id,
        planHash: input.permit.actionPlanHash,
        policyVersion: input.permit.policyVersion,
        policyHash: verifiedPolicy.policyHash,
        manifestHash: manifest.manifestHash,
        governanceHash: decision.governanceHash,
        proofKind: "connector_reread",
        permitExpiresAt: input.permit.expiresAt
      });
    } catch {
      throwOutcomeUnknownReconciliation("BINDING_INVALID");
    }
  }
  try {
    binding = buildBinding({
      decision,
      verifiedPolicy,
      targetVersionHash: safeObservation.targetVersionHash,
      eventSetHash: safeObservation.eventSetHash,
      allowPublishAttempted: true,
      executionProofKind:
        input.permit.executionProofKind as ExecutionProofKind,
      actionPlanHash: input.permit.actionPlanHash ?? undefined,
      executionAccountLease: executionAccountLease
        ? permitBindingLeaseFromLease(executionAccountLease)
        : undefined
    });
  } catch {
    throwOutcomeUnknownReconciliation("BINDING_INVALID");
  }
  return { decision, manifest, policy, binding, executionAccountLease };
}

type ParsedProductionAttemptReceipt = {
  schemaVersion: typeof PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION;
  permitKey: string;
  idempotencyKey: string;
  targetHash: string;
  targetVersionHash: string;
  contentHash: string;
  state:
    | "outcome_unknown"
    | "confirmed_published"
    | "confirmed_not_published";
  observedAt: string;
  remoteEvidenceHash: string;
  requestedMutationCount: 1;
  sentMutationCount: 1;
  publishAttempted: true;
  realPublishEnabled: true;
  bodyPersisted: false;
  containsForumText: false;
};

function parseReconciliationReceipt(input: {
  attempt: ExecutionAttempt;
  permit: ExecutionPermit;
  binding: ExecutionPermitBinding;
  expectedState:
    | "outcome_unknown"
    | "confirmed_published"
    | "confirmed_not_published";
}): ParsedProductionAttemptReceipt {
  if (!validCanonicalSha256(input.attempt.remoteOutcomeHash)) {
    throwOutcomeUnknownReconciliation("RECEIPT_INVALID");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input.attempt.receiptJson) as unknown;
  } catch {
    throwOutcomeUnknownReconciliation("RECEIPT_INVALID");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throwOutcomeUnknownReconciliation("RECEIPT_INVALID");
  }
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).length !== PRODUCTION_ATTEMPT_RECEIPT_KEYS.size ||
    Object.keys(value).some(
      (key) => !PRODUCTION_ATTEMPT_RECEIPT_KEYS.has(key)
    )
  ) {
    throwOutcomeUnknownReconciliation("RECEIPT_INVALID");
  }
  if (
    value.schemaVersion !==
      PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION ||
    value.permitKey !== input.permit.permitKey ||
    value.idempotencyKey !== input.permit.idempotencyKey ||
    value.targetHash !== input.binding.targetHash ||
    value.targetVersionHash !== input.binding.targetVersionHash ||
    value.contentHash !== input.binding.contentHash ||
    value.state !== input.expectedState ||
    value.requestedMutationCount !== 1 ||
    value.sentMutationCount !== 1 ||
    value.publishAttempted !== true ||
    value.realPublishEnabled !== true ||
    value.bodyPersisted !== false ||
    value.containsForumText !== false ||
    typeof value.observedAt !== "string" ||
    !validCanonicalSha256(value.remoteEvidenceHash)
  ) {
    throwOutcomeUnknownReconciliation("RECEIPT_INVALID");
  }
  let observedAt: Date;
  try {
    observedAt = new Date(value.observedAt);
  } catch {
    throwOutcomeUnknownReconciliation("RECEIPT_INVALID");
  }
  if (
    !Number.isFinite(observedAt.getTime()) ||
    observedAt.toISOString() !== value.observedAt ||
    !input.attempt.finishedAt ||
    observedAt.getTime() !== input.attempt.finishedAt.getTime()
  ) {
    throwOutcomeUnknownReconciliation("RECEIPT_INVALID");
  }
  let computedHash: string;
  try {
    computedHash = canonicalProtocolHash(
      PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
      value as CanonicalJsonValue
    );
  } catch {
    throwOutcomeUnknownReconciliation("RECEIPT_INVALID");
  }
  if (computedHash !== input.attempt.remoteOutcomeHash) {
    throwOutcomeUnknownReconciliation("RECEIPT_INVALID");
  }
  return value as ParsedProductionAttemptReceipt;
}

function assertReconciliationPermit(
  attempt: ExecutionAttempt,
  permit: ExecutionPermit,
  context: HistoricalExecutionContext
): void {
  if (
    attempt.permitId !== permit.id ||
    permit.status !== "used" ||
    !permit.usedAt ||
    permit.revokedAt ||
    permit.realPublishEnabled !== true ||
    permit.decisionId !== attempt.decisionId ||
    permit.courseAlias !== context.decision.courseAlias
  ) {
    throwOutcomeUnknownReconciliation("PERMIT_INVALID");
  }
  if (
    context.executionAccountLease &&
    attempt.executionAccountRefHash !== context.binding.accountRefHash
  ) {
    throwOutcomeUnknownReconciliation("PERMIT_INVALID");
  }
  try {
    assertPersistedPermitBinding(permit, context.binding);
  } catch {
    throwOutcomeUnknownReconciliation("PERMIT_INVALID");
  }
  if (attempt.idempotencyKey !== permit.idempotencyKey) {
    throwOutcomeUnknownReconciliation("PERMIT_INVALID");
  }
}

async function assertReconciliationStage(input: {
  prisma: PrismaLike;
  decisionId: string;
  permit: ExecutionPermit;
}): Promise<void> {
  const stage = await input.prisma.executionStageReceipt.findUnique({
    where: { decisionId: input.decisionId }
  });
  if (
    !stage ||
    stage.status !== "consumed" ||
    !stage.usedAt ||
    stage.courseAlias !== input.permit.courseAlias ||
    stage.policyVersion !== input.permit.policyVersion ||
    stage.targetVersionHash !== input.permit.targetVersionHash ||
    stage.contentHash !== input.permit.contentHash ||
    stage.editorWriteCount !== 1 ||
    stage.editorClearCount !== 1 ||
    stage.sentMutationCount !== 0 ||
    stage.publishAttempted ||
    stage.bodyPersisted ||
    stage.containsForumText
  ) {
    throwOutcomeUnknownReconciliation("STAGE_INVALID");
  }
}

function assertReconciliationAttempt(
  attempt: ExecutionAttempt,
  expectedState: "outcome_unknown" | ReconciledExecutionState
): void {
  if (
    attempt.mode !== "AUTO" ||
    attempt.transport !== "real_platform" ||
    attempt.requestedMutationCount !== 1 ||
    attempt.sentMutationCount !== 1 ||
    attempt.publishAttempted !== true ||
    !attempt.finishedAt ||
    !attempt.remoteOutcomeHash ||
    (expectedState === "outcome_unknown" && attempt.status !== "outcome_unknown") ||
    (expectedState !== "outcome_unknown" && attempt.status !== expectedState)
  ) {
    throwOutcomeUnknownReconciliation(
      expectedState === "outcome_unknown" ? "ATTEMPT_INVALID" : "STATE_CONFLICT"
    );
  }
}

/**
 * Reconcile a previously sent real-platform attempt using already-collected
 * remote evidence.  This function is deliberately local-only: it performs no
 * adapter/network call and never changes the permit, STAGE, budget, decision,
 * policy, or manifest.  A serializable transaction plus a conditional update
 * on the unknown status makes the transition a one-time CAS.
 */
export async function reconcileOutcomeUnknownExecutionAttempt(input: {
  prisma: PrismaClient;
  attemptId: string;
  state: ReconciledExecutionState;
  remoteEvidenceHash: string;
  now: Date;
}): Promise<ExecutionClaim> {
  const remoteEvidenceHash = assertReconciliationInput(input);
  const reconcileOnce = () =>
    input.prisma.$transaction(
      async (transaction) => {
        let attempt: ExecutionAttempt | null;
        try {
          attempt = await transaction.executionAttempt.findUnique({
            where: { id: input.attemptId }
          });
        } catch {
          throwOutcomeUnknownReconciliation("ATTEMPT_NOT_FOUND");
        }
        if (!attempt) {
          throwOutcomeUnknownReconciliation("ATTEMPT_NOT_FOUND");
        }
        if (!attempt.permitId) {
          throwOutcomeUnknownReconciliation("ATTEMPT_PERMIT_MISSING");
        }
        const permit = await transaction.executionPermit.findUnique({
          where: { id: attempt.permitId }
        });
        if (!permit) {
          throwOutcomeUnknownReconciliation("PERMIT_INVALID");
        }
        const context = await loadHistoricalExecutionContext({
          prisma: transaction,
          attempt,
          permit
        });
        assertReconciliationPermit(attempt, permit, context);
        if (permit.executionProofKind === "trusted_stage") {
          await assertReconciliationStage({
            prisma: transaction,
            decisionId: context.decision.id,
            permit
          });
        }

        if (
          attempt.status === "confirmed_published" ||
          attempt.status === "confirmed_not_published"
        ) {
          if (attempt.status !== input.state) {
            throwOutcomeUnknownReconciliation("STATE_CONFLICT");
          }
          const reconciledReceipt = parseReconciliationReceipt({
            attempt,
            permit,
            binding: context.binding,
            expectedState: input.state
          });
          if (
            reconciledReceipt.remoteEvidenceHash !==
            remoteEvidenceHash
          ) {
            throwOutcomeUnknownReconciliation("STATE_CONFLICT");
          }
          return { attempt, permit, idempotent: true };
        }

        assertReconciliationAttempt(attempt, "outcome_unknown");
        parseReconciliationReceipt({
          attempt,
          permit,
          binding: context.binding,
          expectedState: "outcome_unknown"
        });
        const receipt = productionAttemptReceipt({
          permit,
          binding: context.binding,
          state: input.state,
          observedAt: input.now,
          sentMutationCount: 1,
          publishAttempted: true,
          remoteEvidenceHash
        });
        const receiptHash = canonicalProtocolHash(
          PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
          receipt as CanonicalJsonValue
        );
        const changed = await transaction.executionAttempt.updateMany({
          where: {
            id: attempt.id,
            status: "outcome_unknown",
            remoteOutcomeHash: attempt.remoteOutcomeHash
          },
          data: {
            status: input.state,
            receiptJson: JSON.stringify(receipt),
            remoteOutcomeHash: receiptHash,
            finishedAt: input.now
          }
        });
        if (changed.count !== 1) {
          throwOutcomeUnknownReconciliation("STATE_CONFLICT");
        }
        const reconciled =
          await transaction.executionAttempt.findUniqueOrThrow({
            where: { id: attempt.id }
          });
        return {
          attempt: reconciled,
          permit,
          idempotent: false
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 10_000
      }
    );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await reconcileOnce();
    } catch (error) {
      if (isPermitTransactionConflict(error)) {
        if (attempt < 2) {
          await new Promise((resolve) =>
            setTimeout(resolve, 25 * (attempt + 1))
          );
          continue;
        }
        throw new Error(
          OUTCOME_UNKNOWN_RECONCILIATION_CODES.TRANSACTION_CONFLICT
        );
      }
      throw error;
    }
  }
  throw new Error(
    OUTCOME_UNKNOWN_RECONCILIATION_CODES.TRANSACTION_CONFLICT
  );
}

export async function abortPreparedExecutionAttempt(input: {
  prisma: PrismaClient;
  attemptId: string;
  evidenceHash: string;
  now: Date;
}): Promise<ExecutionClaim> {
  const evidenceHash = sha256(
    input.evidenceHash,
    "发送前中止证据"
  );
  return input.prisma.$transaction(async (transaction) => {
    const attempt =
      await transaction.executionAttempt.findUniqueOrThrow({
        where: { id: input.attemptId }
      });
    if (!attempt.permitId) {
      throw new Error("EXECUTION_ATTEMPT_PERMIT_MISSING");
    }
    const permit =
      await transaction.executionPermit.findUniqueOrThrow({
        where: { id: attempt.permitId }
      });
    if (!hasCompleteExecutionAccountBinding(permit)) {
      throw new Error("EXECUTION_ACCOUNT_LEASE_REQUIRED");
    }
    if (
      attempt.status === "aborted_before_send" &&
      attempt.finishedAt &&
      permit.status === "used" &&
      permit.usedAt
    ) {
      const decision =
        await transaction.autonomyDecision.findUniqueOrThrow({
          where: { id: attempt.decisionId }
        });
      const invocation =
        await transaction.scheduledInvocation.findUniqueOrThrow({
          where: { id: decision.invocationId }
        });
      const leaseBinding = executionAccountLeaseBindingFromPermit({
        permit,
        decision,
        invocation,
        now: input.now
      });
      if (
        !leaseBinding ||
        attempt.executionAccountRefHash !== leaseBinding.accountRefHash
      ) {
        throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
      }
      try {
        await assertExecutionAccountLeaseBinding({
          prisma: transaction,
          ...leaseBinding,
          status: "released"
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "EXECUTION_ACCOUNT_LEASE_EXPIRED"
        ) {
          throw error;
        }
        await assertExecutionAccountLeaseBinding({
          prisma: transaction,
          ...leaseBinding,
          status: "expired"
        });
      }
      return { attempt, permit, idempotent: true };
    }
    if (
      attempt.status !== "prepared_real" ||
      attempt.transport !== "real_platform" ||
      attempt.requestedMutationCount !== 1 ||
      attempt.sentMutationCount !== 0 ||
      attempt.publishAttempted ||
      permit.status !== "claimed" ||
      permit.usedAt ||
      permit.revokedAt
    ) {
      throw new Error("EXECUTION_REAL_ABORT_STATE_CONFLICT");
    }
    const baseContext = await loadExecutionContext({
      prisma: transaction,
      decisionId: attempt.decisionId,
      now: attempt.startedAt,
      executionPolicyVersion: permit.policyVersion,
      executionProofKind:
        permit.executionProofKind as ExecutionProofKind,
      actionPlanHash: permit.actionPlanHash ?? undefined
    });
    let lease: ExecutionAccountLease | null = null;
    let leaseExpired = false;
    try {
      lease = await loadPermitExecutionAccountLease({
        prisma: transaction,
        permit,
        decision: baseContext.decision,
        invocation: baseContext.invocation,
        now: input.now,
        status: "active"
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "EXECUTION_ACCOUNT_LEASE_EXPIRED"
      ) {
        leaseExpired = true;
      } else {
        throw error;
      }
    }
    if (!lease && !leaseExpired) {
      throw new Error("EXECUTION_ACCOUNT_LEASE_REQUIRED");
    }
    const context = await loadExecutionContext({
      prisma: transaction,
      decisionId: attempt.decisionId,
      now: attempt.startedAt,
      executionPolicyVersion: permit.policyVersion,
      executionProofKind:
        permit.executionProofKind as ExecutionProofKind,
      actionPlanHash: permit.actionPlanHash ?? undefined,
      executionAccountLease: {
        id: permit.executionAccountLeaseId,
        accountRefHash: permit.executionAccountRefHash,
        credentialRefHash: permit.credentialRefHash
      }
    });
    assertPersistedPermitBinding(permit, context.binding);
    if (attempt.executionAccountRefHash !== context.binding.accountRefHash) {
      throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
    }
    const receipt = productionAttemptReceipt({
      permit,
      binding: context.binding,
      state: "aborted_before_send",
      observedAt: input.now,
      sentMutationCount: 0,
      publishAttempted: false,
      remoteEvidenceHash: evidenceHash
    });
    const receiptHash = canonicalProtocolHash(
      PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
      receipt as CanonicalJsonValue
    );
    const aborted =
      await transaction.executionAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "aborted_before_send",
          receiptJson: JSON.stringify(receipt),
          remoteOutcomeHash: receiptHash,
          finishedAt: input.now
        }
      });
    const used = await transaction.executionPermit.update({
      where: { id: permit.id },
      data: { status: "used", usedAt: input.now }
    });
    if (lease) {
      await releaseExecutionAccountLeaseInTransaction({
        prisma: transaction,
        executionAccountLeaseId: lease.id,
        accountRefHash: lease.accountRefHash,
        credentialRefHash: lease.credentialRefHash,
        decisionId: context.decision.id,
        invocationId: context.invocation.id,
        courseAlias: context.decision.courseAlias,
        now: input.now
      });
    }
    await releaseBudgetReservation({
      prisma: transaction,
      decision: context.decision,
      now: input.now
    });
    return { attempt: aborted, permit: used, idempotent: false };
  });
}

export async function claimExecutionPermit(input: {
  prisma: PrismaClient;
  permitKey: string;
  transport: "simulated_no_write" | "real_platform";
  now: Date;
  preExecutionObservation?: BoundPreExecutionTargetObservation;
}): Promise<ExecutionClaim> {
  const realExecution = input.transport === "real_platform";
  const persistedPermit =
    await input.prisma.executionPermit.findUnique({
      where: { permitKey: input.permitKey }
    });
  if (!persistedPermit) {
    throw new Error("EXECUTION_PERMIT_NOT_FOUND");
  }
  if (realExecution && !hasCompleteExecutionAccountBinding(persistedPermit)) {
    throw new Error("EXECUTION_ACCOUNT_LEASE_REQUIRED");
  }
  const existing =
    await input.prisma.executionAttempt.findUnique({
      where: {
        idempotencyKey: persistedPermit.idempotencyKey
      }
    });
  if (existing) {
    const validExisting = realExecution
      ? existing.permitId === persistedPermit.id &&
        existing.decisionId === persistedPermit.decisionId &&
        existing.transport === "real_platform" &&
        existing.mode === "AUTO" &&
        existing.requestedMutationCount === 1 &&
        (existing.sentMutationCount === 0 ||
          existing.sentMutationCount === 1)
      : existing.permitId === persistedPermit.id &&
        existing.decisionId === persistedPermit.decisionId &&
        existing.transport === "simulated_no_write" &&
        existing.requestedMutationCount === 0 &&
        existing.sentMutationCount === 0 &&
        !existing.publishAttempted;
    if (!validExisting) {
      throw new Error("EXECUTION_IDEMPOTENCY_COLLISION");
    }
    if (realExecution || hasAnyExecutionAccountBinding(persistedPermit)) {
      if (!hasCompleteExecutionAccountBinding(persistedPermit)) {
        throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
      }
      const decision = await input.prisma.autonomyDecision.findUniqueOrThrow({
        where: { id: persistedPermit.decisionId }
      });
      const invocation =
        await input.prisma.scheduledInvocation.findUniqueOrThrow({
          where: { id: decision.invocationId }
        });
      try {
        await loadPermitExecutionAccountLease({
          prisma: input.prisma,
          permit: persistedPermit,
          decision,
          invocation,
          now: input.now,
          status: realExecution
            ? existing.status === "prepared_real"
              ? "active"
              : "consumed"
            : existing.status === "claimed_no_write"
              ? "active"
              : "released"
        });
      } catch {
        throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
      }
      if (
        existing.executionAccountRefHash !==
        persistedPermit.executionAccountRefHash
      ) {
        throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
      }
    }
    return {
      attempt: existing,
      permit: persistedPermit,
      idempotent: true
    };
  }
  const validated = await validateExecutionPermit({
    prisma: input.prisma,
    permitKey: input.permitKey,
    now: input.now,
    requireRealExecution: realExecution,
    preExecutionObservation: input.preExecutionObservation
  });
  if (!validated.valid) {
    throw new Error(
      `EXECUTION_PERMIT_INVALID:${validated.code}`
    );
  }
  return input.prisma.$transaction(async (transaction) => {
    const raced =
      await transaction.executionAttempt.findUnique({
        where: {
          idempotencyKey:
            validated.permit.idempotencyKey
        }
      });
    if (raced) {
      const expectedTransport = realExecution
        ? "real_platform"
        : "simulated_no_write";
      if (
        raced.permitId !== validated.permit.id ||
        raced.decisionId !== validated.decision.id ||
        raced.transport !== expectedTransport
      ) {
        throw new Error("EXECUTION_IDEMPOTENCY_COLLISION");
      }
      if (realExecution) {
        if (
          !hasCompleteExecutionAccountBinding(validated.permit) ||
          raced.executionAccountRefHash !==
            validated.permit.executionAccountRefHash
        ) {
          throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
        }
        const racedPermit =
          await transaction.executionPermit.findUniqueOrThrow({
            where: { id: validated.permit.id }
          });
        const invocation =
          await transaction.scheduledInvocation.findUniqueOrThrow({
            where: { id: validated.decision.invocationId }
          });
        await loadPermitExecutionAccountLease({
          prisma: transaction,
          permit: racedPermit,
          decision: validated.decision,
          invocation,
          now: input.now,
          status:
            raced.status === "prepared_real" ? "active" : "consumed"
        });
      }
      return {
        attempt: raced,
        permit:
          await transaction.executionPermit.findUniqueOrThrow({
            where: { id: validated.permit.id }
          }),
        idempotent: true
      };
    }
    if (realExecution) {
      const transactionPermit =
        await transaction.executionPermit.findUniqueOrThrow({
          where: { id: validated.permit.id }
        });
      await loadPermitExecutionAccountLease({
        prisma: transaction,
        permit: transactionPermit,
        decision: validated.decision,
        invocation: await transaction.scheduledInvocation.findUniqueOrThrow({
          where: { id: validated.decision.invocationId }
        }),
        now: input.now,
        status: "active"
      });
    }
    const claimed =
      await transaction.executionPermit.updateMany({
        where: {
          id: validated.permit.id,
          status: "active",
          usedAt: null,
          revokedAt: null,
          expiresAt: { gt: input.now }
        },
        data: { status: "claimed" }
      });
    if (claimed.count !== 1) {
      throw new Error("EXECUTION_PERMIT_ALREADY_CLAIMED");
    }
    if (
      realExecution &&
      validated.permit.executionProofKind === "trusted_stage"
    ) {
      await consumeVerifiedExecutionStage({
        prisma: transaction,
        decisionId: validated.decision.id,
        now: input.now
      });
    }
    const receipt = realExecution
      ? productionAttemptReceipt({
          permit: validated.permit,
          binding: validated.binding,
          state: "prepared_real",
          observedAt: input.now,
          sentMutationCount: 0,
          publishAttempted: false,
          remoteEvidenceHash: null
        })
      : attemptReceipt({
          permit: validated.permit,
          binding: validated.binding,
          state: "claimed_no_write",
          observedAt: input.now
        });
    const attempt =
      await transaction.executionAttempt.create({
        data: {
          decisionId: validated.decision.id,
          permitId: validated.permit.id,
          mode: "AUTO",
          status: realExecution
            ? "prepared_real"
            : "claimed_no_write",
          transport: input.transport,
          idempotencyKey:
            validated.permit.idempotencyKey,
          receiptJson: JSON.stringify(receipt),
          remoteOutcomeHash: null,
          requestedMutationCount: realExecution ? 1 : 0,
          sentMutationCount: 0,
          publishAttempted: false,
          executionAccountRefHash: realExecution
            ? validated.permit.executionAccountRefHash
            : null,
          startedAt: input.now,
          finishedAt: null
        }
      });
    return {
      attempt,
      permit:
        await transaction.executionPermit.findUniqueOrThrow({
          where: { id: validated.permit.id }
        }),
      idempotent: false
    };
  });
}

export async function markExecutionAttemptSending(input: {
  prisma: PrismaClient;
  attemptId: string;
  now: Date;
  preExecutionObservation?: BoundPreExecutionTargetObservation;
}): Promise<ExecutionClaim> {
  return input.prisma.$transaction(async (transaction) => {
    const attempt =
      await transaction.executionAttempt.findUniqueOrThrow({
        where: { id: input.attemptId }
      });
    if (!attempt.permitId) {
      throw new Error("EXECUTION_ATTEMPT_PERMIT_MISSING");
    }
    const permit =
      await transaction.executionPermit.findUniqueOrThrow({
        where: { id: attempt.permitId }
      });
    if (
      attempt.transport !== "real_platform" ||
      attempt.mode !== "AUTO" ||
      attempt.requestedMutationCount !== 1 ||
      !permit.realPublishEnabled
    ) {
      throw new Error("EXECUTION_REAL_ATTEMPT_BINDING_INVALID");
    }
    if (!hasCompleteExecutionAccountBinding(permit)) {
      throw new Error("EXECUTION_ACCOUNT_LEASE_REQUIRED");
    }
    if (
      attempt.status === "sending_real" &&
      attempt.sentMutationCount === 1 &&
      attempt.publishAttempted
    ) {
      const decision =
        await transaction.autonomyDecision.findUniqueOrThrow({
          where: { id: attempt.decisionId }
        });
      const invocation =
        await transaction.scheduledInvocation.findUniqueOrThrow({
          where: { id: decision.invocationId }
        });
      const leaseBinding = executionAccountLeaseBindingFromPermit({
        permit,
        decision,
        invocation,
        now: input.now
      });
      if (
        !leaseBinding ||
        attempt.executionAccountRefHash !== leaseBinding.accountRefHash
      ) {
        throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
      }
      await assertExecutionAccountLeaseBinding({
        prisma: transaction,
        ...leaseBinding,
        status: "consumed"
      });
      return { attempt, permit, idempotent: true };
    }
    if (
      attempt.status !== "prepared_real" ||
      attempt.sentMutationCount !== 0 ||
      attempt.publishAttempted ||
      permit.status !== "claimed" ||
      permit.usedAt ||
      permit.revokedAt
    ) {
      throw new Error("EXECUTION_REAL_ATTEMPT_STATE_CONFLICT");
    }
    if (permit.expiresAt.getTime() <= input.now.getTime()) {
      throw new Error("EXECUTION_PERMIT_EXPIRED");
    }
    const baseContext = await loadExecutionContext({
      prisma: transaction,
      decisionId: attempt.decisionId,
      now: input.now,
      allowPublishAttempted: true,
      executionPolicyVersion: permit.policyVersion,
      executionProofKind:
        permit.executionProofKind as ExecutionProofKind,
      actionPlanHash: permit.actionPlanHash ?? undefined
    });
    const lease = await loadPermitExecutionAccountLease({
      prisma: transaction,
      permit,
      decision: baseContext.decision,
      invocation: baseContext.invocation,
      now: input.now,
      status: "active"
    });
    if (!lease) {
      throw new Error("EXECUTION_ACCOUNT_LEASE_REQUIRED");
    }
    const context = await loadExecutionContext({
      prisma: transaction,
      decisionId: attempt.decisionId,
      now: attempt.startedAt,
      allowPublishAttempted: true,
      executionPolicyVersion: permit.policyVersion,
      executionProofKind:
        permit.executionProofKind as ExecutionProofKind,
      actionPlanHash: permit.actionPlanHash ?? undefined,
      executionAccountLease: permitBindingLeaseFromLease(lease)
    });
    assertPersistedPermitBinding(permit, context.binding);
    if (context.actionPlan) {
      await loadCurrentCourseOperationGovernanceBinding({
        prisma: transaction,
        courseAlias: context.decision.courseAlias,
        manifestHash: context.manifest.manifestHash,
        expectedGovernanceHash: context.actionPlan.governanceHash,
        now: input.now
      });
    }
    if (permit.executionProofKind === "connector_reread") {
      const freshObservation = verifyPreExecutionTargetObservation({
        observation: input.preExecutionObservation,
        decision: context.decision,
        expectedTargetVersionHash: context.binding.targetVersionHash,
        expectedEventSetHash: context.binding.eventSetHash,
        now: input.now
      });
      if (!freshObservation.valid) {
        throw new Error(
          `EXECUTION_CONNECTOR_REREAD_INVALID:${freshObservation.code}`
        );
      }
    }
    if (attempt.executionAccountRefHash !== context.binding.accountRefHash) {
      throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
    }
    const receipt = productionAttemptReceipt({
      permit,
      binding: context.binding,
      state: "sending_real",
      observedAt: input.now,
      sentMutationCount: 1,
      publishAttempted: true,
      remoteEvidenceHash: null
    });
    const sending =
      await transaction.executionAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "sending_real",
          receiptJson: JSON.stringify(receipt),
          sentMutationCount: 1,
          publishAttempted: true
        }
      });
    await consumeExecutionAccountLeaseInTransaction({
      prisma: transaction,
      executionAccountLeaseId: lease.id,
      accountRefHash: lease.accountRefHash,
      credentialRefHash: lease.credentialRefHash,
      decisionId: context.decision.id,
      invocationId: context.invocation.id,
      courseAlias: context.decision.courseAlias,
      now: input.now
    });
    await transaction.autonomyDecision.update({
      where: { id: attempt.decisionId },
      data: { publishAttempted: true }
    });
    return { attempt: sending, permit, idempotent: false };
  });
}

export async function settleExecutionAttemptReal(input: {
  prisma: PrismaClient;
  attemptId: string;
  state:
    | "confirmed_published"
    | "confirmed_not_published"
    | "outcome_unknown";
  remoteEvidenceHash: string;
  now: Date;
}): Promise<ExecutionClaim> {
  const remoteEvidenceHash = sha256(
    input.remoteEvidenceHash,
    "远端核对证据"
  );
  return input.prisma.$transaction(async (transaction) => {
    const attempt =
      await transaction.executionAttempt.findUniqueOrThrow({
        where: { id: input.attemptId }
      });
    if (!attempt.permitId) {
      throw new Error("EXECUTION_ATTEMPT_PERMIT_MISSING");
    }
    const permit =
      await transaction.executionPermit.findUniqueOrThrow({
        where: { id: attempt.permitId }
      });
    if (!hasCompleteExecutionAccountBinding(permit)) {
      throw new Error("EXECUTION_ACCOUNT_LEASE_REQUIRED");
    }
    if (
      attempt.status === input.state &&
      attempt.finishedAt &&
      permit.status === "used" &&
      permit.usedAt
    ) {
      const decision =
        await transaction.autonomyDecision.findUniqueOrThrow({
          where: { id: attempt.decisionId }
        });
      const invocation =
        await transaction.scheduledInvocation.findUniqueOrThrow({
          where: { id: decision.invocationId }
        });
      const leaseBinding = executionAccountLeaseBindingFromPermit({
        permit,
        decision,
        invocation,
        now: input.now
      });
      if (
        !leaseBinding ||
        attempt.executionAccountRefHash !== leaseBinding.accountRefHash
      ) {
        throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
      }
      await assertExecutionAccountLeaseBinding({
        prisma: transaction,
        ...leaseBinding,
        status: "consumed"
      });
      return { attempt, permit, idempotent: true };
    }
    if (
      attempt.status !== "sending_real" ||
      attempt.transport !== "real_platform" ||
      attempt.mode !== "AUTO" ||
      attempt.requestedMutationCount !== 1 ||
      attempt.sentMutationCount !== 1 ||
      !attempt.publishAttempted ||
      permit.status !== "claimed" ||
      !permit.realPublishEnabled ||
      permit.usedAt ||
      permit.revokedAt
    ) {
      throw new Error("EXECUTION_REAL_SETTLEMENT_STATE_CONFLICT");
    }
    let context: HistoricalExecutionContext;
    try {
      // Sending has already happened. Only immutable historical bindings may
      // gate terminal bookkeeping; current pause/revoke/expiry must not strand
      // the attempt in sending_real.
      context = await loadHistoricalExecutionContext({
        prisma: transaction,
        attempt,
        permit
      });
    } catch {
      throw new Error("EXECUTION_REAL_SETTLEMENT_BINDING_INVALID");
    }
    assertPersistedPermitBinding(permit, context.binding);
    if (attempt.executionAccountRefHash !== context.binding.accountRefHash) {
      throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
    }
    const receipt = productionAttemptReceipt({
      permit,
      binding: context.binding,
      state: input.state,
      observedAt: input.now,
      sentMutationCount: 1,
      publishAttempted: true,
      remoteEvidenceHash
    });
    const receiptHash = canonicalProtocolHash(
      PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
      receipt as CanonicalJsonValue
    );
    const completed =
      await transaction.executionAttempt.update({
        where: { id: attempt.id },
        data: {
          status: input.state,
          receiptJson: JSON.stringify(receipt),
          remoteOutcomeHash: receiptHash,
          finishedAt: input.now
        }
      });
    const used = await transaction.executionPermit.update({
      where: { id: permit.id },
      data: { status: "used", usedAt: input.now }
    });
    await consumeBudgetReservation({
      prisma: transaction,
      decision: context.decision,
      now: input.now
    });
    if (permit.executionProofKind === "trusted_stage") {
      await consumeVerifiedExecutionStage({
        prisma: transaction,
        decisionId: context.decision.id,
        now: input.now,
        validAt: attempt.startedAt
      });
    }
    await transaction.autonomyDecision.update({
      where: { id: context.decision.id },
      data: { publishAttempted: true }
    });
    return {
      attempt: completed,
      permit: used,
      idempotent: false
    };
  });
}

export async function settleExecutionAttemptNoWrite(input: {
  prisma: PrismaClient;
  attemptId: string;
  now: Date;
}): Promise<ExecutionClaim> {
  return input.prisma.$transaction(async (transaction) => {
    const attempt =
      await transaction.executionAttempt.findUniqueOrThrow({
        where: { id: input.attemptId }
      });
    if (!attempt.permitId) {
      throw new Error("EXECUTION_ATTEMPT_PERMIT_MISSING");
    }
    const permit =
      await transaction.executionPermit.findUniqueOrThrow({
        where: { id: attempt.permitId }
      });
    if (
      attempt.requestedMutationCount !== 0 ||
      attempt.sentMutationCount !== 0 ||
      attempt.publishAttempted
    ) {
      throw new Error("EXECUTION_NO_WRITE_SETTLEMENT_UNSAFE");
    }
    if (
      attempt.status === "completed_no_write" &&
      permit.status === "used"
    ) {
      const decision =
        await transaction.autonomyDecision.findUniqueOrThrow({
          where: { id: attempt.decisionId }
        });
      if (hasAnyExecutionAccountBinding(permit)) {
        if (!hasCompleteExecutionAccountBinding(permit)) {
          throw new Error("EXECUTION_ACCOUNT_PERMIT_BINDING_INVALID");
        }
        const invocation =
          await transaction.scheduledInvocation.findUniqueOrThrow({
            where: { id: decision.invocationId }
          });
        const leaseBinding = executionAccountLeaseBindingFromPermit({
          permit,
          decision,
          invocation,
          now: input.now
        });
        if (
          !leaseBinding ||
          attempt.executionAccountRefHash !== leaseBinding.accountRefHash
        ) {
          throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
        }
        try {
          await assertExecutionAccountLeaseBinding({
            prisma: transaction,
            ...leaseBinding,
            status: "released"
          });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "EXECUTION_ACCOUNT_LEASE_EXPIRED"
          ) {
            throw error;
          }
          await assertExecutionAccountLeaseBinding({
            prisma: transaction,
            ...leaseBinding,
            status: "expired"
          });
        }
      }
      await releaseBudgetReservation({
        prisma: transaction,
        decision,
        now: input.now
      });
      return { attempt, permit, idempotent: true };
    }
    if (
      attempt.status !== "claimed_no_write" ||
      permit.status !== "claimed" ||
      permit.usedAt ||
      permit.revokedAt
    ) {
      throw new Error("EXECUTION_ATTEMPT_STATE_CONFLICT");
    }
    const baseContext = await loadExecutionContext({
      prisma: transaction,
      decisionId: attempt.decisionId,
      now: attempt.startedAt,
      executionPolicyVersion: permit.policyVersion,
      executionProofKind:
        permit.executionProofKind as ExecutionProofKind,
      actionPlanHash: permit.actionPlanHash ?? undefined,
      allowHistoricalNoWriteSettlement: true
    });
    let lease: ExecutionAccountLease | null = null;
    if (hasAnyExecutionAccountBinding(permit)) {
      lease = await loadPermitExecutionAccountLease({
        prisma: transaction,
        permit,
        decision: baseContext.decision,
        invocation: baseContext.invocation,
        now: input.now,
        status: "active"
      });
    }
    const context = lease
      ? await loadExecutionContext({
          prisma: transaction,
          decisionId: attempt.decisionId,
          now: attempt.startedAt,
          executionPolicyVersion: permit.policyVersion,
          executionProofKind:
            permit.executionProofKind as ExecutionProofKind,
          actionPlanHash: permit.actionPlanHash ?? undefined,
          executionAccountLease: permitBindingLeaseFromLease(lease),
          allowHistoricalNoWriteSettlement: true
        })
      : baseContext;
    assertPersistedPermitBinding(permit, context.binding);
    if (
      lease &&
      attempt.executionAccountRefHash !== context.binding.accountRefHash
    ) {
      throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
    }
    const receipt = attemptReceipt({
      permit,
      binding: context.binding,
      state: "completed_no_write",
      observedAt: input.now
    });
    const completed =
      await transaction.executionAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "completed_no_write",
          receiptJson: JSON.stringify(receipt),
          finishedAt: input.now
        }
      });
    const used = await transaction.executionPermit.update({
      where: { id: permit.id },
      data: {
        status: "used",
        usedAt: input.now
      }
    });
    await releaseBudgetReservation({
      prisma: transaction,
      decision: context.decision,
      now: input.now
    });
    if (lease) {
      await releaseExecutionAccountLeaseInTransaction({
        prisma: transaction,
        executionAccountLeaseId: lease.id,
        accountRefHash: lease.accountRefHash,
        credentialRefHash: lease.credentialRefHash,
        decisionId: context.decision.id,
        invocationId: context.invocation.id,
        courseAlias: context.decision.courseAlias,
        now: input.now
      });
    }
    return {
      attempt: completed,
      permit: used,
      idempotent: false
    };
  });
}

export async function revokeExecutionPermit(input: {
  prisma: PrismaClient;
  permitKey: string;
  now: Date;
}): Promise<ExecutionPermit> {
  const revokeOnce = () =>
    input.prisma.$transaction(
      async (transaction) => {
        const permit =
          await transaction.executionPermit.findUniqueOrThrow({
            where: { permitKey: input.permitKey }
          });
        if (permit.status === "used" || permit.usedAt) {
          throw new Error("EXECUTION_PERMIT_ALREADY_USED");
        }
        const decision =
          await transaction.autonomyDecision.findUniqueOrThrow({
            where: { id: permit.decisionId }
          });
        if (permit.status === "revoked" || permit.revokedAt) {
          if (hasAnyExecutionAccountBinding(permit)) {
            if (!hasCompleteExecutionAccountBinding(permit)) {
              throw new Error("EXECUTION_ACCOUNT_PERMIT_BINDING_INVALID");
            }
            const invocation =
              await transaction.scheduledInvocation.findUniqueOrThrow({
                where: { id: decision.invocationId }
              });
            const leaseBinding = executionAccountLeaseBindingFromPermit({
              permit,
              decision,
              invocation,
              now: input.now
            });
            if (leaseBinding) {
              try {
                await assertExecutionAccountLeaseBinding({
                  prisma: transaction,
                  ...leaseBinding,
                  status: "released"
                });
              } catch (error) {
                if (
                  !(error instanceof Error) ||
                  error.message !== "EXECUTION_ACCOUNT_LEASE_EXPIRED"
                ) {
                  throw error;
                }
                await assertExecutionAccountLeaseBinding({
                  prisma: transaction,
                  ...leaseBinding,
                  status: "expired"
                });
              }
            }
          }
          await releaseBudgetReservation({
            prisma: transaction,
            decision,
            now: input.now
          });
          return permit;
        }
        // The real-platform attempt boundary must win or lose atomically with
        // revocation.  Re-read it in this same transaction immediately before
        // updating the permit: a concurrent claim/mark either committed first
        // (and is observed here) or the revocation commits first (and the
        // claim's conditional update cannot succeed).
        const blockingRealAttempt =
          await transaction.executionAttempt.findFirst({
            where: {
              permitId: permit.id,
              transport: "real_platform",
              status: { in: ["prepared_real", "sending_real"] }
            },
            select: { id: true }
          });
        if (blockingRealAttempt) {
          throw new Error("EXECUTION_PERMIT_REAL_ATTEMPT_IN_FLIGHT");
        }
        let lease: ExecutionAccountLease | null = null;
        if (hasAnyExecutionAccountBinding(permit)) {
          const invocation =
            await transaction.scheduledInvocation.findUniqueOrThrow({
              where: { id: decision.invocationId }
            });
          try {
            lease = await loadPermitExecutionAccountLease({
              prisma: transaction,
              permit,
              decision,
              invocation,
              now: input.now,
              status: "active"
            });
          } catch (error) {
            // A permit and its lease share the same expiry boundary.  Closing
            // an already-expired pre-send permit must still be atomic and
            // fail closed; the lease is already terminally expired, so no
            // second release transition is attempted.
            if (
              error instanceof Error &&
              error.message === "EXECUTION_ACCOUNT_LEASE_EXPIRED"
            ) {
              lease = null;
            } else {
              throw error;
            }
          }
        }
        const revoked = await transaction.executionPermit.update({
          where: { id: permit.id },
          data: {
            status: "revoked",
            revokedAt: input.now
          }
        });
        await transaction.executionAttempt.updateMany({
          where: {
            permitId: permit.id,
            status: "claimed_no_write"
          },
          data: {
            status: "revoked_no_write",
            finishedAt: input.now
          }
        });
        await releaseBudgetReservation({
          prisma: transaction,
          decision,
          now: input.now
        });
        if (lease) {
          await releaseExecutionAccountLeaseInTransaction({
            prisma: transaction,
            executionAccountLeaseId: lease.id,
            accountRefHash: lease.accountRefHash,
            credentialRefHash: lease.credentialRefHash,
            decisionId: decision.id,
            invocationId: decision.invocationId,
            courseAlias: decision.courseAlias,
            now: input.now
          });
        }
        return revoked;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 10_000
      }
    );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await revokeOnce();
    } catch (error) {
      if (
        attempt < 2 &&
        isPermitTransactionConflict(error)
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, 25 * (attempt + 1))
        );
        continue;
      }
      throw error;
    }
  }
  throw new Error("EXECUTION_PERMIT_REVOKE_RETRY_EXHAUSTED");
}
