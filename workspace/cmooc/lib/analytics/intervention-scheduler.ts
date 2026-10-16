import { round } from "./statistics";

export type SchedulerCandidate = {
  id: string;
  baseScore: number;
  authorId: string;
  authorCentrality: number;
  commentCount: number;
  riskLevel: string;
  targetMode: string;
  interventionType: string;
  cieLevel: number;
  cieConfidence: number;
  urgencyScore: number;
  confusionScore: number;
  knowledgePhase: string;
  isValuable?: boolean;
  needsHumanReview?: boolean;
};

export type SchedulingEvidence = {
  baseScore: number;
  cognitiveNeed: number;
  urgencyNeed: number;
  equityNeed: number;
  coveragePenalty: number;
  diversityPenalty: number;
  safetyPenalty: number;
  recentTouches: number;
  selectedAuthorTouches: number;
  fairPriority: number;
  rationale: string[];
};

export type RankedInterventionCandidate<T> = {
  item: T;
  candidate: SchedulerCandidate;
  fairPriority: number;
  schedulingEvidence: SchedulingEvidence;
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function phaseWeight(phase: string): number {
  if (/意义协商|综合检验/.test(phase)) return 8;
  if (/应用迁移/.test(phase)) return 6;
  if (/分享比较/.test(phase)) return 4;
  return 1;
}

export function scoreSchedulingCandidate(candidate: SchedulerCandidate, context: {
  recentTouches: number;
  selectedAuthorTouches: number;
  selectedTypeCount: number;
  selectedCount: number;
}): SchedulingEvidence {
  const cognitiveNeed = clamp(candidate.cieLevel * 1.6 + phaseWeight(candidate.knowledgePhase) + candidate.cieConfidence * 8, 0, 24);
  const urgencyNeed = clamp(candidate.urgencyScore * 0.14 + candidate.confusionScore * 0.1 + (candidate.commentCount <= 1 ? 5 : 0), 0, 24);
  const equityNeed = clamp((1 - clamp(candidate.authorCentrality, 0, 1)) * 18 + (candidate.commentCount <= 1 ? 5 : 0), 0, 24);
  const coveragePenalty = Math.min(30, context.recentTouches * 7 + context.selectedAuthorTouches * 14);
  const selectedTypeShare = context.selectedCount === 0 ? 0 : context.selectedTypeCount / context.selectedCount;
  const diversityPenalty = selectedTypeShare > 0.55 ? 8 + selectedTypeShare * 8 : 0;
  const safetyPenalty = candidate.riskLevel === "high" ? 80 : candidate.riskLevel === "medium" ? 4 : 0;
  const fairPriority = round(clamp(candidate.baseScore + cognitiveNeed + urgencyNeed + equityNeed - coveragePenalty - diversityPenalty - safetyPenalty, 0, 120), 2);
  const rationale = [
    `基础分 ${Math.round(candidate.baseScore)}`,
    cognitiveNeed >= 10 ? `认知推进 +${round(cognitiveNeed, 1)}` : "",
    urgencyNeed >= 8 ? `紧急/困惑 +${round(urgencyNeed, 1)}` : "",
    equityNeed >= 8 ? `边缘学习者 +${round(equityNeed, 1)}` : "",
    coveragePenalty > 0 ? `近期触达 -${round(coveragePenalty, 1)}` : "",
    diversityPenalty > 0 ? `类型多样性 -${round(diversityPenalty, 1)}` : "",
    safetyPenalty > 0 ? `安全风险 -${round(safetyPenalty, 1)}` : ""
  ].filter(Boolean);

  return {
    baseScore: round(candidate.baseScore, 2),
    cognitiveNeed: round(cognitiveNeed, 2),
    urgencyNeed: round(urgencyNeed, 2),
    equityNeed: round(equityNeed, 2),
    coveragePenalty: round(coveragePenalty, 2),
    diversityPenalty: round(diversityPenalty, 2),
    safetyPenalty: round(safetyPenalty, 2),
    recentTouches: context.recentTouches,
    selectedAuthorTouches: context.selectedAuthorTouches,
    fairPriority,
    rationale
  };
}

export function selectFairInterventionCandidates<T>(
  items: T[],
  toCandidate: (item: T) => SchedulerCandidate,
  options: {
    maxCount: number;
    minScore: number;
    recentTouchesByAuthor?: Map<string, number>;
  }
): Array<RankedInterventionCandidate<T>> {
  const candidates = items
    .map((item) => ({ item, candidate: toCandidate(item) }))
    .filter(({ candidate }) =>
      candidate.isValuable !== false &&
      candidate.needsHumanReview !== true &&
      candidate.baseScore >= options.minScore &&
      candidate.riskLevel !== "high" &&
      candidate.targetMode !== "skip"
    );
  const selected: Array<RankedInterventionCandidate<T>> = [];
  const remaining = [...candidates];
  const selectedByAuthor = new Map<string, number>();
  const selectedByType = new Map<string, number>();

  while (remaining.length && selected.length < options.maxCount) {
    const ranked = remaining
      .map((entry) => {
        const recentTouches = options.recentTouchesByAuthor?.get(entry.candidate.authorId) || 0;
        const selectedAuthorTouches = selectedByAuthor.get(entry.candidate.authorId) || 0;
        const selectedTypeCount = selectedByType.get(entry.candidate.interventionType) || 0;
        const schedulingEvidence = scoreSchedulingCandidate(entry.candidate, {
          recentTouches,
          selectedAuthorTouches,
          selectedTypeCount,
          selectedCount: selected.length
        });
        return {
          ...entry,
          fairPriority: schedulingEvidence.fairPriority,
          schedulingEvidence
        };
      })
      .sort((a, b) => b.fairPriority - a.fairPriority || b.candidate.baseScore - a.candidate.baseScore);
    const next = ranked[0];
    selected.push(next);
    selectedByAuthor.set(next.candidate.authorId, (selectedByAuthor.get(next.candidate.authorId) || 0) + 1);
    selectedByType.set(next.candidate.interventionType, (selectedByType.get(next.candidate.interventionType) || 0) + 1);
    const index = remaining.findIndex((entry) => entry.candidate.id === next.candidate.id);
    if (index >= 0) remaining.splice(index, 1);
  }

  return selected;
}
