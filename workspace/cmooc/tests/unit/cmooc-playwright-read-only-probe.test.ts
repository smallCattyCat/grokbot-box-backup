import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CmoocPlaywrightReadOnlyProbe,
  decideReadOnlyPlaywrightRequest,
  type CmoocPlaywrightReadOnlyProbeOptions,
  type ReadOnlyPlaywrightBrowser,
  type ReadOnlyPlaywrightContext,
  type ReadOnlyPlaywrightDownload,
  type ReadOnlyPlaywrightDriver,
  type ReadOnlyPlaywrightLocator,
  type ReadOnlyPlaywrightNavigationResponse,
  type ReadOnlyPlaywrightPage,
  type ReadOnlyPlaywrightRequest,
  type ReadOnlyPlaywrightRoute,
  type ReadOnlyPlaywrightWebSocketRoute
} from "../../lib/forum-adapters/cmooc-playwright-read-only-probe";

const ORIGIN = "https://forum.example.test";
const AUTH_URL = `${ORIGIN}/cMOOC/auth`;
const LIST_URL = `${ORIGIN}/cMOOC/course?courseId=course-001`;
const THREAD_REF = "123456789012345678";
const COMMENT_REF = "987654321012345678";
const THREAD_URL =
  `${ORIGIN}/cMOOC/detail?id=${THREAD_REF}&type=SKETCH`;

const SELECTORS = {
  readableRoot: "readable",
  authenticatedMarker: "authenticated",
  unauthenticatedMarker: "unauthenticated",
  threadLinks: "thread-links",
  threadCardAncestor: "thread-card",
  threadCardTime: "thread-time",
  detailRoot: "detail-root",
  detailTitle: "detail-title",
  detailContent: "detail-content",
  detailTime: "detail-time",
  documentTitle: "document-title",
  commentItems: "comments",
  commentContent: "comment-content",
  commentTime: "comment-time"
} as const;

type FakeNode = {
  text?: string;
  attributes?: Record<string, string>;
  children?: Record<string, FakeNode[]>;
};

class FakeLocator implements ReadOnlyPlaywrightLocator {
  readonly #nodes: FakeNode[];

  constructor(nodes: FakeNode[]) {
    this.#nodes = nodes;
  }

  async count(): Promise<number> {
    return this.#nodes.length;
  }

  first(): ReadOnlyPlaywrightLocator {
    return new FakeLocator(this.#nodes.slice(0, 1));
  }

  nth(index: number): ReadOnlyPlaywrightLocator {
    const node = this.#nodes[index];
    return new FakeLocator(node ? [node] : []);
  }

  locator(selector: string): ReadOnlyPlaywrightLocator {
    return new FakeLocator(
      this.#nodes.flatMap(
        (node) => node.children?.[selector] ?? []
      )
    );
  }

  async getAttribute(name: string): Promise<string | null> {
    return this.#nodes[0]?.attributes?.[name] ?? null;
  }

  async innerText(): Promise<string> {
    const node = this.#nodes[0];
    if (!node) {
      throw new Error("FAKE_LOCATOR_NOT_FOUND");
    }
    return node.text ?? "";
  }
}

class FakeRoute implements ReadOnlyPlaywrightRoute {
  aborted = false;
  continued = false;

  async abort(): Promise<void> {
    this.aborted = true;
  }

  async continue(): Promise<void> {
    this.continued = true;
  }
}

class FakeRequest implements ReadOnlyPlaywrightRequest {
  constructor(
    readonly requestUrl: string,
    readonly requestMethod: string
  ) {}

  method(): string {
    return this.requestMethod;
  }

  url(): string {
    return this.requestUrl;
  }
}

class FakeWebSocketRoute
  implements ReadOnlyPlaywrightWebSocketRoute
{
  closed = false;

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeDownload implements ReadOnlyPlaywrightDownload {
  cancelled = false;

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

type FakeDriverConfig = {
  root: FakeNode;
  backgroundRequests?: Array<{
    url: string;
    method: string;
  }>;
  openWebSocket?: boolean;
  startDownload?: boolean;
  responseStatus?: number;
};

class FakePage implements ReadOnlyPlaywrightPage {
  readonly #context: FakeContext;
  readonly #root: FakeNode;
  readonly #config: FakeDriverConfig;
  #url = "about:blank";
  #downloadListener:
    | ((download: ReadOnlyPlaywrightDownload) => void)
    | undefined;

  constructor(
    context: FakeContext,
    config: FakeDriverConfig
  ) {
    this.#context = context;
    this.#root = config.root;
    this.#config = config;
  }

  async goto(
    url: string
  ): Promise<ReadOnlyPlaywrightNavigationResponse> {
    this.#context.events.push("goto");
    this.#url = url;
    await this.#context.dispatchRequest(url, "GET");
    for (const request of this.#config.backgroundRequests ?? []) {
      await this.#context.dispatchRequest(
        request.url,
        request.method
      );
    }
    if (this.#config.openWebSocket) {
      await this.#context.dispatchWebSocket();
    }
    if (this.#config.startDownload && this.#downloadListener) {
      const download = new FakeDownload();
      this.#context.downloads.push(download);
      this.#downloadListener(download);
    }
    const status = this.#config.responseStatus ?? 200;
    return {
      ok: () => status >= 200 && status < 400,
      status: () => status
    };
  }

  locator(selector: string): ReadOnlyPlaywrightLocator {
    return new FakeLocator(this.#root.children?.[selector] ?? []);
  }

  currentUrl(): string {
    return this.#url;
  }

  onDownload(
    listener: (download: ReadOnlyPlaywrightDownload) => void
  ): void {
    this.#context.events.push("download-guard");
    this.#downloadListener = listener;
  }
}

class FakeContext implements ReadOnlyPlaywrightContext {
  readonly events: string[] = [];
  readonly routes: FakeRoute[] = [];
  readonly webSockets: FakeWebSocketRoute[] = [];
  readonly downloads: FakeDownload[] = [];
  readonly config: FakeDriverConfig;
  closed = false;
  requestHandler:
    | ((
        route: ReadOnlyPlaywrightRoute,
        request: ReadOnlyPlaywrightRequest
      ) => Promise<void>)
    | undefined;
  webSocketHandler:
    | ((
        route: ReadOnlyPlaywrightWebSocketRoute
      ) => Promise<void>)
    | undefined;

  constructor(config: FakeDriverConfig) {
    this.config = config;
  }

  async interceptRequests(
    handler: (
      route: ReadOnlyPlaywrightRoute,
      request: ReadOnlyPlaywrightRequest
    ) => Promise<void>
  ): Promise<void> {
    this.events.push("request-guard");
    this.requestHandler = handler;
  }

  async interceptWebSockets(
    handler: (
      route: ReadOnlyPlaywrightWebSocketRoute
    ) => Promise<void>
  ): Promise<void> {
    this.events.push("websocket-guard");
    this.webSocketHandler = handler;
  }

  async newPage(): Promise<ReadOnlyPlaywrightPage> {
    this.events.push("new-page");
    return new FakePage(this, this.config);
  }

  async dispatchRequest(
    url: string,
    method: string
  ): Promise<FakeRoute> {
    assert.ok(this.requestHandler);
    const route = new FakeRoute();
    this.routes.push(route);
    await this.requestHandler(
      route,
      new FakeRequest(url, method)
    );
    return route;
  }

  async dispatchWebSocket(): Promise<void> {
    assert.ok(this.webSocketHandler);
    const route = new FakeWebSocketRoute();
    this.webSockets.push(route);
    await this.webSocketHandler(route);
  }

  async close(): Promise<void> {
    this.events.push("context-close");
    this.closed = true;
  }
}

class FakeBrowser implements ReadOnlyPlaywrightBrowser {
  readonly contexts: FakeContext[] = [];
  readonly contextOptions: Array<{
    serviceWorkers: "block";
    acceptDownloads: false;
  }> = [];
  readonly #config: FakeDriverConfig;
  closed = false;

  constructor(config: FakeDriverConfig) {
    this.#config = config;
  }

  async newContext(options: {
    serviceWorkers: "block";
    acceptDownloads: false;
  }): Promise<ReadOnlyPlaywrightContext> {
    this.contextOptions.push(options);
    const context = new FakeContext(this.#config);
    this.contexts.push(context);
    return context;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeDriver implements ReadOnlyPlaywrightDriver {
  readonly browsers: FakeBrowser[] = [];
  readonly #config: FakeDriverConfig;
  launchCount = 0;

  constructor(config: FakeDriverConfig) {
    this.#config = config;
  }

  async launch(): Promise<ReadOnlyPlaywrightBrowser> {
    this.launchCount += 1;
    const browser = new FakeBrowser(this.#config);
    this.browsers.push(browser);
    return browser;
  }
}

function syntheticRoot(): FakeNode {
  const timeNode: FakeNode = {
    attributes: {
      datetime: "2026-01-01T00:00:00.000Z"
    }
  };
  const card: FakeNode = {
    text: "SECRET_CARD_STATE replies: 1",
    attributes: { "data-reply-count": "1" },
    children: {
      [SELECTORS.threadCardTime]: [timeNode]
    }
  };
  const link: FakeNode = {
    text: "SECRET_THREAD_TITLE",
    attributes: { href: THREAD_URL },
    children: {
      [SELECTORS.threadCardAncestor]: [card]
    }
  };
  const comment: FakeNode = {
    attributes: {
      "data-comment-id": COMMENT_REF,
      "data-author-id": "author-comment-001"
    },
    children: {
      [SELECTORS.commentContent]: [
        { text: "SECRET_COMMENT_BODY" }
      ],
      [SELECTORS.commentTime]: [timeNode]
    }
  };
  return {
    children: {
      [SELECTORS.readableRoot]: [{}],
      [SELECTORS.authenticatedMarker]: [{}],
      [SELECTORS.unauthenticatedMarker]: [],
      [SELECTORS.threadLinks]: [link],
      [SELECTORS.detailRoot]: [
        {
          attributes: {
            "data-author-id": "author-thread-001",
            "data-created-at": "2025-12-31T23:00:00.000Z"
          }
        }
      ],
      [SELECTORS.detailTitle]: [
        { text: "SECRET_THREAD_TITLE" }
      ],
      [SELECTORS.detailContent]: [
        { text: "SECRET_THREAD_BODY" }
      ],
      [SELECTORS.detailTime]: [timeNode],
      [SELECTORS.documentTitle]: [
        { text: "SECRET_DOCUMENT_TITLE" }
      ],
      [SELECTORS.commentItems]: [comment]
    }
  };
}

function probeOptions(
  driver: ReadOnlyPlaywrightDriver,
  networkEnabled = true
): CmoocPlaywrightReadOnlyProbeOptions {
  return {
    allowedOrigins: [ORIGIN],
    authCheckUrl: AUTH_URL,
    networkEnabled,
    timeoutMs: 1_000,
    driver,
    selectors: SELECTORS
  };
}

test("纯请求策略只允许显式 HTTPS origin 的 GET/HEAD", () => {
  for (const method of ["GET", "HEAD", "get"]) {
    assert.deepEqual(
      decideReadOnlyPlaywrightRequest({
        url: `${ORIGIN}/resource`,
        method,
        allowedOrigins: [ORIGIN]
      }),
      { action: "allow" }
    );
  }
  const cases = [
    {
      url: `${ORIGIN}/resource`,
      method: "POST",
      code: "method_not_allowed"
    },
    {
      url: "http://forum.example.test/resource",
      method: "GET",
      code: "https_required"
    },
    {
      url: "https://other.example.test/resource",
      method: "GET",
      code: "origin_not_allowed"
    },
    {
      url: "https://user:password@forum.example.test/resource",
      method: "GET",
      code: "embedded_credentials_forbidden"
    },
    {
      url: `${ORIGIN}/resource?access_token=secret`,
      method: "GET",
      code: "sensitive_query_forbidden"
    },
    {
      url: `${ORIGIN}/resource?x_auth_token=secret`,
      method: "GET",
      code: "sensitive_query_forbidden"
    },
    {
      url: `${ORIGIN}/resource?my_token=secret`,
      method: "GET",
      code: "sensitive_query_forbidden"
    },
    {
      url: `${ORIGIN}/resource?api_key=secret`,
      method: "GET",
      code: "sensitive_query_forbidden"
    },
    {
      url: "not-a-url",
      method: "GET",
      code: "invalid_url"
    }
  ];
  for (const candidate of cases) {
    assert.deepEqual(
      decideReadOnlyPlaywrightRequest({
        url: candidate.url,
        method: candidate.method,
        allowedOrigins: [ORIGIN]
      }),
      { action: "abort", code: candidate.code }
    );
  }
  assert.throws(
    () =>
      decideReadOnlyPlaywrightRequest({
        url: `${ORIGIN}/resource`,
        method: "GET",
        allowedOrigins: [`${ORIGIN}/not-an-origin`]
      }),
    /INVALID_READ_ONLY_ALLOWED_ORIGIN/
  );
});

test("默认网络关闭且不会启动浏览器驱动", async () => {
  const driver = new FakeDriver({ root: syntheticRoot() });
  const probe = new CmoocPlaywrightReadOnlyProbe(
    probeOptions(driver, false)
  );
  await assert.rejects(
    () => probe.inspectAuth(),
    /NETWORK_DISABLED/
  );
  assert.equal(driver.launchCount, 0);
  assert.equal(probe.auditSnapshot().sessionsStarted, 0);
});

test("具体 probe 以受限 context 和 locator 只读解析三类结果", async () => {
  const driver = new FakeDriver({ root: syntheticRoot() });
  const probe = new CmoocPlaywrightReadOnlyProbe(
    probeOptions(driver)
  );

  const auth = await probe.inspectAuth();
  const list = await probe.readThreadList({
    forumListUrl: LIST_URL,
    maxThreads: 10
  });
  const detail = await probe.readThreadDetail({
    threadUrl: THREAD_URL
  });

  assert.deepEqual(auth, {
    authenticated: true,
    readable: true
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].locator, THREAD_URL);
  assert.equal(list[0].titleText, "SECRET_THREAD_TITLE");
  assert.equal(list[0].replyCount, 1);
  assert.equal(
    list[0].latestEventAt,
    "2026-01-01T00:00:00.000Z"
  );
  assert.equal(detail?.comments[0].stableCommentRef, COMMENT_REF);
  assert.equal(
    detail?.comments[0].contentText,
    "SECRET_COMMENT_BODY"
  );

  assert.equal(driver.launchCount, 3);
  for (const browser of driver.browsers) {
    assert.deepEqual(browser.contextOptions, [
      {
        serviceWorkers: "block",
        acceptDownloads: false
      }
    ]);
    const [context] = browser.contexts;
    assert.deepEqual(context.events.slice(0, 4), [
      "request-guard",
      "websocket-guard",
      "new-page",
      "download-guard"
    ]);
    assert.equal(context.events[4], "goto");
    assert.equal(context.closed, true);
    assert.equal(browser.closed, true);
    assert.equal(context.routes[0].continued, true);
    assert.equal(context.routes[0].aborted, false);
  }
  assert.deepEqual(probe.auditSnapshot(), {
    schemaVersion: "cmooc.playwright-read-only-probe.v1",
    networkEnabled: true,
    allowedOriginCount: 1,
    sessionsStarted: 3,
    allowedRequestCount: 3,
    abortedRequestCount: 0,
    blockedWebSocketCount: 0,
    blockedDownloadCount: 0,
    violationCodes: [],
    containsForumText: false
  });
});

test("页面脚本的 POST 在发出前终止并产生去正文审计错误", async () => {
  const driver = new FakeDriver({
    root: syntheticRoot(),
    backgroundRequests: [
      { url: `${ORIGIN}/cMOOC/api/write`, method: "POST" }
    ]
  });
  const probe = new CmoocPlaywrightReadOnlyProbe(
    probeOptions(driver)
  );

  await assert.rejects(
    () => probe.inspectAuth(),
    /POLICY_VIOLATION: method_not_allowed/
  );
  const [context] = driver.browsers[0].contexts;
  assert.equal(context.routes[0].continued, true);
  assert.equal(context.routes[1].aborted, true);
  assert.deepEqual(probe.auditSnapshot().violationCodes, [
    "method_not_allowed"
  ]);
  assert.equal(probe.auditSnapshot().allowedRequestCount, 1);
  assert.equal(probe.auditSnapshot().abortedRequestCount, 1);
  assert.equal(
    JSON.stringify(probe.auditSnapshot()).includes(
      "SECRET_THREAD_BODY"
    ),
    false
  );
});

test("WebSocket 与下载均被关闭、取消并报告", async () => {
  const driver = new FakeDriver({
    root: syntheticRoot(),
    openWebSocket: true,
    startDownload: true
  });
  const probe = new CmoocPlaywrightReadOnlyProbe(
    probeOptions(driver)
  );

  await assert.rejects(
    () => probe.inspectAuth(),
    /POLICY_VIOLATION: websocket_forbidden/
  );
  const [context] = driver.browsers[0].contexts;
  assert.equal(context.webSockets[0].closed, true);
  assert.equal(context.downloads[0].cancelled, true);
  assert.equal(probe.auditSnapshot().blockedWebSocketCount, 1);
  assert.equal(probe.auditSnapshot().blockedDownloadCount, 1);
  assert.deepEqual(probe.auditSnapshot().violationCodes, [
    "websocket_forbidden",
    "download_forbidden"
  ]);
});

test("源码不含页面写入、脚本注入、截图、跟踪或旧数据链依赖", () => {
  const source = readFileSync(
    new URL(
      "../../lib/forum-adapters/cmooc-playwright-read-only-probe.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /\.(?:click|fill|press|type|evaluate|screenshot)\s*\(/
  );
  assert.doesNotMatch(
    source,
    /\b(?:keyboard|mouse|tracing)\b/
  );
  assert.doesNotMatch(
    source,
    /(?:scan-real-forum|extract-post-detail|publish-reply|cmooc-api|prisma|database)/
  );
  assert.doesNotMatch(
    source,
    /\b(?:writeFile|appendFile|createWriteStream)\s*\(/
  );
});
