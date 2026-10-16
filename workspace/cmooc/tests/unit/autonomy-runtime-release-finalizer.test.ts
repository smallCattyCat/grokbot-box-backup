import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AUTONOMY_RELEASE_MANIFEST_SCHEMA_VERSION,
  AUTONOMY_RELEASE_RECEIPT_SCHEMA_VERSION
} from "../../scripts/build-autonomy-release";
import {
  AUTONOMY_RUNTIME_RELEASE_RECEIPT_SCHEMA_VERSION,
  AutonomyRuntimeReleaseFinalizeError,
  finalizeAutonomyRuntimeRelease
} from "../../scripts/finalize-autonomy-runtime-release";

const RUNTIME_VERSION = "v1-rc13";

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => compareText(a, b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function createPreparedRelease(t: test.TestContext): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "cmooc-runtime-release-"));
  t.after(async () => {
    await rm(parent, { force: true, recursive: true });
  });
  const root = path.join(parent, `${RUNTIME_VERSION}-release`);
  await mkdir(root);

  const scripts = Object.fromEntries(
    [
      "build",
      "start",
      "prisma:migrate",
      "autonomy:tick",
      "autonomy:worker",
      "autonomy:soak-readiness",
      "autonomy:release",
      "autonomy:release:finalize",
      "autonomy:governance",
      "autonomy:graph-status",
      "autonomy:l3"
    ].map((command) => [command, `echo ${command}`])
  );
  const sourceFiles: Record<string, string> = {
    "package.json": `${JSON.stringify({ name: "runtime-fixture", scripts })}\n`,
    "package-lock.json": `${JSON.stringify({ lockfileVersion: 3 })}\n`,
    "lib/forum/real-write-lock.ts": "export const REAL_FORUM_WRITE_LOCKED = true;\n",
    "lib/autonomy/course-manifest.ts": "export type Manifest = { realPublishEnabled: false };\n",
    "prisma/migrations/migration_lock.toml": "provider = \"sqlite\"\n",
    "prisma/migrations/20260823000000_runtime/migration.sql": "SELECT 1;\n"
  };
  await writeTree(root, sourceFiles);

  const files = Object.entries(sourceFiles)
    .map(([filePath, content]) => ({
      path: filePath,
      sha256: sha256(content),
      sizeBytes: Buffer.byteLength(content)
    }))
    .sort((left, right) => compareText(left.path, right.path));
  const manifest = {
    schemaVersion: AUTONOMY_RELEASE_MANIFEST_SCHEMA_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    files,
    aggregateSha256: sha256(
      files.map((file) => `${file.path}\0${file.sizeBytes}\0${file.sha256}\n`).join("")
    )
  };
  const receiptPayload = {
    schemaVersion: AUTONOMY_RELEASE_RECEIPT_SCHEMA_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    mode: "apply",
    status: "created",
    targetDirectoryName: `${RUNTIME_VERSION}-release`,
    fileCount: files.length,
    contentBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    manifestSha256: sha256(stableJson(manifest)),
    dependencies: {
      included: false,
      installed: false,
      lockfileIncluded: true
    },
    environment: { included: false, injected: false },
    runtimeReady: false,
    blockers: [
      "dependencies_not_installed",
      "runtime_environment_not_injected",
      "production_build_not_created",
      "package_script_surface_not_projected",
      "filesystem_no_replace_not_guaranteed"
    ],
    packageScripts: {
      projected: false,
      guaranteedCommands: Object.keys(scripts)
    },
    promotion: {
      strategy: "atomic_directory_rename",
      builderConcurrencyLock: true,
      filesystemNoReplaceGuaranteed: false
    },
    safety: {
      allowlistOnly: true,
      hardExclusions: [],
      nodeModulesCopied: false,
      testsCopied: false,
      targetOverwriteAttempted: false,
      automationModified: false,
      externalMutationAttempted: false
    }
  };
  await writeTree(root, {
    "manifest.json": `${stableJson(manifest)}\n`,
    "receipt.json": `${stableJson({
      ...receiptPayload,
      receiptSha256: sha256(stableJson(receiptPayload))
    })}\n`,
    ".env.local": [
      "DATABASE_URL=file:C:/runtime/dev.db",
      `CMOOC_COURSE_MANIFEST_DIR=${root.replace(/\\/gu, "/")}`,
      "CMOOC_DISABLE_WINDOWS_ENV_FALLBACK=1",
      ""
    ].join("\n"),
    ".next/BUILD_ID": "runtime-build\n",
    ".next/required-server-files.json": "{}\n",
    ".next/server/app-paths-manifest.json": "{}\n",
    ".next/server/middleware-manifest.json": "{}\n",
    "playwright/auth-state.json": "{}\n"
  });
  for (const packageName of [
    "@prisma/client",
    "next",
    "prisma",
    "react",
    "react-dom",
    "tsx"
  ]) {
    await mkdir(path.join(root, "node_modules", ...packageName.split("/")), {
      recursive: true
    });
  }
  return root;
}

test("finalizer promotes only a fully prepared self-contained runtime", async (t) => {
  const releaseDirectory = await createPreparedRelease(t);
  const result = await finalizeAutonomyRuntimeRelease({
    releaseDirectory,
    runtimeVersion: RUNTIME_VERSION,
    now: new Date("2026-08-23T20:00:00.000Z")
  });

  assert.equal(result.schemaVersion, AUTONOMY_RUNTIME_RELEASE_RECEIPT_SCHEMA_VERSION);
  assert.equal(result.runtimeReady, true);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.dependencies.selfContained, true);
  assert.equal(result.environment.credentialKeysPresent, false);
  assert.equal(result.browserSession.storageStatePresent, true);
  assert.equal(result.browserSession.storageStateLinked, false);
  assert.equal(result.browserSession.storageStateContentInspected, false);
  assert.equal(result.productionBuild.created, true);
  assert.equal(result.database.migrationCount, 1);
  assert.equal(result.safety.realForumWriteHardLockVerified, true);
  assert.equal(result.safety.externalMutationAttempted, false);
  assert.match(result.receiptSha256, /^[a-f0-9]{64}$/u);

  const persisted = JSON.parse(
    await readFile(path.join(releaseDirectory, "runtime-receipt.json"), "utf8")
  ) as typeof result;
  assert.deepEqual(persisted, result);
  await assert.rejects(
    finalizeAutonomyRuntimeRelease({
      releaseDirectory,
      runtimeVersion: RUNTIME_VERSION
    }),
    (error: unknown) =>
      error instanceof AutonomyRuntimeReleaseFinalizeError &&
      error.code === "receipt_exists"
  );
});

test("finalizer rejects source drift before writing a ready receipt", async (t) => {
  const releaseDirectory = await createPreparedRelease(t);
  await writeFile(
    path.join(releaseDirectory, "lib", "forum", "real-write-lock.ts"),
    "export const REAL_FORUM_WRITE_LOCKED = false;\n"
  );

  await assert.rejects(
    finalizeAutonomyRuntimeRelease({
      releaseDirectory,
      runtimeVersion: RUNTIME_VERSION
    }),
    (error: unknown) =>
      error instanceof AutonomyRuntimeReleaseFinalizeError &&
      error.code === "source_drift"
  );
});

test("finalizer rejects credential-bearing environment keys", async (t) => {
  const releaseDirectory = await createPreparedRelease(t);
  await writeFile(
    path.join(releaseDirectory, ".env.local"),
    [
      "DATABASE_URL=file:C:/runtime/dev.db",
      `CMOOC_COURSE_MANIFEST_DIR=${releaseDirectory.replace(/\\/gu, "/")}`,
      "CMOOC_DISABLE_WINDOWS_ENV_FALLBACK=1",
      "API_TOKEN=forbidden",
      ""
    ].join("\n")
  );

  await assert.rejects(
    finalizeAutonomyRuntimeRelease({
      releaseDirectory,
      runtimeVersion: RUNTIME_VERSION
    }),
    (error: unknown) =>
      error instanceof AutonomyRuntimeReleaseFinalizeError &&
      error.code === "environment_invalid"
  );
});

test("finalizer rejects a runtime without injected browser session state", async (t) => {
  const releaseDirectory = await createPreparedRelease(t);
  await rm(path.join(releaseDirectory, "playwright", "auth-state.json"));

  await assert.rejects(
    finalizeAutonomyRuntimeRelease({
      releaseDirectory,
      runtimeVersion: RUNTIME_VERSION
    }),
    (error: unknown) =>
      error instanceof AutonomyRuntimeReleaseFinalizeError &&
      error.code === "environment_invalid"
  );
});
