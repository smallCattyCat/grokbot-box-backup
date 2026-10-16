import { browserCoursePrivateRoot, getBrowserWorkspace, interruptBrowserRun, recoverBrowserExecution, reserveBrowserExecution } from "./browser-course-store";
import { isLocalCourseFixture, type BrowserCourseRun } from "./browser-course-contracts";
import { createWorkbenchRun, completeWorkbenchRun, getActiveWorkbenchRun, getWorkbenchRun, stopWorkbenchRun } from "./run-store";
import { attachWorkbenchPersistence, persistWorkbenchRunSnapshot } from "./history-store";
import { inspectCodexHarnessReadiness, startCodexAppServerRun } from "./codex-app-server";
import { prepareBrowserCourseRuntime } from "./browser-course-runtime";

type Native = { id: string; status: string };
export type BrowserDispatcherDependencies = {
  now(): Date;
  native(id: string): Native | undefined;
  busy(): boolean;
  ready(): Promise<boolean>;
  create(goal: string, title: string): Native;
  start(run: BrowserCourseRun, entryUrl: string, origin: string): Promise<void>;
  stop(id: string): Promise<unknown>;
  fail(id: string): void;
};
const defaults: BrowserDispatcherDependencies = {
  now: () => new Date(), native: getWorkbenchRun, busy: () => !!getActiveWorkbenchRun(),
  ready: async () => (await inspectCodexHarnessReadiness()).ready,
  create: (goal, title) => createWorkbenchRun({ prompt: goal, source: "app-server", taskTitle: title, collaborationMode: "default", goalMode: false }),
  start: async (run, entryUrl, origin) => {
    const id = run.executionRunId!; const native = getWorkbenchRun(id);
    if (native) { await persistWorkbenchRunSnapshot(native); attachWorkbenchPersistence(id); }
    const profile = await prepareBrowserCourseRuntime(run.id, entryUrl, origin, id);
    // A teacher may stop the durable task while runtime setup is in progress.
    const current = (await getBrowserWorkspace()).runs.find(r => r.id === run.id);
    if (!["executing", "watch_executing"].includes(current?.dispatch?.state || "") || current?.executionRunId !== id) throw new Error("DISPATCH_CANCELLED");
    const prompt = run.phase === "reply_watch"
      ? "完成已绑定课程的接球复扫。先使用 claim_course_run 接手同一条 Tape，再重读目标讨论和已有观察；只需记录最新观察并调用 finish_course_run，若观察到第三人实质接球让位，未接球则记录待穿线状态。登录失效时调用 mark_course_relogin_required，释放租约并暂停任务。"
      : "完成已绑定的课程任务。先使用 claim_course_run 获取本轮目标、模式和课程入口。已有观察时先重读当前页面，再从检查点继续。登录失效时调用 mark_course_relogin_required，释放租约并暂停任务。";
    await startCodexAppServerRun(id, prompt, {
      nativeConversation: true, collaborationMode: "default", goalMode: false, executionIntent: "inspect", browserCourseRuntime: profile
    });
  },
  stop: stopWorkbenchRun,
  fail: (id) => { completeWorkbenchRun(id, "failed", "课程后台执行连接中断，成果保留。", "COURSE_DISPATCH_FAILED"); }
};
const KEY = "__cmooc_course_dispatcher__";

/** Consumes already requested work. It never creates course schedules or enables publication. */
export async function dispatchBrowserCourses(origin: string, overrides: Partial<BrowserDispatcherDependencies> = {}) {
  const url = new URL(origin);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.origin !== origin) throw new Error("DISPATCH_ORIGIN_INVALID");
  const global = globalThis as typeof globalThis & { [KEY]?: Set<string> };
  const locks = global[KEY] ??= new Set<string>(); const key = browserCoursePrivateRoot();
  if (locks.has(key)) return { status: "busy", recovered: 0, started: 0, realPublishEnabled: false };
  locks.add(key); const deps = { ...defaults, ...overrides }; let recovered = 0;
  try {
    const snapshot = await getBrowserWorkspace(); const now = deps.now();
    for (const run of snapshot.runs) {
      if (run.dispatch?.origin !== origin || !["executing", "watch_executing"].includes(run.dispatch.state) || !run.executionRunId) continue;
      const native = deps.native(run.executionRunId);
      if (native?.status === "stopped") {
        await interruptBrowserRun(run.id, "执行者已停止任务；已有成果保留，等待明确继续。"); continue;
      }
      const expired = run.status === "interrupted" || ((run.status === "queued" || run.status === "running" || run.status === "completed") &&
        now.getTime() - Date.parse(run.dispatch.startedAt!) > 5 * 60_000);
      if (!native || ["failed", "completed"].includes(native.status) || expired) {
        if (native && !["failed", "completed"].includes(native.status)) await deps.stop(native.id);
        const code = expired ? "EXECUTION_EXPIRED" : !native ? "EXECUTION_LOST" : native.status === "completed" ? "EXECUTION_INCOMPLETE" : "EXECUTION_FAILED";
        await recoverBrowserExecution(run.id, run.executionRunId, code, now); recovered++;
      }
    }
    if (deps.busy()) return { status: "busy", recovered, started: 0, realPublishEnabled: false };
    const current = await getBrowserWorkspace();
    const run = current.runs.find(r => r.dispatch?.origin === origin &&
      ((r.status === "queued" && ["queued", "retry_wait", "watch_queued"].includes(r.dispatch.state)) || (r.status === "completed" && r.dispatch.state === "watch_queued")) &&
      r.authState !== "relogin_required" && Date.parse(r.dispatch.nextAttemptAt) <= now.getTime());
    if (!run) return { status: "idle", recovered, started: 0, realPublishEnabled: false };
    const course = current.courses.find(c => c.id === run.courseId)!;
    if (!isLocalCourseFixture(course.entryUrl) || new URL(course.entryUrl).origin !== origin) throw new Error("DISPATCH_SCOPE_INVALID");
    if (!await deps.ready()) return { status: "runtime_unavailable", recovered, started: 0, realPublishEnabled: false };
    // Native creation reserves the single execution slot synchronously.
    const native = deps.create(run.goal, course.title);
    let reserved: BrowserCourseRun;
    try { reserved = await reserveBrowserExecution(run.id, native.id, origin, now); }
    catch { deps.fail(native.id); return { status: "changed", recovered, started: 0, realPublishEnabled: false }; }
    try { await deps.start(reserved, course.entryUrl, origin); }
    catch {
      await deps.stop(native.id).catch(() => undefined);
      deps.fail(native.id);
      await recoverBrowserExecution(run.id, native.id, "START_FAILED", deps.now());
      return { status: "retry_wait", recovered, started: 0, realPublishEnabled: false };
    }
    return { status: "started", recovered, started: 1, realPublishEnabled: false };
  } finally { locks.delete(key); }
}
