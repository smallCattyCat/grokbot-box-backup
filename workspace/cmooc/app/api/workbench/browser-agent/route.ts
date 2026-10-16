import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  BrowserCourseError, verifyBrowserBridge, getBrowserWorkspace, claimBrowserCourseRun,
  recordBrowserObservation, recordBrowserProposals, recordBrowserReplyReceipt, recordBrowserStage, finishBrowserRun, reportBrowserAttention, reportBrowserReloginRequired, readBrowserGuidance
} from "@/lib/workbench/browser-course-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json" || !await verifyBrowserBridge(request.headers.get("x-course-bridge-key"))) return NextResponse.json({ error: "课程执行连接尚未授权。" }, { status: 403 });
  if (Number(request.headers.get("content-length") || 0) > 1_500_000) return NextResponse.json({ error: "观察记录过大，请缩小本轮范围。" }, { status: 413 });
  try {
    const raw = await request.text(); if (raw.length > 1_500_000) throw new BrowserCourseError("BODY_LIMIT", "观察记录过大。", 413);
    const body = z.object({ action: z.enum(["workspace", "claim", "patrol_begin", "observation", "proposals", "reply_receipt", "stage", "finish", "patrol_end", "attention", "relogin_required", "guidance"]), runId: z.string().uuid().optional(), executionRunId: z.string().uuid().optional(), owner: z.string().uuid(), leaseToken: z.string().optional(), operationKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional(), observation: z.unknown().optional(), proposals: z.unknown().optional(), receipt: z.unknown().optional(), summary: z.string().max(800).optional(), message: z.string().max(500).optional() }).strict().parse(JSON.parse(raw));
    if (body.action === "workspace") {
      const workspace = await getBrowserWorkspace();
      const runs = workspace.runs.filter((r) => !body.runId || r.id === body.runId);
      return NextResponse.json({ courses: workspace.courses.filter((c) => !body.runId || runs.some((r) => r.courseId === c.id)), runs: runs.map((r) => ({ id: r.id, courseId: r.courseId, status: r.status, goal: r.goal, mode: r.mode })) });
    }
    const id = z.string().uuid().parse(body.runId); let value: unknown;
    if (body.action === "claim" || body.action === "patrol_begin") value = await claimBrowserCourseRun(id, body.owner, body.executionRunId);
    else {
      const token = z.string().min(1).parse(body.leaseToken);
      if (body.action === "guidance") value = await readBrowserGuidance(id, body.owner, token);
      if (body.action === "observation") value = await recordBrowserObservation(id, body.owner, token, body.observation, body.operationKey);
      if (body.action === "proposals") value = await recordBrowserProposals(id, body.owner, token, body.proposals, body.operationKey);
      if (body.action === "reply_receipt") value = await recordBrowserReplyReceipt(id, body.owner, token, body.receipt, body.operationKey);
      if (body.action === "stage") value = await recordBrowserStage(id, body.owner, token, body.receipt, body.operationKey);
      if (body.action === "finish" || body.action === "patrol_end") value = await finishBrowserRun(id, body.owner, token, body.summary || "本轮课程观察已完成。", body.operationKey);
      if (body.action === "attention") {
        value = await reportBrowserAttention(id, body.owner, token, body.message || "当前任务需要检查。");
      }
      if (body.action === "relogin_required") value = await reportBrowserReloginRequired(id, body.owner, token, body.message || "课程登录已失效，请重新登录后继续。");
    }
    return NextResponse.json(value, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof BrowserCourseError ? error.message : "课程工具参数或观察结构无效。", code: error instanceof BrowserCourseError ? error.code : "INPUT_INVALID" }, { status: error instanceof BrowserCourseError ? error.status : 400 });
  }
}
