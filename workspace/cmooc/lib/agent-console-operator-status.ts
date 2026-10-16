import { buildOperatorPipelineSteps, graphWaveletStateLabel, type OperatorPipelineStep } from "@/lib/agent-console-pipeline";
import { evaluateResearchReadiness } from "@/lib/analytics/research-readiness";
import {
  getAgentConsoleBaseSnapshot,
  getAgentConsoleSnapshot,
  getAgentConsoleSummarySnapshot,
  type AgentConsoleBaseSnapshot
} from "@/lib/agent-console-snapshot";
import { prisma } from "@/lib/db";
import { anonymizeLearnerName } from "@/lib/privacy";

const RESEARCH_DETAIL_ENDPOINT = "/api/operator/research";
const RESEARCH_DIGEST_ENDPOINT = "/api/operator/research?format=digest";
const FULL_STATUS_ENDPOINT = "/api/operator/status?detail=full";
const FULL_STATUS_CACHE_TTL_MS = 15_000;

type OperatorStatusDetail = "summary" | "full";
type FullSnapshot = Awaited<ReturnType<typeof getAgentConsoleSnapshot>>;
type SummarySnapshot = Awaited<ReturnType<typeof getAgentConsoleSummarySnapshot>>;
type SharedSnapshot = FullSnapshot | SummarySnapshot;
type FullOperatorStatusPayload = Awaited<ReturnType<typeof buildFullOperatorStatusPayload>>;

type FullOperatorStatusCache = {
  expiresAt: number;
  payload: FullOperatorStatusPayload;
  signature: string;
};

const operatorStatusGlobal = globalThis as typeof globalThis & {
  __cmoocFullOperatorStatusCache?: FullOperatorStatusCache | null;
};

function readFullOperatorStatusCache() {
  return operatorStatusGlobal.__cmoocFullOperatorStatusCache ?? null;
}

function writeFullOperatorStatusCache(cache: FullOperatorStatusCache) {
  operatorStatusGlobal.__cmoocFullOperatorStatusCache = cache;
}

function dateStamp(value: Date | null | undefined) {
  return value ? value.toISOString() : "-";
}

function buildFullCacheSignature(snapshot: AgentConsoleBaseSnapshot) {
  return [
    `posts:${snapshot.counts.postCount}`,
    `candidates:${snapshot.counts.candidateCount}`,
    `published:${snapshot.counts.publishedCount}`,
    `agentRuns:${snapshot.counts.agentRunCount}`,
    `realPublish:${snapshot.settings.realPublishEnabled}`,
    `llm:${snapshot.llmStatus.mode}:${snapshot.llmStatus.provider}`,
    `scheduler:${snapshot.scheduler.running}:${snapshot.scheduler.config?.mode ?? "-"}`,
    `latestRun:${snapshot.latestRun?.id ?? "-"}:${dateStamp(snapshot.latestRun?.updatedAt)}`,
    `topCandidate:${snapshot.topCandidate?.id ?? "-"}:${dateStamp(snapshot.topCandidate?.updatedAt)}`,
    `latestWave:${snapshot.latestWaveRun?.id ?? "-"}:${dateStamp(snapshot.latestWaveRun?.finishedAt ?? snapshot.latestWaveRun?.startedAt)}`
  ].join("|");
}

function serializeLatestRun(snapshot: SharedSnapshot) {
  const latestRun = snapshot.latestRun;
  return latestRun
    ? {
      id: latestRun.id,
      mode: latestRun.mode,
      status: latestRun.status,
      createdAt: latestRun.createdAt.toISOString(),
      candidateCount: latestRun.candidates.length,
      topCandidateScore: latestRun.candidates[0]?.interventionScore ?? null
    }
    : null;
}

function serializeTopCandidate(snapshot: SharedSnapshot) {
  const topCandidate = snapshot.topCandidate;
  return topCandidate
    ? {
      id: topCandidate.id,
      postTitle: topCandidate.postTitle,
      interventionScore: topCandidate.interventionScore,
      interventionType: topCandidate.interventionType,
      targetMode: topCandidate.targetMode,
      status: topCandidate.status,
      safetyRisk: topCandidate.safetyRisk ?? topCandidate.riskLevel,
      reason: topCandidate.reason,
      postUrl: topCandidate.postUrl
    }
    : null;
}

function buildBasePayload(snapshot: SharedSnapshot, detail: OperatorStatusDetail, pipeline: OperatorPipelineStep[]) {
  const scheduler = snapshot.scheduler;

  return {
    app: "cMOOC 智能学伴自动干预维护系统",
    detail,
    generatedAt: new Date().toISOString(),
    researchDetailEndpoint: RESEARCH_DETAIL_ENDPOINT,
    fullStatusEndpoint: FULL_STATUS_ENDPOINT,
    safeDefault: {
      mode: "dry_run",
      allowRealPublish: false,
      currentTurnConfirmationRequiredForRealPublish: true
    },
    safety: {
      realPublishEnabled: snapshot.settings.realPublishEnabled,
      schedulerRunning: scheduler.running,
      schedulerExecuting: scheduler.isExecuting,
      schedulerMode: scheduler.config?.mode ?? null,
      schedulerRunOnceCategory: scheduler.config?.mode === "real_publish"
        ? "high_impact_real_publish"
        : "safe_scheduler_control"
    },
    llm: snapshot.llmStatus,
    metrics: snapshot.counts,
    pipeline,
    latestRun: serializeLatestRun(snapshot),
    topCandidate: serializeTopCandidate(snapshot)
  };
}

function buildTemporalWavelet(snapshot: SharedSnapshot) {
  return {
    state: snapshot.wavelet?.state ?? null,
    trend: snapshot.wavelet?.trend ?? null,
    burstWindow: snapshot.wavelet?.burstWindow ?? [],
    latestMonitorStartedAt: snapshot.latestWaveRun?.startedAt.toISOString() ?? null
  };
}

async function getLatestSocialNetworkSync() {
  const run = await prisma.agentRun.findFirst({
    where: { agentName: "social-network-sync-agent", status: "success" },
    orderBy: { startedAt: "desc" }
  });
  if (!run) return null;
  try {
    return JSON.parse(run.outputJson) as {
      scope?: { type?: string; runId?: string | null; sourceUrl?: string | null; postCount?: number };
      edgeModel?: string;
      edgeCount?: number;
      rawReplyEdgeCount?: number;
      postReplyEdgeCount?: number;
      nestedReplyEdgeCount?: number;
      density?: number;
      reciprocity?: number;
      averageClustering?: number;
      updatedUserCount?: number;
      topUsers?: unknown[];
    };
  } catch {
    return null;
  }
}

function buildFullAlgorithms(snapshot: FullSnapshot) {
  const { researchSnapshot, graphWavelet } = snapshot;
  const participation = researchSnapshot.quasiExperiment.outcomes.participation;
  const avgCie = researchSnapshot.quasiExperiment.outcomes.avgCie;
  const topGraphNodes = graphWavelet.topNodes.slice(0, 5).map((node) => ({
    ...node,
    id: anonymizeLearnerName(node.id),
    label: anonymizeLearnerName(node.label)
  }));
  const topUsers = researchSnapshot.socialNetwork.topUsers.slice(0, 5).map((user) => ({
    ...user,
    id: anonymizeLearnerName(user.id),
    name: anonymizeLearnerName(user.name)
  }));

  return {
    temporalWavelet: buildTemporalWavelet(snapshot),
    graphWavelet: {
      state: graphWavelet.state,
      stateLabel: graphWaveletStateLabel(graphWavelet.state),
      method: graphWavelet.method,
      nodeCount: graphWavelet.nodeCount,
      edgeCount: graphWavelet.edgeCount,
      scales: graphWavelet.scales,
      graphRoughness: graphWavelet.graphRoughness,
      roughnessRatio: graphWavelet.roughnessRatio,
      totalEnergy: graphWavelet.totalEnergy,
      highFrequencyEnergyRatio: graphWavelet.highFrequencyEnergyRatio,
      pprMassConcentration: graphWavelet.pprMassConcentration,
      topNodes: topGraphNodes,
      scaleSummaries: graphWavelet.scaleSummaries
    },
    research: {
      socialNetwork: {
        edgeModel: researchSnapshot.socialNetwork.edgeModel,
        nodeCount: researchSnapshot.socialNetwork.nodeCount,
        edgeCount: researchSnapshot.socialNetwork.edgeCount,
        rawReplyEdgeCount: researchSnapshot.socialNetwork.rawReplyEdgeCount,
        postReplyEdgeCount: researchSnapshot.socialNetwork.postReplyEdgeCount,
        nestedReplyEdgeCount: researchSnapshot.socialNetwork.nestedReplyEdgeCount,
        density: researchSnapshot.socialNetwork.density,
        reciprocity: researchSnapshot.socialNetwork.reciprocity,
        averageDegree: researchSnapshot.socialNetwork.averageDegree,
        averageClustering: researchSnapshot.socialNetwork.averageClustering,
        topUsers
      },
      codingReliability: {
        machineAgreementKappa: researchSnapshot.codingReliability.machineAgreement.kappa,
        humanReviewRecommendedCount: researchSnapshot.codingReliability.humanReviewRecommendedCount
      },
      quasiExperiment: {
        participationAnalysisReady: participation.validity.analysisReady,
        participationDid: participation.did,
        avgCieDid: avgCie.did,
        validityNotes: researchSnapshot.quasiExperiment.validityNotes
      }
    }
  };
}

function buildSummaryAlgorithms(snapshot: SummarySnapshot) {
  return {
    temporalWavelet: buildTemporalWavelet(snapshot),
    graphWavelet: {
      state: "deferred_research_detail",
      stateLabel: "按需读取",
      detailEndpoint: RESEARCH_DETAIL_ENDPOINT,
      fullStatusEndpoint: FULL_STATUS_ENDPOINT,
      reason: "轻量状态接口不默认运行完整图小波；需要研究证据时读取详情接口。"
    },
    research: {
      deferred: true,
      detailEndpoint: RESEARCH_DETAIL_ENDPOINT,
      fullStatusEndpoint: FULL_STATUS_ENDPOINT
    }
  };
}

async function buildFullOperatorStatusPayload(baseSnapshot?: AgentConsoleBaseSnapshot) {
  const snapshot = await getAgentConsoleSnapshot(baseSnapshot);
  return {
    ...buildBasePayload(snapshot, "full", snapshot.pipelineSteps),
    algorithms: buildFullAlgorithms(snapshot)
  };
}

function withFullCacheMetadata(payload: FullOperatorStatusPayload, input: { hit: boolean; expiresAt: number; servedAt: number; signature: string }) {
  return {
    ...payload,
    servedAt: new Date(input.servedAt).toISOString(),
    cache: {
      hit: input.hit,
      ttlSeconds: Math.round(FULL_STATUS_CACHE_TTL_MS / 1000),
      expiresAt: new Date(input.expiresAt).toISOString(),
      bypassQuery: "fresh=true",
      signature: input.signature
    }
  };
}

async function getCachedFullOperatorStatusPayload(options: { fresh?: boolean } = {}) {
  const now = Date.now();
  const baseSnapshot = await getAgentConsoleBaseSnapshot();
  const signature = buildFullCacheSignature(baseSnapshot);
  const cachedFullOperatorStatus = readFullOperatorStatusCache();
  if (!options.fresh && cachedFullOperatorStatus && cachedFullOperatorStatus.expiresAt > now && cachedFullOperatorStatus.signature === signature) {
    return withFullCacheMetadata(cachedFullOperatorStatus.payload, {
      hit: true,
      expiresAt: cachedFullOperatorStatus.expiresAt,
      servedAt: now,
      signature
    });
  }

  const payload = await buildFullOperatorStatusPayload(baseSnapshot);
  const refreshedAt = Date.now();
  const expiresAt = refreshedAt + FULL_STATUS_CACHE_TTL_MS;
  writeFullOperatorStatusCache({ expiresAt, payload, signature });
  return withFullCacheMetadata(payload, { hit: false, expiresAt, servedAt: refreshedAt, signature });
}

export async function getOperatorStatusPayload(options: { detail?: OperatorStatusDetail; fresh?: boolean } = {}) {
  if (options.detail === "full") return getCachedFullOperatorStatusPayload({ fresh: options.fresh });

  const snapshot = await getAgentConsoleSummarySnapshot();
  return {
    ...buildBasePayload(snapshot, "summary", buildOperatorPipelineSteps({
      postCount: snapshot.counts.postCount,
      agentRunCount: snapshot.counts.agentRunCount,
      llmStatus: snapshot.llmStatus,
      realPublishEnabled: snapshot.settings.realPublishEnabled
    })),
    algorithms: buildSummaryAlgorithms(snapshot)
  };
}

export async function getOperatorResearchDigestPayload(options: { fresh?: boolean } = {}) {
  const [fullPayload, latestSocialNetworkSync] = await Promise.all([
    getCachedFullOperatorStatusPayload({ fresh: options.fresh }),
    getLatestSocialNetworkSync()
  ]);
  const graphWavelet = fullPayload.algorithms.graphWavelet;
  const research = fullPayload.algorithms.research;
  const readiness = evaluateResearchReadiness({
    graphWaveletState: graphWavelet.state,
    graphNodeCount: graphWavelet.nodeCount,
    graphEdgeCount: graphWavelet.edgeCount,
    participationAnalysisReady: research.quasiExperiment.participationAnalysisReady,
    machineAgreementKappa: research.codingReliability.machineAgreementKappa,
    humanReviewRecommendedCount: research.codingReliability.humanReviewRecommendedCount,
    validityNoteCount: research.quasiExperiment.validityNotes.length
  });

  return {
    app: fullPayload.app,
    detail: "research_digest",
    generatedAt: fullPayload.generatedAt,
    servedAt: fullPayload.servedAt,
    cache: fullPayload.cache,
    researchDetailEndpoint: RESEARCH_DETAIL_ENDPOINT,
    researchDigestEndpoint: RESEARCH_DIGEST_ENDPOINT,
    fullStatusEndpoint: FULL_STATUS_ENDPOINT,
    readiness,
    algorithms: {
      temporalWavelet: fullPayload.algorithms.temporalWavelet,
      graphWavelet: {
        state: graphWavelet.state,
        stateLabel: graphWavelet.stateLabel,
        nodeCount: graphWavelet.nodeCount,
        edgeCount: graphWavelet.edgeCount,
        highFrequencyEnergyRatio: graphWavelet.highFrequencyEnergyRatio,
        roughnessRatio: graphWavelet.roughnessRatio,
        pprMassConcentration: graphWavelet.pprMassConcentration,
        topNodes: graphWavelet.topNodes.slice(0, 3)
      },
      research: {
        socialNetwork: {
          edgeModel: latestSocialNetworkSync?.edgeModel ?? research.socialNetwork.edgeModel,
          scope: latestSocialNetworkSync?.scope ?? { type: "all_local_forum_data" },
          edgeCount: latestSocialNetworkSync?.edgeCount ?? research.socialNetwork.edgeCount,
          rawReplyEdgeCount: latestSocialNetworkSync?.rawReplyEdgeCount ?? research.socialNetwork.rawReplyEdgeCount,
          postReplyEdgeCount: latestSocialNetworkSync?.postReplyEdgeCount ?? research.socialNetwork.postReplyEdgeCount,
          nestedReplyEdgeCount: latestSocialNetworkSync?.nestedReplyEdgeCount ?? research.socialNetwork.nestedReplyEdgeCount,
          density: latestSocialNetworkSync?.density ?? research.socialNetwork.density,
          reciprocity: latestSocialNetworkSync?.reciprocity ?? research.socialNetwork.reciprocity,
          averageClustering: latestSocialNetworkSync?.averageClustering ?? research.socialNetwork.averageClustering,
          latestSyncUpdatedUserCount: latestSocialNetworkSync?.updatedUserCount ?? null
        },
        codingReliability: research.codingReliability,
        quasiExperiment: research.quasiExperiment
      }
    }
  };
}
