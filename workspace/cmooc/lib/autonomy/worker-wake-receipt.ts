import type { PrismaClient } from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import type {
  AutonomyWorkerCounts,
  AutonomyWorkerSummary,
  WorkerTaskResult
} from "./worker";

// Keep this module type-only dependent on worker.ts. runtime-health.ts imports
// this receipt module and worker.ts imports runtime-health.ts, so a runtime
// import here would create an initialization cycle.
const AUTONOMY_WORKER_SCHEMA_VERSION =
  "cmooc.autonomy-worker-once.v2" as const;

export const AUTONOMY_WORKER_WAKE_RECEIPT_SCHEMA_VERSION =
  "cmooc.autonomy-worker-wake-receipt.v2" as const;

export const WORKER_WAKE_SOURCES = [
  "codex_automation",
  "local_cli",
  "test"
] as const;

export type WorkerWakeSource = (typeof WORKER_WAKE_SOURCES)[number];

export const WORKER_WAKE_STATUSES = [
  "running",
  "completed",
  "attention",
  "failed",
  "abandoned"
] as const;

export type WorkerWakeStatus = (typeof WORKER_WAKE_STATUSES)[number];

const STALE_WAKE_MS = 2 * 60 * 60_000;
const SAFE_RUNTIME_VERSION_PATTERN =
  /^(?:source|v[0-9]+(?:[._-][a-z0-9]+)*)$/i;
const SAFE_REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{1,80}$/;
const SAFE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_MODES = new Set([
  "OBSERVE",
  "SHADOW",
  "UNKNOWN"
]);
const SAFE_TASK_STATUSES = new Set([
  "executed",
  "skipped",
  "failed"
]);
const COUNT_KEYS = [
  "recovered",
  "recoveryFailed",
  "remainingExpired",
  "due",
  "dueQueryFailed",
  "governanceFiltered",
  "considered",
  "executed",
  "skipped",
  "failed",
  "reconciled",
  "reconcileFailed"
] as const satisfies readonly (keyof AutonomyWorkerCounts)[];

const UNSAFE_STRING_PATTERN =
  /https?:\/\/|www\.|cookie|token|password|secret|auth[-_ ]?state|api[-_ ]?key|sensitive|transient|marker|forum|body|content|title|author|platform[-_ ]?id|正文|论坛/i;

export type WorkerWakeReceiptHandle = {
  id: string;
  source: WorkerWakeSource;
  runtimeVersion: string;
  startedAt: Date;
  status: "running";
  abandonedStaleCount: number;
};

export type WorkerWakeSoakSummary = {
  schemaVersion: typeof AUTONOMY_WORKER_WAKE_RECEIPT_SCHEMA_VERSION;
  asOf: string;
  lookbackMs: number;
  lookbackStartedAt: string;
  totalReceipts: number;
  sourceCounts: Record<WorkerWakeSource, number>;
  statusCounts: Record<WorkerWakeStatus, number>;
  terminalCount: number;
  completedCount: number;
  consecutiveTerminalCount: number;
  consecutiveCompletedCount: number;
  runningCount: number;
  staleRunningCount: number;
  firstStartedAt: string | null;
  lastStartedAt: string | null;
  maxAdjacentGapMs: number | null;
  sourceStats: Record<WorkerWakeSource, WorkerWakeSourceSoakStats>;
  scopedStats: WorkerWakeScopedSoakStats[];
  runtimeVersionCounts: Record<string, number>;
  aggregate: AutonomyWorkerCounts;
  invariants: {
    zeroEditorWriteCount: boolean;
    zeroPublishAttemptCount: boolean;
    realPublishDisabled: boolean;
    noForumText: boolean;
  };
  receiptContractValid: boolean;
  evidenceHash: string;
  containsForumText: false;
};

export type WorkerWakeSourceSoakStats = {
  count: number;
  firstStartedAt: string | null;
  lastStartedAt: string | null;
  maxAdjacentGapMs: number | null;
};

export type WorkerWakeScopedSoakStats = {
  source: WorkerWakeSource;
  runtimeVersion: string;
  count: number;
  statusCounts: Record<WorkerWakeStatus, number>;
  terminalCount: number;
  completedCount: number;
  consecutiveTerminalCount: number;
  consecutiveCompletedCount: number;
  runningCount: number;
  staleRunningCount: number;
  firstStartedAt: string | null;
  lastStartedAt: string | null;
  lastStatus: WorkerWakeStatus | null;
  maxAdjacentGapMs: number | null;
  aggregate: AutonomyWorkerCounts;
  invariants: {
    zeroEditorWriteCount: boolean;
    zeroPublishAttemptCount: boolean;
    realPublishDisabled: boolean;
    noForumText: boolean;
  };
  receiptContractValid: boolean;
};

function validNow(value: Date | string | undefined): Date {
  const now = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(now.getTime())) {
    throw new Error("AUTONOMY_WAKE_RECEIPT_TIME_INVALID");
  }
  return now;
}

function validateSource(value: string | undefined): WorkerWakeSource {
  const source = value ?? "local_cli";
  if (
    !WORKER_WAKE_SOURCES.includes(
      source as WorkerWakeSource
    )
  ) {
    throw new Error("AUTONOMY_WAKE_RECEIPT_SOURCE_INVALID");
  }
  return source as WorkerWakeSource;
}

function validateRuntimeVersion(value: string | undefined): string {
  const runtimeVersion = value ?? "source";
  if (
    !SAFE_RUNTIME_VERSION_PATTERN.test(runtimeVersion) ||
    runtimeVersion.length > 64
  ) {
    throw new Error(
      "AUTONOMY_WAKE_RECEIPT_RUNTIME_VERSION_INVALID"
    );
  }
  return runtimeVersion;
}

function zeroCounts(): AutonomyWorkerCounts {
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

function canonicalValue(value: unknown): CanonicalJsonValue {
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item));
  }
  if (typeof value === "object") {
    const result: Record<string, CanonicalJsonValue> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>
    )) {
      result[key] = canonicalValue(item);
    }
    return result;
  }
  throw new Error("AUTONOMY_WAKE_RECEIPT_CANONICAL_VALUE_INVALID");
}

function hashValue(
  schemaVersion: string,
  value: unknown
): string {
  const canonical = canonicalValue(value);
  const hashDomainValue =
    canonical !== null &&
    !Array.isArray(canonical) &&
    typeof canonical === "object" &&
    "schemaVersion" in canonical &&
    canonical.schemaVersion !== schemaVersion
      ? {
          schemaVersion,
          value: canonical
        }
      : canonical;
  return canonicalProtocolHash(
    schemaVersion,
    hashDomainValue
  );
}

function assertNoUnsafeStrings(value: unknown): void {
  if (typeof value === "string") {
    if (UNSAFE_STRING_PATTERN.test(value)) {
      throw new Error("AUTONOMY_WAKE_RECEIPT_SUMMARY_INVALID");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoUnsafeStrings(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      assertNoUnsafeStrings(item);
    }
  }
}

function normalizedCounts(
  value: unknown
): AutonomyWorkerCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AUTONOMY_WAKE_RECEIPT_SUMMARY_INVALID");
  }
  const source = value as Record<string, unknown>;
  const sourceKeys = Object.keys(source);
  if (
    sourceKeys.length !== COUNT_KEYS.length ||
    sourceKeys.some(
      (key) =>
        !COUNT_KEYS.includes(
          key as (typeof COUNT_KEYS)[number]
        )
    )
  ) {
    throw new Error("AUTONOMY_WAKE_RECEIPT_SUMMARY_INVALID");
  }
  const counts = zeroCounts();
  for (const key of COUNT_KEYS) {
    const number = source[key];
    if (
      !Number.isSafeInteger(number) ||
      (number as number) < 0 ||
      (number as number) > 100_000_000
    ) {
      throw new Error("AUTONOMY_WAKE_RECEIPT_SUMMARY_INVALID");
    }
    counts[key] = number as AutonomyWorkerCounts[typeof key];
  }
  return counts;
}

function normalizedTask(value: unknown): WorkerTaskResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AUTONOMY_WAKE_RECEIPT_SUMMARY_INVALID");
  }
  const task = value as Record<string, unknown>;
  if (
    typeof task.courseAlias !== "string" ||
    !SAFE_ALIAS_PATTERN.test(task.courseAlias) ||
    typeof task.scheduledFor !== "string" ||
    !Number.isFinite(new Date(task.scheduledFor).getTime()) ||
    typeof task.mode !== "string" ||
    !SAFE_MODES.has(task.mode) ||
    typeof task.status !== "string" ||
    !SAFE_TASK_STATUSES.has(task.status) ||
    typeof task.reasonCode !== "string" ||
    !SAFE_REASON_CODE_PATTERN.test(task.reasonCode) ||
    task.containsForumText !== false
  ) {
    throw new Error("AUTONOMY_WAKE_RECEIPT_SUMMARY_INVALID");
  }
  return {
    courseAlias: task.courseAlias,
    scheduledFor: new Date(task.scheduledFor).toISOString(),
    mode: task.mode,
    status: task.status as WorkerTaskResult["status"],
    reasonCode: task.reasonCode,
    containsForumText: false
  };
}

function normalizeSummary(summary: AutonomyWorkerSummary): {
  summary: AutonomyWorkerSummary;
  countsJson: string;
  taskSetHash: string;
  summaryHash: string;
  exitCode: 0 | 1 | 2;
} {
  if (!summary || typeof summary !== "object") {
    throw new Error("AUTONOMY_WAKE_RECEIPT_SUMMARY_INVALID");
  }
  if (
    summary.schemaVersion !== AUTONOMY_WORKER_SCHEMA_VERSION ||
    summary.containsForumText !== false ||
    typeof summary.sourceTruncated !== "boolean" ||
    !["completed", "attention", "failed"].includes(summary.status) ||
    (summary.status === "completed" &&
      summary.reasonCode !== "worker_cycle_completed") ||
    (summary.status === "attention" &&
      summary.reasonCode !== "worker_cycle_attention") ||
    (summary.status === "failed" &&
      summary.reasonCode !== "worker_cycle_failed") ||
    !Array.isArray(summary.tasks) ||
    summary.tasks.length > 100
  ) {
    throw new Error("AUTONOMY_WAKE_RECEIPT_SUMMARY_INVALID");
  }
  assertNoUnsafeStrings(summary);
  const counts = normalizedCounts(summary.counts);
  const tasks = summary.tasks.map(normalizedTask);
  const taskCounts = {
    executed: tasks.filter((task) => task.status === "executed").length,
    skipped: tasks.filter((task) => task.status === "skipped").length,
    failed: tasks.filter((task) => task.status === "failed").length
  };
  // The worker's per-task counters must agree with the redacted task list.
  // Cycle-level query failures are represented by dueQueryFailed and do not
  // create a task, but they must not be smuggled in as a task failure count.
  if (
    counts.executed !== taskCounts.executed ||
    counts.skipped !== taskCounts.skipped ||
    counts.failed !== taskCounts.failed ||
    counts.considered !== tasks.length ||
    counts.due < counts.considered ||
    counts.executed > tasks.length ||
    counts.skipped > tasks.length ||
    counts.failed > tasks.length ||
    counts.reconciled + counts.reconcileFailed > counts.executed
  ) {
    throw new Error("AUTONOMY_WAKE_RECEIPT_SUMMARY_INVALID");
  }
  const expectedFailed =
    counts.failed > 0 || counts.dueQueryFailed > 0;
  const expectedAttention =
    !expectedFailed &&
    (counts.recoveryFailed > 0 ||
      counts.remainingExpired > 0 ||
      counts.governanceFiltered > 0 ||
      counts.reconcileFailed > 0 ||
      summary.sourceTruncated);
  const expectedStatus = expectedFailed
    ? "failed"
    : expectedAttention
      ? "attention"
      : "completed";
  const expectedReasonCode =
    expectedStatus === "failed"
      ? "worker_cycle_failed"
      : expectedStatus === "attention"
        ? "worker_cycle_attention"
        : "worker_cycle_completed";
  if (
    summary.status !== expectedStatus ||
    summary.reasonCode !== expectedReasonCode
  ) {
    throw new Error("AUTONOMY_WAKE_RECEIPT_SUMMARY_INVALID");
  }
  const normalized = {
    schemaVersion: AUTONOMY_WORKER_SCHEMA_VERSION,
    status: summary.status,
    reasonCode: summary.reasonCode,
    counts,
    tasks,
    sourceTruncated: summary.sourceTruncated,
    containsForumText: false as const
  };
  const exitCode: 0 | 1 | 2 =
    summary.status === "completed"
      ? 0
      : summary.status === "attention"
        ? 2
        : 1;
  return {
    summary: normalized,
    countsJson: JSON.stringify(counts),
    taskSetHash: hashValue(
      "cmooc.autonomy-worker-task-set.v1",
      tasks
    ),
    summaryHash: hashValue(
      AUTONOMY_WORKER_WAKE_RECEIPT_SCHEMA_VERSION,
      normalized
    ),
    exitCode
  };
}

function runningHashes(input: {
  source: WorkerWakeSource;
  runtimeVersion: string;
  startedAt: Date;
}): { countsJson: string; taskSetHash: string; summaryHash: string } {
  const counts = zeroCounts();
  const runningSummary = {
    schemaVersion: AUTONOMY_WORKER_SCHEMA_VERSION,
    status: "running" as const,
    reasonCode: "worker_wake_running" as const,
    source: input.source,
    runtimeVersion: input.runtimeVersion,
    startedAt: input.startedAt.toISOString(),
    counts,
    tasks: [],
    sourceTruncated: false,
    containsForumText: false as const
  };
  return {
    countsJson: JSON.stringify(counts),
    taskSetHash: hashValue(
      "cmooc.autonomy-worker-task-set.v1",
      []
    ),
    summaryHash: hashValue(
      AUTONOMY_WORKER_WAKE_RECEIPT_SCHEMA_VERSION,
      runningSummary
    )
  };
}

function abandonedHashes(input: {
  source: string;
  runtimeVersion: string;
  startedAt: Date;
  finishedAt: Date;
}): { countsJson: string; taskSetHash: string; summaryHash: string } {
  const counts = zeroCounts();
  const taskSetHash = hashValue(
    "cmooc.autonomy-worker-task-set.v1",
    []
  );
  const abandonedSummary = {
    schemaVersion: AUTONOMY_WORKER_WAKE_RECEIPT_SCHEMA_VERSION,
    status: "abandoned" as const,
    reasonCode: "worker_wake_stale_abandoned" as const,
    source: input.source,
    runtimeVersion: input.runtimeVersion,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    counts,
    tasks: [],
    sourceTruncated: false,
    editorWriteCount: 0,
    publishAttemptCount: 0,
    realPublishEnabled: false,
    containsForumText: false as const
  };
  return {
    countsJson: JSON.stringify(counts),
    taskSetHash,
    summaryHash: hashValue(
      AUTONOMY_WORKER_WAKE_RECEIPT_SCHEMA_VERSION,
      abandonedSummary
    )
  };
}

export async function startWorkerWakeReceipt(input: {
  prisma: PrismaClient;
  source?: string;
  runtimeVersion?: string;
  now?: Date | string;
}): Promise<WorkerWakeReceiptHandle> {
  const source = validateSource(input.source);
  const runtimeVersion = validateRuntimeVersion(
    input.runtimeVersion
  );
  const now = validNow(input.now);
  const hashes = runningHashes({
    source,
    runtimeVersion,
    startedAt: now
  });
  const staleBefore = new Date(now.getTime() - STALE_WAKE_MS);
  const result = await input.prisma.$transaction(async (tx) => {
    const staleReceipts = await tx.autonomyWorkerWakeReceipt.findMany({
      where: {
        status: "running",
        startedAt: { lt: staleBefore }
      },
      select: {
        id: true,
        source: true,
        runtimeVersion: true,
        startedAt: true
      }
    });
    let abandonedCount = 0;
    for (const stale of staleReceipts) {
      const hashes = abandonedHashes({
        source: stale.source,
        runtimeVersion: stale.runtimeVersion,
        startedAt: stale.startedAt,
        finishedAt: now
      });
      const abandoned = await tx.autonomyWorkerWakeReceipt.updateMany({
        where: {
          id: stale.id,
          status: "running",
          startedAt: { lt: staleBefore }
        },
        data: {
          status: "abandoned",
          reasonCode: "worker_wake_stale_abandoned",
          exitCode: 1,
          countsJson: hashes.countsJson,
          taskSetHash: hashes.taskSetHash,
          summaryHash: hashes.summaryHash,
          editorWriteCount: 0,
          publishAttemptCount: 0,
          realPublishEnabled: false,
          containsForumText: false,
          finishedAt: now,
          updatedAt: now
        }
      });
      if (abandoned.count === 1) abandonedCount += 1;
    }
    const receipt = await tx.autonomyWorkerWakeReceipt.create({
      data: {
        source,
        runtimeVersion,
        startedAt: now,
        status: "running",
        reasonCode: "worker_wake_running",
        exitCode: null,
        countsJson: hashes.countsJson,
        sourceTruncated: false,
        taskSetHash: hashes.taskSetHash,
        summaryHash: hashes.summaryHash,
        editorWriteCount: 0,
        publishAttemptCount: 0,
        realPublishEnabled: false,
        containsForumText: false,
        updatedAt: now
      }
    });
    return {
      receipt,
      abandonedCount
    };
  });
  return {
    id: result.receipt.id,
    source,
    runtimeVersion,
    startedAt: result.receipt.startedAt,
    status: "running",
    abandonedStaleCount: result.abandonedCount
  };
}

export async function abandonStaleWorkerWakeReceipts(input: {
  prisma: PrismaClient;
  now?: Date | string;
  staleAfterMs?: number;
}): Promise<{ abandonedCount: number; containsForumText: false }> {
  const now = validNow(input.now);
  const staleAfterMs = input.staleAfterMs ?? STALE_WAKE_MS;
  if (
    !Number.isSafeInteger(staleAfterMs) ||
    staleAfterMs < 1 ||
    staleAfterMs > 30 * 24 * 60 * 60_000
  ) {
    throw new Error("AUTONOMY_WAKE_RECEIPT_STALE_WINDOW_INVALID");
  }
  const abandonedCount = await input.prisma.$transaction(async (tx) => {
    const staleBefore = new Date(now.getTime() - staleAfterMs);
    const staleReceipts = await tx.autonomyWorkerWakeReceipt.findMany({
      where: {
        status: "running",
        startedAt: { lt: staleBefore }
      },
      select: {
        id: true,
        source: true,
        runtimeVersion: true,
        startedAt: true
      }
    });
    let count = 0;
    for (const stale of staleReceipts) {
      const hashes = abandonedHashes({
        source: stale.source,
        runtimeVersion: stale.runtimeVersion,
        startedAt: stale.startedAt,
        finishedAt: now
      });
      const updated = await tx.autonomyWorkerWakeReceipt.updateMany({
        where: {
          id: stale.id,
          status: "running",
          startedAt: { lt: staleBefore }
        },
        data: {
          status: "abandoned",
          reasonCode: "worker_wake_stale_abandoned",
          exitCode: 1,
          countsJson: hashes.countsJson,
          taskSetHash: hashes.taskSetHash,
          summaryHash: hashes.summaryHash,
          editorWriteCount: 0,
          publishAttemptCount: 0,
          realPublishEnabled: false,
          containsForumText: false,
          finishedAt: now,
          updatedAt: now
        }
      });
      if (updated.count === 1) count += 1;
    }
    return count;
  });
  return {
    abandonedCount,
    containsForumText: false
  };
}

export async function finishWorkerWakeReceipt(input: {
  prisma: PrismaClient;
  receiptId: string;
  summary: AutonomyWorkerSummary;
  now?: Date | string;
}): Promise<{
  id: string;
  status: "completed" | "attention" | "failed";
  reasonCode: string;
  exitCode: number;
  finishedAt: Date;
  countsJson: string;
  sourceTruncated: boolean;
  taskSetHash: string;
  summaryHash: string;
  editorWriteCount: number;
  publishAttemptCount: number;
  realPublishEnabled: boolean;
  containsForumText: false;
}> {
  const now = validNow(input.now);
  if (
    typeof input.receiptId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.receiptId)
  ) {
    throw new Error("AUTONOMY_WAKE_RECEIPT_FINISH_CONFLICT");
  }
  const current = await input.prisma.autonomyWorkerWakeReceipt.findUnique({
    where: { id: input.receiptId },
    select: { status: true, startedAt: true }
  });
  if (
    !current ||
    current.status !== "running" ||
    current.startedAt.getTime() > now.getTime()
  ) {
    throw new Error("AUTONOMY_WAKE_RECEIPT_FINISH_CONFLICT");
  }
  const normalized = normalizeSummary(input.summary);
  const updated = await input.prisma.autonomyWorkerWakeReceipt.updateMany({
    where: {
      id: input.receiptId,
      status: "running",
      startedAt: { lte: now }
    },
    data: {
      status: normalized.summary.status,
      reasonCode: normalized.summary.reasonCode,
      exitCode: normalized.exitCode,
      countsJson: normalized.countsJson,
      sourceTruncated: normalized.summary.sourceTruncated,
      taskSetHash: normalized.taskSetHash,
      summaryHash: normalized.summaryHash,
      editorWriteCount: 0,
      publishAttemptCount: 0,
      realPublishEnabled: false,
      containsForumText: false,
      finishedAt: now,
      updatedAt: now
    }
  });
  if (updated.count !== 1) {
    throw new Error("AUTONOMY_WAKE_RECEIPT_FINISH_CONFLICT");
  }
  const receipt =
    await input.prisma.autonomyWorkerWakeReceipt.findUniqueOrThrow({
      where: { id: input.receiptId },
      select: {
        id: true,
        status: true,
        reasonCode: true,
        exitCode: true,
        finishedAt: true,
        countsJson: true,
        sourceTruncated: true,
        taskSetHash: true,
        summaryHash: true,
        editorWriteCount: true,
        publishAttemptCount: true,
        realPublishEnabled: true,
        containsForumText: true
      }
    });
  if (
    !["completed", "attention", "failed"].includes(receipt.status) ||
    typeof receipt.exitCode !== "number" ||
    !receipt.finishedAt ||
    receipt.containsForumText !== false
  ) {
    throw new Error("AUTONOMY_WAKE_RECEIPT_FINISH_CONFLICT");
  }
  return {
    ...receipt,
    status: receipt.status as "completed" | "attention" | "failed",
    exitCode: receipt.exitCode,
    finishedAt: receipt.finishedAt,
    containsForumText: false
  };
}

function emptyAggregate(): AutonomyWorkerCounts {
  return zeroCounts();
}

function parseCounts(value: string): AutonomyWorkerCounts | null {
  try {
    return normalizedCounts(JSON.parse(value));
  } catch {
    return null;
  }
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

type WorkerWakeReceiptProjection = {
  id: string;
  source: string;
  runtimeVersion: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: string;
  reasonCode: string;
  exitCode: number | null;
  countsJson: string;
  sourceTruncated: boolean;
  taskSetHash: string;
  summaryHash: string;
  editorWriteCount: number;
  publishAttemptCount: number;
  realPublishEnabled: boolean;
  containsForumText: boolean;
};

function emptyStatusCounts(): Record<WorkerWakeStatus, number> {
  return {
    running: 0,
    completed: 0,
    attention: 0,
    failed: 0,
    abandoned: 0
  };
}

function addCounts(
  aggregate: AutonomyWorkerCounts,
  counts: AutonomyWorkerCounts
): void {
  for (const key of COUNT_KEYS) {
    aggregate[key] += counts[key];
  }
}

function allCountsZero(counts: AutonomyWorkerCounts): boolean {
  return COUNT_KEYS.every((key) => counts[key] === 0);
}

function terminalCountsAreCoherent(
  counts: AutonomyWorkerCounts
): boolean {
  return (
    counts.considered ===
      counts.executed + counts.skipped + counts.failed &&
    counts.due >= counts.considered &&
    counts.reconciled + counts.reconcileFailed <= counts.executed
  );
}

function expectedTerminalStatus(input: {
  counts: AutonomyWorkerCounts;
  sourceTruncated: boolean;
}): "completed" | "attention" | "failed" {
  if (input.counts.failed > 0 || input.counts.dueQueryFailed > 0) {
    return "failed";
  }
  if (
    input.counts.recoveryFailed > 0 ||
    input.counts.remainingExpired > 0 ||
    input.counts.governanceFiltered > 0 ||
    input.counts.reconcileFailed > 0 ||
    input.sourceTruncated
  ) {
    return "attention";
  }
  return "completed";
}

/**
 * Checks only invariants that can be mechanically established from the
 * persisted projection. Terminal task bodies are intentionally not loaded,
 * so their hashes can be shape-checked but not recomputed here.
 */
function persistedReceiptContractIsValid(
  receipt: WorkerWakeReceiptProjection,
  now: Date
): boolean {
  if (
    !WORKER_WAKE_SOURCES.includes(
      receipt.source as WorkerWakeSource
    ) ||
    !SAFE_RUNTIME_VERSION_PATTERN.test(receipt.runtimeVersion) ||
    receipt.runtimeVersion.length > 64 ||
    receipt.editorWriteCount !== 0 ||
    receipt.publishAttemptCount !== 0 ||
    receipt.realPublishEnabled !== false ||
    receipt.containsForumText !== false
  ) {
    return false;
  }
  const counts = parseCounts(receipt.countsJson);
  if (!counts) return false;

  if (receipt.status === "running") {
    if (
      receipt.reasonCode !== "worker_wake_running" ||
      receipt.exitCode !== null ||
      receipt.finishedAt !== null ||
      receipt.sourceTruncated ||
      !allCountsZero(counts)
    ) {
      return false;
    }
    const expected = runningHashes({
      source: receipt.source as WorkerWakeSource,
      runtimeVersion: receipt.runtimeVersion,
      startedAt: receipt.startedAt
    });
    return (
      receipt.taskSetHash === expected.taskSetHash &&
      receipt.summaryHash === expected.summaryHash
    );
  }

  if (receipt.status === "abandoned") {
    if (
      receipt.reasonCode !== "worker_wake_stale_abandoned" ||
      receipt.exitCode !== 1 ||
      !receipt.finishedAt ||
      receipt.finishedAt < receipt.startedAt ||
      receipt.finishedAt > now ||
      receipt.sourceTruncated ||
      !allCountsZero(counts)
    ) {
      return false;
    }
    const expected = abandonedHashes({
      source: receipt.source,
      runtimeVersion: receipt.runtimeVersion,
      startedAt: receipt.startedAt,
      finishedAt: receipt.finishedAt
    });
    return (
      receipt.taskSetHash === expected.taskSetHash &&
      receipt.summaryHash === expected.summaryHash
    );
  }

  if (
    !["completed", "attention", "failed"].includes(
      receipt.status
    ) ||
    !receipt.finishedAt ||
    receipt.finishedAt < receipt.startedAt ||
    receipt.finishedAt > now ||
    !terminalCountsAreCoherent(counts) ||
    !SHA256_HEX_PATTERN.test(receipt.taskSetHash) ||
    !SHA256_HEX_PATTERN.test(receipt.summaryHash)
  ) {
    return false;
  }
  const expectedStatus = expectedTerminalStatus({
    counts,
    sourceTruncated: receipt.sourceTruncated
  });
  const expectedReasonCode =
    expectedStatus === "completed"
      ? "worker_cycle_completed"
      : expectedStatus === "attention"
        ? "worker_cycle_attention"
        : "worker_cycle_failed";
  const expectedExitCode =
    expectedStatus === "completed"
      ? 0
      : expectedStatus === "attention"
        ? 2
        : 1;
  return (
    receipt.status === expectedStatus &&
    receipt.reasonCode === expectedReasonCode &&
    receipt.exitCode === expectedExitCode
  );
}

function summarizeScopedReceipts(input: {
  source: WorkerWakeSource;
  runtimeVersion: string;
  receipts: WorkerWakeReceiptProjection[];
  now: Date;
  staleBefore: Date;
}): WorkerWakeScopedSoakStats {
  const statusCounts = emptyStatusCounts();
  const aggregate = emptyAggregate();
  const terminalStatuses = new Set<WorkerWakeStatus>([
    "completed",
    "attention",
    "failed",
    "abandoned"
  ]);
  let invalidCounts = false;
  let invalidMetadata = false;
  let staleRunningCount = 0;
  let maxAdjacentGapMs: number | null = null;

  for (let index = 0; index < input.receipts.length; index += 1) {
    const receipt = input.receipts[index];
    const status = receipt.status as WorkerWakeStatus;
    if (WORKER_WAKE_STATUSES.includes(status)) {
      statusCounts[status] += 1;
    } else {
      invalidMetadata = true;
    }
    if (
      receipt.status === "running" &&
      receipt.startedAt < input.staleBefore
    ) {
      staleRunningCount += 1;
    }
    const counts = parseCounts(receipt.countsJson);
    if (counts) {
      addCounts(aggregate, counts);
    } else {
      invalidCounts = true;
    }
    if (
      !SAFE_REASON_CODE_PATTERN.test(receipt.reasonCode) ||
      UNSAFE_STRING_PATTERN.test(receipt.reasonCode)
    ) {
      invalidMetadata = true;
    }
    if (index > 0) {
      const gap =
        receipt.startedAt.getTime() -
        input.receipts[index - 1].startedAt.getTime();
      maxAdjacentGapMs = Math.max(maxAdjacentGapMs ?? 0, gap);
    }
  }

  let consecutiveTerminalCount = 0;
  for (
    let index = input.receipts.length - 1;
    index >= 0;
    index -= 1
  ) {
    const status = input.receipts[index].status as WorkerWakeStatus;
    if (!terminalStatuses.has(status)) break;
    consecutiveTerminalCount += 1;
  }
  let consecutiveCompletedCount = 0;
  for (
    let index = input.receipts.length - 1;
    index >= 0;
    index -= 1
  ) {
    if (input.receipts[index].status !== "completed") break;
    consecutiveCompletedCount += 1;
  }
  const lastReceipt = input.receipts.at(-1);
  const lastStatus = lastReceipt?.status as WorkerWakeStatus | undefined;
  return {
    source: input.source,
    runtimeVersion: input.runtimeVersion,
    count: input.receipts.length,
    statusCounts,
    terminalCount:
      statusCounts.completed +
      statusCounts.attention +
      statusCounts.failed +
      statusCounts.abandoned,
    completedCount: statusCounts.completed,
    consecutiveTerminalCount,
    consecutiveCompletedCount,
    runningCount: statusCounts.running,
    staleRunningCount,
    firstStartedAt:
      input.receipts[0]?.startedAt.toISOString() ?? null,
    lastStartedAt: lastReceipt?.startedAt.toISOString() ?? null,
    lastStatus:
      lastStatus && WORKER_WAKE_STATUSES.includes(lastStatus)
        ? lastStatus
        : null,
    maxAdjacentGapMs,
    aggregate,
    invariants: {
      zeroEditorWriteCount: input.receipts.every(
        (receipt) => receipt.editorWriteCount === 0
      ),
      zeroPublishAttemptCount: input.receipts.every(
        (receipt) => receipt.publishAttemptCount === 0
      ),
      realPublishDisabled: input.receipts.every(
        (receipt) => receipt.realPublishEnabled === false
      ),
      noForumText:
        !invalidCounts &&
        !invalidMetadata &&
        input.receipts.every(
          (receipt) => receipt.containsForumText === false
        )
    },
    receiptContractValid: input.receipts.every((receipt) =>
      persistedReceiptContractIsValid(receipt, input.now)
    )
  };
}

export async function summarizeWorkerWakeReceipts(input: {
  prisma: PrismaClient;
  now?: Date | string;
  lookbackMs?: number;
}): Promise<WorkerWakeSoakSummary> {
  const now = validNow(input.now);
  const lookbackMs = input.lookbackMs ?? 7 * 24 * 60 * 60_000;
  if (
    !Number.isSafeInteger(lookbackMs) ||
    lookbackMs < 1 ||
    lookbackMs > 30 * 24 * 60 * 60_000
  ) {
    throw new Error("AUTONOMY_WAKE_RECEIPT_LOOKBACK_INVALID");
  }
  const lookbackStartedAt = new Date(now.getTime() - lookbackMs);
  const receipts = await input.prisma.autonomyWorkerWakeReceipt.findMany({
    where: {
      startedAt: {
        gte: lookbackStartedAt,
        lte: now
      }
    },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      source: true,
      startedAt: true,
      finishedAt: true,
      status: true,
      reasonCode: true,
      exitCode: true,
      runtimeVersion: true,
      countsJson: true,
      sourceTruncated: true,
      taskSetHash: true,
      summaryHash: true,
      editorWriteCount: true,
      publishAttemptCount: true,
      realPublishEnabled: true,
      containsForumText: true
    }
  });
  const sourceCounts: Record<WorkerWakeSource, number> = {
    codex_automation: 0,
    local_cli: 0,
    test: 0
  };
  const statusCounts = emptyStatusCounts();
  const sourceStats: Record<WorkerWakeSource, WorkerWakeSourceSoakStats> = {
    codex_automation: {
      count: 0,
      firstStartedAt: null,
      lastStartedAt: null,
      maxAdjacentGapMs: null
    },
    local_cli: {
      count: 0,
      firstStartedAt: null,
      lastStartedAt: null,
      maxAdjacentGapMs: null
    },
    test: {
      count: 0,
      firstStartedAt: null,
      lastStartedAt: null,
      maxAdjacentGapMs: null
    }
  };
  const previousStartedAtBySource = new Map<WorkerWakeSource, Date>();
  const scopedReceiptMap = new Map<
    string,
    {
      source: WorkerWakeSource;
      runtimeVersion: string;
      receipts: WorkerWakeReceiptProjection[];
    }
  >();
  const runtimeVersionCounts: Record<string, number> = {};
  const aggregate = emptyAggregate();
  const terminal = new Set<WorkerWakeStatus>([
    "completed",
    "attention",
    "failed",
    "abandoned"
  ]);
  const staleBefore = new Date(now.getTime() - STALE_WAKE_MS);
  let staleRunningCount = 0;
  let invalidCounts = false;
  let invalidMetadata = false;
  let maxAdjacentGapMs: number | null = null;
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index];
    const source = receipt.source as WorkerWakeSource;
    if (WORKER_WAKE_SOURCES.includes(source)) {
      sourceCounts[source] += 1;
      const stats = sourceStats[source];
      stats.count += 1;
      const startedAt = receipt.startedAt.toISOString();
      stats.firstStartedAt ??= startedAt;
      stats.lastStartedAt = startedAt;
      const previous = previousStartedAtBySource.get(source);
      if (previous) {
        const gap = receipt.startedAt.getTime() - previous.getTime();
        stats.maxAdjacentGapMs = Math.max(
          stats.maxAdjacentGapMs ?? 0,
          gap
        );
      }
      previousStartedAtBySource.set(source, receipt.startedAt);
    } else {
      invalidMetadata = true;
    }
    const status = receipt.status as WorkerWakeStatus;
    if (WORKER_WAKE_STATUSES.includes(status)) {
      statusCounts[status] += 1;
    } else {
      invalidMetadata = true;
    }
    if (
      !SAFE_RUNTIME_VERSION_PATTERN.test(receipt.runtimeVersion) ||
      receipt.runtimeVersion.length > 64
    ) {
      invalidMetadata = true;
    } else {
      runtimeVersionCounts[receipt.runtimeVersion] =
        (runtimeVersionCounts[receipt.runtimeVersion] ?? 0) + 1;
    }
    if (
      WORKER_WAKE_SOURCES.includes(source) &&
      SAFE_RUNTIME_VERSION_PATTERN.test(receipt.runtimeVersion) &&
      receipt.runtimeVersion.length <= 64
    ) {
      const scopeKey = `${source}\u0000${receipt.runtimeVersion}`;
      const scope = scopedReceiptMap.get(scopeKey) ?? {
        source,
        runtimeVersion: receipt.runtimeVersion,
        receipts: []
      };
      scope.receipts.push(receipt);
      scopedReceiptMap.set(scopeKey, scope);
    }
    if (
      receipt.status === "running" &&
      receipt.startedAt < staleBefore
    ) {
      staleRunningCount += 1;
    }
    const counts = parseCounts(receipt.countsJson);
    if (!counts) {
      invalidCounts = true;
    } else {
      addCounts(aggregate, counts);
    }
    if (
      !SAFE_REASON_CODE_PATTERN.test(receipt.reasonCode) ||
      UNSAFE_STRING_PATTERN.test(receipt.reasonCode)
    ) {
      invalidMetadata = true;
    }
    if (index > 0) {
      const gap =
        receipt.startedAt.getTime() -
        receipts[index - 1].startedAt.getTime();
      maxAdjacentGapMs = Math.max(maxAdjacentGapMs ?? 0, gap);
    }
  }
  let consecutiveTerminalCount = 0;
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const status = receipts[index].status as WorkerWakeStatus;
    if (!terminal.has(status)) break;
    consecutiveTerminalCount += 1;
  }
  let consecutiveCompletedCount = 0;
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    if (receipts[index].status !== "completed") break;
    consecutiveCompletedCount += 1;
  }
  const sourceOrder = new Map(
    WORKER_WAKE_SOURCES.map((source, index) => [source, index])
  );
  const scopedStats = [...scopedReceiptMap.values()]
    .sort((left, right) => {
      const sourceDifference =
        (sourceOrder.get(left.source) ?? Number.MAX_SAFE_INTEGER) -
        (sourceOrder.get(right.source) ?? Number.MAX_SAFE_INTEGER);
      if (sourceDifference !== 0) return sourceDifference;
      if (left.runtimeVersion < right.runtimeVersion) return -1;
      if (left.runtimeVersion > right.runtimeVersion) return 1;
      return 0;
    })
    .map((scope) =>
      summarizeScopedReceipts({
        ...scope,
        now,
        staleBefore
      })
    );
  const summaryWithoutHash = {
    schemaVersion:
      AUTONOMY_WORKER_WAKE_RECEIPT_SCHEMA_VERSION,
    asOf: now.toISOString(),
    lookbackMs,
    lookbackStartedAt: lookbackStartedAt.toISOString(),
    totalReceipts: receipts.length,
    sourceCounts,
    statusCounts,
    terminalCount:
      statusCounts.completed +
      statusCounts.attention +
      statusCounts.failed +
      statusCounts.abandoned,
    completedCount: statusCounts.completed,
    consecutiveTerminalCount,
    consecutiveCompletedCount,
    runningCount: statusCounts.running,
    staleRunningCount,
    firstStartedAt:
      receipts[0]?.startedAt.toISOString() ?? null,
    lastStartedAt:
      receipts[receipts.length - 1]?.startedAt.toISOString() ??
      null,
    maxAdjacentGapMs,
    sourceStats,
    scopedStats,
    runtimeVersionCounts,
    aggregate,
    invariants: {
      zeroEditorWriteCount: receipts.every(
        (receipt) => receipt.editorWriteCount === 0
      ),
      zeroPublishAttemptCount: receipts.every(
        (receipt) => receipt.publishAttemptCount === 0
      ),
      realPublishDisabled: receipts.every(
        (receipt) => receipt.realPublishEnabled === false
      ),
      noForumText:
        !invalidCounts &&
        !invalidMetadata &&
        receipts.every(
          (receipt) =>
            receipt.containsForumText === false &&
            receipt.sourceTruncated !== undefined
        )
    },
    receiptContractValid: receipts.every((receipt) =>
      persistedReceiptContractIsValid(receipt, now)
    ),
    containsForumText: false as const
  };
  return {
    ...summaryWithoutHash,
    evidenceHash: canonicalProtocolHash(
      AUTONOMY_WORKER_WAKE_RECEIPT_SCHEMA_VERSION,
      summaryWithoutHash as unknown as CanonicalJsonValue
    )
  };
}
