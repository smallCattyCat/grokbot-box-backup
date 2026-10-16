import type { WorkbenchCollaborationMode, WorkbenchRunStatus } from "../workbench/contracts";
import type {
  PageBridgeAction,
  PageBridgeExecutionOutcome,
  PageBridgeState
} from "./page-bridge";

export type WorkbenchPageActionRuntimeState = {
  surface: "conversation" | "schedule";
  collaborationMode: WorkbenchCollaborationMode;
  goalMode: boolean;
  historyOpen: boolean;
  runStatus: WorkbenchRunStatus | "idle";
  canStop: boolean;
  stopPending: boolean;
  revision: number;
};

export type WorkbenchStopReadback = {
  runStatus: WorkbenchRunStatus;
  canStop: boolean;
  revision?: number;
};

export const WORKBENCH_PAGE_ACTION_CAPABILITIES = [
  "workbench.show_surface",
  "workbench.set_mode",
  "workbench.set_goal",
  "workbench.stop"
] as const;

export function createWorkbenchPageBridgeState(
  runtime: WorkbenchPageActionRuntimeState
): PageBridgeState {
  const surfaceLabel = runtime.historyOpen
    ? "任务历史"
    : runtime.surface === "schedule"
      ? "周期运行"
      : "任务对话";
  return {
    schemaVersion: "cmooc.page-bridge-state.v1",
    routeId: "workbench",
    href: "/workbench",
    status: runtime.stopPending ? "busy" : "ready",
    capabilities: WORKBENCH_PAGE_ACTION_CAPABILITIES,
    revision: runtime.revision,
    summary: runtime.stopPending
      ? "智能控制台正在停止当前任务。"
      : `智能控制台已就绪，当前显示${surfaceLabel}。`,
    attachedContexts: [],
    metadata: {
      surface: runtime.surface,
      collaborationMode: runtime.collaborationMode,
      goalMode: runtime.goalMode,
      historyOpen: runtime.historyOpen,
      runStatus: runtime.runStatus,
      canStop: runtime.canStop,
      stopPending: runtime.stopPending
    },
    containsForumText: false,
    externalWrites: false
  };
}

export function transitionWorkbenchPageAction(input: {
  current: WorkbenchPageActionRuntimeState;
  action: Exclude<PageBridgeAction, { type: "workbench.stop" }>;
}): {
  next: WorkbenchPageActionRuntimeState;
  outcome: PageBridgeExecutionOutcome;
} {
  const { current, action } = input;
  let next: WorkbenchPageActionRuntimeState;
  let summary: string;

  switch (action.type) {
    case "workbench.show_surface":
      if (action.surface === "history") {
        next = {
          ...current,
          historyOpen: true,
          revision: current.revision + 1
        };
        summary = "已打开任务历史。";
      } else {
        next = {
          ...current,
          surface: action.surface,
          historyOpen: false,
          revision: current.revision + 1
        };
        summary = action.surface === "schedule"
          ? "已打开周期运行。"
          : "已回到任务对话。";
      }
      break;
    case "workbench.set_mode":
      next = {
        ...current,
        collaborationMode: action.mode,
        revision: current.revision + 1
      };
      summary = action.mode === "plan"
        ? "下一任务已切换为计划模式；当前运行不受影响。"
        : "下一任务已切换为默认模式；当前运行不受影响。";
      break;
    case "workbench.set_goal":
      next = {
        ...current,
        goalMode: action.enabled,
        revision: current.revision + 1
      };
      summary = action.enabled
        ? "下一任务已开启持续目标；当前运行不受影响。"
        : "下一任务已关闭持续目标；当前运行不受影响。";
      break;
    default:
      return {
        next: current,
        outcome: {
          status: "unsupported",
          summary: "智能控制台不支持此页面动作。",
          retryable: false,
          errorCode: "WORKBENCH_PAGE_ACTION_UNSUPPORTED"
        }
      };
  }

  return {
    next,
    outcome: {
      status: "completed",
      summary,
      state: createWorkbenchPageBridgeState(next)
    }
  };
}

function idempotentStopSummary(
  status: WorkbenchPageActionRuntimeState["runStatus"]
): string {
  if (status === "completed") return "当前任务已经完成，无需停止。";
  if (status === "failed") return "当前任务已经失败并结束，无需停止。";
  if (status === "stopped") return "当前任务已经停止，无需重复停止。";
  return "当前页面没有活动任务，无需停止。";
}

function terminalStopSummary(status: WorkbenchRunStatus): string | null {
  if (status === "stopped") return "当前任务已停止。";
  if (status === "completed") {
    return "当前任务在停止请求处理期间已经完成；保留完成结果，没有改写为停止。";
  }
  if (status === "failed") {
    return "当前任务在停止请求处理期间已经失败；保留失败结果，没有改写为停止。";
  }
  return null;
}

/**
 * Executes Workbench page controls while keeping stop honest: a stop receipt is
 * derived only from the server snapshot returned after the interrupt request.
 */
export async function executeWorkbenchPageAction(input: {
  current: WorkbenchPageActionRuntimeState;
  action: PageBridgeAction;
  stopCurrentRun: () => Promise<WorkbenchStopReadback | null>;
}): Promise<{
  next: WorkbenchPageActionRuntimeState;
  outcome: PageBridgeExecutionOutcome;
}> {
  const { current, action } = input;
  if (action.type !== "workbench.stop") {
    return transitionWorkbenchPageAction({ current, action });
  }

  if (
    current.runStatus === "idle" ||
    current.runStatus === "completed" ||
    current.runStatus === "failed" ||
    current.runStatus === "stopped"
  ) {
    return {
      next: current,
      outcome: {
        status: "completed",
        summary: idempotentStopSummary(current.runStatus),
        state: createWorkbenchPageBridgeState(current)
      }
    };
  }

  let readback: WorkbenchStopReadback | null;
  try {
    readback = await input.stopCurrentRun();
  } catch {
    readback = null;
  }
  if (!readback) {
    return {
      next: current,
      outcome: {
        status: "failed",
        summary: "停止请求未返回可核验的任务状态，尚未确认停止。",
        retryable: true,
        errorCode: "WORKBENCH_STOP_READBACK_MISSING"
      }
    };
  }

  const next: WorkbenchPageActionRuntimeState = {
    ...current,
    runStatus: readback.runStatus,
    canStop: readback.canStop,
    stopPending: false,
    revision: Math.max(
      current.revision + 1,
      Number.isSafeInteger(readback.revision) && (readback.revision ?? 0) >= 0
        ? readback.revision ?? 0
        : 0
    )
  };
  const terminalSummary = terminalStopSummary(readback.runStatus);
  if (terminalSummary) {
    return {
      next,
      outcome: {
        status: "completed",
        summary: terminalSummary,
        state: createWorkbenchPageBridgeState(next)
      }
    };
  }

  return {
    next,
    outcome: {
      status: "failed",
      summary: "停止请求返回后任务仍在运行，尚未确认停止。",
      retryable: true,
      errorCode: "WORKBENCH_STOP_NOT_TERMINAL",
      state: createWorkbenchPageBridgeState(next)
    }
  };
}
