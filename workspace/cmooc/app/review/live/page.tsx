import Link from "next/link";
import { CommandShell } from "@/components/ui/command-shell";
import { IncidentGovernanceActions } from "@/components/autonomy/IncidentGovernanceActions";
import { GlassCard } from "@/components/ui/glass-card";
import { StatusPill } from "@/components/ui/status-pill";
import { filterOperatorCourses } from "@/lib/autonomy/operator-presentation";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

type SafeReviewEvent = {
  invocationId: string | null;
  kind: string;
  outcome: string;
  reasonCode: string | null;
  evidenceHash: string;
  createdAt: Date;
};

type SafeIncident = {
  id: string;
  invocationId: string | null;
  severity: string;
  code: string;
  status: string;
  evidenceHash: string;
  openedAt: Date;
  resolvedAt: Date | null;
};

type SafeInvocation = {
  id: string;
  mode: string;
  status: string;
  manifestHash: string;
  scheduledFor: Date;
  finishedAt: Date | null;
};

type SafeWorkerWakeReceipt = {
  source: string;
  runtimeVersion: string;
  status: string;
  reasonCode: string;
  startedAt: Date;
  finishedAt: Date | null;
};

type ReviewEventGroup = {
  key: string;
  invocationId: string | null;
  evidenceHash: string;
  createdAt: Date;
  count: number;
};

const incidentDescriptions: Record<string, string> = {
  comment_pagination_position_ignored:
    "评论分页未按预期推进，当前覆盖已降级为部分。",
  comment_count_mismatch:
    "观察到的评论数量与预期不一致，当前覆盖已降级为部分。",
  read_auth_unavailable:
    "当前读取会话缺少必要授权，相关范围已停止继续读取。",
  invalid_event_time:
    "观察事件的时间字段无效，相关事件未进入当前世界状态。",
  event_parent_unresolved:
    "回复缺少可核验的父节点，相关关系未进入当前结构投影。",
  scan_limit_exceeded:
    "本轮读取达到安全上限，未完成范围会留待后续周期恢复。",
  event_version_conflict:
    "同一事件出现冲突版本，相关世界投影已停止写入。",
  structure_fact_version_conflict:
    "结构事实出现冲突版本，相关图投影已停止写入。",
  course_manifest_mismatch:
    "课程绑定校验未通过，相关运行已被隔离。",
  course_manifest_invalid:
    "课程清单校验未通过，相关运行未继续执行。",
  invocation_lease_expired:
    "运行租约已过期，恢复流程会在下一次唤醒时安全接管。"
};

const codePattern = /^[A-Za-z][A-Za-z0-9_-]{0,80}$/;
const hashPattern = /^[A-Za-z0-9_-]{12,160}$/;

function safeCode(value: string | null | undefined) {
  return value && codePattern.test(value) ? value : "未提供代码";
}

function shortHash(value: string | null | undefined) {
  if (!value || !hashPattern.test(value)) return "哈希不可用";
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function formatTime(value: Date | null | undefined) {
  if (!value) return "尚无时间回执";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(value);
}

function severityTone(severity: string) {
  const normalized = severity.toLowerCase();
  if (normalized === "critical" || normalized === "high") {
    return "danger" as const;
  }
  if (normalized === "medium") return "amber" as const;
  return "muted" as const;
}

function severityLabel(severity: string) {
  const labels: Record<string, string> = {
    critical: "严重",
    high: "高",
    medium: "中",
    low: "低"
  };
  return labels[severity.toLowerCase()] ?? "未分级";
}

function incidentStatusLabel(status: string) {
  const labels: Record<string, string> = {
    open: "待处理",
    acknowledged: "已确认",
    resolved: "已解决",
    closed: "已关闭"
  };
  return labels[status.toLowerCase()] ?? "未识别";
}

function statusTone(status: string) {
  const normalized = status.toLowerCase();
  if (
    normalized === "open" ||
    normalized === "acknowledged" ||
    normalized === "attention"
  ) {
    return "amber" as const;
  }
  if (normalized === "resolved" || normalized === "completed") {
    return "emerald" as const;
  }
  if (normalized === "failed" || normalized === "abandoned") {
    return "danger" as const;
  }
  return "cyan" as const;
}

function workerWakeSourceLabel(source: string) {
  const labels: Record<string, string> = {
    codex_automation: "Codex 自动化",
    local_cli: "本地 CLI",
    test: "测试运行"
  };
  return labels[source] ?? safeCode(source);
}

function workerWakeStatusLabel(status: string) {
  const labels: Record<string, string> = {
    running: "正在唤醒",
    completed: "唤醒完成",
    attention: "需要关注",
    failed: "唤醒失败",
    abandoned: "已安全放弃"
  };
  return labels[status.toLowerCase()] ?? safeCode(status);
}

function modeLabel(mode: string) {
  const labels: Record<string, string> = {
    OBSERVE: "观察",
    SHADOW: "影子运行",
    STAGE: "暂存演练",
    AUTO: "自动运行",
    HALTED: "已停机"
  };
  return labels[mode.toUpperCase()] ?? safeCode(mode);
}

function invocationStatusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: "等待执行",
    running: "正在运行",
    completed: "已完成",
    failed: "运行失败",
    abandoned: "已放弃"
  };
  return labels[status] ?? safeCode(status);
}

function groupReviewEvents(events: SafeReviewEvent[]) {
  const groups = new Map<string, ReviewEventGroup>();
  for (const event of events) {
    const key = [
      safeCode(event.kind),
      safeCode(event.outcome),
      safeCode(event.reasonCode)
    ].join(" · ");
    const current = groups.get(key);
    if (current) {
      current.count += 1;
      continue;
    }
    groups.set(key, {
      key,
      invocationId: event.invocationId,
      evidenceHash: event.evidenceHash,
      createdAt: event.createdAt,
      count: 1
    });
  }
  return [...groups.values()].slice(0, 8);
}

export default async function LiveReviewPage() {
  let data:
    | {
        incidents: SafeIncident[];
        openIncidentCount: number;
        invocations: SafeInvocation[];
        workerWakeReceipts: SafeWorkerWakeReceipt[];
        reviewEvents: SafeReviewEvent[];
      }
    | null = null;

  try {
    const visibleCourseAliases = filterOperatorCourses(
      await prisma.autonomyCourseManifest.findMany({
        where: { enabled: true },
        select: { alias: true, enabled: true }
      })
    ).map((manifest) => manifest.alias);
    const [
      incidents,
      openIncidentCount,
      invocations,
      workerWakeReceipts,
      reviewEvents
    ] = await Promise.all([
        prisma.autonomyIncident.findMany({
          where: { courseAlias: { in: visibleCourseAliases } },
          orderBy: [{ status: "asc" }, { openedAt: "desc" }],
          take: 12,
          select: {
            id: true,
            invocationId: true,
            severity: true,
            code: true,
            status: true,
            evidenceHash: true,
            openedAt: true,
            resolvedAt: true
          }
        }),
        prisma.autonomyIncident.count({
          where: {
            courseAlias: { in: visibleCourseAliases },
            status: { in: ["open", "acknowledged"] }
          }
        }),
        prisma.scheduledInvocation.findMany({
          where: { courseAlias: { in: visibleCourseAliases } },
          orderBy: { scheduledFor: "desc" },
          take: 8,
          select: {
            id: true,
            mode: true,
            status: true,
            manifestHash: true,
            scheduledFor: true,
            finishedAt: true
          }
        }),
        prisma.autonomyWorkerWakeReceipt.findMany({
          orderBy: { startedAt: "desc" },
          take: 12,
          select: {
            source: true,
            runtimeVersion: true,
            status: true,
            reasonCode: true,
            startedAt: true,
            finishedAt: true
          }
        }),
        prisma.reviewEvent.findMany({
          where: {
            containsForumText: false,
            invocation: {
              is: { courseAlias: { in: visibleCourseAliases } }
            }
          },
          orderBy: { createdAt: "desc" },
          take: 48,
          select: {
            invocationId: true,
            kind: true,
            outcome: true,
            reasonCode: true,
            evidenceHash: true,
            createdAt: true
          }
        })
      ]);
    data = {
      incidents,
      openIncidentCount,
      invocations,
      workerWakeReceipts,
      reviewEvents
    };
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <div className="fade-in space-y-6">
        <CommandShell
          title="长期运行审核"
          description="这里汇总自治运行的去正文异常、外层唤醒、课程运行和审核事件，不提供逐条回复审批。"
          status={<StatusPill label="审核数据暂不可用" tone="amber" />}
          actions={
            <Link
              href="/platform"
              className="rounded-md border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-cyan-400 hover:text-cyan-200"
            >
              前往只读诊断
            </Link>
          }
        />
        <GlassCard tone="highlight">
          <h2 className="text-lg font-semibold text-slate-50">
            暂时无法加载审核回执
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
            系统没有展示底层错误信息。请稍后重试，或先在只读诊断入口核验当前运行环境。
          </p>
        </GlassCard>
      </div>
    );
  }

  const reviewGroups = groupReviewEvents(data.reviewEvents);

  return (
    <div className="fade-in space-y-6">
      <CommandShell
        title="长期运行审核"
        description="系统持续运行，教师与课程运营者在这里查看异常、抽样运行与审核回执；不逐条批准、编辑或发送回复。"
        status={
          <>
            <StatusPill label="去正文回执" tone="cyan" />
            <StatusPill label="发布仍锁定" tone="emerald" />
          </>
        }
        actions={
          <Link
            href="/platform"
            className="rounded-md border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-cyan-400 hover:text-cyan-200"
          >
            查看只读诊断
          </Link>
        }
      />

      <GlassCard
        tone={data.openIncidentCount > 0 ? "highlight" : "success"}
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-slate-50">
              异常进入长期审核，而不是逐条回复审批
            </h2>
            <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-300">
              默认只展示当前启用且对运营者可见课程的记录；停用课程历史仍保留在审计表中。每条记录只保留原因代码、严重程度、状态、去正文证据哈希、时间和关联运行，正文、身份、目标和平台定位不会显示在此处。
            </p>
          </div>
          <StatusPill
            label={`${data.openIncidentCount} 个待处理异常`}
            tone={data.openIncidentCount > 0 ? "amber" : "emerald"}
          />
        </div>
      </GlassCard>

      <section
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
        aria-label="长期审核摘要"
      >
        {[
          ["待处理异常", String(data.openIncidentCount), "待确认或待解决"],
          ["近期异常", String(data.incidents.length), "按状态与打开时间排序"],
          [
            "外层唤醒",
            String(data.workerWakeReceipts.length),
            "包含零到期课程周期"
          ],
          [
            "课程运行",
            String(data.invocations.length),
            "仅统计 ScheduledInvocation"
          ],
          ["审核聚合", String(reviewGroups.length), "仅统计去正文审核事件"]
        ].map(([label, value, hint]) => (
          <GlassCard key={label}>
            <p className="text-xs font-semibold text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-black text-slate-100">
              {value}
            </p>
            <p className="mt-1 text-xs text-slate-500">{hint}</p>
          </GlassCard>
        ))}
      </section>

      <section aria-labelledby="worker-wake-heading">
        <GlassCard>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2
                id="worker-wake-heading"
                className="text-lg font-semibold text-slate-50"
              >
                外层唤醒回执
              </h2>
              <p className="mt-1 max-w-4xl text-sm leading-6 text-slate-400">
                这里记录调度器、CLI 或测试执行器的一次 worker
                唤醒。即使本轮有 0
                个到期课程、没有生成课程运行，唤醒回执也会独立保留；它不是课程运行，也不表示发生了课程干预。
              </p>
            </div>
            <StatusPill
              label={`显示 ${data.workerWakeReceipts.length} 条`}
              tone="muted"
            />
          </div>

          {data.workerWakeReceipts.length > 0 ? (
            <div className="mt-5 divide-y divide-slate-800">
              {data.workerWakeReceipts.map((receipt, index) => (
                <article
                  key={`${receipt.startedAt.toISOString()}-${receipt.source}-${index}`}
                  className="grid gap-3 py-4 first:pt-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill
                        label={`来源 · ${workerWakeSourceLabel(receipt.source)}`}
                        tone="violet"
                      />
                      <StatusPill
                        label={`运行时 · ${safeCode(receipt.runtimeVersion)}`}
                        tone="muted"
                      />
                      <StatusPill
                        label={workerWakeStatusLabel(receipt.status)}
                        tone={statusTone(receipt.status)}
                      />
                    </div>
                    <p className="mt-3 break-all font-mono text-xs text-slate-400">
                      原因代码 · {safeCode(receipt.reasonCode)}
                    </p>
                  </div>
                  <dl className="grid gap-2 text-xs text-slate-500 sm:grid-cols-2">
                    <div>
                      <dt>开始时间</dt>
                      <dd className="mt-1 text-slate-300">
                        {formatTime(receipt.startedAt)}
                      </dd>
                    </div>
                    <div>
                      <dt>终态时间</dt>
                      <dd className="mt-1 text-slate-300">
                        {formatTime(receipt.finishedAt)}
                      </dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          ) : (
            <p className="mt-5 text-sm leading-6 text-slate-400">
              当前查询窗口内尚无外层唤醒回执；不能用下方课程运行数量替代判断唤醒是否发生。
            </p>
          )}
        </GlassCard>
      </section>

      <section aria-labelledby="incident-heading">
        <GlassCard>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2
                id="incident-heading"
                className="text-lg font-semibold text-slate-50"
              >
                长期异常
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                先处理仍待确认或待解决的异常；每项可进入关联运行，核对完整的去正文决定带。
              </p>
            </div>
            <StatusPill
              label={`显示 ${data.incidents.length} 条`}
              tone="muted"
            />
          </div>

          {data.incidents.length > 0 ? (
            <div className="mt-5 divide-y divide-slate-800">
              {data.incidents.map((incident) => {
                const code = safeCode(incident.code);
                const incidentTime =
                  incident.resolvedAt ?? incident.openedAt;
                return (
                  <article
                    key={incident.id}
                    className="grid gap-4 py-5 first:pt-0 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-mono text-sm font-semibold text-slate-100">
                          {code}
                        </p>
                        <StatusPill
                          label={`严重程度 · ${severityLabel(incident.severity)}`}
                          tone={severityTone(incident.severity)}
                        />
                        <StatusPill
                          label={`状态 · ${incidentStatusLabel(incident.status)}`}
                          tone={statusTone(incident.status)}
                        />
                      </div>
                      <p className="mt-2 text-sm leading-6 text-slate-400">
                        {incidentDescriptions[code] ??
                          "该代码已进入长期审核；请结合关联运行与去正文证据哈希核验。"}
                      </p>
                      <dl className="mt-3 grid gap-2 text-xs text-slate-500 sm:grid-cols-2">
                        <div>
                          <dt>时间</dt>
                          <dd className="mt-1 text-slate-300">
                            {formatTime(incidentTime)}
                          </dd>
                        </div>
                        <div className="min-w-0">
                          <dt>去正文证据哈希</dt>
                          <dd className="mt-1 break-all font-mono text-slate-300">
                            {shortHash(incident.evidenceHash)}
                          </dd>
                        </div>
                      </dl>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <IncidentGovernanceActions
                        incidentId={incident.id}
                        evidenceHash={incident.evidenceHash}
                        status={incident.status}
                      />
                      {incident.invocationId ? (
                        <Link
                          href={`/autonomy/runs/${incident.invocationId}`}
                          className="inline-flex justify-center rounded-md border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-cyan-400 hover:text-cyan-200"
                        >
                          查看关联运行
                        </Link>
                      ) : (
                        <span className="text-sm text-slate-500">
                          暂无关联运行
                        </span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="mt-5 text-sm leading-6 text-slate-400">
              目前没有异常回执。后续异常会自动进入这里，不需要逐条人工审批。
            </p>
          )}
        </GlassCard>
      </section>

      <div className="grid gap-5 xl:grid-cols-[1.08fr_0.92fr]">
        <GlassCard>
          <h2 className="text-lg font-semibold text-slate-50">
            近期课程运行
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            这里展示 ScheduledInvocation：只有课程进入执行时才会出现。它不是外层唤醒回执，也不能用于判断零到期课程周期是否成功唤醒。
          </p>
          {data.invocations.length > 0 ? (
            <div className="mt-5 divide-y divide-slate-800">
              {data.invocations.map((invocation) => (
                <article
                  key={invocation.id}
                  className="grid gap-3 py-4 first:pt-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill
                        label={modeLabel(invocation.mode)}
                        tone="violet"
                      />
                      <StatusPill
                        label={invocationStatusLabel(invocation.status)}
                        tone={statusTone(invocation.status)}
                      />
                    </div>
                    <dl className="mt-3 grid gap-2 text-xs text-slate-500 sm:grid-cols-2">
                      <div>
                        <dt>时间</dt>
                        <dd className="mt-1 text-slate-300">
                          {formatTime(
                            invocation.finishedAt ?? invocation.scheduledFor
                          )}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt>绑定哈希</dt>
                        <dd className="mt-1 break-all font-mono text-slate-300">
                          {shortHash(invocation.manifestHash)}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <Link
                    href={`/autonomy/runs/${invocation.id}`}
                    className="inline-flex justify-center rounded-md border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-cyan-400 hover:text-cyan-200"
                  >
                    查看运行
                  </Link>
                </article>
              ))}
            </div>
          ) : (
            <p className="mt-5 text-sm leading-6 text-slate-400">
              当前查询窗口内没有课程运行；这不等于外层未唤醒，请以上方外层唤醒回执为准。
            </p>
          )}
        </GlassCard>

        <GlassCard>
          <h2 className="text-lg font-semibold text-slate-50">
            审核事件聚合
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            相同审核代码合并计数，仅保留最近一条去正文证据哈希与关联运行。
          </p>
          {reviewGroups.length > 0 ? (
            <div className="mt-5 divide-y divide-slate-800">
              {reviewGroups.map((group) => (
                <article key={group.key} className="py-4 first:pt-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 break-all font-mono text-xs font-semibold text-slate-200">
                      {group.key}
                    </p>
                    <StatusPill label={`${group.count} 次`} tone="muted" />
                  </div>
                  <dl className="mt-3 grid gap-2 text-xs text-slate-500 sm:grid-cols-2">
                    <div>
                      <dt>最近时间</dt>
                      <dd className="mt-1 text-slate-300">
                        {formatTime(group.createdAt)}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt>去正文证据哈希</dt>
                      <dd className="mt-1 break-all font-mono text-slate-300">
                        {shortHash(group.evidenceHash)}
                      </dd>
                    </div>
                  </dl>
                  {group.invocationId ? (
                    <Link
                      href={`/autonomy/runs/${group.invocationId}`}
                      className="mt-3 inline-flex text-sm font-semibold text-cyan-200 hover:text-cyan-100"
                    >
                      查看关联运行
                    </Link>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <p className="mt-5 text-sm leading-6 text-slate-400">
              尚无去正文审核事件。运行产生抽查或异常处置回执后会自动聚合在这里。
            </p>
          )}
        </GlassCard>
      </div>
    </div>
  );
}
