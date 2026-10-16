import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

function normalizedPath(value: string) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function assertFixtureDatabaseIsIsolated() {
  const prismaDirectory = path.resolve(process.cwd(), "prisma");
  const testDatabase = path.join(prismaDirectory, "test.db");
  const developmentDatabase = path.join(prismaDirectory, "dev.db");

  if (!existsSync(testDatabase) || !existsSync(developmentDatabase)) return;

  const sameCanonicalPath = normalizedPath(realpathSync(testDatabase)) === normalizedPath(realpathSync(developmentDatabase));
  const testStat = statSync(testDatabase, { bigint: true });
  const developmentStat = statSync(developmentDatabase, { bigint: true });
  const sameFileIdentity = testStat.ino !== 0n
    && testStat.dev === developmentStat.dev
    && testStat.ino === developmentStat.ino;

  if (sameCanonicalPath || sameFileIdentity) {
    throw new Error("拒绝写入：prisma/test.db 与 prisma/dev.db 指向同一文件。");
  }
}

async function main() {
  const mode = process.argv[2];

  if (mode === "fixture") {
    assertFixtureDatabaseIsIsolated();
    process.env.DATABASE_URL = "file:./test.db";
    process.env.CMOOC_SEED_MODE = "fixture";
  } else if (mode === "demo") {
    process.env.DATABASE_URL ||= "file:./dev.db";
    process.env.CMOOC_SEED_MODE = "demo";
  } else {
    throw new Error("用法：tsx scripts/seed-database.ts <fixture|demo>");
  }

  const { seedDatabase } = await import("../prisma/seed");
  await seedDatabase();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
