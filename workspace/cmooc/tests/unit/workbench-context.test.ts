import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import type { AutonomyWorldReadModel } from "../../lib/autonomy/world-read-model";
import {
  buildWorkbenchContextEnvelope,
  resolveWorkbenchContext
} from "../../lib/workbench/context";

function worldFixture(): AutonomyWorldReadModel {
  return {
    courses: [{ alias: "course_fixture", label: "课程 01" }],
    selectedCourse: { alias: "course_fixture", label: "课程 01" },
    snapshots: [
      {
        id: "snapshot_fixture",
        label: "T-0",
        asOfAt: "2026-08-11T00:00:00.000Z",
        active: true
      }
    ],
    selectionNotice: null,
    snapshot: {
      id: "snapshot_fixture",
      asOfAt: "2026-08-11T00:00:00.000Z",
      eventCount: 8,
      threadCount: 2,
      actorCount: 3,
      edgeCount: 2,
      openGapCount: 1,
      worldLabel: "W-safe",
      eventSetLabel: "E-safe",
      graphLabel: "G-safe"
    },
    coverage: null,
    graph: {
      source: "course_content_graph_v2",
      readStatus: "ready",
      schemaVersion: "fixture",
      coverageStatus: "censored",
      roleRegistryStatus: "complete",
      nodeCount: 4,
      edgeCount: 2,
      actorNodeCount: 3,
      learnerNodeCount: 1,
      structureFactCount: 0,
      activeLearnerCount: 1,
      visibleNodeCount: 4,
      visibleEdgeCount: 2,
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
        actor: 0,
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
      totalLearnerCount: 1,
      visibleLearnerCount: 0,
      totalReplyEdgeCount: 0,
      visibleReplyEdgeCount: 0,
      truncated: false
    },
    learnerPositions: [
      {
        id: "position-001",
        actorId: "actor-001",
        actorLabel: "学习者 01",
        windowKind: "rolling_30d",
        coverageStatus: "lower_bound",
        eventCount: 2,
        authoredThreadCount: 0,
        replyCount: 1,
        inboundReplyCount: 1,
        outboundReplyCount: 0,
        uniqueInboundPeerCount: 1,
        uniqueOutboundPeerCount: 0,
        reciprocalPeerCount: 0,
        componentSize: 2,
        kCore: null,
        pageRank: null
      }
    ]
  };
}

test("snapshot context resolves an exact course/invocation/snapshot evidence anchor", async () => {
  const db = {
    courseWorldSnapshot: {
      findUnique: async () => ({
        id: "snapshot_fixture",
        invocationId: "invocation_fixture",
        courseAlias: "course_fixture",
        asOfAt: new Date("2026-08-11T00:00:00.000Z"),
        worldHash: "world-safe-hash",
        eventCount: 8,
        threadCount: 2,
        openGapCount: 1,
        invocation: {
          id: "invocation_fixture",
          courseAlias: "course_fixture"
        }
      })
    }
  } as unknown as PrismaClient;

  const context = await resolveWorkbenchContext("snapshot:snapshot_fixture", db);

  assert.equal(context?.kind, "snapshot");
  assert.equal(context?.courseAlias, "course_fixture");
  assert.equal(context?.invocationId, "invocation_fixture");
  assert.equal(context?.evidenceAsOf, "2026-08-11T00:00:00.000Z");
  assert.equal(context?.evidenceHash, "world-safe-hash");
  assert.equal(
    context?.sourceHref,
    "/autonomy/world?course=course_fixture&snapshot=snapshot_fixture&view=course_structure&window=rolling_30d"
  );
  assert.equal(context?.containsForumText, false);
  assert.equal(context?.containsIdentity, false);
  assert.equal(
    buildWorkbenchContextEnvelope(context!).includes(
      "定位引用：snapshot:snapshot_fixture"
    ),
    true
  );
});

test("snapshot context fails closed when the linked invocation repeats a different course", async () => {
  const db = {
    courseWorldSnapshot: {
      findUnique: async () => ({
        id: "snapshot_fixture",
        invocationId: "invocation_fixture",
        courseAlias: "course_fixture",
        asOfAt: new Date("2026-08-11T00:00:00.000Z"),
        worldHash: "world-safe-hash",
        eventCount: 8,
        threadCount: 2,
        openGapCount: 1,
        invocation: {
          id: "invocation_fixture",
          courseAlias: "course_decoy"
        }
      })
    }
  } as unknown as PrismaClient;

  assert.equal(
    await resolveWorkbenchContext("snapshot:snapshot_fixture", db),
    null
  );
});

test("learner context revalidates snapshot and learner role through the world read model", async () => {
  const db = {
    courseWorldSnapshot: {
      findUnique: async () => ({
        id: "snapshot_fixture",
        courseAlias: "course_fixture",
        asOfAt: new Date("2026-08-11T00:00:00.000Z"),
        worldHash: "world-safe-hash"
      })
    }
  } as unknown as PrismaClient;
  const calls: unknown[] = [];
  const context = await resolveWorkbenchContext(
    "learner:snapshot_fixture__actor-001",
    db,
    async (input) => {
      calls.push(input);
      return worldFixture();
    }
  );

  assert.deepEqual(calls, [
    { courseAlias: "course_fixture", snapshotId: "snapshot_fixture" }
  ]);
  assert.equal(context?.kind, "learner");
  assert.equal(context?.title, "学习者 01");
  assert.match(context?.state ?? "", /当前可观察下界/);
  assert.equal(context?.containsForumText, false);
  assert.equal(
    context?.sourceHref,
    "/autonomy/world?course=course_fixture&snapshot=snapshot_fixture&view=learner_position&window=rolling_30d&focus=actor-001"
  );
  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes("platform-user"), false);
  assert.equal(serialized.includes("rawKey"), false);
  assert.equal(buildWorkbenchContextEnvelope(context!).includes("学习者 01"), true);
  assert.equal(buildWorkbenchContextEnvelope(context!).includes("learner:"), false);
});

test("learner context fails closed when the safe actor is absent from the requested snapshot", async () => {
  const db = {
    courseWorldSnapshot: {
      findUnique: async () => ({
        id: "snapshot_fixture",
        courseAlias: "course_fixture",
        asOfAt: new Date("2026-08-11T00:00:00.000Z"),
        worldHash: "world-safe-hash"
      })
    }
  } as unknown as PrismaClient;
  const model = worldFixture();
  model.learnerPositions = [];

  assert.equal(
    await resolveWorkbenchContext(
      "learner:snapshot_fixture__actor-001",
      db,
      async () => model
    ),
    null
  );
});
