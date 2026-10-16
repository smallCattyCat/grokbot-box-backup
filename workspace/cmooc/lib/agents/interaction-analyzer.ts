import { prisma } from "@/lib/db";
import type { InteractionSignal } from "@/lib/types";
import { recordAgentRun } from "./agent-run";
import { analyzeResearchInteraction } from "./research-algorithms";

export async function analyzeInteraction(postId: string, taskId?: string): Promise<InteractionSignal> {
  const startedAt = new Date();
  const post = await prisma.forumPost.findUniqueOrThrow({
    where: { id: postId },
    include: { author: true, replies: true }
  });
  const researchOutput = analyzeResearchInteraction(post);
  const { researchEvidence: _researchEvidence, ...output } = researchOutput;

  await recordAgentRun({
    taskId,
    postId,
    agentName: "interaction-analyzer",
    input: { title: post.title, content: post.content, replyCount: post.replyCount, likeCount: post.likeCount, centralityScore: post.author.centralityScore },
    output: researchOutput,
    startedAt
  });
  return output as InteractionSignal;
}
