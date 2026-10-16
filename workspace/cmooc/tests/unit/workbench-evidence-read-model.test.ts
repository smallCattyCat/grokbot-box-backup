import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { COURSE_CONTENT_GRAPH_SCHEMA_VERSION } from "../../lib/world/course-content-graph-projector";
import {
  CANDIDATE_SET_SCHEMA_VERSION,
  type AutonomyCandidateSet
} from "../../lib/autonomy/candidate-set";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "../../lib/facilitation-protocol";
import {
  CourseEvidenceWorkspaceReadError
} from "../../lib/workbench/evidence-route-handler";
import {
  hashPersistedEvidenceQualification,
  PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION,
  type PersistedEvidenceQualification
} from "../../lib/workbench/course-evidence-workspace";
import {
  getAnchoredCourseEvidenceWorkspace,
  verifyContentGraphIntegrity
} from "../../lib/workbench/evidence-read-model";

const CURRENT_AS_OF = new Date("2026-08-12T11:00:00.000Z");
const BASELINE_AS_OF = new Date("2026-08-12T10:00:00.000Z");

function coverage(input: {
  complete?: boolean;
  discovered?: number;
  completed?: number;
  observed?: number;
} = {}) {
  const receipt = {
    schemaVersion: "cmooc.course-scan-coverage.v5",
    observedAt: CURRENT_AS_OF.toISOString(),
    sourceKind: "cmooc_api_plus_read_only_browser",
    apiReadAuthStatus: "authenticated",
    uiStatus: "ready",
    uiEvidenceHash: "ui-evidence",
    courseShellDetected: true,
    categoryCount: 1,
    categoryCompletedCount: 1,
    pageRequestCount: 1,
    discoveredThreadCount: input.discovered ?? 10,
    completedDetailCount: input.completed ?? 8,
    observedEventCount: input.observed ?? 16,
    incompleteCommentThreadCount: 2,
    failedTargetCount: 0,
    truncatedThreadListing: false,
    complete: input.complete ?? true,
    failureCodeCounts: {}
  };
  Object.assign(receipt, { containsForumText: false });
  return JSON.stringify(receipt);
}

function coverageReceipt(input: {
  complete?: boolean;
  discovered?: number;
  completed?: number;
  observed?: number;
} = {}) {
  const json = coverage(input);
  const parsed = JSON.parse(json) as CanonicalJsonValue & {
    schemaVersion: string;
    observedEventCount: number;
    failedTargetCount: number;
  };
  return {
    json,
    hash: canonicalProtocolHash(parsed.schemaVersion, parsed),
    observedEventCount: parsed.observedEventCount,
    failedTargetCount: parsed.failedTargetCount
  };
}

const QUALIFICATION: PersistedEvidenceQualification = {
  answerability: "qualified",
  formatValid: true,
  evidenceLegal: true,
  relationCorrect: true,
  temporalLegal: true,
  supportResolution: "resolved",
  appropriateAbstention: false,
  decision: "qualify",
  reasonCodes: []
};

function contentGraph(input: {
  coverageHash: string;
  decoy?: Decoy;
}) {
  const nodes = [
    {
      nodeKey: "course-node",
      kind: "course",
      role: null,
      ordinal: null,
      firstSeenAt: null,
      lastSeenAt: null,
      completeness: "complete",
      metricsJson: "{}",
      stateHash: ""
    },
    {
      nodeKey: "thread-node",
      kind: "thread",
      role: null,
      ordinal: null,
      firstSeenAt: CURRENT_AS_OF,
      lastSeenAt: CURRENT_AS_OF,
      completeness: "complete",
      metricsJson: "{}",
      stateHash: ""
    }
  ].map((node) => {
    const material = {
      nodeKey: node.nodeKey,
      kind: node.kind,
      role: node.role,
      ordinal: node.ordinal,
      firstSeenAt: node.firstSeenAt?.toISOString() ?? null,
      lastSeenAt: node.lastSeenAt?.toISOString() ?? null,
      completeness: node.completeness,
      metrics: {}
    };
    return {
      ...node,
      stateHash: canonicalProtocolHash(
        "cmooc.course-graph-node-state.v2",
        material as CanonicalJsonValue
      )
    };
  });
  const normalizedNodes = nodes.map((node) => ({
    nodeKey: node.nodeKey,
    kind: node.kind,
    role: node.role,
    ordinal: node.ordinal,
    firstSeenAt: node.firstSeenAt?.toISOString() ?? null,
    lastSeenAt: node.lastSeenAt?.toISOString() ?? null,
    completeness: node.completeness,
    metrics: {},
    stateHash: node.stateHash
  }));
  const edges = [
    {
      edgeKey: "contains-edge",
      sourceNodeKey: "course-node",
      targetNodeKey: "thread-node",
      kind: "contains",
      scopeNodeKey: "course-node",
      weight: 1,
      evidenceCount: 1,
      firstEventAt: CURRENT_AS_OF,
      latestEventAt: CURRENT_AS_OF,
      completeness: "complete",
      stateHash: ""
    }
  ].map((edge) => {
    const material = {
      edgeKey: edge.edgeKey,
      sourceNodeKey: edge.sourceNodeKey,
      targetNodeKey: edge.targetNodeKey,
      kind: edge.kind,
      scopeNodeKey: edge.scopeNodeKey,
      weight: edge.weight,
      evidenceCount: edge.evidenceCount,
      firstEventAt: edge.firstEventAt.toISOString(),
      latestEventAt: edge.latestEventAt.toISOString(),
      completeness: edge.completeness
    };
    return {
      ...edge,
      stateHash: canonicalProtocolHash(
        "cmooc.course-graph-edge-state.v2",
        material as CanonicalJsonValue
      )
    };
  });
  const normalizedEdges = edges.map((edge) => ({
    edgeKey: edge.edgeKey,
    sourceNodeKey: edge.sourceNodeKey,
    targetNodeKey: edge.targetNodeKey,
    kind: edge.kind,
    scopeNodeKey: edge.scopeNodeKey,
    weight: edge.weight,
    evidenceCount: edge.evidenceCount,
    firstEventAt: edge.firstEventAt.toISOString(),
    latestEventAt: edge.latestEventAt.toISOString(),
    completeness: edge.completeness,
    stateHash: edge.stateHash
  }));
  const actualNodeSetHash = canonicalProtocolHash(
    "cmooc.course-graph-node-set.v2",
    normalizedNodes as CanonicalJsonValue
  );
  const actualEdgeSetHash = canonicalProtocolHash(
    "cmooc.course-graph-edge-set.v2",
    normalizedEdges as CanonicalJsonValue
  );
  const nodeSetHash =
    input.decoy === "graph_node_set_hash" ? "node-decoy" : actualNodeSetHash;
  const edgeSetHash =
    input.decoy === "graph_edge_set_hash" ? "edge-decoy" : actualEdgeSetHash;
  const learnerPositionSetHash = canonicalProtocolHash(
    "cmooc.learner-network-position-set.v1",
    []
  );
  const graphMaterial = {
    schemaVersion: COURSE_CONTENT_GRAPH_SCHEMA_VERSION,
    courseAlias: "safe-course",
    courseKey: "course-node",
    worldHash: "world-current",
    asOfAt: CURRENT_AS_OF.toISOString(),
    coverageHash: input.coverageHash,
    coverageStatus: "complete",
    roleRegistryStatus: "complete",
    nodeSetHash,
    edgeSetHash,
    learnerPositionSetHash,
    containsForumText: false
  };
  const actualContentGraphHash = canonicalProtocolHash(
    COURSE_CONTENT_GRAPH_SCHEMA_VERSION,
    graphMaterial
  );
  const contentGraphHash =
    input.decoy === "graph_content_hash" ? "graph-decoy" : actualContentGraphHash;
  const nodeCount = input.decoy === "graph_node_count" ? 3 : nodes.length;
  const edgeCount = input.decoy === "graph_edge_count" ? 2 : edges.length;
  return {
    worldSnapshotId: "snapshot-current",
    courseAlias: input.decoy === "graph_course" ? "decoy-course" : "safe-course",
    asOfAt: CURRENT_AS_OF,
    schemaVersion: COURSE_CONTENT_GRAPH_SCHEMA_VERSION,
    structureFactSetHash: "facts-current",
    nodeSetHash,
    edgeSetHash,
    contentGraphHash,
    coverageHash: input.coverageHash,
    coverageStatus:
      input.decoy === "graph_coverage_status" ? "corrupt" : "complete",
    roleRegistryStatus: "complete",
    nodeCount,
    edgeCount,
    learnerNodeCount: 0,
    stateJson: JSON.stringify({
      schemaVersion: COURSE_CONTENT_GRAPH_SCHEMA_VERSION,
      courseKey: "course-node",
      worldHash: "world-current",
      asOfAt: CURRENT_AS_OF.toISOString(),
      structureFactSetHash: "facts-current",
      nodeSetHash,
      edgeSetHash,
      contentGraphHash,
      nodeCount,
      edgeCount,
      learnerNodeCount: 0,
      learnerPositionCount: 0,
      coverageStatus: "complete",
      roleRegistryStatus: "complete",
      containsForumText: false
    }),
    nodes,
    edges,
    learnerPositions: []
  };
}

type Decoy =
  | "manifest_hash"
  | "invocation_course"
  | "snapshot_invocation"
  | "scan_hash"
  | "candidate_snapshot"
  | "decision_world"
  | "graph_course"
  | "coverage_json"
  | "graph_coverage_status"
  | "graph_content_hash"
  | "graph_node_set_hash"
  | "graph_edge_set_hash"
  | "graph_node_count"
  | "graph_edge_count"
  | "thread_count"
  | "mature_gap_count";

function fakeDb(options: {
  decoy?: Decoy;
  earlier?: Array<Record<string, unknown>>;
  baselineScan?: Record<string, unknown> | null;
  qualification?:
    | "valid"
    | "missing"
    | "tampered"
    | "wrong_version"
    | "invalid_shape";
} = {}) {
  const currentCoverage = coverageReceipt();
  const baselineCoverage = coverageReceipt({ discovered: 6, completed: 6, observed: 9 });
  const calls: Array<{ model: string; method: string; args: unknown }> = [];
  const record = <T>(model: string, method: string, value: T) =>
    async (args: unknown) => {
      calls.push({ model, method, args });
      return value;
    };
  const scanValues = [
    {
      id: "scan-current",
      invocationId: "invocation-current",
      courseAlias: "safe-course",
      status: "completed",
      coverageJson:
        options.decoy === "coverage_json"
          ? coverage({ observed: 15 })
          : currentCoverage.json,
      coverageHash: options.decoy === "scan_hash" ? "coverage-decoy" : currentCoverage.hash,
      observedEventCount: currentCoverage.observedEventCount,
      failedTargetCount: currentCoverage.failedTargetCount
    },
    options.baselineScan === undefined
      ? {
          status: "completed",
          coverageHash: baselineCoverage.hash,
          coverageJson: baselineCoverage.json,
          observedEventCount: baselineCoverage.observedEventCount,
          failedTargetCount: baselineCoverage.failedTargetCount
        }
      : options.baselineScan
  ];
  let scanIndex = 0;
  const candidateDocument: AutonomyCandidateSet = {
    schemaVersion: CANDIDATE_SET_SCHEMA_VERSION,
    courseAlias: "safe-course",
    worldHash: "world-current",
    eventSetHash: "events-current",
    asOfAt: CURRENT_AS_OF.toISOString(),
    candidates: [],
    containsForumText: false
  };
  const candidateSetHash = canonicalProtocolHash(
    candidateDocument.schemaVersion,
    candidateDocument as unknown as CanonicalJsonValue
  );
  const opportunityReceiptHash = "opportunity-current";
  const projectedQualification =
    options.qualification === "invalid_shape"
      ? { ...QUALIFICATION, formatValid: false }
      : QUALIFICATION;
  const qualificationSummary = {
    schemaVersion: "cmooc.autonomy-decision-summary.v1",
    candidateKey: "candidate-current",
    decision: "draft",
    opportunityReceiptHash,
    ...(options.qualification === "missing"
      ? {}
      : {
          opportunityReceiptSchemaVersion: "cmooc.live-opportunity-receipt.v1",
          qualificationSchemaVersion:
            options.qualification === "wrong_version"
              ? "cmooc.persisted-evidence-qualification.v0"
              : PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION,
          qualification: projectedQualification,
          qualificationHash:
            options.qualification === "tampered"
              ? "qualification-decoy"
              : hashPersistedEvidenceQualification({
                  opportunityReceiptHash,
                  qualification:
                    projectedQualification as PersistedEvidenceQualification
                })
        })
  };
  const db = {
    autonomyCourseManifest: {
      findUnique: record("manifest", "findUnique", {
        alias: "safe-course",
        manifestHash:
          options.decoy === "manifest_hash" ? "manifest-decoy" : "manifest-current"
      })
    },
    scheduledInvocation: {
      findUnique: record("invocation", "findUnique", {
        id: "invocation-current",
        courseAlias:
          options.decoy === "invocation_course" ? "decoy-course" : "safe-course",
        manifestHash: "manifest-current"
      })
    },
    courseWorldSnapshot: {
      findUnique: record("snapshot", "findUnique", {
        id: "snapshot-current",
        invocationId:
          options.decoy === "snapshot_invocation"
            ? "invocation-decoy"
            : "invocation-current",
        courseAlias: "safe-course",
        asOfAt: CURRENT_AS_OF,
        eventSetHash: "events-current",
        worldHash: "world-current",
        graphHash: "graph-current",
        coverageHash: currentCoverage.hash,
        eventCount: 20,
        threadCount: options.decoy === "thread_count" ? 11 : 10,
        actorCount: 8,
        edgeCount: 7,
        openGapCount: 4
      }),
      findMany: record(
        "snapshots",
        "findMany",
        options.earlier ?? [
          {
            id: "snapshot-baseline",
            invocationId: "invocation-baseline",
            courseAlias: "safe-course",
            asOfAt: BASELINE_AS_OF,
            coverageHash: baselineCoverage.hash,
            eventCount: 12,
            threadCount: 6,
            actorCount: 5,
            edgeCount: 3,
            openGapCount: 1
          }
        ]
      )
    },
    courseScanRun: {
      findUnique: async (args: unknown) => {
        calls.push({ model: "scan", method: "findUnique", args });
        const value = scanValues[Math.min(scanIndex, scanValues.length - 1)];
        scanIndex += 1;
        return value;
      }
    },
    candidateSet: {
      findUnique: record("candidate", "findUnique", {
        invocationId: "invocation-current",
        snapshotId:
          options.decoy === "candidate_snapshot" ? "snapshot-decoy" : "snapshot-current",
        candidateSetHash,
        asOfAt: CURRENT_AS_OF,
        candidateCount: 0,
        candidatesJson: JSON.stringify(candidateDocument)
      })
    },
    autonomyDecision: {
      findMany: record("decisions", "findMany", [
        {
          id: "decision-current",
          invocationId: "invocation-current",
          courseAlias: "safe-course",
          threadKey: "thread-current",
          decision: "draft",
          opportunityReceiptHash,
          evidenceAsOf: CURRENT_AS_OF,
          decisionJson: JSON.stringify(qualificationSummary),
          worldHash:
            options.decoy === "decision_world" ? "world-decoy" : "world-current",
          candidateSetHash
        }
      ])
    },
    threadStateAtCutoff: {
      groupBy: record("threads", "groupBy", [
        { completeness: "complete", _count: { _all: 8 } },
        { completeness: "censored", _count: { _all: 2 } }
      ]),
      aggregate: record("supportGaps", "aggregate", {
        _count: { _all: options.decoy === "mature_gap_count" ? 9 : 4 }
      })
    },
    courseContentGraphSnapshot: {
      findUnique: record(
        "graph",
        "findUnique",
        contentGraph({ coverageHash: currentCoverage.hash, decoy: options.decoy })
      )
    },
    // Mutating methods are explicit tripwires. A reader must never touch them.
    $transaction: () => {
      throw new Error("WRITE_METHOD_CALLED:$transaction");
    },
    autonomyDecisionWriteDecoy: {
      create: () => {
        throw new Error("WRITE_METHOD_CALLED:create");
      },
      update: () => {
        throw new Error("WRITE_METHOD_CALLED:update");
      },
      delete: () => {
        throw new Error("WRITE_METHOD_CALLED:delete");
      }
    }
  } as unknown as PrismaClient;
  return { db, calls };
}

const ANCHOR = {
  courseAlias: "safe-course",
  invocationId: "invocation-current",
  snapshotId: "snapshot-current"
};

test("evidence reader binds every aggregate to one exact anchor and uses only strict selects", async () => {
  const { db, calls } = fakeDb();
  const workspace = await getAnchoredCourseEvidenceWorkspace({
    anchor: ANCHOR,
    prisma: db
  });

  assert.equal(workspace.status, "ready");
  assert.equal(workspace.anchor?.snapshotId, "snapshot-current");
  assert.equal(workspace.anchor?.baselineSnapshotId, "snapshot-baseline");
  assert.equal(workspace.waterfall.status, "qualified");
  assert.equal(workspace.portrait.allObservedUnitCount, 10);
  assert.equal(workspace.portrait.eligibleCompleteUnitCount, 8);
  assert.equal(workspace.portrait.unsupportedUnitCount, 2);
  assert.deepEqual(workspace.portrait.compatibleRange, {
    lower: 0.4,
    upper: 0.6,
    basis: "成熟支持缺口占全部观察单位的下界，至把未支持单位全部计入后的上界",
    kind: "identification_interval_not_confidence_interval"
  });

  for (const call of calls) {
    const args = call.args as { select?: unknown };
    assert.ok(args.select || call.method === "groupBy" || call.method === "aggregate");
  }
  const serializedCalls = JSON.stringify(calls);
  for (const forbidden of [
    "summaryJson",
    "receiptJson",
    "payloadJson",
    "threadKey",
    "authorKey"
  ]) {
    assert.equal(serializedCalls.includes(forbidden), false);
  }
  for (const call of calls) {
    const selected = JSON.stringify((call.args as { select?: unknown }).select ?? null);
    if (selected.includes("stateJson") || selected.includes("actorKey")) {
      assert.equal(call.model, "graph");
    }
  }
  assert.equal(calls.some((call) => /create|update|delete|upsert/i.test(call.method)), false);
});

test("baseline selection is strict earlier, same course, same manifest, and has no latest fallback", async () => {
  const { db, calls } = fakeDb();
  await getAnchoredCourseEvidenceWorkspace({ anchor: ANCHOR, prisma: db });
  const baselineCall = calls.find((call) => call.model === "snapshots");

  assert.deepEqual(
    (baselineCall?.args as { where: unknown }).where,
    {
      courseAlias: "safe-course",
      asOfAt: { lt: CURRENT_AS_OF },
      invocation: { is: { manifestHash: "manifest-current" } }
    }
  );
  assert.deepEqual(
    (baselineCall?.args as { orderBy: unknown }).orderBy,
    [{ asOfAt: "desc" }, { id: "asc" }]
  );
  assert.equal((baselineCall?.args as { take: number }).take, 2);

  const noBaseline = fakeDb({ earlier: [] });
  const workspace = await getAnchoredCourseEvidenceWorkspace({
    anchor: ANCHOR,
    prisma: noBaseline.db
  });
  assert.equal(workspace.anchor?.baselineSnapshotId, null);
  assert.equal(workspace.change.status, "unavailable");
  assert.equal(workspace.change.metrics.every((metric) => metric.delta === null), true);
  assert.equal(noBaseline.calls.filter((call) => call.model === "scan").length, 1);
});

test("ambiguous equal-time baselines and unverifiable baseline coverage fail closed without fallback", async () => {
  const ambiguous = fakeDb({
    earlier: [
      {
        id: "snapshot-a",
        invocationId: "invocation-a",
        courseAlias: "safe-course",
        asOfAt: BASELINE_AS_OF,
        coverageHash: "coverage-a",
        eventCount: 12,
        threadCount: 6,
        actorCount: 5,
        edgeCount: 3,
        openGapCount: 1
      },
      {
        id: "snapshot-b",
        invocationId: "invocation-b",
        courseAlias: "safe-course",
        asOfAt: BASELINE_AS_OF,
        coverageHash: "coverage-b",
        eventCount: 11,
        threadCount: 5,
        actorCount: 4,
        edgeCount: 2,
        openGapCount: 1
      }
    ]
  });
  const ambiguousWorkspace = await getAnchoredCourseEvidenceWorkspace({
    anchor: ANCHOR,
    prisma: ambiguous.db
  });
  assert.equal(ambiguousWorkspace.anchor?.baselineSnapshotId, null);
  assert.equal(ambiguousWorkspace.change.status, "unavailable");

  const unavailableCoverage = fakeDb({ baselineScan: null });
  const lowerBound = await getAnchoredCourseEvidenceWorkspace({
    anchor: ANCHOR,
    prisma: unavailableCoverage.db
  });
  assert.equal(lowerBound.anchor?.baselineSnapshotId, "snapshot-baseline");
  assert.equal(lowerBound.change.status, "lower_bound");
});

test("reader rejects cross-course, cross-snapshot, hash, decision, and aggregate decoys", async () => {
  for (const decoy of [
    "manifest_hash",
    "invocation_course",
    "snapshot_invocation",
    "scan_hash",
    "candidate_snapshot",
    "decision_world",
    "coverage_json",
    "thread_count",
    "mature_gap_count"
  ] as const) {
    await assert.rejects(
      getAnchoredCourseEvidenceWorkspace({
        anchor: ANCHOR,
        prisma: fakeDb({ decoy }).db
      }),
      (error: unknown) => {
        assert.equal(error instanceof CourseEvidenceWorkspaceReadError, true);
        assert.equal(
          (error as CourseEvidenceWorkspaceReadError).code,
          "EVIDENCE_ANCHOR_CONFLICT"
        );
        return true;
      }
    );
  }
});

test("reader reports a hash-bound new qualification and keeps legacy or tampered projections UNKNOWN", async () => {
  const verified = await getAnchoredCourseEvidenceWorkspace({
    anchor: ANCHOR,
    prisma: fakeDb().db
  });

  assert.equal(verified.waterfall.status, "qualified");
  assert.equal(
    verified.waterfall.stages.every((stage) => stage.state === "pass"),
    true
  );

  for (const qualification of [
    "missing",
    "tampered",
    "wrong_version",
    "invalid_shape"
  ] as const) {
    const workspace = await getAnchoredCourseEvidenceWorkspace({
      anchor: ANCHOR,
      prisma: fakeDb({ qualification }).db
    });

    assert.equal(workspace.waterfall.status, "unavailable");
    assert.equal(workspace.waterfall.stages[0]?.state, "unknown");
    assert.deepEqual(
      workspace.waterfall.stages.slice(1).map((stage) => stage.state),
      ["not_evaluated", "not_evaluated", "not_evaluated", "not_evaluated", "not_evaluated"]
    );
  }
});

test("reader pins the graph lookup to the exact snapshot and schema version without fallback", async () => {
  const { db, calls } = fakeDb();
  await getAnchoredCourseEvidenceWorkspace({ anchor: ANCHOR, prisma: db });
  const graphCall = calls.find((call) => call.model === "graph");

  assert.deepEqual(
    (graphCall?.args as { where: unknown }).where,
    {
      worldSnapshotId_schemaVersion: {
        worldSnapshotId: "snapshot-current",
        schemaVersion: COURSE_CONTENT_GRAPH_SCHEMA_VERSION
      }
    }
  );
  assert.equal(graphCall?.method, "findUnique");
});

test("graph hashes and counts are fully verified but graph corruption does not over-block non-graph evidence", async () => {
  const coverageHash = coverageReceipt().hash;
  const anchor = {
    snapshotId: "snapshot-current",
    courseAlias: "safe-course",
    worldHash: "world-current",
    coverageHash,
    asOfAt: CURRENT_AS_OF
  };
  assert.equal(
    verifyContentGraphIntegrity({
      graph: contentGraph({ coverageHash }),
      anchor
    }).status,
    "verified"
  );

  for (const [decoy, reasonCode] of [
    ["graph_content_hash", "content_graph_hash_mismatch"],
    ["graph_node_set_hash", "content_graph_child_hash_mismatch"],
    ["graph_edge_set_hash", "content_graph_child_hash_mismatch"],
    ["graph_node_count", "content_graph_count_mismatch"],
    ["graph_edge_count", "content_graph_count_mismatch"]
  ] as const) {
    const integrity = verifyContentGraphIntegrity({
      graph: contentGraph({ coverageHash, decoy }),
      anchor
    });
    assert.equal(integrity.status, "failed");
    assert.equal(integrity.reasonCode, reasonCode);

    const workspace = await getAnchoredCourseEvidenceWorkspace({
      anchor: ANCHOR,
      prisma: fakeDb({ decoy }).db
    });
    assert.equal(workspace.status, "ready");
    assert.equal(workspace.waterfall.status, "qualified");
    assert.equal(workspace.portrait.status, "unavailable");
  }

  const learnerCountDecoy = contentGraph({ coverageHash });
  learnerCountDecoy.learnerNodeCount = 1;
  const state = JSON.parse(learnerCountDecoy.stateJson) as Record<string, unknown>;
  state.learnerNodeCount = 1;
  learnerCountDecoy.stateJson = JSON.stringify(state);
  assert.equal(
    verifyContentGraphIntegrity({ graph: learnerCountDecoy, anchor }).reasonCode,
    "content_graph_count_mismatch"
  );
});
