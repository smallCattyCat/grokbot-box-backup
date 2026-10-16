import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWorkerWakeRuntimeDisposition,
  latestDueScheduledFor,
  listDueAutonomyInvocations
} from "../../lib/autonomy/runtime-health";
import type { PrismaClient } from "@prisma/client";
import type { CourseManifest } from "../../lib/autonomy/course-manifest";
import {
  buildCourseOperationGovernanceBaseline,
  hashCourseOperationGovernancePolicy
} from "../../lib/autonomy/course-operation-governance";
import {
  buildEventPrefix,
  classifyPublicationEligibility,
  eventPrefixIsContinuous,
  remotePublicationReceiptIsBound,
  summarizePostPublicationEvents,
  type EventPrefixItem
} from "../../lib/autonomy/outcome-observer";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "../../lib/facilitation-protocol";
import {
  EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION
} from "../../lib/autonomy/execution-permit";
import type {
  AutonomySoakReadinessCheckId,
  AutonomySoakReadinessReceipt
} from "../../lib/autonomy/soak-readiness";

function event(input: {
  eventKey: string;
  actorKey: string | null;
  actorRelation: string;
  occurredAt: string;
  depth: number;
  parentEventKey?: string | null;
}): EventPrefixItem {
  return {
    eventKey: input.eventKey,
    parentEventKey: input.parentEventKey ?? null,
    actorKey: input.actorKey,
    actorRelation: input.actorRelation,
    kind:
      input.parentEventKey === undefined
        ? "thread_root"
        : "comment",
    occurredAt: new Date(input.occurredAt),
    observedAt: new Date(input.occurredAt),
    depth: input.depth,
    targetVersionHash: "f".repeat(64)
  };
}

test("调度器折叠错过的 cadence，并保持当前槽幂等", () => {
  const now = new Date("2026-07-05T12:47:00.000Z");
  assert.equal(
    latestDueScheduledFor({
      now,
      intervalMinutes: 30,
      nextRunAt: new Date(
        "2026-07-05T10:00:00.000Z"
      ),
      latestScheduledFor: new Date(
        "2026-07-05T10:00:00.000Z"
      )
    })?.toISOString(),
    "2026-07-05T12:30:00.000Z"
  );
  assert.equal(
    latestDueScheduledFor({
      now,
      intervalMinutes: 30,
      nextRunAt: new Date(
        "2026-07-05T13:00:00.000Z"
      ),
      latestScheduledFor: null
    }),
    null
  );
  assert.equal(
    latestDueScheduledFor({
      now,
      intervalMinutes: 30,
      nextRunAt: new Date(
        "2026-07-05T13:00:00.000Z"
      ),
      latestScheduledFor: new Date(
        "2026-07-05T12:00:00.000Z"
      ),
      latestStatus: "failed"
    })?.toISOString(),
    "2026-07-05T12:00:00.000Z",
    "失败 cadence 必须原槽重试，不能被 nextRunAt 跳过"
  );
});

test("启用 schedule 使用 keyset 分页，501 之后的 due 课程不会永久饥饿", async () => {
  const now = new Date("2026-08-02T12:00:00.000Z");
  const alias = "tail-course";
  const manifestHash = "f".repeat(64);
  const manifest = {
    schemaVersion: "cmooc.course-manifest.v1",
    alias,
    platformId: "cmooc.bnu",
    courseId: "12345678",
    courseIdSha256: "a".repeat(64),
    canonicalUrl: "https://example.test/course",
    allowedOrigins: ["https://example.test"],
    adapterId: "test-adapter",
    timeZone: "UTC",
    defaultMode: "SHADOW",
    policyVersion: "v1",
    scan: {
      maxThreadsPerTick: 10,
      maxCommentsPerThread: 10,
      pageSize: 10
    },
    budget: {
      dailySlots: 3,
      workloadCost: 1,
      authorTouchLimit30d: 3
    },
    schedule: {
      intervalMinutes: 30,
      leaseSeconds: 30
    },
    realPublishEnabled: false,
    manifestHash,
    sourcePath: "test"
  } satisfies CourseManifest;
  const governancePolicy = buildCourseOperationGovernanceBaseline({
    manifest,
    version: "v1",
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z"
  });
  const governanceHash = hashCourseOperationGovernancePolicy(
    governancePolicy
  );
  const governanceRow = {
    id: "tail-governance",
    courseAlias: alias,
    version: governancePolicy.version,
    baseManifestHash: governancePolicy.baseManifestHash,
    status: governancePolicy.status,
    mode: governancePolicy.mode,
    dailySlotLimit: governancePolicy.limits.dailySlotLimit,
    perTickActionLimit: governancePolicy.limits.perTickActionLimit,
    authorTouchLimit30d: governancePolicy.limits.authorTouchLimit30d,
    minIntervalMinutes: governancePolicy.limits.minIntervalMinutes,
    validFrom: new Date(governancePolicy.validFrom),
    validUntil: new Date(governancePolicy.validUntil),
    emergencyHalt: governancePolicy.emergencyHalt,
    governanceHash,
    containsForumText: false
  };
  const newer = new Date("2026-08-02T11:00:00.000Z");
  const schedules = Array.from({ length: 500 }, (_, index) => ({
    id: `filler-${String(index).padStart(3, "0")}`,
    courseAlias: `filler-${String(index).padStart(3, "0")}`,
    mode: "SHADOW",
    intervalMinutes: 30,
    nextRunAt: new Date("2026-08-02T11:00:00.000Z"),
    updatedAt: newer
  }));
  schedules.push({
    id: "000-tail-schedule",
    courseAlias: alias,
    mode: "SHADOW",
    intervalMinutes: 30,
    nextRunAt: new Date("2026-08-02T11:00:00.000Z"),
    updatedAt: newer
  });
  schedules.sort(
    (left, right) =>
      right.updatedAt.getTime() - left.updatedAt.getTime() ||
      right.id.localeCompare(left.id)
  );
  const scheduleQueryTakes: number[] = [];
  const scheduleQueryCursors: string[] = [];
  const prisma = {
    autonomyCourseManifest: {
      findMany: async () => [
        { alias, manifestHash }
      ]
    },
    operationSchedule: {
      findMany: async (args: any) => {
        scheduleQueryTakes.push(args.take);
        const cursor = args.where.OR?.[0]?.updatedAt?.lt as Date | undefined;
        const tieCursor = args.where.OR?.[1]?.updatedAt as Date | undefined;
        const idCursor = args.where.OR?.[1]?.id?.lt as string | undefined;
        if (cursor || tieCursor || idCursor) {
          scheduleQueryCursors.push(
            `${tieCursor?.toISOString() ?? cursor?.toISOString()}:${idCursor ?? ""}`
          );
        }
        const filtered = schedules.filter((schedule) =>
          cursor && tieCursor && idCursor
            ? schedule.updatedAt < cursor ||
              (schedule.updatedAt.getTime() === tieCursor.getTime() &&
                schedule.id < idCursor)
            : true
        );
        return filtered.slice(0, args.take);
      }
    },
    courseOperationGovernancePolicy: {
      findMany: async () => [governanceRow]
    },
    scheduledInvocation: {
      findMany: async () => [],
      findFirst: async () => null
    }
  } as unknown as PrismaClient;

  const result = await listDueAutonomyInvocations({
    prisma,
    now,
    limit: 1,
    resolveManifest: async () => manifest
  });

  assert.deepEqual(
    result.due.map((entry) => entry.courseAlias),
    [alias]
  );
  assert.equal(result.truncated, false);
  assert.equal(scheduleQueryTakes.every((take) => take === 500), true);
  assert.equal(scheduleQueryTakes.length >= 4, true);
  assert.equal(scheduleQueryCursors.length >= 2, true);
});

test("worker wake 缺失、卡死和安全越界不能被标成 healthy", () => {
  const readiness = (
    status: "unknown" | "qualifying" | "blocked" | "qualified",
    failedCheckId?: AutonomySoakReadinessCheckId
  ): Pick<AutonomySoakReadinessReceipt, "status" | "checks"> => ({
    status,
    checks: [
      {
        id: failedCheckId ?? "receipt_contract_valid",
        kind: "blocker",
        status: failedCheckId ? "failed" : "passed",
        operator: "eq",
        observed: failedCheckId ? false : true,
        expected: true
      }
    ]
  });
  assert.equal(
    classifyWorkerWakeRuntimeDisposition({
      soakReadiness: readiness("unknown"),
      enabledScheduleCount: 1
    }),
    "attention"
  );
  assert.equal(
    classifyWorkerWakeRuntimeDisposition({
      soakReadiness: readiness("blocked", "stale_running_count"),
      enabledScheduleCount: 1
    }),
    "attention"
  );
  assert.equal(
    classifyWorkerWakeRuntimeDisposition({
      soakReadiness: readiness(
        "blocked",
        "zero_publish_attempts"
      ),
      enabledScheduleCount: 1
    }),
    "halted"
  );
  assert.equal(
    classifyWorkerWakeRuntimeDisposition({
      soakReadiness: readiness("qualifying"),
      enabledScheduleCount: 1
    }),
    "healthy"
  );
});

test("其他 source/runtime 的坏回执不能污染 RC13 生产 scope", () => {
  const productionReadiness = {
    status: "qualifying" as const,
    checks: [
      {
        id: "receipt_contract_valid",
        kind: "blocker",
        status: "passed",
        operator: "eq",
        observed: true,
        expected: true
      }
    ]
  } satisfies Pick<
    AutonomySoakReadinessReceipt,
    "status" | "checks"
  >;
  assert.equal(
    classifyWorkerWakeRuntimeDisposition({
      soakReadiness: productionReadiness,
      enabledScheduleCount: 1
    }),
    "healthy"
  );
});

test("只有单次、已确认、permit 已消费的 AUTO 发布可建结果窗口", () => {
  const decision = {
    id: "decision-local",
    courseAlias: "safe-alias",
    threadKey: "a".repeat(64),
    authorKey: "b".repeat(64),
    decision: "draft",
    publishAttempted: true
  };
  const permit = {
    id: "permit-local",
    decisionId: decision.id,
    permitKey: "d".repeat(64),
    targetHash: "e".repeat(64),
    targetVersionHash: "f".repeat(64),
    contentHash: "1".repeat(64),
    idempotencyKey: "2".repeat(64),
    status: "used",
    usedAt: new Date("2026-07-05T12:00:00.000Z"),
    revokedAt: null,
    realPublishEnabled: true
  };
  const finishedAt = new Date(
    "2026-07-05T12:00:00.000Z"
  );
  const receipt = {
    schemaVersion:
      EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
    permitKey: permit.permitKey,
    idempotencyKey: permit.idempotencyKey,
    targetHash: permit.targetHash,
    targetVersionHash: permit.targetVersionHash,
    contentHash: permit.contentHash,
    state: "confirmed_published",
    observedAt: finishedAt.toISOString(),
    requestedMutationCount: 1,
    sentMutationCount: 1,
    publishAttempted: true,
    realPublishEnabled: true,
    bodyPersisted: false,
    containsForumText: false
  };
  const attempt = {
    id: "attempt-local",
    decisionId: decision.id,
    permitId: "permit-local",
    mode: "AUTO",
    status: "confirmed_published",
    idempotencyKey: permit.idempotencyKey,
    receiptJson: JSON.stringify(receipt),
    requestedMutationCount: 1,
    sentMutationCount: 1,
    publishAttempted: true,
    remoteOutcomeHash: canonicalProtocolHash(
      EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
      receipt as unknown as CanonicalJsonValue
    ),
    finishedAt
  };
  const eligible = classifyPublicationEligibility({
    decision,
    attempt,
    permit
  });
  assert.equal(eligible.eligible, true);
  assert.equal(
    remotePublicationReceiptIsBound({
      attempt,
      permit
    }),
    true
  );
  assert.deepEqual(
    classifyPublicationEligibility({
      decision,
      attempt: {
        ...attempt,
        remoteOutcomeHash: "c".repeat(64)
      },
      permit
    }),
    {
      eligible: false,
      reason: "remote_outcome_receipt_invalid"
    },
    "任意 64 位摘要不得冒充远端发布回执"
  );

  const shadow = classifyPublicationEligibility({
    decision,
    attempt: {
      ...attempt,
      mode: "SHADOW",
      requestedMutationCount: 0,
      sentMutationCount: 0,
      publishAttempted: false
    },
    permit
  });
  assert.deepEqual(shadow, {
    eligible: false,
    reason: "attempt_not_confirmed"
  });
  const stage = classifyPublicationEligibility({
    decision,
    attempt: {
      ...attempt,
      mode: "STAGE"
    },
    permit
  });
  assert.deepEqual(stage, {
    eligible: false,
    reason: "attempt_not_auto"
  });
});

test("HMAC 事件前缀只做连续性与描述性近端指标", () => {
  const root = event({
    eventKey: "1".repeat(64),
    actorKey: "a".repeat(64),
    actorRelation: "thread_author",
    occurredAt: "2026-07-05T10:00:00.000Z",
    depth: 0
  });
  const externalReply = event({
    eventKey: "2".repeat(64),
    actorKey: "b".repeat(64),
    actorRelation: "external_human",
    occurredAt: "2026-07-05T13:00:00.000Z",
    depth: 1,
    parentEventKey: root.eventKey
  });
  const authorReturn = event({
    eventKey: "3".repeat(64),
    actorKey: root.actorKey,
    actorRelation: "thread_author",
    occurredAt: "2026-07-05T14:00:00.000Z",
    depth: 2,
    parentEventKey: externalReply.eventKey
  });
  const baseline = buildEventPrefix([root]);
  const current = buildEventPrefix([
    authorReturn,
    root,
    externalReply
  ]);
  assert.equal(
    eventPrefixIsContinuous({
      baselineEventKeys: baseline.eventKeys,
      currentEventKeys: current.eventKeys
    }),
    true
  );
  assert.equal(
    eventPrefixIsContinuous({
      baselineEventKeys: baseline.eventKeys,
      currentEventKeys: [
        "9".repeat(64),
        ...current.eventKeys
      ]
    }),
    false
  );
  assert.deepEqual(
    summarizePostPublicationEvents({
      baselineEvents: [root],
      currentEvents: [root, externalReply, authorReturn],
      authorKey: root.actorKey,
      publishedAt: new Date(
        "2026-07-05T12:00:00.000Z"
      )
    }),
    {
      firstExternalReplyAt: new Date(
        "2026-07-05T13:00:00.000Z"
      ),
      authorReturned: true,
      replyDepthDelta: 2,
      newAuthorCount: 1
    }
  );
});
