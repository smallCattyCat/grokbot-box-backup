import type { PrismaClient } from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  summarizeWorkerWakeReceipts,
  type WorkerWakeSoakSummary
} from "./worker-wake-receipt";
import {
  evaluateAutonomySoakReadiness,
  type AutonomySoakReadinessReceipt
} from "./soak-readiness";
import { REAL_FORUM_WRITE_LOCKED } from "@/lib/forum/real-write-lock";
import {
  verifyCourseOperationGovernanceRecord
} from "./course-operation-governance";
import {
  loadAnyCourseManifest,
  type CourseManifest
} from "./course-manifest";

export const AUTONOMY_RUNTIME_HEALTH_SCHEMA_VERSION =
  "cmooc.autonomy-runtime-health.v2" as const;
export const AUTONOMY_DUE_INVOCATIONS_SCHEMA_VERSION =
  "cmooc.autonomy-due-invocations.v1" as const;
export const AUTONOMY_LEASE_RECOVERY_SCHEMA_VERSION =
  "cmooc.autonomy-lease-recovery.v1" as const;

const DAY_MS = 24 * 60 * 60_000;

// Enabled schedules are read in stable keyset pages.  Keeping this bound on
// every database call avoids the old one-shot window where rows after the
// first 500 could never enter the due queue.
const ENABLED_SCHEDULE_PAGE_SIZE = 500;

type EnabledScheduleRow = {
  id: string;
  courseAlias: string;
  mode: string;
  intervalMinutes: number;
  nextRunAt: Date | null;
  updatedAt: Date;
};

type EnabledSchedulePageCursor = {
  updatedAt: Date;
  id: string;
};

/**
 * Visit every enabled schedule through bounded, deterministic keyset pages.
 * The callback receives one page at a time; callers must not rely on an
 * unbounded in-memory schedule array.  `updatedAt` is ordered with `id` as a
 * tie-breaker so equal timestamps cannot hide the later rows.
 */
async function forEachEnabledSchedulePage(
  prisma: PrismaClient,
  onPage: (schedules: EnabledScheduleRow[]) => Promise<void>
): Promise<void> {
  let cursor: EnabledSchedulePageCursor | null = null;
  while (true) {
    const schedules: EnabledScheduleRow[] =
      await prisma.operationSchedule.findMany({
        where:
          cursor === null
            ? { enabled: true }
            : {
                enabled: true,
                OR: [
                  { updatedAt: { lt: cursor.updatedAt } },
                  {
                    updatedAt: cursor.updatedAt,
                    id: { lt: cursor.id }
                  }
                ]
              },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: ENABLED_SCHEDULE_PAGE_SIZE,
        select: {
          id: true,
          courseAlias: true,
          mode: true,
          intervalMinutes: true,
          nextRunAt: true,
          updatedAt: true
        }
      });
    if (schedules.length === 0) return;

    await onPage(schedules);
    if (schedules.length < ENABLED_SCHEDULE_PAGE_SIZE) return;

    const tail: EnabledScheduleRow = schedules[schedules.length - 1];
    const nextCursor: EnabledSchedulePageCursor = {
      updatedAt: tail.updatedAt,
      id: tail.id
    };
    if (
      cursor !== null &&
      cursor.id === nextCursor.id &&
      cursor.updatedAt.getTime() === nextCursor.updatedAt.getTime()
    ) {
      // A broken adapter returning the same full page would otherwise spin
      // forever.  Failing the read is safer than silently claiming coverage.
      throw new Error("AUTONOMY_SCHEDULE_PAGE_CURSOR_STALLED");
    }
    cursor = nextCursor;
  }
}

export type WorkerWakeRuntimeDisposition =
  | "healthy"
  | "attention"
  | "halted";

export function classifyWorkerWakeRuntimeDisposition(input: {
  soakReadiness: Pick<
    AutonomySoakReadinessReceipt,
    "status" | "checks"
  >;
  enabledScheduleCount: number;
}): WorkerWakeRuntimeDisposition {
  const safetyCheckIds = new Set([
    "zero_editor_writes",
    "zero_publish_attempts",
    "real_publish_disabled",
    "no_forum_text"
  ]);
  const safetyBoundaryFailed = input.soakReadiness.checks.some(
    (check) =>
      safetyCheckIds.has(check.id) && check.status === "failed"
  );
  if (safetyBoundaryFailed) {
    return "halted";
  }
  if (
    input.soakReadiness.status === "blocked" ||
    (input.enabledScheduleCount > 0 &&
      input.soakReadiness.status === "unknown")
  ) {
    return "attention";
  }
  return "healthy";
}

export type DueInvocationDescriptor = {
  courseAlias: string;
  scheduleId: string;
  manifestHash: string;
  mode: string;
  scheduledFor: string;
  scheduleIntervalMinutes: number;
  governancePolicyId?: string;
  governanceVersion?: string;
  governanceHash?: string;
  governanceLimits?: {
    dailySlotLimit: number;
    perTickActionLimit: number;
    authorTouchLimit30d: number;
    intervalMinutes: number;
  };
  state:
    | "runnable"
    | "lease_busy"
    | "lease_recovery_required";
  containsForumText: false;
};

function validDate(value: Date, label: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`${label}必须是有效时间。`);
  }
  return value;
}

function positiveIntervalMs(intervalMinutes: number): number {
  if (
    !Number.isSafeInteger(intervalMinutes) ||
    intervalMinutes < 1 ||
    intervalMinutes > 7 * 24 * 60
  ) {
    throw new Error("自治调度间隔必须是 1 分钟到 7 天之间的整数。");
  }
  return intervalMinutes * 60_000;
}

function floorToInterval(value: Date, intervalMs: number): Date {
  return new Date(
    Math.floor(value.getTime() / intervalMs) * intervalMs
  );
}

/**
 * Returns the newest due cadence slot and intentionally collapses missed
 * slots. A restarted worker therefore resumes with one current invocation
 * rather than replaying an unbounded backlog.
 */
export function latestDueScheduledFor(input: {
  now: Date;
  intervalMinutes: number;
  nextRunAt: Date | null;
  latestScheduledFor: Date | null;
  latestStatus?: string | null;
}): Date | null {
  const now = validDate(new Date(input.now), "当前时间");
  const intervalMs = positiveIntervalMs(
    input.intervalMinutes
  );
  const latest = input.latestScheduledFor
    ? validDate(
        new Date(input.latestScheduledFor),
        "最近运行时间"
      )
    : null;
  const configured = input.nextRunAt
    ? validDate(
        new Date(input.nextRunAt),
        "下次运行时间"
      )
    : null;

  // Non-terminal cadence rows are retried in place. Advancing from a
  // failed/abandoned/pending row would make recovery skip the exact
  // idempotency slot that still needs to finish.
  if (
    latest &&
    input.latestStatus !== undefined &&
    input.latestStatus !== null &&
    input.latestStatus !== "completed"
  ) {
    return latest.getTime() <= now.getTime() ? latest : null;
  }

  let candidate: Date;
  if (latest) {
    candidate = new Date(latest.getTime() + intervalMs);
    if (
      configured &&
      configured.getTime() > candidate.getTime()
    ) {
      candidate = configured;
    }
  } else {
    candidate =
      configured ?? floorToInterval(now, intervalMs);
  }
  if (candidate.getTime() > now.getTime()) return null;

  const missedIntervals = Math.floor(
    (now.getTime() - candidate.getTime()) / intervalMs
  );
  return new Date(
    candidate.getTime() + missedIntervals * intervalMs
  );
}

export async function listDueAutonomyInvocations(input: {
  prisma: PrismaClient;
  now?: Date;
  limit?: number;
  /** Test fixtures may inject an isolated manifest; production uses disk. */
  resolveManifest?: (alias: string) => Promise<CourseManifest>;
}): Promise<{
  schemaVersion:
    typeof AUTONOMY_DUE_INVOCATIONS_SCHEMA_VERSION;
  asOf: string;
  due: DueInvocationDescriptor[];
  truncated: boolean;
  governanceFilteredCount: number;
  containsForumText: false;
}> {
  const now = validDate(
    new Date(input.now ?? new Date()),
    "调度查询时间"
  );
  const limit = Math.min(
    100,
    Math.max(1, Math.trunc(input.limit ?? 25))
  );
  const resolveManifest =
    input.resolveManifest ?? ((alias: string) => loadAnyCourseManifest(alias));
  const manifests = await input.prisma.autonomyCourseManifest.findMany({
    where: { enabled: true },
    select: { alias: true, manifestHash: true }
  });
  const manifestHashByAlias = new Map(
    manifests.map((manifest) => [
      manifest.alias,
      manifest.manifestHash
    ])
  );
  const enabledAliases = new Set(
    manifests.map((manifest) => manifest.alias)
  );
  const manifestByAlias = new Map<string, CourseManifest>();
  await Promise.all(
    manifests.map(async (manifestRow) => {
      try {
        const manifest = await resolveManifest(manifestRow.alias);
        if (
          manifest.alias !== manifestRow.alias ||
          manifest.manifestHash !== manifestRow.manifestHash ||
          manifest.realPublishEnabled !== false
        ) {
          return;
        }
        manifestByAlias.set(manifestRow.alias, manifest);
      } catch {
        // Missing or malformed disk manifests are fail-closed.
      }
    })
  );
  const governanceRows =
    enabledAliases.size === 0
      ? []
      : await input.prisma.courseOperationGovernancePolicy.findMany({
          where: { courseAlias: { in: [...enabledAliases] } },
          orderBy: [
            { courseAlias: "asc" },
            { createdAt: "desc" },
            { id: "desc" }
          ],
          select: {
            id: true,
            courseAlias: true,
            version: true,
            baseManifestHash: true,
            status: true,
            mode: true,
            dailySlotLimit: true,
            perTickActionLimit: true,
            authorTouchLimit30d: true,
            minIntervalMinutes: true,
            validFrom: true,
            validUntil: true,
            emergencyHalt: true,
            governanceHash: true,
            containsForumText: true
          }
        });
  const governanceByAlias = new Map<string, (typeof governanceRows)[number]>();
  for (const row of governanceRows) {
    if (row.validFrom > now) continue;
    if (!governanceByAlias.has(row.courseAlias)) {
      governanceByAlias.set(row.courseAlias, row);
    }
  }

  let governanceFilteredCount = 0;

  // A manifest change can leave an older schedule row behind. A duplicate
  // enabled row for one course/mode is ambiguous, so fail closed instead of
  // arbitrarily selecting one. Detect duplicates in a first bounded pass;
  // the second pass can then release each page without retaining the table.
  const seenScheduleAliases = new Set<string>();
  const duplicateScheduleAliases = new Set<string>();
  await forEachEnabledSchedulePage(input.prisma, async (schedules) => {
    for (const schedule of schedules) {
      if (!enabledAliases.has(schedule.courseAlias)) continue;
      if (seenScheduleAliases.has(schedule.courseAlias)) {
        if (!duplicateScheduleAliases.has(schedule.courseAlias)) {
          duplicateScheduleAliases.add(schedule.courseAlias);
          governanceFilteredCount += 1;
        }
      } else {
        seenScheduleAliases.add(schedule.courseAlias);
      }
    }
  });

  const due: DueInvocationDescriptor[] = [];
  let dueOverflowed = false;
  const compareDue = (
    left: DueInvocationDescriptor,
    right: DueInvocationDescriptor
  ): number =>
    left.scheduledFor.localeCompare(right.scheduledFor) ||
    left.courseAlias.localeCompare(right.courseAlias) ||
    left.mode.localeCompare(right.mode);
  const retainDue = (candidate: DueInvocationDescriptor): void => {
    due.push(candidate);
    due.sort(compareDue);
    if (due.length > limit) {
      due.pop();
      dueOverflowed = true;
    }
  };

  // Re-read the same keyset pages so invocation state is also bounded to one
  // page.  The first pass has already established which course aliases are
  // unambiguous, preserving the previous fail-closed duplicate behavior.
  await forEachEnabledSchedulePage(input.prisma, async (schedules) => {
    const currentSchedules = schedules.filter(
      (schedule) =>
        enabledAliases.has(schedule.courseAlias) &&
        !duplicateScheduleAliases.has(schedule.courseAlias)
    );
    if (currentSchedules.length === 0) return;

    const currentScheduleIds = currentSchedules.map(
      (schedule) => schedule.id
    );
    const invocations =
      await input.prisma.scheduledInvocation.findMany({
        where: { scheduleId: { in: currentScheduleIds } },
        orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
        select: {
          id: true,
          courseAlias: true,
          scheduleId: true,
          mode: true,
          status: true,
          scheduledFor: true,
          leaseExpiresAt: true
        }
      });
    const latestBySchedule = new Map<
      string,
      (typeof invocations)[number]
    >();
    const activeByCourse = new Map<
      string,
      { live: boolean; recoverable: boolean }
    >();
    const scheduleById = new Map(
      currentSchedules.map((schedule) => [schedule.id, schedule])
    );
    for (const invocation of invocations) {
      if (
        !invocation.scheduleId ||
        !scheduleById.has(invocation.scheduleId) ||
        scheduleById.get(invocation.scheduleId)?.courseAlias !==
          invocation.courseAlias ||
        scheduleById.get(invocation.scheduleId)?.mode !== invocation.mode
      ) {
        // Legacy null schedule ids and malformed mode bindings are preserved as
        // evidence but can never block a current cadence.
        continue;
      }
      if (!latestBySchedule.has(invocation.scheduleId)) {
        latestBySchedule.set(invocation.scheduleId, invocation);
      }
      if (invocation.status === "running") {
        const state =
          activeByCourse.get(invocation.courseAlias) ?? {
            live: false,
            recoverable: false
          };
        if (
          !invocation.leaseExpiresAt ||
          invocation.leaseExpiresAt.getTime() < now.getTime()
        ) {
          state.recoverable = true;
        } else {
          state.live = true;
        }
        activeByCourse.set(invocation.courseAlias, state);
      }
    }

    for (const schedule of currentSchedules) {
      const manifestHash = manifestHashByAlias.get(schedule.courseAlias);
      const manifest = manifestByAlias.get(schedule.courseAlias);
      const governance = governanceByAlias.get(schedule.courseAlias);
      let verifiedGovernance:
        | ReturnType<typeof verifyCourseOperationGovernanceRecord>
        | null = null;
      if (manifest && governance) {
        try {
          verifiedGovernance = verifyCourseOperationGovernanceRecord(
            governance as any,
            manifest
          );
        } catch {
          verifiedGovernance = null;
        }
      }
      if (
        !manifestHash ||
        !manifest ||
        !governance ||
        !verifiedGovernance ||
        manifest.manifestHash !== manifestHash ||
        verifiedGovernance.policy.status !== "active" ||
        verifiedGovernance.policy.emergencyHalt ||
        verifiedGovernance.policy.mode !== schedule.mode ||
        Date.parse(verifiedGovernance.policy.validFrom) > now.getTime() ||
        Date.parse(verifiedGovernance.policy.validUntil) <= now.getTime()
      ) {
        governanceFilteredCount += 1;
        continue;
      }
      const effectiveIntervalMinutes = Math.max(
        schedule.intervalMinutes,
        verifiedGovernance.effectiveLimits.intervalMinutes
      );
      const latest = latestBySchedule.get(schedule.id);
      const scheduledFor = latestDueScheduledFor({
        now,
        intervalMinutes: effectiveIntervalMinutes,
        nextRunAt: schedule.nextRunAt,
        latestScheduledFor: latest?.scheduledFor ?? null,
        latestStatus: latest?.status ?? null
      });
      if (!scheduledFor) continue;
      const legacySlotCollision =
        await input.prisma.scheduledInvocation.findFirst({
          where: {
            courseAlias: schedule.courseAlias,
            mode: schedule.mode,
            scheduledFor,
            OR: [
              { scheduleId: null },
              { scheduleId: { not: schedule.id } }
            ]
          },
          select: { id: true }
        });
      if (legacySlotCollision) {
        // The legacy course/mode/time unique key would reject a new bound row.
        // Preserve the old evidence and wait for the next cadence instead of
        // emitting a task that will fail forever in this exact slot.
        governanceFilteredCount += 1;
        continue;
      }
      const active = activeByCourse.get(schedule.courseAlias);
      const state: DueInvocationDescriptor["state"] =
        active?.live
          ? "lease_busy"
          : active?.recoverable
            ? "lease_recovery_required"
            : "runnable";
      retainDue({
        courseAlias: schedule.courseAlias,
        scheduleId: schedule.id,
        manifestHash,
        mode: schedule.mode,
        scheduledFor: scheduledFor.toISOString(),
        scheduleIntervalMinutes: effectiveIntervalMinutes,
        governancePolicyId: verifiedGovernance.record.id,
        governanceVersion: verifiedGovernance.policy.version,
        governanceHash: verifiedGovernance.governanceHash,
        governanceLimits: {
          dailySlotLimit: verifiedGovernance.effectiveLimits.dailySlotLimit,
          perTickActionLimit:
            verifiedGovernance.effectiveLimits.perTickActionLimit,
          authorTouchLimit30d:
            verifiedGovernance.effectiveLimits.authorTouchLimit30d,
          intervalMinutes: verifiedGovernance.effectiveLimits.intervalMinutes
        },
        state,
        containsForumText: false
      });
    }
  });
  due.sort(compareDue);
  return {
    schemaVersion:
      AUTONOMY_DUE_INVOCATIONS_SCHEMA_VERSION,
    asOf: now.toISOString(),
    due,
    truncated: dueOverflowed,
    governanceFilteredCount,
    containsForumText: false
  };
}

export async function recoverExpiredInvocationLeases(input: {
  prisma: PrismaClient;
  now?: Date;
  limit?: number;
}): Promise<{
  schemaVersion:
    typeof AUTONOMY_LEASE_RECOVERY_SCHEMA_VERSION;
  asOf: string;
  recoveredCount: number;
  remainingExpiredCount: number;
  evidenceHash: string;
  containsForumText: false;
}> {
  const now = validDate(
    new Date(input.now ?? new Date()),
    "租约恢复时间"
  );
  const limit = Math.min(
    100,
    Math.max(1, Math.trunc(input.limit ?? 25))
  );
  const expired =
    await input.prisma.scheduledInvocation.findMany({
      where: {
        status: "running",
        OR: [
          { leaseExpiresAt: { lt: now } },
          { leaseExpiresAt: null }
        ]
      },
      orderBy: { leaseExpiresAt: "asc" },
      take: limit,
      select: {
        id: true,
        courseAlias: true,
        scheduledFor: true,
        phase: true,
        attempt: true,
        leaseExpiresAt: true
      }
    });
  let recoveredCount = 0;
  for (const invocation of expired) {
    const evidenceHash = canonicalProtocolHash(
      "cmooc.expired-invocation-lease.v1",
      {
        invocationId: invocation.id,
        courseAlias: invocation.courseAlias,
        scheduledFor:
          invocation.scheduledFor.toISOString(),
        expiredAt:
          invocation.leaseExpiresAt?.toISOString() ??
          null,
        recoveredAt: now.toISOString(),
        containsForumText: false
      }
    );
    const recovered = await input.prisma.$transaction(
      async (tx) => {
        const updated =
          await tx.scheduledInvocation.updateMany({
            where: {
              id: invocation.id,
              status: "running",
              OR: [
                { leaseExpiresAt: { lt: now } },
                { leaseExpiresAt: null }
              ]
            },
            data: {
              status: "abandoned",
              phase: "lease_expired_recovered",
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: now,
              finishedAt: now,
              summaryJson: JSON.stringify({
                schemaVersion:
                  "cmooc.invocation-summary.v1",
                status: "abandoned",
                reasonCode: "lease_expired",
                previousPhase: invocation.phase,
                attempt: invocation.attempt,
                containsForumText: false
              })
            }
          });
        if (updated.count !== 1) return false;
        await tx.autonomyIncident.create({
          data: {
            courseAlias: invocation.courseAlias,
            invocationId: invocation.id,
            severity: "medium",
            code: "invocation_lease_expired",
            status: "resolved",
            evidenceHash,
            summaryJson: JSON.stringify({
              schemaVersion:
                "cmooc.autonomy-incident-summary.v1",
              code: "invocation_lease_expired",
              recovery:
                "marked_abandoned_for_safe_reacquire",
              containsForumText: false
            }),
            openedAt:
              invocation.leaseExpiresAt ?? now,
            resolvedAt: now
          }
        });
        return true;
      }
    );
    if (recovered) recoveredCount += 1;
  }
  const remainingExpiredCount =
    await input.prisma.scheduledInvocation.count({
      where: {
        status: "running",
        OR: [
          { leaseExpiresAt: { lt: now } },
          { leaseExpiresAt: null }
        ]
      }
    });
  const evidenceHash = canonicalProtocolHash(
    AUTONOMY_LEASE_RECOVERY_SCHEMA_VERSION,
    {
      asOf: now.toISOString(),
      recoveredCount,
      remainingExpiredCount,
      containsForumText: false
    }
  );
  return {
    schemaVersion:
      AUTONOMY_LEASE_RECOVERY_SCHEMA_VERSION,
    asOf: now.toISOString(),
    recoveredCount,
    remainingExpiredCount,
    evidenceHash,
    containsForumText: false
  };
}

export async function getAutonomyRuntimeHealth(input: {
  prisma: PrismaClient;
  now?: Date;
  resolveManifest?: (alias: string) => Promise<CourseManifest>;
}): Promise<{
  schemaVersion:
    typeof AUTONOMY_RUNTIME_HEALTH_SCHEMA_VERSION;
  asOf: string;
  status: "healthy" | "attention" | "halted";
  externalWriteLockIntact: boolean;
  manifests: {
    enabled: number;
    publishEnabled: number;
  };
  schedules: {
    enabled: number;
    due: number;
    runnable: number;
    missingForEnabledManifest: number;
  };
  invocations: {
    running: number;
    expiredLease: number;
    failedLast24h: number;
    lastCompletedAt: string | null;
  };
  outcomes: {
    pending: number;
    overdue: number;
    observed: number;
    censored: number;
  };
  incidents: {
    open: number;
    acknowledged: number;
    unresolved: number;
    unresolvedHighOrCritical: number;
  };
  governance: {
    total: number;
    active: number;
    paused: number;
    revoked: number;
    emergencyHalt: number;
    missingForEnabledManifest: number;
    dueFiltered: number;
  };
  workerWake: WorkerWakeSoakSummary;
  soakReadiness: AutonomySoakReadinessReceipt;
  evidenceHash: string;
  containsForumText: false;
}> {
  const now = validDate(
    new Date(input.now ?? new Date()),
    "健康摘要时间"
  );
  const lastDay = new Date(now.getTime() - DAY_MS);
  const due = await listDueAutonomyInvocations({
    prisma: input.prisma,
    now,
    limit: 100,
    resolveManifest: input.resolveManifest
  });
  const enabledManifests = await input.prisma.autonomyCourseManifest.findMany({
    where: { enabled: true },
    select: {
      alias: true,
      manifestHash: true,
      realPublishEnabled: true
    }
  });
  const enabledManifestAliases = new Set(
    enabledManifests.map((manifest) => manifest.alias)
  );
  const enabledCourseAliases = [...enabledManifestAliases];
  const publishEnabledManifestCount = enabledManifests.filter(
    (manifest) => manifest.realPublishEnabled
  ).length;
  const [
    enabledSchedules,
    forumPublishEnabledCount,
    activeRealPolicyCount,
    runningInvocationCount,
    expiredLeaseCount,
    failedLast24hCount,
    latestCompleted,
    pendingOutcomeCount,
    overdueOutcomeCount,
    observedOutcomeCount,
    censoredOutcomeCount,
    unresolvedIncidentRows,
    emergencyPolicyCount,
    livePermitCount,
    workerWake,
    governanceRows
  ] = await Promise.all([
    input.prisma.operationSchedule.findMany({
      where: {
        enabled: true,
        courseAlias: { in: enabledCourseAliases }
      },
      select: { id: true, courseAlias: true, mode: true }
    }),
    input.prisma.forumSetting.count({
      where: { realPublishEnabled: true }
    }),
    input.prisma.autonomyPolicy.count({
      where: {
        status: "active",
        realPublishEnabled: true,
        revokedAt: null,
        validFrom: { lte: now },
        validUntil: { gte: now }
      }
    }),
    input.prisma.scheduledInvocation.count({
      where: {
        courseAlias: { in: enabledCourseAliases },
        status: "running"
      }
    }),
    input.prisma.scheduledInvocation.count({
      where: {
        courseAlias: { in: enabledCourseAliases },
        status: "running",
        OR: [
          { leaseExpiresAt: { lt: now } },
          { leaseExpiresAt: null }
        ]
      }
    }),
    input.prisma.scheduledInvocation.count({
      where: {
        courseAlias: { in: enabledCourseAliases },
        status: "failed",
        finishedAt: { gte: lastDay, lte: now }
      }
    }),
    input.prisma.scheduledInvocation.findFirst({
      where: {
        courseAlias: { in: enabledCourseAliases },
        status: "completed",
        finishedAt: { not: null, lte: now }
      },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true }
    }),
    input.prisma.proximalOutcome.count({
      where: {
        status: "pending",
        decision: { courseAlias: { in: enabledCourseAliases } }
      }
    }),
    input.prisma.proximalOutcome.count({
      where: {
        status: "pending",
        dueAt: { lte: now },
        decision: { courseAlias: { in: enabledCourseAliases } }
      }
    }),
    input.prisma.proximalOutcome.count({
      where: {
        status: "observed",
        censored: false,
        decision: { courseAlias: { in: enabledCourseAliases } }
      }
    }),
    input.prisma.proximalOutcome.count({
      where: {
        censored: true,
        decision: { courseAlias: { in: enabledCourseAliases } }
      }
    }),
    input.prisma.autonomyIncident.findMany({
      where: {
        courseAlias: { in: enabledCourseAliases },
        status: { in: ["open", "acknowledged"] }
      },
      select: {
        courseAlias: true,
        severity: true,
        status: true
      }
    }),
    input.prisma.autonomyPolicy.count({
      where: {
        courseAlias: { in: enabledCourseAliases },
        status: "active",
        emergencyHalt: true,
        revokedAt: null,
        validFrom: { lte: now },
        validUntil: { gte: now }
      }
    }),
    input.prisma.executionPermit.count({
      where: {
        realPublishEnabled: true,
        status: { in: ["issued", "active"] },
        revokedAt: null,
        expiresAt: { gte: now }
      }
    }),
    summarizeWorkerWakeReceipts({
      prisma: input.prisma,
      now
    }),
    input.prisma.courseOperationGovernancePolicy.findMany({
      where: { courseAlias: { in: enabledCourseAliases } },
      orderBy: [
        { courseAlias: "asc" },
        { createdAt: "desc" },
        { id: "desc" }
      ],
      select: {
        id: true,
        courseAlias: true,
        version: true,
        baseManifestHash: true,
        status: true,
        mode: true,
        dailySlotLimit: true,
        perTickActionLimit: true,
        authorTouchLimit30d: true,
        minIntervalMinutes: true,
        emergencyHalt: true,
        validFrom: true,
        validUntil: true,
        governanceHash: true,
        containsForumText: true
      }
    })
  ]);
  const externalWriteLockIntact =
    REAL_FORUM_WRITE_LOCKED === true &&
    publishEnabledManifestCount === 0 &&
    forumPublishEnabledCount === 0 &&
    activeRealPolicyCount === 0 &&
      livePermitCount === 0;
  const enabledManifestCount = enabledManifests.length;
  // Runtime health is the health of the currently enabled product surface.
  // Disabled test fixtures and retired courses remain preserved as audit
  // evidence, but cannot keep the active worker or its soak qualification red.
  const activeUnresolvedIncidentRows = unresolvedIncidentRows.filter((incident) =>
    enabledManifestAliases.has(incident.courseAlias)
  );
  const openIncidentCount = activeUnresolvedIncidentRows.filter(
    (incident) => incident.status === "open"
  ).length;
  const acknowledgedIncidentCount = activeUnresolvedIncidentRows.filter(
    (incident) => incident.status === "acknowledged"
  ).length;
  const unresolvedIncidentCount = activeUnresolvedIncidentRows.length;
  const unresolvedHighIncidentCount = activeUnresolvedIncidentRows.filter(
    (incident) => ["high", "critical"].includes(incident.severity)
  ).length;
  const enabledScheduleAliases = new Set(
    enabledSchedules
      .filter((schedule) => enabledManifestAliases.has(schedule.courseAlias))
      .map((schedule) => schedule.courseAlias)
  );
  const missingEnabledScheduleCount = enabledManifests.filter(
    (manifest) => !enabledScheduleAliases.has(manifest.alias)
  ).length;
  const resolveManifest =
    input.resolveManifest ?? ((alias: string) => loadAnyCourseManifest(alias));
  const resolvedManifestByAlias = new Map<string, CourseManifest>();
  await Promise.all(
    enabledManifests.map(async (manifestRow) => {
      try {
        const manifest = await resolveManifest(manifestRow.alias);
        if (
          manifest.alias !== manifestRow.alias ||
          manifest.manifestHash !== manifestRow.manifestHash ||
          manifest.realPublishEnabled !== false
        ) {
          return;
        }
        resolvedManifestByAlias.set(manifestRow.alias, manifest);
      } catch {
        // Health must surface a missing/malformed disk manifest as attention.
      }
    })
  );
  const currentGovernanceByCourse = new Map<
    string,
    (typeof governanceRows)[number]
  >();
  for (const row of governanceRows) {
    if (row.validFrom > now) continue;
    if (!currentGovernanceByCourse.has(row.courseAlias)) {
      currentGovernanceByCourse.set(row.courseAlias, row);
    }
  }
  const currentGovernanceRows = [...currentGovernanceByCourse.values()];
  const enabledGovernanceRows = currentGovernanceRows.filter((row) =>
    enabledManifestAliases.has(row.courseAlias)
  );
  let missingEnabledGovernanceCount = 0;
  let governanceIntegrityAttentionCount = 0;
  const verifiedEnabledGovernance = new Map<
    string,
    ReturnType<typeof verifyCourseOperationGovernanceRecord>
  >();
  for (const manifestRow of enabledManifests) {
    const manifest = resolvedManifestByAlias.get(manifestRow.alias);
    const governance = currentGovernanceByCourse.get(manifestRow.alias);
    if (!governance) {
      missingEnabledGovernanceCount += 1;
      governanceIntegrityAttentionCount += 1;
      continue;
    }
    if (!manifest) {
      governanceIntegrityAttentionCount += 1;
      continue;
    }
    try {
      const verified = verifyCourseOperationGovernanceRecord(
        governance as any,
        manifest
      );
      verifiedEnabledGovernance.set(manifestRow.alias, verified);
      if (
        verified.policy.status !== "active" ||
        verified.policy.emergencyHalt ||
        Date.parse(verified.policy.validFrom) > now.getTime() ||
        Date.parse(verified.policy.validUntil) <= now.getTime()
      ) {
        governanceIntegrityAttentionCount += 1;
      }
    } catch {
      // Hash drift, stale base manifest, malformed bounds, or schema errors.
      governanceIntegrityAttentionCount += 1;
    }
  }
  const nonExecutableEnabledGovernanceCount = enabledGovernanceRows.filter(
    (row) =>
      row.status !== "active" ||
      row.emergencyHalt ||
      row.validFrom > now ||
      row.validUntil <= now
  ).length;
  const verifiedEnabledGovernanceRows = [
    ...verifiedEnabledGovernance.values()
  ];
  const governanceEmergencyCount = verifiedEnabledGovernanceRows.filter(
    (governance) => governance.policy.emergencyHalt
  ).length;
  const soakReadiness = evaluateAutonomySoakReadiness({
    summary: workerWake,
    expiredLeaseCount,
    unresolvedHighIncidentCount
  });
  const workerWakeDisposition = classifyWorkerWakeRuntimeDisposition({
    soakReadiness,
    enabledScheduleCount: enabledSchedules.length
  });
  const status =
    emergencyPolicyCount > 0 ||
      governanceEmergencyCount > 0 ||
      workerWakeDisposition === "halted" ||
      !externalWriteLockIntact
      ? ("halted" as const)
      : expiredLeaseCount > 0 ||
          failedLast24hCount > 0 ||
          unresolvedHighIncidentCount > 0 ||
          overdueOutcomeCount > 0 ||
          missingEnabledScheduleCount > 0 ||
          missingEnabledGovernanceCount > 0 ||
          nonExecutableEnabledGovernanceCount > 0 ||
          governanceIntegrityAttentionCount > 0 ||
          due.governanceFilteredCount > 0 ||
          workerWakeDisposition === "attention"
        ? ("attention" as const)
        : ("healthy" as const);
  const summaryWithoutHash = {
    schemaVersion:
      AUTONOMY_RUNTIME_HEALTH_SCHEMA_VERSION,
    asOf: now.toISOString(),
    status,
    externalWriteLockIntact,
    manifests: {
      enabled: enabledManifestCount,
      publishEnabled: publishEnabledManifestCount
    },
    schedules: {
      enabled: enabledSchedules.length,
      due: due.due.length,
      runnable: due.due.filter(
        (entry) => entry.state === "runnable"
      ).length,
      missingForEnabledManifest: missingEnabledScheduleCount
    },
    invocations: {
      running: runningInvocationCount,
      expiredLease: expiredLeaseCount,
      failedLast24h: failedLast24hCount,
      lastCompletedAt:
        latestCompleted?.finishedAt?.toISOString() ?? null
    },
    outcomes: {
      pending: pendingOutcomeCount,
      overdue: overdueOutcomeCount,
      observed: observedOutcomeCount,
      censored: censoredOutcomeCount
    },
    incidents: {
      open: openIncidentCount,
      acknowledged: acknowledgedIncidentCount,
      unresolved: unresolvedIncidentCount,
      unresolvedHighOrCritical: unresolvedHighIncidentCount
    },
    governance: {
      total: enabledGovernanceRows.length,
      active: verifiedEnabledGovernanceRows.filter(
        (governance) =>
          governance.policy.status === "active" &&
          Date.parse(governance.policy.validFrom) <= now.getTime() &&
          Date.parse(governance.policy.validUntil) > now.getTime() &&
          !governance.policy.emergencyHalt
      ).length,
      paused: verifiedEnabledGovernanceRows.filter(
        (governance) => governance.policy.status === "paused"
      ).length,
      revoked: verifiedEnabledGovernanceRows.filter(
        (governance) => governance.policy.status === "revoked"
      ).length,
      emergencyHalt: governanceEmergencyCount,
      missingForEnabledManifest: missingEnabledGovernanceCount,
      dueFiltered: due.governanceFilteredCount
    },
    workerWake,
    soakReadiness,
    containsForumText: false as const
  };
  return {
    ...summaryWithoutHash,
    evidenceHash: canonicalProtocolHash(
      AUTONOMY_RUNTIME_HEALTH_SCHEMA_VERSION,
      summaryWithoutHash as unknown as CanonicalJsonValue
    )
  };
}
