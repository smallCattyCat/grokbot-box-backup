import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_HASH_ALGORITHM,
  PROTOCOL_SCHEMA_VERSIONS,
  canonicalProtocolHash,
  parseProtocolObject
} from "../../lib/facilitation-protocol";
import {
  SEMANTIC_RENDERER_CONTRACT_VERSION,
  rebuildDeterministicSemanticDraft,
  renderSemanticDraft,
  type SemanticRendererConfiguration,
  type SemanticRendererModelRequest,
  type SemanticRenderingOpportunity
} from "../../lib/autonomy/semantic-renderer";
import { hashTransientDraftBody } from "../../lib/live-runtime/draft-content";
import { buildDeterministicFacilitationDraft } from "../../lib/live-runtime/facilitation-kernel";

const FALLBACK_BODY =
  "DETERMINISTIC_FALLBACK_CANARY：请围绕观点边界补充一个例子。";

function hash(label: string): string {
  return canonicalProtocolHash("cmooc.semantic-renderer-test.v1", {
    label
  });
}

const CONFIG: SemanticRendererConfiguration = {
  enabled: true,
  provider: "test_provider",
  model: "test-model.v1",
  maximumBodyCharacters: 500
};

function draftOpportunity(): SemanticRenderingOpportunity {
  const intent = parseProtocolObject("interventionIntent", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.interventionIntent,
    evidenceRefHash: hash("evidence-ref"),
    evidenceAsOf: "2026-07-30T04:30:00.000Z",
    intervene: true,
    facilitationFunction: "cognitive_conflict",
    targetObject: "thread_author",
    workloadCost: 1,
    candidateExpiresAt: "2026-07-30T05:00:00.000Z",
    withdrawalConditions: [
      "external_human_response",
      "candidate_expired",
      "target_version_changed"
    ],
    policyVersion: "policy.v1",
    budgetVersion: "budget.v1",
    hashAlgorithm: CANONICAL_HASH_ALGORITHM,
    containsForumText: false
  });
  const intentHash = canonicalProtocolHash(
    intent.schemaVersion,
    intent
  );
  const moveSpec = parseProtocolObject("facilitationMoveSpec", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.facilitationMoveSpec,
    intentHash,
    needState: "conceptual_tension",
    mechanismTarget: "surface_explanatory_tension",
    facilitationMove:
      "pose_counterexample_and_request_explanation",
    targetObject: "thread_author",
    requiredContentElements: [
      "boundary_question",
      "counterexample_invitation"
    ],
    prohibitedMoves: [
      "answer_on_behalf_of_learner",
      "identity_ranking",
      "stable_personality_judgment"
    ],
    observableSuccessCriteria: [
      "external_human_response",
      "reply_chain_extension"
    ],
    specVersion: "cmooc.live-move-spec.v1",
    containsForumText: false
  });
  const moveSpecHash = canonicalProtocolHash(
    moveSpec.schemaVersion,
    moveSpec
  );
  return {
    receiptHash: hash("opportunity"),
    transientDraft: FALLBACK_BODY,
    receipt: {
      decision: "draft",
      decisionMode: "DRAFT_ELIGIBLE",
      selectedFunction: "cognitive_conflict",
      observationReceiptHash: hash("observation"),
      historyCutoffHash: hash("history-cutoff"),
      historyEvidenceHash: hash("history-evidence"),
      targetVersionHash: hash("target-version"),
      eventSetHash: hash("event-set"),
      evidenceAsOf: "2026-07-30T04:30:00.000Z",
      intent,
      intentHash,
      moveSpec,
      moveSpecHash,
      draftCreated: true,
      draftContentHash: hashTransientDraftBody(FALLBACK_BODY),
      draftGeneratorVersion:
        "cmooc.deterministic-facilitation-draft.v1",
      draftBodyPersisted: false,
      containsForumText: false
    }
  };
}

function nonDraftOpportunity(
  decision: "wait" | "yield" | "abstain"
): SemanticRenderingOpportunity {
  const decisionMode = {
    wait: "WAIT_FORCED",
    yield: "YIELD_TO_HUMAN",
    abstain: "ABSTAIN"
  } as const;
  return {
    receiptHash: hash(`opportunity-${decision}`),
    transientDraft: null,
    receipt: {
      decision,
      decisionMode: decisionMode[decision],
      selectedFunction: null,
      observationReceiptHash: hash(`observation-${decision}`),
      historyCutoffHash: hash(`history-cutoff-${decision}`),
      historyEvidenceHash: null,
      targetVersionHash: hash(`target-version-${decision}`),
      eventSetHash: hash(`event-set-${decision}`),
      evidenceAsOf: "2026-07-30T04:30:00.000Z",
      intent: null,
      intentHash: null,
      moveSpec: null,
      moveSpecHash: null,
      draftCreated: false,
      draftContentHash: null,
      draftGeneratorVersion: null,
      draftBodyPersisted: false,
      containsForumText: false
    }
  };
}

test("DRAFT sends only structured protocol objects and hashes to the model", async () => {
  let captured: SemanticRendererModelRequest | null = null;
  const result = await renderSemanticDraft({
    opportunity: draftOpportunity(),
    config: CONFIG,
    generate: (request) => {
      captured = request;
      return { body: "  模型生成的促进草稿。\r\n" };
    }
  });

  assert.ok(captured);
  assert.deepEqual(Object.keys(captured).sort(), [
    "containsForumText",
    "containsIdentity",
    "containsPlatformIdentifiers",
    "contractVersion",
    "evidenceAsOf",
    "evidenceHashes",
    "intent",
    "intentHash",
    "moveSpec",
    "moveSpecHash",
    "opportunityReceiptHash",
    "outputContract",
    "schemaVersion",
    "targetVersionHash"
  ]);
  const serializedRequest = JSON.stringify(captured);
  assert.equal(serializedRequest.includes(FALLBACK_BODY), false);
  for (const forbidden of [
    "courseId",
    "platformId",
    "authorId",
    "authorName",
    "actorRef",
    "stableTargetRef",
    "forumBody",
    "rawText"
  ]) {
    assert.equal(serializedRequest.includes(forbidden), false);
  }
  assert.equal(result.transientBody, "模型生成的促进草稿。");
  assert.equal(result.receipt.resolution, "model_generated");
  assert.equal(result.receipt.modelInvoked, true);
  assert.equal(result.receipt.modelOutputAccepted, true);
  assert.equal(
    result.receipt.contractVersion,
    SEMANTIC_RENDERER_CONTRACT_VERSION
  );
  assert.equal(result.receipt.provider, CONFIG.provider);
  assert.equal(result.receipt.model, CONFIG.model);
  assert.equal(
    result.receipt.contentHash,
    hashTransientDraftBody("模型生成的促进草稿。")
  );
  assert.equal(result.receipt.bodyPersisted, false);
  assert.equal(
    JSON.stringify(result.receipt).includes(
      result.transientBody ?? "missing"
    ),
    false
  );
});

test("WAIT, YIELD, and ABSTAIN provably make zero model calls", async () => {
  let calls = 0;
  for (const decision of [
    "wait",
    "yield",
    "abstain"
  ] as const) {
    const result = await renderSemanticDraft({
      opportunity: nonDraftOpportunity(decision),
      config: CONFIG,
      generate: () => {
        calls += 1;
        return { body: "不得生成" };
      }
    });
    assert.equal(result.transientBody, null);
    assert.equal(result.receipt.decision, decision);
    assert.equal(
      result.receipt.resolution,
      "skipped_non_draft"
    );
    assert.equal(result.receipt.modelInvoked, false);
    assert.equal(result.receipt.contentHash, null);
  }
  assert.equal(calls, 0);
});

test("model unavailability, errors, and invalid output use the deterministic fallback", async (t) => {
  const cases: Array<{
    name: string;
    generate?: () => unknown | Promise<unknown>;
    reason:
      | "generator_unavailable"
      | "generator_error"
      | "invalid_model_output";
  }> = [
    {
      name: "unavailable",
      reason: "generator_unavailable"
    },
    {
      name: "error",
      generate: () => {
        throw new Error("provider detail must not enter receipt");
      },
      reason: "generator_error"
    },
    {
      name: "non-object",
      generate: () => "not an object",
      reason: "invalid_model_output"
    },
    {
      name: "empty body",
      generate: () => ({ body: " \r\n " }),
      reason: "invalid_model_output"
    },
    {
      name: "overlength body",
      generate: () => ({ body: "x".repeat(501) }),
      reason: "invalid_model_output"
    },
    {
      name: "extra property",
      generate: () => ({ body: "text", extra: true }),
      reason: "invalid_model_output"
    }
  ];

  for (const current of cases) {
    await t.test(current.name, async () => {
      const result = await renderSemanticDraft({
        opportunity: draftOpportunity(),
        config: CONFIG,
        generate: current.generate
      });
      assert.equal(result.transientBody, FALLBACK_BODY);
      assert.equal(
        result.receipt.resolution,
        "deterministic_fallback"
      );
      assert.equal(
        result.receipt.fallbackReason,
        current.reason
      );
      assert.equal(
        result.receipt.contentHash,
        hashTransientDraftBody(FALLBACK_BODY)
      );
      assert.equal(
        JSON.stringify(result.receipt).includes(FALLBACK_BODY),
        false
      );
    });
  }
});

test("model output cannot change the decision, facilitation function, or target", async () => {
  const result = await renderSemanticDraft({
    opportunity: draftOpportunity(),
    config: CONFIG,
    generate: () => ({
      body: "试图越权的模型输出",
      decision: "wait",
      facilitationFunction: "emotional_support",
      targetObject: "comment"
    })
  });

  assert.equal(
    result.receipt.resolution,
    "deterministic_fallback"
  );
  assert.equal(
    result.receipt.fallbackReason,
    "invalid_model_output"
  );
  assert.equal(result.receipt.decision, "draft");
  assert.equal(
    result.receipt.selectedFunction,
    "cognitive_conflict"
  );
  assert.equal(result.receipt.targetObject, "thread_author");
  assert.equal(result.transientBody, FALLBACK_BODY);
});

test("tampered Intent binding fails before any model invocation", async () => {
  let calls = 0;
  const original = draftOpportunity();
  const tampered: SemanticRenderingOpportunity = {
    ...original,
    receipt: {
      ...original.receipt,
      intentHash: "a".repeat(64)
    }
  };

  await assert.rejects(
    renderSemanticDraft({
      opportunity: tampered,
      config: CONFIG,
      generate: () => {
        calls += 1;
        return { body: "should not run" };
      }
    }),
    /Intent 或 MoveSpec 哈希/
  );
  assert.equal(calls, 0);
});

test("persisted Intent and MoveSpec can rebuild the deterministic draft without storing its body", () => {
  const opportunity = draftOpportunity();
  const { intent, intentHash, moveSpec, moveSpecHash } =
    opportunity.receipt;
  assert.ok(intent);
  assert.ok(intentHash);
  assert.ok(moveSpec);
  assert.ok(moveSpecHash);

  const expectedBody = buildDeterministicFacilitationDraft(
    "cognitive_conflict"
  );
  const rebuilt = rebuildDeterministicSemanticDraft({
    intent,
    moveSpec,
    intentHash,
    moveSpecHash,
    expectedContentHash: hashTransientDraftBody(expectedBody)
  });

  assert.equal(rebuilt, expectedBody);
  assert.throws(
    () =>
      rebuildDeterministicSemanticDraft({
        intent,
        moveSpec,
        intentHash,
        moveSpecHash,
        expectedContentHash: "f".repeat(64)
      }),
    /内容哈希/
  );
});
