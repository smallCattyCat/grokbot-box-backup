"use client";

import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { CommandShell } from "@/components/ui/command-shell";
import { GlassCard } from "@/components/ui/glass-card";
import { StatusPill } from "@/components/ui/status-pill";
import type { CourseWorldScenarioLabReportV1 } from "@/lib/scenario-lab/contracts";
import type { OasisPreviewReportV1 } from "@/lib/scenario-lab/oasis-sidecar-contracts";
import styles from "./CourseWorldScenarioLab.module.css";

const RUN_REQUEST = {
  datasetRef: "p3a-2025-holdout-v1",
  scenarioSetRef: "scheduler-k-comparison-v1",
  runtimeId: "deterministic_p3a_replay_v1"
} as const;

const OASIS_PREVIEW_REQUEST = {
  datasetRef: "p3a-2025-holdout-v1",
  sceneTemplateRef: "course-support-network-64-v1",
  seedSetRef: "courseworld-seeds-16-v1",
  runtimeId: "oasis_contract_reference_v1"
} as const;

const integerFormatter = new Intl.NumberFormat("zh-CN");

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; report: CourseWorldScenarioLabReportV1 };

type OasisPreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; report: OasisPreviewReportV1 };

function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

function formatBps(value: number): string {
  return `${(value / 100).toFixed(1)}%`;
}

function formatSignedInteger(value: number): string {
  if (value === 0) return "0";
  return `${value > 0 ? "+" : "−"}${formatInteger(Math.abs(value))}`;
}

function formatSignedBps(value: number): string {
  if (value === 0) return "0.0pp";
  return `${value > 0 ? "+" : "−"}${(Math.abs(value) / 100).toFixed(1)}pp`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function formatClock(clock: unknown): string {
  const value = asRecord(clock);
  if (!value) return "冻结历史时钟";

  const decisionLag = value.decisionLagHours;
  const outcomeEnd = value.outcomeEndHours;
  const tickMinutes = value.schedulerTickMinutes;
  const candidateTtlMinutes = value.candidateTtlMinutes;
  if (
    typeof decisionLag === "number" &&
    typeof outcomeEnd === "number" &&
    typeof tickMinutes === "number"
  ) {
    return `决策 +${decisionLag}h · 观察终点 +${outcomeEnd}h · ${tickMinutes} 分钟 tick${typeof candidateTtlMinutes === "number" ? ` · TTL ${candidateTtlMinutes} 分钟` : ""}`;
  }

  return "冻结历史时钟 · 与实时资格及发布后结果时钟分离";
}

function availabilityTone(
  availability: string
): "emerald" | "cyan" | "amber" | "muted" {
  const normalized = availability.toLowerCase();
  if (normalized === "active" || normalized === "available" || normalized === "implemented") {
    return "emerald";
  }
  if (
    normalized === "next" ||
    normalized === "adapter_ready" ||
    normalized === "adapter_contract_ready"
  ) {
    return "cyan";
  }
  if (normalized === "planned" || normalized === "future") return "amber";
  return "muted";
}

function availabilityLabel(availability: string): string {
  const labels: Record<string, string> = {
    active: "当前运行",
    available: "可运行",
    implemented: "已实现",
    next: "下一阶段",
    adapter_ready: "适配器就绪",
    adapter_contract_ready: "适配契约就绪",
    planned: "计划中",
    future: "后续接入"
  };
  return labels[availability.toLowerCase()] ?? availability;
}

function runtimeRoleLabel(role: string): string {
  const labels: Record<string, string> = {
    historical_replay: "冻结证据上的确定性历史重放",
    social_interaction_simulation: "OASIS 社交互动仿真侧车",
    distributed_experiment_orchestration: "AgentSociety 2 分布式实验编排"
  };
  return labels[role] ?? role;
}

function receiptHashes(receipt: unknown): Array<[string, string]> {
  const value = asRecord(receipt);
  if (!value) return [];

  return Object.entries(value).filter(
    ([key, item]) => /hash/i.test(key) && typeof item === "string"
  ) as Array<[string, string]>;
}

function hashLabel(key: string): string {
  const labels: Record<string, string> = {
    evidenceHash: "证据集",
    scenarioHash: "情景规格",
    resultHash: "运行结果",
    runHash: "运行回执",
    sourceEvidenceHash: "证据集",
    scenarioSpecHash: "情景规格",
    scenarioResultSetHash: "情景结果集",
    forecastEnvelopeHash: "情景信封",
    receiptHash: "运行回执",
    temporalContractHash: "时间契约",
    implementationHash: "实现版本",
    actionLogHash: "动作日志"
  };
  return labels[key] ?? key.replace(/Hash$/i, "");
}

function shortHash(value: string): string {
  return value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

function oasisArmLabel(armId: string): string {
  const labels: Record<string, string> = {
    "wait-baseline": "WAIT 基线",
    "facilitation-k1": "促进 K=1",
    "facilitation-k3": "促进 K=3",
    "facilitation-k5": "促进 K=5"
  };
  return labels[armId] ?? armId;
}

function extractOasisPreviewReport(value: unknown): OasisPreviewReportV1 | null {
  const root = asRecord(value);
  if (!root) return null;
  const candidate = asRecord(root.report) ?? root;
  if (
    candidate.schemaVersion !== "cmooc.oasis-preview-report.v1" ||
    candidate.datasetRef !== OASIS_PREVIEW_REQUEST.datasetRef ||
    candidate.sceneTemplateRef !== OASIS_PREVIEW_REQUEST.sceneTemplateRef ||
    candidate.seedSetRef !== OASIS_PREVIEW_REQUEST.seedSetRef ||
    !asRecord(candidate.scenePack) ||
    !asRecord(candidate.capabilities) ||
    !asRecord(candidate.output) ||
    !asRecord(candidate.receipt) ||
    typeof candidate.reportHash !== "string"
  ) {
    return null;
  }
  return candidate as unknown as OasisPreviewReportV1;
}

function OasisPreviewPanel({
  state,
  onRun
}: {
  state: OasisPreviewState;
  onRun: () => void;
}) {
  if (state.status === "idle") {
    return (
      <GlassCard className={styles.oasisPreviewState} data-testid="oasis-preview-idle">
        <p className={styles.sectionCode}>OASIS PROTOCOL PREVIEW</p>
        <h3>等待显式运行协议预演</h3>
        <p>
          预演只检查 ScenePack、16 个固定种子与四臂聚合回执能否按 OASIS 侧车协议闭合；不会生成课程候选、许可或真实动作。
        </p>
      </GlassCard>
    );
  }

  if (state.status === "loading") {
    return (
      <GlassCard className={styles.oasisPreviewState} data-testid="oasis-preview-loading">
        <div role="status" aria-live="polite">
          <p className={styles.sectionCode}>OASIS PROTOCOL PREVIEW</p>
          <h3>正在运行协议一致性预演</h3>
          <p>正在核验 96 个合成 Agent、64 个合成讨论线程、16 个固定种子与四个研究臂。</p>
        </div>
      </GlassCard>
    );
  }

  if (state.status === "error") {
    return (
      <GlassCard className={styles.oasisPreviewState} tone="warning" data-testid="oasis-preview-error">
        <div role="alert">
          <p className={styles.sectionCode}>OASIS PROTOCOL PREVIEW</p>
          <h3>本次预演没有形成可核验回执</h3>
          <p>{state.message}</p>
          <button className={styles.oasisPreviewButton} type="button" onClick={onRun}>
            重新运行 OASIS 协议预演
          </button>
        </div>
      </GlassCard>
    );
  }

  const { report } = state;
  const boundary = report.output.executionBoundary;
  const nativeAvailable = report.capabilities.nativeOasisAvailable;

  return (
    <GlassCard className={styles.oasisPreviewCard} data-testid="oasis-preview-ready">
      <div className={styles.oasisPreviewHeader}>
        <div>
          <p className={styles.sectionCode}>SYNTHETIC · 协议一致性预演 · 不是教育效果预测</p>
          <h3>OASIS 四臂敏感性回执</h3>
          <p>p50 仅汇总固定合成种子下的协议参考运行，不表示真实课程中的个体结果、促进效果或因果效应。</p>
        </div>
        <StatusPill
          label={nativeAvailable ? "原生 OASIS 可用" : "原生 OASIS 未安装 · 契约参考运行时"}
          tone={nativeAvailable ? "emerald" : "muted"}
        />
      </div>

      <dl className={styles.oasisSceneFacts} aria-label="OASIS 协议预演规模">
        <div><dt>Agents</dt><dd>{report.scenePack.syntheticPopulation.agentCount}</dd></div>
        <div><dt>Threads</dt><dd>{report.scenePack.syntheticPopulation.threadCount}</dd></div>
        <div><dt>Seeds</dt><dd>{report.scenePack.runConfig.seeds.length}</dd></div>
        <div><dt>Arms</dt><dd>{report.scenePack.arms.length}</dd></div>
      </dl>

      <div className={styles.oasisTableScroll} tabIndex={0} role="region" aria-label="OASIS 四臂 p50 聚合表，可横向滚动">
        <table className={styles.oasisTable}>
          <caption>四个合成研究臂在 16 个固定种子上的 p50 协议输出</caption>
          <thead>
            <tr>
              <th scope="col">研究臂</th>
              <th scope="col">动作 p50</th>
              <th scope="col">回应覆盖 p50</th>
              <th scope="col">支持缺口 p50</th>
              <th scope="col">同伴回复边 p50</th>
            </tr>
          </thead>
          <tbody>
            {report.output.armSummaries.map((arm) => (
              <tr key={arm.armId}>
                <th scope="row">{oasisArmLabel(arm.armId)}</th>
                <td>{formatInteger(arm.facilitatorActionCount.p50)}</td>
                <td>{formatBps(arm.responseCoverageBps.p50)}</td>
                <td>{formatBps(arm.supportGapBps.p50)}</td>
                <td>{formatInteger(arm.peerReplyEdgeCount.p50)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.oasisBoundaryGrid}>
        <section aria-labelledby="oasis-boundary-title">
          <p className={styles.sectionCode}>EXECUTION BOUNDARY</p>
          <h4 id="oasis-boundary-title">侧车声明，不是沙箱证明</h4>
          <dl>
            <div><dt>evidenceMode</dt><dd><code>{boundary.evidenceMode}</code></dd></div>
            <div><dt>enforcementMode</dt><dd><code>{boundary.enforcementMode}</code></dd></div>
          </dl>
          <p>
            externalNetworkUsed=false、workspaceWriteCount=0、scratchWriteCount=0 是 sidecar self-report；process_contract_only 只证明进程协议声明，不能当作操作系统沙箱证明。
          </p>
        </section>
        <section aria-labelledby="oasis-hash-title">
          <p className={styles.sectionCode}>RECEIPT</p>
          <h4 id="oasis-hash-title">短哈希核对</h4>
          <dl>
            <div><dt>receipt</dt><dd title={report.receipt.receiptHash}><code>{shortHash(report.receipt.receiptHash)}</code></dd></div>
            <div><dt>report</dt><dd title={report.reportHash}><code>{shortHash(report.reportHash)}</code></dd></div>
          </dl>
          <p>decisionUse = research_only · interventionEligible = false · 课程平台写入与真实动作均为 0。</p>
        </section>
      </div>
    </GlassCard>
  );
}

function ScenarioLoading() {
  return (
    <GlassCard data-testid="scenario-lab-loading">
      <div className={styles.stateCard} role="status" aria-live="polite">
        <span className={styles.loadingMark} aria-hidden="true" />
        <div>
          <p className={styles.stateEyebrow}>正在构建影子世界</p>
          <h2>核验冻结证据并运行三档调度重放</h2>
          <p>读取聚合证据、校验时间契约，再生成 K=1 / 3 / 5 的确定性回执。</p>
        </div>
      </div>
    </GlassCard>
  );
}

function ScenarioError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <GlassCard tone="warning" data-testid="scenario-lab-error">
      <div className={styles.stateCard} role="alert">
        <span className={styles.errorMark} aria-hidden="true">!</span>
        <div>
          <p className={styles.stateEyebrow}>本次实验未形成回执</p>
          <h2>影子世界保持未运行状态</h2>
          <p>{message}</p>
          <button className={styles.retryButton} type="button" onClick={onRetry}>
            重新运行
          </button>
        </div>
      </div>
    </GlassCard>
  );
}

export function CourseWorldScenarioLab() {
  const [requestVersion, setRequestVersion] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [oasisPreviewState, setOasisPreviewState] = useState<OasisPreviewState>({ status: "idle" });
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const oasisPreviewAbortRef = useRef<AbortController | null>(null);

  const runScenario = useCallback(async (signal: AbortSignal) => {
    setLoadState({ status: "loading" });

    try {
      const response = await fetch("/api/scenario-lab/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(RUN_REQUEST),
        cache: "no-store",
        signal
      });

      if (!response.ok) {
        throw new Error(
          response.status >= 500
            ? "实验运行服务暂时不可用，事实世界未发生任何改变。"
            : "实验请求未通过契约校验，请重新运行。"
        );
      }

      const payload: unknown = await response.json();
      const payloadRecord = asRecord(payload);
      const report = (payloadRecord?.report ?? payload) as CourseWorldScenarioLabReportV1;
      if (!report || typeof report !== "object") {
        throw new Error("实验服务没有返回可读取的版本化回执。事实世界未发生任何改变。");
      }

      if (signal.aborted) return;
      setSelectedScenarioId(report.spec.referenceScenarioId);
      setLoadState({ status: "ready", report });
    } catch (error) {
      if (signal.aborted) return;
      setLoadState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "实验运行服务暂时不可用，事实世界未发生任何改变。"
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void runScenario(controller.signal);
    return () => controller.abort();
  }, [requestVersion, runScenario]);

  useEffect(() => () => oasisPreviewAbortRef.current?.abort(), []);

  const runOasisPreview = useCallback(async () => {
    oasisPreviewAbortRef.current?.abort();
    const controller = new AbortController();
    oasisPreviewAbortRef.current = controller;
    setOasisPreviewState({ status: "loading" });

    try {
      const response = await fetch("/api/scenario-lab/oasis-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(OASIS_PREVIEW_REQUEST),
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(
          response.status >= 500
            ? "OASIS 协议预演服务暂时不可用；事实世界和真实动作均未改变。"
            : "OASIS 协议预演请求未通过版本化契约校验。"
        );
      }

      const report = extractOasisPreviewReport(await response.json());
      if (!report) {
        throw new Error("OASIS 协议预演没有返回可读取的版本化聚合回执。事实世界未改变。");
      }
      if (controller.signal.aborted) return;
      setOasisPreviewState({ status: "ready", report });
    } catch (error) {
      if (controller.signal.aborted) return;
      setOasisPreviewState({
        status: "error",
        message: error instanceof Error
          ? error.message
          : "OASIS 协议预演服务暂时不可用；事实世界和真实动作均未改变。"
      });
    }
  }, []);

  const report = loadState.status === "ready" ? loadState.report : null;
  const scenarios = useMemo(
    () => [...(report?.scenarioResults ?? [])].sort((a, b) => a.dailyBudgetK - b.dailyBudgetK),
    [report]
  );
  const selectedScenario =
    scenarios.find((scenario) => scenario.scenarioId === selectedScenarioId) ?? scenarios[0] ?? null;
  const selectedComparison =
    report?.envelope.comparisons.find(
      (comparison) => comparison.scenarioId === selectedScenario?.scenarioId
    ) ?? null;

  const selectTab = (index: number) => {
    const scenario = scenarios[index];
    if (!scenario) return;
    setSelectedScenarioId(scenario.scenarioId);
    tabRefs.current[index]?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % scenarios.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + scenarios.length) % scenarios.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = scenarios.length - 1;

    if (nextIndex === null) return;
    event.preventDefault();
    selectTab(nextIndex);
  };

  return (
    <div className={`${styles.lab} fade-in`} data-testid="scenario-lab">
      <CommandShell
        variant="operational"
        testId="scenario-lab-masthead"
        eyebrow="COURSEWORLD · SCENARIO LAB"
        title="课程世界实验室"
        description="把冻结历史证据编译成可复核的影子世界，比较调度策略的覆盖、让位与暴露结构；实验只生成研究回执，不写课程事实世界。"
        status={
          <>
            <StatusPill label="影子世界 · 只读" tone="cyan" />
            <StatusPill label="不写事实世界" tone="emerald" />
            <StatusPill label="非教育效果估计" tone="muted" />
          </>
        }
      >
        <div className={styles.boundaryStrip}>
          <span>冻结证据</span>
          <i aria-hidden="true" />
          <span>确定性重放</span>
          <i aria-hidden="true" />
          <span>版本化回执</span>
          <strong>interventionEligible = false</strong>
        </div>
      </CommandShell>

      {loadState.status === "loading" ? <ScenarioLoading /> : null}
      {loadState.status === "error" ? (
        <ScenarioError
          message={loadState.message}
          onRetry={() => setRequestVersion((value) => value + 1)}
        />
      ) : null}

      {report && selectedScenario ? (
        <div className={styles.ready} data-testid="scenario-lab-ready">
          <section aria-labelledby="observed-title">
            <div className={styles.sectionHeading}>
              <div>
                <p className={styles.sectionCode}>01 · OBSERVED</p>
                <h2 id="observed-title">冻结证据的观察边界</h2>
              </div>
              <p>{formatClock(report.evidence.clock)}</p>
            </div>

            <div className={styles.observedGrid}>
              <GlassCard className={styles.observedPrimary}>
                <p className={styles.metricLabel}>2025 时间留出快照</p>
                <strong className={styles.heroNumber}>
                  {formatInteger(report.evidence.counts.snapshotCount)}
                </strong>
                <p className={styles.metricNote}>冻结观察总量 · 不含正文与身份</p>
              </GlassCard>

              <div className={styles.flowColumn}>
                <div className={styles.flowRow}>
                  <article>
                    <span>决策时点不符合候选条件</span>
                    <strong>
                      {formatInteger(report.evidence.counts.ineligibleOrAnsweredAtDecisionCount)}
                    </strong>
                  </article>
                  <article className={styles.candidateCell}>
                    <span>符合条件且未获回应</span>
                    <strong>{formatInteger(report.evidence.counts.eligibleUnansweredCount)}</strong>
                  </article>
                </div>
                <div className={styles.branchRule} aria-hidden="true" />
                <div className={styles.flowRow}>
                  <article className={styles.organicCell}>
                    <span>窗口内自然获得外部回应</span>
                    <strong>
                      {formatInteger(report.evidence.counts.organicExternalResponseInWindowCount)}
                    </strong>
                  </article>
                  <article className={styles.gapCell}>
                    <span>观察终点仍存在支持缺口</span>
                    <strong>
                      {formatInteger(report.evidence.counts.supportGapAtHorizonCount)}
                    </strong>
                  </article>
                </div>
              </div>
            </div>

            <p className={styles.equation}>
              <span>{formatInteger(report.evidence.counts.snapshotCount)}</span>
              = {formatInteger(report.evidence.counts.ineligibleOrAnsweredAtDecisionCount)} +
              {" "}<span>{formatInteger(report.evidence.counts.eligibleUnansweredCount)}</span>
              <b aria-hidden="true">·</b>
              <span>{formatInteger(report.evidence.counts.eligibleUnansweredCount)}</span>
              = {formatInteger(report.evidence.counts.organicExternalResponseInWindowCount)} +
              {" "}<span>{formatInteger(report.evidence.counts.supportGapAtHorizonCount)}</span>
            </p>
          </section>

          <section aria-labelledby="replay-title">
            <div className={styles.sectionHeading}>
              <div>
                <p className={styles.sectionCode}>02 · REPLAY</p>
                <h2 id="replay-title">预算改变时，调度结构如何移动</h2>
              </div>
              <p>同一冻结候选集 · K 只改变每日预算 · 不推断反事实学习结果</p>
            </div>

            <div
              className={styles.tabs}
              role="tablist"
              aria-label="选择每日调度预算"
            >
              {scenarios.map((scenario, index) => {
                const selected = scenario.scenarioId === selectedScenario.scenarioId;
                const isReference = scenario.scenarioId === report.spec.referenceScenarioId;
                return (
                  <button
                    key={scenario.scenarioId}
                    ref={(element) => {
                      tabRefs.current[index] = element;
                    }}
                    id={`scenario-tab-${scenario.dailyBudgetK}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`scenario-panel-${scenario.dailyBudgetK}`}
                    tabIndex={selected ? 0 : -1}
                    className={styles.tab}
                    data-selected={selected ? "true" : "false"}
                    onClick={() => setSelectedScenarioId(scenario.scenarioId)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                  >
                    <span>K = {scenario.dailyBudgetK}</span>
                    <small>{isReference ? "参考情景" : `${formatInteger(scenario.selectedCount)} 次选择`}</small>
                  </button>
                );
              })}
            </div>

            <GlassCard className={styles.replayPanel} tone="highlight">
              <div
                id={`scenario-panel-${selectedScenario.dailyBudgetK}`}
                role="tabpanel"
                aria-labelledby={`scenario-tab-${selectedScenario.dailyBudgetK}`}
                tabIndex={0}
              >
                <div className={styles.panelHeader}>
                  <div>
                    <p className={styles.panelK}>K = {selectedScenario.dailyBudgetK}</p>
                    <h3>
                      {formatInteger(selectedScenario.selectedCount)} 次选择，来自 {formatInteger(selectedScenario.candidateCount)} 个候选
                    </h3>
                  </div>
                  {selectedScenario.scenarioId === report.spec.referenceScenarioId ? (
                    <StatusPill label="冻结参考情景" tone="cyan" />
                  ) : (
                    <StatusPill label="预算敏感性情景" tone="violet" />
                  )}
                </div>

                <div className={styles.metricGrid}>
                  <article>
                    <span>支持缺口覆盖</span>
                    <strong>{formatBps(selectedScenario.gapCoverageBps)}</strong>
                    <div className={styles.bar} aria-hidden="true">
                      <i style={{ width: `${Math.min(selectedScenario.gapCoverageBps / 100, 100)}%` }} />
                    </div>
                    <small>全部观察终点缺口中被选择的比例</small>
                  </article>
                  <article>
                    <span>选择中的缺口占比</span>
                    <strong>{formatBps(selectedScenario.gapShareAmongSelectedBps)}</strong>
                    <div className={styles.bar} aria-hidden="true">
                      <i style={{ width: `${Math.min(selectedScenario.gapShareAmongSelectedBps / 100, 100)}%` }} />
                    </div>
                    <small>调度精度代理，不等同干预效果</small>
                  </article>
                  <article>
                    <span>自然回应重叠</span>
                    <strong>{formatBps(selectedScenario.naturalResponseOverlapBps)}</strong>
                    <div className={`${styles.bar} ${styles.amberBar}`} aria-hidden="true">
                      <i style={{ width: `${Math.min(selectedScenario.naturalResponseOverlapBps / 100, 100)}%` }} />
                    </div>
                    <small>后来出现真人回应的已选事件比例</small>
                  </article>
                  <article>
                    <span>独立作者覆盖</span>
                    <strong>{formatBps(selectedScenario.uniqueAuthorCoverageBps)}</strong>
                    <div className={styles.bar} aria-hidden="true">
                      <i style={{ width: `${Math.min(selectedScenario.uniqueAuthorCoverageBps / 100, 100)}%` }} />
                    </div>
                    <small>被调度作者在候选作者中的覆盖</small>
                  </article>
                  <article>
                    <span>7 日重复触达</span>
                    <strong>{formatBps(selectedScenario.repeatTouch7dBps)}</strong>
                    <div className={`${styles.bar} ${styles.amberBar}`} aria-hidden="true">
                      <i style={{ width: `${Math.min(selectedScenario.repeatTouch7dBps / 100, 100)}%` }} />
                    </div>
                    <small>同一作者七日内再次被选择的比例</small>
                  </article>
                  <article>
                    <span>作者暴露 Gini</span>
                    <strong>{formatBps(selectedScenario.authorExposureGiniBps)}</strong>
                    <div className={`${styles.bar} ${styles.violetBar}`} aria-hidden="true">
                      <i style={{ width: `${Math.min(selectedScenario.authorExposureGiniBps / 100, 100)}%` }} />
                    </div>
                    <small>越低表示选择分布越均衡</small>
                  </article>
                </div>

                <dl className={styles.schedulerDetails}>
                  <div>
                    <dt>选择前撤回</dt>
                    <dd>{formatInteger(selectedScenario.withdrawnBeforeSelectionCount)}</dd>
                  </div>
                  <div>
                    <dt>到期未选择</dt>
                    <dd>{formatInteger(selectedScenario.expiredUnselectedCount)}</dd>
                  </div>
                  <div>
                    <dt>情景标识</dt>
                    <dd title={selectedScenario.scenarioId}>{selectedScenario.scenarioId}</dd>
                  </div>
                </dl>
              </div>
            </GlassCard>

            <div className={styles.comparisonRail} aria-label="三档预算概览">
              {scenarios.map((scenario) => (
                <article key={scenario.scenarioId}>
                  <span>K={scenario.dailyBudgetK}</span>
                  <strong>{formatBps(scenario.gapCoverageBps)}</strong>
                  <small>缺口覆盖 · {formatBps(scenario.repeatTouch7dBps)} 重复触达</small>
                </article>
              ))}
            </div>
          </section>

          <section aria-labelledby="runtime-title">
            <div className={styles.sectionHeading}>
              <div>
                <p className={styles.sectionCode}>03 · RUNTIME LADDER</p>
                <h2 id="runtime-title">从确定性回放走向多智能体实验</h2>
              </div>
              <p>运行时可替换，事实与动作权威保持在产品内核</p>
            </div>

            <div className={styles.runtimeLayout}>
              <div className={styles.runtimeLadder}>
                {report.runtimeCapabilities.map((runtime, index) => {
                  const isOasisRuntime = runtime.role === "social_interaction_simulation";
                  return (
                    <article key={runtime.runtimeId} className={styles.runtimeItem}>
                      <span className={styles.runtimeIndex}>{String(index + 1).padStart(2, "0")}</span>
                      <div>
                        <div className={styles.runtimeTitleRow}>
                          <h3>{runtime.label}</h3>
                          <StatusPill
                            label={availabilityLabel(runtime.availability)}
                            tone={availabilityTone(runtime.availability)}
                          />
                        </div>
                        <p>{runtimeRoleLabel(runtime.role)}</p>
                        <code>{runtime.runtimeId}</code>
                        {isOasisRuntime ? (
                          <button
                            className={styles.oasisPreviewButton}
                            type="button"
                            aria-describedby="oasis-preview-boundary-copy"
                            disabled={oasisPreviewState.status === "loading"}
                            onClick={() => void runOasisPreview()}
                          >
                            {oasisPreviewState.status === "loading"
                              ? "OASIS 协议预演运行中…"
                              : "运行 OASIS 协议预演"}
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>

              <GlassCard className={styles.envelopeCard}>
                <p className={styles.sectionCode}>FORECAST ENVELOPE</p>
                <h3>比较被密封为研究读物</h3>
                <p>
                  {report.envelope.comparisons.length} 组版本化比较只描述重放结构与敏感性，不能生成候选、许可或真实动作。
                </p>
                {selectedComparison ? (
                  <div className={styles.deltaBlock} aria-label="相对参考情景的变化">
                    <div className={styles.deltaHeading}>
                      <span>K={selectedScenario.dailyBudgetK}</span>
                      <small>相对 {selectedComparison.relativeToScenarioId}</small>
                    </div>
                    <dl className={styles.deltaGrid}>
                      <div>
                        <dt>选择数</dt>
                        <dd>{formatSignedInteger(selectedComparison.selectedDelta)}</dd>
                      </div>
                      <div>
                        <dt>缺口覆盖</dt>
                        <dd>{formatSignedBps(selectedComparison.gapCoverageDeltaBps)}</dd>
                      </div>
                      <div>
                        <dt>重复触达</dt>
                        <dd>{formatSignedBps(selectedComparison.repeatTouch7dDeltaBps)}</dd>
                      </div>
                      <div>
                        <dt>暴露 Gini</dt>
                        <dd>{formatSignedBps(selectedComparison.authorExposureGiniDeltaBps)}</dd>
                      </div>
                    </dl>
                  </div>
                ) : (
                  <p className={styles.referenceNote}>当前为冻结参考情景，差值基线归零。</p>
                )}
                <ul>
                  <li><span aria-hidden="true">01</span> 不改写 Course Event World</li>
                  <li><span aria-hidden="true">02</span> 不进入 Resolver 与 Decision Tape</li>
                  <li><span aria-hidden="true">03</span> 不生成 R24 / R72 真实结果</li>
                </ul>
              </GlassCard>
            </div>
            <p id="oasis-preview-boundary-copy" className={styles.oasisPreviewBoundaryCopy}>
              OASIS 入口只运行合成协议参考场景；不读取论坛正文，不创建真实课程动作，也不进入事实世界或发布链。
            </p>
            <OasisPreviewPanel state={oasisPreviewState} onRun={() => void runOasisPreview()} />
          </section>

          <GlassCard className={styles.receiptCard} data-testid="scenario-lab-receipt">
            <div className={styles.receiptIntro}>
              <p className={styles.sectionCode}>RUN RECEIPT</p>
              <h2>这次影子世界可以被精确复核</h2>
              <p>证据、情景和实现均以哈希锚定；页面只接收聚合结果。</p>
            </div>
            <dl className={styles.hashGrid}>
              {receiptHashes(report.receipt).map(([key, value]) => (
                <div key={key}>
                  <dt>{hashLabel(key)}</dt>
                  <dd title={value}>{shortHash(value)}</dd>
                </div>
              ))}
            </dl>
          </GlassCard>
        </div>
      ) : null}
    </div>
  );
}
