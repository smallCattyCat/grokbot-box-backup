import Link from "next/link";
import { AutonomySubnav } from "@/components/AutonomySubnav";
import { BriefIcon } from "@/components/autonomy/BriefIcon";
import {
  autonomyDate,
  buildAutonomyBriefNarrative,
  compactHash,
  formatObservedOutcomeWindows,
  getAutonomyDashboardReadModel
} from "@/lib/autonomy/read-model";
import styles from "./AutonomyDashboard.module.css";

const deepLinks = [
  {
    href: "/autonomy/world",
    title: "查看课程世界",
    description: "探索讨论、参与者与连接全貌",
    icon: "world" as const
  },
  {
    href: "/autonomy/decisions",
    title: "理解本轮决定",
    description: "回溯克制、让位与草稿证据",
    icon: "decisions" as const
  },
  {
    href: "/autonomy/outcomes",
    title: "核对近端观察",
    description: "查看 R24 / R72 描述性结果",
    icon: "outcomes" as const
  },
  {
    href: "/autonomy/governance",
    title: "进入运行驾驶舱",
    description: "核对课程治理与运行边界",
    icon: "cockpit" as const
  }
] as const;

const executionAgentProfiles = [
  {
    roleKey: "socratic_guide",
    name: "苏格拉底引导",
    shortName: "引导",
    description: "用追问打开思路，帮助学习者把直觉变成可讨论的问题。"
  },
  {
    roleKey: "evidence_connector",
    name: "证据连接",
    shortName: "证据",
    description: "把讨论观点与课程材料、概念和已有证据连接起来。"
  },
  {
    roleKey: "reflection_coach",
    name: "反思教练",
    shortName: "反思",
    description: "邀请学习者复盘过程，澄清变化、困难与下一步行动。"
  },
  {
    roleKey: "community_host",
    name: "社群主持",
    shortName: "社群",
    description: "串联同伴回应，让值得继续的对话获得更多参与。"
  }
] as const;

function countText(value: number | null | undefined): string {
  return typeof value === "number"
    ? new Intl.NumberFormat("zh-CN").format(value)
    : "—";
}

function coverageRatio(
  completed: number | undefined,
  total: number | undefined
): string {
  if (!total) return "—";
  return `${completed ?? 0}/${total}`;
}

function runPresentation(input: {
  mode?: string | null;
  status?: string | null;
  coverageComplete: boolean;
}) {
  const mode = (input.mode ?? "SHADOW").toUpperCase();
  if (input.status === "running") {
    return {
      label: `${mode} · 正在巡检`,
      tone: "good" as const,
      icon: "history" as const
    };
  }
  if (input.status === "failed") {
    return {
      label: `${mode} · 需要处理`,
      tone: "danger" as const,
      icon: "alert" as const
    };
  }
  if (input.status === "completed") {
    return {
      label: `${mode} · 运行完成`,
      tone: input.coverageComplete
        ? ("good" as const)
        : ("warning" as const),
      icon: "check" as const
    };
  }
  return {
    label: `${mode} · 等待唤醒`,
    tone: "warning" as const,
    icon: "history" as const
  };
}

export async function AutonomyDashboard() {
  const model = await getAutonomyDashboardReadModel();
  const invocation = model.focalInvocation;
  const latestInvocation = model.latestInvocation;
  const coverage = model.coverage;
  const world = model.world;
  const graph = model.graph;
  const executionAgents = model.executionAgents;
  const runTime = invocation?.finishedAt ?? invocation?.scheduledFor;
  const focalRunLabel =
    invocation?.status === "completed"
      ? "上一次完成巡检"
      : invocation?.status === "running"
        ? "巡检进行中"
        : invocation?.status === "failed"
          ? "巡检失败"
          : "等待巡检";
  const evidenceAsOf = runTime ? autonomyDate(runTime) : "等待回执";
  const observedWindows = formatObservedOutcomeWindows(
    model.observedOutcomeWindows
  );
  const narrative = buildAutonomyBriefNarrative({
    latestStatus: latestInvocation?.status,
    hasInvocation: Boolean(invocation),
    draftCount: model.decisions.draft,
    abstainCount: model.decisions.abstain,
    yieldCount: model.decisions.yield
  });
  const narrativeLines = narrative.includes("，")
    ? narrative.split(/(?<=，)/)
    : [narrative];
  const presentation = runPresentation({
    mode: latestInvocation?.mode ?? invocation?.mode,
    status: latestInvocation?.status ?? invocation?.status,
    coverageComplete: coverage?.complete === true
  });
  const statusToneClass =
    presentation.tone === "good"
      ? styles.statusGood
      : presentation.tone === "danger"
        ? styles.statusDanger
        : styles.statusWarning;
  const coverageSummary = coverage
    ? `${focalRunLabel}的证据快照覆盖 ${coverageRatio(coverage.categoryCompletedCount, coverage.categoryCount)} 个栏目、${coverageRatio(coverage.completedDetailCount, coverage.discoveredThreadCount)} 个讨论详情；${model.externalWriteAttemptCount === 0 ? "没有触发外部写入" : `记录到 ${model.externalWriteAttemptCount} 次外部写入尝试`}。`
    : "系统正在等待第一份可核验的课程覆盖回执。";
  const decisionSummary = `${model.decisions.abstain} 次克制、${model.decisions.yield} 次让位、${model.decisions.draft} 次草稿${model.decisions.wait > 0 ? `、${model.decisions.wait} 次等待` : ""}`;
  const evidenceSteps = [
    {
      href: invocation
        ? `/autonomy/runs/${invocation.id}`
        : "/autonomy/world",
      name: "持久化运行证据",
      value:
        world && graph && model.tapeCount > 0
          ? "World / Graph / Decision Tape 已落库"
          : "等待完整链路回执"
    },
    {
      href: "/review/live",
      name: "终态唤醒",
      value:
        model.wakeReceiptSummary.terminalCount > 0
          ? `${countText(model.wakeReceiptSummary.terminalCount)} 次（系统累计）`
          : "尚无终态唤醒"
    },
    {
      href: "/evidence",
      name: "确认发布",
      value:
        model.confirmedPublicationCount > 0
          ? `${countText(model.confirmedPublicationCount)} 次（系统历史）`
          : "尚无真实发布"
    },
    {
      href: "/autonomy/outcomes",
      name: "近端观察",
      value:
        model.observedOutcomeCount > 0
          ? `${observedWindows} 已观察（系统累计）`
          : model.pendingOutcomeCount > 0
            ? `${model.pendingOutcomeCount} 个窗口待观察`
            : "尚未形成观察窗口"
    },
    {
      href: "/evidence",
      name: "教育效果",
      value: "尚无证据"
    }
  ] as const;
  const activityRows = [
    {
      label: focalRunLabel,
      scope: evidenceAsOf,
      dateTime: runTime?.toISOString(),
      description: coverage
        ? `覆盖 ${coverageRatio(coverage.categoryCompletedCount, coverage.categoryCount)} 个栏目、${coverageRatio(coverage.completedDetailCount, coverage.discoveredThreadCount)} 个讨论详情；${coverage.failedTargetCount === 0 ? "没有目标失败" : `${coverage.failedTargetCount} 个目标失败`}。`
        : "尚无可核验的覆盖摘要。"
    },
    {
      label: "系统决定",
      scope: "本轮运行",
      description: `${decisionSummary}；持续维持让位优先的运行姿态。`
    },
    {
      label: "角色智能体",
      scope: "角色执行身份池",
      description:
        executionAgents.configurationState === "ready"
          ? `角色执行身份池已配置 ${countText(executionAgents.configuredRoleCount)} 类/${countText(executionAgents.configuredAgentCount)} 个；可用 ${countText(executionAgents.availableAgentCount)}、执行中 ${countText(executionAgents.activeAgentCount)}、冷却 ${countText(executionAgents.cooldownAgentCount)}、额度耗尽 ${countText(executionAgents.dailyLimitReachedAgentCount)}；今日消费 ${countText(executionAgents.consumedLeaseCountToday)} 次。它表示角色执行身份，不代表独立推理模型。`
          : executionAgents.configurationState === "not_configured"
            ? "四类角色原型已经就位；接入账号后，这里会切换为实时可用、执行、冷却与当日用量。"
            : "角色编队继续展示；实时账号状态暂未同步。"
    },
    {
      label: "共同体动态",
      scope: "同一 as-of 快照",
      description: world
        ? `出现 ${countText(world.threadCount)} 个讨论线程、${countText(world.actorCount)} 位事件参与者，并派生 ${countText(graph?.edgeCount)} 条互动连接。`
        : "等待课程世界快照。"
    },
    {
      label: "近端观察",
      scope: "历史合格行动",
      description:
        model.observedOutcomeCount > 0
          ? `${observedWindows} 观察已经完成；它们是发布后的描述性过程证据，不是因果或教育效果。`
          : "尚无已经完成的近端观察。"
    },
    {
      label: "系统治理",
      scope: "当前边界",
      description: `${model.realPublishEnabled ? "真实发布策略当前已启用" : "真实发布保持关闭"}；本轮外部写入 ${model.externalWriteAttemptCount} 次。`
    }
  ];
  const incompleteCommentThreadCount =
    coverage?.incompleteCommentThreadCount ?? 0;
  const executionAgentCards = executionAgentProfiles.map((profile) => {
    const role = executionAgents.roles.find(
      (candidate) => candidate.roleKey === profile.roleKey
    );
    const configuredCount = role?.configuredAgentCount ?? 0;
    const status =
      executionAgents.configurationState === "not_configured"
        ? "原型待接入"
        : executionAgents.configurationState === "unavailable"
          ? "状态待同步"
          : (role?.activeAgentCount ?? 0) > 0
            ? "执行中"
            : (role?.availableAgentCount ?? 0) > 0
              ? "可用"
              : (role?.cooldownAgentCount ?? 0) > 0
                ? "冷却中"
                : (role?.dailyLimitReachedAgentCount ?? 0) > 0
                  ? "今日任务完成"
                  : "待接入";
    const availability =
      executionAgents.configurationState === "ready"
        ? `${countText(configuredCount)} 个身份 · ${countText(role?.consumedLeaseCountToday)} 次今日行动`
        : "接入账号后显示实时轮换状态";

    return {
      ...profile,
      status,
      availability
    };
  });

  return (
    <div
      className={`fade-in ${styles.page}`}
      data-testid="autonomy-dashboard"
    >
      <div className={styles.subnavBar}>
        <AutonomySubnav />
      </div>

      <section className={styles.hero} aria-labelledby="brief-title">
        <div className={styles.heroCopy}>
          <h1 id="brief-title" className={styles.heroTitle}>
            {narrativeLines.map((line) => (
              <span key={line} className={styles.heroTitleLine}>
                {line}
              </span>
            ))}
          </h1>
          <p className={styles.heroSummary}>{coverageSummary}</p>
          <div className={styles.statusRow} aria-label="运行与发布状态">
            <span className={`${styles.status} ${statusToneClass}`}>
              <BriefIcon
                name={presentation.icon}
                className={styles.statusIcon}
              />
              {presentation.label}
            </span>
            <span
              className={`${styles.status} ${model.realPublishEnabled ? styles.statusDanger : styles.statusGood}`}
            >
              <BriefIcon
                name={model.realPublishEnabled ? "alert" : "lock"}
                className={styles.statusIcon}
              />
              {model.realPublishEnabled
                ? "真实发布策略有启用配置 · 非本次授权"
                : "真实发布策略配置关闭"}
            </span>
          </div>
        </div>

        <div className={styles.pulse} aria-labelledby="pulse-title">
          <div className={styles.pulseHeader}>
            <h2 id="pulse-title" className={styles.pulseTitle}>
              课程脉搏
            </h2>
            <span className={styles.pulseContext}>
              {evidenceAsOf} 单次快照 · 非趋势图
            </span>
          </div>
          <div className={styles.pulseTrack} aria-hidden="true">
            <span className={styles.pulseTicks} />
            <span className={styles.pulseMarker} />
          </div>
          <dl className={styles.pulseMetrics}>
            <div className={styles.pulseMetric}>
              <dt className={styles.pulseLabel}>观察事件</dt>
              <dd className={styles.pulseValue}>
                {countText(world?.eventCount)}
              </dd>
            </div>
            <div className={styles.pulseMetric}>
              <dt className={styles.pulseLabel}>讨论线程</dt>
              <dd className={styles.pulseValue}>
                {countText(world?.threadCount)}
              </dd>
            </div>
            <div className={styles.pulseMetric}>
              <dt className={styles.pulseLabel}>事件参与者</dt>
              <dd className={styles.pulseValue}>
                {countText(world?.actorCount)}
              </dd>
            </div>
            <div className={styles.pulseMetric}>
              <dt className={styles.pulseLabel}>互动连接</dt>
              <dd className={styles.pulseValue}>
                {countText(graph?.edgeCount)}
              </dd>
            </div>
          </dl>
          <div className={styles.decisionBlock}>
            <p className={styles.decisionLabel}>证据快照决策摘要</p>
            <dl className={styles.decisionMetrics}>
              <div className={styles.decisionMetric}>
                <dt>次克制</dt>
                <dd className={styles.decisionValue}>
                  {model.decisions.abstain}
                </dd>
              </div>
              <div className={styles.decisionMetric}>
                <dt>次让位</dt>
                <dd className={styles.decisionValue}>
                  {model.decisions.yield}
                </dd>
              </div>
              <div className={styles.decisionMetric}>
                <dt>次草稿</dt>
                <dd className={styles.decisionValue}>
                  {model.decisions.draft}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      <section
        className={styles.evidenceSection}
        aria-labelledby="evidence-ladder-title"
      >
        <h2 id="evidence-ladder-title" className={styles.sectionTitle}>
          证据阶梯
          <span className={styles.sectionNote}>由下而上，逐级可核</span>
        </h2>
        <ol className={styles.evidenceList}>
          {evidenceSteps.map((step, index) => (
            <li key={step.name} className={styles.evidenceItem}>
              <Link href={step.href} className={styles.evidenceLink}>
                <span className={styles.evidenceMarker}>{index + 1}</span>
                <span className={styles.evidenceCopy}>
                  <span className={styles.evidenceName}>{step.name}</span>
                  <span className={styles.evidenceValue}>{step.value}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      <section
        className={styles.agentSection}
        aria-labelledby="execution-agents-title"
        data-testid="execution-agent-prototype"
      >
        <div className={styles.agentHeader}>
          <div>
            <p className={styles.agentEyebrow}>多智能体角色编队</p>
            <h2 id="execution-agents-title" className={styles.agentTitle}>
              一个决策内核，四种协作身份
            </h2>
          </div>
          <span className={styles.agentPoolStatus}>
            {executionAgents.configurationState === "ready"
              ? `${countText(executionAgents.configuredAgentCount)} 个身份已接入`
              : "可交互原型"}
          </span>
        </div>
        <p className={styles.agentIntro}>
          系统会按讨论需要选择角色，再从对应账号中轮换执行。学习者看到的是分工清晰、公开披露的 AI
          角色，而不是同一个超强账号连续发言。
        </p>
        <div className={styles.agentGrid}>
          {executionAgentCards.map((agent, index) => (
            <article key={agent.roleKey} className={styles.agentCard}>
              <div className={styles.agentCardHeader}>
                <span className={styles.agentIndex} aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className={styles.agentStatus}>{agent.status}</span>
              </div>
              <p className={styles.agentShortName}>{agent.shortName}</p>
              <h3 className={styles.agentName}>{agent.name}</h3>
              <p className={styles.agentDescription}>{agent.description}</p>
              <p className={styles.agentAvailability}>{agent.availability}</p>
            </article>
          ))}
        </div>
        <p className={styles.agentFootnote}>
          原型节奏：机械日额度 5 次，每轮至多 1 次；账号按角色、当日用量与冷却状态自动轮换。
        </p>
      </section>

      <section className={styles.detailGrid} aria-label="本轮摘要与关注项">
        <article className={styles.panel}>
          <h2 className={styles.panelTitle}>证据快照发生了什么</h2>
          <ol className={styles.timelineList}>
            {activityRows.map((row) => (
              <li key={row.label} className={styles.timelineItem}>
                <div className={styles.timelineMeta}>
                  <span className={styles.timelineLabel}>{row.label}</span>
                  {row.dateTime ? (
                    <time
                      className={styles.timelineTime}
                      dateTime={row.dateTime}
                    >
                      {row.scope}
                    </time>
                  ) : (
                    <span className={styles.timelineTime}>{row.scope}</span>
                  )}
                </div>
                <p className={styles.timelineDescription}>
                  {row.description}
                </p>
              </li>
            ))}
          </ol>
        </article>

        <aside className={styles.panel} aria-labelledby="attention-title">
          <h2 id="attention-title" className={styles.panelTitle}>
            需要关注
          </h2>
          <ul className={styles.attentionList}>
            <li className={styles.attentionItem}>
              <span className={styles.attentionIcon}>
                <BriefIcon
                  name={
                    incompleteCommentThreadCount > 0 ? "alert" : "check"
                  }
                />
              </span>
              <div>
                <p className={styles.attentionTitle}>
                  {incompleteCommentThreadCount > 0
                    ? `${incompleteCommentThreadCount} 个评论范围仍为删失下界`
                    : "评论覆盖边界已完整记录"}
                </p>
                <p className={styles.attentionText}>
                  {incompleteCommentThreadCount > 0
                    ? "这些范围的真实值可能高于当前可见数据，网络指标继续按下界解释。"
                    : "当前快照没有需要额外解释的评论覆盖缺口。"}
                </p>
              </div>
            </li>
            <li className={styles.attentionItem}>
              <span
                className={`${styles.attentionIcon} ${styles.attentionIconHistory}`}
              >
                <BriefIcon name="history" />
              </span>
              <div>
                <p className={styles.attentionTitle}>
                  {model.unresolvedIncidentCount > 0
                    ? `${model.unresolvedIncidentCount} 项历史异常待长期复核`
                    : "没有待长期复核的历史异常"}
                </p>
                <p className={styles.attentionText}>
                  {model.unresolvedIncidentCount > 0
                    ? "开放和已确认但尚未解决的异常统一进入长期审核口径。"
                    : "当前开放与已确认未解决异常均为零。"}
                </p>
              </div>
            </li>
          </ul>
          <Link href="/review/live" className={styles.attentionLink}>
            进入长期审核查看详情
            <BriefIcon name="arrow" />
          </Link>
        </aside>
      </section>

      <nav className={styles.deepLinks} aria-label="成果证据下钻入口">
        {deepLinks.map((item) => (
          <Link key={item.href} href={item.href} className={styles.deepLink}>
            <span className={styles.deepIcon}>
              <BriefIcon name={item.icon} />
            </span>
            <span>
              <span className={styles.deepTitle}>{item.title}</span>
              <span className={styles.deepDescription}>
                {item.description}
              </span>
            </span>
            <BriefIcon name="arrow" className={styles.deepArrow} />
          </Link>
        ))}
      </nav>

      <p className={styles.evidenceFootnote}>
        World {compactHash(world?.worldHash)} · Tape{" "}
        {compactHash(model.tapeHeadHash)} · 当前真实发布{" "}
        {model.realPublishEnabled ? "ENABLED" : "LOCKED"}
      </p>
    </div>
  );
}
