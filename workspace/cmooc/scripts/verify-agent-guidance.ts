import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const repositoryRoot = process.cwd();
const agentsPath = path.join(repositoryRoot, "AGENTS.md");
const policyPath = path.join(repositoryRoot, "docs", "AGENT_DECISION_POLICY.md");
const productCurrentPath = path.join(repositoryRoot, "docs", "PRODUCT_CURRENT.md");
const masterPlanPath = path.join(
  repositoryRoot,
  "docs",
  "AUTONOMOUS_PRODUCT_MASTER_PLAN.md"
);
const packagePath = path.join(repositoryRoot, "package.json");

const agents = readFileSync(agentsPath, "utf8");
const policy = readFileSync(policyPath, "utf8");
const productCurrent = readFileSync(productCurrentPath, "utf8");
const masterPlan = readFileSync(masterPlanPath, "utf8");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
  scripts?: Record<string, string>;
};
const scripts = packageJson.scripts ?? {};
const guidance = `${agents}\n${policy}`;

function sourceFilesUnder(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFilesUnder(entryPath));
    } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

assert.ok(
  Buffer.byteLength(agents, "utf8") <= 8_000,
  "AGENTS.md must stay concise enough to leave working context for the task"
);

for (const requiredBoundary of [
  "01_原始数据",
  "%LOCALAPPDATA%\\cmooc-research",
  "annotate --authorize",
  "realPublishEnabled=false",
  "as-of",
  "2024",
  "2025",
  "AGENT_DECISION_POLICY.md"
]) {
  assert.ok(
    agents.includes(requiredBoundary),
    `AGENTS.md must retain project boundary: ${requiredBoundary}`
  );
}

for (const obsoleteGuidance of [
  "npm run scan",
  "npm run analyze",
  "优先保证 demo 可运行",
  "所有智能体输出必须保存到数据库",
  "浏览器自动化优先对本地 mock 论坛生效"
]) {
  assert.equal(
    guidance.includes(obsoleteGuidance),
    false,
    `obsolete agent guidance must not return: ${obsoleteGuidance}`
  );
}

const referencedScripts = new Set(
  Array.from(guidance.matchAll(/\bnpm run ([a-zA-Z0-9:._-]+)/g), (match) => match[1])
);
for (const script of referencedScripts) {
  assert.ok(scripts[script], `agent guidance references missing npm script: ${script}`);
}

for (const decisionMarker of ["**Proceed**", "**Ask**", "永不绕过", "防止流程膨胀"]) {
  assert.ok(
    policy.includes(decisionMarker),
    `agent decision policy must retain section or marker: ${decisionMarker}`
  );
}

for (const autonomyMarker of [
  "PRODUCT_CURRENT.md",
  "AUTONOMOUS_PRODUCT_MASTER_PLAN.md",
  "CourseManifest",
  "AutonomyPolicy",
  "Decision Tape"
]) {
  assert.ok(
    guidance.includes(autonomyMarker),
    `agent guidance must retain autonomous product marker: ${autonomyMarker}`
  );
}

const nextVerticalSlices = [
  ...productCurrent.matchAll(/任务 ID：`([A-Z0-9-]+)`/g)
].map((match) => match[1]);
assert.deepEqual(
  nextVerticalSlices,
  ["AUTONOMY-V1-RC13-QUALIFIED-AUTOMATION-AND-LONG-SOAK"],
  "PRODUCT_CURRENT.md must name exactly one current autonomous vertical slice"
);
for (const mode of ["`OBSERVE`", "`SHADOW`", "`STAGE`", "`AUTO`", "`HALTED`"]) {
  assert.ok(
    masterPlan.includes(mode),
    `autonomous product master plan must retain operating mode: ${mode}`
  );
}

// The low-level persistence primitive intentionally remains importable by
// focused tests, but production code must go through guarded root issuance or
// the lifecycle service so it cannot create an unlinked governance root.
const directGovernancePersistenceSymbol =
  "createCourseOperationGovernancePolicy";
const allowedProductionPersistenceFiles = new Set([
  path.join("lib", "autonomy", "course-operation-governance.ts"),
  path.join("lib", "autonomy", "course-operation-governance-lifecycle.ts"),
  path.join("scripts", "verify-agent-guidance.ts")
]);
for (const rootName of ["app", "lib", "scripts"]) {
  for (const sourcePath of sourceFilesUnder(
    path.join(repositoryRoot, rootName)
  )) {
    const relativePath = path.relative(repositoryRoot, sourcePath);
    if (
      readFileSync(sourcePath, "utf8").includes(
        directGovernancePersistenceSymbol
      )
    ) {
      assert.ok(
        allowedProductionPersistenceFiles.has(relativePath),
        `production governance persistence bypass detected: ${relativePath}`
      );
    }
  }
}

console.log(
  `agent guidance verified (${Buffer.byteLength(agents, "utf8")} bytes, ` +
    `${referencedScripts.size} npm scripts checked)`
);
