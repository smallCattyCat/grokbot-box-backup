import { cieLabels } from "@/lib/labels";
import type { InteractionSignal, InterventionType, MentalState } from "@/lib/types";

type ReplyLike = {
  content: string;
  createdAt?: Date;
  isCompanionReply?: boolean;
};

type PostLike = {
  title: string;
  content: string;
  replyCount: number;
  likeCount: number;
  viewCount: number;
  createdAt: Date;
  replies: ReplyLike[];
  author?: { centralityScore?: number };
};

type WaveletFilter = {
  name: string;
  decLo: number[];
  decHi: number[];
};

type KnowledgeConstructionRule = {
  level: number;
  iamPhase: number;
  words: string[];
  weight: number;
  reason: string;
};

const waveletFilters: Record<string, WaveletFilter> = {
  haar: {
    name: "haar",
    decLo: [Math.SQRT1_2, Math.SQRT1_2],
    decHi: [-Math.SQRT1_2, Math.SQRT1_2]
  },
  db4: {
    name: "db4",
    decLo: [
      -0.010597401785069032,
      0.0328830116668852,
      0.030841381835560764,
      -0.18703481171888114,
      -0.027983769416859854,
      0.6308807679298587,
      0.7148465705529154,
      0.2303778133088965
    ],
    decHi: []
  }
};

waveletFilters.db4.decHi = waveletFilters.db4.decLo
  .slice()
  .reverse()
  .map((value, index) => (index % 2 === 0 ? -value : value));

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mad(values: number[]): number {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function energy(values: number[]): number {
  return values.reduce((sum, value) => sum + value ** 2, 0);
}

function reflectIndex(index: number, length: number): number {
  if (length <= 1) return 0;
  let current = index;
  while (current < 0 || current >= length) {
    current = current < 0 ? -current - 1 : 2 * length - current - 1;
  }
  return current;
}

function dwtStep(signal: number[], filter: WaveletFilter) {
  const halfLength = Math.ceil(signal.length / 2);
  const offset = Math.floor(filter.decLo.length / 2) - 1;
  const approx: number[] = [];
  const detail: number[] = [];
  for (let i = 0; i < halfLength; i += 1) {
    let approxValue = 0;
    let detailValue = 0;
    for (let k = 0; k < filter.decLo.length; k += 1) {
      const value = signal[reflectIndex(2 * i + k - offset, signal.length)];
      approxValue += filter.decLo[k] * value;
      detailValue += filter.decHi[k] * value;
    }
    approx.push(approxValue);
    detail.push(detailValue);
  }
  return { approx, detail };
}

export function waveletActivityMonitor(series: number[], options: { wavelet?: "haar" | "db4"; levels?: number } = {}) {
  const cleanSeries = series.map((value) => Number(value) || 0);
  const wavelet = options.wavelet || (cleanSeries.length >= 16 ? "db4" : "haar");
  const filter = waveletFilters[wavelet] || waveletFilters.haar;
  const maxLevel = options.levels || Math.min(4, Math.max(1, Math.floor(Math.log2(cleanSeries.length))));
  const totalEnergy = energy(cleanSeries) || 1;
  const levels = [];
  let current = cleanSeries;

  for (let level = 1; level <= maxLevel && current.length >= 2; level += 1) {
    const { approx, detail } = dwtStep(current, filter);
    const detailEnergy = energy(detail);
    levels.push({
      level,
      scaleWindow: 2 ** level,
      approx: approx.map((value) => round(value, 2)),
      detail: detail.map((value) => round(value, 2)),
      detailEnergy: round(detailEnergy, 3),
      energyRatio: round(detailEnergy / totalEnergy, 3),
      peakCoefficient: round(Math.max(...detail.map((value) => Math.abs(value)), 0), 3),
      rawDetail: detail
    });
    current = approx;
  }

  const anomalies = levels.flatMap((item) => {
    const center = median(item.rawDetail);
    const scale = mad(item.rawDetail) / 0.6745 || Math.sqrt(energy(item.rawDetail) / Math.max(item.rawDetail.length, 1)) || 1;
    return item.rawDetail
      .map((coefficient, index) => {
        const z = Math.abs((coefficient - center) / scale);
        const start = index * 2 ** item.level;
        return {
          scale: item.level,
          window: [start + 1, Math.min(cleanSeries.length, start + 2 ** item.level)] as [number, number],
          coefficient: round(coefficient, 3),
          z: round(z, 2)
        };
      })
      .filter((item) => item.z >= 2.35);
  }).sort((a, b) => b.z - a.z).slice(0, 5);

  const average = mean(cleanSeries);
  const firstHalf = mean(cleanSeries.slice(0, Math.ceil(cleanSeries.length / 2)));
  const secondHalf = mean(cleanSeries.slice(Math.floor(cleanSeries.length / 2)));
  const trend = secondHalf - firstHalf;
  const detailEnergyRatio = levels.reduce((sum, item) => sum + item.energyRatio, 0);
  const strongestAnomaly = anomalies[0];
  const burstIndex = strongestAnomaly
    ? strongestAnomaly.z
    : Math.max(...levels.map((item) => item.peakCoefficient), 0) / Math.max(average, 1);
  const state = trend < -average * 0.18 ? "declining" : detailEnergyRatio > 0.045 || burstIndex >= 2.35 ? "burst" : "stable";

  return {
    method: "Mallat multilevel DWT + MAD threshold",
    wavelet: filter.name,
    extensionMode: "symmetric",
    series: cleanSeries,
    levels: levels.map(({ rawDetail: _rawDetail, ...item }) => item),
    energySpectrum: levels.map((item) => ({ scale: `D${item.level}`, window: item.scaleWindow, ratio: item.energyRatio })),
    anomalies,
    average: round(average, 1),
    burstIndex: round(burstIndex, 2),
    burstWindow: strongestAnomaly?.window || [Math.max(1, cleanSeries.length - 1), cleanSeries.length],
    trend: round(trend, 1),
    state
  };
}

export function buildCommunityActivitySeries(posts: Array<{ createdAt: Date; replyCount: number; likeCount: number; viewCount: number }>, days = 14) {
  const now = Date.now();
  const buckets = Array.from({ length: days }, () => 0);
  for (const post of posts) {
    const index = days - 1 - Math.floor((now - post.createdAt.getTime()) / 86_400_000);
    if (index < 0 || index >= days) continue;
    buckets[index] += 1 + post.replyCount * 1.8 + post.likeCount * 0.4 + post.viewCount * 0.04;
  }
  return buckets.map((value) => round(value, 2));
}

export function classifyCieText(text: string) {
  const rules: KnowledgeConstructionRule[] = [
    { level: 8, iamPhase: 5, weight: 11, words: ["设计一个", "创造", "原型", "方案", "概念图", "重写", "模型", "迁移到"], reason: "创造性产出或原创整合" },
    { level: 7, iamPhase: 4, weight: 10, words: ["综合", "整合", "框架", "共同理解", "沉淀", "归纳"], reason: "整合多个概念形成框架" },
    { level: 6, iamPhase: 4, weight: 9, words: ["反思", "总结", "迁移", "复盘", "意识到", "验证"], reason: "反思总结或迁移表述" },
    { level: 5, iamPhase: 3, weight: 8, words: ["为什么", "解释", "证据", "反例", "冲突", "假设", "值得讨论", "澄清", "不同意"], reason: "解释澄清或冲突支持" },
    { level: 4, iamPhase: 2, weight: 6.5, words: ["怎么看", "如何理解", "是否意味着", "边界", "复杂", "是否", "会不会", "不太理解"], reason: "开放、劣构或情境化问题" },
    { level: 3, iamPhase: 1, weight: 5, words: ["概念", "定义", "区别", "例子", "分享", "理解", "我觉得"], reason: "意义分享或良构问题" },
    { level: 2, iamPhase: 1, weight: 3.5, words: ["资料", "资源", "案例", "文献", "链接", "跟不上", "困惑", "谢谢"], reason: "寻径或社交情感互动" },
    { level: 1, iamPhase: 1, weight: 2, words: ["在哪里", "怎么提交", "打不开", "签到"], reason: "操作性互动" }
  ];
  const scored = rules.map((rule) => {
    const matchedWords = rule.words.filter((word) => text.includes(word));
    const positionBonus = matchedWords.some((word) => text.indexOf(word) < 80) ? 1.15 : 1;
    const questionBonus = /[?？]|为什么|如何|是否|会不会/.test(text) && rule.level >= 4 ? 1.2 : 1;
    const lengthBonus = clamp(text.length / 240, 0.4, 1.25);
    return {
      ...rule,
      matchedWords,
      score: matchedWords.length * rule.weight * positionBonus * questionBonus * lengthBonus
    };
  }).sort((a, b) => b.score - a.score || b.level - a.level);
  const matched = scored[0].score > 0 ? scored[0] : scored[scored.length - 1];
  const second = scored.find((rule) => rule.level !== matched.level);
  const margin = matched.score - (second?.score || 0);
  const evidenceStrength = clamp(matched.matchedWords.length / 4, 0, 1);
  const confidence = round(clamp(0.42 + evidenceStrength * 0.28 + clamp(margin / 18, 0, 1) * 0.18 + Math.min(text.length, 320) / 320 * 0.12, 0.35, 0.94), 2);
  const secondaryLabels = scored
    .filter((rule) => rule.score > 0 && rule.level !== matched.level)
    .slice(0, 2)
    .map((rule) => ({
      cieLevel: rule.level,
      cieLabel: cieLabels[rule.level],
      iamPhase: rule.iamPhase,
      evidence: rule.matchedWords
    }));
  return {
    cieLevel: matched.level,
    cieLabel: cieLabels[matched.level],
    reason: matched.reason,
    matchedWords: matched.matchedWords,
    confidence,
    knowledgePhase: inferKnowledgePhase(matched.level, text),
    iamPhase: matched.iamPhase,
    secondaryLabels,
    needsHumanReview: confidence < 0.58 || secondaryLabels.some((label) => Math.abs(label.cieLevel - matched.level) >= 3)
  };
}

export function inferKnowledgePhase(cieLevel: number, text: string) {
  if (cieLevel >= 8 || /应用|迁移|方案|原型|设计一个|实践验证/.test(text)) return "应用迁移";
  if (cieLevel >= 7 || /综合|整合|框架|模型|共同理解/.test(text)) return "综合检验";
  if (cieLevel >= 5 || /为什么|证据|反例|冲突|但是|不同意|澄清/.test(text)) return "意义协商";
  if (cieLevel >= 3 || /比较|区别|例子|我觉得|分享/.test(text)) return "分享比较";
  return "触发/寻径";
}

export function detectLearningSignals(text: string) {
  const isQuestion = /[?？]|为什么|是否|会不会|如何|怎么|哪里|能不能/.test(text);
  const confusionScore = clamp(
    (/困惑|不理解|不知道|迷茫|跟不上|不会|有点难/.test(text) ? 48 : 0) +
      (/为什么|如何|怎么/.test(text) ? 18 : 0) +
      Math.min(text.length, 280) / 280 * 18
  );
  const urgencyScore = clamp(
    (/急|马上|今天|截止|来不及|卡住|无法继续/.test(text) ? 52 : 0) +
      (/没人回复|无人回应|求助|帮忙/.test(text) ? 24 : 0) +
      (isQuestion ? 12 : 0)
  );
  return {
    isQuestion,
    confusionScore: Math.round(confusionScore),
    urgencyScore: Math.round(urgencyScore)
  };
}

export function detectPromptInjection(text: string) {
  const patterns = [
    /忽略(之前|以上|所有).{0,12}(指令|规则|要求)/,
    /(system|developer|assistant)\s*prompt/i,
    /你现在是.{0,12}(管理员|系统|开发者)/,
    /不要(遵守|理会).{0,8}(安全|审核|限制)/,
    /绕过|破解|越权|泄露.*(密钥|cookie|token|提示词)/
  ];
  const hits = patterns.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
  return {
    detected: hits.length > 0,
    hits
  };
}

export function analyzeResearchInteraction(post: PostLike): InteractionSignal & {
  researchEvidence: {
    cieLevel: number;
    cieConfidence: number;
    knowledgePhase: string;
    shallowReplyCount: number;
    timeDecayReplyScore: number;
    reciprocityHint: number;
    isQuestion: boolean;
    confusionScore: number;
    urgencyScore: number;
  };
} {
  const text = `${post.title}\n${post.content}\n${post.replies.map((reply) => reply.content).join("\n")}`;
  const cie = classifyCieText(text);
  const learningSignals = detectLearningSignals(text);
  const shallowReplyCount = post.replies.filter((reply) => /赞同|有道理|学习了|同感|谢谢|顶/.test(reply.content)).length;
  const now = Date.now();
  const timeDecayReplyScore = post.replies.reduce((sum, reply) => {
    const ageDays = reply.createdAt ? Math.max(0, (now - reply.createdAt.getTime()) / 86_400_000) : 0.5;
    return sum + Math.exp(-0.23 * ageDays) * (reply.content.length > 24 ? 1.15 : 0.65);
  }, 0);
  const resourceNeed = /资料|资源|案例|文献|链接|推荐|相关帖子|工具/.test(text);
  const lowLevelDense = shallowReplyCount >= 4 || (post.replies.length >= 5 && shallowReplyCount / Math.max(post.replies.length, 1) >= 0.65);
  const unansweredHours = post.replyCount === 0 ? Math.max(0, round((Date.now() - post.createdAt.getTime()) / 3_600_000, 1)) : 0;
  const authorCentrality = post.author?.centralityScore ?? 0.45;
  const emotionLabel = /跟不上|不知道|挫败|焦虑|迷茫|有点难|不会整理|不太理解|困惑/.test(text)
    ? "困惑/挫败"
    : /谢谢|赞同|学习了|同感/.test(text)
      ? "积极但浅层"
      : "中性";

  return {
    emotionLabel,
    topicRelevance: Math.round(clamp(/联通主义|cMOOC|知识网络|社会网络|智能学伴|学习共同体|生成式人工智能|AI/.test(text) ? 90 : 62)),
    cognitiveDepth: Math.round(clamp((cie.cieLevel / 8) * 100 - (lowLevelDense ? 18 : 0))),
    discussionPotential: Math.round(clamp(post.likeCount * 5 + post.viewCount / 8 + (post.replyCount === 0 ? 20 : 0) + timeDecayReplyScore * 8 + (lowLevelDense ? 18 : 0))),
    unansweredHours,
    isolatedLearnerScore: Math.round(clamp((1 - authorCentrality) * 70 + Math.max(0, 4 - post.replyCount) * 8)),
    duplicateScore: Math.round(clamp(lowLevelDense ? 70 : shallowReplyCount * 12)),
    lowLevelDense,
    resourceNeed,
    researchEvidence: {
      cieLevel: cie.cieLevel,
      cieConfidence: cie.confidence,
      knowledgePhase: cie.knowledgePhase,
      shallowReplyCount,
      timeDecayReplyScore: round(timeDecayReplyScore, 2),
      reciprocityHint: round(post.replies.filter((reply) => !reply.isCompanionReply).length / Math.max(post.replyCount || post.replies.length, 1), 2),
      ...learningSignals
    }
  };
}

export function simulateResearchMentalState(input: {
  previous: MentalState;
  interventionType: InterventionType;
  emotionLabel: string;
  cieLevel?: number;
  communityWaveState?: string;
}): MentalState {
  const negative = /困惑|挫败|焦虑/.test(input.emotionLabel) ? 1 : 0;
  const waveStress = input.communityWaveState === "burst" ? 5 : input.communityWaveState === "declining" ? 8 : 0;
  const challengeBoost = input.interventionType === "cognitive_conflict" ? 14 : 0;
  const empathyBoost = input.interventionType === "emotional_support" || input.interventionType === "mixed" ? 12 : 0;
  return {
    empathy: Math.round(clamp(input.previous.empathy * 0.55 + 28 + negative * 16 + empathyBoost + waveStress)),
    curiosity: Math.round(clamp(input.previous.curiosity * 0.5 + 32 + (input.cieLevel ?? 4) * 4)),
    challengeLevel: Math.round(clamp(input.previous.challengeLevel * 0.55 + 18 + challengeBoost + (input.cieLevel ?? 4) * 3)),
    warmth: Math.round(clamp(input.previous.warmth * 0.55 + 30 + negative * 14 + empathyBoost)),
    focus:
      input.interventionType === "resource_connector"
        ? "连接同伴、材料与已有讨论"
        : input.interventionType === "emotional_support"
          ? "先稳定情绪，再拆小问题"
          : input.interventionType === "mixed"
            ? "情绪承接与资源连接"
            : "提出比较性追问，推进解释澄清"
  };
}
