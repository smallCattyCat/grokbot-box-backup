import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  appendWorkbenchEvent,
  completeWorkbenchRun,
  getWorkbenchRun,
  getWorkbenchRunInternal,
  markWorkbenchStopRequested,
  setWorkbenchProtocolIds,
  setWorkbenchGoal,
  setWorkbenchPlan,
  setWorkbenchPendingAction,
  setWorkbenchRunStatus,
  setWorkbenchSession,
  updateWorkbenchAgent,
  updateWorkbenchTool,
  addWorkbenchArtifact,
  type WorkbenchRunSession
} from "@/lib/workbench/run-store";
import {
  redactPublicText,
  sanitizeWorkbenchLiveExcerpt,
  sanitizeWorkbenchCitations,
  type WorkbenchCollaborationMode,
  type WorkbenchCitation,
  type WorkbenchCourseGoalCode,
  type WorkbenchGoalStatus,
  type WorkbenchPriorActionReceipt,
  type WorkbenchPlanStepStatus
} from "@/lib/workbench/contracts";
import { safeCourseAgentGoalObjective } from "@/lib/workbench/course-agent-task-family";
import {
  assertWorkbenchCourseToolResult,
  fingerprintWorkbenchCourseToolCall,
  parseWorkbenchCourseToolInvocation,
  prepareWorkbenchCourseToolTransport,
  type PreparedWorkbenchCourseToolTransport,
  type WorkbenchCourseToolDescriptor,
  type WorkbenchCourseToolTransport
} from "@/lib/workbench/course-tool-transport";
import {
  buildStrategicBrainInstructions,
  resolveWorkbenchBrainConfig,
  type WorkbenchBrainConfig
} from "@/lib/workbench/strategic-brain";

const MAX_REQUEST_JSONL_BYTES = 64 * 1024;
const MAX_RESPONSE_JSONL_BYTES = 4 * 1024 * 1024;
const RPC_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 2_500;
const TRANSPORT_CLOSE_TIMEOUT_MS = 2_500;
const MAX_DYNAMIC_TOOL_CALLS_PER_RUN = 128;
export type WorkbenchCodexRunOptions = {
  collaborationMode: WorkbenchCollaborationMode;
  goalMode: boolean;
  courseGoalCode?: WorkbenchCourseGoalCode;
  executionIntent?: "inspect" | "implement";
  priorActionReceipts?: readonly WorkbenchPriorActionReceipt[];
  /** Internal closure only. It is never hydrated from a browser request. */
  courseToolTransport?: WorkbenchCourseToolTransport;
};

const DEFAULT_RUN_OPTIONS: WorkbenchCodexRunOptions = Object.freeze({
  collaborationMode: "default",
  goalMode: false,
  executionIntent: "implement"
});

const WORKBENCH_SHELL_ENVIRONMENT = Object.freeze([
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE"
] as const);

export const WORKBENCH_CODEX_APP_SERVER_ARGS = Object.freeze([
  "-c",
  "apps._default.enabled=false",
  "-c",
  "features.apps=false",
  "-c",
  "features.remote_plugin=false",
  "-c",
  "features.hooks=false",
  "-c",
  "features.skill_mcp_dependency_install=false",
  "-c",
  "mcp_servers={}",
  "-c",
  'web_search="live"',
  "-c",
  'tools.web_search.context_size="medium"',
  "-c",
  'history.persistence="none"',
  "-c",
  "memories.generate_memories=false",
  "-c",
  "allow_login_shell=false",
  "-c",
  "sandbox_workspace_write.network_access=false",
  "app-server",
  "--stdio"
] as const);

const WORKBENCH_CITATIONS_OUTPUT_SCHEMA = Object.freeze({
  type: "array",
  maxItems: 8,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["title", "url"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 180 },
      url: { type: "string", minLength: 1, maxLength: 1_024 }
    }
  }
} as const);

export const WORKBENCH_RESULT_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["summary", "completedActions", "nextStep", "citations", "safety"],
  properties: {
    summary: { type: "string", minLength: 240, maxLength: 4_000 },
    completedActions: {
      type: "array",
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 240 }
    },
    nextStep: { type: "string", maxLength: 400 },
    citations: WORKBENCH_CITATIONS_OUTPUT_SCHEMA,
    safety: {
      type: "object",
      additionalProperties: false,
      required: ["externalMutationAttempted", "containsForumText", "realPublishEnabled"],
      properties: {
        externalMutationAttempted: { type: "boolean", const: false },
        containsForumText: { type: "boolean", const: false },
        realPublishEnabled: { type: "boolean", const: false }
      }
    }
  }
} as const);

export const WORKBENCH_PLAN_RESULT_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["summary", "planSteps", "executionBoundary", "citations", "safety"],
  properties: {
    summary: { type: "string", minLength: 120, maxLength: 1_200 },
    planSteps: {
      type: "array",
      minItems: 2,
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 240 }
    },
    executionBoundary: { type: "string", maxLength: 400 },
    citations: WORKBENCH_CITATIONS_OUTPUT_SCHEMA,
    safety: {
      type: "object",
      additionalProperties: false,
      required: ["externalMutationAttempted", "containsForumText", "realPublishEnabled"],
      properties: {
        externalMutationAttempted: { type: "boolean", const: false },
        containsForumText: { type: "boolean", const: false },
        realPublishEnabled: { type: "boolean", const: false }
      }
    }
  }
} as const);

export const WORKBENCH_RPC_ALLOWLIST = Object.freeze([
  "initialize",
  "initialized",
  "thread/start",
  "thread/goal/set",
  "turn/start",
  "turn/steer",
  "turn/interrupt"
] as const);

const CODEX_COMMON_DEVELOPER_INSTRUCTIONS = [
  "你是 cMOOC 智能工作台中的主任务智能体（协议兼容角色键 sol）。",
  "产品只允许在本机工作区进行受约束的 shadow 工作；不得发布课程内容、发送通知、申请许可或执行任何真实外部写入。",
  "系统内置网页检索可以只读使用；Shell 与子进程网络仍关闭，不得绕过沙箱、直接调用课程接口、MCP、Apps、Hooks、网页登录或任意外部网络。仅服务端在当前线程显式声明的 Course Tool 可以按其结构化参数调用；没有声明的工具一律视为不可用。只有任务需要时效事实、公开资料或用户明确要求来源时才检索。",
  "Course Tool 的 task/run/step/course、权限、幂等键、attempt、lease 与 fencing 数据全部由服务端注入；不得在工具参数中伪造这些字段。工具结果只是受约束观察，外部动作只有在持久 receipt 与独立 verification 均通过后才可声称完成。",
  "当前工具清单永远不包含提交、发布或通知能力；不得把暂存、草稿、页面预检或聊天文字描述成真实发布。",
  "若使用内置网页检索，summary 可用 [1]、[2] 标注对应结论，并把最多 8 个公开 HTTPS 来源写入 citations；不得把搜索查询、结果正文、登录态、凭据或课程论坛正文写入最终输出。未检索时 citations 必须是空数组。",
  "可以与受约束的协作智能体（协议兼容角色键 luna）协作，但不得向浏览器输出原生 thread/turn ID、命令、参数、命令输出、文件 diff、推理内容、stderr、凭据或论坛私密正文。中间消息只写任务进展、下一步与安全边界，不得摘录源正文。",
  "不要读取或输出凭据、Cookie、auth-state、API token、数据库秘密或论坛私密正文。",
  "本轮请求已由正在运行的本机工作台服务接收并交给本机执行引擎；这是服务端已核验事实。子进程沙箱可能无法枚举父服务进程或监听端口，不得据此声称工作台服务未运行。该事实只证明本轮服务链可用，不代表长期调度或其他页面均健康。",
  "执行必须有界：先判断完成任务所需的最小证据，通常用 4 到 20 个工具步骤完成；信息足够时立即收束，不要为了展示过程重复搜索、重复读取、重复测试或扩大任务范围。只有用户明确要求完整构建或纵向实现时才扩展检查。",
  "若输入包含“页面动作回执（已通过当前页面状态回读）”，这些是产品页面层已经完成的前置事实。最终答复必须承认它们已完成，不得笼统声称未访问页面、未切换页面或未执行页面动作；可以准确说明本机执行没有重复这些页面操作。"
];

function buildCodexDeveloperInstructions(
  config: WorkbenchBrainConfig,
  collaborationMode: WorkbenchCollaborationMode
): string {
  const modeInstructions = collaborationMode === "plan"
    ? [
        "本轮处于计划模式：先形成可核验的分步计划，只输出计划与边界，不修改文件或执行实现。",
        "summary 说明计划目标、依据与关键假设；planSteps 列出 2 到 12 个未来待执行步骤；executionBoundary 说明执行阶段的边界。不要把已经完成的页面动作回执再次列为待执行步骤。",
        "不要请求用户输入；信息不足时作最小且可逆的假设，并在计划中明确标注。最终回答只能返回符合计划 outputSchema 的 JSON，不得使用 completedActions 或 nextStep；公开来源只写入 citations。"
      ]
    : [
        "最终答复要像完整的助手交付：summary 必须先给出用户实际请求的答案或成果，再说明关键依据、验证情况与边界；若任务要求草稿、摘要、方案或分析，必须把可直接审阅的内容写入 summary，不能用‘已形成’或执行过程代替成果。summary 使用 3 到 6 个清晰短段落且至少 240 个字符；completedActions 只在成果之后列出 2 到 8 项实际完成内容，nextStep 给出明确下一步或说明无需继续。",
        "最终回答必须只返回符合 outputSchema 的 JSON；summary、completedActions 与 nextStep 只能概括行动和结论，不得复制源正文、命令、路径、内部标识或敏感值；公开来源只写入 citations。"
      ];
  return [
    ...CODEX_COMMON_DEVELOPER_INSTRUCTIONS,
    buildStrategicBrainInstructions(config),
    ...modeInstructions
  ].join("\n");
}

type JsonObject = Record<string, unknown>;

export type CodexTransport = {
  send(line: string): void | Promise<void>;
  onLine(listener: (line: string) => void): () => void;
  onExit(listener: (code: number | null) => void): () => void;
  close(force?: boolean): void | Promise<void>;
};

export type CodexTransportFactory = (options: {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => CodexTransport;

let transportFactory: CodexTransportFactory | undefined;

type CodexRuntimeProbeResult = "ready" | "auth-unavailable" | "unknown";

type CodexRuntimeProbe = (options: {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => Promise<CodexRuntimeProbeResult>;

let runtimeProbeForTests: CodexRuntimeProbe | undefined;

type CodexLoginLaunchHandle = {
  completed: Promise<void>;
};

type CodexLoginLauncher = (options: {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => Promise<CodexLoginLaunchHandle>;

let loginLauncherForTests: CodexLoginLauncher | undefined;
let loginStartInFlight: Promise<CodexLoginStartResult> | undefined;
let loginCompletion: Promise<void> | undefined;

class SafeRpcError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SafeRpcError";
    this.code = code;
  }
}

type PendingRequest = {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Notification = {
  method?: unknown;
  params?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
};

type JsonRpcId = string | number;

type DynamicToolCallResponse = {
  success: boolean;
  contentItems: Array<{
    type: "inputText";
    text: string;
  }>;
};

type DynamicToolCallState = {
  fingerprint: string;
  descriptor: WorkbenchCourseToolDescriptor;
  result: Promise<DynamicToolCallResponse>;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function statusValue(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function diagnosticClassificationText(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase().slice(0, 8_192);
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value).toLowerCase().slice(0, 8_192);
  } catch {
    return "";
  }
}

function otherCodexErrorDetail(error: unknown, codexErrorInfo: unknown): string | undefined {
  const otherKey = isObject(codexErrorInfo)
    ? Object.keys(codexErrorInfo).find((key) => key.toLowerCase() === "other")
    : undefined;
  if (statusValue(codexErrorInfo) !== "other" && !otherKey) return undefined;
  const details = isObject(error)
    ? [error.message, error.details, error.detail, error.additionalDetails]
    : [error];
  if (otherKey && isObject(codexErrorInfo)) details.push(codexErrorInfo[otherKey]);
  return details.map(diagnosticClassificationText).filter(Boolean).join(" ");
}

function projectRemoteError(params: unknown): {
  code:
    | "CODEX_OUTPUT_SCHEMA_INVALID"
    | "CODEX_CONNECTION_INTERRUPTED"
    | "CODEX_SERVICE_BUSY"
    | "CODEX_USAGE_LIMIT"
    | "CODEX_AUTH_UNAVAILABLE"
    | "CODEX_REQUEST_REJECTED"
    | "CODEX_REMOTE_ERROR";
  summary: string;
} {
  const error = isObject(params) && isObject(params.error) ? params.error : params;
  const remoteCode = isObject(error) ? statusValue(error.code) : "";
  const rawMessage = isObject(error) ? statusValue(error.message) : "";
  const codexErrorInfo = isObject(error) ? error.codexErrorInfo : undefined;
  const otherErrorDetail = otherCodexErrorDetail(error, codexErrorInfo);
  if (
    remoteCode === "invalid_json_schema" ||
    (/schema|response.?format|structured/.test(rawMessage) && /json/.test(rawMessage))
  ) {
    return {
      code: "CODEX_OUTPUT_SCHEMA_INVALID",
      summary: "结构化结果契约未通过本机执行引擎校验。"
    };
  }
  if (
    isObject(codexErrorInfo) &&
    (
      "responseStreamDisconnected" in codexErrorInfo ||
      "responseStreamConnectionFailed" in codexErrorInfo ||
      "responseTooManyFailedAttempts" in codexErrorInfo ||
      "httpConnectionFailed" in codexErrorInfo
    )
  ) {
    return {
      code: "CODEX_CONNECTION_INTERRUPTED",
      summary: "本机执行连接中断，自动重试仍未恢复。"
    };
  }
  if (
    otherErrorDetail &&
    /stream[\s_-]+disconnected|error[\s_-]+sending[\s_-]+request|transport[\s_-]+connection/.test(
      otherErrorDetail
    )
  ) {
    return {
      code: "CODEX_CONNECTION_INTERRUPTED",
      summary: "本机执行连接中断，自动重试仍未恢复。"
    };
  }
  if (codexErrorInfo === "serverOverloaded") {
    return {
      code: "CODEX_SERVICE_BUSY",
      summary: "本机执行服务暂时繁忙，稍后可重新启动任务。"
    };
  }
  if (codexErrorInfo === "usageLimitExceeded" || codexErrorInfo === "sessionBudgetExceeded") {
    return {
      code: "CODEX_USAGE_LIMIT",
      summary: "本机执行用量暂时受限，当前任务已安全收束。"
    };
  }
  if (codexErrorInfo === "unauthorized") {
    return {
      code: "CODEX_AUTH_UNAVAILABLE",
      summary: "本机执行授权当前不可用。"
    };
  }
  if (codexErrorInfo === "badRequest") {
    return {
      code: "CODEX_REQUEST_REJECTED",
      summary: "本机执行请求未通过协议校验。"
    };
  }
  return {
    code: "CODEX_REMOTE_ERROR",
    summary: "本机执行引擎返回了受约束错误。"
  };
}

function extractItem(params: unknown): JsonObject | undefined {
  if (!isObject(params) || !isObject(params.item)) return undefined;
  return params.item;
}

function extractText(value: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractText(entry, depth + 1))
      .filter((entry): entry is string => Boolean(entry));
    return parts.length ? parts.join("\n") : undefined;
  }
  if (!isObject(value)) return undefined;
  for (const key of ["text", "content", "message", "summary", "description"]) {
    const text = extractText(value[key], depth + 1);
    if (text) return text;
  }
  return undefined;
}

function safeAgentMessage(value: unknown): string {
  let text = redactPublicText(extractText(value), 4_000);
  text = text
    .replace(/```[\s\S]*?```/g, "[代码细节已隐藏]")
    .replace(/\b(?:urn:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[内部标识已隐藏]")
    .replace(/\b(?:thread|turn|native)[_-]?id\s*[:=]\s*[^\s,;]+/gi, "[内部标识已隐藏]")
    .replace(/\b(?:cwd|codex[_-]?home|stderr|stdout|command|args?|parameters?|reasoning|chain[_-]?of[_-]?thought|cot)\s*[:=][^\n]*/gi, "[内部运行信息已隐藏]")
    .replace(/^\s*(?:npm|pnpm|yarn|git|powershell|pwsh|cmd|python|node|tsx|curl|invoke-webrequest)\b[^\n]*/gim, "[命令信息已隐藏]")
    .replace(/^\s*(?:diff --git|@@\s|\+\+\+\s|---\s)[^\n]*/gim, "[文件差异已隐藏]");
  return text.trim();
}

type SafeStructuredFinal = {
  summary: string;
  completedActions: string[];
  nextStep: string;
  planSteps: string[];
  executionBoundary: string;
  citations: WorkbenchCitation[];
};

const REDACTED_PUBLIC_MARKER = /\[(?:凭据|敏感字段|链接|本机路径|内部标识|内部运行信息|命令信息|文件差异|代码细节)已隐藏\]/;
const LIVE_PROGRESS_PREFIX = /^(?:我(?:会|将|先|正在|已经|已)|已|正在|接下来|下一步|当前|开始|继续|完成|准备|等待|发现|核对|检查|验证|运行|测试|整理|实现|修复|构建|分析|审计|I\s+(?:will|am|have)|Checking|Next|Completed|Reviewing)/i;
const SOURCE_TEXT_HINT = /(?:论坛(?:正文|原文|帖子内容|回复内容|内容)|(?:帖子|回复|课程|学习者|用户)(?:正文|原文|发言|内容|内容引用)|原文\s*[:：]|引用(?:如下|内容))/i;
const UNSAFE_PROGRESS_HINT = /(?:\b(?:powershell|pwsh|cmd|git|npm|pnpm|yarn|node|python|tsx|curl|wget|rg|grep|Get-ChildItem|Invoke-WebRequest)\b|(?:actor|learner|member|user|invocation|thread|run)[-_: ]?[a-z0-9]{3,}|\b[a-f0-9]{32,}\b|(?:token|cookie|credential|secret|password|api[_ -]?key)\b)/i;
const STRUCTURED_COMMAND_LINE_HINT = /(?:^|[\s:：，,；;])(?:npm|pnpm|yarn|git|powershell|pwsh|cmd|python|node|tsx|curl|wget|rg|grep|Get-ChildItem|Invoke-WebRequest)(?=\s|$)/i;
const STRUCTURED_INTERNAL_ID_HINT = /(?:\b(?:actor|learner|member|user|invocation|thread|turn|native|request|session|activity|artifact)[_-](?:[a-z0-9]{3,})\b|\b(?:thread|turn|native|invocation|run|actor|learner|member|user|request|session|activity|artifact)(?:[_-]?id|\s+id)\s*[:=]\s*[a-z0-9_-]{3,}|\b[a-f0-9]{32,}\b)/i;

function stripPublicListPrefix(line: string): string {
  return line.replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+(?:\[[ xX]\]\s*)?/, "").trim();
}

/**
 * Structured final/plan fields are model-authored text, not a trusted data
 * channel.  Normalize list syntax before scanning so a numbered shell command
 * cannot bypass the line-start redaction used by safeAgentMessage().
 */
function safeStructuredPublicText(value: unknown, maxLength: number): string {
  const raw = safeAgentMessage(value);
  if (!raw) return "";
  const lines = raw
    .split(/\r?\n/)
    .map(stripPublicListPrefix)
    .filter(
      (line) =>
        line &&
        !REDACTED_PUBLIC_MARKER.test(line) &&
        !SOURCE_TEXT_HINT.test(line) &&
        !STRUCTURED_COMMAND_LINE_HINT.test(line) &&
        !STRUCTURED_INTERNAL_ID_HINT.test(line)
    );
  return lines.join("\n").slice(0, maxLength).trim();
}

function safeLiveAgentExcerpt(value: unknown): string | undefined {
  const visibleLines = safeAgentMessage(value)
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+/, "").trim())
    .filter(
      (line) =>
        line &&
        LIVE_PROGRESS_PREFIX.test(line) &&
        !SOURCE_TEXT_HINT.test(line) &&
        !UNSAFE_PROGRESS_HINT.test(line) &&
        !REDACTED_PUBLIC_MARKER.test(line)
    );
  return sanitizeWorkbenchLiveExcerpt(visibleLines.join(" "));
}

function safeStructuredFinal(
  item: JsonObject,
  collaborationMode: WorkbenchCollaborationMode
): SafeStructuredFinal | undefined {
  if (statusValue(item.phase) !== "final_answer") return undefined;
  const raw = extractText(item);
  if (!raw) return undefined;

  let candidate = raw.trim();
  let parsed: unknown;
  for (let depth = 0; depth < 4; depth += 1) {
    const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced?.[1]) candidate = fenced[1].trim();
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return undefined;
    }
    if (typeof parsed !== "string") break;
    candidate = parsed.trim();
  }
  if (!isObject(parsed) || !isObject(parsed.safety)) return undefined;
  if (
    parsed.safety.externalMutationAttempted !== false ||
    parsed.safety.containsForumText !== false ||
    parsed.safety.realPublishEnabled !== false
  ) {
    return undefined;
  }

  const summary = typeof parsed.summary === "string"
    ? safeStructuredPublicText(parsed.summary, 4_000)
    : "";
  const completedActions = collaborationMode === "default" && Array.isArray(parsed.completedActions)
    ? parsed.completedActions
        .slice(0, 8)
        .map((value) => typeof value === "string" ? safeStructuredPublicText(value, 240) : "")
        .filter(Boolean)
    : [];
  const rawNextStep = collaborationMode === "default" && typeof parsed.nextStep === "string"
    ? safeStructuredPublicText(parsed.nextStep, 400)
    : "";
  const nextStep = rawNextStep;
  const planSteps = collaborationMode === "plan" && Array.isArray(parsed.planSteps)
    ? parsed.planSteps
        .slice(0, 12)
        .map((value) => typeof value === "string" ? safeStructuredPublicText(value, 240) : "")
        .filter(Boolean)
    : [];
  const rawExecutionBoundary = collaborationMode === "plan" && typeof parsed.executionBoundary === "string"
    ? safeStructuredPublicText(parsed.executionBoundary, 400)
    : "";
  const executionBoundary = rawExecutionBoundary;
  const citations = sanitizeWorkbenchCitations(parsed.citations);
  if (
    !summary &&
    completedActions.length === 0 &&
    !nextStep &&
    planSteps.length === 0 &&
    !executionBoundary
  ) {
    return undefined;
  }
  return {
    summary,
    completedActions,
    nextStep,
    planSteps,
    executionBoundary,
    citations
  };
}

function formatStructuredFinal(
  structured: SafeStructuredFinal,
  collaborationMode: WorkbenchCollaborationMode
): string {
  const publicParts = [structured.summary];
  if (collaborationMode === "default" && structured.completedActions.length) {
    publicParts.push(`已完成：\n${structured.completedActions.map((entry) => `- ${entry}`).join("\n")}`);
  }
  if (collaborationMode === "default" && structured.nextStep) {
    publicParts.push(`下一步：${structured.nextStep}`);
  }
  if (collaborationMode === "plan" && structured.executionBoundary) {
    publicParts.push(`执行边界：${structured.executionBoundary}`);
  }
  return publicParts.filter(Boolean).join("\n\n").trim();
}

function mentionsVerifiedPageActions(text: string): boolean {
  return /(?:页面(?:动作|操作)|(?:访问|打开|查看|定位|聚焦)[^。！？；;\n]{0,12}社会网络|(?:切换|跳转|返回)[^。！？；;\n]{0,12}控制台|(?:附加|加入|添加)[^。！？；;\n]{0,12}上下文|社会网络[^。！？；;\n]{0,12}(?:访问|打开|定位|聚焦)|控制台[^。！？；;\n]{0,12}(?:切换|跳转)|上下文[^。！？；;\n]{0,12}(?:附加|加入|添加))/u.test(text);
}

function contradictsVerifiedPageActions(text: string): boolean {
  const deniesCompletion = /(?:尚未|未曾|并未|没有|未能|未予|未执行|未进行|未完成|没有做|没做)/u.test(text);
  return mentionsVerifiedPageActions(text) && deniesCompletion;
}

function restatesVerifiedPageActions(text: string): boolean {
  const assertsCompletion = /(?:页面层已完成|页面阶段已完成|已(?:访问|打开|切换|跳转|定位|聚焦|附加|加入|添加)|无需重复|没有重复)/u.test(text);
  return mentionsVerifiedPageActions(text) && assertsCompletion;
}

function removeConflictingPageActionSegments(
  text: string,
  removeRestatements = false
): string {
  return text
    .split(/(?<=[。！？；;\n])/u)
    .filter(
      (segment) =>
        !contradictsVerifiedPageActions(segment) &&
        !(removeRestatements && restatesVerifiedPageActions(segment))
    )
    .join("")
    .trim();
}

function normalizePriorActionReceiptSummary(summary: string): string {
  return safeStructuredPublicText(summary, 220)
    .replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, "$1")
    .replace(/\s+([，。；：])/gu, "$1")
    .replace(/[，,。；;\s]+$/gu, "");
}

function reconcileVerifiedPageActionFinal(
  structured: SafeStructuredFinal,
  receipts: readonly WorkbenchPriorActionReceipt[]
): SafeStructuredFinal {
  const receiptSummary = receipts
    .slice(0, 8)
    .map((receipt) => normalizePriorActionReceiptSummary(receipt.summary))
    .filter(Boolean)
    .join("；");
  const authoritativeSummary = receiptSummary
    ? `页面阶段已完成并核验：${receiptSummary}。本机执行在这些结果上继续，没有重复页面操作。`
    : "页面阶段已完成并核验。本机执行在这些结果上继续，没有重复页面操作。";
  const modelSummary = removeConflictingPageActionSegments(structured.summary, true);
  return {
    summary: [authoritativeSummary, modelSummary].filter(Boolean).join("\n\n"),
    completedActions: structured.completedActions.filter(
      (entry) =>
        !contradictsVerifiedPageActions(entry) &&
        !restatesVerifiedPageActions(entry)
    ),
    nextStep: removeConflictingPageActionSegments(structured.nextStep),
    planSteps: structured.planSteps.filter(
      (entry) =>
        !contradictsVerifiedPageActions(entry) &&
        !restatesVerifiedPageActions(entry)
    ),
    executionBoundary: removeConflictingPageActionSegments(structured.executionBoundary),
    citations: structured.citations
  };
}

function safePlanProjection(rawValue: unknown): {
  summary: string;
  steps: Array<{ step: string; status: WorkbenchPlanStepStatus }>;
} | undefined {
  const raw = extractText(rawValue)?.trim();
  if (!raw) return undefined;
  const proposedPlan = raw.match(/^<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>$/i);
  const planText = proposedPlan?.[1] ?? raw;

  const summary = safeStructuredPublicText(planText, 4_000);
  if (!summary) return undefined;

  const steps = planText
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\s*(?:\d{1,2}[.)]|[-*])\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/);
      if (!match?.[1]) return [];
      const step = safeStructuredPublicText(match[1], 240);
      if (!step) return [];
      return [{ step, status: "pending" as const }];
    })
    .slice(0, 12);

  return { summary, steps };
}

function safeNativePlanFinal(item: JsonObject): ReturnType<typeof safePlanProjection> {
  if (statusValue(item.phase) !== "final_answer") return undefined;
  const raw = extractText(item)?.trim();
  if (!raw || /^(?:\{|\[|")/.test(raw)) return undefined;
  const projected = safePlanProjection(raw);
  return projected?.steps.length ? projected : undefined;
}

function itemStatus(item: JsonObject, fallback: "running" | "completed"): "running" | "completed" | "failed" | "stopped" {
  const status = statusValue(item.status);
  if (status.includes("fail") || status === "error") return "failed";
  if (status.includes("interrupt") || status.includes("cancel") || status === "stopped") return "stopped";
  if (status === "started" || status === "in_progress" || status === "running") return "running";
  return fallback;
}

function eventStatus(status: ReturnType<typeof itemStatus>): "running" | "completed" | "failed" | "stopped" {
  return status;
}

function extractThreadId(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  if (isObject(value.thread)) return stringValue(value.thread.id);
  return stringValue(value.threadId);
}

function extractTurnId(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  if (isObject(value.turn)) return stringValue(value.turn.id);
  return stringValue(value.turnId);
}

function makeEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "CODEX_HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE"
  ].map((key) => key.toUpperCase()));
  const env = {} as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const normalizedKey = key.toUpperCase();
    const isProxyOrTrustPath =
      normalizedKey === "HTTPS_PROXY" ||
      normalizedKey === "HTTP_PROXY" ||
      normalizedKey === "ALL_PROXY" ||
      normalizedKey === "NO_PROXY" ||
      normalizedKey === "NODE_EXTRA_CA_CERTS" ||
      normalizedKey === "SSL_CERT_FILE";
    if (isProxyOrTrustPath && /:\/\/[^/\s@]*@/i.test(value)) {
      continue;
    }
    if (allowed.has(normalizedKey) || normalizedKey.startsWith("OPENAI_")) {
      env[normalizedKey] = value;
    }
  }
  if (!env.SSL_CERT_FILE) {
    const discoveredCaBundle = resolveDefaultSslCertFile();
    if (discoveredCaBundle) env.SSL_CERT_FILE = discoveredCaBundle;
  }
  return env;
}

function isWithinResolvedRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function resolveTrustedFile(
  configuredRoot: string | undefined,
  relativeSegments: readonly string[]
): string | undefined {
  if (!configuredRoot || !path.isAbsolute(configuredRoot)) return undefined;
  const root = path.resolve(configuredRoot);
  const expectedRelative = path.join(...relativeSegments);
  const candidate = path.join(root, expectedRelative);
  try {
    const candidateLink = lstatSync(candidate);
    if (!candidateLink.isFile() || candidateLink.isSymbolicLink()) return undefined;
    const rootReal = realpathSync.native(root);
    const candidateReal = realpathSync.native(candidate);
    if (!isWithinResolvedRoot(rootReal, candidateReal)) return undefined;
    if (path.relative(rootReal, candidateReal).toLowerCase() !== expectedRelative.toLowerCase()) {
      return undefined;
    }
    return statSync(candidateReal).isFile() ? candidateReal : undefined;
  } catch {
    return undefined;
  }
}

function resolveDefaultSslCertFile(): string | undefined {
  const roots = [
    process.env.PROGRAMFILES,
    process.env.PROGRAMW6432,
    process.env["PROGRAMFILES(X86)"]
  ];
  for (const root of roots) {
    const candidate = resolveTrustedFile(root, [
      "Git",
      "usr",
      "ssl",
      "certs",
      "ca-bundle.crt"
    ]);
    if (candidate) return candidate;
  }
  return undefined;
}

type ResolvedCodexBin = {
  logicalPath: string;
  realPath: string;
};

type ResolvedCodexExecutable = {
  path: string;
  mtimeMs: number;
  sortKey: string;
};

function resolveCodexBin(
  configuredRoot: string | undefined,
  binSegments: readonly string[]
): ResolvedCodexBin | undefined {
  if (!configuredRoot || !path.isAbsolute(configuredRoot)) return undefined;
  const root = path.resolve(configuredRoot);
  const binRoot = path.join(root, ...binSegments);
  try {
    if (!existsSync(binRoot) || !statSync(binRoot).isDirectory()) return undefined;
    const rootReal = realpathSync.native(root);
    const binRootReal = realpathSync.native(binRoot);
    if (!isWithinResolvedRoot(rootReal, binRootReal)) return undefined;
    return { logicalPath: binRoot, realPath: binRootReal };
  } catch {
    return undefined;
  }
}

function resolveCodexExecutableInBin(
  bin: ResolvedCodexBin,
  relativeSegments: readonly string[]
): ResolvedCodexExecutable | undefined {
  const expectedRelative = path.join(...relativeSegments);
  const candidate = path.join(bin.logicalPath, expectedRelative);
  if (path.basename(candidate).toLowerCase() !== "codex.exe") return undefined;
  try {
    const candidateLink = lstatSync(candidate);
    if (!candidateLink.isFile() || candidateLink.isSymbolicLink()) return undefined;
    const candidateReal = realpathSync.native(candidate);
    if (!isWithinResolvedRoot(bin.realPath, candidateReal)) return undefined;
    const actualRelative = path.relative(bin.realPath, candidateReal);
    if (actualRelative.toLowerCase() !== expectedRelative.toLowerCase()) return undefined;
    if (path.basename(candidateReal).toLowerCase() !== "codex.exe") return undefined;
    const candidateStats = statSync(candidateReal);
    if (!candidateStats.isFile() || !Number.isFinite(candidateStats.mtimeMs)) return undefined;
    return {
      path: candidateReal,
      mtimeMs: candidateStats.mtimeMs,
      sortKey: actualRelative.replace(/\\/g, "/").toLowerCase()
    };
  } catch {
    return undefined;
  }
}

function newestCodexExecutable(
  candidates: readonly ResolvedCodexExecutable[]
): string | undefined {
  return [...candidates]
    .sort((left, right) => {
      if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
      if (left.sortKey !== right.sortKey) return left.sortKey < right.sortKey ? -1 : 1;
      return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
    })[0]?.path;
}

function resolveDesktopCodexExecutable(configuredRoot: string | undefined): string | undefined {
  const bin = resolveCodexBin(configuredRoot, ["OpenAI", "Codex", "bin"]);
  if (!bin) return undefined;
  const candidates: ResolvedCodexExecutable[] = [];
  const direct = resolveCodexExecutableInBin(bin, ["codex.exe"]);
  if (direct) candidates.push(direct);
  try {
    for (const entry of readdirSync(bin.logicalPath, { withFileTypes: true })) {
      if (!/^[a-f0-9]{8,64}$/i.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const versionDirectory = path.join(bin.logicalPath, entry.name);
      const directoryLink = lstatSync(versionDirectory);
      if (!directoryLink.isDirectory() || directoryLink.isSymbolicLink()) continue;
      const nested = resolveCodexExecutableInBin(bin, [entry.name, "codex.exe"]);
      if (nested) candidates.push(nested);
    }
  } catch {
    // A valid direct candidate can still be used if version enumeration races or fails.
  }
  return newestCodexExecutable(candidates);
}

function resolveCodexExecutableCandidate(
  configuredRoot: string | undefined,
  binSegments: readonly string[]
): string | undefined {
  const bin = resolveCodexBin(configuredRoot, binSegments);
  if (!bin) return undefined;
  return resolveCodexExecutableInBin(bin, ["codex.exe"])?.path;
}

function resolveCodexExecutable(): string | undefined {
  return (
    resolveDesktopCodexExecutable(process.env.LOCALAPPDATA) ??
    resolveCodexExecutableCandidate(process.env.APPDATA, [
      "npm",
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin"
    ])
  );
}

export function isCodexHarnessAvailable(): boolean {
  return Boolean(transportFactory || resolveCodexExecutable());
}

function defaultCodexRuntimeProbe(options: {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<CodexRuntimeProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CodexRuntimeProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    try {
      const child = spawn(options.executable, ["login", "status"], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: "ignore"
      });
      child.once("error", () => finish("unknown"));
      child.once("exit", (code) => {
        if (code === 0) finish("ready");
        else if (code === 1) finish("auth-unavailable");
        else finish("unknown");
      });
      timer = setTimeout(() => {
        if (!child.killed) child.kill();
        finish("unknown");
      }, 5_000);
    } catch {
      finish("unknown");
    }
  });
}

function defaultCodexLoginLauncher(options: {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<CodexLoginLaunchHandle> {
  return new Promise((resolve, reject) => {
    let spawned = false;
    let completed = false;
    let resolveCompleted!: () => void;
    const completion = new Promise<void>((done) => {
      resolveCompleted = done;
    });
    const finish = () => {
      if (completed) return;
      completed = true;
      resolveCompleted();
    };
    try {
      const child = spawn(options.executable, ["login"], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: "ignore"
      });
      const timer = setTimeout(() => {
        if (!spawned) {
          if (!child.killed) child.kill();
          reject(new SafeRpcError("CODEX_LOGIN_START_TIMEOUT"));
        }
      }, 5_000);
      child.once("spawn", () => {
        spawned = true;
        clearTimeout(timer);
        resolve({ completed: completion });
      });
      child.once("error", () => {
        clearTimeout(timer);
        finish();
        if (!spawned) reject(new SafeRpcError("CODEX_LOGIN_START_FAILED"));
      });
      child.once("exit", finish);
    } catch {
      finish();
      reject(new SafeRpcError("CODEX_LOGIN_START_FAILED"));
    }
  });
}

export type CodexHarnessReadiness =
  | { ready: true }
  | {
      ready: false;
      code: "CODEX_HARNESS_UNAVAILABLE" | "CODEX_AUTH_UNAVAILABLE";
      summary: string;
    };

export async function inspectCodexHarnessReadiness(): Promise<CodexHarnessReadiness> {
  const executable = resolveCodexExecutable() ?? (transportFactory ? "codex.exe" : undefined);
  if (!executable) {
    return {
      ready: false,
      code: "CODEX_HARNESS_UNAVAILABLE",
      summary: "本机执行引擎暂不可用。"
    };
  }
  if (transportFactory && !runtimeProbeForTests) return { ready: true };
  const result = await (runtimeProbeForTests ?? defaultCodexRuntimeProbe)({
    executable,
    cwd: process.cwd(),
    env: makeEnvironment()
  });
  if (result === "auth-unavailable") {
    return {
      ready: false,
      code: "CODEX_AUTH_UNAVAILABLE",
      summary: "本机执行授权尚未连接。"
    };
  }
  // Older compatible runtimes may not implement `login status`.  Unknown probe
  // results deliberately fall through to the existing protocol handshake.
  return { ready: true };
}

export type CodexLoginStartResult =
  | { status: "ready"; summary: string }
  | { status: "started" | "already-running"; summary: string }
  | {
      status: "unavailable";
      code: "CODEX_HARNESS_UNAVAILABLE" | "CODEX_LOGIN_START_FAILED";
      summary: string;
    };

export async function startCodexInteractiveLogin(): Promise<CodexLoginStartResult> {
  const readiness = await inspectCodexHarnessReadiness();
  if (readiness.ready) {
    return { status: "ready", summary: "本机执行已连接。" };
  }
  if (readiness.code === "CODEX_HARNESS_UNAVAILABLE") {
    return {
      status: "unavailable",
      code: readiness.code,
      summary: readiness.summary
    };
  }
  if (loginStartInFlight || loginCompletion) {
    return { status: "already-running", summary: "本机授权正在浏览器中进行。" };
  }
  const executable = resolveCodexExecutable() ?? (transportFactory ? "codex.exe" : undefined);
  if (!executable) {
    return {
      status: "unavailable",
      code: "CODEX_HARNESS_UNAVAILABLE",
      summary: "本机执行引擎暂不可用。"
    };
  }
  const start = (async (): Promise<CodexLoginStartResult> => {
    try {
      const handle = await (loginLauncherForTests ?? defaultCodexLoginLauncher)({
        executable,
        cwd: process.cwd(),
        env: makeEnvironment()
      });
      let tracked!: Promise<void>;
      tracked = handle.completed.finally(() => {
        if (loginCompletion === tracked) loginCompletion = undefined;
      });
      loginCompletion = tracked;
      return { status: "started", summary: "已打开本机授权页面。" };
    } catch {
      return {
        status: "unavailable",
        code: "CODEX_LOGIN_START_FAILED",
        summary: "本机授权页面未能打开。"
      };
    }
  })();
  loginStartInFlight = start;
  try {
    return await start;
  } finally {
    if (loginStartInFlight === start) loginStartInFlight = undefined;
  }
}

function defaultTransportFactory(options: {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): CodexTransport {
  const child: ChildProcessWithoutNullStreams = spawn(
    options.executable,
    [...options.args],
    {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  const lines = createInterface({ input: child.stdout });
  const lineListeners = new Set<(line: string) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  let exitOrErrorObserved = false;
  let resolveExitOrError!: () => void;
  const exitOrError = new Promise<void>((resolve) => {
    resolveExitOrError = resolve;
  });
  let closePromise: Promise<void> | undefined;

  const reportExitOrError = (code: number | null) => {
    if (exitOrErrorObserved) return;
    exitOrErrorObserved = true;
    resolveExitOrError();
    for (const listener of exitListeners) listener(code);
  };

  const waitForExitOrError = (): Promise<void> => {
    if (exitOrErrorObserved) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SafeRpcError("CODEX_TRANSPORT_CLOSE_TIMEOUT"));
      }, TRANSPORT_CLOSE_TIMEOUT_MS);
      void exitOrError.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  lines.on("line", (line) => {
    for (const listener of lineListeners) listener(line);
  });
  child.stderr.on("data", () => {
    // stderr intentionally discarded: it may contain paths, prompts or secrets.
  });
  child.on("error", () => reportExitOrError(null));
  child.on("exit", (code) => reportExitOrError(code));
  return {
    send(line) {
      if (!child.stdin.writable) throw new SafeRpcError("CODEX_TRANSPORT_CLOSED");
      child.stdin.write(`${line}\n`);
    },
    onLine(listener) {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    close(force = false) {
      lines.close();
      if (exitOrErrorObserved) return Promise.resolve();
      if (closePromise) return closePromise;
      closePromise = (async () => {
        if (!child.killed) {
          if (force && process.platform === "win32" && child.pid) {
            const fallbackKill = () => {
              if (!exitOrErrorObserved && !child.killed) child.kill("SIGKILL");
            };
            try {
              const killer = spawn(
                "taskkill.exe",
                ["/PID", String(child.pid), "/T", "/F"],
                {
                  cwd: options.cwd,
                  env: options.env,
                  shell: false,
                  detached: false,
                  windowsHide: true,
                  stdio: "ignore"
                }
              );
              killer.once("error", fallbackKill);
              killer.once("exit", (code) => {
                if (code !== 0) fallbackKill();
              });
            } catch {
              fallbackKill();
            }
          } else {
            child.kill(force ? "SIGKILL" : undefined);
          }
        }
        await waitForExitOrError();
      })();
      return closePromise;
    }
  };
}

export const createDefaultWorkbenchTransportForTests = defaultTransportFactory;

function currentTransportFactory(): CodexTransportFactory {
  return transportFactory ?? defaultTransportFactory;
}

export function setCodexTransportFactory(factory: CodexTransportFactory | undefined): void {
  transportFactory = factory;
}

export function setCodexRuntimeProbeForTests(probe: CodexRuntimeProbe | undefined): void {
  runtimeProbeForTests = probe;
}

export function setCodexLoginLauncherForTests(
  launcher: CodexLoginLauncher | undefined
): void {
  loginLauncherForTests = launcher;
}

// Alias kept intentionally narrow so tests can inject only the stdio seam.
export const setWorkbenchTransportFactory = setCodexTransportFactory;

const SENSITIVE_ARTIFACT_BASENAME_HINT = /^(?:\.env(?:\..*)?|.*(?:secret|token|credential|password|passwd|cookie|private[_-]?key|id[_-]?(?:rsa|dsa)|ssh[_-]?key).*|.*\.(?:pem|key|p12|pfx|crt|cer))$/i;

function requestLine(id: number, method: string, params: JsonObject): string {
  const line = JSON.stringify({ id, method, params });
  if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_JSONL_BYTES) {
    throw new SafeRpcError("CODEX_PROTOCOL_LINE_TOO_LARGE");
  }
  return line;
}

function notificationLine(method: string, params: JsonObject): string {
  const line = JSON.stringify({ method, params });
  if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_JSONL_BYTES) {
    throw new SafeRpcError("CODEX_PROTOCOL_LINE_TOO_LARGE");
  }
  return line;
}

function serverResultLine(id: JsonRpcId, result: JsonObject): string {
  const line = JSON.stringify({ id, result });
  if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_JSONL_BYTES) {
    throw new SafeRpcError("CODEX_PROTOCOL_LINE_TOO_LARGE");
  }
  return line;
}

function serverErrorLine(id: JsonRpcId, code: number): string {
  const line = JSON.stringify({
    id,
    error: {
      code,
      message: "WORKBENCH_SERVER_REQUEST_REJECTED"
    }
  });
  if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_JSONL_BYTES) {
    throw new SafeRpcError("CODEX_PROTOCOL_LINE_TOO_LARGE");
  }
  return line;
}

function safeFileChange(
  runId: string,
  item: JsonObject,
  cwd: string
): void {
  const candidates: unknown[] = [item.path, item.filePath, item.filename];
  if (Array.isArray(item.changes)) candidates.push(...item.changes);
  const seen = new Set<string>();
  let accepted = 0;
  let rootReal: string;
  try {
    rootReal = realpathSync.native(cwd);
  } catch {
    rootReal = path.resolve(cwd);
  }

  const isWithinRoot = (target: string): boolean => {
    const relative = path.relative(rootReal, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  for (const candidate of candidates) {
    const raw = typeof candidate === "string" ? candidate : isObject(candidate) ? candidate.path : undefined;
    if (typeof raw !== "string" || !raw.trim()) continue;
    try {
      const absolute = path.resolve(cwd, raw);
      const relative = path.relative(cwd, absolute);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const normalized = relative.replace(/\\/g, "/");
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      if (SENSITIVE_ARTIFACT_BASENAME_HINT.test(path.basename(normalized))) continue;

      // Resolve the existing target or its nearest existing parent so symlinks
      // and Windows reparse points cannot escape the workspace root.
      let probe = absolute;
      while (!existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
      const probeReal = realpathSync.native(probe);
      if (!isWithinRoot(probeReal)) continue;

      const changeKind = statusValue(
        (isObject(candidate) && (candidate.kind || candidate.changeType)) ||
          item.kind ||
          item.changeType
      );
      const kind = changeKind.includes("delete") ? "deleted" : changeKind.includes("create") ? "created" : "updated";
      const artifactId = `artifact-${Buffer.from(normalized).toString("base64url").slice(0, 80)}`;
      const recorded = addWorkbenchArtifact(runId, {
        id: artifactId,
        label: path.basename(normalized),
        relativePath: normalized,
        kind,
        status: "ready",
        observedAt: new Date().toISOString()
      });
      if (!recorded) continue;
      appendWorkbenchEvent(runId, {
        kind: "artifact",
        status: "completed",
        title: "工作区文件已更新",
        summary: "仅记录工作区内的相对制品元数据。",
        artifactId
      });
      accepted += 1;
    } catch {
      continue;
    }
  }
  if (accepted === 0) {
    appendWorkbenchEvent(runId, {
      kind: "artifact",
      status: "info",
      title: "工作区文件变化已观察",
      summary: "文件变化未通过工作区边界核验。"
    });
  }
}

function priorActionEventTitle(actionType: WorkbenchPriorActionReceipt["actionType"]): string {
  switch (actionType) {
    case "navigate":
      return "页面导航已核验";
    case "world.focus_weakest":
      return "课程世界已聚焦弱点";
    case "world.set_view":
      return "课程世界视图已更新";
    case "world.set_window":
      return "课程世界时间窗口已更新";
    case "world.focus_learner":
      return "课程世界焦点已更新";
    case "workbench.show_surface":
      return "控制台工作面已更新";
    case "workbench.set_mode":
      return "控制台模式已更新";
    case "workbench.set_goal":
      return "持续目标设置已更新";
    case "context.attach_focused":
      return "安全页面上下文已附加";
    default:
      return "页面动作已核验";
  }
}

function appendPriorActionReceiptEvents(
  runId: string,
  receipts: readonly WorkbenchPriorActionReceipt[]
): void {
  for (const receipt of receipts.slice(0, 8)) {
    if (!receipt || receipt.status !== "completed") continue;
    appendWorkbenchEvent(runId, {
      kind: "message",
      status: "completed",
      title: priorActionEventTitle(receipt.actionType),
      summary: "页面动作已通过状态回读；未复制页面正文、身份或内部编号。",
      presentationRole: "system"
    });
  }
}

class CodexAppServerSession implements WorkbenchRunSession {
  private readonly runId: string;
  private readonly transport: CodexTransport;
  private readonly options: WorkbenchCodexRunOptions;
  private readonly brainConfig: WorkbenchBrainConfig;
  private readonly preparedCourseTools?:
    PreparedWorkbenchCourseToolTransport;
  private readonly courseToolAbort = new AbortController();
  private readonly dynamicToolCalls =
    new Map<string, DynamicToolCallState>();
  private readonly courseToolLifecyclePhases = new Set<string>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly lunaAliases = new Map<string, string>();
  private readonly activityAliases = new Map<string, string>();
  private readonly openActivityIds = new Map<string, string[]>();
  private nextRequestId = 1;
  private nextPublicActivityId = 1;
  private unsubscribeLine?: () => void;
  private unsubscribeExit?: () => void;
  private closed = false;
  private turnActive = false;
  private lastAgentSummary = "";
  private lastCitations: WorkbenchCitation[] = [];
  private unknownNotificationRecorded = false;
  private unknownItemRecorded = false;
  private retryingConnectionRecorded = false;
  private lunaCount = 0;
  private currentTurnPriorActionReceipts: WorkbenchPriorActionReceipt[] = [];
  private threadId?: string;
  private turnId?: string;

  private constructor(
    runId: string,
    transport: CodexTransport,
    options: WorkbenchCodexRunOptions,
    preparedCourseTools: PreparedWorkbenchCourseToolTransport | undefined,
    brainConfig: WorkbenchBrainConfig
  ) {
    this.runId = runId;
    this.transport = transport;
    this.options = options;
    this.preparedCourseTools = preparedCourseTools;
    this.brainConfig = brainConfig;
    this.unsubscribeLine = transport.onLine((line) => this.handleLine(line));
    this.unsubscribeExit = transport.onExit((code) => this.handleExit(code));
  }

  static async start(
    runId: string,
    prompt: string,
    options: WorkbenchCodexRunOptions = DEFAULT_RUN_OPTIONS
  ): Promise<CodexAppServerSession> {
    const brainConfig = resolveWorkbenchBrainConfig();
    const preparedCourseTools = options.courseToolTransport
      ? prepareWorkbenchCourseToolTransport(options.courseToolTransport)
      : undefined;
    const executable = resolveCodexExecutable() ?? (transportFactory ? "codex.exe" : undefined);
    if (!executable) throw new SafeRpcError("CODEX_HARNESS_UNAVAILABLE");
    const transport = currentTransportFactory()({
      executable,
      args: WORKBENCH_CODEX_APP_SERVER_ARGS,
      cwd: process.cwd(),
      env: makeEnvironment()
    });
    const session = new CodexAppServerSession(
      runId,
      transport,
      options,
      preparedCourseTools,
      brainConfig
    );
    try {
      setWorkbenchRunStatus(runId, "starting", { summary: "本机执行引擎连接正在建立。" });
      const initialize = await session.request("initialize", {
        clientInfo: {
          name: "cmooc-workbench",
          title: "cMOOC Agent Workbench",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [
            "remoteControl/status/changed",
            "reasoning/raw",
            "response/commandOutput/delta",
            "response/fileDiff/delta",
            "commandExecution/outputDelta",
            "fileChange/diffDelta"
          ]
        }
      });
      void initialize;
      await session.notify("initialized", {});
      const thread = await session.request("thread/start", {
        model: brainConfig.executorModel,
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandbox:
          options.collaborationMode === "plan" ||
          options.executionIntent === "inspect"
            ? "read-only"
            : "workspace-write",
        config: {
          apps: { _default: { enabled: false } },
          features: {
            apps: false,
            remote_plugin: false,
            hooks: false,
            skill_mcp_dependency_install: false
          },
          mcp_servers: {},
          web_search: "live",
          tools: { web_search: { context_size: "medium" } },
          history: { persistence: "none" },
          memories: { generate_memories: false },
          allow_login_shell: false,
          sandbox_workspace_write: { network_access: false },
          shell_environment_policy: {
            inherit: "core",
            ignore_default_excludes: false,
            include_only: [...WORKBENCH_SHELL_ENVIRONMENT]
          }
        },
        developerInstructions: buildCodexDeveloperInstructions(
          brainConfig,
          options.collaborationMode
        ),
        ...(preparedCourseTools?.dynamicToolSpecs.length
          ? { dynamicTools: preparedCourseTools.dynamicToolSpecs }
          : {}),
        // Native goals are rejected on ephemeral app-server threads. Keep the
        // ordinary execution path ephemeral, and opt into a local recoverable
        // thread only when the user explicitly enables goal mode.
        ephemeral: !options.goalMode
      });
      session.threadId = extractThreadId(thread);
      if (!session.threadId) throw new SafeRpcError("CODEX_THREAD_MISSING");
      setWorkbenchProtocolIds(runId, { threadId: session.threadId });
      setWorkbenchSession(runId, session);
      if (options.goalMode) {
        await session.request("thread/goal/set", {
          threadId: session.threadId,
          objective: options.courseGoalCode
            ? safeCourseAgentGoalObjective(options.courseGoalCode)
            : "完成当前受约束的本机工作台任务，并保持外部写入与真实发布锁定。",
          status: "active"
        });
        setWorkbenchGoal(runId, {
          status: "active",
          tokensUsed: 0,
          timeUsedSeconds: 0
        });
        appendWorkbenchEvent(runId, {
          kind: "plan",
          status: "info",
          title: "持续目标已建立",
          summary: "工作台历史不保存目标原文；只保留状态与用量。",
          agentKey: "sol",
          agentLabel: "主任务智能体",
          agentRole: "sol"
        });
      }
      const beforeTurn = getWorkbenchRunInternal(runId);
      if (!beforeTurn || beforeTurn.stopRequested || getWorkbenchRun(runId)?.status === "stopped") {
        throw new SafeRpcError("CODEX_STOPPED_BEFORE_START");
      }
      await session.startTurn(prompt, options.priorActionReceipts ?? []);
      setWorkbenchRunStatus(runId, "running", { summary: "主任务智能体正在受约束的本机线程中工作。" });
      return session;
    } catch (error) {
      await session.close(true);
      throw error instanceof SafeRpcError ? error : new SafeRpcError("CODEX_START_FAILED");
    }
  }

  private async request(method: string, params: JsonObject, timeoutMs = RPC_TIMEOUT_MS): Promise<JsonObject> {
    if (this.closed) throw new SafeRpcError("CODEX_TRANSPORT_CLOSED");
    if (!WORKBENCH_RPC_ALLOWLIST.includes(method as (typeof WORKBENCH_RPC_ALLOWLIST)[number])) {
      throw new SafeRpcError("CODEX_RPC_METHOD_NOT_ALLOWED");
    }
    const id = this.nextRequestId++;
    const key = String(id);
    const line = requestLine(id, method, params);
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new SafeRpcError("CODEX_RPC_TIMEOUT"));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      try {
        void Promise.resolve(this.transport.send(line)).catch(() => {
          this.pending.delete(key);
          clearTimeout(timer);
          reject(new SafeRpcError("CODEX_TRANSPORT_ERROR"));
        });
      } catch {
        this.pending.delete(key);
        clearTimeout(timer);
        reject(new SafeRpcError("CODEX_TRANSPORT_ERROR"));
      }
    });
  }

  private async notify(method: string, params: JsonObject): Promise<void> {
    if (this.closed) throw new SafeRpcError("CODEX_TRANSPORT_CLOSED");
    if (!WORKBENCH_RPC_ALLOWLIST.includes(method as (typeof WORKBENCH_RPC_ALLOWLIST)[number])) {
      throw new SafeRpcError("CODEX_RPC_METHOD_NOT_ALLOWED");
    }
    const line = notificationLine(method, params);
    await Promise.resolve(this.transport.send(line)).catch(() => {
      throw new SafeRpcError("CODEX_TRANSPORT_ERROR");
    });
  }

  private async startTurn(
    prompt: string,
    priorActionReceipts: readonly WorkbenchPriorActionReceipt[] = []
  ): Promise<void> {
    if (!this.threadId) throw new SafeRpcError("CODEX_THREAD_MISSING");
    const current = getWorkbenchRun(this.runId);
    if (!current || current.status === "stopped" || getWorkbenchRunInternal(this.runId)?.stopRequested) {
      throw new SafeRpcError("CODEX_STOPPED_BEFORE_START");
    }
    this.turnActive = true;
    this.retryingConnectionRecorded = false;
    // Public answers and plans are scoped to a turn.  Keep the chronological
    // event transcript, but never let a later turn inherit a previous final
    // summary or make an old plan executable when it produced no replacement.
    this.lastAgentSummary = "";
    this.lastCitations = [];
    if (!this.options.courseToolTransport) {
      setWorkbenchPlan(this.runId, { steps: [] });
    }
    this.currentTurnPriorActionReceipts = priorActionReceipts.map((receipt) => ({
      ...receipt
    }));
    setWorkbenchRunStatus(this.runId, "running", { summary: "主任务智能体正在处理新一轮任务。" });
    appendPriorActionReceiptEvents(this.runId, this.currentTurnPriorActionReceipts);
    appendWorkbenchEvent(this.runId, {
      kind: "agent",
      status: "running",
      title: "主任务智能体正在处理任务",
      agentKey: "sol",
      agentLabel: "主任务智能体",
      agentRole: "sol"
    });
    updateWorkbenchAgent(this.runId, {
      key: "sol",
      label: "主任务智能体",
      role: "sol",
      status: "running"
    });
    const response = await this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      effort: this.brainConfig.executorReasoningEffort,
      summary: "none",
      approvalPolicy: "never",
      sandboxPolicy: this.options.collaborationMode === "plan"
        ? { type: "readOnly" }
        : this.options.executionIntent === "inspect"
          ? { type: "readOnly" }
        : {
            type: "workspaceWrite",
            writableRoots: [process.cwd()],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true
          },
      collaborationMode: {
        mode: this.options.collaborationMode,
        settings: {
          model: this.brainConfig.executorModel,
          reasoning_effort: this.brainConfig.executorReasoningEffort,
          developer_instructions: buildCodexDeveloperInstructions(
            this.brainConfig,
            this.options.collaborationMode
          )
        }
      },
      outputSchema: this.options.collaborationMode === "plan"
        ? WORKBENCH_PLAN_RESULT_OUTPUT_SCHEMA
        : WORKBENCH_RESULT_OUTPUT_SCHEMA
    });
    this.turnId = extractTurnId(response);
    if (this.turnId) setWorkbenchProtocolIds(this.runId, { turnId: this.turnId });
  }

  async steer(
    prompt: string,
    priorActionReceipts: readonly WorkbenchPriorActionReceipt[] = []
  ): Promise<void> {
    if (this.closed) throw new SafeRpcError("CODEX_TRANSPORT_CLOSED");
    if (!this.threadId) throw new SafeRpcError("CODEX_THREAD_MISSING");
    appendWorkbenchEvent(this.runId, {
      kind: "message",
      status: "info",
      title: "追加引导已提交",
      summary: "追加内容已交给当前受约束的主任务智能体。",
      presentationRole: "user"
    });
    if (this.turnActive && this.turnId) {
      this.currentTurnPriorActionReceipts = [
        ...this.currentTurnPriorActionReceipts,
        ...priorActionReceipts.map((receipt) => ({ ...receipt }))
      ].slice(-8);
      appendPriorActionReceiptEvents(this.runId, priorActionReceipts);
      await this.request("turn/steer", {
        threadId: this.threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        expectedTurnId: this.turnId
      });
    } else {
      await this.startTurn(prompt, priorActionReceipts);
    }
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    markWorkbenchStopRequested(this.runId);
    const threadId = this.threadId;
    const turnId = this.turnId;
    if (threadId && turnId && this.turnActive) {
      try {
        await this.request(
          "turn/interrupt",
          { threadId, turnId },
          STOP_TIMEOUT_MS
        );
      } catch {
        // A missing interrupt response is followed by killing only this child.
      }
    }
    await this.close(true, true);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    if (Buffer.byteLength(line, "utf8") > MAX_RESPONSE_JSONL_BYTES) {
      if (this.projectOversizedCompletedCommand(line)) return;
      this.fail("CODEX_PROTOCOL_LINE_TOO_LARGE");
      return;
    }
    let message: Notification;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isObject(parsed)) return;
      message = parsed;
    } catch {
      this.fail("CODEX_PROTOCOL_INVALID_JSON");
      return;
    }
    if (
      (typeof message.id === "string" ||
        (typeof message.id === "number" &&
          Number.isSafeInteger(message.id))) &&
      typeof message.method === "string"
    ) {
      void this.handleServerRequest(
        message.id,
        message.method,
        message.params
      );
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error !== undefined) pending.reject(new SafeRpcError("CODEX_RPC_ERROR"));
      else pending.resolve(isObject(message.result) ? message.result : {});
      return;
    }
    if (typeof message.method === "string") {
      this.handleNotification(message.method, message.params);
    }
  }

  private async sendServerResult(
    id: JsonRpcId,
    response: DynamicToolCallResponse
  ): Promise<void> {
    if (this.closed) return;
    let line: string;
    try {
      line = serverResultLine(id, response as unknown as JsonObject);
    } catch {
      line = serverResultLine(
        id,
        this.dynamicToolFailure(
          "COURSE_TOOL_RESULT_TOO_LARGE",
          false
        ) as unknown as JsonObject
      );
    }
    await Promise.resolve(this.transport.send(line));
  }

  private async sendServerError(
    id: JsonRpcId,
    code: number
  ): Promise<void> {
    if (this.closed) return;
    await Promise.resolve(
      this.transport.send(serverErrorLine(id, code))
    );
  }

  private dynamicToolFailure(
    code: string,
    retryable: boolean
  ): DynamicToolCallResponse {
    return {
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            schemaVersion:
              "cmooc.workbench-course-tool-result.v1",
            status: "failed",
            code,
            retryable,
            safety: {
              containsForumText: false,
              containsIdentity: false,
              containsSecrets: false,
              realPublishEnabled: false
            }
          })
        }
      ]
    };
  }

  private dynamicToolSuccess(
    projection: ReturnType<
      WorkbenchCourseToolTransport["invoke"]
    > extends Promise<infer T> ? T : never
  ): DynamicToolCallResponse {
    return {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            schemaVersion:
              "cmooc.workbench-course-tool-result.v1",
            status: "succeeded",
            summary: projection.safeSummary,
            data: projection.model,
            safety: {
              containsForumText: false,
              containsIdentity: false,
              containsSecrets: false,
              realPublishEnabled: false
            }
          })
        }
      ]
    };
  }

  private recordCourseToolLifecycle(
    callId: string,
    descriptor: WorkbenchCourseToolDescriptor,
    phase: "started" | "completed" | "failed"
  ): void {
    const phaseKey = `${callId}:${phase}`;
    if (this.courseToolLifecyclePhases.has(phaseKey)) return;
    this.courseToolLifecyclePhases.add(phaseKey);
    const toolKey = `course-tool:${descriptor.protocolName}`;
    const existingTool = getWorkbenchRun(this.runId)?.tools.find(
      (tool) => tool.key === toolKey
    );
    updateWorkbenchTool(this.runId, {
      key: toolKey,
      label: descriptor.safeLabel,
      category: "other",
      status: phase === "started"
        ? "running"
        : phase === "completed"
          ? "completed"
          : "failed",
      callCount:
        (existingTool?.callCount ?? 0) +
        (phase === "started" ? 1 : 0)
    });
    appendWorkbenchEvent(this.runId, {
      kind: "tool",
      status: phase === "started"
        ? "running"
        : phase === "completed"
          ? "completed"
          : "failed",
      title: descriptor.safeLabel,
      summary: phase === "started"
        ? "课程工具正在执行；业务参数与内部权限上下文不会显示。"
        : phase === "completed"
          ? "安全工具结果已返回；执行事实以持久回执与验证记录为准。"
          : "课程工具未能形成可验证结果；未扩大权限或执行发布。",
      toolKey,
      activityId: this.publicActivityId(
        { callId, type: "dynamicToolCall" },
        phase === "started" ? "started" : "completed",
        "dynamictoolcall"
      )
    });
  }

  private async invokeDynamicCourseTool(input: {
    callId: string;
    descriptor: WorkbenchCourseToolDescriptor;
    argumentsValue: unknown;
  }): Promise<DynamicToolCallResponse> {
    const transport = this.options.courseToolTransport;
    if (!transport || this.courseToolAbort.signal.aborted) {
      return this.dynamicToolFailure(
        "COURSE_TOOL_TRANSPORT_UNAVAILABLE",
        false
      );
    }
    this.recordCourseToolLifecycle(
      input.callId,
      input.descriptor,
      "started"
    );
    try {
      const request = parseWorkbenchCourseToolInvocation({
        descriptor: input.descriptor,
        argumentsValue: input.argumentsValue
      });
      const projection = await transport.invoke({
        runId: this.runId,
        callId: input.callId,
        request,
        signal: this.courseToolAbort.signal
      });
      assertWorkbenchCourseToolResult(projection);
      this.recordCourseToolLifecycle(
        input.callId,
        input.descriptor,
        "completed"
      );
      return this.dynamicToolSuccess(projection);
    } catch {
      this.recordCourseToolLifecycle(
        input.callId,
        input.descriptor,
        "failed"
      );
      return this.dynamicToolFailure(
        this.courseToolAbort.signal.aborted
          ? "COURSE_TOOL_CALL_ABORTED"
          : "COURSE_TOOL_CALL_REJECTED",
        false
      );
    }
  }

  private async handleServerRequest(
    id: JsonRpcId,
    method: string,
    params: unknown
  ): Promise<void> {
    try {
      if (
        method !== "item/tool/call" ||
        !this.preparedCourseTools ||
        !this.options.courseToolTransport
      ) {
        await this.sendServerError(id, -32601);
        return;
      }
      if (!isObject(params)) {
        await this.sendServerResult(
          id,
          this.dynamicToolFailure("COURSE_TOOL_CALL_INVALID", false)
        );
        return;
      }
      const callId = stringValue(params.callId);
      const threadId = stringValue(params.threadId);
      const turnId = stringValue(params.turnId);
      const protocolName = stringValue(params.tool);
      if (
        !callId ||
        callId.length > 160 ||
        !threadId ||
        threadId !== this.threadId ||
        !turnId ||
        turnId !== this.turnId ||
        !protocolName ||
        params.namespace !== undefined && params.namespace !== null
      ) {
        await this.sendServerResult(
          id,
          this.dynamicToolFailure("COURSE_TOOL_CALL_INVALID", false)
        );
        return;
      }
      const descriptor =
        this.preparedCourseTools.byProtocolName.get(protocolName);
      if (!descriptor) {
        await this.sendServerResult(
          id,
          this.dynamicToolFailure("COURSE_TOOL_NOT_REGISTERED", false)
        );
        return;
      }
      let fingerprint: string;
      try {
        fingerprint = fingerprintWorkbenchCourseToolCall({
          protocolName,
          argumentsValue: params.arguments,
          threadId,
          turnId
        });
      } catch {
        await this.sendServerResult(
          id,
          this.dynamicToolFailure("COURSE_TOOL_CALL_INVALID", false)
        );
        return;
      }
      const existing = this.dynamicToolCalls.get(callId);
      if (existing) {
        await this.sendServerResult(
          id,
          existing.fingerprint === fingerprint
            ? await existing.result
            : this.dynamicToolFailure(
                "COURSE_TOOL_CALL_ID_CONFLICT",
                false
              )
        );
        return;
      }
      if (
        this.dynamicToolCalls.size >=
        MAX_DYNAMIC_TOOL_CALLS_PER_RUN
      ) {
        await this.sendServerResult(
          id,
          this.dynamicToolFailure("COURSE_TOOL_CALL_LIMIT", false)
        );
        return;
      }
      const result = this.invokeDynamicCourseTool({
        callId,
        descriptor,
        argumentsValue: params.arguments
      });
      this.dynamicToolCalls.set(callId, {
        fingerprint,
        descriptor,
        result
      });
      await this.sendServerResult(id, await result);
    } catch {
      this.fail("CODEX_DYNAMIC_TOOL_RESPONSE_FAILED");
    }
  }

  private handleExit(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending("CODEX_PROCESS_EXIT");
    const current = getWorkbenchRun(this.runId);
    if (!current || current.status === "completed" || current.status === "failed" || current.status === "stopped") return;
    if (current.status === "queued" || current.status === "starting" || current.status === "running") {
      if (current.status === "running" && code === 0 && this.lastAgentSummary) {
        completeWorkbenchRun(
          this.runId,
          "completed",
          this.lastAgentSummary,
          undefined,
          this.lastCitations
        );
      } else if (getWorkbenchRunInternal(this.runId)?.stopRequested) {
        completeWorkbenchRun(this.runId, "stopped", "任务已中断。", "CODEX_INTERRUPTED");
      } else {
        completeWorkbenchRun(this.runId, "failed", "本机执行进程未能完成任务。", "CODEX_PROCESS_EXIT");
      }
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "thread/started") {
      const id = extractThreadId(params);
      if (id) {
        this.threadId = id;
        setWorkbenchProtocolIds(this.runId, { threadId: id });
      }
      appendWorkbenchEvent(this.runId, {
        kind: "run",
        status: "running",
        title: "临时工作线程已建立",
        summary: "本次运行使用一次性本机线程。"
      });
      return;
    }
    if (method === "turn/started") {
      const id = extractTurnId(params);
      if (id) {
        this.turnId = id;
        setWorkbenchProtocolIds(this.runId, { turnId: id });
      }
      this.turnActive = true;
      setWorkbenchRunStatus(this.runId, "running");
      return;
    }
    if (method === "turn/completed") {
      this.turnActive = false;
      const status = isObject(params) ? statusValue(isObject(params.turn) ? params.turn.status : params.status) : "";
      if (status.includes("interrupt") || status.includes("cancel") || status === "stopped") {
        updateWorkbenchAgent(this.runId, {
          key: "sol",
          label: "主任务智能体",
          role: "sol",
          status: "stopped"
        });
        completeWorkbenchRun(this.runId, "stopped", "任务已中断。", "CODEX_INTERRUPTED");
      } else if (status.includes("fail") || status === "error") {
        updateWorkbenchAgent(this.runId, {
          key: "sol",
          label: "主任务智能体",
          role: "sol",
          status: "failed"
        });
        completeWorkbenchRun(this.runId, "failed", "本机执行任务未能完成。", "CODEX_TURN_FAILED");
      } else {
        const pendingAction =
          this.options.courseToolTransport?.pendingInteraction?.() ?? null;
        if (pendingAction) {
          updateWorkbenchAgent(this.runId, {
            key: "sol",
            label: "主任务智能体",
            role: "sol",
            status: "idle"
          });
          setWorkbenchPendingAction(this.runId, pendingAction);
          setWorkbenchRunStatus(this.runId, "awaiting_action", {
            summary:
              "已准备一次精确的测试平台暂存与清空操作；发布与通知仍为 0。"
          });
          return;
        }
        updateWorkbenchAgent(this.runId, {
          key: "sol",
          label: "主任务智能体",
          role: "sol",
          status: "completed"
        });
        completeWorkbenchRun(
          this.runId,
          "completed",
          this.lastAgentSummary ||
            "本机执行已经结束，但本轮没有返回可展示的完整答复。过程事件与坚果云会话目录已保留；可以在当前任务中追加更明确的验收要求，或从保留上下文重新启动。",
          undefined,
          this.lastCitations
        );
      }
      return;
    }
    if (method === "turn/plan/updated") {
      const payload = isObject(params) ? params : {};
      const rawPlan = Array.isArray(payload.plan) ? payload.plan : [];
      const steps = rawPlan.flatMap((entry) => {
        if (!isObject(entry) || typeof entry.step !== "string") return [];
        const rawStatus = statusValue(entry.status);
        const status: WorkbenchPlanStepStatus = rawStatus === "completed"
          ? "completed"
          : rawStatus === "inprogress" || rawStatus === "in_progress" || rawStatus === "running"
            ? "inProgress"
            : "pending";
        const safeStep = safeAgentMessage(entry.step).slice(0, 240);
        return safeStep ? [{ step: safeStep, status }] : [];
      });
      if (!this.options.courseToolTransport) {
        setWorkbenchPlan(this.runId, {
          explanation: typeof payload.explanation === "string"
            ? safeAgentMessage(payload.explanation).slice(0, 600)
            : undefined,
          steps
        });
      }
      const completedCount = steps.filter((step) => step.status === "completed").length;
      const runningCount = steps.filter((step) => step.status === "inProgress").length;
      appendWorkbenchEvent(this.runId, {
        kind: "plan",
        status: runningCount > 0 ? "running" : completedCount === steps.length && steps.length > 0 ? "completed" : "info",
        title: "执行计划已更新",
        summary: `${steps.length} 步 · ${completedCount} 已完成${runningCount ? ` · ${runningCount} 进行中` : ""}`,
        agentKey: "sol",
        agentLabel: "主任务智能体",
        agentRole: "sol"
      });
      return;
    }
    if (method === "thread/goal/updated") {
      const goal = isObject(params) && isObject(params.goal) ? params.goal : undefined;
      if (!goal) return;
      const rawStatus = typeof goal.status === "string" ? goal.status : "active";
      const goalStatuses = new Set<WorkbenchGoalStatus>([
        "active",
        "paused",
        "blocked",
        "usageLimited",
        "budgetLimited",
        "complete"
      ]);
      const status = goalStatuses.has(rawStatus as WorkbenchGoalStatus)
        ? rawStatus as WorkbenchGoalStatus
        : "active";
      setWorkbenchGoal(this.runId, {
        status,
        tokenBudget: typeof goal.tokenBudget === "number" ? goal.tokenBudget : undefined,
        tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0,
        timeUsedSeconds: typeof goal.timeUsedSeconds === "number" ? goal.timeUsedSeconds : 0
      });
      appendWorkbenchEvent(this.runId, {
        kind: "plan",
        status: status === "complete" ? "completed" : status === "blocked" ? "failed" : "info",
        title: status === "complete" ? "持续目标已完成" : "持续目标状态已更新",
        summary: "工作台历史不保存目标原文；仅更新状态与用量。",
        agentKey: "sol",
        agentLabel: "主任务智能体",
        agentRole: "sol"
      });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = extractItem(params);
      if (!item) {
        if (!this.unknownNotificationRecorded && !this.unknownItemRecorded) {
          this.unknownItemRecorded = true;
          appendWorkbenchEvent(this.runId, {
            kind: "warning",
            status: "info",
            title: "已忽略未识别的线程项目",
            summary: "为保护工作台边界，未识别项目不会转发到浏览器。"
          });
        }
        return;
      }
      this.mapItem(item, method === "item/started" ? "started" : "completed");
      return;
    }
    if (method === "error" || method === "turn/error") {
      if (isObject(params) && params.willRetry === true) {
        setWorkbenchRunStatus(this.runId, "running", {
          summary: "本机执行连接短暂中断，正在自动重试。"
        });
        updateWorkbenchAgent(this.runId, {
          key: "sol",
          label: "主任务智能体",
          role: "sol",
          status: "running"
        });
        if (!this.retryingConnectionRecorded) {
          this.retryingConnectionRecorded = true;
          appendWorkbenchEvent(this.runId, {
            kind: "warning",
            status: "info",
            title: "执行连接正在自动重试",
            summary: "本机执行流短暂中断；原生引擎已接管重试，任务仍在运行。"
          });
        }
        return;
      }
      const projected = projectRemoteError(params);
      updateWorkbenchAgent(this.runId, {
        key: "sol",
        label: "主任务智能体",
        role: "sol",
        status: "failed"
      });
      completeWorkbenchRun(this.runId, "failed", projected.summary, projected.code);
      return;
    }
    if (!this.unknownNotificationRecorded && !this.unknownItemRecorded) {
      this.unknownNotificationRecorded = true;
      appendWorkbenchEvent(this.runId, {
        kind: "warning",
        status: "info",
        title: "已忽略未识别的本机事件",
        summary: "为保护工作台边界，未识别事件不会转发到浏览器。"
      });
    }
  }

  private activityCategory(type: string): string {
    if (type === "commandexecution" || type === "command_execution" || type === "shell") {
      return "command";
    }
    if (
      type === "mcptoolcall" ||
      type === "mcp_tool_call" ||
      type === "dynamictoolcall" ||
      type === "dynamic_tool_call"
    ) {
      return "external-tool";
    }
    if (
      type === "collabagenttoolcall" ||
      type === "collab_agent_tool_call" ||
      type === "subagentactivity" ||
      type === "sub_agent_activity"
    ) {
      return "collaboration";
    }
    if (type === "websearch" || type === "web_search") return "web-search";
    if (type === "imageview" || type === "image_view") return "image-view";
    return type || "item";
  }

  private publicActivityId(
    item: JsonObject,
    phase: "started" | "completed",
    type: string
  ): string {
    const nativeId = stringValue(item.id) ||
      stringValue(item.itemId) ||
      stringValue(item.item_id) ||
      stringValue(item.callId) ||
      stringValue(item.call_id);
    const category = this.activityCategory(type);
    const open = this.openActivityIds.get(category) ?? [];
    let activityId = nativeId ? this.activityAliases.get(nativeId) : undefined;

    if (!activityId && phase === "completed" && !nativeId) {
      activityId = open.shift();
    }
    if (!activityId) {
      activityId = `activity-${this.nextPublicActivityId++}`;
      if (nativeId) this.activityAliases.set(nativeId, activityId);
    }

    if (phase === "started") {
      if (!open.includes(activityId)) open.push(activityId);
    } else {
      const openIndex = open.indexOf(activityId);
      if (openIndex >= 0) open.splice(openIndex, 1);
    }
    if (open.length) this.openActivityIds.set(category, open);
    else this.openActivityIds.delete(category);
    return activityId;
  }

  private configuredCourseToolItem(item: JsonObject): {
    callId: string;
    descriptor: WorkbenchCourseToolDescriptor;
  } | undefined {
    if (!this.preparedCourseTools) return undefined;
    const protocolName =
      stringValue(item.tool) ||
      stringValue(item.toolName) ||
      stringValue(item.name);
    const callId =
      stringValue(item.callId) ||
      stringValue(item.call_id) ||
      stringValue(item.id) ||
      stringValue(item.itemId) ||
      stringValue(item.item_id);
    if (!protocolName || !callId) return undefined;
    const descriptor =
      this.preparedCourseTools.byProtocolName.get(protocolName);
    return descriptor ? { callId, descriptor } : undefined;
  }

  private mapItem(item: JsonObject, phase: "started" | "completed"): void {
    const type = statusValue(item.type);
    const status = eventStatus(itemStatus(item, phase === "started" ? "running" : "completed"));
    const activityId = this.publicActivityId(item, phase, type);
    if (type === "agentmessage" || type === "agent_message" || type === "assistantmessage" || type === "assistant_message") {
      if (phase === "completed") {
        const parsedStructured = safeStructuredFinal(item, this.options.collaborationMode);
        const structured = parsedStructured && this.currentTurnPriorActionReceipts.length
          ? reconcileVerifiedPageActionFinal(
              parsedStructured,
              this.currentTurnPriorActionReceipts
            )
          : parsedStructured;
        const structuredText = structured
          ? formatStructuredFinal(structured, this.options.collaborationMode)
          : undefined;
        const nativePlan = this.options.collaborationMode === "plan"
          ? safeNativePlanFinal(item)
          : undefined;
        const text = structuredText ?? nativePlan?.summary;
        const isFinal = statusValue(item.phase) === "final_answer";
        const planSteps = nativePlan?.steps.length
          ? nativePlan.steps
          : this.options.collaborationMode === "plan" && structured?.planSteps.length
            ? structured.planSteps.map((step) => ({
                step,
                status: "pending" as const
              }))
            : [];
        if (
          isFinal &&
          planSteps.length &&
          !this.options.courseToolTransport
        ) {
          setWorkbenchPlan(this.runId, {
            explanation: structured?.summary ?? nativePlan?.summary,
            steps: planSteps
          });
          appendWorkbenchEvent(this.runId, {
            kind: "plan",
            status: "completed",
            title: "验收计划已生成",
            summary: `${planSteps.length} 步 · 等待执行`,
            agentKey: "sol",
            agentLabel: "主任务智能体",
            agentRole: "sol",
            activityId
          });
        }
        if (isFinal) {
          this.lastCitations = structured?.citations ?? [];
          if (text) {
            this.lastAgentSummary = text;
          } else if (!(this.options.collaborationMode === "plan" && this.lastAgentSummary)) {
            this.lastAgentSummary = "主任务智能体已完成；公开摘要未通过安全契约，原始内容未展示。";
          }
        }
        appendWorkbenchEvent(this.runId, {
          kind: "message",
          status: "completed",
          title: isFinal ? "主任务智能体返回公开结果" : "执行进展",
          summary: isFinal
            ? this.lastAgentSummary
            : "收到一条过程更新；内部推理与运行细节未展示。",
          liveExcerpt: isFinal ? undefined : safeLiveAgentExcerpt(item),
          agentKey: "sol",
          agentLabel: "主任务智能体",
          agentRole: "sol",
          activityId
        });
      } else {
        appendWorkbenchEvent(this.runId, {
          kind: "agent",
          status: "running",
          title: "主任务智能体正在生成消息",
          agentKey: "sol",
          agentLabel: "主任务智能体",
          agentRole: "sol",
          activityId
        });
      }
      return;
    }
    if (type === "plan") {
      const projectedPlan = phase === "completed" && this.options.collaborationMode === "plan"
        ? safePlanProjection(item)
        : undefined;
      if (projectedPlan) {
        this.lastAgentSummary = projectedPlan.summary;
        if (
          projectedPlan.steps.length &&
          !this.options.courseToolTransport
        ) {
          setWorkbenchPlan(this.runId, {
            explanation: projectedPlan.summary,
            steps: projectedPlan.steps
          });
        }
      }
      appendWorkbenchEvent(this.runId, {
        kind: "plan",
        status,
        title: phase === "started" ? "计划正在整理" : "验收计划已生成",
        summary: projectedPlan?.steps.length
          ? `${projectedPlan.steps.length} 步 · 等待执行`
          : "计划内容已按安全边界摘要化。",
        agentKey: "sol",
        agentLabel: "主任务智能体",
        agentRole: "sol",
        activityId
      });
      return;
    }
    if (type === "reasoning") {
      appendWorkbenchEvent(this.runId, {
        kind: "agent",
        status,
        title: "主任务智能体正在分析任务",
        summary: "分析内容不会显示在工作台。",
        agentKey: "sol",
        agentLabel: "主任务智能体",
        agentRole: "sol",
        activityId
      });
      return;
    }
    if (type === "commandexecution" || type === "command_execution" || type === "shell") {
      const toolKey = "command";
      const existingTool = getWorkbenchRun(this.runId)?.tools.find((tool) => tool.key === toolKey);
      updateWorkbenchTool(this.runId, {
        key: toolKey,
        label: "命令工具",
        category: "shell",
        status: status === "stopped" ? "stopped" : status === "failed" ? "failed" : status === "running" ? "running" : "completed",
        callCount: (existingTool?.callCount ?? 0) + (phase === "started" || !existingTool ? 1 : 0)
      });
      appendWorkbenchEvent(this.runId, {
        kind: "tool",
        status,
        title: "命令工具",
        toolKey,
        activityId
      });
      return;
    }
    if (type === "filechange" || type === "file_change") {
      safeFileChange(this.runId, item, process.cwd());
      return;
    }
    if (type === "mcptoolcall" || type === "mcp_tool_call" || type === "dynamictoolcall" || type === "dynamic_tool_call") {
      const configured = type.includes("dynamic")
        ? this.configuredCourseToolItem(item)
        : undefined;
      if (configured) {
        this.recordCourseToolLifecycle(
          configured.callId,
          configured.descriptor,
          phase === "started"
            ? "started"
            : status === "failed" || status === "stopped"
              ? "failed"
              : "completed"
        );
        return;
      }
      const toolKey = "external-tool";
      const existingTool = getWorkbenchRun(this.runId)?.tools.find((tool) => tool.key === toolKey);
      updateWorkbenchTool(this.runId, {
        key: toolKey,
        label: "外部工具事件（已隐藏）",
        category: "other",
        status: status === "stopped" ? "stopped" : status === "failed" ? "failed" : status === "running" ? "running" : "completed",
        callCount: (existingTool?.callCount ?? 0) + (phase === "started" || !existingTool ? 1 : 0)
      });
      appendWorkbenchEvent(this.runId, {
        kind: "tool",
        status,
        title: "外部工具事件已拦截",
        summary: "工具来源与参数不会显示；真实工作台配置已禁用 MCP 与 Apps。",
        toolKey,
        activityId
      });
      return;
    }
    if (type === "collabagenttoolcall" || type === "collab_agent_tool_call" || type === "subagentactivity" || type === "sub_agent_activity") {
      const receiverThreadId = Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.find((value): value is string => typeof value === "string" && value.trim().length > 0)
        : undefined;
      const stateThreadId = isObject(item.agentsStates)
        ? Object.keys(item.agentsStates)[0]
        : undefined;
      const rawKey =
        stringValue(item.agentThreadId) ||
        receiverThreadId ||
        stateThreadId ||
        stringValue(item.agentId || item.agentKey) ||
        "collaboration-default";
      let alias = this.lunaAliases.get(rawKey);
      if (!alias) {
        alias = `luna-${++this.lunaCount}`;
        this.lunaAliases.set(rawKey, alias);
      }
      const label = `协作智能体 #${alias.replace(/^luna-/, "")}`;
      const phaseLabel = phase === "started" ? "协作子任务已开始" : "协作子任务已更新";
      updateWorkbenchAgent(this.runId, {
        key: alias,
        label,
        role: "luna",
        status: status === "stopped" ? "stopped" : status === "failed" ? "failed" : status === "running" ? "running" : "completed",
        taskSummary: "受约束的协作子任务"
      });
      appendWorkbenchEvent(this.runId, {
        kind: "agent",
        status,
        title: phaseLabel,
        summary: "任务摘要已安全化处理。",
        agentKey: alias,
        agentLabel: label,
        agentRole: "luna",
        activityId
      });
      return;
    }
    if (type === "websearch" || type === "web_search" || type === "imageview" || type === "image_view") {
      const toolKey = type.includes("image") ? "image-view" : "web-search";
      const label = type.includes("image") ? "图像观察" : "网页检索";
      const existingTool = getWorkbenchRun(this.runId)?.tools.find((tool) => tool.key === toolKey);
      updateWorkbenchTool(this.runId, {
        key: toolKey,
        label,
        category: "search",
        status: status === "stopped" ? "stopped" : status === "failed" ? "failed" : status === "running" ? "running" : "completed",
        callCount: (existingTool?.callCount ?? 0) + (phase === "started" || !existingTool ? 1 : 0)
      });
      appendWorkbenchEvent(this.runId, {
        kind: "tool",
        status,
        title: label,
        summary: "仅显示安全工具状态。",
        toolKey,
        activityId
      });
      return;
    }
    if (!this.unknownNotificationRecorded && !this.unknownItemRecorded) {
      this.unknownItemRecorded = true;
      appendWorkbenchEvent(this.runId, {
        kind: "warning",
        status: "info",
        title: "已忽略未识别的线程项目",
        summary: "为保护工作台边界，未识别项目不会转发到浏览器。"
      });
    }
  }

  private projectOversizedCompletedCommand(line: string): boolean {
    const prefix = line.slice(0, Math.min(line.length, MAX_REQUEST_JSONL_BYTES)).toLowerCase();
    if (
      !prefix.includes('"method":"item/completed"') ||
      !(
        prefix.includes('"type":"commandexecution"') ||
        prefix.includes('"type":"command_execution"') ||
        prefix.includes('"type":"shell"')
      )
    ) {
      return false;
    }
    this.mapItem({ type: "commandExecution", status: "completed" }, "completed");
    appendWorkbenchEvent(this.runId, {
      kind: "warning",
      status: "info",
      title: "过大的命令输出已省略",
      summary: "命令状态已保留，原始输出未进入工作台或持久化记录。"
    });
    return true;
  }

  private rejectPending(code: string): void {
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new SafeRpcError(code));
      this.pending.delete(key);
    }
  }

  private fail(code: string): void {
    if (this.closed) return;
    completeWorkbenchRun(this.runId, "failed", "本机执行引擎通信未能完成。", code);
    void this.close(true);
  }

  private async close(force: boolean, requireConfirmation = false): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.courseToolAbort.abort();
    this.unsubscribeLine?.();
    this.unsubscribeExit?.();
    this.rejectPending("CODEX_TRANSPORT_CLOSED");
    try {
      await Promise.resolve(this.transport.close(force));
    } catch {
      if (requireConfirmation) throw new SafeRpcError("CODEX_TRANSPORT_CLOSE_UNCONFIRMED");
    }
  }
}

export async function startCodexAppServerRun(
  runId: string,
  prompt: string,
  options: WorkbenchCodexRunOptions = DEFAULT_RUN_OPTIONS
): Promise<WorkbenchRunSession> {
  return CodexAppServerSession.start(runId, prompt, options);
}

export function resetCodexAppServerForTests(): void {
  transportFactory = undefined;
  runtimeProbeForTests = undefined;
  loginLauncherForTests = undefined;
  loginStartInFlight = undefined;
  loginCompletion = undefined;
}

export const resetForTests = resetCodexAppServerForTests;

export const CODEX_PROTOCOL_MAX_REQUEST_LINE_BYTES = MAX_REQUEST_JSONL_BYTES;
export const CODEX_PROTOCOL_MAX_RESPONSE_LINE_BYTES = MAX_RESPONSE_JSONL_BYTES;
export const CODEX_PROTOCOL_MAX_LINE_BYTES = MAX_RESPONSE_JSONL_BYTES;
