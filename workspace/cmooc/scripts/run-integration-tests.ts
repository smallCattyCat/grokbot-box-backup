import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const integrationFiles = [
  "tests/integration/course-operation-governance.test.ts",
  "tests/integration/database-baseline.test.ts",
  "tests/integration/profile-boundaries.test.ts",
  "tests/integration/context-snapshot-boundaries.test.ts",
  "tests/integration/autonomy-portable-v2-tick.test.ts",
  "tests/integration/autonomy-shadow-tick.test.ts",
  "tests/integration/course-content-graph-persistence.test.ts",
  "tests/integration/autonomy-execution-permit.test.ts",
  "tests/integration/autonomy-production-execution.test.ts",
  "tests/integration/autonomy-outcome-unknown-transition.test.ts",
  "tests/integration/autonomy-stage-receipt-hardening.test.ts",
  "tests/integration/autonomy-one-shot-relock-hardening.test.ts",
  "tests/integration/stage-run-nonce-registry.test.ts",
  "tests/integration/autonomy-runtime-outcome.test.ts",
  "tests/integration/autonomy-runtime-health-governance.test.ts",
  "tests/integration/autonomy-governance-cli.test.ts",
  "tests/integration/autonomy-worker-cli.test.ts",
  "tests/integration/autonomy-worker-wake-receipt.test.ts",
  "tests/integration/autonomy-execution-account-pool.test.ts",
  "tests/integration/course-agent-checkpoint-read-model.test.ts",
  "tests/integration/course-agent-checkpoint-hydrator.test.ts"
] as const;

const result = spawnSync(
  process.execPath,
  [
    require.resolve("tsx/cli"),
    "--test",
    "--test-concurrency=1",
    ...integrationFiles
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: "file:./test.db",
      CMOOC_DISABLE_WINDOWS_ENV_FALLBACK: "1"
    },
    stdio: "inherit"
  }
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
