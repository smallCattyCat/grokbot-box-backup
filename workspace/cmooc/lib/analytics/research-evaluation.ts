import { prisma } from "@/lib/db";
import { classifyCieText } from "@/lib/agents/research-algorithms";
import { graphWaveletSnapshot } from "@/lib/analytics/graph-wavelet";
import { cohenKappa, differenceInDifferences, mean, round, safeDivide } from "./statistics";

type Edge = { from: string; to: string; weight: number; createdAt: Date };
type UserPeriodOutcome = { participation: number; avgCie: number; highCieCount: number };

function pushMapValue<T>(map: Map<string, T[]>, key: string, value: T) {
  const items = map.get(key);
  if (items) {
    items.push(value);
  } else {
    map.set(key, [value]);
  }
}

function incrementMap(map: Map<string, number>, key: string, value = 1) {
  map.set(key, (map.get(key) || 0) + value);
}

function buildAdjacency(users: string[], edges: Edge[]) {
  const adjacency = new Map<string, Set<string>>(users.map((id) => [id, new Set<string>()]));
  for (const edge of edges) {
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }
  return adjacency;
}

function buildDirectedWeights(users: string[], edges: Edge[]) {
  const inDegree = Object.fromEntries(users.map((id) => [id, 0]));
  const outDegree = Object.fromEntries(users.map((id) => [id, 0]));
  const weightedInDegree = Object.fromEntries(users.map((id) => [id, 0]));
  const weightedOutDegree = Object.fromEntries(users.map((id) => [id, 0]));
  for (const edge of edges) {
    outDegree[edge.from] += 1;
    inDegree[edge.to] += 1;
    weightedOutDegree[edge.from] += edge.weight;
    weightedInDegree[edge.to] += edge.weight;
  }
  return { inDegree, outDegree, weightedInDegree, weightedOutDegree };
}

function pageRank(users: string[], edges: Edge[], damping = 0.85) {
  let ranks = Object.fromEntries(users.map((id) => [id, safeDivide(1, users.length || 1)]));
  const outWeight = Object.fromEntries(users.map((id) => [id, 0]));
  for (const edge of edges) outWeight[edge.from] += edge.weight;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const next = Object.fromEntries(users.map((id) => [id, safeDivide(1 - damping, users.length || 1)]));
    for (const edge of edges) {
      next[edge.to] += damping * ranks[edge.from] * safeDivide(edge.weight, outWeight[edge.from] || 1);
    }
    ranks = next;
  }
  return Object.fromEntries(users.map((id) => [id, round(ranks[id], 4)]));
}

function clustering(users: string[], adjacency: Map<string, Set<string>>) {
  return Object.fromEntries(users.map((id) => {
    const neighbors = [...(adjacency.get(id) || [])];
    if (neighbors.length < 2) return [id, 0];
    let links = 0;
    for (let i = 0; i < neighbors.length; i += 1) {
      for (let j = i + 1; j < neighbors.length; j += 1) {
        if (adjacency.get(neighbors[i])?.has(neighbors[j])) links += 1;
      }
    }
    return [id, round(safeDivide(2 * links, neighbors.length * (neighbors.length - 1)), 3)];
  }));
}

function shortestDistances(start: string, adjacency: Map<string, Set<string>>) {
  const distances = new Map<string, number>([[start, 0]]);
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const next of adjacency.get(current) || []) {
      if (distances.has(next)) continue;
      distances.set(next, (distances.get(current) || 0) + 1);
      queue.push(next);
    }
  }
  return distances;
}

function closeness(users: string[], adjacency: Map<string, Set<string>>) {
  return Object.fromEntries(users.map((id) => {
    const distances = shortestDistances(id, adjacency);
    const total = [...distances.values()].reduce((sum, value) => sum + value, 0);
    return [id, total > 0 ? round((distances.size - 1) / total, 3) : 0];
  }));
}

function betweenness(users: string[], adjacency: Map<string, Set<string>>) {
  const score = Object.fromEntries(users.map((id) => [id, 0]));
  for (const source of users) {
    const stack: string[] = [];
    const predecessors = new Map<string, string[]>(users.map((id) => [id, []]));
    const sigma = Object.fromEntries(users.map((id) => [id, 0]));
    const distance = Object.fromEntries(users.map((id) => [id, -1]));
    sigma[source] = 1;
    distance[source] = 0;
    const queue = [source];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      stack.push(current);
      for (const neighbor of adjacency.get(current) || []) {
        if (distance[neighbor] < 0) {
          queue.push(neighbor);
          distance[neighbor] = distance[current] + 1;
        }
        if (distance[neighbor] === distance[current] + 1) {
          sigma[neighbor] += sigma[current];
          predecessors.get(neighbor)?.push(current);
        }
      }
    }
    const dependency = Object.fromEntries(users.map((id) => [id, 0]));
    while (stack.length) {
      const node = stack.pop() as string;
      for (const predecessor of predecessors.get(node) || []) {
        dependency[predecessor] += (sigma[predecessor] / Math.max(sigma[node], 1)) * (1 + dependency[node]);
      }
      if (node !== source) score[node] += dependency[node];
    }
  }
  const normalizer = users.length > 2 ? (users.length - 1) * (users.length - 2) : 1;
  return Object.fromEntries(users.map((id) => [id, round(score[id] / normalizer, 3)]));
}

function eigenvector(users: string[], adjacency: Map<string, Set<string>>) {
  let values = Object.fromEntries(users.map((id) => [id, 1 / Math.max(users.length, 1)]));
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const next = Object.fromEntries(users.map((id) => [id, [...(adjacency.get(id) || [])].reduce((sum, neighbor) => sum + values[neighbor], 0)]));
    const norm = Math.sqrt(Object.values(next).reduce((sum, value) => sum + value ** 2, 0)) || 1;
    values = Object.fromEntries(users.map((id) => [id, next[id] / norm]));
  }
  return Object.fromEntries(users.map((id) => [id, round(values[id], 3)]));
}

function kCore(users: string[], adjacency: Map<string, Set<string>>) {
  const core = Object.fromEntries(users.map((id) => [id, 0]));
  for (let k = 1; k <= users.length; k += 1) {
    const remaining = new Set(users);
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...remaining]) {
        const degree = [...(adjacency.get(id) || [])].filter((neighbor) => remaining.has(neighbor)).length;
        if (degree < k) {
          remaining.delete(id);
          changed = true;
        }
      }
    }
    for (const id of remaining) core[id] = k;
  }
  return core;
}

export async function buildResearchEvaluationSnapshot(options: { postIds?: string[] } = {}) {
  const scopedPostIds = Array.from(new Set(options.postIds || [])).filter(Boolean);
  const postWhere = scopedPostIds.length > 0 ? { id: { in: scopedPostIds } } : undefined;
  const [posts, replies, candidates, unscopedUsers] = await Promise.all([
    prisma.forumPost.findMany({ where: postWhere, include: { analysis: true } }),
    prisma.forumReply.findMany({ where: postWhere ? { postId: { in: scopedPostIds } } : undefined, include: { post: true } }),
    prisma.autoInterventionCandidate.findMany({ where: postWhere ? { postId: { in: scopedPostIds } } : undefined }),
    scopedPostIds.length > 0 ? Promise.resolve([]) : prisma.forumUser.findMany()
  ]);
  const scopedUserIds = new Set<string>();
  if (scopedPostIds.length > 0) {
    for (const post of posts) scopedUserIds.add(post.authorId);
    for (const reply of replies) {
      scopedUserIds.add(reply.authorId);
      if (reply.targetUserId) scopedUserIds.add(reply.targetUserId);
      scopedUserIds.add(reply.post.authorId);
    }
  }
  const users = scopedPostIds.length > 0
    ? await prisma.forumUser.findMany({ where: { id: { in: [...scopedUserIds] } } })
    : unscopedUsers;
  const userIds = users.map((user) => user.id);
  const userById = new Map(users.map((user) => [user.id, user]));
  const postById = new Map(posts.map((post) => [post.id, post]));
  const postsByAuthor = new Map<string, typeof posts>();
  const repliesByAuthor = new Map<string, typeof replies>();
  const candidatesByPost = new Map<string, typeof candidates>();
  const candidateMaxCieByPost = new Map<string, number>();
  const candidateCountByAuthor = new Map<string, number>();
  const attentionCandidateCountByAuthor = new Map<string, number>();
  const cieByAuthor = new Map<string, number[]>();

  for (const post of posts) pushMapValue(postsByAuthor, post.authorId, post);
  for (const reply of replies) pushMapValue(repliesByAuthor, reply.authorId, reply);
  for (const candidate of candidates) {
    pushMapValue(candidatesByPost, candidate.postId, candidate);
    candidateMaxCieByPost.set(candidate.postId, Math.max(candidateMaxCieByPost.get(candidate.postId) || 0, candidate.cieLevel || 0));
    const authorId = postById.get(candidate.postId)?.authorId;
    if (!authorId) continue;
    incrementMap(candidateCountByAuthor, authorId);
    if (["manual_review", "dry_run_ready", "published"].includes(candidate.status)) incrementMap(attentionCandidateCountByAuthor, authorId);
    pushMapValue(cieByAuthor, authorId, candidate.cieLevel || 0);
  }

  const userIdSet = new Set(userIds);
  const replyEdges = replies.map((reply) => {
    const targetUserId = reply.targetUserId || reply.post.authorId;
    const depth = Math.max(0, Number(reply.depth ?? 0));
    return {
      edge: {
        from: reply.authorId,
        to: targetUserId,
        weight: reply.isCompanionReply ? 0.8 : depth > 0 ? 1.1 : 1,
        createdAt: reply.createdAt
      },
      depth
    };
  });
  const validReplyEdges = replyEdges.filter(({ edge }) => edge.from !== edge.to && userIdSet.has(edge.from) && userIdSet.has(edge.to));
  const edges: Edge[] = validReplyEdges.map(({ edge }) => edge);
  const nestedReplyEdgeCount = validReplyEdges.filter(({ depth }) => depth > 0).length;
  const postReplyEdgeCount = validReplyEdges.filter(({ depth }) => depth === 0).length;
  const adjacency = buildAdjacency(userIds, edges);
  const directed = buildDirectedWeights(userIds, edges);
  const directedKeys = new Set(edges.map((edge) => `${edge.from}->${edge.to}`));
  const undirectedKeys = new Set(edges.map((edge) => [edge.from, edge.to].sort().join("<->")));
  const possibleDirected = userIds.length * Math.max(userIds.length - 1, 1);
  const reciprocalPairs = [...undirectedKeys].filter((key) => {
    const [a, b] = key.split("<->");
    return directedKeys.has(`${a}->${b}`) && directedKeys.has(`${b}->${a}`);
  }).length;
  const degree = Object.fromEntries(userIds.map((id) => [id, adjacency.get(id)?.size || 0]));
  const centrality = {
    degree,
    inDegree: directed.inDegree,
    outDegree: directed.outDegree,
    weightedInDegree: Object.fromEntries(userIds.map((id) => [id, round(directed.weightedInDegree[id], 2)])),
    weightedOutDegree: Object.fromEntries(userIds.map((id) => [id, round(directed.weightedOutDegree[id], 2)])),
    closeness: closeness(userIds, adjacency),
    betweenness: betweenness(userIds, adjacency),
    eigenvector: eigenvector(userIds, adjacency),
    pageRank: pageRank(userIds, edges),
    clustering: clustering(userIds, adjacency),
    kCore: kCore(userIds, adjacency)
  };
  const topUsers = userIds
    .map((id) => {
      const user = userById.get(id);
      return {
        id,
        name: user?.name || id,
        role: user?.role || "unknown",
        degree: degree[id],
        inDegree: directed.inDegree[id],
        outDegree: directed.outDegree[id],
        betweenness: centrality.betweenness[id],
        pageRank: centrality.pageRank[id],
        eigenvector: centrality.eigenvector[id],
        kCore: centrality.kCore[id]
      };
    })
    .sort((a, b) => b.betweenness - a.betweenness || b.degree - a.degree)
    .slice(0, 5);

  const graphWavelet = graphWaveletSnapshot(
    userIds.map((id) => {
      const user = userById.get(id);
      const avgCie = mean(cieByAuthor.get(id) || []);
      const authorPostCount = postsByAuthor.get(id)?.length || 0;
      const authorReplyCount = repliesByAuthor.get(id)?.length || 0;
      const isolationNeed = degree[id] === 0 && authorPostCount > 0 ? 1 : safeDivide(1, 1 + degree[id]);
      return {
        id,
        label: user?.name || id,
        signal: round(
          (candidateCountByAuthor.get(id) || 0) * 1.6 +
          (attentionCandidateCountByAuthor.get(id) || 0) * 1.2 +
          avgCie * 0.65 +
          isolationNeed * 0.8 +
          authorPostCount * 0.25 +
          authorReplyCount * 0.1,
          4
        )
      };
    }),
    edges
  );

  const grouped = users.reduce<Record<string, typeof users>>((acc, user) => {
    const group = user.role || "learner";
    acc[group] ||= [];
    acc[group].push(user);
    return acc;
  }, {});
  const experiment = Object.fromEntries(Object.entries(grouped).map(([group, members]) => {
    const ids = new Set(members.map((member) => member.id));
    const groupPosts = [...ids].flatMap((id) => postsByAuthor.get(id) || []);
    const groupReplies = [...ids].flatMap((id) => repliesByAuthor.get(id) || []);
    const groupCandidates = groupPosts.flatMap((post) => candidatesByPost.get(post.id) || []);
    const cieValues = groupPosts.map((post) => post.analysis?.cieLevel || candidateMaxCieByPost.get(post.id) || 0);
    const avgCie = mean(cieValues);
    return [group, {
      learners: members.length,
      posts: groupPosts.length,
      replies: groupReplies.length,
      avgCie: round(avgCie, 2),
      highCieRatio: round(cieValues.filter((value) => value >= 5).length / Math.max(cieValues.length, 1), 3),
      candidateCount: groupCandidates.length,
      publishedCount: groupCandidates.filter((candidate) => candidate.status === "published").length
    }];
  }));
  const temporalWindows = [7, 14, 30].map((days) => {
    const since = Date.now() - days * 86_400_000;
    const windowEdges = edges.filter((edge) => edge.createdAt.getTime() >= since);
    const windowDirected = new Set(windowEdges.map((edge) => `${edge.from}->${edge.to}`));
    const windowUndirected = new Set(windowEdges.map((edge) => [edge.from, edge.to].sort().join("<->")));
    return {
      days,
      edgeCount: windowDirected.size,
      density: round(safeDivide(windowDirected.size, possibleDirected), 3),
      reciprocity: round(safeDivide([...windowUndirected].filter((key) => {
        const [a, b] = key.split("<->");
        return windowDirected.has(`${a}->${b}`) && windowDirected.has(`${b}->${a}`);
      }).length, windowUndirected.size), 3)
    };
  });

  const codingPairs = candidates.map((candidate) => {
    let parsed: { cieLevel?: number; cieConfidence?: number; needsHumanReview?: boolean } = {};
    let raw: { title?: string; content?: string; comments?: Array<{ content?: string }> } = {};
    try {
      parsed = candidate.valueAnalysisJson ? JSON.parse(candidate.valueAnalysisJson) : {};
    } catch {
      parsed = {};
    }
    try {
      raw = candidate.rawExtractJson ? JSON.parse(candidate.rawExtractJson) : {};
    } catch {
      raw = {};
    }
    const recoded = classifyCieText([
      raw.title || candidate.postTitle,
      raw.content || "",
      ...(raw.comments || []).map((comment) => comment.content || "")
    ].join("\n"));
    return {
      a: candidate.cieLevel,
      b: recoded.cieLevel,
      confidence: Number(parsed.cieConfidence || recoded.confidence || 0),
      needsHumanReview: Boolean(parsed.needsHumanReview || recoded.needsHumanReview),
      candidateId: candidate.id,
      postTitle: candidate.postTitle,
      storedLabel: candidate.cieLevel,
      recodedLabel: recoded.cieLevel,
      recodedReason: recoded.reason
    };
  });
  const codingReliability = {
    method: "stored candidate label vs independent text recode",
    machineAgreement: cohenKappa(codingPairs.map((pair) => ({ a: pair.a, b: pair.b })), [0, 1, 2, 3, 4, 5, 6, 7, 8]),
    lowConfidenceCount: codingPairs.filter((pair) => pair.confidence > 0 && pair.confidence < 0.6).length,
    humanReviewRecommendedCount: codingPairs.filter((pair) => pair.needsHumanReview || (pair.confidence > 0 && pair.confidence < 0.6)).length,
    disagreementSamples: codingPairs
      .filter((pair) => pair.storedLabel !== pair.recodedLabel)
      .slice(0, 5)
      .map((pair) => ({
        candidateId: pair.candidateId,
        title: pair.postTitle,
        storedLabel: pair.storedLabel,
        recodedLabel: pair.recodedLabel,
        reason: pair.recodedReason
      }))
  };

  const exposureCandidates = candidates.filter((candidate) => ["published", "dry_run_ready"].includes(candidate.status));
  const cutoffTime = exposureCandidates.length
    ? Math.min(...exposureCandidates.map((candidate) => candidate.updatedAt.getTime()))
    : Date.now();
  const cutoff = new Date(cutoffTime);
  const treatmentUserIds = new Set(exposureCandidates.map((candidate) => postById.get(candidate.postId)?.authorId).filter(Boolean) as string[]);
  const learnerIds = users.filter((user) => user.role !== "companion").map((user) => user.id);
  const controlUserIds = new Set(learnerIds.filter((id) => !treatmentUserIds.has(id)));
  const outcomeCache = new Map<string, UserPeriodOutcome>();
  const userPeriodOutcome = (userId: string, period: "pre" | "post"): UserPeriodOutcome => {
    const cacheKey = `${userId}:${period}`;
    const cached = outcomeCache.get(cacheKey);
    if (cached) return cached;
    const isPostPeriod = period === "post";
    const userPosts = (postsByAuthor.get(userId) || []).filter((post) => (post.createdAt.getTime() >= cutoffTime) === isPostPeriod);
    const userReplies = (repliesByAuthor.get(userId) || []).filter((reply) => (reply.createdAt.getTime() >= cutoffTime) === isPostPeriod);
    const cieValues = userPosts.map((post) => post.analysis?.cieLevel || candidateMaxCieByPost.get(post.id) || 0).filter((value) => value > 0);
    const outcome = {
      participation: userPosts.length + userReplies.length,
      avgCie: mean(cieValues),
      highCieCount: cieValues.filter((value) => value >= 5).length
    };
    outcomeCache.set(cacheKey, outcome);
    return outcome;
  };
  const collectOutcome = (ids: Set<string>, period: "pre" | "post", key: "participation" | "avgCie" | "highCieCount") =>
    [...ids].map((id) => userPeriodOutcome(id, period)[key]);
  const quasiExperiment = {
    method: "observational difference-in-differences scaffold",
    cutoff: cutoff.toISOString(),
    treatmentUsers: treatmentUserIds.size,
    controlUsers: controlUserIds.size,
    exposureCount: exposureCandidates.length,
    outcomes: {
      participation: differenceInDifferences({
        treatmentPre: collectOutcome(treatmentUserIds, "pre", "participation"),
        treatmentPost: collectOutcome(treatmentUserIds, "post", "participation"),
        controlPre: collectOutcome(controlUserIds, "pre", "participation"),
        controlPost: collectOutcome(controlUserIds, "post", "participation")
      }),
      avgCie: differenceInDifferences({
        treatmentPre: collectOutcome(treatmentUserIds, "pre", "avgCie"),
        treatmentPost: collectOutcome(treatmentUserIds, "post", "avgCie"),
        controlPre: collectOutcome(controlUserIds, "pre", "avgCie"),
        controlPost: collectOutcome(controlUserIds, "post", "avgCie")
      }),
      highCieCount: differenceInDifferences({
        treatmentPre: collectOutcome(treatmentUserIds, "pre", "highCieCount"),
        treatmentPost: collectOutcome(treatmentUserIds, "post", "highCieCount"),
        controlPre: collectOutcome(controlUserIds, "pre", "highCieCount"),
        controlPost: collectOutcome(controlUserIds, "post", "highCieCount")
      })
    },
    validityNotes: [
      treatmentUserIds.size < 3 || controlUserIds.size < 3 ? "样本量不足，当前只能作为演示级趋势监测。" : "",
      exposureCandidates.some((candidate) => candidate.status === "dry_run_ready") ? "包含 dry_run_ready 作为计划暴露，正式研究需只使用真实干预或明确分组。" : ""
    ].filter(Boolean)
  };

  return {
    socialNetwork: {
      edgeModel: "reply_author_to_target_user_with_post_author_fallback",
      nodeCount: userIds.length,
      edgeCount: directedKeys.size,
      rawReplyEdgeCount: edges.length,
      postReplyEdgeCount,
      nestedReplyEdgeCount,
      density: round(directedKeys.size / Math.max(possibleDirected, 1), 3),
      reciprocity: round(reciprocalPairs / Math.max(undirectedKeys.size, 1), 3),
      averageDegree: round(Object.values(degree).reduce((sum, value) => sum + value, 0) / Math.max(userIds.length, 1), 2),
      averageClustering: round(mean(Object.values(centrality.clustering)), 3),
      temporalWindows,
      topUsers,
      graphWavelet,
      centrality
    },
    experiment,
    codingReliability,
    quasiExperiment
  };
}
