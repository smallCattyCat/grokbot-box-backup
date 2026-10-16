import assert from "node:assert/strict";
import test from "node:test";
import {
  COURSE_TOOL_ENVELOPE_SCHEMA_VERSION,
  hashCourseScope,
  hashCourseToolValue,
  type CourseToolVerificationPolicy,
  type ToolExecutionEnvelope
} from "../../lib/course-tools/contracts";
import { CourseToolRegistry } from "../../lib/course-tools/registry";
import {
  CourseToolVerifierRegistry,
  CourseToolVerifierRegistryError,
  type CourseToolVerifierRegistration
} from "../../lib/course-tools/verifier-registry";
import {
  FIXTURE_NOW,
  makeToolRegistration,
  passingVerifier,
  serverContext
} from "./course-tool-test-fixtures";

function verifierFixture() {
  const context = serverContext();
  const registration = new CourseToolRegistry()
    .register(makeToolRegistration())
    .resolve("course.fixture_read", "1");
  const input = Object.freeze({ query: "fixture" });
  const envelope: ToolExecutionEnvelope = Object.freeze({
    schemaVersion: COURSE_TOOL_ENVELOPE_SCHEMA_VERSION,
    callId: context.callId,
    taskId: context.taskId,
    runId: context.runId,
    planRevisionId: context.planRevisionId,
    stepId: context.stepId,
    courseScope: context.courseScope,
    courseScopeHash: hashCourseScope(context.courseScope),
    toolName: registration.definition.name,
    toolVersion: registration.definition.version,
    input,
    inputHash: hashCourseToolValue("fixture-input", input),
    idempotencyKey: context.idempotencyKey,
    grantedCapability: "L0_READ",
    policyVersion: context.policyVersion,
    attempt: context.attempt,
    executionLeaseId: context.executionLeaseId,
    leaseGeneration: context.leaseGeneration,
    fencingToken: context.fencingToken,
    startedAt: context.now,
    deadlineAt: context.deadlineAt
  });
  return {
    definition: registration.definition,
    context,
    envelope,
    handlerResult: {
      output: { value: "fixture-output" },
      evidenceRefs: [],
      containsForumText: false as const,
      containsIdentity: false as const,
      containsSecrets: false as const
    },
    subject: { type: "tool_result" as const, id: context.callId },
    observedAt: FIXTURE_NOW
  };
}

function idFactory() {
  let next = 0;
  return () => `verification-fixture-${++next}`;
}

test("verifier registry runs versioned checks and returns one safe aggregate report", async () => {
  const registry = new CourseToolVerifierRegistry({ idFactory: idFactory() })
    .register(passingVerifier())
    .seal();
  const policy: CourseToolVerificationPolicy = {
    required: true,
    subjectType: "tool_result",
    verifiers: [
      { name: "verification.fixture", version: "1", required: true }
    ],
    mode: "all",
    onFailure: "failed"
  };
  const report = await registry.verify({ ...verifierFixture(), policy });

  assert.equal(report.status, "passed");
  assert.equal(report.subjectType, "tool_result");
  assert.equal(report.subjectId, "call-fixture-001");
  assert.equal(report.receipts.length, 1);
  assert.equal(report.receipts[0]?.status, "passed");
  assert.equal(report.receipts[0]?.containsSecrets, false);
  assert.equal(JSON.stringify(report).includes("fencing-token"), false);
  assert.deepEqual(registry.manifest().verifiers, [
    {
      name: "verification.fixture",
      version: "1",
      safeLabel: "Fixture verification"
    }
  ]);
});

test("missing, throwing, or malformed verifiers resolve to unknown without leaking raw errors", async () => {
  const throwing: CourseToolVerifierRegistration = {
    definition: {
      name: "verification.throwing",
      version: "1",
      safeLabel: "Throwing verification"
    },
    verify: async () => {
      throw new Error("Bearer raw-verifier-secret");
    }
  };
  const malformed: CourseToolVerifierRegistration = {
    definition: {
      name: "verification.malformed",
      version: "1",
      safeLabel: "Malformed verification"
    },
    verify: async () => ({
      status: "passed",
      checks: [
        {
          code: "unsafe_check",
          status: "passed",
          safeSummary: "token=raw-secret"
        }
      ],
      evidenceRefs: [],
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false
    })
  };
  const registry = new CourseToolVerifierRegistry({ idFactory: idFactory() })
    .register(throwing)
    .register(malformed);

  for (const ref of [
    { name: "verification.missing", version: "1", required: true },
    { name: "verification.throwing", version: "1", required: true },
    { name: "verification.malformed", version: "1", required: true }
  ]) {
    const report = await registry.verify({
      ...verifierFixture(),
      policy: {
        required: true,
        subjectType: "tool_result",
        verifiers: [ref],
        mode: "all",
        onFailure: "failed"
      }
    });
    assert.equal(report.status, "unknown");
    assert.equal(report.receipts[0]?.status, "unknown");
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("raw-verifier-secret"), false);
    assert.equal(serialized.includes("raw-secret"), false);
  }
});

test("any-mode can pass on one independent verifier while all-mode fails closed", async () => {
  const failed: CourseToolVerifierRegistration = {
    definition: {
      name: "verification.failed",
      version: "1",
      safeLabel: "Failed verification"
    },
    verify: async () => ({
      status: "failed",
      checks: [
        {
          code: "fixture_failed",
          status: "failed",
          safeSummary: "Fixture postcondition failed."
        }
      ],
      evidenceRefs: [],
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false
    })
  };
  const registry = new CourseToolVerifierRegistry({ idFactory: idFactory() })
    .register(passingVerifier())
    .register(failed);
  const refs = [
    { name: "verification.fixture", version: "1", required: true },
    { name: "verification.failed", version: "1", required: true }
  ] as const;

  const any = await registry.verify({
    ...verifierFixture(),
    policy: {
      required: true,
      subjectType: "tool_result",
      verifiers: refs,
      mode: "any",
      onFailure: "failed"
    }
  });
  assert.equal(any.status, "passed");

  const all = await registry.verify({
    ...verifierFixture(),
    policy: {
      required: true,
      subjectType: "tool_result",
      verifiers: refs,
      mode: "all",
      onFailure: "failed"
    }
  });
  assert.equal(all.status, "failed");
});

test("registry rejects collisions, post-seal registration, and subject mismatches", async () => {
  const registry = new CourseToolVerifierRegistry({ idFactory: idFactory() })
    .register(passingVerifier());
  assert.throws(
    () => registry.register(passingVerifier()),
    (error: unknown) =>
      error instanceof CourseToolVerifierRegistryError &&
      error.code === "COURSE_TOOL_VERIFIER_COLLISION"
  );
  registry.seal();
  assert.throws(
    () => registry.register(passingVerifier()),
    (error: unknown) =>
      error instanceof CourseToolVerifierRegistryError &&
      error.code === "COURSE_TOOL_VERIFIER_REGISTRY_SEALED"
  );

  await assert.rejects(
    () =>
      registry.verify({
        ...verifierFixture(),
        subject: { type: "target", id: "target-fixture" },
        policy: {
          required: true,
          subjectType: "tool_result",
          verifiers: [
            { name: "verification.fixture", version: "1", required: true }
          ],
          mode: "all",
          onFailure: "failed"
        }
      }),
    (error: unknown) =>
      error instanceof CourseToolVerifierRegistryError &&
      error.code === "COURSE_TOOL_VERIFICATION_SUBJECT_MISMATCH"
  );
});
