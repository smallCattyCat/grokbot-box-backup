import type { Metadata } from "next";
import Link from "next/link";
import { CommandShell } from "@/components/ui/command-shell";
import { GlassCard } from "@/components/ui/glass-card";
import { CockpitMetricCard } from "@/components/ui/metric-card";
import { StatusPill } from "@/components/ui/status-pill";
import {
  autonomyDate,
  compactHash
} from "@/lib/autonomy/read-model";
import {
  formatCourseLabel,
  formatDecisionReason,
  formatExecutionBoundary,
  formatRunMode
} from "@/lib/autonomy/run-operator-presentation";
import { loadVerifiedOperatorCourseNames } from "@/lib/autonomy/operator-course-name";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "运行记录 | cMOOC 智能学伴",
  description: "查看当前范围内的去正文决定回执、运行状态与证据链。"
};

const decisionPresentation: Record<
  string,
  { label: string; detail: string; className: string }
> = {
  draft: {
    label: "可生成草稿",
    detail: "受约束草稿，仍待审阅",
    className: "text-cyan-200"
  },
  wait: {
    label: "等待",
    detail: "等待更充分的时机或证据",
    className: "text-amber-200"
  },
  abstain: {
    label: "不行动",
    detail: "本轮不形成外部动作",
    className: "text-slate-200"
  },
  yield: {
    label: "让位",
    detail: "优先保留既有的人类互动",
    className: "text-violet-200"
  }
};

function decisionState(decision: string) {
  return (
    decisionPresentation[decision] ?? {
      label: "未识别状态",
      detail: "原始回执状态未映射",
      className: "text-slate-200"
    }
  );
}

function ScopeLink({
  href,
  active,
  children
}: {
  href: string;
  active: boolean;
  children: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-md border px-3 py-2 text-sm font-semibold transition ${
        active
          ? "border-cyan-400/70 bg-cyan-400/10 text-cyan-100"
          : "border-slate-700 bg-slate-950/30 text-slate-300 hover:border-slate-500 hover:text-slate-100"
      }`}
    >
      {children}
    </Link>
  );
}

export default async function AutonomyDecisionsPage({
  searchParams
}: {
  searchParams?: { scope?: string; run?: string };
}) {
  const requestedRunId = searchParams?.run?.trim();
  const hasRequestedRun = Boolean(requestedRunId);
  const showingAllHistory =
    searchParams?.scope === "all" && !hasRequestedRun;
  const [latestCompletedRun, requestedRun] = await Promise.all([
    prisma.scheduledInvocation.findFirst({
      where: {
        status: "completed",
        finishedAt: { not: null }
      },
      orderBy: [{ finishedAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        courseAlias: true,
        invocationKey: true,
        finishedAt: true,
        mode: true,
        status: true
      }
    }),
    requestedRunId
      ? prisma.scheduledInvocation.findUnique({
          where: { id: requestedRunId },
          select: {
            id: true,
            courseAlias: true,
            invocationKey: true,
            finishedAt: true,
            mode: true,
            status: true
          }
        })
      : Promise.resolve(null)
  ]);
  const focalRun = hasRequestedRun
    ? requestedRun
      : latestCompletedRun;
  const courseNames = await loadVerifiedOperatorCourseNames(
    focalRun ? [focalRun.courseAlias] : undefined
  );
  const decisionScope = showingAllHistory
    ? {}
    : focalRun
      ? { invocationId: focalRun.id }
      : { invocationId: "__no_completed_autonomy_run__" };

  const [decisions, counts, tapeCount] = await Promise.all([
    prisma.autonomyDecision.findMany({
      where: decisionScope,
      orderBy: { evidenceAsOf: "desc" },
      take: 120,
      include: {
        invocation: {
          select: {
            id: true,
            courseAlias: true,
            invocationKey: true,
            finishedAt: true,
            status: true
          }
        }
      }
    }),
    prisma.autonomyDecision.groupBy({
      by: ["decision"],
      where: decisionScope,
      _count: { _all: true }
    }),
    prisma.decisionTapeEntry.count({
      where: showingAllHistory
        ? undefined
        : focalRun
          ? { invocationId: focalRun.id }
          : { invocationId: "__no_completed_autonomy_run__" }
    })
  ]);
  const countByDecision = Object.fromEntries(
    counts.map((item) => [item.decision, item._count._all])
  );
  const scopeDescription = showingAllHistory
    ? "全部课程的历史决定（最近 120 条）"
    : focalRun
      ? `${formatCourseLabel(focalRun.courseAlias, courseNames)} · ${
          hasRequestedRun ? "指定运行" : "最近完成运行"
        } · ${autonomyDate(focalRun.finishedAt)}`
      : hasRequestedRun
        ? "指定运行未找到；不会回退到其它运行"
        : "尚无可用的完成运行；不会混入运行中或失败记录";
  const focalRunStatus = !showingAllHistory && focalRun
    ? focalRun.status === "completed"
      ? "已完成"
      : focalRun.status === "running"
        ? "运行中"
        : focalRun.status === "failed"
          ? "失败 · 需要处理"
          : "等待运行"
    : null;
  const focalRunMode = !showingAllHistory && focalRun
    ? formatRunMode(focalRun.mode)
    : "全部历史";

  return (
    <div className="fade-in space-y-6">
      <CommandShell
        variant="operational"
        testId="run-records-masthead"
        eyebrow="决定回执 · 去正文"
        title="运行记录"
        description={scopeDescription}
        status={
          <>
            {focalRunStatus ? (
              <StatusPill
                label={focalRunStatus}
                tone={
                  focalRun?.status === "completed"
                    ? "emerald"
                    : focalRun?.status === "failed"
                      ? "danger"
                      : "amber"
                }
              />
            ) : null}
            <StatusPill
              label={`运行模式 · ${focalRunMode}`}
              tone="cyan"
            />
            <StatusPill label={`${decisions.length} 条决定`} tone="muted" />
          </>
        }
        actions={
          !showingAllHistory && focalRun ? (
            <Link
              href={`/autonomy/runs/${focalRun.id}`}
              className="inline-flex min-h-11 items-center rounded-md border border-cyan-400/60 bg-cyan-400/10 px-3 py-2 text-sm font-semibold text-cyan-100 hover:border-cyan-300"
            >
              打开运行详情
            </Link>
          ) : null
        }
      >
        <section
          aria-label="决定记录范围"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          {hasRequestedRun && focalRun ? (
            <p className="text-xs text-slate-400">
              精确过滤仅显示这一次运行的决定回执（{focalRunStatus ?? "当前状态"}）。
            </p>
          ) : (
            <p className="text-xs text-slate-400">
              当前筛选不会混入运行中或失败记录。
            </p>
          )}
          <div
            role="group"
            aria-label="决定记录范围切换"
            className="flex shrink-0 flex-wrap gap-2"
          >
            <ScopeLink
              href="/autonomy/decisions"
              active={!showingAllHistory && !hasRequestedRun}
            >
              最新完成运行
            </ScopeLink>
            <ScopeLink
              href="/autonomy/decisions?scope=all"
              active={showingAllHistory}
            >
              全部历史
            </ScopeLink>
          </div>
          <details className="w-full rounded-md border border-slate-800 bg-slate-950/30 px-3 py-2 text-xs text-slate-400 sm:w-auto">
            <summary className="cursor-pointer font-semibold text-slate-300">
              运行核查
            </summary>
            <p className="mt-2 leading-5">
              当前范围包含 {tapeCount} 条可核对的运行记录；原始原因码、哈希和语义绑定会在每行按需展开。
            </p>
          </details>
        </section>
      </CommandShell>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(["draft", "wait", "abstain", "yield"] as const).map(
          (decision) => (
            <CockpitMetricCard
              key={decision}
              label={decisionState(decision).label}
              value={countByDecision[decision] ?? 0}
              hint={showingAllHistory ? "当前历史范围" : "本次完成运行"}
              tone={
                decision === "draft"
                  ? "cyan"
                  : decision === "yield"
                    ? "violet"
                    : decision === "wait"
                      ? "amber"
                      : "emerald"
              }
            />
          )
        )}
      </section>

      {decisions.length === 0 ? (
        <GlassCard tone="success" className="p-6 sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">
            去正文决定带
          </p>
          <h2 className="mt-2 text-xl font-semibold text-slate-50">
            当前范围内没有可展示的决定记录
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            {showingAllHistory
              ? "尚未写入任何去正文决定回执。运行完成后，页面会优先展示决定、理由和执行边界。"
              : hasRequestedRun
                ? "该指定运行没有决定记录，或运行标识不可用。页面不会改用其它课程或运行的记录。"
                : "尚未发现已完成运行，或该运行没有候选决定。页面不会用运行中、失败或其他运行的记录填充此视图。"}
          </p>
        </GlassCard>
      ) : (
        <GlassCard className="p-0">
          <div className="border-b border-slate-800 px-4 py-4 sm:px-5">
            <h2 className="text-lg font-semibold text-slate-50">
              决定记录
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              {scopeDescription}。每行的核查信息默认收起，需要时再展开。
            </p>
          </div>

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[1060px] text-left text-sm">
              <caption className="sr-only">
                {scopeDescription}；表格展示决定、理由、执行边界和运行详情链接，核查信息按需展开。
              </caption>
              <thead className="border-b border-slate-700 text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th scope="col" className="px-4 py-3">时点</th>
                  <th scope="col" className="px-4 py-3">四态决定</th>
                  <th scope="col" className="px-4 py-3">本轮理由</th>
                  <th scope="col" className="px-4 py-3">执行边界</th>
                  <th scope="col" className="px-4 py-3">课程 / 详情</th>
                  <th scope="col" className="px-4 py-3">核查信息</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {decisions.map((decision) => {
                  const state = decisionState(decision.decision);
                  return (
                    <tr key={decision.id} className="align-top">
                      <td className="whitespace-nowrap px-4 py-4 text-xs text-slate-400">
                        {autonomyDate(decision.evidenceAsOf)}
                      </td>
                      <td className="px-4 py-4">
                        <p className={`font-semibold ${state.className}`}>
                          {state.label}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                          {state.detail}
                        </p>
                      </td>
                      <td className="px-4 py-4">
                        <p className="max-w-[18rem] text-sm leading-5 text-slate-200">
                          {formatDecisionReason(decision.reasonCode)}
                        </p>
                      </td>
                      <td className="px-4 py-4 text-xs text-slate-300">
                        <p className={
                          decision.publishAttempted
                            ? "text-amber-200"
                            : "text-emerald-200"
                        }>
                          {formatExecutionBoundary({
                            bodyPersisted: decision.bodyPersisted,
                            editorWriteAttempted: decision.editorWriteAttempted,
                            publishAttempted: decision.publishAttempted
                          })}
                        </p>
                      </td>
                      <td className="px-4 py-4">
                        <p className="text-xs font-semibold text-slate-200">
                          {formatCourseLabel(decision.invocation.courseAlias, courseNames)}
                        </p>
                        <Link
                          href={`/autonomy/runs/${decision.invocation.id}`}
                          className="mt-1 inline-block text-xs font-semibold text-cyan-300 hover:underline"
                        >
                          查看运行详情
                        </Link>
                      </td>
                      <td className="px-4 py-4">
                        <details className="max-w-[18rem] text-xs text-slate-300">
                          <summary className="cursor-pointer font-semibold text-cyan-200">
                            展开核查信息
                          </summary>
                          <dl className="mt-3 space-y-2 leading-5">
                            <div>
                              <dt className="text-slate-500">原因码</dt>
                              <dd className="break-all font-mono text-slate-300">
                                {decision.reasonCode}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-slate-500">线程 / 证据</dt>
                              <dd className="font-mono text-slate-300">
                                {compactHash(decision.threadKey)} / {compactHash(decision.evidenceBundleHash)}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-slate-500">语义约束</dt>
                              <dd className="text-slate-300">
                                {decision.intentHash ? "Intent 已绑定" : "无 Intent"} · {decision.moveSpecHash ? "MoveSpec 已绑定" : "无 MoveSpec"}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-slate-500">运行标识</dt>
                              <dd className="break-all font-mono text-slate-300">
                                {decision.invocation.courseAlias} · {compactHash(decision.invocation.invocationKey)}
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

          <ul
            aria-label="移动端决定记录"
            className="divide-y divide-slate-800 md:hidden"
          >
            {decisions.map((decision) => {
              const state = decisionState(decision.decision);
              return (
                <li key={decision.id} className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className={`font-semibold ${state.className}`}>
                        {state.label}
                      </p>
                      <p className="mt-1 text-xs text-slate-400">
                        {state.detail}
                      </p>
                    </div>
                    <time className="shrink-0 text-right text-xs text-slate-400">
                      {autonomyDate(decision.evidenceAsOf)}
                    </time>
                  </div>
                  <div className="mt-4 space-y-3 text-xs">
                    <div>
                      <p className="text-slate-500">本轮理由</p>
                      <p className="mt-1 leading-5 text-slate-200">
                        {formatDecisionReason(decision.reasonCode)}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500">执行边界</p>
                      <p className={`mt-1 leading-5 ${
                        decision.publishAttempted
                          ? "text-amber-200"
                          : "text-emerald-200"
                      }`}>
                        {formatExecutionBoundary({
                          bodyPersisted: decision.bodyPersisted,
                          editorWriteAttempted: decision.editorWriteAttempted,
                          publishAttempted: decision.publishAttempted
                        })}
                      </p>
                    </div>
                    <details className="rounded-md border border-slate-800 bg-slate-950/30 px-3 py-2">
                      <summary className="cursor-pointer font-semibold text-cyan-200">
                        展开核查信息
                      </summary>
                      <dl className="mt-3 space-y-2 leading-5">
                        <div>
                          <dt className="text-slate-500">原因码</dt>
                          <dd className="break-all font-mono text-slate-300">
                            {decision.reasonCode}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-500">线程 / 证据</dt>
                          <dd className="font-mono text-slate-300">
                            {compactHash(decision.threadKey)} / {compactHash(decision.evidenceBundleHash)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-500">语义约束</dt>
                          <dd className="text-slate-300">
                            {decision.intentHash ? "Intent 已绑定" : "无 Intent"} · {decision.moveSpecHash ? "MoveSpec 已绑定" : "无 MoveSpec"}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-500">运行标识</dt>
                          <dd className="break-all font-mono text-slate-300">
                            {decision.invocation.courseAlias} · {compactHash(decision.invocation.invocationKey)}
                          </dd>
                        </div>
                      </dl>
                    </details>
                  </div>
                  <Link
                    href={`/autonomy/runs/${decision.invocation.id}`}
                    className="mt-4 inline-flex text-xs font-semibold text-cyan-300 hover:underline"
                  >
                    {formatCourseLabel(decision.invocation.courseAlias, courseNames)} · 查看运行详情
                  </Link>
                </li>
              );
            })}
          </ul>
        </GlassCard>
      )}
    </div>
  );
}
