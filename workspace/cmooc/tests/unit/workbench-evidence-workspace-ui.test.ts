import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const evidenceSource = readFileSync(
  new URL(
    "../../components/workbench/opportunity-canvas/OpportunityEvidenceWorkspace.tsx",
    import.meta.url
  ),
  "utf8"
);
const evidenceCss = readFileSync(
  new URL(
    "../../components/workbench/opportunity-canvas/OpportunityEvidenceWorkspace.module.css",
    import.meta.url
  ),
  "utf8"
);
const briefSource = readFileSync(
  new URL("../../components/workbench/CourseOpportunityBrief.tsx", import.meta.url),
  "utf8"
);
const workbenchSource = readFileSync(
  new URL("../../components/workbench/AgentWorkbench.tsx", import.meta.url),
  "utf8"
);
const workbenchCss = readFileSync(
  new URL("../../components/workbench/Workbench.module.css", import.meta.url),
  "utf8"
);

test("Opportunity Canvas exposes exactly four evidence lenses with roving keyboard tabs", () => {
  assert.match(
    evidenceSource,
    /const LENSES:[\s\S]*?\{ key: "evidence", label: "判断依据" \}[\s\S]*?\{ key: "change", label: "事件变化" \}[\s\S]*?\{ key: "portrait", label: "课程画像" \}[\s\S]*?\{ key: "research", label: "研究证据" \}/u
  );
  assert.equal((evidenceSource.match(/\{ key: "(?:evidence|change|portrait|research)"/g) ?? []).length, 4);
  assert.match(evidenceSource, /role="tablist"[\s\S]*?aria-label="证据视角"/u);
  assert.match(evidenceSource, /role="tab"[\s\S]*?aria-selected=\{activeLens === lens\.key\}/u);
  assert.match(evidenceSource, /tabIndex=\{activeLens === lens\.key \? 0 : -1\}/u);
  assert.match(evidenceSource, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/u);
  assert.match(evidenceSource, /requestAnimationFrame\(\(\) => tabRefs\.current\[index\]\?\.focus\(\)\)/u);
});

test("the four tabs own one active panel rather than four report-like pages", () => {
  assert.match(evidenceSource, /role="tabpanel"/u);
  assert.match(evidenceSource, /aria-labelledby=\{`\$\{idPrefix\}-\$\{activeLens\}-tab`\}/u);
  assert.match(evidenceSource, /id=\{`\$\{idPrefix\}-\$\{activeLens\}-panel`\}/u);
  assert.doesNotMatch(
    evidenceSource,
    /LENSES\.map\(\(lens\) => \([\s\S]*?role="tabpanel"/u
  );
  assert.doesNotMatch(evidenceSource, /<h1\b|dashboard|驾驶舱|汇报/u);
});

test("lower-bound change remains visible and is not collapsed into unavailable", () => {
  assert.match(evidenceSource, /change\.status === "unavailable"/u);
  assert.match(evidenceSource, /const lowerBound = change\.status === "lower_bound"/u);
  assert.match(evidenceSource, /结构事件变化（可见范围）/u);
  assert.match(evidenceSource, /可见下界 · 聚合计数/u);
  assert.match(evidenceSource, /lowerBound \? "可见差" : "变化"/u);
});

test("desktop preserves the approved 38/62 Canvas split", () => {
  assert.match(
    workbenchCss,
    /@media \(min-width:\s*901px\)[\s\S]*?\.consoleWorkspace\[data-canvas-open="true"\][\s\S]*?grid-template-columns:\s*minmax\(22rem,\s*38fr\)\s+minmax\(0,\s*62fr\);/u
  );
  assert.match(
    workbenchCss,
    /\.consoleWorkspace\[data-canvas-open="true"\][\s\S]*?\.conversationConsole\s*\{[\s\S]*?grid-column:\s*1;/u
  );
  assert.match(
    workbenchCss,
    /\.consoleWorkspace\[data-canvas-open="true"\][\s\S]*?\.opportunityCanvas\s*\{[\s\S]*?grid-column:\s*2;/u
  );
});

test("mobile Canvas is full-screen and owns background inertness, focus, and Escape", () => {
  assert.match(
    workbenchCss,
    /@media \(max-width:\s*900px\)[\s\S]*?\.opportunityCanvas\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;[\s\S]*?width:\s*100vw;[\s\S]*?height:\s*100dvh;/u
  );
  assert.match(briefSource, /window\.matchMedia\("\(max-width: 900px\)"\)/u);
  assert.match(briefSource, /const enteringModal = isModal && !wasModalRef\.current/u);
  assert.match(briefSource, /if \(enteringModal\)[\s\S]*?closeRef\.current\?\.focus\(\)/u);
  assert.doesNotMatch(briefSource, /initialFocusAppliedRef/u);
  assert.match(briefSource, /node\.inert = true;[\s\S]*?node\.setAttribute\("aria-hidden", "true"\)/u);
  assert.match(briefSource, /entry\.node\.inert = entry\.inert/u);
  assert.match(briefSource, /if \(event\.key === "Escape"\)[\s\S]*?onClose\(\)/u);
  assert.match(briefSource, /event\.key !== "Tab" \|\| !isModal/u);
  assert.match(briefSource, /closeRef\.current\?\.focus\(\)/u);
  assert.match(
    workbenchSource,
    /closeOpportunityCanvas[\s\S]*?briefTriggerRef\.current[\s\S]*?trigger\?\.isConnected[\s\S]*?trigger\.focus\(\)/u
  );
});

test("research lens downloads the strict aggregate endpoint and states its privacy boundary", () => {
  assert.match(
    evidenceSource,
    /<a className=\{styles\.downloadAction\} href=\{research!\.exportHref\} download>/u
  );
  assert.match(evidenceSource, /下载研究证据包/u);
  assert.match(evidenceSource, /SHA-256/u);
  assert.match(evidenceSource, /不支持个体诊断、因果效果或真实发布判断/u);
  assert.match(briefSource, /只读 · 不含论坛正文与身份/u);
  assert.doesNotMatch(evidenceSource, /localStorage|sessionStorage|document\.cookie/u);
  assert.match(evidenceCss, /\.downloadAction:focus-visible/u);
});
