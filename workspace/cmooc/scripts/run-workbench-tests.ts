import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const testFiles = [
  "tests/unit/agent-client-session.test.ts",
  "tests/unit/agent-command-planner.test.ts",
  "tests/unit/agent-page-bridge.test.ts",
  "tests/unit/platform-page-actions.test.ts",
  "tests/unit/workbench-page-actions.test.ts",
  "tests/unit/workbench-context.test.ts",
  "tests/unit/workbench-contracts.test.ts",
  "tests/unit/course-opportunity-brief.test.ts",
  "tests/unit/course-evidence-workspace.test.ts",
  "tests/unit/course-evidence-tools.test.ts",
  "tests/unit/course-operations-tools.test.ts",
  "tests/unit/course-tool-contracts.test.ts",
  "tests/unit/course-tool-registry.test.ts",
  "tests/unit/course-tool-policy-gateway.test.ts",
  "tests/unit/course-tool-verifier-registry.test.ts",
  "tests/unit/course-tool-executor.test.ts",
  "tests/unit/course-tool-ledger-sink.test.ts",
  "tests/unit/course-tools-platform-stage.test.ts",
  "tests/unit/course-tool-facilitation-artifacts.test.ts",
  "tests/unit/protected-artifact-store.test.ts",
  "tests/unit/protected-artifact-preview-controller.test.ts",
  "tests/unit/protected-draft-correction-controller.test.ts",
  "tests/unit/artifact-workspace-read-model.test.ts",
  "tests/unit/artifact-selection-store.test.ts",
  "tests/unit/workbench-protected-material-vault.test.ts",
  "tests/unit/stage-companion-v3.test.ts",
  "tests/unit/workbench-trusted-stage-adapter.test.ts",
  "tests/unit/workbench-stage-target-resolver-v2.test.ts",
  "tests/unit/prisma-workbench-stage-transaction-store.test.ts",
  "tests/unit/course-tool-action-store.test.ts",
  "tests/unit/workbench-durable-ledger.test.ts",
  "tests/unit/workbench-course-agent-plan.test.ts",
  "tests/unit/workbench-course-agent-mvp-planner.test.ts",
  "tests/unit/workbench-course-agent-task-family.test.ts",
  "tests/unit/workbench-course-agent-runtime.test.ts",
  "tests/unit/workbench-course-agent-artifact-runtime.test.ts",
  "tests/unit/course-agent-checkpoint-read-model.test.ts",
  "tests/unit/course-agent-checkpoint-hydrator.test.ts",
  "tests/unit/workbench-course-agent-toolkit.test.ts",
  "tests/unit/workbench-course-agent-toolkit-bootstrap.test.ts",
  "tests/unit/workbench-trusted-stage-providers.test.ts",
  "tests/unit/workbench-course-agent-action-execution.test.ts",
  "tests/unit/workbench-course-agent-stage-resume.test.ts",
  "tests/unit/workbench-research-export.test.ts",
  "tests/unit/workbench-evidence-workspace-ui.test.ts",
  "tests/unit/workbench-evidence-route.test.ts",
  "tests/unit/workbench-research-export-route.test.ts",
  "tests/unit/workbench-evidence-read-model.test.ts",
  "tests/unit/workbench-anchored-brief-read-model.test.ts",
  "tests/unit/workbench-brief-route.test.ts",
  "tests/unit/workbench-course-opportunity-brief.test.ts",
  "tests/unit/workbench-idle-home.test.ts",
  "tests/unit/workbench-layout-contract.test.ts",
  "tests/unit/desktop-visual-system.test.ts",
  "tests/unit/workbench-session-workspace.test.ts",
  "tests/unit/workbench-test-runner.test.ts",
  "tests/unit/workbench-world-actions.test.ts",
  "tests/unit/workbench-presentation.test.ts",
  "tests/unit/scenario-lab-runtime.test.ts",
  "tests/unit/scenario-lab-evidence.test.ts",
  "tests/unit/scenario-lab-route.test.ts",
  "tests/unit/scenario-lab-ui.test.ts",
  "tests/unit/scenario-lab-oasis-sidecar-transport.test.ts",
  "tests/unit/scenario-lab-oasis-preview-service.test.ts",
  "tests/unit/scenario-lab-oasis-preview-route.test.ts",
  "tests/unit/scenario-lab-oasis-preview-ui.test.ts",
  "tests/unit/workbench-run-store.test.ts",
  "tests/unit/workbench-codex-app-server.test.ts",
  "tests/unit/workbench-operator-network.test.ts",
  "tests/unit/workbench-operator-locator.test.ts",
  "tests/unit/workbench-operator-schedule.test.ts",
  "tests/unit/autonomy-read-model.test.ts",
  "tests/unit/autonomy-operator-identity-sync.test.ts",
  "tests/unit/world-operator-presentation.test.ts",
  "tests/integration/workbench-routes.test.ts",
  "tests/integration/workbench-action-decision-route.test.ts",
  "tests/integration/workbench-durable-ledger.test.ts",
  "tests/integration/course-tool-action-grant.test.ts",
  "tests/integration/workbench-artifact-workspace-routes.test.ts",
  "tests/integration/artifact-selection-store.test.ts",
  "tests/integration/workbench-stage-transaction-store.test.ts",
  "tests/integration/workbench-zero-publish-stage-e2e.test.ts",
  "tests/integration/course-agent-checkpoint-read-model.test.ts",
  "tests/unit/workbench-artifact-workspace-ui.test.ts",
  "tests/integration/workbench-course-agent-one-sentence-e2e.test.ts",
  "tests/integration/workbench-course-agent-task-family-e2e.test.ts"
] as const;

const testRoot = mkdtempSync(path.join(tmpdir(), "cmooc-workbench-tests-"));
const databasePath = path.join(testRoot, "workbench.db").replace(/\\/g, "/");
const databaseUrl = `file:${databasePath}`;
const env = {
  ...process.env,
  NODE_ENV: "test" as const,
  DATABASE_URL: databaseUrl,
  CMOOC_USE_CONFIGURED_TEST_DATABASE: "1",
  CMOOC_DISABLE_WINDOWS_ENV_FALLBACK: "1"
};

function run(moduleId: string, args: readonly string[]): number {
  const result = spawnSync(process.execPath, [require.resolve(moduleId), ...args], {
    cwd: process.cwd(),
    env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

let exitCode = 1;
try {
  const migrationExit = run("prisma/build/index.js", ["migrate", "deploy"]);
  if (migrationExit !== 0) {
    exitCode = migrationExit;
  } else {
    exitCode = run("tsx/cli", [
      "--test",
      "--test-concurrency=1",
      ...testFiles
    ]);
  }
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}

process.exit(exitCode);
