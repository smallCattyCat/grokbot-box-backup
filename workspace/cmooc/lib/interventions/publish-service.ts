import { prisma } from "@/lib/db";
import {
  recordAgentRunBestEffort,
  type AgentRunRecorder
} from "@/lib/agents/agent-run";
import { normalizeTaskStatus } from "@/lib/state-machine";
import {
  buildPublicationBinding,
  computePublishIdempotencyKey,
  validatePublishAuthorization
} from "./publish-policy";

export type PublisherResult =
  | {
    outcome: "published";
    publishedUrl: string;
    evidence: string;
    screenshotPath?: string;
    transport?: string;
  }
  | {
    outcome: "outcome_unknown";
    message: string;
    evidence?: string;
    transport?: string;
  }
  | {
    outcome: "not_attempted";
    message: string;
    evidence?: string;
    transport?: string;
  };

export type PublishServiceResult = {
  status:
    | "authorization_required"
    | "publishing"
    | "published"
    | "failed_retryable"
    | "reconcile_required";
  attemptId?: string;
  taskId: string;
  publishedUrl?: string | null;
  message?: string;
};

export const STALE_PUBLISHING_RECONCILE_AFTER_MS = 5 * 60_000;

export function isStalePublishingForReconciliation(input: {
  taskUpdatedAt: Date;
  attemptStartedAt?: Date | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const cutoff = now.getTime() - STALE_PUBLISHING_RECONCILE_AFTER_MS;
  return input.taskUpdatedAt.getTime() <= cutoff ||
    Boolean(input.attemptStartedAt && input.attemptStartedAt.getTime() <= cutoff);
}

type AuthorizationInput = {
  id?: string;
  taskId: string;
  contentHash: string;
  targetHash: string;
  expiresAt: Date | string;
  status?: string;
  maxUses?: number;
  usedCount?: number;
  revokedAt?: Date | string | null;
};

type PublishInterventionInput = {
  taskId: string;
  sourceCandidateId?: string | null;
  authorization?: AuthorizationInput;
  authorizationSource?: "persisted" | "ephemeral_test";
  // Retained only to prove that the former caller-controlled boolean no longer
  // grants authority. It is deliberately ignored.
  allowRealPublish?: boolean;
  publisher: () => Promise<PublisherResult>;
  transport?: string;
};

const inFlightPublishes = new Map<string, Promise<PublishServiceResult>>();
const PUBLISH_SETTLEMENT_ALREADY_RESOLVED = "PUBLISH_SETTLEMENT_ALREADY_RESOLVED";

function isSettlementAlreadyResolved(error: unknown) {
  return error instanceof Error &&
    error.message === PUBLISH_SETTLEMENT_ALREADY_RESOLVED;
}

async function latestAttemptResult(taskId: string): Promise<PublishServiceResult | null> {
  const [task, attempt] = await Promise.all([
    prisma.interventionTask.findUnique({ where: { id: taskId } }),
    prisma.publishAttempt.findFirst({
      where: { taskId },
      orderBy: { createdAt: "desc" }
    })
  ]);
  if (!task) return null;
  const status = normalizeTaskStatus(task.status);
  if (status === "published") {
    return {
      status: "published",
      taskId,
      attemptId: attempt?.id,
      publishedUrl: task.publishedUrl
    };
  }
  if (status === "reconcile_required") {
    return {
      status: "reconcile_required",
      taskId,
      attemptId: attempt?.id,
      message: task.errorMessage ?? attempt?.message
    };
  }
  if (status === "publishing") {
    return {
      status: "publishing",
      taskId,
      attemptId: attempt?.id
    };
  }
  if (status === "failed_retryable") {
    return {
      status: "failed_retryable",
      taskId,
      attemptId: attempt?.id,
      message: task.errorMessage ?? attempt?.message
    };
  }
  return null;
}

async function runClaimedPublish(input: PublishInterventionInput & {
  binding: ReturnType<typeof buildPublicationBinding>;
  idempotencyKey: string;
  expectedTaskUpdatedAt: Date;
}): Promise<PublishServiceResult> {
  const usesPersistedAuthorization = input.authorizationSource !== "ephemeral_test";
  const persistedAuthorizationId = usesPersistedAuthorization
    ? input.authorization?.id
    : undefined;

  let attempt: Awaited<ReturnType<typeof prisma.publishAttempt.create>>;
  try {
    attempt = await prisma.$transaction(async (transaction) => {
      const claimedAt = new Date();
      if (usesPersistedAuthorization) {
        if (!persistedAuthorizationId) {
          throw new Error("PUBLISH_AUTHORIZATION_CHANGED");
        }
        const currentAuthorization = await transaction.publishAuthorization.findUnique({
          where: { id: persistedAuthorizationId }
        });
        if (
          !currentAuthorization ||
          !validatePublishAuthorization(
            currentAuthorization,
            input.binding,
            claimedAt
          ).valid
        ) {
          throw new Error("PUBLISH_AUTHORIZATION_CHANGED");
        }
        const authorizationClaim = await transaction.publishAuthorization.updateMany({
          where: {
            id: currentAuthorization.id,
            taskId: input.taskId,
            status: "active",
            contentHash: input.binding.contentHash,
            targetHash: input.binding.targetHash,
            usedCount: currentAuthorization.usedCount,
            revokedAt: null,
            expiresAt: currentAuthorization.expiresAt
          },
          data: {
            status: "consumed",
            usedCount: { increment: 1 },
            consumedAt: claimedAt
          }
        });
        if (authorizationClaim.count !== 1) {
          throw new Error("PUBLISH_AUTHORIZATION_CHANGED");
        }
      }
      const claimed = await transaction.interventionTask.updateMany({
        where: {
          id: input.taskId,
          status: "ready",
          updatedAt: input.expectedTaskUpdatedAt,
          contentHash: input.binding.contentHash,
          targetHash: input.binding.targetHash
        },
        data: {
          status: "publishing",
          errorMessage: null
        }
      });
      if (claimed.count !== 1) {
        throw new Error("PUBLISH_ALREADY_CLAIMED");
      }
      return transaction.publishAttempt.create({
        data: {
          taskId: input.taskId,
          authorizationId: persistedAuthorizationId,
          action: "publish",
          status: "publishing",
          message: "已取得唯一发布权，开始调用论坛发布适配器。",
          contentHash: input.binding.contentHash,
          targetHash: input.binding.targetHash,
          idempotencyKey: input.idempotencyKey,
          transport: input.transport,
          startedAt: new Date()
        }
      });
    });
  } catch (error) {
    const existing = await prisma.publishAttempt.findUnique({
      where: { idempotencyKey: input.idempotencyKey }
    });
    if (existing) {
      return (await latestAttemptResult(input.taskId)) ?? {
        status: "publishing",
        taskId: input.taskId,
        attemptId: existing.id
      };
    }
    if (error instanceof Error && error.message === "PUBLISH_ALREADY_CLAIMED") {
      return (await latestAttemptResult(input.taskId)) ?? {
        status: "publishing",
        taskId: input.taskId
      };
    }
    if (error instanceof Error && error.message === "PUBLISH_AUTHORIZATION_CHANGED") {
      return {
        status: "authorization_required",
        taskId: input.taskId,
        message: "发布授权已变化、失效或被其他请求使用，请刷新后重新审阅。"
      };
    }
    throw error;
  }

  try {
    const result = await input.publisher();
    if (result.outcome === "not_attempted") {
      await prisma.$transaction(async (transaction) => {
        const attemptSettled = await transaction.publishAttempt.updateMany({
          where: { id: attempt.id, status: "publishing" },
          data: {
            status: "not_attempted",
            message: result.message,
            evidenceJson: JSON.stringify({ evidence: result.evidence ?? null }),
            transport: result.transport ?? input.transport,
            errorCode: "LOCAL_GATE_CLOSED_BEFORE_REMOTE_CALL",
            finishedAt: new Date()
          }
        });
        if (attemptSettled.count !== 1) {
          throw new Error(PUBLISH_SETTLEMENT_ALREADY_RESOLVED);
        }
        const taskSettled = await transaction.interventionTask.updateMany({
          where: {
            id: input.taskId,
            status: "publishing",
            contentHash: input.binding.contentHash,
            targetHash: input.binding.targetHash
          },
          data: {
            status: "failed_retryable",
            errorMessage: result.message
          }
        });
        if (taskSettled.count !== 1) {
          throw new Error(PUBLISH_SETTLEMENT_ALREADY_RESOLVED);
        }
        if (input.sourceCandidateId) {
          await transaction.autoInterventionCandidate.update({
            where: { id: input.sourceCandidateId },
            data: {
              status: "manual_review",
              errorMessage: result.message
            }
          });
        }
      });
      return {
        status: "failed_retryable",
        taskId: input.taskId,
        attemptId: attempt.id,
        message: result.message
      };
    }
    if (result.outcome === "outcome_unknown") {
      await prisma.$transaction(async (transaction) => {
        const attemptSettled = await transaction.publishAttempt.updateMany({
          where: { id: attempt.id, status: "publishing" },
          data: {
            status: "outcome_unknown",
            message: result.message,
            evidenceJson: JSON.stringify({ evidence: result.evidence ?? null }),
            transport: result.transport ?? input.transport,
            errorCode: "REMOTE_OUTCOME_UNKNOWN",
            finishedAt: new Date()
          }
        });
        if (attemptSettled.count !== 1) {
          throw new Error(PUBLISH_SETTLEMENT_ALREADY_RESOLVED);
        }
        const reconciled = await transaction.interventionTask.updateMany({
          where: {
            id: input.taskId,
            status: "publishing",
            contentHash: input.binding.contentHash,
            targetHash: input.binding.targetHash
          },
          data: {
            status: "reconcile_required",
            errorMessage: result.message
          }
        });
        if (reconciled.count !== 1) {
          throw new Error(PUBLISH_SETTLEMENT_ALREADY_RESOLVED);
        }
        if (input.sourceCandidateId) {
          await transaction.autoInterventionCandidate.update({
            where: { id: input.sourceCandidateId },
            data: {
              status: "manual_review",
              errorMessage: result.message
            }
          });
        }
      });
      return {
        status: "reconcile_required",
        taskId: input.taskId,
        attemptId: attempt.id,
        message: result.message
      };
    }

    await prisma.$transaction(async (transaction) => {
      const attemptSettled = await transaction.publishAttempt.updateMany({
        where: { id: attempt.id, status: "publishing" },
        data: {
          status: "published",
          message: "论坛发布成功并保存了远端证据。",
          remoteUrl: result.publishedUrl,
          screenshotPath: result.screenshotPath,
          evidenceJson: JSON.stringify({ evidence: result.evidence }),
          transport: result.transport ?? input.transport,
          finishedAt: new Date()
        }
      });
      if (attemptSettled.count !== 1) {
        throw new Error(PUBLISH_SETTLEMENT_ALREADY_RESOLVED);
      }
      const published = await transaction.interventionTask.updateMany({
        where: {
          id: input.taskId,
          status: "publishing",
          contentHash: input.binding.contentHash,
          targetHash: input.binding.targetHash
        },
        data: {
          status: "published",
          publishedUrl: result.publishedUrl,
          screenshotPath: result.screenshotPath,
          publishedAt: new Date(),
          errorMessage: null
        }
      });
      if (published.count !== 1) {
        throw new Error(PUBLISH_SETTLEMENT_ALREADY_RESOLVED);
      }
      if (input.sourceCandidateId) {
        await transaction.autoInterventionCandidate.update({
          where: { id: input.sourceCandidateId },
          data: {
            status: "published",
            publishedUrl: result.publishedUrl,
            screenshotPath: result.screenshotPath,
            errorMessage: null
          }
        });
      }
    });
    return {
      status: "published",
      taskId: input.taskId,
      attemptId: attempt.id,
      publishedUrl: result.publishedUrl
    };
  } catch (error) {
    if (isSettlementAlreadyResolved(error)) {
      return (await latestAttemptResult(input.taskId)) ?? {
        status: "reconcile_required",
        taskId: input.taskId,
        attemptId: attempt.id,
        message: "发布结果已由另一项核对操作结算，请刷新查看最新状态。"
      };
    }
    const message = error instanceof Error ? error.message : "论坛发布结果未知。";
    try {
      await prisma.$transaction(async (transaction) => {
        const attemptSettled = await transaction.publishAttempt.updateMany({
          where: { id: attempt.id, status: "publishing" },
          data: {
            status: "outcome_unknown",
            message,
            errorCode: "PUBLISHER_EXCEPTION_AFTER_CLAIM",
            finishedAt: new Date()
          }
        });
        if (attemptSettled.count !== 1) {
          throw new Error(PUBLISH_SETTLEMENT_ALREADY_RESOLVED);
        }
        const taskSettled = await transaction.interventionTask.updateMany({
          where: {
            id: input.taskId,
            status: "publishing",
            contentHash: input.binding.contentHash,
            targetHash: input.binding.targetHash
          },
          data: { status: "reconcile_required", errorMessage: message }
        });
        if (taskSettled.count !== 1) {
          throw new Error(PUBLISH_SETTLEMENT_ALREADY_RESOLVED);
        }
        if (input.sourceCandidateId) {
          await transaction.autoInterventionCandidate.update({
            where: { id: input.sourceCandidateId },
            data: {
              status: "manual_review",
              errorMessage: message
            }
          });
        }
      });
    } catch (settlementError) {
      if (isSettlementAlreadyResolved(settlementError)) {
        return (await latestAttemptResult(input.taskId)) ?? {
          status: "reconcile_required",
          taskId: input.taskId,
          attemptId: attempt.id,
          message: "发布结果已由另一项核对操作结算，请刷新查看最新状态。"
        };
      }
      throw settlementError;
    }
    return {
      status: "reconcile_required",
      taskId: input.taskId,
      attemptId: attempt.id,
      message
    };
  }
}

export async function publishIntervention(
  input: PublishInterventionInput
): Promise<PublishServiceResult> {
  const task = await prisma.interventionTask.findUniqueOrThrow({
    where: { id: input.taskId }
  });
  const current = normalizeTaskStatus(task.status);
  if (current === "published" || current === "reconcile_required" || current === "publishing") {
    return (await latestAttemptResult(task.id)) ?? {
      status: current,
      taskId: task.id
    };
  }
  if (current !== "ready") {
    throw new Error(`当前任务状态 ${current} 不能发布。`);
  }
  if (!input.authorization) {
    return {
      status: "authorization_required",
      taskId: task.id,
      message: "真实发布需要绑定当前正文与目标的服务端授权。"
    };
  }
  if (!input.authorization.id) {
    return {
      status: "authorization_required",
      taskId: task.id,
      message: "发布授权缺少唯一编号，请刷新后重新审阅。"
    };
  }

  const binding = buildPublicationBinding(task);
  const authorizationSource = input.authorizationSource ?? "persisted";
  const persistedAuthorization = authorizationSource === "persisted" && input.authorization.id
    ? await prisma.publishAuthorization.findUnique({
      where: { id: input.authorization.id }
    })
    : null;
  if (authorizationSource === "persisted" && !persistedAuthorization) {
    return {
      status: "authorization_required",
      taskId: task.id,
      message: "发布授权不存在或已经失效，请刷新后重新审阅。"
    };
  }
  const authoritativeAuthorization = persistedAuthorization ?? input.authorization;
  const validation = validatePublishAuthorization(authoritativeAuthorization, binding);
  if (!validation.valid) {
    return {
      status: "authorization_required",
      taskId: task.id,
      message: validation.reason
    };
  }
  const idempotencyKey = computePublishIdempotencyKey(
    binding,
    input.authorization.id
  );
  const existingInFlight = inFlightPublishes.get(idempotencyKey);
  if (existingInFlight) return existingInFlight;

  const promise = runClaimedPublish({
    ...input,
    sourceCandidateId: task.sourceCandidateId,
    authorization: authoritativeAuthorization,
    authorizationSource,
    binding,
    idempotencyKey,
    expectedTaskUpdatedAt: task.updatedAt
  });
  inFlightPublishes.set(idempotencyKey, promise);
  try {
    return await promise;
  } finally {
    if (inFlightPublishes.get(idempotencyKey) === promise) {
      inFlightPublishes.delete(idempotencyKey);
    }
  }
}

export async function reconcilePublishOutcome(input: {
  taskId: string;
  resolution: "published" | "not_published";
  evidenceNote: string;
  publishedUrl?: string;
  confirmed: boolean;
}, dependencies: {
  recordAgentRun?: AgentRunRecorder;
} = {}) {
  if (input.confirmed !== true) {
    throw new Error("人工核对必须明确确认核对结果。");
  }
  const evidenceNote = input.evidenceNote.trim();
  if (evidenceNote.length < 6) {
    throw new Error("请填写论坛核对依据，例如看到的回复、评论数量或未发现回复。");
  }
  const task = await prisma.interventionTask.findUniqueOrThrow({
    where: { id: input.taskId },
    include: { post: true }
  });
  const currentStatus = normalizeTaskStatus(task.status);
  if (currentStatus !== "reconcile_required" && currentStatus !== "publishing") {
    throw new Error(`当前任务状态 ${task.status} 不需要人工核对。`);
  }
  const attempt = await prisma.publishAttempt.findFirst({
    where: {
      taskId: task.id,
      ...(currentStatus === "publishing" ? { status: "publishing" } : {})
    },
    orderBy: { createdAt: "desc" }
  });
  const resolvedAt = new Date();
  if (
    currentStatus === "publishing" &&
    attempt?.idempotencyKey &&
    inFlightPublishes.has(attempt.idempotencyKey)
  ) {
    throw new Error("发布进程仍在本机执行；在它结束前不能人工判定未发布。");
  }
  if (
    currentStatus === "publishing" &&
    !isStalePublishingForReconciliation({
      taskUpdatedAt: task.updatedAt,
      attemptStartedAt: attempt?.startedAt ?? attempt?.createdAt,
      now: resolvedAt
    })
  ) {
    throw new Error("发布仍在执行或尚未超过 5 分钟；请稍后刷新，系统不会自动重发。");
  }
  const resolvedStatus = input.resolution === "published"
    ? "published"
    : "failed_retryable";
  const publishedUrl = input.publishedUrl?.trim()
    || task.publishedUrl
    || (task.post.url.startsWith("http") ? task.post.url : null);

  const resolved = await prisma.$transaction(async (transaction) => {
    const changed = await transaction.interventionTask.updateMany({
      where: {
        id: task.id,
        status: task.status,
        updatedAt: task.updatedAt
      },
      data: input.resolution === "published"
        ? {
          status: resolvedStatus,
          publishedUrl,
          publishedAt: resolvedAt,
          errorMessage: null
        }
        : {
          status: resolvedStatus,
          errorMessage: `人工核对确认远端未发布：${evidenceNote}`
        }
    });
    if (changed.count !== 1) {
      throw new Error("任务核对状态已被其他操作更新，请刷新后重试。");
    }
    await transaction.publishAuthorization.updateMany({
      where: { taskId: task.id, status: "active" },
      data: { status: "revoked", revokedAt: resolvedAt }
    });
    if (attempt) {
      await transaction.publishAttempt.update({
        where: { id: attempt.id },
        data: {
          status: input.resolution === "published"
            ? "published_reconciled"
            : "confirmed_not_published",
          message: evidenceNote,
          remoteUrl: input.resolution === "published" ? publishedUrl : attempt.remoteUrl,
          evidenceJson: JSON.stringify({
            previousEvidence: attempt.evidenceJson,
            manualReconciliation: {
              resolution: input.resolution,
              evidenceNote,
              resolvedAt: resolvedAt.toISOString()
            }
          }),
          errorCode: input.resolution === "published"
            ? null
            : "REMOTE_CONFIRMED_NOT_PUBLISHED",
          finishedAt: resolvedAt
        }
      });
    }
    if (task.sourceCandidateId) {
      await transaction.autoInterventionCandidate.update({
        where: { id: task.sourceCandidateId },
        data: input.resolution === "published"
          ? {
            status: "published",
            publishedUrl,
            errorMessage: null
          }
          : {
            status: "manual_review",
            errorMessage: `人工核对确认远端未发布：${evidenceNote}`
          }
      });
    }
    return transaction.interventionTask.findUniqueOrThrow({
      where: { id: task.id }
    });
  });

  await recordAgentRunBestEffort(
    {
      taskId: task.id,
      postId: task.postId,
      agentName: "publisher-reconciliation-agent",
      input: {
        resolution: input.resolution,
        confirmed: true,
        attemptId: attempt?.id ?? null
      },
      output: {
        status: resolved.status,
        evidenceNote,
        publishedUrl: resolved.publishedUrl,
        resolvedAt: resolvedAt.toISOString()
      }
    },
    { record: dependencies.recordAgentRun }
  );
  return resolved;
}
