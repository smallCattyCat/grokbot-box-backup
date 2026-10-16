import { prisma } from "@/lib/db";
import type { ExtractedPostDetail } from "@/lib/forum/extract-post-detail";

export type RelatedResource = {
  postId: string;
  title: string;
  url: string;
  score: number;
  matchedTerms: string[];
  reason: string;
};

const stopWords = new Set(["这个", "一个", "我们", "大家", "是否", "如何", "为什么", "可以", "什么", "需要", "进行", "学习"]);

function tokenize(text: string): string[] {
  const clean = text.toLowerCase().replace(/\s+/g, "");
  const words = Array.from(clean.matchAll(/[a-z0-9]{2,}|[\u4e00-\u9fa5]{2,}/g)).flatMap((match) => {
    const value = match[0];
    if (/^[a-z0-9]+$/.test(value)) return [value];
    const tokens: string[] = [];
    for (let index = 0; index < value.length - 1; index += 1) {
      tokens.push(value.slice(index, index + 2));
    }
    return tokens;
  });
  return words.filter((word) => !stopWords.has(word));
}

function weightedJaccard(left: string[], right: string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = [...leftSet].filter((item) => rightSet.has(item));
  const union = new Set([...leftSet, ...rightSet]);
  return {
    score: union.size === 0 ? 0 : intersection.length / union.size,
    matchedTerms: intersection.slice(0, 8)
  };
}

export async function recommendRelatedResources(post: ExtractedPostDetail, options: { limit?: number } = {}): Promise<RelatedResource[]> {
  const limit = options.limit ?? 3;
  const sourceText = [post.title, post.content, ...post.tags, ...post.comments.map((comment) => comment.content)].join("\n");
  const sourceTokens = tokenize(sourceText);
  if (sourceTokens.length === 0) return [];

  const existingPosts = await prisma.forumPost.findMany({
    where: { url: { not: post.url } },
    include: { replies: true, analysis: true },
    take: 120,
    orderBy: { updatedAt: "desc" }
  });

  return existingPosts
    .map((candidate) => {
      const candidateText = [candidate.title, candidate.content, ...candidate.replies.map((reply) => reply.content)].join("\n");
      const similarity = weightedJaccard(sourceTokens, tokenize(candidateText));
      const qualityBoost = Math.min(0.12, (candidate.analysis?.cieLevel || 0) * 0.012 + candidate.replyCount * 0.006);
      const score = similarity.score + qualityBoost;
      return {
        postId: candidate.id,
        title: candidate.title,
        url: candidate.url,
        score: Number(score.toFixed(3)),
        matchedTerms: similarity.matchedTerms,
        reason: `相似词 ${similarity.matchedTerms.join("、") || "较少"}；CIE ${candidate.analysis?.cieLevel ?? "-"}；回复 ${candidate.replyCount}`
      };
    })
    .filter((item) => item.score >= 0.06)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
