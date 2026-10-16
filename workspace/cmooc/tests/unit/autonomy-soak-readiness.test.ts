import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTONOMY_SOAK_READINESS_SCHEMA_VERSION,
  DEFAULT_AUTONOMY_SOAK_READINESS_PROFILE,
  evaluateAutonomySoakReadiness,
  type WorkerWakeScopedSoakStatsInput
} from "../../lib/autonomy/soak-readiness";
import {
  AUTONOMY_WORKER_WAKE_RECEIPT_SCHEMA_VERSION
} from "../../lib/autonomy/worker-wake-receipt";
import { AUTONOMY_WORKER_SCHEMA_VERSION } from "../../lib/autonomy/worker";

const AS_OF = "2026-08-23T12:00:00.000Z";
const HOUR_MS = 60 * 60_000;

type ReadinessInput = Parameters<
  typeof evaluateAutonomySoakReadiness
>[0];

function aggregate(
  overrides: Partial<WorkerWakeScopedSoakStatsInput["aggregate"]> = {}
): WorkerWakeScopedSoakStatsInput["aggregate"] {
  return {
    recovered: 0,
    recoveryFailed: 0,
    remainingExpired: 0,
    due: 145,
    dueQueryFailed: 0,
    considered: 145,
    executed: 145,
    skipped: 0,
    failed: 0,
    reconciled: 145,
    reconcileFailed: 0,
    governanceFiltered: 0,
    ...overrides
  };
}

function qualifiedScope(
  overrides: Partial<WorkerWakeScopedSoakStatsInput> = {}
): WorkerWakeScopedSoakStatsInput {
  const scope: WorkerWakeScopedSoakStatsInput = {
    source: "codex_automation",
    runtimeVersion: "v1-rc13",
    count: 145,
    statusCounts: {
      running: 0,
      completed: 145,
      attention: 0,
      failed: 0,
      abandoned: 0
    },
    terminalCount: 145,
    completedCount: 145,
    consecutiveCompletedCount: 145,
    runningCount: 0,
    staleRunningCount: 0,
    firstStartedAt: new Date(
      Date.parse(AS_OF) - 72 * HOUR_MS
    ).toISOString(),
    lastStartedAt: AS_OF,
    maxAdjacentGapMs: 30 * 60_000,
    aggregate: aggregate(),
    invariants: {
      zeroEditorWriteCount: true,
      zeroPublishAttemptCount: true,
      realPublishDisabled: true,
      noForumText: true
    },
    receiptContractValid: true
  };
  return {
    ...scope,
    ...overrides,
    statusCounts: overrides.statusCounts ?? scope.statusCounts,
    aggregate: overrides.aggregate ?? scope.aggregate,
    invariants: overrides.invariants ?? scope.invariants
  };
}

function summary(
  scopedStats: readonly WorkerWakeScopedSoakStatsInput[],
  overrides: Record<string, unknown> = {}
): ReadinessInput["summary"] {
  const value = {
    schemaVersion: AUTONOMY_WORKER_WAKE_RECEIPT_SCHEMA_VERSION,
    asOf: AS_OF,
    lookbackMs: 7 * 24 * HOUR_MS,
    lookbackStartedAt: new Date(
      Date.parse(AS_OF) - 7 * 24 * HOUR_MS
    ).toISOString(),
    totalReceipts: scopedStats.reduce(
      (total, item) => total + item.count,
      0
    ),
    sourceCounts: {
      codex_automation: 0,
      local_cli: 0,
      test: 0
    },
    statusCounts: {
      running: 0,
      completed: 0,
      attention: 0,
      failed: 0,
      abandoned: 0
    },
    terminalCount: 0,
    completedCount: 0,
    consecutiveTerminalCount: 0,
    consecutiveCompletedCount: 0,
    runningCount: 0,
    staleRunningCount: 0,
    firstStartedAt: null,
    lastStartedAt: null,
    maxAdjacentGapMs: null,
    sourceStats: {
      codex_automation: {
        count: 0,
        firstStartedAt: null,
        lastStartedAt: null,
        maxAdjacentGapMs: null
      },
      local_cli: {
        count: 0,
        firstStartedAt: null,
        lastStartedAt: null,
        maxAdjacentGapMs: null
      },
      test: {
        count: 0,
        firstStartedAt: null,
        lastStartedAt: null,
        maxAdjacentGapMs: null
      }
    },
    runtimeVersionCounts: {},
    aggregate: {
      recovered: 0,
      recoveryFailed: 0,
      remainingExpired: 0,
      due: 0,
      dueQueryFailed: 0,
      considered: 0,
      executed: 0,
      skipped: 0,
      failed: 0,
      reconciled: 0,
      reconcileFailed: 0
    },
    invariants: {
      zeroEditorWriteCount: true,
      zeroPublishAttemptCount: true,
      realPublishDisabled: true,
      noForumText: true
    },
    evidenceHash: "a".repeat(64),
    containsForumText: false,
    scopedStats,
    receiptContractValid: true,
    ...overrides
  };
  return value as unknown as ReadinessInput["summary"];
}

function evaluate(input: {
  scopedStats?: readonly WorkerWakeScopedSoakStatsInput[];
  summaryOverrides?: Record<string, unknown>;
  expiredLeaseCount?: number;
  unresolvedHighIncidentCount?: number;
} = {}) {
  return evaluateAutonomySoakReadiness({
    summary: summary(
      input.scopedStats ?? [qualifiedScope()],
      input.summaryOverrides
    ),
    expiredLeaseCount: input.expiredLeaseCount ?? 0,
    unresolvedHighIncidentCount: input.unresolvedHighIncidentCount ?? 0
  });
}

function check(
  result: ReturnType<typeof evaluateAutonomySoakReadiness>,
  id: ReturnType<typeof evaluateAutonomySoakReadiness>["checks"][number]["id"]
) {
  const found = result.checks.find((item) => item.id === id);
  assert.ok(found, `missing check: ${id}`);
  return found;
}

test("默认 RC13 profile 精确绑定 v2 契约和 72 小时 cadence", () => {
  assert.equal(
    AUTONOMY_WORKER_SCHEMA_VERSION,
    "cmooc.autonomy-worker-once.v2"
  );
  assert.equal(
    AUTONOMY_WORKER_WAKE_RECEIPT_SCHEMA_VERSION,
    "cmooc.autonomy-worker-wake-receipt.v2"
  );
  assert.deepEqual(DEFAULT_AUTONOMY_SOAK_READINESS_PROFILE, {
    source: "codex_automation",
    runtimeVersion: "v1-rc13",
    minimumSpanMs: 72 * HOUR_MS,
    cadenceMs: 30 * 60_000,
    minimumCompletedCycles: 144,
    maxWakeAgeMs: 60 * 60_000,
    maxAdjacentGapMs: 65 * 60_000
  });
  const result = evaluate();
  assert.equal(result.schemaVersion, AUTONOMY_SOAK_READINESS_SCHEMA_VERSION);
  assert.equal(result.status, "qualified");
  assert.equal(result.qualificationScope, "local_runtime_evidence_only");
  assert.equal(result.matureV1Eligible, false);
  assert.deepEqual(result.externalChecks, {
    failedOnlyDelivery: "unknown",
    successUiSuppression: "unknown"
  });
  assert.equal(result.requestedMutationCount, 0);
  assert.equal(result.sentMutationCount, 0);
  assert.equal(result.realPublishEnabled, false);
  assert.equal(result.externalWriteAttempted, false);
  assert.equal(result.containsForumText, false);
  assert.equal(check(result, "minimum_observation_span_ms").status, "passed");
  assert.equal(check(result, "minimum_completed_cycles").status, "passed");
});

test("零目标样本保持 unknown，历史 RC12 绿色证据不能冒充 RC13", () => {
  const wrongRuntime = qualifiedScope({
    runtimeVersion: "v1-rc12"
  });
  const wrongSource = qualifiedScope({
    source: "local_cli"
  });
  const result = evaluate({
    scopedStats: [wrongRuntime, wrongSource]
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.evidence.wakeCount, null);
  assert.equal(check(result, "scoped_receipt_count").status, "unknown");
  assert.equal(check(result, "receipt_contract_valid").status, "unknown");
  assert.notEqual(result.status, "qualified");
});

test("同 source/runtime 内 span 或连续周期不足时只能 qualifying", () => {
  const shortScope = qualifiedScope({
    count: 143,
    statusCounts: {
      running: 0,
      completed: 143,
      attention: 0,
      failed: 0,
      abandoned: 0
    },
    terminalCount: 143,
    completedCount: 143,
    consecutiveCompletedCount: 143,
    firstStartedAt: new Date(
      Date.parse(AS_OF) - 71 * HOUR_MS
    ).toISOString(),
    aggregate: aggregate({
      due: 143,
      considered: 143,
      executed: 143,
      reconciled: 143
    })
  });
  const result = evaluate({ scopedStats: [shortScope] });
  assert.equal(result.status, "qualifying");
  assert.equal(
    check(result, "minimum_observation_span_ms").status,
    "pending"
  );
  assert.equal(
    check(result, "minimum_completed_cycles").status,
    "pending"
  );
  assert.equal(
    check(result, "minimum_consecutive_completed_cycles").status,
    "pending"
  );
});

test("资格只读目标 scoped evidence，不受其他 source/runtime 故障污染", () => {
  const baseline = evaluate();
  const unrelatedFailure = qualifiedScope({
    source: "local_cli",
    runtimeVersion: "v1-rc12",
    count: 1,
    statusCounts: {
      running: 0,
      completed: 0,
      attention: 0,
      failed: 1,
      abandoned: 0
    },
    terminalCount: 1,
    completedCount: 0,
    consecutiveCompletedCount: 0,
    firstStartedAt: AS_OF,
    lastStartedAt: AS_OF,
    maxAdjacentGapMs: null,
    aggregate: aggregate({ failed: 1, governanceFiltered: 1 }),
    invariants: {
      zeroEditorWriteCount: false,
      zeroPublishAttemptCount: false,
      realPublishDisabled: false,
      noForumText: false
    },
    receiptContractValid: false
  });
  const isolated = evaluate({
    scopedStats: [qualifiedScope(), unrelatedFailure],
    summaryOverrides: {
      receiptContractValid: false,
      evidenceHash: "b".repeat(64),
      statusCounts: {
        running: 0,
        completed: 145,
        attention: 0,
        failed: 1,
        abandoned: 0
      }
    }
  });
  assert.deepEqual(isolated, baseline);
});

test("wake 状态、stale、freshness、gap 与契约/安全异常均阻断", async (t) => {
  const statusCases = ["attention", "failed", "abandoned"] as const;
  for (const wakeStatus of statusCases) {
    await t.test(wakeStatus, () => {
      const statusCounts = {
        running: 0,
        completed: 144,
        attention: 0,
        failed: 0,
        abandoned: 0,
        [wakeStatus]: 1
      };
      const result = evaluate({
        scopedStats: [
          qualifiedScope({
            statusCounts,
            completedCount: 144,
            consecutiveCompletedCount: 144
          })
        ]
      });
      assert.equal(result.status, "blocked");
      assert.equal(check(result, `wake_${wakeStatus}_count`).status, "failed");
    });
  }

  const cases: Array<{
    name: string;
    id: ReturnType<typeof evaluate>["checks"][number]["id"];
    scope: WorkerWakeScopedSoakStatsInput;
  }> = [
    {
      name: "stale running",
      id: "stale_running_count",
      scope: qualifiedScope({
        statusCounts: {
          running: 1,
          completed: 144,
          attention: 0,
          failed: 0,
          abandoned: 0
        },
        terminalCount: 144,
        completedCount: 144,
        consecutiveCompletedCount: 144,
        runningCount: 1,
        staleRunningCount: 1
      })
    },
    {
      name: "expired last wake",
      id: "last_wake_age_ms",
      scope: qualifiedScope({
        firstStartedAt: new Date(
          Date.parse(AS_OF) - 73 * HOUR_MS
        ).toISOString(),
        lastStartedAt: new Date(
          Date.parse(AS_OF) - 61 * 60_000
        ).toISOString()
      })
    },
    {
      name: "cadence gap",
      id: "max_adjacent_gap_ms",
      scope: qualifiedScope({ maxAdjacentGapMs: 65 * 60_000 + 1 })
    },
    {
      name: "receipt contract",
      id: "receipt_contract_valid",
      scope: qualifiedScope({ receiptContractValid: false })
    },
    {
      name: "editor write invariant",
      id: "zero_editor_writes",
      scope: qualifiedScope({
        invariants: {
          ...qualifiedScope().invariants,
          zeroEditorWriteCount: false
        }
      })
    },
    {
      name: "publish invariant",
      id: "zero_publish_attempts",
      scope: qualifiedScope({
        invariants: {
          ...qualifiedScope().invariants,
          zeroPublishAttemptCount: false
        }
      })
    },
    {
      name: "publish lock invariant",
      id: "real_publish_disabled",
      scope: qualifiedScope({
        invariants: {
          ...qualifiedScope().invariants,
          realPublishDisabled: false
        }
      })
    },
    {
      name: "forum text invariant",
      id: "no_forum_text",
      scope: qualifiedScope({
        invariants: {
          ...qualifiedScope().invariants,
          noForumText: false
        }
      })
    }
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const result = evaluate({ scopedStats: [item.scope] });
      assert.equal(result.status, "blocked");
      assert.equal(check(result, item.id).status, "failed");
    });
  }
});

test("worker 失败、过期、reconcile、治理过滤、lease 和高危 incident 均阻断", async (t) => {
  const aggregateCases: Array<{
    field: keyof WorkerWakeScopedSoakStatsInput["aggregate"];
    id: ReturnType<typeof evaluate>["checks"][number]["id"];
  }> = [
    { field: "failed", id: "worker_failure_count" },
    { field: "recoveryFailed", id: "recovery_failure_count" },
    { field: "dueQueryFailed", id: "due_query_failure_count" },
    { field: "remainingExpired", id: "remaining_expired_count" },
    { field: "reconcileFailed", id: "reconcile_failure_count" },
    { field: "governanceFiltered", id: "governance_filtered_count" }
  ];
  for (const item of aggregateCases) {
    await t.test(item.field, () => {
      const result = evaluate({
        scopedStats: [
          qualifiedScope({ aggregate: aggregate({ [item.field]: 1 }) })
        ]
      });
      assert.equal(result.status, "blocked");
      assert.equal(check(result, item.id).status, "failed");
    });
  }
  await t.test("expired lease", () => {
    const result = evaluate({ expiredLeaseCount: 1 });
    assert.equal(result.status, "blocked");
    assert.equal(check(result, "expired_lease_count").status, "failed");
  });
  await t.test("unresolved high incident", () => {
    const result = evaluate({ unresolvedHighIncidentCount: 1 });
    assert.equal(result.status, "blocked");
    assert.equal(
      check(result, "unresolved_high_incident_count").status,
      "failed"
    );
  });
});

test("receipt hash 确定且输出不复制输入正文或身份字段", () => {
  const inputSummary = summary([qualifiedScope()]) as ReadinessInput["summary"] &
    Record<string, unknown>;
  inputSummary.forumBody = "SHOULD_NEVER_APPEAR";
  inputSummary.author = "SHOULD_NEVER_APPEAR";
  inputSummary.url = "https://example.invalid/private";
  const first = evaluateAutonomySoakReadiness({
    summary: inputSummary,
    expiredLeaseCount: 0,
    unresolvedHighIncidentCount: 0
  });
  const second = evaluateAutonomySoakReadiness({
    summary: inputSummary,
    expiredLeaseCount: 0,
    unresolvedHighIncidentCount: 0
  });
  assert.deepEqual(first, second);
  assert.match(first.evidenceHash, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /SHOULD_NEVER_APPEAR/u);
  assert.doesNotMatch(
    serialized,
    /"(?:body|content|title|author|url|cookie|token|password)"\s*:/iu
  );
});
