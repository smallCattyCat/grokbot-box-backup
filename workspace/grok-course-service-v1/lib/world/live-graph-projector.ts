import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import type { ProjectableCourseEvent } from "./live-world-projector";

export type LiveGraphEdge = {
  edgeKey: string;
  sourceActorKey: string | null;
  targetActorKey: string | null;
  threadKey: string;
  kind: "reply_to";
  weight: number;
  firstEventAt: string;
  latestEventAt: string;
  stateHash: string;
};

export function projectLiveInteractionGraph(
  events: ProjectableCourseEvent[]
): {
  edges: LiveGraphEdge[];
  graphHash: string;
} {
  const eventByKey = new Map(
    events.map((event) => [event.eventKey, event])
  );
  const grouped = new Map<string, Omit<LiveGraphEdge, "stateHash">>();
  for (const event of events) {
    if (!event.parentEventKey || event.kind !== "comment") continue;
    const parent = eventByKey.get(event.parentEventKey);
    if (!parent) continue;
    const edgeKey = canonicalProtocolHash(
      "cmooc.interaction-edge-key.v1",
      {
        sourceActorKey: event.actorKey,
        targetActorKey: parent.actorKey,
        threadKey: event.threadKey,
        kind: "reply_to"
      }
    );
    const existing = grouped.get(edgeKey);
    if (existing) {
      existing.weight += 1;
      if (
        Date.parse(event.occurredAt) <
        Date.parse(existing.firstEventAt)
      ) {
        existing.firstEventAt = event.occurredAt;
      }
      if (
        Date.parse(event.occurredAt) >
        Date.parse(existing.latestEventAt)
      ) {
        existing.latestEventAt = event.occurredAt;
      }
    } else {
      grouped.set(edgeKey, {
        edgeKey,
        sourceActorKey: event.actorKey,
        targetActorKey: parent.actorKey,
        threadKey: event.threadKey,
        kind: "reply_to",
        weight: 1,
        firstEventAt: event.occurredAt,
        latestEventAt: event.occurredAt
      });
    }
  }
  const edges = [...grouped.values()]
    .sort((left, right) => left.edgeKey.localeCompare(right.edgeKey))
    .map((edge): LiveGraphEdge => ({
      ...edge,
      stateHash: canonicalProtocolHash(
        "cmooc.interaction-edge-state.v1",
        edge as unknown as CanonicalJsonValue
      )
    }));
  const graphHash = canonicalProtocolHash(
    "cmooc.live-interaction-graph.v1",
    {
      schemaVersion: "cmooc.live-interaction-graph.v1",
      edges
    } as unknown as CanonicalJsonValue
  );
  return { edges, graphHash };
}
