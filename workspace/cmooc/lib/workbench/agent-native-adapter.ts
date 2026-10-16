import type {
  CourseOpportunityBriefItem,
  CourseOpportunityBrief
} from "@/lib/workbench/course-opportunity-brief";
import type {
  AgentNativeActionType,
  AgentNativeCoverage,
  AgentNativeDisposition,
  AgentNativeFreshness,
  AgentNativeSystemState,
  AgentNativeWorkbenchViewModel,
  AgentNativeWriteMode,
  ActionPreview,
  AttentionItem,
  DecisionBrief,
  DecisionOption,
  EvidenceUnit,
  FocusObject,
  OperatorContextCapsule,
  ScopeContext
} from "@/lib/workbench/agent-native-contracts";
import {
  AGENT_NATIVE_WORKBENCH_SCHEMA_VERSION,
  buildWorkbenchFocusHref,
  parseBriefFocus,
  serializeBriefFocus
} from "@/lib/workbench/agent-native-contracts";
import type { OperatorWorkspaceReadModel } from "@/lib/workbench/operator-read-model";

export type AgentNativeWorkbenchAdapterInput = Readonly<{
  operator: OperatorWorkspaceReadModel;
  focusQuery?: string | null;
  now?: Date;
}>;

function safeNow(input: Date | undefined): Date {
  return input && Number.isFinite(input.getTime()) ? input : new Date();
}

function writeMode(value: string | null | undefined): AgentNativeWriteMode {
  const normalized = value?.trim().toUpperCase();
  if (
    normalized === "OBSERVE" ||
    normalized === "SHADOW" ||
    normalized === "STAGE" ||
    normalized === "AUTO" ||
    normalized === "HALTED"
  ) {
    return normalized;
  }
  return "READ_ONLY";
}

function coverage(value: OperatorWorkspaceReadModel): AgentNativeCoverage {
  if (value.coverage.status === "complete") return "complete";
  if (value.coverage.status === "partial") return "partial";
  return "unavailable";
}

function systemState(item: CourseOpportunityBriefItem): AgentNativeSystemState {
  if (item.kind === "incident") return "ERROR";
  if (item.kind === "coverage_gap") return "MISSING_DATA";
  if (item.kind === "boundary") return "UNAVAILABLE";
  return "READY";
}

function disposition(item: CourseOpportunityBriefItem): AgentNativeDisposition | null {
  if (item.kind === "wait") return "WAIT";
  if (item.kind === "abstain" || item.kind === "no_action") return "ABSTAIN";
  if (item.kind === "yield") return "YIELD";
  if (item.kind === "intervention_opportunity") return "DRAFT";
  return null;
}

function actionType(item: CourseOpportunityBriefItem): AgentNativeActionType {
  if (item.kind === "intervention_opportunity") return "REPLY";
  if (item.kind === "outcome_due") return "VERIFY";
  if (
    item.kind === "wait" ||
    item.kind === "abstain" ||
    item.kind === "yield" ||
    item.kind === "no_action"
  ) {
    return "NONE";
  }
  return "INSPECT";
}

function focusForItem(item: CourseOpportunityBriefItem): FocusObject {
  const itemDisposition = disposition(item);
  const itemState = systemState(item);
  return Object.freeze({
    type: "opportunity",
    id: item.id,
    sourceRoute: item.sourceHref,
    summary: item.summary,
    status: itemDisposition ?? itemState
  });
}

function evidenceForItem(
  item: CourseOpportunityBriefItem,
  focus: FocusObject
): EvidenceUnit {
  const allGatesPass =
    item.gates.admission === "pass" &&
    item.gates.review === "pass" &&
    item.gates.conditions === "pass";
  return Object.freeze({
    evidenceId: `evidence:${item.id}`,
    claim: item.headline,
    sourceType: "course-opportunity-brief",
    sourceRef: item.contextRef,
    sourceLocation: null,
    timeBoundary: item.evidenceAsOf,
    observedFact: [...item.observedFacts],
    interpretation: item.summary,
    confidence: allGatesPass ? "high" : "unknown",
    limitations: [...item.limitations],
    relatedObjectRefs: [focus.id]
  });
}

function humanJudgmentRequired(
  itemDisposition: AgentNativeDisposition | null,
  itemState: AgentNativeSystemState
): boolean {
  return itemState !== "READY" || itemDisposition === "DRAFT";
}

function recommendationForItem(
  itemDisposition: AgentNativeDisposition | null,
  itemState: AgentNativeSystemState,
  canHandoff: boolean
): string | null {
  if (itemState === "ERROR") return "先处理观察异常，不形成新的课程动作。";
  if (itemState === "MISSING_DATA") return "先补足或核验证据覆盖，再解释当前事项。";
  if (itemState === "UNAVAILABLE") return "当前资料不可用，保留事项并等待可核验来源。";
  if (itemDisposition === "WAIT") return "继续观察，不生成新的外部动作。";
  if (itemDisposition === "ABSTAIN") return "本轮不行动，保留可回溯的判断边界。";
  if (itemDisposition === "YIELD") return "让位于现有的人类或同伴互动。";
  if (itemDisposition === "DRAFT" && canHandoff) {
    return "先查看证据，再决定是否交给工作台继续研判。";
  }
  return null;
}

function decisionBriefForItem(
  item: CourseOpportunityBriefItem,
  focus: FocusObject
): DecisionBrief {
  const itemState = systemState(item);
  const itemDisposition = disposition(item);
  const evidence = [evidenceForItem(item, focus)];
  const action = actionType(item);
  const allowed = item.canHandoff && itemState === "READY";
  const option: DecisionOption = Object.freeze({
    action,
    target: item.contextRef || null,
    supportingEvidenceRefs: evidence.map((unit) => unit.evidenceId),
    expectedEffect: null,
    risk: itemState === "READY" ? null : item.stateLabel,
    uncertainty: item.limitations.join("；") || null,
    estimatedCost: null,
    reversibility: "unknown",
    policyResult: allowed ? "allowed" : "blocked"
  });
  return Object.freeze({
    decisionId: item.id,
    question: `是否需要处理“${item.headline}”？`,
    currentObservation: item.summary,
    whyNow: item.summary,
    evidence,
    options: [option],
    recommendation: recommendationForItem(itemDisposition, itemState, item.canHandoff),
    humanJudgmentRequired: humanJudgmentRequired(itemDisposition, itemState),
    disposition: itemDisposition,
    systemState: itemState
  });
}

function actionPreviewForItem(
  item: CourseOpportunityBriefItem,
  scope: ScopeContext,
  brief: DecisionBrief
): ActionPreview {
  const allowed =
    item.canHandoff &&
    brief.systemState === "READY" &&
    brief.disposition !== "WAIT" &&
    brief.disposition !== "ABSTAIN" &&
    brief.disposition !== "YIELD";
  const blockedReason = allowed
    ? null
    : brief.systemState !== "READY"
      ? `当前系统状态为 ${brief.systemState}。`
      : brief.disposition
        ? `当前处置为 ${brief.disposition}，不生成新的外部动作。`
        : "当前事项未提供可交接的安全动作。";
  const action = actionType(item);
  return Object.freeze({
    actionType: action,
    target: item.contextRef || null,
    intent:
      action === "REPLY"
        ? "核验该参与机会并准备受约束的回复草稿"
        : action === "VERIFY"
          ? "核验该事项的近端观察窗口"
          : action === "INSPECT"
            ? "查看该事项的只读证据与边界"
            : "保留当前治理处置，不生成新的动作",
    evidenceRefs: brief.evidence.map((unit) => unit.evidenceId),
    scope,
    policyVersion: scope.policyVersion,
    writeMode: scope.writeMode,
    externalWrites: 0,
    allowed,
    blockedReason,
    expectedEffect: null,
    uncertainty: item.limitations.join("；") || null,
    estimatedTokens: null,
    estimatedToolCalls: null,
    estimatedDuration: null,
    reversible: "unknown",
    stopCondition: "当前读模型未提供停止条件；任何执行计划必须先明确停止条件。",
    executor: {
      label: "当前工作台（真实租约信息不可用）",
      leaseStatus: "unavailable" as const
    }
  });
}

function attentionForItem(item: CourseOpportunityBriefItem): AttentionItem {
  const focus = focusForItem(item);
  return Object.freeze({
    id: item.id,
    title: item.headline,
    summary: item.summary,
    whyNow: item.summary,
    priority: item.priority,
    kind: item.kind,
    stateLabel: item.stateLabel,
    disposition: disposition(item),
    systemState: systemState(item),
    focus,
    evidenceRefs: [`evidence:${item.id}`],
    evidenceAsOf: item.evidenceAsOf,
    evidenceCode: item.evidenceCode,
    contextRef: item.contextRef,
    sourceHref: item.sourceHref,
    canHandoff: item.canHandoff
  });
}

function scopeForOperator(operator: OperatorWorkspaceReadModel): ScopeContext {
  const anchor = operator.brief.anchor;
  const selectedCourse = anchor?.courseAlias ?? operator.courseAlias;
  const snapshotId = anchor?.snapshotId ?? null;
  const invocationId = anchor?.invocationId ?? operator.invocationId;
  const timeBoundary = anchor?.worldAsOf ?? operator.scheduledFor;
  return Object.freeze({
    // The operator read model intentionally exposes only a safe alias. Do not
    // relabel that alias as an internal course id in the agent capsule.
    courseId: null,
    courseAlias: selectedCourse,
    courseName: anchor?.courseName ?? operator.courseName,
    snapshotId,
    invocationId,
    timeBoundary,
    policyVersion: null,
    modelVersion: null,
    writeMode: writeMode(operator.invocationMode),
    externalWrites: 0,
    coverage: coverage(operator),
    freshness: anchor?.worldAsOf ? "as_of_snapshot" : "unavailable"
  });
}

function compactAttention(item: AttentionItem) {
  return Object.freeze({
    id: item.id,
    title: item.title,
    summary: item.summary,
    priority: item.priority,
    stateLabel: item.stateLabel
  });
}

function capsuleForInput(input: {
  operator: OperatorWorkspaceReadModel;
  scope: ScopeContext;
  attention: AttentionItem[];
  focus: FocusObject | null;
  now: Date;
}): OperatorContextCapsule {
  const { operator, scope, attention, focus, now } = input;
  const anchor = operator.brief.anchor;
  const activeConstraints = [
    "真实平台发布与通知保持关闭。",
    "external_writes: 0。",
    scope.coverage === "partial"
      ? "当前证据覆盖为部分，只能解释为可观察下界。"
      : scope.coverage === "unavailable"
        ? "当前证据覆盖不可用。"
        : "当前事项仅按已锚定快照解释。"
  ];
  const blockedActions = ["真实平台发布", "真实平台通知"];
  const allowedActions = ["查看证据", "打开来源", "启动只读研判"];
  const evidenceRefs = attention
    .slice(0, 8)
    .flatMap((item) => item.evidenceRefs);
  const deepLinks = [
    "/workbench",
    ...(anchor?.snapshotId
      ? [
          `/autonomy/world?course=${encodeURIComponent(anchor.courseAlias)}&snapshot=${encodeURIComponent(anchor.snapshotId)}`
        ]
      : []),
    ...(focus?.sourceRoute ? [focus.sourceRoute] : [])
  ];
  const recentDeltas = [
    `当前关注事项 ${attention.length} 项。`,
    `观察事件 ${operator.metrics.events} · 讨论 ${operator.metrics.threads} · 参与者 ${operator.metrics.actors}。`,
    ...(operator.evidence.openIncidentCount > 0
      ? [`存在 ${operator.evidence.openIncidentCount} 个待处理异常。`]
      : [])
  ];
  return Object.freeze({
    schemaVersion: AGENT_NATIVE_WORKBENCH_SCHEMA_VERSION,
    capsuleId: `capsule:${scope.invocationId ?? scope.snapshotId ?? "unbound"}`,
    generatedAt: now.toISOString(),
    scope,
    objective: operator.brief.headline,
    focus,
    recentDeltas,
    attention: attention.slice(0, 8).map(compactAttention),
    activeConstraints,
    allowedActions,
    blockedActions,
    evidenceRefs: [...new Set(evidenceRefs)],
    unresolvedQuestions:
      scope.policyVersion === null
        ? ["当前安全读模型未暴露具体 Policy 版本，执行前需重新核验。"]
        : [],
    resourceBudget: {
      maxTokens: null,
      maxToolCalls: null,
      deadlineOrLease: null
    },
    nextBestActions: attention.length
      ? ["打开最高优先级关注项", "沿证据引用查看原始范围", "必要时启动只读研判"]
      : ["等待下一次完整课程快照"],
    deepLinks: [...new Set(deepLinks)],
    containsForumText: false,
    containsIdentity: false,
    externalWrites: 0
  });
}

export function buildAgentNativeWorkbenchViewModel(
  input: AgentNativeWorkbenchAdapterInput
): AgentNativeWorkbenchViewModel {
  const now = safeNow(input.now);
  const scope = scopeForOperator(input.operator);
  const attention = input.operator.brief.items.map(attentionForItem);
  const requestedFocus = parseBriefFocus(input.focusQuery);
  const focused = requestedFocus
    ? attention.find((item) => item.id === requestedFocus) ?? null
    : null;
  const focus = focused?.focus ?? null;
  const selectedBriefItem = focused
    ? input.operator.brief.items.find((item) => item.id === focused.id) ?? null
    : null;
  const decisionBrief = selectedBriefItem && focus
    ? decisionBriefForItem(selectedBriefItem, focus)
    : null;
  const actionPreview = decisionBrief && selectedBriefItem
    ? actionPreviewForItem(selectedBriefItem, scope, decisionBrief)
    : null;
  const capsule = capsuleForInput({
    operator: input.operator,
    scope,
    attention,
    focus,
    now
  });
  return Object.freeze({
    schemaVersion: AGENT_NATIVE_WORKBENCH_SCHEMA_VERSION,
    scope,
    focus,
    attention,
    decisionBrief,
    actionPreview,
    capsule
  });
}

export function buildAgentNativeAttentionItems(
  brief: CourseOpportunityBrief
): AttentionItem[] {
  return brief.items.map(attentionForItem);
}

export function buildAgentNativeCapsule(
  operator: OperatorWorkspaceReadModel,
  focusQuery?: string | null,
  now?: Date
): OperatorContextCapsule {
  return buildAgentNativeWorkbenchViewModel({ operator, focusQuery, now }).capsule;
}

export function buildAgentNativeWorkbenchHref(
  searchParams: URLSearchParams,
  focusId?: string | null
): string {
  return buildWorkbenchFocusHref({
    pathname: "/workbench",
    searchParams,
    focusId
  });
}

export function focusQueryForItem(item: AttentionItem): string | null {
  return serializeBriefFocus(item.id);
}
