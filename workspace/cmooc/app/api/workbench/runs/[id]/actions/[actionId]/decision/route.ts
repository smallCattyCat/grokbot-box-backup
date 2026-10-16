import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  approveCourseToolAction,
  declineCourseToolRecovery,
  expireCourseToolGrant,
  loadCourseToolRecoveryAction,
  revokeCourseToolGrant,
  transitionCourseToolAction
} from "@/lib/workbench/course-tool-action-store";
import { executeApprovedCourseAgentAction } from "@/lib/workbench/course-agent-action-execution";
import { projectPendingCourseAgentAction } from "@/lib/workbench/course-agent-action-coordinator";
import {
  deleteCourseAgentProcessSession,
  getCourseAgentProcessSession
} from "@/lib/workbench/course-agent-session";
import {
  completeWorkbenchRun,
  getWorkbenchRun,
  setWorkbenchPendingAction,
  setWorkbenchRunStatus,
  steerWorkbenchRun
} from "@/lib/workbench/run-store";
import { persistWorkbenchRunSnapshot } from "@/lib/workbench/history-store";
import { isSafeRunId } from "@/lib/workbench/contracts";
import {
  buildVerifiedStageDeliveryResumePrompt,
  extractStageVerificationRefFromDurableReceipt
} from "@/lib/workbench/course-agent-stage-resume";
import {
  skipWaitingPlanBranch,
  transitionPlanStep
} from "@/lib/workbench/plan-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTION_REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;

type DecisionInput = {
  decision: "approve" | "decline";
  expectedActionHash: string;
};

function response(
  body: Readonly<Record<string, unknown>>,
  status: number
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function parseDecision(value: unknown): DecisionInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== "decision" && key !== "expectedActionHash"
    ) ||
    (record.decision !== "approve" && record.decision !== "decline") ||
    typeof record.expectedActionHash !== "string" ||
    !HASH.test(record.expectedActionHash)
  ) {
    return null;
  }
  return {
    decision: record.decision,
    expectedActionHash: record.expectedActionHash
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; actionId: string } }
): Promise<NextResponse> {
  const guard = requireTrustedJsonMutation(request, "工作台本次精确操作");
  if (guard) return guard;
  if (!isSafeRunId(params.id) || !ACTION_REF.test(params.actionId)) {
    return response(
      { error: "任务或操作编号无效。", code: "WORKBENCH_ACTION_ID_INVALID" },
      400
    );
  }
  const decision = parseDecision(await request.json().catch(() => null));
  if (!decision) {
    return response(
      { error: "本次操作决定无效。", code: "WORKBENCH_ACTION_DECISION_INVALID" },
      400
    );
  }
  const snapshot = getWorkbenchRun(params.id);
  const pending = snapshot?.pendingAction;
  if (
    !snapshot ||
    snapshot.status !== "awaiting_action" ||
    !pending ||
    pending.actionRef !== params.actionId ||
    pending.approvalHash !== decision.expectedActionHash
  ) {
    return response(
      { error: "该精确操作已变更、过期或不再等待决定。", code: "WORKBENCH_ACTION_STALE" },
      409
    );
  }
  const action = await prisma.workbenchCourseToolActionRecord.findUnique({
    where: { id: params.actionId }
  });
  if (
    !action ||
    action.runId !== params.id ||
    action.approvalHash !== decision.expectedActionHash ||
    action.bindingHash !== pending.bindingHash ||
    action.toolName !== pending.toolName ||
    (action.toolName !== "platform.editor.stage_verify_clear" &&
      action.toolName !== "platform.editor.reconcile_stage") ||
    action.realPublishEnabled !== false ||
    action.capability !== "L3_EXTERNAL_STAGE" ||
    action.effectClass !== "external_stage"
  ) {
    return response(
      { error: "本次操作绑定无法核对。", code: "WORKBENCH_ACTION_BINDING_MISMATCH" },
      409
    );
  }
  const isRecovery = action.toolName === "platform.editor.reconcile_stage";
  const actionToolName = action.toolName;
  if (
    (isRecovery &&
      (!action.parentActionId ||
        action.parentActionId !== action.recoveryOfActionId ||
        pending.parentActionRef !== action.parentActionId ||
        pending.recoveryOfActionRef !== action.recoveryOfActionId)) ||
    (!isRecovery && (action.parentActionId || action.recoveryOfActionId))
  ) {
    return response(
      { error: "本次恢复操作 lineage 无法核对。", code: "WORKBENCH_ACTION_LINEAGE_MISMATCH" },
      409
    );
  }
  const now = new Date();
  const session = getCourseAgentProcessSession(params.id);
  const clearPendingAction = () => {
    session?.transport.resolvePendingInteraction?.(action.id);
    if (action.parentActionId) {
      session?.transport.resolvePendingInteraction?.(action.parentActionId);
    }
    setWorkbenchPendingAction(params.id, null);
  };
  const blockRecoveryPlan = async () => {
    await transitionPlanStep(prisma, {
      taskId: action.taskId,
      runId: action.runId,
      stepId: action.stepId,
      from: "waiting_for_reconcile",
      to: "pending",
      at: now
    });
    await transitionPlanStep(prisma, {
      taskId: action.taskId,
      runId: action.runId,
      stepId: action.stepId,
      from: "pending",
      to: "running",
      at: now
    });
    await transitionPlanStep(prisma, {
      taskId: action.taskId,
      runId: action.runId,
      stepId: action.stepId,
      from: "running",
      to: "blocked",
      at: now
    });
  };
  const finishWithoutExecution = async (input: {
    status: "completed" | "failed";
    summary: string;
    errorCode?: string;
    retainProtectedRuntime?: boolean;
  }) => {
    clearPendingAction();
    if (!input.retainProtectedRuntime) {
      deleteCourseAgentProcessSession(params.id);
    }
    const completed = completeWorkbenchRun(
      params.id,
      input.status,
      input.summary,
      input.errorCode
    );
    if (completed) await persistWorkbenchRunSnapshot(completed);
    return completed;
  };
  const loadDurableStageVerificationRef = async (): Promise<string> => {
    const receipt = await prisma.workbenchToolReceiptRecord.findUnique({
      where: { callId: action.callId },
      select: {
        id: true,
        callId: true,
        status: true,
        outputHash: true,
        verificationId: true,
        evidenceRefsJson: true,
        containsForumText: true,
        containsIdentity: true
      }
    });
    if (!receipt?.verificationId) {
      throw new Error("COURSE_AGENT_STAGE_RESUME_RECEIPT_INVALID");
    }
    const verification = await prisma.workbenchVerificationRecord.findUnique({
      where: { id: receipt.verificationId },
      select: { id: true, status: true }
    });
    if (!verification) {
      throw new Error("COURSE_AGENT_STAGE_RESUME_VERIFICATION_INVALID");
    }
    return extractStageVerificationRefFromDurableReceipt({
      action: {
        callId: action.callId,
        toolName: actionToolName,
        terminalReceiptHash: action.terminalReceiptHash
      },
      receipt,
      verification
    });
  };
  const continueAfterVerifiedStage = async (
    stageVerificationRef: string,
    receiptHash?: string
  ) => {
    let resumePrompt: string;
    try {
      resumePrompt = buildVerifiedStageDeliveryResumePrompt(
        stageVerificationRef
      );
    } catch {
      const failed = await finishWithoutExecution({
        status: "failed",
        summary:
          "暂存已核验，但交付步骤缺少精确的 STAGE 回执引用；未重放暂存、发布或通知。",
        errorCode: "COURSE_AGENT_STAGE_VERIFICATION_REF_INVALID"
      });
      return response(
        {
          action: {
            actionRef: action.id,
            status: "verification_failed",
            receiptHash,
            realPublishEnabled: false
          },
          run: failed
        },
        409
      );
    }
    if (!session) {
      const failed = await finishWithoutExecution({
        status: "failed",
        summary:
          "暂存已核验完成，但受保护成果运行时已经失效；未执行发布或通知，请重新生成交付包。",
        errorCode: "COURSE_AGENT_PROTECTED_RUNTIME_EXPIRED"
      });
      return response(
        {
          action: {
            actionRef: action.id,
            status: "succeeded",
            receiptHash,
            stageVerificationRef,
            realPublishEnabled: false
          },
          run: failed
        },
        409
      );
    }
    clearPendingAction();
    setWorkbenchRunStatus(params.id, "running", {
      summary: "本次暂存已回读核验并清空；正在继续生成零发布交付包。"
    });
    const running = getWorkbenchRun(params.id);
    if (running) await persistWorkbenchRunSnapshot(running);
    try {
      await steerWorkbenchRun(
        params.id,
        resumePrompt
      );
    } catch {
      return response(
        {
          error: "暂存已核验，但零发布交付包恢复失败；不得重放暂存步骤。",
          code: "WORKBENCH_DELIVERY_RESUME_FAILED",
          action: {
            actionRef: action.id,
            status: "succeeded",
            receiptHash,
            stageVerificationRef,
            realPublishEnabled: false
          },
          run: getWorkbenchRun(params.id)
        },
        409
      );
    }
    return response(
      {
        action: {
          actionRef: action.id,
          status: "succeeded",
          receiptHash,
          stageVerificationRef,
          realPublishEnabled: false
        },
        run: getWorkbenchRun(params.id)
      },
      202
    );
  };

  if (action.status === "succeeded") {
    if (!action.terminalReceiptHash || !HASH.test(action.terminalReceiptHash)) {
      const failed = await finishWithoutExecution({
        status: "failed",
        summary: "暂存终态缺少可核验回执；系统未继续交付或执行任何发布。",
        errorCode: "COURSE_AGENT_STAGE_RECEIPT_INVALID"
      });
      return response(
        {
          action: {
            actionRef: action.id,
            status: "verification_failed",
            realPublishEnabled: false
          },
          run: failed
        },
        409
      );
    }
    if (isRecovery) {
      const parent = await prisma.workbenchCourseToolActionRecord.findFirst({
        where: {
          id: action.recoveryOfActionId!,
          taskId: action.taskId,
          runId: action.runId,
          status: "reconciled",
          reconciliationHash: action.terminalReceiptHash,
          toolName: "platform.editor.stage_verify_clear",
          realPublishEnabled: false
        }
      });
      if (!parent) {
        const failed = await finishWithoutExecution({
          status: "failed",
          summary: "恢复子动作与原暂存终态不一致；系统未继续交付、发布或通知。",
          errorCode: "COURSE_AGENT_RECONCILE_PAIR_INVALID"
        });
        return response(
          {
            action: {
              actionRef: action.id,
              status: "verification_failed",
              realPublishEnabled: false
            },
            run: failed
          },
          409
        );
      }
    }
    let stageVerificationRef: string;
    try {
      stageVerificationRef = await loadDurableStageVerificationRef();
    } catch {
      const failed = await finishWithoutExecution({
        status: "failed",
        summary:
          "暂存终态无法恢复精确的 STAGE 回执引用；系统未继续交付或执行发布。",
        errorCode: "COURSE_AGENT_STAGE_RESUME_RECEIPT_INVALID"
      });
      return response(
        {
          action: {
            actionRef: action.id,
            status: "verification_failed",
            realPublishEnabled: false
          },
          run: failed
        },
        409
      );
    }
    return continueAfterVerifiedStage(
      stageVerificationRef,
      action.terminalReceiptHash ?? undefined
    );
  }
  if (action.status === "executing") {
    return response(
      {
        error: "本次操作已经取得一次性执行权，正在等待唯一终态回流。",
        code: "WORKBENCH_ACTION_EXECUTING"
      },
      409
    );
  }
  if (action.status === "unknown" && !isRecovery) {
    const recovery = await loadCourseToolRecoveryAction(prisma, {
      recoveryOfActionRef: action.id,
      taskId: action.taskId,
      runId: action.runId
    });
    if (recovery?.status === "awaiting_approval") {
      const recoveryPending = projectPendingCourseAgentAction(recovery);
      clearPendingAction();
      setWorkbenchPendingAction(params.id, recoveryPending);
      setWorkbenchRunStatus(params.id, "awaiting_action", {
        summary: "暂存终态不确定；等待批准一次精确、零发布的所有权安全核对。"
      });
      const recoveredRun = getWorkbenchRun(params.id);
      if (recoveredRun) await persistWorkbenchRunSnapshot(recoveredRun);
      return response(
        {
          action: {
            actionRef: action.id,
            status: "unknown",
            realPublishEnabled: false
          },
          pendingAction: recoveryPending,
          run: recoveredRun
        },
        202
      );
    }
  }
  if (
    action.status === "unknown" ||
    action.status === "reconciling" ||
    action.status === "reconciled" ||
    action.status === "manual_review"
  ) {
    const failed = await finishWithoutExecution({
      status: "failed",
      summary:
        "暂存结果不能由本次审批卡继续；系统未重放写入，需进入所有权安全核对或重新生成。",
      errorCode: "COURSE_AGENT_RECONCILE_REQUIRED",
      retainProtectedRuntime:
        action.status === "unknown" || action.status === "reconciling"
    });
    return response(
      {
        action: {
          actionRef: action.id,
          status: action.status,
          realPublishEnabled: false
        },
        run: failed
      },
      409
    );
  }
  if (action.status === "failed_before_write") {
    const declined = action.statusReasonCode === "operator_declined_before_write" ||
      action.statusReasonCode === "grant_revoked";
    const completed = await finishWithoutExecution({
      status: declined ? "completed" : "failed",
      summary: declined
        ? "本次暂存操作已取消；未发生编辑器写入、发布或通知。"
        : "本次暂存在写入前已失败或过期；未执行发布或通知。",
      ...(declined ? {} : { errorCode: "COURSE_AGENT_STAGE_FAILED_BEFORE_WRITE" })
    });
    return response(
      {
        action: {
          actionRef: action.id,
          status: "failed_before_write",
          realPublishEnabled: false
        },
        run: completed
      },
      declined ? 200 : 409
    );
  }

  if (decision.decision === "decline") {
    try {
      if (isRecovery) {
        if (action.status === "approved") {
          await revokeCourseToolGrant(prisma, {
            grantRef: action.grantRef,
            bindingHash: action.bindingHash,
            approvalHash: action.approvalHash,
            revokedAt: now
          });
        } else if (action.status !== "awaiting_approval") {
          throw new Error("WORKBENCH_ACTION_STATE_CHANGED");
        }
        await declineCourseToolRecovery(prisma, {
          recoveryActionRef: action.id,
          parentActionRef: action.recoveryOfActionId!,
          at: now
        });
        await blockRecoveryPlan();
      } else if (action.status === "approved") {
        await revokeCourseToolGrant(prisma, {
          grantRef: action.grantRef,
          bindingHash: action.bindingHash,
          approvalHash: action.approvalHash,
          revokedAt: now
        });
      } else if (action.status === "awaiting_approval") {
        await transitionCourseToolAction(prisma, {
          actionRef: action.id,
          from: "awaiting_approval",
          to: "failed_before_write",
          reasonCode: "operator_declined_before_write",
          at: now
        });
      } else {
        throw new Error("WORKBENCH_ACTION_STATE_CHANGED");
      }
      if (!isRecovery) {
        await skipWaitingPlanBranch(prisma, {
          taskId: action.taskId,
          runId: action.runId,
          stepId: action.stepId,
          from: "waiting_for_approval",
          at: now
        });
      }
    } catch {
      return response(
        { error: "该操作状态已变更，请刷新后再核对。", code: "WORKBENCH_ACTION_STATE_CHANGED" },
        409
      );
    }
    const completed = await finishWithoutExecution({
      status: isRecovery ? "failed" : "completed",
      summary: isRecovery
        ? "操作者未授权所有权核对；系统没有重试写入、清除内容、发布或通知，任务转人工审核。"
        : "操作者选择暂不执行测试平台暂存；未发生编辑器写入、发布或通知。",
      ...(isRecovery
        ? { errorCode: "COURSE_AGENT_RECONCILE_DECLINED" }
        : {})
    });
    return response(
      {
        action: { actionRef: action.id, status: "declined", realPublishEnabled: false },
        run: completed
      },
      isRecovery ? 409 : 200
    );
  }

  if (action.expiresAt <= now) {
    try {
      if (action.status === "approved") {
        await expireCourseToolGrant(prisma, {
          grantRef: action.grantRef,
          now
        });
      } else if (action.status === "awaiting_approval") {
        await transitionCourseToolAction(prisma, {
          actionRef: action.id,
          from: "awaiting_approval",
          to: "failed_before_write",
          reasonCode: "approval_window_expired",
          at: now
        });
      }
      if (isRecovery) {
        await transitionCourseToolAction(prisma, {
          actionRef: action.recoveryOfActionId!,
          from: "unknown",
          to: "manual_review",
          reasonCode: "reconcile_approval_expired",
          at: now
        });
        await blockRecoveryPlan();
      } else {
        await skipWaitingPlanBranch(prisma, {
          taskId: action.taskId,
          runId: action.runId,
          stepId: action.stepId,
          from: "waiting_for_approval",
          at: now
        });
      }
    } catch {
      // A concurrent terminal transition wins; no new authority is issued.
    }
    await finishWithoutExecution({
      status: "failed",
      summary: "本次精确操作已过期；未发放或使用新的写入权限，请重新预检。",
      errorCode: "WORKBENCH_ACTION_EXPIRED"
    });
    return response(
      { error: "本次操作已过期，需要重新预检。", code: "WORKBENCH_ACTION_EXPIRED" },
      409
    );
  }

  if (!session) {
    return response(
      {
        error: "受保护草稿运行时已不可用；未发放授权，请重新生成。",
        code: "WORKBENCH_ACTION_RUNTIME_EXPIRED"
      },
      409
    );
  }
  try {
    const approved = await approveCourseToolAction(prisma, {
      actionRef: action.id,
      bindingHash: action.bindingHash,
      approvalHash: action.approvalHash,
      approvedAt: now
    });
    const execution = await executeApprovedCourseAgentAction({
      db: prisma,
      action: approved.action,
      session,
      now
    });
    if (execution.status !== "succeeded") {
      clearPendingAction();
      if (execution.status === "unknown" && execution.pendingAction) {
        setWorkbenchPendingAction(params.id, execution.pendingAction);
        setWorkbenchRunStatus(params.id, "awaiting_action", {
          summary: "暂存终态不确定；等待批准一次精确、零发布的所有权安全核对。"
        });
        const waiting = getWorkbenchRun(params.id);
        if (waiting) await persistWorkbenchRunSnapshot(waiting);
        return response(
          {
            action: {
              actionRef: action.id,
              status: "unknown",
              realPublishEnabled: false
            },
            pendingAction: execution.pendingAction,
            run: waiting
          },
          202
        );
      }
      if (execution.status !== "unknown" || !execution.pendingAction) {
        deleteCourseAgentProcessSession(params.id);
      }
      const failed = completeWorkbenchRun(
        params.id,
        "failed",
        execution.status === "unknown"
          ? "暂存结果未能唯一确认，且无法建立精确核对子动作；系统未自动重试。"
          : execution.status === "manual_review"
            ? "所有权安全核对未得到可自动继续的终态；未重试写入或清除无主内容，任务转人工审核。"
            : "暂存在写入前失败；未执行发布或通知。",
        execution.status === "unknown"
          ? "COURSE_AGENT_RECONCILE_REQUIRED"
          : execution.status === "manual_review"
            ? "COURSE_AGENT_MANUAL_REVIEW_REQUIRED"
          : "COURSE_AGENT_STAGE_FAILED_BEFORE_WRITE"
      );
      if (failed) await persistWorkbenchRunSnapshot(failed);
      return response(
        {
          action: {
            actionRef: action.id,
            status: execution.status,
            realPublishEnabled: false
          },
          run: failed
        },
        409
      );
    }
    if (!execution.stageVerificationRef) {
      throw new Error("COURSE_AGENT_STAGE_VERIFICATION_REF_MISSING");
    }
    return continueAfterVerifiedStage(
      execution.stageVerificationRef,
      execution.receiptHash
    );
  } catch {
    return response(
      {
        error: "本次操作未能完成精确授权执行；系统未放宽权限或自动重试。",
        code: "WORKBENCH_ACTION_EXECUTION_FAILED"
      },
      409
    );
  }
}
