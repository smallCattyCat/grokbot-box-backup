import assert from "node:assert/strict";
import test from "node:test";
import {
  createCourseStructureEdgeFact,
  createCourseStructureNodeFact,
  deriveCourseGraphNodeKey,
  deriveCourseGraphRevisionHash,
  extractControlledConceptSignals,
  extractHashedResourceSignals,
  hashCourseStructureFactSet
} from "../../lib/world/course-structure-fact";
import {
  projectCourseContentGraphV2
} from "../../lib/world/course-content-graph-projector";
import {
  deriveAutonomyCourseKey,
  normalizeObservedThread
} from "../../lib/world/live-event";
import {
  projectLiveWorld
} from "../../lib/world/live-world-projector";
import {
  selectAutonomyWorldCourse
} from "../../lib/autonomy/world-read-model";

const secret = Buffer.alloc(32, 21);
const courseRef = "1234567890";

test("事件世界默认选择拥有最新快照的课程，同时尊重显式课程范围", () => {
  const courses = [
    { alias: "integration", label: "课程 01" },
    { alias: "real-shadow", label: "课程 02" }
  ];

  assert.equal(
    selectAutonomyWorldCourse({
      courses,
      requestedCourse: null,
      latestSnapshotCourseAlias: "real-shadow"
    })?.alias,
    "real-shadow"
  );
  assert.equal(
    selectAutonomyWorldCourse({
      courses,
      requestedCourse: "integration",
      latestSnapshotCourseAlias: "real-shadow"
    })?.alias,
    "integration"
  );
  assert.equal(
    selectAutonomyWorldCourse({
      courses,
      requestedCourse: "missing",
      latestSnapshotCourseAlias: "real-shadow"
    })?.alias,
    "real-shadow"
  );
});

function graphFixture(input: {
  coverageComplete: boolean;
  columnOrdinal?: number;
}) {
  const courseKey = deriveAutonomyCourseKey({
    secret,
    courseRef
  });
  const columnKey = deriveCourseGraphNodeKey({
    secret,
    courseRef,
    kind: "column",
    sourceRef: "column-1"
  });
  const normalized = normalizeObservedThread({
    courseAlias: "test-course",
    secret,
    maxComments: 10,
    thread: {
      courseRef,
      threadRef: "thread-1",
      authorRef: "learner-a",
      occurredAt: "2026-07-01T00:00:00.000Z",
      observedAt: "2026-07-05T00:00:00.000Z",
      versionMaterial: "root-v1",
      comments: [
        {
          eventRef: "self-return",
          actorRef: "learner-a",
          parentEventRef: "thread-1",
          depth: 0,
          occurredAt: "2026-07-01T01:00:00.000Z",
          versionMaterial: "self-v1"
        },
        {
          eventRef: "peer-reply",
          actorRef: "learner-b",
          parentEventRef: "thread-1",
          depth: 0,
          occurredAt: "2026-07-01T02:00:00.000Z",
          versionMaterial: "peer-v1"
        },
        {
          eventRef: "peer-reply-again",
          actorRef: "learner-b",
          parentEventRef: "thread-1",
          depth: 0,
          occurredAt: "2026-07-01T02:30:00.000Z",
          versionMaterial: "peer-v2"
        },
        {
          eventRef: "missing-actor",
          actorRef: null,
          parentEventRef: "thread-1",
          depth: 0,
          occurredAt: "2026-07-01T03:00:00.000Z",
          versionMaterial: "missing-v1"
        }
      ]
    }
  });
  const learnerBKey = normalized.events.find(
    (event) =>
      event.kind === "comment" &&
      event.actorKey !== normalized.authorKey &&
      event.actorKey !== null
  )?.actorKey;
  assert.ok(normalized.authorKey);
  assert.ok(learnerBKey);
  const revisionHash = deriveCourseGraphRevisionHash({
    secret,
    courseRef,
    scope: "fixture",
    versionMaterial: "v1"
  });
  const facts = [
    createCourseStructureNodeFact({
      courseKey,
      subjectKey: courseKey,
      subjectKind: "course",
      revisionHash,
      attributes: { source: "manifest" }
    }),
    createCourseStructureNodeFact({
      courseKey,
      subjectKey: columnKey,
      subjectKind: "column",
      revisionHash,
      ordinal: input.columnOrdinal ?? 1,
      attributes: { source: "course_columns" }
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
      revisionHash,
      attributes: { role: "learner" }
    }),
    createCourseStructureNodeFact({
      courseKey,
      subjectKey: learnerBKey,
      subjectKind: "actor",
      revisionHash,
      attributes: { role: "learner" }
    }),
    createCourseStructureEdgeFact({
      courseKey,
      sourceKey: courseKey,
      sourceKind: "course",
      targetKey: columnKey,
      targetKind: "column",
      kind: "contains",
      revisionHash
    }),
    createCourseStructureEdgeFact({
      courseKey,
      sourceKey: columnKey,
      sourceKind: "column",
      targetKey: normalized.threadKey,
      targetKind: "thread",
      kind: "contains",
      revisionHash
    })
  ];
  const world = projectLiveWorld(normalized.events, {
    asOfAt: "2026-07-05T00:00:00.000Z",
    coverageComplete: input.coverageComplete,
    completeThreadKeys: input.coverageComplete
      ? [normalized.threadKey]
      : []
  });
  return {
    courseKey,
    facts,
    normalized,
    world,
    projection: projectCourseContentGraphV2({
      courseAlias: "test-course",
      courseKey,
      worldHash: world.worldHash,
      asOfAt: world.asOfAt,
      coverageHash: "a".repeat(64),
      coverageComplete: input.coverageComplete,
      roleRegistryStatus: "complete",
      facts,
      events: normalized.events
    })
  };
}

test("结构事实和受控语义抽取不泄漏原始正文或资源 URL", () => {
  const marker = "SENSITIVE_GRAPH_TEXT";
  const concepts = extractControlledConceptSignals([
    `${marker} 社会网络与知识图谱`
  ]);
  assert.deepEqual(
    concepts.map((item) => item.conceptId).sort(),
    ["knowledge_graph", "social_network"]
  );

  const resources = extractHashedResourceSignals({
    secret,
    courseRef,
    texts: [
      `${marker} https://private.example.test/path/to/resource`
    ]
  });
  const serialized = JSON.stringify({ concepts, resources });
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes("private.example.test"), false);
  assert.ok(
    resources.every((resource) =>
      /^[a-f0-9]{64}$/.test(resource.resourceKey)
    )
  );
});

test("Graph v2 哈希覆盖 typed nodes，且事件/事实置换不改变投影", () => {
  const first = graphFixture({
    coverageComplete: true,
    columnOrdinal: 1
  });
  const reordered = projectCourseContentGraphV2({
    courseAlias: "test-course",
    courseKey: first.courseKey,
    worldHash: first.world.worldHash,
    asOfAt: first.world.asOfAt,
    coverageHash: "a".repeat(64),
    coverageComplete: true,
    roleRegistryStatus: "complete",
    facts: [...first.facts].reverse(),
    events: [...first.normalized.events].reverse()
  });
  const changedNode = graphFixture({
    coverageComplete: true,
    columnOrdinal: 2
  });

  assert.equal(reordered.graphHash, first.projection.graphHash);
  assert.equal(
    reordered.nodeSetHash,
    first.projection.nodeSetHash
  );
  assert.equal(
    reordered.edgeSetHash,
    first.projection.edgeSetHash
  );
  assert.notEqual(
    changedNode.projection.graphHash,
    first.projection.graphHash
  );
  assert.notEqual(
    hashCourseStructureFactSet(changedNode.facts),
    hashCourseStructureFactSet(first.facts)
  );
  const nodeKeys = new Set(
    first.projection.nodes.map((node) => node.nodeKey)
  );
  assert.ok(
    first.projection.edges.every(
      (edge) =>
        nodeKeys.has(edge.sourceNodeKey) &&
        nodeKeys.has(edge.targetNodeKey)
    )
  );
});

test("学习者网络排除 self/null，删失覆盖只提供下界而不计算中心性", () => {
  const fixture = graphFixture({ coverageComplete: false });
  const replyEdges = fixture.projection.edges.filter(
    (edge) => edge.kind === "reply_to"
  );
  assert.equal(replyEdges.length, 1);
  assert.equal(replyEdges[0].weight, 2);
  assert.equal(replyEdges[0].evidenceCount, 2);
  assert.ok(
    replyEdges.every(
      (edge) => edge.sourceNodeKey !== edge.targetNodeKey
    )
  );
  assert.equal(fixture.projection.coverageStatus, "censored");
  assert.equal(fixture.projection.learnerPositions.length, 6);
  assert.ok(
    fixture.projection.learnerPositions.every(
      (position) =>
        position.coverageStatus === "lower_bound" &&
        position.pageRank === null &&
        position.kCore === null
    )
  );
});

test("完整覆盖的五人网络以定点材料哈希 PageRank，并聚合同一逻辑边", () => {
  const courseKey = deriveAutonomyCourseKey({
    secret,
    courseRef
  });
  const normalized = normalizeObservedThread({
    courseAlias: "test-course",
    secret,
    maxComments: 10,
    thread: {
      courseRef,
      threadRef: "network-thread",
      authorRef: "learner-0",
      occurredAt: "2026-07-01T00:00:00.000Z",
      observedAt: "2026-07-05T00:00:00.000Z",
      versionMaterial: "network-root",
      comments: [1, 2, 3, 4].flatMap((learner) => [
        {
          eventRef: `reply-${learner}-a`,
          actorRef: `learner-${learner}`,
          parentEventRef: "network-thread",
          depth: 0,
          occurredAt: `2026-07-01T0${learner}:00:00.000Z`,
          versionMaterial: `reply-${learner}-a`
        },
        {
          eventRef: `reply-${learner}-b`,
          actorRef: `learner-${learner}`,
          parentEventRef: "network-thread",
          depth: 0,
          occurredAt: `2026-07-01T1${learner}:00:00.000Z`,
          versionMaterial: `reply-${learner}-b`
        }
      ])
    }
  });
  const actorKeys = [
    ...new Set(
      normalized.events
        .map((event) => event.actorKey)
        .filter((actorKey): actorKey is string => Boolean(actorKey))
    )
  ];
  assert.equal(actorKeys.length, 5);
  const revisionHash = deriveCourseGraphRevisionHash({
    secret,
    courseRef,
    scope: "pagerank_fixture",
    versionMaterial: "v1"
  });
  const facts = [
    createCourseStructureNodeFact({
      courseKey,
      subjectKey: courseKey,
      subjectKind: "course",
      revisionHash
    }),
    ...actorKeys.map((actorKey) =>
      createCourseStructureNodeFact({
        courseKey,
        subjectKey: actorKey,
        subjectKind: "actor",
        revisionHash,
        attributes: { role: "learner" }
      })
    )
  ];
  const world = projectLiveWorld(normalized.events, {
    asOfAt: "2026-07-05T00:00:00.000Z",
    coverageComplete: true,
    completeThreadKeys: [normalized.threadKey]
  });
  const graph = projectCourseContentGraphV2({
    courseAlias: "test-course",
    courseKey,
    worldHash: world.worldHash,
    asOfAt: world.asOfAt,
    coverageHash: "b".repeat(64),
    coverageComplete: true,
    roleRegistryStatus: "complete",
    facts,
    events: normalized.events
  });
  assert.match(graph.graphHash, /^[a-f0-9]{64}$/);
  assert.ok(
    graph.learnerPositions.every(
      (position) =>
        position.coverageStatus === "complete" &&
        position.pageRank !== null &&
        position.kCore !== null
    )
  );
  const replyEdges = graph.edges.filter(
    (edge) => edge.kind === "reply_to"
  );
  assert.equal(replyEdges.length, 4);
  assert.ok(
    replyEdges.every(
      (edge) => edge.weight === 2 && edge.evidenceCount === 2
    )
  );
});
