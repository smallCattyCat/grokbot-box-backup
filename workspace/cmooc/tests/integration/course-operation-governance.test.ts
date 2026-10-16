import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CourseOperationGovernanceError,
  createCourseOperationGovernancePolicy,
  issueCourseOperationGovernanceBaseline,
  hashCourseOperationGovernancePolicy,
  loadCourseOperationGovernance,
  type CourseOperationGovernancePolicy
} from "../../lib/autonomy/course-operation-governance";
import { transitionCourseOperationGovernance } from "../../lib/autonomy/course-operation-governance-lifecycle";
import type { CourseManifest } from "../../lib/autonomy/course-manifest";
import { listDueAutonomyInvocations } from "../../lib/autonomy/runtime-health";
import { runAutonomyTick } from "../../lib/autonomy/tick";
import { runAutonomyWorkerOnce } from "../../lib/autonomy/worker";

process.env.DATABASE_URL = "file:./test.db";
process.env.CMOOC_DISABLE_WINDOWS_ENV_FALLBACK = "1";

function fixtureManifest(alias: string): CourseManifest {
  const manifestHash = createHash("sha256").update(alias).digest("hex");
  return {
    schemaVersion: "cmooc.course-manifest.v1",
    alias,
    platformId: "cmooc.bnu",
    courseId: "1234567890",
    courseIdSha256: "a".repeat(64),
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
    manifestHash,
    sourcePath: `C:\\tmp\\${alias}-course.json`
  } as CourseManifest;
}

function policyFor(manifest: CourseManifest, overrides: Partial<CourseOperationGovernancePolicy> = {}) {
  return {
    schemaVersion: "cmooc.course-operation-governance-policy.v1",
    courseAlias: manifest.alias,
    version: "governance.v1",
    baseManifestHash: manifest.manifestHash,
    status: "active",
    mode: "SHADOW",
    limits: {
      dailySlotLimit: 2,
      perTickActionLimit: 1,
      authorTouchLimit30d: 1,
      minIntervalMinutes: 60
    },
    validFrom: "2026-08-01T00:00:00.000Z",
    validUntil: "2026-09-01T00:00:00.000Z",
    emergencyHalt: false,
    containsForumText: false,
    ...overrides
  } as CourseOperationGovernancePolicy;
}

test("课程治理 DB baseline、due 过滤和 direct tick lease 前门", async () => {
  const { prisma } = await import("../../lib/db");
  const alias = `governance-it-${Date.now().toString(36)}`;
  const manifest = fixtureManifest(alias);
  try {
    const baseline = await issueCourseOperationGovernanceBaseline({
      prisma,
      manifest,
      version: "governance.v1",
      validFrom: "2026-08-01T00:00:00.000Z",
      validUntil: "2026-09-01T00:00:00.000Z"
    });
    await prisma.autonomyCourseManifest.create({
      data: {
        alias,
        manifestHash: manifest.manifestHash,
        platformId: "test",
        platformCourseRefHash: "a".repeat(64),
        canonicalLocatorHash: "b".repeat(64),
        identityKeyFingerprint: "c".repeat(64),
        allowedOrigin: "https://example.test",
        timeZone: "UTC",
        defaultMode: "SHADOW",
        policyVersion: manifest.policyVersion,
        enabled: true,
        realPublishEnabled: false
      }
    });
    const schedule = await prisma.operationSchedule.create({
      data: {
        courseAlias: alias,
        scheduleKey: `${alias}-schedule`,
        mode: "SHADOW",
        intervalMinutes: 60,
        timeZone: "UTC",
        enabled: true,
        nextRunAt: new Date("2026-08-02T10:00:00.000Z"),
        budgetJson: JSON.stringify({ containsForumText: false })
      }
    });
    const listed = await listDueAutonomyInvocations({
      prisma,
      now: new Date("2026-08-02T12:00:00.000Z"),
      limit: 10,
      resolveManifest: async () => manifest
    });
    const listedCourse = listed.due.find((row) => row.courseAlias === alias);
    assert.ok(listedCourse);
    assert.equal(listedCourse.governanceHash, baseline.governanceHash);
    assert.equal(listedCourse.scheduleIntervalMinutes, 60);

    await assert.rejects(
      () =>
        runAutonomyTick(
          { courseAlias: `missing-${alias}`, requestedMode: "SHADOW" },
          { prisma, manifest: fixtureManifest(`missing-${alias}`) }
        ),
      (error: unknown) =>
        error instanceof CourseOperationGovernanceError &&
        error.code === "course_operation_governance_missing"
    );
    assert.equal(
      await prisma.scheduledInvocation.count({
        where: { courseAlias: `missing-${alias}` }
      }),
      0
    );
  } finally {
    await prisma.$transaction(async (tx) => {
      await tx.scheduledInvocation.deleteMany({ where: { courseAlias: alias } });
      await tx.operationSchedule.deleteMany({ where: { courseAlias: alias } });
      await tx.autonomyCourseManifest.deleteMany({ where: { alias } });
    });
    await prisma.$disconnect();
  }
});

test("暂停治理不会进入 due，worker 对缺少治理 as-of 的队列项拒绝执行", async () => {
  const { prisma } = await import("../../lib/db");
  const alias = `governance-pause-it-${Date.now().toString(36)}`;
  const manifest = fixtureManifest(alias);
  try {
    await createCourseOperationGovernancePolicy({
      prisma,
      manifest,
      policy: policyFor(manifest, { status: "paused" })
    });
    await prisma.autonomyCourseManifest.create({
      data: {
        alias,
        manifestHash: manifest.manifestHash,
        platformId: "test",
        platformCourseRefHash: "a".repeat(64),
        canonicalLocatorHash: "b".repeat(64),
        identityKeyFingerprint: "c".repeat(64),
        allowedOrigin: "https://example.test",
        timeZone: "UTC",
        defaultMode: "SHADOW",
        policyVersion: manifest.policyVersion,
        enabled: true,
        realPublishEnabled: false
      }
    });
    const schedule = await prisma.operationSchedule.create({
      data: {
        courseAlias: alias,
        scheduleKey: `${alias}-schedule`,
        mode: "SHADOW",
        intervalMinutes: 30,
        timeZone: "UTC",
        enabled: true,
        nextRunAt: new Date("2026-08-02T10:00:00.000Z"),
        budgetJson: JSON.stringify({ containsForumText: false })
      }
    });
    const listed = await listDueAutonomyInvocations({
      prisma,
      now: new Date("2026-08-02T12:00:00.000Z"),
      resolveManifest: async () => manifest
    });
    assert.equal(listed.due.some((row) => row.courseAlias === alias), false);

    const worker = await runAutonomyWorkerOnce(
      { limit: 1, now: new Date("2026-08-02T12:00:00.000Z") },
      {
        prisma,
        listDueAutonomyInvocations: async () => ({
          due: [
            {
              courseAlias: alias,
              scheduleId: schedule.id,
              manifestHash: manifest.manifestHash,
              mode: "SHADOW",
              scheduledFor: "2026-08-02T12:00:00.000Z",
              scheduleIntervalMinutes: 30,
              state: "runnable",
              containsForumText: false
            }
          ]
        }),
        resolveManifest: async () => manifest,
        runTick: async () => {
          throw new Error("worker must not bypass governance");
        },
        reconcileOutcomes: async () => ({ status: "skipped", containsForumText: false })
      }
    );
    assert.equal(worker.counts.executed, 0);
    assert.equal(worker.tasks[0]?.reasonCode, "governance_unverified");
  } finally {
    await prisma.$transaction(async (tx) => {
      await tx.scheduledInvocation.deleteMany({ where: { courseAlias: alias } });
      await tx.operationSchedule.deleteMany({ where: { courseAlias: alias } });
      await tx.autonomyCourseManifest.deleteMany({ where: { alias } });
    });
    await prisma.$disconnect();
  }
});

test("issued governance policy rows are append-only at the database boundary", async () => {
  const { prisma } = await import("../../lib/db");
  const alias = `governance-trigger-it-${Date.now().toString(36)}`;
  const manifest = fixtureManifest(alias);
  try {
    const issued = await issueCourseOperationGovernanceBaseline({
      prisma,
      manifest,
      version: "trigger.v1",
      validFrom: "2026-08-01T00:00:00.000Z",
      validUntil: "2026-09-01T00:00:00.000Z"
    });
    await assert.rejects(
      () =>
        prisma.$executeRaw`UPDATE "CourseOperationGovernancePolicy" SET "status" = 'paused' WHERE "id" = ${issued.record.id}`,
      /append-only|UPDATE is forbidden/i
    );
    await assert.rejects(
      () =>
        prisma.$executeRaw`DELETE FROM "CourseOperationGovernancePolicy" WHERE "id" = ${issued.record.id}`,
      /append-only|DELETE is forbidden/i
    );
  } finally {
    // Governance events intentionally remain in test.db as immutable history.
    await prisma.$disconnect();
  }
});

test("baseline issuance has exactly one root per course and exact replay remains idempotent", async () => {
  const { prisma } = await import("../../lib/db");
  const alias = `governance-root-it-${Date.now().toString(36)}`;
  const manifest = fixtureManifest(alias);
  const baselineInput = {
    prisma,
    manifest,
    version: "root.v1",
    validFrom: "2026-08-01T00:00:00.000Z",
    validUntil: "2026-09-01T00:00:00.000Z"
  };
  try {
    const issued = await issueCourseOperationGovernanceBaseline(baselineInput);
    const replayed = await issueCourseOperationGovernanceBaseline(baselineInput);
    assert.equal(replayed.governanceHash, issued.governanceHash);
    assert.equal(replayed.record.id, issued.record.id);

    await assert.rejects(
      () =>
        issueCourseOperationGovernanceBaseline({
          ...baselineInput,
          version: "unlinked-root.v2"
        }),
      (error: unknown) =>
        error instanceof CourseOperationGovernanceError &&
        error.code === "course_operation_governance_baseline_exists"
    );
    assert.equal(
      await prisma.courseOperationGovernancePolicy.count({
        where: { courseAlias: alias }
      }),
      1
    );

    const raceAlias = `${alias}-race`;
    const raceManifest = fixtureManifest(raceAlias);
    const raced = await Promise.allSettled(
      ["root.race.a", "root.race.b"].map((version) =>
        issueCourseOperationGovernanceBaseline({
          prisma,
          manifest: raceManifest,
          version,
          validFrom: "2026-08-01T00:00:00.000Z",
          validUntil: "2026-09-01T00:00:00.000Z"
        })
      )
    );
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = raced.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof CourseOperationGovernanceError);
    assert.equal(
      rejected.reason.code,
      "course_operation_governance_baseline_exists"
    );
    assert.equal(
      await prisma.courseOperationGovernancePolicy.count({
        where: { courseAlias: raceAlias }
      }),
      1
    );
  } finally {
    // Governance events intentionally remain in test.db as immutable history.
    await prisma.$disconnect();
  }
});

test("治理 lifecycle preview 不写库，apply 追加 policy+transition，重放幂等且 CAS 冲突拒绝", async () => {
  const { prisma } = await import("../../lib/db");
  const alias = `governance-lifecycle-it-${Date.now().toString(36)}`;
  const manifest = fixtureManifest(alias);
  try {
    const baseline = await issueCourseOperationGovernanceBaseline({
      prisma,
      manifest,
      version: "lifecycle.v1",
      validFrom: "2026-08-01T00:00:00.000Z",
      validUntil: "2026-09-01T00:00:00.000Z"
    });
    const input = {
      prisma,
      manifest,
      expectedManifestHash: manifest.manifestHash,
      expectedGovernanceHash: baseline.governanceHash,
      command: {
        action: "pause" as const,
        version: "lifecycle.pause.v2",
        transitionKey: "lifecycle-pause-v2",
        reasonCode: "operator_policy_change",
        effectiveAt: "2026-08-02T12:00:00.000Z"
      }
    };

    const preview = await transitionCourseOperationGovernance({
      ...input,
      apply: false
    });
    assert.equal(preview.applied, false);
    assert.equal(preview.replayed, false);
    assert.equal(
      await prisma.courseOperationGovernancePolicy.count({
        where: { courseAlias: alias }
      }),
      1
    );
    assert.equal(
      await prisma.courseOperationGovernanceTransition.count({
        where: { courseAlias: alias }
      }),
      0
    );

    const applied = await transitionCourseOperationGovernance({
      ...input,
      apply: true
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.replayed, false);
    assert.equal(applied.policy.status, "paused");
    assert.equal(applied.transitionRecord?.containsForumText, false);
    assert.equal(
      await prisma.courseOperationGovernancePolicy.count({
        where: { courseAlias: alias }
      }),
      2
    );
    assert.equal(
      await prisma.courseOperationGovernanceTransition.count({
        where: { courseAlias: alias }
      }),
      1
    );

    const replayed = await transitionCourseOperationGovernance({
      ...input,
      apply: true
    });
    assert.equal(replayed.applied, true);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.eventHash, applied.eventHash);
    assert.equal(
      await prisma.courseOperationGovernancePolicy.count({
        where: { courseAlias: alias }
      }),
      2
    );

    await assert.rejects(
      () =>
        transitionCourseOperationGovernance({
          ...input,
          command: {
            ...input.command,
            reasonCode: "different_reason"
          },
          apply: true
        }),
      /transition.*conflict|冲突/i
    );

    await assert.rejects(
      () =>
        prisma.$executeRaw`UPDATE "CourseOperationGovernanceTransition" SET "reasonCode" = 'tampered' WHERE "eventHash" = ${applied.eventHash}`,
      /append-only|UPDATE is forbidden/i
    );
    await assert.rejects(
      () =>
        prisma.$executeRaw`DELETE FROM "CourseOperationGovernanceTransition" WHERE "eventHash" = ${applied.eventHash}`,
      /append-only|DELETE is forbidden/i
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("future rotate 按 as-of 生效，且同一 predecessor 的并发 CAS 只能追加一个 successor", async () => {
  const { prisma } = await import("../../lib/db");
  const suffix = Date.now().toString(36);
  const futureAlias = `governance-future-it-${suffix}`;
  const raceAlias = `governance-race-it-${suffix}`;
  const futureManifest = fixtureManifest(futureAlias);
  const raceManifest = fixtureManifest(raceAlias);
  try {
    const futureBaseline = await issueCourseOperationGovernanceBaseline({
      prisma,
      manifest: futureManifest,
      version: "future.v1",
      validFrom: "2026-08-01T00:00:00.000Z",
      validUntil: "2026-09-01T00:00:00.000Z"
    });
    const futureRotation = await transitionCourseOperationGovernance({
      prisma,
      manifest: futureManifest,
      expectedManifestHash: futureManifest.manifestHash,
      expectedGovernanceHash: futureBaseline.governanceHash,
      command: {
        action: "rotate",
        version: "future.v2",
        transitionKey: "future-rotate-v2",
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
    assert.equal(
      (
        await loadCourseOperationGovernance({
          prisma,
          manifest: futureManifest,
          now: new Date("2026-08-02T12:00:00.000Z"),
          requireExecutable: false
        })
      ).policy.version,
      "future.v1"
    );
    assert.equal(
      (
        await loadCourseOperationGovernance({
          prisma,
          manifest: futureManifest,
          now: new Date("2026-08-10T00:00:00.000Z"),
          requireExecutable: false
        })
      ).policy.version,
      "future.v2"
    );

    await assert.rejects(
      () =>
        transitionCourseOperationGovernance({
          prisma,
          manifest: futureManifest,
          expectedManifestHash: futureManifest.manifestHash,
          expectedGovernanceHash: futureRotation.governanceHash,
          command: {
            action: "pause",
            version: "future.pause.backdated",
            transitionKey: "future-pause-backdated",
            reasonCode: "invalid_backdated_policy",
            effectiveAt: "2026-08-05T00:00:00.000Z"
          },
          apply: false
        }),
      /生效时间|monotonic|effectiveAt/i
    );

    await assert.rejects(
      () =>
        transitionCourseOperationGovernance({
          prisma,
          manifest: futureManifest,
          expectedManifestHash: futureManifest.manifestHash,
          expectedGovernanceHash: futureRotation.governanceHash,
          command: {
            action: "emergency_halt",
            version: "future.halt.historical",
            transitionKey: "future-emergency-halt-historical",
            reasonCode: "invalid_historical_override",
            effectiveAt: "2020-01-01T00:00:00.000Z"
          },
          apply: false,
          now: new Date("2026-08-05T00:00:00.000Z")
        }),
      /emergency.*backdate|紧急停止.*回溯|effectiveAt/i
    );

    const emergencyOverride = await transitionCourseOperationGovernance({
      prisma,
      manifest: futureManifest,
      expectedManifestHash: futureManifest.manifestHash,
      expectedGovernanceHash: futureRotation.governanceHash,
      command: {
        action: "emergency_halt",
        version: "future.halt.v3",
        transitionKey: "future-emergency-halt-v3",
        reasonCode: "emergency_safety_override",
        effectiveAt: "2026-08-05T00:00:00.000Z"
      },
      apply: true,
      now: new Date("2026-08-05T00:00:00.000Z")
    });
    for (const asOf of [
      "2026-08-05T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z"
    ]) {
      const effective = await loadCourseOperationGovernance({
        prisma,
        manifest: futureManifest,
        now: new Date(asOf),
        requireExecutable: false
      });
      assert.equal(effective.governanceHash, emergencyOverride.governanceHash);
      assert.equal(effective.policy.emergencyHalt, true);
      assert.equal(effective.policy.status, "paused");
    }

    const raceBaseline = await issueCourseOperationGovernanceBaseline({
      prisma,
      manifest: raceManifest,
      version: "race.v1",
      validFrom: "2026-08-01T00:00:00.000Z",
      validUntil: "2026-09-01T00:00:00.000Z"
    });
    const outcomes = await Promise.allSettled(
      ["a", "b"].map((branch) =>
        transitionCourseOperationGovernance({
          prisma,
          manifest: raceManifest,
          expectedManifestHash: raceManifest.manifestHash,
          expectedGovernanceHash: raceBaseline.governanceHash,
          command: {
            action: "pause",
            version: `race.pause.${branch}`,
            transitionKey: `race-pause-${branch}`,
            reasonCode: `operator_policy_change_${branch}`,
            effectiveAt: "2026-08-02T12:00:00.000Z"
          },
          apply: true
        })
      )
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1
    );
    assert.equal(
      await prisma.courseOperationGovernanceTransition.count({
        where: { courseAlias: raceAlias }
      }),
      1
    );
    assert.equal(
      await prisma.courseOperationGovernancePolicy.count({
        where: { courseAlias: raceAlias }
      }),
      2
    );
  } finally {
    await prisma.$disconnect();
  }
});
