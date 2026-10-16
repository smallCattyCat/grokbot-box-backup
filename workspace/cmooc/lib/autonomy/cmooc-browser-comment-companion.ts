import { existsSync } from "node:fs";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type Response
} from "playwright";
import {
  normalizeCmoocCommentRecords,
  type CmoocApiComment,
  type CmoocRawCommentRecord
} from "@/lib/forum/cmooc-api";
import { decideReadOnlyPlaywrightRequest } from "@/lib/forum-adapters/cmooc-playwright-read-only-probe";

/**
 * This companion is deliberately a separate, read-only trust boundary.  Its
 * receipt contains counts and booleans only; comment text is returned to the
 * caller for the current process and is never included in the receipt.
 */
export const CMOOC_BROWSER_COMMENT_COMPANION_SCHEMA_VERSION =
  "cmooc.browser-comment-companion-receipt.v1" as const;

export type CmoocBrowserCommentCompanionReceipt = {
  schemaVersion: typeof CMOOC_BROWSER_COMMENT_COMPANION_SCHEMA_VERSION;
  source: "ui_native_infinite_scroll";
  expectedRootComments: number;
  observedRootComments: number;
  observedEventCount: number;
  pageRequestCount: number;
  terminalPage: number;
  serverPages: number;
  stableIds: true;
  parentClosure: true;
  zeroPageFailures: true;
  blockedWriteRequestCount: number;
  sentMutationCount: 0;
  realPublishEnabled: false;
  externalWriteAttempted: false;
  containsForumText: false;
};

export type CmoocBrowserCommentCompanionSnapshot = {
  items: CmoocApiComment[];
  receipt: CmoocBrowserCommentCompanionReceipt;
};

export interface CmoocBrowserCommentCompanion {
  readThread(input: {
    postUrl: string;
    expectedCourseId: string;
    maxComments: number;
  }): Promise<CmoocBrowserCommentCompanionSnapshot>;
  close(): Promise<void>;
}

export type CmoocBrowserCommentBrowserChannel =
  | "bundled_chromium"
  | "system_chrome";

type CommentPageData = {
  records: unknown[];
  current: number;
  size: number;
  total: number;
  pages: number;
};

/** A serialisable page capture used by the pure validator and by the browser. */
export type CmoocBrowserCommentPageCapture = {
  request: {
    method?: string;
    url?: string;
    postData?: string | null;
    /** `body` is accepted by the pure validator to keep fixture creation easy. */
    body?: unknown;
  };
  response: {
    status: number;
    body: unknown;
  };
};

export type CmoocBrowserCommentPageSequenceInput = {
  /** Preferred name. */
  captures?: readonly CmoocBrowserCommentPageCapture[];
  /** Alias retained for small, dependency-free fixtures. */
  pages?: readonly CmoocBrowserCommentPageCapture[];
  expectedModuleId: string;
  maxComments: number;
  blockedWriteRequestCount?: number;
};

export type CmoocBrowserCommentRequestDecision =
  | { action: "allow_get_or_head" }
  | { action: "allow_comment_list_post" }
  | {
      action: "abort";
      code:
        | "invalid_url"
        | "https_required"
        | "embedded_credentials_forbidden"
        | "sensitive_query_forbidden"
        | "origin_not_allowed"
        | "method_not_allowed";
    };

const COMMENT_LIST_PATHS = new Set([
  "/cmooc-api/comment/list",
  "/comment/list"
]);
const MAX_SAFE_SERVER_PAGES = 1_000;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SENSITIVE_QUERY_MARKERS = [
  "token",
  "accesstoken",
  "authtoken",
  "satoken",
  "auth",
  "authorization",
  "cookie",
  "session",
  "sessionid",
  "sid",
  "password",
  "secret",
  "clientsecret",
  "credential",
  "credentials",
  "jwt",
  "apikey",
  "accesskey",
  "secretkey"
] as const;

function error(message: string): Error {
  return new Error(`CMOOC_BROWSER_COMMENT_COMPANION_${message}`);
}

export type CmoocBrowserCommentRuntimePhase =
  | "BROWSER_RUNTIME"
  | "BROWSER_SESSION"
  | "COMMENT_RESPONSE"
  | "DETAIL_RESPONSE"
  | "DOM_INSPECTION"
  | "NATIVE_SCROLL"
  | "NAVIGATION"
  | "REQUEST_CAPTURE";

const STABLE_COMPANION_ERROR_PATTERN =
  /^CMOOC_BROWSER_COMMENT_COMPANION_[A-Z0-9_]+$/;

/**
 * Converts Playwright/runtime failures into a bounded public taxonomy. Raw
 * browser messages can contain URLs, selectors, page content, or profile
 * paths, so callers must never persist or surface them directly.
 */
export function normalizeCmoocBrowserCommentRuntimeError(
  reason: unknown,
  phase: CmoocBrowserCommentRuntimePhase
): Error {
  if (
    reason instanceof Error &&
    STABLE_COMPANION_ERROR_PATTERN.test(reason.message)
  ) {
    return reason;
  }
  const diagnostic =
    reason instanceof Error
      ? `${reason.name} ${reason.message}`.toUpperCase()
      : "";
  if (
    /(?:TARGET|PAGE|CONTEXT|BROWSER)[^\n]*(?:CLOSED|CLOSING)|HAS BEEN CLOSED/.test(
      diagnostic
    )
  ) {
    return error("BROWSER_SESSION_CLOSED");
  }
  if (/TIMEOUT|TIMED OUT/.test(diagnostic)) {
    return error(`${phase}_TIMEOUT`);
  }
  return error(`${phase}_FAILED`);
}

function safeInteger(value: unknown, name: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw error(`${name}_INVALID`);
  return parsed;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = safeInteger(value, name);
  if (parsed < 1) throw error(`${name}_INVALID`);
  return parsed;
}

function nonNegativeInteger(value: unknown, name: string): number {
  const parsed = safeInteger(value, name);
  if (parsed < 0) throw error(`${name}_INVALID`);
  return parsed;
}

function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw error(`${name}_INVALID`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw error(`${name}_INVALID`);
  }
  const result = String(value).trim();
  if (!result) throw error(`${name}_INVALID`);
  return result;
}

function parseJson(value: unknown, name: string): Record<string, unknown> {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            throw error(`${name}_JSON_INVALID`);
          }
        })()
      : value;
  return assertRecord(parsed, name);
}

function hasSensitiveQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase().replace(/[-_]/g, "");
    if (SENSITIVE_QUERY_MARKERS.some((marker) => normalized.includes(marker))) {
      return true;
    }
  }
  return false;
}

function normalizeAllowedOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw error("ALLOWED_ORIGIN_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw error("ALLOWED_ORIGIN_INVALID");
  }
  return parsed.origin;
}

function exactCommentListUrl(url: string, allowedOrigin: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === allowedOrigin &&
      parsed.hash === "" &&
      COMMENT_LIST_PATHS.has(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Request policy used by the browser route.  The existing UI readiness probe
 * owns URL/method hardening; a POST is admitted only after that same GET-style
 * URL validation and only for the two exact comment-list paths.
 */
export function decideCmoocBrowserCommentRequest(input: {
  url: string;
  method: string;
  allowedOrigin: string;
}): CmoocBrowserCommentRequestDecision {
  const method = input.method.toUpperCase();
  let origin: string;
  try {
    origin = normalizeAllowedOrigin(input.allowedOrigin);
  } catch {
    return { action: "abort", code: "origin_not_allowed" };
  }

  // Run the project-wide URL checks with a read method first.  This preserves
  // HTTPS, credential, sensitive-query and same-origin guards for semantic
  // POSTs without weakening the normal GET/HEAD policy.
  const urlGuard = decideReadOnlyPlaywrightRequest({
    url: input.url,
    method: method === "POST" ? "GET" : method,
    allowedOrigins: [origin]
  });
  if (urlGuard.action === "abort") {
    return { action: "abort", code: urlGuard.code };
  }
  if (method === "GET" || method === "HEAD") {
    return { action: "allow_get_or_head" };
  }
  if (method === "POST" && exactCommentListUrl(input.url, origin)) {
    return { action: "allow_comment_list_post" };
  }
  return { action: "abort", code: "method_not_allowed" };
}

export const decideReadOnlyCmoocBrowserCommentRequest =
  decideCmoocBrowserCommentRequest;

function extractRequestBody(capture: CmoocBrowserCommentPageCapture): Record<string, unknown> {
  if (capture.request.body !== undefined) {
    return assertRecord(capture.request.body, "REQUEST_BODY");
  }
  return parseJson(capture.request.postData ?? null, "REQUEST_BODY");
}

function parseCommentPageData(body: unknown): { code: number; data: CommentPageData } {
  const envelope = parseJson(body, "RESPONSE");
  const code = safeInteger(envelope.code, "RESPONSE_CODE");
  if (code !== 200) throw error("RESPONSE_CODE_INVALID");
  const data = assertRecord(envelope.data, "RESPONSE_DATA");
  if (!Array.isArray(data.records)) throw error("RESPONSE_RECORDS_INVALID");
  return {
    code,
    data: {
      records: data.records,
      current: positiveInteger(data.current, "RESPONSE_CURRENT"),
      size: positiveInteger(data.size, "RESPONSE_SIZE"),
      total: nonNegativeInteger(data.total, "RESPONSE_TOTAL"),
      pages: positiveInteger(data.pages, "RESPONSE_PAGES")
    }
  };
}

function recordId(record: Record<string, unknown>): string {
  // Match normalizeCmoocCommentRecords' commentId-before-id precedence.
  const value = record.commentId ?? record.id;
  if (value === undefined || value === null) throw error("COMMENT_ID_INVALID");
  const id = String(value).trim();
  if (!id || !STABLE_ID_PATTERN.test(id)) throw error("COMMENT_ID_INVALID");
  return id;
}

function childRecords(record: Record<string, unknown>): Record<string, unknown>[] {
  const children: Record<string, unknown>[] = [];
  for (const key of ["replyList", "children", "commentReplyList"] as const) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) throw error("COMMENT_CHILDREN_INVALID");
    for (const child of value) children.push(assertRecord(child, "COMMENT_RECORD"));
  }
  return children;
}

function explicitParentId(record: Record<string, unknown>): string | null {
  for (const key of ["parentId", "commentParentId", "replyToId"] as const) {
    const value = record[key];
    if (value === undefined || value === null || String(value).trim() === "") {
      continue;
    }
    const parentId = String(value).trim();
    if (!STABLE_ID_PATTERN.test(parentId)) throw error("PARENT_ID_INVALID");
    return parentId;
  }
  return null;
}

function collectRecordIds(
  records: readonly unknown[],
  ids: Set<string>,
  parentIds: Array<{ id: string; parentId: string | null }>
): void {
  for (const value of records) {
    const record = assertRecord(value, "COMMENT_RECORD");
    const id = recordId(record);
    if (ids.has(id)) throw error("COMMENT_ID_OVERLAP");
    ids.add(id);
    parentIds.push({ id, parentId: explicitParentId(record) });
    for (const child of childRecords(record)) {
      collectNestedRecordIds(child, ids, parentIds, id);
    }
  }
}

function collectNestedRecordIds(
  record: Record<string, unknown>,
  ids: Set<string>,
  parentIds: Array<{ id: string; parentId: string | null }>,
  parentId: string
): void {
  const id = recordId(record);
  if (ids.has(id)) throw error("COMMENT_ID_OVERLAP");
  ids.add(id);
  parentIds.push({ id, parentId });
  for (const child of childRecords(record)) {
    collectNestedRecordIds(child, ids, parentIds, id);
  }
}

function capturePages(input: CmoocBrowserCommentPageSequenceInput): readonly CmoocBrowserCommentPageCapture[] {
  const captures = input.captures ?? input.pages;
  if (!captures) throw error("PAGES_REQUIRED");
  return captures;
}

/**
 * Validate a complete sequence of browser-captured pages and normalize records
 * without dropping structural tombstones.  This function never performs I/O,
 * making pagination failures straightforward to test without a browser.
 */
export function validateCmoocBrowserCommentPageSequence(
  input: CmoocBrowserCommentPageSequenceInput
): CmoocBrowserCommentCompanionSnapshot {
  const expectedModuleId = stringValue(input.expectedModuleId, "MODULE_ID");
  const maxComments = positiveInteger(input.maxComments, "MAX_COMMENTS");
  const captures = capturePages(input);
  if (captures.length < 1) throw error("PAGES_REQUIRED");

  let authoritativeTotal: number | undefined;
  let authoritativePages: number | undefined;
  let authoritativeSize: number | undefined;
  const allIds = new Set<string>();
  const explicitParentRefs: string[] = [];
  const allItems: CmoocApiComment[] = [];
  let rootCount = 0;

  for (let index = 0; index < captures.length; index += 1) {
    const capture = captures[index];
    const requestMethod = capture.request.method?.toUpperCase() ?? "POST";
    if (requestMethod !== "POST") throw error("REQUEST_METHOD_INVALID");
    if (capture.request.url && !COMMENT_LIST_PATHS.has(new URL(capture.request.url).pathname)) {
      throw error("REQUEST_PATH_INVALID");
    }
    const request = extractRequestBody(capture);
    const moduleId = stringValue(request.moduleId, "REQUEST_MODULE_ID");
    const current = positiveInteger(request.current, "REQUEST_CURRENT");
    const size = positiveInteger(request.size, "REQUEST_SIZE");
    if (moduleId !== expectedModuleId) throw error("REQUEST_MODULE_ID_MISMATCH");
    if (current !== index + 1) throw error("REQUEST_PAGE_SEQUENCE_INVALID");
    if (request.showReply !== true) throw error("REQUEST_SHOW_REPLY_INVALID");
    if (capture.response.status !== 200) throw error("HTTP_STATUS_INVALID");
    const { data } = parseCommentPageData(capture.response.body);
    if (data.current !== current) throw error("RESPONSE_PAGE_MISMATCH");
    if (data.size !== size) throw error("PAGE_SIZE_DRIFT");
    if (authoritativeTotal === undefined) {
      authoritativeTotal = data.total;
      authoritativePages = data.pages;
      authoritativeSize = data.size;
      if (authoritativePages > MAX_SAFE_SERVER_PAGES) {
        throw error("SERVER_PAGES_LIMIT");
      }
      // A page count larger than the requested event cap cannot be completed
      // while preserving the authoritative root count.
      if (authoritativeTotal > maxComments) throw error("MAX_COMMENTS_LIMIT");
    } else if (
      data.total !== authoritativeTotal ||
      data.pages !== authoritativePages ||
      data.size !== authoritativeSize
    ) {
      throw error("PAGE_METADATA_DRIFT");
    }

    const pageIds = new Set<string>();
    const parentIds: Array<{ id: string; parentId: string | null }> = [];
    collectRecordIds(data.records, pageIds, parentIds);
    explicitParentRefs.push(
      ...parentIds.flatMap((value) => (value.parentId ? [value.parentId] : []))
    );
    for (const id of pageIds) {
      if (allIds.has(id)) throw error("COMMENT_ID_OVERLAP");
      allIds.add(id);
    }
    const items = normalizeCmoocCommentRecords({
      records: data.records as CmoocRawCommentRecord[],
      page: current,
      pageSize: size,
      preserveStructuralTombstones: true
    });
    if (items.length !== pageIds.size) throw error("COMMENT_ID_INVALID");
    for (const item of items) {
      if (!item.id || !STABLE_ID_PATTERN.test(item.id)) {
        throw error("COMMENT_ID_INVALID");
      }
      if (item.parentId === null || item.parentId === undefined || item.parentId === "") {
        rootCount += 1;
      }
      allItems.push(item);
    }
    if (allItems.length > maxComments) throw error("MAX_COMMENTS_LIMIT");
  }

  if (
    authoritativeTotal === undefined ||
    authoritativePages === undefined ||
    authoritativeSize === undefined
  ) {
    throw error("PAGES_REQUIRED");
  }
  if (captures.length !== authoritativePages) throw error("PAGES_INCOMPLETE");
  if (captures[captures.length - 1].request.body !== undefined) {
    const finalRequest = extractRequestBody(captures[captures.length - 1]);
    if (positiveInteger(finalRequest.current, "REQUEST_CURRENT") !== authoritativePages) {
      throw error("TERMINAL_PAGE_INVALID");
    }
  }
  if (rootCount !== authoritativeTotal) throw error("ROOT_COUNT_MISMATCH");
  const idSet = new Set(allItems.map((item) => item.id));
  if (idSet.size !== allItems.length || idSet.size !== allIds.size) {
    throw error("COMMENT_ID_OVERLAP");
  }
  for (const item of allItems) {
    if (item.parentId && !idSet.has(item.parentId)) {
      throw error("PARENT_CLOSURE_INVALID");
    }
  }
  for (const parentId of explicitParentRefs) {
    if (!idSet.has(parentId)) throw error("PARENT_CLOSURE_INVALID");
  }

  const indexedItems = allItems.map((item, index) => ({ ...item, index }));
  const receipt: CmoocBrowserCommentCompanionReceipt = {
    schemaVersion: CMOOC_BROWSER_COMMENT_COMPANION_SCHEMA_VERSION,
    source: "ui_native_infinite_scroll",
    expectedRootComments: authoritativeTotal,
    observedRootComments: rootCount,
    observedEventCount: indexedItems.length,
    pageRequestCount: captures.length,
    terminalPage: authoritativePages,
    serverPages: authoritativePages,
    stableIds: true,
    parentClosure: true,
    zeroPageFailures: true,
    blockedWriteRequestCount: nonNegativeInteger(
      input.blockedWriteRequestCount ?? 0,
      "BLOCKED_WRITE_REQUEST_COUNT"
    ),
    sentMutationCount: 0,
    realPublishEnabled: false,
    externalWriteAttempted: false,
    containsForumText: false
  };
  return { items: indexedItems, receipt };
}

/** Friendly aliases for callers that describe captures as a page sequence. */
export const validateCmoocBrowserCommentPages =
  validateCmoocBrowserCommentPageSequence;
export const validateCmoocBrowserCommentCompanionPages =
  validateCmoocBrowserCommentPageSequence;
export const validateCapturedCmoocBrowserCommentPages =
  validateCmoocBrowserCommentPageSequence;

type ActiveRead = {
  page: Page | null;
  moduleId: string;
  expectedCourseId: string;
  maxComments: number;
  captures: CmoocBrowserCommentPageCapture[];
  pending: Map<Request, CmoocBrowserCommentPageCapture>;
  completedResponses: number;
  responseTasks: Set<Promise<void>>;
  courseValidated: boolean;
  serverPages: number | null;
  blockedWriteRequestCount: number;
  failure: Error | null;
};

function setFailure(
  state: ActiveRead,
  reason: unknown,
  phase: CmoocBrowserCommentRuntimePhase
): void {
  if (state.failure) return;
  state.failure = normalizeCmoocBrowserCommentRuntimeError(
    reason,
    phase
  );
}

function requestBelongsToActivePage(
  request: Request,
  state: ActiveRead
): boolean {
  if (!state.page) return false;
  try {
    return request.frame().page() === state.page;
  } catch {
    return false;
  }
}

function detailPathMatches(url: string, moduleId: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const match = parsed.pathname.match(/\/sketch\/detail\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) === moduleId : false;
}

function detailCourseId(body: unknown): string {
  const envelope = parseJson(body, "DETAIL_RESPONSE");
  if (safeInteger(envelope.code, "DETAIL_RESPONSE_CODE") !== 200) {
    throw error("DETAIL_RESPONSE_CODE_INVALID");
  }
  const data = assertRecord(envelope.data, "DETAIL_RESPONSE_DATA");
  const value = data.courseId;
  if (value === undefined || value === null || String(value).trim() === "") {
    throw error("COURSE_ID_UNVERIFIED");
  }
  return String(value).trim();
}

/** Pure course-join assertion used by the browser path and dependency-free tests. */
export function validateCmoocBrowserCommentCourseId(input: {
  expectedCourseId: string;
  observedCourseId: string;
}): true {
  const expected = stringValue(input.expectedCourseId, "COURSE_ID");
  const observed = stringValue(input.observedCourseId, "OBSERVED_COURSE_ID");
  if (expected !== observed) throw error("COURSE_ID_MISMATCH");
  return true;
}

/** Keep timeout validation explicit so callers can reject before launching Chromium. */
export function validateCmoocBrowserCommentTimeoutMs(value: number): true {
  if (!Number.isSafeInteger(value) || value < 1) throw error("TIMEOUT_INVALID");
  return true;
}

export function chooseCmoocBrowserCommentScrollSelector(input: {
  detailContentCount: number;
  detailCount: number;
}): ".detail_content" | ".detail" {
  if (input.detailContentCount > 0) return ".detail_content";
  if (input.detailCount > 0) return ".detail";
  throw error("DETAIL_CONTAINER_MISSING");
}

function assertThreadUrl(postUrl: string, allowedOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(postUrl);
  } catch {
    throw error("POST_URL_INVALID");
  }
  const guard = decideReadOnlyPlaywrightRequest({
    url: postUrl,
    method: "GET",
    allowedOrigins: [allowedOrigin]
  });
  if (guard.action === "abort") throw error("POST_URL_NOT_ALLOWED");
  if (parsed.pathname !== "/cMOOC/detail" && parsed.pathname !== "/cMOOC/detail/") {
    throw error("POST_URL_PATH_INVALID");
  }
  if (
    parsed.searchParams.getAll("id").length !== 1 ||
    parsed.searchParams.getAll("type").length !== 1 ||
    parsed.searchParams.get("type") !== "SKETCH"
  ) {
    throw error("POST_URL_STABLE_REF_REQUIRED");
  }
  const moduleId = parsed.searchParams.get("id") ?? "";
  if (!STABLE_ID_PATTERN.test(moduleId)) throw error("POST_URL_STABLE_REF_INVALID");
  if (hasSensitiveQuery(parsed) || parsed.hash) throw error("POST_URL_SENSITIVE_QUERY");
  return moduleId;
}

function requestBodyForBrowser(request: Request): Record<string, unknown> {
  const postData = request.postData();
  return parseJson(postData ?? null, "REQUEST_BODY");
}

function validateBrowserRequestBody(
  body: Record<string, unknown>,
  state: ActiveRead
): void {
  if (stringValue(body.moduleId, "REQUEST_MODULE_ID") !== state.moduleId) {
    throw error("REQUEST_MODULE_ID_MISMATCH");
  }
  const current = positiveInteger(body.current, "REQUEST_CURRENT");
  const size = positiveInteger(body.size, "REQUEST_SIZE");
  if (body.showReply !== true) throw error("REQUEST_SHOW_REPLY_INVALID");
  if (current !== state.captures.length + 1) {
    throw error("REQUEST_PAGE_SEQUENCE_INVALID");
  }
  const first = state.captures[0];
  if (first) {
    const firstBody = extractRequestBody(first);
    if (positiveInteger(firstBody.size, "REQUEST_SIZE") !== size) {
      throw error("REQUEST_SIZE_DRIFT");
    }
  }
}

async function waitForState(
  state: ActiveRead,
  predicate: () => boolean,
  timeoutMs: number,
  timeoutCode:
    | "INITIAL_COMMENT_RESPONSE_TIMEOUT"
    | "NEXT_COMMENT_PAGE_TIMEOUT"
    | "DETAIL_RESPONSE_TIMEOUT"
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (state.failure) throw state.failure;
    if (Date.now() >= deadline) {
      const progress =
        timeoutCode === "NEXT_COMMENT_PAGE_TIMEOUT"
          ? `_AFTER_${state.completedResponses}_OF_${
              state.serverPages ?? 0
            }`
          : "";
      throw error(`${timeoutCode}${progress}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (state.failure) throw state.failure;
}

function capturedRootRecordCount(state: ActiveRead): number {
  return state.captures.reduce((sum, capture) => {
    if (capture.response.status !== 200) return sum;
    return sum + parseCommentPageData(capture.response.body).data.records.length;
  }, 0);
}

async function waitForRenderedRootComments(
  page: Page,
  state: ActiveRead,
  timeoutMs: number
): Promise<void> {
  const expected = capturedRootRecordCount(state);
  const deadline = Date.now() + timeoutMs;
  while ((await page.locator(".cComment").count()) < expected) {
    if (state.failure) throw state.failure;
    if (Date.now() >= deadline) {
      throw error("COMMENT_RENDER_TIMEOUT");
    }
    await page.waitForTimeout(20);
  }
  if (state.failure) throw state.failure;
}

async function waitForCommentPageRequestStart(
  state: ActiveRead,
  previousCaptureCount: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (state.captures.length <= previousCaptureCount) {
    if (state.failure) throw state.failure;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

async function triggerNativeCommentScroll(
  page: Page,
  detail: Locator
): Promise<void> {
  const scrollRange = await detail.evaluate((element) => {
    const target = element as HTMLElement;
    // The deployed cMOOC detail handler requires both axes to be at their
    // terminal positions before it requests the next page.
    const top = Math.max(
      0,
      target.scrollHeight - target.clientHeight
    );
    const left = Math.max(
      0,
      target.scrollWidth - target.clientWidth
    );
    target.scrollTop = Math.max(0, top - 2);
    target.scrollLeft = Math.max(0, left - 2);
    return { top, left };
  });
  await detail.hover();
  if (scrollRange.top > 0 || scrollRange.left > 0) {
    await page.mouse.wheel(10_000, 10_000);
  } else {
    await detail.evaluate((element) => {
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
  }
}

class PlaywrightCmoocBrowserCommentCompanion
  implements CmoocBrowserCommentCompanion
{
  #closed = false;
  #browser: Browser;
  #context: BrowserContext;
  #allowedOrigin: string;
  #timeoutMs: number;
  #active: ActiveRead | null = null;

  private constructor(input: {
    browser: Browser;
    context: BrowserContext;
    allowedOrigin: string;
    timeoutMs: number;
  }) {
    this.#browser = input.browser;
    this.#context = input.context;
    this.#allowedOrigin = input.allowedOrigin;
    this.#timeoutMs = input.timeoutMs;
  }

  static async create(input: {
    browser: Browser;
    context: BrowserContext;
    allowedOrigin: string;
    timeoutMs: number;
  }): Promise<PlaywrightCmoocBrowserCommentCompanion> {
    const companion = new PlaywrightCmoocBrowserCommentCompanion(input);
    await companion.#installGuards();
    return companion;
  }

  async #installGuards(): Promise<void> {
    await this.#context.route("**/*", async (route, request) => {
      const decision = decideCmoocBrowserCommentRequest({
        url: request.url(),
        method: request.method(),
        allowedOrigin: this.#allowedOrigin
      });
      if (decision.action === "allow_get_or_head") {
        await route.continue();
        return;
      }
      if (decision.action === "allow_comment_list_post") {
        const state = this.#active;
        if (!state || !requestBelongsToActivePage(request, state)) {
          await route.abort("blockedbyclient");
          return;
        }
        try {
          const body = requestBodyForBrowser(request);
          validateBrowserRequestBody(body, state);
          const capture: CmoocBrowserCommentPageCapture = {
            request: {
              method: request.method(),
              url: request.url(),
              postData: request.postData()
            },
            response: { status: 0, body: null }
          };
          state.captures.push(capture);
          state.pending.set(request, capture);
          await route.continue();
          return;
        } catch (reason) {
          setFailure(state, reason, "REQUEST_CAPTURE");
          await route.abort("blockedbyclient");
          return;
        }
      }
      const state = this.#active;
      if (
        state &&
        requestBelongsToActivePage(request, state) &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(request.method().toUpperCase())
      ) {
        state.blockedWriteRequestCount += 1;
      }
      await route.abort("blockedbyclient");
    });
    await this.#context.routeWebSocket(/.*/, async (route) => {
      await route.close({
        code: 1008,
        reason: "CMOOC browser comment companion is read-only"
      });
    });
  }

  async #consumeCommentResponse(
    state: ActiveRead,
    request: Request,
    response: Response,
    capture: CmoocBrowserCommentPageCapture
  ): Promise<void> {
    try {
      const body = await response.json();
      capture.response = { status: response.status(), body };
      const { data } = parseCommentPageData(body);
      const requestBody = extractRequestBody(capture);
      const requestedCurrent = positiveInteger(requestBody.current, "REQUEST_CURRENT");
      if (data.current !== requestedCurrent) throw error("RESPONSE_PAGE_MISMATCH");
      if (state.serverPages === null) {
        state.serverPages = data.pages;
        if (data.pages > MAX_SAFE_SERVER_PAGES) throw error("SERVER_PAGES_LIMIT");
        if (data.total > state.maxComments) throw error("MAX_COMMENTS_LIMIT");
      } else if (state.serverPages !== data.pages) {
        throw error("PAGE_METADATA_DRIFT");
      }
      state.completedResponses += 1;
    } catch (reason) {
      setFailure(state, reason, "COMMENT_RESPONSE");
    } finally {
      state.pending.delete(request);
    }
  }

  async #consumeDetailResponse(
    state: ActiveRead,
    response: Response
  ): Promise<void> {
    if (!detailPathMatches(response.url(), state.moduleId)) return;
    try {
      if (response.status() !== 200) throw error("DETAIL_HTTP_STATUS_INVALID");
      const courseId = detailCourseId(await response.json());
      validateCmoocBrowserCommentCourseId({
        expectedCourseId: state.expectedCourseId,
        observedCourseId: courseId
      });
      state.courseValidated = true;
    } catch (reason) {
      setFailure(state, reason, "DETAIL_RESPONSE");
    }
  }

  #observeResponses(page: Page, state: ActiveRead): void {
    page.on("response", (response) => {
      const request = response.request();
      const commentCapture = state.pending.get(request);
      const task = commentCapture
        ? this.#consumeCommentResponse(state, request, response, commentCapture)
        : this.#consumeDetailResponse(state, response);
      state.responseTasks.add(task);
      void task.finally(() => state.responseTasks.delete(task));
    });
    page.on("download", (download) => {
      void download.cancel();
    });
  }

  async readThread(input: {
    postUrl: string;
    expectedCourseId: string;
    maxComments: number;
  }): Promise<CmoocBrowserCommentCompanionSnapshot> {
    if (this.#closed) throw error("CLOSED");
    if (this.#active) throw error("CONCURRENT_READ_NOT_ALLOWED");
    const expectedCourseId = stringValue(input.expectedCourseId, "COURSE_ID");
    const maxComments = positiveInteger(input.maxComments, "MAX_COMMENTS");
    const moduleId = assertThreadUrl(input.postUrl, this.#allowedOrigin);
    const state: ActiveRead = {
      page: null,
      moduleId,
      expectedCourseId,
      maxComments,
      captures: [],
      pending: new Map(),
      completedResponses: 0,
      responseTasks: new Set(),
      courseValidated: false,
      serverPages: null,
      blockedWriteRequestCount: 0,
      failure: null
    };
    this.#active = state;
    let page: Page | null = null;
    let runtimePhase: CmoocBrowserCommentRuntimePhase =
      "BROWSER_SESSION";
    try {
      page = await this.#context.newPage();
      state.page = page;
      this.#observeResponses(page, state);
      runtimePhase = "NAVIGATION";
      const navigation = await page
        .goto(input.postUrl, {
          waitUntil: "load",
          timeout: this.#timeoutMs
        })
        .catch((reason: unknown) => {
          const message =
            reason instanceof Error
              ? `${reason.name} ${reason.message}`.toUpperCase()
              : "";
          if (message.includes("TIMEOUT")) {
            throw error("NAVIGATION_TIMEOUT");
          }
          throw normalizeCmoocBrowserCommentRuntimeError(
            reason,
            "NAVIGATION"
          );
        });
      if (!navigation || !navigation.ok()) throw error("NAVIGATION_FAILED");
      // A redirect to another same-origin page (for example a login shell) is
      // not independent thread evidence and must not be treated as success.
      const finalModuleId = assertThreadUrl(page.url(), this.#allowedOrigin);
      if (finalModuleId !== moduleId) throw error("THREAD_ID_MISMATCH");
      await waitForState(
        state,
        () => state.completedResponses > 0 || state.failure !== null,
        this.#timeoutMs,
        "INITIAL_COMMENT_RESPONSE_TIMEOUT"
      );
      if (state.serverPages === null) throw error("SERVER_PAGES_UNVERIFIED");
      runtimePhase = "DOM_INSPECTION";
      const detailContentCount = await page
        .locator(".detail_content")
        .count();
      const detailCount = await page.locator(".detail").count();
      const detail = page
        .locator(
          chooseCmoocBrowserCommentScrollSelector({
            detailContentCount,
            detailCount
          })
        )
        .first();

      while (state.completedResponses < state.serverPages) {
        if (state.failure) throw state.failure;
        await waitForRenderedRootComments(
          page,
          state,
          this.#timeoutMs
        );
        if (state.completedResponses >= state.serverPages) break;
        const before = state.completedResponses;
        const previousCaptureCount = state.captures.length;
        let requestStarted =
          previousCaptureCount > state.completedResponses;
        if (!requestStarted) {
          for (let attempt = 0; attempt < 3 && !requestStarted; attempt += 1) {
            runtimePhase = "NATIVE_SCROLL";
            await triggerNativeCommentScroll(page, detail);
            requestStarted = await waitForCommentPageRequestStart(
              state,
              previousCaptureCount,
              Math.min(1_000, this.#timeoutMs)
            );
          }
        }
        runtimePhase = "DOM_INSPECTION";
        requestStarted ||=
          state.captures.length > previousCaptureCount;
        if (state.completedResponses >= state.serverPages) break;
        if (!requestStarted) {
          throw error(
            `NEXT_COMMENT_PAGE_REQUEST_NOT_OBSERVED_AFTER_${
              state.completedResponses
            }_OF_${state.serverPages}`
          );
        }
        await waitForState(
          state,
          () => state.completedResponses > before || state.failure !== null,
          this.#timeoutMs,
          "NEXT_COMMENT_PAGE_TIMEOUT"
        );
      }
      await Promise.all([...state.responseTasks]);
      if (state.failure) throw state.failure;
      await waitForState(
        state,
        () => state.courseValidated || state.failure !== null,
        this.#timeoutMs,
        "DETAIL_RESPONSE_TIMEOUT"
      );
      await Promise.all([...state.responseTasks]);
      if (state.failure) throw state.failure;
      if (!state.courseValidated) throw error("COURSE_ID_UNVERIFIED");
      const snapshot = validateCmoocBrowserCommentPageSequence({
        captures: state.captures,
        expectedModuleId: moduleId,
        maxComments: maxComments,
        blockedWriteRequestCount: state.blockedWriteRequestCount
      });
      return snapshot;
    } catch (reason) {
      throw normalizeCmoocBrowserCommentRuntimeError(
        reason,
        runtimePhase
      );
    } finally {
      this.#active = null;
      state.page = null;
      if (page) await page.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#active && !this.#active.failure) {
      this.#active.failure = error("CLOSED");
    }
    try {
      await this.#context.close();
    } finally {
      await this.#browser.close().catch(() => undefined);
    }
  }
}

export async function openCmoocBrowserCommentCompanion(input: {
  allowedOrigin: string;
  timeoutMs?: number;
  storageStatePath?: string;
  browserChannel?: CmoocBrowserCommentBrowserChannel;
}): Promise<CmoocBrowserCommentCompanion> {
  const allowedOrigin = normalizeAllowedOrigin(input.allowedOrigin);
  const timeoutMs = input.timeoutMs ?? 30_000;
  validateCmoocBrowserCommentTimeoutMs(timeoutMs);
  const defaultStorageStatePath = path.join(
    process.cwd(),
    "playwright",
    "auth-state.json"
  );
  const storageStatePath = input.storageStatePath?.trim()
    ? path.resolve(input.storageStatePath)
    : defaultStorageStatePath;
  if (
    input.storageStatePath?.trim() &&
    !existsSync(storageStatePath)
  ) {
    throw error("AUTH_STATE_MISSING");
  }
  const browserChannel =
    input.browserChannel ?? "bundled_chromium";
  if (
    browserChannel !== "bundled_chromium" &&
    browserChannel !== "system_chrome"
  ) {
    throw error("BROWSER_CHANNEL_INVALID");
  }
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  try {
    browser = await chromium.launch(
      browserChannel === "system_chrome"
        ? { channel: "chrome", headless: true }
        : { headless: true }
    );
    context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
      ...(existsSync(storageStatePath)
        ? { storageState: storageStatePath }
        : {})
    });
    return await PlaywrightCmoocBrowserCommentCompanion.create({
      browser,
      context,
      allowedOrigin,
      timeoutMs
    });
  } catch (reason) {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    throw normalizeCmoocBrowserCommentRuntimeError(
      reason,
      "BROWSER_SESSION"
    );
  }
}
