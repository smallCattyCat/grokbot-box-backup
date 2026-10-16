import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { InterventionTask, PrismaClient } from "@prisma/client";

process.env.DATABASE_URL = "file:./test.db";
process.env.LLM_MODE = "mock";

const publishPolicyModulePath = "../../lib/interventions/publish-policy";
const interventionServiceModulePath = "../../lib/interventions/intervention-service";
const publishServiceModulePath = "../../lib/interventions/publish-service";
const workflowModulePath = "../../lib/workflow";

type UnifiedTaskStatus =
  | "proposed"
  | "review_required"
  | "ready"
  | "publishing"
  | "published"
  | "failed_retryable"
  | "reconcile_required"
  | "skipped";

type PublishBinding = {
  taskId: string;
  contentHash: string;
  targetHash: string;
  expiresAt?: Date;
};

type PublishAuthorization = PublishBinding & Record<string, unknown>;

type PublishPolicyModule = {
  issuePublishAuthorization: (binding: PublishBinding) => PublishAuthorization;
  authorizeInterventionPublish: (input: {
    taskId: string;
    expectedContentHash: string;
    expectedTargetHash: string;
  }) => Promise<{ authorization: PublishAuthorization & { id: string } }>;
};

type InterventionServiceModule = {
  transitionInterventionTask: (input: {
    taskId: string;
    toStatus: UnifiedTaskStatus;
  }) => Promise<InterventionTask>;
  promoteAutoCandidateToInterventionTask: (input: {
    candidateId: string;
  }) => Promise<{ task: InterventionTask; created: boolean }>;
  skipAutoInterventionCandidate: (input: {
    candidateId: string;
    reason?: string;
  }) => Promise<{ id: string; status: string }>;
};

type PublisherResult =
  | {
      outcome: "published";
      publishedUrl: string;
      evidence: string;
    }
  | {
      outcome: "outcome_unknown";
      message: string;
    }
  | {
      outcome: "not_attempted";
      message: string;
      evidence?: string;
    };

type PublishServiceResult = {
  status: UnifiedTaskStatus | "authorization_required";
  attemptId?: string;
};

type PublishServiceModule = {
  STALE_PUBLISHING_RECONCILE_AFTER_MS: number;
  publishIntervention: (input: {
    taskId: string;
    authorization?: PublishAuthorization;
    authorizationSource?: "persisted" | "ephemeral_test";
    allowRealPublish?: boolean;
    publisher: () => Promise<PublisherResult>;
  }) => Promise<PublishServiceResult>;
  reconcilePublishOutcome: (input: {
    taskId: string;
    resolution: "published" | "not_published";
    evidenceNote: string;
    confirmed: boolean;
  }, dependencies?: {
    recordAgentRun?: () => Promise<unknown>;
  }) => Promise<InterventionTask>;
};

type WorkflowModule = {
  commitAnalyzedInterventionTask: (input: {
    taskId: string;
    expectedStatus: string;
    expectedUpdatedAt: Date;
    interventionType: string;
    publishTarget: string;
    targetCommentStrategy: string | null;
    targetCommentIndex: number | null;
    priorityScore: number;
    targetUserId: string;
  }) => Promise<InterventionTask>;
};

const openTaskStatuses = [
  "proposed",
  "review_required",
  "ready",
  "publishing",
  "failed_retryable",
  "reconcile_required"
] as const;

async function loadKernelModule<T>(modulePath: string, expectedFile: string): Promise<T> {
  try {
    return (await import(modulePath)) as T;
  } catch (error) {
    assert.fail(
      `缺少统一干预内核 ${expectedFile}：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bindingForTask(task: Pick<
  InterventionTask,
  "id" | "finalContent" | "draftContent" | "publishTarget" | "targetCommentIndex" | "targetCommentStrategy" |
  "targetPlatformReplyId" | "targetCommentContentHash"
>): PublishBinding {
  const content = task.finalContent ?? task.draftContent ?? "";
  return {
    taskId: task.id,
    contentHash: sha256(content),
    targetHash: sha256(JSON.stringify({
      publishTarget: task.publishTarget,
      targetCommentIndex: task.targetCommentIndex,
      targetCommentStrategy: task.targetCommentStrategy,
      targetPlatformReplyId: task.targetPlatformReplyId,
      targetCommentContentHash: task.targetCommentContentHash
    })),
    expiresAt: new Date(Date.now() + 60_000)
  };
}

async function createKernelTask(
  prisma: PrismaClient,
  status: UnifiedTaskStatus,
  suffix: string
): Promise<InterventionTask> {
  const post = await prisma.forumPost.findFirstOrThrow({
    where: {
      tasks: {
        none: {
          status: { in: [...openTaskStatuses] }
        }
      }
    },
    orderBy: { createdAt: "asc" }
  });
  const content = `统一发布内核隔离测试-${suffix}`;
  return prisma.interventionTask.create({
    data: {
      courseId: post.courseId,
      postId: post.id,
      targetUserId: post.authorId,
      interventionType: "cognitive_conflict",
      publishTarget: "post_comment",
      targetCommentStrategy: null,
      targetCommentIndex: null,
      targetPlatformReplyId: null,
      targetCommentContentHash: null,
      priorityScore: 99,
      status,
      draftContent: content,
      finalContent: content,
      safetyRisk: 0,
      safetyResult: "allow"
    }
  });
}

async function assertPublishDeniedWithoutCallingAdapter(
  promise: Promise<PublishServiceResult>,
  getPublisherCalls: () => number
): Promise<void> {
  const outcome = await promise.then(
    (value) => ({ kind: "resolved" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error })
  );

  if (outcome.kind === "resolved") {
    assert.equal(outcome.value.status, "authorization_required");
  } else {
    assert.match(
      outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      /authorization|授权/
    );
  }
  assert.equal(getPublisherCalls(), 0, "授权失败时不得调用真实发布适配器");
}

test("正式迁移可从空库建立完整 schema 并重复装载 fixture", async () => {
  const { prisma } = await import("../../lib/db");

  try {
    const counts = await Promise.all([
      prisma.forumUser.count(),
      prisma.forumPost.count(),
      prisma.forumReply.count(),
      prisma.companionProfile.count(),
      prisma.interventionTask.count(),
      prisma.forumSetting.count()
    ]);

    assert.deepEqual(counts, [9, 12, 30, 4, 5, 1]);

    const integrity = await prisma.$queryRawUnsafe<Array<{ integrity_check: string }>>("PRAGMA integrity_check");
    const foreignKeyViolations = await prisma.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check");
    const interventionTaskForeignKeys = await prisma.$queryRawUnsafe<
      Array<{
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
      }>
    >('PRAGMA foreign_key_list("InterventionTask")');
    const publishLogForeignKeys = await prisma.$queryRawUnsafe<
      Array<{
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
      }>
    >('PRAGMA foreign_key_list("PublishLog")');
    const publishLogColumns = await prisma.$queryRawUnsafe<
      Array<{ name: string; notnull: bigint; dflt_value: string | null }>
    >('PRAGMA table_info("PublishLog")');
    const migrations = await prisma.$queryRawUnsafe<
      Array<{ migration_name: string }>
    >(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name'
    );

    assert.deepEqual(integrity, [{ integrity_check: "ok" }]);
    assert.deepEqual(foreignKeyViolations, []);
    const sourceCandidateForeignKey = interventionTaskForeignKeys.find(
      (foreignKey) => foreignKey.from === "sourceCandidateId"
    );
    assert.deepEqual(
      sourceCandidateForeignKey && {
        table: sourceCandidateForeignKey.table,
        from: sourceCandidateForeignKey.from,
        to: sourceCandidateForeignKey.to,
        on_update: sourceCandidateForeignKey.on_update,
        on_delete: sourceCandidateForeignKey.on_delete
      },
      {
        table: "AutoInterventionCandidate",
        from: "sourceCandidateId",
        to: "id",
        on_update: "CASCADE",
        on_delete: "SET NULL"
      }
    );
    assert.equal(
      publishLogForeignKeys.find(
        (foreignKey) => foreignKey.from === "taskId"
      )?.on_delete,
      "RESTRICT",
      "发布证据必须阻止删除父任务，不能随任务级联消失"
    );
    assert.equal(
      publishLogForeignKeys.find(
        (foreignKey) => foreignKey.from === "taskId"
      )?.on_update,
      "CASCADE"
    );
    const authorizationForeignKey = publishLogForeignKeys.find(
      (foreignKey) => foreignKey.from === "authorizationId"
    );
    assert.deepEqual(
      authorizationForeignKey && {
        table: authorizationForeignKey.table,
        from: authorizationForeignKey.from,
        to: authorizationForeignKey.to,
        on_update: authorizationForeignKey.on_update,
        on_delete: authorizationForeignKey.on_delete
      },
      {
        table: "PublishAuthorization",
        from: "authorizationId",
        to: "id",
        on_update: "CASCADE",
        on_delete: "SET NULL"
      }
    );
    assert.equal(
      publishLogColumns.find((column) => column.name === "action")
        ?.dflt_value,
      "'publish'"
    );
    assert.ok(
      migrations.some(
        (migration) =>
          migration.migration_name ===
          "20260730000000_add_autonomy_runtime_v1"
      ),
      "自治运行时迁移必须被正式部署"
    );
    assert.ok(migrations.length >= 9);
  } finally {
    await prisma.$disconnect();
  }
});

test("统一任务状态机禁止 published 与 skipped 终态复活", async () => {
  const { prisma } = await import("../../lib/db");
  const service = await loadKernelModule<InterventionServiceModule>(
    interventionServiceModulePath,
    "lib/interventions/intervention-service.ts"
  );

  try {
    for (const terminalStatus of ["published", "skipped"] as const) {
      const task = await createKernelTask(prisma, terminalStatus, `terminal-${terminalStatus}-${Date.now()}`);
      await assert.rejects(
        () => service.transitionInterventionTask({
          taskId: task.id,
          toStatus: "review_required"
        }),
        /终态|terminal|不可|非法/
      );
      const persisted = await prisma.interventionTask.findUniqueOrThrow({
        where: { id: task.id }
      });
      assert.equal(persisted.status, terminalStatus);
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("慢分析结果只能提交到原任务版本，不能覆盖 publishing 或 published", async () => {
  const { prisma } = await import("../../lib/db");
  const workflow = await loadKernelModule<WorkflowModule>(
    workflowModulePath,
    "lib/workflow.ts"
  );

  try {
    let resettable = await createKernelTask(prisma, "ready", `analysis-reset-${Date.now()}`);
    resettable = await prisma.interventionTask.update({
      where: { id: resettable.id },
      data: {
        publishTarget: "comment_reply",
        targetCommentStrategy: "first",
        targetCommentIndex: 0,
        targetPlatformReplyId: "reviewed-comment-id",
        targetCommentContentHash: sha256("reviewed comment"),
        targetCommentPreview: "reviewed comment",
        contentHash: sha256(resettable.finalContent ?? ""),
        targetHash: sha256("reviewed-target"),
        safetyCheckedAt: new Date()
      }
    });
    const activeAuthorization = await prisma.publishAuthorization.create({
      data: {
        taskId: resettable.id,
        status: "active",
        contentHash: resettable.contentHash!,
        targetHash: resettable.targetHash!,
        expiresAt: new Date(Date.now() + 60_000)
      }
    });
    const reset = await workflow.commitAnalyzedInterventionTask({
      taskId: resettable.id,
      expectedStatus: resettable.status,
      expectedUpdatedAt: resettable.updatedAt,
      interventionType: "cognitive_conflict",
      publishTarget: "post_comment",
      targetCommentStrategy: null,
      targetCommentIndex: null,
      priorityScore: 88,
      targetUserId: resettable.targetUserId
    });
    assert.equal(reset.status, "proposed");
    assert.equal(reset.targetPlatformReplyId, null);
    assert.equal(reset.targetCommentContentHash, null);
    assert.equal(reset.targetCommentPreview, null);
    assert.equal(reset.contentHash, null);
    assert.equal(reset.targetHash, null);
    assert.equal(reset.safetyCheckedAt, null);
    assert.equal(
      (await prisma.publishAuthorization.findUniqueOrThrow({
        where: { id: activeAuthorization.id }
      })).status,
      "revoked"
    );
    await prisma.interventionTask.update({
      where: { id: reset.id },
      data: { status: "skipped" }
    });

    const stale = await createKernelTask(prisma, "ready", `analysis-cas-${Date.now()}`);
    const staleCommit = {
      taskId: stale.id,
      expectedStatus: stale.status,
      expectedUpdatedAt: stale.updatedAt,
      interventionType: "emotional_support",
      publishTarget: "post_comment",
      targetCommentStrategy: null,
      targetCommentIndex: null,
      priorityScore: 1,
      targetUserId: stale.targetUserId
    };
    await prisma.interventionTask.update({
      where: { id: stale.id },
      data: { status: "publishing" }
    });
    const publishing = await workflow.commitAnalyzedInterventionTask(staleCommit);
    assert.equal(publishing.status, "publishing");
    assert.equal(publishing.priorityScore, stale.priorityScore);

    await prisma.interventionTask.update({
      where: { id: stale.id },
      data: { status: "published", publishedAt: new Date() }
    });
    const published = await workflow.commitAnalyzedInterventionTask(staleCommit);
    assert.equal(published.status, "published");
    assert.equal(published.priorityScore, stale.priorityScore);
  } finally {
    await prisma.$disconnect();
  }
});

test("allowRealPublish 布尔值本身不能取得发布授权", async () => {
  const { prisma } = await import("../../lib/db");
  const service = await loadKernelModule<PublishServiceModule>(
    publishServiceModulePath,
    "lib/interventions/publish-service.ts"
  );
  try {
    const task = await createKernelTask(prisma, "ready", `boolean-gate-${Date.now()}`);
    let publisherCalls = 0;
    await assertPublishDeniedWithoutCallingAdapter(
      service.publishIntervention({
        taskId: task.id,
        allowRealPublish: true,
        publisher: async () => {
          publisherCalls += 1;
          return {
            outcome: "published",
            publishedUrl: "mock://must-not-publish",
            evidence: "forbidden-adapter-call"
          };
        }
      }),
      () => publisherCalls
    );

    const persisted = await prisma.interventionTask.findUniqueOrThrow({
      where: { id: task.id }
    });
    assert.equal(persisted.status, "ready");
  } finally {
    await prisma.$disconnect();
  }
});

test("任务正文或目标变化后既有发布授权立即失效", async () => {
  const { prisma } = await import("../../lib/db");
  const policy = await loadKernelModule<PublishPolicyModule>(
    publishPolicyModulePath,
    "lib/interventions/publish-policy.ts"
  );
  const service = await loadKernelModule<PublishServiceModule>(
    publishServiceModulePath,
    "lib/interventions/publish-service.ts"
  );
  try {
    for (const changedField of ["content", "target"] as const) {
      const task = await createKernelTask(prisma, "ready", `${changedField}-change-${Date.now()}`);
      const authorization = policy.issuePublishAuthorization(bindingForTask(task));
      if (changedField === "content") {
        await prisma.interventionTask.update({
          where: { id: task.id },
          data: { finalContent: `${task.finalContent}-已修改` }
        });
      } else {
        await prisma.interventionTask.update({
          where: { id: task.id },
          data: {
            publishTarget: "comment_reply",
            targetCommentIndex: 0,
            targetCommentStrategy: "first"
          }
        });
      }

      let publisherCalls = 0;
      await assertPublishDeniedWithoutCallingAdapter(
        service.publishIntervention({
          taskId: task.id,
          authorization,
          authorizationSource: "ephemeral_test",
          publisher: async () => {
            publisherCalls += 1;
            return {
              outcome: "published",
              publishedUrl: "mock://stale-authorization",
              evidence: "forbidden-stale-authorization-call"
            };
          }
        }),
        () => publisherCalls
      );
      const persisted = await prisma.interventionTask.findUniqueOrThrow({
        where: { id: task.id }
      });
      assert.notEqual(persisted.status, "publishing");
      assert.notEqual(persisted.status, "published");
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("并发发布对同一任务与授权最多调用一次发布适配器", async () => {
  const { prisma } = await import("../../lib/db");
  const policy = await loadKernelModule<PublishPolicyModule>(
    publishPolicyModulePath,
    "lib/interventions/publish-policy.ts"
  );
  const service = await loadKernelModule<PublishServiceModule>(
    publishServiceModulePath,
    "lib/interventions/publish-service.ts"
  );

  try {
    let task = await createKernelTask(prisma, "ready", `concurrency-${Date.now()}`);
    const binding = bindingForTask(task);
    task = await prisma.interventionTask.update({
      where: { id: task.id },
      data: {
        contentHash: binding.contentHash,
        targetHash: binding.targetHash,
        safetyCheckedAt: new Date()
      }
    });
    const authorization = policy.issuePublishAuthorization(binding);
    let publisherCalls = 0;
    const publisher = async (): Promise<PublisherResult> => {
      publisherCalls += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      return {
        outcome: "published",
        publishedUrl: "mock://published-once",
        evidence: "mock-idempotency-evidence"
      };
    };

    const results = await Promise.allSettled([
      service.publishIntervention({
        taskId: task.id,
        authorization,
        authorizationSource: "ephemeral_test",
        publisher
      }),
      service.publishIntervention({
        taskId: task.id,
        authorization,
        authorizationSource: "ephemeral_test",
        publisher
      })
    ]);

    assert.equal(publisherCalls, 1, "并发请求不得产生两个远端副作用");
    assert.ok(
      results.some((result) => result.status === "fulfilled" && result.value.status === "published"),
      "至少一个调用应取得已发布结果"
    );
    const fulfilledAttemptIds = results.flatMap((result) =>
      result.status === "fulfilled" && result.value.attemptId ? [result.value.attemptId] : []
    );
    assert.ok(new Set(fulfilledAttemptIds).size <= 1, "重复调用若返回结果，必须指向同一发布尝试");
    const persisted = await prisma.interventionTask.findUniqueOrThrow({
      where: { id: task.id }
    });
    assert.equal(persisted.status, "published");
  } finally {
    await prisma.$disconnect();
  }
});

test("本机发布适配器仍在执行时不能用超时核对覆盖结果", async () => {
  const { prisma } = await import("../../lib/db");
  const policy = await loadKernelModule<PublishPolicyModule>(
    publishPolicyModulePath,
    "lib/interventions/publish-policy.ts"
  );
  const service = await loadKernelModule<PublishServiceModule>(
    publishServiceModulePath,
    "lib/interventions/publish-service.ts"
  );

  let releasePublisher: (() => void) | undefined;
  let publishingPromise: Promise<PublishServiceResult> | undefined;
  try {
    let task = await createKernelTask(prisma, "ready", `in-flight-${Date.now()}`);
    const binding = bindingForTask(task);
    task = await prisma.interventionTask.update({
      where: { id: task.id },
      data: {
        contentHash: binding.contentHash,
        targetHash: binding.targetHash,
        safetyCheckedAt: new Date()
      }
    });
    const authorization = policy.issuePublishAuthorization(binding);
    let markPublisherEntered: (() => void) | undefined;
    const publisherEntered = new Promise<void>((resolve) => {
      markPublisherEntered = resolve;
    });
    const publisherGate = new Promise<void>((resolve) => {
      releasePublisher = resolve;
    });

    publishingPromise = service.publishIntervention({
      taskId: task.id,
      authorization,
      authorizationSource: "ephemeral_test",
      publisher: async () => {
        markPublisherEntered?.();
        await publisherGate;
        return {
          outcome: "published",
          publishedUrl: "mock://published-after-in-flight-guard",
          evidence: "deferred-publisher-completed"
        };
      }
    });
    await publisherEntered;

    const attempt = await prisma.publishAttempt.findFirstOrThrow({
      where: { taskId: task.id, status: "publishing" }
    });
    const staleAt = new Date(
      Date.now() - service.STALE_PUBLISHING_RECONCILE_AFTER_MS - 1_000
    );
    await prisma.interventionTask.update({
      where: { id: task.id },
      data: { updatedAt: staleAt }
    });
    await prisma.publishAttempt.update({
      where: { id: attempt.id },
      data: { startedAt: staleAt }
    });

    await assert.rejects(
      () => service.reconcilePublishOutcome({
        taskId: task.id,
        resolution: "not_published",
        evidenceNote: "人为改旧时间但本机调用仍未返回。",
        confirmed: true
      }),
      /仍在本机执行/
    );

    assert.ok(releasePublisher);
    releasePublisher();
    releasePublisher = undefined;
    assert.equal((await publishingPromise).status, "published");
    publishingPromise = undefined;
    assert.equal(
      (await prisma.interventionTask.findUniqueOrThrow({
        where: { id: task.id }
      })).status,
      "published"
    );
  } finally {
    releasePublisher?.();
    await publishingPromise?.catch(() => undefined);
    await prisma.$disconnect();
  }
});

test("远端调用前本地闸门关闭时明确记为未尝试且允许重新审阅", async () => {
  const { prisma } = await import("../../lib/db");
  const policy = await loadKernelModule<PublishPolicyModule>(
    publishPolicyModulePath,
    "lib/interventions/publish-policy.ts"
  );
  const service = await loadKernelModule<PublishServiceModule>(
    publishServiceModulePath,
    "lib/interventions/publish-service.ts"
  );

  try {
    let task = await createKernelTask(prisma, "ready", `not-attempted-${Date.now()}`);
    const binding = bindingForTask(task);
    task = await prisma.interventionTask.update({
      where: { id: task.id },
      data: {
        contentHash: binding.contentHash,
        targetHash: binding.targetHash,
        safetyCheckedAt: new Date()
      }
    });
    const authorization = policy.issuePublishAuthorization(binding);
    let publisherCalls = 0;
    const result = await service.publishIntervention({
      taskId: task.id,
      authorization,
      authorizationSource: "ephemeral_test",
      publisher: async () => {
        publisherCalls += 1;
        return {
          outcome: "not_attempted",
          message: "真实发布设置在远端调用前发生变化。",
          evidence: "settings-version-changed"
        };
      }
    });

    assert.equal(publisherCalls, 1);
    assert.equal(result.status, "failed_retryable");
    assert.equal(
      (await prisma.interventionTask.findUniqueOrThrow({ where: { id: task.id } })).status,
      "failed_retryable"
    );
    const attempt = await prisma.publishAttempt.findFirstOrThrow({
      where: { taskId: task.id },
      orderBy: { createdAt: "desc" }
    });
    assert.equal(attempt.status, "not_attempted");
    assert.equal(attempt.errorCode, "LOCAL_GATE_CLOSED_BEFORE_REMOTE_CALL");
  } finally {
    await prisma.$disconnect();
  }
});

test("远端结果不确定时进入 reconcile_required 且不得盲目重试", async () => {
  const { prisma } = await import("../../lib/db");
  const policy = await loadKernelModule<PublishPolicyModule>(
    publishPolicyModulePath,
    "lib/interventions/publish-policy.ts"
  );
  const service = await loadKernelModule<PublishServiceModule>(
    publishServiceModulePath,
    "lib/interventions/publish-service.ts"
  );
  const interventionService = await loadKernelModule<InterventionServiceModule>(
    interventionServiceModulePath,
    "lib/interventions/intervention-service.ts"
  );

  try {
    let task = await createKernelTask(prisma, "ready", `reconcile-${Date.now()}`);
    const binding = bindingForTask(task);
    task = await prisma.interventionTask.update({
      where: { id: task.id },
      data: {
        contentHash: binding.contentHash,
        targetHash: binding.targetHash,
        safetyCheckedAt: new Date()
      }
    });
    const { authorization } = await policy.authorizeInterventionPublish({
      taskId: task.id,
      expectedContentHash: binding.contentHash,
      expectedTargetHash: binding.targetHash
    });
    let publisherCalls = 0;
    const publisher = async (): Promise<PublisherResult> => {
      publisherCalls += 1;
      return {
        outcome: "outcome_unknown",
        message: "mock transport timed out after remote submission"
      };
    };

    const result = await service.publishIntervention({
      taskId: task.id,
      authorization,
      publisher
    });
    assert.equal(result.status, "reconcile_required");
    assert.equal(
      (await prisma.interventionTask.findUniqueOrThrow({ where: { id: task.id } })).status,
      "reconcile_required"
    );
    assert.equal(
      (await prisma.publishAuthorization.findUniqueOrThrow({
        where: { id: authorization.id }
      })).status,
      "consumed",
      "一旦取得唯一发布权，一次性授权就必须立即消耗"
    );

    await service.publishIntervention({
      taskId: task.id,
      authorization,
      publisher
    }).catch(() => undefined);
    assert.equal(publisherCalls, 1, "reconcile_required 任务必须先核对远端状态，不能直接重发");

    let reconciliationLogCalls = 0;
    const reconciled = await service.reconcilePublishOutcome(
      {
        taskId: task.id,
        resolution: "not_published",
        evidenceNote: "人工检查目标帖子评论列表，未发现该回复。",
        confirmed: true
      },
      {
        recordAgentRun: async () => {
          reconciliationLogCalls += 1;
          throw new Error("simulated reconciliation log failure");
        }
      }
    );
    assert.equal(reconciled.status, "failed_retryable");
    assert.equal(reconciliationLogCalls, 1);
    assert.equal(
      (await prisma.publishAttempt.findFirstOrThrow({
        where: { taskId: task.id },
        orderBy: { createdAt: "desc" }
      })).status,
      "confirmed_not_published"
    );

    await interventionService.transitionInterventionTask({
      taskId: task.id,
      toStatus: "ready"
    });
    const { authorization: retryAuthorization } =
      await policy.authorizeInterventionPublish({
        taskId: task.id,
        expectedContentHash: binding.contentHash,
        expectedTargetHash: binding.targetHash
      });
    const retryResult = await service.publishIntervention({
      taskId: task.id,
      authorization: retryAuthorization,
      publisher: async () => {
        publisherCalls += 1;
        return {
          outcome: "published",
          publishedUrl: "mock://published-after-confirmed-retry",
          evidence: "second-human-authorization"
        };
      }
    });
    assert.equal(retryResult.status, "published");
    assert.equal(publisherCalls, 2, "新的人审授权必须允许同一正文在确认未发布后重试一次");
    assert.equal(
      await prisma.publishAttempt.count({ where: { taskId: task.id } }),
      2,
      "重试应创建新的发布尝试，而不是复用旧的未知结果"
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("只有超时的 publishing 任务可以进入人工核对", async () => {
  const { prisma } = await import("../../lib/db");
  const service = await loadKernelModule<PublishServiceModule>(
    publishServiceModulePath,
    "lib/interventions/publish-service.ts"
  );

  try {
    const task = await createKernelTask(prisma, "publishing", `stale-publishing-${Date.now()}`);
    const attempt = await prisma.publishAttempt.create({
      data: {
        taskId: task.id,
        action: "publish",
        status: "publishing",
        message: "隔离测试中的发布占位。",
        startedAt: new Date()
      }
    });

    await assert.rejects(
      () => service.reconcilePublishOutcome({
        taskId: task.id,
        resolution: "not_published",
        evidenceNote: "刚开始发布，尚不能人工判定。",
        confirmed: true
      }),
      /仍在执行|尚未超过 5 分钟/
    );
    assert.equal(
      (await prisma.interventionTask.findUniqueOrThrow({ where: { id: task.id } })).status,
      "publishing"
    );

    const staleStartedAt = new Date(
      Date.now() - service.STALE_PUBLISHING_RECONCILE_AFTER_MS - 1_000
    );
    await prisma.publishAttempt.update({
      where: { id: attempt.id },
      data: { startedAt: staleStartedAt }
    });

    const reconciled = await service.reconcilePublishOutcome({
      taskId: task.id,
      resolution: "not_published",
      evidenceNote: "等待超过五分钟并检查论坛，确认没有该回复。",
      confirmed: true
    });
    assert.equal(reconciled.status, "failed_retryable");
    assert.equal(
      (await prisma.publishAttempt.findUniqueOrThrow({
        where: { id: attempt.id }
      })).status,
      "confirmed_not_published"
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("同一帖子在数据库层最多保留一个开放干预计划", async () => {
  const { prisma } = await import("../../lib/db");
  try {
    const first = await createKernelTask(prisma, "ready", `unique-open-${Date.now()}`);
    await assert.rejects(
      () => prisma.interventionTask.create({
        data: {
          courseId: first.courseId,
          postId: first.postId,
          targetUserId: first.targetUserId,
          interventionType: first.interventionType,
          publishTarget: "post_comment",
          priorityScore: 80,
          status: "review_required"
        }
      }),
      /Unique constraint|unique|唯一/i
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("AutoInterventionCandidate 提升为 InterventionTask 是幂等操作", async () => {
  const { prisma } = await import("../../lib/db");
  const service = await loadKernelModule<InterventionServiceModule>(
    interventionServiceModulePath,
    "lib/interventions/intervention-service.ts"
  );

  try {
    const post = await prisma.forumPost.findFirstOrThrow({
      where: {
        tasks: {
          none: {
            status: { in: [...openTaskStatuses] }
          }
        }
      },
      orderBy: { createdAt: "asc" }
    });
    const run = await prisma.autoInterventionRun.create({
      data: {
        courseId: post.courseId,
        forumListUrl: "mock://isolated-auto-run",
        mode: "dry_run",
        status: "completed",
        maxScanPosts: 1,
        maxPublishCount: 1,
        minScoreToPublish: 75,
        finishedAt: new Date()
      }
    });
    const marker = `幂等提升测试-${Date.now()}`;
    const candidate = await prisma.autoInterventionCandidate.create({
      data: {
        courseId: post.courseId,
        runId: run.id,
        postId: post.id,
        postUrl: post.url,
        postTitle: post.title,
        rawExtractJson: JSON.stringify({ source: "isolated-test" }),
        valueAnalysisJson: JSON.stringify({ isValuable: true }),
        interventionScore: 91,
        cieLevel: 2,
        emotionLabel: "中性",
        topicType: "discussion",
        interventionType: "cognitive_conflict",
        targetMode: "post_comment",
        targetCommentIndex: null,
        targetReason: "隔离测试",
        replyStrategy: "提出一个澄清问题",
        riskLevel: "low",
        reason: "用于验证候选提升幂等性",
        draftReply: marker,
        finalReply: marker,
        safetyRisk: 0,
        status: "analyzed"
      }
    });
    const existingTaskIds = new Set(
      (await prisma.interventionTask.findMany({
        where: { postId: post.id },
        select: { id: true }
      })).map((task) => task.id)
    );

    const [first, second] = await Promise.all([
      service.promoteAutoCandidateToInterventionTask({
        candidateId: candidate.id
      }),
      service.promoteAutoCandidateToInterventionTask({
        candidateId: candidate.id
      })
    ]);
    const third = await service.promoteAutoCandidateToInterventionTask({
      candidateId: candidate.id
    });

    assert.equal(
      [first, second].filter((result) => result.created).length,
      1,
      "并发提升只能有一个创建者"
    );
    assert.equal(second.task.id, first.task.id);
    assert.equal(third.created, false);
    assert.equal(third.task.id, first.task.id);
    assert.equal(first.task.postId, candidate.postId);
    assert.equal(first.task.targetUserId, post.authorId);
    assert.equal(first.task.interventionType, candidate.interventionType);
    assert.equal(first.task.publishTarget, candidate.targetMode);
    assert.equal(first.task.finalContent ?? first.task.draftContent, marker);

    const newTasks = await prisma.interventionTask.findMany({
      where: {
        postId: post.id,
        id: { notIn: [...existingTaskIds] }
      }
    });
    assert.equal(newTasks.length, 1, "重复提升不得创建第二条任务");
    assert.equal(newTasks[0].id, first.task.id);
  } finally {
    await prisma.$disconnect();
  }
});

test("候选提升与忽略并发时只能有一个最终事实", async () => {
  const { prisma } = await import("../../lib/db");
  const service = await loadKernelModule<InterventionServiceModule>(
    interventionServiceModulePath,
    "lib/interventions/intervention-service.ts"
  );

  try {
    const suffix = `candidate-race-${Date.now()}`;
    const user = await prisma.forumUser.create({
      data: {
        forumUserId: `user-${suffix}`,
        name: "并发测试学习者",
        role: "LEARNER",
        tagsJson: "[]",
        activityLevel: 1,
        emotionalState: "neutral",
        centralityScore: 0,
        lastActiveAt: new Date()
      }
    });
    const post = await prisma.forumPost.create({
      data: {
        forumPostId: `post-${suffix}`,
        authorId: user.id,
        title: "候选提升与忽略竞争",
        content: "用于验证两个审阅动作不会同时生效。",
        url: `https://cmooc.bnu.edu.cn/cMOOC/detail?id=${Date.now()}`,
        createdAt: new Date()
      }
    });
    const run = await prisma.autoInterventionRun.create({
      data: {
        forumListUrl: "mock://candidate-race",
        mode: "dry_run",
        status: "completed",
        maxScanPosts: 1,
        maxPublishCount: 1,
        minScoreToPublish: 75,
        finishedAt: new Date()
      }
    });
    const candidate = await prisma.autoInterventionCandidate.create({
      data: {
        runId: run.id,
        postId: post.id,
        postUrl: post.url,
        postTitle: post.title,
        rawExtractJson: "{}",
        valueAnalysisJson: JSON.stringify({ isValuable: true }),
        interventionScore: 88,
        cieLevel: 3,
        emotionLabel: "中性",
        topicType: "discussion",
        interventionType: "cognitive_conflict",
        targetMode: "post_comment",
        targetCommentIndex: null,
        targetReason: "并发隔离测试",
        replyStrategy: "提出澄清问题",
        riskLevel: "low",
        reason: "并发隔离测试",
        draftReply: "这是一条并发隔离测试回复。",
        finalReply: "这是一条并发隔离测试回复。",
        safetyRisk: 0,
        status: "analyzed"
      }
    });

    const outcomes = await Promise.allSettled([
      service.promoteAutoCandidateToInterventionTask({
        candidateId: candidate.id
      }),
      service.skipAutoInterventionCandidate({
        candidateId: candidate.id,
        reason: "并发测试中的人工忽略。"
      })
    ]);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
      "提升与忽略不能同时成功"
    );

    const finalCandidate = await prisma.autoInterventionCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
      include: { task: true }
    });
    assert.notEqual(finalCandidate.status, "promoting");
    if (finalCandidate.task) {
      assert.ok(
        ["planned", "manual_review"].includes(finalCandidate.status),
        "已有任务时候选必须保持与计划一致"
      );
    } else {
      assert.equal(finalCandidate.status, "skipped");
    }
    assert.ok(
      !(finalCandidate.task && finalCandidate.status === "skipped"),
      "不能同时存在已固化任务和已忽略候选"
    );
  } finally {
    await prisma.$disconnect();
  }
});
