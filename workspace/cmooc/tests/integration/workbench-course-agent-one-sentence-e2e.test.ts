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
import {
  PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
  hashPreExecutionTargetObservation
} from "../../lib/autonomy/execution-permit";
import {
  hashCourseToolValue,
  type EvidenceRef
} from "../../lib/course-tools/contracts";
import { prisma } from "../../lib/db";
import {
  resetCodexAppServerForTests,
  setCodexRuntimeProbeForTests,
  setWorkbenchTransportFactory,
  type CodexTransport
} from "../../lib/workbench/codex-app-server";
import { COURSE_AGENT_PLAN_COMPILER_VERSION } from "../../lib/workbench/course-agent-plan";
import { resetCourseAgentProcessSessionsForTests } from "../../lib/workbench/course-agent-session";
import {
  resetWorkbenchHistorySubscriptionsForTests
} from "../../lib/workbench/history-store";
import { getWorkbenchRun, resetWorkbenchStoreForTests } from "../../lib/workbench/run-store";
import {
  resetWorkbenchSessionWorkspaceForTests,
  setWorkbenchSessionWorkspaceRootForTests
} from "../../lib/workbench/session-workspace";
import {
  WORKBENCH_STAGE_TARGET_RESOLUTION_SCHEMA_VERSION,
  buildResolvedWorkbenchStageTargetReceiptV2,
  type ResolvedWorkbenchStageTarget,
  type WorkbenchStageTargetResolver
} from "../../lib/workbench/trusted-workbench-platform-stage-adapter";
import {
  setWorkbenchTrustedStageProviderSourceForTests
} from "../../lib/workbench/workbench-course-agent-toolkit-factory";
import { createWorkbenchTrustedStageProviders } from "../../lib/workbench/workbench-trusted-stage-providers";
import {
  REAL_DOM_STAGE_FIXTURE_ORIGIN,
  REAL_DOM_STAGE_FIXTURE_TARGET_URL,
  createRealDomWorkbenchStageSessionFactory
} from "../fixtures/workbench-real-dom-stage-session";
import {
  seedSyntheticCourseAgentWorld,
  type SyntheticCourseAgentWorld
} from "../fixtures/workbench-course-agent-world";

const COURSE_ALIAS = "governance-cli-fixture";
const COURSE_ID = "12345678";
const CANONICAL_TOOLS = Object.freeze([
  "course.context.resolve",
  "course.snapshot.read",
  "opportunity.list",
  "opportunity.select_support_gap",
  "evidence.read_opportunity",
  "evidence.verify_integrity",
  "facilitation.intent.compose",
  "artifact.reply_draft.create",
  "platform.target.preflight_read",
  "platform.editor.stage_verify_clear",
  "delivery.bundle.create"
] as const);
const PRIVATE_PROMPT =
  "请基于精确快照核验支持缺口并形成零发布回复草稿，私密请求哨兵 7f0b26。";
const SIGNING_SECRET = Buffer.from(
  "synthetic-one-sentence-stage-secret-never-persisted-2026",
  "utf8"
);

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  return value as JsonRecord;
}

function stringField(value: JsonRecord, field: string): string {
  const result = value[field];
  assert.equal(typeof result, "string", `${field} must be a string`);
  return result as string;
}

function hash(label: string): string {
  return hashCourseToolValue(
    "test.workbench-course-agent-one-sentence-e2e.v1",
    label
  );
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
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    latest = await read();
  }
  return latest;
}

class OneSentenceRouteTransport implements CodexTransport {
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();
  private readonly serverResponses = new Map<
    string,
    (message: JsonRecord) => void
  >();
  private nextServerRequestId = 0;
  private turnCount = 0;

  readonly sent: string[] = [];
  readonly turnPrompts: string[] = [];
  readonly dynamicToolNames: string[] = [];
  readonly modelToolCalls: Array<{
    protocolName: string;
    businessInput: JsonRecord;
    turnId: string;
  }> = [];
  threadId = "";
  turnId = "";

  send(line: string): void {
    this.sent.push(line);
    const message = asRecord(JSON.parse(line) as unknown, "transport message");
    const method = message.method;
    if (message.id !== undefined && typeof method === "string") {
      let result: JsonRecord = {};
      if (method === "thread/start") {
        this.threadId = "one-sentence-native-thread";
        const params = asRecord(message.params, "thread/start params");
        const tools = params.dynamicTools;
        assert.ok(Array.isArray(tools));
        this.dynamicToolNames.push(
          ...tools.map((entry) => stringField(asRecord(entry, "dynamic tool"), "name"))
        );
        result = { thread: { id: this.threadId } };
      } else if (method === "turn/start") {
        this.turnCount += 1;
        this.turnId = `one-sentence-native-turn-${this.turnCount}`;
        const params = asRecord(message.params, "turn/start params");
        const input = params.input;
        assert.ok(Array.isArray(input));
        const first = asRecord(input[0], "turn input");
        this.turnPrompts.push(stringField(first, "text"));
        result = { turn: { id: this.turnId } };
      }
      queueMicrotask(() => this.emit({ id: message.id, result }));
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
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
    // The real app-server lifecycle is exercised over this deterministic pipe.
  }

  private emit(message: JsonRecord): void {
    const line = JSON.stringify(message);
    for (const listener of this.lineListeners) listener(line);
  }

  async waitForTurn(count: number): Promise<void> {
    await waitFor(
      () => this.turnPrompts.length,
      (value) => value >= count,
      `turn ${count}`
    );
  }

  async callTool(toolName: string, businessInput: JsonRecord): Promise<JsonRecord> {
    assert.ok(this.threadId);
    assert.ok(this.turnId);
    const protocolName = toolName.replace(/\./gu, "_");
    assert.ok(this.dynamicToolNames.includes(protocolName));
    const requestId = `model-tool-${++this.nextServerRequestId}`;
    const responsePromise = new Promise<JsonRecord>((resolve) => {
      this.serverResponses.set(requestId, resolve);
    });
    this.modelToolCalls.push({ protocolName, businessInput, turnId: this.turnId });
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
    const item = asRecord(contentItems[0], "dynamic tool content");
    const payload = asRecord(
      JSON.parse(stringField(item, "text")) as unknown,
      "dynamic tool payload"
    );
    assert.equal(payload.status, "succeeded", JSON.stringify(payload));
    return asRecord(payload.data, "dynamic tool data");
  }

  completeTurn(): void {
    this.emit({
      method: "turn/completed",
      params: { turn: { id: this.turnId, status: "completed" } }
    });
  }

  completeGoalAndRun(): void {
    const summary = [
      "精确课程证据链已经完成核验，成熟支持缺口由版本化选择规则唯一确定。",
      "促进意图与受保护草稿均通过机械验证；草稿正文只在短期受保护内存中使用，没有进入持久化记录。",
      "测试平台编辑器完成一次写入、一次回读和一次清空，提交、发送与通知计数均为零。",
      "最终零发布交付包已经版本化并绑定全部前序回执，当前计划无需继续执行其他动作。"
    ].join("");
    this.emit({
      method: "item/completed",
      params: {
        item: {
          id: "final-safe-result",
          type: "agentMessage",
          phase: "final_answer",
          status: "completed",
          text: JSON.stringify({
            summary,
            completedActions: [
              "完成精确证据与支持缺口核验。",
              "完成受保护草稿及零发布暂存核验。",
              "完成版本化交付包与持久回执核验。"
            ],
            nextStep: "无需继续；如需真实课程动作，必须另行经过课程级治理与发布硬锁。",
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
        goal: {
          status: "complete",
          tokensUsed: 1_100,
          timeUsedSeconds: 11
        }
      }
    });
    this.completeTurn();
  }
}

function targetResolver(input: {
  world: SyntheticCourseAgentWorld;
  manifestHash: string;
}): WorkbenchStageTargetResolver {
  return {
    resolve: async (request) => {
      const observationReceipt = Object.freeze({
        schemaVersion: PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
        courseAlias: COURSE_ALIAS,
        threadKey: request.target.threadKey,
        targetVersionHash: request.target.targetVersionHash,
        eventSetHash: request.target.eventSetHash,
        observedAt: request.requestedAt,
        containsForumText: false as const
      });
      const freshObservation = Object.freeze({
        receipt: observationReceipt,
        receiptHash: hashPreExecutionTargetObservation(observationReceipt)
      });
      const targetLocatorHash = hash("synthetic-target-locator");
      const built = buildResolvedWorkbenchStageTargetReceiptV2({
        target: request.target,
        courseAlias: request.courseAlias,
        courseScopeHash: request.courseScopeHash,
        manifestHash: request.manifestHash,
        courseLocatorHash: input.manifestHash,
        targetLocatorHash,
        freshObservation
      });
      const snapshotEvidence: EvidenceRef = Object.freeze({
        kind: "snapshot",
        id: input.world.snapshotId,
        hash: input.world.worldHash,
        observedAt: request.requestedAt
      });
      const resolved: ResolvedWorkbenchStageTarget = Object.freeze({
        schemaVersion: WORKBENCH_STAGE_TARGET_RESOLUTION_SCHEMA_VERSION,
        targetUrl: REAL_DOM_STAGE_FIXTURE_TARGET_URL,
        allowedOrigin: REAL_DOM_STAGE_FIXTURE_ORIGIN,
        courseLocatorHash: built.receipt.courseLocatorHash,
        targetLocatorHash: built.receipt.targetLocatorHash,
        targetVersionHash: built.receipt.targetVersionHash,
        eventSetHash: built.receipt.eventSetHash,
        sourceRevalidationReceiptHash:
          built.receipt.sourceRevalidationReceiptHash,
        sourceAfterObservationReceiptHash:
          built.receipt.sourceAfterObservationReceiptHash,
        freshObservation,
        freshObservationRef: built.receipt.freshObservationRef,
        freshObservationHash: built.receipt.freshObservationHash,
        resolvedAt: built.receipt.resolvedAt,
        resolvedTargetReceipt: built.receipt,
        resolvedTargetReceiptRef: built.receiptRef,
        resolvedTargetReceiptHash: built.receiptHash,
        evidenceRefs: [snapshotEvidence],
        readOnly: true,
        externalWriteAttempted: false,
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      });
      return resolved;
    }
  };
}

function stageVerificationRefFromResume(prompt: string): string {
  const match = prompt.match(
    /(?:"stageVerificationRef"\s*:\s*"|stageVerificationRef\s*[：:=]\s*)([A-Za-z0-9._:@-]+)/u
  );
  assert.ok(match?.[1], "approved STAGE resume must carry an exact stageVerificationRef");
  return match[1];
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

function databaseFilePath(): string {
  const url = process.env.DATABASE_URL;
  if (!url?.startsWith("file:")) {
    throw new Error("one-sentence E2E requires a file-backed test database");
  }
  const raw = url.slice("file:".length);
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function databaseFilesForPrivacyScan(): readonly Buffer[] {
  const databasePath = databaseFilePath();
  return [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`
  ]
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => readFileSync(candidate));
}

test("one sentence drives the real route through the exact 11-step zero-publish support-gap plan", async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "cmooc-one-sentence-e2e-"));
  const manifestRoot = path.join(testRoot, "course-manifests");
  const sessionRoot = path.join(testRoot, "智能控制台会话");
  const previousManifestRoot = process.env.CMOOC_COURSE_MANIFEST_DIR;
  const previousTrustedStage = process.env.CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED;
  const previousAutoReversibleStage =
    process.env.CMOOC_WORKBENCH_AUTO_REVERSIBLE_STAGE_ENABLED;
  const transport = new OneSentenceRouteTransport();
  const dom = createRealDomWorkbenchStageSessionFactory({
    scenario: { requestExpectedReadPost: true }
  });
  let providerSourceCalls = 0;

  try {
    await resetWorkbenchHistorySubscriptionsForTests();
    resetWorkbenchStoreForTests();
    resetCodexAppServerForTests();
    resetCourseAgentProcessSessionsForTests();
    setWorkbenchSessionWorkspaceRootForTests(sessionRoot);
    await mkdir(manifestRoot, { recursive: true });
    await writeFile(
      path.join(manifestRoot, `${COURSE_ALIAS}-course.json`),
      JSON.stringify({
        schemaVersion: "cmooc.course-manifest.v1",
        alias: COURSE_ALIAS,
        platformId: "cmooc.bnu",
        courseId: COURSE_ID,
        canonicalUrl:
          `https://example.test/course?courseId=${COURSE_ID}&isBack=1`,
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
    process.env.CMOOC_COURSE_MANIFEST_DIR = manifestRoot;
    process.env.CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED = "1";
    delete process.env.CMOOC_WORKBENCH_AUTO_REVERSIBLE_STAGE_ENABLED;
    const manifest = await loadCourseManifest(COURSE_ALIAS);
    const world = await seedSyntheticCourseAgentWorld({
      prisma,
      courseAlias: COURSE_ALIAS,
      manifestHash: manifest.manifestHash,
      suffix: `one-sentence-${process.pid}`
    });
    const providers = createWorkbenchTrustedStageProviders({
      db: prisma,
      courseAlias: COURSE_ALIAS,
      targetResolver: targetResolver({ world, manifestHash: manifest.manifestHash }),
      browserSessionFactory: dom.factory,
      signingSecretProvider: async () => Buffer.from(SIGNING_SECRET)
    });
    setWorkbenchTrustedStageProviderSourceForTests(() => {
      providerSourceCalls += 1;
      return providers;
    });
    setCodexRuntimeProbeForTests(async () => "ready");
    setWorkbenchTransportFactory(() => transport);

    const [executionAttemptCountBefore, publishAttemptCountBefore] =
      await Promise.all([
        prisma.executionAttempt.count(),
        prisma.publishAttempt.count()
      ]);
    const createRoute = await import("../../app/api/workbench/runs/route");
    const createResponse = await createRoute.POST(
      trustedMutationRequest("/api/workbench/runs", {
        prompt: PRIVATE_PROMPT,
        mode: "live",
        intent: "implement",
        goalMode: true,
        contextRef: `snapshot:${world.snapshotId}`
      })
    );
    assert.equal(createResponse.status, 202);
    const createBody = asRecord(await createResponse.json(), "create response");
    const createdRun = asRecord(createBody.run, "created run");
    const runId = stringField(createdRun, "id");
    assert.equal(createdRun.courseGoalCode, "course_evidence_support_gap");
    assert.equal(providerSourceCalls, 0, "trusted provider stays lazy through route construction");

    await transport.waitForTurn(1);
    assert.deepEqual(
      transport.dynamicToolNames,
      CANONICAL_TOOLS.map((name) => name.replace(/\./gu, "_"))
    );
    const taskId = `task-${runId}`;
    const contextRef = `snapshot:${world.snapshotId}`;
    const initialPlan = await prisma.workbenchPlanRevisionRecord.findFirstOrThrow({
      where: { taskId, runId },
      include: { steps: { orderBy: { ordinal: "asc" } } }
    });
    assert.equal(initialPlan.compilerVersion, COURSE_AGENT_PLAN_COMPILER_VERSION);
    assert.deepEqual(initialPlan.steps.map((step) => step.toolName), CANONICAL_TOOLS);
    assert.deepEqual(initialPlan.steps.map((step) => step.status), Array(11).fill("pending"));

    await transport.callTool(CANONICAL_TOOLS[0], { contextRef });
    await transport.callTool(CANONICAL_TOOLS[1], { contextRef });
    await transport.callTool(CANONICAL_TOOLS[2], { contextRef });
    const selection = await transport.callTool(CANONICAL_TOOLS[3], { contextRef });
    const opportunityId = stringField(selection, "selectedOpportunityId");
    assert.equal(opportunityId, `support-gap:${world.candidateKey}`);
    await transport.callTool(CANONICAL_TOOLS[4], { contextRef, opportunityId });
    const integrity = await transport.callTool(CANONICAL_TOOLS[5], {
      contextRef,
      opportunityId
    });
    const integrityVerificationRef = stringField(
      integrity,
      "integrityVerificationRef"
    );
    const composition = await transport.callTool(CANONICAL_TOOLS[6], {
      selectionRef: stringField(selection, "selectionRef"),
      integrityVerificationRef
    });
    const draft = await transport.callTool(CANONICAL_TOOLS[7], {
      compositionRef: stringField(composition, "compositionRef"),
      revisionKind: "initial"
    });
    const draftArtifact = asRecord(draft.artifact, "draft artifact");
    assert.equal(stringField(draftArtifact, "draftBodyHash"), world.draftBodyHash);
    const preflight = await transport.callTool(CANONICAL_TOOLS[8], {
      targetRef: opportunityId
    });
    assert.equal(preflight.status, "ready");
    assert.equal(providerSourceCalls, 1);
    const approvalProjection = await transport.callTool(CANONICAL_TOOLS[9], {
      targetRef: opportunityId,
      artifactVersionRef: stringField(draftArtifact, "versionRef"),
      draftBodyHash: stringField(draftArtifact, "draftBodyHash"),
      preflightRef: stringField(preflight, "preflightRef")
    });
    assert.equal(approvalProjection.status, "approval_required");
    transport.completeTurn();

    const awaiting = await waitFor(
      () => getWorkbenchRun(runId),
      (value) => value?.status === "awaiting_action",
      "L3 pending approval"
    );
    assert.ok(awaiting?.pendingAction);
    assert.equal(awaiting.pendingAction.actionRef, approvalProjection.actionRef);
    assert.deepEqual(awaiting.pendingAction.operationBoundary, {
      editorWriteCount: 1,
      editorReadbackCount: 1,
      editorClearCount: 1,
      publishCount: 0,
      notificationCount: 0,
      realPublishEnabled: false
    });
    const waitingPlan = await prisma.workbenchPlanRevisionRecord.findUniqueOrThrow({
      where: { id: initialPlan.id },
      include: { steps: { orderBy: { ordinal: "asc" } } }
    });
    assert.deepEqual(waitingPlan.steps.map((step) => step.status), [
      ...Array(9).fill("completed"),
      "waiting_for_approval",
      "pending"
    ]);

    const decisionRoute = await import(
      "../../app/api/workbench/runs/[id]/actions/[actionId]/decision/route"
    );
    const actionRef = awaiting.pendingAction.actionRef;
    const decisionResponse = await decisionRoute.POST(
      trustedMutationRequest(
        `/api/workbench/runs/${runId}/actions/${actionRef}/decision`,
        {
          decision: "approve",
          expectedActionHash: awaiting.pendingAction.approvalHash
        }
      ),
      { params: { id: runId, actionId: actionRef } }
    );
    assert.equal(decisionResponse.status, 202, await decisionResponse.text());
    await transport.waitForTurn(2);
    const resumePrompt = transport.turnPrompts[1]!;
    const stageVerificationRef = stageVerificationRefFromResume(resumePrompt);
    assert.equal(resumePrompt.includes(PRIVATE_PROMPT), false);
    assert.equal(resumePrompt.includes(world.draftBody), false);
    assert.deepEqual(
      transport.modelToolCalls.map((call) => call.protocolName),
      CANONICAL_TOOLS.slice(0, 10).map((name) => name.replace(/\./gu, "_"))
    );
    assert.equal(
      transport.modelToolCalls.filter(
        (call) => call.protocolName === "platform_editor_stage_verify_clear"
      ).length,
      1
    );

    const delivery = await transport.callTool(CANONICAL_TOOLS[10], {
      draftVersionRef: stringField(draftArtifact, "versionRef"),
      integrityVerificationRef,
      stageVerificationRef
    });
    assert.equal(delivery.status, "ready");
    assert.deepEqual(
      transport.modelToolCalls.map((call) => call.protocolName),
      CANONICAL_TOOLS.map((name) => name.replace(/\./gu, "_"))
    );
    assert.deepEqual(
      transport.modelToolCalls
        .filter((call) => call.turnId === transport.turnId)
        .map((call) => call.protocolName),
      ["delivery_bundle_create"]
    );
    transport.completeGoalAndRun();

    const completedRun = await waitFor(
      () => getWorkbenchRun(runId),
      (value) => value?.status === "completed" && value.goal?.status === "complete",
      "completed run and goal"
    );
    assert.ok(completedRun);
    await waitFor(
      () => prisma.workbenchRunRecord.findUnique({ where: { id: runId } }),
      (value) => value?.status === "completed",
      "durable completed run"
    );
    const [
      task,
      objective,
      finalPlan,
      toolCalls,
      receipts,
      verifications,
      artifacts,
      action,
      transaction,
      persistedRun,
      events
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
      prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
        where: { id: actionRef },
        include: { grant: true }
      }),
      prisma.workbenchStageTransactionRecord.findFirstOrThrow({
        where: { taskId, runId }
      }),
      prisma.workbenchRunRecord.findUniqueOrThrow({ where: { id: runId } }),
      prisma.workbenchEventRecord.findMany({
        where: { runId },
        orderBy: { sequence: "asc" }
      })
    ]);

    assert.equal(task.status, "completed");
    assert.equal(objective.source, "cmooc.course-agent-objective-classifier.v2");
    assert.equal(objective.safeSummary.includes("支持缺口"), true);
    const structuredGoal = asRecord(
      JSON.parse(objective.structuredGoalJson) as unknown,
      "structured goal"
    );
    assert.equal(structuredGoal.goalCode, "course_evidence_support_gap");
    assert.deepEqual(finalPlan.steps.map((step) => step.toolName), CANONICAL_TOOLS);
    assert.deepEqual(finalPlan.steps.map((step) => step.status), Array(11).fill("completed"));
    assert.deepEqual(toolCalls.map((call) => call.toolName), CANONICAL_TOOLS);
    assert.equal(toolCalls.every((call) => call.status === "succeeded"), true);
    assert.equal(receipts.length, 11);
    assert.equal(receipts.every((receipt) => receipt.status === "succeeded"), true);
    assert.equal(receipts.every((receipt) => receipt.containsForumText === false), true);
    assert.equal(verifications.length >= 5, true);
    assert.equal(verifications.every((verification) => verification.status === "passed"), true);
    assert.deepEqual(artifacts.map((artifact) => artifact.artifactKind), [
      "facilitation_intent",
      "facilitation_reply_draft",
      "facilitation_delivery_bundle"
    ]);
    assert.equal(artifacts.every((artifact) => artifact.contentRef === null), true);
    assert.equal(action.status, "succeeded");
    assert.equal(action.grant?.status, "consumed");
    assert.equal(action.realPublishEnabled, false);
    assert.equal(transaction.status, "verified");
    const verifiedOutput = asRecord(
      JSON.parse(transaction.verifiedOutputJson ?? "null") as unknown,
      "verified stage output"
    );
    assert.equal(verifiedOutput.receiptRef, stageVerificationRef);
    assert.deepEqual(
      {
        editorWriteCount: verifiedOutput.editorWriteCount,
        editorReadbackCount: verifiedOutput.editorReadbackCount,
        editorReadbackVerified: verifiedOutput.editorReadbackVerified,
        editorClearCount: verifiedOutput.editorClearCount,
        editorEmptyAfterClear: verifiedOutput.editorEmptyAfterClear,
        submitMutationCount: verifiedOutput.submitMutationCount,
        sendMutationCount: verifiedOutput.sendMutationCount,
        realPublishEnabled: verifiedOutput.realPublishEnabled,
        published: verifiedOutput.published,
        bodyPersisted: verifiedOutput.bodyPersisted
      },
      {
        editorWriteCount: 1,
        editorReadbackCount: 1,
        editorReadbackVerified: true,
        editorClearCount: 1,
        editorEmptyAfterClear: true,
        submitMutationCount: 0,
        sendMutationCount: 0,
        realPublishEnabled: false,
        published: false,
        bodyPersisted: false
      }
    );
    assert.equal(persistedRun.status, "completed");
    assert.equal(await prisma.executionAttempt.count(), executionAttemptCountBefore);
    assert.equal(await prisma.publishAttempt.count(), publishAttemptCountBefore);
    assert.equal(dom.lifecycle.sessionOpenCount, 2);
    assert.equal(dom.lifecycle.sessionCloseCount, 2);
    assert.equal(dom.lifecycle.browserCloseCount, dom.lifecycle.browserLaunchCount);
    assert.equal(dom.lifecycle.contextCloseCount, dom.lifecycle.contextOpenCount);
    assert.equal(dom.lifecycle.pageCloseCount, dom.lifecycle.pageOpenCount);
    assert.equal(dom.lifecycle.routeFulfillCount, 2);
    assert.equal(dom.lifecycle.blockedPostCount, 2);

    const publicAndDurable = JSON.stringify({
      createBody,
      completedRun,
      task,
      objective,
      finalPlan,
      toolCalls,
      receipts,
      verifications,
      artifacts,
      action,
      transaction,
      persistedRun,
      events
    });
    const sessionText = await readTextFilesRecursively(sessionRoot);
    const databaseFiles = databaseFilesForPrivacyScan();
    assert.equal(databaseFiles.length >= 1, true);
    for (const forbidden of [
      PRIVATE_PROMPT,
      world.draftBody,
      SIGNING_SECRET.toString("utf8"),
      SIGNING_SECRET.toString("hex"),
      REAL_DOM_STAGE_FIXTURE_TARGET_URL,
      REAL_DOM_STAGE_FIXTURE_ORIGIN
    ]) {
      assert.equal(publicAndDurable.includes(forbidden), false);
      assert.equal(sessionText.includes(forbidden), false);
      assert.equal(
        databaseFiles.some((bytes) =>
          bytes.includes(Buffer.from(forbidden, "utf8"))
        ),
        false
      );
    }
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
    await rm(testRoot, { recursive: true, force: true });
  }
});
