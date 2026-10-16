import { ensureAppEnvLoaded, readEnvironmentValue } from "@/lib/env";

ensureAppEnvLoaded();

export type JsonGenerationInput = {
  system: string;
  user: string;
  temperature?: number;
  schemaName?: string;
};

type LlmConfig = {
  mode: "mock" | "real";
  provider: "openai_compatible" | "siliconflow" | "dashscope" | "mock";
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

export type LlmRuntimeStatus = {
  mode: "mock" | "real";
  provider: "openai_compatible" | "siliconflow" | "dashscope" | "mock";
  baseUrlSet: boolean;
  model: string;
  hasApiKey: boolean;
};

function getLlmConfig(): LlmConfig {
  const requestedMode = process.env.LLM_MODE;
  const mode =
    requestedMode === "real" ||
    requestedMode === "siliconflow" ||
    requestedMode === "dashscope"
      ? "real"
      : "mock";
  const hasGenericKey = Boolean(process.env.LLM_API_KEY);
  if (mode === "real" && hasGenericKey) {
    return {
      mode,
      provider: "openai_compatible",
      baseUrl: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
      apiKey: process.env.LLM_API_KEY || "",
      model: process.env.LLM_MODEL || "gpt-4o-mini",
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 60_000)
    };
  }
  if (mode === "real" && process.env.SILICONFLOW_API_KEY) {
    return {
      mode,
      provider: "siliconflow",
      baseUrl: process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1",
      apiKey: process.env.SILICONFLOW_API_KEY,
      model: process.env.SILICONFLOW_MODEL || "Pro/zai-org/GLM-5.1",
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 60_000)
    };
  }
  const dashscopeKey = mode === "real"
    ? readEnvironmentValue("DASHSCOPE_API_KEY")
    : "";
  if (mode === "real" && dashscopeKey) {
    return {
      mode,
      provider: "dashscope",
      baseUrl:
        process.env.DASHSCOPE_COMPATIBLE_BASE_URL ||
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: dashscopeKey,
      model: process.env.DASHSCOPE_MODEL || "qwen3.7-plus",
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 60_000)
    };
  }
  if (mode === "real") {
    const siliconflowRequested = requestedMode === "siliconflow";
    const dashscopeRequested = requestedMode === "dashscope";
    return {
      mode,
      provider: siliconflowRequested
        ? "siliconflow"
        : dashscopeRequested
          ? "dashscope"
          : "openai_compatible",
      baseUrl: siliconflowRequested
        ? process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1"
        : dashscopeRequested
          ? process.env.DASHSCOPE_COMPATIBLE_BASE_URL ||
            "https://dashscope.aliyuncs.com/compatible-mode/v1"
          : process.env.LLM_BASE_URL || "https://api.openai.com/v1",
      apiKey: "",
      model: siliconflowRequested
        ? process.env.SILICONFLOW_MODEL || "Pro/zai-org/GLM-5.1"
        : dashscopeRequested
          ? process.env.DASHSCOPE_MODEL || "qwen3.7-plus"
        : process.env.LLM_MODEL || "gpt-4o-mini",
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 60_000)
    };
  }
  return {
    mode: "mock",
    provider: "mock",
    baseUrl: "",
    apiKey: "",
    model: "mock",
    timeoutMs: 60_000
  };
}

export function getLlmRuntimeStatus(): LlmRuntimeStatus {
  const config = getLlmConfig();
  return {
    mode: config.mode,
    provider: config.provider,
    baseUrlSet: Boolean(config.baseUrl),
    model: config.model,
    hasApiKey: Boolean(config.apiKey)
  };
}

function extractJsonBlock(text: string): string {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const firstObject = text.indexOf("{");
  const firstArray = text.indexOf("[");
  const first = firstObject < 0 ? firstArray : firstArray < 0 ? firstObject : Math.min(firstObject, firstArray);
  if (first < 0) return text;

  const openToClose: Record<string, string> = { "{": "}", "[": "]" };
  const closeToOpen: Record<string, string> = { "}": "{", "]": "[" };
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = first; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.length === 0 || stack[stack.length - 1] !== closeToOpen[char]) return text.slice(first, index + 1);
      stack.pop();
      if (stack.length === 0) return text.slice(first, index + 1);
    }
  }
  return text.slice(first);
}

function mockJson(schemaName?: string): unknown {
  if (schemaName === "ValueAnalysis") {
    return {
      isValuable: true,
      interventionScore: 76,
      cieLevel: 4,
      cieLabel: "劣构问题",
      emotionLabel: "neutral",
      topicType: "conceptual_question",
      interventionType: "cognitive_conflict",
      targetMode: "post_comment",
      targetCommentIndex: null,
      targetReason: "mock 判断：帖子具备继续讨论潜力",
      replyStrategy: "提出比较性追问，促进解释澄清",
      riskLevel: "low",
      reason: "mock LLM fallback：默认选择可自动干预的认知冲突型回应",
      urgencyScore: 24,
      confusionScore: 38,
      isQuestion: true,
      cieConfidence: 0.68,
      knowledgePhase: "意义协商",
      iamPhase: 3,
      needsHumanReview: false,
      secondaryLabels: []
    };
  }
  if (schemaName === "AutoReply") {
    return {
      replyContent:
        "这个问题可以继续往深处比较：如果只看任务完成度，容易忽略不同同学的贡献方式；如果看协作过程，又需要更清楚的证据记录。或许可以先讨论：哪些行为能说明真实参与，而不只是结果正确？",
      style: "认知冲突型",
      whyThisReply: "mock 生成：用追问推动讨论，不直接给最终答案"
    };
  }
  if (schemaName === "SafetyReview") {
    return {
      safetyRisk: 12,
      route: "ready",
      issues: [],
      rationale: "mock fallback：未发现明显攻击、敏感、替代作业或过度权威风险。"
    };
  }
  return {};
}

export async function generateJson<T>(input: JsonGenerationInput): Promise<T> {
  const config = getLlmConfig();
  if (config.mode !== "real") {
    return mockJson(input.schemaName) as T;
  }
  if (!config.apiKey) {
    throw new Error("在线模型模式已启用，但未找到 LLM_API_KEY、SILICONFLOW_API_KEY 或 DASHSCOPE_API_KEY；已停止本次分析，未使用 mock 结果代替。");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: `${input.system}\n\n你必须只输出合法 JSON，不要输出解释性文字。` },
          { role: "user", content: input.user }
        ],
        temperature: input.temperature ?? 0.2,
        response_format: { type: "json_object" }
      })
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${body ? `：${body.slice(0, 240)}` : ""}`);
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content ?? "";
    try {
      return JSON.parse(content) as T;
    } catch {
      const extracted = extractJsonBlock(content);
      try {
        return JSON.parse(extracted) as T;
      } catch (parseError) {
        throw new Error(`模型返回的 JSON 无法解析：${parseError instanceof Error ? parseError.message : "unknown"}`);
      }
    }
  } catch (error) {
    throw new Error(
      `在线模型调用失败，已停止本次分析且未回退到 mock：${error instanceof Error ? error.message : "unknown error"}`
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function generateTextWithFallback(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, fallback: string) {
  const config = getLlmConfig();
  if (config.mode !== "real") return fallback;
  if (!config.apiKey) {
    throw new Error("在线模型模式已启用，但未找到模型令牌；已停止本次生成，未使用 mock 文本代替。");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: config.model, messages, temperature: 0.65 })
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("模型返回了空文本。");
    }
    return content;
  } catch (error) {
    throw new Error(
      `在线模型调用失败，已停止本次生成且未回退到 mock：${error instanceof Error ? error.message : "unknown error"}`
    );
  } finally {
    clearTimeout(timer);
  }
}
