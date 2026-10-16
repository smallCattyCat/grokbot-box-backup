import { canonicalProtocolHash } from "./canonical-hash";
import type { ProtocolSchemaName } from "./schemas";
import type {
  DecisionEvidenceRefV1,
  ExecutionCommandV1,
  ExecutionReceiptV1,
  FacilitationMoveSpecV1,
  InterventionEventV1,
  InterventionIntentV1,
  ObservationEnvelopeV1,
  ProtocolTypeMap
} from "./types";
import { parseProtocolObject } from "./validation";

export class ProtocolSemanticError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProtocolSemanticError";
    this.code = code;
  }
}

function protocolTime(value: string, fieldName: string): number {
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ? value
    : `${value}Z`;
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) {
    throw new ProtocolSemanticError(
      "INVALID_PROTOCOL_TIME",
      `${fieldName} 不是可比较的 ISO-8601 时间。`
    );
  }
  return milliseconds;
}

function assertNotAfter(
  earlier: string,
  later: string,
  code: string,
  message: string
): void {
  if (
    protocolTime(earlier, "earlier") >
    protocolTime(later, "later")
  ) {
    throw new ProtocolSemanticError(code, message);
  }
}

export function assertObservationEnvelopeSemantics(
  input: unknown
): ObservationEnvelopeV1 {
  const observation = parseProtocolObject("observationEnvelope", input);
  assertNotAfter(
    observation.evidenceAsOf,
    observation.observedAt,
    "EVIDENCE_AFTER_OBSERVATION",
    "evidenceAsOf 不得晚于 observedAt。"
  );
  assertNotAfter(
    observation.sourceObservedThrough,
    observation.observedAt,
    "SOURCE_CLOCK_AFTER_OBSERVATION",
    "sourceObservedThrough 不得晚于 observedAt。"
  );
  if (
    observation.temporalEvidenceStatus === "as_of_verified" &&
    protocolTime(observation.sourceObservedThrough, "sourceObservedThrough") <
      protocolTime(observation.evidenceAsOf, "evidenceAsOf")
  ) {
    throw new ProtocolSemanticError(
      "UNVERIFIED_AS_OF_BOUNDARY",
      "as_of_verified 要求来源观测终点覆盖 evidenceAsOf。"
    );
  }
  return observation;
}

export function assertDecisionEvidenceRefSemantics(
  input: unknown
): DecisionEvidenceRefV1 {
  const evidenceRef = parseProtocolObject("decisionEvidenceRef", input);
  const expectedSplit =
    evidenceRef.year === 2024 ? "development" : "time_holdout";
  if (evidenceRef.split !== expectedSplit) {
    throw new ProtocolSemanticError(
      "EVIDENCE_SPLIT_MISMATCH",
      "2024 必须属于 development，2025 必须属于 time_holdout。"
    );
  }
  protocolTime(evidenceRef.decisionAt, "decisionAt");
  return evidenceRef;
}

export function assertInterventionIntentSemantics(
  input: unknown
): InterventionIntentV1 {
  const intent = parseProtocolObject("interventionIntent", input);
  if (
    protocolTime(intent.candidateExpiresAt, "candidateExpiresAt") <=
    protocolTime(intent.evidenceAsOf, "evidenceAsOf")
  ) {
    throw new ProtocolSemanticError(
      "NON_POSITIVE_INTENT_TTL",
      "candidateExpiresAt 必须晚于 evidenceAsOf。"
    );
  }
  if (!intent.withdrawalConditions.includes("candidate_expired")) {
    throw new ProtocolSemanticError(
      "MISSING_EXPIRY_WITHDRAWAL",
      "候选意图必须声明 candidate_expired 撤回条件。"
    );
  }
  return intent;
}

const MOVE_BY_FUNCTION = {
  resource_connection: {
    needState: "connection_gap",
    mechanismTarget: "reduce_connection_cost",
    facilitationMove: "connect_resource_and_invite_application"
  },
  cognitive_conflict: {
    needState: "conceptual_tension",
    mechanismTarget: "surface_explanatory_tension",
    facilitationMove: "pose_counterexample_and_request_explanation"
  },
  emotional_support: {
    needState: "participation_barrier",
    mechanismTarget: "lower_reentry_cost",
    facilitationMove: "acknowledge_contribution_and_invite_return"
  }
} as const;

export function assertMoveSpecMatchesIntent(
  intentInput: unknown,
  moveSpecInput: unknown
): {
  intent: InterventionIntentV1;
  moveSpec: FacilitationMoveSpecV1;
} {
  const intent = assertInterventionIntentSemantics(intentInput);
  const moveSpec = parseProtocolObject(
    "facilitationMoveSpec",
    moveSpecInput
  );
  if (!intent.intervene || intent.facilitationFunction === null) {
    throw new ProtocolSemanticError(
      "MOVE_FOR_NON_INTERVENTION",
      "不介入意图不得生成促进动作。"
    );
  }
  const expectedIntentHash = canonicalProtocolHash(
    intent.schemaVersion,
    intent
  );
  if (moveSpec.intentHash !== expectedIntentHash) {
    throw new ProtocolSemanticError(
      "INTENT_HASH_MISMATCH",
      "促进动作引用的 intentHash 与规范化意图不一致。"
    );
  }
  if (moveSpec.targetObject !== intent.targetObject) {
    throw new ProtocolSemanticError(
      "TARGET_OBJECT_MISMATCH",
      "促进动作必须保持意图的目标对象。"
    );
  }
  const expected = MOVE_BY_FUNCTION[intent.facilitationFunction];
  for (const field of [
    "needState",
    "mechanismTarget",
    "facilitationMove"
  ] as const) {
    if (moveSpec[field] !== expected[field]) {
      throw new ProtocolSemanticError(
        "FACILITATION_FUNCTION_MISMATCH",
        `${field} 与 facilitationFunction 不匹配。`
      );
    }
  }
  for (const prohibited of [
    "answer_on_behalf_of_learner",
    "identity_ranking"
  ] as const) {
    if (!moveSpec.prohibitedMoves.includes(prohibited)) {
      throw new ProtocolSemanticError(
        "MISSING_CORE_PROHIBITION",
        `促进动作缺少核心禁止项 ${prohibited}。`
      );
    }
  }
  return { intent, moveSpec };
}

export function assertExecutionCommandSemantics(
  input: unknown
): ExecutionCommandV1 {
  const command = parseProtocolObject("executionCommand", input);
  if (
    protocolTime(command.expiresAt, "expiresAt") <=
    protocolTime(command.issuedAt, "issuedAt")
  ) {
    throw new ProtocolSemanticError(
      "NON_POSITIVE_COMMAND_TTL",
      "执行命令 expiresAt 必须晚于 issuedAt。"
    );
  }
  return command;
}

export function assertExecutionReceiptSemantics(
  input: unknown
): ExecutionReceiptV1 {
  const receipt = parseProtocolObject("executionReceipt", input);
  if (
    receipt.attemptedAt !== null &&
    protocolTime(receipt.attemptedAt, "attemptedAt") >
      protocolTime(receipt.recordedAt, "recordedAt")
  ) {
    throw new ProtocolSemanticError(
      "RECEIPT_RECORDED_BEFORE_ATTEMPT",
      "recordedAt 不得早于 attemptedAt。"
    );
  }
  if (
    receipt.outcome === "verified_published" &&
    (receipt.attemptedAt === null || receipt.remoteObjectRefHash === null)
  ) {
    throw new ProtocolSemanticError(
      "UNVERIFIED_PUBLISHED_RECEIPT",
      "verified_published 必须同时包含尝试时间和远端对象引用哈希。"
    );
  }
  if (
    receipt.outcome === "confirmed_not_attempted" &&
    (receipt.attemptedAt !== null || receipt.remoteObjectRefHash !== null)
  ) {
    throw new ProtocolSemanticError(
      "INVALID_NOT_ATTEMPTED_RECEIPT",
      "confirmed_not_attempted 不得包含尝试时间或远端对象引用。"
    );
  }
  if (
    (receipt.outcome === "confirmed_not_published" ||
      receipt.outcome === "outcome_unknown") &&
    receipt.attemptedAt === null
  ) {
    throw new ProtocolSemanticError(
      "MISSING_ATTEMPT_TIME",
      `${receipt.outcome} 必须记录 attemptedAt。`
    );
  }
  if (
    receipt.outcome === "confirmed_not_published" &&
    receipt.remoteObjectRefHash !== null
  ) {
    throw new ProtocolSemanticError(
      "UNEXPECTED_REMOTE_OBJECT",
      "confirmed_not_published 不得包含远端对象引用。"
    );
  }
  return receipt;
}

export function assertInterventionEventSemantics(
  input: unknown
): InterventionEventV1 {
  const event = parseProtocolObject("interventionEvent", input);
  assertNotAfter(
    event.occurredAt,
    event.recordedAt,
    "EVENT_RECORDED_BEFORE_OCCURRENCE",
    "recordedAt 不得早于 occurredAt。"
  );
  return event;
}

export function validateProtocolSemantics<K extends ProtocolSchemaName>(
  schemaName: K,
  input: unknown
): ProtocolTypeMap[K] {
  switch (schemaName) {
    case "observationEnvelope":
      return assertObservationEnvelopeSemantics(input) as ProtocolTypeMap[K];
    case "decisionEvidenceRef":
      return assertDecisionEvidenceRefSemantics(input) as ProtocolTypeMap[K];
    case "interventionIntent":
      return assertInterventionIntentSemantics(input) as ProtocolTypeMap[K];
    case "executionCommand":
      return assertExecutionCommandSemantics(input) as ProtocolTypeMap[K];
    case "executionReceipt":
      return assertExecutionReceiptSemantics(input) as ProtocolTypeMap[K];
    case "interventionEvent":
      return assertInterventionEventSemantics(input) as ProtocolTypeMap[K];
    default:
      return parseProtocolObject(schemaName, input);
  }
}
