import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import {
  CMOOC_QUILL_STAGE_BROWSER_BRIDGE_VERSION,
  decideCmoocQuillStageBrowserRequest,
  isExpectedBlockedBackgroundRequest,
  openCmoocQuillStageBrowserBridge,
  probeCmoocQuillStageEditorReadiness,
  type StageBrowserBridgeAudit,
  type StageBrowserBrowser,
  type StageBrowserContext,
  type StageBrowserDriver,
  type StageBrowserDownload,
  type StageBrowserPage,
  type StageBrowserRequest,
  type StageBrowserRoute,
  type StageBrowserWebSocketRoute
} from "../../lib/live-runtime/cmooc-quill-stage-browser-bridge";

const TARGET_URL =
  "https://forum.example.test/cMOOC/detail?id=thread-001&type=SKETCH";
const ORIGIN = "https://forum.example.test";
const DRIFTED_TARGET_URL =
  `${ORIGIN}/cMOOC/other?access_token=redacted`;
const READINESS_ARGUMENT_MARKER =
  "cmooc-quill-stage-editor-readiness-v1";
type FakeReadinessStatus =
  | "waiting"
  | "ready"
  | "multiple"
  | "target_mismatch";

function isReadinessArgument(value: unknown): value is {
  marker: typeof READINESS_ARGUMENT_MARKER;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "marker" in value &&
    (value as { marker?: unknown }).marker ===
      READINESS_ARGUMENT_MARKER
  );
}

class FakeRoute implements StageBrowserRoute {
  action: "abort" | "continue" | null = null;

  async abort(): Promise<void> {
    this.action = "abort";
  }

  async continue(): Promise<void> {
    this.action = "continue";
  }
}

class FakeRequest implements StageBrowserRequest {
  constructor(
    private readonly requestUrl: string,
    private readonly requestMethod: string,
    private readonly requestResourceType = "",
    private readonly navigationRequest = false
  ) {}

  method(): string {
    return this.requestMethod;
  }

  url(): string {
    return this.requestUrl;
  }

  resourceType(): string {
    return this.requestResourceType;
  }

  isNavigationRequest(): boolean {
    return this.navigationRequest;
  }
}

class FakeWebSocketRoute implements StageBrowserWebSocketRoute {
  options: { code: number; reason: string } | null = null;

  async close(options: { code: number; reason: string }): Promise<void> {
    this.options = options;
  }
}

class FakeDownload implements StageBrowserDownload {
  cancelled = false;

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

class FakePage implements StageBrowserPage {
  readonly events: string[] = [];
  readonly downloads: FakeDownload[] = [];
  readonly readinessArguments: unknown[] = [];
  readonly readinessSources: string[] = [];
  readinessProbeCount = 0;
  #url = TARGET_URL;
  #downloadListener: ((download: StageBrowserDownload) => void) | null = null;
  #evaluate: StageBrowserPage["evaluate"];
  closed = false;

  constructor(
    private readonly context: FakeContext,
    evaluate?: StageBrowserPage["evaluate"],
    private readonly failGoto = false,
    private readonly readinessResults: readonly FakeReadinessStatus[] = [
      "ready"
    ]
  ) {
    this.#evaluate = async (pageFunction, argument) => {
      if (isReadinessArgument(argument)) {
        this.readinessArguments.push(argument);
        this.readinessSources.push(String(pageFunction));
        const index = Math.min(
          this.readinessProbeCount,
          Math.max(this.readinessResults.length - 1, 0)
        );
        this.readinessProbeCount += 1;
        const status =
          this.readinessResults[index] ?? "ready";
        if (status === "target_mismatch") {
          this.#url = DRIFTED_TARGET_URL;
        }
        return {
          status
        } as never;
      }
      if (evaluate) return evaluate(pageFunction, argument);
      return { ok: true } as never;
    };
  }

  async goto(
    _url: string,
    _options: { waitUntil: "load"; timeout: number }
  ): Promise<{ ok(): boolean; status(): number } | null> {
    this.events.push("goto");
    if (this.failGoto) throw new Error("raw navigation error");
    await this.context.dispatchRequest(TARGET_URL, "GET", {
      resourceType: "document",
      isNavigationRequest: true
    });
    return { ok: () => true, status: () => 200 };
  }

  url(): string {
    return this.#url;
  }

  setUrl(value: string): void {
    this.#url = value;
  }

  evaluate<Result, Argument>(
    pageFunction: (argument: Argument) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result> {
    return this.#evaluate(pageFunction, argument);
  }

  on(
    event: "download",
    listener: (download: StageBrowserDownload) => void
  ): void {
    assert.equal(event, "download");
    this.events.push("download");
    this.#downloadListener = listener;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.events.push("page-close");
  }

  emitDownload(): FakeDownload {
    const download = new FakeDownload();
    this.downloads.push(download);
    this.#downloadListener?.(download);
    return download;
  }
}

class FakeContext implements StageBrowserContext {
  readonly events: string[] = [];
  readonly routes: FakeRoute[] = [];
  readonly webSockets: FakeWebSocketRoute[] = [];
  requestHandler:
    | ((route: StageBrowserRoute, request: StageBrowserRequest) => Promise<void>)
    | null = null;
  webSocketHandler:
    | ((route: StageBrowserWebSocketRoute) => Promise<void>)
    | null = null;
  newPageCount = 0;
  closed = false;
  readonly contextOptions: {
    serviceWorkers: "block";
    acceptDownloads: false;
    storageState?: string;
  };
  page: FakePage;
  failNewPage = false;

  constructor(
    contextOptions: FakeContext["contextOptions"],
    evaluate?: StageBrowserPage["evaluate"],
    failGoto = false,
    readinessResults: readonly FakeReadinessStatus[] = ["ready"]
  ) {
    this.contextOptions = contextOptions;
    this.page = new FakePage(
      this,
      evaluate,
      failGoto,
      readinessResults
    );
  }

  async route(
    _pattern: string,
    handler: (
      route: StageBrowserRoute,
      request: StageBrowserRequest
    ) => Promise<void>
  ): Promise<void> {
    this.events.push("route");
    this.requestHandler = handler;
  }

  async routeWebSocket(
    _pattern: RegExp,
    handler: (route: StageBrowserWebSocketRoute) => Promise<void>
  ): Promise<void> {
    this.events.push("websocket-route");
    this.webSocketHandler = handler;
  }

  async newPage(): Promise<StageBrowserPage> {
    this.events.push("new-page");
    this.newPageCount += 1;
    if (this.failNewPage) throw new Error("raw page error");
    return this.page;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.events.push("context-close");
  }

  async dispatchRequest(
    url: string,
    method: string,
    options: {
      resourceType?: string;
      isNavigationRequest?: boolean;
    } = {}
  ): Promise<FakeRoute> {
    if (!this.requestHandler) throw new Error("REQUEST_GUARD_NOT_INSTALLED");
    const route = new FakeRoute();
    this.routes.push(route);
    await this.requestHandler(
      route,
      new FakeRequest(
        url,
        method,
        options.resourceType,
        options.isNavigationRequest
      )
    );
    return route;
  }

  async dispatchWebSocket(): Promise<FakeWebSocketRoute> {
    if (!this.webSocketHandler) throw new Error("WEBSOCKET_GUARD_NOT_INSTALLED");
    const route = new FakeWebSocketRoute();
    this.webSockets.push(route);
    await this.webSocketHandler(route);
    return route;
  }
}

class FakeBrowser implements StageBrowserBrowser {
  readonly contexts: FakeContext[] = [];
  closed = false;
  readonly events: string[] = [];
  readonly evaluate?: StageBrowserPage["evaluate"];
  readonly failGoto: boolean;
  readonly failNewPage: boolean;
  readonly readinessResults: readonly FakeReadinessStatus[];

  constructor(options: {
    evaluate?: StageBrowserPage["evaluate"];
    failGoto?: boolean;
    failNewPage?: boolean;
    readinessResults?: readonly FakeReadinessStatus[];
  } = {}) {
    this.evaluate = options.evaluate;
    this.failGoto = options.failGoto === true;
    this.failNewPage = options.failNewPage === true;
    this.readinessResults = options.readinessResults ?? ["ready"];
  }

  async newContext(options: FakeContext["contextOptions"]): Promise<StageBrowserContext> {
    this.events.push("new-context");
    const context = new FakeContext(
      options,
      this.evaluate,
      this.failGoto,
      this.readinessResults
    );
    context.failNewPage = this.failNewPage;
    this.contexts.push(context);
    return context;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.events.push("browser-close");
  }
}

class FakeDriver implements StageBrowserDriver {
  readonly browsers: FakeBrowser[] = [];
  constructor(
    private readonly options: ConstructorParameters<typeof FakeBrowser>[0] = {}
  ) {}

  async launch(): Promise<StageBrowserBrowser> {
    const browser = new FakeBrowser(this.options);
    this.browsers.push(browser);
    return browser;
  }
}

function audit(bridge: { auditSnapshot(): StageBrowserBridgeAudit }): StageBrowserBridgeAudit {
  return bridge.auditSnapshot();
}

test("factory installs guards before one page navigation and loads only a storage path", async () => {
  const driver = new FakeDriver();
  const bridge = await openCmoocQuillStageBrowserBridge({
    targetUrl: TARGET_URL,
    allowedOrigin: ORIGIN,
    storageStatePath: "package.json",
    driver,
    timeoutMs: 1_000
  });
  const browser = driver.browsers[0];
  assert.ok(browser);
  const context = browser.contexts[0] as FakeContext;
  assert.deepEqual(context.events.slice(0, 3), [
    "route",
    "websocket-route",
    "new-page"
  ]);
  assert.deepEqual(context.page.events.slice(0, 2), ["download", "goto"]);
  assert.equal(context.newPageCount, 1);
  assert.deepEqual(context.contextOptions, {
    serviceWorkers: "block",
    acceptDownloads: false,
    storageState: "package.json"
  });
  assert.deepEqual(
    await bridge.evaluate(() => ({ ok: true }), undefined, { timeoutMs: 1_000 }),
    { ok: true }
  );
  await bridge.close();
  await bridge.close();
  assert.equal(context.closed, true);
  assert.equal(browser.closed, true);
  await assert.rejects(
    () => bridge.evaluate(() => ({ ok: true }), undefined, { timeoutMs: 1_000 }),
    /^Error: CMOOC_QUILL_STAGE_BROWSER_BRIDGE_CLOSED$/
  );
});

test("structural readiness probe survives real local Chromium serialization", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<!doctype html><style>
        .comment_container #edit .ql-editor {
          display: block;
          width: 240px;
          height: 48px;
        }
      </style><div class="comment_container"><div id="edit"><div class="ql-editor"></div></div></div>`,
      { waitUntil: "load" }
    );
    const result = await page.evaluate(
      probeCmoocQuillStageEditorReadiness,
      {
        marker: READINESS_ARGUMENT_MARKER,
        expectedOrigin: "null",
        expectedTargetUrl: "about:blank",
        editorSelector: ".comment_container #edit .ql-editor"
      }
    );
    assert.deepEqual(result, { status: "ready" });
    assert.doesNotMatch(
      String(probeCmoocQuillStageEditorReadiness),
      /textContent|innerHTML|outerHTML|innerText|document\.body/
    );
    assert.equal(
      String(probeCmoocQuillStageEditorReadiness).includes("__name"),
      false
    );
    assert.equal(JSON.stringify(result).includes("token"), false);
    await page.close();
  } finally {
    await browser.close();
  }
});

test("factory waits for a delayed empty Quill editor with structural-only probes", async () => {
  const driver = new FakeDriver({
    readinessResults: ["waiting", "ready"]
  });
  const bridge = await openCmoocQuillStageBrowserBridge({
    targetUrl: TARGET_URL,
    allowedOrigin: ORIGIN,
    driver,
    timeoutMs: 500
  });
  const page = driver.browsers[0].contexts[0].page;
  assert.equal(page.readinessProbeCount, 2);
  assert.equal(
    JSON.stringify(page.readinessArguments).includes("token"),
    false
  );
  assert.doesNotMatch(
    page.readinessSources[0] ?? "",
    /textContent|innerHTML|outerHTML|innerText|document\.body/
  );
  await bridge.close();
});

test("factory times out a continuously absent editor and closes all resources", async () => {
  const driver = new FakeDriver({
    readinessResults: ["waiting"]
  });
  await assert.rejects(
    () =>
      openCmoocQuillStageBrowserBridge({
        targetUrl: TARGET_URL,
        allowedOrigin: ORIGIN,
        driver,
        timeoutMs: 50
      }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      assert.equal(
        message,
        "CMOOC_QUILL_STAGE_BROWSER_EDITOR_READINESS_TIMEOUT"
      );
      assert.equal(message.includes(TARGET_URL), false);
      assert.equal(message.includes("token"), false);
      return true;
    }
  );
  const browser = driver.browsers[0];
  assert.ok(browser);
  const context = browser.contexts[0] as FakeContext;
  assert.ok(context.page.readinessProbeCount >= 1);
  assert.equal(context.page.closed, true);
  assert.equal(context.closed, true);
  assert.equal(browser.closed, true);
});

test("factory fails closed immediately when multiple visible editors are present", async () => {
  const driver = new FakeDriver({
    readinessResults: ["multiple"]
  });
  await assert.rejects(
    () =>
      openCmoocQuillStageBrowserBridge({
        targetUrl: TARGET_URL,
        allowedOrigin: ORIGIN,
        driver,
        timeoutMs: 500
      }),
    /^Error: CMOOC_QUILL_STAGE_BROWSER_EDITOR_NOT_UNIQUE$/
  );
  const browser = driver.browsers[0];
  assert.ok(browser);
  const context = browser.contexts[0] as FakeContext;
  assert.equal(context.page.readinessProbeCount, 1);
  assert.equal(context.page.closed, true);
  assert.equal(context.closed, true);
  assert.equal(browser.closed, true);
});

test("factory rejects target URL drift discovered during readiness without exposing it", async () => {
  const driver = new FakeDriver({
    readinessResults: ["target_mismatch"]
  });
  await assert.rejects(
    () =>
      openCmoocQuillStageBrowserBridge({
        targetUrl: TARGET_URL,
        allowedOrigin: ORIGIN,
        driver,
        timeoutMs: 500
      }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      assert.equal(
        message,
        "CMOOC_QUILL_STAGE_BROWSER_TARGET_URL_MISMATCH"
      );
      assert.equal(message.includes(TARGET_URL), false);
      assert.equal(message.includes("token"), false);
      return true;
    }
  );
  const browser = driver.browsers[0];
  assert.ok(browser);
  const context = browser.contexts[0] as FakeContext;
  assert.equal(context.page.readinessProbeCount, 1);
  assert.equal(context.page.url(), DRIFTED_TARGET_URL);
  assert.equal(context.page.closed, true);
  assert.equal(context.closed, true);
  assert.equal(browser.closed, true);
});

test("request, WebSocket and download guards are fail-closed without exposing request data", async () => {
  const driver = new FakeDriver();
  const bridge = await openCmoocQuillStageBrowserBridge({
    targetUrl: TARGET_URL,
    allowedOrigin: ORIGIN,
    driver,
    timeoutMs: 1_000
  });
  const context = driver.browsers[0].contexts[0] as FakeContext;
  const allowedMethods = ["GET", "HEAD", "OPTIONS"];
  for (const method of allowedMethods) {
    const route = await context.dispatchRequest(
      `${ORIGIN}/safe?value=${method}`,
      method
    );
    assert.equal(route.action, "continue");
  }
  const blockedUrl = `${ORIGIN}/comment/commentModule?attempt=1`;
  const blocked = await context.dispatchRequest(blockedUrl, "POST");
  assert.equal(blocked.action, "abort");
  await assert.rejects(
    () => bridge.evaluate(() => ({ ok: true }), undefined, { timeoutMs: 1_000 }),
    (error: unknown) => {
      assert.equal(
        error instanceof Error ? error.message : "",
        "CMOOC_QUILL_STAGE_BROWSER_NETWORK_GUARD_VIOLATION"
      );
      assert.equal(
        String(error).includes(blockedUrl),
        false
      );
      return true;
    }
  );
  const websocket = await context.dispatchWebSocket();
  assert.equal(websocket.options?.code, 1008);
  const download = context.page.emitDownload();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(download.cancelled, true);
  const snapshot = audit(bridge);
  assert.equal(snapshot.schemaVersion, CMOOC_QUILL_STAGE_BROWSER_BRIDGE_VERSION);
  assert.equal(snapshot.sentMutationCount, 0);
  assert.equal(snapshot.containsForumText, false);
  assert.deepEqual(snapshot.violationCodes, [
    "method_not_allowed",
    "websocket_forbidden",
    "download_forbidden"
  ]);
  await assert.rejects(
    () => bridge.close(),
    /^Error: CMOOC_QUILL_STAGE_BROWSER_NETWORK_GUARD_VIOLATION$/
  );
});

test("URL and method policy rejects transport or credential escapes", () => {
  const cases = [
    {
      url: "http://forum.example.test/cMOOC/detail",
      method: "GET",
      code: "https_required"
    },
    {
      url: "https://user:password@forum.example.test/cMOOC/detail",
      method: "GET",
      code: "embedded_credentials_forbidden"
    },
    {
      url: "https://forum.example.test/cMOOC/detail?access_token=redacted",
      method: "GET",
      code: "sensitive_query_forbidden"
    },
    {
      url: "https://other.example.test/cMOOC/detail",
      method: "GET",
      code: "origin_not_allowed"
    },
    {
      url: `${ORIGIN}/api/logout`,
      method: "GET",
      code: "sensitive_path_forbidden"
    },
    {
      url: `${ORIGIN}/api/export/course`,
      method: "HEAD",
      code: "sensitive_path_forbidden"
    },
    {
      url: `${ORIGIN}/cMOOC/detail`,
      method: "PATCH",
      code: "method_not_allowed"
    }
  ] as const;
  for (const input of cases) {
    assert.deepEqual(
      decideCmoocQuillStageBrowserRequest({
        ...input,
        allowedOrigin: ORIGIN
      }),
      { action: "abort", code: input.code }
    );
  }
  assert.deepEqual(
    decideCmoocQuillStageBrowserRequest({
      url: `${ORIGIN}/cMOOC/detail?safe=1`,
      method: "OPTIONS",
      allowedOrigin: ORIGIN
    }),
    { action: "allow" }
  );
});

test("credentialed same-origin XHR/fetch reads with sensitive query are allowed only off navigation", () => {
  for (const resourceType of ["xhr", "fetch"] as const) {
    for (const method of ["GET", "HEAD", "OPTIONS"] as const) {
      assert.deepEqual(
        decideCmoocQuillStageBrowserRequest({
          url: `${ORIGIN}/cmooc-api/session?access_token=redacted`,
          method,
          allowedOrigin: ORIGIN,
          resourceType,
          isNavigationRequest: false
        }),
        { action: "allow" }
      );
    }
  }

  assert.deepEqual(
    decideCmoocQuillStageBrowserRequest({
      url: `${ORIGIN}/cMOOC/detail?access_token=redacted`,
      method: "GET",
      allowedOrigin: ORIGIN,
      resourceType: "document",
      isNavigationRequest: true
    }),
    { action: "abort", code: "sensitive_query_forbidden" }
  );
  assert.deepEqual(
    decideCmoocQuillStageBrowserRequest({
      url: "https://other.example.test/cmooc-api/session?access_token=redacted",
      method: "GET",
      allowedOrigin: ORIGIN,
      resourceType: "xhr",
      isNavigationRequest: false
    }),
    { action: "abort", code: "sensitive_query_forbidden" }
  );
  assert.deepEqual(
    decideCmoocQuillStageBrowserRequest({
      url: `${ORIGIN}/cmooc-api/session?access_token=redacted`,
      method: "GET",
      allowedOrigin: ORIGIN,
      resourceType: "image",
      isNavigationRequest: false
    }),
    { action: "abort", code: "sensitive_query_forbidden" }
  );
});

test("expected blocked background requests are a narrow pure classification", () => {
  for (const pathname of ["/cmooc-api/comment/list", "/comment/list"] as const) {
    assert.equal(
      isExpectedBlockedBackgroundRequest({
        url: `${ORIGIN}${pathname}?page=1`,
        method: "POST",
        allowedOrigin: ORIGIN,
        resourceType: "xhr",
        isNavigationRequest: false
      }),
      true
    );
  }
  assert.equal(
    isExpectedBlockedBackgroundRequest({
      url: "https://cdn.example.test/editor.png",
      method: "GET",
      allowedOrigin: ORIGIN,
      resourceType: "image",
      isNavigationRequest: false
    }),
    true
  );
  assert.equal(
    isExpectedBlockedBackgroundRequest({
      url: `${ORIGIN}/autosave`,
      method: "POST",
      allowedOrigin: ORIGIN,
      resourceType: "xhr",
      isNavigationRequest: false
    }),
    false
  );
  assert.equal(
    isExpectedBlockedBackgroundRequest({
      url: `${ORIGIN}/comment/list`,
      method: "POST",
      allowedOrigin: ORIGIN,
      resourceType: "xhr",
      isNavigationRequest: true
    }),
    false
  );
});

test("mixed guarded startup requests keep blocked background counts without failing STAGE", async () => {
  const driver = new FakeDriver();
  const bridge = await openCmoocQuillStageBrowserBridge({
    targetUrl: TARGET_URL,
    allowedOrigin: ORIGIN,
    driver,
    timeoutMs: 1_000
  });
  const context = driver.browsers[0].contexts[0] as FakeContext;
  for (const token of ["access_token", "Satoken"]) {
    const route = await context.dispatchRequest(
      `${ORIGIN}/cmooc-api/session?${token}=redacted`,
      "GET",
      { resourceType: "xhr", isNavigationRequest: false }
    );
    assert.equal(route.action, "continue");
  }
  const commentList = await context.dispatchRequest(
    `${ORIGIN}/cmooc-api/comment/list?page=1`,
    "POST",
    { resourceType: "xhr", isNavigationRequest: false }
  );
  assert.equal(commentList.action, "abort");
  const image = await context.dispatchRequest(
    "https://cdn.example.test/editor.png",
    "GET",
    { resourceType: "image", isNavigationRequest: false }
  );
  assert.equal(image.action, "abort");
  assert.deepEqual(
    audit(bridge).violationCodes,
    []
  );
  assert.equal(audit(bridge).blockedRequestCount, 2);
  assert.deepEqual(
    await bridge.evaluate(() => ({ ok: true }), undefined, {
      timeoutMs: 1_000
    }),
    { ok: true }
  );
  await bridge.close();
});

test("arbitrary mutation after startup remains a fatal network guard violation", async () => {
  const driver = new FakeDriver();
  const bridge = await openCmoocQuillStageBrowserBridge({
    targetUrl: TARGET_URL,
    allowedOrigin: ORIGIN,
    driver,
    timeoutMs: 1_000
  });
  const context = driver.browsers[0].contexts[0] as FakeContext;
  const mutation = await context.dispatchRequest(
    `${ORIGIN}/cmooc-api/comment/autosave`,
    "POST",
    { resourceType: "xhr", isNavigationRequest: false }
  );
  assert.equal(mutation.action, "abort");
  await assert.rejects(
    () => bridge.evaluate(() => ({ ok: true }), undefined, { timeoutMs: 1_000 }),
    /^Error: CMOOC_QUILL_STAGE_BROWSER_NETWORK_GUARD_VIOLATION$/
  );
  await assert.rejects(
    () => bridge.close(),
    /^Error: CMOOC_QUILL_STAGE_BROWSER_NETWORK_GUARD_VIOLATION$/
  );
});

test("evaluate converts underlying errors and timeout into stable codes", async () => {
  const driver = new FakeDriver({
    evaluate: async () => {
      throw new Error("raw body and https://private.example.invalid");
    }
  });
  const bridge = await openCmoocQuillStageBrowserBridge({
    targetUrl: TARGET_URL,
    allowedOrigin: ORIGIN,
    driver,
    timeoutMs: 1_000
  });
  await assert.rejects(
    () => bridge.evaluate(() => ({ ok: true }), undefined, { timeoutMs: 1_000 }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      assert.equal(message, "CMOOC_QUILL_STAGE_BROWSER_EVALUATE_FAILED");
      assert.equal(message.includes("private.example"), false);
      return true;
    }
  );
  await bridge.close();

  const timeoutDriver = new FakeDriver({
    evaluate: () => new Promise(() => undefined)
  });
  const timeoutBridge = await openCmoocQuillStageBrowserBridge({
    targetUrl: TARGET_URL,
    allowedOrigin: ORIGIN,
    driver: timeoutDriver,
    timeoutMs: 20
  });
  await assert.rejects(
    () => timeoutBridge.evaluate(() => ({ ok: true }), undefined, { timeoutMs: 20 }),
    /^Error: CMOOC_QUILL_STAGE_BROWSER_EVALUATE_TIMEOUT$/
  );
  const timeoutBrowser = timeoutDriver.browsers[0];
  assert.ok(timeoutBrowser);
  const timeoutContext = timeoutBrowser.contexts[0] as FakeContext;
  assert.equal(timeoutContext.page.closed, true);
  assert.equal(timeoutContext.closed, true);
  assert.equal(timeoutBrowser.closed, true);
  await timeoutBridge.close();
});

test("close fails closed when a browser-level mutation was blocked", async () => {
  const driver = new FakeDriver();
  const bridge = await openCmoocQuillStageBrowserBridge({
    targetUrl: TARGET_URL,
    allowedOrigin: ORIGIN,
    driver,
    timeoutMs: 1_000
  });
  const context = driver.browsers[0].contexts[0] as FakeContext;
  const route = await context.dispatchRequest(
    `${ORIGIN}/comment/commentModule`,
    "POST"
  );
  assert.equal(route.action, "abort");
  await assert.rejects(
    () => bridge.close(),
    /^Error: CMOOC_QUILL_STAGE_BROWSER_NETWORK_GUARD_VIOLATION$/
  );
  assert.equal(context.page.closed, true);
  assert.equal(context.closed, true);
  assert.equal(driver.browsers[0].closed, true);
});

test("factory uses stable failures and cleans up a partially created browser session", async () => {
  const driver = new FakeDriver({ failGoto: true });
  await assert.rejects(
    () =>
      openCmoocQuillStageBrowserBridge({
        targetUrl: TARGET_URL,
        allowedOrigin: ORIGIN,
        driver,
        timeoutMs: 1_000
      }),
    /^Error: CMOOC_QUILL_STAGE_BROWSER_NAVIGATION_FAILED$/
  );
  const browser = driver.browsers[0];
  assert.ok(browser);
  const context = browser.contexts[0] as FakeContext;
  assert.equal(context.page.closed, true);
  assert.equal(context.closed, true);
  assert.equal(browser.closed, true);

  const missingDriver = new FakeDriver();
  await assert.rejects(
    () =>
      openCmoocQuillStageBrowserBridge({
        targetUrl: TARGET_URL,
        allowedOrigin: ORIGIN,
        storageStatePath: "definitely-missing-auth-state.json",
        driver: missingDriver,
        timeoutMs: 1_000
      }),
    /^Error: CMOOC_QUILL_STAGE_BROWSER_AUTH_STATE_MISSING$/
  );
  assert.equal(missingDriver.browsers.length, 0);
});
