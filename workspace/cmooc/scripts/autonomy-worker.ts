import { prisma } from "@/lib/db";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  AUTOPILOT_CANARY_EXECUTION_SUMMARY_SCHEMA_VERSION,
  runAutopilotCanaryExecution,
  type AutopilotCanaryExecutionSummary
} from "@/lib/autonomy/autopilot-canary-execution";
import {
  AUTONOMY_WORKER_SCHEMA_VERSION,
  autonomyWorkerExitCode,
  runAutonomyWorkerOnce,
  type AutopilotCanaryDispatchInput,
  type AutopilotCanaryDispatchResult,
  type AutonomyWorkerSummary
} from "@/lib/autonomy/worker";
import {
  finishWorkerWakeReceipt,
  startWorkerWakeReceipt,
  type WorkerWakeReceiptHandle
} from "@/lib/autonomy/worker-wake-receipt";

type CliArgs = {
  limit: number;
  wakeSource?: string;
  runtimeVersion?: string;
  autopilotCanaryPolicyVersion?: string;
};

const SAFE_POLICY_VERSION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SAFE_RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,191}$/u;
const SAFE_HASH_PATTERN = /^[a-f0-9]{64}$/u;

type CanaryRunner = typeof runAutopilotCanaryExecution;

export function parseAutonomyWorkerArgs(argv: string[]): CliArgs {
  let limit = 1;
  let wakeSource: string | undefined;
  let runtimeVersion: string | undefined;
  let autopilotCanaryPolicyVersion: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--limit") {
      if (value === undefined) {
        throw new Error("AUTONOMY_WORKER_LIMIT_REQUIRED");
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error("AUTONOMY_WORKER_LIMIT_INVALID");
      }
      limit = parsed;
      index += 1;
      continue;
    }
    if (arg === "--wake-source") {
      if (value === undefined) {
        throw new Error("AUTONOMY_WORKER_WAKE_SOURCE_REQUIRED");
      }
      wakeSource = value;
      index += 1;
      continue;
    }
    if (arg === "--runtime-version") {
      if (value === undefined) {
        throw new Error("AUTONOMY_WORKER_RUNTIME_VERSION_REQUIRED");
      }
      runtimeVersion = value;
      index += 1;
      continue;
    }
    if (arg === "--autopilot-canary-policy-version") {
      if (value === undefined) {
        throw new Error(
          "AUTONOMY_WORKER_AUTOPILOT_CANARY_POLICY_VERSION_REQUIRED"
        );
      }
      if (!SAFE_POLICY_VERSION_PATTERN.test(value)) {
        throw new Error(
          "AUTONOMY_WORKER_AUTOPILOT_CANARY_POLICY_VERSION_INVALID"
        );
      }
      autopilotCanaryPolicyVersion = value;
      index += 1;
      continue;
    }
    throw new Error("AUTONOMY_WORKER_UNKNOWN_ARGUMENT");
  }
  return {
    limit,
    wakeSource,
    runtimeVersion,
    autopilotCanaryPolicyVersion
  };
}

function assertCompletedNoWriteCanary(
  summary: AutopilotCanaryExecutionSummary,
  expected: {
    courseAlias: string;
    invocationId: string;
    decisionId: string;
    executionPolicyVersion: string;
  }
): void {
  if (
    summary.schemaVersion !==
      AUTOPILOT_CANARY_EXECUTION_SUMMARY_SCHEMA_VERSION ||
    summary.courseAlias !== expected.courseAlias ||
    summary.invocationId !== expected.invocationId ||
    summary.decisionId !== expected.decisionId ||
    summary.executionPolicyVersion !==
      expected.executionPolicyVersion ||
    !SAFE_RECORD_ID_PATTERN.test(summary.attemptId) ||
    !SAFE_HASH_PATTERN.test(summary.terminalReceiptHash) ||
    summary.state !== "completed_no_write" ||
    summary.requestedMutationCount !== 0 ||
    summary.sentMutationCount !== 0 ||
    summary.publishAttempted !== false ||
    summary.realPublishEnabled !== false ||
    summary.bodyPersisted !== false ||
    summary.containsForumText !== false
  ) {
    throw new Error("AUTOPILOT_CANARY_UNSAFE_RESULT");
  }
}

export async function dispatchConfiguredAutopilotCanary(
  input: AutopilotCanaryDispatchInput,
  executionPolicyVersion: string,
  runCanary: CanaryRunner = runAutopilotCanaryExecution
): Promise<AutopilotCanaryDispatchResult> {
  if (!SAFE_POLICY_VERSION_PATTERN.test(executionPolicyVersion)) {
    throw new Error("AUTOPILOT_CANARY_POLICY_VERSION_INVALID");
  }
  const decisions = await input.prisma.autonomyDecision.findMany({
    where: {
      invocationId: input.invocationId,
      courseAlias: input.courseAlias,
      decision: "draft",
      decisionMode: "DRAFT_ELIGIBLE",
      reasonCode: "draft_eligible",
      governanceHash: input.governanceHash,
      policyVersion: executionPolicyVersion,
      bodyPersisted: false,
      publishAttempted: false,
      editorWriteAttempted: false
    },
    orderBy: { id: "asc" },
    select: { id: true },
    take: 2
  });
  if (decisions.length === 0) {
    return {
      status: "skipped",
      reasonCode: "no_eligible_decision",
      containsForumText: false
    };
  }
  if (decisions.length !== 1) {
    throw new Error("AUTOPILOT_CANARY_DECISION_AMBIGUOUS");
  }
  const summary = await runCanary({
    prisma: input.prisma,
    courseAlias: input.courseAlias,
    invocationId: input.invocationId,
    decisionId: decisions[0].id,
    executionPolicyVersion,
    now: input.now
  });
  assertCompletedNoWriteCanary(summary, {
    courseAlias: input.courseAlias,
    invocationId: input.invocationId,
    decisionId: decisions[0].id,
    executionPolicyVersion
  });
  return {
    status: "dispatched",
    reasonCode: "completed_no_write",
    containsForumText: false
  };
}

function safeFailure(): AutonomyWorkerSummary {
  return {
    schemaVersion: AUTONOMY_WORKER_SCHEMA_VERSION,
    status: "failed",
    reasonCode: "worker_cycle_failed",
    counts: {
      recovered: 0,
      recoveryFailed: 1,
      remainingExpired: 0,
      due: 0,
      dueQueryFailed: 1,
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

async function main(): Promise<void> {
  let summary: AutonomyWorkerSummary = safeFailure();
  let wakeReceipt: WorkerWakeReceiptHandle | null = null;
  try {
    const args = parseAutonomyWorkerArgs(process.argv.slice(2));
    wakeReceipt = await startWorkerWakeReceipt({
      prisma,
      source: args.wakeSource,
      runtimeVersion: args.runtimeVersion
    });
    const workerInput = { limit: args.limit };
    const completed =
      args.autopilotCanaryPolicyVersion === undefined
        ? await runAutonomyWorkerOnce(workerInput)
        : await runAutonomyWorkerOnce(workerInput, {
            prisma,
            dispatchAutopilotCanary: (input) =>
              dispatchConfiguredAutopilotCanary(
                input,
                args.autopilotCanaryPolicyVersion!
              )
          });
    summary = completed;
  } catch {
    summary = safeFailure();
  }
  if (wakeReceipt) {
    try {
      await finishWorkerWakeReceipt({
        prisma,
        receiptId: wakeReceipt.id,
        summary
      });
    } catch {
      // A malformed or raced worker result must not be emitted as a success.
      // Retry with the fixed, redacted failure envelope so a valid wake can
      // still reach a terminal receipt when the first finish was rejected.
      summary = safeFailure();
      try {
        await finishWorkerWakeReceipt({
          prisma,
          receiptId: wakeReceipt.id,
          summary
        });
      } catch {
        // The receipt helper's CAS remains fail-closed; the next wake can
        // abandon a genuinely stale running row.
      }
    }
  }
  process.exitCode = autonomyWorkerExitCode(summary);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

const invokedPath = process.argv[1];
const isDirectInvocation =
  invokedPath !== undefined &&
  path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectInvocation) {
  void main().finally(async () => {
    await prisma.$disconnect();
  });
}
