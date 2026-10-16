import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page
} from "playwright";
import type {
  BrowserDiagnosticAuthSnapshot,
  BrowserDiagnosticCommentDetail,
  BrowserDiagnosticProbe,
  BrowserDiagnosticThreadDetail,
  BrowserDiagnosticThreadListItem
} from "./cmooc-browser-diagnostic-adapter";

export const CMOOC_PLAYWRIGHT_READ_ONLY_PROBE_VERSION =
  "cmooc.playwright-read-only-probe.v1" as const;

export interface ReadOnlyPlaywrightLocator {
  count(): Promise<number>;
  first(): ReadOnlyPlaywrightLocator;
  nth(index: number): ReadOnlyPlaywrightLocator;
  locator(selector: string): ReadOnlyPlaywrightLocator;
  getAttribute(name: string): Promise<string | null>;
  innerText(options?: { timeout?: number }): Promise<string>;
}

export interface ReadOnlyPlaywrightNavigationResponse {
  ok(): boolean;
  status(): number;
}

export interface ReadOnlyPlaywrightDownload {
  cancel(): Promise<void>;
}

export interface ReadOnlyPlaywrightPage {
  goto(
    url: string,
    options: {
      waitUntil: "load";
      timeout: number;
    }
  ): Promise<ReadOnlyPlaywrightNavigationResponse | null>;
  locator(selector: string): ReadOnlyPlaywrightLocator;
  currentUrl(): string;
  onDownload(
    listener: (download: ReadOnlyPlaywrightDownload) => void
  ): void;
}

export interface ReadOnlyPlaywrightRequest {
  method(): string;
  url(): string;
}

export interface ReadOnlyPlaywrightRoute {
  abort(errorCode: "blockedbyclient"): Promise<void>;
  continue(): Promise<void>;
}

export interface ReadOnlyPlaywrightWebSocketRoute {
  close(options: { code: number; reason: string }): Promise<void>;
}

export interface ReadOnlyPlaywrightContext {
  interceptRequests(
    handler: (
      route: ReadOnlyPlaywrightRoute,
      request: ReadOnlyPlaywrightRequest
    ) => Promise<void>
  ): Promise<void>;
  interceptWebSockets(
    handler: (
      route: ReadOnlyPlaywrightWebSocketRoute
    ) => Promise<void>
  ): Promise<void>;
  newPage(): Promise<ReadOnlyPlaywrightPage>;
  close(): Promise<void>;
}

export interface ReadOnlyPlaywrightBrowser {
  newContext(options: {
    serviceWorkers: "block";
    acceptDownloads: false;
  }): Promise<ReadOnlyPlaywrightContext>;
  close(): Promise<void>;
}

export interface ReadOnlyPlaywrightDriver {
  launch(options: {
    headless: true;
  }): Promise<ReadOnlyPlaywrightBrowser>;
}

export type ReadOnlyRequestViolationCode =
  | "invalid_url"
  | "https_required"
  | "embedded_credentials_forbidden"
  | "sensitive_query_forbidden"
  | "origin_not_allowed"
  | "method_not_allowed"
  | "websocket_forbidden"
  | "download_forbidden";

export type ReadOnlyRequestDecision =
  | { action: "allow" }
  | {
      action: "abort";
      code: Exclude<
        ReadOnlyRequestViolationCode,
        "websocket_forbidden" | "download_forbidden"
      >;
    };

export interface ReadOnlyPlaywrightProbeAudit {
  schemaVersion: typeof CMOOC_PLAYWRIGHT_READ_ONLY_PROBE_VERSION;
  networkEnabled: boolean;
  allowedOriginCount: number;
  sessionsStarted: number;
  allowedRequestCount: number;
  abortedRequestCount: number;
  blockedWebSocketCount: number;
  blockedDownloadCount: number;
  violationCodes: ReadOnlyRequestViolationCode[];
  containsForumText: false;
}

export interface CmoocReadOnlyProbeSelectors {
  readableRoot: string;
  authenticatedMarker: string;
  unauthenticatedMarker: string;
  threadLinks: string;
  threadCardAncestor: string;
  threadCardTime: string;
  detailRoot: string;
  detailTitle: string;
  detailContent: string;
  detailTime: string;
  documentTitle: string;
  commentItems: string;
  commentContent: string;
  commentTime: string;
}

export interface CmoocPlaywrightReadOnlyProbeOptions {
  allowedOrigins: readonly string[];
  authCheckUrl: string;
  networkEnabled?: boolean;
  timeoutMs?: number;
  driver?: ReadOnlyPlaywrightDriver;
  selectors?: Partial<CmoocReadOnlyProbeSelectors>;
}

const DEFAULT_SELECTORS: CmoocReadOnlyProbeSelectors = {
  readableRoot: "body",
  authenticatedMarker:
    "[data-user-id], .avatar, .user-info, .userInfo",
  unauthenticatedMarker:
    "a[href*='login'], a[href*='Login'], .login",
  threadLinks: "a[href*='/cMOOC/detail']",
  threadCardAncestor:
    "xpath=ancestor-or-self::*[self::article or self::li or " +
    "contains(@class,'item') or contains(@class,'card')][1]",
  threadCardTime: "time[datetime], time",
  detailRoot: ".detail_content",
  detailTitle:
    ".detail_content h1, .detail_content .title, " +
    ".detail_content .topic, h1",
  detailContent: ".detail_content .content",
  detailTime: ".detail_content time, .detail_content .time",
  documentTitle: "title",
  commentItems: ".comment .items > .cComment.item",
  commentContent: ".content",
  commentTime: "time, .buttons .time"
};

const STABLE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXPLICIT_ZONE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
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

function adaptLocator(locator: Locator): ReadOnlyPlaywrightLocator {
  return {
    count: () => locator.count(),
    first: () => adaptLocator(locator.first()),
    nth: (index) => adaptLocator(locator.nth(index)),
    locator: (selector) => adaptLocator(locator.locator(selector)),
    getAttribute: (name) => locator.getAttribute(name),
    innerText: (options) => locator.innerText(options)
  };
}

function adaptPage(page: Page): ReadOnlyPlaywrightPage {
  return {
    goto: async (url, options) => {
      const response = await page.goto(url, options);
      return response
        ? {
            ok: () => response.ok(),
            status: () => response.status()
          }
        : null;
    },
    locator: (selector) => adaptLocator(page.locator(selector)),
    currentUrl: () => page.url(),
    onDownload: (listener) => {
      page.on("download", (download) => {
        listener({
          cancel: () => download.cancel()
        });
      });
    }
  };
}

function adaptContext(
  context: BrowserContext
): ReadOnlyPlaywrightContext {
  return {
    interceptRequests: (handler) =>
      context.route("**/*", (route, request) =>
        handler(
          {
            abort: () => route.abort("blockedbyclient"),
            continue: () => route.continue()
          },
          {
            method: () => request.method(),
            url: () => request.url()
          }
        )
      ).then(() => undefined),
    interceptWebSockets: (handler) =>
      context.routeWebSocket(/.*/, (route) =>
        handler({
          close: (options) => route.close(options)
        })
      ).then(() => undefined),
    newPage: async () => adaptPage(await context.newPage()),
    close: () => context.close()
  };
}

function adaptBrowser(
  browser: Browser
): ReadOnlyPlaywrightBrowser {
  return {
    newContext: async (options) =>
      adaptContext(await browser.newContext(options)),
    close: () => browser.close()
  };
}

const DEFAULT_DRIVER: ReadOnlyPlaywrightDriver = {
  launch: async (options) =>
    adaptBrowser(await chromium.launch(options))
};

function normalizedAllowedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("INVALID_READ_ONLY_ALLOWED_ORIGIN");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("INVALID_READ_ONLY_ALLOWED_ORIGIN");
  }
  return url.origin;
}

function hasSensitiveQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
    if (
      SENSITIVE_QUERY_MARKERS.some((marker) =>
        normalizedKey.includes(marker)
      )
    ) {
      return true;
    }
  }
  return false;
}

export function decideReadOnlyPlaywrightRequest(input: {
  url: string;
  method: string;
  allowedOrigins: readonly string[];
}): ReadOnlyRequestDecision {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { action: "abort", code: "invalid_url" };
  }
  if (url.protocol !== "https:") {
    return { action: "abort", code: "https_required" };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      action: "abort",
      code: "embedded_credentials_forbidden"
    };
  }
  if (hasSensitiveQuery(url)) {
    return {
      action: "abort",
      code: "sensitive_query_forbidden"
    };
  }
  const allowedOrigins = new Set(
    input.allowedOrigins.map(normalizedAllowedOrigin)
  );
  if (!allowedOrigins.has(url.origin)) {
    return { action: "abort", code: "origin_not_allowed" };
  }
  const method = input.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return { action: "abort", code: "method_not_allowed" };
  }
  return { action: "allow" };
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function readText(
  locator: ReadOnlyPlaywrightLocator,
  timeoutMs: number
): Promise<string> {
  try {
    return cleanText(await locator.innerText({ timeout: timeoutMs }));
  } catch {
    return "";
  }
}

async function readAttribute(
  locator: ReadOnlyPlaywrightLocator,
  names: readonly string[]
): Promise<string | null> {
  for (const name of names) {
    const value = await locator.getAttribute(name);
    if (value !== null && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

function stableRefOrNull(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return STABLE_REF_PATTERN.test(value) ? value : null;
}

function explicitTimeOrNull(value: string | null): string | null {
  if (
    value === null ||
    !EXPLICIT_ZONE_TIME_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return null;
  }
  return new Date(value).toISOString();
}

async function readExplicitTime(
  locator: ReadOnlyPlaywrightLocator,
  timeoutMs: number
): Promise<string | null> {
  const attribute = await readAttribute(locator, [
    "datetime",
    "data-time",
    "data-created-at",
    "data-edited-at"
  ]);
  const fromAttribute = explicitTimeOrNull(attribute);
  if (fromAttribute !== null) {
    return fromAttribute;
  }
  return explicitTimeOrNull(await readText(locator, timeoutMs));
}

function detailStableRef(locator: string): string | null {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    return null;
  }
  if (!/^\/cMOOC\/detail$/i.test(url.pathname)) {
    return null;
  }
  const candidate = url.searchParams.get("id");
  return candidate && /^\d{8,127}$/.test(candidate)
    ? candidate
    : null;
}

async function readReplyCount(
  locator: ReadOnlyPlaywrightLocator,
  visibleStateText: string
): Promise<number> {
  const attribute = await readAttribute(locator, [
    "data-reply-count",
    "data-comment-count"
  ]);
  const candidate =
    attribute ??
    visibleStateText.match(
      /(?:评论|回复|comments?|repl(?:y|ies))\s*[:：]?\s*(\d+)/i
    )?.[1] ??
    null;
  if (candidate === null || !/^\d+$/.test(candidate)) {
    return 0;
  }
  const count = Number(candidate);
  return Number.isSafeInteger(count) ? count : 0;
}

export class CmoocPlaywrightReadOnlyProbe
  implements BrowserDiagnosticProbe
{
  readonly #allowedOrigins: string[];
  readonly #authCheckUrl: string;
  readonly #networkEnabled: boolean;
  readonly #timeoutMs: number;
  readonly #driver: ReadOnlyPlaywrightDriver;
  readonly #selectors: CmoocReadOnlyProbeSelectors;
  readonly #violations: ReadOnlyRequestViolationCode[] = [];
  #sessionsStarted = 0;
  #allowedRequestCount = 0;
  #abortedRequestCount = 0;
  #blockedWebSocketCount = 0;
  #blockedDownloadCount = 0;

  constructor(options: CmoocPlaywrightReadOnlyProbeOptions) {
    if (
      !options ||
      !Array.isArray(options.allowedOrigins) ||
      options.allowedOrigins.length === 0
    ) {
      throw new Error("READ_ONLY_ALLOWED_ORIGIN_REQUIRED");
    }
    this.#allowedOrigins = [
      ...new Set(options.allowedOrigins.map(normalizedAllowedOrigin))
    ];
    this.#authCheckUrl = options.authCheckUrl;
    this.#networkEnabled = options.networkEnabled === true;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#driver = options.driver ?? DEFAULT_DRIVER;
    this.#selectors = {
      ...DEFAULT_SELECTORS,
      ...options.selectors
    };
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 100 ||
      this.#timeoutMs > 120_000
    ) {
      throw new Error("INVALID_READ_ONLY_PROBE_TIMEOUT");
    }
    this.#assertNavigationAllowed(this.#authCheckUrl);
  }

  auditSnapshot(): ReadOnlyPlaywrightProbeAudit {
    return {
      schemaVersion: CMOOC_PLAYWRIGHT_READ_ONLY_PROBE_VERSION,
      networkEnabled: this.#networkEnabled,
      allowedOriginCount: this.#allowedOrigins.length,
      sessionsStarted: this.#sessionsStarted,
      allowedRequestCount: this.#allowedRequestCount,
      abortedRequestCount: this.#abortedRequestCount,
      blockedWebSocketCount: this.#blockedWebSocketCount,
      blockedDownloadCount: this.#blockedDownloadCount,
      violationCodes: [...this.#violations],
      containsForumText: false
    };
  }

  async inspectAuth(): Promise<BrowserDiagnosticAuthSnapshot> {
    return this.#withPage(
      this.#authCheckUrl,
      async (page, response) => {
        const readable =
          response?.ok() === true &&
          (await page
            .locator(this.#selectors.readableRoot)
            .count()) > 0;
        const authenticatedCount = await page
          .locator(this.#selectors.authenticatedMarker)
          .count();
        const unauthenticatedCount = await page
          .locator(this.#selectors.unauthenticatedMarker)
          .count();
        const authenticated =
          authenticatedCount > 0 && unauthenticatedCount === 0
            ? true
            : unauthenticatedCount > 0 &&
                authenticatedCount === 0
              ? false
              : null;
        return { authenticated, readable };
      }
    );
  }

  async readThreadList(input: {
    forumListUrl: string;
    maxThreads: number;
  }): Promise<BrowserDiagnosticThreadListItem[]> {
    if (
      !Number.isSafeInteger(input.maxThreads) ||
      input.maxThreads < 1 ||
      input.maxThreads > 100
    ) {
      throw new Error("INVALID_READ_ONLY_MAX_THREADS");
    }
    return this.#withPage(
      input.forumListUrl,
      async (page, response) => {
        this.#assertReadableResponse(
          response,
          "READ_ONLY_THREAD_LIST_UNAVAILABLE"
        );
        const links = page.locator(this.#selectors.threadLinks);
        const scanLimit = Math.min(
          await links.count(),
          Math.min(
            Math.max(input.maxThreads * 20, 100),
            500
          )
        );
        const seen = new Set<string>();
        const items: BrowserDiagnosticThreadListItem[] = [];
        for (
          let index = 0;
          index < scanLimit && items.length < input.maxThreads;
          index += 1
        ) {
          const link = links.nth(index);
          const href = await link.getAttribute("href");
          if (!href) {
            continue;
          }
          let locator: string;
          try {
            locator = new URL(href, page.currentUrl()).toString();
          } catch {
            continue;
          }
          const stableThreadRef = detailStableRef(locator);
          const decision = decideReadOnlyPlaywrightRequest({
            url: locator,
            method: "GET",
            allowedOrigins: this.#allowedOrigins
          });
          if (
            stableThreadRef === null ||
            decision.action === "abort" ||
            seen.has(stableThreadRef)
          ) {
            continue;
          }
          seen.add(stableThreadRef);
          const candidateCard = link
            .locator(this.#selectors.threadCardAncestor)
            .first();
          const card =
            (await candidateCard.count()) > 0
              ? candidateCard
              : link;
          const titleText =
            (await readText(link, this.#timeoutMs)) ||
            stableThreadRef;
          const visibleStateText = await readText(
            card,
            this.#timeoutMs
          );
          const latestEventAt = await readExplicitTime(
            card.locator(this.#selectors.threadCardTime).first(),
            this.#timeoutMs
          );
          items.push({
            locator,
            titleText,
            visibleStateText,
            replyCount: await readReplyCount(
              card,
              visibleStateText
            ),
            latestEventAt
          });
        }
        return items;
      }
    );
  }

  async readThreadDetail(input: {
    threadUrl: string;
  }): Promise<BrowserDiagnosticThreadDetail | null> {
    return this.#withPage(
      input.threadUrl,
      async (page, response) => {
        if (response?.ok() !== true) {
          return null;
        }
        const detailRoot = page
          .locator(this.#selectors.detailRoot)
          .first();
        if ((await detailRoot.count()) === 0) {
          return null;
        }
        const titleText =
          (await readText(
            page.locator(this.#selectors.detailTitle).first(),
            this.#timeoutMs
          )) ||
          (await readText(
            page.locator(this.#selectors.documentTitle).first(),
            this.#timeoutMs
          ));
        const contentText = await readText(
          page.locator(this.#selectors.detailContent).first(),
          this.#timeoutMs
        );
        const authorStableRef = stableRefOrNull(
          await readAttribute(detailRoot, [
            "data-author-id",
            "data-user-id"
          ])
        );
        const createdAt = explicitTimeOrNull(
          await readAttribute(detailRoot, ["data-created-at"])
        );
        const editedAt =
          explicitTimeOrNull(
            await readAttribute(detailRoot, ["data-edited-at"])
          ) ??
          (await readExplicitTime(
            page.locator(this.#selectors.detailTime).first(),
            this.#timeoutMs
          ));
        const comments = await this.#readComments(page);
        return {
          locator: page.currentUrl(),
          authorStableRef,
          titleText,
          contentText,
          createdAt,
          editedAt,
          comments
        };
      }
    );
  }

  async #readComments(
    page: ReadOnlyPlaywrightPage
  ): Promise<BrowserDiagnosticCommentDetail[]> {
    const commentsLocator = page.locator(
      this.#selectors.commentItems
    );
    const count = await commentsLocator.count();
    const comments: BrowserDiagnosticCommentDetail[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < count; index += 1) {
      const comment = commentsLocator.nth(index);
      const stableCommentRef = stableRefOrNull(
        await readAttribute(comment, [
          "data-comment-id",
          "data-id",
          "id"
        ])
      );
      if (
        stableCommentRef === null ||
        seen.has(stableCommentRef)
      ) {
        throw new Error(
          "READ_ONLY_COMMENT_STABLE_REF_REQUIRED"
        );
      }
      seen.add(stableCommentRef);
      const parentRef = stableRefOrNull(
        await readAttribute(comment, [
          "data-parent-id",
          "data-parent-ref"
        ])
      );
      const authorStableRef = stableRefOrNull(
        await readAttribute(comment, [
          "data-author-id",
          "data-user-id"
        ])
      );
      const timeLocator = comment
        .locator(this.#selectors.commentTime)
        .first();
      const createdAt =
        explicitTimeOrNull(
          await readAttribute(comment, ["data-created-at"])
        ) ??
        (await readExplicitTime(timeLocator, this.#timeoutMs));
      const editedAt = explicitTimeOrNull(
        await readAttribute(comment, ["data-edited-at"])
      );
      comments.push({
        stableCommentRef,
        parentRef,
        authorStableRef,
        contentText: await readText(
          comment
            .locator(this.#selectors.commentContent)
            .first(),
          this.#timeoutMs
        ),
        createdAt,
        editedAt
      });
    }
    return comments;
  }

  #assertNavigationAllowed(url: string): void {
    const decision = decideReadOnlyPlaywrightRequest({
      url,
      method: "GET",
      allowedOrigins: this.#allowedOrigins
    });
    if (decision.action === "abort") {
      throw new Error(
        `READ_ONLY_NAVIGATION_FORBIDDEN: ${decision.code}`
      );
    }
  }

  #assertReadableResponse(
    response: ReadOnlyPlaywrightNavigationResponse | null,
    code: string
  ): void {
    if (response?.ok() !== true) {
      throw new Error(
        `${code}: ${response?.status() ?? "no_response"}`
      );
    }
  }

  #recordViolation(
    code: ReadOnlyRequestViolationCode,
    sessionViolations: ReadOnlyRequestViolationCode[]
  ): void {
    this.#violations.push(code);
    sessionViolations.push(code);
  }

  #throwForSessionViolation(
    sessionViolations: ReadOnlyRequestViolationCode[]
  ): void {
    const [code] = sessionViolations;
    if (code) {
      throw new Error(
        `READ_ONLY_BROWSER_POLICY_VIOLATION: ${code}`
      );
    }
  }

  async #withPage<T>(
    url: string,
    read: (
      page: ReadOnlyPlaywrightPage,
      response: ReadOnlyPlaywrightNavigationResponse | null
    ) => Promise<T>
  ): Promise<T> {
    this.#assertNavigationAllowed(url);
    if (!this.#networkEnabled) {
      throw new Error("READ_ONLY_BROWSER_NETWORK_DISABLED");
    }
    const sessionViolations: ReadOnlyRequestViolationCode[] = [];
    const pendingGuards: Promise<void>[] = [];
    this.#sessionsStarted += 1;
    let browser: ReadOnlyPlaywrightBrowser | undefined;
    let context: ReadOnlyPlaywrightContext | undefined;
    let result: T | undefined;
    let completed = false;
    let operationError: unknown;
    try {
      browser = await this.#driver.launch({ headless: true });
      context = await browser.newContext({
        serviceWorkers: "block",
        acceptDownloads: false
      });
      await context.interceptRequests(async (route, request) => {
        const decision = decideReadOnlyPlaywrightRequest({
          url: request.url(),
          method: request.method(),
          allowedOrigins: this.#allowedOrigins
        });
        if (decision.action === "abort") {
          this.#abortedRequestCount += 1;
          this.#recordViolation(
            decision.code,
            sessionViolations
          );
          await route.abort("blockedbyclient");
          return;
        }
        this.#allowedRequestCount += 1;
        await route.continue();
      });
      await context.interceptWebSockets(async (route) => {
        this.#blockedWebSocketCount += 1;
        this.#recordViolation(
          "websocket_forbidden",
          sessionViolations
        );
        await route.close({
          code: 1008,
          reason: "read-only diagnostic policy"
        });
      });
      const page = await context.newPage();
      page.onDownload((download) => {
        this.#blockedDownloadCount += 1;
        this.#recordViolation(
          "download_forbidden",
          sessionViolations
        );
        pendingGuards.push(download.cancel());
      });
      const response = await page.goto(url, {
        waitUntil: "load",
        timeout: this.#timeoutMs
      });
      this.#throwForSessionViolation(sessionViolations);
      result = await read(page, response);
      this.#throwForSessionViolation(sessionViolations);
      completed = true;
    } catch (error) {
      operationError = error;
    } finally {
      try {
        await context?.close();
        await browser?.close();
      } catch (error) {
        operationError ??= error;
      }
    }
    await Promise.allSettled(pendingGuards);
    this.#throwForSessionViolation(sessionViolations);
    if (operationError !== undefined) {
      throw operationError;
    }
    if (!completed) {
      throw new Error("READ_ONLY_BROWSER_SESSION_INCOMPLETE");
    }
    return result as T;
  }
}
