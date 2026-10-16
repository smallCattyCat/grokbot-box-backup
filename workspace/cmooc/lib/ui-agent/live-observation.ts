import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import { normalizeCmoocCourseTargetInput } from "@/lib/forum/normalize-target-input";
import type {
  CmoocDetailObservation,
  CmoocUiReadinessReceipt
} from "@/lib/platform-readiness/cmooc-ui-readiness";
import {
  constantTimeEqualHex,
  loadOrCreateLocalEvidenceSecret,
  localEvidenceHmac
} from "@/lib/privacy/local-evidence-hmac";

export const LIVE_UI_CAPTURE_SCHEMA_VERSION =
  "cmooc.live-ui-capture.v1" as const;
export const LIVE_UI_OBSERVATION_SCHEMA_VERSION =
  "cmooc.live-ui-observation-receipt.v1" as const;

export type LiveUiDriverKind =
  | "chrome_computer_use"
  | "deterministic_browser";

export type LiveUiActionName =
  | "navigate"
  | "observe_course"
  | "select_category"
  | "open_card"
  | "scroll"
  | "reobserve";

export type LiveUiActionOutcome =
  | "verified"
  | "unknown_timeout"
  | "blocked";

export type LiveUiPostcondition =
  | "target_url_verified"
  | "course_shell_present"
  | "category_state_changed"
  | "detail_state_changed"
  | "viewport_changed"
  | "course_state_reobserved";

export type LiveUiActionCapture = {
  sequence: number;
  action: LiveUiActionName;
  outcome: LiveUiActionOutcome;
  postcondition: LiveUiPostcondition;
  postconditionVerified: boolean;
};

export type LiveUiDetailCapture = {
  courseRef: string;
  threadRef: string;
  authorRef: string | null;
  targetVersionHash: string;
  eventCount: number;
  commentCount: number;
  externalCommentCount: number | null;
  selfCommentCount: number | null;
  uniqueExternalAuthorCount: number | null;
  replyEdgeCount: number | null;
  maxReplyDepth: number | null;
  latestEventAt: string | null;
  commentCompleteness:
    | "not_observed"
    | "visible_only"
    | "complete";
  identityBasis:
    | "stable_platform_ref"
    | "display_text_only"
    | "unavailable";
  versionBasis:
    | "explicit_revision"
    | "current_fingerprint"
    | "unavailable";
  events: LiveUiEventCapture[];
};

export type LiveUiEventActorRelation =
  | "thread_author"
  | "external_human"
  | "system_or_agent"
  | "unknown";

export type LiveUiEventRelationBasis =
  | "stable_actor_match"
  | "course_role_registry"
  | "explicit_test_actor_registry"
  | "unavailable";

export type LiveUiEventCapture = {
  eventRef: string;
  actorRef: string | null;
  parentEventRef: string | null;
  createdAt: string;
  actorRelation: LiveUiEventActorRelation;
  actorRelationBasis: LiveUiEventRelationBasis;
};

export type LiveUiEventEvidence = {
  eventKey: string;
  actorKey: string | null;
  parentEventKey: string | null;
  createdAt: string;
  actorRelation: LiveUiEventActorRelation;
  actorRelationBasis: LiveUiEventRelationBasis;
};

export type TrustedSameTabGuardAttestation = {
  guardReceiptHash: string;
  driverSessionRef: string;
  surfaceLocatorHash: string;
  attachedAt: string;
  observedAt: string;
  expiresAt: string;
  sentMutationCount: 0;
};

export type TrustedCourseRoleAttestation = {
  roleReceiptHash: string;
  courseRef: string;
  actorRef: string;
  role: "learner" | "creator" | "helper";
  issuedAt: string;
  expiresAt: string;
};

export type LiveUiCapture = {
  schemaVersion: typeof LIVE_UI_CAPTURE_SCHEMA_VERSION;
  baselineEvidenceHash: string;
  targetInput: string;
  driverKind: LiveUiDriverKind;
  driverSessionRef: string;
  observedAt: string;
  finalUrl: string;
  courseShellDetected: boolean;
  categoryTabCount: number;
  visibleCardCount: number;
  detailObservation: CmoocDetailObservation;
  detail: LiveUiDetailCapture | null;
  actions: LiveUiActionCapture[];
  networkGuardAttached: boolean;
  requestedMutationCount: number;
  blockedMutationCount: number;
  sentMutationCount: number;
  externalWriteAttempted: false;
  containsForumText: false;
};

export type LiveUiObservationReceipt = {
  schemaVersion: typeof LIVE_UI_OBSERVATION_SCHEMA_VERSION;
  baselineEvidenceHash: string;
  observationKey: string;
  driverKind: LiveUiDriverKind;
  driverSessionKey: string;
  attestationLevel:
    | "same_tab_guarded"
    | "same_target_correlated"
    | "deterministic_browser_guarded"
    | "target_only";
  targetLocatorHash: string;
  surfaceLocatorHash: string;
  courseKey: string;
  threadKey: string | null;
  authorKey: string | null;
  authorRole: "learner" | "creator" | "helper" | "unknown";
  authorRoleEvidenceHash: string | null;
  authorRoleEvidenceExpiresAt: string | null;
  observedAt: string;
  evidenceAsOf: string;
  temporalEvidenceStatus:
    | "live_prefix_observed"
    | "as_of_unverified";
  contentRevisionStatus:
    | "live_target_fingerprint_observed"
    | "not_included"
    | "final_export_revision_unknown";
  captureStatus:
    | "structural_observed"
    | "semantic_ready"
    | "source_censored"
    | "blocked";
  safeToAdvanceToSemanticReview: boolean;
  courseShellDetected: boolean;
  categoryTabCount: number;
  visibleCardCount: number;
  detailObservation: CmoocDetailObservation;
  targetVersionHash: string | null;
  eventSetHash: string | null;
  eventEvidence: LiveUiEventEvidence[];
  eventCount: number | null;
  commentCount: number | null;
  externalCommentCount: number | null;
  selfCommentCount: number | null;
  uniqueExternalAuthorCount: number | null;
  replyEdgeCount: number | null;
  maxReplyDepth: number | null;
  latestEventAt: string | null;
  commentCompleteness:
    | "not_observed"
    | "visible_only"
    | "complete";
  identityBasis:
    | "stable_platform_ref"
    | "display_text_only"
    | "unavailable";
  versionBasis:
    | "explicit_revision"
    | "current_fingerprint"
    | "unavailable";
  actions: LiveUiActionCapture[];
  networkGuardAttached: boolean;
  guardReceiptHash: string | null;
  guardObservedAt: string | null;
  guardExpiresAt: string | null;
  requestedMutationCount: number;
  blockedMutationCount: number;
  sentMutationCount: 0;
  realPublishEnabled: false;
  externalWriteAttempted: false;
  containsForumText: false;
};

const CAPTURE_KEYS = new Set([
  "schemaVersion",
  "baselineEvidenceHash",
  "targetInput",
  "driverKind",
  "driverSessionRef",
  "observedAt",
  "finalUrl",
  "courseShellDetected",
  "categoryTabCount",
  "visibleCardCount",
  "detailObservation",
  "detail",
  "actions",
  "networkGuardAttached",
  "requestedMutationCount",
  "blockedMutationCount",
  "sentMutationCount",
  "externalWriteAttempted",
  "containsForumText"
]);

const ACTION_KEYS = new Set([
  "sequence",
  "action",
  "outcome",
  "postcondition",
  "postconditionVerified"
]);

const DETAIL_KEYS = new Set([
  "courseRef",
  "threadRef",
  "authorRef",
  "targetVersionHash",
  "eventCount",
  "commentCount",
  "externalCommentCount",
  "selfCommentCount",
  "uniqueExternalAuthorCount",
  "replyEdgeCount",
  "maxReplyDepth",
  "latestEventAt",
  "commentCompleteness",
  "identityBasis",
  "versionBasis",
  "events"
]);

const EVENT_KEYS = new Set([
  "eventRef",
  "actorRef",
  "parentEventRef",
  "createdAt",
  "actorRelation",
  "actorRelationBasis"
]);

const EVENT_ACTOR_RELATIONS = new Set<LiveUiEventActorRelation>([
  "thread_author",
  "external_human",
  "system_or_agent",
  "unknown"
]);

const EVENT_RELATION_BASES = new Set<LiveUiEventRelationBasis>([
  "stable_actor_match",
  "course_role_registry",
  "explicit_test_actor_registry",
  "unavailable"
]);

const ACTION_NAMES = new Set<LiveUiActionName>([
  "navigate",
  "observe_course",
  "select_category",
  "open_card",
  "scroll",
  "reobserve"
]);

const ACTION_OUTCOMES = new Set<LiveUiActionOutcome>([
  "verified",
  "unknown_timeout",
  "blocked"
]);

const POSTCONDITIONS = new Set<LiveUiPostcondition>([
  "target_url_verified",
  "course_shell_present",
  "category_state_changed",
  "detail_state_changed",
  "viewport_changed",
  "course_state_reobserved"
]);

const DETAIL_OBSERVATIONS = new Set<CmoocDetailObservation>([
  "detail_observed",
  "not_available_public_session",
  "not_attempted_read_only_boundary",
  "interaction_no_transition",
  "interaction_failed",
  "no_cards"
]);

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  const unexpected = Object.keys(value).filter(
    (key) => !allowed.has(key)
  );
  if (unexpected.length > 0) {
    throw new Error(
      `${label}包含未允许字段：${unexpected.sort().join("、")}。`
    );
  }
}

function asObject(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  label: string,
  maxLength = 2048
): string {
  if (typeof value !== "string") {
    throw new Error(`${label}必须是字符串。`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label}不能为空且不能超过 ${maxLength} 个字符。`);
  }
  return normalized;
}

function optionalString(
  value: unknown,
  label: string,
  maxLength = 512
): string | null {
  if (value === null) return null;
  return requiredString(value, label, maxLength);
}

function nonNegativeInteger(
  value: unknown,
  label: string
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`${label}必须是非负整数。`);
  }
  return value;
}

function optionalNonNegativeInteger(
  value: unknown,
  label: string
): number | null {
  return value === null ? null : nonNegativeInteger(value, label);
}

function sha256Hex(value: unknown, label: string): string {
  const normalized = requiredString(value, label, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label}必须是 SHA-256 十六进制摘要。`);
  }
  return normalized;
}

function validIsoTime(value: unknown, label: string): string {
  const normalized = requiredString(value, label, 80);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${label}必须是有效时间。`);
  }
  return new Date(normalized).toISOString();
}

function parseAction(
  value: unknown,
  expectedSequence: number
): LiveUiActionCapture {
  const action = asObject(value, "动作回执");
  assertExactKeys(action, ACTION_KEYS, "动作回执");
  const sequence = nonNegativeInteger(action.sequence, "动作序号");
  if (sequence !== expectedSequence) {
    throw new Error("动作回执必须从 1 开始连续编号。");
  }
  if (
    typeof action.action !== "string" ||
    !ACTION_NAMES.has(action.action as LiveUiActionName)
  ) {
    throw new Error("动作类型不在只读白名单中。");
  }
  if (
    typeof action.outcome !== "string" ||
    !ACTION_OUTCOMES.has(action.outcome as LiveUiActionOutcome)
  ) {
    throw new Error("动作结果无效。");
  }
  if (
    typeof action.postcondition !== "string" ||
    !POSTCONDITIONS.has(
      action.postcondition as LiveUiPostcondition
    )
  ) {
    throw new Error("动作后置条件无效。");
  }
  if (typeof action.postconditionVerified !== "boolean") {
    throw new Error("动作后置条件核验结果必须是布尔值。");
  }
  if (
    action.outcome === "verified" &&
    action.postconditionVerified !== true
  ) {
    throw new Error("标记为 verified 的动作必须核验后置条件。");
  }
  return {
    sequence,
    action: action.action as LiveUiActionName,
    outcome: action.outcome as LiveUiActionOutcome,
    postcondition: action.postcondition as LiveUiPostcondition,
    postconditionVerified: action.postconditionVerified
  };
}

function parseDetail(value: unknown): LiveUiDetailCapture | null {
  if (value === null) return null;
  const detail = asObject(value, "详情观察");
  assertExactKeys(detail, DETAIL_KEYS, "详情观察");
  const latestEventAt =
    detail.latestEventAt === null
      ? null
      : validIsoTime(detail.latestEventAt, "最新事件时间");
  if (
    detail.commentCompleteness !== "not_observed" &&
    detail.commentCompleteness !== "visible_only" &&
    detail.commentCompleteness !== "complete"
  ) {
    throw new Error("评论完整性状态无效。");
  }
  if (
    detail.identityBasis !== "stable_platform_ref" &&
    detail.identityBasis !== "display_text_only" &&
    detail.identityBasis !== "unavailable"
  ) {
    throw new Error("身份依据状态无效。");
  }
  if (
    detail.versionBasis !== "explicit_revision" &&
    detail.versionBasis !== "current_fingerprint" &&
    detail.versionBasis !== "unavailable"
  ) {
    throw new Error("版本依据状态无效。");
  }
  if (!Array.isArray(detail.events) || detail.events.length > 500) {
    throw new Error("事件证据必须是最多 500 项的数组。");
  }
  const events = detail.events.map((value, index): LiveUiEventCapture => {
    const event = asObject(value, `事件证据 ${index + 1}`);
    assertExactKeys(event, EVENT_KEYS, `事件证据 ${index + 1}`);
    if (
      typeof event.actorRelation !== "string" ||
      !EVENT_ACTOR_RELATIONS.has(
        event.actorRelation as LiveUiEventActorRelation
      )
    ) {
      throw new Error(`事件证据 ${index + 1} 的参与者关系无效。`);
    }
    if (
      typeof event.actorRelationBasis !== "string" ||
      !EVENT_RELATION_BASES.has(
        event.actorRelationBasis as LiveUiEventRelationBasis
      )
    ) {
      throw new Error(
        `事件证据 ${index + 1} 的参与者关系依据无效。`
      );
    }
    return {
      eventRef: requiredString(
        event.eventRef,
        `事件证据 ${index + 1} 的平台引用`,
        512
      ),
      actorRef: optionalString(
        event.actorRef,
        `事件证据 ${index + 1} 的参与者引用`,
        512
      ),
      parentEventRef: optionalString(
        event.parentEventRef,
        `事件证据 ${index + 1} 的父事件引用`,
        512
      ),
      createdAt: validIsoTime(
        event.createdAt,
        `事件证据 ${index + 1} 的时间`
      ),
      actorRelation:
        event.actorRelation as LiveUiEventActorRelation,
      actorRelationBasis:
        event.actorRelationBasis as LiveUiEventRelationBasis
    };
  });
  if (new Set(events.map((event) => event.eventRef)).size !== events.length) {
    throw new Error("事件平台引用不得重复。");
  }
  const parsed: LiveUiDetailCapture = {
    courseRef: requiredString(
      detail.courseRef,
      "详情课程平台引用",
      512
    ),
    threadRef: requiredString(
      detail.threadRef,
      "线程平台引用",
      512
    ),
    authorRef: optionalString(
      detail.authorRef,
      "作者平台引用",
      512
    ),
    targetVersionHash: sha256Hex(
      detail.targetVersionHash,
      "目标版本摘要"
    ),
    eventCount: nonNegativeInteger(
      detail.eventCount,
      "事件数量"
    ),
    commentCount: nonNegativeInteger(
      detail.commentCount,
      "评论数量"
    ),
    externalCommentCount: optionalNonNegativeInteger(
      detail.externalCommentCount,
      "外部评论数量"
    ),
    selfCommentCount: optionalNonNegativeInteger(
      detail.selfCommentCount,
      "作者自评数量"
    ),
    uniqueExternalAuthorCount: optionalNonNegativeInteger(
      detail.uniqueExternalAuthorCount,
      "外部作者数量"
    ),
    replyEdgeCount: optionalNonNegativeInteger(
      detail.replyEdgeCount,
      "回复边数量"
    ),
    maxReplyDepth: optionalNonNegativeInteger(
      detail.maxReplyDepth,
      "最大回复深度"
    ),
    latestEventAt,
    commentCompleteness:
      detail.commentCompleteness as LiveUiDetailCapture["commentCompleteness"],
    identityBasis:
      detail.identityBasis as LiveUiDetailCapture["identityBasis"],
    versionBasis:
      detail.versionBasis as LiveUiDetailCapture["versionBasis"],
    events
  };
  if (parsed.eventCount !== parsed.commentCount + 1) {
    throw new Error("事件数量必须等于根贡献加评论数量。");
  }
  if (parsed.events.length !== parsed.eventCount) {
    throw new Error("事件证据数量必须等于事件总数。");
  }
  const rootEvents = parsed.events.filter(
    (event) => event.parentEventRef === null
  );
  if (
    rootEvents.length !== 1 ||
    rootEvents[0]?.eventRef !== parsed.threadRef ||
    rootEvents[0]?.actorRelation !== "thread_author" ||
    rootEvents[0]?.actorRelationBasis !== "stable_actor_match" ||
    (parsed.authorRef !== null &&
      rootEvents[0]?.actorRef !== parsed.authorRef)
  ) {
    throw new Error("事件证据必须包含与线程和作者一致的唯一根贡献。");
  }
  const commentEvents = parsed.events.filter(
    (event) => event.parentEventRef !== null
  );
  if (commentEvents.length !== parsed.commentCount) {
    throw new Error("评论事件数量必须与评论总数一致。");
  }
  const externalEvents = commentEvents.filter(
    (event) => event.actorRelation === "external_human"
  );
  const selfEvents = commentEvents.filter(
    (event) => event.actorRelation === "thread_author"
  );
  for (const event of parsed.events) {
    if (
      (event.actorRelation === "unknown") !==
      (event.actorRelationBasis === "unavailable")
    ) {
      throw new Error("未知参与者关系必须与不可用依据同时出现。");
    }
    if (
      event.actorRelation === "thread_author" &&
      (event.actorRelationBasis !== "stable_actor_match" ||
        parsed.authorRef === null ||
        event.actorRef !== parsed.authorRef)
    ) {
      throw new Error("线程作者关系必须由稳定作者引用直接核对。");
    }
    if (
      event.actorRelation === "external_human" &&
      (event.actorRef === null ||
        event.actorRef === parsed.authorRef ||
        (event.actorRelationBasis !== "course_role_registry" &&
          event.actorRelationBasis !==
            "explicit_test_actor_registry"))
    ) {
      throw new Error("外部真人关系缺少独立参与者与角色登记依据。");
    }
    if (
      event.actorRelation === "system_or_agent" &&
      (event.actorRef === null ||
        event.actorRef === parsed.authorRef ||
        (event.actorRelationBasis !== "course_role_registry" &&
          event.actorRelationBasis !==
            "explicit_test_actor_registry"))
    ) {
      throw new Error("系统或智能体关系缺少角色登记依据。");
    }
  }
  if (
    parsed.externalCommentCount !== null &&
    externalEvents.length !== parsed.externalCommentCount
  ) {
    throw new Error("外部评论数量必须与事件证据一致。");
  }
  if (
    parsed.selfCommentCount !== null &&
    selfEvents.length !== parsed.selfCommentCount
  ) {
    throw new Error("作者自评数量必须与事件证据一致。");
  }
  if (
    parsed.uniqueExternalAuthorCount !== null &&
    new Set(
      externalEvents
        .map((event) => event.actorRef)
        .filter((value): value is string => value !== null)
    ).size !== parsed.uniqueExternalAuthorCount
  ) {
    throw new Error("外部作者数量必须与事件证据一致。");
  }
  if (
    parsed.externalCommentCount !== null &&
    parsed.selfCommentCount !== null &&
    parsed.externalCommentCount + parsed.selfCommentCount >
      parsed.commentCount
  ) {
    throw new Error("外部评论与作者自评数量不能超过评论总数。");
  }
  if (
    parsed.uniqueExternalAuthorCount !== null &&
    parsed.externalCommentCount !== null &&
    parsed.uniqueExternalAuthorCount > parsed.externalCommentCount
  ) {
    throw new Error("外部作者数量不能超过外部评论数量。");
  }
  if (
    parsed.replyEdgeCount !== null &&
    parsed.replyEdgeCount > parsed.commentCount
  ) {
    throw new Error("回复边数量不能超过评论数量。");
  }
  if (parsed.commentCompleteness === "complete") {
    const byRef = new Map(
      parsed.events.map((event) => [event.eventRef, event])
    );
    for (const event of commentEvents) {
      const parent = byRef.get(event.parentEventRef ?? "");
      if (!parent) {
        throw new Error("完整评论树不能包含未解析的父事件。");
      }
      if (Date.parse(parent.createdAt) > Date.parse(event.createdAt)) {
        throw new Error("父事件时间不得晚于子事件。");
      }
    }
    const depths = new Map<string, number>();
    const resolveDepth = (
      eventRef: string,
      trail = new Set<string>()
    ): number => {
      const cached = depths.get(eventRef);
      if (cached !== undefined) return cached;
      if (trail.has(eventRef)) {
        throw new Error("评论树不能包含循环父子关系。");
      }
      const event = byRef.get(eventRef);
      if (!event) {
        throw new Error("评论树引用了不存在的事件。");
      }
      if (event.parentEventRef === null) {
        depths.set(eventRef, 0);
        return 0;
      }
      const nextTrail = new Set(trail);
      nextTrail.add(eventRef);
      const depth =
        resolveDepth(event.parentEventRef, nextTrail) + 1;
      depths.set(eventRef, depth);
      return depth;
    };
    const observedMaxDepth = Math.max(
      ...parsed.events.map((event) =>
        resolveDepth(event.eventRef)
      )
    );
    if (
      parsed.replyEdgeCount !== parsed.commentCount ||
      parsed.maxReplyDepth !== observedMaxDepth
    ) {
      throw new Error("完整评论树的回复边或最大深度与事件证据不一致。");
    }
  }
  const latestEventInEvidence = [...parsed.events]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
    ?.createdAt;
  if (
    !latestEventInEvidence ||
    parsed.latestEventAt === null ||
    Date.parse(latestEventInEvidence) !==
      Date.parse(parsed.latestEventAt)
  ) {
    throw new Error("最新事件时间必须与事件证据一致。");
  }
  return parsed;
}

export function parseLiveUiCapture(value: unknown): LiveUiCapture {
  const capture = asObject(value, "真实界面观察");
  assertExactKeys(capture, CAPTURE_KEYS, "真实界面观察");
  if (capture.schemaVersion !== LIVE_UI_CAPTURE_SCHEMA_VERSION) {
    throw new Error("真实界面观察 schema 无效。");
  }
  const driverKind = capture.driverKind;
  if (
    driverKind !== "chrome_computer_use" &&
    driverKind !== "deterministic_browser"
  ) {
    throw new Error("真实界面观察驱动类型无效。");
  }
  if (
    typeof capture.detailObservation !== "string" ||
    !DETAIL_OBSERVATIONS.has(
      capture.detailObservation as CmoocDetailObservation
    )
  ) {
    throw new Error("详情观察状态无效。");
  }
  if (!Array.isArray(capture.actions) || capture.actions.length > 20) {
    throw new Error("动作回执必须是最多 20 项的数组。");
  }
  const actions = capture.actions.map((action, index) =>
    parseAction(action, index + 1)
  );
  const detail = parseDetail(capture.detail);
  if (
    capture.detailObservation === "detail_observed" &&
    detail === null
  ) {
    throw new Error("详情已观察时必须提供去正文详情计数与摘要。");
  }
  if (
    capture.detailObservation !== "detail_observed" &&
    detail !== null
  ) {
    throw new Error("详情未观察时不能提交详情证据。");
  }
  if (
    detail &&
    detail.events.some(
      (event) =>
        Date.parse(event.createdAt) > Date.parse(String(capture.observedAt))
    )
  ) {
    throw new Error("事件时间不得晚于观察时间。");
  }
  if (
    typeof capture.courseShellDetected !== "boolean" ||
    typeof capture.networkGuardAttached !== "boolean" ||
    capture.externalWriteAttempted !== false ||
    capture.containsForumText !== false
  ) {
    throw new Error("真实界面观察越过了只读或去正文边界。");
  }
  const requestedMutationCount = nonNegativeInteger(
    capture.requestedMutationCount,
    "请求变更数量"
  );
  const blockedMutationCount = nonNegativeInteger(
    capture.blockedMutationCount,
    "阻断变更数量"
  );
  const sentMutationCount = nonNegativeInteger(
    capture.sentMutationCount,
    "已发送变更数量"
  );
  if (
    blockedMutationCount + sentMutationCount >
      requestedMutationCount ||
    sentMutationCount !== 0
  ) {
    throw new Error("真实界面观察不是零写运行，拒绝封存。");
  }
  return {
    schemaVersion: LIVE_UI_CAPTURE_SCHEMA_VERSION,
    baselineEvidenceHash: sha256Hex(
      capture.baselineEvidenceHash,
      "基线证据哈希"
    ),
    targetInput: requiredString(
      capture.targetInput,
      "课程目标",
      4096
    ),
    driverKind,
    driverSessionRef: requiredString(
      capture.driverSessionRef,
      "驱动会话引用",
      200
    ),
    observedAt: validIsoTime(capture.observedAt, "观察时间"),
    finalUrl: requiredString(capture.finalUrl, "最终页面地址", 4096),
    courseShellDetected: capture.courseShellDetected,
    categoryTabCount: nonNegativeInteger(
      capture.categoryTabCount,
      "分区数量"
    ),
    visibleCardCount: nonNegativeInteger(
      capture.visibleCardCount,
      "可见卡片数量"
    ),
    detailObservation:
      capture.detailObservation as CmoocDetailObservation,
    detail,
    actions,
    networkGuardAttached: capture.networkGuardAttached,
    requestedMutationCount,
    blockedMutationCount,
    sentMutationCount,
    externalWriteAttempted: false,
    containsForumText: false
  };
}

function sameCourseTarget(
  canonicalTarget: string,
  finalUrlValue: string,
  detail: LiveUiDetailCapture | null
): boolean {
  let target: URL;
  let finalUrl: URL;
  try {
    target = new URL(canonicalTarget);
    finalUrl = new URL(finalUrlValue);
  } catch {
    return false;
  }
  const sameOriginAndTransport =
    target.protocol === "https:" &&
    target.username === "" &&
    target.password === "" &&
    finalUrl.protocol === "https:" &&
    finalUrl.username === "" &&
    finalUrl.password === "" &&
    target.origin === finalUrl.origin;
  const courseId = target.searchParams.get("courseId");
  if (!sameOriginAndTransport || !courseId) return false;
  if (/^\/cMOOC\/course\/?$/i.test(finalUrl.pathname)) {
    return courseId === finalUrl.searchParams.get("courseId");
  }
  return Boolean(
    detail &&
      /^\/cMOOC\/detail\/?$/i.test(finalUrl.pathname) &&
      detail.courseRef === courseId &&
      finalUrl.searchParams.get("id") === detail.threadRef
  );
}

export function liveUiSurfaceLocatorHash(urlValue: string): string {
  const url = new URL(urlValue);
  url.hash = "";
  return canonicalProtocolHash(
    "cmooc.ui-surface-locator.v1",
    url.toString()
  );
}

function verifyTrustedGuardAttestation(input: {
  capture: LiveUiCapture;
  surfaceLocatorHash: string;
  attestation?: TrustedSameTabGuardAttestation;
}): TrustedSameTabGuardAttestation | null {
  const attestation = input.attestation;
  if (!attestation) return null;
  const attachedAt = validIsoTime(
    attestation.attachedAt,
    "守卫挂载时间"
  );
  const observedAt = validIsoTime(
    attestation.observedAt,
    "守卫观察时间"
  );
  const expiresAt = validIsoTime(
    attestation.expiresAt,
    "守卫失效时间"
  );
  if (
    !input.capture.networkGuardAttached ||
    attestation.driverSessionRef !==
      input.capture.driverSessionRef ||
    attestation.surfaceLocatorHash !==
      input.surfaceLocatorHash ||
    attestation.sentMutationCount !== 0 ||
    Date.parse(attachedAt) >
      Date.parse(input.capture.observedAt) ||
    Date.parse(observedAt) <
      Date.parse(input.capture.observedAt) ||
    Date.parse(observedAt) > Date.parse(expiresAt)
  ) {
    throw new Error("受信同标签页守卫与当前观察会话不一致。");
  }
  return {
    guardReceiptHash: sha256Hex(
      attestation.guardReceiptHash,
      "守卫回执哈希"
    ),
    driverSessionRef: requiredString(
      attestation.driverSessionRef,
      "守卫驱动会话",
      200
    ),
    surfaceLocatorHash: sha256Hex(
      attestation.surfaceLocatorHash,
      "守卫页面定位哈希"
    ),
    attachedAt,
    observedAt,
    expiresAt,
    sentMutationCount: 0
  };
}

function verifyTrustedCourseRoleAttestation(input: {
  capture: LiveUiCapture;
  attestation?: TrustedCourseRoleAttestation;
}): TrustedCourseRoleAttestation | null {
  const attestation = input.attestation;
  if (!attestation) return null;
  const detail = input.capture.detail;
  if (!detail?.authorRef) {
    throw new Error("课程角色许可缺少可绑定的目标作者。");
  }
  const issuedAt = validIsoTime(
    attestation.issuedAt,
    "课程角色许可签发时间"
  );
  const expiresAt = validIsoTime(
    attestation.expiresAt,
    "课程角色许可失效时间"
  );
  const observedAt = Date.parse(input.capture.observedAt);
  if (
    attestation.courseRef !== detail.courseRef ||
    attestation.actorRef !== detail.authorRef ||
    !["learner", "creator", "helper"].includes(attestation.role) ||
    Date.parse(issuedAt) > observedAt ||
    observedAt > Date.parse(expiresAt)
  ) {
    throw new Error("课程角色许可与当前课程、作者或观察时间不一致。");
  }
  return {
    roleReceiptHash: sha256Hex(
      attestation.roleReceiptHash,
      "课程角色许可回执哈希"
    ),
    courseRef: requiredString(
      attestation.courseRef,
      "课程角色许可课程引用",
      200
    ),
    actorRef: requiredString(
      attestation.actorRef,
      "课程角色许可作者引用",
      200
    ),
    role: attestation.role,
    issuedAt,
    expiresAt
  };
}

function semanticEvidenceReady(
  capture: LiveUiCapture,
  trustedGuard: TrustedSameTabGuardAttestation | null,
  trustedRole: TrustedCourseRoleAttestation | null
): boolean {
  const detail = capture.detail;
  return Boolean(
    capture.courseShellDetected &&
      capture.detailObservation === "detail_observed" &&
      detail &&
      detail.identityBasis === "stable_platform_ref" &&
      detail.versionBasis !== "unavailable" &&
      detail.commentCompleteness === "complete" &&
      detail.events.length === detail.eventCount &&
      detail.events.every(
        (event) =>
          event.actorRelation !== "unknown" &&
          event.actorRelationBasis !== "unavailable" &&
          event.actorRef !== null
      ) &&
      trustedGuard &&
      trustedRole &&
      capture.sentMutationCount === 0 &&
      capture.actions.some(
        (action) =>
          action.action === "open_card" &&
          action.outcome === "verified" &&
          action.postcondition === "detail_state_changed" &&
          action.postconditionVerified
      )
  );
}

export function sealLiveUiCapture(input: {
  capture: LiveUiCapture;
  baseline: {
    evidenceHash: string;
    receipt: CmoocUiReadinessReceipt;
  };
  secret: Buffer | string;
  trustedGuardAttestation?: TrustedSameTabGuardAttestation;
  trustedRoleAttestation?: TrustedCourseRoleAttestation;
}): {
  receipt: LiveUiObservationReceipt;
  receiptHash: string;
} {
  const capture = input.capture;
  if (capture.baselineEvidenceHash !== input.baseline.evidenceHash) {
    throw new Error("真实界面观察引用了不同的基线回执。");
  }
  if (
    Date.parse(capture.observedAt) <
    Date.parse(input.baseline.receipt.observedAt)
  ) {
    throw new Error("真实界面观察时间早于所引用的基线回执。");
  }
  const normalizedTarget = normalizeCmoocCourseTargetInput(
    capture.targetInput
  );
  const targetLocatorHash = canonicalProtocolHash(
    "cmooc.ui-target-locator.v1",
    normalizedTarget.url
  );
  const surfaceLocatorHash = liveUiSurfaceLocatorHash(
    capture.finalUrl
  );
  if (
    targetLocatorHash !== input.baseline.receipt.targetLocatorHash ||
    !sameCourseTarget(
      normalizedTarget.url,
      capture.finalUrl,
      capture.detail
    )
  ) {
    throw new Error(
      "真实界面观察的最终课程与基线 courseId 不一致。"
    );
  }
  if (
    !capture.actions.some(
      (action) =>
        action.action === "navigate" &&
        action.outcome === "verified" &&
        action.postcondition === "target_url_verified" &&
        action.postconditionVerified
    )
  ) {
    throw new Error("真实界面观察缺少已核验的页面身份动作。");
  }

  const target = new URL(normalizedTarget.url);
  const courseId = target.searchParams.get("courseId");
  if (!courseId) {
    throw new Error("真实界面观察缺少课程标识。");
  }
  const detailThreadKey = capture.detail
    ? localEvidenceHmac({
        secret: input.secret,
        scope: "thread-ref-v1",
        value: `${courseId}\0${capture.detail.threadRef}`
      })
    : null;
  const finalSurface = new URL(capture.finalUrl);
  if (
    capture.detail &&
    /^\/cMOOC\/course\/?$/i.test(finalSurface.pathname) &&
    (input.baseline.receipt.selectedThreadKey === null ||
      input.baseline.receipt.selectedThreadKey !==
        detailThreadKey)
  ) {
    throw new Error(
      "课程页详情证据没有绑定到基线中已选择的帖子。"
    );
  }
  const trustedGuard = verifyTrustedGuardAttestation({
    capture,
    surfaceLocatorHash,
    attestation: input.trustedGuardAttestation
  });
  const trustedRole = verifyTrustedCourseRoleAttestation({
    capture,
    attestation: input.trustedRoleAttestation
  });
  const safeToAdvanceToSemanticReview =
    semanticEvidenceReady(capture, trustedGuard, trustedRole);
  const actionHasUnknownOutcome = capture.actions.some(
    (action) => action.outcome !== "verified"
  );
  const captureStatus: LiveUiObservationReceipt["captureStatus"] =
    !capture.courseShellDetected
      ? "blocked"
      : actionHasUnknownOutcome
        ? "source_censored"
        : safeToAdvanceToSemanticReview
          ? "semantic_ready"
          : "structural_observed";
  const attestationLevel: LiveUiObservationReceipt["attestationLevel"] =
    capture.driverKind === "chrome_computer_use"
      ? trustedGuard
        ? "same_tab_guarded"
        : "same_target_correlated"
      : trustedGuard
        ? "deterministic_browser_guarded"
        : "target_only";
  const detail = capture.detail;
  const eventEvidence: LiveUiEventEvidence[] = detail
    ? detail.events
        .map((event) => ({
          eventKey: localEvidenceHmac({
            secret: input.secret,
            scope: "forum-event-ref-v1",
            value: `${courseId}\0${detail.threadRef}\0${event.eventRef}`
          }),
          actorKey: event.actorRef
            ? localEvidenceHmac({
                secret: input.secret,
                scope: "forum-actor-ref-v1",
                value: `${courseId}\0${event.actorRef}`
              })
            : null,
          parentEventKey: event.parentEventRef
            ? localEvidenceHmac({
                secret: input.secret,
                scope: "forum-event-ref-v1",
                value: `${courseId}\0${detail.threadRef}\0${event.parentEventRef}`
              })
            : null,
          createdAt: event.createdAt,
          actorRelation: event.actorRelation,
          actorRelationBasis: event.actorRelationBasis
        }))
        .sort(
          (a, b) =>
            Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
            a.eventKey.localeCompare(b.eventKey)
        )
    : [];
  const sealedEventSetHash =
    eventEvidence.length > 0
      ? canonicalProtocolHash(
          "cmooc.live-event-evidence-set.v1",
          {
            schemaVersion: "cmooc.live-event-evidence-set.v1",
            events: eventEvidence
          } as CanonicalJsonValue
        )
      : null;
  const receiptWithoutKey: Omit<
    LiveUiObservationReceipt,
    "observationKey"
  > = {
    schemaVersion: LIVE_UI_OBSERVATION_SCHEMA_VERSION,
    baselineEvidenceHash: input.baseline.evidenceHash,
    driverKind: capture.driverKind,
    driverSessionKey: localEvidenceHmac({
      secret: input.secret,
      scope: "ui-driver-session-v1",
      value: capture.driverSessionRef
    }),
    attestationLevel,
    targetLocatorHash,
    surfaceLocatorHash,
    courseKey: localEvidenceHmac({
      secret: input.secret,
      scope: "course-ref-v1",
      value: courseId
    }),
    threadKey:
      detailThreadKey ?? input.baseline.receipt.selectedThreadKey,
    authorKey: detail?.authorRef
      ? localEvidenceHmac({
          secret: input.secret,
          scope: "author-ref-v1",
          value: `${courseId}\0${detail.authorRef}`
        })
      : null,
    authorRole: trustedRole?.role ?? "unknown",
    authorRoleEvidenceHash:
      trustedRole?.roleReceiptHash ?? null,
    authorRoleEvidenceExpiresAt:
      trustedRole?.expiresAt ?? null,
    observedAt: capture.observedAt,
    evidenceAsOf: capture.observedAt,
    temporalEvidenceStatus: safeToAdvanceToSemanticReview
      ? "live_prefix_observed"
      : "as_of_unverified",
    contentRevisionStatus: safeToAdvanceToSemanticReview
      ? "live_target_fingerprint_observed"
      : detail
        ? "final_export_revision_unknown"
        : "not_included",
    captureStatus,
    safeToAdvanceToSemanticReview,
    courseShellDetected: capture.courseShellDetected,
    categoryTabCount: capture.categoryTabCount,
    visibleCardCount: capture.visibleCardCount,
    detailObservation: capture.detailObservation,
    targetVersionHash: detail?.targetVersionHash ?? null,
    eventSetHash: sealedEventSetHash,
    eventEvidence,
    eventCount: detail?.eventCount ?? null,
    commentCount: detail?.commentCount ?? null,
    externalCommentCount: detail?.externalCommentCount ?? null,
    selfCommentCount: detail?.selfCommentCount ?? null,
    uniqueExternalAuthorCount:
      detail?.uniqueExternalAuthorCount ?? null,
    replyEdgeCount: detail?.replyEdgeCount ?? null,
    maxReplyDepth: detail?.maxReplyDepth ?? null,
    latestEventAt: detail?.latestEventAt ?? null,
    commentCompleteness:
      detail?.commentCompleteness ?? "not_observed",
    identityBasis: detail?.identityBasis ?? "unavailable",
    versionBasis: detail?.versionBasis ?? "unavailable",
    actions: capture.actions,
    networkGuardAttached: trustedGuard !== null,
    guardReceiptHash: trustedGuard?.guardReceiptHash ?? null,
    guardObservedAt: trustedGuard?.observedAt ?? null,
    guardExpiresAt: trustedGuard?.expiresAt ?? null,
    requestedMutationCount: capture.requestedMutationCount,
    blockedMutationCount: capture.blockedMutationCount,
    sentMutationCount: 0,
    realPublishEnabled: false,
    externalWriteAttempted: false,
    containsForumText: false
  };
  const observationKey = canonicalProtocolHash(
    LIVE_UI_OBSERVATION_SCHEMA_VERSION,
    receiptWithoutKey as CanonicalJsonValue
  );
  const receipt: LiveUiObservationReceipt = {
    ...receiptWithoutKey,
    observationKey
  };
  return {
    receipt,
    receiptHash: canonicalProtocolHash(
      receipt.schemaVersion,
      receipt as CanonicalJsonValue
    )
  };
}

export function liveObservationOutputRoot(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error(
      "未设置 LOCALAPPDATA，无法保存真实界面观察回执。"
    );
  }
  return path.resolve(
    localAppData,
    "cmooc-research",
    "live-ui-observations-v1"
  );
}

export async function persistLiveUiObservation(input: {
  receipt: LiveUiObservationReceipt;
  receiptHash: string;
  outputRoot?: string;
}): Promise<string> {
  normalizeStoredReceipt(input.receipt);
  const computedReceiptHash = canonicalProtocolHash(
    input.receipt.schemaVersion,
    input.receipt as CanonicalJsonValue
  );
  if (
    !constantTimeEqualHex(computedReceiptHash, input.receiptHash)
  ) {
    throw new Error("真实界面观察回执哈希与内容不一致。");
  }
  if (
    input.receipt.containsForumText ||
    input.receipt.externalWriteAttempted ||
    input.receipt.realPublishEnabled ||
    input.receipt.sentMutationCount !== 0
  ) {
    throw new Error("拒绝保存越过只读、零写或去正文边界的观察回执。");
  }
  const outputRoot = path.resolve(
    input.outputRoot ?? liveObservationOutputRoot()
  );
  await mkdir(outputRoot, { recursive: true });
  const receiptPath = path.join(
    outputRoot,
    `${input.receiptHash}.json`
  );
  await writeFile(
    receiptPath,
    `${JSON.stringify(input.receipt, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" }
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  return receiptPath;
}

export async function sealAndPersistLiveUiCapture(input: {
  capture: LiveUiCapture;
  baseline: {
    evidenceHash: string;
    receipt: CmoocUiReadinessReceipt;
  };
  trustedGuardAttestation?: TrustedSameTabGuardAttestation;
  trustedRoleAttestation?: TrustedCourseRoleAttestation;
}): Promise<{
  receipt: LiveUiObservationReceipt;
  receiptHash: string;
  receiptPath: string;
}> {
  const secret = await loadOrCreateLocalEvidenceSecret();
  const sealed = sealLiveUiCapture({
    ...input,
    secret
  });
  return {
    ...sealed,
    receiptPath: await persistLiveUiObservation(sealed)
  };
}

function normalizeStoredReceipt(
  value: unknown
): LiveUiObservationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("真实界面观察回执不是对象。");
  }
  const receipt = value as Partial<LiveUiObservationReceipt>;
  const authorRoleValid =
    receipt.authorRole === "unknown" ||
    receipt.authorRole === "learner" ||
    receipt.authorRole === "creator" ||
    receipt.authorRole === "helper";
  const qualifiedRoleEvidenceValid =
    receipt.authorRole === "unknown"
      ? receipt.authorRoleEvidenceHash === null &&
        receipt.authorRoleEvidenceExpiresAt === null
      : typeof receipt.authorRoleEvidenceHash === "string" &&
        /^[a-f0-9]{64}$/i.test(receipt.authorRoleEvidenceHash) &&
        typeof receipt.authorRoleEvidenceExpiresAt === "string" &&
        Number.isFinite(
          Date.parse(receipt.authorRoleEvidenceExpiresAt)
        );
  const guardLeaseValid =
    receipt.networkGuardAttached === true
      ? typeof receipt.guardReceiptHash === "string" &&
        /^[a-f0-9]{64}$/i.test(receipt.guardReceiptHash) &&
        typeof receipt.guardObservedAt === "string" &&
        Number.isFinite(Date.parse(receipt.guardObservedAt)) &&
        typeof receipt.guardExpiresAt === "string" &&
        Number.isFinite(Date.parse(receipt.guardExpiresAt)) &&
        Date.parse(receipt.guardObservedAt) <=
          Date.parse(receipt.guardExpiresAt)
      : receipt.guardReceiptHash === null &&
        receipt.guardObservedAt === null &&
        receipt.guardExpiresAt === null;
  if (
    receipt.schemaVersion !== LIVE_UI_OBSERVATION_SCHEMA_VERSION ||
    receipt.containsForumText !== false ||
    receipt.externalWriteAttempted !== false ||
    receipt.realPublishEnabled !== false ||
    receipt.sentMutationCount !== 0 ||
    !Array.isArray(receipt.eventEvidence) ||
    !authorRoleValid ||
    !qualifiedRoleEvidenceValid ||
    !guardLeaseValid ||
    typeof receipt.baselineEvidenceHash !== "string" ||
    typeof receipt.surfaceLocatorHash !== "string" ||
    !/^[a-f0-9]{64}$/i.test(receipt.surfaceLocatorHash) ||
    typeof receipt.observationKey !== "string" ||
    !/^[a-f0-9]{64}$/i.test(receipt.observationKey) ||
    !Number.isFinite(Date.parse(String(receipt.observedAt)))
  ) {
    throw new Error("真实界面观察回执未通过边界校验。");
  }
  const { observationKey, ...receiptWithoutKey } =
    receipt as LiveUiObservationReceipt;
  const computedObservationKey = canonicalProtocolHash(
    LIVE_UI_OBSERVATION_SCHEMA_VERSION,
    receiptWithoutKey as CanonicalJsonValue
  );
  if (
    !constantTimeEqualHex(computedObservationKey, observationKey)
  ) {
    throw new Error("真实界面观察内部键校验失败。");
  }
  return receipt as LiveUiObservationReceipt;
}

export async function loadLiveUiObservation(
  receiptHash: string,
  outputRoot = liveObservationOutputRoot()
): Promise<{
  receipt: LiveUiObservationReceipt;
  receiptHash: string;
}> {
  const normalizedHash = sha256Hex(
    receiptHash,
    "真实界面观察回执哈希"
  );
  const raw = JSON.parse(
    await readFile(
      path.join(path.resolve(outputRoot), `${normalizedHash}.json`),
      "utf8"
    )
  ) as CanonicalJsonValue;
  const receipt = normalizeStoredReceipt(raw);
  const computedHash = canonicalProtocolHash(
    receipt.schemaVersion,
    raw
  );
  if (!constantTimeEqualHex(computedHash, normalizedHash)) {
    throw new Error("真实界面观察回执哈希校验失败。");
  }
  return { receipt, receiptHash: normalizedHash };
}

export async function loadLatestLiveUiObservationForBaseline(
  baselineEvidenceHash: string,
  outputRoot = liveObservationOutputRoot()
): Promise<{
  receipt: LiveUiObservationReceipt;
  receiptHash: string;
} | null> {
  const normalizedBaselineHash = sha256Hex(
    baselineEvidenceHash,
    "基线证据哈希"
  );
  let files: string[];
  try {
    files = (await readdir(path.resolve(outputRoot)))
      .filter((name) => /^[a-f0-9]{64}\.json$/i.test(name))
      .slice(-200);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const candidates = await Promise.all(
    files.map(async (file) => {
      try {
        return await loadLiveUiObservation(
          file.slice(0, -".json".length),
          outputRoot
        );
      } catch {
        return null;
      }
    })
  );
  return (
    candidates
      .filter(
        (
          value
        ): value is {
          receipt: LiveUiObservationReceipt;
          receiptHash: string;
        } =>
          value !== null &&
          value.receipt.baselineEvidenceHash ===
            normalizedBaselineHash
      )
      .sort(
        (left, right) =>
          Date.parse(right.receipt.observedAt) -
          Date.parse(left.receipt.observedAt)
      )[0] ?? null
  );
}
