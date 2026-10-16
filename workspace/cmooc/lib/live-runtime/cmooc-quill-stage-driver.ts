import {
  normalizeTransientDraftBody
} from "./draft-content";
import type {
  AtomicStageCompanionDriver,
  AtomicStageCompanionTransaction,
  StageCompanionNetworkGuard,
  StageCompanionPageState
} from "./stage-companion";

export const DEFAULT_CMOOC_QUILL_STAGE_TIMEOUT_MS =
  60_000;

const DEFAULT_EDITOR_SELECTOR =
  ".comment_container #edit .ql-editor";
const DEFAULT_SUBMIT_CONTROL_SELECTOR =
  ".comment_container .buttons .right";
const HASH_PATTERN = /^[a-f0-9]{64}$/;

type BrowserEvaluateOptions = {
  timeoutMs: number;
};

export interface CmoocQuillStageBrowserBridge {
  evaluate<Result, Argument>(
    pageFunction: (
      argument: Argument
    ) => Result | Promise<Result>,
    argument: Argument,
    options: BrowserEvaluateOptions
  ): Promise<Result>;
}

type DomGuardSnapshot = {
  sentMutationCount: 0;
  publishControlActivated: boolean;
  submitKeyboardShortcutUsed: boolean;
  formSubmitTriggered: boolean;
  externalPublishAttempted: boolean;
};

type DomTransactionInput = {
  expectedOrigin: string;
  expectedTargetUrl: string;
  editorSelector: string;
  submitControlSelector: string;
  runNonceHash: string;
  transientDraft: string;
  settleMs: number;
};

type DomTransactionResult = {
  errorCode: string | null;
  origin: string;
  pageReady: boolean;
  editorVisible: boolean;
  editorTouched: boolean;
  editorValue: string;
  editorEmptyAfterClear: boolean;
  guardAfterAttach: DomGuardSnapshot;
  guardAfterWrite: DomGuardSnapshot;
  guardAfterClear: DomGuardSnapshot;
};

type EmergencyClearResult =
  | "cleared"
  | "not_owned"
  | "editor_missing";

export type CmoocQuillStageBaseline = Readonly<{
  pageReady: boolean;
  editorVisible: boolean;
  editorEmpty: boolean;
}>;

export type CmoocQuillStageReconcileResult = Readonly<{
  status:
    | "owned_draft_cleared"
    | "already_empty_not_owned"
    | "blocked_unowned_content"
    | "blocked_owned_content_mismatch"
    | "editor_missing";
  editorReadbackVerified: boolean;
  editorEmptyAfterClear: boolean;
  editorClearCount: 0 | 1;
}>;

function normalizedTargetUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function pageState(
  expected: StageCompanionPageState,
  origin: string
): StageCompanionPageState {
  return {
    ...expected,
    origin,
    activeTab: true,
    pageReady: true,
    editorVisible: true,
    containsForumText: false
  };
}

function guardState(
  snapshot: DomGuardSnapshot,
  guardReceiptHash: string
): StageCompanionNetworkGuard {
  return {
    guardReceiptHash,
    attached: true,
    sentMutationCount: snapshot.sentMutationCount,
    publishControlActivated:
      snapshot.publishControlActivated,
    submitKeyboardShortcutUsed:
      snapshot.submitKeyboardShortcutUsed,
    formSubmitTriggered: snapshot.formSubmitTriggered,
    externalPublishAttempted:
      snapshot.externalPublishAttempted,
    containsForumText: false
  };
}

/**
 * This function is deliberately self-contained because browser bridges
 * serialize it into the active cMOOC tab. It performs the entire guarded
 * Quill round-trip in one evaluation and never returns page content other than
 * the transient editor readback needed for the in-memory hash check.
 */
export async function runCmoocQuillStageDomTransaction(
  input: DomTransactionInput
): Promise<DomTransactionResult> {
  const normalize = (value: string) =>
    value.replace(/\r\n?/g, "\n").normalize("NFC");
  const emptyGuard = (): DomGuardSnapshot => ({
    sentMutationCount: 0,
    publishControlActivated: false,
    submitKeyboardShortcutUsed: false,
    formSubmitTriggered: false,
    externalPublishAttempted: false
  });
  const cloneGuard = (
    value: DomGuardSnapshot
  ): DomGuardSnapshot => ({ ...value });
  const isReadMethod = (method: string) =>
    ["GET", "HEAD", "OPTIONS"].includes(
      method.toUpperCase()
    );
  const visible = (element: Element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      element.isConnected &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const readLogicalEditorText = (editor: Element) => {
    const nodes = Array.from(editor.childNodes);
    if (nodes.length === 0) return "";
    const lines = nodes.map((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent ?? "";
      }
      if (!(node instanceof Element)) return "";
      if (
        node.tagName === "BR" ||
        (node.textContent ?? "") === ""
      ) {
        return "";
      }
      return node.textContent ?? "";
    });
    if (lines.length === 1 && lines[0] === "") {
      return "";
    }
    return normalize(lines.join("\n"));
  };
  const isPlaceholderEditor = (editor: HTMLElement) => {
    const nodes = Array.from(editor.childNodes);
    if (nodes.length === 0) return true;
    if (nodes.length !== 1) return false;
    const paragraph = nodes[0];
    if (!(paragraph instanceof HTMLParagraphElement)) {
      return false;
    }
    if (paragraph.attributes.length !== 0 || paragraph.childNodes.length !== 1) {
      return false;
    }
    const breakNode = paragraph.firstChild;
    return (
      breakNode instanceof HTMLBRElement &&
      breakNode.attributes.length === 0
    );
  };
  const editorIsEmpty = (editor: HTMLElement) =>
    editor.isConnected && isPlaceholderEditor(editor);
  const visibleEditors = () =>
    Array.from(document.querySelectorAll(input.editorSelector))
      .filter(visible) as HTMLElement[];
  const assertPageAndEditor = () => {
    const currentUrl = new URL(location.href);
    currentUrl.hash = "";
    const expectedUrl = new URL(input.expectedTargetUrl);
    expectedUrl.hash = "";
    if (
      location.origin !== input.expectedOrigin ||
      currentUrl.toString() !== expectedUrl.toString()
    ) {
      throw new Error("CMOOC_QUILL_STAGE_TARGET_URL_MISMATCH");
    }
    if (!['interactive', 'complete'].includes(document.readyState)) {
      throw new Error("CMOOC_QUILL_STAGE_PAGE_NOT_READY");
    }
    const editors = visibleEditors();
    if (editors.length !== 1) {
      throw new Error("CMOOC_QUILL_STAGE_EDITOR_NOT_UNIQUE");
    }
    return editors[0];
  };
  const dispatchEditorInput = (
    editor: HTMLElement,
    inputType: string
  ) => {
    let event: Event;
    try {
      event = new InputEvent("input", {
        bubbles: true,
        cancelable: false,
        inputType,
        data: null
      });
    } catch {
      event = new Event("input", { bubbles: true });
    }
    editor.dispatchEvent(event);
  };
  const replaceWithLogicalText = (
    editor: HTMLElement,
    value: string
  ) => {
    const fragment = document.createDocumentFragment();
    for (const line of normalize(value).split("\n")) {
      const paragraph = document.createElement("p");
      if (line === "") {
        paragraph.appendChild(document.createElement("br"));
      } else {
        paragraph.textContent = line;
      }
      fragment.appendChild(paragraph);
    }
    editor.replaceChildren(fragment);
    dispatchEditorInput(editor, "insertText");
  };
  const clearOwnedEditor = (editor: HTMLElement) => {
    const paragraph = document.createElement("p");
    paragraph.appendChild(document.createElement("br"));
    editor.replaceChildren(paragraph);
    dispatchEditorInput(editor, "deleteContentBackward");
    delete editor.dataset.cmoocStageRun;
  };
  const waitForSettle = async () => {
    if (input.settleMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, input.settleMs);
      });
    } else {
      await Promise.resolve();
    }
  };
  const safeErrorCode = (error: unknown) => {
    const message =
      error instanceof Error ? error.message : "";
    return /^CMOOC_QUILL_STAGE_[A-Z0-9_]+$/.test(message)
      ? message
      : "CMOOC_QUILL_STAGE_TRANSACTION_FAILED";
  };

  const initialGuard = emptyGuard();
  let guard = emptyGuard();
  let guardAfterWrite = emptyGuard();
  let guardAfterClear = emptyGuard();
  let editorValue = "";
  let editorEmptyAfterClear = false;
  let editorTouched = false;
  let errorCode: string | null = null;
  let editor: HTMLElement | null = null;
  const ownedEditors: HTMLElement[] = [];
  const draft = normalize(input.transientDraft);
  const cleanup: Array<() => void> = [];

  const rememberOwnedEditor = (candidate: HTMLElement) => {
    if (!candidate.isConnected || !visible(candidate)) {
      throw new Error("CMOOC_QUILL_STAGE_EDITOR_NOT_CONNECTED");
    }
    if (!ownedEditors.includes(candidate)) ownedEditors.push(candidate);
    candidate.dataset.cmoocStageRun = input.runNonceHash;
  };
  const transferOwnershipIfDraftMatches = (
    candidate: HTMLElement
  ): HTMLElement => {
    if (!candidate.isConnected || !visible(candidate)) {
      throw new Error("CMOOC_QUILL_STAGE_EDITOR_REPLACED_UNVERIFIED");
    }
    if (readLogicalEditorText(candidate) !== draft) {
      throw new Error("CMOOC_QUILL_STAGE_EDITOR_REPLACED_UNVERIFIED");
    }
    rememberOwnedEditor(candidate);
    return candidate;
  };
  const reassertOwnedEditor = (current: HTMLElement): HTMLElement => {
    const candidate = assertPageAndEditor();
    if (candidate === current) {
      if (candidate.dataset.cmoocStageRun !== input.runNonceHash) {
        return transferOwnershipIfDraftMatches(candidate);
      }
      return candidate;
    }
    return transferOwnershipIfDraftMatches(candidate);
  };
  const clearAllOwnedEditors = () => {
    const candidates = [
      ...ownedEditors,
      ...Array.from(document.querySelectorAll(input.editorSelector))
        .filter((value): value is HTMLElement => value instanceof HTMLElement)
    ];
    const seen = new Set<HTMLElement>();
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const owned =
        candidate.dataset.cmoocStageRun === input.runNonceHash;
      const replacement =
        editorTouched &&
        candidate.isConnected &&
        visible(candidate) &&
        readLogicalEditorText(candidate) === draft;
      if (!owned && !replacement) continue;
      if (!owned) {
        try {
          rememberOwnedEditor(candidate);
        } catch {
          continue;
        }
      }
      try {
        clearOwnedEditor(candidate);
      } catch {
        editorEmptyAfterClear = false;
      }
    }
    try {
      const current = assertPageAndEditor();
      if (readLogicalEditorText(current) === draft) {
        rememberOwnedEditor(current);
        clearOwnedEditor(current);
      }
      editorEmptyAfterClear = editorIsEmpty(current);
    } catch {
      editorEmptyAfterClear = false;
    }
  };

  try {
    editor = assertPageAndEditor();
    if (!editorIsEmpty(editor)) {
      throw new Error("CMOOC_QUILL_STAGE_EDITOR_NOT_EMPTY");
    }

    const onClick = (event: Event) => {
      const target =
        event.target instanceof Element
          ? event.target
          : null;
      if (target?.closest(input.submitControlSelector)) {
        guard.publishControlActivated = true;
        guard.externalPublishAttempted = true;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const onSubmit = (event: Event) => {
      guard.formSubmitTriggered = true;
      guard.externalPublishAttempted = true;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onKeyDown = (event: Event) => {
      if (
        event instanceof KeyboardEvent &&
        event.key === "Enter" &&
        (event.ctrlKey || event.metaKey)
      ) {
        guard.submitKeyboardShortcutUsed = true;
        guard.externalPublishAttempted = true;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("keydown", onKeyDown, true);
    cleanup.push(() => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("keydown", onKeyDown, true);
    });

    const originalFetch = window.fetch;
    window.fetch = async (request, init) => {
      const method =
        init?.method ??
        (request instanceof Request ? request.method : "GET");
      if (!isReadMethod(method)) {
        guard.externalPublishAttempted = true;
        throw new TypeError("CMOOC_QUILL_STAGE_MUTATION_BLOCKED");
      }
      return originalFetch.call(window, request, init);
    };
    cleanup.push(() => {
      window.fetch = originalFetch;
    });

    type XhrOpen = (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null
    ) => void;
    type XhrSend = (
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null
    ) => void;
    const xhrMethods = new WeakMap<XMLHttpRequest, string>();
    const originalXhrOpen =
      XMLHttpRequest.prototype.open as XhrOpen;
    const originalXhrSend =
      XMLHttpRequest.prototype.send as XhrSend;
    const guardedXhrOpen: XhrOpen = function (
      method,
      url,
      async = true,
      username = null,
      password = null
    ) {
      xhrMethods.set(this, method);
      originalXhrOpen.call(
        this,
        method,
        url,
        async,
        username,
        password
      );
    };
    const guardedXhrSend: XhrSend = function (body) {
      const method = xhrMethods.get(this) ?? "GET";
      if (!isReadMethod(method)) {
        guard.externalPublishAttempted = true;
        this.abort();
        throw new Error("CMOOC_QUILL_STAGE_MUTATION_BLOCKED");
      }
      originalXhrSend.call(this, body);
    };
    XMLHttpRequest.prototype.open = guardedXhrOpen;
    XMLHttpRequest.prototype.send = guardedXhrSend;
    cleanup.push(() => {
      XMLHttpRequest.prototype.open = originalXhrOpen;
      XMLHttpRequest.prototype.send = originalXhrSend;
    });

    const originalFormSubmit = HTMLFormElement.prototype.submit;
    const originalRequestSubmit =
      HTMLFormElement.prototype.requestSubmit;
    HTMLFormElement.prototype.submit = function () {
      guard.formSubmitTriggered = true;
      guard.externalPublishAttempted = true;
    };
    HTMLFormElement.prototype.requestSubmit = function () {
      guard.formSubmitTriggered = true;
      guard.externalPublishAttempted = true;
    };
    cleanup.push(() => {
      HTMLFormElement.prototype.submit = originalFormSubmit;
      HTMLFormElement.prototype.requestSubmit =
        originalRequestSubmit;
    });

    const hadOwnBeacon = Object.prototype.hasOwnProperty.call(
      navigator,
      "sendBeacon"
    );
    const originalBeacon = navigator.sendBeacon;
    try {
      Object.defineProperty(navigator, "sendBeacon", {
        configurable: true,
        value: () => {
          guard.externalPublishAttempted = true;
          return false;
        }
      });
      cleanup.push(() => {
        if (hadOwnBeacon) {
          Object.defineProperty(navigator, "sendBeacon", {
            configurable: true,
            value: originalBeacon
          });
        } else {
          Reflect.deleteProperty(navigator, "sendBeacon");
        }
      });
    } catch {
      // The remaining guards still fail closed for fetch, XHR, forms,
      // controls, and submit shortcuts when sendBeacon is non-configurable.
    }

    initialGuard.publishControlActivated =
      guard.publishControlActivated;
    initialGuard.submitKeyboardShortcutUsed =
      guard.submitKeyboardShortcutUsed;
    initialGuard.formSubmitTriggered =
      guard.formSubmitTriggered;
    initialGuard.externalPublishAttempted =
      guard.externalPublishAttempted;

    rememberOwnedEditor(editor);
    editorTouched = true;
    replaceWithLogicalText(editor, input.transientDraft);
    await waitForSettle();
    editor = reassertOwnedEditor(editor);
    editorValue = readLogicalEditorText(editor);
    if (editorValue !== draft) {
      throw new Error("CMOOC_QUILL_STAGE_EDITOR_READBACK_MISMATCH");
    }
    guardAfterWrite = cloneGuard(guard);
  } catch (error) {
    errorCode = safeErrorCode(error);
  } finally {
    if (editorTouched) {
      try {
        if (editor) {
          editor = reassertOwnedEditor(editor);
        }
      } catch {
        // The page may have drifted while the transaction was running.  The
        // detached/owned node sweep below is still required even when a final
        // identity check cannot be completed.
      }
      try {
        clearAllOwnedEditors();
        await waitForSettle();
        const finalEditor = assertPageAndEditor();
        editorEmptyAfterClear = editorIsEmpty(finalEditor);
      } catch {
        editorEmptyAfterClear = false;
      }
      if (!editorEmptyAfterClear && !errorCode) {
        errorCode = "CMOOC_QUILL_STAGE_EDITOR_CLEAR_FAILED";
      }
    }
    guardAfterClear = cloneGuard(guard);
    for (const restore of cleanup.reverse()) {
      try {
        restore();
      } catch {
        errorCode ??=
          "CMOOC_QUILL_STAGE_GUARD_RESTORE_FAILED";
      }
    }
  }

  return {
    errorCode,
    origin: location.origin,
    pageReady: ['interactive', 'complete'].includes(
      document.readyState
    ),
    editorVisible: editor ? visible(editor) : false,
    editorTouched,
    editorValue,
    editorEmptyAfterClear,
    guardAfterAttach: initialGuard,
    guardAfterWrite,
    guardAfterClear
  };
}

async function emergencyClearOwnedQuillEditor(input: {
  editorSelector: string;
  runNonceHash: string;
}): Promise<EmergencyClearResult> {
  const editors = Array.from(
    document.querySelectorAll(input.editorSelector)
  ).filter(
    (value): value is HTMLElement => value instanceof HTMLElement
  );
  if (editors.length === 0) return "editor_missing";
  let cleared = 0;
  for (const editor of editors) {
    if (editor.dataset.cmoocStageRun !== input.runNonceHash) {
      continue;
    }
    const paragraph = document.createElement("p");
    paragraph.appendChild(document.createElement("br"));
    editor.replaceChildren(paragraph);
    editor.dispatchEvent(
      new Event("input", { bubbles: true })
    );
    delete editor.dataset.cmoocStageRun;
    cleared += 1;
  }
  return cleared > 0 ? "cleared" : "not_owned";
}

async function inspectCmoocQuillStageBaseline(input: {
  expectedOrigin: string;
  expectedTargetUrl: string;
  editorSelector: string;
}): Promise<CmoocQuillStageBaseline> {
  const normalizeUrl = (value: string) => {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  };
  const visible = (element: HTMLElement) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const logicalText = (element: HTMLElement) =>
    (element.innerText || element.textContent || "")
      .replace(/\r\n?/gu, "\n")
      .replace(/[\t\f\v ]+/gu, " ")
      .replace(/ *\n */gu, "\n")
      .trim();
  const editors = Array.from(document.querySelectorAll(input.editorSelector)).filter(
    (value): value is HTMLElement => value instanceof HTMLElement && visible(value)
  );
  return {
    pageReady:
      location.origin === input.expectedOrigin &&
      normalizeUrl(location.href) === normalizeUrl(input.expectedTargetUrl) &&
      ["interactive", "complete"].includes(document.readyState),
    editorVisible: editors.length === 1,
    editorEmpty: editors.length === 1 && logicalText(editors[0]) === ""
  };
}

async function reconcileOwnedCmoocQuillStageEditor(input: {
  expectedOrigin: string;
  expectedTargetUrl: string;
  editorSelector: string;
  runNonceHash: string;
  transientDraft: string;
}): Promise<CmoocQuillStageReconcileResult> {
  const normalize = (value: string) =>
    value.replace(/\r\n?/gu, "\n").normalize("NFC");
  const normalizeUrl = (value: string) => {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  };
  const visible = (element: HTMLElement) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const logicalText = (editor: Element) => {
    const nodes = Array.from(editor.childNodes);
    if (nodes.length === 0) return "";
    const lines = nodes.map((node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      if (!(node instanceof Element)) return "";
      if (node.tagName === "BR" || (node.textContent ?? "") === "") return "";
      return node.textContent ?? "";
    });
    if (lines.length === 1 && lines[0] === "") return "";
    return normalize(lines.join("\n"));
  };
  const editors = Array.from(document.querySelectorAll(input.editorSelector)).filter(
    (value): value is HTMLElement => value instanceof HTMLElement && visible(value)
  );
  if (
    location.origin !== input.expectedOrigin ||
    normalizeUrl(location.href) !== normalizeUrl(input.expectedTargetUrl) ||
    editors.length !== 1
  ) {
    return {
      status: "editor_missing",
      editorReadbackVerified: false,
      editorEmptyAfterClear: false,
      editorClearCount: 0
    };
  }
  const editor = editors[0];
  const current = logicalText(editor);
  if (editor.dataset.cmoocStageRun !== input.runNonceHash) {
    return {
      status: current === "" ? "already_empty_not_owned" : "blocked_unowned_content",
      editorReadbackVerified: false,
      editorEmptyAfterClear: current === "",
      editorClearCount: 0
    };
  }
  if (current !== normalize(input.transientDraft)) {
    return {
      status: "blocked_owned_content_mismatch",
      editorReadbackVerified: false,
      editorEmptyAfterClear: false,
      editorClearCount: 0
    };
  }
  const paragraph = document.createElement("p");
  paragraph.appendChild(document.createElement("br"));
  editor.replaceChildren(paragraph);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  delete editor.dataset.cmoocStageRun;
  const empty = logicalText(editor) === "";
  return {
    status: empty ? "owned_draft_cleared" : "blocked_owned_content_mismatch",
    editorReadbackVerified: true,
    editorEmptyAfterClear: empty,
    editorClearCount: empty ? 1 : 0
  };
}

async function executeSerializedDomTransaction(input: {
  source: string;
  transactionInput: DomTransactionInput;
}): Promise<DomTransactionResult> {
  const scope = globalThis as typeof globalThis & {
    __name?: ObjectConstructor;
  };
  const hadOwnName = Object.prototype.hasOwnProperty.call(
    scope,
    "__name"
  );
  const previousName = scope.__name;
  scope.__name = Object;
  try {
    const transaction = Reflect.apply(
      globalThis.eval,
      globalThis,
      [`(${input.source})`]
    ) as (
      value: DomTransactionInput
    ) => Promise<DomTransactionResult>;
    return await transaction(input.transactionInput);
  } finally {
    if (hadOwnName) {
      scope.__name = previousName;
    } else {
      delete scope.__name;
    }
  }
}

async function executeSerializedBrowserFunction<Argument, Result>(input: {
  source: string;
  argument: Argument;
}): Promise<Result> {
  const scope = globalThis as typeof globalThis & {
    __name?: ObjectConstructor;
  };
  const hadOwnName = Object.prototype.hasOwnProperty.call(scope, "__name");
  const previousName = scope.__name;
  scope.__name = Object;
  try {
    const operation = Reflect.apply(globalThis.eval, globalThis, [
      `(${input.source})`
    ]) as (value: Argument) => Promise<Result>;
    return await operation(input.argument);
  } finally {
    if (hadOwnName) scope.__name = previousName;
    else delete scope.__name;
  }
}

export class CmoocQuillStageCompanionDriver
implements AtomicStageCompanionDriver {
  readonly #bridge: CmoocQuillStageBrowserBridge;
  readonly #expectedPage: StageCompanionPageState;
  readonly #expectedTargetUrl: string;
  readonly #editorSelector: string;
  readonly #submitControlSelector: string;
  readonly #operationTimeoutMs: number;
  readonly #settleMs: number;

  constructor(input: {
    bridge: CmoocQuillStageBrowserBridge;
    expectedPage: StageCompanionPageState;
    expectedTargetUrl: string;
    editorSelector?: string;
    submitControlSelector?: string;
    operationTimeoutMs?: number;
    settleMs?: number;
  }) {
    const operationTimeoutMs =
      input.operationTimeoutMs ??
      DEFAULT_CMOOC_QUILL_STAGE_TIMEOUT_MS;
    const settleMs = input.settleMs ?? 75;
    const targetUrl = normalizedTargetUrl(
      input.expectedTargetUrl
    );
    if (
      new URL(targetUrl).origin !==
      input.expectedPage.origin ||
      operationTimeoutMs < 30_000 ||
      operationTimeoutMs > 120_000 ||
      !Number.isSafeInteger(operationTimeoutMs) ||
      settleMs < 0 ||
      settleMs > 1_000 ||
      !Number.isSafeInteger(settleMs)
    ) {
      throw new Error("CMOOC_QUILL_STAGE_DRIVER_OPTIONS_INVALID");
    }
    this.#bridge = input.bridge;
    this.#expectedPage = { ...input.expectedPage };
    this.#expectedTargetUrl = targetUrl;
    this.#editorSelector =
      input.editorSelector ?? DEFAULT_EDITOR_SELECTOR;
    this.#submitControlSelector =
      input.submitControlSelector ??
      DEFAULT_SUBMIT_CONTROL_SELECTOR;
    this.#operationTimeoutMs = operationTimeoutMs;
    this.#settleMs = settleMs;
  }

  async inspectBaseline(): Promise<CmoocQuillStageBaseline> {
    const result = await this.#bridge.evaluate<
      CmoocQuillStageBaseline,
      {
        source: string;
        argument: {
          expectedOrigin: string;
          expectedTargetUrl: string;
          editorSelector: string;
        };
      }
    >(
      executeSerializedBrowserFunction,
      {
        source: inspectCmoocQuillStageBaseline.toString(),
        argument: {
          expectedOrigin: this.#expectedPage.origin,
          expectedTargetUrl: this.#expectedTargetUrl,
          editorSelector: this.#editorSelector
        }
      },
      { timeoutMs: this.#operationTimeoutMs }
    );
    return Object.freeze({ ...result });
  }

  async reconcileOwned(input: {
    runNonceHash: string;
    transientDraft: string;
  }): Promise<CmoocQuillStageReconcileResult> {
    if (
      !HASH_PATTERN.test(input.runNonceHash) ||
      normalizeTransientDraftBody(input.transientDraft) === ""
    ) {
      throw new Error("CMOOC_QUILL_STAGE_RECONCILE_INPUT_INVALID");
    }
    const result = await this.#bridge.evaluate<
      CmoocQuillStageReconcileResult,
      {
        source: string;
        argument: {
          expectedOrigin: string;
          expectedTargetUrl: string;
          editorSelector: string;
          runNonceHash: string;
          transientDraft: string;
        };
      }
    >(
      executeSerializedBrowserFunction,
      {
        source: reconcileOwnedCmoocQuillStageEditor.toString(),
        argument: {
          expectedOrigin: this.#expectedPage.origin,
          expectedTargetUrl: this.#expectedTargetUrl,
          editorSelector: this.#editorSelector,
          runNonceHash: input.runNonceHash,
          transientDraft: input.transientDraft
        }
      },
      { timeoutMs: this.#operationTimeoutMs }
    );
    return Object.freeze({ ...result });
  }

  async executeStageTransaction(input: {
    runNonceHash: string;
    expectedGuardReceiptHash: string;
    transientDraft: string;
  }): Promise<AtomicStageCompanionTransaction> {
    if (
      !HASH_PATTERN.test(input.runNonceHash) ||
      !HASH_PATTERN.test(input.expectedGuardReceiptHash) ||
      normalizeTransientDraftBody(input.transientDraft) === ""
    ) {
      throw new Error("CMOOC_QUILL_STAGE_TRANSACTION_INPUT_INVALID");
    }
    let result: DomTransactionResult;
    try {
      result = await this.#bridge.evaluate(
        executeSerializedDomTransaction,
        {
          source:
            runCmoocQuillStageDomTransaction.toString(),
          transactionInput: {
            expectedOrigin: this.#expectedPage.origin,
            expectedTargetUrl: this.#expectedTargetUrl,
            editorSelector: this.#editorSelector,
            submitControlSelector:
              this.#submitControlSelector,
            runNonceHash: input.runNonceHash,
            transientDraft: input.transientDraft,
            settleMs: this.#settleMs
          }
        },
        { timeoutMs: this.#operationTimeoutMs }
      );
    } catch {
      const cleanup = await this.#emergencyClear(
        input.runNonceHash
      );
      throw new Error(
        cleanup === "editor_missing"
          ? "CMOOC_QUILL_STAGE_FAILURE_CLEAR_UNKNOWN"
          : "CMOOC_QUILL_STAGE_TRANSACTION_FAILED_CLEARED"
      );
    }
    if (result.errorCode) {
      if (
        result.editorTouched &&
        !result.editorEmptyAfterClear
      ) {
        const cleanup = await this.#emergencyClear(
          input.runNonceHash
        );
        throw new Error(
          cleanup === "cleared"
            ? "CMOOC_QUILL_STAGE_FAILURE_CLEAR_RECOVERED"
            : "CMOOC_QUILL_STAGE_FAILURE_CLEAR_UNKNOWN"
        );
      }
      throw new Error(result.errorCode);
    }
    if (
      !result.pageReady ||
      !result.editorVisible ||
      !result.editorTouched
    ) {
      throw new Error("CMOOC_QUILL_STAGE_PAGE_GUARD_FAILED");
    }
    if (!result.editorEmptyAfterClear) {
      const cleanup = await this.#emergencyClear(
        input.runNonceHash
      );
      throw new Error(
        cleanup === "cleared"
          ? "CMOOC_QUILL_STAGE_EDITOR_CLEAR_RECOVERED"
          : "CMOOC_QUILL_STAGE_EDITOR_CLEAR_UNKNOWN"
      );
    }
    const state = pageState(
      this.#expectedPage,
      result.origin
    );
    return {
      pageBeforeWrite: { ...state },
      pageAfterWrite: { ...state },
      pageAfterClear: { ...state },
      guardAfterAttach: guardState(
        result.guardAfterAttach,
        input.expectedGuardReceiptHash
      ),
      guardAfterWrite: guardState(
        result.guardAfterWrite,
        input.expectedGuardReceiptHash
      ),
      guardAfterClear: guardState(
        result.guardAfterClear,
        input.expectedGuardReceiptHash
      ),
      editorValue: result.editorValue,
      editorEmptyAfterClear: true
    };
  }

  async #emergencyClear(
    runNonceHash: string
  ): Promise<EmergencyClearResult> {
    try {
      return await this.#bridge.evaluate(
        emergencyClearOwnedQuillEditor,
        {
          editorSelector: this.#editorSelector,
          runNonceHash
        },
        { timeoutMs: this.#operationTimeoutMs }
      );
    } catch {
      return "editor_missing";
    }
  }
}

function isTransientScreenshotFailure(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : String(error);
  return /Page\.captureScreenshot|CDP[^\n]*(?:timeout|timed out|closed)|screenshot[^\n]*(?:timeout|timed out)/i.test(
    message
  );
}

/**
 * Screenshot evidence is intentionally outside the STAGE transaction. A
 * transient CDP capture failure can be retried without replaying editor writes
 * or any publication action.
 */
export async function captureBrowserScreenshotWithRetry(input: {
  capture: () => Promise<Uint8Array>;
  maxAttempts?: number;
}): Promise<Uint8Array> {
  const maxAttempts = input.maxAttempts ?? 2;
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 3
  ) {
    throw new Error("SCREENSHOT_RETRY_LIMIT_INVALID");
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await input.capture();
    } catch (error) {
      lastError = error;
      if (
        !isTransientScreenshotFailure(error) ||
        attempt === maxAttempts
      ) {
        throw error;
      }
    }
  }
  throw lastError;
}
