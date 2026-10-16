import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = "file:./test.db";

test("画像同步隔离课程、来源、空批次和批次完成后的未来回复", async () => {
  const { prisma } = await import("../../lib/db");
  const { syncUserProfiles } = await import("../../lib/analytics/user-profile-sync");
  const { persistExtractedPost } = await import("../../lib/forum/extract-post-detail");
  const cutoff = new Date("2026-01-15T04:00:00.000Z");
  const beforeCutoff = new Date(cutoff.getTime() - 60_000);
  const afterCutoff = new Date(cutoff.getTime() + 1);

  try {
    const [courseA, courseB] = await Promise.all([
      prisma.course.create({
        data: { platformCourseId: "p1-boundary-course-a", name: "P1 边界课程 A", metadataJson: "{}" }
      }),
      prisma.course.create({
        data: { platformCourseId: "p1-boundary-course-b", name: "P1 边界课程 B", metadataJson: "{}" }
      })
    ]);
    const [author, peer, companion, otherCourseLearner] = await Promise.all([
      prisma.forumUser.create({
        data: {
          forumUserId: "p1-author",
          name: "学习者-A",
          role: "learner",
          tagsJson: "[]",
          activityLevel: 0,
          emotionalState: "unknown",
          centralityScore: 0,
          lastActiveAt: beforeCutoff
        }
      }),
      prisma.forumUser.create({
        data: {
          forumUserId: "p1-peer",
          name: "学习者-B",
          role: "learner",
          tagsJson: "[]",
          activityLevel: 0,
          emotionalState: "unknown",
          centralityScore: 0,
          lastActiveAt: beforeCutoff
        }
      }),
      prisma.forumUser.create({
        data: {
          forumUserId: "p1-companion",
          name: "测试学伴",
          role: "companion",
          tagsJson: "[]",
          activityLevel: 0,
          emotionalState: "stable",
          centralityScore: 0,
          lastActiveAt: beforeCutoff
        }
      }),
      prisma.forumUser.create({
        data: {
          forumUserId: "p1-course-b-user",
          name: "课程-B-学习者",
          role: "learner",
          tagsJson: "[]",
          activityLevel: 0,
          emotionalState: "unknown",
          centralityScore: 0,
          lastActiveAt: beforeCutoff
        }
      })
    ]);
    await Promise.all([
      prisma.forumUserProfile.create({
        data: {
          userId: companion.id,
          forumUserId: companion.forumUserId,
          displayName: companion.name,
          role: companion.role,
          riskFlagsJson: "[]",
          interestTermsJson: "[]",
          evidenceJson: "{}",
          profileSummary: "迁移前残留的非学习者全局画像"
        }
      }),
      prisma.forumUserCourseProfile.create({
        data: {
          courseId: courseA.id,
          userId: companion.id,
          forumUserId: companion.forumUserId,
          displayName: companion.name,
          role: companion.role,
          riskFlagsJson: "[]",
          interestTermsJson: "[]",
          evidenceJson: "{}",
          profileSummary: "迁移前残留的非学习者课程画像"
        }
      }),
      prisma.courseMembership.create({
        data: {
          courseId: courseA.id,
          userId: companion.id,
          forumUserId: companion.forumUserId,
          displayName: companion.name,
          roleInCourse: "learner",
          activityLevel: 80,
          emotionalState: "positive",
          centralityScore: 0.8,
          personaType: "active_contributor",
          tagsJson: "[\"active_contributor\"]",
          evidenceJson: "{\"source\":\"legacy-profile-sync\"}"
        }
      })
    ]);
    const [postA] = await Promise.all([
      prisma.forumPost.create({
        data: {
          courseId: courseA.id,
          sourceKind: "learner",
          forumPostId: "p1-boundary-post-a",
          authorId: author.id,
          title: "截止时间前的帖子",
          content: "我想讨论知识网络中的证据关系。",
          url: "https://cmooc.example/p1/a",
          createdAt: beforeCutoff
        }
      }),
      prisma.forumPost.create({
        data: {
          courseId: courseB.id,
          sourceKind: "learner",
          forumPostId: "p1-boundary-post-b",
          authorId: otherCourseLearner.id,
          title: "另一课程的帖子",
          content: "这条内容不得进入课程 A 的画像。",
          url: "https://cmooc.example/p1/b",
          createdAt: beforeCutoff
        }
      })
    ]);

    const [learnerReply, companionReply, futureReply, crossCourseReply] = await Promise.all([
      prisma.forumReply.create({
        data: {
          courseId: courseA.id,
          sourceKind: "learner",
          forumReplyId: "p1-learner-reply",
          postId: postA.id,
          authorId: peer.id,
          targetUserId: author.id,
          content: "我认为还需要比较反例，你怎么看？",
          createdAt: beforeCutoff
        }
      }),
      prisma.forumReply.create({
        data: {
          courseId: courseA.id,
          sourceKind: "companion",
          forumReplyId: "p1-companion-reply",
          postId: postA.id,
          authorId: companion.id,
          targetUserId: author.id,
          content: "这是一条学伴支持回复。",
          isCompanionReply: true,
          companionType: "resource_connector",
          createdAt: beforeCutoff
        }
      }),
      prisma.forumReply.create({
        data: {
          courseId: courseA.id,
          sourceKind: "learner",
          forumReplyId: "p1-future-reply",
          postId: postA.id,
          authorId: peer.id,
          targetUserId: author.id,
          content: "这条回复在批次完成之后才可见。",
          createdAt: afterCutoff
        }
      }),
      prisma.forumReply.create({
        data: {
          courseId: courseB.id,
          sourceKind: "learner",
          forumReplyId: "p1-cross-course-reply",
          postId: postA.id,
          authorId: otherCourseLearner.id,
          targetUserId: author.id,
          content: "这条脏数据挂在课程 A 帖子下，但明确属于课程 B。",
          createdAt: beforeCutoff
        }
      })
    ]);
    const run = await prisma.forumIngestionRun.create({
      data: {
        courseId: courseA.id,
        sourceUrl: "https://cmooc.example/p1/course-a",
        sourceType: "course",
        status: "completed",
        postCount: 1,
        replyCount: 2,
        userCount: 3,
        startedAt: new Date(cutoff.getTime() - 120_000),
        finishedAt: cutoff
      }
    });
    await prisma.forumPostSnapshot.create({
      data: {
        courseId: courseA.id,
        runId: run.id,
        postId: postA.id,
        forumPostId: postA.forumPostId,
        title: postA.title,
        url: postA.url,
        replyCount: 2,
        likeCount: 0,
        viewCount: 0,
        contentLength: postA.content.length,
        rawJson: "{}"
      }
    });

    const result = await syncUserProfiles({ runId: run.id, mode: "materialize" });
    assert.equal(result.mode, "materialize");
    assert.equal(result.scope.asOfAt, cutoff.toISOString());
    assert.equal(result.scope.timeBoundaryBasis, "run_finished_at");
    assert.equal(result.analyzedUtteranceCount, 3);
    assert.equal(result.profileEligibleUtteranceCount, 2);
    assert.equal(result.excludedUtteranceCount, 1);
    assert.deepEqual(result.sourceKindDistribution, { learner: 2, companion: 1 });
    assert.equal(result.materializedProfileCount, 2);
    assert.deepEqual(result.invalidation, {
      excludedUserCount: 1,
      deletedCourseProfileCount: 1,
      deletedGlobalProfileCount: 1,
      invalidatedMembershipCount: 1
    });

    const courseProfiles = await prisma.forumUserCourseProfile.findMany({
      where: { courseId: courseA.id },
      orderBy: { forumUserId: "asc" }
    });
    assert.equal(courseProfiles.length, 2);
    assert.equal(courseProfiles.some((profile) => profile.userId === companion.id), false);
    assert.equal(await prisma.forumUserProfile.count({ where: { userId: companion.id } }), 0);
    const invalidatedMembership = await prisma.courseMembership.findUnique({
      where: { courseId_userId: { courseId: courseA.id, userId: companion.id } }
    });
    assert.equal(invalidatedMembership?.personaType, "excluded_no_learner_evidence");
    assert.equal(invalidatedMembership?.activityLevel, 0);
    assert.equal(await prisma.forumUserCourseProfile.count({ where: { courseId: courseB.id } }), 0);
    assert.equal(courseProfiles.find((profile) => profile.userId === author.id)?.incomingInteractionCount, 1);
    assert.equal(courseProfiles.find((profile) => profile.userId === peer.id)?.outgoingInteractionCount, 1);

    const analyses = await prisma.forumUserUtteranceAnalysis.findMany({ where: { courseId: courseA.id } });
    assert.equal(analyses.length, 3);
    assert.equal(analyses.find((analysis) => analysis.replyId === companionReply.id)?.sourceKind, "companion");
    assert.equal(analyses.some((analysis) => analysis.replyId === futureReply.id), false);
    assert.equal(analyses.some((analysis) => analysis.replyId === crossCourseReply.id), false);
    assert.equal(analyses.find((analysis) => analysis.replyId === learnerReply.id)?.sourceKind, "learner");

    const profileFingerprintBefore = JSON.stringify(courseProfiles.map((profile) => ({
      id: profile.id,
      utteranceCount: profile.utteranceCount,
      updatedAt: profile.updatedAt.toISOString()
    })));
    const previewResult = await syncUserProfiles({ runId: run.id });
    assert.equal(previewResult.mode, "preview");
    assert.equal(previewResult.materializedProfileCount, 0);
    const profilesAfterPreview = await prisma.forumUserCourseProfile.findMany({
      where: { courseId: courseA.id },
      orderBy: { forumUserId: "asc" }
    });
    assert.equal(JSON.stringify(profilesAfterPreview.map((profile) => ({
      id: profile.id,
      utteranceCount: profile.utteranceCount,
      updatedAt: profile.updatedAt.toISOString()
    }))), profileFingerprintBefore);

    const emptyRun = await prisma.forumIngestionRun.create({
      data: {
        courseId: courseA.id,
        sourceUrl: "https://cmooc.example/p1/empty",
        sourceType: "course",
        status: "completed",
        postCount: 0,
        replyCount: 0,
        userCount: 0,
        startedAt: new Date(cutoff.getTime() + 60_000),
        finishedAt: new Date(cutoff.getTime() + 120_000)
      }
    });
    const emptyResult = await syncUserProfiles({ runId: emptyRun.id, mode: "materialize" });
    assert.equal(emptyResult.analyzedUtteranceCount, 0);
    assert.equal(emptyResult.profileCount, 0);
    const profilesAfterEmptyRun = await prisma.forumUserCourseProfile.findMany({
      where: { courseId: courseA.id },
      orderBy: { forumUserId: "asc" }
    });
    assert.equal(JSON.stringify(profilesAfterEmptyRun.map((profile) => ({
      id: profile.id,
      utteranceCount: profile.utteranceCount,
      updatedAt: profile.updatedAt.toISOString()
    }))), profileFingerprintBefore);

    await assert.rejects(
      () => syncUserProfiles({ runId: run.id, courseId: courseB.id }),
      /不属于指定课程/
    );

    const reingestedDetail = {
      url: "https://cmooc.example/p1/reingestion",
      title: "重复采集来源保护",
      authorPlatformId: "p1-reingestion-post-author",
      authorName: "重复采集发帖者",
      tags: [],
      content: "用于验证重复采集不会降级可信来源。",
      editedAt: "",
      commentCount: 1,
      comments: [{
        index: 0,
        id: "p1-reingestion-comment",
        authorPlatformId: "p1-reingestion-companion",
        authorName: "重复采集学伴",
        content: "智能学伴自动干预：先保留这条可信标记。",
        time: "2026-01-15 12:00:00"
      }]
    };
    await persistExtractedPost(reingestedDetail);
    await persistExtractedPost({
      ...reingestedDetail,
      comments: [{
        ...reingestedDetail.comments[0],
        content: "第二次采集的正文不再包含任何来源标记。"
      }]
    });
    const reingestedReply = await prisma.forumReply.findUnique({
      where: { forumReplyId: "real-cmooc-comment-p1-reingestion-comment" }
    });
    assert.equal(reingestedReply?.sourceKind, "companion");
    assert.equal(reingestedReply?.isCompanionReply, true);
    assert.equal(reingestedReply?.companionType, "auto");

    const fallbackUrl = "https://cmooc.bnu.edu.cn/cMOOC/detail?id=194509521234567890&type=SKETCH";
    const fallbackDetail = {
      url: fallbackUrl,
      title: "浏览器兜底来源保护",
      authorName: "浏览器兜底发帖者",
      tags: [],
      content: "无平台评论 ID 时必须保守处理。",
      editedAt: "",
      commentCount: 2,
      comments: [
        {
          index: 0,
          authorName: "浏览器兜底学伴",
          content: "智能学伴自动干预：首次抓取带有可信标记。",
          time: "刚刚"
        },
        {
          index: 1,
          authorName: "浏览器兜底普通用户",
          content: "没有平台 ID 的普通评论不能默认进入学习者画像。",
          time: "刚刚"
        }
      ]
    };
    await persistExtractedPost(fallbackDetail);
    const fallbackPost = await prisma.forumPost.findUniqueOrThrow({
      where: { forumPostId: "194509521234567890" }
    });
    const legacyFallbackReply = await prisma.forumReply.create({
      data: {
        sourceKind: "learner",
        forumReplyId: `real-${Buffer.from(fallbackUrl).toString("base64url").slice(0, 40)}-9-old-content-key`,
        postId: fallbackPost.id,
        authorId: peer.id,
        content: "旧版正文相关键留下的弱 learner 记录。",
        createdAt: beforeCutoff
      }
    });
    await persistExtractedPost({
      ...fallbackDetail,
      comments: [
        {
          ...fallbackDetail.comments[0],
          content: "编辑后的正文已经不含任何来源标记。"
        },
        fallbackDetail.comments[1]
      ]
    });
    const fallbackReplies = await prisma.forumReply.findMany({
      where: {
        postId: fallbackPost.id,
        forumReplyId: { startsWith: "real-fallback-" }
      }
    });
    assert.equal(fallbackReplies.length, 2);
    assert.equal(fallbackReplies.find((reply) => reply.content.startsWith("编辑后的"))?.sourceKind, "companion");
    assert.equal(fallbackReplies.find((reply) => reply.content.startsWith("没有平台"))?.sourceKind, "unknown");
    assert.equal(
      (await prisma.forumReply.findUniqueOrThrow({ where: { id: legacyFallbackReply.id } })).sourceKind,
      "unknown"
    );

    const collisionUrl = "https://cmooc.bnu.edu.cn/cMOOC/detail?id=194509529876543210&type=SKETCH";
    assert.equal(
      Buffer.from(fallbackUrl).toString("base64url").slice(0, 40),
      Buffer.from(collisionUrl).toString("base64url").slice(0, 40)
    );
    await persistExtractedPost({
      ...fallbackDetail,
      url: collisionUrl,
      title: "公共 URL 前缀碰撞保护",
      commentCount: 1,
      comments: [{
        ...fallbackDetail.comments[0],
        content: "另一个帖子中同一作者、同一序号的评论。"
      }]
    });
    const collisionPost = await prisma.forumPost.findUniqueOrThrow({
      where: { forumPostId: "194509529876543210" }
    });
    const collisionReply = await prisma.forumReply.findFirstOrThrow({
      where: { postId: collisionPost.id, forumReplyId: { startsWith: "real-fallback-" } }
    });
    const editedFallbackReply = fallbackReplies.find((reply) => reply.content.startsWith("编辑后的"));
    assert.notEqual(collisionReply.forumReplyId, editedFallbackReply?.forumReplyId);
    assert.equal(collisionReply.postId, collisionPost.id);
    assert.equal(editedFallbackReply?.postId, fallbackPost.id);

    const trustedSystemAuthor = await prisma.forumUser.create({
      data: {
        forumUserId: "p1-trusted-system-author",
        name: "可信系统账号",
        role: "system",
        tagsJson: "[]",
        activityLevel: 0,
        emotionalState: "unknown",
        centralityScore: 0,
        lastActiveAt: beforeCutoff
      }
    });
    const trustedSystemUrl = "https://cmooc.example/p1/trusted-system-post";
    await prisma.forumPost.create({
      data: {
        sourceKind: "system",
        forumPostId: trustedSystemUrl,
        authorId: trustedSystemAuthor.id,
        title: "可信系统帖",
        content: "该来源不能被弱启发式降级。",
        url: trustedSystemUrl,
        createdAt: beforeCutoff
      }
    });
    await persistExtractedPost({
      url: trustedSystemUrl,
      title: "可信系统帖重采",
      authorPlatformId: "p1-apparent-learner-author",
      authorName: "表面学习者",
      tags: [],
      content: "重复采集后的正文。",
      editedAt: "",
      commentCount: 0,
      comments: []
    });
    const trustedSystemPost = await prisma.forumPost.findUnique({
      where: { forumPostId: trustedSystemUrl }
    });
    assert.equal(trustedSystemPost?.sourceKind, "system");
  } finally {
    await prisma.$disconnect();
  }
});
