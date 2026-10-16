import {
  assertMoveSpecMatchesIntent,
  canonicalProtocolHash,
  type CanonicalJsonValue,
  type FacilitationMoveSpecV1,
  type InterventionIntentV1
} from "@/lib/facilitation-protocol";
import {
  normalizeTransientDraftBody,
  hashTransientDraftBody
} from "@/lib/live-runtime/draft-content";
import {
  buildDeterministicFacilitationDraft,
  type ActiveFacilitationFunction,
  type LiveOpportunityReceipt,
  type LiveOpportunityResult
} from "@/lib/live-runtime/facilitation-kernel";

export const SEMANTIC_RENDERER_REQUEST_SCHEMA_VERSION =
  "cmooc.semantic-renderer-request.v1" as const;
export const SEMANTIC_RENDERER_RECEIPT_SCHEMA_VERSION =
  "cmooc.semantic-renderer-receipt.v1" as const;
export const SEMANTIC_RENDERER_CONTRACT_VERSION =
  "cmooc.constrained-semantic-renderer.v1" as const;
export const SEMANTIC_RENDERER_VERSION =
  "cmooc.semantic-renderer.v1" as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const RENDERER_LABEL_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAXIMUM_ALLOWED_BODY_CHARACTERS = 4_000;

type RenderingReceiptFields = Pick<
  LiveOpportunityReceipt,
  | "decision"
  | "decisionMode"
  | "selectedFunction"
  | "observationReceiptHash"
  | "historyCutoffHash"
  | "historyEvidenceHash"
  | "targetVersionHash"
  | "eventSetHash"
  | "evidenceAsOf"
  | "intent"
  | "intentHash"
  | "moveSpec"
  | "moveSpecHash"
  | "draftCreated"
  | "draftContentHash"
  | "draftGeneratorVersion"
  | "draftBodyPersisted"
  | "containsForumText"
>;

export type SemanticRenderingOpportunity = Pick<
  LiveOpportunityResult,
  "receiptHash" | "transientDraft"
> & {
  receipt: RenderingReceiptFields;
};

export type SemanticRendererConfiguration = Readonly<{
  enabled: boolean;
  provider: string;
  model: string;
  maximumBodyCharacters: number;
}>;

export type SemanticRendererModelRequest = {
  schemaVersion: typeof SEMANTIC_RENDERER_REQUEST_SCHEMA_VERSION;
  contractVersion: typeof SEMANTIC_RENDERER_CONTRACT_VERSION;
  opportunityReceiptHash: string;
  evidenceAsOf: string;
  evidenceHashes: {
    observationReceiptHash: string;
    historyCutoffHash: string;
    historyEvidenceHash: string | null;
    eventSetHash: string;
  };
  targetVersionHash: string;
  intent: InterventionIntentV1;
  intentHash: string;
  moveSpec: FacilitationMoveSpecV1;
  moveSpecHash: string;
  outputContract: {
    requiredKeys: readonly ["body"];
    additionalProperties: false;
    maximumBodyCharacters: number;
  };
  containsForumText: false;
  containsIdentity: false;
  containsPlatformIdentifiers: false;
};

export type SemanticRendererGenerator = (
  request: Readonly<SemanticRendererModelRequest>
) => unknown | Promise<unknown>;

export type SemanticRendererFallbackReason =
  | "renderer_disabled"
  | "generator_unavailable"
  | "generator_error"
  | "invalid_model_output";

export type SemanticRendererReceipt = {
  schemaVersion: typeof SEMANTIC_RENDERER_RECEIPT_SCHEMA_VERSION;
  rendererVersion: typeof SEMANTIC_RENDERER_VERSION;
  contractVersion: typeof SEMANTIC_RENDERER_CONTRACT_VERSION;
  provider: string;
  model: string;
  decision: LiveOpportunityReceipt["decision"];
  decisionMode: LiveOpportunityReceipt["decisionMode"];
  resolution:
    | "model_generated"
    | "deterministic_fallback"
    | "skipped_non_draft";
  fallbackReason: SemanticRendererFallbackReason | null;
  modelInvoked: boolean;
  modelOutputAccepted: boolean;
  opportunityReceiptHash: string;
  evidenceAsOf: string;
  observationReceiptHash: string;
  historyCutoffHash: string;
  historyEvidenceHash: string | null;
  eventSetHash: string;
  targetVersionHash: string;
  selectedFunction:
    LiveOpportunityReceipt["selectedFunction"];
  targetObject: InterventionIntentV1["targetObject"];
  intentHash: string | null;
  moveSpecHash: string | null;
  contentHash: string | null;
  bodyPersisted: false;
  containsForumText: false;
};

export type SemanticRendererResult = {
  receipt: SemanticRendererReceipt;
  receiptHash: string;
  transientBody: string | null;
};

export function rebuildDeterministicSemanticDraft(input: {
  intent: InterventionIntentV1;
  moveSpec: FacilitationMoveSpecV1;
  intentHash: string;
  moveSpecHash: string;
  expectedContentHash: string;
}): string {
  const { intent, moveSpec } = assertMoveSpecMatchesIntent(
    input.intent,
    input.moveSpec
  );
  assertHash(input.intentHash, "Intent 哈希");
  assertHash(input.moveSpecHash, "MoveSpec 哈希");
  assertHash(input.expectedContentHash, "语义内容哈希");
  if (
    canonicalProtocolHash(
      intent.schemaVersion,
      intent as CanonicalJsonValue
    ) !== input.intentHash ||
    canonicalProtocolHash(
      moveSpec.schemaVersion,
      moveSpec as CanonicalJsonValue
    ) !== input.moveSpecHash
  ) {
    throw new Error(
      "持久语义结构与 Intent/MoveSpec 绑定不一致。"
    );
  }
  const body = normalizeTransientDraftBody(
    buildDeterministicFacilitationDraft(
      intent.facilitationFunction as ActiveFacilitationFunction
    )
  ).trim();
  if (
    hashTransientDraftBody(body) !== input.expectedContentHash
  ) {
    throw new Error("重建草稿与持久内容哈希不一致。");
  }
  return body;
}

function assertHash(value: string, label: string): void {
  if (!HASH_PATTERN.test(value)) {
    throw new Error(`${label} 必须是规范 SHA-256 哈希。`);
  }
}

function assertOptionalHash(
  value: string | null,
  label: string
): void {
  if (value !== null) assertHash(value, label);
}

function assertIsoTime(value: string, label: string): void {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} 必须是 ISO-8601 时间。`);
  }
}

function hasSubstantiveText(value: string): boolean {
  return value.replace(/[\s\u200B-\u200D\u2060\uFEFF]/gu, "")
    .length > 0;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(
      value as Record<string, unknown>
    )) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function parseConfiguration(
  config: SemanticRendererConfiguration
): SemanticRendererConfiguration {
  for (const [label, value] of [
    ["provider", config.provider],
    ["model", config.model]
  ] as const) {
    if (!RENDERER_LABEL_PATTERN.test(value)) {
      throw new Error(`语义渲染器 ${label} 标识无效。`);
    }
  }
  if (
    !Number.isSafeInteger(config.maximumBodyCharacters) ||
    config.maximumBodyCharacters < 1 ||
    config.maximumBodyCharacters >
      MAXIMUM_ALLOWED_BODY_CHARACTERS
  ) {
    throw new Error("语义渲染器正文长度上限无效。");
  }
  return config;
}

function validateCommonOpportunity(
  opportunity: SemanticRenderingOpportunity
): void {
  const receipt = opportunity.receipt;
  assertHash(opportunity.receiptHash, "机会回执哈希");
  assertHash(receipt.observationReceiptHash, "观察回执哈希");
  assertHash(receipt.historyCutoffHash, "历史截止哈希");
  assertOptionalHash(receipt.historyEvidenceHash, "历史证据哈希");
  assertHash(receipt.targetVersionHash, "目标版本哈希");
  assertHash(receipt.eventSetHash, "事件集合哈希");
  assertIsoTime(receipt.evidenceAsOf, "证据截止时间");
  if (
    receipt.containsForumText ||
    receipt.draftBodyPersisted
  ) {
    throw new Error("语义渲染只接受去正文机会回执。");
  }
}

function validateNonDraftOpportunity(
  opportunity: SemanticRenderingOpportunity
): void {
  const receipt = opportunity.receipt;
  if (
    receipt.intent !== null ||
    receipt.intentHash !== null ||
    receipt.moveSpec !== null ||
    receipt.moveSpecHash !== null ||
    receipt.selectedFunction !== null ||
    receipt.draftCreated ||
    receipt.draftContentHash !== null ||
    receipt.draftGeneratorVersion !== null ||
    opportunity.transientDraft !== null
  ) {
    throw new Error("非 DRAFT 决策不得携带语义生成负载。");
  }
}

function validateDraftOpportunity(
  opportunity: SemanticRenderingOpportunity,
  maximumBodyCharacters: number
): {
  intent: InterventionIntentV1;
  moveSpec: FacilitationMoveSpecV1;
  fallbackBody: string;
} {
  const receipt = opportunity.receipt;
  if (
    receipt.intent === null ||
    receipt.intentHash === null ||
    receipt.moveSpec === null ||
    receipt.moveSpecHash === null ||
    receipt.selectedFunction === null ||
    !receipt.draftCreated ||
    receipt.draftContentHash === null ||
    receipt.draftGeneratorVersion === null ||
    opportunity.transientDraft === null
  ) {
    throw new Error("DRAFT 决策缺少完整的受约束语义负载。");
  }
  const { intent, moveSpec } = assertMoveSpecMatchesIntent(
    receipt.intent,
    receipt.moveSpec
  );
  const actualIntentHash = canonicalProtocolHash(
    intent.schemaVersion,
    intent as CanonicalJsonValue
  );
  const actualMoveSpecHash = canonicalProtocolHash(
    moveSpec.schemaVersion,
    moveSpec as CanonicalJsonValue
  );
  if (
    actualIntentHash !== receipt.intentHash ||
    actualMoveSpecHash !== receipt.moveSpecHash
  ) {
    throw new Error("Intent 或 MoveSpec 哈希与机会回执不一致。");
  }
  if (
    intent.facilitationFunction !== receipt.selectedFunction ||
    moveSpec.targetObject !== intent.targetObject
  ) {
    throw new Error("语义渲染负载改变了促进功能或目标对象。");
  }
  const fallbackBody = normalizeTransientDraftBody(
    opportunity.transientDraft
  ).trim();
  if (
    !hasSubstantiveText(fallbackBody) ||
    Array.from(fallbackBody).length >
      maximumBodyCharacters ||
    hashTransientDraftBody(fallbackBody) !==
      receipt.draftContentHash
  ) {
    throw new Error("确定性回退草稿未通过完整性校验。");
  }
  return { intent, moveSpec, fallbackBody };
}

function parseModelBody(
  output: unknown,
  maximumBodyCharacters: number
): string | null {
  try {
    if (
      output === null ||
      typeof output !== "object" ||
      Array.isArray(output) ||
      Object.getPrototypeOf(output) !== Object.prototype
    ) {
      return null;
    }
    const keys = Object.keys(output);
    if (keys.length !== 1 || keys[0] !== "body") {
      return null;
    }
    const body = (output as { body?: unknown }).body;
    if (typeof body !== "string") return null;
    const normalized = normalizeTransientDraftBody(body).trim();
    if (
      !hasSubstantiveText(normalized) ||
      Array.from(normalized).length >
        maximumBodyCharacters
    ) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

function sealResult(
  receipt: SemanticRendererReceipt,
  transientBody: string | null
): SemanticRendererResult {
  return {
    receipt,
    receiptHash: canonicalProtocolHash(
      receipt.schemaVersion,
      receipt as CanonicalJsonValue
    ),
    transientBody
  };
}

function receiptBase(input: {
  opportunity: SemanticRenderingOpportunity;
  config: SemanticRendererConfiguration;
}): Omit<
  SemanticRendererReceipt,
  | "resolution"
  | "fallbackReason"
  | "modelInvoked"
  | "modelOutputAccepted"
  | "contentHash"
> {
  const receipt = input.opportunity.receipt;
  return {
    schemaVersion: SEMANTIC_RENDERER_RECEIPT_SCHEMA_VERSION,
    rendererVersion: SEMANTIC_RENDERER_VERSION,
    contractVersion: SEMANTIC_RENDERER_CONTRACT_VERSION,
    provider: input.config.provider,
    model: input.config.model,
    decision: receipt.decision,
    decisionMode: receipt.decisionMode,
    opportunityReceiptHash: input.opportunity.receiptHash,
    evidenceAsOf: receipt.evidenceAsOf,
    observationReceiptHash: receipt.observationReceiptHash,
    historyCutoffHash: receipt.historyCutoffHash,
    historyEvidenceHash: receipt.historyEvidenceHash,
    eventSetHash: receipt.eventSetHash,
    targetVersionHash: receipt.targetVersionHash,
    selectedFunction: receipt.selectedFunction,
    targetObject: receipt.intent?.targetObject ?? null,
    intentHash: receipt.intentHash,
    moveSpecHash: receipt.moveSpecHash,
    bodyPersisted: false,
    containsForumText: false
  };
}

export async function renderSemanticDraft(input: {
  opportunity: SemanticRenderingOpportunity;
  config: SemanticRendererConfiguration;
  generate?: SemanticRendererGenerator;
}): Promise<SemanticRendererResult> {
  const config = parseConfiguration(input.config);
  validateCommonOpportunity(input.opportunity);
  const base = receiptBase({
    opportunity: input.opportunity,
    config
  });

  if (input.opportunity.receipt.decision !== "draft") {
    validateNonDraftOpportunity(input.opportunity);
    return sealResult(
      {
        ...base,
        resolution: "skipped_non_draft",
        fallbackReason: null,
        modelInvoked: false,
        modelOutputAccepted: false,
        contentHash: null
      },
      null
    );
  }

  const { intent, moveSpec, fallbackBody } =
    validateDraftOpportunity(
      input.opportunity,
      config.maximumBodyCharacters
    );
  const fallback = (
    reason: SemanticRendererFallbackReason,
    modelInvoked: boolean
  ) =>
    sealResult(
      {
        ...base,
        resolution: "deterministic_fallback",
        fallbackReason: reason,
        modelInvoked,
        modelOutputAccepted: false,
        contentHash: hashTransientDraftBody(fallbackBody)
      },
      fallbackBody
    );

  if (!config.enabled) {
    return fallback("renderer_disabled", false);
  }
  if (!input.generate) {
    return fallback("generator_unavailable", false);
  }

  const request = deepFreeze<SemanticRendererModelRequest>({
    schemaVersion: SEMANTIC_RENDERER_REQUEST_SCHEMA_VERSION,
    contractVersion: SEMANTIC_RENDERER_CONTRACT_VERSION,
    opportunityReceiptHash: input.opportunity.receiptHash,
    evidenceAsOf: input.opportunity.receipt.evidenceAsOf,
    evidenceHashes: {
      observationReceiptHash:
        input.opportunity.receipt.observationReceiptHash,
      historyCutoffHash:
        input.opportunity.receipt.historyCutoffHash,
      historyEvidenceHash:
        input.opportunity.receipt.historyEvidenceHash,
      eventSetHash: input.opportunity.receipt.eventSetHash
    },
    targetVersionHash:
      input.opportunity.receipt.targetVersionHash,
    intent: {
      ...intent,
      withdrawalConditions: [...intent.withdrawalConditions]
    },
    intentHash: input.opportunity.receipt.intentHash!,
    moveSpec: {
      ...moveSpec,
      requiredContentElements: [
        ...moveSpec.requiredContentElements
      ],
      prohibitedMoves: [...moveSpec.prohibitedMoves],
      observableSuccessCriteria: [
        ...moveSpec.observableSuccessCriteria
      ]
    },
    moveSpecHash: input.opportunity.receipt.moveSpecHash!,
    outputContract: {
      requiredKeys: ["body"],
      additionalProperties: false,
      maximumBodyCharacters: config.maximumBodyCharacters
    },
    containsForumText: false,
    containsIdentity: false,
    containsPlatformIdentifiers: false
  });

  let output: unknown;
  try {
    output = await input.generate(request);
  } catch {
    return fallback("generator_error", true);
  }
  const generatedBody = parseModelBody(
    output,
    config.maximumBodyCharacters
  );
  if (generatedBody === null) {
    return fallback("invalid_model_output", true);
  }
  return sealResult(
    {
      ...base,
      resolution: "model_generated",
      fallbackReason: null,
      modelInvoked: true,
      modelOutputAccepted: true,
      contentHash: hashTransientDraftBody(generatedBody)
    },
    generatedBody
  );
}
