import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CommandShell } from "@/components/ui/command-shell";
import { GlassCard } from "@/components/ui/glass-card";
import { CockpitMetricCard } from "@/components/ui/metric-card";
import { StatusPill } from "@/components/ui/status-pill";
import { verifyDecisionTape } from "@/lib/autonomy/decision-tape";
import {
  autonomyDate,
  compactHash,
  parseSafeDecisionTapeGovernancePayload,
  parseSafeCoverageSummary
} from "@/lib/autonomy/read-model";
import {
  formatCourseLabel,
  formatRunMode,
  formatRunSafetyMessage,
  formatTapeStageLabel
} from "@/lib/autonomy/run-operator-presentation";
import { loadVerifiedOperatorCourseNames } from "@/lib/autonomy/operator-course-name";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "运行详情 | cMOOC 智能学伴",
  description: "查看单次自治运行的状态、范围、覆盖、决定与证据链。"
};

function lifecycleLabel(status: string): string {
  if (status === "completed") return "已完成";
  if (status === "running") return "运行中";
  if (status === "failed") return "失败 · 需要处理";
  return "等待运行";
}

export default async function AutonomyRunPage({
  params
}: {
  params: { id: string };
}) {
  const invocation =
    await prisma.scheduledInvocation.findUnique({
      where: { id: params.id }
    });
  if (!invocation) notFound();
  const courseNames = await loadVerifiedOperatorCourseNames([
    invocation.courseAlias
  ]);

  const [
    scan,
    world,
    candidateSet,
    decisions,
    tape,
    tapeCheck,
    openIncidentCount
  ] = await Promise.all([
    prisma.courseScanRun.findUnique({
      where: { invocationId: invocation.id }
    }),
    prisma.courseWorldSnapshot.findUnique({
      where: { invocationId: invocation.id }
    }),
    prisma.candidateSet.findUnique({
      where: { invocationId: invocation.id }
    }),
    prisma.autonomyDecision.findMany({
      where: { invocationId: invocation.id },
      select: {
        id: true,
        decision: true,
        editorWriteAttempted: true
      }
    }),
    prisma.decisionTapeEntry.findMany({
      where: { invocationId: invocation.id },
      select: {
        id: true,
        sequence: true,
        kind: true,
        entryHash: true,
        payloadJson: true,
        createdAt: true,
        containsForumText: true
      },
      orderBy: { sequence: "asc" }
    }),
    verifyDecisionTape({
      prisma,
      invocationId: invocation.id
    }),
    prisma.autonomyIncident.count({
      where: {
        invocationId: invocation.id,
        status: "open"
      }
    })
  ]);
  const coverage = parseSafeCoverageSummary(scan?.coverageJson);

  const [graph, structureFactCount, attempts] =
    await Promise.all([
      world
        ? prisma.courseContentGraphSnapshot.findFirst({
            where: { worldSnapshotId: world.id },
            orderBy: { createdAt: "desc" },
            select: {
              schemaVersion: true,
              coverageStatus: true,
              roleRegistryStatus: true,
              nodeCount: true,
              edgeCount: true,
              learnerNodeCount: true
            }
          })
        : Promise.resolve(null),
      scan
        ? prisma.courseStructureFactObservation.count({
            where: { scanRunId: scan.id }
          })
        : Promise.resolve(0),
      decisions.length > 0
        ? prisma.executionAttempt.findMany({
            where: {
              decisionId: {
                in: decisions.map((decision) => decision.id)
              }
            },
            select: {
              transport: true,
              requestedMutationCount: true,
              sentMutationCount: true,
              publishAttempted: true
            }
          })
        : Promise.resolve([])
    ]);

  const externalWriteAttemptCount = attempts.filter(
    (attempt) =>
      attempt.transport === "real_platform" ||
      attempt.requestedMutationCount > 0 ||
      attempt.sentMutationCount > 0 ||
      attempt.publishAttempted
  ).length;
  const editorWriteAttemptCount = decisions.filter(
    (decision) => decision.editorWriteAttempted
  ).length;
  const decisionCounts = decisions.reduce(
    (counts, decision) => {
      if (decision.decision in counts) {
        counts[
          decision.decision as keyof typeof counts
        ] += 1;
      }
      return counts;
    },
    { draft: 0, wait: 0, abstain: 0, yield: 0 }
  );
  const groupedTape = Array.from(
    tape.reduce(
      (groups, entry) => {
        const existing = groups.get(entry.kind);
        if (existing) {
          existing.count += 1;
          existing.lastSequence = entry.sequence;
          existing.lastHash = entry.entryHash;
          return groups;
        }
        groups.set(entry.kind, {
          kind: entry.kind,
          count: 1,
          firstSequence: entry.sequence,
          lastSequence: entry.sequence,
          lastHash: entry.entryHash
        });
        return groups;
      },
      new Map<
        string,
        {
          kind: string;
          count: number;
          firstSequence: number;
          lastSequence: number;
          lastHash: string;
        }
      >()
    ).values()
  );
  const governanceTape = tape.flatMap((entry) => {
    const payload = parseSafeDecisionTapeGovernancePayload(
      entry.kind,
      entry.payloadJson,
      entry.containsForumText
    );
    return payload
      ? [{ ...entry, payload }]
      : [];
  });
  const coveragePartial = coverage?.complete === false;
  const requestedMutationCount = attempts.reduce(
    (count, attempt) => count + attempt.requestedMutationCount,
    0
  );
  const sentMutationCount = attempts.reduce(
    (count, attempt) => count + attempt.sentMutationCount,
    0
  );
  const publishAttemptCount = attempts.filter(
    (attempt) => attempt.publishAttempted
  ).length;
  const runMode = formatRunMode(invocation.mode);

  return (
    <div
      className="fade-in space-y-5 sm:space-y-6"
      data-testid="autonomy-run"
    >
      <CommandShell
        variant="operational"
        testId="run-detail-masthead"
        eyebrow="运行记录 · 单次回执"
        title="运行详情"
        description={`${formatCourseLabel(invocation.courseAlias, courseNames)} · ${runMode} · ${autonomyDate(invocation.startedAt)} — ${autonomyDate(invocation.finishedAt)}`}
        status={
          <>
            <StatusPill
              label={lifecycleLabel(invocation.status)}
              tone={
                invocation.status === "completed"
                  ? "emerald"
                  : invocation.status === "failed"
                    ? "danger"
                    : "amber"
              }
              pulse={invocation.status === "running"}
            />
            <StatusPill
              label={
                coveragePartial
                  ? "证据部分覆盖"
                  : coverage?.complete
                    ? "证据覆盖完整"
                    : "覆盖状态不可用"
              }
              tone={
                coveragePartial
                  ? "amber"
                  : coverage?.complete
                    ? "emerald"
                    : "muted"
              }
            />
            <StatusPill
              label={
                externalWriteAttemptCount === 0
                  ? "未产生课程平台写入"
                  : "检测到平台写入尝试"
              }
              tone={externalWriteAttemptCount === 0 ? "emerald" : "danger"}
            />
            {!tapeCheck.valid ? (
              <StatusPill label="运行核查异常" tone="danger" />
            ) : null}
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
          <Link
            href={`/autonomy/decisions?run=${encodeURIComponent(invocation.id)}`}
            className="inline-flex min-h-11 items-center rounded-md border border-cyan-400/60 bg-cyan-400/10 px-3 py-2 text-sm font-semibold text-cyan-100 hover:border-cyan-300"
          >
            查看本次决定
          </Link>
          <Link
            href="/review/live"
            className="inline-flex min-h-11 items-center rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-slate-500"
          >
            打开异常总览 · 本次 {openIncidentCount}
          </Link>
          </div>
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
          <p>
            计划 {autonomyDate(invocation.scheduledFor)}
          </p>
          <Link
            href="/autonomy/decisions"
            className="inline-flex min-h-11 items-center font-semibold text-slate-300 hover:text-slate-50"
          >
            返回运行记录
          </Link>
        </div>
      </CommandShell>

      <section
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="本次运行指标"
      >
        <CockpitMetricCard
          label="已观察事件"
          value={world?.eventCount ?? scan?.observedEventCount ?? 0}
          hint={`${scan?.newEventCount ?? 0} 个本轮新增事件`}
          tone="cyan"
        />
        <CockpitMetricCard
          label="讨论线程"
          value={world?.threadCount ?? 0}
          hint={`${structureFactCount} 条课程结构事实`}
          tone="emerald"
        />
        <CockpitMetricCard
          label="互动关系"
          value={graph?.edgeCount ?? 0}
          hint={
            graph
              ? `${graph.nodeCount} 个参与节点`
              : "当前运行暂无关系摘要"
          }
          tone="violet"
        />
        <CockpitMetricCard
          label="自主决定"
          value={decisions.length}
          hint={`${decisionCounts.abstain} 不行动 · ${decisionCounts.yield} 让位 · ${decisionCounts.draft} 草稿`}
          tone="amber"
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <GlassCard>
          <h2 className="text-lg font-semibold text-slate-50">
            运行范围
          </h2>
          <dl className="mt-4 space-y-3 text-sm">
            {[
              ["课程", formatCourseLabel(invocation.courseAlias, courseNames)],
              ["运行模式", runMode],
              ["计划时点", autonomyDate(invocation.scheduledFor)],
              ["开始", autonomyDate(invocation.startedAt)],
              ["结束", autonomyDate(invocation.finishedAt)]
            ].map(([label, value]) => (
              <div
                key={label}
                className="flex items-center justify-between gap-4 border-b border-slate-800 pb-2 last:border-0 last:pb-0"
              >
                <dt className="text-slate-400">{label}</dt>
                <dd className="text-right font-mono text-xs text-slate-100">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <p className={`mt-4 rounded-md border px-3 py-3 text-xs leading-5 ${
            externalWriteAttemptCount === 0
              ? "border-emerald-400/25 bg-emerald-400/5 text-emerald-100"
              : "border-amber-400/25 bg-amber-400/5 text-amber-100"
          }`}>
            {formatRunSafetyMessage({
              editorWriteAttemptCount,
              externalWriteAttemptCount,
              requestedMutationCount,
              sentMutationCount,
              publishAttemptCount
            })}
          </p>
          <details className="mt-4 rounded-md border border-slate-800 bg-slate-950/30 px-3 py-2 text-xs text-slate-400">
            <summary className="cursor-pointer font-semibold text-slate-300">
              运行核查
            </summary>
            <dl className="mt-3 space-y-2 leading-5">
              <div>
                <dt className="text-slate-500">恢复尝试</dt>
                <dd className="font-mono text-slate-300">{invocation.attempt}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Manifest</dt>
                <dd className="break-all font-mono text-slate-300">{compactHash(invocation.manifestHash)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">写入计数</dt>
                <dd className="font-mono text-slate-300">
                  编辑器 {editorWriteAttemptCount} · 请求 {requestedMutationCount} · 发送 {sentMutationCount} · 发布尝试 {publishAttemptCount}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">运行标识</dt>
                <dd className="break-all font-mono text-slate-300">{invocation.courseAlias} · {compactHash(invocation.invocationKey)}</dd>
              </div>
            </dl>
          </details>
        </GlassCard>

        <GlassCard tone={coveragePartial ? "warning" : "success"}>
          <h2 className="text-lg font-semibold text-slate-50">
            覆盖回执
          </h2>
          {coverage ? (
            <>
              <p className="mt-4 text-base font-semibold text-slate-100">
                {coverage.complete ? "课程范围已完整核验" : "课程范围存在未覆盖内容"}
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-300">
                {coverage.courseShellDetected
                  ? "课程入口已识别，下面的运行事实均按本次可见范围解释。"
                  : "课程入口未能完整识别，当前事实只能作为有限观察。"}
              </p>
              {coveragePartial ? (
                <p className="mt-4 rounded-md border border-amber-400/25 bg-amber-400/5 px-3 py-3 text-xs leading-5 text-amber-100">
                  运行生命周期已经结束，但证据并不完整。评论范围缺失使互动关系只能作为当前可见范围的下界。
                </p>
              ) : null}
              <details className="mt-4 rounded-md border border-slate-800 bg-slate-950/30 px-3 py-2 text-xs text-slate-400">
                <summary className="cursor-pointer font-semibold text-slate-300">
                  覆盖核查
                </summary>
                <dl className="mt-3 grid grid-cols-2 gap-3 leading-5">
                  <div>
                    <dt className="text-slate-500">栏目</dt>
                    <dd className="font-mono text-slate-300">{coverage.categoryCompletedCount}/{coverage.categoryCount}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">线程详情</dt>
                    <dd className="font-mono text-slate-300">{coverage.completedDetailCount}/{coverage.discoveredThreadCount}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">评论范围删失</dt>
                    <dd className="font-mono text-slate-300">{coverage.incompleteCommentThreadCount}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">失败目标</dt>
                    <dd className="font-mono text-slate-300">{coverage.failedTargetCount}</dd>
                  </div>
                </dl>
              </details>
            </>
          ) : (
            <p className="mt-4 text-sm text-slate-400">
              当前运行没有可验证覆盖回执。
            </p>
          )}
        </GlassCard>
      </section>

      <GlassCard>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-50">
              运行阶段
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-400">
              按阶段展示本次运行如何完成；内部校验值默认收起。
            </p>
          </div>
        </div>
        <ol className="mt-5 divide-y divide-slate-700 border-y border-slate-700">
          {groupedTape.map((group) => (
            <li
              key={group.kind}
              className="flex items-center justify-between gap-3 py-4 text-sm"
            >
              <div>
                <p className="font-semibold text-slate-100">
                  {formatTapeStageLabel(group.kind)}
                </p>
              </div>
              <span className="text-xs text-slate-400">已记录</span>
            </li>
          ))}
          {groupedTape.length === 0 ? (
            <li className="py-6 text-sm text-slate-400">
              当前运行还没有 Decision Tape 回执。
            </li>
          ) : null}
        </ol>
        <details className="mt-4 rounded-md border border-slate-800 bg-slate-950/30 px-3 py-2 text-xs text-slate-400">
          <summary className="cursor-pointer font-semibold text-slate-300">
            运行核查
          </summary>
          <p className="mt-3 leading-5">
            Decision Tape {tapeCheck.valid ? "校验通过" : "校验失败"}，共 {tape.length} 条回执；原始阶段码、序列和哈希仅在此处显示。
          </p>
          <ul className="mt-3 space-y-2 border-t border-slate-800 pt-3">
            {groupedTape.map((group) => (
              <li key={`audit-${group.kind}`} className="font-mono text-slate-400">
                {group.kind} · {group.count} 条 · #{group.firstSequence}{group.lastSequence === group.firstSequence ? "" : `–${group.lastSequence}`} · {compactHash(group.lastHash)}
              </li>
            ))}
          </ul>
        </details>
        {governanceTape.length > 0 ? (
          <div className="mt-6">
            <h3 className="font-semibold text-slate-100">
              长期结果回流
            </h3>
            <p className="mt-1 text-sm leading-6 text-slate-400">
              以下字段由去正文白名单投影生成；它们是发布后的描述性过程信号，不构成教育效果或因果结论。
            </p>
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {governanceTape.map((entry) => (
                <article
                  key={entry.id}
                  className="rounded-md border border-slate-800 bg-slate-950/30 p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold text-cyan-100">
                      {entry.payload.observationWindow} · 已观察
                    </p>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                    <div>
                      <dt className="text-slate-500">证据来源</dt>
                      <dd className="mt-1 text-slate-200">
                        {entry.payload.evidenceSource === "full_course"
                          ? "全课完整覆盖"
                          : "目标线程完整"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">作者返回</dt>
                      <dd className="mt-1 text-slate-200">
                        {entry.payload.authorReturned ? "是" : "否"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">深度增量</dt>
                      <dd className="mt-1 text-slate-200">
                        {entry.payload.replyDepthDelta}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">新参与者</dt>
                      <dd className="mt-1 text-slate-200">
                        {entry.payload.newAuthorCount}
                      </dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          </div>
        ) : null}
      </GlassCard>
    </div>
  );
}
