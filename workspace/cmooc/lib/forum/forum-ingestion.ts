import { prisma } from "@/lib/db";
import { recordAgentRunBestEffort } from "@/lib/agents/agent-run";
import { extractPostDetail, type ExtractedPostDetail } from "@/lib/forum/extract-post-detail";
import { scanRealForum } from "@/lib/forum/scan-real-forum";
import { fetchCmoocCourseColumns, fetchCmoocSketchPosts } from "@/lib/forum/cmooc-api";
import { anonymizeLearnerName } from "@/lib/privacy";
import { extractPlatformCourseId, upsertCourseFromSource } from "@/lib/forum/course-scope";
import { assertAllowedForumUrl } from "@/lib/forum/allowed-url";

export type ForumIngestionInput = {
  sourceUrl: string;
  maxPosts?: number;
  courseId?: string;
  platformCourseId?: string;
};

export type ForumIngestionResult = {
  runId: string;
  sourceUrl: string;
  course: {
    id: string;
    platformCourseId: string;
    name: string;
  };
  sourceType: "detail" | "course";
  status: "completed";
  postCount: number;
  replyCount: number;
  userCount: number;
  posts: Array<{
    forumPostId: string;
    title: string;
    url: string;
    replyCount: number;
  }>;
};

type LoadedPost = Awaited<ReturnType<typeof loadPostsForSnapshots>>[number];

type TargetPostRef = {
  url: string;
  columnId?: string;
  columnName?: string;
  authorPlatformId?: string | null;
  authorName?: string;
  likeCount?: number;
  collectCount?: number;
  commentCount?: number;
  createdTime?: string;
};

type UserStat = {
  user: LoadedPost["author"];
  postCount: number;
  replyCount: number;
  companionReplyCount: number;
  textSamples: string[];
  dates: Date[];
};

function clampInteger(value: number | undefined, fallback: number, min: number, max: number) {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.trunc(Math.max(min, Math.min(max, numeric)));
}

function sourceTypeFromUrl(sourceUrl: string): "detail" | "course" {
  return sourceUrl.includes("/detail?") || /[?&]id=\d{16,}/.test(sourceUrl) ? "detail" : "course";
}

function forumPostIdFromUrl(url: string) {
  try {
    return new URL(url).searchParams.get("id") || url;
  } catch {
    return url.match(/\d{16,}/)?.[0] || url;
  }
}

function cleanText(value: string | undefined | null) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function userIdFromName(name: string): string {
  return `real-user-${Buffer.from(name).toString("base64url").slice(0, 80)}`;
}

function userIdFromPlatformId(platformId: string) {
  return `real-user-id-${platformId}`;
}

async function upsertIngestedForumUser(input: { authorName?: string; authorPlatformId?: string | null }) {
  const safeName = cleanText(input.authorName) || "真实论坛用户";
  const forumUserId = input.authorPlatformId ? userIdFromPlatformId(input.authorPlatformId) : userIdFromName(safeName);
  return prisma.forumUser.upsert({
    where: { forumUserId },
    update: {
      name: anonymizeLearnerName(safeName),
      lastActiveAt: new Date()
    },
    create: {
      forumUserId,
      name: anonymizeLearnerName(safeName),
      role: "learner",
      tagsJson: JSON.stringify(["real-forum", "anonymized", "listed-author"]),
      activityLevel: 20,
      emotionalState: "unknown",
      centralityScore: 0,
      lastActiveAt: new Date()
    }
  });
}

async function targetUrls(input: { sourceUrl: string; maxPosts: number; sourceType: "detail" | "course" }): Promise<TargetPostRef[]> {
  if (input.sourceType === "detail") return [{ url: input.sourceUrl }];

  const courseId = extractPlatformCourseId(input.sourceUrl) || process.env.CMOOC_COURSE_ID || null;
  if (courseId) {
    const columns = await fetchCmoocCourseColumns({ courseId }).catch(() => []);
    const refs: TargetPostRef[] = [];
    const seen = new Set<string>();
    for (const column of columns) {
      const posts = await fetchCmoocSketchPosts({
        forumListUrl: input.sourceUrl,
        maxPosts: input.maxPosts,
        columnId: column.columnId,
        columnName: column.columnName
      }).catch(() => []);
      for (const post of posts) {
        if (seen.has(post.url)) continue;
        seen.add(post.url);
        refs.push({
          url: post.url,
          columnId: post.columnId,
          columnName: post.columnName,
          authorPlatformId: post.authorPlatformId,
          authorName: post.authorName,
          likeCount: post.likeCount,
          collectCount: post.collectCount,
          commentCount: post.commentCount,
          createdTime: post.createdTime
        });
        if (refs.length >= input.maxPosts) return refs;
      }
    }
    if (refs.length > 0) return refs;
  }

  const scanned = await scanRealForum({ forumListUrl: input.sourceUrl, maxPosts: input.maxPosts });
  return scanned.map((post) => ({ url: post.url, columnId: post.columnId, columnName: post.columnName })).slice(0, input.maxPosts);
}

async function findPersistedPost(detail: ExtractedPostDetail) {
  const forumPostId = forumPostIdFromUrl(detail.url);
  const post = await prisma.forumPost.findUnique({ where: { forumPostId } })
    ?? await prisma.forumPost.findFirst({ where: { url: detail.url } });
  if (!post) throw new Error(`采集后未找到本地帖子记录：${detail.url}`);
  return post;
}

async function loadPostsForSnapshots(postIds: string[]) {
  return prisma.forumPost.findMany({
    where: { id: { in: postIds } },
    include: {
      author: true,
      replies: {
        include: { author: true },
        orderBy: { createdAt: "asc" }
      }
    }
  });
}

function parseTags(tagsJson: string) {
  try {
    const parsed = JSON.parse(tagsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function addUserStat(stats: Map<string, UserStat>, user: LoadedPost["author"], kind: "post" | "reply", text: string, date: Date, companionReply = false) {
  const stat = stats.get(user.id) ?? {
    user,
    postCount: 0,
    replyCount: 0,
    companionReplyCount: 0,
    textSamples: [],
    dates: []
  };
  if (kind === "post") stat.postCount += 1;
  if (kind === "reply") stat.replyCount += 1;
  if (companionReply) stat.companionReplyCount += 1;
  if (text) stat.textSamples.push(text.slice(0, 280));
  stat.dates.push(date);
  stats.set(user.id, stat);
}

function inferEmotionalState(stat: UserStat) {
  const text = stat.textSamples.join("\n");
  if (/困惑|跟不上|不知道|不确定|迷路|压力|焦虑|挫败|混在一起/.test(text)) return "confused";
  if (/期待|赞同|谢谢|有道理|学习了|支持|同感|值得讨论/.test(text)) return "engaged";
  if (stat.companionReplyCount > 0) return "companion-active";
  return stat.user.emotionalState || "unknown";
}

function firstDate(dates: Date[]) {
  return dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : null;
}

function lastDate(dates: Date[]) {
  return dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))) : null;
}

async function createUserSnapshots(input: { runId: string; courseId: string; posts: LoadedPost[] }) {
  const stats = new Map<string, UserStat>();
  const totalEvents = input.posts.reduce((sum, post) => sum + 1 + post.replies.length, 0);

  for (const post of input.posts) {
    addUserStat(stats, post.author, "post", `${post.title}\n${post.content}`, post.createdAt);
    for (const reply of post.replies) {
      addUserStat(stats, reply.author, "reply", reply.content, reply.createdAt, reply.isCompanionReply);
    }
  }

  for (const stat of stats.values()) {
    const activityLevel = Math.min(100, stat.postCount * 24 + stat.replyCount * 9 + stat.companionReplyCount * 8);
    const centralityScore = totalEvents > 0 ? Math.min(1, (stat.postCount * 2 + stat.replyCount) / totalEvents) : 0;
    const emotionalState = inferEmotionalState(stat);
    const tags = Array.from(new Set([...parseTags(stat.user.tagsJson), "real-forum-snapshot"]));
    const lastSeenAt = lastDate(stat.dates) ?? new Date();

    await prisma.forumUser.update({
      where: { id: stat.user.id },
      data: {
        activityLevel,
        emotionalState,
        centralityScore,
        lastActiveAt: lastSeenAt
      }
    });
    await prisma.forumUserSnapshot.create({
      data: {
        courseId: input.courseId,
        runId: input.runId,
        userId: stat.user.id,
        forumUserId: stat.user.forumUserId,
        displayName: stat.user.name,
        role: stat.user.role,
        postCount: stat.postCount,
        replyCount: stat.replyCount,
        companionReplyCount: stat.companionReplyCount,
        activityLevel,
        emotionalState,
        centralityScore,
        firstSeenAt: firstDate(stat.dates),
        lastSeenAt,
        tagsJson: JSON.stringify(tags),
        evidenceJson: JSON.stringify({
          sampleCount: stat.textSamples.length,
          samples: stat.textSamples.slice(0, 5)
        }, null, 2)
      }
    });
    await prisma.courseMembership.upsert({
      where: { courseId_userId: { courseId: input.courseId, userId: stat.user.id } },
      create: {
        courseId: input.courseId,
        userId: stat.user.id,
        forumUserId: stat.user.forumUserId,
        displayName: stat.user.name,
        roleInCourse: stat.user.role,
        postCount: stat.postCount,
        replyCount: stat.replyCount,
        companionReplyCount: stat.companionReplyCount,
        activityLevel,
        emotionalState,
        centralityScore,
        firstSeenAt: firstDate(stat.dates),
        lastSeenAt,
        tagsJson: JSON.stringify(tags),
        evidenceJson: JSON.stringify({
          source: "forum-ingestion",
          sampleCount: stat.textSamples.length,
          samples: stat.textSamples.slice(0, 5)
        }, null, 2)
      },
      update: {
        forumUserId: stat.user.forumUserId,
        displayName: stat.user.name,
        roleInCourse: stat.user.role,
        postCount: stat.postCount,
        replyCount: stat.replyCount,
        companionReplyCount: stat.companionReplyCount,
        activityLevel,
        emotionalState,
        centralityScore,
        firstSeenAt: firstDate(stat.dates),
        lastSeenAt,
        tagsJson: JSON.stringify(tags),
        evidenceJson: JSON.stringify({
          source: "forum-ingestion",
          sampleCount: stat.textSamples.length,
          samples: stat.textSamples.slice(0, 5)
        }, null, 2)
      }
    });
  }

  return stats.size;
}

export async function runForumIngestion(input: ForumIngestionInput): Promise<ForumIngestionResult> {
  const sourceUrl = assertAllowedForumUrl(
    input.sourceUrl.trim(),
    "论坛采集地址"
  );
  const maxPosts = clampInteger(input.maxPosts, 1, 1, 50);
  const sourceType = sourceTypeFromUrl(sourceUrl);
  const course = await upsertCourseFromSource({
    courseId: input.courseId,
    platformCourseId: input.platformCourseId,
    sourceUrl
  });
  const run = await prisma.forumIngestionRun.create({
    data: {
      courseId: course.id,
      sourceUrl,
      sourceType,
      status: "running",
      metadataJson: JSON.stringify({ maxPosts, courseId: course.id, platformCourseId: course.platformCourseId }, null, 2)
    }
  });

  try {
    const targets = await targetUrls({ sourceUrl, maxPosts, sourceType });
    const postIds: string[] = [];
    const postSummaries: ForumIngestionResult["posts"] = [];

    for (const target of targets) {
      const detail = await extractPostDetail({ postUrl: target.url });
      let post = await findPersistedPost(detail);
      post = await prisma.forumPost.update({
        where: { id: post.id },
        data: { courseId: course.id }
      });
      await prisma.forumReply.updateMany({
        where: { postId: post.id },
        data: { courseId: course.id }
      });
      if (target.authorName || target.authorPlatformId) {
        const listedAuthor = await upsertIngestedForumUser({
          authorName: target.authorName || detail.authorName,
          authorPlatformId: target.authorPlatformId
        });
        post = await prisma.forumPost.update({
          where: { id: post.id },
          data: {
            courseId: course.id,
            authorId: listedAuthor.id,
            likeCount: target.likeCount ?? post.likeCount,
            replyCount: target.commentCount ?? post.replyCount
          }
        });
        await prisma.forumReply.updateMany({
          where: { postId: post.id, depth: 0 },
          data: { targetUserId: listedAuthor.id }
        });
      }
      postIds.push(post.id);
      await prisma.forumPostSnapshot.create({
        data: {
          courseId: course.id,
          runId: run.id,
          postId: post.id,
          forumPostId: post.forumPostId,
          columnId: target.columnId ?? null,
          columnName: target.columnName ?? null,
          title: post.title,
          url: post.url,
          replyCount: post.replyCount,
          likeCount: post.likeCount,
          viewCount: post.viewCount,
          contentLength: post.content.length,
          lastReplyAt: post.lastReplyAt,
          rawJson: JSON.stringify({
            column: {
              columnId: target.columnId ?? null,
              columnName: target.columnName ?? null
            },
            listedAuthor: {
              authorName: target.authorName ?? null,
              authorPlatformId: target.authorPlatformId ?? null
            },
            listedStats: {
              likeCount: target.likeCount ?? null,
              collectCount: target.collectCount ?? null,
              commentCount: target.commentCount ?? null,
              createdTime: target.createdTime ?? null
            },
            detail
          }, null, 2)
        }
      });
      postSummaries.push({
        forumPostId: post.forumPostId,
        title: post.title,
        url: post.url,
        replyCount: post.replyCount
      });
    }

    const loadedPosts = await loadPostsForSnapshots(postIds);
    const replyCount = loadedPosts.reduce((sum, post) => sum + post.replies.length, 0);
    const userCount = await createUserSnapshots({ runId: run.id, courseId: course.id, posts: loadedPosts });

    await prisma.forumIngestionRun.update({
      where: { id: run.id },
      data: {
        status: "completed",
        postCount: loadedPosts.length,
        replyCount,
        userCount,
        finishedAt: new Date(),
        metadataJson: JSON.stringify({
          maxPosts,
          sourceType,
          course: {
            id: course.id,
            platformCourseId: course.platformCourseId,
            name: course.name
          },
          urls: targets.map((target) => target.url),
          columns: targets.map((target) => ({
            url: target.url,
            columnId: target.columnId,
            columnName: target.columnName,
            authorName: target.authorName ?? null,
            authorPlatformId: target.authorPlatformId ?? null
          })),
          postIds
        }, null, 2)
      }
    });
    await prisma.course.update({
      where: { id: course.id },
      data: { lastSyncedAt: new Date(), sourceUrl }
    });
    await recordAgentRunBestEffort({
      agentName: "forum-ingestion-agent",
      input: { sourceUrl, sourceType, maxPosts, courseId: course.id, platformCourseId: course.platformCourseId },
      output: { runId: run.id, courseId: course.id, postCount: loadedPosts.length, replyCount, userCount, posts: postSummaries }
    });

    return {
      runId: run.id,
      sourceUrl,
      course: {
        id: course.id,
        platformCourseId: course.platformCourseId,
        name: course.name
      },
      sourceType,
      status: "completed",
      postCount: loadedPosts.length,
      replyCount,
      userCount,
      posts: postSummaries
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知论坛采集错误";
    await prisma.forumIngestionRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), errorMessage: message }
    });
    throw error;
  }
}
