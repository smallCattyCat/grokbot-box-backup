import { prisma } from "@/lib/db";
import { recordAgentRun, recordAgentRunBestEffort } from "@/lib/agents/agent-run";
import { generateJson } from "@/lib/llm/client";
import { runSafetyGateway } from "@/lib/security/safety-gateway";
import type { InterventionType } from "@/lib/types";

export type MockMultiRolePatrolMode = "dry_run" | "mock_publish";

type CompanionRoleType = Exclude<InterventionType, "mixed">;

type MockMultiRolePatrolInput = {
  mode?: MockMultiRolePatrolMode;
  maxScanPosts?: number;
  maxTurns?: number;
  minScore?: number;
  cooldownHours?: number;
  targetPostId?: string;
  useLlm?: boolean;
};

type LoadedMockPost = Awaited<ReturnType<typeof loadMockPosts>>[number];

type CandidateEvidence = {
  score: number;
  reasons: string[];
  lowLevelReplyCount: number;
  companionReplyCount: number;
  recentCompanionReplyCount: number;
  hasQuestion: boolean;
  hasResourceNeed: boolean;
  hasConfusionSignal: boolean;
  cieLevel: number | null;
  discussionPotential: number | null;
  isolatedLearnerScore: number | null;
};

type RoleDraft = {
  replyContent?: string;
  content?: string;
  rationale?: string;
};

export type MockMultiRolePatrolResult = {
  ok: boolean;
  mode: MockMultiRolePatrolMode;
  safe: true;
  scannedCount: number;
  selectedPost: null | {
    id: string;
    forumPostId: string;
    title: string;
    url: string;
    score: number;
    reasons: string[];
  };
  evaluatedPosts: Array<{
    forumPostId: string;
    title: string;
    score: number;
    reasons: string[];
  }>;
  turns: Array<{
    round: number;
    companion: string;
    roleType: CompanionRoleType;
    content: string;
    rationale: string;
    duplicateRisk: boolean;
    safety: ReturnType<typeof compactSafety>;
  }>;
  critic: {
    route: "allow" | "manual_review" | "block";
    issues: string[];
  };
  publishedCount: number;
  evidence: string[];
};

const ROLE_CATALOG: Record<CompanionRoleType, {
  forumUserId: string;
  name: string;
  focus: string;
  tone: string;
}> = {
  resource_connector: {
    forumUserId: "mock-companion-resource-connector",
    name: "连枝",
    focus: "连接课程资料、案例和相似讨论",
    tone: "清晰、克制、连接导向"
  },
  cognitive_conflict: {
    forumUserId: "mock-companion-cognitive-conflict",
    name: "问石",
    focus: "提出边界、证据和反例问题",
    tone: "温和追问、比较启发"
  },
  emotional_support: {
    forumUserId: "mock-companion-emotional-support",
    name: "暖栖",
    focus: "稳定参与意愿，把困惑拆成可继续行动的小步",
    tone: "共情、具体、不过度承诺"
  }
};

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function compactSafety(safety: ReturnType<typeof runSafetyGateway>) {
  return {
    injectionRisk: safety.injectionRisk,
    piiRisk: safety.piiRisk,
    actionRisk: safety.actionRisk,
    overallRisk: safety.overallRisk,
    route: safety.route,
    issues: safety.issues
  };
}

function compactText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function similarity(a: string, b: string): number {
  const left = new Set(compactText(a).split(""));
  const right = new Set(compactText(b).split(""));
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap += 1;
  return overlap / Math.max(left.size, right.size);
}

async function loadMockPosts(input: { maxScanPosts: number; targetPostId?: string }) {
  return prisma.forumPost.findMany({
    where: {
      url: { startsWith: "/mock-forum" },
      ...(input.targetPostId
        ? {
            OR: [
              { id: input.targetPostId },
              { forumPostId: input.targetPostId },
              { url: input.targetPostId }
            ]
          }
        : {})
    },
    include: {
      author: true,
      analysis: true,
      replies: {
        include: { author: true },
        orderBy: { createdAt: "asc" }
      }
    },
    orderBy: [
      { lastReplyAt: "desc" },
      { updatedAt: "desc" }
    ],
    take: input.maxScanPosts
  });
}

function lowLevelReply(content: string) {
  const value = compactText(content);
  if (value.length <= 12) return true;
  return /^(赞同|同感|学习了|有道理|确实|支持|谢谢|期待|很有启发)[。！!，, ]*$/.test(value);
}

function evaluateCandidate(post: LoadedMockPost, cooldownHours: number): CandidateEvidence {
  const now = Date.now();
  const text = `${post.title}\n${post.content}\n${post.replies.map((reply) => reply.content).join("\n")}`;
  const companionReplies = post.replies.filter((reply) => reply.isCompanionReply);
  const recentCompanionReplies = companionReplies.filter((reply) => now - reply.createdAt.getTime() <= cooldownHours * 3_600_000);
  const lowLevelReplyCount = post.replies.filter((reply) => lowLevelReply(reply.content)).length;
  const hasQuestion = /[？?]|如何|怎么|能否|是否|有没有|为什么|哪些|该怎么看|可行吗/.test(text);
  const hasResourceNeed = /资源|案例|文献|资料|推荐|工具|清单|路径|寻径/.test(text);
  const hasConfusionSignal = /困惑|跟不上|不知道|迷路|不确定|零散|没人回应|压力/.test(text);

  let score = 24;
  const reasons: string[] = [];
  if (post.analysis) {
    score += post.analysis.discussionPotential * 0.22;
    score += post.analysis.topicRelevance * 0.12;
    score += post.analysis.isolatedLearnerScore * 0.12;
    if (post.analysis.cieLevel >= 4) {
      score += 12;
      reasons.push("CIE 层级较高，适合引导深层讨论");
    }
    if (post.analysis.duplicateScore >= 50) {
      score += 10;
      reasons.push("浅层重复互动较多，需要打破同质回应");
    }
  }
  if (hasQuestion) {
    score += 10;
    reasons.push("帖子包含开放问题");
  }
  if (hasResourceNeed) {
    score += 8;
    reasons.push("存在资源连接需求");
  }
  if (hasConfusionSignal) {
    score += 8;
    reasons.push("存在困惑或参与支持信号");
  }
  if (lowLevelReplyCount >= 3) {
    score += 14;
    reasons.push("评论区浅层回复密集");
  }
  if (post.replyCount <= 1) {
    score += 8;
    reasons.push("互动较少，可补充启动性回应");
  }
  if (companionReplies.length === 0) {
    score += 8;
    reasons.push("尚无本地学伴介入记录");
  }
  if (recentCompanionReplies.length > 0) {
    score -= 90;
    reasons.push(`近 ${cooldownHours} 小时已有学伴介入，触发冷却`);
  }

  return {
    score: Math.round(clamp(score, 0, 100)),
    reasons: reasons.length ? reasons : ["基础热度与讨论结构达到巡检阈值"],
    lowLevelReplyCount,
    companionReplyCount: companionReplies.length,
    recentCompanionReplyCount: recentCompanionReplies.length,
    hasQuestion,
    hasResourceNeed,
    hasConfusionSignal,
    cieLevel: post.analysis?.cieLevel ?? null,
    discussionPotential: post.analysis?.discussionPotential ?? null,
    isolatedLearnerScore: post.analysis?.isolatedLearnerScore ?? null
  };
}

function chooseRoles(evidence: CandidateEvidence, maxTurns: number): CompanionRoleType[] {
  const roles: CompanionRoleType[] = [];
  if (evidence.hasResourceNeed) roles.push("resource_connector");
  if (evidence.lowLevelReplyCount >= 3 || (evidence.cieLevel ?? 0) >= 4 || evidence.hasQuestion) roles.push("cognitive_conflict");
  if (evidence.hasConfusionSignal || (evidence.isolatedLearnerScore ?? 0) >= 60) roles.push("emotional_support");

  for (const role of ["cognitive_conflict", "resource_connector", "emotional_support"] as const) {
    if (!roles.includes(role)) roles.push(role);
  }
  return roles.slice(0, maxTurns);
}

function fallbackDraft(roleType: CompanionRoleType, post: LoadedMockPost, evidence: CandidateEvidence) {
  if (roleType === "resource_connector") {
    return `我会期待把“${post.title}”里提到的问题整理成资源线索：先找一个课程案例，再标出可复用的方法和限制。这样后续同学补充资料时，也能更容易接上已有讨论。`;
  }
  if (roleType === "emotional_support") {
    return evidence.hasConfusionSignal
      ? "这个困惑挺真实的，不一定要一次把所有概念都理顺。可以先抓住一个最想解释的场景，再回看哪些概念能帮助说明它，这样继续讨论会轻一些。"
      : "这个主题值得继续等更多同学加入。先把一个具体场景说清楚，再慢慢比较不同观点，可能比直接追求完整结论更有收获。";
  }
  return "我也期待这个问题继续展开，不过想追问一个边界：如果只看互动数量，是否会高估学习深度？哪些证据能说明讨论真的推动了理解，而不只是表达了赞同？";
}

async function draftRoleReply(input: {
  roleType: CompanionRoleType;
  post: LoadedMockPost;
  evidence: CandidateEvidence;
  previousReplies: string[];
  useLlm: boolean;
}) {
  const fallback = fallbackDraft(input.roleType, input.post, input.evidence);
  const role = ROLE_CATALOG[input.roleType];
  if (!input.useLlm) {
    return {
      content: fallback,
      rationale: `快速模式：按 ${role.name} 的 ${role.focus} 角色使用本地模板。`
    };
  }
  const raw = await generateJson<RoleDraft>({
    schemaName: "MockMultiRoleReply",
    temperature: 0.48,
    system: `你是 cMOOC 模拟论坛中的智能学伴角色。必须只输出 JSON。
要求：中文，50-140 字；表达对主题的期待、补充问题或资源方向；不冒充真人；不直接给作业答案；不重复前序回复。
当前角色：${role.name}，关注点：${role.focus}，语气：${role.tone}。`,
    user: JSON.stringify({
      roleType: input.roleType,
      post: {
        title: input.post.title,
        content: input.post.content,
        authorState: input.post.author.emotionalState,
        recentReplies: input.post.replies.slice(-6).map((reply) => reply.content)
      },
      evidence: input.evidence,
      previousReplies: input.previousReplies,
      expectedJson: { replyContent: "string", rationale: "string" }
    }, null, 2)
  });
  const content = compactText(raw.replyContent || raw.content || fallback) || fallback;
  return {
    content,
    rationale: raw.rationale || `按 ${role.name} 的 ${role.focus} 角色生成。`
  };
}

async function ensureCompanionUsers() {
  const rows = await Promise.all((Object.entries(ROLE_CATALOG) as Array<[CompanionRoleType, typeof ROLE_CATALOG[CompanionRoleType]]>).map(([type, role]) =>
    prisma.forumUser.upsert({
      where: { forumUserId: role.forumUserId },
      update: {
        name: role.name,
        role: "companion",
        tagsJson: JSON.stringify(["智能学伴", "模拟论坛", type]),
        activityLevel: 70,
        emotionalState: "stable",
        centralityScore: 0.64,
        lastActiveAt: new Date()
      },
      create: {
        forumUserId: role.forumUserId,
        name: role.name,
        role: "companion",
        tagsJson: JSON.stringify(["智能学伴", "模拟论坛", type]),
        activityLevel: 70,
        emotionalState: "stable",
        centralityScore: 0.64,
        lastActiveAt: new Date()
      }
    })
  ));
  return new Map(rows.map((row) => [row.forumUserId, row]));
}

function forumText(post: LoadedMockPost) {
  return `${post.title}\n${post.content}\n${post.replies.map((reply) => reply.content).join("\n")}`;
}

export async function runMockMultiRolePatrol(input: MockMultiRolePatrolInput = {}): Promise<MockMultiRolePatrolResult> {
  const mode = input.mode === "mock_publish" ? "mock_publish" : "dry_run";
  const maxScanPosts = Math.trunc(clamp(input.maxScanPosts ?? 12, 1, 50));
  const maxTurns = Math.trunc(clamp(input.maxTurns ?? 3, 1, 3));
  const minScore = clamp(input.minScore ?? 65, 0, 100);
  const cooldownHours = Math.trunc(clamp(input.cooldownHours ?? 24, 1, 24 * 7));
  const useLlm = input.useLlm !== false;
  const startedAt = new Date();
  const posts = await loadMockPosts({ maxScanPosts, targetPostId: input.targetPostId });
  const evaluated = posts
    .map((post) => ({ post, evidence: evaluateCandidate(post, cooldownHours) }))
    .sort((left, right) => right.evidence.score - left.evidence.score);
  const selected = evaluated.find((item) =>
    item.evidence.recentCompanionReplyCount === 0 && (item.evidence.score >= minScore || Boolean(input.targetPostId))
  ) ?? null;

  const baseResult = {
    ok: Boolean(selected),
    mode,
    safe: true as const,
    scannedCount: posts.length,
    selectedPost: selected
      ? {
          id: selected.post.id,
          forumPostId: selected.post.forumPostId,
          title: selected.post.title,
          url: selected.post.url,
          score: selected.evidence.score,
          reasons: selected.evidence.reasons
        }
      : null,
    evaluatedPosts: evaluated.slice(0, 8).map((item) => ({
      forumPostId: item.post.forumPostId,
      title: item.post.title,
      score: item.evidence.score,
      reasons: item.evidence.reasons
    })),
    turns: [],
    critic: {
      route: selected ? "allow" as const : "manual_review" as const,
      issues: selected ? [] : ["未找到达到阈值且不在冷却期的模拟论坛帖子"]
    },
    publishedCount: 0,
    evidence: [] as string[]
  } satisfies MockMultiRolePatrolResult;

  if (!selected) {
    await recordAgentRun({
      agentName: "mock-multi-role-planner-agent",
      input: { mode, maxScanPosts, maxTurns, minScore, cooldownHours, targetPostId: input.targetPostId ?? null, useLlm },
      output: baseResult,
      startedAt
    });
    return baseResult;
  }

  const roles = chooseRoles(selected.evidence, maxTurns);
  const previousReplies: string[] = [];
  const existingCompanionReplies = selected.post.replies
    .filter((reply) => reply.isCompanionReply)
    .map((reply) => reply.content);
  const turns: MockMultiRolePatrolResult["turns"] = [];

  for (const [index, roleType] of roles.entries()) {
    const draft = await draftRoleReply({
      roleType,
      post: selected.post,
      evidence: selected.evidence,
      previousReplies,
      useLlm
    });
    const duplicateRisk = [...existingCompanionReplies, ...previousReplies].some((reply) => similarity(reply, draft.content) > 0.82);
    const safety = runSafetyGateway({
      forumText: forumText(selected.post),
      proposedReply: draft.content,
      action: { targetMode: "post_comment", targetCommentIndex: null, publishEnabled: mode === "mock_publish" }
    });
    turns.push({
      round: index + 1,
      companion: ROLE_CATALOG[roleType].name,
      roleType,
      content: draft.content,
      rationale: draft.rationale,
      duplicateRisk,
      safety: compactSafety(safety)
    });
    previousReplies.push(draft.content);
  }

  const issues = [
    ...turns.flatMap((turn) => turn.safety.route === "allow" ? [] : [`第 ${turn.round} 轮安全网关为 ${turn.safety.route}`]),
    ...turns.flatMap((turn) => turn.duplicateRisk ? [`第 ${turn.round} 轮与近期学伴回复过于相似`] : [])
  ];
  const criticRoute: MockMultiRolePatrolResult["critic"]["route"] = issues.some((issue) => issue.includes("block"))
    ? "block"
    : issues.length
      ? "manual_review"
      : "allow";

  await recordAgentRun({
    postId: selected.post.id,
    agentName: "mock-multi-role-planner-agent",
    input: { mode, maxScanPosts, maxTurns, minScore, cooldownHours, targetPostId: input.targetPostId ?? null, useLlm },
    output: {
      selectedPost: baseResult.selectedPost,
      evaluatedPosts: baseResult.evaluatedPosts,
      roleSequence: roles,
      turns
    },
    startedAt
  });
  await recordAgentRun({
    postId: selected.post.id,
    agentName: "mock-multi-role-critic-agent",
    input: {
      selectedPost: baseResult.selectedPost,
      mode,
      turnCount: turns.length
    },
    output: {
      route: criticRoute,
      issues,
      safetyRoutes: turns.map((turn) => turn.safety.route),
      duplicateRiskCount: turns.filter((turn) => turn.duplicateRisk).length
    },
    status: criticRoute === "block" ? "failed" : "success"
  });

  if (mode === "dry_run" || criticRoute !== "allow") {
    return {
      ...baseResult,
      turns,
      critic: { route: criticRoute, issues },
      evidence: [`agent-run:mock-multi-role-planner-agent:${selected.post.forumPostId}`, `agent-run:mock-multi-role-critic-agent:${criticRoute}`]
    };
  }

  const usersByForumId = await ensureCompanionUsers();
  const publishedReplyIds: string[] = [];
  for (const turn of turns) {
    const role = ROLE_CATALOG[turn.roleType];
    const companion = usersByForumId.get(role.forumUserId);
    if (!companion) throw new Error(`缺少模拟学伴用户：${role.forumUserId}`);
    const reply = await prisma.forumReply.create({
      data: {
        forumReplyId: `mock-multi-${selected.post.forumPostId}-${turn.round}-${Date.now()}`,
        sourceKind: "companion",
        postId: selected.post.id,
        authorId: companion.id,
        content: turn.content,
        isCompanionReply: true,
        companionType: turn.roleType
      }
    });
    publishedReplyIds.push(reply.id);
  }
  await prisma.forumPost.update({
    where: { id: selected.post.id },
    data: {
      replyCount: { increment: turns.length },
      lastReplyAt: new Date()
    }
  });
  await recordAgentRunBestEffort({
    postId: selected.post.id,
    agentName: "mock-multi-role-publish-agent",
    input: { mode, postId: selected.post.id, turnCount: turns.length },
    output: {
      publishedReplyIds,
      roleSequence: turns.map((turn) => turn.roleType),
      targetUrl: selected.post.url,
      transport: "local-mock-db"
    }
  });

  return {
    ...baseResult,
    turns,
    critic: { route: criticRoute, issues },
    publishedCount: publishedReplyIds.length,
    evidence: [
      `mock-forum:${selected.post.forumPostId}:replies+${publishedReplyIds.length}`,
      "agent-run:mock-multi-role-publish-agent"
    ]
  };
}
