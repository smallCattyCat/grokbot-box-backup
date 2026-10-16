import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import { isSafeRunId } from "@/lib/workbench/contracts";
import {
  getWorkbenchRun,
  stopWorkbenchRun
} from "@/lib/workbench/run-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = requireTrustedJsonMutation(request, "停止工作台任务");
  if (guard) return guard;
  if (!isSafeRunId(params.id)) {
    return NextResponse.json(
      { error: "工作台任务编号无效。", code: "WORKBENCH_INVALID_ID" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "停止请求必须是精确的空 JSON 对象。", code: "WORKBENCH_STOP_BODY" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body as Record<string, unknown>).length !== 0
  ) {
    return NextResponse.json(
      { error: "停止请求必须是精确的空 JSON 对象。", code: "WORKBENCH_STOP_BODY" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  if (!getWorkbenchRun(params.id)) {
    return NextResponse.json(
      { error: "找不到工作台任务。", code: "WORKBENCH_NOT_FOUND" },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }
  const run = await stopWorkbenchRun(params.id);
  return NextResponse.json(
    { run },
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}
