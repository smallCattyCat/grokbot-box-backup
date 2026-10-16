import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getInitialCommunityNodeId,
  communityNodeLabelVisible
} from "../../components/autonomy/world-graph-explorer";
import {
  buildOperatorCourseIdentityOverlay
} from "../../lib/autonomy/operator-course-identity";
import {
  deriveAutonomyActorKey,
  deriveAutonomyThreadKey
} from "../../lib/world/live-event";

const worldPageSource = readFileSync(
  new URL("../../app/autonomy/world/page.tsx", import.meta.url),
  "utf8"
);
const explorerSource = readFileSync(
  new URL(
    "../../components/autonomy/world-graph-explorer.tsx",
    import.meta.url
  ),
  "utf8"
);

test("world defaults to a human course label and keeps aliases out of the visible chooser", () => {
  assert.match(worldPageSource, /function humanCourseLabel\s*\(/u);
  assert.match(worldPageSource, /aria-label=\{humanCourseLabel\(course\)\}/u);
  assert.doesNotMatch(
    worldPageSource,
    /course\.alias !== courseName[\s\S]{0,280}course\.alias\}/u
  );
  assert.match(worldPageSource, /核查信息/u);
  assert.match(worldPageSource, /互动数据已校验/u);
  assert.doesNotMatch(worldPageSource, /Course Graph v2 · 已校验/u);
});

test("community explorer starts empty and only exposes a node label after explicit selection", () => {
  const model = {
    community: {
      nodes: [
        { id: "actor-1" },
        { id: "actor-2" }
      ]
    }
  } as never;

  assert.equal(
    getInitialCommunityNodeId(model, {
      view: "community_network",
      focus: null
    }),
    null
  );
  assert.equal(
    getInitialCommunityNodeId(model, {
      view: "community_network",
      focus: "actor-2"
    }),
    "actor-2"
  );
  assert.equal(communityNodeLabelVisible(false), false);
  assert.equal(communityNodeLabelVisible(true), true);
  assert.match(explorerSource, /浏览节点/u);
  assert.match(explorerSource, /选择一个节点查看互动摘要/u);
  assert.doesNotMatch(
    explorerSource,
    /<g[\s\S]{0,180}role="button"[\s\S]{0,120}tabIndex=\{0\}/u,
    "the graph must not put every anonymous node into the page Tab order"
  );
  assert.doesNotMatch(
    explorerSource,
    /model\.community\.nodes\[0\]\?\.id \?\? null/u
  );
});

test("operator identity overlay resolves stable graph ids to real members and discussions without changing safe graph ids", () => {
  const secret = Buffer.alloc(32, 7);
  const courseRef = "course-001";
  const actorKey = deriveAutonomyActorKey({
    secret,
    courseRef,
    actorRef: "user-27"
  });
  const threadKey = deriveAutonomyThreadKey({
    secret,
    courseRef,
    threadRef: "post-27"
  });
  const overlay = buildOperatorCourseIdentityOverlay({
    courseAlias: "course-a",
    snapshotId: "snapshot-a",
    courseRef,
    secret,
    allowedOrigins: ["https://forum.example"],
    graphNodes: [
      { nodeKey: threadKey, kind: "thread", ordinal: 2 },
      { nodeKey: actorKey, kind: "actor", ordinal: 4 }
    ],
    memberships: [{
      forumUserId: "real-user-id-user-27",
      displayName: "学习者-a1b2c3",
      user: {
        forumUserId: "real-user-id-user-27",
        name: "学习者-a1b2c3"
      }
    }],
    posts: [{
      forumPostId: "post-27",
      title: "如何形成跨小组连接？",
      content: "这是运营者需要阅读的真实讨论内容。",
      url: "https://forum.example/post/27",
      author: {
        forumUserId: "real-user-id-user-27",
        name: "学习者-a1b2c3"
      }
    }],
    identitySnapshots: [{
      forumPostId: "post-27",
      rawJson: JSON.stringify({
        listedAuthor: {
          authorName: "张同学",
          authorPlatformId: "user-27"
        },
        detail: {
          authorName: "张同学",
          authorPlatformId: "user-27",
          comments: []
        }
      })
    }]
  });

  assert.deepEqual(overlay.actors, [{
    nodeId: "actor-001",
    displayName: "张同学",
    accountName: "user-27"
  }]);
  assert.deepEqual(overlay.identityCoverage, {
    graphActorCount: 1,
    matchedActorCount: 1,
    unmatchedActorCount: 0,
    sourceIdentityCount: 1,
    status: "complete"
  });
  assert.equal(overlay.threads[0]?.nodeId, "thread-001");
  assert.equal(overlay.threads[0]?.title, "如何形成跨小组连接？");
  assert.equal(overlay.threads[0]?.content, "这是运营者需要阅读的真实讨论内容。");
  assert.equal(overlay.operatorOnly, true);
  assert.equal(overlay.containsIdentity, true);
  assert.equal(overlay.containsForumText, true);
  assert.match(worldPageSource, /loadOperatorCourseIdentityOverlay/u);
  assert.match(explorerSource, /运营者实名视图/u);
});

test("operator network separates missing names from missing role evidence", () => {
  const secret = Buffer.alloc(32, 9);
  const courseRef = "course-coverage";
  const knownActorKey = deriveAutonomyActorKey({
    secret,
    courseRef,
    actorRef: "known-user"
  });
  const unmatchedActorKey = deriveAutonomyActorKey({
    secret,
    courseRef,
    actorRef: "not-in-local-directory"
  });
  const overlay = buildOperatorCourseIdentityOverlay({
    courseAlias: "course-a",
    snapshotId: "snapshot-a",
    courseRef,
    secret,
    allowedOrigins: ["https://forum.example"],
    graphNodes: [
      { nodeKey: knownActorKey, kind: "actor", ordinal: 1 },
      { nodeKey: unmatchedActorKey, kind: "actor", ordinal: 2 }
    ],
    memberships: [{
      forumUserId: "real-user-id-known-user",
      displayName: "已同步成员",
      user: {
        forumUserId: "real-user-id-known-user",
        name: "已同步成员"
      }
    }],
    posts: []
  });

  assert.deepEqual(overlay.identityCoverage, {
    graphActorCount: 2,
    matchedActorCount: 1,
    unmatchedActorCount: 1,
    sourceIdentityCount: 1,
    status: "partial"
  });
  assert.match(explorerSource, /姓名已匹配/u);
  assert.match(explorerSource, /角色证据/u);
  assert.match(explorerSource, /姓名尚未同步/u);
  assert.match(explorerSource, /姓名匹配与角色判断是两条独立证据链/u);
  assert.doesNotMatch(explorerSource, /本地匿名节点/u);
  assert.doesNotMatch(explorerSource, /角色未登记/u);
});

test("operator identity coverage also uses course user snapshots and stored reply authors", () => {
  const secret = Buffer.alloc(32, 11);
  const courseRef = "course-broader-identity";
  const snapshotActorKey = deriveAutonomyActorKey({
    secret,
    courseRef,
    actorRef: "snapshot-user"
  });
  const replyActorKey = deriveAutonomyActorKey({
    secret,
    courseRef,
    actorRef: "reply-user"
  });
  const overlay = buildOperatorCourseIdentityOverlay({
    courseAlias: "course-a",
    snapshotId: "snapshot-a",
    courseRef,
    secret,
    allowedOrigins: ["https://forum.example"],
    graphNodes: [
      { nodeKey: snapshotActorKey, kind: "actor", ordinal: 1 },
      { nodeKey: replyActorKey, kind: "actor", ordinal: 2 }
    ],
    memberships: [],
    posts: [],
    userSnapshots: [{
      forumUserId: "real-user-id-snapshot-user",
      displayName: "快照成员"
    }],
    replyAuthors: [{
      author: {
        forumUserId: "real-user-id-reply-user",
        name: "回复成员"
      }
    }]
  });

  assert.deepEqual(overlay.actors, [
    {
      nodeId: "actor-001",
      displayName: "快照成员",
      accountName: "snapshot-user"
    },
    {
      nodeId: "actor-002",
      displayName: "回复成员",
      accountName: "reply-user"
    }
  ]);
  assert.deepEqual(overlay.identityCoverage, {
    graphActorCount: 2,
    matchedActorCount: 2,
    unmatchedActorCount: 0,
    sourceIdentityCount: 2,
    status: "complete"
  });
});
