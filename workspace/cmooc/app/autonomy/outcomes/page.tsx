import { CommandShell } from "@/components/ui/command-shell";
import { GlassCard } from "@/components/ui/glass-card";
import { CockpitMetricCard } from "@/components/ui/metric-card";
import { StatusPill } from "@/components/ui/status-pill";
import {
  autonomyDate,
  compactHash,
  parseSafeOutcomeEvidenceSummary
} from "@/lib/autonomy/read-model";
import { formatCourseLabel } from "@/lib/autonomy/run-operator-presentation";
import { loadVerifiedOperatorCourseNames } from "@/lib/autonomy/operator-course-name";
import {
  preflightDueProximalOutcomes
} from "@/lib/autonomy/outcome-observer";
import { prisma } from "@/lib/db";
import { REAL_FORUM_WRITE_LOCKED } from "@/lib/forum/real-write-lock";

export const dynamic = "force-dynamic";

const outcomeStatusLabel: Record<string, string> = {
  pending: "待观察",
  observed: "已观察",
  censored: "覆盖不足"
};

function humanOutcomeStatus(status: string) {
  return outcomeStatusLabel[status] ?? "未识别状态";
}

function humanPreflightStatus(
  status: string | undefined
) {
  const labels: Record<string, string> = {
    ready: "证据可核对",
    waiting_for_coverage: "等待数据补齐",
    would_censor: "继续等待"
  };
  return status ? labels[status] ?? "状态待核查" : "尚未到期";
}

function humanEvidenceSource(
  value: string | null | undefined
) {
  if (value === "full_course") return "完整课程数据";
  if (value === "target_thread") return "目标讨论数据";
  return "暂无合格数据";
}

function humanObservationWindow(value: string): string {
  if (value === "R24") return "24 小时";
  if (value === "R72") return "72 小时";
  return value || "观察窗口";
}

function humanMissingReason(value: string | null): string {
  if (!value) return "未标记覆盖不足";
  const labels: Record<string, string> = {
    source_censored: "来源数据不完整",
    target_thread_censored: "目标讨论数据不完整",
    coverage_incomplete: "覆盖范围尚未补齐",
    target_missing: "目标内容暂不可核对"
  };
  return labels[value] ?? "原因已记录，等待核查";
}

export default async function AutonomyOutcomesPage() {
  const [
    outcomes,
    groups,
    publishEnabledManifestCount,
    preflight
  ] =
    await Promise.all([
      prisma.proximalOutcome.findMany({
        orderBy: { dueAt: "desc" },
        take: 80,
        include: {
          decision: {
            select: {
              courseAlias: true
            }
          }
        }
      }),
      prisma.proximalOutcome.groupBy({
        by: ["status"],
        _count: { _all: true }
      }),
      prisma.autonomyCourseManifest.count({
        where: { realPublishEnabled: true }
      }),
      preflightDueProximalOutcomes({ prisma }).catch(() => ({
        counts: {
          due: 0,
          ready: 0,
          waitingForCoverage: 0,
          wouldCensor: 0
        },
        outcomes: []
      }))
    ]);
  const counts = Object.fromEntries(
    groups.map((item) => [item.status, item._count._all])
  );
  const courseNames = await loadVerifiedOperatorCourseNames(
    Array.from(
      new Set(outcomes.map((outcome) => outcome.decision.courseAlias))
    )
  );
  const realPublishLocked =
    REAL_FORUM_WRITE_LOCKED || publishEnabledManifestCount === 0;
  const preflightByOutcomeId = new Map(
    preflight.outcomes.map((item) => [item.outcomeId, item])
  );

  return (
    <div className="fade-in space-y-6">
      <CommandShell
        variant="operational"
        testId="outcomes-masthead"
        eyebrow="课程结果 · 只读观察"
        title="结果观察"
        description="只有真实确认发布的动作才有资格进入观察窗口；这里记录的是去正文的近端过程信号，不是教育效果或因果结论。"
        status={
          <>
            <StatusPill label="仅真实确认发布有资格" tone="cyan" />
            <StatusPill label="非因果观察" tone="violet" />
            <StatusPill
              label={
                realPublishLocked
                  ? "真实发布关闭"
                  : "发布门已核验"
              }
              tone={realPublishLocked ? "emerald" : "amber"}
            />
          </>
        }
      />

      {outcomes.length === 0 ? (
        <GlassCard
          tone={realPublishLocked ? "success" : "default"}
          className="p-6 sm:p-8"
        >
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(250px,0.7fr)] lg:items-start">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">
                观察边界完整
              </p>
              <h2 className="mt-2 text-xl font-semibold text-slate-50">
                当前没有合格的近端结果窗口
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
                {realPublishLocked
                  ? "真实发布仍处于关闭状态，系统不会把只读运行、编辑器演练或离线记录登记为真实结果。没有空表格需要解读；这正是当前开发边界的预期状态。"
                  : "尚未出现同时满足许可、确认发布和观察窗口条件的执行。页面会在合格窗口建立后，才展示去正文的近端观察回执。"}
              </p>
            </div>
            <div className="rounded-md border border-slate-700/80 bg-slate-950/35 p-4">
              <h3 className="font-semibold text-slate-100">进入此视图的条件</h3>
              <ul className="mt-3 space-y-2 text-sm leading-5 text-slate-300">
                <li>1. 课程、策略与单动作许可均有效。</li>
                <li>2. 真实动作已确认发布并绑定回执。</li>
                <li>3. 24 / 72 小时窗口到期后以只读方式观察。</li>
              </ul>
              <p className="mt-4 border-t border-slate-800 pt-3 text-xs leading-5 text-slate-400">
                这类回执记录近端过程信号与覆盖不足，不单独构成学习效果或因果结论。
              </p>
            </div>
          </div>
        </GlassCard>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <CockpitMetricCard
              label="待观察"
              value={counts.pending ?? 0}
              hint="到期后只读回访"
              tone="cyan"
            />
            <CockpitMetricCard
              label="已完成观察"
              value={counts.observed ?? 0}
              hint="已形成近端回执"
              tone="emerald"
            />
            <CockpitMetricCard
              label="覆盖不足"
              value={counts.censored ?? 0}
              hint="保留原因，不能补作完整观察"
              tone="amber"
            />
            <CockpitMetricCard
              label="全部窗口"
              value={outcomes.length}
              hint="页面最多显示 80 条"
              tone="violet"
            />
          </section>

          <GlassCard tone="highlight" className="p-5 sm:p-6">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <div>
                <h2 className="text-lg font-semibold text-slate-50">
                  到期窗口只按证据就绪状态核对
                </h2>
                <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-300">
                  预检只读取本地去正文事件账本。只有完整课程数据，或目标讨论的根事件与评论范围可共同核验时，窗口才会进入只读观察；其余窗口继续等待，不会被系统强行标记为完整。
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-sm sm:grid-cols-4 lg:text-right">
                <div><dt className="text-slate-500">已到期</dt><dd className="mt-1 font-semibold text-slate-100">{preflight.counts.due}</dd></div>
                <div><dt className="text-slate-500">可核对</dt><dd className="mt-1 font-semibold text-emerald-200">{preflight.counts.ready}</dd></div>
                <div><dt className="text-slate-500">等待覆盖</dt><dd className="mt-1 font-semibold text-cyan-200">{preflight.counts.waitingForCoverage}</dd></div>
                <div><dt className="text-slate-500">继续等待</dt><dd className="mt-1 font-semibold text-amber-200">{preflight.counts.wouldCensor}</dd></div>
              </dl>
            </div>
          </GlassCard>

          <GlassCard className="p-0">
            <div className="border-b border-slate-800 px-4 py-4 sm:px-5">
              <h2 className="text-lg font-semibold text-slate-50">
                已确认发布后的近端观察
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                默认只展示课程结果、观察窗口、聚合信号和证据来源；核查信息按行展开，不展示发布内容、身份或平台标识。
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-left text-sm">
                <caption className="sr-only">
                  已确认发布后的近端观察；表格只包含去正文的聚合信号、状态和可理解的覆盖信息。
                </caption>
                <thead className="border-b border-slate-700 text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th scope="col" className="px-4 py-3">课程</th>
                    <th scope="col" className="px-4 py-3">窗口</th>
                    <th scope="col" className="px-4 py-3">状态</th>
                    <th scope="col" className="px-4 py-3">证据来源</th>
                    <th scope="col" className="px-4 py-3">到期</th>
                    <th scope="col" className="px-4 py-3">观察时间</th>
                    <th scope="col" className="px-4 py-3">作者返回</th>
                    <th scope="col" className="px-4 py-3">深度</th>
                    <th scope="col" className="px-4 py-3">新参与者</th>
                    <th scope="col" className="px-4 py-3">覆盖状态</th>
                    <th scope="col" className="px-4 py-3">核查信息</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {outcomes.map((outcome) => {
                    const pendingPreflight =
                      preflightByOutcomeId.get(outcome.id);
                    const receipt =
                      parseSafeOutcomeEvidenceSummary(
                        outcome.functionUptakeJson
                      );
                    const evidenceSource =
                      receipt?.evidenceSource ??
                      pendingPreflight?.evidenceSource;
                    return (
                    <tr key={outcome.id} className="align-top">
                      <td className="px-4 py-4 text-xs font-semibold text-slate-200">
                        {formatCourseLabel(outcome.decision.courseAlias, courseNames)}
                      </td>
                      <td className="px-4 py-4 font-semibold text-cyan-200">
                        {humanObservationWindow(outcome.observationWindow)}
                      </td>
                      <td className="px-4 py-4">
                        <p className="text-slate-200">
                          {humanOutcomeStatus(outcome.status)}
                        </p>
                      </td>
                      <td className="px-4 py-4 text-xs text-slate-300">
                        <p>{humanEvidenceSource(evidenceSource)}</p>
                      </td>
                      <td className="whitespace-nowrap px-4 py-4 text-xs text-slate-400">
                        {autonomyDate(outcome.dueAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-4 text-xs text-slate-300">
                        {autonomyDate(outcome.observedAt)}
                      </td>
                      <td className="px-4 py-4 text-slate-200">
                        {outcome.authorReturned === null
                          ? "—"
                          : outcome.authorReturned
                            ? "是"
                            : "否"}
                      </td>
                      <td className="px-4 py-4 text-slate-200">
                        {outcome.replyDepthDelta ?? "—"}
                      </td>
                      <td className="px-4 py-4 text-slate-200">
                        {outcome.newAuthorCount ?? "—"}
                      </td>
                      <td className="px-4 py-4 text-xs text-slate-300">
                        {outcome.censored || outcome.status === "censored"
                          ? humanMissingReason(outcome.missingReason)
                          : "数据可核对"}
                      </td>
                      <td className="px-4 py-4 text-xs text-slate-400">
                        <details>
                          <summary className="cursor-pointer list-none font-semibold text-slate-300 outline-none transition hover:text-slate-100 focus-visible:ring-2 focus-visible:ring-cyan-400/70">
                            核查信息
                          </summary>
                          <dl className="mt-3 space-y-2 border-t border-slate-800 pt-3 leading-5">
                            <div>
                              <dt className="text-slate-500">原始状态</dt>
                              <dd className="font-mono text-[11px] text-slate-300">
                                {outcome.status}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-slate-500">观察窗口原值</dt>
                              <dd className="font-mono text-[11px] text-slate-300">
                                {outcome.observationWindow}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-slate-500">预检</dt>
                              <dd>{humanPreflightStatus(pendingPreflight?.status)}</dd>
                            </div>
                            <div>
                              <dt className="text-slate-500">首次外部回应</dt>
                              <dd>{autonomyDate(outcome.firstExternalReplyAt)}</dd>
                            </div>
                            <div>
                              <dt className="text-slate-500">事件前缀</dt>
                              <dd className="font-mono text-[11px] text-slate-300">
                                {compactHash(outcome.eventPrefixHash)}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-slate-500">覆盖原因原值</dt>
                              <dd className="break-all font-mono text-[11px] text-slate-300">
                                {outcome.missingReason ?? "—"}
                              </dd>
                            </div>
                          </dl>
                        </details>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </GlassCard>
        </>
      )}
    </div>
  );
}
