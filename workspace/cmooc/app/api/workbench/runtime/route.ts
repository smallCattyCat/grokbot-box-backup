import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  inspectCodexHarnessReadiness,
  startCodexInteractiveLogin
} from "@/lib/workbench/codex-app-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET() {
  const readiness = await inspectCodexHarnessReadiness();
  if (readiness.ready) {
    return NextResponse.json(
      {
        status: "ready",
        summary: "本机执行已连接。",
        canStartAuthorization: false
      },
      { headers: NO_STORE }
    );
  }
  if (readiness.code === "CODEX_AUTH_UNAVAILABLE") {
    return NextResponse.json(
      {
        status: "auth-required",
        summary: readiness.summary,
        canStartAuthorization: true
      },
      { headers: NO_STORE }
    );
  }
  return NextResponse.json(
    {
      status: "unavailable",
      summary: readiness.summary,
      canStartAuthorization: false
    },
    { headers: NO_STORE }
  );
}

export async function POST(request: NextRequest) {
  const guard = requireTrustedJsonMutation(request, "本机执行授权");
  if (guard) return guard;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "授权请求不是有效 JSON。", code: "WORKBENCH_RUNTIME_INVALID_JSON" },
      { status: 400, headers: NO_STORE }
    );
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length > 0
  ) {
    return NextResponse.json(
      { error: "授权请求包含不支持的字段。", code: "WORKBENCH_RUNTIME_INVALID_INPUT" },
      { status: 400, headers: NO_STORE }
    );
  }

  const result = await startCodexInteractiveLogin();
  if (result.status === "ready") {
    return NextResponse.json(
      { status: "ready", summary: result.summary, canStartAuthorization: false },
      { headers: NO_STORE }
    );
  }
  if (result.status === "started" || result.status === "already-running") {
    return NextResponse.json(
      {
        status: "authorizing",
        summary: result.summary,
        canStartAuthorization: false
      },
      { status: result.status === "started" ? 202 : 200, headers: NO_STORE }
    );
  }
  if (result.status === "unavailable") {
    return NextResponse.json(
      {
        status: "unavailable",
        summary: result.summary,
        canStartAuthorization: result.code === "CODEX_LOGIN_START_FAILED"
      },
      { status: 503, headers: NO_STORE }
    );
  }
  return NextResponse.json(
    {
      status: "unavailable",
      summary: "本机授权页面未能打开。",
      canStartAuthorization: true
    },
    { status: 503, headers: NO_STORE }
  );
}
