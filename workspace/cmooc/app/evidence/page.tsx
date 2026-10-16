import { ContextTrace } from "@/components/ContextTrace";
import { ResearchDetailPanel } from "@/components/ResearchDetailPanel";
import { CommandShell } from "@/components/ui/command-shell";
import { GlassCard } from "@/components/ui/glass-card";
import { StatusPill } from "@/components/ui/status-pill";
import { serializeAgentContextSnapshot } from "@/lib/agents/context-trace";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { interventionTypeLabels } from "@/lib/labels";
import type { InterventionType } from "@/lib/types";

export const dynamic = "force-dynamic";

const RESEARCH_DIGEST_ENDPOINT = "/api/operator/research?format=digest";
const RESEARCH_DETAIL_ENDPOINT = "/api/operator/research";
const FULL_STATUS_ENDPOINT = "/api/operator/status?detail=full";

const roleDefinitions = [
  {
    id: "observer",
    label: "世界状态智能体",
    description: "保存论坛快照、学习者状态与社区连接结构。",
    names: ["global-monitor", "forum-ingestion", "forum-ingestion-agent", "user-profile-sync", "social-network-sync", "cie-classifier", "interaction-analyzer"]
  },
  {
    id: "policy",
    label: "干预策略智能体",
    description: "识别有价值但尚未被承接的互动并确定优先级。",
    names: ["value-detector", "intervention-score", "scheduler-agent"]
  },
  {
    id: "companion",
    label: "学伴表达智能体",
    description: "根据情境和角色策略生成具体回应。",
    names: ["expression-agent", "auto-reply-agent", "mental-state-agent", "narrative-agent"]
  },
  {
    id: "safety",
    label: "安全与审批智能体",
    description: "校验内容、目标、风险和授权边界。",
    names: ["safety-agent"]
  },
  {
    id: "publisher",
    label: "发布与证据智能体",
    description: "执行幂等发布并保存链接、截图和运行记录。",
    names: ["publish-agent", "agent-console", "multi-companion"]
  }
] as const;

function conceptualRole(agentName: string) {
  return roleDefinitions.find((role) => role.names.some((name) => agentName.includes(name))) ?? roleDefinitions[4];
}

function runStatusLabel(status: string) {
  if (status === "success" || status === "completed") return "完成";
  if (status === "running") return "运行中";
  if (status === "failed") return "异常";
  return status;
}

export default async function EvidencePage() {
  const [runs, companions, autoRuns, snapshotCount, latestContext] = await Promise.all([
    prisma.agentRun.findMany({
      include: { post: true, task: true },
      orderBy: { startedAt: "desc" },
      take: 50
    }),
    prisma.companionProfile.findMany({ orderBy: { type: "asc" } }),
    prisma.autoInterventionRun.findMany({
      include: { candidates: { select: { id: true, status: true } } },
      orderBy: { createdAt: "desc" },
      take: 12
    }),
    prisma.agentContextSnapshot.count(),
    prisma.agentContextSnapshot.findFirst({ orderBy: { createdAt: "desc" } })
  ]);

  const successfulRuns = runs.filter((run) => run.status === "success" || run.status === "completed").length;
  const failedRuns = runs.filter((run) => run.status === "failed").length;

  return (
    <div className="fade-in space-y-6">
      <CommandShell
        title="研究与运行证据"
        description="这里集中保存世界状态、干预决策、学伴角色、安全校验和发布结果。默认显示可读摘要，原始记录只在需要核查时展开。"
        status={
          <>
            <StatusPill label={`最近运行 ${runs.length}`} tone="cyan" />
            <StatusPill label={`成功 ${successfulRuns}`} tone="emerald" />
            <StatusPill label={`异常 ${failedRuns}`} tone={failedRuns > 0 ? "danger" : "muted"} />
          </>
        }
      />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {roleDefinitions.map((role) => {
          const count = runs.filter((run) => conceptualRole(run.agentName).id === role.id).length;
          return (
            <GlassCard key={role.id}>
              <p className="text-sm font-semibold text-slate-100">{role.label}</p>
              <p className="mt-2 text-3xl font-black text-cyan-200">{count}</p>
              <p className="mt-2 text-xs leading-5 text-slate-400">{role.description}</p>
            </GlassCard>
          );
        })}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
        <GlassCard tone="highlight">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-50">研究算法证据</h2>
              <p className="mt-1 text-sm leading-6 text-slate-400">图小波、社会网络、编码一致性与观测趋势按需读取，不阻塞日常巡检。</p>
            </div>
            <StatusPill label="按需读取" tone="muted" />
          </div>
          <ResearchDetailPanel
            digestEndpoint={RESEARCH_DIGEST_ENDPOINT}
            detailEndpoint={RESEARCH_DETAIL_ENDPOINT}
            fullStatusEndpoint={FULL_STATUS_ENDPOINT}
          />
        </GlassCard>

        <GlassCard>
          <h2 className="text-lg font-semibold text-slate-50">世界模型情境快照</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            系统已保存 {snapshotCount} 份“观察—推断—表达”快照，用于复核每次学伴回应依据。
          </p>
          <ContextTrace trace={latestContext ? serializeAgentContextSnapshot(latestContext) : null} />
        </GlassCard>
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
        <GlassCard>
          <h2 className="text-lg font-semibold text-slate-50">学伴角色策略</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">角色画像是世界模型的外显表达策略，不把临时调节状态解释为稳定人格。</p>
          <div className="mt-4 divide-y divide-slate-800">
            {companions.map((companion) => (
              <details key={companion.id} className="py-3 first:pt-0">
                <summary className="cursor-pointer list-none">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-100">{companion.name}</p>
                      <p className="mt-1 text-xs text-slate-400">
                        {interventionTypeLabels[companion.type as InterventionType] ?? companion.type} · {companion.tone}
                      </p>
                    </div>
                    <span className="text-xs text-cyan-300">展开</span>
                  </div>
                </summary>
                <div className="mt-3 space-y-2 rounded-md bg-slate-950/40 p-3 text-sm leading-6 text-slate-300">
                  <p>{companion.persona}</p>
                  <p><b className="text-slate-100">角色边界：</b>{companion.roleBoundary}</p>
                </div>
              </details>
            ))}
            {companions.length === 0 ? <p className="py-3 text-sm text-slate-400">暂无学伴角色记录。</p> : null}
          </div>
        </GlassCard>

        <GlassCard>
          <h2 className="text-lg font-semibold text-slate-50">最近巡检批次</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead>
                <tr>
                  <th className="px-3 py-3">时间</th>
                  <th className="px-3 py-3">结果</th>
                  <th className="px-3 py-3">候选</th>
                  <th className="px-3 py-3">运行边界</th>
                </tr>
              </thead>
              <tbody>
                {autoRuns.map((run) => (
                  <tr key={run.id} className="border-t border-slate-800">
                    <td className="px-3 py-3">{formatDate(run.createdAt)}</td>
                    <td className="px-3 py-3">{runStatusLabel(run.status)}</td>
                    <td className="px-3 py-3">{run.candidates.length}</td>
                    <td className="px-3 py-3">{run.mode === "dry_run" ? "只生成预览" : "历史发布批次"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {autoRuns.length === 0 ? <p className="py-4 text-sm text-slate-400">暂无巡检批次。</p> : null}
          </div>
        </GlassCard>
      </section>

      <GlassCard>
        <h2 className="text-lg font-semibold text-slate-50">智能体运行记录</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">名称已归并到五类研究角色；如需审计，可展开查看原始输入输出。</p>
        <div className="mt-4 divide-y divide-slate-800">
          {runs.map((run) => {
            const role = conceptualRole(run.agentName);
            return (
              <details key={run.id} className="py-3 first:pt-0">
                <summary className="cursor-pointer list-none">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap gap-2">
                        <StatusPill label={role.label} tone="cyan" />
                        <StatusPill
                          label={runStatusLabel(run.status)}
                          tone={run.status === "failed" ? "danger" : run.status === "success" ? "emerald" : "muted"}
                        />
                      </div>
                      {run.post ? <p className="mt-2 truncate text-sm text-slate-300">{run.post.title}</p> : null}
                    </div>
                    <time className="text-xs text-slate-500">{formatDate(run.startedAt)}</time>
                  </div>
                </summary>
                <div className="mt-3 rounded-md border border-slate-800 bg-slate-950/40 p-3">
                  <p className="text-xs text-slate-500">内部步骤：{run.agentName}</p>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-semibold text-slate-300">查看原始记录</summary>
                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                      <pre className="max-h-80 overflow-auto rounded-md p-3 text-xs">{run.inputJson}</pre>
                      <pre className="max-h-80 overflow-auto rounded-md p-3 text-xs">{run.outputJson}</pre>
                    </div>
                  </details>
                </div>
              </details>
            );
          })}
          {runs.length === 0 ? <p className="py-4 text-sm text-slate-400">暂无智能体运行记录。</p> : null}
        </div>
      </GlassCard>
    </div>
  );
}
