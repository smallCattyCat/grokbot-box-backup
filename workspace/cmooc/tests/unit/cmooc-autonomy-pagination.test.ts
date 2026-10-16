import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  COURSE_MANIFEST_SCHEMA_VERSION,
  COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION,
  parseCourseManifest,
  type CourseManifestTemplate
} from "../../lib/autonomy/course-manifest";
import {
  CmoocHybridShadowObserver,
  classifyCmoocCommentCompanionFailure,
  collectCmoocPages,
  parseCourseScanResumeCursor,
  type CourseScanResumeCursor
} from "../../lib/autonomy/platform-observer";
import {
  resolveServerRoleEvidence
} from "../../lib/autonomy/server-evidence";
import {
  normalizeObservedThread
} from "../../lib/world/live-event";
import type {
  AutonomyCandidate
} from "../../lib/autonomy/candidate-set";
import {
  assertCmoocCourseScope,
  createCmoocCommentPageCursor,
  createCmoocTopicPageCursor,
  normalizeCmoocCommentRecords,
  normalizeCmoocCourseMemberRecords,
  resolveCmoocApiBase,
  type CmoocApiPageReceipt,
  type CmoocApiScannedPost
} from "../../lib/forum/cmooc-api";

type Item = { id: string };

test("course member normalization keeps the platform display name beside the stable account id", () => {
  assert.deepEqual(
    normalizeCmoocCourseMemberRecords([
      {
        userId: "member-1",
        memberType: "LEARNER",
        userNickName: "张同学"
      },
      {
        userId: "member-2",
        memberType: "HELPER",
        userName: "李老师"
      },
      {
        userId: "member-3",
        memberType: "FOLLOWER"
      }
    ]),
    [
      {
        actorPlatformId: "member-1",
        memberType: "LEARNER",
        displayName: "张同学"
      },
      {
        actorPlatformId: "member-2",
        memberType: "HELPER",
        displayName: "李老师"
      },
      {
        actorPlatformId: "member-3",
        memberType: "FOLLOWER",
        displayName: null
      }
    ]
  );
});

function receipt(input: {
  requestCursor: string;
  nextCursor: string | null;
  expected: number | null;
  observed: number;
}): CmoocApiPageReceipt {
  return {
    ...input,
    truncated: input.nextCursor !== null,
    failure: null,
    containsForumText: false
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("comment companion retry taxonomy treats missing course validation as transient but preserves structural fail-closed errors", () => {
  assert.deepEqual(
    classifyCmoocCommentCompanionFailure(
      new Error(
        "CMOOC_BROWSER_COMMENT_COMPANION_COURSE_ID_UNVERIFIED"
      )
    ),
    { code: "course_id_unverified", retryable: true }
  );
  assert.deepEqual(
    classifyCmoocCommentCompanionFailure(
      new Error(
        "CMOOC_BROWSER_COMMENT_COMPANION_DETAIL_RESPONSE_TIMEOUT"
      )
    ),
    { code: "detail_response_timeout", retryable: true }
  );
  assert.deepEqual(
    classifyCmoocCommentCompanionFailure(
      new Error(
        "CMOOC_BROWSER_COMMENT_COMPANION_NEXT_COMMENT_PAGE_REQUEST_NOT_OBSERVED_AFTER_1_OF_2"
      )
    ),
    {
      code: "next_comment_page_request_not_observed",
      retryable: true
    }
  );
  assert.deepEqual(
    classifyCmoocCommentCompanionFailure(
      new Error(
        "CMOOC_BROWSER_COMMENT_COMPANION_COURSE_ID_MISMATCH"
      )
    ),
    { code: "course_id_mismatch", retryable: false }
  );
  assert.deepEqual(
    classifyCmoocCommentCompanionFailure(
      new Error(
        "CMOOC_BROWSER_COMMENT_COMPANION_PAGE_METADATA_DRIFT"
      )
    ),
    { code: "page_metadata_drift", retryable: false }
  );
  assert.deepEqual(
    classifyCmoocCommentCompanionFailure(
      new Error(
        "CMOOC_BROWSER_COMMENT_COMPANION_NAVIGATION_FAILED"
      )
    ),
    { code: "navigation_failed", retryable: true }
  );
  assert.deepEqual(
    classifyCmoocCommentCompanionFailure(
      new Error(
        "CMOOC_BROWSER_COMMENT_COMPANION_DOM_INSPECTION_TIMEOUT"
      )
    ),
    { code: "dom_inspection_timeout", retryable: true }
  );
  assert.deepEqual(
    classifyCmoocCommentCompanionFailure(
      new Error(
        "CMOOC_BROWSER_COMMENT_COMPANION_BROWSER_SESSION_CLOSED"
      )
    ),
    { code: "browser_session_closed", retryable: true }
  );
});

function fixtureManifest() {
  const courseId = "1234567890";
  const template: CourseManifestTemplate = {
    schemaVersion:
      COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION,
    alias: "pagination-course",
    platformId: "cmooc.bnu",
    courseIdSha256: sha256(courseId),
    canonicalOrigin: "https://cmooc.bnu.edu.cn",
    canonicalPath: "/cMOOC/course",
    timeZone: "Asia/Shanghai",
    defaultMode: "SHADOW",
    policyVersion: "test.shadow.v2",
    realPublishEnabled: false
  };
  return parseCourseManifest({
    template,
    sourcePath: "C:\\tmp\\pagination-course.json",
    value: {
      schemaVersion: COURSE_MANIFEST_SCHEMA_VERSION,
      alias: "pagination-course",
      platformId: "cmooc.bnu",
      courseId,
      canonicalUrl:
        `https://cmooc.bnu.edu.cn/cMOOC/course?courseId=${courseId}&isBack=1`,
      allowedOrigins: ["https://cmooc.bnu.edu.cn"],
      adapterId: "cmooc.api.v2",
      timeZone: "Asia/Shanghai",
      defaultMode: "SHADOW",
      policyVersion: "test.shadow.v2",
      scan: {
        maxThreadsPerTick: 10,
        maxCommentsPerThread: 10,
        pageSize: 2
      },
      budget: {
        dailySlots: 2,
        workloadCost: 1,
        authorTouchLimit30d: 2
      },
      schedule: {
        intervalMinutes: 30,
        leaseSeconds: 120
      },
      realPublishEnabled: false
    }
  });
}

test("bounded collector follows explicit cursors across multiple pages", async () => {
  const pages = new Map<string, Item[]>([
    ["page-1", [{ id: "a" }, { id: "b" }]],
    ["page-2", [{ id: "c" }]]
  ]);
  const result = await collectCmoocPages<Item>({
    initialCursor: "page-1",
    maxItems: 10,
    itemKey: (item: Item) => item.id,
    fetchPage: async (cursor) => ({
      items: pages.get(cursor) ?? [],
      receipt: receipt({
        requestCursor: cursor,
        nextCursor: cursor === "page-1" ? "page-2" : null,
        expected: 3,
        observed: pages.get(cursor)?.length ?? 0
      })
    })
  });

  assert.deepEqual(
    result.items.map((item) => item.id),
    ["a", "b", "c"]
  );
  assert.deepEqual(result.receipt, {
    expected: 3,
    observed: 3,
    nextCursor: null,
    truncation: false,
    failure: null,
    pageRequestCount: 2,
    containsForumText: false
  });
});

test("bounded collector isolates a duplicate page without looping", async () => {
  const result = await collectCmoocPages({
    initialCursor: "page-1",
    maxItems: 10,
    itemKey: (item: Item) => item.id,
    fetchPage: async (cursor) => ({
      items: [{ id: "a" }, { id: "b" }],
      receipt: receipt({
        requestCursor: cursor,
        nextCursor:
          cursor === "page-1" ? "page-2" : "page-3",
        expected: 4,
        observed: 2
      })
    })
  });

  assert.equal(result.receipt.failure, "duplicate_page");
  assert.equal(result.receipt.nextCursor, "page-2");
  assert.equal(result.receipt.truncation, true);
  assert.equal(result.receipt.pageRequestCount, 2);
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["a", "b"]
  );
});

test("bounded collector rejects partial cross-page overlap instead of counting it twice", async () => {
  const pages = new Map<string, Item[]>([
    ["page-1", [{ id: "a" }, { id: "b" }]],
    ["page-2", [{ id: "b" }, { id: "c" }]]
  ]);
  const result = await collectCmoocPages({
    initialCursor: "page-1",
    maxItems: 10,
    itemKey: (item: Item) => item.id,
    fetchPage: async (cursor) => ({
      items: pages.get(cursor) ?? [],
      receipt: receipt({
        requestCursor: cursor,
        nextCursor: cursor === "page-1" ? "page-2" : null,
        expected: 3,
        observed: pages.get(cursor)?.length ?? 0
      })
    })
  });

  assert.equal(result.receipt.failure, "page_item_overlap");
  assert.equal(result.receipt.nextCursor, "page-2");
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["a", "b"]
  );
});

test("bounded collector reports limit truncation with a resumable cursor", async () => {
  const result = await collectCmoocPages({
    initialCursor: "page-1",
    maxItems: 2,
    itemKey: (item: Item) => item.id,
    fetchPage: async (cursor) => ({
      items: [{ id: "a" }, { id: "b" }],
      receipt: receipt({
        requestCursor: cursor,
        nextCursor: "page-2",
        expected: 4,
        observed: 2
      })
    })
  });

  assert.equal(result.receipt.expected, 4);
  assert.equal(result.receipt.observed, 2);
  assert.equal(result.receipt.nextCursor, "page-2");
  assert.equal(result.receipt.truncation, true);
  assert.equal(result.receipt.failure, null);
});

test("bounded collector preserves the failed request cursor for retry", async () => {
  const result = await collectCmoocPages({
    initialCursor: "page-1",
    maxItems: 10,
    itemKey: (item: Item) => item.id,
    classifyFailure: () => "topic_page_failed",
    fetchPage: async (cursor) => {
      if (cursor === "page-2") throw new Error("network");
      return {
        items: [{ id: "a" }],
        receipt: receipt({
          requestCursor: cursor,
          nextCursor: "page-2",
          expected: 2,
          observed: 1
        })
      };
    }
  });

  assert.equal(result.receipt.observed, 1);
  assert.equal(result.receipt.nextCursor, "page-2");
  assert.equal(result.receipt.truncation, true);
  assert.equal(result.receipt.failure, "topic_page_failed");
  assert.equal(result.receipt.pageRequestCount, 2);
});

test("course scope check fails closed before a mismatched listing read", () => {
  assert.throws(
    () =>
      assertCmoocCourseScope({
        forumListUrl:
          "https://cmooc.bnu.edu.cn/cMOOC/course?courseId=1111111111",
        expectedCourseId: "2222222222"
      }),
    /CMOOC_COURSE_REF_MISMATCH/
  );
});

test("authenticated API base is pinned to the trusted HTTPS origin", () => {
  assert.equal(
    resolveCmoocApiBase(
      "https://cmooc.bnu.edu.cn/cmooc-api/"
    ),
    "https://cmooc.bnu.edu.cn/cmooc-api"
  );
  for (const value of [
    "http://cmooc.bnu.edu.cn/cmooc-api",
    "https://attacker.example/cmooc-api",
    "https://cmooc.bnu.edu.cn.attacker.example/cmooc-api",
    "https://user:password@cmooc.bnu.edu.cn/cmooc-api",
    "https://cmooc.bnu.edu.cn/other-api"
  ]) {
    assert.throws(
      () => resolveCmoocApiBase(value),
      /CMOOC_API_ORIGIN_NOT_ALLOWED/
    );
  }
});

test("resumable API cursors contain only versioned positions and scope hashes", () => {
  const courseId = "1234567890";
  const columnId = "RAW_COLUMN_PLATFORM_ID";
  const postId = "88888888";
  const topicCursor = createCmoocTopicPageCursor({
    forumListUrl:
      `https://cmooc.bnu.edu.cn/cMOOC/course?courseId=${courseId}`,
    expectedCourseId: courseId,
    columnId,
    pageSize: 25
  });
  const commentCursor = createCmoocCommentPageCursor({
    postUrl:
      `https://cmooc.bnu.edu.cn/cMOOC/detail?id=${postId}&type=SKETCH`,
    expectedCourseId: courseId,
    pageSize: 25
  });

  for (const cursor of [topicCursor, commentCursor]) {
    assert.match(cursor, /^cmooc\.page\.v1\./);
    assert.equal(cursor.includes(courseId), false);
    assert.equal(cursor.includes(columnId), false);
    assert.equal(cursor.includes(postId), false);
    const payload = JSON.parse(
      Buffer.from(cursor.split(".").at(-1) ?? "", "base64url")
        .toString("utf8")
    ) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(payload).sort(),
      ["kind", "page", "pageSize", "scopeHash", "v"]
    );
    assert.match(String(payload.scopeHash), /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(payload).includes(courseId), false);
    assert.equal(JSON.stringify(payload).includes(columnId), false);
    assert.equal(JSON.stringify(payload).includes(postId), false);
  }
});

test("hybrid observer emits complete safe pagination receipts without raw content or platform refs", async () => {
  const manifest = fixtureManifest();
  const posts: CmoocApiScannedPost[] = [
    {
      url: "https://cmooc.bnu.edu.cn/cMOOC/detail?id=11111111&type=SKETCH",
      titleCandidate: "RAW_TOPIC_TITLE_ONE",
      cardText: "RAW_TOPIC_BODY_ONE",
      sourceIndex: 0,
      commentCount: 1,
      createdTime: "2026-07-01 08:00:00"
    },
    {
      url: "https://cmooc.bnu.edu.cn/cMOOC/detail?id=22222222&type=SKETCH",
      titleCandidate: "RAW_TOPIC_TITLE_TWO",
      cardText: "RAW_TOPIC_BODY_TWO",
      sourceIndex: 1,
      commentCount: 0,
      createdTime: "2026-07-01 09:00:00"
    }
  ];
  let topicRequestCount = 0;
  const commentRequestCount = new Map<string, number>();
  const capturedOperatorIdentities: Array<{
    platformAccountId: string;
    displayName: string;
    source: string;
  }> = [];
  const observer = new CmoocHybridShadowObserver({
    inspectReadiness: async () => {
      throw new Error("browser unavailable");
    },
    getToken: async () => null,
    fetchMembers: async () => [
      {
        actorPlatformId: "RAW_AUTHOR_ID",
        memberType: "LEARNER",
        displayName: "RAW_MEMBER_NAME"
      }
    ],
    recordOperatorIdentities: async (input) => {
      capturedOperatorIdentities.push(...input.identities);
    },
    fetchColumns: async () => [
      {
        columnId: "RAW_COLUMN_ID",
        columnName: "RAW_COLUMN_NAME",
        columnType: "SKETCH",
        innerType: "",
        columnSort: 1,
        guidanceCaption: null
      }
    ],
    fetchTopicPage: async (input) => {
      topicRequestCount += 1;
      const item = posts[topicRequestCount - 1];
      return {
        items: item ? [item] : [],
        receipt: receipt({
          requestCursor: input.cursor ?? "",
          nextCursor:
            topicRequestCount === 1 ? "topic-page-2" : null,
          expected: 2,
          observed: item ? 1 : 0
        })
      };
    },
    fetchPostCore: async (input) => ({
      url: input.postUrl,
      title: "RAW_DETAIL_TITLE",
      courseId: manifest.courseId,
      authorPlatformId: "RAW_AUTHOR_ID",
      authorName: "RAW_AUTHOR_NAME",
      tags: [],
      content: "RAW_DETAIL_BODY",
      editedAt: "2026-07-01 08:00:00",
      commentCount: input.postUrl.includes("11111111") ? 1 : 0
    }),
    fetchCommentPage: async (input) => {
      const key = input.postUrl.includes("11111111")
        ? "first"
        : "second";
      const count = (commentRequestCount.get(key) ?? 0) + 1;
      commentRequestCount.set(key, count);
      if (key === "second") {
        return {
          items: [],
          receipt: receipt({
            requestCursor: input.cursor ?? "",
            nextCursor: null,
            expected: 0,
            observed: 0
          })
        };
      }
      return {
        items: [
          count === 1
            ? {
                id: "RAW_COMMENT_ID_ONE",
                index: 0,
                parentId: null,
                depth: 0,
                authorPlatformId: "RAW_COMMENT_AUTHOR_ONE",
                authorName: "RAW_COMMENT_NAME_ONE",
                content: "RAW_COMMENT_BODY_ONE",
                time: "2026-07-01 08:10:00"
              }
            : {
                id: "RAW_COMMENT_ID_TWO",
                index: 1,
                parentId: "RAW_COMMENT_ID_ONE",
                depth: 1,
                authorPlatformId: "RAW_COMMENT_AUTHOR_TWO",
                authorName: "RAW_COMMENT_NAME_TWO",
                content: "RAW_COMMENT_BODY_TWO",
                time: "2026-07-01 08:20:00"
              }
        ],
        receipt: receipt({
          requestCursor: input.cursor ?? "",
          nextCursor:
            count === 1 ? "comment-page-2" : null,
          expected: 1,
          observed: 1
        })
      };
    }
  });

  const observationSecret = Buffer.alloc(32, 4);
  const observation = await observer.observe({
    manifest,
    secret: observationSecret,
    observedAt: "2026-07-02T00:00:00.000Z"
  });

  assert.equal(topicRequestCount, 2);
  assert.equal(commentRequestCount.get("first"), 2);
  assert.equal(observation.coverage.discoveredThreadCount, 2);
  assert.equal(observation.coverage.expectedThreadCount, 2);
  assert.equal(observation.coverage.expectedCommentCount, 1);
  assert.equal(
    observation.coverage.apiReadAuthStatus,
    "anonymous"
  );
  assert.equal(observation.coverage.nextCursor, null);
  assert.equal(observation.coverage.paginationTruncated, false);
  assert.equal(observation.coverage.paginationFailureCount, 0);
  assert.deepEqual(
    {
      expected: observation.coverage.columnPagination?.expected,
      observed: observation.coverage.columnPagination?.observed,
      nextCursor:
        observation.coverage.columnPagination?.nextCursor,
      truncation:
        observation.coverage.columnPagination?.truncation,
      failure: observation.coverage.columnPagination?.failure
    },
    {
      expected: 1,
      observed: 1,
      nextCursor: null,
      truncation: false,
      failure: null
    }
  );
  assert.equal(
    observation.coverage.topicPagination?.[0]?.observed,
    2
  );
  assert.equal(
    observation.coverage.commentPagination?.[0]?.observed,
    1
  );
  assert.equal(
    observation.coverage.commentPagination?.[0]?.countDomain,
    "root_comments"
  );
  assert.equal(
    observation.coverage.commentPagination?.[0]
      ?.observedEventCount,
    2
  );
  assert.equal(observation.threads.length, 2);
  assert.deepEqual(
    capturedOperatorIdentities.map((identity) => ({
      platformAccountId: identity.platformAccountId,
      displayName: identity.displayName,
      source: identity.source
    })),
    [
      {
        platformAccountId: "RAW_AUTHOR_ID",
        displayName: "RAW_AUTHOR_NAME",
        source: "post_author"
      },
      {
        platformAccountId: "RAW_COMMENT_AUTHOR_ONE",
        displayName: "RAW_COMMENT_NAME_ONE",
        source: "reply_author"
      },
      {
        platformAccountId: "RAW_COMMENT_AUTHOR_TWO",
        displayName: "RAW_COMMENT_NAME_TWO",
        source: "reply_author"
      }
    ]
  );
  const registeredAuthor = observation.threads.find(
    (thread) => thread.kernelObservation.authorRole === "learner"
  );
  assert.ok(registeredAuthor);
  assert.match(
    registeredAuthor.kernelObservation.authorRoleEvidenceHash ?? "",
    /^[a-f0-9]{64}$/
  );
  assert.equal(
    resolveServerRoleEvidence({
      observation: registeredAuthor.kernelObservation,
      candidate: {
        threadKey: registeredAuthor.threadKey,
        authorKey: registeredAuthor.authorKey,
        targetVersionHash: registeredAuthor.targetVersionHash
      } as AutonomyCandidate,
      assessedAt: "2026-07-02T00:00:01.000Z",
      secret: observationSecret
    }).status,
    "verified"
  );

  const serialized = JSON.stringify(observation);
  for (const marker of [
    "RAW_COLUMN_ID",
    "RAW_COLUMN_NAME",
    "RAW_TOPIC_TITLE_ONE",
    "RAW_TOPIC_BODY_ONE",
    "RAW_DETAIL_BODY",
    "RAW_AUTHOR_ID",
    "RAW_COMMENT_ID_ONE",
    "RAW_COMMENT_AUTHOR_ONE",
    "RAW_COMMENT_BODY_ONE",
    "11111111",
    "22222222",
    manifest.courseId
  ]) {
    assert.equal(serialized.includes(marker), false, marker);
  }
});

test("hybrid observer isolates a detail course mismatch and continues safely", async () => {
  const manifest = fixtureManifest();
  const observer = new CmoocHybridShadowObserver({
    inspectReadiness: async () => {
      throw new Error("browser unavailable");
    },
    getToken: async () => null,
    fetchMembers: async () => [],
    fetchColumns: async () => [
      {
        columnId: "column",
        columnName: "column",
        columnType: "SKETCH",
        innerType: "",
        columnSort: 1,
        guidanceCaption: null
      }
    ],
    fetchTopicPage: async (input) => ({
      items: [
        {
          url: "https://cmooc.bnu.edu.cn/cMOOC/detail?id=33333333&type=SKETCH",
          titleCandidate: "TRANSIENT",
          cardText: "TRANSIENT",
          sourceIndex: 0,
          commentCount: 0,
          createdTime: "2026-07-01 08:00:00"
        }
      ],
      receipt: receipt({
        requestCursor: input.cursor ?? "",
        nextCursor: null,
        expected: 1,
        observed: 1
      })
    }),
    fetchPostCore: async (input) => ({
      url: input.postUrl,
      title: "TRANSIENT",
      courseId: "9999999999",
      authorPlatformId: null,
      authorName: "TRANSIENT",
      tags: [],
      content: "TRANSIENT",
      editedAt: "2026-07-01 08:00:00",
      commentCount: 0
    }),
    fetchCommentPage: async () => {
      throw new Error("must not read comments after mismatch");
    }
  });

  const observation = await observer.observe({
    manifest,
    secret: Buffer.alloc(32, 5),
    observedAt: "2026-07-02T00:00:00.000Z"
  });

  assert.equal(observation.threads.length, 0);
  assert.equal(observation.coverage.failedTargetCount, 1);
  assert.equal(
    observation.coverage.failureCodeCounts.course_scope_mismatch,
    1
  );
  assert.equal(
    observation.coverage.commentPagination?.[0]?.failure,
    "course_scope_mismatch"
  );
  assert.notEqual(
    observation.coverage.commentPagination?.[0]?.nextCursor,
    null
  );
});

test("hybrid observer resumes a hash-scoped topic cursor on the next tick", async () => {
  const baseManifest = fixtureManifest();
  const manifest = {
    ...baseManifest,
    scan: {
      ...baseManifest.scan,
      maxThreadsPerTick: 1
    }
  };
  const advanceCursor = (cursor: string) => {
    const prefix = "cmooc.page.v1.";
    const payload = JSON.parse(
      Buffer.from(cursor.slice(prefix.length), "base64url")
        .toString("utf8")
    ) as Record<string, unknown>;
    payload.page = Number(payload.page) + 1;
    return (
      prefix +
      Buffer.from(JSON.stringify(payload), "utf8").toString(
        "base64url"
      )
    );
  };
  const requestedTopicCursors: string[] = [];
  const observer = new CmoocHybridShadowObserver({
    inspectReadiness: async () => {
      throw new Error("browser unavailable");
    },
    getToken: async () => null,
    fetchMembers: async () => [],
    fetchColumns: async () => [
      {
        columnId: "TRANSIENT_COLUMN",
        columnName: "TRANSIENT_COLUMN",
        columnType: "SKETCH",
        innerType: "",
        columnSort: 1,
        guidanceCaption: null
      }
    ],
    fetchTopicPage: async (input) => {
      const cursor = input.cursor ?? "";
      requestedTopicCursors.push(cursor);
      const payload = JSON.parse(
        Buffer.from(
          cursor.slice("cmooc.page.v1.".length),
          "base64url"
        ).toString("utf8")
      ) as { page: number };
      const page = payload.page;
      return {
        items: [
          {
            url:
              `https://cmooc.bnu.edu.cn/cMOOC/detail?id=${page === 1 ? "44444444" : "55555555"}&type=SKETCH`,
            titleCandidate: "TRANSIENT",
            cardText: "TRANSIENT",
            sourceIndex: page - 1,
            commentCount: 0,
            createdTime: "2026-07-01 08:00:00"
          }
        ],
        receipt: receipt({
          requestCursor: cursor,
          nextCursor:
            page === 1 ? advanceCursor(cursor) : null,
          expected: 2,
          observed: 1
        })
      };
    },
    fetchPostCore: async (input) => ({
      url: input.postUrl,
      title: "TRANSIENT",
      courseId: manifest.courseId,
      authorPlatformId: "TRANSIENT_AUTHOR",
      authorName: "TRANSIENT",
      tags: [],
      content: "TRANSIENT",
      editedAt: "2026-07-01 08:00:00",
      commentCount: 0
    }),
    fetchCommentPage: async (input) => ({
      items: [],
      receipt: receipt({
        requestCursor: input.cursor ?? "",
        nextCursor: null,
        expected: 0,
        observed: 0
      })
    })
  });
  let persistedCursor: CourseScanResumeCursor | undefined;
  const first = await observer.observe({
    manifest,
    secret: Buffer.alloc(32, 6),
    observedAt: "2026-07-02T00:00:00.000Z",
    onProgress: async (cursor) => {
      persistedCursor = cursor;
    }
  });
  assert.equal(first.coverage.truncatedThreadListing, true);
  assert.ok(persistedCursor);
  assert.ok(
    Object.values(persistedCursor.scopeCursors).some(
      (cursor) => cursor === requestedTopicCursors[0]
        ? false
        : cursor.startsWith("cmooc.page.v1.")
    )
  );
  const parsed = parseCourseScanResumeCursor(
    JSON.parse(JSON.stringify(persistedCursor))
  );
  assert.ok(parsed);

  const second = await observer.observe({
    manifest,
    secret: Buffer.alloc(32, 6),
    observedAt: "2026-07-02T00:30:00.000Z",
    resumeCursor: parsed ?? undefined
  });
  assert.equal(requestedTopicCursors.length, 2);
  assert.notEqual(
    requestedTopicCursors[1],
    requestedTopicCursors[0]
  );
  assert.equal(second.coverage.discoveredThreadCount, 1);
  assert.equal(
    second.coverage.topicPagination?.[0]?.observed,
    2
  );
  assert.equal(
    second.coverage.topicPagination?.[0]?.nextCursor,
    null
  );
});

test("hybrid observer isolates a comment position mismatch per thread", async () => {
  const manifest = fixtureManifest();
  const posts = ["66666666", "77777777"].map(
    (id, sourceIndex): CmoocApiScannedPost => ({
      url:
        `https://cmooc.bnu.edu.cn/cMOOC/detail?id=${id}&type=SKETCH`,
      titleCandidate: "TRANSIENT",
      cardText: "TRANSIENT",
      sourceIndex,
      authorPlatformId: `TRANSIENT_AUTHOR_${sourceIndex}`,
      commentCount: 4,
      createdTime: "2026-07-01 08:00:00"
    })
  );
  const requestsByPost = new Map<string, number>();
  const observer = new CmoocHybridShadowObserver({
    inspectReadiness: async () => {
      throw new Error("browser unavailable");
    },
    getToken: async () => null,
    fetchMembers: async () => [],
    fetchColumns: async () => [
      {
        columnId: "TRANSIENT_COLUMN",
        columnName: "TRANSIENT_COLUMN",
        columnType: "SKETCH",
        innerType: "",
        columnSort: 1,
        guidanceCaption: null
      }
    ],
    fetchTopicPage: async (input) => ({
      items: posts,
      receipt: receipt({
        requestCursor: input.cursor ?? "",
        nextCursor: null,
        expected: 2,
        observed: 2
      })
    }),
    fetchPostCore: async (input) => ({
      url: input.postUrl,
      title: "TRANSIENT",
      courseId: manifest.courseId,
      authorPlatformId: input.postUrl.includes("66666666")
        ? "TRANSIENT_AUTHOR_0"
        : "TRANSIENT_AUTHOR_1",
      authorName: "TRANSIENT",
      tags: [],
      content: "TRANSIENT",
      editedAt: "2026-07-01 08:00:00",
      commentCount: 4
    }),
    openCommentCompanion: async () => {
      throw new Error("fixture companion unavailable");
    },
    fetchCommentPage: async (input) => {
      const postKey = input.postUrl.includes("66666666")
        ? "first"
        : "second";
      const requestCount = (requestsByPost.get(postKey) ?? 0) + 1;
      requestsByPost.set(postKey, requestCount);
      if (postKey === "first" && requestCount === 2) {
        throw new Error("CMOOC_PAGE_POSITION_MISMATCH");
      }
      const pageTwo = requestCount === 2;
      return {
        items: [
          {
            id: `${postKey}-comment-${pageTwo ? "c" : "a"}`,
            index: 0,
            parentId: null,
            depth: 0,
            authorPlatformId: `${postKey}-actor-a`,
            authorName: "TRANSIENT",
            content: "TRANSIENT",
            time: "2026-07-01 08:10:00"
          },
          {
            id: `${postKey}-comment-${pageTwo ? "d" : "b"}`,
            index: 1,
            parentId: null,
            depth: 0,
            authorPlatformId: `${postKey}-actor-b`,
            authorName: "TRANSIENT",
            content: "TRANSIENT",
            time: "2026-07-01 08:20:00"
          }
        ],
        receipt: receipt({
          requestCursor: input.cursor ?? "",
          nextCursor: pageTwo ? null : "comment-page-2",
          expected: 4,
          observed: 2
        })
      };
    }
  });

  const observation = await observer.observe({
    manifest,
    secret: Buffer.alloc(32, 14),
    observedAt: "2026-07-02T00:00:00.000Z"
  });

  assert.equal(requestsByPost.get("first"), 2);
  assert.equal(requestsByPost.get("second"), 2);
  assert.equal(
    observation.coverage.failureCodeCounts
      .comment_pagination_position_ignored,
    1
  );
  assert.equal(observation.coverage.incompleteCommentThreadCount, 1);
  assert.equal(
    observation.coverage.failureCodeCounts
      .comment_browser_companion_failed,
    1
  );
  assert.equal(
    observation.threads.filter(
      (thread) =>
        thread.kernelObservation.commentCompleteness === "visible_only"
    ).length,
    1
  );
  assert.equal(
    observation.threads.filter(
      (thread) =>
        thread.kernelObservation.commentCompleteness === "complete"
    ).length,
    1
  );
  assert.equal(
    observation.coverage.commentPagination?.filter(
      (receipt) => receipt.failure === null
    ).length,
    1
  );
  assert.equal(
    observation.coverage.commentPagination?.filter(
      (receipt) =>
        receipt.failure === "comment_pagination_position_ignored"
    ).length,
    1
  );
  assert.equal(
    observation.coverage.commentPagination?.find(
      (receipt) => receipt.failure === null
    )?.truncation,
    false
  );
});

test("hybrid observer retries transient failures and replaces one closed browser session", async () => {
  const manifest = fixtureManifest();
  const posts = ["86666666", "87777777"].map(
    (id, sourceIndex): CmoocApiScannedPost => ({
      url:
        `https://cmooc.bnu.edu.cn/cMOOC/detail?id=${id}&type=SKETCH`,
      titleCandidate: "TRANSIENT",
      cardText: "TRANSIENT",
      sourceIndex,
      authorPlatformId: `TRANSIENT_AUTHOR_${sourceIndex}`,
      commentCount: 4,
      createdTime: "2026-07-01 08:00:00"
    })
  );
  const requestsByPost = new Map<string, number>();
  let companionOpenCount = 0;
  let companionReadCount = 0;
  let companionCloseCount = 0;
  const companionReadsByPost = new Map<string, number>();
  const comment = (postKey: string, suffix: string, index: number) => ({
    id: `${postKey}-comment-${suffix}`,
    index,
    parentId: null,
    depth: 0,
    authorPlatformId: `${postKey}-actor-${suffix}`,
    authorName: "TRANSIENT",
    content: "TRANSIENT",
    contentStatus: "present" as const,
    time: "2026-07-01 08:10:00"
  });
  const observer = new CmoocHybridShadowObserver({
    inspectReadiness: async () => ({
      canonicalUrl: manifest.canonicalUrl,
      receipt: {
        schemaVersion: "cmooc.ui-readiness-receipt.v1",
        observedAt: "2026-07-02T00:00:00.000Z",
        transport: "ui_native_browser",
        targetOrigin: "https://cmooc.bnu.edu.cn",
        targetPath: "/cMOOC/course",
        targetLocatorHash: "fixture-locator-hash",
        normalizationSource: "exact_url",
        inputWasNormalized: false,
        browserRuntime: "playwright_chromium",
        status: "overview_ready",
        safeToDemonstrate: true,
        courseShellDetected: true,
        categoryTabCount: 1,
        visibleCardCount: 2,
        visibleCardKeys: ["fixture-card-a", "fixture-card-b"],
        selectedThreadKey: null,
        detailEvidenceLevel: "none",
        sessionBoundary: "authenticated_or_unknown",
        detailObservation: "no_cards",
        apiAssistKinds: [],
        allowedGetOrHeadCount: 1,
        allowedSemanticReadPostCount: 0,
        blockedWriteRequestCount: 0,
        blockedCrossOriginRequestCount: 0,
        requestedMutationCount: 0,
        sentMutationCount: 0,
        networkGuardActive: true,
        requestPolicy: "READ_ONLY_ENDPOINT_ALLOWLIST",
        realPublishEnabled: false,
        externalWriteAttempted: false,
        containsForumText: false
      },
      evidenceHash: "fixture-readiness-evidence-hash",
      receiptPath: "fixture-readiness-receipt.json"
    }),
    getToken: async () => null,
    fetchMembers: async () => [],
    fetchColumns: async () => [
      {
        columnId: "TRANSIENT_COLUMN",
        columnName: "TRANSIENT_COLUMN",
        columnType: "SKETCH",
        innerType: "",
        columnSort: 1,
        guidanceCaption: null
      }
    ],
    fetchTopicPage: async (input) => ({
      items: posts,
      receipt: receipt({
        requestCursor: input.cursor ?? "",
        nextCursor: null,
        expected: 2,
        observed: 2
      })
    }),
    fetchPostCore: async (input) => ({
      url: input.postUrl,
      title: "TRANSIENT",
      courseId: manifest.courseId,
      authorPlatformId: input.postUrl.includes("86666666")
        ? "TRANSIENT_AUTHOR_0"
        : "TRANSIENT_AUTHOR_1",
      authorName: "TRANSIENT",
      tags: [],
      content: "TRANSIENT",
      editedAt: "2026-07-01 08:00:00",
      commentCount: 4
    }),
    fetchCommentPage: async (input) => {
      const postKey = input.postUrl.includes("86666666")
        ? "first"
        : "second";
      const requestCount = (requestsByPost.get(postKey) ?? 0) + 1;
      requestsByPost.set(postKey, requestCount);
      if (requestCount === 2) {
        throw new Error("CMOOC_PAGE_POSITION_MISMATCH");
      }
      const pageTwo = requestCount === 2;
      return {
        items: [
          comment(postKey, pageTwo ? "c" : "a", 0),
          comment(postKey, pageTwo ? "d" : "b", 1)
        ],
        receipt: receipt({
          requestCursor: input.cursor ?? "",
          nextCursor: pageTwo ? null : "comment-page-2",
          expected: 4,
          observed: 2
        })
      };
    },
    openCommentCompanion: async (openInput) => {
      companionOpenCount += 1;
      const generation = companionOpenCount;
      assert.equal(
        openInput.browserChannel,
        generation === 1
          ? "bundled_chromium"
          : "system_chrome"
      );
      let browserSessionClosed = false;
      return {
        readThread: async (input) => {
          companionReadCount += 1;
          assert.equal(input.expectedCourseId, manifest.courseId);
          assert.equal(input.maxComments, 10);
          if (browserSessionClosed) {
            throw new Error(
              "CMOOC_BROWSER_COMMENT_COMPANION_BROWSER_SESSION_CLOSED"
            );
          }
          const postKey = input.postUrl.includes("86666666")
            ? "first"
            : "second";
          const postReadCount =
            (companionReadsByPost.get(postKey) ?? 0) + 1;
          companionReadsByPost.set(postKey, postReadCount);
          if (postKey === "first" && postReadCount === 1) {
            throw new Error(
              "CMOOC_BROWSER_COMMENT_COMPANION_COURSE_ID_UNVERIFIED"
            );
          }
          if (
            postKey === "second" &&
            generation === 1
          ) {
            browserSessionClosed = true;
            throw new Error(
              "CMOOC_BROWSER_COMMENT_COMPANION_BROWSER_SESSION_CLOSED"
            );
          }
          return {
            items: [
              comment(postKey, "a", 0),
              comment(postKey, "b", 1),
              comment(postKey, "c", 2),
              comment(postKey, "d", 3)
            ],
            receipt: {
              schemaVersion:
                "cmooc.browser-comment-companion-receipt.v1",
              source: "ui_native_infinite_scroll",
              expectedRootComments: 4,
              observedRootComments: 4,
              observedEventCount: 4,
              pageRequestCount: 2,
              terminalPage: 2,
              serverPages: 2,
              stableIds: true,
              parentClosure: true,
              zeroPageFailures: true,
              blockedWriteRequestCount: 0,
              sentMutationCount: 0,
              realPublishEnabled: false,
              externalWriteAttempted: false,
              containsForumText: false
            }
          };
        },
        close: async () => {
          companionCloseCount += 1;
        }
      };
    }
  });

  const observation = await observer.observe({
    manifest,
    secret: Buffer.alloc(32, 18),
    observedAt: "2026-07-02T00:00:00.000Z"
  });

  assert.equal(companionOpenCount, 2);
  assert.equal(companionReadCount, 4);
  assert.equal(companionCloseCount, 2);
  assert.equal(observation.coverage.complete, true);
  assert.equal(observation.coverage.incompleteCommentThreadCount, 0);
  assert.equal(
    observation.coverage.failureCodeCounts
      .comment_pagination_position_ignored,
    undefined
  );
  assert.equal(
    observation.coverage.failureCodeCounts
      .comment_browser_companion_failed,
    undefined
  );
  assert.equal(
    observation.coverage.recoveryCodeCounts
      .comment_browser_companion_recovered,
    2
  );
  assert.equal(
    observation.coverage.recoveryCodeCounts
      .comment_browser_companion_retry_recovered,
    2
  );
  const recoveredReceipt =
    observation.coverage.commentPagination?.find(
      (item) =>
        item.transport === "ui_native_infinite_scroll"
    );
  assert.ok(recoveredReceipt);
  assert.equal(recoveredReceipt.failure, null);
  assert.equal(recoveredReceipt.truncation, false);
  assert.equal(recoveredReceipt.expected, 4);
  assert.equal(recoveredReceipt.observed, 4);
  assert.equal(recoveredReceipt.apiPageRequestCount, 2);
  assert.equal(recoveredReceipt.companionAttemptCount, 2);
  assert.equal(recoveredReceipt.companionFailedAttemptCount, 1);
  assert.deepEqual(recoveredReceipt.companionFailureCodes, [
    "course_id_unverified"
  ]);
  assert.equal(recoveredReceipt.pageRequestCount, 4);
  assert.equal(
    recoveredReceipt.companionReceipt?.parentClosure,
    true
  );
  assert.equal(
    observation.coverage.commentPagination?.filter(
      (item) => item.failure === null
    ).length,
    2
  );
});

test("autonomy comment parser preserves an empty structural parent and its child edges", () => {
  const comments = normalizeCmoocCommentRecords({
    records: [
      {
        commentId: "RAW_EMPTY_PARENT",
        createdUserId: "RAW_PARENT_AUTHOR",
        commentContent: "",
        createdTime: "2026-07-01 08:10:00",
        replyList: [
          {
            commentId: "RAW_CHILD_ONE",
            createdUserId: "RAW_CHILD_AUTHOR_ONE",
            commentContent: "RAW_CHILD_BODY_ONE",
            createdTime: "2026-07-01 08:11:00"
          },
          {
            commentId: "RAW_CHILD_TWO",
            createdUserId: "RAW_CHILD_AUTHOR_TWO",
            commentContent: "RAW_CHILD_BODY_TWO",
            createdTime: "2026-07-01 08:12:00"
          }
        ]
      }
    ],
    page: 1,
    pageSize: 10,
    preserveStructuralTombstones: true
  });

  assert.equal(comments.length, 3);
  const parent = comments.find(
    (comment) => comment.id === "RAW_EMPTY_PARENT"
  );
  assert.equal(parent?.contentStatus, "empty_or_deleted");
  assert.equal(parent?.content, "");
  assert.deepEqual(
    comments
      .filter((comment) => comment.parentId === "RAW_EMPTY_PARENT")
      .map((comment) => comment.id)
      .sort(),
    ["RAW_CHILD_ONE", "RAW_CHILD_TWO"]
  );
});

function singleThreadObserver(input: {
  comments: Array<{
    id: string;
    index: number;
    parentId: string | null;
    depth: number;
    authorPlatformId: string | null;
    authorName: string;
    content: string;
    contentStatus?: "present" | "empty_or_deleted";
    time: string;
  }>;
  expected: number;
}) {
  const manifest = fixtureManifest();
  const observer = new CmoocHybridShadowObserver({
    inspectReadiness: async () => {
      throw new Error("browser unavailable");
    },
    getToken: async () => null,
    fetchMembers: async () => [],
    fetchColumns: async () => [
      {
        columnId: "TRANSIENT_COLUMN",
        columnName: "TRANSIENT_COLUMN",
        columnType: "SKETCH",
        innerType: "",
        columnSort: 1,
        guidanceCaption: null
      }
    ],
    fetchTopicPage: async (request) => ({
      items: [
        {
          url:
            "https://cmooc.bnu.edu.cn/cMOOC/detail?id=88888888&type=SKETCH",
          titleCandidate: "TRANSIENT",
          cardText: "TRANSIENT",
          sourceIndex: 0,
          authorPlatformId: "RAW_ROOT_AUTHOR",
          commentCount: input.expected,
          createdTime: "2026-07-01 08:00:00"
        }
      ],
      receipt: receipt({
        requestCursor: request.cursor ?? "",
        nextCursor: null,
        expected: 1,
        observed: 1
      })
    }),
    fetchPostCore: async (request) => ({
      url: request.postUrl,
      title: "TRANSIENT",
      courseId: manifest.courseId,
      authorPlatformId: "RAW_ROOT_AUTHOR",
      authorName: "TRANSIENT",
      tags: [],
      content: "TRANSIENT",
      editedAt: "2026-07-01 08:00:00",
      commentCount: input.expected
    }),
    fetchCommentPage: async (request) => ({
      items: input.comments,
      receipt: receipt({
        requestCursor: request.cursor ?? "",
        nextCursor: null,
        expected: input.expected,
        observed: input.expected
      })
    })
  });
  return { manifest, observer };
}

test("hybrid observer keeps a tombstone parent for topology but censors semantic completeness", async () => {
  const rawMarkers = [
    "RAW_EMPTY_PARENT",
    "RAW_CHILD_ONE",
    "RAW_CHILD_TWO"
  ];
  const { manifest, observer } = singleThreadObserver({
    expected: 1,
    comments: [
      {
        id: rawMarkers[0],
        index: 0,
        parentId: null,
        depth: 0,
        authorPlatformId: "RAW_PARENT_AUTHOR",
        authorName: "TRANSIENT",
        content: "",
        contentStatus: "empty_or_deleted",
        time: "2026-07-01 08:10:00"
      },
      {
        id: rawMarkers[1],
        index: 1,
        parentId: rawMarkers[0],
        depth: 1,
        authorPlatformId: "RAW_CHILD_AUTHOR_ONE",
        authorName: "TRANSIENT",
        content: "TRANSIENT",
        contentStatus: "present",
        time: "2026-07-01 08:11:00"
      },
      {
        id: rawMarkers[2],
        index: 2,
        parentId: rawMarkers[0],
        depth: 1,
        authorPlatformId: "RAW_CHILD_AUTHOR_TWO",
        authorName: "TRANSIENT",
        content: "TRANSIENT",
        contentStatus: "present",
        time: "2026-07-01 08:12:00"
      }
    ]
  });

  const observation = await observer.observe({
    manifest,
    secret: Buffer.alloc(32, 15),
    observedAt: "2026-07-02T00:00:00.000Z"
  });

  assert.equal(observation.threads.length, 1);
  assert.equal(observation.threads[0].events.length, 4);
  const parent = observation.threads[0].events.find(
    (event) => event.depth === 1
  );
  assert.ok(parent);
  assert.equal(
    observation.threads[0].events.filter(
      (event) => event.parentEventKey === parent.eventKey
    ).length,
    2
  );
  assert.equal(
    observation.threads[0].kernelObservation.commentCompleteness,
    "visible_only"
  );
  assert.equal(observation.coverage.failedTargetCount, 0);
  assert.equal(
    observation.coverage.failureCodeCounts
      .comment_content_censored,
    1
  );
  assert.equal(
    observation.coverage.failureCodeCounts.thread_detail_failed,
    undefined
  );
  assert.equal(observation.coverage.commentPagination?.length, 1);
  assert.equal(
    observation.coverage.commentPagination?.[0]?.failure,
    "comment_content_censored"
  );
  assert.equal(
    observation.coverage.commentPagination?.[0]?.countDomain,
    "root_comments"
  );
  assert.equal(
    observation.coverage.commentPagination?.[0]?.observed,
    1
  );
  assert.equal(
    observation.coverage.commentPagination?.[0]
      ?.observedEventCount,
    3
  );
  const serialized = JSON.stringify(observation);
  for (const marker of rawMarkers) {
    assert.equal(serialized.includes(marker), false);
  }
});

test("hybrid observer preserves the frozen version hash for present comments", async () => {
  const secret = Buffer.alloc(32, 17);
  const commentTime = "2026-07-01 08:10:00";
  const { manifest, observer } = singleThreadObserver({
    expected: 1,
    comments: [
      {
        id: "RAW_PRESENT_COMMENT",
        index: 0,
        parentId: null,
        depth: 0,
        authorPlatformId: "RAW_PRESENT_AUTHOR",
        authorName: "TRANSIENT",
        content: "TRANSIENT",
        contentStatus: "present",
        time: commentTime
      }
    ]
  });
  const observedAt = "2026-07-02T00:00:00.000Z";

  const observation = await observer.observe({
    manifest,
    secret,
    observedAt
  });
  const frozen = normalizeObservedThread({
    courseAlias: manifest.alias,
    secret,
    maxComments: manifest.scan.maxCommentsPerThread,
    thread: {
      courseRef: manifest.courseId,
      threadRef: "88888888",
      authorRef: "RAW_ROOT_AUTHOR",
      occurredAt: "2026-07-01 08:00:00",
      observedAt,
      versionMaterial: [
        "TRANSIENT",
        "TRANSIENT",
        "2026-07-01 08:00:00"
      ].join("\0"),
      comments: [
        {
          eventRef: "RAW_PRESENT_COMMENT",
          actorRef: "RAW_PRESENT_AUTHOR",
          parentEventRef: "88888888",
          depth: 0,
          occurredAt: commentTime,
          versionMaterial: ["TRANSIENT", commentTime].join("\0")
        }
      ]
    }
  });

  assert.equal(
    observation.threads[0]?.events.find(
      (event) => event.kind === "comment"
    )?.sourceVersionHash,
    frozen.events.find((event) => event.kind === "comment")
      ?.sourceVersionHash
  );
});

test("hybrid observer emits one typed receipt for an unresolved parent", async () => {
  const { manifest, observer } = singleThreadObserver({
    expected: 1,
    comments: [
      {
        id: "RAW_ORPHAN_CHILD",
        index: 0,
        parentId: "RAW_MISSING_PARENT",
        depth: 1,
        authorPlatformId: "RAW_ORPHAN_AUTHOR",
        authorName: "TRANSIENT",
        content: "TRANSIENT",
        contentStatus: "present",
        time: "2026-07-01 08:11:00"
      }
    ]
  });

  const observation = await observer.observe({
    manifest,
    secret: Buffer.alloc(32, 16),
    observedAt: "2026-07-02T00:00:00.000Z"
  });

  assert.equal(observation.threads.length, 0);
  assert.equal(observation.coverage.failedTargetCount, 1);
  assert.equal(observation.coverage.commentPagination?.length, 1);
  assert.equal(
    observation.coverage.commentPagination?.[0]?.failure,
    "event_parent_unresolved"
  );
  assert.equal(
    observation.coverage.failureCodeCounts.event_parent_unresolved,
    1
  );
  assert.equal(
    observation.coverage.failureCodeCounts.thread_detail_failed,
    undefined
  );
});
