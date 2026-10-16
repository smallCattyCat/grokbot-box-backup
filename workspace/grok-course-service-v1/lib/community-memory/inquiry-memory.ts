import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";

/**
 * A body-free, read-model contract for the middle layer between the course
 * event world and a facilitation decision.  This module deliberately has no
 * persistence or network dependency: callers can keep the value in a
 * sidecar, attach it to a context snapshot, or reject it before any write.
 */
export const COMMUNITY_INQUIRY_MEMORY_SCHEMA_VERSION =
  "cmooc.community-inquiry-memory.v1" as const;

export const COMMUNITY_INQUIRY_MEMORY_RELATION_GRAPH =
  "community_inquiry_retrieval" as const;

export const COMMUNITY_INQUIRY_MEMORY_CLAIM_BOUNDARY =
  "descriptive_process_or_hypothesis_not_causal" as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CODE_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const ROLE_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/u;
const MAX_ABSTRACT_TEXT = 320;

export type CommunityInquiryEpistemicStatus =
  | "observed"
  | "inferred"
  | "unknown";

export type CommunityInquiryMemoryStatus =
  | "candidate"
  | "active"
  | "disputed"
  | "retracted"
  | "superseded";

export type CommunityInquiryConditionState =
  | "satisfied"
  | "unsatisfied"
  | "unknown"
  | "conflict";

export type CommunityInquiryUnresolvedKind =
  | "question"
  | "evidence_gap"
  | "disagreement"
  | "responsibility"
  | "timing"
  | "other";

export type CommunityInquiryUnresolvedStatus =
  | "open"
  | "resolved"
  | "unknown";

export type CommunityInquiryEvidenceKind =
  | "anchor"
  | "invocation"
  | "course_event"
  | "world_snapshot"
  | "graph_snapshot"
  | "candidate_set"
  | "content_graph"
  | "decision"
  | "decision_tape"
  | "outcome"
  | "verification"
  | "source";

export type CommunityInquiryEntityKind =
  | "course"
  | "thread"
  | "event"
  | "actor"
  | "resource"
  | "concept"
  | "question"
  | "explanation"
  | "condition"
  | "activity"
  | "decision"
  | "outcome"
  | "teacher"
  | "peer"
  | "author";

export type CommunityInquiryEvidenceRef = {
  readonly kind: CommunityInquiryEvidenceKind;
  readonly id: string;
  readonly hash: string;
  readonly observedAt: string;
};

export type CommunityInquiryMemoryAnchor = {
  /** The course alias is safe routing metadata, not a platform course id. */
  readonly courseAlias: string;
  readonly invocationId: string;
  readonly worldSnapshotId: string;
  readonly graphSnapshotId: string;
  readonly candidateSetId: string;
  readonly asOfAt: string;
  readonly worldHash: string;
  readonly graphHash: string;
  readonly candidateSetHash: string;
};

export type CommunityInquiryCondition = {
  readonly code: string;
  readonly state: CommunityInquiryConditionState;
  readonly evidenceRefs: readonly CommunityInquiryEvidenceRef[];
};

export type CommunityInquiryExplanation = {
  readonly key: string;
  /** A short abstract statement, never a quoted post or a forum body. */
  readonly statement: string;
  readonly epistemicStatus: CommunityInquiryEpistemicStatus;
  readonly evidenceRefs: readonly CommunityInquiryEvidenceRef[];
  readonly conditions: readonly CommunityInquiryCondition[];
  readonly unknowns: readonly string[];
  readonly status: Exclude<CommunityInquiryMemoryStatus, "candidate">;
};

export type CommunityInquiryRelationMember = {
  readonly role: string;
  readonly refKind: CommunityInquiryEntityKind;
  /** Actor references must be opaque hashes; no names or platform ids. */
  readonly ref: string;
};

export type CommunityInquiryRelation = {
  readonly key: string;
  readonly predicate: string;
  readonly members: readonly CommunityInquiryRelationMember[];
  readonly epistemicStatus: CommunityInquiryEpistemicStatus;
  readonly evidenceRefs: readonly CommunityInquiryEvidenceRef[];
  readonly conditions: readonly CommunityInquiryCondition[];
  readonly unknowns: readonly string[];
  readonly status: Exclude<CommunityInquiryMemoryStatus, "candidate">;
};

export type CommunityInquiryResponsibilityCandidate = {
  readonly role: string;
  readonly subjectRef: CommunityInquiryRelationMember | null;
  readonly epistemicStatus: CommunityInquiryEpistemicStatus;
  readonly evidenceRefs: readonly CommunityInquiryEvidenceRef[];
  readonly conditions: readonly CommunityInquiryCondition[];
  readonly unknowns: readonly string[];
};

export type CommunityInquiryUnresolved = {
  readonly key: string;
  readonly kind: CommunityInquiryUnresolvedKind;
  readonly status: CommunityInquiryUnresolvedStatus;
  readonly evidenceRefs: readonly CommunityInquiryEvidenceRef[];
};

export type CommunityInquiryValidity = {
  readonly from: string | null;
  readonly through: string | null;
};

export type CommunityInquirySupersedes = {
  readonly memoryKey: string;
  readonly version: number;
  readonly contentHash: string;
};

export type CommunityInquiryMemoryV1 = {
  readonly schemaVersion: typeof COMMUNITY_INQUIRY_MEMORY_SCHEMA_VERSION;
  /** Stable identity for one inquiry line; it is not a database row id. */
  readonly memoryKey: string;
  readonly version: number;
  readonly status: CommunityInquiryMemoryStatus;
  readonly courseAlias: string;
  readonly invocationId: string;
  readonly anchor: CommunityInquiryMemoryAnchor;
  readonly question: string;
  readonly questionKey: string;
  readonly activityPhase: string;
  readonly epistemicStatus: CommunityInquiryEpistemicStatus;
  readonly evidenceRefs: readonly CommunityInquiryEvidenceRef[];
  readonly explanations: readonly CommunityInquiryExplanation[];
  readonly relations: readonly CommunityInquiryRelation[];
  readonly conditions: readonly CommunityInquiryCondition[];
  readonly unresolved: readonly CommunityInquiryUnresolved[];
  readonly responsibilityCandidates: readonly CommunityInquiryResponsibilityCandidate[];
  readonly sourceHashes: readonly string[];
  readonly recordedAt: string;
  readonly validAt: CommunityInquiryValidity;
  readonly supersedes: CommunityInquirySupersedes | null;
  readonly relationGraphKind: typeof COMMUNITY_INQUIRY_MEMORY_RELATION_GRAPH;
  readonly claimBoundary: typeof COMMUNITY_INQUIRY_MEMORY_CLAIM_BOUNDARY;
  readonly containsForumText: false;
  readonly containsDirectIdentity: false;
  readonly assertsCausality: false;
  readonly contentHash: string;
};

/** Short alias for callers that do not need to spell the wire-version name. */
export type CommunityInquiryMemory = CommunityInquiryMemoryV1;

export type CommunityInquiryMemoryProjection = CommunityInquiryMemoryAnchor;

export type CommunityInquiryMemoryInput = {
  readonly anchor: CommunityInquiryMemoryAnchor;
  readonly question: string;
  readonly questionKey?: string;
  readonly activityPhase: string;
  readonly epistemicStatus: CommunityInquiryEpistemicStatus;
  readonly evidenceRefs?: readonly CommunityInquiryEvidenceRef[];
  readonly explanations?: readonly CommunityInquiryExplanation[];
  /** `claims` is accepted as an input alias and canonicalized to explanations. */
  readonly claims?: readonly CommunityInquiryExplanation[];
  readonly relations?: readonly CommunityInquiryRelation[];
  readonly conditions?: readonly CommunityInquiryCondition[];
  readonly unresolved?: readonly CommunityInquiryUnresolved[];
  readonly responsibilityCandidates?: readonly CommunityInquiryResponsibilityCandidate[];
  /** Optional caller assertion; the builder recomputes and checks it. */
  readonly sourceHashes?: readonly string[];
  readonly recordedAt?: string;
  readonly validAt?: CommunityInquiryValidity;
  readonly memoryKey?: string;
  readonly version?: number;
  /** `revision` is accepted as a compatibility alias for `version`. */
  readonly revision?: number;
  readonly status?: CommunityInquiryMemoryStatus;
  readonly supersedes?: CommunityInquirySupersedes | null;
  readonly supersedesHash?: string | null;
  readonly containsForumText?: false;
  readonly containsDirectIdentity?: false;
  readonly assertsCausality?: false;
};

export type CommunityInquiryMemoryBuildFromProjectionInput = Omit<
  CommunityInquiryMemoryInput,
  "anchor"
> & {
  readonly projection: CommunityInquiryMemoryProjection;
};

export class CommunityInquiryMemoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CommunityInquiryMemoryError";
    this.code = code;
  }
}

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "memoryKey",
  "version",
  "status",
  "courseAlias",
  "invocationId",
  "anchor",
  "question",
  "questionKey",
  "activityPhase",
  "epistemicStatus",
  "evidenceRefs",
  "explanations",
  "relations",
  "conditions",
  "unresolved",
  "responsibilityCandidates",
  "sourceHashes",
  "recordedAt",
  "validAt",
  "supersedes",
  "relationGraphKind",
  "claimBoundary",
  "containsForumText",
  "containsDirectIdentity",
  "assertsCausality",
  "contentHash"
]);

const INPUT_KEYS = new Set([
  "anchor",
  "question",
  "questionKey",
  "activityPhase",
  "epistemicStatus",
  "evidenceRefs",
  "explanations",
  "claims",
  "relations",
  "conditions",
  "unresolved",
  "responsibilityCandidates",
  "sourceHashes",
  "recordedAt",
  "validAt",
  "memoryKey",
  "version",
  "revision",
  "status",
  "supersedes",
  "supersedesHash",
  "containsForumText",
  "containsDirectIdentity",
  "assertsCausality"
]);

const ANCHOR_KEYS = new Set([
  "courseAlias",
  "invocationId",
  "worldSnapshotId",
  "graphSnapshotId",
  "candidateSetId",
  "asOfAt",
  "worldHash",
  "graphHash",
  "candidateSetHash"
]);

const EVIDENCE_KEYS = new Set([
  "kind",
  "id",
  "hash",
  "observedAt"
]);

const CONDITION_KEYS = new Set([
  "code",
  "state",
  "evidenceRefs"
]);

const EXPLANATION_KEYS = new Set([
  "key",
  "statement",
  "epistemicStatus",
  "evidenceRefs",
  "conditions",
  "unknowns",
  "status"
]);

const RELATION_KEYS = new Set([
  "key",
  "predicate",
  "members",
  "epistemicStatus",
  "evidenceRefs",
  "conditions",
  "unknowns",
  "status"
]);

const RELATION_MEMBER_KEYS = new Set([
  "role",
  "refKind",
  "ref"
]);

const RESPONSIBILITY_KEYS = new Set([
  "role",
  "subjectRef",
  "epistemicStatus",
  "evidenceRefs",
  "conditions",
  "unknowns"
]);

const UNRESOLVED_KEYS = new Set([
  "key",
  "kind",
  "status",
  "evidenceRefs"
]);

const VALIDITY_KEYS = new Set(["from", "through"]);
const SUPERSEDES_KEYS = new Set([
  "memoryKey",
  "version",
  "contentHash"
]);

const FORBIDDEN_KEYS = new Set([
  "body",
  "content",
  "raw",
  "html",
  "markdown",
  "title",
  "url",
  "cookie",
  "token",
  "password",
  "secret",
  "email",
  "phone",
  "realname",
  "identity",
  "userid",
  "authorid",
  "actorid",
  "platformid",
  "courseid",
  "postid",
  "message",
  "transcript",
  "quote",
  "selection",
  "causal",
  "causality",
  "learningeffect",
  "effectsize",
  "impact",
  "causalclaim",
  "learningeffectclaim",
  "educationaleffect",
  "outcomeeffect",
  "effect",
  "text",
  "name",
  "displayname",
  "username",
  "handle",
  "profile"
]);

const EVIDENCE_KINDS = new Set<CommunityInquiryEvidenceKind>([
  "anchor",
  "invocation",
  "course_event",
  "world_snapshot",
  "graph_snapshot",
  "candidate_set",
  "content_graph",
  "decision",
  "decision_tape",
  "outcome",
  "verification",
  "source"
]);

const ENTITY_KINDS = new Set<CommunityInquiryEntityKind>([
  "course",
  "thread",
  "event",
  "actor",
  "resource",
  "concept",
  "question",
  "explanation",
  "condition",
  "activity",
  "decision",
  "outcome",
  "teacher",
  "peer",
  "author"
]);

const EPISTEMIC_STATUSES = new Set<CommunityInquiryEpistemicStatus>([
  "observed",
  "inferred",
  "unknown"
]);

const CONDITION_STATES = new Set<CommunityInquiryConditionState>([
  "satisfied",
  "unsatisfied",
  "unknown",
  "conflict"
]);

const MEMORY_STATUSES = new Set<CommunityInquiryMemoryStatus>([
  "candidate",
  "active",
  "disputed",
  "retracted",
  "superseded"
]);

const UNRESOLVED_KINDS = new Set<CommunityInquiryUnresolvedKind>([
  "question",
  "evidence_gap",
  "disagreement",
  "responsibility",
  "timing",
  "other"
]);

const UNRESOLVED_STATUSES = new Set<CommunityInquiryUnresolvedStatus>([
  "open",
  "resolved",
  "unknown"
]);

function fail(code: string, message: string): never {
  throw new CommunityInquiryMemoryError(code, message);
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail("COMMUNITY_MEMORY_RECORD_INVALID", `${label}必须是普通对象。`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  expected: ReadonlySet<string>,
  label: string
): void {
  const actual = Object.keys(record);
  if (
    actual.some((key) => !expected.has(key)) ||
    expected.size !== actual.length
  ) {
    fail("COMMUNITY_MEMORY_SHAPE_INVALID", `${label}包含未允许或缺失字段。`);
  }
}

function exactKeysAllowOptional(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    Object.values(record).some((value) => value === undefined)
  ) {
    fail("COMMUNITY_MEMORY_SHAPE_INVALID", `${label}包含未允许字段。`);
  }
}

function assertNoForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoForbiddenKeys);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.replace(/[A-Z]/gu, (letter) => letter.toLowerCase()))) {
      fail(
        "COMMUNITY_MEMORY_SENSITIVE_FIELD",
        `共同体探究记忆禁止字段：${key}。`
      );
    }
    assertNoForbiddenKeys(child);
  }
}

function assertHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    fail("COMMUNITY_MEMORY_HASH_INVALID", `${label}必须是 64 位小写 SHA-256。`);
  }
  return value;
}

function assertIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    fail("COMMUNITY_MEMORY_IDENTIFIER_INVALID", `${label}格式无效。`);
  }
  return value;
}

function assertCode(value: unknown, label: string): string {
  if (typeof value !== "string" || !CODE_PATTERN.test(value)) {
    fail("COMMUNITY_MEMORY_CODE_INVALID", `${label}必须是小写结构化代码。`);
  }
  return value;
}

function assertStructuredKey(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    (!CODE_PATTERN.test(value) && !HASH_PATTERN.test(value))
  ) {
    fail("COMMUNITY_MEMORY_CODE_INVALID", `${label}必须是结构化代码或规范哈希。`);
  }
  return value;
}

function assertRole(value: unknown, label: string): string {
  if (typeof value !== "string" || !ROLE_PATTERN.test(value)) {
    fail("COMMUNITY_MEMORY_ROLE_INVALID", `${label}格式无效。`);
  }
  return value;
}

function normalizeTime(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail("COMMUNITY_MEMORY_TIME_INVALID", `${label}必须是 ISO-8601 时间。`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    fail("COMMUNITY_MEMORY_TIME_INVALID", `${label}不是有效时间。`);
  }
  return parsed.toISOString();
}

function timeMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    fail("COMMUNITY_MEMORY_TIME_INVALID", "时间不可比较。");
  }
  return parsed;
}

function assertAbstractText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail("COMMUNITY_MEMORY_ABSTRACT_TEXT_INVALID", `${label}必须是抽象短句。`);
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_ABSTRACT_TEXT ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized) ||
    /<\/?[a-z][^>]*>/iu.test(normalized) ||
    /(?:https?:\/\/|www\.)/iu.test(normalized)
  ) {
    fail(
      "COMMUNITY_MEMORY_ABSTRACT_TEXT_INVALID",
      `${label}只能是有限长度的去正文抽象短句。`
    );
  }
  return normalized;
}

function normalizeStringCodes(
  value: unknown,
  label: string,
  max: number
): readonly string[] {
  if (!Array.isArray(value) || value.length > max) {
    fail("COMMUNITY_MEMORY_CODES_INVALID", `${label}必须是有限代码数组。`);
  }
  const result = value.map((item, index) =>
    assertCode(item, `${label}[${index}]`)
  );
  if (new Set(result).size !== result.length) {
    fail("COMMUNITY_MEMORY_CODES_DUPLICATE", `${label}不能重复。`);
  }
  return [...result].sort((left, right) => left.localeCompare(right));
}

function normalizeEpistemicStatus(
  value: unknown,
  label: string
): CommunityInquiryEpistemicStatus {
  if (
    typeof value !== "string" ||
    !EPISTEMIC_STATUSES.has(value as CommunityInquiryEpistemicStatus)
  ) {
    fail("COMMUNITY_MEMORY_EPISTEMIC_STATUS_INVALID", `${label}无效。`);
  }
  return value as CommunityInquiryEpistemicStatus;
}

function normalizeMemoryStatus(
  value: unknown,
  label: string
): CommunityInquiryMemoryStatus {
  if (
    typeof value !== "string" ||
    !MEMORY_STATUSES.has(value as CommunityInquiryMemoryStatus)
  ) {
    fail("COMMUNITY_MEMORY_STATUS_INVALID", `${label}无效。`);
  }
  return value as CommunityInquiryMemoryStatus;
}

function normalizeEvidenceRef(
  value: unknown,
  label: string,
  asOfAt: string
): CommunityInquiryEvidenceRef {
  const record = recordValue(value, label);
  exactKeys(record, EVIDENCE_KEYS, label);
  const kind = record.kind;
  if (
    typeof kind !== "string" ||
    !EVIDENCE_KINDS.has(kind as CommunityInquiryEvidenceKind)
  ) {
    fail("COMMUNITY_MEMORY_EVIDENCE_KIND_INVALID", `${label}.kind 无效。`);
  }
  const id = assertIdentifier(record.id, `${label}.id`);
  const hash = assertHash(record.hash, `${label}.hash`);
  const observedAt = normalizeTime(record.observedAt, `${label}.observedAt`);
  if (timeMs(observedAt) > timeMs(asOfAt)) {
    fail(
      "COMMUNITY_MEMORY_FUTURE_EVIDENCE",
      `${label}的 observedAt 晚于精确 as-of。`
    );
  }
  return { kind: kind as CommunityInquiryEvidenceKind, id, hash, observedAt };
}

function evidenceRefKey(value: CommunityInquiryEvidenceRef): string {
  return `${value.kind}\0${value.id}\0${value.hash}\0${value.observedAt}`;
}

function normalizeEvidenceRefs(
  value: unknown,
  label: string,
  asOfAt: string,
  max = 256
): readonly CommunityInquiryEvidenceRef[] {
  if (!Array.isArray(value) || value.length > max) {
    fail("COMMUNITY_MEMORY_EVIDENCE_REFS_INVALID", `${label}必须是有限数组。`);
  }
  const unique = new Map<string, CommunityInquiryEvidenceRef>();
  value.forEach((item, index) => {
    const ref = normalizeEvidenceRef(item, `${label}[${index}]`, asOfAt);
    unique.set(evidenceRefKey(ref), ref);
  });
  return [...unique.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id) ||
      left.hash.localeCompare(right.hash) ||
      left.observedAt.localeCompare(right.observedAt)
  );
}

function normalizeCondition(
  value: unknown,
  label: string,
  asOfAt: string
): CommunityInquiryCondition {
  const record = recordValue(value, label);
  exactKeys(record, CONDITION_KEYS, label);
  const code = assertCode(record.code, `${label}.code`);
  const state = record.state;
  if (
    typeof state !== "string" ||
    !CONDITION_STATES.has(state as CommunityInquiryConditionState)
  ) {
    fail("COMMUNITY_MEMORY_CONDITION_STATE_INVALID", `${label}.state 无效。`);
  }
  return {
    code,
    state: state as CommunityInquiryConditionState,
    evidenceRefs: normalizeEvidenceRefs(
      record.evidenceRefs,
      `${label}.evidenceRefs`,
      asOfAt
    )
  };
}

function normalizeConditions(
  value: unknown,
  label: string,
  asOfAt: string
): readonly CommunityInquiryCondition[] {
  if (!Array.isArray(value) || value.length > 64) {
    fail("COMMUNITY_MEMORY_CONDITIONS_INVALID", `${label}必须是有限数组。`);
  }
  const conditions = value.map((item, index) =>
    normalizeCondition(item, `${label}[${index}]`, asOfAt)
  );
  if (new Set(conditions.map((item) => item.code)).size !== conditions.length) {
    fail("COMMUNITY_MEMORY_CONDITION_DUPLICATE", `${label}的 code 不能重复。`);
  }
  return [...conditions].sort((left, right) => left.code.localeCompare(right.code));
}

function normalizeRelationMember(
  value: unknown,
  label: string
): CommunityInquiryRelationMember {
  const record = recordValue(value, label);
  exactKeys(record, RELATION_MEMBER_KEYS, label);
  const role = assertRole(record.role, `${label}.role`);
  const refKind = record.refKind;
  if (
    typeof refKind !== "string" ||
    !ENTITY_KINDS.has(refKind as CommunityInquiryEntityKind)
  ) {
    fail("COMMUNITY_MEMORY_ENTITY_KIND_INVALID", `${label}.refKind 无效。`);
  }
  const ref = assertIdentifier(record.ref, `${label}.ref`);
  if (
    ["actor", "author", "peer", "teacher"].includes(refKind) &&
    !HASH_PATTERN.test(ref)
  ) {
    fail(
      "COMMUNITY_MEMORY_IDENTITY_REF_INVALID",
      `${label}的参与者引用必须是不可逆哈希。`
    );
  }
  return {
    role,
    refKind: refKind as CommunityInquiryEntityKind,
    ref
  };
}

function relationMemberKey(value: CommunityInquiryRelationMember): string {
  return `${value.role}\0${value.refKind}\0${value.ref}`;
}

function normalizeExplanation(
  value: unknown,
  label: string,
  asOfAt: string
): CommunityInquiryExplanation {
  const record = recordValue(value, label);
  exactKeys(record, EXPLANATION_KEYS, label);
  const status = record.status;
  if (
    typeof status !== "string" ||
    !["active", "disputed", "retracted", "superseded"].includes(status)
  ) {
    fail("COMMUNITY_MEMORY_EXPLANATION_STATUS_INVALID", `${label}.status 无效。`);
  }
  return {
    key: assertCode(record.key, `${label}.key`),
    statement: assertAbstractText(record.statement, `${label}.statement`),
    epistemicStatus: normalizeEpistemicStatus(
      record.epistemicStatus,
      `${label}.epistemicStatus`
    ),
    evidenceRefs: normalizeEvidenceRefs(
      record.evidenceRefs,
      `${label}.evidenceRefs`,
      asOfAt
    ),
    conditions: normalizeConditions(
      record.conditions,
      `${label}.conditions`,
      asOfAt
    ),
    unknowns: normalizeStringCodes(record.unknowns, `${label}.unknowns`, 64),
    status: status as Exclude<CommunityInquiryMemoryStatus, "candidate">
  };
}

function normalizeExplanations(
  value: unknown,
  label: string,
  asOfAt: string
): readonly CommunityInquiryExplanation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    fail("COMMUNITY_MEMORY_EXPLANATIONS_INVALID", `${label}必须包含 1 到 32 条解释。`);
  }
  const explanations = value.map((item, index) =>
    normalizeExplanation(item, `${label}[${index}]`, asOfAt)
  );
  if (new Set(explanations.map((item) => item.key)).size !== explanations.length) {
    fail("COMMUNITY_MEMORY_EXPLANATION_DUPLICATE", `${label}的 key 不能重复。`);
  }
  return [...explanations].sort((left, right) => left.key.localeCompare(right.key));
}

function normalizeRelation(
  value: unknown,
  label: string,
  asOfAt: string
): CommunityInquiryRelation {
  const record = recordValue(value, label);
  exactKeys(record, RELATION_KEYS, label);
  const membersValue = record.members;
  if (
    !Array.isArray(membersValue) ||
    membersValue.length < 2 ||
    membersValue.length > 32
  ) {
    fail("COMMUNITY_MEMORY_RELATION_MEMBERS_INVALID", `${label}.members 必须是 2 到 32 个成员。`);
  }
  const members = membersValue.map((item, index) =>
    normalizeRelationMember(item, `${label}.members[${index}]`)
  );
  const memberKeys = members.map(relationMemberKey);
  if (new Set(memberKeys).size !== memberKeys.length) {
    fail("COMMUNITY_MEMORY_RELATION_MEMBER_DUPLICATE", `${label}.members 不能重复。`);
  }
  const status = record.status;
  if (
    typeof status !== "string" ||
    !["active", "disputed", "retracted", "superseded"].includes(status)
  ) {
    fail("COMMUNITY_MEMORY_RELATION_STATUS_INVALID", `${label}.status 无效。`);
  }
  return {
    key: assertCode(record.key, `${label}.key`),
    predicate: assertCode(record.predicate, `${label}.predicate`),
    members: [...members].sort(
      (left, right) => relationMemberKey(left).localeCompare(relationMemberKey(right))
    ),
    epistemicStatus: normalizeEpistemicStatus(
      record.epistemicStatus,
      `${label}.epistemicStatus`
    ),
    evidenceRefs: normalizeEvidenceRefs(
      record.evidenceRefs,
      `${label}.evidenceRefs`,
      asOfAt
    ),
    conditions: normalizeConditions(
      record.conditions,
      `${label}.conditions`,
      asOfAt
    ),
    unknowns: normalizeStringCodes(record.unknowns, `${label}.unknowns`, 64),
    status: status as Exclude<CommunityInquiryMemoryStatus, "candidate">
  };
}

function normalizeRelations(
  value: unknown,
  label: string,
  asOfAt: string
): readonly CommunityInquiryRelation[] {
  if (!Array.isArray(value) || value.length > 64) {
    fail("COMMUNITY_MEMORY_RELATIONS_INVALID", `${label}必须是有限数组。`);
  }
  const relations = value.map((item, index) =>
    normalizeRelation(item, `${label}[${index}]`, asOfAt)
  );
  if (new Set(relations.map((item) => item.key)).size !== relations.length) {
    fail("COMMUNITY_MEMORY_RELATION_DUPLICATE", `${label}的 key 不能重复。`);
  }
  return [...relations].sort((left, right) => left.key.localeCompare(right.key));
}

function normalizeResponsibilityCandidate(
  value: unknown,
  label: string,
  asOfAt: string
): CommunityInquiryResponsibilityCandidate {
  const record = recordValue(value, label);
  exactKeys(record, RESPONSIBILITY_KEYS, label);
  let subjectRef: CommunityInquiryRelationMember | null = null;
  if (record.subjectRef !== null) {
    subjectRef = normalizeRelationMember(record.subjectRef, `${label}.subjectRef`);
  }
  return {
    role: assertRole(record.role, `${label}.role`),
    subjectRef,
    epistemicStatus: normalizeEpistemicStatus(
      record.epistemicStatus,
      `${label}.epistemicStatus`
    ),
    evidenceRefs: normalizeEvidenceRefs(
      record.evidenceRefs,
      `${label}.evidenceRefs`,
      asOfAt
    ),
    conditions: normalizeConditions(
      record.conditions,
      `${label}.conditions`,
      asOfAt
    ),
    unknowns: normalizeStringCodes(record.unknowns, `${label}.unknowns`, 64)
  };
}

function normalizeResponsibilities(
  value: unknown,
  label: string,
  asOfAt: string
): readonly CommunityInquiryResponsibilityCandidate[] {
  if (!Array.isArray(value) || value.length > 32) {
    fail("COMMUNITY_MEMORY_RESPONSIBILITIES_INVALID", `${label}必须是有限数组。`);
  }
  const candidates = value.map((item, index) =>
    normalizeResponsibilityCandidate(item, `${label}[${index}]`, asOfAt)
  );
  const keys = candidates.map((item) =>
    `${item.role}\0${item.subjectRef ? relationMemberKey(item.subjectRef) : "none"}`
  );
  if (new Set(keys).size !== keys.length) {
    fail("COMMUNITY_MEMORY_RESPONSIBILITY_DUPLICATE", `${label}不能重复。`);
  }
  return [...candidates].sort((left, right) => {
    const leftKey = `${left.role}\0${left.subjectRef ? relationMemberKey(left.subjectRef) : "none"}`;
    const rightKey = `${right.role}\0${right.subjectRef ? relationMemberKey(right.subjectRef) : "none"}`;
    return leftKey.localeCompare(rightKey);
  });
}

function normalizeUnresolved(
  value: unknown,
  label: string,
  asOfAt: string
): readonly CommunityInquiryUnresolved[] {
  if (!Array.isArray(value) || value.length > 64) {
    fail("COMMUNITY_MEMORY_UNRESOLVED_INVALID", `${label}必须是有限数组。`);
  }
  const unresolved = value.map((item, index) => {
    const record = recordValue(item, `${label}[${index}]`);
    exactKeys(record, UNRESOLVED_KEYS, `${label}[${index}]`);
    const kind = record.kind;
    const status = record.status;
    if (
      typeof kind !== "string" ||
      !UNRESOLVED_KINDS.has(kind as CommunityInquiryUnresolvedKind) ||
      typeof status !== "string" ||
      !UNRESOLVED_STATUSES.has(status as CommunityInquiryUnresolvedStatus)
    ) {
      fail("COMMUNITY_MEMORY_UNRESOLVED_STATE_INVALID", `${label}[${index}]状态无效。`);
    }
    return {
      key: assertCode(record.key, `${label}[${index}].key`),
      kind: kind as CommunityInquiryUnresolvedKind,
      status: status as CommunityInquiryUnresolvedStatus,
      evidenceRefs: normalizeEvidenceRefs(
        record.evidenceRefs,
        `${label}[${index}].evidenceRefs`,
        asOfAt
      )
    } satisfies CommunityInquiryUnresolved;
  });
  if (new Set(unresolved.map((item) => item.key)).size !== unresolved.length) {
    fail("COMMUNITY_MEMORY_UNRESOLVED_DUPLICATE", `${label}的 key 不能重复。`);
  }
  return [...unresolved].sort((left, right) => left.key.localeCompare(right.key));
}

function normalizeValidity(
  value: unknown,
  label: string,
  asOfAt: string
): CommunityInquiryValidity {
  const record = recordValue(value, label);
  exactKeys(record, VALIDITY_KEYS, label);
  const from = record.from === null ? null : normalizeTime(record.from, `${label}.from`);
  const through = record.through === null
    ? null
    : normalizeTime(record.through, `${label}.through`);
  if (from && through && timeMs(from) > timeMs(through)) {
    fail("COMMUNITY_MEMORY_VALIDITY_ORDER_INVALID", "validAt.from 不能晚于 through。");
  }
  if (from && timeMs(from) > timeMs(asOfAt)) {
    fail("COMMUNITY_MEMORY_FUTURE_VALIDITY", "validAt.from 不能晚于精确 as-of。");
  }
  return { from, through };
}

function normalizeSupersedes(
  value: unknown,
  label: string
): CommunityInquirySupersedes | null {
  if (value === null) return null;
  const record = recordValue(value, label);
  exactKeys(record, SUPERSEDES_KEYS, label);
  const memoryKey = assertHash(record.memoryKey, `${label}.memoryKey`);
  const version = record.version;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    fail("COMMUNITY_MEMORY_VERSION_INVALID", `${label}.version 无效。`);
  }
  const contentHash = assertHash(record.contentHash, `${label}.contentHash`);
  return { memoryKey, version, contentHash };
}

function normalizeAnchor(value: unknown): CommunityInquiryMemoryAnchor {
  const record = recordValue(value, "共同体探究记忆 anchor");
  exactKeys(record, ANCHOR_KEYS, "共同体探究记忆 anchor");
  const anchor = {
    courseAlias: assertIdentifier(record.courseAlias, "anchor.courseAlias"),
    invocationId: assertIdentifier(record.invocationId, "anchor.invocationId"),
    worldSnapshotId: assertIdentifier(
      record.worldSnapshotId,
      "anchor.worldSnapshotId"
    ),
    graphSnapshotId: assertIdentifier(
      record.graphSnapshotId,
      "anchor.graphSnapshotId"
    ),
    candidateSetId: assertIdentifier(
      record.candidateSetId,
      "anchor.candidateSetId"
    ),
    asOfAt: normalizeTime(record.asOfAt, "anchor.asOfAt"),
    worldHash: assertHash(record.worldHash, "anchor.worldHash"),
    graphHash: assertHash(record.graphHash, "anchor.graphHash"),
    candidateSetHash: assertHash(
      record.candidateSetHash,
      "anchor.candidateSetHash"
    )
  } satisfies CommunityInquiryMemoryAnchor;
  return anchor;
}

function anchorEvidenceRefs(
  anchor: CommunityInquiryMemoryAnchor
): readonly CommunityInquiryEvidenceRef[] {
  const invocationHash = canonicalProtocolHash(
    "cmooc.community-inquiry-invocation-anchor.v1",
    {
      courseAlias: anchor.courseAlias,
      invocationId: anchor.invocationId,
      containsForumText: false
    } as unknown as CanonicalJsonValue
  );
  return [
    {
      kind: "invocation",
      id: anchor.invocationId,
      hash: invocationHash,
      observedAt: anchor.asOfAt
    },
    {
      kind: "world_snapshot",
      id: anchor.worldSnapshotId,
      hash: anchor.worldHash,
      observedAt: anchor.asOfAt
    },
    {
      kind: "graph_snapshot",
      id: anchor.graphSnapshotId,
      hash: anchor.graphHash,
      observedAt: anchor.asOfAt
    },
    {
      kind: "candidate_set",
      id: anchor.candidateSetId,
      hash: anchor.candidateSetHash,
      observedAt: anchor.asOfAt
    }
  ];
}

function collectNestedEvidenceRefs(memory: {
  evidenceRefs: readonly CommunityInquiryEvidenceRef[];
  explanations: readonly CommunityInquiryExplanation[];
  relations: readonly CommunityInquiryRelation[];
  conditions: readonly CommunityInquiryCondition[];
  unresolved: readonly CommunityInquiryUnresolved[];
  responsibilityCandidates: readonly CommunityInquiryResponsibilityCandidate[];
}): readonly CommunityInquiryEvidenceRef[] {
  const refs = [
    ...memory.evidenceRefs,
    ...memory.explanations.flatMap((item) => [
      ...item.evidenceRefs,
      ...item.conditions.flatMap((condition) => condition.evidenceRefs)
    ]),
    ...memory.relations.flatMap((item) => [
      ...item.evidenceRefs,
      ...item.conditions.flatMap((condition) => condition.evidenceRefs)
    ]),
    ...memory.conditions.flatMap((condition) => condition.evidenceRefs),
    ...memory.unresolved.flatMap((item) => item.evidenceRefs),
    ...memory.responsibilityCandidates.flatMap((item) => [
      ...item.evidenceRefs,
      ...item.conditions.flatMap((condition) => condition.evidenceRefs)
    ])
  ];
  const unique = new Map<string, CommunityInquiryEvidenceRef>();
  refs.forEach((ref) => unique.set(evidenceRefKey(ref), ref));
  return [...unique.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id) ||
      left.hash.localeCompare(right.hash) ||
      left.observedAt.localeCompare(right.observedAt)
  );
}

function assertAnchorEvidenceRefsPresent(
  refs: readonly CommunityInquiryEvidenceRef[],
  anchor: CommunityInquiryMemoryAnchor
): void {
  const keys = new Set(refs.map(evidenceRefKey));
  for (const expected of anchorEvidenceRefs(anchor)) {
    if (!keys.has(evidenceRefKey(expected))) {
      fail(
        "COMMUNITY_MEMORY_ANCHOR_EVIDENCE_MISSING",
        "evidenceRefs 必须包含 invocation、world、graph 和 candidate 的精确锚点。"
      );
    }
  }
}

function assertEvidenceRefsHaveNoConflicts(
  refs: readonly CommunityInquiryEvidenceRef[]
): void {
  const byIdentity = new Map<string, CommunityInquiryEvidenceRef>();
  for (const ref of refs) {
    const identity = `${ref.kind}\0${ref.id}`;
    const previous = byIdentity.get(identity);
    if (
      previous &&
      (previous.hash !== ref.hash || previous.observedAt !== ref.observedAt)
    ) {
      fail(
        "COMMUNITY_MEMORY_EVIDENCE_CONFLICT",
        "同一证据标识不能绑定多个哈希或观测时间。"
      );
    }
    byIdentity.set(identity, ref);
  }
}

function normalizeMemoryRecord(value: unknown): CommunityInquiryMemoryV1 {
  assertNoForbiddenKeys(value);
  const record = recordValue(value, "共同体探究记忆");
  exactKeys(record, TOP_LEVEL_KEYS, "共同体探究记忆");
  if (record.schemaVersion !== COMMUNITY_INQUIRY_MEMORY_SCHEMA_VERSION) {
    fail("COMMUNITY_MEMORY_SCHEMA_VERSION_INVALID", "schemaVersion 不匹配。");
  }
  const anchor = normalizeAnchor(record.anchor);
  if (record.courseAlias !== anchor.courseAlias) {
    fail("COMMUNITY_MEMORY_COURSE_ANCHOR_MISMATCH", "courseAlias 未绑定到精确 anchor。");
  }
  if (record.invocationId !== anchor.invocationId) {
    fail("COMMUNITY_MEMORY_INVOCATION_ANCHOR_MISMATCH", "invocationId 未绑定到精确 anchor。");
  }
  const version = record.version;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    fail("COMMUNITY_MEMORY_VERSION_INVALID", "version 必须是正整数。");
  }
  const parsedVersion = version as number;
  const status = normalizeMemoryStatus(record.status, "status");
  const question = assertAbstractText(record.question, "question");
  const questionKey = assertStructuredKey(record.questionKey, "questionKey");
  const activityPhase = assertCode(record.activityPhase, "activityPhase");
  const epistemicStatus = normalizeEpistemicStatus(
    record.epistemicStatus,
    "epistemicStatus"
  );
  const evidenceRefs = normalizeEvidenceRefs(
    record.evidenceRefs,
    "evidenceRefs",
    anchor.asOfAt
  );
  const explanations = normalizeExplanations(
    record.explanations,
    "explanations",
    anchor.asOfAt
  );
  const relations = normalizeRelations(record.relations, "relations", anchor.asOfAt);
  const conditions = normalizeConditions(
    record.conditions,
    "conditions",
    anchor.asOfAt
  );
  const unresolved = normalizeUnresolved(
    record.unresolved,
    "unresolved",
    anchor.asOfAt
  );
  const responsibilityCandidates = normalizeResponsibilities(
    record.responsibilityCandidates,
    "responsibilityCandidates",
    anchor.asOfAt
  );
  const allRefs = collectNestedEvidenceRefs({
    evidenceRefs,
    explanations,
    relations,
    conditions,
    unresolved,
    responsibilityCandidates
  });
  assertAnchorEvidenceRefsPresent(allRefs, anchor);
  assertEvidenceRefsHaveNoConflicts(allRefs);
  const normalizedEvidenceKeys = allRefs.map(evidenceRefKey);
  if (
    normalizedEvidenceKeys.length !== evidenceRefs.length ||
    evidenceRefs.some((ref) => !normalizedEvidenceKeys.includes(evidenceRefKey(ref)))
  ) {
    fail(
      "COMMUNITY_MEMORY_EVIDENCE_ROOT_INCOMPLETE",
      "evidenceRefs 必须至少包含所有记忆证据引用。"
    );
  }
  const sourceHashes = normalizeHashes(record.sourceHashes, "sourceHashes");
  const expectedSourceHashes = [...new Set([
    anchor.worldHash,
    anchor.graphHash,
    anchor.candidateSetHash,
    ...allRefs.map((ref) => ref.hash)
  ])].sort();
  if (JSON.stringify(sourceHashes) !== JSON.stringify(expectedSourceHashes)) {
    fail("COMMUNITY_MEMORY_SOURCE_HASHES_MISMATCH", "sourceHashes 未覆盖精确来源。");
  }
  const recordedAt = normalizeTime(record.recordedAt, "recordedAt");
  const latestEvidenceAt = allRefs.reduce(
    (latest, ref) => Math.max(latest, timeMs(ref.observedAt)),
    Number.NEGATIVE_INFINITY
  );
  if (timeMs(recordedAt) < latestEvidenceAt) {
    fail("COMMUNITY_MEMORY_RECORDED_BEFORE_EVIDENCE", "recordedAt 不能早于证据观测时间。");
  }
  const validAt = normalizeValidity(record.validAt, "validAt", anchor.asOfAt);
  const supersedes = normalizeSupersedes(record.supersedes, "supersedes");
  const memoryKey = assertHash(record.memoryKey, "memoryKey");
  if (parsedVersion === 1 && supersedes !== null) {
    fail("COMMUNITY_MEMORY_FIRST_VERSION_SUPERSEDES", "首版本不能 supersede 旧版本。");
  }
  if (parsedVersion > 1 && supersedes === null) {
    fail("COMMUNITY_MEMORY_SUPERSEDES_REQUIRED", "后续版本必须精确引用 supersedes。");
  }
  if (
    supersedes !== null &&
    (supersedes.memoryKey !== memoryKey ||
      supersedes.version !== parsedVersion - 1)
  ) {
    fail(
      "COMMUNITY_MEMORY_SUPERSEDES_SEQUENCE_INVALID",
      "supersedes 必须指向同一 memoryKey 的前一版本。"
    );
  }
  if (record.relationGraphKind !== COMMUNITY_INQUIRY_MEMORY_RELATION_GRAPH) {
    fail("COMMUNITY_MEMORY_RELATION_GRAPH_INVALID", "关系图必须是独立的检索关系图。");
  }
  if (record.claimBoundary !== COMMUNITY_INQUIRY_MEMORY_CLAIM_BOUNDARY) {
    fail("COMMUNITY_MEMORY_CLAIM_BOUNDARY_INVALID", "记忆不能越过非因果主张边界。");
  }
  if (record.containsForumText !== false) {
    fail("COMMUNITY_MEMORY_FORUM_TEXT_FORBIDDEN", "共同体探究记忆不得包含论坛正文。");
  }
  if (record.containsDirectIdentity !== false) {
    fail("COMMUNITY_MEMORY_IDENTITY_FORBIDDEN", "共同体探究记忆不得包含直接身份。");
  }
  if (record.assertsCausality !== false) {
    fail("COMMUNITY_MEMORY_CAUSAL_CLAIM_FORBIDDEN", "共同体探究记忆不得自动宣称因果。");
  }
  const contentHash = assertHash(record.contentHash, "contentHash");
  const normalized = {
    schemaVersion: COMMUNITY_INQUIRY_MEMORY_SCHEMA_VERSION,
    memoryKey,
    version: parsedVersion,
    status,
    courseAlias: anchor.courseAlias,
    invocationId: anchor.invocationId,
    anchor,
    question,
    questionKey,
    activityPhase,
    epistemicStatus,
    evidenceRefs: allRefs,
    explanations,
    relations,
    conditions,
    unresolved,
    responsibilityCandidates,
    sourceHashes,
    recordedAt,
    validAt,
    supersedes,
    relationGraphKind: COMMUNITY_INQUIRY_MEMORY_RELATION_GRAPH,
    claimBoundary: COMMUNITY_INQUIRY_MEMORY_CLAIM_BOUNDARY,
    containsForumText: false as const,
    containsDirectIdentity: false as const,
    assertsCausality: false as const,
    contentHash
  } satisfies CommunityInquiryMemoryV1;
  const expectedHash = contentHashFor(normalized);
  if (expectedHash !== contentHash) {
    fail("COMMUNITY_MEMORY_CONTENT_HASH_MISMATCH", "contentHash 与内容不一致。");
  }
  return normalized;
}

function normalizeHashes(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 512) {
    fail("COMMUNITY_MEMORY_HASHES_INVALID", `${label}必须是有限数组。`);
  }
  const hashes = value.map((item, index) => assertHash(item, `${label}[${index}]`));
  if (new Set(hashes).size !== hashes.length) {
    fail("COMMUNITY_MEMORY_HASHES_DUPLICATE", `${label}不能重复。`);
  }
  return [...hashes].sort();
}

function contentHashMaterial(
  memory: Omit<CommunityInquiryMemoryV1, "contentHash">
): CanonicalJsonValue {
  return memory as unknown as CanonicalJsonValue;
}

function contentHashFor(memory: CommunityInquiryMemoryV1): string {
  const { contentHash: _ignored, ...material } = memory;
  return canonicalProtocolHash(
    COMMUNITY_INQUIRY_MEMORY_SCHEMA_VERSION,
    contentHashMaterial(material)
  );
}

function normalizeInputValue(input: CommunityInquiryMemoryInput): {
  readonly anchor: CommunityInquiryMemoryAnchor;
  readonly question: string;
  readonly questionKey: string;
  readonly activityPhase: string;
  readonly epistemicStatus: CommunityInquiryEpistemicStatus;
  readonly evidenceRefs: readonly CommunityInquiryEvidenceRef[];
  readonly explanations: readonly CommunityInquiryExplanation[];
  readonly relations: readonly CommunityInquiryRelation[];
  readonly conditions: readonly CommunityInquiryCondition[];
  readonly unresolved: readonly CommunityInquiryUnresolved[];
  readonly responsibilityCandidates: readonly CommunityInquiryResponsibilityCandidate[];
  readonly sourceHashes: readonly string[];
  readonly recordedAt: string;
  readonly validAt: CommunityInquiryValidity;
  readonly memoryKey: string;
  readonly version: number;
  readonly status: CommunityInquiryMemoryStatus;
  readonly supersedes: CommunityInquirySupersedes | null;
} {
  const inputRecord = recordValue(input, "共同体探究记忆输入");
  exactKeysAllowOptional(inputRecord, INPUT_KEYS, "共同体探究记忆输入");
  assertNoForbiddenKeys(input);
  const anchor = normalizeAnchor(input.anchor);
  const question = assertAbstractText(input.question, "question");
  const questionKey = input.questionKey !== undefined
    ? assertStructuredKey(input.questionKey, "questionKey")
    : canonicalProtocolHash(
        "cmooc.community-inquiry-question-key.v1",
        {
          courseAlias: anchor.courseAlias,
          question,
          containsForumText: false
        } as unknown as CanonicalJsonValue
      );
  const activityPhase = assertCode(input.activityPhase, "activityPhase");
  const epistemicStatus = normalizeEpistemicStatus(
    input.epistemicStatus,
    "epistemicStatus"
  );
  const anchorRefs = anchorEvidenceRefs(anchor);
  const suppliedRefs = normalizeEvidenceRefs(
    input.evidenceRefs ?? [],
    "evidenceRefs",
    anchor.asOfAt
  );
  const explanationsInput = input.explanations ?? input.claims;
  if (!explanationsInput) {
    fail("COMMUNITY_MEMORY_EXPLANATIONS_REQUIRED", "至少需要一条 explanation/claim。");
  }
  if (input.explanations && input.claims) {
    fail("COMMUNITY_MEMORY_EXPLANATION_ALIAS_CONFLICT", "explanations 与 claims 不能同时提供。");
  }
  const explanations = normalizeExplanations(
    explanationsInput,
    "explanations",
    anchor.asOfAt
  );
  const relations = normalizeRelations(
    input.relations ?? [],
    "relations",
    anchor.asOfAt
  );
  const conditions = normalizeConditions(
    input.conditions ?? [],
    "conditions",
    anchor.asOfAt
  );
  const unresolved = normalizeUnresolved(
    input.unresolved ?? [],
    "unresolved",
    anchor.asOfAt
  );
  const responsibilityCandidates = normalizeResponsibilities(
    input.responsibilityCandidates ?? [],
    "responsibilityCandidates",
    anchor.asOfAt
  );
  const allRefs = collectNestedEvidenceRefs({
    evidenceRefs: [...anchorRefs, ...suppliedRefs],
    explanations,
    relations,
    conditions,
    unresolved,
    responsibilityCandidates
  });
  assertAnchorEvidenceRefsPresent(allRefs, anchor);
  assertEvidenceRefsHaveNoConflicts(allRefs);
  const derivedSourceHashes = [...new Set([
    anchor.worldHash,
    anchor.graphHash,
    anchor.candidateSetHash,
    ...allRefs.map((ref) => ref.hash)
  ])].sort();
  const sourceHashes = input.sourceHashes === undefined
    ? derivedSourceHashes
    : normalizeHashes(input.sourceHashes, "sourceHashes");
  if (JSON.stringify(sourceHashes) !== JSON.stringify(derivedSourceHashes)) {
    fail("COMMUNITY_MEMORY_SOURCE_HASHES_MISMATCH", "sourceHashes 未覆盖精确来源。");
  }
  const recordedAt = normalizeTime(
    input.recordedAt ?? anchor.asOfAt,
    "recordedAt"
  );
  const latestEvidenceAt = allRefs.reduce(
    (latest, ref) => Math.max(latest, timeMs(ref.observedAt)),
    Number.NEGATIVE_INFINITY
  );
  if (timeMs(recordedAt) < latestEvidenceAt) {
    fail("COMMUNITY_MEMORY_RECORDED_BEFORE_EVIDENCE", "recordedAt 不能早于证据观测时间。");
  }
  const validAt = normalizeValidity(
    input.validAt ?? { from: null, through: null },
    "validAt",
    anchor.asOfAt
  );
  const suppliedVersion = input.version ?? input.revision ?? 1;
  if (
    input.version !== undefined &&
    input.revision !== undefined &&
    input.version !== input.revision
  ) {
    fail("COMMUNITY_MEMORY_VERSION_ALIAS_CONFLICT", "version 与 revision 不一致。");
  }
  if (!Number.isSafeInteger(suppliedVersion) || suppliedVersion < 1) {
    fail("COMMUNITY_MEMORY_VERSION_INVALID", "version 必须是正整数。");
  }
  const memoryKey = input.memoryKey !== undefined
    ? assertHash(input.memoryKey, "memoryKey")
    : canonicalProtocolHash(
        "cmooc.community-inquiry-memory-key.v1",
        {
          courseAlias: anchor.courseAlias,
          questionKey,
          relationGraphKind: COMMUNITY_INQUIRY_MEMORY_RELATION_GRAPH,
          containsForumText: false
        } as unknown as CanonicalJsonValue
      );
  let supersedes = normalizeSupersedes(input.supersedes ?? null, "supersedes");
  if (input.supersedesHash !== undefined) {
    if (input.supersedesHash === null) {
      if (supersedes !== null) {
        fail("COMMUNITY_MEMORY_SUPERSEDES_ALIAS_CONFLICT", "supersedes 与 supersedesHash 冲突。");
      }
    } else {
      const supersedesHash = assertHash(input.supersedesHash, "supersedesHash");
      if (supersedes !== null && supersedes.contentHash !== supersedesHash) {
        fail("COMMUNITY_MEMORY_SUPERSEDES_ALIAS_CONFLICT", "supersedes 与 supersedesHash 冲突。");
      }
      if (supersedes === null) {
        fail(
          "COMMUNITY_MEMORY_SUPERSEDES_VERSION_REQUIRED",
          "提供 supersedesHash 时必须同时提供 supersedes.memoryKey 与 version。"
        );
      }
    }
  }
  if (suppliedVersion === 1 && supersedes !== null) {
    fail("COMMUNITY_MEMORY_FIRST_VERSION_SUPERSEDES", "首版本不能 supersede 旧版本。");
  }
  if (suppliedVersion > 1 && supersedes === null) {
    fail("COMMUNITY_MEMORY_SUPERSEDES_REQUIRED", "后续版本必须精确引用 supersedes。");
  }
  if (
    supersedes !== null &&
    (supersedes.memoryKey !== memoryKey ||
      supersedes.version !== suppliedVersion - 1)
  ) {
    fail(
      "COMMUNITY_MEMORY_SUPERSEDES_SEQUENCE_INVALID",
      "supersedes 必须指向同一 memoryKey 的前一版本。"
    );
  }
  const status = normalizeMemoryStatus(input.status ?? "candidate", "status");
  if (input.containsForumText !== undefined || input.containsDirectIdentity !== undefined || input.assertsCausality !== undefined) {
    if (input.containsForumText !== false || input.containsDirectIdentity !== false || input.assertsCausality !== false) {
      fail("COMMUNITY_MEMORY_BOUNDARY_FLAGS_INVALID", "边界标记必须固定为 false。");
    }
  }
  return {
    anchor,
    question,
    questionKey,
    activityPhase,
    epistemicStatus,
    evidenceRefs: allRefs,
    explanations,
    relations,
    conditions,
    unresolved,
    responsibilityCandidates,
    sourceHashes,
    recordedAt,
    validAt,
    memoryKey,
    version: suppliedVersion,
    status,
    supersedes
  };
}

export function buildCommunityInquiryMemory(
  input: CommunityInquiryMemoryInput
): CommunityInquiryMemoryV1 {
  const normalized = normalizeInputValue(input);
  const withoutHash = {
    schemaVersion: COMMUNITY_INQUIRY_MEMORY_SCHEMA_VERSION,
    memoryKey: normalized.memoryKey,
    version: normalized.version,
    status: normalized.status,
    courseAlias: normalized.anchor.courseAlias,
    invocationId: normalized.anchor.invocationId,
    anchor: normalized.anchor,
    question: normalized.question,
    questionKey: normalized.questionKey,
    activityPhase: normalized.activityPhase,
    epistemicStatus: normalized.epistemicStatus,
    evidenceRefs: normalized.evidenceRefs,
    explanations: normalized.explanations,
    relations: normalized.relations,
    conditions: normalized.conditions,
    unresolved: normalized.unresolved,
    responsibilityCandidates: normalized.responsibilityCandidates,
    sourceHashes: normalized.sourceHashes,
    recordedAt: normalized.recordedAt,
    validAt: normalized.validAt,
    supersedes: normalized.supersedes,
    relationGraphKind: COMMUNITY_INQUIRY_MEMORY_RELATION_GRAPH,
    claimBoundary: COMMUNITY_INQUIRY_MEMORY_CLAIM_BOUNDARY,
    containsForumText: false as const,
    containsDirectIdentity: false as const,
    assertsCausality: false as const
  };
  const contentHash = canonicalProtocolHash(
    COMMUNITY_INQUIRY_MEMORY_SCHEMA_VERSION,
    withoutHash as unknown as CanonicalJsonValue
  );
  return { ...withoutHash, contentHash } satisfies CommunityInquiryMemoryV1;
}

/** Semantic alias used by adapters that treat the builder as a constructor. */
export const createCommunityInquiryMemory = buildCommunityInquiryMemory;

/** Build the same contract when the caller has an existing safe projection. */
export function buildCommunityInquiryMemoryFromProjection(
  input: CommunityInquiryMemoryBuildFromProjectionInput
): CommunityInquiryMemoryV1 {
  const { projection, ...rest } = input;
  return buildCommunityInquiryMemory({
    ...rest,
    anchor: projection
  });
}

/** Validate an existing safe world/graph/candidate projection before use. */
export function parseCommunityInquiryMemoryProjection(
  value: unknown
): CommunityInquiryMemoryProjection {
  return normalizeAnchor(value);
}

export function parseCommunityInquiryMemory(
  value: unknown
): CommunityInquiryMemoryV1 {
  return normalizeMemoryRecord(value);
}

/** Return the verified canonical hash without exposing the hash material format. */
export function hashCommunityInquiryMemory(value: unknown): string {
  return parseCommunityInquiryMemory(value).contentHash;
}

export function assertCommunityInquiryMemory(
  value: unknown
): CommunityInquiryMemoryV1 {
  return parseCommunityInquiryMemory(value);
}

export function verifyCommunityInquiryMemory(
  value: unknown
): {
  readonly valid: boolean;
  readonly memory: CommunityInquiryMemoryV1 | null;
  readonly contentHash: string | null;
  readonly errorCode: string | null;
} {
  try {
    const memory = parseCommunityInquiryMemory(value);
    return {
      valid: true,
      memory,
      contentHash: memory.contentHash,
      errorCode: null
    };
  } catch (error) {
    return {
      valid: false,
      memory: null,
      contentHash: null,
      errorCode:
        error instanceof CommunityInquiryMemoryError ? error.code : "COMMUNITY_MEMORY_INVALID"
    };
  }
}

export function assertCommunityInquiryMemoryRevision(input: {
  readonly previous: CommunityInquiryMemoryV1;
  readonly next: CommunityInquiryMemoryV1;
}): void {
  const previous = parseCommunityInquiryMemory(input.previous);
  const next = parseCommunityInquiryMemory(input.next);
  if (next.memoryKey !== previous.memoryKey) {
    fail("COMMUNITY_MEMORY_REVISION_KEY_MISMATCH", "修订不能改变 memoryKey。");
  }
  if (next.courseAlias !== previous.courseAlias || next.questionKey !== previous.questionKey) {
    fail("COMMUNITY_MEMORY_REVISION_SCOPE_MISMATCH", "修订不能改变课程或探究问题身份。");
  }
  if (next.version !== previous.version + 1) {
    fail("COMMUNITY_MEMORY_REVISION_SEQUENCE_INVALID", "修订版本必须严格递增一位。");
  }
  if (
    !next.supersedes ||
    next.supersedes.memoryKey !== previous.memoryKey ||
    next.supersedes.version !== previous.version ||
    next.supersedes.contentHash !== previous.contentHash
  ) {
    fail("COMMUNITY_MEMORY_REVISION_SUPERSEDES_INVALID", "修订必须精确 supersede 前一版本。");
  }
  if (timeMs(next.recordedAt) < timeMs(previous.recordedAt)) {
    fail("COMMUNITY_MEMORY_REVISION_TIME_INVALID", "修订 recordedAt 不能早于前一版本。");
  }
  if (timeMs(next.anchor.asOfAt) < timeMs(previous.anchor.asOfAt)) {
    fail("COMMUNITY_MEMORY_REVISION_AS_OF_INVALID", "修订 as-of 不能早于前一版本。");
  }
}

export function buildCommunityInquiryMemoryRevision(input: {
  readonly previous: CommunityInquiryMemoryV1;
  readonly next: Omit<CommunityInquiryMemoryInput, "memoryKey" | "version" | "revision" | "supersedes" | "supersedesHash">;
}): CommunityInquiryMemoryV1 {
  const previous = parseCommunityInquiryMemory(input.previous);
  const next = buildCommunityInquiryMemory({
    ...input.next,
    memoryKey: previous.memoryKey,
    version: previous.version + 1,
    supersedes: {
      memoryKey: previous.memoryKey,
      version: previous.version,
      contentHash: previous.contentHash
    }
  });
  assertCommunityInquiryMemoryRevision({ previous, next });
  return next;
}

/**
 * Append-only helper. It never mutates or replaces `previous`; a caller may
 * persist the returned value as a new sidecar record after its own transaction.
 */
export function appendCommunityInquiryMemoryRevision(input: {
  readonly previous: CommunityInquiryMemoryV1;
  readonly next: CommunityInquiryMemoryV1;
}): CommunityInquiryMemoryV1 {
  assertCommunityInquiryMemoryRevision(input);
  return input.next;
}
