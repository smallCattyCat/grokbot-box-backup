import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_SCHEMA_VERSIONS,
  canonicalProtocolHash,
  type ExecutionCommandV1
} from "../../lib/facilitation-protocol";
import type {
  CmoocApiPostDetail,
  CmoocApiScannedPost
} from "../../lib/forum/cmooc-api";
import {
  CmoocApiAdapter,
  ForumAdapterRegistry,
  MockForumAdapter,
  assertAdapterManifest,
  type AdapterManifest,
  type CmoocAuthStatusView,
  type MockForumThread
} from "../../lib/forum-adapters";
import {
  defineForumAdapterConformanceSuite,
  type ForumAdapterConformanceFixture
} from "../contract/forum-adapter-conformance";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const CMOOC_THREAD_REF = "123456789012345678";
const CMOOC_COMMENT_REF = "987654321012345678";
const CMOOC_LIST_URL =
  "https://cmooc.bnu.edu.cn/cMOOC/course?courseId=111111111111111111";
const CMOOC_POST_URL =
  `https://cmooc.bnu.edu.cn/cMOOC/detail?id=${CMOOC_THREAD_REF}&type=SKETCH`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function mockCommand(
  expectedTargetHash: string,
  suffix: string
): ExecutionCommandV1 {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.executionCommand,
    commandId: `command:${suffix}`,
    correlationId: `correlation:${suffix}`,
    capability: "forum.execute_authorized",
    taskRefHash: HASH_A,
    reviewBundleHash: HASH_B,
    authorizationRefHash: HASH_A,
    idempotencyKey: canonicalProtocolHash(
      "cmooc.test-idempotency-key.v1",
      { suffix }
    ),
    budgetReservationRefHash: HASH_A,
    expectedTargetHash,
    contentHash: HASH_B,
    gatewayPolicyVersion: "gateway.test.v1",
    issuedAt: "2025-12-31T23:55:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    containsForumText: false
  };
}

function mockThread(commentContent = "SECRET_MOCK_COMMENT"): MockForumThread {
  return {
    stableThreadRef: "mock-thread-001",
    courseKey: "course:test",
    platformCourseRef: "platform-course-test",
    locator: "mock://forum/mock-thread-001",
    authorRef: "mock-author-001",
    title: "SECRET_MOCK_TITLE",
    content: "SECRET_MOCK_BODY",
    createdAt: "2025-12-31T22:00:00.000Z",
    updatedAt: "2025-12-31T22:30:00.000Z",
    comments: [
      {
        stableCommentRef: "mock-comment-001",
        parentRef: null,
        authorRef: "mock-author-002",
        content: commentContent,
        createdAt: "2025-12-31T22:20:00.000Z"
      }
    ]
  };
}

function mockFixture(): ForumAdapterConformanceFixture {
  const adapter = new MockForumAdapter({
    clock: () => new Date(FIXED_NOW),
    threads: [mockThread()]
  });
  return {
    adapter,
    scope: {
      courseKey: "course:test",
      platformCourseRef: "platform-course-test",
      limit: 10
    },
    targetRef: (thread) => ({
      thread,
      targetType: "comment",
      targetObject: "specific_participant",
      stableTargetRef: "mock-comment-001"
    }),
    mutateTarget: () => {
      adapter.upsertThread(mockThread("SECRET_MOCK_COMMENT_EDITED"));
    },
    forbiddenForumText: [
      "SECRET_MOCK_TITLE",
      "SECRET_MOCK_BODY",
      "SECRET_MOCK_COMMENT",
      "SECRET_MOCK_COMMENT_EDITED"
    ]
  };
}

function cmoocFixture(): ForumAdapterConformanceFixture {
  const scannedPost: CmoocApiScannedPost = {
    url: CMOOC_POST_URL,
    titleCandidate: "SECRET_CMOOC_TITLE",
    cardText: "SECRET_CMOOC_CARD_BODY",
    sourceIndex: 0,
    commentCount: 1,
    createdTime: "2025-12-31T22:00:00.000Z"
  };
  let detail: CmoocApiPostDetail = {
    url: CMOOC_POST_URL,
    title: "SECRET_CMOOC_TITLE",
    authorPlatformId: "author-platform-001",
    authorName: "SECRET_CMOOC_AUTHOR",
    tags: ["SECRET_CMOOC_TAG"],
    content: "SECRET_CMOOC_BODY",
    editedAt: "2025-12-31T22:10:00.000Z",
    commentCount: 1,
    comments: [
      {
        id: CMOOC_COMMENT_REF,
        index: 0,
        parentId: null,
        depth: 0,
        authorPlatformId: "author-platform-002",
        authorName: "SECRET_CMOOC_COMMENT_AUTHOR",
        content: "SECRET_CMOOC_COMMENT",
        time: "2025-12-31T22:20:00.000Z"
      }
    ]
  };
  const authStatus: CmoocAuthStatusView = {
    readyForRealForumWrite: true,
    sources: {
      envSatoken: { configured: true, valid: true },
      partnerAccount: { configured: false, valid: null },
      playwrightStorageState: {
        exists: true,
        hasSatoken: true,
        valid: true
      }
    }
  };
  const adapter = new CmoocApiAdapter({
    dependencies: {
      clock: () => new Date(FIXED_NOW),
      inspectAuth: async () => authStatus,
      fetchThreads: async () => [scannedPost],
      fetchThread: async () => detail
    }
  });
  return {
    adapter,
    scope: {
      courseKey: "course:test",
      platformCourseRef: "111111111111111111",
      locator: CMOOC_LIST_URL,
      limit: 10
    },
    targetRef: (thread) => ({
      thread,
      targetType: "comment",
      targetObject: "specific_participant",
      stableTargetRef: CMOOC_COMMENT_REF
    }),
    mutateTarget: () => {
      detail = {
        ...detail,
        comments: detail.comments.map((comment) => ({
          ...comment,
          content: "SECRET_CMOOC_COMMENT_EDITED"
        }))
      };
    },
    forbiddenForumText: [
      "SECRET_CMOOC_TITLE",
      "SECRET_CMOOC_CARD_BODY",
      "SECRET_CMOOC_AUTHOR",
      "SECRET_CMOOC_TAG",
      "SECRET_CMOOC_BODY",
      "SECRET_CMOOC_COMMENT",
      "SECRET_CMOOC_COMMENT_EDITED"
    ]
  };
}

defineForumAdapterConformanceSuite("MockForumAdapter", mockFixture);
defineForumAdapterConformanceSuite("CmoocApiAdapter", cmoocFixture);

test("registry 拒绝重复 adapter，并冻结真实外部写 adapter 数为零", () => {
  const mock = mockFixture().adapter;
  const cmooc = cmoocFixture().adapter;
  const registry = new ForumAdapterRegistry()
    .register(mock)
    .register(cmooc);
  const snapshot = registry.snapshot();
  assert.equal(snapshot.adapterCount, 2);
  assert.equal(snapshot.realExternalWriteAdapterCount, 0);
  assert.equal(snapshot.containsForumText, false);
  assert.deepEqual(
    registry.manifests().map((manifest) => manifest.adapterId),
    ["cmooc.api", "mock.forum"]
  );
  assert.equal(registry.get("cmooc.api"), cmooc);
  assert.throws(() => registry.register(mock), /DUPLICATE/);
  assert.throws(() => registry.get("missing.adapter"), /UNKNOWN/);
});

test("cMOOC adapter 即使检测到有效登录态也不获得真实写能力", async () => {
  const adapter = cmoocFixture().adapter;
  const auth = await adapter.inspectAuth();
  assert.equal(auth.status, "authenticated");
  assert.equal(auth.canRead, true);
  assert.equal(auth.canExecuteAuthorized, false);
  assert.equal(adapter.manifest().externalWriteMode, "none");
  assert.equal(adapter.manifest().capabilities.executeAuthorized, false);
});

test("cMOOC adapter 拒绝课程引用与白名单 URL 不一致", async () => {
  const fixture = cmoocFixture();
  await assert.rejects(
    () =>
      fixture.adapter.listThreads({
        ...fixture.scope,
        platformCourseRef: "222222222222222222"
      }),
    /CMOOC_COURSE_REF_MISMATCH/
  );
});

test("cMOOC adapter 在 API 读取完成后记录 observedAt，并在读取前拒绝敏感 locator", async () => {
  let fetchCompleted = false;
  let fetchCount = 0;
  const adapter = new CmoocApiAdapter({
    dependencies: {
      clock: () => {
        assert.equal(fetchCompleted, true);
        return new Date(FIXED_NOW);
      },
      inspectAuth: async () => ({
        readyForRealForumWrite: false,
        sources: {
          envSatoken: { configured: false, valid: null },
          partnerAccount: { configured: false, valid: null },
          playwrightStorageState: {
            exists: false,
            hasSatoken: false,
            valid: null
          }
        }
      }),
      fetchThreads: async () => {
        fetchCount += 1;
        fetchCompleted = true;
        return [];
      },
      fetchThread: async () => {
        throw new Error("UNEXPECTED_THREAD_FETCH");
      }
    }
  });
  const page = await adapter.listThreads({
    courseKey: "course:test",
    platformCourseRef: "111111111111111111",
    locator: CMOOC_LIST_URL
  });
  assert.equal(page.observedAt, FIXED_NOW.toISOString());
  assert.equal(fetchCount, 1);

  fetchCompleted = false;
  await assert.rejects(
    () =>
      adapter.listThreads({
        courseKey: "course:test",
        platformCourseRef: "111111111111111111",
        locator: `${CMOOC_LIST_URL}&access_token=secret-token-value`
      }),
    /SENSITIVE_QUERY_FORBIDDEN/
  );
  assert.equal(fetchCount, 1);
});

test("cMOOC adapter 仅接受 listThreads 实际签发且未被篡改的引用", async () => {
  const fixture = cmoocFixture();
  const page = await fixture.adapter.listThreads(fixture.scope);
  const issued = page.items[0].threadRef;
  for (const tampered of [
    { ...issued, courseKey: "course:tampered" },
    {
      ...issued,
      platformCourseRef: "222222222222222222"
    },
    {
      ...issued,
      locator: `${issued.locator}&view=alternate`
    },
    { ...issued, stableThreadRef: "222222222222222222" }
  ]) {
    await assert.rejects(
      () => fixture.adapter.observeThread(tampered),
      /THREAD_REF_(?:NOT_ISSUED|MISMATCH)/
    );
  }
});

test("manifest 运行时校验拒绝未知字段", () => {
  const manifest = cmoocFixture().adapter.manifest();
  assert.throws(
    () =>
      assertAdapterManifest({
        ...manifest,
        unexpectedField: true
      } as AdapterManifest),
    /INVALID_ADAPTER_MANIFEST_FIELDS/
  );
});

test("mock adapter 明确区分结果不明、确认未发布和确认未尝试", async () => {
  for (const outcome of [
    "outcome_unknown",
    "confirmed_not_published",
    "confirmed_not_attempted"
  ] as const) {
    const adapter = new MockForumAdapter({
      clock: () => new Date(FIXED_NOW),
      threads: [mockThread()],
      executionOutcome: outcome
    });
    const page = await adapter.listThreads({
      courseKey: "course:test",
      platformCourseRef: "platform-course-test"
    });
    const bound = await adapter.bindTarget({
      thread: page.items[0].threadRef,
      targetType: "comment",
      targetObject: "specific_participant",
      stableTargetRef: "mock-comment-001"
    });
    const command = mockCommand(
      canonicalProtocolHash(bound.schemaVersion, bound),
      outcome
    );
    const receipt = await adapter.executeAuthorized(command);
    assert.equal(receipt.outcome, outcome);
    assert.equal(receipt.remoteObjectRefHash, null);
    assert.equal(
      receipt.attemptedAt === null,
      outcome === "confirmed_not_attempted"
    );
  }
});

test("mock adapter 拒绝同一幂等键绑定不同命令", async () => {
  const fixture = mockFixture();
  const adapter = fixture.adapter;
  const page = await adapter.listThreads(fixture.scope);
  const bound = await adapter.bindTarget(
    fixture.targetRef(page.items[0].threadRef)
  );
  const command = mockCommand(
    canonicalProtocolHash(bound.schemaVersion, bound),
    "conflict"
  );
  await adapter.executeAuthorized(command);
  await assert.rejects(
    () =>
      adapter.executeAuthorized({
        ...command,
        contentHash: HASH_A
      }),
    /IDEMPOTENCY_KEY_CONFLICT/
  );
});

test("mock adapter 的旧绑定不因重绑时钟变化失效，只因目标版本变化失效", async () => {
  let now = new Date(FIXED_NOW);
  const adapter = new MockForumAdapter({
    clock: () => new Date(now),
    threads: [mockThread()]
  });
  const page = await adapter.listThreads({
    courseKey: "course:test",
    platformCourseRef: "platform-course-test"
  });
  const targetRef = {
    thread: page.items[0].threadRef,
    targetType: "comment" as const,
    targetObject: "specific_participant" as const,
    stableTargetRef: "mock-comment-001"
  };
  const first = await adapter.bindTarget(targetRef);
  now = new Date("2026-01-01T00:05:00.000Z");
  const second = await adapter.bindTarget(targetRef);
  const firstHash = canonicalProtocolHash(first.schemaVersion, first);
  const secondHash = canonicalProtocolHash(
    second.schemaVersion,
    second
  );
  assert.notEqual(firstHash, secondHash);
  assert.equal(
    (await adapter.preflight(mockCommand(firstHash, "first-rebind")))
      .status,
    "ready"
  );
  assert.equal(
    (await adapter.preflight(mockCommand(secondHash, "second-rebind")))
      .status,
    "ready"
  );

  adapter.upsertThread(mockThread("SECRET_MOCK_COMMENT_EDITED"));
  assert.equal(
    (await adapter.preflight(mockCommand(firstHash, "first-edited")))
      .status,
    "target_changed"
  );
  assert.equal(
    (await adapter.preflight(mockCommand(secondHash, "second-edited")))
      .status,
    "target_changed"
  );
});

test("mock adapter 在固定虚拟时钟下排除未来事件并拒绝未来修订", async () => {
  const adapter = new MockForumAdapter({
    clock: () => new Date(FIXED_NOW),
    threads: [mockThread()]
  });
  const scope = {
    courseKey: "course:test",
    platformCourseRef: "platform-course-test"
  };
  const firstPage = await adapter.listThreads(scope);
  const threadRef = firstPage.items[0].threadRef;
  const firstObservation = await adapter.observeThread(threadRef);
  const firstBound = await adapter.bindTarget({
    thread: threadRef,
    targetType: "comment",
    targetObject: "specific_participant",
    stableTargetRef: "mock-comment-001"
  });

  adapter.upsertThread({
    ...mockThread(),
    comments: [
      ...mockThread().comments,
      {
        stableCommentRef: "mock-comment-future",
        parentRef: null,
        authorRef: "mock-author-future",
        content: "SECRET_MOCK_FUTURE_COMMENT",
        createdAt: "2026-01-01T00:10:00.000Z"
      }
    ]
  });
  const secondPage = await adapter.listThreads(scope);
  const secondObservation = await adapter.observeThread(threadRef);
  const secondBound = await adapter.bindTarget({
    thread: threadRef,
    targetType: "comment",
    targetObject: "specific_participant",
    stableTargetRef: "mock-comment-001"
  });
  assert.equal(secondPage.items[0].replyCount, 1);
  assert.equal(secondObservation.stateHash, firstObservation.stateHash);
  assert.equal(
    secondBound.targetVersionHash,
    firstBound.targetVersionHash
  );

  adapter.upsertThread({
    ...mockThread("SECRET_MOCK_FUTURE_REVISION"),
    comments: mockThread("SECRET_MOCK_FUTURE_REVISION").comments.map(
      (comment) => ({
        ...comment,
        updatedAt: "2026-01-01T00:10:00.000Z"
      })
    )
  });
  await assert.rejects(
    () => adapter.observeThread(threadRef),
    /COMMENT_REVISION_AFTER_OBSERVATION/
  );
  await assert.rejects(
    () =>
      adapter.bindTarget({
        thread: threadRef,
        targetType: "comment",
        targetObject: "specific_participant",
        stableTargetRef: "mock-comment-001"
      }),
    /COMMENT_REVISION_AFTER_OBSERVATION/
  );
});

test("mock adapter 按绝对时间而非 ISO 字符串顺序选择最新事件", async () => {
  const adapter = new MockForumAdapter({
    clock: () => new Date(FIXED_NOW),
    threads: [
      {
        ...mockThread(),
        updatedAt: "2025-12-31T23:30:00.000Z",
        comments: mockThread().comments.map((comment) => ({
          ...comment,
          createdAt: "2026-01-01T00:15:00.000+01:00"
        }))
      }
    ]
  });
  const page = await adapter.listThreads({
    courseKey: "course:test",
    platformCourseRef: "platform-course-test"
  });
  assert.equal(
    page.items[0].latestEventAt,
    "2025-12-31T23:30:00.000Z"
  );
});
