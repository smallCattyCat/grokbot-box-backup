import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workbenchSource = readFileSync(
  new URL("../../components/workbench/AgentWorkbench.tsx", import.meta.url),
  "utf8"
);
const briefSource = readFileSync(
  new URL("../../components/workbench/CourseOpportunityBrief.tsx", import.meta.url),
  "utf8"
);
const evidenceWorkspaceSource = readFileSync(
  new URL(
    "../../components/workbench/opportunity-canvas/OpportunityEvidenceWorkspace.tsx",
    import.meta.url
  ),
  "utf8"
);
const evidenceWorkspaceCss = readFileSync(
  new URL(
    "../../components/workbench/opportunity-canvas/OpportunityEvidenceWorkspace.module.css",
    import.meta.url
  ),
  "utf8"
);
const workbenchCss = readFileSync(
  new URL("../../components/workbench/Workbench.module.css", import.meta.url),
  "utf8"
);

test("the brief is progressive disclosure inside the existing conversation, not a report page", () => {
  assert.match(workbenchSource, /<TodayBriefTrigger brief=\{brief\} onOpen=\{onOpenBrief\} \/>/);
  assert.match(
    workbenchSource,
    /!idleLanding \? \([\s\S]*?<ConversationBrief[\s\S]*?brief=\{operator\.brief\}[\s\S]*?onOpen=\{openOpportunityCanvas\}/
  );
  assert.match(
    workbenchSource,
    /selectedBriefItemId \? \([\s\S]*?<OpportunityCanvas[\s\S]*?brief=\{operator\.brief\}/
  );
  assert.match(briefSource, /<article className=\{styles\.conversationBrief\} aria-labelledby=/);
  assert.match(briefSource, /<aside[\s\S]*?role="dialog"[\s\S]*?aria-labelledby="opportunity-canvas-title"/);
  assert.match(briefSource, /<nav[\s\S]*?aria-label="简报事项"/);
  assert.doesNotMatch(briefSource, /<h1\b/);
  assert.match(
    workbenchSource,
    /idleScheduleOpen \? \([\s\S]*?<h2 id="idle-schedule-page-heading"/
  );
  assert.doesNotMatch(
    workbenchSource,
    /<h1 id="idle-schedule-page-heading"/
  );
  assert.doesNotMatch(briefSource, /dashboard|驾驶舱|汇报/u);
});

test("the opportunity Canvas preserves the approved desktop 38/62 conversation split", () => {
  assert.match(
    workbenchCss,
    /@media \(min-width:\s*901px\)[\s\S]*?\.consoleWorkspace\[data-canvas-open="true"\]\s*\{[\s\S]*?grid-template-columns:\s*minmax\(22rem,\s*38fr\)\s+minmax\(0,\s*62fr\);/
  );
  assert.match(
    workbenchCss,
    /\.consoleWorkspace\[data-canvas-open="true"\] \.conversationConsole\s*\{\s*grid-column:\s*1;/
  );
  assert.match(
    workbenchCss,
    /\.consoleWorkspace\[data-canvas-open="true"\] \.opportunityCanvas\s*\{\s*grid-column:\s*2;/
  );
  assert.match(
    workbenchSource,
    /className=\{styles\.consoleWorkspace\}[\s\S]*?data-canvas-open=\{Boolean\(selectedBriefItemId\)\}/
  );
});

test("the Canvas becomes a true full-screen task surface at and below 900px", () => {
  assert.match(
    workbenchCss,
    /@media \(max-width:\s*900px\)[\s\S]*?\.opportunityCanvas\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;[\s\S]*?width:\s*100vw;[\s\S]*?height:\s*100dvh;/
  );
  assert.match(
    workbenchCss,
    /@media \(max-width:\s*900px\)[\s\S]*?\.canvasBackdrop\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;[\s\S]*?display:\s*block;/
  );
  assert.match(
    evidenceWorkspaceCss,
    /@media \(max-width:\s*620px\)[\s\S]*?\.actions,[\s\S]*?\.researchActionRow\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/
  );
});

test("Canvas keyboard ownership includes Escape, a focus loop, and trigger focus restoration", () => {
  assert.match(briefSource, /closeRef\.current\?\.focus\(\)/);
  assert.match(
    briefSource,
    /if \(event\.key === "Escape"\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?onClose\(\);/
  );
  assert.match(briefSource, /event\.key !== "Tab"/);
  assert.match(briefSource, /window\.matchMedia\("\(max-width: 900px\)"\)/);
  assert.match(briefSource, /event\.key !== "Tab" \|\| !isModal/);
  assert.match(briefSource, /aria-modal=\{isModal \? "true" : undefined\}/);
  assert.match(
    briefSource,
    /a\[href\], button:not\(\[disabled\]\), \[tabindex\]:not\(\[tabindex="-1"\]\)/
  );
  assert.match(workbenchSource, /briefTriggerRef = useRef<HTMLButtonElement \| null>\(null\);/);
  assert.match(
    workbenchSource,
    /const closeOpportunityCanvas = useCallback\(\(\) => \{[\s\S]*?setSelectedBriefItemId\(""\);[\s\S]*?const trigger = briefTriggerRef\.current;[\s\S]*?trigger\?\.isConnected[\s\S]*?trigger\.focus\(\)/
  );
  assert.match(
    workbenchSource,
    /const openOpportunityCanvas = useCallback\([\s\S]*?briefTriggerRef\.current = trigger;[\s\S]*?setSelectedBriefItemId\(item\.id\)/
  );
});

test("the brief handoff keeps the operation read-only and carries an exact evidence context", () => {
  assert.match(briefSource, /只读 · 不含论坛正文与身份/);
  assert.match(evidenceWorkspaceSource, /item\.canHandoff \? \(/);
  assert.match(evidenceWorkspaceSource, /<Link href=\{item\.sourceHref\}>/);
  assert.match(workbenchSource, /setAttachedContextRef\(item\.contextRef\)/);
  assert.match(workbenchSource, /sourceHref:\s*item\.sourceHref/);
  assert.match(workbenchSource, /保持课程平台写入关闭，不执行真实发布/);
});
