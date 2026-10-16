import { assertAllowedForumUrl } from "../forum/allowed-url";
import {
  fetchCmoocPostDetail,
  fetchCmoocSketchPosts,
  type CmoocApiPostDetail,
  type CmoocApiScannedPost
} from "../forum/cmooc-api";
import { getCmoocAuthStatus } from "../forum/cmooc-auth-status";
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

type AuthSourceState = {
  configured?: boolean;
  exists?: boolean;
  hasSatoken?: boolean;
  valid: boolean | null;
};

export interface CmoocAuthStatusView {
  readyForRealForumWrite: boolean;
  sources: {
    envSatoken: AuthSourceState;
    partnerAccount: AuthSourceState;
    playwrightStorageState: AuthSourceState;
  };
}

export interface CmoocApiAdapterDependencies {
  clock: AdapterClock;
  inspectAuth: () => Promise<CmoocAuthStatusView>;
  fetchThreads: (input: {
    forumListUrl: string;
    maxPosts: number;
  }) => Promise<CmoocApiScannedPost[]>;
  fetchThread: (input: {
    postUrl: string;
  }) => Promise<CmoocApiPostDetail | null>;
}

export interface CmoocApiAdapterOptions {
  adapterId?: string;
  adapterVersion?: string;
  defaultForumListUrl?: string;
  defaultLimit?: number;
  dependencies?: Partial<CmoocApiAdapterDependencies>;
}

type StoredReceipt = {
  commandHash: string;
  receipt: ExecutionReceiptV1;
};

const defaultDependencies: CmoocApiAdapterDependencies = {
  clock: () => new Date(),
  inspectAuth: getCmoocAuthStatus,
  fetchThreads: fetchCmoocSketchPosts,
  fetchThread: fetchCmoocPostDetail
};

export function cmoocStableThreadRef(locator: string): string {
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
    throw new Error("CMOOC_STABLE_THREAD_REF_REQUIRED");
  }
  return candidate;
}

export class CmoocApiAdapter implements ForumAdapter {
  readonly #adapterId: string;
  readonly #adapterVersion: string;
  readonly #defaultForumListUrl?: string;
  readonly #defaultLimit: number;
  readonly #dependencies: CmoocApiAdapterDependencies;
  readonly #issuedThreadRefs = new Map<string, string>();
  readonly #receipts = new Map<string, StoredReceipt>();

  constructor(options: CmoocApiAdapterOptions = {}) {
    this.#adapterId = options.adapterId ?? "cmooc.api";
    this.#adapterVersion = options.adapterVersion ?? "p4b.2";
    this.#defaultForumListUrl = options.defaultForumListUrl;
    this.#defaultLimit = options.defaultLimit ?? 20;
    this.#dependencies = {
      ...defaultDependencies,
      ...options.dependencies
    };
    if (
      !Number.isSafeInteger(this.#defaultLimit) ||
      this.#defaultLimit < 1 ||
      this.#defaultLimit > 100
    ) {
      throw new Error("INVALID_CMOOC_ADAPTER_LIMIT");
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
      transport: "api",
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
    const status = await this.#dependencies.inspectAuth();
    const sources = [
      status.sources.envSatoken,
      status.sources.partnerAccount,
      status.sources.playwrightStorageState
    ];
    const anyValid = sources.some((source) => source.valid === true);
    const anyConfigured = sources.some(
      (source) =>
        source.configured === true ||
        source.exists === true ||
        source.hasSatoken === true
    );
    const authStatus = anyValid
      ? "authenticated"
      : anyConfigured
        ? "unauthenticated"
        : "unknown";
    const checkedAt = adapterNow(this.#dependencies.clock);
    return buildAuthSummary({
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      status: authStatus,
      canRead: true,
      canExecuteAuthorized: false,
      checkedAt,
      messageCode: anyValid
        ? "read_auth_available"
        : "read_auth_unverified",
      evidence: {
        anyValid,
        anyConfigured,
        sourceValidity: sources.map((source) => source.valid)
      }
    });
  }

  async listThreads(
    scopeInput: ForumScope,
    cursor?: string
  ): Promise<ThreadPage> {
    const scope = assertForumScope(scopeInput);
    if (cursor !== undefined) {
      throw new Error("CMOOC_API_CURSOR_UNSUPPORTED");
    }
    const forumListUrl = assertAllowedForumUrl(
      scope.locator ?? this.#defaultForumListUrl ?? "",
      "cMOOC adapter 列表地址"
    );
    const locatedCourseRef = new URL(forumListUrl).searchParams.get(
      "courseId"
    );
    if (
      locatedCourseRef === null ||
      locatedCourseRef !== scope.platformCourseRef
    ) {
      throw new Error("CMOOC_COURSE_REF_MISMATCH");
    }
    const posts = await this.#dependencies.fetchThreads({
      forumListUrl,
      maxPosts: scope.limit ?? this.#defaultLimit
    });
    const observedAt = adapterNow(this.#dependencies.clock);
    const stableRefs = new Set<string>();
    const items = posts
      .slice(0, scope.limit ?? this.#defaultLimit)
      .map((post) => {
      const locator = assertAllowedForumUrl(
        post.url,
        "cMOOC adapter 帖子地址"
      );
      const stableThreadRef = cmoocStableThreadRef(locator);
      if (stableRefs.has(stableThreadRef)) {
        throw new Error("CMOOC_DUPLICATE_THREAD_REF");
      }
      stableRefs.add(stableThreadRef);
      const replyCount = post.commentCount ?? 0;
      if (!Number.isSafeInteger(replyCount) || replyCount < 0) {
        throw new Error("CMOOC_INVALID_REPLY_COUNT");
      }
      return {
        threadRef: {
          threadKey: stableThreadRef,
          courseKey: scope.courseKey,
          platformCourseRef: scope.platformCourseRef,
          stableThreadRef,
          locator
        },
        titleHash: adapterEvidenceHash(
          "thread-title",
          post.titleCandidate
        ),
        stateHintHash: adapterEvidenceHash("thread-state-hint", {
          stableThreadRef,
          cardText: post.cardText,
          createdTime: post.createdTime ?? null,
          commentCount: post.commentCount ?? 0,
          likeCount: post.likeCount ?? 0,
          collectCount: post.collectCount ?? 0
        }),
        replyCount,
        latestEventAt: post.createdTime ?? null,
        containsForumText: false as const
      };
    });
    for (const item of items) {
      this.#issuedThreadRefs.set(
        this.#issuedThreadKey(item.threadRef),
        canonicalProtocolHash(
          "cmooc.forum-thread-ref.v1",
          item.threadRef as unknown as CanonicalJsonValue
        )
      );
    }
    return assertThreadPage({
      schemaVersion: THREAD_PAGE_SCHEMA_VERSION,
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      courseKey: scope.courseKey,
      observedAt,
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
    const observedAt = adapterNow(this.#dependencies.clock);
    return buildObservationEnvelope({
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      observationKey: `observation:${adapterEvidenceHash(
        "observation-key",
        {
          stableThreadRef: ref.stableThreadRef,
          observedAt
        }
      ).slice(0, 24)}`,
      threadKey: ref.threadKey,
      courseKey: ref.courseKey,
      observedAt,
      timeBasis: "utc",
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
            authorPlatformId: detail.authorPlatformId ?? null,
            authorName: detail.authorName,
            title: detail.title,
            content: detail.content,
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
      boundAt: adapterNow(this.#dependencies.clock),
      targetState
    });
  }

  async preflight(
    command: ExecutionCommandV1
  ): Promise<PreflightReceipt> {
    const checkedAt = adapterNow(this.#dependencies.clock);
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
      messageCode: "external_write_disabled",
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
    const locator = assertAllowedForumUrl(
      ref.locator,
      "cMOOC adapter 帖子地址"
    );
    if (cmoocStableThreadRef(locator) !== ref.stableThreadRef) {
      throw new Error("CMOOC_THREAD_REF_MISMATCH");
    }
    const normalized = { ...ref, locator };
    const issuedHash = this.#issuedThreadRefs.get(
      this.#issuedThreadKey(normalized)
    );
    if (
      issuedHash !==
      canonicalProtocolHash(
        "cmooc.forum-thread-ref.v1",
        normalized as unknown as CanonicalJsonValue
      )
    ) {
      throw new Error("CMOOC_THREAD_REF_NOT_ISSUED");
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

  async #threadDetail(ref: ThreadRef): Promise<CmoocApiPostDetail> {
    const detail = await this.#dependencies.fetchThread({
      postUrl: ref.locator
    });
    if (!detail) {
      throw new Error("CMOOC_THREAD_NOT_FOUND");
    }
    const detailLocator = assertAllowedForumUrl(
      detail.url,
      "cMOOC adapter 返回地址"
    );
    if (
      cmoocStableThreadRef(detailLocator) !== ref.stableThreadRef
    ) {
      throw new Error("CMOOC_RETURNED_THREAD_REF_MISMATCH");
    }
    return detail;
  }

  #commentTargetState(
    detail: CmoocApiPostDetail,
    stableCommentRef: string
  ): CanonicalJsonValue {
    const comments = detail.comments.filter(
      (candidate) => candidate.id === stableCommentRef
    );
    if (comments.length !== 1) {
      throw new Error("CMOOC_COMMENT_TARGET_NOT_FOUND");
    }
    const [comment] = comments;
    return {
      targetType: "comment",
      stableTargetRef: comment.id,
      parentRef: comment.parentId ?? null,
      depth: comment.depth ?? 0,
      authorPlatformId: comment.authorPlatformId ?? null,
      authorName: comment.authorName,
      content: comment.content,
      time: comment.time
    };
  }

  #threadState(
    detail: CmoocApiPostDetail,
    stableThreadRef: string
  ): CanonicalJsonValue {
    return {
      stableThreadRef,
      authorPlatformId: detail.authorPlatformId ?? null,
      authorName: detail.authorName,
      title: detail.title,
      tags: detail.tags,
      content: detail.content,
      editedAt: detail.editedAt,
      commentCount: detail.commentCount,
      comments: detail.comments.map((comment) => ({
        id: comment.id,
        parentId: comment.parentId ?? null,
        depth: comment.depth ?? 0,
        authorPlatformId: comment.authorPlatformId ?? null,
        authorName: comment.authorName,
        content: comment.content,
        time: comment.time
      }))
    };
  }
}
