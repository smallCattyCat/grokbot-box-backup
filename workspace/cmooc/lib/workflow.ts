import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { PublishMode } from "@/lib/forum/publish-reply";
import type { RealPublishTargetOptions } from "@/lib/agents/publish-agent";
import { classifyCieLevel } from "@/lib/agents/cie-classifier";
import { analyzeInteraction } from "@/lib/agents/interaction-analyzer";
import { calculateInterventionScore } from "@/lib/agents/intervention-score";
import { chooseCompanionType } from "@/lib/agents/scheduler-agent";
import { ensureCompanionProfile } from "@/lib/agents/narrative-agent";
import { scanForumPosts } from "@/lib/agents/global-monitor";
import { publishInterventionTask } from "@/lib/agents/publish-agent";
import {
  prepareInterventionPlan,
  transitionInterventionTask
} from "@/lib/interventions/intervention-service";
import { normalizeTaskStatus } from "@/lib/state-machine";

const openTaskStatuses = [
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
] as const;

async function findOpenTask(postId: string) {
  return prisma.interventionTask.findFirst({
    where: {
      postId,
      status: { in: [...openTaskStatuses] }
    },
    orderBy: { updatedAt: "desc" }
  });
}

async function createOrReuseOpenTask(input: {
  courseId: string | null;
  postId: string;
  targetUserId: string;
}) {
  try {
    return await prisma.interventionTask.create({
      data: {
        courseId: input.courseId,
        postId: input.postId,
        targetUserId: input.targetUserId,
        interventionType: "cognitive_conflict",
        publishTarget: "post_comment",
        priorityScore: 0,
        status: "proposed"
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const racedTask = await findOpenTask(input.postId);
      if (racedTask) return racedTask;
    }
    throw error;
  }
}

export async function commitAnalyzedInterventionTask(input: {
  taskId: string;
  expectedStatus: string;
  expectedUpdatedAt: Date;
  interventionType: string;
  publishTarget: string;
  targetCommentStrategy: string | null;
  targetCommentIndex: number | null;
  priorityScore: number;
  targetUserId: string;
}) {
  return prisma.$transaction(async (transaction) => {
    const changed = await transaction.interventionTask.updateMany({
      where: {
        id: input.taskId,
        status: input.expectedStatus,
        updatedAt: input.expectedUpdatedAt
      },
      data: {
        status: "proposed",
        interventionType: input.interventionType,
        publishTarget: input.publishTarget,
        targetCommentStrategy: input.targetCommentStrategy,
        targetCommentIndex: input.targetCommentIndex,
        targetPlatformReplyId: null,
        targetCommentContentHash: null,
        targetCommentPreview: null,
        priorityScore: input.priorityScore,
        targetUserId: input.targetUserId,
        draftContent: null,
        finalContent: null,
        safetyRisk: null,
        safetyResult: null,
        contentHash: null,
        targetHash: null,
        safetyCheckedAt: null,
        policyDecisionJson: null,
        policyVersion: null,
        errorMessage: null
      }
    });
    if (changed.count !== 1) {
      return transaction.interventionTask.findUniqueOrThrow({
        where: { id: input.taskId }
      });
    }
    await transaction.publishAuthorization.updateMany({
      where: { taskId: input.taskId, status: "active" },
      data: { status: "revoked", revokedAt: new Date() }
    });
    return transaction.interventionTask.findUniqueOrThrow({
      where: { id: input.taskId }
    });
  });
}

export async function analyzePostToCandidate(postId: string) {
  await scanForumPosts();
  const post = await prisma.forumPost.findUniqueOrThrow({
    where: { id: postId },
    include: { author: true }
  });
  let task = await findOpenTask(postId);
  if (!task) {
    task = await createOrReuseOpenTask({
      courseId: post.courseId,
      postId,
      targetUserId: post.authorId
    });
  }
  const taskStatus = normalizeTaskStatus(task.status);
  if (taskStatus === "publishing" || taskStatus === "reconcile_required") {
    return task;
  }

  const cie = await classifyCieLevel(postId, task.id);
  const signal = await analyzeInteraction(postId, task.id);
  await prisma.interactionAnalysis.upsert({
    where: { postId },
    update: {
      courseId: post.courseId,
      cieLevel: cie.cieLevel,
      cieLabel: cie.cieLabel,
      emotionLabel: signal.emotionLabel,
      topicRelevance: signal.topicRelevance,
      cognitiveDepth: signal.cognitiveDepth,
      discussionPotential: signal.discussionPotential,
      unansweredHours: signal.unansweredHours,
      isolatedLearnerScore: signal.isolatedLearnerScore,
      duplicateScore: signal.duplicateScore,
      analyzedAt: new Date()
    },
    create: {
      courseId: post.courseId,
      postId,
      cieLevel: cie.cieLevel,
      cieLabel: cie.cieLabel,
      emotionLabel: signal.emotionLabel,
      topicRelevance: signal.topicRelevance,
      cognitiveDepth: signal.cognitiveDepth,
      discussionPotential: signal.discussionPotential,
      unansweredHours: signal.unansweredHours,
      isolatedLearnerScore: signal.isolatedLearnerScore,
      duplicateScore: signal.duplicateScore
    }
  });
  const score = await calculateInterventionScore({
    postId,
    taskId: task.id,
    cieLevel: cie.cieLevel,
    unansweredHours: signal.unansweredHours,
    emotionLabel: signal.emotionLabel,
    topicRelevance: signal.topicRelevance,
    discussionPotential: signal.discussionPotential,
    isolatedLearnerScore: signal.isolatedLearnerScore
  });
  const decision = await chooseCompanionType({
    postId,
    taskId: task.id,
    cieLevel: cie.cieLevel,
    analysis: signal
  });
  await ensureCompanionProfile(decision.interventionType, postId, task.id);

  return commitAnalyzedInterventionTask({
    taskId: task.id,
    expectedStatus: task.status,
    expectedUpdatedAt: task.updatedAt,
    interventionType: decision.interventionType,
    publishTarget: decision.publishTarget,
    targetCommentStrategy: decision.targetCommentStrategy ?? null,
    targetCommentIndex: decision.targetCommentIndex ?? null,
    priorityScore: score.priorityScore,
    targetUserId: post.authorId
  });
}

export async function runFullAgentPipelineForPost(postId: string) {
  const candidate = await analyzePostToCandidate(postId);
  return prepareInterventionPlan({ taskId: candidate.id, force: true });
}

export async function scanAndAnalyzeForum() {
  const findings = await scanForumPosts();
  const uniquePostIds = Array.from(new Set(findings.map((finding) => finding.postId)));
  const tasks = [];
  for (const postId of uniquePostIds) {
    tasks.push(await analyzePostToCandidate(postId));
  }
  return { findings, tasks };
}

export async function skipIntervention(taskId: string) {
  return transitionInterventionTask({ taskId, toStatus: "skipped" });
}

export async function publishQueuedIntervention(
  taskId: string,
  baseUrl?: string,
  mode: PublishMode = "mock",
  targetOptions: RealPublishTargetOptions = {}
) {
  return publishInterventionTask(taskId, baseUrl, mode, targetOptions);
}
