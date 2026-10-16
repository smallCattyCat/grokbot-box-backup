import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  hashCourseScope,
  hashCourseToolValue
} from "../../lib/course-tools/contracts";
import {
  PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
  PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION,
  type PlatformStageReconciledOutput,
  type PlatformStageVerifiedOutput
} from "../../lib/course-tools/tools/platform-stage";
import {
  PrismaWorkbenchStageTransactionStore,
  WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_V3_SCHEMA_VERSION,
  type StageTransactionReconcileTerminalBindingV3,
  type StageTransactionStageTerminalBindingV3,
  type SafeWorkbenchStageTransactionRecordV3
} from "../../lib/workbench/prisma-workbench-stage-transaction-store";
import { WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION } from "../../lib/workbench/trusted-workbench-platform-stage-adapter";

const WORKBENCH_STAGE_TRANSACTION_V2 =
  "cmooc.workbench-stage-transaction.v2" as const;
const WORKBENCH_STAGE_TRANSACTION_V3 =
  "cmooc.workbench-stage-transaction.v3" as const;

type V3Record = SafeWorkbenchStageTransactionRecordV3;

const require = createRequire(import.meta.url);
const testRoot = mkdtempSync(path.join(tmpdir(), "cmooc-stage-transactions-"));
const databasePath = path.join(testRoot, "stage-transactions.db").replace(/\\/g, "/");
const databaseUrl = `file:${databasePath}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const t0 = new Date("2026-08-13T17:00:00.000Z");

function hash(label: string): string {
  return hashCourseToolValue("test.workbench-stage-transaction.integration", label);
}

function at(offsetMs: number): string {
  return new Date(t0.getTime() + offsetMs).toISOString();
}

type StageScope = {
  taskId: string;
  runId: string;
  planRevisionId: string;
  stepId: string;
  callId: string;
  executionLeaseId: string;
  courseAlias: string;
  courseScopeHash: string;
  manifestHash: string;
  policyVersion: string;
  integrityVerificationRef: string;
};

async function createScope(
  suffix: string,
  client: PrismaClient = prisma
): Promise<StageScope> {
  const taskId = `task:stage-transaction:${suffix}`;
  const runId = `run:stage-transaction:${suffix}`;
  const planRevisionId = `plan:stage-transaction:${suffix}`;
  const stepId = `step:stage-transaction:${suffix}`;
  const callId = `call:stage-transaction:${suffix}`;
  const executionLeaseId = `lease:stage-transaction:${suffix}`;
  const courseAlias = `course-${suffix}`;
  const manifestHash = hash(`manifest:${suffix}`);
  const policyVersion = "cmooc.course-tool.policy.v1";
  const integrityVerificationRef = `integrity-verification:${hash(`integrity:${suffix}`)}`;
  const courseScopeHash = hashCourseScope({
    courseId: `private-course-${suffix}`,
    alias: courseAlias,
    manifestHash
  });
  await client.workbenchTask.create({
    data: {
      id: taskId,
      title: `安全 STAGE 事务 ${suffix}`,
      status: "running",
      createdAt: new Date(at(-60_000))
    }
  });
  await client.workbenchRunRecord.create({
    data: {
      id: runId,
      taskId,
      schemaVersion: "workbench-run-v1",
      source: "app-server",
      status: "running",
      projectLabel: "课程工作台",
      snapshotJson: "{}",
      createdAt: new Date(at(-60_000)),
      updatedAt: new Date(at(-60_000))
    }
  });
  await client.workbenchPlanRevisionRecord.create({
    data: {
      id: planRevisionId,
      taskId,
      runId,
      revision: 1,
      objectiveHash: hash(`objective:${suffix}`),
      source: "server_compiler",
      compilerVersion: "fixture-v1",
      proposalHash: null,
      safeSummary: "安全 STAGE 测试计划",
      createdAt: new Date(at(-50_000))
    }
  });
  await client.workbenchPlanStepRecord.create({
    data: {
      id: stepId,
      planRevisionId,
      ordinal: 1,
      status: "running",
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
      safeSummary: "安全 STAGE",
      startedAt: new Date(at(-40_000)),
      createdAt: new Date(at(-50_000))
    }
  });
  const fencingTokenHash = hash(`fence:${suffix}`);
  await client.workbenchExecutionLease.create({
    data: {
      id: executionLeaseId,
      taskId,
      runId,
      stepId,
      scopeKey: `stage:${suffix}`,
      ownerInstanceId: "stage-transaction-test",
      generation: 1,
      fencingTokenHash,
      status: "active",
      acquiredAt: new Date(at(-30_000)),
      heartbeatAt: new Date(at(-30_000)),
      expiresAt: new Date(at(600_000))
    }
  });
  await client.workbenchToolCallRecord.create({
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
      safeInputSummary: "安全 STAGE 输入",
      inputHash: hash(`input:${suffix}`),
      idempotencyKey: hash(`idempotency:${suffix}`),
      attempt: 1,
      grantRef: `grant:${suffix}`,
      leaseGeneration: 1,
      fencingTokenHash,
      status: "running",
      createdAt: new Date(at(-20_000))
    }
  });
  return {
    taskId,
    runId,
    planRevisionId,
    stepId,
    callId,
    executionLeaseId,
    courseAlias,
    courseScopeHash,
    manifestHash,
    policyVersion,
    integrityVerificationRef
  };
}

function pendingRecord(
  suffix: string,
  scope: StageScope
): V3Record {
  const candidateKey = hash(`candidate:${suffix}`);
  return {
    schemaVersion: WORKBENCH_STAGE_TRANSACTION_V3,
    stageTransactionRef: `stage-transaction:${hash(`transaction:${suffix}`)}`,
    taskId: scope.taskId,
    runId: scope.runId,
    planRevisionId: scope.planRevisionId,
    stepId: scope.stepId,
    callId: scope.callId,
    courseAlias: scope.courseAlias,
    courseScopeHash: scope.courseScopeHash,
    manifestHash: scope.manifestHash,
    policyVersion: scope.policyVersion,
    integrityVerificationRef: scope.integrityVerificationRef,
    target: {
      targetRef: `support-gap:${candidateKey}`,
      opportunityId: `support-gap:${candidateKey}`,
      candidateKey,
      decisionId: `decision:${suffix}`,
      threadKey: `thread:${suffix}`,
      targetVersionHash: hash(`target-version:${suffix}`),
      eventSetHash: hash(`event-set:${suffix}`),
      opportunityReceiptHash: hash(`opportunity:${suffix}`),
      revalidationReceiptHash: hash(`revalidation:${suffix}`),
      afterObservationReceiptHash: hash(`after-observation:${suffix}`),
      evidenceRefs: [
        {
          kind: "manifest",
          id: scope.courseAlias,
          hash: scope.manifestHash,
          observedAt: at(0)
        },
        {
          kind: "verification",
          id: scope.integrityVerificationRef,
          hash: scope.integrityVerificationRef.replace(
            "integrity-verification:",
            ""
          ),
          observedAt: at(0)
        },
        {
          kind: "decision",
          id: `decision:${suffix}`,
          hash: hash(`decision:${suffix}`),
          observedAt: at(0)
        }
      ]
    },
    artifactVersionRef: `artifact-version:${suffix}`,
    draftBodyHash: hash(`draft:${suffix}`),
    runNonceHash: hash(`nonce:${suffix}`),
    baselineRef: `editor-baseline:${hash(`baseline:${suffix}`)}`,
    baselineHash: hash(`baseline:${suffix}`),
    pageBindingRef: `page-binding:${hash(`page-binding:${suffix}`)}`,
    pageBindingHash: hash(`page-binding:${suffix}`),
    preflightRef: `preflight:${hash(`preflight:${suffix}`)}`,
    preflightHash: hash(`preflight:${suffix}`),
    resolvedTargetReceiptRef: `resolved-target:${hash(`resolved-target:${suffix}`)}`,
    resolvedTargetReceiptHash: hash(`resolved-target:${suffix}`),
    freshObservationRef: `fresh-observation:${hash(`fresh-observation:${suffix}`)}`,
    freshObservationHash: hash(`fresh-observation:${suffix}`),
    eventSetHash: hash(`event-set:${suffix}`),
    targetLocatorHash: hash(`target-locator:${suffix}`),
    resolvedAt: at(0),
    status: "pending",
    verifiedOutput: null,
    terminalBinding: null,
    createdAt: at(0),
    updatedAt: at(0)
  } as V3Record;
}

function verifiedOutput(
  record: V3Record,
  observedAt: string
): PlatformStageVerifiedOutput {
  const receiptHash = hash(`stage-receipt:${record.stageTransactionRef}`);
  return {
    schemaVersion: PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION,
    status: "verified_cleared",
    stageTransactionRef: record.stageTransactionRef,
    receiptRef: `stage-receipt:${receiptHash}`,
    receiptHash,
    targetRef: record.target.targetRef,
    targetVersionHash: record.target.targetVersionHash,
    artifactVersionRef: record.artifactVersionRef,
    draftBodyHash: record.draftBodyHash,
    pageBindingRef: record.pageBindingRef,
    pageBindingHash: record.pageBindingHash,
    baselineRef: record.baselineRef,
    baselineHash: record.baselineHash,
    editorWriteCount: 1,
    editorReadbackCount: 1,
    editorReadbackVerified: true,
    editorClearCount: 1,
    editorEmptyAfterClear: true,
    submitMutationCount: 0,
    sendMutationCount: 0,
    closeAuditStatus: "passed",
    realPublishEnabled: false,
    bodyPersisted: false,
    published: false,
    observedAt,
    evidenceRefs: [
      ...record.target.evidenceRefs,
      {
        kind: "stage_receipt",
        id: `stage-receipt:${receiptHash}`,
        hash: receiptHash,
        observedAt
      }
    ] as unknown as PlatformStageVerifiedOutput["evidenceRefs"],
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
}

function reconciledOutput(
  record: V3Record,
  observedAt: string
): PlatformStageReconciledOutput {
  const verified = verifiedOutput(record, observedAt);
  return {
    ...verified,
    schemaVersion: PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
    status: "reconciled_cleared",
    resolution: "owned_draft_cleared"
  };
}

function stageTerminalBinding(
  record: V3Record,
  output: PlatformStageVerifiedOutput
): StageTransactionStageTerminalBindingV3 {
  return {
    schemaVersion: WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_V3_SCHEMA_VERSION,
    kind: "stage",
    receiptRef: output.receiptRef,
    receiptHash: output.receiptHash,
    resolvedTargetReceiptRef: record.resolvedTargetReceiptRef,
    resolvedTargetReceiptHash: record.resolvedTargetReceiptHash,
    freshObservationRef: record.freshObservationRef,
    freshObservationHash: record.freshObservationHash,
    eventSetHash: record.eventSetHash,
    targetLocatorHash: record.targetLocatorHash,
    resolvedAt: record.resolvedAt,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
}

function reconcileTerminalBinding(
  record: V3Record,
  output: PlatformStageReconciledOutput
): StageTransactionReconcileTerminalBindingV3 {
  return {
    schemaVersion: WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_V3_SCHEMA_VERSION,
    kind: "reconcile",
    receiptRef: output.receiptRef,
    receiptHash: output.receiptHash,
    originalResolvedTargetReceiptRef: record.resolvedTargetReceiptRef,
    originalResolvedTargetReceiptHash: record.resolvedTargetReceiptHash,
    reconcileResolvedTargetReceiptRef: `resolved-target:${hash("reconcile-target")}`,
    reconcileResolvedTargetReceiptHash: hash("reconcile-target"),
    reconcileFreshObservationRef: `fresh-observation:${hash("reconcile-observation")}`,
    reconcileFreshObservationHash: hash("reconcile-observation"),
    reconcileEventSetHash: hash("reconcile-event-set"),
    reconcileTargetLocatorHash: record.targetLocatorHash,
    reconcileResolvedAt: output.observedAt,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
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

test("unknown STAGE state survives a new client and reaches one immutable verified terminal", async () => {
  const scope = await createScope("restart");
  const record = pendingRecord("restart", scope);
  const firstStore = new PrismaWorkbenchStageTransactionStore(prisma);
  await firstStore.createPending(record);
  await firstStore.createPending({
    ...record,
    createdAt: at(500),
    updatedAt: at(500)
  });
  await firstStore.markUnknown(record.stageTransactionRef, at(1_000));

  const restartedPrisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } }
  });
  await restartedPrisma.$connect();
  try {
    const restartedStore = new PrismaWorkbenchStageTransactionStore(restartedPrisma);
    const recovered = await restartedStore.get(record.stageTransactionRef);
    assert.equal(recovered?.status, "unknown");
    assert.equal(recovered?.taskId, scope.taskId);
    assert.equal(recovered?.runId, scope.runId);
    assert.equal(recovered?.planRevisionId, scope.planRevisionId);
    assert.equal(recovered?.stepId, scope.stepId);
    assert.equal(recovered?.callId, scope.callId);
    assert.equal(recovered?.courseAlias, scope.courseAlias);
    assert.equal(recovered?.courseScopeHash, scope.courseScopeHash);
    assert.equal(recovered?.manifestHash, scope.manifestHash);
    assert.equal(recovered?.policyVersion, scope.policyVersion);
    assert.equal(
      recovered?.integrityVerificationRef,
      scope.integrityVerificationRef
    );
    assert.equal(recovered?.verifiedOutput, null);

    const output = verifiedOutput(record, at(2_000));
    await restartedStore.markVerified(
      record.stageTransactionRef,
      output,
      output.observedAt,
      stageTerminalBinding(record, output)
    );
    await restartedStore.markVerified(
      record.stageTransactionRef,
      output,
      output.observedAt,
      stageTerminalBinding(record, output)
    );
    await restartedStore.markUnknown(record.stageTransactionRef, at(3_000));

    const terminal = await firstStore.get(record.stageTransactionRef);
    assert.equal(terminal?.status, "verified");
    assert.deepEqual(terminal?.verifiedOutput, output);
    assert.equal(terminal?.updatedAt, output.observedAt);
    const persisted = await prisma.workbenchStageTransactionRecord.findUniqueOrThrow({
      where: { stageTransactionRef: record.stageTransactionRef }
    });
    assert.equal(persisted.terminalAt?.toISOString(), output.observedAt);
    assert.equal(persisted.containsForumText, false);
    assert.equal(persisted.containsIdentity, false);
    assert.equal(persisted.containsSecrets, false);
    const serialized = JSON.stringify(persisted).toLowerCase();
    assert.equal(serialized.includes("https://"), false);
    assert.equal(serialized.includes("cookie"), false);
    assert.equal(serialized.includes("bearer "), false);
    assert.equal(serialized.includes("must-never-persist"), false);
    assert.equal(serialized.includes(`private-course-${"restart"}`), false);
  } finally {
    await restartedPrisma.$disconnect();
  }
});

test("reconciled is a durable terminal and conflicting terminal output is rejected", async () => {
  const scope = await createScope("reconciled");
  const record = pendingRecord("reconciled", scope);
  const store = new PrismaWorkbenchStageTransactionStore(prisma);
  await store.createPending(record);
  await store.markUnknown(record.stageTransactionRef, at(4_000));
  const output = reconciledOutput(record, at(5_000));
  await store.markVerified(
    record.stageTransactionRef,
    output,
    output.observedAt,
    reconcileTerminalBinding(record, output)
  );
  assert.equal((await store.get(record.stageTransactionRef))?.status, "reconciled");

  const conflictingReceiptHash = hash("different-reconcile-receipt");
  const conflicting = {
    ...output,
    receiptRef: `stage-receipt:${conflictingReceiptHash}`,
    receiptHash: conflictingReceiptHash,
    evidenceRefs: output.evidenceRefs.map((ref) =>
      ref.kind === "stage_receipt"
        ? {
            ...ref,
            id: `stage-receipt:${conflictingReceiptHash}`,
            hash: conflictingReceiptHash
          }
        : ref
    )
  } as PlatformStageReconciledOutput;
  await assert.rejects(
    store.markVerified(
      record.stageTransactionRef,
      conflicting,
      conflicting.observedAt,
      reconcileTerminalBinding(record, conflicting)
    ),
    /WORKBENCH_STAGE_TRANSACTION_CONFLICT/
  );
});

test("same transaction reference cannot be rebound and task/run scope must be exact", async () => {
  const firstScope = await createScope("binding-a");
  const secondScope = await createScope("binding-b");
  const record = pendingRecord("binding", firstScope);
  const store = new PrismaWorkbenchStageTransactionStore(prisma);
  await store.createPending(record);
  await assert.rejects(
    store.createPending({ ...record, runNonceHash: hash("replacement-nonce") }),
    /WORKBENCH_STAGE_TRANSACTION_CONFLICT/
  );
  await assert.rejects(
    store.createPending({ ...record, policyVersion: "cmooc.course-tool.policy.v2" }),
    /WORKBENCH_STAGE_TRANSACTION_CONFLICT/
  );
  await assert.rejects(
    store.createPending({ ...record, courseAlias: "other-course" }),
    /WORKBENCH_STAGE_TRANSACTION_CONFLICT/
  );
  await assert.rejects(
    store.createPending({ ...record, courseScopeHash: hash("other-scope") }),
    /WORKBENCH_STAGE_TRANSACTION_CONFLICT/
  );
  await assert.rejects(
    store.createPending({
      ...record,
      manifestHash: hash("replacement-manifest"),
      target: {
        ...record.target,
        evidenceRefs: record.target.evidenceRefs.map((ref) =>
          ref.kind === "manifest"
            ? { ...ref, hash: hash("replacement-manifest") }
            : ref
        )
      }
    }),
    /WORKBENCH_STAGE_TRANSACTION_CONFLICT/
  );
  await assert.rejects(
    store.createPending({
      ...pendingRecord("scope-mismatch", firstScope),
      runId: secondScope.runId
    }),
    /WORKBENCH_STAGE_TRANSACTION_SCOPE_MISMATCH/
  );
});

test("terminal CAS rejects every stale or tampered v3 target binding", async () => {
  const scope = await createScope("terminal-binding");
  const record = pendingRecord("terminal-binding", scope);
  const store = new PrismaWorkbenchStageTransactionStore(prisma);
  await store.createPending(record);
  const output = verifiedOutput(record, at(7_000));
  const canonical = stageTerminalBinding(record, output);
  for (const binding of [
    { ...canonical, receiptHash: hash("tampered-terminal-receipt") },
    {
      ...canonical,
      resolvedTargetReceiptHash: hash("tampered-resolved-target")
    },
    { ...canonical, freshObservationHash: hash("tampered-fresh-observation") },
    { ...canonical, eventSetHash: hash("tampered-event-set") },
    { ...canonical, targetLocatorHash: hash("tampered-target-locator") },
    { ...canonical, resolvedAt: at(8_000) }
  ] as StageTransactionStageTerminalBindingV3[]) {
    await assert.rejects(
      store.markVerified(
        record.stageTransactionRef,
        output,
        output.observedAt,
        binding
      ),
      /WORKBENCH_STAGE_TRANSACTION_TERMINAL_(RECEIPT|BINDING)_MISMATCH/
    );
  }
  assert.equal((await store.get(record.stageTransactionRef))?.status, "pending");
});

test("the migrated schema reads terminal v2 history and rejects legacy nonterminal continuation", async () => {
  const scope = await createScope("legacy-v2");
  const record = pendingRecord("legacy-v2", scope);
  const output = verifiedOutput(record, at(9_000));
  const legacyTarget = { ...record.target } as Record<string, unknown>;
  delete legacyTarget.eventSetHash;
  let inspectedTerminal = false;
  let rejectedNonterminal = false;
  await assert.rejects(
    prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        'DROP TRIGGER "WorkbenchStageTransactionRecord_insert_check"'
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO "WorkbenchStageTransactionRecord" (
      "stageTransactionRef", "schemaVersion", "taskId", "runId", "planRevisionId",
      "stepId", "callId", "courseAlias", "courseScopeHash", "manifestHash",
      "policyVersion", "integrityVerificationRef", "targetRef", "opportunityId",
      "candidateKey", "decisionId", "threadKey", "targetVersionHash",
      "opportunityReceiptHash", "revalidationReceiptHash",
      "afterObservationReceiptHash", "targetEvidenceRefsJson", "artifactVersionRef",
      "draftBodyHash", "runNonceHash", "baselineRef", "baselineHash",
      "pageBindingRef", "pageBindingHash", "status", "verifiedOutputJson",
      "containsForumText", "containsIdentity", "containsSecrets", "createdAt",
      "updatedAt", "terminalAt"
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    record.stageTransactionRef,
    WORKBENCH_STAGE_TRANSACTION_V2,
    record.taskId,
    record.runId,
    record.planRevisionId,
    record.stepId,
    record.callId,
    record.courseAlias,
    record.courseScopeHash,
    record.manifestHash,
    record.policyVersion,
    record.integrityVerificationRef,
    legacyTarget.targetRef,
    legacyTarget.opportunityId,
    legacyTarget.candidateKey,
    legacyTarget.decisionId,
    legacyTarget.threadKey,
    legacyTarget.targetVersionHash,
    legacyTarget.opportunityReceiptHash,
    legacyTarget.revalidationReceiptHash,
    legacyTarget.afterObservationReceiptHash,
    JSON.stringify(legacyTarget.evidenceRefs),
    record.artifactVersionRef,
    record.draftBodyHash,
    record.runNonceHash,
    record.baselineRef,
    record.baselineHash,
    record.pageBindingRef,
    record.pageBindingHash,
    "verified",
    JSON.stringify(output),
    false,
    false,
    false,
    at(0),
    output.observedAt,
        output.observedAt
      );
      const store = new PrismaWorkbenchStageTransactionStore(transaction);
      const legacy = await store.get(record.stageTransactionRef);
      assert.equal(legacy?.schemaVersion, WORKBENCH_STAGE_TRANSACTION_V2);
      assert.equal(legacy?.status, "verified");
      inspectedTerminal = true;
      await assert.rejects(
        store.markVerified(
          record.stageTransactionRef,
          output,
          output.observedAt,
          stageTerminalBinding(record, output)
        ),
        /WORKBENCH_STAGE_TRANSACTION_LEGACY_READ_ONLY/
      );
      await transaction.$executeRawUnsafe(
        'DROP TRIGGER "WorkbenchStageTransactionRecord_update_check"'
      );
      await transaction.$executeRawUnsafe(
        `UPDATE "WorkbenchStageTransactionRecord"
         SET "status" = 'pending', "verifiedOutputJson" = NULL,
             "updatedAt" = "createdAt", "terminalAt" = NULL
         WHERE "stageTransactionRef" = ?`,
        record.stageTransactionRef
      );
      await assert.rejects(
        store.get(record.stageTransactionRef),
        /WORKBENCH_STAGE_TRANSACTION_LEGACY_RECONCILE_ONLY/
      );
      rejectedNonterminal = true;
      throw new Error("ROLLBACK_LEGACY_V2_FIXTURE");
    }),
    /ROLLBACK_LEGACY_V2_FIXTURE/
  );
  assert.equal(inspectedTerminal, true);
  assert.equal(rejectedNonterminal, true);
});

test("database constraints reject privacy drift and invalid terminal transitions", async () => {
  const scope = await createScope("database-guards");
  const record = pendingRecord("database-guards", scope);
  const store = new PrismaWorkbenchStageTransactionStore(prisma);
  await store.createPending(record);
  await assert.rejects(
    prisma.$executeRawUnsafe(
      'UPDATE "WorkbenchStageTransactionRecord" SET "containsSecrets" = 1 WHERE "stageTransactionRef" = ?',
      record.stageTransactionRef
    )
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(
      'UPDATE "WorkbenchStageTransactionRecord" SET "runNonceHash" = ? WHERE "stageTransactionRef" = ?',
      hash("database-rebind"),
      record.stageTransactionRef
    )
  );
  for (const [column, value] of [
    ["planRevisionId", "plan:tampered"],
    ["stepId", "step:tampered"],
    ["callId", "call:tampered"],
    ["courseAlias", "other-course"],
    ["courseScopeHash", hash("tampered-scope")],
    ["manifestHash", hash("tampered-manifest")],
    ["policyVersion", "cmooc.course-tool.policy.v2"],
    ["integrityVerificationRef", `integrity-verification:${hash("tampered")}`],
    ["preflightRef", `preflight:${hash("tampered")}`],
    ["preflightHash", hash("tampered")],
    ["resolvedTargetReceiptRef", `resolved-target:${hash("tampered")}`],
    ["resolvedTargetReceiptHash", hash("tampered")],
    ["freshObservationRef", `fresh-observation:${hash("tampered")}`],
    ["freshObservationHash", hash("tampered")],
    ["eventSetHash", hash("tampered")],
    ["targetLocatorHash", hash("tampered")],
    ["resolvedAt", at(-1_000)]
  ] as const) {
    await assert.rejects(
      prisma.$executeRawUnsafe(
        `UPDATE "WorkbenchStageTransactionRecord" SET "${column}" = ? WHERE "stageTransactionRef" = ?`,
        value,
        record.stageTransactionRef
      )
    );
  }
  await assert.rejects(
    prisma.$executeRawUnsafe(
      'UPDATE "WorkbenchStageTransactionRecord" SET "status" = \'verified\' WHERE "stageTransactionRef" = ?',
      record.stageTransactionRef
    )
  );
  const unchanged = await store.get(record.stageTransactionRef);
  assert.equal(unchanged?.status, "pending");
  assert.equal(unchanged?.verifiedOutput, null);
});
