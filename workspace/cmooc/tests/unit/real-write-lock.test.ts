import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  assertRealForumWriteUnlocked,
  issueRealForumWriteGrant,
  REAL_FORUM_WRITE_LOCKED,
  REAL_FORUM_WRITE_LOCK_CODE,
  runWithRealForumWriteGrant,
  type RealForumWriteMutationBinding
} from "../../lib/forum/real-write-lock";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function trustedMutationRequest(
  pathname: string,
  body: Record<string, unknown>
) {
  return new NextRequest(`http://localhost:3000${pathname}`, {
    method: "POST",
    headers: {
      Host: "localhost:3000",
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
      "Sec-Fetch-Site": "same-origin"
    },
    body: JSON.stringify(body)
  });
}

test("开发与 PI 演示阶段真实论坛写入由代码常量硬锁", () => {
  assert.equal(REAL_FORUM_WRITE_LOCKED, true);
  assert.throws(
    () => assertRealForumWriteUnlocked(),
    new RegExp(REAL_FORUM_WRITE_LOCK_CODE)
  );
});

test("production Committer 只能在精确绑定的一次性作用域内消费一个写动作", async () => {
  const now = new Date("2026-07-31T12:00:00.000Z");
  const secret = Buffer.alloc(32, 7);
  const binding: RealForumWriteMutationBinding = {
    permitKey: hash("permit"),
    attemptId: "attempt-once",
    idempotencyKey: hash("idempotency"),
    targetHash: hash("target"),
    contentHash: hash("content"),
    containsForumText: false
  };
  const grant = issueRealForumWriteGrant({
    binding,
    signingSecret: secret,
    now,
    expiresAt: new Date(now.getTime() + 60_000)
  });

  await runWithRealForumWriteGrant({
    grant,
    signingSecret: secret,
    binding,
    now,
    action: async () => {
      assert.doesNotThrow(() =>
        assertRealForumWriteUnlocked(binding)
      );
      assert.throws(
        () => assertRealForumWriteUnlocked(binding),
        /REAL_FORUM_WRITE_GRANT_CONSUMED/
      );
    }
  });

  assert.throws(
    () => assertRealForumWriteUnlocked(binding),
    new RegExp(REAL_FORUM_WRITE_LOCK_CODE)
  );
});

test("一次性写授权不能用于不同目标，也不能让旧的无绑定入口穿透硬锁", async () => {
  const now = new Date("2026-07-31T12:00:00.000Z");
  const secret = Buffer.alloc(32, 9);
  const binding: RealForumWriteMutationBinding = {
    permitKey: hash("permit-mismatch"),
    attemptId: "attempt-mismatch",
    idempotencyKey: hash("idempotency-mismatch"),
    targetHash: hash("target-mismatch"),
    contentHash: hash("content-mismatch"),
    containsForumText: false
  };
  const grant = issueRealForumWriteGrant({
    binding,
    signingSecret: secret,
    now,
    expiresAt: new Date(now.getTime() + 60_000)
  });

  await runWithRealForumWriteGrant({
    grant,
    signingSecret: secret,
    binding,
    now,
    action: async () => {
      assert.throws(
        () => assertRealForumWriteUnlocked(),
        new RegExp(REAL_FORUM_WRITE_LOCK_CODE)
      );
      assert.throws(
        () =>
          assertRealForumWriteUnlocked({
            ...binding,
            targetHash: hash("other-target")
          }),
        /REAL_FORUM_WRITE_GRANT_BINDING_MISMATCH/
      );
    }
  });
});

test("写授权进入作用域后过期仍不能在真实 mutation 边界消费", async () => {
  const issuedAt = new Date("2026-07-31T12:00:00.000Z");
  let current = new Date(issuedAt);
  const secret = Buffer.alloc(32, 11);
  const binding: RealForumWriteMutationBinding = {
    permitKey: hash("permit-expiry"),
    attemptId: "attempt-expiry",
    idempotencyKey: hash("idempotency-expiry"),
    targetHash: hash("target-expiry"),
    contentHash: hash("content-expiry"),
    containsForumText: false
  };
  const grant = issueRealForumWriteGrant({
    binding,
    signingSecret: secret,
    now: issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 1_000)
  });

  await runWithRealForumWriteGrant({
    grant,
    signingSecret: secret,
    binding,
    now: issuedAt,
    currentTime: () => current,
    action: async () => {
      current = new Date(issuedAt.getTime() + 1_000);
      assert.throws(
        () => assertRealForumWriteUnlocked(binding),
        /REAL_FORUM_WRITE_GRANT_INVALID_OR_EXPIRED/
      );
    }
  });
});

test("设置接口不能开启真实发布", async () => {
  const settingsRoute = await import("../../app/api/settings/route");
  const response = await settingsRoute.POST(
    trustedMutationRequest("/api/settings", {
      forumBaseUrl: "https://cmooc.bnu.edu.cn/cMOOC/home",
      loginUrl: "https://cmooc.bnu.edu.cn/cMOOC/home",
      postUrlPattern: "",
      replyEditorSelector: "",
      replySubmitSelector: "",
      replySuccessSelector: "",
      realPublishEnabled: true
    })
  );
  assert.equal(response.status, 423);
  assert.equal(
    (await response.json()).code,
    REAL_FORUM_WRITE_LOCK_CODE
  );
});

test("发布授权与发布路由在访问任务或远端传输前均返回 423", async () => {
  const [authorizeRoute, publishRoute] = await Promise.all([
    import("../../app/api/interventions/[id]/authorize-publish/route"),
    import("../../app/api/interventions/[id]/publish/route")
  ]);
  const authorizeResponse = await authorizeRoute.POST(
    trustedMutationRequest(
      "/api/interventions/nonexistent/authorize-publish",
      {}
    ),
    { params: { id: "nonexistent" } }
  );
  const publishResponse = await publishRoute.POST(
    trustedMutationRequest(
      "/api/interventions/nonexistent/publish",
      {}
    ),
    { params: { id: "nonexistent" } }
  );
  assert.equal(authorizeResponse.status, 423);
  assert.equal(publishResponse.status, 423);
  assert.equal(
    (await authorizeResponse.json()).code,
    REAL_FORUM_WRITE_LOCK_CODE
  );
  assert.equal(
    (await publishResponse.json()).code,
    REAL_FORUM_WRITE_LOCK_CODE
  );
});
