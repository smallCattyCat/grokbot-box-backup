import { spawnSync } from "node:child_process";

const checks = [
  { label: "agent guidance invariants", args: ["run", "verify:agent-guidance"] },
  { label: "operator contract invariants", args: ["exec", "tsx", "scripts/verify-operator-contract.ts"] },
  { label: "TypeScript", args: ["run", "type-check"] },
  { label: "ESLint", args: ["run", "lint"] },
  { label: "unit and database integration tests", args: ["test"] }
] as const;

function runNpm(args: readonly string[]) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return spawnSync(process.execPath, [npmCli, ...args], {
      stdio: "inherit",
      env: process.env
    });
  }

  return spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", [...args], {
    stdio: "inherit",
    env: process.env
  });
}

for (const check of checks) {
  console.log(`\n[verify] ${check.label}`);
  const result = runNpm(check.args);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\nAll verification checks passed.");
