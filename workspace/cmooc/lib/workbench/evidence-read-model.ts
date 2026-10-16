import { prisma as defaultPrisma } from "@/lib/db";
import { parseSafeCoverageSummary } from "@/lib/autonomy/read-model";
import { COURSE_CONTENT_GRAPH_SCHEMA_VERSION } from "@/lib/world/course-content-graph-projector";
import {
  CANDIDATE_SET_SCHEMA_VERSION,
  type AutonomyCandidateSet
} from "@/lib/autonomy/candidate-set";
import {
  LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION,
  type LiveOpportunityReasonCode
} from "@/lib/live-runtime/facilitation-kernel";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  buildCourseEvidenceWorkspace,
  hashPersistedEvidenceQualification,
  PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION,
  type EvidenceQualificationInput,
  type PersistedEvidenceQualification,
  type CourseEvidenceWorkspace
} from "@/lib/workbench/course-evidence-workspace";
import {
  CourseEvidenceWorkspaceReadError,
  type CourseEvidenceAnchor
} from "@/lib/workbench/evidence-route-handler";

const MATURE_SUPPORT_GAP_HOURS = 72;

const LIVE_OPPORTUNITY_REASON_CODES = new Set<LiveOpportunityReasonCode>([
  "draft_eligible",
  "external_human_response",
  "distinct_actor_response",
  "original_author_return",
  "existing_system_or_agent_response",
  "sequence_socially_complete",
  "support_gap_not_mature",
  "insufficient_longitudinal_history",
  "author_cooldown_active",
  "repeat_touch_limit",
  "budget_unavailable",
  "construct_unanswerable",
  "relation_unanswerable",
  "target_role_unknown",
  "target_actor_ineligible",
  "insufficient_admissible_evidence",
  "support_unresolved",
  "source_censored",
  "history_evidence_unavailable",
  "target_version_changed",
  "protocol_failure"
]);

type PersistedDecisionQualificationInput = {
  id: string;
  decision: string;
  opportunityReceiptHash: string;
  decisionJson: string;
};

type ContentGraphRow = {
  worldSnapshotId: string;
  courseAlias: string;
  asOfAt: Date;
  schemaVersion: string;
  structureFactSetHash: string;
  nodeSetHash: string;
  edgeSetHash: string;
  contentGraphHash: string;
  coverageHash: string;
  coverageStatus: string;
  roleRegistryStatus: string;
  nodeCount: number;
  edgeCount: number;
  learnerNodeCount: number;
  stateJson: string;
  nodes: Array<{
    nodeKey: string;
    kind: string;
    role: string | null;
    ordinal: number | null;
    firstSeenAt: Date | null;
    lastSeenAt: Date | null;
    completeness: string;
    metricsJson: string;
    stateHash: string;
  }>;
  edges: Array<{
    edgeKey: string;
    sourceNodeKey: string;
    targetNodeKey: string;
    kind: string;
    scopeNodeKey: string | null;
    weight: number;
    evidenceCount: number;
    firstEventAt: Date | null;
    latestEventAt: Date | null;
    completeness: string;
    stateHash: string;
  }>;
  learnerPositions: Array<{
    actorKey: string;
    windowKind: string;
    coverageStatus: string;
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
  }>;
};

export type ContentGraphIntegrityResult = {
  status: "verified" | "failed" | "unavailable";
  reasonCode:
    | "content_graph_verified"
    | "content_graph_missing"
    | "content_graph_anchor_mismatch"
    | "content_graph_state_invalid"
    | "content_graph_child_hash_mismatch"
    | "content_graph_count_mismatch"
    | "content_graph_hash_mismatch";
  contentGraphHash: string | null;
  nodeSetHash: string | null;
  edgeSetHash: string | null;
  nodeCount: number | null;
  edgeCount: number | null;
  learnerNodeCount: number | null;
};

function fail(
  code: "EVIDENCE_ANCHOR_NOT_FOUND" | "EVIDENCE_ANCHOR_CONFLICT",
  message: string
): never {
  throw new CourseEvidenceWorkspaceReadError(code, message);
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function parsePersistedQualification(
  value: unknown
): PersistedEvidenceQualification | null {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "answerability",
      "formatValid",
      "evidenceLegal",
      "relationCorrect",
      "temporalLegal",
      "supportResolution",
      "appropriateAbstention",
      "decision",
      "reasonCodes"
    ]) ||
    !["qualified", "unanswerable"].includes(String(value.answerability)) ||
    value.formatValid !== true ||
    typeof value.evidenceLegal !== "boolean" ||
    typeof value.relationCorrect !== "boolean" ||
    typeof value.temporalLegal !== "boolean" ||
    !["resolved", "unresolved", "conflicting"].includes(
      String(value.supportResolution)
    ) ||
    typeof value.appropriateAbstention !== "boolean" ||
    !["qualify", "abstain", "review"].includes(String(value.decision)) ||
    !Array.isArray(value.reasonCodes) ||
    value.reasonCodes.some(
      (code) =>
        typeof code !== "string" ||
        !LIVE_OPPORTUNITY_REASON_CODES.has(code as LiveOpportunityReasonCode)
    ) ||
    new Set(value.reasonCodes).size !== value.reasonCodes.length
  ) {
    return null;
  }
  const qualification = {
    answerability: value.answerability,
    formatValid: true as const,
    evidenceLegal: value.evidenceLegal,
    relationCorrect: value.relationCorrect,
    temporalLegal: value.temporalLegal,
    supportResolution: value.supportResolution,
    appropriateAbstention: value.appropriateAbstention,
    decision: value.decision,
    reasonCodes: [...value.reasonCodes]
  } as PersistedEvidenceQualification;
  const qualifiedShape =
    qualification.answerability === "qualified" &&
    qualification.evidenceLegal &&
    qualification.relationCorrect &&
    qualification.temporalLegal &&
    qualification.supportResolution === "resolved" &&
    qualification.reasonCodes.length === 0;
  if (
    qualification.appropriateAbstention !==
      (qualification.decision !== "qualify") ||
    (qualification.decision === "qualify" && !qualifiedShape)
  ) {
    return null;
  }
  return qualification;
}

/**
 * Reads only the safe qualification projection written alongside an immutable
 * opportunity receipt. Legacy records and any malformed or substituted
 * projection intentionally remain UNKNOWN instead of being inferred from
 * decision labels or aggregate counts.
 */
export function readPersistedDecisionQualification(
  input: PersistedDecisionQualificationInput
): EvidenceQualificationInput | null {
  try {
    const summary = JSON.parse(input.decisionJson) as unknown;
    if (
      !isRecord(summary) ||
      summary.schemaVersion !== "cmooc.autonomy-decision-summary.v1" ||
      summary.opportunityReceiptSchemaVersion !==
        LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION ||
      summary.qualificationSchemaVersion !==
        PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION ||
      summary.opportunityReceiptHash !== input.opportunityReceiptHash ||
      typeof summary.qualificationHash !== "string"
    ) {
      return null;
    }
    const qualification = parsePersistedQualification(summary.qualification);
    if (
      !qualification ||
      (input.decision === "draft" && qualification.decision !== "qualify") ||
      hashPersistedEvidenceQualification({
        opportunityReceiptHash: input.opportunityReceiptHash,
        qualification
      }) !== summary.qualificationHash
    ) {
      return null;
    }
    return {
      answerability: qualification.answerability,
      formatValid: qualification.formatValid,
      evidenceLegal: qualification.evidenceLegal,
      relationCorrect: qualification.relationCorrect,
      temporalLegal: qualification.temporalLegal,
      supportResolution: qualification.supportResolution
    };
  } catch {
    return null;
  }
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function graphFailure(
  reasonCode: Exclude<
    ContentGraphIntegrityResult["reasonCode"],
    "content_graph_verified" | "content_graph_missing"
  >,
  graph: ContentGraphRow
): ContentGraphIntegrityResult {
  return {
    status: "failed",
    reasonCode,
    contentGraphHash: graph.contentGraphHash,
    nodeSetHash: graph.nodeSetHash,
    edgeSetHash: graph.edgeSetHash,
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    learnerNodeCount: graph.learnerNodeCount
  };
}

/**
 * Verifies the complete persisted Content Graph projection. Callers decide
 * whether a claim depends on this sidecar; a failed graph must block a graph
 * claim, but it must not invalidate an otherwise exact thread support-gap
 * claim.
 */
export function verifyContentGraphIntegrity(input: {
  graph: ContentGraphRow | null;
  anchor: {
    snapshotId: string;
    courseAlias: string;
    worldHash: string;
    coverageHash: string;
    asOfAt: Date;
  };
}): ContentGraphIntegrityResult {
  const graph = input.graph;
  if (!graph) {
    return {
      status: "unavailable",
      reasonCode: "content_graph_missing",
      contentGraphHash: null,
      nodeSetHash: null,
      edgeSetHash: null,
      nodeCount: null,
      edgeCount: null,
      learnerNodeCount: null
    };
  }
  if (
    graph.worldSnapshotId !== input.anchor.snapshotId ||
    graph.courseAlias !== input.anchor.courseAlias ||
    graph.schemaVersion !== COURSE_CONTENT_GRAPH_SCHEMA_VERSION ||
    graph.asOfAt.getTime() !== input.anchor.asOfAt.getTime() ||
    graph.coverageHash !== input.anchor.coverageHash ||
    !["complete", "censored"].includes(graph.coverageStatus) ||
    !["complete", "unavailable"].includes(graph.roleRegistryStatus)
  ) {
    return graphFailure("content_graph_anchor_mismatch", graph);
  }

  let state: Record<string, unknown>;
  try {
    const parsed = JSON.parse(graph.stateJson) as unknown;
    if (!isRecord(parsed)) {
      return graphFailure("content_graph_state_invalid", graph);
    }
    state = parsed;
  } catch {
    return graphFailure("content_graph_state_invalid", graph);
  }
  if (
    state.schemaVersion !== COURSE_CONTENT_GRAPH_SCHEMA_VERSION ||
    typeof state.courseKey !== "string" ||
    !state.courseKey ||
    state.worldHash !== input.anchor.worldHash ||
    state.asOfAt !== graph.asOfAt.toISOString() ||
    state.structureFactSetHash !== graph.structureFactSetHash ||
    state.nodeSetHash !== graph.nodeSetHash ||
    state.edgeSetHash !== graph.edgeSetHash ||
    state.contentGraphHash !== graph.contentGraphHash ||
    state.coverageStatus !== graph.coverageStatus ||
    state.roleRegistryStatus !== graph.roleRegistryStatus ||
    state.containsForumText !== false
  ) {
    return graphFailure("content_graph_state_invalid", graph);
  }

  let normalizedNodes: CanonicalJsonValue[];
  let normalizedEdges: CanonicalJsonValue[];
  let normalizedPositions: CanonicalJsonValue[];
  try {
    normalizedNodes = graph.nodes
      .map((node) => {
        const material = {
          nodeKey: node.nodeKey,
          kind: node.kind,
          role: node.role,
          ordinal: node.ordinal,
          firstSeenAt: iso(node.firstSeenAt),
          lastSeenAt: iso(node.lastSeenAt),
          completeness: node.completeness,
          metrics: JSON.parse(node.metricsJson) as CanonicalJsonValue
        };
        if (
          canonicalProtocolHash(
            "cmooc.course-graph-node-state.v2",
            material as unknown as CanonicalJsonValue
          ) !== node.stateHash
        ) {
          throw new Error("node");
        }
        return { ...material, stateHash: node.stateHash } as CanonicalJsonValue;
      })
      .sort((left, right) =>
        String((left as Record<string, unknown>).nodeKey).localeCompare(
          String((right as Record<string, unknown>).nodeKey)
        )
      );
    normalizedEdges = graph.edges
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
        if (
          canonicalProtocolHash(
            "cmooc.course-graph-edge-state.v2",
            material as unknown as CanonicalJsonValue
          ) !== edge.stateHash
        ) {
          throw new Error("edge");
        }
        return { ...material, stateHash: edge.stateHash } as CanonicalJsonValue;
      })
      .sort((left, right) =>
        String((left as Record<string, unknown>).edgeKey).localeCompare(
          String((right as Record<string, unknown>).edgeKey)
        )
      );
    normalizedPositions = graph.learnerPositions
      .map((position) => {
        const material = {
          actorKey: position.actorKey,
          windowKind: position.windowKind,
          coverageStatus: position.coverageStatus,
          eventCount: position.eventCount,
          authoredThreadCount: position.authoredThreadCount,
          replyCount: position.replyCount,
          inboundReplyCount: position.inboundReplyCount,
          outboundReplyCount: position.outboundReplyCount,
          uniqueInboundPeerCount: position.uniqueInboundPeerCount,
          uniqueOutboundPeerCount: position.uniqueOutboundPeerCount,
          reciprocalPeerCount: position.reciprocalPeerCount,
          componentSize: position.componentSize,
          kCore: position.kCore,
          pageRankE8:
            position.pageRank === null
              ? null
              : Math.round(position.pageRank * 100_000_000)
        };
        if (
          canonicalProtocolHash(
            "cmooc.learner-network-position.v1",
            material as unknown as CanonicalJsonValue
          ) !== position.stateHash
        ) {
          throw new Error("position");
        }
        return { ...material, stateHash: position.stateHash } as CanonicalJsonValue;
      })
      .sort((left, right) => {
        const leftRecord = left as Record<string, unknown>;
        const rightRecord = right as Record<string, unknown>;
        return (
          String(leftRecord.windowKind).localeCompare(
            String(rightRecord.windowKind)
          ) ||
          String(leftRecord.actorKey).localeCompare(
            String(rightRecord.actorKey)
          )
        );
      });
  } catch {
    return graphFailure("content_graph_child_hash_mismatch", graph);
  }

  const learnerNodeCount = graph.nodes.filter(
    (node) => node.kind === "actor" && node.role === "learner"
  ).length;
  if (
    graph.nodeCount !== graph.nodes.length ||
    graph.edgeCount !== graph.edges.length ||
    graph.learnerNodeCount !== learnerNodeCount ||
    state.nodeCount !== graph.nodeCount ||
    state.edgeCount !== graph.edgeCount ||
    state.learnerNodeCount !== graph.learnerNodeCount ||
    state.learnerPositionCount !== graph.learnerPositions.length
  ) {
    return graphFailure("content_graph_count_mismatch", graph);
  }

  const nodeSetHash = canonicalProtocolHash(
    "cmooc.course-graph-node-set.v2",
    normalizedNodes as CanonicalJsonValue
  );
  const edgeSetHash = canonicalProtocolHash(
    "cmooc.course-graph-edge-set.v2",
    normalizedEdges as CanonicalJsonValue
  );
  if (
    nodeSetHash !== graph.nodeSetHash ||
    edgeSetHash !== graph.edgeSetHash
  ) {
    return graphFailure("content_graph_child_hash_mismatch", graph);
  }
  const learnerPositionSetHash = canonicalProtocolHash(
    "cmooc.learner-network-position-set.v1",
    normalizedPositions as CanonicalJsonValue
  );
  const contentGraphHash = canonicalProtocolHash(
    COURSE_CONTENT_GRAPH_SCHEMA_VERSION,
    {
      schemaVersion: COURSE_CONTENT_GRAPH_SCHEMA_VERSION,
      courseAlias: graph.courseAlias,
      courseKey: state.courseKey,
      worldHash: input.anchor.worldHash,
      asOfAt: graph.asOfAt.toISOString(),
      coverageHash: graph.coverageHash,
      coverageStatus: graph.coverageStatus,
      roleRegistryStatus: graph.roleRegistryStatus,
      nodeSetHash,
      edgeSetHash,
      learnerPositionSetHash,
      containsForumText: false
    }
  );
  if (contentGraphHash !== graph.contentGraphHash) {
    return graphFailure("content_graph_hash_mismatch", graph);
  }
  return {
    status: "verified",
    reasonCode: "content_graph_verified",
    contentGraphHash: graph.contentGraphHash,
    nodeSetHash: graph.nodeSetHash,
    edgeSetHash: graph.edgeSetHash,
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    learnerNodeCount: graph.learnerNodeCount
  };
}

export async function readAnchoredContentGraphIntegrity(input: {
  anchor: {
    snapshotId: string;
    courseAlias: string;
    worldHash: string;
    coverageHash: string;
    asOfAt: Date;
  };
  prisma?: typeof defaultPrisma;
}): Promise<ContentGraphIntegrityResult> {
  const db = input.prisma ?? defaultPrisma;
  const graph = await db.courseContentGraphSnapshot.findUnique({
    where: {
      worldSnapshotId_schemaVersion: {
        worldSnapshotId: input.anchor.snapshotId,
        schemaVersion: COURSE_CONTENT_GRAPH_SCHEMA_VERSION
      }
    },
    select: {
      worldSnapshotId: true,
      courseAlias: true,
      asOfAt: true,
      schemaVersion: true,
      structureFactSetHash: true,
      nodeSetHash: true,
      edgeSetHash: true,
      contentGraphHash: true,
      coverageHash: true,
      coverageStatus: true,
      roleRegistryStatus: true,
      nodeCount: true,
      edgeCount: true,
      learnerNodeCount: true,
      stateJson: true,
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
        orderBy: { nodeKey: "asc" }
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
        orderBy: { edgeKey: "asc" }
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
        orderBy: [{ windowKind: "asc" }, { actorKey: "asc" }]
      }
    }
  });
  return verifyContentGraphIntegrity({
    graph: graph as ContentGraphRow | null,
    anchor: input.anchor
  });
}

export function readValidatedCandidateSet(input: {
  json: string;
  hash: string;
  courseAlias: string;
  worldHash: string;
  eventSetHash: string;
  asOfAt: Date;
}): { valid: boolean; count: number; candidateSet: AutonomyCandidateSet | null } {
  try {
    const parsed = JSON.parse(input.json) as AutonomyCandidateSet;
    const valid = (
      parsed.schemaVersion === CANDIDATE_SET_SCHEMA_VERSION &&
      parsed.containsForumText === false &&
      parsed.courseAlias === input.courseAlias &&
      parsed.worldHash === input.worldHash &&
      parsed.eventSetHash === input.eventSetHash &&
      new Date(parsed.asOfAt).getTime() === input.asOfAt.getTime() &&
      Array.isArray(parsed.candidates) &&
      canonicalProtocolHash(
        parsed.schemaVersion,
        parsed as unknown as CanonicalJsonValue
      ) === input.hash
    );
    return {
      valid,
      count: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
      candidateSet: valid ? parsed : null
    };
  } catch {
    return { valid: false, count: 0, candidateSet: null };
  }
}

export function verifyCoverageReceipt(input: {
  json: string;
  hash: string;
  observedEventCount: number;
  failedTargetCount: number;
}): boolean {
  try {
    const parsed = JSON.parse(input.json) as Record<string, unknown>;
    const schemaVersion = parsed.schemaVersion;
    return (
      schemaVersion === "cmooc.course-scan-coverage.v5" &&
      parsed.containsForumText === false &&
      Number.isSafeInteger(parsed.observedEventCount) &&
      Number(parsed.observedEventCount) === input.observedEventCount &&
      Number.isSafeInteger(parsed.failedTargetCount) &&
      Number(parsed.failedTargetCount) === input.failedTargetCount &&
      canonicalProtocolHash(
        schemaVersion,
        parsed as CanonicalJsonValue
      ) === input.hash
    );
  } catch {
    return false;
  }
}

export async function getAnchoredCourseEvidenceWorkspace(input: {
  anchor: CourseEvidenceAnchor;
  prisma?: typeof defaultPrisma;
}): Promise<CourseEvidenceWorkspace> {
  const db = input.prisma ?? defaultPrisma;
  const { courseAlias, invocationId, snapshotId } = input.anchor;
  const [manifest, invocation, snapshot] = await Promise.all([
    db.autonomyCourseManifest.findUnique({
      where: { alias: courseAlias },
      select: { alias: true, manifestHash: true }
    }),
    db.scheduledInvocation.findUnique({
      where: { id: invocationId },
      select: { id: true, courseAlias: true, manifestHash: true }
    }),
    db.courseWorldSnapshot.findUnique({
      where: { id: snapshotId },
      select: {
        id: true,
        invocationId: true,
        courseAlias: true,
        asOfAt: true,
        eventSetHash: true,
        worldHash: true,
        graphHash: true,
        coverageHash: true,
        eventCount: true,
        threadCount: true,
        actorCount: true,
        edgeCount: true,
        openGapCount: true
      }
    })
  ]);

  if (!manifest || !invocation || !snapshot) {
    fail("EVIDENCE_ANCHOR_NOT_FOUND", "Evidence anchor not found.");
  }
  if (
    manifest.alias !== courseAlias ||
    invocation.courseAlias !== courseAlias ||
    invocation.manifestHash !== manifest.manifestHash ||
    snapshot.courseAlias !== courseAlias ||
    snapshot.invocationId !== invocationId ||
    !snapshot.eventSetHash ||
    !snapshot.worldHash ||
    !snapshot.graphHash ||
    !snapshot.coverageHash
  ) {
    fail("EVIDENCE_ANCHOR_CONFLICT", "Evidence anchor lineage conflict.");
  }

  const [scan, candidateSet, decisions, threadGroups, matureSupportGaps, graph, earlier] =
    await Promise.all([
      db.courseScanRun.findUnique({
        where: { invocationId },
        select: {
          id: true,
          invocationId: true,
          courseAlias: true,
          status: true,
          coverageJson: true,
          coverageHash: true,
          observedEventCount: true,
          failedTargetCount: true
        }
      }),
      db.candidateSet.findUnique({
        where: { invocationId },
        select: {
          invocationId: true,
          snapshotId: true,
          candidateSetHash: true,
          asOfAt: true,
          candidateCount: true,
          candidatesJson: true
        }
      }),
      db.autonomyDecision.findMany({
        where: { invocationId },
        orderBy: [{ evidenceAsOf: "desc" }, { id: "asc" }],
        select: {
          id: true,
          invocationId: true,
          courseAlias: true,
          decision: true,
          opportunityReceiptHash: true,
          decisionJson: true,
          worldHash: true,
          candidateSetHash: true
        }
      }),
      db.threadStateAtCutoff.groupBy({
        by: ["completeness"],
        where: { snapshotId },
        _count: { _all: true }
      }),
      db.threadStateAtCutoff.aggregate({
        where: {
          snapshotId,
          completeness: "complete",
          supportGapHours: { gte: MATURE_SUPPORT_GAP_HOURS },
          externalHumanCount: 0,
          distinctActorResponseCount: 0,
          authorReturnCount: 0,
          systemResponseCount: 0
        },
        _count: { _all: true }
      }),
      db.courseContentGraphSnapshot.findUnique({
        where: {
          worldSnapshotId_schemaVersion: {
            worldSnapshotId: snapshotId,
            schemaVersion: COURSE_CONTENT_GRAPH_SCHEMA_VERSION
          }
        },
        select: {
          worldSnapshotId: true,
          courseAlias: true,
          asOfAt: true,
          schemaVersion: true,
          structureFactSetHash: true,
          nodeSetHash: true,
          edgeSetHash: true,
          contentGraphHash: true,
          coverageHash: true,
          coverageStatus: true,
          roleRegistryStatus: true,
          nodeCount: true,
          edgeCount: true,
          learnerNodeCount: true,
          stateJson: true,
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
            orderBy: { nodeKey: "asc" }
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
            orderBy: { edgeKey: "asc" }
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
            orderBy: [{ windowKind: "asc" }, { actorKey: "asc" }]
          }
        }
      }),
      db.courseWorldSnapshot.findMany({
        where: {
          courseAlias,
          asOfAt: { lt: snapshot.asOfAt },
          invocation: { is: { manifestHash: manifest.manifestHash } }
        },
        orderBy: [{ asOfAt: "desc" }, { id: "asc" }],
        take: 2,
        select: {
          id: true,
          invocationId: true,
          courseAlias: true,
          asOfAt: true,
          coverageHash: true,
          eventCount: true,
          threadCount: true,
          actorCount: true,
          edgeCount: true,
          openGapCount: true
        }
      })
    ]);

  const coverage = parseSafeCoverageSummary(scan?.coverageJson);
  const coverageIntegrity = verifyCoverageReceipt({
    json: scan?.coverageJson ?? "",
    hash: scan?.coverageHash ?? "",
    observedEventCount: nonNegative(scan?.observedEventCount),
    failedTargetCount: nonNegative(scan?.failedTargetCount)
  });
  const candidateIntegrity = readValidatedCandidateSet({
    json: candidateSet?.candidatesJson ?? "",
    hash: candidateSet?.candidateSetHash ?? "",
    courseAlias,
    worldHash: snapshot.worldHash,
    eventSetHash: snapshot.eventSetHash,
    asOfAt: snapshot.asOfAt
  });
  if (
    !scan ||
    !candidateSet ||
    scan.invocationId !== invocationId ||
    scan.courseAlias !== courseAlias ||
    scan.status !== "completed" ||
    scan.coverageHash !== snapshot.coverageHash ||
    !coverage ||
    !coverageIntegrity ||
    candidateSet.invocationId !== invocationId ||
    candidateSet.snapshotId !== snapshotId ||
    candidateSet.asOfAt.getTime() !== snapshot.asOfAt.getTime() ||
    !candidateSet.candidateSetHash ||
    !candidateIntegrity.valid ||
    candidateSet.candidateCount !== candidateIntegrity.count ||
    decisions.some(
      (row) =>
        row.invocationId !== invocationId ||
        row.courseAlias !== courseAlias ||
        !row.opportunityReceiptHash ||
        row.worldHash !== snapshot.worldHash ||
        row.candidateSetHash !== candidateSet.candidateSetHash
    )
  ) {
    fail("EVIDENCE_ANCHOR_CONFLICT", "Evidence chain is incomplete or conflicting.");
  }

  const graphIntegrity = verifyContentGraphIntegrity({
    graph: graph as ContentGraphRow | null,
    anchor: {
      snapshotId,
      courseAlias,
      worldHash: snapshot.worldHash,
      coverageHash: snapshot.coverageHash,
      asOfAt: snapshot.asOfAt
    }
  });
  const qualification = decisions[0]
    ? readPersistedDecisionQualification({
        id: decisions[0].id,
        decision: decisions[0].decision,
        opportunityReceiptHash: decisions[0].opportunityReceiptHash,
        decisionJson: decisions[0].decisionJson
      })
    : null;

  const baseline =
    earlier.length > 0 &&
    (earlier.length === 1 ||
      earlier[0]!.asOfAt.getTime() !== earlier[1]!.asOfAt.getTime())
      ? earlier[0]!
      : null;
  const baselineScan = baseline
    ? await db.courseScanRun.findUnique({
        where: { invocationId: baseline.invocationId },
        select: {
          status: true,
          coverageHash: true,
          coverageJson: true,
          observedEventCount: true,
          failedTargetCount: true
        }
      })
    : null;
  const baselineCoverage = parseSafeCoverageSummary(baselineScan?.coverageJson);
  const baselineCoverageIntegrity = baselineScan
    ? verifyCoverageReceipt({
        json: baselineScan.coverageJson,
        hash: baselineScan.coverageHash ?? "",
        observedEventCount: nonNegative(baselineScan.observedEventCount),
        failedTargetCount: nonNegative(baselineScan.failedTargetCount)
      })
    : false;
  const baselineCoverageStatus = !baseline
    ? undefined
    : baselineScan?.status === "completed" &&
        baselineScan.coverageHash === baseline.coverageHash &&
        baselineCoverage &&
        baselineCoverageIntegrity
      ? baselineCoverage.complete
        ? "complete"
        : "partial"
      : "unavailable";

  const allObservedUnitCount = threadGroups.reduce(
    (sum, row) => sum + nonNegative(row._count._all),
    0
  );
  const eligibleCompleteUnitCount = threadGroups
    .filter((row) => row.completeness === "complete")
    .reduce((sum, row) => sum + nonNegative(row._count._all), 0);
  if (
    allObservedUnitCount !== nonNegative(snapshot.threadCount) ||
    eligibleCompleteUnitCount > allObservedUnitCount ||
    nonNegative(matureSupportGaps._count._all) > eligibleCompleteUnitCount
  ) {
    fail(
      "EVIDENCE_ANCHOR_CONFLICT",
      "Thread projection does not match the anchored world snapshot."
    );
  }

  return buildCourseEvidenceWorkspace({
    anchor: input.anchor,
    current: snapshot,
    baseline,
    baselineCoverageStatus,
    coverage: {
      status: coverage.complete ? "complete" : "partial",
      discoveredThreadCount: allObservedUnitCount,
      completedDetailCount: nonNegative(coverage.completedDetailCount),
      observedEventCount: nonNegative(
        coverage.observedEventCount || scan.observedEventCount
      ),
      incompleteThreadCount: Math.max(
        0,
        allObservedUnitCount - eligibleCompleteUnitCount
      ),
      failedTargetCount: nonNegative(
        coverage.failedTargetCount || scan.failedTargetCount
      )
    },
    qualification,
    matureSupportGapCount: nonNegative(matureSupportGaps._count._all),
    threadSupport: {
      allObservedUnitCount,
      eligibleCompleteUnitCount,
      unsupportedUnitCount: Math.max(
        0,
        allObservedUnitCount - eligibleCompleteUnitCount
      )
    },
    graph: {
      status: graphIntegrity.status !== "verified"
        ? "unavailable"
        : graph?.coverageStatus === "complete"
          ? "complete"
          : "censored"
    }
  });
}
