import type { Prisma, PrismaClient } from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import type {
  ActiveFacilitationFunction,
  LiveOpportunityDecision,
  LiveOpportunityReasonCode,
  TeachableEpisodeDirective
} from "@/lib/live-runtime/facilitation-kernel";

export const TEACHABLE_EPISODE_RECEIPT_SCHEMA_VERSION =
  "cmooc.teachable-episode-receipt.v1" as const;

export type TeachableEpisodeState =
  | "none"
  | "shadow_proposed_unchanged"
  | "awaiting_learner"
  | "learner_returned"
  | "peer_taken_over"
  | "stalled_closed";

export type TeachableEpisodeAction =
  | "none"
  | "wait"
  | "yield"
  | "close";

export type TeachableEpisodeReasonCode =
  | "no_prior_episode"
  | "prior_episode_integrity_unavailable"
  | "episode_binding_changed"
  | "shadow_draft_unchanged_reused"
  | "teachable_episode_awaiting_learner"
  | "teachable_episode_human_returned"
  | "teachable_episode_peer_taken_over"
  | "teachable_episode_stalled_closed";

export type TeachableEpisodeOutcome = {
  observationWindow: string;
  status: string;
  dueAt: string;
  observedAt: string | null;
  firstExternalReplyAt: string | null;
  authorReturned: boolean | null;
  newAuthorCount: number | null;
  censored: boolean;
  createdAt: string;
};

export type PriorTeachableDecision = {
  decisionKey: string;
  evidenceAsOf: string;
  authorKey: string | null;
  targetVersionHash: string;
  policyVersion: string;
  governanceHash: string | null;
  selectedFunction: ActiveFacilitationFunction | null;
  rendererVersion: string;
  rendererContractVersion: string;
  bodyPersisted: boolean;
  editorWriteAttempted: boolean;
  publishAttempted: boolean;
  confirmedPublishedAt: string | null;
  outcomes: TeachableEpisodeOutcome[];
};

export type TeachableEpisodeCurrent = {
  courseAlias: string;
  threadKey: string;
  authorKey: string | null;
  asOf: string;
  targetVersionHash: string;
  policyVersion: string;
  governanceHash: string | null;
  selectedFunction: ActiveFacilitationFunction | null;
  rendererVersion: string;
  rendererContractVersion: string;
  baseDecision: LiveOpportunityDecision;
  baseReasonCode: LiveOpportunityReasonCode;
};

export type TeachableEpisodeReceipt = {
  schemaVersion: typeof TEACHABLE_EPISODE_RECEIPT_SCHEMA_VERSION;
  courseScopeHash: string;
  threadScopeHash: string;
  asOf: string;
  sourceDecisionKey: string | null;
  state: TeachableEpisodeState;
  action: TeachableEpisodeAction;
  reasonCode: TeachableEpisodeReasonCode;
  bindings: {
    sameAuthor: boolean;
    sameTargetVersion: boolean;
    samePolicyVersion: boolean;
    sameGovernanceHash: boolean;
    sameRendererVersion: boolean;
    sameRendererContract: boolean;
    sameFacilitationFunction: boolean;
  };
  episodeEvidence: {
    confirmedPublished: boolean;
    latestVisibleOutcomeWindow: string | null;
    latestVisibleOutcomeStatus: string | null;
    learnerReturned: boolean;
    peerTakenOver: boolean;
  };
  authorityFootprint: {
    aiAuthorityUses: Array<"ask" | "narrow_focus" | "invite_peer_response">;
    learnerRights: Array<"ignore" | "correct" | "redirect" | "stop">;
    substitutesLearnerJudgment: false;
    humanResponsePriority: true;
    containsForumText: false;
  };
  outcomeInterpretation:
    "descriptive_process_state_not_learning_effect";
  containsForumText: false;
};

export type TeachableEpisodeResolution = {
  receipt: TeachableEpisodeReceipt;
  receiptHash: string;
  directive: TeachableEpisodeDirective | null;
};

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ACTIVE_FUNCTIONS = new Set<ActiveFacilitationFunction>([
  "resource_connection",
  "cognitive_conflict",
  "emotional_support"
]);
const HUMAN_RETURN_REASONS = new Set<LiveOpportunityReasonCode>([
  "original_author_return"
]);
const PEER_TAKEOVER_REASONS = new Set<LiveOpportunityReasonCode>([
  "external_human_response",
  "distinct_actor_response",
  "sequence_socially_complete"
]);
const ACTION_BY_STATE: Record<
  TeachableEpisodeState,
  TeachableEpisodeAction
> = {
  none: "none",
  shadow_proposed_unchanged: "wait",
  awaiting_learner: "wait",
  learner_returned: "yield",
  peer_taken_over: "yield",
  stalled_closed: "close"
};
const REASONS_BY_STATE: Record<
  TeachableEpisodeState,
  ReadonlySet<TeachableEpisodeReasonCode>
> = {
  none: new Set([
    "no_prior_episode",
    "prior_episode_integrity_unavailable",
    "episode_binding_changed"
  ]),
  shadow_proposed_unchanged: new Set([
    "shadow_draft_unchanged_reused"
  ]),
  awaiting_learner: new Set([
    "teachable_episode_awaiting_learner"
  ]),
  learner_returned: new Set([
    "teachable_episode_human_returned"
  ]),
  peer_taken_over: new Set([
    "teachable_episode_peer_taken_over"
  ]),
  stalled_closed: new Set([
    "teachable_episode_stalled_closed"
  ])
};
const AI_AUTHORITY_USES = new Set([
  "ask",
  "narrow_focus",
  "invite_peer_response"
]);
const LEARNER_RIGHTS = new Set([
  "ignore",
  "correct",
  "redirect",
  "stop"
]);
const RECEIPT_KEYS = new Set([
  "schemaVersion",
  "courseScopeHash",
  "threadScopeHash",
  "asOf",
  "sourceDecisionKey",
  "state",
  "action",
  "reasonCode",
  "bindings",
  "episodeEvidence",
  "authorityFootprint",
  "outcomeInterpretation",
  "containsForumText"
]);
const FORBIDDEN_TEXT_KEYS = new Set([
  "body",
  "content",
  "text",
  "raw",
  "title",
  "url",
  "cookie",
  "token",
  "password",
  "threadRef",
  "authorRef",
  "actorRef",
  "courseId"
]);

type TeachablePrisma = PrismaClient | Prisma.TransactionClient;

function recordValue(value: unknown, label: string): Record<string, unknown> {
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
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label}包含未允许字段。`);
  }
}

function assertNoForumTextKeys(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(assertNoForumTextKeys);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_TEXT_KEYS.has(key)) {
      throw new Error(`可教回合回执禁止字段：${key}。`);
    }
    assertNoForumTextKeys(item);
  }
}

function isoTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}必须是有效时间。`);
  }
  return new Date(value).toISOString();
}

function hashValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${label}必须是规范 SHA-256。`);
  }
  return value;
}

function safeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label}格式无效。`);
  }
  return value;
}

function exactStringSet(
  value: unknown,
  expected: ReadonlySet<string>
): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.size &&
    new Set(value).size === expected.size &&
    value.every(
      (item) => typeof item === "string" && expected.has(item)
    )
  );
}

function blankReceipt(input: TeachableEpisodeCurrent): TeachableEpisodeReceipt {
  const asOf = isoTime(input.asOf, "可教回合 as-of");
  return {
    schemaVersion: TEACHABLE_EPISODE_RECEIPT_SCHEMA_VERSION,
    courseScopeHash: canonicalProtocolHash(
      "cmooc.teachable-episode-course-scope.v1",
      { courseAlias: input.courseAlias, containsForumText: false }
    ),
    threadScopeHash: canonicalProtocolHash(
      "cmooc.teachable-episode-thread-scope.v1",
      {
        courseAlias: input.courseAlias,
        threadKey: input.threadKey,
        containsForumText: false
      }
    ),
    asOf,
    sourceDecisionKey: null,
    state: "none",
    action: "none",
    reasonCode: "no_prior_episode",
    bindings: {
      sameAuthor: false,
      sameTargetVersion: false,
      samePolicyVersion: false,
      sameGovernanceHash: false,
      sameRendererVersion: false,
      sameRendererContract: false,
      sameFacilitationFunction: false
    },
    episodeEvidence: {
      confirmedPublished: false,
      latestVisibleOutcomeWindow: null,
      latestVisibleOutcomeStatus: null,
      learnerReturned: false,
      peerTakenOver: false
    },
    authorityFootprint: {
      aiAuthorityUses: ["ask", "narrow_focus", "invite_peer_response"],
      learnerRights: ["ignore", "correct", "redirect", "stop"],
      substitutesLearnerJudgment: false,
      humanResponsePriority: true,
      containsForumText: false
    },
    outcomeInterpretation:
      "descriptive_process_state_not_learning_effect",
    containsForumText: false
  };
}

function seal(receipt: TeachableEpisodeReceipt): TeachableEpisodeResolution {
  const parsed = parseTeachableEpisodeReceipt(receipt);
  const receiptHash = canonicalProtocolHash(
    parsed.schemaVersion,
    parsed as unknown as CanonicalJsonValue
  );
  const reasonByState: Partial<
    Record<TeachableEpisodeState, TeachableEpisodeDirective>
  > = {
    shadow_proposed_unchanged: {
      action: "wait",
      reasonCode: "shadow_draft_unchanged_reused",
      receiptHash
    },
    awaiting_learner: {
      action: "wait",
      reasonCode: "teachable_episode_awaiting_learner",
      receiptHash
    },
    learner_returned: {
      action: "yield",
      reasonCode: "teachable_episode_human_returned",
      receiptHash
    },
    peer_taken_over: {
      action: "yield",
      reasonCode: "teachable_episode_peer_taken_over",
      receiptHash
    },
    stalled_closed: {
      action: "close",
      reasonCode: "teachable_episode_stalled_closed",
      receiptHash
    }
  };
  return {
    receipt: parsed,
    receiptHash,
    directive: reasonByState[parsed.state] ?? null
  };
}

export function projectTeachableEpisode(input: {
  current: TeachableEpisodeCurrent;
  prior: PriorTeachableDecision | null;
}): TeachableEpisodeResolution {
  const receipt = blankReceipt(input.current);
  const prior = input.prior;
  if (!prior) return seal(receipt);

  hashValue(prior.decisionKey, "前序决定键");
  const priorAsOf = isoTime(prior.evidenceAsOf, "前序决定 as-of");
  if (Date.parse(priorAsOf) >= Date.parse(receipt.asOf)) {
    return seal({
      ...receipt,
      sourceDecisionKey: prior.decisionKey,
      reasonCode: "prior_episode_integrity_unavailable"
    });
  }
  const bindings = {
    sameAuthor: prior.authorKey === input.current.authorKey,
    sameTargetVersion:
      prior.targetVersionHash === input.current.targetVersionHash,
    samePolicyVersion:
      prior.policyVersion === input.current.policyVersion,
    sameGovernanceHash:
      prior.governanceHash === input.current.governanceHash,
    sameRendererVersion:
      prior.rendererVersion === input.current.rendererVersion,
    sameRendererContract:
      prior.rendererContractVersion ===
      input.current.rendererContractVersion,
    sameFacilitationFunction:
      prior.selectedFunction === input.current.selectedFunction
  };
  const visibleOutcomes = prior.outcomes
    .filter((outcome) => {
      const createdAt = Date.parse(outcome.createdAt);
      const observedAt = outcome.observedAt
        ? Date.parse(outcome.observedAt)
        : null;
      return (
        Number.isFinite(createdAt) &&
        createdAt <= Date.parse(receipt.asOf) &&
        (observedAt === null || observedAt <= Date.parse(receipt.asOf))
      );
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.observedAt ?? left.createdAt);
      const rightTime = Date.parse(right.observedAt ?? right.createdAt);
      return rightTime - leftTime;
    });
  const latestOutcome = visibleOutcomes[0] ?? null;
  const observedOutcomes = visibleOutcomes.filter(
    (outcome) =>
      outcome.status === "observed" &&
      outcome.observedAt !== null &&
      !outcome.censored
  );
  const learnerReturned = observedOutcomes.some(
    (outcome) => outcome.authorReturned === true
  );
  const peerTakenOver = observedOutcomes.some(
    (outcome) =>
      (outcome.firstExternalReplyAt !== null &&
        Date.parse(outcome.firstExternalReplyAt) <=
          Date.parse(receipt.asOf)) ||
      (outcome.newAuthorCount ?? 0) > 0
  );
  const confirmedPublished =
    prior.confirmedPublishedAt !== null &&
    Number.isFinite(Date.parse(prior.confirmedPublishedAt)) &&
    Date.parse(prior.confirmedPublishedAt) <= Date.parse(receipt.asOf);
  const common = {
    ...receipt,
    sourceDecisionKey: prior.decisionKey,
    bindings,
    episodeEvidence: {
      confirmedPublished,
      latestVisibleOutcomeWindow:
        latestOutcome?.observationWindow ?? null,
      latestVisibleOutcomeStatus: latestOutcome?.status ?? null,
      learnerReturned,
      peerTakenOver
    }
  };

  if (!bindings.sameAuthor || !bindings.sameTargetVersion) {
    return seal({
      ...common,
      reasonCode: "episode_binding_changed"
    });
  }
  if (
    HUMAN_RETURN_REASONS.has(input.current.baseReasonCode) ||
    learnerReturned
  ) {
    return seal({
      ...common,
      state: "learner_returned",
      action: "yield",
      reasonCode: "teachable_episode_human_returned"
    });
  }
  if (
    PEER_TAKEOVER_REASONS.has(input.current.baseReasonCode) ||
    peerTakenOver
  ) {
    return seal({
      ...common,
      state: "peer_taken_over",
      action: "yield",
      reasonCode: "teachable_episode_peer_taken_over"
    });
  }
  if (confirmedPublished) {
    const r72Observed = observedOutcomes.some(
      (outcome) => outcome.observationWindow.toUpperCase() === "R72"
    );
    if (r72Observed) {
      return seal({
        ...common,
        state: "stalled_closed",
        action: "close",
        reasonCode: "teachable_episode_stalled_closed"
      });
    }
    return seal({
      ...common,
      state: "awaiting_learner",
      action: "wait",
      reasonCode: "teachable_episode_awaiting_learner"
    });
  }
  const exactShadowBinding =
    input.current.baseDecision === "draft" &&
    bindings.samePolicyVersion &&
    bindings.sameGovernanceHash &&
    bindings.sameRendererVersion &&
    bindings.sameRendererContract &&
    bindings.sameFacilitationFunction &&
    !prior.bodyPersisted &&
    !prior.editorWriteAttempted &&
    !prior.publishAttempted;
  if (exactShadowBinding) {
    return seal({
      ...common,
      state: "shadow_proposed_unchanged",
      action: "wait",
      reasonCode: "shadow_draft_unchanged_reused"
    });
  }
  return seal({
    ...common,
    reasonCode: "episode_binding_changed"
  });
}

export function parseTeachableEpisodeReceipt(
  value: unknown
): TeachableEpisodeReceipt {
  assertNoForumTextKeys(value);
  const input = recordValue(value, "可教回合回执");
  exactKeys(input, RECEIPT_KEYS, "可教回合回执");
  if (
    input.schemaVersion !== TEACHABLE_EPISODE_RECEIPT_SCHEMA_VERSION ||
    input.containsForumText !== false ||
    input.outcomeInterpretation !==
      "descriptive_process_state_not_learning_effect"
  ) {
    throw new Error("可教回合 schema 或证据边界无效。");
  }
  hashValue(input.courseScopeHash, "课程范围哈希");
  hashValue(input.threadScopeHash, "线程范围哈希");
  isoTime(input.asOf, "可教回合 as-of");
  if (input.sourceDecisionKey !== null) {
    hashValue(input.sourceDecisionKey, "前序决定键");
  }
  const states = new Set<TeachableEpisodeState>([
    "none",
    "shadow_proposed_unchanged",
    "awaiting_learner",
    "learner_returned",
    "peer_taken_over",
    "stalled_closed"
  ]);
  const actions = new Set<TeachableEpisodeAction>([
    "none",
    "wait",
    "yield",
    "close"
  ]);
  if (
    typeof input.state !== "string" ||
    !states.has(input.state as TeachableEpisodeState) ||
    typeof input.action !== "string" ||
    !actions.has(input.action as TeachableEpisodeAction) ||
    typeof input.reasonCode !== "string"
  ) {
    throw new Error("可教回合状态或动作无效。");
  }
  const state = input.state as TeachableEpisodeState;
  const action = input.action as TeachableEpisodeAction;
  const reasonCode = input.reasonCode as TeachableEpisodeReasonCode;
  if (
    action !== ACTION_BY_STATE[state] ||
    !REASONS_BY_STATE[state].has(reasonCode)
  ) {
    throw new Error("可教回合状态、动作与理由不一致。");
  }
  const bindings = recordValue(input.bindings, "可教回合绑定");
  const bindingKeys = [
    "sameAuthor",
    "sameTargetVersion",
    "samePolicyVersion",
    "sameGovernanceHash",
    "sameRendererVersion",
    "sameRendererContract",
    "sameFacilitationFunction"
  ];
  exactKeys(bindings, new Set(bindingKeys), "可教回合绑定");
  if (bindingKeys.some((key) => typeof bindings[key] !== "boolean")) {
    throw new Error("可教回合绑定字段无效。");
  }
  const evidence = recordValue(
    input.episodeEvidence,
    "可教回合证据"
  );
  exactKeys(
    evidence,
    new Set([
      "confirmedPublished",
      "latestVisibleOutcomeWindow",
      "latestVisibleOutcomeStatus",
      "learnerReturned",
      "peerTakenOver"
    ]),
    "可教回合证据"
  );
  if (
    typeof evidence.confirmedPublished !== "boolean" ||
    typeof evidence.learnerReturned !== "boolean" ||
    typeof evidence.peerTakenOver !== "boolean" ||
    (evidence.latestVisibleOutcomeWindow !== null &&
      typeof evidence.latestVisibleOutcomeWindow !== "string") ||
    (evidence.latestVisibleOutcomeStatus !== null &&
      typeof evidence.latestVisibleOutcomeStatus !== "string")
  ) {
    throw new Error("可教回合证据字段无效。");
  }
  const footprint = recordValue(
    input.authorityFootprint,
    "权威足迹"
  );
  exactKeys(
    footprint,
    new Set([
      "aiAuthorityUses",
      "learnerRights",
      "substitutesLearnerJudgment",
      "humanResponsePriority",
      "containsForumText"
    ]),
    "权威足迹"
  );
  if (
    footprint.substitutesLearnerJudgment !== false ||
    footprint.humanResponsePriority !== true ||
    footprint.containsForumText !== false ||
    !exactStringSet(footprint.aiAuthorityUses, AI_AUTHORITY_USES) ||
    !exactStringSet(footprint.learnerRights, LEARNER_RIGHTS)
  ) {
    throw new Error("权威足迹边界无效。");
  }
  return value as TeachableEpisodeReceipt;
}

function parsePriorDecisionSummary(value: string): {
  targetVersionHash: string;
  selectedFunction: ActiveFacilitationFunction | null;
  rendererVersion: string;
  rendererContractVersion: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("TEACHABLE_EPISODE_PRIOR_DECISION_JSON_INVALID");
  }
  const summary = recordValue(parsed, "前序决定摘要");
  if (summary.containsForumText !== false) {
    throw new Error("TEACHABLE_EPISODE_PRIOR_DECISION_BOUNDARY_INVALID");
  }
  const semantic = recordValue(summary.semanticReceipt, "前序语义回执");
  const selectedFunction = summary.selectedFunction;
  if (
    selectedFunction !== null &&
    (typeof selectedFunction !== "string" ||
      !ACTIVE_FUNCTIONS.has(
        selectedFunction as ActiveFacilitationFunction
      ))
  ) {
    throw new Error("TEACHABLE_EPISODE_PRIOR_FUNCTION_INVALID");
  }
  return {
    targetVersionHash: hashValue(
      semantic.targetVersionHash,
      "前序目标版本哈希"
    ),
    selectedFunction:
      selectedFunction as ActiveFacilitationFunction | null,
    rendererVersion: safeIdentifier(
      semantic.rendererVersion,
      "前序渲染器版本"
    ),
    rendererContractVersion: safeIdentifier(
      semantic.contractVersion,
      "前序渲染契约版本"
    )
  };
}

export async function resolveTeachableEpisode(input: {
  prisma: TeachablePrisma;
  current: TeachableEpisodeCurrent;
}): Promise<TeachableEpisodeResolution> {
  const asOf = new Date(isoTime(input.current.asOf, "可教回合 as-of"));
  const prior = await input.prisma.autonomyDecision.findFirst({
    where: {
      courseAlias: input.current.courseAlias,
      threadKey: input.current.threadKey,
      decision: "draft",
      evidenceAsOf: { lt: asOf }
    },
    orderBy: [{ evidenceAsOf: "desc" }, { id: "desc" }],
    include: {
      executionAttempts: {
        where: {
          status: "confirmed_published",
          finishedAt: { lte: asOf }
        },
        orderBy: { finishedAt: "desc" }
      },
      proximalOutcomes: {
        where: { createdAt: { lte: asOf } },
        orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }]
      }
    }
  });
  if (!prior) {
    return projectTeachableEpisode({
      current: input.current,
      prior: null
    });
  }
  let summary: ReturnType<typeof parsePriorDecisionSummary>;
  try {
    summary = parsePriorDecisionSummary(prior.decisionJson);
  } catch {
    const base = blankReceipt(input.current);
    return seal({
      ...base,
      sourceDecisionKey: HASH_PATTERN.test(prior.decisionKey)
        ? prior.decisionKey
        : null,
      reasonCode: "prior_episode_integrity_unavailable"
    });
  }
  const confirmedPublishedAt =
    prior.executionAttempts.find(
      (attempt) => attempt.finishedAt !== null
    )?.finishedAt ?? null;
  return projectTeachableEpisode({
    current: input.current,
    prior: {
      decisionKey: prior.decisionKey,
      evidenceAsOf: prior.evidenceAsOf.toISOString(),
      authorKey: prior.authorKey,
      targetVersionHash: summary.targetVersionHash,
      policyVersion: prior.policyVersion,
      governanceHash: prior.governanceHash,
      selectedFunction: summary.selectedFunction,
      rendererVersion: summary.rendererVersion,
      rendererContractVersion: summary.rendererContractVersion,
      bodyPersisted: prior.bodyPersisted,
      editorWriteAttempted: prior.editorWriteAttempted,
      publishAttempted: prior.publishAttempted,
      confirmedPublishedAt:
        confirmedPublishedAt?.toISOString() ?? null,
      outcomes: prior.proximalOutcomes.map((outcome) => ({
        observationWindow: outcome.observationWindow,
        status: outcome.status,
        dueAt: outcome.dueAt.toISOString(),
        observedAt: outcome.observedAt?.toISOString() ?? null,
        firstExternalReplyAt:
          outcome.firstExternalReplyAt?.toISOString() ?? null,
        authorReturned: outcome.authorReturned,
        newAuthorCount: outcome.newAuthorCount,
        censored: outcome.censored,
        createdAt: outcome.createdAt.toISOString()
      }))
    }
  });
}
