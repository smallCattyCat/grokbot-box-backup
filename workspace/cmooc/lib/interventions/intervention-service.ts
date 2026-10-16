import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CanonicalTaskStatus, InterventionType } from "@/lib/types";
import { assertTransition, normalizeTaskStatus } from "@/lib/state-machine";
import { deriveAgentRegulationState } from "@/lib/agents/mental-state-agent";
import { createAgentContextSnapshot } from "@/lib/agents/context-snapshot";
import { generateReplyDraft } from "@/lib/agents/expression-agent";
import { checkReplySafety } from "@/lib/agents/safety-agent";
import { redactPii } from "@/lib/security/safety-gateway";
import {
  PUBLISH_POLICY_VERSION,
  buildPublicationBinding,
  computeContentHash
} from "./publish-policy";

export const INTERVENTION_POLICY_VERSION = "intervention-plan-v1";
const PROMOTABLE_CANDIDATE_STATUSES = new Set([
  "analyzed",
  "dry_run_ready",
  "planned",
  "manual_review",
  "failed"
]);

type StoredValueAnalysis = {
  isValuable?: boolean;
  cieLabel?: string;
  emotionLabel?: string;
  topicType?: string;
  interventionType?: string;
  targetMode?: string;
  targetCommentIndex?: number | null;
  targetReason?: string;
  replyStrategy?: string;
  reason?: string;
  riskLevel?: string;
  needsHumanReview?: boolean;
  discussionPotential?: number;
  isolatedLearnerScore?: number;
  unansweredHours?: number;
  duplicateScore?: number;
};

type StoredExtractedPost = {
  comments?: Array<{
    index?: number;
    id?: string;
  }>;
};

function parseValueAnalysis(value: string | null): StoredValueAnalysis {
  if (!value) return {};
  try {
    return JSON.parse(value) as StoredValueAnalysis;
  } catch {
    return {};
  }
}

function parseExtractedPost(value: string | null): StoredExtractedPost {
  if (!value) return {};
  try {
    return JSON.parse(value) as StoredExtractedPost;
  } catch {
    return {};
  }
}

function normalizeTargetCommentContent(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function findStableCommentTarget(input: {
  postId: string;
  targetCommentIndex: number | null;
  targetPlatformReplyId?: string | null;
  candidateRawExtractJson?: string | null;
}) {
  let platformReplyId = input.targetPlatformReplyId?.trim() || null;
  if (!platformReplyId && input.candidateRawExtractJson) {
    const comments = parseExtractedPost(input.candidateRawExtractJson).comments ?? [];
    const extracted = input.targetCommentIndex === null
      ? comments[0]
      : comments.find((comment) => comment.index === input.targetCommentIndex)
        ?? comments[input.targetCommentIndex];
    platformReplyId = extracted?.id?.trim() || null;
  }

  let reply = platformReplyId
    ? await prisma.forumReply.findFirst({
      where: { postId: input.postId, platformReplyId },
      include: { author: true }
    })
    : null;

  if (platformReplyId && !reply) {
    return null;
  }
  if (!reply) {
    const candidates = await prisma.forumReply.findMany({
      where: {
        postId: input.postId,
        platformReplyId: { not: null }
      },
      include: { author: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    });
    reply = candidates[input.targetCommentIndex ?? 0] ?? null;
  }
  if (!reply?.platformReplyId) return null;

  const normalizedContent = normalizeTargetCommentContent(reply.content);
  return {
    platformReplyId: reply.platformReplyId,
    contentHash: computeContentHash(normalizedContent),
    preview: redactPii(normalizedContent).slice(0, 180),
    targetUserId: reply.authorId,
    targetUserName: reply.author.name
  };
}

type PreparedTask = Awaited<ReturnType<typeof prisma.interventionTask.findUniqueOrThrow>> & {
  post: {
    authorId: string;
    analysis: {
      cieLevel: number;
      emotionLabel: string;
    } | null;
  };
};

async function bindStableTarget(task: PreparedTask): Promise<PreparedTask> {
  if (task.publishTarget !== "comment_reply") {
    if (
      !task.targetPlatformReplyId &&
      !task.targetCommentContentHash &&
      !task.targetCommentPreview &&
      task.targetUserId === task.post.authorId
    ) {
      return task;
    }
    return prisma.$transaction(async (transaction) => {
      await transaction.publishAuthorization.updateMany({
        where: { taskId: task.id, status: "active" },
        data: { status: "revoked", revokedAt: new Date() }
      });
      const changed = await transaction.interventionTask.updateMany({
        where: {
          id: task.id,
          status: task.status,
          updatedAt: task.updatedAt
        },
        data: {
          targetUserId: task.post.authorId,
          targetPlatformReplyId: null,
          targetCommentContentHash: null,
          targetCommentPreview: null,
          contentHash: null,
          targetHash: null,
          safetyCheckedAt: null
        }
      });
      if (changed.count !== 1) {
        throw new Error("任务目标在绑定期间已被其他操作修改，请刷新后重试。");
      }
      return transaction.interventionTask.findUniqueOrThrow({
        where: { id: task.id },
        include: { post: { include: { analysis: true } } }
      }) as Promise<PreparedTask>;
    });
  }

  const sourceCandidate = task.sourceCandidateId
    ? await prisma.autoInterventionCandidate.findUnique({
      where: { id: task.sourceCandidateId },
      select: { rawExtractJson: true }
    })
    : null;
  const stableTarget = await findStableCommentTarget({
    postId: task.postId,
    targetCommentIndex: task.targetCommentIndex,
    targetPlatformReplyId: task.targetPlatformReplyId,
    candidateRawExtractJson: sourceCandidate?.rawExtractJson
  });
  if (!stableTarget) {
    throw new Error("目标评论没有稳定的平台标识，已阻止生成可发布计划；请改为回复主题帖或重新采集论坛详情。");
  }
  if (
    task.targetPlatformReplyId === stableTarget.platformReplyId &&
    task.targetCommentContentHash === stableTarget.contentHash &&
    task.targetCommentPreview === stableTarget.preview &&
    task.targetUserId === stableTarget.targetUserId
  ) {
    return task;
  }

  return prisma.$transaction(async (transaction) => {
    await transaction.publishAuthorization.updateMany({
      where: { taskId: task.id, status: "active" },
      data: { status: "revoked", revokedAt: new Date() }
    });
    const changed = await transaction.interventionTask.updateMany({
      where: {
        id: task.id,
        status: task.status,
        updatedAt: task.updatedAt
      },
      data: {
        targetUserId: stableTarget.targetUserId,
        targetPlatformReplyId: stableTarget.platformReplyId,
        targetCommentContentHash: stableTarget.contentHash,
        targetCommentPreview: stableTarget.preview,
        contentHash: null,
        targetHash: null,
        safetyCheckedAt: null
      }
    });
    if (changed.count !== 1) {
      throw new Error("任务目标在绑定期间已被其他操作修改，请刷新后重试。");
    }
    return transaction.interventionTask.findUniqueOrThrow({
      where: { id: task.id },
      include: { post: { include: { analysis: true } } }
    }) as Promise<PreparedTask>;
  });
}

function asInterventionType(value: string): InterventionType {
  if (
    value === "resource_connector" ||
    value === "cognitive_conflict" ||
    value === "emotional_support" ||
    value === "mixed"
  ) {
    return value;
  }
  return "cognitive_conflict";
}

function initialTaskStatus(candidate: {
  status: string;
  interventionType: string;
  targetMode: string;
  interventionScore: number;
  riskLevel: string;
  valueAnalysisJson: string | null;
}): CanonicalTaskStatus {
  if (candidate.status === "published") return "published";
  if (candidate.status === "publishing" || candidate.status === "failed") return "reconcile_required";
  if (candidate.status === "skipped" || candidate.interventionType === "none" || candidate.targetMode === "skip") {
    return "skipped";
  }
  const analysis = parseValueAnalysis(candidate.valueAnalysisJson);
  if (
    candidate.status === "manual_review" ||
    analysis.needsHumanReview ||
    candidate.riskLevel === "high" ||
    analysis.isValuable === false
  ) {
    return analysis.isValuable === false || candidate.interventionScore < 60
      ? "skipped"
      : "review_required";
  }
  return "proposed";
}

export async function transitionInterventionTask(input: {
  taskId: string;
  toStatus: CanonicalTaskStatus;
  reason?: string;
}) {
  const task = await prisma.interventionTask.findUniqueOrThrow({
    where: { id: input.taskId }
  });
  const current = normalizeTaskStatus(task.status);
  if (current === input.toStatus) return task;
  assertTransition(current, input.toStatus);

  return prisma.$transaction(async (transaction) => {
    const changed = await transaction.interventionTask.updateMany({
      where: {
        id: task.id,
        status: task.status,
        updatedAt: task.updatedAt
      },
      data: {
        status: input.toStatus,
        ...(input.toStatus === "skipped" && input.reason?.trim()
          ? { errorMessage: input.reason.trim() }
          : {})
      }
    });
    if (changed.count !== 1) {
      throw new Error("任务状态已被其他操作更新，请刷新后重试。");
    }
    if (input.toStatus !== "ready" && input.toStatus !== "publishing") {
      await transaction.publishAuthorization.updateMany({
        where: { taskId: task.id, status: "active" },
        data: { status: "revoked", revokedAt: new Date() }
      });
    }
    if (input.toStatus === "skipped" && task.sourceCandidateId) {
      await transaction.autoInterventionCandidate.updateMany({
        where: {
          id: task.sourceCandidateId,
          status: { notIn: ["publishing", "published"] }
        },
        data: {
          status: "skipped",
          errorMessage: input.reason?.trim() ||
            "研究者在计划审阅阶段决定不干预。"
        }
      });
    }
    return transaction.interventionTask.findUniqueOrThrow({ where: { id: task.id } });
  });
}

export async function promoteAutoCandidateToInterventionTask(input: {
  candidateId: string;
}): Promise<{
  task: Awaited<ReturnType<typeof prisma.interventionTask.findUniqueOrThrow>>;
  created: boolean;
}> {
  const candidate = await prisma.autoInterventionCandidate.findUniqueOrThrow({
    where: { id: input.candidateId },
    include: {
      task: true,
      post: { include: { author: true } }
    }
  });
  if (candidate.task) {
    return { task: candidate.task, created: false };
  }
  if (!PROMOTABLE_CANDIDATE_STATUSES.has(candidate.status)) {
    throw new Error(`候选当前状态 ${candidate.status} 不能固化为干预计划。`);
  }

  const analysis = parseValueAnalysis(candidate.valueAnalysisJson);
  const stableTarget = candidate.targetMode === "comment_reply"
    ? await findStableCommentTarget({
      postId: candidate.postId,
      targetCommentIndex: candidate.targetCommentIndex,
      candidateRawExtractJson: candidate.rawExtractJson
    })
    : null;
  const initialStatus = initialTaskStatus(candidate);
  const targetMissing = candidate.targetMode === "comment_reply" && !stableTarget;
  const taskStatus = targetMissing && !["published", "skipped"].includes(initialStatus)
    ? "review_required"
    : initialStatus;
  const interventionType = asInterventionType(candidate.interventionType);

  try {
    const task = await prisma.$transaction(async (transaction) => {
      const candidateClaim = await transaction.autoInterventionCandidate.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          updatedAt: candidate.updatedAt
        },
        data: {
          status: "promoting",
          errorMessage: null
        }
      });
      if (candidateClaim.count !== 1) {
        throw new Error("CANDIDATE_ALREADY_RESOLVED");
      }
      await transaction.interactionAnalysis.upsert({
        where: { postId: candidate.postId },
        update: {
          courseId: candidate.courseId,
          cieLevel: candidate.cieLevel,
          cieLabel: analysis.cieLabel ?? `CIE ${candidate.cieLevel}`,
          emotionLabel: candidate.emotionLabel,
          topicRelevance: Math.min(100, Math.max(0, candidate.interventionScore)),
          cognitiveDepth: Math.min(100, Math.max(0, candidate.cieLevel * 12.5)),
          discussionPotential: Math.min(100, Math.max(0, analysis.discussionPotential ?? candidate.interventionScore)),
          unansweredHours: Math.max(0, analysis.unansweredHours ?? 0),
          isolatedLearnerScore: Math.min(100, Math.max(0, analysis.isolatedLearnerScore ?? 0)),
          duplicateScore: Math.min(100, Math.max(0, analysis.duplicateScore ?? 0)),
          analyzedAt: new Date()
        },
        create: {
          courseId: candidate.courseId,
          postId: candidate.postId,
          cieLevel: candidate.cieLevel,
          cieLabel: analysis.cieLabel ?? `CIE ${candidate.cieLevel}`,
          emotionLabel: candidate.emotionLabel,
          topicRelevance: Math.min(100, Math.max(0, candidate.interventionScore)),
          cognitiveDepth: Math.min(100, Math.max(0, candidate.cieLevel * 12.5)),
          discussionPotential: Math.min(100, Math.max(0, analysis.discussionPotential ?? candidate.interventionScore)),
          unansweredHours: Math.max(0, analysis.unansweredHours ?? 0),
          isolatedLearnerScore: Math.min(100, Math.max(0, analysis.isolatedLearnerScore ?? 0)),
          duplicateScore: Math.min(100, Math.max(0, analysis.duplicateScore ?? 0))
        }
      });

      const created = await transaction.interventionTask.create({
        data: {
          courseId: candidate.courseId,
          sourceCandidateId: candidate.id,
          postId: candidate.postId,
          targetUserId: stableTarget?.targetUserId ?? candidate.post.authorId,
          interventionType,
          publishTarget: candidate.targetMode === "comment_reply" ? "comment_reply" : "post_comment",
          targetCommentStrategy:
            candidate.targetMode === "comment_reply" && candidate.targetCommentIndex === null
              ? "first"
              : null,
          targetCommentIndex: candidate.targetCommentIndex,
          targetPlatformReplyId: stableTarget?.platformReplyId ?? null,
          targetCommentContentHash: stableTarget?.contentHash ?? null,
          targetCommentPreview: stableTarget?.preview ?? null,
          priorityScore: candidate.interventionScore,
          status: taskStatus,
          draftContent: candidate.draftReply,
          finalContent: candidate.finalReply,
          safetyRisk: candidate.safetyRisk,
          safetyResult: candidate.errorMessage,
          publishedUrl: candidate.publishedUrl,
          screenshotPath: candidate.screenshotPath,
          errorMessage: targetMissing
            ? "目标评论缺少稳定平台标识，不能授权发布。"
            : taskStatus === "skipped" || taskStatus === "review_required"
              ? candidate.errorMessage
              : null,
          publishedAt: taskStatus === "published" ? candidate.updatedAt : null,
          policyDecisionJson: candidate.valueAnalysisJson,
          policyVersion: INTERVENTION_POLICY_VERSION
        }
      });
      let finalizedTask = created;
      if (candidate.finalReply || candidate.draftReply) {
        const binding = buildPublicationBinding(created);
        finalizedTask = await transaction.interventionTask.update({
          where: { id: created.id },
          data: { contentHash: binding.contentHash, targetHash: binding.targetHash }
        });
      }
      await transaction.autoInterventionCandidate.update({
        where: { id: candidate.id },
        data: {
          status:
            taskStatus === "skipped"
              ? "skipped"
              : taskStatus === "published"
                ? "published"
                : taskStatus === "proposed"
                  ? "planned"
                  : "manual_review",
          errorMessage: targetMissing
            ? "目标评论缺少稳定平台标识，不能授权发布。"
            : taskStatus === "review_required"
              ? candidate.errorMessage
              : null
        }
      });
      return finalizedTask;
    });
    return { task, created: true };
  } catch (error) {
    if (error instanceof Error && error.message === "CANDIDATE_ALREADY_RESOLVED") {
      const current = await prisma.autoInterventionCandidate.findUniqueOrThrow({
        where: { id: candidate.id },
        include: { task: true }
      });
      if (current.task) return { task: current.task, created: false };
      throw new Error("候选已被忽略或正在由另一项操作处理，请刷新后查看。");
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const taskForCandidate = await prisma.interventionTask.findUnique({
        where: { sourceCandidateId: candidate.id }
      });
      if (taskForCandidate) return { task: taskForCandidate, created: false };

      const existingOpenTask = await prisma.interventionTask.findFirst({
        where: {
          postId: candidate.postId,
          status: {
            in: [
              "proposed",
              "review_required",
              "ready",
              "publishing",
              "failed_retryable",
              "reconcile_required"
            ]
          }
        },
        orderBy: { updatedAt: "desc" }
      });
      if (existingOpenTask) {
        await prisma.autoInterventionCandidate.updateMany({
          where: {
            id: candidate.id,
            status: candidate.status,
            updatedAt: candidate.updatedAt
          },
          data: {
            status: "skipped",
            errorMessage: "同一帖子已经存在开放的干预计划，本候选保留为重复检测证据。"
          }
        });
        return { task: existingOpenTask, created: false };
      }
    }
    throw error;
  }
}

export async function skipAutoInterventionCandidate(input: {
  candidateId: string;
  reason?: string;
}) {
  const candidate = await prisma.autoInterventionCandidate.findUniqueOrThrow({
    where: { id: input.candidateId },
    include: { task: { select: { id: true } } }
  });
  if (candidate.task) {
    throw new Error("候选已经固化为干预计划，请在计划卡片中跳过。");
  }
  if (candidate.status === "skipped") return candidate;
  if (candidate.status === "published") {
    throw new Error("已发布候选不能跳过。");
  }
  if (candidate.status === "promoting") {
    throw new Error("候选正在固化为计划，请刷新后在计划卡片中处理。");
  }
  const changed = await prisma.autoInterventionCandidate.updateMany({
    where: {
      id: candidate.id,
      status: candidate.status,
      updatedAt: candidate.updatedAt
    },
    data: {
      status: "skipped",
      errorMessage: input.reason?.trim() ||
        "研究者在候选审阅阶段决定不干预。"
    }
  });
  if (changed.count !== 1) {
    const current = await prisma.autoInterventionCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
      include: { task: { select: { id: true } } }
    });
    if (current.task) {
      throw new Error("候选已经固化为干预计划，请在计划卡片中跳过。");
    }
    throw new Error("候选状态已由另一项操作更新，请刷新后查看。");
  }
  return prisma.autoInterventionCandidate.findUniqueOrThrow({
    where: { id: candidate.id }
  });
}

export async function prepareInterventionPlan(input: {
  taskId: string;
  force?: boolean;
}) {
  let task = await prisma.interventionTask.findUniqueOrThrow({
    where: { id: input.taskId },
    include: { post: { include: { analysis: true } } }
  }) as PreparedTask;
  let status = normalizeTaskStatus(task.status);
  if (status === "published" || status === "skipped" || status === "publishing" || status === "reconcile_required") {
    throw new Error(`当前状态 ${status} 不能重新生成干预计划。`);
  }
  task = await bindStableTarget(task);
  status = normalizeTaskStatus(task.status);
  if (
    !input.force &&
    status === "ready" &&
    task.contentHash &&
    task.targetHash &&
    task.safetyCheckedAt
  ) {
    return task;
  }

  const interventionType = asInterventionType(task.interventionType);
  const mentalState = await deriveAgentRegulationState({
    taskId: task.id,
    postId: task.postId,
    interventionType,
    emotionLabel: task.post.analysis?.emotionLabel ?? "中性",
    cieLevel: task.post.analysis?.cieLevel,
    communityMood: "开放但回应不均衡"
  });
  const context = await createAgentContextSnapshot({
    taskId: task.id,
    interventionType,
    mentalState
  });
  const draft = await generateReplyDraft({
    taskId: task.id,
    postId: task.postId,
    interventionType,
    mentalState,
    contextSnapshotId: context.snapshot.id,
    expressionPolicy: context.expressionPolicy
  });
  if (!draft.draftContent.trim()) {
    throw new Error("学伴表达智能体没有生成可审阅的回复。");
  }
  const safety = await checkReplySafety({
    taskId: task.id,
    postId: task.postId,
    content: draft.draftContent
  });
  const binding = buildPublicationBinding({
    ...task,
    draftContent: draft.draftContent,
    finalContent: draft.draftContent
  });
  const nextStatus = safety.route;
  const now = new Date();

  const updated = await prisma.$transaction(async (transaction) => {
    const changed = await transaction.interventionTask.updateMany({
      where: {
        id: task.id,
        status: task.status,
        updatedAt: task.updatedAt
      },
      data: {
        status: nextStatus,
        draftContent: draft.draftContent,
        finalContent: draft.draftContent,
        safetyRisk: safety.safetyRisk,
        safetyResult: safety.safetyResult,
        safetyCheckedAt: now,
        contentHash: binding.contentHash,
        targetHash: binding.targetHash,
        policyVersion: INTERVENTION_POLICY_VERSION,
        policyDecisionJson: JSON.stringify({
          policyVersion: INTERVENTION_POLICY_VERSION,
          publishPolicyVersion: PUBLISH_POLICY_VERSION,
          contextSnapshotId: context.snapshot.id,
          safety,
          decidedAt: now.toISOString()
        })
      }
    });
    if (changed.count !== 1) {
      throw new Error("任务在生成期间已被发布或修改，本次生成结果未覆盖当前计划；请刷新后重试。");
    }
    await transaction.publishAuthorization.updateMany({
      where: { taskId: task.id, status: "active" },
      data: { status: "revoked", revokedAt: now }
    });
    if (task.sourceCandidateId) {
      await transaction.autoInterventionCandidate.updateMany({
        where: {
          id: task.sourceCandidateId,
          status: { notIn: ["publishing", "published"] }
        },
        data: {
          draftReply: draft.draftContent,
          finalReply: draft.draftContent,
          safetyRisk: safety.safetyRisk,
          status: nextStatus === "ready" ? "planned" : "manual_review",
          errorMessage: nextStatus === "ready" ? null : safety.safetyResult
        }
      });
    }
    return transaction.interventionTask.findUniqueOrThrow({
      where: { id: task.id }
    });
  });

  return updated;
}
