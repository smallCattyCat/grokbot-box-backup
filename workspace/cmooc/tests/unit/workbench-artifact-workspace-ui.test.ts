import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../../components/workbench/AgentWorkbench.tsx", import.meta.url),
  "utf8"
);
const css = readFileSync(
  new URL("../../components/workbench/Workbench.module.css", import.meta.url),
  "utf8"
);

test("course Artifact Workspace is reachable from active and terminal runs", () => {
  assert.match(
    source,
    /function AdaptiveRunSpine\([\s\S]*?<CourseArtifactWorkspace key=\{snapshot\.id\} snapshot=\{snapshot\} \/>/u
  );
  assert.match(
    source,
    /snapshot && !terminalSnapshot \? \([\s\S]*?<AdaptiveRunSpine[\s\S]*?snapshot && terminalSnapshot \? \([\s\S]*?data-terminal-artifacts="true"[\s\S]*?<CourseArtifactWorkspace/u
  );
  assert.match(source, /<span>最新成果与验证<\/span>/u);
  assert.match(source, /<strong>课程成果版本<\/strong>/u);
});

test("workspace reads safe metadata only after disclosure and validates its public contract", () => {
  assert.match(
    source,
    /className=\{styles\.spineArtifactDisclosure\}[\s\S]*?onToggle=\{\(event\) => \{[\s\S]*?event\.currentTarget\.open\) void loadWorkspace\(\)/u
  );
  assert.match(
    source,
    /`\/api\/workbench\/runs\/\$\{encodeURIComponent\(snapshot\.id\)\}\/artifacts`[\s\S]*?method: "GET"[\s\S]*?cache: "no-store"/u
  );
  assert.match(source, /value\.bodyIncluded !== false/u);
  assert.match(source, /value\.bodyPersistedByWorkspace !== false/u);
  assert.match(source, /normalizeCourseArtifactVerification/u);
  assert.match(source, /normalizeCourseArtifactRecovery/u);
  assert.match(source, /normalizeCourseArtifactPreviewAvailability/u);
});

test("protected body is an explicit one-shot POST and never joins conversation events", () => {
  assert.match(
    source,
    /const previewRequestBody = JSON\.stringify\(\{[\s\S]*?expectedContentHash: version\.contentHash[\s\S]*?expectedDraftBodyHash: version\.draftBodyHash/u
  );
  assert.match(
    source,
    /\/artifacts\/\$\{encodeURIComponent\(version\.versionId\)\}\/preview`[\s\S]*?method: "POST"[\s\S]*?body: previewRequestBody/u
  );
  assert.match(source, /一次性预览正文/u);
  assert.match(source, /点击会消耗本版本的进程内预览绑定/u);
  assert.match(source, /setConsumedVersionIds/u);
  assert.match(source, /<pre>\{protectedView\.body\}<\/pre>/u);
  assert.match(source, /关闭后立即从 DOM 移除/u);
  assert.match(source, /else clearProtectedView\(false\)/u);
  assert.match(
    source,
    /useEffect\(\(\) => \{[\s\S]*?workspaceAbortRef\.current\?\.abort\(\);[\s\S]*?protectedAbortRef\.current\?\.abort\(\);/u
  );
  assert.doesNotMatch(
    source,
    /appendEvent\([\s\S]{0,300}protectedView|conversationBlocks[\s\S]{0,300}protectedView/u
  );
});

test("version diff clearly consumes both bindings and file artifacts remain separate", () => {
  assert.match(
    source,
    /const diffRequestBody = JSON\.stringify\(\{[\s\S]*?fromVersionId: pair\.from\.versionId[\s\S]*?toVersionId: pair\.to\.versionId/u
  );
  assert.match(source, /\/artifacts\/diff`[\s\S]*?method: "POST"[\s\S]*?body: diffRequestBody/u);
  assert.match(source, /对比会同时消耗两个版本的一次性绑定/u);
  assert.match(
    source,
    /new Set\(\[\.\.\.previous, pair\.from\.versionId, pair\.to\.versionId\]\)/u
  );
  assert.match(source, /<summary>Codex 文件变化 · \{snapshot\.artifacts\.length\} 项<\/summary>/u);
  assert.match(source, /与课程成果版本分开/u);
});

test("protected preview can become a bounded correction and refreshes immutable versions", () => {
  assert.match(source, /protectedEditBody/u);
  assert.match(
    source,
    /<textarea[\s\S]*?value=\{protectedEditBody\}[\s\S]*?maxLength=\{MAX_PROTECTED_DRAFT_EDIT_LENGTH\}/u
  );
  assert.match(source, /正文只保留在当前页面与短期受保护编辑会话/u);
  assert.match(
    source,
    /const correctionRequestBody = JSON\.stringify\(\{[\s\S]*?expectedContentHash: version\.contentHash[\s\S]*?expectedDraftBodyHash: version\.draftBodyHash[\s\S]*?correctedBody: protectedEditBody/u
  );
  assert.match(
    source,
    /\/artifacts\/\$\{encodeURIComponent\(version\.versionId\)\}\/corrections`[\s\S]*?method: "POST"[\s\S]*?body: correctionRequestBody/u
  );
  assert.match(source, /parseProtectedCorrection/u);
  assert.match(source, /void loadWorkspace\(true\)/u);
  assert.match(source, /修订并重新验证/u);
  assert.match(source, /已生成不可变 v/u);
  assert.doesNotMatch(
    source,
    /localStorage\.setItem\([^)]*protectedEditBody|sessionStorage\.setItem\([^)]*protectedEditBody/u
  );
});

test("closing or changing runs clears all correction body state and aborts its request", () => {
  assert.match(
    source,
    /const clearProtectedView = \(restoreFocus = false\) => \{[\s\S]*?setProtectedEditBody\(null\);/u
  );
  assert.match(
    source,
    /useEffect\(\(\) => \{[\s\S]*?return \(\) => \{[\s\S]*?correctionAbortRef\.current\?\.abort\(\);/u
  );
  assert.match(
    source,
    /<CourseArtifactWorkspace key=\{snapshot\.id\}/u
  );
});

test("Artifact Workspace remains touch-safe, focus-visible and progressively disclosed", () => {
  assert.match(
    css,
    /\.artifactRefreshButton,[\s\S]*?\.protectedArtifactView > header button\s*\{[\s\S]*?min-height:\s*2\.75rem;/u
  );
  assert.match(
    css,
    /\.artifactRefreshButton:focus-visible,[\s\S]*?\.fileArtifactDisclosure > summary:focus-visible\s*\{[\s\S]*?outline:\s*2px solid/u
  );
  assert.match(
    css,
    /@media \(max-width:\s*620px\)[\s\S]*?\.courseArtifactActions,[\s\S]*?\.artifactDiffEntry\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/u
  );
  assert.match(
    css,
    /\.protectedArtifactEditor textarea\s*\{[\s\S]*?min-height:\s*min\(18rem,\s*34dvh\);/u
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.spineDisclosureCaret\s*\{\s*transition:\s*none;/u
  );
});
