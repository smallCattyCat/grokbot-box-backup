import type {
  AutonomyDecision,
  AutonomyPolicy,
  ExecutionAttempt,
  ExecutionPermit,
  Prisma,
  PrismaClient
} from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue,
  type FacilitationMoveSpecV1,
  type InterventionIntentV1
} from "@/lib/facilitation-protocol";
import {
  REAL_FORUM_WRITE_LOCKED
} from "@/lib/forum/real-write-lock";
import {
  rebuildDeterministicSemanticDraft
} from "./semantic-renderer";
import {
  AUTONOMY_POLICY_SCHEMA_VERSION,
  registerCourseAutonomyPolicy,
  verifyAutonomyPolicyRecord
} from "./autonomy-policy";
import {
  abortPreparedExecutionAttempt,
  revokeExecutionPermit,
  settleExecutionAttemptReal
} from "./execution-permit";
import {
  parseDecisionBudgetEvidence,
  readBudgetUsage
} from "./budget-reservation";

export type MechanicalDraftSelection = {
  decision: AutonomyDecision;
  transientBody: string;
  candidateOrdinal: number;
  candidateCount: number;
  selectionHash: string;
  revalidationReceiptHash: string;
  containsForumText: false;
};

/**
 * The in-process handoff from the trusted STAGE boundary to the one-shot
 * publication boundary.  These identifiers never belong in the CLI result;
 * they are kept only long enough to bind the two calls in one process.
 */
export type OneShotPublicationHandoff = {
  decisionId: string;
  selectionHash: string;
  policyVersion: string;
};

// Each trusted invocation remains a single-action boundary, while the daily
// course budget allows up to five independently gated invocations. The
// authoritative reservation/Permit checks still run after policy activation.
export const TRUSTED_ONE_SHOT_DAILY_ACTION_LIMIT = 5;
const TRUSTED_ONE_SHOT_PER_TICK_ACTION_LIMIT = 1;
const TRUSTED_ONE_SHOT_AUTHOR_TOUCH_LIMIT_30D = 1;

type DecisionSummary = {
  candidateKey: string;
  intent: InterventionIntentV1;
  intentHash: string;
  moveSpec: FacilitationMoveSpecV1;
  moveSpecHash: string;
  draftContentHash: string;
  semanticReceipt: {
    resolution: string;
    contentHash: string | null;
    bodyPersisted: false;
    containsForumText: false;
  };
  revalidationReceipt: Record<string, unknown>;
  revalidationReceiptHash: string;
  draftBodyPersisted: false;
  publishAttempted: false;
  containsForumText: false;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("L3_DECISION_SUMMARY_INVALID");
  }
  return value as Record<string, unknown>;
}

function parseSummary(decision: AutonomyDecision): DecisionSummary {
  const value = record(JSON.parse(decision.decisionJson));
  const semantic = record(value.semanticReceipt);
  const revalidation = record(value.revalidationReceipt);
  if (
    typeof value.candidateKey !== "string" ||
    typeof value.intentHash !== "string" ||
    typeof value.moveSpecHash !== "string" ||
    typeof value.draftContentHash !== "string" ||
    typeof value.revalidationReceiptHash !== "string" ||
    value.draftBodyPersisted !== false ||
    value.publishAttempted !== false ||
    value.containsForumText !== false ||
    semantic.resolution !== "deterministic_fallback" ||
    semantic.contentHash !== value.draftContentHash ||
    semantic.bodyPersisted !== false ||
    semantic.containsForumText !== false ||
    revalidation.decision !== "EXECUTE" ||
    revalidation.containsForumText !== false ||
    typeof revalidation.schemaVersion !== "string" ||
    canonicalProtocolHash(
      revalidation.schemaVersion,
      revalidation as CanonicalJsonValue
    ) !== value.revalidationReceiptHash
  ) {
    throw new Error("L3_DECISION_NOT_MECHANICALLY_ELIGIBLE");
  }
  return {
    candidateKey: value.candidateKey,
    intent: value.intent as InterventionIntentV1,
    intentHash: value.intentHash,
    moveSpec: value.moveSpec as FacilitationMoveSpecV1,
    moveSpecHash: value.moveSpecHash,
    draftContentHash: value.draftContentHash,
    semanticReceipt:
      semantic as DecisionSummary["semanticReceipt"],
    revalidationReceipt: revalidation,
    revalidationReceiptHash:
      value.revalidationReceiptHash,
    draftBodyPersisted: false,
    publishAttempted: false,
    containsForumText: false
  };
}

export async function selectMechanicalDraft(input: {
  prisma: PrismaClient;
  courseAlias: string;
  allowStagedForPolicyVersion?: string;
  now?: Date;
}): Promise<MechanicalDraftSelection> {
  const selectionNow = input.now ?? new Date();
  const stagedSelection =
    input.allowStagedForPolicyVersion !== undefined;
  const invocation =
    await input.prisma.scheduledInvocation.findFirst({
      where: {
        courseAlias: input.courseAlias,
        mode: "SHADOW",
        status: "completed"
      },
      orderBy: [
        { scheduledFor: "desc" },
        { createdAt: "desc" }
      ]
    });
  if (!invocation) {
    throw new Error("L3_COMPLETED_SHADOW_INVOCATION_REQUIRED");
  }
  const candidateRecord =
    await input.prisma.candidateSet.findUnique({
      where: { invocationId: invocation.id }
    });
  if (!candidateRecord) {
    throw new Error("L3_CANDIDATE_SET_REQUIRED");
  }
  const candidateSet = record(
    JSON.parse(candidateRecord.candidatesJson)
  );
  if (
    candidateSet.containsForumText !== false ||
    !Array.isArray(candidateSet.candidates) ||
    candidateRecord.candidateSetHash !==
      canonicalProtocolHash(
        String(candidateSet.schemaVersion),
        candidateSet as CanonicalJsonValue
      )
  ) {
    throw new Error("L3_CANDIDATE_SET_INVALID");
  }
  const decisions =
    await input.prisma.autonomyDecision.findMany({
      where: { invocationId: invocation.id },
      include: {
        semanticRealization: true,
        executionPermits: true,
        executionAttempts: true,
        executionStageReceipt: true
      }
    });
  const byThreadKey = new Map(
    decisions.map((decision) => [decision.threadKey, decision])
  );
  for (
    let ordinal = 0;
    ordinal < candidateSet.candidates.length;
    ordinal += 1
  ) {
    const candidate = record(candidateSet.candidates[ordinal]);
    if (
      typeof candidate.threadKey !== "string" ||
      typeof candidate.candidateKey !== "string"
    ) {
      continue;
    }
    const decision = byThreadKey.get(candidate.threadKey);
    if (
      !decision ||
      decision.decision !== "draft" ||
      decision.decisionMode !== "DRAFT_ELIGIBLE" ||
      !decision.authorKey ||
      !decision.intentHash ||
      !decision.moveSpecHash ||
      !decision.draftContentHash ||
      decision.bodyPersisted ||
      decision.publishAttempted ||
      !decision.semanticRealization ||
      decision.semanticRealization.bodyPersisted ||
      decision.semanticRealization.contentHash !==
        decision.draftContentHash ||
      decision.executionPermits.length !== 0 ||
      decision.executionAttempts.length !== 0 ||
      (input.allowStagedForPolicyVersion !== undefined
        ? decision.executionStageReceipt === null ||
          decision.executionStageReceipt.status !== "verified_cleared" ||
          decision.executionStageReceipt.policyVersion !==
            input.allowStagedForPolicyVersion ||
          decision.executionStageReceipt.usedAt !== null
        : decision.executionStageReceipt !== null)
    ) {
      continue;
    }
    try {
      if (!stagedSelection) {
        const budgetEvidence = parseDecisionBudgetEvidence(decision);
        if (
          budgetEvidence.availableSlots <
          budgetEvidence.workloadCost
        ) {
          continue;
        }
        const usage = await readBudgetUsage({
          prisma: input.prisma,
          courseAlias: input.courseAlias,
          invocationId: invocation.id,
          authorKey: decision.authorKey,
          now: selectionNow,
          legacyWorkloadCost: budgetEvidence.workloadCost
        });
        const authorTouchLimit = Math.min(
          budgetEvidence.authorTouchLimit30d,
          TRUSTED_ONE_SHOT_AUTHOR_TOUCH_LIMIT_30D
        );
        if (
          usage.consumedUnitsToday +
            usage.reservedUnitsToday +
            budgetEvidence.workloadCost >
            TRUSTED_ONE_SHOT_DAILY_ACTION_LIMIT ||
          usage.consumedUnitsThisInvocation +
            usage.reservedUnitsThisInvocation +
            budgetEvidence.workloadCost >
            TRUSTED_ONE_SHOT_PER_TICK_ACTION_LIMIT ||
          usage.authorTouches30d === null ||
          usage.authorTouches30d + 1 > authorTouchLimit
        ) {
          continue;
        }
      }
      const summary = parseSummary(decision);
      if (
        summary.candidateKey !== candidate.candidateKey ||
        summary.intentHash !== decision.intentHash ||
        summary.moveSpecHash !== decision.moveSpecHash ||
        summary.draftContentHash !==
          decision.draftContentHash
      ) {
        continue;
      }
      const transientBody = rebuildDeterministicSemanticDraft({
        intent: summary.intent,
        moveSpec: summary.moveSpec,
        intentHash: summary.intentHash,
        moveSpecHash: summary.moveSpecHash,
        expectedContentHash: summary.draftContentHash
      });
      const selectionHash = canonicalProtocolHash(
        "cmooc.l3-mechanical-selection.v1",
        {
          courseAlias: input.courseAlias,
          invocationKey: invocation.invocationKey,
          candidateSetHash: candidateRecord.candidateSetHash,
          candidateKey: summary.candidateKey,
          candidateOrdinal: ordinal,
          decisionKey: decision.decisionKey,
          revalidationReceiptHash:
            summary.revalidationReceiptHash,
          contentHash: decision.draftContentHash,
          containsForumText: false
        }
      );
      return {
        decision,
        transientBody,
        candidateOrdinal: ordinal,
        candidateCount: candidateSet.candidates.length,
        selectionHash,
        revalidationReceiptHash:
          summary.revalidationReceiptHash,
        containsForumText: false
      };
    } catch {
      continue;
    }
  }
  throw new Error("L3_NO_MECHANICALLY_ELIGIBLE_DRAFT");
}

function policyVersion(now: Date, selectionHash: string): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "z")
    .toLowerCase();
  return `cmooc.autonomy.l3-one-shot.${stamp}.${selectionHash.slice(0, 12)}`;
}

export const MAX_ONE_SHOT_DAILY_ACTION_LIMIT = 10;

export function normalizeOneShotDailyActionLimit(
  value: number | undefined
): number {
  const normalized = value ?? 1;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 1 ||
    normalized > MAX_ONE_SHOT_DAILY_ACTION_LIMIT
  ) {
    throw new Error("L3_DAILY_ACTION_LIMIT_INVALID");
  }
  return normalized;
}

/**
 * These are the only terminal states which no longer hold a real-platform
 * execution boundary. `outcome_unknown` is deliberately not terminal: it is
 * a durable stop-the-world state until an operator reconciles the remote
 * result.
 */
const TERMINAL_REAL_ATTEMPT_STATUSES = [
  "aborted_before_send",
  "confirmed_not_published",
  "confirmed_published"
] as const;

const MAX_RELOCK_PERMIT_STATE_READS = 3;

function isRelockStateConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return new Set([
    "EXECUTION_PERMIT_REAL_ATTEMPT_IN_FLIGHT",
    "EXECUTION_PERMIT_ALREADY_CLAIMED",
    "EXECUTION_PERMIT_ALREADY_USED",
    "EXECUTION_REAL_ABORT_STATE_CONFLICT",
    "EXECUTION_REAL_SETTLEMENT_STATE_CONFLICT",
    "EXECUTION_PERMIT_NOT_FOUND"
  ]).has(error.message);
}

type OneShotDb = PrismaClient | Prisma.TransactionClient;

type OneShotSafetyCounts = {
  activeRealPolicyCount: number;
  openRealPermitCount: number;
  blockingRealAttemptCount: number;
};

type OneShotLockPostcondition = OneShotSafetyCounts & {
  manifestRealPublishEnabled: boolean | null;
  forumSettingRealPublishEnabled: boolean;
};

async function readOneShotSafetyCounts(
  db: OneShotDb,
  courseAlias: string
): Promise<OneShotSafetyCounts> {
  const [activeRealPolicyCount, openRealPermitCount, blockingRealAttemptCount] =
    await Promise.all([
      db.autonomyPolicy.count({
        where: {
          courseAlias,
          status: "active",
          realPublishEnabled: true,
          revokedAt: null
        }
      }),
      db.executionPermit.count({
        where: {
          courseAlias,
          realPublishEnabled: true,
          status: { in: ["active", "claimed"] },
          usedAt: null,
          revokedAt: null
        }
      }),
      db.executionAttempt.count({
        where: {
          decision: { courseAlias },
          transport: "real_platform",
          status: { notIn: [...TERMINAL_REAL_ATTEMPT_STATUSES] }
        }
      })
    ]);
  return {
    activeRealPolicyCount,
    openRealPermitCount,
    blockingRealAttemptCount
  };
}

async function readOneShotLockPostcondition(
  db: OneShotDb,
  courseAlias: string
): Promise<OneShotLockPostcondition> {
  const [manifest, forumSetting, counts] = await Promise.all([
    db.autonomyCourseManifest.findUnique({
      where: { alias: courseAlias },
      select: { realPublishEnabled: true }
    }),
    db.forumSetting.findUnique({
      where: { id: "default" },
      select: { realPublishEnabled: true }
    }),
    readOneShotSafetyCounts(db, courseAlias)
  ]);
  return {
    manifestRealPublishEnabled:
      manifest?.realPublishEnabled ?? null,
    forumSettingRealPublishEnabled:
      forumSetting?.realPublishEnabled ?? false,
    ...counts
  };
}

function assertActivationPreconditions(
  counts: OneShotSafetyCounts
): void {
  if (
    counts.activeRealPolicyCount !== 0 ||
    counts.openRealPermitCount !== 0 ||
    counts.blockingRealAttemptCount !== 0
  ) {
    throw new Error("L3_ACTIVATION_PRECONDITION_FAILED");
  }
}

function isStableL3Error(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^L3_[A-Z0-9_]+$/.test(error.message)
  );
}

function isTransactionConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  return (
    code === "P2034" ||
    /database is locked|database table is locked|deadlock|write conflict|transaction.*closed/i.test(
      error.message
    )
  );
}

function assertActivationPostcondition(
  postcondition: OneShotLockPostcondition,
  policy: AutonomyPolicy
): void {
  if (
    postcondition.manifestRealPublishEnabled !== true ||
    postcondition.activeRealPolicyCount !== 1 ||
    postcondition.openRealPermitCount !== 0 ||
    postcondition.blockingRealAttemptCount !== 0
  ) {
    throw new Error("L3_ACTIVATION_POSTCONDITION_FAILED");
  }
  // The count check above prevents duplicate active policies. Verify the
  // policy itself as a final identity check after the transaction commits.
  if (
    policy.status !== "active" ||
    policy.revokedAt !== null ||
    policy.emergencyHalt ||
    policy.realPublishEnabled !== true
  ) {
    throw new Error("L3_ACTIVATION_POSTCONDITION_FAILED");
  }
}

function hasOneShotPolicyShape(
  policy: ReturnType<typeof verifyAutonomyPolicyRecord>["policy"]
): boolean {
  return (
    policy.mode === "AUTO" &&
    policy.allowedActions.includes("stage_editor") &&
    policy.allowedActions.includes("forum_reply") &&
    Number.isSafeInteger(policy.budget.dailyActionLimit) &&
    policy.budget.dailyActionLimit >= 1 &&
    policy.budget.dailyActionLimit <=
      MAX_ONE_SHOT_DAILY_ACTION_LIMIT &&
    policy.budget.perTickActionLimit === 1 &&
    policy.budget.authorTouchLimit30d === 1
  );
}

export async function activateOneShotPolicy(input: {
  prisma: PrismaClient;
  courseAlias: string;
  selectionHash: string;
  now: Date;
  validForMinutes?: number;
  dailyActionLimit?: number;
}): Promise<AutonomyPolicy> {
  if (!REAL_FORUM_WRITE_LOCKED) {
    throw new Error("L3_GLOBAL_HARD_LOCK_MUST_REMAIN_ENABLED");
  }
  const dailyActionLimit = normalizeOneShotDailyActionLimit(
    input.dailyActionLimit
  );
  const version = policyVersion(input.now, input.selectionHash);
  const validForMinutes = Math.max(
    5,
    Math.min(60, Math.floor(input.validForMinutes ?? 30))
  );

  // An already-active real policy is always owned by another invocation (or
  // by a prior invocation whose handoff was not completed).  Never adopt it
  // as an idempotent activation: doing so would let a losing preflight/stage
  // revoke the winner in its finally block.
  const activeCount = await input.prisma.autonomyPolicy.count({
    where: {
      courseAlias: input.courseAlias,
      status: "active",
      revokedAt: null,
      realPublishEnabled: true
    }
  });
  const currentCounts = await readOneShotSafetyCounts(
    input.prisma,
    input.courseAlias
  );
  if (activeCount > 0) {
    throw new Error("L3_DIFFERENT_REAL_POLICY_ALREADY_ACTIVE");
  }
  assertActivationPreconditions(currentCounts);

  let policy: AutonomyPolicy;
  try {
    policy = await input.prisma.$transaction(async (transaction) => {
      // The manifest row is the per-course serialization/CAS point. The
      // conditional update is deliberately inside the same transaction as
      // policy creation so two concurrent activations cannot both observe a
      // clean course and then create two real policies.
      const before = await readOneShotSafetyCounts(
        transaction,
        input.courseAlias
      );
      assertActivationPreconditions(before);
      const manifestClaim =
        await transaction.autonomyCourseManifest.updateMany({
          where: {
            alias: input.courseAlias,
            enabled: true,
            realPublishEnabled: false
          },
          data: { realPublishEnabled: true }
        });
      if (manifestClaim.count !== 1) {
        throw new Error("L3_ACTIVATION_CAS_FAILED");
      }
      const created = await registerCourseAutonomyPolicy({
        prisma: transaction,
        allowRealPublishActivation: true,
        value: {
          schemaVersion: AUTONOMY_POLICY_SCHEMA_VERSION,
          courseAlias: input.courseAlias,
          version,
          mode: "AUTO",
          allowedActions: ["stage_editor", "forum_reply"],
          budget: {
            dailyActionLimit,
            perTickActionLimit: 1,
            authorTouchLimit30d: 1
          },
          validFrom: new Date(
            input.now.getTime() - 5_000
          ).toISOString(),
          validUntil: new Date(
            input.now.getTime() + validForMinutes * 60_000
          ).toISOString(),
          realPublishEnabled: true,
          containsForumText: false
        }
      });
      const after = await readOneShotSafetyCounts(
        transaction,
        input.courseAlias
      );
      const transactionManifest =
        await transaction.autonomyCourseManifest.findUnique({
          where: { alias: input.courseAlias },
          select: { realPublishEnabled: true }
        });
      if (
        transactionManifest?.realPublishEnabled !== true ||
        after.activeRealPolicyCount !== 1 ||
        after.openRealPermitCount !== 0 ||
        after.blockingRealAttemptCount !== 0
      ) {
        throw new Error("L3_ACTIVATION_POSTCONDITION_FAILED");
      }
      return created;
    });
  } catch (error) {
    // All manifest/policy writes above are in one transaction. A known
    // precondition/CAS rejection therefore rolls back without touching a
    // concurrently-owned policy. Driver errors are converted to a stable
    // fail-closed L3 code. Without a committed policy version there is no
    // ownership proof permitting cleanup, so never relock an unrelated active
    // policy here.
    if (isStableL3Error(error)) {
      throw error;
    }
    // A losing concurrent transaction is already rolled back by Prisma. Do
    // not relock the winner from the losing worker: that would turn a safe
    // one-winner race into an unexpected revocation of the successful policy.
    if (isTransactionConflictError(error)) {
      throw new Error("L3_ACTIVATION_CONFLICT");
    }
    throw new Error("L3_ACTIVATION_FAILED_CLOSED");
  }

  // Read back after commit. This catches a driver that committed only part of
  // the intended state and makes the caller fail closed instead of returning
  // an optimistic policy object.
  let postcondition: OneShotLockPostcondition;
  let committedPolicy: AutonomyPolicy | null;
  try {
    postcondition = await readOneShotLockPostcondition(
      input.prisma,
      input.courseAlias
    );
    committedPolicy = await input.prisma.autonomyPolicy.findUnique({
      where: {
        courseAlias_version: {
          courseAlias: input.courseAlias,
          version: policy.version
        }
      }
    });
  } catch {
    try {
      await relockOneShotPolicy({
        prisma: input.prisma,
        courseAlias: input.courseAlias,
        ownedPolicyVersion: policy.version,
        now: input.now
      });
    } catch {
      // Keep the stable postcondition error below.
    }
    throw new Error("L3_ACTIVATION_POSTCONDITION_FAILED");
  }
  if (!committedPolicy) {
    try {
      await relockOneShotPolicy({
        prisma: input.prisma,
        courseAlias: input.courseAlias,
        ownedPolicyVersion: policy.version,
        now: input.now
      });
    } catch {
      // Keep the stable postcondition error below.
    }
    throw new Error("L3_ACTIVATION_POSTCONDITION_FAILED");
  }
  try {
    assertActivationPostcondition(postcondition, committedPolicy);
  } catch {
    try {
      await relockOneShotPolicy({
        prisma: input.prisma,
        courseAlias: input.courseAlias,
        ownedPolicyVersion: policy.version,
        now: input.now
      });
    } catch {
      // Keep the stable postcondition error below.
    }
    throw new Error("L3_ACTIVATION_POSTCONDITION_FAILED");
  }
  return committedPolicy;
}

export async function loadActiveOneShotPolicy(input: {
  prisma: PrismaClient;
  courseAlias: string;
  now: Date;
  expectedPolicyVersion?: string;
}): Promise<AutonomyPolicy> {
  const policy = input.expectedPolicyVersion
    ? await input.prisma.autonomyPolicy.findUnique({
        where: {
          courseAlias_version: {
            courseAlias: input.courseAlias,
            version: input.expectedPolicyVersion
          }
        }
      })
    : await input.prisma.autonomyPolicy.findFirst({
        where: {
          courseAlias: input.courseAlias,
          status: "active",
          revokedAt: null,
          emergencyHalt: false,
          realPublishEnabled: true,
          validFrom: { lte: input.now },
          validUntil: { gt: input.now }
        },
        orderBy: { createdAt: "desc" }
      });
  if (!policy) throw new Error("L3_ACTIVE_POLICY_NOT_FOUND");
  if (
    input.expectedPolicyVersion &&
    policy.version !== input.expectedPolicyVersion
  ) {
    throw new Error("L3_PUBLICATION_HANDOFF_POLICY_MISMATCH");
  }
  if (
    policy.courseAlias !== input.courseAlias ||
    policy.status !== "active" ||
    policy.revokedAt !== null ||
    policy.emergencyHalt ||
    !policy.realPublishEnabled ||
    policy.validFrom > input.now ||
    policy.validUntil <= input.now
  ) {
    throw new Error("L3_ACTIVE_POLICY_NOT_FOUND");
  }
  const verified = verifyAutonomyPolicyRecord(policy);
  if (!hasOneShotPolicyShape(verified.policy)) {
    throw new Error("L3_ACTIVE_POLICY_NOT_ONE_SHOT");
  }
  return policy;
}

export type ExpiredOneShotPolicyRecoverySummary =
  | {
      status: "noop";
      reason: "no_active_policy" | "policy_not_expired";
      activePolicyCount: number;
      recovered: false;
      containsForumText: false;
    }
  | {
      status: "recovered";
      reason: "expired_policy_relocked";
      activePolicyCount: 1;
      recovered: true;
      revokedPolicyCount: number;
      closedPermitCount: number;
      manifestLocked: true;
      forumSettingLocked: true;
      globalHardLock: true;
      activeRealPolicyCount: 0;
      openRealPermitCount: 0;
      blockingRealAttemptCount: 0;
      containsForumText: false;
    };

/**
 * Reclaims an active one-shot policy only when its own validity window has
 * elapsed.  This is a local database recovery path: it never claims a fresh
 * permit, calls a transport, or retries a remote send.
 */
export async function recoverExpiredOneShotPolicy(input: {
  prisma: PrismaClient;
  courseAlias: string;
  now: Date;
}): Promise<ExpiredOneShotPolicyRecoverySummary> {
  let activePolicies: Array<{
    version: string;
    validUntil: Date;
  }>;
  try {
    activePolicies = await input.prisma.autonomyPolicy.findMany({
      where: {
        courseAlias: input.courseAlias,
        status: "active",
        revokedAt: null,
        realPublishEnabled: true
      },
      select: { version: true, validUntil: true }
    });
  } catch {
    throw new Error("L3_EXPIRED_POLICY_RECOVERY_READ_FAILED");
  }
  if (activePolicies.length === 0) {
    return {
      status: "noop",
      reason: "no_active_policy",
      activePolicyCount: 0,
      recovered: false,
      containsForumText: false
    };
  }
  if (activePolicies.length > 1) {
    // Never choose an owner when more than one active real policy is visible.
    // In particular, do not relock one policy while leaving the other active.
    throw new Error("L3_EXPIRED_POLICY_RECOVERY_CONFLICT");
  }
  const activePolicy = activePolicies[0];
  if (activePolicy.validUntil.getTime() > input.now.getTime()) {
    return {
      status: "noop",
      reason: "policy_not_expired",
      activePolicyCount: 1,
      recovered: false,
      containsForumText: false
    };
  }

  let relocked: Awaited<ReturnType<typeof relockOneShotPolicy>>;
  try {
    relocked = await relockOneShotPolicy({
      prisma: input.prisma,
      courseAlias: input.courseAlias,
      ownedPolicyVersion: activePolicy.version,
      now: input.now
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /^L3_[A-Z0-9_]+$/.test(error.message)
    ) {
      throw error;
    }
    throw new Error("L3_EXPIRED_POLICY_RECOVERY_FAILED");
  }
  if (
    !relocked.manifestLocked ||
    !relocked.forumSettingLocked ||
    !relocked.globalHardLock ||
    relocked.activeRealPolicyCount !== 0 ||
    relocked.openRealPermitCount !== 0 ||
    relocked.blockingRealAttemptCount !== 0
  ) {
    throw new Error(
      "L3_EXPIRED_POLICY_RECOVERY_POSTCONDITION_FAILED"
    );
  }
  return {
    status: "recovered",
    reason: "expired_policy_relocked",
    activePolicyCount: 1,
    recovered: true,
    revokedPolicyCount: relocked.revokedPolicyCount,
    closedPermitCount: relocked.closedPermitCount,
    manifestLocked: true,
    forumSettingLocked: true,
    globalHardLock: true,
    activeRealPolicyCount: 0,
    openRealPermitCount: 0,
    blockingRealAttemptCount: 0,
    containsForumText: false
  };
}

export async function relockOneShotPolicy(input: {
  prisma: PrismaClient;
  courseAlias: string;
  now: Date;
  /**
   * When supplied, cleanup is restricted to the policy activated by this
   * invocation.  This is essential for a losing preflight/publication call:
   * it must never revoke a concurrently-owned active policy.
   */
  ownedPolicyVersion?: string;
}): Promise<{
  revokedPolicyCount: number;
  closedPermitCount: number;
  manifestLocked: boolean;
  forumSettingLocked: boolean;
  globalHardLock: boolean;
  activeRealPolicyCount: number;
  openRealPermitCount: number;
  blockingRealAttemptCount: number;
  containsForumText: false;
}> {
  if (!REAL_FORUM_WRITE_LOCKED) {
    throw new Error("L3_RELOCK_GLOBAL_HARD_LOCK_DISABLED");
  }

  let revokedPolicyCount = 0;
  let closedPermitCount = 0;

  // Settle/revoke through the existing business functions first. They each
  // own a transaction and enforce the prepared/sending state machine; do not
  // call them from an enclosing Prisma transaction.  The first query only
  // enumerates permits.  Every action below re-reads that permit and its
  // real-platform attempts so a claim/mark transition that lands after this
  // enumeration cannot be mistaken for a clean revoke.
  let cleanupError: unknown = null;
  let permits: Array<{ id: string; permitKey: string }> = [];
  try {
    permits = await input.prisma.executionPermit.findMany({
      where: {
        courseAlias: input.courseAlias,
        ...(input.ownedPolicyVersion
          ? { policyVersion: input.ownedPolicyVersion }
          : {}),
        realPublishEnabled: true,
        status: { in: ["active", "claimed"] },
        usedAt: null,
        revokedAt: null
      },
      select: { id: true, permitKey: true }
    });
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError === null) {
    permitLoop: for (const listedPermit of permits) {
      let settledOrRevoked = false;
      for (
        let read = 0;
        read < MAX_RELOCK_PERMIT_STATE_READS;
        read += 1
      ) {
        let permit: (ExecutionPermit & {
          attempts: ExecutionAttempt[];
        }) | null;
        try {
          permit = await input.prisma.executionPermit.findUnique({
            where: { id: listedPermit.id },
            include: { attempts: true }
          });
        } catch (error) {
          cleanupError = error;
          break;
        }
        if (
          !permit ||
          permit.status === "used" ||
          permit.status === "revoked" ||
          permit.usedAt !== null ||
          permit.revokedAt !== null
        ) {
          settledOrRevoked = true;
          break;
        }
        const realAttempts = permit.attempts.filter(
          (candidate) => candidate.transport === "real_platform"
        );
        const blockingAttempt = realAttempts.find(
          (candidate) =>
            candidate.status === "prepared_real" ||
            candidate.status === "sending_real"
        );
        if (
          !blockingAttempt &&
          realAttempts.length > 0
        ) {
          cleanupError = new Error(
            "L3_RELOCK_REAL_ATTEMPT_STATE_UNRESOLVED"
          );
          break;
        }
        try {
          if (
            blockingAttempt?.status === "prepared_real" &&
            blockingAttempt.sentMutationCount === 0
          ) {
            await abortPreparedExecutionAttempt({
              prisma: input.prisma,
              attemptId: blockingAttempt.id,
              evidenceHash: canonicalProtocolHash(
                "cmooc.l3-finally-abort.v1",
                {
                  permitKey: permit.permitKey,
                  state: "finally_before_send",
                  containsForumText: false
                }
              ),
              now: input.now
            });
          } else if (
            blockingAttempt?.status === "sending_real" &&
            blockingAttempt.sentMutationCount === 1
          ) {
            // A send which may have reached the remote platform is never
            // marked clean merely because the process is shutting down.
            // Settling to outcome_unknown consumes the permit and leaves the
            // blocking attempt visible to the final postcondition check.
            await settleExecutionAttemptReal({
              prisma: input.prisma,
              attemptId: blockingAttempt.id,
              state: "outcome_unknown",
              remoteEvidenceHash: canonicalProtocolHash(
                "cmooc.l3-finally-outcome-unknown.v1",
                {
                  permitKey: permit.permitKey,
                  state: "finally_after_send",
                  containsForumText: false
                }
              ),
              now: input.now
            });
          } else {
            await revokeExecutionPermit({
              prisma: input.prisma,
              permitKey: permit.permitKey,
              now: input.now
            });
          }
          closedPermitCount += 1;
          settledOrRevoked = true;
          break;
        } catch (error) {
          if (!isRelockStateConflict(error)) {
            cleanupError = error;
            break;
          }
          // A local state transition won the race after our read.  Re-read
          // and settle/revoke the newly observed state; this loop never
          // repeats a remote send.
          if (read + 1 >= MAX_RELOCK_PERMIT_STATE_READS) {
            cleanupError = new Error(
              "L3_RELOCK_CLEANUP_RACE_UNRESOLVED"
            );
          }
        }
      }
      if (cleanupError !== null) break permitLoop;
      if (!settledOrRevoked) {
        cleanupError = new Error("L3_RELOCK_CLEANUP_RACE_UNRESOLVED");
        break;
      }
    }
  }

  // The lock writes are grouped so a crash cannot expose an enabled manifest
  // after all active policies have already been revoked (or vice versa).
  // If local cleanup is still racing, preserve the active policy/manifest and
  // leave the blocking attempt visible.  Locking them here would make a
  // failed cleanup look like a successful hard relock and would strand a
  // sending attempt under a revoked permit.
  try {
    if (cleanupError !== null) {
      throw new Error("L3_RELOCK_CLEANUP_PENDING");
    }
    const lockWrites = await input.prisma.$transaction(async (transaction) => {
      const revoked = await transaction.autonomyPolicy.updateMany({
        where: {
          courseAlias: input.courseAlias,
          ...(input.ownedPolicyVersion
            ? { version: input.ownedPolicyVersion }
            : {}),
          realPublishEnabled: true,
          status: "active",
          revokedAt: null
        },
        data: {
          status: "revoked",
          revokedAt: input.now,
          emergencyHalt: true
        }
      });
      await transaction.executionStageReceipt.updateMany({
        where: {
          courseAlias: input.courseAlias,
          ...(input.ownedPolicyVersion
            ? { policyVersion: input.ownedPolicyVersion }
            : {}),
          status: "verified_cleared",
          usedAt: null
        },
        data: { status: "revoked_unused" }
      });
      // A scoped relock must not disable a manifest or the global forum
      // setting while another invocation still owns an active policy.  The
      // normal (unscoped) relock retains the historical lock-all behavior.
      const remainingActive = input.ownedPolicyVersion
        ? await transaction.autonomyPolicy.count({
            where: {
              courseAlias: input.courseAlias,
              status: "active",
              revokedAt: null,
              realPublishEnabled: true
            }
          })
        : 0;
      const manifest =
        !input.ownedPolicyVersion || remainingActive === 0
          ? await transaction.autonomyCourseManifest.updateMany({
              where: { alias: input.courseAlias },
              data: { realPublishEnabled: false }
            })
          : { count: 0 };
      if (!input.ownedPolicyVersion || remainingActive === 0) {
        await transaction.forumSetting.updateMany({
          data: { realPublishEnabled: false }
        });
      }
      return { revokedPolicyCount: revoked.count, manifestCount: manifest.count };
    });
    revokedPolicyCount = lockWrites.revokedPolicyCount;
    if (lockWrites.manifestCount !== 1 && cleanupError === null) {
      cleanupError = new Error("L3_RELOCK_MANIFEST_MISSING");
    }
  } catch (error) {
    cleanupError ??= error;
  }

  let postcondition: OneShotLockPostcondition;
  try {
    postcondition = await readOneShotLockPostcondition(
      input.prisma,
      input.courseAlias
    );
  } catch {
    throw new Error("L3_RELOCK_POSTCONDITION_FAILED");
  }
  const clean =
    postcondition.manifestRealPublishEnabled === false &&
    postcondition.forumSettingRealPublishEnabled === false &&
    postcondition.activeRealPolicyCount === 0 &&
    postcondition.openRealPermitCount === 0 &&
    postcondition.blockingRealAttemptCount === 0 &&
    REAL_FORUM_WRITE_LOCKED;
  if (cleanupError !== null || !clean) {
    throw new Error("L3_RELOCK_POSTCONDITION_FAILED");
  }
  return {
    revokedPolicyCount,
    closedPermitCount,
    manifestLocked: postcondition.manifestRealPublishEnabled === false,
    forumSettingLocked:
      postcondition.forumSettingRealPublishEnabled === false,
    globalHardLock: REAL_FORUM_WRITE_LOCKED,
    activeRealPolicyCount: postcondition.activeRealPolicyCount,
    openRealPermitCount: postcondition.openRealPermitCount,
    blockingRealAttemptCount:
      postcondition.blockingRealAttemptCount,
    containsForumText: false
  };
}
