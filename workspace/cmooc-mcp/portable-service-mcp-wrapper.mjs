#!/usr/bin/env node
/**
 * stdio MCP launcher for portable grok-course-service-v2 on 127.0.0.1:3050.
 * Always forces v2 root/dataDir — ignores inherited v1 CMOOC_* env from older connectors.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.env.CMOOC_FORCE_ROOT || "/workspace/grok-course-service-v2";
const dataDir = path.join(root, ".cmooc-service-data");
const port = process.env.CMOOC_SERVICE_PORT || "3050";
const host = process.env.CMOOC_SERVICE_HOST || "127.0.0.1";
const origin = `http://${host}:${port}`;
const localAppData = path.join(dataDir, "private");

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

if (!existsSync(path.join(root, "package.json"))) die("PORTABLE_ROOT_MISSING: " + root);
if (!existsSync(path.join(root, "scripts/portable-course-mcp.ts"))) {
  die("portable-course-mcp.ts missing under " + root);
}

const health = await fetch(new URL("/health", origin), {
  method: "GET",
  redirect: "error",
  signal: AbortSignal.timeout(5000),
}).catch(() => null);
if (!health || !health.ok) {
  die(
    "PORTABLE_SERVICE_DOWN: cannot reach " +
      origin +
      "/health\nStart: cd " +
      root +
      " && set -a && . ./.env.local.run && set +a && npm run --silent service:manage -- start"
  );
}

const tsxCli = path.join(root, "node_modules/tsx/dist/cli.mjs");
const mcpScript = path.join(root, "scripts/portable-course-mcp.ts");
if (!existsSync(tsxCli)) die("tsx missing; run npm ci in " + root);

// Strip inherited v1/workbench keys before spawn; only pass forced v2 env.
const clean = { ...process.env };
for (const k of Object.keys(clean)) {
  if (
    k.startsWith("CMOOC_") ||
    k === "DATABASE_URL" ||
    k === "LOCALAPPDATA" ||
    k === "APP_ORIGIN" ||
    k === "NEXT_PUBLIC_APP_URL"
  ) {
    delete clean[k];
  }
}

const child = spawn(process.execPath, [tsxCli, mcpScript], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...clean,
    CMOOC_SERVICE_HOST: host,
    CMOOC_SERVICE_PORT: String(port),
    CMOOC_SERVICE_DATA_DIR: dataDir,
    DATABASE_URL: `file:${dataDir}/course.db`,
    CMOOC_WORKBENCH_ORIGIN: origin,
    CMOOC_PORTABLE_SERVICE_ORIGIN: origin,
    CMOOC_WORKBENCH_ROOT: root,
    CMOOC_PORTABLE_MODE: "1",
    LOCALAPPDATA: localAppData,
    CMOOC_DISABLE_WINDOWS_ENV_FALLBACK: "1",
    LLM_MODE: "mock",
  },
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
