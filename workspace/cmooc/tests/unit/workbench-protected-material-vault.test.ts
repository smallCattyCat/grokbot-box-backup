import assert from "node:assert/strict";
import test from "node:test";
import { hashTransientDraftBody } from "../../lib/live-runtime/draft-content";
import { CourseAgentProtectedMaterialVault } from "../../lib/workbench/course-agent-protected-material-vault";
import { InMemoryProtectedArtifactStore } from "../../lib/workbench/protected-artifact-store";

const NOW = "2026-08-13T12:00:00.000Z";
const EXPIRES = "2026-08-13T12:05:00.000Z";

test("protected material vault resolves one exact version without serializing its handle or body", async () => {
  const store = new InMemoryProtectedArtifactStore({ idFactory: () => "vault-test" });
  const body = "请比较两个观点，并说明各自证据边界。";
  const draftBodyHash = hashTransientDraftBody(body);
  const handle = await store.put({
    taskId: "task-1",
    runId: "run-1",
    callId: "call-1",
    idempotencyKey: "draft-1",
    body,
    draftBodyHash,
    storedAt: NOW,
    expiresAt: EXPIRES
  });
  const vault = new CourseAgentProtectedMaterialVault({
    taskId: "task-1",
    runId: "run-1",
    protectedStore: store
  });
  vault.bind({
    taskId: "task-1",
    runId: "run-1",
    artifactVersionRef: "artifact-version:draft-1",
    protectedRef: handle.ref,
    draftBodyHash,
    expiresAt: EXPIRES
  });

  const resolved = await vault.resolve({
    taskId: "task-1",
    runId: "run-1",
    artifactVersionRef: "artifact-version:draft-1",
    expectedDraftBodyHash: draftBodyHash,
    now: NOW
  });
  assert.equal(resolved?.body, body);
  assert.equal(resolved?.bodyPersisted, false);
  assert.equal(JSON.stringify(vault), "{}");
  assert.equal(JSON.stringify(resolved).includes(handle.ref), false);
});

test("protected material vault fails closed across scope, hash drift and expiry", async () => {
  const store = new InMemoryProtectedArtifactStore({ idFactory: () => "vault-expiry" });
  const body = "短期草稿";
  const draftBodyHash = hashTransientDraftBody(body);
  const handle = await store.put({
    taskId: "task-2",
    runId: "run-2",
    callId: "call-2",
    idempotencyKey: "draft-2",
    body,
    draftBodyHash,
    storedAt: NOW,
    expiresAt: EXPIRES
  });
  const vault = new CourseAgentProtectedMaterialVault({
    taskId: "task-2",
    runId: "run-2",
    protectedStore: store
  });
  vault.bind({
    taskId: "task-2",
    runId: "run-2",
    artifactVersionRef: "artifact-version:draft-2",
    protectedRef: handle.ref,
    draftBodyHash,
    expiresAt: EXPIRES
  });

  await assert.rejects(
    vault.resolve({
      taskId: "task-other",
      runId: "run-2",
      artifactVersionRef: "artifact-version:draft-2",
      expectedDraftBodyHash: draftBodyHash,
      now: NOW
    }),
    /different task or run/u
  );
  await assert.rejects(
    vault.resolve({
      taskId: "task-2",
      runId: "run-2",
      artifactVersionRef: "artifact-version:draft-2",
      expectedDraftBodyHash: "0".repeat(64),
      now: NOW
    }),
    /do not match/u
  );
  assert.equal(
    await vault.resolve({
      taskId: "task-2",
      runId: "run-2",
      artifactVersionRef: "artifact-version:draft-2",
      expectedDraftBodyHash: draftBodyHash,
      now: EXPIRES
    }),
    null
  );
});
