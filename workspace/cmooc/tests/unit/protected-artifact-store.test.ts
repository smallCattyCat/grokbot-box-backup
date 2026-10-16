import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryProtectedArtifactStore,
  PROTECTED_ARTIFACT_RECOVERY_BOUNDARY,
  ProtectedArtifactStoreError
} from "../../lib/workbench/protected-artifact-store";
import { hashTransientDraftBody } from "../../lib/live-runtime/draft-content";

const NOW = "2026-08-12T12:00:00.000Z";
const EXPIRY = "2026-08-12T12:05:00.000Z";

test("protected draft store is process-memory only and idempotently returns the same opaque handle", async () => {
  const store = new InMemoryProtectedArtifactStore({
    idFactory: () => "protected-fixture-001"
  });
  const body = "一行受保护草稿。\r\n第二行。";
  const normalizedBody = "一行受保护草稿。\n第二行。";
  const draftBodyHash = hashTransientDraftBody(normalizedBody);
  const request = {
    taskId: "task-protected-001",
    runId: "run-protected-001",
    callId: "call-protected-001",
    idempotencyKey: "idem-protected-001",
    body,
    draftBodyHash,
    storedAt: NOW,
    expiresAt: EXPIRY
  } as const;

  const first = await store.put(request);
  const duplicate = await store.put({
    ...request,
    callId: "call-protected-retry-002"
  });
  assert.deepEqual(duplicate, first);
  assert.equal(first.bodyPersisted, false);
  assert.equal(first.recovery, "regenerate_and_reverify");
  assert.equal("body" in first, false);
  assert.equal(
    await store.getByRef({
      ref: first.ref,
      taskId: request.taskId,
      runId: request.runId,
      expectedDraftBodyHash: draftBodyHash,
      now: NOW
    }),
    normalizedBody
  );
  assert.deepEqual(PROTECTED_ARTIFACT_RECOVERY_BOUNDARY, {
    storage: "process_memory_only",
    exactResume: false,
    recovery: "regenerate_and_reverify",
    bodyPersisted: false
  });
});

test("protected draft store rejects idempotency drift and cross-scope reads", async () => {
  const store = new InMemoryProtectedArtifactStore({
    idFactory: () => "protected-fixture-002"
  });
  const body = "受保护草稿。";
  const handle = await store.put({
    taskId: "task-protected-002",
    runId: "run-protected-002",
    callId: "call-protected-002",
    idempotencyKey: "idem-protected-002",
    body,
    draftBodyHash: hashTransientDraftBody(body),
    storedAt: NOW,
    expiresAt: EXPIRY
  });

  await assert.rejects(
    store.put({
      taskId: "task-protected-002",
      runId: "run-protected-002",
      callId: "call-protected-003",
      idempotencyKey: "idem-protected-002",
      body: "不同正文。",
      draftBodyHash: hashTransientDraftBody("不同正文。"),
      storedAt: NOW,
      expiresAt: EXPIRY
    }),
    (error: unknown) =>
      error instanceof ProtectedArtifactStoreError &&
      error.code === "PROTECTED_DRAFT_IDEMPOTENCY_CONFLICT"
  );
  await assert.rejects(
    store.getByRef({
      ref: handle.ref,
      taskId: "task-other-002",
      runId: "run-protected-002",
      expectedDraftBodyHash: handle.draftBodyHash,
      now: NOW
    }),
    (error: unknown) =>
      error instanceof ProtectedArtifactStoreError &&
      error.code === "PROTECTED_DRAFT_SCOPE_MISMATCH"
  );
});

test("expired protected draft is unavailable and therefore requires regeneration", async () => {
  const store = new InMemoryProtectedArtifactStore({
    idFactory: () => "protected-fixture-003"
  });
  const body = "短时草稿。";
  const handle = await store.put({
    taskId: "task-protected-003",
    runId: "run-protected-003",
    callId: "call-protected-003",
    idempotencyKey: "idem-protected-003",
    body,
    draftBodyHash: hashTransientDraftBody(body),
    storedAt: NOW,
    expiresAt: "2026-08-12T12:00:01.000Z"
  });
  assert.equal(
    await store.getByRef({
      ref: handle.ref,
      taskId: "task-protected-003",
      runId: "run-protected-003",
      expectedDraftBodyHash: handle.draftBodyHash,
      now: "2026-08-12T12:00:01.000Z"
    }),
    null
  );
});
