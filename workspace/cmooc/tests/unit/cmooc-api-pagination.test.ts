import assert from "node:assert/strict";
import test from "node:test";
import {
  createCmoocCommentPageCursor,
  createCmoocTopicPageCursor,
  fetchCmoocCommentPage,
  fetchCmoocSketchPostPage
} from "../../lib/forum/cmooc-api";

const SYNTHETIC_API_BASE = "https://cmooc.bnu.edu.cn/cmooc-api";
const SYNTHETIC_COURSE_ID = "fixture-course";
const SYNTHETIC_MODULE_ID = "fixture-module";
const SYNTHETIC_COLUMN_ID = "fixture-column";
const SYNTHETIC_POST_URL =
  `https://cmooc.bnu.edu.cn/cMOOC/detail?id=${SYNTHETIC_MODULE_ID}&type=SKETCH`;
const SYNTHETIC_FORUM_URL =
  `https://cmooc.bnu.edu.cn/cMOOC/course?courseId=${SYNTHETIC_COURSE_ID}`;

type JsonRecord = Record<string, unknown>;

const ENV_KEYS = [
  "CMOOC_API_BASE_URL",
  "CMOOC_WEB_BASE_URL"
] as const;

function jsonResponse(data: unknown): Response {
  return new Response(
    JSON.stringify({
      code: 200,
      data
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    }
  );
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestBody(init: RequestInit | undefined): JsonRecord {
  assert.ok(init);
  assert.equal(init.method, "POST");
  assert.ok(init.body);
  return JSON.parse(String(init.body)) as JsonRecord;
}

function assertNoLegacyPaginationFields(body: JsonRecord) {
  for (const field of ["page", "offset", "cursor"]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(body, field),
      false,
      `request body must not contain ${field}`
    );
  }
}

function snapshotEnvironment() {
  return Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]])
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>;
}

function restoreEnvironment(
  snapshot: Record<(typeof ENV_KEYS)[number], string | undefined>
) {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withFetchStub<T>(
  fetchStub: typeof fetch,
  run: () => Promise<T>
): Promise<T> {
  const previousFetch = globalThis.fetch;
  const environment = snapshotEnvironment();
  process.env.CMOOC_API_BASE_URL = SYNTHETIC_API_BASE;
  try {
    globalThis.fetch = fetchStub;
    return await run();
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(environment);
  }
}

function commentRecord(id: string, content: string) {
  return {
    commentId: id,
    userId: `fixture-actor-${id}`,
    userNickName: `fixture-author-${id}`,
    commentContent: content,
    createdTime: "2026-01-01T00:00:00.000Z"
  };
}

test("comment page sends the real current-based POST contract on the first request", async () => {
  const requests: Array<{ url: string; body: JsonRecord }> = [];
  const cursor = createCmoocCommentPageCursor({
    postUrl: SYNTHETIC_POST_URL,
    expectedCourseId: SYNTHETIC_COURSE_ID,
    pageSize: 2
  });

  await withFetchStub(
    async (input, init) => {
      const url = requestUrl(input);
      const body = requestBody(init);
      requests.push({ url, body });
      return jsonResponse({
        records: [commentRecord("fixture-comment-1", "fixture-comment-body-1")],
        current: 1,
        size: 2,
        total: 1,
        pages: 1
      });
    },
    async () => {
      const page = await fetchCmoocCommentPage({
        postUrl: SYNTHETIC_POST_URL,
        expectedCourseId: SYNTHETIC_COURSE_ID,
        pageSize: 2,
        cursor,
        token: "fixture"
      });
      assert.deepEqual(page.items.map((item) => item.id), ["fixture-comment-1"]);
      assert.equal(page.receipt.nextCursor, null);
    }
  );

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    `${SYNTHETIC_API_BASE}/comment/list`
  );
  assert.deepEqual(requests[0]?.body, {
    current: 1,
    size: 2,
    moduleId: SYNTHETIC_MODULE_ID,
    showReply: true,
    order: "better"
  });
  assertNoLegacyPaginationFields(requests[0]?.body ?? {});
});

test("comment cursor resumes at current two and terminates from pages metadata", async () => {
  const requests: Array<{ url: string; body: JsonRecord }> = [];
  const responses = [
    {
      records: [
        commentRecord("fixture-comment-a", "fixture-comment-body-a"),
        commentRecord("fixture-comment-b", "fixture-comment-body-b")
      ],
      current: 1,
      size: 2,
      total: 3,
      pages: 2
    },
    {
      records: [commentRecord("fixture-comment-c", "fixture-comment-body-c")],
      current: 2,
      size: 2,
      total: 3,
      pages: 2
    }
  ];
  const initialCursor = createCmoocCommentPageCursor({
    postUrl: SYNTHETIC_POST_URL,
    expectedCourseId: SYNTHETIC_COURSE_ID,
    pageSize: 2
  });

  await withFetchStub(
    async (input, init) => {
      const url = requestUrl(input);
      const body = requestBody(init);
      requests.push({ url, body });
      const response = responses.shift();
      assert.ok(response);
      return jsonResponse(response);
    },
    async () => {
      const first = await fetchCmoocCommentPage({
        postUrl: SYNTHETIC_POST_URL,
        expectedCourseId: SYNTHETIC_COURSE_ID,
        pageSize: 2,
        cursor: initialCursor,
        token: "fixture"
      });
      assert.ok(first.receipt.nextCursor);

      const second = await fetchCmoocCommentPage({
        postUrl: SYNTHETIC_POST_URL,
        expectedCourseId: SYNTHETIC_COURSE_ID,
        pageSize: 2,
        cursor: first.receipt.nextCursor,
        token: "fixture"
      });

      assert.deepEqual(
        first.items.map((item) => item.id),
        ["fixture-comment-a", "fixture-comment-b"]
      );
      assert.deepEqual(second.items.map((item) => item.id), ["fixture-comment-c"]);
      assert.equal(second.receipt.expected, 3);
      assert.equal(second.receipt.observed, 1);
      assert.equal(second.receipt.nextCursor, null);
      assert.equal(second.receipt.truncated, false);
    }
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, `${SYNTHETIC_API_BASE}/comment/list`);
  assert.equal(requests[1]?.url, `${SYNTHETIC_API_BASE}/comment/list`);
  assert.equal(requests[0]?.body.current, 1);
  assert.equal(requests[1]?.body.current, 2);
  assertNoLegacyPaginationFields(requests[0]?.body ?? {});
  assertNoLegacyPaginationFields(requests[1]?.body ?? {});
});

test("a repeated or drifted comment page position fails closed", async () => {
  const requests: Array<{ url: string; body: JsonRecord }> = [];
  const responses = [
    {
      records: [commentRecord("fixture-comment-a", "fixture-comment-body-a")],
      current: 1,
      size: 2,
      total: 2,
      pages: 2
    },
    {
      records: [commentRecord("fixture-comment-a", "fixture-comment-body-a")],
      current: 1,
      size: 2,
      total: 2,
      pages: 2
    }
  ];
  const initialCursor = createCmoocCommentPageCursor({
    postUrl: SYNTHETIC_POST_URL,
    expectedCourseId: SYNTHETIC_COURSE_ID,
    pageSize: 2
  });

  await withFetchStub(
    async (input, init) => {
      const url = requestUrl(input);
      const body = requestBody(init);
      requests.push({ url, body });
      const response = responses.shift();
      assert.ok(response);
      return jsonResponse(response);
    },
    async () => {
      const first = await fetchCmoocCommentPage({
        postUrl: SYNTHETIC_POST_URL,
        expectedCourseId: SYNTHETIC_COURSE_ID,
        pageSize: 2,
        cursor: initialCursor,
        token: "fixture"
      });
      assert.ok(first.receipt.nextCursor);

      await assert.rejects(
        fetchCmoocCommentPage({
          postUrl: SYNTHETIC_POST_URL,
          expectedCourseId: SYNTHETIC_COURSE_ID,
          pageSize: 2,
          cursor: first.receipt.nextCursor,
          token: "fixture"
        }),
        /CMOOC_PAGE_POSITION_MISMATCH/
      );
    }
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.body.current, 2);
  assertNoLegacyPaginationFields(requests[1]?.body ?? {});
});

test("comment receipts honor total/pages terminal metadata while enforcing current position", async () => {
  const requests: JsonRecord[] = [];
  const initialCursor = createCmoocCommentPageCursor({
    postUrl: SYNTHETIC_POST_URL,
    expectedCourseId: SYNTHETIC_COURSE_ID,
    pageSize: 2
  });

  await withFetchStub(
    async (input, init) => {
      assert.equal(requestUrl(input), `${SYNTHETIC_API_BASE}/comment/list`);
      const body = requestBody(init);
      requests.push(body);
      return jsonResponse({
        records: [commentRecord("fixture-comment-terminal", "fixture-terminal-body")],
        current: 1,
        size: 2,
        total: 1,
        pages: 1
      });
    },
    async () => {
      const page = await fetchCmoocCommentPage({
        postUrl: SYNTHETIC_POST_URL,
        expectedCourseId: SYNTHETIC_COURSE_ID,
        pageSize: 2,
        cursor: initialCursor,
        token: "fixture"
      });
      assert.equal(page.receipt.expected, 1);
      assert.equal(page.receipt.nextCursor, null);
      assert.equal(page.receipt.truncated, false);
    }
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.current, 1);
  assertNoLegacyPaginationFields(requests[0] ?? {});

  const totalOnlyRequests: JsonRecord[] = [];
  const totalOnlyResponses = [
    {
      records: [
        commentRecord("fixture-comment-total-a", "fixture-total-body-a"),
        commentRecord("fixture-comment-total-b", "fixture-total-body-b")
      ],
      current: 1,
      size: 2,
      total: 4
    },
    {
      records: [commentRecord("fixture-comment-total-only", "fixture-total-body")],
      current: 2,
      size: 2,
      total: 4
    }
  ];
  const secondCursor = createCmoocCommentPageCursor({
    postUrl: SYNTHETIC_POST_URL,
    expectedCourseId: SYNTHETIC_COURSE_ID,
    pageSize: 2
  });
  await withFetchStub(
    async (input, init) => {
      assert.equal(requestUrl(input), `${SYNTHETIC_API_BASE}/comment/list`);
      const body = requestBody(init);
      totalOnlyRequests.push(body);
      const response = totalOnlyResponses.shift();
      assert.ok(response);
      return jsonResponse(response);
    },
    async () => {
      const first = await fetchCmoocCommentPage({
        postUrl: SYNTHETIC_POST_URL,
        expectedCourseId: SYNTHETIC_COURSE_ID,
        pageSize: 2,
        cursor: secondCursor,
        token: "fixture"
      });
      assert.ok(first.receipt.nextCursor);

      const second = await fetchCmoocCommentPage({
        postUrl: SYNTHETIC_POST_URL,
        expectedCourseId: SYNTHETIC_COURSE_ID,
        pageSize: 2,
        cursor: first.receipt.nextCursor,
        token: "fixture"
      });
      assert.equal(second.receipt.expected, 4);
      assert.equal(second.receipt.nextCursor, null);
      assert.equal(second.receipt.truncated, false);
    }
  );
  assert.equal(totalOnlyRequests.length, 2);
  assert.equal(totalOnlyRequests[0]?.current, 1);
  assert.equal(totalOnlyRequests[1]?.current, 2);
});

test("topic pages use current for HTTP pagination without page, offset, or cursor aliases", async () => {
  const requests: Array<{ url: string; body: JsonRecord }> = [];
  const cursor = createCmoocTopicPageCursor({
    forumListUrl: SYNTHETIC_FORUM_URL,
    expectedCourseId: SYNTHETIC_COURSE_ID,
    columnId: SYNTHETIC_COLUMN_ID,
    pageSize: 2
  });

  await withFetchStub(
    async (input, init) => {
      const url = requestUrl(input);
      const body = requestBody(init);
      requests.push({ url, body });
      return jsonResponse({
        records: [
          {
            moduleId: "fixture-topic-1",
            moduleTitle: "fixture-topic-title",
            moduleContent: "fixture-topic-body",
            moduleComment: 1,
            moduleLike: 2,
            moduleCollect: 3,
            createdUserId: "fixture-topic-author",
            createdUserNickName: "fixture-topic-author-name",
            createdTime: "2026-01-01T00:00:00.000Z"
          }
        ],
        current: 1,
        size: 2,
        total: 1,
        pages: 1
      });
    },
    async () => {
      const page = await fetchCmoocSketchPostPage({
        forumListUrl: SYNTHETIC_FORUM_URL,
        expectedCourseId: SYNTHETIC_COURSE_ID,
        pageSize: 2,
        cursor,
        token: "fixture",
        columnId: SYNTHETIC_COLUMN_ID,
        columnName: "fixture-column-name"
      });
      assert.deepEqual(page.items.map((item) => item.titleCandidate), [
        "fixture-topic-title"
      ]);
      assert.equal(page.receipt.nextCursor, null);
    }
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, `${SYNTHETIC_API_BASE}/sketch/page`);
  assert.deepEqual(requests[0]?.body, {
    current: 1,
    size: 2,
    courseId: SYNTHETIC_COURSE_ID,
    columnId: SYNTHETIC_COLUMN_ID,
    orderBy: "new"
  });
  assertNoLegacyPaginationFields(requests[0]?.body ?? {});
});
