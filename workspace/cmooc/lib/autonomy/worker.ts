import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import {
  loadAnyCourseManifest,
  type AutonomyMode,
  type CourseManifest
} from "./course-manifest";
import {
  listDueAutonomyInvocations,
  recoverExpiredInvocationLeases,
  type DueInvocationDescriptor
} from "./runtime-health";
import {
  observeDueProximalOutcomes,
  preflightDueProximalOutcomes,
  scheduleProximalOutcomes
} from "./outcome-observer";
import {
  AUTONOMY_TICK_SUMMARY_SCHEMA_VERSION,
  AutonomyTickError,
  runAutonomyTick
} from "./tick";
import {
  CourseOperationGovernanceError,
  loadCourseOperationGovernance
} from "./course-operation-governance";
import type { AutonomyObserverRegistry } from "./observer-registry";
import type { AutonomyCourseObserver } from "./platform-observer";

export const AUTONOMY_WORKER_SCHEMA_VERSION =
  "cmooc.autonomy-worker-once.v2" as const;

const SAFE_MODES = new Set<AutonomyMode>([
  "OBSERVE",
  "SHADOW"
]);
const SAFE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{1,80}$/;
const SAFE_INVOCATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SAFE_HASH_PATTERN = /^[a-f0-9]{64}$/;
const KNOWN_MODES = new Set<AutonomyMode>([
  "OBSERVE",
  "SHADOW",
  "STAGE",
  "AUTO",
  "HALTED"
]);
const SAFE_SCHEDULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** The due-queue shape intentionally contains no invocation id or URL. */
export type WorkerDueInvocation = DueInvocationDescriptor;

export type WorkerTaskStatus =
  | "executed"
  | "skipped"
  | "failed";

export type WorkerTaskResult = {
  courseAlias: string;
  scheduledFor: string;
  mode: string;
  status: WorkerTaskStatus;
  reasonCode: string;
  containsForumText: false;
};

export type AutonomyWorkerCounts = {
  recovered: number;
  recoveryFailed: number;
  remainingExpired: number;
  due: number;
  dueQueryFailed: number;
  governanceFiltered: number;
  considered: number;
  executed: number;
  skipped: number;
  failed: number;
  reconciled: number;
  reconcileFailed: number;
};

export type AutonomyWorkerSummary = {
  schemaVersion: typeof AUTONOMY_WORKER_SCHEMA_VERSION;
  status: "completed" | "attention" | "failed";
  reasonCode:
    | "worker_cycle_completed"
    | "worker_cycle_attention"
    | "worker_cycle_failed";
  counts: AutonomyWorkerCounts;
  tasks: WorkerTaskResult[];
  sourceTruncated: boolean;
  containsForumText: false;
};

export type WorkerRecoverySummary = {
  recoveredCount?: number;
  remainingExpiredCount?: number;
  containsForumText?: false;
};

export type WorkerDueSummary = {
  due: WorkerDueInvocation[];
  truncated?: boolean;
  governanceFilteredCount?: number;
  containsForumText?: false;
};

export type WorkerTickInput = {
  courseAlias: string;
  requestedMode: AutonomyMode;
  scheduledFor: string;
  scheduleId: string;
};

export type WorkerReconcileInput = {
  courseAlias: string;
  mode: AutonomyMode;
  scheduledFor: string;
  now: Date;
  manifest: CourseManifest;
  tickSummary: unknown;
};

/**
 * Body-free handoff from a completed read-only SHADOW tick into the optional
 * AUTOPILOT_CANARY dispatcher. The dispatcher is dependency-injected so the
 * normal worker path remains closed unless a caller explicitly installs it.
 */
export type AutopilotCanaryDispatchInput = {
  prisma: PrismaClient;
  invocationId: string;
  courseAlias: string;
  governanceHash: string;
  scheduledFor: string;
  now: Date;
  containsForumText: false;
};

export type AutopilotCanaryDispatchResult = {
  status: "dispatched" | "skipped";
  reasonCode: string;
  containsForumText: false;
};

export type AutopilotCanaryDispatcher = (
  input: AutopilotCanaryDispatchInput
) => Promise<AutopilotCanaryDispatchResult>;

type ScheduleOutcomes = (input: {
  prisma: PrismaClient;
  courseAliases?: string[];
  limit?: number;
}) => Promise<unknown>;

type PreflightOutcomes = (input: {
  prisma: PrismaClient;
  now?: Date;
  courseAliases?: string[];
  limit?: number;
}) => Promise<unknown>;

type ObserveOutcomes = (input: {
  prisma: PrismaClient;
  now?: Date;
  courseAliases?: string[];
  outcomeIds?: string[];
  readyOnly?: boolean;
  limit?: number;
}) => Promise<unknown>;

export type AutonomyWorkerDependencies = {
  /** Optional in tests; production defaults to the singleton Prisma client. */
  prisma?: PrismaClient;
  recoverExpiredInvocationLeases?: (input: {
    prisma: PrismaClient;
    now: Date;
    limit: number;
  }) => Promise<WorkerRecoverySummary>;
  listDueAutonomyInvocations?: (input: {
    prisma: PrismaClient;
    now: Date;
    limit: number;
  }) => Promise<WorkerDueSummary>;
  resolveManifest?: (courseAlias: string) => Promise<CourseManifest>;
  resolveGovernance?: (input: {
    prisma: PrismaClient;
    manifest: CourseManifest;
    mode: "OBSERVE" | "SHADOW";
    now: Date;
  }) => Promise<{
    record: { id: string };
    policy: { version: string; mode?: "OBSERVE" | "SHADOW" };
    governanceHash: string;
  }>;
  runTick?: (
    input: WorkerTickInput,
    dependencies: {
      prisma: PrismaClient;
      manifest: CourseManifest;
      observer?: AutonomyCourseObserver;
      observerRegistry?: AutonomyObserverRegistry;
    }
  ) => Promise<unknown>;
  /**
   * Default-off post-tick seam. Installing a dispatcher does not add a worker
   * mode and never bypasses the SHADOW tick's zero-write validation.
   */
  dispatchAutopilotCanary?: AutopilotCanaryDispatcher;
  /** Optional explicit observer seam for read-only synthetic or installed connectors. */
  observer?: AutonomyCourseObserver;
  /** Optional exact platform/adapter registry passed through to the tick. */
  observerRegistry?: AutonomyObserverRegistry;
  /** Override point for tests; production uses ready-only reconciliation. */
  reconcileOutcomes?: (
    input: WorkerReconcileInput
  ) => Promise<unknown>;
  scheduleOutcomes?: ScheduleOutcomes;
  preflightOutcomes?: PreflightOutcomes;
  observeOutcomes?: ObserveOutcomes;
};

export type RunAutonomyWorkerOnceInput = {
  limit?: number;
  now?: Date | string;
};

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("AUTONOMY_WORKER_LIMIT_INVALID");
  }
  return Math.min(100, value);
}

function safeNow(value: Date | string | undefined): Date {
  const now = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(now.getTime())) {
    throw new Error("AUTONOMY_WORKER_NOW_INVALID");
  }
  return now;
}

function outputAlias(value: unknown): string {
  if (
    typeof value === "string" &&
    SAFE_ALIAS_PATTERN.test(value)
  ) {
    return value;
  }
  return "unknown";
}

function outputMode(value: unknown): string {
  if (typeof value !== "string") return "UNKNOWN";
  const normalized = value.trim().toUpperCase();
  return KNOWN_MODES.has(normalized as AutonomyMode)
    ? normalized
    : "UNKNOWN";
}

function outputScheduledFor(value: unknown): string {
  const date = new Date(
    value instanceof Date || typeof value === "string" ? value : NaN
  );
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function outputScheduleId(value: unknown): string | undefined {
  if (
    typeof value === "string" &&
    SAFE_SCHEDULE_ID_PATTERN.test(value.trim())
  ) {
    return value.trim();
  }
  return undefined;
}

function taskResult(input: {
  due: Partial<WorkerDueInvocation>;
  status: WorkerTaskStatus;
  reasonCode: string;
}): WorkerTaskResult {
  return {
    courseAlias: outputAlias(input.due.courseAlias),
    scheduledFor: outputScheduledFor(input.due.scheduledFor),
    mode: outputMode(input.due.mode),
    status: input.status,
    reasonCode: input.reasonCode,
    containsForumText: false
  };
}

function safeTickFailureReason(error: unknown): string {
  return error instanceof AutonomyTickError &&
    SAFE_REASON_CODE_PATTERN.test(error.code)
    ? error.code
    : "tick_failed";
}

function emptyCounts(): AutonomyWorkerCounts {
  return {
    recovered: 0,
    recoveryFailed: 0,
    remainingExpired: 0,
    due: 0,
    dueQueryFailed: 0,
    governanceFiltered: 0,
    considered: 0,
    executed: 0,
    skipped: 0,
    failed: 0,
    reconciled: 0,
    reconcileFailed: 0
  };
}

function workerSummary(input: {
  counts: AutonomyWorkerCounts;
  tasks: WorkerTaskResult[];
  sourceTruncated: boolean;
}): AutonomyWorkerSummary {
  const failed =
    input.counts.failed > 0 ||
    input.counts.dueQueryFailed > 0;
  const attention =
    !failed &&
    (input.counts.recoveryFailed > 0 ||
      input.counts.remainingExpired > 0 ||
      input.counts.governanceFiltered > 0 ||
      input.counts.reconcileFailed > 0 ||
      input.sourceTruncated);
  const status = failed
    ? ("failed" as const)
    : attention
      ? ("attention" as const)
      : ("completed" as const);
  return {
    schemaVersion: AUTONOMY_WORKER_SCHEMA_VERSION,
    status,
    reasonCode:
      status === "failed"
        ? "worker_cycle_failed"
        : status === "attention"
          ? "worker_cycle_attention"
          : "worker_cycle_completed",
    counts: input.counts,
    tasks: input.tasks,
    sourceTruncated: input.sourceTruncated,
    containsForumText: false
  };
}

/** Stable process exit code for OS/Codex schedulers and health monitors. */
export function autonomyWorkerExitCode(
  summary: AutonomyWorkerSummary
): 0 | 1 | 2 {
  if (summary.status === "completed") return 0;
  if (summary.status === "attention") return 2;
  return 1;
}

export type WorkerOutcomeReconcileSummary = {
  status: "reconciled" | "skipped";
  reasonCode:
    | "ready_outcomes_observed"
    | "no_ready_outcomes"
    | "ready_outcomes_raced";
  readyCount: number;
  observedCount: number;
  containsForumText: false;
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Schedule and reconcile only outcome rows that a read-only preflight proves
 * ready. The observer receives explicit ids and is forbidden to censor them.
 */
export async function reconcileReadyProximalOutcomes(
  input: {
    prisma: PrismaClient;
    now: Date;
    courseAlias: string;
  },
  dependencies: {
    scheduleOutcomes?: ScheduleOutcomes;
    preflightOutcomes?: PreflightOutcomes;
    observeOutcomes?: ObserveOutcomes;
  } = {}
): Promise<WorkerOutcomeReconcileSummary> {
  const schedule =
    dependencies.scheduleOutcomes ?? scheduleProximalOutcomes;
  const preflight =
    dependencies.preflightOutcomes ??
    preflightDueProximalOutcomes;
  const observe =
    dependencies.observeOutcomes ??
    observeDueProximalOutcomes;

  const scheduled = objectRecord(
    await schedule({
      prisma: input.prisma,
      courseAliases: [input.courseAlias],
      limit: 100
    })
  );
  if (!scheduled || scheduled.containsForumText !== false) {
    throw new Error("OUTCOME_SCHEDULE_RESULT_INVALID");
  }
  const preflightResult = objectRecord(
    await preflight({
      prisma: input.prisma,
      now: input.now,
      courseAliases: [input.courseAlias],
      limit: 100
    })
  );
  if (
    !preflightResult ||
    preflightResult.containsForumText !== false ||
    !Array.isArray(preflightResult.outcomes)
  ) {
    throw new Error("OUTCOME_PREFLIGHT_RESULT_INVALID");
  }
  const readyIds = [
    ...new Set(
      preflightResult.outcomes.flatMap((value) => {
        const row = objectRecord(value);
        return row?.status === "ready" &&
          row.courseAlias === input.courseAlias &&
          typeof row.outcomeId === "string" &&
          row.outcomeId.length > 0
          ? [row.outcomeId]
          : [];
      })
    )
  ];
  if (readyIds.length === 0) {
    return {
      status: "skipped",
      reasonCode: "no_ready_outcomes",
      readyCount: 0,
      observedCount: 0,
      containsForumText: false
    };
  }
  const observed = objectRecord(
    await observe({
      prisma: input.prisma,
      now: input.now,
      courseAliases: [input.courseAlias],
      outcomeIds: readyIds,
      readyOnly: true,
      limit: readyIds.length
    })
  );
  if (
    !observed ||
    observed.containsForumText !== false ||
    safeCount(observed.censoredCount) !== 0
  ) {
    throw new Error("READY_OUTCOME_OBSERVATION_INVALID");
  }
  const observedCount = safeCount(observed.observedCount);
  if (observedCount > readyIds.length) {
    throw new Error("READY_OUTCOME_COUNT_INVALID");
  }
  return {
    status: observedCount > 0 ? "reconciled" : "skipped",
    reasonCode:
      observedCount > 0
        ? "ready_outcomes_observed"
        : "ready_outcomes_raced",
    readyCount: readyIds.length,
    observedCount,
    containsForumText: false
  };
}

function reconcileWasCompleted(value: unknown): boolean {
  const result = objectRecord(value);
  return (
    result?.status === "reconciled" &&
    result.containsForumText === false
  );
}

type TickDisposition =
  | {
      kind: "completed";
      invocationId: string;
      canaryEligible: boolean;
    }
  | { kind: "coverage_degraded" }
  | {
      kind: "skipped";
      reasonCode:
        | "tick_lease_busy"
        | "tick_already_completed";
    }
  | { kind: "invalid" };

function validateTickSummary(input: {
  value: unknown;
  courseAlias: string;
  mode: AutonomyMode;
  scheduledFor: string;
  governanceHash: string;
}): TickDisposition {
  const summary = objectRecord(input.value);
  if (
    !summary ||
    summary.schemaVersion !==
      AUTONOMY_TICK_SUMMARY_SCHEMA_VERSION ||
    summary.courseAlias !== input.courseAlias ||
    summary.mode !== input.mode ||
    summary.scheduledFor !== input.scheduledFor ||
    typeof summary.invocationId !== "string" ||
    !SAFE_INVOCATION_ID_PATTERN.test(summary.invocationId) ||
    summary.governanceHash !== input.governanceHash ||
    !SAFE_HASH_PATTERN.test(input.governanceHash) ||
    summary.publishAttemptCount !== 0 ||
    summary.editorWriteCount !== 0 ||
    summary.realPublishEnabled !== false ||
    summary.containsForumText !== false
  ) {
    return { kind: "invalid" };
  }
  const unrecoveredCommentCompanionFailureCount =
    summary.unrecoveredCommentCompanionFailureCount ?? 0;
  if (
    typeof unrecoveredCommentCompanionFailureCount !== "number" ||
    !Number.isSafeInteger(unrecoveredCommentCompanionFailureCount) ||
    unrecoveredCommentCompanionFailureCount < 0
  ) {
    return { kind: "invalid" };
  }
  if (
    (summary.status === "completed" ||
      summary.status === "completed_partial") &&
    summary.leaseAcquired === true
  ) {
    return unrecoveredCommentCompanionFailureCount > 0
      ? { kind: "coverage_degraded" }
      : {
          kind: "completed",
          invocationId: summary.invocationId,
          // Partial coverage remains valid for the existing observer/reconcile
          // path, but cannot authorize the canary execution stage.
          canaryEligible: summary.status === "completed"
        };
  }
  if (
    summary.status === "lease_busy" &&
    summary.leaseAcquired === false
  ) {
    return {
      kind: "skipped",
      reasonCode: "tick_lease_busy"
    };
  }
  if (
    summary.status === "already_completed" &&
    summary.leaseAcquired === false
  ) {
    return {
      kind: "skipped",
      reasonCode: "tick_already_completed"
    };
  }
  return { kind: "invalid" };
}

function validCanaryDispatchResult(
  value: unknown
): value is AutopilotCanaryDispatchResult {
  const result = objectRecord(value);
  return (
    (result?.status === "dispatched" || result?.status === "skipped") &&
    typeof result.reasonCode === "string" &&
    SAFE_REASON_CODE_PATTERN.test(result.reasonCode) &&
    result.containsForumText === false
  );
}

function defaultRunTick(
  input: WorkerTickInput,
  dependencies: {
    prisma: PrismaClient;
    manifest: CourseManifest;
    observer?: AutonomyCourseObserver;
    observerRegistry?: AutonomyObserverRegistry;
  }
): Promise<unknown> {
  return runAutonomyTick(
    {
      courseAlias: input.courseAlias,
      requestedMode: input.requestedMode,
      scheduledFor: input.scheduledFor,
      scheduleId: input.scheduleId
    },
    {
      prisma: dependencies.prisma,
      manifest: dependencies.manifest,
      observer: dependencies.observer,
      observerRegistry: dependencies.observerRegistry
    }
  );
}

/**
 * Run one bounded, fail-closed worker cycle. This function only ever calls
 * the shadow/observe tick and deliberately does not expose tick or hook
 * payloads in its result.
 */
export async function runAutonomyWorkerOnce(
  input: RunAutonomyWorkerOnceInput = {},
  dependencies: AutonomyWorkerDependencies = {}
): Promise<AutonomyWorkerSummary> {
  const limit = boundedLimit(input.limit);
  const now = safeNow(input.now);
  const prisma = dependencies.prisma ?? defaultPrisma;
  const recover =
    dependencies.recoverExpiredInvocationLeases ??
    recoverExpiredInvocationLeases;
  const listDue =
    dependencies.listDueAutonomyInvocations ??
    listDueAutonomyInvocations;
  const resolveManifest =
    dependencies.resolveManifest ?? loadAnyCourseManifest;
  const resolveGovernance =
    dependencies.resolveGovernance ??
    ((value: {
      prisma: PrismaClient;
      manifest: CourseManifest;
      mode: "OBSERVE" | "SHADOW";
      now: Date;
    }) =>
      loadCourseOperationGovernance({
      prisma: value.prisma,
      manifest: value.manifest,
      now: value.now
    }));
  const runTick = dependencies.runTick ?? defaultRunTick;
  const reconcile =
    dependencies.reconcileOutcomes ??
    ((task: WorkerReconcileInput) =>
      reconcileReadyProximalOutcomes(
        {
          prisma,
          now: task.now,
          courseAlias: task.courseAlias
        },
        {
          scheduleOutcomes: dependencies.scheduleOutcomes,
          preflightOutcomes: dependencies.preflightOutcomes,
          observeOutcomes: dependencies.observeOutcomes
        }
      ));
  const counts = emptyCounts();
  const tasks: WorkerTaskResult[] = [];
  let sourceTruncated = false;

  // Recovery is intentionally a separate first phase. A failure is reported
  // as a safe aggregate and does not expose an exception or stop shutdown.
  try {
    const recovery = await recover({
      prisma,
      now,
      // Recover all bounded expired leases before listing due work. The
      // runtime-health helper itself caps this at 100.
      limit: 100
    });
    counts.recovered = safeCount(recovery.recoveredCount);
    counts.remainingExpired = safeCount(
      recovery.remainingExpiredCount
    );
  } catch {
    // A subsequent due query can still identify runnable work. The failure is
    // represented only by the aggregate remainingExpired count.
    counts.recoveryFailed = 1;
    counts.remainingExpired = 1;
  }

  let due: WorkerDueInvocation[] = [];
  try {
    // runtime-health sorts before slicing. Read a wider bounded window so an
    // old test alias or a busy lease cannot permanently starve a valid course
    // when the caller asks for one execution.
    const queryLimit = Math.min(
      100,
      Math.max(25, limit * 4)
    );
    const listed = await listDue({
      prisma,
      now,
      limit: queryLimit
    });
    due = Array.isArray(listed.due) ? listed.due : [];
    sourceTruncated = listed.truncated === true;
    counts.governanceFiltered = safeCount(
      listed.governanceFilteredCount
    );
  } catch {
    // Keep the summary safe and useful even if the database query is
    // temporarily unavailable. There is no task detail to report.
    counts.dueQueryFailed = 1;
    return workerSummary({ counts, tasks, sourceTruncated });
  }

  counts.due = due.length;
  const seenAliases = new Set<string>();
  let tickAttempts = 0;
  for (const entry of due) {
    // limit bounds actual tick attempts, not safe skips. This lets a
    // missing/test alias at the head of the queue be reported and then lets
    // a later manifest-backed course run in the same invocation.
    if (tickAttempts >= limit) break;
    counts.considered += 1;
    const alias =
      typeof entry?.courseAlias === "string"
        ? entry.courseAlias.trim()
        : "";
    const mode = outputMode(entry?.mode);

    if (entry?.state !== "runnable") {
      const reasonCode =
        entry?.state === "lease_busy"
          ? "lease_busy"
          : entry?.state === "lease_recovery_required"
            ? "lease_recovery_required"
            : "state_not_runnable";
      tasks.push(
        taskResult({ due: entry, status: "skipped", reasonCode })
      );
      counts.skipped += 1;
      continue;
    }
    if (!alias || !SAFE_ALIAS_PATTERN.test(alias)) {
      tasks.push(
        taskResult({
          due: entry,
          status: "skipped",
          reasonCode: "course_alias_invalid"
        })
      );
      counts.skipped += 1;
      continue;
    }
    if (!SAFE_MODES.has(mode as AutonomyMode)) {
      tasks.push(
        taskResult({ due: entry, status: "skipped", reasonCode: "mode_not_allowed" })
      );
      counts.skipped += 1;
      continue;
    }
    const scheduledFor = outputScheduledFor(entry.scheduledFor);
    if (!scheduledFor) {
      tasks.push(
        taskResult({
          due: entry,
          status: "skipped",
          reasonCode: "scheduled_for_invalid"
        })
      );
      counts.skipped += 1;
      continue;
    }
    const scheduleId = outputScheduleId(entry.scheduleId);
    if (!scheduleId) {
      tasks.push(
        taskResult({
          due: entry,
          status: "skipped",
          reasonCode: "schedule_id_invalid"
        })
      );
      counts.skipped += 1;
      continue;
    }
    if (new Date(scheduledFor).getTime() > now.getTime()) {
      tasks.push(
        taskResult({
          due: entry,
          status: "skipped",
          reasonCode: "scheduled_for_future"
        })
      );
      counts.skipped += 1;
      continue;
    }

    let manifest: CourseManifest;
    try {
      manifest = await resolveManifest(alias);
    } catch {
      tasks.push(
        taskResult({
          due: entry,
          status: "skipped",
          reasonCode: "manifest_unavailable"
        })
      );
      counts.skipped += 1;
      continue;
    }

    const manifestMode = outputMode(manifest?.defaultMode);
    if (manifest?.alias !== alias) {
      tasks.push(
        taskResult({
          due: entry,
          status: "skipped",
          reasonCode: "manifest_alias_mismatch"
        })
      );
      counts.skipped += 1;
      continue;
    }
    if (
      typeof entry.manifestHash !== "string" ||
      entry.manifestHash.length === 0 ||
      manifest.manifestHash !== entry.manifestHash
    ) {
      tasks.push(
        taskResult({
          due: entry,
          status: "skipped",
          reasonCode: "manifest_hash_mismatch"
        })
      );
      counts.skipped += 1;
      continue;
    }
    if (manifest.realPublishEnabled !== false) {
      tasks.push(
        taskResult({
          due: entry,
          status: "skipped",
          reasonCode: "real_publish_enabled"
        })
      );
      counts.skipped += 1;
      continue;
    }
    if (
      !SAFE_MODES.has(manifestMode as AutonomyMode) ||
      (manifestMode === "OBSERVE" && mode !== "OBSERVE") ||
      (manifestMode === "SHADOW" &&
        mode !== "SHADOW" &&
        mode !== "OBSERVE")
    ) {
      tasks.push(
        taskResult({
          due: entry,
          status: "skipped",
          reasonCode:
            manifestMode !== mode
              ? "manifest_mode_mismatch"
              : "manifest_mode_not_allowed"
        })
      );
      counts.skipped += 1;
      continue;
    }
    if (
      !Number.isSafeInteger(entry.scheduleIntervalMinutes) ||
      entry.scheduleIntervalMinutes < manifest.schedule.intervalMinutes ||
      (entry.governanceLimits &&
        entry.scheduleIntervalMinutes !==
          Math.max(
            manifest.schedule.intervalMinutes,
            entry.governanceLimits.intervalMinutes
          ))
    ) {
      tasks.push(
        taskResult({
          due: entry,
          status: "skipped",
          reasonCode: "schedule_interval_mismatch"
        })
      );
      counts.skipped += 1;
      continue;
    }
    if (
      !entry.governancePolicyId ||
      !entry.governanceVersion ||
      !entry.governanceHash
    ) {
      tasks.push(
        taskResult({
          due: entry,
          status: "skipped",
          reasonCode: "governance_unverified"
        })
      );
      counts.skipped += 1;
      continue;
    }
    // Every due source—including injected test sources—must resolve and
    // verify the current governance row. A 64-character hash in the due
    // payload is metadata only and is never sufficient by itself.
    try {
      const governance = await resolveGovernance({
        prisma,
        manifest,
        mode: mode as "OBSERVE" | "SHADOW",
        now
      });
      if (
        governance.record.id !== entry.governancePolicyId ||
        governance.policy.version !== entry.governanceVersion ||
        governance.governanceHash !== entry.governanceHash ||
        typeof governance.record.id !== "string" ||
        typeof governance.policy.version !== "string" ||
        typeof governance.governanceHash !== "string" ||
        governance.governanceHash.length !== 64
      ) {
        tasks.push(
          taskResult({
            due: entry,
            status: "skipped",
            reasonCode: "governance_drift"
          })
        );
        counts.skipped += 1;
        continue;
      }
      const governanceMode = outputMode(governance.policy.mode);
      if (
        governance.policy.mode !== undefined &&
        (!SAFE_MODES.has(governanceMode as AutonomyMode) ||
          (governanceMode === "OBSERVE" && mode !== "OBSERVE") ||
          (governanceMode === "SHADOW" &&
            mode !== "SHADOW" &&
            mode !== "OBSERVE"))
      ) {
        tasks.push(
          taskResult({
            due: entry,
            status: "skipped",
            reasonCode: "governance_mode_not_allowed"
          })
        );
        counts.skipped += 1;
        continue;
      }
    } catch (error) {
      const reasonCode =
        error instanceof CourseOperationGovernanceError
          ? error.code
          : "governance_unavailable";
      tasks.push(
        taskResult({ due: entry, status: "skipped", reasonCode })
      );
      counts.skipped += 1;
      continue;
    }
    if (seenAliases.has(alias)) {
      tasks.push(
        taskResult({
          due: entry,
          status: "skipped",
          reasonCode: "duplicate_course"
        })
      );
      counts.skipped += 1;
      continue;
    }
    seenAliases.add(alias);
    tickAttempts += 1;

    try {
      const tickSummary = await runTick(
        {
          courseAlias: alias,
          requestedMode: mode as AutonomyMode,
          scheduledFor,
          scheduleId
        },
        {
          prisma,
          manifest,
          observer: dependencies.observer,
          observerRegistry: dependencies.observerRegistry
        }
      );
      const disposition = validateTickSummary({
        value: tickSummary,
        courseAlias: alias,
        mode: mode as AutonomyMode,
        scheduledFor,
        governanceHash: entry.governanceHash
      });
      if (disposition.kind === "skipped") {
        counts.skipped += 1;
        tasks.push(
          taskResult({
            due: entry,
            status: "skipped",
            reasonCode: disposition.reasonCode
          })
        );
        continue;
      }
      if (disposition.kind === "invalid") {
        counts.failed += 1;
        tasks.push(
          taskResult({
            due: entry,
            status: "failed",
            reasonCode: "tick_summary_invalid"
          })
        );
        continue;
      }
      if (disposition.kind === "coverage_degraded") {
        counts.failed += 1;
        tasks.push(
          taskResult({
            due: entry,
            status: "failed",
            reasonCode: "tick_comment_companion_unrecovered"
          })
        );
        continue;
      }
      if (
        mode === "SHADOW" &&
        disposition.canaryEligible &&
        dependencies.dispatchAutopilotCanary
      ) {
        try {
          const canaryResult = await dependencies.dispatchAutopilotCanary({
            prisma,
            invocationId: disposition.invocationId,
            courseAlias: alias,
            governanceHash: entry.governanceHash,
            scheduledFor,
            now,
            containsForumText: false
          });
          if (!validCanaryDispatchResult(canaryResult)) {
            throw new Error("AUTOPILOT_CANARY_RESULT_INVALID");
          }
          if (canaryResult.status === "skipped") {
            // An installed canary may make a body-free, policy-bound refusal.
            // The completed read-only tick still succeeds; the refusal never
            // becomes an execution attempt and does not alter worker output.
          }
        } catch {
          counts.failed += 1;
          tasks.push(
            taskResult({
              due: entry,
              status: "failed",
              reasonCode: "autopilot_canary_failed"
            })
          );
          continue;
        }
      }
      counts.executed += 1;
      try {
        const reconcileResult = await reconcile({
          courseAlias: alias,
          mode: mode as AutonomyMode,
          scheduledFor,
          now: input.now === undefined ? new Date() : now,
          manifest,
          tickSummary
        });
        if (reconcileWasCompleted(reconcileResult)) {
          counts.reconciled += 1;
        }
        tasks.push(
          taskResult({
            due: entry,
            status: "executed",
            reasonCode: "tick_completed"
          })
        );
      } catch {
        counts.reconcileFailed += 1;
        tasks.push(
          taskResult({
            due: entry,
            status: "executed",
            reasonCode: "tick_completed_reconcile_failed"
          })
        );
      }
    } catch (error) {
      counts.failed += 1;
      tasks.push(
        taskResult({
          due: entry,
          status: "failed",
          reasonCode: safeTickFailureReason(error)
        })
      );
    }
  }

  return workerSummary({ counts, tasks, sourceTruncated });
}

function safeCount(value: unknown): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : 0;
}
