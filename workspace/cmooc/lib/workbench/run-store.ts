import { randomUUID } from "node:crypto";
import {
  SAFE_WORKBENCH_STATE,
  WORKBENCH_SCHEMA_VERSION,
  WorkbenchAgent,
  WorkbenchArtifact,
  WorkbenchEvent,
  WorkbenchEventKind,
  WorkbenchEventStatus,
  WorkbenchPresentationRole,
  WorkbenchRunSnapshot,
  WorkbenchRunStatus,
  WorkbenchSource,
  WorkbenchTool,
  WorkbenchContextSummary,
  WorkbenchCollaborationMode,
  WorkbenchGoalState,
  WorkbenchPlanState,
  WorkbenchPendingAction,
  WorkbenchPriorActionReceipt,
  WorkbenchRunLineage,
  WorkbenchSessionWorkspaceSummary,
  WorkbenchCitation,
  WORKBENCH_LINEAGE_SCHEMA_VERSION,
  isSafeRunId,
  isTerminalWorkbenchStatus,
  isWorkbenchRunLineage,
  isWorkbenchSessionWorkspaceSummary,
  isWorkbenchPendingAction,
  redactPublicText,
  sanitizeWorkbenchLiveExcerpt,
  sanitizeWorkbenchCitations
} from "@/lib/workbench/contracts";

const EVENT_RING_LIMIT = 500;
const RUN_REGISTRY_LIMIT = 20;
const AGENT_LIMIT = 32;
const TOOL_LIMIT = 64;
const ARTIFACT_LIMIT = 200;

export type WorkbenchRunSession = {
  steer(
    prompt: string,
    priorActionReceipts?: readonly WorkbenchPriorActionReceipt[]
  ): Promise<void>;
  stop(): Promise<void>;
};

export type WorkbenchEventDraft = {
  kind: WorkbenchEventKind;
  status: WorkbenchEventStatus;
  title: string;
  summary?: string;
  liveExcerpt?: string;
  agentKey?: string;
  agentLabel?: string;
  agentRole?: WorkbenchEvent["agentRole"];
  presentationRole?: WorkbenchPresentationRole;
  toolKey?: string;
  artifactId?: string;
  activityId?: string;
};

type RunListener = (event: WorkbenchEvent) => void;

type InternalRun = {
  snapshot: WorkbenchRunSnapshot;
  listeners: Set<RunListener>;
  session?: WorkbenchRunSession;
  threadId?: string;
  turnId?: string;
  stopRequested: boolean;
  stopPromise?: Promise<WorkbenchRunSnapshot | undefined>;
};

type StoreState = {
  runs: Map<string, InternalRun>;
  activeRunId?: string;
};

const STORE_KEY = "__cmooc_workbench_run_store__";

function getStore(): StoreState {
  const root = globalThis as typeof globalThis & {
    [STORE_KEY]?: StoreState;
  };
  if (!root[STORE_KEY]) {
    root[STORE_KEY] = { runs: new Map() };
  }
  return root[STORE_KEY];
}

function now(): string {
  return new Date().toISOString();
}

function publicTitle(value: unknown): string {
  return redactPublicText(value, 240) || "工作台事件";
}

function publicSummary(value: unknown): string | undefined {
  const text = redactPublicText(value);
  return text || undefined;
}

function inferPresentationRole(
  draft: WorkbenchEventDraft
): WorkbenchPresentationRole {
  if (draft.presentationRole) return draft.presentationRole;
  if (draft.kind === "tool" || draft.kind === "artifact") return "tool";
  if (draft.kind === "run" || draft.kind === "warning" || draft.kind === "error") {
    return "system";
  }
  return "assistant";
}

function cloneSnapshot(snapshot: WorkbenchRunSnapshot): WorkbenchRunSnapshot {
  return {
    ...snapshot,
    events: snapshot.events.map((event) => ({ ...event })),
    agents: snapshot.agents.map((agent) => ({ ...agent })),
    tools: snapshot.tools.map((tool) => ({ ...tool })),
    artifacts: snapshot.artifacts.map((artifact) => ({ ...artifact })),
    pendingAction: snapshot.pendingAction
      ? {
          ...snapshot.pendingAction,
          operationBoundary: { ...snapshot.pendingAction.operationBoundary }
        }
      : undefined,
    finalResult: snapshot.finalResult
      ? {
          ...snapshot.finalResult,
          citations: snapshot.finalResult.citations?.map((citation) => ({ ...citation }))
        }
      : undefined,
    safety: { ...snapshot.safety },
    capabilities: { ...snapshot.capabilities },
    context: snapshot.context ? { ...snapshot.context } : undefined,
    sessionWorkspace: snapshot.sessionWorkspace
      ? { ...snapshot.sessionWorkspace }
      : undefined,
    plan: snapshot.plan
      ? { ...snapshot.plan, steps: snapshot.plan.steps.map((step) => ({ ...step })) }
      : undefined,
    goal: snapshot.goal ? { ...snapshot.goal } : undefined,
    lineage: snapshot.lineage ? { ...snapshot.lineage } : undefined
  };
}

function findRun(runId: string): InternalRun | undefined {
  return getStore().runs.get(runId);
}

function updateActiveRun(store: StoreState, run: InternalRun): void {
  if (isTerminalWorkbenchStatus(run.snapshot.status)) {
    if (store.activeRunId === run.snapshot.id) {
      store.activeRunId = undefined;
    }
    return;
  }
  store.activeRunId = run.snapshot.id;
}

function releaseTerminalSession(run: InternalRun): void {
  const session = run.session;
  if (!session) return;
  run.session = undefined;
  run.snapshot.capabilities = {
    ...run.snapshot.capabilities,
    canSteer: false,
    canStop: false
  };
  void session.stop();
}

function cleanupRunRegistry(store: StoreState): void {
  for (const run of store.runs.values()) {
    if (isTerminalWorkbenchStatus(run.snapshot.status)) {
      releaseTerminalSession(run);
    }
  }
  while (store.runs.size > RUN_REGISTRY_LIMIT) {
    const oldest = store.runs.entries().next().value as [string, InternalRun] | undefined;
    if (!oldest) break;
    const [runId, run] = oldest;
    if (!isTerminalWorkbenchStatus(run.snapshot.status) || runId === store.activeRunId) break;
    store.runs.delete(runId);
  }
}

export function getActiveWorkbenchRun(): WorkbenchRunSnapshot | undefined {
  const store = getStore();
  const id = store.activeRunId;
  if (!id) return undefined;
  const run = store.runs.get(id);
  if (!run || isTerminalWorkbenchStatus(run.snapshot.status)) {
    store.activeRunId = undefined;
    return undefined;
  }
  return cloneSnapshot(run.snapshot);
}

export function createWorkbenchRun(input: {
  prompt: string;
  source: WorkbenchSource;
  runId?: string;
  lineage?: WorkbenchRunLineage;
  collaborationMode?: WorkbenchCollaborationMode;
  goalMode?: boolean;
  taskTitle?: string;
  context?: WorkbenchContextSummary;
  courseGoalCode?: WorkbenchRunSnapshot["courseGoalCode"];
}): WorkbenchRunSnapshot {
  const store = getStore();
  cleanupRunRegistry(store);
  if (store.activeRunId) {
    const active = store.runs.get(store.activeRunId);
    if (active && !isTerminalWorkbenchStatus(active.snapshot.status)) {
      throw new Error("WORKBENCH_ACTIVE_RUN");
    }
    store.activeRunId = undefined;
  }

  const timestamp = now();
  const runId = input.runId ?? randomUUID();
  if (!isSafeRunId(runId) || store.runs.has(runId)) {
    throw new Error("WORKBENCH_RUN_ID_INVALID");
  }
  const lineage: WorkbenchRunLineage = input.lineage ?? {
    schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
    relation: "root",
    rootRunId: runId,
    generation: 0
  };
  if (!isWorkbenchRunLineage(lineage, runId)) {
    throw new Error("WORKBENCH_LINEAGE_INVALID");
  }
  const snapshot: WorkbenchRunSnapshot = {
    schemaVersion: WORKBENCH_SCHEMA_VERSION,
    id: runId,
    status: "queued",
    source: input.source,
    projectLabel: "cMOOC 源码工作区",
    collaborationMode: input.collaborationMode ?? "default",
    goalMode: input.goalMode ?? false,
    lineage: { ...lineage },
    taskTitle: publicTitle(input.taskTitle ?? input.context?.title ?? "课程研判任务"),
    context: input.context ? { ...input.context } : undefined,
    ...(input.courseGoalCode ? { courseGoalCode: input.courseGoalCode } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    events: [],
    firstEventSeq: 0,
    lastEventSeq: 0,
    agents: [
      {
        key: "sol",
        label: "主任务智能体",
        role: "sol",
        status: "idle",
        lastActivityAt: timestamp
      }
    ],
    tools: [],
    artifacts: [],
    safety: { ...SAFE_WORKBENCH_STATE },
    capabilities: {
      canSteer: input.source === "app-server",
      canStop: true,
      canRestart: false,
      canContinue: false,
      liveHarness: input.source === "app-server",
      planMode: input.source === "app-server",
      goalMode: input.source === "app-server",
      computerUse: "external-read-only"
    }
  };
  const run: InternalRun = {
    snapshot,
    listeners: new Set(),
    stopRequested: false
  };
  store.runs.set(runId, run);
  store.activeRunId = runId;
  cleanupRunRegistry(store);
  appendWorkbenchEvent(runId, {
    kind: "run",
    status: "queued",
    title: "任务已排队",
    summary: input.source === "demo" ? "演示任务已排队。" : "任务已进入受约束的本机运行。"
  });
  return cloneSnapshot(run.snapshot);
}

export function getWorkbenchRun(runId: string): WorkbenchRunSnapshot | undefined {
  const run = findRun(runId);
  return run ? cloneSnapshot(run.snapshot) : undefined;
}

export function getWorkbenchRunInternal(runId: string): {
  id: string;
  stopRequested: boolean;
  threadId?: string;
  turnId?: string;
} | undefined {
  const run = findRun(runId);
  if (!run) return undefined;
  return {
    id: run.snapshot.id,
    stopRequested: run.stopRequested,
    threadId: run.threadId,
    turnId: run.turnId
  };
}

export function setWorkbenchSessionWorkspace(
  runId: string,
  workspace: WorkbenchSessionWorkspaceSummary
): WorkbenchRunSnapshot | undefined {
  const run = findRun(runId);
  if (
    !run ||
    run.snapshot.source !== "app-server" ||
    !isWorkbenchSessionWorkspaceSummary(workspace)
  ) {
    return undefined;
  }
  run.snapshot.sessionWorkspace = { ...workspace };
  run.snapshot.updatedAt = now();
  return cloneSnapshot(run.snapshot);
}

export function appendWorkbenchEvent(
  runId: string,
  draft: WorkbenchEventDraft
): WorkbenchEvent | undefined {
  const run = findRun(runId);
  if (!run) return undefined;
  const at = now();
  const seq = run.snapshot.lastEventSeq + 1;
  const event: WorkbenchEvent = {
    schemaVersion: WORKBENCH_SCHEMA_VERSION,
    runId,
    seq,
    at,
    kind: draft.kind,
    status: draft.status,
    title: publicTitle(draft.title),
    presentationRole: inferPresentationRole(draft)
  };
  const summary = publicSummary(draft.summary);
  if (summary) event.summary = summary;
  const liveExcerpt = sanitizeWorkbenchLiveExcerpt(draft.liveExcerpt);
  if (liveExcerpt) event.liveExcerpt = liveExcerpt;
  if (draft.agentKey) event.agentKey = redactPublicText(draft.agentKey, 80);
  if (draft.agentLabel) event.agentLabel = redactPublicText(draft.agentLabel, 80);
  if (draft.agentRole) event.agentRole = draft.agentRole;
  if (draft.toolKey) event.toolKey = redactPublicText(draft.toolKey, 100);
  if (draft.artifactId) event.artifactId = redactPublicText(draft.artifactId, 120);
  if (draft.activityId && /^activity-[A-Za-z0-9_-]{1,72}$/.test(draft.activityId)) {
    event.activityId = draft.activityId;
  }

  run.snapshot.events.push(event);
  if (run.snapshot.events.length > EVENT_RING_LIMIT) {
    run.snapshot.events.splice(0, run.snapshot.events.length - EVENT_RING_LIMIT);
  }
  run.snapshot.firstEventSeq = run.snapshot.events[0]?.seq ?? seq;
  run.snapshot.lastEventSeq = seq;
  run.snapshot.updatedAt = at;
  for (const listener of run.listeners) {
    try {
      listener({ ...event });
    } catch {
      // A disconnected SSE consumer must never interrupt the run.
    }
  }
  return { ...event };
}

export function setWorkbenchRunStatus(
  runId: string,
  status: WorkbenchRunStatus,
  options?: { summary?: string; errorCode?: string }
): WorkbenchRunSnapshot | undefined {
  const run = findRun(runId);
  if (!run) return undefined;
  if (isTerminalWorkbenchStatus(run.snapshot.status)) {
    return cloneSnapshot(run.snapshot);
  }
  run.snapshot.status = status;
  run.snapshot.updatedAt = now();
  if (options?.errorCode) {
    run.snapshot.errorCode = options.errorCode.replace(/[^A-Z0-9_\-]/g, "").slice(0, 80) || "WORKBENCH_ERROR";
  }
  updateActiveRun(getStore(), run);
  appendWorkbenchEvent(runId, {
    kind: "run",
    status:
      status === "completed"
        ? "completed"
        : status === "failed"
          ? "failed"
          : status === "stopped"
            ? "stopped"
            : status === "running"
              ? "running"
              : status === "awaiting_action"
                ? "info"
              : "queued",
    title:
      status === "completed"
        ? "任务已完成"
        : status === "failed"
          ? "任务未完成"
          : status === "stopped"
            ? "任务已停止"
            : status === "running"
              ? "任务正在运行"
              : status === "awaiting_action"
                ? "任务等待本次授权"
              : "任务正在启动",
    summary: options?.summary
  });
  return cloneSnapshot(run.snapshot);
}

export function setWorkbenchPendingAction(
  runId: string,
  action: WorkbenchPendingAction | null
): WorkbenchRunSnapshot | undefined {
  const run = findRun(runId);
  if (!run || isTerminalWorkbenchStatus(run.snapshot.status)) return undefined;
  if (action !== null && !isWorkbenchPendingAction(action)) return undefined;
  run.snapshot.pendingAction = action
    ? {
        ...action,
        operationBoundary: { ...action.operationBoundary }
      }
    : undefined;
  run.snapshot.updatedAt = now();
  run.snapshot.capabilities = {
    ...run.snapshot.capabilities,
    canSteer: action === null && Boolean(run.session),
    canStop: action === null
  };
  return cloneSnapshot(run.snapshot);
}

export function completeWorkbenchRun(
  runId: string,
  status: "completed" | "failed" | "stopped",
  summary: string,
  errorCode?: string,
  citations: readonly WorkbenchCitation[] = []
): WorkbenchRunSnapshot | undefined {
  const run = findRun(runId);
  if (!run) return undefined;
  if (isTerminalWorkbenchStatus(run.snapshot.status)) {
    return cloneSnapshot(run.snapshot);
  }
  const completedAt = now();
  run.snapshot.pendingAction = undefined;
  run.snapshot.events = run.snapshot.events.map(({ liveExcerpt: _liveExcerpt, ...event }) => event);
  run.snapshot.finalResult = {
    status,
    summary: redactPublicText(summary) ||
      (status === "completed" ? "任务已完成。" : status === "stopped" ? "任务已停止。" : "任务未完成。"),
    completedAt,
    ...(status === "completed" && citations.length
      ? { citations: sanitizeWorkbenchCitations(citations) }
      : {})
  };
  if (errorCode) {
    run.snapshot.errorCode = errorCode.replace(/[^A-Z0-9_\-]/g, "").slice(0, 80) || "WORKBENCH_ERROR";
  }
  if (status !== "completed" && run.session) {
    const terminalSession = run.session;
    run.session = undefined;
    if (!run.stopRequested) void terminalSession.stop();
  }
  if ((status === "failed" || status === "stopped") && run.snapshot.goal?.status === "active") {
    run.snapshot.goal = {
      ...run.snapshot.goal,
      status: "paused",
      updatedAt: completedAt
    };
  }
  run.snapshot.status = status;
  run.snapshot.updatedAt = completedAt;
  const terminalResourceStatus = status;
  run.snapshot.agents = run.snapshot.agents.map((agent) =>
    agent.status === "running"
      ? { ...agent, status: terminalResourceStatus, lastActivityAt: completedAt }
      : agent
  );
  run.snapshot.tools = run.snapshot.tools.map((tool) =>
    tool.status === "running"
      ? { ...tool, status: terminalResourceStatus, lastActivityAt: completedAt }
      : tool
  );
  run.snapshot.capabilities = {
    ...run.snapshot.capabilities,
    canSteer: status === "completed" && Boolean(run.session),
    canStop: false,
    canRestart:
      status === "failed" &&
      run.snapshot.source === "app-server" &&
      Boolean(run.snapshot.sessionWorkspace),
    canContinue:
      status === "completed" &&
      run.snapshot.source === "app-server" &&
      Boolean(run.snapshot.finalResult)
  };
  updateActiveRun(getStore(), run);
  appendWorkbenchEvent(runId, {
    kind: "result",
    status,
    title:
      status === "completed"
        ? "运行结果已就绪"
        : status === "stopped"
          ? "运行已中断"
          : "运行结果失败",
    summary: run.snapshot.finalResult.summary
  });
  return cloneSnapshot(run.snapshot);
}

export function setWorkbenchSession(
  runId: string,
  session: WorkbenchRunSession | undefined
): boolean {
  const run = findRun(runId);
  if (!run) return false;
  if (
    session &&
    (run.stopRequested || isTerminalWorkbenchStatus(run.snapshot.status))
  ) {
    void Promise.resolve()
      .then(() => session.stop())
      .catch(() => undefined);
    return false;
  }
  run.session = session;
  return true;
}

export function setWorkbenchProtocolIds(
  runId: string,
  ids: { threadId?: string; turnId?: string }
): boolean {
  const run = findRun(runId);
  if (!run) return false;
  if (ids.threadId) run.threadId = ids.threadId;
  if (ids.turnId) run.turnId = ids.turnId;
  return true;
}

export function setWorkbenchPlan(
  runId: string,
  plan: Omit<WorkbenchPlanState, "updatedAt"> & { updatedAt?: string }
): boolean {
  const run = findRun(runId);
  if (!run) return false;
  const steps = plan.steps
    .slice(0, 12)
    .map((entry) => ({
      step: redactPublicText(entry.step, 240),
      status: entry.status
    }))
    .filter((entry) => entry.step.length > 0);
  run.snapshot.plan = {
    ...(plan.explanation
      ? { explanation: redactPublicText(plan.explanation, 600) }
      : {}),
    steps,
    updatedAt: plan.updatedAt ?? now()
  };
  run.snapshot.updatedAt = now();
  return true;
}

export function setWorkbenchGoal(
  runId: string,
  goal: Omit<WorkbenchGoalState, "updatedAt"> & { updatedAt?: string }
): boolean {
  const run = findRun(runId);
  if (!run) return false;
  run.snapshot.goal = {
    status: goal.status,
    ...(typeof goal.tokenBudget === "number" && Number.isFinite(goal.tokenBudget)
      ? { tokenBudget: Math.max(0, Math.floor(goal.tokenBudget)) }
      : {}),
    tokensUsed: Math.max(0, Math.floor(goal.tokensUsed)),
    timeUsedSeconds: Math.max(0, Math.floor(goal.timeUsedSeconds)),
    updatedAt: goal.updatedAt ?? now()
  };
  run.snapshot.updatedAt = now();
  return true;
}

export function markWorkbenchStopRequested(runId: string): boolean {
  const run = findRun(runId);
  if (!run) return false;
  run.stopRequested = true;
  return true;
}

export async function stopWorkbenchRun(runId: string): Promise<WorkbenchRunSnapshot | undefined> {
  const run = findRun(runId);
  if (!run) return undefined;
  if (isTerminalWorkbenchStatus(run.snapshot.status)) {
    return cloneSnapshot(run.snapshot);
  }
  if (run.stopPromise) return run.stopPromise;
  run.stopRequested = true;
  const stopPromise = (async () => {
    const session = run.session;
    let stopConfirmed = true;
    if (session) {
      try {
        await session.stop();
      } catch {
        stopConfirmed = false;
      }
    }
    const afterStop = getWorkbenchRun(runId);
    if (afterStop && isTerminalWorkbenchStatus(afterStop.status)) return afterStop;
    if (!stopConfirmed) {
      return completeWorkbenchRun(
        runId,
        "failed",
        "本机执行进程未能确认停止，任务已按失败结果收束。",
        "WORKBENCH_STOP_UNCONFIRMED"
      );
    }
    return completeWorkbenchRun(runId, "stopped", "任务已按请求停止。", "WORKBENCH_STOPPED");
  })();
  run.stopPromise = stopPromise;
  try {
    return await stopPromise;
  } finally {
    if (run.stopPromise === stopPromise) run.stopPromise = undefined;
  }
}

export async function steerWorkbenchRun(
  runId: string,
  prompt: string,
  priorActionReceipts: readonly WorkbenchPriorActionReceipt[] = []
): Promise<WorkbenchRunSnapshot | undefined> {
  const run = findRun(runId);
  if (!run) return undefined;
  if (run.snapshot.status === "awaiting_action" || run.snapshot.pendingAction) {
    throw new Error("WORKBENCH_ACTION_PENDING");
  }
  if (!run.session) throw new Error("WORKBENCH_SESSION_UNAVAILABLE");
  const store = getStore();
  if (store.activeRunId && store.activeRunId !== runId) {
    const active = store.runs.get(store.activeRunId);
    if (active && !isTerminalWorkbenchStatus(active.snapshot.status)) {
      throw new Error("WORKBENCH_ACTIVE_RUN");
    }
  }
  if (isTerminalWorkbenchStatus(run.snapshot.status)) {
    reopenWorkbenchRun(runId);
  }
  try {
    await run.session.steer(prompt, priorActionReceipts);
  } catch (error) {
    completeWorkbenchRun(
      runId,
      "failed",
      "追加引导未能提交。",
      error instanceof Error && /^CODEX_/.test(error.message)
        ? error.message
        : "WORKBENCH_STEER_FAILED"
    );
    throw error;
  }
  return cloneSnapshot(run.snapshot);
}

/** Re-opens a completed turn while retaining its ephemeral thread session. */
export function reopenWorkbenchRun(runId: string): WorkbenchRunSnapshot | undefined {
  const run = findRun(runId);
  if (!run || !run.session || run.snapshot.status === "stopped") return undefined;
  run.snapshot.status = "running";
  run.snapshot.finalResult = undefined;
  run.snapshot.errorCode = undefined;
  run.snapshot.capabilities = {
    ...run.snapshot.capabilities,
    canSteer: true,
    canStop: true
  };
  run.stopRequested = false;
  run.snapshot.updatedAt = now();
  getStore().activeRunId = runId;
  appendWorkbenchEvent(runId, {
    kind: "run",
    status: "running",
    title: "已在同一线程开始新一轮任务",
    summary: "上一轮已结束；追加引导继续使用临时线程。"
  });
  return cloneSnapshot(run.snapshot);
}

export function subscribeWorkbenchRun(runId: string, listener: RunListener): (() => void) | undefined {
  const run = findRun(runId);
  if (!run) return undefined;
  run.listeners.add(listener);
  return () => run.listeners.delete(listener);
}

export function getWorkbenchEventsAfter(runId: string, afterSeq: number): WorkbenchEvent[] | undefined {
  const run = findRun(runId);
  if (!run) return undefined;
  return run.snapshot.events.filter((event) => event.seq > afterSeq).map((event) => ({ ...event }));
}

export function updateWorkbenchAgent(
  runId: string,
  agent: Omit<WorkbenchAgent, "lastActivityAt"> & { lastActivityAt?: string }
): boolean {
  const run = findRun(runId);
  if (!run) return false;
  const key = redactPublicText(agent.key, 80).replace(/[^A-Za-z0-9_.:-]/g, "_") || "agent";
  const index = run.snapshot.agents.findIndex((item) => item.key === key);
  if (index === -1 && run.snapshot.agents.length >= AGENT_LIMIT) return false;
  const next: WorkbenchAgent = {
    ...agent,
    key,
    label: publicTitle(agent.label),
    taskSummary: publicSummary(agent.taskSummary),
    lastActivityAt: agent.lastActivityAt ?? now()
  };
  if (index === -1) run.snapshot.agents.push(next);
  else run.snapshot.agents[index] = next;
  run.snapshot.updatedAt = next.lastActivityAt;
  return true;
}

export function updateWorkbenchTool(
  runId: string,
  tool: Omit<WorkbenchTool, "lastActivityAt"> & { lastActivityAt?: string }
): boolean {
  const run = findRun(runId);
  if (!run) return false;
  const key = redactPublicText(tool.key, 100).replace(/[^A-Za-z0-9_.:-]/g, "_") || "tool";
  const index = run.snapshot.tools.findIndex((item) => item.key === key);
  if (index === -1 && run.snapshot.tools.length >= TOOL_LIMIT) return false;
  const next: WorkbenchTool = {
    ...tool,
    key,
    label: publicTitle(tool.label),
    callCount: Math.max(0, Math.min(10_000, Math.floor(tool.callCount))),
    lastActivityAt: tool.lastActivityAt ?? now()
  };
  if (index === -1) run.snapshot.tools.push(next);
  else run.snapshot.tools[index] = next;
  run.snapshot.updatedAt = next.lastActivityAt;
  return true;
}

export function addWorkbenchArtifact(
  runId: string,
  artifact: WorkbenchArtifact
): boolean {
  const run = findRun(runId);
  if (!run) return false;
  const safeArtifact = {
    ...artifact,
    id: redactPublicText(artifact.id, 120),
    label: publicTitle(artifact.label),
    relativePath: redactPublicText(artifact.relativePath, 500)
      .replace(/\\/g, "/")
      .replace(/^\/+/, ""),
    observedAt: artifact.observedAt || now()
  };
  if (
    !safeArtifact.id ||
    !safeArtifact.relativePath ||
    safeArtifact.relativePath.includes("[本机路径已隐藏]") ||
    safeArtifact.relativePath.split("/").includes("..")
  ) {
    return false;
  }
  const index = run.snapshot.artifacts.findIndex((item) => item.id === safeArtifact.id);
  if (index === -1 && run.snapshot.artifacts.length >= ARTIFACT_LIMIT) return false;
  if (index === -1) run.snapshot.artifacts.push(safeArtifact);
  else run.snapshot.artifacts[index] = safeArtifact;
  run.snapshot.updatedAt = safeArtifact.observedAt;
  return true;
}

export function resetWorkbenchStoreForTests(): void {
  const store = getStore();
  for (const run of store.runs.values()) {
    run.listeners.clear();
    if (run.session) void run.session.stop();
  }
  store.runs.clear();
  store.activeRunId = undefined;
}

export const resetForTests = resetWorkbenchStoreForTests;

export const WORKBENCH_EVENT_RING_LIMIT = EVENT_RING_LIMIT;
export const WORKBENCH_RUN_REGISTRY_LIMIT = RUN_REGISTRY_LIMIT;
export const WORKBENCH_AGENT_LIMIT = AGENT_LIMIT;
export const WORKBENCH_TOOL_LIMIT = TOOL_LIMIT;
export const WORKBENCH_ARTIFACT_LIMIT = ARTIFACT_LIMIT;
