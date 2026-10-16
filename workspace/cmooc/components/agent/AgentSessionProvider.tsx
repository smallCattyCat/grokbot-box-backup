"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode
} from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  planAgentCommand,
  type AgentCommandAction
} from "@/lib/agent/command-planner";
import {
  executePageAction,
  readPageBridgeState,
  waitForPageBridge,
  type PageActionResult
} from "@/lib/agent/page-bridge";
import {
  WORKBENCH_RUN_STORAGE_KEY,
  WORKBENCH_TASK_STORAGE_KEY,
  appendCanonicalAppRoute,
  buildDelegatedWorkbenchPrompt,
  buildWorkbenchDelegationInput,
  buildWorkbenchRunHandoffHref,
  consumeCanonicalAppBackRoute,
  createInitialAgentSessionState,
  createTransientWorkbenchPrompt,
  executeLocalAppAction,
  filterForwardablePriorActionReceipts,
  isForwardablePriorActionType,
  isSafeWorkbenchRunId,
  loadAgentClientSession,
  persistAgentClientSession,
  reduceAgentSession,
  shouldPreserveCurrentPageNavigation,
  type AgentClientSessionState,
  type AgentContextAttachment,
  type TransientWorkbenchPrompt
} from "@/lib/agent/client-session";
import { GlobalAgentDock } from "@/components/agent/GlobalAgentDock";
import type { WorkbenchPriorActionReceipt } from "@/lib/workbench/contracts";

export type AgentSessionContextValue = {
  attachment: AgentContextAttachment | null;
  clearAttachment: () => void;
  draft: string;
  error: string;
  executeCommand: (command: string) => Promise<boolean>;
  expanded: boolean;
  isExecuting: boolean;
  journal: AgentClientSessionState["journal"];
  phase: AgentClientSessionState["phase"];
  setAttachment: (attachment: AgentContextAttachment) => void;
  setDraft: (draft: string) => void;
  setExpanded: (expanded: boolean) => void;
  summary: string;
  workbenchPromptHandoff: TransientWorkbenchPrompt | null;
};

type WorkbenchCreatePayload = {
  error?: unknown;
  run?: {
    id?: unknown;
    taskTitle?: unknown;
  };
};

type WorkbenchSnapshotPayload = {
  id?: unknown;
  status?: unknown;
  source?: unknown;
  taskTitle?: unknown;
  capabilities?: { canSteer?: unknown };
};

type WorkbenchHistoryPayload = {
  runs?: Array<{
    id?: unknown;
    status?: unknown;
    source?: unknown;
  }>;
};

const AgentSessionContext = createContext<AgentSessionContextValue | null>(null);

function messageFromUnknown(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 220);
  if (value instanceof Error && value.message.trim()) return value.message.trim().slice(0, 220);
  return fallback;
}

function attachmentFromResult(result: PageActionResult): AgentContextAttachment | null {
  const context = result.context;
  if (!context || typeof context !== "object") return null;
  const record = context as Record<string, unknown>;
  const ref = typeof record.ref === "string"
    ? record.ref
    : typeof record.id === "string"
      ? record.id
      : "";
  const title = typeof record.label === "string"
    ? record.label
    : typeof record.title === "string"
      ? record.title
      : "";
  const sourceHref = typeof record.sourceHref === "string"
    ? record.sourceHref
    : typeof record.href === "string"
      ? record.href
      : undefined;
  return ref && title ? { ref, title, ...(sourceHref ? { sourceHref } : {}) } : null;
}

async function readCreatePayload(response: Response): Promise<WorkbenchCreatePayload> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as WorkbenchCreatePayload;
  } catch {
    return {};
  }
}

async function readJsonRecord<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}

function isDelegateAction(
  action: AgentCommandAction
): action is Extract<AgentCommandAction, { type: "workbench.delegate" }> {
  return action.type === "workbench.delegate";
}

function isDelayedWorkbenchNavigation(
  actions: readonly AgentCommandAction[],
  index: number,
  action: AgentCommandAction
): boolean {
  if (action.type !== "navigate" || action.href !== "/workbench") return false;
  const nextExecutable = actions
    .slice(index + 1)
    .find((candidate) => candidate.type !== "navigate");
  return Boolean(nextExecutable && isDelegateAction(nextExecutable));
}

function hasFollowingPageAction(
  actions: readonly AgentCommandAction[],
  index: number,
  routeId: Extract<AgentCommandAction, { type: "navigate" }>["routeId"]
): boolean {
  return actions.slice(index + 1).some((candidate) =>
    candidate.type !== "navigate" &&
    candidate.type !== "workbench.delegate" &&
    "routeId" in candidate &&
    candidate.routeId === routeId
  );
}

function actionLabel(action: AgentCommandAction): string {
  switch (action.type) {
    case "navigate":
      return `打开${action.label}`;
    case "app.go_back":
      return "返回上一页";
    case "app.refresh":
      return "刷新当前页面";
    case "world.focus_weakest":
      return "定位互动连接较弱的学习者";
    case "world.set_view":
      return action.view === "course_structure"
        ? "查看课程结构"
        : action.view === "learner_position"
          ? "查看学习者位置"
          : "查看社会网络";
    case "world.set_window":
      return action.window === "rolling_7d"
        ? "切换到最近 7 天"
        : action.window === "rolling_30d"
          ? "切换到最近 30 天"
          : "切换到全部时间";
    case "world.focus_learner":
      return `聚焦${action.learnerLabel}`;
    case "context.attach_focused":
      return "加入当前任务上下文";
    case "workbench.show_surface":
      return action.surface === "schedule"
        ? "打开周期运行"
        : action.surface === "history"
          ? "打开任务历史"
          : "打开任务对话";
    case "workbench.set_mode":
      return action.mode === "plan" ? "切换到计划模式" : "切换到默认模式";
    case "workbench.set_goal":
      return action.enabled ? "开启持续目标" : "关闭持续目标";
    case "workbench.stop":
      return "停止当前控制台任务";
    case "platform.inspect_readiness":
      return "运行平台只读诊断";
    case "workbench.delegate":
      return "交给智能控制台继续处理";
  }
}

function priorActionReceipt(
  actionType: WorkbenchPriorActionReceipt["actionType"],
  summary: string,
  attachment: AgentContextAttachment | null
): WorkbenchPriorActionReceipt {
  return {
    actionType,
    status: "completed",
    summary,
    ...(actionType === "context.attach_focused" && attachment
      ? { contextRef: attachment.ref }
      : {}),
    containsForumText: false,
    externalWrites: false
  };
}

function createCommandId(): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `command-${suffix}`;
}

export function AgentSessionProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [state, dispatch] = useReducer(reduceAgentSession, undefined, createInitialAgentSessionState);
  const [workbenchPromptHandoff, setWorkbenchPromptHandoff] = useState<TransientWorkbenchPrompt | null>(null);
  const stateRef = useRef(state);
  const activeCommandRef = useRef<AbortController | null>(null);
  const routeHistoryRef = useRef(appendCanonicalAppRoute([], pathname));
  const isExecuting = state.phase === "planning" || state.phase === "running";

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    routeHistoryRef.current = appendCanonicalAppRoute(
      routeHistoryRef.current,
      pathname
    );
  }, [pathname]);

  useEffect(() => {
    dispatch({ type: "hydrate", snapshot: loadAgentClientSession(window.sessionStorage) });
  }, []);

  useEffect(() => {
    if (!state.hydrated) return;
    persistAgentClientSession(window.sessionStorage, stateRef.current);
  }, [state.attachment, state.hydrated, state.journal]);

  useEffect(() => () => {
    activeCommandRef.current?.abort();
  }, []);

  const setAttachment = useCallback((attachment: AgentContextAttachment) => {
    dispatch({ type: "set_attachment", attachment });
  }, []);

  const clearAttachment = useCallback(() => {
    dispatch({ type: "set_attachment", attachment: null });
  }, []);

  const setDraft = useCallback((draft: string) => {
    dispatch({ type: "set_draft", draft });
  }, []);

  const setExpanded = useCallback((expanded: boolean) => {
    dispatch({ type: "set_expanded", expanded });
  }, []);

  const delegateToWorkbench = useCallback(async (
    action: Extract<AgentCommandAction, { type: "workbench.delegate" }>,
    attachment: AgentContextAttachment | null,
    signal: AbortSignal,
    completedActionReceipts: readonly WorkbenchPriorActionReceipt[],
    displayPrompt: string
  ): Promise<string> => {
    const forwardableActionReceipts = filterForwardablePriorActionReceipts(
      completedActionReceipts
    );
    const guidancePrompt = buildDelegatedWorkbenchPrompt(
      action.prompt,
      attachment,
      forwardableActionReceipts
    );
    let storedRunId = "";
    try {
      const candidate = window.sessionStorage.getItem(WORKBENCH_RUN_STORAGE_KEY);
      if (isSafeWorkbenchRunId(candidate)) storedRunId = candidate;
    } catch {
      // A new task can still be created when sessionStorage is unavailable.
    }

    const steerExistingRun = async (runId: string): Promise<string | null> => {
      const snapshotResponse = await fetch(`/api/workbench/runs/${encodeURIComponent(runId)}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal
      });
      if (!snapshotResponse.ok) return null;
      const snapshot = await readJsonRecord<WorkbenchSnapshotPayload>(snapshotResponse);
      if (
        !snapshot ||
        snapshot.id !== runId ||
        snapshot.source !== "app-server" ||
        snapshot.capabilities?.canSteer !== true
      ) {
        return null;
      }
      const guidanceResponse = await fetch(
        `/api/workbench/runs/${encodeURIComponent(runId)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            prompt: guidancePrompt,
            ...(forwardableActionReceipts.length
              ? { priorActionReceipts: forwardableActionReceipts }
              : {})
          }),
          signal
        }
      );
      if (!guidanceResponse.ok) return null;
      const taskTitle = typeof snapshot.taskTitle === "string" && snapshot.taskTitle.trim()
        ? snapshot.taskTitle.trim().slice(0, 160)
        : "智能操作任务";
      try {
        window.sessionStorage.setItem(WORKBENCH_RUN_STORAGE_KEY, runId);
        window.sessionStorage.setItem(WORKBENCH_TASK_STORAGE_KEY, taskTitle);
      } catch {
        throw new Error("引导已追加，但浏览器未能保存恢复位置。请直接打开智能控制台查看。");
      }
      setWorkbenchPromptHandoff(createTransientWorkbenchPrompt(runId, displayPrompt));
      router.replace(buildWorkbenchRunHandoffHref(runId));
      return "已把新要求追加到当前控制台任务";
    };

    const findActiveRunId = async (excludedRunId = ""): Promise<string> => {
      const historyResponse = await fetch("/api/workbench/runs?limit=12", {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal
      });
      if (!historyResponse.ok) return "";
      const history = await readJsonRecord<WorkbenchHistoryPayload>(historyResponse);
      const activeRun = history?.runs?.find((run) =>
        run.source === "app-server" &&
        (run.status === "queued" || run.status === "starting" || run.status === "running") &&
        isSafeWorkbenchRunId(run.id) &&
        run.id !== excludedRunId
      );
      return activeRun && isSafeWorkbenchRunId(activeRun.id) ? activeRun.id : "";
    };

    if (storedRunId) {
      const steered = await steerExistingRun(storedRunId);
      if (steered) return steered;
    }

    // Recover an active run even when its browser storage key was cleared.
    const activeRunId = await findActiveRunId(storedRunId);
    if (activeRunId) {
      const steered = await steerExistingRun(activeRunId);
      if (steered) return steered;
    }

    const response = await fetch("/api/workbench/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(buildWorkbenchDelegationInput(
        guidancePrompt,
        action.collaborationMode,
        action.goalMode,
        attachment,
        forwardableActionReceipts
      )),
      signal
    });
    const payload = await readCreatePayload(response);
    if (!response.ok) {
      if (response.status === 429) {
        const recoveredRunId = await findActiveRunId();
        if (recoveredRunId) {
          const steered = await steerExistingRun(recoveredRunId);
          if (steered) return steered;
          try {
            window.sessionStorage.setItem(WORKBENCH_RUN_STORAGE_KEY, recoveredRunId);
            window.sessionStorage.setItem(WORKBENCH_TASK_STORAGE_KEY, "正在运行的智能操作任务");
          } catch {
            // Navigation still gives the user a visible recovery surface.
          }
          router.replace(buildWorkbenchRunHandoffHref(recoveredRunId));
        }
        throw new Error("已有控制台任务正在执行；请打开智能控制台，在当前任务中追加这条要求。");
      }
      throw new Error(messageFromUnknown(payload.error, `控制台任务启动失败（${response.status}）。`));
    }
    const runId = typeof payload.run?.id === "string" ? payload.run.id : "";
    if (!runId) throw new Error("控制台没有返回可恢复的任务编号。");
    const taskTitle = typeof payload.run?.taskTitle === "string" && payload.run.taskTitle.trim()
      ? payload.run.taskTitle.trim().slice(0, 160)
      : "智能操作任务";

    try {
      window.sessionStorage.setItem(WORKBENCH_RUN_STORAGE_KEY, runId);
      window.sessionStorage.setItem(WORKBENCH_TASK_STORAGE_KEY, taskTitle);
    } catch {
      throw new Error("任务已经创建，但浏览器未能保存恢复位置。请直接打开智能控制台查看。 ");
    }
    setWorkbenchPromptHandoff(createTransientWorkbenchPrompt(runId, displayPrompt));
    router.replace(buildWorkbenchRunHandoffHref(runId));
    return "任务已交给智能控制台继续执行";
  }, [router]);

  const executeCommand = useCallback(async (command: string): Promise<boolean> => {
    const trimmed = command.trim();
    if (!trimmed || activeCommandRef.current) return false;

    const controller = new AbortController();
    activeCommandRef.current = controller;
    dispatch({ type: "command_planning" });
    let currentActionId = "";

    try {
      const plan = planAgentCommand(trimmed);
      const commandId = createCommandId();
      dispatch({
        type: "command_started",
        commandId,
        actions: plan.actions.map((action) => ({
          id: action.id,
          kind: action.type,
          label: actionLabel(action)
        }))
      });

      let attachment = stateRef.current.attachment;
      let finalSummary = "命令已完成";
      const completedActionReceipts: WorkbenchPriorActionReceipt[] = [];
      for (let index = 0; index < plan.actions.length; index += 1) {
        const action = plan.actions[index];
        currentActionId = action.id;
        dispatch({ type: "action_started", actionId: action.id });

        if (isDelayedWorkbenchNavigation(plan.actions, index, action)) {
          finalSummary = "将在任务创建后打开智能控制台";
          dispatch({ type: "action_completed", actionId: action.id, summary: finalSummary });
          continue;
        }

        if (action.type === "navigate") {
          const preserveCurrentPage = shouldPreserveCurrentPageNavigation({
            action,
            actions: plan.actions,
            index,
            currentPathname: pathname,
            currentBridgeRouteId: readPageBridgeState(action.routeId)?.routeId
          });
          if (!preserveCurrentPage) {
            router.push(action.href);
          }
          if (hasFollowingPageAction(plan.actions, index, action.routeId)) {
            await waitForPageBridge(action.routeId, { timeoutMs: 4_000, signal: controller.signal });
          }
          finalSummary = preserveCurrentPage
            ? `已保持${action.label}当前页面，继续执行后续页面动作`
            : `已打开${action.label}`;
        } else if (action.type === "app.go_back" || action.type === "app.refresh") {
          const localOutcome = executeLocalAppAction(action, {
            resolveBackHref: () => {
              const back = consumeCanonicalAppBackRoute(
                routeHistoryRef.current
              );
              routeHistoryRef.current = back.history;
              return back.href;
            },
            navigate: (href) => router.push(href),
            refresh: () => router.refresh()
          });
          if (localOutcome.status !== "completed") {
            throw new Error(localOutcome.summary);
          }
          finalSummary = localOutcome.summary;
        } else if (isDelegateAction(action)) {
          finalSummary = await delegateToWorkbench(
            action,
            attachment,
            controller.signal,
            completedActionReceipts,
            trimmed
          );
        } else {
          const result = await executePageAction(action, {
            waitForMs: 4_000,
            signal: controller.signal
          });
          if (result.status !== "completed") {
            throw new Error(result.summary || "页面动作未能完成。");
          }
          const resultAttachment = attachmentFromResult(result);
          if (resultAttachment) {
            attachment = resultAttachment;
            dispatch({ type: "set_attachment", attachment: resultAttachment });
          }
          finalSummary = result.summary || actionLabel(action);
        }
        dispatch({ type: "action_completed", actionId: action.id, summary: finalSummary });
        if (
          !isDelegateAction(action) &&
          isForwardablePriorActionType(action.type)
        ) {
          completedActionReceipts.push(
            priorActionReceipt(action.type, finalSummary, attachment)
          );
        }
      }
      dispatch({ type: "command_completed", summary: finalSummary });
      return true;
    } catch (cause) {
      if (controller.signal.aborted) return false;
      const message = messageFromUnknown(cause, "命令执行中断，可修改要求后重试。");
      if (currentActionId) {
        dispatch({ type: "action_failed", actionId: currentActionId, message });
      } else {
        dispatch({ type: "command_failed", message });
      }
      dispatch({ type: "set_draft", draft: trimmed });
      return false;
    } finally {
      if (activeCommandRef.current === controller) activeCommandRef.current = null;
    }
  }, [delegateToWorkbench, pathname, router]);

  const value = useMemo<AgentSessionContextValue>(() => ({
    attachment: state.attachment,
    clearAttachment,
    draft: state.draft,
    error: state.error,
    executeCommand,
    expanded: state.expanded,
    isExecuting,
    journal: state.journal,
    phase: state.phase,
    setAttachment,
    setDraft,
    setExpanded,
    summary: state.summary,
    workbenchPromptHandoff
  }), [
    clearAttachment,
    executeCommand,
    isExecuting,
    setAttachment,
    setDraft,
    setExpanded,
    state.attachment,
    state.draft,
    state.error,
    state.expanded,
    state.journal,
    state.phase,
    state.summary,
    workbenchPromptHandoff
  ]);

  return (
    <AgentSessionContext.Provider value={value}>
      {children}
      {!pathname.startsWith("/workbench") ? <GlobalAgentDock {...value} /> : null}
    </AgentSessionContext.Provider>
  );
}

export function useAgentSession(): AgentSessionContextValue {
  const value = useContext(AgentSessionContext);
  if (!value) throw new Error("useAgentSession 必须在 AgentSessionProvider 内使用。");
  return value;
}
