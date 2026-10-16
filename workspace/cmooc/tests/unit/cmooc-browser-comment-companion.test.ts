import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseCmoocBrowserCommentScrollSelector,
  decideCmoocBrowserCommentRequest,
  normalizeCmoocBrowserCommentRuntimeError,
  validateCmoocBrowserCommentCourseId,
  validateCmoocBrowserCommentPageSequence,
  validateCmoocBrowserCommentTimeoutMs,
  type CmoocBrowserCommentPageCapture
} from "../../lib/autonomy/cmooc-browser-comment-companion";

const ORIGIN = "https://forum.example.test";
const MODULE_ID = "module-001";

test("normalizes raw browser runtime failures without exposing their message", () => {
  const navigation = normalizeCmoocBrowserCommentRuntimeError(
    new Error(
      "page.goto: net::ERR_ABORTED at https://forum.example.test/private?token=fixture-secret"
    ),
    "NAVIGATION"
  );
  assert.equal(
    navigation.message,
    "CMOOC_BROWSER_COMMENT_COMPANION_NAVIGATION_FAILED"
  );
  assert.doesNotMatch(navigation.message, /private|token|fixture-secret/i);

  const timeout = normalizeCmoocBrowserCommentRuntimeError(
    Object.assign(new Error("locator timed out beside private content"), {
      name: "TimeoutError"
    }),
    "DOM_INSPECTION"
  );
  assert.equal(
    timeout.message,
    "CMOOC_BROWSER_COMMENT_COMPANION_DOM_INSPECTION_TIMEOUT"
  );

  const closed = normalizeCmoocBrowserCommentRuntimeError(
    new Error("Target page, context or browser has been closed"),
    "NATIVE_SCROLL"
  );
  assert.equal(
    closed.message,
    "CMOOC_BROWSER_COMMENT_COMPANION_BROWSER_SESSION_CLOSED"
  );

  const stable = new Error(
    "CMOOC_BROWSER_COMMENT_COMPANION_COURSE_ID_MISMATCH"
  );
  assert.equal(
    normalizeCmoocBrowserCommentRuntimeError(stable, "BROWSER_RUNTIME"),
    stable
  );
});

function page(
  current: number,
  records: unknown[],
  options: Partial<{ total: number; pages: number; size: number }> = {}
): CmoocBrowserCommentPageCapture {
  const size = options.size ?? 2;
  return {
    request: {
      method: "POST",
      url: `${ORIGIN}/cmooc-api/comment/list`,
      postData: JSON.stringify({
        moduleId: MODULE_ID,
        current,
        size,
        showReply: true
      })
    },
    response: {
      status: 200,
      body: {
        code: 200,
        data: {
          records,
          current,
          size,
          total: options.total ?? 3,
          pages: options.pages ?? 3
        }
      }
    }
  };
}

function happyPages(): CmoocBrowserCommentPageCapture[] {
  return [
    page(1, [
      {
        commentId: "root-a",
        commentContent: "first",
        replyList: [{ commentId: "reply-a", commentContent: "" }]
      }
    ]),
    page(2, [{ commentId: "root-b", commentContent: "second" }]),
    page(3, [{ commentId: "root-c", commentContent: "third" }])
  ];
}

test("validates a three-page native-scroll sequence and preserves tombstones", () => {
  const snapshot = validateCmoocBrowserCommentPageSequence({
    captures: happyPages(),
    expectedModuleId: MODULE_ID,
    maxComments: 10,
    blockedWriteRequestCount: 2
  });
  assert.equal(snapshot.items.length, 4);
  assert.equal(snapshot.items[1]?.contentStatus, "empty_or_deleted");
  assert.deepEqual(snapshot.receipt, {
    schemaVersion: "cmooc.browser-comment-companion-receipt.v1",
    source: "ui_native_infinite_scroll",
    expectedRootComments: 3,
    observedRootComments: 3,
    observedEventCount: 4,
    pageRequestCount: 3,
    terminalPage: 3,
    serverPages: 3,
    stableIds: true,
    parentClosure: true,
    zeroPageFailures: true,
    blockedWriteRequestCount: 2,
    sentMutationCount: 0,
    realPublishEnabled: false,
    externalWriteAttempted: false,
    containsForumText: false
  });
});

test("rejects a server reset to page one", () => {
  const captures = happyPages();
  captures[1] = page(1, [{ commentId: "root-b", commentContent: "second" }]);
  assert.throws(
    () =>
      validateCmoocBrowserCommentPageSequence({
        captures,
        expectedModuleId: MODULE_ID,
        maxComments: 10
      }),
    /REQUEST_PAGE_SEQUENCE_INVALID/
  );
});

test("rejects duplicate IDs crossing page boundaries", () => {
  const captures = happyPages();
  captures[1] = page(2, [{ commentId: "root-a", commentContent: "duplicate" }]);
  assert.throws(
    () =>
      validateCmoocBrowserCommentPageSequence({
        captures,
        expectedModuleId: MODULE_ID,
        maxComments: 10
      }),
    /COMMENT_ID_OVERLAP/
  );
});

test("rejects a missing explicit parent", () => {
  const captures = happyPages();
  captures[0] = page(1, [
    {
      commentId: "root-a",
      commentContent: "first",
      parentId: "missing-parent"
    }
  ]);
  assert.throws(
    () =>
      validateCmoocBrowserCommentPageSequence({
        captures,
        expectedModuleId: MODULE_ID,
        maxComments: 10
      }),
    /PARENT_CLOSURE_INVALID/
  );
});

test("rejects total/pages metadata drift", () => {
  const captures = happyPages();
  captures[2] = page(3, [{ commentId: "root-c", commentContent: "third" }], {
    total: 4
  });
  assert.throws(
    () =>
      validateCmoocBrowserCommentPageSequence({
        captures,
        expectedModuleId: MODULE_ID,
        maxComments: 10
      }),
    /PAGE_METADATA_DRIFT/
  );
});

test("keeps the request guard fail-closed", () => {
  assert.deepEqual(
    decideCmoocBrowserCommentRequest({
      url: `${ORIGIN}/cmooc-api/comment/list`,
      method: "POST",
      allowedOrigin: ORIGIN
    }),
    { action: "allow_comment_list_post" }
  );
  assert.deepEqual(
    decideCmoocBrowserCommentRequest({
      url: `${ORIGIN}/cmooc-api/comment/commentModule`,
      method: "POST",
      allowedOrigin: ORIGIN
    }),
    { action: "abort", code: "method_not_allowed" }
  );
  assert.deepEqual(
    decideCmoocBrowserCommentRequest({
      url: "https://other.example.test/cmooc-api/comment/list",
      method: "POST",
      allowedOrigin: ORIGIN
    }),
    { action: "abort", code: "origin_not_allowed" }
  );
  assert.deepEqual(
    decideCmoocBrowserCommentRequest({
      url: `${ORIGIN}/cmooc-api/comment/list?Satoken=secret`,
      method: "POST",
      allowedOrigin: ORIGIN
    }),
    { action: "abort", code: "sensitive_query_forbidden" }
  );
});

test("rejects course mismatch, limits, and invalid timeout before browser I/O", () => {
  assert.throws(
    () =>
      validateCmoocBrowserCommentCourseId({
        expectedCourseId: "course-a",
        observedCourseId: "course-b"
      }),
    /COURSE_ID_MISMATCH/
  );
  assert.throws(
    () =>
      validateCmoocBrowserCommentPageSequence({
        captures: happyPages(),
        expectedModuleId: MODULE_ID,
        maxComments: 3
      }),
    /MAX_COMMENTS_LIMIT/
  );
  assert.throws(
    () => validateCmoocBrowserCommentTimeoutMs(0),
    /TIMEOUT_INVALID/
  );
  assert.equal(validateCmoocBrowserCommentTimeoutMs(50), true);
});

test("selects the responsive scroll container before the legacy detail fallback", () => {
  assert.equal(
    chooseCmoocBrowserCommentScrollSelector({
      detailContentCount: 1,
      detailCount: 1
    }),
    ".detail_content"
  );
  assert.equal(
    chooseCmoocBrowserCommentScrollSelector({
      detailContentCount: 0,
      detailCount: 1
    }),
    ".detail"
  );
  assert.throws(
    () =>
      chooseCmoocBrowserCommentScrollSelector({
        detailContentCount: 0,
        detailCount: 0
      }),
    /DETAIL_CONTAINER_MISSING/
  );
});
