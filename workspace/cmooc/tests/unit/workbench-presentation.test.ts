import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkbenchEvent,
  WorkbenchPlanState,
  WorkbenchRunSnapshot
} from "../../lib/workbench/contracts";
import type { WorkbenchHistoryItem } from "../../lib/workbench/history-store";
import {
  buildWorkbenchConversation,
  buildWorkbenchPlanExecutionRequest,
  formatWorkbenchAnswer,
  groupWorkbenchTaskHistory,
  projectWorkbenchActivity,
  reconcileWorkbenchHistory,
  resolveWorkbenchContextTitle
} from "../../lib/workbench/presentation";

function event(
  seq: number,
  input: Partial<WorkbenchEvent> &
    Pick<WorkbenchEvent, "kind" | "title"> &
    { activityId?: string }
): WorkbenchEvent {
  return {
    schemaVersion: "cmooc.workbench.v1",
    runId: "12345678-1234-4234-8234-123456789abc",
    seq,
    at: new Date(Date.UTC(2026, 7, 10, 12, 0, seq)).toISOString(),
    status: "completed",
    ...input
  } as WorkbenchEvent;
}

type BuildConversationWithRunStatus = (
  events: readonly WorkbenchEvent[],
  runStatus?: WorkbenchRunSnapshot["status"]
) => ReturnType<typeof buildWorkbenchConversation>;

const buildConversationWithRunStatus =
  buildWorkbenchConversation as BuildConversationWithRunStatus;

test("conversation groups consecutive lead-agent analysis updates without flattening collaborators or system events", () => {
  const blocks = buildWorkbenchConversation([
    event(1, { kind: "run", title: "任务正在运行", presentationRole: "system" }),
    event(2, {
      kind: "agent",
      title: "Sol 正在分析任务",
      agentLabel: "Sol",
      agentRole: "sol",
      presentationRole: "assistant"
    }),
    event(3, {
      kind: "plan",
      title: "计划已更新",
      agentLabel: "Sol",
      agentRole: "sol",
      presentationRole: "assistant"
    }),
    event(4, {
      kind: "agent",
      title: "Sol 正在生成消息",
      agentLabel: "Sol",
      agentRole: "sol",
      presentationRole: "assistant"
    }),
    event(5, {
      kind: "agent",
      title: "协作子任务已完成",
      agentLabel: "Luna #1",
      agentRole: "luna",
      presentationRole: "assistant"
    })
  ]);

  assert.deepEqual(blocks.map((block) => block.type), ["analysis", "assistant"]);
  assert.equal(blocks[0]?.type, "analysis");
  if (blocks[0]?.type === "analysis") {
    assert.equal(blocks[0].events.length, 3);
    assert.equal(blocks[0].label, "主任务智能体");
  }
  assert.equal(blocks[1]?.type, "assistant");
  if (blocks[1]?.type === "assistant") {
    assert.equal(blocks[1].event.agentRole, "luna");
  }
});

test("the pinned activity surface owns lifecycle status instead of repeating run events in the timeline", () => {
  const blocks = buildWorkbenchConversation([
    event(1, { kind: "run", status: "running", title: "任务正在运行", presentationRole: "system" })
  ], "running");

  assert.deepEqual(blocks, []);
});

test("conversation starts a new analysis group after a non-Sol event", () => {
  const blocks = buildWorkbenchConversation([
    event(1, {
      kind: "agent",
      title: "Sol 首轮分析",
      agentLabel: "Sol",
      agentRole: "sol",
      presentationRole: "assistant"
    }),
    event(2, {
      kind: "message",
      title: "Luna 提供观察",
      agentLabel: "Luna",
      agentRole: "luna",
      presentationRole: "assistant"
    }),
    event(3, {
      kind: "plan",
      title: "Sol 更新计划",
      agentLabel: "Sol",
      agentRole: "sol",
      presentationRole: "assistant"
    })
  ]);

  assert.deepEqual(blocks.map((block) => block.type), ["analysis", "assistant", "analysis"]);
  assert.equal(blocks[0]?.type, "analysis");
  assert.equal(blocks[2]?.type, "analysis");
});

test("conversation separates visible file changes from compact tool activity", () => {
  const blocks = buildWorkbenchConversation([
    event(1, {
      kind: "tool",
      status: "running",
      title: "命令工具",
      toolKey: "command",
      presentationRole: "tool"
    }),
    event(2, {
      kind: "tool",
      status: "completed",
      title: "命令工具",
      toolKey: "command",
      presentationRole: "tool"
    }),
    event(3, {
      kind: "artifact",
      title: "工作区文件已更新",
      artifactId: "artifact-1",
      presentationRole: "tool"
    }),
    event(4, {
      kind: "message",
      title: "Sol 更新了执行进展",
      agentLabel: "Sol",
      agentRole: "sol",
      presentationRole: "assistant"
    })
  ]);

  assert.deepEqual(blocks.map((block) => block.type), ["tools", "artifacts", "assistant"]);
  assert.equal(blocks[0]?.type, "tools");
  if (blocks[0]?.type === "tools") {
    assert.equal(blocks[0].events.length, 2);
    assert.equal(blocks[0].items.length, 1);
    assert.equal(blocks[0].items[0]?.status, "completed");
    assert.equal(blocks[0].items[0]?.occurrences, 1);
    assert.deepEqual(
      blocks[0].items.map((item) => ({ key: item.key, occurrences: item.occurrences })),
      [{ key: "command", occurrences: 1 }]
    );
  }
  assert.equal(blocks[1]?.type, "artifacts");
  if (blocks[1]?.type === "artifacts") {
    assert.equal(blocks[1].events.length, 1);
    assert.equal(blocks[1].events[0]?.artifactId, "artifact-1");
  }
});

test("tool aggregation keeps repeated calls compact while preserving status and count", () => {
  const blocks = buildWorkbenchConversation([
    event(1, {
      kind: "tool",
      status: "running",
      title: "搜索工具",
      toolKey: "search",
      presentationRole: "tool"
    }),
    event(2, {
      kind: "tool",
      status: "completed",
      title: "搜索工具",
      toolKey: "search",
      presentationRole: "tool"
    }),
    event(3, {
      kind: "tool",
      status: "running",
      title: "搜索工具",
      toolKey: "search",
      presentationRole: "tool"
    }),
    event(4, {
      kind: "tool",
      status: "completed",
      title: "搜索工具",
      toolKey: "search",
      presentationRole: "tool"
    }),
    event(5, {
      kind: "tool",
      status: "completed",
      title: "文件工具",
      toolKey: "filesystem",
      presentationRole: "tool"
    })
  ]);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "tools");
  if (blocks[0]?.type === "tools") {
    assert.equal(blocks[0].events.length, 5);
    assert.deepEqual(
      blocks[0].items.map((item) => ({ key: item.key, status: item.status, occurrences: item.occurrences })),
      [
        { key: "search", status: "completed", occurrences: 2 },
        { key: "filesystem", status: "completed", occurrences: 1 }
      ]
    );
  }
});

test("activity lifecycle closes separated Sol analysis blocks with the same public activity id", () => {
  const blocks = buildWorkbenchConversation([
    event(1, {
      kind: "agent",
      status: "running",
      title: "Sol 正在分析任务",
      agentRole: "sol",
      presentationRole: "assistant",
      activityId: "activity-analysis-1"
    }),
    event(2, {
      kind: "message",
      status: "completed",
      title: "Luna 已返回受约束观察",
      agentRole: "luna",
      presentationRole: "assistant"
    }),
    event(3, {
      kind: "agent",
      status: "completed",
      title: "Sol 已完成任务分析",
      agentRole: "sol",
      presentationRole: "assistant",
      activityId: "activity-analysis-1"
    })
  ]);

  assert.deepEqual(blocks.map((block) => block.type), ["analysis", "assistant", "analysis"]);
  const analysisEvents = blocks.flatMap((block) =>
    block.type === "analysis" ? block.events : []
  );
  assert.deepEqual(
    analysisEvents.map((entry) => entry.status),
    ["completed", "completed"]
  );
  assert.equal(analysisEvents.some((entry) => entry.status === "running"), false);
});

test("activity lifecycle closes separated tool blocks with the same public activity id", () => {
  const blocks = buildWorkbenchConversation([
    event(1, {
      kind: "tool",
      status: "running",
      title: "命令工具",
      toolKey: "command",
      presentationRole: "tool",
      activityId: "activity-command-1"
    }),
    event(2, {
      kind: "message",
      status: "completed",
      title: "Sol 更新了执行进展",
      agentRole: "sol",
      presentationRole: "assistant"
    }),
    event(3, {
      kind: "tool",
      status: "completed",
      title: "命令工具",
      toolKey: "command",
      presentationRole: "tool",
      activityId: "activity-command-1"
    })
  ]);

  assert.deepEqual(blocks.map((block) => block.type), ["tools", "assistant", "tools"]);
  const toolBlocks = blocks.filter(
    (block): block is Extract<(typeof blocks)[number], { type: "tools" }> =>
      block.type === "tools"
  );
  assert.deepEqual(
    toolBlocks.flatMap((block) => block.items.map((item) => item.status)),
    ["completed", "completed"]
  );
  assert.equal(
    toolBlocks.some(
      (block) =>
        block.events.some((entry) => entry.status === "running") ||
        block.items.some((item) => item.status === "running")
    ),
    false
  );
});

test("terminal runs never leave legacy unpaired analysis or tool events projected as active", () => {
  const legacyEvents = [
    event(1, {
      kind: "agent",
      status: "running",
      title: "Sol 正在分析任务",
      agentRole: "sol",
      presentationRole: "assistant"
    }),
    event(2, {
      kind: "tool",
      status: "running",
      title: "命令工具",
      toolKey: "command",
      presentationRole: "tool"
    })
  ];

  for (const runStatus of ["completed", "failed", "stopped"] as const) {
    const blocks = buildConversationWithRunStatus(legacyEvents, runStatus);
    const projectedEvents = blocks.flatMap((block) =>
      block.type === "user" || block.type === "assistant"
        ? [block.event]
        : block.events
    );
    const projectedToolItems = blocks.flatMap((block) =>
      block.type === "tools" ? block.items : []
    );

    assert.equal(
      projectedEvents.some((entry) => entry.status === "running"),
      false,
      `${runStatus} run retained an active legacy event`
    );
    assert.equal(
      projectedToolItems.some((item) => item.status === "running"),
      false,
      `${runStatus} run retained an active legacy tool item`
    );
  }
});

test("conversation omits the generic result event because the final answer owns that surface", () => {
  const blocks = buildWorkbenchConversation([
    event(1, { kind: "result", title: "运行结果已就绪", presentationRole: "assistant" })
  ]);
  assert.deepEqual(blocks, []);
});

test("activity projection exposes the current safe tool step without leaking internal reasoning", () => {
  const activity = projectWorkbenchActivity(
    [
      event(1, { kind: "run", status: "running", title: "任务正在运行", presentationRole: "system" }),
      event(2, {
        kind: "agent",
        status: "completed",
        title: "Sol 正在分析任务",
        agentRole: "sol",
        presentationRole: "assistant"
      }),
      event(3, {
        kind: "tool",
        status: "running",
        title: "命令工具",
        toolKey: "command",
        presentationRole: "tool"
      })
    ],
    "running"
  );

  assert.deepEqual(activity, {
    state: "working",
    role: "tool",
    title: "正在使用命令工具",
    detail: "只显示可公开的步骤名称；内部推理与工具输出保持隐藏。",
    completedCount: 1,
    toolCallCount: 1
  });
});

test("a running task without an active event waits honestly instead of replaying completed work", () => {
  const activity = projectWorkbenchActivity(
    [
      event(1, { kind: "run", status: "running", title: "任务正在运行", presentationRole: "system" }),
      event(2, {
        kind: "message",
        status: "completed",
        title: "执行进展",
        summary: "进展已记录。",
        presentationRole: "assistant"
      })
    ],
    "running"
  );

  assert.equal(activity.state, "working");
  assert.equal(activity.role, "system");
  assert.equal(activity.title, "正在等待下一条安全进展");
  assert.equal(activity.completedCount, 1);
});

test("terminal conversation projections remove current-run excerpts", () => {
  const progress = event(1, {
    kind: "message",
    title: "执行进展",
    liveExcerpt: "正在核对页面状态。",
    presentationRole: "assistant"
  });

  const running = buildWorkbenchConversation([progress], "running");
  const completed = buildWorkbenchConversation([progress], "completed");

  assert.equal(running[0]?.type, "assistant");
  assert.equal(
    running[0]?.type === "assistant" ? running[0].event.liveExcerpt : undefined,
    "正在核对页面状态。"
  );
  assert.equal(completed[0]?.type, "assistant");
  assert.equal(
    completed[0]?.type === "assistant" ? completed[0].event.liveExcerpt : undefined,
    undefined
  );
});

test("final answer formatter preserves paragraphs, titled sections, and bullet lists", () => {
  const answer = formatWorkbenchAnswer(
    "已完成工作台消息体验优化。\n\n已完成：\n- 连续分析事件折叠\n- 工具调用合并\n\n下一步：在桌面浏览器核验三种状态。"
  );

  assert.deepEqual(answer, [
    { type: "paragraph", text: "已完成工作台消息体验优化。" },
    { type: "heading", text: "已完成" },
    { type: "list", items: ["连续分析事件折叠", "工具调用合并"] },
    { type: "heading", text: "下一步" },
    { type: "paragraph", text: "在桌面浏览器核验三种状态。" }
  ]);
});

test("final answer formatter preserves titled sections and fenced code blocks", () => {
  const answer = formatWorkbenchAnswer(
    "方案：\n\n```ts\nconst safe = true;\n```\n\n验证：运行类型检查。"
  );

  assert.deepEqual(answer, [
    { type: "heading", text: "方案" },
    { type: "code", language: "ts", text: "const safe = true;" },
    { type: "heading", text: "验证" },
    { type: "paragraph", text: "运行类型检查。" }
  ]);
});

test("context title falls back when live and attached titles are blank", () => {
  assert.equal(
    resolveWorkbenchContextTitle("", ""),
    "课程互动网络（聚合视图）"
  );
  assert.equal(
    resolveWorkbenchContextTitle("成员 37", "课程互动网络"),
    "成员 37"
  );
  assert.equal(
    resolveWorkbenchContextTitle(undefined, "课程互动网络"),
    "课程互动网络"
  );
});

test("public context titles remove execution-vendor branding before display", () => {
  assert.equal(
    resolveWorkbenchContextTitle("Codex OpenAI ChatGPT 任务", "备用上下文"),
    "课程研判 本机执行 本机执行 任务"
  );
  assert.equal(resolveWorkbenchContextTitle("", "codex 备用"), "课程研判 备用");
});

test("plan execution request carries only the public plan into a fresh execution turn", () => {
  const plan: WorkbenchPlanState = {
    explanation: "先核验，再实施。",
    steps: [
      { step: "核对 Codex OpenAI 接入状态", status: "pending" },
      { step: "实施控制台修复", status: "inProgress" },
      { step: "运行回归并报告", status: "completed" }
    ],
    updatedAt: "2026-08-11T12:00:00.000Z"
  };

  const request = buildWorkbenchPlanExecutionRequest(plan, "Codex 控制台优化");
  assert.equal(request.displayPrompt, "执行已确认的计划：课程研判 控制台优化");
  assert.match(request.prompt, /工作台已确认的计划/);
  assert.match(request.prompt, /1\. 核对 课程研判 本机执行 接入状态/);
  assert.match(request.prompt, /3\. 运行回归并报告/);
  assert.match(request.prompt, /课程平台零外部写入边界/);
  assert.doesNotMatch(request.prompt, /Codex|OpenAI/);
});

test("live terminal snapshot wins over a stale running history row", () => {
  const stale: WorkbenchHistoryItem = {
    id: "12345678-1234-4234-8234-123456789abc",
    title: "课程研判任务",
    status: "running",
    source: "demo",
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:01.000Z",
    eventCount: 8,
    containsForumText: false
  };
  const completed = {
    id: stale.id,
    taskTitle: stale.title,
    status: "completed",
    source: "demo",
    createdAt: stale.createdAt,
    updatedAt: "2026-08-10T12:00:02.000Z",
    events: Array.from({ length: 10 }, (_, index) => ({ seq: index + 1 }))
  } as WorkbenchRunSnapshot;

  const reconciled = reconcileWorkbenchHistory([stale], completed);
  assert.equal(reconciled[0]?.status, "completed");
  assert.equal(reconciled[0]?.eventCount, 10);
  assert.equal(reconciled[0]?.updatedAt, completed.updatedAt);
});

test("live history projection keeps the reusable Nutstore session folder", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  const key = `20260811T121500Z--run-${id}`;
  const snapshot = {
    schemaVersion: "cmooc.workbench.v1",
    id,
    taskTitle: "课程研判任务",
    status: "running",
    source: "app-server",
    projectLabel: "cMOOC 源码工作区",
    createdAt: "2026-08-11T12:15:00.000Z",
    updatedAt: "2026-08-11T12:15:01.000Z",
    events: [],
    firstEventSeq: 0,
    lastEventSeq: 0,
    agents: [],
    tools: [],
    artifacts: [],
    safety: {
      externalWritesLocked: true,
      realPublishEnabled: false,
      externalMutationAttempted: false,
      editorWriteCount: 0,
      publishAttemptCount: 0,
      containsForumText: false
    },
    capabilities: { canSteer: true, canStop: true, liveHarness: true },
    sessionWorkspace: {
      schemaVersion: "cmooc.workbench-session-workspace.v1",
      key,
      projectRelativePath: `智能控制台会话/${key}`,
      state: "ready",
      reusable: true,
      containsPrompt: false,
      containsForumText: false,
      containsIdentity: false
    }
  } satisfies WorkbenchRunSnapshot;

  const [projected] = reconcileWorkbenchHistory([], snapshot);
  assert.equal(projected?.sessionWorkspace?.projectRelativePath, `智能控制台会话/${key}`);
  assert.equal(projected?.canReuse, true);
});

test("task history groups continuation and restart attempts under one durable root task", () => {
  const rootId = "12345678-1234-4234-8234-123456789abc";
  const continuationId = "22345678-1234-4234-8234-123456789abc";
  const items: WorkbenchHistoryItem[] = [
    {
      id: continuationId,
      title: "核验课程支持缺口",
      status: "running",
      source: "app-server",
      contextTitle: "课程世界快照",
      createdAt: "2026-08-13T12:10:00.000Z",
      updatedAt: "2026-08-13T12:11:00.000Z",
      eventCount: 7,
      lineage: {
        schemaVersion: "cmooc.workbench-lineage.v1",
        relation: "continuation",
        rootRunId: rootId,
        parentRunId: rootId,
        generation: 1,
        requestId: "12345678-1234-4234-8234-123456789abc"
      },
      canReuse: true,
      containsForumText: false
    },
    {
      id: rootId,
      title: "核验课程支持缺口",
      status: "completed",
      source: "app-server",
      contextTitle: "课程世界快照",
      createdAt: "2026-08-13T12:00:00.000Z",
      updatedAt: "2026-08-13T12:05:00.000Z",
      eventCount: 11,
      lineage: {
        schemaVersion: "cmooc.workbench-lineage.v1",
        relation: "root",
        rootRunId: rootId,
        generation: 0
      },
      containsForumText: false
    }
  ];

  const grouped = groupWorkbenchTaskHistory(items);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.rootRunId, rootId);
  assert.equal(grouped[0]?.latestRun.id, continuationId);
  assert.equal(grouped[0]?.turnCount, 2);
  assert.equal(grouped[0]?.eventCount, 18);
  assert.equal(grouped[0]?.status, "running");
  assert.equal(grouped[0]?.canReuse, true);
  assert.deepEqual(grouped[0]?.runs.map((run) => run.id), [rootId, continuationId]);
});

test("task history keeps unrelated roots separate and sorts by latest activity", () => {
  const makeItem = (
    id: string,
    updatedAt: string
  ): WorkbenchHistoryItem => ({
    id,
    title: `任务 ${id.slice(0, 2)}`,
    status: "completed",
    source: "app-server",
    createdAt: updatedAt,
    updatedAt,
    eventCount: 1,
    containsForumText: false
  });
  const older = makeItem("12345678-1234-4234-8234-123456789abc", "2026-08-13T12:00:00.000Z");
  const newer = makeItem("22345678-1234-4234-8234-123456789abc", "2026-08-13T13:00:00.000Z");

  assert.deepEqual(
    groupWorkbenchTaskHistory([older, newer]).map((task) => task.rootRunId),
    [newer.id, older.id]
  );
});
