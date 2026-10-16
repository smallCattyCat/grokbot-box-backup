import { prisma } from "@/lib/db";
import type { InterventionType, MentalState } from "@/lib/types";
import {
  getCompanionExpressionPolicy,
  type CompanionExpressionPolicy
} from "./narrative-agent";

export const CONTEXT_VERSIONS = {
  observation: "agent-observation-v1",
  inference: "agent-inference-v1-rules",
  expression: "companion-expression-policy-v1"
} as const;

function parseStringArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function profileEvidenceAsOf(value: string) {
  try {
    const parsed = JSON.parse(value) as { asOfAt?: unknown };
    if (typeof parsed.asOfAt !== "string") return null;
    const result = new Date(parsed.asOfAt);
    return Number.isNaN(result.getTime()) ? null : result;
  } catch {
    return null;
  }
}

export type CreateAgentContextSnapshotInput = {
  taskId: string;
  interventionType: InterventionType;
  mentalState: MentalState;
  asOfAt?: Date;
};

export async function createAgentContextSnapshot(
  input: CreateAgentContextSnapshotInput
): Promise<{
  snapshot: Awaited<ReturnType<typeof prisma.agentContextSnapshot.create>>;
  expressionPolicy: CompanionExpressionPolicy;
}> {
  const asOfAt = input.asOfAt ?? new Date();
  if (Number.isNaN(asOfAt.getTime()) || asOfAt.getTime() > Date.now() + 1_000) {
    throw new Error("上下文快照截止时点无效或位于未来。");
  }

  const task = await prisma.interventionTask.findUniqueOrThrow({
    where: { id: input.taskId },
    include: {
      post: { include: { analysis: true } }
    }
  });
  if (task.interventionType !== input.interventionType) {
    throw new Error("上下文快照的学伴类型与任务不一致。");
  }
  if (task.post.createdAt.getTime() > asOfAt.getTime()) {
    throw new Error("帖子在上下文快照截止时点之后才出现。");
  }
  if (task.createdAt.getTime() > asOfAt.getTime()) {
    throw new Error("干预任务在上下文快照截止时点之后才创建。");
  }
  if (task.courseId && task.post.courseId && task.courseId !== task.post.courseId) {
    throw new Error("干预任务与帖子所属课程不一致。");
  }

  const courseId = task.courseId ?? task.post.courseId;
  const postSnapshot = await prisma.forumPostSnapshot.findFirst({
    where: {
      postId: task.postId,
      createdAt: { lte: asOfAt }
    },
    orderBy: { createdAt: "desc" }
  });
  if (!postSnapshot && task.post.updatedAt.getTime() > asOfAt.getTime()) {
    throw new Error("截止时点前没有可用的帖子快照，不能安全回放当前帖子计数。");
  }
  const observedPost = postSnapshot ?? task.post;
  if (observedPost.lastReplyAt && observedPost.lastReplyAt.getTime() > asOfAt.getTime()) {
    throw new Error("帖子快照包含截止时点之后的回复信息。");
  }
  const candidateProfile = courseId
    ? await prisma.forumUserCourseProfile.findFirst({
      where: {
        courseId,
        userId: task.targetUserId,
        generatedAt: { lte: asOfAt }
      },
      orderBy: { generatedAt: "desc" }
    })
    : null;
  const profileAsOfAt = candidateProfile
    ? profileEvidenceAsOf(candidateProfile.evidenceJson)
    : null;
  const profile = candidateProfile
    && (!profileAsOfAt || profileAsOfAt.getTime() <= asOfAt.getTime())
    ? candidateProfile
    : null;
  const expressionPolicy = getCompanionExpressionPolicy(input.interventionType);
  const visibleAnalysis = task.post.analysis
    && task.post.analysis.analyzedAt.getTime() <= asOfAt.getTime()
    ? task.post.analysis
    : null;

  const observation = {
    schemaVersion: CONTEXT_VERSIONS.observation,
    evidenceBoundary: {
      asOfAt: asOfAt.toISOString(),
      courseId,
      taskId: task.id,
      postId: task.postId,
      targetUserId: task.targetUserId,
      postSnapshotRunId: postSnapshot?.runId ?? null,
      learnerProfileSourceRunId: profile?.sourceRunId ?? null,
      learnerProfileSourceOnly: true,
      postObservationSource: postSnapshot ? "forum_post_snapshot" : "current_post_at_or_before_cutoff",
      rawPostContentCopied: false,
      futureInformationUsed: false
    },
    postObservation: {
      sourceKind: task.post.sourceKind,
      createdAt: task.post.createdAt.toISOString(),
      observedAt: postSnapshot?.createdAt.toISOString() ?? task.post.updatedAt.toISOString(),
      lastReplyAt: observedPost.lastReplyAt?.toISOString() ?? null,
      replyCount: observedPost.replyCount,
      likeCount: observedPost.likeCount,
      viewCount: observedPost.viewCount
    },
    learnerCourseObservation: profile
      ? {
        generatedAt: profile.generatedAt.toISOString(),
        evidenceAsOfAt: profileAsOfAt?.toISOString() ?? null,
        utteranceCount: profile.utteranceCount,
        postCount: profile.postCount,
        replyCount: profile.replyCount,
        incomingInteractionCount: profile.incomingInteractionCount,
        outgoingInteractionCount: profile.outgoingInteractionCount
      }
      : null
  };

  const inference = {
    schemaVersion: CONTEXT_VERSIONS.inference,
    nonDiagnostic: true,
    stablePersonalityClaimed: false,
    postSignalHypotheses: visibleAnalysis
      ? {
        cieLevel: visibleAnalysis.cieLevel,
        cieLabel: visibleAnalysis.cieLabel,
        emotionLabel: visibleAnalysis.emotionLabel,
        cognitiveDepth: visibleAnalysis.cognitiveDepth,
        discussionPotential: visibleAnalysis.discussionPotential,
        unansweredHours: visibleAnalysis.unansweredHours,
        isolatedLearnerScore: visibleAnalysis.isolatedLearnerScore,
        analyzedAt: visibleAnalysis.analyzedAt.toISOString()
      }
      : null,
    courseAggregateHypotheses: profile
      ? {
        dominantEmotion: profile.dominantEmotion,
        avgConfusionScore: profile.avgConfusionScore,
        avgUrgencyScore: profile.avgUrgencyScore,
        questionRatio: profile.questionRatio,
        riskFlags: parseStringArray(profile.riskFlagsJson)
      }
      : null,
    agentRegulationState: input.mentalState
  };

  const expression = {
    schemaVersion: CONTEXT_VERSIONS.expression,
    interventionType: input.interventionType,
    companion: expressionPolicy,
    taskLocalRegulation: input.mentalState,
    persistentAgentPersonalityMutated: false,
    learnerIdentitySimulated: false
  };

  const snapshot = await prisma.$transaction(async (transaction) => {
    const latest = await transaction.agentContextSnapshot.findFirst({
      where: { taskId: task.id },
      orderBy: { revision: "desc" },
      select: { revision: true }
    });
    return transaction.agentContextSnapshot.create({
      data: {
        courseId,
        taskId: task.id,
        postId: task.postId,
        targetUserId: task.targetUserId,
        sourceRunId: postSnapshot?.runId ?? profile?.sourceRunId ?? null,
        companionType: input.interventionType,
        revision: (latest?.revision ?? 0) + 1,
        asOfAt,
        observationSchemaVersion: CONTEXT_VERSIONS.observation,
        inferenceModelVersion: CONTEXT_VERSIONS.inference,
        expressionPolicyVersion: CONTEXT_VERSIONS.expression,
        observationJson: JSON.stringify(observation, null, 2),
        inferenceJson: JSON.stringify(inference, null, 2),
        expressionJson: JSON.stringify(expression, null, 2),
        futureInformationUsed: false
      }
    });
  });

  return { snapshot, expressionPolicy };
}
