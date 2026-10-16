import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { createArtifactVersion } from "../../lib/workbench/artifact-store";
import {
  appendToolCall,
  claimExecutionLease,
  commitToolReceipt,
  createSafeTaskObjective,
  heartbeatExecutionLease,
  recordVerification,
  releaseExecutionLease,
  WorkbenchDurableLedgerError,
  WorkbenchExecutionLeaseBusyError,
  WorkbenchExecutionLeaseStaleError
} from "../../lib/workbench/durable-ledger";
import {
  createPlanRevision,
  loadCurrentCanonicalPlan,
  transitionPlanStep
} from "../../lib/workbench/plan-store";

const require = createRequire(import.meta.url);
const testRoot = mkdtempSync(path.join(tmpdir(), "cmooc-durable-ledger-"));
const databasePath = path.join(testRoot, "ledger.db").replace(/\\/g, "/");
const databaseUrl = `file:${databasePath}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

const taskId = "task-durable-ledger";
const runId = "run-durable-ledger";
const objectiveHash = hash("classified objective");
const evidenceHash = hash("safe evidence");
const t0 = new Date("2026-08-12T18:00:00.000Z");

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function at(offsetMs: number): Date {
  return new Date(t0.getTime() + offsetMs);
}

const evidenceRef = {
  kind: "snapshot",
  id: "snapshot:safe-001",
  hash: evidenceHash,
  observedAt: t0.toISOString()
} as const;

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
  await prisma.workbenchTask.create({
    data: {
      id: taskId,
      title: "安全目标",
      status: "running",
      createdAt: t0
    }
  });
  await prisma.workbenchRunRecord.create({
    data: {
      id: runId,
      taskId,
      schemaVersion: "workbench-run-v1",
      source: "app-server",
      status: "running",
      projectLabel: "课程工作台",
      snapshotJson: "{}",
      createdAt: t0,
      updatedAt: t0
    }
  });
});

after(async () => {
  await prisma.$disconnect();
  rmSync(testRoot, { recursive: true, force: true });
});

test("safe objective and canonical plan revisions are immutable, complete and proposal-separated", async () => {
  const objective = await createSafeTaskObjective(prisma, {
    id: "objective-safe-001",
    taskId,
    objectiveHash,
    safeSummary: "识别一个证据合格的支持缺口并交付安全成果。",
    structuredGoal: {
      goalCode: "support_gap_to_stage_report",
      courseAlias: "course_fixture",
      contextRefs: ["snapshot:safe-001"],
      requestedArtifactKinds: ["facilitation_draft", "verification_report"],
      constraints: ["no_publish", "no_forum_body_persistence"]
    },
    source: "user_request_classified",
    createdAt: t0,
    expiresAt: at(60_000)
  });
  assert.equal(objective.objectiveHash, objectiveHash);
  assert.equal(objective.structuredGoalJson.includes("rawPrompt"), false);

  const steps = [
    {
      id: "step-read-evidence",
      ordinal: 1,
      toolName: "course.snapshot.read",
      toolVersion: "1",
      dependencyIds: [],
      inputRefs: [
        {
          kind: "snapshot",
          id: evidenceRef.id,
          hash: evidenceRef.hash,
          observedAt: evidenceRef.observedAt
        }
      ],
      preconditions: [],
      postconditions: [{ code: "anchor_verified", required: true }],
      effectClass: "read" as const,
      requiredCapability: "L0_READ" as const,
      acceptance: { allOf: ["anchor_verified"] },
      replanPolicy: { on: ["stale", "mismatch"], maxAttempts: 2 },
      safeSummary: "读取并核验精确课程快照。"
    },
    {
      id: "step-create-artifact",
      ordinal: 2,
      toolName: "artifact.reply_draft.create",
      toolVersion: "1",
      dependencyIds: ["step-read-evidence"],
      inputRefs: [
        {
          kind: "plan_step",
          id: "step-read-evidence",
          hash: evidenceRef.hash
        }
      ],
      preconditions: [{ code: "anchor_verified", required: true }],
      postconditions: [{ code: "artifact_validated", required: true }],
      effectClass: "local_write" as const,
      requiredCapability: "L1_ARTIFACT" as const,
      acceptance: { allOf: ["artifact_validated"] },
      replanPolicy: { on: ["verification_failed"], maxAttempts: 2 },
      safeSummary: "生成只含安全持久投影的草稿成果。"
    }
  ];
  const plan = await createPlanRevision(prisma, {
    id: "plan-revision-safe-001",
    taskId,
    runId,
    revision: 1,
    objectiveHash,
    compilerVersion: "server-compiler-v1",
    proposalHash: hash("model proposal only"),
    safeSummary: "服务端编译了两步 canonical 执行计划。",
    steps,
    createdAt: at(10)
  });
  assert.equal(plan.source, "server_compiler");
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[1].toolName, "artifact.reply_draft.create");
  assert.deepEqual(JSON.parse(plan.steps[1].dependencyIdsJson), [
    "step-read-evidence"
  ]);
  assert.equal(plan.steps.every((step) => step.status === "pending"), true);

  const repeated = await createPlanRevision(prisma, {
    id: "ignored-idempotent-id",
    taskId,
    runId,
    revision: 1,
    objectiveHash,
    compilerVersion: "server-compiler-v1",
    proposalHash: hash("model proposal only"),
    safeSummary: "服务端编译了两步 canonical 执行计划。",
    steps,
    createdAt: at(20)
  });
  assert.equal(repeated.id, plan.id);

  await assert.rejects(
    createSafeTaskObjective(prisma, {
      taskId,
      objectiveHash: hash("different objective"),
      safeSummary: "另一份目标。",
      structuredGoal: { goalCode: "different" },
      source: "user_request_classified"
    }),
    (error: unknown) =>
      error instanceof WorkbenchDurableLedgerError &&
      error.code === "WORKBENCH_SAFE_OBJECTIVE_IMMUTABLE"
  );
});

test("lease generation and fencing CAS prevent stale receipt commits", async () => {
  const lease = await claimExecutionLease(prisma, {
    id: "lease-step-read",
    taskId,
    runId,
    stepId: "step-read-evidence",
    ownerInstanceId: "worker-one",
    ttlMs: 1_000,
    now: at(100)
  });
  assert.equal(lease.generation, 1);
  assert.notEqual(lease.fencingTokenHash, lease.fencingToken);

  await assert.rejects(
    claimExecutionLease(prisma, {
      taskId,
      runId,
      stepId: "step-read-evidence",
      ownerInstanceId: "worker-two",
      ttlMs: 1_000,
      now: at(200)
    }),
    WorkbenchExecutionLeaseBusyError
  );

  const oldCallClaim = await appendToolCall(prisma, {
    id: "call-old-generation",
    taskId,
    runId,
    stepId: "step-read-evidence",
    executionLeaseId: lease.id,
    toolName: "course.snapshot.read",
    toolVersion: "1",
    capability: "L0_READ",
    effectClass: "read",
    safeInputSummary: "读取精确锚定的安全快照。",
    inputHash: hash("old call input"),
    idempotencyKey: hash("old call idempotency"),
    attempt: 1,
    leaseGeneration: lease.generation,
    fencingToken: lease.fencingToken,
    createdAt: at(300)
  });
  const oldCall = oldCallClaim.record;
  assert.equal(oldCallClaim.disposition, "accepted");
  assert.equal(oldCall.status, "requested");

  const replacement = await claimExecutionLease(prisma, {
    taskId,
    runId,
    stepId: "step-read-evidence",
    ownerInstanceId: "worker-two",
    ttlMs: 2_000,
    now: at(1_200)
  });
  assert.equal(replacement.id, lease.id);
  assert.equal(replacement.generation, 2);

  await assert.rejects(
    commitToolReceipt(prisma, {
      callId: oldCall.id,
      status: "succeeded",
      safeOutputSummary: "旧 worker 声称完成。",
      outputHash: hash("stale output"),
      evidenceRefs: [evidenceRef],
      observedAt: at(1_250),
      leaseGeneration: lease.generation,
      fencingToken: lease.fencingToken,
      committedAt: at(1_250)
    }),
    WorkbenchExecutionLeaseStaleError
  );

  const currentCallClaim = await appendToolCall(prisma, {
    id: "call-current-generation",
    taskId,
    runId,
    stepId: "step-read-evidence",
    executionLeaseId: replacement.id,
    parentCallId: oldCall.id,
    toolName: "course.snapshot.read",
    toolVersion: "1",
    capability: "L0_READ",
    effectClass: "read",
    safeInputSummary: "接管后重新读取同一精确锚点。",
    inputHash: hash("current call input"),
    idempotencyKey: hash("current call idempotency"),
    attempt: 2,
    leaseGeneration: replacement.generation,
    fencingToken: replacement.fencingToken,
    createdAt: at(1_300)
  });
  const currentCall = currentCallClaim.record;
  assert.equal(currentCallClaim.disposition, "accepted");
  const duplicateCall = await appendToolCall(prisma, {
    id: "ignored-duplicate-call-id",
    taskId,
    runId,
    stepId: "step-read-evidence",
    executionLeaseId: replacement.id,
    parentCallId: oldCall.id,
    toolName: "course.snapshot.read",
    toolVersion: "1",
    capability: "L0_READ",
    effectClass: "read",
    safeInputSummary: "接管后重新读取同一精确锚点。",
    inputHash: hash("current call input"),
    idempotencyKey: hash("current call idempotency"),
    attempt: 2,
    leaseGeneration: replacement.generation,
    fencingToken: replacement.fencingToken,
    createdAt: at(1_320)
  });
  assert.equal(duplicateCall.disposition, "duplicate");
  assert.equal(duplicateCall.record.id, currentCall.id);
  assert.equal(
    await prisma.workbenchToolCallRecord.count({
      where: {
        toolName: "course.snapshot.read",
        idempotencyKey: hash("current call idempotency"),
        attempt: 2
      }
    }),
    1
  );
  const verification = await recordVerification(prisma, {
    id: "verification-evidence-001",
    taskId,
    runId,
    subjectType: "evidence",
    subjectId: evidenceRef.id,
    verifier: "evidence.integrity.verify",
    verifierVersion: "1",
    status: "passed",
    safeSummary: "锚点、hash 与 freshness 检查通过。",
    checks: [
      {
        code: "anchor_match",
        status: "passed",
        safeSummary: "课程与快照锚点一致。"
      },
      {
        code: "hash_match",
        status: "passed",
        safeSummary: "安全证据哈希一致。"
      }
    ],
    evidenceRefs: [evidenceRef],
    observedAt: at(1_350),
    expiresAt: at(2_500),
    executionLeaseId: replacement.id,
    stepId: "step-read-evidence",
    leaseGeneration: replacement.generation,
    fencingToken: replacement.fencingToken,
    committedAt: at(1_360)
  });
  const receipt = await commitToolReceipt(prisma, {
    id: "receipt-current-generation",
    callId: currentCall.id,
    status: "succeeded",
    safeOutputSummary: "读取了一个安全锚定快照并通过独立核验。",
    outputHash: hash("safe output projection"),
    evidenceRefs: [evidenceRef],
    beforeRef: evidenceRef,
    afterRef: evidenceRef,
    verificationId: verification.id,
    observedAt: at(1_400),
    leaseGeneration: replacement.generation,
    fencingToken: replacement.fencingToken,
    committedAt: at(1_450)
  });
  assert.equal(receipt.containsForumText, false);
  assert.equal(receipt.containsIdentity, false);

  const heartbeat = await heartbeatExecutionLease(prisma, {
    leaseId: replacement.id,
    ownerInstanceId: "worker-two",
    generation: replacement.generation,
    fencingToken: replacement.fencingToken,
    ttlMs: 2_000,
    now: at(1_500)
  });
  assert.equal(heartbeat.expiresAt.toISOString(), at(3_500).toISOString());
  const released = await releaseExecutionLease(prisma, {
    leaseId: replacement.id,
    ownerInstanceId: "worker-two",
    generation: replacement.generation,
    fencingToken: replacement.fencingToken,
    now: at(1_600)
  });
  assert.equal(released.status, "released");

  await assert.rejects(
    recordVerification(prisma, {
      id: "verification-stale-fence",
      taskId,
      runId,
      subjectType: "tool_result",
      subjectId: currentCall.id,
      verifier: "course.tool.result.verify",
      verifierVersion: "1",
      status: "passed",
      safeSummary: "过期 worker 不应写入该 verification。",
      checks: [
        {
          code: "schema_match",
          status: "passed",
          safeSummary: "该摘要不应被持久化。"
        }
      ],
      evidenceRefs: [evidenceRef],
      observedAt: at(1_700),
      executionLeaseId: replacement.id,
      stepId: "step-read-evidence",
      leaseGeneration: replacement.generation,
      fencingToken: replacement.fencingToken,
      committedAt: at(1_700)
    }),
    WorkbenchExecutionLeaseStaleError
  );
  assert.equal(
    await prisma.workbenchVerificationRecord.count({
      where: { id: "verification-stale-fence" }
    }),
    0
  );

  const takeover = await claimExecutionLease(prisma, {
    taskId,
    runId,
    stepId: "step-read-evidence",
    ownerInstanceId: "worker-three",
    ttlMs: 1_000,
    now: at(1_800)
  });
  assert.equal(takeover.generation, replacement.generation + 1);
  await assert.rejects(
    recordVerification(prisma, {
      id: "verification-superseded-fence",
      taskId,
      runId,
      subjectType: "tool_result",
      subjectId: currentCall.id,
      verifier: "course.tool.result.verify",
      verifierVersion: "1",
      status: "passed",
      safeSummary: "被接管的 worker 不应写入 verification。",
      checks: [
        {
          code: "schema_match",
          status: "passed",
          safeSummary: "该摘要不应被持久化。"
        }
      ],
      evidenceRefs: [evidenceRef],
      observedAt: at(1_850),
      executionLeaseId: replacement.id,
      stepId: "step-read-evidence",
      leaseGeneration: replacement.generation,
      fencingToken: replacement.fencingToken,
      committedAt: at(1_850)
    }),
    WorkbenchExecutionLeaseStaleError
  );
  assert.equal(
    await prisma.workbenchVerificationRecord.count({
      where: { id: "verification-superseded-fence" }
    }),
    0
  );
  await releaseExecutionLease(prisma, {
    leaseId: takeover.id,
    ownerInstanceId: "worker-three",
    generation: takeover.generation,
    fencingToken: takeover.fencingToken,
    now: at(1_900)
  });
});

test("artifact versions keep only safe metadata, hashes, refs and regeneration recipes", async () => {
  const artifact = await createArtifactVersion(prisma, {
    id: "artifact-version-001",
    taskId,
    runId,
    artifactId: "facilitation-draft-001",
    version: 1,
    artifactKind: "facilitation_draft",
    contentClass: "restricted_transient",
    contentHash: hash("artifact object projection"),
    draftBodyHash: hash("transient body never persisted"),
    safeSummary: "草稿版本通过确定性 guard，正文保持瞬时。",
    metadata: {
      guardVersion: "privacy_claim_guard_v1",
      guardStatus: "passed",
      containsForumText: false,
      containsIdentity: false
    },
    sourceRefs: [evidenceRef],
    regenerationRecipe: {
      recipeCode: "intent_movespec_v1",
      inputRefs: ["snapshot:safe-001"]
    },
    createdByCallId: "call-current-generation",
    createdAt: at(1_700),
    expiresAt: at(60_000)
  });
  assert.equal(artifact.contentRef, null);
  assert.equal(artifact.version, 1);
  assert.equal(artifact.metadataJson.includes("transient body"), false);

  const repeated = await createArtifactVersion(prisma, {
    taskId,
    runId,
    artifactId: "facilitation-draft-001",
    version: 1,
    artifactKind: "facilitation_draft",
    contentClass: "restricted_transient",
    contentHash: hash("artifact object projection"),
    draftBodyHash: hash("transient body never persisted"),
    safeSummary: "草稿版本通过确定性 guard，正文保持瞬时。",
    metadata: {
      guardVersion: "privacy_claim_guard_v1",
      guardStatus: "passed",
      containsForumText: false,
      containsIdentity: false
    },
    sourceRefs: [evidenceRef],
    regenerationRecipe: {
      recipeCode: "intent_movespec_v1",
      inputRefs: ["snapshot:safe-001"]
    },
    createdByCallId: "call-current-generation",
    createdAt: at(1_800),
    expiresAt: at(60_000)
  });
  assert.equal(repeated.id, artifact.id);

  await assert.rejects(
    createArtifactVersion(prisma, {
      taskId,
      runId,
      artifactId: "facilitation-draft-001",
      version: 1,
      artifactKind: "facilitation_draft",
      contentClass: "restricted_transient",
      contentHash: hash("changed object projection"),
      draftBodyHash: hash("changed transient body"),
      safeSummary: "试图覆盖旧版本。",
      metadata: { guardStatus: "passed" },
      sourceRefs: [evidenceRef],
      regenerationRecipe: { recipeCode: "intent_movespec_v1" }
    }),
    (error: unknown) =>
      error instanceof WorkbenchDurableLedgerError &&
      error.code === "WORKBENCH_ARTIFACT_VERSION_IMMUTABLE"
  );
});

test("current canonical plan enforces dependency-aware CAS transitions and terminal completion", async () => {
  const current = await loadCurrentCanonicalPlan(prisma, { taskId, runId });
  assert.equal(current?.id, "plan-revision-safe-001");
  assert.deepEqual(current?.steps.map((step) => step.id), [
    "step-read-evidence",
    "step-create-artifact"
  ]);

  await assert.rejects(
    transitionPlanStep(prisma, {
      taskId,
      runId,
      stepId: "step-create-artifact",
      from: "pending",
      to: "running",
      at: at(2_000)
    }),
    (error: unknown) =>
      error instanceof WorkbenchDurableLedgerError &&
      error.code === "WORKBENCH_PLAN_STEP_DEPENDENCY_INCOMPLETE"
  );

  const firstRunning = await transitionPlanStep(prisma, {
    taskId,
    runId,
    stepId: "step-read-evidence",
    from: "pending",
    to: "running",
    at: at(2_100)
  });
  assert.equal(firstRunning.startedAt?.toISOString(), at(2_100).toISOString());
  const firstCompleted = await transitionPlanStep(prisma, {
    taskId,
    runId,
    stepId: "step-read-evidence",
    from: "running",
    to: "completed",
    at: at(2_200)
  });
  assert.equal(firstCompleted.completedAt?.toISOString(), at(2_200).toISOString());

  await assert.rejects(
    transitionPlanStep(prisma, {
      taskId,
      runId,
      stepId: "step-read-evidence",
      from: "completed",
      to: "pending",
      at: at(2_300)
    }),
    (error: unknown) =>
      error instanceof WorkbenchDurableLedgerError &&
      error.code === "WORKBENCH_PLAN_STEP_TRANSITION_INVALID"
  );

  await transitionPlanStep(prisma, {
    taskId,
    runId,
    stepId: "step-create-artifact",
    from: "pending",
    to: "running",
    at: at(2_400)
  });
  await transitionPlanStep(prisma, {
    taskId,
    runId,
    stepId: "step-create-artifact",
    from: "running",
    to: "blocked",
    at: at(2_500)
  });
  await transitionPlanStep(prisma, {
    taskId,
    runId,
    stepId: "step-create-artifact",
    from: "blocked",
    to: "pending",
    at: at(2_600)
  });
  await transitionPlanStep(prisma, {
    taskId,
    runId,
    stepId: "step-create-artifact",
    from: "pending",
    to: "running",
    at: at(2_700)
  });
  const secondCompleted = await transitionPlanStep(prisma, {
    taskId,
    runId,
    stepId: "step-create-artifact",
    from: "running",
    to: "completed",
    at: at(2_800)
  });
  assert.equal(secondCompleted.status, "completed");
  assert.equal(secondCompleted.completedAt?.toISOString(), at(2_800).toISOString());
});

test("ordinary durable rows contain no raw fencing token or forbidden content flags", async () => {
  const [objectives, plans, calls, receipts, artifacts, verifications, leases] =
    await Promise.all([
      prisma.workbenchSafeTaskObjective.findMany(),
      prisma.workbenchPlanRevisionRecord.findMany({ include: { steps: true } }),
      prisma.workbenchToolCallRecord.findMany(),
      prisma.workbenchToolReceiptRecord.findMany(),
      prisma.workbenchArtifactVersionRecord.findMany(),
      prisma.workbenchVerificationRecord.findMany(),
      prisma.workbenchExecutionLease.findMany()
    ]);
  const serialized = JSON.stringify({
    objectives,
    plans,
    calls,
    receipts,
    artifacts,
    verifications,
    leases
  });
  assert.equal(serialized.includes("transient body never persisted"), false);
  assert.equal(serialized.includes("rawPrompt"), false);
  assert.equal(serialized.includes("worker-three"), true);
  for (const lease of leases) {
    assert.equal(serialized.includes(`\"${lease.fencingTokenHash}\"`), true);
  }
  assert.equal(receipts.every((row) => !row.containsForumText), true);
  assert.equal(receipts.every((row) => !row.containsIdentity), true);
  assert.equal(verifications.every((row) => !row.containsForumText), true);
  assert.equal(verifications.every((row) => !row.containsIdentity), true);

  const foreignKeyFailures = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "PRAGMA foreign_key_check"
  );
  assert.deepEqual(foreignKeyFailures, []);
});
