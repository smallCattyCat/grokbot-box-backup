import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { hashCourseToolValue } from "../../lib/course-tools/contracts";
import { COURSE_TOOL_POLICY_VERSION } from "../../lib/course-tools/policy-gateway";
import {
  COURSE_AGENT_OBJECTIVE_CLASSIFIER_VERSION,
  COURSE_AGENT_PLAN_COMPILER_VERSION
} from "../../lib/workbench/course-agent-plan";
import { deriveVerifiedCourseAgentCheckpoint } from "../../lib/workbench/course-agent-checkpoint-read-model";
import { createSafeTaskObjective } from "../../lib/workbench/durable-ledger";
import { createPlanRevision } from "../../lib/workbench/plan-store";

const require = createRequire(import.meta.url);
const testRoot = mkdtempSync(path.join(tmpdir(), "cmooc-checkpoint-read-model-"));
const databasePath = path.join(testRoot, "checkpoint.db").replace(/\\/gu, "/");
const databaseUrl = `file:${databasePath}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const taskId = "task-checkpoint-integration";
const runId = "run-checkpoint-integration";
const planId = "plan-checkpoint-integration";
const t0 = new Date("2026-08-13T18:00:00.000Z");
const readAt = new Date("2026-08-13T20:00:00.000Z");

const tools = [
  ["course.context.resolve", "read", "L0_READ"],
  ["course.snapshot.read", "read", "L0_READ"],
  ["opportunity.list", "read", "L0_READ"],
  ["opportunity.select_support_gap", "pure", "L0_READ"],
  ["evidence.read_opportunity", "read", "L0_READ"],
  ["evidence.verify_integrity", "read", "L0_READ"],
  ["facilitation.intent.compose", "local_write", "L1_ARTIFACT"],
  ["artifact.reply_draft.create", "local_write", "L1_ARTIFACT"],
  ["platform.target.preflight_read", "read", "L0_READ"],
  ["platform.editor.stage_verify_clear", "external_stage", "L3_EXTERNAL_STAGE"],
  ["delivery.bundle.create", "local_write", "L1_ARTIFACT"]
] as const;

function hash(label: string): string {
  return hashCourseToolValue("test.course-agent-checkpoint.integration", label);
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
  assert.equal(migrated.status, 0, `${migrated.stdout ?? ""}\n${migrated.stderr ?? ""}`);
  await prisma.$connect();
  await prisma.workbenchTask.create({
    data: { id: taskId, title: "安全 checkpoint 集成测试", status: "running", createdAt: t0 }
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
  const objectiveHash = hash("objective");
  await createSafeTaskObjective(prisma, {
    id: "objective-checkpoint-integration",
    taskId,
    objectiveHash,
    safeSummary: "读取精确课程证据并形成可核验的安全成果。",
    structuredGoal: {
      goalCode: "course_evidence_support_gap",
      courseAlias: "bnu-test",
      contextRefs: ["context:safe-checkpoint-integration"],
      requestedArtifactKinds: ["facilitation_draft", "delivery_bundle"],
      constraints: ["no_forum_text_persistence", "no_real_publish"],
      capabilityCeiling: "L1_ARTIFACT",
      policyVersion: COURSE_TOOL_POLICY_VERSION
    },
    source: COURSE_AGENT_OBJECTIVE_CLASSIFIER_VERSION,
    createdAt: t0,
    expiresAt: new Date("2026-08-14T20:00:00.000Z")
  });
  await createPlanRevision(prisma, {
    id: planId,
    taskId,
    runId,
    revision: 1,
    objectiveHash,
    compilerVersion: COURSE_AGENT_PLAN_COMPILER_VERSION,
    safeSummary: "读取、核验、生成、暂存核对并交付零发布成果。",
    createdAt: new Date("2026-08-13T18:10:00.000Z"),
    steps: tools.map(([toolName, effectClass, requiredCapability], index) => ({
      id: `step-checkpoint-${index + 1}`,
      ordinal: index + 1,
      toolName,
      toolVersion: "1",
      dependencyIds: index === 0 ? [] : [`step-checkpoint-${index}`],
      inputRefs: [{ kind: "safe_ref", ref: `checkpoint-input-${index + 1}` }],
      preconditions: [],
      postconditions: [{ code: "verified", required: true }],
      effectClass,
      requiredCapability,
      acceptance: { code: "verified" },
      replanPolicy: { on: "failed_or_unknown", action: "stop_and_replan" },
      safeSummary: `安全步骤 ${index + 1}。`
    }))
  });
});

after(async () => {
  await prisma.$disconnect();
  rmSync(testRoot, { recursive: true, force: true });
});

test("derives a stable fail-closed checkpoint from migrated canonical tables", async () => {
  const first = await deriveVerifiedCourseAgentCheckpoint(prisma, {
    taskId,
    runId,
    now: readAt
  });
  const later = await deriveVerifiedCourseAgentCheckpoint(prisma, {
    taskId,
    runId,
    now: new Date("2026-08-13T20:30:00.000Z")
  });
  assert.equal(first.state, "evidence_replay_required");
  assert.equal(first.reasonCode, "verified_composition_absent");
  assert.equal(first.planRef, planId);
  assert.equal(first.checkpointHash, later.checkpointHash);
  assert.equal(first.checkpointRef, later.checkpointRef);
  assert.notEqual(first.derivedAt, later.derivedAt);
  assert.equal(JSON.stringify(first).includes("metadata"), false);
  await assert.rejects(
    deriveVerifiedCourseAgentCheckpoint(prisma, {
      taskId: "task-cross-run",
      runId,
      now: readAt
    }),
    /COURSE_AGENT_CHECKPOINT_SCOPE_MISMATCH/u
  );
});
