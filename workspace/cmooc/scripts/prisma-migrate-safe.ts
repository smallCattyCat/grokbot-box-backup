import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

const require = createRequire(import.meta.url);
const schemaPath = path.join("prisma", "schema.prisma");

function runPrisma(args: string[]): void {
  const result = spawnSync(
    process.execPath,
    [require.resolve("prisma/build/index.js"), ...args],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    }
  );
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) {
    throw new Error("PRISMA_CHILD_PROCESS_FAILED");
  }
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL_REQUIRED");

  // Migrations run in a disposable child process. If SQLite aborts while a
  // migration has foreign_keys disabled, that connection is destroyed before
  // this verifier opens a new one.
  runPrisma(["migrate", "deploy", "--schema", schemaPath]);
  runPrisma(["generate", "--schema", schemaPath]);

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const foreignKeys = await prisma.$queryRawUnsafe<
      Array<{ foreign_keys: number | bigint }>
    >("PRAGMA foreign_keys");
    assert.equal(Number(foreignKeys[0]?.foreign_keys), 1, "FOREIGN_KEYS_OFF");

    const foreignKeyViolations = await prisma.$queryRawUnsafe<
      Array<Record<string, unknown>>
    >("PRAGMA foreign_key_check");
    assert.equal(
      foreignKeyViolations.length,
      0,
      "FOREIGN_KEY_CHECK_FAILED"
    );

    const integrity = await prisma.$queryRawUnsafe<
      Array<{ integrity_check: string }>
    >("PRAGMA integrity_check");
    assert.deepEqual(
      integrity.map((row) => row.integrity_check),
      ["ok"],
      "INTEGRITY_CHECK_FAILED"
    );

    const expectedMigrations = readdirSync(
      path.join(process.cwd(), "prisma", "migrations"),
      { withFileTypes: true }
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const appliedMigrations = await prisma.$queryRawUnsafe<
      Array<{ migration_name: string }>
    >(
      'SELECT "migration_name" FROM "_prisma_migrations" ' +
        'WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL'
    );
    assert.deepEqual(
      appliedMigrations.map((row) => row.migration_name).sort(),
      expectedMigrations,
      "MIGRATION_SET_MISMATCH"
    );

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        migrationCount: expectedMigrations.length,
        foreignKeys: true,
        foreignKeyViolations: 0,
        integrity: "ok",
        containsForumText: false
      })}\n`
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch(() => {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      code: "prisma_migrate_safe_failed",
      containsForumText: false
    })}\n`
  );
  process.exitCode = 1;
});
