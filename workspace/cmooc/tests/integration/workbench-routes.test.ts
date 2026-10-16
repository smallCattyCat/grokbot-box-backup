import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "../../lib/db";
import {
  appendWorkbenchEvent,
  completeWorkbenchRun,
  createWorkbenchRun,
  getActiveWorkbenchRun,
  getWorkbenchRun,
  resetWorkbenchStoreForTests,
  setWorkbenchPendingAction,
  setWorkbenchPlan,
  setWorkbenchRunStatus,
  setWorkbenchSessionWorkspace,
  setWorkbenchGoal,
  WORKBENCH_EVENT_RING_LIMIT
} from "../../lib/workbench/run-store";
import { resetDemoRunsForTests } from "../../lib/workbench/demo-events";
import {
  loadPersistentWorkbenchRun,
  persistWorkbenchRunSnapshot,
  resetWorkbenchHistorySubscriptionsForTests
} from "../../lib/workbench/history-store";
import {
  resetCodexAppServerForTests,
  setCodexLoginLauncherForTests,
  setCodexRuntimeProbeForTests,
  startCodexAppServerRun,
  setWorkbenchTransportFactory,
  type CodexTransport
} from "../../lib/workbench/codex-app-server";
import {
  ensureWorkbenchSessionWorkspace,
  resetWorkbenchSessionWorkspaceForTests,
  setWorkbenchSessionWorkspaceRootForTests,
  syncWorkbenchSessionWorkspace
} from "../../lib/workbench/session-workspace";
import { WORKBENCH_LINEAGE_SCHEMA_VERSION } from "../../lib/workbench/contracts";
import { COURSE_AGENT_ACTION_COORDINATOR_SCHEMA_VERSION } from "../../lib/workbench/course-agent-action-coordinator";
import {
  getCourseAgentProcessSession,
  registerCourseAgentProcessSession,
  resetCourseAgentProcessSessionsForTests
} from "../../lib/workbench/course-agent-session";
import {
  deriveWorkbenchChildRunId,
  setWorkbenchCourseRecoveryBundleLoaderForTests
} from "../../lib/workbench/launch";
import type { CourseAgentToolkit } from "../../lib/workbench/course-agent-toolkit";
import type { WorkbenchCourseToolTransport } from "../../lib/workbench/course-tool-transport";
import {
  CourseAgentCheckpointHydratorError,
  type VerifiedCourseAgentRecoveryBundle
} from "../../lib/workbench/course-agent-checkpoint-hydrator";

type RouteHandlers = {
  create: typeof import("../../app/api/workbench/runs/route");
  runtime: typeof import("../../app/api/workbench/runtime/route");
  get: typeof import("../../app/api/workbench/runs/[id]/route");
  stop: typeof import("../../app/api/workbench/runs/[id]/stop/route");
  messages: typeof import("../../app/api/workbench/runs/[id]/messages/route");
  events: typeof import("../../app/api/workbench/runs/[id]/events/route");
};

async function loadRoutes(): Promise<RouteHandlers> {
  const [create, runtime, get, stop, messages, events] = await Promise.all([
    import("../../app/api/workbench/runs/route"),
    import("../../app/api/workbench/runtime/route"),
    import("../../app/api/workbench/runs/[id]/route"),
    import("../../app/api/workbench/runs/[id]/stop/route"),
    import("../../app/api/workbench/runs/[id]/messages/route"),
    import("../../app/api/workbench/runs/[id]/events/route")
  ]);
  return { create, runtime, get, stop, messages, events };
}

let routeSessionProjectRoot = "";
let routeSessionRoot = "";

beforeEach(async () => {
  await resetWorkbenchHistorySubscriptionsForTests();
  resetWorkbenchStoreForTests();
  resetDemoRunsForTests();
  resetCodexAppServerForTests();
  resetCourseAgentProcessSessionsForTests();
  setWorkbenchCourseRecoveryBundleLoaderForTests(undefined);
  routeSessionProjectRoot = await mkdtemp(path.join(tmpdir(), "cmooc-route-session-"));
  routeSessionRoot = path.join(routeSessionProjectRoot, "智能控制台会话");
  setWorkbenchSessionWorkspaceRootForTests(routeSessionRoot);
});

afterEach(async () => {
  await resetWorkbenchHistorySubscriptionsForTests();
  resetWorkbenchStoreForTests();
  resetDemoRunsForTests();
  resetCodexAppServerForTests();
  resetCourseAgentProcessSessionsForTests();
  setWorkbenchCourseRecoveryBundleLoaderForTests(undefined);
  resetWorkbenchSessionWorkspaceForTests();
  if (routeSessionProjectRoot) {
    await rm(routeSessionProjectRoot, { recursive: true, force: true });
  }
  routeSessionProjectRoot = "";
  routeSessionRoot = "";
});

function trustedMutationRequest(
  pathname: string,
  body: unknown,
  overrides: Record<string, string> = {}
): NextRequest {
  return new NextRequest(`http://localhost:3000${pathname}`, {
    method: "POST",
    headers: {
      Host: "localhost:3000",
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
      "Sec-Fetch-Site": "same-origin",
      ...overrides
    },
    body: JSON.stringify(body)
  });
}

function trustedGetRequest(pathname: string): NextRequest {
  return new NextRequest(`http://localhost:3000${pathname}`, {
    headers: {
      Host: "localhost:3000",
      Origin: "http://localhost:3000",
      "Sec-Fetch-Site": "same-origin"
    }
  });
}

async function installRouteCourseManifestFixture(): Promise<() => void> {
  const manifestRoot = path.join(routeSessionProjectRoot, "course-manifests");
  await mkdir(manifestRoot, { recursive: true });
  await writeFile(
    path.join(manifestRoot, "governance-cli-fixture-course.json"),
    JSON.stringify({
      schemaVersion: "cmooc.course-manifest.v1",
      alias: "governance-cli-fixture",
      platformId: "cmooc.bnu",
      courseId: "12345678",
      canonicalUrl: "https://example.test/course?courseId=12345678&isBack=1",
      allowedOrigins: ["https://example.test"],
      adapterId: "workbench.route.fixture",
      timeZone: "UTC",
      defaultMode: "SHADOW",
      policyVersion: "governance.cli.fixture.v1",
      scan: { maxThreadsPerTick: 5, maxCommentsPerThread: 5, pageSize: 5 },
      budget: { dailySlots: 2, workloadCost: 1, authorTouchLimit30d: 1 },
      schedule: { intervalMinutes: 30, leaseSeconds: 30 },
      realPublishEnabled: false
    }),
    "utf8"
  );
  const previous = process.env.CMOOC_COURSE_MANIFEST_DIR;
  process.env.CMOOC_COURSE_MANIFEST_DIR = manifestRoot;
  return () => {
    if (previous === undefined) {
      delete process.env.CMOOC_COURSE_MANIFEST_DIR;
    } else {
      process.env.CMOOC_COURSE_MANIFEST_DIR = previous;
    }
  };
}

async function createFailedSupportGapRouteParent(input: {
  collaborationMode?: "default" | "plan";
  parentPlanMarker?: string;
} = {}) {
  const parent = createWorkbenchRun({
    prompt: "private support-gap route fixture",
    source: "app-server",
    collaborationMode: input.collaborationMode ?? "default",
    taskTitle: "课程支持缺口恢复",
    courseGoalCode: "course_evidence_support_gap",
    context: {
      schemaVersion: "cmooc.workbench-context.v1",
      ref: "route-recovery-context",
      kind: "invocation",
      title: "安全课程调用锚点",
      courseAlias: "governance-cli-fixture",
      invocationId: "route-recovery-invocation",
      state: "failed",
      containsForumText: false,
      containsIdentity: false
    }
  });
  const workspace = await ensureWorkbenchSessionWorkspace({
    runId: parent.id,
    createdAt: parent.createdAt,
    taskTitle: parent.taskTitle ?? "课程支持缺口恢复",
    sourceRoot: process.cwd()
  });
  setWorkbenchSessionWorkspace(parent.id, workspace);
  if (input.parentPlanMarker) {
    setWorkbenchPlan(parent.id, {
      explanation: input.parentPlanMarker,
      steps: [{ step: input.parentPlanMarker, status: "pending" }]
    });
  }
  const failed = completeWorkbenchRun(
    parent.id,
    "failed",
    "上一任务安全中断。",
    "CODEX_CONNECTION_INTERRUPTED"
  );
  assert.ok(failed);
  await persistWorkbenchRunSnapshot(failed);
  return failed;
}

async function readStreamChunks(response: Response, limit: number): Promise<string> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (let index = 0; index < limit; index += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  return output;
}

class RouteFakeTransport implements CodexTransport {
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();
  readonly sent: string[] = [];

  send(line: string): void {
    this.sent.push(line);
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.id === undefined || typeof message.method !== "string") return;
    let result: Record<string, unknown> = {};
    if (message.method === "thread/start") {
      result = { thread: { id: "route-native-thread" } };
    } else if (message.method === "turn/start") {
      result = { turn: { id: "route-native-turn" } };
    }
    queueMicrotask(() => this.emit({ id: message.id, result }));
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  close(): void {
    // The route test only needs a deterministic in-memory transport.
  }

  emit(message: Record<string, unknown>): void {
    const line = JSON.stringify(message);
    for (const listener of this.lineListeners) listener(line);
  }

  emitExit(code: number | null): void {
    for (const listener of this.exitListeners) listener(code);
  }
}

test("run creation rejects untrusted requests and unknown execution fields", async () => {
  const routes = await loadRoutes();

  const wrongContentType = new NextRequest("http://localhost:3000/api/workbench/runs", {
    method: "POST",
    headers: {
      Host: "localhost:3000",
      "Content-Type": "text/plain",
      Origin: "http://localhost:3000",
      "Sec-Fetch-Site": "same-origin"
    },
    body: JSON.stringify({ prompt: "fixture" })
  });
  assert.equal((await routes.create.POST(wrongContentType)).status, 415);

  const crossOrigin = trustedMutationRequest(
    "/api/workbench/runs",
    { prompt: "fixture" },
    { Origin: "http://attacker.example", "Sec-Fetch-Site": "cross-site" }
  );
  assert.equal((await routes.create.POST(crossOrigin)).status, 403);

  for (const extra of [
    { cwd: "C:/fixture-workspace" },
    { command: "fixture-command" },
    { env: { FIXTURE: "value" } }
  ]) {
    const response = await routes.create.POST(
      trustedMutationRequest("/api/workbench/runs", { prompt: "fixture", mode: "demo", ...extra })
    );
    assert.equal(response.status, 400);
  }
});

test("demo POST returns a no-store 202 run and reaches the safe demo final result", async () => {
  const routes = await loadRoutes();
  const response = await routes.create.POST(
    trustedMutationRequest("/api/workbench/runs", {
      prompt: "show the fixture timeline",
      mode: "demo"
    })
  );
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = (await response.json()) as {
    run: { id: string; source: string; sessionWorkspace?: unknown };
  };
  assert.equal(body.run.source, "demo");
  assert.equal(body.run.sessionWorkspace, undefined);

  await new Promise((resolve) => setTimeout(resolve, 1_900));
  const snapshot = getWorkbenchRun(body.run.id);
  assert.equal(snapshot?.status, "completed");
  assert.equal(snapshot?.source, "demo");
  assert.equal(snapshot?.finalResult?.summary.includes("未连接真实执行引擎"), true);
  assert.ok(snapshot);
  await persistWorkbenchRunSnapshot(snapshot);

  const historyResponse = await routes.create.GET(
    trustedGetRequest("/api/workbench/runs?limit=12")
  );
  assert.equal(historyResponse.status, 200);
  const history = (await historyResponse.json()) as {
    runs: Array<{ id: string; containsForumText: boolean }>;
  };
  assert.equal(history.runs.some((item) => item.id === body.run.id), true);
  assert.equal(history.runs.every((item) => item.containsForumText === false), true);

  resetWorkbenchStoreForTests();
  const durableResponse = await routes.get.GET(
    trustedGetRequest(`/api/workbench/runs/${body.run.id}`),
    { params: { id: body.run.id } }
  );
  assert.equal(durableResponse.status, 200);
  const durable = (await durableResponse.json()) as { id: string; status: string };
  assert.equal(durable.id, body.run.id);
  assert.equal(durable.status, "completed");
});

test("persistent snapshots never advertise in-memory steer or stop controls", async () => {
  const run = createWorkbenchRun({
    prompt: "durable capability fixture",
    source: "app-server",
    goalMode: true
  });
  setWorkbenchGoal(run.id, {
    status: "active",
    tokensUsed: 64,
    timeUsedSeconds: 3
  });
  const live = getWorkbenchRun(run.id);
  assert.equal(live?.goal?.status, "active");
  assert.ok(live);
  await persistWorkbenchRunSnapshot(live);

  const persisted = await loadPersistentWorkbenchRun(run.id);
  assert.ok(persisted);
  assert.equal(persisted.capabilities.canSteer, false);
  assert.equal(persisted.capabilities.canStop, false);
  assert.equal(persisted.goal?.status, "paused");
  assert.equal(persisted.goal?.tokensUsed, 64);
});

test("persistent snapshots discard current-run live message excerpts", async () => {
  const run = createWorkbenchRun({
    prompt: "ephemeral excerpt fixture",
    source: "app-server"
  });
  appendWorkbenchEvent(run.id, {
    kind: "message",
    status: "completed",
    title: "主任务智能体更新了执行进展",
    summary: "收到一条过程更新；内部推理与运行细节未展示。",
    liveExcerpt: "EPHEMERAL_PROGRESS_SENTINEL"
  });
  const live = getWorkbenchRun(run.id);
  assert.equal(live?.events.at(-1)?.liveExcerpt, "EPHEMERAL_PROGRESS_SENTINEL");
  assert.ok(live);

  await persistWorkbenchRunSnapshot(live);
  const durable = await loadPersistentWorkbenchRun(run.id);
  assert.ok(durable);
  assert.equal(durable.events.some((event) => event.liveExcerpt), false);

  const row = await prisma.workbenchRunRecord.findUnique({
    where: { id: run.id },
    select: { snapshotJson: true }
  });
  assert.equal(row?.snapshotJson.includes("EPHEMERAL_PROGRESS_SENTINEL"), false);
});

test("interrupted goal recovery pauses the goal in the database and session bundle without losing counts", async () => {
  const run = createWorkbenchRun({
    prompt: "interrupted goal recovery fixture",
    source: "app-server",
    goalMode: true
  });
  const workspace = await ensureWorkbenchSessionWorkspace({
    runId: run.id,
    createdAt: run.createdAt,
    taskTitle: run.taskTitle ?? "持续目标任务",
    lineage: run.lineage,
    sourceRoot: process.cwd()
  });
  setWorkbenchSessionWorkspace(run.id, workspace);
  setWorkbenchGoal(run.id, {
    status: "active",
    tokenBudget: 900,
    tokensUsed: 321,
    timeUsedSeconds: 47
  });
  const live = getWorkbenchRun(run.id);
  assert.ok(live?.goal);
  await persistWorkbenchRunSnapshot(live);
  const persistedSessionManifest = JSON.parse(
    await readFile(path.join(routeSessionRoot, workspace.key, "session.json"), "utf8")
  ) as { goal?: { status?: string; tokensUsed?: number } };
  assert.equal(persistedSessionManifest.goal?.status, "paused");
  assert.equal(persistedSessionManifest.goal?.tokensUsed, 321);

  // Simulate an abrupt process loss after the in-memory active goal was written.
  const interrupted = {
    ...live,
    status: "running" as const,
    updatedAt: new Date(Date.now() + 1_000).toISOString()
  };
  await prisma.workbenchRunRecord.update({
    where: { id: run.id },
    data: {
      status: "running",
      snapshotJson: JSON.stringify(interrupted),
      recoveryState: null
    }
  });
  await prisma.workbenchTask.update({
    where: { id: `task-${run.id}` },
    data: { status: "running", completedAt: null }
  });
  await syncWorkbenchSessionWorkspace(interrupted);
  resetWorkbenchStoreForTests();

  const { recoverInterruptedWorkbenchRuns } = await import("../../lib/workbench/history-store");
  assert.ok((await recoverInterruptedWorkbenchRuns()) >= 1);
  const durable = await loadPersistentWorkbenchRun(run.id);
  assert.equal(durable?.status, "failed");
  assert.equal(durable?.goal?.status, "paused");
  assert.equal(durable?.goal?.tokenBudget, 900);
  assert.equal(durable?.goal?.tokensUsed, 321);
  assert.equal(durable?.goal?.timeUsedSeconds, 47);
  const routes = await loadRoutes();
  const apiResponse = await routes.get.GET(
    trustedGetRequest(`/api/workbench/runs/${run.id}`),
    { params: { id: run.id } }
  );
  assert.equal(apiResponse.status, 200);
  const apiSnapshot = await apiResponse.json() as {
    goal?: { status?: string; tokensUsed?: number; timeUsedSeconds?: number };
  };
  assert.equal(apiSnapshot.goal?.status, "paused");
  assert.equal(apiSnapshot.goal?.tokensUsed, 321);
  assert.equal(apiSnapshot.goal?.timeUsedSeconds, 47);

  const row = await prisma.workbenchRunRecord.findUnique({
    where: { id: run.id },
    select: { snapshotJson: true, recoveryState: true }
  });
  assert.equal(row?.recoveryState, "interrupted");
  const dbSnapshot = JSON.parse(row?.snapshotJson ?? "{}") as { goal?: { status?: string; tokensUsed?: number } };
  assert.equal(dbSnapshot.goal?.status, "paused");
  assert.equal(dbSnapshot.goal?.tokensUsed, 321);

  const sessionManifest = JSON.parse(
    await readFile(path.join(routeSessionRoot, workspace.key, "session.json"), "utf8")
  ) as { goal?: { status?: string; tokensUsed?: number } };
  assert.equal(sessionManifest.goal?.status, "paused");
  assert.equal(sessionManifest.goal?.tokensUsed, 321);
});

test("process loss invalidates an awaiting action card and exposes an honest restart instead of a dead approval", async () => {
  const run = createWorkbenchRun({
    prompt: "awaiting action process-loss fixture",
    source: "app-server"
  });
  const workspace = await ensureWorkbenchSessionWorkspace({
    runId: run.id,
    createdAt: run.createdAt,
    taskTitle: run.taskTitle ?? "课程暂存任务",
    lineage: run.lineage,
    sourceRoot: process.cwd()
  });
  setWorkbenchSessionWorkspace(run.id, workspace);
  setWorkbenchPendingAction(run.id, {
    schemaVersion: COURSE_AGENT_ACTION_COORDINATOR_SCHEMA_VERSION,
    kind: "approval_required",
    actionRef: `action-${run.id}`,
    approvalHash: "a".repeat(64),
    bindingHash: "b".repeat(64),
    toolName: "platform.editor.stage_verify_clear",
    toolVersion: "1",
    safeSummary: "暂存、回读并清空一份受保护草稿；发布与通知均为 0。",
    validFrom: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    operationBoundary: {
      editorWriteCount: 1,
      editorReadbackCount: 1,
      editorClearCount: 1,
      publishCount: 0,
      notificationCount: 0,
      realPublishEnabled: false
    }
  });
  setWorkbenchRunStatus(run.id, "awaiting_action", {
    summary: "等待本次精确暂存决定。"
  });
  const awaiting = getWorkbenchRun(run.id);
  assert.ok(awaiting?.pendingAction);
  await persistWorkbenchRunSnapshot(awaiting);
  resetWorkbenchStoreForTests();

  const { recoverInterruptedWorkbenchRuns } = await import("../../lib/workbench/history-store");
  assert.equal(await recoverInterruptedWorkbenchRuns(), 1);
  const recovered = await loadPersistentWorkbenchRun(run.id);
  assert.equal(recovered?.status, "failed");
  assert.equal(recovered?.errorCode, "WORKBENCH_ACTION_SESSION_LOST");
  assert.equal(recovered?.pendingAction, undefined);
  assert.equal(recovered?.capabilities.canRestart, true);
  assert.match(recovered?.finalResult?.summary ?? "", /没有自动执行或重放动作/);
});

test("history reset waits for in-flight persistence before releasing test workspace state", async () => {
  const run = createWorkbenchRun({ prompt: "persistence drain fixture", source: "demo" });
  let releasePersistence: (() => void) | undefined;
  const persistenceGate = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  const delayedDb = {
    workbenchTask: {
      findUnique: async () => {
        await persistenceGate;
        throw new Error("fixture persistence stopped");
      }
    }
  } as unknown as typeof prisma;

  let persistenceFinished = false;
  const persistence = persistWorkbenchRunSnapshot(run, delayedDb)
    .catch(() => undefined)
    .finally(() => {
      persistenceFinished = true;
    });
  let resetFinished = false;
  const reset = resetWorkbenchHistorySubscriptionsForTests().then(() => {
    resetFinished = true;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(persistenceFinished, false);
  assert.equal(resetFinished, false);

  assert.ok(releasePersistence);
  releasePersistence();
  await Promise.all([persistence, reset]);
  assert.equal(persistenceFinished, true);
  assert.equal(resetFinished, true);
});

test("run creation recovers persisted active rows before accepting a new run", async () => {
  const routes = await loadRoutes();
  const stale = createWorkbenchRun({
    prompt: "stale process fixture",
    source: "app-server"
  });
  await persistWorkbenchRunSnapshot(stale);
  resetWorkbenchStoreForTests();

  const response = await routes.create.POST(
    trustedMutationRequest("/api/workbench/runs", {
      prompt: "new demo after recovery",
      mode: "demo"
    })
  );
  assert.equal(response.status, 202);
  const recovered = await loadPersistentWorkbenchRun(stale.id);
  assert.equal(recovered?.status, "failed");
  assert.equal(recovered?.errorCode, "WORKBENCH_PROCESS_LOST");
  assert.equal(recovered?.capabilities.canSteer, false);
  assert.equal(recovered?.capabilities.canStop, false);
});

test("run GET and SSE recover persisted active rows instead of serving stale running snapshots", async () => {
  const routes = await loadRoutes();
  const stale = createWorkbenchRun({
    prompt: "stale GET/SSE fixture",
    source: "app-server"
  });
  await persistWorkbenchRunSnapshot(stale);
  resetWorkbenchStoreForTests();

  const getResponse = await routes.get.GET(
    trustedGetRequest(`/api/workbench/runs/${stale.id}`),
    { params: { id: stale.id } }
  );
  assert.equal(getResponse.status, 200);
  const recovered = (await getResponse.json()) as {
    status: string;
    errorCode?: string;
    capabilities: { canSteer: boolean; canStop: boolean };
  };
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.errorCode, "WORKBENCH_PROCESS_LOST");
  assert.equal(recovered.capabilities.canSteer, false);
  assert.equal(recovered.capabilities.canStop, false);

  const sseResponse = await routes.events.GET(
    trustedGetRequest(`/api/workbench/runs/${stale.id}/events?after=0`),
    { params: { id: stale.id } }
  );
  const sse = await readStreamChunks(sseResponse, 1);
  assert.match(sse, /event: snapshot/);
  assert.match(sse, /"status":"failed"/);
  assert.match(sse, /"errorCode":"WORKBENCH_PROCESS_LOST"/);
});

test("history quarantines invalid active snapshots and never exposes them as running tasks", async () => {
  const routes = await loadRoutes();
  const suffix = randomUUID();
  const taskId = `invalid-history-task-${suffix}`;
  const runId = suffix;
  const now = new Date();
  await prisma.workbenchTask.create({
    data: {
      id: taskId,
      title: "Invalid history fixture",
      status: "running",
      createdAt: now
    }
  });
  await prisma.workbenchRunRecord.create({
    data: {
      id: runId,
      taskId,
      schemaVersion: "workbench-run-v1",
      source: "app-server",
      status: "running",
      projectLabel: "Course workbench",
      snapshotJson: "{}",
      createdAt: now,
      updatedAt: now
    }
  });

  const response = await routes.create.GET(
    trustedGetRequest("/api/workbench/runs?limit=20")
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    runs: Array<{ id: string; status: string }>;
  };
  assert.equal(body.runs.some((run) => run.id === runId), false);

  const quarantined = await prisma.workbenchRunRecord.findUnique({
    where: { id: runId },
    select: { status: true, errorCode: true, recoveryState: true }
  });
  assert.deepEqual(quarantined, {
    status: "failed",
    errorCode: "WORKBENCH_SNAPSHOT_INVALID",
    recoveryState: "interrupted"
  });
});

test("GET returns no-store 404 for unknown safe run ids and stop rejects non-empty bodies", async () => {
  const routes = await loadRoutes();
  const unknownId = "aaaaaaaaaaaaaaaa";
  const getResponse = await routes.get.GET(
    trustedGetRequest(`/api/workbench/runs/${unknownId}`),
    { params: { id: unknownId } }
  );
  assert.equal(getResponse.status, 404);
  assert.equal(getResponse.headers.get("cache-control"), "no-store");

  const stopResponse = await routes.stop.POST(
    trustedMutationRequest(`/api/workbench/runs/${unknownId}/stop`, { unexpected: true }),
    { params: { id: unknownId } }
  );
  assert.equal(stopResponse.status, 400);
  assert.equal(stopResponse.headers.get("cache-control"), "no-store");
});

test("history GET fails closed when persistence recovery throws", async () => {
  const routes = await loadRoutes();
  const runRecord = prisma.workbenchRunRecord;
  const originalFindMany = runRecord.findMany;
  const mutableRunRecord = runRecord as unknown as {
    findMany: () => Promise<never>;
  };
  mutableRunRecord.findMany = async () => {
    throw new Error("database details must stay private");
  };
  try {
    const response = await routes.create.GET(
      trustedGetRequest("/api/workbench/runs")
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as {
      error: string;
      code: string;
    };
    assert.deepEqual(body, {
      error: "工作台历史恢复失败，请稍后重试。",
      code: "WORKBENCH_RECOVERY_FAILED"
    });
    assert.doesNotMatch(JSON.stringify(body), /database details/);
  } finally {
    (runRecord as unknown as { findMany: typeof originalFindMany }).findMany = originalFindMany;
  }
});

test("SSE returns snapshot/replay and resets stale cursors without hanging", async () => {
  const routes = await loadRoutes();
  const run = createWorkbenchRun({ prompt: "SSE fixture", source: "demo" });
  appendWorkbenchEvent(run.id, {
    kind: "message",
    status: "info",
    title: "fixture replay event",
    summary: "safe replay summary"
  });

  const response = await routes.events.GET(
    trustedGetRequest(`/api/workbench/runs/${run.id}/events?after=0`),
    { params: { id: run.id } }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const replay = await readStreamChunks(response, 3);
  assert.match(replay, /event: snapshot/);
  assert.match(replay, /event: workbench_event/);
  assert.match(replay, /id: 1/);

  for (let index = 0; index < WORKBENCH_EVENT_RING_LIMIT + 1; index += 1) {
    appendWorkbenchEvent(run.id, {
      kind: "message",
      status: "info",
      title: `stale fixture ${index}`,
      summary: "safe stale summary"
    });
  }
  const staleResponse = await routes.events.GET(
    trustedGetRequest(`/api/workbench/runs/${run.id}/events?after=1`),
    { params: { id: run.id } }
  );
  assert.equal(staleResponse.status, 200);
  const reset = await readStreamChunks(staleResponse, 1);
  assert.match(reset, /event: reset/);
  assert.match(reset, /id: \d+/);

  const latest = getWorkbenchRun(run.id);
  assert.ok(latest);
  const resumedResponse = await routes.events.GET(
    new NextRequest(`http://localhost:3000/api/workbench/runs/${run.id}/events`, {
      headers: {
        Host: "localhost:3000",
        Origin: "http://localhost:3000",
        "Sec-Fetch-Site": "same-origin",
        "Last-Event-ID": String(latest.lastEventSeq)
      }
    }),
    { params: { id: run.id } }
  );
  const resumed = await readStreamChunks(resumedResponse, 1);
  assert.doesNotMatch(resumed, /event: reset/);
});

test("live POST can use an injected transport and remains a 202 app-server run", async () => {
  let transport: RouteFakeTransport | undefined;
  setWorkbenchTransportFactory(() => {
    transport = new RouteFakeTransport();
    return transport;
  });
  const routes = await loadRoutes();
  const response = await routes.create.POST(
    trustedMutationRequest("/api/workbench/runs", {
      prompt: "live fixture",
      mode: "live"
    })
  );
  assert.equal(response.status, 202);
  const body = (await response.json()) as {
    run: {
      id: string;
      source: string;
      sessionWorkspace?: {
        key: string;
        projectRelativePath: string;
        containsPrompt: boolean;
        containsForumText: boolean;
      };
    };
  };
  assert.equal(body.run.source, "app-server");
  assert.ok(body.run.sessionWorkspace);
  assert.equal(body.run.sessionWorkspace.containsPrompt, false);
  assert.equal(body.run.sessionWorkspace.containsForumText, false);
  assert.equal(
    body.run.sessionWorkspace.projectRelativePath,
    `智能控制台会话/${body.run.sessionWorkspace.key}`
  );
  const manifest = await readFile(
    path.join(routeSessionRoot, body.run.sessionWorkspace.key, "session.json"),
    "utf8"
  );
  assert.match(manifest, new RegExp(body.run.id));
  assert.doesNotMatch(manifest, /live fixture|threadId|turnId/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(transport);
  assert.equal(
    transport.sent.every((line) =>
      [
        "initialize",
        "initialized",
        "thread/start",
        "turn/start",
        "turn/steer",
        "turn/interrupt"
      ].includes(String((JSON.parse(line) as Record<string, unknown>).method))
    ),
    true
  );
  const stopResponse = await routes.stop.POST(
    trustedMutationRequest(`/api/workbench/runs/${body.run.id}/stop`, {}),
    { params: { id: body.run.id } }
  );
  assert.equal(stopResponse.status, 200);
});

test("live POST fails before run creation when local execution authorization is unavailable", async () => {
  let transportCreated = false;
  setWorkbenchTransportFactory(() => {
    transportCreated = true;
    return new RouteFakeTransport();
  });
  setCodexRuntimeProbeForTests(async () => "auth-unavailable");
  const routes = await loadRoutes();

  const response = await routes.create.POST(
    trustedMutationRequest("/api/workbench/runs", {
      prompt: "authorization preflight fixture",
      mode: "live"
    })
  );
  const body = (await response.json()) as { code?: string; error?: string };

  assert.equal(response.status, 503);
  assert.equal(body.code, "CODEX_AUTH_UNAVAILABLE");
  assert.equal(body.error, "本机执行授权尚未连接，请先完成一次本机授权后重试。");
  assert.equal(transportCreated, false);
  assert.equal(getActiveWorkbenchRun(), undefined);
  assert.equal(JSON.stringify(body).toLowerCase().includes("not logged in"), false);
});

test("runtime readiness exposes a safe explicit authorization handoff", async () => {
  setWorkbenchTransportFactory(() => new RouteFakeTransport());
  let authorized = false;
  setCodexRuntimeProbeForTests(async () => authorized ? "ready" : "auth-unavailable");
  let launchCount = 0;
  let completeLogin!: () => void;
  const completed = new Promise<void>((resolve) => {
    completeLogin = resolve;
  });
  setCodexLoginLauncherForTests(async () => {
    launchCount += 1;
    return { completed };
  });
  const routes = await loadRoutes();

  const before = await routes.runtime.GET();
  const beforeBody = await before.json() as Record<string, unknown>;
  assert.equal(before.status, 200);
  assert.deepEqual(beforeBody, {
    status: "auth-required",
    summary: "本机执行授权尚未连接。",
    canStartAuthorization: true
  });

  const started = await routes.runtime.POST(
    trustedMutationRequest("/api/workbench/runtime", {})
  );
  const startedBody = await started.json() as Record<string, unknown>;
  assert.equal(started.status, 202);
  assert.equal(startedBody.status, "authorizing");
  assert.equal(launchCount, 1);

  const repeated = await routes.runtime.POST(
    trustedMutationRequest("/api/workbench/runtime", {})
  );
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json() as Record<string, unknown>).status, "authorizing");
  assert.equal(launchCount, 1);
  assert.equal(JSON.stringify([beforeBody, startedBody]).includes(process.cwd()), false);

  authorized = true;
  const after = await routes.runtime.GET();
  assert.deepEqual(await after.json(), {
    status: "ready",
    summary: "本机执行已连接。",
    canStartAuthorization: false
  });
  completeLogin();
});

test("a failed durable run can restart as a new lineage-linked Nutstore session", async () => {
  const privatePromptSentinel = "ORIGINAL_PRIVATE_PROMPT_SENTINEL_MUST_NOT_REAPPEAR";
  const parent = createWorkbenchRun({
    prompt: privatePromptSentinel,
    source: "app-server",
    taskTitle: "可恢复课程研判"
  });
  const parentWorkspace = await ensureWorkbenchSessionWorkspace({
    runId: parent.id,
    createdAt: parent.createdAt,
    taskTitle: parent.taskTitle ?? "可恢复课程研判",
    sourceRoot: process.cwd()
  });
  setWorkbenchSessionWorkspace(parent.id, parentWorkspace);
  const failedParent = completeWorkbenchRun(
    parent.id,
    "failed",
    "本机执行连接中断；安全上下文与会话目录已经保留。",
    "CODEX_CONNECTION_INTERRUPTED"
  );
  assert.ok(failedParent);
  await persistWorkbenchRunSnapshot(failedParent);
  resetWorkbenchStoreForTests();

  const transport = new RouteFakeTransport();
  setWorkbenchTransportFactory(() => transport);
  const routes = await loadRoutes();
  const launchRoute = await import("../../app/api/workbench/runs/[id]/launch/route");
  const requestId = "99999999-8888-4777-8666-555555555555";
  const launchPath = `/api/workbench/runs/${parent.id}/launch`;
  const response = await launchRoute.POST(
    trustedMutationRequest(launchPath, { kind: "restart", requestId }),
    { params: { id: parent.id } }
  );
  assert.equal(response.status, 202);
  const body = await response.json() as {
    run: {
      id: string;
      lineage?: {
        schemaVersion: string;
        relation: string;
        rootRunId: string;
        parentRunId?: string;
        recoveryOfRunId?: string;
        generation: number;
        requestId?: string;
      };
      taskTitle?: string;
      sessionWorkspace?: { key: string; projectRelativePath: string };
    };
  };
  assert.notEqual(body.run.id, parent.id);
  assert.deepEqual(body.run.lineage, {
    schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
    relation: "restart",
    rootRunId: parent.id,
    parentRunId: parent.id,
    recoveryOfRunId: parent.id,
    generation: 1,
    requestId
  });
  assert.equal(body.run.taskTitle, parent.taskTitle);
  assert.ok(body.run.sessionWorkspace);
  assert.notEqual(body.run.sessionWorkspace.key, parentWorkspace.key);
  assert.equal(
    body.run.sessionWorkspace.projectRelativePath,
    `智能控制台会话/${body.run.sessionWorkspace.key}`
  );

  const repeatedResponse = await launchRoute.POST(
    trustedMutationRequest(launchPath, { kind: "restart", requestId }),
    { params: { id: parent.id } }
  );
  assert.equal([200, 202].includes(repeatedResponse.status), true);
  const repeatedBody = await repeatedResponse.json() as typeof body;
  assert.equal(repeatedBody.run.id, body.run.id);
  assert.equal(repeatedBody.run.sessionWorkspace?.key, body.run.sessionWorkspace.key);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const parentRow = await prisma.workbenchRunRecord.findUnique({
    where: { id: parent.id },
    select: { taskId: true }
  });
  const childRow = await prisma.workbenchRunRecord.findUnique({
    where: { id: body.run.id },
    select: { taskId: true, snapshotJson: true }
  });
  assert.equal(childRow?.taskId, parentRow?.taskId);
  assert.equal(childRow?.snapshotJson.includes(privatePromptSentinel), false);
  assert.equal(JSON.stringify(transport.sent).includes(privatePromptSentinel), false);
  const childManifest = await readFile(
    path.join(routeSessionRoot, body.run.sessionWorkspace.key, "session.json"),
    "utf8"
  );
  assert.equal(childManifest.includes(privatePromptSentinel), false);

  const stopResponse = await routes.stop.POST(
    trustedMutationRequest(`/api/workbench/runs/${body.run.id}/stop`, {}),
    { params: { id: body.run.id } }
  );
  assert.equal(stopResponse.status, 200);
});

test("restart start failure clears the process session and durably records the failed child", async () => {
  const parent = createWorkbenchRun({
    prompt: "restart start failure fixture",
    source: "app-server",
    taskTitle: "启动失败恢复测试"
  });
  const parentWorkspace = await ensureWorkbenchSessionWorkspace({
    runId: parent.id,
    createdAt: parent.createdAt,
    taskTitle: parent.taskTitle ?? "启动失败恢复测试",
    sourceRoot: process.cwd()
  });
  setWorkbenchSessionWorkspace(parent.id, parentWorkspace);
  const failedParent = completeWorkbenchRun(
    parent.id,
    "failed",
    "父任务已失败并保留安全交接目录。",
    "CODEX_CONNECTION_INTERRUPTED"
  );
  assert.ok(failedParent);
  await persistWorkbenchRunSnapshot(failedParent);

  const requestId = "12121212-3434-4567-8899-101010101010";
  const input = { kind: "restart" as const, requestId };
  const childRunId = deriveWorkbenchChildRunId(parent.id, input);
  registerCourseAgentProcessSession({
    taskId: `task-${parent.id}`,
    runId: childRunId,
    courseAlias: "route-start-failure-fixture",
    toolkit: {} as CourseAgentToolkit,
    transport: {} as WorkbenchCourseToolTransport
  });
  assert.ok(getCourseAgentProcessSession(childRunId));

  setWorkbenchTransportFactory(() => {
    throw new Error("TEST_TRANSPORT_START_FAILURE");
  });
  const launchRoute = await import("../../app/api/workbench/runs/[id]/launch/route");
  const response = await launchRoute.POST(
    trustedMutationRequest(`/api/workbench/runs/${parent.id}/launch`, input),
    { params: { id: parent.id } }
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json() as { run: { id: string } }).run.id, childRunId);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (getWorkbenchRun(childRunId)?.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(getWorkbenchRun(childRunId)?.status, "failed");
  assert.equal(getWorkbenchRun(childRunId)?.errorCode, "CODEX_START_FAILED");
  assert.equal(getCourseAgentProcessSession(childRunId), null);

  let durableStatus: string | null = null;
  let durableSnapshot = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const row = await prisma.workbenchRunRecord.findUnique({
      where: { id: childRunId },
      select: { status: true, snapshotJson: true }
    });
    durableStatus = row?.status ?? null;
    durableSnapshot = row?.snapshotJson ?? "";
    if (durableStatus === "failed" && durableSnapshot.includes("CODEX_START_FAILED")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(durableStatus, "failed");
  assert.equal(durableSnapshot.includes("CODEX_START_FAILED"), true);
});

test("course restart rejects terminal checkpoint states before creating a child", async () => {
  const parent = await createFailedSupportGapRouteParent();
  const launchRoute = await import("../../app/api/workbench/runs/[id]/launch/route");
  const cases = [
    {
      state: "stage_unknown_requires_reconcile" as const,
      code: "COURSE_AGENT_STAGE_RECONCILIATION_REQUIRED",
      reasonCode: "stage_outcome_unknown"
    },
    {
      state: "stage_verified_delivery_ready" as const,
      code: "COURSE_AGENT_DELIVERY_RECOVERY_REQUIRED",
      reasonCode: "stage_verified_delivery_absent"
    },
    {
      state: "blocked" as const,
      code: "COURSE_AGENT_RECOVERY_MANUAL_REVIEW_REQUIRED",
      reasonCode: "draft_binding_invalid"
    },
    {
      state: "completed" as const,
      code: "COURSE_AGENT_RECOVERY_ALREADY_COMPLETED",
      reasonCode: "verified_delivery_completed"
    }
  ];

  for (const [index, fixture] of cases.entries()) {
    const requestId = `77777777-8888-4${index}99-8${index}66-55555555555${index}`;
    const childRunId = deriveWorkbenchChildRunId(parent.id, {
      kind: "restart",
      requestId
    });
    setWorkbenchCourseRecoveryBundleLoaderForTests(async (_db, input) => {
      assert.equal(input.sourceRunId, parent.id);
      assert.equal(input.childRunId, childRunId);
      assert.equal(
        await prisma.workbenchRunRecord.count({ where: { id: childRunId } }),
        0,
        "checkpoint routing must happen before child creation"
      );
      throw new CourseAgentCheckpointHydratorError(
        "COURSE_AGENT_RECOVERY_CHECKPOINT_UNSUPPORTED",
        "typed route fixture",
        fixture.state,
        fixture.reasonCode
      );
    });
    const response = await launchRoute.POST(
      trustedMutationRequest(`/api/workbench/runs/${parent.id}/launch`, {
        kind: "restart",
        requestId
      }),
      { params: { id: parent.id } }
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code?: string }).code, fixture.code);
    assert.equal(getWorkbenchRun(childRunId), undefined);
    assert.equal(
      await prisma.workbenchRunRecord.count({ where: { id: childRunId } }),
      0
    );
  }
});

test("course restart loader failure returns 503 without creating a child", async () => {
  const parent = await createFailedSupportGapRouteParent();
  const requestId = "67676767-8989-4012-8345-454545454545";
  const childRunId = deriveWorkbenchChildRunId(parent.id, {
    kind: "restart",
    requestId
  });
  setWorkbenchCourseRecoveryBundleLoaderForTests(async (_db, input) => {
    assert.equal(input.childRunId, childRunId);
    assert.equal(
      await prisma.workbenchRunRecord.count({ where: { id: childRunId } }),
      0
    );
    throw new Error("TEST_RECOVERY_LOADER_UNAVAILABLE");
  });
  const launchRoute = await import("../../app/api/workbench/runs/[id]/launch/route");
  const response = await launchRoute.POST(
    trustedMutationRequest(`/api/workbench/runs/${parent.id}/launch`, {
      kind: "restart",
      requestId
    }),
    { params: { id: parent.id } }
  );
  assert.equal(response.status, 503);
  assert.equal(
    (await response.json() as { code?: string }).code,
    "COURSE_AGENT_RECOVERY_LOAD_FAILED"
  );
  assert.equal(getWorkbenchRun(childRunId), undefined);
  assert.equal(
    await prisma.workbenchRunRecord.count({ where: { id: childRunId } }),
    0
  );
});

test("course restart with replay-required evidence keeps the ordinary full-plan behavior", async () => {
  const restoreManifest = await installRouteCourseManifestFixture();
  try {
    const parent = await createFailedSupportGapRouteParent();
    const requestId = "45454545-6767-4890-8123-232323232323";
    setWorkbenchCourseRecoveryBundleLoaderForTests(async () => {
      throw new CourseAgentCheckpointHydratorError(
        "COURSE_AGENT_RECOVERY_CHECKPOINT_UNSUPPORTED",
        "fresh evidence is required",
        "evidence_replay_required",
        "composition_expired_fresh_evidence_required"
      );
    });
    const transport = new RouteFakeTransport();
    setWorkbenchTransportFactory(() => transport);
    const launchRoute = await import("../../app/api/workbench/runs/[id]/launch/route");
    const response = await launchRoute.POST(
      trustedMutationRequest(`/api/workbench/runs/${parent.id}/launch`, {
        kind: "restart",
        requestId
      }),
      { params: { id: parent.id } }
    );
    assert.equal(response.status, 202);
    const body = await response.json() as {
      run: { id: string; plan?: { steps: Array<{ step: string }> } };
      displayPrompt?: string;
    };
    assert.match(body.displayPrompt ?? "", /重新启动/u);
    assert.equal(body.run.plan?.steps.length, 11);
    assert.match(body.run.plan?.steps[0]?.step ?? "", /精确课程证据上下文/u);
    assert.match(body.run.plan?.steps[10]?.step ?? "", /零发布边界/u);

    const routes = await loadRoutes();
    const stopResponse = await routes.stop.POST(
      trustedMutationRequest(`/api/workbench/runs/${body.run.id}/stop`, {}),
      { params: { id: body.run.id } }
    );
    assert.equal(stopResponse.status, 200);
  } finally {
    restoreManifest();
  }
});

test("verified draft checkpoint launches a fixed four-step recovery child without copying the parent plan", async () => {
  const restoreManifest = await installRouteCourseManifestFixture();
  try {
    const parentPlanMarker = "PARENT_DISPLAY_PLAN_MUST_NOT_BE_COPIED";
    const parent = await createFailedSupportGapRouteParent({
      collaborationMode: "plan",
      parentPlanMarker
    });
    const requestId = "56565656-7878-4901-8234-343434343434";
    const childRunId = deriveWorkbenchChildRunId(parent.id, {
      kind: "restart",
      requestId
    });
    const checkpointHash = "a".repeat(64);
    const checkpointRef = `course-checkpoint:${checkpointHash}`;
    const verifiedCheckpointSource = Object.freeze({
      schemaVersion: "cmooc.course-agent.verified-checkpoint-source.v2"
    }) as unknown as VerifiedCourseAgentRecoveryBundle["source"];
    const bundle = Object.freeze({
      checkpoint: Object.freeze({
        checkpointRef,
        checkpointHash
      }),
      source: verifiedCheckpointSource,
      runtimeRecovery: Object.freeze({ verifiedCheckpointSource })
    }) as unknown as VerifiedCourseAgentRecoveryBundle;

    setWorkbenchCourseRecoveryBundleLoaderForTests(async (_db, input) => {
      assert.equal(input.taskId, `task-${parent.id}`);
      assert.equal(input.sourceRunId, parent.id);
      assert.equal(input.childRunId, childRunId);
      assert.equal(input.courseAlias, "governance-cli-fixture");
      assert.equal(
        await prisma.workbenchRunRecord.count({ where: { id: childRunId } }),
        0,
        "verified source must be loaded before the child exists"
      );
      return bundle;
    });
    const transport = new RouteFakeTransport();
    setWorkbenchTransportFactory(() => transport);
    const launchRoute = await import("../../app/api/workbench/runs/[id]/launch/route");
    const response = await launchRoute.POST(
      trustedMutationRequest(`/api/workbench/runs/${parent.id}/launch`, {
        kind: "restart",
        requestId
      }),
      { params: { id: parent.id } }
    );
    assert.equal(response.status, 202);
    const body = await response.json() as {
      run: {
        id: string;
        collaborationMode?: string;
        plan?: { steps: Array<{ step: string; status: string }> };
      };
      displayPrompt?: string;
    };
    assert.equal(body.run.id, childRunId);
    assert.equal(body.run.collaborationMode, "default");
    assert.match(body.displayPrompt ?? "", /恢复课程成果/u);
    assert.equal((body.displayPrompt ?? "").includes(checkpointRef), false);
    assert.deepEqual(
      body.run.plan?.steps.map((step) => step.step),
      [
        "从服务器核验的检查点材料重新生成短期受保护草稿并复验。",
        "只读预检精确目标、页面绑定与空编辑器基线。",
        "在一次性授权下暂存、回读核验并清空编辑器。",
        "交付草稿、验证与零发布边界组成的成果包。"
      ]
    );
    assert.equal(JSON.stringify(body).includes(parentPlanMarker), false);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const sent = JSON.stringify(transport.sent);
    assert.equal(sent.includes(parentPlanMarker), false);
    assert.equal(sent.includes(checkpointRef), false);
    assert.equal(sent.includes(checkpointHash), false);
    assert.equal(sent.includes("禁止发布、提交、发送或通知"), true);
    const durablePlan = await prisma.workbenchPlanRevisionRecord.findFirst({
      where: { runId: childRunId },
      include: { steps: { orderBy: { ordinal: "asc" } } }
    });
    assert.deepEqual(
      durablePlan?.steps.map((step) => step.toolName),
      [
        "artifact.reply_draft.regenerate",
        "platform.target.preflight_read",
        "platform.editor.stage_verify_clear",
        "delivery.bundle.create"
      ]
    );
    assert.equal(durablePlan?.safeSummary.includes(parentPlanMarker), false);

    const routes = await loadRoutes();
    const stopResponse = await routes.stop.POST(
      trustedMutationRequest(`/api/workbench/runs/${childRunId}/stop`, {}),
      { params: { id: childRunId } }
    );
    assert.equal(stopResponse.status, 200);
  } finally {
    restoreManifest();
  }
});

test("a durable completed run continues as one idempotent lineage child without reviving its old thread", async () => {
  const privatePromptSentinel = "COMPLETED_PRIVATE_PROMPT_MUST_NOT_REAPPEAR";
  const parent = createWorkbenchRun({
    prompt: privatePromptSentinel,
    source: "app-server",
    taskTitle: "已完成课程研判"
  });
  const parentWorkspace = await ensureWorkbenchSessionWorkspace({
    runId: parent.id,
    createdAt: parent.createdAt,
    taskTitle: parent.taskTitle ?? "已完成课程研判",
    sourceRoot: process.cwd()
  });
  setWorkbenchSessionWorkspace(parent.id, parentWorkspace);
  const completedParent = completeWorkbenchRun(
    parent.id,
    "completed",
    "上一轮已核验一处缺口；下一步应继续完成有界实现。"
  );
  assert.ok(completedParent);
  await persistWorkbenchRunSnapshot(completedParent);
  resetWorkbenchStoreForTests();

  const transport = new RouteFakeTransport();
  setWorkbenchTransportFactory(() => transport);
  const routes = await loadRoutes();
  const launchRoute = await import("../../app/api/workbench/runs/[id]/launch/route");
  const requestId = "33333333-4444-4555-8666-777777777777";
  const launchPath = `/api/workbench/runs/${parent.id}/launch`;
  const response = await launchRoute.POST(
    trustedMutationRequest(launchPath, { kind: "continuation", requestId }),
    { params: { id: parent.id } }
  );
  assert.equal(response.status, 202);
  const body = await response.json() as {
    run: {
      id: string;
      lineage?: Record<string, unknown>;
      sessionWorkspace?: { key: string; projectRelativePath: string };
    };
    displayPrompt?: string;
  };
  assert.deepEqual(body.run.lineage, {
    schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
    relation: "continuation",
    rootRunId: parent.id,
    parentRunId: parent.id,
    generation: 1,
    requestId
  });
  assert.match(body.displayPrompt ?? "", /基于结果继续/);
  assert.ok(body.run.sessionWorkspace);
  assert.notEqual(body.run.sessionWorkspace.key, parentWorkspace.key);

  const repeated = await launchRoute.POST(
    trustedMutationRequest(launchPath, { kind: "continuation", requestId }),
    { params: { id: parent.id } }
  );
  assert.equal([200, 202].includes(repeated.status), true);
  const repeatedBody = await repeated.json() as typeof body;
  assert.equal(repeatedBody.run.id, body.run.id);
  assert.equal(repeatedBody.run.sessionWorkspace?.key, body.run.sessionWorkspace.key);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const parentRow = await prisma.workbenchRunRecord.findUnique({
    where: { id: parent.id },
    select: { taskId: true }
  });
  const childRow = await prisma.workbenchRunRecord.findUnique({
    where: { id: body.run.id },
    select: { taskId: true, snapshotJson: true }
  });
  assert.equal(childRow?.taskId, parentRow?.taskId);
  assert.equal(childRow?.snapshotJson.includes(privatePromptSentinel), false);
  assert.equal(JSON.stringify(transport.sent).includes(privatePromptSentinel), false);
  assert.equal(
    JSON.stringify(transport.sent).includes("下一步应继续完成有界实现"),
    true
  );

  const stopResponse = await routes.stop.POST(
    trustedMutationRequest(`/api/workbench/runs/${body.run.id}/stop`, {}),
    { params: { id: body.run.id } }
  );
  assert.equal(stopResponse.status, 200);
});

test("a completed plan launches one fresh execution child with the plan lineage", async () => {
  const planRun = createWorkbenchRun({
    prompt: "plan source fixture",
    source: "app-server",
    collaborationMode: "plan",
    taskTitle: "课程计划执行"
  });
  const planWorkspace = await ensureWorkbenchSessionWorkspace({
    runId: planRun.id,
    createdAt: planRun.createdAt,
    taskTitle: planRun.taskTitle ?? "课程计划执行",
    lineage: planRun.lineage,
    sourceRoot: process.cwd()
  });
  setWorkbenchSessionWorkspace(planRun.id, planWorkspace);
  setWorkbenchPlan(planRun.id, {
    explanation: "先核验，再实现。",
    steps: [
      { step: "核验当前安全投影", status: "pending" },
      { step: "完成有界实现并测试", status: "pending" }
    ]
  });
  const completedPlan = completeWorkbenchRun(
    planRun.id,
    "completed",
    "计划已经形成，可以开启新的执行任务。"
  );
  assert.ok(completedPlan);
  await persistWorkbenchRunSnapshot(completedPlan);
  resetWorkbenchStoreForTests();

  const transport = new RouteFakeTransport();
  setWorkbenchTransportFactory(() => transport);
  const launchRoute = await import("../../app/api/workbench/runs/[id]/launch/route");
  const requestId = "11111111-2222-4333-8444-555555555555";
  const response = await launchRoute.POST(
    trustedMutationRequest(`/api/workbench/runs/${planRun.id}/launch`, {
      kind: "plan-execution",
      requestId
    }),
    { params: { id: planRun.id } }
  );
  assert.equal(response.status, 202);
  const body = await response.json() as {
    run: {
      id: string;
      collaborationMode?: string;
      plan?: { steps: Array<{ step: string; status: string }> };
      lineage?: Record<string, unknown>;
      sessionWorkspace?: { key: string };
    };
  };
  assert.deepEqual(body.run.lineage, {
    schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
    relation: "plan-execution",
    rootRunId: planRun.id,
    parentRunId: planRun.id,
    planRunId: planRun.id,
    generation: 1,
    requestId
  });
  assert.equal(body.run.collaborationMode, "default");
  assert.deepEqual(body.run.plan?.steps.map((step) => step.step), [
    "核验当前安全投影",
    "完成有界实现并测试"
  ]);
  assert.notEqual(body.run.sessionWorkspace?.key, planWorkspace.key);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(JSON.stringify(transport.sent).includes("核验当前安全投影"), true);

  const routes = await loadRoutes();
  const stopResponse = await routes.stop.POST(
    trustedMutationRequest(`/api/workbench/runs/${body.run.id}/stop`, {}),
    { params: { id: body.run.id } }
  );
  assert.equal(stopResponse.status, 200);
});

test("plan execution rejects a second turn when it produced no replacement plan", async () => {
  const planRun = createWorkbenchRun({
    prompt: "plan follow-up invalidation fixture",
    source: "app-server",
    collaborationMode: "plan"
  });
  const workspace = await ensureWorkbenchSessionWorkspace({
    runId: planRun.id,
    createdAt: planRun.createdAt,
    taskTitle: planRun.taskTitle ?? "计划任务",
    lineage: planRun.lineage,
    sourceRoot: process.cwd()
  });
  setWorkbenchSessionWorkspace(planRun.id, workspace);
  const transport = new RouteFakeTransport();
  setWorkbenchTransportFactory(() => transport);
  await startCodexAppServerRun(planRun.id, "plan follow-up invalidation fixture", {
    collaborationMode: "plan",
    goalMode: false
  });

  transport.emit({
    method: "item/completed",
    params: {
      item: {
        type: "agentMessage",
        phase: "final_answer",
        status: "completed",
        text: JSON.stringify({
          summary: "第一轮计划已经形成。",
          planSteps: ["第一轮计划步骤"],
          executionBoundary: "等待执行。",
          safety: {
            externalMutationAttempted: false,
            containsForumText: false,
            realPublishEnabled: false
          }
        })
      }
    }
  });
  transport.emit({ method: "turn/completed", params: { turn: { status: "completed" } } });
  assert.equal(getWorkbenchRun(planRun.id)?.plan?.steps.length, 1);

  const routes = await loadRoutes();
  const followUp = await routes.messages.POST(
    trustedMutationRequest(`/api/workbench/runs/${planRun.id}/messages`, { prompt: "second turn without plan" }),
    { params: { id: planRun.id } }
  );
  assert.equal(followUp.status, 202);
  transport.emit({ method: "turn/completed", params: { turn: { status: "completed" } } });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const launchRoute = await import("../../app/api/workbench/runs/[id]/launch/route");
  const response = await launchRoute.POST(
    trustedMutationRequest(`/api/workbench/runs/${planRun.id}/launch`, {
      kind: "plan-execution",
      requestId: "22222222-3333-4444-8555-666666666666"
    }),
    { params: { id: planRun.id } }
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code?: string }).code, "WORKBENCH_PLAN_NOT_READY");
});

test("a live run never starts the execution engine when its session folder cannot be created", async () => {
  const blockedRoot = path.join(routeSessionProjectRoot, "blocked-session-root");
  await writeFile(blockedRoot, "not a directory", "utf8");
  setWorkbenchSessionWorkspaceRootForTests(blockedRoot);
  let transportStarted = false;
  setWorkbenchTransportFactory(() => {
    transportStarted = true;
    return new RouteFakeTransport();
  });
  const routes = await loadRoutes();
  const response = await routes.create.POST(
    trustedMutationRequest("/api/workbench/runs", {
      prompt: "folder failure fixture",
      mode: "live"
    })
  );
  assert.equal(response.status, 503);
  assert.equal(
    (await response.json() as { code?: string }).code,
    "WORKBENCH_SESSION_WORKSPACE_UNAVAILABLE"
  );
  assert.equal(transportStarted, false);
});

test("follow-up route is guarded, rejects demo runs, and steers the same live thread", async () => {
  const routes = await loadRoutes();
  const demo = createWorkbenchRun({ prompt: "demo guidance fixture", source: "demo" });

  const crossOrigin = trustedMutationRequest(
    `/api/workbench/runs/${demo.id}/messages`,
    { prompt: "fixture guidance" },
    { Origin: "http://attacker.example", "Sec-Fetch-Site": "cross-site" }
  );
  assert.equal((await routes.messages.POST(crossOrigin, { params: { id: demo.id } })).status, 403);

  const unknownField = trustedMutationRequest(
    `/api/workbench/runs/${demo.id}/messages`,
    { prompt: "fixture guidance", cwd: "C:/fixture" }
  );
  assert.equal((await routes.messages.POST(unknownField, { params: { id: demo.id } })).status, 400);

  const demoResponse = await routes.messages.POST(
    trustedMutationRequest(`/api/workbench/runs/${demo.id}/messages`, { prompt: "fixture guidance" }),
    { params: { id: demo.id } }
  );
  assert.equal(demoResponse.status, 409);
  assert.equal((await demoResponse.json() as { code?: string }).code, "WORKBENCH_DEMO_READ_ONLY");

  resetWorkbenchStoreForTests();
  const transport = new RouteFakeTransport();
  setWorkbenchTransportFactory(() => transport);
  const liveResponse = await routes.create.POST(
    trustedMutationRequest("/api/workbench/runs", { prompt: "live guidance fixture", mode: "live" })
  );
  assert.equal(liveResponse.status, 202);
  const liveBody = (await liveResponse.json()) as { run: { id: string } };
  await new Promise((resolve) => setTimeout(resolve, 10));

  const mismatchedContextResponse = await routes.messages.POST(
    trustedMutationRequest(`/api/workbench/runs/${liveBody.run.id}/messages`, {
      prompt: "continue with mismatched context",
      priorActionReceipts: [{
        actionType: "context.attach_focused",
        status: "completed",
        summary: "已加入匿名学习者上下文",
        contextRef: "learner:snapshot_fixture__actor-007",
        containsForumText: false,
        externalWrites: false
      }]
    }),
    { params: { id: liveBody.run.id } }
  );
  assert.equal(mismatchedContextResponse.status, 409);
  assert.equal(
    (await mismatchedContextResponse.json() as { code?: string }).code,
    "WORKBENCH_CONTEXT_MISMATCH"
  );

  const guidanceResponse = await routes.messages.POST(
    trustedMutationRequest(`/api/workbench/runs/${liveBody.run.id}/messages`, {
      prompt: "continue safely",
      priorActionReceipts: [{
        actionType: "navigate",
        status: "completed",
        summary: "已打开社会网络",
        containsForumText: false,
        externalWrites: false
      }]
    }),
    { params: { id: liveBody.run.id } }
  );
  assert.equal(guidanceResponse.status, 202);
  assert.equal(
    transport.sent.filter((line) => (JSON.parse(line) as Record<string, unknown>).method === "turn/steer").length,
    1
  );
});

test("a completed run persists the newest final answer after follow-up steering", async () => {
  const routes = await loadRoutes();
  const transport = new RouteFakeTransport();
  setWorkbenchTransportFactory(() => transport);
  const response = await routes.create.POST(
    trustedMutationRequest("/api/workbench/runs", { prompt: "first turn", mode: "live" })
  );
  const body = (await response.json()) as { run: { id: string } };
  await new Promise((resolve) => setTimeout(resolve, 10));

  transport.emit({
    method: "item/completed",
    params: {
      item: {
        type: "agentMessage",
        phase: "final_answer",
        status: "completed",
        text: JSON.stringify({
          summary: "第一轮已经完成，并形成了可核验的安全摘要。",
          completedActions: ["核验第一轮状态"],
          nextStep: "继续第二轮。",
          safety: {
            externalMutationAttempted: false,
            containsForumText: false,
            realPublishEnabled: false
          }
        })
      }
    }
  });
  transport.emit({ method: "turn/completed", params: { turn: { status: "completed" } } });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const guidance = await routes.messages.POST(
    trustedMutationRequest(`/api/workbench/runs/${body.run.id}/messages`, { prompt: "continue safely" }),
    { params: { id: body.run.id } }
  );
  assert.equal(guidance.status, 202);

  transport.emit({
    method: "item/completed",
    params: {
      item: {
        type: "agentMessage",
        phase: "final_answer",
        status: "completed",
        text: JSON.stringify({
          summary: "第二轮已经完成；这是历史恢复时必须看到的最新答复。",
          completedActions: ["核验第二轮状态", "更新最终答复"],
          nextStep: "打开历史记录复核。",
          safety: {
            externalMutationAttempted: false,
            containsForumText: false,
            realPublishEnabled: false
          }
        })
      }
    }
  });
  transport.emit({ method: "turn/completed", params: { turn: { status: "completed" } } });

  let persisted = await loadPersistentWorkbenchRun(body.run.id);
  for (let attempt = 0; attempt < 20 && !persisted?.finalResult?.summary.includes("第二轮"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    persisted = await loadPersistentWorkbenchRun(body.run.id);
  }
  assert.match(persisted?.finalResult?.summary ?? "", /第二轮/);
});
