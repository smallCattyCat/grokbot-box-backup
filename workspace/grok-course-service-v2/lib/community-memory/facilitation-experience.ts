import { z } from "zod";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  parseCommunityInquiryMemoryProjection,
  type CommunityInquiryMemoryProjection
} from "./inquiry-memory";
import type { RelationalActivityPhase } from "./relational-opportunity";
import type {
  CommunityInquiryShadowDecision,
  CommunityInquiryShadowDecisionField
} from "./shadow-comparison";

/**
 * Pure, body-free contracts for carrying one observed facilitation episode
 * into a bounded, reusable lesson.  This module deliberately does not load
 * a course, choose a production target, or grant a publication capability.
 */
export const FACILITATION_EXPERIENCE_OBSERVATION_SCHEMA_VERSION =
  "cmooc.facilitation-experience-observation.v1" as const;
export const FACILITATION_LESSON_SCHEMA_VERSION =
  "cmooc.facilitation-lesson.v1" as const;
export const FACILITATION_LESSON_APPLICATION_SCHEMA_VERSION =
  "cmooc.facilitation-lesson-application.v1" as const;

export const FACILITATION_METHODS = [
  "resource_connection",
  "preserve_peer_opportunity",
  "teacher_handoff"
] as const;
export type FacilitationMethod = (typeof FACILITATION_METHODS)[number];

export const FACILITATION_CONDITION_KEYS = [
  "activity_phase",
  "purpose_compatible",
  "peer_continuation",
  "teacher_required"
] as const;
export type FacilitationConditionKey =
  (typeof FACILITATION_CONDITION_KEYS)[number];

export const FACILITATION_LESSON_DISPOSITIONS = [
  "adopted",
  "rejected",
  "needs_check"
] as const;
export type FacilitationLessonDisposition =
  (typeof FACILITATION_LESSON_DISPOSITIONS)[number];

export const FACILITATION_FACT_SOURCES = [
  "host_judgement",
  "runtime_observation",
  "browser_interpretation"
] as const;
export type FacilitationFactsSource = (typeof FACILITATION_FACT_SOURCES)[number];

export const FACILITATION_EVALUATION_MODES = [
  "as_of",
  "post_hoc_host_review",
  "post_hoc_browser_interpretation"
] as const;
export type FacilitationEvaluationMode =
  (typeof FACILITATION_EVALUATION_MODES)[number];

export const FACILITATION_FACT_VALUES = [
  "true",
  "false",
  "unknown",
  "conflict"
] as const;
export type FacilitationFactValue = (typeof FACILITATION_FACT_VALUES)[number];

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const FORBIDDEN_SHORT_TEXT_PATTERN =
  /(?:https?:\/\/|www\.|mailto:|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:bearer|basic|satoken|cookie)\b[\s:=]+[A-Z0-9._~+\/-]{8,})/iu;
const FORBIDDEN_CONTROL_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const ISO_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;

const activityPhases = [
  "question_opening",
  "explanation_development",
  "peer_review",
  "resource_connection",
  "collaborative_progress",
  "task_reentry",
  "unknown"
] as const satisfies readonly RelationalActivityPhase[];

const decisionValues = ["DRAFT", "WAIT", "ABSTAIN", "YIELD"] as const;

function validIso(value: string): boolean {
  return ISO_TIME_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function safeShortText(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    normalized.length <= 320 &&
    !FORBIDDEN_CONTROL_PATTERN.test(normalized) &&
    !/<\/?[a-z][^>]*>/iu.test(normalized) &&
    !FORBIDDEN_SHORT_TEXT_PATTERN.test(normalized)
  );
}

const hashSchema = z
  .string()
  .length(64)
  .regex(HASH_PATTERN, "必须是小写 SHA-256 哈希");
const identifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(IDENTIFIER_PATTERN, "必须是受限标识符");
const codeSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(CODE_PATTERN, "必须是受限代码");
const isoSchema = z
  .string()
  .refine(validIso, "必须是带时区的 ISO-8601 时间");
const shortReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .refine(safeShortText, "只能是有限的去正文短摘要");

const sourceAnchorSchema = z
  .object({
    courseAlias: identifierSchema,
    invocationId: identifierSchema,
    worldSnapshotId: identifierSchema,
    graphSnapshotId: identifierSchema,
    candidateSetId: identifierSchema,
    asOfAt: isoSchema,
    worldHash: hashSchema,
    graphHash: hashSchema,
    candidateSetHash: hashSchema
  })
  .strict();

const shadowDecisionSchema = z
  .object({
    decision: z.enum(decisionValues),
    targetKey: codeSchema.nullable(),
    facilitationFunction: codeSchema.nullable(),
    responsibility: codeSchema.nullable(),
    reasonCode: codeSchema
  })
  .strict();

const observationFeedbackSchema = z
  .object({
    kind: z.enum(["host_correction", "runtime_observation"]),
    reason: shortReasonSchema
  })
  .strict();

const observationEvidenceLevelSchema = z.enum([
  "shadow",
  "local_synthetic",
  "observed_process"
]);

/** Input contract for an observed, body-free facilitation episode. */
export const experienceObservationSchema = z
  .object({
    observationKey: identifierSchema,
    sourceAnchor: sourceAnchorSchema,
    candidateKey: codeSchema,
    decisionKey: codeSchema,
    recordedAt: isoSchema,
    decision: shadowDecisionSchema,
    feedback: observationFeedbackSchema,
    evidenceLevel: observationEvidenceLevelSchema,
    sourceObservationHashes: z.array(hashSchema).min(1).max(64)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.sourceObservationHashes).size !== value.sourceObservationHashes.length) {
      context.addIssue({
        code: "custom",
        path: ["sourceObservationHashes"],
        message: "sourceObservationHashes 不能重复"
      });
    }
    if (value.recordedAt && validIso(value.sourceAnchor.asOfAt)) {
      if (Date.parse(value.recordedAt) < Date.parse(value.sourceAnchor.asOfAt)) {
        context.addIssue({
          code: "custom",
          path: ["recordedAt"],
          message: "recordedAt 不能早于 sourceAnchor.asOfAt"
        });
      }
    }
  });

export type ExperienceObservationInput = z.input<
  typeof experienceObservationSchema
>;

export type ExperienceObservation = ExperienceObservationInput & {
  readonly schemaVersion: typeof FACILITATION_EXPERIENCE_OBSERVATION_SCHEMA_VERSION;
  readonly observationHash: string;
  readonly containsForumText: false;
  readonly containsDirectIdentity: false;
  readonly assertsCausality: false;
};

const conditionExpectedSchema = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .refine(
    (value) =>
      !FORBIDDEN_CONTROL_PATTERN.test(value) &&
      !/<\/?[a-z][^>]*>/iu.test(value) &&
      !FORBIDDEN_SHORT_TEXT_PATTERN.test(value),
    "条件必须是有界去正文值"
  );
const lessonConditionSchema = z
  .object({
    key: z.enum(FACILITATION_CONDITION_KEYS),
    expected: conditionExpectedSchema
  })
  .strict();

/** Input contract for a reusable, explicitly conditioned facilitation lesson. */
export const facilitationLessonSchema = z
  .object({
    courseAlias: identifierSchema,
    lessonKey: identifierSchema,
    version: z.number().int().positive().safe(),
    sourceObservationHashes: z.array(hashSchema).min(1).max(64),
    sourceAnchor: sourceAnchorSchema,
    recordedAt: isoSchema,
    method: z.enum(FACILITATION_METHODS),
    activityPhase: z.enum(activityPhases),
    conditions: z.array(lessonConditionSchema).min(1).max(4),
    reason: shortReasonSchema,
    supersedesHash: hashSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.sourceObservationHashes).size !== value.sourceObservationHashes.length) {
      context.addIssue({
        code: "custom",
        path: ["sourceObservationHashes"],
        message: "sourceObservationHashes 不能重复"
      });
    }
    if (new Set(value.conditions.map((condition) => condition.key)).size !== value.conditions.length) {
      context.addIssue({
        code: "custom",
        path: ["conditions"],
        message: "conditions 的 key 不能重复"
      });
    }
    if (value.recordedAt && validIso(value.sourceAnchor.asOfAt)) {
      if (Date.parse(value.recordedAt) < Date.parse(value.sourceAnchor.asOfAt)) {
        context.addIssue({
          code: "custom",
          path: ["recordedAt"],
          message: "recordedAt 不能早于 sourceAnchor.asOfAt"
        });
      }
    }
  });

export type FacilitationLessonInput = z.input<typeof facilitationLessonSchema>;

export type FacilitationLesson = FacilitationLessonInput & {
  readonly schemaVersion: typeof FACILITATION_LESSON_SCHEMA_VERSION;
  readonly lessonHash: string;
};

export type FacilitationFacts = {
  readonly activity_phase?: string;
  readonly purpose_compatible?: string;
  readonly peer_continuation?: string;
  readonly teacher_required?: string;
};

export type FacilitationLessonApplication = {
  readonly schemaVersion: typeof FACILITATION_LESSON_APPLICATION_SCHEMA_VERSION;
  readonly lessonHash: string;
  readonly sourceAnchor: CommunityInquiryMemoryProjection;
  readonly targetAnchor: CommunityInquiryMemoryProjection;
  readonly candidateKey: string;
  readonly acceptedAt: string;
  readonly evaluationMode: FacilitationEvaluationMode;
  readonly evaluatedAt: string;
  readonly facts: FacilitationFacts;
  readonly factsSource: FacilitationFactsSource;
  readonly disposition: FacilitationLessonDisposition;
  readonly reasonCode: string;
  readonly decision: CommunityInquiryShadowDecision;
  readonly changedFields: readonly CommunityInquiryShadowDecisionField[];
  readonly publishAllowed: false;
  readonly applicationHash: string;
};

export type ApplyFacilitationLessonInput = {
  readonly lesson: FacilitationLesson;
  readonly targetAnchor: CommunityInquiryMemoryProjection;
  readonly candidateKey: string;
  readonly baseline: CommunityInquiryShadowDecision;
  readonly facts: FacilitationFacts & {
    readonly factsSource?: FacilitationFactsSource;
  };
  readonly acceptedAt: string;
  readonly evaluatedAt?: string;
};

const lessonRecordSchema = z
  .object({
    schemaVersion: z.literal(FACILITATION_LESSON_SCHEMA_VERSION),
    courseAlias: identifierSchema,
    lessonKey: identifierSchema,
    version: z.number().int().positive().safe(),
    sourceObservationHashes: z.array(hashSchema).min(1).max(64),
    sourceAnchor: sourceAnchorSchema,
    recordedAt: isoSchema,
    method: z.enum(FACILITATION_METHODS),
    activityPhase: z.enum(activityPhases),
    conditions: z.array(lessonConditionSchema).min(1).max(4),
    reason: shortReasonSchema,
    supersedesHash: hashSchema.nullable(),
    lessonHash: hashSchema
  })
  .strict();

const observationRecordSchema = z
  .object({
    schemaVersion: z.literal(FACILITATION_EXPERIENCE_OBSERVATION_SCHEMA_VERSION),
    observationKey: identifierSchema,
    sourceAnchor: sourceAnchorSchema,
    candidateKey: codeSchema,
    decisionKey: codeSchema,
    recordedAt: isoSchema,
    decision: shadowDecisionSchema,
    feedback: observationFeedbackSchema,
    evidenceLevel: observationEvidenceLevelSchema,
    sourceObservationHashes: z.array(hashSchema).min(1).max(64),
    observationHash: hashSchema,
    containsForumText: z.literal(false),
    containsDirectIdentity: z.literal(false),
    assertsCausality: z.literal(false)
  })
  .strict();

const observationHashBody = (value: {
  readonly observationKey: string;
  readonly sourceAnchor: CommunityInquiryMemoryProjection;
  readonly candidateKey: string;
  readonly decisionKey: string;
  readonly recordedAt: string;
  readonly decision: CommunityInquiryShadowDecision;
  readonly feedback: ExperienceObservationInput["feedback"];
  readonly evidenceLevel: ExperienceObservationInput["evidenceLevel"];
  readonly sourceObservationHashes: readonly string[];
}): Record<string, unknown> => ({
  schemaVersion: FACILITATION_EXPERIENCE_OBSERVATION_SCHEMA_VERSION,
  observationKey: value.observationKey,
  sourceAnchor: value.sourceAnchor,
  candidateKey: value.candidateKey,
  decisionKey: value.decisionKey,
  recordedAt: value.recordedAt,
  decision: value.decision,
  feedback: value.feedback,
  evidenceLevel: value.evidenceLevel,
  sourceObservationHashes: value.sourceObservationHashes
});

function lessonHashBody(value: {
  readonly courseAlias: string;
  readonly lessonKey: string;
  readonly version: number;
  readonly sourceObservationHashes: readonly string[];
  readonly sourceAnchor: CommunityInquiryMemoryProjection;
  readonly recordedAt: string;
  readonly method: FacilitationMethod;
  readonly activityPhase: RelationalActivityPhase;
  readonly conditions: readonly { key: FacilitationConditionKey; expected: string }[];
  readonly reason: string;
  readonly supersedesHash: string | null;
}): Record<string, unknown> {
  return {
    schemaVersion: FACILITATION_LESSON_SCHEMA_VERSION,
    courseAlias: value.courseAlias,
    lessonKey: value.lessonKey,
    version: value.version,
    sourceObservationHashes: value.sourceObservationHashes,
    sourceAnchor: value.sourceAnchor,
    recordedAt: value.recordedAt,
    method: value.method,
    activityPhase: value.activityPhase,
    conditions: value.conditions,
    reason: value.reason,
    supersedesHash: value.supersedesHash
  };
}

function applicationHashBody(value: Omit<FacilitationLessonApplication, "applicationHash">): Record<string, unknown> {
  return {
    schemaVersion: value.schemaVersion,
    lessonHash: value.lessonHash,
    sourceAnchor: value.sourceAnchor,
    targetAnchor: value.targetAnchor,
    candidateKey: value.candidateKey,
    acceptedAt: value.acceptedAt,
    evaluationMode: value.evaluationMode,
    evaluatedAt: value.evaluatedAt,
    facts: value.facts,
    factsSource: value.factsSource,
    disposition: value.disposition,
    reasonCode: value.reasonCode,
    decision: value.decision,
    changedFields: value.changedFields,
    publishAllowed: value.publishAllowed
  };
}

function fail(code: string, message = code): never {
  throw new Error(`${code}: ${message}`);
}

function normalizeAnchor(value: unknown): CommunityInquiryMemoryProjection {
  return parseCommunityInquiryMemoryProjection(value);
}

function normalizeIso(value: string, label: string): string {
  if (!validIso(value)) fail("FACILITATION_EXPERIENCE_TIME_INVALID", `${label} 无效。`);
  return new Date(value).toISOString();
}

type EvaluationMetadata = {
  readonly evaluationMode: FacilitationEvaluationMode;
  readonly evaluatedAt: string;
};

function resolveEvaluationMetadata(input: {
  readonly targetAnchor: CommunityInquiryMemoryProjection;
  readonly factsSource: FacilitationFactsSource;
  readonly evaluatedAt?: string;
  readonly evaluationMode?: FacilitationEvaluationMode;
}): EvaluationMetadata {
  const targetAsOf = input.targetAnchor.asOfAt;
  if (input.factsSource === "runtime_observation") {
    const evaluatedAt = input.evaluatedAt === undefined
      ? targetAsOf
      : normalizeIso(input.evaluatedAt, "evaluatedAt");
    if (evaluatedAt !== targetAsOf) {
      fail(
        "FACILITATION_EXPERIENCE_RUNTIME_EVALUATED_AT_MISMATCH",
        "runtime_observation 的 evaluatedAt 必须等于 targetAnchor.asOfAt。"
      );
    }
    const evaluationMode = "as_of" as const;
    if (input.evaluationMode !== undefined && input.evaluationMode !== evaluationMode) {
      fail("FACILITATION_EXPERIENCE_EVALUATION_MODE_INVALID");
    }
    return { evaluationMode, evaluatedAt };
  }
  if (input.factsSource === "browser_interpretation") {
    if (input.evaluatedAt === undefined) {
      fail(
        "FACILITATION_EXPERIENCE_BROWSER_EVALUATED_AT_REQUIRED",
        "browser_interpretation 必须显式提供 interpretedAt。"
      );
    }
    const evaluatedAt = normalizeIso(input.evaluatedAt, "evaluatedAt");
    if (Date.parse(evaluatedAt) < Date.parse(targetAsOf)) {
      fail(
        "FACILITATION_EXPERIENCE_BROWSER_EVALUATED_AT_BEFORE_TARGET",
        "browser_interpretation 的 evaluatedAt 不能早于 targetAnchor.asOfAt。"
      );
    }
    const evaluationMode = "post_hoc_browser_interpretation" as const;
    if (input.evaluationMode !== undefined && input.evaluationMode !== evaluationMode) {
      fail("FACILITATION_EXPERIENCE_EVALUATION_MODE_INVALID");
    }
    return { evaluationMode, evaluatedAt };
  }
  if (input.evaluatedAt === undefined) {
    fail(
      "FACILITATION_EXPERIENCE_HOST_EVALUATED_AT_REQUIRED",
      "host_judgement 必须显式提供 evaluatedAt。"
    );
  }
  const evaluatedAt = normalizeIso(input.evaluatedAt, "evaluatedAt");
  if (Date.parse(evaluatedAt) < Date.parse(targetAsOf)) {
    fail(
      "FACILITATION_EXPERIENCE_HOST_EVALUATED_AT_BEFORE_TARGET",
      "host_judgement 的 evaluatedAt 不能早于 targetAnchor.asOfAt。"
    );
  }
  const evaluationMode = "post_hoc_host_review" as const;
  if (input.evaluationMode !== undefined && input.evaluationMode !== evaluationMode) {
    fail("FACILITATION_EXPERIENCE_EVALUATION_MODE_INVALID");
  }
  return { evaluationMode, evaluatedAt };
}

function normalizeSourceHashes(value: readonly string[], label: string): readonly string[] {
  const hashes = [...value].sort();
  if (new Set(hashes).size !== hashes.length) {
    fail("FACILITATION_EXPERIENCE_HASH_DUPLICATE", `${label} 不能重复。`);
  }
  return hashes;
}

function normalizeDecision(value: unknown, label: string): CommunityInquiryShadowDecision {
  const parsed = shadowDecisionSchema.parse(value);
  return {
    decision: parsed.decision,
    targetKey: parsed.targetKey,
    facilitationFunction: parsed.facilitationFunction,
    responsibility: parsed.responsibility,
    reasonCode: parsed.reasonCode
  } satisfies CommunityInquiryShadowDecision;
}

function normalizeConditions(
  value: readonly { key: FacilitationConditionKey; expected: string }[]
): readonly { key: FacilitationConditionKey; expected: string }[] {
  const conditions = value.map((condition) => ({
    key: condition.key,
    expected: condition.expected.trim()
  }));
  if (new Set(conditions.map((condition) => condition.key)).size !== conditions.length) {
    fail("FACILITATION_LESSON_CONDITION_DUPLICATE");
  }
  return conditions.sort((left, right) => left.key.localeCompare(right.key));
}

function changedFields(
  baseline: CommunityInquiryShadowDecision,
  decision: CommunityInquiryShadowDecision
): readonly CommunityInquiryShadowDecisionField[] {
  const fields: readonly CommunityInquiryShadowDecisionField[] = [
    "decision",
    "targetKey",
    "facilitationFunction",
    "responsibility",
    "reasonCode"
  ];
  return fields.filter((field) => baseline[field] !== decision[field]);
}

function asFacts(value: ApplyFacilitationLessonInput["facts"]): {
  readonly facts: FacilitationFacts;
  readonly factsSource: FacilitationFactsSource;
} {
  const factsSource = value.factsSource ?? "runtime_observation";
  if (!FACILITATION_FACT_SOURCES.includes(factsSource)) {
    fail("FACILITATION_FACT_SOURCE_INVALID");
  }
  const normalized: FacilitationFacts = {};
  const keys: readonly (keyof FacilitationFacts)[] = [
    "activity_phase",
    "purpose_compatible",
    "peer_continuation",
    "teacher_required"
  ];
  for (const key of keys) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      fail("FACILITATION_FACT_INVALID", `${key} 必须是非空字符串。`);
    }
    (normalized as Record<string, string>)[key] = raw.trim().toLowerCase();
  }
  return { facts: normalized, factsSource };
}

function factValue(
  facts: FacilitationFacts,
  key: FacilitationConditionKey
): string | undefined {
  return facts[key];
}

function validFactValue(value: string): value is FacilitationFactValue {
  return FACILITATION_FACT_VALUES.includes(value as FacilitationFactValue);
}

function validFactValueForKey(
  key: keyof FacilitationFacts,
  value: string
): boolean {
  if (key === "activity_phase") {
    return activityPhases.includes(value as RelationalActivityPhase);
  }
  return validFactValue(value);
}

function application(
  input: Omit<FacilitationLessonApplication, "applicationHash">
): FacilitationLessonApplication {
  const body = applicationHashBody(input);
  return {
    ...input,
    applicationHash: canonicalProtocolHash(
      FACILITATION_LESSON_APPLICATION_SCHEMA_VERSION,
      body as unknown as CanonicalJsonValue
    )
  };
}

/** Build a normalized, hash-bound observation without retaining forum text. */
export function buildExperienceObservation(
  rawInput: ExperienceObservationInput
): ExperienceObservation {
  const input = experienceObservationSchema.parse(rawInput);
  const sourceAnchor = normalizeAnchor(input.sourceAnchor);
  const recordedAt = normalizeIso(input.recordedAt, "recordedAt");
  if (Date.parse(recordedAt) < Date.parse(sourceAnchor.asOfAt)) {
    fail("FACILITATION_OBSERVATION_FUTURE_SOURCE", "recordedAt 早于 sourceAnchor.asOfAt。");
  }
  const decision = normalizeDecision(input.decision, "decision");
  const sourceObservationHashes = normalizeSourceHashes(
    input.sourceObservationHashes,
    "sourceObservationHashes"
  );
  const feedback = {
    kind: input.feedback.kind,
    reason: input.feedback.reason.trim()
  } satisfies ExperienceObservationInput["feedback"];
  const body = observationHashBody({
    observationKey: input.observationKey,
    sourceAnchor,
    candidateKey: input.candidateKey,
    decisionKey: input.decisionKey,
    recordedAt,
    decision,
    feedback,
    evidenceLevel: input.evidenceLevel,
    sourceObservationHashes
  });
  return {
    ...body,
    observationHash: canonicalProtocolHash(
      FACILITATION_EXPERIENCE_OBSERVATION_SCHEMA_VERSION,
      body as unknown as CanonicalJsonValue
    ),
    containsForumText: false,
    containsDirectIdentity: false,
    assertsCausality: false
  } as ExperienceObservation;
}

/** Parse and re-hash a persisted observation; extra fields and tampering fail closed. */
export function parseExperienceObservation(
  value: unknown
): ExperienceObservation {
  const parsed = observationRecordSchema.parse(value);
  const rebuilt = buildExperienceObservation({
    observationKey: parsed.observationKey,
    sourceAnchor: parsed.sourceAnchor,
    candidateKey: parsed.candidateKey,
    decisionKey: parsed.decisionKey,
    recordedAt: parsed.recordedAt,
    decision: parsed.decision,
    feedback: parsed.feedback,
    evidenceLevel: parsed.evidenceLevel,
    sourceObservationHashes: parsed.sourceObservationHashes
  });
  if (parsed.observationHash !== rebuilt.observationHash) {
    fail("FACILITATION_OBSERVATION_HASH_MISMATCH", "observationHash 与规范化内容不一致。");
  }
  return rebuilt;
}

/** Build a reusable lesson whose source and conditions remain explicit. */
export function buildFacilitationLesson(
  rawInput: FacilitationLessonInput
): FacilitationLesson {
  const input = facilitationLessonSchema.parse(rawInput);
  const sourceAnchor = normalizeAnchor(input.sourceAnchor);
  if (sourceAnchor.courseAlias !== input.courseAlias) {
    fail("FACILITATION_LESSON_COURSE_MISMATCH", "courseAlias 必须绑定 sourceAnchor。");
  }
  const recordedAt = normalizeIso(input.recordedAt, "recordedAt");
  if (Date.parse(recordedAt) < Date.parse(sourceAnchor.asOfAt)) {
    fail("FACILITATION_LESSON_FUTURE_SOURCE", "recordedAt 早于 sourceAnchor.asOfAt。");
  }
  const sourceObservationHashes = normalizeSourceHashes(
    input.sourceObservationHashes,
    "sourceObservationHashes"
  );
  const conditions = normalizeConditions(input.conditions);
  const body = lessonHashBody({
    courseAlias: input.courseAlias,
    lessonKey: input.lessonKey,
    version: input.version,
    sourceObservationHashes,
    sourceAnchor,
    recordedAt,
    method: input.method,
    activityPhase: input.activityPhase,
    conditions,
    reason: input.reason.trim(),
    supersedesHash: input.supersedesHash
  });
  return {
    ...body,
    lessonHash: canonicalProtocolHash(
      FACILITATION_LESSON_SCHEMA_VERSION,
      body as unknown as CanonicalJsonValue
    )
  } as FacilitationLesson;
}

/** Parse and re-hash a persisted lesson; tampering or extra fields fail closed. */
export function parseFacilitationLesson(value: unknown): FacilitationLesson {
  const parsed = lessonRecordSchema.parse(value);
  const rebuilt = buildFacilitationLesson({
    courseAlias: parsed.courseAlias,
    lessonKey: parsed.lessonKey,
    version: parsed.version,
    sourceObservationHashes: parsed.sourceObservationHashes,
    sourceAnchor: parsed.sourceAnchor,
    recordedAt: parsed.recordedAt,
    method: parsed.method,
    activityPhase: parsed.activityPhase,
    conditions: parsed.conditions,
    reason: parsed.reason,
    supersedesHash: parsed.supersedesHash
  });
  if (parsed.lessonHash !== rebuilt.lessonHash) {
    fail("FACILITATION_LESSON_HASH_MISMATCH", "lessonHash 与规范化内容不一致。");
  }
  return rebuilt;
}

const applicationFactsSchema = z
  .object({
    activity_phase: z.string().min(1).max(96).optional(),
    purpose_compatible: z.string().min(1).max(96).optional(),
    peer_continuation: z.string().min(1).max(96).optional(),
    teacher_required: z.string().min(1).max(96).optional()
  })
  .strict()
  .superRefine((facts, context) => {
    for (const [key, value] of Object.entries(facts)) {
      if (!validFactValueForKey(key as keyof FacilitationFacts, value)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "事实值不在允许的有界集合内"
        });
      }
    }
  });
const applicationRecordSchema = z
  .object({
    schemaVersion: z.literal(FACILITATION_LESSON_APPLICATION_SCHEMA_VERSION),
    lessonHash: hashSchema,
    sourceAnchor: sourceAnchorSchema,
    targetAnchor: sourceAnchorSchema,
    candidateKey: codeSchema,
    acceptedAt: isoSchema,
    evaluationMode: z.enum(FACILITATION_EVALUATION_MODES),
    evaluatedAt: isoSchema,
    facts: applicationFactsSchema,
    factsSource: z.enum(FACILITATION_FACT_SOURCES),
    disposition: z.enum(FACILITATION_LESSON_DISPOSITIONS),
    reasonCode: codeSchema,
    decision: shadowDecisionSchema,
    changedFields: z.array(z.enum([
      "decision",
      "targetKey",
      "facilitationFunction",
      "responsibility",
      "reasonCode"
    ])).max(5).superRefine((fields, context) => {
      if (new Set(fields).size !== fields.length) {
        context.addIssue({ code: "custom", message: "changedFields 不能重复" });
      }
    }),
    publishAllowed: z.literal(false),
    applicationHash: hashSchema
  })
  .strict();

function baselineApplication(
  input: {
    readonly lesson: FacilitationLesson;
    readonly sourceAnchor: CommunityInquiryMemoryProjection;
    readonly targetAnchor: CommunityInquiryMemoryProjection;
    readonly candidateKey: string;
    readonly acceptedAt: string;
    readonly evaluation: EvaluationMetadata;
    readonly facts: FacilitationFacts;
    readonly factsSource: FacilitationFactsSource;
    readonly baseline: CommunityInquiryShadowDecision;
    readonly disposition: FacilitationLessonDisposition;
    readonly reasonCode: string;
  }
): FacilitationLessonApplication {
  return application({
    schemaVersion: FACILITATION_LESSON_APPLICATION_SCHEMA_VERSION,
    lessonHash: input.lesson.lessonHash,
    sourceAnchor: input.sourceAnchor,
    targetAnchor: input.targetAnchor,
    candidateKey: input.candidateKey,
    acceptedAt: input.acceptedAt,
    evaluationMode: input.evaluation.evaluationMode,
    evaluatedAt: input.evaluation.evaluatedAt,
    facts: input.facts,
    factsSource: input.factsSource,
    disposition: input.disposition,
    reasonCode: input.reasonCode,
    decision: input.baseline,
    changedFields: [],
    publishAllowed: false
  });
}

function proposedDecision(
  lesson: FacilitationLesson,
  baseline: CommunityInquiryShadowDecision,
  candidateKey: string,
  facts: FacilitationFacts
): CommunityInquiryShadowDecision {
  if (facts.peer_continuation === "true") {
    return {
      ...baseline,
      decision: "YIELD",
      reasonCode: "lesson_peer_continuation"
    };
  }
  switch (lesson.method) {
    case "resource_connection":
      return {
        decision: "DRAFT",
        targetKey: candidateKey,
        facilitationFunction: "resource_connection",
        responsibility: "companion",
        reasonCode: "lesson_resource_connection"
      };
    case "preserve_peer_opportunity":
      return {
        decision: "WAIT",
        targetKey: baseline.targetKey,
        facilitationFunction: null,
        responsibility: "peer",
        reasonCode: "lesson_preserve_peer_opportunity"
      };
    case "teacher_handoff":
      return {
        decision: "WAIT",
        targetKey: baseline.targetKey,
        facilitationFunction: "teacher_handoff",
        responsibility: "teacher",
        reasonCode: "lesson_teacher_handoff"
      };
  }
}

/**
 * Apply one accepted lesson to a fresh target anchor.  The result is a
 * decision suggestion only: publication is permanently false in this pure
 * kernel and must be handled by the separate policy/committer path.
 */
export function applyFacilitationLesson(
  input: ApplyFacilitationLessonInput
): FacilitationLessonApplication {
  const lesson = parseFacilitationLesson(input.lesson);
  const sourceAnchor = normalizeAnchor(lesson.sourceAnchor);
  const targetAnchor = normalizeAnchor(input.targetAnchor);
  const candidateKey = codeSchema.parse(input.candidateKey);
  const baseline = normalizeDecision(input.baseline, "baseline");
  const acceptedAt = normalizeIso(input.acceptedAt, "acceptedAt");
  const { facts, factsSource } = asFacts(input.facts);
  const evaluation = resolveEvaluationMetadata({
    targetAnchor,
    factsSource,
    evaluatedAt: input.evaluatedAt
  });

  if (targetAnchor.courseAlias !== lesson.courseAlias || sourceAnchor.courseAlias !== lesson.courseAlias) {
    return baselineApplication({
      lesson,
      sourceAnchor,
      targetAnchor,
      candidateKey,
      acceptedAt,
      evaluation,
      facts,
      factsSource,
      baseline,
      disposition: "rejected",
      reasonCode: "lesson_cross_course"
    });
  }
  if (Date.parse(sourceAnchor.asOfAt) > Date.parse(targetAnchor.asOfAt)) {
    return baselineApplication({
      lesson,
      sourceAnchor,
      targetAnchor,
      candidateKey,
      acceptedAt,
      evaluation,
      facts,
      factsSource,
      baseline,
      disposition: "rejected",
      reasonCode: "lesson_source_in_future"
    });
  }
  if (Date.parse(acceptedAt) > Date.parse(targetAnchor.asOfAt)) {
    return baselineApplication({
      lesson,
      sourceAnchor,
      targetAnchor,
      candidateKey,
      acceptedAt,
      evaluation,
      facts,
      factsSource,
      baseline,
      disposition: "rejected",
      reasonCode: "lesson_acceptance_in_future"
    });
  }
  if (Date.parse(acceptedAt) < Date.parse(lesson.recordedAt)) {
    return baselineApplication({
      lesson,
      sourceAnchor,
      targetAnchor,
      candidateKey,
      acceptedAt,
      evaluation,
      facts,
      factsSource,
      baseline,
      disposition: "rejected",
      reasonCode: "lesson_acceptance_before_recorded"
    });
  }

  if (Object.values(facts).some((value) => value === "conflict")) {
    return baselineApplication({
      lesson,
      sourceAnchor,
      targetAnchor,
      candidateKey,
      acceptedAt,
      evaluation,
      facts,
      factsSource,
      baseline,
      disposition: "rejected",
      reasonCode: "lesson_fact_conflict"
    });
  }
  // An observed continuation takes precedence over every lesson method.
  if (facts.peer_continuation === "true") {
    if (baseline.decision === "ABSTAIN") {
      return baselineApplication({
        lesson,
        sourceAnchor,
        targetAnchor,
        candidateKey,
        acceptedAt,
        evaluation,
        facts,
        factsSource,
        baseline,
        disposition: "rejected",
        reasonCode: "lesson_baseline_abstain_guard"
      });
    }
    const decision = proposedDecision(lesson, baseline, candidateKey, facts);
    const changed = changedFields(baseline, decision);
    return application({
      schemaVersion: FACILITATION_LESSON_APPLICATION_SCHEMA_VERSION,
      lessonHash: lesson.lessonHash,
      sourceAnchor,
      targetAnchor,
      candidateKey,
      acceptedAt,
      facts,
      factsSource,
      evaluationMode: evaluation.evaluationMode,
      evaluatedAt: evaluation.evaluatedAt,
      disposition: changed.length === 0 ? "adopted" : "adopted",
      reasonCode: "lesson_peer_continuation",
      decision,
      changedFields: changed,
      publishAllowed: false
    });
  }

  if (
    Object.entries(facts).some(
      ([key, value]) =>
        !validFactValueForKey(key as keyof FacilitationFacts, value)
    )
  ) {
    return baselineApplication({
      lesson,
      sourceAnchor,
      targetAnchor,
      candidateKey,
      acceptedAt,
      evaluation,
      facts,
      factsSource,
      baseline,
      disposition: "needs_check",
      reasonCode: "lesson_fact_unknown"
    });
  }

  if (baseline.decision === "YIELD") {
    return baselineApplication({
      lesson,
      sourceAnchor,
      targetAnchor,
      candidateKey,
      acceptedAt,
      evaluation,
      facts,
      factsSource,
      baseline,
      disposition: "rejected",
      reasonCode: "lesson_baseline_yield_guard"
    });
  }
  if (baseline.decision === "ABSTAIN") {
    return baselineApplication({
      lesson,
      sourceAnchor,
      targetAnchor,
      candidateKey,
      acceptedAt,
      evaluation,
      facts,
      factsSource,
      baseline,
      disposition: "rejected",
      reasonCode: "lesson_baseline_abstain_guard"
    });
  }

  for (const condition of lesson.conditions) {
    const actual = factValue(facts, condition.key);
    if (actual === undefined || actual === "unknown") {
      return baselineApplication({
        lesson,
        sourceAnchor,
        targetAnchor,
        candidateKey,
        acceptedAt,
        evaluation,
        facts,
        factsSource,
        baseline,
        disposition: "needs_check",
        reasonCode: "lesson_condition_unknown"
      });
    }
    if (actual !== condition.expected) {
      return baselineApplication({
        lesson,
        sourceAnchor,
        targetAnchor,
        candidateKey,
        acceptedAt,
        evaluation,
        facts,
        factsSource,
        baseline,
        disposition: "rejected",
        reasonCode: "lesson_condition_mismatch"
      });
    }
  }

  if (lesson.method === "resource_connection") {
    const purpose = facts.purpose_compatible;
    if (purpose === undefined || purpose === "unknown") {
      return baselineApplication({
        lesson,
        sourceAnchor,
        targetAnchor,
        candidateKey,
        acceptedAt,
        evaluation,
        facts,
        factsSource,
        baseline,
        disposition: "needs_check",
        reasonCode: "lesson_resource_purpose_unknown"
      });
    }
    if (purpose !== "true") {
      return baselineApplication({
        lesson,
        sourceAnchor,
        targetAnchor,
        candidateKey,
        acceptedAt,
        evaluation,
        facts,
        factsSource,
        baseline,
        disposition: "rejected",
        reasonCode: "lesson_resource_purpose_incompatible"
      });
    }
    const phase = facts.activity_phase;
    if (phase === undefined || phase === "unknown") {
      return baselineApplication({
        lesson,
        sourceAnchor,
        targetAnchor,
        candidateKey,
        acceptedAt,
        evaluation,
        facts,
        factsSource,
        baseline,
        disposition: "needs_check",
        reasonCode: "lesson_resource_phase_unknown"
      });
    }
    if (phase !== lesson.activityPhase) {
      return baselineApplication({
        lesson,
        sourceAnchor,
        targetAnchor,
        candidateKey,
        acceptedAt,
        evaluation,
        facts,
        factsSource,
        baseline,
        disposition: "rejected",
        reasonCode: "lesson_resource_phase_mismatch"
      });
    }
  }

  const decision = proposedDecision(lesson, baseline, candidateKey, facts);
  if (decision.decision === "DRAFT" && ["ABSTAIN", "YIELD"].includes(baseline.decision)) {
    return baselineApplication({
      lesson,
      sourceAnchor,
      targetAnchor,
      candidateKey,
      acceptedAt,
      evaluation,
      facts,
      factsSource,
      baseline,
      disposition: "rejected",
      reasonCode: "lesson_baseline_guard"
    });
  }
  const changed = changedFields(baseline, decision);
  return application({
    schemaVersion: FACILITATION_LESSON_APPLICATION_SCHEMA_VERSION,
    lessonHash: lesson.lessonHash,
    sourceAnchor,
    targetAnchor,
    candidateKey,
    acceptedAt,
    facts,
    factsSource,
    evaluationMode: evaluation.evaluationMode,
    evaluatedAt: evaluation.evaluatedAt,
    disposition: "adopted",
    reasonCode: changed.length === 0 ? "lesson_no_delta" : decision.reasonCode,
    decision,
    changedFields: changed,
    publishAllowed: false
  });
}

/** Parse and verify a persisted application receipt, including its hash. */
export function parseFacilitationLessonApplication(
  value: unknown
): FacilitationLessonApplication {
  const parsed = applicationRecordSchema.parse(value);
  const targetAnchor = normalizeAnchor(parsed.targetAnchor);
  const evaluation = resolveEvaluationMetadata({
    targetAnchor,
    factsSource: parsed.factsSource,
    evaluatedAt: parsed.evaluatedAt,
    evaluationMode: parsed.evaluationMode
  });
  const normalized: Omit<FacilitationLessonApplication, "applicationHash"> = {
    schemaVersion: parsed.schemaVersion,
    lessonHash: parsed.lessonHash,
    sourceAnchor: normalizeAnchor(parsed.sourceAnchor),
    targetAnchor,
    candidateKey: parsed.candidateKey,
    acceptedAt: normalizeIso(parsed.acceptedAt, "acceptedAt"),
    evaluationMode: evaluation.evaluationMode,
    evaluatedAt: evaluation.evaluatedAt,
    facts: { ...parsed.facts },
    factsSource: parsed.factsSource,
    disposition: parsed.disposition,
    reasonCode: parsed.reasonCode,
    decision: normalizeDecision(parsed.decision, "decision"),
    changedFields: [...parsed.changedFields],
    publishAllowed: false
  };
  const expectedHash = canonicalProtocolHash(
    FACILITATION_LESSON_APPLICATION_SCHEMA_VERSION,
    applicationHashBody(normalized) as unknown as CanonicalJsonValue
  );
  if (parsed.applicationHash !== expectedHash) {
    fail(
      "FACILITATION_LESSON_APPLICATION_HASH_MISMATCH",
      "applicationHash 与规范化内容不一致。"
    );
  }
  return { ...normalized, applicationHash: parsed.applicationHash };
}
