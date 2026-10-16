import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createBrowserCourseSchema, browserObservationSchema, browserProposalSchema, browserReplyReceiptSchema, browserStageSchema, browserReplyUptakeSchema, browserParticipationChoiceSchema, MAX_BROWSER_DISCUSSIONS } from "../lib/workbench/browser-course-contracts";
import { PortableCourseClient, type PortableCourseClientOptions } from "../lib/workbench/portable-course-client";

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
  workspaceTransport: portableMode ? "portable" : "agent"
};
const client = new PortableCourseClient(clientOptions);
const server = new McpServer({ name: "course-companion", version: "0.2.0" });

const runInput = z.string().uuid().optional().describe("任务编号；由创建任务或工作台交接提供。绑定运行时可省略。");
const requiredRunInput = z.string().uuid().describe("课程任务编号。");
const courseIdInput = z.string().uuid().describe("已登记课程编号。");
const operationInput = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional().describe("可选的稳定操作编号；重试同一请求时复用，数据冲突会被拒绝。");
const modeInput = z.enum(["observe", "stage"]).describe("observe 只保存观察和建议；stage 允许编辑器回读但仍禁止提交。");

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : "课程工具执行失败。";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
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

register("get_course_workspace", "读取已登记课程和任务摘要。课程由教师或宿主显式登记。", {}, async () => client.workspace(), true);

if (portableMode) {
  register("get_portable_service_health", "读取独立课程服务的能力状态；只返回服务能力、版本和真实发布硬锁，不读取凭据。", {}, async () => client.health(), true);
  register("register_course", "登记一门课程，绑定课程入口、目标、预算和促进策略；不会启动巡检或发布。", { course: createBrowserCourseSchema }, async ({ course }) => client.registerCourse(course));
  register("create_course_run", "创建一个 external_host 课程任务，供当前 Grok/通用宿主随后 claim；不经过 Codex dispatcher。", { courseId: courseIdInput, requestId: z.string().uuid(), goal: z.string().trim().min(1).max(800).optional(), mode: modeInput.default("observe") }, async (args) => client.createCourseRun(args));
  register("get_course_run", "读取一个课程任务的运行状态、观察、建议、回执和只读证据。", { runId: requiredRunInput }, async ({ runId }) => client.getCourseRun(runId), true);
  register("stop_course_run", "停止一个课程任务并撤销当前执行租约；已有观察和建议保留。", { runId: requiredRunInput }, async ({ runId }) => client.stopCourseRun(runId));
  register("resume_course_run", "恢复一个已停止或中断的课程任务；返回后必须重新 claim。", { runId: requiredRunInput }, async ({ runId }) => client.resumeCourseRun(runId));
  register("read_course_experience", "只读读取该课程已接纳的条件化经验、适用情境和应用记录；不会自动接纳候选。", { courseId: courseIdInput }, async ({ courseId }) => client.readCourseExperience(courseId), true);
  register("search_public_practice", "只读检索受控公开实践知识。结果仅供核对和形成候选，不自动写入课程经验或授予发布权限。", { query: z.string().trim().max(200).default(""), limit: z.number().int().min(1).max(20).default(5) }, async ({ query, limit }) => client.searchPublicPractice({ query, limit }), true);
}

register("claim_course_run", "接手一个 external_host 课程任务，获得课程入口、目标、模式和已有观察。租约留在宿主私有 session 中。", { runId: runInput }, async ({ runId }) => client.claimCourseRun(runId));
register("patrol_begin", "开始或恢复一轮课程巡检；与任务的持久 Decision Tape 绑定。", { runId: runInput }, async ({ runId }) => client.patrolBegin(runId));
register("read_course_guidance", "读取本轮最新教师补充和课程促进策略。结束前读取，页面引用仅作证据。", { runId: runInput }, async ({ runId }) => client.readCourseGuidance(runId));
register("record_course_observation", "保存实际浏览器观察。并列详情须提供课程列表 membership；创建时间未知填 null 并保留局部覆盖。不要传入论坛原文或身份。", { runId: runInput, operationKey: operationInput, observation: browserObservationSchema }, async ({ runId, operationKey, observation }) => client.recordCourseObservation(observation, runId, operationKey));
register("save_course_proposals", "保存当前观察的全部决定并同步持久中层；核对最终决定、草稿编号和经验评价。中层候选仍须宿主接纳。", { runId: runInput, operationKey: operationInput, proposals: z.array(browserProposalSchema).max(MAX_BROWSER_DISCUSSIONS) }, async ({ runId, operationKey, proposals }) => client.saveCourseProposals(proposals, runId, operationKey));
register("record_reply_receipt", "记录未发布或待核对的回复回执；此工具不执行发布。", { runId: runInput, operationKey: operationInput, receipt: browserReplyReceiptSchema }, async ({ runId, operationKey, receipt }) => client.recordReplyReceipt(receipt, runId, operationKey));
register("record_reply_uptake", "记录已观察真人回复的功能判断与帖子依据；浏览器记录是待复核解释，不是人工标注或教育效果。", { runId: runInput, operationKey: operationInput, uptake: browserReplyUptakeSchema }, async ({ runId, operationKey, uptake }) => client.recordReplyUptake(uptake, runId, operationKey));
register("record_participation_choice", "仅依据原作者可见的明确表达，记录等同伴、找教师、拒绝、停止或恢复；不从未回复推断选择。", { runId: runInput, operationKey: operationInput, choice: browserParticipationChoiceSchema }, async ({ runId, operationKey, choice }) => client.recordParticipationChoice(choice, runId, operationKey));
register("record_editor_readback", "仅 stage 任务：记录浏览器实际读回的生成草稿、清空和未提交情况。", { runId: runInput, operationKey: operationInput, receipt: browserStageSchema }, async ({ runId, operationKey, receipt }) => client.recordEditorReadback(receipt, runId, operationKey));
register("finish_course_run", "在观察、决定和任务要求的编辑器回读完成后结束任务；真实发布硬锁保持关闭。", { runId: runInput, operationKey: operationInput, summary: z.string().trim().min(1).max(800) }, async ({ runId, operationKey, summary }) => client.finishCourseRun(summary, runId, operationKey));
register("patrol_end", "结束本轮巡检；未完成的接球复扫会留在同一条 Decision Tape 的持久队列。", { runId: runInput, operationKey: operationInput, summary: z.string().trim().min(1).max(800) }, async ({ runId, operationKey, summary }) => client.patrolEnd(summary, runId, operationKey));
register("report_course_attention", "记录登录失效、页面不完整等问题，保留已有观察等待继续。", { runId: runInput, message: z.string().trim().min(1).max(500) }, async ({ runId, message }) => client.reportCourseAttention(message, runId));
register("mark_course_relogin_required", "明确记录课程登录失效，释放租约并暂停巡检，等待用户重新登录。", { runId: runInput, message: z.string().trim().min(1).max(500) }, async ({ runId, message }) => client.markCourseReloginRequired(message, runId));

server.connect(new StdioServerTransport()).catch(() => {
  process.stderr.write("课程插件连接失败。\n");
  process.exitCode = 1;
});
