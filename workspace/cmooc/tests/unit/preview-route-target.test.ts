import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

function trustedPost(pathname: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${pathname}`, {
    method: "POST",
    headers: {
      Host: "localhost:3000",
      Origin: "http://localhost:3000",
      "Content-Type": "application/json",
      "Sec-Fetch-Site": "same-origin"
    },
    body: JSON.stringify(body)
  });
}

test("旧预演调度入口没有显式论坛地址时拒绝启动", async () => {
  const route = await import(
    "../../app/api/auto-intervention/scheduler/route"
  );
  try {
    const response = await route.POST(
      trustedPost("/api/auto-intervention/scheduler", {
        action: "start"
      })
    );
    assert.equal(response.status, 400);
    assert.equal(
      (await response.json()).error,
      "PREVIEW_FORUM_LIST_URL_REQUIRED"
    );
  } finally {
    await route.POST(
      trustedPost("/api/auto-intervention/scheduler", {
        action: "stop"
      })
    );
  }
});

test("旧预演调度入口保留显式地址，并强制 dry-run 零发布", async () => {
  const route = await import(
    "../../app/api/auto-intervention/scheduler/route"
  );
  const forumListUrl = "https://example.test/cmooc/course";
  try {
    const response = await route.POST(
      trustedPost("/api/auto-intervention/scheduler", {
        action: "start",
        forumListUrl,
        runImmediately: false
      })
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.config?.forumListUrl, forumListUrl);
    assert.equal(payload.config?.mode, "dry_run");
    assert.equal(payload.config?.allowRealPublish, false);
  } finally {
    await route.POST(
      trustedPost("/api/auto-intervention/scheduler", {
        action: "stop"
      })
    );
  }
});

test("统一 operator 预演调度入口没有显式论坛地址时拒绝启动", async () => {
  const route = await import("../../app/api/operator/actions/route");
  try {
    const response = await route.POST(
      trustedPost("/api/operator/actions", {
        actionId: "start_preview_scheduler",
        input: {}
      })
    );
    assert.equal(response.status, 400);
    assert.equal(
      (await response.json()).error,
      "PREVIEW_FORUM_LIST_URL_REQUIRED"
    );
  } finally {
    await route.POST(
      trustedPost("/api/operator/actions", {
        actionId: "stop_preview_scheduler"
      })
    );
  }
});

test("统一 operator 预演调度入口保留显式地址，并强制 dry-run 零发布", async () => {
  const route = await import("../../app/api/operator/actions/route");
  const forumListUrl = "https://example.test/cmooc/course";
  try {
    const response = await route.POST(
      trustedPost("/api/operator/actions", {
        actionId: "start_preview_scheduler",
        input: {
          forumListUrl,
          runImmediately: false
        }
      })
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.result?.config?.forumListUrl, forumListUrl);
    assert.equal(payload.result?.config?.mode, "dry_run");
    assert.equal(payload.result?.config?.allowRealPublish, false);
  } finally {
    await route.POST(
      trustedPost("/api/operator/actions", {
        actionId: "stop_preview_scheduler"
      })
    );
  }
});

test("单次旧预演入口没有显式论坛地址时拒绝运行", async () => {
  const route = await import("../../app/api/auto-intervention/run/route");
  const response = await route.POST(
    trustedPost("/api/auto-intervention/run", {})
  );
  assert.equal(response.status, 400);
  assert.equal(
    (await response.json()).error,
    "PREVIEW_FORUM_LIST_URL_REQUIRED"
  );
});

test("课程 scope 不再内置固定课程标识作为隐式后备", async () => {
  const source = await readFile(
    path.resolve(process.cwd(), "lib/forum/course-scope.ts"),
    "utf8"
  );
  assert.doesNotMatch(source, /2059235676645744640/u);
  assert.match(source, /COURSE_SCOPE_PLATFORM_COURSE_ID_REQUIRED/u);
});
