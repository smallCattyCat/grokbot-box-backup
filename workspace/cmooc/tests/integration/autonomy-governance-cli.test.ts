import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { loadCourseManifest } from "../../lib/autonomy/course-manifest";

process.env.DATABASE_URL = "file:./test.db";
process.env.CMOOC_DISABLE_WINDOWS_ENV_FALLBACK = "1";

const require = createRequire(import.meta.url);
const COURSE_ALIAS = "governance-cli-fixture";
const COURSE_ID = "12345678";

function isolatedTestEnv(
  manifestRoot: string,
  databaseUrl = "file:./test.db"
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // node --test propagates NODE_TEST_CONTEXT into spawned CLIs. Explicitly
    // opt this fixture into its disposable configured database so env.ts does
    // not safely redirect the child process back to prisma/test.db.
    NODE_ENV: databaseUrl === "file:./test.db" ? "test" : "development",
    DATABASE_URL: databaseUrl,
    CMOOC_USE_CONFIGURED_TEST_DATABASE: "1",
    CMOOC_DISABLE_WINDOWS_ENV_FALLBACK: "1",
    CMOOC_COURSE_MANIFEST_DIR: manifestRoot
  };
  for (const name of [
    "CMOOC_SATOKEN",
    "CMOOC_PARTNER_ACCOUNT",
    "CMOOC_PARTNER_PASSWORD",
    "CMOOC_PARTNER_ACCOUNTS"
  ]) {
    delete env[name];
  }
  return env;
}

function runCli(
  manifestRoot: string,
  args: string[],
  databaseUrl = "file:./test.db"
) {
  return spawnSync(
    process.execPath,
    [require.resolve("tsx/cli"), "scripts/autonomy-governance.ts", ...args],
    {
      cwd: process.cwd(),
      env: isolatedTestEnv(manifestRoot, databaseUrl),
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true
    }
  );
}

function migrateIsolatedDatabase(
  manifestRoot: string,
  databaseUrl: string
): void {
  const result = spawnSync(
    process.execPath,
    [
      require.resolve("prisma/build/index.js"),
      "migrate",
      "deploy",
      "--schema",
      "prisma/schema.prisma"
    ],
    {
      cwd: process.cwd(),
      env: isolatedTestEnv(manifestRoot, databaseUrl),
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
}

test("governance CLI previews by default and applies one immutable baseline only explicitly", async () => {
  const manifestRoot = await mkdtemp(path.join(tmpdir(), "cmooc-governance-cli-"));
  const databaseUrl = `file:${path
    .join(manifestRoot, "governance-cli.db")
    .replaceAll("\\", "/")}`;
  const version = `governance.cli.${Date.now().toString(36)}`;
  const manifestPath = path.join(manifestRoot, `${COURSE_ALIAS}-course.json`);
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: "cmooc.course-manifest.v1",
      alias: COURSE_ALIAS,
      platformId: "cmooc.bnu",
      courseId: COURSE_ID,
      canonicalUrl: `https://example.test/course?courseId=${COURSE_ID}&isBack=1`,
      allowedOrigins: ["https://example.test"],
      adapterId: "governance.cli.fixture",
      timeZone: "UTC",
      defaultMode: "SHADOW",
      policyVersion: "governance.cli.fixture.v1",
      scan: {
        maxThreadsPerTick: 5,
        maxCommentsPerThread: 5,
        pageSize: 5
      },
      budget: { dailySlots: 2, workloadCost: 1, authorTouchLimit30d: 1 },
      schedule: { intervalMinutes: 30, leaseSeconds: 30 },
      realPublishEnabled: false
    }),
    "utf8"
  );

  migrateIsolatedDatabase(manifestRoot, databaseUrl);
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } }
  });
  try {
    const manifest = await loadCourseManifest(COURSE_ALIAS, { manifestRoot });
    const args = [
      "baseline",
      "--course",
      COURSE_ALIAS,
      "--version",
      version,
      "--valid-from",
      "2026-08-01T00:00:00.000Z",
      "--valid-until",
      "2027-08-01T00:00:00.000Z",
      "--expected-manifest-hash",
      manifest.manifestHash
    ];

    const preview = runCli(manifestRoot, args, databaseUrl);
    assert.equal(preview.error, undefined);
    assert.equal(preview.signal, null);
    assert.equal(preview.status, 0, preview.stderr);
    const previewJson = JSON.parse(preview.stdout.trim()) as Record<string, unknown>;
    assert.equal(previewJson.ok, true);
    assert.equal(previewJson.applied, false);
    assert.equal(previewJson.externalMutationAttempted, false);
    assert.equal(previewJson.containsForumText, false);
    assert.equal(
      await prisma.courseOperationGovernancePolicy.count({
        where: { courseAlias: COURSE_ALIAS, version }
      }),
      0
    );

    const applied = runCli(manifestRoot, [...args, "--apply"], databaseUrl);
    assert.equal(applied.error, undefined);
    assert.equal(applied.signal, null);
    assert.equal(applied.status, 0, applied.stderr);
    const appliedJson = JSON.parse(applied.stdout.trim()) as Record<string, unknown>;
    assert.equal(appliedJson.ok, true);
    assert.equal(appliedJson.applied, true);
    assert.equal(
      appliedJson.externalMutationAttempted,
      false,
      "本地治理 DB append 不是论坛外部 mutation"
    );
    assert.equal(appliedJson.containsForumText, false);
    assert.equal(
      await prisma.courseOperationGovernancePolicy.count({
        where: { courseAlias: COURSE_ALIAS, version }
      }),
      1
    );

    const repeated = runCli(manifestRoot, [...args, "--apply"], databaseUrl);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(
      await prisma.courseOperationGovernancePolicy.count({
        where: { courseAlias: COURSE_ALIAS, version }
      }),
      1
    );

    const secondRootPreview = runCli(
      manifestRoot,
      [
        ...args.map((value) =>
          value === version ? `${version}.second-root` : value
        )
      ],
      databaseUrl
    );
    assert.equal(secondRootPreview.status, 1);
    const secondRootPayload = JSON.parse(
      secondRootPreview.stderr.trim()
    ) as Record<string, unknown>;
    assert.equal(secondRootPayload.code, "autonomy_governance_baseline_failed");
    assert.equal(secondRootPayload.externalMutationAttempted, false);
    assert.equal(secondRootPayload.containsForumText, false);
    assert.equal(
      await prisma.courseOperationGovernancePolicy.count({
        where: { courseAlias: COURSE_ALIAS }
      }),
      1
    );

    const baselinePolicy = appliedJson.policy as {
      governanceHash: string;
    };
    const pauseArgs = [
      "pause",
      "--course",
      COURSE_ALIAS,
      "--version",
      `${version}.pause`,
      "--transition-key",
      `${version}-pause`,
      "--reason-code",
      "operator_policy_change",
      "--effective-at",
      "2026-08-02T12:00:00.000Z",
      "--expected-manifest-hash",
      manifest.manifestHash,
      "--expected-governance-hash",
      baselinePolicy.governanceHash
    ];
    const pausePreview = runCli(manifestRoot, pauseArgs, databaseUrl);
    assert.equal(pausePreview.status, 0, pausePreview.stderr);
    const pausePreviewJson = JSON.parse(pausePreview.stdout.trim()) as Record<
      string,
      unknown
    >;
    assert.equal(pausePreviewJson.operation, "pause");
    assert.equal(pausePreviewJson.applied, false);
    assert.equal(pausePreviewJson.externalMutationAttempted, false);
    assert.equal(
      await prisma.courseOperationGovernanceTransition.count({
        where: { courseAlias: COURSE_ALIAS }
      }),
      0
    );

    const pauseApplied = runCli(
      manifestRoot,
      [...pauseArgs, "--apply"],
      databaseUrl
    );
    assert.equal(pauseApplied.status, 0, pauseApplied.stderr);
    const pauseAppliedJson = JSON.parse(pauseApplied.stdout.trim()) as Record<
      string,
      unknown
    >;
    assert.equal(pauseAppliedJson.applied, true);
    assert.equal(pauseAppliedJson.externalMutationAttempted, false);
    assert.equal(pauseAppliedJson.containsForumText, false);
    assert.equal(
      await prisma.courseOperationGovernanceTransition.count({
        where: { courseAlias: COURSE_ALIAS }
      }),
      1
    );
    const pauseRepeated = runCli(
      manifestRoot,
      [...pauseArgs, "--apply"],
      databaseUrl
    );
    assert.equal(pauseRepeated.status, 0, pauseRepeated.stderr);
    assert.equal(
      await prisma.courseOperationGovernanceTransition.count({
        where: { courseAlias: COURSE_ALIAS }
      }),
      1
    );

    const serialized = `${preview.stdout}${applied.stdout}${repeated.stdout}${secondRootPreview.stderr}${pausePreview.stdout}${pauseApplied.stdout}${pauseRepeated.stdout}`;
    assert.doesNotMatch(serialized, new RegExp(COURSE_ID));
    assert.doesNotMatch(serialized, /canonicalUrl|sourcePath|https?:\/\//i);
  } finally {
    await prisma.$disconnect();
    await rm(manifestRoot, { recursive: true, force: true });
  }
});

test("governance CLI rejects a manifest hash mismatch with generic safe JSON", async () => {
  const manifestRoot = await mkdtemp(path.join(tmpdir(), "cmooc-governance-cli-invalid-"));
  try {
    const result = runCli(manifestRoot, [
      "baseline",
      "--course",
      COURSE_ALIAS,
      "--version",
      "governance.cli.invalid",
      "--valid-from",
      "2026-08-01T00:00:00.000Z",
      "--valid-until",
      "2027-08-01T00:00:00.000Z",
      "--expected-manifest-hash",
      "0".repeat(64)
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const serialized = result.stderr.trim();
    const payload = JSON.parse(serialized) as Record<string, unknown>;
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "autonomy_governance_baseline_failed");
    assert.equal(payload.externalMutationAttempted, false);
    assert.equal(payload.containsForumText, false);
    assert.doesNotMatch(serialized, /courseId|canonicalUrl|sourcePath|https?:\/\//i);
  } finally {
    await rm(manifestRoot, { recursive: true, force: true });
  }
});
