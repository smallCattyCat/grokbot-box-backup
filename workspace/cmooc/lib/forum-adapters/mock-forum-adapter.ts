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

export interface MockForumComment {
  stableCommentRef: string;
  parentRef: string | null;
  authorRef: string;
  content: string;
  createdAt: string;
  updatedAt?: string;
}

export interface MockForumThread {
  stableThreadRef: string;
  courseKey: string;
  platformCourseRef: string;
  locator: string;
  authorRef: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  comments: MockForumComment[];
}

export type MockExecutionOutcome =
  | "verified_published"
  | "confirmed_not_attempted"
  | "outcome_unknown"
  | "confirmed_not_published";

export interface MockForumAdapterOptions {
  adapterId?: string;
  adapterVersion?: string;
  clock: AdapterClock;
  threads: MockForumThread[];
  executionOutcome?: MockExecutionOutcome;
}

type StoredReceipt = {
  commandHash: string;
  receipt: ExecutionReceiptV1;
};

type StoredBinding = {
  targetRef: TargetRef;
  targetVersionHash: string;
};

const DEFAULT_PAGE_LIMIT = 20;

export class MockForumAdapter implements ForumAdapter {
  readonly #adapterId: string;
  readonly #adapterVersion: string;
  readonly #clock: AdapterClock;
  readonly #threads = new Map<string, MockForumThread>();
  readonly #issuedThreadRefs = new Map<string, string>();
  readonly #bindings = new Map<string, StoredBinding>();
  readonly #receipts = new Map<string, StoredReceipt>();
  #executionOutcome: MockExecutionOutcome;

  constructor(options: MockForumAdapterOptions) {
    this.#adapterId = options.adapterId ?? "mock.forum";
    this.#adapterVersion = options.adapterVersion ?? "p4b.2";
    this.#clock = options.clock;
    this.#executionOutcome =
      options.executionOutcome ?? "verified_published";
    for (const thread of options.threads) {
      this.upsertThread(thread);
    }
    assertAdapterManifest(this.manifest());
  }

  manifest(): AdapterManifest {
    return {
      schemaVersion: ADAPTER_MANIFEST_SCHEMA_VERSION,
      contractVersion: FORUM_ADAPTER_CONTRACT_VERSION,
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      platformId: "synthetic.forum",
      transport: "mock",
      externalWriteMode: "synthetic_only",
      supportsVirtualClock: true,
      capabilities: {
        inspectAuth: true,
        listThreads: true,
        observeThread: true,
        bindTarget: true,
        preflight: true,
        executeAuthorized: true
      },
      containsForumText: false
    };
  }

  upsertThread(thread: MockForumThread): void {
    assertForumScope({
      courseKey: thread.courseKey,
      platformCourseRef: thread.platformCourseRef
    });
    assertThreadRef({
      threadKey: thread.stableThreadRef,
      courseKey: thread.courseKey,
      platformCourseRef: thread.platformCourseRef,
      stableThreadRef: thread.stableThreadRef,
      locator: thread.locator
    });
    this.#threads.set(thread.stableThreadRef, structuredClone(thread));
  }

  setExecutionOutcome(outcome: MockExecutionOutcome): void {
    this.#executionOutcome = outcome;
  }

  async inspectAuth(): Promise<AuthSummary> {
    const checkedAt = adapterNow(this.#clock);
    return buildAuthSummary({
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      status: "not_applicable",
      canRead: true,
      canExecuteAuthorized: true,
      checkedAt,
      messageCode: "synthetic_only",
      evidence: {
        transport: "mock",
        externalWriteMode: "synthetic_only"
      }
    });
  }

  async listThreads(
    scopeInput: ForumScope,
    cursor?: string
  ): Promise<ThreadPage> {
    const scope = assertForumScope(scopeInput);
    if (cursor !== undefined) {
      throw new Error("MOCK_CURSOR_UNSUPPORTED");
    }
    const observedAt = adapterNow(this.#clock);
    const limit = scope.limit ?? DEFAULT_PAGE_LIMIT;
    const items = [...this.#threads.values()]
      .filter(
        (thread) =>
          thread.courseKey === scope.courseKey &&
          thread.platformCourseRef === scope.platformCourseRef &&
          this.#eventTime(thread.createdAt, "thread.createdAt") <=
            Date.parse(observedAt)
      )
      .sort((left, right) =>
        left.stableThreadRef.localeCompare(right.stableThreadRef)
      )
      .slice(0, limit)
      .map((threadInput) => {
        const thread = this.#threadAsOf(threadInput, observedAt);
        const latestEventAt = [
          thread.updatedAt,
          ...thread.comments.map(
            (comment) => comment.updatedAt ?? comment.createdAt
          )
        ]
          .sort(
            (left, right) =>
              this.#eventTime(left, "latestEventAt") -
              this.#eventTime(right, "latestEventAt")
          )
          .at(-1) ?? null;
        return {
          threadRef: {
            threadKey: thread.stableThreadRef,
            courseKey: thread.courseKey,
            platformCourseRef: thread.platformCourseRef,
            stableThreadRef: thread.stableThreadRef,
            locator: thread.locator
          },
          titleHash: adapterEvidenceHash("thread-title", thread.title),
          stateHintHash: adapterEvidenceHash("thread-state-hint", {
            stableThreadRef: thread.stableThreadRef,
            updatedAt: thread.updatedAt,
            replyCount: thread.comments.length
          }),
          replyCount: thread.comments.length,
          latestEventAt,
          containsForumText: false as const
        };
      });
    for (const item of items) {
      this.#issuedThreadRefs.set(
        this.#issuedThreadKey(item.threadRef),
        canonicalProtocolHash(
          "cmooc.mock-forum-thread-ref.v1",
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
    const observedAt = adapterNow(this.#clock);
    const thread = this.#threadAsOf(this.#thread(ref), observedAt);
    return buildObservationEnvelope({
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      observationKey: `observation:${adapterEvidenceHash(
        "observation-key",
        {
          stableThreadRef: thread.stableThreadRef,
          observedAt
        }
      ).slice(0, 24)}`,
      threadKey: ref.threadKey,
      courseKey: ref.courseKey,
      observedAt,
      timeBasis: "synthetic_virtual_clock",
      contentRevisionStatus: "decision_time_version_verified",
      eventCount: thread.comments.length + 1,
      state: this.#threadState(thread)
    });
  }

  async bindTarget(refInput: TargetRef): Promise<BoundTargetV1> {
    const ref = assertTargetRef(refInput);
    const threadRef = this.#validatedThreadRef(ref.thread);
    const targetRef = { ...ref, thread: threadRef };
    const boundAt = adapterNow(this.#clock);
    const thread = this.#threadAsOf(
      this.#thread(threadRef),
      boundAt
    );
    const targetState = this.#targetState(thread, targetRef);
    const bound = buildBoundTarget({
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      threadKey: targetRef.thread.threadKey,
      targetType: targetRef.targetType,
      targetObject: targetRef.targetObject,
      stableTargetRef: targetRef.stableTargetRef,
      contentRevisionStatus: "decision_time_version_verified",
      boundAt,
      targetState
    });
    this.#bindings.set(
      canonicalProtocolHash(bound.schemaVersion, bound),
      {
        targetRef: structuredClone(targetRef),
        targetVersionHash: bound.targetVersionHash
      }
    );
    return bound;
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
    const binding = this.#bindings.get(command.expectedTargetHash);
    if (!binding || !this.#bindingStillCurrent(binding, checkedAt)) {
      return buildPreflightReceipt({
        adapterId: this.#adapterId,
        adapterVersion: this.#adapterVersion,
        command,
        status: "target_changed",
        checkedAt,
        messageCode: "target_hash_unknown"
      });
    }
    return buildPreflightReceipt({
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      command,
      status: "ready",
      checkedAt,
      messageCode: "synthetic_ready"
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
    if (preflight.status !== "ready") {
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

    const attemptedAt = adapterNow(this.#clock);
    const outcome = this.#executionOutcome;
    const remoteObjectRefHash =
      outcome === "verified_published"
        ? adapterEvidenceHash("synthetic-remote-object", {
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey
          })
        : null;
    const messageCode = {
      verified_published: "synthetic_published",
      confirmed_not_attempted: "synthetic_not_attempted",
      outcome_unknown: "synthetic_outcome_unknown",
      confirmed_not_published: "synthetic_not_published"
    }[outcome];
    const receipt = buildExecutionReceipt({
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      command,
      outcome,
      attemptedAt:
        outcome === "confirmed_not_attempted" ? null : attemptedAt,
      recordedAt: adapterNow(this.#clock),
      remoteObjectRefHash,
      evidenceHash: adapterEvidenceHash("synthetic-execution", {
        commandHash,
        outcome,
        messageCode
      }),
      messageCode
    });
    this.#receipts.set(command.idempotencyKey, {
      commandHash,
      receipt
    });
    return receipt;
  }

  #thread(ref: ThreadRef): MockForumThread {
    const thread = this.#threads.get(ref.stableThreadRef);
    if (
      !thread ||
      thread.courseKey !== ref.courseKey ||
      thread.platformCourseRef !== ref.platformCourseRef ||
      thread.locator !== ref.locator
    ) {
      throw new Error("MOCK_THREAD_REF_NOT_FOUND");
    }
    return thread;
  }

  #validatedThreadRef(refInput: ThreadRef): ThreadRef {
    const ref = assertThreadRef(refInput);
    const issuedHash = this.#issuedThreadRefs.get(
      this.#issuedThreadKey(ref)
    );
    if (
      issuedHash !==
      canonicalProtocolHash(
        "cmooc.mock-forum-thread-ref.v1",
        ref as unknown as CanonicalJsonValue
      )
    ) {
      throw new Error("MOCK_THREAD_REF_NOT_ISSUED");
    }
    return ref;
  }

  #issuedThreadKey(ref: ThreadRef): string {
    return [
      ref.courseKey,
      ref.platformCourseRef,
      ref.stableThreadRef
    ].join("\0");
  }

  #eventTime(value: string, label: string): number {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`INVALID_MOCK_FORUM_TIME: ${label}`);
    }
    return parsed;
  }

  #threadAsOf(
    thread: MockForumThread,
    observedAt: string
  ): MockForumThread {
    const cutoff = Date.parse(observedAt);
    if (
      this.#eventTime(thread.createdAt, "thread.createdAt") > cutoff
    ) {
      throw new Error("MOCK_THREAD_NOT_OBSERVED_AS_OF");
    }
    if (
      this.#eventTime(thread.updatedAt, "thread.updatedAt") > cutoff
    ) {
      throw new Error("MOCK_THREAD_REVISION_AFTER_OBSERVATION");
    }
    const comments = thread.comments
      .filter(
        (comment) =>
          this.#eventTime(comment.createdAt, "comment.createdAt") <=
          cutoff
      )
      .map((comment) => {
        const updatedAt = comment.updatedAt ?? comment.createdAt;
        if (
          this.#eventTime(updatedAt, "comment.updatedAt") > cutoff
        ) {
          throw new Error(
            "MOCK_COMMENT_REVISION_AFTER_OBSERVATION"
          );
        }
        return structuredClone(comment);
      });
    return {
      ...structuredClone(thread),
      comments
    };
  }

  #targetState(
    thread: MockForumThread,
    ref: TargetRef
  ): CanonicalJsonValue {
    return ref.targetType === "thread"
      ? {
          targetType: "thread",
          stableTargetRef: thread.stableThreadRef,
          authorRef: thread.authorRef,
          title: thread.title,
          content: thread.content,
          updatedAt: thread.updatedAt
        }
      : this.#commentTargetState(thread, ref.stableTargetRef);
  }

  #bindingStillCurrent(
    binding: StoredBinding,
    checkedAt: string
  ): boolean {
    try {
      const thread = this.#threadAsOf(
        this.#thread(binding.targetRef.thread),
        checkedAt
      );
      return (
        adapterEvidenceHash(
          "target-version",
          this.#targetState(thread, binding.targetRef)
        ) === binding.targetVersionHash
      );
    } catch {
      return false;
    }
  }

  #commentTargetState(
    thread: MockForumThread,
    stableCommentRef: string
  ): CanonicalJsonValue {
    const comment = thread.comments.find(
      (candidate) =>
        candidate.stableCommentRef === stableCommentRef
    );
    if (!comment) {
      throw new Error("MOCK_COMMENT_TARGET_NOT_FOUND");
    }
    return {
      targetType: "comment",
      stableTargetRef: comment.stableCommentRef,
      parentRef: comment.parentRef,
      authorRef: comment.authorRef,
      content: comment.content,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt ?? comment.createdAt
    };
  }

  #threadState(thread: MockForumThread): CanonicalJsonValue {
    return {
      stableThreadRef: thread.stableThreadRef,
      authorRef: thread.authorRef,
      title: thread.title,
      content: thread.content,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      comments: thread.comments.map((comment) => ({
        stableCommentRef: comment.stableCommentRef,
        parentRef: comment.parentRef,
        authorRef: comment.authorRef,
        content: comment.content,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt ?? comment.createdAt
      }))
    };
  }
}
