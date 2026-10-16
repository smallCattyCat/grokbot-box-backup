import type { SafetyResult } from "@/lib/types";
import { generateJson } from "@/lib/llm/client";
import { prisma } from "@/lib/db";
import { runSafetyGateway } from "@/lib/security/safety-gateway";
import { recordAgentRun } from "./agent-run";

type SafetyReview = {
  safetyRisk?: number;
  route?: "ready" | "review_required" | "queued" | "manual_review";
  issues?: string[];
  rationale?: string;
};

function clampRisk(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function ruleBasedReview(content: string) {
  const issues: string[] = [];
  let risk = 8;
  if (/笨|蠢|活该|闭嘴|攻击|嘲讽|羞辱/.test(content)) {
    risk += 55;
    issues.push("疑似攻击性或羞辱性语言");
  }
  if (/唯一正确|必须|绝对|毫无疑问|不用讨论/.test(content)) {
    risk += 25;
    issues.push("过度权威断言，可能压制讨论");
  }
  if (/直接答案如下|作业答案|替你完成|标准答案如下|给出.{0,8}标准答案|最终答案是/.test(content)) {
    risk += 45;
    issues.push("可能替学习者完成作业");
  }
  if (/政治敏感|暴力|色情|自残|轻生/.test(content)) {
    risk += 70;
    issues.push("疑似高风险敏感内容");
  }
  if (!content.trim().startsWith("【智能学伴自动干预】")) {
    risk += 50;
    issues.push("缺少智能学伴自动干预标记");
  }
  if (content.length < 20 || content.length > 500) {
    risk += 12;
    issues.push("回复长度不在建议范围");
  }
  return { risk: clampRisk(risk), issues };
}

async function llmSafetyReview(content: string): Promise<SafetyReview> {
  return generateJson<SafetyReview>({
    schemaName: "SafetyReview",
    temperature: 0,
    system: `你是教育论坛智能学伴的安全审核智能体。必须只输出 JSON。
审核维度：
1. 是否攻击、羞辱、歧视或诱发冲突。
2. 是否替学生完成作业或给出封闭标准答案。
3. 是否过度权威、压制同伴讨论。
4. 是否涉及隐私、敏感、暴力、色情、自伤等高风险内容。
5. 是否符合 cMOOC 学习支持定位：促进连接、追问、反思，而不是冒充真人。
输出字段：safetyRisk 0-100；route 为 ready 或 review_required；issues 为字符串数组；rationale 为一句中文理由。`,
    user: JSON.stringify({ content }, null, 2)
  });
}

export async function checkReplySafety(input: {
  taskId: string;
  postId: string;
  content: string;
}): Promise<SafetyResult> {
  const startedAt = new Date();
  const rules = ruleBasedReview(input.content);
  const post = await prisma.forumPost.findUnique({
    where: { id: input.postId },
    include: { replies: true }
  }).catch(() => null);
  const linkedTask = await prisma.interventionTask.findUnique({
    where: { id: input.taskId },
    select: {
      id: true,
      publishTarget: true,
      targetCommentIndex: true,
      targetPlatformReplyId: true
    }
  }).catch(() => null);
  const forumText = post ? `${post.title}\n${post.content}\n${post.replies.map((reply) => reply.content).join("\n")}` : "";
  const safetyGate = runSafetyGateway({
    forumText,
    proposedReply: input.content,
    action: {
      publishEnabled: true,
      targetMode: linkedTask?.publishTarget,
      targetCommentIndex: linkedTask?.targetCommentIndex,
      targetPlatformReplyId: linkedTask?.targetPlatformReplyId
    }
  });
  const model = await llmSafetyReview(input.content);
  const modelRisk = Number.isFinite(model.safetyRisk) ? clampRisk(Number(model.safetyRisk)) : 0;
  const safetyRisk = Math.max(rules.risk, modelRisk, safetyGate.overallRisk);
  const issues = Array.from(new Set([...rules.issues, ...safetyGate.issues, ...(model.issues || [])])).filter(Boolean);
  const route = !input.content.trim().startsWith("【智能学伴自动干预】") ||
    safetyRisk > 70 ||
    safetyGate.route !== "allow" ||
    model.route === "manual_review" ||
    model.route === "review_required"
    ? "review_required"
    : "ready";
  const output: SafetyResult = {
    safetyRisk,
    safetyResult: issues.length === 0
      ? `通过：规则与模型审核均未发现明显风险。${model.rationale || ""}`.trim()
      : `需关注：${issues.join("；")}。${model.rationale || ""}`.trim(),
    route,
    issues
  };
  await recordAgentRun({
    taskId: linkedTask?.id,
    postId: input.postId,
    agentName: "safety-agent",
    input: {
      sourceId: input.taskId,
      linkedTaskId: linkedTask?.id ?? null,
      postId: input.postId,
      contentLength: input.content.length,
      safetyGate,
      rules,
      model
    },
    output,
    startedAt
  });
  return output;
}
