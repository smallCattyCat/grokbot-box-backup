import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  resolveSelectedArtifactVersion,
  selectArtifactVersion,
  WorkbenchArtifactSelectionError
} from "../../lib/workbench/artifact-selection-store";

const require = createRequire(import.meta.url);
const root = mkdtempSync(path.join(tmpdir(), "cmooc-artifact-selection-"));
const url = `file:${path.join(root, "selection.db").replace(/\\/gu, "/")}`;
const prisma = new PrismaClient({ datasources: { db: { url } } });
const TASK_ID = "task-artifact-selection";
const RUN_1 = "run-artifact-selection-1";
const RUN_2 = "run-artifact-selection-2";
const ARTIFACT_ID = "artifact-logical-safe-1";
const T0 = new Date("2026-08-13T20:00:00.000Z");

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function binding(version: 1 | 2 | 3, runId = version === 1 ? RUN_1 : RUN_2) {
  return Object.freeze({
    taskId: TASK_ID,
    runId,
    artifactId: ARTIFACT_ID,
    versionId: `artifact-version-safe-${version}`,
    versionRef: `artifact-version:artifact-version-safe-${version}`,
    contentHash: sha(`safe-content-${version}`),
    draftBodyHash: sha(`transient-body-${version}`)
  });
}

before(async () => {
  const migrated = spawnSync(
    process.execPath,
    [require.resolve("prisma/build/index.js"), "migrate", "deploy"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: url,
        CMOOC_DISABLE_WINDOWS_ENV_FALLBACK: "1"
      },
      encoding: "utf8"
    }
  );
  assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`);
  await prisma.$connect();
  await prisma.workbenchTask.create({
    data: { id: TASK_ID, title: "安全 artifact", status: "running", createdAt: T0 }
  });
  for (const [runId, offset] of [[RUN_1, 0], [RUN_2, 1]] as const) {
    await prisma.workbenchRunRecord.create({
      data: {
        id: runId,
        taskId: TASK_ID,
        schemaVersion: "workbench-run-v1",
        source: "app-server",
        status: "running",
        projectLabel: "课程工作台",
        snapshotJson: "{}",
        createdAt: new Date(T0.getTime() + offset),
        updatedAt: new Date(T0.getTime() + offset)
      }
    });
  }
  for (const version of [1, 2, 3] as const) {
    const item = binding(version);
    await prisma.workbenchArtifactVersionRecord.create({
      data: {
        id: item.versionId,
        taskId: item.taskId,
        runId: item.runId,
        artifactId: item.artifactId,
        version,
        schemaVersion: "cmooc.workbench.artifact-version.v1",
        artifactKind: "reply_draft",
        contentClass: "restricted_transient",
        contentHash: item.contentHash,
        draftBodyHash: item.draftBodyHash,
        safeSummary: `safe version ${version}`,
        metadataJson: "{}",
        sourceRefsJson: "[]",
        regenerationRecipeJson: "{}",
        createdAt: new Date(T0.getTime() + version * 1_000)
      }
    });
    await prisma.workbenchVerificationRecord.create({
      data: {
        id: `verification-version-${version}`,
        taskId: item.taskId,
        runId: item.runId,
        subjectType: "artifact_version",
        subjectId: item.versionId,
        verifier: "verification.reply_draft",
        verifierVersion: "1",
        status: "passed",
        safeSummary: "安全校验通过。",
        checksJson: "[]",
        evidenceRefsJson: "[]",
        observedAt: new Date(T0.getTime() + version * 1_000),
        containsForumText: false,
        containsIdentity: false
      }
    });
  }
});

after(async () => {
  await prisma.$disconnect();
  rmSync(root, { recursive: true, force: true });
});

test("selection initializes v1, advances by CAS, and rejects stale/cross-run/tampered refs", async () => {
  const first = await selectArtifactVersion(prisma, {
    ...binding(1),
    verificationId: "verification-version-1",
    expected: null,
    selectedAt: new Date(T0.getTime() + 2_000)
  });
  assert.equal(first.generation, 1);

  const second = await selectArtifactVersion(prisma, {
    ...binding(2),
    verificationId: "verification-version-2",
    expected: { generation: first.generation, selectionHash: first.selectionHash },
    selectedAt: new Date(T0.getTime() + 3_000)
  });
  assert.equal(second.generation, 2);
  const resolveAt = new Date(T0.getTime() + 3_500);
  assert.equal(
    await resolveSelectedArtifactVersion(prisma, { ...binding(1), now: resolveAt }),
    null
  );
  assert.equal(
    (await resolveSelectedArtifactVersion(prisma, {
      ...binding(2),
      now: resolveAt
    }))?.versionRef,
    binding(2).versionRef
  );
  assert.equal(
    await resolveSelectedArtifactVersion(prisma, {
      ...binding(2),
      runId: RUN_1,
      now: resolveAt
    }),
    null
  );
  assert.equal(
    await resolveSelectedArtifactVersion(prisma, {
      ...binding(2),
      contentHash: sha("tampered-ref"),
      now: resolveAt
    }),
    null
  );
  await assert.rejects(
    selectArtifactVersion(prisma, {
      ...binding(3),
      verificationId: "verification-version-3",
      expected: { generation: first.generation, selectionHash: first.selectionHash },
      selectedAt: new Date(T0.getTime() + 4_000)
    }),
    (error: unknown) =>
      error instanceof WorkbenchArtifactSelectionError &&
      error.code === "WORKBENCH_ARTIFACT_SELECTION_CONFLICT"
  );
});
