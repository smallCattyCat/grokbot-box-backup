"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

type AutoInterventionFormProps = {
  defaultForumListUrl: string;
  realPublishEnabled: boolean;
  compact?: boolean;
};

type SchedulerStatus = {
  running: boolean;
  isExecuting: boolean;
  config: {
    intervalMinutes: number;
  } | null;
  nextRunAt: string | null;
  lastFinishedAt: string | null;
  lastRunId: string | null;
  lastResult: {
    scannedCount: number;
    candidateCount: number;
    dryRunReadyCount: number;
    failedCount: number;
  } | null;
  lastError: string | null;
};

type RunResult = {
  runId?: string;
  scannedCount: number;
  candidateCount: number;
  dryRunReadyCount: number;
  failedCount?: number;
};

function formatTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

export function AutoInterventionForm({ defaultForumListUrl, realPublishEnabled }: AutoInterventionFormProps) {
  const router = useRouter();
  const [forumListUrl, setForumListUrl] = useState(defaultForumListUrl);
  const [maxScanPosts, setMaxScanPosts] = useState(10);
  const [minScoreToPublish, setMinScoreToPublish] = useState(75);
  const [intervalMinutes, setIntervalMinutes] = useState(30);
  const [message, setMessage] = useState("等待生成预览。");
  const [schedulerMessage, setSchedulerMessage] = useState("");
  const [runEvidence, setRunEvidence] = useState<RunResult | null>(null);
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | null>(null);
  const [schedulerPending, setSchedulerPending] = useState(false);
  const [pending, startTransition] = useTransition();

  async function refreshSchedulerStatus() {
    const response = await fetch("/api/auto-intervention/scheduler", { cache: "no-store" });
    if (!response.ok) return;
    setSchedulerStatus((await response.json()) as SchedulerStatus);
  }

  useEffect(() => {
    void refreshSchedulerStatus();
    const timer = window.setInterval(() => void refreshSchedulerStatus(), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  function createPreview() {
    setMessage("正在扫描论坛、分析互动并生成候选预览…");
    setRunEvidence(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/auto-intervention/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            forumListUrl,
            maxScanPosts,
            minScoreToPublish
          })
        });
        const payload = await response.json();
        if (!response.ok) {
          setMessage(payload.error || "预览生成失败，请查看运行证据。");
          return;
        }
        setRunEvidence(payload);
        setMessage(
          payload.dryRunReadyCount > 0
            ? `已生成 ${payload.dryRunReadyCount} 条可审阅候选。`
            : `本轮扫描 ${payload.scannedCount} 条，暂未发现达到阈值的候选。`
        );
        router.refresh();
      } catch {
        setMessage("无法连接运行服务，请确认系统已经启动。");
      }
    });
  }

  async function controlScheduler(action: "start" | "stop" | "run_once") {
    setSchedulerPending(true);
    setSchedulerMessage(action === "stop" ? "正在停止周期预览…" : "正在更新周期预览…");
    try {
      const response = await fetch("/api/auto-intervention/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          forumListUrl,
          maxScanPosts,
          minScoreToPublish,
          intervalMinutes,
          runImmediately: false
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        setSchedulerMessage(payload.error || "周期预览更新失败。");
        return;
      }
      setSchedulerStatus(payload);
      setSchedulerMessage(
        action === "stop"
          ? "周期预览已停止。"
          : action === "run_once"
            ? "已触发一轮预览。"
            : "周期预览已启动。"
      );
      router.refresh();
    } catch {
      setSchedulerMessage("无法连接周期预览服务。");
    } finally {
      setSchedulerPending(false);
    }
  }

  const schedulerRunning = Boolean(schedulerStatus?.running);
  const fieldClass =
    "mt-2 w-full rounded-md border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400";

  return (
    <section
      className="space-y-5 rounded-lg border border-slate-700/70 bg-slate-950/60 p-5 shadow-2xl shadow-black/20"
      data-testid="auto-intervention-form"
      data-default-mode="dry_run"
      data-default-allow-real-publish="false"
      aria-busy={pending || schedulerPending}
    >
      <div>
        <h2 className="text-lg font-semibold text-slate-50">生成一轮干预预览</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
          系统会自动完成扫描、价值判断、学伴选择、回复生成与安全校验。这里不会直接向论坛发布内容。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="operator-run-dry-run"
          data-agent-action="safe-dry-run"
          data-action-category="safe_dry_run"
          data-requires-confirmation="false"
          disabled={pending}
          onClick={createPreview}
          className="rounded-md bg-cyan-400 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:cursor-wait disabled:opacity-60"
        >
          {pending ? "正在生成…" : "生成一轮干预预览"}
        </button>
        <Link href="/review" className="rounded-md border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:border-cyan-300 hover:text-cyan-200">
          查看待审阅候选
        </Link>
      </div>

      <p
        data-testid="operator-run-message"
        role="status"
        aria-live="polite"
        aria-busy={pending}
        className="text-sm text-slate-300"
      >
        {message}
      </p>

      {runEvidence ? (
        <div
          data-testid="operator-run-evidence"
          data-run-id={runEvidence.runId ?? ""}
          className="grid gap-2 rounded-md border border-slate-800 bg-slate-950/45 p-3 text-sm text-slate-300 sm:grid-cols-4"
        >
          <span>扫描 <b>{runEvidence.scannedCount}</b></span>
          <span>发现候选 <b>{runEvidence.candidateCount}</b></span>
          <span>可审阅 <b>{runEvidence.dryRunReadyCount}</b></span>
          <span>异常 <b>{runEvidence.failedCount ?? 0}</b></span>
        </div>
      ) : null}

      <details className="rounded-md border border-slate-800 bg-slate-950/30">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-200">
          高级巡检与周期预览
        </summary>
        <div className="space-y-5 border-t border-slate-800 p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="md:col-span-2">
              <span className="text-sm font-semibold text-slate-200">论坛入口</span>
              <input
                data-testid="operator-forum-list-url"
                aria-label="论坛入口"
                value={forumListUrl}
                onChange={(event) => setForumListUrl(event.target.value)}
                className={fieldClass}
              />
            </label>
            <label>
              <span className="text-sm font-semibold text-slate-200">每轮最多扫描</span>
              <input
                data-testid="operator-max-scan-posts"
                aria-label="每轮最多扫描"
                type="number"
                min={1}
                value={maxScanPosts}
                onChange={(event) => setMaxScanPosts(Number(event.target.value))}
                className={fieldClass}
              />
            </label>
            <label>
              <span className="text-sm font-semibold text-slate-200">候选最低分</span>
              <input
                data-testid="operator-min-score"
                aria-label="候选最低分"
                type="number"
                min={0}
                max={100}
                value={minScoreToPublish}
                onChange={(event) => setMinScoreToPublish(Number(event.target.value))}
                className={fieldClass}
              />
            </label>
          </div>

          <div className="border-t border-slate-800 pt-4" data-testid="operator-scheduler-panel">
            <div className="flex flex-col gap-3 md:flex-row md:items-end">
              <label className="w-full md:max-w-xs">
                <span className="text-sm font-semibold text-slate-200">预览间隔（分钟）</span>
                <input
                  data-testid="operator-scheduler-interval-minutes"
                  aria-label="预览间隔分钟"
                  type="number"
                  min={1}
                  value={intervalMinutes}
                  onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                  className={fieldClass}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="operator-scheduler-start-dry-run"
                  disabled={schedulerPending || schedulerRunning}
                  onClick={() => controlScheduler("start")}
                  className="rounded-md border border-cyan-400/50 px-4 py-2 text-sm font-semibold text-cyan-200 disabled:opacity-50"
                >
                  启动周期预览
                </button>
                <button
                  type="button"
                  data-testid="operator-scheduler-run-once"
                  disabled={schedulerPending}
                  onClick={() => controlScheduler("run_once")}
                  className="rounded-md border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 disabled:opacity-50"
                >
                  立即预览一次
                </button>
                <button
                  type="button"
                  data-testid="operator-scheduler-stop"
                  disabled={schedulerPending || !schedulerRunning}
                  onClick={() => controlScheduler("stop")}
                  className="rounded-md border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 disabled:opacity-50"
                >
                  停止
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-2 rounded-md bg-slate-950/50 p-3 text-xs text-slate-400 sm:grid-cols-2">
              <div>状态：{schedulerRunning ? "周期预览中" : "未启动"}{schedulerStatus?.isExecuting ? " · 正在执行" : ""}</div>
              <div>下次预览：{formatTime(schedulerStatus?.nextRunAt)}</div>
              <div>最近完成：{formatTime(schedulerStatus?.lastFinishedAt)}</div>
              <div>最近记录：{schedulerStatus?.lastRunId ?? "—"}</div>
              {schedulerStatus?.lastResult ? (
                <div className="sm:col-span-2">
                  最近结果：扫描 {schedulerStatus.lastResult.scannedCount}，候选 {schedulerStatus.lastResult.candidateCount}，可审阅 {schedulerStatus.lastResult.dryRunReadyCount}。
                </div>
              ) : null}
              {schedulerStatus?.lastError ? <div className="sm:col-span-2 text-red-300">{schedulerStatus.lastError}</div> : null}
            </div>
            <p role="status" aria-live="polite" className="mt-3 text-sm text-slate-300">
              {schedulerMessage || "周期模式同样只生成预览，不会自动发布。"}
            </p>
          </div>
        </div>
      </details>

      <p className="text-xs text-slate-500">
        {realPublishEnabled
          ? "系统发布能力已开启，但每条内容仍须在审阅页单独批准。"
          : "系统发布能力当前关闭；你仍可完整生成和审阅候选。"}
      </p>
    </section>
  );
}
