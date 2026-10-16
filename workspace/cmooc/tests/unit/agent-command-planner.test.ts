import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_ROUTES,
  isCanonicalAppHref,
  normalizeAppHref,
  resolveAppRoute
} from "../../lib/agent/app-routes";
import {
  AGENT_COMMAND_PLAN_VERSION,
  hasLocalPageActions,
  inferCommandModes,
  planAgentCommand
} from "../../lib/agent/command-planner";

test("canonical app routes resolve Chinese aliases without accepting arbitrary URLs", () => {
  assert.equal(resolveAppRoute("社会网络")?.id, "autonomy.world");
  assert.equal(resolveAppRoute("智能控制台")?.href, "/workbench");
  assert.equal(resolveAppRoute("结果观察")?.id, "autonomy.outcomes");
  assert.equal(normalizeAppHref("课程治理"), "/autonomy/governance");

  assert.equal(isCanonicalAppHref("/autonomy/world"), true);
  assert.equal(isCanonicalAppHref("/autonomy/world?course=secret"), false);
  assert.equal(isCanonicalAppHref("https://example.test/workbench"), false);
  assert.equal(isCanonicalAppHref("//example.test/workbench"), false);
  assert.equal(isCanonicalAppHref("/workbench/../settings"), false);
  assert.equal(resolveAppRoute("https://example.test/社会网络"), null);
  assert.equal(normalizeAppHref("/not-a-real-page"), null);

  assert.equal(
    new Set(APP_ROUTES.map((route) => route.href)).size,
    APP_ROUTES.length
  );
});

test("a simple route command stays local and uses a canonical href", () => {
  const plan = planAgentCommand("打开结果观察");

  assert.equal(plan.schemaVersion, AGENT_COMMAND_PLAN_VERSION);
  assert.equal(AGENT_COMMAND_PLAN_VERSION, "cmooc.agent-command-plan.v3");
  assert.equal(plan.kind, "local");
  assert.equal(plan.collaborationMode, "default");
  assert.equal(plan.goalMode, false);
  assert.equal(hasLocalPageActions(plan), true);
  assert.deepEqual(plan.actions, [
    {
      id: "step-1",
      type: "navigate",
      routeId: "autonomy.outcomes",
      href: "/autonomy/outcomes",
      label: "结果观察"
    }
  ]);
});

test("the product home route is available to natural-language navigation", () => {
  const plan = planAgentCommand("回到首页");
  assert.deepEqual(plan.actions, [
    {
      id: "step-1",
      type: "navigate",
      routeId: "home",
      href: "/",
      label: "产品总览"
    }
  ]);

  const workbenchPath = planAgentCommand("打开/workbench");
  assert.deepEqual(
    workbenchPath.actions.map((action) =>
      action.type === "navigate" ? action.routeId : action.type
    ),
    ["workbench"]
  );
});

test("unknown and long-tail commands delegate instead of being rejected", () => {
  const command = "比较最近两轮学习网络变化并解释可能原因";
  const plan = planAgentCommand(command);

  assert.equal(plan.kind, "delegated");
  assert.equal(hasLocalPageActions(plan), false);
  assert.deepEqual(plan.actions, [
    {
      id: "step-1",
      type: "workbench.delegate",
      prompt: command,
      collaborationMode: "default",
      goalMode: false,
      contextFromPreviousActions: false
    }
  ]);
  assert.deepEqual(plan.safety, {
    localOnly: true,
    externalReads: false,
    externalWrites: false,
    requiresConfirmation: false
  });
});

test("route nouns inside implementation work do not trigger accidental navigation", () => {
  for (const command of [
    "修复设置页面的类型错误",
    "分析测试结果并给出修复",
    "重构平台组件并运行测试"
  ]) {
    const plan = planAgentCommand(command);
    assert.equal(plan.kind, "delegated");
    assert.deepEqual(
      plan.actions.map((action) => action.type),
      ["workbench.delegate"]
    );
  }

  assert.deepEqual(
    planAgentCommand("打开设置").actions.map((action) => action.type),
    ["navigate"]
  );
  assert.deepEqual(
    planAgentCommand("去结果观察").actions.map((action) => action.type),
    ["navigate"]
  );
});

test("planning and persistent language infer Workbench collaboration modes", () => {
  assert.deepEqual(inferCommandModes("先规划一下再修复控制台"), {
    collaborationMode: "plan",
    goalMode: false
  });
  assert.deepEqual(inferCommandModes("持续跟进这个问题，直到测试通过"), {
    collaborationMode: "default",
    goalMode: true
  });
  assert.deepEqual(inferCommandModes("修复持续出现的遮挡问题"), {
    collaborationMode: "default",
    goalMode: false
  });
  assert.deepEqual(inferCommandModes("优化课程规划页面的布局"), {
    collaborationMode: "default",
    goalMode: false
  });

  const combined = planAgentCommand("先制定计划，并持续优化消息体验直到完成");
  const delegate = combined.actions.at(-1);
  assert.equal(delegate?.type, "workbench.delegate");
  if (delegate?.type !== "workbench.delegate") {
    assert.fail("expected delegated Workbench action");
  }
  assert.equal(delegate.collaborationMode, "plan");
  assert.equal(delegate.goalMode, true);
});

test("cross-route weakest-learner command produces a deterministic verified sequence", () => {
  const command =
    "去社会网络找到当前可观察连接最弱的学习者，把他加入当前上下文，然后回到控制台制定支持计划";
  const plan = planAgentCommand(command);

  assert.equal(plan.kind, "hybrid");
  assert.equal(plan.collaborationMode, "plan");
  assert.equal(plan.goalMode, false);
  assert.equal(hasLocalPageActions(plan), true);
  assert.deepEqual(
    plan.actions.map((action) => action.type),
    [
      "navigate",
      "world.focus_weakest",
      "context.attach_focused",
      "navigate",
      "workbench.delegate"
    ]
  );

  const [worldNavigation, focus, attach, returnNavigation, delegate] =
    plan.actions;
  assert.deepEqual(worldNavigation, {
    id: "step-1",
    type: "navigate",
    routeId: "autonomy.world",
    href: "/autonomy/world",
    label: "社会网络"
  });
  assert.deepEqual(focus, {
    id: "step-2",
    type: "world.focus_weakest",
    routeId: "autonomy.world",
    strategy: "lowest_observable_connections",
    window: "current_observable"
  });
  assert.deepEqual(attach, {
    id: "step-3",
    type: "context.attach_focused",
    routeId: "autonomy.world",
    contextKind: "learner"
  });
  assert.deepEqual(returnNavigation, {
    id: "step-4",
    type: "navigate",
    routeId: "workbench",
    href: "/workbench",
    label: "智能控制台"
  });
  assert.deepEqual(delegate, {
    id: "step-5",
    type: "workbench.delegate",
    prompt: command,
    collaborationMode: "plan",
    goalMode: false,
    contextFromPreviousActions: true
  });
});

test("weakest-learner intent enters the world page even when the route is implicit", () => {
  const plan = planAgentCommand("找到互动连接最少的学习者");

  assert.deepEqual(
    plan.actions.map((action) => action.type),
    ["navigate", "world.focus_weakest"]
  );
  assert.equal(plan.kind, "local");
});

test("compound world commands cover every local clause instead of silently dropping the tail", () => {
  const plan = planAgentCommand(
    "打开社会网络，切换到最近7天并查看课程结构"
  );

  assert.equal(plan.kind, "local");
  assert.deepEqual(
    plan.actions.map((action) => action.type),
    ["navigate", "world.set_window", "world.set_view"]
  );
  assert.deepEqual(plan.coverage, {
    status: "complete",
    recognizedActionIds: ["step-1", "step-2", "step-3"],
    residual: ""
  });
  assert.deepEqual(plan.actions[1], {
    id: "step-2",
    type: "world.set_window",
    routeId: "autonomy.world",
    window: "rolling_7d"
  });
  assert.deepEqual(plan.actions[2], {
    id: "step-3",
    type: "world.set_view",
    routeId: "autonomy.world",
    view: "course_structure"
  });
});

test("a named anonymous learner becomes a typed world action", () => {
  const plan = planAgentCommand("打开社会网络并选择学习者07");

  assert.equal(plan.kind, "local");
  assert.deepEqual(plan.actions, [
    {
      id: "step-1",
      type: "navigate",
      routeId: "autonomy.world",
      href: "/autonomy/world",
      label: "社会网络"
    },
    {
      id: "step-2",
      type: "world.focus_learner",
      routeId: "autonomy.world",
      learnerLabel: "学习者 07"
    }
  ]);
  assert.equal(plan.coverage.status, "complete");
  assert.equal(plan.coverage.residual, "");
});

test("Workbench surface and mode commands stay local and use the page bridge", () => {
  const cases = [
    ["打开周期运行", "workbench.show_surface", "schedule"],
    ["回到任务对话", "workbench.show_surface", "conversation"],
    ["打开任务历史", "workbench.show_surface", "history"],
    ["切换到计划模式", "workbench.set_mode", "plan"],
    ["切换到默认模式", "workbench.set_mode", "default"],
    ["开启持续目标", "workbench.set_goal", true],
    ["关闭持续目标", "workbench.set_goal", false]
  ] as const;

  for (const [command, actionType, value] of cases) {
    const plan = planAgentCommand(command);
    assert.equal(plan.kind, "local", command);
    assert.equal(plan.actions[0]?.type, "navigate", command);
    assert.equal(
      plan.actions[0]?.type === "navigate" && plan.actions[0].routeId,
      "workbench",
      command
    );
    const pageAction = plan.actions[1];
    assert.equal(pageAction?.type, actionType, command);
    if (pageAction?.type === "workbench.show_surface") {
      assert.equal(pageAction.surface, value, command);
    } else if (pageAction?.type === "workbench.set_mode") {
      assert.equal(pageAction.mode, value, command);
    } else if (pageAction?.type === "workbench.set_goal") {
      assert.equal(pageAction.enabled, value, command);
    }
    assert.equal(plan.coverage.status, "complete", command);
  }
});

test("meaningful residual work is delegated after verified local actions", () => {
  const command =
    "打开社会网络，切换到最近7天并查看课程结构，再解释变化原因";
  const plan = planAgentCommand(command);

  assert.equal(plan.kind, "hybrid");
  assert.deepEqual(
    plan.actions.map((action) => action.type),
    [
      "navigate",
      "world.set_window",
      "world.set_view",
      "workbench.delegate"
    ]
  );
  assert.equal(plan.coverage.status, "partial");
  assert.match(plan.coverage.residual, /解释变化原因/u);
  assert.deepEqual(plan.coverage.recognizedActionIds, [
    "step-1",
    "step-2",
    "step-3"
  ]);
});

test("a delegated command reports its entire request as uncovered local work", () => {
  const command = "比较最近两轮学习网络变化并解释可能原因";
  const plan = planAgentCommand(command);

  assert.deepEqual(plan.coverage, {
    status: "delegated",
    recognizedActionIds: [],
    residual: command
  });
});

test("browser back and refresh commands remain typed local actions", () => {
  const back = planAgentCommand("返回上一页");
  assert.equal(back.kind, "local");
  assert.deepEqual(back.actions, [
    {
      id: "step-1",
      type: "app.go_back"
    }
  ]);
  assert.deepEqual(back.coverage, {
    status: "complete",
    recognizedActionIds: ["step-1"],
    residual: ""
  });

  for (const command of ["刷新", "刷新当前页面", "重新加载页面"]) {
    const refresh = planAgentCommand(command);
    assert.equal(refresh.kind, "local", command);
    assert.deepEqual(refresh.actions, [
      {
        id: "step-1",
        type: "app.refresh"
      }
    ], command);
    assert.equal(refresh.coverage.status, "complete", command);
    assert.equal(refresh.safety.externalReads, false, command);
  }
});

test("stopping the current Workbench run is typed without matching negated or implementation language", () => {
  for (const command of ["停止当前任务", "停止运行", "终止这个控制台任务"]) {
    const plan = planAgentCommand(command);
    assert.equal(plan.kind, "local", command);
    assert.deepEqual(
      plan.actions.map((action) => action.type),
      ["navigate", "workbench.stop"],
      command
    );
    assert.deepEqual(plan.actions[1], {
      id: "step-2",
      type: "workbench.stop",
      routeId: "workbench"
    });
    assert.equal(plan.coverage.status, "complete", command);
  }

  for (const command of [
    "不要停止当前任务",
    "我不想停止当前任务",
    "暂时不想停止当前任务",
    "请修复停止按钮",
    "检查停止条件",
    "说明任务为什么停止",
    "取消本次任务的安全限制"
  ]) {
    const plan = planAgentCommand(command);
    assert.equal(
      plan.actions.some((action) => action.type === "workbench.stop"),
      false,
      command
    );
  }
});

test("explicit goal and plan exits override broad delegated mode inference", () => {
  const closeGoal = planAgentCommand("关闭持续目标，并总结当前进展");
  const goalDelegate = closeGoal.actions.at(-1);
  assert.equal(closeGoal.kind, "hybrid");
  assert.equal(closeGoal.goalMode, false);
  assert.equal(goalDelegate?.type, "workbench.delegate");
  if (goalDelegate?.type !== "workbench.delegate") {
    assert.fail("expected delegated Workbench action");
  }
  assert.equal(goalDelegate.goalMode, false);

  const exitPlan = planAgentCommand("退出计划模式并继续修复");
  const planDelegate = exitPlan.actions.at(-1);
  assert.equal(exitPlan.kind, "hybrid");
  assert.equal(exitPlan.collaborationMode, "default");
  assert.equal(planDelegate?.type, "workbench.delegate");
  if (planDelegate?.type !== "workbench.delegate") {
    assert.fail("expected delegated Workbench action");
  }
  assert.equal(planDelegate.collaborationMode, "default");
});

test("an explicit read-only diagnosis of a trusted HTTPS cMOOC course becomes a typed external-read action", () => {
  const targetInput =
    "https://cmooc.bnu.edu.cn/cMOOC/course?courseId=2059000000000000001&isBack=1";
  const plan = planAgentCommand(`只读诊断 ${targetInput}`);

  assert.equal(plan.kind, "local");
  assert.deepEqual(plan.actions, [
    {
      id: "step-1",
      type: "navigate",
      routeId: "platform",
      href: "/platform",
      label: "平台只读诊断"
    },
    {
      id: "step-2",
      type: "platform.inspect_readiness",
      routeId: "platform",
      targetInput
    }
  ]);
  assert.deepEqual(plan.coverage, {
    status: "complete",
    recognizedActionIds: ["step-1", "step-2"],
    residual: ""
  });
  assert.deepEqual(plan.safety, {
    localOnly: false,
    externalReads: true,
    externalWrites: false,
    requiresConfirmation: false
  });
});

test("platform readiness never activates without both explicit read-only intent and a trusted course URL", () => {
  const validTarget =
    "https://cmooc.bnu.edu.cn/cMOOC/course?courseId=2059000000000000001&isBack=1";
  const commands = [
    `检查 ${validTarget}`,
    `发布到 ${validTarget}`,
    "只读诊断 http://cmooc.bnu.edu.cn/cMOOC/course?courseId=2059000000000000001",
    "只读诊断 https://attacker.example/cMOOC/course?courseId=2059000000000000001",
    "只读诊断 https://cmooc.bnu.edu.cn/cMOOC/course?courseId=123"
  ];

  for (const command of commands) {
    const plan = planAgentCommand(command);
    assert.equal(
      plan.actions.some((action) => action.type === "platform.inspect_readiness"),
      false,
      command
    );
    assert.equal(plan.safety.externalReads, false, command);
    assert.equal(plan.safety.localOnly, true, command);
  }
});
