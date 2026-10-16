import { assertAllowedForumUrl } from "../forum/allowed-url";
import {
  canonicalProtocolHash,
  type BoundTargetV1,
  type CanonicalJsonValue,
  type ExecutionCommandV1,
  type ExecutionReceiptV1,
  type ObservationEnvelopeV1
} from "../facilitation-protocol";
import {
  ADAPTER_MANIFEST_SCHEMA_VERSION,
  FORUM_ADAPTER_CONTRACT_VERSION,
  THREAD_PAGE_SCHEMA_VERSION,
  assertAdapterManifest,
  assertForumScope,
  assertTargetRef,
  assertThreadPage,
  assertThreadRef,
  type AdapterManifest,
  type AuthSummary,
  type ForumAdapter,
  type ForumScope,
  type PreflightReceipt,
  type TargetRef,
  type ThreadPage,
  type ThreadRef
} from "./contract";
import {
  adapterEvidenceHash,
  adapterNow,
  buildAuthSummary,
  buildBoundTarget,
  buildExecutionReceipt,
  buildObservationEnvelope,
  buildPreflightReceipt,
  commandExpired,
  type AdapterClock
} from "./shared";

export interface BrowserDiagnosticAuthSnapshot {
  authenticated: boolean | null;
  readable: boolean;
}

export interface BrowserDiagnosticThreadListItem {
  locator: string;
  titleText: string;
  visibleStateText: string;
  replyCount: number;
  latestEventAt: string | null;
}

export interface BrowserDiagnosticCommentDetail {
  stableCommentRef: string;
  parentRef: string | null;
  authorStableRef: string | null;
  contentText: string;
  createdAt: string | null;
  editedAt: string | null;
}

export interface BrowserDiagnosticThreadDetail {
  locator: string;
  authorStableRef: string | null;
  titleText: string;
  contentText: string;
  createdAt: string | null;
  editedAt: string | null;
  comments: BrowserDiagnosticCommentDetail[];
}

/**
 * The adapter can only invoke these three observation operations. A concrete
 * browser integration remains responsible for enforcing the same no-write rule.
 */
export interface BrowserDiagnosticProbe {
  readonly inspectAuth: () => Promise<BrowserDiagnosticAuthSnapshot>;
  readonly readThreadList: (input: {
    forumListUrl: string;
    maxThreads: number;
  }) => Promise<BrowserDiagnosticThreadListItem[]>;
  readonly readThreadDetail: (input: {
    threadUrl: string;
  }) => Promise<BrowserDiagnosticThreadDetail | null>;
}

export interface CmoocBrowserDiagnosticAdapterOptions {
  probe: BrowserDiagnosticProbe;
  clock?: AdapterClock;
  adapterId?: string;
  adapterVersion?: string;
  defaultForumListUrl?: string;
  defaultLimit?: number;
}

type StoredReceipt = {
  commandHash: string;
  receipt: ExecutionReceiptV1;
};

const STABLE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SENSITIVE_QUERY_MARKERS = [
  "token",
  "auth",
  "authorization",
  "cookie",
  "session",
  "password",
  "secret",
  "credential",
  "jwt"
] as const;

function assertAllowedDiagnosticUrl(
  value: string,
  label: string
): string {
  const locator = assertAllowedForumUrl(value, label);
  for (const key of new URL(locator).searchParams.keys()) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
    if (
      SENSITIVE_QUERY_MARKERS.some((marker) =>
        normalizedKey.includes(marker)
      )
    ) {
      throw new Error(
        "CMOOC_BROWSER_DIAGNOSTIC_SENSITIVE_QUERY_FORBIDDEN"
      );
    }
  }
  return locator;
}

function assertStableRef(value: unknown, label: string): void {
  if (
    typeof value !== "string" ||
    !STABLE_REF_PATTERN.test(value)
  ) {
    throw new Error(`INVALID_BROWSER_DIAGNOSTIC_STABLE_REF: ${label}`);
  }
}

function assertText(value: unknown, label: string): void {
  if (typeof value !== "string") {
    throw new Error(`INVALID_BROWSER_DIAGNOSTIC_TEXT: ${label}`);
  }
}

function assertNullableTime(
  value: unknown,
  label: string
): void {
  if (
    value !== null &&
    (typeof value !== "string" ||
      value.trim() === "" ||
      !Number.isFinite(Date.parse(value)))
  ) {
    throw new Error(`INVALID_BROWSER_DIAGNOSTIC_TIME: ${label}`);
  }
}

export function cmoocBrowserStableThreadRef(locator: string): string {
  let candidate: string | null = null;
  try {
    const url = new URL(locator);
    candidate =
      url.searchParams.get("id") ??
      url.pathname.match(/\d{8,}/)?.[0] ??
      null;
  } catch {
    candidate = locator.match(/\d{8,}/)?.[0] ?? null;
  }
  if (!candidate || !/^\d{8,127}$/.test(candidate)) {
    throw new Error("CMOOC_BROWSER_STABLE_THREAD_REF_REQUIRED");
  }
  return candidate;
}

export class CmoocBrowserDiagnosticAdapter implements ForumAdapter {
  readonly #adapterId: string;
  readonly #adapterVersion: string;
  readonly #defaultForumListUrl?: string;
  readonly #defaultLimit: number;
  readonly #probe: BrowserDiagnosticProbe;
  readonly #clock: AdapterClock;
  readonly #issuedThreadRefs = new Map<string, string>();
  readonly #receipts = new Map<string, StoredReceipt>();

  constructor(options: CmoocBrowserDiagnosticAdapterOptions) {
    if (
      !options ||
      typeof options.probe !== "object" ||
      options.probe === null ||
      typeof options.probe.inspectAuth !== "function" ||
      typeof options.probe.readThreadList !== "function" ||
      typeof options.probe.readThreadDetail !== "function"
    ) {
      throw new Error("BROWSER_DIAGNOSTIC_PROBE_REQUIRED");
    }
    this.#adapterId = options.adapterId ?? "cmooc.browser-diagnostic";
    this.#adapterVersion = options.adapterVersion ?? "p4b.2";
    this.#defaultForumListUrl = options.defaultForumListUrl;
    this.#defaultLimit = options.defaultLimit ?? 20;
    this.#probe = options.probe;
    this.#clock = options.clock ?? (() => new Date());
    if (
      !Number.isSafeInteger(this.#defaultLimit) ||
      this.#defaultLimit < 1 ||
      this.#defaultLimit > 100
    ) {
      throw new Error("INVALID_CMOOC_BROWSER_DIAGNOSTIC_LIMIT");
    }
    assertAdapterManifest(this.manifest());
  }

  manifest(): AdapterManifest {
    return {
      schemaVersion: ADAPTER_MANIFEST_SCHEMA_VERSION,
      contractVersion: FORUM_ADAPTER_CONTRACT_VERSION,
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      platformId: "cmooc.bnu",
      transport: "browser_diagnostic",
      externalWriteMode: "none",
      supportsVirtualClock: false,
      capabilities: {
        inspectAuth: true,
        listThreads: true,
        observeThread: true,
        bindTarget: true,
        preflight: true,
        executeAuthorized: false
      },
      containsForumText: false
    };
  }

  async inspectAuth(): Promise<AuthSummary> {
    const snapshot = await this.#probe.inspectAuth();
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      !(
        snapshot.authenticated === null ||
        typeof snapshot.authenticated === "boolean"
      ) ||
      typeof snapshot.readable !== "boolean"
    ) {
      throw new Error("INVALID_BROWSER_DIAGNOSTIC_AUTH_SNAPSHOT");
    }
    const status =
      snapshot.authenticated === true
        ? "authenticated"
        : snapshot.authenticated === false
          ? "unauthenticated"
          : "unknown";
    return buildAuthSummary({
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      status,
      canRead: snapshot.readable,
      canExecuteAuthorized: false,
      checkedAt: adapterNow(this.#clock),
      messageCode: snapshot.readable
        ? "browser_diagnostic_readable"
        : "browser_diagnostic_unreadable",
      evidence: {
        authenticated: snapshot.authenticated,
        readable: snapshot.readable
      }
    });
  }

  async listThreads(
    scopeInput: ForumScope,
    cursor?: string
  ): Promise<ThreadPage> {
    const scope = assertForumScope(scopeInput);
    if (cursor !== undefined) {
      throw new Error("CMOOC_BROWSER_DIAGNOSTIC_CURSOR_UNSUPPORTED");
    }
    const forumListUrl = assertAllowedDiagnosticUrl(
      scope.locator ?? this.#defaultForumListUrl ?? "",
      "cMOOC 浏览器诊断列表地址"
    );
    const locatedCourseRef = new URL(forumListUrl).searchParams.get(
      "courseId"
    );
    if (
      locatedCourseRef === null ||
      locatedCourseRef !== scope.platformCourseRef
    ) {
      throw new Error("CMOOC_BROWSER_DIAGNOSTIC_COURSE_REF_MISMATCH");
    }
    const limit = scope.limit ?? this.#defaultLimit;
    const snapshots = await this.#probe.readThreadList({
      forumListUrl,
      maxThreads: limit
    });
    if (!Array.isArray(snapshots)) {
      throw new Error("INVALID_BROWSER_DIAGNOSTIC_THREAD_LIST");
    }
    const stableRefs = new Set<string>();
    const items = snapshots.slice(0, limit).map((snapshot) => {
      if (
        typeof snapshot !== "object" ||
        snapshot === null
      ) {
        throw new Error(
          "INVALID_BROWSER_DIAGNOSTIC_THREAD_LIST_ITEM"
        );
      }
      const locator = assertAllowedDiagnosticUrl(
        snapshot.locator,
        "cMOOC 浏览器诊断帖子地址"
      );
      const stableThreadRef = cmoocBrowserStableThreadRef(locator);
      if (stableRefs.has(stableThreadRef)) {
        throw new Error(
          "CMOOC_BROWSER_DIAGNOSTIC_DUPLICATE_THREAD_REF"
        );
      }
      stableRefs.add(stableThreadRef);
      assertText(snapshot.titleText, "titleText");
      assertText(snapshot.visibleStateText, "visibleStateText");
      if (
        !Number.isSafeInteger(snapshot.replyCount) ||
        snapshot.replyCount < 0
      ) {
        throw new Error(
          "CMOOC_BROWSER_DIAGNOSTIC_INVALID_REPLY_COUNT"
        );
      }
      assertNullableTime(snapshot.latestEventAt, "latestEventAt");
      return {
        threadRef: {
          threadKey: stableThreadRef,
          courseKey: scope.courseKey,
          platformCourseRef: scope.platformCourseRef,
          stableThreadRef,
          locator
        },
        titleHash: adapterEvidenceHash(
          "browser-diagnostic-thread-title",
          snapshot.titleText
        ),
        stateHintHash: adapterEvidenceHash(
          "browser-diagnostic-thread-state-hint",
          {
            stableThreadRef,
            visibleStateText: snapshot.visibleStateText,
            replyCount: snapshot.replyCount,
            latestEventAt: snapshot.latestEventAt
          }
        ),
        replyCount: snapshot.replyCount,
        latestEventAt: snapshot.latestEventAt,
        containsForumText: false as const
      };
    });
    for (const item of items) {
      this.#issuedThreadRefs.set(
        this.#issuedThreadKey(item.threadRef),
        canonicalProtocolHash(
          "cmooc.browser-diagnostic-thread-ref.v1",
          item.threadRef as unknown as CanonicalJsonValue
        )
      );
    }
    return assertThreadPage({
      schemaVersion: THREAD_PAGE_SCHEMA_VERSION,
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      courseKey: scope.courseKey,
      observedAt: adapterNow(this.#clock),
      items,
      nextCursor: null,
      containsForumText: false
    });
  }

  async observeThread(
    refInput: ThreadRef
  ): Promise<ObservationEnvelopeV1> {
    const ref = this.#validatedThreadRef(refInput);
    const detail = await this.#threadDetail(ref);
    const observedAt = adapterNow(this.#clock);
    return buildObservationEnvelope({
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      observationKey: `observation:${adapterEvidenceHash(
        "browser-diagnostic-observation-key",
        {
          stableThreadRef: ref.stableThreadRef,
          observedAt
        }
      ).slice(0, 24)}`,
      threadKey: ref.threadKey,
      courseKey: ref.courseKey,
      observedAt,
      evidenceAsOf: observedAt,
      sourceObservedThrough: observedAt,
      timeBasis: "utc",
      temporalEvidenceStatus: "as_of_unverified",
      contentRevisionStatus: "final_export_revision_unknown",
      eventCount: detail.comments.length + 1,
      state: this.#threadState(detail, ref.stableThreadRef)
    });
  }

  async bindTarget(refInput: TargetRef): Promise<BoundTargetV1> {
    const ref = assertTargetRef(refInput);
    const threadRef = this.#validatedThreadRef(ref.thread);
    const detail = await this.#threadDetail(threadRef);
    const targetState =
      ref.targetType === "thread"
        ? {
            targetType: "thread",
            stableTargetRef: ref.stableTargetRef,
            authorStableRef: detail.authorStableRef,
            titleText: detail.titleText,
            contentText: detail.contentText,
            createdAt: detail.createdAt,
            editedAt: detail.editedAt
          }
        : this.#commentTargetState(detail, ref.stableTargetRef);
    return buildBoundTarget({
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      threadKey: ref.thread.threadKey,
      targetType: ref.targetType,
      targetObject: ref.targetObject,
      stableTargetRef: ref.stableTargetRef,
      contentRevisionStatus: "final_export_revision_unknown",
      boundAt: adapterNow(this.#clock),
      targetState
    });
  }

  async preflight(
    command: ExecutionCommandV1
  ): Promise<PreflightReceipt> {
    const checkedAt = adapterNow(this.#clock);
    if (commandExpired(command, checkedAt)) {
      return buildPreflightReceipt({
        adapterId: this.#adapterId,
        adapterVersion: this.#adapterVersion,
        command,
        status: "command_expired",
        checkedAt,
        messageCode: "command_expired"
      });
    }
    return buildPreflightReceipt({
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      command,
      status: "denied",
      checkedAt,
      messageCode: "browser_diagnostic_external_write_disabled",
      evidence: {
        adapterId: this.#adapterId,
        externalWriteMode: "none",
        commandId: command.commandId
      }
    });
  }

  async executeAuthorized(
    command: ExecutionCommandV1
  ): Promise<ExecutionReceiptV1> {
    const commandHash = canonicalProtocolHash(
      command.schemaVersion,
      command
    );
    const stored = this.#receipts.get(command.idempotencyKey);
    if (stored) {
      if (stored.commandHash !== commandHash) {
        throw new Error("IDEMPOTENCY_KEY_CONFLICT");
      }
      return stored.receipt;
    }
    const preflight = await this.preflight(command);
    const receipt = buildExecutionReceipt({
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      command,
      outcome: "confirmed_not_attempted",
      attemptedAt: null,
      recordedAt: preflight.checkedAt,
      remoteObjectRefHash: null,
      evidenceHash: preflight.evidenceHash,
      messageCode: preflight.messageCode
    });
    this.#receipts.set(command.idempotencyKey, {
      commandHash,
      receipt
    });
    return receipt;
  }

  #validatedThreadRef(refInput: ThreadRef): ThreadRef {
    const ref = assertThreadRef(refInput);
    const locator = assertAllowedDiagnosticUrl(
      ref.locator,
      "cMOOC 浏览器诊断帖子地址"
    );
    if (
      cmoocBrowserStableThreadRef(locator) !== ref.stableThreadRef
    ) {
      throw new Error(
        "CMOOC_BROWSER_DIAGNOSTIC_THREAD_REF_MISMATCH"
      );
    }
    const normalized = { ...ref, locator };
    const issuedHash = this.#issuedThreadRefs.get(
      this.#issuedThreadKey(normalized)
    );
    if (
      issuedHash !==
      canonicalProtocolHash(
        "cmooc.browser-diagnostic-thread-ref.v1",
        normalized as unknown as CanonicalJsonValue
      )
    ) {
      throw new Error(
        "CMOOC_BROWSER_DIAGNOSTIC_THREAD_REF_NOT_ISSUED"
      );
    }
    return normalized;
  }

  #issuedThreadKey(ref: ThreadRef): string {
    return [
      ref.courseKey,
      ref.platformCourseRef,
      ref.stableThreadRef
    ].join("\0");
  }

  async #threadDetail(
    ref: ThreadRef
  ): Promise<BrowserDiagnosticThreadDetail> {
    const detail = await this.#probe.readThreadDetail({
      threadUrl: ref.locator
    });
    if (typeof detail !== "object" || detail === null) {
      throw new Error("CMOOC_BROWSER_DIAGNOSTIC_THREAD_NOT_FOUND");
    }
    const detailLocator = assertAllowedDiagnosticUrl(
      detail.locator,
      "cMOOC 浏览器诊断返回地址"
    );
    if (
      cmoocBrowserStableThreadRef(detailLocator) !==
      ref.stableThreadRef
    ) {
      throw new Error(
        "CMOOC_BROWSER_DIAGNOSTIC_RETURNED_THREAD_REF_MISMATCH"
      );
    }
    assertText(detail.titleText, "detail.titleText");
    assertText(detail.contentText, "detail.contentText");
    if (detail.authorStableRef !== null) {
      assertStableRef(
        detail.authorStableRef,
        "detail.authorStableRef"
      );
    }
    assertNullableTime(detail.createdAt, "detail.createdAt");
    assertNullableTime(detail.editedAt, "detail.editedAt");
    if (!Array.isArray(detail.comments)) {
      throw new Error("INVALID_BROWSER_DIAGNOSTIC_COMMENTS");
    }
    const commentRefs = new Set<string>();
    for (const comment of detail.comments) {
      if (typeof comment !== "object" || comment === null) {
        throw new Error(
          "INVALID_BROWSER_DIAGNOSTIC_COMMENT"
        );
      }
      assertStableRef(
        comment.stableCommentRef,
        "comment.stableCommentRef"
      );
      if (commentRefs.has(comment.stableCommentRef)) {
        throw new Error(
          "CMOOC_BROWSER_DIAGNOSTIC_DUPLICATE_COMMENT_REF"
        );
      }
      commentRefs.add(comment.stableCommentRef);
      if (comment.parentRef !== null) {
        assertStableRef(comment.parentRef, "comment.parentRef");
      }
      if (comment.authorStableRef !== null) {
        assertStableRef(
          comment.authorStableRef,
          "comment.authorStableRef"
        );
      }
      assertText(comment.contentText, "comment.contentText");
      assertNullableTime(comment.createdAt, "comment.createdAt");
      assertNullableTime(comment.editedAt, "comment.editedAt");
    }
    return {
      ...detail,
      locator: detailLocator,
      comments: [...detail.comments].sort((left, right) =>
        left.stableCommentRef.localeCompare(right.stableCommentRef)
      )
    };
  }

  #commentTargetState(
    detail: BrowserDiagnosticThreadDetail,
    stableCommentRef: string
  ): CanonicalJsonValue {
    const comments = detail.comments.filter(
      (candidate) =>
        candidate.stableCommentRef === stableCommentRef
    );
    if (comments.length !== 1) {
      throw new Error(
        "CMOOC_BROWSER_DIAGNOSTIC_COMMENT_TARGET_NOT_FOUND"
      );
    }
    const [comment] = comments;
    return {
      targetType: "comment",
      stableTargetRef: comment.stableCommentRef,
      parentRef: comment.parentRef,
      authorStableRef: comment.authorStableRef,
      contentText: comment.contentText,
      createdAt: comment.createdAt,
      editedAt: comment.editedAt
    };
  }

  #threadState(
    detail: BrowserDiagnosticThreadDetail,
    stableThreadRef: string
  ): CanonicalJsonValue {
    return {
      stableThreadRef,
      authorStableRef: detail.authorStableRef,
      titleText: detail.titleText,
      contentText: detail.contentText,
      createdAt: detail.createdAt,
      editedAt: detail.editedAt,
      comments: detail.comments.map((comment) => ({
        stableCommentRef: comment.stableCommentRef,
        parentRef: comment.parentRef,
        authorStableRef: comment.authorStableRef,
        contentText: comment.contentText,
        createdAt: comment.createdAt,
        editedAt: comment.editedAt
      }))
    };
  }
}
