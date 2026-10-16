import { prisma } from "@/lib/db";
import { recordAgentRun } from "./agent-run";
import { buildCommunityActivitySeries, waveletActivityMonitor } from "./research-algorithms";

export type MonitorFinding = {
  postId: string;
  forumPostId: string;
  title: string;
  findingType: "new_post" | "unanswered_high_value" | "low_level_dense" | "isolated_learner";
  reason: string;
};

function hoursSince(date: Date): number {
  return Math.round(((Date.now() - date.getTime()) / 3_600_000) * 10) / 10;
}

export async function scanForumPosts(): Promise<MonitorFinding[]> {
  const startedAt = new Date();
  const posts = await prisma.forumPost.findMany({
    include: { author: true, replies: true, analysis: true },
    orderBy: { createdAt: "desc" }
  });
  const findings: MonitorFinding[] = [];

  for (const post of posts) {
    if (!post.analysis) {
      findings.push({
        postId: post.id,
        forumPostId: post.forumPostId,
        title: post.title,
        findingType: "new_post",
        reason: "尚未生成 InteractionAnalysis"
      });
    }
    if (post.replyCount === 0 && hoursSince(post.createdAt) > 12 && /如何|怎么看|是否|为什么|边界/.test(post.title + post.content)) {
      findings.push({
        postId: post.id,
        forumPostId: post.forumPostId,
        title: post.title,
        findingType: "unanswered_high_value",
        reason: "开放性学习问题超过 12 小时无人回应"
      });
    }
    const lowReplies = post.replies.filter((reply) => /赞同|有道理|学习了|同感|谢谢/.test(reply.content)).length;
    if (lowReplies >= 4) {
      findings.push({
        postId: post.id,
        forumPostId: post.forumPostId,
        title: post.title,
        findingType: "low_level_dense",
        reason: "低层互动较密集，但缺少解释澄清或反思"
      });
    }
    if (post.author.centralityScore < 0.35 && post.replyCount <= 1) {
      findings.push({
        postId: post.id,
        forumPostId: post.forumPostId,
        title: post.title,
        findingType: "isolated_learner",
        reason: "作者中心性低且帖子回应少"
      });
    }
  }

  const activitySeries = buildCommunityActivitySeries(posts);
  const wavelet = waveletActivityMonitor(activitySeries);
  if (wavelet.state === "declining") {
    const latestPost = posts[0];
    if (latestPost) {
      findings.push({
        postId: latestPost.id,
        forumPostId: latestPost.forumPostId,
        title: latestPost.title,
        findingType: "new_post",
        reason: `社区活跃度小波监测为 declining，建议选择近期帖子进行逆周期激活；趋势 ${wavelet.trend}`
      });
    }
  }

  await recordAgentRun({
    agentName: "global-monitor",
    input: { source: "forum-database", postCount: posts.length },
    output: {
      findings,
      researchAlgorithm: {
        activitySeries,
        wavelet
      }
    },
    startedAt
  });
  return findings;
}
