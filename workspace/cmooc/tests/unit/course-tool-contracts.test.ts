import assert from "node:assert/strict";
import test from "node:test";
import {
  CourseToolContractError,
  type CourseToolJsonValue,
  assertSafeCourseToolProjection,
  assertServerToolExecutionContext,
  createJsonCourseToolSchema,
  hashCourseToolValue,
  parseModelToolRequest,
  sanitizeCourseToolSummary
} from "../../lib/course-tools/contracts";
import { serverContext } from "./course-tool-test-fixtures";

test("model requests accept business parameters only and freeze their canonical copy", () => {
  const raw = {
    toolName: "course.snapshot_read",
    toolVersion: "1",
    input: {
      anchorRef: "snapshot-fixture",
      filters: { includeCoverage: true }
    }
  };
  const parsed = parseModelToolRequest(raw);

  assert.deepEqual(parsed, raw);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.input), true);
  assert.equal(Object.isFrozen(parsed.input.filters), true);
  raw.input.anchorRef = "changed-after-parse";
  assert.equal(parsed.input.anchorRef, "snapshot-fixture");
  assert.match(hashCourseToolValue("fixture", parsed.input), /^[a-f0-9]{64}$/);
});

test("model requests reject every server execution field at the top level or recursively", () => {
  const forged = [
    {
      toolName: "course.snapshot_read",
      input: { anchorRef: "fixture" },
      taskId: "forged-task"
    },
    {
      toolName: "course.snapshot_read",
      input: { taskId: "forged-task" }
    },
    {
      toolName: "course.snapshot_read",
      input: { nested: { course_scope: { courseId: "other-course" } } }
    },
    {
      toolName: "course.snapshot_read",
      input: { capabilityGrantRefs: ["grant-forged"] }
    },
    {
      toolName: "course.snapshot_read",
      input: { retry: { leaseGeneration: 999, fencing_token: "forged" } }
    },
    {
      toolName: "course.snapshot_read",
      input: { idempotencyKey: "model-key", attempt: 7 }
    }
  ];

  for (const value of forged) {
    assert.throws(
      () => parseModelToolRequest(value),
      (error: unknown) =>
        error instanceof CourseToolContractError &&
        [
          "COURSE_TOOL_REQUEST_UNKNOWN_FIELD",
          "COURSE_TOOL_SERVER_FIELD_INJECTION"
        ].includes(error.code)
    );
  }
});

test("closed JSON schemas reject unknown business fields and cannot expose server controls", () => {
  const schema = createJsonCourseToolSchema<{ readonly anchorRef: string }>({
    schemaVersion: "fixture.anchor-input.v1",
    modelJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["anchorRef"],
      properties: { anchorRef: { type: "string", minLength: 1 } }
    }
  });
  assert.deepEqual(schema.parse({ anchorRef: "snapshot-001" }), {
    anchorRef: "snapshot-001"
  });
  assert.throws(
    () => schema.parse({ anchorRef: "snapshot-001", extra: true }),
    (error: unknown) =>
      error instanceof CourseToolContractError &&
      error.code === "COURSE_TOOL_SCHEMA_VALIDATION_FAILED"
  );

  assert.throws(
    () =>
      createJsonCourseToolSchema({
        schemaVersion: "fixture.forged-input.v1",
        modelJsonSchema: {
          type: "object",
          additionalProperties: false,
          properties: { courseId: { type: "string" } }
        }
      }),
    (error: unknown) =>
      error instanceof CourseToolContractError &&
      error.code === "COURSE_TOOL_SCHEMA_EXPOSES_SERVER_FIELD"
  );
  assert.throws(
    () =>
      createJsonCourseToolSchema({
        schemaVersion: "fixture.open-input.v1",
        modelJsonSchema: {
          type: "object",
          properties: { anchorRef: { type: "string" } }
        }
      }),
    (error: unknown) =>
      error instanceof CourseToolContractError &&
      error.code === "COURSE_TOOL_SCHEMA_MUST_BE_CLOSED"
  );
});

test("safe projections reject secrets, credentials, paths, links, and restricted fields", () => {
  const base = {
    safeSummary: "Safe aggregate is available.",
    containsForumText: false as const,
    containsIdentity: false as const,
    containsSecrets: false as const
  };
  assert.doesNotThrow(() =>
    assertSafeCourseToolProjection({
      ...base,
      model: { aggregateCount: 3, evidenceRef: "snapshot-fixture" }
    })
  );

  const unsafeModels: readonly CourseToolJsonValue[] = [
    { token: "fixture-secret" },
    { body: "raw forum body" },
    { username: "natural-person-name" },
    { courseId: "raw-platform-course" },
    { nested: { fencingToken: "fixture-fence" } },
    { message: "Bearer fixture-secret-token" },
    { source: "https://private.example/path?token=fixture" },
    { source: "C:\\Users\\fixture\\auth-state.json" }
  ];
  for (const model of unsafeModels) {
    assert.throws(
      () => assertSafeCourseToolProjection({ ...base, model }),
      CourseToolContractError
    );
  }
});

test("durable summaries redact secrets without persisting the original material", () => {
  const source =
    "Completed with token=fixture-secret at https://private.example/path and C:\\Users\\fixture\\file.txt";
  const safe = sanitizeCourseToolSummary(source);
  assert.equal(safe.includes("fixture-secret"), false);
  assert.equal(safe.includes("private.example"), false);
  assert.equal(safe.includes("C:\\Users\\fixture"), false);
  assert.match(safe, /redacted/);
});

test("server context requires a live deadline and complete lease fence injected outside model input", () => {
  assert.doesNotThrow(() => assertServerToolExecutionContext(serverContext()));
  for (const invalid of [
    serverContext({ executionLeaseId: "" }),
    serverContext({ leaseGeneration: 0 }),
    serverContext({ fencingToken: "short" }),
    serverContext({ deadlineAt: "2026-08-12T12:00:00.000Z" }),
    serverContext({ capabilityGrantRefs: ["grant-1", "bad ref with spaces"] })
  ]) {
    assert.throws(
      () => assertServerToolExecutionContext(invalid),
      (error: unknown) =>
        error instanceof CourseToolContractError &&
        error.code === "COURSE_TOOL_SERVER_CONTEXT_INVALID"
    );
  }
});
