import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PROTOCOL_SCHEMA_VERSIONS,
  canonicalProtocolHash,
  type ExecutionCommandV1
} from "../../lib/facilitation-protocol";
import {
  CmoocBrowserDiagnosticAdapter,
  type BrowserDiagnosticProbe,
  type BrowserDiagnosticThreadDetail
} from "../../lib/forum-adapters/cmooc-browser-diagnostic-adapter";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const THREAD_REF = "123456789012345678";
const COMMENT_REF = "987654321012345678";
const LIST_URL =
  "https://cmooc.bnu.edu.cn/cMOOC/course?courseId=111111111111111111";
const THREAD_URL =
  `https://cmooc.bnu.edu.cn/cMOOC/detail?id=${THREAD_REF}&type=SKETCH`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SECRET_TITLE = "SECRET_BROWSER_TITLE";
const SECRET_STATE = "SECRET_BROWSER_CARD_STATE";
const SECRET_BODY = "SECRET_BROWSER_BODY";
const SECRET_COMMENT = "SECRET_BROWSER_COMMENT";

function threadDetail(
  commentText = SECRET_COMMENT
): BrowserDiagnosticThreadDetail {
  return {
    locator: THREAD_URL,
    authorStableRef: "browser-author-001",
    titleText: SECRET_TITLE,
    contentText: SECRET_BODY,
    createdAt: "2025-12-31T22:00:00.000Z",
    editedAt: "2025-12-31T22:10:00.000Z",
    comments: [
      {
        stableCommentRef: COMMENT_REF,
        parentRef: null,
        authorStableRef: "browser-author-002",
        contentText: commentText,
        createdAt: "2025-12-31T22:20:00.000Z",
        editedAt: null
      }
    ]
  };
}

function fixture(): {
  adapter: CmoocBrowserDiagnosticAdapter;
  calls: string[];
  mutateComment: (text: string) => void;
} {
  const calls: string[] = [];
  let detail = threadDetail();
  const probe: BrowserDiagnosticProbe = {
    inspectAuth: async () => {
      calls.push("inspectAuth");
      return { authenticated: true, readable: true };
    },
    readThreadList: async ({ forumListUrl, maxThreads }) => {
      calls.push(`readThreadList:${forumListUrl}:${maxThreads}`);
      return [
        {
          locator: THREAD_URL,
          titleText: SECRET_TITLE,
          visibleStateText: SECRET_STATE,
          replyCount: 1,
          latestEventAt: "2025-12-31T22:20:00.000Z"
        }
      ];
    },
    readThreadDetail: async ({ threadUrl }) => {
      calls.push(`readThreadDetail:${threadUrl}`);
      return detail;
    }
  };
  return {
    adapter: new CmoocBrowserDiagnosticAdapter({
      probe,
      clock: () => new Date(FIXED_NOW)
    }),
    calls,
    mutateComment: (text) => {
      detail = threadDetail(text);
    }
  };
}

function executionCommand(): ExecutionCommandV1 {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.executionCommand,
    commandId: "command:browser-diagnostic",
    correlationId: "correlation:browser-diagnostic",
    capability: "forum.execute_authorized",
    taskRefHash: HASH_A,
    reviewBundleHash: HASH_B,
    authorizationRefHash: HASH_A,
    idempotencyKey: HASH_B,
    budgetReservationRefHash: HASH_A,
    expectedTargetHash: HASH_B,
    contentHash: HASH_A,
    gatewayPolicyVersion: "gateway.test.v1",
    issuedAt: "2025-12-31T23:55:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    containsForumText: false
  };
}

function assertNoForumText(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    SECRET_TITLE,
    SECRET_STATE,
    SECRET_BODY,
    SECRET_COMMENT,
    "SECRET_BROWSER_COMMENT_EDITED"
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
}

test("浏览器诊断 adapter 只调用注入的只读 probe 并输出去正文证据", async () => {
  const { adapter, calls, mutateComment } = fixture();
  const manifest = adapter.manifest();
  assert.equal(manifest.transport, "browser_diagnostic");
  assert.equal(manifest.externalWriteMode, "none");
  assert.equal(manifest.capabilities.executeAuthorized, false);

  const auth = await adapter.inspectAuth();
  const page = await adapter.listThreads({
    courseKey: "course:test",
    platformCourseRef: "111111111111111111",
    locator: LIST_URL,
    limit: 10
  });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].threadRef.stableThreadRef, THREAD_REF);
  assert.equal(page.items[0].replyCount, 1);
  assert.equal(
    page.items[0].latestEventAt,
    "2025-12-31T22:20:00.000Z"
  );

  const observation = await adapter.observeThread(
    page.items[0].threadRef
  );
  const targetRef = {
    thread: page.items[0].threadRef,
    targetType: "comment" as const,
    targetObject: "specific_participant" as const,
    stableTargetRef: COMMENT_REF
  };
  const firstBinding = await adapter.bindTarget(targetRef);
  mutateComment("SECRET_BROWSER_COMMENT_EDITED");
  const secondBinding = await adapter.bindTarget(targetRef);

  assert.equal(auth.canRead, true);
  assert.equal(auth.canExecuteAuthorized, false);
  assert.equal(observation.eventCount, 2);
  assert.equal(
    observation.temporalEvidenceStatus,
    "as_of_unverified"
  );
  assert.notEqual(
    secondBinding.targetVersionHash,
    firstBinding.targetVersionHash
  );
  assertNoForumText({
    manifest,
    auth,
    page,
    observation,
    firstBinding,
    secondBinding
  });
  assert.deepEqual(calls, [
    "inspectAuth",
    `readThreadList:${LIST_URL}:10`,
    `readThreadDetail:${THREAD_URL}`,
    `readThreadDetail:${THREAD_URL}`,
    `readThreadDetail:${THREAD_URL}`
  ]);
});

test("列表 observedAt 只在只读 probe 完成后取得", async () => {
  let probeCompleted = false;
  const probe: BrowserDiagnosticProbe = {
    inspectAuth: async () => ({
      authenticated: null,
      readable: true
    }),
    readThreadList: async () => {
      probeCompleted = true;
      return [];
    },
    readThreadDetail: async () => null
  };
  const adapter = new CmoocBrowserDiagnosticAdapter({
    probe,
    clock: () => {
      assert.equal(probeCompleted, true);
      return new Date(FIXED_NOW);
    }
  });
  const page = await adapter.listThreads({
    courseKey: "course:test",
    platformCourseRef: "111111111111111111",
    locator: LIST_URL
  });
  assert.equal(page.observedAt, FIXED_NOW.toISOString());
});

test("浏览器诊断 adapter 对 cursor、课程引用和缺失目标 fail closed", async () => {
  const { adapter } = fixture();
  const scope = {
    courseKey: "course:test",
    platformCourseRef: "111111111111111111",
    locator: LIST_URL,
    limit: 10
  };
  await assert.rejects(
    () => adapter.listThreads(scope, "opaque:cursor"),
    /CURSOR_UNSUPPORTED/
  );
  await assert.rejects(
    () =>
      adapter.listThreads({
        ...scope,
        platformCourseRef: "222222222222222222"
      }),
    /COURSE_REF_MISMATCH/
  );
  const page = await adapter.listThreads(scope);
  await assert.rejects(
    () =>
      adapter.bindTarget({
        thread: page.items[0].threadRef,
        targetType: "comment",
        targetObject: "specific_participant",
        stableTargetRef: "missing:comment"
      }),
    /COMMENT_TARGET_NOT_FOUND/
  );
});

test("浏览器诊断 adapter 在调用 probe 前拒绝 locator 查询凭据", async () => {
  const { adapter, calls } = fixture();
  await assert.rejects(
    () =>
      adapter.listThreads({
        courseKey: "course:test",
        platformCourseRef: "111111111111111111",
        locator: `${LIST_URL}&access_token=secret-token-value`
      }),
    /SENSITIVE_QUERY_FORBIDDEN/
  );
  assert.deepEqual(calls, []);
});

test("浏览器诊断 adapter 永远拒绝执行且幂等返回确认未尝试", async () => {
  const { adapter, calls } = fixture();
  const command = executionCommand();
  const preflight = await adapter.preflight(command);
  const first = await adapter.executeAuthorized(command);
  const second = await adapter.executeAuthorized(command);

  assert.equal(preflight.status, "denied");
  assert.equal(first.outcome, "confirmed_not_attempted");
  assert.equal(first.attemptedAt, null);
  assert.equal(first.remoteObjectRefHash, null);
  assert.deepEqual(second, first);
  assert.deepEqual(calls, []);
  assertNoForumText({ preflight, first });

  await assert.rejects(
    () =>
      adapter.executeAuthorized({
        ...command,
        contentHash: HASH_B
      }),
    /IDEMPOTENCY_KEY_CONFLICT/
  );
  assert.equal(
    canonicalProtocolHash(first.schemaVersion, first).length,
    64
  );
});

test("浏览器诊断实现不依赖页面写操作、截图或持久化入口", () => {
  const source = readFileSync(
    new URL(
      "../../lib/forum-adapters/cmooc-browser-diagnostic-adapter.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.doesNotMatch(source, /from\s+["']playwright["']/);
  assert.doesNotMatch(
    source,
    /\.(?:click|fill|press|submit|screenshot)\s*\(/
  );
  assert.doesNotMatch(
    source,
    /\b(?:writeFile|appendFile|createWriteStream)\s*\(/
  );
  assert.doesNotMatch(
    source,
    /\b(?:publishCmoocPostComment|publishCmoocCommentReply|publishReplyWithPlaywright|publishIntervention)\b/
  );
});
