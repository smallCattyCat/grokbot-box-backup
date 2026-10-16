import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { POST } from "../../app/api/workbench/runs/[id]/actions/[actionId]/decision/route";
import { prisma } from "../../lib/db";
import { hashCourseToolValue } from "../../lib/course-tools/contracts";
import type { CourseToolGrantBinding } from "../../lib/course-tools/policy-gateway";
import {
  approveCourseToolAction,
  prepareCourseToolAction,
  projectPreparedCourseToolAction,
  requestCourseToolActionApproval,
  transitionCourseToolAction
} from "../../lib/workbench/course-tool-action-store";
import {
  COURSE_AGENT_ACTION_COORDINATOR_SCHEMA_VERSION,
  projectPendingCourseAgentAction
} from "../../lib/workbench/course-agent-action-coordinator";
import { ScopedWorkbenchCourseToolGrantAuthority } from "../../lib/workbench/scoped-course-tool-grant-authority";
import {
  createWorkbenchRun,
  resetWorkbenchStoreForTests,
  setWorkbenchPendingAction,
  setWorkbenchRunStatus
} from "../../lib/workbench/run-store";

function trustedDecisionRequest(
  runId: string,
  actionRef: string,
  body: unknown
): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/workbench/runs/${runId}/actions/${actionRef}/decision`,
    {
      method: "POST",
      headers: {
        Host: "localhost:3000",
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
        "Sec-Fetch-Site": "same-origin"
      },
      body: JSON.stringify(body)
    }
  );
}

type AwaitingFixture = Awaited<ReturnType<typeof createAwaitingFixture>>;

async function createAwaitingFixture() {
  const suffix = randomUUID();
  const runId = suffix;
  const taskId = `decision-task-${suffix}`;
  const planRevisionId = `decision-plan-${suffix}`;
  const stepId = `decision-step-${suffix}`;
  const callId = `decision-call-${suffix}`;
  const actionRef = `decision-action-${suffix}`;
  const grantRef = `decision-grant-${suffix}`;
  const now = new Date();
  const businessInput = {
    targetRef: `target-${suffix}`,
    artifactVersionRef: `artifact-${suffix}`,
    draftBodyHash: hashCourseToolValue("decision-draft.v1", suffix),
    preflightRef: `preflight-${suffix}`
  };
  const binding: CourseToolGrantBinding = {
    capability: "L3_EXTERNAL_STAGE",
    effect: "external_stage",
    toolName: "platform.editor.stage_verify_clear",
    toolVersion: "1",
    callId,
    taskId,
    runId,
    planRevisionId,
    stepId,
    courseScopeHash: hashCourseToolValue("decision-course-scope.v1", suffix),
    inputHash: hashCourseToolValue(
      "input:platform.editor.stage_verify_clear@1",
      businessInput
    ),
    idempotencyKeyHash: hashCourseToolValue("decision-idempotency.v1", suffix),
    policyVersion: "cmooc.course-tool.policy.v1",
    attempt: 1
  };
  await prisma.workbenchTask.create({
    data: {
      id: taskId,
      title: "精确暂存决定测试",
      status: "running",
      createdAt: now
    }
  });
  await prisma.workbenchRunRecord.create({
    data: {
      id: runId,
      taskId,
      schemaVersion: "workbench-run-v1",
      source: "app-server",
      status: "running",
      projectLabel: "课程工作台",
      snapshotJson: "{}",
      createdAt: now,
      updatedAt: now
    }
  });
  await prisma.workbenchPlanRevisionRecord.create({
    data: {
      id: planRevisionId,
      taskId,
      runId,
      revision: 1,
      objectiveHash: hashCourseToolValue("decision-objective.v1", suffix),
      source: "server_compiler",
      compilerVersion: "course-agent-v2",
      safeSummary: "核验一项精确 L3 暂存决定。",
      createdAt: now
    }
  });
  await prisma.workbenchPlanStepRecord.create({
    data: {
      id: stepId,
      planRevisionId,
      ordinal: 1,
      status: "waiting_for_approval",
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
      safeSummary: "暂存、回读并清空受保护草稿。",
      startedAt: now,
      createdAt: now
    }
  });
  const prepared = await prepareCourseToolAction(prisma, {
    actionRef,
    grantRef,
    binding,
    businessInput,
    safeSummary: "暂存、回读并清空一份受保护草稿；发布与通知均为 0。",
    validFrom: new Date(now.getTime() - 1_000),
    expiresAt: new Date(now.getTime() + 5 * 60_000),
    preparedAt: now,
    oneShot: true,
    realPublishEnabled: false
  });
  const awaiting = await requestCourseToolActionApproval(prisma, {
    actionRef,
    bindingHash: prepared.bindingHash,
    approvalHash: prepared.approvalHash,
    requestedAt: now
  });
  const projection = projectPreparedCourseToolAction(awaiting);
  createWorkbenchRun({
    prompt: "执行精确暂存决定测试",
    source: "app-server",
    runId
  });
  setWorkbenchPendingAction(runId, {
    schemaVersion: COURSE_AGENT_ACTION_COORDINATOR_SCHEMA_VERSION,
    kind: "approval_required",
    actionRef,
    approvalHash: projection.approvalHash,
    bindingHash: projection.bindingHash,
    toolName: "platform.editor.stage_verify_clear",
    toolVersion: "1",
    safeSummary: projection.safeSummary,
    validFrom: projection.validFrom,
    expiresAt: projection.expiresAt,
    operationBoundary: {
      editorWriteCount: 1,
      editorReadbackCount: 1,
      editorClearCount: 1,
      publishCount: 0,
      notificationCount: 0,
      realPublishEnabled: false
    }
  });
  setWorkbenchRunStatus(runId, "awaiting_action", {
    summary: "等待本次精确暂存决定。"
  });
  return {
    actionRef,
    grantRef,
    projection,
    runId,
    taskId,
    planRevisionId,
    stepId,
    callId,
    binding,
    now
  };
}

beforeEach(() => {
  resetWorkbenchStoreForTests();
});

test("decision endpoint rejects client-supplied grant and capability fields", async () => {
  const response = await POST(
    trustedDecisionRequest(
      "11111111-1111-4111-8111-111111111111",
      "decision-shape-action",
      {
        decision: "approve",
        expectedActionHash: "a".repeat(64),
        grantRef: "client-controlled-grant",
        capability: "L4_IRREVERSIBLE",
        publish: true
      }
    ),
    {
      params: {
        id: "11111111-1111-4111-8111-111111111111",
        actionId: "decision-shape-action"
      }
    }
  );
  assert.equal(response.status, 400);
  assert.equal(
    ((await response.json()) as { code?: string }).code,
    "WORKBENCH_ACTION_DECISION_INVALID"
  );
});

test("declining an exact pending action skips the branch without issuing a grant", async () => {
  const fixture: AwaitingFixture = await createAwaitingFixture();
  const response = await POST(
    trustedDecisionRequest(fixture.runId, fixture.actionRef, {
      decision: "decline",
      expectedActionHash: fixture.projection.approvalHash
    }),
    { params: { id: fixture.runId, actionId: fixture.actionRef } }
  );
  assert.equal(response.status, 200);
  const [action, step, grantCount] = await Promise.all([
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: fixture.actionRef }
    }),
    prisma.workbenchPlanStepRecord.findUniqueOrThrow({
      where: { id: fixture.stepId }
    }),
    prisma.workbenchCourseToolGrantRecord.count({
      where: { id: fixture.grantRef }
    })
  ]);
  assert.equal(action.status, "failed_before_write");
  assert.equal(step.status, "skipped");
  assert.equal(grantCount, 0);
  assert.equal(JSON.stringify(await response.clone().json()).includes("grantRef"), false);
});

test("approval with an expired protected runtime issues no grant", async () => {
  const fixture: AwaitingFixture = await createAwaitingFixture();
  const response = await POST(
    trustedDecisionRequest(fixture.runId, fixture.actionRef, {
      decision: "approve",
      expectedActionHash: fixture.projection.approvalHash
    }),
    { params: { id: fixture.runId, actionId: fixture.actionRef } }
  );
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { code?: string }).code,
    "WORKBENCH_ACTION_RUNTIME_EXPIRED"
  );
  assert.equal(
    await prisma.workbenchCourseToolGrantRecord.count({
      where: { id: fixture.grantRef }
    }),
    0
  );
  assert.equal(
    (
      await prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
        where: { id: fixture.actionRef }
      })
    ).status,
    "awaiting_approval"
  );
});

test("reconcile approval after process restart fails closed and issues no second grant", async () => {
  const fixture = await createAwaitingFixture();
  const approvedStage = await approveCourseToolAction(prisma, {
    actionRef: fixture.actionRef,
    bindingHash: fixture.projection.bindingHash,
    approvalHash: fixture.projection.approvalHash,
    approvedAt: new Date(fixture.now.getTime() + 1)
  });
  const claimed = await new ScopedWorkbenchCourseToolGrantAuthority(prisma).claim({
    grantRef: approvedStage.grant.id,
    binding: fixture.binding,
    now: new Date(fixture.now.getTime() + 2).toISOString()
  });
  assert.equal(claimed.status, "claimed");
  const stageTransactionRef = `stage-transaction-${fixture.callId}`;
  await transitionCourseToolAction(prisma, {
    actionRef: fixture.actionRef,
    from: "executing",
    to: "unknown",
    reasonCode: "stage_outcome_reconcile_required",
    compensationRef: stageTransactionRef,
    at: new Date(fixture.now.getTime() + 3)
  });
  await prisma.workbenchPlanStepRecord.update({
    where: { id: fixture.stepId },
    data: { status: "waiting_for_reconcile" }
  });
  const recoveryInput = { stageTransactionRef };
  const recoveryBinding: CourseToolGrantBinding = {
    ...fixture.binding,
    toolName: "platform.editor.reconcile_stage",
    callId: `reconcile-${fixture.callId}`,
    inputHash: hashCourseToolValue(
      "input:platform.editor.reconcile_stage@1",
      recoveryInput
    ),
    idempotencyKeyHash: hashCourseToolValue(
      "decision-reconcile-idempotency.v1",
      fixture.callId
    )
  };
  const recovery = await prepareCourseToolAction(prisma, {
    actionRef: `recovery-${fixture.actionRef}`,
    grantRef: `recovery-${fixture.grantRef}`,
    binding: recoveryBinding,
    businessInput: recoveryInput,
    safeSummary: "只核对上一笔暂存并仅清除属于本事务的残留；发布与通知均为 0。",
    validFrom: new Date(fixture.now.getTime() - 1_000),
    expiresAt: new Date(fixture.now.getTime() + 5 * 60_000),
    preparedAt: new Date(fixture.now.getTime() + 4),
    parentActionRef: fixture.actionRef,
    recoveryOfActionRef: fixture.actionRef,
    oneShot: true,
    realPublishEnabled: false
  });
  const recoveryAwaiting = await requestCourseToolActionApproval(prisma, {
    actionRef: recovery.id,
    bindingHash: recovery.bindingHash,
    approvalHash: recovery.approvalHash,
    requestedAt: new Date(fixture.now.getTime() + 5)
  });
  const pending = projectPendingCourseAgentAction(recoveryAwaiting);
  setWorkbenchPendingAction(fixture.runId, pending);
  setWorkbenchRunStatus(fixture.runId, "awaiting_action", {
    summary: "等待精确所有权核对决定。"
  });

  const response = await POST(
    trustedDecisionRequest(fixture.runId, recovery.id, {
      decision: "approve",
      expectedActionHash: recovery.approvalHash
    }),
    { params: { id: fixture.runId, actionId: recovery.id } }
  );
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { code?: string }).code,
    "WORKBENCH_ACTION_RUNTIME_EXPIRED"
  );
  const [recoveryAfter, parentAfter, recoveryGrantCount] = await Promise.all([
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: recovery.id }
    }),
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: fixture.actionRef }
    }),
    prisma.workbenchCourseToolGrantRecord.count({
      where: { actionId: recovery.id }
    })
  ]);
  assert.equal(recoveryAfter.status, "awaiting_approval");
  assert.equal(parentAfter.status, "unknown");
  assert.equal(recoveryGrantCount, 0);
});
