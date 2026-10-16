import assert from "node:assert/strict";
import test from "node:test";
import { inferForumSourceKind, isLearnerProfileSource } from "../../lib/forum/source-kind";

test("论坛来源分类遵守 companion > system > test > learner > unknown", () => {
  assert.equal(inferForumSourceKind({ storedSourceKind: "learner", isCompanionReply: true }), "companion");
  assert.equal(inferForumSourceKind({ storedSourceKind: "test", authorRole: "companion" }), "companion");
  assert.equal(inferForumSourceKind({ authorRole: "scanner", postUrl: "/mock-forum/posts/1" }), "system");
  assert.equal(inferForumSourceKind({ authorRole: "learner", postUrl: "/mock-forum/posts/1" }), "test");
  assert.equal(inferForumSourceKind({ authorRole: "learner", postUrl: "https://cmooc.example/post/1" }), "learner");
  assert.equal(inferForumSourceKind({ authorRole: "teacher" }), "unknown");
});

test("只有 learner 来源能够进入学习者画像", () => {
  assert.equal(isLearnerProfileSource("learner"), true);
  for (const sourceKind of ["companion", "system", "test", "unknown"] as const) {
    assert.equal(isLearnerProfileSource(sourceKind), false);
  }
});
