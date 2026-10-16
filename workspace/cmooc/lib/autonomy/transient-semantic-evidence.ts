import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import type {
  ContributionFunction,
  DominantNeed,
  EvidenceStatus,
  NeedSignals
} from "@/lib/live-runtime/facilitation-kernel";

export const AUTONOMY_SEMANTIC_EVIDENCE_SCHEMA_VERSION =
  "cmooc.autonomy-semantic-evidence.v1" as const;
export const AUTONOMY_SEMANTIC_ANALYZER_VERSION =
  "cmooc.bounded-lexical-semantic-analyzer.v1" as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_ANALYZED_CHARACTERS = 20_000;
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
const RECEIPT_FIELDS = new Set([
  "schemaVersion",
  "analyzerVersion",
  "observationReceiptHash",
  "targetVersionHash",
  "eventSetHash",
  "observedAt",
  "contributionFunctions",
  "sequenceCompletion",
  "atomicIdeaCount",
  "epistemicSeedStatus",
  "needSignals",
  "dominantNeed",
  "semanticEvidenceStatus",
  "analyzedCharacterCount",
  "inputTruncated",
  "featureEvidenceHash",
  "containsForumText"
]);

export type AutonomySemanticEvidenceReceipt = {
  schemaVersion: typeof AUTONOMY_SEMANTIC_EVIDENCE_SCHEMA_VERSION;
  analyzerVersion: typeof AUTONOMY_SEMANTIC_ANALYZER_VERSION;
  observationReceiptHash: string;
  targetVersionHash: string;
  eventSetHash: string;
  observedAt: string;
  contributionFunctions: ContributionFunction[];
  sequenceCompletion: "open" | "socially_complete" | "unknown";
  atomicIdeaCount: number;
  epistemicSeedStatus: EvidenceStatus;
  needSignals: NeedSignals;
  dominantNeed: DominantNeed;
  semanticEvidenceStatus: "supported" | "insufficient";
  analyzedCharacterCount: number;
  inputTruncated: boolean;
  featureEvidenceHash: string;
  containsForumText: false;
};

function assertHash(value: string, label: string): void {
  if (!HASH_PATTERN.test(value)) {
    throw new Error(`${label}必须是规范 SHA-256 哈希。`);
  }
}

function assertIsoTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("语义证据观察时间无效。");
  }
  return new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Revalidates the body-free feature receipt before a completed scan reuses it.
 * The strict field list prevents a future caller from smuggling source text,
 * identities, or credentials into the durable retry record.
 */
export function parseAutonomySemanticEvidenceReceipt(
  value: unknown
): AutonomySemanticEvidenceReceipt {
  if (!isRecord(value)) {
    throw new Error("AUTONOMY_SEMANTIC_EVIDENCE_INVALID");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== RECEIPT_FIELDS.size ||
    keys.some((key) => !RECEIPT_FIELDS.has(key))
  ) {
    throw new Error("AUTONOMY_SEMANTIC_EVIDENCE_FIELDS_INVALID");
  }
  if (
    value.schemaVersion !== AUTONOMY_SEMANTIC_EVIDENCE_SCHEMA_VERSION ||
    value.analyzerVersion !== AUTONOMY_SEMANTIC_ANALYZER_VERSION ||
    value.containsForumText !== false
  ) {
    throw new Error("AUTONOMY_SEMANTIC_EVIDENCE_BOUNDARY_INVALID");
  }
  for (const field of [
    "observationReceiptHash",
    "targetVersionHash",
    "eventSetHash",
    "featureEvidenceHash"
  ] as const) {
    if (typeof value[field] !== "string") {
      throw new Error("AUTONOMY_SEMANTIC_EVIDENCE_HASH_INVALID");
    }
    assertHash(value[field], field);
  }
  if (typeof value.observedAt !== "string") {
    throw new Error("AUTONOMY_SEMANTIC_EVIDENCE_TIME_INVALID");
  }
  const observedAt = assertIsoTime(value.observedAt);
  if (
    !Array.isArray(value.contributionFunctions) ||
    value.contributionFunctions.some(
      (item) =>
        typeof item !== "string" ||
        !CONTRIBUTION_FUNCTIONS.has(item as ContributionFunction)
    ) ||
    new Set(value.contributionFunctions).size !==
      value.contributionFunctions.length
  ) {
    throw new Error("AUTONOMY_SEMANTIC_EVIDENCE_FUNCTIONS_INVALID");
  }
  if (
    value.sequenceCompletion !== "open" &&
    value.sequenceCompletion !== "socially_complete" &&
    value.sequenceCompletion !== "unknown"
  ) {
    throw new Error("AUTONOMY_SEMANTIC_EVIDENCE_SEQUENCE_INVALID");
  }
  if (
    typeof value.atomicIdeaCount !== "number" ||
    !Number.isSafeInteger(value.atomicIdeaCount) ||
    value.atomicIdeaCount < 0 ||
    value.atomicIdeaCount > 5 ||
    typeof value.analyzedCharacterCount !== "number" ||
    !Number.isSafeInteger(value.analyzedCharacterCount) ||
    value.analyzedCharacterCount < 0 ||
    value.analyzedCharacterCount > MAX_ANALYZED_CHARACTERS ||
    typeof value.inputTruncated !== "boolean"
  ) {
    throw new Error("AUTONOMY_SEMANTIC_EVIDENCE_COUNTS_INVALID");
  }
  if (
    typeof value.epistemicSeedStatus !== "string" ||
    !EVIDENCE_STATUSES.has(value.epistemicSeedStatus as EvidenceStatus) ||
    typeof value.dominantNeed !== "string" ||
    !DOMINANT_NEEDS.has(value.dominantNeed as DominantNeed) ||
    (value.semanticEvidenceStatus !== "supported" &&
      value.semanticEvidenceStatus !== "insufficient") ||
    !isRecord(value.needSignals) ||
    Object.keys(value.needSignals).length !== 3 ||
    !EVIDENCE_STATUSES.has(
      value.needSignals.connectionGap as EvidenceStatus
    ) ||
    !EVIDENCE_STATUSES.has(
      value.needSignals.conceptualTension as EvidenceStatus
    ) ||
    !EVIDENCE_STATUSES.has(
      value.needSignals.participationBarrier as EvidenceStatus
    )
  ) {
    throw new Error("AUTONOMY_SEMANTIC_EVIDENCE_STATUS_INVALID");
  }
  return {
    ...(value as unknown as AutonomySemanticEvidenceReceipt),
    observedAt
  };
}

function hasAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function evidenceStatus(
  supported: boolean,
  sufficientText: boolean
): EvidenceStatus {
  if (!sufficientText) return "unknown";
  return supported ? "supported" : "unsupported";
}

export function analyzeTransientSemanticEvidence(input: {
  observationReceiptHash: string;
  targetVersionHash: string;
  eventSetHash: string;
  observedAt: string;
  texts: readonly string[];
  sequenceCompletion?: "open" | "socially_complete" | "unknown";
}): {
  receipt: AutonomySemanticEvidenceReceipt;
  receiptHash: string;
} {
  assertHash(input.observationReceiptHash, "观察回执哈希");
  assertHash(input.targetVersionHash, "目标版本哈希");
  assertHash(input.eventSetHash, "事件集合哈希");
  const observedAt = assertIsoTime(input.observedAt);
  const normalized = input.texts
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.normalize("NFKC").trim())
    .filter(Boolean)
    .join("\n");
  const inputTruncated =
    Array.from(normalized).length > MAX_ANALYZED_CHARACTERS;
  const analyzedText = Array.from(normalized)
    .slice(0, MAX_ANALYZED_CHARACTERS)
    .join("");
  const compact = analyzedText.replace(
    /[\s\u200B-\u200D\u2060\uFEFF]/gu,
    ""
  );
  const analyzedCharacterCount = Array.from(compact).length;
  const sufficientText = analyzedCharacterCount >= 24;
  const hasQuestion = /[?？]/u.test(analyzedText) ||
    hasAny(analyzedText, [
      /为什么/u,
      /如何/u,
      /是否/u,
      /什么条件/u,
      /还会/u,
      /能否/u
    ]);
  const hasClaim = hasAny(analyzedText, [
    /我认为/u,
    /我觉得/u,
    /我的理解/u,
    /因为/u,
    /所以/u,
    /说明/u,
    /意味着/u,
    /例如/u,
    /比如/u
  ]);
  const hasContrast = hasAny(analyzedText, [
    /但是/u,
    /然而/u,
    /相反/u,
    /反例/u,
    /矛盾/u,
    /如果/u,
    /边界/u,
    /条件/u
  ]);
  const hasResourceRequest = hasAny(analyzedText, [
    /有没有.*(?:资源|资料|文献|链接)/u,
    /哪里.*(?:资源|资料|文献)/u,
    /谁能.*(?:回应|分享|推荐)/u,
    /希望.*同伴/u,
    /需要.*(?:连接|联系|交流)/u
  ]);
  const hasOperationalNeed = hasAny(analyzedText, [
    /怎么做/u,
    /如何操作/u,
    /具体步骤/u,
    /实践中/u,
    /怎样应用/u
  ]);
  const hasParticipationBarrier = hasAny(analyzedText, [
    /不敢/u,
    /担心/u,
    /焦虑/u,
    /害怕/u,
    /不知道怎么参与/u,
    /不想发言/u,
    /难以参与/u,
    /卡住/u
  ]);
  const hasSocialAffective =
    hasParticipationBarrier ||
    hasAny(analyzedText, [
      /感谢/u,
      /支持/u,
      /鼓励/u,
      /感受/u,
      /情绪/u
    ]);
  const hasInnovation = hasAny(analyzedText, [
    /提出/u,
    /设想/u,
    /改进/u,
    /新方案/u,
    /也许/u,
    /可能/u,
    /如果/u
  ]);
  const epistemicSeedSupported =
    sufficientText &&
    (hasQuestion || hasClaim || hasContrast || hasInnovation);
  const conceptualTension =
    sufficientText &&
    epistemicSeedSupported &&
    (hasQuestion || hasContrast || hasClaim);

  const contributionFunctions: ContributionFunction[] = [];
  if (hasOperationalNeed) contributionFunctions.push("operational");
  if (hasResourceRequest) contributionFunctions.push("wayfinding");
  if (epistemicSeedSupported) {
    contributionFunctions.push("meaning_making");
  }
  if (hasInnovation) contributionFunctions.push("innovation");
  if (hasSocialAffective) {
    contributionFunctions.push("social_affective");
  }

  const needSignals: NeedSignals = {
    connectionGap: evidenceStatus(
      hasResourceRequest,
      sufficientText
    ),
    conceptualTension: evidenceStatus(
      conceptualTension,
      sufficientText
    ),
    participationBarrier: evidenceStatus(
      hasParticipationBarrier,
      sufficientText
    )
  };
  const dominantNeed: DominantNeed =
    needSignals.participationBarrier === "supported"
      ? "participation_barrier"
      : needSignals.connectionGap === "supported"
        ? "connection_gap"
        : needSignals.conceptualTension === "supported"
          ? "conceptual_tension"
          : "unknown";
  const atomicIdeaCount = sufficientText
    ? Math.max(
        1,
        Math.min(
          5,
          analyzedText
            .split(/[。！？!?；;\n]+/u)
            .map((value) => value.trim())
            .filter((value) => Array.from(value).length >= 8)
            .length
        )
      )
    : 0;
  const featureEvidenceHash = canonicalProtocolHash(
    "cmooc.autonomy-semantic-feature-evidence.v1",
    {
      sufficientText,
      analyzedCharacterCount,
      inputTruncated,
      hasQuestion,
      hasClaim,
      hasContrast,
      hasResourceRequest,
      hasOperationalNeed,
      hasParticipationBarrier,
      hasSocialAffective,
      hasInnovation,
      atomicIdeaCount
    }
  );
  const receipt: AutonomySemanticEvidenceReceipt = {
    schemaVersion: AUTONOMY_SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    analyzerVersion: AUTONOMY_SEMANTIC_ANALYZER_VERSION,
    observationReceiptHash: input.observationReceiptHash,
    targetVersionHash: input.targetVersionHash,
    eventSetHash: input.eventSetHash,
    observedAt,
    contributionFunctions: [...new Set(contributionFunctions)],
    sequenceCompletion: input.sequenceCompletion ?? "open",
    atomicIdeaCount,
    epistemicSeedStatus: epistemicSeedSupported
      ? "supported"
      : sufficientText
        ? "unsupported"
        : "unknown",
    needSignals,
    dominantNeed,
    semanticEvidenceStatus:
      epistemicSeedSupported && dominantNeed !== "unknown"
        ? "supported"
        : "insufficient",
    analyzedCharacterCount,
    inputTruncated,
    featureEvidenceHash,
    containsForumText: false
  };
  return {
    receipt,
    receiptHash: canonicalProtocolHash(
      receipt.schemaVersion,
      receipt as unknown as CanonicalJsonValue
    )
  };
}
