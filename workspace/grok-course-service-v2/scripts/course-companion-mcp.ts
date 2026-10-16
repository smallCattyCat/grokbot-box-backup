import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z, ZodError } from "zod";
import {
  createBrowserCourseSchema,
  browserObservationSchema,
  browserProposalSchema,
  browserReplyReceiptSchema,
  browserStageSchema,
  browserReplyUptakeSchema,
  browserParticipationChoiceSchema,
  MAX_BROWSER_DISCUSSIONS
} from "../lib/workbench/browser-course-contracts";
import {
  PortableCourseClient,
  PortableCourseClientError,
  type PortableCourseClientOptions
} from "../lib/workbench/portable-course-client";
import { openPortableMcpSession, PortableMcpSessionError, type PortableMcpSessionHandle } from "../lib/workbench/portable-mcp-session";

/**
 * A portable service and the stdio MCP live on the same host.  The explicit
 * mode switch keeps the existing Codex plugin's browser-agent workspace check
 * compatible while letting a Grok/other host use the independent service.
 */
const portableMode = process.env.CMOOC_PORTABLE_MODE === "1" || Boolean(process.env.CMOOC_PORTABLE_SERVICE_ORIGIN || process.env.CMOOC_SERVICE_DATA_DIR);
const packageRoot = (() => {
  const configured = process.env.CMOOC_WORKBENCH_ROOT;
  if (configured) {
    const root = path.resolve(configured);
    if (existsSync(path.join(root, "package.json"))) return root;
    if (existsSync(path.join(root, "源码", "package.json"))) return path.join(root, "源码");
  }
  const cwd = path.resolve(process.cwd());
  return existsSync(path.join(cwd, "package.json")) ? cwd : existsSync(path.join(cwd, "源码", "package.json")) ? path.join(cwd, "源码") : cwd;
})();
function legacyDataDir(): string {
  let root = process.env.CMOOC_WORKBENCH_ROOT || packageRoot;
  if (!existsSync(path.join(root, "package.json")) && existsSync(path.join(root, "源码", "package.json"))) root = path.join(root, "源码");
  const workspace = createHash("sha256").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 20);
  const local = process.env.LOCALAPPDATA || path.join(homedir(), ".local", "share");
  const namespace = process.env.CMOOC_BROWSER_WORKSPACE_NAMESPACE;
  if (namespace && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(namespace)) throw new Error("BROWSER_WORKSPACE_NAMESPACE_INVALID");
  const storage = path.join(local, "cmooc-workbench", "browser-courses", workspace);
  return namespace ? path.join(storage, "isolated", namespace) : storage;
}

const clientOptions: PortableCourseClientOptions = {
  serviceOrigin: portableMode
    ? process.env.CMOOC_PORTABLE_SERVICE_ORIGIN || process.env.CMOOC_WORKBENCH_ORIGIN || "http://127.0.0.1:3050"
    : process.env.CMOOC_WORKBENCH_ORIGIN || "http://127.0.0.1:3017",
  dataDir: portableMode ? process.env.CMOOC_SERVICE_DATA_DIR : undefined,
  bridgeKeyPath: portableMode ? undefined : path.join(legacyDataDir(), "bridge-key"),
  bridgeKey: portableMode ? undefined : process.env.CMOOC_WORKBENCH_BRIDGE_KEY,
  fixedRunId: process.env.CMOOC_COURSE_RUN_ID,
  executionRunId: process.env.CMOOC_COURSE_EXECUTION_ID,
  workspaceTransport: portableMode ? "portable" : "agent",
  requireProtocolIdentity: portableMode,
};
const server = new McpServer({ name: portableMode ? "course-companion-v2" : "course-companion", version: portableMode ? "2.0.0" : "0.2.0" });

const runInput = z.string().uuid().optional().describe("任务编号；由创建任务或工作台交接提供。绑定运行时可省略。");
const requiredRunInput = z.string().uuid().describe("课程任务编号。");
const courseIdInput = z.string().uuid().describe("已登记课程编号。");
const optionalCourseIdInput = z.string().uuid().optional().describe("可选课程编号；省略时返回全部课程摘要。");
const operationInput = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional().describe("可选的稳定操作编号；重试同一请求时复用，数据冲突会被拒绝。");
const modeInput = z.enum(["observe", "stage"]).describe("observe 只保存观察和建议；stage 允许编辑器回读但仍禁止提交。");

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function stableError(error: unknown): {
  error: string;
  message: string;
  code: string;
  stage: string;
  retryable: boolean;
  recoveryAction: string;
  operationId?: string;
  savedProgress?: unknown;
} {
  if (error instanceof PortableCourseClientError) {
    return {
      error: error.message,
      message: error.message,
      code: error.details.code,
      stage: error.details.stage,
      retryable: error.details.retryable,
      recoveryAction: error.details.recoveryAction,
      ...(error.details.operationId ? { operationId: error.details.operationId } : {}),
      ...(error.details.savedProgress !== undefined ? { savedProgress: error.details.savedProgress } : {})
    };
  }
  if (error instanceof ZodError) {
    return {
      error: "输入结构无效。",
      message: "输入结构无效。",
      code: "INPUT_INVALID",
      stage: "validate",
      retryable: false,
      recoveryAction: "fix_input"
    };
  }
  return {
    error: "课程工具执行失败。",
    message: "课程工具执行失败。",
    code: "COURSE_TOOL_FAILED",
    stage: "connector",
    retryable: true,
    recoveryAction: "check_service_and_retry"
  };
}

function errorResult(error: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(stableError(error)) }] };
}

function register<T extends z.ZodRawShape>(name: string, description: string, schema: T, handler: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>, readonly = false) {
  server.registerTool(name, {
    description,
    inputSchema: schema,
    annotations: { readOnlyHint: readonly, destructiveHint: false, openWorldHint: false }
  }, (async (args: Record<string, unknown>) => {
    try { return result(await handler(args as z.infer<z.ZodObject<T>>)); }
    catch (error) { return errorResult(error); }
  }) as never);
}

function registerTools(client: PortableCourseClient): void {
  register("get_course_workspace", "读取已登记课程和任务摘要。课程由教师或宿主显式登记。", {}, async () => client.workspace(), true);

  if (portableMode) {
    register("get_runtime_identity", "读取独立课程服务的主协议、实例、数据命名空间和包版本；协议不匹配会明确报错，不读取凭据。", {}, async () => client.runtimeIdentity(), true);
    register("get_course_summary", "读取课程级健康摘要：观察范围、礼貌回应与实质接续、未知项、当前任务和下一步；依据仍可回溯到服务记录。", { courseId: optionalCourseIdInput }, async ({ courseId }) => client.courseSummary(courseId), true);
    register("get_portable_service_health", "读取独立课程服务的能力状态；只返回服务能力、版本和真实发布硬锁，不读取凭据。", {}, async () => client.health(), true);
    register("register_course", "登记一门课程，绑定课程入口、目标、预算和促进策略；不会启动巡检或发布。", { course: createBrowserCourseSchema }, async ({ course }) => client.registerCourse(course));
    register("create_course_run", "创建一个 external_host 课程任务，供当前 Grok/通用宿主随后 claim；不经过 Codex dispatcher。", { courseId: courseIdInput, requestId: z.string().uuid(), goal: z.string().trim().min(1).max(800).optional(), mode: modeInput.default("observe") }, async (args) => client.createCourseRun(args));
    register("get_course_run", "读取一个课程任务的运行状态、观察、建议、回执和只读证据。", { runId: requiredRunInput }, async ({ runId }) => client.getCourseRun(runId), true);
    register("stop_course_run", "停止一个课程任务并撤销当前执行租约；已有观察和建议保留。", { runId: requiredRunInput }, async ({ runId }) => client.stopCourseRun(runId));
    register("resume_course_run", "恢复一个已停止或中断的课程任务；返回后必须重新 claim。", { runId: requiredRunInput }, async ({ runId }) => client.resumeCourseRun(runId));
    register("read_course_experience", "只读读取课程已接纳的条件化经验、适用情境和应用记录；公开待审候选、课程已接纳经验和已撤回经验分开返回，不会自动接纳候选。", { courseId: courseIdInput }, async ({ courseId }) => client.readCourseExperience(courseId), true);
    register("search_public_practice", "只读检索公开待审候选。结果只用于核对和形成候选，绝不等同于课程已接纳经验或发布许可。", { query: z.string().trim().max(200).default(""), limit: z.number().int().min(1).max(20).default(5) }, async ({ query, limit }) => client.searchPublicPractice({ query, limit }), true);
  }

  register("claim_course_run", "接手一个 external_host 课程任务，获得课程入口、目标、模式和已有观察。租约留在宿主私有 session 中，连接器重启可沿用。", { runId: runInput }, async ({ runId }) => client.claimCourseRun(runId));
  register("patrol_begin", "开始或恢复一轮课程巡检；与任务的持久 Decision Tape 绑定。", { runId: runInput }, async ({ runId }) => client.patrolBegin(runId));
  register("read_course_guidance", "读取本轮最新教师补充和课程促进策略。结束前读取，页面引用仅作证据。", { runId: runInput }, async ({ runId }) => client.readCourseGuidance(runId));
  register("record_course_observation", "保存实际浏览器观察。并列详情须提供课程列表 membership；创建时间未知填 null 并保留局部覆盖。不要传入论坛原文或身份。", { runId: runInput, operationKey: operationInput, observation: browserObservationSchema }, async ({ runId, operationKey, observation }) => client.recordCourseObservation(observation, runId, operationKey));
  register("save_course_proposals", "保存当前观察的全部决定并同步持久中层；公开待审候选与课程已接纳/已撤回经验保持分层，宿主仍须完成适用性核对。", { runId: runInput, operationKey: operationInput, proposals: z.array(browserProposalSchema).max(MAX_BROWSER_DISCUSSIONS) }, async ({ runId, operationKey, proposals }) => client.saveCourseProposals(proposals, runId, operationKey));
  register("record_reply_receipt", "记录未发布或待核对的回复回执；此工具不执行发布。", { runId: runInput, operationKey: operationInput, receipt: browserReplyReceiptSchema }, async ({ runId, operationKey, receipt }) => client.recordReplyReceipt(receipt, runId, operationKey));
  register("record_reply_uptake", "记录已观察真人回复的功能判断与帖子依据；礼貌回应不自动算作实质接续，浏览器记录仍是待复核解释，不是人工标注或教育效果。", { runId: runInput, operationKey: operationInput, uptake: browserReplyUptakeSchema }, async ({ runId, operationKey, uptake }) => client.recordReplyUptake(uptake, runId, operationKey));
  register("record_participation_choice", "仅依据原作者可见的明确表达，记录等同伴、找教师、拒绝、停止或恢复；不从未回复推断选择。", { runId: runInput, operationKey: operationInput, choice: browserParticipationChoiceSchema }, async ({ runId, operationKey, choice }) => client.recordParticipationChoice(choice, runId, operationKey));
  register("record_editor_readback", "仅 stage 任务：记录浏览器实际读回的生成草稿、清空和未提交情况。", { runId: runInput, operationKey: operationInput, receipt: browserStageSchema }, async ({ runId, operationKey, receipt }) => client.recordEditorReadback(receipt, runId, operationKey));
  register("finish_course_run", "在观察、决定和任务要求的编辑器回读完成后结束任务；真实发布硬锁保持关闭；已完成的同 operationKey 重试只读回原回执。", { runId: runInput, operationKey: operationInput, summary: z.string().trim().min(1).max(800) }, async ({ runId, operationKey, summary }) => client.finishCourseRun(summary, runId, operationKey));
  register("patrol_end", "结束本轮巡检；未完成的接球复扫会留在同一条 Decision Tape 的持久队列。", { runId: runInput, operationKey: operationInput, summary: z.string().trim().min(1).max(800) }, async ({ runId, operationKey, summary }) => client.patrolEnd(summary, runId, operationKey));
  register("report_course_attention", "记录登录失效、页面不完整等问题，保留已有观察等待继续。", { runId: runInput, message: z.string().trim().min(1).max(500) }, async ({ runId, message }) => client.reportCourseAttention(message, runId));
  register("mark_course_relogin_required", "明确记录课程登录失效，释放租约并暂停巡检，等待用户重新登录。", { runId: runInput, message: z.string().trim().min(1).max(500) }, async ({ runId, message }) => client.markCourseReloginRequired(message, runId));
}

function safeStartupError(error: unknown): string {
  if (error instanceof PortableCourseClientError) return error.code || "COURSE_CONNECTOR_FAILED";
  if (error instanceof PortableMcpSessionError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)) return error.message;
  return "COURSE_CONNECTOR_FAILED";
}

async function main(): Promise<void> {
  let session: PortableMcpSessionHandle | undefined;
  try {
    if (portableMode) session = await openPortableMcpSession({ dataDir: clientOptions.dataDir });
    const client = new PortableCourseClient({
      ...clientOptions,
      ...(session ? { session: session.session, sessionWriter: session.save } : {})
    });
    // Refuse to expose the portable tool set when the configured origin is an
    // older 32-tool/legacy service.  The handshake is done before registration
    // so callers cannot accidentally start a run through the wrong protocol.
    if (portableMode) await client.health();
    registerTools(client);
    if (session) {
      const release = () => session?.releaseSync();
      process.once("SIGINT", () => { release(); process.exit(0); });
      process.once("SIGTERM", () => { release(); process.exit(0); });
      process.once("exit", release);
      process.once("uncaughtException", () => { release(); process.exit(1); });
      process.once("unhandledRejection", () => { release(); process.exit(1); });
    }
    await server.connect(new StdioServerTransport());
  } catch (error) {
    if (session) await session.release().catch(() => undefined);
    process.stderr.write(JSON.stringify({ error: safeStartupError(error) }) + "\n");
    process.exitCode = 1;
  }
}

void main();
