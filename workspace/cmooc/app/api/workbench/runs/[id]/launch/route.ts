import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  WorkbenchInputError,
  isSafeRunId,
  isWorkbenchRunLineage,
  parseWorkbenchLaunchInput
} from "@/lib/workbench/contracts";
import {
  completeWorkbenchRun,
  createWorkbenchRun,
  getActiveWorkbenchRun,
  getWorkbenchRun,
  setWorkbenchPlan,
  setWorkbenchSessionWorkspace
} from "@/lib/workbench/run-store";
import {
  attachWorkbenchPersistence,
  loadPersistentWorkbenchRun,
  persistWorkbenchRunSnapshot,
  recoverInterruptedWorkbenchRuns
} from "@/lib/workbench/history-store";
import {
  buildWorkbenchChildPrompt,
  buildWorkbenchCourseDraftRecoveryPrompt,
  deriveWorkbenchChildLineage,
  deriveWorkbenchChildRunId,
  loadWorkbenchCourseRecoveryBundle
} from "@/lib/workbench/launch";
import { buildWorkbenchContextEnvelope } from "@/lib/workbench/context";
import {
  inspectCodexHarnessReadiness,
  startCodexAppServerRun
} from "@/lib/workbench/codex-app-server";
import { ensureWorkbenchSessionWorkspace } from "@/lib/workbench/session-workspace";
import {
  prepareCourseAgentRuntime,
  presentCanonicalCourseAgentPlan
} from "@/lib/workbench/course-agent-runtime";
import { createWorkbenchRouteCourseAgentComposition } from "@/lib/workbench/workbench-course-agent-toolkit-factory";
import { workbenchTaskId } from "@/lib/workbench/course-agent-plan";
import {
  MVP_COURSE_AGENT_GOAL_CODE,
  restoreCourseAgentMvpPlanSelection
} from "@/lib/workbench/course-agent-mvp-planner";
import { loadCurrentCanonicalPlan } from "@/lib/workbench/plan-store";
import { courseAgentGoalAcceptsContext } from "@/lib/workbench/course-agent-task-family";
import { createCourseAgentActionCoordinator } from "@/lib/workbench/course-agent-action-coordinator";
import { createScopedCourseToolGrantAuthority } from "@/lib/workbench/scoped-course-tool-grant-authority";
import {
  deleteCourseAgentProcessSession
} from "@/lib/workbench/course-agent-session";
import type { WorkbenchCourseToolTransport } from "@/lib/workbench/course-tool-transport";
import type { WorkbenchRunSnapshot } from "@/lib/workbench/contracts";
import {
  CourseAgentCheckpointHydratorError,
  type VerifiedCourseAgentRecoveryBundle
} from "@/lib/workbench/course-agent-checkpoint-hydrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(message: string, status: number, code: string) {
  return NextResponse.json(
    { error: message, code },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

function recoveryCheckpointResponse(
  error: unknown
): NextResponse | null {
  if (!(error instanceof CourseAgentCheckpointHydratorError)) {
    return errorResponse(
      "课程恢复材料暂时无法核验，本次未创建重启任务。",
      503,
      "COURSE_AGENT_RECOVERY_LOAD_FAILED"
    );
  }
  if (error.checkpointState === "stage_unknown_requires_reconcile") {
    return errorResponse(
      "上一任务的编辑器暂存结果仍然未知，必须先执行专用核对；为避免重复写入，本次未创建重启任务。",
      409,
      "COURSE_AGENT_STAGE_RECONCILIATION_REQUIRED"
    );
  }
  if (error.checkpointState === "stage_verified_delivery_ready") {
    return errorResponse(
      "上一任务已完成零发布暂存核验，只需从已验证状态生成交付成果；本次未重放已完成动作。",
      409,
      "COURSE_AGENT_DELIVERY_RECOVERY_REQUIRED"
    );
  }
  if (error.checkpointState === "blocked") {
    return errorResponse(
      "上一任务的恢复证据未通过完整性约束，需要人工核查；本次未创建重启任务。",
      409,
      "COURSE_AGENT_RECOVERY_MANUAL_REVIEW_REQUIRED"
    );
  }
  if (error.checkpointState === "completed") {
    return errorResponse(
      "上一任务已经存在完整、已验证的交付成果，无需重放课程动作。",
      409,
      "COURSE_AGENT_RECOVERY_ALREADY_COMPLETED"
    );
  }
  if (
    error.code === "COURSE_AGENT_RECOVERY_CHECKPOINT_UNSUPPORTED" &&
    (
      error.checkpointState === "none" ||
      error.checkpointState === "evidence_replay_required" ||
      error.checkpointState === "composition_verified"
    )
  ) {
    return null;
  }
  return errorResponse(
    "上一任务没有可安全复用的完整恢复材料；本次未创建重启任务。",
    409,
    "COURSE_AGENT_RECOVERY_CHECKPOINT_INVALID"
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = requireTrustedJsonMutation(request, "工作台子任务启动");
  if (guard) return guard;
  if (!isSafeRunId(params.id)) {
    return errorResponse("工作台任务编号无效。", 400, "WORKBENCH_INVALID_ID");
  }

  let input;
  try {
    input = parseWorkbenchLaunchInput(await request.json());
  } catch (error) {
    if (error instanceof WorkbenchInputError) {
      return errorResponse(error.message, error.status, "WORKBENCH_INVALID_LAUNCH");
    }
    return errorResponse("启动请求不是有效 JSON。", 400, "WORKBENCH_INVALID_JSON");
  }

  try {
    await recoverInterruptedWorkbenchRuns();
  } catch {
    return errorResponse("工作台历史恢复失败，请稍后重试。", 503, "WORKBENCH_RECOVERY_FAILED");
  }

  const source = getWorkbenchRun(params.id) ?? await loadPersistentWorkbenchRun(params.id);
  if (!source) {
    return errorResponse("找不到来源任务。", 404, "WORKBENCH_NOT_FOUND");
  }
  const childRunId = deriveWorkbenchChildRunId(source.id, input);
  const existing = getWorkbenchRun(childRunId) ?? await loadPersistentWorkbenchRun(childRunId);
  if (existing) {
    const lineageMatches = isWorkbenchRunLineage(existing.lineage, existing.id) &&
      existing.lineage.parentRunId === source.id &&
      existing.lineage.requestId === input.requestId &&
      existing.lineage.relation === input.kind;
    if (!lineageMatches) {
      return errorResponse("子任务编号发生冲突。", 409, "WORKBENCH_LAUNCH_CONFLICT");
    }
    return NextResponse.json(
      { run: existing, replayed: true },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }

  if (source.source !== "app-server") {
    return errorResponse("演示任务不能创建执行子任务。", 409, "WORKBENCH_DEMO_READ_ONLY");
  }
  if (input.kind === "restart") {
    if (source.status !== "failed" || !source.sessionWorkspace) {
      return errorResponse(
        "只有保留了安全交接目录的失败任务可以重新启动。",
        409,
        "WORKBENCH_RESTART_NOT_AVAILABLE"
      );
    }
  } else if (input.kind === "plan-execution" && (
    source.status !== "completed" ||
    source.collaborationMode !== "plan" ||
    !source.plan?.steps.length
  )) {
    return errorResponse("当前任务没有可执行的已完成计划。", 409, "WORKBENCH_PLAN_NOT_READY");
  } else if (
    input.kind === "continuation" &&
    (source.status !== "completed" || !source.finalResult)
  ) {
    return errorResponse(
      "只有保留了安全完成结果的任务可以继续。",
      409,
      "WORKBENCH_CONTINUATION_NOT_AVAILABLE"
    );
  }

  let lineage;
  try {
    lineage = deriveWorkbenchChildLineage(source, input);
  } catch {
    return errorResponse("任务承接层级已达到上限。", 409, "WORKBENCH_LINEAGE_LIMIT");
  }

  let checkpointRecovery: VerifiedCourseAgentRecoveryBundle | undefined;
  if (
    input.kind === "restart" &&
    source.status === "failed" &&
    source.courseGoalCode === "course_evidence_support_gap" &&
    source.context?.courseAlias &&
    courseAgentGoalAcceptsContext(source.courseGoalCode, source.context)
  ) {
    try {
      checkpointRecovery = await loadWorkbenchCourseRecoveryBundle(prisma, {
        taskId: workbenchTaskId({ id: childRunId, lineage }),
        sourceRunId: source.id,
        childRunId,
        courseAlias: source.context.courseAlias,
        now: new Date()
      });
    } catch (error) {
      const response = recoveryCheckpointResponse(error);
      if (response) return response;
    }
  }

  const readiness = await inspectCodexHarnessReadiness();
  if (!readiness.ready) {
    const message = readiness.code === "CODEX_AUTH_UNAVAILABLE"
      ? "本机执行授权尚未连接，请先完成一次本机授权后重试。"
      : readiness.summary;
    return errorResponse(message, 503, readiness.code);
  }
  if (getActiveWorkbenchRun()) {
    return errorResponse("已有一个工作台任务正在运行。", 429, "WORKBENCH_ACTIVE_RUN");
  }

  const childRequest = checkpointRecovery
    ? buildWorkbenchCourseDraftRecoveryPrompt(source)
    : buildWorkbenchChildPrompt(source, input.kind);
  const collaborationMode = checkpointRecovery || input.kind === "plan-execution"
    ? "default"
    : source.collaborationMode ?? "default";
  const goalMode = Boolean(source.goalMode);

  let run: WorkbenchRunSnapshot;
  try {
    run = createWorkbenchRun({
      runId: childRunId,
      lineage,
      prompt: childRequest.prompt,
      source: "app-server",
      collaborationMode,
      goalMode,
      taskTitle: source.taskTitle,
      context: source.context ? { ...source.context } : undefined,
      courseGoalCode: source.courseGoalCode
    });
  } catch (error) {
    const replay = getWorkbenchRun(childRunId) ?? await loadPersistentWorkbenchRun(childRunId);
    if (replay) {
      return NextResponse.json(
        { run: replay, replayed: true },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (error instanceof Error && error.message === "WORKBENCH_ACTIVE_RUN") {
      return errorResponse("已有一个工作台任务正在运行。", 429, "WORKBENCH_ACTIVE_RUN");
    }
    return errorResponse("子任务未能创建。", 500, "WORKBENCH_CREATE_FAILED");
  }

  if (!checkpointRecovery && source.plan?.steps.length) {
    setWorkbenchPlan(run.id, {
      ...(source.plan.explanation ? { explanation: source.plan.explanation } : {}),
      steps: source.plan.steps.map((step) => ({ ...step }))
    });
    run = getWorkbenchRun(run.id) ?? run;
  }

  await persistWorkbenchRunSnapshot(run).catch(() => undefined);
  try {
    const sessionWorkspace = await ensureWorkbenchSessionWorkspace({
      runId: run.id,
      createdAt: run.createdAt,
      taskTitle: run.taskTitle ?? "课程研判任务",
      lineage: run.lineage,
      sourceRoot: process.cwd()
    });
    run = setWorkbenchSessionWorkspace(run.id, sessionWorkspace) ?? run;
    await persistWorkbenchRunSnapshot(run);
  } catch {
    const failed = completeWorkbenchRun(
      run.id,
      "failed",
      "坚果云会话目录未能建立，本机执行没有启动。",
      "WORKBENCH_SESSION_WORKSPACE_UNAVAILABLE"
    );
    if (failed) await persistWorkbenchRunSnapshot(failed).catch(() => undefined);
    return errorResponse(
      "坚果云会话目录未能建立，请检查同步目录后重试。",
      503,
      "WORKBENCH_SESSION_WORKSPACE_UNAVAILABLE"
    );
  }

  attachWorkbenchPersistence(run.id);
  const executionIntent = checkpointRecovery
    ? "implement"
    : collaborationMode === "plan"
      ? "inspect"
      : "implement";
  let courseToolTransport: WorkbenchCourseToolTransport | undefined;
  if (
    run.context &&
    run.courseGoalCode &&
    courseAgentGoalAcceptsContext(run.courseGoalCode, run.context)
  ) {
    try {
      const composition = createWorkbenchRouteCourseAgentComposition({
        taskId: workbenchTaskId(run),
        runId: run.id,
        courseAlias: run.context.courseAlias!,
        prisma,
        ...(checkpointRecovery?.runtimeRecovery ?? {})
      });
      const toolkit = composition.toolkit;
      const mvpPlan = run.courseGoalCode === MVP_COURSE_AGENT_GOAL_CODE
        ? restoreCourseAgentMvpPlanSelection({
            tools: (await loadCurrentCanonicalPlan(prisma, {
              taskId: workbenchTaskId(source),
              runId: source.id
            }))?.steps.map((step) => ({
              name: step.toolName,
              version: step.toolVersion
            })) ?? [],
            intent: executionIntent,
            registryManifest: toolkit.registry.manifest()
          })
        : undefined;
      const actionCoordinator = createCourseAgentActionCoordinator({
        db: prisma,
        registry: toolkit.registry
      });
      const runtime = await prepareCourseAgentRuntime({
        run,
        goalCode: run.courseGoalCode,
        intent: executionIntent,
        registry: toolkit.registry,
        verifierRegistry: toolkit.verifierRegistry,
        onToolOutcome: toolkit.onToolOutcome,
        actionCoordinator,
        actionPolicyMode: composition.actionPolicyMode,
        ...(composition.autoActionExecutor
          ? { autoActionExecutor: composition.autoActionExecutor }
          : {}),
        grantAuthority: createScopedCourseToolGrantAuthority(prisma),
        ...(mvpPlan ? { mvpPlan } : {}),
        ...(checkpointRecovery
          ? {
              recovery: {
                mode: "regenerate_draft" as const,
                sourceCheckpointRef: checkpointRecovery.checkpoint.checkpointRef,
                sourceCheckpointHash: checkpointRecovery.checkpoint.checkpointHash
              }
            }
          : {}),
        onPlanChanged: (plan) => {
          setWorkbenchPlan(
            run.id,
            presentCanonicalCourseAgentPlan(plan)
          );
        }
      });
      courseToolTransport = runtime.transport;
      composition.registerProcessSession(runtime.transport);
      run = getWorkbenchRun(run.id) ?? run;
      await persistWorkbenchRunSnapshot(run);
    } catch {
      deleteCourseAgentProcessSession(run.id);
      const failed = completeWorkbenchRun(
        run.id,
        "failed",
        "课程工具运行时未能恢复精确证据计划；未执行课程动作。",
        "COURSE_AGENT_RUNTIME_UNAVAILABLE"
      );
      if (failed) {
        await persistWorkbenchRunSnapshot(failed).catch(() => undefined);
      }
      return errorResponse(
        "课程工具运行时未能恢复精确证据计划，请核对课程锚点后重试。",
        503,
        "COURSE_AGENT_RUNTIME_UNAVAILABLE"
      );
    }
  }
  const prompt = source.context
    ? `${buildWorkbenchContextEnvelope(source.context)}\n\n${childRequest.prompt}`
    : childRequest.prompt;
  void startCodexAppServerRun(run.id, prompt, {
    collaborationMode,
    goalMode,
    courseGoalCode: run.courseGoalCode,
    executionIntent,
    courseToolTransport,
    priorActionReceipts: []
  }).catch(async () => {
    deleteCourseAgentProcessSession(run.id);
    const failed = completeWorkbenchRun(
      run.id,
      "failed",
      "本机执行任务未能启动。",
      "CODEX_START_FAILED"
    );
    if (failed) {
      await persistWorkbenchRunSnapshot(failed).catch(() => undefined);
    }
  });

  return NextResponse.json(
    { run, replayed: false, displayPrompt: childRequest.displayPrompt },
    { status: 202, headers: { "Cache-Control": "no-store" } }
  );
}
