import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  hashCourseToolValue,
  type CourseToolBusinessInput
} from "../../lib/course-tools/contracts";
import type { CourseToolGrantBinding } from "../../lib/course-tools/policy-gateway";
import {
  CourseToolActionStoreError,
  hashCourseToolActionApproval,
  hashCourseToolActionBinding,
  isCourseToolActionTransitionAllowed,
  prepareCourseToolAction,
  type ServerPreparedCourseToolAction
} from "../../lib/workbench/course-tool-action-store";

const unreachableDb = {} as PrismaClient;

function binding(
  overrides: Partial<CourseToolGrantBinding> = {}
): CourseToolGrantBinding {
  const businessInput = { draftArtifactRef: "artifact:safe-001" };
  return {
    capability: "L3_EXTERNAL_STAGE",
    effect: "external_stage",
    toolName: "platform.editor.stage_verify_clear",
    toolVersion: "1",
    callId: "call:stage-001",
    taskId: "task:stage-001",
    runId: "run:stage-001",
    planRevisionId: "plan:stage-001",
    stepId: "step:stage-001",
    courseScopeHash: hashCourseToolValue("fixture", "course"),
    inputHash: hashCourseToolValue(
      "input:platform.editor.stage_verify_clear@1",
      businessInput
    ),
    idempotencyKeyHash: hashCourseToolValue("fixture", "idempotency"),
    policyVersion: "cmooc.course-tool.policy.v1",
    attempt: 1,
    ...overrides
  };
}

function material(
  overrides: Partial<ServerPreparedCourseToolAction> = {}
): ServerPreparedCourseToolAction {
  return {
    actionRef: "action:stage-001",
    grantRef: "grant:stage-001",
    binding: binding(),
    businessInput: { draftArtifactRef: "artifact:safe-001" },
    safeSummary: "暂存、逐字回读并清除一个受保护草稿。",
    validFrom: "2026-08-13T10:00:00.000Z",
    expiresAt: "2026-08-13T10:05:00.000Z",
    preparedAt: "2026-08-13T09:59:00.000Z",
    oneShot: true,
    realPublishEnabled: false,
    ...overrides
  };
}

test("server prepared material rejects forum body, identity, secret and local path before database access", async () => {
  const unsafeInputs: readonly CourseToolBusinessInput[] = [
    { draftBody: "raw forum draft" },
    { identity: "natural person" },
    { accessToken: "not-a-real-token" },
    { artifactRef: "C:\\private\\draft.txt" },
    { artifactRef: "https://example.test/private" }
  ];
  for (const businessInput of unsafeInputs) {
    await assert.rejects(
      prepareCourseToolAction(
        unreachableDb,
        material({
          businessInput,
          binding: binding({
            inputHash: hashCourseToolValue(
              "input:platform.editor.stage_verify_clear@1",
              businessInput
            )
          })
        })
      ),
      (error: unknown) =>
        error instanceof Error &&
        /安全投影|持久账本|forbidden|unsafe/iu.test(error.message)
    );
  }
});

test("persistent action authority rejects L4, publish-enabled and unknown-field injection before database access", async () => {
  await assert.rejects(
    prepareCourseToolAction(
      unreachableDb,
      material({
        binding: binding({
          capability: "L4_IRREVERSIBLE",
          effect: "irreversible_external"
        })
      })
    ),
    (error: unknown) =>
      error instanceof CourseToolActionStoreError &&
      error.code === "COURSE_TOOL_ACTION_STAGE_ONLY"
  );

  await assert.rejects(
    prepareCourseToolAction(
      unreachableDb,
      { ...material(), realPublishEnabled: true } as unknown as ServerPreparedCourseToolAction
    ),
    (error: unknown) =>
      error instanceof CourseToolActionStoreError &&
      error.code === "COURSE_TOOL_ACTION_PUBLISH_FORBIDDEN"
  );

  await assert.rejects(
    prepareCourseToolAction(
      unreachableDb,
      { ...material(), publish: true } as unknown as ServerPreparedCourseToolAction
    ),
    (error: unknown) =>
      error instanceof CourseToolActionStoreError &&
      error.code === "COURSE_TOOL_ACTION_MATERIAL_UNKNOWN_FIELD"
  );
});

test("binding and approval hashes are canonical, domain-separated and exact-scope sensitive", () => {
  const firstBinding = binding();
  const reordered = Object.fromEntries(
    Object.entries(firstBinding).reverse()
  ) as unknown as CourseToolGrantBinding;
  const bindingHash = hashCourseToolActionBinding(firstBinding);
  assert.equal(hashCourseToolActionBinding(reordered), bindingHash);

  const approvalHash = hashCourseToolActionApproval({
    actionRef: "action:stage-001",
    grantRef: "grant:stage-001",
    bindingHash,
    validFrom: "2026-08-13T10:00:00.000Z",
    expiresAt: "2026-08-13T10:05:00.000Z"
  });
  assert.notEqual(approvalHash, bindingHash);
  assert.notEqual(
    hashCourseToolActionApproval({
      actionRef: "action:stage-001",
      grantRef: "grant:stage-002",
      bindingHash,
      validFrom: "2026-08-13T10:00:00.000Z",
      expiresAt: "2026-08-13T10:05:00.000Z"
    }),
    approvalHash
  );
});

test("action transition table reserves approval and grant claim edges for their atomic services", () => {
  for (const [from, to] of [
    ["prepared", "awaiting_approval"],
    ["executing", "succeeded"],
    ["executing", "failed_before_write"],
    ["executing", "unknown"],
    ["unknown", "reconciling"],
    ["reconciling", "reconciled"],
    ["reconciling", "manual_review"]
  ] as const) {
    assert.equal(isCourseToolActionTransitionAllowed(from, to), true);
  }
  for (const [from, to] of [
    ["awaiting_approval", "approved"],
    ["approved", "executing"],
    ["prepared", "executing"],
    ["unknown", "succeeded"],
    ["succeeded", "executing"]
  ] as const) {
    assert.equal(isCourseToolActionTransitionAllowed(from, to), false);
  }
});
