import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const globalsCss = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
const workbenchCss = readFileSync(
  new URL("../../components/workbench/Workbench.module.css", import.meta.url),
  "utf8"
);
const workbenchSource = readFileSync(
  new URL("../../components/workbench/AgentWorkbench.tsx", import.meta.url),
  "utf8"
);
const runtimeStatusSource = readFileSync(
  new URL("../../components/workbench/WorkbenchRuntimeStatus.tsx", import.meta.url),
  "utf8"
);
const agentSessionProviderSource = readFileSync(
  new URL("../../components/agent/AgentSessionProvider.tsx", import.meta.url),
  "utf8"
);

test("workbench owns a bounded viewport shell instead of pushing the composer below the page", () => {
  assert.match(
    globalsCss,
    /\.app-shell:has\(\[data-agent-workbench="true"\]\)\s*\{[\s\S]*?height:\s*100dvh;[\s\S]*?flex-direction:\s*column;[\s\S]*?overflow:\s*hidden;/
  );
  assert.match(
    globalsCss,
    /\.app-main:has\(\[data-agent-workbench="true"\]\)\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/
  );
  assert.match(
    workbenchCss,
    /\.taskRail,\s*\.consoleWorkspace \.conversationConsole\s*\{\s*position:\s*relative;\s*top:\s*auto;\s*height:\s*100%;\s*min-height:\s*0;\s*max-height:\s*none;/
  );
  assert.match(
    workbenchCss,
    /\.conversationPane\s*\{\s*position:\s*relative;\s*overflow:\s*hidden;/
  );
});

test("idle Workbench exposes a compact explicit local-authorization status", () => {
  assert.match(workbenchSource, /<WorkbenchRuntimeStatus\s*\/\>/);
  assert.match(workbenchSource, /idle:\s*"未启动"/);
  assert.match(runtimeStatusSource, /\/api\/workbench\/runtime/);
  assert.match(runtimeStatusSource, /连接本机/);
  assert.match(runtimeStatusSource, /status === "authorizing"/);
  assert.doesNotMatch(runtimeStatusSource, /localStorage|sessionStorage|document\.cookie/);
  assert.match(workbenchCss, /\.runtimeStatusButton\s*\{[\s\S]*?min-height:\s*2\.75rem;/);
});

test("responsive workbench keeps only the timeline scrollable and compacts keyboard focus", () => {
  assert.match(
    workbenchCss,
    /@media \(max-width:\s*900px\)[\s\S]*?\.consoleWorkspace \.conversationStream\s*\{\s*min-height:\s*0;\s*max-height:\s*none;\s*overflow-y:\s*auto;/
  );
  assert.match(
    workbenchCss,
    /@media \(max-width:\s*620px\)[\s\S]*?\.consoleWorkspace \.conversationConsole\s*\{\s*height:\s*100%;\s*min-height:\s*0;/
  );
  assert.match(
    workbenchCss,
    /@media \(max-width:\s*620px\) and \(max-height:\s*680px\)[\s\S]*?\.conversationConsole:has\(\.promptInput:focus\)[\s\S]*?\.conversationComposer:focus-within \.composerMetaStack/
  );
  assert.match(
    workbenchCss,
    /\.consoleWorkspace \.conversationComposer \.promptInput\s*\{[\s\S]*?min-height:\s*3\.25rem;[\s\S]*?max-height:\s*8\.5rem;[\s\S]*?field-sizing:\s*content;[\s\S]*?resize:\s*none;/
  );
  assert.match(
    globalsCss,
    /@media \(max-width:\s*639px\)[\s\S]*?\.app-shell:has\(\[data-agent-workbench="true"\]\) > \.app-header > div\s*\{[\s\S]*?flex-direction:\s*row;[\s\S]*?padding-block:\s*0\.45rem;/
  );
});

test("workbench chrome yields a larger vertical budget to the conversation", () => {
  assert.match(
    globalsCss,
    /\.app-shell:has\(\[data-agent-workbench="true"\]\) > \.app-header > div\s*\{\s*padding-block:\s*0\.2rem;/
  );
  assert.match(
    globalsCss,
    /@media \(min-width:\s*640px\)[\s\S]*?\.app-main:has\(\[data-agent-workbench="true"\]\)\s*\{\s*padding-top:\s*0\.5rem;\s*padding-bottom:\s*0\.5rem;/
  );
  assert.match(
    workbenchCss,
    /\/\* Console viewport budget v3:[\s\S]*?\.consoleWorkspace \.conversationHeader\s*\{\s*min-height:\s*2\.55rem;[\s\S]*?\.consoleWorkspace \.consoleViewBar\s*\{\s*min-height:\s*2\.25rem;[\s\S]*?\.consoleWorkspace \.conversationComposer\s*\{[\s\S]*?padding-top:\s*0\.3rem;\s*padding-bottom:\s*0\.35rem;[\s\S]*?\.consoleWorkspace \.conversationComposer \.promptInput\s*\{\s*min-height:\s*3rem;/
  );
  assert.match(
    workbenchCss,
    /@media \(min-width:\s*901px\) and \(max-height:\s*820px\)[\s\S]*?\.taskRailHeader\s*\{\s*min-height:\s*3\.4rem;[\s\S]*?\.taskRail \.historySection \.paneHeader h2\s*\{\s*white-space:\s*nowrap;\s*\}/
  );
});

test("mobile composer stays one row at rest without shrinking touch targets", () => {
  assert.match(
    workbenchCss,
    /@media \(min-width:\s*621px\) and \(max-width:\s*900px\)[\s\S]*?\.consoleWorkspace \.consoleViewBar,[\s\S]*?\.consoleWorkspace \.consoleTabs button\s*\{\s*min-height:\s*2\.75rem;/
  );
  assert.match(
    workbenchCss,
    /\/\* Mobile viewport correction v3:[\s\S]*?\.consoleWorkspace \.conversationHeader\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?\.consoleWorkspace \.consoleTabs button\s*\{\s*min-height:\s*2\.75rem;/
  );
  assert.match(
    workbenchCss,
    /\/\* Mobile viewport correction v3:[\s\S]*?\.consoleWorkspace \.conversationComposer \.promptInput\s*\{[\s\S]*?height:\s*3\.25rem;[\s\S]*?field-sizing:\s*fixed;[\s\S]*?white-space:\s*nowrap;[\s\S]*?\.consoleWorkspace \.conversationComposer \.promptInput:not\(:placeholder-shown\)\s*\{[\s\S]*?field-sizing:\s*content;[\s\S]*?white-space:\s*pre-wrap;/
  );
  assert.match(
    workbenchCss,
    /\.composerTools > summary > span\s*\{[\s\S]*?clip-path:\s*inset\(50%\);[\s\S]*?\.composerTools > summary > svg:last-child\s*\{\s*display:\s*none;/
  );
});

test("the composer uses one compact ChatGPT-like shell with search and advanced controls tucked away", () => {
  assert.match(workbenchSource, /className=\{styles\.composerShell\}/);
  assert.match(workbenchSource, /className=\{styles\.composerTools\}/);
  assert.match(workbenchSource, /搜索与工具/);
  assert.match(workbenchSource, /项目检索/);
  assert.match(workbenchSource, /网页检索/);
  assert.match(workbenchSource, /只读 · 来源随答复/);
  assert.match(workbenchSource, /finalResult\.citations/);
  assert.match(workbenchSource, /className=\{styles\.answerSources\}/);
  assert.match(workbenchSource, /target="_blank"[\s\S]*?rel="noreferrer"/);
  assert.match(
    workbenchCss,
    /\.composerShell\s*\{[\s\S]*?border-radius:\s*1rem;[\s\S]*?background:\s*#111b1f;/
  );
  assert.match(
    workbenchCss,
    /@media \(max-width:\s*620px\)[\s\S]*?\.conversationComposer \.composerFooter\s*\{[\s\S]*?flex-direction:\s*row;/
  );
});

test("active progress stays visible while mobile chrome yields space to the conversation", () => {
  assert.match(
    workbenchCss,
    /\.activityStrip\[data-state="working"\],\s*\.activityStrip\[data-state="starting"\]\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0;/
  );
  assert.match(
    workbenchSource,
    /<span className=\{styles\.systemSnapshotFact\}>快照/
  );
  assert.match(
    workbenchCss,
    /@media \(max-width:\s*620px\)[\s\S]*?\.systemBar > div:first-child > \.systemSnapshotFact\s*\{\s*display:\s*none;\s*\}[\s\S]*?\.taskModeBar\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/
  );
  assert.match(workbenchSource, /className=\{styles\.activityAnnouncement\}[\s\S]*?aria-live="polite"/);
  assert.match(workbenchSource, /当前步骤：\$\{publicTaskDisplayTitle\(activity\.title\)\}/);
});

test("mobile task history is a labelled focus-owned drawer", () => {
  assert.match(workbenchSource, /const taskRailRef = useRef<HTMLElement \| null>\(null\);/);
  assert.match(workbenchSource, /const taskRailCloseRef = useRef<HTMLButtonElement \| null>\(null\);/);
  assert.match(workbenchSource, /id="task-history-drawer"[\s\S]*?ref=\{taskRailRef\}/);
  assert.match(workbenchSource, /aria-controls="task-history-drawer"/);
  assert.match(workbenchSource, /taskRailCloseRef\.current\?\.focus\(\)/);
  assert.match(workbenchSource, /event\.key !== "Tab"/);
  assert.match(workbenchSource, /aria-current=\{task\.rootRunId === activeRootRunId \? "true" : undefined\}/);
});

test("timeline follow mode rechecks user intent and exposes only existing descriptions", () => {
  assert.match(workbenchSource, /lastTimelineRunIdRef = useRef\(""\);/);
  assert.match(workbenchSource, /timelineUserScrollIntentRef = useRef\(false\);/);
  assert.match(
    workbenchSource,
    /requestAnimationFrame\(\(\) => \{[\s\S]*?if \(!shouldAutoScrollRef\.current \|\| snapshotRef\.current\?\.id !== targetRunId\) return;/
  );
  assert.match(
    workbenchSource,
    /aria-describedby=\{visibleError \? "workbench-prompt-help workbench-error" : "workbench-prompt-help"\}/
  );
  assert.match(workbenchSource, /onWheel=\{markTimelineUserScrollIntent\}/);
  assert.match(workbenchSource, /onTouchMove=\{markTimelineUserScrollIntent\}/);
});

test("terminal replies stay primary while execution evidence remains available in the timeline", () => {
  assert.match(workbenchSource, /return eventSummary !== finalSummary;/);
  assert.match(workbenchSource, /snapshot && !terminalSnapshot \? \([\s\S]*?<AdaptiveRunSpine activity=\{activity\} snapshot=\{snapshot\}/);
  assert.match(
    workbenchSource,
    /querySelector<HTMLElement>\('\[data-final-answer="true"\]'\)[\s\S]*?finalAnswerTop[\s\S]*?stream\.scrollTop = Math\.max\(0, finalAnswerTop - 12\);/
  );
  assert.match(
    workbenchSource,
    /<FinalAnswer snapshot=\{snapshot\} \/>[\s\S]*?<details className=\{styles\.executionDetails\}>/
  );
  assert.match(
    workbenchCss,
    /\.conversationColumn \.executionDetails\[open\]\s*\{[\s\S]*?max-height:\s*none;[\s\S]*?overflow:\s*visible;/
  );
});

test("agent updates show ephemeral safe excerpts with functional role names", () => {
  assert.match(workbenchSource, /event\.liveExcerpt/);
  assert.match(workbenchSource, /当前进展摘录/);
  assert.match(workbenchSource, /安全摘录/);
  assert.match(workbenchSource, /内部推理和敏感信息已隐藏/);
  assert.match(workbenchSource, /主任务智能体/);
  assert.match(workbenchSource, /协作智能体/);
  assert.match(
    workbenchCss,
    /\.liveExcerpt\s*\{[\s\S]*?border-left:[\s\S]*?overflow-wrap:\s*anywhere;/
  );
  assert.match(workbenchSource, /event\.status === "completed" \? "进展已记录"/);
});

test("desktop running layout keeps history secondary and the current task pinned", () => {
  assert.match(
    workbenchCss,
    /@media \(min-width:\s*901px\)[\s\S]*?\.page\[data-run-state="queued"\] \.consoleWorkspace,[\s\S]*?\.page\[data-run-state="starting"\] \.consoleWorkspace,[\s\S]*?\.page\[data-run-state="running"\] \.consoleWorkspace\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/
  );
  assert.match(
    workbenchCss,
    /\.page\[data-run-state="running"\] \.activityStrip\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0;/
  );
});

test("a completed plan keeps the full assistant reply primary and exposes a compact execution plan", () => {
  assert.match(workbenchSource, /data-plan-outcome="true"/);
  assert.match(workbenchSource, /data-compact=\{compact\}/);
  assert.match(workbenchSource, /completed \? "完整答复"/);
  assert.match(workbenchSource, /onClick=\{onExecutePlan\}[\s\S]*?按计划执行/);
  assert.match(
    workbenchSource,
    /const executeCurrentPlan = \(\) => \{[\s\S]*?kind:\s*"plan-execution"/
  );
  assert.match(workbenchSource, /\/api\/workbench\/runs\/\$\{[^}]+\}\/launch/);
  assert.match(
    workbenchSource,
    /querySelector<HTMLElement>\('\[data-final-answer="true"\]'\)[\s\S]*?\?\?[\s\S]*?querySelector<HTMLElement>\('\[data-plan-outcome="true"\]'\)/
  );
  assert.match(
    workbenchSource,
    /snapshot \? <FinalAnswer snapshot=\{snapshot\} \/> : null[\s\S]*?planOutcome[\s\S]*?<PlanGoalPanel[\s\S]*?compact/
  );
  assert.doesNotMatch(
    workbenchSource,
    /planOutcome \? null : <FinalAnswer/
  );
  assert.match(
    workbenchSource,
    /\{!compact && plan\?\.explanation \? <p>/
  );
  assert.match(
    workbenchCss,
    /\.planExecuteButton\s*\{[\s\S]*?min-height:\s*2\.75rem;[\s\S]*?\.planExecuteButton:focus-visible/
  );
});

test("completed runs use continuation language and an in-session full user command", () => {
  assert.match(
    agentSessionProviderSource,
    /createTransientWorkbenchPrompt\(runId, displayPrompt\)/
  );
  assert.match(
    workbenchSource,
    /resolveTransientWorkbenchPrompt\(workbenchPromptHandoff, snapshot\?\.id\)/
  );
  assert.match(
    workbenchSource,
    /completedContinuation[\s\S]*?继续追问、补充要求，或要求按计划执行/
  );
  assert.doesNotMatch(
    workbenchSource,
    /status === "completed" && canGuide \? "继续当前任务 · 追加引导"/
  );
});

test("restored runs preserve only closed course routing metadata and exact snapshot anchors", () => {
  assert.match(
    workbenchSource,
    /rawContext\.kind === "course" \|\|[\s\S]*?rawContext\.kind === "snapshot" \|\|[\s\S]*?rawContext\.kind === "invocation"/u
  );
  assert.match(
    workbenchSource,
    /courseGoalCode:[\s\S]*?value\.courseGoalCode === "course_evidence_support_gap" \|\|[\s\S]*?value\.courseGoalCode === "research_evidence_package" \|\|[\s\S]*?value\.courseGoalCode === "schedule_review"[\s\S]*?\? value\.courseGoalCode[\s\S]*?: undefined/u
  );
  assert.match(
    workbenchSource,
    /transientTaskPrompt \|\| activeTaskTitle \|\| snapshot\.taskTitle \|\| "课程研判任务（原始要求未持久化）"/u
  );
});

test("new tasks keep the bounded visible request as their in-session title", () => {
  assert.match(
    workbenchSource,
    /next\.taskTitle !== "课程研判任务"[\s\S]*?publicTaskDisplayTitle\(displayPrompt\)\.slice\(0, 160\)/
  );
});

test("persisted completed runs offer an honest lineage-linked continuation", () => {
  assert.match(workbenchSource, /data-continuation-action="true"/);
  assert.match(workbenchSource, /在同一任务中继续/);
  assert.match(workbenchSource, /历史与成果仍归入当前任务/);
  assert.match(
    workbenchSource,
    /const continueCompletedRun = \(\) => \{[\s\S]*?kind:\s*"continuation"/
  );
  assert.match(workbenchSource, /正在承接….*继续/s);
  assert.doesNotMatch(workbenchSource, /\b(?:parentRunId|rootRunId)\s*:/);
});

test("failed local runs offer an honest lineage-linked restart action", () => {
  assert.match(workbenchSource, /data-recovery-action="true"/);
  assert.match(workbenchSource, /恢复任务/);
  assert.match(workbenchSource, /创建新的执行尝试，不重放旧线程/);
  assert.match(
    workbenchSource,
    /const restartCurrentRun = \(\) => \{[\s\S]*?kind:\s*"restart"/
  );
  assert.match(workbenchSource, /\/api\/workbench\/runs\/\$\{[^}]+\}\/launch/);
  assert.doesNotMatch(workbenchSource, /\b(?:planRunId|recoveryOfRunId)\s*:/);
  assert.match(workbenchSource, /recoveryState === "interrupted"[\s\S]*?中断 · 可恢复/);
  assert.match(
    workbenchCss,
    /\.failureRecovery[\s\S]*?\.recoveryButton[\s\S]*?min-height:\s*2\.75rem;/
  );
});

test("goal status never defaults to active before the native goal exists", () => {
  assert.doesNotMatch(workbenchSource, /snapshot\.goal\?\.status \?\? "active"/);
  assert.match(workbenchSource, /snapshot\.goal\s*\?/);
  assert.match(workbenchSource, /正在建立/);
  assert.match(workbenchSource, /未建立/);
});

test("Workbench registers typed page actions for its visible controls", () => {
  assert.match(
    workbenchSource,
    /registerPageBridge\(\{[\s\S]*?routeId:\s*"workbench"[\s\S]*?WORKBENCH_PAGE_ACTION_CAPABILITIES/
  );
  assert.match(
    workbenchSource,
    /if \(!runRestorationComplete\) return;[\s\S]*?registerPageBridge\(\{/
  );
  assert.match(
    workbenchSource,
    /executeWorkbenchPageAction\(\{[\s\S]*?surface:\s*consoleViewRef\.current[\s\S]*?collaborationMode:\s*collaborationModeRef\.current[\s\S]*?goalMode:\s*goalModeRef\.current/
  );
  assert.match(workbenchSource, /stopRequestRef/);
  assert.match(
    workbenchSource,
    /const stopRun = async[\s\S]*?stopRequestRef[\s\S]*?\/stop[\s\S]*?return await stopPromise/
  );
  assert.match(workbenchSource, /onClick=\{\(\) => void stopRun\(\)\}/);
});

test("cross-page delegation opens and restores the exact Workbench run", () => {
  assert.match(
    agentSessionProviderSource,
    /router\.replace\(buildWorkbenchRunHandoffHref\((?:runId|recoveredRunId)\)\)/
  );
  assert.match(workbenchSource, /useSearchParams\(\)/);
  assert.match(
    workbenchSource,
    /resolveWorkbenchRestoreRunId\(handoffRunId, storedRunId\)/
  );
  assert.match(workbenchSource, /\}, \[handoffRunId\]\);/);
});

test("running and demo tasks keep typed page commands submit-enabled even when guidance is unavailable", () => {
  assert.match(
    workbenchSource,
    /const composerHasLocalPageActions = useMemo\([\s\S]*?hasLocalPageActions\(planAgentCommand\(prompt\)\)/u
  );
  assert.match(
    workbenchSource,
    /disabled=\{isCreating \|\| isSending \|\| \(active && !canGuide && !composerHasLocalPageActions\)\}/u
  );
  assert.match(workbenchSource, /composerHasLocalPageActions \? "执行页面动作"/u);
});

test("failed local page commands keep the Workbench composer draft", () => {
  assert.match(
    workbenchSource,
    /executeAgentCommand\(trimmedPrompt\)\.then\(\(completed\) => \{[\s\S]*?if \(mountedRef\.current && completed\) setPrompt\(""\);/
  );
});

test("stale global page-command errors stay hidden until this Workbench action fails", () => {
  assert.match(workbenchSource, /const \[showAgentCommandError, setShowAgentCommandError\] = useState\(false\);/);
  assert.match(
    workbenchSource,
    /const visibleError = error \|\| \(showAgentCommandError \? agentCommandError : ""\);/
  );
  assert.match(
    workbenchSource,
    /setShowAgentCommandError\(false\);[\s\S]*?void executeAgentCommand\(trimmedPrompt\)\.then\(\(completed\) => \{[\s\S]*?setShowAgentCommandError\(!completed\);/
  );
  assert.match(
    workbenchSource,
    /const createRun = async \([\s\S]*?\) => \{[\s\S]*?setShowAgentCommandError\(false\);/
  );
  assert.match(workbenchSource, /const sendGuidance = async \(requestedPrompt: string\) => \{[\s\S]*?setShowAgentCommandError\(false\);/);
  assert.match(workbenchSource, /const openHistoryItem = async \(item: WorkbenchHistoryItem\) => \{[\s\S]*?setShowAgentCommandError\(false\);/);
});

test("the current activity is docked outside the scrolling timeline", () => {
  assert.match(
    workbenchSource,
    /className=\{styles\.activityDock\}[\s\S]*?<AdaptiveRunSpine activity=\{activity\} snapshot=\{snapshot\}[\s\S]*?className=\{styles\.conversationStream\}/
  );
});

test("active runs use one adaptive spine while tool and internal logs stay collapsed", () => {
  assert.match(
    workbenchSource,
    /function AdaptiveRunSpine\([\s\S]*?aria-label="当前计划、成果与验证"[\s\S]*?>当前步骤<[\s\S]*?计划进度：[\s\S]*?>最新成果与验证</
  );
  assert.match(workbenchSource, /className=\{styles\.spineArtifactDisclosure\}[\s\S]*?<summary>[\s\S]*?成果与验证工作区（仅安全元数据）/);
  assert.match(workbenchSource, /安全元数据就绪 · 独立验证未回流/);
  assert.match(workbenchSource, /尚未收到独立验证回执/);
  assert.match(workbenchSource, /不预览正文/);
  assert.match(workbenchSource, /function ArtifactBlock\([\s\S]*?aria-label="文件变化"/);
  assert.match(workbenchSource, /block\.type === "artifacts"[\s\S]*?<ArtifactBlock/);
  assert.match(workbenchSource, /function ProcessDetails\([\s\S]*?onToggle=/);
  assert.match(workbenchSource, /function AnalysisBlock\([\s\S]*?defaultExpanded=\{false\}/);
  assert.match(workbenchSource, /function ToolBlock\([\s\S]*?defaultExpanded=\{false\}/);
  assert.match(workbenchSource, /<details className=\{styles\.executionDetails\}>[\s\S]*?<TeamCard[\s\S]*?<ToolsCard/);
  assert.match(workbenchSource, /aria-label=\{`\$\{planStepStatusLabel\(step\.status\)\}：\$\{publicTaskDisplayTitle\(step\.step\)\}`\}/);
  assert.doesNotMatch(workbenchSource, /\$\{snapshot\.goal\?\.tokensUsed\.toLocaleString/);
});

test("the final density layer keeps mobile chrome compact without hiding idle guidance", () => {
  assert.match(
    workbenchCss,
    /Density pass:[\s\S]*?\.consoleWorkspace \.conversationHeader\s*\{[\s\S]*?min-height:\s*2\.9rem;/
  );
  assert.match(
    workbenchCss,
    /Density pass:[\s\S]*?\.systemBar\s*\{[\s\S]*?min-height:\s*1\.95rem;/
  );
  assert.match(
    workbenchCss,
    /@media \(max-width:\s*620px\)[\s\S]*?\.systemBar\s*\{[\s\S]*?flex-direction:\s*row;[\s\S]*?\.systemBar > div:first-child\s*\{[\s\S]*?overflow-x:\s*auto;/
  );
  assert.match(
    workbenchCss,
    /\.conversationStream \.emptyDescription\s*\{[\s\S]*?display:\s*-webkit-box;[\s\S]*?-webkit-line-clamp:\s*2;[\s\S]*?\.conversationStream \.exampleRow\s*\{[\s\S]*?display:\s*flex;/
  );
  assert.match(
    workbenchCss,
    /\.conversationStream \.exampleChip\s*\{[\s\S]*?min-height:\s*2\.75rem;/
  );
  assert.match(
    workbenchSource,
    /aria-label="运行安全事实，窄屏可横向滚动"[\s\S]*?tabIndex=\{0\}/
  );
});

test("adaptive spine keeps desktop evidence lateral and mobile disclosure touch-safe", () => {
  assert.match(
    workbenchCss,
    /\.adaptiveRunSpine\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1\.45fr\)\s*minmax\(16rem,\s*0\.8fr\);/
  );
  assert.match(
    workbenchCss,
    /\.spineArtifactDisclosure > summary\s*\{[\s\S]*?min-height:\s*4\.1rem;[\s\S]*?cursor:\s*pointer;[\s\S]*?list-style:\s*none;/
  );
  assert.match(
    workbenchCss,
    /\.spineArtifactDisclosure > summary:focus-visible\s*\{[\s\S]*?outline:\s*2px solid/
  );
  assert.match(
    workbenchCss,
    /@media \(max-width:\s*900px\)[\s\S]*?\.adaptiveRunSpine\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/
  );
  assert.match(
    workbenchCss,
    /@media \(max-width:\s*620px\)[\s\S]*?\.spineArtifactDisclosure > summary\s*\{[\s\S]*?min-height:\s*4\.4rem;[\s\S]*?\.artifactWorkspacePanel\s*\{[\s\S]*?max-height:\s*min\(62dvh,\s*32rem\);[\s\S]*?overscroll-behavior:\s*contain;/
  );
  assert.match(workbenchCss, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.adaptiveRunSpine\[data-state="working"\] \.activityPulse[\s\S]*?animation:\s*none;/);
});

test("awaiting-action runs expose one inline exact-scope L3 decision card", () => {
  assert.match(
    workbenchSource,
    /snapshot\?\.status === "awaiting_action" && snapshot\.pendingAction \? \([\s\S]*?<PendingActionCard[\s\S]*?key=\{snapshot\.pendingAction\.actionRef\}/u
  );
  assert.match(
    workbenchSource,
    /data-pending-action-card="true"[\s\S]*?确认一次可恢复的编辑器核验[\s\S]*?有效至 \{formatActionExpiry\(action\.expiresAt\)\}/u
  );
  assert.match(workbenchSource, /编辑器写入[\s\S]*?回读[\s\S]*?清空[\s\S]*?发布[\s\S]*?通知/u);
  assert.match(workbenchSource, /不会发布，也不会通知任何人/u);
  assert.match(workbenchSource, /技术绑定详情[\s\S]*?actionRef[\s\S]*?approvalHash[\s\S]*?bindingHash/u);
  assert.doesNotMatch(workbenchSource, /pendingActionSummary[\s\S]*?(?:草稿正文|draft body|preview draft)/iu);
});

test("pending-action decisions send only the bounded decision and expected action hash", () => {
  assert.match(
    workbenchSource,
    /\/api\/workbench\/runs\/\$\{encodeURIComponent\(runId\)\}\/actions\/\$\{encodeURIComponent\(action\.actionRef\)\}\/decision/u
  );
  const decisionBody = workbenchSource.match(
    /body:\s*JSON\.stringify\(\{([\s\S]*?)\}\)/u
  )?.[1] ?? "";
  assert.match(decisionBody, /\bdecision\b/u);
  assert.match(decisionBody, /expectedActionHash:\s*action\.approvalHash/u);
  assert.doesNotMatch(
    decisionBody,
    /\b(?:grantRef|toolName|toolVersion|capability|course|publish|actionRef|bindingHash)\b/u
  );
  assert.match(workbenchSource, /const next = await fetchSnapshot\(runId\);[\s\S]*?applySnapshot\(next\);/u);
});

test("pending-action controls remain touch-safe, responsive and politely announced", () => {
  assert.match(
    workbenchSource,
    /className=\{styles\.pendingActionStatus\}[\s\S]*?role="status"[\s\S]*?aria-live="polite"/u
  );
  assert.match(workbenchSource, /disabled=\{decisionLocked\}/u);
  assert.match(
    workbenchCss,
    /\.pendingActionApprove,[\s\S]*?\.pendingActionDecline\s*\{[\s\S]*?min-height:\s*2\.75rem;/u
  );
  assert.match(
    workbenchCss,
    /\.pendingActionDetails > summary:focus-visible,[\s\S]*?outline:\s*2px solid/u
  );
  assert.match(
    workbenchCss,
    /@media \(max-width:\s*620px\)[\s\S]*?\.pendingActionButtons\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/u
  );
});
