import type { CmoocUiReadinessReceipt } from "@/lib/platform-readiness/cmooc-ui-readiness";
import type { PlatformInspectReadinessAction } from "./command-planner";
import {
  PAGE_BRIDGE_STATE_VERSION,
  type PageBridgeExecutionOutcome,
  type PageBridgeState
} from "./page-bridge";

export const PLATFORM_PAGE_ACTION_CAPABILITIES = [
  "platform.inspect_readiness"
] as const;

export type PlatformInspectReadinessPageAction =
  PlatformInspectReadinessAction;

export type PlatformReadinessSuccess = {
  ok: true;
  evidenceHash: string;
  receipt: CmoocUiReadinessReceipt;
};

export type PlatformReadinessFailure = {
  ok: false;
  errorCode: string;
};

export type PlatformReadinessBridgeSnapshot = {
  phase: "idle" | "running" | "completed" | "failed";
  revision: number;
  message: string;
  result: PlatformReadinessSuccess | PlatformReadinessFailure | null;
};

type ExecutePlatformReadinessActionInput = {
  action: PlatformInspectReadinessPageAction;
  currentTargetInput: string;
  busy: boolean;
  runReadiness: (
    targetInput: string
  ) => Promise<PlatformReadinessBridgeSnapshot>;
};

const EVIDENCE_HASH_PATTERN = /^[a-f0-9]{64}$/i;

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/**
 * Runtime-check the same-origin readiness response before it can become page
 * bridge state. The accepted shape deliberately excludes canonical URLs,
 * course identifiers and any page/forum text.
 */
export function safePlatformReadinessSuccess(
  value: unknown
): PlatformReadinessSuccess | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as {
    ok?: unknown;
    evidenceHash?: unknown;
    receipt?: unknown;
  };
  if (
    candidate.ok !== true ||
    typeof candidate.evidenceHash !== "string" ||
    !EVIDENCE_HASH_PATTERN.test(candidate.evidenceHash) ||
    !candidate.receipt ||
    typeof candidate.receipt !== "object" ||
    Array.isArray(candidate.receipt)
  ) {
    return null;
  }
  const receipt = candidate.receipt as Partial<CmoocUiReadinessReceipt>;
  if (
    receipt.schemaVersion !== "cmooc.ui-readiness-receipt.v1" ||
    receipt.containsForumText !== false ||
    receipt.externalWriteAttempted !== false ||
    receipt.realPublishEnabled !== false ||
    receipt.sentMutationCount !== 0 ||
    receipt.networkGuardActive !== true ||
    (receipt.status !== "overview_ready" &&
      receipt.status !== "shell_only" &&
      receipt.status !== "blocked") ||
    typeof receipt.courseShellDetected !== "boolean" ||
    !nonNegativeInteger(receipt.categoryTabCount) ||
    !nonNegativeInteger(receipt.visibleCardCount) ||
    !nonNegativeInteger(receipt.blockedWriteRequestCount)
  ) {
    return null;
  }
  return {
    ok: true,
    evidenceHash: candidate.evidenceHash.toLowerCase(),
    receipt: receipt as CmoocUiReadinessReceipt
  };
}

export function buildPlatformReadinessBridgeState(
  snapshot: PlatformReadinessBridgeSnapshot
): PageBridgeState {
  const successful = snapshot.result?.ok === true
    ? snapshot.result
    : null;
  const receipt = successful?.receipt ?? null;
  return {
    schemaVersion: PAGE_BRIDGE_STATE_VERSION,
    routeId: "platform",
    href: "/platform",
    status:
      snapshot.phase === "running"
        ? "busy"
        : snapshot.phase === "failed"
          ? "error"
          : "ready",
    capabilities:
      PLATFORM_PAGE_ACTION_CAPABILITIES as PageBridgeState["capabilities"],
    revision: snapshot.revision,
    summary: snapshot.message,
    attachedContexts: [],
    metadata: {
      phase: snapshot.phase,
      externalReadOnly: true,
      readinessStatus: receipt?.status ?? null,
      courseShellDetected: receipt?.courseShellDetected ?? false,
      categoryTabCount: receipt?.categoryTabCount ?? 0,
      visibleCardCount: receipt?.visibleCardCount ?? 0,
      blockedWriteRequestCount:
        receipt?.blockedWriteRequestCount ?? 0,
      sentMutationCount: 0,
      networkGuardActive: receipt?.networkGuardActive ?? false,
      evidenceHash: successful?.evidenceHash ?? null
    },
    containsForumText: false,
    externalWrites: false
  };
}

function completionSummary(result: PlatformReadinessSuccess): string {
  const receipt = result.receipt;
  if (receipt.status === "overview_ready") {
    return `平台只读诊断完成：真实课程概要已就绪，观察到 ${receipt.categoryTabCount} 个分区和 ${receipt.visibleCardCount} 张当前可见卡片；外部写入为 0。`;
  }
  if (receipt.status === "shell_only") {
    return "平台只读诊断完成：课程壳已定位，但当前会话尚未读取到可巡检卡片；外部写入为 0。";
  }
  return "平台只读诊断完成：当前课程页面未通过可用性核验；外部写入为 0。";
}

export async function executePlatformReadinessAction(
  input: ExecutePlatformReadinessActionInput
): Promise<PageBridgeExecutionOutcome> {
  if (input.busy) {
    return {
      status: "unavailable",
      summary: "平台只读诊断正在运行，本次没有重复发起外部读取。",
      retryable: true,
      errorCode: "PLATFORM_READINESS_BUSY"
    };
  }

  const targetInput =
    input.action.targetInput?.trim() ||
    input.currentTargetInput.trim();
  if (!targetInput) {
    return {
      status: "unavailable",
      summary: "请先提供一个明确的 cMOOC 课程地址，再运行只读诊断。",
      retryable: false,
      errorCode: "PLATFORM_TARGET_REQUIRED"
    };
  }

  try {
    const snapshot = await input.runReadiness(targetInput);
    const state = buildPlatformReadinessBridgeState(snapshot);
    if (snapshot.result?.ok === true) {
      return {
        status: "completed",
        summary: completionSummary(snapshot.result),
        retryable: false,
        state
      };
    }
    return {
      status: "failed",
      summary: "平台只读诊断未完成。请检查课程入口和当前会话后重试。",
      retryable: true,
      errorCode:
        snapshot.result?.errorCode || "PLATFORM_READINESS_FAILED",
      state
    };
  } catch {
    return {
      status: "failed",
      summary: "平台只读诊断未完成。请检查课程入口和当前会话后重试。",
      retryable: true,
      errorCode: "PLATFORM_READINESS_FAILED"
    };
  }
}
