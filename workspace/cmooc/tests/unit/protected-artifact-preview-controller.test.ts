import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "node:test";
import { hashTransientDraftBody } from "../../lib/live-runtime/draft-content";
import { InMemoryProtectedArtifactStore } from "../../lib/workbench/protected-artifact-store";
import {
  bindProtectedArtifactPreview,
  consumeProtectedArtifactDiff,
  consumeProtectedArtifactPreview,
  inspectProtectedArtifactPreview,
  ProtectedArtifactPreviewError,
  resetProtectedArtifactPreviewControllerForTests
} from "../../lib/workbench/protected-artifact-preview-controller";

const TASK_ID = "task-preview-controller";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-13T12:00:00.000Z");

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function protectedBinding(input: {
  id: string;
  versionRef: string;
  body: string;
  store?: InMemoryProtectedArtifactStore;
  now?: Date;
}) {
  const now = input.now ?? NOW;
  const store = input.store ?? new InMemoryProtectedArtifactStore({ idFactory: () => input.id });
  const draftBodyHash = hashTransientDraftBody(input.body);
  const protectedExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const handle = await store.put({
    taskId: TASK_ID,
    runId: RUN_ID,
    callId: `call-${input.id}`,
    idempotencyKey: `key-${input.id}`,
    body: input.body,
    draftBodyHash,
    storedAt: now.toISOString(),
    expiresAt: protectedExpiresAt
  });
  const contentHash = sha(`projection:${input.versionRef}:${input.body}`);
  const binding = {
    taskId: TASK_ID,
    runId: RUN_ID,
    versionRef: input.versionRef,
    contentHash,
    draftBodyHash
  };
  const publicBinding = bindProtectedArtifactPreview({
    ...binding,
    protectedRef: handle.ref,
    protectedStore: store,
    protectedExpiresAt,
    now
  });
  return { binding, publicBinding, handle, store };
}

beforeEach(() => resetProtectedArtifactPreviewControllerForTests());

test("preview binding is private, at most 60 seconds and consumed exactly once", async () => {
  const fixture = await protectedBinding({
    id: "preview-once",
    versionRef: "artifact-version:preview-once",
    body: "受保护的生成草稿"
  });
  assert.equal(
    Date.parse(fixture.publicBinding.expiresAt) - NOW.getTime(),
    60_000
  );
  assert.equal(JSON.stringify(fixture.publicBinding).includes("protected-draft"), false);
  assert.equal(
    inspectProtectedArtifactPreview({ ...fixture.binding, now: NOW }).status,
    "available"
  );
  const preview = await consumeProtectedArtifactPreview({
    ...fixture.binding,
    now: new Date(NOW.getTime() + 1_000)
  });
  assert.equal(preview.body, "受保护的生成草稿");
  assert.equal(preview.bodyPersisted, false);
  assert.equal(JSON.stringify(preview).includes(fixture.handle.ref), false);
  await assert.rejects(
    consumeProtectedArtifactPreview({
      ...fixture.binding,
      now: new Date(NOW.getTime() + 2_000)
    }),
    (error: unknown) =>
      error instanceof ProtectedArtifactPreviewError &&
      error.code === "PROTECTED_ARTIFACT_PREVIEW_UNAVAILABLE"
  );
});

test("expired and scope-changed bindings return recovery states without body access", async () => {
  const expired = await protectedBinding({
    id: "preview-expired",
    versionRef: "artifact-version:preview-expired",
    body: "expires"
  });
  const availability = inspectProtectedArtifactPreview({
    ...expired.binding,
    now: new Date(NOW.getTime() + 60_001)
  });
  assert.equal(availability.status, "regenerate_or_reenter");
  assert.equal(availability.reason, "binding_expired");

  const scoped = await protectedBinding({
    id: "preview-scope",
    versionRef: "artifact-version:preview-scope",
    body: "scope"
  });
  await assert.rejects(
    consumeProtectedArtifactPreview({
      ...scoped.binding,
      contentHash: "f".repeat(64),
      now: NOW
    }),
    (error: unknown) =>
      error instanceof ProtectedArtifactPreviewError &&
      error.code === "PROTECTED_ARTIFACT_PREVIEW_SCOPE_MISMATCH"
  );
  const stillAvailable = await consumeProtectedArtifactPreview({
    ...scoped.binding,
    now: NOW
  });
  assert.equal(stillAvailable.body, "scope");
});

test("diff atomically requires two in-scope live bodies and consumes both once", async () => {
  const from = await protectedBinding({
    id: "diff-from",
    versionRef: "artifact-version:diff-from",
    body: "开头\n旧内容\n结尾"
  });
  await assert.rejects(
    consumeProtectedArtifactDiff({
      taskId: TASK_ID,
      runId: RUN_ID,
      from: from.binding,
      to: {
        versionRef: "artifact-version:missing-to",
        contentHash: "c".repeat(64),
        draftBodyHash: "d".repeat(64)
      },
      now: NOW
    }),
    (error: unknown) => error instanceof ProtectedArtifactPreviewError
  );
  // Failed pair preflight does not burn the available half.
  assert.equal(
    (await consumeProtectedArtifactPreview({ ...from.binding, now: NOW })).body,
    "开头\n旧内容\n结尾"
  );

  const reboundFrom = await protectedBinding({
    id: "diff-from-2",
    versionRef: "artifact-version:diff-from",
    body: "开头\n旧内容\n结尾"
  });
  const to = await protectedBinding({
    id: "diff-to",
    versionRef: "artifact-version:diff-to",
    body: "开头\n新内容\n结尾"
  });
  const diff = await consumeProtectedArtifactDiff({
    taskId: TASK_ID,
    runId: RUN_ID,
    from: reboundFrom.binding,
    to: to.binding,
    now: NOW
  });
  assert.equal(diff.changed, true);
  assert.equal(
    diff.operations
      .filter((operation) => operation.kind !== "add")
      .map((operation) => operation.text)
      .join(""),
    "开头\n旧内容\n结尾"
  );
  assert.equal(
    diff.operations
      .filter((operation) => operation.kind !== "remove")
      .map((operation) => operation.text)
      .join(""),
    "开头\n新内容\n结尾"
  );
  await assert.rejects(
    consumeProtectedArtifactDiff({
      taskId: TASK_ID,
      runId: RUN_ID,
      from: reboundFrom.binding,
      to: to.binding,
      now: NOW
    }),
    (error: unknown) =>
      error instanceof ProtectedArtifactPreviewError &&
      error.code === "PROTECTED_ARTIFACT_PREVIEW_UNAVAILABLE"
  );
});
