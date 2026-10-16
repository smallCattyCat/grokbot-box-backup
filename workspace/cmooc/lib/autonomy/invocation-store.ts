import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  ScheduledInvocation
} from "@prisma/client";
import type {
  AutonomyMode,
  CourseManifest
} from "./course-manifest";
import { loadCourseOperationGovernance } from "./course-operation-governance";

export type InvocationLease = {
  invocation: ScheduledInvocation;
  leaseOwner: string;
  acquired: true;
  recovered: boolean;
};

export type InvocationNotAcquired = {
  invocation: ScheduledInvocation;
  acquired: false;
  reason: "lease_busy" | "already_completed";
};

export type InvocationAcquireResult =
  | InvocationLease
  | InvocationNotAcquired;

export type InvocationAcquireInput = {
  prisma: PrismaClient;
  manifest: CourseManifest;
  mode: AutonomyMode;
  scheduleId: string;
  scheduledFor?: Date | string;
  now?: Date;
  leaseOwner?: string;
  governance: {
    policyId: string;
    version: string;
    hash: string;
    limits: {
      dailySlotLimit: number;
      perTickActionLimit: number;
      authorTouchLimit30d: number;
      intervalMinutes: number;
    };
  };
  intervalMinutes?: number;
};

const courseAcquisitionTails = new Map<
  string,
  Promise<void>
>();

async function serializeCourseAcquisition<T>(
  courseAlias: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous =
    courseAcquisitionTails.get(courseAlias) ??
    Promise.resolve();
  const run = previous.then(operation);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  courseAcquisitionTails.set(courseAlias, tail);
  try {
    return await run;
  } finally {
    if (courseAcquisitionTails.get(courseAlias) === tail) {
      courseAcquisitionTails.delete(courseAlias);
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${label}必须是有效时间。`);
  }
  return date;
}

const SAFE_SCHEDULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_GOVERNANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_GOVERNANCE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const GOVERNANCE_HASH_PATTERN = /^[a-f0-9]{64}$/;

function requiredSafeIdentifier(
  value: unknown,
  pattern: RegExp,
  code: string
): string {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim();
  if (!pattern.test(normalized)) throw new Error(code);
  return normalized;
}

function validateGovernanceLimits(input: InvocationAcquireInput["governance"]): void {
  if (
    [
      input.limits.dailySlotLimit,
      input.limits.perTickActionLimit,
      input.limits.authorTouchLimit30d
    ].some(
      (value) =>
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 10_000
    ) ||
    !Number.isSafeInteger(input.limits.intervalMinutes) ||
    input.limits.intervalMinutes < 1 ||
    input.limits.intervalMinutes > 7 * 24 * 60 ||
    input.limits.perTickActionLimit > input.limits.dailySlotLimit
  ) {
    throw new Error("AUTONOMY_GOVERNANCE_LIMITS_INVALID");
  }
}

export function defaultInvocationTime(
  now = new Date(),
  intervalMinutes = 1
): Date {
  const normalized = safeDate(now, "当前时间");
  if (
    !Number.isSafeInteger(intervalMinutes) ||
    intervalMinutes < 1 ||
    intervalMinutes > 7 * 24 * 60
  ) {
    throw new Error("自治调用间隔必须是 1 分钟到 7 天之间的整数。");
  }
  const intervalMs = intervalMinutes * 60_000;
  return new Date(
    Math.floor(normalized.getTime() / intervalMs) * intervalMs
  );
}

export function invocationKey(input: {
  courseAlias: string;
  scheduledFor: Date;
  mode: AutonomyMode;
  manifestHash: string;
}): string {
  return sha256(
    [
      "cmooc.scheduled-invocation.v1",
      input.courseAlias,
      input.scheduledFor.toISOString(),
      input.mode,
      input.manifestHash
    ].join("\0")
  );
}

async function acquireInvocationLeaseUnlocked(
  input: InvocationAcquireInput
): Promise<InvocationAcquireResult> {
  const now = safeDate(input.now ?? new Date(), "租约当前时间");
  const scheduleId = requiredSafeIdentifier(
    input.scheduleId,
    SAFE_SCHEDULE_ID_PATTERN,
    "AUTONOMY_SCHEDULE_ID_REQUIRED"
  );
  const policyId = requiredSafeIdentifier(
    input.governance.policyId,
    SAFE_GOVERNANCE_ID_PATTERN,
    "AUTONOMY_GOVERNANCE_POLICY_REQUIRED"
  );
  const governanceVersion = requiredSafeIdentifier(
    input.governance.version,
    SAFE_GOVERNANCE_VERSION_PATTERN,
    "AUTONOMY_GOVERNANCE_VERSION_REQUIRED"
  );
  const governanceHash =
    typeof input.governance.hash === "string"
      ? input.governance.hash.trim().toLowerCase()
      : "";
  if (!GOVERNANCE_HASH_PATTERN.test(governanceHash)) {
    throw new Error("AUTONOMY_GOVERNANCE_HASH_REQUIRED");
  }
  validateGovernanceLimits(input.governance);
  const intervalMinutes =
    input.intervalMinutes ?? input.manifest.schedule.intervalMinutes;
  if (
    !Number.isSafeInteger(intervalMinutes) ||
    intervalMinutes < 1 ||
    intervalMinutes > 7 * 24 * 60
  ) {
    throw new Error("AUTONOMY_INVOCATION_INTERVAL_INVALID");
  }
  if (input.governance.limits.intervalMinutes !== intervalMinutes) {
    throw new Error("AUTONOMY_GOVERNANCE_INTERVAL_MISMATCH");
  }
  if (input.mode !== "OBSERVE" && input.mode !== "SHADOW") {
    throw new Error("AUTONOMY_INVOCATION_MODE_NOT_ALLOWED");
  }
  const verifiedGovernance = await loadCourseOperationGovernance({
    prisma: input.prisma,
    manifest: input.manifest,
    requestedMode: input.mode,
    now
  });
  if (
    verifiedGovernance.record.id !== policyId ||
    verifiedGovernance.policy.version !== governanceVersion ||
    verifiedGovernance.governanceHash !== governanceHash ||
    verifiedGovernance.effectiveLimits.dailySlotLimit !==
      input.governance.limits.dailySlotLimit ||
    verifiedGovernance.effectiveLimits.perTickActionLimit !==
      input.governance.limits.perTickActionLimit ||
    verifiedGovernance.effectiveLimits.authorTouchLimit30d !==
      input.governance.limits.authorTouchLimit30d ||
    verifiedGovernance.effectiveLimits.intervalMinutes !== intervalMinutes
  ) {
    throw new Error("AUTONOMY_GOVERNANCE_BINDING_MISMATCH");
  }
  const [storedManifest, storedSchedule] = await Promise.all([
    input.prisma.autonomyCourseManifest.findUnique({
      where: { alias: input.manifest.alias },
      select: {
        manifestHash: true,
        enabled: true,
        realPublishEnabled: true
      }
    }),
    input.prisma.operationSchedule.findUnique({
      where: { id: scheduleId },
      select: {
        courseAlias: true,
        mode: true,
        intervalMinutes: true,
        enabled: true
      }
    })
  ]);
  const scheduleModeAllowed =
    storedSchedule?.mode === input.mode ||
    (input.mode === "OBSERVE" && storedSchedule?.mode === "SHADOW");
  if (
    !storedManifest ||
    storedManifest.enabled !== true ||
    storedManifest.realPublishEnabled !== false ||
    storedManifest.manifestHash !== input.manifest.manifestHash ||
    !storedSchedule ||
    storedSchedule.enabled !== true ||
    storedSchedule.courseAlias !== input.manifest.alias ||
    !scheduleModeAllowed ||
    storedSchedule.intervalMinutes !== intervalMinutes
  ) {
    throw new Error("AUTONOMY_EXECUTION_BINDING_UNAVAILABLE");
  }
  const scheduledFor = input.scheduledFor !== undefined
    ? safeDate(input.scheduledFor, "计划唤醒时间")
    : defaultInvocationTime(now, intervalMinutes);
  if (scheduledFor.getTime() > now.getTime()) {
    throw new Error("AUTONOMY_SCHEDULED_FOR_FUTURE");
  }
  const key = invocationKey({
    courseAlias: input.manifest.alias,
    scheduledFor,
    mode: input.mode,
    manifestHash: input.manifest.manifestHash
  });

  const expectedLimits = JSON.stringify({
    ...input.governance.limits,
    containsForumText: false
  });
  // All identity, governance and cadence checks happen before lease recovery
  // or any write. This prevents a stale/foreign slot from mutating unrelated
  // invocations while it is being rejected.
  const existing =
    await input.prisma.scheduledInvocation.findUnique({
      where: { invocationKey: key }
    });
  if (existing) {
    if (
      existing.scheduleId !== scheduleId ||
      existing.governancePolicyId !== policyId ||
      existing.governanceVersion !== governanceVersion ||
      existing.governanceHash !== governanceHash ||
      existing.governanceLimitsJson !== expectedLimits
    ) {
      throw new Error("AUTONOMY_GOVERNANCE_SLOT_MISMATCH");
    }
    if (existing.status === "completed") {
      return {
        invocation: existing,
        acquired: false,
        reason: "already_completed"
      };
    }
    const expiredRunning =
      existing.status === "running" &&
      (!existing.leaseExpiresAt ||
        existing.leaseExpiresAt.getTime() < now.getTime());
    const retryableOldSlot =
      existing.status === "pending" ||
      existing.status === "failed" ||
      existing.status === "abandoned" ||
      expiredRunning;
    if (
      scheduledFor.getTime() <
        now.getTime() - intervalMinutes * 60_000 &&
      !retryableOldSlot
    ) {
      throw new Error("AUTONOMY_SCHEDULED_FOR_OUTSIDE_CADENCE");
    }
  } else if (
    scheduledFor.getTime() <
    now.getTime() - intervalMinutes * 60_000
  ) {
    throw new Error("AUTONOMY_SCHEDULED_FOR_OUTSIDE_CADENCE");
  }

  const leaseOwner = input.leaseOwner ?? randomUUID();
  const leaseExpiresAt = new Date(
    now.getTime() + input.manifest.schedule.leaseSeconds * 1_000
  );

  await input.prisma.scheduledInvocation.updateMany({
    where: {
      courseAlias: input.manifest.alias,
      status: "running",
      OR: [
        { leaseExpiresAt: { lt: now } },
        { leaseExpiresAt: null }
      ]
    },
    data: {
      status: "abandoned",
      phase: "lease_expired",
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: now,
      summaryJson: JSON.stringify({
        schemaVersion: "cmooc.invocation-summary.v1",
        status: "abandoned",
        reasonCode: "lease_expired",
        containsForumText: false
      })
    }
  });

  const invocation =
    await input.prisma.scheduledInvocation.upsert({
      where: { invocationKey: key },
      create: {
        invocationKey: key,
        courseAlias: input.manifest.alias,
        scheduleId,
        manifestHash: input.manifest.manifestHash,
        governancePolicyId: policyId,
        governanceVersion,
        governanceHash,
        governanceLimitsJson: expectedLimits,
        scheduledFor,
        mode: input.mode,
        status: "pending",
        phase: "created"
      },
      update: {}
    });
  if (
    invocation.scheduleId !== scheduleId ||
    invocation.governancePolicyId !== policyId ||
    invocation.governanceVersion !== governanceVersion ||
    invocation.governanceHash !== governanceHash ||
    invocation.governanceLimitsJson !== expectedLimits
  ) {
    throw new Error("AUTONOMY_GOVERNANCE_SLOT_MISMATCH");
  }
  if (invocation.status === "completed") {
    return {
      invocation,
      acquired: false,
      reason: "already_completed"
    };
  }

  const phase =
    invocation.status === "pending"
      ? "lease_acquired"
      : `lease_recovered_${invocation.phase}`;
  // One compare-and-swap statement protects both this idempotency slot and
  // the course-level single-worker invariant. This avoids SQLite interactive
  // transaction deadlocks while retaining database-level concurrency safety
  // across processes.
  const acquired = await input.prisma.$executeRaw(
    Prisma.sql`
      UPDATE "ScheduledInvocation"
      SET
        "status" = 'running',
        "phase" = ${phase},
        "leaseOwner" = ${leaseOwner},
        "leaseExpiresAt" = ${leaseExpiresAt},
        "heartbeatAt" = ${now},
        "startedAt" = COALESCE("startedAt", ${now}),
        "finishedAt" = NULL,
        "attempt" = "attempt" + 1
      WHERE "id" = ${invocation.id}
        AND (
          "status" IN ('pending', 'failed', 'abandoned')
          OR (
            "status" = 'running'
            AND (
              "leaseExpiresAt" < ${now}
              OR "leaseExpiresAt" IS NULL
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "ScheduledInvocation" AS "active"
          WHERE "active"."courseAlias" = ${input.manifest.alias}
            AND "active"."id" <> ${invocation.id}
            AND "active"."status" = 'running'
            AND (
              "active"."leaseExpiresAt" >= ${now}
              OR "active"."leaseExpiresAt" IS NULL
            )
        )
    `
  );
  const current =
    await input.prisma.scheduledInvocation.findUniqueOrThrow({
      where: { id: invocation.id }
    });
  if (acquired !== 1) {
    return {
      invocation: current,
      acquired: false,
      reason: "lease_busy"
    };
  }
  return {
    invocation: current,
    acquired: true,
    leaseOwner,
    recovered: current.attempt > 1
  };
}

export async function acquireInvocationLease(
  input: InvocationAcquireInput
): Promise<InvocationAcquireResult> {
  return serializeCourseAcquisition(
    input.manifest.alias,
    () => acquireInvocationLeaseUnlocked(input)
  );
}

export async function heartbeatInvocation(input: {
  prisma: PrismaClient;
  invocationId: string;
  leaseOwner: string;
  phase: string;
  leaseSeconds: number;
  now?: Date;
}): Promise<ScheduledInvocation> {
  const now = safeDate(input.now ?? new Date(), "心跳时间");
  const updated = await input.prisma.scheduledInvocation.updateMany({
    where: {
      id: input.invocationId,
      status: "running",
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: { gte: now }
    },
    data: {
      phase: input.phase,
      heartbeatAt: now,
      leaseExpiresAt: new Date(
        now.getTime() + input.leaseSeconds * 1_000
      )
    }
  });
  if (updated.count !== 1) {
    throw new Error("INVOCATION_LEASE_LOST");
  }
  return input.prisma.scheduledInvocation.findUniqueOrThrow({
    where: { id: input.invocationId }
  });
}

export async function completeInvocation(input: {
  prisma: PrismaClient;
  invocationId: string;
  leaseOwner: string;
  summary: Record<string, unknown>;
  now?: Date;
}): Promise<ScheduledInvocation> {
  const now = safeDate(input.now ?? new Date(), "完成时间");
  const updated = await input.prisma.scheduledInvocation.updateMany({
    where: {
      id: input.invocationId,
      status: "running",
      leaseOwner: input.leaseOwner
    },
    data: {
      status: "completed",
      phase: "completed",
      heartbeatAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: now,
      summaryJson: JSON.stringify(input.summary)
    }
  });
  if (updated.count !== 1) {
    throw new Error("INVOCATION_LEASE_LOST_AT_COMPLETION");
  }
  return input.prisma.scheduledInvocation.findUniqueOrThrow({
    where: { id: input.invocationId }
  });
}

export async function failInvocation(input: {
  prisma: PrismaClient;
  invocationId: string;
  leaseOwner: string;
  reasonCode: string;
  evidenceHash: string;
  now?: Date;
}): Promise<void> {
  const now = safeDate(input.now ?? new Date(), "失败时间");
  await input.prisma.scheduledInvocation.updateMany({
    where: {
      id: input.invocationId,
      status: "running",
      leaseOwner: input.leaseOwner
    },
    data: {
      status: "failed",
      phase: input.reasonCode,
      heartbeatAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: now,
      summaryJson: JSON.stringify({
        schemaVersion: "cmooc.invocation-summary.v1",
        status: "failed",
        reasonCode: input.reasonCode,
        evidenceHash: input.evidenceHash,
        containsForumText: false
      })
    }
  });
}
