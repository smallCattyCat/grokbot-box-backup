import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import type {
  CourseGraphEdgeKind,
  CourseGraphNodeKind,
  CourseStructureFact,
  SafeCourseGraphAttributes
} from "./course-structure-fact";
import {
  parseCanonicalCourseStructureFact
} from "./course-structure-fact";
import type {
  ProjectableCourseEvent
} from "./live-world-projector";

export const COURSE_CONTENT_GRAPH_SCHEMA_VERSION =
  "cmooc.course-content-graph.v2" as const;

export type CourseGraphCoverageStatus =
  | "complete"
  | "censored";

export type LearnerMetricCoverageStatus =
  | "complete"
  | "lower_bound"
  | "insufficient_data";

export type CourseGraphNodeProjectionV2 = {
  nodeKey: string;
  kind: CourseGraphNodeKind;
  role:
    | "learner"
    | "creator"
    | "helper"
    | "follower"
    | "unknown"
    | null;
  ordinal: number | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  completeness: "complete" | "censored";
  metrics: SafeCourseGraphAttributes;
  stateHash: string;
};

export type CourseGraphEdgeProjectionV2 = {
  edgeKey: string;
  sourceNodeKey: string;
  targetNodeKey: string;
  kind: CourseGraphEdgeKind;
  scopeNodeKey: string | null;
  weight: number;
  evidenceCount: number;
  firstEventAt: string | null;
  latestEventAt: string | null;
  completeness: "complete" | "censored";
  stateHash: string;
};

export type LearnerNetworkPositionV1 = {
  actorKey: string;
  windowKind:
    | "rolling_7d"
    | "rolling_30d"
    | "all_time";
  coverageStatus: LearnerMetricCoverageStatus;
  eventCount: number;
  authoredThreadCount: number;
  replyCount: number;
  inboundReplyCount: number;
  outboundReplyCount: number;
  uniqueInboundPeerCount: number;
  uniqueOutboundPeerCount: number;
  reciprocalPeerCount: number;
  componentSize: number;
  kCore: number | null;
  pageRank: number | null;
  stateHash: string;
};

export type CourseContentGraphProjectionV2 = {
  schemaVersion: typeof COURSE_CONTENT_GRAPH_SCHEMA_VERSION;
  courseAlias: string;
  courseKey: string;
  worldHash: string;
  asOfAt: string;
  coverageHash: string;
  coverageStatus: CourseGraphCoverageStatus;
  roleRegistryStatus: "complete" | "unavailable";
  nodeSetHash: string;
  edgeSetHash: string;
  graphHash: string;
  nodes: CourseGraphNodeProjectionV2[];
  edges: CourseGraphEdgeProjectionV2[];
  learnerPositions: LearnerNetworkPositionV1[];
  containsForumText: false;
};

type MutableNode = Omit<
  CourseGraphNodeProjectionV2,
  "stateHash"
>;

type MutableEdge = Omit<
  CourseGraphEdgeProjectionV2,
  "edgeKey" | "stateHash"
>;

const ROLE_VALUES = new Set([
  "learner",
  "creator",
  "helper",
  "follower",
  "unknown"
] as const);

function isoTime(
  value: string | Date | null | undefined
): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("COURSE_CONTENT_GRAPH_TIME_INVALID");
  }
  return parsed.toISOString();
}

function minTime(
  left: string | null,
  right: string | null
): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right)
    ? left
    : right;
}

function maxTime(
  left: string | null,
  right: string | null
): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right)
    ? left
    : right;
}

function rounded(value: number, digits = 8): number {
  return Number(value.toFixed(digits));
}

function learnerPositionHashMaterial(
  position: Omit<LearnerNetworkPositionV1, "stateHash">
) {
  const {
    pageRank,
    ...integerAndCodeFields
  } = position;
  return {
    ...integerAndCodeFields,
    pageRankE8:
      pageRank === null
        ? null
        : Math.round(pageRank * 100_000_000)
  };
}

function actorRole(
  attributes: SafeCourseGraphAttributes
): MutableNode["role"] {
  const role = attributes.role;
  return typeof role === "string" &&
    ROLE_VALUES.has(role as never)
    ? (role as MutableNode["role"])
    : null;
}

function threadCompleteness(
  attributes: SafeCourseGraphAttributes,
  fallback: "complete" | "censored"
): "complete" | "censored" {
  return attributes.comment_coverage === "complete"
    ? "complete"
    : attributes.comment_coverage === "censored"
      ? "censored"
      : fallback;
}

function edgeIdentity(input: {
  sourceNodeKey: string;
  targetNodeKey: string;
  kind: CourseGraphEdgeKind;
  scopeNodeKey: string | null;
}): string {
  const identity = {
    sourceNodeKey: input.sourceNodeKey,
    targetNodeKey: input.targetNodeKey,
    kind: input.kind,
    scopeNodeKey: input.scopeNodeKey
  };
  return canonicalProtocolHash(
    "cmooc.course-graph-edge-identity.v2",
    identity as unknown as CanonicalJsonValue
  );
}

function computeKCore(
  actors: string[],
  neighbors: Map<string, Set<string>>
): Map<string, number> {
  const core = new Map(actors.map((actor) => [actor, 0]));
  for (let k = 1; k <= actors.length; k += 1) {
    const remaining = new Set(actors);
    let changed = true;
    while (changed) {
      changed = false;
      for (const actor of [...remaining]) {
        const degree = [...(neighbors.get(actor) ?? [])].filter(
          (peer) => remaining.has(peer)
        ).length;
        if (degree < k) {
          remaining.delete(actor);
          changed = true;
        }
      }
    }
    for (const actor of remaining) core.set(actor, k);
  }
  return core;
}

function computePageRank(input: {
  actors: string[];
  weightedEdges: Map<string, number>;
}): Map<string, number> {
  const actorSet = new Set(input.actors);
  const outWeight = new Map(
    input.actors.map((actor) => [actor, 0])
  );
  const incoming = new Map<
    string,
    Array<{ source: string; weight: number }>
  >(input.actors.map((actor) => [actor, []]));
  for (const [pair, weight] of input.weightedEdges) {
    const [source, target] = pair.split(">");
    if (
      !actorSet.has(source) ||
      !actorSet.has(target) ||
      source === target
    ) {
      continue;
    }
    outWeight.set(
      source,
      (outWeight.get(source) ?? 0) + weight
    );
    incoming.get(target)?.push({ source, weight });
  }
  const size = Math.max(input.actors.length, 1);
  let rank = new Map(
    input.actors.map((actor) => [actor, 1 / size])
  );
  const damping = 0.85;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const danglingMass = input.actors.reduce(
      (sum, actor) =>
        sum +
        ((outWeight.get(actor) ?? 0) === 0
          ? rank.get(actor) ?? 0
          : 0),
      0
    );
    const next = new Map<string, number>();
    for (const actor of input.actors) {
      const incomingMass = (incoming.get(actor) ?? []).reduce(
        (sum, edge) =>
          sum +
          (rank.get(edge.source) ?? 0) *
            edge.weight /
            Math.max(outWeight.get(edge.source) ?? 0, 1),
        0
      );
      next.set(
        actor,
        (1 - damping) / size +
          damping * (incomingMass + danglingMass / size)
      );
    }
    rank = next;
  }
  return new Map(
    [...rank].map(([actor, value]) => [
      actor,
      rounded(value)
    ])
  );
}

function componentSizes(
  actors: string[],
  neighbors: Map<string, Set<string>>
): Map<string, number> {
  const sizes = new Map<string, number>();
  const visited = new Set<string>();
  for (const actor of actors) {
    if (visited.has(actor)) continue;
    const members: string[] = [];
    const stack = [actor];
    visited.add(actor);
    while (stack.length > 0) {
      const current = stack.pop() as string;
      members.push(current);
      for (const peer of neighbors.get(current) ?? []) {
        if (!visited.has(peer)) {
          visited.add(peer);
          stack.push(peer);
        }
      }
    }
    for (const member of members) sizes.set(member, members.length);
  }
  return sizes;
}

function projectLearnerPositions(input: {
  asOfAt: string;
  coverageComplete: boolean;
  roleRegistryStatus: "complete" | "unavailable";
  learnerActorKeys: string[];
  events: ProjectableCourseEvent[];
}): LearnerNetworkPositionV1[] {
  const learnerSet = new Set(input.learnerActorKeys);
  const eventByKey = new Map(
    input.events.map((event) => [event.eventKey, event])
  );
  const asOfMs = Date.parse(input.asOfAt);
  const windows = [
    { kind: "rolling_7d" as const, days: 7 },
    { kind: "rolling_30d" as const, days: 30 },
    { kind: "all_time" as const, days: null }
  ];
  return windows.flatMap((window) => {
    const startMs =
      window.days === null
        ? Number.NEGATIVE_INFINITY
        : asOfMs - window.days * 86_400_000;
    const events = input.events.filter((event) => {
      const occurred = Date.parse(event.occurredAt);
      return occurred >= startMs && occurred <= asOfMs;
    });
    const directedWeights = new Map<string, number>();
    const inboundPeers = new Map(
      input.learnerActorKeys.map((actor) => [
        actor,
        new Set<string>()
      ])
    );
    const outboundPeers = new Map(
      input.learnerActorKeys.map((actor) => [
        actor,
        new Set<string>()
      ])
    );
    const inboundCounts = new Map(
      input.learnerActorKeys.map((actor) => [actor, 0])
    );
    const outboundCounts = new Map(
      input.learnerActorKeys.map((actor) => [actor, 0])
    );
    for (const event of events) {
      if (
        event.kind !== "comment" ||
        !event.actorKey ||
        !event.parentEventKey ||
        !learnerSet.has(event.actorKey)
      ) {
        continue;
      }
      const target = eventByKey.get(
        event.parentEventKey
      )?.actorKey;
      if (
        !target ||
        !learnerSet.has(target) ||
        target === event.actorKey
      ) {
        continue;
      }
      const pair = `${event.actorKey}>${target}`;
      directedWeights.set(
        pair,
        (directedWeights.get(pair) ?? 0) + 1
      );
      outboundCounts.set(
        event.actorKey,
        (outboundCounts.get(event.actorKey) ?? 0) + 1
      );
      inboundCounts.set(
        target,
        (inboundCounts.get(target) ?? 0) + 1
      );
      outboundPeers.get(event.actorKey)?.add(target);
      inboundPeers.get(target)?.add(event.actorKey);
    }
    const neighbors = new Map(
      input.learnerActorKeys.map((actor) => [
        actor,
        new Set<string>()
      ])
    );
    for (const pair of directedWeights.keys()) {
      const [source, target] = pair.split(">");
      neighbors.get(source)?.add(target);
      neighbors.get(target)?.add(source);
    }
    const componentSizeByActor = componentSizes(
      input.learnerActorKeys,
      neighbors
    );
    const sufficientForPosition =
      input.coverageComplete &&
      input.roleRegistryStatus === "complete" &&
      input.learnerActorKeys.length >= 5 &&
      directedWeights.size >= 4;
    const kCore = sufficientForPosition
      ? computeKCore(input.learnerActorKeys, neighbors)
      : new Map<string, number>();
    const pageRank = sufficientForPosition
      ? computePageRank({
          actors: input.learnerActorKeys,
          weightedEdges: directedWeights
        })
      : new Map<string, number>();
    return input.learnerActorKeys.map((actorKey) => {
      const actorEvents = events.filter(
        (event) => event.actorKey === actorKey
      );
      const outgoing = outboundPeers.get(actorKey) ?? new Set();
      const incoming = inboundPeers.get(actorKey) ?? new Set();
      const reciprocalPeerCount = [...outgoing].filter((peer) =>
        incoming.has(peer)
      ).length;
      const coverageStatus: LearnerMetricCoverageStatus =
        input.roleRegistryStatus !== "complete"
          ? "insufficient_data"
          : !input.coverageComplete
            ? "lower_bound"
            : sufficientForPosition
              ? "complete"
              : "insufficient_data";
      const withoutHash = {
        actorKey,
        windowKind: window.kind,
        coverageStatus,
        eventCount: actorEvents.length,
        authoredThreadCount: new Set(
          actorEvents
            .filter((event) => event.kind === "thread_root")
            .map((event) => event.threadKey)
        ).size,
        replyCount: actorEvents.filter(
          (event) => event.kind === "comment"
        ).length,
        inboundReplyCount: inboundCounts.get(actorKey) ?? 0,
        outboundReplyCount: outboundCounts.get(actorKey) ?? 0,
        uniqueInboundPeerCount: incoming.size,
        uniqueOutboundPeerCount: outgoing.size,
        reciprocalPeerCount,
        componentSize: componentSizeByActor.get(actorKey) ?? 1,
        kCore: sufficientForPosition
          ? kCore.get(actorKey) ?? 0
          : null,
        pageRank: sufficientForPosition
          ? pageRank.get(actorKey) ?? 0
          : null
      };
      return {
        ...withoutHash,
        stateHash: canonicalProtocolHash(
          "cmooc.learner-network-position.v1",
          learnerPositionHashMaterial(
            withoutHash
          ) as unknown as CanonicalJsonValue
        )
      };
    });
  }).sort(
    (left, right) =>
      left.windowKind.localeCompare(right.windowKind) ||
      left.actorKey.localeCompare(right.actorKey)
  );
}

export function projectCourseContentGraphV2(input: {
  courseAlias: string;
  courseKey: string;
  worldHash: string;
  asOfAt: string;
  coverageHash: string;
  coverageComplete: boolean;
  roleRegistryStatus: "complete" | "unavailable";
  facts: readonly CourseStructureFact[];
  events: readonly ProjectableCourseEvent[];
}): CourseContentGraphProjectionV2 {
  const asOfAt = isoTime(input.asOfAt);
  if (!asOfAt) {
    throw new Error("COURSE_CONTENT_GRAPH_AS_OF_REQUIRED");
  }
  const events = input.events
    .map((event) => ({
      ...event,
      occurredAt: isoTime(event.occurredAt) as string
    }))
    .sort(
      (left, right) =>
        Date.parse(left.occurredAt) -
          Date.parse(right.occurredAt) ||
        left.eventKey.localeCompare(right.eventKey)
    );
  if (
    events.some(
      (event) =>
        Date.parse(event.occurredAt) > Date.parse(asOfAt)
    )
  ) {
    throw new Error("COURSE_CONTENT_GRAPH_FUTURE_EVENT");
  }
  const factByIdentity = new Map<string, CourseStructureFact>();
  for (const inputFact of input.facts) {
    const fact = parseCanonicalCourseStructureFact(inputFact);
    if (fact.courseKey !== input.courseKey) {
      throw new Error("COURSE_CONTENT_GRAPH_FACT_COURSE_MISMATCH");
    }
    if (fact.legalityStatus !== "admissible") continue;
    const existing = factByIdentity.get(fact.factIdentityKey);
    if (existing && existing.factKey !== fact.factKey) {
      throw new Error(
        "COURSE_CONTENT_GRAPH_FACT_REVISION_UNRESOLVED"
      );
    }
    factByIdentity.set(fact.factIdentityKey, fact);
  }
  const activeFacts = [...factByIdentity.values()].sort(
    (left, right) => left.factKey.localeCompare(right.factKey)
  );
  if (activeFacts.length > 0) {
    const courseFacts = activeFacts.filter(
      (fact) =>
        fact.factKind === "node" &&
        fact.subjectKind === "course"
    );
    if (
      courseFacts.length !== 1 ||
      courseFacts[0].subjectKey !== input.courseKey
    ) {
      throw new Error(
        "COURSE_CONTENT_GRAPH_COURSE_NODE_INVALID"
      );
    }
  }
  const fallbackCompleteness:
    | "complete"
    | "censored" = input.coverageComplete
    ? "complete"
    : "censored";
  const nodes = new Map<string, MutableNode>();
  const ensureNode = (
    nodeKey: string,
    kind: CourseGraphNodeKind
  ): MutableNode => {
    const existing = nodes.get(nodeKey);
    if (existing) {
      if (existing.kind !== kind) {
        throw new Error("COURSE_GRAPH_NODE_KIND_CONFLICT");
      }
      return existing;
    }
    const created: MutableNode = {
      nodeKey,
      kind,
      role: null,
      ordinal: null,
      firstSeenAt: null,
      lastSeenAt: null,
      completeness: fallbackCompleteness,
      metrics: {}
    };
    nodes.set(nodeKey, created);
    return created;
  };
  ensureNode(input.courseKey, "course");
  for (const fact of activeFacts) {
    if (fact.factKind !== "node") continue;
    const node = ensureNode(fact.subjectKey, fact.subjectKind);
    node.role =
      fact.subjectKind === "actor"
        ? actorRole(fact.attributes)
        : node.role;
    node.ordinal = fact.ordinal;
    node.firstSeenAt = minTime(node.firstSeenAt, fact.occurredAt);
    node.lastSeenAt = maxTime(node.lastSeenAt, fact.occurredAt);
    node.completeness =
      fact.subjectKind === "thread"
        ? threadCompleteness(
            fact.attributes,
            fallbackCompleteness
          )
        : fallbackCompleteness;
    node.metrics = {
      ...node.metrics,
      ...fact.attributes
    };
  }
  const eventsByThread = new Map<
    string,
    ProjectableCourseEvent[]
  >();
  for (const event of events) {
    const threadEvents =
      eventsByThread.get(event.threadKey) ?? [];
    threadEvents.push(event);
    eventsByThread.set(event.threadKey, threadEvents);
    const threadNode = ensureNode(event.threadKey, "thread");
    threadNode.firstSeenAt = minTime(
      threadNode.firstSeenAt,
      event.occurredAt
    );
    threadNode.lastSeenAt = maxTime(
      threadNode.lastSeenAt,
      event.occurredAt
    );
    if (event.actorKey) {
      const actorNode = ensureNode(event.actorKey, "actor");
      actorNode.firstSeenAt = minTime(
        actorNode.firstSeenAt,
        event.occurredAt
      );
      actorNode.lastSeenAt = maxTime(
        actorNode.lastSeenAt,
        event.occurredAt
      );
    }
  }
  for (const [threadKey, threadEvents] of eventsByThread) {
    const threadNode = ensureNode(threadKey, "thread");
    threadNode.metrics = {
      ...threadNode.metrics,
      event_count: threadEvents.length,
      max_depth: Math.max(
        ...threadEvents.map((event) => event.depth)
      )
    };
  }
  for (const node of nodes.values()) {
    if (node.kind !== "actor") continue;
    const actorEvents = events.filter(
      (event) => event.actorKey === node.nodeKey
    );
    node.metrics = {
      ...node.metrics,
      event_count: actorEvents.length,
      authored_thread_count: new Set(
        actorEvents
          .filter((event) => event.kind === "thread_root")
          .map((event) => event.threadKey)
      ).size,
      reply_count: actorEvents.filter(
        (event) => event.kind === "comment"
      ).length
    };
  }

  const edges = new Map<string, MutableEdge>();
  const upsertEdge = (edge: MutableEdge) => {
    if (edge.sourceNodeKey === edge.targetNodeKey) return;
    const identity = edgeIdentity(edge);
    const existing = edges.get(identity);
    if (!existing) {
      edges.set(identity, edge);
      return;
    }
    existing.weight += edge.weight;
    existing.evidenceCount += edge.evidenceCount;
    existing.firstEventAt = minTime(
      existing.firstEventAt,
      edge.firstEventAt
    );
    existing.latestEventAt = maxTime(
      existing.latestEventAt,
      edge.latestEventAt
    );
    if (edge.completeness === "censored") {
      existing.completeness = "censored";
    }
  };
  for (const fact of activeFacts) {
    if (
      fact.factKind !== "edge" ||
      !fact.objectKey ||
      !fact.objectKind ||
      !fact.predicate
    ) {
      continue;
    }
    if (
      !nodes.has(fact.subjectKey) ||
      !nodes.has(fact.objectKey)
    ) {
      throw new Error("COURSE_GRAPH_EDGE_ENDPOINT_MISSING");
    }
    const weight =
      typeof fact.attributes.weight === "number"
        ? fact.attributes.weight
        : typeof fact.attributes.occurrence_count === "number"
          ? fact.attributes.occurrence_count
          : 1;
    const evidenceCount =
      typeof fact.attributes.evidence_count === "number"
        ? Math.max(
            1,
            Math.floor(fact.attributes.evidence_count)
          )
        : Math.max(1, Math.floor(weight));
    const scopeNodeKey =
      fact.subjectKind === "thread"
        ? fact.subjectKey
        : fact.objectKind === "thread"
          ? fact.objectKey
          : null;
    const completeness = scopeNodeKey
      ? nodes.get(scopeNodeKey)?.completeness ??
        fallbackCompleteness
      : fallbackCompleteness;
    upsertEdge({
      sourceNodeKey: fact.subjectKey,
      targetNodeKey: fact.objectKey,
      kind: fact.predicate,
      scopeNodeKey,
      weight,
      evidenceCount,
      firstEventAt: fact.occurredAt,
      latestEventAt: fact.occurredAt,
      completeness
    });
  }
  const eventByKey = new Map(
    events.map((event) => [event.eventKey, event])
  );
  for (const event of events) {
    if (event.actorKey) {
      const threadCompleteness =
        nodes.get(event.threadKey)?.completeness ??
        fallbackCompleteness;
      upsertEdge({
        sourceNodeKey: event.actorKey,
        targetNodeKey: event.threadKey,
        kind:
          event.kind === "thread_root"
            ? "authored"
            : "participated_in",
        scopeNodeKey: event.threadKey,
        weight: 1,
        evidenceCount: 1,
        firstEventAt: event.occurredAt,
        latestEventAt: event.occurredAt,
        completeness: threadCompleteness
      });
    }
    if (
      event.kind !== "comment" ||
      !event.actorKey ||
      !event.parentEventKey
    ) {
      continue;
    }
    const targetActorKey = eventByKey.get(
      event.parentEventKey
    )?.actorKey;
    if (!targetActorKey || targetActorKey === event.actorKey) {
      continue;
    }
    upsertEdge({
      sourceNodeKey: event.actorKey,
      targetNodeKey: targetActorKey,
      kind: "reply_to",
      scopeNodeKey: event.threadKey,
      weight: 1,
      evidenceCount: 1,
      firstEventAt: event.occurredAt,
      latestEventAt: event.occurredAt,
      completeness:
        nodes.get(event.threadKey)?.completeness ??
        fallbackCompleteness
    });
  }
  const projectedNodes = [...nodes.values()]
    .map((node): CourseGraphNodeProjectionV2 => ({
      ...node,
      stateHash: canonicalProtocolHash(
        "cmooc.course-graph-node-state.v2",
        node as unknown as CanonicalJsonValue
      )
    }))
    .sort((left, right) =>
      left.nodeKey.localeCompare(right.nodeKey)
    );
  const projectedEdges = [...edges.values()]
    .map((edge): CourseGraphEdgeProjectionV2 => {
      const normalized = {
        ...edge,
        weight: rounded(edge.weight, 4)
      };
      const edgeKey = edgeIdentity(normalized);
      return {
        edgeKey,
        ...normalized,
        stateHash: canonicalProtocolHash(
          "cmooc.course-graph-edge-state.v2",
          {
            edgeKey,
            ...normalized
          } as unknown as CanonicalJsonValue
        )
      };
    })
    .sort((left, right) =>
      left.edgeKey.localeCompare(right.edgeKey)
    );
  const nodeSetHash = canonicalProtocolHash(
    "cmooc.course-graph-node-set.v2",
    projectedNodes as unknown as CanonicalJsonValue
  );
  const edgeSetHash = canonicalProtocolHash(
    "cmooc.course-graph-edge-set.v2",
    projectedEdges as unknown as CanonicalJsonValue
  );
  const learnerActorKeys = projectedNodes
    .filter(
      (node) =>
        node.kind === "actor" && node.role === "learner"
    )
    .map((node) => node.nodeKey);
  const learnerPositions = projectLearnerPositions({
    asOfAt,
    coverageComplete: input.coverageComplete,
    roleRegistryStatus: input.roleRegistryStatus,
    learnerActorKeys,
    events
  });
  const coverageStatus: CourseGraphCoverageStatus =
    input.coverageComplete ? "complete" : "censored";
  const graphWithoutHash = {
    schemaVersion: COURSE_CONTENT_GRAPH_SCHEMA_VERSION,
    courseAlias: input.courseAlias,
    courseKey: input.courseKey,
    worldHash: input.worldHash,
    asOfAt,
    coverageHash: input.coverageHash,
    coverageStatus,
    roleRegistryStatus: input.roleRegistryStatus,
    nodeSetHash,
    edgeSetHash,
    learnerPositionSetHash: canonicalProtocolHash(
      "cmooc.learner-network-position-set.v1",
      learnerPositions.map((position) => {
        const {
          stateHash,
          ...withoutHash
        } = position;
        return {
          ...learnerPositionHashMaterial(withoutHash),
          stateHash
        };
      }) as unknown as CanonicalJsonValue
    ),
    containsForumText: false as const
  };
  return {
    ...graphWithoutHash,
    graphHash: canonicalProtocolHash(
      COURSE_CONTENT_GRAPH_SCHEMA_VERSION,
      graphWithoutHash as unknown as CanonicalJsonValue
    ),
    nodes: projectedNodes,
    edges: projectedEdges,
    learnerPositions
  };
}
