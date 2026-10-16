import { createServer } from "node:http";
import { mkdir, open, readFile, unlink, lstat, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export function portableServiceConfig(env: Record<string, string | undefined> = process.env, root = process.cwd()) {
  const port = Number(env.CMOOC_SERVICE_PORT || 3050);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("SERVICE_PORT_INVALID");
  const dataDir = path.resolve(root, env.CMOOC_SERVICE_DATA_DIR || ".cmooc-service-data");
  if (/[?#\r\n]/.test(dataDir)) throw new Error("SERVICE_DATA_PATH_INVALID");
  return { port, dataDir, origin: `http://127.0.0.1:${port}` };
}

export async function acquireLock(dataDir: string, filename = "service.lock") {
  const file = path.join(dataDir, filename);
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); } finally { await handle.close(); }
      return async () => {
        const saved = JSON.parse(await readFile(file, "utf8").catch(() => "{}"));
        if (saved.nonce === nonce) await unlink(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error("SERVICE_LOCK_INVALID");
      const prior = JSON.parse(await readFile(file, "utf8"));
      if (!Number.isInteger(prior.pid) || prior.pid <= 0) throw new Error("SERVICE_LOCK_INVALID");
      let alive = true;
      try { process.kill(prior.pid, 0); } catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
      if (alive) throw new Error("SERVICE_ALREADY_RUNNING");
      await unlink(file);
    }
  }
  throw new Error("SERVICE_LOCK_BUSY");
}

function prismaCommand(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve("prisma/build/index.js"), ...args], {
      stdio: ["ignore", "pipe", "pipe"], env: process.env
    });
    // Setup output is deliberately compact; never echo environment or database locators.
    child.stdout.resume(); child.stderr.resume();
    child.on("error", () => reject(new Error("PRISMA_COMMAND_START_FAILED")));
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`PRISMA_${args[0].toUpperCase()}_FAILED`)));
  });
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] || "start";
  if (args.length > 1 || !["setup", "start", "serve", "doctor"].includes(command)) throw new Error("USAGE: portable-course-service.ts setup|start|doctor");
  const config = portableServiceConfig();
  Object.assign(process.env, {
    CMOOC_PORTABLE_SERVICE: "1", CMOOC_SERVICE_DATA_DIR: config.dataDir,
    LOCALAPPDATA: path.join(config.dataDir, "private"), DATABASE_URL: `file:${path.join(config.dataDir, "course.db")}`,
    CMOOC_DISABLE_WINDOWS_ENV_FALLBACK: "1", LLM_MODE: "mock",
    APP_ORIGIN: config.origin, NEXT_PUBLIC_APP_URL: config.origin
  });
  // No workstation .env, teacher-review authority, dispatcher or external LLM is inherited.
  delete process.env.CMOOC_LOCAL_REVIEW_ORIGIN;
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  if ((await lstat(config.dataDir)).isSymbolicLink()) throw new Error("SERVICE_DATA_SYMLINK_FORBIDDEN");
  if (process.platform !== "win32") await chmod(config.dataDir, 0o700);
  if (command === "setup") {
    const release = await acquireLock(config.dataDir);
    try {
      await prismaCommand(["generate"]);
      const databaseFile = path.join(config.dataDir, "course.db");
      try { const empty = await open(databaseFile, "wx", 0o600); await empty.close(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const databaseStat = await lstat(databaseFile);
      if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) throw new Error("SERVICE_DATABASE_INVALID");
      await prismaCommand(["migrate", "deploy"]);
      const { browserBridgeSecret } = await import("../lib/workbench/browser-course-store");
      await browserBridgeSecret();
      process.stdout.write(JSON.stringify({ ready: true, command: "setup", realPublishEnabled: false }) + "\n");
    } finally { await release(); }
    return;
  }
  const { prisma } = await import("../lib/db");
  async function databaseReady() {
    await prisma.autonomyCourseManifest.count();
    await prisma.facilitationLessonRevision.count();
    const unfinished = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>("SELECT COUNT(*) AS count FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL");
    if (Number(unfinished[0]?.count) !== 0) throw new Error("SERVICE_MIGRATION_INCOMPLETE");
  }
  if (command === "doctor") {
    try {
      await databaseReady();
      process.stdout.write(JSON.stringify({ ready: true, schemaVersion: "cmooc-portable-service.v1", codexRequired: false,
        database: "ready", browser: "provided_by_host", realPublishEnabled: false }) + "\n");
    } finally { await prisma.$disconnect(); }
    return;
  }
  const release = await acquireLock(config.dataDir);
  try {
    await databaseReady();
    const { browserBridgeSecret, verifyBrowserBridge, BrowserCourseError } = await import("../lib/workbench/browser-course-store");
    const { portableCourseAction } = await import("../lib/workbench/portable-course-api");
    const { POST } = await import("../app/api/workbench/browser-agent/route");
    const { NextRequest } = await import("next/server");
    await browserBridgeSecret();
    const server = createServer(async (req, res) => {
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        res.end(JSON.stringify(value));
      };
      try {
        // No proxy trust or CORS. The Bot and service run on the same host.
        if (req.headers.host !== `127.0.0.1:${config.port}` && req.headers.host !== `localhost:${config.port}`) return send(403, { code: "HOST_FORBIDDEN" });
        if (req.headers.origin && req.headers.origin !== config.origin && req.headers.origin !== `http://localhost:${config.port}`) return send(403, { code: "ORIGIN_FORBIDDEN" });
        if (req.method === "GET" && req.url === "/health") return send(200, {
          ready: true, schemaVersion: "cmooc-portable-service.v1", codexRequired: false, realPublishEnabled: false,
          capabilities: ["course_registration", "external_host_runs", "observations", "middle_layer", "experience_read", "resume", "stdio_mcp", "cli"]
        });
        if (req.method !== "POST" || !["/api/portable/courses", "/api/workbench/browser-agent"].includes(req.url || "")) return send(404, { code: "NOT_FOUND" });
        if (!await verifyBrowserBridge(typeof req.headers["x-course-bridge-key"] === "string" ? req.headers["x-course-bridge-key"] : null)) return send(403, { code: "BRIDGE_UNAUTHORIZED" });
        if (req.headers["content-type"]?.split(";")[0] !== "application/json") return send(415, { code: "JSON_REQUIRED" });
        const limit = req.url === "/api/portable/courses" ? 12_000 : 1_500_000;
        if (Number(req.headers["content-length"] || 0) > limit) return send(413, { code: "BODY_LIMIT" });
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > limit) return send(413, { code: "BODY_LIMIT" }); chunks.push(Buffer.from(chunk)); }
        const body = Buffer.concat(chunks).toString("utf8");
        if (req.url === "/api/portable/courses") return send(200, await portableCourseAction(JSON.parse(body)));
        const response = await POST(new NextRequest(`${config.origin}/api/workbench/browser-agent`, { method: "POST", headers: {
          "Content-Type": "application/json", "X-Course-Bridge-Key": req.headers["x-course-bridge-key"] as string
        }, body }));
        return send(response.status, await response.json());
      } catch (error) {
        send(error instanceof BrowserCourseError ? error.status : 400, {
          code: error instanceof BrowserCourseError ? error.code : "REQUEST_FAILED",
          error: error instanceof BrowserCourseError ? error.message : "请求未完成；请核对输入结构、回合状态和数据库版本。"
        });
      }
    });
    server.requestTimeout = 30_000; server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, "127.0.0.1", resolve); });
    process.stdout.write(JSON.stringify({ ready: true, origin: config.origin, codexRequired: false, realPublishEnabled: false }) + "\n");
    await new Promise<void>(resolve => {
      const stop = () => { server.close(() => resolve()); server.closeIdleConnections(); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
    });
  } finally { await prisma.$disconnect(); await release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message) ? error.message : "SERVICE_OPERATION_FAILED";
    process.stderr.write(JSON.stringify({ error: code, hint: "检查 Node 22、npm ci、service:setup、数据目录及端口占用。" }) + "\n"); process.exitCode = 1;
  });
}
