import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as { scripts?: Record<string, string> };
const runnerUrl = new URL(
  "../../scripts/run-workbench-tests.ts",
  import.meta.url
);
const runnerSource = existsSync(runnerUrl)
  ? readFileSync(runnerUrl, "utf8")
  : "";

test("test:workbench uses a disposable test database instead of the development history", () => {
  assert.equal(
    packageJson.scripts?.["test:workbench"],
    "tsx scripts/run-workbench-tests.ts"
  );
  assert.match(runnerSource, /mkdtempSync\(/);
  assert.match(runnerSource, /NODE_ENV:\s*"test"/);
  assert.match(runnerSource, /DATABASE_URL:\s*databaseUrl/);
  assert.match(runnerSource, /CMOOC_USE_CONFIGURED_TEST_DATABASE:\s*"1"/);
  assert.match(runnerSource, /prisma\/build\/index\.js/);
  assert.match(runnerSource, /rmSync\([^,]+,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/);
  assert.doesNotMatch(runnerSource, /dev\.db/);
});

test("test:workbench includes the Slice 2 evidence and privacy contract suites", () => {
  for (const testFile of [
    "tests/unit/course-evidence-workspace.test.ts",
    "tests/unit/workbench-research-export.test.ts",
    "tests/unit/workbench-evidence-workspace-ui.test.ts",
    "tests/unit/workbench-evidence-route.test.ts",
    "tests/unit/workbench-research-export-route.test.ts",
    "tests/unit/workbench-evidence-read-model.test.ts"
  ]) {
    assert.match(runnerSource, new RegExp(testFile.replaceAll(".", "\\.")));
  }
});

test("test:workbench includes the durable Course Agent approval and execution chain", () => {
  for (const testFile of [
    "tests/unit/course-evidence-tools.test.ts",
    "tests/unit/course-operations-tools.test.ts",
    "tests/unit/course-tool-facilitation-artifacts.test.ts",
    "tests/unit/workbench-course-agent-mvp-planner.test.ts",
    "tests/unit/workbench-course-agent-task-family.test.ts",
    "tests/unit/course-tool-action-store.test.ts",
    "tests/unit/workbench-course-agent-artifact-runtime.test.ts",
    "tests/unit/course-agent-checkpoint-read-model.test.ts",
    "tests/unit/course-agent-checkpoint-hydrator.test.ts",
    "tests/unit/workbench-course-agent-toolkit.test.ts",
    "tests/unit/workbench-course-agent-toolkit-bootstrap.test.ts",
    "tests/unit/workbench-trusted-stage-providers.test.ts",
    "tests/unit/workbench-course-agent-action-execution.test.ts",
    "tests/integration/workbench-action-decision-route.test.ts",
    "tests/integration/course-tool-action-grant.test.ts"
  ]) {
    assert.match(runnerSource, new RegExp(testFile.replaceAll(".", "\\.")));
  }
});

test("test:workbench includes trusted STAGE recovery and Artifact Workspace boundaries", () => {
  for (const testFile of [
    "tests/unit/workbench-protected-material-vault.test.ts",
    "tests/unit/stage-companion-v3.test.ts",
    "tests/unit/workbench-trusted-stage-adapter.test.ts",
    "tests/unit/prisma-workbench-stage-transaction-store.test.ts",
    "tests/unit/protected-artifact-preview-controller.test.ts",
    "tests/unit/artifact-workspace-read-model.test.ts",
    "tests/integration/workbench-artifact-workspace-routes.test.ts",
    "tests/integration/workbench-stage-transaction-store.test.ts",
    "tests/integration/course-agent-checkpoint-read-model.test.ts",
    "tests/integration/workbench-zero-publish-stage-e2e.test.ts",
    "tests/unit/workbench-artifact-workspace-ui.test.ts"
  ]) {
    assert.match(runnerSource, new RegExp(testFile.replaceAll(".", "\\.")));
  }
});

test("test:workbench includes the operator identity synchronization contract", () => {
  assert.match(
    runnerSource,
    /tests\/unit\/autonomy-operator-identity-sync\.test\.ts/u
  );
});
