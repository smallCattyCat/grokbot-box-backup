import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AutonomyReleaseBuildError,
  buildAutonomyRelease
} from "../../scripts/build-autonomy-release";

const REQUIRED_FIXTURE_FILES: Record<string, string> = {
  "package.json": "{\"name\":\"release-fixture\"}\n",
  "package-lock.json": "{\"lockfileVersion\":3}\n",
  "next.config.mjs": "export default {};\n",
  "next-env.d.ts": "/// <reference types=\"next\" />\n",
  "tsconfig.json": "{}\n",
  "tailwind.config.ts": "export default {};\n",
  "postcss.config.mjs": "export default {};\n",
  "middleware.ts": "export function middleware() {}\n",
  "fixtures/p4d1/golden-path-resource-connection-v1.json": "{\"version\":\"fixture\"}\n",
  "fixtures/p4f-lite/fidelity-rubric-v1.json": "{\"version\":\"fixture\"}\n",
  "prisma/schema.prisma": "generator client { provider = \"prisma-client-js\" }\n",
  "prisma/migrations/migration_lock.toml": "provider = \"sqlite\"\n",
  "prisma/migrations/20260823000000_runtime/migration.sql": "SELECT 1;\n",
  "configs/courses/bnu-test-course.template.json": "{\"enabled\":false}\n",
  "scripts/autonomy-tick.ts": "export {};\n",
  "scripts/autonomy-worker.ts": "export {};\n",
  "scripts/autonomy-soak-readiness.ts": "export {};\n",
  "scripts/autonomy-governance.ts": "export {};\n",
  "scripts/autonomy-l3.ts": "export {};\n",
  "scripts/course-graph-status.ts": "export {};\n",
  "scripts/prisma-migrate-safe.ts": "export {};\n",
  "scripts/scenario_lab_oasis_sidecar.py": "def main():\n    return 0\n",
  "scripts/build-autonomy-release.ts": "export {};\n",
  "scripts/finalize-autonomy-runtime-release.ts": "export {};\n",
  "app/page.tsx": "export default function Page() { return null; }\n",
  "app/globals.css": "body {}\n",
  "components/runtime-card.tsx": "export function RuntimeCard() { return null; }\n",
  "lib/autonomy/runtime.ts": "export const runtime = true;\n"
};

const SENSITIVE_FIXTURE_FILES: Record<string, string> = {
  ".env": "API_KEY=do-not-copy\n",
  ".env.local": "TOKEN=do-not-copy\n",
  "app/.env.production": "SECRET=do-not-copy\n",
  "app/.next/types/runtime.ts": "export {};\n",
  "app/node_modules/pkg/index.ts": "export {};\n",
  "app/operator.spec.ts": "export {};\n",
  "app/tests/runtime.test.ts": "export {};\n",
  "app/wake.test.ts": "export {};\n",
  "components/artifacts/private.tsx": "export default null;\n",
  "lib/api-key.json": "{\"value\":\"private\"}\n",
  "lib/auth/session.ts": "export const cookie = 'private';\n",
  "lib/auth-state-prod.json": "{\"state\":\"private\"}\n",
  "lib/credentials.json": "{\"token\":\"private\"}\n",
  "lib/logs/runtime.ts": "export const log = 'private';\n",
  "lib/runtime.db": "private database\n",
  "lib/runtime.log": "private log\n",
  "lib/secrets-prod.json": "{\"secret\":\"private\"}\n",
  "lib/session.json": "{\"session\":\"private\"}\n",
  "lib/tokens.json": "{\"token\":\"private\"}\n",
  "tests/unit/should-not-copy.ts": "export {};\n",
  "artifacts/should-not-copy.json": "{}\n",
  "node_modules/pkg/index.js": "module.exports = {};\n"
};

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function createFixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cmooc-release-builder-"));
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  await writeTree(root, REQUIRED_FIXTURE_FILES);
  await writeTree(root, SENSITIVE_FIXTURE_FILES);
  return root;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

test("release builder defaults to a non-writing dry run with honest blockers", async (t) => {
  const projectRoot = await createFixture(t);
  const releaseRoot = path.join(projectRoot, "release-output");

  const result = await buildAutonomyRelease({ projectRoot, releaseRoot });

  assert.equal(result.receipt.runtimeVersion, "v1-rc13");
  assert.equal(result.receipt.targetDirectoryName, "v1-rc13-release");
  assert.equal(result.receipt.mode, "dry_run");
  assert.equal(result.receipt.status, "planned");
  assert.equal(result.receipt.runtimeReady, false);
  assert.deepEqual(result.receipt.blockers, [
    "dependencies_not_installed",
    "runtime_environment_not_injected",
    "production_build_not_created",
    "package_script_surface_not_projected",
    "filesystem_no_replace_not_guaranteed"
  ]);
  assert.equal(result.receipt.packageScripts.projected, false);
  assert.equal(result.receipt.promotion.builderConcurrencyLock, true);
  assert.equal(result.receipt.promotion.filesystemNoReplaceGuaranteed, false);
  assert.equal(result.receipt.dependencies.included, false);
  assert.equal(result.receipt.environment.included, false);
  assert.equal(result.receipt.safety.automationModified, false);
  assert.equal(result.receipt.safety.externalMutationAttempted, false);
  assert.equal(await exists(releaseRoot), false);
  assert.match(result.receipt.manifestSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.receipt.receiptSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(result.manifest), new RegExp(projectRoot.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"));
  assert.doesNotMatch(JSON.stringify(result.receipt), new RegExp(projectRoot.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"));
});

test("apply copies only allowlisted non-sensitive runtime files and refuses overwrite", async (t) => {
  const projectRoot = await createFixture(t);
  const releaseRoot = path.join(projectRoot, "release-output");
  const result = await buildAutonomyRelease({
    apply: true,
    projectRoot,
    releaseRoot,
    runtimeVersion: "v1-rc13"
  });

  assert.equal(result.receipt.status, "created");
  assert.equal(await exists(path.join(result.targetDirectory, "app", "page.tsx")), true);
  assert.equal(
    await exists(
      path.join(
        result.targetDirectory,
        "fixtures",
        "p4d1",
        "golden-path-resource-connection-v1.json"
      )
    ),
    true
  );
  assert.equal(await exists(path.join(result.targetDirectory, "prisma", "schema.prisma")), true);
  assert.equal(
    await exists(
      path.join(result.targetDirectory, "scripts", "scenario_lab_oasis_sidecar.py")
    ),
    true
  );
  assert.equal(await exists(path.join(result.targetDirectory, "manifest.json")), true);
  assert.equal(await exists(path.join(result.targetDirectory, "receipt.json")), true);

  for (const relativePath of Object.keys(SENSITIVE_FIXTURE_FILES)) {
    assert.equal(
      await exists(path.join(result.targetDirectory, ...relativePath.split("/"))),
      false,
      `sensitive path was copied: ${relativePath}`
    );
  }

  const manifestOnDisk = JSON.parse(
    await readFile(path.join(result.targetDirectory, "manifest.json"), "utf8")
  ) as typeof result.manifest;
  const receiptOnDisk = JSON.parse(
    await readFile(path.join(result.targetDirectory, "receipt.json"), "utf8")
  ) as typeof result.receipt;
  assert.deepEqual(manifestOnDisk, result.manifest);
  assert.deepEqual(receiptOnDisk, result.receipt);
  assert.equal(manifestOnDisk.files.some((file) => file.path.includes("\\")), false);

  await assert.rejects(
    buildAutonomyRelease({
      apply: true,
      projectRoot,
      releaseRoot,
      runtimeVersion: "v1-rc13"
    }),
    (error: unknown) =>
      error instanceof AutonomyReleaseBuildError && error.code === "target_exists"
  );
});

test("manifest and receipt hashes are stable for identical content", async (t) => {
  const projectRoot = await createFixture(t);
  const first = await buildAutonomyRelease({
    projectRoot,
    releaseRoot: path.join(projectRoot, "release-a")
  });
  const second = await buildAutonomyRelease({
    projectRoot,
    releaseRoot: path.join(projectRoot, "release-b")
  });

  assert.equal(first.manifest.aggregateSha256, second.manifest.aggregateSha256);
  assert.equal(first.receipt.manifestSha256, second.receipt.manifestSha256);
  assert.equal(first.receipt.receiptSha256, second.receipt.receiptSha256);

  await writeFile(path.join(projectRoot, "lib", "autonomy", "runtime.ts"), "export const runtime = false;\n");
  const changed = await buildAutonomyRelease({
    projectRoot,
    releaseRoot: path.join(projectRoot, "release-c")
  });
  assert.notEqual(changed.manifest.aggregateSha256, first.manifest.aggregateSha256);
  assert.notEqual(changed.receipt.manifestSha256, first.receipt.manifestSha256);
});

test("invalid versions fail closed and apply cleans a failed staging directory", async (t) => {
  const projectRoot = await createFixture(t);
  const releaseRoot = path.join(projectRoot, "release-output");

  await assert.rejects(
    buildAutonomyRelease({
      projectRoot,
      releaseRoot,
      runtimeVersion: "../../overwrite"
    }),
    (error: unknown) =>
      error instanceof AutonomyReleaseBuildError &&
      error.code === "invalid_runtime_version"
  );

  await assert.rejects(
    buildAutonomyRelease({
      apply: true,
      projectRoot,
      releaseRoot,
      testFault: "before_promote",
      runtimeVersion: "v1-rc14"
    }),
    /injected promotion failure/u
  );
  assert.equal(await exists(path.join(releaseRoot, "v1-rc14-release")), false);
  assert.deepEqual(await readdir(releaseRoot), []);
});

test("release builder rejects an output root that traverses a link", async (t) => {
  const projectRoot = await createFixture(t);
  const realOutputRoot = path.join(projectRoot, "real-output");
  const linkedOutputRoot = path.join(projectRoot, "linked-output");
  await mkdir(realOutputRoot, { recursive: true });
  try {
    await symlink(
      realOutputRoot,
      linkedOutputRoot,
      process.platform === "win32" ? "junction" : "dir"
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("directory links require privileges on this platform");
      return;
    }
    throw error;
  }

  await assert.rejects(
    buildAutonomyRelease({
      projectRoot,
      releaseRoot: linkedOutputRoot
    }),
    (error: unknown) =>
      error instanceof AutonomyReleaseBuildError &&
      error.code === "unsafe_output_root"
  );
});
