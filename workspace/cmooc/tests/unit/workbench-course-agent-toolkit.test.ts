import assert from "node:assert/strict";
import test from "node:test";
import {
  createCourseAgentToolkit,
  createUnavailablePlatformStageAdapter
} from "../../lib/workbench/course-agent-toolkit";

test("composite course agent toolkit exposes the full bounded first-slice surface", () => {
  const toolkit = createCourseAgentToolkit({
    taskId: "task-toolkit-fixture-1",
    runId: "run-toolkit-fixture-1",
    courseAlias: "course-fixture"
  });
  const tools = toolkit.registry.manifest().tools;

  assert.equal(tools.length, 16);
  assert.deepEqual(
    tools.map((tool) => `${tool.name}@${tool.version}`),
    [
      "artifact.reply_draft.create@1",
      "artifact.reply_draft.regenerate@1",
      "course.context.resolve@1",
      "course.schedule.read@1",
      "course.snapshot.read@1",
      "delivery.bundle.create@1",
      "evidence.read_opportunity@1",
      "evidence.verify_integrity@1",
      "facilitation.intent.compose@1",
      "opportunity.list@1",
      "opportunity.select_support_gap@1",
      "platform.editor.reconcile_stage@1",
      "platform.editor.stage_verify_clear@1",
      "platform.target.preflight_read@1",
      "research.evidence_package.prepare@1",
      "schedule.review_bundle.create@1"
    ]
  );
  assert.equal(
    tools.some((tool) =>
      /(?:publish|submit|send|commit)/u.test(tool.name) ||
      tool.effect === "irreversible_external" ||
      tool.capability === "L4_IRREVERSIBLE"
    ),
    false
  );
  assert.deepEqual(
    toolkit.verifierRegistry.manifest().verifiers.map(
      (verifier) => `${verifier.name}@${verifier.version}`
    ),
    [
      "verification.course_schedule_read@1",
      "verification.facilitation_delivery_bundle@1",
      "verification.facilitation_intent@1",
      "verification.facilitation_reply_draft@1",
      "verification.opportunity_integrity@1",
      "verification.platform_stage_atomic@1",
      "verification.research_evidence_package@1",
      "verification.schedule_review_bundle@1"
    ]
  );
  assert.equal(typeof toolkit.onToolOutcome, "function");
  assert.equal(typeof toolkit.protectedStore.getByRef, "function");

  const recovery = tools.find(
    (tool) => tool.name === "artifact.reply_draft.regenerate"
  );
  assert.ok(recovery);
  assert.equal(recovery.capability, "L1_ARTIFACT");
  assert.equal(recovery.effect, "local_write");
  assert.deepEqual(recovery.idempotency, {
    strategy: "input_hash",
    scope: "run"
  });
  assert.deepEqual(recovery.modelInputSchema, {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {}
  });
  assert.equal(recovery.evidenceRequired, true);
  assert.equal(recovery.verificationRequired, true);
  assert.deepEqual(recovery.verifierRefs, [
    {
      name: "verification.facilitation_reply_draft",
      version: "1",
      required: true
    }
  ]);
});

test("research and schedule tools keep exact evidence, verification, and effect contracts", () => {
  const toolkit = createCourseAgentToolkit({
    taskId: "task-toolkit-fixture-2",
    runId: "run-toolkit-fixture-2",
    courseAlias: "course-fixture"
  });
  const tools = toolkit.registry.manifest().tools;
  const expected = [
    {
      name: "course.schedule.read",
      capability: "L0_READ",
      effect: "read",
      idempotencyScope: "step",
      verifier: "verification.course_schedule_read"
    },
    {
      name: "research.evidence_package.prepare",
      capability: "L1_ARTIFACT",
      effect: "local_write",
      idempotencyScope: "task",
      verifier: "verification.research_evidence_package"
    },
    {
      name: "schedule.review_bundle.create",
      capability: "L1_ARTIFACT",
      effect: "local_write",
      idempotencyScope: "task",
      verifier: "verification.schedule_review_bundle"
    }
  ] as const;

  for (const contract of expected) {
    const tool = tools.find((candidate) => candidate.name === contract.name);
    assert.ok(tool, contract.name);
    assert.equal(tool.capability, contract.capability);
    assert.equal(tool.effect, contract.effect);
    assert.deepEqual(tool.dataClasses, [
      "safe_aggregate",
      "opaque_evidence_ref"
    ]);
    assert.deepEqual(tool.idempotency, {
      strategy: "input_hash",
      scope: contract.idempotencyScope
    });
    assert.equal(tool.evidenceRequired, true);
    assert.equal(tool.verificationRequired, true);
    assert.deepEqual(tool.verifierRefs, [
      { name: contract.verifier, version: "1", required: true }
    ]);
    const modelInputSchema = tool.modelInputSchema;
    assert.ok(modelInputSchema);
    assert.equal(modelInputSchema.additionalProperties, false);
    assert.deepEqual(modelInputSchema.required, ["contextRef"]);
    assert.equal(
      JSON.stringify(modelInputSchema).includes("prompt"),
      false
    );
  }
});

test("default platform adapter reports unavailable and cannot perform STAGE", async () => {
  const adapter = createUnavailablePlatformStageAdapter();
  const context = {
    now: "2026-08-13T12:00:00.000Z",
    courseScope: {
      alias: "course-fixture",
      manifestHash: "a".repeat(64)
    }
  } as never;
  const envelope = {} as never;

  const preflight = await adapter.preflightRead({
    targetRef: "target-safe-fixture",
    context,
    envelope
  });
  assert.equal(preflight.status, "waiting_for_browser");
  assert.equal(preflight.reasonCode, "browser_unavailable");
  assert.equal(preflight.containsForumText, false);
  assert.equal(preflight.containsIdentity, false);
  assert.equal(preflight.containsSecrets, false);

  const stage = await adapter.stageVerifyClear({
    targetRef: "target-safe-fixture",
    artifactVersionRef: "artifact-version-safe-fixture",
    draftBodyHash: "b".repeat(64),
    preflightRef: preflight.preflightRef,
    context,
    envelope
  });
  assert.equal(stage.status, "failed_before_write");
  assert.equal(stage.reasonCode, "grant_binding_invalid");

  const reconciliation = await adapter.reconcileStage({
    stageTransactionRef: "stage-transaction-safe-fixture",
    context,
    envelope
  });
  assert.equal(reconciliation.status, "blocked");
  assert.equal(reconciliation.reasonCode, "transaction_not_found");
});
