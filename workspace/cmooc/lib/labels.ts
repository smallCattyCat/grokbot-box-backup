import type { InterventionType, PublishTarget, TaskStatus } from "./types";

export const cieLabels: Record<number, string> = {
  0: "无关互动",
  1: "操作交互",
  2: "寻径交互 / 社交情感互动",
  3: "良构问题 / 意义分享",
  4: "劣构问题",
  5: "解释澄清 / 冲突支持",
  6: "反思总结",
  7: "综合",
  8: "创造"
};

export const interventionTypeLabels: Record<InterventionType, string> = {
  resource_connector: "资源连接型学伴",
  cognitive_conflict: "认知冲突型学伴",
  emotional_support: "情感支持型学伴",
  mixed: "资源连接 + 情感支持"
};

export const statusLabels: Record<TaskStatus, string> = {
  proposed: "新候选",
  review_required: "需复核",
  ready: "可批准",
  failed_retryable: "可重试",
  reconcile_required: "待核对",
  discovered: "已发现",
  analyzed: "已分析",
  candidate: "候选干预",
  drafted: "已生成草稿",
  safety_checked: "已安全审核",
  queued: "待发布",
  publishing: "发布中",
  published: "已发布",
  failed: "发布失败",
  manual_review: "人工审核",
  skipped: "已跳过"
};

export const publishTargetLabels: Record<PublishTarget, string> = {
  post_comment: "发布为主评论",
  comment_reply: "回复已有评论"
};

export const companionTone: Record<InterventionType, string> = {
  resource_connector: "清晰、克制、善于连接",
  cognitive_conflict: "温和追问、比较启发、避免替代思考",
  emotional_support: "共情、稳定、鼓励继续参与",
  mixed: "先承接情绪，再提供连接线索"
};
