export const RESEARCH_READINESS_POLICY = {
  minGraphNodeCount: 8,
  minGraphEdgeCount: 8,
  minMachineAgreementKappa: 0.7,
  requireParticipationAnalysisReady: true
} as const;

export type ResearchReadinessWarningLevel = "ready" | "sample_warning" | "insufficient_graph_signal" | "low_reliability";
export type ResearchReadinessCheckId = "graph_size" | "machine_agreement" | "participation_did";

type ResearchReadinessCheck = {
  id: ResearchReadinessCheckId;
  label: string;
  passed: boolean;
  value: string | number | boolean;
  threshold: string | number | boolean;
  passedLabel: string;
  failedLabel: string;
  failureHint: string;
};

type ResearchReadinessInput = {
  graphWaveletState: string;
  graphNodeCount: number;
  graphEdgeCount: number;
  participationAnalysisReady: boolean;
  machineAgreementKappa: number;
  humanReviewRecommendedCount: number;
  validityNoteCount: number;
};

export function evaluateResearchReadiness(input: ResearchReadinessInput) {
  const graphWaveletReady = input.graphWaveletState !== "insufficient_data"
    && input.graphNodeCount >= RESEARCH_READINESS_POLICY.minGraphNodeCount
    && input.graphEdgeCount >= RESEARCH_READINESS_POLICY.minGraphEdgeCount;
  const codingReliabilityReady = input.machineAgreementKappa >= RESEARCH_READINESS_POLICY.minMachineAgreementKappa;
  const participationAnalysisReady = !RESEARCH_READINESS_POLICY.requireParticipationAnalysisReady || input.participationAnalysisReady;
  const humanReviewRecommended = input.humanReviewRecommendedCount > 0 || !codingReliabilityReady;
  const warningLevel: ResearchReadinessWarningLevel = !graphWaveletReady
    ? "insufficient_graph_signal"
    : !codingReliabilityReady
      ? "low_reliability"
      : !participationAnalysisReady
        ? "sample_warning"
        : "ready";

  return {
    policy: RESEARCH_READINESS_POLICY,
    warningLevel,
    graphWaveletReady,
    codingReliabilityReady,
    participationAnalysisReady,
    humanReviewRecommended,
    validityNoteCount: input.validityNoteCount,
    checks: [
      {
        id: "graph_size",
        label: "图信号规模",
        passed: graphWaveletReady,
        value: `${input.graphNodeCount}/${input.graphEdgeCount}`,
        threshold: `${RESEARCH_READINESS_POLICY.minGraphNodeCount}/${RESEARCH_READINESS_POLICY.minGraphEdgeCount}`,
        passedLabel: "图结构可用",
        failedLabel: "图信号不足",
        failureHint: "互动图节点或边不足，图小波结果只能作为线索。"
      },
      {
        id: "machine_agreement",
        label: "机器复核一致性",
        passed: codingReliabilityReady,
        value: input.machineAgreementKappa,
        threshold: RESEARCH_READINESS_POLICY.minMachineAgreementKappa,
        passedLabel: "一致性达标",
        failedLabel: "一致性不足",
        failureHint: "Kappa 未达到策略门槛，需要人工复核编码结果。"
      },
      {
        id: "participation_did",
        label: "观测趋势 DiD",
        passed: participationAnalysisReady,
        value: input.participationAnalysisReady,
        threshold: RESEARCH_READINESS_POLICY.requireParticipationAnalysisReady,
        passedLabel: "趋势可分析",
        failedLabel: "样本不足",
        failureHint: "观测趋势样本不足，不能直接解释为干预效果。"
      }
    ] satisfies ResearchReadinessCheck[],
    recommendedUse: warningLevel === "ready"
      ? "可以作为研究指标摘要使用。"
      : "仅作为巡检线索使用，结论需要结合完整研究详情或人工复核。"
  };
}
