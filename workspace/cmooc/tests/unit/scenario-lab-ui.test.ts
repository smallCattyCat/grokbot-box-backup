import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const componentSource = readFileSync(
  new URL(
    "../../components/scenario-lab/CourseWorldScenarioLab.tsx",
    import.meta.url
  ),
  "utf8"
);
const cssSource = readFileSync(
  new URL(
    "../../components/scenario-lab/CourseWorldScenarioLab.module.css",
    import.meta.url
  ),
  "utf8"
);
const pageSource = readFileSync(
  new URL("../../app/scenario-lab/page.tsx", import.meta.url),
  "utf8"
);
const layoutSource = readFileSync(
  new URL("../../app/layout.tsx", import.meta.url),
  "utf8"
);
const subnavSource = readFileSync(
  new URL("../../components/AutonomySubnav.tsx", import.meta.url),
  "utf8"
);

test("Scenario Lab 是独立可发现的产品工作面", () => {
  assert.doesNotMatch(layoutSource, /href: "\/scenario-lab", label: "情景实验"/u);
  assert.match(subnavSource, /\["\/scenario-lab",\s*"研究实验"\]/u);
  assert.match(pageSource, /<CourseWorldScenarioLab \/>/u);
  assert.match(pageSource, /export const dynamic = "force-dynamic"/u);
  assert.doesNotMatch(componentSource, /<main\b/u);
});

test("Scenario Lab 按需运行精确的版本化情景请求并提供三态", () => {
  assert.match(
    componentSource,
    /datasetRef: "p3a-2025-holdout-v1"[\s\S]*?scenarioSetRef: "scheduler-k-comparison-v1"[\s\S]*?runtimeId: "deterministic_p3a_replay_v1"/u
  );
  assert.match(componentSource, /fetch\("\/api\/scenario-lab\/run"/u);
  assert.match(componentSource, /cache: "no-store"/u);
  assert.match(componentSource, /status: "loading"/u);
  assert.match(componentSource, /status: "error"/u);
  assert.match(componentSource, /status: "ready"/u);
  assert.match(componentSource, /data-testid="scenario-lab-loading"/u);
  assert.match(componentSource, /data-testid="scenario-lab-error"/u);
  assert.match(componentSource, /data-testid="scenario-lab-ready"/u);
});

test("观察、回放与多智能体运行时在界面中保持分层", () => {
  assert.match(componentSource, /01 · OBSERVED/u);
  assert.match(componentSource, /02 · REPLAY/u);
  assert.match(componentSource, /03 · RUNTIME LADDER/u);
  assert.match(componentSource, /非教育效果估计/u);
  assert.match(componentSource, /不写课程事实世界/u);
  assert.match(componentSource, /OASIS 社交互动仿真侧车/u);
  assert.match(componentSource, /AgentSociety 2 分布式实验编排/u);
  assert.match(componentSource, /不进入 Resolver 与 Decision Tape/u);
  assert.doesNotMatch(
    componentSource,
    /localStorage|sessionStorage|document\.cookie|candidateSetHash/u
  );
});

test("K=1/3/5 选择器使用 roving tabs 与完整键盘导航", () => {
  assert.match(componentSource, /role="tablist"/u);
  assert.match(componentSource, /role="tab"/u);
  assert.match(componentSource, /aria-selected=\{selected\}/u);
  assert.match(componentSource, /tabIndex=\{selected \? 0 : -1\}/u);
  assert.match(componentSource, /event\.key === "ArrowRight"/u);
  assert.match(componentSource, /event\.key === "ArrowLeft"/u);
  assert.match(componentSource, /event\.key === "Home"/u);
  assert.match(componentSource, /event\.key === "End"/u);
  assert.match(componentSource, /tabRefs\.current\[index\]\?\.focus\(\)/u);
  assert.match(componentSource, /role="tabpanel"/u);
});

test("Scenario Lab 在桌面、平板、手机和 320px 宽度保持可操作", () => {
  assert.match(cssSource, /@media \(max-width: 900px\)/u);
  assert.match(cssSource, /@media \(max-width: 639px\)/u);
  assert.match(cssSource, /@media \(max-width: 359px\)/u);
  assert.match(cssSource, /\.tab \{[\s\S]*?min-height: 4rem;/u);
  assert.match(
    cssSource,
    /@media \(max-width: 359px\)[\s\S]*?\.tab \{[\s\S]*?min-height: 44px;/u
  );
  assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(cssSource, /overflow-x: auto/u);
});
