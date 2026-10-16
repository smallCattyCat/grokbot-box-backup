import { prisma } from "@/lib/db";
import { scanRealForum } from "@/lib/forum/scan-real-forum";
import { extractPostDetail, type ExtractedPostDetail } from "@/lib/forum/extract-post-detail";
import { detectInterventionValue, type ValueAnalysis } from "@/lib/agents/value-detector-agent";
import { recordAgentRun } from "@/lib/agents/agent-run";
import { getLlmRuntimeStatus } from "@/lib/llm/client";
import { assertAllowedForumUrl } from "@/lib/forum/allowed-url";
import { anonymizeLearnerName } from "@/lib/privacy";
import { redactPii } from "@/lib/security/safety-gateway";
import { selectFairInterventionCandidates, type SchedulingEvidence } from "@/lib/analytics/intervention-scheduler";
import { upsertCourseFromSource } from "@/lib/forum/course-scope";
import {
  prepareInterventionPlan,
  promoteAutoCandidateToInterventionTask,
  transitionInterventionTask
} from "@/lib/interventions/intervention-service";
import { normalizeTaskStatus } from "@/lib/state-machine";

export type AutoInterventionMode = "dry_run" | "real_publish";

export type AutoInterventionRunResult = {
  runId: string;
  scannedCount: number;
  extractedCount: number;
  candidateCount: number;
  dryRunReadyCount: number;
  publishedCount: number;
  skippedCount: number;
  failedCount: number;
};

type ExtractedItem = {
  post: ExtractedPostDetail;
  postId: string;
  analysis: ValueAnalysis;
  candidateId: string;
  authorId: string;
  authorName: string;
  authorCentrality: number;
};

type RankedExtractedItem = ExtractedItem & {
  fairPriority: number;
  authorRecentTouches: number;
  schedulingEvidence: SchedulingEvidence;
};

function clampMaxPublishCount(_mode: AutoInterventionMode, value: number): number {
  return Math.max(0, Math.floor(value));
}

function includesMarker(post: ExtractedPostDetail): boolean {
  return `${post.title} ${post.content} ${post.comments.map((comment) => comment.content).join(" ")}`.includes("智能学伴自动干预");
}

function similarity(a: string, b: string): number {
  const left = new Set(a.replace(/\s+/g, "").split(""));
  const right = new Set(b.replace(/\s+/g, "").split(""));
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap += 1;
  return overlap / Math.max(left.size, right.size);
}

async function hasRecentSystemReply(postUrl: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [candidateCount, taskCount] = await Promise.all([
    prisma.autoInterventionCandidate.count({
      where: {
        postUrl,
        status: "published",
        updatedAt: { gte: since }
      }
    }),
    prisma.interventionTask.count({
      where: {
        post: { url: postUrl },
        status: "published",
        publishedAt: { gte: since }
      }
    })
  ]);
  return candidateCount > 0 || taskCount > 0;
}

async function hasOpenIntervention(postId: string): Promise<boolean> {
  const [taskCount, unpromotedCandidateCount] = await Promise.all([
    prisma.interventionTask.count({
      where: {
        postId,
        status: {
          in: [
            "proposed",
            "review_required",
            "ready",
            "publishing",
            "failed_retryable",
            "reconcile_required",
            "discovered",
            "analyzed",
            "candidate",
            "drafted",
            "safety_checked",
            "queued",
            "failed",
            "manual_review"
          ]
        }
      }
    }),
    prisma.autoInterventionCandidate.count({
      where: {
        postId,
        status: { in: ["planned", "manual_review"] },
        task: { is: null }
      }
    })
  ]);
  return taskCount > 0 || unpromotedCandidateCount > 0;
}

async function hasSimilarHistoricalReply(postId: string, content: string): Promise<boolean> {
  const replies = await prisma.forumReply.findMany({
    where: { postId, isCompanionReply: true },
    orderBy: { createdAt: "desc" },
    take: 10
  });
  return replies.some((reply) => similarity(reply.content, content) > 0.82);
}

function emptyAnalysis(reason: string): ValueAnalysis {
  return {
    isValuable: false,
    interventionScore: 0,
    cieLevel: 0,
    cieLabel: "skip",
    emotionLabel: "unknown",
    topicType: "other",
    interventionType: "none",
    targetMode: "skip",
    targetCommentIndex: null,
    targetReason: reason,
    replyStrategy: "skip",
    riskLevel: "high",
    reason,
    urgencyScore: 0,
    confusionScore: 0,
    isQuestion: false,
    cieConfidence: 0,
    knowledgePhase: "skip",
    iamPhase: 1,
    needsHumanReview: false,
    secondaryLabels: []
  };
}

function redactExtractedPost(post: ExtractedPostDetail): ExtractedPostDetail {
  return {
    ...post,
    authorName: anonymizeLearnerName(post.authorName),
    content: redactPii(post.content),
    comments: post.comments.map((comment) => ({
      ...comment,
      authorName: anonymizeLearnerName(comment.authorName),
      content: redactPii(comment.content)
    }))
  };
}

function initialCandidateStatus(analysis: ValueAnalysis): string {
  if (analysis.targetMode === "skip") return "skipped";
  if (!analysis.isValuable) return "skipped";
  if (analysis.needsHumanReview || analysis.riskLevel === "high") return "manual_review";
  return "analyzed";
}

export async function runAutoIntervention(input: {
  forumListUrl: string;
  maxScanPosts: number;
  maxPublishCount: number;
  minScoreToPublish: number;
  mode: AutoInterventionMode;
  allowRealPublish: boolean;
  courseId?: string;
  platformCourseId?: string;
}): Promise<AutoInterventionRunResult> {
  const forumListUrl = assertAllowedForumUrl(
    input.forumListUrl,
    "自动干预论坛地址"
  );
  const maxPublishCount = clampMaxPublishCount(input.mode, input.maxPublishCount);
  const course = await upsertCourseFromSource({
    courseId: input.courseId,
    platformCourseId: input.platformCourseId,
    sourceUrl: forumListUrl
  });
  const run = await prisma.autoInterventionRun.create({
    data: {
      courseId: course.id,
      forumListUrl,
      mode: input.mode,
      status: "running",
      maxScanPosts: input.maxScanPosts,
      maxPublishCount,
      minScoreToPublish: input.minScoreToPublish
    }
  });

  try {
    const scanned = await scanRealForum({ forumListUrl, maxPosts: input.maxScanPosts });
    const llmStatus = getLlmRuntimeStatus();
    console.log("[auto-intervention] scan result", {
      forumListUrl,
      scannedCount: scanned.length,
      llmMode: llmStatus.mode,
      llmProvider: llmStatus.provider,
      llmModel: llmStatus.model,
      hasLlmApiKey: llmStatus.hasApiKey
    });
    const extractedItems: ExtractedItem[] = [];

    for (const scannedPost of scanned) {
      let extracted: ExtractedPostDetail | null = null;
      let analysis: ValueAnalysis = emptyAnalysis("尚未分析。");
      try {
        extracted = await extractPostDetail({ postUrl: scannedPost.url });
        const dbPost = await prisma.forumPost.findFirstOrThrow({ where: { url: scannedPost.url }, include: { author: true } });
        await prisma.forumPost.update({ where: { id: dbPost.id }, data: { courseId: course.id } });
        await prisma.forumReply.updateMany({ where: { postId: dbPost.id }, data: { courseId: course.id } });
        const alreadyOpen = await hasOpenIntervention(dbPost.id);
        analysis = includesMarker(extracted)
          ? emptyAnalysis("帖子或评论已包含智能学伴回复标记，跳过。")
          : alreadyOpen
            ? emptyAnalysis("该帖子已有待审阅、发布中或待核对的干预计划，本轮不重复创建。")
            : await detectInterventionValue({ post: extracted });
        const candidate = await prisma.autoInterventionCandidate.create({
          data: {
            courseId: course.id,
            runId: run.id,
            postId: dbPost.id,
            postUrl: extracted.url,
            postTitle: extracted.title || scannedPost.titleCandidate || scannedPost.url,
            rawExtractJson: JSON.stringify(redactExtractedPost(extracted), null, 2),
            valueAnalysisJson: JSON.stringify(analysis, null, 2),
            interventionScore: analysis.interventionScore,
            cieLevel: analysis.cieLevel,
            emotionLabel: analysis.emotionLabel,
            topicType: analysis.topicType,
            interventionType: analysis.interventionType,
            targetMode: analysis.targetMode,
            targetCommentIndex: analysis.targetCommentIndex,
            targetReason: analysis.targetReason,
            replyStrategy: analysis.replyStrategy,
            riskLevel: analysis.riskLevel,
            reason: analysis.reason,
            status: initialCandidateStatus(analysis),
            errorMessage: !analysis.isValuable
              ? "价值判断为不适合自动干预。"
              : analysis.needsHumanReview
                ? "CIE/目标判断置信度不足，建议人工复核。"
                : analysis.riskLevel === "high"
                  ? analysis.reason
                  : null
          }
        });
        await recordAgentRun({
          courseId: course.id,
          postId: dbPost.id,
          agentName: "value-detector-agent",
          input: { post: extracted },
          output: analysis
        }).catch((error) => {
          console.warn(`[auto-intervention] 记录 value-detector-agent 运行失败：${error instanceof Error ? error.message : "unknown"}`);
        });
        if (!alreadyOpen && analysis.isValuable) {
          extractedItems.push({
            post: extracted,
            postId: dbPost.id,
            analysis,
            candidateId: candidate.id,
            authorId: dbPost.authorId,
            authorName: dbPost.author.name,
            authorCentrality: dbPost.author.centralityScore
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "未知抽取或分析错误";
        const post = await prisma.forumPost.findFirst({ where: { url: scannedPost.url } });
        if (post) {
          await prisma.autoInterventionCandidate.create({
            data: {
              courseId: course.id,
              runId: run.id,
              postId: post.id,
              postUrl: scannedPost.url,
              postTitle: scannedPost.titleCandidate || scannedPost.url,
              rawExtractJson: extracted ? JSON.stringify(redactExtractedPost(extracted), null, 2) : "{}",
              valueAnalysisJson: JSON.stringify(analysis, null, 2),
              interventionScore: 0,
              cieLevel: 0,
              emotionLabel: "unknown",
              topicType: "other",
              interventionType: "none",
              targetMode: "skip",
              targetCommentIndex: null,
              targetReason: message,
              replyStrategy: "skip",
              riskLevel: "high",
              reason: message,
              status: "failed",
              errorMessage: message
            }
          });
        }
      }
    }

    const eligible: RankedExtractedItem[] = [];
    if (maxPublishCount > 0) {
      const authorIds = [...new Set(extractedItems.map((item) => item.authorId))];
      const recentTouchedCandidates = authorIds.length === 0 ? [] : await prisma.autoInterventionCandidate.findMany({
        where: {
          status: { in: ["planned", "dry_run_ready", "manual_review", "published"] },
          updatedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          post: { authorId: { in: authorIds } }
        },
        include: { post: { select: { authorId: true } } }
      });
      const authorRecentTouches = new Map<string, number>();
      for (const candidate of recentTouchedCandidates) {
        authorRecentTouches.set(candidate.post.authorId, (authorRecentTouches.get(candidate.post.authorId) || 0) + 1);
      }
      const rankedItems = selectFairInterventionCandidates(
        extractedItems,
        (item) => ({
          id: item.candidateId,
          baseScore: item.analysis.interventionScore,
          authorId: item.authorId,
          authorCentrality: item.authorCentrality,
          commentCount: item.post.commentCount,
          riskLevel: item.analysis.riskLevel,
          targetMode: item.analysis.targetMode,
          interventionType: item.analysis.interventionType,
          cieLevel: item.analysis.cieLevel,
          cieConfidence: item.analysis.cieConfidence,
          urgencyScore: item.analysis.urgencyScore,
          confusionScore: item.analysis.confusionScore,
          knowledgePhase: item.analysis.knowledgePhase,
          isValuable: item.analysis.isValuable,
          needsHumanReview: item.analysis.needsHumanReview
        }),
        {
          maxCount: extractedItems.length,
          minScore: input.minScoreToPublish,
          recentTouchesByAuthor: authorRecentTouches
        }
      );

      for (const ranked of rankedItems) {
        const item = ranked.item;
        if (includesMarker(item.post)) continue;
        if (await hasRecentSystemReply(item.post.url)) continue;
        eligible.push({
          ...item,
          fairPriority: ranked.fairPriority,
          authorRecentTouches: ranked.schedulingEvidence.recentTouches,
          schedulingEvidence: ranked.schedulingEvidence
        });
        if (eligible.length >= maxPublishCount) break;
      }
    }

    for (const item of eligible) {
      try {
        const promoted = await promoteAutoCandidateToInterventionTask({
          candidateId: item.candidateId
        });
        const plan = await prepareInterventionPlan({
          taskId: promoted.task.id
        });
        const content = plan.finalContent ?? plan.draftContent ?? "";
        if (!content.trim()) throw new Error("世界状态与学伴表达链没有生成可审阅内容。");
        if (normalizeTaskStatus(plan.status) === "ready" && await hasSimilarHistoricalReply(item.postId, content)) {
          await transitionInterventionTask({
            taskId: plan.id,
            toStatus: "skipped",
            reason: "与历史系统回复相似度过高。"
          });
          continue;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "未知发布错误";
        await prisma.autoInterventionCandidate.updateMany({
          where: {
            id: item.candidateId,
            status: "analyzed"
          },
          data: { status: "failed", errorMessage: message }
        });
      }
    }

    const candidates = await prisma.autoInterventionCandidate.findMany({ where: { runId: run.id }, orderBy: { interventionScore: "desc" } });
    const report = {
      course: { id: course.id, platformCourseId: course.platformCourseId, name: course.name },
      scannedCount: scanned.length,
      extractedCount: extractedItems.length,
      candidateCount: candidates.length,
      dryRunReadyCount: candidates.filter((candidate) => ["planned", "dry_run_ready"].includes(candidate.status)).length,
      publishedCount: candidates.filter((candidate) => candidate.status === "published").length,
      skippedCount: candidates.filter((candidate) => candidate.status === "skipped").length,
      failedCount: candidates.filter((candidate) => candidate.status === "failed").length,
      candidates: candidates.map((candidate) => ({
        title: candidate.postTitle,
        url: candidate.postUrl,
        score: candidate.interventionScore,
        interventionType: candidate.interventionType,
        targetMode: candidate.targetMode,
        riskLevel: candidate.riskLevel,
        reason: candidate.reason,
        draftReply: candidate.draftReply,
        status: candidate.status
      })),
      fairScheduling: eligible.map((item) => ({
        title: item.post.title,
        author: item.authorName,
        baseScore: item.analysis.interventionScore,
        fairPriority: item.fairPriority,
        authorRecentTouches: item.authorRecentTouches,
        schedulingEvidence: item.schedulingEvidence
      })),
      publishPolicy: {
        previewOnly: true,
        requestedMode: input.mode,
        callerBooleanIgnored: input.allowRealPublish,
        message: "巡检只生成冻结的干预计划；真实发布必须在审阅页取得绑定正文与目标的服务端授权。"
      }
    };
    await prisma.autoInterventionRun.update({
      where: { id: run.id },
      data: { status: "completed", finishedAt: new Date(), reportJson: JSON.stringify(report, null, 2) }
    });
    return { runId: run.id, ...report };
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知自动干预错误";
    await prisma.autoInterventionRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), reportJson: JSON.stringify({ error: message }, null, 2) }
    });
    throw error;
  }
}
