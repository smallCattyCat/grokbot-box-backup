import { recordAgentRunBestEffort } from "@/lib/agents/agent-run";
import { prisma } from "@/lib/db";
import { buildResearchEvaluationSnapshot } from "@/lib/analytics/research-evaluation";
import { round } from "@/lib/analytics/statistics";
import { resolveCourseScope } from "@/lib/forum/course-scope";

function normalize(values: Record<string, number>) {
  const max = Math.max(...Object.values(values), 0);
  if (max <= 0) return Object.fromEntries(Object.keys(values).map((id) => [id, 0]));
  return Object.fromEntries(Object.entries(values).map(([id, value]) => [id, value / max]));
}

async function resolveSnaScope(input: { runId?: string; courseId?: string; platformCourseId?: string } = {}) {
  const requestedCourse = input.courseId || input.platformCourseId
    ? await resolveCourseScope({ courseId: input.courseId, platformCourseId: input.platformCourseId })
    : null;
  const run = input.runId
    ? await prisma.forumIngestionRun.findUnique({
      where: { id: input.runId },
      include: { course: true, postSnapshots: { select: { postId: true } } }
    })
    : await prisma.forumIngestionRun.findFirst({
      where: { status: "completed", ...(requestedCourse ? { courseId: requestedCourse.id } : {}) },
      orderBy: { createdAt: "desc" },
      include: { course: true, postSnapshots: { select: { postId: true } } }
    });
  if (input.runId && !run) throw new Error(`找不到论坛采集批次：${input.runId}`);
  const course = run?.course ?? requestedCourse;
  const postIds = Array.from(new Set(
    run?.postSnapshots.map((snapshot) => snapshot.postId)
    || (course ? (await prisma.forumPost.findMany({ where: { courseId: course.id }, select: { id: true } })).map((post) => post.id) : [])
  ));
  return {
    type: run ? "forum_ingestion_run" : course ? "course_local_forum_data" : "all_local_forum_data",
    runId: run?.id ?? null,
    sourceUrl: run?.sourceUrl ?? null,
    course: course ? { id: course.id, platformCourseId: course.platformCourseId, name: course.name } : null,
    postCount: postIds.length,
    postIds
  };
}

export async function syncSocialNetworkMetrics(input: { runId?: string; courseId?: string; platformCourseId?: string } = {}) {
  const startedAt = new Date();
  const scope = await resolveSnaScope(input);
  const snapshot = await buildResearchEvaluationSnapshot(scope.postIds.length > 0 ? { postIds: scope.postIds } : {});
  const centrality = snapshot.socialNetwork.centrality;
  const ids = Object.keys(centrality.pageRank);
  const normalized = {
    pageRank: normalize(centrality.pageRank),
    degree: normalize(centrality.degree),
    eigenvector: normalize(centrality.eigenvector),
    kCore: normalize(centrality.kCore)
  };
  const scores = Object.fromEntries(ids.map((id) => {
    const score = round(
      normalized.pageRank[id] * 0.4 +
        normalized.degree[id] * 0.25 +
        normalized.eigenvector[id] * 0.2 +
        normalized.kCore[id] * 0.15,
      4
    );
    return [id, score];
  }));

  const users = await prisma.forumUser.findMany({
    where: { id: { in: ids } },
    select: { id: true, forumUserId: true, name: true, role: true }
  });
  const userById = new Map(users.map((user) => [user.id, user]));
  for (const id of ids) {
    await prisma.forumUser.update({
      where: { id },
      data: { centralityScore: scores[id] ?? 0 }
    });
    if (scope.course) {
      await prisma.courseMembership.upsert({
        where: { courseId_userId: { courseId: scope.course.id, userId: id } },
        create: {
          courseId: scope.course.id,
          userId: id,
          forumUserId: userById.get(id)?.forumUserId ?? id,
          displayName: userById.get(id)?.name ?? id,
          roleInCourse: userById.get(id)?.role ?? "learner",
          centralityScore: scores[id] ?? 0,
          tagsJson: "[]",
          evidenceJson: JSON.stringify({ source: "social-network-sync-agent" }, null, 2)
        },
        update: { centralityScore: scores[id] ?? 0 }
      });
    }
  }

  const topUsers = ids.map((id) => ({
    id,
    name: userById.get(id)?.name ?? id,
    role: userById.get(id)?.role ?? "unknown",
    centralityScore: scores[id] ?? 0,
    degree: centrality.degree[id] ?? 0,
    inDegree: centrality.inDegree[id] ?? 0,
    outDegree: centrality.outDegree[id] ?? 0,
    pageRank: centrality.pageRank[id] ?? 0,
    eigenvector: centrality.eigenvector[id] ?? 0,
    kCore: centrality.kCore[id] ?? 0
  }))
    .sort((left, right) => right.centralityScore - left.centralityScore)
    .slice(0, 5);
  const result = {
    scope,
    nodeCount: snapshot.socialNetwork.nodeCount,
    edgeModel: snapshot.socialNetwork.edgeModel,
    edgeCount: snapshot.socialNetwork.edgeCount,
    rawReplyEdgeCount: snapshot.socialNetwork.rawReplyEdgeCount,
    postReplyEdgeCount: snapshot.socialNetwork.postReplyEdgeCount,
    nestedReplyEdgeCount: snapshot.socialNetwork.nestedReplyEdgeCount,
    density: snapshot.socialNetwork.density,
    reciprocity: snapshot.socialNetwork.reciprocity,
    averageClustering: snapshot.socialNetwork.averageClustering,
    updatedUserCount: ids.length,
    topUsers
  };

  await recordAgentRunBestEffort({
    agentName: "social-network-sync-agent",
    startedAt,
    input: {
      scope,
      scoreFormula: "0.40*PageRank + 0.25*degree + 0.20*eigenvector + 0.15*k-core, all normalized",
      edgeModel: snapshot.socialNetwork.edgeModel
    },
    output: result
  });

  return result;
}
