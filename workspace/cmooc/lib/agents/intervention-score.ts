import { recordAgentRun } from "./agent-run";

type ScoreInput = {
  postId: string;
  taskId?: string;
  cieLevel: number;
  unansweredHours: number;
  emotionLabel: string;
  topicRelevance: number;
  discussionPotential: number;
  isolatedLearnerScore: number;
};

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export async function calculateInterventionScore(input: ScoreInput): Promise<{ priorityScore: number; reason: string }> {
  const startedAt = new Date();
  const cieScore = clamp((input.cieLevel / 8) * 100);
  const unansweredScore = clamp(Math.min(input.unansweredHours, 48) * 2.1);
  const emotionNeedScore = /困惑|挫败|焦虑/.test(input.emotionLabel) ? 92 : /积极但浅层/.test(input.emotionLabel) ? 52 : 28;
  const priorityScore = clamp(
    cieScore * 0.25 +
      unansweredScore * 0.2 +
      emotionNeedScore * 0.2 +
      input.topicRelevance * 0.15 +
      input.discussionPotential * 0.15 +
      input.isolatedLearnerScore * 0.05
  );
  const output = {
    priorityScore,
    reason: `CIE=${input.cieLevel}，无人回应=${input.unansweredHours}小时，情绪需求=${emotionNeedScore}，综合得分=${priorityScore}`
  };
  await recordAgentRun({
    taskId: input.taskId,
    postId: input.postId,
    agentName: "intervention-score",
    input,
    output,
    startedAt
  });
  return output;
}
