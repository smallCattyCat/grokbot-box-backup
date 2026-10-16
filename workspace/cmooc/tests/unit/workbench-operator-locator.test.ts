import assert from "node:assert/strict";
import test from "node:test";
import {
  OperatorLocatorError,
  loadOperatorCourseLocator,
  parseOperatorLocatorRequest,
  type OperatorLocatorDb
} from "../../lib/workbench/operator-locator";
import { deriveAutonomyThreadKey } from "../../lib/world/live-event";

const MANIFEST_HASH = "a".repeat(64);

function fixtureDb(overrides: {
  storedManifestHash?: string;
  posts?: Array<Record<string, unknown>>;
} = {}): OperatorLocatorDb {
  return {
    autonomyCourseManifest: {
      findUnique: async () => ({
        alias: "course-a",
        manifestHash: overrides.storedManifestHash ?? MANIFEST_HASH,
        enabled: true
      })
    },
    course: {
      findUnique: async () => ({
        id: "course-row",
        name: "真实课程名称",
        sourceUrl: "https://forum.example/course?courseId=course-1",
        status: "active",
        lastSyncedAt: new Date("2026-08-13T12:00:00.000Z")
      })
    },
    forumPost: {
      findMany: async () => (overrides.posts ?? [{
        forumPostId: "post-27",
        title: "如何形成跨小组连接？",
        content: "这是运营者需要阅读和定位的真实讨论内容。",
        url: "https://forum.example/post/27",
        replyCount: 3,
        createdAt: new Date("2026-08-13T10:00:00.000Z"),
        updatedAt: new Date("2026-08-13T11:00:00.000Z"),
        lastReplyAt: new Date("2026-08-13T11:00:00.000Z"),
      author: {
        forumUserId: "real-user-id-learner-27",
        name: "学习者-a1b2c3"
      }
      }]) as never
    },
    forumPostSnapshot: {
      findMany: async () => [{
        forumPostId: "post-27",
        rawJson: JSON.stringify({
          listedAuthor: {
            authorName: "张同学",
            authorPlatformId: "learner-27"
          },
          detail: {
            authorName: "张同学",
            authorPlatformId: "learner-27",
            comments: []
          }
        })
      }]
    }
  };
}

const loadManifest = async () => ({
  alias: "course-a",
  courseId: "course-1",
  manifestHash: MANIFEST_HASH,
  canonicalUrl: "https://forum.example/course?courseId=course-1",
  allowedOrigins: ["https://forum.example"]
});

test("operator locator request is closed and keeps search bounded", () => {
  assert.deepEqual(parseOperatorLocatorRequest({
    courseAlias: "course-a",
    query: "  张同学  "
  }), {
    courseAlias: "course-a",
    query: "张同学"
  });
  assert.throws(
    () => parseOperatorLocatorRequest({ courseAlias: "course-a", query: "x", extra: true }),
    OperatorLocatorError
  );
  assert.throws(
    () => parseOperatorLocatorRequest({ courseAlias: "../course", query: "" }),
    OperatorLocatorError
  );
});

test("operator locator returns real course, content and account identifiers for the operator-only surface", async () => {
  const locator = await loadOperatorCourseLocator({
    courseAlias: "course-a",
    query: "张同学",
    prisma: fixtureDb(),
    loadManifest
  });

  assert.equal(locator.course.name, "真实课程名称");
  assert.equal(locator.course.alias, "course-a");
  assert.equal(locator.items.length, 1);
  assert.equal(locator.items[0]?.author.displayName, "张同学");
  assert.equal(locator.items[0]?.author.accountName, "learner-27");
  assert.equal(locator.items[0]?.content, "这是运营者需要阅读和定位的真实讨论内容。");
  assert.equal(locator.items[0]?.sourceUrl, "https://forum.example/post/27");
  assert.equal(locator.containsForumText, true);
  assert.equal(locator.containsIdentity, true);
  assert.equal(locator.operatorOnly, true);
});

test("operator locator fails before reading posts when the manifest binding drifts", async () => {
  let postReadCount = 0;
  const db = fixtureDb({ storedManifestHash: "b".repeat(64) });
  db.forumPost.findMany = async () => {
    postReadCount += 1;
    return [];
  };

  await assert.rejects(
    loadOperatorCourseLocator({
      courseAlias: "course-a",
      prisma: db,
      loadManifest
    }),
    (error: unknown) =>
      error instanceof OperatorLocatorError &&
      error.code === "OPERATOR_LOCATOR_MANIFEST_MISMATCH"
  );
  assert.equal(postReadCount, 0);
});

test("operator locator removes a post link outside the manifest origin without hiding its local content", async () => {
  const db = fixtureDb({
    posts: [{
      forumPostId: "post-unsafe",
      title: "边界帖子",
      content: "仍可在本机运营界面阅读。",
      url: "https://other.example/post/1",
      replyCount: 0,
      createdAt: new Date("2026-08-13T10:00:00.000Z"),
      updatedAt: new Date("2026-08-13T10:00:00.000Z"),
      lastReplyAt: null,
      author: { forumUserId: "learner-1", name: "李同学" }
    }]
  });
  const locator = await loadOperatorCourseLocator({
    courseAlias: "course-a",
    prisma: db,
    loadManifest
  });

  assert.equal(locator.items[0]?.sourceUrl, null);
  assert.equal(locator.items[0]?.content, "仍可在本机运营界面阅读。");
});

test("operator locator resolves one run-bound draft to its exact post, author and content", async () => {
  const secret = Buffer.alloc(32, 5);
  const threadKey = deriveAutonomyThreadKey({
    secret,
    courseRef: "course-1",
    threadRef: "post-27"
  });
  const db = fixtureDb() as OperatorLocatorDb;
  db.workbenchRunRecord = {
    findUnique: async () => ({ id: "run-27" })
  };
  db.workbenchArtifactVersionRecord = {
    findMany: async () => [{
      sourceRefsJson: JSON.stringify([{
        kind: "decision",
        id: "decision:decision-27",
        hash: "b".repeat(64),
        observedAt: "2026-08-13T11:00:00.000Z"
      }])
    }]
  };
  db.autonomyDecision = {
    findUnique: async () => ({
      id: "decision-27",
      courseAlias: "course-a",
      threadKey
    })
  };
  db.forumPost.findMany = async () => [{
    forumPostId: "post-27",
    title: "如何形成跨小组连接？",
    content: "这是运营者需要阅读和定位的真实讨论内容。",
    url: "https://forum.example/post/27",
    replyCount: 3,
    createdAt: new Date("2026-08-13T10:00:00.000Z"),
    updatedAt: new Date("2026-08-13T11:00:00.000Z"),
    lastReplyAt: new Date("2026-08-13T11:00:00.000Z"),
    author: { forumUserId: "learner-27", name: "张同学" }
  }];

  const locator = await loadOperatorCourseLocator({
    courseAlias: "course-a",
    runId: "run-27",
    prisma: db,
    evidenceSecret: secret,
    loadManifest
  });

  assert.equal(locator.replyTarget?.status, "resolved");
  assert.equal(locator.replyTarget?.title, "如何形成跨小组连接？");
  assert.equal(locator.replyTarget?.author.displayName, "张同学");
  assert.equal(locator.replyTarget?.author.accountName, "learner-27");
  assert.equal(locator.replyTarget?.postRef, "post-27");
});

test("operator locator performs one read-only live lookup when the run target is newer than local ingestion", async () => {
  const secret = Buffer.alloc(32, 9);
  const threadKey = deriveAutonomyThreadKey({
    secret,
    courseRef: "course-1",
    threadRef: "8899001122334455"
  });
  const db = fixtureDb({
    posts: [{
      forumPostId: "older-post",
      title: "旧同步内容",
      content: "这不是当前任务目标。",
      url: "https://forum.example/post/older",
      replyCount: 1,
      createdAt: new Date("2026-08-12T10:00:00.000Z"),
      updatedAt: new Date("2026-08-12T11:00:00.000Z"),
      lastReplyAt: null,
      author: { forumUserId: "older-user", name: "旧成员" }
    }]
  });
  db.workbenchRunRecord = {
    findUnique: async () => ({ id: "run-live" })
  };
  db.workbenchArtifactVersionRecord = {
    findMany: async () => [{
      sourceRefsJson: JSON.stringify([{
        kind: "decision",
        id: "decision:decision-live",
        hash: "c".repeat(64),
        observedAt: "2026-08-13T11:00:00.000Z"
      }])
    }]
  };
  db.autonomyDecision = {
    findUnique: async () => ({
      id: "decision-live",
      courseAlias: "course-a",
      threadKey
    })
  };
  let liveReadCount = 0;

  const locator = await loadOperatorCourseLocator({
    courseAlias: "course-a",
    runId: "run-live",
    prisma: db,
    evidenceSecret: secret,
    loadManifest,
    liveTargetReader: async (request) => {
      liveReadCount += 1;
      assert.equal(request.threadKey, threadKey);
      return {
        forumPostId: "8899001122334455",
        title: "刚刚需要回应的课程讨论",
        content: "这是写前只读定位得到的当前帖子正文。",
        url: "https://forum.example/detail?id=8899001122334455",
        author: {
          forumUserId: "platform-user-88",
          name: "王同学"
        }
      };
    }
  });

  assert.equal(liveReadCount, 1);
  assert.equal(locator.replyTarget?.status, "resolved");
  assert.equal(locator.replyTarget?.title, "刚刚需要回应的课程讨论");
  assert.equal(locator.replyTarget?.author.displayName, "王同学");
  assert.equal(locator.replyTarget?.author.accountName, "platform-user-88");
  assert.equal(locator.replyTarget?.content, "这是写前只读定位得到的当前帖子正文。");
});
