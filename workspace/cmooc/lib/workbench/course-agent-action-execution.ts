import type { WorkbenchCourseToolActionRecord } from "@prisma/client";
import { loadCourseManifest } from "@/lib/autonomy/course-manifest";
import {
  hashCourseToolValue,
  isSafeIdentifier,
  isSha256,
  type CourseToolBusinessInput,
  type CourseToolExecutionOutcome,
  type CourseToolJsonValue,
  type ModelToolRequest,
  type ServerToolExecutionContext
} from "@/lib/course-tools/contracts";
import { CourseToolExecutor } from "@/lib/course-tools/executor";
import {
  CourseToolPolicyGateway,
  COURSE_TOOL_POLICY_VERSION
} from "@/lib/course-tools/policy-gateway";
import {
  approveCourseToolAction,
  completeCourseToolRecovery,
  loadCourseToolAction,
  markCourseToolRecoveryManualReview,
  transitionCourseToolAction
} from "@/lib/workbench/course-tool-action-store";
import {
  createCourseAgentActionCoordinator,
  projectPendingCourseAgentAction,
  type PendingCourseAgentAction
} from "@/lib/workbench/course-agent-action-coordinator";
import { DurableCourseToolExecutionSink } from "@/lib/workbench/course-tool-ledger-sink";
import type { CourseAgentProcessSession } from "@/lib/workbench/course-agent-session";
import {
  claimExecutionLease,
  releaseExecutionLease,
  type WorkbenchDb
} from "@/lib/workbench/durable-ledger";
import { transitionPlanStep } from "@/lib/workbench/plan-store";
import { createScopedCourseToolGrantAuthority } from "@/lib/workbench/scoped-course-tool-grant-authority";

const EXECUTION_LEASE_TTL_MS = 2 * 60_000;
const TOOL_DEADLINE_MS = 60_000;

export type ApprovedCourseAgentActionResult = Readonly<{
  status: "succeeded" | "failed" | "unknown" | "manual_review";
  actionRef: string;
  safeSummary: string;
  receiptHash?: string;
  stageVerificationRef?: string;
  recoveryActionRef?: string;
  safeModelProjection?: CourseToolJsonValue;
  pendingAction?: PendingCourseAgentAction;
}>;

function pendingActionMatchesExactProjection(
  supplied: PendingCourseAgentAction,
  projected: PendingCourseAgentAction
): boolean {
  return supplied.schemaVersion === projected.schemaVersion &&
    supplied.kind === projected.kind &&
    supplied.actionRef === projected.actionRef &&
    supplied.approvalHash === projected.approvalHash &&
    supplied.bindingHash === projected.bindingHash &&
    supplied.toolName === projected.toolName &&
    supplied.toolVersion === projected.toolVersion &&
    supplied.parentActionRef === projected.parentActionRef &&
    supplied.recoveryOfActionRef === projected.recoveryOfActionRef &&
    supplied.safeSummary === projected.safeSummary &&
    supplied.validFrom === projected.validFrom &&
    supplied.expiresAt === projected.expiresAt &&
    supplied.operationBoundary.editorWriteCount ===
      projected.operationBoundary.editorWriteCount &&
    supplied.operationBoundary.editorReadbackCount ===
      projected.operationBoundary.editorReadbackCount &&
    supplied.operationBoundary.editorClearCount ===
      projected.operationBoundary.editorClearCount &&
    supplied.operationBoundary.publishCount === 0 &&
    supplied.operationBoundary.publishCount ===
      projected.operationBoundary.publishCount &&
    supplied.operationBoundary.notificationCount === 0 &&
    supplied.operationBoundary.notificationCount ===
      projected.operationBoundary.notificationCount &&
    supplied.operationBoundary.realPublishEnabled === false &&
    supplied.operationBoundary.realPublishEnabled ===
      projected.operationBoundary.realPublishEnabled;
}

function exactStageVerificationRef(input: {
  action: WorkbenchCourseToolActionRecord;
  outcome: Readonly<CourseToolExecutionOutcome>;
  session: CourseAgentProcessSession;
}): string {
  const value = input.outcome.result.transientOutput;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("COURSE_AGENT_STAGE_VERIFICATION_REF_MISSING");
  }
  const registration = input.session.toolkit.registry.resolve(
    input.action.toolName,
    input.action.toolVersion
  );
  const output = registration.definition.outputSchema.parse(value) as Readonly<
    Record<string, unknown>
  >;
  const isStage = input.action.toolName === "platform.editor.stage_verify_clear";
  const expectedSchema = isStage
    ? "cmooc.course-tool.platform-stage-output.v1"
    : "cmooc.course-tool.platform-stage-reconcile-output.v1";
  const expectedStatus = isStage ? "verified_cleared" : "reconciled_cleared";
  const receiptRef = output.receiptRef;
  const receiptHash = output.receiptHash;
  const evidenceRefs = output.evidenceRefs;
  const exactReceiptEvidence = Array.isArray(evidenceRefs) && evidenceRefs.some(
    (candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return false;
      }
      const evidence = candidate as Readonly<Record<string, unknown>>;
      return evidence.kind === "stage_receipt" &&
        evidence.id === receiptRef &&
        evidence.hash === receiptHash;
    }
  );
  if (
    output.schemaVersion !== expectedSchema ||
    output.status !== expectedStatus ||
    typeof receiptRef !== "string" ||
    !isSafeIdentifier(receiptRef) ||
    typeof receiptHash !== "string" ||
    !isSha256(receiptHash) ||
    output.editorReadbackVerified !== true ||
    output.editorEmptyAfterClear !== true ||
    output.submitMutationCount !== 0 ||
    output.sendMutationCount !== 0 ||
    output.closeAuditStatus !== "passed" ||
    output.realPublishEnabled !== false ||
    output.bodyPersisted !== false ||
    output.published !== false ||
    !exactReceiptEvidence
  ) {
    throw new Error("COURSE_AGENT_STAGE_VERIFICATION_REF_INVALID");
  }
  return receiptRef;
}

function parseBusinessInput(action: WorkbenchCourseToolActionRecord): CourseToolBusinessInput {
  const value = JSON.parse(action.businessInputJson) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("COURSE_AGENT_ACTION_INPUT_CORRUPT");
  }
  return value as CourseToolBusinessInput;
}

export async function executeApprovedCourseAgentAction(input: {
  db: WorkbenchDb;
  action: WorkbenchCourseToolActionRecord;
  session: CourseAgentProcessSession;
  now?: Date;
}): Promise<ApprovedCourseAgentActionResult> {
  const { action, session } = input;
  const isStage = action.toolName === "platform.editor.stage_verify_clear";
  const isRecovery = action.toolName === "platform.editor.reconcile_stage";
  if (
    action.status !== "approved" ||
    action.taskId !== session.taskId ||
    action.runId !== session.runId ||
    (!isStage && !isRecovery) ||
    action.toolVersion !== "1" ||
    action.capability !== "L3_EXTERNAL_STAGE" ||
    action.effectClass !== "external_stage" ||
    action.realPublishEnabled !== false ||
    action.oneShot !== true
  ) {
    throw new Error("COURSE_AGENT_APPROVED_ACTION_SCOPE_INVALID");
  }
  if (
    (isStage && (action.parentActionId || action.recoveryOfActionId)) ||
    (isRecovery &&
      (!action.parentActionId ||
        action.parentActionId !== action.recoveryOfActionId))
  ) {
    throw new Error("COURSE_AGENT_APPROVED_ACTION_LINEAGE_INVALID");
  }
  const now = input.now ?? new Date();
  if (action.expiresAt <= now) {
    throw new Error("COURSE_AGENT_APPROVED_ACTION_EXPIRED");
  }
  const manifest = await loadCourseManifest(session.courseAlias);
  const ownerInstanceId = `course-agent-approval-${action.runId}`;
  const lease = await claimExecutionLease(input.db, {
    taskId: action.taskId,
    runId: action.runId,
    stepId: action.stepId,
    ownerInstanceId,
    ttlMs: EXECUTION_LEASE_TTL_MS,
    now: now.toISOString()
  });
  let planRunning = false;
  try {
    await transitionPlanStep(input.db, {
      taskId: action.taskId,
      runId: action.runId,
      stepId: action.stepId,
      from: isRecovery ? "waiting_for_reconcile" : "waiting_for_approval",
      to: "pending",
      at: now
    });
    await transitionPlanStep(input.db, {
      taskId: action.taskId,
      runId: action.runId,
      stepId: action.stepId,
      from: "pending",
      to: "running",
      at: now
    });
    planRunning = true;
    const context: ServerToolExecutionContext = Object.freeze({
      callId: action.callId,
      taskId: action.taskId,
      runId: action.runId,
      planRevisionId: action.planRevisionId,
      stepId: action.stepId,
      courseScope: Object.freeze({
        courseId: manifest.courseId,
        alias: manifest.alias,
        manifestHash: manifest.manifestHash
      }),
      intent: "implement",
      baseCapability: "L1_ARTIFACT",
      capabilityGrantRefs: Object.freeze([action.grantRef]),
      policyVersion: COURSE_TOOL_POLICY_VERSION,
      now: now.toISOString(),
      deadlineAt: new Date(
        Math.min(now.getTime() + TOOL_DEADLINE_MS, action.expiresAt.getTime())
      ).toISOString(),
      idempotencyKey: `request-${action.callId}`,
      attempt: action.attempt,
      executionLeaseId: lease.id,
      leaseGeneration: lease.generation,
      fencingToken: lease.fencingToken
    });
    if (action.policyVersion !== context.policyVersion) {
      throw new Error("COURSE_AGENT_ACTION_POLICY_CHANGED");
    }
    const request: ModelToolRequest = Object.freeze({
      toolName: action.toolName,
      toolVersion: action.toolVersion,
      input: parseBusinessInput(action)
    });
    const executor = new CourseToolExecutor({
      registry: session.toolkit.registry,
      verifierRegistry: session.toolkit.verifierRegistry,
      policyGateway: new CourseToolPolicyGateway({
        grantAuthority: createScopedCourseToolGrantAuthority(input.db),
        irreversibleExternalEnabled: false
      }),
      sink: new DurableCourseToolExecutionSink(input.db, {
        now: input.now ? () => new Date(now) : () => new Date()
      })
    });
    const outcome = await executor.execute(request, context);
    if (outcome.result.status === "succeeded") {
      const stageVerificationRef = exactStageVerificationRef({
        action,
        outcome,
        session
      });
      await session.toolkit.onToolOutcome({
        toolName: action.toolName,
        toolVersion: action.toolVersion,
        context,
        outcome
      });
      const receiptHash = hashCourseToolValue(
        "cmooc.course-agent-terminal-tool-receipt.v1",
        {
          receiptId: outcome.result.receiptId,
          callId: action.callId,
          status: outcome.result.status,
          outputHash: outcome.result.outputHash,
          verificationId: outcome.result.verificationId ?? null
        }
      );
      if (isRecovery) {
        await completeCourseToolRecovery(input.db, {
          recoveryActionRef: action.id,
          parentActionRef: action.recoveryOfActionId!,
          receiptHash,
          at: now
        });
      } else {
        await transitionCourseToolAction(input.db, {
          actionRef: action.id,
          from: "executing",
          to: "succeeded",
          reasonCode: "verified_stage_completed",
          at: now,
          terminalReceiptHash: receiptHash
        });
        await transitionPlanStep(input.db, {
          taskId: action.taskId,
          runId: action.runId,
          stepId: action.stepId,
          from: "running",
          to: "completed",
          at: now
        });
      }
      return Object.freeze({
        status: "succeeded" as const,
        actionRef: action.id,
        safeSummary: outcome.durableProjection.safeOutputSummary,
        receiptHash,
        stageVerificationRef,
        safeModelProjection: outcome.result.safeModelProjection
      });
    }
    if (isRecovery) {
      await markCourseToolRecoveryManualReview(input.db, {
        recoveryActionRef: action.id,
        parentActionRef: action.recoveryOfActionId!,
        reasonCode: outcome.result.status === "unknown"
          ? "reconcile_inconclusive_manual_review"
          : "reconcile_blocked_manual_review",
        at: now
      });
      return Object.freeze({
        status: "manual_review" as const,
        actionRef: action.id,
        safeSummary:
          outcome.result.status === "unknown"
            ? "所有权核对仍无法得到唯一终态；系统未重试、未清除无主内容，已转人工审核。"
            : "所有权核对发现不属于本事务或无法安全清除的状态；未修改该内容，已转人工审核。"
      });
    }

    const compensationRef =
      outcome.result.compensationRef ?? outcome.durableProjection.compensationRef;
    if (outcome.result.status === "unknown" && compensationRef) {
      const unknownAction = await transitionCourseToolAction(input.db, {
        actionRef: action.id,
        from: "executing",
        to: "unknown",
        reasonCode: "stage_outcome_reconcile_required",
        at: now,
        compensationRef
      });
      await transitionPlanStep(input.db, {
        taskId: action.taskId,
        runId: action.runId,
        stepId: action.stepId,
        from: "running",
        to: "waiting_for_reconcile",
        at: now
      });
      const recoveryHash = hashCourseToolValue(
        "cmooc.course-agent-reconcile-call.v1",
        {
          actionRef: action.id,
          callId: action.callId,
          compensationRef
        }
      );
      const recoveryCallId = `call-reconcile-${recoveryHash}`;
      const recoveryContext: ServerToolExecutionContext = Object.freeze({
        ...context,
        callId: recoveryCallId,
        capabilityGrantRefs: Object.freeze([]),
        idempotencyKey: `request-${recoveryCallId}`,
        attempt: 1,
        causationId: action.callId
      });
      try {
        const recoveryCoordinator = createCourseAgentActionCoordinator({
          db: input.db,
          registry: session.toolkit.registry
        });
        if (!recoveryCoordinator.prepareRecovery) {
          throw new Error("COURSE_AGENT_RECOVERY_COORDINATOR_UNAVAILABLE");
        }
        const pendingAction = await recoveryCoordinator.prepareRecovery({
          parentAction: unknownAction,
          stageTransactionRef: compensationRef,
          context: recoveryContext
        });
        return Object.freeze({
          status: "unknown" as const,
          actionRef: action.id,
          safeSummary: outcome.durableProjection.safeOutputSummary,
          pendingAction
        });
      } catch {
        await transitionCourseToolAction(input.db, {
          actionRef: action.id,
          from: "unknown",
          to: "manual_review",
          reasonCode: "reconcile_action_preparation_failed",
          at: now
        });
        await transitionPlanStep(input.db, {
          taskId: action.taskId,
          runId: action.runId,
          stepId: action.stepId,
          from: "waiting_for_reconcile",
          to: "pending",
          at: now
        })
          .then(() =>
            transitionPlanStep(input.db, {
              taskId: action.taskId,
              runId: action.runId,
              stepId: action.stepId,
              from: "pending",
              to: "running",
              at: now
            })
          )
          .then(() =>
            transitionPlanStep(input.db, {
              taskId: action.taskId,
              runId: action.runId,
              stepId: action.stepId,
              from: "running",
              to: "blocked",
              at: now
            })
          )
          .catch(() => undefined);
        return Object.freeze({
          status: "manual_review" as const,
          actionRef: action.id,
          safeSummary:
            "暂存终态不确定，且精确核对子动作未能安全建立；系统未重试写入，已转人工审核。"
        });
      }
    }

    await transitionCourseToolAction(input.db, {
      actionRef: action.id,
      from: "executing",
      to: outcome.result.status === "unknown"
        ? "manual_review"
        : "failed_before_write",
      reasonCode: outcome.result.status === "unknown"
        ? "stage_unknown_without_recovery_ref"
        : "stage_failed_before_write",
      at: now
    });
    await transitionPlanStep(input.db, {
      taskId: action.taskId,
      runId: action.runId,
      stepId: action.stepId,
      from: "running",
      to: "blocked",
      at: now
    });
    return Object.freeze({
      status: outcome.result.status === "unknown"
        ? "manual_review" as const
        : "failed" as const,
      actionRef: action.id,
      safeSummary: outcome.result.status === "unknown"
        ? "暂存终态不确定但缺少精确事务引用；系统未重试，已转人工审核。"
        : outcome.durableProjection.safeOutputSummary
    });
  } catch (error) {
    if (planRunning) {
      const current = await loadCourseToolAction(input.db, {
        actionRef: action.id,
        taskId: action.taskId,
        runId: action.runId
      });
      if (current?.status === "executing") {
        if (isRecovery) {
          await markCourseToolRecoveryManualReview(input.db, {
            recoveryActionRef: action.id,
            parentActionRef: action.recoveryOfActionId!,
            reasonCode: "reconcile_execution_interrupted",
            at: now
          });
        } else {
          await transitionCourseToolAction(input.db, {
            actionRef: action.id,
            from: "executing",
            to: "manual_review",
            reasonCode: "stage_interrupted_without_recovery_ref",
            at: now
          });
          await transitionPlanStep(input.db, {
            taskId: action.taskId,
            runId: action.runId,
            stepId: action.stepId,
            from: "running",
            to: "blocked",
            at: now
          });
        }
        return Object.freeze({
          status: "manual_review" as const,
          actionRef: action.id,
          safeSummary:
            "一次性执行已开始但没有返回可精确核对的终态；系统未重试写入，已转人工审核。"
        });
      }
      if (current?.status === "approved" || current?.status === "failed_before_write") {
        if (current.status === "approved") {
          await transitionCourseToolAction(input.db, {
            actionRef: action.id,
            from: "approved",
            to: "failed_before_write",
            reasonCode: "stage_failed_before_grant_claim",
            at: now
          });
        }
        if (isRecovery && action.recoveryOfActionId) {
          await transitionCourseToolAction(input.db, {
            actionRef: action.recoveryOfActionId,
            from: "unknown",
            to: "manual_review",
            reasonCode: "reconcile_failed_before_grant_claim",
            at: now
          }).catch(() => undefined);
        }
        await transitionPlanStep(input.db, {
          taskId: action.taskId,
          runId: action.runId,
          stepId: action.stepId,
          from: "running",
          to: "blocked",
          at: now
        });
        return Object.freeze({
          status: "failed" as const,
          actionRef: action.id,
          safeSummary: isRecovery
            ? "所有权核对在取得执行权前失败；未执行编辑器写入、清除、发布或通知，已转人工审核。"
            : "暂存操作在取得外部写入权前失败；未执行编辑器写入、发布或通知。"
        });
      }
    }
    throw error;
  } finally {
    await releaseExecutionLease(input.db, {
      leaseId: lease.id,
      ownerInstanceId,
      generation: lease.generation,
      fencingToken: lease.fencingToken,
      now: new Date().toISOString()
    }).catch(() => undefined);
  }
}

/**
 * Server policy executor for the exact reversible action that was already
 * prepared and moved to awaiting_approval by the canonical transport. It does
 * not mint a broad grant: the existing action binding is approved verbatim,
 * then the normal one-shot grant claim and receipt path is reused.
 */
export async function autoAuthorizeAndExecuteCourseAgentAction(input: {
  db: WorkbenchDb;
  pendingAction: PendingCourseAgentAction;
  session: CourseAgentProcessSession;
  policyMode: "auto_reversible";
  now?: Date;
}): Promise<ApprovedCourseAgentActionResult> {
  if (input.policyMode !== "auto_reversible") {
    throw new Error("COURSE_AGENT_AUTO_REVERSIBLE_POLICY_REQUIRED");
  }
  const { pendingAction, session } = input;
  const now = input.now ?? new Date();
  const action = await loadCourseToolAction(input.db, {
    actionRef: pendingAction.actionRef,
    taskId: session.taskId,
    runId: session.runId
  });
  let exactProjection: PendingCourseAgentAction | null = null;
  try {
    exactProjection = action ? projectPendingCourseAgentAction(action) : null;
  } catch {
    exactProjection = null;
  }
  const isExactRecovery =
    pendingAction.toolName === "platform.editor.reconcile_stage" &&
    action?.toolName === "platform.editor.reconcile_stage" &&
    Boolean(pendingAction.parentActionRef) &&
    pendingAction.parentActionRef === pendingAction.recoveryOfActionRef &&
    action.parentActionId === pendingAction.parentActionRef &&
    action.recoveryOfActionId === pendingAction.recoveryOfActionRef;
  const isExactStage =
    pendingAction.toolName === "platform.editor.stage_verify_clear" &&
    action?.toolName === "platform.editor.stage_verify_clear" &&
    pendingAction.parentActionRef === undefined &&
    pendingAction.recoveryOfActionRef === undefined &&
    action.parentActionId === null &&
    action.recoveryOfActionId === null;
  if (
    !action ||
    !exactProjection ||
    !pendingActionMatchesExactProjection(pendingAction, exactProjection) ||
    action.status !== "awaiting_approval" ||
    action.bindingHash !== pendingAction.bindingHash ||
    action.approvalHash !== pendingAction.approvalHash ||
    action.toolVersion !== pendingAction.toolVersion ||
    action.capability !== "L3_EXTERNAL_STAGE" ||
    action.effectClass !== "external_stage" ||
    action.oneShot !== true ||
    action.realPublishEnabled !== false ||
    action.expiresAt <= now ||
    (!isExactStage && !isExactRecovery)
  ) {
    throw new Error("COURSE_AGENT_AUTO_REVERSIBLE_SCOPE_INVALID");
  }
  const approved = await approveCourseToolAction(input.db, {
    actionRef: action.id,
    bindingHash: action.bindingHash,
    approvalHash: action.approvalHash,
    approvedAt: now
  });
  const executed = await executeApprovedCourseAgentAction({
    db: input.db,
    action: approved.action,
    session,
    now
  });
  if (executed.status !== "unknown" || !executed.pendingAction) {
    return executed;
  }
  if (isExactRecovery) {
    throw new Error("COURSE_AGENT_RECONCILE_RETURNED_SECOND_RECOVERY");
  }

  const recoveryActionRef = executed.pendingAction.actionRef;
  const reconciled = await autoAuthorizeAndExecuteCourseAgentAction({
    db: input.db,
    pendingAction: executed.pendingAction,
    session,
    policyMode: "auto_reversible",
    now
  });
  return Object.freeze({
    status: reconciled.status,
    actionRef: action.id,
    safeSummary: reconciled.safeSummary,
    ...(reconciled.receiptHash
      ? { receiptHash: reconciled.receiptHash }
      : {}),
    ...(reconciled.stageVerificationRef
      ? { stageVerificationRef: reconciled.stageVerificationRef }
      : {}),
    ...(reconciled.safeModelProjection !== undefined
      ? { safeModelProjection: reconciled.safeModelProjection }
      : {}),
    recoveryActionRef
  });
}
