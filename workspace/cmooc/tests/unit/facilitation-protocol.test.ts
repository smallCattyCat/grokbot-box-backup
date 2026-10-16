import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_HASH_ALGORITHM,
  PROTOCOL_SCHEMA_VERSIONS,
  ProtocolSemanticError,
  ProtocolValidationError,
  assertDecisionEvidenceRefSemantics,
  assertExecutionReceiptSemantics,
  assertInterventionIntentSemantics,
  assertMoveSpecMatchesIntent,
  assertObservationEnvelopeSemantics,
  canonicalJson,
  canonicalProtocolHash,
  parseProtocolObject,
  validateAndHashProtocolObject,
  type ProtocolSchemaName
} from "../../lib/facilitation-protocol";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const STABLE_A = "a".repeat(24);
const STABLE_B = "b".repeat(24);
const STABLE_C = "c".repeat(24);
const STABLE_D = "d".repeat(24);

function validIntent() {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.interventionIntent,
    evidenceRefHash: HASH_A,
    evidenceAsOf: "2024-10-19T19:49:17",
    intervene: true,
    facilitationFunction: "resource_connection",
    targetObject: "thread_author",
    workloadCost: 1,
    candidateExpiresAt: "2024-10-19T20:19:17",
    withdrawalConditions: [
      "external_human_response",
      "candidate_expired"
    ],
    policyVersion: "policy.v1",
    budgetVersion: "budget.v1",
    hashAlgorithm: CANONICAL_HASH_ALGORITHM,
    containsForumText: false
  } as const;
}

function validMoveSpec(intentHash: string) {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.facilitationMoveSpec,
    intentHash,
    needState: "connection_gap",
    mechanismTarget: "reduce_connection_cost",
    facilitationMove: "connect_resource_and_invite_application",
    targetObject: "thread_author",
    requiredContentElements: ["resource_reference", "application_invitation"],
    prohibitedMoves: [
      "answer_on_behalf_of_learner",
      "identity_ranking"
    ],
    observableSuccessCriteria: [
      "external_human_response",
      "resource_application_attempt"
    ],
    specVersion: "move.v1",
    containsForumText: false
  } as const;
}

function protocolExamples(): Record<ProtocolSchemaName, unknown> {
  const intent = validIntent();
  const intentHash = canonicalProtocolHash(
    intent.schemaVersion,
    intent
  );
  return {
    observationEnvelope: {
      schemaVersion: PROTOCOL_SCHEMA_VERSIONS.observationEnvelope,
      observationKey: "observation:001",
      adapterId: "adapter.cmooc",
      adapterVersion: "adapter.v1",
      threadKey: "thread:001",
      courseKey: "course:001",
      observedAt: "2024-10-19T20:00:00",
      evidenceAsOf: "2024-10-19T19:49:17",
      sourceObservedThrough: "2024-10-19T19:55:00",
      timeBasis: "naive_platform_local_time_no_dst_adjustment",
      temporalEvidenceStatus: "as_of_verified",
      contentRevisionStatus: "final_export_revision_unknown",
      stateHash: HASH_A,
      eventCount: 4,
      containsForumText: false
    },
    decisionEvidenceRef: {
      schemaVersion: PROTOCOL_SCHEMA_VERSIONS.decisionEvidenceRef,
      snapshotKey: STABLE_A,
      threadKey: STABLE_B,
      courseKey: STABLE_C,
      authorKey: STABLE_D,
      year: 2024,
      split: "development",
      decisionAt: "2024-10-19T19:49:17",
      snapshotSchemaVersion: "cmooc-decision-snapshot-v1",
      temporalContractVersion:
        "cmooc-decision-snapshot-temporal-contract-v2",
      temporalContractHash: HASH_A,
      featureHash: HASH_B,
      timeBasis: "naive_platform_local_time_no_dst_adjustment",
      temporalEvidenceStatus: "as_of_verified",
      contentRevisionStatus: "not_included",
      containsForumText: false
    },
    interventionIntent: intent,
    facilitationMoveSpec: validMoveSpec(intentHash),
    boundTarget: {
      schemaVersion: PROTOCOL_SCHEMA_VERSIONS.boundTarget,
      adapterId: "adapter.cmooc",
      adapterVersion: "adapter.v1",
      threadKey: "thread:001",
      targetType: "thread",
      targetObject: "thread_author",
      stableTargetRef: "target:001",
      targetVersionHash: HASH_A,
      contentRevisionStatus: "decision_time_version_verified",
      boundAt: "2024-10-19T20:01:00",
      containsForumText: false
    },
    reviewBundle: {
      schemaVersion: PROTOCOL_SCHEMA_VERSIONS.reviewBundle,
      taskRefHash: HASH_A,
      evidenceRefHash: HASH_B,
      intentHash: HASH_A,
      moveSpecHash: HASH_B,
      draftContentHash: HASH_A,
      targetHash: HASH_B,
      safetyResultHash: HASH_A,
      policyVersion: "review.v1",
      assembledAt: "2024-10-19T20:02:00",
      containsForumText: false
    },
    capabilityRequest: {
      schemaVersion: PROTOCOL_SCHEMA_VERSIONS.capabilityRequest,
      principalType: "agent_client",
      principalRef: "agent:local",
      capability: "intervention.preview",
      objectRefHash: HASH_A,
      correlationId: "correlation:001",
      requestedAt: "2024-10-19T20:03:00",
      containsForumText: false
    },
    executionCommand: {
      schemaVersion: PROTOCOL_SCHEMA_VERSIONS.executionCommand,
      commandId: "command:001",
      correlationId: "correlation:001",
      capability: "forum.execute_authorized",
      taskRefHash: HASH_A,
      reviewBundleHash: HASH_B,
      authorizationRefHash: HASH_A,
      idempotencyKey: HASH_B,
      budgetReservationRefHash: HASH_A,
      expectedTargetHash: HASH_B,
      contentHash: HASH_A,
      gatewayPolicyVersion: "gateway.v1",
      issuedAt: "2024-10-19T20:04:00",
      expiresAt: "2024-10-19T20:09:00",
      containsForumText: false
    },
    executionReceipt: {
      schemaVersion: PROTOCOL_SCHEMA_VERSIONS.executionReceipt,
      commandId: "command:001",
      correlationId: "correlation:001",
      adapterId: "adapter.cmooc",
      adapterVersion: "adapter.v1",
      outcome: "confirmed_not_attempted",
      attemptedAt: null,
      recordedAt: "2024-10-19T20:05:00",
      remoteObjectRefHash: null,
      evidenceHash: HASH_A,
      messageCode: "policy_denied",
      containsForumText: false
    },
    interventionEvent: {
      schemaVersion: PROTOCOL_SCHEMA_VERSIONS.interventionEvent,
      eventId: "event:001",
      aggregateType: "intent",
      aggregateRefHash: HASH_A,
      eventType: "intent_created",
      occurredAt: "2024-10-19T20:00:00",
      recordedAt: "2024-10-19T20:00:01",
      correlationId: "correlation:001",
      causationId: null,
      evidenceStatus: "observed",
      payloadHash: HASH_B,
      containsForumText: false
    }
  };
}

test("十类 P4A v1 协议对象均通过严格运行时校验", () => {
  for (const [schemaName, value] of Object.entries(
    protocolExamples()
  ) as Array<[ProtocolSchemaName, unknown]>) {
    const parsed = parseProtocolObject(schemaName, value);
    assert.equal(parsed.containsForumText, false);
    assert.equal(typeof parsed.schemaVersion, "string");
  }
});

test("所有协议对象对未知字段和论坛正文标志 fail closed", () => {
  for (const [schemaName, value] of Object.entries(
    protocolExamples()
  ) as Array<[ProtocolSchemaName, Record<string, unknown>]>) {
    assert.throws(
      () =>
        parseProtocolObject(schemaName, {
          ...value,
          unexpectedField: "must-fail"
        }),
      ProtocolValidationError
    );
    assert.throws(
      () =>
        parseProtocolObject(schemaName, {
          ...value,
          containsForumText: true
        }),
      ProtocolValidationError
    );
  }
});

test("规范 JSON 与协议哈希不受对象键顺序影响", () => {
  const original = {
    schemaVersion: "test.schema.v1",
    z: 2,
    nested: { beta: true, alpha: ["x", 1] },
    a: null
  };
  const reordered = {
    a: null,
    nested: { alpha: ["x", 1], beta: true },
    z: 2,
    schemaVersion: "test.schema.v1"
  };
  assert.equal(canonicalJson(original), canonicalJson(reordered));
  assert.equal(
    canonicalProtocolHash(original.schemaVersion, original),
    canonicalProtocolHash(reordered.schemaVersion, reordered)
  );
  assert.throws(
    () => canonicalJson({ invalidMeasurement: 0.25 }),
    /安全整数/
  );
  assert.throws(
    () => canonicalProtocolHash("other.schema.v1", original),
    /schemaVersion/
  );
});

test("证据时钟和候选 TTL 语义违反时会 fail closed", () => {
  const observation = protocolExamples()
    .observationEnvelope as Record<string, unknown>;
  assert.throws(
    () =>
      assertObservationEnvelopeSemantics({
        ...observation,
        evidenceAsOf: "2024-10-19T20:01:00"
      }),
    (error: unknown) =>
      error instanceof ProtocolSemanticError &&
      error.code === "EVIDENCE_AFTER_OBSERVATION"
  );
  assert.throws(
    () =>
      assertInterventionIntentSemantics({
        ...validIntent(),
        candidateExpiresAt: "2024-10-19T19:49:17"
      }),
    (error: unknown) =>
      error instanceof ProtocolSemanticError &&
      error.code === "NON_POSITIVE_INTENT_TTL"
  );
  const evidenceRef = protocolExamples()
    .decisionEvidenceRef as Record<string, unknown>;
  assert.throws(
    () =>
      assertDecisionEvidenceRefSemantics({
        ...evidenceRef,
        split: "time_holdout"
      }),
    (error: unknown) =>
      error instanceof ProtocolSemanticError &&
      error.code === "EVIDENCE_SPLIT_MISMATCH"
  );
});

test("促进动作必须保持意图哈希、目标和教育语义映射", () => {
  const intent = validIntent();
  const { hash } = validateAndHashProtocolObject(
    "interventionIntent",
    intent
  );
  const valid = assertMoveSpecMatchesIntent(
    intent,
    validMoveSpec(hash)
  );
  assert.equal(valid.moveSpec.needState, "connection_gap");

  assert.throws(
    () =>
      assertMoveSpecMatchesIntent(intent, {
        ...validMoveSpec(hash),
        mechanismTarget: "surface_explanatory_tension"
      }),
    (error: unknown) =>
      error instanceof ProtocolSemanticError &&
      error.code === "FACILITATION_FUNCTION_MISMATCH"
  );
});

test("执行回执区分已核验发布、确认未尝试和结果不明", () => {
  const base = protocolExamples()
    .executionReceipt as Record<string, unknown>;
  assert.doesNotThrow(() => assertExecutionReceiptSemantics(base));
  assert.throws(
    () =>
      assertExecutionReceiptSemantics({
        ...base,
        outcome: "verified_published",
        attemptedAt: "2024-10-19T20:04:30",
        remoteObjectRefHash: null
      }),
    (error: unknown) =>
      error instanceof ProtocolSemanticError &&
      error.code === "UNVERIFIED_PUBLISHED_RECEIPT"
  );
  assert.doesNotThrow(() =>
    assertExecutionReceiptSemantics({
      ...base,
      outcome: "outcome_unknown",
      attemptedAt: "2024-10-19T20:04:30"
    })
  );
});
