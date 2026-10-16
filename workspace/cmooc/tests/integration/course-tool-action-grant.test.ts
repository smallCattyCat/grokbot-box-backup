import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { hashCourseToolValue } from "../../lib/course-tools/contracts";
import type { CourseToolGrantBinding } from "../../lib/course-tools/policy-gateway";
import {
  approveCourseToolAction,
  completeCourseToolRecovery,
  CourseToolActionStoreError,
  prepareCourseToolAction,
  projectPreparedCourseToolAction,
  quarantineCourseToolRunAfterProcessLoss,
  requestCourseToolActionApproval,
  revokeCourseToolGrant,
  transitionCourseToolAction
} from "../../lib/workbench/course-tool-action-store";
import { ScopedWorkbenchCourseToolGrantAuthority } from "../../lib/workbench/scoped-course-tool-grant-authority";

const require = createRequire(import.meta.url);
const testRoot = mkdtempSync(path.join(tmpdir(), "cmooc-course-tool-grants-"));
const databasePath = path.join(testRoot, "grants.db").replace(/\\/g, "/");
const databaseUrl = `file:${databasePath}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const t0 = new Date("2026-08-13T10:00:00.000Z");

function hash(domain: string, value: string): string {
  return hashCourseToolValue(domain, value);
}

function at(offsetMs: number): Date {
  return new Date(t0.getTime() + offsetMs);
}

type Scope = {
  suffix: string;
  taskId: string;
  runId: string;
  planRevisionId: string;
  stepId: string;
  callId: string;
};

async function createScope(suffix: string): Promise<Scope> {
  const scope = {
    suffix,
    taskId: `task:${suffix}`,
    runId: `run:${suffix}`,
    planRevisionId: `plan:${suffix}`,
    stepId: `step:${suffix}`,
    callId: `call:${suffix}`
  };
  await prisma.workbenchTask.create({
    data: {
      id: scope.taskId,
      title: `安全 L3 action ${suffix}`,
      status: "running",
      createdAt: at(-60_000)
    }
  });
  await prisma.workbenchRunRecord.create({
    data: {
      id: scope.runId,
      taskId: scope.taskId,
      schemaVersion: "workbench-run-v1",
      source: "app-server",
      status: "running",
      projectLabel: "课程工作台",
      snapshotJson: "{}",
      createdAt: at(-60_000),
      updatedAt: at(-60_000)
    }
  });
  await prisma.workbenchPlanRevisionRecord.create({
    data: {
      id: scope.planRevisionId,
      taskId: scope.taskId,
      runId: scope.runId,
      revision: 1,
      objectiveHash: hash("objective", suffix),
      source: "server_compiler",
      compilerVersion: "course-agent-v2",
      safeSummary: "执行精确绑定的 L3 暂存步骤。",
      createdAt: at(-50_000)
    }
  });
  await prisma.workbenchPlanStepRecord.create({
    data: {
      id: scope.stepId,
      planRevisionId: scope.planRevisionId,
      ordinal: 1,
      status: "pending",
      toolName: "platform.editor.stage_verify_clear",
      toolVersion: "1",
      dependencyIdsJson: "[]",
      inputRefsJson: "[]",
      preconditionsJson: "[]",
      postconditionsJson: "[]",
      effectClass: "external_stage",
      requiredCapability: "L3_EXTERNAL_STAGE",
      acceptanceJson: "{}",
      replanPolicyJson: "{}",
      safeSummary: "暂存、回读并清除受保护草稿。",
      createdAt: at(-50_000)
    }
  });
  return scope;
}

function binding(scope: Scope): CourseToolGrantBinding {
  const businessInput = { draftArtifactRef: `artifact:${scope.suffix}` };
  return {
    capability: "L3_EXTERNAL_STAGE",
    effect: "external_stage",
    toolName: "platform.editor.stage_verify_clear",
    toolVersion: "1",
    callId: scope.callId,
    taskId: scope.taskId,
    runId: scope.runId,
    planRevisionId: scope.planRevisionId,
    stepId: scope.stepId,
    courseScopeHash: hash("course-scope", scope.suffix),
    inputHash: hashCourseToolValue(
      "input:platform.editor.stage_verify_clear@1",
      businessInput
    ),
    idempotencyKeyHash: hash("idempotency", scope.suffix),
    policyVersion: "cmooc.course-tool.policy.v1",
    attempt: 1
  };
}

async function prepareAndApprove(
  scope: Scope,
  window: { validFrom?: Date; expiresAt?: Date } = {}
) {
  const exactBinding = binding(scope);
  const action = await prepareCourseToolAction(prisma, {
    actionRef: `action:${scope.suffix}`,
    grantRef: `grant:${scope.suffix}`,
    binding: exactBinding,
    businessInput: { draftArtifactRef: `artifact:${scope.suffix}` },
    safeSummary: "暂存、逐字回读并清除一个受保护草稿。",
    validFrom: window.validFrom ?? at(0),
    expiresAt: window.expiresAt ?? at(300_000),
    preparedAt: at(-30_000),
    oneShot: true,
    realPublishEnabled: false
  });
  const projection = projectPreparedCourseToolAction(action);
  assert.equal("grantRef" in projection, false);
  await requestCourseToolActionApproval(prisma, {
    actionRef: projection.actionRef,
    bindingHash: projection.bindingHash,
    approvalHash: projection.approvalHash,
    requestedAt: at(-20_000)
  });
  const approved = await approveCourseToolAction(prisma, {
    actionRef: projection.actionRef,
    bindingHash: projection.bindingHash,
    approvalHash: projection.approvalHash,
    approvedAt: at(-10_000)
  });
  return { ...approved, binding: exactBinding, projection };
}

before(async () => {
  const migrated = spawnSync(
    process.execPath,
    [require.resolve("prisma/build/index.js"), "migrate", "deploy"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        CMOOC_DISABLE_WINDOWS_ENV_FALLBACK: "1"
      },
      encoding: "utf8"
    }
  );
  assert.equal(
    migrated.status,
    0,
    `${migrated.stdout ?? ""}\n${migrated.stderr ?? ""}`
  );
  await prisma.$connect();
});

after(async () => {
  await prisma.$disconnect();
  rmSync(testRoot, { recursive: true, force: true });
});

test("prepared approval issues an exact no-publish grant and the authority consumes it once", async () => {
  const scope = await createScope("exact");
  const prepared = await prepareAndApprove(scope);
  assert.equal(prepared.action.status, "approved");
  assert.equal(prepared.grant.status, "available");
  assert.equal(prepared.grant.realPublishEnabled, false);
  assert.equal(prepared.grant.oneShot, true);
  assert.equal(prepared.action.businessInputJson.includes("artifact:exact"), true);
  assert.equal(prepared.action.containsForumText, false);
  assert.equal(prepared.action.containsIdentity, false);
  assert.equal(prepared.action.containsSecrets, false);

  const authority = new ScopedWorkbenchCourseToolGrantAuthority(prisma);
  const first = await authority.claim({
    grantRef: prepared.grant.id,
    binding: prepared.binding,
    now: at(1_000).toISOString()
  });
  assert.equal(first.status, "claimed");
  assert.equal(first.grant?.capability, "L3_EXTERNAL_STAGE");
  assert.equal(first.grant?.effect, "external_stage");
  assert.equal(first.grant?.realPublishEnabled, false);

  const second = await authority.claim({
    grantRef: prepared.grant.id,
    binding: prepared.binding,
    now: at(2_000).toISOString()
  });
  assert.equal(second.status, "consumed");
  const [action, grant] = await Promise.all([
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: prepared.action.id }
    }),
    prisma.workbenchCourseToolGrantRecord.findUniqueOrThrow({
      where: { id: prepared.grant.id }
    })
  ]);
  assert.equal(action.status, "executing");
  assert.equal(grant.status, "consumed");
  assert.equal(grant.consumedAt?.toISOString(), at(1_000).toISOString());

  await transitionCourseToolAction(prisma, {
    actionRef: action.id,
    from: "executing",
    to: "unknown",
    reasonCode: "stage_outcome_unknown",
    at: at(3_000)
  });
  await transitionCourseToolAction(prisma, {
    actionRef: action.id,
    from: "unknown",
    to: "reconciling",
    reasonCode: "trusted_reconcile_started",
    at: at(4_000)
  });
  const reconciled = await transitionCourseToolAction(prisma, {
    actionRef: action.id,
    from: "reconciling",
    to: "reconciled",
    reasonCode: "editor_safe_state_confirmed",
    reconciliationHash: hash("reconciliation", "exact"),
    at: at(5_000)
  });
  assert.equal(reconciled.status, "reconciled");
});

test("scope mismatch does not consume authority; concurrent exact claims have one winner", async () => {
  const mismatchScope = await createScope("mismatch");
  const mismatch = await prepareAndApprove(mismatchScope);
  const authority = new ScopedWorkbenchCourseToolGrantAuthority(prisma);
  const wrong = await authority.claim({
    grantRef: mismatch.grant.id,
    binding: {
      ...mismatch.binding,
      inputHash: hash("wrong-input", "mismatch")
    },
    now: at(1_000).toISOString()
  });
  assert.equal(wrong.status, "scope_mismatch");
  assert.equal(
    (
      await prisma.workbenchCourseToolGrantRecord.findUniqueOrThrow({
        where: { id: mismatch.grant.id }
      })
    ).status,
    "available"
  );

  const concurrentScope = await createScope("concurrent");
  const concurrent = await prepareAndApprove(concurrentScope);
  const claims = await Promise.all([
    authority.claim({
      grantRef: concurrent.grant.id,
      binding: concurrent.binding,
      now: at(1_000).toISOString()
    }),
    authority.claim({
      grantRef: concurrent.grant.id,
      binding: concurrent.binding,
      now: at(1_000).toISOString()
    })
  ]);
  assert.deepEqual(
    claims.map((result) => result.status).sort(),
    ["claimed", "consumed"]
  );
});

test("reconcile uses a distinct one-shot grant and atomically completes its parent and plan step", async () => {
  const scope = await createScope("reconcile-grant");
  const stage = await prepareAndApprove(scope);
  const authority = new ScopedWorkbenchCourseToolGrantAuthority(prisma);
  assert.equal(
    (
      await authority.claim({
        grantRef: stage.grant.id,
        binding: stage.binding,
        now: at(1_000).toISOString()
      })
    ).status,
    "claimed"
  );
  const stageTransactionRef = `stage-transaction:${scope.suffix}`;
  const parent = await transitionCourseToolAction(prisma, {
    actionRef: stage.action.id,
    from: "executing",
    to: "unknown",
    reasonCode: "stage_outcome_reconcile_required",
    compensationRef: stageTransactionRef,
    at: at(2_000)
  });
  const recoveryInput = { stageTransactionRef };
  const recoveryBinding: CourseToolGrantBinding = {
    ...stage.binding,
    toolName: "platform.editor.reconcile_stage",
    callId: `call:reconcile:${scope.suffix}`,
    inputHash: hashCourseToolValue(
      "input:platform.editor.reconcile_stage@1",
      recoveryInput
    ),
    idempotencyKeyHash: hash("reconcile-idempotency", scope.suffix)
  };
  const recovery = await prepareCourseToolAction(prisma, {
    actionRef: `action:reconcile:${scope.suffix}`,
    grantRef: `grant:reconcile:${scope.suffix}`,
    binding: recoveryBinding,
    businessInput: recoveryInput,
    safeSummary: "只核对上一笔暂存并仅清除本事务残留；发布与通知均为 0。",
    validFrom: at(0),
    expiresAt: at(300_000),
    preparedAt: at(3_000),
    parentActionRef: parent.id,
    recoveryOfActionRef: parent.id,
    oneShot: true,
    realPublishEnabled: false
  });
  await requestCourseToolActionApproval(prisma, {
    actionRef: recovery.id,
    bindingHash: recovery.bindingHash,
    approvalHash: recovery.approvalHash,
    requestedAt: at(4_000)
  });
  const approvedRecovery = await approveCourseToolAction(prisma, {
    actionRef: recovery.id,
    bindingHash: recovery.bindingHash,
    approvalHash: recovery.approvalHash,
    approvedAt: at(5_000)
  });
  assert.notEqual(approvedRecovery.grant.id, stage.grant.id);
  await prisma.workbenchPlanStepRecord.update({
    where: { id: scope.stepId },
    data: { status: "running", startedAt: at(5_500) }
  });

  const claims = await Promise.all([
    authority.claim({
      grantRef: approvedRecovery.grant.id,
      binding: recoveryBinding,
      now: at(6_000).toISOString()
    }),
    authority.claim({
      grantRef: approvedRecovery.grant.id,
      binding: recoveryBinding,
      now: at(6_000).toISOString()
    })
  ]);
  assert.deepEqual(
    claims.map((result) => result.status).sort(),
    ["claimed", "consumed"]
  );
  const [parentAfter, recoveryAfter, recoveryGrant] = await Promise.all([
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: parent.id }
    }),
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: recovery.id }
    }),
    prisma.workbenchCourseToolGrantRecord.findUniqueOrThrow({
      where: { id: approvedRecovery.grant.id }
    })
  ]);
  assert.equal(parentAfter.status, "reconciling");
  assert.equal(recoveryAfter.status, "executing");
  assert.equal(recoveryGrant.status, "consumed");
  assert.equal(recoveryAfter.parentActionId, parent.id);
  assert.equal(recoveryAfter.recoveryOfActionId, parent.id);

  const receiptHash = hash("reconciliation-receipt", scope.suffix);
  await completeCourseToolRecovery(prisma, {
    recoveryActionRef: recovery.id,
    parentActionRef: parent.id,
    receiptHash,
    at: at(7_000)
  });
  const [parentCompleted, recoveryCompleted, planStepCompleted] =
    await Promise.all([
      prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
        where: { id: parent.id }
      }),
      prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
        where: { id: recovery.id }
      }),
      prisma.workbenchPlanStepRecord.findUniqueOrThrow({
        where: { id: scope.stepId }
      })
    ]);
  assert.equal(parentCompleted.status, "reconciled");
  assert.equal(parentCompleted.reconciliationHash, receiptHash);
  assert.equal(recoveryCompleted.status, "succeeded");
  assert.equal(recoveryCompleted.terminalReceiptHash, receiptHash);
  assert.equal(planStepCompleted.status, "completed");
  assert.equal(planStepCompleted.completedAt?.toISOString(), at(7_000).toISOString());
});

test("expired and revoked grants remain terminal and never reach executing", async () => {
  const expiredScope = await createScope("expired");
  const expired = await prepareAndApprove(expiredScope, {
    validFrom: at(-30_000),
    expiresAt: at(10_000)
  });
  const authority = new ScopedWorkbenchCourseToolGrantAuthority(prisma);
  const expiredClaim = await authority.claim({
    grantRef: expired.grant.id,
    binding: expired.binding,
    now: at(20_000).toISOString()
  });
  assert.equal(expiredClaim.status, "expired");
  assert.equal(
    (
      await prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
        where: { id: expired.action.id }
      })
    ).status,
    "failed_before_write"
  );

  const revokedScope = await createScope("revoked");
  const revoked = await prepareAndApprove(revokedScope);
  const revokedRow = await revokeCourseToolGrant(prisma, {
    grantRef: revoked.grant.id,
    bindingHash: revoked.projection.bindingHash,
    approvalHash: revoked.projection.approvalHash,
    revokedAt: at(1_000)
  });
  assert.equal(revokedRow.status, "revoked");
  const revokedClaim = await authority.claim({
    grantRef: revoked.grant.id,
    binding: revoked.binding,
    now: at(2_000).toISOString()
  });
  assert.equal(revokedClaim.status, "revoked");
  assert.equal(
    (
      await prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
        where: { id: revoked.action.id }
      })
    ).status,
    "failed_before_write"
  );
});

test("process loss revokes unconsumed authority and quarantines any started action without replay", async () => {
  const beforeWriteScope = await createScope("process-loss-before-write");
  const beforeWrite = await prepareAndApprove(beforeWriteScope);
  await prisma.workbenchPlanStepRecord.update({
    where: { id: beforeWriteScope.stepId },
    data: { status: "waiting_for_approval" }
  });
  const beforeWriteResult = await quarantineCourseToolRunAfterProcessLoss(prisma, {
    taskId: beforeWriteScope.taskId,
    runId: beforeWriteScope.runId,
    at: at(1_000)
  });
  assert.equal(beforeWriteResult.revokedGrantCount, 1);
  assert.equal(beforeWriteResult.failedBeforeWriteCount, 1);
  const [beforeWriteAction, beforeWriteGrant, beforeWriteStep] = await Promise.all([
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: beforeWrite.action.id }
    }),
    prisma.workbenchCourseToolGrantRecord.findUniqueOrThrow({
      where: { id: beforeWrite.grant.id }
    }),
    prisma.workbenchPlanStepRecord.findUniqueOrThrow({
      where: { id: beforeWriteScope.stepId }
    })
  ]);
  assert.equal(beforeWriteAction.status, "failed_before_write");
  assert.equal(beforeWriteGrant.status, "revoked");
  assert.equal(beforeWriteStep.status, "blocked");

  const startedScope = await createScope("process-loss-after-start");
  const started = await prepareAndApprove(startedScope);
  const authority = new ScopedWorkbenchCourseToolGrantAuthority(prisma);
  assert.equal(
    (
      await authority.claim({
        grantRef: started.grant.id,
        binding: started.binding,
        now: at(2_000).toISOString()
      })
    ).status,
    "claimed"
  );
  await prisma.workbenchPlanStepRecord.update({
    where: { id: startedScope.stepId },
    data: { status: "running" }
  });
  const startedResult = await quarantineCourseToolRunAfterProcessLoss(prisma, {
    taskId: startedScope.taskId,
    runId: startedScope.runId,
    at: at(3_000)
  });
  assert.equal(startedResult.revokedGrantCount, 0);
  assert.equal(startedResult.manualReviewCount, 1);
  const [startedAction, startedGrant, startedStep] = await Promise.all([
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: started.action.id }
    }),
    prisma.workbenchCourseToolGrantRecord.findUniqueOrThrow({
      where: { id: started.grant.id }
    }),
    prisma.workbenchPlanStepRecord.findUniqueOrThrow({
      where: { id: startedScope.stepId }
    })
  ]);
  assert.equal(startedAction.status, "manual_review");
  assert.equal(startedGrant.status, "consumed");
  assert.equal(startedStep.status, "blocked");
});

test("approval after expiry persists failed_before_write and creates no grant", async () => {
  const scope = await createScope("approval-expired");
  const exactBinding = binding(scope);
  const action = await prepareCourseToolAction(prisma, {
    actionRef: "action:approval-expired",
    grantRef: "grant:approval-expired",
    binding: exactBinding,
    businessInput: { draftArtifactRef: "artifact:approval-expired" },
    safeSummary: "审批到期前只保留安全 action 投影。",
    validFrom: at(-30_000),
    expiresAt: at(5_000),
    preparedAt: at(-20_000),
    oneShot: true,
    realPublishEnabled: false
  });
  const projection = projectPreparedCourseToolAction(action);
  await requestCourseToolActionApproval(prisma, {
    actionRef: projection.actionRef,
    bindingHash: projection.bindingHash,
    approvalHash: projection.approvalHash,
    requestedAt: at(-10_000)
  });
  await assert.rejects(
    approveCourseToolAction(prisma, {
      actionRef: projection.actionRef,
      bindingHash: projection.bindingHash,
      approvalHash: projection.approvalHash,
      approvedAt: at(10_000)
    }),
    (error: unknown) =>
      error instanceof CourseToolActionStoreError &&
      error.code === "COURSE_TOOL_ACTION_EXPIRED"
  );
  assert.equal(
    (
      await prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
        where: { id: action.id }
      })
    ).status,
    "failed_before_write"
  );
  assert.equal(
    await prisma.workbenchCourseToolGrantRecord.count({
      where: { actionId: action.id }
    }),
    0
  );
});

test("database checks reject L4 and publish-enabled action injection", async () => {
  const l4Scope = await createScope("db-l4");
  const exact = binding(l4Scope);
  const common = {
    schemaVersion: "cmooc.workbench.course-tool-action.v1",
    taskId: l4Scope.taskId,
    runId: l4Scope.runId,
    planRevisionId: l4Scope.planRevisionId,
    stepId: l4Scope.stepId,
    callId: l4Scope.callId,
    toolName: exact.toolName,
    toolVersion: exact.toolVersion,
    courseScopeHash: exact.courseScopeHash,
    inputHash: exact.inputHash,
    idempotencyKeyHash: exact.idempotencyKeyHash,
    policyVersion: exact.policyVersion,
    attempt: exact.attempt,
    businessInputJson: '{"draftArtifactRef":"artifact:db-l4"}',
    safeSummary: "数据库边界注入测试。",
    bindingHash: hash("binding", "db-l4"),
    approvalHash: hash("approval", "db-l4"),
    grantRef: "grant:db-l4",
    validFrom: at(0),
    expiresAt: at(300_000),
    oneShot: true,
    status: "prepared",
    statusReasonCode: "server_prepared",
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false,
    preparedAt: at(-1_000)
  } as const;

  await assert.rejects(
    prisma.workbenchCourseToolActionRecord.create({
      data: {
        id: "action:db-l4",
        ...common,
        capability: "L4_IRREVERSIBLE",
        effectClass: "irreversible_external",
        realPublishEnabled: false
      }
    })
  );
  assert.equal(
    await prisma.workbenchCourseToolActionRecord.count({
      where: { id: "action:db-l4" }
    }),
    0
  );

  const publishScope = await createScope("db-publish");
  const publishBinding = binding(publishScope);
  await assert.rejects(
    prisma.workbenchCourseToolActionRecord.create({
      data: {
        ...common,
        id: "action:db-publish",
        taskId: publishScope.taskId,
        runId: publishScope.runId,
        planRevisionId: publishScope.planRevisionId,
        stepId: publishScope.stepId,
        callId: publishScope.callId,
        courseScopeHash: publishBinding.courseScopeHash,
        inputHash: publishBinding.inputHash,
        idempotencyKeyHash: publishBinding.idempotencyKeyHash,
        bindingHash: hash("binding", "db-publish"),
        approvalHash: hash("approval", "db-publish"),
        grantRef: "grant:db-publish",
        capability: "L3_EXTERNAL_STAGE",
        effectClass: "external_stage",
        realPublishEnabled: true
      }
    })
  );
  assert.equal(
    await prisma.workbenchCourseToolActionRecord.count({
      where: { id: "action:db-publish" }
    }),
    0
  );

  const foreignKeyFailures = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "PRAGMA foreign_key_check"
  );
  assert.deepEqual(foreignKeyFailures, []);
});
