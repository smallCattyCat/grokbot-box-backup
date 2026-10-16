import { AutonomySubnav } from "@/components/AutonomySubnav";
import { CommandShell } from "@/components/ui/command-shell";
import { GlassCard } from "@/components/ui/glass-card";
import { StatusPill } from "@/components/ui/status-pill";
import {
  courseOperationGovernanceListOrderBy,
  currentCourseOperationGovernanceHashes,
  safeCourseOperationGovernanceState
} from "@/lib/autonomy/course-operation-governance";
import { safeCourseOperationGovernanceTransitionState } from "@/lib/autonomy/course-operation-governance-lifecycle";
import { loadCourseManifest } from "@/lib/autonomy/course-manifest";
import { loadVerifiedOperatorCourseNames } from "@/lib/autonomy/operator-course-name";
import { filterOperatorCourses } from "@/lib/autonomy/operator-presentation";
import { autonomyDate, compactHash } from "@/lib/autonomy/read-model";
import { getAutonomyRuntimeHealth } from "@/lib/autonomy/runtime-health";
import type {
  AutonomySoakReadinessCheck,
  AutonomySoakReadinessCheckId,
  AutonomySoakReadinessStatus
} from "@/lib/autonomy/soak-readiness";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
const GOVERNANCE_VIEW_LIMIT = 200;

const SOAK_CHECK_LABELS: Record<AutonomySoakReadinessCheckId, string> = {
  scope_record_count: "目标运行范围唯一",
  scoped_receipt_count: "已有目标范围回执",
  receipt_contract_valid: "回执契约完整",
  wake_attention_count: "无 attention 唤醒",
  wake_failed_count: "无失败唤醒",
  wake_abandoned_count: "无废弃唤醒",
  stale_running_count: "无过期运行回执",
  last_wake_age_ms: "最近唤醒未过期",
  max_adjacent_gap_ms: "相邻唤醒间隔",
  minimum_observation_span_ms: "最小观察周期",
  minimum_completed_cycles: "最小完成轮次",
  minimum_consecutive_completed_cycles: "连续完成轮次",
  zero_editor_writes: "编辑器写入为零",
  zero_publish_attempts: "发布尝试为零",
  real_publish_disabled: "真实发布保持关闭",
  no_forum_text: "回执不含论坛正文",
  worker_failure_count: "worker 执行失败为零",
  recovery_failure_count: "恢复失败为零",
  due_query_failure_count: "到期查询失败为零",
  remaining_expired_count: "剩余过期运行租约为零",
  reconcile_failure_count: "核对失败为零",
  governance_filtered_count: "无治理拒绝遗漏",
  expired_lease_count: "当前无过期租约",
  unresolved_high_incident_count: "高优先级未解决事件数"
};

function soakStatusLabel(status: AutonomySoakReadinessStatus): string {
  return {
    unknown: "证据未知",
    qualifying: "持续观察中",
    blocked: "当前受阻",
    qualified: "本地资格已满足"
  }[status];
}

function soakStatusTone(
  status: AutonomySoakReadinessStatus
): "emerald" | "amber" | "danger" | "muted" {
  if (status === "qualified") return "emerald";
  if (status === "blocked") return "danger";
  if (status === "qualifying") return "amber";
  return "muted";
}

function soakCheckStatusLabel(
  status: AutonomySoakReadinessCheck["status"]
): string {
  return {
    passed: "通过",
    failed: "阻塞",
    pending: "待积累",
    unknown: "未知"
  }[status];
}

function soakCheckTone(
  status: AutonomySoakReadinessCheck["status"]
): "emerald" | "amber" | "danger" | "muted" {
  if (status === "passed") return "emerald";
  if (status === "failed") return "danger";
  if (status === "pending") return "amber";
  return "muted";
}

function durationLabel(milliseconds: number | null): string {
  if (milliseconds === null) return "暂无可信证据";
  const hours = milliseconds / (60 * 60_000);
  return `${hours.toFixed(hours >= 10 ? 0 : 1).replace(/\.0$/u, "")} 小时`;
}

function soakCheckValue(
  check: AutonomySoakReadinessCheck,
  value: number | boolean | null
): string {
  if (value === null) return "未知";
  if (typeof value === "boolean") return value ? "是" : "否";
  return check.id.endsWith("_ms") ? durationLabel(value) : String(value);
}

function stateLabel(status: string): string {
  return {
    active: "有效",
    paused: "已暂停",
    revoked: "已撤销",
    expired: "已过期",
    not_yet_valid: "尚未生效",
    emergency_halt: "紧急停止",
    integrity_invalid: "完整性无效",
    manifest_stale: "课程配置已变化"
  }[status] ?? "未识别";
}

function stateTone(status: string): "emerald" | "amber" | "danger" | "muted" {
  if (status === "active") return "emerald";
  if (["paused", "not_yet_valid", "manifest_stale"].includes(status)) return "amber";
  if (["revoked", "emergency_halt", "integrity_invalid"].includes(status)) return "danger";
  return "muted";
}

function modeLabel(mode: string): string {
  return {
    OBSERVE: "仅观察",
    SHADOW: "影子运行"
  }[mode] ?? "未识别";
}

function transitionActionLabel(action: string): string {
  return {
    pause: "暂停运行",
    resume: "恢复运行",
    revoke: "撤销策略",
    emergency_halt: "紧急停止",
    rotate: "轮换治理策略"
  }[action] ?? "治理状态变更";
}

export default async function AutonomyGovernancePage() {
  const now = new Date();
  const manifests = filterOperatorCourses(
    await prisma.autonomyCourseManifest.findMany({
      where: { enabled: true },
      select: {
        alias: true,
        manifestHash: true,
        realPublishEnabled: true,
        enabled: true
      }
    })
  );
  const visibleCourseAliases = manifests.map((manifest) => manifest.alias);
  const [policyWindow, transitionWindow, soakReadiness] = await Promise.all([
    prisma.courseOperationGovernancePolicy.findMany({
      where: { courseAlias: { in: visibleCourseAliases } },
      orderBy: courseOperationGovernanceListOrderBy(),
      take: GOVERNANCE_VIEW_LIMIT + 1
    }),
    prisma.courseOperationGovernanceTransition.findMany({
      where: { courseAlias: { in: visibleCourseAliases } },
      orderBy: [
        { courseAlias: "asc" },
        { createdAt: "desc" },
        { id: "desc" }
      ],
      take: GOVERNANCE_VIEW_LIMIT + 1
    }),
    getAutonomyRuntimeHealth({ prisma, now })
      .then((health) => health.soakReadiness)
      .catch(() => null)
  ]);
  const policiesTruncated = policyWindow.length > GOVERNANCE_VIEW_LIMIT;
  const transitionsTruncated = transitionWindow.length > GOVERNANCE_VIEW_LIMIT;
  const rows = policyWindow.slice(0, GOVERNANCE_VIEW_LIMIT);
  const transitionRows = transitionWindow.slice(0, GOVERNANCE_VIEW_LIMIT);
  const manifestHashes = new Map<string, string>();
  await Promise.all(
    manifests.map(async (manifestRow) => {
      try {
        const manifest = await loadCourseManifest(manifestRow.alias);
        if (
          manifest.alias === manifestRow.alias &&
          manifest.manifestHash === manifestRow.manifestHash &&
          manifestRow.realPublishEnabled === false &&
          manifest.realPublishEnabled === false
        ) {
          manifestHashes.set(manifestRow.alias, manifest.manifestHash);
        }
      } catch {
        // Missing or malformed disk manifests must never appear active.
      }
    })
  );
  const currentHashes = currentCourseOperationGovernanceHashes(rows, now);
  const policies = rows.map((row) => ({
    ...safeCourseOperationGovernanceState({
      record: row,
      currentManifestHash: manifestHashes.get(row.courseAlias) ?? null,
      now
    }),
    isCurrent: currentHashes.has(row.governanceHash)
  }));
  const transitions = transitionRows.map((row) =>
    safeCourseOperationGovernanceTransitionState(row)
  );
  const courseAliases = Array.from(
    new Set([
      ...manifests.map((manifest) => manifest.alias),
      ...rows.map((row) => row.courseAlias),
      ...transitionRows.map((row) => row.courseAlias)
    ])
  ).sort((left, right) => left.localeCompare(right));
  const verifiedCourseNames = await loadVerifiedOperatorCourseNames(
    courseAliases
  );
  const courseLabels = new Map(
    courseAliases.map((alias, index) => [
      alias,
      verifiedCourseNames.get(alias) ??
        `课程 ${String(index + 1).padStart(2, "0")}`
    ])
  );
  const operatorCourseLabel = (alias: string) =>
    courseLabels.get(alias) ?? "当前课程";
  const keySoakChecks =
    soakReadiness?.checks
      .filter((check) => check.status !== "passed")
      .sort((left, right) => {
        const priority = { failed: 0, unknown: 1, pending: 2, passed: 3 };
        return priority[left.status] - priority[right.status];
      })
      .slice(0, 6) ?? [];
  return (
    <div className="fade-in space-y-6">
      <CommandShell
        variant="operational"
        eyebrow="治理 · 只读视图"
        title="课程运行治理"
        description="课程级运行边界只限制调度频率和影子运行预算，不代表发布授权；任何真实执行仍需独立策略与许可。"
        status={
          <>
            <StatusPill label="只读视图" tone="cyan" />
            <StatusPill label="真实发布关闭" tone="emerald" />
            <StatusPill label="缺策略即拒绝" tone="amber" />
          </>
        }
        actions={<AutonomySubnav />}
      />

      <GlassCard
        className="p-5 sm:p-6"
        data-testid="soak-readiness"
        tone={
          soakReadiness?.status === "blocked"
            ? "danger"
            : soakReadiness?.status === "qualified"
              ? "success"
              : soakReadiness?.status === "qualifying"
                ? "warning"
                : "default"
        }
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">
              RC13 · 长时运行证据
            </p>
            <h2 className="mt-2 text-lg font-semibold text-slate-50">长时运行资格（Soak readiness）</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-400">
              只评估外层定时唤醒的本地安全回执，不读取课程正文，也不触发编辑器、通知或发布。
            </p>
          </div>
          <StatusPill
            label={soakReadiness ? soakStatusLabel(soakReadiness.status) : "读取不可用"}
            tone={soakReadiness ? soakStatusTone(soakReadiness.status) : "muted"}
          />
        </div>

        {soakReadiness ? (
          <>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-md border border-slate-800 bg-slate-950/30 p-4">
                <p className="text-xs text-slate-500">目标 scope</p>
                <p className="mt-1 font-mono text-sm text-slate-100">
                  {soakReadiness.profile.source} · {soakReadiness.profile.runtimeVersion}
                </p>
                <p className="mt-1 text-xs text-slate-500">仅本地运行证据</p>
              </div>
              <div className="rounded-md border border-slate-800 bg-slate-950/30 p-4">
                <p className="text-xs text-slate-500">观察周期</p>
                <p className="mt-1 text-sm text-slate-100">
                  {durationLabel(soakReadiness.evidence.observationSpanMs)} / 目标 {durationLabel(soakReadiness.profile.minimumSpanMs)}
                </p>
              </div>
              <div className="rounded-md border border-slate-800 bg-slate-950/30 p-4">
                <p className="text-xs text-slate-500">完成轮次</p>
                <p className="mt-1 text-sm text-slate-100">
                  {soakReadiness.evidence.completedCount ?? "未知"} / 目标 {soakReadiness.profile.minimumCompletedCycles}
                </p>
              </div>
              <div className="rounded-md border border-slate-800 bg-slate-950/30 p-4">
                <p className="text-xs text-slate-500">连续完成 / 最近唤醒</p>
                <p className="mt-1 text-sm text-slate-100">
                  {soakReadiness.evidence.consecutiveCompletedCount ?? "未知"} 轮 · {soakReadiness.evidence.lastWakeAgeMs === null
                    ? "暂无可信唤醒证据"
                    : `${durationLabel(soakReadiness.evidence.lastWakeAgeMs)}前`}
                </p>
              </div>
            </div>

            <div className="mt-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-100">关键 blocker / check</h3>
                <span className="text-xs text-slate-500">最多显示 6 项未通过检查</span>
              </div>
              {keySoakChecks.length > 0 ? (
                <div className="mt-3 grid gap-2 lg:grid-cols-2">
                  {keySoakChecks.map((check) => (
                    <div
                      key={check.id}
                      className="flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-950/30 px-3 py-2"
                    >
                      <div>
                        <p className="text-sm text-slate-200">{SOAK_CHECK_LABELS[check.id]}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          当前 {soakCheckValue(check, check.observed)} · 要求 {soakCheckValue(check, check.expected)}
                        </p>
                      </div>
                      <StatusPill
                        label={soakCheckStatusLabel(check.status)}
                        tone={soakCheckTone(check.status)}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 rounded-md border border-emerald-400/20 bg-emerald-400/5 p-3 text-sm leading-6 text-emerald-100">
                  目标 scope 内的本地 blocker 与资格检查均已通过。
                </p>
              )}
            </div>

            <p className="mt-5 rounded-md border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-100">
              本地 qualified ≠ mature-v1 外部认证。失败通知送达与成功运行界面抑制仍缺少外部可观测证据，本页不会据此宣称成熟版本已完成。
            </p>
          </>
        ) : (
          <p className="mt-5 rounded-md border border-dashed border-slate-700 bg-slate-950/30 p-5 text-sm leading-6 text-slate-400">
            当前无法形成安全的 soak readiness 投影；本页不会展示底层错误，也不会把缺失证据解释为通过。
          </p>
        )}
      </GlassCard>

      <GlassCard className="p-5 sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-50">上限策略状态</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-400">
              默认只展示当前启用且对运营者可见课程的策略链。停用课程的历史记录继续保留在不可变审计表中，不会被后续修改覆盖。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusPill
              label={`${policies.filter((row) => row.isCurrent).length} 个当前版本`}
              tone="cyan"
            />
            <StatusPill
              label={`${policies.length} 个版本${policiesTruncated ? "（窗口）" : ""}`}
              tone="violet"
            />
          </div>
        </div>

        {policiesTruncated ? (
          <p className="mt-4 rounded-md border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-100">
            策略历史超过 {GOVERNANCE_VIEW_LIMIT} 条；本页当前版本与状态计数只覆盖可见窗口，不冒充全库事实。
          </p>
        ) : null}

        {policies.length === 0 ? (
          <div className="mt-5 rounded-md border border-dashed border-slate-700 bg-slate-950/30 p-5">
            <h3 className="font-semibold text-slate-100">当前没有显式治理策略</h3>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              系统不会自行补齐默认策略；没有有效策略时，定时运行和手动运行都会拒绝执行。
            </p>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {policies.map((row) => {
              return (
                <article
                  key={row.governanceHash}
                  className="grid gap-4 rounded-md border border-slate-800 bg-slate-950/30 p-4 text-sm lg:grid-cols-[1.1fr_0.8fr_1.2fr_1fr]"
                >
                  <div>
                    <p className="text-xs text-slate-500">课程 / 当前版本</p>
                    <p className="mt-1 text-slate-100">{operatorCourseLabel(row.courseAlias)}</p>
                    <div className="mt-2">
                      <StatusPill
                        label={row.isCurrent ? "当前生效链" : "历史 / 预定"}
                        tone={row.isCurrent ? "emerald" : "muted"}
                      />
                    </div>
                    <details className="mt-2 text-xs text-slate-500">
                      <summary className="cursor-pointer text-slate-400 hover:text-slate-200">核查信息</summary>
                      <div className="mt-2 space-y-1 font-mono">
                        <p>内部课程别名 {row.courseAlias}</p>
                        <p>策略版本 {row.version}</p>
                        <p>治理链 {compactHash(row.governanceHash)}</p>
                        <p>Manifest {compactHash(row.baseManifestHash)}</p>
                      </div>
                    </details>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">状态 / 模式</p>
                    <div className="mt-1">
                      <StatusPill label={stateLabel(row.status)} tone={stateTone(row.status)} />
                    </div>
                    <p className="mt-2 text-xs text-slate-400">{modeLabel(row.mode)}{row.emergencyHalt ? " · 紧急停止" : ""}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">有效期</p>
                    <p className="mt-1 text-xs leading-5 text-slate-200">{autonomyDate(new Date(row.validFrom))} → {autonomyDate(new Date(row.validUntil))}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">收紧后的配置上限</p>
                    <p className="mt-1 text-xs leading-5 text-slate-200">
                      每日 {row.limits.dailySlotLimit} · 单轮 {row.limits.perTickActionLimit} · 作者30日 {row.limits.authorTouchLimit30d} · 间隔 ≥ {row.limits.intervalMinutes} 分钟
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </GlassCard>

      <GlassCard className="p-5 sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-50">不可变生命周期记录</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-400">
              暂停、恢复、撤销、紧急停止与轮换都会追加新版本和变更记录。这里默认只展示本地治理事实，不会触碰论坛、编辑器或发布权限。
            </p>
          </div>
          <StatusPill
            label={`${transitions.length} 次状态变更${transitionsTruncated ? "（窗口）" : ""}`}
            tone="violet"
          />
        </div>

        {transitionsTruncated ? (
          <p className="mt-4 rounded-md border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-100">
            生命周期历史超过 {GOVERNANCE_VIEW_LIMIT} 条；当前只显示最新排序窗口，完整历史需使用后续分页读取。
          </p>
        ) : null}

        {transitions.length === 0 ? (
          <p className="mt-5 rounded-md border border-dashed border-slate-700 bg-slate-950/30 p-5 text-sm leading-6 text-slate-400">
            尚无状态变更记录；首次暂停、恢复、撤销、紧急停止或策略轮换后，会在这里显示可追溯记录。
          </p>
        ) : (
          <div className="mt-5 space-y-3">
            {transitions.map((transition) => (
              <article
                key={transition.eventHash ?? transition.createdAt ?? "invalid-transition"}
                className="grid gap-4 rounded-md border border-slate-800 bg-slate-950/30 p-4 text-sm lg:grid-cols-[1fr_0.8fr_1.2fr]"
              >
                {transition.integrityState === "valid" ? (
                  <>
                    <div>
                      <p className="text-xs text-slate-500">课程 / 状态变更</p>
                      <p className="mt-1 font-semibold text-slate-100">
                        {operatorCourseLabel(transition.courseAlias)} · {transitionActionLabel(transition.action)}
                      </p>
                      <p className="mt-1 text-xs text-slate-400">治理状态已追加记录</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">生效时间</p>
                      <p className="mt-1 text-slate-200">
                        {autonomyDate(new Date(transition.effectiveAt!))}
                      </p>
                      <StatusPill label="校验通过" tone="emerald" />
                    </div>
                    <div>
                      <details className="text-xs text-slate-500">
                        <summary className="cursor-pointer text-slate-400 hover:text-slate-200">核查信息</summary>
                        <div className="mt-2 space-y-1 font-mono">
                          <p>内部课程别名 {transition.courseAlias}</p>
                          <p>内部动作 {transition.action}</p>
                          <p>原因码 {transition.reasonCode}</p>
                          <p>变更链 {compactHash(transition.fromGovernanceHash!)} → {compactHash(transition.toGovernanceHash!)}</p>
                          <p>事件 {compactHash(transition.eventHash!)}</p>
                        </div>
                      </details>
                    </div>
                  </>
                ) : (
                  <div className="lg:col-span-3">
                    <StatusPill label="变更记录完整性无效" tone="danger" />
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </GlassCard>
    </div>
  );
}
