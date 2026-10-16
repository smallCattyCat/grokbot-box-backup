import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  localEvidenceHmac
} from "@/lib/privacy/local-evidence-hmac";

export const COURSE_STRUCTURE_FACT_SCHEMA_VERSION =
  "cmooc.course-structure-fact.v1" as const;
export const COURSE_STRUCTURE_FACT_SET_SCHEMA_VERSION =
  "cmooc.course-structure-fact-set.v1" as const;
export const CONTROLLED_COURSE_CONCEPT_TAXONOMY_VERSION =
  "cmooc.controlled-course-concepts.v1" as const;

export type CourseGraphNodeKind =
  | "course"
  | "column"
  | "thread"
  | "actor"
  | "concept"
  | "resource";

export type DerivedCourseGraphNodeKind =
  | "column"
  | "concept"
  | "resource";

export type CourseGraphEdgeKind =
  | "contains"
  | "authored"
  | "participated_in"
  | "reply_to"
  | "discusses"
  | "references_resource";

export type SafeCourseGraphAttributeValue =
  | string
  | number
  | boolean
  | null;

export type SafeCourseGraphAttributes = Record<
  string,
  SafeCourseGraphAttributeValue
>;

export type CourseStructureFact = {
  schemaVersion: typeof COURSE_STRUCTURE_FACT_SCHEMA_VERSION;
  courseKey: string;
  factKey: string;
  factIdentityKey: string;
  factKind: "node" | "edge";
  subjectKey: string;
  subjectKind: CourseGraphNodeKind;
  predicate: CourseGraphEdgeKind | null;
  objectKey: string | null;
  objectKind: CourseGraphNodeKind | null;
  revisionHash: string;
  occurredAt: string | null;
  ordinal: number | null;
  attributes: SafeCourseGraphAttributes;
  legalityStatus: "admissible";
  containsForumText: false;
};

export type ControlledConceptSignal = {
  conceptId: string;
  occurrenceCount: number;
  taxonomyVersion:
    typeof CONTROLLED_COURSE_CONCEPT_TAXONOMY_VERSION;
};

export type HashedResourceSignal = {
  resourceKey: string;
  occurrenceCount: number;
  resourceKind: "external_url";
};

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ATTRIBUTE_CODE_PATTERN =
  /^[a-z0-9][a-z0-9_.:-]{0,127}$/;
const NODE_KIND_VALUES = new Set<CourseGraphNodeKind>([
  "course",
  "column",
  "thread",
  "actor",
  "concept",
  "resource"
]);
const EDGE_KIND_VALUES = new Set<CourseGraphEdgeKind>([
  "contains",
  "authored",
  "participated_in",
  "reply_to",
  "discusses",
  "references_resource"
]);
const MAX_GRAPH_COUNT = 1_000_000_000;

const CONTROLLED_CONCEPTS: ReadonlyArray<{
  conceptId: string;
  terms: readonly string[];
}> = [
  {
    conceptId: "artificial_intelligence",
    terms: ["人工智能", "artificial intelligence", "AI"]
  },
  {
    conceptId: "generative_ai",
    terms: ["生成式人工智能", "生成式AI", "generative ai"]
  },
  {
    conceptId: "ai_companion",
    terms: ["智能学伴", "学习伙伴", "learning companion"]
  },
  {
    conceptId: "connectivism",
    terms: ["联通主义", "connectivism"]
  },
  {
    conceptId: "knowledge_graph",
    terms: ["知识图谱", "knowledge graph"]
  },
  {
    conceptId: "social_network",
    terms: ["社会网络", "social network"]
  },
  {
    conceptId: "learning_community",
    terms: ["学习共同体", "学习社区", "learning community"]
  },
  {
    conceptId: "collaborative_learning",
    terms: ["协作学习", "合作学习", "collaborative learning"]
  },
  {
    conceptId: "learning_analytics",
    terms: ["学习分析", "learning analytics"]
  },
  {
    conceptId: "assessment",
    terms: [
      "过程性评价",
      "综合素质评价",
      "评价指标",
      "assessment"
    ]
  },
  {
    conceptId: "data_governance",
    terms: ["数据治理", "data governance"]
  },
  {
    conceptId: "privacy_ethics",
    terms: ["隐私", "伦理", "公平", "privacy", "ethics"]
  },
  {
    conceptId: "evidence_reasoning",
    terms: ["证据", "论证", "evidence", "reasoning"]
  },
  {
    conceptId: "resource_connection",
    terms: ["资源连接", "课程资源", "参考文献", "resource"]
  }
];

function assertHash(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`COURSE_GRAPH_${label}_INVALID`);
  }
  const normalized = value.trim().toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw new Error(`COURSE_GRAPH_${label}_INVALID`);
  }
  return normalized;
}

function normalizedTime(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("COURSE_GRAPH_OCCURRED_AT_INVALID");
  }
  return parsed.toISOString();
}

function normalizedOrdinal(
  value: number | null | undefined
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("COURSE_GRAPH_ORDINAL_INVALID");
  }
  return value;
}

function normalizedAttributes(
  attributes: SafeCourseGraphAttributes = {}
): SafeCourseGraphAttributes {
  if (
    !attributes ||
    typeof attributes !== "object" ||
    Array.isArray(attributes) ||
    Object.getPrototypeOf(attributes) !== Object.prototype
  ) {
    throw new Error("COURSE_GRAPH_ATTRIBUTES_INVALID");
  }
  const entries = Object.entries(attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!ATTRIBUTE_KEY_PATTERN.test(key)) {
        throw new Error("COURSE_GRAPH_ATTRIBUTE_KEY_INVALID");
      }
      if (
        value !== null &&
        !["string", "number", "boolean"].includes(typeof value)
      ) {
        throw new Error("COURSE_GRAPH_ATTRIBUTE_VALUE_INVALID");
      }
      if (
        typeof value === "number" &&
        (!Number.isSafeInteger(value) ||
          Math.abs(value) > MAX_GRAPH_COUNT)
      ) {
        throw new Error("COURSE_GRAPH_ATTRIBUTE_NUMBER_INVALID");
      }
      if (
        typeof value === "string" &&
        !ATTRIBUTE_CODE_PATTERN.test(value)
      ) {
        throw new Error("COURSE_GRAPH_ATTRIBUTE_TEXT_FORBIDDEN");
      }
      return [key, value] as const;
    });
  return Object.fromEntries(entries);
}

function assertEdgeShape(input: {
  sourceKind: CourseGraphNodeKind;
  kind: CourseGraphEdgeKind;
  targetKind: CourseGraphNodeKind;
  attributes: SafeCourseGraphAttributes;
}): void {
  const allowed =
    (input.kind === "contains" &&
      ((input.sourceKind === "course" &&
        input.targetKind === "column") ||
        (input.sourceKind === "column" &&
          input.targetKind === "thread"))) ||
    (input.kind === "authored" &&
      input.sourceKind === "actor" &&
      input.targetKind === "thread") ||
    (input.kind === "participated_in" &&
      input.sourceKind === "actor" &&
      input.targetKind === "thread") ||
    (input.kind === "reply_to" &&
      input.sourceKind === "actor" &&
      input.targetKind === "actor") ||
    (input.kind === "discusses" &&
      input.sourceKind === "thread" &&
      input.targetKind === "concept") ||
    (input.kind === "references_resource" &&
      input.sourceKind === "thread" &&
      input.targetKind === "resource");
  if (!allowed) {
    throw new Error("COURSE_GRAPH_EDGE_RELATION_INVALID");
  }
  for (const key of [
    "evidence_count",
    "occurrence_count",
    "weight"
  ]) {
    const value = input.attributes[key];
    if (
      value !== undefined &&
      (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > MAX_GRAPH_COUNT)
    ) {
      throw new Error("COURSE_GRAPH_EDGE_WEIGHT_INVALID");
    }
  }
}

function buildFact(input: {
  courseKey: string;
  factKind: "node" | "edge";
  subjectKey: string;
  subjectKind: CourseGraphNodeKind;
  predicate?: CourseGraphEdgeKind | null;
  objectKey?: string | null;
  objectKind?: CourseGraphNodeKind | null;
  revisionHash: string;
  occurredAt?: string | null;
  ordinal?: number | null;
  attributes?: SafeCourseGraphAttributes;
}): CourseStructureFact {
  const courseKey = assertHash(input.courseKey, "COURSE_KEY");
  const subjectKey = assertHash(input.subjectKey, "SUBJECT_KEY");
  const objectKey = input.objectKey
    ? assertHash(input.objectKey, "OBJECT_KEY")
    : null;
  const predicate = input.predicate ?? null;
  const objectKind = input.objectKind ?? null;
  if (!NODE_KIND_VALUES.has(input.subjectKind)) {
    throw new Error("COURSE_GRAPH_SUBJECT_KIND_INVALID");
  }
  if (
    input.factKind === "node" &&
    (predicate !== null ||
      objectKey !== null ||
      objectKind !== null)
  ) {
    throw new Error("COURSE_GRAPH_NODE_FACT_SHAPE_INVALID");
  }
  if (
    input.factKind === "edge" &&
    (!predicate || !objectKey || !objectKind)
  ) {
    throw new Error("COURSE_GRAPH_EDGE_FACT_SHAPE_INVALID");
  }
  if (
    input.factKind === "edge" &&
    subjectKey === objectKey
  ) {
    throw new Error("COURSE_GRAPH_SELF_EDGE_FACT_FORBIDDEN");
  }
  if (
    input.factKind === "edge" &&
    (!EDGE_KIND_VALUES.has(predicate as CourseGraphEdgeKind) ||
      !NODE_KIND_VALUES.has(
        objectKind as CourseGraphNodeKind
      ))
  ) {
    throw new Error("COURSE_GRAPH_EDGE_KIND_INVALID");
  }
  const revisionHash = assertHash(
    input.revisionHash,
    "REVISION_HASH"
  );
  const occurredAt = normalizedTime(input.occurredAt);
  const ordinal = normalizedOrdinal(input.ordinal);
  const attributes = normalizedAttributes(input.attributes);
  if (
    input.factKind === "edge" &&
    predicate &&
    objectKind
  ) {
    assertEdgeShape({
      sourceKind: input.subjectKind,
      kind: predicate,
      targetKind: objectKind,
      attributes
    });
  }
  const identityMaterial = {
    courseKey,
    factKind: input.factKind,
    subjectKey,
    subjectKind: input.subjectKind,
    predicate,
    objectKey,
    objectKind
  };
  const factIdentityKey = canonicalProtocolHash(
    "cmooc.course-structure-fact-identity.v1",
    identityMaterial as unknown as CanonicalJsonValue
  );
  const factWithoutKey = {
    schemaVersion: COURSE_STRUCTURE_FACT_SCHEMA_VERSION,
    factIdentityKey,
    ...identityMaterial,
    revisionHash,
    occurredAt,
    ordinal,
    attributes,
    legalityStatus: "admissible" as const,
    containsForumText: false as const
  };
  return {
    ...factWithoutKey,
    factKey: canonicalProtocolHash(
      COURSE_STRUCTURE_FACT_SCHEMA_VERSION,
      factWithoutKey as unknown as CanonicalJsonValue
    )
  };
}

export function createCourseStructureNodeFact(input: {
  courseKey: string;
  subjectKey: string;
  subjectKind: CourseGraphNodeKind;
  revisionHash: string;
  occurredAt?: string | null;
  ordinal?: number | null;
  attributes?: SafeCourseGraphAttributes;
}): CourseStructureFact {
  return buildFact({
    factKind: "node",
    ...input
  });
}

export function createCourseStructureEdgeFact(input: {
  courseKey: string;
  sourceKey: string;
  sourceKind: CourseGraphNodeKind;
  targetKey: string;
  targetKind: CourseGraphNodeKind;
  kind: CourseGraphEdgeKind;
  revisionHash: string;
  occurredAt?: string | null;
  ordinal?: number | null;
  attributes?: SafeCourseGraphAttributes;
}): CourseStructureFact {
  return buildFact({
    courseKey: input.courseKey,
    factKind: "edge",
    subjectKey: input.sourceKey,
    subjectKind: input.sourceKind,
    predicate: input.kind,
    objectKey: input.targetKey,
    objectKind: input.targetKind,
    revisionHash: input.revisionHash,
    occurredAt: input.occurredAt,
    ordinal: input.ordinal,
    attributes: input.attributes
  });
}

export function parseCanonicalCourseStructureFact(
  value: unknown
): CourseStructureFact {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("COURSE_STRUCTURE_FACT_INVALID");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "attributes",
    "containsForumText",
    "courseKey",
    "factIdentityKey",
    "factKey",
    "factKind",
    "legalityStatus",
    "objectKey",
    "objectKind",
    "occurredAt",
    "ordinal",
    "predicate",
    "revisionHash",
    "schemaVersion",
    "subjectKey",
    "subjectKind"
  ];
  if (
    JSON.stringify(Object.keys(record).sort()) !==
    JSON.stringify(expectedKeys)
  ) {
    throw new Error("COURSE_STRUCTURE_FACT_SHAPE_INVALID");
  }
  if (
    record.schemaVersion !==
      COURSE_STRUCTURE_FACT_SCHEMA_VERSION ||
    record.legalityStatus !== "admissible" ||
    record.containsForumText !== false ||
    !["node", "edge"].includes(String(record.factKind)) ||
    !NODE_KIND_VALUES.has(
      record.subjectKind as CourseGraphNodeKind
    )
  ) {
    throw new Error("COURSE_STRUCTURE_FACT_CONTRACT_INVALID");
  }
  const factKind = record.factKind as "node" | "edge";
  const rebuilt =
    factKind === "node"
      ? createCourseStructureNodeFact({
          courseKey: record.courseKey as string,
          subjectKey: record.subjectKey as string,
          subjectKind:
            record.subjectKind as CourseGraphNodeKind,
          revisionHash: record.revisionHash as string,
          occurredAt: record.occurredAt as string | null,
          ordinal: record.ordinal as number | null,
          attributes:
            record.attributes as SafeCourseGraphAttributes
        })
      : createCourseStructureEdgeFact({
          courseKey: record.courseKey as string,
          sourceKey: record.subjectKey as string,
          sourceKind:
            record.subjectKind as CourseGraphNodeKind,
          targetKey: record.objectKey as string,
          targetKind:
            record.objectKind as CourseGraphNodeKind,
          kind: record.predicate as CourseGraphEdgeKind,
          revisionHash: record.revisionHash as string,
          occurredAt: record.occurredAt as string | null,
          ordinal: record.ordinal as number | null,
          attributes:
            record.attributes as SafeCourseGraphAttributes
        });
  const primitiveKeys: Array<keyof CourseStructureFact> = [
    "schemaVersion",
    "courseKey",
    "factKey",
    "factIdentityKey",
    "factKind",
    "subjectKey",
    "subjectKind",
    "predicate",
    "objectKey",
    "objectKind",
    "revisionHash",
    "occurredAt",
    "ordinal",
    "legalityStatus",
    "containsForumText"
  ];
  if (
    primitiveKeys.some(
      (key) => record[key] !== rebuilt[key]
    ) ||
    JSON.stringify(record.attributes) !==
      JSON.stringify(rebuilt.attributes)
  ) {
    throw new Error("COURSE_STRUCTURE_FACT_CANONICAL_INVALID");
  }
  return rebuilt;
}

export function deriveCourseGraphNodeKey(input: {
  secret: Buffer | string;
  courseRef: string;
  kind: DerivedCourseGraphNodeKind;
  sourceRef: string;
}): string {
  const courseRef = input.courseRef.trim();
  const sourceRef = input.sourceRef.trim();
  if (!courseRef || !sourceRef) {
    throw new Error("COURSE_GRAPH_SOURCE_REF_REQUIRED");
  }
  return localEvidenceHmac({
    secret: input.secret,
    scope: `autonomy-course-graph-${input.kind}-ref-v1`,
    value: `${courseRef}\0${sourceRef}`,
    length: 64
  });
}

export function deriveCourseGraphRevisionHash(input: {
  secret: Buffer | string;
  courseRef: string;
  scope: string;
  versionMaterial: string;
}): string {
  const courseRef = input.courseRef.trim();
  const scope = input.scope.trim();
  if (!courseRef || !scope || scope.length > 120) {
    throw new Error("COURSE_GRAPH_REVISION_SCOPE_INVALID");
  }
  return localEvidenceHmac({
    secret: input.secret,
    scope: "autonomy-course-graph-revision-v1",
    value: [
      courseRef,
      scope,
      input.versionMaterial
    ].join("\0"),
    length: 64
  });
}

function occurrenceCount(
  text: string,
  term: string
): number {
  if (!term) return 0;
  const haystack = text.toLocaleLowerCase("zh-Hans-CN");
  const needle = term.toLocaleLowerCase("zh-Hans-CN");
  let count = 0;
  let offset = 0;
  const latinToken = /^[a-z0-9 ]+$/i.test(term);
  while (offset < haystack.length) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) break;
    const before = found > 0 ? haystack[found - 1] : "";
    const after =
      found + needle.length < haystack.length
        ? haystack[found + needle.length]
        : "";
    if (
      !latinToken ||
      (!/[a-z0-9_]/i.test(before) &&
        !/[a-z0-9_]/i.test(after))
    ) {
      count += 1;
    }
    offset = found + Math.max(needle.length, 1);
  }
  return count;
}

export function extractControlledConceptSignals(
  texts: readonly string[]
): ControlledConceptSignal[] {
  const joined = texts
    .filter((value) => typeof value === "string")
    .join("\n");
  return CONTROLLED_CONCEPTS.flatMap((concept) => {
    const count = concept.terms.reduce(
      (sum, term) => sum + occurrenceCount(joined, term),
      0
    );
    return count > 0
      ? [
          {
            conceptId: concept.conceptId,
            occurrenceCount: count,
            taxonomyVersion:
              CONTROLLED_COURSE_CONCEPT_TAXONOMY_VERSION
          }
        ]
      : [];
  }).sort((left, right) =>
    left.conceptId.localeCompare(right.conceptId)
  );
}

export function extractHashedResourceSignals(input: {
  secret: Buffer | string;
  courseRef: string;
  texts: readonly string[];
}): HashedResourceSignal[] {
  const counts = new Map<string, number>();
  const pattern = /https?:\/\/[^\s<>"']+/giu;
  for (const text of input.texts) {
    for (const match of text.match(pattern) ?? []) {
      const trimmed = match.replace(/[),.;!?，。；！？）]+$/u, "");
      try {
        const parsed = new URL(trimmed);
        if (!["http:", "https:"].includes(parsed.protocol)) continue;
        if (parsed.username || parsed.password) continue;
        parsed.hash = "";
        const stableQueryEntries = [...parsed.searchParams.entries()]
          .filter(
            ([key]) =>
              !/^(?:access_?token|auth|authorization|expires?|expiry|key|nonce|sig|signature|timestamp|token|ts)$/i.test(
                key
              )
          )
          .sort(
            (left, right) =>
              left[0].localeCompare(right[0]) ||
              left[1].localeCompare(right[1])
          );
        parsed.search = "";
        for (const [key, value] of stableQueryEntries) {
          parsed.searchParams.append(key, value);
        }
        const normalized = parsed.toString();
        counts.set(
          normalized,
          (counts.get(normalized) ?? 0) + 1
        );
      } catch {
        continue;
      }
    }
  }
  return [...counts]
    .map(([resourceRef, count]) => ({
      resourceKey: deriveCourseGraphNodeKey({
        secret: input.secret,
        courseRef: input.courseRef,
        kind: "resource",
        sourceRef: resourceRef
      }),
      occurrenceCount: count,
      resourceKind: "external_url" as const
    }))
    .sort((left, right) =>
      left.resourceKey.localeCompare(right.resourceKey)
    );
}

export function hashCourseStructureFactSet(
  facts: readonly CourseStructureFact[]
): string {
  const uniqueByKey = new Map<string, CourseStructureFact>();
  for (const inputFact of facts) {
    const fact = parseCanonicalCourseStructureFact(inputFact);
    const existing = uniqueByKey.get(fact.factKey);
    if (
      existing &&
      JSON.stringify(existing) !== JSON.stringify(fact)
    ) {
      throw new Error("COURSE_STRUCTURE_FACT_KEY_CONFLICT");
    }
    uniqueByKey.set(fact.factKey, fact);
  }
  const ordered = [...uniqueByKey.values()].sort((left, right) =>
    left.factKey.localeCompare(right.factKey)
  );
  return canonicalProtocolHash(
    COURSE_STRUCTURE_FACT_SET_SCHEMA_VERSION,
    {
      schemaVersion: COURSE_STRUCTURE_FACT_SET_SCHEMA_VERSION,
      facts: ordered,
      containsForumText: false
    } as unknown as CanonicalJsonValue
  );
}
