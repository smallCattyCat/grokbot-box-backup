import assert from "node:assert/strict";
import test from "node:test";
import {
  CMOOC_EXECUTION_ACCOUNT_POOL_READ_MODEL_SCHEMA_VERSION,
  getSafeExecutionAccountPoolSummary,
  type SafeExecutionAgentPoolSummary
} from "../../lib/autonomy/execution-account-pool-read-model";

const hashes = {
  alpha: "a".repeat(64),
  beta: "b".repeat(64),
  gamma: "c".repeat(64),
  credential: "d".repeat(64),
  sentinel: "sentinel-account-password-token-url-body-hash"
};

type Descriptor = {
  accountRefHash: string;
  credentialRefHash: string;
  roleKey:
    | "socratic_guide"
    | "evidence_connector"
    | "reflection_coach"
    | "community_host";
  courseAliases: string[];
  dailyActionLimit: number;
  cooldownMinutes: number;
  disclosedAi: true;
  containsForumText: false;
};

function descriptor(
  accountRefHash: string,
  roleKey: Descriptor["roleKey"],
  courseAliases = ["course-a"],
  dailyActionLimit = 2,
  cooldownMinutes = 30
): Descriptor {
  return {
    accountRefHash,
    credentialRefHash: hashes.credential,
    roleKey,
    courseAliases,
    dailyActionLimit,
    cooldownMinutes,
    disclosedAi: true,
    containsForumText: false
  };
}

function fakePrisma(input: {
  aliases: string[];
  leases: Array<{
    accountRefHash: string;
    status: string;
    expiresAt: Date;
    consumedAt: Date | null;
  }>;
}) {
  return {
    autonomyCourseManifest: {
      async findMany() {
        return input.aliases.map((alias) => ({ alias }));
      }
    },
    executionAccountLease: {
      async findMany() {
        return input.leases;
      }
    }
  };
}

function assertSafeSummary(summary: SafeExecutionAgentPoolSummary) {
  assert.deepEqual(Object.keys(summary).sort(), [
    "activeAgentCount",
    "availableAgentCount",
    "configurationState",
    "configuredAgentCount",
    "configuredRoleCount",
    "containsAccountIdentity",
    "containsCredentialMaterial",
    "containsForumText",
    "consumedLeaseCountToday",
    "cooldownAgentCount",
    "dailyLimitReachedAgentCount",
    "roles",
    "schemaVersion",
    "scope"
  ].sort());
  assert.equal(
    summary.schemaVersion,
    CMOOC_EXECUTION_ACCOUNT_POOL_READ_MODEL_SCHEMA_VERSION
  );
  assert.equal(summary.scope, "enabled_courses");
  assert.equal(summary.containsAccountIdentity, false);
  assert.equal(summary.containsCredentialMaterial, false);
  assert.equal(summary.containsForumText, false);
  assert.deepEqual(
    summary.roles.map((role) => role.roleKey),
    [
      "socratic_guide",
      "evidence_connector",
      "reflection_coach",
      "community_host"
    ]
  );
  for (const role of summary.roles) {
    assert.deepEqual(Object.keys(role).sort(), [
      "activeAgentCount",
      "availableAgentCount",
      "configuredAgentCount",
      "cooldownAgentCount",
      "dailyLimitReachedAgentCount",
      "consumedLeaseCountToday",
      "roleKey"
    ].sort());
  }
  assert.equal(
    summary.availableAgentCount +
      summary.activeAgentCount +
      summary.cooldownAgentCount +
      summary.dailyLimitReachedAgentCount,
    summary.configuredAgentCount
  );
  const serialized = JSON.stringify(summary);
  for (const value of [
    hashes.alpha,
    hashes.beta,
    hashes.gamma,
    hashes.credential
  ]) {
    assert.equal(serialized.includes(value), false);
  }
  assert.equal(/[a-f0-9]{64}/.test(serialized), false);
  assert.equal(serialized.includes(hashes.sentinel), false);
  assert.equal(serialized.includes("password"), false);
  assert.equal(serialized.includes("https://"), false);
}

test("读模型按固定角色顺序、状态优先级和总数守恒投影账号池", async () => {
  const now = new Date("2026-08-10T15:59:59.000Z");
  const runtime = {
    listDescriptors: () => [
      descriptor(hashes.alpha, "socratic_guide", ["course-a", "course-b"]),
      descriptor(hashes.alpha, "socratic_guide", ["course-a", "course-b"]),
      descriptor(hashes.beta, "evidence_connector", ["course-a"], 1, 120),
      descriptor(hashes.gamma, "reflection_coach", ["disabled-course"])
    ]
  };
  const prisma = fakePrisma({
    aliases: ["course-a"],
    leases: [
      {
        accountRefHash: hashes.alpha,
        status: "active",
        expiresAt: new Date("2026-08-10T16:30:00.000Z"),
        consumedAt: null
      },
      {
        accountRefHash: hashes.alpha,
        status: "consumed",
        expiresAt: new Date("2026-08-10T15:00:00.000Z"),
        consumedAt: new Date("2026-08-10T00:00:00.000Z")
      },
      {
        accountRefHash: hashes.beta,
        status: "consumed",
        expiresAt: new Date("2026-08-10T15:00:00.000Z"),
        consumedAt: new Date("2026-08-10T15:00:00.000Z")
      },
      {
        accountRefHash: hashes.beta,
        status: "consumed",
        expiresAt: new Date("2026-08-09T15:00:00.000Z"),
        consumedAt: new Date("2026-08-09T15:00:00.000Z")
      }
    ]
  });
  const summary = await getSafeExecutionAccountPoolSummary({
    prisma,
    now,
    runtime
  });
  assertSafeSummary(summary);
  assert.equal(summary.configurationState, "ready");
  assert.equal(summary.configuredAgentCount, 2);
  assert.equal(summary.configuredRoleCount, 2);
  assert.equal(summary.activeAgentCount, 1);
  assert.equal(summary.dailyLimitReachedAgentCount, 1);
  assert.equal(summary.cooldownAgentCount, 0);
  assert.equal(summary.availableAgentCount, 0);
  assert.equal(summary.consumedLeaseCountToday, 2);
  assert.deepEqual(summary.roles[0], {
    roleKey: "socratic_guide",
    configuredAgentCount: 1,
    availableAgentCount: 0,
    activeAgentCount: 1,
    cooldownAgentCount: 0,
    dailyLimitReachedAgentCount: 0,
    consumedLeaseCountToday: 1
  });
  assert.deepEqual(summary.roles[1], {
    roleKey: "evidence_connector",
    configuredAgentCount: 1,
    availableAgentCount: 0,
    activeAgentCount: 0,
    cooldownAgentCount: 0,
    dailyLimitReachedAgentCount: 1,
    consumedLeaseCountToday: 1
  });
});

test("上海日边界只计入当天消费，并在无租约时保持可用", async () => {
  const now = new Date("2026-08-10T15:59:59.999Z");
  const prisma = fakePrisma({
    aliases: ["course-a"],
    leases: [
      {
        accountRefHash: hashes.alpha,
        status: "consumed",
        expiresAt: new Date("2026-08-09T15:00:00.000Z"),
        consumedAt: new Date("2026-08-09T15:59:59.999Z")
      },
      {
        accountRefHash: hashes.alpha,
        status: "consumed",
        expiresAt: new Date("2026-08-10T15:00:00.000Z"),
        consumedAt: new Date("2026-08-10T15:59:59.999Z")
      }
    ]
  });
  const summary = await getSafeExecutionAccountPoolSummary({
    prisma,
    now,
    runtime: {
      listDescriptors: () => [
        descriptor(hashes.alpha, "socratic_guide", ["course-a"], 2, 0)
      ]
    }
  });
  assert.equal(summary.configurationState, "ready");
  assert.equal(summary.consumedLeaseCountToday, 1);
  assert.equal(summary.availableAgentCount, 1);
  assertSafeSummary(summary);
});

test("额度未耗尽但最近消费仍在冷却窗口时标记为冷却", async () => {
  const now = new Date("2026-08-10T15:59:59.999Z");
  const summary = await getSafeExecutionAccountPoolSummary({
    prisma: fakePrisma({
      aliases: ["course-a"],
      leases: [
        {
          accountRefHash: hashes.alpha,
          status: "consumed",
          expiresAt: new Date("2026-08-10T15:30:00.000Z"),
          consumedAt: new Date("2026-08-10T15:30:00.000Z")
        }
      ]
    }),
    now,
    runtime: {
      listDescriptors: () => [
        descriptor(hashes.alpha, "reflection_coach", ["course-a"], 3, 60)
      ]
    }
  });
  assert.equal(summary.configurationState, "ready");
  assert.equal(summary.cooldownAgentCount, 1);
  assert.equal(summary.availableAgentCount, 0);
  assert.equal(summary.dailyLimitReachedAgentCount, 0);
  assertSafeSummary(summary);
});

test("未配置和不可用状态稳定折叠且不泄露底层异常", async () => {
  const prisma = fakePrisma({ aliases: ["course-a"], leases: [] });
  const notConfigured = await getSafeExecutionAccountPoolSummary({
    prisma,
    runtimeLoader: async () => {
      throw new Error("CMOOC_EXECUTION_ACCOUNT_POOL_NOT_CONFIGURED secret-account-password");
    }
  });
  assert.equal(notConfigured.configurationState, "not_configured");
  assertSafeSummary(notConfigured);
  const unavailable = await getSafeExecutionAccountPoolSummary({
    prisma,
    runtimeLoader: async () => {
      throw new Error("network url https://private.invalid body forum secret");
    }
  });
  assert.equal(unavailable.configurationState, "unavailable");
  assertSafeSummary(unavailable);
});

test("runtime 任一不安全描述或同账号冲突都整体降级，不做部分投影", async () => {
  const prisma = fakePrisma({ aliases: ["course-a"], leases: [] });
  const unsafe = await getSafeExecutionAccountPoolSummary({
    prisma,
    runtime: {
      listDescriptors: () => [
        descriptor(hashes.alpha, "socratic_guide"),
        {
          ...descriptor(hashes.beta, "evidence_connector"),
          containsForumText: true
        } as unknown as Descriptor
      ]
    }
  });
  assert.equal(unsafe.configurationState, "unavailable");
  assert.equal(unsafe.configuredAgentCount, 0);
  assertSafeSummary(unsafe);

  const conflict = await getSafeExecutionAccountPoolSummary({
    prisma,
    runtime: {
      listDescriptors: () => [
        descriptor(hashes.alpha, "socratic_guide", ["course-a"]),
        descriptor(hashes.alpha, "evidence_connector", ["course-a"])
      ]
    }
  });
  assert.equal(conflict.configurationState, "unavailable");
  assert.equal(conflict.configuredAgentCount, 0);
  assertSafeSummary(conflict);
});
