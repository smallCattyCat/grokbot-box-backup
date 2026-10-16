import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const args = process.argv.slice(2); const build = args.includes("--build");
const portIndex = args.indexOf("--port"); const port = portIndex < 0 ? 3018 : Number(args[portIndex + 1]);
const rest = args.filter((_, i) => i !== portIndex && !(portIndex >= 0 && i === portIndex + 1));
if (!Number.isInteger(port) || port < 1024 || port > 65535 || rest.some((a) => a !== "--build")) throw new Error("Usage: npm run workbench:start -- [--port 3018]");
const production = ".next-stale-workspace-r8-production"; const built = existsSync(path.join(process.cwd(), production, "BUILD_ID"));
const mode = build ? "build" : built ? "start" : "dev"; const origin = `http://127.0.0.1:${port}`;
if (!build) console.log(`共学课程工作台 R8: ${origin}/workbench?view=course (${mode})`);
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), mode, ...(build ? [] : ["--hostname", "127.0.0.1", "--port", String(port)])], { cwd: process.cwd(), stdio: "inherit", windowsHide: true,
  env: { ...process.env, CMOOC_NEXT_DIST_DIR: build || built ? production : ".next-stale-workspace-r8-dev", APP_ORIGIN: origin, NEXT_PUBLIC_APP_URL: origin } });
child.once("error", () => { console.error("工作台进程未能启动。"); process.exitCode = 1; });
const consumer = build ? null : spawn(process.execPath, [require.resolve("tsx/cli"), "scripts/course-execution-worker.ts"], {
  cwd: process.cwd(), stdio: "inherit", windowsHide: true, env: { ...process.env, CMOOC_WORKBENCH_ORIGIN: origin }
});
consumer?.once("error", () => { console.error("课程队列消费者未能启动。"); child.kill(); process.exitCode = 1; });
consumer?.once("exit", () => { if (child.exitCode === null) child.kill(); });
child.once("exit", (code) => { consumer?.kill(); process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { consumer?.kill(signal); child.kill(signal); });


