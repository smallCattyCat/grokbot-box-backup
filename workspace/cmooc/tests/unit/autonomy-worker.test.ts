import assert from "node:assert/strict";
import test from "node:test";
import {
  autonomyWorkerExitCode,
  runAutonomyWorkerOnce,
  type AutonomyWorkerDependencies,
  type WorkerDueInvocation,
  type WorkerReconcileInput,
  type WorkerTickInput
} from "../../lib/autonomy/worker";
import { AutonomyTickError } from "../../lib/autonomy/tick";

const NOW = new Date("2026-08-02T12:00:00.000Z");

function due(
  courseAlias: string,
  mode: string,
  scheduledFor = "2026-08-02T11:00:00.000Z",
  state: WorkerDueInvocation["state"] = "runnable"
): WorkerDueInvocation {
  return {
    courseAlias,
    scheduleId: `${courseAlias}-schedule`,
    manifestHash: `${courseAlias}-manifest`,
    mode,
    scheduledFor,
    scheduleIntervalMinutes: 30,
    governancePolicyId: `${courseAlias}-governance-policy`,
    governanceVersion: "governance.v1",
    governanceHash: "a".repeat(64),
    governanceLimits: {
      dailySlotLimit: 3,
      perTickActionLimit: 3,
      authorTouchLimit30d: 2,
      intervalMinutes: 30
    },
    state,
    containsForumText: false
  };
}

function manifest(
  alias: string,
  defaultMode: "OBSERVE" | "SHADOW" = "SHADOW",
  realPublishEnabled = false
): any {
  return {
    alias,
    defaultMode,
    realPublishEnabled,
    schedule: { intervalMinutes: 30, leaseSeconds: 30 },
    manifestHash: `${alias}-manifest`,
    containsForumText: false
  };
}

function tickSummary(input: {
  courseAlias: string;
  mode?: string;
  scheduledFor?: string;
  status?:
    | "completed"
    | "completed_partial"
    | "lease_busy"
    | "already_completed";
  leaseAcquired?: boolean;
  publishAttemptCount?: number;
  editorWriteCount?: number;
  realPublishEnabled?: boolean;
  containsForumText?: boolean;
  unrecoveredCommentCompanionFailureCount?: number;
  invocationId?: string;
  governanceHash?: string | null;
}): Record<string, unknown> {
  const status = input.status ?? "completed";
  return {
    schemaVersion: "cmooc.autonomy-tick-summary.v1",
    status,
    invocationId: input.invocationId ?? `${input.courseAlias}-invocation`,
    courseAlias: input.courseAlias,
    mode: input.mode ?? "SHADOW",
    scheduledFor:
      input.scheduledFor ?? "2026-08-02T11:00:00.000Z",
    leaseAcquired:
      input.leaseAcquired ??
      (status === "completed" || status === "completed_partial"),
    publishAttemptCount: input.publishAttemptCount ?? 0,
    editorWriteCount: input.editorWriteCount ?? 0,
    realPublishEnabled: input.realPublishEnabled ?? false,
    containsForumText: input.containsForumText ?? false,
    governanceHash: input.governanceHash ?? "a".repeat(64),
    unrecoveredCommentCompanionFailureCount:
      input.unrecoveredCommentCompanionFailureCount ?? 0
  };
}

function deps(input: {
  due: WorkerDueInvocation[];
  manifests?: Record<string, any>;
  resolveErrors?: Record<string, string>;
  tick?: (task: WorkerTickInput) => Promise<unknown>;
  reconcile?: (task: WorkerReconcileInput) => Promise<unknown>;
  order?: string[];
}): AutonomyWorkerDependencies {
  const order = input.order ?? [];
  const dueByAlias = new Map(
    input.due.map((entry) => [entry.courseAlias, entry])
  );
  return {
    recoverExpiredInvocationLeases: async () => {
      order.push("recover");
      return {
        recoveredCount: 1,
        remainingExpiredCount: 0,
        containsForumText: false
      };
    },
    listDueAutonomyInvocations: async () => {
      order.push("list");
      return {
        due: input.due,
        truncated: false,
        containsForumText: false
      };
    },
    resolveManifest: async (alias) => {
      order.push(`resolve:${alias}`);
      const message = input.resolveErrors?.[alias];
      if (message) throw new Error(message);
      const value = input.manifests?.[alias];
      if (!value) throw new Error("manifest body must never be emitted");
      return value;
    },
    resolveGovernance: async ({ manifest }) => {
      const entry = dueByAlias.get(manifest.alias);
      assert.ok(entry?.governancePolicyId);
      assert.ok(entry?.governanceVersion);
      assert.ok(entry?.governanceHash);
      return {
        record: { id: entry.governancePolicyId },
        policy: {
          version: entry.governanceVersion,
          mode: entry.mode === "OBSERVE" ? "OBSERVE" : "SHADOW"
        },
        governanceHash: entry.governanceHash
      };
    },
    runTick: async (task) => {
      order.push(`tick:${task.courseAlias}`);
      return (
        input.tick?.(task) ??
        tickSummary({
          courseAlias: task.courseAlias,
          mode: task.requestedMode,
          scheduledFor: task.scheduledFor
        })
      );
    },
    reconcileOutcomes: async (task) => {
      order.push(`reconcile:${task.courseAlias}`);
      return (
        input.reconcile?.(task) ?? {
          status: "reconciled",
          containsForumText: false
        }
      );
    }
  };
}

test("先恢复租约，再执行显式 manifest 绑定的 SHADOW due", async () => {
  const order: string[] = [];
  const result = await runAutonomyWorkerOnce(
    { limit: 5, now: NOW },
    deps({
      order,
      due: [due("safe-course", "SHADOW")],
      manifests: { "safe-course": manifest("safe-course") }
    })
  );

  assert.deepEqual(order.slice(0, 3), [
    "recover",
    "list",
    "resolve:safe-course"
  ]);
  assert.equal(order.includes("tick:safe-course"), true);
  assert.equal(result.counts.executed, 1);
  assert.equal(result.tasks[0]?.status, "executed");
  assert.equal(result.containsForumText, false);
});

test("AUTOPILOT_CANARY 默认关闭且不改变现有 worker 摘要", async () => {
  const result = await runAutonomyWorkerOnce(
    { limit: 1, now: NOW },
    deps({
      due: [due("default-off-course", "SHADOW")],
      manifests: {
        "default-off-course": manifest("default-off-course")
      }
    })
  );

  assert.equal(result.status, "completed");
  assert.equal(result.counts.executed, 1);
  assert.equal(result.tasks[0]?.reasonCode, "tick_completed");
  assert.deepEqual(Object.keys(result).sort(), [
    "containsForumText",
    "counts",
    "reasonCode",
    "schemaVersion",
    "sourceTruncated",
    "status",
    "tasks"
  ]);
});

test("仅完整 SHADOW tick 把无正文绑定交给 AUTOPILOT_CANARY", async () => {
  const dispatched: Record<string, unknown>[] = [];
  const dependency = deps({
    due: [due("canary-course", "SHADOW")],
    manifests: { "canary-course": manifest("canary-course") },
    tick: async (task) =>
      tickSummary({
        courseAlias: task.courseAlias,
        mode: task.requestedMode,
        scheduledFor: task.scheduledFor,
        invocationId: "invocation-canary-1"
      })
  });
  dependency.dispatchAutopilotCanary = async (input) => {
    dispatched.push(input);
    return {
      status: "dispatched",
      reasonCode: "canary_action_dispatched",
      containsForumText: false
    };
  };

  const result = await runAutonomyWorkerOnce(
    { limit: 1, now: NOW },
    dependency
  );

  assert.equal(result.status, "completed");
  assert.equal(result.tasks[0]?.reasonCode, "tick_completed");
  assert.equal(dispatched.length, 1);
  assert.deepEqual(
    {
      invocationId: dispatched[0]?.invocationId,
      courseAlias: dispatched[0]?.courseAlias,
      governanceHash: dispatched[0]?.governanceHash,
      scheduledFor: dispatched[0]?.scheduledFor,
      now: dispatched[0]?.now,
      containsForumText: dispatched[0]?.containsForumText
    },
    {
      invocationId: "invocation-canary-1",
      courseAlias: "canary-course",
      governanceHash: "a".repeat(64),
      scheduledFor: "2026-08-02T11:00:00.000Z",
      now: NOW,
      containsForumText: false
    }
  );
  assert.equal("tickSummary" in (dispatched[0] ?? {}), false);
  assert.equal("body" in (dispatched[0] ?? {}), false);
});

test("OBSERVE、partial、未获租约与不安全 tick 都不触发 AUTOPILOT_CANARY", async () => {
  const dispatched: string[] = [];
  const aliases = [
    "observe-course",
    "partial-course",
    "lease-course",
    "unsafe-course"
  ];
  const dependency = deps({
    due: [
      due("observe-course", "OBSERVE"),
      due("partial-course", "SHADOW"),
      due("lease-course", "SHADOW"),
      due("unsafe-course", "SHADOW")
    ],
    manifests: {
      "observe-course": manifest("observe-course", "OBSERVE"),
      "partial-course": manifest("partial-course"),
      "lease-course": manifest("lease-course"),
      "unsafe-course": manifest("unsafe-course")
    },
    tick: async (task) => {
      if (task.courseAlias === "partial-course") {
        return tickSummary({
          courseAlias: task.courseAlias,
          status: "completed_partial"
        });
      }
      if (task.courseAlias === "lease-course") {
        return tickSummary({
          courseAlias: task.courseAlias,
          status: "lease_busy",
          leaseAcquired: false
        });
      }
      if (task.courseAlias === "unsafe-course") {
        return tickSummary({
          courseAlias: task.courseAlias,
          publishAttemptCount: 1
        });
      }
      return tickSummary({
        courseAlias: task.courseAlias,
        mode: task.requestedMode
      });
    }
  });
  dependency.dispatchAutopilotCanary = async (input) => {
    dispatched.push(input.courseAlias);
    return {
      status: "dispatched",
      reasonCode: "canary_action_dispatched",
      containsForumText: false
    };
  };

  const result = await runAutonomyWorkerOnce(
    { limit: 10, now: NOW },
    dependency
  );

  assert.deepEqual(dispatched, []);
  assert.equal(result.counts.executed, 2);
  assert.equal(result.counts.skipped, 1);
  assert.equal(result.counts.failed, 1);
  assert.deepEqual(
    result.tasks.map((task) => task.courseAlias),
    aliases
  );
});

test("AUTOPILOT_CANARY 失败时 worker fail closed 且不进入 reconcile", async () => {
  let reconciled = false;
  const dependency = deps({
    due: [due("canary-failure-course", "SHADOW")],
    manifests: {
      "canary-failure-course": manifest("canary-failure-course")
    },
    reconcile: async () => {
      reconciled = true;
      return { status: "reconciled", containsForumText: false };
    }
  });
  dependency.dispatchAutopilotCanary = async () => {
    throw new Error("SENSITIVE_CANARY_FAILURE");
  };

  const result = await runAutonomyWorkerOnce(
    { limit: 1, now: NOW },
    dependency
  );

  assert.equal(result.status, "failed");
  assert.equal(result.counts.considered, 1);
  assert.equal(result.counts.executed, 0);
  assert.equal(result.counts.skipped, 0);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.tasks[0]?.status, "failed");
  assert.equal(result.tasks[0]?.reasonCode, "autopilot_canary_failed");
  assert.equal(reconciled, false);
  assert.equal(JSON.stringify(result).includes("SENSITIVE_CANARY_FAILURE"), false);
});

test("AUTOPILOT_CANARY 非法回执与异常使用同一稳定失败原因", async () => {
  const dependency = deps({
    due: [due("canary-malformed-course", "SHADOW")],
    manifests: {
      "canary-malformed-course": manifest("canary-malformed-course")
    }
  });
  dependency.dispatchAutopilotCanary = async () =>
    ({
      status: "dispatched",
      reasonCode: "canary_action_dispatched",
      containsForumText: true,
      body: "MUST_NOT_ESCAPE"
    }) as never;

  const result = await runAutonomyWorkerOnce(
    { limit: 1, now: NOW },
    dependency
  );

  assert.equal(result.status, "failed");
  assert.equal(result.counts.executed, 0);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.tasks[0]?.reasonCode, "autopilot_canary_failed");
  assert.equal(JSON.stringify(result).includes("MUST_NOT_ESCAPE"), false);
});

test("AUTOPILOT_CANARY 明确 skipped 是安全拒绝，tick 仍按已执行计数", async () => {
  const dependency = deps({
    due: [due("canary-skip-course", "SHADOW")],
    manifests: {
      "canary-skip-course": manifest("canary-skip-course")
    }
  });
  dependency.dispatchAutopilotCanary = async () => ({
    status: "skipped",
    reasonCode: "no_authorized_action",
    containsForumText: false
  });

  const result = await runAutonomyWorkerOnce(
    { limit: 1, now: NOW },
    dependency
  );

  assert.equal(result.status, "completed");
  assert.equal(result.counts.considered, 1);
  assert.equal(result.counts.executed, 1);
  assert.equal(result.counts.skipped, 0);
  assert.equal(result.counts.failed, 0);
  assert.equal(result.tasks[0]?.reasonCode, "tick_completed");
});

test("AUTO、租约忙、缺失 manifest、别名不一致都安全 skip", async () => {
  const result = await runAutonomyWorkerOnce(
    { limit: 10, now: NOW },
    deps({
      due: [
        due("auto-course", "AUTO"),
        due("busy-course", "SHADOW", undefined, "lease_busy"),
        due("missing-course", "SHADOW"),
        due("mismatch-course", "SHADOW")
      ],
      manifests: {
        "auto-course": manifest("auto-course"),
        "busy-course": manifest("busy-course"),
        "mismatch-course": manifest("different-alias")
      },
      resolveErrors: { "missing-course": "secret manifest body" }
    })
  );

  assert.equal(result.counts.executed, 0);
  assert.equal(result.counts.skipped, 4);
  assert.equal(result.tasks.every((task) => task.status === "skipped"), true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret manifest body"), false);
  assert.equal(serialized.includes("different-alias"), false);
});

test("due mode 必须与 manifest.defaultMode 一致且真实发布硬锁保持关闭", async () => {
  const calls: string[] = [];
  const result = await runAutonomyWorkerOnce(
    { limit: 10, now: NOW },
    deps({
      due: [due("drift-course", "SHADOW"), due("publish-course", "SHADOW")],
      manifests: {
        "drift-course": manifest("drift-course", "OBSERVE"),
        "publish-course": manifest("publish-course", "SHADOW", true)
      },
      tick: async (task) => {
        calls.push(task.courseAlias);
        return tickSummary({
          courseAlias: task.courseAlias,
          mode: task.requestedMode,
          scheduledFor: task.scheduledFor
        });
      }
    })
  );

  assert.deepEqual(calls, []);
  assert.deepEqual(
    result.tasks.map((task) => task.reasonCode),
    ["manifest_mode_mismatch", "real_publish_enabled"]
  );
});

test("limit 查询窗口扩大，队首测试别名不会饿死后续安全课程", async () => {
  let queriedLimit = 0;
  const calls: string[] = [];
  const result = await runAutonomyWorkerOnce(
    { limit: 1, now: NOW },
    {
      recoverExpiredInvocationLeases: async () => ({
        recoveredCount: 0,
        remainingExpiredCount: 0,
        containsForumText: false
      }),
      listDueAutonomyInvocations: async (input) => {
        queriedLimit = input.limit;
        return {
          due: [
            due("autonomy-integration-test", "SHADOW"),
            due("safe-course", "SHADOW")
          ],
          truncated: true,
          containsForumText: false
        };
      },
      resolveManifest: async (alias) => {
        if (alias === "autonomy-integration-test") {
          throw new Error("test alias");
        }
        return manifest(alias);
      },
      resolveGovernance: async ({ manifest: resolvedManifest }) => ({
        record: { id: `${resolvedManifest.alias}-governance-policy` },
        policy: {
          version: "governance.v1",
          mode:
            resolvedManifest.defaultMode === "OBSERVE"
              ? "OBSERVE"
              : "SHADOW"
        },
        governanceHash: "a".repeat(64)
      }),
      runTick: async (input) => {
        calls.push(input.courseAlias);
        return tickSummary({
          courseAlias: input.courseAlias,
          mode: input.requestedMode,
          scheduledFor: input.scheduledFor
        });
      }
    }
  );

  assert.equal(queriedLimit >= 25, true);
  assert.deepEqual(calls, ["safe-course"]);
  assert.equal(result.sourceTruncated, true);
});

test("非法别名不会进入 manifest 路径解析，非法 scheduledFor 只安全 skip", async () => {
  const resolved: string[] = [];
  const ticked: string[] = [];
  const result = await runAutonomyWorkerOnce(
    { limit: 2, now: NOW },
    {
      recoverExpiredInvocationLeases: async () => ({
        recoveredCount: 0,
        remainingExpiredCount: 0,
        containsForumText: false
      }),
      listDueAutonomyInvocations: async () => ({
        due: [
          due("https://not-an-alias", "SHADOW"),
          due("bad-date-course", "SHADOW", "not-a-date"),
          due("safe-course", "SHADOW")
        ],
        containsForumText: false
      }),
      resolveManifest: async (alias) => {
        resolved.push(alias);
        return manifest(alias);
      },
      resolveGovernance: async ({ manifest: resolvedManifest }) => ({
        record: { id: `${resolvedManifest.alias}-governance-policy` },
        policy: {
          version: "governance.v1",
          mode:
            resolvedManifest.defaultMode === "OBSERVE"
              ? "OBSERVE"
              : "SHADOW"
        },
        governanceHash: "a".repeat(64)
      }),
      runTick: async (input) => {
        ticked.push(input.courseAlias);
        return tickSummary({
          courseAlias: input.courseAlias,
          mode: input.requestedMode,
          scheduledFor: input.scheduledFor
        });
      }
    }
  );

  assert.deepEqual(resolved, ["safe-course"]);
  assert.deepEqual(ticked, ["safe-course"]);
  assert.deepEqual(
    result.tasks.map((task) => task.reasonCode),
    ["course_alias_invalid", "scheduled_for_invalid", "tick_completed"]
  );
  assert.equal(JSON.stringify(result).includes("https://"), false);
});

test("默认 outcome hook 只把 preflight ready 的窗口交给 observer", async () => {
  const observedOutcomeIds: string[][] = [];
  const result = await runAutonomyWorkerOnce(
    { limit: 1, now: NOW },
    {
      recoverExpiredInvocationLeases: async () => ({
        recoveredCount: 0,
        remainingExpiredCount: 0,
        containsForumText: false
      }),
      listDueAutonomyInvocations: async () => ({
        due: [due("safe-course", "SHADOW")],
        containsForumText: false
      }),
      resolveManifest: async (alias) => manifest(alias),
      resolveGovernance: async ({ manifest: resolvedManifest }) => ({
        record: { id: `${resolvedManifest.alias}-governance-policy` },
        policy: {
          version: "governance.v1",
          mode:
            resolvedManifest.defaultMode === "OBSERVE"
              ? "OBSERVE"
              : "SHADOW"
        },
        governanceHash: "a".repeat(64)
      }),
      runTick: async (task) =>
        tickSummary({
          courseAlias: task.courseAlias,
          mode: task.requestedMode,
          scheduledFor: task.scheduledFor,
          status: "completed_partial"
        }),
      scheduleOutcomes: async () => ({
        createdWindowCount: 0,
        existingWindowCount: 2,
        containsForumText: false
      }),
      preflightOutcomes: async (input) => {
        assert.deepEqual(input.courseAliases, ["safe-course"]);
        return {
          outcomes: [
            {
              outcomeId: "ready-r24",
              courseAlias: "safe-course",
              status: "ready"
            },
            {
              outcomeId: "unsafe-r72",
              courseAlias: "safe-course",
              status: "would_censor"
            }
          ],
          containsForumText: false
        };
      },
      observeOutcomes: async (input) => {
        observedOutcomeIds.push(input.outcomeIds ?? []);
        return {
          observedCount: 1,
          censoredCount: 0,
          waitingForCoverageCount: 0,
          containsForumText: false
        };
      }
    }
  );

  assert.equal(result.counts.executed, 1);
  assert.equal(result.counts.reconciled, 1);
  assert.deepEqual(observedOutcomeIds, [["ready-r24"]]);
});

test("未恢复的 comment companion 覆盖退化使 worker 失败且不进入 outcome reconcile", async () => {
  let reconciled = false;
  const result = await runAutonomyWorkerOnce(
    { limit: 1, now: NOW },
    deps({
      due: [due("safe-course", "SHADOW")],
      manifests: { "safe-course": manifest("safe-course") },
      tick: async (task) =>
        tickSummary({
          courseAlias: task.courseAlias,
          mode: task.requestedMode,
          scheduledFor: task.scheduledFor,
          status: "completed_partial",
          unrecoveredCommentCompanionFailureCount: 38
        }),
      reconcile: async () => {
        reconciled = true;
        return { status: "reconciled", containsForumText: false };
      }
    })
  );

  assert.equal(result.status, "failed");
  assert.equal(result.reasonCode, "worker_cycle_failed");
  assert.equal(result.counts.executed, 0);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.tasks[0]?.status, "failed");
  assert.equal(
    result.tasks[0]?.reasonCode,
    "tick_comment_companion_unrecovered"
  );
  assert.equal(reconciled, false);
  assert.equal(autonomyWorkerExitCode(result), 1);
});

test("单个 tick 失败不阻断其它课程", async () => {
  const result = await runAutonomyWorkerOnce(
    { limit: 10, now: NOW },
    deps({
      due: [
        due("failed-course", "SHADOW"),
        due("healthy-course", "OBSERVE")
      ],
      manifests: {
        "failed-course": manifest("failed-course"),
        "healthy-course": manifest("healthy-course", "OBSERVE")
      },
      tick: async (task) => {
        if (task.courseAlias === "failed-course") {
          throw new Error("forum body and remote URL must never be emitted");
        }
        return tickSummary({
          courseAlias: task.courseAlias,
          mode: task.requestedMode,
          scheduledFor: task.scheduledFor
        });
      }
    })
  );

  assert.equal(result.counts.failed, 1);
  assert.equal(result.counts.executed, 1);
  assert.deepEqual(
    result.tasks.map((task) => task.status),
    ["failed", "executed"]
  );
  assert.equal(JSON.stringify(result).includes("forum body"), false);
});

test("worker 只透传受信 tick 原因码并继续隐藏原始错误", async () => {
  const authResult = await runAutonomyWorkerOnce(
    { limit: 1, now: NOW },
    deps({
      due: [due("auth-course", "SHADOW")],
      manifests: {
        "auth-course": manifest("auth-course")
      },
      tick: async () => {
        throw new AutonomyTickError(
          "read_auth_unavailable",
          "a".repeat(64)
        );
      }
    })
  );
  const rawResult = await runAutonomyWorkerOnce(
    { limit: 1, now: NOW },
    deps({
      due: [due("raw-course", "SHADOW")],
      manifests: {
        "raw-course": manifest("raw-course")
      },
      tick: async () => {
        throw new Error("SENSITIVE_REMOTE_BODY");
      }
    })
  );

  assert.equal(
    authResult.tasks[0]?.reasonCode,
    "read_auth_unavailable"
  );
  assert.equal(rawResult.tasks[0]?.reasonCode, "tick_failed");
  assert.equal(
    JSON.stringify(rawResult).includes("SENSITIVE_REMOTE_BODY"),
    false
  );
});

test("同一轮每个 courseAlias 最多执行一次", async () => {
  let ticks = 0;
  const result = await runAutonomyWorkerOnce(
    { limit: 10, now: NOW },
    deps({
      due: [
        due("duplicate-course", "SHADOW", "2026-08-02T10:00:00.000Z"),
        due("duplicate-course", "SHADOW", "2026-08-02T11:00:00.000Z")
      ],
      manifests: { "duplicate-course": manifest("duplicate-course") },
      tick: async (task) => {
        ticks += 1;
        return tickSummary({
          courseAlias: task.courseAlias,
          mode: task.requestedMode,
          scheduledFor: task.scheduledFor
        });
      }
    })
  );

  assert.equal(ticks, 1);
  assert.equal(result.counts.executed, 1);
  assert.equal(result.counts.skipped, 1);
  assert.equal(result.tasks[1]?.reasonCode, "duplicate_course");
});

test("reconcile hook 只在 tick 成功后调用", async () => {
  const reconciled: string[] = [];
  const result = await runAutonomyWorkerOnce(
    { limit: 10, now: NOW },
    deps({
      due: [due("bad-course", "SHADOW"), due("good-course", "SHADOW")],
      manifests: {
        "bad-course": manifest("bad-course"),
        "good-course": manifest("good-course")
      },
      tick: async (task) => {
        if (task.courseAlias === "bad-course") {
          throw new Error("not safe to expose");
        }
        return tickSummary({
          courseAlias: task.courseAlias,
          mode: task.requestedMode,
          scheduledFor: task.scheduledFor
        });
      },
      reconcile: async (task) => {
        reconciled.push(task.courseAlias);
        return {
          status: "reconciled",
          containsForumText: false
        };
      }
    })
  );

  assert.deepEqual(reconciled, ["good-course"]);
  assert.equal(result.counts.reconciled, 1);
});

test("manifest hash、调度间隔和未来槽位漂移时全部 fail closed", async () => {
  const driftedHash = {
    ...due("hash-course", "SHADOW"),
    manifestHash: "stale-manifest"
  };
  const driftedInterval = {
    ...due("interval-course", "SHADOW"),
    scheduleIntervalMinutes: 60
  };
  const future = due(
    "future-course",
    "SHADOW",
    "2026-08-02T13:00:00.000Z"
  );
  const result = await runAutonomyWorkerOnce(
    { limit: 10, now: NOW },
    deps({
      due: [driftedHash, driftedInterval, future],
      manifests: {
        "hash-course": manifest("hash-course"),
        "interval-course": manifest("interval-course"),
        "future-course": manifest("future-course")
      }
    })
  );

  assert.equal(result.counts.executed, 0);
  assert.deepEqual(
    result.tasks.map((task) => task.reasonCode),
    [
      "manifest_hash_mismatch",
      "schedule_interval_mismatch",
      "scheduled_for_future"
    ]
  );
});

test("注入 due 即使带 64 位哈希也必须经过当前治理 resolver", async () => {
  let resolverCalls = 0;
  let tickCalls = 0;
  const result = await runAutonomyWorkerOnce(
    { limit: 1, now: NOW },
    {
      recoverExpiredInvocationLeases: async () => ({
        recoveredCount: 0,
        remainingExpiredCount: 0,
        containsForumText: false
      }),
      listDueAutonomyInvocations: async () => ({
        due: [due("injected-governance-course", "SHADOW")],
        containsForumText: false
      }),
      resolveManifest: async (alias) => manifest(alias),
      resolveGovernance: async ({ manifest: resolvedManifest }) => {
        resolverCalls += 1;
        return {
          record: {
            id: `${resolvedManifest.alias}-governance-policy`
          },
          policy: { version: "governance.v1", mode: "SHADOW" },
          governanceHash: "b".repeat(64)
        };
      },
      runTick: async () => {
        tickCalls += 1;
        return tickSummary({
          courseAlias: "injected-governance-course"
        });
      }
    }
  );
  assert.equal(resolverCalls, 1);
  assert.equal(tickCalls, 0);
  assert.equal(result.tasks[0]?.reasonCode, "governance_drift");
});

test("不安全或未获租约的 tick summary 绝不触发 reconcile", async () => {
  const reconciled: string[] = [];
  const statuses = new Map<string, Record<string, unknown>>([
    [
      "lease-course",
      tickSummary({
        courseAlias: "lease-course",
        status: "lease_busy",
        leaseAcquired: false
      })
    ],
    [
      "completed-course",
      tickSummary({
        courseAlias: "completed-course",
        status: "already_completed",
        leaseAcquired: false
      })
    ],
    [
      "write-course",
      tickSummary({
        courseAlias: "write-course",
        publishAttemptCount: 1
      })
    ],
    [
      "shape-course",
      { status: "completed" }
    ]
  ]);
  const aliases = [...statuses.keys()];
  const result = await runAutonomyWorkerOnce(
    { limit: 10, now: NOW },
    deps({
      due: aliases.map((alias) => due(alias, "SHADOW")),
      manifests: Object.fromEntries(
        aliases.map((alias) => [alias, manifest(alias)])
      ),
      tick: async (task) => statuses.get(task.courseAlias),
      reconcile: async (task) => {
        reconciled.push(task.courseAlias);
        return {
          status: "reconciled",
          containsForumText: false
        };
      }
    })
  );

  assert.deepEqual(reconciled, []);
  assert.equal(result.counts.executed, 0);
  assert.equal(result.counts.skipped, 2);
  assert.equal(result.counts.failed, 2);
  assert.deepEqual(
    result.tasks.map((task) => task.reasonCode),
    [
      "tick_lease_busy",
      "tick_already_completed",
      "tick_summary_invalid",
      "tick_summary_invalid"
    ]
  );
});

test("同课程的不安全队列项不会挡住后续 runnable SHADOW", async () => {
  const ticked: string[] = [];
  const result = await runAutonomyWorkerOnce(
    { limit: 1, now: NOW },
    deps({
      due: [
        due("same-course", "AUTO", "2026-08-02T10:00:00.000Z"),
        due("same-course", "SHADOW", "2026-08-02T11:00:00.000Z")
      ],
      manifests: { "same-course": manifest("same-course") },
      tick: async (task) => {
        ticked.push(task.courseAlias);
        return tickSummary({
          courseAlias: task.courseAlias,
          mode: task.requestedMode,
          scheduledFor: task.scheduledFor
        });
      }
    })
  );

  assert.deepEqual(ticked, ["same-course"]);
  assert.equal(result.counts.executed, 1);
  assert.deepEqual(
    result.tasks.map((task) => task.reasonCode),
    ["mode_not_allowed", "tick_completed"]
  );
});

test("worker 顶层状态和退出码让外部调度器识别成功、注意与失败", async () => {
  const healthy = await runAutonomyWorkerOnce(
    { limit: 1, now: NOW },
    deps({
      due: [due("healthy-course", "SHADOW")],
      manifests: {
        "healthy-course": manifest("healthy-course")
      }
    })
  );
  assert.equal(healthy.status, "completed");
  assert.equal(healthy.reasonCode, "worker_cycle_completed");
  assert.equal(autonomyWorkerExitCode(healthy), 0);

  const attention = await runAutonomyWorkerOnce(
    { limit: 1, now: NOW },
    {
      recoverExpiredInvocationLeases: async () => {
        throw new Error("database connection details");
      },
      listDueAutonomyInvocations: async () => ({
        due: [],
        containsForumText: false
      })
    }
  );
  assert.equal(attention.status, "attention");
  assert.equal(attention.counts.recoveryFailed, 1);
  assert.equal(autonomyWorkerExitCode(attention), 2);

  const governanceFiltered = await runAutonomyWorkerOnce(
    { limit: 1, now: NOW },
    {
      recoverExpiredInvocationLeases: async () => ({
        recoveredCount: 0,
        remainingExpiredCount: 0,
        containsForumText: false
      }),
      listDueAutonomyInvocations: async () => ({
        due: [],
        governanceFilteredCount: 2,
        containsForumText: false
      })
    }
  );
  assert.equal(governanceFiltered.status, "attention");
  assert.equal(governanceFiltered.counts.governanceFiltered, 2);
  assert.equal(autonomyWorkerExitCode(governanceFiltered), 2);

  const failed = await runAutonomyWorkerOnce(
    { limit: 1, now: NOW },
    {
      recoverExpiredInvocationLeases: async () => ({
        recoveredCount: 0,
        remainingExpiredCount: 0,
        containsForumText: false
      }),
      listDueAutonomyInvocations: async () => {
        throw new Error("database path must remain redacted");
      }
    }
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.counts.dueQueryFailed, 1);
  assert.equal(autonomyWorkerExitCode(failed), 1);
  assert.equal(
    JSON.stringify(failed).includes("database path"),
    false
  );
});
