import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { loadCourseManifest } from "../../lib/autonomy/course-manifest";
import { prisma } from "../../lib/db";
import {
  resetCodexAppServerForTests,
  setCodexRuntimeProbeForTests,
  setWorkbenchTransportFactory,
  type CodexTransport
} from "../../lib/workbench/codex-app-server";
import { COURSE_AGENT_PLAN_COMPILER_VERSION } from "../../lib/workbench/course-agent-plan";
import { MVP_COURSE_AGENT_PLAN_COMPILER_VERSION } from "../../lib/workbench/course-agent-mvp-planner";
import { resetCourseAgentProcessSessionsForTests } from "../../lib/workbench/course-agent-session";
import { resetWorkbenchHistorySubscriptionsForTests } from "../../lib/workbench/history-store";
import { getWorkbenchRun, resetWorkbenchStoreForTests } from "../../lib/workbench/run-store";
import {
  resetWorkbenchSessionWorkspaceForTests,
  setWorkbenchSessionWorkspaceRootForTests
} from "../../lib/workbench/session-workspace";
import { setWorkbenchTrustedStageProviderSourceForTests } from "../../lib/workbench/workbench-course-agent-toolkit-factory";
import {
  seedSyntheticCourseAgentWorld
} from "../fixtures/workbench-course-agent-world";

type JsonRecord = Record<string, unknown>;

const COURSE_ALIAS = "governance-cli-fixture";

type Scenario = Readonly<{
  key: "research" | "schedule" | "open";
  goalCode: "research_evidence_package" | "schedule_review" | "open_course_task";
  prompt: string;
  tools: readonly string[];
  artifactKinds: readonly ("research_evidence_package" | "schedule_review_bundle")[];
  verifierCheckPrefixes: readonly string[];
  compilerVersion: string;
}>; 

const SCENARIOS: readonly Scenario[] = [
  {
    key: "research",
    goalCode: "research_evidence_package",
    prompt:
      `请生成一份研究证据包，供后续方法审计；私密请求哨兵 research-route-${process.pid}。`,
    tools: [
      "course.context.resolve",
      "course.snapshot.read",
      "research.evidence_package.prepare"
    ],
    artifactKinds: ["research_evidence_package"],
    verifierCheckPrefixes: ["verification.research_evidence_package."],
    compilerVersion: COURSE_AGENT_PLAN_COMPILER_VERSION
  },
  {
    key: "schedule",
    goalCode: "schedule_review",
    prompt:
      `请做课程排期审查，但不要启动或修改调度；私密请求哨兵 schedule-route-${process.pid}。`,
    tools: ["course.schedule.read", "schedule.review_bundle.create"],
    artifactKinds: ["schedule_review_bundle"],
    verifierCheckPrefixes: [
      "verification.course_schedule_read.",
      "verification.schedule_review_bundle."
    ],
    compilerVersion: COURSE_AGENT_PLAN_COMPILER_VERSION
  },
  {
    key: "open",
    goalCode: "open_course_task",
    prompt:
      `请先检查课程排期，再生成一份研究证据包；私密请求哨兵 open-route-${process.pid}。`,
    tools: [
      "course.context.resolve",
      "course.snapshot.read",
      "research.evidence_package.prepare",
      "course.schedule.read",
      "schedule.review_bundle.create"
    ],
    artifactKinds: ["research_evidence_package", "schedule_review_bundle"],
    verifierCheckPrefixes: [
      "verification.research_evidence_package.",
      "verification.course_schedule_read.",
      "verification.schedule_review_bundle."
    ],
    compilerVersion: MVP_COURSE_AGENT_PLAN_COMPILER_VERSION
  }
] as const;

function asRecord(value: unknown, label: string): JsonRecord {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  return value as JsonRecord;
}

function stringField(value: JsonRecord, field: string): string {
  const result = value[field];
  assert.equal(typeof result, "string", `${field} must be a string`);
  return result as string;
}

function trustedMutationRequest(pathname: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${pathname}`, {
    method: "POST",
    headers: {
      Host: "localhost:3000",
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
      "Sec-Fetch-Site": "same-origin"
    },
    body: JSON.stringify(body)
  });
}

async function waitFor<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeoutMs = 20_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!accept(latest)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    latest = await read();
  }
  return latest;
}

class TaskFamilyRouteTransport implements CodexTransport {
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();
  private readonly serverResponses = new Map<
    string,
    (message: JsonRecord) => void
  >();
  private nextServerRequestId = 0;

  readonly dynamicToolNames: string[] = [];
  readonly modelToolCalls: Array<{
    protocolName: string;
    businessInput: JsonRecord;
  }> = [];
  readonly turnPrompts: string[] = [];
  threadId = "";
  turnId = "";

  constructor(private readonly scenarioKey: string) {}

  send(line: string): void {
    const message = asRecord(JSON.parse(line) as unknown, "transport message");
    const method = message.method;
    if (message.id !== undefined && typeof method === "string") {
      let result: JsonRecord = {};
      if (method === "thread/start") {
        this.threadId = `task-family-${this.scenarioKey}-thread`;
        const params = asRecord(message.params, "thread/start params");
        const tools = params.dynamicTools;
        assert.ok(Array.isArray(tools));
        this.dynamicToolNames.push(
          ...tools.map((entry) =>
            stringField(asRecord(entry, "dynamic tool"), "name")
          )
        );
        result = { thread: { id: this.threadId } };
      } else if (method === "turn/start") {
        this.turnId = `task-family-${this.scenarioKey}-turn`;
        const params = asRecord(message.params, "turn/start params");
        const input = params.input;
        assert.ok(Array.isArray(input));
        this.turnPrompts.push(
          stringField(asRecord(input[0], "turn input"), "text")
        );
        result = { turn: { id: this.turnId } };
      }
      queueMicrotask(() => this.emit({ id: message.id, result }));
      return;
    }
    if (
      message.id !== undefined &&
      (message.result !== undefined || message.error !== undefined)
    ) {
      const resolve = this.serverResponses.get(String(message.id));
      if (resolve) {
        this.serverResponses.delete(String(message.id));
        resolve(message);
      }
    }
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
    // The production app-server lifecycle runs over this deterministic pipe.
  }

  private emit(message: JsonRecord): void {
    const line = JSON.stringify(message);
    for (const listener of this.lineListeners) listener(line);
  }

  async waitForTurn(): Promise<void> {
    await waitFor(
      () => this.turnPrompts.length,
      (value) => value === 1,
      `${this.scenarioKey} turn`
    );
  }

  async callTool(toolName: string, businessInput: JsonRecord): Promise<JsonRecord> {
    assert.ok(this.threadId);
    assert.ok(this.turnId);
    const protocolName = toolName.replace(/\./gu, "_");
    assert.ok(this.dynamicToolNames.includes(protocolName));
    const requestId =
      `task-family-${this.scenarioKey}-tool-${++this.nextServerRequestId}`;
    const responsePromise = new Promise<JsonRecord>((resolve) => {
      this.serverResponses.set(requestId, resolve);
    });
    this.modelToolCalls.push({ protocolName, businessInput });
    this.emit({
      id: requestId,
      method: "item/tool/call",
      params: {
        callId: `native-${requestId}`,
        threadId: this.threadId,
        turnId: this.turnId,
        tool: protocolName,
        arguments: businessInput
      }
    });
    const response = await responsePromise;
    assert.equal(response.error, undefined);
    const result = asRecord(response.result, "dynamic tool response");
    assert.equal(result.success, true, JSON.stringify(result));
    const contentItems = result.contentItems;
    assert.ok(Array.isArray(contentItems));
    const payload = asRecord(
      JSON.parse(
        stringField(asRecord(contentItems[0], "dynamic tool content"), "text")
      ) as unknown,
      "dynamic tool payload"
    );
    assert.equal(payload.status, "succeeded", JSON.stringify(payload));
    return asRecord(payload.data, "dynamic tool data");
  }

  completeGoalAndRun(): void {
    this.emit({
      method: "item/completed",
      params: {
        item: {
          id: `task-family-${this.scenarioKey}-final`,
          type: "agentMessage",
          phase: "final_answer",
          status: "completed",
          text: JSON.stringify({
            summary: "版本化、可验证的零外部写入成果已完成。",
            completedActions: ["已按精确课程锚点完成全部 canonical plan 步骤。"],
            nextStep: "无需继续执行。",
            citations: [],
            safety: {
              externalMutationAttempted: false,
              containsForumText: false,
              realPublishEnabled: false
            }
          })
        }
      }
    });
    this.emit({
      method: "thread/goal/updated",
      params: {
        goal: { status: "complete", tokensUsed: 300, timeUsedSeconds: 3 }
      }
    });
    this.emit({
      method: "turn/completed",
      params: { turn: { id: this.turnId, status: "completed" } }
    });
  }
}

async function readTextFilesRecursively(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      parts.push(await readTextFilesRecursively(absolute));
    } else if (entry.isFile()) {
      parts.push(await readFile(absolute, "utf8"));
    }
  }
  return parts.join("\n");
}

function databaseFilesForPrivacyScan(): readonly Buffer[] {
  const url = process.env.DATABASE_URL;
  if (!url?.startsWith("file:")) {
    throw new Error("task-family E2E requires a file-backed test database");
  }
  const raw = url.slice("file:".length);
  const databasePath = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  return [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`
  ]
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => readFileSync(candidate));
}

async function writeCourseManifest(input: {
  root: string;
  courseAlias: string;
}): Promise<void> {
  await mkdir(input.root, { recursive: true });
  await writeFile(
    path.join(input.root, `${input.courseAlias}-course.json`),
    JSON.stringify({
      schemaVersion: "cmooc.course-manifest.v1",
      alias: input.courseAlias,
      platformId: "cmooc.bnu",
      courseId: "12345678",
      canonicalUrl: "https://example.test/course?courseId=12345678&isBack=1",
      allowedOrigins: ["https://example.test"],
      adapterId: "workbench.one-sentence.e2e",
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
}

async function seedScheduleReadState(input: {
  courseAlias: string;
  suffix: string;
}): Promise<{ scheduleId: string }> {
  const scheduleId = `schedule-${input.courseAlias}`;
  await prisma.operationSchedule.upsert({
    where: { id: scheduleId },
    create: {
      id: scheduleId,
      courseAlias: input.courseAlias,
      scheduleKey: `schedule-key-${input.courseAlias}`,
      mode: "SHADOW",
      intervalMinutes: 30,
      timeZone: "UTC",
      enabled: true,
      nextRunAt: new Date(Date.now() + 30 * 60_000),
      budgetJson: JSON.stringify({ dailySlots: 2, containsForumText: false })
    },
    update: {}
  });
  return { scheduleId };
}

async function resetRouteHarness(sessionRoot: string): Promise<void> {
  await resetWorkbenchHistorySubscriptionsForTests();
  resetWorkbenchStoreForTests();
  resetCodexAppServerForTests();
  resetCourseAgentProcessSessionsForTests();
  resetWorkbenchSessionWorkspaceForTests();
  setWorkbenchSessionWorkspaceRootForTests(sessionRoot);
  setWorkbenchTrustedStageProviderSourceForTests(undefined);
}

for (const scenario of SCENARIOS) {
  test(`one natural-language route completes the real ${scenario.goalCode} task family`, async () => {
    const testRoot = await mkdtemp(
      path.join(tmpdir(), `cmooc-task-family-${scenario.key}-`)
    );
    const manifestRoot = path.join(testRoot, "course-manifests");
    const sessionRoot = path.join(testRoot, "智能控制台会话");
    const previousManifestRoot = process.env.CMOOC_COURSE_MANIFEST_DIR;
    const previousTrustedStage = process.env.CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED;
    const previousAutoReversibleStage =
      process.env.CMOOC_WORKBENCH_AUTO_REVERSIBLE_STAGE_ENABLED;
    const previousLlmMode = process.env.LLM_MODE;
    const courseAlias = COURSE_ALIAS;
    const suffix = `${scenario.key}-${process.pid}`;
    const transport = new TaskFamilyRouteTransport(scenario.key);

    try {
      await resetRouteHarness(sessionRoot);
      await writeCourseManifest({ root: manifestRoot, courseAlias });
      process.env.CMOOC_COURSE_MANIFEST_DIR = manifestRoot;
      delete process.env.CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED;
      delete process.env.CMOOC_WORKBENCH_AUTO_REVERSIBLE_STAGE_ENABLED;
      process.env.LLM_MODE = "mock";
      const manifest = await loadCourseManifest(courseAlias);
      const world = await seedSyntheticCourseAgentWorld({
        prisma,
        courseAlias,
        manifestHash: manifest.manifestHash,
        suffix
      });
      const scheduleFixture =
        scenario.key === "schedule" || scenario.key === "open"
          ? await seedScheduleReadState({ courseAlias, suffix })
          : undefined;
      setCodexRuntimeProbeForTests(async () => "ready");
      setWorkbenchTransportFactory(() => transport);

      const [
        executionAttemptCountBefore,
        publishAttemptCountBefore,
        scheduledInvocationCountBefore,
        scheduleBefore,
        wakeCountBefore
      ] = await Promise.all([
        prisma.executionAttempt.count(),
        prisma.publishAttempt.count(),
        prisma.scheduledInvocation.count({ where: { courseAlias } }),
        scheduleFixture
          ? prisma.operationSchedule.findUniqueOrThrow({
              where: { id: scheduleFixture.scheduleId }
            })
          : Promise.resolve(null),
        prisma.autonomyWorkerWakeReceipt.count()
      ]);

      const createRoute = await import("../../app/api/workbench/runs/route");
      const createResponse = await createRoute.POST(
        trustedMutationRequest("/api/workbench/runs", {
          prompt: scenario.prompt,
          mode: "live",
          intent: "implement",
          goalMode: true,
          contextRef: `snapshot:${world.snapshotId}`
        })
      );
      assert.equal(createResponse.status, 202, await createResponse.clone().text());
      const createBody = asRecord(await createResponse.json(), "create response");
      const createdRun = asRecord(createBody.run, "created run");
      const runId = stringField(createdRun, "id");
      const taskId = `task-${runId}`;
      const contextRef = `snapshot:${world.snapshotId}`;
      assert.equal(createdRun.courseGoalCode, scenario.goalCode);

      await transport.waitForTurn();
      assert.equal(transport.turnPrompts[0]?.includes(scenario.prompt), true);
      assert.deepEqual(
        transport.dynamicToolNames,
        scenario.tools.map((name) => name.replace(/\./gu, "_"))
      );
      const initialPlan =
        await prisma.workbenchPlanRevisionRecord.findFirstOrThrow({
          where: { taskId, runId },
          include: { steps: { orderBy: { ordinal: "asc" } } }
        });
      assert.equal(initialPlan.compilerVersion, scenario.compilerVersion);
      assert.deepEqual(
        initialPlan.steps.map((step) => step.toolName),
        scenario.tools
      );
      assert.deepEqual(
        initialPlan.steps.map((step) => step.status),
        Array(scenario.tools.length).fill("pending")
      );

      let finalToolOutput: JsonRecord | undefined;
      for (const toolName of scenario.tools) {
        finalToolOutput = await transport.callTool(toolName, { contextRef });
        if (toolName === "course.schedule.read") {
          assert.equal(finalToolOutput.status, "ready");
          assert.equal(
            asRecord(finalToolOutput.schedule, "schedule projection")
              .externalWritesLocked,
            true
          );
          assert.equal(finalToolOutput.zeroWriteStatus, "unavailable");
        }
      }
      assert.ok(finalToolOutput);
      assert.equal(finalToolOutput.status, "prepared");
      const artifactPointer = asRecord(finalToolOutput.artifact, "artifact pointer");
      assert.equal(typeof artifactPointer.version, "number");
      assert.equal(stringField(artifactPointer, "versionRef").startsWith("artifact-version:"), true);
      transport.completeGoalAndRun();

      const completedRun = await waitFor(
        () => getWorkbenchRun(runId),
        (value) => value?.status === "completed" && value.goal?.status === "complete",
        `${scenario.key} completed run and goal`
      );
      assert.ok(completedRun);
      const persistedRun = await waitFor(
        () => prisma.workbenchRunRecord.findUnique({ where: { id: runId } }),
        (value) => value?.status === "completed",
        `${scenario.key} durable completed run`
      );
      assert.ok(persistedRun);

      const [
        task,
        objective,
        finalPlan,
        toolCalls,
        receipts,
        verifications,
        artifacts,
        events,
        actionCount,
        stageTransactionCount,
        scheduleAfter,
        scheduledInvocationCountAfter,
        wakeCountAfter
      ] = await Promise.all([
        prisma.workbenchTask.findUniqueOrThrow({ where: { id: taskId } }),
        prisma.workbenchSafeTaskObjective.findUniqueOrThrow({ where: { taskId } }),
        prisma.workbenchPlanRevisionRecord.findUniqueOrThrow({
          where: { id: initialPlan.id },
          include: { steps: { orderBy: { ordinal: "asc" } } }
        }),
        prisma.workbenchToolCallRecord.findMany({
          where: { taskId, runId },
          orderBy: { createdAt: "asc" }
        }),
        prisma.workbenchToolReceiptRecord.findMany({
          where: { call: { taskId, runId } },
          orderBy: { createdAt: "asc" }
        }),
        prisma.workbenchVerificationRecord.findMany({
          where: { taskId, runId },
          orderBy: { createdAt: "asc" }
        }),
        prisma.workbenchArtifactVersionRecord.findMany({
          where: { taskId, runId },
          orderBy: { createdAt: "asc" }
        }),
        prisma.workbenchEventRecord.findMany({
          where: { runId },
          orderBy: { sequence: "asc" }
        }),
        prisma.workbenchCourseToolActionRecord.count({ where: { taskId, runId } }),
        prisma.workbenchStageTransactionRecord.count({ where: { taskId, runId } }),
        scheduleFixture
          ? prisma.operationSchedule.findUniqueOrThrow({
              where: { id: scheduleFixture.scheduleId }
            })
          : Promise.resolve(null),
        prisma.scheduledInvocation.count({ where: { courseAlias } }),
        prisma.autonomyWorkerWakeReceipt.count()
      ]);

      assert.equal(task.status, "completed");
      assert.equal(objective.source, "cmooc.course-agent-objective-classifier.v2");
      assert.equal(objective.safeSummary.includes(scenario.prompt), false);
      const structuredGoal = asRecord(
        JSON.parse(objective.structuredGoalJson) as unknown,
        "structured goal"
      );
      assert.equal(structuredGoal.goalCode, scenario.goalCode);
      assert.deepEqual(
        finalPlan.steps.map((step) => step.toolName),
        scenario.tools
      );
      assert.deepEqual(
        finalPlan.steps.map((step) => step.status),
        Array(scenario.tools.length).fill("completed")
      );
      assert.deepEqual(
        transport.modelToolCalls.map((call) => call.protocolName),
        scenario.tools.map((name) => name.replace(/\./gu, "_"))
      );
      assert.deepEqual(
        toolCalls.map((call) => call.toolName),
        scenario.tools
      );
      assert.equal(toolCalls.every((call) => call.status === "succeeded"), true);
      assert.equal(receipts.length, scenario.tools.length);
      assert.equal(receipts.every((receipt) => receipt.status === "succeeded"), true);
      assert.equal(
        receipts.every((receipt) => receipt.containsForumText === false),
        true
      );
      assert.equal(
        verifications.every(
          (verification) =>
            verification.verifier === "verification.course_tool_registry" &&
            verification.verifierVersion === "1"
        ),
        true
      );
      const verificationChecks = verifications.flatMap((verification) =>
        Object.keys(
          asRecord(
            Object.fromEntries(
              (JSON.parse(verification.checksJson) as Array<{ code: string }>).map(
                (check) => [check.code, true]
              )
            ),
            "verification checks"
          )
        )
      );
      for (const prefix of scenario.verifierCheckPrefixes) {
        assert.equal(
          verificationChecks.some((code) => code.startsWith(prefix)),
          true,
          prefix
        );
      }
      assert.equal(
        verifications.every((verification) => verification.status === "passed"),
        true
      );
      assert.deepEqual(
        artifacts.map((artifact) => artifact.artifactKind),
        scenario.artifactKinds
      );
      assert.equal(artifacts.every((artifact) => artifact.version === 1), true);
      assert.equal(artifacts.every((artifact) => artifact.contentRef === null), true);
      assert.equal(actionCount, 0);
      assert.equal(stageTransactionCount, 0);
      assert.equal(await prisma.executionAttempt.count(), executionAttemptCountBefore);
      assert.equal(await prisma.publishAttempt.count(), publishAttemptCountBefore);

      if (scenario.key === "schedule" || scenario.key === "open") {
        assert.deepEqual(scheduleAfter, scheduleBefore);
        assert.equal(scheduledInvocationCountAfter, scheduledInvocationCountBefore);
        assert.equal(wakeCountAfter, wakeCountBefore);
      }

      const publicAndDurable = JSON.stringify({
        createBody,
        completedRun,
        persistedRun,
        task,
        objective,
        finalPlan,
        toolCalls,
        receipts,
        verifications,
        artifacts,
        events
      });
      const sessionText = await readTextFilesRecursively(sessionRoot);
      const databaseFiles = databaseFilesForPrivacyScan();
      assert.equal(publicAndDurable.includes(scenario.prompt), false);
      assert.equal(sessionText.includes(scenario.prompt), false);
      assert.equal(
        databaseFiles.some((bytes) =>
          bytes.includes(Buffer.from(scenario.prompt, "utf8"))
        ),
        false
      );
    } finally {
      setWorkbenchTrustedStageProviderSourceForTests(undefined);
      setCodexRuntimeProbeForTests(undefined);
      setWorkbenchTransportFactory(undefined);
      await resetWorkbenchHistorySubscriptionsForTests();
      resetWorkbenchStoreForTests();
      resetCodexAppServerForTests();
      resetCourseAgentProcessSessionsForTests();
      resetWorkbenchSessionWorkspaceForTests();
      if (previousManifestRoot === undefined) {
        delete process.env.CMOOC_COURSE_MANIFEST_DIR;
      } else {
        process.env.CMOOC_COURSE_MANIFEST_DIR = previousManifestRoot;
      }
      if (previousTrustedStage === undefined) {
        delete process.env.CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED;
      } else {
        process.env.CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED = previousTrustedStage;
      }
      if (previousAutoReversibleStage === undefined) {
        delete process.env.CMOOC_WORKBENCH_AUTO_REVERSIBLE_STAGE_ENABLED;
      } else {
        process.env.CMOOC_WORKBENCH_AUTO_REVERSIBLE_STAGE_ENABLED =
          previousAutoReversibleStage;
      }
      if (previousLlmMode === undefined) {
        delete process.env.LLM_MODE;
      } else {
        process.env.LLM_MODE = previousLlmMode;
      }
      await rm(testRoot, { recursive: true, force: true });
    }
  });
}
