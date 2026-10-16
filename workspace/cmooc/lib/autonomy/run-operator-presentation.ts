/**
 * Human-facing presentation helpers for the autonomy run read models.
 *
 * The database and Decision Tape keep their protocol vocabulary intact. These
 * helpers only translate that vocabulary at the page boundary; no API or
 * persistence contract is changed.
 */

const decisionReasonLabels: Record<string, string> = {
  draft_eligible: "证据足够，形成可审阅草稿",
  shadow_draft_unchanged_reused: "目标与策略未变化，复用上一轮影子提议",
  teachable_episode_awaiting_learner: "回合仍在等待学习者回应",
  teachable_episode_stalled_closed: "长期未获回应，回合已自动结束",
  teachable_episode_human_returned: "学习者已经返回，系统立即让位",
  teachable_episode_peer_taken_over: "同伴已经接续，系统立即让位",
  stable_no_human_response: "暂未观察到新的真人互动",
  external_human_response: "检测到新的真人互动，系统让位",
  original_author_return: "原作者已经返回，系统让位",
  existing_system_or_agent_response: "已有系统或学伴回应，避免重复介入",
  distinct_actor_response: "已有其他参与者回应，优先保留互动",
  sequence_socially_complete: "当前讨论已经形成完整回应链",
  source_censored: "评论范围不完整，暂不行动",
  target_version_changed: "目标内容已变化，需要重新核验",
  event_prefix_changed: "课程事件发生变化，需要重新核验",
  candidate_expired: "机会已过期，本轮不再介入",
  budget_unavailable: "本轮预算不可用，保持克制",
  insufficient_admissible_evidence: "可核验证据不足，保持克制",
  history_evidence_unavailable: "历史证据暂不可用，保持克制",
  support_gap_not_mature: "支持缺口尚未成熟，继续观察",
  author_cooldown_active: "该作者仍在冷却期，避免重复触达",
  repeat_touch_limit: "已达到近期触达上限，保持克制",
  reread_unavailable: "写前重读不可用，安全停止"
};

const tapeKindLabels: Record<string, string> = {
  operation_governance_resolved: "运行治理边界",
  invocation_started: "唤醒与边界锁定",
  invocation_recovered: "恢复与边界锁定",
  observation_committed: "课程观察回执",
  world_committed: "课程世界投影",
  content_graph_v2_committed: "互动关系已更新",
  candidate_set_committed: "机会候选集",
  teachable_episode_resolved: "可教回合状态",
  target_revalidated: "目标写前重读",
  decision_committed: "四态自主决定",
  invocation_completed: "运行完成回执",
  invocation_failed: "运行失败回执",
  proximal_outcome_observed: "近端结果回流"
};

export function formatCourseLabel(
  courseAlias: string,
  courseNames?: ReadonlyMap<string, string>
): string {
  const value = courseAlias.trim();
  if (!value) return "已绑定课程";
  const verifiedName = courseNames?.get(value)?.trim();
  if (verifiedName) return verifiedName;
  const separator = value.indexOf(" · ");
  if (separator > 0) {
    const humanLabel = value.slice(0, separator).trim();
    if (humanLabel) return humanLabel;
  }
  // Manifest rows currently expose only an operational alias. Do not invent a
  // course title from that alias; keep the default layer neutral instead.
  return /^[a-z0-9][a-z0-9_-]{1,62}$/i.test(value)
    ? "已绑定课程"
    : value;
}

export function formatRunMode(mode: string): string {
  switch (mode.trim().toLowerCase()) {
    case "shadow":
      return "只读运行";
    case "observe":
      return "仅观察";
    case "stage":
      return "编辑器演练";
    case "auto":
      return "自动运行";
    case "halted":
      return "已停止";
    default:
      return "运行";
  }
}

export function formatDecisionReason(reasonCode: string): string {
  return decisionReasonLabels[reasonCode] ?? "按当前证据保持克制";
}

export function formatExecutionBoundary(input: {
  bodyPersisted: boolean;
  editorWriteAttempted?: boolean;
  publishAttempted: boolean;
}): string {
  if (input.publishAttempted) {
    return "记录了发布尝试，真实发布仍受硬锁";
  }
  if (input.editorWriteAttempted || input.bodyPersisted) {
    return "仅暂存于编辑器，未发布";
  }
  return "未写入课程平台";
}

export function formatTapeStageLabel(kind: string): string {
  return tapeKindLabels[kind] ?? "运行阶段";
}

export function formatRunSafetyMessage(input: {
  editorWriteAttemptCount: number;
  externalWriteAttemptCount: number;
  requestedMutationCount: number;
  sentMutationCount: number;
  publishAttemptCount: number;
}): string {
  if (input.externalWriteAttemptCount === 0) {
    return "本次运行未向课程平台写入，真实发布仍关闭。";
  }
  return "本次运行记录了编辑器或平台写入尝试；真实发布仍关闭。";
}
