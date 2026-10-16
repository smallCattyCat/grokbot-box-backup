import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { assertSeedTarget, DEMO_RESET_CONFIRMATION } from "../../lib/database/seed-safety";
import { defaultDatabaseUrl } from "../../lib/env";
import { assertTransition, canTransition, getAllowedTransitions, nextStatus } from "../../lib/state-machine";

const require = createRequire(import.meta.url);
const publishPolicyModulePath = "../../lib/interventions/publish-policy";

type PublishBinding = {
  taskId: string;
  contentHash: string;
  targetHash: string;
  expiresAt?: Date;
};

type PublishAuthorization = PublishBinding & Record<string, unknown>;

type PublishPolicyModule = {
  issuePublishAuthorization: (binding: PublishBinding) => PublishAuthorization;
  validatePublishAuthorization: (
    authorization: PublishAuthorization,
    binding: PublishBinding
  ) => boolean | { valid: boolean; reason?: string };
};

async function loadPublishPolicy(): Promise<PublishPolicyModule> {
  try {
    return (await import(publishPolicyModulePath)) as PublishPolicyModule;
  } catch (error) {
    assert.fail(
      `缺少统一发布策略模块 lib/interventions/publish-policy.ts：${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function isAuthorizationValid(result: ReturnType<PublishPolicyModule["validatePublishAuthorization"]>): boolean {
  return typeof result === "boolean" ? result : result.valid;
}

test("测试环境默认使用隔离的 SQLite 数据库", () => {
  assert.equal(defaultDatabaseUrl("test"), "file:./test.db");
  assert.equal(defaultDatabaseUrl("development"), "file:./dev.db");
  assert.equal(defaultDatabaseUrl("production"), "file:./dev.db");
});

test("真实环境加载不会让 .env 覆盖测试库隔离", () => {
  const { DATABASE_URL: _databaseUrl, ...inheritedEnv } = process.env;
  const result = spawnSync(
    process.execPath,
    [require.resolve("tsx/cli"), "tests/fixtures/print-database-url.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...inheritedEnv, NODE_ENV: "test" as const }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "file:./test.db");
});

test("直接运行单个 node:test 文件也不能回落到开发库", () => {
  const {
    DATABASE_URL: _databaseUrl,
    NODE_ENV: _nodeEnv,
    NODE_TEST_CONTEXT: _nodeTestContext,
    CMOOC_USE_CONFIGURED_TEST_DATABASE: _configuredTestDatabase,
    ...inheritedEnv
  } = process.env;
  const result = spawnSync(
    process.execPath,
    [
      require.resolve("tsx/cli"),
      "--test",
      "--test-concurrency=1",
      "tests/fixtures/print-database-url.ts"
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: inheritedEnv as NodeJS.ProcessEnv
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /file:\.\/test\.db/);
  assert.doesNotMatch(result.stdout, /file:\.\/dev\.db/);
});

test("任务状态机只接受显式允许的流转", () => {
  assert.equal(canTransition("discovered", "ready"), true);
  assert.equal(canTransition("discovered", "published"), false);
  assert.equal(nextStatus("failed", "failed_retryable"), "failed_retryable");
  assert.equal(canTransition("failed", "ready"), false);
  assert.equal(canTransition("ready", "review_required"), true);
  assert.equal(canTransition("failed_retryable", "review_required"), true);
  assert.deepEqual(getAllowedTransitions("safety_checked"), ["proposed", "ready", "skipped"]);
  assert.throws(() => assertTransition("drafted", "published"), /非法状态流转/);
});

test("fixture seed 只能写入固定测试库", () => {
  assert.doesNotThrow(() =>
    assertSeedTarget({
      CMOOC_SEED_MODE: "fixture",
      DATABASE_URL: "file:./test.db"
    })
  );
  assert.throws(
    () =>
      assertSeedTarget({
        CMOOC_SEED_MODE: "fixture",
        DATABASE_URL: "file:./dev.db"
      }),
    /只允许 DATABASE_URL=file:\.\/test\.db/
  );
});

test("demo seed 同时要求固定开发库和人工确认口令", () => {
  assert.throws(
    () =>
      assertSeedTarget({
        CMOOC_SEED_MODE: "demo",
        DATABASE_URL: "file:./dev.db"
      }),
    /拒绝重置开发数据库/
  );
  assert.throws(
    () =>
      assertSeedTarget({
        CMOOC_SEED_MODE: "demo",
        DATABASE_URL: "file:./other.db",
        CMOOC_ALLOW_DEMO_RESET: DEMO_RESET_CONFIRMATION
      }),
    /拒绝写入非固定开发库/
  );
  assert.doesNotThrow(() =>
    assertSeedTarget({
      CMOOC_SEED_MODE: "demo",
      DATABASE_URL: "file:./dev.db",
      CMOOC_ALLOW_DEMO_RESET: DEMO_RESET_CONFIRMATION
    })
  );
});

test("发布授权同时绑定 taskId、contentHash 与 targetHash", async () => {
  const policy = await loadPublishPolicy();
  const binding: PublishBinding = {
    taskId: "task-contract-1",
    contentHash: "content-hash-v1",
    targetHash: "target-hash-v1",
    expiresAt: new Date(Date.now() + 60_000)
  };
  const authorization = policy.issuePublishAuthorization(binding);

  assert.equal(isAuthorizationValid(policy.validatePublishAuthorization(authorization, binding)), true);
  assert.equal(
    isAuthorizationValid(
      policy.validatePublishAuthorization(authorization, {
        ...binding,
        taskId: "task-contract-2"
      })
    ),
    false,
    "其他任务不能复用该授权"
  );
  assert.equal(
    isAuthorizationValid(
      policy.validatePublishAuthorization(authorization, {
        ...binding,
        contentHash: "content-hash-v2"
      })
    ),
    false,
    "正文变化必须使授权失效"
  );
  assert.equal(
    isAuthorizationValid(
      policy.validatePublishAuthorization(authorization, {
        ...binding,
        targetHash: "target-hash-v2"
      })
    ),
    false,
    "发布目标变化必须使授权失效"
  );
});

test("发布策略拒绝没有内容或目标指纹的授权", async () => {
  const policy = await loadPublishPolicy();
  const base: PublishBinding = {
    taskId: "task-contract-empty",
    contentHash: "content-hash",
    targetHash: "target-hash"
  };

  assert.throws(
    () => policy.issuePublishAuthorization({ ...base, contentHash: "" }),
    /contentHash|内容|正文|指纹/
  );
  assert.throws(
    () => policy.issuePublishAuthorization({ ...base, targetHash: "" }),
    /targetHash|目标|指纹/
  );
});

test("评论回复始终按稳定平台 ID 和审阅内容指纹定位", async () => {
  const { assertStableCommentTarget } = await import("../../lib/forum/publish-reply");
  const reviewedContent = "这是一条已经审阅的目标评论";
  const reviewedHash = createHash("sha256")
    .update(reviewedContent, "utf8")
    .digest("hex");
  const reordered = [
    { id: "new-comment", content: "后来插入的新评论" },
    { id: "target-comment", content: reviewedContent }
  ];

  assert.equal(
    assertStableCommentTarget({
      comments: reordered,
      targetPlatformReplyId: "target-comment",
      targetCommentContentHash: reviewedHash
    }).id,
    "target-comment",
    "评论重排后仍必须命中审阅时的平台 ID"
  );
  assert.throws(
    () => assertStableCommentTarget({
      comments: [{ id: "target-comment", content: "内容已经被编辑" }],
      targetPlatformReplyId: "target-comment",
      targetCommentContentHash: reviewedHash
    }),
    /内容已发生变化/
  );
  assert.throws(
    () => assertStableCommentTarget({
      comments: reordered.filter((comment) => comment.id !== "target-comment"),
      targetPlatformReplyId: "target-comment",
      targetCommentContentHash: reviewedHash
    }),
    /已删除|不再可见/
  );
});

test("评论回复规划阶段不因尚未绑定平台 ID 被误删，发布前必须绑定", async () => {
  const { runSafetyGateway } = await import("../../lib/security/safety-gateway");
  const planning = runSafetyGateway({
    forumText: "这是一条正常的课程讨论。",
    action: {
      publishEnabled: false,
      targetMode: "comment_reply"
    }
  });
  assert.notEqual(planning.route, "block");

  const publishing = runSafetyGateway({
    forumText: "这是一条正常的课程讨论。",
    proposedReply: "这是一条足够长、用于继续推动课程讨论的智能学伴回复。",
    action: {
      publishEnabled: true,
      targetMode: "comment_reply"
    }
  });
  assert.equal(publishing.route, "block");
  assert.match(publishing.issues.join("；"), /稳定平台标识/);
});

test("论坛发布证据只能来自本次新增、正文精确且父评论正确的记录", async () => {
  const { findNewPublishedCommentEvidence } = await import("../../lib/forum/cmooc-api");
  const base = {
    index: 0,
    authorName: "匿名学习者",
    time: "2026-07-25"
  };
  const before = [
    {
      ...base,
      id: "old-same-content",
      parentId: "target-comment",
      depth: 1,
      content: "相同正文"
    }
  ];

  assert.equal(
    findNewPublishedCommentEvidence({
      before,
      after: [
        ...before,
        {
          ...base,
          id: "unrelated-new",
          parentId: null,
          depth: 0,
          content: "别人并发发布的无关内容"
        }
      ],
      content: "相同正文",
      expectedParentId: "target-comment"
    }),
    null,
    "旧的相同正文加一条无关新增记录不能伪装成本次成功"
  );
  assert.equal(
    findNewPublishedCommentEvidence({
      before,
      after: [
        ...before,
        {
          ...base,
          id: "wrong-parent",
          parentId: "another-comment",
          depth: 1,
          content: "相同正文"
        }
      ],
      content: "相同正文",
      expectedParentId: "target-comment"
    }),
    null,
    "正文相同但父评论错误时不能判定成功"
  );
  assert.equal(
    findNewPublishedCommentEvidence({
      before,
      after: [
        ...before,
        {
          ...base,
          id: "new-correct-reply",
          parentId: "target-comment",
          depth: 1,
          content: "<p>相同正文</p>"
        }
      ],
      content: "相同正文",
      expectedParentId: "target-comment"
    })?.id,
    "new-correct-reply"
  );
});

test("状态修改请求只接受可信本机地址上的同源 JSON", async () => {
  const { NextRequest } = await import("next/server");
  const { requireTrustedJsonMutation } = await import("../../lib/http/mutation-guard");
  const local = new NextRequest("http://localhost:3000/api/settings", {
    method: "POST",
    headers: {
      Host: "localhost:3000",
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
      "Sec-Fetch-Site": "same-origin"
    },
    body: "{}"
  });
  assert.equal(requireTrustedJsonMutation(local, "设置"), null);

  const rebound = new NextRequest("http://attacker.example/api/settings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://attacker.example",
      "Sec-Fetch-Site": "same-origin"
    },
    body: "{}"
  });
  assert.equal(requireTrustedJsonMutation(rebound, "设置")?.status, 403);

  const forgedHost = new NextRequest("http://localhost:3000/api/settings", {
    method: "POST",
    headers: {
      Host: "attacker.example",
      "Content-Type": "application/json",
      Origin: "http://attacker.example",
      "Sec-Fetch-Site": "same-origin"
    },
    body: "{}"
  });
  assert.equal(requireTrustedJsonMutation(forgedHost, "设置")?.status, 403);

  const crossOrigin = new NextRequest("http://localhost:3000/api/settings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://malicious.example",
      "Sec-Fetch-Site": "cross-site"
    },
    body: "{}"
  });
  assert.equal(requireTrustedJsonMutation(crossOrigin, "设置")?.status, 403);

  const misleadingContentType = new NextRequest("http://localhost:3000/api/settings", {
    method: "POST",
    headers: {
      "Content-Type": "text/application/json-evil",
      Origin: "http://localhost:3000"
    },
    body: "{}"
  });
  assert.equal(requireTrustedJsonMutation(misleadingContentType, "设置")?.status, 415);

  const { middleware } = await import("../../middleware");
  assert.equal(middleware(rebound).status, 421, "读取请求也必须拒绝伪造 Host");
  assert.equal(middleware(forgedHost).status, 421);
  assert.notEqual(middleware(local).status, 421);
});

test("论坛地址白名单在采集与真实写入边界统一拒绝非 cMOOC 地址", async () => {
  const { assertAllowedForumUrl } = await import("../../lib/forum/allowed-url");

  assert.equal(
    assertAllowedForumUrl("https://cmooc.bnu.edu.cn/cMOOC/detail?id=123#reply"),
    "https://cmooc.bnu.edu.cn/cMOOC/detail?id=123"
  );
  assert.throws(
    () => assertAllowedForumUrl("http://cmooc.bnu.edu.cn/cMOOC/detail?id=123"),
    /HTTPS/
  );
  assert.throws(
    () => assertAllowedForumUrl("https://attacker.example/cMOOC/detail?id=123"),
    /允许/
  );
  assert.throws(
    () => assertAllowedForumUrl("https://user:pass@cmooc.bnu.edu.cn/cMOOC/detail?id=123"),
    /内嵌凭据/
  );
  assert.throws(
    () => assertAllowedForumUrl("https://cmooc.bnu.edu.cn/admin"),
    /论坛页面路径/
  );
});

test("在线模型模式缺少令牌时显式失败，不伪装成 mock 结果", async () => {
  const original = {
    mode: process.env.LLM_MODE,
    genericKey: process.env.LLM_API_KEY,
    siliconflowKey: process.env.SILICONFLOW_API_KEY,
    disableWindowsFallback: process.env.CMOOC_DISABLE_WINDOWS_ENV_FALLBACK
  };
  try {
    process.env.LLM_MODE = "real";
    delete process.env.LLM_API_KEY;
    delete process.env.SILICONFLOW_API_KEY;
    process.env.CMOOC_DISABLE_WINDOWS_ENV_FALLBACK = "1";
    const { generateJson, getLlmRuntimeStatus } = await import("../../lib/llm/client");
    assert.equal(getLlmRuntimeStatus().mode, "real");
    assert.equal(getLlmRuntimeStatus().hasApiKey, false);
    await assert.rejects(
      () => generateJson({ system: "test", user: "test", schemaName: "ValueAnalysis" }),
      /未找到.*API_KEY|未使用 mock/
    );
  } finally {
    if (original.mode === undefined) delete process.env.LLM_MODE;
    else process.env.LLM_MODE = original.mode;
    if (original.genericKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = original.genericKey;
    if (original.siliconflowKey === undefined) delete process.env.SILICONFLOW_API_KEY;
    else process.env.SILICONFLOW_API_KEY = original.siliconflowKey;
    if (original.disableWindowsFallback === undefined) {
      delete process.env.CMOOC_DISABLE_WINDOWS_ENV_FALLBACK;
    } else {
      process.env.CMOOC_DISABLE_WINDOWS_ENV_FALLBACK =
        original.disableWindowsFallback;
    }
  }
});

test("审计日志写入失败不会改变已经提交的发布或核对结果", async () => {
  const { recordAgentRunBestEffort } = await import("../../lib/agents/agent-run");
  const warnings: string[] = [];

  const result = await recordAgentRunBestEffort(
    {
      taskId: "task-already-committed",
      postId: "post-already-committed",
      agentName: "publisher-reconciliation-agent",
      input: { resolution: "published" },
      output: { status: "published" }
    },
    {
      record: async () => {
        throw new Error("simulated agent-run storage failure");
      },
      warn: (message) => warnings.push(message)
    }
  );

  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /publisher-reconciliation-agent/);
  assert.match(warnings[0], /业务结果保持不变/);
});
