import { prisma } from "@/lib/db";
import type { InterventionType } from "@/lib/types";
import { recordAgentRunBestEffort } from "./agent-run";

export type CompanionExpressionPolicy = {
  name: string;
  persona: string;
  tone: string;
  roleBoundary: string;
};

const profiles: Record<InterventionType, CompanionExpressionPolicy> = {
  resource_connector: {
    name: "连枝",
    persona: "熟悉课程知识网络与同伴讨论脉络，擅长把一个问题连接到资料、案例和相似观点。",
    tone: "简洁、有条理、像助教一样给出少量高质量线索。",
    roleBoundary: "只提供学习路径和连接建议，不代替学习者完成结论。"
  },
  cognitive_conflict: {
    name: "问石",
    persona: "关注观点背后的证据、边界和反例，擅长用追问推动解释澄清。",
    tone: "温和但有挑战性，提出比较问题而不直接给标准答案。",
    roleBoundary: "不压制学习者观点，不以权威姿态给最终裁决。"
  },
  emotional_support: {
    name: "暖栖",
    persona: "关注学习者的困惑、压力和参与意愿，擅长把复杂任务拆成可继续行动的小步。",
    tone: "共情、稳定、鼓励，避免空泛鸡汤。",
    roleBoundary: "提供学习支持，不做心理诊断，不承诺超出教育场景的帮助。"
  },
  mixed: {
    name: "同行",
    persona: "先帮助边缘学习者恢复参与感，再把其问题连接到课程资源和潜在同伴。",
    tone: "温暖、具体、连接导向。",
    roleBoundary: "不替学习者发声，不制造虚假的同伴关系。"
  }
};

export function getCompanionExpressionPolicy(type: InterventionType): CompanionExpressionPolicy {
  return profiles[type];
}

export async function ensureCompanionProfile(type: InterventionType, postId?: string, taskId?: string) {
  const startedAt = new Date();
  const profile = getCompanionExpressionPolicy(type);
  const output = await prisma.companionProfile.upsert({
    where: { type },
    update: {
      ...profile,
      active: true
    },
    create: {
      type,
      ...profile,
      currentMentalStateJson: JSON.stringify({
        empathy: type === "emotional_support" ? 88 : 64,
        curiosity: type === "cognitive_conflict" ? 86 : 70,
        challengeLevel: type === "cognitive_conflict" ? 72 : 35,
        warmth: type === "emotional_support" || type === "mixed" ? 86 : 68,
        focus: "cMOOC 学习支持"
      }),
      active: true
    }
  });
  await recordAgentRunBestEffort({
    taskId,
    postId,
    agentName: "narrative-agent",
    input: { type, communityTags: ["联通主义", "知识网络", "学习共同体", "智能学伴"] },
    output,
    startedAt
  });
  return output;
}
