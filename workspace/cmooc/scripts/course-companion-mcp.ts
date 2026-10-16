import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { browserObservationSchema, browserProposalSchema, browserReplyReceiptSchema, browserStageSchema, MAX_BROWSER_DISCUSSIONS } from "../lib/workbench/browser-course-contracts";

const origin = new URL(process.env.CMOOC_WORKBENCH_ORIGIN || "http://127.0.0.1:3017");
if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) || origin.pathname !== "/" || origin.username || origin.password) throw new Error("WORKBENCH_LOOPBACK_REQUIRED");
const owner = randomUUID();
const fixedRun = process.env.CMOOC_COURSE_RUN_ID;
const leases = new Map<string, string>();
function bridgeKey() {
  if (process.env.CMOOC_WORKBENCH_BRIDGE_KEY) return process.env.CMOOC_WORKBENCH_BRIDGE_KEY;
  let root = process.env.CMOOC_WORKBENCH_ROOT || process.cwd();
  if (!existsSync(path.join(root, "package.json")) && existsSync(path.join(root, "源码/package.json"))) root = path.join(root, "源码");
  const hash = createHash("sha256").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 20);
  const local = process.env.LOCALAPPDATA || path.join(homedir(), ".local", "share");
  return readFileSync(path.join(local, "cmooc-workbench", "browser-courses", hash, "bridge-key"), "utf8").trim();
}
async function call(action: string, args: Record<string, unknown> = {}) {
  const runId = fixedRun || args.runId;
  if (fixedRun && args.runId && args.runId !== fixedRun) throw new Error("任务范围不一致。");
  const response = await fetch(new URL("/api/workbench/browser-agent", origin), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/json", Origin: origin.origin, "X-Course-Bridge-Key": bridgeKey() },
    body: JSON.stringify({ action, ...args, ...(runId ? { runId } : {}), owner, executionRunId: process.env.CMOOC_COURSE_EXECUTION_ID, leaseToken: typeof runId === "string" ? leases.get(runId) : undefined })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "工作台连接未完成。");
  if (result.leaseToken && typeof runId === "string") { leases.set(runId, result.leaseToken); delete result.leaseToken; }
  return result;
}
const server = new McpServer({ name: "course-companion", version: "0.1.0" });
const runInput = z.string().uuid().optional().describe("任务编号；由工作台任务交接提供。绑定运行时可省略。");
const operationInput = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional().describe("可选的稳定操作编号；重试同一请求时复用，数据冲突会被拒绝。");
function result(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
function register(name: string, description: string, schema: z.ZodRawShape, action: string, readonly = false) {
  server.registerTool(name, { description, inputSchema: schema,
    annotations: { readOnlyHint: readonly, destructiveHint: false, openWorldHint: false } }, async (args) => {
      try { return result(await call(action, args as Record<string, unknown>)); }
      catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "课程工具执行失败。" }] }; }
    });
}
register("get_course_workspace", "读取已登记课程和任务摘要。课程由教师在工作台中添加。", {}, "workspace", true);
register("claim_course_run", "接手工作台已有课程任务，获得课程入口、目标、模式和已有观察。", { runId: runInput }, "claim");
register("patrol_begin", "开始一轮正式课程巡检；与工作台持久队列和同一条 Decision Tape 绑定。", { runId: runInput }, "patrol_begin");
register("read_course_guidance", "读取本轮最新教师补充和课程促进策略。结束前读取，页面引用仅作证据。", { runId: runInput }, "guidance");
register("record_course_observation", "保存从浏览器实际读取的课程观察。仅概括、别名和结构关系；不要传入论坛原文。", { runId: runInput, operationKey: operationInput, observation: browserObservationSchema }, "observation");
register("save_course_proposals", "依据已记录的观察一次保存本轮全部讨论的决定；读取返回值中的最终决定与草稿编号。", { runId: runInput, operationKey: operationInput, proposals: z.array(browserProposalSchema).max(MAX_BROWSER_DISCUSSIONS) }, "proposals");
register("record_reply_receipt", "记录未发布或待核对的回复回执；已确认发布只能由受信连接器写入，并把接球复扫挂回同一条 Decision Tape。此工具不执行发布。", { runId: runInput, operationKey: operationInput, receipt: browserReplyReceiptSchema }, "reply_receipt");
register("record_editor_readback", "仅 stage 任务：记录浏览器实际读回的生成草稿、清空和未提交情况。它是代理回读记录。", { runId: runInput, operationKey: operationInput, receipt: browserStageSchema }, "stage");
register("finish_course_run", "在观察、建议和任务要求的编辑器回读完成后结束任务，成果同步工作台。", { runId: runInput, operationKey: operationInput, summary: z.string().min(1).max(800) }, "finish");
register("patrol_end", "结束本轮正式巡检；未完成的接球复扫会留在同一条 Decision Tape 的持久队列。", { runId: runInput, operationKey: operationInput, summary: z.string().min(1).max(800) }, "patrol_end");
register("report_course_attention", "记录登录失效、页面不完整等问题，保留已有观察等待继续。", { runId: runInput, message: z.string().min(1).max(500) }, "attention");
register("mark_course_relogin_required", "明确记录课程登录失效，释放租约并暂停巡检，等待用户重新登录。", { runId: runInput, message: z.string().min(1).max(500) }, "relogin_required");
server.connect(new StdioServerTransport()).catch(() => { process.stderr.write("课程插件连接失败。\n"); process.exitCode = 1; });

