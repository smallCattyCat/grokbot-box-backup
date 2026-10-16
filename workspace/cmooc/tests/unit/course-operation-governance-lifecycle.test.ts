import assert from "node:assert/strict";
import test from "node:test";
import type { CourseManifest } from "../../lib/autonomy/course-manifest";
import {
  COURSE_OPERATION_GOVERNANCE_SCHEMA_VERSION,
  hashCourseOperationGovernancePolicy,
  type CourseOperationGovernancePolicy
} from "../../lib/autonomy/course-operation-governance";
import {
  COURSE_OPERATION_GOVERNANCE_TRANSITION_SCHEMA_VERSION,
  buildCourseOperationGovernanceTransition,
  hashCourseOperationGovernanceTransition,
  parseCourseOperationGovernanceTransition,
  safeCourseOperationGovernanceTransitionState
} from "../../lib/autonomy/course-operation-governance-lifecycle";

const manifest = {
  schemaVersion: "cmooc.course-manifest.v1",
  alias: "governance-lifecycle-test",
  platformId: "cmooc.bnu",
  courseId: "1234567890",
  courseIdSha256: "a".repeat(64),
  canonicalUrl: "https://example.test/course",
  allowedOrigins: ["https://example.test"],
  adapterId: "test",
  timeZone: "UTC",
  defaultMode: "SHADOW",
  policyVersion: "test.shadow.v1",
  scan: { maxThreadsPerTick: 10, maxCommentsPerThread: 10, pageSize: 10 },
  budget: { dailySlots: 4, workloadCost: 1, authorTouchLimit30d: 3 },
  schedule: { intervalMinutes: 30, leaseSeconds: 30 },
  realPublishEnabled: false,
  manifestHash: "b".repeat(64),
  sourcePath: "C:\\tmp\\governance-lifecycle-test-course.json"
} as CourseManifest;

function policy(
  overrides: Partial<CourseOperationGovernancePolicy> = {}
): CourseOperationGovernancePolicy {
  return {
    schemaVersion: COURSE_OPERATION_GOVERNANCE_SCHEMA_VERSION,
    courseAlias: manifest.alias,
    version: "baseline.v1",
    baseManifestHash: manifest.manifestHash,
    status: "active",
    mode: "SHADOW",
    limits: {
      dailySlotLimit: 3,
      perTickActionLimit: 2,
      authorTouchLimit30d: 2,
      minIntervalMinutes: 60
    },
    validFrom: "2026-08-01T00:00:00.000Z",
    validUntil: "2026-09-01T00:00:00.000Z",
    emergencyHalt: false,
    containsForumText: false,
    ...overrides
  };
}

function build(
  predecessorPolicy: CourseOperationGovernancePolicy,
  action:
    | "pause"
    | "resume"
    | "revoke"
    | "emergency_halt"
    | "rotate",
  overrides: Record<string, unknown> = {}
) {
  return buildCourseOperationGovernanceTransition({
    manifest,
    predecessor: {
      policy: predecessorPolicy,
      governanceHash: hashCourseOperationGovernancePolicy(predecessorPolicy)
    },
    command: {
      action,
      version: `${action}.v2`,
      transitionKey: `${action}-transition-v2`,
      reasonCode: "operator_policy_change",
      effectiveAt: "2026-08-02T12:00:00.000Z",
      ...overrides
    } as never
  });
}

test("治理生命周期把 pause/resume/revoke/halt 表达为新的不可变完整快照", () => {
  const paused = build(policy(), "pause");
  assert.equal(paused.policy.status, "paused");
  assert.equal(paused.policy.emergencyHalt, false);
  assert.equal(paused.transition.action, "pause");
  assert.equal(paused.transition.fromGovernanceHash, hashCourseOperationGovernancePolicy(policy()));
  assert.equal(paused.transition.toGovernanceHash, paused.governanceHash);

  const resumed = build(paused.policy, "resume");
  assert.equal(resumed.policy.status, "active");
  assert.equal(resumed.policy.emergencyHalt, false);

  const halted = build(policy(), "emergency_halt");
  assert.equal(halted.policy.status, "paused");
  assert.equal(halted.policy.emergencyHalt, true);

  const revoked = build(paused.policy, "revoke");
  assert.equal(revoked.policy.status, "revoked");
  assert.equal(revoked.policy.emergencyHalt, false);

  for (const result of [paused, resumed, halted, revoked]) {
    assert.notEqual(
      result.governanceHash,
      result.transition.fromGovernanceHash,
      "每次状态变化必须产生新的策略哈希"
    );
    assert.match(result.eventHash, /^[a-f0-9]{64}$/);
    assert.equal(result.transition.containsForumText, false);
  }
});

test("rotate 可以收紧预算和延长版本有效期，但不能隐式改变 cadence 或放宽 Manifest", () => {
  const rotated = build(policy(), "rotate", {
    validUntil: "2026-10-01T00:00:00.000Z",
    limits: {
      dailySlotLimit: 2,
      perTickActionLimit: 1,
      authorTouchLimit30d: 1,
      minIntervalMinutes: 60
    }
  });
  assert.equal(rotated.policy.status, "active");
  assert.deepEqual(rotated.policy.limits, {
    dailySlotLimit: 2,
    perTickActionLimit: 1,
    authorTouchLimit30d: 1,
    minIntervalMinutes: 60
  });
  assert.equal(rotated.policy.validUntil, "2026-10-01T00:00:00.000Z");

  assert.throws(
    () =>
      build(policy(), "rotate", {
        limits: {
          dailySlotLimit: 3,
          perTickActionLimit: 2,
          authorTouchLimit30d: 2,
          minIntervalMinutes: 90
        }
      }),
    /cadence|间隔|schedule/i
  );
  assert.throws(
    () =>
      build(policy(), "rotate", {
        limits: {
          dailySlotLimit: 5,
          perTickActionLimit: 2,
          authorTouchLimit30d: 2,
          minIntervalMinutes: 60
        }
      }),
    /Manifest|放宽/
  );
});

test("future lifecycle chain is monotonic and cannot backdate a successor before its predecessor", () => {
  const futureRotation = build(policy(), "rotate", {
    effectiveAt: "2026-08-10T00:00:00.000Z"
  });
  assert.throws(
    () =>
      build(futureRotation.policy, "pause", {
        effectiveAt: "2026-08-05T00:00:00.000Z"
      }),
    /effectiveAt|生效时间|monotonic/i
  );

  const laterPause = build(futureRotation.policy, "pause", {
    effectiveAt: "2026-08-15T00:00:00.000Z"
  });
  assert.equal(laterPause.policy.validFrom, "2026-08-15T00:00:00.000Z");
  assert.equal(laterPause.policy.status, "paused");

  const emergencyOverride = build(futureRotation.policy, "emergency_halt", {
    effectiveAt: "2026-08-05T00:00:00.000Z"
  });
  assert.equal(emergencyOverride.policy.validFrom, "2026-08-05T00:00:00.000Z");
  assert.equal(emergencyOverride.policy.status, "paused");
  assert.equal(emergencyOverride.policy.emergencyHalt, true);
});

test("状态转换矩阵拒绝恢复 active、暂停 paused 和恢复 revoked", () => {
  assert.throws(() => build(policy(), "resume"), /状态|resume/i);
  assert.throws(
    () => build(policy({ status: "paused" }), "pause"),
    /状态|pause/i
  );
  assert.throws(
    () => build(policy({ status: "revoked" }), "resume"),
    /状态|revoked|resume/i
  );
});

test("transition exact schema/hash 覆盖 from/to、原因与生效时间且拒绝正文", () => {
  const built = build(policy(), "pause");
  assert.equal(
    built.transition.schemaVersion,
    COURSE_OPERATION_GOVERNANCE_TRANSITION_SCHEMA_VERSION
  );
  assert.deepEqual(
    parseCourseOperationGovernanceTransition(built.transition),
    built.transition
  );
  assert.equal(
    hashCourseOperationGovernanceTransition(built.transition),
    built.eventHash
  );
  assert.notEqual(
    hashCourseOperationGovernanceTransition({
      ...built.transition,
      reasonCode: "different_reason"
    }),
    built.eventHash
  );
  assert.throws(
    () =>
      parseCourseOperationGovernanceTransition({
        ...built.transition,
        body: "forbidden"
      }),
    /未允许字段/
  );
});

test("只读 transition state 重算 event hash，篡改原因不能显示为有效", () => {
  const built = build(policy(), "pause");
  const record = {
    id: "transition-record",
    schemaVersion: built.transition.schemaVersion,
    courseAlias: built.transition.courseAlias,
    transitionKey: built.transition.transitionKey,
    action: built.transition.action,
    fromGovernanceHash: built.transition.fromGovernanceHash,
    toGovernanceHash: built.transition.toGovernanceHash,
    expectedManifestHash: built.transition.expectedManifestHash,
    effectiveAt: new Date(built.transition.effectiveAt),
    reasonCode: built.transition.reasonCode,
    eventHash: built.eventHash,
    containsForumText: false,
    createdAt: new Date("2026-08-02T12:00:00.000Z")
  } as any;
  assert.equal(
    safeCourseOperationGovernanceTransitionState(record).integrityState,
    "valid"
  );
  assert.equal(
    safeCourseOperationGovernanceTransitionState({
      ...record,
      reasonCode: "tampered_reason"
    }).integrityState,
    "integrity_invalid"
  );
});
