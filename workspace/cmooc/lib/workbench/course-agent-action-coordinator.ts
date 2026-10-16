import {
  hashCourseToolValue,
  type ModelToolRequest,
  type ServerToolExecutionContext
} from "@/lib/course-tools/contracts";
import type { WorkbenchCourseToolActionRecord } from "@prisma/client";
import {
  prepareCourseToolExecution
} from "@/lib/course-tools/executor";
import { buildGrantBinding } from "@/lib/course-tools/policy-gateway";
import { CourseToolRegistry } from "@/lib/course-tools/registry";
import {
  prepareCourseToolAction,
  projectPreparedCourseToolAction,
  requestCourseToolActionApproval
} from "@/lib/workbench/course-tool-action-store";
import type { WorkbenchDb } from "@/lib/workbench/durable-ledger";
import type { WorkbenchPendingAction } from "@/lib/workbench/contracts";

export const COURSE_AGENT_ACTION_COORDINATOR_SCHEMA_VERSION =
  "cmooc.course-agent-action-coordinator.v1" as const;

const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;

export type PendingCourseAgentAction = Readonly<WorkbenchPendingAction>;

export function projectPendingCourseAgentAction(
  action: WorkbenchCourseToolActionRecord
): PendingCourseAgentAction {
  const projection = projectPreparedCourseToolAction(action);
  const isRecovery = action.toolName === "platform.editor.reconcile_stage";
  if (
    projection.status !== "awaiting_approval" ||
    (action.toolName !== "platform.editor.stage_verify_clear" && !isRecovery) ||
    action.toolVersion !== "1" ||
    (isRecovery &&
      (!action.parentActionId ||
        action.parentActionId !== action.recoveryOfActionId)) ||
    (!isRecovery && (action.parentActionId || action.recoveryOfActionId))
  ) {
    throw new Error("COURSE_AGENT_PENDING_ACTION_PROJECTION_INVALID");
  }
  const toolName = action.toolName as
    | "platform.editor.stage_verify_clear"
    | "platform.editor.reconcile_stage";
  return Object.freeze({
    schemaVersion: COURSE_AGENT_ACTION_COORDINATOR_SCHEMA_VERSION,
    kind: "approval_required" as const,
    actionRef: projection.actionRef,
    approvalHash: projection.approvalHash,
    bindingHash: projection.bindingHash,
    toolName,
    toolVersion: "1" as const,
    safeSummary: projection.safeSummary,
    validFrom: projection.validFrom,
    expiresAt: projection.expiresAt,
    operationBoundary: Object.freeze({
      editorWriteCount: isRecovery ? 0 as const : 1 as const,
      editorReadbackCount: 1 as const,
      editorClearCount: 1 as const,
      publishCount: 0 as const,
      notificationCount: 0 as const,
      realPublishEnabled: false as const
    }),
    ...(isRecovery
      ? {
          parentActionRef: action.parentActionId!,
          recoveryOfActionRef: action.recoveryOfActionId!
        }
      : {})
  });
}

export interface CourseAgentActionCoordinator {
  prepare(input: {
    request: ModelToolRequest;
    context: Readonly<ServerToolExecutionContext>;
  }): Promise<PendingCourseAgentAction>;
  prepareRecovery?(input: {
    parentAction: WorkbenchCourseToolActionRecord;
    stageTransactionRef: string;
    context: Readonly<ServerToolExecutionContext>;
  }): Promise<PendingCourseAgentAction>;
}

function deterministicRef(
  prefix: "action" | "grant",
  context: Readonly<ServerToolExecutionContext>,
  inputHash: string
): string {
  const hash = hashCourseToolValue(
    `cmooc.course-agent-${prefix}-ref.v1`,
    {
      callId: context.callId,
      taskId: context.taskId,
      runId: context.runId,
      planRevisionId: context.planRevisionId,
      stepId: context.stepId,
      inputHash
    }
  );
  return `${prefix}-${hash}`;
}

export function createCourseAgentActionCoordinator(input: {
  db: WorkbenchDb;
  registry: CourseToolRegistry;
  approvalTtlMs?: number;
}): CourseAgentActionCoordinator {
  const ttlMs = input.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 15 * 60_000) {
    throw new Error("COURSE_AGENT_ACTION_TTL_INVALID");
  }
  const prepareAction = async (parameters: {
    request: ModelToolRequest;
    context: Readonly<ServerToolExecutionContext>;
    parentAction?: WorkbenchCourseToolActionRecord;
  }): Promise<PendingCourseAgentAction> => {
      const { request, context, parentAction } = parameters;
      const prepared = prepareCourseToolExecution({
        registry: input.registry,
        modelRequest: request,
        context: { ...context }
      });
      const { definition } = prepared.registration;
      const isStage = definition.name === "platform.editor.stage_verify_clear";
      const isRecovery = definition.name === "platform.editor.reconcile_stage";
      if (
        (!isStage && !isRecovery) ||
        definition.version !== "1" ||
        definition.capability !== "L3_EXTERNAL_STAGE" ||
        definition.effect !== "external_stage"
      ) {
        throw new Error("COURSE_AGENT_ACTION_STAGE_ONLY");
      }
      if (
        (isStage && parentAction) ||
        (isRecovery &&
          (!parentAction ||
            parentAction.status !== "unknown" ||
            parentAction.toolName !== "platform.editor.stage_verify_clear" ||
            parentAction.toolVersion !== "1" ||
            parentAction.taskId !== context.taskId ||
            parentAction.runId !== context.runId ||
            parentAction.planRevisionId !== context.planRevisionId ||
            parentAction.stepId !== context.stepId ||
            parentAction.courseScopeHash !== prepared.courseScopeHash ||
            parentAction.policyVersion !== context.policyVersion ||
            parentAction.compensationRef !==
              prepared.parsedInput.stageTransactionRef))
      ) {
        throw new Error("COURSE_AGENT_RECOVERY_ACTION_SCOPE_INVALID");
      }
      const binding = buildGrantBinding({
        definition,
        context: prepared.authorizationContext,
        courseScopeHash: prepared.courseScopeHash,
        inputHash: prepared.inputHash
      });
      const validFrom = new Date(context.now);
      const expiresAt = new Date(validFrom.getTime() + ttlMs);
      const action = await prepareCourseToolAction(input.db, {
        actionRef: deterministicRef("action", context, prepared.inputHash),
        grantRef: deterministicRef("grant", context, prepared.inputHash),
        binding,
        businessInput: prepared.parsedInput,
        safeSummary: isRecovery
          ? "准备只读核对上一笔不确定暂存，并仅在确认属于本事务时清空残留；不会写入新正文，发布与通知均为 0。"
          : "准备在受信测试平台编辑器中暂存、回读并清空一份已核验草稿；发布与通知均为 0。",
        validFrom,
        expiresAt,
        preparedAt: validFrom,
        ...(parentAction
          ? {
              parentActionRef: parentAction.id,
              recoveryOfActionRef: parentAction.id
            }
          : {}),
        oneShot: true,
        realPublishEnabled: false
      });
      const awaiting = await requestCourseToolActionApproval(input.db, {
        actionRef: action.id,
        bindingHash: action.bindingHash,
        approvalHash: action.approvalHash,
        requestedAt: validFrom
      });
      return projectPendingCourseAgentAction(awaiting);
  };
  const coordinator: CourseAgentActionCoordinator = {
    prepare: ({ request, context }) => prepareAction({ request, context }),
    prepareRecovery: ({ parentAction, stageTransactionRef, context }) =>
      prepareAction({
        parentAction,
        context,
        request: Object.freeze({
          toolName: "platform.editor.reconcile_stage",
          toolVersion: "1",
          input: Object.freeze({ stageTransactionRef })
        })
      })
  };
  return Object.freeze(coordinator);
}
