import assert from "node:assert/strict";
import test from "node:test";
import {
  DurableCourseToolExecutionSink
} from "../../lib/workbench/course-tool-ledger-sink";
import type { WorkbenchDb } from "../../lib/workbench/durable-ledger";

function databaseFixture() {
  const calls: Array<{ operation: string; data: unknown }> = [];
  const now = new Date("2026-08-12T20:00:00.000Z");
  const callRecord = {
    id: "call-safe",
    taskId: "task-safe",
    runId: "run-safe",
    stepId: "step-safe",
    executionLeaseId: "lease-safe",
    parentCallId: null,
    toolName: "course.snapshot.read",
    toolVersion: "1",
    capability: "L0_READ",
    effectClass: "read",
    safeInputSummary: "读取精确课程快照。",
    inputHash: "a".repeat(64),
    idempotencyKey: "b".repeat(64),
    attempt: 1,
    grantRef: null,
    leaseGeneration: 1,
    fencingTokenHash: "c".repeat(64),
    status: "requested",
    causationId: null,
    createdAt: now,
    completedAt: null
  };
  const lease = {
    id: "lease-safe",
    taskId: "task-safe",
    runId: "run-safe",
    stepId: "step-safe",
    scopeKey: "step:step-safe",
    ownerInstanceId: "owner-safe",
    generation: 1,
    fencingTokenHash: "placeholder",
    status: "active",
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: new Date("2026-08-12T20:05:00.000Z"),
    releasedAt: null,
    createdAt: now,
    updatedAt: now
  };
  const db = {
    $transaction: async (callback: (transaction: unknown) => unknown) =>
      callback(db),
    workbenchRunRecord: {
      findUnique: async () => ({ taskId: "task-safe" })
    },
    workbenchPlanStepRecord: {
      findUnique: async () => ({
        planRevision: { taskId: "task-safe", runId: "run-safe" }
      })
    },
    workbenchExecutionLease: {
      updateMany: async ({ data }: { data: unknown }) => {
        calls.push({ operation: "lease", data });
        return { count: 1 };
      }
    },
    workbenchToolCallRecord: {
      findUnique: async () => null,
      create: async ({ data }: { data: unknown }) => {
        calls.push({ operation: "call", data });
        return { ...callRecord, ...(data as object) };
      }
    }
  } as unknown as WorkbenchDb;
  return { db, calls, callRecord, lease };
}

const FENCE = {
  callId: "call-safe",
  executionLeaseId: "lease-safe",
  leaseGeneration: 1,
  fencingToken: "d".repeat(64)
} as const;

test("ledger sink maps a start projection to an atomic durable claim without persisting the token", async () => {
  const fixture = databaseFixture();
  const sink = new DurableCourseToolExecutionSink(fixture.db);
  const disposition = await sink.appendToolCall(
    {
      schemaVersion: "cmooc.course-tool-durable-call.v1",
      id: "call-safe",
      taskId: "task-safe",
      runId: "run-safe",
      stepId: "step-safe",
      toolName: "course.snapshot.read",
      toolVersion: "1",
      capability: "L0_READ",
      effectClass: "read",
      safeInputSummary: "读取精确课程快照。",
      inputHash: "a".repeat(64),
      idempotencyKey: "b".repeat(64),
      attempt: 1,
      leaseGeneration: 1,
      fencingTokenHash: "c".repeat(64),
      status: "started",
      createdAt: "2026-08-12T20:00:00.000Z"
    },
    FENCE
  );

  assert.equal(disposition, "accepted");
  assert.equal(
    JSON.stringify(fixture.calls).includes(FENCE.fencingToken),
    false
  );
});

test("ledger sink rejects a projection whose call identity differs from its fence", async () => {
  const fixture = databaseFixture();
  const sink = new DurableCourseToolExecutionSink(fixture.db);
  await assert.rejects(
    sink.appendToolCall(
      {
        schemaVersion: "cmooc.course-tool-durable-call.v1",
        id: "another-call",
        taskId: "task-safe",
        runId: "run-safe",
        stepId: "step-safe",
        toolName: "course.snapshot.read",
        toolVersion: "1",
        capability: "L0_READ",
        effectClass: "read",
        safeInputSummary: "读取精确课程快照。",
        inputHash: "a".repeat(64),
        idempotencyKey: "b".repeat(64),
        attempt: 1,
        leaseGeneration: 1,
        fencingTokenHash: "c".repeat(64),
        status: "started",
        createdAt: "2026-08-12T20:00:00.000Z"
      },
      FENCE
    ),
    /does not match its transient lease fence/
  );
});

test("aggregate verification reports require coherent non-empty receipts before database access", async () => {
  const fixture = databaseFixture();
  const sink = new DurableCourseToolExecutionSink(fixture.db);
  await assert.rejects(
    sink.recordVerification(
      {
        id: "verification-safe",
        subjectType: "tool_result",
        subjectId: "call-safe",
        status: "unknown",
        receipts: [],
        observedAt: "2026-08-12T20:00:00.000Z"
      },
      {
        ...FENCE,
        taskId: "task-safe",
        runId: "run-safe",
        stepId: "step-safe"
      }
    ),
    /no coherent receipts/
  );
  assert.equal(fixture.calls.length, 0);
});
