import { prisma } from "@/lib/db";
import { cieLabels } from "@/lib/labels";
import type { CieClassification } from "@/lib/types";
import { recordAgentRun } from "./agent-run";
import { classifyCieText } from "./research-algorithms";

export async function classifyCieLevel(postId: string, taskId?: string): Promise<CieClassification> {
  const startedAt = new Date();
  const post = await prisma.forumPost.findUniqueOrThrow({
    where: { id: postId },
    include: { replies: true }
  });
  const combinedText = `${post.title}\n${post.content}\n${post.replies.map((reply) => reply.content).join("\n")}`;
  const matched = classifyCieText(combinedText);
  const lowLevelReplies = post.replies.filter((reply) => /赞同|有道理|学习了|同感|顶/.test(reply.content)).length;
  const output =
    lowLevelReplies >= 4
      ? { cieLevel: 2, cieLabel: cieLabels[2], reason: "低层回应密集，但缺少解释、争论或反思" }
      : {
          cieLevel: matched.cieLevel,
          cieLabel: matched.cieLabel,
          reason: `${matched.reason}${matched.matchedWords.length ? `；命中：${matched.matchedWords.join("、")}` : ""}`
        };

  await recordAgentRun({
    taskId,
    postId,
    agentName: "cie-classifier",
    input: { title: post.title, content: post.content, replyCount: post.replyCount },
    output,
    startedAt
  });
  return output;
}
