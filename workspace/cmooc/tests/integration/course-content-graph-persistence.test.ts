import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  type PrismaClient as PrismaClientType
} from "@prisma/client";
import {
  createCourseStructureEdgeFact,
  createCourseStructureNodeFact,
  deriveCourseGraphNodeKey,
  deriveCourseGraphRevisionHash,
  type CourseStructureFact
} from "../../lib/world/course-structure-fact";
import {
  projectAndPersistCourseContentGraphV2
} from "../../lib/world/course-content-graph-store";
import {
  COURSE_CONTENT_GRAPH_SCHEMA_VERSION
} from "../../lib/world/course-content-graph-projector";
import {
  appendCourseStructureFacts,
  loadLatestCourseStructureFacts
} from "../../lib/world/course-structure-store";
import {
  appendObservedCourseEvents,
  deriveAutonomyCourseKey,
  normalizeObservedThread
} from "../../lib/world/live-event";
import {
  projectAndPersistLiveWorld,
  projectLiveWorld
} from "../../lib/world/live-world-projector";

process.env.DATABASE_URL = "file:./test.db";
process.env.LLM_MODE = "mock";
process.env.CMOOC_DISABLE_WINDOWS_ENV_FALLBACK = "1";

const graphSecret = Buffer.alloc(32, 31);
let fixtureSequence = 0;

function hash64(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixtureSuffix(label: string): string {
  fixtureSequence += 1;
  return `${label}-${Date.now().toString(36)}-${fixtureSequence}`;
}

async function createCourseManifest(
  prisma: PrismaClientType,
  alias: string
): Promise<string> {
  const manifestHash = hash64(`manifest:${alias}`);
  await prisma.autonomyCourseManifest.create({
    data: {
      alias,
      manifestHash,
      platformId: "synthetic.test",
      platformCourseRefHash: hash64(`course-ref:${alias}`),
      canonicalLocatorHash: hash64(`locator:${alias}`),
      identityKeyFingerprint: hash64(`identity-key:${alias}`),
      allowedOrigin: "https://example.test",
      timeZone: "UTC",
      defaultMode: "SHADOW",
      policyVersion: "graph-v2-test-v1",
      enabled: true,
      realPublishEnabled: false
    }
  });
  return manifestHash;
}

async function createScanRun(input: {
  prisma: PrismaClientType;
  courseAlias: string;
  manifestHash: string;
  observedAt: string;
  label: string;
}) {
  const invocation =
    await input.prisma.scheduledInvocation.create({
      data: {
        invocationKey: hash64(
          `invocation:${input.courseAlias}:${input.label}`
        ),
        courseAlias: input.courseAlias,
        manifestHash: input.manifestHash,
        scheduledFor: new Date(input.observedAt),
        mode: "SHADOW",
        status: "running",
        phase: "scanning"
      }
    });
  return input.prisma.courseScanRun.create({
    data: {
      invocationId: invocation.id,
      courseAlias: input.courseAlias,
      scanKey: hash64(
        `scan:${input.courseAlias}:${input.label}`
      ),
      status: "running",
      sourceKind: "synthetic_graph_v2_test",
      cursorJson: JSON.stringify({
        schemaVersion: "graph-v2-test-cursor.v1",
        containsForumText: false
      }),
      coverageJson: JSON.stringify({
        schemaVersion: "graph-v2-test-coverage.v1",
        containsForumText: false
      })
    }
  });
}

function structureRevision(input: {
  courseRef: string;
  scope: string;
  version: string;
}): string {
  return deriveCourseGraphRevisionHash({
    secret: graphSecret,
    courseRef: input.courseRef,
    scope: input.scope,
    versionMaterial: input.version
  });
}

async function createGraphFixture(input: {
  prisma: PrismaClientType;
  coverageComplete: boolean;
  label: string;
}) {
  const suffix = fixtureSuffix(input.label);
  const courseAlias = `graph-v2-${suffix}`.slice(0, 63);
  const courseRef = `synthetic-course-${suffix}`;
  const observedAt = "2026-07-05T00:00:00.000Z";
  const manifestHash = await createCourseManifest(
    input.prisma,
    courseAlias
  );
  const scanRun = await createScanRun({
    prisma: input.prisma,
    courseAlias,
    manifestHash,
    observedAt,
    label: `${suffix}-scan`
  });
  const threadRef = `synthetic-thread-${suffix}`;
  const normalized = normalizeObservedThread({
    courseAlias,
    secret: graphSecret,
    maxComments: 10,
    thread: {
      courseRef,
      threadRef,
      authorRef: `synthetic-actor-a-${suffix}`,
      occurredAt: "2026-07-01T00:00:00.000Z",
      observedAt,
      versionMaterial: "thread-revision-v1",
      knownExternalHumanActorRefs: [
        `synthetic-actor-b-${suffix}`
      ],
      comments: [
        {
          eventRef: `synthetic-comment-${suffix}`,
          actorRef: `synthetic-actor-b-${suffix}`,
          parentEventRef: threadRef,
          depth: 0,
          occurredAt: "2026-07-01T01:00:00.000Z",
          versionMaterial: "comment-revision-v1"
        }
      ]
    }
  });
  const ledger = await appendObservedCourseEvents({
    prisma: input.prisma,
    scanRunId: scanRun.id,
    courseAlias,
    events: normalized.events
  });
  assert.equal(ledger.conflictEventKeys.length, 0);

  const courseKey = deriveAutonomyCourseKey({
    secret: graphSecret,
    courseRef
  });
  const columnKey = deriveCourseGraphNodeKey({
    secret: graphSecret,
    courseRef,
    kind: "column",
    sourceRef: `synthetic-column-${suffix}`
  });
  const peerActorKey = normalized.events.find(
    (event) =>
      event.kind === "comment" &&
      event.actorKey !== null &&
      event.actorKey !== normalized.authorKey
  )?.actorKey;
  assert.ok(normalized.authorKey);
  assert.ok(peerActorKey);
  const commonRevision = structureRevision({
    courseRef,
    scope: "graph-fixture",
    version: "v1"
  });
  const facts: CourseStructureFact[] = [
    createCourseStructureNodeFact({
      courseKey,
      subjectKey: courseKey,
      subjectKind: "course",
      revisionHash: commonRevision,
      attributes: { source: "synthetic_manifest" }
    }),
    createCourseStructureNodeFact({
      courseKey,
      subjectKey: columnKey,
      subjectKind: "column",
      revisionHash: commonRevision,
      ordinal: 1,
      attributes: { source: "synthetic_columns" }
    }),
    createCourseStructureNodeFact({
      courseKey,
      subjectKey: normalized.threadKey,
      subjectKind: "thread",
      revisionHash: normalized.events[0].sourceVersionHash,
      occurredAt: normalized.events[0].occurredAt,
      attributes: {
        comment_coverage: input.coverageComplete
          ? "complete"
          : "censored"
      }
    }),
    createCourseStructureNodeFact({
      courseKey,
      subjectKey: normalized.authorKey,
      subjectKind: "actor",
      revisionHash: commonRevision,
      attributes: { role: "learner" }
    }),
    createCourseStructureNodeFact({
      courseKey,
      subjectKey: peerActorKey,
      subjectKind: "actor",
      revisionHash: commonRevision,
      attributes: { role: "learner" }
    }),
    createCourseStructureEdgeFact({
      courseKey,
      sourceKey: courseKey,
      sourceKind: "course",
      targetKey: columnKey,
      targetKind: "column",
      kind: "contains",
      revisionHash: commonRevision
    }),
    createCourseStructureEdgeFact({
      courseKey,
      sourceKey: columnKey,
      sourceKind: "column",
      targetKey: normalized.threadKey,
      targetKind: "thread",
      kind: "contains",
      revisionHash: commonRevision
    })
  ];
  const appended = await appendCourseStructureFacts({
    prisma: input.prisma,
    scanRunId: scanRun.id,
    courseAlias,
    courseKey,
    observedAt,
    sourceKind: "synthetic_graph_v2_test",
    facts
  });
  assert.equal(appended.conflictFactKeys.length, 0);
  const coverageHash = hash64(
    `coverage:${courseAlias}:${input.coverageComplete}`
  );
  const world = await projectAndPersistLiveWorld({
    prisma: input.prisma,
    invocationId: scanRun.invocationId,
    courseAlias,
    coverageHash,
    asOfAt: observedAt,
    coverageComplete: input.coverageComplete,
    completeThreadKeys: input.coverageComplete
      ? [normalized.threadKey]
      : []
  });
  await input.prisma.courseScanRun.update({
    where: { id: scanRun.id },
    data: {
      status: "completed",
      coverageHash,
      finishedAt: new Date(observedAt)
    }
  });
  return {
    courseAlias,
    courseKey,
    coverageHash,
    observedAt,
    scanRun,
    world,
    facts
  };
}

test("事件账本保留合法版本修订，并按 cutoff 重放当时可见版本", async () => {
  const { prisma } = await import("../../lib/db");
  const suffix = fixtureSuffix("event-revision");
  const courseAlias = `event-revision-${suffix}`.slice(0, 63);
  const courseRef = `event-revision-course-${suffix}`;
  const manifestHash = await createCourseManifest(
    prisma,
    courseAlias
  );
  const firstObservedAt = "2026-07-05T00:00:00.000Z";
  const secondObservedAt = "2026-07-05T01:00:00.000Z";
  const firstScan = await createScanRun({
    prisma,
    courseAlias,
    manifestHash,
    observedAt: firstObservedAt,
    label: `${suffix}-first`
  });
  const secondScan = await createScanRun({
    prisma,
    courseAlias,
    manifestHash,
    observedAt: secondObservedAt,
    label: `${suffix}-second`
  });
  const normalizeRevision = (
    observedAt: string,
    versionMaterial: string
  ) =>
    normalizeObservedThread({
      courseAlias,
      secret: graphSecret,
      maxComments: 10,
      thread: {
        courseRef,
        threadRef: `event-revision-thread-${suffix}`,
        authorRef: `event-revision-actor-${suffix}`,
        occurredAt: "2026-07-01T00:00:00.000Z",
        observedAt,
        versionMaterial,
        comments: []
      }
    });
  const firstRevision = normalizeRevision(
    firstObservedAt,
    "revision-v1"
  );
  const secondRevision = normalizeRevision(
    secondObservedAt,
    "revision-v2"
  );
  assert.equal(
    firstRevision.events[0].eventKey,
    secondRevision.events[0].eventKey
  );
  assert.notEqual(
    firstRevision.targetVersionHash,
    secondRevision.targetVersionHash
  );

  const firstAppend = await appendObservedCourseEvents({
    prisma,
    scanRunId: firstScan.id,
    courseAlias,
    events: firstRevision.events
  });
  assert.equal(firstAppend.conflictEventKeys.length, 0);
  const secondAppend = await appendObservedCourseEvents({
    prisma,
    scanRunId: secondScan.id,
    courseAlias,
    events: secondRevision.events
  });
  assert.equal(secondAppend.conflictEventKeys.length, 0);
  assert.equal(
    (secondAppend as { revisionEventCount?: number })
      .revisionEventCount,
    1
  );

  const earlyWorld = await projectAndPersistLiveWorld({
    prisma,
    invocationId: firstScan.invocationId,
    courseAlias,
    coverageHash: hash64(`${suffix}:coverage:first`),
    asOfAt: firstObservedAt,
    coverageComplete: true,
    completeThreadKeys: [firstRevision.threadKey]
  });
  const laterWorld = await projectAndPersistLiveWorld({
    prisma,
    invocationId: secondScan.invocationId,
    courseAlias,
    coverageHash: hash64(`${suffix}:coverage:second`),
    asOfAt: secondObservedAt,
    coverageComplete: true,
    completeThreadKeys: [secondRevision.threadKey]
  });
  assert.equal(
    earlyWorld.projection.eventSetHash,
    projectLiveWorld(firstRevision.events, {
      asOfAt: firstObservedAt,
      coverageComplete: true,
      completeThreadKeys: [firstRevision.threadKey]
    }).eventSetHash
  );
  assert.equal(
    laterWorld.projection.eventSetHash,
    projectLiveWorld(secondRevision.events, {
      asOfAt: secondObservedAt,
      coverageComplete: true,
      completeThreadKeys: [secondRevision.threadKey]
    }).eventSetHash
  );
  assert.notEqual(
    earlyWorld.projection.eventSetHash,
    laterWorld.projection.eventSetHash
  );
  assert.notEqual(
    earlyWorld.projection.worldHash,
    laterWorld.projection.worldHash
  );
});

test("结构事实 append 幂等、允许同 identity 新 revision，并对同 factKey 冲突关闭", async () => {
  const { prisma } = await import("../../lib/db");
  const suffix = fixtureSuffix("structure-store");
  const courseAlias = `graph-v2-${suffix}`.slice(0, 63);
  const courseRef = `synthetic-course-${suffix}`;
  const manifestHash = await createCourseManifest(
    prisma,
    courseAlias
  );
  const firstObservedAt = "2026-07-05T00:00:00.000Z";
  const secondObservedAt = "2026-07-06T00:00:00.000Z";

  try {
    const firstScan = await createScanRun({
      prisma,
      courseAlias,
      manifestHash,
      observedAt: firstObservedAt,
      label: `${suffix}-first`
    });
    const courseKey = deriveAutonomyCourseKey({
      secret: graphSecret,
      courseRef
    });
    const columnKey = deriveCourseGraphNodeKey({
      secret: graphSecret,
      courseRef,
      kind: "column",
      sourceRef: `synthetic-column-${suffix}`
    });
    const firstFact = createCourseStructureNodeFact({
      courseKey,
      subjectKey: columnKey,
      subjectKind: "column",
      revisionHash: structureRevision({
        courseRef,
        scope: "column",
        version: "v1"
      }),
      ordinal: 1,
      attributes: { source: "synthetic_columns" }
    });
    const first = await appendCourseStructureFacts({
      prisma,
      scanRunId: firstScan.id,
      courseAlias,
      courseKey,
      observedAt: firstObservedAt,
      sourceKind: "synthetic_graph_v2_test",
      facts: [firstFact]
    });
    const duplicate = await appendCourseStructureFacts({
      prisma,
      scanRunId: firstScan.id,
      courseAlias,
      courseKey,
      observedAt: firstObservedAt,
      sourceKind: "synthetic_graph_v2_test",
      facts: [firstFact]
    });
    assert.deepEqual(first, {
      observedFactCount: 1,
      newFactCount: 1,
      newObservationCount: 1,
      conflictFactKeys: []
    });
    assert.deepEqual(duplicate, {
      observedFactCount: 1,
      newFactCount: 0,
      newObservationCount: 0,
      conflictFactKeys: []
    });
    await prisma.courseScanRun.update({
      where: { id: firstScan.id },
      data: {
        status: "completed",
        coverageHash: hash64(`${courseAlias}:first-coverage`),
        finishedAt: new Date(firstObservedAt)
      }
    });

    const secondScan = await createScanRun({
      prisma,
      courseAlias,
      manifestHash,
      observedAt: secondObservedAt,
      label: `${suffix}-second`
    });
    const secondFact = createCourseStructureNodeFact({
      courseKey,
      subjectKey: columnKey,
      subjectKind: "column",
      revisionHash: structureRevision({
        courseRef,
        scope: "column",
        version: "v2"
      }),
      ordinal: 2,
      attributes: { source: "synthetic_columns" }
    });
    assert.equal(
      secondFact.factIdentityKey,
      firstFact.factIdentityKey
    );
    assert.notEqual(secondFact.factKey, firstFact.factKey);
    const revised = await appendCourseStructureFacts({
      prisma,
      scanRunId: secondScan.id,
      courseAlias,
      courseKey,
      observedAt: secondObservedAt,
      sourceKind: "synthetic_graph_v2_test",
      facts: [secondFact]
    });
    assert.deepEqual(revised, {
      observedFactCount: 1,
      newFactCount: 1,
      newObservationCount: 1,
      conflictFactKeys: []
    });
    await prisma.courseScanRun.update({
      where: { id: secondScan.id },
      data: {
        status: "completed",
        coverageHash: hash64(`${courseAlias}:second-coverage`),
        finishedAt: new Date(secondObservedAt)
      }
    });
    const latest = await loadLatestCourseStructureFacts({
      prisma,
      courseAlias,
      courseKey,
      asOfAt: secondObservedAt
    });
    assert.equal(latest.length, 1);
    assert.equal(latest[0].factKey, secondFact.factKey);
    assert.equal(latest[0].ordinal, 2);

    await prisma.courseStructureFact.update({
      where: { factKey: firstFact.factKey },
      data: { ordinal: 99 }
    });
    const conflict = await appendCourseStructureFacts({
      prisma,
      scanRunId: secondScan.id,
      courseAlias,
      courseKey,
      observedAt: secondObservedAt,
      sourceKind: "synthetic_graph_v2_test",
      facts: [firstFact]
    });
    assert.deepEqual(conflict, {
      observedFactCount: 1,
      newFactCount: 0,
      newObservationCount: 0,
      conflictFactKeys: [firstFact.factKey]
    });
    assert.equal(
      await prisma.courseStructureFactObservation.count({
        where: {
          scanRunId: secondScan.id,
          factKey: firstFact.factKey
        }
      }),
      0,
      "冲突 factKey 不得产生新的观察事实"
    );
    assert.equal(
      await prisma.courseStructureFact.count({
        where: {
          courseAlias,
          factIdentityKey: firstFact.factIdentityKey
        }
      }),
      2,
      "同一 identity 应保留两个不可变 revision"
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("Graph v2 snapshot 重入幂等，并对输入漂移和子投影篡改关闭", async () => {
  const { prisma } = await import("../../lib/db");
  try {
    const fixture = await createGraphFixture({
      prisma,
      coverageComplete: true,
      label: "snapshot-idempotency"
    });
    const persistInput = {
      prisma,
      worldSnapshotId: fixture.world.snapshotId,
      scanRunId: fixture.scanRun.id,
      courseAlias: fixture.courseAlias,
      courseKey: fixture.courseKey,
      coverageHash: fixture.coverageHash,
      asOfAt: fixture.observedAt,
      coverageComplete: true,
      roleRegistryStatus: "complete" as const
    };
    const first =
      await projectAndPersistCourseContentGraphV2(persistInput);
    const second =
      await projectAndPersistCourseContentGraphV2(persistInput);
    assert.equal(second.graphSnapshotId, first.graphSnapshotId);
    assert.equal(
      second.projection.graphHash,
      first.projection.graphHash
    );
    assert.equal(
      await prisma.courseContentGraphSnapshot.count({
        where: {
          worldSnapshotId: fixture.world.snapshotId
        }
      }),
      1
    );
    assert.equal(
      await prisma.courseGraphNodeProjection.count({
        where: { graphSnapshotId: first.graphSnapshotId }
      }),
      first.projection.nodes.length
    );
    assert.equal(
      await prisma.courseGraphEdgeProjection.count({
        where: { graphSnapshotId: first.graphSnapshotId }
      }),
      first.projection.edges.length
    );

    await assert.rejects(
      () =>
        projectAndPersistCourseContentGraphV2({
          ...persistInput,
          coverageComplete: false
        }),
      /COURSE_CONTENT_GRAPH_SNAPSHOT_IMMUTABILITY_CONFLICT/
    );

    const persistedNode =
      await prisma.courseGraphNodeProjection.findFirstOrThrow({
        where: { graphSnapshotId: first.graphSnapshotId },
        orderBy: { nodeKey: "asc" }
      });
    await prisma.courseGraphNodeProjection.update({
      where: { id: persistedNode.id },
      data: { stateHash: hash64("tampered-node-state") }
    });
    await assert.rejects(
      () =>
        projectAndPersistCourseContentGraphV2(persistInput),
      /COURSE_CONTENT_GRAPH_CHILD_IMMUTABILITY_CONFLICT/
    );
    const { getAutonomyWorldReadModel } = await import(
      "../../lib/autonomy/world-read-model"
    );
    const safeReadModel = await getAutonomyWorldReadModel({
      courseAlias: fixture.courseAlias,
      snapshotId: fixture.world.snapshotId
    });
    assert.equal(
      safeReadModel.graph.readStatus,
      "integrity_failed"
    );
    assert.equal(
      safeReadModel.graph.source,
      "world_v1_fallback"
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("censored coverage 落库后只提供 lower-bound，不持久化 PageRank 或 k-core", async () => {
  const { prisma } = await import("../../lib/db");
  try {
    const fixture = await createGraphFixture({
      prisma,
      coverageComplete: false,
      label: "censored-network"
    });
    const persisted =
      await projectAndPersistCourseContentGraphV2({
        prisma,
        worldSnapshotId: fixture.world.snapshotId,
        scanRunId: fixture.scanRun.id,
        courseAlias: fixture.courseAlias,
        courseKey: fixture.courseKey,
        coverageHash: fixture.coverageHash,
        asOfAt: fixture.observedAt,
        coverageComplete: false,
        roleRegistryStatus: "complete"
      });
    const snapshot =
      await prisma.courseContentGraphSnapshot.findUniqueOrThrow({
        where: {
          worldSnapshotId_schemaVersion: {
            worldSnapshotId: fixture.world.snapshotId,
            schemaVersion: COURSE_CONTENT_GRAPH_SCHEMA_VERSION
          }
        }
      });
    const positions =
      await prisma.learnerNetworkPositionAtCutoff.findMany({
        where: {
          graphSnapshotId: persisted.graphSnapshotId
        }
      });
    assert.equal(snapshot.coverageStatus, "censored");
    assert.ok(positions.length > 0);
    assert.ok(
      positions.every(
        (position) =>
          position.coverageStatus === "lower_bound" &&
          position.pageRank === null &&
          position.kCore === null
      )
    );
  } finally {
    await prisma.$disconnect();
  }
});
