import type {
  Prisma,
  PrismaClient
} from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import { projectLiveInteractionGraph } from "./live-graph-projector";
import {
  loadCourseEventRevisionsAtCutoff
} from "./live-event";

export type ProjectableCourseEvent = {
  eventKey: string;
  threadKey: string;
  actorKey: string | null;
  parentEventKey: string | null;
  kind: string;
  actorRelation: string;
  depth: number;
  occurredAt: string;
  sourceVersionHash: string;
  targetVersionHash: string;
  legalityStatus: string;
};

export type ProjectedThreadState = {
  threadKey: string;
  rootEventKey: string;
  authorKey: string | null;
  firstEventAt: string;
  latestEventAt: string;
  eventCount: number;
  externalHumanCount: number;
  distinctActorResponseCount: number;
  authorReturnCount: number;
  systemResponseCount: number;
  maxDepth: number;
  completeness: "complete" | "censored";
  supportGapHours: number;
  stateHash: string;
};

export type ProjectedActorState = {
  actorKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  eventCount: number;
  authoredThreadCount: number;
  replyCount: number;
  distinctPeerCount: number;
  systemTouchCount30d: number;
  lastSystemTouchAt: string | null;
  stateHash: string;
};

export type LiveWorldProjection = {
  asOfAt: string;
  eventSetHash: string;
  worldHash: string;
  graphHash: string;
  eventCount: number;
  openGapCount: number;
  threads: ProjectedThreadState[];
  actors: ProjectedActorState[];
  edges: ReturnType<typeof projectLiveInteractionGraph>["edges"];
};

export type LiveWorldProjectionOptions = {
  asOfAt?: Date | string;
  coverageComplete?: boolean;
  completeThreadKeys?: readonly string[];
};

function isoTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("世界投影遇到无效事件时间。");
  }
  return date.toISOString();
}

export function projectLiveWorld(
  inputEvents: ProjectableCourseEvent[],
  options: LiveWorldProjectionOptions = {}
): LiveWorldProjection {
  if (inputEvents.length === 0) {
    throw new Error("世界投影至少需要一个真实事件。");
  }
  const events = inputEvents
    .map((event) => ({
      ...event,
      occurredAt: isoTime(event.occurredAt)
    }))
    .sort(
      (left, right) =>
        Date.parse(left.occurredAt) -
          Date.parse(right.occurredAt) ||
        left.eventKey.localeCompare(right.eventKey)
    );
  if (new Set(events.map((event) => event.eventKey)).size !== events.length) {
    throw new Error("世界投影事件键重复。");
  }
  const eventSetHash = canonicalProtocolHash(
    "cmooc.course-event-set.v1",
    {
      schemaVersion: "cmooc.course-event-set.v1",
      events: events.map((event) => ({
        eventKey: event.eventKey,
        threadKey: event.threadKey,
        actorKey: event.actorKey,
        parentEventKey: event.parentEventKey,
        kind: event.kind,
        actorRelation: event.actorRelation,
        depth: event.depth,
        occurredAt: event.occurredAt,
        sourceVersionHash: event.sourceVersionHash,
        targetVersionHash: event.targetVersionHash,
        legalityStatus: event.legalityStatus
      }))
    } as unknown as CanonicalJsonValue
  );
  const asOfAt = options.asOfAt
    ? isoTime(options.asOfAt)
    : events[events.length - 1].occurredAt;
  if (
    events.some(
      (event) =>
        Date.parse(event.occurredAt) > Date.parse(asOfAt)
    )
  ) {
    throw new Error("世界投影包含截止时点之后的事件。");
  }
  const byThread = new Map<string, ProjectableCourseEvent[]>();
  const completeThreadKeys = options.completeThreadKeys
    ? new Set(options.completeThreadKeys)
    : null;
  for (const event of events) {
    const current = byThread.get(event.threadKey) ?? [];
    current.push(event);
    byThread.set(event.threadKey, current);
  }
  const threads: ProjectedThreadState[] = [];
  for (const [threadKey, threadEvents] of byThread) {
    const roots = threadEvents.filter(
      (event) =>
        event.kind === "thread_root" &&
        event.parentEventKey === null
    );
    if (roots.length !== 1) {
      throw new Error("每个线程必须有唯一根事件。");
    }
    const root = roots[0];
    const firstEventAt = threadEvents[0].occurredAt;
    const latestEventAt =
      threadEvents[threadEvents.length - 1].occurredAt;
    const stateWithoutHash = {
      threadKey,
      rootEventKey: root.eventKey,
      authorKey: root.actorKey,
      firstEventAt,
      latestEventAt,
      eventCount: threadEvents.length,
      externalHumanCount: threadEvents.filter(
        (event) => event.actorRelation === "external_human"
      ).length,
      distinctActorResponseCount: new Set(
        threadEvents
          .filter(
            (event) =>
              event.kind === "comment" &&
              event.actorKey !== null &&
              root.actorKey !== null &&
              event.actorKey !== root.actorKey
          )
          .map((event) => event.actorKey as string)
      ).size,
      authorReturnCount: threadEvents.filter(
        (event) =>
          event.kind === "comment" &&
          event.actorRelation === "thread_author"
      ).length,
      systemResponseCount: threadEvents.filter(
        (event) => event.actorRelation === "system_or_agent"
      ).length,
      maxDepth: Math.max(...threadEvents.map((event) => event.depth)),
      completeness:
        (completeThreadKeys
          ? completeThreadKeys.has(threadKey)
          : options.coverageComplete !== false) &&
        threadEvents.every(
          (event) => event.legalityStatus === "admissible"
        )
        ? ("complete" as const)
        : ("censored" as const),
      supportGapHours: Math.max(
        0,
        Math.floor(
          (Date.parse(asOfAt) - Date.parse(root.occurredAt)) /
            3_600_000
        )
      )
    };
    threads.push({
      ...stateWithoutHash,
      stateHash: canonicalProtocolHash(
        "cmooc.thread-state-at-cutoff.v2",
        stateWithoutHash as unknown as CanonicalJsonValue
      )
    });
  }
  threads.sort((left, right) =>
    left.threadKey.localeCompare(right.threadKey)
  );

  const peersByActor = new Map<string, Set<string>>();
  const eventByKey = new Map(
    events.map((event) => [event.eventKey, event])
  );
  for (const event of events) {
    if (!event.actorKey || !event.parentEventKey) continue;
    const parentActor = eventByKey.get(
      event.parentEventKey
    )?.actorKey;
    if (!parentActor || parentActor === event.actorKey) continue;
    const peers = peersByActor.get(event.actorKey) ?? new Set<string>();
    peers.add(parentActor);
    peersByActor.set(event.actorKey, peers);
    const reverse = peersByActor.get(parentActor) ?? new Set<string>();
    reverse.add(event.actorKey);
    peersByActor.set(parentActor, reverse);
  }
  const byActor = new Map<string, ProjectableCourseEvent[]>();
  for (const event of events) {
    if (!event.actorKey) continue;
    const actorEvents = byActor.get(event.actorKey) ?? [];
    actorEvents.push(event);
    byActor.set(event.actorKey, actorEvents);
  }
  const actors: ProjectedActorState[] = [...byActor.entries()]
    .map(([actorKey, actorEvents]) => {
      const firstSeenAt = actorEvents[0].occurredAt;
      const lastSeenAt =
        actorEvents[actorEvents.length - 1].occurredAt;
      const stateWithoutHash = {
        actorKey,
        firstSeenAt,
        lastSeenAt,
        eventCount: actorEvents.length,
        authoredThreadCount: new Set(
          actorEvents
            .filter((event) => event.kind === "thread_root")
            .map((event) => event.threadKey)
        ).size,
        replyCount: actorEvents.filter(
          (event) => event.kind === "comment"
        ).length,
        distinctPeerCount: peersByActor.get(actorKey)?.size ?? 0,
        systemTouchCount30d: 0,
        lastSystemTouchAt: null
      };
      return {
        ...stateWithoutHash,
        stateHash: canonicalProtocolHash(
          "cmooc.actor-course-state-at-cutoff.v1",
          stateWithoutHash as unknown as CanonicalJsonValue
        )
      };
    })
    .sort((left, right) =>
      left.actorKey.localeCompare(right.actorKey)
    );
  const graph = projectLiveInteractionGraph(events);
  const worldHash = canonicalProtocolHash(
    "cmooc.course-world-snapshot.v2",
    {
      schemaVersion: "cmooc.course-world-snapshot.v2",
      asOfAt,
      eventSetHash,
      threads,
      actors,
      graphHash: graph.graphHash
    } as unknown as CanonicalJsonValue
  );
  return {
    asOfAt,
    eventSetHash,
    worldHash,
    graphHash: graph.graphHash,
    eventCount: events.length,
    openGapCount: threads.filter(
      (thread) =>
        thread.externalHumanCount === 0 &&
        thread.distinctActorResponseCount === 0 &&
        thread.authorReturnCount === 0 &&
        thread.systemResponseCount === 0
    ).length,
    threads,
    actors,
    edges: graph.edges
  };
}

function eventIdentityHash(
  event: ProjectableCourseEvent
): string {
  return canonicalProtocolHash(
    "cmooc.incremental-world-event.v1",
    {
      schemaVersion: "cmooc.incremental-world-event.v1",
      eventKey: event.eventKey,
      threadKey: event.threadKey,
      actorKey: event.actorKey,
      parentEventKey: event.parentEventKey,
      kind: event.kind,
      actorRelation: event.actorRelation,
      depth: event.depth,
      occurredAt: isoTime(event.occurredAt),
      sourceVersionHash: event.sourceVersionHash,
      targetVersionHash: event.targetVersionHash,
      legalityStatus: event.legalityStatus
    } as unknown as CanonicalJsonValue
  );
}

/**
 * Checkpoint-friendly event ingestion. Derived state is rebuilt from the
 * canonical event map so full replay and incremental ingestion cannot drift.
 */
export class IncrementalLiveWorldProjector {
  readonly #events = new Map<
    string,
    {
      event: ProjectableCourseEvent;
      identityHash: string;
    }
  >();

  append(events: ProjectableCourseEvent[]): {
    appended: number;
    duplicate: number;
  } {
    let appended = 0;
    let duplicate = 0;
    for (const event of events) {
      const normalized = {
        ...event,
        occurredAt: isoTime(event.occurredAt)
      };
      const identityHash = eventIdentityHash(normalized);
      const existing = this.#events.get(event.eventKey);
      if (existing) {
        if (existing.identityHash !== identityHash) {
          throw new Error(
            "INCREMENTAL_WORLD_EVENT_CONFLICT"
          );
        }
        duplicate += 1;
        continue;
      }
      this.#events.set(event.eventKey, {
        event: normalized,
        identityHash
      });
      appended += 1;
    }
    return { appended, duplicate };
  }

  project(
    options: LiveWorldProjectionOptions = {}
  ): LiveWorldProjection {
    return projectLiveWorld(
      [...this.#events.values()].map((item) => item.event),
      options
    );
  }

  get size(): number {
    return this.#events.size;
  }
}

export function projectLiveWorldIncrementally(
  batches: ProjectableCourseEvent[][],
  options: LiveWorldProjectionOptions = {}
): LiveWorldProjection {
  const projector = new IncrementalLiveWorldProjector();
  for (const batch of batches) {
    projector.append(batch);
  }
  return projector.project(options);
}

async function persistProjectionChildren(input: {
  tx: Prisma.TransactionClient;
  snapshotId: string;
  projection: LiveWorldProjection;
}): Promise<void> {
  await input.tx.threadStateAtCutoff.createMany({
    data: input.projection.threads.map((thread) => ({
      snapshotId: input.snapshotId,
      threadKey: thread.threadKey,
      rootEventKey: thread.rootEventKey,
      authorKey: thread.authorKey,
      firstEventAt: new Date(thread.firstEventAt),
      latestEventAt: new Date(thread.latestEventAt),
      eventCount: thread.eventCount,
      externalHumanCount: thread.externalHumanCount,
      distinctActorResponseCount:
        thread.distinctActorResponseCount,
      authorReturnCount: thread.authorReturnCount,
      systemResponseCount: thread.systemResponseCount,
      maxDepth: thread.maxDepth,
      completeness: thread.completeness,
      supportGapHours: thread.supportGapHours,
      stateHash: thread.stateHash
    }))
  });
  if (input.projection.actors.length > 0) {
    await input.tx.actorCourseStateAtCutoff.createMany({
      data: input.projection.actors.map((actor) => ({
        snapshotId: input.snapshotId,
        actorKey: actor.actorKey,
        firstSeenAt: new Date(actor.firstSeenAt),
        lastSeenAt: new Date(actor.lastSeenAt),
        eventCount: actor.eventCount,
        authoredThreadCount: actor.authoredThreadCount,
        replyCount: actor.replyCount,
        distinctPeerCount: actor.distinctPeerCount,
        systemTouchCount30d: actor.systemTouchCount30d,
        lastSystemTouchAt: actor.lastSystemTouchAt
          ? new Date(actor.lastSystemTouchAt)
          : null,
        stateHash: actor.stateHash
      }))
    });
  }
  if (input.projection.edges.length > 0) {
    await input.tx.interactionEdgeProjection.createMany({
      data: input.projection.edges.map((edge) => ({
        snapshotId: input.snapshotId,
        edgeKey: edge.edgeKey,
        sourceActorKey: edge.sourceActorKey,
        targetActorKey: edge.targetActorKey,
        threadKey: edge.threadKey,
        kind: edge.kind,
        weight: edge.weight,
        firstEventAt: new Date(edge.firstEventAt),
        latestEventAt: new Date(edge.latestEventAt),
        stateHash: edge.stateHash
      }))
    });
  }
}

export async function projectAndPersistLiveWorld(input: {
  prisma: PrismaClient;
  invocationId: string;
  courseAlias: string;
  coverageHash: string;
  asOfAt: Date | string;
  coverageComplete: boolean;
  completeThreadKeys?: readonly string[];
}): Promise<{
  snapshotId: string;
  projection: LiveWorldProjection;
}> {
  const invocation =
    await input.prisma.scheduledInvocation.findUnique({
      where: { id: input.invocationId },
      select: { courseAlias: true }
    });
  if (!invocation || invocation.courseAlias !== input.courseAlias) {
    throw new Error("WORLD_INVOCATION_MISMATCH");
  }
  const asOfAt = new Date(isoTime(input.asOfAt));
  const persisted = await input.prisma.courseEvent.findMany({
    where: {
      courseAlias: input.courseAlias,
      legalityStatus: "admissible",
      occurredAt: { lte: asOfAt },
      observedAt: { lte: asOfAt }
    },
    select: {
      eventKey: true,
      threadKey: true,
      actorKey: true,
      parentEventKey: true,
      kind: true,
      actorRelation: true,
      depth: true,
      occurredAt: true,
      sourceVersionHash: true,
      targetVersionHash: true,
      legalityStatus: true
    }
  });
  const revisions = await loadCourseEventRevisionsAtCutoff({
    prisma: input.prisma,
    eventKeys: persisted.map((event) => event.eventKey),
    cutoff: asOfAt
  });
  const projectable = persisted.map((event) => ({
      ...event,
      occurredAt: event.occurredAt.toISOString(),
      sourceVersionHash:
        revisions.get(event.eventKey)?.sourceVersionHash ??
        event.sourceVersionHash,
      targetVersionHash:
        revisions.get(event.eventKey)?.targetVersionHash ??
        event.targetVersionHash
    }));
  const batchSize = 250;
  const batches: ProjectableCourseEvent[][] = [];
  for (
    let index = 0;
    index < projectable.length;
    index += batchSize
  ) {
    batches.push(projectable.slice(index, index + batchSize));
  }
  const projection = projectLiveWorldIncrementally(batches, {
    asOfAt,
    coverageComplete: input.coverageComplete,
    completeThreadKeys: input.completeThreadKeys
  });
  const snapshotId = await input.prisma.$transaction(
    async (tx) => {
      const existing =
        await tx.courseWorldSnapshot.findUnique({
          where: { invocationId: input.invocationId }
        });
      if (existing) {
        if (
          existing.worldHash !== projection.worldHash ||
          existing.coverageHash !== input.coverageHash ||
          existing.asOfAt.getTime() !== asOfAt.getTime()
        ) {
          throw new Error(
            "WORLD_SNAPSHOT_IMMUTABILITY_CONFLICT"
          );
        }
        const [threadCount, actorCount, edgeCount] =
          await Promise.all([
            tx.threadStateAtCutoff.count({
              where: { snapshotId: existing.id }
            }),
            tx.actorCourseStateAtCutoff.count({
              where: { snapshotId: existing.id }
            }),
            tx.interactionEdgeProjection.count({
              where: { snapshotId: existing.id }
            })
          ]);
        if (
          threadCount !== projection.threads.length ||
          actorCount !== projection.actors.length ||
          edgeCount !== projection.edges.length
        ) {
          await tx.threadStateAtCutoff.deleteMany({
            where: { snapshotId: existing.id }
          });
          await tx.actorCourseStateAtCutoff.deleteMany({
            where: { snapshotId: existing.id }
          });
          await tx.interactionEdgeProjection.deleteMany({
            where: { snapshotId: existing.id }
          });
          await persistProjectionChildren({
            tx,
            snapshotId: existing.id,
            projection
          });
        }
        return existing.id;
      }
      const snapshot =
        await tx.courseWorldSnapshot.create({
          data: {
            invocationId: input.invocationId,
            courseAlias: input.courseAlias,
            asOfAt,
            eventSetHash: projection.eventSetHash,
            worldHash: projection.worldHash,
            graphHash: projection.graphHash,
            coverageHash: input.coverageHash,
            eventCount: projection.eventCount,
            threadCount: projection.threads.length,
            actorCount: projection.actors.length,
            edgeCount: projection.edges.length,
            openGapCount: projection.openGapCount,
            stateJson: JSON.stringify({
              schemaVersion:
                "cmooc.course-world-state-summary.v2",
              asOfAt: projection.asOfAt,
              eventSetHash: projection.eventSetHash,
              worldHash: projection.worldHash,
              graphHash: projection.graphHash,
              eventCount: projection.eventCount,
              threadCount: projection.threads.length,
              actorCount: projection.actors.length,
              edgeCount: projection.edges.length,
              openGapCount: projection.openGapCount,
              coverageComplete: input.coverageComplete,
              containsForumText: false
            })
          }
        });
      await persistProjectionChildren({
        tx,
        snapshotId: snapshot.id,
        projection
      });
      return snapshot.id;
    }
  );
  return { snapshotId, projection };
}
