"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { DownloadSimple } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import type {
  CourseOpportunityBriefGateState,
  CourseOpportunityBriefItem
} from "@/lib/workbench/course-opportunity-brief";
import type { CourseEvidenceWorkspace } from "@/lib/workbench/course-evidence-workspace";
import styles from "./OpportunityEvidenceWorkspace.module.css";

export type OpportunityLens = "evidence" | "change" | "portrait" | "research";

type ExtendedPortrait = CourseEvidenceWorkspace["portrait"] & {
  compatibleRange?: {
    lower: number | null;
    upper: number | null;
    basis?: string;
  } | null;
};

type ExtendedResearch = CourseEvidenceWorkspace["research"] & {
  sha256?: string | null;
  sourcePath?: string | null;
  reconstructionStatus?: "replayable" | "partial" | "unavailable";
};

const LENSES: Array<{ key: OpportunityLens; label: string }> = [
  { key: "evidence", label: "判断依据" },
  { key: "change", label: "事件变化" },
  { key: "portrait", label: "课程画像" },
  { key: "research", label: "研究证据" }
];

const WATERFALL_STATE_LABELS = {
  pass: "通过",
  fail: "停止",
  unknown: "待核验",
  not_evaluated: "未继续"
} as const;

function gateLabel(state: CourseOpportunityBriefGateState): string {
  if (state === "pass") return "通过";
  if (state === "blocked") return "停在这里";
  return "待核验";
}

function percent(value: number | null): string {
  return value === null ? "不可用" : `${Math.round(value * 100)}%`;
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

function metricDelta(value: number): string {
  if (value === 0) return "持平";
  return `${value > 0 ? "+" : ""}${compactNumber(value)}`;
}

function panelStyle(share: number | null): CSSProperties {
  return { "--coverage-share": `${Math.round((share ?? 0) * 100)}%` } as CSSProperties;
}

function EvidenceUnavailable({ children }: { children: string }) {
  return (
    <div className={styles.unavailable} role="status">
      <span aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}

function EvidencePanel({
  item,
  workspace,
  onHandoff
}: {
  item: CourseOpportunityBriefItem;
  workspace: CourseEvidenceWorkspace | undefined;
  onHandoff: (item: CourseOpportunityBriefItem) => void;
}) {
  const allGatesPass = Object.values(item.gates).every((state) => state === "pass");
  const waterfall = workspace?.waterfall;

  return (
    <div className={styles.panelStack}>
      <section className={styles.section} aria-labelledby="canvas-waterfall-heading">
        <div className={styles.sectionHeading}>
          <div>
            <span>证据资格链</span>
            <h4 id="canvas-waterfall-heading">六段判定瀑布</h4>
          </div>
          <small data-state={waterfall?.status ?? "unavailable"}>
            {waterfall?.headline ?? "尚无严格锚定的逐层证据"}
          </small>
        </div>
        {waterfall ? (
          <ol className={styles.waterfall} aria-label="六段证据资格判定">
            {waterfall.stages.map((stage, index) => (
              <li key={stage.key} data-state={stage.state}>
                <span className={styles.stageIndex} aria-hidden="true">
                  {stage.state === "pass" ? "✓" : index + 1}
                </span>
                <span className={styles.stageCopy}>
                  <strong>{stage.label}</strong>
                  <small>{stage.summary}</small>
                </span>
                <span className={styles.stageState}>{WATERFALL_STATE_LABELS[stage.state]}</span>
              </li>
            ))}
          </ol>
        ) : (
          <EvidenceUnavailable>当前项没有可以逐层重放的资格回执，不会用结构指标代替。</EvidenceUnavailable>
        )}
      </section>

      <section className={styles.section} aria-labelledby="canvas-facts-heading">
        <div className={styles.sectionHeading}>
          <div>
            <span>本项回执</span>
            <h4 id="canvas-facts-heading">观察到的事实</h4>
          </div>
        </div>
        <ul className={styles.factList}>
          {item.observedFacts.map((fact) => <li key={fact}>{fact}</li>)}
        </ul>
      </section>

      <section className={styles.section} aria-labelledby="canvas-gates-heading">
        <div className={styles.sectionHeading}>
          <div>
            <span>行动边界</span>
            <h4 id="canvas-gates-heading">
              {allGatesPass ? "行动条件" : "为什么停在这里"}
            </h4>
          </div>
        </div>
        <dl className={styles.gates}>
          <div data-state={item.gates.admission}>
            <dt>准入</dt><dd>{gateLabel(item.gates.admission)}</dd>
          </div>
          <div data-state={item.gates.review}>
            <dt>复核</dt><dd>{gateLabel(item.gates.review)}</dd>
          </div>
          <div data-state={item.gates.conditions}>
            <dt>条件</dt><dd>{gateLabel(item.gates.conditions)}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="canvas-boundary-heading">
        <div className={styles.sectionHeading}>
          <div>
            <span>证据诚实性</span>
            <h4 id="canvas-boundary-heading">限制与缺口</h4>
          </div>
        </div>
        <ul className={styles.limitList}>
          {item.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
        </ul>
      </section>

      <footer className={styles.actions}>
        {item.canHandoff ? (
          <button type="button" onClick={() => onHandoff(item)}>
            带入新任务 <ArrowRight size={15} aria-hidden="true" />
          </button>
        ) : null}
        <Link href={item.sourceHref}>
          打开完整证据 <ArrowSquareOut size={15} aria-hidden="true" />
        </Link>
      </footer>
    </div>
  );
}

function ChangePanel({ workspace }: { workspace: CourseEvidenceWorkspace | undefined }) {
  const change = workspace?.change;
  if (!change || change.status === "unavailable") {
    return (
      <div className={styles.panelStack}>
        <section className={styles.section}>
          <div className={styles.sectionHeading}>
            <div><span>同课程 · 严格时间前缀</span><h4>事件变化暂不可比</h4></div>
          </div>
          <EvidenceUnavailable>
            {change?.summary ?? "当前没有可比的早期快照，不把缺失写成零变化。"}
          </EvidenceUnavailable>
          {change?.limitation ? <p className={styles.boundaryNote}>{change.limitation}</p> : null}
        </section>
      </div>
    );
  }

  const lowerBound = change.status === "lower_bound";

  return (
    <div className={styles.panelStack}>
      <section className={styles.section} aria-labelledby="canvas-change-heading">
        <div className={styles.sectionHeading}>
          <div>
            <span>同课程 · 相邻可比快照</span>
            <h4 id="canvas-change-heading">
              {lowerBound ? "结构事件变化（可见范围）" : "结构事件变化"}
            </h4>
          </div>
          <small data-state={change.status}>
            {lowerBound ? "可见下界 · 聚合计数" : "完整覆盖 · 聚合计数"}
          </small>
        </div>
        <p className={styles.changeSummary}>{change.summary}</p>
        <div className={styles.changeTable} role="table" aria-label="课程结构变化">
          <div className={styles.changeHeader} role="row">
            <span role="columnheader">观察项</span>
            <span role="columnheader">上次</span>
            <span role="columnheader">当前</span>
            <span role="columnheader">{lowerBound ? "可见差" : "变化"}</span>
          </div>
          {change.metrics.map((entry) => (
            <div className={styles.changeRow} role="row" key={entry.key}>
              <strong role="cell">{entry.label}</strong>
              <span role="cell">{entry.before === null ? "—" : compactNumber(entry.before)}</span>
              <span role="cell">{entry.after === null ? "—" : compactNumber(entry.after)}</span>
              <span role="cell" data-direction={(entry.delta ?? 0) > 0 ? "up" : (entry.delta ?? 0) < 0 ? "down" : "flat"}>
                {entry.delta === null ? "不可比" : metricDelta(entry.delta)}
              </span>
            </div>
          ))}
        </div>
        <p className={styles.boundaryNote}>{change.limitation}</p>
      </section>
    </div>
  );
}

function CoverageMeasure({
  label,
  share,
  numerator,
  denominator,
  note
}: {
  label: string;
  share: number | null;
  numerator: number;
  denominator: number;
  note: string;
}) {
  return (
    <div className={styles.coverageMeasure}>
      <div>
        <strong>{label}</strong>
        <span>{percent(share)}</span>
      </div>
      <div
        className={styles.coverageBar}
        style={panelStyle(share)}
        role="img"
        aria-label={`${label}：${numerator} / ${denominator}，${percent(share)}`}
      >
        <span />
      </div>
      <small>{compactNumber(numerator)} / {compactNumber(denominator)} · {note}</small>
    </div>
  );
}

function PortraitPanel({ workspace }: { workspace: CourseEvidenceWorkspace | undefined }) {
  const portrait = workspace?.portrait as ExtendedPortrait | undefined;
  if (!portrait || portrait.status === "unavailable") {
    return (
      <div className={styles.panelStack}>
        <section className={styles.section}>
          <div className={styles.sectionHeading}>
            <div><span>群体级 · 去身份</span><h4>课程画像尚未就绪</h4></div>
          </div>
          <EvidenceUnavailable>{portrait?.summary ?? "当前没有足够的覆盖与图证据，不生成个体标签。"}</EvidenceUnavailable>
        </section>
      </div>
    );
  }
  const compatible = portrait.compatibleRange;

  return (
    <div className={styles.panelStack}>
      <section className={styles.section} aria-labelledby="canvas-portrait-heading">
        <div className={styles.sectionHeading}>
          <div><span>双分母 · 支持边界</span><h4 id="canvas-portrait-heading">课程群体画像</h4></div>
          <small data-state={portrait.status}>{portrait.status === "supported" ? "完整覆盖" : "可见下界"}</small>
        </div>
        <div className={styles.coverageStack}>
          <CoverageMeasure
            label="完整讨论单位"
            share={portrait.completeUnitShare}
            numerator={portrait.completeUnitCount}
            denominator={portrait.totalUnitCount}
            note="讨论单位分母"
          />
          <CoverageMeasure
            label="观察任务覆盖"
            share={portrait.observationCoverage.share}
            numerator={portrait.observationCoverage.completedDetailCount}
            denominator={portrait.observationCoverage.discoveredThreadCount}
            note="详情任务分母"
          />
        </div>
        <dl className={styles.portraitFacts}>
          <div>
            <dt>未支持讨论单位</dt>
            <dd>{percent(portrait.unsupportedUnitShare)}</dd>
            <small>{compactNumber(portrait.unsupportedUnitCount)} 个单位保留为未支持，不编码成 0</small>
          </div>
          <div>
            <dt>成熟支持缺口</dt>
            <dd>{compactNumber(portrait.matureSupportGapCount)}</dd>
            <small>课程级聚合，不含学习者身份</small>
          </div>
          <div>
            <dt>互动功能相容范围</dt>
            <dd>
              {compatible && compatible.lower !== null && compatible.upper !== null
                ? `${percent(compatible.lower)} – ${percent(compatible.upper)}`
                : "尚未持久化"}
            </dd>
            <small>{compatible?.basis ?? "不用结构连线代替互动功能分类"}</small>
          </div>
        </dl>
        <p className={styles.boundaryNote}>{portrait.limitation}</p>
      </section>
    </div>
  );
}

function ResearchPanel({ workspace }: { workspace: CourseEvidenceWorkspace | undefined }) {
  const research = workspace?.research as ExtendedResearch | undefined;
  const downloadable = workspace?.status === "ready" && Boolean(research?.exportHref);
  return (
    <div className={styles.panelStack}>
      <section className={styles.section} aria-labelledby="canvas-research-heading">
        <div className={styles.sectionHeading}>
          <div><span>可审计 · 可重放边界</span><h4 id="canvas-research-heading">聚合研究证据包</h4></div>
          <small>{research?.deterministic ? "确定性 JSON" : "尚未就绪"}</small>
        </div>
        {research ? (
          <div className={styles.researchColumns}>
            <div>
              <strong>包含</strong>
              <ul>{research.includes.map((entry) => <li key={entry}>{entry}</li>)}</ul>
            </div>
            <div>
              <strong>明确排除</strong>
              <ul>{research.excludes.map((entry) => <li key={entry}>{entry}</li>)}</ul>
            </div>
          </div>
        ) : (
          <EvidenceUnavailable>缺少精确快照锚点，当前不生成研究包。</EvidenceUnavailable>
        )}
        <p className={styles.boundaryNote}>
          研究包只用于聚合证据核对；不支持个体诊断、因果效果或真实发布判断。
        </p>
        <div className={styles.researchActionRow}>
          {downloadable ? (
            <a className={styles.downloadAction} href={research!.exportHref} download>
              <DownloadSimple size={17} aria-hidden="true" />
              下载研究证据包
            </a>
          ) : (
            <button type="button" className={styles.downloadAction} disabled>
              <DownloadSimple size={17} aria-hidden="true" />
              证据包不可用
            </button>
          )}
          {research ? (
            <details className={styles.researchDetails}>
              <summary>核验与路径</summary>
              <dl>
                <div><dt>SHA-256</dt><dd><code>{research.sha256 ?? "下载时生成并随回执提供"}</code></dd></div>
                <div><dt>导出端点</dt><dd><code>{research.exportHref || "不可用"}</code></dd></div>
                {research.sourcePath ? <div><dt>受管路径</dt><dd><code>{research.sourcePath}</code></dd></div> : null}
              </dl>
            </details>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export function OpportunityEvidenceWorkspace({
  item,
  workspace,
  onHandoff,
  onViewChange
}: {
  item: CourseOpportunityBriefItem;
  workspace: CourseEvidenceWorkspace | undefined;
  onHandoff: (item: CourseOpportunityBriefItem) => void;
  onViewChange?: () => void;
}) {
  const [activeLens, setActiveLens] = useState<OpportunityLens>("evidence");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const idPrefix = useId().replace(/:/g, "");

  useEffect(() => {
    setActiveLens("evidence");
  }, [item.id]);

  const activate = (lens: OpportunityLens, focus = false) => {
    setActiveLens(lens);
    onViewChange?.();
    if (focus) {
      const index = LENSES.findIndex((candidate) => candidate.key === lens);
      window.requestAnimationFrame(() => tabRefs.current[index]?.focus());
    }
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, LENSES.findIndex((lens) => lens.key === activeLens));
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? LENSES.length - 1
        : event.key === "ArrowRight"
          ? (current + 1) % LENSES.length
          : (current - 1 + LENSES.length) % LENSES.length;
    activate(LENSES[next]!.key, true);
  };

  const activePanel = activeLens === "evidence"
    ? <EvidencePanel item={item} workspace={workspace} onHandoff={onHandoff} />
    : activeLens === "change"
      ? <ChangePanel workspace={workspace} />
      : activeLens === "portrait"
        ? <PortraitPanel workspace={workspace} />
        : <ResearchPanel workspace={workspace} />;

  return (
    <div className={styles.workspace}>
      <div className={styles.tabs} role="tablist" aria-label="证据视角" onKeyDown={handleTabKeyDown}>
        {LENSES.map((lens, index) => (
          <button
            ref={(node) => { tabRefs.current[index] = node; }}
            id={`${idPrefix}-${lens.key}-tab`}
            key={lens.key}
            type="button"
            role="tab"
            aria-selected={activeLens === lens.key}
            aria-controls={`${idPrefix}-${lens.key}-panel`}
            tabIndex={activeLens === lens.key ? 0 : -1}
            onClick={() => activate(lens.key)}
          >
            {lens.label}
          </button>
        ))}
      </div>

      <div
        id={`${idPrefix}-${activeLens}-panel`}
        role="tabpanel"
        aria-labelledby={`${idPrefix}-${activeLens}-tab`}
        tabIndex={0}
        className={styles.panel}
      >
        {activePanel}
      </div>
    </div>
  );
}
