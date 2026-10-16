import { AutonomySubnav } from "@/components/AutonomySubnav";
import { CommandShell } from "@/components/ui/command-shell";
import { GlassCard } from "@/components/ui/glass-card";
import { CockpitMetricCard } from "@/components/ui/metric-card";
import { StatusPill } from "@/components/ui/status-pill";
import {
  autonomyDate,
  compactHash
} from "@/lib/autonomy/read-model";
import { prisma } from "@/lib/db";
import { REAL_FORUM_WRITE_LOCKED } from "@/lib/forum/real-write-lock";

export const dynamic = "force-dynamic";

function policyStateLabel(status: string) {
  const labels: Record<string, string> = {
    active: "有效",
    revoked: "已撤销",
    expired: "已过期",
    draft: "草案"
  };
  return labels[status] ?? "未识别状态";
}

function permitStateLabel(status: string) {
  const labels: Record<string, string> = {
    active: "可领取",
    claimed: "已领取",
    used: "已消费",
    revoked: "已撤销",
    expired: "已过期"
  };
  return labels[status] ?? "未识别状态";
}

type TeachableEpisodeSummary = {
  state:
    | "shadow_proposed_unchanged"
    | "awaiting_learner"
    | "learner_returned"
    | "peer_taken_over"
    | "stalled_closed";
  action: "wait" | "yield" | "close";
};

function parseTeachableEpisodeSummary(
  decisionJson: string
): TeachableEpisodeSummary | null {
  try {
    const summary = JSON.parse(decisionJson) as {
      teachableEpisode?: unknown;
    };
    if (
      !summary.teachableEpisode ||
      typeof summary.teachableEpisode !== "object" ||
      Array.isArray(summary.teachableEpisode)
    ) {
      return null;
    }
    const episode = summary.teachableEpisode as Record<
      string,
      unknown
    >;
    const states = new Set([
      "shadow_proposed_unchanged",
      "awaiting_learner",
      "learner_returned",
      "peer_taken_over",
      "stalled_closed"
    ]);
    const actions = new Set(["wait", "yield", "close"]);
    if (
      typeof episode.state !== "string" ||
      !states.has(episode.state) ||
      typeof episode.action !== "string" ||
      !actions.has(episode.action)
    ) {
      return null;
    }
    return episode as TeachableEpisodeSummary;
  } catch {
    return null;
  }
}

export default async function AutonomyPolicyPage() {
  const [manifests, schedules, policies, permits, recentDecisions] =
    await Promise.all([
      prisma.autonomyCourseManifest.findMany({
        orderBy: { alias: "asc" }
      }),
      prisma.operationSchedule.findMany({
        orderBy: { courseAlias: "asc" }
      }),
      prisma.autonomyPolicy.findMany({
        orderBy: { validFrom: "desc" },
        take: 40
      }),
      prisma.executionPermit.findMany({
        orderBy: { createdAt: "desc" },
        take: 40
      }),
      prisma.autonomyDecision.findMany({
        orderBy: { evidenceAsOf: "desc" },
        take: 240,
        select: {
          courseAlias: true,
          threadKey: true,
          decisionJson: true
        }
      })
    ]);
  const latestEpisodeByThread = new Map<
    string,
    TeachableEpisodeSummary
  >();
  for (const decision of recentDecisions) {
    const key = `${decision.courseAlias}\u0000${decision.threadKey}`;
    if (latestEpisodeByThread.has(key)) continue;
    const episode = parseTeachableEpisodeSummary(
      decision.decisionJson
    );
    if (episode) latestEpisodeByThread.set(key, episode);
  }
  const teachableEpisodes = [...latestEpisodeByThread.values()];
  const episodeCount = (state: TeachableEpisodeSummary["state"]) =>
    teachableEpisodes.filter((episode) => episode.state === state)
      .length;
  const now = new Date();
  const activeAutoPolicyCount = policies.filter(
    (item) =>
      item.status === "active" &&
      item.mode === "AUTO" &&
      !item.emergencyHalt &&
      !item.revokedAt &&
      item.realPublishEnabled &&
      item.validFrom <= now &&
      item.validUntil > now
  ).length;
  const usableRealPermitCount = REAL_FORUM_WRITE_LOCKED
    ? 0
    : permits.filter(
        (item) =>
          item.status === "active" &&
          !item.revokedAt &&
          !item.usedAt &&
          item.expiresAt > now &&
          item.realPublishEnabled
      ).length;

  return (
    <div className="fade-in space-y-6">
      <CommandShell
        title="策略边界"
        description="真实发布必须连续通过全局硬锁、课程 Manifest、版本化 Policy 与单动作 Permit。任一层缺失、过期、撤销或关闭，AUTO 都会拒绝执行。"
        status={
          <>
            <StatusPill
              label={
                REAL_FORUM_WRITE_LOCKED
                  ? "全局写入硬锁开启"
                  : "全局写入硬锁已释放"
              }
              tone={REAL_FORUM_WRITE_LOCKED ? "emerald" : "danger"}
            />
            <StatusPill label="课程范围隔离" tone="cyan" />
            <StatusPill label="任一缺失即拒绝" tone="violet" />
          </>
        }
        actions={<AutonomySubnav />}
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <CockpitMetricCard
          label="全局写入硬锁"
          value={REAL_FORUM_WRITE_LOCKED ? "开启" : "关闭"}
          hint="硬锁开启时真实发布一律拒绝"
          tone={REAL_FORUM_WRITE_LOCKED ? "emerald" : "danger"}
        />
        <CockpitMetricCard
          label="课程 Manifest"
          value={manifests.length}
          hint="显式绑定；无静默默认课程"
          tone="cyan"
        />
        <CockpitMetricCard
          label="数据库计划"
          value={schedules.filter((item) => item.enabled).length}
          hint="持久化窗口，不代表外部唤醒"
          tone="violet"
        />
        <CockpitMetricCard
          label="有效 AUTO 策略"
          value={activeAutoPolicyCount}
          hint="已计入状态、时限、撤销与停机"
          tone="amber"
        />
        <CockpitMetricCard
          label="可真实发布许可"
          value={usableRealPermitCount}
          hint="需同时通过全部发布层，当前应为 0"
          tone="emerald"
        />
      </section>

      <GlassCard tone="highlight" className="overflow-hidden p-5 sm:p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">
              Teachable Episode Controller
            </p>
            <h2 className="mt-2 text-lg font-semibold text-slate-50">
              系统记住一次促进回合，后续自动等待、让位或结束
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
              相同目标与策略不会重复生成 SHADOW 草稿；学习者或同伴返回时立即让位；真实回合长期无回应时停止追发。状态只保存哈希、受控枚举与时间，不保存论坛正文，也不改变模型权重或发布权限。
            </p>
          </div>
          <StatusPill label="外置状态 · 零平台写入" tone="cyan" />
        </div>

        <ol className="mt-5 grid gap-2 text-sm md:grid-cols-4">
          {[
            ["01", "提出一次", "形成受约束的影子促进草稿"],
            ["02", "记住回合", "绑定目标、策略与渲染版本"],
            ["03", "自动调节", "重复则等待，真人返回则让位"],
            ["04", "保留能动性", "学习者可忽略、纠正、改向或停止"]
          ].map(([step, title, detail]) => (
            <li
              key={step}
              className="rounded-md border border-cyan-900/50 bg-slate-950/35 p-3"
            >
              <p className="font-mono text-xs text-cyan-300">{step}</p>
              <p className="mt-2 font-semibold text-slate-100">{title}</p>
              <p className="mt-1 text-xs leading-5 text-slate-400">{detail}</p>
            </li>
          ))}
        </ol>

        <dl className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-md border border-slate-800 bg-slate-950/30 p-3">
            <dt className="text-xs text-slate-500">影子提议已复用</dt>
            <dd className="mt-1 text-2xl font-semibold text-slate-50">
              {episodeCount("shadow_proposed_unchanged")}
            </dd>
          </div>
          <div className="rounded-md border border-slate-800 bg-slate-950/30 p-3">
            <dt className="text-xs text-slate-500">正在等待学习者</dt>
            <dd className="mt-1 text-2xl font-semibold text-slate-50">
              {episodeCount("awaiting_learner")}
            </dd>
          </div>
          <div className="rounded-md border border-slate-800 bg-slate-950/30 p-3">
            <dt className="text-xs text-slate-500">真人接管后让位</dt>
            <dd className="mt-1 text-2xl font-semibold text-slate-50">
              {episodeCount("learner_returned") +
                episodeCount("peer_taken_over")}
            </dd>
          </div>
          <div className="rounded-md border border-slate-800 bg-slate-950/30 p-3">
            <dt className="text-xs text-slate-500">停滞回合已关闭</dt>
            <dd className="mt-1 text-2xl font-semibold text-slate-50">
              {episodeCount("stalled_closed")}
            </dd>
          </div>
        </dl>
      </GlassCard>

      <GlassCard tone="success" className="p-5 sm:p-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.9fr)] lg:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">
              四层发布链
            </p>
            <h2 className="mt-2 text-lg font-semibold text-slate-50">
              当前全局真实写入硬锁仍在生效
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
              即使某条记录显示策略或许可已登记，硬锁也会让真实发布保持关闭。页面只呈现别名、状态、时间和哈希摘要，不展示正文、身份、平台标识或登录信息。
            </p>
          </div>
          <ol className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-1">
            {[
              ["1", "全局硬锁"],
              ["2", "课程 Manifest"],
              ["3", "版本化 Policy"],
              ["4", "单动作 Permit"]
            ].map(([step, label]) => (
              <li
                key={step}
                className="rounded-md border border-emerald-900/60 bg-slate-950/30 px-3 py-2 text-slate-200"
              >
                <span className="mr-2 font-mono text-emerald-300">{step}</span>
                {label}
              </li>
            ))}
          </ol>
        </div>
      </GlassCard>

      <GlassCard className="p-5 sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-50">
              课程 Manifest 与数据库计划
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-400">
              Manifest 是课程边界与模式的唯一显式来源。数据库 schedule 只保存可领取的周期和下次窗口；它不会启动外部 Codex 定时任务，也不证明任何外部唤醒正在运行。实际运行以单次运行回执为准。
            </p>
          </div>
          <StatusPill label="数据库计划不等于外部定时器" tone="amber" />
        </div>

        {manifests.length === 0 ? (
          <div className="mt-5 rounded-md border border-dashed border-slate-700 bg-slate-950/30 p-5">
            <h3 className="font-semibold text-slate-100">
              尚无可用的课程 Manifest
            </h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
              系统不会猜测或回退到默认课程。没有显式 Manifest 时，课程观察与 AUTO 发布都会保持拒绝；后续必须先写入可核验的课程别名、边界、模式与策略版本。
            </p>
          </div>
        ) : (
          <div className="mt-5 grid gap-3 lg:grid-cols-2">
            {manifests.map((manifest) => {
              const schedule = schedules.find(
                (item) => item.courseAlias === manifest.alias
              );
              return (
                <article
                  key={manifest.alias}
                  className="rounded-md border border-slate-700/70 bg-slate-950/30 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-slate-100">
                        {manifest.alias}
                      </h3>
                      <p className="mt-1 text-xs text-slate-400">
                        课程边界已由 Manifest 显式绑定
                      </p>
                    </div>
                    <StatusPill label={manifest.defaultMode} tone="cyan" />
                  </div>
                  <dl className="mt-4 grid gap-x-5 gap-y-3 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="text-slate-500">Manifest 回执</dt>
                      <dd className="mt-1 font-mono text-slate-200">
                        {compactHash(manifest.manifestHash)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">策略版本</dt>
                      <dd className="mt-1 text-slate-200">
                        {manifest.policyVersion}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">数据库计划</dt>
                      <dd className="mt-1 text-slate-200">
                        {schedule
                          ? schedule.enabled
                            ? "已登记"
                            : "已停用"
                          : "未配置"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">计划窗口</dt>
                      <dd className="mt-1 text-slate-200">
                        {schedule
                          ? `${schedule.intervalMinutes} 分钟 · ${autonomyDate(
                              schedule.nextRunAt
                            )}`
                          : "无可领取窗口"}
                      </dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-slate-500">Manifest 发布门</dt>
                      <dd className="mt-1 font-semibold text-emerald-300">
                        {manifest.realPublishEnabled
                          ? "已登记为 true，但仍受全局硬锁拒绝"
                          : "false（真实发布关闭）"}
                      </dd>
                    </div>
                  </dl>
                </article>
              );
            })}
          </div>
        )}
      </GlassCard>

      <GlassCard className="p-5 sm:p-6">
        <div>
          <h2 className="text-lg font-semibold text-slate-50">
            版本化 AUTO 策略
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-400">
            Policy 约束课程、允许模式、动作、预算和有效期。状态为 active 并不跳过 Manifest、全局硬锁或后续 Permit；过期、撤销和 emergency halt 均会直接关闭 AUTO。
          </p>
        </div>

        {policies.length === 0 ? (
          <div className="mt-5 rounded-md border border-dashed border-slate-700 bg-slate-950/30 p-5">
            <h3 className="font-semibold text-slate-100">
              当前没有已登记的 AUTO 策略
            </h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
              这是明确的 fail-closed 状态：没有版本化且在有效期内的策略，AUTO 不会获得动作权限。只读巡检和 SHADOW 可以继续产生去正文回执，但不能替代策略授权。
            </p>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {policies.map((policy) => (
              <article
                key={policy.id}
                className="grid gap-4 rounded-md border border-slate-800 bg-slate-950/30 p-4 text-sm lg:grid-cols-[1.15fr_1fr_1.2fr_0.95fr]"
              >
                <div>
                  <p className="text-xs text-slate-500">课程 / 版本</p>
                  <p className="mt-1 text-slate-100">
                    {policy.courseAlias} · {policy.version}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">策略状态</p>
                  <p className="mt-1 font-semibold text-slate-100">
                    {policyStateLabel(policy.status)}
                  </p>
                  <code className="mt-1 block text-xs text-slate-500">
                    {policy.status} · {policy.mode}
                  </code>
                </div>
                <div>
                  <p className="text-xs text-slate-500">有效期</p>
                  <p className="mt-1 text-xs leading-5 text-slate-100">
                    {autonomyDate(policy.validFrom)} → {" "}
                    {autonomyDate(policy.validUntil)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">发布门</p>
                  <p className="mt-1 font-semibold text-emerald-300">
                    {policy.emergencyHalt
                      ? "紧急停止"
                      : policy.realPublishEnabled
                        ? "策略已登记；硬锁仍拒绝"
                        : "false（关闭）"}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </GlassCard>

      <GlassCard className="p-5 sm:p-6">
        <div>
          <h2 className="text-lg font-semibold text-slate-50">
            单动作 ExecutionPermit
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-400">
            Permit 逐项绑定决定、目标版本、内容哈希、策略版本和幂等键。它不是常驻发布授权；领取、使用、撤销、过期或任一绑定变化都会使许可失效。
          </p>
        </div>

        {permits.length === 0 ? (
          <div className="mt-5 rounded-md border border-dashed border-slate-700 bg-slate-950/30 p-5">
            <h3 className="font-semibold text-slate-100">当前没有执行许可</h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
              没有单动作 Permit 时，AUTO 不能进入执行路径。即使未来存在策略记录，也仍需为当前目标重新核验并签发受时限约束的许可。
            </p>
          </div>
        ) : (
          <div className="mt-5 grid gap-3 lg:grid-cols-2">
            {permits.map((permit) => (
              <article
                key={permit.id}
                className="rounded-md border border-slate-800 bg-slate-950/30 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-slate-500">课程 / 策略</p>
                    <p className="mt-1 text-sm font-semibold text-slate-100">
                      {permit.courseAlias} · {permit.policyVersion}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-slate-500">许可状态</p>
                    <p className="mt-1 text-sm font-semibold text-slate-100">
                      {permitStateLabel(permit.status)}
                    </p>
                    <code className="mt-1 block text-xs text-slate-500">
                      {permit.status}
                    </code>
                  </div>
                </div>
                <dl className="mt-4 grid gap-x-4 gap-y-3 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-slate-500">到期</dt>
                    <dd className="mt-1 text-slate-200">
                      {autonomyDate(permit.expiresAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">许可回执</dt>
                    <dd className="mt-1 font-mono text-slate-200">
                      {compactHash(permit.permitKey)}
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-slate-500">绑定与发布门</dt>
                    <dd className="mt-1 leading-5 text-slate-300">
                      目标版本、内容哈希与幂等键已绑定；{permit.realPublishEnabled
                        ? "许可标记为 true，但全局硬锁仍拒绝真实写入。"
                        : "许可未开启真实发布。"}
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </GlassCard>
    </div>
  );
}
