import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  addBrowserCourse, BrowserCourseError, browserBridgeSecret, createBrowserCourseRun, editBrowserDraft,
  getBrowserWorkspace, interruptBrowserRun, resumeBrowserRun, appendBrowserGuidance, markBrowserGuidanceDelivered
} from "@/lib/workbench/browser-course-store";
import { stopWorkbenchRun, steerWorkbenchRun } from "@/lib/workbench/run-store";
import { companionContextSchema, quoteCompanionContext } from "@/lib/workbench/companion-context";
import { createBrowserCourseSchema, isLocalCourseFixture } from "@/lib/workbench/browser-course-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function reply(value: unknown, status = 200) { return NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } }); }
export async function GET() {
  try { await browserBridgeSecret(); return reply(await getBrowserWorkspace()); }
  catch { return reply({ error: "课程工作区暂时无法读取，请稍后重试。" }, 503); }
}

export async function POST(request: NextRequest) {
  const guard = requireTrustedJsonMutation(request, "课程工作区"); if (guard) return guard;
  // The guard has matched Origin to the trusted Host. Next's internal URL can normalize 127.0.0.1 to localhost.
  const origin = new URL(request.headers.get("origin")!).origin;
  try {
    const raw = await request.text(); if (raw.length > 12_000) throw new BrowserCourseError("BODY_LIMIT", "请求过长。", 413);
    const body = z.discriminatedUnion("action", [
      z.object({ action: z.literal("add"), course: createBrowserCourseSchema }).strict(),
      z.object({ action: z.literal("run"), courseId: z.string().uuid(), requestId: z.string().uuid(), goal: z.string().trim().min(1).max(800).optional(), mode: z.enum(["observe", "stage"]), executor: z.enum(["codex_host", "codex_app_server"]) }).strict(),
      z.object({ action: z.literal("stop"), runId: z.string().uuid() }).strict(),
      z.object({ action: z.literal("resume"), runId: z.string().uuid() }).strict(),
      z.object({ action: z.literal("message"), runId: z.string().uuid(), requestId: z.string().uuid(), text: z.string().trim().min(1).max(4000), context: companionContextSchema.optional() }).strict(),
      z.object({ action: z.literal("edit"), runId: z.string().uuid(), proposalId: z.string().uuid(), revision: z.number().int().positive(), draft: z.string().trim().min(1).max(1600) }).strict()
    ]).parse(JSON.parse(raw));
    if (body.action === "add") return reply({ course: await addBrowserCourse(body.course) });
    if (body.action === "edit") return reply({ run: await editBrowserDraft(body.runId, body.proposalId, body.revision, body.draft) });
    if (body.action === "message") {
      const saved = await appendBrowserGuidance(body.runId, { requestId: body.requestId, text: body.text, ...(body.context ? { context: body.context } : {}) });
      let run = saved.run;
      if (!saved.replay && run.executor === "codex_app_server" && run.status === "running") {
        try {
          const prompt = `${body.text}${body.context ? `\n\n${quoteCompanionContext(body.context)}` : ""}\n课程范围与运行模式保持原绑定；请读取最新教师补充。`;
          const delivered = await steerWorkbenchRun(run.executionRunId || run.id, prompt, []);
          if (delivered) run = await markBrowserGuidanceDelivered(run.id, saved.messageId);
        } catch { /* Durable saved guidance is picked up by the next claim/read; never claim delivery. */ }
      }
      return reply({ run, delivery: run.messages?.find((m) => m.id === saved.messageId)?.delivery ?? "saved" });
    }
    if (body.action === "stop") {
      const run = await interruptBrowserRun(body.runId);
      if (run.executor === "codex_app_server") await stopWorkbenchRun(run.executionRunId || body.runId).catch(() => undefined);
      return reply({ run });
    }
    if (body.action === "resume") {
      const state = await getBrowserWorkspace(); const previous = state.runs.find((r) => r.id === body.runId);
      if (!previous) throw new BrowserCourseError("RUN_MISSING", "任务不存在。", 404);
      if (previous.executor === "codex_host") return reply({ run: await resumeBrowserRun(previous.id) });
      const course = state.courses.find((c) => c.id === previous.courseId)!;
      if (!isLocalCourseFixture(course.entryUrl) || new URL(course.entryUrl).origin !== origin) throw new BrowserCourseError("HOST_REQUIRED", "请从课程绑定的工作台地址继续。", 409);
      return reply({ run: await resumeBrowserRun(previous.id, origin) }, 202);
    }
    const state = await getBrowserWorkspace();
    const replay = state.runs.find((r) => r.requestId === body.requestId);
    if (replay) {
      if (replay.courseId !== body.courseId || replay.mode !== body.mode || replay.executor !== body.executor) throw new BrowserCourseError("REQUEST_CONFLICT", "请求编号与原任务不一致。", 409);
      return reply({ run: replay });
    }
    if (body.executor === "codex_host") return reply({ run: await createBrowserCourseRun(body) });
    const course = state.courses.find((c) => c.id === body.courseId);
    if (!course || !isLocalCourseFixture(course.entryUrl) || new URL(course.entryUrl).origin !== origin) throw new BrowserCourseError("HOST_REQUIRED", "请在 Codex 原生浏览器中接手这门课程。", 409);
    return reply({ run: await createBrowserCourseRun({ ...body, dispatchOrigin: origin }) }, 202);
  } catch (error) {
    return reply({ error: error instanceof BrowserCourseError ? error.message : error instanceof z.ZodError ? error.issues[0]?.message || "请求格式无效。" : "课程操作未完成，请稍后重试。", code: error instanceof BrowserCourseError ? error.code : "INPUT_INVALID" }, error instanceof BrowserCourseError ? error.status : 400);
  }
}
