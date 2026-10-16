import type { GraphWaveletSnapshot } from "@/lib/analytics/graph-wavelet";
import type { LlmRuntimeStatus } from "@/lib/llm/client";

export type OperatorPipelineTone = "cyan" | "blue" | "violet" | "emerald" | "amber" | "danger" | "muted";

export type OperatorPipelineStep = {
  id: "api" | "llm" | "graph-wavelet" | "safety" | "evidence";
  label: string;
  value: string;
  state: string;
  stateLabel: string;
  tone: OperatorPipelineTone;
};

export type WaveletMonitorOutput = {
  researchAlgorithm?: {
    wavelet?: {
      state?: string;
      trend?: number;
      burstWindow?: number[];
    };
  };
};

export function graphWaveletStateLabel(state: string) {
  if (state === "fragmented_need_signal") return "局部割裂";
  if (state === "localized_shift") return "局部突变";
  if (state === "smooth_diffusion") return "平滑扩散";
  return "样本不足";
}

export function parseWaveletOutput(value: string | null): WaveletMonitorOutput | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as WaveletMonitorOutput;
  } catch {
    return null;
  }
}

export function buildOperatorPipelineSteps(input: {
  postCount: number;
  agentRunCount: number;
  llmStatus: LlmRuntimeStatus;
  graphWavelet?: GraphWaveletSnapshot;
  realPublishEnabled: boolean;
}): OperatorPipelineStep[] {
  const graphWaveletStep: OperatorPipelineStep = input.graphWavelet
    ? {
      id: "graph-wavelet",
      label: "图小波",
      value: graphWaveletStateLabel(input.graphWavelet.state),
      state: input.graphWavelet.state,
      stateLabel: input.graphWavelet.state === "insufficient_data" ? "样本不足" : "已计算",
      tone: input.graphWavelet.state === "fragmented_need_signal"
        ? "amber"
        : input.graphWavelet.state === "insufficient_data"
          ? "muted"
          : "cyan"
    }
    : {
      id: "graph-wavelet",
      label: "图小波",
      value: "按需详情",
      state: "deferred_research_detail",
      stateLabel: "按需",
      tone: "muted"
    };

  return [
    {
      id: "api",
      label: "API采集",
      value: `${input.postCount}帖`,
      state: input.postCount > 0 ? "ready" : "empty",
      stateLabel: input.postCount > 0 ? "已入库" : "待采集",
      tone: input.postCount > 0 ? "cyan" : "muted"
    },
    {
      id: "llm",
      label: "LLM判断",
      value: input.llmStatus.provider,
      state: input.llmStatus.mode,
      stateLabel: input.llmStatus.mode === "real" ? "真实" : "降级",
      tone: input.llmStatus.mode === "real" ? "cyan" : "muted"
    },
    graphWaveletStep,
    {
      id: "safety",
      label: "安全审核",
      value: input.realPublishEnabled ? "受控发布" : "只巡检",
      state: input.realPublishEnabled ? "guarded_real_publish" : "dry_run_guard",
      stateLabel: input.realPublishEnabled ? "双确认" : "保护中",
      tone: input.realPublishEnabled ? "amber" : "muted"
    },
    {
      id: "evidence",
      label: "证据回写",
      value: `${input.agentRunCount}次`,
      state: input.agentRunCount > 0 ? "recorded" : "empty",
      stateLabel: input.agentRunCount > 0 ? "已记录" : "待记录",
      tone: input.agentRunCount > 0 ? "emerald" : "muted"
    }
  ];
}
