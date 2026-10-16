import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  parseCommunityInquiryMemoryProjection,
  type CommunityInquiryMemoryProjection
} from "./inquiry-memory";
import type { FacilitationFacts } from "./facilitation-experience";

export const EXPERIENCE_FACT_SCHEMA_VERSION =
  "cmooc.facilitation-experience-fact.v1" as const;
export const EXPERIENCE_FACTS_TAPE_SCHEMA_VERSION =
  "cmooc.facilitation-experience-facts-tape.v1" as const;

export const EXPERIENCE_FACT_KEYS = [
  "activity_phase",
  "purpose_compatible",
  "peer_continuation",
  "teacher_required"
] as const;
export type ExperienceFactKey = (typeof EXPERIENCE_FACT_KEYS)[number];

export const EXPERIENCE_FACT_SOURCES = [
  "runtime_observation",
  "browser_interpretation"
] as const;
export type ExperienceFactSource = (typeof EXPERIENCE_FACT_SOURCES)[number];

export type ExperienceFactEvidenceRef = {
  readonly kind: string;
  readonly id: string;
  readonly hash: string;
  readonly observedAt: string;
};

export type PersistedExperienceFact = {
  readonly schemaVersion: typeof EXPERIENCE_FACT_SCHEMA_VERSION;
  readonly courseAlias: string;
  readonly decisionKey: string;
  readonly anchor: CommunityInquiryMemoryProjection;
  readonly key: ExperienceFactKey;
  readonly value: string;
  readonly source: ExperienceFactSource;
  readonly evidenceRefs: readonly ExperienceFactEvidenceRef[];
  readonly observationHash: string;
  readonly observedAt: string;
  readonly interpretedAt: string;
  readonly evidenceHash: string;
  readonly payloadHash: string;
  readonly containsForumText: false;
  readonly containsDirectIdentity: false;
  readonly assertsCausality: false;
};

export type ExperienceFactsTapePayload = {
  readonly schemaVersion: typeof EXPERIENCE_FACTS_TAPE_SCHEMA_VERSION;
  readonly courseAlias: string;
  readonly decisionKey: string;
  readonly anchor: CommunityInquiryMemoryProjection;
  readonly records: readonly PersistedExperienceFact[];
  readonly operationKey: string;
  readonly payloadHash: string;
  readonly containsForumText: false;
  readonly containsDirectIdentity: false;
  readonly assertsCausality: false;
};

export type ExperienceFactsResolution =
  | "provider_missing"
  | "no_persisted_facts"
  | "no_eligible_facts"
  | "facts_selected"
  | "peer_priority_override"
  | "fact_conflict";

export type SelectedExperienceFactEvidence = {
  readonly key: ExperienceFactKey;
  readonly source: ExperienceFactSource;
  readonly value: string;
  readonly evidenceRefs: readonly ExperienceFactEvidenceRef[];
  readonly observationHash: string;
  readonly evidenceHash: string;
  readonly interpretedAt: string;
  readonly observedAt: string;
};

export type ExperienceFactsSelection = {
  readonly facts: FacilitationFacts;
  readonly factsSource: "runtime_observation" | "browser_interpretation";
  readonly evaluationMode: "as_of" | "post_hoc_browser_interpretation";
  readonly evaluatedAt: string;
  readonly resolution: ExperienceFactsResolution;
  readonly selected: readonly SelectedExperienceFactEvidence[];
  readonly rejectedRecordCount: number;
  readonly selectionHash: string;
};

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CODE_PATTERN = /^[a-z][a-z0-9_.:-]{0,95}$/u;
const ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const PHASES = new Set([
  "question_opening",
  "explanation_development",
  "peer_review",
  "resource_connection",
  "collaborative_progress",
  "task_reentry",
  "unknown"
]);
const TRUTH_VALUES = new Set(["true", "false", "unknown", "conflict"]);
const EVIDENCE_KINDS = /^[a-z][a-z0-9_.:-]{0,63}$/u;
const FACT_RECORD_KEYS = new Set([
  "schemaVersion", "courseAlias", "decisionKey", "anchor", "key", "value",
  "source", "evidenceRefs", "observationHash", "observedAt", "interpretedAt",
  "evidenceHash", "payloadHash", "containsForumText", "containsDirectIdentity",
  "assertsCausality"
]);
const TAPE_KEYS = new Set([
  "schemaVersion", "courseAlias", "decisionKey", "anchor", "records", "operationKey",
  "payloadHash", "containsForumText", "containsDirectIdentity", "assertsCausality"
]);

function fail(code: string, message = code): never {
  throw new Error(`${code}: ${message}`);
}

function assertExactKeys(value: Record<string, unknown>, keys: Set<string>, code: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) fail(code);
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    fail("EXPERIENCE_FACT_HASH_INVALID", label);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    fail("EXPERIENCE_FACT_IDENTIFIER_INVALID", label);
  }
  return value;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !ISO_PATTERN.test(value)) {
    fail("EXPERIENCE_FACT_TIME_INVALID", label);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    fail("EXPERIENCE_FACT_TIME_INVALID", label);
  }
  return date.toISOString();
}

function sameAnchor(
  left: CommunityInquiryMemoryProjection,
  right: CommunityInquiryMemoryProjection
): boolean {
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

function factValue(key: ExperienceFactKey, value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 96) {
    fail("EXPERIENCE_FACT_VALUE_INVALID", key);
  }
  const normalized = value.trim().toLowerCase();
  if (key === "activity_phase") {
    if (!PHASES.has(normalized)) fail("EXPERIENCE_FACT_VALUE_INVALID", key);
  } else if (!TRUTH_VALUES.has(normalized)) {
    fail("EXPERIENCE_FACT_VALUE_INVALID", key);
  }
  return normalized;
}

function normalizeEvidenceRefs(value: unknown): readonly ExperienceFactEvidenceRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    fail("EXPERIENCE_FACT_EVIDENCE_INVALID");
  }
  const refs = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail("EXPERIENCE_FACT_EVIDENCE_INVALID", `evidenceRefs[${index}]`);
    }
    const record = item as Record<string, unknown>;
    const kind = record.kind;
    if (typeof kind !== "string" || !EVIDENCE_KINDS.test(kind)) {
      fail("EXPERIENCE_FACT_EVIDENCE_INVALID", `evidenceRefs[${index}].kind`);
    }
    return {
      kind,
      id: identifier(record.id, `evidenceRefs[${index}].id`),
      hash: hash(record.hash, `evidenceRefs[${index}].hash`),
      observedAt: iso(record.observedAt, `evidenceRefs[${index}].observedAt`)
    } satisfies ExperienceFactEvidenceRef;
  });
  const keys = refs.map((ref) => `${ref.kind}\0${ref.id}\0${ref.hash}\0${ref.observedAt}`);
  if (new Set(keys).size !== keys.length) fail("EXPERIENCE_FACT_EVIDENCE_DUPLICATE");
  return [...refs].sort((left, right) =>
    `${left.kind}:${left.id}:${left.observedAt}`.localeCompare(
      `${right.kind}:${right.id}:${right.observedAt}`
    )
  );
}

function factBody(value: Omit<PersistedExperienceFact, "evidenceHash" | "payloadHash">): Record<string, unknown> {
  return {
    schemaVersion: value.schemaVersion,
    courseAlias: value.courseAlias,
    decisionKey: value.decisionKey,
    anchor: value.anchor,
    key: value.key,
    value: value.value,
    source: value.source,
    evidenceRefs: value.evidenceRefs,
    observationHash: value.observationHash,
    observedAt: value.observedAt,
    interpretedAt: value.interpretedAt,
    containsForumText: false,
    containsDirectIdentity: false,
    assertsCausality: false
  };
}

function evidenceBody(value: Omit<PersistedExperienceFact, "evidenceHash" | "payloadHash">): Record<string, unknown> {
  return {
    observationHash: value.observationHash,
    evidenceRefs: value.evidenceRefs
  };
}

function tapeBody(value: Omit<ExperienceFactsTapePayload, "payloadHash">): Record<string, unknown> {
  return {
    schemaVersion: value.schemaVersion,
    courseAlias: value.courseAlias,
    decisionKey: value.decisionKey,
    anchor: value.anchor,
    records: value.records,
    operationKey: value.operationKey,
    containsForumText: false,
    containsDirectIdentity: false,
    assertsCausality: false
  };
}

export function buildPersistedExperienceFact(input: {
  courseAlias: string;
  decisionKey: string;
  anchor: CommunityInquiryMemoryProjection;
  key: ExperienceFactKey;
  value: string;
  source: ExperienceFactSource;
  evidenceRefs: readonly ExperienceFactEvidenceRef[];
  observationHash: string;
  observedAt: string;
  interpretedAt: string;
}): PersistedExperienceFact {
  const anchor = parseCommunityInquiryMemoryProjection(input.anchor);
  const courseAlias = identifier(input.courseAlias, "courseAlias");
  const decisionKey = identifier(input.decisionKey, "decisionKey");
  if (anchor.courseAlias !== courseAlias) fail("EXPERIENCE_FACT_ANCHOR_MISMATCH", "courseAlias");
  if (!EXPERIENCE_FACT_KEYS.includes(input.key)) fail("EXPERIENCE_FACT_KEY_INVALID");
  if (!EXPERIENCE_FACT_SOURCES.includes(input.source)) fail("EXPERIENCE_FACT_SOURCE_INVALID");
  const value = factValue(input.key, input.value);
  const observedAt = iso(input.observedAt, "observedAt");
  const interpretedAt = iso(input.interpretedAt, "interpretedAt");
  const asOfMs = Date.parse(anchor.asOfAt);
  if (
    input.source === "runtime_observation" &&
    (Date.parse(observedAt) > asOfMs || Date.parse(interpretedAt) > asOfMs)
  ) {
    fail("EXPERIENCE_FACT_RUNTIME_FUTURE", "runtime_observation 的观测、解释时间不能晚于 anchor.asOfAt");
  }
  if (input.source === "browser_interpretation" && Date.parse(interpretedAt) < Date.parse(anchor.asOfAt)) {
    fail("EXPERIENCE_FACT_BROWSER_INTERPRETATION_TIME", "browser_interpretation 的 interpretedAt 不能早于 anchor.asOfAt");
  }
  if (Date.parse(observedAt) > Date.parse(interpretedAt)) {
    fail("EXPERIENCE_FACT_TIME_ORDER_INVALID");
  }
  const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs);
  if (evidenceRefs.some((ref) => Date.parse(ref.observedAt) > asOfMs)) {
    fail(
      input.source === "runtime_observation"
        ? "EXPERIENCE_FACT_RUNTIME_FUTURE"
        : "EXPERIENCE_FACT_BROWSER_FUTURE_EVIDENCE",
      "evidenceRefs 的 observedAt 不能晚于 anchor.asOfAt"
    );
  }
  if (evidenceRefs.some((ref) => Date.parse(ref.observedAt) > Date.parse(interpretedAt))) {
    fail("EXPERIENCE_FACT_EVIDENCE_AFTER_INTERPRETATION");
  }
  const base = {
    schemaVersion: EXPERIENCE_FACT_SCHEMA_VERSION,
    courseAlias,
    decisionKey,
    anchor,
    key: input.key,
    value,
    source: input.source,
    evidenceRefs,
    observationHash: hash(input.observationHash, "observationHash"),
    observedAt,
    interpretedAt,
    containsForumText: false as const,
    containsDirectIdentity: false as const,
    assertsCausality: false as const
  } satisfies Omit<PersistedExperienceFact, "evidenceHash" | "payloadHash">;
  const evidenceHash = canonicalProtocolHash(
    "cmooc.facilitation-experience-fact-evidence.v1",
    evidenceBody(base) as unknown as CanonicalJsonValue
  );
  const payloadHash = canonicalProtocolHash(
    EXPERIENCE_FACT_SCHEMA_VERSION,
    factBody(base) as unknown as CanonicalJsonValue
  );
  return { ...base, evidenceHash, payloadHash };
}

export function parsePersistedExperienceFact(
  value: unknown,
  expected?: { courseAlias?: string; decisionKey?: string; anchor?: CommunityInquiryMemoryProjection }
): PersistedExperienceFact {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("EXPERIENCE_FACT_RECORD_INVALID");
  const record = value as Record<string, unknown>;
  assertExactKeys(record, FACT_RECORD_KEYS, "EXPERIENCE_FACT_RECORD_FIELDS_INVALID");
  const anchor = parseCommunityInquiryMemoryProjection(record.anchor);
  const normalized = buildPersistedExperienceFact({
    courseAlias: String(record.courseAlias),
    decisionKey: String(record.decisionKey),
    anchor,
    key: record.key as ExperienceFactKey,
    value: String(record.value),
    source: record.source as ExperienceFactSource,
    evidenceRefs: record.evidenceRefs as ExperienceFactEvidenceRef[],
    observationHash: String(record.observationHash),
    observedAt: String(record.observedAt),
    interpretedAt: String(record.interpretedAt)
  });
  if (
    record.schemaVersion !== EXPERIENCE_FACT_SCHEMA_VERSION ||
    record.evidenceHash !== normalized.evidenceHash ||
    record.payloadHash !== normalized.payloadHash ||
    record.containsForumText !== false ||
    record.containsDirectIdentity !== false ||
    record.assertsCausality !== false
  ) {
    fail("EXPERIENCE_FACT_PAYLOAD_HASH_MISMATCH");
  }
  if (expected?.courseAlias !== undefined && normalized.courseAlias !== expected.courseAlias) {
    fail("EXPERIENCE_FACT_SCOPE_MISMATCH", "courseAlias");
  }
  if (expected?.decisionKey !== undefined && normalized.decisionKey !== expected.decisionKey) {
    fail("EXPERIENCE_FACT_SCOPE_MISMATCH", "decisionKey");
  }
  if (expected?.anchor !== undefined && !sameAnchor(normalized.anchor, expected.anchor)) {
    fail("EXPERIENCE_FACT_ANCHOR_MISMATCH");
  }
  return normalized;
}

export function buildExperienceFactsTapePayload(input: {
  courseAlias: string;
  decisionKey: string;
  anchor: CommunityInquiryMemoryProjection;
  records: readonly PersistedExperienceFact[];
  operationKey: string;
}): ExperienceFactsTapePayload {
  const anchor = parseCommunityInquiryMemoryProjection(input.anchor);
  const courseAlias = identifier(input.courseAlias, "courseAlias");
  const decisionKey = identifier(input.decisionKey, "decisionKey");
  const operationKey = identifier(input.operationKey, "operationKey");
  const records = [...input.records].map((record) =>
    parsePersistedExperienceFact(record, { courseAlias, decisionKey, anchor })
  ).sort((left, right) =>
    `${left.key}:${left.source}:${left.interpretedAt}`.localeCompare(
      `${right.key}:${right.source}:${right.interpretedAt}`
    )
  );
  const base = {
    schemaVersion: EXPERIENCE_FACTS_TAPE_SCHEMA_VERSION,
    courseAlias,
    decisionKey,
    anchor,
    records,
    operationKey,
    containsForumText: false as const,
    containsDirectIdentity: false as const,
    assertsCausality: false as const
  } satisfies Omit<ExperienceFactsTapePayload, "payloadHash">;
  return {
    ...base,
    payloadHash: canonicalProtocolHash(
      EXPERIENCE_FACTS_TAPE_SCHEMA_VERSION,
      tapeBody(base) as unknown as CanonicalJsonValue
    )
  };
}

export function parseExperienceFactsTapePayload(
  value: unknown,
  expected?: { courseAlias?: string; decisionKey?: string; anchor?: CommunityInquiryMemoryProjection }
): ExperienceFactsTapePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("EXPERIENCE_FACTS_TAPE_INVALID");
  const record = value as Record<string, unknown>;
  assertExactKeys(record, TAPE_KEYS, "EXPERIENCE_FACTS_TAPE_FIELDS_INVALID");
  const anchor = parseCommunityInquiryMemoryProjection(record.anchor);
  if (expected?.anchor !== undefined && !sameAnchor(anchor, expected.anchor)) {
    fail("EXPERIENCE_FACTS_TAPE_ANCHOR_MISMATCH");
  }
  if (!Array.isArray(record.records)) fail("EXPERIENCE_FACTS_TAPE_RECORDS_INVALID");
  const payload = buildExperienceFactsTapePayload({
    courseAlias: String(record.courseAlias),
    decisionKey: String(record.decisionKey),
    anchor,
    records: record.records as PersistedExperienceFact[],
    operationKey: String(record.operationKey)
  });
  if (
    record.schemaVersion !== EXPERIENCE_FACTS_TAPE_SCHEMA_VERSION ||
    record.payloadHash !== payload.payloadHash ||
    record.containsForumText !== false ||
    record.containsDirectIdentity !== false ||
    record.assertsCausality !== false
  ) {
    fail("EXPERIENCE_FACTS_TAPE_HASH_MISMATCH");
  }
  if (expected?.courseAlias !== undefined && payload.courseAlias !== expected.courseAlias) fail("EXPERIENCE_FACTS_TAPE_SCOPE_MISMATCH");
  if (expected?.decisionKey !== undefined && payload.decisionKey !== expected.decisionKey) fail("EXPERIENCE_FACTS_TAPE_SCOPE_MISMATCH");
  if (expected?.anchor !== undefined && !sameAnchor(payload.anchor, expected.anchor)) fail("EXPERIENCE_FACTS_TAPE_ANCHOR_MISMATCH");
  return payload;
}

function emptyFacts(): FacilitationFacts {
  return {
    activity_phase: "unknown",
    purpose_compatible: "unknown",
    peer_continuation: "unknown",
    teacher_required: "unknown"
  };
}

function effectiveTime(record: PersistedExperienceFact): number {
  return Date.parse(record.source === "browser_interpretation" ? record.interpretedAt : record.observedAt);
}

function selectionBody(value: Omit<ExperienceFactsSelection, "selectionHash">): Record<string, unknown> {
  return {
    facts: value.facts,
    factsSource: value.factsSource,
    evaluationMode: value.evaluationMode,
    evaluatedAt: value.evaluatedAt,
    resolution: value.resolution,
    selected: value.selected,
    rejectedRecordCount: value.rejectedRecordCount
  };
}

export function selectExperienceFacts(input: {
  records: readonly unknown[] | null;
  courseAlias: string;
  decisionKey: string;
  anchor: CommunityInquiryMemoryProjection;
}): ExperienceFactsSelection {
  const anchor = parseCommunityInquiryMemoryProjection(input.anchor);
  const courseAlias = identifier(input.courseAlias, "courseAlias");
  const decisionKey = identifier(input.decisionKey, "decisionKey");
  if (input.records === null) {
    const empty: Omit<ExperienceFactsSelection, "selectionHash"> = {
      facts: emptyFacts(),
      factsSource: "runtime_observation",
      evaluationMode: "as_of",
      evaluatedAt: anchor.asOfAt,
      resolution: "provider_missing",
      selected: [],
      rejectedRecordCount: 0
    };
    return {
      ...empty,
      selectionHash: canonicalProtocolHash("cmooc.facilitation-experience-fact-selection.v1", selectionBody(empty) as unknown as CanonicalJsonValue)
    };
  }
  const records: PersistedExperienceFact[] = [];
  let rejectedRecordCount = 0;
  for (const raw of input.records) {
    try {
      records.push(parsePersistedExperienceFact(raw, { courseAlias, decisionKey, anchor }));
    } catch {
      rejectedRecordCount += 1;
    }
  }
  if (records.length === 0) {
    const empty: Omit<ExperienceFactsSelection, "selectionHash"> = {
      facts: emptyFacts(),
      factsSource: "runtime_observation",
      evaluationMode: "as_of",
      evaluatedAt: anchor.asOfAt,
      resolution: input.records.length === 0 ? "no_persisted_facts" : "no_eligible_facts",
      selected: [],
      rejectedRecordCount
    };
    return {
      ...empty,
      selectionHash: canonicalProtocolHash("cmooc.facilitation-experience-fact-selection.v1", selectionBody(empty) as unknown as CanonicalJsonValue)
    };
  }
  const selected: PersistedExperienceFact[] = [];
  let peerPriority = false;
  let conflict = false;
  for (const key of EXPERIENCE_FACT_KEYS) {
    const values = records.filter((record) => record.key === key);
    if (values.length === 0) continue;
    if (key === "peer_continuation") {
      const peerTrue = values.find((record) => record.value === "true");
      if (peerTrue) {
        selected.push(peerTrue);
        peerPriority = true;
        continue;
      }
    }
    const ordered = [...values].sort((left, right) => effectiveTime(right) - effectiveTime(left));
    const latestTime = effectiveTime(ordered[0]);
    const latest = ordered.filter((record) => effectiveTime(record) === latestTime);
    const distinctValues = new Set(latest.map((record) => record.value));
    if (distinctValues.size > 1 || latest[0].value === "conflict") {
      conflict = true;
      const conflictRecord = latest[0];
      selected.push({ ...conflictRecord, value: "unknown" });
    } else {
      selected.push(latest[0]);
    }
  }
  const facts: Record<ExperienceFactKey, string> = {
    activity_phase: "unknown",
    purpose_compatible: "unknown",
    peer_continuation: "unknown",
    teacher_required: "unknown"
  };
  for (const record of selected) {
    facts[record.key] = record.value;
  }
  const hasBrowser = selected.some((record) => record.source === "browser_interpretation");
  const evaluatedAt = hasBrowser
    ? new Date(Math.max(...selected.filter((record) => record.source === "browser_interpretation").map((record) => Date.parse(record.interpretedAt)))).toISOString()
    : anchor.asOfAt;
  const selectedEvidence: SelectedExperienceFactEvidence[] = selected.map((record) => ({
    key: record.key,
    source: record.source,
    value: record.value,
    evidenceRefs: record.evidenceRefs,
    observationHash: record.observationHash,
    evidenceHash: record.evidenceHash,
    interpretedAt: record.interpretedAt,
    observedAt: record.observedAt
  }));
  const body: Omit<ExperienceFactsSelection, "selectionHash"> = {
    facts: facts as FacilitationFacts,
    factsSource: hasBrowser ? "browser_interpretation" : "runtime_observation",
    evaluationMode: hasBrowser ? "post_hoc_browser_interpretation" : "as_of",
    evaluatedAt,
    resolution: peerPriority ? "peer_priority_override" : conflict ? "fact_conflict" : "facts_selected",
    selected: selectedEvidence,
    rejectedRecordCount
  };
  return {
    ...body,
    selectionHash: canonicalProtocolHash("cmooc.facilitation-experience-fact-selection.v1", selectionBody(body) as unknown as CanonicalJsonValue)
  };
}
