import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

process.env.DATABASE_URL = "file:./test.db";
process.env.LLM_MODE = "mock";

test("草稿流水线追加 O-I-E 快照且不改写全局学伴状态", async () => {
  const { prisma } = await import("../../lib/db");
  const { prepareInterventionPlan } = await import("../../lib/interventions/intervention-service");
  const { createAgentContextSnapshot } = await import("../../lib/agents/context-snapshot");
  const { getAgentContextTraces } = await import("../../lib/agents/context-trace");
  const { GET: getContextApi } = await import("../../app/api/interventions/[id]/context/route");

  try {
    const task = await prisma.interventionTask.findFirstOrThrow({
      where: { status: "proposed" },
      include: { post: true }
    });
    const companion = await prisma.companionProfile.findUniqueOrThrow({
      where: { type: task.interventionType }
    });
    const baselineBefore = companion.currentMentalStateJson;

    await prepareInterventionPlan({ taskId: task.id, force: true });
    await prepareInterventionPlan({ taskId: task.id, force: true });

    const snapshots = await prisma.agentContextSnapshot.findMany({
      where: { taskId: task.id },
      orderBy: { revision: "asc" }
    });
    assert.equal(snapshots.length, 2);
    assert.deepEqual(snapshots.map((snapshot) => snapshot.revision), [1, 2]);
    assert.equal(snapshots.every((snapshot) => snapshot.futureInformationUsed === false), true);
    assert.equal(snapshots.every((snapshot) => snapshot.companionType === task.interventionType), true);

    const persistedCompanion = await prisma.companionProfile.findUniqueOrThrow({
      where: { id: companion.id }
    });
    assert.equal(persistedCompanion.currentMentalStateJson, baselineBefore);

    for (const snapshot of snapshots) {
      const observation = JSON.parse(snapshot.observationJson) as Record<string, unknown>;
      const inference = JSON.parse(snapshot.inferenceJson) as Record<string, unknown>;
      const expression = JSON.parse(snapshot.expressionJson) as Record<string, unknown>;
      const evidenceBoundary = observation.evidenceBoundary as {
        futureInformationUsed: boolean;
        postObservationSource: string;
      };
      const serialized = `${snapshot.observationJson}\n${snapshot.inferenceJson}\n${snapshot.expressionJson}`;
      assert.equal(serialized.includes(task.post.title), false);
      assert.equal(serialized.includes(task.post.content), false);
      assert.equal(evidenceBoundary.futureInformationUsed, false);
      assert.match(evidenceBoundary.postObservationSource, /forum_post_snapshot|current_post_at_or_before_cutoff/);
      assert.equal(inference.nonDiagnostic, true);
      assert.equal(inference.stablePersonalityClaimed, false);
      assert.equal(expression.persistentAgentPersonalityMutated, false);
      assert.equal(expression.learnerIdentitySimulated, false);
    }

    const expressionRuns = await prisma.agentRun.findMany({
      where: { taskId: task.id, agentName: "expression-agent" },
      orderBy: { startedAt: "asc" }
    });
    assert.equal(expressionRuns.length, 2);
    const referencedSnapshots = expressionRuns.map((run) => {
      const input = JSON.parse(run.inputJson) as { contextSnapshotId: string };
      return input.contextSnapshotId;
    });
    assert.deepEqual(referencedSnapshots, snapshots.map((snapshot) => snapshot.id));

    const tracePayload = await getAgentContextTraces(task.id);
    assert.ok(tracePayload);
    assert.deepEqual(tracePayload.snapshots.map((snapshot) => snapshot.revision), [2, 1]);
    const serializedTrace = JSON.stringify(tracePayload);
    assert.equal(serializedTrace.includes(task.post.title), false);
    assert.equal(serializedTrace.includes(task.post.content), false);
    assert.equal(tracePayload.snapshots[0].inference.nonDiagnostic, true);
    assert.equal(tracePayload.snapshots[0].expression.persistentAgentPersonalityMutated, false);

    const contextResponse = await getContextApi(
      new Request(`http://localhost/api/interventions/${task.id}/context`),
      { params: { id: task.id } }
    );
    assert.equal(contextResponse.status, 200);
    assert.equal(contextResponse.headers.get("cache-control"), "no-store");
    assert.equal((await contextResponse.text()).includes(task.post.content), false);

    const missingResponse = await getContextApi(
      new Request("http://localhost/api/interventions/missing/context"),
      { params: { id: "missing" } }
    );
    assert.equal(missingResponse.status, 404);

    await assert.rejects(
      () => createAgentContextSnapshot({
        taskId: task.id,
        interventionType: task.interventionType as "resource_connector" | "cognitive_conflict" | "emotional_support" | "mixed",
        mentalState: { empathy: 60, curiosity: 60, challengeLevel: 40, warmth: 60, focus: "test" },
        asOfAt: new Date(task.post.createdAt.getTime() - 1)
      }),
      /帖子在上下文快照截止时点之后才出现/
    );
    assert.equal(await prisma.agentContextSnapshot.count({ where: { taskId: task.id } }), 2);

    if (task.createdAt.getTime() > task.post.createdAt.getTime()) {
      await assert.rejects(
        () => createAgentContextSnapshot({
          taskId: task.id,
          interventionType: task.interventionType as "resource_connector" | "cognitive_conflict" | "emotional_support" | "mixed",
          mentalState: { empathy: 60, curiosity: 60, challengeLevel: 40, warmth: 60, focus: "test" },
          asOfAt: new Date(task.createdAt.getTime() - 1)
        }),
        /干预任务在上下文快照截止时点之后才创建/
      );
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("评论回复表达必须承接稳定绑定的目标评论，主帖回复不携带评论语义", async () => {
  const { prisma } = await import("../../lib/db");
  const { generateReplyDraft } = await import("../../lib/agents/expression-agent");
  const { getCompanionExpressionPolicy } = await import("../../lib/agents/narrative-agent");
  const marker = `expression-target-${Date.now()}`;
  const created: {
    courseId?: string;
    postId?: string;
    replyId?: string;
    taskId?: string;
  } = {};

  try {
    const [course, users] = await Promise.all([
      prisma.course.create({
        data: {
          platformCourseId: `${marker}-course`,
          name: "表达目标上下文测试课程",
          metadataJson: "{}"
        }
      }),
      prisma.forumUser.findMany({ take: 2, orderBy: { id: "asc" } })
    ]);
    created.courseId = course.id;
    assert.equal(users.length, 2);
    const post = await prisma.forumPost.create({
      data: {
        courseId: course.id,
        sourceKind: "learner",
        forumPostId: `${marker}-post`,
        authorId: users[0].id,
        title: "如何判断连接是否带来更深学习",
        content: "我想讨论连接数量与连接质量的差别。",
        url: `mock://${marker}`,
        createdAt: new Date()
      }
    });
    created.postId = post.id;
    const targetContent = "我觉得只要认识的人多就一定学得深，电话 13800138000。";
    const reply = await prisma.forumReply.create({
      data: {
        courseId: course.id,
        sourceKind: "learner",
        forumReplyId: `${marker}-reply`,
        platformReplyId: `${marker}-platform`,
        postId: post.id,
        authorId: users[1].id,
        content: targetContent
      }
    });
    created.replyId = reply.id;
    const normalizedTarget = targetContent.replace(/\s+/g, " ").trim();
    const task = await prisma.interventionTask.create({
      data: {
        courseId: course.id,
        postId: post.id,
        targetUserId: users[1].id,
        interventionType: "cognitive_conflict",
        publishTarget: "comment_reply",
        targetCommentIndex: 0,
        targetPlatformReplyId: reply.platformReplyId,
        targetCommentContentHash: createHash("sha256")
          .update(normalizedTarget, "utf8")
          .digest("hex"),
        targetCommentPreview: normalizedTarget,
        priorityScore: 80,
        status: "proposed"
      }
    });
    created.taskId = task.id;
    const expressionPolicy = getCompanionExpressionPolicy("cognitive_conflict");
    let commentMessages = "";
    let commentFallback = "";
    await generateReplyDraft(
      {
        taskId: task.id,
        postId: post.id,
        interventionType: "cognitive_conflict",
        mentalState: {
          empathy: 60,
          curiosity: 80,
          challengeLevel: 65,
          warmth: 60,
          focus: "承接具体评论观点"
        },
        contextSnapshotId: "expression-comment-context",
        expressionPolicy
      },
      {
        generate: async (messages, fallback) => {
          commentMessages = JSON.stringify(messages);
          commentFallback = fallback;
          return "可以从一个反例开始检验这个判断。";
        }
      }
    );
    assert.match(commentMessages, /只要认识的人多就一定学得深/);
    assert.match(commentMessages, new RegExp(reply.platformReplyId!));
    assert.equal(commentMessages.includes("13800138000"), false);
    assert.match(commentFallback, /只要认识的人多就一定学得深/);

    const commentRun = await prisma.agentRun.findFirstOrThrow({
      where: { taskId: task.id, agentName: "expression-agent" },
      orderBy: { startedAt: "desc" }
    });
    assert.equal(commentRun.inputJson.includes("13800138000"), false);
    assert.match(commentRun.inputJson, new RegExp(reply.platformReplyId!));

    await prisma.interventionTask.update({
      where: { id: task.id },
      data: {
        publishTarget: "post_comment",
        targetUserId: users[0].id,
        targetCommentIndex: null,
        targetPlatformReplyId: null,
        targetCommentContentHash: null,
        targetCommentPreview: null
      }
    });
    let postMessages = "";
    await generateReplyDraft(
      {
        taskId: task.id,
        postId: post.id,
        interventionType: "cognitive_conflict",
        mentalState: {
          empathy: 60,
          curiosity: 80,
          challengeLevel: 65,
          warmth: 60,
          focus: "回应主题帖"
        },
        contextSnapshotId: "expression-post-context",
        expressionPolicy
      },
      {
        generate: async (messages) => {
          postMessages = JSON.stringify(messages);
          return "可以继续比较连接数量与关系质量。";
        }
      }
    );
    assert.match(postMessages, /\\"targetMode\\":\\"post_comment\\"/);
    assert.match(postMessages, /\\"targetComment\\":null/);
    assert.equal(postMessages.includes("只要认识的人多就一定学得深"), false);
  } finally {
    if (created.taskId) {
      await prisma.agentRun.deleteMany({ where: { taskId: created.taskId } });
      await prisma.interventionTask.deleteMany({ where: { id: created.taskId } });
    }
    if (created.replyId) {
      await prisma.forumReply.deleteMany({ where: { id: created.replyId } });
    }
    if (created.postId) {
      await prisma.forumPost.deleteMany({ where: { id: created.postId } });
    }
    if (created.courseId) {
      await prisma.course.deleteMany({ where: { id: created.courseId } });
    }
    await prisma.$disconnect();
  }
});
