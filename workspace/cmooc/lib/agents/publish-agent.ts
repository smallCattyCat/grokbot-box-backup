import { prisma } from "@/lib/db";
import {
  publishReplyWithPlaywright,
  validateRealReplyTarget,
  type PublishMode,
  type RealPublishTransport,
  type RealPublishTargetMode,
  type TargetCommentStrategy
} from "@/lib/forum/publish-reply";
import { assertRealForumWriteUnlocked } from "@/lib/forum/real-write-lock";
import { getForumSettings } from "@/lib/settings";
import {
  buildPublicationBinding,
  issuePublishAuthorization
} from "@/lib/interventions/publish-policy";
import { publishIntervention } from "@/lib/interventions/publish-service";
import { normalizeTaskStatus } from "@/lib/state-machine";
import { recordAgentRunBestEffort } from "./agent-run";

export type RealPublishTargetOptions = {
  targetMode?: RealPublishTargetMode;
  targetCommentIndex?: number;
  targetCommentStrategy?: TargetCommentStrategy;
  targetCommentText?: string;
  transport?: RealPublishTransport;
};

function assertTargetOptionsMatchTask(
  task: {
    publishTarget: string;
    targetCommentIndex: number | null;
    targetCommentStrategy: string | null;
    targetPlatformReplyId: string | null;
    targetCommentContentHash: string | null;
  },
  targetOptions: RealPublishTargetOptions
) {
  if (targetOptions.targetMode && targetOptions.targetMode !== task.publishTarget) {
    throw new Error("发布目标与已审核计划不一致，请重新生成并授权。");
  }
  if (
    targetOptions.targetCommentIndex !== undefined &&
    targetOptions.targetCommentIndex !== task.targetCommentIndex
  ) {
    throw new Error("目标评论已变化，请重新生成并授权。");
  }
  if (
    targetOptions.targetCommentStrategy &&
    targetOptions.targetCommentStrategy !== task.targetCommentStrategy
  ) {
    throw new Error("目标评论策略已变化，请重新生成并授权。");
  }
  if (targetOptions.targetCommentText) {
    throw new Error("按临时文本改写目标不属于已审核计划，已阻止发布。");
  }
}

async function persistMockCompanionReply(input: {
  taskId: string;
  attemptId?: string;
  postId: string;
  content: string;
  companionType: string;
}) {
  const marker = input.attemptId ?? input.taskId;
  const forumReplyId = `mock-published-${marker}`;
  const existing = await prisma.forumReply.findUnique({ where: { forumReplyId } });
  if (existing) return;
  const companionUser = await prisma.forumUser.upsert({
    where: { forumUserId: "companion-system" },
    update: {},
    create: {
      forumUserId: "companion-system",
      name: "智能学伴",
      role: "companion",
      tagsJson: JSON.stringify(["智能学伴", "系统账号"]),
      activityLevel: 80,
      emotionalState: "stable",
      centralityScore: 0.7,
      lastActiveAt: new Date()
    }
  });
  await prisma.$transaction([
    prisma.forumReply.create({
      data: {
        forumReplyId,
        sourceKind: "companion",
        postId: input.postId,
        authorId: companionUser.id,
        content: input.content,
        isCompanionReply: true,
        companionType: input.companionType
      }
    }),
    prisma.forumPost.update({
      where: { id: input.postId },
      data: { replyCount: { increment: 1 }, lastReplyAt: new Date() }
    })
  ]);
}

export async function publishInterventionTask(
  taskId: string,
  baseUrl?: string,
  mode: PublishMode = "mock",
  targetOptions: RealPublishTargetOptions = {}
) {
  if (mode === "real") {
    assertRealForumWriteUnlocked();
  }
  const startedAt = new Date();
  const task = await prisma.interventionTask.findUniqueOrThrow({
    where: { id: taskId },
    include: { post: true }
  });
  if (normalizeTaskStatus(task.status) !== "ready") {
    throw new Error(`当前任务状态 ${task.status} 不能发布。`);
  }
  assertTargetOptionsMatchTask(task, targetOptions);
  const content = task.finalContent ?? task.draftContent ?? "";
  if (!content.trim()) throw new Error("任务没有可发布的回复正文。");

  let authorization;
  let reviewedForumSettingsVersion: Date | null = null;
  if (mode === "real") {
    const settings = await getForumSettings();
    if (!settings.realPublishEnabled) {
      throw new Error("真实发布紧急停止开关处于关闭状态。");
    }
    reviewedForumSettingsVersion = settings.updatedAt;
    authorization = await prisma.publishAuthorization.findFirst({
      where: {
        taskId,
        status: "active",
        expiresAt: { gt: new Date() }
      },
      orderBy: { authorizedAt: "desc" }
    });
    if (!authorization) {
      throw new Error("缺少绑定当前正文与目标的有效发布授权。");
    }
    try {
      await validateRealReplyTarget({
        postUrl: task.post.url,
        targetMode: task.publishTarget as RealPublishTargetMode,
        targetPlatformReplyId: task.targetPlatformReplyId ?? undefined,
        targetCommentContentHash: task.targetCommentContentHash ?? undefined
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "目标评论预检失败。";
      await prisma.$transaction([
        prisma.interventionTask.updateMany({
          where: { id: task.id, status: "ready" },
          data: {
            status: "review_required",
            targetHash: null,
            safetyCheckedAt: null,
            errorMessage: message
          }
        }),
        prisma.publishAuthorization.updateMany({
          where: { taskId: task.id, status: "active" },
          data: { status: "revoked", revokedAt: new Date() }
        })
      ]);
      await recordAgentRunBestEffort({
        taskId,
        postId: task.postId,
        agentName: "publisher-target-preflight-agent",
        input: {
          publishTarget: task.publishTarget,
          targetPlatformReplyId: task.targetPlatformReplyId
        },
        output: { allowed: false, message },
        status: "failed",
        startedAt
      });
      throw new Error(message);
    }
  } else {
    authorization = issuePublishAuthorization(buildPublicationBinding(task), {
      kind: "mock",
      expiresInMinutes: 10
    });
  }

  const result = await publishIntervention({
    taskId,
    authorization,
    authorizationSource: mode === "real" ? "persisted" : "ephemeral_test",
    transport: mode === "real" ? targetOptions.transport ?? "api" : "mock_browser",
    publisher: async () => {
      if (mode === "real") {
        assertRealForumWriteUnlocked();
        const currentSettings = await getForumSettings();
        if (
          !currentSettings.realPublishEnabled ||
          !reviewedForumSettingsVersion ||
          currentSettings.updatedAt.getTime() !== reviewedForumSettingsVersion.getTime()
        ) {
          return {
            outcome: "not_attempted" as const,
            message: "真实发布开关或论坛设置在审批后发生变化，远端写入尚未开始。",
            evidence: "forum-settings-version-changed-before-remote-call",
            transport: targetOptions.transport ?? "api"
          };
        }
      }
      const published = await publishReplyWithPlaywright({
        mode,
        postId: task.post.id,
        forumPostId: task.post.forumPostId,
        postUrl: task.post.url,
        content,
        baseUrl,
        targetMode: mode === "real" ? task.publishTarget as RealPublishTargetMode : undefined,
        targetCommentIndex: task.targetCommentIndex ?? undefined,
        targetCommentStrategy: task.targetCommentStrategy as TargetCommentStrategy | undefined,
        targetPlatformReplyId: task.targetPlatformReplyId ?? undefined,
        targetCommentContentHash: task.targetCommentContentHash ?? undefined,
        realTransport: mode === "real" ? targetOptions.transport ?? "api" : undefined
      });
      return {
        outcome: "published" as const,
        publishedUrl: published.publishedUrl,
        screenshotPath: published.screenshotPath,
        transport: published.transport,
        evidence: JSON.stringify({
          screenshotPath: published.screenshotPath,
          tracePath: published.tracePath ?? null
        })
      };
    }
  });

  if (mode === "mock" && result.status === "published") {
    await persistMockCompanionReply({
      taskId,
      attemptId: result.attemptId,
      postId: task.postId,
      content,
      companionType: task.interventionType
    });
  }
  const output = await prisma.interventionTask.findUniqueOrThrow({ where: { id: taskId } });
  await recordAgentRunBestEffort({
    taskId,
    postId: task.postId,
    agentName: "publisher-evidence-agent",
    input: {
      taskId,
      mode,
      target: {
        publishTarget: task.publishTarget,
        targetCommentIndex: task.targetCommentIndex,
        targetCommentStrategy: task.targetCommentStrategy,
        targetPlatformReplyId: task.targetPlatformReplyId,
        targetCommentContentHash: task.targetCommentContentHash
      },
      authorizationId: authorization.id
    },
    output: result,
    status: result.status === "published" ? "success" : "failed",
    startedAt
  });
  if (result.status !== "published") {
    throw new Error(result.message ?? `发布未完成，当前状态：${result.status}`);
  }
  return output;
}
