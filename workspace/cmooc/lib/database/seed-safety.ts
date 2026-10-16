export const DEMO_RESET_CONFIRMATION = "RESET_CMOOC_DEMO_DATABASE";

export type SeedMode = "fixture" | "demo";

type SeedEnvironment = Readonly<Record<string, string | undefined>>;

function normalizeDatabaseUrl(value: string | undefined) {
  return (value ?? "").trim().replace(/\\/g, "/");
}

export function assertSeedTarget(env: SeedEnvironment = process.env): void {
  const databaseUrl = normalizeDatabaseUrl(env.DATABASE_URL);
  const mode = env.CMOOC_SEED_MODE;

  if (mode === "fixture") {
    if (databaseUrl === "file:./test.db") return;
    throw new Error("拒绝写入非固定测试库；fixture seed 只允许 DATABASE_URL=file:./test.db。");
  }

  if (mode === "demo") {
    if (databaseUrl !== "file:./dev.db") {
      throw new Error("拒绝写入非固定开发库；demo seed 只允许 DATABASE_URL=file:./dev.db。");
    }
    if (env.CMOOC_ALLOW_DEMO_RESET === DEMO_RESET_CONFIRMATION) return;
    throw new Error(
      `拒绝重置开发数据库。若确实要重建 demo，请显式设置 CMOOC_ALLOW_DEMO_RESET=${DEMO_RESET_CONFIRMATION}。`
    );
  }

  throw new Error("拒绝直接运行 seed。测试数据请使用 npm run seed:fixture。");
}
