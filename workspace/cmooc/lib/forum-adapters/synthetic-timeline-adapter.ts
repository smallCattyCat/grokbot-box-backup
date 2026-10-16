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

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SYNTHETIC_TIMELINE_CURSOR_VERSION =
  "cmooc.synthetic-timeline-cursor.v1" as const;
const DEFAULT_PAGE_LIMIT = 20;

export interface SyntheticTimelineMessage {
  stableMessageRef: string;
  parentMessageRef: string | null;
  actorRef: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface SyntheticTimeline {
  stableTimelineRef: string;
  courseKey: string;
  platformCourseRef: string;
  topicLabel: string;
  rootMessageRef: string;
  messages: SyntheticTimelineMessage[];
}

export type SyntheticTimelineExecutionOutcome =
  | "verified_published"
  | "confirmed_not_published"
  | "outcome_unknown";

export interface SyntheticTimelineAdapterOptions {
  adapterId?: string;
  adapterVersion?: string;
  clock: AdapterClock;
  timelines: SyntheticTimeline[];
  executionOutcome?: SyntheticTimelineExecutionOutcome;
}

type StoredBinding = {
  targetRef: TargetRef;
  targetVersionHash: string;
};

type StoredReceipt = {
  commandHash: string;
  receipt: ExecutionReceiptV1;
};

type StoredCursor = {
  schemaVersion: typeof SYNTHETIC_TIMELINE_CURSOR_VERSION;
  adapterId: string;
  adapterVersion: string;
  courseKey: string;
  platformCourseRef: string;
  scopeLocator: string;
  limit: number;
  nextOffset: number;
  timelineSetHash: string;
};

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`INVALID_SYNTHETIC_TIMELINE_IDENTIFIER: ${label}`);
  }
}

function eventTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`INVALID_SYNTHETIC_TIMELINE_TIME: ${label}`);
  }
  return parsed;
}

function locatorPart(value: string, label: string): string {
  assertIdentifier(value, label);
  return encodeURIComponent(value);
}

export function syntheticTimelineScopeLocator(
  platformCourseRef: string
): string {
  return `synthetic-timeline://local/course/${locatorPart(
    platformCourseRef,
    "platformCourseRef"
  )}/feed`;
}

export function syntheticTimelineThreadLocator(
  platformCourseRef: string,
  stableTimelineRef: string
): string {
  return `synthetic-timeline://local/course/${locatorPart(
    platformCourseRef,
    "platformCourseRef"
  )}/timeline/${locatorPart(
    stableTimelineRef,
    "stableTimelineRef"
  )}`;
}

function validateTimeline(
  input: SyntheticTimeline
): SyntheticTimeline {
  assertForumScope({
    courseKey: input.courseKey,
    platformCourseRef: input.platformCourseRef
  });
  assertIdentifier(input.stableTimelineRef, "stableTimelineRef");
  assertIdentifier(input.rootMessageRef, "rootMessageRef");
  if (!input.topicLabel.trim()) {
    throw new Error("SYNTHETIC_TIMELINE_TOPIC_REQUIRED");
  }
  if (input.messages.length === 0) {
    throw new Error("SYNTHETIC_TIMELINE_ROOT_REQUIRED");
  }

  const messages = new Map<string, SyntheticTimelineMessage>();
  for (const message of input.messages) {
    assertIdentifier(message.stableMessageRef, "stableMessageRef");
    assertIdentifier(message.actorRef, "actorRef");
    if (
      message.parentMessageRef !== null &&
      !IDENTIFIER_PATTERN.test(message.parentMessageRef)
    ) {
      throw new Error(
        "INVALID_SYNTHETIC_TIMELINE_IDENTIFIER: parentMessageRef"
      );
    }
    if (
      !Number.isSafeInteger(message.revision) ||
      message.revision < 1
    ) {
      throw new Error("INVALID_SYNTHETIC_TIMELINE_REVISION");
    }
    if (
      eventTime(message.updatedAt, "updatedAt") <
      eventTime(message.createdAt, "createdAt")
    ) {
      throw new Error("SYNTHETIC_TIMELINE_REVISION_PRECEDES_CREATION");
    }
    if (messages.has(message.stableMessageRef)) {
      throw new Error("DUPLICATE_SYNTHETIC_TIMELINE_MESSAGE");
    }
    messages.set(message.stableMessageRef, message);
  }

  const root = messages.get(input.rootMessageRef);
  if (!root || root.parentMessageRef !== null) {
    throw new Error("INVALID_SYNTHETIC_TIMELINE_ROOT");
  }
  for (const message of messages.values()) {
    if (
      message.stableMessageRef !== input.rootMessageRef &&
      (message.parentMessageRef === null ||
        !messages.has(message.parentMessageRef))
    ) {
      throw new Error("SYNTHETIC_TIMELINE_PARENT_NOT_FOUND");
    }
    const visited = new Set<string>();
    let current = message;
    while (current.parentMessageRef !== null) {
      if (visited.has(current.stableMessageRef)) {
        throw new Error("SYNTHETIC_TIMELINE_PARENT_CYCLE");
      }
      visited.add(current.stableMessageRef);
      const parent = messages.get(current.parentMessageRef);
      if (!parent) {
        throw new Error("SYNTHETIC_TIMELINE_PARENT_NOT_FOUND");
      }
      if (
        eventTime(parent.createdAt, "parent.createdAt") >
        eventTime(current.createdAt, "child.createdAt")
      ) {
        throw new Error(
          "SYNTHETIC_TIMELINE_PARENT_CREATED_AFTER_CHILD"
        );
      }
      current = parent;
    }
  }

  return structuredClone(input);
}

export class SyntheticTimelineForumAdapter implements ForumAdapter {
  readonly #adapterId: string;
  readonly #adapterVersion: string;
  readonly #clock: AdapterClock;
  readonly #timelines = new Map<string, SyntheticTimeline>();
  readonly #issuedThreadRefs = new Map<string, string>();
  readonly #bindings = new Map<string, StoredBinding>();
  readonly #receipts = new Map<string, StoredReceipt>();
  readonly #cursors = new Map<string, StoredCursor>();
  #executionOutcome: SyntheticTimelineExecutionOutcome;

  constructor(options: SyntheticTimelineAdapterOptions) {
    this.#adapterId = options.adapterId ?? "synthetic.timeline";
    this.#adapterVersion = options.adapterVersion ?? "p4b.2";
    this.#clock = options.clock;
    this.#executionOutcome =
      options.executionOutcome ?? "verified_published";
    for (const timeline of options.timelines) {
      if (this.#timelines.has(timeline.stableTimelineRef)) {
        throw new Error("DUPLICATE_SYNTHETIC_TIMELINE_REF");
      }
      this.upsertTimeline(timeline);
    }
    assertAdapterManifest(this.manifest());
  }

  manifest(): AdapterManifest {
    return {
      schemaVersion: ADAPTER_MANIFEST_SCHEMA_VERSION,
      contractVersion: FORUM_ADAPTER_CONTRACT_VERSION,
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      platformId: "synthetic.timeline",
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

  upsertTimeline(timeline: SyntheticTimeline): void {
    const validated = validateTimeline(timeline);
    const existing = this.#timelines.get(
      validated.stableTimelineRef
    );
    if (existing) {
      this.#assertMonotonicTimelineUpdate(existing, validated);
    }
    this.#timelines.set(validated.stableTimelineRef, validated);
  }

  setExecutionOutcome(
    outcome: SyntheticTimelineExecutionOutcome
  ): void {
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
      messageCode: "synthetic_timeline_only",
      evidence: {
        transport: "mock",
        platformId: "synthetic.timeline",
        externalWriteMode: "synthetic_only"
      }
    });
  }

  async listThreads(
    scopeInput: ForumScope,
    cursor?: string
  ): Promise<ThreadPage> {
    const scope = assertForumScope(scopeInput);
    const expectedScopeLocator = syntheticTimelineScopeLocator(
      scope.platformCourseRef
    );
    if (
      scope.locator !== undefined &&
      scope.locator !== expectedScopeLocator
    ) {
      throw new Error("SYNTHETIC_TIMELINE_SCOPE_LOCATOR_MISMATCH");
    }

    const observedAt = adapterNow(this.#clock);
    const limit = scope.limit ?? DEFAULT_PAGE_LIMIT;
    const timelines = [...this.#timelines.values()]
      .filter(
        (timeline) =>
          timeline.courseKey === scope.courseKey &&
          timeline.platformCourseRef === scope.platformCourseRef
      )
      .map((timeline) =>
        this.#timelineAsOf(timeline, observedAt, "omit")
      )
      .filter(
        (timeline): timeline is SyntheticTimeline =>
          timeline !== null
      )
      .sort((left, right) =>
        left.stableTimelineRef.localeCompare(
          right.stableTimelineRef
        )
      );
    const timelineSetHash = adapterEvidenceHash(
      "timeline-page-set",
      timelines.map((timeline) => ({
        stableTimelineRef: timeline.stableTimelineRef,
        stateHash: adapterEvidenceHash(
          "timeline-page-item-state",
          this.#timelineState(timeline)
        )
      }))
    );
    const offset =
      cursor === undefined
        ? 0
        : this.#cursorOffset(cursor, {
            courseKey: scope.courseKey,
            platformCourseRef: scope.platformCourseRef,
            scopeLocator: expectedScopeLocator,
            limit,
            timelineSetHash,
            totalCount: timelines.length
          });
    const items = timelines
      .slice(offset, offset + limit)
      .map((timeline) => {
        const latestEventAt =
          [...timeline.messages]
            .sort(
              (left, right) =>
                eventTime(left.updatedAt, "updatedAt") -
                eventTime(right.updatedAt, "updatedAt")
            )
            .at(-1)?.updatedAt ?? null;
        return {
          threadRef: this.#threadRef(timeline),
          titleHash: adapterEvidenceHash(
            "timeline-topic-label",
            timeline.topicLabel
          ),
          stateHintHash: adapterEvidenceHash(
            "timeline-state-hint",
            {
              stableTimelineRef: timeline.stableTimelineRef,
              rootMessageRef: timeline.rootMessageRef,
              messageCount: timeline.messages.length,
              latestEventAt
            }
          ),
          replyCount: timeline.messages.length - 1,
          latestEventAt,
          containsForumText: false as const
        };
      });
    for (const item of items) {
      this.#issuedThreadRefs.set(
        this.#issuedThreadKey(item.threadRef),
        canonicalProtocolHash(
          "cmooc.synthetic-timeline-thread-ref.v1",
          item.threadRef as unknown as CanonicalJsonValue
        )
      );
    }
    const nextOffset = offset + items.length;
    const nextCursor =
      nextOffset < timelines.length
        ? this.#issueCursor({
            schemaVersion: SYNTHETIC_TIMELINE_CURSOR_VERSION,
            adapterId: this.#adapterId,
            adapterVersion: this.#adapterVersion,
            courseKey: scope.courseKey,
            platformCourseRef: scope.platformCourseRef,
            scopeLocator: expectedScopeLocator,
            limit,
            nextOffset,
            timelineSetHash
          })
        : null;

    return assertThreadPage({
      schemaVersion: THREAD_PAGE_SCHEMA_VERSION,
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      courseKey: scope.courseKey,
      observedAt,
      items,
      nextCursor,
      containsForumText: false
    });
  }

  async observeThread(
    refInput: ThreadRef
  ): Promise<ObservationEnvelopeV1> {
    const ref = this.#validatedThreadRef(refInput);
    const observedAt = adapterNow(this.#clock);
    const timeline = this.#timelineAsOf(
      this.#timeline(ref),
      observedAt,
      "reject"
    );
    return buildObservationEnvelope({
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      observationKey: `observation:${adapterEvidenceHash(
        "timeline-observation-key",
        {
          stableTimelineRef: timeline.stableTimelineRef,
          observedAt
        }
      ).slice(0, 24)}`,
      threadKey: ref.threadKey,
      courseKey: ref.courseKey,
      observedAt,
      timeBasis: "synthetic_virtual_clock",
      contentRevisionStatus: "decision_time_version_verified",
      eventCount: timeline.messages.length,
      state: this.#timelineState(timeline)
    });
  }

  async bindTarget(refInput: TargetRef): Promise<BoundTargetV1> {
    const ref = assertTargetRef(refInput);
    const thread = this.#validatedThreadRef(ref.thread);
    const targetRef = { ...ref, thread };
    const boundAt = adapterNow(this.#clock);
    const timeline = this.#timelineAsOf(
      this.#timeline(thread),
      boundAt,
      "reject"
    );
    const targetState = this.#targetState(timeline, targetRef);
    const bound = buildBoundTarget({
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      threadKey: thread.threadKey,
      targetType: targetRef.targetType,
      targetObject: targetRef.targetObject,
      stableTargetRef: targetRef.stableTargetRef,
      contentRevisionStatus: "decision_time_version_verified",
      boundAt,
      targetState
    });
    const boundHash = canonicalProtocolHash(
      bound.schemaVersion,
      bound
    );
    this.#bindings.set(boundHash, {
      targetRef: structuredClone(targetRef),
      targetVersionHash: bound.targetVersionHash
    });
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
    if (
      !binding ||
      !this.#bindingStillCurrent(binding, checkedAt)
    ) {
      return buildPreflightReceipt({
        adapterId: this.#adapterId,
        adapterVersion: this.#adapterVersion,
        command,
        status: "target_changed",
        checkedAt,
        messageCode: "synthetic_timeline_target_changed"
      });
    }
    return buildPreflightReceipt({
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      command,
      status: "ready",
      checkedAt,
      messageCode: "synthetic_timeline_ready"
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
    const messageCode = {
      verified_published: "synthetic_timeline_published",
      confirmed_not_published: "synthetic_timeline_not_published",
      outcome_unknown: "synthetic_timeline_outcome_unknown"
    }[outcome];
    const receipt = buildExecutionReceipt({
      adapterId: this.#adapterId,
      adapterVersion: this.#adapterVersion,
      command,
      outcome,
      attemptedAt,
      recordedAt: adapterNow(this.#clock),
      remoteObjectRefHash:
        outcome === "verified_published"
          ? adapterEvidenceHash(
              "synthetic-timeline-remote-message",
              {
                commandId: command.commandId,
                idempotencyKey: command.idempotencyKey
              }
            )
          : null,
      evidenceHash: adapterEvidenceHash(
        "synthetic-timeline-execution",
        {
          commandHash,
          outcome,
          messageCode
        }
      ),
      messageCode
    });
    this.#receipts.set(command.idempotencyKey, {
      commandHash,
      receipt
    });
    return receipt;
  }

  #threadRef(timeline: SyntheticTimeline): ThreadRef {
    return {
      threadKey: timeline.stableTimelineRef,
      courseKey: timeline.courseKey,
      platformCourseRef: timeline.platformCourseRef,
      stableThreadRef: timeline.stableTimelineRef,
      locator: syntheticTimelineThreadLocator(
        timeline.platformCourseRef,
        timeline.stableTimelineRef
      )
    };
  }

  #issueCursor(state: StoredCursor): string {
    const cursor = `timeline-cursor:${canonicalProtocolHash(
      state.schemaVersion,
      state as unknown as CanonicalJsonValue
    )}`;
    const existing = this.#cursors.get(cursor);
    if (
      existing &&
      canonicalProtocolHash(
        existing.schemaVersion,
        existing as unknown as CanonicalJsonValue
      ) !==
        canonicalProtocolHash(
          state.schemaVersion,
          state as unknown as CanonicalJsonValue
        )
    ) {
      throw new Error("SYNTHETIC_TIMELINE_CURSOR_COLLISION");
    }
    this.#cursors.set(cursor, structuredClone(state));
    return cursor;
  }

  #cursorOffset(
    cursor: string,
    expected: {
      courseKey: string;
      platformCourseRef: string;
      scopeLocator: string;
      limit: number;
      timelineSetHash: string;
      totalCount: number;
    }
  ): number {
    const state = this.#cursors.get(cursor);
    if (!state) {
      throw new Error("INVALID_SYNTHETIC_TIMELINE_CURSOR");
    }
    const expectedToken = `timeline-cursor:${canonicalProtocolHash(
      state.schemaVersion,
      state as unknown as CanonicalJsonValue
    )}`;
    if (expectedToken !== cursor) {
      throw new Error("INVALID_SYNTHETIC_TIMELINE_CURSOR");
    }
    if (
      state.schemaVersion !== SYNTHETIC_TIMELINE_CURSOR_VERSION ||
      state.adapterId !== this.#adapterId ||
      state.adapterVersion !== this.#adapterVersion ||
      state.courseKey !== expected.courseKey ||
      state.platformCourseRef !== expected.platformCourseRef ||
      state.scopeLocator !== expected.scopeLocator ||
      state.limit !== expected.limit
    ) {
      throw new Error(
        "SYNTHETIC_TIMELINE_CURSOR_SCOPE_MISMATCH"
      );
    }
    if (
      !Number.isSafeInteger(state.nextOffset) ||
      state.nextOffset < 1 ||
      state.nextOffset >= expected.totalCount
    ) {
      throw new Error(
        "SYNTHETIC_TIMELINE_CURSOR_OFFSET_OUT_OF_BOUNDS"
      );
    }
    if (state.timelineSetHash !== expected.timelineSetHash) {
      throw new Error(
        "SYNTHETIC_TIMELINE_CURSOR_COLLECTION_CHANGED"
      );
    }
    return state.nextOffset;
  }

  #validatedThreadRef(refInput: ThreadRef): ThreadRef {
    const ref = assertThreadRef(refInput);
    if (
      ref.locator !==
      syntheticTimelineThreadLocator(
        ref.platformCourseRef,
        ref.stableThreadRef
      )
    ) {
      throw new Error(
        "SYNTHETIC_TIMELINE_THREAD_LOCATOR_MISMATCH"
      );
    }
    const issuedHash = this.#issuedThreadRefs.get(
      this.#issuedThreadKey(ref)
    );
    if (
      issuedHash !==
      canonicalProtocolHash(
        "cmooc.synthetic-timeline-thread-ref.v1",
        ref as unknown as CanonicalJsonValue
      )
    ) {
      throw new Error(
        "SYNTHETIC_TIMELINE_THREAD_REF_NOT_ISSUED"
      );
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

  #timeline(ref: ThreadRef): SyntheticTimeline {
    const timeline = this.#timelines.get(ref.stableThreadRef);
    if (
      !timeline ||
      timeline.courseKey !== ref.courseKey ||
      timeline.platformCourseRef !== ref.platformCourseRef
    ) {
      throw new Error("SYNTHETIC_TIMELINE_NOT_FOUND");
    }
    return timeline;
  }

  #timelineAsOf(
    timeline: SyntheticTimeline,
    observedAt: string,
    futureRoot: "reject"
  ): SyntheticTimeline;
  #timelineAsOf(
    timeline: SyntheticTimeline,
    observedAt: string,
    futureRoot: "omit"
  ): SyntheticTimeline | null;
  #timelineAsOf(
    timeline: SyntheticTimeline,
    observedAt: string,
    futureRoot: "omit" | "reject"
  ): SyntheticTimeline | null {
    const asOf = eventTime(observedAt, "observedAt");
    const root = timeline.messages.find(
      (message) =>
        message.stableMessageRef === timeline.rootMessageRef
    );
    if (!root) {
      throw new Error("SYNTHETIC_TIMELINE_ROOT_NOT_FOUND");
    }
    if (eventTime(root.createdAt, "root.createdAt") > asOf) {
      if (futureRoot === "omit") {
        return null;
      }
      throw new Error(
        "SYNTHETIC_TIMELINE_ROOT_NOT_VISIBLE_AS_OF"
      );
    }

    const messages = timeline.messages.filter((message) => {
      if (
        eventTime(message.createdAt, "message.createdAt") > asOf
      ) {
        return false;
      }
      if (
        eventTime(message.updatedAt, "message.updatedAt") > asOf
      ) {
        throw new Error(
          "SYNTHETIC_TIMELINE_REVISION_AFTER_AS_OF"
        );
      }
      return true;
    });
    return {
      ...timeline,
      messages
    };
  }

  #assertMonotonicTimelineUpdate(
    previous: SyntheticTimeline,
    next: SyntheticTimeline
  ): void {
    if (
      previous.courseKey !== next.courseKey ||
      previous.platformCourseRef !== next.platformCourseRef ||
      previous.rootMessageRef !== next.rootMessageRef
    ) {
      throw new Error(
        "SYNTHETIC_TIMELINE_STABLE_IDENTITY_CHANGED"
      );
    }
    const previousMessages = new Map(
      previous.messages.map((message) => [
        message.stableMessageRef,
        message
      ])
    );
    const nextMessages = new Map(
      next.messages.map((message) => [
        message.stableMessageRef,
        message
      ])
    );
    for (const [stableMessageRef, before] of previousMessages) {
      const after = nextMessages.get(stableMessageRef);
      if (!after) {
        throw new Error(
          "SYNTHETIC_TIMELINE_MESSAGE_DELETION_UNVERSIONED"
        );
      }
      if (
        before.parentMessageRef !== after.parentMessageRef ||
        before.actorRef !== after.actorRef ||
        before.createdAt !== after.createdAt
      ) {
        throw new Error(
          "SYNTHETIC_TIMELINE_MESSAGE_IDENTITY_CHANGED"
        );
      }
      const revisionIncreased = after.revision > before.revision;
      const updateTimeIncreased =
        eventTime(after.updatedAt, "updatedAt") >
        eventTime(before.updatedAt, "previous.updatedAt");
      if (
        after.revision < before.revision ||
        eventTime(after.updatedAt, "updatedAt") <
          eventTime(before.updatedAt, "previous.updatedAt") ||
        (after.body !== before.body &&
          (!revisionIncreased || !updateTimeIncreased)) ||
        (after.revision !== before.revision &&
          !updateTimeIncreased) ||
        (after.updatedAt !== before.updatedAt &&
          !revisionIncreased)
      ) {
        throw new Error(
          "SYNTHETIC_TIMELINE_REVISION_NOT_MONOTONIC"
        );
      }
    }
    if (previous.topicLabel !== next.topicLabel) {
      const previousRoot = previousMessages.get(
        previous.rootMessageRef
      );
      const nextRoot = nextMessages.get(next.rootMessageRef);
      if (
        !previousRoot ||
        !nextRoot ||
        nextRoot.revision <= previousRoot.revision ||
        eventTime(nextRoot.updatedAt, "root.updatedAt") <=
          eventTime(
            previousRoot.updatedAt,
            "previous.root.updatedAt"
          )
      ) {
        throw new Error(
          "SYNTHETIC_TIMELINE_TOPIC_REVISION_REQUIRED"
        );
      }
    }
  }

  #targetState(
    timeline: SyntheticTimeline,
    ref: TargetRef
  ): CanonicalJsonValue {
    if (ref.targetType === "thread") {
      const root = timeline.messages.find(
        (message) =>
          message.stableMessageRef === timeline.rootMessageRef
      );
      if (!root) {
        throw new Error("SYNTHETIC_TIMELINE_ROOT_NOT_FOUND");
      }
      return {
        entityKind: "timeline",
        stableTimelineRef: timeline.stableTimelineRef,
        topicLabel: timeline.topicLabel,
        rootMessageRef: root.stableMessageRef,
        rootActorRef: root.actorRef,
        rootBody: root.body,
        rootCreatedAt: root.createdAt,
        rootUpdatedAt: root.updatedAt,
        rootRevision: root.revision
      };
    }

    const matches = timeline.messages.filter(
      (message) =>
        message.stableMessageRef === ref.stableTargetRef
    );
    if (matches.length !== 1) {
      throw new Error("SYNTHETIC_TIMELINE_MESSAGE_NOT_FOUND");
    }
    const [message] = matches;
    return {
      entityKind: "timeline_message",
      stableMessageRef: message.stableMessageRef,
      parentMessageRef: message.parentMessageRef,
      actorRef: message.actorRef,
      body: message.body,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      revision: message.revision
    };
  }

  #bindingStillCurrent(
    binding: StoredBinding,
    checkedAt: string
  ): boolean {
    try {
      const thread = this.#validatedThreadRef(
        binding.targetRef.thread
      );
      const timeline = this.#timelineAsOf(
        this.#timeline(thread),
        checkedAt,
        "reject"
      );
      const currentState = this.#targetState(
        timeline,
        binding.targetRef
      );
      return (
        adapterEvidenceHash("target-version", currentState) ===
        binding.targetVersionHash
      );
    } catch {
      return false;
    }
  }

  #timelineState(
    timeline: SyntheticTimeline
  ): CanonicalJsonValue {
    return {
      entityKind: "timeline",
      stableTimelineRef: timeline.stableTimelineRef,
      topicLabel: timeline.topicLabel,
      rootMessageRef: timeline.rootMessageRef,
      messages: timeline.messages.map((message) => ({
        stableMessageRef: message.stableMessageRef,
        parentMessageRef: message.parentMessageRef,
        actorRef: message.actorRef,
        body: message.body,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        revision: message.revision
      }))
    };
  }
}
