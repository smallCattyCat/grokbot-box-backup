import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { loadCourseManifest } from "../../lib/autonomy/course-manifest";
import {
  type CourseToolExecutionOutcome,
  type EvidenceRef,
  type ModelToolRequest,
  type ServerToolExecutionContext
} from "../../lib/course-tools/contracts";
import {
  COURSE_TOOL_POLICY_VERSION
} from "../../lib/course-tools/policy-gateway";
import { CourseToolRegistry } from "../../lib/course-tools/registry";
import {
  PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION,
  PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
  createPlatformStageToolRegistrations,
  createPlatformStageVerifierRegistrations,
  type TrustedPlatformStageAdapter
} from "../../lib/course-tools/tools/platform-stage";
import { CourseToolVerifierRegistry } from "../../lib/course-tools/verifier-registry";
import {
  createCourseAgentActionCoordinator
} from "../../lib/workbench/course-agent-action-coordinator";
import {
  autoAuthorizeAndExecuteCourseAgentAction,
  executeApprovedCourseAgentAction
} from "../../lib/workbench/course-agent-action-execution";
import type { CourseAgentProcessSession } from "../../lib/workbench/course-agent-session";
import {
  COURSE_AGENT_TOOLKIT_SCHEMA_VERSION,
  type CourseAgentToolkit
} from "../../lib/workbench/course-agent-toolkit";
import type { WorkbenchCourseToolTransport } from "../../lib/workbench/course-tool-transport";
import {
  approveCourseToolAction
} from "../../lib/workbench/course-tool-action-store";
import { InMemoryProtectedArtifactStore } from "../../lib/workbench/protected-artifact-store";
import { CourseAgentProtectedMaterialVault } from "../../lib/workbench/course-agent-protected-material-vault";

const require = createRequire(import.meta.url);
const testRoot = mkdtempSync(path.join(tmpdir(), "cmooc-approved-stage-"));
const databasePath = path.join(testRoot, "approved-stage.db").replace(/\\/g, "/");
const databaseUrl = `file:${databasePath}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

const COURSE_ALIAS = "bnu-test";
const T0 = new Date("2026-08-13T12:00:00.000Z");
const ARTIFACT_VERSION_REF = "artifact-version-safe-v1";
const DRAFT_BODY_HASH = sha("protected transient draft");
const PREFLIGHT_REF = "preflight-safe-v1";
const TARGET_REF = "target-safe-v1";

let manifest: Awaited<ReturnType<typeof loadCourseManifest>>;

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

type Scope = Readonly<{
  suffix: string;
  taskId: string;
  runId: string;
  planRevisionId: string;
  stepId: string;
  callId: string;
}>;

async function createScope(suffix: string): Promise<Scope> {
  const scope = Object.freeze({
    suffix,
    taskId: `task-stage-${suffix}`,
    runId: `run-stage-${suffix}`,
    planRevisionId: `plan-stage-${suffix}`,
    stepId: `step-stage-${suffix}`,
    callId: `call-stage-${suffix}`
  });
  await prisma.workbenchTask.create({
    data: {
      id: scope.taskId,
      title: `安全 STAGE 执行测试 ${suffix}`,
      status: "running",
      createdAt: at(-60_000)
    }
  });
  await prisma.workbenchRunRecord.create({
    data: {
      id: scope.runId,
      taskId: scope.taskId,
      schemaVersion: "workbench-run-v1",
      source: "test",
      status: "awaiting_action",
      projectLabel: "课程工作台",
      snapshotJson: "{}",
      createdAt: at(-60_000),
      updatedAt: at(-60_000)
    }
  });
  await prisma.workbenchPlanRevisionRecord.create({
    data: {
      id: scope.planRevisionId,
      taskId: scope.taskId,
      runId: scope.runId,
      revision: 1,
      objectiveHash: sha(`objective:${suffix}`),
      source: "server_compiler",
      compilerVersion: "course-agent-v2",
      safeSummary: "执行一次精确绑定、零发布的 STAGE。",
      createdAt: at(-50_000)
    }
  });
  await prisma.workbenchPlanStepRecord.create({
    data: {
      id: scope.stepId,
      planRevisionId: scope.planRevisionId,
      ordinal: 1,
      status: "waiting_for_approval",
      toolName: "platform.editor.stage_verify_clear",
      toolVersion: "1",
      dependencyIdsJson: "[]",
      inputRefsJson: "[]",
      preconditionsJson: "[]",
      postconditionsJson: "[]",
      effectClass: "external_stage",
      requiredCapability: "L3_EXTERNAL_STAGE",
      acceptanceJson: "{}",
      replanPolicyJson: "{}",
      safeSummary: "暂存、回读并清除受保护草稿。",
      createdAt: at(-50_000)
    }
  });
  return scope;
}

function evidence(
  kind: EvidenceRef["kind"],
  id: string,
  observedAt: string
): EvidenceRef {
  return Object.freeze({
    kind,
    id,
    hash: sha(`${kind}:${id}`),
    observedAt
  });
}

function createTrustedAdapter(
  mode: "succeeded" | "unknown",
  reconcileMode: "succeeded" | "blocked" | "unknown" = "succeeded"
) {
  const calls = {
    stage: 0,
    preflight: 0,
    reconcile: 0,
    editorWrite: 0,
    editorReadback: 0,
    editorClear: 0,
    publish: 0,
    notification: 0
  };
  const adapter: TrustedPlatformStageAdapter = {
    preflightRead: async () => {
      calls.preflight += 1;
      throw new Error("TEST_UNEXPECTED_PREFLIGHT");
    },
    stageVerifyClear: async ({
      targetRef,
      artifactVersionRef,
      draftBodyHash,
      preflightRef,
      context,
      envelope
    }) => {
      calls.stage += 1;
      assert.equal(targetRef, TARGET_REF);
      assert.equal(artifactVersionRef, ARTIFACT_VERSION_REF);
      assert.equal(draftBodyHash, DRAFT_BODY_HASH);
      assert.equal(preflightRef, PREFLIGHT_REF);
      assert.equal(envelope.grantedCapability, "L3_EXTERNAL_STAGE");
      assert.equal(envelope.grantRef, context.capabilityGrantRefs[0]);

      calls.editorWrite += 1;
      if (mode === "unknown") {
        return Object.freeze({
          status: "unknown" as const,
          reasonCode: "network_ambiguous" as const,
          stageTransactionRef: `stage-transaction-${context.callId}`,
          evidenceRefs: Object.freeze([
            evidence("artifact", ARTIFACT_VERSION_REF, context.now)
          ]),
          observedAt: context.now
        });
      }

      calls.editorReadback += 1;
      calls.editorClear += 1;
      const stageTransactionRef = `stage-transaction-${context.callId}`;
      const receiptRef = `stage-receipt-${context.callId}`;
      const receiptHash = sha(`stage_receipt:${receiptRef}`);
      return Object.freeze({
        schemaVersion: PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION,
        status: "verified_cleared" as const,
        stageTransactionRef,
        receiptRef,
        receiptHash,
        targetRef,
        targetVersionHash: sha(`target-version:${context.callId}`),
        artifactVersionRef,
        draftBodyHash,
        pageBindingRef: `page-binding-${context.callId}`,
        pageBindingHash: sha(`page-binding:${context.callId}`),
        baselineRef: `editor-baseline-${context.callId}`,
        baselineHash: sha(""),
        editorWriteCount: 1 as const,
        editorReadbackCount: 1 as const,
        editorReadbackVerified: true as const,
        editorClearCount: 1 as const,
        editorEmptyAfterClear: true as const,
        submitMutationCount: 0 as const,
        sendMutationCount: 0 as const,
        closeAuditStatus: "passed" as const,
        realPublishEnabled: false as const,
        bodyPersisted: false as const,
        published: false as const,
        observedAt: context.now,
        evidenceRefs: Object.freeze([
          evidence("artifact", artifactVersionRef, context.now),
          evidence("stage_receipt", receiptRef, context.now)
        ]),
        containsForumText: false as const,
        containsIdentity: false as const,
        containsSecrets: false as const
      });
    },
    reconcileStage: async ({ stageTransactionRef, context }) => {
      calls.reconcile += 1;
      calls.editorReadback += 1;
      if (reconcileMode === "unknown") {
        return Object.freeze({
          status: "unknown" as const,
          reasonCode: "network_ambiguous" as const,
          stageTransactionRef,
          evidenceRefs: Object.freeze([
            evidence("artifact", ARTIFACT_VERSION_REF, context.now)
          ]),
          observedAt: context.now
        });
      }
      if (reconcileMode === "blocked") {
        return Object.freeze({
          status: "blocked" as const,
          reasonCode: "blocked_unowned_content" as const,
          stageTransactionRef,
          evidenceRefs: Object.freeze([
            evidence("artifact", ARTIFACT_VERSION_REF, context.now)
          ]),
          observedAt: context.now
        });
      }
      calls.editorClear += 1;
      const receiptRef = `reconcile-receipt-${context.callId}`;
      const receiptHash = sha(`stage_receipt:${receiptRef}`);
      return Object.freeze({
        schemaVersion: PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
        status: "reconciled_cleared" as const,
        resolution: "owned_draft_cleared" as const,
        stageTransactionRef,
        receiptRef,
        receiptHash,
        targetRef: TARGET_REF,
        targetVersionHash: sha(`target-version:${stageTransactionRef}`),
        artifactVersionRef: ARTIFACT_VERSION_REF,
        draftBodyHash: DRAFT_BODY_HASH,
        pageBindingRef: `page-binding-${stageTransactionRef}`,
        pageBindingHash: sha(`page-binding:${stageTransactionRef}`),
        baselineRef: `editor-baseline-${stageTransactionRef}`,
        baselineHash: sha(""),
        editorWriteCount: 1 as const,
        editorReadbackCount: 1 as const,
        editorReadbackVerified: true as const,
        editorClearCount: 1 as const,
        editorEmptyAfterClear: true as const,
        submitMutationCount: 0 as const,
        sendMutationCount: 0 as const,
        closeAuditStatus: "passed" as const,
        realPublishEnabled: false as const,
        bodyPersisted: false as const,
        published: false as const,
        observedAt: context.now,
        evidenceRefs: Object.freeze([
          evidence("artifact", ARTIFACT_VERSION_REF, context.now),
          evidence("stage_receipt", receiptRef, context.now)
        ]),
        containsForumText: false as const,
        containsIdentity: false as const,
        containsSecrets: false as const
      });
    }
  };
  return { adapter: Object.freeze(adapter), calls };
}

function createToolkit(
  adapter: TrustedPlatformStageAdapter,
  observedOutcomes: CourseToolExecutionOutcome[],
  scope: Pick<Scope, "taskId" | "runId">
): CourseAgentToolkit {
  const [preflight, stage, reconcile] =
    createPlatformStageToolRegistrations({ trustedDriver: adapter });
  const registry = new CourseToolRegistry()
    .register(preflight)
    .register(stage)
    .register(reconcile)
    .seal();
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
      observedOutcomes.push(outcome);
    },
    protectedStore,
    protectedMaterialVault: new CourseAgentProtectedMaterialVault({
      taskId: scope.taskId,
      runId: scope.runId,
      protectedStore
    })
  });
}

const unusedTransport: WorkbenchCourseToolTransport = Object.freeze({
  listTools: () => Object.freeze([]),
  invoke: async () => {
    throw new Error("TEST_UNUSED_TRANSPORT");
  }
});

async function approvedFixture(input: {
  suffix: string;
  adapter: TrustedPlatformStageAdapter;
  observedOutcomes?: CourseToolExecutionOutcome[];
}) {
  const scope = await createScope(input.suffix);
  const observedOutcomes = input.observedOutcomes ?? [];
  const toolkit = createToolkit(input.adapter, observedOutcomes, scope);
  const request: ModelToolRequest = Object.freeze({
    toolName: "platform.editor.stage_verify_clear",
    toolVersion: "1",
    input: Object.freeze({
      targetRef: TARGET_REF,
      artifactVersionRef: ARTIFACT_VERSION_REF,
      draftBodyHash: DRAFT_BODY_HASH,
      preflightRef: PREFLIGHT_REF
    })
  });
  const context: ServerToolExecutionContext = Object.freeze({
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
    now: T0.toISOString(),
    deadlineAt: at(60_000).toISOString(),
    idempotencyKey: `request-${scope.callId}`,
    attempt: 1,
    executionLeaseId: `approval-preparation-${input.suffix}`,
    leaseGeneration: 1,
    fencingToken: "f".repeat(64)
  });
  const pending = await createCourseAgentActionCoordinator({
    db: prisma,
    registry: toolkit.registry
  }).prepare({ request, context });
  const approved = await approveCourseToolAction(prisma, {
    actionRef: pending.actionRef,
    bindingHash: pending.bindingHash,
    approvalHash: pending.approvalHash,
    approvedAt: at(1_000)
  });
  const session: CourseAgentProcessSession = Object.freeze({
    taskId: scope.taskId,
    runId: scope.runId,
    courseAlias: manifest.alias,
    toolkit,
    transport: unusedTransport,
    registeredAt: T0.toISOString(),
    expiresAt: at(10 * 60_000).toISOString()
  });
  return {
    scope,
    pending,
    action: approved.action,
    grant: approved.grant,
    session,
    observedOutcomes
  };
}

async function awaitingFixture(input: {
  suffix: string;
  adapter: TrustedPlatformStageAdapter;
  observedOutcomes?: CourseToolExecutionOutcome[];
}) {
  const scope = await createScope(input.suffix);
  const observedOutcomes = input.observedOutcomes ?? [];
  const toolkit = createToolkit(input.adapter, observedOutcomes, scope);
  const request: ModelToolRequest = Object.freeze({
    toolName: "platform.editor.stage_verify_clear",
    toolVersion: "1",
    input: Object.freeze({
      targetRef: TARGET_REF,
      artifactVersionRef: ARTIFACT_VERSION_REF,
      draftBodyHash: DRAFT_BODY_HASH,
      preflightRef: PREFLIGHT_REF
    })
  });
  const context: ServerToolExecutionContext = Object.freeze({
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
    now: T0.toISOString(),
    deadlineAt: at(60_000).toISOString(),
    idempotencyKey: `request-${scope.callId}`,
    attempt: 1,
    executionLeaseId: `approval-preparation-${input.suffix}`,
    leaseGeneration: 1,
    fencingToken: "f".repeat(64)
  });
  const pending = await createCourseAgentActionCoordinator({
    db: prisma,
    registry: toolkit.registry
  }).prepare({ request, context });
  const session: CourseAgentProcessSession = Object.freeze({
    taskId: scope.taskId,
    runId: scope.runId,
    courseAlias: manifest.alias,
    toolkit,
    transport: unusedTransport,
    registeredAt: T0.toISOString(),
    expiresAt: at(10 * 60_000).toISOString()
  });
  return { scope, pending, session, observedOutcomes };
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
  manifest = await loadCourseManifest(COURSE_ALIAS);
  assert.equal(manifest.alias, COURSE_ALIAS);
  assert.match(manifest.manifestHash, /^[a-f0-9]{64}$/);
});

after(async () => {
  await prisma.$disconnect();
  rmSync(testRoot, { recursive: true, force: true });
});

test("approved STAGE consumes one grant, verifies 1/1/1, persists success, and keeps publish/notification at zero", async () => {
  const driver = createTrustedAdapter("succeeded");
  const observedOutcomes: CourseToolExecutionOutcome[] = [];
  const fixture = await approvedFixture({
    suffix: "success",
    adapter: driver.adapter,
    observedOutcomes
  });

  assert.deepEqual(fixture.pending.operationBoundary, {
    editorWriteCount: 1,
    editorReadbackCount: 1,
    editorClearCount: 1,
    publishCount: 0,
    notificationCount: 0,
    realPublishEnabled: false
  });
  const result = await executeApprovedCourseAgentAction({
    db: prisma,
    action: fixture.action,
    session: fixture.session,
    now: at(2_000)
  });

  assert.equal(result.status, "succeeded");
  assert.match(result.receiptHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    result.stageVerificationRef,
    `stage-receipt-${fixture.action.callId}`
  );
  assert.deepEqual(driver.calls, {
    stage: 1,
    preflight: 0,
    reconcile: 0,
    editorWrite: 1,
    editorReadback: 1,
    editorClear: 1,
    publish: 0,
    notification: 0
  });
  assert.equal(observedOutcomes.length, 1);
  const model = observedOutcomes[0]!.result.safeModelProjection as {
    publicationStatus: string;
    counts: {
      editorWrite: number;
      editorReadback: number;
      editorClear: number;
      submitMutation: number;
      sendMutation: number;
    };
  };
  assert.equal(model.publicationStatus, "not_published");
  assert.deepEqual(model.counts, {
    editorWrite: 1,
    editorReadback: 1,
    editorClear: 1,
    submitMutation: 0,
    sendMutation: 0
  });

  const [action, grant, step, receipt, verification] = await Promise.all([
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: fixture.action.id }
    }),
    prisma.workbenchCourseToolGrantRecord.findUniqueOrThrow({
      where: { id: fixture.grant.id }
    }),
    prisma.workbenchPlanStepRecord.findUniqueOrThrow({
      where: { id: fixture.scope.stepId }
    }),
    prisma.workbenchToolReceiptRecord.findUniqueOrThrow({
      where: { callId: fixture.action.callId }
    }),
    prisma.workbenchVerificationRecord.findFirstOrThrow({
      where: { runId: fixture.scope.runId }
    })
  ]);
  assert.equal(action.status, "succeeded");
  assert.equal(action.terminalReceiptHash, result.receiptHash);
  assert.equal(grant.status, "consumed");
  assert.equal(step.status, "completed");
  assert.equal(receipt.status, "succeeded");
  assert.match(receipt.safeOutputSummary, /not published/);
  assert.equal(verification.status, "passed");
});

test("auto_reversible exact-approves and executes one durable zero-publish STAGE without a user decision", async () => {
  const driver = createTrustedAdapter("succeeded");
  const fixture = await awaitingFixture({
    suffix: "auto-reversible-success",
    adapter: driver.adapter
  });

  const result = await autoAuthorizeAndExecuteCourseAgentAction({
    db: prisma,
    pendingAction: fixture.pending,
    session: fixture.session,
    policyMode: "auto_reversible",
    now: at(1_000)
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.actionRef, fixture.pending.actionRef);
  assert.equal(
    result.stageVerificationRef,
    `stage-receipt-${fixture.scope.callId}`
  );
  assert.deepEqual(driver.calls, {
    stage: 1,
    preflight: 0,
    reconcile: 0,
    editorWrite: 1,
    editorReadback: 1,
    editorClear: 1,
    publish: 0,
    notification: 0
  });
  const [action, grant, step, receiptCount] = await Promise.all([
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: fixture.pending.actionRef }
    }),
    prisma.workbenchCourseToolGrantRecord.findUniqueOrThrow({
      where: { actionId: fixture.pending.actionRef }
    }),
    prisma.workbenchPlanStepRecord.findUniqueOrThrow({
      where: { id: fixture.scope.stepId }
    }),
    prisma.workbenchToolReceiptRecord.count({
      where: { call: { runId: fixture.scope.runId } }
    })
  ]);
  assert.equal(action.status, "succeeded");
  assert.equal(action.statusReasonCode, "verified_stage_completed");
  assert.equal(grant.status, "consumed");
  assert.ok(grant.consumedAt);
  assert.equal(step.status, "completed");
  assert.equal(receiptCount, 1);
});

test("auto_reversible rejects a non-exact pending projection before issuing any grant", async () => {
  const driver = createTrustedAdapter("succeeded");
  const fixture = await awaitingFixture({
    suffix: "auto-reversible-projection-drift",
    adapter: driver.adapter
  });

  await assert.rejects(
    autoAuthorizeAndExecuteCourseAgentAction({
      db: prisma,
      pendingAction: {
        ...fixture.pending,
        safeSummary: "被篡改的安全摘要。"
      },
      session: fixture.session,
      policyMode: "auto_reversible",
      now: at(1_000)
    }),
    /COURSE_AGENT_AUTO_REVERSIBLE_SCOPE_INVALID/u
  );

  const [action, grantCount] = await Promise.all([
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: fixture.pending.actionRef }
    }),
    prisma.workbenchCourseToolGrantRecord.count({
      where: { actionId: fixture.pending.actionRef }
    })
  ]);
  assert.equal(action.status, "awaiting_approval");
  assert.equal(grantCount, 0);
  assert.equal(driver.calls.stage, 0);
});

test("auto_reversible never retries an unknown STAGE and performs one exact reconcile before manual review", async () => {
  const driver = createTrustedAdapter("unknown", "blocked");
  const fixture = await awaitingFixture({
    suffix: "auto-reversible-unknown",
    adapter: driver.adapter
  });

  const result = await autoAuthorizeAndExecuteCourseAgentAction({
    db: prisma,
    pendingAction: fixture.pending,
    session: fixture.session,
    policyMode: "auto_reversible",
    now: at(1_000)
  });

  assert.equal(result.status, "manual_review");
  assert.equal(result.actionRef, fixture.pending.actionRef);
  assert.ok(result.recoveryActionRef);
  assert.deepEqual(driver.calls, {
    stage: 1,
    preflight: 0,
    reconcile: 1,
    editorWrite: 1,
    editorReadback: 1,
    editorClear: 0,
    publish: 0,
    notification: 0
  });
  const [parent, recovery, grants, step] = await Promise.all([
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: fixture.pending.actionRef }
    }),
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: result.recoveryActionRef! }
    }),
    prisma.workbenchCourseToolGrantRecord.findMany({
      where: { runId: fixture.scope.runId },
      orderBy: { createdAt: "asc" }
    }),
    prisma.workbenchPlanStepRecord.findUniqueOrThrow({
      where: { id: fixture.scope.stepId }
    })
  ]);
  assert.equal(parent.status, "manual_review");
  assert.equal(recovery.status, "manual_review");
  assert.equal(grants.length, 2);
  assert.ok(grants.every((grant) => grant.status === "consumed"));
  assert.equal(step.status, "blocked");
});

test("auto_reversible resolves an unknown STAGE through one owned reconcile and resumes the plan", async () => {
  const driver = createTrustedAdapter("unknown", "succeeded");
  const fixture = await awaitingFixture({
    suffix: "auto-reversible-reconciled",
    adapter: driver.adapter
  });

  const result = await autoAuthorizeAndExecuteCourseAgentAction({
    db: prisma,
    pendingAction: fixture.pending,
    session: fixture.session,
    policyMode: "auto_reversible",
    now: at(1_000)
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.actionRef, fixture.pending.actionRef);
  assert.ok(result.recoveryActionRef);
  assert.match(result.stageVerificationRef ?? "", /^reconcile-receipt-/u);
  assert.deepEqual(driver.calls, {
    stage: 1,
    preflight: 0,
    reconcile: 1,
    editorWrite: 1,
    editorReadback: 1,
    editorClear: 1,
    publish: 0,
    notification: 0
  });
  const [parent, recovery, grants, step] = await Promise.all([
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: fixture.pending.actionRef }
    }),
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: result.recoveryActionRef! }
    }),
    prisma.workbenchCourseToolGrantRecord.findMany({
      where: { runId: fixture.scope.runId }
    }),
    prisma.workbenchPlanStepRecord.findUniqueOrThrow({
      where: { id: fixture.scope.stepId }
    })
  ]);
  assert.equal(parent.status, "reconciled");
  assert.equal(recovery.status, "succeeded");
  assert.equal(grants.length, 2);
  assert.ok(grants.every((grant) => grant.status === "consumed"));
  assert.equal(step.status, "completed");
});

test("failure before grant claim is failed_before_write with a blocked plan, never unknown", async () => {
  const driver = createTrustedAdapter("succeeded");
  const fixture = await approvedFixture({
    suffix: "preclaim-failure",
    adapter: driver.adapter
  });

  const result = await executeApprovedCourseAgentAction({
    db: prisma,
    action: {
      ...fixture.action,
      policyVersion: "cmooc.course-tool.policy.changed-for-test"
    },
    session: fixture.session,
    now: at(2_000)
  });

  assert.equal(result.status, "failed");
  assert.match(result.safeSummary, /取得外部写入权前失败/);
  assert.equal(driver.calls.stage, 0);
  const [action, grant, step, callCount] = await Promise.all([
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: fixture.action.id }
    }),
    prisma.workbenchCourseToolGrantRecord.findUniqueOrThrow({
      where: { id: fixture.grant.id }
    }),
    prisma.workbenchPlanStepRecord.findUniqueOrThrow({
      where: { id: fixture.scope.stepId }
    }),
    prisma.workbenchToolCallRecord.count({
      where: { runId: fixture.scope.runId }
    })
  ]);
  assert.equal(action.status, "failed_before_write");
  assert.equal(action.statusReasonCode, "stage_failed_before_grant_claim");
  assert.equal(grant.status, "available");
  assert.equal(step.status, "blocked");
  assert.equal(callCount, 0);
});

test("ambiguous result after grant claim becomes unknown and waits for reconcile without retry", async () => {
  const driver = createTrustedAdapter("unknown");
  const fixture = await approvedFixture({
    suffix: "unknown-after-claim",
    adapter: driver.adapter
  });

  const result = await executeApprovedCourseAgentAction({
    db: prisma,
    action: fixture.action,
    session: fixture.session,
    now: at(2_000)
  });

  assert.equal(result.status, "unknown");
  assert.equal(result.pendingAction?.toolName, "platform.editor.reconcile_stage");
  assert.equal(result.pendingAction?.parentActionRef, fixture.action.id);
  assert.equal(result.pendingAction?.recoveryOfActionRef, fixture.action.id);
  assert.deepEqual(result.pendingAction?.operationBoundary, {
    editorWriteCount: 0,
    editorReadbackCount: 1,
    editorClearCount: 1,
    publishCount: 0,
    notificationCount: 0,
    realPublishEnabled: false
  });
  assert.equal(driver.calls.stage, 1);
  assert.equal(driver.calls.reconcile, 0);
  const [action, grant, step, calls, receipts, recovery, recoveryGrantCount] = await Promise.all([
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: fixture.action.id }
    }),
    prisma.workbenchCourseToolGrantRecord.findUniqueOrThrow({
      where: { id: fixture.grant.id }
    }),
    prisma.workbenchPlanStepRecord.findUniqueOrThrow({
      where: { id: fixture.scope.stepId }
    }),
    prisma.workbenchToolCallRecord.count({
      where: { runId: fixture.scope.runId }
    }),
    prisma.workbenchToolReceiptRecord.count({
      where: { call: { runId: fixture.scope.runId } }
    }),
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: result.pendingAction!.actionRef }
    }),
    prisma.workbenchCourseToolGrantRecord.count({
      where: { actionId: result.pendingAction!.actionRef }
    })
  ]);
  assert.equal(action.status, "unknown");
  assert.equal(action.statusReasonCode, "stage_outcome_reconcile_required");
  assert.equal(
    action.compensationRef,
    `stage-transaction-${fixture.action.callId}`
  );
  assert.equal(grant.status, "consumed");
  assert.equal(step.status, "waiting_for_reconcile");
  assert.equal(calls, 1);
  assert.equal(receipts, 1);
  assert.equal(recovery.status, "awaiting_approval");
  assert.equal(recovery.toolName, "platform.editor.reconcile_stage");
  assert.equal(recovery.parentActionId, action.id);
  assert.equal(recovery.recoveryOfActionId, action.id);
  assert.deepEqual(JSON.parse(recovery.businessInputJson), {
    stageTransactionRef: action.compensationRef
  });
  assert.equal(recoveryGrantCount, 0, "reconcile authority is issued only after approval");

  await assert.rejects(
    executeApprovedCourseAgentAction({
      db: prisma,
      action,
      session: fixture.session,
      now: at(3_000)
    }),
    /COURSE_AGENT_APPROVED_ACTION_SCOPE_INVALID/
  );
  assert.equal(driver.calls.stage, 1, "unknown STAGE must never blind-retry");
});

test("approved reconcile consumes its own grant, reconciles the parent, and resumes only after verified clear", async () => {
  const driver = createTrustedAdapter("unknown", "succeeded");
  const observedOutcomes: CourseToolExecutionOutcome[] = [];
  const fixture = await approvedFixture({
    suffix: "reconcile-success",
    adapter: driver.adapter,
    observedOutcomes
  });
  const stage = await executeApprovedCourseAgentAction({
    db: prisma,
    action: fixture.action,
    session: fixture.session,
    now: at(2_000)
  });
  assert.equal(stage.status, "unknown");
  assert.ok(stage.pendingAction);
  const recoveryAwaiting =
    await prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: stage.pendingAction!.actionRef }
    });
  const approvedRecovery = await approveCourseToolAction(prisma, {
    actionRef: recoveryAwaiting.id,
    bindingHash: recoveryAwaiting.bindingHash,
    approvalHash: recoveryAwaiting.approvalHash,
    approvedAt: at(3_000)
  });
  const recoveryResult = await executeApprovedCourseAgentAction({
    db: prisma,
    action: approvedRecovery.action,
    session: fixture.session,
    now: at(4_000)
  });

  assert.equal(recoveryResult.status, "succeeded");
  assert.match(recoveryResult.receiptHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    recoveryResult.stageVerificationRef,
    `reconcile-receipt-${recoveryAwaiting.callId}`
  );
  assert.deepEqual(driver.calls, {
    stage: 1,
    preflight: 0,
    reconcile: 1,
    editorWrite: 1,
    editorReadback: 1,
    editorClear: 1,
    publish: 0,
    notification: 0
  });
  const [parent, recovery, stageGrant, recoveryGrant, step, receiptCount] =
    await Promise.all([
      prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
        where: { id: fixture.action.id }
      }),
      prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
        where: { id: recoveryAwaiting.id }
      }),
      prisma.workbenchCourseToolGrantRecord.findUniqueOrThrow({
        where: { id: fixture.grant.id }
      }),
      prisma.workbenchCourseToolGrantRecord.findUniqueOrThrow({
        where: { id: approvedRecovery.grant.id }
      }),
      prisma.workbenchPlanStepRecord.findUniqueOrThrow({
        where: { id: fixture.scope.stepId }
      }),
      prisma.workbenchToolReceiptRecord.count({
        where: { call: { runId: fixture.scope.runId } }
      })
    ]);
  assert.equal(parent.status, "reconciled");
  assert.equal(parent.reconciliationHash, recoveryResult.receiptHash);
  assert.equal(recovery.status, "succeeded");
  assert.equal(recovery.terminalReceiptHash, recoveryResult.receiptHash);
  assert.equal(stageGrant.status, "consumed");
  assert.equal(recoveryGrant.status, "consumed");
  assert.equal(step.status, "completed");
  assert.equal(receiptCount, 2);
  assert.equal(observedOutcomes.length, 1);

  await assert.rejects(
    executeApprovedCourseAgentAction({
      db: prisma,
      action: recovery,
      session: fixture.session,
      now: at(5_000)
    }),
    /COURSE_AGENT_APPROVED_ACTION_SCOPE_INVALID/
  );
  assert.equal(driver.calls.stage, 1);
  assert.equal(driver.calls.reconcile, 1);
});

test("unowned reconcile content terminates in paired manual_review without clearing or retrying", async () => {
  const driver = createTrustedAdapter("unknown", "blocked");
  const fixture = await approvedFixture({
    suffix: "reconcile-unowned",
    adapter: driver.adapter
  });
  const stage = await executeApprovedCourseAgentAction({
    db: prisma,
    action: fixture.action,
    session: fixture.session,
    now: at(2_000)
  });
  const recoveryAwaiting =
    await prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: stage.pendingAction!.actionRef }
    });
  const approvedRecovery = await approveCourseToolAction(prisma, {
    actionRef: recoveryAwaiting.id,
    bindingHash: recoveryAwaiting.bindingHash,
    approvalHash: recoveryAwaiting.approvalHash,
    approvedAt: at(3_000)
  });
  const result = await executeApprovedCourseAgentAction({
    db: prisma,
    action: approvedRecovery.action,
    session: fixture.session,
    now: at(4_000)
  });
  assert.equal(result.status, "manual_review");
  const [parent, recovery, step] = await Promise.all([
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: fixture.action.id }
    }),
    prisma.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: recoveryAwaiting.id }
    }),
    prisma.workbenchPlanStepRecord.findUniqueOrThrow({
      where: { id: fixture.scope.stepId }
    })
  ]);
  assert.equal(parent.status, "manual_review");
  assert.equal(recovery.status, "manual_review");
  assert.equal(step.status, "blocked");
  assert.equal(driver.calls.stage, 1);
  assert.equal(driver.calls.reconcile, 1);
  assert.equal(driver.calls.editorClear, 0);
  assert.equal(driver.calls.publish, 0);
  assert.equal(driver.calls.notification, 0);
});
