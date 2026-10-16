import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  AGENT_CLIENT_SESSION_SCHEMA_VERSION,
  MAX_AGENT_JOURNAL_ENTRIES,
  appendCanonicalAppRoute,
  buildWorkbenchRunHandoffHref,
  buildDelegatedWorkbenchPrompt,
  buildWorkbenchDelegationInput,
  consumeCanonicalAppBackRoute,
  createTransientWorkbenchPrompt,
  createInitialAgentSessionState,
  executeLocalAppAction,
  filterForwardablePriorActionReceipts,
  isForwardablePriorActionType,
  loadAgentClientSession,
  persistAgentClientSession,
  reduceAgentSession,
  resolveTransientWorkbenchPrompt,
  resolveWorkbenchRestoreRunId,
  shouldPreserveCurrentPageNavigation,
  type AgentClientSessionState,
  type StorageLike
} from "../../lib/agent/client-session";

test("delegated Workbench handoff carries an exact recoverable run id", () => {
  const runId = "5918ad32-22d4-4809-8c02-8a40a373e756";
  assert.equal(
    buildWorkbenchRunHandoffHref(runId),
    `/workbench?run=${runId}`
  );
  assert.throws(() => buildWorkbenchRunHandoffHref("../../unsafe"));
  assert.equal(
    resolveWorkbenchRestoreRunId(runId, "540d1bfa-7d62-4894-ae3f-a7984908ba2f"),
    runId
  );
  assert.equal(
    resolveWorkbenchRestoreRunId("invalid", "540d1bfa-7d62-4894-ae3f-a7984908ba2f"),
    "540d1bfa-7d62-4894-ae3f-a7984908ba2f"
  );
});

test("the current browser session can show the exact delegated command only for its run", () => {
  const runId = "5918ad32-22d4-4809-8c02-8a40a373e756";
  const command = "切换到最近 7 天，聚焦连接最弱的学习者，然后给出三步核验计划。";
  const handoff = createTransientWorkbenchPrompt(runId, `  ${command}  `);

  assert.deepEqual(handoff, { runId, prompt: command });
  assert.equal(resolveTransientWorkbenchPrompt(handoff, runId), command);
  assert.equal(
    resolveTransientWorkbenchPrompt(
      handoff,
      "540d1bfa-7d62-4894-ae3f-a7984908ba2f"
    ),
    ""
  );
  assert.equal(createTransientWorkbenchPrompt("../../unsafe", command), null);
  assert.equal(createTransientWorkbenchPrompt(runId, "  "), null);
});

test("local app back consumes only a known canonical route and never uses browser history", () => {
  const calls: string[] = [];
  let history = appendCanonicalAppRoute([], "/");
  history = appendCanonicalAppRoute(history, "https://outside.example/previous");
  history = appendCanonicalAppRoute(history, "/workbench");
  const back = consumeCanonicalAppBackRoute(history);
  assert.equal(back.href, "/");
  assert.deepEqual(back.history, ["/"]);

  const runtime = {
    resolveBackHref: () => back.href,
    navigate: (href: string) => calls.push(`navigate:${href}`),
    refresh: () => calls.push("refresh")
  };

  assert.deepEqual(
    executeLocalAppAction({ id: "step-1", type: "app.go_back" }, runtime),
    {
      status: "completed",
      summary: "已返回站内上一页。",
      href: "/"
    }
  );
  assert.deepEqual(
    executeLocalAppAction({ id: "step-2", type: "app.refresh" }, runtime),
    {
      status: "completed",
      summary: "已请求刷新当前页面数据。"
    }
  );
  assert.deepEqual(calls, ["navigate:/", "refresh"]);
});

test("local app back is stably unavailable without an in-app predecessor", () => {
  const back = consumeCanonicalAppBackRoute(["/workbench"]);
  const calls: string[] = [];
  assert.equal(back.href, null);
  assert.deepEqual(
    executeLocalAppAction(
      { id: "step-1", type: "app.go_back" },
      {
        resolveBackHref: () => back.href,
        navigate: (href: string) => calls.push(href),
        refresh: () => calls.push("refresh")
      }
    ),
    {
      status: "unavailable",
      summary: "当前会话没有可安全返回的站内上一页。",
      errorCode: "APP_BACK_UNAVAILABLE"
    }
  );
  assert.deepEqual(calls, []);
});

test("AgentSessionProvider never delegates browser history to router.back", async () => {
  const source = await readFile(
    path.join(process.cwd(), "components", "agent", "AgentSessionProvider.tsx"),
    "utf8"
  );
  assert.doesNotMatch(source, /router\.back\s*\(/u);
  assert.match(source, /navigate:\s*\(href\)\s*=>\s*router\.push\(href\)/u);
});

test("same-page navigation keeps the existing query state for a following page action", () => {
  const navigate = {
    id: "step-1",
    type: "navigate" as const,
    routeId: "autonomy.world" as const,
    href: "/autonomy/world" as const,
    label: "社会网络"
  };
  const actions = [
    navigate,
    {
      id: "step-2",
      type: "world.focus_learner" as const,
      routeId: "autonomy.world" as const,
      learnerLabel: "学习者 07"
    }
  ];

  assert.equal(
    shouldPreserveCurrentPageNavigation({
      action: navigate,
      actions,
      index: 0,
      currentPathname: "/autonomy/world",
      currentBridgeRouteId: "autonomy.world"
    }),
    true
  );
});

test("same-page preservation does not swallow standalone navigation or cross-page navigation", () => {
  const navigate = {
    id: "step-1",
    type: "navigate" as const,
    routeId: "autonomy.world" as const,
    href: "/autonomy/world" as const,
    label: "社会网络"
  };

  assert.equal(
    shouldPreserveCurrentPageNavigation({
      action: navigate,
      actions: [navigate],
      index: 0,
      currentPathname: "/autonomy/world",
      currentBridgeRouteId: "autonomy.world"
    }),
    false
  );
  assert.equal(
    shouldPreserveCurrentPageNavigation({
      action: navigate,
      actions: [
        navigate,
        {
          id: "step-2",
          type: "world.set_view" as const,
          routeId: "autonomy.world" as const,
          view: "course_structure" as const
        }
      ],
      index: 0,
      currentPathname: "/workbench",
      currentBridgeRouteId: "autonomy.world"
    }),
    false
  );
  assert.equal(
    shouldPreserveCurrentPageNavigation({
      action: navigate,
      actions: [
        navigate,
        {
          id: "step-2",
          type: "world.set_window" as const,
          routeId: "autonomy.world" as const,
          window: "rolling_7d" as const
        }
      ],
      index: 0,
      currentPathname: "/autonomy/world",
      currentBridgeRouteId: null
    }),
    false
  );
});

test("delegated prompt carries verified local action receipts into the Workbench turn", () => {
  const prompt = buildDelegatedWorkbenchPrompt(
    "制定支持计划",
    {
      ref: "learner:snapshot-safe__actor-008",
      title: "成员 08",
      sourceHref: "/autonomy/world?focus=actor-008"
    },
    [
      {
        actionType: "navigate",
        status: "completed",
        summary: "已打开社会网络",
        containsForumText: false,
        externalWrites: false
      },
      {
        actionType: "world.focus_weakest",
        status: "completed",
        summary: "已按当前可观察下界聚焦成员 08",
        containsForumText: false,
        externalWrites: false
      },
      {
        actionType: "context.attach_focused",
        status: "completed",
        summary: "已加入匿名学习者上下文 token=secret-value",
        contextRef: "learner:snapshot-safe__actor-008",
        containsForumText: false,
        externalWrites: false
      }
    ]
  );

  assert.match(prompt, /页面动作回执/);
  assert.match(prompt, /已打开社会网络/);
  assert.match(prompt, /已按当前可观察下界聚焦成员 08/);
  assert.match(prompt, /上述动作.*已完成/);
  assert.match(prompt, /当前已附加安全页面上下文：成员 08/);
  assert.match(prompt, /制定支持计划/);
  assert.doesNotMatch(prompt, /secret-value/);
});

test("non-attested v3 actions are never forwarded as verified prior-action receipts", () => {
  const blockedTypes = [
    "app.go_back",
    "app.refresh",
    "workbench.stop",
    "platform.inspect_readiness"
  ] as const;
  for (const actionType of blockedTypes) {
    assert.equal(isForwardablePriorActionType(actionType), false, actionType);
  }
  assert.equal(isForwardablePriorActionType("world.focus_weakest"), true);

  const receipts = [
    ...blockedTypes.map((actionType) => ({
      actionType,
      status: "completed" as const,
      summary: `不得转交 ${actionType}`,
      containsForumText: false as const,
      externalWrites: false as const
    })),
    {
      actionType: "world.focus_weakest" as const,
      status: "completed" as const,
      summary: "已回读匿名学习者焦点",
      containsForumText: false as const,
      externalWrites: false as const
    }
  ];

  assert.deepEqual(
    filterForwardablePriorActionReceipts(receipts).map(({ actionType }) => actionType),
    ["world.focus_weakest"]
  );
  assert.deepEqual(
    buildWorkbenchDelegationInput(
      "继续分析",
      "default",
      false,
      null,
      receipts
    ).priorActionReceipts?.map(({ actionType }) => actionType),
    ["world.focus_weakest"]
  );
  const prompt = buildDelegatedWorkbenchPrompt("继续分析", null, receipts);
  assert.match(prompt, /已回读匿名学习者焦点/u);
  for (const actionType of blockedTypes) {
    assert.doesNotMatch(prompt, new RegExp(actionType.replace(".", "\\."), "u"));
  }
});

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  value(key: string): string | undefined {
    return this.values.get(key);
  }
}

test("agent session reducer exposes command and action progress without retaining a completed draft", () => {
  let state = createInitialAgentSessionState();
  state = reduceAgentSession(state, { type: "hydrate", snapshot: null });
  state = reduceAgentSession(state, { type: "set_draft", draft: "打开社会网络" });
  state = reduceAgentSession(state, {
    type: "command_started",
    commandId: "command-1",
    actions: [
      { id: "action-1", kind: "navigate", label: "打开社会网络" },
      { id: "action-2", kind: "world.focus_learner", label: "定位互动较弱的学习者" }
    ]
  });

  assert.equal(state.phase, "running");
  assert.equal(state.draft, "");
  assert.deepEqual(state.journal.map((entry) => entry.status), ["running", "queued"]);

  state = reduceAgentSession(state, {
    type: "action_completed",
    actionId: "action-1",
    summary: "已打开社会网络"
  });
  assert.deepEqual(state.journal.map((entry) => entry.status), ["completed", "running"]);

  state = reduceAgentSession(state, {
    type: "command_completed",
    summary: "已定位学习者并加入当前上下文"
  });
  assert.equal(state.phase, "completed");
  assert.equal(state.journal[1]?.status, "completed");
  assert.equal(state.summary, "已定位学习者并加入当前上下文");
});

test("agent session reducer keeps a failed action visible and makes the session retryable", () => {
  let state = reduceAgentSession(createInitialAgentSessionState(), {
    type: "command_started",
    commandId: "command-2",
    actions: [{ id: "action-2", kind: "delegate", label: "交给智能控制台继续处理" }]
  });
  state = reduceAgentSession(state, {
    type: "action_failed",
    actionId: "action-2",
    message: "本机执行引擎暂不可用"
  });

  assert.equal(state.phase, "failed");
  assert.equal(state.error, "本机执行引擎暂不可用");
  assert.equal(state.journal[0]?.status, "failed");

  state = reduceAgentSession(state, { type: "reset_after_failure" });
  assert.equal(state.phase, "idle");
  assert.equal(state.error, "");
  assert.equal(state.journal[0]?.status, "failed");
});

test("a retry advances only the new command journal", () => {
  let state = reduceAgentSession(createInitialAgentSessionState(), {
    type: "command_started",
    commandId: "command-old",
    actions: [
      { id: "step-1", kind: "navigate", label: "旧动作一" },
      { id: "step-2", kind: "delegate", label: "旧动作二" }
    ]
  });
  state = reduceAgentSession(state, {
    type: "action_failed",
    actionId: "step-1",
    message: "旧任务失败"
  });
  state = reduceAgentSession(state, { type: "reset_after_failure" });
  state = reduceAgentSession(state, {
    type: "command_started",
    commandId: "command-new",
    actions: [{ id: "step-1", kind: "navigate", label: "新动作" }]
  });
  state = reduceAgentSession(state, {
    type: "action_completed",
    actionId: "step-1",
    summary: "新动作完成"
  });
  state = reduceAgentSession(state, {
    type: "command_completed",
    summary: "新任务完成"
  });

  assert.deepEqual(
    state.journal.map((entry) => [entry.id, entry.status]),
    [
      ["step-1", "failed"],
      ["step-2", "queued"],
      ["step-1", "completed"]
    ]
  );
});

test("session persistence is bounded, versioned, and omits drafts, prompts, and unsafe fields", () => {
  const storage = new MemoryStorage();
  const initial = createInitialAgentSessionState();
  const journal: AgentClientSessionState["journal"] = Array.from(
    { length: MAX_AGENT_JOURNAL_ENTRIES + 7 },
    (_, index) => ({
      id: `action-${index}`,
      commandId: "command-private",
      kind: "navigate",
      label: `动作 ${index}`,
      status: "completed" as const,
      summary: index === 0 ? "token=secret-value user@example.test" : `已完成 ${index}`,
      at: `2026-08-11T00:00:${String(index).padStart(2, "0")}Z`
    })
  );
  const state: AgentClientSessionState = {
    ...initial,
    hydrated: true,
    draft: "这里是不可持久化的原始任务正文",
    summary: "带有 Cookie=private-value 的摘要",
    journal,
    attachment: {
      ref: "learner:anonymous-7",
      title: "匿名学习者 7",
      sourceHref: "/autonomy/world"
    }
  };

  persistAgentClientSession(storage, state);
  const raw = storage.value("cmooc.agent.client-session.v1");
  assert.ok(raw);
  assert.doesNotMatch(raw, /不可持久化的原始任务正文|secret-value|private-value|example\.test/);

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(parsed.schemaVersion, AGENT_CLIENT_SESSION_SCHEMA_VERSION);
  assert.equal(Object.hasOwn(parsed, "draft"), false);
  assert.equal(Object.hasOwn(parsed, "prompt"), false);

  const restored = loadAgentClientSession(storage);
  assert.equal(restored?.journal.length, MAX_AGENT_JOURNAL_ENTRIES);
  assert.equal(restored?.journal[0]?.id, "action-7");
  assert.equal(restored?.attachment?.ref, "learner:anonymous-7");
});

test("session loading rejects stale or malformed payloads without throwing", () => {
  const storage = new MemoryStorage();
  storage.setItem("cmooc.agent.client-session.v1", JSON.stringify({
    schemaVersion: "cmooc.agent.client-session.v0",
    journal: [{ status: "completed" }]
  }));
  assert.equal(loadAgentClientSession(storage), null);

  storage.setItem("cmooc.agent.client-session.v1", "{not-json");
  assert.equal(loadAgentClientSession(storage), null);
});

test("session loading marks actions interrupted by a page reload as retryable failures", () => {
  const storage = new MemoryStorage();
  persistAgentClientSession(storage, {
    ...createInitialAgentSessionState(),
    journal: [
      {
        id: "step-1",
        commandId: "command-reload",
        kind: "navigate",
        label: "打开社会网络",
        status: "running",
        at: "2026-08-11T01:00:00.000Z"
      },
      {
        id: "step-2",
        commandId: "command-reload",
        kind: "world.focus_weakest",
        label: "定位学习者",
        status: "queued",
        at: "2026-08-11T01:00:00.000Z"
      }
    ]
  });

  const restored = loadAgentClientSession(storage);
  assert.deepEqual(restored?.journal.map((entry) => entry.status), ["failed", "failed"]);
  assert.match(restored?.journal[0]?.summary ?? "", /刷新|中断/);
});

test("session persistence accepts a structured learner ref with a long snapshot id", () => {
  const storage = new MemoryStorage();
  const learnerRef = "learner:cm0verylongsnapshotidentifier123456789__actor-001";
  persistAgentClientSession(storage, {
    ...createInitialAgentSessionState(),
    attachment: {
      ref: learnerRef,
      title: "匿名学习者 001",
      sourceHref: "/autonomy/world?view=learner_position"
    }
  });

  assert.equal(loadAgentClientSession(storage)?.attachment?.ref, learnerRef);
});

test("session persistence drops a source href that resembles a credential-bearing URL", () => {
  const storage = new MemoryStorage();
  persistAgentClientSession(storage, {
    ...createInitialAgentSessionState(),
    attachment: {
      ref: "learner:snapshot-safe__actor-001",
      title: "匿名学习者 001",
      sourceHref: "/autonomy/world?token=secret-value"
    }
  });

  assert.deepEqual(loadAgentClientSession(storage)?.attachment, {
    ref: "learner:snapshot-safe__actor-001",
    title: "匿名学习者 001"
  });
});

test("workbench delegation carries the typed attachment instead of relying on prompt text", () => {
  assert.deepEqual(
    buildWorkbenchDelegationInput(
      "制定支持计划",
      "plan",
      true,
      {
        ref: "learner:cm0verylongsnapshotidentifier123456789__actor-001",
        title: "匿名学习者 001",
        sourceHref: "/autonomy/world"
      },
      [{
        actionType: "navigate",
        status: "completed",
        summary: "已打开社会网络",
        containsForumText: false,
        externalWrites: false
      }]
    ),
    {
      prompt: "制定支持计划",
      mode: "live",
      collaborationMode: "plan",
      goalMode: true,
      contextRef: "learner:cm0verylongsnapshotidentifier123456789__actor-001",
      intent: "implement",
      priorActionReceipts: [{
        actionType: "navigate",
        status: "completed",
        summary: "已打开社会网络",
        containsForumText: false,
        externalWrites: false
      }]
    }
  );
});
