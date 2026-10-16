import fs from "node:fs";
import { chromium, type Page, type Response } from "playwright";
import { prisma } from "@/lib/db";
import { screenshotPath, screenshotRoot } from "@/lib/screenshots";
import { fetchCmoocSketchPosts } from "@/lib/forum/cmooc-api";
import { assertAllowedForumUrl } from "@/lib/forum/allowed-url";

type SketchPageRecord = {
  moduleId?: string;
  moduleTitle?: string;
  moduleContent?: string;
  moduleComment?: number;
  createdTime?: string;
};

type SketchPageResponse = {
  data?: {
    records?: SketchPageRecord[];
  };
};

type CandidateCollector = {
  add: (url: string | null, titleCandidate: string, cardText: string, sourceIndex: number) => void;
  posts: () => ScannedForumPost[];
  size: () => number;
};

export type ScannedForumPost = {
  url: string;
  titleCandidate: string;
  cardText: string;
  sourceIndex: number;
  columnId?: string;
  columnName?: string;
};

const DETAIL_URL_PATTERN = /^https:\/\/cmooc\.bnu\.edu\.cn\/cMOOC\/detail\?id=[^#&\s]+/i;
const DETAIL_PATH_PATTERN = /\/cMOOC\/detail\?id=|[?&]id=[^#&\s]+/i;
const POST_ID_PATTERN = /\b\d{16,}\b/g;
const authStatePath = "playwright/auth-state.json";

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function forumPostIdFromUrl(url: string): string {
  try {
    return new URL(url).searchParams.get("id") || url;
  } catch {
    return url;
  }
}

async function ensureSystemUser() {
  return prisma.forumUser.upsert({
    where: { forumUserId: "real-forum-scanner" },
    update: { lastActiveAt: new Date() },
    create: {
      forumUserId: "real-forum-scanner",
      name: "Real Forum Scanner",
      role: "scanner",
      tagsJson: JSON.stringify(["real-forum", "auto-scan"]),
      activityLevel: 0,
      emotionalState: "unknown",
      centralityScore: 0,
      lastActiveAt: new Date()
    }
  });
}

export async function upsertScannedForumPost(input: {
  url: string;
  title: string;
  content?: string;
  replyCount?: number;
  createdAt?: Date;
}) {
  const scanner = await ensureSystemUser();
  const forumPostId = forumPostIdFromUrl(input.url);
  const post = await prisma.forumPost.upsert({
    where: { forumPostId },
    update: {
      title: input.title || forumPostId,
      content: input.content ?? undefined,
      url: input.url,
      replyCount: input.replyCount ?? undefined
    },
    create: {
      forumPostId,
      sourceKind: "system",
      authorId: scanner.id,
      title: input.title || forumPostId,
      content: input.content ?? "",
      url: input.url,
      replyCount: input.replyCount ?? 0,
      likeCount: 0,
      viewCount: 0,
      createdAt: input.createdAt ?? new Date()
    }
  });
  return {
    ...post,
    isScannerPlaceholder: post.sourceKind === "system" && post.authorId === scanner.id
  };
}

function normalizeDetailUrl(href: string, pageUrl: string): string | null {
  try {
    const url = new URL(href, pageUrl);
    if (url.hostname !== "cmooc.bnu.edu.cn") return null;
    const id = url.searchParams.get("id");
    if (!id) return null;
    const type = url.searchParams.get("type");
    return `https://cmooc.bnu.edu.cn/cMOOC/detail?id=${id}${type ? `&type=${encodeURIComponent(type)}` : ""}`;
  } catch {
    return null;
  }
}

function detailUrlFromId(id: string): string {
  return `https://cmooc.bnu.edu.cn/cMOOC/detail?id=${id}&type=SKETCH`;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/g, " ");
}

function createCandidateCollector(maxPosts: number): CandidateCollector {
  const candidates: ScannedForumPost[] = [];
  const seen = new Set<string>();
  return {
    add: (url, titleCandidate, cardText, sourceIndex) => {
      if (!url || !DETAIL_URL_PATTERN.test(url) || seen.has(url) || candidates.length >= maxPosts) return;
      seen.add(url);
      candidates.push({
        url,
        titleCandidate: normalizeText(titleCandidate),
        cardText: normalizeText(cardText).slice(0, 1200),
        sourceIndex
      });
    },
    posts: () => candidates.slice(0, maxPosts),
    size: () => candidates.length
  };
}

function postFromSketchRecord(record: SketchPageRecord, sourceIndex: number): ScannedForumPost | null {
  if (!record.moduleId) return null;
  return {
    url: detailUrlFromId(record.moduleId),
    titleCandidate: normalizeText(record.moduleTitle || record.moduleId),
    cardText: normalizeText(`${record.moduleTitle || ""} ${stripHtml(record.moduleContent || "")}`).slice(0, 1200),
    sourceIndex
  };
}

async function collectSketchResponsePosts(response: Response, collector: CandidateCollector, sourceOffset: number) {
  if (!response.url().includes("/cmooc-api/sketch/page")) return;
  const payload = (await response.json().catch(() => null)) as SketchPageResponse | null;
  const records = payload?.data?.records || [];
  records.forEach((record, index) => {
    const post = postFromSketchRecord(record, sourceOffset + index);
    if (post) collector.add(post.url, post.titleCandidate, post.cardText, post.sourceIndex);
  });
}

async function collectVisibleLinks(page: Page, collector: CandidateCollector, pageUrl: string) {
  const links = page.locator("a[href]");
  const linkCount = await links.count();
  for (let index = 0; index < linkCount; index += 1) {
    const link = links.nth(index);
    const href = (await link.getAttribute("href")) || "";
    if (!DETAIL_PATH_PATTERN.test(href)) continue;
    const titleCandidate = await link.innerText({ timeout: 1_000 }).catch(() => "");
    const cardText = await link
      .locator("xpath=ancestor-or-self::*[self::article or self::li or contains(@class,'item') or contains(@class,'card')][1]")
      .innerText({ timeout: 1_000 })
      .catch(() => titleCandidate);
    collector.add(normalizeDetailUrl(href, pageUrl), titleCandidate, cardText, index);
  }
}

async function collectVisibleCardIds(page: Page, collector: CandidateCollector, sourceOffset: number) {
  const cards = page.locator(".cards .card, .card, .list-item, .post-item, li");
  const cardCount = Math.min(await cards.count(), 80);
  for (let index = 0; index < cardCount; index += 1) {
    const card = cards.nth(index);
    const cardText = await card.innerText({ timeout: 1_000 }).catch(() => "");
    const ids = normalizeText(cardText).match(POST_ID_PATTERN) || [];
    for (const id of ids) {
      collector.add(detailUrlFromId(id), cardText.split("\n")[0] || id, cardText, sourceOffset + index);
    }
  }
}

async function clickThroughCards(page: Page, collector: CandidateCollector, pageUrl: string, sourceOffset: number, maxPosts: number) {
  const cards = page.locator(".cards .card, .card");
  const cardCount = Math.min(await cards.count(), 20);
  for (let index = 0; index < cardCount; index += 1) {
    if (collector.size() >= maxPosts) break;
    const beforeUrl = page.url();
    const card = cards.nth(index);
    const cardText = await card.innerText({ timeout: 1_000 }).catch(() => "");
    await card.click({ timeout: 2_000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
    const afterUrl = page.url();
    if (afterUrl !== beforeUrl) {
      collector.add(normalizeDetailUrl(afterUrl, pageUrl), cardText.split("\n")[0] || afterUrl, cardText, sourceOffset + index);
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
    }
  }
}

async function traverseForumByBrowser(page: Page, collector: CandidateCollector, pageUrl: string, maxPosts: number) {
  const tabLocator = page.locator(".tabs .tab, .tab, .column, .category, [role='tab']");
  const tabCount = Math.min(await tabLocator.count(), 20);
  for (let index = 0; index < tabCount; index += 1) {
    if (collector.size() >= maxPosts) break;
    const tab = tabLocator.nth(index);
    const tabText = await tab.innerText({ timeout: 1_000 }).catch(() => "");
    if (!normalizeText(tabText)) continue;
    await tab.click({ timeout: 2_000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
    for (let scrollIndex = 0; scrollIndex < 2; scrollIndex += 1) {
      await page.mouse.wheel(0, 900).catch(() => undefined);
      await page.waitForTimeout(500);
    }
    await collectVisibleLinks(page, collector, pageUrl);
    await collectVisibleCardIds(page, collector, 1_000 + index * 100);
    await clickThroughCards(page, collector, pageUrl, 2_000 + index * 100, maxPosts);
  }
}

export async function scanRealForum(input: { forumListUrl: string; maxPosts: number }): Promise<ScannedForumPost[]> {
  input = {
    ...input,
    forumListUrl: assertAllowedForumUrl(input.forumListUrl, "论坛扫描地址")
  };
  const apiPosts = await fetchCmoocSketchPosts(input).catch((error) => {
    console.warn(`[scan-real-forum] cMOOC API 扫描失败，准备回退浏览器：${error instanceof Error ? error.message : "unknown"}`);
    return [];
  });
  if (apiPosts.length > 0) {
    for (const post of apiPosts) {
      await upsertScannedForumPost({
        url: post.url,
        title: post.titleCandidate || post.cardText.slice(0, 60),
        content: post.cardText
      });
    }
    return apiPosts;
  }

  if (!fs.existsSync(authStatePath)) {
    throw new Error("缺少 cMOOC API 学伴账号配置或 playwright/auth-state.json；请配置 CMOOC_SATOKEN/CMOOC_PARTNER_ACCOUNT，或先运行 npm run auth:save。");
  }
  await fs.promises.mkdir(screenshotRoot, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: authStatePath });
  const page = await context.newPage();
  try {
    await page.goto(input.forumListUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    for (let index = 0; index < 4; index += 1) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(700);
    }
    const outputPath = screenshotPath(`scan-real-forum-${Date.now()}.png`);
    await page.screenshot({ path: outputPath, fullPage: true });
    const pageUrl = page.url();
    const collector = createCandidateCollector(input.maxPosts);
    const responseHandler = (response: Response) => {
      void collectSketchResponsePosts(response, collector, 5_000);
    };
    page.on("response", responseHandler);

    await collectVisibleLinks(page, collector, pageUrl);
    await collectVisibleCardIds(page, collector, 1_000);
    await clickThroughCards(page, collector, pageUrl, 2_000, input.maxPosts);
    if (collector.size() < input.maxPosts) {
      await traverseForumByBrowser(page, collector, pageUrl, input.maxPosts);
    }
    page.off("response", responseHandler);

    const posts = collector.posts();
    for (const post of posts) {
      await upsertScannedForumPost({ url: post.url, title: post.titleCandidate || post.cardText.slice(0, 60) });
    }
    return posts;
  } finally {
    await browser.close();
  }
}
