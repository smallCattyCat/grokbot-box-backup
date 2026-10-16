import { buildWorldHref } from "@/lib/autonomy/world-explorer-state";

export const COURSE_OPPORTUNITY_BRIEF_SCHEMA_VERSION =
  "cmooc.course-opportunity-brief.v1" as const;

export type CourseOpportunityBriefPriority = "high" | "medium" | "low";
export type CourseOpportunityBriefGateState = "pass" | "blocked" | "unknown";
export type CourseOpportunityBriefKind =
  | "incident"
  | "coverage_gap"
  | "support_gap"
  | "intervention_opportunity"
  | "outcome_due"
  | "wait"
  | "abstain"
  | "yield"
  | "no_action"
  | "boundary";

export type CourseOpportunityBriefItem = {
  id: string;
  kind: CourseOpportunityBriefKind;
  priority: CourseOpportunityBriefPriority;
  stateLabel: string;
  headline: string;
  summary: string;
  observedFacts: string[];
  limitations: string[];
  gates: {
    admission: CourseOpportunityBriefGateState;
    review: CourseOpportunityBriefGateState;
    conditions: CourseOpportunityBriefGateState;
  };
  evidenceAsOf: string;
  evidenceCode: string;
  contextRef: string;
  sourceHref: string;
  canHandoff: boolean;
  containsForumText: false;
  containsIdentity: false;
};

export type CourseOpportunityBrief = {
  schemaVersion: typeof COURSE_OPPORTUNITY_BRIEF_SCHEMA_VERSION;
  status: "ready" | "unavailable";
  anchor: {
    courseAlias: string;
    courseName: string;
    invocationId: string;
    snapshotId: string;
    manifestHash: string;
    worldHash: string;
    coverageHash: string;
    worldAsOf: string;
    evidenceAsOf: string;
  } | null;
  headline: string;
  summaryLine: string;
  summary: {
    needsAttention: number;
    canYield: number;
    dueOutcomes: number;
    incompleteScopes: number;
  };
  items: CourseOpportunityBriefItem[];
  containsForumText: false;
  containsIdentity: false;
};

export type BriefSourceCheck = "checked" | "unavailable";

type BriefDecisionInput = {
  id: string;
  decision: string;
  reasonCode: string;
  evidenceAsOf: Date;
  worldHash: string;
  candidateSetHash: string;
  courseAlias: string;
};

type BriefIncidentInput = {
  id: string;
  severity: string;
  code: string;
  openedAt: Date;
  evidenceHash: string;
  courseAlias: string;
  invocationId: string | null;
};

type BriefOutcomeInput = {
  id: string;
  observationWindow: string;
  dueAt: Date;
  decisionId: string;
  courseAlias: string;
  invocationId: string;
  worldHash: string;
  candidateSetHash: string;
};

export type BuildCourseOpportunityBriefInput = {
  anchor: {
    courseAlias: string;
    courseName: string;
    invocationId: string;
    snapshotId: string;
    manifestHash: string;
    worldHash: string;
    coverageHash: string;
    candidateSetHash: string;
    worldAsOf: Date;
  } | null;
  coverage: {
    status: "complete" | "partial" | "unavailable";
    incompleteThreadCount: number;
    failedTargetCount: number;
  };
  supportGaps: {
    matureCount: number;
    longestOpenHours: number | null;
  };
  sourceChecks: {
    coverage: BriefSourceCheck;
    supportGaps: BriefSourceCheck;
    decisions: BriefSourceCheck;
    incidents: BriefSourceCheck;
    dueOutcomes: BriefSourceCheck;
  };
  decisions: BriefDecisionInput[];
  incidents: BriefIncidentInput[];
  dueOutcomes: BriefOutcomeInput[];
};

const PRIORITY_WEIGHT: Record<CourseOpportunityBriefPriority, number> = {
  high: 3,
  medium: 2,
  low: 1
};

const DECISION_EVIDENCE_LABELS: Record<string, string> = {
  draft_eligible: "促进条件已满足",
  shadow_draft_unchanged_reused: "已复用相同目标的影子提议",
  teachable_episode_awaiting_learner: "正在等待学习者回应",
  teachable_episode_stalled_closed: "停滞回合已自动结束",
  teachable_episode_human_returned: "学习者返回后系统已让位",
  teachable_episode_peer_taken_over: "同伴接续后系统已让位",
  stable_no_human_response: "暂未出现新的真人互动",
  external_human_response: "已有新的真人回应",
  original_author_return: "原作者已经返回",
  existing_system_or_agent_response: "已有学伴或系统回应",
  distinct_actor_response: "已有其他参与者回应",
  sequence_socially_complete: "当前回应链已完整",
  source_censored: "观察范围不完整",
  target_version_changed: "目标版本已经变化",
  event_prefix_changed: "课程事件已经变化",
  candidate_expired: "机会已过期",
  budget_unavailable: "本轮预算不可用",
  insufficient_admissible_evidence: "可核验证据不足",
  history_evidence_unavailable: "历史证据暂不可用",
  support_gap_not_mature: "支持缺口尚未成熟",
  author_cooldown_active: "近期触达仍在冷却期",
  repeat_touch_limit: "已达到近期触达上限",
  reread_unavailable: "写前重读不可用"
};

const INCIDENT_EVIDENCE_LABELS: Record<string, string> = {
  event_version_conflict: "课程事件版本冲突",
  structure_fact_version_conflict: "课程结构事实版本冲突",
  invocation_lease_expired: "运行租约已过期",
  read_auth_unavailable: "只读观察授权不可用",
  manifest_hash_mismatch: "课程清单绑定不一致",
  course_alias_mismatch: "课程绑定不一致",
  coverage_unavailable: "课程覆盖证据不可用"
};

function safeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function dateLabel(value: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(value);
}

function worldHref(anchor: NonNullable<BuildCourseOpportunityBriefInput["anchor"]>) {
  return buildWorldHref({
    courseAlias: anchor.courseAlias,
    snapshotId: anchor.snapshotId,
    view: "course_structure",
    window: "rolling_30d"
  });
}

function decisionEvidenceLabel(code: string): string {
  return DECISION_EVIDENCE_LABELS[code] ?? "按当前证据保持克制";
}

function incidentEvidenceLabel(code: string): string {
  return INCIDENT_EVIDENCE_LABELS[code] ?? "运行证据需要复核";
}

function sharedItemBoundary() {
  return {
    containsForumText: false as const,
    containsIdentity: false as const
  };
}

function unavailableBrief(): CourseOpportunityBrief {
  return {
    schemaVersion: COURSE_OPPORTUNITY_BRIEF_SCHEMA_VERSION,
    status: "unavailable",
    anchor: null,
    headline: "今日简报尚未就绪",
    summaryLine: "还没有可精确绑定的课程巡检快照。",
    summary: {
      needsAttention: 1,
      canYield: 0,
      dueOutcomes: 0,
      incompleteScopes: 0
    },
    items: [
      {
        id: "boundary:anchor-unavailable",
        kind: "boundary",
        priority: "high",
        stateLabel: "边界未就绪",
        headline: "课程证据尚不能形成精确简报",
        summary: "完成一次带课程、运行和世界快照绑定的巡检后再继续研判。",
        observedFacts: ["当前没有同时绑定课程、运行与世界快照的证据锚点"],
        limitations: ["此状态不能解释为课程没有机会或不需要支持。"],
        gates: { admission: "blocked", review: "unknown", conditions: "unknown" },
        evidenceAsOf: "",
        evidenceCode: "证据锚点不可用",
        contextRef: "",
        sourceHref: "/autonomy/world",
        canHandoff: false,
        ...sharedItemBoundary()
      }
    ],
    containsForumText: false,
    containsIdentity: false
  };
}

function decisionItem(
  row: BriefDecisionInput,
  anchor: NonNullable<BuildCourseOpportunityBriefInput["anchor"]>
): CourseOpportunityBriefItem | null {
  if (
    row.courseAlias !== anchor.courseAlias ||
    row.worldHash !== anchor.worldHash ||
    row.candidateSetHash !== anchor.candidateSetHash
  ) {
    return null;
  }

  const shared = {
    id: `decision:${row.id}`,
    evidenceAsOf: row.evidenceAsOf.toISOString(),
    evidenceCode: decisionEvidenceLabel(row.reasonCode),
    contextRef: `decision:${row.id}`,
    sourceHref: `/autonomy/decisions?decision=${encodeURIComponent(row.id)}`,
    ...sharedItemBoundary()
  };

  if (row.decision === "draft") {
    return {
      ...shared,
      kind: "intervention_opportunity",
      priority: "medium",
      stateLabel: "可继续",
      headline: "发现一项可继续核验的促进机会",
      summary: "本轮证据与预算门槛已经通过，可以先核验依据，再决定是否交给学伴继续研判。",
      observedFacts: ["本轮决定为可生成受约束草稿", `证据截至 ${dateLabel(row.evidenceAsOf)}`],
      limitations: ["这是一项行动机会，不是已经发生的真实干预或教育效果。"],
      gates: { admission: "pass", review: "pass", conditions: "pass" },
      canHandoff: true
    };
  }

  if (row.decision === "wait") {
    return {
      ...shared,
      kind: "wait",
      priority: "low",
      stateLabel: "等待",
      headline: "一项机会正在等待更多证据",
      summary: "当前信息还不足以支持稳定行动；保留现场并在下一轮继续观察。",
      observedFacts: ["本轮决定为等待", `证据截至 ${dateLabel(row.evidenceAsOf)}`],
      limitations: ["等待不表示学习者拒绝、失去兴趣或没有学习。"],
      gates: { admission: "pass", review: "blocked", conditions: "unknown" },
      canHandoff: true
    };
  }

  if (row.decision === "abstain") {
    return {
      ...shared,
      kind: "abstain",
      priority: "low",
      stateLabel: "克制",
      headline: "系统本轮保持克制",
      summary: "现有证据不支持继续介入；可以查看停在哪一层，无需强行生成行动。",
      observedFacts: ["本轮决定为克制", `证据截至 ${dateLabel(row.evidenceAsOf)}`],
      limitations: ["克制是合格结果，不应被改写为执行失败。"],
      gates: { admission: "blocked", review: "unknown", conditions: "unknown" },
      canHandoff: true
    };
  }

  if (row.decision === "yield") {
    return {
      ...shared,
      kind: "yield",
      priority: "low",
      stateLabel: "让位",
      headline: "课程参与者已接过互动",
      summary: "现场已经出现可信回应或作者回归，本轮不继续自动促进。",
      observedFacts: ["本轮决定为让位", `证据截至 ${dateLabel(row.evidenceAsOf)}`],
      limitations: ["让位只说明当前行动边界，不代表课程问题已经永久解决。"],
      gates: { admission: "pass", review: "pass", conditions: "blocked" },
      canHandoff: false
    };
  }

  return null;
}

export function buildCourseOpportunityBrief(
  input: BuildCourseOpportunityBriefInput
): CourseOpportunityBrief {
  if (!input.anchor) return unavailableBrief();

  const anchor = input.anchor;
  const items: CourseOpportunityBriefItem[] = [];
  const incompleteScopes =
    safeCount(input.coverage.incompleteThreadCount) +
    safeCount(input.coverage.failedTargetCount);

  const incident = input.incidents
    .filter(
      (row) =>
        row.courseAlias === anchor.courseAlias &&
        row.invocationId === anchor.invocationId
    )
    .sort(
      (left, right) =>
        right.openedAt.getTime() - left.openedAt.getTime() ||
        left.id.localeCompare(right.id)
    )[0];
  if (incident) {
    items.push({
      id: `incident:${incident.id}`,
      kind: "incident",
      priority: "high",
      stateLabel: "需核验",
      headline: "本轮运行异常尚未收束",
      summary: "先确认本轮巡检与证据链是否完整，再决定是否继续课程动作。",
      observedFacts: ["本轮存在开放或已知悉的运行异常", `异常记录于 ${dateLabel(incident.openedAt)}`],
      limitations: ["运行异常不等于课程学习异常，也不直接说明需要发布干预。"],
      gates: { admission: "blocked", review: "unknown", conditions: "unknown" },
      evidenceAsOf: incident.openedAt.toISOString(),
      evidenceCode: incidentEvidenceLabel(incident.code),
      contextRef: `incident:${incident.id}`,
      sourceHref: `/review/live?incident=${encodeURIComponent(incident.id)}`,
      canHandoff: true,
      ...sharedItemBoundary()
    });
  }

  if (input.coverage.status !== "complete" || incompleteScopes > 0) {
    const unavailable = input.coverage.status === "unavailable";
    items.push({
      id: `coverage:${anchor.snapshotId}`,
      kind: "coverage_gap",
      priority: "high",
      stateLabel: unavailable ? "覆盖不可用" : "覆盖下界",
      headline: unavailable
        ? "课程观察覆盖证据不可用"
        : `课程观察存在 ${Math.max(1, incompleteScopes)} 处覆盖缺口`,
      summary: unavailable
        ? "当前快照不能支持课程级行动判断，请先恢复完整巡检证据。"
        : "当前世界状态仍可用于局部研判，但不能把可见部分外推为完整课程事实。",
      observedFacts: unavailable
        ? ["本轮未取得可核验的覆盖状态"]
        : [
            `${safeCount(input.coverage.incompleteThreadCount)} 个讨论范围不完整`,
            `${safeCount(input.coverage.failedTargetCount)} 个观察目标失败`
          ],
      limitations: ["受缺失影响的计数和关系只能按下界解释。"],
      gates: { admission: "unknown", review: "blocked", conditions: "unknown" },
      evidenceAsOf: anchor.worldAsOf.toISOString(),
      evidenceCode: unavailable ? "覆盖证据不可用" : "覆盖范围不完整",
      contextRef: `snapshot:${anchor.snapshotId}`,
      sourceHref: worldHref(anchor),
      canHandoff: true,
      ...sharedItemBoundary()
    });
  }

  const matureCount = safeCount(input.supportGaps.matureCount);
  if (matureCount > 0) {
    items.push({
      id: `support-gap:${anchor.snapshotId}`,
      kind: "support_gap",
      priority: "medium",
      stateLabel: "可研判",
      headline: `${matureCount} 个成熟支持缺口值得核验`,
      summary: "精确快照中存在持续至少 72 小时且尚无外部回应、作者回归或系统触达的匿名讨论聚合。",
      observedFacts: [
        `${matureCount} 个完整观察范围符合成熟支持缺口条件`,
        input.supportGaps.longestOpenHours === null
          ? "最长开放时长待核验"
          : `最长已开放 ${safeCount(input.supportGaps.longestOpenHours)} 小时`
      ],
      limitations: ["聚合不展示讨论正文或身份；成熟缺口仍需结合教学情境判断。"],
      gates: { admission: "pass", review: "unknown", conditions: "unknown" },
      evidenceAsOf: anchor.worldAsOf.toISOString(),
      evidenceCode: "成熟支持缺口聚合",
      contextRef: `snapshot:${anchor.snapshotId}`,
      sourceHref: worldHref(anchor),
      canHandoff: true,
      ...sharedItemBoundary()
    });
  }

  const outcome = input.dueOutcomes
    .filter(
      (row) =>
        row.courseAlias === anchor.courseAlias &&
        row.invocationId === anchor.invocationId &&
        row.worldHash === anchor.worldHash &&
        row.candidateSetHash === anchor.candidateSetHash
    )
    .sort(
      (left, right) =>
        left.dueAt.getTime() - right.dueAt.getTime() ||
        left.id.localeCompare(right.id)
    )[0];
  if (outcome) {
    const alignedDueCount = input.dueOutcomes.filter(
      (row) =>
        row.courseAlias === anchor.courseAlias &&
        row.invocationId === anchor.invocationId &&
        row.worldHash === anchor.worldHash &&
        row.candidateSetHash === anchor.candidateSetHash
    ).length;
    items.push({
      id: `outcome:${outcome.id}`,
      kind: "outcome_due",
      priority: "medium",
      stateLabel: "待回流",
      headline: `${alignedDueCount} 个近端结果窗口已到核对时间`,
      summary: "核对结果窗口是否就绪，并把观察记录为描述性回流。",
      observedFacts: [`最早到期窗口为 ${outcome.observationWindow}`, `应在 ${dateLabel(outcome.dueAt)} 后核对`],
      limitations: ["R24/R72 是近端描述性观察，不能单独支持促进效果或因果结论。"],
      gates: { admission: "pass", review: "blocked", conditions: "unknown" },
      evidenceAsOf: outcome.dueAt.toISOString(),
      evidenceCode: "近端结果窗口到期",
      contextRef: `outcome:${outcome.id}`,
      sourceHref: `/autonomy/outcomes?outcome=${encodeURIComponent(outcome.id)}`,
      canHandoff: true,
      ...sharedItemBoundary()
    });
  }

  const decision = [...input.decisions]
    .sort(
      (left, right) =>
        right.evidenceAsOf.getTime() - left.evidenceAsOf.getTime() ||
        left.id.localeCompare(right.id)
    )
    .map((row) => decisionItem(row, anchor))
    .find((item): item is CourseOpportunityBriefItem => item !== null);
  if (decision) items.push(decision);

  const orderedItems = items
    .sort(
      (left, right) =>
        PRIORITY_WEIGHT[right.priority] - PRIORITY_WEIGHT[left.priority] ||
        right.evidenceAsOf.localeCompare(left.evidenceAsOf) ||
        left.id.localeCompare(right.id)
    )
    .slice(0, 5);

  const allSourcesChecked = Object.values(input.sourceChecks).every(
    (status) => status === "checked"
  );
  if (orderedItems.length === 0 && allSourcesChecked) {
    orderedItems.push({
      id: `no-action:${anchor.snapshotId}`,
      kind: "no_action",
      priority: "low",
      stateLabel: "无需行动",
      headline: "当前没有需要处理的事项",
      summary: "本轮五类证据源均已检查，没有形成开放事项；可以让课程参与者继续互动。",
      observedFacts: ["覆盖、支持缺口、决定、异常和到期结果均已完成检查", `课程世界截至 ${dateLabel(anchor.worldAsOf)}`],
      limitations: ["无需行动只适用于当前证据时点，下一轮巡检仍会重新判断。"],
      gates: { admission: "pass", review: "pass", conditions: "blocked" },
      evidenceAsOf: anchor.worldAsOf.toISOString(),
      evidenceCode: "五类证据源均无开放事项",
      contextRef: `snapshot:${anchor.snapshotId}`,
      sourceHref: worldHref(anchor),
      canHandoff: false,
      ...sharedItemBoundary()
    });
  } else if (orderedItems.length === 0) {
    orderedItems.push({
      id: `boundary:sources-unavailable:${anchor.snapshotId}`,
      kind: "boundary",
      priority: "high",
      stateLabel: "检查未完成",
      headline: "简报来源尚未全部核验",
      summary: "至少一类只读来源不可用，因此不能断言当前无需行动。",
      observedFacts: ["五类证据源中至少一类未成功完成检查"],
      limitations: ["此状态不能解释为课程没有机会或不需要支持。"],
      gates: { admission: "blocked", review: "unknown", conditions: "unknown" },
      evidenceAsOf: anchor.worldAsOf.toISOString(),
      evidenceCode: "简报来源检查不完整",
      contextRef: `snapshot:${anchor.snapshotId}`,
      sourceHref: worldHref(anchor),
      canHandoff: true,
      ...sharedItemBoundary()
    });
  }

  const needsAttention = orderedItems.filter(
    (item) =>
      item.kind === "incident" ||
      item.kind === "coverage_gap" ||
      item.kind === "support_gap" ||
      item.kind === "intervention_opportunity" ||
      item.kind === "outcome_due" ||
      item.kind === "boundary"
  ).length;
  const canYield = orderedItems.filter(
    (item) => item.kind === "yield" || item.kind === "abstain" || item.kind === "no_action"
  ).length;
  const alignedDueOutcomes = input.dueOutcomes.filter(
    (row) =>
      row.courseAlias === anchor.courseAlias &&
      row.invocationId === anchor.invocationId &&
      row.worldHash === anchor.worldHash &&
      row.candidateSetHash === anchor.candidateSetHash
  ).length;
  const evidenceWatermark = orderedItems.reduce(
    (latest, item) => {
      const timestamp = Date.parse(item.evidenceAsOf);
      return Number.isFinite(timestamp) && timestamp > latest
        ? timestamp
        : latest;
    },
    anchor.worldAsOf.getTime()
  );

  return {
    schemaVersion: COURSE_OPPORTUNITY_BRIEF_SCHEMA_VERSION,
    status: "ready",
    anchor: {
      courseAlias: anchor.courseAlias,
      courseName: anchor.courseName,
      invocationId: anchor.invocationId,
      snapshotId: anchor.snapshotId,
      manifestHash: anchor.manifestHash,
      worldHash: anchor.worldHash,
      coverageHash: anchor.coverageHash,
      worldAsOf: anchor.worldAsOf.toISOString(),
      evidenceAsOf: new Date(evidenceWatermark).toISOString()
    },
    headline: needsAttention > 0 ? `今天有 ${needsAttention} 件值得看` : "当前无需处理",
    summaryLine: orderedItems[0]?.headline ?? "课程简报已生成",
    summary: {
      needsAttention,
      canYield,
      dueOutcomes: alignedDueOutcomes,
      incompleteScopes
    },
    items: orderedItems,
    containsForumText: false,
    containsIdentity: false
  };
}
