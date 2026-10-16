import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import type { CmoocUiReadinessReceipt } from "@/lib/platform-readiness/cmooc-ui-readiness";
import type { LiveUiObservationReceipt } from "@/lib/ui-agent/live-observation";

export const LIVE_SHADOW_QUEUE_SCHEMA_VERSION =
  "cmooc.live-shadow-queue.v1" as const;

export type LiveShadowWaitReason =
  | "awaiting_computer_use_receipt"
  | "insufficient_detail_evidence"
  | "action_outcome_unknown"
  | "insufficient_longitudinal_history"
  | "ui_drift_or_target_blocked";

export type LiveShadowQueueItem = {
  candidateKey: string;
  displayAlias: string;
  position: number;
  selectedByUi: boolean;
  decision: "wait";
  state:
    | "structural_observed"
    | "source_censored"
    | "semantic_observed_waiting_history"
    | "blocked";
  reasonCode: LiveShadowWaitReason;
  intentCreated: false;
  moveSpecCreated: false;
  draftCreated: false;
  realPublishEnabled: false;
  containsForumText: false;
};

export type LiveShadowQueue = {
  schemaVersion: typeof LIVE_SHADOW_QUEUE_SCHEMA_VERSION;
  queueHash: string;
  sourceKind: "real_platform_live";
  baselineEvidenceHash: string;
  observationReceiptHash: string | null;
  observedAt: string;
  driverLabel:
    | "等待 Chrome / Computer Use"
    | "Chrome + Computer Use"
    | "确定性只读浏览器";
  attestationLabel:
    | "等待驱动回执"
    | "同目标相关核验"
    | "同标签页只读核验"
    | "确定性浏览器只读核验"
    | "仅目标核验";
  workflow: Array<{
    stage: "感知" | "择机" | "促成" | "让位";
    status: "complete" | "waiting" | "armed" | "blocked";
    detail: string;
  }>;
  currentDecision: "wait";
  waitReason: LiveShadowWaitReason;
  queueItems: LiveShadowQueueItem[];
  visibleCardCount: number;
  categoryTabCount: number;
  semanticCandidateCount: 0;
  externalWriteAttempted: false;
  containsForumText: false;
};

function aliasFor(key: string, position: number): string {
  if (/^[a-f0-9]{12,64}$/i.test(key)) {
    return `帖子 T-${key.slice(0, 8).toUpperCase()}`;
  }
  const fallback = canonicalProtocolHash(
    "cmooc.live-shadow-card-fallback.v1",
    `${position}`
  );
  return `帖子 T-${fallback.slice(0, 8).toUpperCase()}`;
}

function waitReason(input: {
  readiness: CmoocUiReadinessReceipt;
  observation: LiveUiObservationReceipt | null;
}): LiveShadowWaitReason {
  if (!input.observation) {
    return "awaiting_computer_use_receipt";
  }
  if (
    input.observation.captureStatus === "blocked" ||
    !input.observation.courseShellDetected
  ) {
    return "ui_drift_or_target_blocked";
  }
  if (input.observation.captureStatus === "source_censored") {
    return "action_outcome_unknown";
  }
  if (input.observation.safeToAdvanceToSemanticReview) {
    return "insufficient_longitudinal_history";
  }
  return "insufficient_detail_evidence";
}

function itemState(
  observation: LiveUiObservationReceipt | null
): LiveShadowQueueItem["state"] {
  if (!observation) return "structural_observed";
  if (observation.captureStatus === "blocked") return "blocked";
  if (observation.captureStatus === "source_censored") {
    return "source_censored";
  }
  if (observation.safeToAdvanceToSemanticReview) {
    return "semantic_observed_waiting_history";
  }
  return "structural_observed";
}

function driverLabel(
  observation: LiveUiObservationReceipt | null
): LiveShadowQueue["driverLabel"] {
  if (!observation) return "等待 Chrome / Computer Use";
  return observation.driverKind === "chrome_computer_use"
    ? "Chrome + Computer Use"
    : "确定性只读浏览器";
}

function attestationLabel(
  observation: LiveUiObservationReceipt | null
): LiveShadowQueue["attestationLabel"] {
  if (!observation) return "等待驱动回执";
  if (observation.attestationLevel === "same_tab_guarded") {
    return "同标签页只读核验";
  }
  if (observation.attestationLevel === "same_target_correlated") {
    return "同目标相关核验";
  }
  if (
    observation.attestationLevel ===
    "deterministic_browser_guarded"
  ) {
    return "确定性浏览器只读核验";
  }
  return "仅目标核验";
}

function reasonDetail(reason: LiveShadowWaitReason): string {
  const details: Record<LiveShadowWaitReason, string> = {
    awaiting_computer_use_receipt:
      "真实课程结构已封存，等待可替换界面驱动提交同目标观察回执。",
    insufficient_detail_evidence:
      "只有课程壳与卡片结构，尚不能判断促进功能、目标对象或理由。",
    action_outcome_unknown:
      "页面动作超时后结果未知；系统停止重放，等待重新观察。",
    insufficient_longitudinal_history:
      "详情证据达到门槛，但持续支持缺口与重复触达历史尚不足。",
    ui_drift_or_target_blocked:
      "课程身份或页面 landmark 未通过，当前批次已阻断。"
  };
  return details[reason];
}

export function buildLiveShadowQueue(input: {
  readiness: CmoocUiReadinessReceipt;
  baselineEvidenceHash: string;
  observation?: {
    receipt: LiveUiObservationReceipt;
    receiptHash: string;
  } | null;
}): LiveShadowQueue {
  const observation =
    input.observation &&
    Date.parse(input.observation.receipt.observedAt) >=
      Date.parse(input.readiness.observedAt)
      ? input.observation.receipt
      : null;
  const validObservationReceiptHash = observation
    ? input.observation?.receiptHash ?? null
    : null;
  const reason = waitReason({
    readiness: input.readiness,
    observation
  });
  const keys =
    input.readiness.visibleCardKeys.length > 0
      ? input.readiness.visibleCardKeys
      : Array.from(
          { length: input.readiness.visibleCardCount },
          (_, index) =>
            canonicalProtocolHash(
              "cmooc.live-shadow-visible-position.v1",
              `${input.readiness.targetLocatorHash}\0${index}`
            ).slice(0, 24)
        );
  const state = itemState(observation);
  const queueItems = keys.map(
    (candidateKey, index): LiveShadowQueueItem => ({
      candidateKey,
      displayAlias: aliasFor(candidateKey, index + 1),
      position: index + 1,
      selectedByUi:
        index === 0 &&
        Boolean(input.readiness.selectedThreadKey) &&
        observation?.threadKey ===
          input.readiness.selectedThreadKey,
      decision: "wait",
      state,
      reasonCode: reason,
      intentCreated: false,
      moveSpecCreated: false,
      draftCreated: false,
      realPublishEnabled: false,
      containsForumText: false
    })
  );
  const workflow: LiveShadowQueue["workflow"] = [
    {
      stage: "感知",
      status:
        reason === "ui_drift_or_target_blocked"
          ? "blocked"
          : observation
            ? "complete"
            : "waiting",
      detail: observation
        ? "已核验真实课程 URL、courseId、课程壳与去正文结构。"
        : "LIFT-1 已完成，等待 Chrome / Computer Use 同目标回执。"
    },
    {
      stage: "择机",
      status:
        reason === "ui_drift_or_target_blocked"
          ? "blocked"
          : "waiting",
      detail: reasonDetail(reason)
    },
    {
      stage: "促成",
      status: "waiting",
      detail:
        "未达到语义证据与历史门槛，不创建 Intent、MoveSpec 或草稿。"
    },
    {
      stage: "让位",
      status: "armed",
      detail:
        "任何后续动作都必须重新读取目标与真人回复；真实发布保持硬锁。"
    }
  ];
  const queueWithoutHash = {
    schemaVersion: LIVE_SHADOW_QUEUE_SCHEMA_VERSION,
    sourceKind: "real_platform_live" as const,
    baselineEvidenceHash: input.baselineEvidenceHash,
    observationReceiptHash: validObservationReceiptHash,
    observedAt: observation?.observedAt ?? input.readiness.observedAt,
    driverLabel: driverLabel(observation),
    attestationLabel: attestationLabel(observation),
    workflow,
    currentDecision: "wait" as const,
    waitReason: reason,
    queueItems,
    visibleCardCount: input.readiness.visibleCardCount,
    categoryTabCount: input.readiness.categoryTabCount,
    semanticCandidateCount: 0 as const,
    externalWriteAttempted: false as const,
    containsForumText: false as const
  };
  return {
    ...queueWithoutHash,
    queueHash: canonicalProtocolHash(
      LIVE_SHADOW_QUEUE_SCHEMA_VERSION,
      queueWithoutHash as CanonicalJsonValue
    )
  };
}
