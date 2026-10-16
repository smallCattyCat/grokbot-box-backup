import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import type { CourseManifest } from "../../lib/autonomy/course-manifest";
import {
  hashCourseOperationGovernancePolicy,
  issueCourseOperationGovernanceBaseline,
  type CourseOperationGovernancePolicy
} from "../../lib/autonomy/course-operation-governance";
import { transitionCourseOperationGovernance } from "../../lib/autonomy/course-operation-governance-lifecycle";
import {
  getAutonomyRuntimeHealth,
  listDueAutonomyInvocations
} from "../../lib/autonomy/runtime-health";
import { getAutonomyDashboardReadModel } from "../../lib/autonomy/read-model";

process.env.DATABASE_URL = "file:./test.db";
process.env.CMOOC_DISABLE_WINDOWS_ENV_FALLBACK = "1";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureManifest(alias: string): CourseManifest {
  return {
    schemaVersion: "cmooc.course-manifest.v1",
    alias,
    platformId: "cmooc.bnu",
    courseId: "1234567890",
    courseIdSha256: hash("1234567890"),
    canonicalUrl: "https://example.test/course",
    allowedOrigins: ["https://example.test"],
    adapterId: "test.adapter",
    timeZone: "UTC",
    defaultMode: "SHADOW",
    policyVersion: `${alias}.shadow.v1`,
    scan: { maxThreadsPerTick: 10, maxCommentsPerThread: 10, pageSize: 10 },
    budget: { dailySlots: 3, workloadCost: 1, authorTouchLimit30d: 2 },
    schedule: { intervalMinutes: 30, leaseSeconds: 30 },
    realPublishEnabled: false,
    manifestHash: hash(`manifest-${alias}`),
    sourcePath: `C:\\tmp\\${alias}-course.json`
  } as CourseManifest;
}

async function createManifestRow(
  prisma: PrismaClient,
  manifest: CourseManifest,
  enabled = true
) {
  return prisma.autonomyCourseManifest.create({
    data: {
      alias: manifest.alias,
      manifestHash: manifest.manifestHash,
      platformId: "test",
      platformCourseRefHash: hash(`course-${manifest.alias}`),
      canonicalLocatorHash: hash(`locator-${manifest.alias}`),
      identityKeyFingerprint: hash(`identity-${manifest.alias}`),
      allowedOrigin: "https://example.test",
      timeZone: "UTC",
      defaultMode: "SHADOW",
      policyVersion: manifest.policyVersion,
      enabled,
      realPublishEnabled: false
    }
  });
}

async function createSchedule(
  prisma: PrismaClient,
  alias: string,
  scheduleKey: string,
  now: Date,
  intervalMinutes = 30
) {
  return prisma.operationSchedule.create({
    data: {
      courseAlias: alias,
      scheduleKey,
      mode: "SHADOW",
      intervalMinutes,
      timeZone: "UTC",
      enabled: true,
      nextRunAt: new Date(now.getTime() - 60 * 60_000),
      budgetJson: JSON.stringify({ containsForumText: false })
    }
  });
}

function overBudgetPolicy(
  manifest: CourseManifest
): CourseOperationGovernancePolicy {
  return {
    schemaVersion: "cmooc.course-operation-governance-policy.v1",
    courseAlias: manifest.alias,
    version: `${manifest.alias}.over-budget.v1`,
    baseManifestHash: manifest.manifestHash,
    status: "active",
    mode: "SHADOW",
    limits: {
      dailySlotLimit: 4,
      perTickActionLimit: 4,
      authorTouchLimit30d: 2,
      minIntervalMinutes: 30
    },
    validFrom: "2026-08-01T00:00:00.000Z",
    validUntil: "2026-09-01T00:00:00.000Z",
    emergencyHalt: false,
    containsForumText: false
  };
}

async function cleanup(
  prisma: PrismaClient,
  aliases: string[]
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.scheduledInvocation.deleteMany({
      where: { courseAlias: { in: aliases } }
    });
    await tx.operationSchedule.deleteMany({
      where: { courseAlias: { in: aliases } }
    });
    await tx.autonomyCourseManifest.deleteMany({
      where: { alias: { in: aliases } }
    });
  });
}

test("hash-valid 但超过 manifest budget 的治理策略不进入 due，健康为 attention", async () => {
  const { prisma } = await import("../../lib/db");
  const alias = `health-budget-${randomUUID().replaceAll("-", "")}`;
  const now = new Date("2026-08-02T12:00:00.000Z");
  const manifest = fixtureManifest(alias);
  try {
    const before = await listDueAutonomyInvocations({
      prisma,
      now,
      resolveManifest: async () => manifest
    });
    const beforeHealth = await getAutonomyRuntimeHealth({
      prisma,
      now,
      resolveManifest: async () => manifest
    });
    await createManifestRow(prisma, manifest);
    const policy = overBudgetPolicy(manifest);
    await prisma.courseOperationGovernancePolicy.create({
      data: {
        courseAlias: policy.courseAlias,
        version: policy.version,
        baseManifestHash: policy.baseManifestHash,
        status: policy.status,
        mode: policy.mode,
        dailySlotLimit: policy.limits.dailySlotLimit,
        perTickActionLimit: policy.limits.perTickActionLimit,
        authorTouchLimit30d: policy.limits.authorTouchLimit30d,
        minIntervalMinutes: policy.limits.minIntervalMinutes,
        validFrom: new Date(policy.validFrom),
        validUntil: new Date(policy.validUntil),
        emergencyHalt: policy.emergencyHalt,
        governanceHash: hashCourseOperationGovernancePolicy(policy),
        containsForumText: false
      }
    });
    await createSchedule(prisma, alias, `${alias}-schedule`, now);
    const resolver = async () => manifest;
    const due = await listDueAutonomyInvocations({
      prisma,
      now,
      resolveManifest: resolver
    });
    assert.equal(due.due.some((entry) => entry.courseAlias === alias), false);
    assert.equal(
      due.governanceFilteredCount >= before.governanceFilteredCount + 1,
      true
    );
    const health = await getAutonomyRuntimeHealth({
      prisma,
      now,
      resolveManifest: resolver
    });
    assert.equal(health.status, "attention");
    assert.equal(health.governance.dueFiltered >= 1, true);
    assert.equal(health.governance.active, beforeHealth.governance.active);
  } finally {
    await cleanup(prisma, [alias]);
    await prisma.$disconnect();
  }
});

test("旧 null schedule invocation 不阻塞新 schedule，合法 due 绑定 scheduleId", async () => {
  const { prisma } = await import("../../lib/db");
  const alias = `health-legacy-${randomUUID().replaceAll("-", "")}`;
  const now = new Date("2026-08-02T12:00:00.000Z");
  const manifest = fixtureManifest(alias);
  try {
    const before = await listDueAutonomyInvocations({
      prisma,
      now,
      resolveManifest: async () => manifest
    });
    await createManifestRow(prisma, manifest);
    await issueCourseOperationGovernanceBaseline({
      prisma,
      manifest,
      version: `${alias}.governance.v1`,
      validFrom: "2026-08-01T00:00:00.000Z",
      validUntil: "2026-09-01T00:00:00.000Z"
    });
    const schedule = await createSchedule(
      prisma,
      alias,
      `${alias}-schedule`,
      now
    );
    await prisma.scheduledInvocation.create({
      data: {
        invocationKey: `${alias}-legacy`,
        courseAlias: alias,
        scheduleId: null,
        manifestHash: manifest.manifestHash,
        scheduledFor: now,
        mode: "SHADOW",
        status: "pending",
        phase: "scheduled",
        attempt: 0
      }
    });
    const collided = await listDueAutonomyInvocations({
      prisma,
      now,
      resolveManifest: async () => manifest
    });
    assert.equal(
      collided.due.some((candidate) => candidate.courseAlias === alias),
      false
    );
    assert.equal(
      collided.governanceFilteredCount >=
        before.governanceFilteredCount + 1,
      true
    );
    const due = await listDueAutonomyInvocations({
      prisma,
      now: new Date(now.getTime() + 31 * 60_000),
      resolveManifest: async () => manifest
    });
    const entry = due.due.find((candidate) => candidate.courseAlias === alias);
    assert.ok(entry);
    assert.equal(entry.scheduleId, schedule.id);
  } finally {
    await cleanup(prisma, [alias]);
    await prisma.$disconnect();
  }
});

test("同课程多个 enabled schedule 即使模式不同也 fail closed", async () => {
  const { prisma } = await import("../../lib/db");
  const alias = `health-duplicate-${randomUUID().replaceAll("-", "")}`;
  const now = new Date("2026-08-02T12:00:00.000Z");
  const manifest = fixtureManifest(alias);
  try {
    const before = await listDueAutonomyInvocations({
      prisma,
      now,
      resolveManifest: async () => manifest
    });
    await createManifestRow(prisma, manifest);
    await issueCourseOperationGovernanceBaseline({
      prisma,
      manifest,
      version: `${alias}.governance.v1`,
      validFrom: "2026-08-01T00:00:00.000Z",
      validUntil: "2026-09-01T00:00:00.000Z"
    });
    await createSchedule(prisma, alias, `${alias}-schedule-a`, now);
    const secondSchedule = await createSchedule(
      prisma,
      alias,
      `${alias}-schedule-b`,
      now
    );
    await prisma.operationSchedule.update({
      where: { id: secondSchedule.id },
      data: { mode: "OBSERVE" }
    });
    const due = await listDueAutonomyInvocations({
      prisma,
      now,
      resolveManifest: async () => manifest
    });
    assert.equal(due.due.some((entry) => entry.courseAlias === alias), false);
    assert.equal(
      due.governanceFilteredCount >= before.governanceFilteredCount + 1,
      true
    );
  } finally {
    await cleanup(prisma, [alias]);
    await prisma.$disconnect();
  }
});

test("enabled manifest 缺策略计 missing，disabled manifest 不计", async () => {
  const { prisma } = await import("../../lib/db");
  const enabledAlias = `health-missing-enabled-${randomUUID().replaceAll("-", "")}`;
  const disabledAlias = `health-missing-disabled-${randomUUID().replaceAll("-", "")}`;
  const enabledManifest = fixtureManifest(enabledAlias);
  const disabledManifest = fixtureManifest(disabledAlias);
  try {
    const before = await getAutonomyRuntimeHealth({
      prisma,
      now: new Date("2026-08-02T12:00:00.000Z"),
      resolveManifest: async () => enabledManifest
    });
    await createManifestRow(prisma, enabledManifest, true);
    await createManifestRow(prisma, disabledManifest, false);
    const resolver = async (alias: string) =>
      alias === enabledAlias ? enabledManifest : disabledManifest;
    const health = await getAutonomyRuntimeHealth({
      prisma,
      now: new Date("2026-08-02T12:00:00.000Z"),
      resolveManifest: resolver
    });
    assert.equal(
      health.manifests.enabled >= before.manifests.enabled + 1,
      true
    );
    assert.equal(
      health.governance.missingForEnabledManifest >=
        before.governance.missingForEnabledManifest + 1,
      true
    );
    assert.equal(health.status, "attention");
  } finally {
    await cleanup(prisma, [enabledAlias, disabledAlias]);
    await prisma.$disconnect();
  }
});

test("disabled course 的遗留 high incident 不污染 active runtime health", async () => {
  const { prisma } = await import("../../lib/db");
  const alias = `health-disabled-incident-${randomUUID().replaceAll("-", "")}`;
  const manifest = fixtureManifest(alias);
  const now = new Date("2026-08-02T12:00:00.000Z");
  let incidentId = "";
  try {
    const before = await getAutonomyRuntimeHealth({
      prisma,
      now,
      resolveManifest: async () => manifest
    });
    await createManifestRow(prisma, manifest, false);
    const incident = await prisma.autonomyIncident.create({
      data: {
        courseAlias: alias,
        severity: "high",
        code: "disabled_fixture_failure",
        status: "open",
        evidenceHash: hash(`incident-${alias}`),
        summaryJson: JSON.stringify({
          schemaVersion: "cmooc.autonomy-incident-summary.v1",
          reasonCode: "disabled_fixture_failure",
          containsForumText: false
        })
      }
    });
    incidentId = incident.id;
    const health = await getAutonomyRuntimeHealth({
      prisma,
      now,
      resolveManifest: async () => manifest
    });
    assert.equal(health.incidents.open, before.incidents.open);
    assert.equal(
      health.incidents.unresolvedHighOrCritical,
      before.incidents.unresolvedHighOrCritical
    );
    assert.equal(
      health.soakReadiness.checks.find(
        (check) => check.id === "unresolved_high_incident_count"
      )?.observed,
      before.soakReadiness.checks.find(
        (check) => check.id === "unresolved_high_incident_count"
      )?.observed
    );
  } finally {
    if (incidentId) {
      await prisma.autonomyIncident.delete({ where: { id: incidentId } });
    }
    await cleanup(prisma, [alias]);
    await prisma.$disconnect();
  }
});

test("enabled course 的 acknowledged high incident 仍阻断 soak readiness", async () => {
  const { prisma } = await import("../../lib/db");
  const alias = `health-acknowledged-incident-${randomUUID().replaceAll("-", "")}`;
  const manifest = fixtureManifest(alias);
  const now = new Date("2026-08-02T12:00:00.000Z");
  let incidentId = "";
  try {
    const before = await getAutonomyRuntimeHealth({
      prisma,
      now,
      resolveManifest: async () => manifest
    });
    await createManifestRow(prisma, manifest, true);
    const incident = await prisma.autonomyIncident.create({
      data: {
        courseAlias: alias,
        severity: "high",
        code: "acknowledged_active_failure",
        status: "acknowledged",
        evidenceHash: hash(`incident-${alias}`),
        summaryJson: JSON.stringify({
          schemaVersion: "cmooc.autonomy-incident-summary.v1",
          reasonCode: "acknowledged_active_failure",
          containsForumText: false
        })
      }
    });
    incidentId = incident.id;
    const health = await getAutonomyRuntimeHealth({
      prisma,
      now,
      resolveManifest: async () => manifest
    });
    assert.equal(health.incidents.open, before.incidents.open);
    assert.equal(
      health.incidents.acknowledged,
      before.incidents.acknowledged + 1
    );
    assert.equal(
      health.incidents.unresolved,
      before.incidents.unresolved + 1
    );
    assert.equal(
      health.incidents.unresolvedHighOrCritical,
      before.incidents.unresolvedHighOrCritical + 1
    );
    const beforeHighIncidentCheck = before.soakReadiness.checks.find(
      (check) => check.id === "unresolved_high_incident_count"
    );
    assert.equal(typeof beforeHighIncidentCheck?.observed, "number");
    assert.equal(
      health.soakReadiness.checks.find(
        (check) => check.id === "unresolved_high_incident_count"
      )?.observed,
      Number(beforeHighIncidentCheck?.observed) + 1
    );
    assert.equal(health.soakReadiness.status, "blocked");
  } finally {
    if (incidentId) {
      await prisma.autonomyIncident.delete({ where: { id: incidentId } });
    }
    await cleanup(prisma, [alias]);
    await prisma.$disconnect();
  }
});

test("disabled course 的 invocation 与 outcome 残留不污染 active health", async () => {
  const { prisma } = await import("../../lib/db");
  const alias = `health-disabled-runtime-${randomUUID().replaceAll("-", "")}`;
  const manifest = fixtureManifest(alias);
  const now = new Date("2026-08-02T12:00:00.000Z");
  let decisionId = "";
  try {
    const before = await getAutonomyRuntimeHealth({
      prisma,
      now,
      resolveManifest: async () => manifest
    });
    await createManifestRow(prisma, manifest, false);
    const running = await prisma.scheduledInvocation.create({
      data: {
        invocationKey: `${alias}-running`,
        courseAlias: alias,
        manifestHash: manifest.manifestHash,
        scheduledFor: new Date(now.getTime() - 60_000),
        mode: "SHADOW",
        status: "running",
        phase: "scan",
        startedAt: new Date(now.getTime() - 30_000)
      }
    });
    await prisma.scheduledInvocation.create({
      data: {
        invocationKey: `${alias}-failed`,
        courseAlias: alias,
        manifestHash: manifest.manifestHash,
        scheduledFor: new Date(now.getTime() - 120_000),
        mode: "SHADOW",
        status: "failed",
        phase: "failed",
        finishedAt: new Date(now.getTime() - 30_000)
      }
    });
    const completed = await prisma.scheduledInvocation.create({
      data: {
        invocationKey: `${alias}-completed`,
        courseAlias: alias,
        manifestHash: manifest.manifestHash,
        scheduledFor: new Date(now.getTime() - 180_000),
        mode: "SHADOW",
        status: "completed",
        phase: "completed",
        finishedAt: new Date(now.getTime() - 15_000)
      }
    });
    const decision = await prisma.autonomyDecision.create({
      data: {
        invocationId: completed.id,
        courseAlias: alias,
        decisionKey: `${alias}-decision`,
        threadKey: hash(`${alias}-thread`),
        decision: "wait",
        decisionMode: "SHADOW",
        reasonCode: "disabled_runtime_fixture",
        observationReceiptHash: hash(`${alias}-observation`),
        opportunityReceiptHash: hash(`${alias}-opportunity`),
        evidenceBundleHash: hash(`${alias}-bundle`),
        policyVersion: manifest.policyVersion,
        worldHash: hash(`${alias}-world`),
        candidateSetHash: hash(`${alias}-candidate`),
        evidenceAsOf: now,
        decisionJson: JSON.stringify({ containsForumText: false })
      }
    });
    decisionId = decision.id;
    await prisma.proximalOutcome.create({
      data: {
        decisionId: decision.id,
        observationWindow: "R24",
        dueAt: new Date(now.getTime() - 1_000),
        status: "pending",
        functionUptakeJson: JSON.stringify({ containsForumText: false })
      }
    });

    const health = await getAutonomyRuntimeHealth({
      prisma,
      now,
      resolveManifest: async () => manifest
    });
    assert.deepEqual(health.invocations, before.invocations);
    assert.deepEqual(health.outcomes, before.outcomes);
    assert.equal(running.leaseExpiresAt, null);
  } finally {
    if (decisionId) {
      await prisma.proximalOutcome.deleteMany({ where: { decisionId } });
      await prisma.autonomyDecision.delete({ where: { id: decisionId } });
    }
    await cleanup(prisma, [alias]);
    await prisma.$disconnect();
  }
});

test("operator dashboard 的 focal invocation 只来自 active visible course", async () => {
  const { prisma } = await import("../../lib/db");
  const activeAlias = `production-scope-${randomUUID().replaceAll("-", "")}`;
  const disabledAlias = `retired-scope-${randomUUID().replaceAll("-", "")}`;
  const activeManifest = fixtureManifest(activeAlias);
  const disabledManifest = fixtureManifest(disabledAlias);
  let activeIncidentId = "";
  let disabledIncidentId = "";
  try {
    const before = await getAutonomyDashboardReadModel({ prisma });
    await createManifestRow(prisma, activeManifest, true);
    await createManifestRow(prisma, disabledManifest, false);
    const activeInvocation = await prisma.scheduledInvocation.create({
      data: {
        invocationKey: `${activeAlias}-completed`,
        courseAlias: activeAlias,
        manifestHash: activeManifest.manifestHash,
        scheduledFor: new Date("2099-01-01T00:00:00.000Z"),
        mode: "SHADOW",
        status: "completed",
        phase: "completed",
        finishedAt: new Date("2099-01-01T00:01:00.000Z")
      }
    });
    await prisma.scheduledInvocation.create({
      data: {
        invocationKey: `${disabledAlias}-completed`,
        courseAlias: disabledAlias,
        manifestHash: disabledManifest.manifestHash,
        scheduledFor: new Date("2100-01-01T00:00:00.000Z"),
        mode: "SHADOW",
        status: "completed",
        phase: "completed",
        finishedAt: new Date("2100-01-01T00:01:00.000Z")
      }
    });
    const activeIncident = await prisma.autonomyIncident.create({
      data: {
        courseAlias: activeAlias,
        invocationId: activeInvocation.id,
        severity: "medium",
        code: "active_operator_incident",
        status: "acknowledged",
        evidenceHash: hash(`${activeAlias}-incident`),
        summaryJson: JSON.stringify({ containsForumText: false })
      }
    });
    activeIncidentId = activeIncident.id;
    const disabledIncident = await prisma.autonomyIncident.create({
      data: {
        courseAlias: disabledAlias,
        severity: "high",
        code: "retired_operator_incident",
        status: "open",
        evidenceHash: hash(`${disabledAlias}-incident`),
        summaryJson: JSON.stringify({ containsForumText: false })
      }
    });
    disabledIncidentId = disabledIncident.id;

    const dashboard = await getAutonomyDashboardReadModel({ prisma });
    assert.equal(dashboard.focalInvocation?.id, activeInvocation.id);
    assert.equal(
      dashboard.manifests.some((row) => row.alias === activeAlias),
      true
    );
    assert.equal(
      dashboard.manifests.some((row) => row.alias === disabledAlias),
      false
    );
    assert.equal(
      dashboard.unresolvedIncidentCount,
      before.unresolvedIncidentCount + 1
    );
  } finally {
    if (activeIncidentId || disabledIncidentId) {
      await prisma.autonomyIncident.deleteMany({
        where: { id: { in: [activeIncidentId, disabledIncidentId].filter(Boolean) } }
      });
    }
    await cleanup(prisma, [activeAlias, disabledAlias]);
    await prisma.$disconnect();
  }
});

test("enabled manifest 有有效治理但缺 schedule 时健康为 attention", async () => {
  const { prisma } = await import("../../lib/db");
  const alias = `health-missing-schedule-${randomUUID().replaceAll("-", "")}`;
  const manifest = fixtureManifest(alias);
  const now = new Date("2026-08-02T12:00:00.000Z");
  try {
    const before = await getAutonomyRuntimeHealth({
      prisma,
      now,
      resolveManifest: async () => manifest
    });
    await createManifestRow(prisma, manifest, true);
    await issueCourseOperationGovernanceBaseline({
      prisma,
      manifest,
      version: `${alias}.governance.v1`,
      validFrom: "2026-08-01T00:00:00.000Z",
      validUntil: "2026-09-01T00:00:00.000Z"
    });
    const health = await getAutonomyRuntimeHealth({
      prisma,
      now,
      resolveManifest: async () => manifest
    });
    assert.equal(health.status, "attention");
    assert.equal(
      health.schedules.missingForEnabledManifest >=
        before.schedules.missingForEnabledManifest + 1,
      true
    );
  } finally {
    await cleanup(prisma, [alias]);
    await prisma.$disconnect();
  }
});

test("due/health 按 as-of 选择 future rotation，不提前切换 governance hash", async () => {
  const { prisma } = await import("../../lib/db");
  const alias = `health-future-${randomUUID().replaceAll("-", "")}`;
  const manifest = fixtureManifest(alias);
  const beforeRotation = new Date("2026-08-02T12:00:00.000Z");
  try {
    await createManifestRow(prisma, manifest, true);
    const baseline = await issueCourseOperationGovernanceBaseline({
      prisma,
      manifest,
      version: `${alias}.governance.v1`,
      validFrom: "2026-08-01T00:00:00.000Z",
      validUntil: "2026-09-01T00:00:00.000Z"
    });
    await createSchedule(
      prisma,
      alias,
      `${alias}-schedule`,
      beforeRotation
    );
    const rotation = await transitionCourseOperationGovernance({
      prisma,
      manifest,
      expectedManifestHash: manifest.manifestHash,
      expectedGovernanceHash: baseline.governanceHash,
      command: {
        action: "rotate",
        version: `${alias}.governance.v2`,
        transitionKey: `${alias}-rotate-v2`,
        reasonCode: "scheduled_policy_rotation",
        effectiveAt: "2026-08-10T00:00:00.000Z",
        validUntil: "2026-10-01T00:00:00.000Z",
        limits: {
          dailySlotLimit: 2,
          perTickActionLimit: 1,
          authorTouchLimit30d: 1,
          minIntervalMinutes: 30
        }
      },
      apply: true
    });
    const before = await listDueAutonomyInvocations({
      prisma,
      now: beforeRotation,
      resolveManifest: async () => manifest
    });
    assert.equal(
      before.due.find((entry) => entry.courseAlias === alias)?.governanceHash,
      baseline.governanceHash
    );
    const after = await listDueAutonomyInvocations({
      prisma,
      now: new Date("2026-08-10T00:31:00.000Z"),
      resolveManifest: async () => manifest
    });
    assert.equal(
      after.due.find((entry) => entry.courseAlias === alias)?.governanceHash,
      rotation.governanceHash
    );
    const health = await getAutonomyRuntimeHealth({
      prisma,
      now: new Date("2026-08-10T00:31:00.000Z"),
      resolveManifest: async () => manifest
    });
    assert.equal(health.governance.active >= 1, true);
  } finally {
    await cleanup(prisma, [alias]);
    await prisma.$disconnect();
  }
});
