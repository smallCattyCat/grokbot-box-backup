import { prisma as defaultPrisma } from "@/lib/db";
import {
  getAutonomyDashboardReadModel,
  parseSafeCoverageSummary
} from "@/lib/autonomy/read-model";
import {
  getAutonomyWorldReadModel,
  type AutonomyWorldReadModel,
  type SafeNetworkEdge,
  type SafeNetworkNode
} from "@/lib/autonomy/world-read-model";
import {
  buildOperatorScheduleSummary,
  OPERATOR_WORKER_WAKE_SCOPE,
  type OperatorScheduleSummary
} from "@/lib/workbench/operator-schedule";
import { formatDecisionReason } from "@/lib/autonomy/run-operator-presentation";
import {
  buildCourseOpportunityBrief,
  type CourseOpportunityBrief
} from "@/lib/workbench/course-opportunity-brief";
import {
  unavailableCourseEvidenceWorkspace,
  type CourseEvidenceWorkspace
} from "@/lib/workbench/course-evidence-workspace";
import { getAnchoredCourseEvidenceWorkspace } from "@/lib/workbench/evidence-read-model";

export const OPERATOR_WORKSPACE_SCHEMA_VERSION =
  "cmooc.operator-workspace.v3" as const;

export type OperatorOpportunityState =
  | "draft"
  | "wait"
  | "abstain"
  | "yield";

export type OperatorOpportunity = {
  id: string;
  contextRef: string;
  state: OperatorOpportunityState;
  stateLabel: string;
  title: string;
  summary: string;
  evidenceAsOf: string;
  reasonCode: string;
  actionLabel: string;
};

export type OperatorLearnerNetworkNode = {
  id: string;
  label: string;
  x: number;
  y: number;
  radius: number;
  community: number;
  eventCount: number;
  replyCount: number;
  distinctPeerCount: number;
  inboundWeight: number;
  outboundWeight: number;
};

export type OperatorLearnerNetworkEdge = {
  id: string;
  sourceId: string;
  targetId: string;
  weight: number;
  completeness: "complete" | "censored";
  crossCommunity: boolean;
  weakBridge: boolean;
};

export type OperatorLearnerNetwork = {
  status: "ready" | "empty" | "unavailable";
  coverageStatus: "complete" | "lower_bound" | "unavailable";
  totalLearnerCount: number;
  visibleLearnerCount: number;
  directInteractionCount: number;
  reciprocalRelationCount: number;
  communityCount: number;
  weakBridgeCount: number;
  truncated: boolean;
  nodes: OperatorLearnerNetworkNode[];
  edges: OperatorLearnerNetworkEdge[];
  containsIdentity: false;
  containsForumText: false;
};

export type OperatorWorkspaceReadModel = {
  schemaVersion: typeof OPERATOR_WORKSPACE_SCHEMA_VERSION;
  courseBound: boolean;
  courseAlias: string | null;
  courseName: string | null;
  invocationId: string | null;
  invocationStatus: string;
  invocationMode: string;
  scheduledFor: string | null;
  coverage: {
    status: "complete" | "partial" | "unavailable";
    observedEventCount: number;
    incompleteThreadCount: number;
    failedTargetCount: number;
  };
  metrics: {
    events: number;
    threads: number;
    actors: number;
    edges: number;
  };
  decisions: {
    draft: number;
    wait: number;
    abstain: number;
    yield: number;
  };
  evidence: {
    decisionTapeEntryCount: number;
    candidateCount: number;
    graphCoverageStatus: string;
    openIncidentCount: number;
  };
  executionAgents: {
    configurationState: "ready" | "not_configured" | "unavailable";
    configuredAgentCount: number;
    availableAgentCount: number;
    activeAgentCount: number;
    consumedLeaseCountToday: number;
    roles: Array<{
      roleKey: string;
      configuredAgentCount: number;
      availableAgentCount: number;
      activeAgentCount: number;
    }>;
  };
  schedule: OperatorScheduleSummary;
  brief: CourseOpportunityBrief;
  evidenceWorkspace: CourseEvidenceWorkspace;
  learnerNetwork: OperatorLearnerNetwork;
  networkTrend: Array<{
    observedAt: string;
    learnerCount: number;
    interactionCount: number;
    relationCount: number;
    openGapCount: number;
  }>;
  opportunities: OperatorOpportunity[];
  containsForumText: false;
  realPublishEnabled: boolean;
};

export type CourseOpportunityBriefAnchor = {
  courseAlias: string;
  invocationId: string;
  snapshotId: string;
};

export class CourseOpportunityBriefReadError extends Error {
  constructor(
    readonly code:
      | "BRIEF_ANCHOR_NOT_FOUND"
      | "BRIEF_ANCHOR_CONFLICT",
    message: string
  ) {
    super(message);
    this.name = "CourseOpportunityBriefReadError";
  }
}

type OpportunityRow = {
  id: string;
  decision: string;
  reasonCode: string;
  evidenceAsOf: Date;
  worldHash: string;
};

const MATURE_SUPPORT_GAP_HOURS = 72;

export { OPERATOR_WORKER_WAKE_SCOPE };

type OperatorWorkerWakeReceiptRow = {
  status: string;
  startedAt: Date;
  editorWriteCount: number;
  publishAttemptCount: number;
  realPublishEnabled: boolean;
  containsForumText: boolean;
};

type OperatorWorkerWakeReceiptQuery = {
  where: typeof OPERATOR_WORKER_WAKE_SCOPE;
  orderBy: Array<{ startedAt: "desc" } | { id: "desc" }>;
  select: {
    status: true;
    startedAt: true;
    editorWriteCount: true;
    publishAttemptCount: true;
    realPublishEnabled: true;
    containsForumText: true;
  };
};

type OperatorRunReceiptQuery = Omit<OperatorWorkerWakeReceiptQuery, "where">;

const OPERATOR_WAKE_RECEIPT_SELECT = {
  status: true,
  startedAt: true,
  editorWriteCount: true,
  publishAttemptCount: true,
  realPublishEnabled: true,
  containsForumText: true
} as const;

export async function readLatestOperatorWorkerWakeReceipt(input: {
  findFirst: (
    query: OperatorWorkerWakeReceiptQuery
  ) => Promise<OperatorWorkerWakeReceiptRow | null>;
}): Promise<OperatorWorkerWakeReceiptRow | null> {
  return input.findFirst({
    where: OPERATOR_WORKER_WAKE_SCOPE,
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: OPERATOR_WAKE_RECEIPT_SELECT
  });
}

export async function readLatestOperatorRunReceipt(input: {
  findFirst: (
    query: OperatorRunReceiptQuery
  ) => Promise<OperatorWorkerWakeReceiptRow | null>;
}): Promise<OperatorWorkerWakeReceiptRow | null> {
  return input.findFirst({
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: OPERATOR_WAKE_RECEIPT_SELECT
  });
}

const STATE_COPY: Record<
  OperatorOpportunityState,
  Pick<OperatorOpportunity, "stateLabel" | "title" | "summary" | "actionLabel">
> = {
  draft: {
    stateLabel: "可继续",
    title: "促进机会已形成",
    summary: "证据与预算门槛已经通过，可以创建一次受约束的研判任务。",
    actionLabel: "创建研判任务"
  },
  wait: {
    stateLabel: "等待",
    title: "等待更多课程证据",
    summary: "当前信息还不足以形成稳定行动，先保留现场并继续观察。",
    actionLabel: "创建复核任务"
  },
  abstain: {
    stateLabel: "克制",
    title: "系统本轮保持克制",
    summary: "机械规则判断不应介入，可进一步检查证据边界与实现状态。",
    actionLabel: "检查理由"
  },
  yield: {
    stateLabel: "让位",
    title: "系统已让位给课程参与者",
    summary: "课程世界已经出现回应或作者回归，本轮不继续自动促进。",
    actionLabel: "查看证据"
  }
};

const NETWORK_NODE_LIMIT = 54;
const NETWORK_CENTERS = [
  { x: 286, y: 270 },
  { x: 690, y: 210 },
  { x: 650, y: 470 }
] as const;

function stableBucket(value: string, count: number): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % Math.max(1, count);
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function emptyLearnerNetwork(
  status: OperatorLearnerNetwork["status"] = "unavailable"
): OperatorLearnerNetwork {
  return {
    status,
    coverageStatus: "unavailable",
    totalLearnerCount: 0,
    visibleLearnerCount: 0,
    directInteractionCount: 0,
    reciprocalRelationCount: 0,
    communityCount: 0,
    weakBridgeCount: 0,
    truncated: false,
    nodes: [],
    edges: [],
    containsIdentity: false,
    containsForumText: false
  };
}

function weightedDegree(
  nodeId: string,
  edges: SafeNetworkEdge[]
): number {
  let total = 0;
  for (const edge of edges) {
    if (edge.sourceId === nodeId || edge.targetId === nodeId) {
      total += Math.max(0, edge.weight);
    }
  }
  return total;
}

function assignCommunities(
  nodes: SafeNetworkNode[],
  edges: SafeNetworkEdge[]
): Map<string, number> {
  const communityCount = nodes.length >= 18 ? 3 : nodes.length >= 8 ? 2 : 1;
  const ordered = [...nodes].sort(
    (left, right) =>
      weightedDegree(right.id, edges) - weightedDegree(left.id, edges) ||
      left.label.localeCompare(right.label)
  );
  const seeds = ordered.length ? [ordered[0]] : [];
  while (seeds.length < communityCount) {
    const seedIds = new Set(seeds.map((seed) => seed.id));
    const next = ordered
      .filter((node) => !seedIds.has(node.id))
      .sort((left, right) => {
        const affinity = (node: SafeNetworkNode) =>
          edges.reduce((sum, edge) => {
            const touchesNode =
              edge.sourceId === node.id || edge.targetId === node.id;
            const peerId =
              edge.sourceId === node.id ? edge.targetId : edge.sourceId;
            return touchesNode && seedIds.has(peerId)
              ? sum + Math.max(0, edge.weight)
              : sum;
          }, 0);
        return (
          affinity(left) - affinity(right) ||
          weightedDegree(right.id, edges) - weightedDegree(left.id, edges) ||
          left.label.localeCompare(right.label)
        );
      })[0];
    if (!next) break;
    seeds.push(next);
  }
  const assignment = new Map<string, number>();
  for (const [index, seed] of seeds.entries()) assignment.set(seed.id, index);
  for (const node of nodes) {
    if (!assignment.has(node.id)) {
      assignment.set(node.id, stableBucket(node.id, communityCount));
    }
  }

  for (let iteration = 0; iteration < 5; iteration += 1) {
    for (const node of ordered) {
      if (seeds.some((seed) => seed.id === node.id)) continue;
      const scores = new Array<number>(communityCount).fill(0);
      for (const edge of edges) {
        const peerId =
          edge.sourceId === node.id
            ? edge.targetId
            : edge.targetId === node.id
              ? edge.sourceId
              : null;
        if (!peerId) continue;
        const peerCommunity = assignment.get(peerId);
        if (peerCommunity !== undefined) {
          scores[peerCommunity] += Math.max(0, edge.weight);
        }
      }
      let best = assignment.get(node.id) ?? 0;
      for (let index = 0; index < scores.length; index += 1) {
        if (scores[index] > scores[best]) best = index;
      }
      if (scores[best] > 0) assignment.set(node.id, best);
    }
  }
  return assignment;
}

export function buildOperatorLearnerNetwork(
  world: AutonomyWorldReadModel | null
): OperatorLearnerNetwork {
  if (!world?.snapshot) return emptyLearnerNetwork("unavailable");

  const learnerNodes = world.learnerCommunity.nodes;
  if (learnerNodes.length === 0) {
    return {
      ...emptyLearnerNetwork("empty"),
      coverageStatus:
        world.graph.coverageStatus === "complete"
          ? "complete"
          : world.graph.coverageStatus === "censored"
            ? "lower_bound"
            : "unavailable",
      totalLearnerCount: world.graph.learnerNodeCount
    };
  }

  const learnerIds = new Set(learnerNodes.map((node) => node.id));
  const learnerEdges = world.learnerCommunity.edges.filter(
    (edge) => learnerIds.has(edge.sourceId) && learnerIds.has(edge.targetId)
  );
  const orderedNodes = [...learnerNodes]
    .sort(
      (left, right) =>
        weightedDegree(right.id, learnerEdges) - weightedDegree(left.id, learnerEdges) ||
        right.eventCount - left.eventCount ||
        left.label.localeCompare(right.label)
    )
    .slice(0, NETWORK_NODE_LIMIT);
  const visibleIds = new Set(orderedNodes.map((node) => node.id));
  const visibleEdges = learnerEdges.filter(
    (edge) => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId)
  );
  const communities = assignCommunities(orderedNodes, visibleEdges);
  const grouped = new Map<number, SafeNetworkNode[]>();
  for (const node of orderedNodes) {
    const community = communities.get(node.id) ?? 0;
    const group = grouped.get(community) ?? [];
    group.push(node);
    grouped.set(community, group);
  }

  const positionedNodes: OperatorLearnerNetworkNode[] = [];
  for (const [community, members] of grouped) {
    const center = NETWORK_CENTERS[community] ?? NETWORK_CENTERS[0];
    const orderedMembers = [...members].sort(
      (left, right) =>
        weightedDegree(right.id, visibleEdges) - weightedDegree(left.id, visibleEdges) ||
        left.label.localeCompare(right.label)
    );
    for (const [index, node] of orderedMembers.entries()) {
      const angle = index * 2.3999632297 - Math.PI / 2;
      const orbit = index === 0 ? 0 : 28 + Math.sqrt(index) * 27;
      const degree = weightedDegree(node.id, visibleEdges);
      positionedNodes.push({
        id: node.id,
        label: node.label,
        x: Math.round(center.x + Math.cos(angle) * orbit),
        y: Math.round(center.y + Math.sin(angle) * orbit),
        radius: Math.min(22, 6 + Math.sqrt(Math.max(1, degree)) * 1.55),
        community,
        eventCount: node.eventCount,
        replyCount: node.replyCount,
        distinctPeerCount: node.distinctPeerCount,
        inboundWeight: node.inboundWeight,
        outboundWeight: node.outboundWeight
      });
    }
  }

  const directedPairs = new Set(
    visibleEdges.map((edge) => `${edge.sourceId}>${edge.targetId}`)
  );
  const reciprocalPairs = new Set<string>();
  for (const edge of visibleEdges) {
    if (directedPairs.has(`${edge.targetId}>${edge.sourceId}`)) {
      reciprocalPairs.add(pairKey(edge.sourceId, edge.targetId));
    }
  }
  const crossCommunityEdges = visibleEdges.filter(
    (edge) => communities.get(edge.sourceId) !== communities.get(edge.targetId)
  );
  const weakestCrossWeight = crossCommunityEdges.reduce(
    (minimum, edge) => Math.min(minimum, edge.weight),
    Number.POSITIVE_INFINITY
  );
  const projectedEdges = visibleEdges.map((edge) => {
    const crossCommunity =
      communities.get(edge.sourceId) !== communities.get(edge.targetId);
    return {
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      weight: edge.weight,
      completeness: edge.completeness,
      crossCommunity,
      weakBridge:
        crossCommunity && edge.weight === weakestCrossWeight
    } satisfies OperatorLearnerNetworkEdge;
  });

  return {
    status: "ready",
    coverageStatus:
      world.graph.coverageStatus === "complete"
        ? "complete"
        : world.graph.coverageStatus === "censored"
          ? "lower_bound"
          : "unavailable",
    totalLearnerCount: world.graph.learnerNodeCount,
    visibleLearnerCount: positionedNodes.length,
    directInteractionCount: projectedEdges.reduce(
      (sum, edge) => sum + Math.max(0, edge.weight),
      0
    ),
    reciprocalRelationCount: reciprocalPairs.size,
    communityCount: new Set(positionedNodes.map((node) => node.community)).size,
    weakBridgeCount: projectedEdges.filter((edge) => edge.weakBridge).length,
    truncated:
      world.learnerCommunity.truncated || learnerNodes.length > positionedNodes.length,
    nodes: positionedNodes,
    edges: projectedEdges,
    containsIdentity: false,
    containsForumText: false
  };
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function opportunity(row: OpportunityRow): OperatorOpportunity {
  const state =
    row.decision === "draft" ||
    row.decision === "wait" ||
    row.decision === "abstain" ||
    row.decision === "yield"
      ? row.decision
      : "wait";
  return {
    id: row.id,
    contextRef: `decision:${row.id}`,
    state,
    ...STATE_COPY[state],
    evidenceAsOf: row.evidenceAsOf.toISOString(),
    reasonCode: formatDecisionReason(row.reasonCode)
  };
}

/**
 * Read a brief only for an explicit immutable course/run/world anchor.
 *
 * This path deliberately selects scalar evidence fields only. In particular it
 * never reads candidate, decision, incident-summary or invocation-summary JSON.
 */
export async function getAnchoredCourseOpportunityBrief(input: {
  anchor: CourseOpportunityBriefAnchor;
  prisma?: typeof defaultPrisma;
  now?: Date;
}): Promise<CourseOpportunityBrief> {
  const db = input.prisma ?? defaultPrisma;
  const { courseAlias, invocationId, snapshotId } = input.anchor;
  const now = input.now ?? new Date();
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
        worldHash: true,
        coverageHash: true
      }
    })
  ]);

  if (!manifest || !invocation || !snapshot) {
    throw new CourseOpportunityBriefReadError(
      "BRIEF_ANCHOR_NOT_FOUND",
      "未找到请求的课程简报锚点。"
    );
  }
  if (
    manifest.alias !== courseAlias ||
    invocation.courseAlias !== courseAlias ||
    invocation.manifestHash !== manifest.manifestHash ||
    snapshot.courseAlias !== courseAlias ||
    snapshot.invocationId !== invocationId
  ) {
    throw new CourseOpportunityBriefReadError(
      "BRIEF_ANCHOR_CONFLICT",
      "课程、运行与世界快照未形成同一证据锚点。"
    );
  }

  const [scan, candidateSet, decisions, incidents, outcomes, matureSupportGaps] =
    await Promise.all([
      db.courseScanRun.findUnique({
        where: { invocationId },
        select: {
          invocationId: true,
          courseAlias: true,
          status: true,
          coverageJson: true,
          coverageHash: true,
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
          candidateCount: true
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
          reasonCode: true,
          evidenceAsOf: true,
          worldHash: true,
          candidateSetHash: true
        }
      }),
      db.autonomyIncident.findMany({
        where: {
          invocationId,
          status: { in: ["open", "acknowledged"] }
        },
        orderBy: [{ openedAt: "desc" }, { id: "asc" }],
        select: {
          id: true,
          invocationId: true,
          courseAlias: true,
          severity: true,
          code: true,
          evidenceHash: true,
          openedAt: true
        }
      }),
      db.proximalOutcome.findMany({
        where: {
          status: "pending",
          dueAt: { lte: now },
          decision: { is: { invocationId } }
        },
        orderBy: [{ dueAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          decisionId: true,
          observationWindow: true,
          dueAt: true,
          decision: {
            select: {
              invocationId: true,
              courseAlias: true,
              worldHash: true,
              candidateSetHash: true
            }
          }
        }
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
        _count: { _all: true },
        _max: { supportGapHours: true }
      })
    ]);

  if (!scan || !candidateSet) {
    throw new CourseOpportunityBriefReadError(
      "BRIEF_ANCHOR_CONFLICT",
      "请求的世界快照缺少同轮扫描或候选集绑定。"
    );
  }
  const scanCoverage = parseSafeCoverageSummary(scan.coverageJson);
  const scanHashConflict =
    scan.coverageHash !== null && scan.coverageHash !== snapshot.coverageHash;
  if (
    scan.invocationId !== invocationId ||
    scan.courseAlias !== courseAlias ||
    scanHashConflict ||
    candidateSet.invocationId !== invocationId ||
    candidateSet.snapshotId !== snapshotId ||
    candidateSet.asOfAt.getTime() !== snapshot.asOfAt.getTime()
  ) {
    throw new CourseOpportunityBriefReadError(
      "BRIEF_ANCHOR_CONFLICT",
      "扫描、候选集与世界快照的证据绑定不一致。"
    );
  }

  if (
    decisions.some(
      (row) =>
        row.invocationId !== invocationId ||
        row.courseAlias !== courseAlias ||
        row.worldHash !== snapshot.worldHash ||
        row.candidateSetHash !== candidateSet.candidateSetHash
    ) ||
    incidents.some(
      (row) =>
        row.invocationId !== invocationId ||
        row.courseAlias !== courseAlias ||
        !row.evidenceHash
    ) ||
    outcomes.some(
      (row) =>
        row.decision.invocationId !== invocationId ||
        row.decision.courseAlias !== courseAlias ||
        row.decision.worldHash !== snapshot.worldHash ||
        row.decision.candidateSetHash !== candidateSet.candidateSetHash
    )
  ) {
    throw new CourseOpportunityBriefReadError(
      "BRIEF_ANCHOR_CONFLICT",
      "决定、异常或结果窗口与请求的证据锚点不一致。"
    );
  }

  const coverageStatus =
    scan.status !== "completed" ||
    scan.coverageHash === null ||
    !scanCoverage
      ? "unavailable"
      : scanCoverage.complete
        ? "complete"
        : "partial";

  return buildCourseOpportunityBrief({
    anchor: {
      courseAlias,
      courseName: "当前课程",
      invocationId,
      snapshotId,
      manifestHash: manifest.manifestHash,
      worldHash: snapshot.worldHash,
      coverageHash: snapshot.coverageHash,
      candidateSetHash: candidateSet.candidateSetHash,
      worldAsOf: snapshot.asOfAt
    },
    coverage: {
      status: coverageStatus,
      incompleteThreadCount: nonNegative(
        scanCoverage?.incompleteCommentThreadCount
      ),
      failedTargetCount: nonNegative(
        scanCoverage?.failedTargetCount ?? scan.failedTargetCount
      )
    },
    supportGaps: {
      matureCount: nonNegative(matureSupportGaps._count._all),
      longestOpenHours:
        typeof matureSupportGaps._max.supportGapHours === "number"
          ? matureSupportGaps._max.supportGapHours
          : null
    },
    sourceChecks: {
      coverage: "checked",
      supportGaps: "checked",
      decisions: "checked",
      incidents: "checked",
      dueOutcomes: "checked"
    },
    decisions: decisions.map((row) => ({
      id: row.id,
      decision: row.decision,
      reasonCode: row.reasonCode,
      evidenceAsOf: row.evidenceAsOf,
      worldHash: row.worldHash,
      candidateSetHash: row.candidateSetHash,
      courseAlias: row.courseAlias
    })),
    incidents: incidents.map((row) => ({
      id: row.id,
      severity: row.severity,
      code: row.code,
      openedAt: row.openedAt,
      evidenceHash: row.evidenceHash,
      courseAlias: row.courseAlias,
      invocationId: row.invocationId
    })),
    dueOutcomes: outcomes.map((row) => ({
      id: row.id,
      observationWindow: row.observationWindow,
      dueAt: row.dueAt,
      decisionId: row.decisionId,
      courseAlias: row.decision.courseAlias,
      invocationId: row.decision.invocationId,
      worldHash: row.decision.worldHash,
      candidateSetHash: row.decision.candidateSetHash
    }))
  });
}

export async function getOperatorWorkspaceReadModel(input: {
  prisma?: typeof defaultPrisma;
} = {}): Promise<OperatorWorkspaceReadModel> {
  const db = input.prisma ?? defaultPrisma;
  const dashboard = await getAutonomyDashboardReadModel({ prisma: db });
  const focal = dashboard.focalInvocation;
  const requestedCourseAlias =
    focal?.courseAlias ?? dashboard.manifests[0]?.alias ?? null;
  const requestedWorld = requestedCourseAlias
    ? await getAutonomyWorldReadModel({
        courseAlias: requestedCourseAlias,
        snapshotId:
          dashboard.world?.courseAlias === requestedCourseAlias
            ? dashboard.world.id
            : null
      })
    : null;
  const courseAlias = requestedWorld?.selectedCourse?.alias ?? requestedCourseAlias;
  const world =
    courseAlias &&
    requestedWorld?.snapshot?.id === dashboard.world?.id
      ? requestedWorld
      : null;
  const focalManifest = focal
    ? dashboard.manifests.find((manifest) => manifest.alias === focal.courseAlias)
    : null;
  const alignedFocal =
    focal?.courseAlias === courseAlias &&
    focalManifest?.manifestHash === focal.manifestHash &&
    dashboard.world?.invocationId === focal.id &&
    world?.snapshot?.id === dashboard.world.id &&
    dashboard.scan?.invocationId === focal.id &&
    dashboard.scan.courseAlias === focal.courseAlias &&
    dashboard.scan.coverageHash === dashboard.world.coverageHash &&
    dashboard.candidateSet?.invocationId === focal.id &&
    dashboard.candidateSet.snapshotId === dashboard.world.id &&
    dashboard.candidateSet.asOfAt.getTime() === dashboard.world.asOfAt.getTime()
      ? focal
      : null;
  const [
    rows,
    incidents,
    dueOutcomes,
    trendRows,
    schedules,
    latestScheduledInvocation,
    latestHostWake,
    latestWake,
    governance,
    matureSupportGaps
  ] = await Promise.all([
    alignedFocal
      ? db.autonomyDecision.findMany({
          where: { invocationId: alignedFocal.id },
          orderBy: [{ evidenceAsOf: "desc" }, { id: "asc" }],
          select: {
            id: true,
            decision: true,
            reasonCode: true,
            evidenceAsOf: true,
            worldHash: true,
            candidateSetHash: true,
            courseAlias: true
          }
        })
      : Promise.resolve([]),
    alignedFocal
      ? db.autonomyIncident.findMany({
          where: {
            invocationId: alignedFocal.id,
            status: { in: ["open", "acknowledged"] }
          },
          orderBy: [
            { openedAt: "desc" },
            { id: "asc" }
          ],
          take: 5,
          select: {
            id: true,
            severity: true,
            code: true,
            openedAt: true,
            evidenceHash: true,
            courseAlias: true,
            invocationId: true
          }
        })
      : Promise.resolve([]),
    alignedFocal
      ? db.proximalOutcome.findMany({
          where: {
            status: "pending",
            dueAt: { lte: new Date() },
            decision: { is: { invocationId: alignedFocal.id } }
          },
          orderBy: [
            { dueAt: "asc" },
            { id: "asc" }
          ],
          take: 5,
          select: {
            id: true,
            observationWindow: true,
            dueAt: true,
            decisionId: true,
            decision: {
              select: {
                invocationId: true,
                courseAlias: true,
                worldHash: true,
                candidateSetHash: true
              }
            }
          }
        })
      : Promise.resolve([]),
    courseAlias
      ? db.courseWorldSnapshot.findMany({
          where: { courseAlias },
          orderBy: { asOfAt: "desc" },
          take: 6,
          select: {
            asOfAt: true,
            actorCount: true,
            edgeCount: true,
            threadCount: true,
            openGapCount: true
          }
        })
      : Promise.resolve([]),
    courseAlias
      ? db.operationSchedule.findMany({
          where: { courseAlias },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 3,
          select: {
            id: true,
            enabled: true,
            mode: true,
            intervalMinutes: true,
            timeZone: true,
            nextRunAt: true
          }
        })
      : Promise.resolve([]),
    courseAlias
      ? db.scheduledInvocation.findFirst({
          where: { courseAlias },
          orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
          select: {
            scheduleId: true,
            status: true,
            scheduledFor: true
          }
        })
      : Promise.resolve(null),
    readLatestOperatorWorkerWakeReceipt({
      findFirst: (query) => db.autonomyWorkerWakeReceipt.findFirst(query)
    }),
    readLatestOperatorRunReceipt({
      findFirst: (query) => db.autonomyWorkerWakeReceipt.findFirst(query)
    }),
    courseAlias
      ? db.courseOperationGovernancePolicy.findFirst({
          where: { courseAlias },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            status: true,
            mode: true,
            minIntervalMinutes: true,
            emergencyHalt: true,
            validFrom: true,
            validUntil: true
          }
        })
      : Promise.resolve(null),
    alignedFocal && dashboard.world
      ? db.threadStateAtCutoff.aggregate({
          where: {
            snapshotId: dashboard.world.id,
            completeness: "complete",
            supportGapHours: { gte: MATURE_SUPPORT_GAP_HOURS },
            externalHumanCount: 0,
            distinctActorResponseCount: 0,
            authorReturnCount: 0,
            systemResponseCount: 0
          },
          _count: { _all: true },
          _max: { supportGapHours: true }
        })
      : Promise.resolve({
          _count: { _all: 0 },
          _max: { supportGapHours: null as number | null }
        })
  ]);
  const coverage = alignedFocal ? dashboard.coverage : null;
  const complete = coverage?.complete === true;
  const coverageStatus = coverage
    ? complete
      ? "complete"
      : "partial"
    : "unavailable";
  const courseName = requestedWorld?.selectedCourse?.displayName?.trim() || null;
  const evidenceBindingsValid = Boolean(
    alignedFocal &&
      dashboard.world &&
      dashboard.candidateSet &&
      rows.every(
        (row) =>
          row.courseAlias === alignedFocal.courseAlias &&
          row.worldHash === dashboard.world!.worldHash &&
          row.candidateSetHash === dashboard.candidateSet!.candidateSetHash
      ) &&
      incidents.every(
        (incident) =>
          incident.courseAlias === alignedFocal.courseAlias &&
          incident.invocationId === alignedFocal.id &&
          Boolean(incident.evidenceHash)
      ) &&
      dueOutcomes.every(
        (outcome) =>
          outcome.decision.invocationId === alignedFocal.id &&
          outcome.decision.courseAlias === alignedFocal.courseAlias &&
          outcome.decision.worldHash === dashboard.world!.worldHash &&
          outcome.decision.candidateSetHash ===
            dashboard.candidateSet!.candidateSetHash
      )
  );
  const brief = buildCourseOpportunityBrief({
    anchor:
      evidenceBindingsValid &&
      alignedFocal &&
      dashboard.world &&
      dashboard.candidateSet &&
      world?.snapshot
        ? {
            courseAlias: alignedFocal.courseAlias,
            courseName: courseName ?? "当前课程",
            invocationId: alignedFocal.id,
            snapshotId: dashboard.world.id,
            manifestHash: alignedFocal.manifestHash,
            worldHash: dashboard.world.worldHash,
            coverageHash: dashboard.world.coverageHash,
            candidateSetHash: dashboard.candidateSet.candidateSetHash,
            worldAsOf: dashboard.world.asOfAt
          }
        : null,
    coverage: {
      status: coverageStatus,
      incompleteThreadCount: nonNegative(
        coverage?.incompleteCommentThreadCount
      ),
      failedTargetCount: nonNegative(coverage?.failedTargetCount)
    },
    supportGaps: {
      matureCount: nonNegative(matureSupportGaps._count._all),
      longestOpenHours:
        typeof matureSupportGaps._max.supportGapHours === "number"
          ? matureSupportGaps._max.supportGapHours
          : null
    },
    sourceChecks: {
      coverage: alignedFocal ? "checked" : "unavailable",
      supportGaps: alignedFocal ? "checked" : "unavailable",
      decisions: alignedFocal ? "checked" : "unavailable",
      incidents: alignedFocal ? "checked" : "unavailable",
      dueOutcomes: alignedFocal ? "checked" : "unavailable"
    },
    decisions: rows.map((row) => ({
      id: row.id,
      decision: row.decision,
      reasonCode: row.reasonCode,
      evidenceAsOf: row.evidenceAsOf,
      worldHash: row.worldHash,
      candidateSetHash: row.candidateSetHash,
      courseAlias: row.courseAlias
    })),
    incidents: incidents.map((incident) => ({
      id: incident.id,
      severity: incident.severity,
      code: incident.code,
      openedAt: incident.openedAt,
      evidenceHash: incident.evidenceHash,
      courseAlias: incident.courseAlias,
      invocationId: incident.invocationId
    })),
    dueOutcomes: dueOutcomes.map((outcome) => ({
      id: outcome.id,
      observationWindow: outcome.observationWindow,
      dueAt: outcome.dueAt,
      decisionId: outcome.decisionId,
      courseAlias: outcome.decision.courseAlias,
      invocationId: outcome.decision.invocationId,
      worldHash: outcome.decision.worldHash,
      candidateSetHash: outcome.decision.candidateSetHash
    }))
  });
  const evidenceWorkspace = brief.anchor
    ? await getAnchoredCourseEvidenceWorkspace({
        anchor: {
          courseAlias: brief.anchor.courseAlias,
          invocationId: brief.anchor.invocationId,
          snapshotId: brief.anchor.snapshotId
        },
        prisma: db
      }).catch(() => unavailableCourseEvidenceWorkspace())
    : unavailableCourseEvidenceWorkspace();

  return {
    schemaVersion: OPERATOR_WORKSPACE_SCHEMA_VERSION,
    courseBound: Boolean(courseAlias),
    courseAlias,
    courseName,
    invocationId: alignedFocal?.id ?? null,
    invocationStatus: alignedFocal?.status ?? "idle",
    invocationMode: alignedFocal?.mode ?? "SHADOW",
    scheduledFor: alignedFocal?.scheduledFor.toISOString() ?? null,
    coverage: {
      status: coverageStatus,
      observedEventCount: nonNegative(coverage?.observedEventCount),
      incompleteThreadCount: nonNegative(coverage?.incompleteCommentThreadCount),
      failedTargetCount: nonNegative(coverage?.failedTargetCount)
    },
    metrics: {
      events: nonNegative(alignedFocal ? dashboard.world?.eventCount : 0),
      threads: nonNegative(alignedFocal ? dashboard.world?.threadCount : 0),
      actors: nonNegative(alignedFocal ? dashboard.world?.actorCount : 0),
      edges: nonNegative(alignedFocal ? dashboard.world?.edgeCount : 0)
    },
    decisions: alignedFocal
      ? { ...dashboard.decisions }
      : { draft: 0, wait: 0, abstain: 0, yield: 0 },
    evidence: {
      decisionTapeEntryCount: alignedFocal ? dashboard.tapeCount : 0,
      candidateCount: nonNegative(
        alignedFocal ? dashboard.candidateSet?.candidateCount : 0
      ),
      graphCoverageStatus:
        (alignedFocal ? dashboard.graph?.coverageStatus : null) ?? "unavailable",
      openIncidentCount: incidents.length
    },
    executionAgents: {
      configurationState: dashboard.executionAgents.configurationState,
      configuredAgentCount: dashboard.executionAgents.configuredAgentCount,
      availableAgentCount: dashboard.executionAgents.availableAgentCount,
      activeAgentCount: dashboard.executionAgents.activeAgentCount,
      consumedLeaseCountToday:
        dashboard.executionAgents.consumedLeaseCountToday,
      roles: dashboard.executionAgents.roles.map((role) => ({
        roleKey: role.roleKey,
        configuredAgentCount: role.configuredAgentCount,
        availableAgentCount: role.availableAgentCount,
        activeAgentCount: role.activeAgentCount
      }))
    },
    schedule: buildOperatorScheduleSummary({
      now: new Date(),
      schedules,
      governance,
      latestInvocation: latestScheduledInvocation,
      latestHostWake,
      latestWake
    }),
    brief,
    evidenceWorkspace,
    learnerNetwork: buildOperatorLearnerNetwork(world),
    networkTrend: trendRows.map((row) => ({
      observedAt: row.asOfAt.toISOString(),
      learnerCount: nonNegative(row.actorCount),
      interactionCount: nonNegative(row.edgeCount),
      relationCount: nonNegative(row.threadCount),
      openGapCount: nonNegative(row.openGapCount)
    })),
    opportunities: rows.map(opportunity),
    containsForumText: false,
    realPublishEnabled: dashboard.realPublishEnabled
  };
}
