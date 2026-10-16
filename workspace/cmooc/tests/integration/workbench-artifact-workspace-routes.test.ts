import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { GET as GET_WORKSPACE } from "../../app/api/workbench/runs/[id]/artifacts/route";
import { GET as GET_VERSION } from "../../app/api/workbench/runs/[id]/artifacts/[versionId]/route";
import { POST as POST_PREVIEW } from "../../app/api/workbench/runs/[id]/artifacts/[versionId]/preview/route";
import { POST as POST_CORRECTION } from "../../app/api/workbench/runs/[id]/artifacts/[versionId]/corrections/route";
import { POST as POST_DIFF } from "../../app/api/workbench/runs/[id]/artifacts/diff/route";
import { prisma } from "../../lib/db";
import { hashTransientDraftBody } from "../../lib/live-runtime/draft-content";
import { InMemoryProtectedArtifactStore } from "../../lib/workbench/protected-artifact-store";
import { selectArtifactVersion } from "../../lib/workbench/artifact-selection-store";
import {
  bindProtectedArtifactPreview,
  resetProtectedArtifactPreviewControllerForTests
} from "../../lib/workbench/protected-artifact-preview-controller";

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function trustedPost(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      Host: "localhost:3000",
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
      "Sec-Fetch-Site": "same-origin"
    },
    body: JSON.stringify(body)
  });
}

type VersionFixture = Readonly<{
  versionId: string;
  version: number;
  versionRef: string;
  contentHash: string;
  draftBodyHash: string;
  body: string;
  protectedRef: string;
  protectedExpiresAt: string;
}>;

async function createRouteFixture() {
  const suffix = randomUUID();
  const taskId = `artifact-route-task-${suffix}`;
  const runId = suffix;
  const artifactId = `artifact-route-${suffix}`;
  const now = new Date();
  await prisma.workbenchTask.create({
    data: {
      id: taskId,
      title: "Artifact workspace route fixture",
      status: "running",
      createdAt: now
    }
  });
  await prisma.workbenchRunRecord.create({
    data: {
      id: runId,
      taskId,
      schemaVersion: "workbench-run-v1",
      source: "app-server",
      status: "running",
      projectLabel: "Course workbench",
      snapshotJson: "{}",
      createdAt: now,
      updatedAt: now
    }
  });
  const store = new InMemoryProtectedArtifactStore();
  const versions: VersionFixture[] = [];
  for (const [index, body] of [
    "课程支持草稿\n旧版建议",
    "课程支持草稿\n新版建议"
  ].entries()) {
    const version = index + 1;
    const versionId = `artifact-route-version-${version}-${suffix}`;
    const versionRef = `artifact-version:${versionId}`;
    const contentHash = sha(`projection:${versionRef}:${body}`);
    const draftBodyHash = hashTransientDraftBody(body);
    const protectedExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const handle = await store.put({
      taskId,
      runId,
      callId: `artifact-route-call-${version}-${suffix}`,
      idempotencyKey: `artifact-route-key-${version}-${suffix}`,
      body,
      draftBodyHash,
      storedAt: now.toISOString(),
      expiresAt: protectedExpiresAt
    });
    await prisma.workbenchArtifactVersionRecord.create({
      data: {
        id: versionId,
        taskId,
        runId,
        artifactId,
        version,
        schemaVersion: "cmooc.workbench.artifact-version.v1",
        artifactKind: "facilitation_reply_draft",
        contentClass: "restricted_transient",
        contentHash,
        draftBodyHash,
        contentRef: null,
        safeSummary: `Restricted draft version ${version}.`,
        metadataJson: '{"privateSentinel":"metadata-must-not-return"}',
        sourceRefsJson: "[]",
        regenerationRecipeJson:
          '{"privateSentinel":"recipe-must-not-return"}',
        createdByCallId: null,
        expiresAt: new Date(now.getTime() + 10 * 60_000),
        createdAt: new Date(now.getTime() + index)
      }
    });
    await prisma.workbenchVerificationRecord.create({
      data: {
        id: `artifact-route-verification-${version}-${suffix}`,
        taskId,
        runId,
        subjectType: "artifact_version",
        subjectId: versionId,
        verifier: "artifact.reply_draft.verify",
        verifierVersion: "1",
        status: "passed",
        safeSummary: "Transient body hash and boundary passed.",
        checksJson: "[]",
        evidenceRefsJson: "[]",
        observedAt: new Date(now.getTime() + index),
        expiresAt: new Date(now.getTime() + 10 * 60_000),
        containsForumText: false,
        containsIdentity: false
      }
    });
    bindProtectedArtifactPreview({
      taskId,
      runId,
      versionRef,
      contentHash,
      draftBodyHash,
      protectedRef: handle.ref,
      protectedStore: store,
      protectedExpiresAt,
      now
    });
    versions.push({
      versionId,
      version,
      versionRef,
      contentHash,
      draftBodyHash,
      body,
      protectedRef: handle.ref,
      protectedExpiresAt
    });
  }
  const firstSelection = await selectArtifactVersion(prisma, {
    taskId,
    runId,
    artifactId,
    versionId: versions[0]!.versionId,
    versionRef: versions[0]!.versionRef,
    contentHash: versions[0]!.contentHash,
    draftBodyHash: versions[0]!.draftBodyHash,
    verificationId: `artifact-route-verification-1-${suffix}`,
    expected: null,
    selectedAt: new Date(now.getTime() + 2)
  });
  await selectArtifactVersion(prisma, {
    taskId,
    runId,
    artifactId,
    versionId: versions[1]!.versionId,
    versionRef: versions[1]!.versionRef,
    contentHash: versions[1]!.contentHash,
    draftBodyHash: versions[1]!.draftBodyHash,
    verificationId: `artifact-route-verification-2-${suffix}`,
    expected: {
      generation: firstSelection.generation,
      selectionHash: firstSelection.selectionHash
    },
    selectedAt: new Date(now.getTime() + 3)
  });
  return { taskId, runId, artifactId, now, store, versions };
}

function rebind(
  fixture: Awaited<ReturnType<typeof createRouteFixture>>,
  version: VersionFixture
) {
  bindProtectedArtifactPreview({
    taskId: fixture.taskId,
    runId: fixture.runId,
    versionRef: version.versionRef,
    contentHash: version.contentHash,
    draftBodyHash: version.draftBodyHash,
    protectedRef: version.protectedRef,
    protectedStore: fixture.store,
    protectedExpiresAt: version.protectedExpiresAt,
    now: new Date()
  });
}

beforeEach(() => resetProtectedArtifactPreviewControllerForTests());

test("artifact read routes expose exact safe projections but never durable private fields", async () => {
  const fixture = await createRouteFixture();
  const list = await GET_WORKSPACE(
    new Request(`http://localhost:3000/api/workbench/runs/${fixture.runId}/artifacts`),
    { params: { id: fixture.runId } }
  );
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "no-store");
  const listText = await list.text();
  assert.equal(listText.includes("metadata-must-not-return"), false);
  assert.equal(listText.includes("recipe-must-not-return"), false);
  assert.equal(listText.includes("protected-draft:"), false);
  assert.equal(listText.includes(fixture.versions[0]!.body), false);
  const listJson = JSON.parse(listText) as {
    versions: Array<{ versionId: string; verification: { status: string } }>;
  };
  assert.equal(listJson.versions.length, 2);
  assert.equal(listJson.versions[0]!.verification.status, "passed");

  const version = fixture.versions[0]!;
  const detail = await GET_VERSION(
    new Request(
      `http://localhost:3000/api/workbench/runs/${fixture.runId}/artifacts/${version.versionId}`
    ),
    { params: { id: fixture.runId, versionId: version.versionId } }
  );
  assert.equal(detail.status, 200);
  const detailText = await detail.text();
  assert.equal(detailText.includes("metadata-must-not-return"), false);
  assert.equal(detailText.includes("recipe-must-not-return"), false);
  assert.equal(detailText.includes("protected-draft:"), false);
});

test("preview body appears only in one same-origin POST response and then requires regeneration", async () => {
  const fixture = await createRouteFixture();
  const version = fixture.versions[0]!;
  const url = `http://localhost:3000/api/workbench/runs/${fixture.runId}/artifacts/${version.versionId}/preview`;
  const body = {
    expectedContentHash: version.contentHash,
    expectedDraftBodyHash: version.draftBodyHash
  };
  const first = await POST_PREVIEW(trustedPost(url, body), {
    params: { id: fixture.runId, versionId: version.versionId }
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const firstText = await first.text();
  assert.equal(firstText.includes(version.protectedRef), false);
  const firstJson = JSON.parse(firstText) as { preview: { body: string } };
  assert.equal(firstJson.preview.body, version.body);

  const second = await POST_PREVIEW(trustedPost(url, body), {
    params: { id: fixture.runId, versionId: version.versionId }
  });
  assert.equal(second.status, 409);
  const secondJson = (await second.json()) as {
    code: string;
    recovery: { action: string; bodyPersisted: boolean };
  };
  assert.equal(secondJson.code, "WORKBENCH_ARTIFACT_REGENERATE_REQUIRED");
  assert.equal(secondJson.recovery.action, "regenerate_or_reenter");
  assert.equal(secondJson.recovery.bodyPersisted, false);
});

test("correction route is closed, same-origin and requires an exact preview edit session", async () => {
  const fixture = await createRouteFixture();
  const version = fixture.versions[1]!;
  const url = `http://localhost:3000/api/workbench/runs/${fixture.runId}/artifacts/${version.versionId}/corrections`;
  const payload = {
    expectedContentHash: version.contentHash,
    expectedDraftBodyHash: version.draftBodyHash,
    correctedBody: "课程支持草稿\n受保护修订"
  };
  const crossOrigin = await POST_CORRECTION(
    new NextRequest(url, {
      method: "POST",
      headers: {
        Host: "localhost:3000",
        "Content-Type": "application/json",
        Origin: "https://attacker.invalid"
      },
      body: JSON.stringify(payload)
    }),
    { params: { id: fixture.runId, versionId: version.versionId } }
  );
  assert.equal(crossOrigin.status, 403);

  const missingSession = await POST_CORRECTION(trustedPost(url, payload), {
    params: { id: fixture.runId, versionId: version.versionId }
  });
  assert.equal(missingSession.status, 409);
  assert.equal(missingSession.headers.get("cache-control"), "no-store");
  const text = await missingSession.text();
  assert.equal(text.includes(payload.correctedBody), false);
  assert.equal(text.includes(version.protectedRef), false);
  assert.equal(
    (JSON.parse(text) as { reason: string }).reason,
    "preview_or_edit_session_missing"
  );
});

test("diff is in-memory, same-run, no-store and consumes both body bindings", async () => {
  const fixture = await createRouteFixture();
  const [from, to] = fixture.versions as [VersionFixture, VersionFixture];
  const url = `http://localhost:3000/api/workbench/runs/${fixture.runId}/artifacts/diff`;
  const requestBody = {
    fromVersionId: from.versionId,
    toVersionId: to.versionId,
    expectedFromContentHash: from.contentHash,
    expectedToContentHash: to.contentHash
  };
  const first = await POST_DIFF(trustedPost(url, requestBody), {
    params: { id: fixture.runId }
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const firstText = await first.text();
  assert.equal(firstText.includes("protected-draft:"), false);
  const firstJson = JSON.parse(firstText) as {
    diff: { operations: Array<{ kind: "equal" | "remove" | "add"; text: string }> };
  };
  assert.equal(
    firstJson.diff.operations
      .filter((operation) => operation.kind !== "add")
      .map((operation) => operation.text)
      .join(""),
    from.body
  );
  assert.equal(
    firstJson.diff.operations
      .filter((operation) => operation.kind !== "remove")
      .map((operation) => operation.text)
      .join(""),
    to.body
  );

  const second = await POST_DIFF(trustedPost(url, requestBody), {
    params: { id: fixture.runId }
  });
  assert.equal(second.status, 409);
  assert.equal(
    ((await second.json()) as { code: string }).code,
    "WORKBENCH_ARTIFACT_DIFF_REGENERATE_REQUIRED"
  );
});

test("missing process binding and cross-run version lookup fail closed", async () => {
  const fixture = await createRouteFixture();
  const version = fixture.versions[0]!;
  resetProtectedArtifactPreviewControllerForTests();
  const preview = await POST_PREVIEW(
    trustedPost(
      `http://localhost:3000/api/workbench/runs/${fixture.runId}/artifacts/${version.versionId}/preview`,
      {
        expectedContentHash: version.contentHash,
        expectedDraftBodyHash: version.draftBodyHash
      }
    ),
    { params: { id: fixture.runId, versionId: version.versionId } }
  );
  assert.equal(preview.status, 409);
  assert.equal(
    ((await preview.json()) as { reason: string }).reason,
    "binding_missing_or_process_restarted"
  );

  const otherRunId = randomUUID();
  await prisma.workbenchRunRecord.create({
    data: {
      id: otherRunId,
      taskId: fixture.taskId,
      schemaVersion: "workbench-run-v1",
      source: "app-server",
      status: "running",
      projectLabel: "Other run",
      snapshotJson: "{}",
      createdAt: new Date(),
      updatedAt: new Date()
    }
  });
  const crossScope = await GET_VERSION(
    new Request(
      `http://localhost:3000/api/workbench/runs/${otherRunId}/artifacts/${version.versionId}`
    ),
    { params: { id: otherRunId, versionId: version.versionId } }
  );
  assert.equal(crossScope.status, 404);
  assert.equal(
    ((await crossScope.json()) as { code: string }).code,
    "WORKBENCH_ARTIFACT_NOT_FOUND"
  );

  // The helper is deliberately used only to keep TypeScript checking the
  // trusted rebinding surface; it never exposes a protected ref to a route.
  rebind(fixture, version);
});
