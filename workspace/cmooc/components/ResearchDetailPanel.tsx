"use client";

import { useState } from "react";

type ResearchDetailPayload = {
  detail?: string;
  cache?: {
    hit?: boolean;
    ttlSeconds?: number;
    expiresAt?: string;
  };
  readiness?: {
    warningLevel?: "ready" | "sample_warning" | "insufficient_graph_signal" | "low_reliability";
    graphWaveletReady?: boolean;
    codingReliabilityReady?: boolean;
    participationAnalysisReady?: boolean;
    humanReviewRecommended?: boolean;
    validityNoteCount?: number;
    recommendedUse?: string;
    policy?: {
      minGraphNodeCount: number;
      minGraphEdgeCount: number;
      minMachineAgreementKappa: number;
      requireParticipationAnalysisReady: boolean;
    };
    checks?: Array<{
      id: string;
      label?: string;
      passed: boolean;
      value: string | number | boolean;
      threshold: string | number | boolean;
      passedLabel?: string;
      failedLabel?: string;
      failureHint?: string;
    }>;
  };
  algorithms?: {
    graphWavelet?: {
      state?: string;
      stateLabel?: string;
      nodeCount?: number;
      edgeCount?: number;
      highFrequencyEnergyRatio?: number;
      roughnessRatio?: number;
      topNodes?: Array<{
        label: string;
        anomalyScore: number;
      }>;
    };
    research?: {
      socialNetwork?: {
        edgeModel?: string;
        scope?: {
          type?: string;
          runId?: string | null;
          postCount?: number;
        };
        edgeCount?: number;
        rawReplyEdgeCount?: number;
        postReplyEdgeCount?: number;
        nestedReplyEdgeCount?: number;
        density?: number;
        reciprocity?: number;
        averageClustering?: number;
        latestSyncUpdatedUserCount?: number | null;
      };
      codingReliability?: {
        machineAgreementKappa?: number;
        humanReviewRecommendedCount?: number;
      };
      quasiExperiment?: {
        participationAnalysisReady?: boolean;
        participationDid?: number;
        avgCieDid?: number;
        validityNotes?: string[];
      };
    };
  };
};

type ResearchDetailPanelProps = {
  digestEndpoint: string;
  detailEndpoint: string;
  fullStatusEndpoint: string;
};

function displayNumber(value: number | undefined, fallback = "-") {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : fallback;
}

function displayCheckValue(value: string | number | boolean | undefined) {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length > 0) return value;
  return "-";
}

function checkToneClass(passed: boolean) {
  return passed
    ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
    : "border-amber-400/50 bg-amber-400/10 text-amber-200";
}

function summaryToneClass(failedCount: number, hasPayload: boolean) {
  if (!hasPayload) return "border-slate-700 bg-slate-900/60 text-slate-300";
  return failedCount > 0
    ? "border-amber-400/40 bg-amber-400/10 text-amber-100"
    : "border-emerald-400/40 bg-emerald-400/10 text-emerald-100";
}

export function ResearchDetailPanel({ digestEndpoint, detailEndpoint, fullStatusEndpoint }: ResearchDetailPanelProps) {
  const [payload, setPayload] = useState<ResearchDetailPayload | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("等待按需读取。");

  async function loadResearchDetail() {
    setPending(true);
    setMessage("正在读取研究证据...");
    try {
      const response = await fetch(digestEndpoint, { cache: "no-store" });
      const nextPayload = (await response.json()) as ResearchDetailPayload;
      if (!response.ok) {
        setMessage("研究证据读取失败。");
        return;
      }
      setPayload(nextPayload);
      setMessage("研究证据已读取。");
    } catch {
      setMessage("研究证据读取失败。");
    } finally {
      setPending(false);
    }
  }

  const graphWavelet = payload?.algorithms?.graphWavelet;
  const socialNetwork = payload?.algorithms?.research?.socialNetwork;
  const codingReliability = payload?.algorithms?.research?.codingReliability;
  const quasiExperiment = payload?.algorithms?.research?.quasiExperiment;
  const readiness = payload?.readiness;
  const readinessChecks = readiness?.checks ?? [];
  const failedReadinessChecks = readinessChecks.filter((check) => !check.passed);
  const failedCheckIds = failedReadinessChecks.map((check) => check.id).join(",");
  const readinessDecision = failedReadinessChecks.length > 0
    ? `${failedReadinessChecks.length} 项待复核`
    : payload
      ? "全部通过"
      : "未读取";
  const readinessHint = failedReadinessChecks.length > 0
    ? failedReadinessChecks.map((check) => check.failureHint ?? check.failedLabel ?? check.label ?? check.id).join("；")
    : readiness?.recommendedUse ?? "等待按需读取。";
  const primaryFailedCheck = failedReadinessChecks[0];
  const readinessSummaryText = primaryFailedCheck
    ? `${primaryFailedCheck.failedLabel ?? "待复核"}：${primaryFailedCheck.label ?? primaryFailedCheck.id}`
    : payload
      ? readinessDecision
      : "等待按需读取";
  const topNodes = graphWavelet?.topNodes?.slice(0, 3) ?? [];
  const evidenceState = readiness?.warningLevel ?? "not_loaded";
  const evidenceStateLabel = readiness?.warningLevel === "ready"
    ? "可作为摘要"
    : readiness?.warningLevel === "sample_warning"
      ? "样本提示"
      : readiness?.warningLevel === "insufficient_graph_signal"
        ? "图信号不足"
        : readiness?.warningLevel === "low_reliability"
          ? "一致性不足"
          : "未读取";
  const snaScopeLabel = socialNetwork?.scope?.type === "forum_ingestion_run"
    ? `最近快照 ${displayNumber(socialNetwork.scope.postCount)} 帖`
    : socialNetwork?.scope?.type
      ? "全量本地库"
      : "未读取";

  return (
    <div
      className="mt-4 rounded-md border border-slate-800 bg-slate-950/45 p-3"
      data-testid="operator-research-detail-panel"
      data-state={pending ? "loading" : payload ? "loaded" : "idle"}
      data-digest-endpoint={digestEndpoint}
      data-detail-endpoint={detailEndpoint}
      data-full-status-endpoint={fullStatusEndpoint}
      data-cache-hit={payload?.cache?.hit ?? ""}
      data-cache-ttl-seconds={payload?.cache?.ttlSeconds ?? ""}
      data-graph-wavelet-state={graphWavelet?.state ?? "not_loaded"}
      data-evidence-state={evidenceState}
      data-graph-wavelet-ready={readiness?.graphWaveletReady ?? ""}
      data-coding-reliability-ready={readiness?.codingReliabilityReady ?? ""}
      data-participation-analysis-ready={readiness?.participationAnalysisReady ?? ""}
      data-human-review-recommended={readiness?.humanReviewRecommended ?? ""}
      data-validity-note-count={readiness?.validityNoteCount ?? ""}
      data-readiness-check-count={readinessChecks.length}
      data-readiness-failed-check-count={failedReadinessChecks.length}
      data-readiness-failed-checks={failedCheckIds}
      data-readiness-primary-failed-check={primaryFailedCheck?.id ?? ""}
      data-readiness-decision={readinessDecision}
      data-min-graph-node-count={readiness?.policy?.minGraphNodeCount ?? ""}
      data-min-graph-edge-count={readiness?.policy?.minGraphEdgeCount ?? ""}
      data-min-machine-agreement-kappa={readiness?.policy?.minMachineAgreementKappa ?? ""}
      data-sna-density={socialNetwork?.density ?? ""}
      data-sna-edge-model={socialNetwork?.edgeModel ?? ""}
      data-sna-scope={socialNetwork?.scope?.type ?? ""}
      data-sna-scope-run-id={socialNetwork?.scope?.runId ?? ""}
      data-sna-edge-count={socialNetwork?.edgeCount ?? ""}
      data-sna-nested-reply-edge-count={socialNetwork?.nestedReplyEdgeCount ?? ""}
      data-machine-agreement-kappa={codingReliability?.machineAgreementKappa ?? ""}
      data-participation-did={quasiExperiment?.participationDid ?? ""}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          data-testid="operator-load-research-detail"
          data-agent-action="read-on-demand-research"
          data-action-category="read_only"
          data-requires-confirmation="false"
          data-polling-policy="on_demand_only"
          data-request-endpoint={digestEndpoint}
          aria-disabled={pending}
          disabled={pending}
          onClick={loadResearchDetail}
          className="rounded-md border border-cyan-400/50 px-3 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-400 hover:text-slate-950 disabled:opacity-60"
        >
          {pending ? "读取中" : "读取研究证据"}
        </button>
        <span
          data-testid="operator-research-detail-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-busy={pending}
          className="text-xs text-slate-400"
        >
          {message}
        </span>
      </div>
      <div
        className={`mt-3 grid gap-1 rounded-md border px-3 py-2 text-xs sm:grid-cols-[auto_1fr] sm:items-center ${summaryToneClass(failedReadinessChecks.length, Boolean(payload))}`}
        data-testid="operator-research-readiness-summary"
        data-primary-failed-check={primaryFailedCheck?.id ?? ""}
        data-failed-check-count={failedReadinessChecks.length}
        data-readiness-decision={readinessDecision}
      >
        <span className="font-semibold">研究证据</span>
        <b className="min-w-0 truncate sm:text-right">{readinessSummaryText}</b>
        <span className="sm:col-span-2 text-slate-400">{readinessHint}</span>
      </div>

      <div data-testid="operator-research-detail-evidence" className="mt-3 grid gap-2 text-sm text-slate-300">
        <div className="flex justify-between gap-3"><span>图小波状态</span><b>{graphWavelet?.stateLabel ?? "未读取"}</b></div>
        <div className="flex justify-between gap-3"><span>证据状态</span><b>{evidenceStateLabel}</b></div>
        <div className="flex justify-between gap-3"><span>节点 / 边</span><b>{displayNumber(graphWavelet?.nodeCount)} / {displayNumber(graphWavelet?.edgeCount)}</b></div>
        <div className="flex justify-between gap-3"><span>高频能量</span><b>{displayNumber(graphWavelet?.highFrequencyEnergyRatio)}</b></div>
        <div className="flex justify-between gap-3"><span>SNA 范围</span><b>{snaScopeLabel}</b></div>
        <div className="flex justify-between gap-3"><span>SNA 边模型</span><b>{socialNetwork?.edgeModel ? "评论目标关系" : "未读取"}</b></div>
        <div className="flex justify-between gap-3"><span>评论边 / 二级回复边</span><b>{displayNumber(socialNetwork?.rawReplyEdgeCount)} / {displayNumber(socialNetwork?.nestedReplyEdgeCount)}</b></div>
        <div className="flex justify-between gap-3"><span>网络密度</span><b>{displayNumber(socialNetwork?.density)}</b></div>
        <div className="flex justify-between gap-3"><span>机器复核一致性</span><b>{displayNumber(codingReliability?.machineAgreementKappa)}</b></div>
        <div className="flex justify-between gap-3"><span>质量策略</span><b>图 {readiness?.policy ? `${readiness.policy.minGraphNodeCount}/${readiness.policy.minGraphEdgeCount}` : "-"} · Kappa {displayNumber(readiness?.policy?.minMachineAgreementKappa)}</b></div>
        <div className="flex justify-between gap-3"><span>观测趋势 DiD</span><b>{quasiExperiment?.participationAnalysisReady ? "可分析" : payload ? "样本不足" : "未读取"} · {displayNumber(quasiExperiment?.participationDid)}</b></div>
        <div className="flex justify-between gap-3"><span>复核提示</span><b>{readiness?.humanReviewRecommended ? "建议复核" : payload ? "未触发" : "未读取"}</b></div>
        <div
          className="border-t border-slate-800 pt-2"
          data-testid="operator-research-readiness-checks"
          data-failed-checks={failedCheckIds}
          data-failed-check-count={failedReadinessChecks.length}
        >
          <div className="flex justify-between gap-3"><span>门槛核查</span><b>{readinessDecision}</b></div>
          {readinessChecks.length > 0 ? (
            <div className="mt-2 grid gap-0 text-xs sm:gap-1" data-readiness-display="compact">
              {readinessChecks.map((check) => (
                <div
                  key={check.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-t border-slate-800/70 py-1.5 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:border-t-0 sm:py-0"
                  data-testid={`operator-research-readiness-check-${check.id}`}
                  data-check-id={check.id}
                  data-check-passed={check.passed}
                  data-check-value={displayCheckValue(check.value)}
                  data-check-threshold={displayCheckValue(check.threshold)}
                >
                  <span className="min-w-0 truncate text-slate-400">{check.label ?? check.id}</span>
                  <span className={`rounded-sm border px-1.5 py-0.5 text-[11px] font-semibold leading-4 ${checkToneClass(check.passed)}`}>
                    {check.passed ? (check.passedLabel ?? "通过") : (check.failedLabel ?? "待复核")}
                  </span>
                  <b className="col-span-2 font-mono text-[11px] leading-4 text-slate-200 sm:col-span-1 sm:text-right">
                    {displayCheckValue(check.value)} / {displayCheckValue(check.threshold)}
                  </b>
                </div>
              ))}
            </div>
          ) : null}
          <p className="mt-2 text-xs text-slate-400" data-testid="operator-research-readiness-hint">
            {readinessHint}
          </p>
        </div>
        <div className="border-t border-slate-800 pt-2 text-xs text-slate-400">
          局部异常：{topNodes.map((node) => `${node.label}(${node.anomalyScore})`).join("、") || "-"}
        </div>
      </div>
    </div>
  );
}
