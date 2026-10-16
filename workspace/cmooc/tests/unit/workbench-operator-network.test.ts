import assert from "node:assert/strict";
import test from "node:test";
import type {
  AutonomyWorldReadModel,
  SafeNetworkNode
} from "../../lib/autonomy/world-read-model";
import { buildOperatorLearnerNetwork } from "../../lib/workbench/operator-read-model";

function learner(index: number): SafeNetworkNode {
  return {
    id: `actor-${index}`,
    label: `L-${String(index).padStart(2, "0")}`,
    role: "learner",
    x: 0,
    y: 0,
    radius: 5,
    showLabel: false,
    eventCount: index * 2,
    authoredThreadCount: 1,
    replyCount: index,
    distinctPeerCount: 2,
    inboundWeight: index,
    outboundWeight: index,
    systemTouchCount30d: 0,
    lastSeenAt: "2026-08-10T00:00:00.000Z"
  };
}

function worldFixture(): AutonomyWorldReadModel {
  const nodes = Array.from({ length: 8 }, (_, index) => learner(index + 1));
  return {
    courses: [{ alias: "course-a", label: "课程 01" }],
    selectedCourse: { alias: "course-a", label: "课程 01" },
    snapshots: [],
    selectionNotice: null,
    snapshot: {
      id: "snapshot-a",
      asOfAt: "2026-08-10T00:00:00.000Z",
      eventCount: 50,
      threadCount: 12,
      actorCount: 8,
      edgeCount: 9,
      openGapCount: 1,
      worldLabel: "W-01",
      eventSetLabel: "E-01",
      graphLabel: "G-01"
    },
    coverage: null,
    graph: {
      source: "course_content_graph_v2",
      readStatus: "ready",
      schemaVersion: "v2",
      coverageStatus: "censored",
      roleRegistryStatus: "complete",
      nodeCount: 8,
      edgeCount: 9,
      actorNodeCount: 8,
      learnerNodeCount: 8,
      structureFactCount: 0,
      activeLearnerCount: 8,
      visibleNodeCount: 8,
      visibleEdgeCount: 9,
      nodeTruncated: false,
      edgeTruncated: false
    },
    structure: {
      nodes: [],
      edges: [],
      kindCounts: {
        course: 0,
        column: 0,
        thread: 0,
        actor: 8,
        concept: 0,
        resource: 0
      }
    },
    threads: [],
    laneCounts: {
      open_gap: 0,
      verified_response: 0,
      distinct_response: 0,
      follow_up: 0,
      censored: 0
    },
    community: {
      nodes: [
        ...nodes,
        { ...learner(9), id: "helper-1", label: "H-01", role: "helper" }
      ],
      edges: [
        { id: "e1", sourceId: "actor-1", targetId: "actor-2", weight: 5, completeness: "complete" },
        { id: "e2", sourceId: "actor-2", targetId: "actor-1", weight: 4, completeness: "complete" },
        { id: "e3", sourceId: "actor-2", targetId: "actor-3", weight: 3, completeness: "complete" },
        { id: "e4", sourceId: "actor-3", targetId: "actor-4", weight: 3, completeness: "complete" },
        { id: "e5", sourceId: "actor-5", targetId: "actor-6", weight: 5, completeness: "complete" },
        { id: "e6", sourceId: "actor-6", targetId: "actor-7", weight: 4, completeness: "complete" },
        { id: "e7", sourceId: "actor-7", targetId: "actor-8", weight: 3, completeness: "censored" },
        { id: "e8", sourceId: "actor-4", targetId: "actor-5", weight: 1, completeness: "complete" },
        { id: "ignored", sourceId: "helper-1", targetId: "actor-1", weight: 99, completeness: "complete" }
      ],
      totalActorCount: 9,
      visibleActorCount: 9,
      totalReplyEdgeCount: 9,
      visibleReplyEdgeCount: 9,
      truncated: false
    },
    learnerCommunity: {
      nodes,
      edges: [
        { id: "e1", sourceId: "actor-1", targetId: "actor-2", weight: 5, completeness: "complete" },
        { id: "e2", sourceId: "actor-2", targetId: "actor-1", weight: 4, completeness: "complete" },
        { id: "e3", sourceId: "actor-2", targetId: "actor-3", weight: 3, completeness: "complete" },
        { id: "e4", sourceId: "actor-3", targetId: "actor-4", weight: 3, completeness: "complete" },
        { id: "e5", sourceId: "actor-5", targetId: "actor-6", weight: 5, completeness: "complete" },
        { id: "e6", sourceId: "actor-6", targetId: "actor-7", weight: 4, completeness: "complete" },
        { id: "e7", sourceId: "actor-7", targetId: "actor-8", weight: 3, completeness: "censored" },
        { id: "e8", sourceId: "actor-4", targetId: "actor-5", weight: 1, completeness: "complete" }
      ],
      totalLearnerCount: 8,
      visibleLearnerCount: 8,
      totalReplyEdgeCount: 8,
      visibleReplyEdgeCount: 8,
      truncated: false
    },
    learnerPositions: []
  };
}

test("projects a learner-only interaction network with honest coverage and bridge metrics", () => {
  const network = buildOperatorLearnerNetwork(worldFixture());

  assert.equal(network.status, "ready");
  assert.equal(network.coverageStatus, "lower_bound");
  assert.equal(network.totalLearnerCount, 8);
  assert.equal(network.visibleLearnerCount, 8);
  assert.equal(network.directInteractionCount, 28);
  assert.equal(network.reciprocalRelationCount, 1);
  assert.equal(network.communityCount, 2);
  assert.equal(network.weakBridgeCount, 1);
  assert.equal(network.nodes.some((node) => node.id === "helper-1"), false);
  assert.equal(network.edges.some((edge) => edge.id === "ignored"), false);
  assert.equal(network.containsIdentity, false);
  assert.equal(network.containsForumText, false);
  for (const node of network.nodes) {
    assert.ok(node.x >= 0 && node.x <= 960);
    assert.ok(node.y >= 0 && node.y <= 620);
  }
});

test("does not fabricate a graph when no learner relationship is available", () => {
  const world = worldFixture();
  world.learnerCommunity.nodes = [];
  world.learnerCommunity.edges = [];

  const network = buildOperatorLearnerNetwork(world);
  assert.equal(network.status, "empty");
  assert.equal(network.totalLearnerCount, 8);
  assert.deepEqual(network.nodes, []);
  assert.deepEqual(network.edges, []);
});

test("returns an unavailable safe projection without a world snapshot", () => {
  const network = buildOperatorLearnerNetwork(null);
  assert.equal(network.status, "unavailable");
  assert.equal(network.totalLearnerCount, 0);
  assert.equal(network.containsIdentity, false);
  assert.equal(network.containsForumText, false);
});
