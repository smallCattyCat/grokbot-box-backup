import { existsSync } from "node:fs";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
  type WebSocketRoute
} from "playwright";
import type {
  CmoocQuillStageBrowserBridge
} from "./cmooc-quill-stage-driver";

export const CMOOC_QUILL_STAGE_BROWSER_BRIDGE_VERSION =
  "cmooc.quill-stage-browser-bridge.v1" as const;

export type StageBrowserViolationCode =
  | "invalid_url"
  | "https_required"
  | "embedded_credentials_forbidden"
  | "sensitive_query_forbidden"
  | "sensitive_path_forbidden"
  | "origin_not_allowed"
  | "method_not_allowed"
  | "websocket_forbidden"
  | "download_forbidden";

export type StageBrowserBridgeAudit = {
  schemaVersion: typeof CMOOC_QUILL_STAGE_BROWSER_BRIDGE_VERSION;
  networkEnabled: true;
  allowedOriginCount: 1;
  guardInstalled: true;
  pageCount: 1;
  allowedRequestCount: number;
  blockedRequestCount: number;
  blockedWebSocketCount: number;
  blockedDownloadCount: number;
  sentMutationCount: 0;
  violationCodes: StageBrowserViolationCode[];
  containsForumText: false;
};

export type StageBrowserEvaluateOptions = {
  timeoutMs: number;
};

export type StageBrowserNavigationResponse = {
  ok(): boolean;
  status(): number;
};

export interface StageBrowserRequest {
  method(): string;
  url(): string;
  resourceType?(): string;
  isNavigationRequest?(): boolean;
}

export interface StageBrowserRoute {
  abort(errorCode: "blockedbyclient"): Promise<void>;
  continue(): Promise<void>;
}

export interface StageBrowserWebSocketRoute {
  close(options: { code: number; reason: string }): Promise<void>;
}

export interface StageBrowserDownload {
  cancel(): Promise<void>;
}

export interface StageBrowserPage {
  goto(
    url: string,
    options: {
      waitUntil: "load";
      timeout: number;
    }
  ): Promise<StageBrowserNavigationResponse | null>;
  url(): string;
  evaluate<Result, Argument>(
    pageFunction: (
      argument: Argument
    ) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result>;
  on(
    event: "download",
    listener: (download: StageBrowserDownload) => void
  ): void;
  close(): Promise<void>;
}

export interface StageBrowserContext {
  route(
    pattern: string,
    handler: (
      route: StageBrowserRoute,
      request: StageBrowserRequest
    ) => Promise<void>
  ): Promise<void>;
  routeWebSocket(
    pattern: RegExp,
    handler: (
      route: StageBrowserWebSocketRoute
    ) => Promise<void>
  ): Promise<void>;
  newPage(): Promise<StageBrowserPage>;
  close(): Promise<void>;
}

export interface StageBrowserBrowser {
  newContext(options: {
    serviceWorkers: "block";
    acceptDownloads: false;
    storageState?: string;
  }): Promise<StageBrowserContext>;
  close(): Promise<void>;
}

export interface StageBrowserDriver {
  launch(options: { headless: true }): Promise<StageBrowserBrowser>;
}

export type CmoocQuillStageBrowserBridgeOptions = {
  targetUrl: string;
  allowedOrigin: string;
  storageStatePath?: string;
  timeoutMs?: number;
  driver?: StageBrowserDriver;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const RESOURCE_CLOSE_TIMEOUT_MS = 2_000;
const EDITOR_READINESS_TIMEOUT_MS = 8_000;
const EDITOR_READINESS_POLL_INTERVAL_MS = 50;
const EDITOR_SELECTOR = ".comment_container #edit .ql-editor";
const EDITOR_READINESS_ARGUMENT_MARKER =
  "cmooc-quill-stage-editor-readiness-v1" as const;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const BACKGROUND_READ_RESOURCE_TYPES = new Set(["xhr", "fetch"]);
const EXPECTED_COMMENT_LIST_PATHS = new Set([
  "/cmooc-api/comment/list",
  "/comment/list"
]);
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
const SENSITIVE_PATH_SEGMENTS = new Set([
  "logout",
  "signout",
  "export",
  "download",
  "token",
  "auth",
  "credential",
  "credentials",
  "password",
  "delete",
  "remove",
  "publish"
]);

const CODES = {
  options: "CMOOC_QUILL_STAGE_BROWSER_OPTIONS_INVALID",
  origin: "CMOOC_QUILL_STAGE_BROWSER_ORIGIN_INVALID",
  target: "CMOOC_QUILL_STAGE_BROWSER_TARGET_INVALID",
  authState: "CMOOC_QUILL_STAGE_BROWSER_AUTH_STATE_MISSING",
  launch: "CMOOC_QUILL_STAGE_BROWSER_LAUNCH_FAILED",
  context: "CMOOC_QUILL_STAGE_BROWSER_CONTEXT_FAILED",
  guard: "CMOOC_QUILL_STAGE_BROWSER_GUARD_INSTALL_FAILED",
  navigation: "CMOOC_QUILL_STAGE_BROWSER_NAVIGATION_FAILED",
  targetMismatch: "CMOOC_QUILL_STAGE_BROWSER_TARGET_URL_MISMATCH",
  network: "CMOOC_QUILL_STAGE_BROWSER_NETWORK_GUARD_VIOLATION",
  editorReadiness: "CMOOC_QUILL_STAGE_BROWSER_EDITOR_READINESS_FAILED",
  editorReadinessTimeout:
    "CMOOC_QUILL_STAGE_BROWSER_EDITOR_READINESS_TIMEOUT",
  editorNotUnique: "CMOOC_QUILL_STAGE_BROWSER_EDITOR_NOT_UNIQUE",
  evaluate: "CMOOC_QUILL_STAGE_BROWSER_EVALUATE_FAILED",
  evaluateTimeout: "CMOOC_QUILL_STAGE_BROWSER_EVALUATE_TIMEOUT",
  evaluateOptions: "CMOOC_QUILL_STAGE_BROWSER_EVALUATE_OPTIONS_INVALID",
  closed: "CMOOC_QUILL_STAGE_BROWSER_BRIDGE_CLOSED",
  close: "CMOOC_QUILL_STAGE_BROWSER_CLOSE_FAILED"
} as const;

const STABLE_CODES = new Set<string>(Object.values(CODES));

function stableError(code: string): Error {
  return new Error(code);
}

function isStableCode(value: unknown): value is string {
  return typeof value === "string" && STABLE_CODES.has(value);
}

function hasSensitiveQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase().replace(/[-_]/g, "");
    if (
      SENSITIVE_QUERY_MARKERS.some((marker) =>
        normalized.includes(marker)
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasSensitivePath(url: URL): boolean {
  return url.pathname
    .split("/")
    .filter(Boolean)
    .some((segment) =>
      SENSITIVE_PATH_SEGMENTS.has(segment.toLowerCase())
    );
}

function normalizeAllowedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw stableError(CODES.origin);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw stableError(CODES.origin);
  }
  return url.origin;
}

function normalizeTargetUrl(
  value: string,
  allowedOrigin: string
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw stableError(CODES.target);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.origin !== allowedOrigin ||
    hasSensitiveQuery(url)
  ) {
    throw stableError(CODES.target);
  }
  url.hash = "";
  return url.toString();
}

export type StageBrowserRequestPolicyInput = {
  url: string;
  method: string;
  allowedOrigin: string;
  resourceType?: string;
  isNavigationRequest?: boolean;
};

function normalizedResourceType(value: string | undefined): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function requestViolationCode(
  input: StageBrowserRequestPolicyInput
): StageBrowserViolationCode | null {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return "invalid_url";
  }
  if (url.protocol !== "https:") return "https_required";
  if (url.username !== "" || url.password !== "") {
    return "embedded_credentials_forbidden";
  }
  if (hasSensitiveQuery(url)) {
    const method = input.method.toUpperCase();
    const canContinueCredentialedRead =
      url.origin === input.allowedOrigin &&
      input.isNavigationRequest === false &&
      BACKGROUND_READ_RESOURCE_TYPES.has(
        normalizedResourceType(input.resourceType)
      ) &&
      READ_METHODS.has(method) &&
      !hasSensitivePath(url);
    if (!canContinueCredentialedRead) {
      return "sensitive_query_forbidden";
    }
  }
  if (url.origin !== input.allowedOrigin) return "origin_not_allowed";
  if (hasSensitivePath(url)) return "sensitive_path_forbidden";
  if (!READ_METHODS.has(input.method.toUpperCase())) {
    return "method_not_allowed";
  }
  return null;
}

export type StageBrowserRequestDecision =
  | { action: "allow" }
  | { action: "abort"; code: StageBrowserViolationCode };

export function decideCmoocQuillStageBrowserRequest(input: {
  url: string;
  method: string;
  allowedOrigin: string;
  resourceType?: string;
  isNavigationRequest?: boolean;
}): StageBrowserRequestDecision {
  const code = requestViolationCode(input);
  return code ? { action: "abort", code } : { action: "allow" };
}

/**
 * Identifies background requests that are expected to be blocked during STAGE
 * startup, but whose absence is not a fatal guard violation.  The helper is
 * deliberately structural: it never reads a request body and returns no URL
 * or query data.
 */
export function isExpectedBlockedBackgroundRequest(
  input: StageBrowserRequestPolicyInput
): boolean {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    input.isNavigationRequest !== false
  ) {
    return false;
  }

  const resourceType = normalizedResourceType(input.resourceType);
  const method = input.method.toUpperCase();
  if (
    url.origin === input.allowedOrigin &&
    BACKGROUND_READ_RESOURCE_TYPES.has(resourceType) &&
    method === "POST" &&
    EXPECTED_COMMENT_LIST_PATHS.has(url.pathname)
  ) {
    return true;
  }
  return (
    url.origin !== input.allowedOrigin &&
    resourceType === "image" &&
    (method === "GET" || method === "HEAD")
  );
}

function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

type GuardState = {
  allowedRequestCount: number;
  blockedRequestCount: number;
  blockedWebSocketCount: number;
  blockedDownloadCount: number;
  violationCodes: StageBrowserViolationCode[];
};

function createGuardState(): GuardState {
  return {
    allowedRequestCount: 0,
    blockedRequestCount: 0,
    blockedWebSocketCount: 0,
    blockedDownloadCount: 0,
    violationCodes: []
  };
}

function recordViolation(
  state: GuardState,
  code: StageBrowserViolationCode
): void {
  state.violationCodes.push(code);
}

function assertTimeout(value: unknown, code: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw stableError(code);
  }
}

async function closeWithDeadline(
  close: () => Promise<void>,
  timeoutMs = RESOURCE_CLOSE_TIMEOUT_MS
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(close),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
      })
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type StageBrowserEditorReadinessStatus =
  | "waiting"
  | "ready"
  | "multiple"
  | "target_mismatch";

type StageBrowserEditorReadinessProbeInput = {
  marker: string;
  expectedOrigin: string;
  expectedTargetUrl: string;
  editorSelector: string;
};

type StageBrowserEditorReadinessProbeResult = {
  status: StageBrowserEditorReadinessStatus;
};

/**
 * This function is serialized into the page for a structural-only readiness
 * check. It deliberately returns an enum and never reads editor text, HTML, or
 * any other page content.
 */
export function probeCmoocQuillStageEditorReadiness(
  input: StageBrowserEditorReadinessProbeInput
): StageBrowserEditorReadinessProbeResult {
  if (input.marker !== "cmooc-quill-stage-editor-readiness-v1") {
    return { status: "target_mismatch" };
  }
  let currentUrl: URL;
  let expectedUrl: URL;
  try {
    currentUrl = new URL(location.href);
    currentUrl.hash = "";
    expectedUrl = new URL(input.expectedTargetUrl);
    expectedUrl.hash = "";
  } catch {
    return { status: "target_mismatch" };
  }
  if (
    location.origin !== input.expectedOrigin ||
    currentUrl.toString() !== expectedUrl.toString()
  ) {
    return { status: "target_mismatch" };
  }
  const editors = document.querySelectorAll(input.editorSelector);
  let editorCount = 0;
  for (let index = 0; index < editors.length; index += 1) {
    const editor = editors[index];
    if (!editor || !editor.isConnected) continue;
    const style = getComputedStyle(editor);
    const rect = editor.getBoundingClientRect();
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      continue;
    }
    editorCount += 1;
    if (editorCount > 1) return { status: "multiple" };
  }
  if (!["interactive", "complete"].includes(document.readyState)) {
    return { status: "waiting" };
  }
  return { status: editorCount === 1 ? "ready" : "waiting" };
}

function isEditorReadinessResult(
  value: unknown
): value is StageBrowserEditorReadinessProbeResult {
  if (typeof value !== "object" || value === null) return false;
  const status = (value as { status?: unknown }).status;
  return (
    status === "waiting" ||
    status === "ready" ||
    status === "multiple" ||
    status === "target_mismatch"
  );
}

async function waitForCmoocQuillStageEditorReadiness(input: {
  page: StageBrowserPage;
  state: GuardState;
  allowedOrigin: string;
  targetUrl: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline =
    Date.now() + Math.min(EDITOR_READINESS_TIMEOUT_MS, input.timeoutMs);
  while (true) {
    if (input.state.violationCodes.length > 0) {
      throw stableError(CODES.network);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw stableError(CODES.editorReadinessTimeout);
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let result: unknown;
    try {
      result = await Promise.race([
        input.page.evaluate(
          probeCmoocQuillStageEditorReadiness,
          {
            marker: EDITOR_READINESS_ARGUMENT_MARKER,
            expectedOrigin: input.allowedOrigin,
            expectedTargetUrl: input.targetUrl,
            editorSelector: EDITOR_SELECTOR
          }
        ),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(stableError(CODES.editorReadinessTimeout));
          }, remainingMs);
        })
      ]);
    } catch (error) {
      if (input.state.violationCodes.length > 0) {
        throw stableError(CODES.network);
      }
      if (
        error instanceof Error &&
        error.message === CODES.editorReadinessTimeout
      ) {
        throw error;
      }
      throw stableError(CODES.editorReadiness);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
    if (input.state.violationCodes.length > 0) {
      throw stableError(CODES.network);
    }
    if (!isEditorReadinessResult(result)) {
      throw stableError(CODES.editorReadiness);
    }
    if (result.status === "ready") return;
    if (result.status === "multiple") {
      throw stableError(CODES.editorNotUnique);
    }
    if (result.status === "target_mismatch") {
      throw stableError(CODES.targetMismatch);
    }
    const sleepMs = Math.min(
      EDITOR_READINESS_POLL_INTERVAL_MS,
      deadline - Date.now()
    );
    if (sleepMs <= 0) {
      throw stableError(CODES.editorReadinessTimeout);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, sleepMs);
    });
  }
}

function adaptPage(page: Page): StageBrowserPage {
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
    url: () => page.url(),
    evaluate: async (pageFunction, argument) =>
      (await page.evaluate(
        pageFunction as never,
        argument as never
      )) as never,
    on: (event, listener) => {
      page.on(event, (download) => {
        listener({
          cancel: () => download.cancel()
        });
      });
    },
    close: () => page.close()
  };
}

function adaptContext(context: BrowserContext): StageBrowserContext {
  return {
    route: (pattern, handler) =>
      context
        .route(pattern, (route: Route, request: Request) =>
          handler(
            {
              abort: (errorCode) => route.abort(errorCode),
              continue: () => route.continue()
            },
            {
              method: () => request.method(),
              url: () => request.url(),
              resourceType: () => request.resourceType(),
              isNavigationRequest: () => request.isNavigationRequest()
            }
          )
        )
        .then(() => undefined),
    routeWebSocket: (pattern, handler) =>
      context
        .routeWebSocket(pattern, (route: WebSocketRoute) =>
          handler({
            close: (options) => route.close(options)
          })
        )
        .then(() => undefined),
    newPage: async () => adaptPage(await context.newPage()),
    close: () => context.close()
  };
}

function adaptBrowser(browser: Browser): StageBrowserBrowser {
  return {
    newContext: async (options) =>
      adaptContext(
        await browser.newContext(options)
      ),
    close: () => browser.close()
  };
}

const DEFAULT_DRIVER: StageBrowserDriver = {
  launch: async (options) =>
    adaptBrowser(await chromium.launch(options))
};

export class PlaywrightCmoocQuillStageBrowserBridge
  implements CmoocQuillStageBrowserBridge
{
  readonly #page: StageBrowserPage;
  readonly #context: StageBrowserContext;
  readonly #browser: StageBrowserBrowser;
  readonly #state: GuardState;
  #closed = false;
  #closePromise: Promise<{
    failed: boolean;
    networkViolation: boolean;
  }> | null = null;

  constructor(input: {
    page: StageBrowserPage;
    context: StageBrowserContext;
    browser: StageBrowserBrowser;
    state: GuardState;
  }) {
    this.#page = input.page;
    this.#context = input.context;
    this.#browser = input.browser;
    this.#state = input.state;
  }

  auditSnapshot(): StageBrowserBridgeAudit {
    return {
      schemaVersion: CMOOC_QUILL_STAGE_BROWSER_BRIDGE_VERSION,
      networkEnabled: true,
      allowedOriginCount: 1,
      guardInstalled: true,
      pageCount: 1,
      allowedRequestCount: this.#state.allowedRequestCount,
      blockedRequestCount: this.#state.blockedRequestCount,
      blockedWebSocketCount: this.#state.blockedWebSocketCount,
      blockedDownloadCount: this.#state.blockedDownloadCount,
      sentMutationCount: 0,
      violationCodes: [...this.#state.violationCodes],
      containsForumText: false
    };
  }

  async evaluate<Result, Argument>(
    pageFunction: (
      argument: Argument
    ) => Result | Promise<Result>,
    argument: Argument,
    options: StageBrowserEvaluateOptions
  ): Promise<Result> {
    if (this.#closed) throw stableError(CODES.closed);
    assertTimeout(options?.timeoutMs, CODES.evaluateOptions);
    if (this.#state.violationCodes.length > 0) {
      throw stableError(CODES.network);
    }

    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const evaluation = this.#page.evaluate(pageFunction, argument);
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          reject(stableError(CODES.evaluateTimeout));
        }, options.timeoutMs);
      });
      const result = await Promise.race([evaluation, timeout]);
      if (this.#state.violationCodes.length > 0) {
        throw stableError(CODES.network);
      }
      return result as Result;
    } catch (error) {
      if (timedOut || (error instanceof Error && error.message === CODES.evaluateTimeout)) {
        // Playwright cannot cancel an in-flight page.evaluate.  Closing all
        // owned browser resources before returning the timeout code prevents a
        // late DOM mutation from continuing after the STAGE caller has entered
        // its recovery path.
        await this.#closeInternal();
        throw stableError(CODES.evaluateTimeout);
      }
      if (this.#state.violationCodes.length > 0) {
        throw stableError(CODES.network);
      }
      if (error instanceof Error && isStableCode(error.message)) {
        throw error;
      }
      throw stableError(CODES.evaluate);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  async close(): Promise<void> {
    const result = await this.#closeInternal();
    if (result.networkViolation) {
      throw stableError(CODES.network);
    }
    if (result.failed) throw stableError(CODES.close);
  }

  async #closeInternal(): Promise<{
    failed: boolean;
    networkViolation: boolean;
  }> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      let failed = false;
      if (!(await closeWithDeadline(() => this.#page.close()))) {
        failed = true;
      }
      if (!(await closeWithDeadline(() => this.#context.close()))) {
        failed = true;
      }
      if (!(await closeWithDeadline(() => this.#browser.close()))) {
        failed = true;
      }
      return {
        failed,
        networkViolation: this.#state.violationCodes.length > 0
      };
    })();
    return this.#closePromise;
  }
}

export async function openCmoocQuillStageBrowserBridge(
  input: CmoocQuillStageBrowserBridgeOptions
): Promise<PlaywrightCmoocQuillStageBrowserBridge> {
  if (!input || typeof input !== "object") {
    throw stableError(CODES.options);
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertTimeout(timeoutMs, CODES.options);
  if (typeof input.storageStatePath === "string") {
    if (
      input.storageStatePath.trim() === "" ||
      !existsSync(input.storageStatePath)
    ) {
      throw stableError(CODES.authState);
    }
  }
  if (typeof input.storageStatePath !== "undefined" && typeof input.storageStatePath !== "string") {
    throw stableError(CODES.options);
  }
  const allowedOrigin = normalizeAllowedOrigin(input.allowedOrigin);
  const targetUrl = normalizeTargetUrl(input.targetUrl, allowedOrigin);
  const driver = input.driver ?? DEFAULT_DRIVER;
  const state = createGuardState();

  let browser: StageBrowserBrowser | null = null;
  let context: StageBrowserContext | null = null;
  let page: StageBrowserPage | null = null;
  let phase: "launch" | "context" | "guard" | "page" | "navigation" = "launch";
  try {
    browser = await driver.launch({ headless: true });
    phase = "context";
    const contextOptions: {
      serviceWorkers: "block";
      acceptDownloads: false;
      storageState?: string;
    } = {
      serviceWorkers: "block",
      acceptDownloads: false
    };
    if (input.storageStatePath !== undefined) {
      contextOptions.storageState = input.storageStatePath;
    }
    context = await browser.newContext(contextOptions);

    // Both guards are installed before creating a page, so no initial page
    // request can bypass the read-only policy.
    phase = "guard";
    await context.route("**/*", async (route, request) => {
      const requestInput: StageBrowserRequestPolicyInput = {
        url: request.url(),
        method: request.method(),
        allowedOrigin,
        resourceType: request.resourceType?.(),
        isNavigationRequest: request.isNavigationRequest?.()
      };
      if (isExpectedBlockedBackgroundRequest(requestInput)) {
        state.blockedRequestCount += 1;
        await route.abort("blockedbyclient");
        return;
      }
      let decision: StageBrowserRequestDecision;
      try {
        decision = decideCmoocQuillStageBrowserRequest(requestInput);
      } catch {
        decision = {
          action: "abort",
          code: "invalid_url"
        };
      }
      if (decision.action === "abort") {
        state.blockedRequestCount += 1;
        recordViolation(state, decision.code);
        await route.abort("blockedbyclient");
        return;
      }
      state.allowedRequestCount += 1;
      await route.continue();
    });
    await context.routeWebSocket(/.*/, async (route) => {
      state.blockedWebSocketCount += 1;
      recordViolation(state, "websocket_forbidden");
      await route.close({
        code: 1008,
        reason: "cMOOC STAGE browser is read-only"
      });
    });

    phase = "page";
    page = await context.newPage();
    page.on("download", (download) => {
      state.blockedDownloadCount += 1;
      recordViolation(state, "download_forbidden");
      void download.cancel().catch(() => undefined);
    });

    phase = "navigation";
    const response = await page.goto(targetUrl, {
      waitUntil: "load",
      timeout: timeoutMs
    });
    if (!response || response.ok() !== true) {
      throw stableError(CODES.navigation);
    }
    const finalUrl = normalizedUrl(page.url());
    if (finalUrl !== targetUrl) {
      throw stableError(CODES.targetMismatch);
    }
    if (state.violationCodes.length > 0) {
      throw stableError(CODES.network);
    }
    await waitForCmoocQuillStageEditorReadiness({
      page,
      state,
      allowedOrigin,
      targetUrl,
      timeoutMs
    });
    if (state.violationCodes.length > 0) {
      throw stableError(CODES.network);
    }
    return new PlaywrightCmoocQuillStageBrowserBridge({
      page,
      context,
      browser,
      state
    });
  } catch (error) {
    const code =
      error instanceof Error && isStableCode(error.message)
        ? error.message
        : phase === "launch"
          ? CODES.launch
          : phase === "context"
            ? CODES.context
            : phase === "guard"
              ? CODES.guard
              : phase === "page"
                ? CODES.context
                : CODES.navigation;
    if (page) await closeWithDeadline(() => page!.close());
    if (context) await closeWithDeadline(() => context!.close());
    if (browser) await closeWithDeadline(() => browser!.close());
    throw stableError(code);
  }
}

export const createCmoocQuillStageBrowserBridge =
  openCmoocQuillStageBrowserBridge;
