#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
const origin = process.env.CMOOC_WORKBENCH_ORIGIN || "http://127.0.0.1:3017";
const root = process.env.CMOOC_WORKBENCH_ROOT || "/workspace/cmooc";
const script = path.join(root, "scripts/course-companion-mcp.ts");
const localAppData = process.env.LOCALAPPDATA || path.join(root, ".localappdata");
function die(msg) { process.stderr.write(msg + "\n"); process.exit(1); }
try { const u = new URL(origin); if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) die("WORKBENCH_LOOPBACK_REQUIRED"); } catch { die("CMOOC_WORKBENCH_ORIGIN invalid"); }
if (!existsSync(script)) die("course-companion-mcp.ts missing at " + script);
const health = await fetch(new URL("/api/workbench/browser-courses", origin), { method: "GET", redirect: "error", signal: AbortSignal.timeout(5000) }).catch(() => null);
if (!health || !health.ok) die("WORKBENCH_DOWN: cannot reach " + origin + "/api/workbench/browser-courses\nStart: cd /workspace/cmooc && npx next dev -H 127.0.0.1 -p 3017\nKeep slim MCP until healthy. See /workspace/cmooc-mcp/SYNC_CUTOVER.md");
const child = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), script], { cwd: root, stdio: "inherit", env: { ...process.env, CMOOC_WORKBENCH_ORIGIN: origin, CMOOC_WORKBENCH_ROOT: root, LOCALAPPDATA: localAppData } });
child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); process.exit(code ?? 1); });
