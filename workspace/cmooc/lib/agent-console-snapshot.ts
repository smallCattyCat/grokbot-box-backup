import { buildResearchEvaluationSnapshot } from "@/lib/analytics/research-evaluation";
import { getAutoInterventionSchedulerStatus } from "@/lib/auto-intervention/scheduler";
import { prisma } from "@/lib/db";
import { getLlmRuntimeStatus } from "@/lib/llm/client";
import { getForumSettings } from "@/lib/settings";
import { buildOperatorPipelineSteps, parseWaveletOutput } from "@/lib/agent-console-pipeline";

export async function getAgentConsoleBaseSnapshot() {
  const [settings, llmStatus, scheduler, latestRun, topCandidate, latestWaveRun, counts] = await Promise.all([
    getForumSettings(),
    Promise.resolve(getLlmRuntimeStatus()),
    Promise.resolve(getAutoInterventionSchedulerStatus()),
    prisma.autoInterventionRun.findFirst({
      include: { candidates: { orderBy: { interventionScore: "desc" }, take: 3 } },
      orderBy: { createdAt: "desc" }
    }),
    prisma.autoInterventionCandidate.findFirst({ orderBy: [{ interventionScore: "desc" }, { updatedAt: "desc" }] }),
    prisma.agentRun.findFirst({ where: { agentName: "global-monitor" }, orderBy: { startedAt: "desc" } }),
    Promise.all([
      prisma.forumPost.count(),
      prisma.autoInterventionCandidate.count(),
      prisma.autoInterventionCandidate.count({ where: { status: "published" } }),
      prisma.agentRun.count()
    ])
  ]);
  const [postCount, candidateCount, publishedCount, agentRunCount] = counts;
  const waveOutput = parseWaveletOutput(latestWaveRun?.outputJson || null);
  const wavelet = waveOutput?.researchAlgorithm?.wavelet;

  return {
    settings,
    llmStatus,
    scheduler,
    latestRun,
    topCandidate,
    latestWaveRun,
    counts: { postCount, candidateCount, publishedCount, agentRunCount },
    wavelet
  };
}

export type AgentConsoleBaseSnapshot = Awaited<ReturnType<typeof getAgentConsoleBaseSnapshot>>;

export async function getAgentConsoleSummarySnapshot() {
  return getAgentConsoleBaseSnapshot();
}

export async function getAgentConsoleSnapshot(baseSnapshotInput?: AgentConsoleBaseSnapshot) {
  const [baseSnapshot, researchSnapshot] = await Promise.all([
    baseSnapshotInput ? Promise.resolve(baseSnapshotInput) : getAgentConsoleBaseSnapshot(),
    buildResearchEvaluationSnapshot()
  ]);
  const graphWavelet = researchSnapshot.socialNetwork.graphWavelet;
  const pipelineSteps = buildOperatorPipelineSteps({
    postCount: baseSnapshot.counts.postCount,
    agentRunCount: baseSnapshot.counts.agentRunCount,
    llmStatus: baseSnapshot.llmStatus,
    graphWavelet,
    realPublishEnabled: baseSnapshot.settings.realPublishEnabled
  });

  return {
    ...baseSnapshot,
    researchSnapshot,
    graphWavelet,
    pipelineSteps
  };
}
