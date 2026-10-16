import { Prisma, PrismaClient } from "@prisma/client";
import { assertSeedTarget } from "../lib/database/seed-safety";

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

async function seedData(db: Prisma.TransactionClient) {
  await db.publishAttempt.deleteMany();
  await db.publishAuthorization.deleteMany();
  await db.agentRun.deleteMany();
  await db.agentContextSnapshot.deleteMany();
  await db.autoInterventionCandidate.deleteMany();
  await db.autoInterventionRun.deleteMany();
  await db.interventionTask.deleteMany();
  await db.interactionAnalysis.deleteMany();
  await db.forumUserUtteranceAnalysis.deleteMany();
  await db.forumPostSnapshot.deleteMany();
  await db.forumUserSnapshot.deleteMany();
  await db.forumUserCourseProfile.deleteMany();
  await db.forumUserProfile.deleteMany();
  await db.courseMembership.deleteMany();
  await db.forumReply.deleteMany();
  await db.forumPost.deleteMany();
  await db.forumIngestionRun.deleteMany();
  await db.course.deleteMany();
  await db.forumUser.deleteMany();
  await db.companionProfile.deleteMany();
  await db.forumSetting.deleteMany();

  const users = await Promise.all(
    [
      ["u001", "林澈", "learner", ["联通主义", "知识网络"], 68, "curious", 0.62],
      ["u002", "周予", "learner", ["智能学伴", "生成式人工智能"], 42, "frustrated", 0.41],
      ["u003", "陈安", "learner", ["社会网络分析"], 58, "neutral", 0.55],
      ["u004", "许一诺", "learner", ["学习共同体"], 34, "isolated", 0.21],
      ["u005", "顾明", "learner", ["cMOOC"], 73, "active", 0.74],
      ["u006", "赵青", "learner", ["教育技术"], 47, "neutral", 0.38],
      ["u007", "韩溪", "learner", ["知识网络"], 52, "curious", 0.48],
      ["u008", "叶然", "learner", ["课程案例"], 61, "active", 0.57]
    ].map(([forumUserId, name, role, tags, activityLevel, emotionalState, centralityScore], index) =>
      db.forumUser.create({
        data: {
          forumUserId: forumUserId as string,
          name: name as string,
          role: role as string,
          tagsJson: JSON.stringify(tags),
          activityLevel: activityLevel as number,
          emotionalState: emotionalState as string,
          centralityScore: centralityScore as number,
          lastActiveAt: hoursAgo(2 + index * 3)
        }
      })
    )
  );

  const companionUser = await db.forumUser.create({
    data: {
      forumUserId: "companion-system",
      name: "智能学伴",
      role: "companion",
      tagsJson: JSON.stringify(["智能学伴", "系统账号"]),
      activityLevel: 80,
      emotionalState: "stable",
      centralityScore: 0.7,
      lastActiveAt: new Date()
    }
  });

  await db.companionProfile.createMany({
    data: [
      {
        name: "连枝",
        type: "resource_connector",
        persona: "熟悉课程知识网络与同伴讨论脉络，擅长把问题连接到资料、案例和相似观点。",
        tone: "清晰、克制、连接导向",
        roleBoundary: "提供学习路径和连接建议，不堆砌链接，不替学习者完成结论。",
        currentMentalStateJson: JSON.stringify({ empathy: 62, curiosity: 78, challengeLevel: 32, warmth: 68, focus: "资源连接" }),
        active: true
      },
      {
        name: "问石",
        type: "cognitive_conflict",
        persona: "关注观点背后的证据、边界和反例，擅长用追问推动解释澄清。",
        tone: "温和追问、比较启发",
        roleBoundary: "提出问题和反例，不直接给最终答案。",
        currentMentalStateJson: JSON.stringify({ empathy: 58, curiosity: 88, challengeLevel: 72, warmth: 60, focus: "认知挑战" }),
        active: true
      },
      {
        name: "暖栖",
        type: "emotional_support",
        persona: "关注学习者的困惑、压力和参与意愿，擅长把复杂任务拆成可继续行动的小步。",
        tone: "共情、稳定、鼓励",
        roleBoundary: "提供教育场景内的学习支持，不做心理诊断。",
        currentMentalStateJson: JSON.stringify({ empathy: 90, curiosity: 54, challengeLevel: 28, warmth: 88, focus: "情感支持" }),
        active: true
      },
      {
        name: "同行",
        type: "mixed",
        persona: "帮助边缘学习者恢复参与感，并把其问题连接到课程资源和潜在同伴。",
        tone: "温暖、具体、连接导向",
        roleBoundary: "不替学习者发声，不制造虚假的同伴关系。",
        currentMentalStateJson: JSON.stringify({ empathy: 86, curiosity: 68, challengeLevel: 36, warmth: 84, focus: "组合介入" }),
        active: true
      }
    ]
  });

  const postInputs = [
    ["p001", 0, "连接越多是否一定意味着学习越深入？", "我在读联通主义时有个疑问：如果一个学习者连接了很多资源和同伴，是否就一定代表学习更深入？有没有可能连接很多但理解很浅？这个边界该怎么看？", 19, 126, 30],
    ["p002", 1, "我有点跟不上知识网络这一周的内容", "社会网络分析、知识网络、cMOOC 的关系混在一起后，我有点跟不上，也不知道怎么整理笔记。有没有一种比较小的整理方法？", 7, 82, 20],
    ["p003", 2, "有没有智能学伴在课程论坛中的案例或文献？", "我想找一些智能学伴参与论坛讨论的案例、资料或文献，尤其是和 cMOOC、学习共同体相关的。大家有没有推荐？", 11, 104, 15],
    ["p004", 4, "生成式人工智能会让学习共同体更紧密吗？", "我觉得生成式人工智能可能会提高互动频率，但不确定这种频率是否真的能形成更强的共同体连接。", 24, 210, 10],
    ["p005", 3, "第一次发帖：我理解的联通主义是不是太零散？", "我连续看了几段视频，感觉自己抓到了一些关键词，但一直没人回应我之前的帖子。我想知道这些关键词怎样连成一张知识网络。", 3, 46, 40],
    ["p006", 5, "社会网络分析指标如何解释学习支持？", "中心性、密度这些指标能不能说明学习支持质量？还是只能说明互动结构？", 9, 97, 8],
    ["p007", 6, "课程资源太开放时如何做寻径？", "cMOOC 的开放资源很多，我目前会按主题收藏，但常常不知道哪些资源更适合当前问题。", 8, 76, 6],
    ["p008", 7, "小组讨论里的沉默是否也是一种互动？", "有些同学很少发言但会点赞和收藏，这种低可见行为是否应该进入互动分析？", 13, 130, 5],
    ["p009", 0, "我对 CIE 层级的一个反思", "我尝试把自己的回复按 CIE 层级标注，发现很多时候我以为自己在反思，其实只是复述。", 16, 148, 3],
    ["p010", 2, "学习共同体中的情感支持怎么被观察？", "如果只看回复数量，似乎很难看出情感支持。哪些文本线索更可靠？", 10, 88, 2],
    ["p011", 5, "能否用知识图谱表示论坛讨论演化？", "我想把帖子、回复、概念节点连起来，看讨论如何从资源寻径走向认知冲突。这个方案可行吗？", 15, 156, 1],
    ["p012", 7, "同伴推荐会不会造成信息茧房？", "如果系统一直推荐相似观点的同伴，会不会削弱观点冲突？这个问题和联通主义强调的多样连接有点矛盾。", 18, 174, 4]
  ] as const;

  const posts = [];
  for (const [forumPostId, userIndex, title, content, likeCount, viewCount, hours] of postInputs) {
    posts.push(
      await db.forumPost.create({
        data: {
          forumPostId,
          sourceKind: "test",
          authorId: users[userIndex].id,
          title,
          content,
          url: `/mock-forum/posts/${forumPostId}`,
          likeCount,
          viewCount,
          replyCount: 0,
          createdAt: hoursAgo(hours)
        }
      })
    );
  }

  const replyPlan: Array<[number, number, string]> = [
    [1, 4, "我也有类似感觉，概念一下子太多了。"],
    [2, 5, "可以先看课程推荐阅读里的 connectivism 经典论文。"],
    [2, 7, "我记得前几天有个帖子讨论了 AI tutor 的案例。"],
    [3, 0, "赞同。"],
    [3, 2, "有道理。"],
    [3, 3, "学习了。"],
    [3, 5, "同感。"],
    [3, 6, "赞同这个判断。"],
    [3, 7, "确实值得讨论。"],
    [3, 1, "学习了，谢谢分享。"],
    [3, 2, "有道理。"],
    [4, 6, "我之前也发过类似问题，回应确实比较少。"],
    [5, 0, "我觉得中心性只能说明结构位置，不能直接说明支持质量。"],
    [5, 2, "也许可以结合回复内容的 CIE 层级看。"],
    [5, 7, "这个问题适合做一个小型编码练习。"],
    [6, 1, "我会先按主题做标签。"],
    [6, 3, "资源太多时，我也容易迷路。"],
    [6, 5, "可以试试问题驱动的收藏方式。"],
    [6, 7, "谢谢，这个提醒有用。"],
    [7, 0, "沉默可能是阅读参与，但证据不够直接。"],
    [7, 2, "点赞和收藏可以作为弱互动信号。"],
    [8, 5, "这个反思很真实，我也会把复述当总结。"],
    [8, 6, "也许可以看有没有新例子或新关系。"],
    [8, 7, "从复述到反思，中间差一个自我判断。"],
    [9, 0, "我觉得可以看安慰、鼓励、任务拆解这些线索。"],
    [9, 3, "还要注意不要把所有积极词都当情感支持。"],
    [10, 2, "知识图谱很适合表示讨论演化。"],
    [10, 4, "但边的类型要定义清楚。"],
    [10, 6, "可以先从一个主题周的数据试做。"],
    [11, 5, "这个问题很重要，相似推荐确实可能减少异质连接。"]
  ];

  for (let index = 0; index < replyPlan.length; index += 1) {
    const [postIndex, userIndex, content] = replyPlan[index];
    await db.forumReply.create({
      data: {
        forumReplyId: `r${String(index + 1).padStart(3, "0")}`,
        sourceKind: "test",
        postId: posts[postIndex].id,
        authorId: users[userIndex].id,
        content,
        createdAt: hoursAgo(Math.max(1, 18 - index * 0.3))
      }
    });
  }

  for (const post of posts) {
    const replies = await db.forumReply.findMany({ where: { postId: post.id }, orderBy: { createdAt: "desc" } });
    await db.forumPost.update({
      where: { id: post.id },
      data: {
        replyCount: replies.length,
        lastReplyAt: replies[0]?.createdAt ?? null
      }
    });
  }

  const analyses = [
    [0, 4, "劣构问题", "中性", 91, 72, 84, 30, 34, 12, "cognitive_conflict", 78],
    [1, 2, "寻径交互 / 社交情感互动", "困惑/挫败", 88, 42, 68, 0, 64, 20, "emotional_support", 73],
    [2, 2, "寻径交互 / 社交情感互动", "中性", 90, 44, 70, 0, 40, 18, "resource_connector", 66],
    [3, 2, "寻径交互 / 社交情感互动", "积极但浅层", 86, 38, 88, 0, 28, 70, "cognitive_conflict", 69],
    [4, 4, "劣构问题", "中性", 82, 61, 74, 0, 86, 15, "mixed", 72]
  ] as const;

  for (const [postIndex, cieLevel, cieLabel, emotionLabel, topicRelevance, cognitiveDepth, discussionPotential, unansweredHours, isolatedLearnerScore, duplicateScore, interventionType, priorityScore] of analyses) {
    await db.interactionAnalysis.create({
      data: {
        postId: posts[postIndex].id,
        cieLevel,
        cieLabel,
        emotionLabel,
        topicRelevance,
        cognitiveDepth,
        discussionPotential,
        unansweredHours,
        isolatedLearnerScore,
        duplicateScore
      }
    });
    await db.interventionTask.create({
      data: {
        postId: posts[postIndex].id,
        targetUserId: posts[postIndex].authorId,
        interventionType,
        publishTarget: "post_comment",
        priorityScore,
        status: "proposed"
      }
    });
  }

  await db.forumSetting.create({
    data: {
      id: "default",
      forumBaseUrl: "https://cmooc.bnu.edu.cn/cMOOC/home",
      loginUrl: "https://cmooc.bnu.edu.cn/cMOOC/home",
      postUrlPattern: "",
      replyEditorSelector: ".comment_container #edit .ql-editor",
      replySubmitSelector: ".comment_container .buttons .right",
      replySuccessSelector: ""
    }
  });

  await db.agentRun.create({
    data: {
      agentName: "seed",
      inputJson: JSON.stringify({ scenarioCount: 5, postCount: posts.length }),
      outputJson: JSON.stringify({ message: "mock cMOOC demo data generated", companionUserId: companionUser.id }),
      status: "success",
      finishedAt: new Date()
    }
  });
}

export async function seedDatabase() {
  assertSeedTarget();
  const prisma = new PrismaClient();
  try {
    await prisma.$transaction((transaction) => seedData(transaction), { timeout: 60_000 });
  } finally {
    await prisma.$disconnect();
  }
}
