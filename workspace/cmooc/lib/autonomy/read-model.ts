import { prisma } from "@/lib/db";
import { getSafeExecutionAccountPoolSummary } from "@/lib/autonomy/execution-account-pool-read-model";
import { filterOperatorCourses } from "@/lib/autonomy/operator-presentation";

export type SafeCoverageSummary = {
  uiStatus: string;
  courseShellDetected: boolean;
  categoryCount: number;
  categoryCompletedCount: number;
  pageRequestCount: number;
  discoveredThreadCount: number;
  completedDetailCount: number;
  failedTargetCount: number;
  observedEventCount: number;
  truncatedThreadListing: boolean;
  incompleteCommentThreadCount: number;
  complete: boolean;
  failureCodeCounts: Record<string, number>;
};

export type SafeOutcomeEvidenceSummary = {
  outcome: "observed";
  evidenceSource: "full_course" | "target_thread";
  attribution:
    "descriptive_post_publication_observation_not_causal";
  educationalEffectClaimed: false;
};

export type SafeDecisionTapeGovernancePayload = {
  kind: "proximal_outcome_observed";
  observationWindow: "R24" | "R72";
  status: "observed";
  evidenceSource: "full_course" | "target_thread";
  authorReturned: boolean;
  replyDepthDelta: number;
  newAuthorCount: number;
  educationalEffectClaimed: false;
};

export type AutonomyBriefNarrativeInput = {
  latestStatus?: string | null;
  hasInvocation: boolean;
  draftCount: number;
  abstainCount: number;
  yieldCount: number;
};

export function buildAutonomyBriefNarrative(
  input: AutonomyBriefNarrativeInput
): string {
  if (!input.hasInvocation) {
    return "等待第一次课程巡检";
  }
  if (input.latestStatus === "running") {
    return "系统正在巡检课程共同体";
  }
  if (input.latestStatus === "failed") {
    return "最新唤醒需要处理，成果视图保留上次完整巡检";
  }
  if (input.draftCount > 0) {
    return "系统发现可促进机会，当前仍保持影子运行";
  }
  if (input.yieldCount > 0) {
    return "课程共同体正在自行连接，系统本轮选择让位";
  }
  if (input.abstainCount > 0) {
    return "证据尚不足，系统本轮保持克制";
  }
  return "课程共同体已完成本轮巡检";
}

export function formatObservedOutcomeWindows(
  windows: readonly string[]
): string {
  const observed = (["R24", "R72"] as const).filter((window) =>
    windows.includes(window)
  );
  return observed.length > 0 ? observed.join(" / ") : "尚未观察";
}

export function parseSafeDecisionTapeGovernancePayload(
  kind: string,
  payloadJson: string,
  containsForumText: boolean
): SafeDecisionTapeGovernancePayload | null {
  if (
    containsForumText ||
    kind !== "proximal_outcome_observed"
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    if (
      parsed.schemaVersion !==
        "cmooc.proximal-outcome-observation.v1" ||
      (parsed.observationWindow !== "R24" &&
        parsed.observationWindow !== "R72") ||
      parsed.status !== "observed" ||
      (parsed.evidenceSource !== "full_course" &&
        parsed.evidenceSource !== "target_thread") ||
      typeof parsed.authorReturned !== "boolean" ||
      !Number.isSafeInteger(parsed.replyDepthDelta) ||
      Number(parsed.replyDepthDelta) < 0 ||
      !Number.isSafeInteger(parsed.newAuthorCount) ||
      Number(parsed.newAuthorCount) < 0 ||
      parsed.educationalEffectClaimed !== false ||
      parsed.containsForumText !== false
    ) {
      return null;
    }
    return {
      kind: "proximal_outcome_observed",
      observationWindow: parsed.observationWindow,
      status: "observed",
      evidenceSource: parsed.evidenceSource,
      authorReturned: parsed.authorReturned,
      replyDepthDelta: Number(parsed.replyDepthDelta),
      newAuthorCount: Number(parsed.newAuthorCount),
      educationalEffectClaimed: false
    };
  } catch {
    return null;
  }
}

export function parseSafeOutcomeEvidenceSummary(
  value: string | null | undefined
): SafeOutcomeEvidenceSummary | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.schemaVersion !==
        "cmooc.proximal-outcome-observation.v1" ||
      parsed.outcome !== "observed" ||
      (parsed.evidenceSource !== "full_course" &&
        parsed.evidenceSource !== "target_thread") ||
      parsed.attribution !==
        "descriptive_post_publication_observation_not_causal" ||
      parsed.educationalEffectClaimed !== false ||
      parsed.containsForumText !== false
    ) {
      return null;
    }
    return {
      outcome: "observed",
      evidenceSource: parsed.evidenceSource,
      attribution:
        "descriptive_post_publication_observation_not_causal",
      educationalEffectClaimed: false
    };
  } catch {
    return null;
  }
}

function nonNegativeInteger(
  value: unknown,
  fallback = 0
): number {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : fallback;
}

export function parseSafeCoverageSummary(
  value: string | null | undefined
): SafeCoverageSummary | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.containsForumText !== false) return null;
    const failureCodeCounts =
      parsed.failureCodeCounts &&
      typeof parsed.failureCodeCounts === "object" &&
      !Array.isArray(parsed.failureCodeCounts)
        ? Object.fromEntries(
            Object.entries(parsed.failureCodeCounts).flatMap(
              ([key, count]) =>
                /^[a-z][a-z0-9_]{1,80}$/.test(key) &&
                Number.isSafeInteger(count) &&
                Number(count) >= 0
                  ? [[key, Number(count)]]
                  : []
            )
          )
        : {};
    return {
      uiStatus:
        typeof parsed.uiStatus === "string"
          ? parsed.uiStatus
          : "unknown",
      courseShellDetected:
        parsed.courseShellDetected === true,
      categoryCount: nonNegativeInteger(
        parsed.categoryCount
      ),
      categoryCompletedCount: nonNegativeInteger(
        parsed.categoryCompletedCount
      ),
      pageRequestCount: nonNegativeInteger(
        parsed.pageRequestCount
      ),
      discoveredThreadCount: nonNegativeInteger(
        parsed.discoveredThreadCount
      ),
      completedDetailCount: nonNegativeInteger(
        parsed.completedDetailCount
      ),
      failedTargetCount: nonNegativeInteger(
        parsed.failedTargetCount
      ),
      observedEventCount: nonNegativeInteger(
        parsed.observedEventCount
      ),
      truncatedThreadListing:
        parsed.truncatedThreadListing === true,
      incompleteCommentThreadCount: nonNegativeInteger(
        parsed.incompleteCommentThreadCount
      ),
      complete: parsed.complete === true,
      failureCodeCounts
    };
  } catch {
    return null;
  }
}

export function compactHash(
  value: string | null | undefined
): string {
  if (!value) return "—";
  return value.length > 20
    ? `${value.slice(0, 10)}…${value.slice(-6)}`
    : value;
}

export function autonomyDate(
  value: Date | null | undefined
): string {
  if (!value) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(value);
}

export async function getAutonomyDashboardReadModel(input: {
  prisma?: typeof prisma;
} = {}) {
  const db = input.prisma ?? prisma;
  const manifests = filterOperatorCourses(
    await db.autonomyCourseManifest.findMany({
      where: { enabled: true },
      orderBy: { alias: "asc" }
    })
  );
  const visibleCourseAliases = manifests.map((manifest) => manifest.alias);
  const [
    schedules,
    latestInvocation,
    latestCompletedInvocation,
    incidentGroups,
    outcomeGroups,
    wakeReceiptGroups,
    confirmedPublicationCount,
    executionAgents
  ] = await Promise.all([
    db.operationSchedule.findMany({
      where: {
        enabled: true,
        courseAlias: { in: visibleCourseAliases }
      },
      orderBy: { courseAlias: "asc" }
    }),
    db.scheduledInvocation.findFirst({
      where: { courseAlias: { in: visibleCourseAliases } },
      orderBy: { scheduledFor: "desc" }
    }),
    db.scheduledInvocation.findFirst({
      where: {
        courseAlias: { in: visibleCourseAliases },
        status: "completed"
      },
      orderBy: { scheduledFor: "desc" }
    }),
    db.autonomyIncident.groupBy({
      by: ["status"],
      where: { courseAlias: { in: visibleCourseAliases } },
      _count: { _all: true }
    }),
    db.proximalOutcome.groupBy({
      by: ["status", "observationWindow"],
      where: {
        decision: { courseAlias: { in: visibleCourseAliases } }
      },
      _count: { _all: true }
    }),
    db.autonomyWorkerWakeReceipt.groupBy({
      by: ["status"],
      _count: { _all: true }
    }),
    db.executionAttempt.count({
      where: {
        decision: { courseAlias: { in: visibleCourseAliases } },
        status: "confirmed_published",
        publishAttempted: true,
        sentMutationCount: { gt: 0 }
      }
    }),
    getSafeExecutionAccountPoolSummary({ prisma: db })
  ]);

  const incidentCount = (status: string) =>
    incidentGroups.find((group) => group.status === status)?._count
      ._all ?? 0;
  const openIncidentCount = incidentCount("open");
  const unresolvedIncidentCount =
    openIncidentCount + incidentCount("acknowledged");
  const pendingOutcomeCount = outcomeGroups
    .filter((group) => group.status === "pending")
    .reduce((total, group) => total + group._count._all, 0);
  const observedOutcomeCount = outcomeGroups
    .filter((group) => group.status === "observed")
    .reduce((total, group) => total + group._count._all, 0);
  const observedOutcomeWindows = (["R24", "R72"] as const).filter(
    (window) =>
      outcomeGroups.some(
        (group) =>
          group.status === "observed" &&
          group.observationWindow === window
      )
  );
  const wakeReceiptCount = (status: string) =>
    wakeReceiptGroups.find((group) => group.status === status)?._count
      ._all ?? 0;
  const wakeReceiptSummary = {
    completedCount: wakeReceiptCount("completed"),
    attentionCount: wakeReceiptCount("attention"),
    failedCount: wakeReceiptCount("failed"),
    abandonedCount: wakeReceiptCount("abandoned")
  };
  const terminalWakeReceiptCount =
    wakeReceiptSummary.completedCount +
    wakeReceiptSummary.attentionCount +
    wakeReceiptSummary.failedCount +
    wakeReceiptSummary.abandonedCount;

  const focalInvocation =
    latestCompletedInvocation ?? latestInvocation;
  const [
    scan,
    world,
    candidateSet,
    decisionGroups,
    tapeCount,
    lastTapeEntry,
    executionAttemptCount,
    externalWriteAttemptCount
  ] = focalInvocation
    ? await Promise.all([
        db.courseScanRun.findUnique({
          where: { invocationId: focalInvocation.id }
        }),
        db.courseWorldSnapshot.findUnique({
          where: { invocationId: focalInvocation.id }
        }),
        db.candidateSet.findUnique({
          where: { invocationId: focalInvocation.id }
        }),
        db.autonomyDecision.groupBy({
          by: ["decision"],
          where: { invocationId: focalInvocation.id },
          _count: { _all: true }
        }),
        db.decisionTapeEntry.count({
          where: { invocationId: focalInvocation.id }
        }),
        db.decisionTapeEntry.findFirst({
          where: { invocationId: focalInvocation.id },
          orderBy: { sequence: "desc" }
        }),
        db.executionAttempt.count({
          where: {
            decision: { is: { invocationId: focalInvocation.id } }
          }
        }),
        db.executionAttempt.count({
          where: {
            decision: { is: { invocationId: focalInvocation.id } },
            OR: [
              { transport: "real_platform" },
              { requestedMutationCount: { gt: 0 } },
              { sentMutationCount: { gt: 0 } },
              { publishAttempted: true }
            ]
          }
        })
      ])
    : [null, null, null, [], 0, null, 0, 0];

  const decisions = {
    draft: 0,
    wait: 0,
    abstain: 0,
    yield: 0
  };
  for (const group of decisionGroups) {
    if (group.decision in decisions) {
      decisions[
        group.decision as keyof typeof decisions
      ] = group._count._all;
    }
  }

  const [graph, structureFactCount] =
    world && scan
      ? await Promise.all([
          db.courseContentGraphSnapshot.findFirst({
            where: { worldSnapshotId: world.id },
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              schemaVersion: true,
              coverageStatus: true,
              roleRegistryStatus: true,
              nodeCount: true,
              edgeCount: true,
              learnerNodeCount: true,
              nodes: {
                where: { kind: "actor" },
                select: { id: true }
              },
              learnerPositions: {
                where: {
                  windowKind: "all_time",
                  eventCount: { gt: 0 }
                },
                select: { id: true }
              }
            }
          }),
          db.courseStructureFactObservation.count({
            where: { scanRunId: scan.id }
          })
        ])
      : [null, 0];

  return {
    manifests,
    schedules,
    latestInvocation,
    latestCompletedInvocation,
    focalInvocation,
    scan,
    coverage: parseSafeCoverageSummary(
      scan?.coverageJson
    ),
    world,
    candidateSet,
    decisions,
    tapeCount,
    tapeHeadHash: lastTapeEntry?.entryHash ?? null,
    openIncidentCount,
    unresolvedIncidentCount,
    pendingOutcomeCount,
    observedOutcomeCount,
    observedOutcomeWindows,
    wakeReceiptSummary: {
      ...wakeReceiptSummary,
      terminalCount: terminalWakeReceiptCount
    },
    confirmedPublicationCount,
    executionAgents,
    graph: graph
      ? (() => {
          const {
            nodes,
            learnerPositions,
            ...snapshotSummary
          } = graph;
          return {
            ...snapshotSummary,
            actorNodeCount: nodes.length,
            activeLearnerCount: learnerPositions.length
          };
        })()
      : null,
    structureFactCount,
    executionAttemptCount,
    externalWriteAttemptCount,
    realPublishEnabled:
      manifests.some((item) => item.realPublishEnabled) ||
      false
  };
}
