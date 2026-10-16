import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  AUTONOMY_WORKER_WAKE_RECEIPT_SCHEMA_VERSION,
  type WorkerWakeSoakSummary,
  type WorkerWakeSource,
  type WorkerWakeStatus
} from "./worker-wake-receipt";

export const AUTONOMY_SOAK_READINESS_SCHEMA_VERSION =
  "cmooc.autonomy-soak-readiness.v1" as const;

const HOUR_MS = 60 * 60_000;

export const DEFAULT_AUTONOMY_SOAK_READINESS_PROFILE = {
  source: "codex_automation",
  runtimeVersion: "v1-rc13",
  minimumSpanMs: 72 * HOUR_MS,
  cadenceMs: 30 * 60_000,
  minimumCompletedCycles: 144,
  maxWakeAgeMs: 60 * 60_000,
  maxAdjacentGapMs: 65 * 60_000
} as const;

export type AutonomySoakReadinessStatus =
  | "unknown"
  | "qualifying"
  | "blocked"
  | "qualified";

export type AutonomySoakReadinessCheckStatus =
  | "passed"
  | "failed"
  | "pending"
  | "unknown";

export type AutonomySoakReadinessCheckId =
  | "scope_record_count"
  | "scoped_receipt_count"
  | "receipt_contract_valid"
  | "wake_attention_count"
  | "wake_failed_count"
  | "wake_abandoned_count"
  | "stale_running_count"
  | "last_wake_age_ms"
  | "max_adjacent_gap_ms"
  | "minimum_observation_span_ms"
  | "minimum_completed_cycles"
  | "minimum_consecutive_completed_cycles"
  | "zero_editor_writes"
  | "zero_publish_attempts"
  | "real_publish_disabled"
  | "no_forum_text"
  | "worker_failure_count"
  | "recovery_failure_count"
  | "due_query_failure_count"
  | "remaining_expired_count"
  | "reconcile_failure_count"
  | "governance_filtered_count"
  | "expired_lease_count"
  | "unresolved_high_incident_count";

export type AutonomySoakReadinessCheck = {
  id: AutonomySoakReadinessCheckId;
  kind: "blocker" | "qualification";
  status: AutonomySoakReadinessCheckStatus;
  operator: "eq" | "gte" | "lte";
  observed: number | boolean | null;
  expected: number | boolean;
};

type ScopedStatusCounts = Record<WorkerWakeStatus, number>;

type ScopedAggregate = {
  recovered: number;
  recoveryFailed: number;
  remainingExpired: number;
  due: number;
  dueQueryFailed: number;
  considered: number;
  executed: number;
  skipped: number;
  failed: number;
  reconciled: number;
  reconcileFailed: number;
  governanceFiltered: number;
};

type ScopedInvariants = {
  zeroEditorWriteCount: boolean;
  zeroPublishAttemptCount: boolean;
  realPublishDisabled: boolean;
  noForumText: boolean;
};

/**
 * Structural subset supplied by the wake-receipt summarizer. Keeping the
 * evaluator dependent only on this aggregate contract prevents raw course or
 * forum material from entering the readiness receipt.
 */
export type WorkerWakeScopedSoakStatsInput = {
  source: WorkerWakeSource;
  runtimeVersion: string;
  count: number;
  statusCounts: ScopedStatusCounts;
  terminalCount: number;
  completedCount: number;
  consecutiveCompletedCount: number;
  runningCount: number;
  staleRunningCount: number;
  firstStartedAt: string | null;
  lastStartedAt: string | null;
  maxAdjacentGapMs: number | null;
  aggregate: ScopedAggregate;
  invariants: ScopedInvariants;
  receiptContractValid: boolean;
};

type SummaryWithScopedStats = WorkerWakeSoakSummary & {
  scopedStats?: readonly WorkerWakeScopedSoakStatsInput[];
  receiptContractValid?: boolean;
};

export type AutonomySoakReadinessReceipt = {
  schemaVersion: typeof AUTONOMY_SOAK_READINESS_SCHEMA_VERSION;
  assessedAt: string;
  status: AutonomySoakReadinessStatus;
  profile: typeof DEFAULT_AUTONOMY_SOAK_READINESS_PROFILE;
  qualificationScope: "local_runtime_evidence_only";
  evidence: {
    scopeRecordCount: number;
    wakeCount: number | null;
    terminalCount: number | null;
    completedCount: number | null;
    consecutiveCompletedCount: number | null;
    runningCount: number | null;
    staleRunningCount: number | null;
    firstStartedAt: string | null;
    lastStartedAt: string | null;
    observationSpanMs: number | null;
    lastWakeAgeMs: number | null;
    maxAdjacentGapMs: number | null;
  };
  checks: AutonomySoakReadinessCheck[];
  externalChecks: {
    failedOnlyDelivery: "unknown";
    successUiSuppression: "unknown";
  };
  matureV1Eligible: false;
  requestedMutationCount: 0;
  sentMutationCount: 0;
  realPublishEnabled: false;
  externalWriteAttempted: false;
  containsForumText: false;
  evidenceHash: string;
};

const STATUS_KEYS = [
  "running",
  "completed",
  "attention",
  "failed",
  "abandoned"
] as const satisfies readonly WorkerWakeStatus[];

const AGGREGATE_KEYS = [
  "recovered",
  "recoveryFailed",
  "remainingExpired",
  "due",
  "dueQueryFailed",
  "considered",
  "executed",
  "skipped",
  "failed",
  "reconciled",
  "reconcileFailed",
  "governanceFiltered"
] as const satisfies readonly (keyof ScopedAggregate)[];

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function safeCount(value: unknown): number | null {
  return isNonNegativeSafeInteger(value) ? value : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function blockerCheck(input: {
  id: AutonomySoakReadinessCheckId;
  observed: number | boolean | null;
  operator: "eq" | "lte";
  expected: number | boolean;
  unknown?: boolean;
}): AutonomySoakReadinessCheck {
  let status: AutonomySoakReadinessCheckStatus;
  if (input.unknown) {
    status = "unknown";
  } else if (input.observed === null) {
    status = "failed";
  } else if (input.operator === "eq") {
    status = input.observed === input.expected ? "passed" : "failed";
  } else {
    status =
      typeof input.observed === "number" &&
      typeof input.expected === "number" &&
      input.observed <= input.expected
        ? "passed"
        : "failed";
  }
  return {
    id: input.id,
    kind: "blocker",
    status,
    operator: input.operator,
    observed: input.observed,
    expected: input.expected
  };
}

function qualificationCheck(input: {
  id: AutonomySoakReadinessCheckId;
  observed: number | null;
  expected: number;
  unknown?: boolean;
}): AutonomySoakReadinessCheck {
  const status: AutonomySoakReadinessCheckStatus = input.unknown
    ? "unknown"
    : input.observed !== null && input.observed >= input.expected
      ? "passed"
      : "pending";
  return {
    id: input.id,
    kind: "qualification",
    status,
    operator: "gte",
    observed: input.observed,
    expected: input.expected
  };
}

function scopeStructureValid(input: {
  scope: WorkerWakeScopedSoakStatsInput;
  asOfMs: number | null;
}): boolean {
  const { scope, asOfMs } = input;
  const statusValues = STATUS_KEYS.map(
    (key) => scope.statusCounts?.[key]
  );
  const aggregateValues = AGGREGATE_KEYS.map(
    (key) => scope.aggregate?.[key]
  );
  if (
    !isNonNegativeSafeInteger(scope.count) ||
    !isNonNegativeSafeInteger(scope.terminalCount) ||
    !isNonNegativeSafeInteger(scope.completedCount) ||
    !isNonNegativeSafeInteger(scope.consecutiveCompletedCount) ||
    !isNonNegativeSafeInteger(scope.runningCount) ||
    !isNonNegativeSafeInteger(scope.staleRunningCount) ||
    !statusValues.every(isNonNegativeSafeInteger) ||
    !aggregateValues.every(isNonNegativeSafeInteger) ||
    scope.staleRunningCount > scope.runningCount ||
    scope.consecutiveCompletedCount > scope.completedCount
  ) {
    return false;
  }
  const statusTotal = statusValues.reduce(
    (sum, value) => sum + value,
    0
  );
  const expectedTerminal =
    scope.statusCounts.completed +
    scope.statusCounts.attention +
    scope.statusCounts.failed +
    scope.statusCounts.abandoned;
  if (
    statusTotal !== scope.count ||
    scope.terminalCount !== expectedTerminal ||
    scope.completedCount !== scope.statusCounts.completed ||
    scope.runningCount !== scope.statusCounts.running
  ) {
    return false;
  }
  if (
    typeof scope.invariants?.zeroEditorWriteCount !== "boolean" ||
    typeof scope.invariants?.zeroPublishAttemptCount !== "boolean" ||
    typeof scope.invariants?.realPublishDisabled !== "boolean" ||
    typeof scope.invariants?.noForumText !== "boolean"
  ) {
    return false;
  }
  if (scope.count === 0) {
    return (
      scope.firstStartedAt === null &&
      scope.lastStartedAt === null &&
      scope.maxAdjacentGapMs === null
    );
  }
  const firstStartedAtMs = parseTimestamp(scope.firstStartedAt);
  const lastStartedAtMs = parseTimestamp(scope.lastStartedAt);
  if (
    firstStartedAtMs === null ||
    lastStartedAtMs === null ||
    asOfMs === null ||
    firstStartedAtMs > lastStartedAtMs ||
    lastStartedAtMs > asOfMs
  ) {
    return false;
  }
  if (scope.count === 1) {
    return scope.maxAdjacentGapMs === null;
  }
  return isNonNegativeSafeInteger(scope.maxAdjacentGapMs);
}

function safeIso(value: string | null, timestamp: number | null): string | null {
  return value !== null && timestamp !== null
    ? new Date(timestamp).toISOString()
    : null;
}

/**
 * Evaluates only the local, source-and-runtime-scoped receipt aggregates. A
 * locally qualified result is deliberately not a mature-v1 claim: the two
 * externally observable delivery checks remain unknown until the hosting
 * product can supply trustworthy evidence for them.
 */
export function evaluateAutonomySoakReadiness(input: {
  summary: SummaryWithScopedStats;
  expiredLeaseCount: number;
  unresolvedHighIncidentCount: number;
}): AutonomySoakReadinessReceipt {
  const profile = DEFAULT_AUTONOMY_SOAK_READINESS_PROFILE;
  const asOfMs = parseTimestamp(input.summary.asOf);
  const lookbackStartedAtMs = parseTimestamp(
    input.summary.lookbackStartedAt
  );
  const envelopeValid =
    input.summary.schemaVersion ===
      AUTONOMY_WORKER_WAKE_RECEIPT_SCHEMA_VERSION &&
    asOfMs !== null &&
    lookbackStartedAtMs !== null &&
    isNonNegativeSafeInteger(input.summary.lookbackMs) &&
    asOfMs - lookbackStartedAtMs === input.summary.lookbackMs &&
    Array.isArray(input.summary.scopedStats);
  const scopedStats = Array.isArray(input.summary.scopedStats)
    ? input.summary.scopedStats
    : [];
  const matchingScopes = scopedStats.filter(
    (candidate) =>
      candidate.source === profile.source &&
      candidate.runtimeVersion === profile.runtimeVersion
  );
  const scope = matchingScopes[0] ?? null;
  const wakeCount = safeCount(scope?.count);
  const hasEvidence = wakeCount !== null && wakeCount > 0;
  const firstStartedAtMs = parseTimestamp(scope?.firstStartedAt);
  const lastStartedAtMs = parseTimestamp(scope?.lastStartedAt);
  const observationSpanMs =
    firstStartedAtMs !== null && lastStartedAtMs !== null
      ? lastStartedAtMs - firstStartedAtMs
      : null;
  const lastWakeAgeMs =
    asOfMs !== null && lastStartedAtMs !== null
      ? asOfMs - lastStartedAtMs
      : null;
  const structureValid =
    scope !== null && scopeStructureValid({ scope, asOfMs });
  const contractValid =
    envelopeValid &&
    matchingScopes.length === 1 &&
    scope?.receiptContractValid === true &&
    structureValid;
  const unknownScope = !hasEvidence && matchingScopes.length <= 1;

  const statusCount = (status: WorkerWakeStatus): number | null =>
    safeCount(scope?.statusCounts?.[status]);
  const aggregateCount = (key: keyof ScopedAggregate): number | null =>
    safeCount(scope?.aggregate?.[key]);
  const invariant = (key: keyof ScopedInvariants): boolean | null => {
    const value = scope?.invariants?.[key];
    return typeof value === "boolean" ? value : null;
  };
  const expiredLeaseCount = safeCount(input.expiredLeaseCount);
  const unresolvedHighIncidentCount = safeCount(
    input.unresolvedHighIncidentCount
  );

  const checks: AutonomySoakReadinessCheck[] = [
    blockerCheck({
      id: "scope_record_count",
      observed: matchingScopes.length,
      operator: "eq",
      expected: 1,
      unknown: matchingScopes.length === 0
    }),
    qualificationCheck({
      id: "scoped_receipt_count",
      observed: wakeCount,
      expected: 1,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "receipt_contract_valid",
      observed: contractValid,
      operator: "eq",
      expected: true,
      unknown: unknownScope && envelopeValid
    }),
    blockerCheck({
      id: "wake_attention_count",
      observed: statusCount("attention"),
      operator: "eq",
      expected: 0,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "wake_failed_count",
      observed: statusCount("failed"),
      operator: "eq",
      expected: 0,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "wake_abandoned_count",
      observed: statusCount("abandoned"),
      operator: "eq",
      expected: 0,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "stale_running_count",
      observed: safeCount(scope?.staleRunningCount),
      operator: "eq",
      expected: 0,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "last_wake_age_ms",
      observed: lastWakeAgeMs,
      operator: "lte",
      expected: profile.maxWakeAgeMs,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "max_adjacent_gap_ms",
      observed: safeCount(scope?.maxAdjacentGapMs),
      operator: "lte",
      expected: profile.maxAdjacentGapMs,
      unknown: !hasEvidence || wakeCount === 1
    }),
    qualificationCheck({
      id: "minimum_observation_span_ms",
      observed: observationSpanMs,
      expected: profile.minimumSpanMs,
      unknown: !hasEvidence
    }),
    qualificationCheck({
      id: "minimum_completed_cycles",
      observed: safeCount(scope?.completedCount),
      expected: profile.minimumCompletedCycles,
      unknown: !hasEvidence
    }),
    qualificationCheck({
      id: "minimum_consecutive_completed_cycles",
      observed: safeCount(scope?.consecutiveCompletedCount),
      expected: profile.minimumCompletedCycles,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "zero_editor_writes",
      observed: invariant("zeroEditorWriteCount"),
      operator: "eq",
      expected: true,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "zero_publish_attempts",
      observed: invariant("zeroPublishAttemptCount"),
      operator: "eq",
      expected: true,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "real_publish_disabled",
      observed: invariant("realPublishDisabled"),
      operator: "eq",
      expected: true,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "no_forum_text",
      observed: invariant("noForumText"),
      operator: "eq",
      expected: true,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "worker_failure_count",
      observed: aggregateCount("failed"),
      operator: "eq",
      expected: 0,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "recovery_failure_count",
      observed: aggregateCount("recoveryFailed"),
      operator: "eq",
      expected: 0,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "due_query_failure_count",
      observed: aggregateCount("dueQueryFailed"),
      operator: "eq",
      expected: 0,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "remaining_expired_count",
      observed: aggregateCount("remainingExpired"),
      operator: "eq",
      expected: 0,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "reconcile_failure_count",
      observed: aggregateCount("reconcileFailed"),
      operator: "eq",
      expected: 0,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "governance_filtered_count",
      observed: aggregateCount("governanceFiltered"),
      operator: "eq",
      expected: 0,
      unknown: !hasEvidence
    }),
    blockerCheck({
      id: "expired_lease_count",
      observed: expiredLeaseCount,
      operator: "eq",
      expected: 0
    }),
    blockerCheck({
      id: "unresolved_high_incident_count",
      observed: unresolvedHighIncidentCount,
      operator: "eq",
      expected: 0
    })
  ];

  const hasBlockingFailure = checks.some(
    (check) => check.kind === "blocker" && check.status === "failed"
  );
  const qualificationsPassed = checks
    .filter((check) => check.kind === "qualification")
    .every((check) => check.status === "passed");
  const status: AutonomySoakReadinessStatus = hasBlockingFailure
    ? "blocked"
    : !hasEvidence
      ? "unknown"
      : qualificationsPassed
        ? "qualified"
        : "qualifying";

  const receiptWithoutHash = {
    schemaVersion: AUTONOMY_SOAK_READINESS_SCHEMA_VERSION,
    assessedAt:
      asOfMs === null
        ? "1970-01-01T00:00:00.000Z"
        : new Date(asOfMs).toISOString(),
    status,
    profile,
    qualificationScope: "local_runtime_evidence_only" as const,
    evidence: {
      scopeRecordCount: matchingScopes.length,
      wakeCount,
      terminalCount: safeCount(scope?.terminalCount),
      completedCount: safeCount(scope?.completedCount),
      consecutiveCompletedCount: safeCount(
        scope?.consecutiveCompletedCount
      ),
      runningCount: safeCount(scope?.runningCount),
      staleRunningCount: safeCount(scope?.staleRunningCount),
      firstStartedAt: safeIso(scope?.firstStartedAt ?? null, firstStartedAtMs),
      lastStartedAt: safeIso(scope?.lastStartedAt ?? null, lastStartedAtMs),
      observationSpanMs:
        observationSpanMs !== null && observationSpanMs >= 0
          ? observationSpanMs
          : null,
      lastWakeAgeMs:
        lastWakeAgeMs !== null && lastWakeAgeMs >= 0
          ? lastWakeAgeMs
          : null,
      maxAdjacentGapMs: safeCount(scope?.maxAdjacentGapMs)
    },
    checks,
    externalChecks: {
      failedOnlyDelivery: "unknown" as const,
      successUiSuppression: "unknown" as const
    },
    matureV1Eligible: false as const,
    requestedMutationCount: 0 as const,
    sentMutationCount: 0 as const,
    realPublishEnabled: false as const,
    externalWriteAttempted: false as const,
    containsForumText: false as const
  };

  return {
    ...receiptWithoutHash,
    evidenceHash: canonicalProtocolHash(
      AUTONOMY_SOAK_READINESS_SCHEMA_VERSION,
      receiptWithoutHash as unknown as CanonicalJsonValue
    )
  };
}
