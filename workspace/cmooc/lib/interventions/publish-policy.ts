import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { normalizeTaskStatus } from "@/lib/state-machine";

export const PUBLISH_POLICY_VERSION = "publish-authorization-v1";

export type PublicationTarget = {
  publishTarget: string;
  targetCommentIndex: number | null;
  targetCommentStrategy: string | null;
  targetPlatformReplyId: string | null;
  targetCommentContentHash: string | null;
};

export type PublicationBinding = {
  taskId: string;
  contentHash: string;
  targetHash: string;
  expiresAt?: Date;
};

export type IssuedPublishAuthorization = {
  id: string;
  taskId: string;
  kind: "single" | "batch" | "mock";
  status: "active";
  contentHash: string;
  targetHash: string;
  expiresAt: Date;
  maxUses: number;
  usedCount: number;
  authorizedAt: Date;
};

export type AuthorizationValidation = {
  valid: boolean;
  reason?: string;
};

type AuthorizationLike = {
  taskId: string;
  contentHash: string;
  targetHash: string;
  expiresAt: Date | string;
  status?: string;
  maxUses?: number;
  usedCount?: number;
  revokedAt?: Date | string | null;
};

type TaskPublicationFields = PublicationTarget & {
  id: string;
  draftContent: string | null;
  finalContent: string | null;
};

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function computeContentHash(content: string): string {
  return sha256(content);
}

export function computeTargetHash(target: PublicationTarget): string {
  return sha256(JSON.stringify({
    publishTarget: target.publishTarget,
    targetCommentIndex: target.targetCommentIndex,
    targetCommentStrategy: target.targetCommentStrategy,
    targetPlatformReplyId: target.targetPlatformReplyId,
    targetCommentContentHash: target.targetCommentContentHash
  }));
}

export function buildPublicationBinding(task: TaskPublicationFields): PublicationBinding {
  const content = task.finalContent ?? task.draftContent ?? "";
  return {
    taskId: task.id,
    contentHash: computeContentHash(content),
    targetHash: computeTargetHash(task)
  };
}

export function computePublishIdempotencyKey(
  binding: PublicationBinding,
  authorizationId: string
): string {
  return sha256(
    `${binding.taskId}:${binding.contentHash}:${binding.targetHash}:${authorizationId}`
  );
}

export function issuePublishAuthorization(
  binding: PublicationBinding,
  options: {
    now?: Date;
    expiresInMinutes?: number;
    kind?: IssuedPublishAuthorization["kind"];
    maxUses?: number;
  } = {}
): IssuedPublishAuthorization {
  if (!binding.taskId || !binding.contentHash || !binding.targetHash) {
    throw new Error("发布授权缺少任务、正文或目标绑定。");
  }
  const now = options.now ?? new Date();
  const expiresInMinutes = Math.max(1, Math.min(24 * 60, Math.floor(options.expiresInMinutes ?? 30)));
  return {
    id: randomUUID(),
    taskId: binding.taskId,
    kind: options.kind ?? "single",
    status: "active",
    contentHash: binding.contentHash,
    targetHash: binding.targetHash,
    expiresAt: binding.expiresAt ?? new Date(now.getTime() + expiresInMinutes * 60_000),
    maxUses: Math.max(1, Math.floor(options.maxUses ?? 1)),
    usedCount: 0,
    authorizedAt: now
  };
}

export function validatePublishAuthorization(
  authorization: AuthorizationLike,
  binding: PublicationBinding,
  now = new Date()
): AuthorizationValidation {
  if (authorization.status && authorization.status !== "active") {
    return { valid: false, reason: "发布授权已失效或已被使用。" };
  }
  if (authorization.revokedAt) {
    return { valid: false, reason: "发布授权已撤销。" };
  }
  if (authorization.taskId !== binding.taskId) {
    return { valid: false, reason: "发布授权不属于当前任务。" };
  }
  if (authorization.contentHash !== binding.contentHash) {
    return { valid: false, reason: "回复正文已变化，请重新审阅并授权。" };
  }
  if (authorization.targetHash !== binding.targetHash) {
    return { valid: false, reason: "发布目标已变化，请重新审阅并授权。" };
  }
  const expiresAt = authorization.expiresAt instanceof Date
    ? authorization.expiresAt
    : new Date(authorization.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    return { valid: false, reason: "发布授权已过期。" };
  }
  if ((authorization.usedCount ?? 0) >= (authorization.maxUses ?? 1)) {
    return { valid: false, reason: "发布授权次数已用完。" };
  }
  return { valid: true };
}

export function assertValidPublishAuthorization(
  authorization: AuthorizationLike,
  binding: PublicationBinding,
  now = new Date()
): void {
  const validation = validatePublishAuthorization(authorization, binding, now);
  if (!validation.valid) {
    throw new Error(validation.reason ?? "发布授权无效。");
  }
}

export async function authorizeInterventionPublish(input: {
  taskId: string;
  expectedContentHash: string;
  expectedTargetHash: string;
  expiresInMinutes?: number;
  kind?: IssuedPublishAuthorization["kind"];
  metadata?: Record<string, unknown>;
}) {
  const task = await prisma.interventionTask.findUniqueOrThrow({
    where: { id: input.taskId }
  });
  if (normalizeTaskStatus(task.status) !== "ready") {
    throw new Error(`当前任务状态 ${task.status} 不能授权发布；请先完成自动生成和安全校验。`);
  }
  const content = task.finalContent ?? task.draftContent ?? "";
  if (!content.trim()) {
    throw new Error("任务没有可发布的回复正文。");
  }
  if (!task.safetyCheckedAt || !task.contentHash || !task.targetHash) {
    throw new Error("当前回复尚未通过带版本指纹的安全校验，请先重新生成并校验。");
  }
  const reviewedSafetyCheckedAt = task.safetyCheckedAt;
  if (
    task.publishTarget === "comment_reply" &&
    (!task.targetPlatformReplyId || !task.targetCommentContentHash)
  ) {
    throw new Error("目标评论缺少稳定平台标识或内容指纹，请重新生成并审阅。");
  }
  const binding = buildPublicationBinding(task);
  if (task.contentHash !== binding.contentHash) {
    throw new Error("任务正文与最近一次安全校验不一致，请重新运行生成与校验。");
  }
  if (task.targetHash !== binding.targetHash) {
    throw new Error("任务目标与最近一次安全校验不一致，请重新运行生成与校验。");
  }
  if (input.expectedContentHash !== binding.contentHash) {
    throw new Error("页面中的回复版本已经过期，请刷新后重新审阅。");
  }
  if (input.expectedTargetHash !== binding.targetHash) {
    throw new Error("页面中的发布目标已经变化，请刷新后重新审阅。");
  }

  const issued = issuePublishAuthorization(binding, {
    expiresInMinutes: input.expiresInMinutes,
    kind: input.kind
  });
  return prisma.$transaction(async (transaction) => {
    const current = await transaction.interventionTask.findUniqueOrThrow({
      where: { id: task.id }
    });
    const unchanged =
      normalizeTaskStatus(current.status) === "ready" &&
      current.updatedAt.getTime() === task.updatedAt.getTime() &&
      current.contentHash === binding.contentHash &&
      current.targetHash === binding.targetHash &&
      current.safetyCheckedAt?.getTime() === reviewedSafetyCheckedAt.getTime();
    if (!unchanged) {
      throw new Error("任务在授权期间已被重新生成或修改，请刷新后重新审阅。");
    }
    await transaction.publishAuthorization.updateMany({
      where: { taskId: task.id, status: "active" },
      data: { status: "revoked", revokedAt: issued.authorizedAt }
    });
    const authorization = await transaction.publishAuthorization.create({
      data: {
        id: issued.id,
        taskId: issued.taskId,
        kind: issued.kind,
        status: issued.status,
        contentHash: issued.contentHash,
        targetHash: issued.targetHash,
        expiresAt: issued.expiresAt,
        maxUses: issued.maxUses,
        usedCount: issued.usedCount,
        metadataJson: JSON.stringify({
          policyVersion: PUBLISH_POLICY_VERSION,
          source: "human_review",
          ...input.metadata
        }),
        authorizedAt: issued.authorizedAt
      }
    });
    return { task, authorization };
  });
}
