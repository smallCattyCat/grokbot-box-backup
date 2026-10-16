import type {
  AuthorizedActionPlan,
  Prisma,
  PrismaClient
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
  loadCurrentCourseOperationGovernanceBinding
} from "./course-operation-governance";

export const AUTHORIZED_ACTION_PLAN_SCHEMA_VERSION =
  "cmooc.authorized-action-plan.v1" as const;

export type ExecutionProofKind =
  | "trusted_stage"
  | "connector_reread";

export type AuthorizedActionPlanBinding = {
  schemaVersion: typeof AUTHORIZED_ACTION_PLAN_SCHEMA_VERSION;
  decisionId: string;
  invocationId: string;
  courseAlias: string;
  manifestHash: string;
  governanceHash: string;
  policyVersion: string;
  policyHash: string;
  connectorBindingHash: string;
  actionType: "forum_reply";
  executionProofKind: ExecutionProofKind;
  validUntil: string;
  containsForumText: false;
};

type PrismaLike = PrismaClient | Prisma.TransactionClient;

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

function governanceLimits(value: string | null): {
  dailySlotLimit: number;
  perTickActionLimit: number;
  authorTouchLimit30d: number;
} {
  let parsed: unknown;
  try {
    parsed = value ? JSON.parse(value) : null;
  } catch {
    throw new Error("AUTHORIZED_ACTION_PLAN_GOVERNANCE_LIMITS_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AUTHORIZED_ACTION_PLAN_GOVERNANCE_LIMITS_INVALID");
  }
  const limits = parsed as Record<string, unknown>;
  const values = [
    limits.dailySlotLimit,
    limits.perTickActionLimit,
    limits.authorTouchLimit30d
  ];
  if (
    values.some(
      (item) =>
        typeof item !== "number" ||
        !Number.isSafeInteger(item) ||
        item < 1
    )
  ) {
    throw new Error("AUTHORIZED_ACTION_PLAN_GOVERNANCE_LIMITS_INVALID");
  }
  return {
    dailySlotLimit: limits.dailySlotLimit as number,
    perTickActionLimit: limits.perTickActionLimit as number,
    authorTouchLimit30d: limits.authorTouchLimit30d as number
  };
}

export function hashAuthorizedActionPlanBinding(
  binding: AuthorizedActionPlanBinding
): string {
  return canonicalProtocolHash(
    binding.schemaVersion,
    binding as unknown as CanonicalJsonValue
  );
}

export function connectorBindingHash(input: {
  platformId: string;
  adapterId: string | null;
  allowedOrigin: string;
  canonicalLocatorHash: string;
}): string {
  return canonicalProtocolHash(
    "platform.connector-execution-binding.v1",
    {
      platformId: input.platformId,
      adapterId: input.adapterId,
      allowedOrigin: input.allowedOrigin,
      canonicalLocatorHash: sha256(
        input.canonicalLocatorHash,
        "Connector locator"
      ),
      containsForumText: false
    }
  );
}

export function authorizedActionPlanBindingFromRecord(
  record: AuthorizedActionPlan
): AuthorizedActionPlanBinding {
  if (
    record.actionType !== "forum_reply" ||
    (record.executionProofKind !== "trusted_stage" &&
      record.executionProofKind !== "connector_reread")
  ) {
    throw new Error("AUTHORIZED_ACTION_PLAN_RECORD_INVALID");
  }
  return {
    schemaVersion: AUTHORIZED_ACTION_PLAN_SCHEMA_VERSION,
    decisionId: record.decisionId,
    invocationId: record.invocationId,
    courseAlias: record.courseAlias,
    manifestHash: sha256(record.manifestHash, "Manifest"),
    governanceHash: sha256(record.governanceHash, "Governance"),
    policyVersion: record.policyVersion,
    policyHash: sha256(record.policyHash, "Policy"),
    connectorBindingHash: sha256(
      record.connectorBindingHash,
      "Connector binding"
    ),
    actionType: "forum_reply",
    executionProofKind: record.executionProofKind,
    validUntil: record.validUntil.toISOString(),
    containsForumText: false
  };
}

export async function verifyAuthorizedActionPlanRecord(input: {
  prisma: PrismaLike;
  record: AuthorizedActionPlan;
}): Promise<AuthorizedActionPlanBinding> {
  const binding = authorizedActionPlanBindingFromRecord(input.record);
  if (hashAuthorizedActionPlanBinding(binding) !== input.record.planHash) {
    throw new Error("AUTHORIZED_ACTION_PLAN_HASH_MISMATCH");
  }
  return binding;
}

export async function authorizeConnectorActionPlan(input: {
  prisma: PrismaClient;
  decisionId: string;
  executionPolicyVersion: string;
  now: Date;
  validForSeconds?: number;
}): Promise<{
  record: AuthorizedActionPlan;
  binding: AuthorizedActionPlanBinding;
  idempotent: boolean;
}> {
  const ttlSeconds = Math.max(
    30,
    Math.min(600, Math.floor(input.validForSeconds ?? 300))
  );
  return input.prisma.$transaction(async (transaction) => {
    const decision = await transaction.autonomyDecision.findUnique({
      where: { id: input.decisionId },
      include: {
        executionPermits: {
          select: {
            id: true,
            actionPlanHash: true
          }
        },
        executionAttempts: { select: { id: true } }
      }
    });
    if (
      !decision ||
      decision.decision !== "draft" ||
      decision.decisionMode !== "DRAFT_ELIGIBLE" ||
      decision.bodyPersisted ||
      decision.publishAttempted
    ) {
      throw new Error("AUTHORIZED_ACTION_PLAN_DECISION_NOT_ELIGIBLE");
    }
    const [invocation, manifest, policy, currentExecutionPolicy] =
      await Promise.all([
      transaction.scheduledInvocation.findUnique({
        where: { id: decision.invocationId }
      }),
      transaction.autonomyCourseManifest.findUnique({
        where: { alias: decision.courseAlias }
      }),
      transaction.autonomyPolicy.findUnique({
        where: {
          courseAlias_version: {
            courseAlias: decision.courseAlias,
            version: input.executionPolicyVersion
          }
        }
      }),
      transaction.autonomyPolicy.findFirst({
        where: {
          courseAlias: decision.courseAlias,
          mode: "AUTO",
          status: "active",
          revokedAt: null,
          emergencyHalt: false,
          validFrom: { lte: input.now },
          validUntil: { gt: input.now }
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }]
      })
    ]);
    if (
      !invocation ||
      invocation.courseAlias !== decision.courseAlias ||
      invocation.status !== "completed" ||
      invocation.mode !== "SHADOW" ||
      !invocation.governanceHash ||
      decision.governanceHash !== invocation.governanceHash
    ) {
      throw new Error("AUTHORIZED_ACTION_PLAN_INVOCATION_INVALID");
    }
    if (
      !manifest ||
      !manifest.enabled ||
      manifest.manifestHash !== invocation.manifestHash ||
      manifest.policyVersion !== decision.policyVersion
    ) {
      throw new Error("AUTHORIZED_ACTION_PLAN_MANIFEST_INVALID");
    }
    if (!policy) {
      throw new Error("AUTHORIZED_ACTION_PLAN_POLICY_NOT_FOUND");
    }
    if (
      !currentExecutionPolicy ||
      currentExecutionPolicy.id !== policy.id
    ) {
      throw new Error("AUTHORIZED_ACTION_PLAN_POLICY_NOT_CURRENT");
    }
    await loadCurrentCourseOperationGovernanceBinding({
      prisma: transaction,
      courseAlias: decision.courseAlias,
      manifestHash: manifest.manifestHash,
      expectedGovernanceHash: invocation.governanceHash,
      now: input.now
    });
    const verifiedPolicy = verifyAutonomyPolicyRecord(policy);
    const policyValidation = validateAutonomyPolicy({
      verified: verifiedPolicy,
      courseAlias: decision.courseAlias,
      policyVersion: policy.version,
      action: "forum_reply",
      mode: "AUTO",
      now: input.now,
      // An action plan freezes a bounded candidate; it is not a write grant.
      // Real authority is re-resolved only when a real permit is issued.
      requireRealPublish: false
    });
    if (!policyValidation.valid) {
      throw new Error(
        `AUTHORIZED_ACTION_PLAN_POLICY_INVALID:${policyValidation.code}`
      );
    }
    const limits = governanceLimits(invocation.governanceLimitsJson);
    if (
      verifiedPolicy.policy.budget.dailyActionLimit >
        limits.dailySlotLimit ||
      verifiedPolicy.policy.budget.perTickActionLimit >
        limits.perTickActionLimit ||
      verifiedPolicy.policy.budget.authorTouchLimit30d >
        limits.authorTouchLimit30d
    ) {
      throw new Error("AUTHORIZED_ACTION_PLAN_POLICY_EXCEEDS_GOVERNANCE");
    }
    const existing = await transaction.authorizedActionPlan.findUnique({
      where: { decisionId: decision.id }
    });
    if (
      !existing &&
      (decision.executionPermits.length !== 0 ||
        decision.executionAttempts.length !== 0)
    ) {
      throw new Error("AUTHORIZED_ACTION_PLAN_DECISION_NOT_ELIGIBLE");
    }
    const validUntil = existing?.validUntil ?? new Date(
      Math.min(
        input.now.getTime() + ttlSeconds * 1_000,
        policy.validUntil.getTime()
      )
    );
    if (validUntil.getTime() <= input.now.getTime()) {
      throw new Error("AUTHORIZED_ACTION_PLAN_POLICY_EXPIRES_TOO_SOON");
    }
    const binding: AuthorizedActionPlanBinding = {
      schemaVersion: AUTHORIZED_ACTION_PLAN_SCHEMA_VERSION,
      decisionId: decision.id,
      invocationId: decision.invocationId,
      courseAlias: decision.courseAlias,
      manifestHash: manifest.manifestHash,
      governanceHash: invocation.governanceHash,
      policyVersion: policy.version,
      policyHash: verifiedPolicy.policyHash,
      connectorBindingHash: connectorBindingHash(manifest),
      actionType: "forum_reply",
      executionProofKind: "connector_reread",
      validUntil: validUntil.toISOString(),
      containsForumText: false
    };
    const planHash = hashAuthorizedActionPlanBinding(binding);
    if (existing) {
      const existingBinding = await verifyAuthorizedActionPlanRecord({
        prisma: transaction,
        record: existing
      });
      if (
        existing.planHash !== planHash ||
        JSON.stringify(existingBinding) !== JSON.stringify(binding) ||
        existing.revokedAt ||
        (existing.status !== "active" &&
          existing.status !== "permit_issued") ||
        existing.validUntil.getTime() <= input.now.getTime()
      ) {
        throw new Error("AUTHORIZED_ACTION_PLAN_DECISION_CONFLICT");
      }
      const linkedPermitCount = decision.executionPermits.filter(
        (permit) => permit.actionPlanHash === existing.planHash
      ).length;
      if (
        (existing.status === "active" &&
          (decision.executionPermits.length !== 0 ||
            decision.executionAttempts.length !== 0)) ||
        (existing.status === "permit_issued" &&
          (!existing.permitIssuedAt || linkedPermitCount !== 1))
      ) {
        throw new Error("AUTHORIZED_ACTION_PLAN_DECISION_CONFLICT");
      }
      return { record: existing, binding, idempotent: true };
    }
    const created = await transaction.authorizedActionPlan.create({
      data: {
        decisionId: decision.id,
        invocationId: decision.invocationId,
        courseAlias: decision.courseAlias,
        manifestHash: manifest.manifestHash,
        governanceHash: invocation.governanceHash,
        policyVersion: policy.version,
        policyHash: verifiedPolicy.policyHash,
        connectorBindingHash: binding.connectorBindingHash,
        actionType: binding.actionType,
        executionProofKind: binding.executionProofKind,
        planHash,
        status: "active",
        validUntil,
        permitIssuedAt: null,
        revokedAt: null
      }
    });
    return { record: created, binding, idempotent: false };
  });
}

export async function loadAuthorizedActionPlanForPermit(input: {
  prisma: PrismaLike;
  decisionId: string;
  planHash: string;
  policyVersion: string;
  policyHash: string;
  manifestHash: string;
  connectorBindingHash: string;
  governanceHash: string | null;
  proofKind: ExecutionProofKind;
  now: Date;
  allowPermitIssued?: boolean;
}): Promise<AuthorizedActionPlan> {
  const planHash = sha256(input.planHash, "Action plan");
  const record = await input.prisma.authorizedActionPlan.findUnique({
    where: { planHash }
  });
  if (!record) {
    throw new Error("AUTHORIZED_ACTION_PLAN_NOT_FOUND");
  }
  const binding = await verifyAuthorizedActionPlanRecord({
    prisma: input.prisma,
    record
  });
  const currentConnectorBindingHash = sha256(
    input.connectorBindingHash,
    "Connector binding"
  );
  if (
    record.decisionId !== input.decisionId ||
    record.policyVersion !== input.policyVersion ||
    record.policyHash !== input.policyHash ||
    record.manifestHash !== input.manifestHash ||
    record.connectorBindingHash !== currentConnectorBindingHash ||
    binding.connectorBindingHash !== currentConnectorBindingHash ||
    record.governanceHash !== input.governanceHash ||
    record.executionProofKind !== input.proofKind ||
    binding.executionProofKind !== input.proofKind ||
    record.revokedAt ||
    record.validUntil.getTime() <= input.now.getTime() ||
    (record.status !== "active" &&
      !(input.allowPermitIssued && record.status === "permit_issued"))
  ) {
    throw new Error("AUTHORIZED_ACTION_PLAN_INVALID");
  }
  return record;
}

/**
 * Verify the immutable plan behind an already-issued permit without requiring
 * the plan or current governance to still be live.  This is only for local
 * settlement/reconciliation after a mutation boundary has already been
 * crossed; it must never be used to authorize a new send.
 */
export async function loadHistoricalAuthorizedActionPlanForPermit(input: {
  prisma: PrismaLike;
  decisionId: string;
  planHash: string;
  policyVersion: string;
  policyHash: string;
  manifestHash: string;
  governanceHash: string | null;
  proofKind: ExecutionProofKind;
  permitExpiresAt: Date;
}): Promise<AuthorizedActionPlan> {
  const planHash = sha256(input.planHash, "Action plan");
  const record = await input.prisma.authorizedActionPlan.findUnique({
    where: { planHash }
  });
  if (!record) {
    throw new Error("AUTHORIZED_ACTION_PLAN_NOT_FOUND");
  }
  const binding = await verifyAuthorizedActionPlanRecord({
    prisma: input.prisma,
    record
  });
  if (
    record.decisionId !== input.decisionId ||
    record.policyVersion !== input.policyVersion ||
    record.policyHash !== input.policyHash ||
    record.manifestHash !== input.manifestHash ||
    record.governanceHash !== input.governanceHash ||
    record.executionProofKind !== input.proofKind ||
    binding.executionProofKind !== input.proofKind ||
    record.status !== "permit_issued" ||
    !record.permitIssuedAt ||
    record.revokedAt ||
    record.validUntil.getTime() < input.permitExpiresAt.getTime()
  ) {
    throw new Error("AUTHORIZED_ACTION_PLAN_HISTORICAL_INVALID");
  }
  return record;
}

export async function markAuthorizedActionPlanPermitIssued(input: {
  prisma: PrismaLike;
  planHash: string;
  decisionId: string;
  now: Date;
}): Promise<void> {
  const updated = await input.prisma.authorizedActionPlan.updateMany({
    where: {
      planHash: input.planHash,
      decisionId: input.decisionId,
      status: "active",
      permitIssuedAt: null,
      revokedAt: null,
      validUntil: { gt: input.now }
    },
    data: {
      status: "permit_issued",
      permitIssuedAt: input.now
    }
  });
  if (updated.count !== 1) {
    throw new Error("AUTHORIZED_ACTION_PLAN_PERMIT_ISSUE_CONFLICT");
  }
}
