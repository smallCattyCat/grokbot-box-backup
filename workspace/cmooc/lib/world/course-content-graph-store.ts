import type {
  Prisma,
  PrismaClient
} from "@prisma/client";
import {
  COURSE_CONTENT_GRAPH_SCHEMA_VERSION,
  projectCourseContentGraphV2,
  type CourseContentGraphProjectionV2
} from "./course-content-graph-projector";
import {
  hashCourseStructureFactSet
} from "./course-structure-fact";
import {
  loadCourseStructureFactsForScan
} from "./course-structure-store";
import type {
  ProjectableCourseEvent
} from "./live-world-projector";
import {
  loadCourseEventRevisionsAtCutoff
} from "./live-event";

function normalizedTime(value: Date | string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("COURSE_CONTENT_GRAPH_CUTOFF_INVALID");
  }
  return parsed;
}

function expectedStateJson(
  projection: CourseContentGraphProjectionV2,
  structureFactSetHash: string
): string {
  return JSON.stringify({
    schemaVersion: COURSE_CONTENT_GRAPH_SCHEMA_VERSION,
    courseKey: projection.courseKey,
    worldHash: projection.worldHash,
    asOfAt: projection.asOfAt,
    structureFactSetHash,
    nodeSetHash: projection.nodeSetHash,
    edgeSetHash: projection.edgeSetHash,
    contentGraphHash: projection.graphHash,
    nodeCount: projection.nodes.length,
    edgeCount: projection.edges.length,
    learnerNodeCount: projection.nodes.filter(
      (node) => node.kind === "actor" && node.role === "learner"
    ).length,
    learnerPositionCount: projection.learnerPositions.length,
    coverageStatus: projection.coverageStatus,
    roleRegistryStatus: projection.roleRegistryStatus,
    containsForumText: false
  });
}

async function persistProjectionChildren(input: {
  tx: Prisma.TransactionClient;
  graphSnapshotId: string;
  projection: CourseContentGraphProjectionV2;
}): Promise<void> {
  if (input.projection.nodes.length > 0) {
    await input.tx.courseGraphNodeProjection.createMany({
      data: input.projection.nodes.map((node) => ({
        graphSnapshotId: input.graphSnapshotId,
        nodeKey: node.nodeKey,
        kind: node.kind,
        role: node.role,
        ordinal: node.ordinal,
        firstSeenAt: node.firstSeenAt
          ? new Date(node.firstSeenAt)
          : null,
        lastSeenAt: node.lastSeenAt
          ? new Date(node.lastSeenAt)
          : null,
        completeness: node.completeness,
        metricsJson: JSON.stringify(node.metrics),
        stateHash: node.stateHash
      }))
    });
  }
  if (input.projection.edges.length > 0) {
    await input.tx.courseGraphEdgeProjection.createMany({
      data: input.projection.edges.map((edge) => ({
        graphSnapshotId: input.graphSnapshotId,
        edgeKey: edge.edgeKey,
        sourceNodeKey: edge.sourceNodeKey,
        targetNodeKey: edge.targetNodeKey,
        kind: edge.kind,
        scopeNodeKey: edge.scopeNodeKey,
        weight: edge.weight,
        evidenceCount: edge.evidenceCount,
        firstEventAt: edge.firstEventAt
          ? new Date(edge.firstEventAt)
          : null,
        latestEventAt: edge.latestEventAt
          ? new Date(edge.latestEventAt)
          : null,
        completeness: edge.completeness,
        stateHash: edge.stateHash
      }))
    });
  }
  if (input.projection.learnerPositions.length > 0) {
    await input.tx.learnerNetworkPositionAtCutoff.createMany({
      data: input.projection.learnerPositions.map((position) => ({
        graphSnapshotId: input.graphSnapshotId,
        actorKey: position.actorKey,
        windowKind: position.windowKind,
        coverageStatus: position.coverageStatus,
        eventCount: position.eventCount,
        authoredThreadCount: position.authoredThreadCount,
        replyCount: position.replyCount,
        inboundReplyCount: position.inboundReplyCount,
        outboundReplyCount: position.outboundReplyCount,
        uniqueInboundPeerCount:
          position.uniqueInboundPeerCount,
        uniqueOutboundPeerCount:
          position.uniqueOutboundPeerCount,
        reciprocalPeerCount: position.reciprocalPeerCount,
        componentSize: position.componentSize,
        kCore: position.kCore,
        pageRank: position.pageRank,
        stateHash: position.stateHash
      }))
    });
  }
}

async function assertPersistedChildrenMatch(input: {
  tx: Prisma.TransactionClient;
  graphSnapshotId: string;
  projection: CourseContentGraphProjectionV2;
}): Promise<void> {
  const [nodes, edges, positions] = await Promise.all([
    input.tx.courseGraphNodeProjection.findMany({
      where: { graphSnapshotId: input.graphSnapshotId },
      select: { nodeKey: true, stateHash: true },
      orderBy: { nodeKey: "asc" }
    }),
    input.tx.courseGraphEdgeProjection.findMany({
      where: { graphSnapshotId: input.graphSnapshotId },
      select: { edgeKey: true, stateHash: true },
      orderBy: { edgeKey: "asc" }
    }),
    input.tx.learnerNetworkPositionAtCutoff.findMany({
      where: { graphSnapshotId: input.graphSnapshotId },
      select: {
        actorKey: true,
        windowKind: true,
        stateHash: true
      },
      orderBy: [
        { actorKey: "asc" },
        { windowKind: "asc" }
      ]
    })
  ]);
  const expectedNodes = input.projection.nodes
    .map((node) => ({
      nodeKey: node.nodeKey,
      stateHash: node.stateHash
    }))
    .sort((left, right) =>
      left.nodeKey.localeCompare(right.nodeKey)
    );
  const expectedEdges = input.projection.edges
    .map((edge) => ({
      edgeKey: edge.edgeKey,
      stateHash: edge.stateHash
    }))
    .sort((left, right) =>
      left.edgeKey.localeCompare(right.edgeKey)
    );
  const expectedPositions = input.projection.learnerPositions
    .map((position) => ({
      actorKey: position.actorKey,
      windowKind: position.windowKind,
      stateHash: position.stateHash
    }))
    .sort(
      (left, right) =>
        left.actorKey.localeCompare(right.actorKey) ||
        left.windowKind.localeCompare(right.windowKind)
    );
  if (
    JSON.stringify(nodes) !== JSON.stringify(expectedNodes) ||
    JSON.stringify(edges) !== JSON.stringify(expectedEdges) ||
    JSON.stringify(positions) !==
      JSON.stringify(expectedPositions)
  ) {
    throw new Error(
      "COURSE_CONTENT_GRAPH_CHILD_IMMUTABILITY_CONFLICT"
    );
  }
}

export async function projectAndPersistCourseContentGraphV2(
  input: {
    prisma: PrismaClient;
    worldSnapshotId: string;
    scanRunId: string;
    courseAlias: string;
    courseKey: string;
    coverageHash: string;
    asOfAt: Date | string;
    coverageComplete: boolean;
    roleRegistryStatus: "complete" | "unavailable";
  }
): Promise<{
  graphSnapshotId: string;
  structureFactSetHash: string;
  projection: CourseContentGraphProjectionV2;
}> {
  const asOfAt = normalizedTime(input.asOfAt);
  const world = await input.prisma.courseWorldSnapshot.findUnique({
    where: { id: input.worldSnapshotId },
    select: {
      courseAlias: true,
      invocationId: true,
      asOfAt: true,
      worldHash: true,
      coverageHash: true
    }
  });
  if (
    !world ||
    world.courseAlias !== input.courseAlias ||
    world.asOfAt.getTime() !== asOfAt.getTime() ||
    world.coverageHash !== input.coverageHash
  ) {
    throw new Error("COURSE_CONTENT_GRAPH_WORLD_MISMATCH");
  }
  const scanRun = await input.prisma.courseScanRun.findUnique({
    where: { id: input.scanRunId },
    select: {
      invocationId: true,
      courseAlias: true,
      status: true,
      coverageHash: true
    }
  });
  if (
    !scanRun ||
    scanRun.invocationId !== world.invocationId ||
    scanRun.courseAlias !== input.courseAlias ||
    scanRun.status !== "completed" ||
    scanRun.coverageHash !== input.coverageHash
  ) {
    throw new Error("COURSE_CONTENT_GRAPH_SCAN_MISMATCH");
  }
  const facts = await loadCourseStructureFactsForScan({
    prisma: input.prisma,
    scanRunId: input.scanRunId,
    courseKey: input.courseKey,
    requireCompleted: true
  });
  const persistedEvents = await input.prisma.courseEvent.findMany({
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
    eventKeys: persistedEvents.map((event) => event.eventKey),
    cutoff: asOfAt
  });
  const events: ProjectableCourseEvent[] = persistedEvents.map(
    (event) => ({
      ...event,
      occurredAt: event.occurredAt.toISOString(),
      sourceVersionHash:
        revisions.get(event.eventKey)?.sourceVersionHash ??
        event.sourceVersionHash,
      targetVersionHash:
        revisions.get(event.eventKey)?.targetVersionHash ??
        event.targetVersionHash
    })
  );
  const structureFactSetHash =
    hashCourseStructureFactSet(facts);
  const projection = projectCourseContentGraphV2({
    courseAlias: input.courseAlias,
    courseKey: input.courseKey,
    worldHash: world.worldHash,
    asOfAt: asOfAt.toISOString(),
    coverageHash: input.coverageHash,
    coverageComplete: input.coverageComplete,
    roleRegistryStatus: input.roleRegistryStatus,
    facts,
    events
  });
  const stateJson = expectedStateJson(
    projection,
    structureFactSetHash
  );
  const graphSnapshotId = await input.prisma.$transaction(
    async (tx) => {
      const existing =
        await tx.courseContentGraphSnapshot.findUnique({
          where: {
            worldSnapshotId_schemaVersion: {
              worldSnapshotId: input.worldSnapshotId,
              schemaVersion:
                COURSE_CONTENT_GRAPH_SCHEMA_VERSION
            }
          }
        });
      if (existing) {
        if (
          existing.courseAlias !== input.courseAlias ||
          existing.asOfAt.getTime() !== asOfAt.getTime() ||
          existing.schemaVersion !==
            COURSE_CONTENT_GRAPH_SCHEMA_VERSION ||
          existing.structureFactSetHash !==
            structureFactSetHash ||
          existing.nodeSetHash !== projection.nodeSetHash ||
          existing.edgeSetHash !== projection.edgeSetHash ||
          existing.contentGraphHash !== projection.graphHash ||
          existing.coverageHash !== input.coverageHash ||
          existing.coverageStatus !==
            projection.coverageStatus ||
          existing.roleRegistryStatus !==
            input.roleRegistryStatus ||
          existing.nodeCount !== projection.nodes.length ||
          existing.edgeCount !== projection.edges.length ||
          existing.learnerNodeCount !==
            projection.nodes.filter(
              (node) =>
                node.kind === "actor" &&
                node.role === "learner"
            ).length ||
          existing.stateJson !== stateJson
        ) {
          throw new Error(
            "COURSE_CONTENT_GRAPH_SNAPSHOT_IMMUTABILITY_CONFLICT"
          );
        }
        await assertPersistedChildrenMatch({
          tx,
          graphSnapshotId: existing.id,
          projection
        });
        return existing.id;
      }
      const snapshot =
        await tx.courseContentGraphSnapshot.create({
          data: {
            worldSnapshotId: input.worldSnapshotId,
            courseAlias: input.courseAlias,
            asOfAt,
            schemaVersion:
              COURSE_CONTENT_GRAPH_SCHEMA_VERSION,
            structureFactSetHash,
            nodeSetHash: projection.nodeSetHash,
            edgeSetHash: projection.edgeSetHash,
            contentGraphHash: projection.graphHash,
            coverageHash: input.coverageHash,
            coverageStatus: projection.coverageStatus,
            roleRegistryStatus: input.roleRegistryStatus,
            nodeCount: projection.nodes.length,
            edgeCount: projection.edges.length,
            learnerNodeCount: projection.nodes.filter(
              (node) =>
                node.kind === "actor" &&
                node.role === "learner"
            ).length,
            stateJson
          }
        });
      await persistProjectionChildren({
        tx,
        graphSnapshotId: snapshot.id,
        projection
      });
      return snapshot.id;
    }
  );
  return {
    graphSnapshotId,
    structureFactSetHash,
    projection
  };
}
