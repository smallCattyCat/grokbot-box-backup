import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const prismaDirectory = path.resolve(process.cwd(), "prisma");
const testDatabasePath = path.resolve(prismaDirectory, "test.db");

if (path.dirname(testDatabasePath) !== prismaDirectory || path.basename(testDatabasePath) !== "test.db") {
  throw new Error(`拒绝清理非固定测试库：${testDatabasePath}`);
}

for (const suffix of ["", "-journal", "-shm", "-wal"]) {
  const target = `${testDatabasePath}${suffix}`;
  if (existsSync(target)) unlinkSync(target);
}

const env = {
  ...process.env,
  NODE_ENV: "test" as const,
  DATABASE_URL: "file:./test.db"
};

function runNodeCli(moduleId: string, args: string[]) {
  const cli = require.resolve(moduleId);
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    env,
    stdio: "inherit"
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

runNodeCli("prisma/build/index.js", ["migrate", "deploy"]);
runNodeCli("tsx/cli", ["scripts/seed-database.ts", "fixture"]);

console.log(`测试数据库已重建：${testDatabasePath}`);
