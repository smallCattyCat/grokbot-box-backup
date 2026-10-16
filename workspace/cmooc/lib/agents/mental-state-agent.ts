import type { InterventionType, MentalState } from "@/lib/types";
import { recordAgentRun } from "./agent-run";
import { simulateResearchMentalState } from "./research-algorithms";

const defaults: Record<InterventionType, MentalState> = {
  resource_connector: { empathy: 62, curiosity: 76, challengeLevel: 34, warmth: 68, focus: "连接资源与同伴" },
  cognitive_conflict: { empathy: 58, curiosity: 88, challengeLevel: 72, warmth: 60, focus: "提出澄清与比较问题" },
  emotional_support: { empathy: 90, curiosity: 54, challengeLevel: 28, warmth: 88, focus: "稳定情绪并拆解任务" },
  mixed: { empathy: 86, curiosity: 68, challengeLevel: 36, warmth: 84, focus: "情绪承接与资源连接" }
};

export async function deriveAgentRegulationState(input: {
  postId: string;
  taskId?: string;
  interventionType: InterventionType;
  emotionLabel: string;
  cieLevel?: number;
  communityMood?: string;
}): Promise<MentalState> {
  const startedAt = new Date();
  const baseline = defaults[input.interventionType];
  const output = simulateResearchMentalState({
    previous: baseline,
    interventionType: input.interventionType,
    emotionLabel: input.emotionLabel,
    cieLevel: input.cieLevel
  });
  await recordAgentRun({
    taskId: input.taskId,
    postId: input.postId,
    agentName: "mental-state-agent",
    input: {
      ...input,
      baseline,
      stateScope: "task_local_expression_control",
      persistentCompanionStateRead: false
    },
    output: {
      regulationState: output,
      learnerPsychologicalDiagnosis: false,
      persistentCompanionStateWritten: false
    },
    startedAt
  });
  return output;
}
