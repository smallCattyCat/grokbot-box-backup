import { prisma } from "@/lib/db";

function parseCourseAlias(argv: string[]): string {
  if (
    argv.length !== 2 ||
    argv[0] !== "--course" ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(argv[1] ?? "")
  ) {
    throw new Error("COURSE_GRAPH_STATUS_COURSE_REQUIRED");
  }
  return argv[1];
}

function safeCoverageSummary(coverageJson: string) {
  const parsed = JSON.parse(coverageJson) as Record<
    string,
    unknown
  >;
  const numberOrNull = (key: string) =>
    typeof parsed[key] === "number" ? parsed[key] : null;
  const failures =
    parsed.failureCodeCounts &&
    typeof parsed.failureCodeCounts === "object" &&
    !Array.isArray(parsed.failureCodeCounts)
      ? Object.fromEntries(
          Object.entries(
            parsed.failureCodeCounts as Record<string, unknown>
          )
            .filter(
              ([key, value]) =>
                /^[a-z0-9_]{1,80}$/.test(key) &&
                Number.isSafeInteger(value) &&
                (value as number) >= 0
            )
            .sort(([left], [right]) =>
              left.localeCompare(right)
            )
        )
      : {};
  return {
    complete: parsed.complete === true,
    categoryCount: numberOrNull("categoryCount"),
    categoryCompletedCount: numberOrNull(
      "categoryCompletedCount"
    ),
    discoveredThreadCount: numberOrNull(
      "discoveredThreadCount"
    ),
    completedDetailCount: numberOrNull(
      "completedDetailCount"
    ),
    failedTargetCount: numberOrNull("failedTargetCount"),
    observedEventCount: numberOrNull("observedEventCount"),
    incompleteCommentThreadCount: numberOrNull(
      "incompleteCommentThreadCount"
    ),
    roleRegistryStatus:
      parsed.roleRegistryStatus === "complete"
        ? "complete"
        : "unavailable",
    roleRegistryMemberCount: numberOrNull(
      "roleRegistryMemberCount"
    ),
    failureCodeCounts: failures
  };
}

async function main(): Promise<void> {
  const courseAlias = parseCourseAlias(
    process.argv.slice(2)
  );
  const snapshot =
    await prisma.courseContentGraphSnapshot.findFirst({
      where: { courseAlias },
      orderBy: [{ asOfAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        worldSnapshotId: true,
        asOfAt: true,
        schemaVersion: true,
        coverageStatus: true,
        roleRegistryStatus: true,
        nodeCount: true,
        edgeCount: true,
        learnerNodeCount: true,
        worldSnapshot: {
          select: { invocationId: true }
        }
      }
    });
  if (!snapshot) {
    process.stdout.write(
      `${JSON.stringify(
        {
          courseAlias,
          status: "not_projected",
          realPublishEnabled: false,
          containsForumText: false
        },
        null,
        2
      )}\n`
    );
    return;
  }
  const scanRun = await prisma.courseScanRun.findUnique({
    where: {
      invocationId: snapshot.worldSnapshot.invocationId
    },
    select: { id: true, coverageJson: true }
  });
  if (!scanRun) {
    throw new Error("COURSE_GRAPH_STATUS_SCAN_MISSING");
  }
  const [
    nodeGroups,
    edgeGroups,
    positionGroups,
    structureFactCount,
    noJoinablePeerEdgeLearnerCount,
    activeLearnerCount,
    reciprocalLearnerCount
  ] = await Promise.all([
    prisma.courseGraphNodeProjection.groupBy({
      by: ["kind"],
      where: { graphSnapshotId: snapshot.id },
      _count: { _all: true },
      orderBy: { kind: "asc" }
    }),
    prisma.courseGraphEdgeProjection.groupBy({
      by: ["kind", "completeness"],
      where: { graphSnapshotId: snapshot.id },
      _count: { _all: true },
      _sum: { weight: true, evidenceCount: true },
      orderBy: [
        { kind: "asc" },
        { completeness: "asc" }
      ]
    }),
    prisma.learnerNetworkPositionAtCutoff.groupBy({
      by: ["windowKind", "coverageStatus"],
      where: { graphSnapshotId: snapshot.id },
      _count: { _all: true },
      orderBy: [
        { windowKind: "asc" },
        { coverageStatus: "asc" }
      ]
    }),
    prisma.courseStructureFactObservation.count({
      where: { scanRunId: scanRun.id }
    }),
    prisma.learnerNetworkPositionAtCutoff.count({
      where: {
        graphSnapshotId: snapshot.id,
        windowKind: "all_time",
        componentSize: 1
      }
    }),
    prisma.learnerNetworkPositionAtCutoff.count({
      where: {
        graphSnapshotId: snapshot.id,
        windowKind: "all_time",
        eventCount: { gt: 0 }
      }
    }),
    prisma.learnerNetworkPositionAtCutoff.count({
      where: {
        graphSnapshotId: snapshot.id,
        windowKind: "all_time",
        reciprocalPeerCount: { gt: 0 }
      }
    })
  ]);
  const report = {
    courseAlias,
    status: "projected",
    schemaVersion: snapshot.schemaVersion,
    asOfAt: snapshot.asOfAt.toISOString(),
    coverageStatus: snapshot.coverageStatus,
    roleRegistryStatus: snapshot.roleRegistryStatus,
    structureFactCount,
    nodeCount: snapshot.nodeCount,
    edgeCount: snapshot.edgeCount,
    learnerNodeCount: snapshot.learnerNodeCount,
    nodeKindCounts: Object.fromEntries(
      nodeGroups.map((group) => [
        group.kind,
        group._count._all
      ])
    ),
    edgeGroups: edgeGroups.map((group) => ({
      kind: group.kind,
      completeness: group.completeness,
      distinctEdgeCount: group._count._all,
      weight: group._sum.weight ?? 0,
      evidenceCount: group._sum.evidenceCount ?? 0
    })),
    learnerPositionGroups: positionGroups.map((group) => ({
      windowKind: group.windowKind,
      coverageStatus: group.coverageStatus,
      learnerCount: group._count._all
    })),
    learnerAllTimeSummary: {
      activeLearnerCount,
      noJoinablePeerEdgeLearnerCount,
      reciprocalLearnerCount
    },
    scanCoverage: safeCoverageSummary(scanRun.coverageJson),
    metricsAreDescriptiveProcessIndicators: true,
    externalOutcomeActivated: false,
    realPublishEnabled: false,
    containsForumText: false
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        code:
          error instanceof Error &&
          /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
            ? error.message.toLowerCase()
            : "course_graph_status_failed",
        containsForumText: false
      })}\n`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
