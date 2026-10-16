import {
  CANONICAL_HASH_ALGORITHM,
  PROTOCOL_SCHEMA_VERSIONS,
  assertMoveSpecMatchesIntent,
  canonicalProtocolHash,
  parseProtocolObject,
  type CanonicalJsonValue,
  type FacilitationFunction,
  type FacilitationMoveSpecV1,
  type InterventionIntentV1
} from "@/lib/facilitation-protocol";
import type {
  LiveUiEventEvidence,
  LiveUiObservationReceipt
} from "@/lib/ui-agent/live-observation";
import { hashTransientDraftBody } from "./draft-content";
import { bindTrustedRuntimeTime } from "./trusted-clock";

export const LIVE_OPPORTUNITY_ASSESSMENT_SCHEMA_VERSION =
  "cmooc.live-opportunity-assessment.v1" as const;
export const LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION =
  "cmooc.live-opportunity-receipt.v1" as const;

export const LIVE_FACILITATION_POLICY_VERSION =
  "cmooc.live-facilitation.strict-prior.v2" as const;
export const LIVE_BUDGET_POLICY_VERSION =
  "cmooc.live-budget.author-coverage.v1" as const;
export const LIVE_DRAFT_GENERATOR_VERSION =
  "cmooc.deterministic-facilitation-draft.v1" as const;

const SUPPORT_GAP_HOURS = 72;
const AUTHOR_COOLDOWN_HOURS = 168;

export type ContributionFunction =
  | "operational"
  | "wayfinding"
  | "meaning_making"
  | "innovation"
  | "social_affective";

export type EvidenceStatus =
  | "supported"
  | "unsupported"
  | "unknown";

export type DominantNeed =
  | "connection_gap"
  | "conceptual_tension"
  | "participation_barrier"
  | "unknown";

export type ActiveFacilitationFunction = Exclude<
  FacilitationFunction,
  null
>;

export type LiveOpportunityDecision =
  | "draft"
  | "wait"
  | "abstain"
  | "yield";

export type LiveOpportunityReasonCode =
  | "draft_eligible"
  | "shadow_draft_unchanged_reused"
  | "teachable_episode_awaiting_learner"
  | "teachable_episode_stalled_closed"
  | "teachable_episode_human_returned"
  | "teachable_episode_peer_taken_over"
  | "external_human_response"
  | "distinct_actor_response"
  | "original_author_return"
  | "existing_system_or_agent_response"
  | "sequence_socially_complete"
  | "support_gap_not_mature"
  | "insufficient_longitudinal_history"
  | "author_cooldown_active"
  | "repeat_touch_limit"
  | "budget_unavailable"
  | "construct_unanswerable"
  | "relation_unanswerable"
  | "target_role_unknown"
  | "target_actor_ineligible"
  | "insufficient_admissible_evidence"
  | "support_unresolved"
  | "source_censored"
  | "history_evidence_unavailable"
  | "target_version_changed"
  | "protocol_failure";

export type NeedSignals = {
  connectionGap: EvidenceStatus;
  conceptualTension: EvidenceStatus;
  participationBarrier: EvidenceStatus;
};

export type LiveOpportunityAssessment = {
  schemaVersion: typeof LIVE_OPPORTUNITY_ASSESSMENT_SCHEMA_VERSION;
  observationReceiptHash: string;
  assessedAt: string;
  historyCutoffHash: string;
  targetVersionHash: string;
  eventSetHash: string;
  contributionPublishedAt: string;
  runtimeMode:
    | "real_course_shadow"
    | "test_platform_validation";
  targetActorRole:
    | "learner"
    | "creator"
    | "helper"
    | "unknown";
  testActorAuthorized: boolean;
  contributionFunctions: ContributionFunction[];
  sequenceCompletion: "open" | "socially_complete" | "unknown";
  atomicIdeaCount: number;
  epistemicSeedStatus: EvidenceStatus;
  needSignals: NeedSignals;
  dominantNeed: DominantNeed;
  relationQualification:
    | "supported"
    | "unresolved"
    | "conflicting";
  longitudinalHistoryStatus:
    | "sufficient"
    | "insufficient"
    | "unknown";
  candidateUniverse: "recent" | "support_gap" | "full_history";
  authorTouchCount30d: number | null;
  lastSystemTouchAt: string | null;
  budget: {
    availableSlots: number;
    workloadCost: number;
    authorTouchLimit30d: number;
  };
  containsForumText: false;
};

export type TrustedSchedulingHistoryAttestation = {
  historyReceiptHash: string;
  observationReceiptHash: string;
  courseKey: string;
  authorKey: string;
  historyCutoffHash: string;
  observedThrough: string;
  issuedAt: string;
  expiresAt: string;
  longitudinalHistoryStatus:
    LiveOpportunityAssessment["longitudinalHistoryStatus"];
  candidateUniverse: LiveOpportunityAssessment["candidateUniverse"];
  authorTouchCount30d: number | null;
  lastSystemTouchAt: string | null;
  budget: LiveOpportunityAssessment["budget"];
};

export type TrustedSemanticEvidenceAttestation = {
  semanticEvidenceHash: string;
  observationReceiptHash: string;
  targetVersionHash: string;
  eventSetHash: string;
  issuedAt: string;
  expiresAt: string;
  authority: "server_course_scan";
  containsForumText: false;
};

export type EvidenceQualificationReceipt = {
  answerability: "qualified" | "unanswerable";
  formatValid: true;
  evidenceLegal: boolean;
  relationCorrect: boolean;
  temporalLegal: boolean;
  supportResolution: "resolved" | "unresolved" | "conflicting";
  appropriateAbstention: boolean;
  decision: "qualify" | "abstain" | "review";
  reasonCodes: LiveOpportunityReasonCode[];
};

export type LiveOpportunityReceipt = {
  schemaVersion: typeof LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION;
  opportunityKey: string;
  sourceKind: "real_platform_live_shadow";
  observationReceiptHash: string;
  historyCutoffHash: string;
  historyEvidenceHash: string | null;
  targetVersionHash: string;
  eventSetHash: string;
  evidenceAsOf: string;
  assessedAt: string;
  runtimeMode: LiveOpportunityAssessment["runtimeMode"];
  targetActorRole:
    LiveOpportunityAssessment["targetActorRole"];
  targetRoleBasis:
    | "verified_learner_role"
    | "unqualified";
  contributionFunctions: ContributionFunction[];
  atomicIdeaCount: number;
  baselineEventEvidence: LiveUiEventEvidence[];
  candidateUniverse: LiveOpportunityAssessment["candidateUniverse"];
  qualification: EvidenceQualificationReceipt;
  decision: LiveOpportunityDecision;
  decisionMode:
    | "DRAFT_ELIGIBLE"
    | "WAIT_VOLUNTARY"
    | "WAIT_FORCED"
    | "ABSTAIN"
    | "YIELD_TO_HUMAN"
    | "YIELD_TO_EXISTING_RESPONSE";
  reasonCode: LiveOpportunityReasonCode;
  selectedFunction: FacilitationFunction | null;
  workloadCost: number;
  authorTouchCount30d: number | null;
  intent: InterventionIntentV1 | null;
  intentHash: string | null;
  moveSpec: FacilitationMoveSpecV1 | null;
  moveSpecHash: string | null;
  draftCreated: boolean;
  draftContentHash: string | null;
  draftGeneratorVersion: string | null;
  draftBodyPersisted: false;
  requiresTargetRevalidation: boolean;
  realPublishEnabled: false;
  publishCapabilityAvailable: false;
  containsForumText: false;
  /** Present only when an already-verified episode can narrow this decision. */
  teachableEpisodeReceiptHash?: string;
};

export type LiveOpportunityResult = {
  receipt: LiveOpportunityReceipt;
  receiptHash: string;
  transientDraft: string | null;
};

const ASSESSMENT_KEYS = new Set([
  "schemaVersion",
  "observationReceiptHash",
  "assessedAt",
  "historyCutoffHash",
  "targetVersionHash",
  "eventSetHash",
  "contributionPublishedAt",
  "runtimeMode",
  "targetActorRole",
  "testActorAuthorized",
  "contributionFunctions",
  "sequenceCompletion",
  "atomicIdeaCount",
  "epistemicSeedStatus",
  "needSignals",
  "dominantNeed",
  "relationQualification",
  "longitudinalHistoryStatus",
  "candidateUniverse",
  "authorTouchCount30d",
  "lastSystemTouchAt",
  "budget",
  "containsForumText"
]);

const NEED_SIGNAL_KEYS = new Set([
  "connectionGap",
  "conceptualTension",
  "participationBarrier"
]);

const BUDGET_KEYS = new Set([
  "availableSlots",
  "workloadCost",
  "authorTouchLimit30d"
]);

const CONTRIBUTION_FUNCTIONS = new Set<ContributionFunction>([
  "operational",
  "wayfinding",
  "meaning_making",
  "innovation",
  "social_affective"
]);

const EVIDENCE_STATUSES = new Set<EvidenceStatus>([
  "supported",
  "unsupported",
  "unknown"
]);

const DOMINANT_NEEDS = new Set<DominantNeed>([
  "connection_gap",
  "conceptual_tension",
  "participation_barrier",
  "unknown"
]);

function objectValue(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new Error(`${label}包含未允许字段：${extra.sort().join("、")}。`);
  }
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string
): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new Error(`${label}不在允许枚举中。`);
  }
  return value as T;
}

function sha256(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{64}$/i.test(value)
  ) {
    throw new Error(`${label}必须是 SHA-256 十六进制摘要。`);
  }
  return value.toLowerCase();
}

function opaqueEvidenceKey(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{24,64}$/i.test(value)
  ) {
    throw new Error(`${label}必须是去标识证据键。`);
  }
  return value.toLowerCase();
}

function isoTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}必须是有效时间。`);
  }
  return new Date(value).toISOString();
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${label}必须是非负安全整数。`);
  }
  return value;
}

function optionalNonNegativeInteger(
  value: unknown,
  label: string
): number | null {
  return value === null ? null : nonNegativeInteger(value, label);
}

function optionalIsoTime(
  value: unknown,
  label: string
): string | null {
  return value === null ? null : isoTime(value, label);
}

function parseNeedSignals(value: unknown): NeedSignals {
  const input = objectValue(value, "需要信号");
  exactKeys(input, NEED_SIGNAL_KEYS, "需要信号");
  return {
    connectionGap: enumValue(
      input.connectionGap,
      EVIDENCE_STATUSES,
      "连接缺口"
    ),
    conceptualTension: enumValue(
      input.conceptualTension,
      EVIDENCE_STATUSES,
      "概念张力"
    ),
    participationBarrier: enumValue(
      input.participationBarrier,
      EVIDENCE_STATUSES,
      "参与障碍"
    )
  };
}

function parseBudget(
  value: unknown
): LiveOpportunityAssessment["budget"] {
  const input = objectValue(value, "注意预算");
  exactKeys(input, BUDGET_KEYS, "注意预算");
  const workloadCost = nonNegativeInteger(
    input.workloadCost,
    "工作量成本"
  );
  if (workloadCost < 1 || workloadCost > 100) {
    throw new Error("工作量成本必须介于 1 与 100。");
  }
  return {
    availableSlots: nonNegativeInteger(
      input.availableSlots,
      "可用预算槽位"
    ),
    workloadCost,
    authorTouchLimit30d: nonNegativeInteger(
      input.authorTouchLimit30d,
      "30 日作者触达上限"
    )
  };
}

export function parseLiveOpportunityAssessment(
  value: unknown
): LiveOpportunityAssessment {
  const input = objectValue(value, "真实机会评估");
  exactKeys(input, ASSESSMENT_KEYS, "真实机会评估");
  if (
    input.schemaVersion !==
    LIVE_OPPORTUNITY_ASSESSMENT_SCHEMA_VERSION
  ) {
    throw new Error("真实机会评估 schema 无效。");
  }
  if (input.containsForumText !== false) {
    throw new Error("真实机会评估只接受去正文结构化标签。");
  }
  if (
    !Array.isArray(input.contributionFunctions) ||
    input.contributionFunctions.length > 5
  ) {
    throw new Error("贡献功能必须是最多五项的数组。");
  }
  const contributionFunctions = input.contributionFunctions.map(
    (item) =>
      enumValue(item, CONTRIBUTION_FUNCTIONS, "贡献功能")
  );
  if (
    new Set(contributionFunctions).size !==
    contributionFunctions.length
  ) {
    throw new Error("贡献功能不得重复。");
  }
  const atomicIdeaCount = nonNegativeInteger(
    input.atomicIdeaCount,
    "原子想法数量"
  );
  if (atomicIdeaCount < 1 || atomicIdeaCount > 20) {
    throw new Error("原子想法数量必须介于 1 与 20。");
  }
  const sequenceCompletion =
    input.sequenceCompletion === "open" ||
    input.sequenceCompletion === "socially_complete" ||
    input.sequenceCompletion === "unknown"
      ? input.sequenceCompletion
      : null;
  if (!sequenceCompletion) {
    throw new Error("序列完成状态无效。");
  }
  const relationQualification =
    input.relationQualification === "supported" ||
    input.relationQualification === "unresolved" ||
    input.relationQualification === "conflicting"
      ? input.relationQualification
      : null;
  if (!relationQualification) {
    throw new Error("关系资格状态无效。");
  }
  const longitudinalHistoryStatus =
    input.longitudinalHistoryStatus === "sufficient" ||
    input.longitudinalHistoryStatus === "insufficient" ||
    input.longitudinalHistoryStatus === "unknown"
      ? input.longitudinalHistoryStatus
      : null;
  if (!longitudinalHistoryStatus) {
    throw new Error("纵向历史状态无效。");
  }
  const candidateUniverse =
    input.candidateUniverse === "recent" ||
    input.candidateUniverse === "support_gap" ||
    input.candidateUniverse === "full_history"
      ? input.candidateUniverse
      : null;
  if (!candidateUniverse) {
    throw new Error("候选宇宙状态无效。");
  }
  const runtimeMode =
    input.runtimeMode === "real_course_shadow" ||
    input.runtimeMode === "test_platform_validation"
      ? input.runtimeMode
      : null;
  if (!runtimeMode) {
    throw new Error("真实运行模式无效。");
  }
  const targetActorRole =
    input.targetActorRole === "learner" ||
    input.targetActorRole === "creator" ||
    input.targetActorRole === "helper" ||
    input.targetActorRole === "unknown"
      ? input.targetActorRole
      : null;
  if (!targetActorRole) {
    throw new Error("目标参与者角色无效。");
  }
  if (typeof input.testActorAuthorized !== "boolean") {
    throw new Error("测试参与者授权状态必须是布尔值。");
  }
  if (
    input.testActorAuthorized
  ) {
    throw new Error(
      "测试参与者授权必须绑定独立许可回执，不能使用裸布尔值。"
    );
  }
  const assessedAt = isoTime(input.assessedAt, "评估时间");
  const contributionPublishedAt = isoTime(
    input.contributionPublishedAt,
    "贡献发布时间"
  );
  if (
    Date.parse(contributionPublishedAt) > Date.parse(assessedAt)
  ) {
    throw new Error("贡献发布时间不得晚于评估时间。");
  }
  return {
    schemaVersion: LIVE_OPPORTUNITY_ASSESSMENT_SCHEMA_VERSION,
    observationReceiptHash: sha256(
      input.observationReceiptHash,
      "观察回执哈希"
    ),
    assessedAt,
    historyCutoffHash: sha256(
      input.historyCutoffHash,
      "历史截点哈希"
    ),
    targetVersionHash: sha256(
      input.targetVersionHash,
      "目标版本哈希"
    ),
    eventSetHash: sha256(input.eventSetHash, "事件集合哈希"),
    contributionPublishedAt,
    runtimeMode,
    targetActorRole,
    testActorAuthorized: input.testActorAuthorized,
    contributionFunctions,
    sequenceCompletion,
    atomicIdeaCount,
    epistemicSeedStatus: enumValue(
      input.epistemicSeedStatus,
      EVIDENCE_STATUSES,
      "认识种子状态"
    ),
    needSignals: parseNeedSignals(input.needSignals),
    dominantNeed: enumValue(
      input.dominantNeed,
      DOMINANT_NEEDS,
      "主导需要"
    ),
    relationQualification,
    longitudinalHistoryStatus,
    candidateUniverse,
    authorTouchCount30d: optionalNonNegativeInteger(
      input.authorTouchCount30d,
      "30 日作者触达次数"
    ),
    lastSystemTouchAt: optionalIsoTime(
      input.lastSystemTouchAt,
      "最近系统触达时间"
    ),
    budget: parseBudget(input.budget),
    containsForumText: false
  };
}

function hoursBetween(earlier: string, later: string): number {
  return (Date.parse(later) - Date.parse(earlier)) / 3_600_000;
}

function selectedFunction(
  assessment: LiveOpportunityAssessment
): ActiveFacilitationFunction | null {
  const mapping: Record<
    Exclude<DominantNeed, "unknown">,
    {
      signal: keyof NeedSignals;
      facilitationFunction: ActiveFacilitationFunction;
    }
  > = {
    connection_gap: {
      signal: "connectionGap",
      facilitationFunction: "resource_connection"
    },
    conceptual_tension: {
      signal: "conceptualTension",
      facilitationFunction: "cognitive_conflict"
    },
    participation_barrier: {
      signal: "participationBarrier",
      facilitationFunction: "emotional_support"
    }
  };
  if (assessment.dominantNeed === "unknown") return null;
  const selected = mapping[assessment.dominantNeed];
  return assessment.needSignals[selected.signal] === "supported"
    ? selected.facilitationFunction
    : null;
}

export function buildDeterministicFacilitationDraft(
  facilitationFunction: ActiveFacilitationFunction
): string {
  if (facilitationFunction === "resource_connection") {
    return [
      "这个想法已经提供了一个可以连接同伴经验的起点。",
      "你愿意补充一个最希望大家回应的具体情境或问题吗？",
      "也邀请有相关案例的同学分享可借鉴的资源或做法，并说明它如何适用于这里。"
    ].join("");
  }
  if (facilitationFunction === "cognitive_conflict") {
    return [
      "你已经把一个值得继续检验的观点放到了讨论里。",
      "想邀请你再往前走一步：如果关键条件发生变化，这个判断还会成立吗？",
      "可以用一个具体例子或反例说明它的适用边界，也欢迎其他同学从不同经验出发接续这个问题。"
    ].join("");
  }
  return [
    "谢谢你把这个想法带进讨论，它已经提供了一个可继续展开的起点。",
    "你可以从其中最想保留的一点出发，再补充一个具体例子或疑问；",
    "也欢迎有相似经历的同学接续回应。"
  ].join("");
}

function buildIntentAndMoveSpec(input: {
  assessment: LiveOpportunityAssessment;
  evidenceRefHash: string;
  facilitationFunction: ActiveFacilitationFunction;
}): {
  intent: InterventionIntentV1;
  intentHash: string;
  moveSpec: FacilitationMoveSpecV1;
  moveSpecHash: string;
} {
  const candidateExpiresAt = new Date(
    Date.parse(input.assessment.assessedAt) + 30 * 60_000
  ).toISOString();
  const intent = parseProtocolObject("interventionIntent", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.interventionIntent,
    evidenceRefHash: input.evidenceRefHash,
    evidenceAsOf: input.assessment.assessedAt,
    intervene: true,
    facilitationFunction: input.facilitationFunction,
    targetObject: "thread_author",
    workloadCost: input.assessment.budget.workloadCost,
    candidateExpiresAt,
    withdrawalConditions: [
      "external_human_response",
      "source_censored",
      "candidate_expired",
      "budget_unavailable",
      "target_version_changed",
      "author_cooldown_active"
    ],
    policyVersion: LIVE_FACILITATION_POLICY_VERSION,
    budgetVersion: LIVE_BUDGET_POLICY_VERSION,
    hashAlgorithm: CANONICAL_HASH_ALGORITHM,
    containsForumText: false
  });
  const intentHash = canonicalProtocolHash(
    intent.schemaVersion,
    intent as CanonicalJsonValue
  );
  const semantics = {
    resource_connection: {
      needState: "connection_gap",
      mechanismTarget: "reduce_connection_cost",
      facilitationMove: "connect_resource_and_invite_application",
      requiredContentElements: [
        "connection_cue",
        "specific_invitation"
      ],
      observableSuccessCriteria: [
        "external_human_response",
        "original_author_return",
        "resource_application_attempt"
      ]
    },
    cognitive_conflict: {
      needState: "conceptual_tension",
      mechanismTarget: "surface_explanatory_tension",
      facilitationMove:
        "pose_counterexample_and_request_explanation",
      requiredContentElements: [
        "boundary_question",
        "counterexample_invitation"
      ],
      observableSuccessCriteria: [
        "external_human_response",
        "reply_chain_extension",
        "explanatory_revision"
      ]
    },
    emotional_support: {
      needState: "participation_barrier",
      mechanismTarget: "lower_reentry_cost",
      facilitationMove: "acknowledge_contribution_and_invite_return",
      requiredContentElements: [
        "specific_acknowledgement",
        "low_cost_reentry_invitation"
      ],
      observableSuccessCriteria: [
        "external_human_response",
        "original_author_return"
      ]
    }
  } as const;
  const move = semantics[input.facilitationFunction];
  const moveSpec = parseProtocolObject("facilitationMoveSpec", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.facilitationMoveSpec,
    intentHash,
    needState: move.needState,
    mechanismTarget: move.mechanismTarget,
    facilitationMove: move.facilitationMove,
    targetObject: "thread_author",
    requiredContentElements: [...move.requiredContentElements],
    prohibitedMoves: [
      "answer_on_behalf_of_learner",
      "identity_ranking",
      "stable_personality_judgment",
      "diagnostic_mental_state_claim",
      "unverifiable_learning_effect_claim"
    ],
    observableSuccessCriteria: [
      ...move.observableSuccessCriteria
    ],
    specVersion: "cmooc.live-move-spec.v1",
    containsForumText: false
  });
  assertMoveSpecMatchesIntent(intent, moveSpec);
  return {
    intent,
    intentHash,
    moveSpec,
    moveSpecHash: canonicalProtocolHash(
      moveSpec.schemaVersion,
      moveSpec as CanonicalJsonValue
    )
  };
}

function verifyTrustedSchedulingHistory(input: {
  attestation?: TrustedSchedulingHistoryAttestation;
  assessment: LiveOpportunityAssessment;
  observation: LiveUiObservationReceipt;
}): TrustedSchedulingHistoryAttestation | null {
  const attestation = input.attestation;
  if (!attestation) return null;
  const observedThrough = isoTime(
    attestation.observedThrough,
    "调度历史观察截止时间"
  );
  const issuedAt = isoTime(
    attestation.issuedAt,
    "调度历史回执签发时间"
  );
  const expiresAt = isoTime(
    attestation.expiresAt,
    "调度历史回执失效时间"
  );
  const lastSystemTouchAt = optionalIsoTime(
    attestation.lastSystemTouchAt,
    "调度历史最近系统触达时间"
  );
  const budget = parseBudget(attestation.budget);
  const authorTouchCount30d = optionalNonNegativeInteger(
    attestation.authorTouchCount30d,
    "调度历史 30 日作者触达次数"
  );
  const historyReceiptHash = sha256(
    attestation.historyReceiptHash,
    "调度历史回执哈希"
  );
  const observationReceiptHash = sha256(
    attestation.observationReceiptHash,
    "调度历史观察回执哈希"
  );
  const courseKey = opaqueEvidenceKey(
    attestation.courseKey,
    "调度历史课程键"
  );
  const authorKey = opaqueEvidenceKey(
    attestation.authorKey,
    "调度历史作者键"
  );
  const historyCutoffHash = sha256(
    attestation.historyCutoffHash,
    "调度历史截点哈希"
  );
  const timeOrderValid =
    Date.parse(observedThrough) >=
      Date.parse(input.observation.evidenceAsOf) &&
    Date.parse(observedThrough) <= Date.parse(issuedAt) &&
    Date.parse(issuedAt) <=
      Date.parse(input.assessment.assessedAt) &&
    Date.parse(input.assessment.assessedAt) <=
      Date.parse(expiresAt) &&
    (lastSystemTouchAt === null ||
      Date.parse(lastSystemTouchAt) <=
        Date.parse(observedThrough));
  const matchesAssessment =
    observationReceiptHash ===
      input.assessment.observationReceiptHash &&
    courseKey === input.observation.courseKey &&
    input.observation.authorKey !== null &&
    authorKey === input.observation.authorKey &&
    historyCutoffHash === input.assessment.historyCutoffHash &&
    attestation.longitudinalHistoryStatus ===
      input.assessment.longitudinalHistoryStatus &&
    attestation.candidateUniverse ===
      input.assessment.candidateUniverse &&
    authorTouchCount30d ===
      input.assessment.authorTouchCount30d &&
    lastSystemTouchAt === input.assessment.lastSystemTouchAt &&
    budget.availableSlots ===
      input.assessment.budget.availableSlots &&
    budget.workloadCost ===
      input.assessment.budget.workloadCost &&
    budget.authorTouchLimit30d ===
      input.assessment.budget.authorTouchLimit30d;
  if (
    !timeOrderValid ||
    !matchesAssessment ||
    !["sufficient", "insufficient", "unknown"].includes(
      attestation.longitudinalHistoryStatus
    ) ||
    !["recent", "support_gap", "full_history"].includes(
      attestation.candidateUniverse
    )
  ) {
    throw new Error(
      "受信调度历史回执与当前观察、作者、时点或预算不一致。"
    );
  }
  return {
    historyReceiptHash,
    observationReceiptHash,
    courseKey,
    authorKey,
    historyCutoffHash,
    observedThrough,
    issuedAt,
    expiresAt,
    longitudinalHistoryStatus:
      attestation.longitudinalHistoryStatus,
    candidateUniverse: attestation.candidateUniverse,
    authorTouchCount30d,
    lastSystemTouchAt,
    budget
  };
}

function verifyTrustedSemanticEvidence(input: {
  attestation?: TrustedSemanticEvidenceAttestation;
  assessment: LiveOpportunityAssessment;
  observation: LiveUiObservationReceipt;
}): TrustedSemanticEvidenceAttestation | null {
  const attestation = input.attestation;
  if (!attestation) return null;
  const semanticEvidenceHash = sha256(
    attestation.semanticEvidenceHash,
    "语义证据回执哈希"
  );
  const observationReceiptHash = sha256(
    attestation.observationReceiptHash,
    "语义证据观察回执哈希"
  );
  const targetVersionHash = sha256(
    attestation.targetVersionHash,
    "语义证据目标版本哈希"
  );
  const eventSetHash = sha256(
    attestation.eventSetHash,
    "语义证据事件集合哈希"
  );
  const issuedAt = isoTime(
    attestation.issuedAt,
    "语义证据签发时间"
  );
  const expiresAt = isoTime(
    attestation.expiresAt,
    "语义证据失效时间"
  );
  const valid =
    attestation.authority === "server_course_scan" &&
    attestation.containsForumText === false &&
    observationReceiptHash ===
      input.assessment.observationReceiptHash &&
    observationReceiptHash ===
      canonicalProtocolHash(
        input.observation.schemaVersion,
        input.observation as CanonicalJsonValue
      ) &&
    targetVersionHash === input.assessment.targetVersionHash &&
    targetVersionHash === input.observation.targetVersionHash &&
    eventSetHash === input.assessment.eventSetHash &&
    eventSetHash === input.observation.eventSetHash &&
    Date.parse(input.observation.evidenceAsOf) <=
      Date.parse(issuedAt) &&
    Date.parse(issuedAt) <=
      Date.parse(input.assessment.assessedAt) &&
    Date.parse(input.assessment.assessedAt) <=
      Date.parse(expiresAt);
  if (!valid) {
    throw new Error(
      "受信语义证据回执与当前观察、目标、事件前缀或时点不一致。"
    );
  }
  return {
    semanticEvidenceHash,
    observationReceiptHash,
    targetVersionHash,
    eventSetHash,
    issuedAt,
    expiresAt,
    authority: "server_course_scan",
    containsForumText: false
  };
}

function makeQualification(input: {
  assessment: LiveOpportunityAssessment;
  observation: LiveUiObservationReceipt;
  trustedHistory: TrustedSchedulingHistoryAttestation | null;
  trustedSemantic: TrustedSemanticEvidenceAttestation | null;
}): EvidenceQualificationReceipt {
  const {
    assessment,
    observation,
    trustedHistory,
    trustedSemantic
  } = input;
  const sameTabGuardedEvidence =
    observation.attestationLevel === "same_tab_guarded" &&
    observation.networkGuardAttached &&
    observation.guardReceiptHash !== null &&
    observation.guardObservedAt !== null &&
    observation.guardExpiresAt !== null &&
    Date.parse(observation.guardObservedAt) <=
      Date.parse(assessment.assessedAt) &&
    Date.parse(assessment.assessedAt) <=
      Date.parse(observation.guardExpiresAt);
  const serverSemanticEvidence =
    trustedSemantic !== null &&
    observation.attestationLevel === "target_only";
  const evidenceLegal =
    observation.captureStatus === "semantic_ready" &&
    observation.safeToAdvanceToSemanticReview &&
    observation.temporalEvidenceStatus ===
      "live_prefix_observed" &&
    observation.contentRevisionStatus ===
      "live_target_fingerprint_observed" &&
    (sameTabGuardedEvidence || serverSemanticEvidence) &&
    observation.commentCompleteness === "complete" &&
    observation.identityBasis === "stable_platform_ref" &&
    observation.authorRoleEvidenceHash !== null &&
    observation.authorRoleEvidenceExpiresAt !== null &&
    Date.parse(assessment.assessedAt) <=
      Date.parse(observation.authorRoleEvidenceExpiresAt) &&
    assessment.targetActorRole === observation.authorRole &&
    trustedHistory !== null &&
    assessment.targetVersionHash === observation.targetVersionHash &&
    assessment.eventSetHash === observation.eventSetHash;
  const temporalLegal =
    Date.parse(assessment.assessedAt) >=
      Date.parse(observation.evidenceAsOf) &&
    Date.parse(assessment.contributionPublishedAt) <=
      Date.parse(assessment.assessedAt);
  const relationCorrect =
    assessment.relationQualification === "supported";
  const targetRoleQualified =
    assessment.targetActorRole === "learner" &&
    observation.authorRole === "learner" &&
    observation.authorRoleEvidenceHash !== null &&
    observation.authorRoleEvidenceExpiresAt !== null;
  const answerable =
    assessment.sequenceCompletion !== "unknown" &&
    assessment.epistemicSeedStatus !== "unknown" &&
    assessment.longitudinalHistoryStatus !== "unknown" &&
    assessment.dominantNeed !== "unknown" &&
    targetRoleQualified &&
    observation.eventEvidence.every(
      (event) => event.actorRelation !== "unknown"
    );
  const supportResolution =
    assessment.relationQualification === "conflicting"
      ? "conflicting"
      : assessment.relationQualification === "unresolved" ||
          assessment.epistemicSeedStatus !== "supported"
        ? "unresolved"
        : "resolved";
  const reasonCodes: LiveOpportunityReasonCode[] = [];
  if (
    observation.captureStatus === "source_censored" ||
    observation.temporalEvidenceStatus !==
      "live_prefix_observed" ||
    observation.contentRevisionStatus !==
      "live_target_fingerprint_observed" ||
    (!sameTabGuardedEvidence && !serverSemanticEvidence) ||
    observation.authorRoleEvidenceHash === null ||
    observation.authorRoleEvidenceExpiresAt === null ||
    observation.commentCompleteness !== "complete" ||
    observation.identityBasis !== "stable_platform_ref"
  ) {
    reasonCodes.push("source_censored");
  }
  if (trustedHistory === null) {
    reasonCodes.push("history_evidence_unavailable");
  }
  if (
    observation.targetVersionHash !== assessment.targetVersionHash
  ) {
    reasonCodes.push("target_version_changed");
  }
  if (!answerable) reasonCodes.push("construct_unanswerable");
  if (!relationCorrect) reasonCodes.push("relation_unanswerable");
  if (!targetRoleQualified) {
    reasonCodes.push(
      assessment.targetActorRole === "unknown" ||
        observation.authorRole === "unknown"
        ? "target_role_unknown"
        : "target_actor_ineligible"
    );
  }
  if (!evidenceLegal || !temporalLegal) {
    reasonCodes.push("insufficient_admissible_evidence");
  }
  if (supportResolution !== "resolved") {
    reasonCodes.push("support_unresolved");
  }
  const decision: EvidenceQualificationReceipt["decision"] =
    reasonCodes.includes("target_version_changed") ||
    supportResolution === "conflicting"
      ? "review"
      : reasonCodes.length > 0
        ? "abstain"
        : "qualify";
  return {
    answerability: answerable ? "qualified" : "unanswerable",
    formatValid: true,
    evidenceLegal,
    relationCorrect,
    temporalLegal,
    supportResolution,
    appropriateAbstention: decision !== "qualify",
    decision,
    reasonCodes: [...new Set(reasonCodes)]
  };
}

function decide(input: {
  assessment: LiveOpportunityAssessment;
  observation: LiveUiObservationReceipt;
  qualification: EvidenceQualificationReceipt;
  teachableEpisodeDirective?: TeachableEpisodeDirective;
}): {
  decision: LiveOpportunityDecision;
  decisionMode: LiveOpportunityReceipt["decisionMode"];
  reasonCode: LiveOpportunityReasonCode;
  facilitationFunction: ActiveFacilitationFunction | null;
} {
  const { assessment, observation, qualification } = input;
  if (
    observation.eventEvidence.some(
      (event) => event.actorRelation === "external_human"
    )
  ) {
    return {
      decision: "yield",
      decisionMode: "YIELD_TO_HUMAN",
      reasonCode: "external_human_response",
      facilitationFunction: null
    };
  }
  if (
    observation.eventEvidence.some(
      (event) =>
        event.actorRelation === "thread_author" &&
        event.parentEventKey !== null
    )
  ) {
    return {
      decision: "yield",
      decisionMode: "YIELD_TO_HUMAN",
      reasonCode: "original_author_return",
      facilitationFunction: null
    };
  }
  if (
    observation.eventEvidence.some(
      (event) => event.actorRelation === "system_or_agent"
    )
  ) {
    return {
      decision: "yield",
      decisionMode: "YIELD_TO_HUMAN",
      reasonCode: "existing_system_or_agent_response",
      facilitationFunction: null
    };
  }
  if (hasStableDistinctActorResponse(observation)) {
    return {
      decision: "yield",
      decisionMode: "YIELD_TO_EXISTING_RESPONSE",
      reasonCode: "distinct_actor_response",
      facilitationFunction: null
    };
  }
  if (assessment.sequenceCompletion === "socially_complete") {
    return {
      decision: "yield",
      decisionMode: "YIELD_TO_HUMAN",
      reasonCode: "sequence_socially_complete",
      facilitationFunction: null
    };
  }
  if (
    observation.captureStatus === "source_censored" ||
    observation.commentCompleteness !== "complete"
  ) {
    return {
      decision: "abstain",
      decisionMode: "ABSTAIN",
      reasonCode: "source_censored",
      facilitationFunction: null
    };
  }
  if (qualification.decision !== "qualify") {
    return {
      decision: "abstain",
      decisionMode: "ABSTAIN",
      reasonCode:
        qualification.reasonCodes[0] ?? "protocol_failure",
      facilitationFunction: null
    };
  }
  if (input.teachableEpisodeDirective) {
    const directive = input.teachableEpisodeDirective;
    if (directive.action === "yield") {
      return {
        decision: "yield",
        decisionMode: "YIELD_TO_HUMAN",
        reasonCode: directive.reasonCode,
        facilitationFunction: null
      };
    }
    if (directive.action === "close") {
      return {
        decision: "abstain",
        decisionMode: "ABSTAIN",
        reasonCode: directive.reasonCode,
        facilitationFunction: null
      };
    }
    return {
      decision: "wait",
      decisionMode: "WAIT_FORCED",
      reasonCode: directive.reasonCode,
      facilitationFunction: null
    };
  }
  if (
    hoursBetween(
      assessment.contributionPublishedAt,
      assessment.assessedAt
    ) < SUPPORT_GAP_HOURS
  ) {
    return {
      decision: "wait",
      decisionMode: "WAIT_VOLUNTARY",
      reasonCode: "support_gap_not_mature",
      facilitationFunction: null
    };
  }
  if (assessment.longitudinalHistoryStatus !== "sufficient") {
    return {
      decision: "wait",
      decisionMode: "WAIT_FORCED",
      reasonCode: "insufficient_longitudinal_history",
      facilitationFunction: null
    };
  }
  if (
    assessment.lastSystemTouchAt !== null &&
    hoursBetween(
      assessment.lastSystemTouchAt,
      assessment.assessedAt
    ) < AUTHOR_COOLDOWN_HOURS
  ) {
    return {
      decision: "wait",
      decisionMode: "WAIT_FORCED",
      reasonCode: "author_cooldown_active",
      facilitationFunction: null
    };
  }
  if (
    assessment.authorTouchCount30d !== null &&
    assessment.authorTouchCount30d >=
      assessment.budget.authorTouchLimit30d
  ) {
    return {
      decision: "wait",
      decisionMode: "WAIT_FORCED",
      reasonCode: "repeat_touch_limit",
      facilitationFunction: null
    };
  }
  if (
    assessment.budget.availableSlots <
    assessment.budget.workloadCost
  ) {
    return {
      decision: "wait",
      decisionMode: "WAIT_FORCED",
      reasonCode: "budget_unavailable",
      facilitationFunction: null
    };
  }
  const facilitationFunction = selectedFunction(assessment);
  if (!facilitationFunction) {
    return {
      decision: "abstain",
      decisionMode: "ABSTAIN",
      reasonCode: "construct_unanswerable",
      facilitationFunction: null
    };
  }
  return {
    decision: "draft",
    decisionMode: "DRAFT_ELIGIBLE",
    reasonCode: "draft_eligible",
    facilitationFunction
  };
}

export type TeachableEpisodeDirective = {
  action: "wait" | "yield" | "close";
  reasonCode:
    | "shadow_draft_unchanged_reused"
    | "teachable_episode_awaiting_learner"
    | "teachable_episode_stalled_closed"
    | "teachable_episode_human_returned"
    | "teachable_episode_peer_taken_over";
  receiptHash: string;
};

function parseTeachableEpisodeDirective(
  value: TeachableEpisodeDirective | undefined
): TeachableEpisodeDirective | undefined {
  if (value === undefined) return undefined;
  if (!/^[a-f0-9]{64}$/.test(value.receiptHash)) {
    throw new Error("可教回合回执哈希无效。");
  }
  const reasonByAction = {
    wait: new Set([
      "shadow_draft_unchanged_reused",
      "teachable_episode_awaiting_learner"
    ]),
    yield: new Set([
      "teachable_episode_human_returned",
      "teachable_episode_peer_taken_over"
    ]),
    close: new Set(["teachable_episode_stalled_closed"])
  } as const;
  if (!reasonByAction[value.action].has(value.reasonCode as never)) {
    throw new Error("可教回合动作与理由不匹配。");
  }
  return { ...value };
}

export function hasStableDistinctActorResponse(
  observation: Pick<
    LiveUiObservationReceipt,
    "authorKey" | "eventEvidence"
  >
): boolean {
  if (!observation.authorKey) return false;
  return observation.eventEvidence.some(
    (event) =>
      event.parentEventKey !== null &&
      event.actorKey !== null &&
      event.actorKey !== observation.authorKey
  );
}

export function buildLiveFacilitationOpportunity(input: {
  assessment: LiveOpportunityAssessment;
  observation: LiveUiObservationReceipt;
  trustedNow: string;
  trustedHistoryAttestation?: TrustedSchedulingHistoryAttestation;
  trustedSemanticEvidenceAttestation?: TrustedSemanticEvidenceAttestation;
  teachableEpisodeDirective?: TeachableEpisodeDirective;
}): LiveOpportunityResult {
  const observation = input.observation;
  const assessment: LiveOpportunityAssessment = {
    ...input.assessment,
    assessedAt: bindTrustedRuntimeTime({
      claimedAt: input.assessment.assessedAt,
      trustedNow: input.trustedNow,
      label: "机会评估时间"
    })
  };
  const actualObservationReceiptHash = canonicalProtocolHash(
    observation.schemaVersion,
    observation as CanonicalJsonValue
  );
  if (
    assessment.observationReceiptHash !== actualObservationReceiptHash
  ) {
    throw new Error("机会评估引用了不同的真实观察回执。");
  }
  const rootEvents = observation.eventEvidence.filter(
    (event) => event.parentEventKey === null
  );
  if (
    rootEvents.length !== 1 ||
    rootEvents[0]?.actorRelation !== "thread_author" ||
    Date.parse(rootEvents[0].createdAt) !==
      Date.parse(assessment.contributionPublishedAt)
  ) {
    throw new Error(
      "贡献发布时间必须绑定观察中唯一的作者根事件。"
    );
  }
  const trustedHistory = verifyTrustedSchedulingHistory({
    attestation: input.trustedHistoryAttestation,
    assessment,
    observation
  });
  const trustedSemantic = verifyTrustedSemanticEvidence({
    attestation: input.trustedSemanticEvidenceAttestation,
    assessment,
    observation
  });
  const qualification = makeQualification({
    assessment,
    observation,
    trustedHistory,
    trustedSemantic
  });
  const teachableEpisodeDirective =
    parseTeachableEpisodeDirective(
      input.teachableEpisodeDirective
    );
  const decision = decide({
    assessment,
    observation,
    qualification,
    teachableEpisodeDirective
  });
  const evidenceRef = {
    schemaVersion: "cmooc.live-qualified-evidence-ref.v1",
    observationReceiptHash: assessment.observationReceiptHash,
    historyCutoffHash: assessment.historyCutoffHash,
    historyEvidenceHash:
      trustedHistory?.historyReceiptHash ?? null,
    targetVersionHash: assessment.targetVersionHash,
    eventSetHash: assessment.eventSetHash,
    assessedAt: assessment.assessedAt,
    qualification,
    containsForumText: false
  } as const;
  const evidenceRefHash = canonicalProtocolHash(
    evidenceRef.schemaVersion,
    evidenceRef as CanonicalJsonValue
  );
  const protocolObjects =
    decision.decision === "draft" && decision.facilitationFunction
      ? buildIntentAndMoveSpec({
          assessment,
          evidenceRefHash,
          facilitationFunction: decision.facilitationFunction
        })
      : null;
  const transientDraft =
    decision.decision === "draft" && decision.facilitationFunction
      ? buildDeterministicFacilitationDraft(
          decision.facilitationFunction
        )
      : null;
  const draftContentHash = transientDraft
    ? hashTransientDraftBody(transientDraft)
    : null;
  const receiptWithoutKey = {
    schemaVersion: LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION,
    sourceKind: "real_platform_live_shadow" as const,
    observationReceiptHash: assessment.observationReceiptHash,
    historyCutoffHash: assessment.historyCutoffHash,
    historyEvidenceHash:
      trustedHistory?.historyReceiptHash ?? null,
    targetVersionHash: assessment.targetVersionHash,
    eventSetHash: assessment.eventSetHash,
    evidenceAsOf: observation.evidenceAsOf,
    assessedAt: assessment.assessedAt,
    runtimeMode: assessment.runtimeMode,
    targetActorRole: assessment.targetActorRole,
    targetRoleBasis:
      assessment.targetActorRole === "learner" &&
      observation.authorRole === "learner" &&
      observation.authorRoleEvidenceHash !== null
        ? ("verified_learner_role" as const)
        : ("unqualified" as const),
    contributionFunctions: assessment.contributionFunctions,
    atomicIdeaCount: assessment.atomicIdeaCount,
    baselineEventEvidence: observation.eventEvidence,
    candidateUniverse: assessment.candidateUniverse,
    qualification,
    decision: decision.decision,
    decisionMode: decision.decisionMode,
    reasonCode: decision.reasonCode,
    selectedFunction: decision.facilitationFunction,
    workloadCost:
      decision.decision === "draft"
        ? assessment.budget.workloadCost
        : 0,
    authorTouchCount30d: assessment.authorTouchCount30d,
    intent: protocolObjects?.intent ?? null,
    intentHash: protocolObjects?.intentHash ?? null,
    moveSpec: protocolObjects?.moveSpec ?? null,
    moveSpecHash: protocolObjects?.moveSpecHash ?? null,
    draftCreated: transientDraft !== null,
    draftContentHash,
    draftGeneratorVersion: transientDraft
      ? LIVE_DRAFT_GENERATOR_VERSION
      : null,
    draftBodyPersisted: false as const,
    requiresTargetRevalidation: transientDraft !== null,
    realPublishEnabled: false as const,
    publishCapabilityAvailable: false as const,
    containsForumText: false as const,
    ...(teachableEpisodeDirective
      ? {
          teachableEpisodeReceiptHash:
            teachableEpisodeDirective.receiptHash
        }
      : {})
  };
  const opportunityKey = canonicalProtocolHash(
    LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION,
    receiptWithoutKey as CanonicalJsonValue
  );
  const receipt: LiveOpportunityReceipt = {
    ...receiptWithoutKey,
    opportunityKey
  };
  return {
    receipt,
    receiptHash: canonicalProtocolHash(
      receipt.schemaVersion,
      receipt as CanonicalJsonValue
    ),
    transientDraft
  };
}
