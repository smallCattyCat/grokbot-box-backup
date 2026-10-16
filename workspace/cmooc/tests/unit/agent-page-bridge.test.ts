import assert from "node:assert/strict";
import test from "node:test";
import type {
  ContextAttachFocusedAction,
  WorldFocusWeakestAction
} from "../../lib/agent/command-planner";
import {
  executePageAction,
  readPageBridgeState,
  registerPageBridge,
  waitForPageBridge,
  type PageBridgeContext,
  type PageBridgeState
} from "../../lib/agent/page-bridge";

const focusAction: WorldFocusWeakestAction = {
  id: "step-1",
  type: "world.focus_weakest",
  routeId: "autonomy.world",
  strategy: "lowest_observable_connections",
  window: "current_observable"
};

const attachAction: ContextAttachFocusedAction = {
  id: "step-2",
  type: "context.attach_focused",
  routeId: "autonomy.world",
  contextKind: "learner"
};

const focusedContext: PageBridgeContext = {
  kind: "learner",
  id: "learner-weakest",
  label: "学习者 07",
  title: "当前可观察连接最弱",
  sourceHref: "/autonomy/world",
  summary: "当前窗口内可观察连接为 1",
  containsIdentity: false,
  containsForumText: false
};

function worldState(revision = 1): PageBridgeState {
  return {
    schemaVersion: "cmooc.page-bridge-state.v1",
    routeId: "autonomy.world",
    href: "/autonomy/world",
    status: "ready",
    capabilities: ["world.focus_weakest", "context.attach_focused"],
    revision,
    summary: "社会网络已就绪",
    focusedContext,
    attachedContexts: [],
    metadata: {
      view: "learner_position",
      observedConnectionCount: 1
    },
    containsForumText: false,
    externalWrites: false
  };
}

function installBrowserWindow(): () => void {
  const host = globalThis as unknown as Record<string, unknown>;
  const hadWindow = Object.prototype.hasOwnProperty.call(host, "window");
  const previous = host["window"];
  host["window"] = {};
  return () => {
    if (!hadWindow) {
      delete host["window"];
    } else {
      host["window"] = previous;
    }
  };
}

test("page bridge is SSR-safe when no browser window exists", async () => {
  assert.equal(readPageBridgeState("autonomy.world"), null);
  assert.equal(await waitForPageBridge("autonomy.world", { timeoutMs: 5 }), null);

  const result = await executePageAction(focusAction);
  assert.deepEqual(result, {
    schemaVersion: "cmooc.page-action-result.v1",
    actionId: "step-1",
    actionType: "world.focus_weakest",
    routeId: "autonomy.world",
    status: "unavailable",
    summary: "目标页面尚未就绪。",
    retryable: true,
    errorCode: "PAGE_BRIDGE_UNAVAILABLE",
    containsForumText: false,
    externalWrites: false
  });
});

test("register, readState and execute return structured local-only results", async () => {
  const restoreWindow = installBrowserWindow();
  try {
    let state = worldState();
    const unregister = registerPageBridge({
      routeId: "autonomy.world",
      capabilities: ["world.focus_weakest", "context.attach_focused"],
      readState: () => state,
      execute: (action) => {
        assert.equal(action.type, "world.focus_weakest");
        state = worldState(2);
        return {
          status: "completed",
          summary: "已聚焦当前可观察连接最弱的学习者。",
          context: focusedContext,
          state
        };
      }
    });

    assert.equal(readPageBridgeState("autonomy.world")?.revision, 1);
    assert.equal((await waitForPageBridge("autonomy.world"))?.revision, 1);

    const result = await executePageAction(focusAction);
    assert.equal(result.status, "completed");
    assert.equal(result.routeId, "autonomy.world");
    assert.equal(result.context?.id, "learner-weakest");
    assert.equal(result.state?.revision, 2);
    assert.equal(result.containsForumText, false);
    assert.equal(result.externalWrites, false);

    unregister();
    assert.equal(readPageBridgeState("autonomy.world"), null);
  } finally {
    restoreWindow();
  }
});

test("waitForPageBridge observes delayed registration and times out cleanly", async () => {
  const restoreWindow = installBrowserWindow();
  try {
    const waiting = waitForPageBridge("autonomy.world", { timeoutMs: 100 });
    const unregister = registerPageBridge({
      routeId: "autonomy.world",
      capabilities: ["world.focus_weakest", "context.attach_focused"],
      readState: () => worldState(3),
      execute: () => ({ status: "completed", summary: "完成" })
    });

    assert.equal((await waiting)?.revision, 3);
    unregister();
    assert.equal(
      await waitForPageBridge("autonomy.world", { timeoutMs: 5 }),
      null
    );
  } finally {
    restoreWindow();
  }
});

test("unsupported actions and adapter failures become stable non-throwing outcomes", async () => {
  const restoreWindow = installBrowserWindow();
  try {
    let unregister = registerPageBridge({
      routeId: "autonomy.world",
      capabilities: ["world.focus_weakest"],
      readState: () => worldState(),
      execute: () => ({ status: "completed", summary: "unexpected" })
    });
    const unsupported = await executePageAction(attachAction);
    assert.equal(unsupported.status, "unsupported");
    assert.equal(unsupported.errorCode, "PAGE_ACTION_UNSUPPORTED");
    assert.equal(unsupported.retryable, false);
    unregister();

    unregister = registerPageBridge({
      routeId: "autonomy.world",
      capabilities: ["world.focus_weakest"],
      readState: () => worldState(),
      execute: () => {
        throw new Error("private raw page detail");
      }
    });
    const failed = await executePageAction(focusAction);
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "PAGE_BRIDGE_EXECUTION_FAILED");
    assert.equal(failed.summary.includes("private raw"), false);
    assert.equal(failed.containsForumText, false);
    unregister();
  } finally {
    restoreWindow();
  }
});

test("bridge rejects an off-site context returned by a page adapter", async () => {
  const restoreWindow = installBrowserWindow();
  try {
    const unregister = registerPageBridge({
      routeId: "autonomy.world",
      capabilities: ["world.focus_weakest"],
      readState: () => worldState(),
      execute: () => ({
        status: "completed",
        summary: "unexpected",
        context: {
          ...focusedContext,
          sourceHref: "https://outside.example.test/learner"
        } as PageBridgeContext
      })
    });

    const result = await executePageAction(focusAction);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "PAGE_BRIDGE_UNSAFE_RESULT");
    assert.equal(result.context, undefined);
    unregister();
  } finally {
    restoreWindow();
  }
});

test("bridge readback rejects states that do not preserve zero-write and body-free facts", () => {
  const restoreWindow = installBrowserWindow();
  try {
    const unregister = registerPageBridge({
      routeId: "autonomy.world",
      capabilities: ["world.focus_weakest"],
      readState: () => ({
        ...worldState(),
        containsForumText: true,
        externalWrites: true
      } as unknown as PageBridgeState),
      execute: () => ({ status: "completed", summary: "unexpected" })
    });

    assert.equal(readPageBridgeState("autonomy.world"), null);
    unregister();
  } finally {
    restoreWindow();
  }
});

test("an older cleanup cannot unregister a newer page bridge", () => {
  const restoreWindow = installBrowserWindow();
  try {
    const unregisterOld = registerPageBridge({
      routeId: "autonomy.world",
      capabilities: ["world.focus_weakest"],
      readState: () => worldState(1),
      execute: () => ({ status: "completed", summary: "old" })
    });
    const unregisterNew = registerPageBridge({
      routeId: "autonomy.world",
      capabilities: ["world.focus_weakest"],
      readState: () => worldState(9),
      execute: () => ({ status: "completed", summary: "new" })
    });

    unregisterOld();
    assert.equal(readPageBridgeState("autonomy.world")?.revision, 9);
    unregisterNew();
  } finally {
    restoreWindow();
  }
});
