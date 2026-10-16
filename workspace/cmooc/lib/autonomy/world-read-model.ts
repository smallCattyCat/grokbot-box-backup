import { prisma } from "@/lib/db";
import {
  parseSafeCoverageSummary,
  type SafeCoverageSummary
} from "./read-model";
import {
  COURSE_CONTENT_GRAPH_SCHEMA_VERSION
} from "@/lib/world/course-content-graph-projector";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  buildOperatorCoursePresentation,
  filterOperatorCourses,
  type OperatorCourseCandidate
} from "./operator-presentation";
import { loadVerifiedOperatorCourseNames } from "./operator-course-name";

const WORLD_SNAPSHOT_LIMIT = 12;
const THREAD_LIMIT = 240;
const ACTOR_LIMIT = 400;
const LEGACY_EDGE_LIMIT = 1_200;
const GRAPH_NODE_LIMIT = 600;
const GRAPH_EDGE_LIMIT = 1_500;
const LEARNER_POSITION_LIMIT = 1_200;
const NETWORK_NODE_LIMIT = 56;
const NETWORK_EDGE_LIMIT = 180;
const LEARNER_NETWORK_NODE_LIMIT = 80;
const LEARNER_NETWORK_EDGE_LIMIT = 360;

export type WorldCourseOption = OperatorCourseCandidate & {
  alias: string;
  label: string;
  displayName?: string | null;
  /** Set by this read model after the operator visibility projection. */
  operatorVisible?: boolean;
};

export function selectAutonomyWorldCourse(input: {
  courses: WorldCourseOption[];
  requestedCourse: string | null;
  latestSnapshotCourseAlias: string | null;
}): WorldCourseOption | null {
  // Callers that provide the projection marker have already evaluated the
  // operator visibility contract. Keep unmarked legacy fixtures compatible,
  // while never allowing an explicitly hidden course to be selected.
  const courses = input.courses.filter(
    (course) => course.operatorVisible !== false
  );
  const requested = input.requestedCourse
    ? courses.find(
        (course) => course.alias === input.requestedCourse
      )
    : null;
  if (requested) return requested;

  const latest = input.latestSnapshotCourseAlias
    ? courses.find(
        (course) =>
          course.alias === input.latestSnapshotCourseAlias
      )
    : null;
  return latest ?? courses[0] ?? null;
}

export type WorldNodeKind =
  | "course"
  | "column"
  | "thread"
  | "actor"
  | "concept"
  | "resource";

export type WorldActorRole =
  | "learner"
  | "creator"
  | "helper"
  | "follower"
  | "unknown"
  | null;

export type WorldThreadLane =
  | "open_gap"
  | "verified_response"
  | "distinct_response"
  | "follow_up"
  | "censored";

export type SafeWorldNode = {
  id: string;
  label: string;
  kind: WorldNodeKind;
  role: WorldActorRole;
  ordinal: number | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  completeness: "complete" | "censored";
  metrics: {
    eventCount: number;
    authoredThreadCount: number;
    replyCount: number;
    maxDepth: number;
    occurrenceCount: number;
  };
};

export type SafeWorldEdge = {
  id: string;
  sourceId: string;
  targetId: string;
  kind:
    | "contains"
    | "authored"
    | "participated_in"
    | "reply_to"
    | "discusses"
    | "references_resource";
  scopeId: string | null;
  weight: number;
  evidenceCount: number;
  completeness: "complete" | "censored";
};

export type SafeWorldThread = {
  id: string;
  label: string;
  authorId: string | null;
  authorLabel: string | null;
  lane: WorldThreadLane;
  firstEventAt: string;
  latestEventAt: string;
  eventCount: number;
  externalHumanCount: number;
  distinctActorResponseCount: number;
  authorReturnCount: number;
  systemResponseCount: number;
  maxDepth: number;
  completeness: "complete" | "censored";
  ageAtCutoffHours: number;
  openGapHours: number | null;
};

export type SafeNetworkNode = {
  id: string;
  label: string;
  role: WorldActorRole;
  x: number;
  y: number;
  radius: number;
  showLabel: boolean;
  eventCount: number;
  authoredThreadCount: number;
  replyCount: number;
  distinctPeerCount: number;
  inboundWeight: number;
  outboundWeight: number;
  systemTouchCount30d: number;
  lastSeenAt: string | null;
};

export type SafeNetworkEdge = {
  id: string;
  sourceId: string;
  targetId: string;
  weight: number;
  completeness: "complete" | "censored";
};

export type SafeLearnerPosition = {
  id: string;
  actorId: string;
  actorLabel: string;
  windowKind:
    | "rolling_7d"
    | "rolling_30d"
    | "all_time";
  coverageStatus:
    | "complete"
    | "lower_bound"
    | "insufficient_data";
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
};

export type AutonomyWorldReadModel = {
  courses: Array<{
    alias: string;
    label: string;
    displayName?: string | null;
  }>;
  selectedCourse: {
    alias: string;
    label: string;
    displayName?: string | null;
  } | null;
  snapshots: Array<{
    id: string;
    label: string;
    asOfAt: string;
    active: boolean;
  }>;
  selectionNotice:
    | "course_not_available"
    | "snapshot_not_in_course"
    | null;
  snapshot: {
    id: string;
    asOfAt: string;
    eventCount: number;
    threadCount: number;
    actorCount: number;
    edgeCount: number;
    openGapCount: number;
    worldLabel: string;
    eventSetLabel: string;
    graphLabel: string;
  } | null;
  coverage: SafeCoverageSummary | null;
  graph: {
    source: "course_content_graph_v2" | "world_v1_fallback";
    readStatus:
      | "ready"
      | "not_projected"
      | "storage_unavailable"
      | "integrity_failed";
    schemaVersion: string | null;
    coverageStatus: "complete" | "censored" | "unavailable";
    roleRegistryStatus: "complete" | "unavailable";
    nodeCount: number;
    edgeCount: number;
    actorNodeCount: number;
    learnerNodeCount: number;
    structureFactCount: number;
    activeLearnerCount: number;
    visibleNodeCount: number;
    visibleEdgeCount: number;
    nodeTruncated: boolean;
    edgeTruncated: boolean;
  };
  structure: {
    nodes: SafeWorldNode[];
    edges: SafeWorldEdge[];
    kindCounts: Record<WorldNodeKind, number>;
  };
  threads: SafeWorldThread[];
  laneCounts: Record<WorldThreadLane, number>;
  community: {
    nodes: SafeNetworkNode[];
    edges: SafeNetworkEdge[];
    totalActorCount: number;
    visibleActorCount: number;
    totalReplyEdgeCount: number;
    visibleReplyEdgeCount: number;
    truncated: boolean;
  };
  learnerCommunity: {
    nodes: SafeNetworkNode[];
    edges: SafeNetworkEdge[];
    totalLearnerCount: number;
    visibleLearnerCount: number;
    totalReplyEdgeCount: number;
    visibleReplyEdgeCount: number;
    truncated: boolean;
  };
  learnerPositions: SafeLearnerPosition[];
};

type InternalNode = {
  rawKey: string;
  kind: WorldNodeKind;
  role: WorldActorRole;
  ordinal: number | null;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  completeness: "complete" | "censored";
  metrics: SafeWorldNode["metrics"];
};

type InternalGraphEdge = {
  rawKey: string;
  sourceRawKey: string;
  targetRawKey: string;
  kind: SafeWorldEdge["kind"];
  scopeRawKey: string | null;
  weight: number;
  evidenceCount: number;
  completeness: "complete" | "censored";
};

const NODE_KIND_ORDER: WorldNodeKind[] = [
  "course",
  "column",
  "thread",
  "actor",
  "concept",
  "resource"
];

const NODE_LABELS: Record<WorldNodeKind, string> = {
  course: "课程",
  column: "栏目",
  thread: "讨论",
  actor: "成员",
  concept: "概念",
  resource: "资源"
};

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : 0;
}

function nonNegativeInteger(value: unknown): number {
  const number = finiteNumber(value);
  return number >= 0 ? Math.floor(number) : 0;
}

function safeMetrics(metricsJson: string): SafeWorldNode["metrics"] {
  try {
    const value = JSON.parse(metricsJson) as Record<
      string,
      unknown
    >;
    return {
      eventCount: nonNegativeInteger(value.event_count),
      authoredThreadCount: nonNegativeInteger(
        value.authored_thread_count
      ),
      replyCount: nonNegativeInteger(value.reply_count),
      maxDepth: nonNegativeInteger(value.max_depth),
      occurrenceCount: nonNegativeInteger(
        value.occurrence_count
      )
    };
  } catch {
    return {
      eventCount: 0,
      authoredThreadCount: 0,
      replyCount: 0,
      maxDepth: 0,
      occurrenceCount: 0
    };
  }
}

function shortDigest(
  value: string | null | undefined,
  prefix: string
): string {
  if (!value) return `${prefix}-—`;
  if (value.length <= 10) return `${prefix}-${value}`;
  return `${prefix}-${value.slice(0, 6)}…${value.slice(-4)}`;
}

function normalizeRole(value: string | null): WorldActorRole {
  return value === "learner" ||
    value === "creator" ||
    value === "helper" ||
    value === "follower" ||
    value === "unknown"
    ? value
    : null;
}

function normalizeCompleteness(
  value: string
): "complete" | "censored" {
  return value === "complete" ? "complete" : "censored";
}

function normalizeNodeKind(
  value: string
): WorldNodeKind | null {
  return NODE_KIND_ORDER.includes(value as WorldNodeKind)
    ? (value as WorldNodeKind)
    : null;
}

function normalizeEdgeKind(
  value: string
): SafeWorldEdge["kind"] | null {
  return value === "contains" ||
    value === "authored" ||
    value === "participated_in" ||
    value === "reply_to" ||
    value === "discusses" ||
    value === "references_resource"
    ? value
    : null;
}

function threadLane(input: {
  completeness: string;
  externalHumanCount: number;
  distinctActorResponseCount: number;
  authorReturnCount: number;
  systemResponseCount: number;
}): WorldThreadLane {
  if (input.completeness !== "complete") return "censored";
  if (
    input.externalHumanCount === 0 &&
    input.distinctActorResponseCount === 0 &&
    input.authorReturnCount === 0 &&
    input.systemResponseCount === 0
  ) {
    return "open_gap";
  }
  if (input.externalHumanCount > 0) {
    return "verified_response";
  }
  if (input.distinctActorResponseCount > 0) {
    return "distinct_response";
  }
  return "follow_up";
}

async function loadGraphSnapshot(input: {
  worldSnapshotId: string;
  courseAlias: string;
}) {
  try {
    const table = await prisma.$queryRaw<
      Array<{ name: string }>
    >`SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name = 'CourseContentGraphSnapshot'
      LIMIT 1`;
    if (table.length === 0) {
      return {
        snapshot: null,
        status: "storage_unavailable" as const
      };
    }
    const snapshot =
      await prisma.courseContentGraphSnapshot.findFirst({
        where: {
          worldSnapshotId: input.worldSnapshotId,
          courseAlias: input.courseAlias,
          schemaVersion: COURSE_CONTENT_GRAPH_SCHEMA_VERSION
        },
        select: {
          id: true,
          schemaVersion: true,
          contentGraphHash: true,
          nodeSetHash: true,
          edgeSetHash: true,
          stateJson: true,
          coverageStatus: true,
          roleRegistryStatus: true,
          nodeCount: true,
          edgeCount: true,
          learnerNodeCount: true,
          nodes: {
            select: {
              nodeKey: true,
              kind: true,
              role: true,
              ordinal: true,
              firstSeenAt: true,
              lastSeenAt: true,
              completeness: true,
              metricsJson: true,
              stateHash: true
            },
            orderBy: [
              { kind: "asc" },
              { nodeKey: "asc" }
            ],
            take: GRAPH_NODE_LIMIT
          },
          edges: {
            select: {
              edgeKey: true,
              sourceNodeKey: true,
              targetNodeKey: true,
              kind: true,
              scopeNodeKey: true,
              weight: true,
              evidenceCount: true,
              firstEventAt: true,
              latestEventAt: true,
              completeness: true,
              stateHash: true
            },
            orderBy: [
              { kind: "asc" },
              { edgeKey: "asc" }
            ],
            take: GRAPH_EDGE_LIMIT
          },
          learnerPositions: {
            select: {
              actorKey: true,
              windowKind: true,
              coverageStatus: true,
              eventCount: true,
              authoredThreadCount: true,
              replyCount: true,
              inboundReplyCount: true,
              outboundReplyCount: true,
              uniqueInboundPeerCount: true,
              uniqueOutboundPeerCount: true,
              reciprocalPeerCount: true,
              componentSize: true,
              kCore: true,
              pageRank: true,
              stateHash: true
            },
            orderBy: [
              { windowKind: "asc" },
              { actorKey: "asc" }
            ],
            take: LEARNER_POSITION_LIMIT
          }
        }
      });
    if (snapshot) {
      try {
        const normalizedNodes = snapshot.nodes
          .map((node) => {
            const material = {
              nodeKey: node.nodeKey,
              kind: node.kind,
              role: node.role,
              ordinal: node.ordinal,
              firstSeenAt: iso(node.firstSeenAt),
              lastSeenAt: iso(node.lastSeenAt),
              completeness: node.completeness,
              metrics: JSON.parse(
                node.metricsJson
              ) as CanonicalJsonValue
            };
            const expectedHash = canonicalProtocolHash(
              "cmooc.course-graph-node-state.v2",
              material as unknown as CanonicalJsonValue
            );
            if (expectedHash !== node.stateHash) {
              throw new Error("GRAPH_NODE_STATE_HASH_MISMATCH");
            }
            return {
              ...material,
              stateHash: node.stateHash
            };
          })
          .sort((left, right) =>
            left.nodeKey.localeCompare(right.nodeKey)
          );
        const normalizedEdges = snapshot.edges
          .map((edge) => {
            const material = {
              edgeKey: edge.edgeKey,
              sourceNodeKey: edge.sourceNodeKey,
              targetNodeKey: edge.targetNodeKey,
              kind: edge.kind,
              scopeNodeKey: edge.scopeNodeKey,
              weight: edge.weight,
              evidenceCount: edge.evidenceCount,
              firstEventAt: iso(edge.firstEventAt),
              latestEventAt: iso(edge.latestEventAt),
              completeness: edge.completeness
            };
            const expectedHash = canonicalProtocolHash(
              "cmooc.course-graph-edge-state.v2",
              material as unknown as CanonicalJsonValue
            );
            if (expectedHash !== edge.stateHash) {
              throw new Error("GRAPH_EDGE_STATE_HASH_MISMATCH");
            }
            return {
              ...material,
              stateHash: edge.stateHash
            };
          })
          .sort((left, right) =>
            left.edgeKey.localeCompare(right.edgeKey)
          );
        for (const position of snapshot.learnerPositions) {
          const expectedHash = canonicalProtocolHash(
            "cmooc.learner-network-position.v1",
            {
              actorKey: position.actorKey,
              windowKind: position.windowKind,
              coverageStatus: position.coverageStatus,
              eventCount: position.eventCount,
              authoredThreadCount:
                position.authoredThreadCount,
              replyCount: position.replyCount,
              inboundReplyCount:
                position.inboundReplyCount,
              outboundReplyCount:
                position.outboundReplyCount,
              uniqueInboundPeerCount:
                position.uniqueInboundPeerCount,
              uniqueOutboundPeerCount:
                position.uniqueOutboundPeerCount,
              reciprocalPeerCount:
                position.reciprocalPeerCount,
              componentSize: position.componentSize,
              kCore: position.kCore,
              pageRankE8:
                position.pageRank === null
                  ? null
                  : Math.round(
                      position.pageRank * 100_000_000
                    )
            } as unknown as CanonicalJsonValue
          );
          if (expectedHash !== position.stateHash) {
            throw new Error(
              "GRAPH_LEARNER_STATE_HASH_MISMATCH"
            );
          }
        }
        const state = JSON.parse(snapshot.stateJson) as {
          learnerPositionCount?: unknown;
        };
        const allChildrenLoaded =
          snapshot.nodeCount <= GRAPH_NODE_LIMIT &&
          snapshot.edgeCount <= GRAPH_EDGE_LIMIT &&
          typeof state.learnerPositionCount === "number" &&
          state.learnerPositionCount <= LEARNER_POSITION_LIMIT;
        if (
          allChildrenLoaded &&
          (snapshot.nodeCount !== normalizedNodes.length ||
            snapshot.edgeCount !== normalizedEdges.length ||
            state.learnerPositionCount !==
              snapshot.learnerPositions.length ||
            canonicalProtocolHash(
              "cmooc.course-graph-node-set.v2",
              normalizedNodes as unknown as CanonicalJsonValue
            ) !== snapshot.nodeSetHash ||
            canonicalProtocolHash(
              "cmooc.course-graph-edge-set.v2",
              normalizedEdges as unknown as CanonicalJsonValue
            ) !== snapshot.edgeSetHash)
        ) {
          throw new Error("GRAPH_CHILD_SET_HASH_MISMATCH");
        }
      } catch {
        return {
          snapshot: null,
          status: "integrity_failed" as const
        };
      }
    }
    return {
      snapshot,
      status: snapshot
        ? ("ready" as const)
        : ("not_projected" as const)
    };
  } catch {
    // Deploys can briefly serve the UI before the additive Graph v2
    // migration is applied. The v1 world remains a safe read-only fallback.
    return {
      snapshot: null,
      status: "storage_unavailable" as const
    };
  }
}

function emptyKindCounts(): Record<WorldNodeKind, number> {
  return {
    course: 0,
    column: 0,
    thread: 0,
    actor: 0,
    concept: 0,
    resource: 0
  };
}

function emptyLaneCounts(): Record<WorldThreadLane, number> {
  return {
    open_gap: 0,
    verified_response: 0,
    distinct_response: 0,
    follow_up: 0,
    censored: 0
  };
}

function emptyModel(input: {
  courses: AutonomyWorldReadModel["courses"];
  selectedCourse: AutonomyWorldReadModel["selectedCourse"];
  selectionNotice: AutonomyWorldReadModel["selectionNotice"];
}): AutonomyWorldReadModel {
  return {
    courses: input.courses,
    selectedCourse: input.selectedCourse,
    snapshots: [],
    selectionNotice: input.selectionNotice,
    snapshot: null,
    coverage: null,
    graph: {
      source: "world_v1_fallback",
      readStatus: "not_projected",
      schemaVersion: null,
      coverageStatus: "unavailable",
      roleRegistryStatus: "unavailable",
      nodeCount: 0,
      edgeCount: 0,
      actorNodeCount: 0,
      learnerNodeCount: 0,
      structureFactCount: 0,
      activeLearnerCount: 0,
      visibleNodeCount: 0,
      visibleEdgeCount: 0,
      nodeTruncated: false,
      edgeTruncated: false
    },
    structure: {
      nodes: [],
      edges: [],
      kindCounts: emptyKindCounts()
    },
    threads: [],
    laneCounts: emptyLaneCounts(),
    community: {
      nodes: [],
      edges: [],
      totalActorCount: 0,
      visibleActorCount: 0,
      totalReplyEdgeCount: 0,
      visibleReplyEdgeCount: 0,
      truncated: false
    },
    learnerCommunity: {
      nodes: [],
      edges: [],
      totalLearnerCount: 0,
      visibleLearnerCount: 0,
      totalReplyEdgeCount: 0,
      visibleReplyEdgeCount: 0,
      truncated: false
    },
    learnerPositions: []
  };
}

export async function getAutonomyWorldReadModel(input: {
  courseAlias?: string | null;
  snapshotId?: string | null;
}): Promise<AutonomyWorldReadModel> {
  const manifests =
    await prisma.autonomyCourseManifest.findMany({
      where: { enabled: true },
      select: { alias: true, enabled: true },
      orderBy: { alias: "asc" }
    });
  // This projection is intentionally read-model-only. Worker/tick discovery
  // still uses every explicit manifest, while synthetic/regression aliases are
  // removed from the operator selector and cannot become the fallback course.
  const visibleManifests = filterOperatorCourses(manifests);
  const courseNames = await loadVerifiedOperatorCourseNames(
    visibleManifests.map((manifest) => manifest.alias)
  );
  const courses: WorldCourseOption[] = visibleManifests.map(
    (manifest, index) => {
      const presentation = buildOperatorCoursePresentation({
        alias: manifest.alias,
        courseName: courseNames.get(manifest.alias) ?? null,
        ordinal: index + 1
      });
      return {
        alias: presentation.alias,
        label: presentation.label,
        displayName: presentation.displayName,
        enabled: manifest.enabled,
        operatorVisible: true
      };
    }
  );
  const requestedCourse = input.courseAlias ?? null;
  const latestSnapshotCourse =
    courses.length > 0
      ? await prisma.courseWorldSnapshot.findFirst({
          where: {
            courseAlias: {
              in: courses.map((course) => course.alias)
            }
          },
          select: { courseAlias: true },
          orderBy: { asOfAt: "desc" }
        })
      : null;
  const selectedCourse = selectAutonomyWorldCourse({
    courses,
    requestedCourse,
    latestSnapshotCourseAlias:
      latestSnapshotCourse?.courseAlias ?? null
  });
  const courseNotice =
    requestedCourse &&
    (!selectedCourse || selectedCourse.alias !== requestedCourse)
      ? ("course_not_available" as const)
      : null;
  if (!selectedCourse) {
    return emptyModel({
      courses,
      selectedCourse: null,
      selectionNotice: courseNotice
    });
  }

  const [recentSnapshots, requestedSnapshot] =
    await Promise.all([
      prisma.courseWorldSnapshot.findMany({
        where: { courseAlias: selectedCourse.alias },
        select: {
          id: true,
          invocationId: true,
          asOfAt: true,
          eventSetHash: true,
          worldHash: true,
          graphHash: true,
          eventCount: true,
          threadCount: true,
          actorCount: true,
          edgeCount: true,
          openGapCount: true
        },
        orderBy: { asOfAt: "desc" },
        take: WORLD_SNAPSHOT_LIMIT
      }),
      input.snapshotId
        ? prisma.courseWorldSnapshot.findFirst({
            where: {
              id: input.snapshotId,
              courseAlias: selectedCourse.alias
            },
            select: {
              id: true,
              invocationId: true,
              asOfAt: true,
              eventSetHash: true,
              worldHash: true,
              graphHash: true,
              eventCount: true,
              threadCount: true,
              actorCount: true,
              edgeCount: true,
              openGapCount: true
            }
          })
        : Promise.resolve(null)
    ]);
  const snapshotNotice =
    input.snapshotId && !requestedSnapshot
      ? ("snapshot_not_in_course" as const)
      : null;
  const snapshot =
    requestedSnapshot ?? recentSnapshots[0] ?? null;
  if (!snapshot) {
    return emptyModel({
      courses,
      selectedCourse,
      selectionNotice: snapshotNotice ?? courseNotice
    });
  }
  const snapshotOptions = recentSnapshots.some(
    (item) => item.id === snapshot.id
  )
    ? recentSnapshots
    : [snapshot, ...recentSnapshots.slice(0, -1)]
        .sort(
          (left, right) =>
            right.asOfAt.getTime() - left.asOfAt.getTime()
        )
        .slice(0, WORLD_SNAPSHOT_LIMIT);

  const [threads, actors, legacyEdges, scan, graphResult] =
    await Promise.all([
      prisma.threadStateAtCutoff.findMany({
        where: { snapshotId: snapshot.id },
        select: {
          threadKey: true,
          authorKey: true,
          firstEventAt: true,
          latestEventAt: true,
          eventCount: true,
          externalHumanCount: true,
          distinctActorResponseCount: true,
          authorReturnCount: true,
          systemResponseCount: true,
          maxDepth: true,
          completeness: true,
          supportGapHours: true
        },
        orderBy: [
          { supportGapHours: "desc" },
          { threadKey: "asc" }
        ],
        take: THREAD_LIMIT
      }),
      prisma.actorCourseStateAtCutoff.findMany({
        where: { snapshotId: snapshot.id },
        select: {
          actorKey: true,
          firstSeenAt: true,
          lastSeenAt: true,
          eventCount: true,
          authoredThreadCount: true,
          replyCount: true,
          distinctPeerCount: true,
          systemTouchCount30d: true
        },
        orderBy: [
          { eventCount: "desc" },
          { actorKey: "asc" }
        ],
        take: ACTOR_LIMIT
      }),
      prisma.interactionEdgeProjection.findMany({
        where: { snapshotId: snapshot.id },
        select: {
          edgeKey: true,
          sourceActorKey: true,
          targetActorKey: true,
          threadKey: true,
          kind: true,
          weight: true
        },
        orderBy: [
          { weight: "desc" },
          { edgeKey: "asc" }
        ],
        take: LEGACY_EDGE_LIMIT
      }),
      prisma.courseScanRun.findUnique({
        where: { invocationId: snapshot.invocationId },
        select: { id: true, coverageJson: true }
      }),
      loadGraphSnapshot({
        worldSnapshotId: snapshot.id,
        courseAlias: selectedCourse.alias
      })
    ]);
  const graphSnapshot = graphResult.snapshot;
  const [structureFactCount, actorNodeCount] =
    await Promise.all([
      scan
        ? prisma.courseStructureFactObservation.count({
            where: { scanRunId: scan.id }
          })
        : Promise.resolve(0),
      graphSnapshot
        ? prisma.courseGraphNodeProjection.count({
            where: {
              graphSnapshotId: graphSnapshot.id,
              kind: "actor"
            }
          })
        : Promise.resolve(snapshot.actorCount)
    ]);
  const activeLearnerCount =
    graphSnapshot?.learnerPositions.filter(
      (position) =>
        position.windowKind === "all_time" &&
        position.eventCount > 0
    ).length ?? 0;

  const internalNodes = new Map<string, InternalNode>();
  const upsertNode = (node: InternalNode) => {
    const existing = internalNodes.get(node.rawKey);
    if (!existing) {
      internalNodes.set(node.rawKey, node);
      return;
    }
    if (existing.kind !== node.kind) return;
    internalNodes.set(node.rawKey, {
      ...existing,
      ...node,
      role: node.role ?? existing.role,
      metrics: {
        eventCount: Math.max(
          existing.metrics.eventCount,
          node.metrics.eventCount
        ),
        authoredThreadCount: Math.max(
          existing.metrics.authoredThreadCount,
          node.metrics.authoredThreadCount
        ),
        replyCount: Math.max(
          existing.metrics.replyCount,
          node.metrics.replyCount
        ),
        maxDepth: Math.max(
          existing.metrics.maxDepth,
          node.metrics.maxDepth
        ),
        occurrenceCount: Math.max(
          existing.metrics.occurrenceCount,
          node.metrics.occurrenceCount
        )
      }
    });
  };

  if (graphSnapshot) {
    for (const node of graphSnapshot.nodes) {
      const kind = normalizeNodeKind(node.kind);
      if (!kind) continue;
      upsertNode({
        rawKey: node.nodeKey,
        kind,
        role: normalizeRole(node.role),
        ordinal: node.ordinal,
        firstSeenAt: node.firstSeenAt,
        lastSeenAt: node.lastSeenAt,
        completeness: normalizeCompleteness(node.completeness),
        metrics: safeMetrics(node.metricsJson)
      });
    }
  } else {
    upsertNode({
      rawKey: `local-course:${selectedCourse.alias}`,
      kind: "course",
      role: null,
      ordinal: 1,
      firstSeenAt: null,
      lastSeenAt: snapshot.asOfAt,
      completeness: "censored",
      metrics: {
        eventCount: snapshot.eventCount,
        authoredThreadCount: 0,
        replyCount: 0,
        maxDepth: 0,
        occurrenceCount: 0
      }
    });
  }
  for (const thread of threads) {
    upsertNode({
      rawKey: thread.threadKey,
      kind: "thread",
      role: null,
      ordinal: null,
      firstSeenAt: thread.firstEventAt,
      lastSeenAt: thread.latestEventAt,
      completeness: normalizeCompleteness(thread.completeness),
      metrics: {
        eventCount: thread.eventCount,
        authoredThreadCount: 0,
        replyCount: Math.max(0, thread.eventCount - 1),
        maxDepth: thread.maxDepth,
        occurrenceCount: 0
      }
    });
  }
  for (const actor of actors) {
    upsertNode({
      rawKey: actor.actorKey,
      kind: "actor",
      role: internalNodes.get(actor.actorKey)?.role ?? null,
      ordinal: null,
      firstSeenAt: actor.firstSeenAt,
      lastSeenAt: actor.lastSeenAt,
      completeness:
        graphSnapshot?.coverageStatus === "complete"
          ? "complete"
          : "censored",
      metrics: {
        eventCount: actor.eventCount,
        authoredThreadCount: actor.authoredThreadCount,
        replyCount: actor.replyCount,
        maxDepth: 0,
        occurrenceCount: 0
      }
    });
  }

  const sortedInternalNodes = [...internalNodes.values()].sort(
    (left, right) =>
      NODE_KIND_ORDER.indexOf(left.kind) -
        NODE_KIND_ORDER.indexOf(right.kind) ||
      (left.ordinal ?? Number.MAX_SAFE_INTEGER) -
        (right.ordinal ?? Number.MAX_SAFE_INTEGER) ||
      left.rawKey.localeCompare(right.rawKey)
  );
  const kindCounters = emptyKindCounts();
  const localNodeByRawKey = new Map<
    string,
    SafeWorldNode
  >();
  for (const node of sortedInternalNodes) {
    kindCounters[node.kind] += 1;
    const index = String(kindCounters[node.kind]).padStart(
      2,
      "0"
    );
    localNodeByRawKey.set(node.rawKey, {
      id: `${node.kind}-${String(
        kindCounters[node.kind]
      ).padStart(3, "0")}`,
      label: `${NODE_LABELS[node.kind]} ${index}`,
      kind: node.kind,
      role: node.role,
      ordinal: node.ordinal,
      firstSeenAt: iso(node.firstSeenAt),
      lastSeenAt: iso(node.lastSeenAt),
      completeness: node.completeness,
      metrics: node.metrics
    });
  }
  const safeNodes = [...localNodeByRawKey.values()];

  const internalGraphEdges: InternalGraphEdge[] = [];
  if (graphSnapshot) {
    for (const edge of graphSnapshot.edges) {
      const kind = normalizeEdgeKind(edge.kind);
      if (
        !kind ||
        !localNodeByRawKey.has(edge.sourceNodeKey) ||
        !localNodeByRawKey.has(edge.targetNodeKey)
      ) {
        continue;
      }
      internalGraphEdges.push({
        rawKey: edge.edgeKey,
        sourceRawKey: edge.sourceNodeKey,
        targetRawKey: edge.targetNodeKey,
        kind,
        scopeRawKey: edge.scopeNodeKey,
        weight: Math.max(0, finiteNumber(edge.weight)),
        evidenceCount: nonNegativeInteger(
          edge.evidenceCount
        ),
        completeness: normalizeCompleteness(
          edge.completeness
        )
      });
    }
  }
  const safeEdges = internalGraphEdges.map(
    (edge, index): SafeWorldEdge => ({
      id: `relation-${String(index + 1).padStart(3, "0")}`,
      sourceId:
        localNodeByRawKey.get(edge.sourceRawKey)?.id ?? "",
      targetId:
        localNodeByRawKey.get(edge.targetRawKey)?.id ?? "",
      kind: edge.kind,
      scopeId: edge.scopeRawKey
        ? localNodeByRawKey.get(edge.scopeRawKey)?.id ?? null
        : null,
      weight: edge.weight,
      evidenceCount: edge.evidenceCount,
      completeness: edge.completeness
    })
  );

  const laneCounts = emptyLaneCounts();
  const safeThreads = threads.map(
    (thread): SafeWorldThread => {
      const localThread = localNodeByRawKey.get(
        thread.threadKey
      );
      const localAuthor = thread.authorKey
        ? localNodeByRawKey.get(thread.authorKey)
        : null;
      const lane = threadLane(thread);
      laneCounts[lane] += 1;
      const isOpenGap =
        thread.externalHumanCount === 0 &&
        thread.distinctActorResponseCount === 0 &&
        thread.authorReturnCount === 0 &&
        thread.systemResponseCount === 0;
      return {
        id: localThread?.id ?? "thread-unresolved",
        label: localThread?.label ?? "讨论（未解析）",
        authorId: localAuthor?.id ?? null,
        authorLabel: localAuthor?.label ?? null,
        lane,
        firstEventAt: thread.firstEventAt.toISOString(),
        latestEventAt: thread.latestEventAt.toISOString(),
        eventCount: thread.eventCount,
        externalHumanCount: thread.externalHumanCount,
        distinctActorResponseCount:
          thread.distinctActorResponseCount,
        authorReturnCount: thread.authorReturnCount,
        systemResponseCount: thread.systemResponseCount,
        maxDepth: thread.maxDepth,
        completeness: normalizeCompleteness(
          thread.completeness
        ),
        ageAtCutoffHours: Math.max(
          0,
          Math.floor(thread.supportGapHours)
        ),
        openGapHours: isOpenGap
          ? Math.max(0, Math.floor(thread.supportGapHours))
          : null
      };
    }
  );

  const legacyActorByKey = new Map(
    actors.map((actor) => [actor.actorKey, actor])
  );
  const networkRawEdges = graphSnapshot
    ? internalGraphEdges
        .filter((edge) => edge.kind === "reply_to")
        .map((edge) => ({
          rawKey: edge.rawKey,
          sourceRawKey: edge.sourceRawKey,
          targetRawKey: edge.targetRawKey,
          weight: edge.weight,
          completeness: edge.completeness
        }))
    : legacyEdges.flatMap((edge) =>
        edge.sourceActorKey &&
        edge.targetActorKey &&
        edge.sourceActorKey !== edge.targetActorKey &&
        localNodeByRawKey.has(edge.sourceActorKey) &&
        localNodeByRawKey.has(edge.targetActorKey)
          ? [
              {
                rawKey: edge.edgeKey,
                sourceRawKey: edge.sourceActorKey,
                targetRawKey: edge.targetActorKey,
                weight: Math.max(0, edge.weight),
                completeness: "censored" as const
              }
            ]
          : []
      );
  const inboundWeight = new Map<string, number>();
  const outboundWeight = new Map<string, number>();
  const peerKeys = new Map<string, Set<string>>();
  for (const edge of networkRawEdges) {
    outboundWeight.set(
      edge.sourceRawKey,
      (outboundWeight.get(edge.sourceRawKey) ?? 0) +
        edge.weight
    );
    inboundWeight.set(
      edge.targetRawKey,
      (inboundWeight.get(edge.targetRawKey) ?? 0) +
        edge.weight
    );
    const sourcePeers =
      peerKeys.get(edge.sourceRawKey) ?? new Set<string>();
    sourcePeers.add(edge.targetRawKey);
    peerKeys.set(edge.sourceRawKey, sourcePeers);
    const targetPeers =
      peerKeys.get(edge.targetRawKey) ?? new Set<string>();
    targetPeers.add(edge.sourceRawKey);
    peerKeys.set(edge.targetRawKey, targetPeers);
  }
  const actorNodes = sortedInternalNodes
    .filter((node) => node.kind === "actor")
    .sort(
      (left, right) =>
        (inboundWeight.get(right.rawKey) ?? 0) +
          (outboundWeight.get(right.rawKey) ?? 0) -
          ((inboundWeight.get(left.rawKey) ?? 0) +
            (outboundWeight.get(left.rawKey) ?? 0)) ||
        right.metrics.eventCount - left.metrics.eventCount ||
        left.rawKey.localeCompare(right.rawKey)
    );
  const visibleActors = actorNodes.slice(
    0,
    NETWORK_NODE_LIMIT
  );
  const visibleActorKeys = new Set(
    visibleActors.map((actor) => actor.rawKey)
  );
  const safeNetworkNodes = visibleActors.map(
    (actor, index): SafeNetworkNode => {
      const local = localNodeByRawKey.get(actor.rawKey);
      const legacy = legacyActorByKey.get(actor.rawKey);
      const weightedDegree =
        (inboundWeight.get(actor.rawKey) ?? 0) +
        (outboundWeight.get(actor.rawKey) ?? 0);
      let x = 450;
      let y = 270;
      if (index > 0) {
        const innerRingCount = Math.min(
          Math.max(visibleActors.length - 1, 0),
          14
        );
        const isInner = index <= innerRingCount;
        const ringIndex = isInner
          ? index - 1
          : index - innerRingCount - 1;
        const ringCount = isInner
          ? innerRingCount
          : Math.max(
              1,
              visibleActors.length - innerRingCount - 1
            );
        const radius = isInner ? 135 : 232;
        const angle =
          (ringIndex / ringCount) * Math.PI * 2 -
          Math.PI / 2;
        x = Math.round(450 + Math.cos(angle) * radius);
        y = Math.round(270 + Math.sin(angle) * radius);
      }
      return {
        id: local?.id ?? "actor-unresolved",
        label: local?.label ?? "成员（未解析）",
        role: actor.role,
        x,
        y,
        radius: Math.min(
          14,
          5 + Math.sqrt(Math.max(0, weightedDegree))
        ),
        showLabel: index < 12,
        eventCount: actor.metrics.eventCount,
        authoredThreadCount:
          actor.metrics.authoredThreadCount,
        replyCount: actor.metrics.replyCount,
        distinctPeerCount:
          legacy?.distinctPeerCount ??
          peerKeys.get(actor.rawKey)?.size ??
          0,
        inboundWeight: inboundWeight.get(actor.rawKey) ?? 0,
        outboundWeight:
          outboundWeight.get(actor.rawKey) ?? 0,
        systemTouchCount30d:
          legacy?.systemTouchCount30d ?? 0,
        lastSeenAt: iso(
          legacy?.lastSeenAt ?? actor.lastSeenAt
        )
      };
    }
  );
  const visibleNetworkEdges = networkRawEdges
    .filter(
      (edge) =>
        visibleActorKeys.has(edge.sourceRawKey) &&
        visibleActorKeys.has(edge.targetRawKey)
    )
    .sort(
      (left, right) =>
        right.weight - left.weight ||
        left.rawKey.localeCompare(right.rawKey)
    )
    .slice(0, NETWORK_EDGE_LIMIT)
    .map((edge, index): SafeNetworkEdge => ({
      id: `reply-${String(index + 1).padStart(3, "0")}`,
      sourceId:
        localNodeByRawKey.get(edge.sourceRawKey)?.id ?? "",
      targetId:
        localNodeByRawKey.get(edge.targetRawKey)?.id ?? "",
      weight: edge.weight,
      completeness: edge.completeness
    }));

  const learnerActors = actorNodes.filter(
    (actor) => actor.role === "learner"
  );
  const learnerActorKeys = new Set(
    learnerActors.map((actor) => actor.rawKey)
  );
  const visibleLearnerActors = learnerActors.slice(
    0,
    LEARNER_NETWORK_NODE_LIMIT
  );
  const visibleLearnerKeys = new Set(
    visibleLearnerActors.map((actor) => actor.rawKey)
  );
  const safeLearnerNetworkNodes = visibleLearnerActors.map(
    (actor, index): SafeNetworkNode => {
      const local = localNodeByRawKey.get(actor.rawKey);
      const legacy = legacyActorByKey.get(actor.rawKey);
      const weightedDegree =
        (inboundWeight.get(actor.rawKey) ?? 0) +
        (outboundWeight.get(actor.rawKey) ?? 0);
      const ringCount = Math.max(1, visibleLearnerActors.length);
      const angle = (index / ringCount) * Math.PI * 2 - Math.PI / 2;
      const ring = index < 28 ? 150 : 238;
      return {
        id: local?.id ?? "actor-unresolved",
        label: local?.label ?? "学习者（未解析）",
        role: "learner",
        x: Math.round(450 + Math.cos(angle) * ring),
        y: Math.round(270 + Math.sin(angle) * ring),
        radius: Math.min(
          14,
          5 + Math.sqrt(Math.max(0, weightedDegree))
        ),
        showLabel: index < 12,
        eventCount: actor.metrics.eventCount,
        authoredThreadCount: actor.metrics.authoredThreadCount,
        replyCount: actor.metrics.replyCount,
        distinctPeerCount:
          legacy?.distinctPeerCount ?? peerKeys.get(actor.rawKey)?.size ?? 0,
        inboundWeight: inboundWeight.get(actor.rawKey) ?? 0,
        outboundWeight: outboundWeight.get(actor.rawKey) ?? 0,
        systemTouchCount30d: legacy?.systemTouchCount30d ?? 0,
        lastSeenAt: iso(legacy?.lastSeenAt ?? actor.lastSeenAt)
      };
    }
  );
  const learnerNetworkRawEdges = networkRawEdges.filter(
    (edge) =>
      learnerActorKeys.has(edge.sourceRawKey) &&
      learnerActorKeys.has(edge.targetRawKey)
  );
  const visibleLearnerNetworkEdges = learnerNetworkRawEdges
    .filter(
      (edge) =>
        visibleLearnerKeys.has(edge.sourceRawKey) &&
        visibleLearnerKeys.has(edge.targetRawKey)
    )
    .sort(
      (left, right) =>
        right.weight - left.weight || left.rawKey.localeCompare(right.rawKey)
    )
    .slice(0, LEARNER_NETWORK_EDGE_LIMIT)
    .map((edge, index): SafeNetworkEdge => ({
      id: `learner-reply-${String(index + 1).padStart(3, "0")}`,
      sourceId: localNodeByRawKey.get(edge.sourceRawKey)?.id ?? "",
      targetId: localNodeByRawKey.get(edge.targetRawKey)?.id ?? "",
      weight: edge.weight,
      completeness: edge.completeness
    }));

  const safeLearnerPositions: SafeLearnerPosition[] =
    graphSnapshot
      ? graphSnapshot.learnerPositions.flatMap(
          (position, index) => {
            const actor = localNodeByRawKey.get(
              position.actorKey
            );
            if (
              !actor ||
              actor.kind !== "actor" ||
              actor.role !== "learner" ||
              (position.windowKind !== "rolling_7d" &&
                position.windowKind !== "rolling_30d" &&
                position.windowKind !== "all_time") ||
              (position.coverageStatus !== "complete" &&
                position.coverageStatus !== "lower_bound" &&
                position.coverageStatus !==
                  "insufficient_data")
            ) {
              return [];
            }
            return [
              {
                id: `position-${String(index + 1).padStart(
                  3,
                  "0"
                )}`,
                actorId: actor.id,
                actorLabel: actor.label,
                windowKind: position.windowKind,
                coverageStatus: position.coverageStatus,
                eventCount: position.eventCount,
                authoredThreadCount:
                  position.authoredThreadCount,
                replyCount: position.replyCount,
                inboundReplyCount:
                  position.inboundReplyCount,
                outboundReplyCount:
                  position.outboundReplyCount,
                uniqueInboundPeerCount:
                  position.uniqueInboundPeerCount,
                uniqueOutboundPeerCount:
                  position.uniqueOutboundPeerCount,
                reciprocalPeerCount:
                  position.reciprocalPeerCount,
                componentSize: position.componentSize,
                kCore:
                  graphSnapshot.coverageStatus === "complete" &&
                  position.coverageStatus === "complete"
                    ? position.kCore
                    : null,
                pageRank:
                  graphSnapshot.coverageStatus === "complete" &&
                  position.coverageStatus === "complete"
                    ? position.pageRank
                    : null
              }
            ];
          }
        )
      : [];

  return {
    courses,
    selectedCourse,
    snapshots: snapshotOptions.map((item, index) => ({
      id: item.id,
      label: `T-${index}`,
      asOfAt: item.asOfAt.toISOString(),
      active: item.id === snapshot.id
    })),
    selectionNotice: snapshotNotice ?? courseNotice,
    snapshot: {
      id: snapshot.id,
      asOfAt: snapshot.asOfAt.toISOString(),
      eventCount: snapshot.eventCount,
      threadCount: snapshot.threadCount,
      actorCount: snapshot.actorCount,
      edgeCount: snapshot.edgeCount,
      openGapCount: snapshot.openGapCount,
      worldLabel: shortDigest(snapshot.worldHash, "W"),
      eventSetLabel: shortDigest(
        snapshot.eventSetHash,
        "E"
      ),
      graphLabel: shortDigest(
        graphSnapshot?.contentGraphHash ?? snapshot.graphHash,
        "G"
      )
    },
    coverage: parseSafeCoverageSummary(scan?.coverageJson),
    graph: {
      source: graphSnapshot
        ? "course_content_graph_v2"
        : "world_v1_fallback",
      readStatus: graphResult.status,
      schemaVersion: graphSnapshot?.schemaVersion ?? null,
      coverageStatus:
        graphSnapshot?.coverageStatus === "complete"
          ? "complete"
          : graphSnapshot
            ? "censored"
            : "unavailable",
      roleRegistryStatus:
        graphSnapshot?.roleRegistryStatus === "complete"
          ? "complete"
          : "unavailable",
      nodeCount:
        graphSnapshot?.nodeCount ?? safeNodes.length,
      edgeCount:
        graphSnapshot?.edgeCount ?? networkRawEdges.length,
      actorNodeCount,
      learnerNodeCount:
        graphSnapshot?.learnerNodeCount ?? 0,
      structureFactCount,
      activeLearnerCount,
      visibleNodeCount: safeNodes.length,
      visibleEdgeCount: graphSnapshot
        ? safeEdges.length
        : networkRawEdges.length,
      nodeTruncated:
        (graphSnapshot?.nodeCount ?? safeNodes.length) >
        safeNodes.length,
      edgeTruncated:
        (graphSnapshot?.edgeCount ?? networkRawEdges.length) >
        (graphSnapshot ? safeEdges.length : networkRawEdges.length)
    },
    structure: {
      nodes: safeNodes,
      edges: safeEdges,
      kindCounts: kindCounters
    },
    threads: safeThreads,
    laneCounts,
    community: {
      nodes: safeNetworkNodes,
      edges: visibleNetworkEdges,
      totalActorCount: snapshot.actorCount,
      visibleActorCount: safeNetworkNodes.length,
      totalReplyEdgeCount: networkRawEdges.length,
      visibleReplyEdgeCount: visibleNetworkEdges.length,
      truncated:
        actorNodes.length > safeNetworkNodes.length ||
        networkRawEdges.length > visibleNetworkEdges.length
    },
    learnerCommunity: {
      nodes: safeLearnerNetworkNodes,
      edges: visibleLearnerNetworkEdges,
      totalLearnerCount: learnerActors.length,
      visibleLearnerCount: safeLearnerNetworkNodes.length,
      totalReplyEdgeCount: learnerNetworkRawEdges.length,
      visibleReplyEdgeCount: visibleLearnerNetworkEdges.length,
      truncated:
        learnerActors.length > safeLearnerNetworkNodes.length ||
        learnerNetworkRawEdges.length > visibleLearnerNetworkEdges.length
    },
    learnerPositions: safeLearnerPositions
  };
}
