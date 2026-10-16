import { NextRequest, NextResponse } from "next/server";
import { isSafeRunId } from "@/lib/workbench/contracts";
import { getWorkbenchRun } from "@/lib/workbench/run-store";
import {
  loadPersistentWorkbenchRun,
  recoverInterruptedWorkbenchRuns
} from "@/lib/workbench/history-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const id = params.id;
  if (!isSafeRunId(id)) {
    return NextResponse.json(
      { error: "工作台任务编号无效。", code: "WORKBENCH_INVALID_ID" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
  try {
    await recoverInterruptedWorkbenchRuns();
  } catch {
    return NextResponse.json(
      {
        error: "工作台历史恢复失败，请稍后重试。",
        code: "WORKBENCH_RECOVERY_FAILED"
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  const run = getWorkbenchRun(id) ?? (await loadPersistentWorkbenchRun(id));
  if (!run) {
    return NextResponse.json(
      { error: "找不到工作台任务。", code: "WORKBENCH_NOT_FOUND" },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.json(run, {
    status: 200,
    headers: { "Cache-Control": "no-store" }
  });
}
