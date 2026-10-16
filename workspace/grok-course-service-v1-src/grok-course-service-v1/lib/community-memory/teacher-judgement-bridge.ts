import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  assertCommunityMemoryApprovalPrincipal,
  COMMUNITY_MEMORY_REVIEW_ROLES,
  type CommunityMemoryApprovalPrincipal,
  type CommunityMemoryReviewRole
} from "./approval-principal";
import type {
  CommunityInquiryEvidenceKind,
  CommunityInquiryEvidenceRef,
  CommunityInquiryMemoryAnchor
} from "./inquiry-memory";

/**
 * Body-free bridge record for a teacher/owner judgement made in the browser
 * companion. It is intentionally a pure contract: callers still have to
 * attach the record to an autonomy invocation/Decision Tape before it can be
 * used by a later runtime. A browser tape without this exact anchor cannot be
 * promoted into an autonomy judgement.
 */
export const COMMUNITY_TEACHER_JUDGEMENT_SCHEMA_VERSION =
  "cmooc.community-teacher-judgement.v1" as const;

export const COMMUNITY_TEACHER_JUDGEMENT_ACTIONS = [
  "accepted",
  "revised",
  "rejected",
  "yield",
  "handoff"
] as const;

export type CommunityTeacherJudgementAction =
  (typeof COMMUNITY_TEACHER_JUDGEMENT_ACTIONS)[number];

export type CommunityTeacherJudgementEvidenceRef = Pick<
  CommunityInquiryEvidenceRef,
  "kind" | "id" | "hash" | "observedAt"
>;

export type CommunityTeacherJudgementV1 = {
  readonly schemaVersion: typeof COMMUNITY_TEACHER_JUDGEMENT_SCHEMA_VERSION;
  readonly courseAlias: string;
  readonly anchor: CommunityInquiryMemoryAnchor;
  readonly decisionKey: string;
  readonly browserRunRef: string | null;
  /** Non-null only when a server-issued BrowserAutonomyBinding was used. */
  readonly browserBindingHash: string | null;
  readonly action: CommunityTeacherJudgementAction;
  readonly reasonCode: string;
  readonly alternativeActionCode: string | null;
  readonly yieldConditionCode: string | null;
  readonly evidenceRefs: readonly CommunityTeacherJudgementEvidenceRef[];
  readonly reviewerRole: CommunityMemoryReviewRole;
  readonly reviewerRefHash: string;
  readonly reviewedAt: string;
  readonly previousJudgementHash: string | null;
  readonly operationKey: string;
  readonly containsForumText: false;
  readonly containsDirectIdentity: false;
  readonly assertsCausality: false;
  readonly judgementHash: string;
};

export type CommunityTeacherJudgementInput = {
  readonly anchor: CommunityInquiryMemoryAnchor;
  readonly decisionKey: string;
  readonly browserRunRef?: string | null;
  readonly browserBindingHash?: string | null;
  readonly action: CommunityTeacherJudgementAction;
  readonly reasonCode: string;
  readonly alternativeActionCode?: string | null;
  readonly yieldConditionCode?: string | null;
  readonly evidenceRefs: readonly CommunityTeacherJudgementEvidenceRef[];
  readonly approval: CommunityMemoryApprovalPrincipal;
  readonly reviewedAt: string;
  readonly previousJudgementHash?: string | null;
  readonly operationKey: string;
};

export class CommunityTeacherJudgementError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "CommunityTeacherJudgementError";
    this.code = code;
  }
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CODE_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
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

function fail(code: string, message = code): never {
  throw new CommunityTeacherJudgementError(code, message);
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    fail("COMMUNITY_TEACHER_JUDGEMENT_HASH_INVALID", `${label}必须是小写 SHA-256。`);
  }
  return value;
}

function code(value: unknown, label: string): string {
  if (typeof value !== "string" || !CODE_PATTERN.test(value)) {
    fail("COMMUNITY_TEACHER_JUDGEMENT_CODE_INVALID", `${label}无效。`);
  }
  return value;
}

function ref(value: unknown, label: string): string {
  if (typeof value !== "string" || !REF_PATTERN.test(value)) {
    fail("COMMUNITY_TEACHER_JUDGEMENT_REF_INVALID", `${label}无效。`);
  }
  return value;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string") fail("COMMUNITY_TEACHER_JUDGEMENT_TIME_INVALID", `${label}无效。`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    fail("COMMUNITY_TEACHER_JUDGEMENT_TIME_INVALID", `${label}无效。`);
  }
  return date.toISOString();
}

function sameAnchor(left: CommunityInquiryMemoryAnchor, right: CommunityInquiryMemoryAnchor): boolean {
  return left.courseAlias === right.courseAlias &&
    left.invocationId === right.invocationId &&
    left.worldSnapshotId === right.worldSnapshotId &&
    left.graphSnapshotId === right.graphSnapshotId &&
    left.candidateSetId === right.candidateSetId &&
    left.asOfAt === right.asOfAt &&
    left.worldHash === right.worldHash &&
    left.graphHash === right.graphHash &&
    left.candidateSetHash === right.candidateSetHash;
}

function anchorRefs(anchor: CommunityInquiryMemoryAnchor): CommunityTeacherJudgementEvidenceRef[] {
  const invocationHash = canonicalProtocolHash(
    "cmooc.community-inquiry-invocation-anchor.v1",
    {
      courseAlias: anchor.courseAlias,
      invocationId: anchor.invocationId,
      containsForumText: false
    } as unknown as CanonicalJsonValue
  );
  return [
    { kind: "invocation", id: anchor.invocationId, hash: invocationHash, observedAt: anchor.asOfAt },
    { kind: "world_snapshot", id: anchor.worldSnapshotId, hash: anchor.worldHash, observedAt: anchor.asOfAt },
    { kind: "graph_snapshot", id: anchor.graphSnapshotId, hash: anchor.graphHash, observedAt: anchor.asOfAt },
    { kind: "candidate_set", id: anchor.candidateSetId, hash: anchor.candidateSetHash, observedAt: anchor.asOfAt }
  ];
}

function normalizeEvidence(
  value: readonly CommunityTeacherJudgementEvidenceRef[],
  anchor: CommunityInquiryMemoryAnchor
): readonly CommunityTeacherJudgementEvidenceRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    fail("COMMUNITY_TEACHER_JUDGEMENT_EVIDENCE_INVALID");
  }
  const normalized = value.map((item, index) => {
    if (!item || !EVIDENCE_KINDS.has(item.kind) || !REF_PATTERN.test(item.id)) {
      fail("COMMUNITY_TEACHER_JUDGEMENT_EVIDENCE_INVALID", `evidenceRefs[${index}]无效。`);
    }
    const observedAt = iso(item.observedAt, `evidenceRefs[${index}].observedAt`);
    if (Date.parse(observedAt) > Date.parse(anchor.asOfAt)) {
      fail("COMMUNITY_TEACHER_JUDGEMENT_FUTURE_EVIDENCE");
    }
    return {
      kind: item.kind,
      id: ref(item.id, `evidenceRefs[${index}].id`),
      hash: hash(item.hash, `evidenceRefs[${index}].hash`),
      observedAt
    };
  });
  const byKey = new Map(normalized.map((item) => [`${item.kind}\0${item.id}`, item]));
  for (const required of anchorRefs(anchor)) {
    const actual = byKey.get(`${required.kind}\0${required.id}`);
    if (!actual || actual.hash !== required.hash || actual.observedAt !== required.observedAt) {
      fail("COMMUNITY_TEACHER_JUDGEMENT_ANCHOR_EVIDENCE_MISSING");
    }
  }
  return normalized.sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id) || left.hash.localeCompare(right.hash)
  );
}

function withoutHash(value: Omit<CommunityTeacherJudgementV1, "judgementHash">): CanonicalJsonValue {
  return value as unknown as CanonicalJsonValue;
}

function judgementHashFor(
  value: Omit<CommunityTeacherJudgementV1, "judgementHash">
): string {
  return canonicalProtocolHash(
    COMMUNITY_TEACHER_JUDGEMENT_SCHEMA_VERSION,
    withoutHash(value)
  );
}

export function buildCommunityTeacherJudgement(
  input: CommunityTeacherJudgementInput
): CommunityTeacherJudgementV1 {
  if (!COMMUNITY_TEACHER_JUDGEMENT_ACTIONS.includes(input.action)) {
    fail("COMMUNITY_TEACHER_JUDGEMENT_ACTION_INVALID");
  }
  const anchor = input.anchor;
  const approval = assertCommunityMemoryApprovalPrincipal(input.approval, {
    courseAlias: anchor.courseAlias
  });
  const decisionKey = hash(input.decisionKey, "decisionKey");
  const browserRunRef = input.browserRunRef == null ? null : ref(input.browserRunRef, "browserRunRef");
  const browserBindingHash = input.browserBindingHash == null
    ? null
    : hash(input.browserBindingHash, "browserBindingHash");
  const reasonCode = code(input.reasonCode, "reasonCode");
  const alternativeActionCode = input.alternativeActionCode == null
    ? null
    : code(input.alternativeActionCode, "alternativeActionCode");
  const yieldConditionCode = input.yieldConditionCode == null
    ? null
    : code(input.yieldConditionCode, "yieldConditionCode");
  const reviewedAt = iso(input.reviewedAt, "reviewedAt");
  const previousJudgementHash = input.previousJudgementHash == null
    ? null
    : hash(input.previousJudgementHash, "previousJudgementHash");
  const operationKey = ref(input.operationKey, "operationKey");
  const evidenceRefs = normalizeEvidence(input.evidenceRefs, anchor);
  const body = {
    schemaVersion: COMMUNITY_TEACHER_JUDGEMENT_SCHEMA_VERSION,
    courseAlias: anchor.courseAlias,
    anchor,
    decisionKey,
    browserRunRef,
    browserBindingHash,
    action: input.action,
    reasonCode,
    alternativeActionCode,
    yieldConditionCode,
    evidenceRefs,
    reviewerRole: approval.reviewerRole,
    reviewerRefHash: approval.reviewerRefHash,
    reviewedAt,
    previousJudgementHash,
    operationKey,
    containsForumText: false as const,
    containsDirectIdentity: false as const,
    assertsCausality: false as const
  } satisfies Omit<CommunityTeacherJudgementV1, "judgementHash">;
  return {
    ...body,
    judgementHash: judgementHashFor(body)
  };
}

export function parseCommunityTeacherJudgement(value: unknown): CommunityTeacherJudgementV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("COMMUNITY_TEACHER_JUDGEMENT_INVALID");
  }
  const record = value as CommunityTeacherJudgementV1;
  if (record.schemaVersion !== COMMUNITY_TEACHER_JUDGEMENT_SCHEMA_VERSION) {
    fail("COMMUNITY_TEACHER_JUDGEMENT_SCHEMA_INVALID");
  }
  if (!record.anchor || typeof record.anchor !== "object" ||
      !COMMUNITY_TEACHER_JUDGEMENT_ACTIONS.includes(record.action) ||
      !COMMUNITY_MEMORY_REVIEW_ROLES.includes(record.reviewerRole) ||
      record.courseAlias !== record.anchor?.courseAlias) {
    fail("COMMUNITY_TEACHER_JUDGEMENT_INVALID");
  }
  const body = {
    schemaVersion: COMMUNITY_TEACHER_JUDGEMENT_SCHEMA_VERSION,
    courseAlias: record.anchor.courseAlias,
    anchor: record.anchor,
    decisionKey: hash(record.decisionKey, "decisionKey"),
    browserRunRef: record.browserRunRef == null ? null : ref(record.browserRunRef, "browserRunRef"),
    browserBindingHash: record.browserBindingHash == null ? null : hash(record.browserBindingHash, "browserBindingHash"),
    action: record.action,
    reasonCode: code(record.reasonCode, "reasonCode"),
    alternativeActionCode: record.alternativeActionCode == null ? null : code(record.alternativeActionCode, "alternativeActionCode"),
    yieldConditionCode: record.yieldConditionCode == null ? null : code(record.yieldConditionCode, "yieldConditionCode"),
    evidenceRefs: normalizeEvidence(record.evidenceRefs, record.anchor),
    reviewerRole: record.reviewerRole,
    reviewerRefHash: hash(record.reviewerRefHash, "reviewerRefHash"),
    reviewedAt: iso(record.reviewedAt, "reviewedAt"),
    previousJudgementHash: record.previousJudgementHash == null ? null : hash(record.previousJudgementHash, "previousJudgementHash"),
    operationKey: ref(record.operationKey, "operationKey"),
    containsForumText: false as const,
    containsDirectIdentity: false as const,
    assertsCausality: false as const
  } satisfies Omit<CommunityTeacherJudgementV1, "judgementHash">;
  if (judgementHashFor(body) !== record.judgementHash) {
    fail("COMMUNITY_TEACHER_JUDGEMENT_HASH_MISMATCH");
  }
  return { ...body, judgementHash: record.judgementHash };
}
