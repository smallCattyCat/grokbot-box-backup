import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_SCHEMA_VERSIONS,
  type ExecutionCommandV1
} from "../../lib/facilitation-protocol";
import {
  CmoocApiAdapter,
  CmoocBrowserDiagnosticAdapter,
  ForumAdapterRegistry,
  MockForumAdapter,
  SyntheticTimelineForumAdapter,
  assertAdapterManifest,
  assertAuthSummary,
  assertForumScope,
  assertPreflightReceipt,
  assertTargetRef,
  assertThreadPage,
  assertThreadRef,
  type BrowserDiagnosticProbe,
  type BrowserDiagnosticThreadDetail
} from "../../lib/forum-adapters";
import {
  defineForumAdapterConformanceSuite,
  type ForumAdapterConformanceFixture
} from "../contract/forum-adapter-conformance";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const LIST_URL =
  "https://cmooc.bnu.edu.cn/cMOOC/course?courseId=111111111111111111";
const THREAD_REF = "123456789012345678";
const COMMENT_REF = "987654321012345678";
const THREAD_URL =
  `https://cmooc.bnu.edu.cn/cMOOC/detail?id=${THREAD_REF}&type=SKETCH`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function browserDetail(
  contentText = "SECRET_BROWSER_CONFORMANCE_COMMENT"
): BrowserDiagnosticThreadDetail {
  return {
    locator: THREAD_URL,
    authorStableRef: "browser-author-001",
    titleText: "SECRET_BROWSER_CONFORMANCE_TITLE",
    contentText: "SECRET_BROWSER_CONFORMANCE_BODY",
    createdAt: "2025-12-31T22:00:00.000Z",
    editedAt: "2025-12-31T22:10:00.000Z",
    comments: [
      {
        stableCommentRef: COMMENT_REF,
        parentRef: null,
        authorStableRef: "browser-author-002",
        contentText,
        createdAt: "2025-12-31T22:20:00.000Z",
        editedAt: null
      }
    ]
  };
}

function browserFixture(): ForumAdapterConformanceFixture {
  let detail = browserDetail();
  const probe: BrowserDiagnosticProbe = {
    inspectAuth: async () => ({
      authenticated: true,
      readable: true
    }),
    readThreadList: async () => [
      {
        locator: THREAD_URL,
        titleText: "SECRET_BROWSER_CONFORMANCE_TITLE",
        visibleStateText: "SECRET_BROWSER_CONFORMANCE_STATE",
        replyCount: 1,
        latestEventAt: "2025-12-31T22:20:00.000Z"
      }
    ],
    readThreadDetail: async () => detail
  };
  const adapter = new CmoocBrowserDiagnosticAdapter({
    probe,
    clock: () => new Date(FIXED_NOW)
  });
  return {
    adapter,
    scope: {
      courseKey: "course:browser",
      platformCourseRef: "111111111111111111",
      locator: LIST_URL,
      limit: 10
    },
    targetRef: (thread) => ({
      thread,
      targetType: "comment",
      targetObject: "specific_participant",
      stableTargetRef: COMMENT_REF
    }),
    mutateTarget: () => {
      detail = browserDetail(
        "SECRET_BROWSER_CONFORMANCE_COMMENT_EDITED"
      );
    },
    forbiddenForumText: [
      "SECRET_BROWSER_CONFORMANCE_TITLE",
      "SECRET_BROWSER_CONFORMANCE_STATE",
      "SECRET_BROWSER_CONFORMANCE_BODY",
      "SECRET_BROWSER_CONFORMANCE_COMMENT",
      "SECRET_BROWSER_CONFORMANCE_COMMENT_EDITED"
    ],
    expectedTemporalEvidenceStatus: "as_of_unverified"
  };
}

function command(): ExecutionCommandV1 {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.executionCommand,
    commandId: "command:p4b2-contract",
    correlationId: "correlation:p4b2-contract",
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

defineForumAdapterConformanceSuite(
  "CmoocBrowserDiagnosticAdapter",
  browserFixture
);

test("registry 注册四个 adapter，真实外部写能力仍为零", () => {
  const clock = () => new Date(FIXED_NOW);
  const browser = browserFixture().adapter;
  const cmooc = new CmoocApiAdapter({
    dependencies: {
      clock,
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
      fetchThreads: async () => [],
      fetchThread: async () => {
        throw new Error("P4B2_TEST_FETCH_FORBIDDEN");
      }
    }
  });
  const mock = new MockForumAdapter({
    clock,
    threads: []
  });
  const timeline = new SyntheticTimelineForumAdapter({
    clock,
    timelines: []
  });
  const registry = new ForumAdapterRegistry()
    .register(browser)
    .register(cmooc)
    .register(mock)
    .register(timeline);
  assert.deepEqual(
    registry.manifests().map((manifest) => manifest.adapterId),
    [
      "cmooc.api",
      "cmooc.browser-diagnostic",
      "mock.forum",
      "synthetic.timeline"
    ]
  );
  assert.equal(registry.snapshot().adapterCount, 4);
  assert.equal(
    registry.snapshot().realExternalWriteAdapterCount,
    0
  );
});

test("browser adapter 拒绝 list 签发后被篡改的课程、locator 和稳定键", async () => {
  const fixture = browserFixture();
  const page = await fixture.adapter.listThreads(fixture.scope);
  const issued = page.items[0].threadRef;
  for (const tampered of [
    { ...issued, courseKey: "course:tampered" },
    {
      ...issued,
      platformCourseRef: "222222222222222222"
    },
    { ...issued, locator: `${issued.locator}&view=alternate` },
    { ...issued, stableThreadRef: "222222222222222222" }
  ]) {
    await assert.rejects(
      () => fixture.adapter.observeThread(tampered),
      /THREAD_REF_(?:NOT_ISSUED|MISMATCH)/
    );
  }
});

test("adapter 输入和输出对象拒绝未知字段", async () => {
  const fixture = browserFixture();
  assert.throws(
    () =>
      assertForumScope({
        ...fixture.scope,
        forumText: "SECRET"
      } as never),
    /INVALID_FORUM_SCOPE_FIELDS/
  );
  const page = await fixture.adapter.listThreads(fixture.scope);
  const thread = page.items[0].threadRef;
  assert.throws(
    () =>
      assertThreadRef({
        ...thread,
        authorName: "SECRET"
      } as never),
    /INVALID_THREAD_REF_FIELDS/
  );
  const target = fixture.targetRef(thread);
  assert.throws(
    () =>
      assertTargetRef({
        ...target,
        content: "SECRET"
      } as never),
    /INVALID_TARGET_REF_FIELDS/
  );

  const auth = await fixture.adapter.inspectAuth();
  assert.throws(
    () => assertAuthSummary({ ...auth, token: "SECRET" }),
    /INVALID_AUTH_SUMMARY_FIELDS/
  );
  assert.throws(
    () =>
      assertAuthSummary({
        ...auth,
        checkedAt: "01/02/2025 03:04:05"
      }),
    /INVALID_ADAPTER_TIME/
  );
  assert.throws(
    () =>
      assertThreadPage({
        ...page,
        items: [
          {
            ...page.items[0],
            titleText: "SECRET"
          }
        ]
      }),
    /INVALID_THREAD_SUMMARY_FIELDS/
  );
  assert.throws(
    () =>
      assertThreadPage({
        ...page,
        observedAt: "2025-02-30T00:00:00.000Z"
      }),
    /INVALID_ADAPTER_TIME/
  );
  assert.throws(
    () =>
      assertThreadPage({
        ...page,
        items: [
          {
            ...page.items[0],
            latestEventAt: "2026-01-01T00:00:00.001Z"
          }
        ]
      }),
    /EVENT_AFTER_OBSERVATION/
  );
  const preflight = await fixture.adapter.preflight(command());
  assert.throws(
    () =>
      assertPreflightReceipt({
        ...preflight,
        draftText: "SECRET"
      }),
    /INVALID_PREFLIGHT_RECEIPT_FIELDS/
  );
});

test("synthetic_only manifest 必须保持 mock、synthetic 命名和虚拟时钟边界", () => {
  const manifest = new SyntheticTimelineForumAdapter({
    clock: () => new Date(FIXED_NOW),
    timelines: []
  }).manifest();
  for (const invalid of [
    { ...manifest, transport: "api" as const },
    { ...manifest, platformId: "external.timeline" },
    { ...manifest, supportsVirtualClock: false }
  ]) {
    assert.throws(
      () => assertAdapterManifest(invalid),
      /INVALID_SYNTHETIC_ADAPTER_BOUNDARY/
    );
  }
});

test("manifest 的 nested capabilities 必须全部为 own exact fields", () => {
  const manifest = browserFixture().adapter.manifest();
  const capabilities = Object.assign(
    Object.create({ executeAuthorized: false }) as object,
    {
      inspectAuth: true,
      listThreads: true,
      observeThread: true,
      bindTarget: true,
      preflight: true
    }
  );
  assert.throws(
    () =>
      assertAdapterManifest({
        ...manifest,
        capabilities
      } as never),
    /INVALID_ADAPTER_CAPABILITIES/
  );
});
