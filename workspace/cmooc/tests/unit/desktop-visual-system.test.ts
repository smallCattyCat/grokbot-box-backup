import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const globalsCss = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
const commandShellSource = readFileSync(
  new URL("../../components/ui/command-shell.tsx", import.meta.url),
  "utf8"
);
const subnavSource = readFileSync(
  new URL("../../components/AutonomySubnav.tsx", import.meta.url),
  "utf8"
);
const rootLayoutSource = readFileSync(
  new URL("../../app/layout.tsx", import.meta.url),
  "utf8"
);
const workbenchCss = readFileSync(
  new URL("../../components/workbench/Workbench.module.css", import.meta.url),
  "utf8"
);
const workbenchSource = readFileSync(
  new URL("../../components/workbench/AgentWorkbench.tsx", import.meta.url),
  "utf8"
);
const worldExplorerSource = readFileSync(
  new URL("../../components/autonomy/world-graph-explorer.tsx", import.meta.url),
  "utf8"
);
const worldPageSource = readFileSync(
  new URL("../../app/autonomy/world/page.tsx", import.meta.url),
  "utf8"
);
const decisionsPageSource = readFileSync(
  new URL("../../app/autonomy/decisions/page.tsx", import.meta.url),
  "utf8"
);
const runPageSource = readFileSync(
  new URL("../../app/autonomy/runs/[id]/page.tsx", import.meta.url),
  "utf8"
);
const runPresentationSource = readFileSync(
  new URL(
    "../../lib/autonomy/run-operator-presentation.ts",
    import.meta.url
  ),
  "utf8"
);
const globalLoadingSource = readFileSync(
  new URL("../../app/loading.tsx", import.meta.url),
  "utf8"
);
const worldLoadingSource = readFileSync(
  new URL("../../app/autonomy/world/loading.tsx", import.meta.url),
  "utf8"
);
const decisionsLoadingSource = readFileSync(
  new URL("../../app/autonomy/decisions/loading.tsx", import.meta.url),
  "utf8"
);
const runLoadingSource = readFileSync(
  new URL("../../app/autonomy/runs/[id]/loading.tsx", import.meta.url),
  "utf8"
);
const governancePageSource = readFileSync(
  new URL("../../app/autonomy/governance/page.tsx", import.meta.url),
  "utf8"
);

test("desktop palette keeps the observatory identity with calmer education-facing semantics", () => {
  assert.match(globalsCss, /--surface-0:\s*#0b0f12;/);
  assert.match(globalsCss, /--surface-1:\s*#11181c;/);
  assert.match(globalsCss, /--surface-2:\s*#172126;/);
  assert.match(globalsCss, /--text-dim:\s*#a3adb0;/);
  assert.match(globalsCss, /--accent-cyan:\s*#50b7d3;/);
  assert.match(globalsCss, /--accent-green:\s*#54d39a;/);
  assert.match(workbenchCss, /--canvas:\s*#0b0f12;/);
  assert.match(workbenchCss, /--info:\s*#50b7d3;/);
  assert.match(workbenchCss, /--success:\s*#54d39a;/);
});

test("desktop shell removes duplicated product navigation and returns height to content", () => {
  assert.match(globalsCss, /\.command-shell\s*\{\s*padding:\s*clamp\(1rem,\s*1\.8vw,\s*1\.5rem\);/);
  assert.match(commandShellSource, /flex flex-col gap-4 xl:flex-row/);
  assert.doesNotMatch(subnavSource, /\["\/workbench"/);
  assert.doesNotMatch(subnavSource, /\["\/autonomy\/world"/);
  assert.match(subnavSource, /pathname\.startsWith\("\/autonomy\/policy"\)/);
  assert.match(subnavSource, /pathname\.startsWith\("\/autonomy\/governance"\)/);
  assert.match(subnavSource, /if \(!governanceContext\) return null;/);
  assert.match(subnavSource, /aria-label="治理视图"/);
});

test("workbench reserves green for verified outcomes and raises desktop metadata readability", () => {
  assert.match(workbenchSource, /snapshot\?\.source === "demo" \? "muted" : "cyan"/);
  assert.match(workbenchSource, /data-mode=\{snapshot\?\.source === "demo" \? "demo" : "governed"\}/);
  assert.match(workbenchCss, /\.systemBar \.modeFact\[data-mode="demo"\]\s*\{\s*color:\s*var\(--muted\);/);
  assert.match(workbenchCss, /\.systemBar \.liveFact\s*\{\s*color:\s*var\(--info\);/);
  assert.match(
    workbenchCss,
    /\/\* Desktop legibility floor[\s\S]*?@media \(min-width:\s*901px\)[\s\S]*?\.consoleWorkspace \.conversationHeader > div:first-child > span\s*\{\s*font-size:\s*0\.75rem;/
  );
  assert.match(workbenchCss, /\.answerSources small\s*\{\s*font-size:\s*0\.75rem;/);
  assert.match(
    workbenchCss,
    /\.messageByline time,[\s\S]*?\.answerStatus,[\s\S]*?\.executionDetails > summary,[\s\S]*?\.sideEyebrow,[\s\S]*?\.sideCount,[\s\S]*?\.avatar span,[\s\S]*?\.sideEmpty[\s\S]*?font-size:\s*0\.75rem;/
  );
});

test("world controls avoid ten-pixel interface text while graph labels remain compact", () => {
  assert.doesNotMatch(worldExplorerSource, /text-\[10px\]/);
  assert.doesNotMatch(worldPageSource, /text-\[10px\]/);
  assert.match(worldExplorerSource, /fontSize="11"/);
});

test("world and run records lead with compact operational facts instead of product promotion", () => {
  assert.match(commandShellSource, /variant\?:\s*"default"\s*\|\s*"operational"/);
  assert.match(commandShellSource, /data-variant=\{variant\}/);
  assert.match(
    globalsCss,
    /\.command-shell\[data-variant="operational"\]\s*\{[\s\S]*?box-shadow:\s*none;/
  );
  assert.match(
    globalsCss,
    /\.command-shell\[data-variant="operational"\]\s+h1\s*\{[\s\S]*?font-size:\s*clamp\(1\.2rem,[\s\S]*?1\.45rem\);/
  );

  assert.match(worldPageSource, /testId="world-masthead"/);
  assert.match(worldPageSource, /variant="operational"/);
  assert.match(worldPageSource, /title="事件参与者网络"/);
  assert.match(worldPageSource, /课程绑定/);
  assert.match(worldPageSource, /观察截至/);
  assert.doesNotMatch(
    worldPageSource,
    /学习者社会网络|控制台任务不再挤占这里的空间|覆盖状态已记录/
  );

  assert.match(decisionsPageSource, /variant="operational"/);
  assert.match(decisionsPageSource, /title="运行记录"/);
  assert.match(decisionsPageSource, /运行模式/);
  assert.match(decisionsPageSource, /打开运行详情/);
  assert.doesNotMatch(
    decisionsPageSource,
    /不保存论坛正文|决定带只追加|人类互动优先/
  );

  assert.match(runPageSource, /variant="operational"/);
  assert.match(runPageSource, /title="运行详情"/);
  assert.match(runPageSource, /返回运行记录/);
  assert.match(runPageSource, /打开异常总览/);
  assert.match(runPageSource, /invocation\.courseAlias/);
  assert.match(
    runPresentationSource,
    /operation_governance_resolved:\s*"运行治理边界"/
  );
  assert.match(
    runPresentationSource,
    /target_revalidated:\s*"目标写前重读"/
  );
  assert.doesNotMatch(runPageSource, /title="运行证据"|返回课程全景/);
  assert.match(
    rootLayoutSource,
    /href:\s*"\/autonomy\/decisions"[\s\S]*?matchPrefixes:\s*\["\/autonomy\/runs"\]/
  );
});

test("operational routes own compact loading shells without changing unrelated pages", () => {
  assert.match(globalLoadingSource, /command-shell min-h-48 animate-pulse/);
  assert.match(worldLoadingSource, /OperationalPageLoading variant="world"/);
  assert.match(decisionsLoadingSource, /OperationalPageLoading variant="records"/);
  assert.match(runLoadingSource, /OperationalPageLoading variant="run"/);
});

test("governance keeps audit hashes available without making them primary content", () => {
  assert.match(
    governancePageSource,
    /<details[\s\S]*?<summary[^>]*>核查信息<\/summary>/
  );
  assert.match(governancePageSource, /治理链\s*\{compactHash\(row\.governanceHash\)\}/);
  assert.match(governancePageSource, /Manifest\s*\{compactHash\(row\.baseManifestHash\)\}/);
});
