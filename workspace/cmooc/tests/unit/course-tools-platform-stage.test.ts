import assert from "node:assert/strict";
import test from "node:test";
import {
  COURSE_TOOL_GRANT_SCHEMA_VERSION,
  CourseToolContractError,
  type CourseToolJsonValue,
  type CourseToolExecutionOutcome,
  type EvidenceRef,
  type ServerToolExecutionContext
} from "../../lib/course-tools/contracts";
import { CourseToolExecutor } from "../../lib/course-tools/executor";
import {
  CourseToolPolicyError,
  CourseToolPolicyGateway,
  type ScopedCourseToolGrantAuthority
} from "../../lib/course-tools/policy-gateway";
import { CourseToolRegistry } from "../../lib/course-tools/registry";
import {
  PLATFORM_PREFLIGHT_OUTPUT_SCHEMA_VERSION,
  PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
  PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION,
  createPlatformStageToolRegistrations,
  createPlatformStageVerifierRegistrations,
  type PlatformStageReconciledOutput,
  type PlatformStageToolDependencies,
  type PlatformStageVerifiedOutput,
  type PlatformTargetPreflightOutput,
  type TrustedPlatformReconcileOutcome,
  type TrustedPlatformStageOutcome
} from "../../lib/course-tools/tools/platform-stage";
import { CourseToolVerifierRegistry } from "../../lib/course-tools/verifier-registry";
import {
  CapturingCourseToolSink,
  FIXTURE_NOW,
  jsonContains,
  serverContext,
  sha
} from "./course-tool-test-fixtures";

const TARGET_REF = "target:support-gap-001";
const ARTIFACT_VERSION_REF = "artifact-version:reply-001:v1";
const PREFLIGHT_REF = "preflight:target-001";
const STAGE_TRANSACTION_REF = "stage-transaction:001";
const DRAFT_BODY_HASH = sha("transient draft body");
const TARGET_VERSION_HASH = sha("target-version");
const BASELINE_HASH = sha("");
const PAGE_BINDING_HASH = sha("page-binding");

function ref(
  kind: EvidenceRef["kind"],
  id: string,
  hash = sha(`${kind}:${id}`)
): EvidenceRef & Readonly<Record<string, CourseToolJsonValue>> {
  return { kind, id, hash, observedAt: FIXTURE_NOW };
}

const ARTIFACT_REF = ref(
  "artifact",
  ARTIFACT_VERSION_REF,
  sha("artifact-version")
);
const STAGE_RECEIPT_REF = ref(
  "stage_receipt",
  "stage-receipt:001",
  sha("stage-receipt")
);
const TARGET_EVIDENCE = ref("decision", "decision:001");
const COMPLETE_TARGET_EVIDENCE = Object.freeze([
  ref("manifest", "manifest:001"),
  ref("invocation", "invocation:001"),
  ref("snapshot", "snapshot:001"),
  ref("world", "world:001"),
  ref("coverage", "coverage:001"),
  ref("content_graph", "content-graph:001"),
  ref("candidate", "candidate:001"),
  ref("decision", "decision:001")
]);

function preflightOutput(
  overrides: Partial<PlatformTargetPreflightOutput> = {}
): PlatformTargetPreflightOutput {
  return {
    schemaVersion: PLATFORM_PREFLIGHT_OUTPUT_SCHEMA_VERSION,
    status: "ready",
    reasonCode: null,
    preflightRef: PREFLIGHT_REF,
    preflightHash: sha("preflight"),
    targetRef: TARGET_REF,
    targetVersionHash: TARGET_VERSION_HASH,
    baselineRef: "editor-baseline:001",
    baselineHash: BASELINE_HASH,
    pageBindingRef: "page-binding:001",
    pageBindingHash: PAGE_BINDING_HASH,
    baselineStatus: "empty",
    observedAt: FIXTURE_NOW,
    evidenceRefs: [TARGET_EVIDENCE],
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false,
    ...overrides
  };
}

function verifiedStageOutput(
  overrides: Partial<PlatformStageVerifiedOutput> = {}
): PlatformStageVerifiedOutput {
  return {
    schemaVersion: PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION,
    status: "verified_cleared",
    stageTransactionRef: STAGE_TRANSACTION_REF,
    receiptRef: STAGE_RECEIPT_REF.id,
    receiptHash: STAGE_RECEIPT_REF.hash,
    targetRef: TARGET_REF,
    targetVersionHash: TARGET_VERSION_HASH,
    artifactVersionRef: ARTIFACT_VERSION_REF,
    draftBodyHash: DRAFT_BODY_HASH,
    pageBindingRef: "page-binding:001",
    pageBindingHash: PAGE_BINDING_HASH,
    baselineRef: "editor-baseline:001",
    baselineHash: BASELINE_HASH,
    editorWriteCount: 1,
    editorReadbackCount: 1,
    editorReadbackVerified: true,
    editorClearCount: 1,
    editorEmptyAfterClear: true,
    submitMutationCount: 0,
    sendMutationCount: 0,
    closeAuditStatus: "passed",
    realPublishEnabled: false,
    bodyPersisted: false,
    published: false,
    observedAt: FIXTURE_NOW,
    evidenceRefs: [ARTIFACT_REF, STAGE_RECEIPT_REF],
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false,
    ...overrides
  };
}

function reconciledStageOutput(
  overrides: Partial<PlatformStageReconciledOutput> = {}
): PlatformStageReconciledOutput {
  const verified = verifiedStageOutput();
  return {
    ...verified,
    schemaVersion: PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
    status: "reconciled_cleared",
    resolution: "owned_draft_cleared",
    ...overrides
  };
}

class OneShotGrantAuthority implements ScopedCourseToolGrantAuthority {
  readonly claims: string[] = [];
  readonly #consumed = new Set<string>();

  async claim(input: Parameters<ScopedCourseToolGrantAuthority["claim"]>[0]) {
    this.claims.push(input.grantRef);
    if (this.#consumed.has(input.grantRef)) {
      return { status: "consumed" as const };
    }
    this.#consumed.add(input.grantRef);
    return {
      status: "claimed" as const,
      grant: {
        schemaVersion: COURSE_TOOL_GRANT_SCHEMA_VERSION,
        grantRef: input.grantRef,
        issuer: "course_tool_server" as const,
        ...input.binding,
        validFrom: new Date(Date.parse(input.now) - 1_000).toISOString(),
        expiresAt: new Date(Date.parse(input.now) + 60_000).toISOString(),
        oneShot: true as const,
        realPublishEnabled: false
      }
    };
  }
}

function adapter(input: {
  stage?: TrustedPlatformStageOutcome;
  reconcile?: TrustedPlatformReconcileOutcome;
} = {}): PlatformStageToolDependencies["trustedDriver"] & {
  readonly calls: { preflight: number; stage: number; reconcile: number };
} {
  const calls = { preflight: 0, stage: 0, reconcile: 0 };
  return {
    calls,
    preflightRead: async ({ targetRef, context, envelope }) => {
      calls.preflight += 1;
      assert.equal(targetRef, TARGET_REF);
      assert.equal(envelope.courseScope.courseId, context.courseScope.courseId);
      assert.equal(envelope.taskId, context.taskId);
      return preflightOutput();
    },
    stageVerifyClear: async ({ context, envelope, ...business }) => {
      calls.stage += 1;
      assert.deepEqual(business, {
        targetRef: TARGET_REF,
        artifactVersionRef: ARTIFACT_VERSION_REF,
        draftBodyHash: DRAFT_BODY_HASH,
        preflightRef: PREFLIGHT_REF
      });
      assert.equal(envelope.grantedCapability, "L3_EXTERNAL_STAGE");
      assert.equal(envelope.grantRef, context.capabilityGrantRefs[0]);
      return input.stage ?? verifiedStageOutput();
    },
    reconcileStage: async ({ stageTransactionRef, envelope }) => {
      calls.reconcile += 1;
      assert.equal(stageTransactionRef, STAGE_TRANSACTION_REF);
      assert.equal(envelope.grantedCapability, "L3_EXTERNAL_STAGE");
      return input.reconcile ?? reconciledStageOutput();
    }
  };
}

function executorFixture(driver: PlatformStageToolDependencies["trustedDriver"]) {
  const [preflight, stage, reconcile] =
    createPlatformStageToolRegistrations({ trustedDriver: driver });
  const registry = new CourseToolRegistry()
    .register(preflight)
    .register(stage)
    .register(reconcile)
    .seal();
  let verificationId = 0;
  const verifiers = new CourseToolVerifierRegistry({
    idFactory: () => `platform-verification-${++verificationId}`
  });
  for (const verifier of createPlatformStageVerifierRegistrations()) {
    verifiers.register(verifier);
  }
  verifiers.seal();
  const grants = new OneShotGrantAuthority();
  const sink = new CapturingCourseToolSink();
  const executor = new CourseToolExecutor({
    registry,
    policyGateway: new CourseToolPolicyGateway({ grantAuthority: grants }),
    verifierRegistry: verifiers,
    sink,
    receiptIdFactory: (() => {
      let id = 0;
      return () => `platform-receipt-${++id}`;
    })()
  });
  return { executor, grants, registry, sink };
}

function stageContext(
  grantRef: string,
  overrides: Partial<ServerToolExecutionContext> = {}
) {
  return serverContext({
    callId: `call:${grantRef}`,
    stepId: `step:${grantRef}`,
    capabilityGrantRefs: [grantRef],
    baseCapability: "L1_ARTIFACT",
    ...overrides
  });
}

async function executeStage(
  executor: CourseToolExecutor,
  context = stageContext("grant-stage-001")
): Promise<CourseToolExecutionOutcome> {
  return executor.execute(
    {
      toolName: "platform.editor.stage_verify_clear",
      input: {
        targetRef: TARGET_REF,
        artifactVersionRef: ARTIFACT_VERSION_REF,
        draftBodyHash: DRAFT_BODY_HASH,
        preflightRef: PREFLIGHT_REF
      }
    },
    context
  );
}

test("registers only closed business-parameter schemas and exposes no publish surface", () => {
  const driver = adapter();
  const { registry } = executorFixture(driver);
  const manifest = registry.manifest();
  assert.deepEqual(
    manifest.tools.map((tool) => tool.name),
    [
      "platform.editor.reconcile_stage",
      "platform.editor.stage_verify_clear",
      "platform.target.preflight_read"
    ]
  );
  assert.equal(
    manifest.tools.some(
      (tool) =>
        tool.effect === "irreversible_external" ||
        /(?:publish|submit|send|commit)/i.test(tool.name)
    ),
    false
  );
  for (const tool of manifest.tools) {
    assert.equal(tool.modelInputSchema?.additionalProperties, false);
    const schemaText = JSON.stringify(tool.modelInputSchema);
    for (const forbidden of [
      "courseId",
      "courseAlias",
      "runId",
      "taskId",
      "grantRef",
      "capabilityGrantRefs",
      "leaseGeneration",
      "fencingToken",
      "stageToken",
      "nonce"
    ]) {
      assert.equal(schemaText.includes(forbidden), false, forbidden);
    }
  }

  const stage = registry.resolve("platform.editor.stage_verify_clear", "1");
  assert.throws(
    () =>
      stage.definition.inputSchema.parse({
        targetRef: TARGET_REF,
        artifactVersionRef: ARTIFACT_VERSION_REF,
        draftBodyHash: DRAFT_BODY_HASH,
        preflightRef: PREFLIGHT_REF,
        courseId: "forged-course"
      }),
    (error: unknown) =>
      error instanceof CourseToolContractError &&
      error.code === "COURSE_TOOL_SCHEMA_VALIDATION_FAILED"
  );
});

test("preflight reads exact server scope and returns only safe refs, hashes, and status", async () => {
  const driver = adapter();
  const { executor, sink } = executorFixture(driver);
  const outcome = await executor.execute(
    {
      toolName: "platform.target.preflight_read",
      input: { targetRef: TARGET_REF }
    },
    serverContext({ intent: "inspect", baseCapability: "L0_READ" })
  );

  assert.equal(outcome.result.status, "succeeded");
  assert.equal(driver.calls.preflight, 1);
  assert.deepEqual(outcome.result.safeModelProjection, {
    status: "ready",
    reasonCode: null,
    preflightRef: PREFLIGHT_REF,
    preflightHash: sha("preflight"),
    targetRef: TARGET_REF,
    targetVersionHash: TARGET_VERSION_HASH,
    baselineRef: "editor-baseline:001",
    baselineHash: BASELINE_HASH,
    pageBindingRef: "page-binding:001",
    pageBindingHash: PAGE_BINDING_HASH,
    baselineStatus: "empty"
  });
  assert.equal(sink.receipts[0]?.projection.containsForumText, false);
  assert.equal(jsonContains(outcome, "course-platform-fixture"), false);
});

test("atomic trusted STAGE verifies one write/readback/clear and projects zero publication", async () => {
  const driver = adapter();
  const { executor, grants, sink } = executorFixture(driver);
  const outcome = await executeStage(executor);

  assert.equal(outcome.result.status, "succeeded");
  assert.equal(driver.calls.stage, 1);
  assert.equal(grants.claims.length, 1);
  assert.equal(outcome.verification?.status, "passed");
  assert.deepEqual(outcome.result.safeModelProjection, {
    status: "verified_cleared",
    stageTransactionRef: STAGE_TRANSACTION_REF,
    receiptRef: STAGE_RECEIPT_REF.id,
    receiptHash: STAGE_RECEIPT_REF.hash,
    targetRef: TARGET_REF,
    targetVersionHash: TARGET_VERSION_HASH,
    artifactVersionRef: ARTIFACT_VERSION_REF,
    draftBodyHash: DRAFT_BODY_HASH,
    pageBindingRef: "page-binding:001",
    pageBindingHash: PAGE_BINDING_HASH,
    baselineRef: "editor-baseline:001",
    baselineHash: BASELINE_HASH,
    editorStatus: "cleared",
    publicationStatus: "not_published",
    closeAuditStatus: "passed",
    counts: {
      editorWrite: 1,
      editorReadback: 1,
      editorClear: 1,
      submitMutation: 0,
      sendMutation: 0
    }
  });
  assert.deepEqual(sink.order, ["call", "verification", "receipt"]);
  assert.equal(sink.receipts[0]?.projection.status, "succeeded");
  assert.equal(sink.receipts[0]?.projection.safeOutputSummary.includes("not published"), true);

  const serialized = JSON.stringify({
    outcome,
    durable: sink.receipts.map(({ projection }) => projection)
  });
  for (const forbidden of [
    "forum body secret",
    "Bearer ",
    "Cookie",
    "auth-state",
    "course-platform-fixture",
    "fencing-token-fixture"
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("STAGE and reconcile retain the complete qualified target evidence chain", async () => {
  const completeEvidence = [
    ...COMPLETE_TARGET_EVIDENCE,
    ARTIFACT_REF,
    STAGE_RECEIPT_REF
  ];
  const driver = adapter({
    stage: verifiedStageOutput({ evidenceRefs: completeEvidence }),
    reconcile: reconciledStageOutput({ evidenceRefs: completeEvidence })
  });
  const { executor } = executorFixture(driver);

  const stage = await executeStage(
    executor,
    stageContext("grant-stage-complete-evidence")
  );
  assert.equal(stage.result.status, "succeeded");
  assert.deepEqual(
    stage.result.evidenceRefs.map((evidenceRef) => evidenceRef.kind),
    completeEvidence.map((evidenceRef) => evidenceRef.kind)
  );

  const reconcile = await executor.execute(
    {
      toolName: "platform.editor.reconcile_stage",
      input: { stageTransactionRef: STAGE_TRANSACTION_REF }
    },
    stageContext("grant-reconcile-complete-evidence")
  );
  assert.equal(reconcile.result.status, "succeeded");
  assert.deepEqual(
    reconcile.result.evidenceRefs.map((evidenceRef) => evidenceRef.kind),
    completeEvidence.map((evidenceRef) => evidenceRef.kind)
  );
});

test("ambiguous STAGE is unknown, requires reconcile, and never blind-retries the write", async () => {
  const driver = adapter({
    stage: {
      status: "unknown",
      reasonCode: "network_ambiguous",
      stageTransactionRef: STAGE_TRANSACTION_REF,
      evidenceRefs: [ARTIFACT_REF],
      observedAt: FIXTURE_NOW
    }
  });
  const { executor, sink } = executorFixture(driver);
  const context = stageContext("grant-stage-unknown");
  const outcome = await executeStage(executor, context);

  assert.equal(outcome.result.status, "unknown");
  assert.deepEqual(outcome.result.safeModelProjection, {
    status: "unknown",
    code: "platform_stage_reconcile_required"
  });
  assert.equal(driver.calls.stage, 1);
  assert.equal(sink.receipts[0]?.projection.status, "unknown");
  assert.equal(outcome.result.compensationRef, STAGE_TRANSACTION_REF);
  assert.equal(
    outcome.durableProjection.compensationRef,
    STAGE_TRANSACTION_REF
  );
  assert.equal(
    sink.receipts[0]?.projection.compensationRef,
    STAGE_TRANSACTION_REF
  );
  assert.equal(
    Object.hasOwn(outcome.result.safeModelProjection as object, "compensationRef"),
    false,
    "the recovery reference stays out of the model-facing failure projection"
  );
  assert.equal(jsonContains(outcome, "forum body secret"), false);

  await assert.rejects(
    () => executeStage(executor, context),
    (error: unknown) =>
      error instanceof CourseToolPolicyError &&
      error.decision.reasonCode === "scoped_grant_expired_or_consumed"
  );
  assert.equal(driver.calls.stage, 1, "consumed grant must prevent a second write");
});

test("trusted reconcile clears only owned state and produces a separately verified final receipt", async () => {
  const driver = adapter({ reconcile: reconciledStageOutput() });
  const { executor, sink } = executorFixture(driver);
  const outcome = await executor.execute(
    {
      toolName: "platform.editor.reconcile_stage",
      input: { stageTransactionRef: STAGE_TRANSACTION_REF }
    },
    stageContext("grant-reconcile-001")
  );

  assert.equal(outcome.result.status, "succeeded");
  assert.equal(outcome.verification?.status, "passed");
  assert.equal(driver.calls.reconcile, 1);
  assert.equal(driver.calls.stage, 0);
  assert.equal(
    (outcome.result.safeModelProjection as { resolutionStatus: string })
      .resolutionStatus,
    "owned_draft_cleared"
  );
  assert.equal(sink.receipts[0]?.projection.status, "succeeded");
});

test("inconclusive reconcile keeps the original safe transaction reference for mechanical recovery", async () => {
  const driver = adapter({
    reconcile: {
      status: "unknown",
      reasonCode: "driver_timeout",
      stageTransactionRef: STAGE_TRANSACTION_REF,
      evidenceRefs: [ARTIFACT_REF],
      observedAt: FIXTURE_NOW
    }
  });
  const { executor, sink } = executorFixture(driver);
  const outcome = await executor.execute(
    {
      toolName: "platform.editor.reconcile_stage",
      input: { stageTransactionRef: STAGE_TRANSACTION_REF }
    },
    stageContext("grant-reconcile-unknown")
  );

  assert.equal(outcome.result.status, "unknown");
  assert.equal(outcome.result.compensationRef, STAGE_TRANSACTION_REF);
  assert.equal(
    outcome.durableProjection.compensationRef,
    STAGE_TRANSACTION_REF
  );
  assert.equal(
    sink.receipts[0]?.projection.compensationRef,
    STAGE_TRANSACTION_REF
  );
  assert.deepEqual(outcome.result.safeModelProjection, {
    status: "unknown",
    code: "platform_stage_reconcile_required"
  });
  assert.equal(driver.calls.reconcile, 1);
  assert.equal(driver.calls.stage, 0);
});

test("reconcile refuses unowned editor content and does not claim a cleared success", async () => {
  const driver = adapter({
    reconcile: {
      status: "blocked",
      reasonCode: "blocked_unowned_content",
      stageTransactionRef: STAGE_TRANSACTION_REF,
      evidenceRefs: [ARTIFACT_REF],
      observedAt: FIXTURE_NOW
    }
  });
  const { executor, sink } = executorFixture(driver);
  const outcome = await executor.execute(
    {
      toolName: "platform.editor.reconcile_stage",
      input: { stageTransactionRef: STAGE_TRANSACTION_REF }
    },
    stageContext("grant-reconcile-unowned")
  );

  assert.equal(outcome.result.status, "failed");
  assert.deepEqual(outcome.result.safeModelProjection, {
    status: "failed",
    code: "platform_stage_blocked_unowned_content"
  });
  assert.equal(driver.calls.reconcile, 1);
  assert.equal(driver.calls.stage, 0);
  assert.equal(sink.receipts[0]?.projection.status, "failed");
  assert.equal(
    Object.hasOwn(
      outcome.result.safeModelProjection as object,
      "editorStatus"
    ),
    false
  );
});

test("malformed or privacy-bearing trusted output cannot enter the safe model or durable projection", async () => {
  const unsafe = {
    ...verifiedStageOutput(),
    forumBody: "forum body secret"
  } as unknown as PlatformStageVerifiedOutput;
  const driver = adapter({ stage: unsafe });
  const { executor, sink } = executorFixture(driver);
  const outcome = await executeStage(
    executor,
    stageContext("grant-stage-unsafe-output")
  );

  assert.equal(outcome.result.status, "unknown");
  assert.deepEqual(outcome.result.safeModelProjection, {
    status: "unknown",
    code: "tool_execution_error"
  });
  assert.equal(jsonContains(outcome, "forum body secret"), false);
  assert.equal(jsonContains(sink.receipts, "forum body secret"), false);
});
