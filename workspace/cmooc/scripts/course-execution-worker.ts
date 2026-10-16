import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

const origin = new URL(process.env.CMOOC_WORKBENCH_ORIGIN || "http://127.0.0.1:3018");
if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== "/") throw new Error("WORKER_LOOPBACK_REQUIRED");
const hash = createHash("sha256").update(path.resolve(process.cwd()).toLowerCase()).digest("hex").slice(0, 20);
const root = path.join(process.env.LOCALAPPDATA || path.join(homedir(), ".local", "share"), "cmooc-workbench", "browser-courses", hash);
let stopped = false; let pending: AbortController | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stopped = true; pending?.abort(); });

async function main() {
  let unavailable = false;
  while (!stopped) {
    try {
      // The API is the only workspace writer; this process only consumes the existing queue.
      const key = (await readFile(path.join(root, "bridge-key"), "utf8")).trim();
      pending = new AbortController();
      const response = await fetch(new URL("/api/workbench/course-dispatch", origin), {
        method: "POST", redirect: "error", signal: AbortSignal.any([pending.signal, AbortSignal.timeout(120_000)]),
        headers: { "Content-Type": "application/json", Origin: origin.origin, "X-Course-Bridge-Key": key }, body: "{}"
      });
      if (!response.ok) throw new Error("WORKER_UNAVAILABLE");
      if (unavailable) console.log("课程执行队列连接已恢复。");
      unavailable = false;
    } catch {
      if (!unavailable && !stopped) console.log("课程执行队列等待服务就绪；持久任务保留。");
      unavailable = true;
    } finally { pending = undefined; }
    if (!stopped) await new Promise(resolve => setTimeout(resolve, unavailable ? 5000 : 2000));
  }
}
void main().catch(() => { console.error("课程后台消费者已退出。"); process.exitCode = 1; });
