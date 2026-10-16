import { loadExperienceDecisionContext } from "./experience-context";
import {
  Prisma,
  type PrismaClient
} from "@prisma/client";
import {
  canonicalJson,
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  assertCommunityMemoryApprovalPrincipal,
  type CommunityMemoryApprovalPrincipal
} from "./approval-principal";
import {
  buildExperienceObservation,
  parseExperienceObservation,
  parseFacilitationLessonApplication,
  applyFacilitationLesson,
  parseFacilitationLesson,
  type ExperienceObservation,
  type ExperienceObservationInput,
  type FacilitationLesson,
  type FacilitationLessonApplication,
  type FacilitationEvaluationMode,
  type FacilitationFactsSource,
  FACILITATION_EXPERIENCE_OBSERVATION_SCHEMA_VERSION,
  FACILITATION_LESSON_APPLICATION_SCHEMA_VERSION,
  FACILITATION_LESSON_SCHEMA_VERSION,
  FACILITATION_FACT_SOURCES,
  FACILITATION_LESSON_DISPOSITIONS
} from "./facilitation-experience";
import {
  parseCommunityInquiryMemoryProjection,
  type CommunityInquiryMemoryProjection
} from "./inquiry-memory";
import type {
  CommunityInquiryShadowDecision,
  CommunityInquiryShadowDecisionField
} from "./shadow-comparison";
import {
  parseExperienceFactsTapePayload,
  selectExperienceFacts
} from "./experience-facts";

/**
 * Durable registry for the cMOOC experience loop.  The registry is an
 * append-only read model: it records observations, lesson revisions, review
 * events, and applications without becoming a course-event source or a
 * publication authority.
 */
export const FACILITATION_EXPERIENCE_STORE_SCHEMA_VERSION =
  "cmooc.facilitation-experience-store.v1" as const;
export const FACILITATION_EXPERIENCE_REVIEW_SCHEMA_VERSION =
  "cmooc.facilitation-experience-review.v1" as const;

export type FacilitationExperienceStoreDb =
  | PrismaClient
  | Prisma.TransactionClient;

export class FacilitationExperienceStoreError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "FacilitationExperienceStoreError";
    this.code = code;
  }
}

export type FacilitationExperienceObservationProjection = {
  readonly id: string;
  readonly observation: ExperienceObservation;
  readonly replayed: boolean;
};

export type FacilitationLessonRevisionProjection = {
  readonly id: string;
  readonly lesson: FacilitationLesson;
  readonly replayed: boolean;
};

export type FacilitationLessonReviewProjection = {
  readonly id: string;
  readonly lessonHash: string;
  readonly lessonKey: string;
  readonly version: number;
  readonly action: "approved" | "rejected" | "retracted";
  readonly reviewerRole: "course_owner" | "teacher";
  readonly reviewerRefHash: string;
  readonly reasonCode: string;
  readonly sequence: number;
  readonly previousReviewHash: string | null;
  readonly reviewHash: string;
  readonly createdAt: string;
  readonly replayed: boolean;
};

export type FacilitationLessonApplicationProjection = {
  readonly id: string;
  readonly application: FacilitationLessonApplication;
  readonly recordedAt: string;
  readonly replayed: boolean;
};

export type CourseExperienceSafeObservation = {
  readonly observationKey: string;
  readonly version: number;
  readonly observationHash: string;
  readonly sourceAnchorHash: string;
  readonly sourceObservationHashes: readonly string[];
  readonly observedAt: string;
  readonly recordedAt: string;
};

export type CourseExperienceSafeLesson = {
  readonly lessonKey: string;
  readonly version: number;
  readonly lessonHash: string;
  readonly status: "candidate" | "approved" | "rejected" | "retracted";
  readonly method: FacilitationLesson["method"];
  readonly reason: string;
  readonly sourceAnchorHash: string;
  readonly sourceObservationHashes: readonly string[];
  readonly supersedesHash: string | null;
  readonly recordedAt: string;
  readonly acceptedAt: string | null;
};

export type CourseExperienceSafeReview = {
  readonly lessonHash: string;
  readonly action: FacilitationLessonReviewProjection["action"];
  readonly reviewerRole: FacilitationLessonReviewProjection["reviewerRole"];
  readonly reviewHash: string;
  readonly reasonCode: string;
  readonly createdAt: string;
};

export type CourseExperienceSafeApplication = {
  readonly applicationHash: string;
  readonly lessonHash: string;
  readonly targetAnchorHash: string;
  readonly candidateKey: string;
  readonly acceptedAt: string;
  readonly evaluatedAt: string;
  readonly evaluationMode: FacilitationEvaluationMode;
  readonly recordedAt: string;
  readonly disposition: FacilitationLessonApplication["disposition"];
  readonly changedFields: readonly CommunityInquiryShadowDecisionField[];
  readonly reasonCode: string;
  readonly decision: CommunityInquiryShadowDecision;
};

export type CourseExperienceSafeReadModel = {
  readonly courseAlias: string;
  readonly observations: readonly CourseExperienceSafeObservation[];
  readonly lessons: readonly CourseExperienceSafeLesson[];
  readonly reviews: readonly CourseExperienceSafeReview[];
  readonly applications: readonly CourseExperienceSafeApplication[];
  readonly containsForumText: false;
  readonly containsDirectIdentity: false;
  readonly assertsCausality: false;
};

type JsonRecord = Record<string, unknown>;
type Row = JsonRecord & { id: string };

type Delegate = {
  findUnique(args: JsonRecord): Promise<Row | null>;
  findFirst(args: JsonRecord): Promise<Row | null>;
  findMany(args: JsonRecord): Promise<Row[]>;
  create(args: JsonRecord): Promise<Row>;
};

type StoreDb = FacilitationExperienceStoreDb & {
  $transaction?: <T>(
    fn: (tx: FacilitationExperienceStoreDb) => Promise<T>
  ) => Promise<T>;
};

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const REVIEW_ACTIONS = ["approved", "rejected", "retracted"] as const;
const REVIEW_ROLES = ["course_owner", "teacher"] as const;

function fail(code: string, message = code): never {
  throw new FacilitationExperienceStoreError(code, message);
}

function delegate(db: FacilitationExperienceStoreDb, name: string): Delegate {
  const value = (db as unknown as Record<string, unknown>)[name];
  if (!value || typeof value !== "object") {
    fail("FACILITATION_EXPERIENCE_DB_MODEL_MISSING", name);
  }
  return value as Delegate;
}

function objectValue(value: unknown, label: string): JsonRecord {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail("FACILITATION_EXPERIENCE_RECORD_INVALID", label);
  }
  return value as JsonRecord;
}

function hashValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    fail("FACILITATION_EXPERIENCE_HASH_INVALID", label);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    fail("FACILITATION_EXPERIENCE_IDENTIFIER_INVALID", label);
  }
  return value;
}

function operationKey(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_PATTERN.test(value.trim())) {
    fail("FACILITATION_EXPERIENCE_OPERATION_INVALID");
  }
  return value.trim();
}

function isoDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    fail("FACILITATION_EXPERIENCE_TIME_INVALID", label);
  }
  return date;
}

function iso(value: Date | string, label: string): string {
  return isoDate(value, label).toISOString();
}

function json(value: unknown, label: string): string {
  try {
    return canonicalJson(value as CanonicalJsonValue);
  } catch {
    fail("FACILITATION_EXPERIENCE_JSON_INVALID", label);
  }
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string" || value.length === 0) {
    fail("FACILITATION_EXPERIENCE_JSON_INVALID", label);
  }
  try {
    return JSON.parse(value);
  } catch {
    fail("FACILITATION_EXPERIENCE_JSON_INVALID", label);
  }
}

function operationHash(kind: string, key: string): string {
  return canonicalProtocolHash(
    FACILITATION_EXPERIENCE_STORE_SCHEMA_VERSION,
    { kind, operationKey: key } as unknown as CanonicalJsonValue
  );
}

function anchorHash(anchor: CommunityInquiryMemoryProjection): string {
  return canonicalProtocolHash(
    "cmooc.facilitation-experience-anchor.v1",
    anchor as unknown as CanonicalJsonValue
  );
}

function sameAnchor(
  left: CommunityInquiryMemoryProjection,
  right: CommunityInquiryMemoryProjection
): boolean {
  return (
    left.courseAlias === right.courseAlias &&
    left.invocationId === right.invocationId &&
    left.worldSnapshotId === right.worldSnapshotId &&
    left.graphSnapshotId === right.graphSnapshotId &&
    left.candidateSetId === right.candidateSetId &&
    left.asOfAt === right.asOfAt &&
    left.worldHash === right.worldHash &&
    left.graphHash === right.graphHash &&
    left.candidateSetHash === right.candidateSetHash
  );
}

function observationInput(value: unknown): ExperienceObservationInput {
  const record = objectValue(value, "observation");
  const {
    schemaVersion: _schemaVersion,
    observationHash: _observationHash,
    containsForumText: _containsForumText,
    containsDirectIdentity: _containsDirectIdentity,
    assertsCausality: _assertsCausality,
    ...input
  } = record;
  if (_schemaVersion !== FACILITATION_EXPERIENCE_OBSERVATION_SCHEMA_VERSION) {
    fail("FACILITATION_EXPERIENCE_OBSERVATION_SCHEMA_INVALID");
  }
  if (_containsForumText !== false || _containsDirectIdentity !== false || _assertsCausality !== false) {
    fail("FACILITATION_EXPERIENCE_PRIVACY_INVALID");
  }
  return input as ExperienceObservationInput;
}

function parseObservation(value: unknown): ExperienceObservation {
  return parseExperienceObservation(value);
}

function parseLesson(value: unknown): FacilitationLesson {
  try {
    return parseFacilitationLesson(value);
  } catch (error) {
    if (error instanceof FacilitationExperienceStoreError) throw error;
    fail("FACILITATION_EXPERIENCE_LESSON_INVALID");
  }
}

function parseApplication(value: unknown): FacilitationLessonApplication {
  return parseFacilitationLessonApplication(value);
}

async function tx<T>(db: FacilitationExperienceStoreDb, fn: (value: FacilitationExperienceStoreDb) => Promise<T>): Promise<T> {
  const transaction = (db as StoreDb).$transaction;
  if (typeof transaction !== "function") return fn(db);
  for (let attempt = 0; ; attempt++) {
    try { return await transaction.call(db, fn) as T; }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (attempt >= 3 || !["P2002", "P2034", "P1008", "P2028", "FACILITATION_EXPERIENCE_WRITE_CONFLICT"].includes(code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

async function assertRuntimeAnchor(
  db: FacilitationExperienceStoreDb,
  anchor: CommunityInquiryMemoryProjection
): Promise<void> {
  const [manifest, invocation, world, graph, candidateSet] = await Promise.all([
    delegate(db, "autonomyCourseManifest").findUnique({ where: { alias: anchor.courseAlias } }),
    delegate(db, "scheduledInvocation").findUnique({ where: { id: anchor.invocationId } }),
    delegate(db, "courseWorldSnapshot").findUnique({ where: { id: anchor.worldSnapshotId } }),
    delegate(db, "courseContentGraphSnapshot").findUnique({ where: { id: anchor.graphSnapshotId } }),
    delegate(db, "candidateSet").findUnique({ where: { id: anchor.candidateSetId } })
  ]);
  if (!manifest || !invocation || !world || !graph || !candidateSet) {
    fail("FACILITATION_EXPERIENCE_ANCHOR_NOT_FOUND");
  }
  if (
    invocation.courseAlias !== anchor.courseAlias ||
    world.invocationId !== anchor.invocationId ||
    world.courseAlias !== anchor.courseAlias ||
    world.worldHash !== anchor.worldHash ||
    graph.worldSnapshotId !== anchor.worldSnapshotId ||
    graph.courseAlias !== anchor.courseAlias ||
    graph.contentGraphHash !== anchor.graphHash ||
    candidateSet.invocationId !== anchor.invocationId ||
    candidateSet.snapshotId !== anchor.worldSnapshotId ||
    candidateSet.candidateSetHash !== anchor.candidateSetHash ||
    iso(world.asOfAt as Date, "world.asOfAt") !== anchor.asOfAt ||
    iso(graph.asOfAt as Date, "graph.asOfAt") !== anchor.asOfAt ||
    iso(candidateSet.asOfAt as Date, "candidateSet.asOfAt") !== anchor.asOfAt
  ) {
    fail("FACILITATION_EXPERIENCE_ANCHOR_MISMATCH");
  }
}

async function assertObservationSources(
  db: FacilitationExperienceStoreDb,
  anchor: CommunityInquiryMemoryProjection,
  hashes: readonly string[]
): Promise<void> {
  const rows = await delegate(db, "autonomyObservation").findMany({
    where: { receiptHash: { in: [...hashes] } }
  });
  if (rows.length !== hashes.length) fail("FACILITATION_EXPERIENCE_SOURCE_OBSERVATION_NOT_FOUND");
  const byHash = new Map(rows.map((row) => [row.receiptHash as string, row]));
  for (const hash of hashes) {
    const row = byHash.get(hash);
    if (!row || row.invocationId !== anchor.invocationId) {
      fail("FACILITATION_EXPERIENCE_SOURCE_OBSERVATION_MISMATCH");
    }
    if (iso(row.observedAt as Date, "observation.observedAt") > anchor.asOfAt) {
      fail("FACILITATION_EXPERIENCE_FUTURE_SOURCE_OBSERVATION");
    }
  }

}

async function assertLessonSources(
  db: FacilitationExperienceStoreDb,
  courseAlias: string,
  hashes: readonly string[]
): Promise<void> {
  const rows = await delegate(db, "facilitationExperienceObservation").findMany({
    where: { observationHash: { in: [...hashes] }, courseAlias }
  });
  if (rows.length !== hashes.length) fail("FACILITATION_EXPERIENCE_LESSON_SOURCE_NOT_FOUND");
  if (new Set(rows.map((row) => row.observationHash)).size !== hashes.length) {
    fail("FACILITATION_EXPERIENCE_LESSON_SOURCE_NOT_FOUND");
  }
  for (const row of rows) parseObservation(parseJson(row.observationJson, "observationJson"));
}

function observationRowData(observation: ExperienceObservation, opHash: string): JsonRecord {
  const anchor = parseCommunityInquiryMemoryProjection(observation.sourceAnchor);
  return {
    schemaVersion: observation.schemaVersion,
    observationKey: observation.observationKey,
    version: 1,
    courseAlias: anchor.courseAlias,
    invocationId: anchor.invocationId,
    worldSnapshotId: anchor.worldSnapshotId,
    graphSnapshotId: anchor.graphSnapshotId,
    candidateSetId: anchor.candidateSetId,
    asOfAt: new Date(anchor.asOfAt),
    worldHash: anchor.worldHash,
    graphHash: anchor.graphHash,
    candidateSetHash: anchor.candidateSetHash,
    sourceAnchorHash: anchorHash(anchor),
    sourceAnchorJson: json(anchor, "sourceAnchor"),
    sourceObservationHashesJson: json(observation.sourceObservationHashes as unknown as CanonicalJsonValue, "sourceObservationHashes"),
    observationJson: json(observation as unknown as CanonicalJsonValue, "observation"),
    observationHash: observation.observationHash,
    observedAt: new Date(anchor.asOfAt),
    recordedAt: new Date(observation.recordedAt),
    operationKeyHash: opHash,
    containsForumText: false,
    containsDirectIdentity: false,
    assertsCausality: false
  };
}

function lessonRowData(lesson: FacilitationLesson, opHash: string): JsonRecord {
  return {
    schemaVersion: lesson.schemaVersion,
    lessonKey: lesson.lessonKey,
    version: lesson.version,
    status: "candidate",
    courseAlias: lesson.courseAlias,
    lessonJson: json(lesson as unknown as CanonicalJsonValue, "lesson"),
    lessonHash: lesson.lessonHash,
    sourceObservationHashesJson: json(lesson.sourceObservationHashes as unknown as CanonicalJsonValue, "lesson.sourceObservationHashes"),
    recordedAt: new Date(lesson.recordedAt),
    validFrom: null,
    validThrough: null,
    supersedesLessonKey: lesson.version > 1 ? lesson.lessonKey : null,
    supersedesVersion: lesson.version > 1 ? lesson.version - 1 : null,
    supersedesLessonHash: lesson.supersedesHash,
    operationKeyHash: opHash,
    containsForumText: false,
    containsDirectIdentity: false,
    assertsCausality: false
  };
}

function applicationRowData(
  application: FacilitationLessonApplication,
  lesson: FacilitationLesson,
  recordedAt: Date,
  opHash: string
): JsonRecord {
  const targetAnchor = parseCommunityInquiryMemoryProjection(application.targetAnchor);
  return {
    schemaVersion: application.schemaVersion,
    applicationKey: canonicalProtocolHash(
      "cmooc.facilitation-lesson-application-key.v1",
      { lessonHash: application.lessonHash, targetAnchor: targetAnchor as unknown as CanonicalJsonValue, candidateKey: application.candidateKey } as unknown as CanonicalJsonValue
    ),
    courseAlias: targetAnchor.courseAlias,
    lessonHash: application.lessonHash,
    targetInvocationId: targetAnchor.invocationId,
    targetWorldSnapshotId: targetAnchor.worldSnapshotId,
    targetGraphSnapshotId: targetAnchor.graphSnapshotId,
    targetCandidateSetId: targetAnchor.candidateSetId,
    targetAsOfAt: new Date(targetAnchor.asOfAt),
    targetAnchorHash: anchorHash(targetAnchor),
    targetAnchorJson: json(targetAnchor, "targetAnchor"),
    sourceObservationHashesJson: json(lesson.sourceObservationHashes as unknown as CanonicalJsonValue, "application.sourceObservationHashes"),
    applicationJson: json(application as unknown as CanonicalJsonValue, "application"),
    applicationHash: application.applicationHash,
    disposition: application.disposition,
    changedFieldsJson: json(application.changedFields as unknown as CanonicalJsonValue, "application.changedFields"),
    reasonCode: application.reasonCode,
    decisionJson: json(application.decision as unknown as CanonicalJsonValue, "application.decision"),
    recordedAt,
    operationKeyHash: opHash,
    containsForumText: false,
    containsDirectIdentity: false,
    assertsCausality: false
  };
}

function reviewHash(input: {
  readonly lessonRevisionId: string;
  readonly lessonHash: string;
  readonly sequence: number;
  readonly action: (typeof REVIEW_ACTIONS)[number];
  readonly reviewerRole: (typeof REVIEW_ROLES)[number];
  readonly reviewerRefHash: string;
  readonly reasonCode: string;
  readonly previousReviewHash: string | null;
  readonly createdAt: Date;
}): string {
  return canonicalProtocolHash(
    FACILITATION_EXPERIENCE_REVIEW_SCHEMA_VERSION,
    {
      schemaVersion: FACILITATION_EXPERIENCE_REVIEW_SCHEMA_VERSION,
      lessonRevisionId: input.lessonRevisionId,
      lessonHash: input.lessonHash,
      sequence: input.sequence,
      action: input.action,
      reviewerRole: input.reviewerRole,
      reviewerRefHash: input.reviewerRefHash,
      reasonCode: input.reasonCode,
      previousReviewHash: input.previousReviewHash,
      createdAt: input.createdAt.toISOString(),
      containsForumText: false
    } as unknown as CanonicalJsonValue
  );
}

function reviewProjection(row: Row, replayed: boolean): FacilitationLessonReviewProjection {
  return {
    id: row.id,
    lessonHash: hashValue(row.lessonHash, "review.lessonHash"),
    lessonKey: identifier(row.lessonKey, "review.lessonKey"),
    version: Number(row.version),
    action: row.action as FacilitationLessonReviewProjection["action"],
    reviewerRole: row.reviewerRole as FacilitationLessonReviewProjection["reviewerRole"],
    reviewerRefHash: hashValue(row.reviewerRefHash, "review.reviewerRefHash"),
    reasonCode: identifier(row.reasonCode, "review.reasonCode"),
    sequence: Number(row.sequence),
    previousReviewHash: row.previousReviewHash == null ? null : hashValue(row.previousReviewHash, "review.previousReviewHash"),
    reviewHash: hashValue(row.reviewHash, "review.reviewHash"),
    createdAt: iso(row.createdAt as Date, "review.createdAt"),
    replayed
  };
}

function observationProjection(row: Row, observation: ExperienceObservation, replayed: boolean): FacilitationExperienceObservationProjection {
  return { id: row.id, observation, replayed };
}

function lessonProjection(row: Row, lesson: FacilitationLesson, replayed: boolean): FacilitationLessonRevisionProjection {
  return { id: row.id, lesson, replayed };
}

function applicationProjection(row: Row, application: FacilitationLessonApplication, replayed: boolean): FacilitationLessonApplicationProjection {
  return { id: row.id, application, recordedAt: iso(row.recordedAt as Date, "application.recordedAt"), replayed };
}

async function existingByOperation(
  db: FacilitationExperienceStoreDb,
  modelName: string,
  opHash: string
): Promise<Row | null> {
  return delegate(db, modelName).findUnique({ where: { operationKeyHash: opHash } });
}

async function assertOperationFree(
  db: FacilitationExperienceStoreDb,
  modelName: string,
  opHash: string,
  contentHash: string,
  field: string
): Promise<Row | null> {
  const existing = await existingByOperation(db, modelName, opHash);
  if (existing && existing[field] !== contentHash) {
    fail("FACILITATION_EXPERIENCE_IDEMPOTENCY_CONFLICT");
  }
  return existing;
}

/** Record a trusted, body-free observation anchored to an existing runtime. */
export async function recordExperienceObservation(input: {
  readonly prisma: FacilitationExperienceStoreDb;
  readonly observation: ExperienceObservation;
  readonly operationKey: string;
}): Promise<FacilitationExperienceObservationProjection> {
  const operation = operationKey(input.operationKey);
  const observation = parseObservation(input.observation);
  const anchor = parseCommunityInquiryMemoryProjection(observation.sourceAnchor);
  const opHash = operationHash("observation", operation);
  return tx(input.prisma, async (db) => {
    const existing = await assertOperationFree(db, "facilitationExperienceObservation", opHash, observation.observationHash, "observationHash");
    if (existing) return observationProjection(existing, observation, true);
    await assertRuntimeAnchor(db, anchor);
    await assertObservationSources(db, anchor, observation.sourceObservationHashes);
    const context = await loadExperienceDecisionContext(db, anchor.courseAlias, observation.decisionKey);
    if (anchorHash(context.anchor) !== anchorHash(anchor) || context.candidate.candidateKey !== observation.candidateKey ||
      json(context.baseline as unknown as CanonicalJsonValue, "baseline") !== json(observation.decision as unknown as CanonicalJsonValue, "decision")) {
      fail("FACILITATION_EXPERIENCE_DECISION_BINDING");
    }
    const sourceRows = await delegate(db, "autonomyObservation").findMany({ where: { receiptHash: { in: observation.sourceObservationHashes } } });
    if (sourceRows.some(row => row.threadKey !== context.decision.threadKey)) fail("FACILITATION_EXPERIENCE_SOURCE_THREAD");
    const sameKey = await delegate(db, "facilitationExperienceObservation").findUnique({
      where: { observationKey_version: { observationKey: observation.observationKey, version: 1 } }
    });
    if (sameKey && sameKey.observationHash !== observation.observationHash) {
      fail("FACILITATION_EXPERIENCE_REVISION_CONFLICT");
    }
    try {
      const row = await delegate(db, "facilitationExperienceObservation").create({
        data: observationRowData(observation, opHash)
      });
      return observationProjection(row, observation, false);
    } catch {
      const raced = await existingByOperation(db, "facilitationExperienceObservation", opHash);
      if (raced && raced.observationHash === observation.observationHash) {
        return observationProjection(raced, observation, true);
      }
      throw new FacilitationExperienceStoreError("FACILITATION_EXPERIENCE_WRITE_CONFLICT");
    }
  });
}

/** Propose a candidate lesson and atomically compare its revision predecessor. */
export async function proposeFacilitationLesson(input: {
  readonly prisma: FacilitationExperienceStoreDb;
  readonly lesson: FacilitationLesson;
  readonly operationKey: string;
}): Promise<FacilitationLessonRevisionProjection> {
  const operation = operationKey(input.operationKey);
  const lesson = parseLesson(input.lesson);
  const anchor = parseCommunityInquiryMemoryProjection(lesson.sourceAnchor);
  const opHash = operationHash("lesson", operation);
  return tx(input.prisma, async (db) => {
    const existing = await assertOperationFree(db, "facilitationLessonRevision", opHash, lesson.lessonHash, "lessonHash");
    if (existing) return lessonProjection(existing, lesson, true);
    await assertRuntimeAnchor(db, anchor);
    await assertLessonSources(db, lesson.courseAlias, lesson.sourceObservationHashes);
    const sourceRows = await delegate(db, "facilitationExperienceObservation").findMany({ where: { observationHash: { in: lesson.sourceObservationHashes } } });
    if (!sourceRows.some(row => row.sourceAnchorHash === anchorHash(anchor)) ||
      sourceRows.some(row => iso(row.recordedAt as Date, "source.recordedAt") > lesson.recordedAt)) fail("FACILITATION_EXPERIENCE_LESSON_SOURCE_TIME");
    const prior = await delegate(db, "facilitationLessonRevision").findUnique({
      where: { lessonKey_version: { lessonKey: lesson.lessonKey, version: lesson.version - 1 } }
    });
    if (lesson.version === 1 && lesson.supersedesHash !== null) {
      fail("FACILITATION_EXPERIENCE_REVISION_CHAIN_INVALID");
    }
    if (lesson.version > 1) {
      if (!prior || prior.lessonHash !== lesson.supersedesHash || prior.courseAlias !== lesson.courseAlias || iso(prior.recordedAt as Date, "prior.recordedAt") > lesson.recordedAt) {
        fail("FACILITATION_EXPERIENCE_REVISION_CAS_FAILED");
      }
      parseLesson(parseJson(prior.lessonJson, "prior.lessonJson"));
    }
    const sameHash = await delegate(db, "facilitationLessonRevision").findUnique({ where: { lessonHash: lesson.lessonHash } });
    if (sameHash) return lessonProjection(sameHash, lesson, true);
    try {
      const row = await delegate(db, "facilitationLessonRevision").create({ data: lessonRowData(lesson, opHash) });
      return lessonProjection(row, lesson, false);
    } catch {
      const raced = await existingByOperation(db, "facilitationLessonRevision", opHash);
      if (raced && raced.lessonHash === lesson.lessonHash) return lessonProjection(raced, lesson, true);
      throw new FacilitationExperienceStoreError("FACILITATION_EXPERIENCE_WRITE_CONFLICT");
    }
  });
}

/** Append an approval/rejection/retraction event using only a branded principal. */
export async function reviewFacilitationLesson(input: {
  readonly prisma: FacilitationExperienceStoreDb;
  readonly lessonHash: string;
  readonly action: (typeof REVIEW_ACTIONS)[number];
  readonly principal: CommunityMemoryApprovalPrincipal;
  readonly operationKey: string;
  readonly reasonCode?: string;
  readonly reviewedAt?: Date | string;
}): Promise<{ readonly review: FacilitationLessonReviewProjection; readonly replayed: boolean }> {
  const lessonHash = hashValue(input.lessonHash, "lessonHash");
  if (!REVIEW_ACTIONS.includes(input.action)) fail("FACILITATION_EXPERIENCE_REVIEW_ACTION_INVALID");
  const operation = operationKey(input.operationKey);
  const reasonCode = identifier(input.reasonCode ?? "reviewed", "reasonCode");
  const opHash = operationHash("review", operation);
  return tx(input.prisma, async (db) => {
    const existing = await existingByOperation(db, "facilitationLessonReview", opHash);
    const revision = await delegate(db, "facilitationLessonRevision").findUnique({ where: { lessonHash } });
    if (!revision) fail("FACILITATION_EXPERIENCE_LESSON_NOT_FOUND");
    const principal = assertCommunityMemoryApprovalPrincipal(input.principal, { courseAlias: revision.courseAlias as string });
    if (existing) {
      if (
        existing.lessonHash !== lessonHash || existing.action !== input.action ||
        existing.reasonCode !== reasonCode || existing.reviewerRole !== principal.reviewerRole ||
        existing.reviewerRefHash !== principal.reviewerRefHash
      ) fail("FACILITATION_EXPERIENCE_IDEMPOTENCY_CONFLICT");
      return { review: reviewProjection(existing, true), replayed: true };
    }
    parseLesson(parseJson(revision.lessonJson, "lessonJson"));
    const latest = await delegate(db, "facilitationLessonReview").findFirst({
      where: { lessonRevisionId: revision.id },
      orderBy: { sequence: "desc" }
    });
    const sequence = Number(latest?.sequence ?? 0) + 1;
    const previousReviewHash = latest?.reviewHash == null ? null : hashValue(latest.reviewHash, "previousReviewHash");
    const createdAt = isoDate(input.reviewedAt ?? new Date(), "reviewedAt");
    if (createdAt < isoDate(revision.recordedAt as Date, "recordedAt") || (latest && createdAt < isoDate(latest.createdAt as Date, "latest.createdAt"))) fail("FACILITATION_EXPERIENCE_REVIEW_TIME");
    const nextHash = reviewHash({
      lessonRevisionId: revision.id,
      lessonHash,
      sequence,
      action: input.action,
      reviewerRole: principal.reviewerRole,
      reviewerRefHash: principal.reviewerRefHash,
      reasonCode,
      previousReviewHash,
      createdAt
    });
    const row = await delegate(db, "facilitationLessonReview").create({
      data: {
        lessonRevisionId: revision.id,
        courseAlias: revision.courseAlias,
        lessonKey: revision.lessonKey,
        version: revision.version,
        lessonHash,
        sequence,
        action: input.action,
        reviewerRole: principal.reviewerRole,
        reviewerRefHash: principal.reviewerRefHash,
        reasonCode,
        previousReviewHash,
        reviewHash: nextHash,
        operationKeyHash: opHash,
        createdAt,
        containsForumText: false
      }
    });
    return { review: reviewProjection(row, false), replayed: false };
  });
}

type AcceptedLesson = { row: Row; lesson: FacilitationLesson; acceptedAt: string; review: Row };

async function approvedLessonsAsOf(
  db: FacilitationExperienceStoreDb,
  courseAlias: string,
  cutoff: Date
): Promise<AcceptedLesson[]> {
  const rows = await delegate(db, "facilitationLessonRevision").findMany({ where: { courseAlias }, orderBy: [{ lessonKey: "asc" }, { version: "asc" }] });
  const accepted: AcceptedLesson[] = [];
  for (const row of rows) {
    const lesson = parseLesson(parseJson(row.lessonJson, "lessonJson"));
    const currentReview = await delegate(db, "facilitationLessonReview").findFirst({ where: { lessonRevisionId: row.id }, orderBy: { sequence: "desc" } });
    if (currentReview?.action === "retracted" || currentReview?.action === "rejected") continue;
    if (lesson.courseAlias !== courseAlias || Date.parse(lesson.recordedAt) > cutoff.getTime()) continue;
    await assertLessonSources(db, courseAlias, lesson.sourceObservationHashes);
    const reviews = (await delegate(db, "facilitationLessonReview").findMany({
      where: { lessonRevisionId: row.id, createdAt: { lte: cutoff } },
      orderBy: { sequence: "asc" }
    }));
    if (reviews.length === 0) continue;
    let previous: string | null = null;
    let expectedSequence = 1;
    for (const review of reviews) {
      if (Number(review.sequence) !== expectedSequence || review.previousReviewHash !== previous || review.lessonHash !== lesson.lessonHash) {
        return [];
      }
      const computed = reviewHash({
        lessonRevisionId: row.id,
        lessonHash: lesson.lessonHash,
        sequence: expectedSequence,
        action: review.action as (typeof REVIEW_ACTIONS)[number],
        reviewerRole: review.reviewerRole as (typeof REVIEW_ROLES)[number],
        reviewerRefHash: hashValue(review.reviewerRefHash, "review.reviewerRefHash"),
        reasonCode: identifier(review.reasonCode, "review.reasonCode"),
        previousReviewHash: previous,
        createdAt: isoDate(review.createdAt as Date, "review.createdAt")
      });
      if (computed !== review.reviewHash || !REVIEW_ROLES.includes(review.reviewerRole as (typeof REVIEW_ROLES)[number])) return [];
      previous = review.reviewHash as string;
      expectedSequence += 1;
    }
    const head = reviews.at(-1);
    if (head?.action === "approved") {
      accepted.push({ row, lesson, acceptedAt: iso(head.createdAt as Date, "acceptedAt"), review: head });
    }
  }
  return accepted;
}

/** Return approved lessons applicable at an as-of cutoff, failing closed on branches. */
export async function listApplicableFacilitationLessons(input: {
  readonly prisma: FacilitationExperienceStoreDb;
  readonly courseAlias: string;
  readonly asOfAt: Date | string;
}): Promise<readonly { readonly lesson: FacilitationLesson; readonly acceptedAt: string }[]> {
  const courseAlias = identifier(input.courseAlias, "courseAlias");
  const cutoff = isoDate(input.asOfAt, "asOfAt");
  const accepted = await approvedLessonsAsOf(input.prisma, courseAlias, cutoff);
  if (accepted.length === 0) return [];
  const byHash = new Map(accepted.map((item) => [item.lesson.lessonHash, item]));
  const superseded = new Set<string>();
  // A withdrawn successor does not silently reactivate an older method.
  // Only a candidate that was never accepted leaves the previous head active.
  const promoted = await delegate(input.prisma, "facilitationLessonReview").findMany({
    where: { courseAlias, action: "approved", createdAt: { lte: cutoff } }
  });
  for (const promotion of promoted) {
    const revision = await delegate(input.prisma, "facilitationLessonRevision").findUnique({ where: { lessonHash: promotion.lessonHash } });
    if (revision?.supersedesLessonHash) superseded.add(revision.supersedesLessonHash as string);
  }
  for (const item of accepted) {
    let next = item.lesson.supersedesHash;
    const seen = new Set<string>();
    while (next) {
      if (seen.has(next)) return [];
      seen.add(next);
      if (byHash.has(next)) superseded.add(next);
      const ancestor = await delegate(input.prisma, "facilitationLessonRevision").findUnique({ where: { lessonHash: next } });
      if (!ancestor) break;
      const ancestorLesson = parseLesson(parseJson(ancestor.lessonJson, "ancestor.lessonJson"));
      next = ancestorLesson.supersedesHash;
    }
  }
  const heads = accepted.filter((item) => !superseded.has(item.lesson.lessonHash));
  const byLessonKey = new Map<string, AcceptedLesson[]>();
  for (const item of heads) {
    const group = byLessonKey.get(item.lesson.lessonKey) ?? [];
    group.push(item);
    byLessonKey.set(item.lesson.lessonKey, group);
  }
  for (const group of byLessonKey.values()) if (group.length > 1) return [];
  return heads.sort((left, right) => left.lesson.lessonKey.localeCompare(right.lesson.lessonKey) || left.lesson.version - right.lesson.version).map((item) => ({ lesson: item.lesson, acceptedAt: item.acceptedAt }));
}

async function assertBrowserFactsApplicationBound(input: {
  readonly db: FacilitationExperienceStoreDb;
  readonly application: FacilitationLessonApplication;
  readonly decisionKey: string;
}): Promise<void> {
  const rows = await delegate(input.db, "decisionTapeEntry").findMany({
    where: {
      invocationId: input.application.targetAnchor.invocationId,
      kind: "community_experience_facts_v1",
      payloadJson: { contains: input.decisionKey }
    },
    orderBy: { sequence: "desc" },
    take: 64
  });
  for (const row of rows) {
    try {
      const payload = parseExperienceFactsTapePayload(JSON.parse(row.payloadJson as string), {
        courseAlias: input.application.targetAnchor.courseAlias,
        decisionKey: input.decisionKey,
        anchor: input.application.targetAnchor
      });
      const selection = selectExperienceFacts({
        records: payload.records,
        courseAlias: input.application.targetAnchor.courseAlias,
        decisionKey: input.decisionKey,
        anchor: input.application.targetAnchor
      });
      if (
        selection.factsSource !== "browser_interpretation" ||
        selection.evaluationMode !== "post_hoc_browser_interpretation" ||
        selection.evaluatedAt !== input.application.evaluatedAt
      ) continue;
      const keys = ["activity_phase", "purpose_compatible", "peer_continuation", "teacher_required"] as const;
      if (keys.every((key) =>
        (input.application.facts[key] ?? "unknown") === (selection.facts[key] ?? "unknown")
      )) return;
    } catch {
      // Ignore another invocation/anchor and keep looking for an exact match.
    }
  }
  fail("FACILITATION_EXPERIENCE_BROWSER_FACTS_UNBOUND");
}

/** Persist an application of a lesson to a new target anchor. */
export async function recordLessonApplication(input: {
  readonly prisma: FacilitationExperienceStoreDb;
  readonly application: FacilitationLessonApplication;
  readonly principal?: CommunityMemoryApprovalPrincipal;
  readonly operationKey: string;
  readonly recordedAt?: Date | string;
}): Promise<FacilitationLessonApplicationProjection> {
  const operation = operationKey(input.operationKey);
  const application = parseApplication(input.application);
  const opHash = operationHash("application", operation);
  return tx(input.prisma, async (db) => {
    const existing = await assertOperationFree(db, "facilitationLessonApplication", opHash, application.applicationHash, "applicationHash");
    if (existing) return applicationProjection(existing, application, true);
    const lessonRow = await delegate(db, "facilitationLessonRevision").findUnique({ where: { lessonHash: application.lessonHash } });
    if (!lessonRow) fail("FACILITATION_EXPERIENCE_LESSON_NOT_FOUND");
    const lesson = parseLesson(parseJson(lessonRow.lessonJson, "lessonJson"));
    if (lesson.courseAlias !== application.targetAnchor.courseAlias) fail("FACILITATION_EXPERIENCE_COURSE_MISMATCH");
    await assertRuntimeAnchor(db, application.targetAnchor);
    await assertLessonSources(db, lesson.courseAlias, lesson.sourceObservationHashes);
    const applicable = await listApplicableFacilitationLessons({ prisma: db, courseAlias: lesson.courseAlias, asOfAt: application.targetAnchor.asOfAt });
    const accepted = applicable.find((item) => item.lesson.lessonHash === application.lessonHash);
    if (!accepted || accepted.acceptedAt !== application.acceptedAt) fail("FACILITATION_EXPERIENCE_LESSON_NOT_APPROVED_AS_OF");
    if (anchorHash(application.sourceAnchor) !== anchorHash(lesson.sourceAnchor)) fail("FACILITATION_EXPERIENCE_SOURCE_ANCHOR_MISMATCH");
    if (application.factsSource === "host_judgement") {
      const principal = assertCommunityMemoryApprovalPrincipal(input.principal, { courseAlias: lesson.courseAlias });
      if (Date.parse(principal.issuedAt) < Date.parse(application.evaluatedAt)) fail("FACILITATION_EXPERIENCE_EVALUATION_TIME");
    }
    const candidateRow = await delegate(db, "candidateSet").findUnique({ where: { id: application.targetAnchor.candidateSetId } });
    const set = parseJson(candidateRow?.candidatesJson, "candidatesJson") as { candidates: { candidateKey: string; threadKey: string }[] };
    const candidate = set.candidates.find(value => value.candidateKey === application.candidateKey);
    if (!candidate) fail("FACILITATION_EXPERIENCE_TARGET_MISSING");
    const decisionRow = await delegate(db, "autonomyDecision").findUnique({ where: { invocationId_threadKey: { invocationId: application.targetAnchor.invocationId, threadKey: candidate.threadKey } } });
    if (!decisionRow) fail("FACILITATION_EXPERIENCE_TARGET_DECISION_MISSING");
    if (application.factsSource === "browser_interpretation") {
      await assertBrowserFactsApplicationBound({
        db,
        application,
        decisionKey: decisionRow.decisionKey as string
      });
    }
    const context = await loadExperienceDecisionContext(db, lesson.courseAlias, decisionRow.decisionKey as string);
    const rebuilt = applyFacilitationLesson({ lesson, targetAnchor: context.anchor, candidateKey: application.candidateKey,
      baseline: context.baseline, acceptedAt: accepted.acceptedAt, evaluatedAt: application.evaluatedAt, facts: { ...application.facts, factsSource: application.factsSource } });
    if (rebuilt.applicationHash !== application.applicationHash) fail("FACILITATION_EXPERIENCE_APPLICATION_RECOMPUTE");
    const recordedAt = isoDate(input.recordedAt ?? new Date(), "recordedAt");
    const row = await delegate(db, "facilitationLessonApplication").create({
      data: applicationRowData(application, lesson, recordedAt, opHash)
    });
    return applicationProjection(row, application, false);
  });
}

/** A body-free, frontend-safe read model for one course. */
export async function listCourseExperience(input: {
  readonly prisma: FacilitationExperienceStoreDb;
  readonly courseAlias: string;
}): Promise<CourseExperienceSafeReadModel> {
  const courseAlias = identifier(input.courseAlias, "courseAlias");
  const [observationRows, lessonRows, reviewRows, applicationRows] = await Promise.all([
    delegate(input.prisma, "facilitationExperienceObservation").findMany({ where: { courseAlias }, orderBy: [{ observedAt: "asc" }, { observationKey: "asc" }] }),
    delegate(input.prisma, "facilitationLessonRevision").findMany({ where: { courseAlias }, orderBy: [{ lessonKey: "asc" }, { version: "asc" }] }),
    delegate(input.prisma, "facilitationLessonReview").findMany({ where: { courseAlias }, orderBy: [{ createdAt: "asc" }, { sequence: "asc" }] }),
    delegate(input.prisma, "facilitationLessonApplication").findMany({ where: { courseAlias }, orderBy: [{ targetAsOfAt: "asc" }, { recordedAt: "asc" }] })
  ]);
  const observations: CourseExperienceSafeObservation[] = [];
  for (const row of observationRows) {
    try {
      const observation = parseObservation(parseJson(row.observationJson, "observationJson"));
      observations.push({
        observationKey: observation.observationKey,
        version: Number(row.version),
        observationHash: observation.observationHash,
        sourceAnchorHash: row.sourceAnchorHash as string,
        sourceObservationHashes: [...observation.sourceObservationHashes],
        observedAt: iso(row.observedAt as Date, "observedAt"),
        recordedAt: iso(row.recordedAt as Date, "recordedAt")
      });
    } catch {
      // Do not expose malformed or tampered rows to a frontend read model.
    }
  }
  const reviews: CourseExperienceSafeReview[] = [];
  const latestByLessonHash = new Map<string, Row>();
  for (const row of reviewRows) {
    try {
      const projection = reviewProjection(row, false);
      reviews.push({ lessonHash: projection.lessonHash, action: projection.action, reviewerRole: projection.reviewerRole, reviewHash: projection.reviewHash, reasonCode: projection.reasonCode, createdAt: projection.createdAt });
      latestByLessonHash.set(projection.lessonHash, row);
    } catch {
      // Keep the safe list fail-closed for malformed review rows.
    }
  }
  const lessons: CourseExperienceSafeLesson[] = [];
  for (const row of lessonRows) {
    try {
      const lesson = parseLesson(parseJson(row.lessonJson, "lessonJson"));
      const latest = latestByLessonHash.get(lesson.lessonHash);
      const status = latest?.action === "approved" ? "approved" : latest?.action === "rejected" ? "rejected" : latest?.action === "retracted" ? "retracted" : "candidate";
      lessons.push({
        lessonKey: lesson.lessonKey,
        version: lesson.version,
        lessonHash: lesson.lessonHash,
        status,
        method: lesson.method,
        reason: lesson.reason,
        sourceAnchorHash: anchorHash(lesson.sourceAnchor),
        sourceObservationHashes: [...lesson.sourceObservationHashes],
        supersedesHash: lesson.supersedesHash,
        recordedAt: lesson.recordedAt,
        acceptedAt: latest?.action === "approved" ? iso(latest.createdAt as Date, "acceptedAt") : null
      });
    } catch {
      // Do not expose malformed or tampered rows to a frontend read model.
    }
  }
  const applications: CourseExperienceSafeApplication[] = [];
  for (const row of applicationRows) {
    try {
      const application = parseApplication(parseJson(row.applicationJson, "applicationJson"));
      applications.push({
        applicationHash: application.applicationHash,
        lessonHash: application.lessonHash,
        targetAnchorHash: row.targetAnchorHash as string,
        candidateKey: application.candidateKey,
        acceptedAt: application.acceptedAt,
        evaluatedAt: application.evaluatedAt, evaluationMode: application.evaluationMode,
        recordedAt: iso(row.recordedAt as Date, "recordedAt"),
        disposition: application.disposition,
        changedFields: [...application.changedFields],
        reasonCode: application.reasonCode,
        decision: application.decision
      });
    } catch {
      // Do not expose malformed or tampered rows to a frontend read model.
    }
  }
  return {
    courseAlias,
    observations,
    lessons,
    reviews,
    applications,
    containsForumText: false,
    containsDirectIdentity: false,
    assertsCausality: false
  };
}
