import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  dispatchConfiguredAutopilotCanary,
  parseAutonomyWorkerArgs
} from "../../scripts/autonomy-worker";
import {
  AUTONOMY_WORKER_SCHEMA_VERSION,
  autonomyWorkerExitCode,
  type AutopilotCanaryDispatchInput,
  type AutonomyWorkerSummary
} from "../../lib/autonomy/worker";

const require = createRequire(import.meta.url);

function isolatedTestEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: "file:./test.db",
    CMOOC_DISABLE_WINDOWS_ENV_FALLBACK: "1"
  };
  for (const name of [
    "CMOOC_SATOKEN",
    "CMOOC_PARTNER_ACCOUNT",
    "CMOOC_PARTNER_PASSWORD",
    "CMOOC_PARTNER_ACCOUNTS"
  ]) {
    delete env[name];
  }
  return env;
}

function summaryFor(
  status: AutonomyWorkerSummary["status"]
): AutonomyWorkerSummary {
  return {
    schemaVersion: AUTONOMY_WORKER_SCHEMA_VERSION,
    status,
    reasonCode:
      status === "completed"
        ? "worker_cycle_completed"
        : status === "attention"
          ? "worker_cycle_attention"
          : "worker_cycle_failed",
    counts: {
      recovered: 0,
      recoveryFailed: 0,
      remainingExpired: 0,
      due: 0,
      dueQueryFailed: 0,
      governanceFiltered: 0,
      considered: 0,
      executed: 0,
      skipped: 0,
      failed: 0,
      reconciled: 0,
      reconcileFailed: 0
    },
    tasks: [],
    sourceTruncated: false,
    containsForumText: false
  };
}

function runWorkerCli(args: string[]) {
  return spawnSync(
    process.execPath,
    [require.resolve("tsx/cli"), "scripts/autonomy-worker.ts", ...args],
    {
      cwd: process.cwd(),
      env: isolatedTestEnv(),
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true
    }
  );
}

function assertSafeCliFailure(result: ReturnType<typeof runWorkerCli>): void {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  const serialized = result.stdout.trim();
  assert.notEqual(serialized, "");
  const payload = JSON.parse(serialized) as Record<string, unknown>;
  assert.equal(payload.schemaVersion, AUTONOMY_WORKER_SCHEMA_VERSION);
  assert.equal(payload.status, "failed");
  assert.equal(payload.reasonCode, "worker_cycle_failed");
  assert.equal(payload.containsForumText, false);
  assert.deepEqual(payload.tasks, []);
  assert.doesNotMatch(
    serialized,
    /https?:\/\/|permitKey|contentHash|targetHash|CMOOC_SATOKEN|PARTNER_PASSWORD|auth-state|sensitive/i
  );
}

function dispatchInput(
  decisions: Array<{ id: string }>,
  capture?: (query: unknown) => void
): AutopilotCanaryDispatchInput {
  const fakePrisma = {
    autonomyDecision: {
      findMany: async (query: unknown) => {
        capture?.(query);
        return decisions;
      }
    }
  } as unknown as PrismaClient;
  return {
    prisma: fakePrisma,
    invocationId: "invocation-1",
    courseAlias: "course-1",
    governanceHash: "a".repeat(64),
    scheduledFor: "2026-08-30T08:00:00.000Z",
    now: new Date("2026-08-30T08:00:01.000Z"),
    containsForumText: false
  };
}

test("autonomy worker CLI unknown argument returns safe JSON and exit 1", () => {
  assertSafeCliFailure(runWorkerCli(["--unknown-argument"]));
});

test("autopilot canary CLI option is default-off and accepts only a safe version", () => {
  assert.deepEqual(parseAutonomyWorkerArgs([]), {
    limit: 1,
    wakeSource: undefined,
    runtimeVersion: undefined,
    autopilotCanaryPolicyVersion: undefined
  });
  assert.deepEqual(
    parseAutonomyWorkerArgs([
      "--autopilot-canary-policy-version",
      "canary.auto.v1"
    ]),
    {
      limit: 1,
      wakeSource: undefined,
      runtimeVersion: undefined,
      autopilotCanaryPolicyVersion: "canary.auto.v1"
    }
  );
  assert.throws(
    () =>
      parseAutonomyWorkerArgs([
        "--autopilot-canary-policy-version"
      ]),
    /AUTONOMY_WORKER_AUTOPILOT_CANARY_POLICY_VERSION_REQUIRED/u
  );
  assert.throws(
    () =>
      parseAutonomyWorkerArgs([
        "--autopilot-canary-policy-version",
        "../unsafe-version"
      ]),
    /AUTONOMY_WORKER_AUTOPILOT_CANARY_POLICY_VERSION_INVALID/u
  );
});

test("autopilot canary CLI missing or invalid value returns only safe failure JSON", () => {
  assertSafeCliFailure(
    runWorkerCli(["--autopilot-canary-policy-version"])
  );
  assertSafeCliFailure(
    runWorkerCli([
      "--autopilot-canary-policy-version",
      "../unsafe-version"
    ])
  );
});

test("configured canary dispatcher queries at most two exact eligible decisions", async () => {
  let capturedQuery: unknown;
  let runnerInput: Record<string, unknown> | undefined;
  const result = await dispatchConfiguredAutopilotCanary(
    dispatchInput([{ id: "decision-1" }], (query) => {
      capturedQuery = query;
    }),
    "canary.auto.v1",
    async (input) => {
      runnerInput = input as unknown as Record<string, unknown>;
      return {
        schemaVersion: "cmooc.autopilot-canary-execution-summary.v1",
        courseAlias: input.courseAlias,
        invocationId: input.invocationId,
        decisionId: input.decisionId,
        executionPolicyVersion: input.executionPolicyVersion,
        attemptId: "attempt-1",
        terminalReceiptHash: "b".repeat(64),
        state: "completed_no_write",
        recoveredFrom: "none",
        idempotent: false,
        requestedMutationCount: 0,
        sentMutationCount: 0,
        publishAttempted: false,
        realPublishEnabled: false,
        bodyPersisted: false,
        containsForumText: false
      };
    }
  );

  assert.deepEqual(capturedQuery, {
    where: {
      invocationId: "invocation-1",
      courseAlias: "course-1",
      decision: "draft",
      decisionMode: "DRAFT_ELIGIBLE",
      reasonCode: "draft_eligible",
      governanceHash: "a".repeat(64),
      policyVersion: "canary.auto.v1",
      bodyPersisted: false,
      publishAttempted: false,
      editorWriteAttempted: false
    },
    orderBy: { id: "asc" },
    select: { id: true },
    take: 2
  });
  assert.equal(runnerInput?.decisionId, "decision-1");
  assert.equal(runnerInput?.executionPolicyVersion, "canary.auto.v1");
  assert.deepEqual(result, {
    status: "dispatched",
    reasonCode: "completed_no_write",
    containsForumText: false
  });
});

test("configured canary dispatcher rejects a terminal summary bound to another invocation", async () => {
  await assert.rejects(
    dispatchConfiguredAutopilotCanary(
      dispatchInput([{ id: "decision-1" }]),
      "canary.auto.v1",
      async (input) => ({
        schemaVersion: "cmooc.autopilot-canary-execution-summary.v1",
        courseAlias: input.courseAlias,
        invocationId: "another-invocation",
        decisionId: input.decisionId,
        executionPolicyVersion: input.executionPolicyVersion,
        attemptId: "attempt-1",
        terminalReceiptHash: "b".repeat(64),
        state: "completed_no_write",
        recoveredFrom: "none",
        idempotent: false,
        requestedMutationCount: 0,
        sentMutationCount: 0,
        publishAttempted: false,
        realPublishEnabled: false,
        bodyPersisted: false,
        containsForumText: false
      })
    ),
    /AUTOPILOT_CANARY_UNSAFE_RESULT/u
  );
});

test("configured canary dispatcher skips zero candidates and rejects ambiguity", async () => {
  assert.deepEqual(
    await dispatchConfiguredAutopilotCanary(
      dispatchInput([]),
      "canary.auto.v1"
    ),
    {
      status: "skipped",
      reasonCode: "no_eligible_decision",
      containsForumText: false
    }
  );
  await assert.rejects(
    dispatchConfiguredAutopilotCanary(
      dispatchInput([{ id: "decision-1" }, { id: "decision-2" }]),
      "canary.auto.v1"
    ),
    /AUTOPILOT_CANARY_DECISION_AMBIGUOUS/u
  );
});

test("autonomy worker status maps to stable scheduler exit codes", () => {
  assert.equal(autonomyWorkerExitCode(summaryFor("completed")), 0);
  assert.equal(autonomyWorkerExitCode(summaryFor("attention")), 2);
  assert.equal(autonomyWorkerExitCode(summaryFor("failed")), 1);
});
