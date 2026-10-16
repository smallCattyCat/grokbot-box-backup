import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureAppEnvLoaded } from "@/lib/env";
import {
  assertRealForumWriteUnlocked,
  type RealForumWriteMutationBinding
} from "@/lib/forum/real-write-lock";
import {
  buildCmoocExecutionAccountRuntime,
  type CmoocExecutionAccountRuntime
} from "@/lib/forum/cmooc-execution-account-config";
import { loadOrCreateLocalEvidenceSecret } from "@/lib/privacy/local-evidence-hmac";

ensureAppEnvLoaded();

type ApiEnvelope<T> = {
  code?: number;
  message?: string;
  data?: T;
};

type ApiPageEnvelope<T> = {
  records?: T[];
  current?: number | string;
  size?: number | string;
  total?: number | string;
  pages?: number | string;
};

type PartnerAccount = {
  account: string;
  password: string;
};

type PartnerLoginData = {
  userId?: number;
  userIdStr?: string;
  userAccount?: string;
  userNickName?: string;
  userSpeakClose?: number;
  loginType?: string;
  saToken?: string;
};

type StorageCookie = {
  name?: string;
  value?: string;
  domain?: string;
};

type StorageState = {
  cookies?: StorageCookie[];
};

type SketchRecord = {
  moduleId?: string | number;
  moduleTitle?: string;
  moduleContent?: string;
  moduleComment?: number;
  moduleLike?: number;
  moduleCollect?: number;
  createdTime?: string;
  createdUserId?: string | number;
  createdUserNickName?: string;
};

type CourseColumnRecord = {
  columnId?: string | number;
  columnName?: string;
  columnType?: string;
  innerType?: string;
  columnSort?: number;
  guidanceCaption?: string | null;
};

type CourseMemberRecord = {
  userId?: string | number;
  memberType?: string;
  userName?: string;
  userNickName?: string;
  nickName?: string;
  displayName?: string;
  realName?: string;
  name?: string;
};

export type CmoocCourseMemberType =
  | "CREATOR"
  | "HELPER"
  | "LEARNER"
  | "FOLLOWER";

export type CmoocCourseMember = {
  actorPlatformId: string;
  memberType: CmoocCourseMemberType;
  displayName: string | null;
};

export type CmoocRawCommentRecord = {
  id?: string | number;
  commentId?: string | number;
  userId?: string | number;
  userIdStr?: string;
  createUserId?: string | number;
  createdUserId?: string | number;
  userName?: string;
  userNickName?: string;
  createdUserName?: string;
  createdUserNickName?: string;
  commentContent?: string;
  content?: string;
  createdTime?: string;
  replyList?: CmoocRawCommentRecord[];
  children?: CmoocRawCommentRecord[];
  commentReplyList?: CmoocRawCommentRecord[] | null;
};

export type CmoocApiComment = {
  id: string;
  index: number;
  parentId?: string | null;
  depth?: number;
  authorPlatformId?: string | null;
  authorName: string;
  content: string;
  contentStatus?: "present" | "empty_or_deleted";
  time: string;
};

export type CmoocApiPostDetail = {
  url: string;
  title: string;
  courseId?: string | null;
  authorPlatformId?: string | null;
  authorName: string;
  tags: string[];
  content: string;
  editedAt: string;
  commentCount: number;
  comments: CmoocApiComment[];
};

export type CmoocApiPublishResult = {
  publishedUrl: string;
  moduleId: string;
  commentId: string | null;
  beforeCommentCount: number;
  afterCommentCount: number;
  transport: "cmooc_api";
};

export type CmoocApiTokenSource = "env_satoken" | "partner_account" | "playwright_storage_state";

export type CmoocApiWriteToken = {
  token: string;
  source: CmoocApiTokenSource;
  accountRefHash?: string;
  credentialRefHash?: string;
};

export type CmoocApiScannedPost = {
  url: string;
  titleCandidate: string;
  cardText: string;
  sourceIndex: number;
  columnId?: string;
  columnName?: string;
  authorPlatformId?: string | null;
  authorName?: string;
  likeCount?: number;
  collectCount?: number;
  commentCount?: number;
  createdTime?: string;
};

export type CmoocCourseColumn = {
  columnId: string;
  columnName: string;
  columnType: string;
  innerType: string;
  columnSort: number;
  guidanceCaption: string | null;
};

export type CmoocApiPageReceipt = {
  requestCursor: string;
  expected: number | null;
  observed: number;
  nextCursor: string | null;
  truncated: boolean;
  failure: null;
  containsForumText: false;
};

export type CmoocApiSketchPage = {
  items: CmoocApiScannedPost[];
  receipt: CmoocApiPageReceipt;
};

export type CmoocApiCommentPage = {
  items: CmoocApiComment[];
  receipt: CmoocApiPageReceipt;
};

export type CmoocApiPostCore = Omit<
  CmoocApiPostDetail,
  "commentCount" | "comments"
> & {
  commentCount: number | null;
};

const DEFAULT_API_BASE = "https://cmooc.bnu.edu.cn/cmooc-api";
const DEFAULT_WEB_BASE = "https://cmooc.bnu.edu.cn/cMOOC";
const TRUSTED_CMOOC_ORIGIN = "https://cmooc.bnu.edu.cn";
const DEFAULT_COLUMN_ID = 60497;
const CMOOC_API_TIMEOUT_MS = 30_000;
const PLAYWRIGHT_AUTH_STATE_PATH = path.join(process.cwd(), "playwright", "auth-state.json");

export function resolveCmoocApiBase(
  configured =
    process.env.CMOOC_API_BASE_URL || DEFAULT_API_BASE
): string {
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("CMOOC_API_BASE_INVALID");
  }
  if (
    url.origin !== TRUSTED_CMOOC_ORIGIN ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.pathname === "/cmooc-api" ||
      url.pathname.startsWith("/cmooc-api/")
    )
  ) {
    throw new Error("CMOOC_API_ORIGIN_NOT_ALLOWED");
  }
  return url.href.replace(/\/$/, "");
}

function apiBase() {
  return resolveCmoocApiBase();
}

function webBase() {
  return process.env.CMOOC_WEB_BASE_URL || DEFAULT_WEB_BASE;
}

function todayInShanghai() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function base64(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

function md5Hex(value: string) {
  return crypto.createHash("md5").update(value, "utf8").digest("hex");
}

function sha256Hex(value: string) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function parsePartnerAccounts(): PartnerAccount[] {
  const json = process.env.CMOOC_PARTNER_ACCOUNTS;
  if (json) {
    try {
      const parsed = JSON.parse(json) as PartnerAccount[];
      return parsed.filter((item) => item.account && item.password);
    } catch {
      return [];
    }
  }
  const account = process.env.CMOOC_PARTNER_ACCOUNT;
  const password = process.env.CMOOC_PARTNER_PASSWORD;
  return account && password ? [{ account, password }] : [];
}

/**
 * Parse the indexed credential array used by the execution-account pool.
 * Unlike the legacy compatibility parser above, this path must never filter
 * invalid entries: doing so would renumber credentialIndex and could bind a
 * role lease to a different platform account.
 */
export function parseCmoocExecutionPartnerCredentials(input: {
  accountsJson?: string | null;
  account?: string | null;
  password?: string | null;
}): PartnerAccount[] {
  if (input.accountsJson !== undefined && input.accountsJson !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.accountsJson) as unknown;
    } catch {
      throw new Error("CMOOC_EXECUTION_ACCOUNT_CONFIG_INVALID");
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 50) {
      throw new Error("CMOOC_EXECUTION_ACCOUNT_CONFIG_INVALID");
    }
    const seen = new Set<string>();
    const credentials = parsed.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("CMOOC_EXECUTION_ACCOUNT_CONFIG_INVALID");
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      if (
        keys.length !== 2 ||
        keys[0] !== "account" ||
        keys[1] !== "password" ||
        typeof record.account !== "string" ||
        record.account.length === 0 ||
        record.account !== record.account.trim() ||
        typeof record.password !== "string" ||
        record.password.length === 0 ||
        seen.has(record.account)
      ) {
        throw new Error("CMOOC_EXECUTION_ACCOUNT_CONFIG_INVALID");
      }
      seen.add(record.account);
      return {
        account: record.account,
        password: record.password
      };
    });
    return credentials;
  }
  if (input.account === undefined && input.password === undefined) {
    throw new Error("CMOOC_EXECUTION_ACCOUNT_POOL_NOT_CONFIGURED");
  }
  if (
    typeof input.account !== "string" ||
    input.account.length === 0 ||
    input.account !== input.account.trim() ||
    typeof input.password !== "string" ||
    input.password.length === 0
  ) {
    throw new Error("CMOOC_EXECUTION_ACCOUNT_CONFIG_INVALID");
  }
  return [{ account: input.account, password: input.password }];
}

export function hasCmoocPartnerAccountConfig() {
  return parsePartnerAccounts().length > 0;
}

export async function loadCmoocExecutionAccountRuntime(): Promise<CmoocExecutionAccountRuntime> {
  const metadataJson = process.env.CMOOC_EXECUTION_ACCOUNT_POOL;
  if (!metadataJson) {
    throw new Error("CMOOC_EXECUTION_ACCOUNT_POOL_NOT_CONFIGURED");
  }
  let credentials: PartnerAccount[];
  try {
    credentials = parseCmoocExecutionPartnerCredentials({
      accountsJson: process.env.CMOOC_PARTNER_ACCOUNTS,
      account: process.env.CMOOC_PARTNER_ACCOUNT,
      password: process.env.CMOOC_PARTNER_PASSWORD
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "CMOOC_EXECUTION_ACCOUNT_POOL_NOT_CONFIGURED"
    ) {
      throw error;
    }
    throw new Error("CMOOC_EXECUTION_ACCOUNT_CONFIG_INVALID");
  }
  const secret = await loadOrCreateLocalEvidenceSecret();
  try {
    return buildCmoocExecutionAccountRuntime({
      metadataJson,
      credentials,
      secret
    });
  } catch {
    throw new Error("CMOOC_EXECUTION_ACCOUNT_CONFIG_INVALID");
  }
}

async function requestJson<T>(path: string, init: RequestInit & { token?: string } = {}) {
  const base = apiBase();
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  if (init.token) headers.set("Satoken", init.token);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CMOOC_API_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort(init.signal?.reason);
  init.signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: controller.signal
    });
    const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
    if (!response.ok || payload?.code !== 200) {
      throw new Error(payload?.message || `cMOOC API 请求失败：${path}`);
    }
    return payload.data as T;
  } catch (error) {
    if (controller.signal.aborted && !init.signal?.aborted) {
      throw new Error(`cMOOC API 请求超过 ${CMOOC_API_TIMEOUT_MS / 1000} 秒，远端结果需要核对：${path}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function readPlaywrightSatoken() {
  try {
    const raw = await fs.readFile(PLAYWRIGHT_AUTH_STATE_PATH, "utf8");
    const state = JSON.parse(raw) as StorageState;
    return state.cookies?.find((item) => item.name === "Satoken" && item.domain === "cmooc.bnu.edu.cn")?.value || null;
  } catch {
    return null;
  }
}

export async function loginPartnerAccount(account: PartnerAccount) {
  const date = todayInShanghai();
  const payload = await requestJson<PartnerLoginData>("/partner/accountLogin", {
    method: "POST",
    body: JSON.stringify({
      account: base64(account.account),
      password: base64(account.password),
      sk: md5Hex(`${account.account}${date}${account.password}`)
    })
  });
  if (!payload?.saToken) throw new Error(`学伴账号 ${account.account} 登录未返回 saToken。`);
  if (payload.userSpeakClose === 1) throw new Error(`学伴账号 ${account.account} 当前被禁言。`);
  return payload;
}

export async function getCmoocPartnerApiToken(executionAccountRefHash?: string) {
  if (executionAccountRefHash !== undefined) {
    const runtime = await loadCmoocExecutionAccountRuntime();
    const credential = runtime.resolveCredential(executionAccountRefHash);
    return (await loginPartnerAccount(credential)).saToken || null;
  }
  const account = parsePartnerAccounts()[0];
  if (!account) return null;
  return (await loginPartnerAccount(account)).saToken || null;
}

export async function getCmoocApiToken(options: {
  includePlaywrightStorageState?: boolean;
  executionAccountRefHash?: string;
} = {}) {
  if (options.executionAccountRefHash !== undefined) {
    return getCmoocPartnerApiToken(options.executionAccountRefHash);
  }
  if (process.env.CMOOC_SATOKEN) return process.env.CMOOC_SATOKEN;
  const account = parsePartnerAccounts()[0];
  if (account) {
    const token = (await loginPartnerAccount(account)).saToken || null;
    if (token) return token;
  }
  return options.includePlaywrightStorageState ? readPlaywrightSatoken() : null;
}

export async function checkCmoocToken(token: string) {
  const url = `/login/checkTokenValid?token=${encodeURIComponent(token)}`;
  return requestJson<boolean>(url);
}

export async function joinCmoocCourse(input: { courseId: string; token?: string | null }) {
  assertRealForumWriteUnlocked();
  const token = input.token ?? (await resolveCmoocApiWriteToken({ includePlaywrightStorageState: true })).token;
  return requestJson<unknown>(`/course/join/${input.courseId}`, { token });
}

async function validWriteToken(
  token: string | null | undefined,
  source: CmoocApiTokenSource,
  binding?: { accountRefHash: string; credentialRefHash: string }
): Promise<CmoocApiWriteToken | null> {
  if (!token) return null;
  try {
    return (await checkCmoocToken(token))
      ? { token, source, ...binding }
      : null;
  } catch {
    return null;
  }
}

export async function resolveCmoocApiWriteToken(options: {
  includePlaywrightStorageState?: boolean;
  executionAccountRefHash?: string;
} = {}): Promise<CmoocApiWriteToken> {
  if (options.executionAccountRefHash !== undefined) {
    const runtime = await loadCmoocExecutionAccountRuntime();
    const descriptor = runtime
      .listDescriptors()
      .find(
        (candidate) =>
          candidate.accountRefHash === options.executionAccountRefHash
      );
    if (!descriptor) {
      throw new Error("CMOOC_EXECUTION_ACCOUNT_NOT_CONFIGURED");
    }
    const partnerToken = await validWriteToken(
      await getCmoocPartnerApiToken(descriptor.accountRefHash).catch(() => null),
      "partner_account",
      {
        accountRefHash: descriptor.accountRefHash,
        credentialRefHash: descriptor.credentialRefHash
      }
    );
    if (partnerToken) return partnerToken;
    throw new Error("CMOOC_EXECUTION_ACCOUNT_AUTH_UNAVAILABLE");
  }
  const envToken = await validWriteToken(process.env.CMOOC_SATOKEN, "env_satoken");
  if (envToken) return envToken;

  if (hasCmoocPartnerAccountConfig()) {
    const partnerToken = await validWriteToken(await getCmoocPartnerApiToken().catch(() => null), "partner_account");
    if (partnerToken) return partnerToken;
  }

  if (options.includePlaywrightStorageState) {
    const storageToken = await validWriteToken(await readPlaywrightSatoken(), "playwright_storage_state");
    if (storageToken) return storageToken;
  }

  throw new Error("缺少可用 cMOOC API 登录态。请配置有效 CMOOC_SATOKEN/CMOOC_PARTNER_ACCOUNT，或运行 npm run auth:save 后再检查。");
}

function idFromDetailUrl(value: string) {
  try {
    const url = new URL(value);
    return url.searchParams.get("id") || value.match(/\d{16,}/)?.[0] || null;
  } catch {
    return value.match(/\d{16,}/)?.[0] || null;
  }
}

export function assertCmoocCourseScope(input: {
  forumListUrl: string;
  expectedCourseId: string;
}): string {
  let url: URL;
  try {
    url = new URL(input.forumListUrl);
  } catch {
    throw new Error("CMOOC_COURSE_URL_INVALID");
  }
  const locatedCourseId = url.searchParams.get("courseId");
  if (
    !locatedCourseId ||
    locatedCourseId !== input.expectedCourseId
  ) {
    throw new Error("CMOOC_COURSE_REF_MISMATCH");
  }
  return locatedCourseId;
}

function courseIdFromUrl(value: string) {
  try {
    return new URL(value).searchParams.get("courseId") || process.env.CMOOC_COURSE_ID || null;
  } catch {
    return process.env.CMOOC_COURSE_ID || null;
  }
}

type CmoocPageCursorKind = "topics" | "comments";

type CmoocPageCursorPayload = {
  v: 1;
  kind: CmoocPageCursorKind;
  scopeHash: string;
  page: number;
  pageSize: number;
};

const CMOOC_PAGE_CURSOR_PREFIX = "cmooc.page.v1.";

function pageScopeHash(
  kind: CmoocPageCursorKind,
  scopeMaterial: string
): string {
  return sha256Hex(`${kind}\0${scopeMaterial}`);
}

function encodePageCursor(
  payload: CmoocPageCursorPayload
): string {
  return (
    CMOOC_PAGE_CURSOR_PREFIX +
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  );
}

function decodePageCursor(input: {
  cursor: string;
  kind: CmoocPageCursorKind;
  scopeHash: string;
  pageSize: number;
}): CmoocPageCursorPayload {
  if (!input.cursor.startsWith(CMOOC_PAGE_CURSOR_PREFIX)) {
    throw new Error("CMOOC_PAGE_CURSOR_INVALID");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(
      Buffer.from(
        input.cursor.slice(CMOOC_PAGE_CURSOR_PREFIX.length),
        "base64url"
      ).toString("utf8")
    );
  } catch {
    throw new Error("CMOOC_PAGE_CURSOR_INVALID");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new Error("CMOOC_PAGE_CURSOR_INVALID");
  }
  const record = payload as Partial<CmoocPageCursorPayload>;
  if (
    record.v !== 1 ||
    record.kind !== input.kind ||
    record.scopeHash !== input.scopeHash ||
    record.pageSize !== input.pageSize ||
    !Number.isSafeInteger(record.page) ||
    (record.page ?? 0) < 1
  ) {
    throw new Error("CMOOC_PAGE_CURSOR_SCOPE_MISMATCH");
  }
  return record as CmoocPageCursorPayload;
}

function boundedPageSize(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 500
  ) {
    throw new Error("CMOOC_PAGE_SIZE_INVALID");
  }
  return value;
}

function optionalSafeCount(value: unknown): number | null {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }
  const parsed =
    typeof value === "number" ? value : Number(String(value));
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : null;
}

function requiredPagePosition(
  value: unknown,
  fallback: number
): number {
  const parsed = optionalSafeCount(value);
  return parsed !== null && parsed >= 1 ? parsed : fallback;
}

function buildPageReceipt(input: {
  kind: CmoocPageCursorKind;
  scopeHash: string;
  requestedPage: number;
  pageSize: number;
  payload: ApiPageEnvelope<unknown>;
  observed: number;
  requestCursor: string;
}): CmoocApiPageReceipt {
  const current = requiredPagePosition(
    input.payload.current,
    input.requestedPage
  );
  if (current !== input.requestedPage) {
    throw new Error("CMOOC_PAGE_POSITION_MISMATCH");
  }
  const serverSize = requiredPagePosition(
    input.payload.size,
    input.pageSize
  );
  const expected = optionalSafeCount(input.payload.total);
  const pages = optionalSafeCount(input.payload.pages);
  const hasNext =
    pages !== null
      ? current < pages
      : expected !== null
        ? current * serverSize < expected
        : input.observed >= serverSize;
  const nextCursor = hasNext
    ? encodePageCursor({
        v: 1,
        kind: input.kind,
        scopeHash: input.scopeHash,
        page: current + 1,
        pageSize: input.pageSize
      })
    : null;
  return {
    requestCursor: input.requestCursor,
    expected,
    observed: input.observed,
    nextCursor,
    truncated: nextCursor !== null,
    failure: null,
    containsForumText: false
  };
}

export function createCmoocTopicPageCursor(input: {
  forumListUrl: string;
  expectedCourseId: string;
  columnId: string | number;
  pageSize: number;
}): string {
  assertCmoocCourseScope(input);
  const pageSize = boundedPageSize(input.pageSize);
  return encodePageCursor({
    v: 1,
    kind: "topics",
    scopeHash: pageScopeHash(
      "topics",
      `${input.expectedCourseId}\0${String(input.columnId)}`
    ),
    page: 1,
    pageSize
  });
}

export function createCmoocCommentPageCursor(input: {
  postUrl: string;
  expectedCourseId: string;
  pageSize: number;
}): string {
  const moduleId = idFromDetailUrl(input.postUrl);
  if (!moduleId) {
    throw new Error("CMOOC_STABLE_THREAD_REF_REQUIRED");
  }
  const pageSize = boundedPageSize(input.pageSize);
  return encodePageCursor({
    v: 1,
    kind: "comments",
    scopeHash: pageScopeHash(
      "comments",
      `${input.expectedCourseId}\0${moduleId}`
    ),
    page: 1,
    pageSize
  });
}

function columnIdFromUrl(value: string) {
  try {
    const raw = new URL(value).searchParams.get("columnId") || process.env.CMOOC_COLUMN_ID;
    return raw ? Number(raw) : DEFAULT_COLUMN_ID;
  } catch {
    return process.env.CMOOC_COLUMN_ID ? Number(process.env.CMOOC_COLUMN_ID) : DEFAULT_COLUMN_ID;
  }
}

function detailUrlFromId(moduleId: string | number) {
  return `${webBase()}/detail?id=${moduleId}&type=SKETCH`;
}

function normalizeText(value: unknown) {
  return stripHtml(String(value ?? "")).replace(/\s+/g, " ").trim();
}

function stripHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"");
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = normalizeText(record[key]);
    if (value) return value;
  }
  return "";
}

function firstSafeCount(
  record: Record<string, unknown>,
  keys: string[]
): number | null {
  for (const key of keys) {
    const value = optionalSafeCount(record[key]);
    if (value !== null) return value;
  }
  return null;
}

export async function fetchCmoocCourseColumns(input: { courseId: string; token?: string | null }): Promise<CmoocCourseColumn[]> {
  const token = input.token ?? (await getCmoocApiToken());
  const records = await requestJson<CourseColumnRecord[]>(`/course/columns/${input.courseId}`, { token: token || undefined });
  return (records || [])
    .filter((record) => record.columnId && record.columnName)
    .map((record) => ({
      columnId: String(record.columnId),
      columnName: String(record.columnName),
      columnType: record.columnType || "",
      innerType: record.innerType || "",
      columnSort: Number(record.columnSort ?? 0),
      guidanceCaption: record.guidanceCaption ?? null
    }))
    .sort((left, right) => left.columnSort - right.columnSort);
}

export async function fetchCmoocCourseMembers(input: {
  courseId: string;
  token?: string | null;
}): Promise<CmoocCourseMember[]> {
  const courseId = String(input.courseId ?? "").trim();
  if (!courseId || courseId.length > 512) {
    throw new Error("CMOOC_COURSE_REF_REQUIRED");
  }
  const token = input.token ?? (await getCmoocApiToken());
  const payload = await requestJson<
    ApiPageEnvelope<CourseMemberRecord>
  >("/course/members", {
    method: "POST",
    token: token || undefined,
    body: JSON.stringify({
      parentObjId: courseId,
      current: 1,
      size: 500
    })
  });
  const current = requiredPagePosition(payload?.current, 1);
  const expected = optionalSafeCount(payload?.total);
  const records = payload?.records ?? [];
  if (
    current !== 1 ||
    (expected !== null && expected > records.length)
  ) {
    throw new Error("CMOOC_MEMBER_REGISTRY_TRUNCATED");
  }
  return normalizeCmoocCourseMemberRecords(records);
}

export function normalizeCmoocCourseMemberRecords(
  records: readonly unknown[]
): CmoocCourseMember[] {
  const allowedRoles = new Set<CmoocCourseMemberType>([
    "CREATOR",
    "HELPER",
    "LEARNER",
    "FOLLOWER"
  ]);
  const byActor = new Map<string, CmoocCourseMember>();
  for (const raw of records) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("CMOOC_MEMBER_REGISTRY_RECORD_INVALID");
    }
    const record = raw as CourseMemberRecord;
    const actorPlatformId = String(record.userId ?? "").trim();
    const memberType = String(
      record.memberType ?? ""
    ).toUpperCase() as CmoocCourseMemberType;
    if (!actorPlatformId || !allowedRoles.has(memberType)) {
      throw new Error("CMOOC_MEMBER_REGISTRY_RECORD_INVALID");
    }
    const displayName = firstString(
      record as Record<string, unknown>,
      [
        "userNickName",
        "nickName",
        "displayName",
        "userName",
        "realName",
        "name"
      ]
    ) || null;
    const existing = byActor.get(actorPlatformId);
    if (existing && existing.memberType !== memberType) {
      throw new Error("CMOOC_MEMBER_REGISTRY_ROLE_CONFLICT");
    }
    byActor.set(actorPlatformId, {
      actorPlatformId,
      memberType,
      displayName: existing?.displayName ?? displayName
    });
  }
  return [...byActor.values()]
    .sort(
      (left, right) =>
        left.actorPlatformId.localeCompare(
          right.actorPlatformId
        ) || left.memberType.localeCompare(right.memberType)
    );
}

export async function fetchCmoocSketchPostPage(input: {
  forumListUrl: string;
  expectedCourseId: string;
  pageSize: number;
  cursor?: string;
  token?: string | null;
  columnId: string | number;
  columnName?: string;
}): Promise<CmoocApiSketchPage> {
  const courseId = assertCmoocCourseScope(input);
  const pageSize = boundedPageSize(input.pageSize);
  const scopeHash = pageScopeHash(
    "topics",
    `${courseId}\0${String(input.columnId)}`
  );
  const requestCursor =
    input.cursor ??
    createCmoocTopicPageCursor({
      forumListUrl: input.forumListUrl,
      expectedCourseId: courseId,
      columnId: input.columnId,
      pageSize
    });
  const decoded = decodePageCursor({
    cursor: requestCursor,
    kind: "topics",
    scopeHash,
    pageSize
  });
  const token = input.token ?? (await getCmoocApiToken());
  const payload = await requestJson<ApiPageEnvelope<SketchRecord>>("/sketch/page", {
    method: "POST",
    token: token || undefined,
    body: JSON.stringify({
      current: decoded.page,
      size: pageSize,
      courseId,
      columnId: input.columnId,
      orderBy: "new"
    })
  });
  const posts = (payload?.records ?? [])
    .map((record, sourceIndex) => {
      if (!record.moduleId) return null;
      const title = normalizeText(record.moduleTitle || record.moduleId);
      const content = normalizeText(record.moduleContent || "");
      return {
        url: detailUrlFromId(record.moduleId),
        titleCandidate: title,
        cardText: `${title} ${content}`.trim().slice(0, 1200),
        sourceIndex,
        columnId: String(input.columnId),
        columnName: input.columnName,
        authorPlatformId: record.createdUserId ? String(record.createdUserId) : null,
        authorName: normalizeText(record.createdUserNickName || ""),
        likeCount: Number(record.moduleLike ?? 0),
        collectCount: Number(record.moduleCollect ?? 0),
        commentCount: Number(record.moduleComment ?? 0),
        createdTime: record.createdTime
      };
    })
    .filter((post): post is NonNullable<typeof post> => post !== null);
  return {
    items: posts,
    receipt: buildPageReceipt({
      kind: "topics",
      scopeHash,
      requestedPage: decoded.page,
      pageSize,
      payload,
      observed: (payload?.records ?? []).length,
      requestCursor
    })
  };
}

export async function fetchCmoocSketchPosts(input: {
  forumListUrl: string;
  maxPosts: number;
  token?: string | null;
  columnId?: string | number;
  columnName?: string;
}): Promise<CmoocApiScannedPost[]> {
  const courseId = courseIdFromUrl(input.forumListUrl);
  if (!courseId) return [];
  const columnId =
    input.columnId ?? columnIdFromUrl(input.forumListUrl);
  const page = await fetchCmoocSketchPostPage({
    forumListUrl: input.forumListUrl,
    expectedCourseId: courseId,
    pageSize: boundedPageSize(input.maxPosts),
    token: input.token,
    columnId,
    columnName: input.columnName
  });
  return page.items.slice(0, input.maxPosts);
}

function flattenComments(records: CmoocRawCommentRecord[] = []) {
  const flattened: Array<{
    record: CmoocRawCommentRecord;
    parentId: string | null;
    depth: number;
  }> = [];
  const visit = (
    record: CmoocRawCommentRecord,
    parentId: string | null,
    depth: number
  ) => {
    const id = String(record.commentId ?? record.id ?? "");
    flattened.push({ record, parentId, depth });
    const children = [
      ...(Array.isArray(record.replyList) ? record.replyList : []),
      ...(Array.isArray(record.children) ? record.children : []),
      ...(Array.isArray(record.commentReplyList) ? record.commentReplyList : [])
    ];
    for (const child of children) visit(child, id || parentId, depth + 1);
  };
  records.forEach((record) => visit(record, null, 0));
  return flattened;
}

export function normalizeCmoocCommentRecords(input: {
  records: CmoocRawCommentRecord[];
  page: number;
  pageSize: number;
  preserveStructuralTombstones?: boolean;
}): CmoocApiComment[] {
  if (
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    !Number.isSafeInteger(input.pageSize) ||
    input.pageSize < 1
  ) {
    throw new Error("CMOOC_COMMENT_PAGE_POSITION_INVALID");
  }
  const flattened = flattenComments(input.records);
  const seen = new Set<string>();
  return flattened
    .map(({ record, parentId, depth }, index) => {
      const content = firstString(
        record as Record<string, unknown>,
        ["commentContent", "content", "replyContent"]
      );
      return {
        id: String(record.commentId ?? record.id ?? ""),
        index:
          (input.page - 1) * input.pageSize + index,
        parentId,
        depth,
        authorPlatformId:
          firstString(record as Record<string, unknown>, [
            "createdUserId",
            "userId",
            "userIdStr",
            "createUserId"
          ]) || null,
        authorName:
          firstString(record as Record<string, unknown>, [
            "createdUserNickName",
            "userNickName",
            "userName",
            "createdUserName",
            "createUserName",
            "nickName"
          ]) || "真实论坛用户",
        content,
        contentStatus: content
          ? ("present" as const)
          : ("empty_or_deleted" as const),
        time: firstString(record as Record<string, unknown>, [
          "createdTime",
          "createTime",
          "time"
        ])
      };
    })
    .filter((comment) => {
      if (!comment.id || seen.has(comment.id)) {
        return false;
      }
      seen.add(comment.id);
      return (
        comment.contentStatus === "present" ||
        input.preserveStructuralTombstones === true
      );
    });
}

export async function fetchCmoocCommentPage(input: {
  postUrl: string;
  expectedCourseId: string;
  pageSize: number;
  cursor?: string;
  token?: string | null;
  preserveStructuralTombstones?: boolean;
}): Promise<CmoocApiCommentPage> {
  const moduleId = idFromDetailUrl(input.postUrl);
  if (!moduleId) {
    throw new Error("CMOOC_STABLE_THREAD_REF_REQUIRED");
  }
  const pageSize = boundedPageSize(input.pageSize);
  const scopeHash = pageScopeHash(
    "comments",
    `${input.expectedCourseId}\0${moduleId}`
  );
  const requestCursor =
    input.cursor ??
    createCmoocCommentPageCursor({
      postUrl: input.postUrl,
      expectedCourseId: input.expectedCourseId,
      pageSize
    });
  const decoded = decodePageCursor({
    cursor: requestCursor,
    kind: "comments",
    scopeHash,
    pageSize
  });
  const token = input.token ?? (await getCmoocApiToken());
  const payload = await requestJson<
    ApiPageEnvelope<CmoocRawCommentRecord>
  >("/comment/list", {
    method: "POST",
    token: token ?? undefined,
    body: JSON.stringify({
      current: decoded.page,
      size: pageSize,
      moduleId,
      showReply: true,
      order: "better"
    })
  });
  const comments = normalizeCmoocCommentRecords({
    records: payload?.records ?? [],
    page: decoded.page,
    pageSize,
    preserveStructuralTombstones:
      input.preserveStructuralTombstones
  });
  return {
    items: comments,
    receipt: buildPageReceipt({
      kind: "comments",
      scopeHash,
      requestedPage: decoded.page,
      pageSize,
      payload,
      observed: (payload?.records ?? []).length,
      requestCursor
    })
  };
}

export async function fetchCmoocPostCore(input: {
  postUrl: string;
  token?: string | null;
  expectedCourseId?: string;
}): Promise<CmoocApiPostCore | null> {
  const moduleId = idFromDetailUrl(input.postUrl);
  if (!moduleId) return null;
  const token = input.token ?? (await getCmoocApiToken());
  const detail = await requestJson<Record<string, unknown>>(`/sketch/detail/${moduleId}`, { token: token || undefined });
  const courseId =
    firstString(detail, ["courseId"]) || null;
  if (
    input.expectedCourseId &&
    courseId &&
    courseId !== input.expectedCourseId
  ) {
    throw new Error("CMOOC_COURSE_REF_MISMATCH");
  }
  return {
    url: detailUrlFromId(moduleId),
    title: firstString(detail, ["moduleTitle", "title", "sketchTitle", "name"]) || input.postUrl,
    courseId,
    authorPlatformId: firstString(detail, ["userId", "userIdStr", "createdUserId", "createUserId", "authorId"]) || null,
    authorName: firstString(detail, ["userNickName", "createdUserNickName", "userName", "createdUserName", "createUserName", "authorName"]) || "真实论坛用户",
    tags: [],
    content: firstString(detail, ["moduleContent", "content", "sketchContent", "description"]),
    editedAt: firstString(detail, ["createdTime", "createTime", "updatedTime", "editedAt"]),
    commentCount: firstSafeCount(detail, [
      "moduleComment",
      "commentCount"
    ])
  };
}

async function fetchComments(
  moduleId: string,
  token?: string | null
): Promise<CmoocApiComment[]> {
  const postUrl = detailUrlFromId(moduleId);
  const expectedCourseId = "legacy-unscoped";
  const comments: CmoocApiComment[] = [];
  const seenCommentIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let requestCount = 0; requestCount < 100; requestCount += 1) {
    const page = await fetchCmoocCommentPage({
      postUrl,
      expectedCourseId,
      pageSize: 100,
      cursor,
      token
    });
    if (seenCursors.has(page.receipt.requestCursor)) {
      throw new Error("CMOOC_COMMENT_CURSOR_CYCLE");
    }
    seenCursors.add(page.receipt.requestCursor);
    let added = 0;
    for (const comment of page.items) {
      if (seenCommentIds.has(comment.id)) continue;
      seenCommentIds.add(comment.id);
      comments.push(comment);
      added += 1;
    }
    if (page.receipt.nextCursor === null) break;
    if (added === 0) {
      throw new Error("CMOOC_DUPLICATE_COMMENT_PAGE");
    }
    cursor = page.receipt.nextCursor;
  }
  return comments.map((comment, index) => ({
    ...comment,
    index
  }));
}

export async function fetchCmoocPostDetail(input: {
  postUrl: string;
  token?: string | null;
  expectedCourseId?: string;
}): Promise<CmoocApiPostDetail | null> {
  const core = await fetchCmoocPostCore(input);
  if (!core) return null;
  const moduleId = idFromDetailUrl(input.postUrl);
  if (!moduleId) return null;
  const token = input.token ?? (await getCmoocApiToken());
  const comments = await fetchComments(moduleId, token);
  return {
    ...core,
    commentCount: core.commentCount ?? comments.length,
    comments
  };
}

function commentHtml(content: string) {
  const escaped = content
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
  return `<p>${escaped.replace(/\n/g, "<br>")}</p>`;
}

function normalizeCommentContent(value: string) {
  return normalizeText(value);
}

export function findNewPublishedCommentEvidence(input: {
  before: CmoocApiComment[];
  after: CmoocApiComment[];
  content: string;
  expectedParentId: string | null;
}) {
  const expected = normalizeCommentContent(input.content);
  const beforeIds = new Set(input.before.map((comment) => comment.id));
  const matched = input.after.filter(
    (comment) =>
      !beforeIds.has(comment.id) &&
      (comment.parentId ?? null) === input.expectedParentId &&
      normalizeCommentContent(comment.content) === expected
  );
  return matched.length === 1 ? matched[0] : null;
}

async function writeWithCourseJoinRetry(write: () => Promise<void>, input: { courseId: string; token: string }) {
  try {
    await write();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("不是课程成员")) throw error;
    await joinCmoocCourse(input);
    await write();
  }
}

export async function publishCmoocPostComment(input: {
  postUrl: string;
  content: string;
  token?: string | null;
  courseId?: string | null;
  themeId?: string | null;
  writeBinding?: RealForumWriteMutationBinding;
  allowCourseJoinRetry?: boolean;
  onBeforeMutation?: (input: {
    beforeComments: CmoocApiComment[];
  }) => Promise<void>;
}): Promise<CmoocApiPublishResult> {
  const moduleId = idFromDetailUrl(input.postUrl);
  if (!moduleId) throw new Error("无法从真实帖子 URL 解析 moduleId。");
  const token = input.token ?? (await resolveCmoocApiWriteToken({ includePlaywrightStorageState: true })).token;
  if (input.token && !(await checkCmoocToken(input.token))) throw new Error("cMOOC API 登录态已失效，请重新运行 npm run auth:save 或更新 CMOOC_SATOKEN。");

  const detail = await requestJson<Record<string, unknown>>(`/sketch/detail/${moduleId}`, { token });
  const courseId = input.courseId || firstString(detail, ["courseId"]);
  const themeId = input.themeId || firstString(detail, ["sunThemeId", "themeId"]) || "-1";
  if (!courseId) throw new Error("真实帖子详情缺少 courseId，无法通过 cMOOC API 发布评论。");

  const beforeComments = await fetchComments(moduleId, token);
  await input.onBeforeMutation?.({ beforeComments });
  assertRealForumWriteUnlocked(input.writeBinding);
  const write = () => requestJson<unknown>("/comment/commentModule", {
      method: "POST",
      token,
      body: JSON.stringify({
        courseId,
        moduleId,
        themeId,
        commentContent: commentHtml(input.content)
      })
    }).then(() => undefined);
  if (input.allowCourseJoinRetry === true) {
    await writeWithCourseJoinRetry(write, { courseId, token });
  } else {
    await write();
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const afterComments = await fetchComments(moduleId, token);
  const matched = findNewPublishedCommentEvidence({
    before: beforeComments,
    after: afterComments,
    content: input.content,
    expectedParentId: null
  });
  if (!matched) {
    throw new Error("cMOOC API 返回成功后未唯一复核到本次新增主评论，发布结果需要人工核对。");
  }

  return {
    publishedUrl: detailUrlFromId(moduleId),
    moduleId,
    commentId: matched.id,
    beforeCommentCount: beforeComments.length,
    afterCommentCount: afterComments.length,
    transport: "cmooc_api"
  };
}

export async function publishCmoocCommentReply(input: {
  postUrl: string;
  content: string;
  commentReplyId: string;
  token?: string | null;
  courseId?: string | null;
  themeId?: string | null;
  writeBinding?: RealForumWriteMutationBinding;
  allowCourseJoinRetry?: boolean;
  onBeforeMutation?: (input: {
    beforeComments: CmoocApiComment[];
  }) => Promise<void>;
}): Promise<CmoocApiPublishResult> {
  const moduleId = idFromDetailUrl(input.postUrl);
  if (!moduleId) throw new Error("无法从真实帖子 URL 解析 moduleId。");
  const token = input.token ?? (await resolveCmoocApiWriteToken({ includePlaywrightStorageState: true })).token;
  if (input.token && !(await checkCmoocToken(input.token))) throw new Error("cMOOC API 登录态已失效，请重新运行 npm run auth:save 或更新 CMOOC_SATOKEN。");

  const detail = await requestJson<Record<string, unknown>>(`/sketch/detail/${moduleId}`, { token });
  const courseId = input.courseId || firstString(detail, ["courseId"]);
  const themeId = input.themeId || firstString(detail, ["sunThemeId", "themeId"]) || "-1";
  if (!courseId) throw new Error("真实帖子详情缺少 courseId，无法通过 cMOOC API 回复评论。");

  const beforeComments = await fetchComments(moduleId, token);
  await input.onBeforeMutation?.({ beforeComments });
  assertRealForumWriteUnlocked(input.writeBinding);
  const write = () => requestJson<unknown>("/comment/commentReply", {
      method: "POST",
      token,
      body: JSON.stringify({
        courseId,
        commentReplyId: input.commentReplyId,
        themeId,
        commentContent: commentHtml(input.content)
      })
    }).then(() => undefined);
  if (input.allowCourseJoinRetry === true) {
    await writeWithCourseJoinRetry(write, { courseId, token });
  } else {
    await write();
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const afterComments = await fetchComments(moduleId, token);
  const matched = findNewPublishedCommentEvidence({
    before: beforeComments,
    after: afterComments,
    content: input.content,
    expectedParentId: input.commentReplyId
  });
  if (!matched) {
    throw new Error("cMOOC API 返回成功后未唯一复核到目标评论下的新增回复，发布结果需要人工核对。");
  }

  return {
    publishedUrl: detailUrlFromId(moduleId),
    moduleId,
    commentId: matched.id,
    beforeCommentCount: beforeComments.length,
    afterCommentCount: afterComments.length,
    transport: "cmooc_api"
  };
}
