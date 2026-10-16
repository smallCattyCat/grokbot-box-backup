"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type ReviewActionsProps =
  | {
      kind: "candidate";
      id: string;
      status: string;
    }
  | {
      kind: "task";
      id: string;
      status: string;
      canPublish: boolean;
      canReconcile: boolean;
      expectedContentHash?: string;
      expectedTargetHash?: string;
    };

async function readPayload(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || "操作未完成。");
  }
  return payload;
}

export function ReviewActions(props: ReviewActionsProps) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();

  async function authorizeAndPublish(taskId: string, expectedContentHash?: string) {
    const authorizationResponse = await fetch(`/api/interventions/${taskId}/authorize-publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedContentHash,
        expectedTargetHash: props.kind === "task"
          ? props.expectedTargetHash
          : undefined,
        expiresInMinutes: 10,
        confirmed: true,
        confirmationText: "我已核对当前目标与当前回复正文"
      })
    });
    await readPayload(authorizationResponse);

    const publishResponse = await fetch(`/api/interventions/${taskId}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    await readPayload(publishResponse);
  }

  function prepare() {
    setMessage("正在生成情境化回复并完成安全校验…");
    startTransition(async () => {
      try {
        const response = await fetch(`/api/interventions/${props.id}/draft`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        });
        await readPayload(response);
        setMessage("回复与安全校验已更新。");
        router.refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "回复生成未完成。");
      }
    });
  }

  function promoteForReview() {
    setMessage("正在固化为可复核计划…");
    startTransition(async () => {
      try {
        const response = await fetch(`/api/auto-intervention/candidates/${props.id}/promote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        });
        await readPayload(response);
        setMessage("候选已转为可复核计划。");
        router.refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "候选转换未完成。");
      }
    });
  }

  function skipCandidate() {
    if (props.kind !== "candidate") return;
    if (!window.confirm("确认忽略这条候选？它不会生成计划或发布。")) return;
    setMessage("正在忽略候选…");
    startTransition(async () => {
      try {
        const response = await fetch(`/api/auto-intervention/candidates/${props.id}/skip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "研究者在候选审阅阶段决定不干预。" })
        });
        await readPayload(response);
        setMessage("候选已忽略。");
        router.refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "候选未能忽略。");
      }
    });
  }

  function approveTask() {
    if (props.kind !== "task") return;
    if (!props.canPublish) {
      setMessage("发布能力尚未开启；可以继续审阅，但不能写入论坛。");
      return;
    }
    if (!window.confirm("确认发布当前页面显示的目标与回复正文？批准仅对这份内容有效。")) return;

    setMessage("正在固化计划并发布…");
    startTransition(async () => {
      try {
        await authorizeAndPublish(props.id, props.expectedContentHash);
        setMessage("已提交发布并保存证据。");
        router.refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "操作未完成。");
      }
    });
  }

  function skipTask() {
    if (props.kind !== "task") return;
    if (!window.confirm("确认跳过这条干预计划？它不会被发布。")) return;
    setMessage("正在归档该计划…");
    startTransition(async () => {
      try {
        const response = await fetch(`/api/interventions/${props.id}/skip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        });
        await readPayload(response);
        setMessage("计划已跳过。");
        router.refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "计划未能跳过。");
      }
    });
  }

  function reconcile(resolution: "published" | "not_published") {
    if (props.kind !== "task") return;
    const promptText = resolution === "published"
      ? "请填写你在论坛中确认已发布的依据（例如回复开头或评论数量）："
      : "请填写你在论坛中确认未发布的依据：";
    const evidenceNote = window.prompt(promptText)?.trim();
    if (!evidenceNote) return;
    const confirmation = resolution === "published"
      ? "确认论坛中已经存在这条回复？系统会把任务记为已发布。"
      : "确认论坛中没有这条回复？之后才能重新生成和重试。";
    if (!window.confirm(confirmation)) return;
    setMessage("正在保存人工核对结果…");
    startTransition(async () => {
      try {
        const response = await fetch(`/api/interventions/${props.id}/reconcile`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resolution,
            evidenceNote,
            confirmed: true
          })
        });
        await readPayload(response);
        setMessage("人工核对结果已保存。");
        router.refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "核对结果未能保存。");
      }
    });
  }

  if (props.kind === "task" && ["proposed", "failed_retryable", "review_required"].includes(props.status)) {
    const label = props.status === "review_required" ? "重新生成并校验" : "生成可审阅回复";
    return (
      <div className="min-w-0">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={prepare}
            disabled={pending}
            className="rounded-md border border-cyan-400/60 px-4 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-400 hover:text-slate-950 disabled:cursor-wait disabled:opacity-50"
          >
            {pending ? "生成中…" : label}
          </button>
          <button
            type="button"
            onClick={skipTask}
            disabled={pending}
            className="rounded-md border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:border-slate-500 disabled:opacity-50"
          >
            跳过
          </button>
        </div>
        <p role="status" aria-live="polite" className="mt-2 max-w-sm text-xs leading-5 text-slate-400">
          {message || "世界状态、学伴表达与安全校验会在后台自动完成。"}
        </p>
      </div>
    );
  }

  if (props.kind === "candidate") {
    return (
      <div className="min-w-0">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={promoteForReview}
            disabled={pending}
            className="rounded-md border border-amber-400/60 px-4 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-400 hover:text-slate-950 disabled:cursor-wait disabled:opacity-50"
          >
            {pending ? "处理中…" : "生成最终审阅计划"}
          </button>
          <button
            type="button"
            onClick={skipCandidate}
            disabled={pending}
            className="rounded-md border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:border-slate-500 disabled:opacity-50"
          >
            忽略
          </button>
        </div>
        <p role="status" aria-live="polite" className="mt-2 max-w-sm text-xs leading-5 text-slate-400">
          {message || "候选不会直接发布；系统固化最终正文后，请重新审阅再批准。"}
        </p>
      </div>
    );
  }

  if (props.kind === "task" && props.canReconcile) {
    return (
      <div className="min-w-0">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => reconcile("published")}
            disabled={pending}
            className="rounded-md border border-emerald-400/60 px-4 py-2 text-sm font-semibold text-emerald-200 disabled:opacity-50"
          >
            确认已发布
          </button>
          <button
            type="button"
            onClick={() => reconcile("not_published")}
            disabled={pending}
            className="rounded-md border border-amber-400/60 px-4 py-2 text-sm font-semibold text-amber-200 disabled:opacity-50"
          >
            确认未发布
          </button>
        </div>
        <p role="status" aria-live="polite" className="mt-2 max-w-sm text-xs leading-5 text-slate-400">
          {message || (
            props.status === "publishing"
              ? "发布进程已超时。请先打开原帖核对实际结果；系统不会自动重发。"
              : "请先打开原帖核对实际结果；系统不会自动重发。"
          )}
        </p>
      </div>
    );
  }

  if (props.kind === "task" && props.status !== "ready") {
    const hint =
      props.status === "reconcile_required"
        ? "远端结果尚不确定，请先核对论坛和证据记录。"
        : props.status === "publishing"
          ? "发布正在执行，请勿重复操作；若 5 分钟后仍无结果，刷新页面进入人工核对。"
          : "当前任务没有可执行的人工操作。";
    return <p className="max-w-sm text-xs leading-5 text-slate-400">{hint}</p>;
  }

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={approveTask}
          disabled={pending || !props.canPublish}
          className="rounded-md bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {pending ? "处理中…" : "批准并发布"}
        </button>
        <button
          type="button"
          onClick={skipTask}
          disabled={pending}
          className="rounded-md border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:border-slate-500 disabled:opacity-50"
        >
          跳过
        </button>
      </div>
      <p role="status" aria-live="polite" className="mt-2 max-w-sm text-xs leading-5 text-slate-400">
        {message || (props.canPublish ? "授权只绑定当前目标和正文，内容变化后会自动失效。" : "发布能力关闭；请先在设置页开启。")}
      </p>
    </div>
  );
}
