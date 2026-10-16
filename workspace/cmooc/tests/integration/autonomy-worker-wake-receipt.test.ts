import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AUTONOMY_WORKER_SCHEMA_VERSION,
  type AutonomyWorkerSummary
} from "../../lib/autonomy/worker";
import {
  abandonStaleWorkerWakeReceipts,
  finishWorkerWakeReceipt,
  startWorkerWakeReceipt,
  summarizeWorkerWakeReceipts
} from "../../lib/autonomy/worker-wake-receipt";

const require = createRequire(import.meta.url);

function summary(
  status: AutonomyWorkerSummary["status"] = "completed",
  overrides: Partial<AutonomyWorkerSummary["counts"]> = {}
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
      reconcileFailed: 0,
      ...overrides
    },
    tasks: [],
    sourceTruncated: false,
    containsForumText: false
  };
}

function testEnv(): NodeJS.ProcessEnv {
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

test("due=0 的唤醒仍持久化并可 CAS 完成", async () => {
  const { prisma } = await import("../../lib/db");
  const now = new Date("2026-08-02T18:00:00.000Z");
  let receiptId = "";
  try {
    const started = await startWorkerWakeReceipt({
      prisma,
      source: "test",
      runtimeVersion: "v1-test",
      now
    });
    receiptId = started.id;
    assert.equal(started.status, "running");
    const running = await prisma.autonomyWorkerWakeReceipt.findUniqueOrThrow({
      where: { id: started.id }
    });
    assert.equal(running.status, "running");
    assert.equal(running.containsForumText, false);
    assert.equal(running.editorWriteCount, 0);
    assert.equal(running.publishAttemptCount, 0);

    const finished = await finishWorkerWakeReceipt({
      prisma,
      receiptId: started.id,
      summary: summary("completed"),
      now: new Date(now.getTime() + 1_000)
    });
    assert.equal(finished.status, "completed");
    assert.equal(finished.exitCode, 0);
    assert.equal(finished.finishedAt?.toISOString(), "2026-08-02T18:00:01.000Z");
  } finally {
    if (receiptId) {
      await prisma.autonomyWorkerWakeReceipt.deleteMany({
        where: { id: receiptId }
      });
    }
    await prisma.$disconnect();
  }
});

test("stale running 唤醒安全 abandoned，重复 finish 产生 CAS 冲突", async () => {
  const { prisma } = await import("../../lib/db");
  const now = new Date("2026-08-02T18:00:00.000Z");
  let receiptId = "";
  let finishedId = "";
  try {
    const stale = await startWorkerWakeReceipt({
      prisma,
      source: "test",
      runtimeVersion: "v1-test",
      now: new Date(now.getTime() - 3 * 60 * 60_000)
    });
    receiptId = stale.id;
    const runningBeforeRecovery = await prisma.autonomyWorkerWakeReceipt.findUniqueOrThrow({
      where: { id: stale.id }
    });
    const recovery = await abandonStaleWorkerWakeReceipts({
      prisma,
      now
    });
    assert.equal(recovery.abandonedCount, 1);
    const abandoned = await prisma.autonomyWorkerWakeReceipt.findUniqueOrThrow({
      where: { id: stale.id }
    });
    assert.equal(abandoned.status, "abandoned");
    assert.notEqual(abandoned.summaryHash, runningBeforeRecovery.summaryHash);
    assert.match(abandoned.summaryHash, /^[a-f0-9]{64}$/);
    await assert.rejects(
      () =>
        finishWorkerWakeReceipt({
          prisma,
          receiptId: stale.id,
          summary: summary(),
          now
        }),
      /AUTONOMY_WAKE_RECEIPT_FINISH_CONFLICT/
    );

    const finished = await startWorkerWakeReceipt({
      prisma,
      source: "test",
      runtimeVersion: "v1-test",
      now
    });
    finishedId = finished.id;
    await finishWorkerWakeReceipt({
      prisma,
      receiptId: finished.id,
      summary: (() => {
        const attention = summary("attention", {
          due: 1,
          considered: 1,
          executed: 1,
          reconcileFailed: 1
        });
        attention.tasks = [
          {
            courseAlias: "safe-course",
            scheduledFor: "2026-08-02T18:00:00.000Z",
            mode: "SHADOW",
            status: "executed",
            reasonCode: "tick_completed_reconcile_failed",
            containsForumText: false
          }
        ];
        return attention;
      })(),
      now: new Date(now.getTime() + 1_000)
    });
    await assert.rejects(
      () =>
        finishWorkerWakeReceipt({
          prisma,
          receiptId: finished.id,
          summary: summary("failed", { failed: 1 }),
          now: new Date(now.getTime() + 2_000)
        }),
      /AUTONOMY_WAKE_RECEIPT_FINISH_CONFLICT/
    );
  } finally {
    await prisma.autonomyWorkerWakeReceipt.deleteMany({
      where: { id: { in: [receiptId, finishedId].filter(Boolean) } }
    });
    await prisma.$disconnect();
  }
});

test("source/runtime/summary 非法或含正文 marker 时 fail closed 且不落库", async () => {
  const { prisma } = await import("../../lib/db");
  const now = new Date("2026-08-02T18:00:00.000Z");
  try {
    await assert.rejects(
      () =>
        startWorkerWakeReceipt({
          prisma,
          source: "https://unsafe.example",
          runtimeVersion: "v1-test",
          now
        }),
      /AUTONOMY_WAKE_RECEIPT_SOURCE_INVALID/
    );
    await assert.rejects(
      () =>
        startWorkerWakeReceipt({
          prisma,
          source: "test",
          runtimeVersion: "https://unsafe.example",
          now
        }),
      /AUTONOMY_WAKE_RECEIPT_RUNTIME_VERSION_INVALID/
    );
    const started = await startWorkerWakeReceipt({
      prisma,
      source: "test",
      runtimeVersion: "v1-test",
      now
    });
    try {
      const legacySchema = {
        ...summary(),
        schemaVersion: "cmooc.autonomy-worker-once.v1"
      } as unknown as AutonomyWorkerSummary;
      await assert.rejects(
        () =>
          finishWorkerWakeReceipt({
            prisma,
            receiptId: started.id,
            summary: legacySchema,
            now: new Date(now.getTime() + 500)
          }),
        /AUTONOMY_WAKE_RECEIPT_SUMMARY_INVALID/
      );
      const unsafe = summary();
      unsafe.tasks = [
        {
          courseAlias: "safe-course",
          scheduledFor: "2026-08-02T18:00:00.000Z",
          mode: "SHADOW",
          status: "failed",
          reasonCode: "https://unsafe.example",
          containsForumText: false
        }
      ];
      await assert.rejects(
        () =>
          finishWorkerWakeReceipt({
            prisma,
            receiptId: started.id,
            summary: unsafe,
            now: new Date(now.getTime() + 1_000)
          }),
        /AUTONOMY_WAKE_RECEIPT_SUMMARY_INVALID/
      );
      const tampered = summary("completed", {
        due: 1,
        considered: 1
      });
      await assert.rejects(
        () =>
          finishWorkerWakeReceipt({
            prisma,
            receiptId: started.id,
            summary: tampered,
            now: new Date(now.getTime() + 2_000)
          }),
        /AUTONOMY_WAKE_RECEIPT_SUMMARY_INVALID/
      );
      const stillRunning = await prisma.autonomyWorkerWakeReceipt.findUniqueOrThrow({
        where: { id: started.id }
      });
      assert.equal(stillRunning.status, "running");
      assert.equal(JSON.stringify(stillRunning).includes("unsafe.example"), false);
    } finally {
      await prisma.autonomyWorkerWakeReceipt.delete({
        where: { id: started.id }
      });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("soak 汇总只输出去正文计数并生成稳定 evidenceHash", async () => {
  const { prisma } = await import("../../lib/db");
  const base = new Date("2026-08-02T18:00:00.000Z");
  const ids: string[] = [];
  try {
    for (const [offsetMinutes, status, counts] of [
      [0, "completed", { due: 0 }],
      [30, "completed", { due: 2, executed: 1 }],
      [90, "failed", { due: 1, failed: 1 }]
    ] as const) {
      const started = await startWorkerWakeReceipt({
        prisma,
        source: "test",
        runtimeVersion: "v1-test",
        now: new Date(base.getTime() + offsetMinutes * 60_000)
      });
      ids.push(started.id);
      const workerSummary = summary(status, counts);
      if (status === "completed" && counts.executed === 1) {
        workerSummary.tasks = [
          {
            courseAlias: "safe-course",
            scheduledFor: "2026-08-02T18:30:00.000Z",
            mode: "SHADOW",
            status: "executed",
            reasonCode: "tick_completed",
            containsForumText: false
          }
        ];
        workerSummary.counts.considered = 1;
      }
      if (status === "failed" && counts.failed === 1) {
        workerSummary.tasks = [
          {
            courseAlias: "safe-course",
            scheduledFor: "2026-08-02T19:30:00.000Z",
            mode: "SHADOW",
            status: "failed",
            reasonCode: "tick_failed",
            containsForumText: false
          }
        ];
        workerSummary.counts.considered = 1;
      }
      await finishWorkerWakeReceipt({
        prisma,
        receiptId: started.id,
        summary: workerSummary,
        now: new Date(base.getTime() + offsetMinutes * 60_000 + 1_000)
      });
    }
    const result = await summarizeWorkerWakeReceipts({
      prisma,
      now: new Date(base.getTime() + 2 * 60 * 60_000),
      lookbackMs: 2 * 60 * 60_000
    });
    assert.equal(result.totalReceipts, 3);
    assert.equal(result.statusCounts.completed, 2);
    assert.equal(result.statusCounts.failed, 1);
    assert.equal(result.terminalCount, 3);
    assert.equal(result.consecutiveTerminalCount, 3);
    assert.equal(result.consecutiveCompletedCount, 0);
    assert.equal(result.runningCount, 0);
    assert.equal(result.staleRunningCount, 0);
    assert.equal(result.maxAdjacentGapMs, 60 * 60_000);
    assert.equal(result.sourceStats.test.count, 3);
    assert.equal(
      result.sourceStats.test.firstStartedAt,
      "2026-08-02T18:00:00.000Z"
    );
    assert.equal(
      result.sourceStats.test.lastStartedAt,
      "2026-08-02T19:30:00.000Z"
    );
    assert.equal(
      result.sourceStats.test.maxAdjacentGapMs,
      60 * 60_000
    );
    assert.equal(result.scopedStats.length, 1);
    assert.deepEqual(
      {
        source: result.scopedStats[0].source,
        runtimeVersion: result.scopedStats[0].runtimeVersion,
        count: result.scopedStats[0].count,
        completedCount: result.scopedStats[0].completedCount,
        consecutiveTerminalCount:
          result.scopedStats[0].consecutiveTerminalCount,
        consecutiveCompletedCount:
          result.scopedStats[0].consecutiveCompletedCount,
        lastStatus: result.scopedStats[0].lastStatus,
        maxAdjacentGapMs: result.scopedStats[0].maxAdjacentGapMs,
        receiptContractValid:
          result.scopedStats[0].receiptContractValid
      },
      {
        source: "test",
        runtimeVersion: "v1-test",
        count: 3,
        completedCount: 2,
        consecutiveTerminalCount: 3,
        consecutiveCompletedCount: 0,
        lastStatus: "failed",
        maxAdjacentGapMs: 60 * 60_000,
        receiptContractValid: true
      }
    );
    assert.equal(result.runtimeVersionCounts["v1-test"], 3);
    assert.equal(result.aggregate.due, 3);
    assert.equal(result.aggregate.executed, 1);
    assert.equal(result.aggregate.failed, 1);
    assert.equal(result.invariants.zeroEditorWriteCount, true);
    assert.equal(result.invariants.zeroPublishAttemptCount, true);
    assert.equal(result.invariants.realPublishDisabled, true);
    assert.equal(result.invariants.noForumText, true);
    assert.equal(result.receiptContractValid, true);
    assert.match(result.evidenceHash, /^[a-f0-9]{64}$/);
    assert.equal(result.containsForumText, false);
  } finally {
    await prisma.autonomyWorkerWakeReceipt.deleteMany({
      where: { id: { in: ids } }
    });
    await prisma.$disconnect();
  }
});

test("scoped soak 按 source+runtime 隔离 streak 并保留最后状态", async () => {
  const { prisma } = await import("../../lib/db");
  const base = new Date("2026-08-05T10:00:00.000Z");
  const ids: string[] = [];
  try {
    const historicalTarget = await startWorkerWakeReceipt({
      prisma,
      source: "codex_automation",
      runtimeVersion: "v1-rc12",
      now: base
    });
    ids.push(historicalTarget.id);
    const recovery = await abandonStaleWorkerWakeReceipts({
      prisma,
      now: new Date(base.getTime() + 3 * 60 * 60_000)
    });
    assert.equal(recovery.abandonedCount, 1);

    for (const [offsetMinutes, source, runtimeVersion] of [
      [190, "codex_automation", "v1-rc12"],
      [200, "local_cli", "v1-rc12"],
      [210, "codex_automation", "v1-rc11"],
      [220, "test", "v1-test"],
      [230, "codex_automation", "v1-rc12"]
    ] as const) {
      const startedAt = new Date(
        base.getTime() + offsetMinutes * 60_000
      );
      const started = await startWorkerWakeReceipt({
        prisma,
        source,
        runtimeVersion,
        now: startedAt
      });
      ids.push(started.id);
      await finishWorkerWakeReceipt({
        prisma,
        receiptId: started.id,
        summary: summary(),
        now: new Date(startedAt.getTime() + 1_000)
      });
    }

    const result = await summarizeWorkerWakeReceipts({
      prisma,
      now: new Date(base.getTime() + 4 * 60 * 60_000),
      lookbackMs: 4 * 60 * 60_000
    });
    assert.deepEqual(
      result.scopedStats.map((stats) => [
        stats.source,
        stats.runtimeVersion
      ]),
      [
        ["codex_automation", "v1-rc11"],
        ["codex_automation", "v1-rc12"],
        ["local_cli", "v1-rc12"],
        ["test", "v1-test"]
      ]
    );
    const target = result.scopedStats.find(
      (stats) =>
        stats.source === "codex_automation" &&
        stats.runtimeVersion === "v1-rc12"
    );
    assert.ok(target);
    assert.equal(target.count, 3);
    assert.equal(target.statusCounts.abandoned, 1);
    assert.equal(target.statusCounts.completed, 2);
    assert.equal(target.terminalCount, 3);
    assert.equal(target.completedCount, 2);
    assert.equal(target.consecutiveTerminalCount, 3);
    assert.equal(target.consecutiveCompletedCount, 2);
    assert.equal(target.lastStatus, "completed");
    assert.equal(target.runningCount, 0);
    assert.equal(target.staleRunningCount, 0);
    assert.equal(target.receiptContractValid, true);
    assert.equal(target.invariants.noForumText, true);
    assert.equal(result.consecutiveCompletedCount, 5);
    assert.equal(result.receiptContractValid, true);
  } finally {
    await prisma.autonomyWorkerWakeReceipt.deleteMany({
      where: { id: { in: ids } }
    });
    await prisma.$disconnect();
  }
});

test("counts/status/hash 持久形状漂移使全局与 scoped contract 失效", async () => {
  const { prisma } = await import("../../lib/db");
  const base = new Date("2026-08-06T10:00:00.000Z");
  const ids: string[] = [];
  try {
    for (const [offsetMinutes, runtimeVersion] of [
      [0, "v1-counts"],
      [10, "v1-status"],
      [20, "v1-hash"]
    ] as const) {
      const startedAt = new Date(
        base.getTime() + offsetMinutes * 60_000
      );
      const started = await startWorkerWakeReceipt({
        prisma,
        source: "test",
        runtimeVersion,
        now: startedAt
      });
      ids.push(started.id);
      await finishWorkerWakeReceipt({
        prisma,
        receiptId: started.id,
        summary: summary(),
        now: new Date(startedAt.getTime() + 1_000)
      });
    }
    const countReceipt =
      await prisma.autonomyWorkerWakeReceipt.findUniqueOrThrow({
        where: { id: ids[0] }
      });
    const driftedCounts = JSON.parse(
      countReceipt.countsJson
    ) as Record<string, unknown>;
    delete driftedCounts.governanceFiltered;
    await prisma.autonomyWorkerWakeReceipt.update({
      where: { id: ids[0] },
      data: { countsJson: JSON.stringify(driftedCounts) }
    });
    await prisma.autonomyWorkerWakeReceipt.update({
      where: { id: ids[1] },
      data: { status: "failed" }
    });
    await prisma.autonomyWorkerWakeReceipt.update({
      where: { id: ids[2] },
      data: { summaryHash: "f".repeat(63) }
    });

    const result = await summarizeWorkerWakeReceipts({
      prisma,
      now: new Date(base.getTime() + 30 * 60_000),
      lookbackMs: 30 * 60_000
    });
    assert.equal(result.receiptContractValid, false);
    for (const runtimeVersion of [
      "v1-counts",
      "v1-status",
      "v1-hash"
    ]) {
      const scoped = result.scopedStats.find(
        (stats) => stats.runtimeVersion === runtimeVersion
      );
      assert.ok(scoped);
      assert.equal(scoped.count, 1);
      assert.equal(scoped.receiptContractValid, false);
    }
    assert.equal(
      result.scopedStats.find(
        (stats) => stats.runtimeVersion === "v1-counts"
      )?.invariants.noForumText,
      false
    );
  } finally {
    await prisma.autonomyWorkerWakeReceipt.deleteMany({
      where: { id: { in: ids } }
    });
    await prisma.$disconnect();
  }
});

test("CLI 非法 wake 参数安全失败且不输出凭据/URL", () => {
  const result = spawnSync(
    process.execPath,
    [
      require.resolve("tsx/cli"),
      "scripts/autonomy-worker.ts",
      "--wake-source",
      "https://unsafe.example"
    ],
    {
      cwd: process.cwd(),
      env: testEnv(),
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.doesNotMatch(
    result.stdout,
    /https?:\/\/|CMOOC_SATOKEN|PARTNER_PASSWORD|auth-state|secret/i
  );
});

test("CLI 合法 wake 在无 due 时也生成 terminal receipt 且保持硬锁", async () => {
  const startedAt = new Date();
  const result = spawnSync(
    process.execPath,
    [
      require.resolve("tsx/cli"),
      "scripts/autonomy-worker.ts",
      "--limit",
      "1",
      "--wake-source",
      "test",
      "--runtime-version",
      "v1-test"
    ],
    {
      cwd: process.cwd(),
      env: testEnv(),
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.ok([0, 1, 2].includes(result.status ?? -1));
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(payload.schemaVersion, AUTONOMY_WORKER_SCHEMA_VERSION);
  assert.equal(payload.containsForumText, false);
  const { prisma } = await import("../../lib/db");
  let receiptId = "";
  try {
    const receipt = await prisma.autonomyWorkerWakeReceipt.findFirstOrThrow({
      where: {
        source: "test",
        runtimeVersion: "v1-test",
        startedAt: { gte: new Date(startedAt.getTime() - 5_000) }
      },
      orderBy: { startedAt: "desc" }
    });
    receiptId = receipt.id;
    assert.notEqual(receipt.status, "running");
    assert.equal(receipt.editorWriteCount, 0);
    assert.equal(receipt.publishAttemptCount, 0);
    assert.equal(receipt.realPublishEnabled, false);
    assert.equal(receipt.containsForumText, false);
  } finally {
    if (receiptId) {
      await prisma.autonomyWorkerWakeReceipt.delete({
        where: { id: receiptId }
      });
    }
    await prisma.$disconnect();
  }
});
