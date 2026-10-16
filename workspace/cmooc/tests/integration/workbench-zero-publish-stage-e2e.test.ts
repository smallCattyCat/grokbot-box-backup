import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { loadCourseManifest } from "../../lib/autonomy/course-manifest";
import {
  COURSE_TOOL_ENVELOPE_SCHEMA_VERSION,
  hashCourseScope,
  hashCourseToolValue,
  type CourseToolExecutionOutcome,
  type CourseToolBusinessInput,
  type EvidenceRef,
  type ServerToolExecutionContext,
  type ToolExecutionEnvelope
} from "../../lib/course-tools/contracts";
import { COURSE_TOOL_POLICY_VERSION } from "../../lib/course-tools/policy-gateway";
import { CourseToolRegistry } from "../../lib/course-tools/registry";
import {
  createPlatformStageToolRegistrations,
  createPlatformStageVerifierRegistrations
} from "../../lib/course-tools/tools/platform-stage";
import { CourseToolVerifierRegistry } from "../../lib/course-tools/verifier-registry";
import { hashTransientDraftBody } from "../../lib/live-runtime/draft-content";
import {
  PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
  hashPreExecutionTargetObservation
} from "../../lib/autonomy/execution-permit";
import { PrismaStageRunNonceRegistry } from "../../lib/live-runtime/stage-run-nonce-registry";
import type {
  CourseAgentStageMaterialBinding,
  CourseAgentStageTargetMaterial
} from "../../lib/workbench/course-agent-artifact-runtime";
import { createCourseAgentActionCoordinator } from "../../lib/workbench/course-agent-action-coordinator";
import { executeApprovedCourseAgentAction } from "../../lib/workbench/course-agent-action-execution";
import { CourseAgentProtectedMaterialVault } from "../../lib/workbench/course-agent-protected-material-vault";
import type { CourseAgentProcessSession } from "../../lib/workbench/course-agent-session";
import {
  COURSE_AGENT_TOOLKIT_SCHEMA_VERSION,
  type CourseAgentToolkit
} from "../../lib/workbench/course-agent-toolkit";
import type { WorkbenchCourseToolTransport } from "../../lib/workbench/course-tool-transport";
import { approveCourseToolAction } from "../../lib/workbench/course-tool-action-store";
import { PrismaWorkbenchStageTransactionStore } from "../../lib/workbench/prisma-workbench-stage-transaction-store";
import { InMemoryProtectedArtifactStore } from "../../lib/workbench/protected-artifact-store";
import {
  WORKBENCH_STAGE_TARGET_RESOLUTION_SCHEMA_VERSION,
  buildResolvedWorkbenchStageTargetReceiptV2,
  createTrustedWorkbenchPlatformStageAdapter,
  type ResolvedWorkbenchStageTarget,
  type WorkbenchStageTargetResolver
} from "../../lib/workbench/trusted-workbench-platform-stage-adapter";
import {
  REAL_DOM_STAGE_FIXTURE_ORIGIN,
  REAL_DOM_STAGE_FIXTURE_TARGET_URL,
  createRealDomWorkbenchStageSessionFactory
} from "../fixtures/workbench-real-dom-stage-session";

const require = createRequire(import.meta.url);
const testRoot = mkdtempSync(path.join(tmpdir(), "cmooc-real-dom-stage-e2e-"));
const databasePath = path.join(testRoot, "zero-publish-stage.db").replace(/\\/gu, "/");
const databaseUrl = `file:${databasePath}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const NOW = "2026-08-13T18:00:00.000Z";
const DEADLINE = "2026-08-13T18:10:00.000Z";
const TRANSIENT_DRAFT_SENTINEL =
  "SYNTHETIC_TRANSIENT_DRAFT_MUST_NEVER_ENTER_DATABASE_8e58f4";
const SYNTHETIC_HUMAN_DRAFT_SENTINEL =
  "SYNTHETIC_HUMAN_DRAFT_MUST_REMAIN_UNTOUCHED_28a493";
const SYNTHETIC_SIGNING_SECRET = Buffer.from(
  "synthetic-stage-signing-secret-never-persisted-2026",
  "utf8"
);

function hash(label: string): string {
  return hashCourseToolValue("test.workbench-real-dom-stage-e2e.v1", label);
}

function evidence(
  kind: EvidenceRef["kind"],
  id: string,
  valueHash: string
): EvidenceRef {
  return Object.freeze({ kind, id, hash: valueHash, observedAt: NOW });
}

function fixtureTargetResolver(scope: Scope): WorkbenchStageTargetResolver {
  return {
    resolve: async (input) => {
      const observationReceipt = Object.freeze({
        schemaVersion: PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
        courseAlias: scope.courseAlias,
        threadKey: scope.target.threadKey,
        targetVersionHash: scope.target.targetVersionHash,
        eventSetHash: scope.target.eventSetHash,
        observedAt: input.requestedAt,
        containsForumText: false as const
      });
      const freshObservation = Object.freeze({
        receipt: observationReceipt,
        receiptHash: hashPreExecutionTargetObservation(observationReceipt)
      });
      const targetLocatorHash = hash(`target-locator:${scope.suffix}`);
      const bound = buildResolvedWorkbenchStageTargetReceiptV2({
        target: input.target,
        courseAlias: input.courseAlias,
        courseScopeHash: input.courseScopeHash,
        manifestHash: input.manifestHash,
        courseLocatorHash: input.manifestHash,
        targetLocatorHash,
        freshObservation
      });
      const resolved: ResolvedWorkbenchStageTarget = Object.freeze({
        schemaVersion: WORKBENCH_STAGE_TARGET_RESOLUTION_SCHEMA_VERSION,
        targetUrl: REAL_DOM_STAGE_FIXTURE_TARGET_URL,
        allowedOrigin: REAL_DOM_STAGE_FIXTURE_ORIGIN,
        courseLocatorHash: bound.receipt.courseLocatorHash,
        targetLocatorHash: bound.receipt.targetLocatorHash,
        targetVersionHash: bound.receipt.targetVersionHash,
        eventSetHash: bound.receipt.eventSetHash,
        sourceRevalidationReceiptHash:
          bound.receipt.sourceRevalidationReceiptHash,
        sourceAfterObservationReceiptHash:
          bound.receipt.sourceAfterObservationReceiptHash,
        freshObservation,
        freshObservationRef: bound.receipt.freshObservationRef,
        freshObservationHash: bound.receipt.freshObservationHash,
        resolvedAt: bound.receipt.resolvedAt,
        resolvedTargetReceipt: bound.receipt,
        resolvedTargetReceiptRef: bound.receiptRef,
        resolvedTargetReceiptHash: bound.receiptHash,
        evidenceRefs: [
          evidence(
            "snapshot",
            `snapshot-${scope.suffix}`,
            hash(`snapshot:${scope.suffix}`)
          )
        ],
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

type Scope = Readonly<{
  suffix: string;
  taskId: string;
  runId: string;
  planRevisionId: string;
  stepId: string;
  callId: string;
  executionLeaseId: string;
  courseAlias: string;
  courseId: string;
  manifestHash: string;
  targetRef: string;
  artifactVersionRef: string;
  draftBodyHash: string;
  integrityHash: string;
  integrityVerificationRef: string;
  target: CourseAgentStageTargetMaterial;
  material: CourseAgentStageMaterialBinding;
}>;

async function createScope(
  suffix: string,
  options: Readonly<{
    actionManaged?: boolean;
    courseAlias?: string;
    courseId?: string;
    manifestHash?: string;
  }> = {}
): Promise<Scope> {
  const taskId = `task:real-dom-stage:${suffix}`;
  const runId = `run:real-dom-stage:${suffix}`;
  const planRevisionId = `plan:real-dom-stage:${suffix}`;
  const stepId = `step:real-dom-stage:${suffix}`;
  const callId = `call:real-dom-stage:${suffix}`;
  const executionLeaseId = `lease:real-dom-stage:${suffix}`;
  const courseAlias = options.courseAlias ?? `fixture-course-${suffix}`;
  const courseId = options.courseId ?? `fixture-private-course-${suffix}`;
  const manifestHash = options.manifestHash ?? hash(`manifest:${suffix}`);
  const targetVersionHash = hash(`target-version:${suffix}`);
  const eventSetHash = hash(`event-set:${suffix}`);
  const opportunityReceiptHash = hash(`opportunity:${suffix}`);
  const revalidationReceiptHash = hash(`revalidation:${suffix}`);
  const afterObservationReceiptHash = hash(`after-observation:${suffix}`);
  const targetRef = `support-gap:candidate-${suffix}`;
  const artifactVersionRef = `artifact-version:real-dom-${suffix}`;
  const draftBodyHash = hashTransientDraftBody(TRANSIENT_DRAFT_SENTINEL);
  const integrityHash = hash(`integrity:${suffix}`);
  const integrityVerificationRef = `integrity-verification:${integrityHash}`;
  const target: CourseAgentStageTargetMaterial = Object.freeze({
    targetRef,
    opportunityId: targetRef,
    candidateKey: `candidate-${suffix}`,
    decisionId: `decision-${suffix}`,
    threadKey: `thread-${suffix}`,
    targetVersionHash,
    eventSetHash,
    opportunityReceiptHash,
    revalidationReceiptHash,
    afterObservationReceiptHash,
    evidenceRefs: Object.freeze([
      evidence("manifest", courseAlias, manifestHash),
      evidence("verification", integrityVerificationRef, integrityHash),
      evidence("decision", `decision-${suffix}`, opportunityReceiptHash)
    ])
  });
  const material: CourseAgentStageMaterialBinding = Object.freeze({
    target,
    artifactVersionRef,
    draftBodyHash,
    integrityVerificationRef
  });
  const createdAt = new Date(NOW);
  await prisma.workbenchTask.create({
    data: {
      id: taskId,
      title: `真实 DOM 零发布 STAGE ${suffix}`,
      status: "running",
      createdAt
    }
  });
  await prisma.workbenchRunRecord.create({
    data: {
      id: runId,
      taskId,
      schemaVersion: "workbench-run-v1",
      source: "app-server",
      status: options.actionManaged ? "awaiting_action" : "running",
      projectLabel: "课程工作台",
      snapshotJson: "{}",
      createdAt,
      updatedAt: createdAt
    }
  });
  await prisma.workbenchPlanRevisionRecord.create({
    data: {
      id: planRevisionId,
      taskId,
      runId,
      revision: 1,
      objectiveHash: hash(`objective:${suffix}`),
      source: "server_compiler",
      compilerVersion: "real-dom-stage-e2e-v1",
      safeSummary: "在合成 Quill 页面完成一次零发布暂存验证。",
      createdAt
    }
  });
  await prisma.workbenchPlanStepRecord.create({
    data: {
      id: stepId,
      planRevisionId,
      ordinal: 1,
      status: options.actionManaged ? "waiting_for_approval" : "running",
      toolName: "platform.editor.stage_verify_clear",
      toolVersion: "1",
      dependencyIdsJson: "[]",
      inputRefsJson: "[]",
      preconditionsJson: "[]",
      postconditionsJson: "[]",
      effectClass: "external_stage",
      requiredCapability: "L3_EXTERNAL_STAGE",
      acceptanceJson: "[]",
      replanPolicyJson: "{}",
      safeSummary: "真实 DOM 写入、回读并清空，发布为零。",
      ...(options.actionManaged ? {} : { startedAt: createdAt }),
      createdAt
    }
  });
  if (!options.actionManaged) {
    const fencingTokenHash = hash(`fencing-token:${suffix}`);
    await prisma.workbenchExecutionLease.create({
      data: {
        id: executionLeaseId,
        taskId,
        runId,
        stepId,
        scopeKey: `real-dom-stage:${suffix}`,
        ownerInstanceId: "real-dom-stage-e2e",
        generation: 1,
        fencingTokenHash,
        status: "active",
        acquiredAt: createdAt,
        heartbeatAt: createdAt,
        expiresAt: new Date(DEADLINE)
      }
    });
    await prisma.workbenchToolCallRecord.create({
      data: {
        id: callId,
        taskId,
        runId,
        stepId,
        executionLeaseId,
        toolName: "platform.editor.stage_verify_clear",
        toolVersion: "1",
        capability: "L3_EXTERNAL_STAGE",
        effectClass: "external_stage",
        safeInputSummary: "执行合成页面零发布 STAGE。",
        inputHash: hash(`input:${suffix}`),
        idempotencyKey: `idempotency-real-dom-${suffix}`,
        attempt: 1,
        grantRef: `grant:real-dom-stage:${suffix}`,
        leaseGeneration: 1,
        fencingTokenHash,
        status: "running",
        createdAt
      }
    });
  }
  return Object.freeze({
    suffix,
    taskId,
    runId,
    planRevisionId,
    stepId,
    callId,
    executionLeaseId,
    courseAlias,
    courseId,
    manifestHash,
    targetRef,
    artifactVersionRef,
    draftBodyHash,
    integrityHash,
    integrityVerificationRef,
    target,
    material
  });
}

function context(
  scope: Scope,
  callId: string
): ServerToolExecutionContext {
  return Object.freeze({
    callId,
    taskId: scope.taskId,
    runId: scope.runId,
    planRevisionId: scope.planRevisionId,
    stepId: scope.stepId,
    courseScope: {
      courseId: scope.courseId,
      alias: scope.courseAlias,
      manifestHash: scope.manifestHash
    },
    intent: "implement",
    baseCapability: "L1_ARTIFACT",
    capabilityGrantRefs: [`grant:real-dom-stage:${scope.suffix}`],
    policyVersion: "cmooc.course-tool.policy.v1",
    now: NOW,
    deadlineAt: DEADLINE,
    idempotencyKey: `idempotency-${callId}`,
    attempt: 1,
    executionLeaseId: scope.executionLeaseId,
    leaseGeneration: 1,
    fencingToken: `synthetic-fence-${scope.suffix}`
  });
}

function envelope<I extends CourseToolBusinessInput>(
  ctx: ServerToolExecutionContext,
  toolName: string,
  businessInput: I
): ToolExecutionEnvelope<I> {
  return Object.freeze({
    schemaVersion: COURSE_TOOL_ENVELOPE_SCHEMA_VERSION,
    callId: ctx.callId,
    taskId: ctx.taskId,
    runId: ctx.runId,
    planRevisionId: ctx.planRevisionId,
    stepId: ctx.stepId,
    courseScope: ctx.courseScope,
    courseScopeHash: hashCourseScope(ctx.courseScope),
    toolName,
    toolVersion: "1",
    input: businessInput,
    inputHash: hashCourseToolValue(
      `test.real-dom-stage.input:${toolName}@1`,
      businessInput
    ),
    idempotencyKey: ctx.idempotencyKey,
    grantedCapability: "L3_EXTERNAL_STAGE",
    grantRef: `grant:real-dom-stage:${ctx.runId}`,
    policyVersion: ctx.policyVersion,
    attempt: 1,
    executionLeaseId: ctx.executionLeaseId,
    leaseGeneration: ctx.leaseGeneration,
    fencingToken: ctx.fencingToken,
    startedAt: ctx.now,
    deadlineAt: ctx.deadlineAt
  });
}

async function protectedVault(scope: Scope): Promise<CourseAgentProtectedMaterialVault> {
  const store = new InMemoryProtectedArtifactStore({
    idFactory: () => `real-dom-stage-body-${scope.suffix}`
  });
  const handle = await store.put({
    taskId: scope.taskId,
    runId: scope.runId,
    callId: `draft-call:${scope.suffix}`,
    idempotencyKey: `draft-idempotency:${scope.suffix}`,
    body: TRANSIENT_DRAFT_SENTINEL,
    draftBodyHash: scope.draftBodyHash,
    storedAt: NOW,
    expiresAt: "2026-08-13T18:20:00.000Z"
  });
  const vault = new CourseAgentProtectedMaterialVault({
    taskId: scope.taskId,
    runId: scope.runId,
    protectedStore: store
  });
  vault.bind({
    taskId: scope.taskId,
    runId: scope.runId,
    artifactVersionRef: scope.artifactVersionRef,
    protectedRef: handle.ref,
    draftBodyHash: scope.draftBodyHash,
    expiresAt: handle.expiresAt
  });
  return vault;
}

async function createAdapter(
  scope: Scope,
  scenario: Parameters<typeof createRealDomWorkbenchStageSessionFactory>[0]
) {
  const dom = createRealDomWorkbenchStageSessionFactory(scenario);
  const transactionStore = new PrismaWorkbenchStageTransactionStore(prisma);
  const adapter = createTrustedWorkbenchPlatformStageAdapter({
    materialLedger: {
      resolveStageMaterial: ({ targetRef, artifactVersionRef }) =>
        targetRef === scope.targetRef &&
        (artifactVersionRef === undefined ||
          artifactVersionRef === scope.artifactVersionRef)
          ? artifactVersionRef === undefined
            ? {
                ...scope.material,
                artifactVersionRef: null,
                draftBodyHash: null
              }
            : scope.material
          : null
    },
    protectedMaterialVault: await protectedVault(scope),
    targetResolver: fixtureTargetResolver(scope),
    browserSessionFactory: dom.factory,
    nonceRegistry: new PrismaStageRunNonceRegistry(prisma),
    transactionStore,
    signingSecret: SYNTHETIC_SIGNING_SECRET,
    now: () => new Date(NOW)
  });
  return { adapter, transactionStore, lifecycle: dom.lifecycle };
}

function createActionToolkit(input: {
  scope: Scope;
  adapter: Awaited<ReturnType<typeof createAdapter>>["adapter"];
  observedOutcomes: CourseToolExecutionOutcome[];
}): CourseAgentToolkit {
  const [preflightRegistration, stageRegistration, reconcileRegistration] =
    createPlatformStageToolRegistrations({
    trustedDriver: input.adapter
  });
  const registry = new CourseToolRegistry()
    .register(preflightRegistration)
    .register(stageRegistration)
    .register(reconcileRegistration);
  registry.seal();
  const verifierRegistry = new CourseToolVerifierRegistry();
  for (const verifier of createPlatformStageVerifierRegistrations()) {
    verifierRegistry.register(verifier);
  }
  verifierRegistry.seal();
  const protectedStore = new InMemoryProtectedArtifactStore();
  return Object.freeze({
    schemaVersion: COURSE_AGENT_TOOLKIT_SCHEMA_VERSION,
    registry,
    verifierRegistry,
    onToolOutcome: ({ outcome }) => {
      input.observedOutcomes.push(outcome);
    },
    protectedStore,
    protectedMaterialVault: new CourseAgentProtectedMaterialVault({
      taskId: input.scope.taskId,
      runId: input.scope.runId,
      protectedStore
    })
  });
}

const unusedTransport: WorkbenchCourseToolTransport = Object.freeze({
  listTools: () => Object.freeze([]),
  invoke: async () => {
    throw new Error("REAL_DOM_STAGE_E2E_UNUSED_TRANSPORT");
  }
});

async function preflight(scope: Scope, adapter: Awaited<ReturnType<typeof createAdapter>>["adapter"]) {
  const ctx = context(scope, `preflight-call:${scope.suffix}`);
  const businessInput = { targetRef: scope.targetRef };
  return adapter.preflightRead({
    targetRef: scope.targetRef,
    context: ctx,
    envelope: envelope(ctx, "platform.target.preflight_read", businessInput)
  });
}

function assertAllBrowserResourcesClosed(input: {
  browserLaunchCount: number;
  browserCloseCount: number;
  contextOpenCount: number;
  contextCloseCount: number;
  pageOpenCount: number;
  pageCloseCount: number;
}): void {
  assert.equal(input.browserCloseCount, input.browserLaunchCount);
  assert.equal(input.contextCloseCount, input.contextOpenCount);
  assert.equal(input.pageCloseCount, input.pageOpenCount);
}

function assertDatabaseBytesExclude(values: readonly string[]): void {
  const bytes = readFileSync(databasePath);
  for (const value of values) {
    assert.equal(
      bytes.includes(Buffer.from(value, "utf8")),
      false,
      `forbidden sentinel leaked into SQLite: ${value.slice(0, 24)}`
    );
  }
}

before(async () => {
  const migrated = spawnSync(
    process.execPath,
    [require.resolve("prisma/build/index.js"), "migrate", "deploy"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        CMOOC_DISABLE_WINDOWS_ENV_FALLBACK: "1"
      },
      encoding: "utf8"
    }
  );
  assert.equal(
    migrated.status,
    0,
    `${migrated.stdout ?? ""}\n${migrated.stderr ?? ""}`
  );
  await prisma.$connect();
});

after(async () => {
  await prisma.$disconnect();
  rmSync(testRoot, { recursive: true, force: true });
});

test("real Chromium performs one persisted zero-publish STAGE round trip and an exact retry does not write twice", async () => {
  const scope = await createScope("success");
  const { adapter, transactionStore, lifecycle } = await createAdapter(scope, {
    scenario: { requestExpectedReadPost: true }
  });
  const ready = await preflight(scope, adapter);
  assert.equal(ready.status, "ready");
  const ctx = context(scope, scope.callId);
  const businessInput = {
    targetRef: scope.targetRef,
    artifactVersionRef: scope.artifactVersionRef,
    draftBodyHash: scope.draftBodyHash,
    preflightRef: ready.preflightRef
  };
  const staged = await adapter.stageVerifyClear({
    ...businessInput,
    context: ctx,
    envelope: envelope(
      ctx,
      "platform.editor.stage_verify_clear",
      businessInput
    )
  });
  assert.equal(staged.status, "verified_cleared");
  if (staged.status !== "verified_cleared") return;
  assert.deepEqual(
    {
      editorWriteCount: staged.editorWriteCount,
      editorReadbackCount: staged.editorReadbackCount,
      editorReadbackVerified: staged.editorReadbackVerified,
      editorClearCount: staged.editorClearCount,
      editorEmptyAfterClear: staged.editorEmptyAfterClear,
      submitMutationCount: staged.submitMutationCount,
      sendMutationCount: staged.sendMutationCount,
      realPublishEnabled: staged.realPublishEnabled,
      published: staged.published,
      bodyPersisted: staged.bodyPersisted
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

  const persisted = await transactionStore.get(staged.stageTransactionRef);
  assert.equal(persisted?.status, "verified");
  assert.equal(persisted?.taskId, scope.taskId);
  assert.equal(persisted?.runId, scope.runId);
  assert.equal(persisted?.planRevisionId, scope.planRevisionId);
  assert.equal(persisted?.stepId, scope.stepId);
  assert.equal(persisted?.callId, scope.callId);
  assert.equal(persisted?.verifiedOutput?.receiptHash, staged.receiptHash);
  assert.equal(await prisma.stageRunNonceClaim.count(), 1);
  assert.equal(await prisma.workbenchStageTransactionRecord.count(), 1);

  const registration = createPlatformStageToolRegistrations({
    trustedDriver: adapter
  })[1];
  const safeStageOutput = registration.definition.outputSchema.parse(staged);
  const safeProjection = registration.projectOutput(safeStageOutput, ctx);
  const safeSerialized = JSON.stringify({
    staged,
    safeProjection,
    persisted,
    lifecycle
  });
  for (const forbidden of [
    TRANSIENT_DRAFT_SENTINEL,
    SYNTHETIC_SIGNING_SECRET.toString("utf8"),
    REAL_DOM_STAGE_FIXTURE_TARGET_URL,
    REAL_DOM_STAGE_FIXTURE_ORIGIN,
    databasePath
  ]) {
    assert.equal(safeSerialized.includes(forbidden), false);
  }

  const repeated = await adapter.stageVerifyClear({
    ...businessInput,
    context: ctx,
    envelope: envelope(
      ctx,
      "platform.editor.stage_verify_clear",
      businessInput
    )
  });
  assert.equal(repeated.status, "failed_before_write");
  if (repeated.status === "failed_before_write") {
    assert.equal(repeated.reasonCode, "preflight_stale");
  }
  assert.equal(await prisma.stageRunNonceClaim.count(), 1);
  assert.equal(await prisma.workbenchStageTransactionRecord.count(), 1);
  assert.equal(lifecycle.sessionOpenCount, 2);
  assert.equal(lifecycle.sessionCloseCount, 2);
  assert.equal(lifecycle.routeFulfillCount, 2);
  assert.equal(lifecycle.blockedPostCount, 2);
  assert.equal(lifecycle.bridgeBlockedRequestCount, 2);
  assert.equal(lifecycle.bridgeAuditCount, 2);
  assertAllBrowserResourcesClosed(lifecycle);
  assertDatabaseBytesExclude([
    TRANSIENT_DRAFT_SENTINEL,
    SYNTHETIC_SIGNING_SECRET.toString("utf8"),
    SYNTHETIC_SIGNING_SECRET.toString("hex"),
    REAL_DOM_STAGE_FIXTURE_TARGET_URL,
    REAL_DOM_STAGE_FIXTURE_ORIGIN,
    databasePath
  ]);
});

test("approved CourseAgent action consumes one scoped grant and completes the same persisted plan through the real DOM", async () => {
  const manifest = await loadCourseManifest("bnu-test");
  const scope = await createScope("approved-action", {
    actionManaged: true,
    courseAlias: manifest.alias,
    courseId: manifest.courseId,
    manifestHash: manifest.manifestHash
  });
  const dom = createRealDomWorkbenchStageSessionFactory({
    scenario: { requestExpectedReadPost: true }
  });
  const transactionStore = new PrismaWorkbenchStageTransactionStore(prisma);
  const adapter = createTrustedWorkbenchPlatformStageAdapter({
    materialLedger: {
      resolveStageMaterial: ({ targetRef, artifactVersionRef }) =>
        targetRef === scope.targetRef &&
        (artifactVersionRef === undefined ||
          artifactVersionRef === scope.artifactVersionRef)
          ? artifactVersionRef === undefined
            ? {
                ...scope.material,
                artifactVersionRef: null,
                draftBodyHash: null
              }
            : scope.material
          : null
    },
    protectedMaterialVault: await protectedVault(scope),
    targetResolver: fixtureTargetResolver(scope),
    browserSessionFactory: dom.factory,
    nonceRegistry: new PrismaStageRunNonceRegistry(prisma),
    transactionStore,
    signingSecret: SYNTHETIC_SIGNING_SECRET,
    now: () => new Date(NOW)
  });

  const ready = await preflight(scope, adapter);
  assert.equal(ready.status, "ready");
  const observedOutcomes: CourseToolExecutionOutcome[] = [];
  const toolkit = createActionToolkit({ scope, adapter, observedOutcomes });
  const request = Object.freeze({
    toolName: "platform.editor.stage_verify_clear",
    toolVersion: "1",
    input: Object.freeze({
      targetRef: scope.targetRef,
      artifactVersionRef: scope.artifactVersionRef,
      draftBodyHash: scope.draftBodyHash,
      preflightRef: ready.preflightRef
    })
  });
  const preparationContext: ServerToolExecutionContext = Object.freeze({
    callId: scope.callId,
    taskId: scope.taskId,
    runId: scope.runId,
    planRevisionId: scope.planRevisionId,
    stepId: scope.stepId,
    courseScope: Object.freeze({
      courseId: manifest.courseId,
      alias: manifest.alias,
      manifestHash: manifest.manifestHash
    }),
    intent: "implement",
    baseCapability: "L1_ARTIFACT",
    capabilityGrantRefs: Object.freeze([]),
    policyVersion: COURSE_TOOL_POLICY_VERSION,
    now: NOW,
    deadlineAt: DEADLINE,
    idempotencyKey: `request-${scope.callId}`,
    attempt: 1,
    executionLeaseId: `approval-preparation-${scope.suffix}`,
    leaseGeneration: 1,
    fencingToken: hash(`preparation-fence:${scope.suffix}`)
  });
  const pending = await createCourseAgentActionCoordinator({
    db: prisma,
    registry: toolkit.registry
  }).prepare({ request, context: preparationContext });
  assert.deepEqual(pending.operationBoundary, {
    editorWriteCount: 1,
    editorReadbackCount: 1,
    editorClearCount: 1,
    publishCount: 0,
    notificationCount: 0,
    realPublishEnabled: false
  });
  const approved = await approveCourseToolAction(prisma, {
    actionRef: pending.actionRef,
    bindingHash: pending.bindingHash,
    approvalHash: pending.approvalHash,
    approvedAt: new Date(NOW)
  });
  const session: CourseAgentProcessSession = Object.freeze({
    taskId: scope.taskId,
    runId: scope.runId,
    courseAlias: manifest.alias,
    toolkit,
    transport: unusedTransport,
    registeredAt: NOW,
    expiresAt: "2026-08-13T18:20:00.000Z"
  });
  const result = await executeApprovedCourseAgentAction({
    db: prisma,
    action: approved.action,
    session,
    now: new Date(NOW)
  });
  assert.equal(result.status, "succeeded");
  assert.equal(observedOutcomes.length, 1);
  const observedOutcome = observedOutcomes[0];
  assert.ok(observedOutcome);
  assert.equal(observedOutcome.result.status, "succeeded");
  const modelProjection = observedOutcome.result.safeModelProjection;
  assert.equal(
    typeof modelProjection,
    "object"
  );
  assert.equal(Array.isArray(modelProjection), false);
  assert.notEqual(modelProjection, null);
  if (
    !modelProjection ||
    typeof modelProjection !== "object" ||
    Array.isArray(modelProjection) ||
    !("publicationStatus" in modelProjection)
  ) {
    throw new Error("REAL_DOM_STAGE_MODEL_PROJECTION_INVALID");
  }
  assert.equal(
    modelProjection.publicationStatus,
    "not_published"
  );
  const [actionRow, grantRow, stepRow, receiptRow, verificationRow] =
    await Promise.all([
      prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
        where: { id: approved.action.id }
      }),
      prisma.workbenchCourseToolGrantRecord.findUniqueOrThrow({
        where: { id: approved.grant.id }
      }),
      prisma.workbenchPlanStepRecord.findUniqueOrThrow({
        where: { id: scope.stepId }
      }),
      prisma.workbenchToolReceiptRecord.findUniqueOrThrow({
        where: { callId: scope.callId }
      }),
      prisma.workbenchVerificationRecord.findFirstOrThrow({
        where: { runId: scope.runId }
      })
    ]);
  assert.equal(actionRow.status, "succeeded");
  assert.equal(grantRow.status, "consumed");
  assert.equal(stepRow.status, "completed");
  assert.equal(receiptRow.status, "succeeded");
  assert.equal(verificationRow.status, "passed");
  const transaction = await prisma.workbenchStageTransactionRecord.findFirstOrThrow({
    where: { taskId: scope.taskId, runId: scope.runId }
  });
  assert.equal(
    await prisma.stageRunNonceClaim.count({
      where: { runNonceHash: transaction.runNonceHash }
    }),
    1
  );
  assert.equal(transaction.status, "verified");
  assert.equal(transaction.planRevisionId, scope.planRevisionId);
  assert.equal(transaction.stepId, scope.stepId);
  assert.equal(transaction.callId, scope.callId);
  assert.equal(dom.lifecycle.sessionOpenCount, 2);
  assert.equal(dom.lifecycle.sessionCloseCount, 2);
  assert.equal(dom.lifecycle.blockedPostCount, 2);
  assertAllBrowserResourcesClosed(dom.lifecycle);
  const safeRows = JSON.stringify({
    pending,
    result,
    actionRow,
    grantRow,
    stepRow,
    receiptRow,
    verificationRow,
    transaction
  });
  for (const forbidden of [
    TRANSIENT_DRAFT_SENTINEL,
    SYNTHETIC_SIGNING_SECRET.toString("utf8"),
    REAL_DOM_STAGE_FIXTURE_TARGET_URL,
    REAL_DOM_STAGE_FIXTURE_ORIGIN,
    databasePath
  ]) {
    assert.equal(safeRows.includes(forbidden), false);
  }
  assertDatabaseBytesExclude([
    TRANSIENT_DRAFT_SENTINEL,
    SYNTHETIC_SIGNING_SECRET.toString("utf8"),
    SYNTHETIC_SIGNING_SECRET.toString("hex"),
    REAL_DOM_STAGE_FIXTURE_TARGET_URL,
    REAL_DOM_STAGE_FIXTURE_ORIGIN,
    databasePath
  ]);
});

test("real DOM preflight preserves an existing human draft and creates no stage transaction", async () => {
  const scope = await createScope("human-draft");
  const transactionCountBefore =
    await prisma.workbenchStageTransactionRecord.count();
  const nonceCountBefore = await prisma.stageRunNonceClaim.count();
  const { adapter, lifecycle } = await createAdapter(scope, {
    scenario: { existingDraft: SYNTHETIC_HUMAN_DRAFT_SENTINEL }
  });
  const result = await preflight(scope, adapter);
  assert.equal(result.status, "blocked");
  assert.equal(result.reasonCode, "editor_not_empty");
  assert.equal(result.baselineStatus, "non_empty");
  assert.equal(
    JSON.stringify(result).includes(SYNTHETIC_HUMAN_DRAFT_SENTINEL),
    false
  );
  assert.equal(
    await prisma.workbenchStageTransactionRecord.count(),
    transactionCountBefore
  );
  assert.equal(await prisma.stageRunNonceClaim.count(), nonceCountBefore);
  assert.equal(lifecycle.sessionOpenCount, 1);
  assert.equal(lifecycle.sessionCloseCount, 1);
  assert.equal(lifecycle.routeFulfillCount, 1);
  assertAllBrowserResourcesClosed(lifecycle);
  assertDatabaseBytesExclude([
    SYNTHETIC_HUMAN_DRAFT_SENTINEL,
    TRANSIENT_DRAFT_SENTINEL,
    REAL_DOM_STAGE_FIXTURE_TARGET_URL,
    REAL_DOM_STAGE_FIXTURE_ORIGIN
  ]);
});

test("real browser transport guard blocks WebSocket and download startup and closes every resource", async (t) => {
  await t.test("WebSocket", async () => {
    const scope = await createScope("websocket-guard");
    const { adapter, lifecycle } = await createAdapter(scope, {
      scenario: { openWebSocket: true }
    });
    const result = await preflight(scope, adapter);
    assert.equal(result.status, "waiting_for_browser");
    assert.equal(result.reasonCode, "browser_unavailable");
    assert.equal(lifecycle.webSocketInterceptCount, 1);
    assert.equal(lifecycle.webSocketCloseCount, 1);
    assert.equal(lifecycle.sessionCloseCount, 0);
    assertAllBrowserResourcesClosed(lifecycle);
  });

  await t.test("download", async () => {
    const scope = await createScope("download-guard");
    const { adapter, lifecycle } = await createAdapter(scope, {
      scenario: { startDownload: true }
    });
    const result = await preflight(scope, adapter);
    assert.equal(result.status, "waiting_for_browser");
    assert.equal(result.reasonCode, "browser_unavailable");
    assert.equal(lifecycle.downloadObservedCount, 1);
    assert.equal(lifecycle.downloadCancelCount, 1);
    assert.equal(lifecycle.sessionCloseCount, 0);
    assertAllBrowserResourcesClosed(lifecycle);
  });
});
