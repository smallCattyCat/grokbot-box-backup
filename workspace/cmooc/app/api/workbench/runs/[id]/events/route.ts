import { NextRequest } from "next/server";
import {
  isSafeRunId,
  isTerminalWorkbenchStatus,
  type WorkbenchEvent,
  type WorkbenchRunSnapshot
} from "@/lib/workbench/contracts";
import {
  getWorkbenchEventsAfter,
  getWorkbenchRun,
  subscribeWorkbenchRun
} from "@/lib/workbench/run-store";
import {
  loadPersistentWorkbenchRun,
  recoverInterruptedWorkbenchRuns
} from "@/lib/workbench/history-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseAfter(request: NextRequest): number {
  const queryValue = request.nextUrl.searchParams.get("after");
  const headerValue = request.headers.get("last-event-id");
  const value = queryValue ?? headerValue ?? "0";
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function sseEvent(event: WorkbenchEvent): string {
  return `id: ${event.seq}\nevent: workbench_event\ndata: ${JSON.stringify(event)}\n\n`;
}

function sseSnapshot(snapshot: WorkbenchRunSnapshot): string {
  return `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

function sseReset(snapshot: WorkbenchRunSnapshot): string {
  return `id: ${snapshot.lastEventSeq}\nevent: reset\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const id = params.id;
  if (!isSafeRunId(id)) {
    return new Response(JSON.stringify({ error: "工作台任务编号无效。" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }
  try {
    await recoverInterruptedWorkbenchRuns();
  } catch {
    return new Response(
      JSON.stringify({
        error: "工作台历史恢复失败，请稍后重试。",
        code: "WORKBENCH_RECOVERY_FAILED"
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
      }
    );
  }
  const snapshot = getWorkbenchRun(id) ?? (await loadPersistentWorkbenchRun(id));
  if (!snapshot) {
    return new Response(JSON.stringify({ error: "找不到工作台任务。" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }

  if (!getWorkbenchRun(id)) {
    return new Response(sseSnapshot(snapshot), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "X-Accel-Buffering": "no"
      }
    });
  }

  const after = parseAfter(request);
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let replaying = true;
  let lastSent = after;
  const pending: WorkbenchEvent[] = [];

  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    if (heartbeat) clearInterval(heartbeat);
  };

  const enqueue = (text: string) => {
    if (closed || !controllerRef) return;
    try {
      controllerRef.enqueue(encoder.encode(text));
    } catch {
      close();
    }
  };

  const closeController = () => {
    if (closed) return;
    close();
    try {
      controllerRef?.close();
    } catch {
      // A disconnected client is already closed.
    }
  };

  const enqueueSnapshot = (current: WorkbenchRunSnapshot) => {
    enqueue(sseSnapshot(current));
    if (isTerminalWorkbenchStatus(current.status)) closeController();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      unsubscribe = subscribeWorkbenchRun(id, (event) => {
        if (event.seq <= lastSent) return;
        if (replaying) {
          pending.push(event);
          return;
        }
        lastSent = event.seq;
        enqueue(sseEvent(event));
        const current = getWorkbenchRun(id);
        if (current) enqueueSnapshot(current);
      });
      const latest = getWorkbenchRun(id) ?? snapshot;
      const staleCursor = after > 0 && latest.firstEventSeq > after + 1;
      if (staleCursor) {
        enqueue(sseReset(latest));
        if (isTerminalWorkbenchStatus(latest.status)) {
          closeController();
          return;
        }
        replaying = false;
        heartbeat = setInterval(() => enqueue(": heartbeat\n\n"), 15_000);
        request.signal.addEventListener("abort", close, { once: true });
        return;
      }
      enqueueSnapshot(latest);
      if (closed) return;
      const replay = getWorkbenchEventsAfter(id, after) ?? [];
      for (const event of replay) {
        if (event.seq <= lastSent) continue;
        lastSent = event.seq;
        enqueue(sseEvent(event));
        const current = getWorkbenchRun(id);
        if (current) enqueueSnapshot(current);
        if (closed) return;
      }
      replaying = false;
      for (const event of pending.splice(0)) {
        if (event.seq <= lastSent) continue;
        lastSent = event.seq;
        enqueue(sseEvent(event));
        const current = getWorkbenchRun(id);
        if (current) enqueueSnapshot(current);
        if (closed) return;
      }
      heartbeat = setInterval(() => enqueue(": heartbeat\n\n"), 15_000);
      request.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      close();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
