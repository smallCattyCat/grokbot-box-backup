import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkbenchPageBridgeState,
  executeWorkbenchPageAction,
  transitionWorkbenchPageAction,
  type WorkbenchPageActionRuntimeState
} from "../../lib/agent/workbench-page-actions";

function runtime(
  input: Partial<WorkbenchPageActionRuntimeState> = {}
): WorkbenchPageActionRuntimeState {
  return {
    surface: "conversation",
    collaborationMode: "default",
    goalMode: false,
    historyOpen: false,
    runStatus: "idle",
    canStop: false,
    stopPending: false,
    revision: 1,
    ...input
  };
}

test("Workbench bridge state exposes local zero-write controls without task content", () => {
  const state = createWorkbenchPageBridgeState(runtime());

  assert.equal(state.routeId, "workbench");
  assert.equal(state.href, "/workbench");
  assert.deepEqual(state.capabilities, [
    "workbench.show_surface",
    "workbench.set_mode",
    "workbench.set_goal",
    "workbench.stop"
  ]);
  assert.deepEqual(state.metadata, {
    surface: "conversation",
    collaborationMode: "default",
    goalMode: false,
    historyOpen: false,
    runStatus: "idle",
    canStop: false,
    stopPending: false
  });
  assert.equal(state.containsForumText, false);
  assert.equal(state.externalWrites, false);
  assert.equal(JSON.stringify(state).includes("prompt"), false);
});

test("Workbench surface actions deterministically open tabs or the history drawer", () => {
  const schedule = transitionWorkbenchPageAction({
    current: runtime(),
    action: {
      id: "step-1",
      type: "workbench.show_surface",
      routeId: "workbench",
      surface: "schedule"
    }
  });
  assert.equal(schedule.outcome.status, "completed");
  assert.deepEqual(schedule.next, runtime({
    surface: "schedule",
    historyOpen: false,
    revision: 2
  }));

  const history = transitionWorkbenchPageAction({
    current: schedule.next,
    action: {
      id: "step-2",
      type: "workbench.show_surface",
      routeId: "workbench",
      surface: "history"
    }
  });
  assert.equal(history.outcome.status, "completed");
  assert.equal(history.next.surface, "schedule");
  assert.equal(history.next.historyOpen, true);
  assert.equal(history.next.revision, 3);

  const conversation = transitionWorkbenchPageAction({
    current: history.next,
    action: {
      id: "step-3",
      type: "workbench.show_surface",
      routeId: "workbench",
      surface: "conversation"
    }
  });
  assert.equal(conversation.next.surface, "conversation");
  assert.equal(conversation.next.historyOpen, false);
});

test("Workbench mode and goal actions only change the next-task controls", () => {
  const planMode = transitionWorkbenchPageAction({
    current: runtime({ runStatus: "running" }),
    action: {
      id: "step-1",
      type: "workbench.set_mode",
      routeId: "workbench",
      mode: "plan"
    }
  });
  assert.equal(planMode.next.collaborationMode, "plan");
  assert.equal(planMode.next.runStatus, "running");
  assert.match(planMode.outcome.summary, /下一任务/u);

  const goal = transitionWorkbenchPageAction({
    current: planMode.next,
    action: {
      id: "step-2",
      type: "workbench.set_goal",
      routeId: "workbench",
      enabled: true
    }
  });
  assert.equal(goal.next.goalMode, true);
  assert.equal(goal.next.revision, 3);
  assert.equal(goal.outcome.state?.externalWrites, false);
});

const stopAction = {
  id: "step-stop",
  type: "workbench.stop" as const,
  routeId: "workbench" as const
};

test("active Workbench stop waits for the server readback before claiming completion", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stopCalls = 0;
  let settled = false;

  const stopping = executeWorkbenchPageAction({
    current: runtime({ runStatus: "running", canStop: true }),
    action: stopAction,
    stopCurrentRun: async () => {
      stopCalls += 1;
      await gate;
      return { runStatus: "stopped", canStop: false };
    }
  }).then((result) => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  assert.equal(stopCalls, 1);
  assert.equal(settled, false);
  release();

  const result = await stopping;
  assert.equal(result.outcome.status, "completed");
  assert.match(result.outcome.summary, /已停止/u);
  assert.equal(result.next.runStatus, "stopped");
  assert.equal(result.next.canStop, false);
  assert.equal(result.next.stopPending, false);
  assert.equal(result.next.revision, 2);
  assert.equal(result.outcome.state?.metadata?.runStatus, "stopped");
});

test("idle and terminal Workbench stops are honest idempotent no-ops", async () => {
  const cases = [
    ["idle", /当前页面没有活动任务/u],
    ["completed", /已经完成/u],
    ["failed", /已经失败/u],
    ["stopped", /已经停止/u]
  ] as const;

  for (const [runStatus, expectedSummary] of cases) {
    let stopCalls = 0;
    const current = runtime({ runStatus, canStop: false, revision: 7 });
    const result = await executeWorkbenchPageAction({
      current,
      action: stopAction,
      stopCurrentRun: async () => {
        stopCalls += 1;
        return { runStatus: "stopped", canStop: false };
      }
    });

    assert.equal(result.outcome.status, "completed", runStatus);
    assert.match(result.outcome.summary, expectedSummary, runStatus);
    if (runStatus === "completed" || runStatus === "failed") {
      assert.doesNotMatch(result.outcome.summary, /已停止/u, runStatus);
    }
    assert.equal(stopCalls, 0, runStatus);
    assert.deepEqual(result.next, current, runStatus);
  }
});

test("a completion or failure race is reported as observed and never rewritten as stopped", async () => {
  for (const [runStatus, expectedSummary] of [
    ["completed", /停止请求处理期间已经完成/u],
    ["failed", /停止请求处理期间已经失败/u]
  ] as const) {
    const result = await executeWorkbenchPageAction({
      current: runtime({ runStatus: "running", canStop: true }),
      action: stopAction,
      stopCurrentRun: async () => ({ runStatus, canStop: false })
    });

    assert.equal(result.outcome.status, "completed", runStatus);
    assert.match(result.outcome.summary, expectedSummary, runStatus);
    assert.doesNotMatch(result.outcome.summary, /已停止/u, runStatus);
    assert.equal(result.next.runStatus, runStatus);
    assert.equal(result.outcome.state?.metadata?.runStatus, runStatus);
  }
});

test("stop does not claim success when the server has no terminal readback", async () => {
  for (const readback of [
    null,
    { runStatus: "running" as const, canStop: true }
  ]) {
    const result = await executeWorkbenchPageAction({
      current: runtime({ runStatus: "running", canStop: true }),
      action: stopAction,
      stopCurrentRun: async () => readback
    });

    assert.equal(result.outcome.status, "failed");
    assert.equal(result.outcome.retryable, true);
    assert.doesNotMatch(result.outcome.summary, /已停止/u);
  }
});
