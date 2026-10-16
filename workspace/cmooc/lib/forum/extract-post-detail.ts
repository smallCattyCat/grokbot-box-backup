import fs from "node:fs";
import { chromium } from "playwright";
import { prisma } from "@/lib/db";
import { screenshotPath, screenshotRoot } from "@/lib/screenshots";
import { upsertScannedForumPost } from "@/lib/forum/scan-real-forum";
import { fetchCmoocPostDetail } from "@/lib/forum/cmooc-api";
import { anonymizeLearnerName } from "@/lib/privacy";
import { inferForumSourceKind } from "@/lib/forum/source-kind";
import { assertAllowedForumUrl } from "@/lib/forum/allowed-url";

export type ExtractedComment = {
  index: number;
  id?: string;
  parentId?: string | null;
  depth?: number;
  authorPlatformId?: string | null;
  authorName: string;
  content: string;
  time: string;
};

export type ExtractedPostDetail = {
  url: string;
  title: string;
  authorPlatformId?: string | null;
  authorName: string;
  tags: string[];
  content: string;
  editedAt: string;
  commentCount: number;
  comments: ExtractedComment[];
};

const authStatePath = "playwright/auth-state.json";

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function legacyForumReplyPrefix(postUrl: string) {
  return `real-${Buffer.from(postUrl).toString("base64url").slice(0, 40)}-`;
}

function fallbackForumReplyPrefix(postId: string) {
  return `real-fallback-${postId}-`;
}

function forumReplyId(postId: string, index: number, authorForumUserId: string, platformReplyId?: string | null): string {
  if (platformReplyId) return `real-cmooc-comment-${platformReplyId}`;
  return `${fallbackForumReplyPrefix(postId)}${index}-${Buffer.from(authorForumUserId).toString("base64url").slice(0, 32)}`;
}

function userIdFromName(name: string): string {
  return `real-user-${Buffer.from(name).toString("base64url").slice(0, 80)}`;
}

function userIdFromPlatformId(platformId: string) {
  return `real-user-id-${platformId}`;
}

async function upsertForumUser(name: string, platformId?: string | null) {
  const safeName = cleanText(name) || "真实论坛用户";
  const displayName = anonymizeLearnerName(safeName);
  const forumUserId = platformId ? userIdFromPlatformId(platformId) : userIdFromName(safeName);
  return prisma.forumUser.upsert({
    where: { forumUserId },
    update: { name: displayName, lastActiveAt: new Date() },
    create: {
      forumUserId,
      name: displayName,
      role: "learner",
      tagsJson: JSON.stringify(["real-forum", "anonymized"]),
      activityLevel: 20,
      emotionalState: "unknown",
      centralityScore: 0,
      lastActiveAt: new Date()
    }
  });
}

export async function persistExtractedPost(extracted: ExtractedPostDetail) {
  const author = await upsertForumUser(extracted.authorName, extracted.authorPlatformId);
  const post = await upsertScannedForumPost({
    url: extracted.url,
    title: extracted.title || extracted.url,
    content: extracted.content,
    replyCount: extracted.commentCount
  });
  await prisma.forumPost.update({
    where: { id: post.id },
    data: {
      authorId: author.id,
      sourceKind: inferForumSourceKind({
        storedSourceKind: post.isScannerPlaceholder ? undefined : post.sourceKind,
        authorRole: author.role,
        authorForumUserId: author.forumUserId,
        authorTagsJson: author.tagsJson,
        postUrl: extracted.url
      }),
      title: extracted.title || post.title,
      content: extracted.content,
      replyCount: extracted.commentCount
    }
  });

  if (extracted.comments.some((comment) => !comment.id)) {
    await prisma.forumReply.updateMany({
      where: {
        postId: post.id,
        platformReplyId: null,
        sourceKind: "learner",
        OR: [
          { forumReplyId: { startsWith: legacyForumReplyPrefix(extracted.url) } },
          { forumReplyId: { startsWith: fallbackForumReplyPrefix(post.id) } }
        ]
      },
      data: { sourceKind: "unknown" }
    });
  }

  const authorIdByPlatformCommentId = new Map<string, string>();
  let sawPlatformReplyIds = false;
  for (const comment of extracted.comments) {
    if (!comment.content) continue;
    const commentAuthor = await upsertForumUser(comment.authorName, comment.authorPlatformId);
    const depth = Math.max(0, Number(comment.depth ?? 0));
    const targetUserId = comment.parentId
      ? authorIdByPlatformCommentId.get(comment.parentId) ?? author.id
      : author.id;
    let replyId = forumReplyId(post.id, comment.index, commentAuthor.forumUserId, comment.id);
    let existingReply = await prisma.forumReply.findUnique({
      where: { forumReplyId: replyId },
      select: { sourceKind: true, isCompanionReply: true, companionType: true }
    });
    if (!comment.id && !existingReply) {
      const legacyReplies = await prisma.forumReply.findMany({
        where: {
          postId: post.id,
          authorId: commentAuthor.id,
          platformReplyId: null,
          forumReplyId: { startsWith: `${legacyForumReplyPrefix(extracted.url)}${comment.index}-` }
        },
        select: {
          id: true,
          forumReplyId: true,
          sourceKind: true,
          isCompanionReply: true,
          companionType: true
        }
      });
      if (legacyReplies.length === 1) {
        replyId = legacyReplies[0].forumReplyId;
        existingReply = legacyReplies[0];
      } else if (legacyReplies.length > 1) {
        await prisma.forumReply.updateMany({
          where: {
            id: { in: legacyReplies.map((reply) => reply.id) },
            sourceKind: "learner"
          },
          data: { sourceKind: "unknown" }
        });
      }
    }
    const detectedCompanion = comment.content.includes("智能学伴自动干预") || /companion|assistant|学伴/i.test(commentAuthor.role);
    const isCompanionReply = detectedCompanion
      || existingReply?.isCompanionReply === true
      || existingReply?.sourceKind === "companion";
    const companionType = existingReply?.companionType ?? (detectedCompanion ? "auto" : null);
    const trustedStoredSourceKind = comment.id
      || ["companion", "system", "test"].includes(existingReply?.sourceKind ?? "")
      ? existingReply?.sourceKind
      : undefined;
    const sourceKind = inferForumSourceKind({
      storedSourceKind: trustedStoredSourceKind,
      authorRole: comment.id ? commentAuthor.role : undefined,
      authorForumUserId: comment.id ? commentAuthor.forumUserId : undefined,
      authorTagsJson: comment.id ? commentAuthor.tagsJson : undefined,
      postUrl: extracted.url,
      isCompanionReply,
      companionType
    });
    sawPlatformReplyIds ||= Boolean(comment.id);
    await prisma.forumReply.upsert({
      where: { forumReplyId: replyId },
      update: {
        content: comment.content,
        authorId: commentAuthor.id,
        targetUserId,
        platformReplyId: comment.id ?? null,
        parentPlatformReplyId: comment.parentId ?? null,
        depth,
        isCompanionReply,
        companionType,
        sourceKind
      },
      create: {
        forumReplyId: replyId,
        platformReplyId: comment.id ?? null,
        parentPlatformReplyId: comment.parentId ?? null,
        postId: post.id,
        authorId: commentAuthor.id,
        targetUserId,
        depth,
        content: comment.content,
        isCompanionReply,
        companionType,
        sourceKind
      }
    });
    if (comment.id) authorIdByPlatformCommentId.set(comment.id, commentAuthor.id);
  }

  if (sawPlatformReplyIds) {
    await prisma.forumReply.deleteMany({
      where: {
        postId: post.id,
        platformReplyId: null,
        OR: [
          { forumReplyId: { startsWith: legacyForumReplyPrefix(extracted.url) } },
          { forumReplyId: { startsWith: fallbackForumReplyPrefix(post.id) } }
        ]
      }
    });
  }
  return extracted;
}

export async function extractPostDetail(input: { postUrl: string }): Promise<ExtractedPostDetail> {
  input = {
    postUrl: assertAllowedForumUrl(input.postUrl, "论坛帖子地址")
  };
  const apiExtracted = await fetchCmoocPostDetail(input).catch((error) => {
    console.warn(`[extract-post-detail] cMOOC API 详情提取失败，准备回退浏览器：${error instanceof Error ? error.message : "unknown"}`);
    return null;
  });
  if (apiExtracted && (apiExtracted.title || apiExtracted.content || apiExtracted.comments.length > 0)) {
    return persistExtractedPost(apiExtracted);
  }

  if (!fs.existsSync(authStatePath)) {
    throw new Error("缺少 cMOOC API 学伴账号配置或 playwright/auth-state.json；请配置 CMOOC_SATOKEN/CMOOC_PARTNER_ACCOUNT，或先运行 npm run auth:save。");
  }
  await fs.promises.mkdir(screenshotRoot, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: authStatePath });
  const page = await context.newPage();
  try {
    await page.goto(input.postUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector(".detail_content", { timeout: 20_000 });
    await page.locator(".comment").scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(async () => {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);

    const readText = async (selector: string) => cleanText(await page.locator(selector).first().innerText({ timeout: 2_000 }).catch(() => ""));
    const readAllText = async (selector: string) => (await page.locator(selector).allInnerTexts()).map(cleanText).filter(Boolean);
    const readScopedText = async (rootSelector: string, index: number, selector: string) =>
      cleanText(await page.locator(rootSelector).nth(index).locator(selector).first().innerText({ timeout: 1_000 }).catch(() => ""));

    const commentLocator = page.locator(".comment .items > .cComment.item");
    const commentCount = await commentLocator.count();
    const comments: ExtractedComment[] = [];
    for (let index = 0; index < commentCount; index += 1) {
      comments.push({
        index,
        authorName: await readScopedText(".comment .items > .cComment.item", index, ".name"),
        content: await readScopedText(".comment .items > .cComment.item", index, ".content"),
        time: await readScopedText(".comment .items > .cComment.item", index, ".buttons .time")
      });
    }

    const extracted: ExtractedPostDetail = {
      url: input.postUrl,
      title:
        (await readText(".detail_content h1")) ||
        (await readText(".detail_content .title")) ||
        (await readText(".detail_content .topic")) ||
        (await readText("h1")) ||
        cleanText(await page.title()),
      authorName: await readText(".detail_content .userInfo"),
      tags: await readAllText(".detail_content .tags .tag"),
      content: await readText(".detail_content .content"),
      editedAt: await readText(".detail_content .time"),
      commentCount,
      comments
    };

    const outputPath = screenshotPath(`extract-post-${Date.now()}.png`);
    await page.screenshot({ path: outputPath, fullPage: true });

    return persistExtractedPost(extracted);
  } finally {
    await browser.close();
  }
}
