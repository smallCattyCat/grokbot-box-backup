import { prisma } from "@/lib/db";
import type { InteractionSignal, SchedulerDecision } from "@/lib/types";
import { recordAgentRun } from "./agent-run";

type SchedulerInput = {
  postId: string;
  taskId?: string;
  cieLevel: number;
  analysis: InteractionSignal;
};

function findHighQualityCommentIndex(replies: Array<{ content: string; isCompanionReply: boolean }>): number | undefined {
  const index = replies.findIndex((reply) => {
    if (reply.isCompanionReply) {
      return false;
    }
    const content = reply.content.trim();
    const hasReasoningSignal = /为什么|证据|反例|比较|我觉得|是否|边界|标准|指标|因为|但是/.test(content);
    return content.length >= 24 && hasReasoningSignal;
  });
  return index >= 0 ? index : undefined;
}

export async function chooseCompanionType(input: SchedulerInput): Promise<SchedulerDecision> {
  const startedAt = new Date();
  const post = await prisma.forumPost.findUniqueOrThrow({
    where: { id: input.postId },
    include: { replies: { orderBy: { createdAt: "asc" } } }
  });
  const text = `${post.title}\n${post.content}`;
  let baseDecision: Pick<SchedulerDecision, "interventionType" | "reason">;

  if (input.analysis.isolatedLearnerScore >= 72 && post.replyCount <= 1) {
    baseDecision = { interventionType: "mixed", reason: "学习者连接弱且回应少，需要先承接情绪，再补充连接线索" };
  } else if (/困惑|挫败|焦虑/.test(input.analysis.emotionLabel)) {
    baseDecision = { interventionType: "emotional_support", reason: "帖子出现跟不上、整理困难等情绪线索" };
  } else if (input.analysis.resourceNeed || /资料|资源|案例|文献|相关帖子/.test(text)) {
    baseDecision = { interventionType: "resource_connector", reason: "学习者明确提出资料、案例、文献或相关帖子需求" };
  } else if (input.analysis.lowLevelDense) {
    baseDecision = { interventionType: "cognitive_conflict", reason: "低层互动密集但缺少解释澄清，需要比较性追问" };
  } else if (input.cieLevel >= 4 && input.analysis.unansweredHours > 12) {
    baseDecision = { interventionType: "cognitive_conflict", reason: "高价值劣构问题长时间未被承接" };
  } else {
    baseDecision = { interventionType: "cognitive_conflict", reason: "具备继续讨论潜力，适合温和追问推动高阶互动" };
  }

  const highQualityCommentIndex = findHighQualityCommentIndex(post.replies);
  const originalPostShowsConfusion = /跟不上|不知道|挫败|焦虑|迷茫|有点难|不会整理/.test(text);
  let output: SchedulerDecision;
  if (baseDecision.interventionType === "resource_connector") {
    output = {
      ...baseDecision,
      publishTarget: "post_comment",
      reason: `${baseDecision.reason}；资源连接默认回应原帖整体需求`
    };
  } else if (baseDecision.interventionType === "emotional_support" && originalPostShowsConfusion) {
    output = {
      ...baseDecision,
      publishTarget: "post_comment",
      reason: `${baseDecision.reason}；原帖作者表达困惑，优先在主评论中直接承接`
    };
  } else if (baseDecision.interventionType === "cognitive_conflict" && highQualityCommentIndex !== undefined) {
    output = {
      ...baseDecision,
      publishTarget: "comment_reply",
      targetCommentStrategy: "first",
      targetCommentIndex: highQualityCommentIndex,
      reason: `${baseDecision.reason}；检测到高质量评论，优先承接该评论继续追问`
    };
  } else {
    output = {
      ...baseDecision,
      publishTarget: "post_comment",
      reason: `${baseDecision.reason}；当前干预目标主要回应原帖整体问题`
    };
  }

  await recordAgentRun({
    taskId: input.taskId,
    postId: input.postId,
    agentName: "scheduler-agent",
    input,
    output,
    startedAt
  });
  return output;
}
