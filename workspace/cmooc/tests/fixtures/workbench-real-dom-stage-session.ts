import {
  chromium,
  type Browser,
  type BrowserContext,
  type Download,
  type Page,
  type Request,
  type Route,
  type WebSocketRoute
} from "playwright";
import { hashCourseToolValue } from "../../lib/course-tools/contracts";
import { CmoocQuillStageCompanionDriver } from "../../lib/live-runtime/cmooc-quill-stage-driver";
import {
  openCmoocQuillStageBrowserBridge,
  type StageBrowserBrowser,
  type StageBrowserContext,
  type StageBrowserDownload,
  type StageBrowserDriver,
  type StageBrowserPage,
  type StageBrowserRequest,
  type StageBrowserRoute,
  type StageBrowserWebSocketRoute
} from "../../lib/live-runtime/cmooc-quill-stage-browser-bridge";
import type {
  WorkbenchStageBrowserSession,
  WorkbenchStageBrowserSessionFactory
} from "../../lib/workbench/trusted-workbench-platform-stage-adapter";

export const REAL_DOM_STAGE_FIXTURE_ORIGIN =
  "https://stage-fixture.invalid";
export const REAL_DOM_STAGE_FIXTURE_TARGET_URL =
  `${REAL_DOM_STAGE_FIXTURE_ORIGIN}/discussion/detail?fixture=workbench-stage`;

export type RealDomStageFixtureScenario = Readonly<{
  existingDraft?: string;
  mutateReadback?: boolean;
  requestExpectedReadPost?: boolean;
  openWebSocket?: boolean;
  startDownload?: boolean;
}>;

/**
 * Numeric and enum-only evidence from the synthetic browser fixture. It never
 * stores the target URL, HTML, transient draft, credentials, or request body.
 */
export type RealDomStageFixtureLifecycle = {
  browserLaunchCount: number;
  browserCloseCount: number;
  contextOpenCount: number;
  contextCloseCount: number;
  pageOpenCount: number;
  pageCloseCount: number;
  routeFulfillCount: number;
  allowedContinueCount: number;
  blockedRequestCount: number;
  blockedPostCount: number;
  webSocketInterceptCount: number;
  webSocketCloseCount: number;
  downloadObservedCount: number;
  downloadCancelCount: number;
  sessionOpenCount: number;
  sessionCloseCount: number;
  bridgeAuditCount: number;
  bridgeAllowedRequestCount: number;
  bridgeBlockedRequestCount: number;
};

export function createRealDomStageFixtureLifecycle(): RealDomStageFixtureLifecycle {
  return {
    browserLaunchCount: 0,
    browserCloseCount: 0,
    contextOpenCount: 0,
    contextCloseCount: 0,
    pageOpenCount: 0,
    pageCloseCount: 0,
    routeFulfillCount: 0,
    allowedContinueCount: 0,
    blockedRequestCount: 0,
    blockedPostCount: 0,
    webSocketInterceptCount: 0,
    webSocketCloseCount: 0,
    downloadObservedCount: 0,
    downloadCancelCount: 0,
    sessionOpenCount: 0,
    sessionCloseCount: 0,
    bridgeAuditCount: 0,
    bridgeAllowedRequestCount: 0,
    bridgeBlockedRequestCount: 0
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function fixtureHtml(scenario: RealDomStageFixtureScenario): string {
  const existingDraft = scenario.existingDraft?.trim() ?? "";
  const editorMarkup = existingDraft
    ? `<p>${escapeHtml(existingDraft)}</p>`
    : "<p><br></p>";
  return `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>synthetic stage fixture</title></head>
  <body>
    <main class="comment_container">
      <div id="edit"><div class="ql-editor" contenteditable="true">${editorMarkup}</div></div>
      <div class="buttons"><button type="button" class="right">synthetic submit</button></div>
    </main>
    <script>
      (() => {
        const editor = document.querySelector('.ql-editor');
        editor.addEventListener('input', () => {
          if (${scenario.mutateReadback === true} &&
              !window.__fixtureReadbackDrifted &&
              editor.textContent) {
            window.__fixtureReadbackDrifted = true;
            editor.firstElementChild.textContent += ' synthetic-drift';
          }
        });
        if (${scenario.requestExpectedReadPost === true}) {
          void fetch('/cmooc-api/comment/list', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
          }).catch(() => undefined);
        }
        if (${scenario.openWebSocket === true}) {
          try {
            const socket = new WebSocket('wss://stage-fixture.invalid/read-stream');
            socket.addEventListener('error', () => undefined);
          } catch {}
        }
        if (${scenario.startDownload === true}) {
          window.addEventListener('load', () => {
            const link = document.createElement('a');
            link.href = 'data:text/plain,synthetic-download';
            link.download = 'synthetic.txt';
            document.body.appendChild(link);
            link.click();
          }, { once: true });
        }
      })();
    </script>
  </body>
</html>`;
}

function normalizedUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  return parsed.toString();
}

function asStageRequest(request: Request): StageBrowserRequest {
  return {
    method: () => request.method(),
    url: () => request.url(),
    resourceType: () => request.resourceType(),
    isNavigationRequest: () => request.isNavigationRequest()
  };
}

function wrapRoute(input: {
  route: Route;
  request: Request;
  targetUrl: string;
  html: string;
  lifecycle: RealDomStageFixtureLifecycle;
}): StageBrowserRoute {
  let settled = false;
  return {
    abort: async () => {
      if (settled) return;
      settled = true;
      input.lifecycle.blockedRequestCount += 1;
      if (input.request.method().toUpperCase() === "POST") {
        input.lifecycle.blockedPostCount += 1;
      }
      await input.route.abort("blockedbyclient");
    },
    continue: async () => {
      if (settled) return;
      settled = true;
      const isFixtureNavigation =
        input.request.isNavigationRequest() &&
        input.request.method().toUpperCase() === "GET" &&
        normalizedUrl(input.request.url()) === normalizedUrl(input.targetUrl);
      if (isFixtureNavigation) {
        input.lifecycle.routeFulfillCount += 1;
        await input.route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: input.html
        });
        return;
      }
      input.lifecycle.allowedContinueCount += 1;
      await input.route.continue();
    }
  };
}

function wrapDownload(
  download: Download,
  lifecycle: RealDomStageFixtureLifecycle
): StageBrowserDownload {
  lifecycle.downloadObservedCount += 1;
  let cancelled = false;
  return {
    cancel: async () => {
      if (!cancelled) {
        cancelled = true;
        lifecycle.downloadCancelCount += 1;
      }
      await download.cancel();
    }
  };
}

function wrapPage(
  page: Page,
  lifecycle: RealDomStageFixtureLifecycle
): StageBrowserPage {
  let closed = false;
  return {
    goto: async (url, options) => page.goto(url, options),
    url: () => page.url(),
    evaluate: async (pageFunction, argument) =>
      page.evaluate(pageFunction as never, argument as never) as Promise<never>,
    on: (_event, listener) => {
      page.on("download", (download) => {
        listener(wrapDownload(download, lifecycle));
      });
    },
    close: async () => {
      if (!closed) {
        closed = true;
        lifecycle.pageCloseCount += 1;
      }
      await page.close();
    }
  };
}

function wrapWebSocketRoute(
  route: WebSocketRoute,
  lifecycle: RealDomStageFixtureLifecycle
): StageBrowserWebSocketRoute {
  let closed = false;
  return {
    close: async (options) => {
      if (!closed) {
        closed = true;
        lifecycle.webSocketCloseCount += 1;
      }
      await route.close(options);
    }
  };
}

function wrapContext(input: {
  context: BrowserContext;
  targetUrl: string;
  html: string;
  lifecycle: RealDomStageFixtureLifecycle;
}): StageBrowserContext {
  let closed = false;
  return {
    route: async (pattern, handler) => {
      await input.context.route(pattern, async (route, request) => {
        await handler(
          wrapRoute({
            route,
            request,
            targetUrl: input.targetUrl,
            html: input.html,
            lifecycle: input.lifecycle
          }),
          asStageRequest(request)
        );
      });
    },
    routeWebSocket: async (pattern, handler) => {
      await input.context.routeWebSocket(pattern, async (route) => {
        input.lifecycle.webSocketInterceptCount += 1;
        await handler(wrapWebSocketRoute(route, input.lifecycle));
      });
    },
    newPage: async () => {
      input.lifecycle.pageOpenCount += 1;
      return wrapPage(await input.context.newPage(), input.lifecycle);
    },
    close: async () => {
      if (!closed) {
        closed = true;
        input.lifecycle.contextCloseCount += 1;
      }
      await input.context.close();
    }
  };
}

function wrapBrowser(input: {
  browser: Browser;
  targetUrl: string;
  html: string;
  lifecycle: RealDomStageFixtureLifecycle;
}): StageBrowserBrowser {
  let closed = false;
  return {
    newContext: async (options) => {
      input.lifecycle.contextOpenCount += 1;
      const context = await input.browser.newContext(options);
      return wrapContext({ ...input, context });
    },
    close: async () => {
      if (!closed) {
        closed = true;
        input.lifecycle.browserCloseCount += 1;
      }
      await input.browser.close();
    }
  };
}

function fixtureBrowserDriver(input: {
  targetUrl: string;
  html: string;
  lifecycle: RealDomStageFixtureLifecycle;
}): StageBrowserDriver {
  return {
    launch: async (options) => {
      input.lifecycle.browserLaunchCount += 1;
      const browser = await chromium.launch(options);
      return wrapBrowser({ ...input, browser });
    }
  };
}

export function createRealDomWorkbenchStageSessionFactory(input?: {
  scenario?: RealDomStageFixtureScenario;
  lifecycle?: RealDomStageFixtureLifecycle;
  timeoutMs?: number;
}): Readonly<{
  factory: WorkbenchStageBrowserSessionFactory;
  lifecycle: RealDomStageFixtureLifecycle;
}> {
  const scenario = Object.freeze({ ...(input?.scenario ?? {}) });
  const lifecycle = input?.lifecycle ?? createRealDomStageFixtureLifecycle();
  const timeoutMs = input?.timeoutMs ?? 30_000;
  const html = fixtureHtml(scenario);
  let sessionSequence = 0;
  const factory: WorkbenchStageBrowserSessionFactory = {
    open: async ({ target, targetRef, courseAlias, observedAt }) => {
      sessionSequence += 1;
      lifecycle.sessionOpenCount += 1;
      const pageIdentityHash = hashCourseToolValue(
        "test.real-dom-stage.page-identity.v1",
        {
          courseAlias,
          targetRef,
          targetVersionHash: target.targetVersionHash,
          sequence: sessionSequence
        }
      );
      const driverSessionKey = hashCourseToolValue(
        "test.real-dom-stage.driver-session.v1",
        { pageIdentityHash, observedAt, sequence: sessionSequence }
      );
      const guardReceiptHash = hashCourseToolValue(
        "test.real-dom-stage.guard.v1",
        { pageIdentityHash, driverSessionKey, sentMutationCount: 0 }
      );
      const pageBindingHash = hashCourseToolValue(
        "test.real-dom-stage.page-binding.v1",
        {
          courseAlias,
          targetRef,
          targetVersionHash: target.targetVersionHash,
          targetLocatorHash: target.targetLocatorHash
        }
      );
      const bridge = await openCmoocQuillStageBrowserBridge({
        targetUrl: target.targetUrl,
        allowedOrigin: target.allowedOrigin,
        timeoutMs,
        driver: fixtureBrowserDriver({
          targetUrl: target.targetUrl,
          html,
          lifecycle
        })
      });
      const expectedPage = Object.freeze({
        origin: target.allowedOrigin,
        courseAlias,
        courseLocatorHash: target.courseLocatorHash,
        pageIdentityHash,
        driverSessionKey,
        targetVersionHash: target.targetVersionHash,
        targetLocatorHash: target.targetLocatorHash,
        activeTab: true as const,
        pageReady: true as const,
        editorVisible: true as const,
        containsForumText: false as const
      });
      try {
        const driver = new CmoocQuillStageCompanionDriver({
          bridge,
          expectedPage,
          expectedTargetUrl: target.targetUrl,
          operationTimeoutMs: timeoutMs,
          settleMs: 0
        });
        let closed = false;
        const session: WorkbenchStageBrowserSession = {
          expectedPage,
          guardReceiptHash,
          pageBindingRef: `page-binding:${pageBindingHash}`,
          pageBindingHash,
          driver,
          inspectBaseline: () => driver.inspectBaseline(),
          reconcileOwned: (request) => driver.reconcileOwned(request),
          close: async () => {
            if (closed) {
              return {
                status: "passed",
                sentMutationCount: 0,
                publishAttempted: false,
                containsForumText: false
              };
            }
            closed = true;
            lifecycle.sessionCloseCount += 1;
            const audit = bridge.auditSnapshot();
            lifecycle.bridgeAuditCount += 1;
            lifecycle.bridgeAllowedRequestCount += audit.allowedRequestCount;
            lifecycle.bridgeBlockedRequestCount += audit.blockedRequestCount;
            let status: "passed" | "unknown" =
              audit.sentMutationCount === 0 && audit.violationCodes.length === 0
                ? "passed"
                : "unknown";
            await bridge.close().catch(() => {
              status = "unknown";
            });
            return {
              status,
              sentMutationCount: 0,
              publishAttempted: false,
              containsForumText: false
            };
          }
        };
        return Object.freeze(session);
      } catch (error) {
        await bridge.close().catch(() => undefined);
        throw error;
      }
    }
  };
  return Object.freeze({ factory: Object.freeze(factory), lifecycle });
}
