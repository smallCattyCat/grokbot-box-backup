import assert from "node:assert/strict";
import test from "node:test";
import {
  COURSE_TOOL_GRANT_SCHEMA_VERSION,
  CourseToolOperationError,
  type CourseToolRegistration,
  type CourseToolVerificationReport,
  type ServerToolExecutionContext,
  type ToolVerificationCommitContext
} from "../../lib/course-tools/contracts";
import {
  CourseToolExecutionError,
  CourseToolExecutor
} from "../../lib/course-tools/executor";
import {
  CourseToolPolicyError,
  CourseToolPolicyGateway,
  type ScopedCourseToolGrantAuthority
} from "../../lib/course-tools/policy-gateway";
import { CourseToolRegistry } from "../../lib/course-tools/registry";
import {
  CourseToolVerifierRegistry,
  type CourseToolVerifierRegistration
} from "../../lib/course-tools/verifier-registry";
import {
  CapturingCourseToolSink,
  type FixtureInput,
  type FixtureOutput,
  jsonContains,
  makeToolRegistration,
  passingVerifier,
  serverContext
} from "./course-tool-test-fixtures";

function idFactory(prefix: string) {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function executorFixture(input: {
  registration?: CourseToolRegistration<FixtureInput, FixtureOutput>;
  sink?: CapturingCourseToolSink;
  policyGateway?: CourseToolPolicyGateway;
  verifiers?: readonly CourseToolVerifierRegistration[];
} = {}) {
  const registration = input.registration ?? makeToolRegistration();
  const registry = new CourseToolRegistry().register(registration).seal();
  const verifierRegistry = new CourseToolVerifierRegistry({
    idFactory: idFactory("verification-id")
  });
  for (const verifier of input.verifiers ?? []) {
    verifierRegistry.register(verifier);
  }
  verifierRegistry.seal();
  const sink = input.sink ?? new CapturingCourseToolSink();
  const executor = new CourseToolExecutor({
    registry,
    policyGateway: input.policyGateway ?? new CourseToolPolicyGateway(),
    verifierRegistry,
    sink,
    receiptIdFactory: idFactory("receipt-id")
  });
  return { executor, sink, registration };
}

test("executor injects all control fields server-side and keeps raw output/fence out of durable projections", async () => {
  const handlerRequests: Array<{
    context: ServerToolExecutionContext;
    envelope: Parameters<
      NonNullable<ReturnType<typeof makeToolRegistration>["handler"]>
    >[0]["envelope"];
  }> = [];
  const registration = makeToolRegistration({
    handler: async ({ context, envelope }) => {
      handlerRequests.push({ context, envelope });
      return {
        output: {
          value: "safe-value",
          internalDigest: "ORIGINAL_TRANSIENT_OUTPUT_MUST_NOT_PERSIST"
        },
        evidenceRefs: [],
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
    },
    summarizeInput: ({ query }) => `Read aggregate for ${query}.`,
    projectOutput: (output) => ({
      model: { value: output.value },
      safeSummary: "Safe aggregate read completed.",
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false
    }),
    definition: {
      verification: {
        required: true,
        subjectType: "tool_result",
        verifiers: [
          { name: "verification.fixture", version: "1", required: true }
        ],
        mode: "all",
        onFailure: "failed"
      }
    }
  });
  const { executor, sink } = executorFixture({
    registration,
    verifiers: [passingVerifier()]
  });
  const context = serverContext();
  const outcome = await executor.execute(
    {
      toolName: registration.definition.name,
      input: { query: "support-gap" }
    },
    context
  );

  assert.equal(outcome.result.status, "succeeded");
  assert.deepEqual(outcome.result.safeModelProjection, { value: "safe-value" });
  const transient = outcome.result.transientOutput;
  assert.ok(
    transient !== null &&
      typeof transient === "object" &&
      "internalDigest" in transient
  );
  assert.equal(
    transient.internalDigest,
    "ORIGINAL_TRANSIENT_OUTPUT_MUST_NOT_PERSIST"
  );
  assert.equal(handlerRequests.length, 1);
  const request = handlerRequests[0]!;
  assert.equal(request.envelope.taskId, context.taskId);
  assert.equal(request.envelope.runId, context.runId);
  assert.equal(request.envelope.stepId, context.stepId);
  assert.equal(request.envelope.courseScope.courseId, context.courseScope.courseId);
  assert.equal(request.envelope.grantedCapability, "L0_READ");
  assert.equal(request.envelope.attempt, context.attempt);
  assert.equal(request.envelope.executionLeaseId, context.executionLeaseId);
  assert.equal(request.envelope.leaseGeneration, context.leaseGeneration);
  assert.equal(request.envelope.fencingToken, context.fencingToken);
  assert.notEqual(
    request.envelope.idempotencyKey,
    context.idempotencyKey,
    "input_hash idempotency is mechanically derived by the executor"
  );

  assert.deepEqual(sink.order, ["call", "verification", "receipt"]);
  assert.equal(sink.verifications[0]?.report.id, outcome.verification?.id);
  assert.equal(
    sink.receipts[0]?.projection.verificationId,
    sink.verifications[0]?.report.id
  );
  assert.equal(sink.starts[0]?.fence.executionLeaseId, context.executionLeaseId);
  assert.equal(sink.starts[0]?.fence.fencingToken, context.fencingToken);
  assert.equal(sink.receipts[0]?.fence.fencingToken, context.fencingToken);

  for (const projection of [
    sink.starts[0]?.projection,
    sink.receipts[0]?.projection,
    outcome.durableProjection
  ]) {
    assert.equal(
      jsonContains(projection, "ORIGINAL_TRANSIENT_OUTPUT_MUST_NOT_PERSIST"),
      false
    );
    assert.equal(jsonContains(projection, context.fencingToken), false);
    assert.equal(jsonContains(projection, context.courseScope.courseId), false);
  }
  assert.equal(
    JSON.stringify(outcome.result).includes(
      "ORIGINAL_TRANSIENT_OUTPUT_MUST_NOT_PERSIST"
    ),
    false,
    "transientOutput is deliberately non-enumerable"
  );
  assert.equal(
    Object.keys(outcome.result).includes("transientOutput"),
    false
  );
});

test("input_hash idempotency is stable across call, lease, and server-key changes within the same step", async () => {
  const { executor, sink, registration } = executorFixture();
  const request = {
    toolName: registration.definition.name,
    input: { query: "same-business-input" }
  };
  await executor.execute(request, serverContext());
  await executor.execute(
    request,
    serverContext({
      callId: "call-fixture-002",
      idempotencyKey: "different-server-key",
      executionLeaseId: "lease-fixture-002",
      leaseGeneration: 4,
      fencingToken: "different-fencing-token-0123456789abcdef"
    })
  );
  assert.equal(sink.starts.length, 2);
  assert.equal(
    sink.starts[0]?.projection.idempotencyKey,
    sink.starts[1]?.projection.idempotencyKey
  );
  assert.notEqual(
    sink.starts[0]?.projection.fencingTokenHash,
    sink.starts[1]?.projection.fencingTokenHash
  );
});

test("model attempts to inject course, capability, idempotency, attempt, or fence fail before dispatch", async () => {
  let handlerCalls = 0;
  const registration = makeToolRegistration({
    handler: async () => {
      handlerCalls += 1;
      return {
        output: { value: "should-not-run" },
        evidenceRefs: [],
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
    }
  });
  const { executor, sink } = executorFixture({ registration });
  const forgedInputs = [
    { query: "fixture", courseId: "other-course" },
    { query: "fixture", capability: "L4_IRREVERSIBLE" },
    { query: "fixture", idempotencyKey: "model-key" },
    { query: "fixture", attempt: 9 },
    { query: "fixture", nested: { leaseGeneration: 999 } },
    { query: "fixture", fencingToken: "model-fence" }
  ];
  for (const input of forgedInputs) {
    await assert.rejects(() =>
      executor.execute(
        { toolName: registration.definition.name, input },
        serverContext()
      )
    );
  }
  await assert.rejects(() =>
    executor.execute(
      {
        toolName: registration.definition.name,
        input: { query: "fixture" },
        taskId: "model-task"
      },
      serverContext()
    )
  );
  assert.equal(handlerCalls, 0);
  assert.equal(sink.starts.length, 0);
  assert.equal(sink.receipts.length, 0);
});

test("duplicate durable claim suppresses the handler and receipt instead of repeating a side effect", async () => {
  let handlerCalls = 0;
  const registration = makeToolRegistration({
    handler: async () => {
      handlerCalls += 1;
      return {
        output: { value: "not-run" },
        evidenceRefs: [],
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
    }
  });
  const sink = new CapturingCourseToolSink();
  sink.appendResult = "duplicate";
  const { executor } = executorFixture({ registration, sink });
  await assert.rejects(
    () =>
      executor.execute(
        { toolName: registration.definition.name, input: { query: "fixture" } },
        serverContext()
      ),
    (error: unknown) =>
      error instanceof CourseToolExecutionError &&
      error.code === "COURSE_TOOL_DUPLICATE_CALL"
  );
  assert.equal(handlerCalls, 0);
  assert.equal(sink.receipts.length, 0);
});

test("unsafe output projector and raw handler errors become safe failed receipts without leaking output", async () => {
  const unsafeProjection = makeToolRegistration({
    handler: async () => ({
      output: {
        value: "fixture",
        internalDigest: "RAW_HANDLER_OUTPUT"
      },
      evidenceRefs: [],
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false
    }),
    projectOutput: () => ({
      model: { token: "Bearer raw-projector-secret" },
      safeSummary: "Unsafe projection.",
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false
    })
  });
  const first = executorFixture({ registration: unsafeProjection });
  const projected = await first.executor.execute(
    {
      toolName: unsafeProjection.definition.name,
      input: { query: "fixture" }
    },
    serverContext()
  );
  assert.equal(projected.result.status, "failed");
  assert.equal(jsonContains(projected, "raw-projector-secret"), false);
  assert.equal(jsonContains(projected.durableProjection, "RAW_HANDLER_OUTPUT"), false);

  const safeOperationError = makeToolRegistration({
    handler: async () => {
      throw new CourseToolOperationError({
        outcome: "failed",
        safeCode: "fixture_failed",
        safeSummary: "Failure token=raw-operation-secret"
      });
    }
  });
  const second = executorFixture({ registration: safeOperationError });
  const failed = await second.executor.execute(
    {
      toolName: safeOperationError.definition.name,
      input: { query: "fixture" }
    },
    serverContext()
  );
  assert.equal(failed.result.status, "failed");
  assert.deepEqual(failed.result.safeModelProjection, {
    status: "failed",
    code: "fixture_failed"
  });
  assert.equal(jsonContains(failed, "raw-operation-secret"), false);
  assert.match(failed.durableProjection.safeOutputSummary, /redacted/);
});

test("verification failure is persisted before a fail-closed receipt and hides the unverified output", async () => {
  const registration = makeToolRegistration({
    handler: async () => ({
      output: {
        value: "unverified-value",
        internalDigest: "UNVERIFIED_RAW_OUTPUT"
      },
      evidenceRefs: [],
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false
    }),
    definition: {
      verification: {
        required: true,
        subjectType: "tool_result",
        verifiers: [
          { name: "verification.fixture", version: "1", required: true }
        ],
        mode: "all",
        onFailure: "failed"
      }
    }
  });
  const failedVerifier = passingVerifier({
    status: "failed",
    checks: [
      {
        code: "fixture_check",
        status: "failed",
        safeSummary: "Fixture postcondition failed."
      }
    ]
  });
  const { executor, sink } = executorFixture({
    registration,
    verifiers: [failedVerifier]
  });
  const outcome = await executor.execute(
    { toolName: registration.definition.name, input: { query: "fixture" } },
    serverContext()
  );
  assert.equal(outcome.result.status, "failed");
  assert.deepEqual(outcome.result.safeModelProjection, {
    status: "failed",
    code: "verification_not_passed",
    verificationId: outcome.verification?.id
  });
  assert.equal(jsonContains(outcome.result.safeModelProjection, "unverified-value"), false);
  assert.equal(jsonContains(outcome.durableProjection, "UNVERIFIED_RAW_OUTPUT"), false);
  assert.deepEqual(sink.order, ["call", "verification", "receipt"]);
});

function stageGrantAuthority(): ScopedCourseToolGrantAuthority {
  return {
    claim: async ({ grantRef, binding, now }) => ({
      status: "claimed",
      grant: {
        schemaVersion: COURSE_TOOL_GRANT_SCHEMA_VERSION,
        grantRef,
        issuer: "course_tool_server",
        ...binding,
        validFrom: new Date(Date.parse(now) - 1_000).toISOString(),
        expiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
        oneShot: true,
        realPublishEnabled: false
      }
    })
  };
}

test("ambiguous L3 handler failure is unknown, never blindly retried, and still produces a fenced safe receipt", async () => {
  const registration = makeToolRegistration({
    name: "platform.editor_stage",
    effect: "external_stage",
    handler: async () => {
      throw new Error("Bearer raw-stage-error");
    }
  });
  const { executor, sink } = executorFixture({
    registration,
    policyGateway: new CourseToolPolicyGateway({
      grantAuthority: stageGrantAuthority()
    }),
    verifiers: [passingVerifier()]
  });
  const outcome = await executor.execute(
    { toolName: registration.definition.name, input: { query: "stage" } },
    serverContext({
      capabilityGrantRefs: ["grant-stage-fixture"],
      baseCapability: "L1_ARTIFACT"
    })
  );
  assert.equal(outcome.result.status, "unknown");
  assert.deepEqual(outcome.result.safeModelProjection, {
    status: "unknown",
    code: "tool_execution_error"
  });
  assert.equal(jsonContains(outcome, "raw-stage-error"), false);
  assert.equal(sink.receipts.length, 1);
  assert.match(sink.starts[0]?.projection.idempotencyKey ?? "", /^[a-f0-9]{64}$/);
  assert.notEqual(
    sink.starts[0]?.projection.idempotencyKey,
    "idempotency-fixture-001"
  );
  assert.deepEqual(sink.order, ["call", "receipt"]);
  assert.equal(registration.definition.retry.retryableStatuses.includes("failed"), false);
});

test("unknown operation receipts persist only a safe opaque compensation reference", async () => {
  const compensationRef = "stage-transaction:recover-001";
  const registration = makeToolRegistration({
    name: "platform.editor_stage",
    effect: "external_stage",
    handler: async () => {
      throw new CourseToolOperationError({
        outcome: "unknown",
        safeCode: "stage_reconcile_required",
        safeSummary: "The transaction requires trusted reconciliation.",
        compensationRef
      });
    }
  });
  const { executor, sink } = executorFixture({
    registration,
    policyGateway: new CourseToolPolicyGateway({
      grantAuthority: stageGrantAuthority()
    })
  });
  const outcome = await executor.execute(
    { toolName: registration.definition.name, input: { query: "stage" } },
    serverContext({
      capabilityGrantRefs: ["grant-stage-recovery"],
      baseCapability: "L1_ARTIFACT"
    })
  );

  assert.equal(outcome.result.status, "unknown");
  assert.equal(outcome.result.compensationRef, compensationRef);
  assert.equal(outcome.durableProjection.compensationRef, compensationRef);
  assert.equal(sink.receipts[0]?.projection.compensationRef, compensationRef);
  assert.deepEqual(outcome.result.safeModelProjection, {
    status: "unknown",
    code: "stage_reconcile_required"
  });
  assert.equal(
    Object.hasOwn(outcome.result.safeModelProjection as object, "compensationRef"),
    false
  );

  const invalidRegistration = makeToolRegistration({
    name: "platform.editor_stage_invalid_ref",
    effect: "external_stage",
    handler: async () => {
      throw new CourseToolOperationError({
        outcome: "unknown",
        safeCode: "stage_reconcile_required",
        safeSummary: "Bearer raw-recovery-secret",
        compensationRef: "Bearer raw-recovery-secret"
      });
    }
  });
  const invalid = executorFixture({
    registration: invalidRegistration,
    policyGateway: new CourseToolPolicyGateway({
      grantAuthority: stageGrantAuthority()
    })
  });
  const invalidOutcome = await invalid.executor.execute(
    {
      toolName: invalidRegistration.definition.name,
      input: { query: "stage" }
    },
    serverContext({
      capabilityGrantRefs: ["grant-stage-invalid-recovery"],
      baseCapability: "L1_ARTIFACT"
    })
  );

  assert.equal(invalidOutcome.result.status, "unknown");
  assert.equal(invalidOutcome.result.compensationRef, undefined);
  assert.equal(invalidOutcome.durableProjection.compensationRef, undefined);
  assert.equal(jsonContains(invalidOutcome, "raw-recovery-secret"), false);
  assert.equal(jsonContains(invalid.sink.receipts, "raw-recovery-secret"), false);
});

test("L3 denial occurs before durable dispatch when no scoped server grant exists", async () => {
  let handlerCalls = 0;
  const registration = makeToolRegistration({
    name: "platform.editor_stage",
    effect: "external_stage",
    handler: async () => {
      handlerCalls += 1;
      return {
        output: { value: "not-run" },
        evidenceRefs: [],
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
    }
  });
  const { executor, sink } = executorFixture({
    registration,
    verifiers: [passingVerifier()]
  });
  await assert.rejects(
    () =>
      executor.execute(
        { toolName: registration.definition.name, input: { query: "stage" } },
        serverContext({ baseCapability: "L4_IRREVERSIBLE" })
      ),
    CourseToolPolicyError
  );
  assert.equal(handlerCalls, 0);
  assert.equal(sink.starts.length, 0);
});

test("verification persistence failure leaves no receipt with a dangling verification reference", async () => {
  const registration = makeToolRegistration({
    definition: {
      verification: {
        required: true,
        subjectType: "tool_result",
        verifiers: [
          { name: "verification.fixture", version: "1", required: true }
        ],
        mode: "all",
        onFailure: "failed"
      }
    }
  });
  class FailingVerificationSink extends CapturingCourseToolSink {
    override async recordVerification(
      report: CourseToolVerificationReport,
      context: ToolVerificationCommitContext
    ): Promise<void> {
      this.verifications.push({ report, context });
      this.order.push("verification");
      throw new Error("database unavailable");
    }
  }
  const sink = new FailingVerificationSink();
  const { executor } = executorFixture({
    registration,
    sink,
    verifiers: [passingVerifier()]
  });
  await assert.rejects(
    () =>
      executor.execute(
        { toolName: registration.definition.name, input: { query: "fixture" } },
        serverContext()
      ),
    (error: unknown) =>
      error instanceof CourseToolExecutionError &&
      error.code === "COURSE_TOOL_VERIFICATION_COMMIT_FAILED" &&
      error.outcome === "failed"
  );
  assert.deepEqual(sink.order, ["call", "verification"]);
  assert.equal(sink.receipts.length, 0);

  const stage = makeToolRegistration({
    name: "platform.editor_stage",
    effect: "external_stage"
  });
  const stageSink = new FailingVerificationSink();
  const stageFixture = executorFixture({
    registration: stage,
    sink: stageSink,
    policyGateway: new CourseToolPolicyGateway({
      grantAuthority: stageGrantAuthority()
    }),
    verifiers: [passingVerifier()]
  });
  await assert.rejects(
    () =>
      stageFixture.executor.execute(
        { toolName: stage.definition.name, input: { query: "stage" } },
        serverContext({ capabilityGrantRefs: ["grant-stage-verification"] })
      ),
    (error: unknown) =>
      error instanceof CourseToolExecutionError &&
      error.code === "COURSE_TOOL_VERIFICATION_COMMIT_FAILED" &&
      error.outcome === "unknown"
  );
  assert.deepEqual(stageSink.order, ["call", "verification"]);
  assert.equal(stageSink.receipts.length, 0);
});
