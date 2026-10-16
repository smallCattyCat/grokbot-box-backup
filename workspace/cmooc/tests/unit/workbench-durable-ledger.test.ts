import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { createArtifactVersion } from "../../lib/workbench/artifact-store";
import {
  assertSafeDurableValue,
  createSafeTaskObjective,
  hashExecutionFencingToken,
  recordVerification,
  WorkbenchDurableLedgerError
} from "../../lib/workbench/durable-ledger";
import { isPlanStepTransitionAllowed } from "../../lib/workbench/plan-store";

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const unreachableDb = {} as PrismaClient;

test("durable safety projection rejects prompt, body, identity, secret and local-path fields", () => {
  for (const unsafe of [
    { prompt: "raw objective" },
    { draftBody: "raw draft" },
    { identity: "natural person" },
    { cookie: "session=value" },
    { nested: { accessToken: "token-value" } },
    { ref: "C:\\private\\artifact.txt" },
    { ref: "https://example.test/private?token=value" }
  ]) {
    assert.throws(
      () => assertSafeDurableValue(unsafe),
      (error: unknown) =>
        error instanceof WorkbenchDurableLedgerError &&
        error.code === "WORKBENCH_DURABLE_INPUT_UNSAFE"
    );
  }

  assert.doesNotThrow(() =>
    assertSafeDurableValue({
      goalCode: "support_gap_review",
      draftBodyHash: hash("transient draft"),
      evidenceRef: "snapshot:safe-001",
      checks: [{ code: "scope_match", status: "passed" }]
    })
  );
});

test("safe objective rejects raw prompt-shaped structured data before touching the database", async () => {
  await assert.rejects(
    createSafeTaskObjective(unreachableDb, {
      taskId: "task-safe",
      objectiveHash: hash("objective"),
      safeSummary: "核验一个安全课程目标。",
      structuredGoal: { rawPrompt: "do not persist this" },
      source: "user_request_classified"
    }),
    (error: unknown) =>
      error instanceof WorkbenchDurableLedgerError &&
      error.code === "WORKBENCH_DURABLE_INPUT_UNSAFE"
  );
});

test("restricted artifact rejects every durable content reference before database access", async () => {
  await assert.rejects(
    createArtifactVersion(unreachableDb, {
      taskId: "task-safe",
      runId: "run-safe",
      artifactId: "artifact-safe",
      artifactKind: "facilitation_draft",
      contentClass: "restricted_transient",
      contentHash: hash("object projection"),
      draftBodyHash: hash("transient draft"),
      contentRef: "blob:raw-draft",
      safeSummary: "草稿只保留哈希与再生成配方。",
      metadata: { guardStatus: "passed" },
      sourceRefs: [],
      regenerationRecipe: { recipeCode: "intent_movespec_v1" }
    }),
    (error: unknown) =>
      error instanceof WorkbenchDurableLedgerError &&
      error.code === "WORKBENCH_RESTRICTED_ARTIFACT_CONTENT_FORBIDDEN"
  );
});

test("fencing token hashing is domain separated and never returns the token", () => {
  const token = "a".repeat(64);
  const first = hashExecutionFencingToken(token);
  const second = hashExecutionFencingToken(token);
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, token);
  assert.notEqual(first, hash(token));
});

test("tool_result is accepted as a first-class verification subject before fenced database access", async () => {
  await assert.rejects(
    recordVerification(unreachableDb, {
      id: "verification-tool-result",
      taskId: "task-safe",
      runId: "run-safe",
      subjectType: "tool_result",
      subjectId: "call:safe-001",
      verifier: "course.tool.result.verify",
      verifierVersion: "1",
      status: "passed",
      safeSummary: "工具结果的独立后置条件检查通过。",
      checks: [
        {
          code: "schema_match",
          status: "passed",
          safeSummary: "安全结果投影符合契约。"
        }
      ],
      evidenceRefs: [],
      observedAt: "2026-08-12T00:00:00.000Z",
      executionLeaseId: "lease-safe",
      stepId: "step-safe",
      leaseGeneration: 1,
      fencingToken: "invalid-token"
    }),
    (error: unknown) =>
      error instanceof WorkbenchDurableLedgerError &&
      error.code === "WORKBENCH_DURABLE_INPUT_INVALID"
  );
});

test("canonical plan step transition table admits only mechanical execution edges", () => {
  const allowed = [
    ["pending", "running"],
    ["pending", "skipped"],
    ["running", "completed"],
    ["running", "blocked"],
    ["running", "waiting_for_browser"],
    ["running", "waiting_for_approval"],
    ["running", "waiting_for_reconcile"],
    ["blocked", "pending"],
    ["waiting_for_browser", "pending"],
    ["waiting_for_approval", "pending"],
    ["waiting_for_reconcile", "pending"]
  ] as const;
  for (const [from, to] of allowed) {
    assert.equal(isPlanStepTransitionAllowed(from, to), true, `${from} -> ${to}`);
  }
  for (const [from, to] of [
    ["pending", "completed"],
    ["pending", "blocked"],
    ["completed", "pending"],
    ["completed", "running"],
    ["blocked", "completed"],
    ["running", "pending"]
  ] as const) {
    assert.equal(isPlanStepTransitionAllowed(from, to), false, `${from} -> ${to}`);
  }
});
