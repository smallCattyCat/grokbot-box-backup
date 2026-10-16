import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbenchDb } from "../../lib/workbench/durable-ledger";
import {
  ArtifactWorkspaceReadError,
  readArtifactWorkspace,
  readArtifactWorkspaceVersion
} from "../../lib/workbench/artifact-workspace-read-model";

const NOW = new Date("2026-08-13T12:00:00.000Z");
const TASK_ID = "task-artifact-read-model";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "artifact-version-safe-001";

function fakeDb(options: { runExists?: boolean } = {}) {
  const calls: Array<{ delegate: string; args: unknown }> = [];
  const db = {
    workbenchRunRecord: {
      findUnique: async (args: unknown) => {
        calls.push({ delegate: "run", args });
        return options.runExists === false ? null : { taskId: TASK_ID };
      }
    },
    workbenchArtifactVersionRecord: {
      findMany: async (args: unknown) => {
        calls.push({ delegate: "artifact", args });
        return [
          {
            id: VERSION_ID,
            taskId: TASK_ID,
            runId: RUN_ID,
            artifactId: "artifact-safe-001",
            version: 2,
            artifactKind: "facilitation_reply_draft",
            contentClass: "restricted_transient",
            contentHash: "a".repeat(64),
            draftBodyHash: "b".repeat(64),
            safeSummary: "Verified restricted draft metadata.",
            expiresAt: new Date("2026-08-13T12:05:00.000Z"),
            createdAt: new Date("2026-08-13T11:59:00.000Z")
          }
        ];
      }
    },
    workbenchVerificationRecord: {
      findMany: async (args: unknown) => {
        calls.push({ delegate: "verification", args });
        return [
          {
            subjectId: VERSION_ID,
            verifier: "artifact.reply_draft.verify",
            verifierVersion: "1",
            status: "passed",
            safeSummary: "Draft hash and transient boundary passed.",
            observedAt: new Date("2026-08-13T11:59:30.000Z"),
            expiresAt: new Date("2026-08-13T12:05:00.000Z")
          }
        ];
      }
    }
  } as unknown as WorkbenchDb;
  return { db, calls };
}

test("artifact workspace selects and projects only safe metadata, hashes, verification and recovery", async () => {
  const fixture = fakeDb();
  const workspace = await readArtifactWorkspace(fixture.db, {
    runId: RUN_ID,
    now: NOW
  });
  assert.equal(workspace.taskId, TASK_ID);
  assert.equal(workspace.runId, RUN_ID);
  assert.equal(workspace.bodyIncluded, false);
  assert.equal(workspace.versions.length, 1);
  const version = workspace.versions[0]!;
  assert.equal(version.versionRef, `artifact-version:${VERSION_ID}`);
  assert.equal(version.verification.status, "passed");
  assert.equal(version.recovery.action, "regenerate_and_reverify");
  assert.equal(version.recovery.bodyPersisted, false);

  const artifactArgs = fixture.calls.find((call) => call.delegate === "artifact")!
    .args as {
    where: Record<string, unknown>;
    select: Record<string, boolean>;
  };
  assert.deepEqual(artifactArgs.where, { taskId: TASK_ID, runId: RUN_ID });
  for (const forbidden of [
    "metadataJson",
    "regenerationRecipeJson",
    "contentRef",
    "sourceRefsJson"
  ]) {
    assert.equal(forbidden in artifactArgs.select, false);
  }
  const serialized = JSON.stringify(workspace);
  assert.equal(serialized.includes("metadataJson"), false);
  assert.equal(serialized.includes("regenerationRecipe"), false);
  assert.equal(serialized.includes("protectedRef"), false);
  assert.equal(serialized.includes("body\""), false);
});

test("single-version read binds version id to the exact task and run", async () => {
  const fixture = fakeDb();
  const version = await readArtifactWorkspaceVersion(fixture.db, {
    runId: RUN_ID,
    versionId: VERSION_ID,
    now: NOW
  });
  assert.equal(version.taskId, TASK_ID);
  assert.equal(version.runId, RUN_ID);
  const artifactArgs = fixture.calls.find((call) => call.delegate === "artifact")!
    .args as { where: Record<string, unknown> };
  assert.deepEqual(artifactArgs.where, {
    taskId: TASK_ID,
    runId: RUN_ID,
    id: VERSION_ID
  });
});

test("missing run fails before any artifact query", async () => {
  const fixture = fakeDb({ runExists: false });
  await assert.rejects(
    readArtifactWorkspace(fixture.db, { runId: RUN_ID, now: NOW }),
    (error: unknown) =>
      error instanceof ArtifactWorkspaceReadError &&
      error.code === "WORKBENCH_ARTIFACT_RUN_NOT_FOUND"
  );
  assert.deepEqual(
    fixture.calls.map((call) => call.delegate),
    ["run"]
  );
});
