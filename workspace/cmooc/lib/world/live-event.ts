import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  localEvidenceHmac
} from "@/lib/privacy/local-evidence-hmac";

export const LIVE_COURSE_EVENT_SCHEMA_VERSION =
  "cmooc.course-event.v1" as const;

export type LiveEventNormalizationErrorCode =
  | "event_parent_unresolved";

export class LiveEventNormalizationError extends Error {
  constructor(
    readonly code: LiveEventNormalizationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "LiveEventNormalizationError";
  }
}

export type CourseEventActorRelation =
  | "thread_author"
  | "external_human"
  | "system_or_agent"
  | "unknown";

export type NormalizedCourseEvent = {
  schemaVersion: typeof LIVE_COURSE_EVENT_SCHEMA_VERSION;
  courseAlias: string;
  eventKey: string;
  threadKey: string;
  actorKey: string | null;
  parentEventKey: string | null;
  kind: "thread_root" | "comment";
  actorRelation: CourseEventActorRelation;
  relationBasis:
    | "stable_actor_match"
    | "server_actor_registry"
    | "unavailable";
  depth: number;
  occurredAt: string;
  observedAt: string;
  sourceKind: "cmooc_api";
  sourceVersionHash: string;
  targetVersionHash: string;
  legalityStatus: "admissible";
};

export type CourseEventObservationDisposition =
  | "initial"
  | "duplicate"
  | "revision"
  | "conflict";

export function classifyCourseEventObservation(input: {
  stableEvent: NormalizedCourseEvent;
  latestObservation?: {
    observedAt: string;
    sourceVersionHash: string;
    targetVersionHash: string;
  } | null;
  incomingEvent: NormalizedCourseEvent;
}): CourseEventObservationDisposition {
  const stable = input.stableEvent;
  const incoming = input.incomingEvent;
  const stableIdentityMatches =
    stable.schemaVersion === incoming.schemaVersion &&
    stable.courseAlias === incoming.courseAlias &&
    stable.eventKey === incoming.eventKey &&
    stable.threadKey === incoming.threadKey &&
    stable.actorKey === incoming.actorKey &&
    stable.parentEventKey === incoming.parentEventKey &&
    stable.kind === incoming.kind &&
    stable.actorRelation === incoming.actorRelation &&
    stable.relationBasis === incoming.relationBasis &&
    stable.depth === incoming.depth &&
    Date.parse(stable.occurredAt) ===
      Date.parse(incoming.occurredAt) &&
    stable.sourceKind === incoming.sourceKind &&
    stable.legalityStatus === incoming.legalityStatus;
  if (!stableIdentityMatches) return "conflict";

  const latest = input.latestObservation;
  if (!latest) return "initial";
  const sameRevision =
    latest.sourceVersionHash === incoming.sourceVersionHash &&
    latest.targetVersionHash === incoming.targetVersionHash;
  if (sameRevision) return "duplicate";
  if (
    Date.parse(incoming.observedAt) <=
    Date.parse(latest.observedAt)
  ) {
    return "conflict";
  }
  return "revision";
}

export type CourseEventRevisionAtCutoff = {
  eventKey: string;
  observedAt: string;
  sourceKind: string;
  sourceVersionHash: string;
  targetVersionHash: string | null;
  revisionKind: string;
};

export async function loadCourseEventRevisionsAtCutoff(input: {
  prisma: PrismaClient;
  eventKeys: readonly string[];
  cutoff: Date | string;
}): Promise<Map<string, CourseEventRevisionAtCutoff>> {
  const eventKeys = [...new Set(input.eventKeys)];
  if (eventKeys.length === 0) return new Map();
  const cutoff = new Date(input.cutoff);
  if (!Number.isFinite(cutoff.getTime())) {
    throw new Error("EVENT_REVISION_CUTOFF_INVALID");
  }
  const rows = await input.prisma.$queryRaw<
    Array<{
      eventKey: string;
      observedAt: Date | string;
      sourceKind: string;
      sourceVersionHash: string;
      targetVersionHash: string | null;
      revisionKind: string;
    }>
  >(Prisma.sql`
    SELECT
      "eventKey",
      "observedAt",
      "sourceKind",
      "sourceVersionHash",
      "targetVersionHash",
      "revisionKind"
    FROM "CourseEventObservation"
    WHERE "eventKey" IN (${Prisma.join(eventKeys)})
      AND "observedAt" <= ${cutoff}
    ORDER BY "observedAt" ASC, "createdAt" ASC, "id" ASC
  `);
  const latest = new Map<string, CourseEventRevisionAtCutoff>();
  for (const row of rows) {
    latest.set(row.eventKey, {
      eventKey: row.eventKey,
      observedAt: new Date(row.observedAt).toISOString(),
      sourceKind: row.sourceKind,
      sourceVersionHash: row.sourceVersionHash,
      targetVersionHash: row.targetVersionHash,
      revisionKind: row.revisionKind
    });
  }
  return latest;
}

export type TransientObservedComment = {
  eventRef: string;
  actorRef: string | null;
  parentEventRef: string;
  depth: number;
  occurredAt: string;
  versionMaterial: string;
};

export type TransientObservedThread = {
  courseRef: string;
  threadRef: string;
  authorRef: string | null;
  occurredAt: string;
  observedAt: string;
  versionMaterial: string;
  comments: TransientObservedComment[];
  knownSystemActorRefs?: string[];
  knownExternalHumanActorRefs?: string[];
};

function requiredRef(
  value: string,
  label: string,
  maxLength = 512
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label}缺失或过长。`);
  }
  return normalized;
}

export function normalizePlatformTime(
  value: string,
  label: string
): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label}缺少严格事件时间。`);
  }
  const shanghaiLocal =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(
      normalized
    );
  const candidate = shanghaiLocal
    ? `${shanghaiLocal[1]}T${shanghaiLocal[2]}+08:00`
    : normalized;
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label}不是可解析的严格时间。`);
  }
  return new Date(timestamp).toISOString();
}

function stableKey(input: {
  secret: Buffer | string;
  scope: string;
  value: string;
}): string {
  return localEvidenceHmac({
    ...input,
    length: 64
  });
}

export function deriveAutonomyCourseKey(input: {
  secret: Buffer | string;
  courseRef: string;
}): string {
  return stableKey({
    secret: input.secret,
    scope: "autonomy-course-ref-v1",
    value: requiredRef(input.courseRef, "课程平台引用")
  });
}

export function deriveAutonomyActorKey(input: {
  secret: Buffer | string;
  courseRef: string;
  actorRef: string;
}): string {
  const courseRef = requiredRef(
    input.courseRef,
    "课程平台引用"
  );
  const actorRef = requiredRef(
    input.actorRef,
    "参与者平台引用"
  );
  return stableKey({
    secret: input.secret,
    scope: "autonomy-actor-ref-v1",
    value: `${courseRef}\0${actorRef}`
  });
}

export function deriveAutonomyThreadKey(input: {
  secret: Buffer | string;
  courseRef: string;
  threadRef: string;
}): string {
  const courseRef = requiredRef(
    input.courseRef,
    "课程平台引用"
  );
  const threadRef = requiredRef(
    input.threadRef,
    "线程平台引用"
  );
  return stableKey({
    secret: input.secret,
    scope: "autonomy-thread-ref-v1",
    value: `${courseRef}\0${threadRef}`
  });
}

export function normalizeObservedThread(input: {
  courseAlias: string;
  thread: TransientObservedThread;
  secret: Buffer | string;
  maxComments: number;
}): {
  courseKey: string;
  threadKey: string;
  authorKey: string | null;
  targetVersionHash: string;
  events: NormalizedCourseEvent[];
} {
  const courseRef = requiredRef(
    input.thread.courseRef,
    "课程平台引用"
  );
  const threadRef = requiredRef(
    input.thread.threadRef,
    "线程平台引用"
  );
  if (
    !Number.isSafeInteger(input.maxComments) ||
    input.maxComments < 0 ||
    input.thread.comments.length > input.maxComments
  ) {
    throw new Error("线程评论超过当前 manifest 的安全扫描上限。");
  }
  const observedAt = normalizePlatformTime(
    input.thread.observedAt,
    "线程观察时间"
  );
  const rootOccurredAt = normalizePlatformTime(
    input.thread.occurredAt,
    "根事件时间"
  );
  if (Date.parse(rootOccurredAt) > Date.parse(observedAt)) {
    throw new Error("根事件时间不得晚于观察时间。");
  }
  const courseKey = deriveAutonomyCourseKey({
    secret: input.secret,
    courseRef
  });
  const threadKey = deriveAutonomyThreadKey({
    secret: input.secret,
    courseRef,
    threadRef
  });
  const authorRef = input.thread.authorRef?.trim() || null;
  const authorKey = authorRef
    ? deriveAutonomyActorKey({
        secret: input.secret,
        courseRef,
        actorRef: authorRef
      })
    : null;
  const targetVersionHash = stableKey({
    secret: input.secret,
    scope: "autonomy-target-version-v1",
    value: [
      courseRef,
      threadRef,
      input.thread.versionMaterial
    ].join("\0")
  });
  const rootEventKey = stableKey({
    secret: input.secret,
    scope: "autonomy-event-ref-v1",
    value: `${courseRef}\0${threadRef}\0${threadRef}`
  });
  const eventsByRef = new Map<string, string>([
    [threadRef, rootEventKey]
  ]);
  const actorKeysByRef = new Map<string, string>();
  if (authorRef && authorKey) {
    actorKeysByRef.set(authorRef, authorKey);
  }
  const systemActorRefs = new Set(
    input.thread.knownSystemActorRefs ?? []
  );
  const externalHumanActorRefs = new Set(
    input.thread.knownExternalHumanActorRefs ?? []
  );
  const events: NormalizedCourseEvent[] = [
    {
      schemaVersion: LIVE_COURSE_EVENT_SCHEMA_VERSION,
      courseAlias: input.courseAlias,
      eventKey: rootEventKey,
      threadKey,
      actorKey: authorKey,
      parentEventKey: null,
      kind: "thread_root",
      actorRelation: "thread_author",
      relationBasis: "stable_actor_match",
      depth: 0,
      occurredAt: rootOccurredAt,
      observedAt,
      sourceKind: "cmooc_api",
      sourceVersionHash: stableKey({
        secret: input.secret,
        scope: "autonomy-event-version-v1",
        value: [
          courseRef,
          threadRef,
          input.thread.versionMaterial
        ].join("\0")
      }),
      targetVersionHash,
      legalityStatus: "admissible"
    }
  ];
  const orderedComments = input.thread.comments
    .map((comment) => ({
      ...comment,
      eventRef: requiredRef(comment.eventRef, "评论平台引用"),
      parentEventRef: requiredRef(
        comment.parentEventRef,
        "评论父事件平台引用"
      ),
      occurredAt: normalizePlatformTime(
        comment.occurredAt,
        "评论事件时间"
      )
    }))
    .sort(
      (left, right) =>
        left.depth - right.depth ||
        Date.parse(left.occurredAt) -
          Date.parse(right.occurredAt) ||
        left.eventRef.localeCompare(right.eventRef)
    );
  for (const comment of orderedComments) {
    if (
      !Number.isSafeInteger(comment.depth) ||
      comment.depth < 0 ||
      Date.parse(comment.occurredAt) > Date.parse(observedAt)
    ) {
      throw new Error("评论深度或事件时间无效。");
    }
    if (eventsByRef.has(comment.eventRef)) {
      throw new Error("线程事件平台引用重复。");
    }
    const parentEventKey = eventsByRef.get(
      comment.parentEventRef
    );
    if (!parentEventKey) {
      throw new LiveEventNormalizationError(
        "event_parent_unresolved",
        "评论父事件不在当前严格事件前缀中。"
      );
    }
    const eventKey = stableKey({
      secret: input.secret,
      scope: "autonomy-event-ref-v1",
      value: `${courseRef}\0${threadRef}\0${comment.eventRef}`
    });
    eventsByRef.set(comment.eventRef, eventKey);
    const actorRef = comment.actorRef?.trim() || null;
    let actorKey: string | null = null;
    if (actorRef) {
      actorKey =
        actorKeysByRef.get(actorRef) ??
        deriveAutonomyActorKey({
          secret: input.secret,
          courseRef,
          actorRef
        });
      actorKeysByRef.set(actorRef, actorKey);
    }
    const actorRelation: CourseEventActorRelation =
      !actorRef || !actorKey
        ? "unknown"
        : authorRef && actorRef === authorRef
          ? "thread_author"
          : systemActorRefs.has(actorRef)
            ? "system_or_agent"
            : externalHumanActorRefs.has(actorRef)
              ? "external_human"
              : "unknown";
    events.push({
      schemaVersion: LIVE_COURSE_EVENT_SCHEMA_VERSION,
      courseAlias: input.courseAlias,
      eventKey,
      threadKey,
      actorKey,
      parentEventKey,
      kind: "comment",
      actorRelation,
      relationBasis:
        actorRelation === "thread_author"
          ? "stable_actor_match"
          : actorRelation === "unknown"
            ? "unavailable"
            : "server_actor_registry",
      depth: comment.depth + 1,
      occurredAt: comment.occurredAt,
      observedAt,
      sourceKind: "cmooc_api",
      sourceVersionHash: stableKey({
        secret: input.secret,
        scope: "autonomy-event-version-v1",
        value: [
          courseRef,
          threadRef,
          comment.eventRef,
          comment.versionMaterial
        ].join("\0")
      }),
      targetVersionHash,
      legalityStatus: "admissible"
    });
  }
  return {
    courseKey,
    threadKey,
    authorKey,
    targetVersionHash,
    events: events.sort(
      (left, right) =>
        Date.parse(left.occurredAt) -
          Date.parse(right.occurredAt) ||
        left.eventKey.localeCompare(right.eventKey)
    )
  };
}

export async function appendObservedCourseEvents(input: {
  prisma: PrismaClient;
  scanRunId: string;
  courseAlias: string;
  events: NormalizedCourseEvent[];
}): Promise<{
  observedEventCount: number;
  newEventCount: number;
  revisionEventCount: number;
  duplicateEventCount: number;
  conflictEventKeys: string[];
}> {
  const scanRun = await input.prisma.courseScanRun.findUnique({
    where: { id: input.scanRunId },
    select: { courseAlias: true }
  });
  if (!scanRun || scanRun.courseAlias !== input.courseAlias) {
    throw new Error("EVENT_LEDGER_SCAN_RUN_MISMATCH");
  }
  for (const event of input.events) {
    if (
      event.courseAlias !== input.courseAlias ||
      event.legalityStatus !== "admissible"
    ) {
      throw new Error("EVENT_LEDGER_COURSE_OR_LEGALITY_MISMATCH");
    }
  }
  const conflictEventKeys: string[] = [];
  let newEventCount = 0;
  let revisionEventCount = 0;
  let duplicateEventCount = 0;
  const existingEvents =
    await input.prisma.courseEvent.findMany({
      where: {
        eventKey: {
          in: [...new Set(input.events.map((event) => event.eventKey))]
        }
      }
    });
  const existingByKey = new Map(
    existingEvents.map((event) => [event.eventKey, event])
  );
  const latestByKey = await loadCourseEventRevisionsAtCutoff({
    prisma: input.prisma,
    eventKeys: input.events.map((event) => event.eventKey),
    cutoff: "9999-12-31T23:59:59.999Z"
  });
  const stableEvent = (
    event: (typeof existingEvents)[number]
  ): NormalizedCourseEvent => ({
    schemaVersion: LIVE_COURSE_EVENT_SCHEMA_VERSION,
    courseAlias: event.courseAlias,
    eventKey: event.eventKey,
    threadKey: event.threadKey,
    actorKey: event.actorKey,
    parentEventKey: event.parentEventKey,
    kind: event.kind as NormalizedCourseEvent["kind"],
    actorRelation:
      event.actorRelation as NormalizedCourseEvent["actorRelation"],
    relationBasis:
      event.relationBasis as NormalizedCourseEvent["relationBasis"],
    depth: event.depth,
    occurredAt: event.occurredAt.toISOString(),
    observedAt: event.observedAt.toISOString(),
    sourceKind: event.sourceKind as "cmooc_api",
    sourceVersionHash: event.sourceVersionHash,
    targetVersionHash: event.targetVersionHash,
    legalityStatus: event.legalityStatus as "admissible"
  });
  const dispositionFor = (
    existing: (typeof existingEvents)[number],
    incoming: NormalizedCourseEvent,
    latest = latestByKey.get(incoming.eventKey) ?? null
  ) =>
    classifyCourseEventObservation({
      stableEvent: stableEvent(existing),
      latestObservation: latest
        ? {
            observedAt: latest.observedAt,
            sourceVersionHash: latest.sourceVersionHash,
            targetVersionHash:
              latest.targetVersionHash ??
              existing.targetVersionHash
          }
        : null,
      incomingEvent: incoming
    });
  for (const event of input.events) {
    const existing = existingByKey.get(event.eventKey);
    if (
      existing &&
      dispositionFor(existing, event) === "conflict"
    ) {
      conflictEventKeys.push(event.eventKey);
    }
  }
  if (conflictEventKeys.length > 0) {
    return {
      observedEventCount: input.events.length,
      newEventCount: 0,
      revisionEventCount: 0,
      duplicateEventCount: 0,
      conflictEventKeys: [...new Set(conflictEventKeys)].sort()
    };
  }
  for (const event of input.events) {
    let existing = await input.prisma.courseEvent.findUnique({
      where: { eventKey: event.eventKey }
    });
    if (!existing) {
      try {
        existing = await input.prisma.courseEvent.create({
          data: {
            courseAlias: input.courseAlias,
            scanRunId: input.scanRunId,
            eventKey: event.eventKey,
            threadKey: event.threadKey,
            actorKey: event.actorKey,
            parentEventKey: event.parentEventKey,
            kind: event.kind,
            actorRelation: event.actorRelation,
            relationBasis: event.relationBasis,
            depth: event.depth,
            occurredAt: new Date(event.occurredAt),
            observedAt: new Date(event.observedAt),
            sourceKind: event.sourceKind,
            sourceVersionHash: event.sourceVersionHash,
            targetVersionHash: event.targetVersionHash,
            legalityStatus: event.legalityStatus
          }
        });
        newEventCount += 1;
      } catch {
        existing = await input.prisma.courseEvent.findUnique({
          where: { eventKey: event.eventKey }
        });
        if (!existing) throw new Error("EVENT_LEDGER_APPEND_FAILED");
      }
    }
    const latest = await loadCourseEventRevisionsAtCutoff({
      prisma: input.prisma,
      eventKeys: [event.eventKey],
      cutoff: "9999-12-31T23:59:59.999Z"
    });
    const disposition = dispositionFor(
      existing,
      event,
      latest.get(event.eventKey) ?? null
    );
    if (disposition === "conflict") {
      conflictEventKeys.push(event.eventKey);
      continue;
    }
    if (disposition === "revision") revisionEventCount += 1;
    if (disposition === "duplicate") duplicateEventCount += 1;
    await input.prisma.$executeRaw(Prisma.sql`
      INSERT OR IGNORE INTO "CourseEventObservation" (
        "id",
        "scanRunId",
        "eventKey",
        "observedAt",
        "sourceKind",
        "sourceVersionHash",
        "targetVersionHash",
        "revisionKind",
        "createdAt"
      ) VALUES (
        ${randomUUID()},
        ${input.scanRunId},
        ${event.eventKey},
        ${new Date(event.observedAt)},
        ${event.sourceKind},
        ${event.sourceVersionHash},
        ${event.targetVersionHash},
        ${disposition},
        ${new Date()}
      )
    `);
  }
  return {
    observedEventCount: input.events.length,
    newEventCount,
    revisionEventCount,
    duplicateEventCount,
    conflictEventKeys
  };
}
