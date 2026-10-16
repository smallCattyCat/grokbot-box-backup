import { createHash } from "node:crypto";
import Link from "next/link";
import { ContextTrace } from "@/components/ContextTrace";
import { GoldenPathReview } from "@/components/GoldenPathReview";
import { ReviewActions } from "@/components/ReviewActions";
import { CommandShell } from "@/components/ui/command-shell";
import { GlassCard } from "@/components/ui/glass-card";
import { RiskBadge } from "@/components/ui/risk-badge";
import { StatusPill } from "@/components/ui/status-pill";
import { serializeAgentContextSnapshot } from "@/lib/agents/context-trace";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { interventionTypeLabels, publishTargetLabels } from "@/lib/labels";
import { isStalePublishingForReconciliation } from "@/lib/interventions/publish-service";
import { buildP4D1ReviewCase } from "@/lib/golden-path/p4d1";
import { getForumSettings } from "@/lib/settings";
import type { InterventionType, PublishTarget } from "@/lib/types";

export const dynamic = "force-dynamic";

function contentHash(content: string | null | undefined) {
  return content ? createHash("sha256").update(content).digest("hex") : undefined;
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    planned: "等待审阅",
    proposed: "正在准备",
    ready: "可以批准",
    review_required: "需要复核",
    manual_review: "需要复核",
    publishing: "正在发布",
    published: "已发布",
    failed_retryable: "可以重试",
    reconcile_required: "等待核对发布结果",
    failed: "需要处理",
    skipped: "已跳过"
  };
  return labels[status] ?? status;
}

function statusTone(status: string) {
  if (status === "published") return "emerald" as const;
  if (["failed", "failed_retryable", "manual_review", "review_required", "reconcile_required"].includes(status)) return "danger" as const;
  if (["ready", "planned"].includes(status)) return "amber" as const;
  return "muted" as const;
}

function companionLabel(value: string) {
  return interventionTypeLabels[value as InterventionType] ?? value;
}

function strategyLabel(value: string) {
  const labels: Record<string, string> = {
    cognitive_conflict: "以温和追问推动深入讨论",
    resource_connector: "连接相关资源与同伴",
    emotional_support: "承接情绪并拆解下一步",
    mixed: "先承接情绪，再提供连接线索"
  };
  return labels[value] ?? value;
}

function boundContextSnapshot<T extends { id: string }>(
  policyDecisionJson: string | null,
  snapshots: T[]
): T | null {
  if (!policyDecisionJson) return null;
  try {
    const parsed = JSON.parse(policyDecisionJson) as { contextSnapshotId?: unknown };
    return typeof parsed.contextSnapshotId === "string"
      ? snapshots.find((snapshot) => snapshot.id === parsed.contextSnapshotId) ?? null
      : null;
  } catch {
    return null;
  }
}

export default async function ReviewPage() {
  const goldenPathReview = buildP4D1ReviewCase();
  const [settings, candidates, tasks, recentPublished] = await Promise.all([
    getForumSettings(),
    prisma.autoInterventionCandidate.findMany({
      where: {
        OR: [
          { status: "planned" },
          { status: "manual_review", interventionScore: { gte: 50 } }
        ],
        post: { url: { startsWith: "http" } }
      },
      include: { post: { include: { author: true } }, run: true, task: true },
      orderBy: [{ interventionScore: "desc" }, { updatedAt: "desc" }],
      take: 40
    }),
    prisma.interventionTask.findMany({
      where: {
        status: {
          in: [
            "proposed",
            "ready",
            "review_required",
            "publishing",
            "failed_retryable",
            "reconcile_required"
          ]
        },
        post: { url: { startsWith: "http" } }
      },
      include: {
        post: true,
        targetUser: true,
        publishAttempts: {
          where: { status: "publishing" },
          orderBy: { createdAt: "desc" },
          take: 1
        },
        contextSnapshots: { orderBy: { revision: "desc" }, take: 20 }
      },
      orderBy: [{ priorityScore: "desc" }, { updatedAt: "desc" }],
      take: 40
    }),
    prisma.interventionTask.findMany({
      where: { status: "published", post: { url: { startsWith: "http" } } },
      include: { post: true, targetUser: true },
      orderBy: { publishedAt: "desc" },
      take: 8
    })
  ]);

  const unpromotedCandidates = candidates.filter((candidate) => candidate.task === null);
  const reviewCount = unpromotedCandidates.length + tasks.length;

  return (
    <div className="fade-in space-y-6">
      <CommandShell
        title="候选审阅"
        description="先完成固定候选的证据审阅、动作编辑与本地回执；下方既有任务仍受发布总开关和逐次授权约束。"
        status={
          <>
            <StatusPill label={`待处理 ${reviewCount}`} tone={reviewCount > 0 ? "amber" : "muted"} />
            <StatusPill
              label={settings.realPublishEnabled ? "发布能力已开启" : "发布能力关闭"}
              tone={settings.realPublishEnabled ? "amber" : "muted"}
            />
          </>
        }
      />

      <section aria-label="P4D-1 产品黄金路径">
        <GoldenPathReview reviewCase={goldenPathReview} />
      </section>

      {reviewCount === 0 ? (
        <GlassCard tone="success">
          <h2 className="text-lg font-semibold text-slate-50">当前没有待审阅候选</h2>
          <p className="mt-2 text-sm leading-6 text-slate-300">可以返回运行中心生成一轮新的干预预览。</p>
          <Link href="/" className="mt-4 inline-block rounded-md bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950">
            返回运行中心
          </Link>
        </GlassCard>
      ) : null}

      <section className="space-y-4" aria-label="待审阅候选">
        {unpromotedCandidates.map((candidate) => {
          const reply = candidate.finalReply ?? candidate.draftReply;
          return (
            <GlassCard
              key={`candidate-${candidate.id}`}
              tone={candidate.status === "manual_review" || candidate.status === "failed" ? "danger" : "highlight"}
            >
              <article>
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap gap-2">
                      <StatusPill label="自动巡检候选" tone="cyan" />
                      <StatusPill label={statusLabel(candidate.status)} tone={statusTone(candidate.status)} />
                      <StatusPill label={`价值分 ${Math.round(candidate.interventionScore)}`} tone="cyan" />
                      <RiskBadge value={candidate.safetyRisk ?? candidate.riskLevel} />
                    </div>
                    <h2 className="mt-3 text-xl font-semibold text-slate-50">{candidate.postTitle}</h2>
                    <p className="mt-2 text-sm text-slate-400">
                      回应对象：{candidate.post.author.name} · {candidate.targetMode === "comment_reply" ? "回复已有评论" : "回复主题帖"}
                    </p>
                  </div>
                  <ReviewActions kind="candidate" id={candidate.id} status={candidate.status} />
                </div>

                <div className="mt-5 grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
                  <section className="rounded-md border border-slate-800 bg-slate-950/35 p-4">
                    <h3 className="text-sm font-semibold text-slate-100">为什么值得回应</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-300">{candidate.reason}</p>
                    <dl className="mt-4 space-y-2 text-sm">
                      <div className="flex justify-between gap-3"><dt className="text-slate-500">学伴角色</dt><dd className="text-right text-slate-200">{companionLabel(candidate.interventionType)}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-slate-500">回应策略</dt><dd className="text-right text-slate-200">{strategyLabel(candidate.replyStrategy)}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-slate-500">安全结果</dt><dd className="text-right text-slate-200">{candidate.safetyRisk === null ? "等待校验" : candidate.safetyRisk < 50 ? "通过" : "建议复核"}</dd></div>
                    </dl>
                  </section>
                  <section className="rounded-md border border-slate-800 bg-slate-950/35 p-4">
                    <h3 className="text-sm font-semibold text-slate-100">将要发布的回复</h3>
                    <p className="mt-2 min-h-24 whitespace-pre-wrap text-sm leading-7 text-slate-200">
                      {reply ?? "尚未生成可发布正文。"}
                    </p>
                  </section>
                </div>

                <details className="mt-4 rounded-md border border-slate-800 bg-slate-950/25">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-300">查看分析证据</summary>
                  <dl className="grid gap-3 border-t border-slate-800 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div><dt className="text-slate-500">CIE 层级</dt><dd className="mt-1 text-slate-200">{candidate.cieLevel}</dd></div>
                    <div><dt className="text-slate-500">情绪线索</dt><dd className="mt-1 text-slate-200">{candidate.emotionLabel}</dd></div>
                    <div><dt className="text-slate-500">主题类型</dt><dd className="mt-1 text-slate-200">{candidate.topicType}</dd></div>
                    <div><dt className="text-slate-500">生成时间</dt><dd className="mt-1 text-slate-200">{formatDate(candidate.updatedAt)}</dd></div>
                    <div className="sm:col-span-2 lg:col-span-4">
                      <dt className="text-slate-500">原帖</dt>
                      <dd className="mt-1">
                        <a href={candidate.postUrl} target="_blank" rel="noreferrer" className="break-all text-cyan-300 hover:underline">
                          {candidate.postUrl}
                        </a>
                      </dd>
                    </div>
                  </dl>
                </details>
              </article>
            </GlassCard>
          );
        })}

        {tasks.map((task) => {
          const reply = task.finalContent ?? task.draftContent;
          const currentContext = boundContextSnapshot(
            task.policyDecisionJson,
            task.contextSnapshots
          );
          const canApprove =
            settings.realPublishEnabled &&
            Boolean(reply) &&
            task.status === "ready";
          const isStalePublishing =
            task.status === "publishing" &&
            isStalePublishingForReconciliation({
              taskUpdatedAt: task.updatedAt,
              attemptStartedAt:
                task.publishAttempts[0]?.startedAt ??
                task.publishAttempts[0]?.createdAt
            });
          const canReconcile =
            task.status === "reconcile_required" || isStalePublishing;

          return (
            <GlassCard
              key={`task-${task.id}`}
              tone={["manual_review", "review_required", "failed", "failed_retryable", "reconcile_required"].includes(task.status) ? "danger" : "default"}
            >
              <article>
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap gap-2">
                      <StatusPill label="世界模型干预计划" tone="violet" />
                      <StatusPill label={statusLabel(task.status)} tone={statusTone(task.status)} />
                      {isStalePublishing ? <StatusPill label="发布超时，需核对" tone="danger" /> : null}
                      <StatusPill label={`价值分 ${Math.round(task.priorityScore)}`} tone="cyan" />
                      <RiskBadge value={task.safetyRisk} />
                    </div>
                    <h2 className="mt-3 text-xl font-semibold text-slate-50">{task.post.title}</h2>
                    <p className="mt-2 text-sm text-slate-400">
                      回应对象：{task.targetUser.name} · {publishTargetLabels[task.publishTarget as PublishTarget] ?? task.publishTarget}
                    </p>
                  </div>
                  <ReviewActions
                    kind="task"
                    id={task.id}
                    status={task.status}
                    canPublish={canApprove}
                    canReconcile={canReconcile}
                    expectedContentHash={contentHash(reply)}
                    expectedTargetHash={task.targetHash ?? undefined}
                  />
                </div>

                <div className="mt-5 grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
                  <section className="rounded-md border border-slate-800 bg-slate-950/35 p-4">
                    <h3 className="text-sm font-semibold text-slate-100">干预计划</h3>
                    <dl className="mt-3 space-y-2 text-sm">
                      <div className="flex justify-between gap-3"><dt className="text-slate-500">学伴角色</dt><dd className="text-right text-slate-200">{companionLabel(task.interventionType)}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-slate-500">安全结果</dt><dd className="text-right text-slate-200">{task.safetyResult ?? "等待校验"}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-slate-500">更新时间</dt><dd className="text-right text-slate-200">{formatDate(task.updatedAt)}</dd></div>
                      {task.publishTarget === "comment_reply" ? (
                        <div className="border-t border-slate-800 pt-2">
                          <dt className="text-slate-500">已绑定目标评论</dt>
                          <dd className="mt-1 break-words text-slate-200">
                            {task.targetCommentPreview ?? "目标评论尚未稳定绑定，请重新生成计划。"}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  </section>
                  <section className="rounded-md border border-slate-800 bg-slate-950/35 p-4">
                    <h3 className="text-sm font-semibold text-slate-100">将要发布的回复</h3>
                    <p className="mt-2 min-h-24 whitespace-pre-wrap text-sm leading-7 text-slate-200">
                      {reply ?? "尚未生成可发布正文。"}
                    </p>
                  </section>
                </div>

                {task.errorMessage ? <p className="mt-4 text-sm text-red-300">{task.errorMessage}</p> : null}
                <ContextTrace trace={currentContext ? serializeAgentContextSnapshot(currentContext) : null} />
              </article>
            </GlassCard>
          );
        })}
      </section>

      {recentPublished.length > 0 ? (
        <details className="glass-card">
          <summary className="cursor-pointer text-lg font-semibold text-slate-50">最近发布记录</summary>
          <div className="mt-4 divide-y divide-slate-800">
            {recentPublished.map((task) => (
              <div key={task.id} className="flex flex-col gap-2 py-3 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold text-slate-100">{task.post.title}</p>
                  <p className="mt-1 text-xs text-slate-400">{task.targetUser.name} · {formatDate(task.publishedAt)}</p>
                </div>
                {task.publishedUrl ? (
                  <a href={task.publishedUrl} target="_blank" rel="noreferrer" className="text-sm text-cyan-300 hover:underline">
                    查看发布结果
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
