import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { getForumSettings, type ForumSettingsInput } from "@/lib/settings";
import { screenshotPath, screenshotRoot } from "@/lib/screenshots";
import { fetchCmoocPostDetail, publishCmoocCommentReply, publishCmoocPostComment } from "@/lib/forum/cmooc-api";
import { assertAllowedForumUrl } from "@/lib/forum/allowed-url";
import { assertRealForumWriteUnlocked } from "@/lib/forum/real-write-lock";
import { forumSelectors, getRealForumSelectors } from "./selectors";

export type PublishMode = "mock" | "real";
export type RealPublishTargetMode = "post_comment" | "comment_reply";
export type TargetCommentStrategy = "first" | "last" | "by_text";
export type RealPublishTransport = "auto" | "api" | "browser";

export type PublishReplyInput = {
  mode: PublishMode;
  postId: string;
  forumPostId?: string;
  postUrl?: string;
  content: string;
  baseUrl?: string;
  settings?: ForumSettingsInput;
  targetMode?: RealPublishTargetMode;
  targetCommentIndex?: number;
  targetCommentStrategy?: TargetCommentStrategy;
  targetCommentText?: string;
  targetPlatformReplyId?: string;
  targetCommentContentHash?: string;
  realTransport?: RealPublishTransport;
};

export type PublishReplyResult = {
  publishedUrl: string;
  screenshotPath: string;
  tracePath?: string;
  transport?: "mock_browser" | "real_browser" | "cmooc_api";
};

function buildRealPostUrl(input: PublishReplyInput, settings: ForumSettingsInput): string {
  if (input.postUrl?.startsWith("http")) {
    return assertAllowedForumUrl(input.postUrl, "真实发布帖子地址");
  }
  if (!settings.postUrlPattern.trim()) {
    throw new Error("真实论坛发布配置不完整，缺少：postUrlPattern。也可以把 ForumPost.url 设置为 http 开头的真实帖子地址。");
  }
  const id = input.postId;
  const forumPostId = input.forumPostId ?? input.postId;
  return assertAllowedForumUrl(
    settings.postUrlPattern
      .replaceAll("{id}", id)
      .replaceAll("{postId}", id)
      .replaceAll("{forumPostId}", forumPostId),
    "真实发布帖子地址"
  );
}

async function ensureScreenshotDir() {
  await fs.promises.mkdir(screenshotRoot, { recursive: true });
}

function compactSnippet(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 20);
}

function normalizedCommentHash(content: string): string {
  return createHash("sha256")
    .update(content.replace(/\s+/g, " ").trim(), "utf8")
    .digest("hex");
}

export function assertStableCommentTarget(input: {
  comments: Array<{ id: string; content: string }>;
  targetPlatformReplyId?: string;
  targetCommentContentHash?: string;
}) {
  if (!input.targetPlatformReplyId || !input.targetCommentContentHash) {
    throw new Error("评论回复目标缺少稳定平台标识或内容指纹，已阻止发布。");
  }
  const targetComment = input.comments.find(
    (comment) => comment.id === input.targetPlatformReplyId
  );
  if (!targetComment) {
    throw new Error("已审阅的目标评论已删除或不再可见，已阻止发布。");
  }
  if (normalizedCommentHash(targetComment.content) !== input.targetCommentContentHash) {
    throw new Error("目标评论内容已发生变化，请重新生成并审阅干预计划。");
  }
  return targetComment;
}

export async function validateRealReplyTarget(input: {
  postUrl: string;
  targetMode: RealPublishTargetMode;
  targetPlatformReplyId?: string;
  targetCommentContentHash?: string;
}) {
  const postUrl = assertAllowedForumUrl(input.postUrl, "真实发布帖子地址");
  if (input.targetMode !== "comment_reply") return;
  const detail = await fetchCmoocPostDetail({ postUrl });
  assertStableCommentTarget({
    comments: detail?.comments ?? [],
    targetPlatformReplyId: input.targetPlatformReplyId,
    targetCommentContentHash: input.targetCommentContentHash
  });
}

function cjkSnippet(content: string): string {
  return Array.from(content.matchAll(/[\u3400-\u9fff]/g))
    .map((match) => match[0])
    .join("")
    .slice(0, 6);
}

function assertRealContentEncodingSafe(content: string): void {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) {
    throw new Error("真实论坛发布内容为空，已阻止提交。");
  }
  if (compact.includes("\uFFFD") || (/\?{2,}/.test(compact) && cjkSnippet(compact).length === 0)) {
    throw new Error("真实论坛发布内容疑似已在脚本或终端管道中变成乱码，已阻止提交。请改用 UTF-8 文件脚本或数据库内容重试。");
  }
}

async function countTopLevelComments(page: Page, commentItemSelector: string): Promise<number> {
  return page.locator(commentItemSelector).count();
}

async function waitForPublishedReplyText(page: Page, content: string): Promise<void> {
  const snippet = compactSnippet(content);
  if (!snippet) {
    throw new Error("回复内容为空，无法判断发布成功。");
  }
  await page.waitForFunction(
    (text) => {
      const clone = document.body.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll("#edit, .ql-editor, textarea, input, [contenteditable='true']")
        .forEach((element) => element.remove());
      return clone.innerText.replace(/\s+/g, " ").includes(text);
    },
    snippet,
    { timeout: 20_000 }
  );
}

async function waitForTopLevelCommentCountIncrease(page: Page, commentItemSelector: string, beforeCommentCount: number): Promise<void> {
  await page.waitForFunction(
    ({ selector, beforeCount }) => document.querySelectorAll(selector).length > beforeCount,
    { selector: commentItemSelector, beforeCount: beforeCommentCount },
    { timeout: 20_000 }
  );
}

async function insertQuillText(page: Page, editor: Locator, submitButton: Locator, content: string): Promise<void> {
  assertRealContentEncodingSafe(content);
  const expectedCjk = cjkSnippet(content);
  await editor.click();
  await page.keyboard.insertText(content);
  await page.waitForTimeout(500);
  const enabledAfterKeyboard = await submitButton.isEnabled({ timeout: 1_500 }).catch(() => false);
  const editorText = await editor.innerText({ timeout: 1_500 }).catch(() => "");
  if (enabledAfterKeyboard && editorText.includes(compactSnippet(content).slice(0, 8)) && (!expectedCjk || cjkSnippet(editorText).includes(expectedCjk))) {
    return;
  }
  await editor.evaluate((element, text) => {
    element.innerHTML = "";
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    element.appendChild(paragraph);
    for (const eventName of ["input", "compositionend", "keyup"]) {
      element.dispatchEvent(new Event(eventName, { bubbles: true, cancelable: true }));
    }
  }, content);
  await page.waitForTimeout(500);
  const fallbackEditorText = await editor.innerText({ timeout: 1_500 }).catch(() => "");
  if (expectedCjk && !cjkSnippet(fallbackEditorText).includes(expectedCjk)) {
    throw new Error("Quill 编辑器中的文本未保留中文关键片段，疑似发生编码损坏，已阻止点击发布。");
  }
  if (!fallbackEditorText.includes(compactSnippet(content).slice(0, 8))) {
    throw new Error("Quill 编辑器文本与待发布内容不一致，已阻止点击发布。");
  }
}

async function pickTargetComment(input: PublishReplyInput, comments: Locator): Promise<Locator> {
  const count = await comments.count();
  if (count === 0) {
    throw new Error("真实论坛页面未找到任何顶层评论，无法执行 comment_reply。");
  }
  if (input.targetCommentIndex !== undefined) {
    if (input.targetCommentIndex < 0 || input.targetCommentIndex >= count) {
      throw new Error(`targetCommentIndex 超出范围：${input.targetCommentIndex}，当前评论数量：${count}`);
    }
    return comments.nth(input.targetCommentIndex);
  }
  if (input.targetCommentStrategy === "last") {
    return comments.nth(count - 1);
  }
  if (input.targetCommentStrategy === "by_text") {
    if (!input.targetCommentText?.trim()) {
      throw new Error("targetCommentStrategy=by_text 时必须提供 targetCommentText。");
    }
    const matched = comments.filter({ hasText: input.targetCommentText });
    if ((await matched.count()) === 0) {
      throw new Error(`未找到包含目标文本的评论：${input.targetCommentText}`);
    }
    return matched.first();
  }
  return comments.first();
}

async function publishReplyWithCmoocApi(input: PublishReplyInput): Promise<PublishReplyResult> {
  if (!input.postUrl?.startsWith("http")) {
    throw new Error("cMOOC API 发布需要真实帖子 URL。");
  }
  const postUrl = assertAllowedForumUrl(input.postUrl, "真实发布帖子地址");
  if ((input.targetMode ?? "post_comment") === "post_comment") {
    const result = await publishCmoocPostComment({
      postUrl,
      content: input.content
    });
    return {
      publishedUrl: result.publishedUrl,
      screenshotPath: `cmooc-api:${result.moduleId}:${result.afterCommentCount}`,
      transport: "cmooc_api"
    };
  }

  const detail = await fetchCmoocPostDetail({ postUrl });
  const targetComment = assertStableCommentTarget({
    comments: detail?.comments ?? [],
    targetPlatformReplyId: input.targetPlatformReplyId,
    targetCommentContentHash: input.targetCommentContentHash
  });
  const result = await publishCmoocCommentReply({
    postUrl,
    content: input.content,
    commentReplyId: targetComment.id
  });
  return {
    publishedUrl: result.publishedUrl,
    screenshotPath: `cmooc-api:${result.moduleId}:${result.afterCommentCount}`,
    transport: "cmooc_api"
  };
}

export async function publishReplyWithPlaywright(input: PublishReplyInput): Promise<PublishReplyResult> {
  if (input.mode === "real") {
    assertRealForumWriteUnlocked();
  }
  await ensureScreenshotDir();
  if (input.mode === "mock") {
    const baseUrl = input.baseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const url = `${baseUrl}/mock-forum/posts/${input.postId}`;
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle" });
      await page.fill(forumSelectors.mock.replyEditor, input.content);
      await page.click(forumSelectors.mock.replySubmit);
      await page.waitForSelector(forumSelectors.mock.replySuccess, { timeout: 10_000 });
      const outputPath = screenshotPath(`publish-mock-${input.postId}-${Date.now()}.png`);
      await page.screenshot({ path: outputPath, fullPage: true });
      return { publishedUrl: url, screenshotPath: outputPath, transport: "mock_browser" };
    } finally {
      await browser.close();
    }
  }

  const settings = input.settings ?? (await getForumSettings());
  // API is the only default transport. Browser automation is an explicit
  // diagnostic choice and is never a silent fallback after an ambiguous API
  // attempt, which prevents accidental duplicate replies.
  if (input.realTransport !== "browser") {
    return publishReplyWithCmoocApi(input);
  }
  if ((input.targetMode ?? "post_comment") === "comment_reply") {
    throw new Error("稳定评论目标只允许使用 cMOOC API 发布；浏览器诊断通道仅支持主题帖主评论。");
  }
  const selectors = getRealForumSelectors(settings);
  const authStatePath = path.join("playwright", "auth-state.json");
  if (!fs.existsSync(authStatePath)) {
    throw new Error("缺少 playwright/auth-state.json。请先运行 npm run auth:save 并手动登录真实论坛。");
  }

  const url = buildRealPostUrl(input, settings);
  const targetMode = input.targetMode ?? "post_comment";
  const debug = {
    targetMode,
    postUrl: url,
    targetCommentIndex: input.targetCommentIndex,
    targetCommentStrategy: input.targetCommentStrategy,
    commentCount: 0,
    clickedReplyButton: false,
    foundNestedEditor: false,
    foundNestedSubmitButton: false,
    currentPageUrl: "",
    screenshotPath: "",
    tracePath: ""
  };
  console.log("[real-publish] start", debug);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: authStatePath });
  const page = await context.newPage();
  try {
    const tracePath = screenshotPath(`trace-real-${input.postId}-${Date.now()}.zip`);
    debug.tracePath = tracePath;
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await page.locator(".comment_container").scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(async () => {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    });
    if (targetMode === "comment_reply") {
      await page.waitForSelector(selectors.commentItem, { timeout: 15_000 });
    }
    debug.currentPageUrl = page.url();
    debug.commentCount = await countTopLevelComments(page, selectors.commentItem);
    const beforeText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
    const beforeCommentCount = debug.commentCount;

    if (targetMode === "post_comment") {
      const editor = page.locator(selectors.postCommentEditor).first();
      const submitButton = page.locator(selectors.postCommentSubmit).first();
      await editor.waitFor({ state: "visible", timeout: 15_000 });
      await submitButton.waitFor({ state: "visible", timeout: 15_000 });
      await insertQuillText(page, editor, submitButton, input.content);
      await submitButton.click();
      await waitForTopLevelCommentCountIncrease(page, selectors.commentItem, beforeCommentCount);
      await waitForPublishedReplyText(page, input.content);
    } else {
      const comments = page.locator(selectors.commentItem);
      const targetComment = await pickTargetComment(input, comments);
      await targetComment.scrollIntoViewIfNeeded();
      const replyButton = targetComment.locator(selectors.commentReplyButton).first();
      await replyButton.waitFor({ state: "visible", timeout: 15_000 });
      await replyButton.click();
      debug.clickedReplyButton = true;

      let editor = targetComment.locator(selectors.nestedReplyEditorScoped).first();
      if ((await editor.count()) === 0) {
        editor = targetComment.locator(selectors.nestedReplyEditorFallback).first();
      }
      await editor.waitFor({ state: "visible", timeout: 15_000 });
      debug.foundNestedEditor = true;

      let submitButton = targetComment.locator(selectors.nestedReplySubmitScoped).first();
      if ((await submitButton.count()) === 0) {
        submitButton = targetComment.locator(selectors.nestedReplySubmitFallback).first();
      }
      await submitButton.waitFor({ state: "visible", timeout: 15_000 });
      debug.foundNestedSubmitButton = true;

      await insertQuillText(page, editor, submitButton, input.content);
      await submitButton.click();
      await waitForPublishedReplyText(page, input.content);
    }

    debug.commentCount = await countTopLevelComments(page, selectors.commentItem);
    console.log("[real-publish] text-before-length", beforeText.length);
    console.log("[real-publish] top-level-comment-count", { before: beforeCommentCount, after: debug.commentCount });
    const outputPath = screenshotPath(`publish-real-${input.postId}-${Date.now()}.png`);
    await page.screenshot({ path: outputPath, fullPage: true });
    await context.tracing.stop({ path: tracePath });
    debug.currentPageUrl = page.url();
    debug.screenshotPath = outputPath;
    console.log("[real-publish] success", debug);
    return { publishedUrl: url, screenshotPath: outputPath, tracePath, transport: "real_browser" };
  } catch (error) {
    const outputPath = screenshotPath(`debug-real-failed-${Date.now()}.png`);
    await page.screenshot({ path: outputPath, fullPage: true }).catch(() => undefined);
    if (debug.tracePath) {
      await context.tracing.stop({ path: debug.tracePath }).catch(() => undefined);
    }
    debug.currentPageUrl = page.url();
    debug.screenshotPath = outputPath;
    console.log("[real-publish] failed", debug);
    const message = error instanceof Error ? error.message : "未知真实论坛发布错误";
    throw new Error(`${message}；调试截图：${outputPath}${debug.tracePath ? `；trace：${debug.tracePath}` : ""}`);
  } finally {
    await browser.close();
  }
}
