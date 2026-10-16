import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { chromium, type Page } from "playwright";
import {
  executeStageCompanionRun,
  InMemoryStageRunNonceRegistry,
  issueStageCompanionToken,
  type StageCompanionPageState
} from "../../lib/live-runtime/stage-companion";
import {
  captureBrowserScreenshotWithRetry,
  CmoocQuillStageCompanionDriver,
  type CmoocQuillStageBrowserBridge
} from "../../lib/live-runtime/cmooc-quill-stage-driver";
import {
  hashTransientDraftBody
} from "../../lib/live-runtime/draft-content";

const TARGET_URL =
  "https://cmooc.example.test/discussion/detail?fixture=stage";
const TRANSIENT_DRAFT =
  "第一段\r\n第二段\n\n第三段：Cafe\u0301";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(nonceSeed: string) {
  const now = new Date("2026-07-31T12:00:00.000Z");
  const secret = Buffer.alloc(32, 73);
  const hashes = {
    courseLocatorHash: hash("quill-course-locator"),
    pageIdentityHash: hash("quill-page-identity"),
    driverSessionKey: hash("quill-driver-session"),
    opportunityReceiptHash: hash("quill-opportunity"),
    revalidationReceiptHash: hash("quill-revalidation"),
    afterObservationReceiptHash: hash("quill-after-observation"),
    guardReceiptHash: hash("quill-network-guard"),
    targetVersionHash: hash("quill-target-version"),
    draftContentHash: hashTransientDraftBody(TRANSIENT_DRAFT)
  };
  const token = issueStageCompanionToken({
    courseAlias: "quill-stage-test",
    allowedOrigin: new URL(TARGET_URL).origin,
    ...hashes,
    signingSecret: secret,
    now,
    expiresInSeconds: 120,
    nonce: createHash("sha256")
      .update(nonceSeed)
      .digest("base64url")
  });
  const pageState: StageCompanionPageState = {
    origin: new URL(TARGET_URL).origin,
    courseAlias: "quill-stage-test",
    courseLocatorHash: hashes.courseLocatorHash,
    pageIdentityHash: hashes.pageIdentityHash,
    driverSessionKey: hashes.driverSessionKey,
    targetVersionHash: hashes.targetVersionHash,
    activeTab: true,
    pageReady: true,
    editorVisible: true,
    containsForumText: false
  };
  return { now, secret, hashes, token, pageState };
}

function html(input?: {
  existingDraft?: string;
  existingMarkup?: string;
  mutateReadback?: boolean;
  attemptMutation?: boolean;
  replaceEditorOnInput?: boolean;
  driftUrlOnInput?: boolean;
  duplicateEditorOnInput?: boolean;
}): string {
  const existing = input?.existingDraft ?? "";
  const editorBody = input?.existingMarkup ?? (existing
    ? `<p>${existing}</p>`
    : "<p><br></p>");
  return `<!doctype html>
    <html><body>
      <div class="comment_container">
        <div id="edit">
          <div class="ql-editor" contenteditable="true">${editorBody}</div>
        </div>
        <div class="buttons"><button class="right">发布</button></div>
      </div>
      <script>
        window.__stageInputCount = 0;
        const editor = document.querySelector('.ql-editor');
        editor.addEventListener('input', () => {
          window.__stageInputCount += 1;
          if (${input?.mutateReadback === true} &&
              !window.__stageReadbackMutated &&
              editor.textContent) {
            window.__stageReadbackMutated = true;
            editor.firstElementChild.textContent += '漂移';
          }
          if (${input?.attemptMutation === true} &&
              !window.__stageMutationAttempted &&
              editor.textContent) {
            window.__stageMutationAttempted = true;
            void fetch('/comment/commentModule', {
              method: 'POST',
              body: 'blocked-stage-fixture'
              }).catch(() => undefined);
          }
          if (${input?.replaceEditorOnInput === true} &&
              !window.__stageEditorReplaced) {
            window.__stageEditorReplaced = true;
            const replacement = document.createElement('div');
            replacement.className = 'ql-editor';
            replacement.contentEditable = 'true';
            replacement.innerHTML = '<p>unverified replacement</p>';
            editor.replaceWith(replacement);
          }
          if (${input?.driftUrlOnInput === true} &&
              !window.__stageUrlDrifted) {
            window.__stageUrlDrifted = true;
            history.replaceState({}, '', '/discussion/drifted?fixture=stage');
          }
          if (${input?.duplicateEditorOnInput === true} &&
              !window.__stageEditorDuplicated) {
            window.__stageEditorDuplicated = true;
            const duplicate = editor.cloneNode(true);
            duplicate.className = 'ql-editor';
            editor.parentElement.appendChild(duplicate);
          }
        });
      </script>
    </body></html>`;
}

async function installPage(page: Page, body: string): Promise<void> {
  await page.route("https://cmooc.example.test/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body
    });
  });
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
}

function bridge(page: Page, calls: number[]): CmoocQuillStageBrowserBridge {
  return {
    async evaluate(pageFunction, argument, options) {
      calls.push(options.timeoutMs);
      return page.evaluate(
        pageFunction as never,
        argument as never
      ) as Promise<Awaited<ReturnType<typeof pageFunction>>>;
    }
  };
}

test("cMOOC Quill STAGE driver preserves logical newlines in one browser transaction", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(async () => browser.close());

  await t.test("multiline readback hashes exactly and clears the editor", async () => {
    const page = await browser.newPage();
    await installPage(page, html());
    const current = fixture("quill-success");
    const calls: number[] = [];
    const driver = new CmoocQuillStageCompanionDriver({
      bridge: bridge(page, calls),
      expectedPage: current.pageState,
      expectedTargetUrl: TARGET_URL,
      operationTimeoutMs: 60_000,
      settleMs: 0
    });

    const result = await executeStageCompanionRun({
      token: current.token,
      signingSecret: current.secret,
      nonceRegistry: new InMemoryStageRunNonceRegistry(),
      driver,
      transientDraft: TRANSIENT_DRAFT,
      now: () => new Date(current.now.getTime() + 1_000)
    });

    assert.equal(result.receipt.editorReadbackVerified, true);
    assert.equal(result.receipt.editorEmptyAfterClear, true);
    assert.equal(result.receipt.sentMutationCount, 0);
    assert.deepEqual(calls, [60_000]);
    assert.equal(
      await page.locator(".ql-editor").evaluate((element) =>
        (element.textContent ?? "").trim()
      ),
      ""
    );
    assert.equal(
      JSON.stringify(result).includes("第一段"),
      false
    );
    await page.close();
  });

  await t.test("baseline and reconciliation inspect only the exact owned editor", async () => {
    const page = await browser.newPage();
    await installPage(page, html());
    const current = fixture("quill-reconcile-owned");
    const driver = new CmoocQuillStageCompanionDriver({
      bridge: bridge(page, []),
      expectedPage: current.pageState,
      expectedTargetUrl: TARGET_URL,
      settleMs: 0
    });
    assert.deepEqual(await driver.inspectBaseline(), {
      pageReady: true,
      editorVisible: true,
      editorEmpty: true
    });
    await page.locator(".ql-editor").evaluate((element, input) => {
      element.innerHTML = "";
      for (const line of input.body.replace(/\r\n?/gu, "\n").split("\n")) {
        const paragraph = document.createElement("p");
        if (line) paragraph.textContent = line;
        else paragraph.appendChild(document.createElement("br"));
        element.appendChild(paragraph);
      }
      (element as HTMLElement).dataset.cmoocStageRun = input.runNonceHash;
    }, {
      body: TRANSIENT_DRAFT,
      runNonceHash: current.token.grant.runNonceHash
    });
    const reconciled = await driver.reconcileOwned({
      runNonceHash: current.token.grant.runNonceHash,
      transientDraft: TRANSIENT_DRAFT
    });
    assert.deepEqual(reconciled, {
      status: "owned_draft_cleared",
      editorReadbackVerified: true,
      editorEmptyAfterClear: true,
      editorClearCount: 1
    });
    assert.equal(await page.locator(".ql-editor").textContent(), "");
    await page.close();
  });

  await t.test("reconciliation never clears unowned human content", async () => {
    const page = await browser.newPage();
    await installPage(page, html({ existingDraft: "教师手工草稿" }));
    const current = fixture("quill-reconcile-unowned");
    const driver = new CmoocQuillStageCompanionDriver({
      bridge: bridge(page, []),
      expectedPage: current.pageState,
      expectedTargetUrl: TARGET_URL,
      settleMs: 0
    });
    const reconciled = await driver.reconcileOwned({
      runNonceHash: current.token.grant.runNonceHash,
      transientDraft: TRANSIENT_DRAFT
    });
    assert.equal(reconciled.status, "blocked_unowned_content");
    assert.equal(reconciled.editorClearCount, 0);
    assert.equal((await page.locator(".ql-editor").textContent())?.trim(), "教师手工草稿");
    await page.close();
  });

  await t.test("readback drift fails closed after clearing", async () => {
    const page = await browser.newPage();
    await installPage(page, html({ mutateReadback: true }));
    const current = fixture("quill-readback-drift");
    const driver = new CmoocQuillStageCompanionDriver({
      bridge: bridge(page, []),
      expectedPage: current.pageState,
      expectedTargetUrl: TARGET_URL,
      settleMs: 0
    });

    await assert.rejects(
      () =>
        executeStageCompanionRun({
          token: current.token,
          signingSecret: current.secret,
          nonceRegistry: new InMemoryStageRunNonceRegistry(),
          driver,
          transientDraft: TRANSIENT_DRAFT,
          now: () => new Date(current.now.getTime() + 1_000)
        }),
      /STAGE_COMPANION_EDITOR_READBACK_MISMATCH|CMOOC_QUILL_STAGE_EDITOR_READBACK_MISMATCH/
    );
    assert.equal(
      await page.locator(".ql-editor").evaluate((element) =>
        (element.textContent ?? "").trim()
      ),
      ""
    );
    await page.close();
  });

  await t.test("a blocked mutation attempt invalidates STAGE and still clears", async () => {
    const page = await browser.newPage();
    await installPage(page, html({ attemptMutation: true }));
    const current = fixture("quill-mutation-attempt");
    const driver = new CmoocQuillStageCompanionDriver({
      bridge: bridge(page, []),
      expectedPage: current.pageState,
      expectedTargetUrl: TARGET_URL,
      settleMs: 0
    });

    await assert.rejects(
      () =>
        executeStageCompanionRun({
          token: current.token,
          signingSecret: current.secret,
          nonceRegistry: new InMemoryStageRunNonceRegistry(),
          driver,
          transientDraft: TRANSIENT_DRAFT,
          now: () => new Date(current.now.getTime() + 1_000)
        }),
      /STAGE_COMPANION_NO_SUBMIT_GUARD_FAILED/
    );
    assert.equal(
      await page.locator(".ql-editor").evaluate((element) =>
        (element.textContent ?? "").trim()
      ),
      ""
    );
    await page.close();
  });

  await t.test("an existing human draft is preserved and never overwritten", async () => {
    const page = await browser.newPage();
    await installPage(page, html({ existingDraft: "已有人工草稿" }));
    const current = fixture("quill-existing-draft");
    const driver = new CmoocQuillStageCompanionDriver({
      bridge: bridge(page, []),
      expectedPage: current.pageState,
      expectedTargetUrl: TARGET_URL,
      settleMs: 0
    });

    await assert.rejects(
      () =>
        executeStageCompanionRun({
          token: current.token,
          signingSecret: current.secret,
          nonceRegistry: new InMemoryStageRunNonceRegistry(),
          driver,
          transientDraft: TRANSIENT_DRAFT,
          now: () => new Date(current.now.getTime() + 1_000)
        }),
      /CMOOC_QUILL_STAGE_EDITOR_NOT_EMPTY/
    );
    assert.equal(
      await page.locator(".ql-editor").innerText(),
      "已有人工草稿"
    );
    await page.close();
  });

  await t.test("an image/embed human draft is not mistaken for an empty editor", async () => {
    const page = await browser.newPage();
    await installPage(
      page,
      html({ existingMarkup: '<p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="human attachment"></p>' })
    );
    const current = fixture("quill-existing-embed-draft");
    const driver = new CmoocQuillStageCompanionDriver({
      bridge: bridge(page, []),
      expectedPage: current.pageState,
      expectedTargetUrl: TARGET_URL,
      settleMs: 0
    });

    await assert.rejects(
      () =>
        executeStageCompanionRun({
          token: current.token,
          signingSecret: current.secret,
          nonceRegistry: new InMemoryStageRunNonceRegistry(),
          driver,
          transientDraft: TRANSIENT_DRAFT,
          now: () => new Date(current.now.getTime() + 1_000)
        }),
      /CMOOC_QUILL_STAGE_EDITOR_NOT_EMPTY/
    );
    assert.match(
      await page.locator(".ql-editor").innerHTML(),
      /human attachment/
    );
    await page.close();
  });

  await t.test("a replacement editor with drift is rejected without clearing unverified content", async () => {
    const page = await browser.newPage();
    await installPage(page, html({ replaceEditorOnInput: true }));
    const current = fixture("quill-editor-replacement-drift");
    const driver = new CmoocQuillStageCompanionDriver({
      bridge: bridge(page, []),
      expectedPage: current.pageState,
      expectedTargetUrl: TARGET_URL,
      settleMs: 0
    });

    await assert.rejects(
      () =>
        executeStageCompanionRun({
          token: current.token,
          signingSecret: current.secret,
          nonceRegistry: new InMemoryStageRunNonceRegistry(),
          driver,
          transientDraft: TRANSIENT_DRAFT,
          now: () => new Date(current.now.getTime() + 1_000)
        }),
      /CMOOC_QUILL_STAGE_FAILURE_CLEAR_RECOVERED|CMOOC_QUILL_STAGE_FAILURE_CLEAR_UNKNOWN|CMOOC_QUILL_STAGE_EDITOR_CLEAR_RECOVERED|CMOOC_QUILL_STAGE_EDITOR_CLEAR_UNKNOWN/
    );
    assert.equal(
      await page.locator(".ql-editor").innerText(),
      "unverified replacement"
    );
    await page.close();
  });

  await t.test("target URL drift during the round-trip is rejected", async () => {
    const page = await browser.newPage();
    await installPage(page, html({ driftUrlOnInput: true }));
    const current = fixture("quill-target-url-drift");
    const driver = new CmoocQuillStageCompanionDriver({
      bridge: bridge(page, []),
      expectedPage: current.pageState,
      expectedTargetUrl: TARGET_URL,
      settleMs: 0
    });

    await assert.rejects(
      () =>
        executeStageCompanionRun({
          token: current.token,
          signingSecret: current.secret,
          nonceRegistry: new InMemoryStageRunNonceRegistry(),
          driver,
          transientDraft: TRANSIENT_DRAFT,
          now: () => new Date(current.now.getTime() + 1_000)
        }),
      /CMOOC_QUILL_STAGE_FAILURE_CLEAR_RECOVERED|CMOOC_QUILL_STAGE_FAILURE_CLEAR_UNKNOWN|CMOOC_QUILL_STAGE_EDITOR_CLEAR_RECOVERED|CMOOC_QUILL_STAGE_EDITOR_CLEAR_UNKNOWN/
    );
    assert.equal(
      (await page.locator(".ql-editor").innerText()).trim(),
      ""
    );
    await page.close();
  });

  await t.test("a second visible editor fails closed and is emptied", async () => {
    const page = await browser.newPage();
    await installPage(page, html({ duplicateEditorOnInput: true }));
    const current = fixture("quill-editor-duplicate");
    const driver = new CmoocQuillStageCompanionDriver({
      bridge: bridge(page, []),
      expectedPage: current.pageState,
      expectedTargetUrl: TARGET_URL,
      settleMs: 0
    });

    await assert.rejects(
      () =>
        executeStageCompanionRun({
          token: current.token,
          signingSecret: current.secret,
          nonceRegistry: new InMemoryStageRunNonceRegistry(),
          driver,
          transientDraft: TRANSIENT_DRAFT,
          now: () => new Date(current.now.getTime() + 1_000)
        }),
      /CMOOC_QUILL_STAGE_FAILURE_CLEAR_RECOVERED|CMOOC_QUILL_STAGE_FAILURE_CLEAR_UNKNOWN|CMOOC_QUILL_STAGE_EDITOR_CLEAR_RECOVERED|CMOOC_QUILL_STAGE_EDITOR_CLEAR_UNKNOWN/
    );
    assert.deepEqual(
      (await page.locator(".ql-editor").allInnerTexts()).map(
        (value) => value.trim()
      ),
      ["", ""]
    );
    await page.close();
  });
});

test("browser evidence screenshot retries only transient capture failures", async () => {
  let attempts = 0;
  const bytes = await captureBrowserScreenshotWithRetry({
    capture: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("Page.captureScreenshot timed out");
      }
      return new Uint8Array([1, 2, 3]);
    },
    maxAttempts: 2
  });
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.equal(attempts, 2);

  attempts = 0;
  await assert.rejects(
    () =>
      captureBrowserScreenshotWithRetry({
        capture: async () => {
          attempts += 1;
          throw new Error("SCREENSHOT_PRIVACY_SCOPE_INVALID");
        },
        maxAttempts: 3
      }),
    /SCREENSHOT_PRIVACY_SCOPE_INVALID/
  );
  assert.equal(attempts, 1);
});
