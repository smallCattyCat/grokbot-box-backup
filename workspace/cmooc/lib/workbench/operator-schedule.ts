import { latestDueScheduledFor } from "@/lib/autonomy/runtime-health";
import { DEFAULT_AUTONOMY_SOAK_READINESS_PROFILE } from "@/lib/autonomy/soak-readiness";

export type OperatorScheduleState =
  | "active"
  | "configured"
  | "paused"
  | "attention"
  | "unavailable";

export type OperatorScheduleSummary = {
  state: OperatorScheduleState;
  mode: string | null;
  intervalMinutes: number | null;
  timeZone: string | null;
  nextWindowAt: string | null;
  nextWindowState: "due" | "upcoming" | "unavailable";
  upcomingWindows: string[];
  latestInvocation: {
    status: string;
    scheduledFor: string;
  } | null;
  latestWake: {
    status: string;
    observedAt: string;
    zeroWrite: boolean;
  } | null;
  externalWritesLocked: true;
  containsForumText: false;
};

export const OPERATOR_WORKER_WAKE_SCOPE = {
  source: DEFAULT_AUTONOMY_SOAK_READINESS_PROFILE.source,
  runtimeVersion: DEFAULT_AUTONOMY_SOAK_READINESS_PROFILE.runtimeVersion
} as const;

type ScheduleRow = {
  id: string;
  enabled: boolean;
  mode: string;
  intervalMinutes: number;
  timeZone: string;
  nextRunAt: Date | null;
};

type GovernanceRow = {
  status: string;
  mode: string;
  minIntervalMinutes: number;
  emergencyHalt: boolean;
  validFrom: Date;
  validUntil: Date;
};

type InvocationRow = {
  scheduleId: string | null;
  status: string;
  scheduledFor: Date;
};

type WakeRow = {
  status: string;
  startedAt: Date;
  editorWriteCount: number;
  publishAttemptCount: number;
  realPublishEnabled: boolean;
  containsForumText: boolean;
};

const HOST_WAKE_FRESHNESS_MS = 60 * 60_000;

function hostWakeState(now: Date, wake: WakeRow | null): OperatorScheduleState {
  if (!wake) return "configured";
  const observedAt = wake.startedAt.getTime();
  const ageMs = now.getTime() - observedAt;
  if (!Number.isFinite(observedAt) || ageMs < 0) return "attention";
  if (ageMs > HOST_WAKE_FRESHNESS_MS) return "configured";
  return wake.status === "completed" || wake.status === "running"
    ? "active"
    : "attention";
}

function baseSummary(
  state: OperatorScheduleState,
  schedule?: ScheduleRow
): OperatorScheduleSummary {
  return {
    state,
    mode: schedule?.mode ?? null,
    intervalMinutes: schedule?.intervalMinutes ?? null,
    timeZone: schedule?.timeZone ?? null,
    nextWindowAt: null,
    nextWindowState: "unavailable",
    upcomingWindows: [],
    latestInvocation: null,
    latestWake: null,
    externalWritesLocked: true,
    containsForumText: false
  };
}

function validGovernance(
  governance: GovernanceRow | null,
  schedule: ScheduleRow,
  now: Date
): governance is GovernanceRow {
  return Boolean(
    governance &&
    governance.status === "active" &&
    governance.mode === schedule.mode &&
    governance.emergencyHalt === false &&
    governance.validFrom.getTime() <= now.getTime() &&
    governance.validUntil.getTime() > now.getTime() &&
    Number.isSafeInteger(governance.minIntervalMinutes) &&
    governance.minIntervalMinutes >= 1
  );
}

function futureWindow(input: {
  intervalMinutes: number;
  configured: Date | null;
  latest: InvocationRow | null;
}): Date | null {
  const intervalMs = input.intervalMinutes * 60_000;
  if (input.latest && input.latest.status !== "completed") {
    return new Date(input.latest.scheduledFor);
  }
  const fromLatest = input.latest
    ? new Date(input.latest.scheduledFor.getTime() + intervalMs)
    : null;
  if (fromLatest && input.configured) {
    return fromLatest.getTime() >= input.configured.getTime()
      ? fromLatest
      : new Date(input.configured);
  }
  return fromLatest ?? (input.configured ? new Date(input.configured) : null);
}

export function buildOperatorScheduleSummary(input: {
  now: Date;
  schedules: ScheduleRow[];
  governance: GovernanceRow | null;
  latestInvocation: InvocationRow | null;
  latestHostWake: WakeRow | null;
  latestWake: WakeRow | null;
}): OperatorScheduleSummary {
  const enabled = input.schedules.filter((schedule) => schedule.enabled);
  if (enabled.length > 1) return baseSummary("attention");
  if (enabled.length === 0) {
    const paused = input.schedules[0];
    return paused ? baseSummary("paused", paused) : baseSummary("unavailable");
  }

  const schedule = enabled[0]!;
  if (
    !Number.isSafeInteger(schedule.intervalMinutes) ||
    schedule.intervalMinutes < 1 ||
    !validGovernance(input.governance, schedule, input.now)
  ) {
    return baseSummary("attention", schedule);
  }

  const intervalMinutes = Math.max(
    schedule.intervalMinutes,
    input.governance.minIntervalMinutes
  );
  const latest =
    input.latestInvocation?.scheduleId === schedule.id
      ? input.latestInvocation
      : null;
  const due = latestDueScheduledFor({
    now: input.now,
    intervalMinutes,
    nextRunAt: schedule.nextRunAt,
    latestScheduledFor: latest?.scheduledFor ?? null,
    latestStatus: latest?.status ?? null
  });
  const next = due ?? futureWindow({
    intervalMinutes,
    configured: schedule.nextRunAt,
    latest
  });
  const summary = baseSummary(
    hostWakeState(input.now, input.latestHostWake),
    schedule
  );
  const projected: OperatorScheduleSummary = {
    ...summary,
    intervalMinutes,
    nextWindowAt: next?.toISOString() ?? null,
    nextWindowState: due ? "due" : next ? "upcoming" : "unavailable",
    latestInvocation: latest
      ? {
          status: latest.status,
          scheduledFor: latest.scheduledFor.toISOString()
        }
      : null,
    latestWake: input.latestWake
      ? {
          status: input.latestWake.status,
          observedAt: input.latestWake.startedAt.toISOString(),
          zeroWrite:
            input.latestWake.editorWriteCount === 0 &&
            input.latestWake.publishAttemptCount === 0 &&
            input.latestWake.realPublishEnabled === false &&
            input.latestWake.containsForumText === false
        }
      : null
  };
  return {
    ...projected,
    upcomingWindows: projectScheduleWindows(projected, 4)
  };
}

export function projectScheduleWindows(
  summary: OperatorScheduleSummary,
  requestedCount = 4
): string[] {
  if (
    (summary.state !== "active" && summary.state !== "configured") ||
    !summary.nextWindowAt ||
    !summary.intervalMinutes
  ) {
    return [];
  }
  const start = Date.parse(summary.nextWindowAt);
  if (!Number.isFinite(start)) return [];
  const count = Math.max(1, Math.min(6, Math.floor(requestedCount)));
  const intervalMs = summary.intervalMinutes * 60_000;
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * intervalMs).toISOString()
  );
}
