import assert from "node:assert/strict";
import test from "node:test";
import type { AgentContextSnapshot } from "@prisma/client";
import { serializeAgentContextSnapshot } from "../../lib/agents/context-trace";

test("上下文追溯序列化只输出允许字段并丢弃意外原文", () => {
  const snapshot = {
    id: "snapshot-1",
    courseId: "course-1",
    taskId: "task-1",
    postId: "post-1",
    targetUserId: "user-1",
    sourceRunId: "run-1",
    companionType: "mixed",
    revision: 1,
    asOfAt: new Date("2026-07-18T00:00:00.000Z"),
    observationSchemaVersion: "observation-v-test",
    inferenceModelVersion: "inference-v-test",
    expressionPolicyVersion: "expression-v-test",
    observationJson: JSON.stringify({
      evidenceBoundary: {
        postObservationSource: "forum_post_snapshot",
        rawPostContentCopied: false,
        unexpectedRawContent: "SECRET_POST_BODY"
      },
      postObservation: { replyCount: 3, likeCount: 2, viewCount: 10 },
      learnerCourseObservation: null
    }),
    inferenceJson: JSON.stringify({
      nonDiagnostic: true,
      stablePersonalityClaimed: false,
      hiddenPrompt: "SECRET_PROMPT",
      agentRegulationState: { empathy: 70, focus: "test" }
    }),
    expressionJson: JSON.stringify({
      interventionType: "mixed",
      companion: { name: "同行", tone: "温暖", roleBoundary: "不代替学习者", secret: "SECRET_ROLE" },
      taskLocalRegulation: { warmth: 80, focus: "连接" },
      persistentAgentPersonalityMutated: false,
      learnerIdentitySimulated: false
    }),
    futureInformationUsed: false,
    createdAt: new Date("2026-07-18T00:00:01.000Z")
  } satisfies AgentContextSnapshot;

  const trace = serializeAgentContextSnapshot(snapshot);
  const serialized = JSON.stringify(trace);
  assert.equal(trace.observation.post.replyCount, 3);
  assert.equal(trace.inference.nonDiagnostic, true);
  assert.equal(trace.expression.companion.name, "同行");
  assert.equal(serialized.includes("SECRET_POST_BODY"), false);
  assert.equal(serialized.includes("SECRET_PROMPT"), false);
  assert.equal(serialized.includes("SECRET_ROLE"), false);
});
