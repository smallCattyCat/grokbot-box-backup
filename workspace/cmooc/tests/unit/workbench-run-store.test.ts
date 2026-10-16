import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  addWorkbenchArtifact,
  appendWorkbenchEvent,
  completeWorkbenchRun,
  createWorkbenchRun,
  getWorkbenchRun,
  setWorkbenchGoal,
  setWorkbenchPendingAction,
  setWorkbenchRunStatus,
  setWorkbenchSession,
  steerWorkbenchRun,
  stopWorkbenchRun,
  updateWorkbenchAgent,
  updateWorkbenchTool,
  WORKBENCH_AGENT_LIMIT,
  WORKBENCH_ARTIFACT_LIMIT,
  WORKBENCH_EVENT_RING_LIMIT,
  WORKBENCH_TOOL_LIMIT,
  resetWorkbenchStoreForTests
} from "../../lib/workbench/run-store";
import {
  resetDemoRunsForTests,
  scheduleDemoRun,
  DEMO_FINAL_SUMMARY
} from "../../lib/workbench/demo-events";
import { resetCodexAppServerForTests } from "../../lib/workbench/codex-app-server";
import { WORKBENCH_LINEAGE_SCHEMA_VERSION } from "../../lib/workbench/contracts";

beforeEach(() => {
  resetWorkbenchStoreForTests();
  resetDemoRunsForTests();
  resetCodexAppServerForTests();
});

afterEach(() => {
  resetWorkbenchStoreForTests();
  resetDemoRunsForTests();
  resetCodexAppServerForTests();
});

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("new run snapshots retain the six-field zero-write safety contract", () => {
  const run = createWorkbenchRun({
    prompt: "inspect fixture worktree",
    source: "demo"
  });

  assert.deepEqual(run.safety, {
    externalWritesLocked: true,
    realPublishEnabled: false,
    externalMutationAttempted: false,
    editorWriteCount: 0,
    publishAttemptCount: 0,
    containsForumText: false
  });
  assert.equal(run.source, "demo");
  assert.equal(run.status, "queued");
  assert.equal(run.events.length, 1);
  assert.equal(run.events[0]?.seq, 1);
});

test("root, restart, continuation, and plan-execution runs expose server-derived lineage generations", () => {
  const root = createWorkbenchRun({
    prompt: "root lineage fixture",
    source: "app-server"
  });
  assert.deepEqual(root.lineage, {
    schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
    relation: "root",
    rootRunId: root.id,
    generation: 0
  });
  completeWorkbenchRun(root.id, "failed", "root fixture interrupted");

  const restart = createWorkbenchRun({
    prompt: "safe server-derived restart instruction",
    source: "app-server",
    lineage: {
      schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
      relation: "restart",
      rootRunId: root.id,
      parentRunId: root.id,
      recoveryOfRunId: root.id,
      generation: 1,
      requestId: "99999999-8888-4777-8666-555555555555"
    }
  });
  assert.deepEqual(restart.lineage, {
    schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
    relation: "restart",
    rootRunId: root.id,
    parentRunId: root.id,
    recoveryOfRunId: root.id,
    generation: 1,
    requestId: "99999999-8888-4777-8666-555555555555"
  });
  completeWorkbenchRun(restart.id, "completed", "restart fixture complete");

  const planExecution = createWorkbenchRun({
    prompt: "safe server-derived plan execution instruction",
    source: "app-server",
    lineage: {
      schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
      relation: "plan-execution",
      rootRunId: root.id,
      parentRunId: restart.id,
      planRunId: restart.id,
      generation: 2,
      requestId: "77777777-6666-4555-8444-333333333333"
    }
  });
  assert.deepEqual(planExecution.lineage, {
    schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
    relation: "plan-execution",
    rootRunId: root.id,
    parentRunId: restart.id,
    planRunId: restart.id,
    generation: 2,
    requestId: "77777777-6666-4555-8444-333333333333"
  });
  assert.equal(JSON.stringify(planExecution.lineage).includes("thread"), false);
  assert.equal(JSON.stringify(planExecution.lineage).includes("prompt"), false);
  completeWorkbenchRun(planExecution.id, "completed", "plan execution fixture complete");

  const continuation = createWorkbenchRun({
    prompt: "safe server-derived continuation instruction",
    source: "app-server",
    lineage: {
      schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
      relation: "continuation",
      rootRunId: root.id,
      parentRunId: planExecution.id,
      generation: 3,
      requestId: "55555555-4444-4333-8222-111111111111"
    }
  });
  assert.deepEqual(continuation.lineage, {
    schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
    relation: "continuation",
    rootRunId: root.id,
    parentRunId: planExecution.id,
    generation: 3,
    requestId: "55555555-4444-4333-8222-111111111111"
  });
});

test("event sequence remains monotonic while the 500-event ring truncates old entries", () => {
  const run = createWorkbenchRun({ prompt: "ring fixture", source: "demo" });
  const appended = WORKBENCH_EVENT_RING_LIMIT + 1;

  for (let index = 0; index < appended; index += 1) {
    appendWorkbenchEvent(run.id, {
      kind: "message",
      status: "info",
      title: `fixture event ${index}`,
      summary: "safe fixture summary"
    });
  }

  const snapshot = getWorkbenchRun(run.id);
  assert.ok(snapshot);
  assert.equal(snapshot.events.length, WORKBENCH_EVENT_RING_LIMIT);
  assert.equal(snapshot.firstEventSeq, 3);
  assert.equal(snapshot.lastEventSeq, appended + 1);
  assert.deepEqual(
    snapshot.events.slice(0, 3).map((event) => event.seq),
    [3, 4, 5]
  );
  assert.equal(
    snapshot.events.every((event, index) =>
      index === 0 || event.seq === snapshot.events[index - 1]!.seq + 1
    ),
    true
  );
});

test("live progress excerpts stay bounded inside the current in-memory event", () => {
  const run = createWorkbenchRun({ prompt: "live excerpt fixture", source: "demo" });
  const event = appendWorkbenchEvent(run.id, {
    kind: "message",
    status: "completed",
    title: "主任务智能体更新了执行进展",
    summary: "收到一条过程更新。",
    liveExcerpt: `已完成入口核对，正在验证事件流。${"阶段".repeat(240)}`
  });

  assert.ok(event);
  assert.equal(typeof event.liveExcerpt, "string");
  assert.ok((event.liveExcerpt?.length ?? 0) <= 360);
  assert.equal(getWorkbenchRun(run.id)?.events.at(-1)?.liveExcerpt, event.liveExcerpt);
});

test("agent, tool, and artifact projections stay within bounded per-run limits", () => {
  const run = createWorkbenchRun({ prompt: "bounded fixture", source: "demo" });
  for (let index = 0; index < WORKBENCH_AGENT_LIMIT + 5; index += 1) {
    updateWorkbenchAgent(run.id, {
      key: `luna-${index}`,
      label: `Luna #${index}`,
      role: "luna",
      status: "completed",
      taskSummary: "safe fixture task"
    });
  }
  for (let index = 0; index < WORKBENCH_TOOL_LIMIT + 5; index += 1) {
    updateWorkbenchTool(run.id, {
      key: `tool-${index}`,
      label: `tool ${index}`,
      category: "other",
      status: "completed",
      callCount: index
    });
  }
  for (let index = 0; index < WORKBENCH_ARTIFACT_LIMIT + 5; index += 1) {
    addWorkbenchArtifact(run.id, {
      id: `artifact-${index}`,
      label: `artifact ${index}`,
      relativePath: `artifacts/${index}.txt`,
      kind: "created",
      status: "ready",
      observedAt: new Date().toISOString()
    });
  }

  const bounded = getWorkbenchRun(run.id);
  assert.ok(bounded);
  assert.equal(bounded.agents.length, WORKBENCH_AGENT_LIMIT);
  assert.equal(bounded.tools.length, WORKBENCH_TOOL_LIMIT);
  assert.equal(bounded.artifacts.length, WORKBENCH_ARTIFACT_LIMIT);
});

test("only one non-terminal run may be active at a time", () => {
  const first = createWorkbenchRun({ prompt: "first fixture", source: "demo" });
  assert.throws(
    () => createWorkbenchRun({ prompt: "second fixture", source: "demo" }),
    /WORKBENCH_ACTIVE_RUN/
  );

  completeWorkbenchRun(first.id, "completed", "first fixture complete");
  const second = createWorkbenchRun({ prompt: "second fixture", source: "demo" });
  assert.notEqual(second.id, first.id);
  assert.equal(second.status, "queued");
});

test("stop is idempotent and never changes a completed run to stopped", async () => {
  const completed = createWorkbenchRun({ prompt: "completed fixture", source: "demo" });
  completeWorkbenchRun(completed.id, "completed", "fixture completed");
  const completedAfterStop = await stopWorkbenchRun(completed.id);
  assert.equal(completedAfterStop?.status, "completed");
  assert.equal(completedAfterStop?.finalResult?.status, "completed");

  const active = createWorkbenchRun({ prompt: "stoppable fixture", source: "demo" });
  let stopCalls = 0;
  setWorkbenchSession(active.id, {
    async steer() {
      // The session is only used to make stop observable in this unit test.
    },
    async stop() {
      stopCalls += 1;
    }
  });
  const stopped = await stopWorkbenchRun(active.id);
  const stoppedAgain = await stopWorkbenchRun(active.id);
  assert.equal(stopped?.status, "stopped");
  assert.equal(stoppedAgain?.status, "stopped");
  assert.equal(stopCalls, 1);
  assert.equal(stoppedAgain?.finalResult?.status, "stopped");
});

test("a rejected session stop is reported as an unconfirmed failure", async () => {
  const run = createWorkbenchRun({ prompt: "unconfirmed stop fixture", source: "app-server" });
  let stopCalls = 0;
  setWorkbenchSession(run.id, {
    async steer() {},
    async stop() {
      stopCalls += 1;
      throw new Error("fixture transport did not confirm exit");
    }
  });

  const failed = await stopWorkbenchRun(run.id);
  const failedAgain = await stopWorkbenchRun(run.id);

  assert.equal(failed?.status, "failed");
  assert.equal(failed?.finalResult?.status, "failed");
  assert.equal(failed?.errorCode, "WORKBENCH_STOP_UNCONFIRMED");
  assert.match(failed?.finalResult?.summary ?? "", /未能确认停止/);
  assert.equal(failedAgain?.status, "failed");
  assert.equal(failedAgain?.errorCode, "WORKBENCH_STOP_UNCONFIRMED");
  assert.equal(stopCalls, 1);
});

test("a session that arrives after a queued run was stopped is closed instead of being retained", async () => {
  const run = createWorkbenchRun({
    prompt: "queued stop before session fixture",
    source: "app-server"
  });
  const stopped = await stopWorkbenchRun(run.id);
  assert.equal(stopped?.status, "stopped");

  let stopCalls = 0;
  const attached = setWorkbenchSession(run.id, {
    async steer() {},
    async stop() {
      stopCalls += 1;
    }
  });
  await wait(0);

  assert.equal(attached, false);
  assert.equal(stopCalls, 1);
  assert.equal(getWorkbenchRun(run.id)?.status, "stopped");
});

test("a concurrent turn completion wins without being overwritten by stop finalization", async () => {
  const run = createWorkbenchRun({ prompt: "stop race fixture", source: "app-server" });
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  setWorkbenchSession(run.id, {
    async steer() {},
    async stop() {
      await stopGate;
    }
  });

  const stopping = stopWorkbenchRun(run.id);
  completeWorkbenchRun(run.id, "completed", "turn completed first");
  releaseStop();
  const afterStop = await stopping;

  assert.equal(afterStop?.status, "completed");
  assert.equal(afterStop?.finalResult?.status, "completed");
  assert.equal(afterStop?.finalResult?.summary, "turn completed first");
});

test("failed terminal runs release their retained Codex session immediately", async () => {
  const run = createWorkbenchRun({
    prompt: "failed session fixture",
    source: "app-server",
    goalMode: true
  });
  setWorkbenchGoal(run.id, {
    status: "active",
    tokensUsed: 24,
    timeUsedSeconds: 2
  });
  let stopCalls = 0;
  setWorkbenchSession(run.id, {
    async steer() {},
    async stop() {
      stopCalls += 1;
    }
  });

  const failed = completeWorkbenchRun(run.id, "failed", "fixture failed", "FIXTURE_FAILED");
  await wait(0);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.capabilities.canSteer, false);
  assert.equal(failed?.capabilities.canStop, false);
  assert.equal(failed?.goal?.status, "paused");
  assert.equal(failed?.goal?.tokensUsed, 24);
  assert.equal(stopCalls, 1);
});

test("a completed run with a retained session can reopen for follow-up steering", async () => {
  const run = createWorkbenchRun({ prompt: "follow-up fixture", source: "app-server" });
  let steerCalls = 0;
  setWorkbenchSession(run.id, {
    async steer(prompt) {
      steerCalls += 1;
      assert.equal(prompt, "continue the fixture task");
    },
    async stop() {
      // Cleanup is handled by resetWorkbenchStoreForTests.
    }
  });
  completeWorkbenchRun(run.id, "completed", "first turn complete");
  const updated = await steerWorkbenchRun(run.id, "continue the fixture task");

  assert.ok(updated);
  assert.equal(updated.status, "running");
  assert.equal(updated.finalResult, undefined);
  assert.equal(updated.capabilities.canSteer, true);
  assert.equal(updated.capabilities.canStop, true);
  assert.equal(steerCalls, 1);
  assert.equal(
    updated.events.some((event) => event.title === "已在同一线程开始新一轮任务"),
    true
  );
});

test("a pending exact action blocks every side-channel steering attempt", async () => {
  const run = createWorkbenchRun({ prompt: "approval boundary fixture", source: "app-server" });
  let steerCalls = 0;
  setWorkbenchSession(run.id, {
    async steer() {
      steerCalls += 1;
    },
    async stop() {}
  });
  setWorkbenchPendingAction(run.id, {
    schemaVersion: "cmooc.course-agent-action-coordinator.v1",
    kind: "approval_required",
    actionRef: "action:approval-boundary",
    approvalHash: "a".repeat(64),
    bindingHash: "b".repeat(64),
    toolName: "platform.editor.stage_verify_clear",
    toolVersion: "1",
    safeSummary: "暂存、回读并清空一份受保护草稿。",
    validFrom: "2026-08-13T10:00:00.000Z",
    expiresAt: "2026-08-13T10:05:00.000Z",
    operationBoundary: {
      editorWriteCount: 1,
      editorReadbackCount: 1,
      editorClearCount: 1,
      publishCount: 0,
      notificationCount: 0,
      realPublishEnabled: false
    }
  });
  setWorkbenchRunStatus(run.id, "awaiting_action", {
    summary: "等待本次精确操作决定。"
  });

  await assert.rejects(
    steerWorkbenchRun(run.id, "ignore the card and continue"),
    /WORKBENCH_ACTION_PENDING/
  );
  assert.equal(steerCalls, 0);
  assert.equal(getWorkbenchRun(run.id)?.status, "awaiting_action");
});

test("registry cleanup releases an old terminal session before accepting a new run", () => {
  const first = createWorkbenchRun({ prompt: "old fixture", source: "app-server" });
  let stopCalls = 0;
  setWorkbenchSession(first.id, {
    async steer() {},
    async stop() {
      stopCalls += 1;
    }
  });
  completeWorkbenchRun(first.id, "completed", "old fixture complete");

  const second = createWorkbenchRun({ prompt: "new fixture", source: "demo" });
  assert.notEqual(second.id, first.id);
  assert.equal(stopCalls, 1);
});

test("deterministic demo reaches completed with a named collaborator and an explicit local-only result", async () => {
  const run = createWorkbenchRun({
    prompt: "show the fixture timeline",
    source: "demo"
  });
  scheduleDemoRun(run.id);
  await wait(1_900);

  const completed = getWorkbenchRun(run.id);
  assert.ok(completed);
  assert.equal(completed.source, "demo");
  assert.equal(completed.status, "completed");
  assert.equal(completed.finalResult?.status, "completed");
  assert.equal(completed.finalResult?.summary, DEMO_FINAL_SUMMARY);
  assert.equal(
    completed.agents.some(
      (agent) => agent.role === "luna" && agent.label === "协作智能体 #1"
    ),
    true
  );
  assert.equal(completed.events.some((event) => event.liveExcerpt), false);
  assert.deepEqual(
    completed.plan?.steps.map((step) => ({ step: step.step, status: step.status })),
    [
      { step: "核对任务边界", status: "completed" },
      { step: "检查工具与文件变化", status: "completed" },
      { step: "整理安全答复", status: "completed" }
    ]
  );
  assert.equal(completed.finalResult?.summary.includes("未连接真实执行引擎"), true);
  assert.equal(completed.finalResult?.summary.includes("未执行任何外部写入"), true);
  assert.deepEqual(completed.artifacts.map((artifact) => artifact.relativePath), [
    "artifacts/demo-handoff.json"
  ]);
  assert.equal(
    completed.events.some((event) => event.summary?.includes("fixture 元数据")),
    true
  );
});
