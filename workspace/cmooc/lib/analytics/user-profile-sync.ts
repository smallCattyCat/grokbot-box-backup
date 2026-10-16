import { recordAgentRunBestEffort } from "@/lib/agents/agent-run";
import { classifyCieText, detectLearningSignals } from "@/lib/agents/research-algorithms";
import { prisma } from "@/lib/db";
import { mean, round, safeDivide } from "@/lib/analytics/statistics";
import { resolveCourseScope } from "@/lib/forum/course-scope";
import { inferForumSourceKind, isLearnerProfileSource, type ForumSourceKind } from "@/lib/forum/source-kind";

const TOPIC_TERMS = [
  "人工智能",
  "生成式人工智能",
  "AI",
  "智能学伴",
  "综合素质评价",
  "全面发展",
  "学生评价",
  "过程性评价",
  "学习分析",
  "数据治理",
  "伦理",
  "隐私",
  "公平",
  "算法",
  "模型",
  "知识图谱",
  "社会网络",
  "图小波",
  "cMOOC",
  "联通主义",
  "协作学习",
  "学习共同体",
  "同伴互评",
  "课程",
  "课堂",
  "实践",
  "案例",
  "资源",
  "文献",
  "工具",
  "评价指标",
  "发展",
  "素养",
  "讨论",
  "问题",
  "观点",
  "证据",
  "反思",
  "方案",
  "框架"
] as const;

type Scope = {
  type: "forum_ingestion_run" | "course_local_forum_data" | "all_local_forum_data";
  runId: string | null;
  sourceUrl: string | null;
  course: { id: string; platformCourseId: string; name: string } | null;
  postCount: number;
  postIds: string[];
  userIds: string[];
  columnNameByPostId: Map<string, string>;
  asOfAt: Date;
  timeBoundaryBasis: "run_finished_at" | "sync_started_at";
};

export type ProfileSyncMode = "preview" | "materialize";

export type SyncUserProfilesInput = {
  runId?: string;
  courseId?: string;
  platformCourseId?: string;
  mode?: ProfileSyncMode;
};

type SourceUtterance = {
  utteranceKey: string;
  courseId?: string;
  userId: string;
  forumUserId: string;
  displayName: string;
  role: string;
  sourceKind: ForumSourceKind;
  postId?: string;
  replyId?: string;
  utteranceType: "post" | "reply";
  columnName?: string;
  title?: string;
  content: string;
  depth: number;
  targetUserId?: string;
  sourceCreatedAt?: Date;
};

type AnalyzedUtterance = SourceUtterance & {
  contentPreview: string;
  contentLength: number;
  cieLevel: number;
  cieLabel: string;
  cieConfidence: number;
  iamPhase: number;
  knowledgePhase: string;
  emotionLabel: string;
  confusionScore: number;
  urgencyScore: number;
  isQuestion: boolean;
  resourceNeed: boolean;
  shallowReply: boolean;
  needsHumanReview: boolean;
  matchedWords: string[];
  topicTerms: string[];
};

type UserAggregate = {
  user: {
    id: string;
    forumUserId: string;
    name: string;
    role: string;
    centralityScore: number;
    lastActiveAt: Date;
  };
  utterances: AnalyzedUtterance[];
  incomingInteractionCount: number;
  outgoingInteractionCount: number;
};

function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function preview(text: string, length = 220) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}...` : compact;
}

function maxDate(dates: Array<Date | undefined>) {
  const times = dates.map((date) => date?.getTime() ?? 0).filter((time) => time > 0);
  return times.length ? new Date(Math.max(...times)) : undefined;
}

function normalizeText(text: string) {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function countBy<T extends string | number>(values: T[]) {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[String(value)] = (acc[String(value)] ?? 0) + 1;
    return acc;
  }, {});
}

function dominant<T extends string | number>(values: T[], fallback: T): T {
  const entries = Object.entries(countBy(values)).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-Hans-CN"));
  return (entries[0]?.[0] as T | undefined) ?? fallback;
}

function topEntries(counts: Record<string, number>, take = 8) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-Hans-CN"))
    .slice(0, take)
    .map(([term, count]) => ({ term, count }));
}

function extractTopicTerms(text: string) {
  const counts: Record<string, number> = {};
  for (const term of TOPIC_TERMS) {
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const matches = text.match(pattern);
    if (matches?.length) counts[term] = (counts[term] ?? 0) + matches.length;
  }
  const asciiTerms = text.match(/[A-Za-z][A-Za-z0-9_-]{1,}/g) ?? [];
  for (const term of asciiTerms) {
    if (term.length < 2 || term.length > 24) continue;
    const normalized = term.toLowerCase() === "ai" ? "AI" : term.toLowerCase();
    counts[normalized] = (counts[normalized] ?? 0) + 1;
  }
  return topEntries(counts, 8).map((entry) => entry.term);
}

function classifyEmotion(text: string, confusionScore: number, urgencyScore: number) {
  if (/焦虑|挫败|崩溃|烦|压力|担心|害怕|不安/.test(text) || urgencyScore >= 60) return "焦虑/急迫";
  if (/困惑|不理解|不知道|迷茫|跟不上|不会|有点难|卡住/.test(text) || confusionScore >= 45) return "困惑/求助";
  if (/谢谢|感谢|赞同|支持|期待|学习了|同感|有道理|喜欢/.test(text)) return "积极/认同";
  if (/不同意|但是|反例|质疑|冲突|争议/.test(text)) return "质疑/协商";
  return "中性";
}

function analyzeUtterance(utterance: SourceUtterance): AnalyzedUtterance {
  const text = normalizeText(utterance.content);
  const cie = classifyCieText(text);
  const learningSignals = detectLearningSignals(text);
  const resourceNeed = /资料|资源|案例|文献|链接|推荐|工具|平台|方法|教程|参考/.test(text);
  const shallowReply = utterance.utteranceType === "reply"
    && text.length <= 90
    && /赞同|有道理|学习了|同感|谢谢|感谢|期待|支持|认同|可以|不错/.test(text)
    && !learningSignals.isQuestion
    && cie.cieLevel <= 3;

  return {
    ...utterance,
    contentPreview: preview(text),
    contentLength: text.length,
    cieLevel: cie.cieLevel,
    cieLabel: cie.cieLabel,
    cieConfidence: cie.confidence,
    iamPhase: cie.iamPhase,
    knowledgePhase: cie.knowledgePhase,
    emotionLabel: classifyEmotion(text, learningSignals.confusionScore, learningSignals.urgencyScore),
    confusionScore: learningSignals.confusionScore,
    urgencyScore: learningSignals.urgencyScore,
    isQuestion: learningSignals.isQuestion,
    resourceNeed,
    shallowReply,
    needsHumanReview: cie.needsHumanReview,
    matchedWords: cie.matchedWords,
    topicTerms: extractTopicTerms(text)
  };
}

async function resolveProfileScope(
  input: SyncUserProfilesInput = {},
  startedAt = new Date()
): Promise<Scope> {
  const requestedCourse = input.courseId || input.platformCourseId
    ? await resolveCourseScope({ courseId: input.courseId, platformCourseId: input.platformCourseId })
    : null;
  const run = input.runId
    ? await prisma.forumIngestionRun.findUnique({
      where: { id: input.runId },
      include: {
        course: true,
        postSnapshots: { select: { postId: true, columnName: true } },
        userSnapshots: { select: { userId: true } }
      }
    })
    : requestedCourse
      ? null
      : await prisma.forumIngestionRun.findFirst({
      where: { status: "completed" },
      orderBy: { createdAt: "desc" },
      include: {
        course: true,
        postSnapshots: { select: { postId: true, columnName: true } },
        userSnapshots: { select: { userId: true } }
      }
      });

  if (input.runId && !run) throw new Error(`找不到论坛采集批次：${input.runId}`);
  if (run && run.status !== "completed") throw new Error(`论坛采集批次尚未完成：${run.id}`);
  if (run && requestedCourse && run.courseId !== requestedCourse.id) {
    throw new Error(`论坛采集批次 ${run.id} 不属于指定课程 ${requestedCourse.platformCourseId}。`);
  }
  const course = run?.course ?? requestedCourse;

  if (run) {
    const finishedAt = run.finishedAt;
    if (!finishedAt) throw new Error(`已完成的论坛采集批次缺少 finishedAt：${run.id}`);
    const postIds = Array.from(new Set(run.postSnapshots.map((snapshot) => snapshot.postId)));
    const userIds = Array.from(new Set(run.userSnapshots.map((snapshot) => snapshot.userId)));
    return {
      type: "forum_ingestion_run",
      runId: run.id,
      sourceUrl: run.sourceUrl,
      course: course ? { id: course.id, platformCourseId: course.platformCourseId, name: course.name } : null,
      postCount: postIds.length,
      postIds,
      userIds,
      columnNameByPostId: new Map(run.postSnapshots.map((snapshot) => [snapshot.postId, snapshot.columnName ?? ""])),
      asOfAt: finishedAt,
      timeBoundaryBasis: "run_finished_at"
    };
  }

  if (course) {
    const posts = await prisma.forumPost.findMany({
      where: { courseId: course.id },
      select: { id: true }
    });
    const memberships = await prisma.courseMembership.findMany({
      where: { courseId: course.id },
      select: { userId: true }
    });
    return {
      type: "course_local_forum_data",
      runId: null,
      sourceUrl: course.sourceUrl,
      course: { id: course.id, platformCourseId: course.platformCourseId, name: course.name },
      postCount: posts.length,
      postIds: posts.map((post) => post.id),
      userIds: memberships.map((membership) => membership.userId),
      columnNameByPostId: new Map(),
      asOfAt: startedAt,
      timeBoundaryBasis: "sync_started_at"
    };
  }

  return {
    type: "all_local_forum_data",
    runId: null,
    sourceUrl: null,
    course: null,
    postCount: 0,
    postIds: [],
    userIds: [],
    columnNameByPostId: new Map(),
    asOfAt: startedAt,
    timeBoundaryBasis: "sync_started_at"
  };
}

function profileRiskFlags(input: {
  utteranceCount: number;
  incomingInteractionCount: number;
  avgConfusionScore: number;
  avgUrgencyScore: number;
  questionRatio: number;
  shallowReplyRatio: number;
  highCieRatio: number;
  humanReviewRatio: number;
  avgCieConfidence: number;
}) {
  const flags: string[] = [];
  if (input.avgConfusionScore >= 40 || input.questionRatio >= 0.45) flags.push("high_confusion_or_questioning");
  if (input.avgUrgencyScore >= 35) flags.push("urgent_help_signal");
  if (input.utteranceCount <= 1) flags.push("low_observed_engagement");
  if (input.shallowReplyRatio >= 0.55 && input.utteranceCount >= 3) flags.push("possible_shallow_participation");
  if (input.incomingInteractionCount <= 1 && input.utteranceCount >= 3) flags.push("possible_isolation");
  if (input.highCieRatio >= 0.5 && input.incomingInteractionCount >= 4) flags.push("high_value_author");
  if (input.utteranceCount >= 3 && input.humanReviewRatio >= 0.7 && input.avgCieConfidence < 0.52) flags.push("needs_human_review_sampling");
  return flags;
}

function choosePersona(input: {
  role: string;
  utteranceCount: number;
  postCount: number;
  replyCount: number;
  incomingInteractionCount: number;
  outgoingInteractionCount: number;
  avgCieLevel: number;
  avgConfusionScore: number;
  questionRatio: number;
  highCieRatio: number;
  shallowReplyRatio: number;
}) {
  if (/学伴|companion|assistant/i.test(input.role)) return "companion";
  if (input.postCount >= 2 && input.incomingInteractionCount >= 5) return "content_hub";
  if (input.replyCount >= 8 && input.outgoingInteractionCount >= 8) return "active_responder";
  if (input.avgConfusionScore >= 40 || input.questionRatio >= 0.45) return "support_needed";
  if (input.avgCieLevel >= 5.5 || input.highCieRatio >= 0.45) return "deep_thinker";
  if (input.shallowReplyRatio >= 0.5 && input.replyCount >= 3) return "social_supporter";
  if (input.utteranceCount <= 1) return "peripheral_observer";
  return "participant";
}

function buildProfileSummary(input: {
  displayName: string;
  personaType: string;
  utteranceCount: number;
  postCount: number;
  replyCount: number;
  avgCieLevel: number;
  dominantKnowledgePhase: string;
  dominantEmotion: string;
  questionRatio: number;
  topTerms: string[];
  riskFlags: string[];
}) {
  const topicText = input.topTerms.length ? `关注主题集中在${input.topTerms.slice(0, 4).join("、")}` : "暂未形成稳定主题";
  const riskText = input.riskFlags.length ? `需关注：${input.riskFlags.join("、")}` : "暂无明显风险信号";
  return `${input.displayName} 当前画像为 ${input.personaType}；共观测 ${input.utteranceCount} 条发言（发帖 ${input.postCount}，回复 ${input.replyCount}），平均 CIE ${round(input.avgCieLevel, 2)}，主要知识阶段为${input.dominantKnowledgePhase}，情绪基调为${input.dominantEmotion}，提问占比 ${round(input.questionRatio * 100, 1)}%。${topicText}；${riskText}。`;
}

function profilePayload(aggregate: UserAggregate, scope: Scope) {
  const sourceRunId = scope.runId;
  const utterances = aggregate.utterances;
  const postCount = utterances.filter((utterance) => utterance.utteranceType === "post").length;
  const replyCount = utterances.filter((utterance) => utterance.utteranceType === "reply").length;
  const nestedReplyCount = utterances.filter((utterance) => utterance.utteranceType === "reply" && utterance.depth > 0).length;
  const avgCieLevel = round(mean(utterances.map((utterance) => utterance.cieLevel)), 3);
  const avgCieConfidence = round(mean(utterances.map((utterance) => utterance.cieConfidence)), 3);
  const avgConfusionScore = round(mean(utterances.map((utterance) => utterance.confusionScore)), 3);
  const avgUrgencyScore = round(mean(utterances.map((utterance) => utterance.urgencyScore)), 3);
  const questionRatio = round(safeDivide(utterances.filter((utterance) => utterance.isQuestion).length, utterances.length), 3);
  const resourceNeedRatio = round(safeDivide(utterances.filter((utterance) => utterance.resourceNeed).length, utterances.length), 3);
  const highCieRatio = round(safeDivide(utterances.filter((utterance) => utterance.cieLevel >= 5).length, utterances.length), 3);
  const shallowReplyRatio = round(safeDivide(utterances.filter((utterance) => utterance.shallowReply).length, utterances.length), 3);
  const humanReviewRatio = round(safeDivide(utterances.filter((utterance) => utterance.needsHumanReview).length, utterances.length), 3);
  const dominantIamPhase = Number(dominant(utterances.map((utterance) => utterance.iamPhase), 1));
  const dominantKnowledgePhase = dominant(utterances.map((utterance) => utterance.knowledgePhase), "unknown");
  const dominantEmotion = dominant(utterances.map((utterance) => utterance.emotionLabel), "unknown");
  const topicCounts = utterances.flatMap((utterance) => utterance.topicTerms).reduce<Record<string, number>>((acc, term) => {
    acc[term] = (acc[term] ?? 0) + 1;
    return acc;
  }, {});
  const topTerms = topEntries(topicCounts, 10).map((entry) => entry.term);
  const riskFlags = profileRiskFlags({
    utteranceCount: utterances.length,
    incomingInteractionCount: aggregate.incomingInteractionCount,
    avgConfusionScore,
    avgUrgencyScore,
    questionRatio,
    shallowReplyRatio,
    highCieRatio,
    humanReviewRatio,
    avgCieConfidence
  });
  const personaType = choosePersona({
    role: aggregate.user.role,
    utteranceCount: utterances.length,
    postCount,
    replyCount,
    incomingInteractionCount: aggregate.incomingInteractionCount,
    outgoingInteractionCount: aggregate.outgoingInteractionCount,
    avgCieLevel,
    avgConfusionScore,
    questionRatio,
    highCieRatio,
    shallowReplyRatio
  });
  const profileSummary = buildProfileSummary({
    displayName: aggregate.user.name,
    personaType,
    utteranceCount: utterances.length,
    postCount,
    replyCount,
    avgCieLevel,
    dominantKnowledgePhase,
    dominantEmotion,
    questionRatio,
    topTerms,
    riskFlags
  });

  const evidence = {
    sourceRunId,
    asOfAt: scope.asOfAt.toISOString(),
    timeBoundaryBasis: scope.timeBoundaryBasis,
    courseId: aggregate.utterances[0]?.courseId ?? null,
    topUtterances: utterances
      .slice()
      .sort((left, right) => right.cieLevel - left.cieLevel || right.contentLength - left.contentLength)
      .slice(0, 5)
      .map((utterance) => ({
        utteranceKey: utterance.utteranceKey,
        utteranceType: utterance.utteranceType,
        sourceKind: utterance.sourceKind,
        title: utterance.title,
        cieLevel: utterance.cieLevel,
        cieLabel: utterance.cieLabel,
        emotionLabel: utterance.emotionLabel,
        contentPreview: utterance.contentPreview
      })),
    distributions: {
      cieLevel: countBy(utterances.map((utterance) => utterance.cieLevel)),
      iamPhase: countBy(utterances.map((utterance) => utterance.iamPhase)),
      emotion: countBy(utterances.map((utterance) => utterance.emotionLabel)),
      knowledgePhase: countBy(utterances.map((utterance) => utterance.knowledgePhase))
    }
  };

  return {
    userId: aggregate.user.id,
    forumUserId: aggregate.user.forumUserId,
    displayName: aggregate.user.name,
    role: aggregate.user.role,
    sourceRunId,
    utteranceCount: utterances.length,
    postCount,
    replyCount,
    nestedReplyCount,
    outgoingInteractionCount: aggregate.outgoingInteractionCount,
    incomingInteractionCount: aggregate.incomingInteractionCount,
    avgCieLevel,
    avgCieConfidence,
    dominantIamPhase,
    dominantKnowledgePhase,
    dominantEmotion,
    avgConfusionScore,
    avgUrgencyScore,
    questionRatio,
    resourceNeedRatio,
    highCieRatio,
    shallowReplyRatio,
    centralityScore: aggregate.user.centralityScore,
    personaType,
    riskFlags,
    interestTerms: topTerms,
    evidence,
    profileSummary
  };
}

async function collectUtterances(scope: Scope) {
  const posts = scope.type !== "all_local_forum_data" && scope.postIds.length === 0
    ? []
    : await prisma.forumPost.findMany({
      where: {
        ...(scope.type === "all_local_forum_data" ? {} : { id: { in: scope.postIds } }),
        ...(scope.course ? { courseId: scope.course.id } : {}),
        createdAt: { lte: scope.asOfAt }
      },
      include: {
        author: true,
        replies: {
          where: {
            createdAt: { lte: scope.asOfAt },
            ...(scope.course
              ? { OR: [{ courseId: null }, { courseId: scope.course.id }] }
              : {})
          },
          include: { author: true },
          orderBy: { createdAt: "asc" }
        }
      },
      orderBy: { createdAt: "asc" }
    });

  const sourceUtterances: SourceUtterance[] = [];
  const scopedUserIds = new Set(scope.userIds);

  for (const post of posts) {
    scopedUserIds.add(post.authorId);
    const columnName = scope.columnNameByPostId.get(post.id) || undefined;
    sourceUtterances.push({
      utteranceKey: `post:${post.id}`,
      userId: post.authorId,
      forumUserId: post.author.forumUserId,
      displayName: post.author.name,
      role: post.author.role,
      sourceKind: inferForumSourceKind({
        storedSourceKind: post.sourceKind,
        authorRole: post.author.role,
        authorForumUserId: post.author.forumUserId,
        authorTagsJson: post.author.tagsJson,
        postUrl: post.url
      }),
      courseId: post.courseId ?? scope.course?.id,
      postId: post.id,
      utteranceType: "post",
      columnName,
      title: post.title,
      content: `${post.title}\n${post.content}`,
      depth: 0,
      sourceCreatedAt: post.createdAt
    });

    for (const reply of post.replies) {
      scopedUserIds.add(reply.authorId);
      if (reply.targetUserId) scopedUserIds.add(reply.targetUserId);
      sourceUtterances.push({
        utteranceKey: `reply:${reply.id}`,
        userId: reply.authorId,
        forumUserId: reply.author.forumUserId,
        displayName: reply.author.name,
        role: reply.author.role,
        sourceKind: inferForumSourceKind({
          storedSourceKind: reply.sourceKind,
          authorRole: reply.author.role,
          authorForumUserId: reply.author.forumUserId,
          authorTagsJson: reply.author.tagsJson,
          postUrl: post.url,
          isCompanionReply: reply.isCompanionReply,
          companionType: reply.companionType
        }),
        courseId: reply.courseId ?? post.courseId ?? scope.course?.id,
        postId: post.id,
        replyId: reply.id,
        utteranceType: "reply",
        columnName,
        title: post.title,
        content: reply.content,
        depth: reply.depth,
        targetUserId: reply.targetUserId ?? (reply.depth === 0 ? post.authorId : undefined),
        sourceCreatedAt: reply.createdAt
      });
    }
  }

  const users = scopedUserIds.size === 0
    ? []
    : await prisma.forumUser.findMany({
      where: { id: { in: Array.from(scopedUserIds) } },
      orderBy: { lastActiveAt: "desc" }
    });

  return {
    users,
    utterances: sourceUtterances.map(analyzeUtterance)
  };
}

async function invalidateExcludedProfiles(
  scope: Scope,
  users: UserAggregate["user"][],
  eligibleUserIds: Set<string>,
  mode: ProfileSyncMode
) {
  const emptyResult = {
    excludedUserCount: 0,
    deletedCourseProfileCount: 0,
    deletedGlobalProfileCount: 0,
    invalidatedMembershipCount: 0
  };
  if (mode !== "materialize" || !scope.course) return emptyResult;

  const excludedUserIds = users
    .map((user) => user.id)
    .filter((userId) => !eligibleUserIds.has(userId));
  if (excludedUserIds.length === 0) return emptyResult;

  const [possiblyLearnerPosts, possiblyLearnerReplies] = await Promise.all([
    prisma.forumPost.findMany({
      where: {
        authorId: { in: excludedUserIds },
        sourceKind: { in: ["learner", "unknown"] }
      },
      select: { authorId: true },
      distinct: ["authorId"]
    }),
    prisma.forumReply.findMany({
      where: {
        authorId: { in: excludedUserIds },
        sourceKind: { in: ["learner", "unknown"] }
      },
      select: { authorId: true },
      distinct: ["authorId"]
    })
  ]);
  const globallyProtectedUserIds = new Set([
    ...possiblyLearnerPosts.map((post) => post.authorId),
    ...possiblyLearnerReplies.map((reply) => reply.authorId)
  ]);
  const globallyExcludedUserIds = excludedUserIds.filter((userId) => !globallyProtectedUserIds.has(userId));
  const exclusionEvidence = json({
    source: "user-profile-sync-agent",
    profileEligible: false,
    reason: "no learner-source utterance in the materialized course scope",
    asOfAt: scope.asOfAt.toISOString()
  });

  const [deletedCourseProfiles, deletedGlobalProfiles, invalidatedMemberships] = await prisma.$transaction([
    prisma.forumUserCourseProfile.deleteMany({
      where: { courseId: scope.course.id, userId: { in: excludedUserIds } }
    }),
    prisma.forumUserProfile.deleteMany({
      where: { userId: { in: globallyExcludedUserIds } }
    }),
    prisma.courseMembership.updateMany({
      where: { courseId: scope.course.id, userId: { in: excludedUserIds } },
      data: {
        activityLevel: 0,
        emotionalState: "unknown",
        centralityScore: 0,
        personaType: "excluded_no_learner_evidence",
        tagsJson: json(["profile-excluded", "no-learner-evidence"]),
        evidenceJson: exclusionEvidence
      }
    })
  ]);

  return {
    excludedUserCount: excludedUserIds.length,
    deletedCourseProfileCount: deletedCourseProfiles.count,
    deletedGlobalProfileCount: deletedGlobalProfiles.count,
    invalidatedMembershipCount: invalidatedMemberships.count
  };
}

export async function syncUserProfiles(input: SyncUserProfilesInput = {}) {
  const startedAt = new Date();
  const mode: ProfileSyncMode = input.mode ?? (input.runId ? "preview" : "materialize");
  const scope = await resolveProfileScope(input, startedAt);
  const { users, utterances } = await collectUtterances(scope);
  const profileEligibleUtterances = utterances.filter((utterance) => isLearnerProfileSource(utterance.sourceKind));
  const eligibleUserIds = new Set(profileEligibleUtterances.map((utterance) => utterance.userId));
  const aggregates = new Map<string, UserAggregate>();

  for (const user of users) {
    if (!eligibleUserIds.has(user.id)) continue;
    aggregates.set(user.id, {
      user,
      utterances: [],
      incomingInteractionCount: 0,
      outgoingInteractionCount: 0
    });
  }

  for (const utterance of profileEligibleUtterances) {
    const aggregate = aggregates.get(utterance.userId);
    if (aggregate) aggregate.utterances.push(utterance);
    if (utterance.utteranceType === "reply" && utterance.targetUserId && utterance.targetUserId !== utterance.userId) {
      const sourceAggregate = aggregates.get(utterance.userId);
      if (sourceAggregate) sourceAggregate.outgoingInteractionCount += 1;
      const targetAggregate = aggregates.get(utterance.targetUserId);
      if (targetAggregate) targetAggregate.incomingInteractionCount += 1;
    }
  }

  if (mode === "materialize") {
    for (const utterance of utterances) {
      await prisma.forumUserUtteranceAnalysis.upsert({
      where: { utteranceKey: utterance.utteranceKey },
      create: {
        utteranceKey: utterance.utteranceKey,
        courseId: utterance.courseId ?? scope.course?.id,
        userId: utterance.userId,
        forumUserId: utterance.forumUserId,
        postId: utterance.postId,
        replyId: utterance.replyId,
        sourceRunId: scope.runId,
        sourceKind: utterance.sourceKind,
        utteranceType: utterance.utteranceType,
        columnName: utterance.columnName,
        title: utterance.title,
        contentPreview: utterance.contentPreview,
        contentLength: utterance.contentLength,
        depth: utterance.depth,
        targetUserId: utterance.targetUserId,
        cieLevel: utterance.cieLevel,
        cieLabel: utterance.cieLabel,
        cieConfidence: utterance.cieConfidence,
        iamPhase: utterance.iamPhase,
        knowledgePhase: utterance.knowledgePhase,
        emotionLabel: utterance.emotionLabel,
        confusionScore: utterance.confusionScore,
        urgencyScore: utterance.urgencyScore,
        isQuestion: utterance.isQuestion,
        resourceNeed: utterance.resourceNeed,
        shallowReply: utterance.shallowReply,
        needsHumanReview: utterance.needsHumanReview,
        matchedWordsJson: json(utterance.matchedWords),
        topicTermsJson: json(utterance.topicTerms),
        sourceCreatedAt: utterance.sourceCreatedAt
      },
      update: {
        courseId: utterance.courseId ?? scope.course?.id,
        userId: utterance.userId,
        forumUserId: utterance.forumUserId,
        postId: utterance.postId,
        replyId: utterance.replyId,
        sourceRunId: scope.runId,
        sourceKind: utterance.sourceKind,
        utteranceType: utterance.utteranceType,
        columnName: utterance.columnName,
        title: utterance.title,
        contentPreview: utterance.contentPreview,
        contentLength: utterance.contentLength,
        depth: utterance.depth,
        targetUserId: utterance.targetUserId,
        cieLevel: utterance.cieLevel,
        cieLabel: utterance.cieLabel,
        cieConfidence: utterance.cieConfidence,
        iamPhase: utterance.iamPhase,
        knowledgePhase: utterance.knowledgePhase,
        emotionLabel: utterance.emotionLabel,
        confusionScore: utterance.confusionScore,
        urgencyScore: utterance.urgencyScore,
        isQuestion: utterance.isQuestion,
        resourceNeed: utterance.resourceNeed,
        shallowReply: utterance.shallowReply,
        needsHumanReview: utterance.needsHumanReview,
        matchedWordsJson: json(utterance.matchedWords),
        topicTermsJson: json(utterance.topicTerms),
        sourceCreatedAt: utterance.sourceCreatedAt,
        analyzedAt: new Date()
      }
      });
    }
  }

  const invalidation = await invalidateExcludedProfiles(scope, users, eligibleUserIds, mode);

  const profileResults = [];
  for (const aggregate of aggregates.values()) {
    const payload = profilePayload(aggregate, scope);
    profileResults.push(payload);
    if (mode === "preview") continue;

    await prisma.forumUserProfile.upsert({
      where: { userId: payload.userId },
      create: {
        userId: payload.userId,
        forumUserId: payload.forumUserId,
        displayName: payload.displayName,
        role: payload.role,
        sourceRunId: payload.sourceRunId,
        utteranceCount: payload.utteranceCount,
        postCount: payload.postCount,
        replyCount: payload.replyCount,
        nestedReplyCount: payload.nestedReplyCount,
        outgoingInteractionCount: payload.outgoingInteractionCount,
        incomingInteractionCount: payload.incomingInteractionCount,
        avgCieLevel: payload.avgCieLevel,
        avgCieConfidence: payload.avgCieConfidence,
        dominantIamPhase: payload.dominantIamPhase,
        dominantKnowledgePhase: payload.dominantKnowledgePhase,
        dominantEmotion: payload.dominantEmotion,
        avgConfusionScore: payload.avgConfusionScore,
        avgUrgencyScore: payload.avgUrgencyScore,
        questionRatio: payload.questionRatio,
        resourceNeedRatio: payload.resourceNeedRatio,
        highCieRatio: payload.highCieRatio,
        shallowReplyRatio: payload.shallowReplyRatio,
        centralityScore: payload.centralityScore,
        personaType: payload.personaType,
        riskFlagsJson: json(payload.riskFlags),
        interestTermsJson: json(payload.interestTerms),
        evidenceJson: json(payload.evidence),
        profileSummary: payload.profileSummary
      },
      update: {
        forumUserId: payload.forumUserId,
        displayName: payload.displayName,
        role: payload.role,
        sourceRunId: payload.sourceRunId,
        utteranceCount: payload.utteranceCount,
        postCount: payload.postCount,
        replyCount: payload.replyCount,
        nestedReplyCount: payload.nestedReplyCount,
        outgoingInteractionCount: payload.outgoingInteractionCount,
        incomingInteractionCount: payload.incomingInteractionCount,
        avgCieLevel: payload.avgCieLevel,
        avgCieConfidence: payload.avgCieConfidence,
        dominantIamPhase: payload.dominantIamPhase,
        dominantKnowledgePhase: payload.dominantKnowledgePhase,
        dominantEmotion: payload.dominantEmotion,
        avgConfusionScore: payload.avgConfusionScore,
        avgUrgencyScore: payload.avgUrgencyScore,
        questionRatio: payload.questionRatio,
        resourceNeedRatio: payload.resourceNeedRatio,
        highCieRatio: payload.highCieRatio,
        shallowReplyRatio: payload.shallowReplyRatio,
        centralityScore: payload.centralityScore,
        personaType: payload.personaType,
        riskFlagsJson: json(payload.riskFlags),
        interestTermsJson: json(payload.interestTerms),
        evidenceJson: json(payload.evidence),
        profileSummary: payload.profileSummary,
        generatedAt: new Date()
      }
    });

    const lastActiveAt = maxDate(aggregate.utterances.map((utterance) => utterance.sourceCreatedAt)) ?? aggregate.user.lastActiveAt;
    const activityLevel = Math.min(100, Math.round(
      payload.utteranceCount * 7 +
        payload.incomingInteractionCount * 5 +
        payload.outgoingInteractionCount * 4 +
        payload.centralityScore * 35
    ));
    if (scope.course) {
      const courseProfileData = {
        forumUserId: payload.forumUserId,
        displayName: payload.displayName,
        role: payload.role,
        sourceRunId: payload.sourceRunId,
        utteranceCount: payload.utteranceCount,
        postCount: payload.postCount,
        replyCount: payload.replyCount,
        nestedReplyCount: payload.nestedReplyCount,
        outgoingInteractionCount: payload.outgoingInteractionCount,
        incomingInteractionCount: payload.incomingInteractionCount,
        avgCieLevel: payload.avgCieLevel,
        avgCieConfidence: payload.avgCieConfidence,
        dominantIamPhase: payload.dominantIamPhase,
        dominantKnowledgePhase: payload.dominantKnowledgePhase,
        dominantEmotion: payload.dominantEmotion,
        avgConfusionScore: payload.avgConfusionScore,
        avgUrgencyScore: payload.avgUrgencyScore,
        questionRatio: payload.questionRatio,
        resourceNeedRatio: payload.resourceNeedRatio,
        highCieRatio: payload.highCieRatio,
        shallowReplyRatio: payload.shallowReplyRatio,
        centralityScore: payload.centralityScore,
        personaType: payload.personaType,
        riskFlagsJson: json(payload.riskFlags),
        interestTermsJson: json(payload.interestTerms),
        evidenceJson: json({ ...payload.evidence, course: scope.course }),
        profileSummary: payload.profileSummary
      };
      await prisma.forumUserCourseProfile.upsert({
        where: { courseId_userId: { courseId: scope.course.id, userId: payload.userId } },
        create: {
          courseId: scope.course.id,
          userId: payload.userId,
          ...courseProfileData
        },
        update: {
          ...courseProfileData,
          generatedAt: new Date()
        }
      });
      await prisma.courseMembership.upsert({
        where: { courseId_userId: { courseId: scope.course.id, userId: payload.userId } },
        create: {
          courseId: scope.course.id,
          userId: payload.userId,
          forumUserId: payload.forumUserId,
          displayName: payload.displayName,
          roleInCourse: payload.role,
          postCount: payload.postCount,
          replyCount: payload.replyCount,
          activityLevel,
          emotionalState: payload.dominantEmotion,
          centralityScore: payload.centralityScore,
          personaType: payload.personaType,
          lastSeenAt: lastActiveAt,
          tagsJson: json(Array.from(new Set([payload.personaType, ...payload.riskFlags, ...payload.interestTerms.slice(0, 3)]))),
          evidenceJson: json({ source: "user-profile-sync-agent", profileSummary: payload.profileSummary })
        },
        update: {
          forumUserId: payload.forumUserId,
          displayName: payload.displayName,
          roleInCourse: payload.role,
          postCount: payload.postCount,
          replyCount: payload.replyCount,
          activityLevel,
          emotionalState: payload.dominantEmotion,
          centralityScore: payload.centralityScore,
          personaType: payload.personaType,
          lastSeenAt: lastActiveAt,
          tagsJson: json(Array.from(new Set([payload.personaType, ...payload.riskFlags, ...payload.interestTerms.slice(0, 3)]))),
          evidenceJson: json({ source: "user-profile-sync-agent", profileSummary: payload.profileSummary })
        }
      });
    }
    await prisma.forumUser.update({
      where: { id: payload.userId },
      data: {
        tagsJson: json(Array.from(new Set([payload.personaType, ...payload.riskFlags, ...payload.interestTerms.slice(0, 3)]))),
        activityLevel,
        emotionalState: payload.dominantEmotion,
        lastActiveAt
      }
    });
  }

  const personaDistribution = countBy(profileResults.map((profile) => profile.personaType));
  const riskFlagDistribution = profileResults.flatMap((profile) => profile.riskFlags).reduce<Record<string, number>>((acc, flag) => {
    acc[flag] = (acc[flag] ?? 0) + 1;
    return acc;
  }, {});
  const topProfiles = profileResults
    .slice()
    .sort((left, right) =>
      right.utteranceCount - left.utteranceCount ||
      right.incomingInteractionCount - left.incomingInteractionCount ||
      right.avgCieLevel - left.avgCieLevel
    )
    .slice(0, 8)
    .map((profile) => ({
      userId: profile.userId,
      forumUserId: profile.forumUserId,
      displayName: profile.displayName,
      personaType: profile.personaType,
      utteranceCount: profile.utteranceCount,
      postCount: profile.postCount,
      replyCount: profile.replyCount,
      avgCieLevel: profile.avgCieLevel,
      dominantEmotion: profile.dominantEmotion,
      incomingInteractionCount: profile.incomingInteractionCount,
      outgoingInteractionCount: profile.outgoingInteractionCount,
      riskFlags: profile.riskFlags,
      interestTerms: profile.interestTerms.slice(0, 5),
      profileSummary: profile.profileSummary
    }));

  const result = {
    mode,
    scope: {
      type: scope.type,
      runId: scope.runId,
      sourceUrl: scope.sourceUrl,
      course: scope.course,
      asOfAt: scope.asOfAt.toISOString(),
      timeBoundaryBasis: scope.timeBoundaryBasis,
      postCount: scope.postCount || new Set(utterances.map((utterance) => utterance.postId).filter(Boolean)).size
    },
    analyzedUtteranceCount: utterances.length,
    profileEligibleUtteranceCount: profileEligibleUtterances.length,
    excludedUtteranceCount: utterances.length - profileEligibleUtterances.length,
    sourceKindDistribution: countBy(utterances.map((utterance) => utterance.sourceKind)),
    profileCount: profileResults.length,
    materializedProfileCount: mode === "materialize" ? profileResults.length : 0,
    courseProfileCount: mode === "materialize" && scope.course ? profileResults.length : 0,
    invalidation,
    personaDistribution,
    riskFlagDistribution,
    topProfiles
  };

  await recordAgentRunBestEffort({
    agentName: "user-profile-sync-agent",
    startedAt,
    input: {
      runId: input.runId ?? null,
      mode,
      scope: result.scope,
      method: "source-boundary filter + as-of cutoff + CIE/IAM rule classifier + learner-only interaction aggregate profile"
    },
    output: result
  });

  return result;
}
