import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  WorkbenchInputError,
  parseCreateRunInput
} from "@/lib/workbench/contracts";
import {
  createWorkbenchRun,
  getActiveWorkbenchRun,
  completeWorkbenchRun,
  getWorkbenchRun,
  setWorkbenchPlan,
  setWorkbenchSessionWorkspace
} from "@/lib/workbench/run-store";
import { scheduleDemoRun } from "@/lib/workbench/demo-events";
import {
  inspectCodexHarnessReadiness,
  startCodexAppServerRun
} from "@/lib/workbench/codex-app-server";
import {
  buildWorkbenchContextEnvelope,
  resolveWorkbenchContext
} from "@/lib/workbench/context";
import {
  attachWorkbenchPersistence,
  listPersistentWorkbenchRuns,
  persistWorkbenchRunSnapshot,
  recoverInterruptedWorkbenchRuns
} from "@/lib/workbench/history-store";
import { ensureWorkbenchSessionWorkspace } from "@/lib/workbench/session-workspace";
import {
  prepareCourseAgentRuntime,
  presentCanonicalCourseAgentPlan
} from "@/lib/workbench/course-agent-runtime";
import { createWorkbenchRouteCourseAgentComposition } from "@/lib/workbench/workbench-course-agent-toolkit-factory";
import { workbenchTaskId } from "@/lib/workbench/course-agent-plan";
import {
  MVP_COURSE_AGENT_GOAL_CODE,
  planCourseAgentMvpGoal
} from "@/lib/workbench/course-agent-mvp-planner";
import {
  classifyCourseAgentTaskFamily,
  courseAgentGoalAcceptsContext
} from "@/lib/workbench/course-agent-task-family";
import { createCourseAgentActionCoordinator } from "@/lib/workbench/course-agent-action-coordinator";
import { createScopedCourseToolGrantAuthority } from "@/lib/workbench/scoped-course-tool-grant-authority";
import type { WorkbenchCourseToolTransport } from "@/lib/workbench/course-tool-transport";
import type { WorkbenchRunSnapshot } from "@/lib/workbench/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(message: string, status: number, code?: string): NextResponse {
  return NextResponse.json(
    { error: message, ...(code ? { code } : {}) },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

export async function GET(request: NextRequest) {
  const limit = Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "12", 10);
  let runs;
  try {
    runs = await listPersistentWorkbenchRuns(Number.isFinite(limit) ? limit : 12);
  } catch {
    return errorResponse(
      "工作台历史恢复失败，请稍后重试。",
      503,
      "WORKBENCH_RECOVERY_FAILED"
    );
  }
  return NextResponse.json(
    { schemaVersion: "cmooc.workbench-history.v1", runs, containsForumText: false },
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: NextRequest) {
  const guard = requireTrustedJsonMutation(request, "工作台任务");
  if (guard) return guard;

  let input;
  try {
    input = parseCreateRunInput(await request.json());
  } catch (error) {
    if (error instanceof WorkbenchInputError) {
      return errorResponse(error.message, error.status);
    }
    return errorResponse("任务请求不是有效 JSON。", 400, "WORKBENCH_INVALID_JSON");
  }

  try {
    await recoverInterruptedWorkbenchRuns();
  } catch {
    return errorResponse(
      "工作台历史恢复失败，请稍后重试。",
      503,
      "WORKBENCH_RECOVERY_FAILED"
    );
  }

  if (getActiveWorkbenchRun()) {
    return errorResponse("已有一个工作台任务正在运行。", 429, "WORKBENCH_ACTIVE_RUN");
  }
  if (input.mode === "live") {
    const readiness = await inspectCodexHarnessReadiness();
    if (!readiness.ready) {
      const message = readiness.code === "CODEX_AUTH_UNAVAILABLE"
        ? "本机执行授权尚未连接，请先完成一次本机授权后重试。"
        : readiness.summary;
      return errorResponse(message, 503, readiness.code);
    }
  }

  const context = input.contextRef
    ? await resolveWorkbenchContext(input.contextRef)
    : undefined;
  if (input.contextRef && !context) {
    return errorResponse(
      "课程上下文已经不可用，请刷新工作台后重试。",
      404,
      "WORKBENCH_CONTEXT_NOT_FOUND"
    );
  }
  const classification = context
    ? classifyCourseAgentTaskFamily(input.prompt)
    : null;
  const classifiedGoalCode = classification?.goalCode ??
    (context ? MVP_COURSE_AGENT_GOAL_CODE : null);
  const courseGoalCode =
    context &&
    classifiedGoalCode &&
    courseAgentGoalAcceptsContext(classifiedGoalCode, context)
      ? classifiedGoalCode
      : undefined;

  let run: WorkbenchRunSnapshot;
  try {
    run = createWorkbenchRun({
      prompt: input.prompt,
      source: input.mode === "demo" ? "demo" : "app-server",
      collaborationMode: input.collaborationMode ?? "default",
      goalMode: input.goalMode ?? false,
      taskTitle: context?.title,
      context: context ?? undefined,
      courseGoalCode
    });
  } catch (error) {
    if (error instanceof Error && error.message === "WORKBENCH_ACTIVE_RUN") {
      return errorResponse("已有一个工作台任务正在运行。", 429, "WORKBENCH_ACTIVE_RUN");
    }
    return errorResponse("工作台任务未能创建。", 500, "WORKBENCH_CREATE_FAILED");
  }

  if (input.mode === "live") {
    try {
      const sessionWorkspace = await ensureWorkbenchSessionWorkspace({
        runId: run.id,
        createdAt: run.createdAt,
        taskTitle: run.taskTitle ?? context?.title ?? "课程研判任务",
        lineage: run.lineage,
        sourceRoot: process.cwd()
      });
      run = setWorkbenchSessionWorkspace(run.id, sessionWorkspace) ?? run;
    } catch {
      completeWorkbenchRun(
        run.id,
        "failed",
        "坚果云会话目录未能建立，本机执行没有启动。",
        "WORKBENCH_SESSION_WORKSPACE_UNAVAILABLE"
      );
      const failed = getWorkbenchRun(run.id);
      if (failed) await persistWorkbenchRunSnapshot(failed).catch(() => undefined);
      return errorResponse(
        "坚果云会话目录未能建立，请检查同步目录后重试。",
        503,
        "WORKBENCH_SESSION_WORKSPACE_UNAVAILABLE"
      );
    }
  }

  if (input.mode === "demo") {
    await persistWorkbenchRunSnapshot(run).catch(() => undefined);
    attachWorkbenchPersistence(run.id);
    scheduleDemoRun(run.id);
  } else {
    await persistWorkbenchRunSnapshot(run).catch(() => undefined);
    attachWorkbenchPersistence(run.id);
    const executionIntent =
      input.intent === "inspect" || input.intent === "summarize"
        ? "inspect"
        : "implement";
    let courseToolTransport: WorkbenchCourseToolTransport | undefined;
    if (
      context &&
      run.courseGoalCode
    ) {
      try {
        const composition = createWorkbenchRouteCourseAgentComposition({
          taskId: workbenchTaskId(run),
          runId: run.id,
          courseAlias: context.courseAlias!,
          prisma
        });
        const toolkit = composition.toolkit;
        const mvpPlan = run.courseGoalCode === MVP_COURSE_AGENT_GOAL_CODE
          ? await planCourseAgentMvpGoal({
              prompt: input.prompt,
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
        completeWorkbenchRun(
          run.id,
          "failed",
          "课程工具运行时未能绑定精确证据计划；未执行课程动作。",
          "COURSE_AGENT_RUNTIME_UNAVAILABLE"
        );
        const failed = getWorkbenchRun(run.id);
        if (failed) {
          await persistWorkbenchRunSnapshot(failed).catch(() => undefined);
        }
        return errorResponse(
          "课程工具运行时未能绑定精确证据计划，请核对课程锚点后重试。",
          503,
          "COURSE_AGENT_RUNTIME_UNAVAILABLE"
        );
      }
    }
    const prompt = context
      ? `${buildWorkbenchContextEnvelope(context)}\n\n用户任务：\n${input.prompt}`
      : input.prompt;
    void startCodexAppServerRun(run.id, prompt, {
      collaborationMode: input.collaborationMode ?? "default",
      goalMode: input.goalMode ?? false,
      courseGoalCode: run.courseGoalCode,
      executionIntent,
      courseToolTransport,
      priorActionReceipts: input.priorActionReceipts ?? []
    }).catch(() => {
      completeWorkbenchRun(
        run.id,
        "failed",
        "本机执行任务未能启动。",
        "CODEX_START_FAILED"
      );
    });
  }

  return NextResponse.json(
    { run },
    { status: 202, headers: { "Cache-Control": "no-store" } }
  );
}
