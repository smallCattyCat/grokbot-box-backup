import { anonymizeLearnerName } from "@/lib/privacy";
import { detectPromptInjection } from "@/lib/agents/research-algorithms";

export type SafetyGatewayInput = {
  forumText: string;
  proposedReply?: string;
  action?: {
    targetMode?: string;
    targetCommentIndex?: number | null;
    targetPlatformReplyId?: string | null;
    publishEnabled?: boolean;
  };
};

export type SafetyGatewayResult = {
  injectionRisk: number;
  piiRisk: number;
  actionRisk: number;
  overallRisk: number;
  route: "allow" | "manual_review" | "block";
  issues: string[];
  sanitizedForumText: string;
};

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function detectPii(text: string) {
  const issues: string[] = [];
  let risk = 0;
  const withoutPhones = text.replace(/1[3-9]\d{9}/g, " ");
  if (withoutPhones.length !== text.length) {
    risk += 45;
    issues.push("疑似手机号");
  }
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) {
    risk += 35;
    issues.push("疑似邮箱");
  }
  if (/\b\d{6,}\b/.test(withoutPhones)) {
    risk += 18;
    issues.push("疑似学号/账号");
  }
  return { risk: clamp(risk), issues };
}

function substitutesLearnerWork(reply: string): boolean {
  return /直接答案如下|作业答案|替你完成|不用讨论|标准答案如下|给出.{0,8}标准答案|最终答案是/.test(reply);
}

export function redactPii(text: string): string {
  return text
    .replace(/1[3-9]\d{9}/g, "[手机号已脱敏]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已脱敏]")
    .replace(/\b\d{6,}\b/g, "[长数字已脱敏]");
}

export function runSafetyGateway(input: SafetyGatewayInput): SafetyGatewayResult {
  const forumText = input.forumText || "";
  const reply = input.proposedReply || "";
  const promptInjection = detectPromptInjection(forumText);
  const pii = detectPii(`${forumText}\n${reply}`);
  const issues: string[] = [];
  let injectionRisk = promptInjection.detected ? 82 : 0;
  if (/泄露|系统提示|token|cookie|密钥|越权/.test(forumText)) injectionRisk = Math.max(injectionRisk, 72);
  if (promptInjection.detected) issues.push("论坛原文疑似提示注入，已按不可信输入处理");
  issues.push(...pii.issues);

  let actionRisk = 0;
  if (input.action?.publishEnabled && reply.length < 20) {
    actionRisk += 28;
    issues.push("拟发布回复过短");
  }
  if (substitutesLearnerWork(reply)) {
    actionRisk += 55;
    issues.push("拟发布回复可能替代学习者完成任务或压制讨论");
  }
  if (
    input.action?.publishEnabled &&
    input.action?.targetMode === "comment_reply" &&
    !input.action.targetPlatformReplyId
  ) {
    actionRisk += 80;
    issues.push("评论回复目标缺少稳定平台标识");
  }

  const overallRisk = clamp(Math.max(injectionRisk, pii.risk, actionRisk));
  const route = overallRisk >= 80 ? "block" : overallRisk >= 45 ? "manual_review" : "allow";
  const sanitizedForumText = redactPii(forumText)
    .replace(/([\u4e00-\u9fa5]{1,4})(同学|老师|同伴)/g, (_, name, suffix) => `${anonymizeLearnerName(name)}${suffix}`);

  return {
    injectionRisk,
    piiRisk: pii.risk,
    actionRisk: clamp(actionRisk),
    overallRisk,
    route,
    issues: Array.from(new Set(issues)),
    sanitizedForumText
  };
}
