import {
  redactPublicText,
  type WorkbenchEvent,
  type WorkbenchEventStatus,
  type WorkbenchPlanState,
  type WorkbenchPresentationRole,
  type WorkbenchRunSnapshot
} from "@/lib/workbench/contracts";
import type { WorkbenchHistoryItem } from "@/lib/workbench/history-store";

export type WorkbenchToolPresentationItem = {
  key: string;
  label: string;
  status: WorkbenchEventStatus;
  occurrences: number;
  at: string;
};

export type WorkbenchConversationBlock =
  | { type: "analysis"; id: string; label: "主任务智能体"; events: WorkbenchEvent[] }
  | { type: "tools"; id: string; events: WorkbenchEvent[]; items: WorkbenchToolPresentationItem[] }
  | { type: "artifacts"; id: string; events: WorkbenchEvent[] }
  | { type: "system"; id: string; events: WorkbenchEvent[] }
  | { type: "user"; id: string; event: WorkbenchEvent }
  | { type: "assistant"; id: string; event: WorkbenchEvent };

export type WorkbenchAnswerBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "code"; language?: string; text: string };

export type WorkbenchActivityProjection = {
  state: "idle" | "starting" | "working" | "completed" | "failed" | "stopped";
  role: "system" | "sol" | "luna" | "tool";
  title: string;
  detail: string;
  completedCount: number;
  toolCallCount: number;
};

const DEFAULT_CONTEXT_TITLE = "课程互动网络（聚合视图）";

function sanitizePublicWorkbenchLabel(value: string): string {
  return value
    .replace(/\bLuna\s*#?\s*(\d+)\b/gi, "协作智能体 #$1")
    .replace(/\bLuna\b/gi, "协作智能体")
    .replace(/\bSol\b/gi, "主任务智能体")
    .replace(/Codex/gi, "课程研判")
    .replace(/OpenAI|ChatGPT/gi, "本机执行");
}

export function resolveWorkbenchContextTitle(
  liveTitle?: string,
  attachedTitle?: string
): string {
  const title = liveTitle?.trim() || attachedTitle?.trim() || DEFAULT_CONTEXT_TITLE;
  return sanitizePublicWorkbenchLabel(title);
}

export type WorkbenchPlanExecutionRequest = {
  prompt: string;
  displayPrompt: string;
};

function publicPlanText(value: string, maxLength: number): string {
  return sanitizePublicWorkbenchLabel(redactPublicText(value, maxLength))
    .replace(/\s+/g, " ")
    .trim();
}

export function buildWorkbenchPlanExecutionRequest(
  plan: WorkbenchPlanState,
  taskTitle?: string
): WorkbenchPlanExecutionRequest {
  const title = publicPlanText(taskTitle?.trim() || "当前任务", 160) || "当前任务";
  const steps = plan.steps
    .slice(0, 12)
    .map((entry) => publicPlanText(entry.step, 240))
    .filter(Boolean);
  const numberedPlan = steps.map((step, index) => `${index + 1}. ${step}`).join("\n");

  return {
    displayPrompt: `执行已确认的计划：${title}`,
    prompt: [
      "请继续执行工作台已确认的计划。",
      `任务：${title}`,
      "计划步骤：",
      numberedPlan || "1. 重新核验当前任务并形成最小可执行步骤。",
      "执行要求：按顺序推进并在过程事件中更新步骤状态；完成后给出充分、可核验的答复。保持课程平台零外部写入边界。"
    ].join("\n\n")
  };
}

export function reconcileWorkbenchHistory(
  history: readonly WorkbenchHistoryItem[],
  snapshot: WorkbenchRunSnapshot | null
): WorkbenchHistoryItem[] {
  if (!snapshot) return [...history];
  const existing = history.find((item) => item.id === snapshot.id);
  const projected: WorkbenchHistoryItem = {
    ...(existing ?? {}),
    id: snapshot.id,
    title:
      snapshot.taskTitle?.trim() ||
      snapshot.context?.title?.trim() ||
      existing?.title ||
      "课程研判任务",
    status: snapshot.status,
    source: snapshot.source,
    contextTitle: snapshot.context?.title ?? existing?.contextTitle,
    lineage: snapshot.lineage ?? existing?.lineage,
    sessionWorkspace: snapshot.sessionWorkspace ?? existing?.sessionWorkspace,
    canReuse: snapshot.source === "app-server" && Boolean(snapshot.sessionWorkspace),
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    eventCount: snapshot.events.length,
    containsForumText: false
  };
  return [projected, ...history.filter((item) => item.id !== snapshot.id)]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 12);
}

export type WorkbenchTaskHistoryGroup = {
  rootRunId: string;
  title: string;
  status: WorkbenchHistoryItem["status"];
  source: WorkbenchHistoryItem["source"];
  contextTitle?: string;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  turnCount: number;
  recoveryState?: WorkbenchHistoryItem["recoveryState"];
  canReuse?: boolean;
  latestRun: WorkbenchHistoryItem;
  runs: WorkbenchHistoryItem[];
  containsForumText: false;
};

function historyTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Presents the durable root-run lineage as one operator task. Child runs remain
 * immutable execution records, but no longer look like unrelated conversations.
 */
export function groupWorkbenchTaskHistory(
  history: readonly WorkbenchHistoryItem[]
): WorkbenchTaskHistoryGroup[] {
  const grouped = new Map<string, WorkbenchHistoryItem[]>();

  for (const item of history) {
    const rootRunId = item.lineage?.rootRunId?.trim() || item.id;
    const runs = grouped.get(rootRunId) ?? [];
    runs.push(item);
    grouped.set(rootRunId, runs);
  }

  return [...grouped.entries()]
    .map(([rootRunId, unsortedRuns]) => {
      const runs = [...unsortedRuns].sort((left, right) => {
        const createdDelta = historyTimestamp(left.createdAt) - historyTimestamp(right.createdAt);
        if (createdDelta !== 0) return createdDelta;
        return historyTimestamp(left.updatedAt) - historyTimestamp(right.updatedAt);
      });
      const latestRun = runs.reduce((latest, candidate) =>
        historyTimestamp(candidate.updatedAt) >= historyTimestamp(latest.updatedAt)
          ? candidate
          : latest
      );
      const rootRun = runs.find((item) => item.id === rootRunId) ?? runs[0] ?? latestRun;

      return {
        rootRunId,
        title: rootRun.title || latestRun.title,
        status: latestRun.status,
        source: latestRun.source,
        ...(latestRun.contextTitle || rootRun.contextTitle
          ? { contextTitle: latestRun.contextTitle || rootRun.contextTitle }
          : {}),
        createdAt: rootRun.createdAt,
        updatedAt: latestRun.updatedAt,
        eventCount: runs.reduce((total, item) => total + item.eventCount, 0),
        turnCount: runs.length,
        ...(latestRun.recoveryState ? { recoveryState: latestRun.recoveryState } : {}),
        ...(latestRun.canReuse !== undefined ? { canReuse: latestRun.canReuse } : {}),
        latestRun,
        runs,
        containsForumText: false as const
      };
    })
    .sort((left, right) => historyTimestamp(right.updatedAt) - historyTimestamp(left.updatedAt));
}

function eventRole(event: WorkbenchEvent): WorkbenchPresentationRole {
  if (event.presentationRole) return event.presentationRole;
  if (event.kind === "tool" || event.kind === "artifact") return "tool";
  if (event.kind === "run" || event.kind === "warning" || event.kind === "error") {
    return "system";
  }
  return "assistant";
}

function isSolAnalysis(event: WorkbenchEvent): boolean {
  return (
    eventRole(event) === "assistant" &&
    event.agentRole !== "luna" &&
    (event.kind === "agent" || event.kind === "plan")
  );
}

type TerminalActivityStatus = "completed" | "failed" | "stopped";

type LifecycleProjectionEntry = {
  event: WorkbenchEvent;
  segment: number;
  segmentTerminal?: TerminalActivityStatus;
};

function terminalActivityStatus(
  status: WorkbenchEventStatus | WorkbenchRunSnapshot["status"] | undefined
): TerminalActivityStatus | undefined {
  return status === "completed" || status === "failed" || status === "stopped"
    ? status
    : undefined;
}

/**
 * Projects append-only protocol events into their effective public lifecycle.
 * Raw events stay immutable; start events inherit the terminal state of the
 * same public activity, while a result event closes any unpaired legacy
 * activity in that turn.
 */
function projectEventLifecycles(
  events: readonly WorkbenchEvent[],
  runStatus?: WorkbenchRunSnapshot["status"]
): LifecycleProjectionEntry[] {
  const entries: LifecycleProjectionEntry[] = [];
  const segmentTerminals = new Map<number, TerminalActivityStatus>();
  let segment = 0;

  for (const event of events) {
    entries.push({ event, segment });
    if (event.kind !== "result") continue;
    const terminal = terminalActivityStatus(event.status);
    if (terminal) segmentTerminals.set(segment, terminal);
    segment += 1;
  }

  const currentTerminal = terminalActivityStatus(runStatus);
  if (currentTerminal) segmentTerminals.set(segment, currentTerminal);

  const activityTerminals = new Map<string, TerminalActivityStatus>();
  for (const entry of entries) {
    const { activityId } = entry.event;
    const terminal = terminalActivityStatus(entry.event.status);
    if (activityId && terminal) {
      activityTerminals.set(`${entry.segment}:${activityId}`, terminal);
    }
  }

  return entries.map((entry) => {
    const segmentTerminal = segmentTerminals.get(entry.segment);
    const activityTerminal = entry.event.activityId
      ? activityTerminals.get(`${entry.segment}:${entry.event.activityId}`)
      : undefined;
    const effectiveStatus = activityTerminal ??
      (entry.event.status === "running" ? segmentTerminal : undefined);
    return {
      ...entry,
      ...(segmentTerminal ? { segmentTerminal } : {}),
      event: effectiveStatus && effectiveStatus !== entry.event.status
        ? { ...entry.event, status: effectiveStatus }
        : entry.event
    };
  });
}

function toolItems(events: WorkbenchEvent[]): WorkbenchToolPresentationItem[] {
  const groups = new Map<string, {
    key: string;
    label: string;
    at: string;
    activityStatuses: Map<string, WorkbenchEventStatus>;
    legacyStatuses: WorkbenchEventStatus[];
    legacyOpen: number;
    legacyOccurrences: number;
  }>();
  for (const event of events) {
    const key = event.toolKey ?? event.artifactId ?? `${event.kind}:${event.title}`;
    const group = groups.get(key) ?? {
      key,
      label: event.title,
      at: event.at,
      activityStatuses: new Map<string, WorkbenchEventStatus>(),
      legacyStatuses: [],
      legacyOpen: 0,
      legacyOccurrences: 0
    };
    group.label = event.title;
    group.at = event.at;
    if (event.activityId) {
      group.activityStatuses.set(event.activityId, event.status);
    } else if (event.status === "running" || event.status === "queued") {
      group.legacyOpen += 1;
      group.legacyOccurrences += 1;
    } else {
      if (group.legacyOpen > 0) group.legacyOpen -= 1;
      else group.legacyOccurrences += 1;
      group.legacyStatuses.push(event.status);
    }
    groups.set(key, group);
  }
  const priority: Record<WorkbenchEventStatus, number> = {
    queued: 1,
    info: 2,
    completed: 3,
    stopped: 4,
    failed: 5,
    running: 6
  };
  return [...groups.values()].map((group) => {
    const statuses = [
      ...group.activityStatuses.values(),
      ...group.legacyStatuses,
      ...(group.legacyOpen > 0 ? ["running" as const] : [])
    ];
    const status = statuses.reduce<WorkbenchEventStatus>(
      (current, candidate) => priority[candidate] > priority[current] ? candidate : current,
      "info"
    );
    return {
      key: group.key,
      label: group.label,
      status,
      occurrences: group.activityStatuses.size + group.legacyOccurrences,
      at: group.at
    };
  });
}

export function buildWorkbenchConversation(
  events: readonly WorkbenchEvent[],
  runStatus?: WorkbenchRunSnapshot["status"]
): WorkbenchConversationBlock[] {
  const visibleEvents = projectEventLifecycles(events, runStatus)
    .filter(({ event, segmentTerminal }) =>
      event.kind !== "result" && event.kind !== "run"
    )
    .map(({ event }) =>
      (runStatus === "completed" || runStatus === "failed" || runStatus === "stopped") && event.liveExcerpt
        ? { ...event, liveExcerpt: undefined }
        : event
    );
  const blocks: WorkbenchConversationBlock[] = [];

  for (let index = 0; index < visibleEvents.length;) {
    const current = visibleEvents[index];
    if (!current) break;
    const role = eventRole(current);

    if (current.kind === "artifact") {
      const grouped: WorkbenchEvent[] = [];
      while (index < visibleEvents.length && visibleEvents[index]!.kind === "artifact") {
        grouped.push(visibleEvents[index]!);
        index += 1;
      }
      blocks.push({
        type: "artifacts",
        id: `artifacts-${grouped[0]!.seq}`,
        events: grouped
      });
      continue;
    }

    if (role === "tool") {
      const grouped: WorkbenchEvent[] = [];
      while (
        index < visibleEvents.length &&
        visibleEvents[index]!.kind !== "artifact" &&
        eventRole(visibleEvents[index]!) === "tool"
      ) {
        grouped.push(visibleEvents[index]!);
        index += 1;
      }
      blocks.push({
        type: "tools",
        id: `tools-${grouped[0]!.seq}`,
        events: grouped,
        items: toolItems(grouped)
      });
      continue;
    }

    if (isSolAnalysis(current)) {
      const grouped: WorkbenchEvent[] = [];
      while (index < visibleEvents.length && isSolAnalysis(visibleEvents[index]!)) {
        grouped.push(visibleEvents[index]!);
        index += 1;
      }
      blocks.push({
        type: "analysis",
        id: `analysis-${grouped[0]!.seq}`,
        label: "主任务智能体",
        events: grouped
      });
      continue;
    }

    if (role === "system") {
      const grouped: WorkbenchEvent[] = [];
      while (index < visibleEvents.length && eventRole(visibleEvents[index]!) === "system") {
        grouped.push(visibleEvents[index]!);
        index += 1;
      }
      blocks.push({
        type: "system",
        id: `system-${grouped[0]!.seq}`,
        events: grouped
      });
      continue;
    }

    blocks.push(
      role === "user"
        ? { type: "user", id: `user-${current.seq}`, event: current }
        : { type: "assistant", id: `assistant-${current.seq}`, event: current }
    );
    index += 1;
  }

  return blocks;
}

export function projectWorkbenchActivity(
  events: readonly WorkbenchEvent[],
  runStatus?: WorkbenchRunSnapshot["status"]
): WorkbenchActivityProjection {
  const projectedEvents = projectEventLifecycles(events, runStatus).map(({ event }) => event);
  const completedKeys = new Set<string>();
  for (const event of projectedEvents) {
    if (event.kind === "result" || event.status !== "completed") continue;
    completedKeys.add(event.activityId ?? `event-${event.seq}`);
  }
  const completedCount = completedKeys.size;
  const toolActivityIds = new Set<string>();
  const legacyToolOccurrences = new Map<string, number>();
  for (const event of projectedEvents) {
    if (eventRole(event) !== "tool") continue;
    if (event.activityId) {
      toolActivityIds.add(event.activityId);
      continue;
    }
    const key = event.toolKey ?? event.artifactId ?? `${event.kind}:${event.title}`;
    const previous = legacyToolOccurrences.get(key);
    if (event.status === "running" || previous === undefined) {
      legacyToolOccurrences.set(key, (previous ?? 0) + 1);
    }
  }
  const toolCallCount = toolActivityIds.size +
    [...legacyToolOccurrences.values()].reduce((sum, count) => sum + count, 0);
  const detail = "只显示可公开的步骤名称；内部推理与工具输出保持隐藏。";

  if (runStatus === "completed") {
    return { state: "completed", role: "sol", title: "任务已完成", detail, completedCount, toolCallCount };
  }
  if (runStatus === "failed") {
    return { state: "failed", role: "system", title: "任务未完成", detail, completedCount, toolCallCount };
  }
  if (runStatus === "stopped") {
    return { state: "stopped", role: "system", title: "任务已停止", detail, completedCount, toolCallCount };
  }
  if (!projectedEvents.length || !runStatus) {
    return { state: "idle", role: "system", title: "等待任务", detail, completedCount, toolCallCount };
  }
  if (runStatus === "queued" || runStatus === "starting") {
    return { state: "starting", role: "system", title: "正在建立本机任务", detail, completedCount, toolCallCount };
  }
  if (runStatus === "awaiting_action") {
    return {
      state: "working",
      role: "system",
      title: "等待授权本次精确操作",
      detail: "只有本次可核对的暂存与清空操作等待决定；发布与通知仍为 0。",
      completedCount,
      toolCallCount
    };
  }

  const latest = [...projectedEvents]
    .reverse()
    .find((event) => event.kind !== "result" && event.kind !== "run" && event.status === "running");
  if (!latest) {
    return {
      state: "working",
      role: "system",
      title: "正在等待下一条安全进展",
      detail: "最近进展已记录，等待执行引擎回报。",
      completedCount,
      toolCallCount
    };
  }
  const role = eventRole(latest);
  if (role === "tool") {
    return {
      state: "working",
      role: "tool",
      title: `正在使用${latest.title}`,
      detail,
      completedCount,
      toolCallCount
    };
  }
  if (latest.agentRole === "luna") {
    return { state: "working", role: "luna", title: latest.title, detail, completedCount, toolCallCount };
  }
  if (role === "system") {
    return { state: "working", role: "system", title: latest.title, detail, completedCount, toolCallCount };
  }
  return { state: "working", role: "sol", title: latest.title, detail, completedCount, toolCallCount };
}

function flushParagraph(lines: string[], output: WorkbenchAnswerBlock[]): void {
  const text = lines.join(" ").trim();
  if (text) output.push({ type: "paragraph", text });
  lines.length = 0;
}

function flushList(items: string[], output: WorkbenchAnswerBlock[]): void {
  if (items.length) output.push({ type: "list", items: [...items] });
  items.length = 0;
}

export function formatWorkbenchAnswer(summary: string): WorkbenchAnswerBlock[] {
  const output: WorkbenchAnswerBlock[] = [];
  const paragraph: string[] = [];
  const list: string[] = [];
  const codeBlock: string[] = [];
  let inCodeBlock = false;
  let currentLanguage = "";
  const lines = summary.replace(/\r\n?/g, "\n").split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      if (inCodeBlock) {
        flushParagraph(paragraph, output);
        flushList(list, output);
        output.push({
          type: "code",
          text: codeBlock.join("\n").trimEnd(),
          language: currentLanguage || undefined
        });
        codeBlock.length = 0;
        inCodeBlock = false;
        currentLanguage = "";
      } else {
        flushParagraph(paragraph, output);
        flushList(list, output);
        inCodeBlock = true;
        currentLanguage = fence[1] ?? "";
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlock.push(rawLine);
      continue;
    }

    if (!line) {
      flushParagraph(paragraph, output);
      flushList(list, output);
      continue;
    }
    const bullet = line.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      flushParagraph(paragraph, output);
      list.push(bullet[1]!.trim());
      continue;
    }
    flushList(list, output);
    const titled = line.match(/^([^：:]{1,24})[：:]\s*(.*)$/);
    if (titled) {
      flushParagraph(paragraph, output);
      output.push({ type: "heading", text: titled[1]!.trim() });
      if (titled[2]!.trim()) {
        output.push({ type: "paragraph", text: titled[2]!.trim() });
      }
      continue;
    }
    paragraph.push(line);
  }

  flushParagraph(paragraph, output);
  flushList(list, output);
  if (inCodeBlock) {
    output.push({
      type: "code",
      text: codeBlock.join("\n").trimEnd(),
      language: currentLanguage || undefined
    });
  }
  return output;
}
