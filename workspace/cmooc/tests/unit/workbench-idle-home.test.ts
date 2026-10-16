import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workbenchSource = readFileSync(
  new URL("../../components/workbench/AgentWorkbench.tsx", import.meta.url),
  "utf8"
);
const workbenchCss = readFileSync(
  new URL("../../components/workbench/Workbench.module.css", import.meta.url),
  "utf8"
);
const workbenchPageSource = readFileSync(
  new URL("../../app/workbench/page.tsx", import.meta.url),
  "utf8"
);
const operatorReadModelSource = readFileSync(
  new URL("../../lib/workbench/operator-read-model.ts", import.meta.url),
  "utf8"
);
const operatorLocatorSource = readFileSync(
  new URL("../../components/workbench/OperatorCourseLocator.tsx", import.meta.url),
  "utf8"
);
const operatorLocatorRouteSource = readFileSync(
  new URL("../../app/api/workbench/operator-locator/route.ts", import.meta.url),
  "utf8"
);
const defaultCourseContextSource = readFileSync(
  new URL("../../lib/workbench/default-course-context.ts", import.meta.url),
  "utf8"
);

test("idle Workbench leads with a verified course and one primary task composer", () => {
  assert.match(operatorReadModelSource, /courseName:\s*string \| null/);
  assert.match(operatorReadModelSource, /courseAlias:\s*string \| null/);
  assert.match(operatorReadModelSource, /courseBound:\s*boolean/);
  assert.match(operatorReadModelSource, /requestedWorld\?\.selectedCourse\?\.displayName/);
  assert.match(workbenchPageSource, /AgentWorkbench operator=\{operator\}/);
  assert.match(workbenchSource, /className=\{styles\.idleCourseContext\}/);
  assert.match(workbenchSource, /当前课程/);
  assert.match(workbenchSource, /courseName=\{operator\.courseName \?\? ""\}/);
  assert.match(workbenchSource, /接下来希望智能学伴完成什么/);
  assert.match(workbenchSource, /htmlFor="workbench-prompt"/);
  assert.match(workbenchSource, /只读运行 · 真实发布关闭/);
  assert.match(workbenchSource, /<OperatorCourseLocator/);
});

test("operator locator deliberately exposes course content and account handles only in a no-store operator surface", () => {
  assert.match(operatorLocatorSource, /课程内容与账号/);
  assert.match(operatorLocatorSource, /仅运营界面/);
  assert.match(operatorLocatorSource, /查找帖子、正文或账号/);
  assert.match(operatorLocatorSource, /打开原帖/);
  assert.match(operatorLocatorSource, /复制账号/);
  assert.match(operatorLocatorSource, /\/api\/workbench\/operator-locator/);
  assert.match(operatorLocatorRouteSource, /requireTrustedJsonMutation/);
  assert.match(operatorLocatorRouteSource, /Cache-Control["']?:\s*["']no-store/);
  assert.doesNotMatch(operatorLocatorSource, /localStorage|sessionStorage|document\.cookie/);
});

test("idle Workbench starts course questions from the latest exact snapshot instead of the generic task lane", () => {
  assert.match(defaultCourseContextSource, /snapshot:\$\{anchor\.snapshotId\}/);
  assert.match(defaultCourseContextSource, /courseName/);
  assert.match(workbenchSource, /defaultCourseContext\(operator\)/);
  assert.match(workbenchSource, /<OperatorReplyTargetCard/);
  assert.match(workbenchSource, /snapshotId=\{operator\.brief\.anchor\?\.snapshotId \?\? null\}/);
});

test("composer language distinguishes starting a task, sending a turn and recovering an interrupted task", () => {
  assert.match(workbenchSource, /canGuide \? "发送"/);
  assert.match(workbenchSource, /: "开始新任务"/);
  assert.match(workbenchSource, /在同一任务中继续/);
  assert.match(workbenchSource, /恢复任务/);
  assert.doesNotMatch(workbenchSource, />启动研判</);
  assert.doesNotMatch(workbenchSource, /交给学伴研判/);
});

test("a loaded task exposes an explicit Codex-style new task action without stopping the old task", () => {
  const newTaskHandler = workbenchSource.match(
    /const beginNewTask = \(\) => \{[\s\S]*?\n  \};/
  )?.[0] ?? "";

  assert.match(workbenchSource, /aria-label="新建独立任务"/);
  assert.match(workbenchSource, />新建任务</);
  assert.match(newTaskHandler, /snapshotRef\.current = null/);
  assert.match(newTaskHandler, /clearPersistedRun\(\)/);
  assert.match(
    newTaskHandler,
    /setAttachedContextRef\(initialCourseContext\?\.ref \?\? ""\)/
  );
  assert.match(newTaskHandler, /setTransport\("idle"\)/);
  assert.doesNotMatch(newTaskHandler, /stopRun|\/stop|DELETE|fetch\(/);
});

test("task rail presents root task groups instead of one row per execution attempt", () => {
  assert.match(workbenchSource, /groupWorkbenchTaskHistory\(items\)/);
  assert.match(workbenchSource, /task\.turnCount/);
  assert.match(workbenchSource, /轮对话/);
  assert.match(workbenchSource, /task\.latestRun/);
});

test("idle layout is explicit and cannot leak into restored run timelines", () => {
  assert.match(
    workbenchSource,
    /const idleLanding =\s*runRestorationComplete &&\s*!snapshot &&\s*!isCreating &&\s*!isSending/
  );
  assert.match(workbenchSource, /data-run-state=\{snapshot\?\.status \?\? "idle"\}/);
  assert.match(workbenchSource, /data-idle-landing=\{idleLanding\}/);
  assert.match(workbenchSource, /idleLanding \? <IdleTimeline/);
  assert.match(workbenchSource, /snapshot && !terminalSnapshot \? \([\s\S]*?<AdaptiveRunSpine activity=\{activity\} snapshot=\{snapshot\}/);
  assert.match(workbenchSource, /snapshot \? <FinalAnswer snapshot=\{snapshot\} \/>/);
  assert.match(workbenchSource, /<FailureRecovery/);
  assert.match(workbenchSource, /<CompletedContinuation/);
});

test("desktop idle chrome progressively discloses history and operational facts", () => {
  assert.match(workbenchSource, /className=\{styles\.idleHistoryPreview\}/);
  assert.match(workbenchSource, /继续上次任务/);
  assert.match(workbenchSource, /historyItem\.canReuse[\s\S]*?"可继续"/);
  assert.match(workbenchSource, /className=\{styles\.idleHistoryAll\}/);
  assert.match(workbenchSource, /aria-controls="task-history-drawer"/);
  assert.match(workbenchSource, /<WorkbenchRuntimeStatus \/>/);
  assert.match(workbenchSource, /terminalSnapshot[\s\S]*?"运行已结束"/);
  assert.match(
    workbenchSource,
    /mountedRef\.current && operation === operationRef\.current/
  );
  assert.doesNotMatch(
    workbenchSource,
    /aria-label=\{`坚果云会话目录：\$\{snapshot\.sessionWorkspace\.projectRelativePath\}`\}/
  );
  assert.match(
    workbenchCss,
    /\.page\[data-idle-landing="true"\] \.systemBar\s*\{\s*display:\s*none;/
  );
  assert.match(
    workbenchCss,
    /@media \(min-width:\s*901px\)[\s\S]*?\.page\[data-idle-landing="true"\] \.conversationPane\s*\{[\s\S]*?grid-template-columns:/
  );
  assert.match(
    workbenchCss,
    /\.page\[data-idle-landing="true"\] \.conversationComposer \.promptInput\s*\{[\s\S]*?min-height:\s*8rem;/
  );
  assert.match(
    workbenchCss,
    /\.page\[data-idle-landing="true"\] \.conversationPane\[hidden\]\s*\{\s*display:\s*none;/
  );
});
