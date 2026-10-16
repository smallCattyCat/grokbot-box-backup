import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  WorkbenchInputError,
  isSafeRunId,
  parseMessageInput
} from "@/lib/workbench/contracts";
import {
  getWorkbenchRun,
  steerWorkbenchRun
} from "@/lib/workbench/run-store";
import {
  attachWorkbenchPersistence,
  persistWorkbenchRunSnapshot
} from "@/lib/workbench/history-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function responseError(message: string, status: number, code?: string) {
  return NextResponse.json(
    { error: message, ...(code ? { code } : {}) },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = requireTrustedJsonMutation(request, "工作台追加引导");
  if (guard) return guard;
  if (!isSafeRunId(params.id)) return responseError("工作台任务编号无效。", 400, "WORKBENCH_INVALID_ID");

  let input;
  try {
    input = parseMessageInput(await request.json());
  } catch (error) {
    if (error instanceof WorkbenchInputError) return responseError(error.message, error.status);
    return responseError("追加引导请求不是有效 JSON。", 400, "WORKBENCH_INVALID_JSON");
  }

  const run = getWorkbenchRun(params.id);
  if (!run) return responseError("找不到工作台任务。", 404, "WORKBENCH_NOT_FOUND");
  if (run.source !== "app-server") {
    return responseError("演示运行不接受追加引导。", 409, "WORKBENCH_DEMO_READ_ONLY");
  }
  const attachedContextRef = input.priorActionReceipts?.find(
    (receipt) => receipt.actionType === "context.attach_focused"
  )?.contextRef;
  if (attachedContextRef && attachedContextRef !== run.context?.ref) {
    return responseError(
      "页面上下文回执与当前任务上下文不一致。",
      409,
      "WORKBENCH_CONTEXT_MISMATCH"
    );
  }

  try {
    attachWorkbenchPersistence(params.id);
    const updated = await steerWorkbenchRun(
      params.id,
      input.prompt,
      input.priorActionReceipts ?? []
    );
    if (!updated) return responseError("找不到工作台任务。", 404, "WORKBENCH_NOT_FOUND");
    await persistWorkbenchRunSnapshot(updated).catch(() => undefined);
    return NextResponse.json(
      { run: updated },
      { status: 202, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof Error && error.message === "WORKBENCH_ACTIVE_RUN") {
      return responseError("已有另一个工作台任务正在运行。", 429, "WORKBENCH_ACTIVE_RUN");
    }
    if (error instanceof Error && error.message === "WORKBENCH_SESSION_UNAVAILABLE") {
      return responseError("当前任务会话不可用。", 503, "WORKBENCH_SESSION_UNAVAILABLE");
    }
    if (error instanceof Error && error.message === "WORKBENCH_ACTION_PENDING") {
      return responseError(
        "当前有一项精确操作等待决定；请先批准或拒绝该操作。",
        409,
        "WORKBENCH_ACTION_PENDING"
      );
    }
    return responseError("追加引导未能提交。", 409, "WORKBENCH_STEER_FAILED");
  }
}
