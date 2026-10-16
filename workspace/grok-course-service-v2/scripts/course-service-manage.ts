import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile, chmod, lstat, unlink } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { acquireLock } from "./portable-course-service";
import {
  clearServiceStopIntent,
  processCommandLine,
  processIsAlive,
  processMatchesPortableService,
  readServiceRuntimeState,
  readServiceStopIntent,
  removeServiceRuntimeState,
  resolveServiceDataDir,
  resolveServicePackageRoot,
  serviceOrigin,
  serviceStatePath,
  verifyManagedIdentity,
  writeServiceRuntimeState,
  writeServiceStopIntent,
  type ManagedIdentityCheck,
  type ServiceHealthIdentity,
  type ServiceRuntimeState
} from "./course-service-state";

export type ManageCommand = "start" | "status" | "stop" | "watchdog" | "systemd";

export type ManageOptions = {
  dataDir?: string;
  packageRoot?: string;
  port?: number;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollMs?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  restartCount?: number;
  once?: boolean;
  output?: string;
};

export type ManagedServiceStatus = {
  status: "running" | "stopped" | "stale" | "foreign" | "stopping" | "attention";
  dataDir: string;
  origin: string;
  state: ServiceRuntimeState | null;
  identity: ManagedIdentityCheck | null;
  health: ServiceHealthIdentity | null;
  reason?: string;
};

type HealthProbe = {
  health: ServiceHealthIdentity | null;
  error?: string;
};

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function positiveInteger(value: string, code: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(code);
  return parsed;
}

function optionNumber(value: string | undefined, fallback: number, min: number, max: number, code: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(code);
  return parsed;
}

function managerRoots(options: ManageOptions): { packageRoot: string; dataDir: string; origin: string } {
  const packageRoot = resolveServicePackageRoot(options.packageRoot ?? process.env.CMOOC_SERVICE_ROOT ?? scriptRoot);
  const dataDir = resolveServiceDataDir(options.dataDir, packageRoot);
  const origin = serviceOrigin(options.port ?? Number(process.env.CMOOC_SERVICE_PORT || 3050));
  return { packageRoot, dataDir, origin };
}

function serviceScript(packageRoot: string): string {
  const value = path.join(packageRoot, "scripts", "portable-course-service.ts");
  return value;
}

function tsxCli(packageRoot: string): string {
  return path.join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
}

function tsxLoader(packageRoot: string): string {
  return path.join(packageRoot, "node_modules", "tsx", "dist", "loader.mjs");
}

async function ensureDirectory(directory: string, mode = 0o700): Promise<void> {
  await mkdir(directory, { recursive: true, mode });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("SERVICE_DIRECTORY_INVALID");
  if (process.platform !== "win32") await chmod(directory, mode);
}

async function assertPackageRuntime(root: string): Promise<void> {
  for (const file of [path.join(root, "package.json"), tsxCli(root), serviceScript(root)]) {
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info || !info.isFile() || info.isSymbolicLink()) throw new Error("SERVICE_PACKAGE_ROOT_INVALID");
  }
}

async function probeHealth(origin: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<HealthProbe> {
  try {
    const response = await fetchImpl(new URL("/health", origin), { method: "GET", redirect: "error", signal: AbortSignal.timeout(2_500) });
    const value = await response.json().catch(() => null);
    if (!response.ok || !value || typeof value !== "object" || Array.isArray(value)) return { health: null, error: `HTTP_${response.status}` };
    return { health: value as ServiceHealthIdentity };
  } catch (error) {
    return { health: null, error: error instanceof Error ? error.message : "HEALTH_UNAVAILABLE" };
  }
}

function healthIdentity(value: ServiceHealthIdentity | null): value is ServiceHealthIdentity & { instanceId: string; namespaceId: string } {
  return Boolean(value && typeof value.instanceId === "string" && typeof value.namespaceId === "string");
}

async function startState(options: ManageOptions, roots: { packageRoot: string; dataDir: string; origin: string }): Promise<ServiceRuntimeState | undefined> {
  return readServiceRuntimeState(roots.dataDir).catch((error) => {
    if (error instanceof Error && error.message === "ENOENT") return undefined;
    throw error;
  });
}

async function closeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function newRuntimeState(input: {
  pid: number;
  instanceId: string;
  namespaceId: string;
  dataDir: string;
  packageRoot: string;
  origin: string;
  restartCount: number;
  restartWindowStartedAt: string | null;
}): ServiceRuntimeState {
  return {
    schemaVersion: "cmooc.course-service-runtime-state.v1",
    pid: input.pid,
    instanceId: input.instanceId,
    namespaceId: input.namespaceId,
    runtimeToken: randomBytes(32).toString("hex"),
    dataDir: input.dataDir,
    packageRoot: input.packageRoot,
    origin: input.origin,
    startedAt: new Date().toISOString(),
    desired: "running",
    restartCount: input.restartCount,
    restartWindowStartedAt: input.restartWindowStartedAt,
    stopRequestedAt: null
  };
}

export async function startManagedService(options: ManageOptions = {}): Promise<{ status: "running"; state: ServiceRuntimeState }> {
  const roots = managerRoots(options);
  await assertPackageRuntime(roots.packageRoot);
  await ensureDirectory(roots.dataDir);
  await clearServiceStopIntent(roots.dataDir);
  const existing = await readServiceRuntimeState(roots.dataDir);
  if (existing) {
    if (await processIsAlive(existing.pid)) {
      const identity = await verifyManagedIdentity(existing, { packageRoot: roots.packageRoot });
      if (identity.verified) throw new Error("SERVICE_ALREADY_RUNNING");
      throw new Error(`SERVICE_IDENTITY_MISMATCH:${identity.reason ?? "UNKNOWN"}`);
    }
    await removeServiceRuntimeState(roots.dataDir);
  }
  const foreign = await probeHealth(roots.origin);
  if (foreign.health && healthIdentity(foreign.health)) throw new Error("SERVICE_FOREIGN_INSTANCE");
  const logDir = path.join(roots.dataDir, "logs");
  await ensureDirectory(logDir);
  const logFile = path.join(logDir, "service.log");
  const fd = openSync(logFile, "a", 0o600);
  let child: ChildProcess;
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CMOOC_SERVICE_DATA_DIR: roots.dataDir,
      CMOOC_SERVICE_PORT: new URL(roots.origin).port,
      CMOOC_PORTABLE_SERVICE: "1",
      CMOOC_DISABLE_WINDOWS_ENV_FALLBACK: "1",
      LLM_MODE: "mock",
      CMOOC_WORKBENCH_ROOT: roots.packageRoot,
      APP_ORIGIN: roots.origin,
      NEXT_PUBLIC_APP_URL: roots.origin,
      LOCALAPPDATA: path.join(roots.dataDir, "private"),
      DATABASE_URL: `file:${path.join(roots.dataDir, "course.db")}`
    };
    delete env.CMOOC_LOCAL_REVIEW_ORIGIN;
    delete env.CMOOC_WORKBENCH_BRIDGE_KEY;
    // Import the TS loader into the service process itself.  Invoking the tsx
    // CLI wrapper can leave a detached child behind when the wrapper is killed,
    // which makes watchdog recovery mistake the orphan for a foreign service.
    child = spawn(process.execPath, ["--import", pathToFileURL(tsxLoader(roots.packageRoot)).href, serviceScript(roots.packageRoot), "start"], {
      cwd: roots.packageRoot,
      env,
      detached: true,
      stdio: ["ignore", fd, fd]
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  if (!child!.pid) throw new Error("SERVICE_PROCESS_START_FAILED");
  const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
  const deadline = Date.now() + startupTimeoutMs;
  let lastHealth: ServiceHealthIdentity | null = null;
  while (Date.now() < deadline) {
    if (!(await processIsAlive(child.pid))) break;
    const probe = await probeHealth(roots.origin);
    lastHealth = probe.health;
    if (healthIdentity(probe.health)) {
      const command = await processCommandLine(child.pid);
      const expected = serviceScript(roots.packageRoot);
      if (!command?.includes(expected)) {
        await closeChild(child);
        throw new Error("SERVICE_PROCESS_IDENTITY_MISMATCH");
      }
      const state = newRuntimeState({
        pid: child.pid,
        instanceId: probe.health.instanceId,
        namespaceId: probe.health.namespaceId,
        dataDir: roots.dataDir,
        packageRoot: roots.packageRoot,
        origin: roots.origin,
        restartCount: options.restartCount ?? 0,
        restartWindowStartedAt: new Date().toISOString()
      });
      await writeServiceRuntimeState(roots.dataDir, state);
      return { status: "running", state };
    }
    await sleep(Math.min(options.pollMs ?? 100, 500));
  }
  await closeChild(child);
  if (lastHealth && healthIdentity(lastHealth)) throw new Error("SERVICE_START_FOREIGN_HEALTH");
  throw new Error("SERVICE_START_TIMEOUT");
}

export async function inspectManagedService(options: ManageOptions = {}): Promise<ManagedServiceStatus> {
  const roots = managerRoots(options);
  const state = await readServiceRuntimeState(roots.dataDir);
  const probe = await probeHealth(roots.origin);
  if (!state) {
    if (probe.health && healthIdentity(probe.health)) return { status: "foreign", dataDir: roots.dataDir, origin: roots.origin, state: null, identity: null, health: probe.health, reason: "HEALTH_WITHOUT_MANAGER_STATE" };
    return { status: "stopped", dataDir: roots.dataDir, origin: roots.origin, state: null, identity: null, health: probe.health };
  }
  const identity = await verifyManagedIdentity(state, { packageRoot: roots.packageRoot });
  if (state.desired === "stopped" && identity.verified) return { status: "stopping", dataDir: roots.dataDir, origin: roots.origin, state, identity, health: identity.health };
  if (identity.verified) return { status: "running", dataDir: roots.dataDir, origin: roots.origin, state, identity, health: identity.health };
  if (identity.pidAlive && (identity.commandMatches || identity.healthMatches)) return { status: "foreign", dataDir: roots.dataDir, origin: roots.origin, state, identity, health: identity.health, reason: identity.reason };
  return { status: state.desired === "attention" ? "attention" : "stale", dataDir: roots.dataDir, origin: roots.origin, state, identity, health: identity.health, reason: identity.reason ?? "PROCESS_NOT_ALIVE" };
}

async function readBridgeKey(dataDir: string): Promise<string> {
  const file = path.join(dataDir, "browser-courses", "bridge-key");
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== 64) throw new Error("BRIDGE_KEY_UNAVAILABLE");
  const value = (await readFile(file, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("BRIDGE_KEY_INVALID");
  return value;
}

async function requestShutdown(state: ServiceRuntimeState, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<void> {
  const key = await readBridgeKey(state.dataDir);
  const response = await fetchImpl(new URL("/api/portable/control", state.origin), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Course-Bridge-Key": key },
    body: JSON.stringify({ action: "shutdown", expectedInstanceId: state.instanceId }),
    redirect: "error",
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: unknown } | null;
    throw new Error(typeof body?.code === "string" ? body.code : `SERVICE_SHUTDOWN_HTTP_${response.status}`);
  }
}

async function waitForExit(state: ServiceRuntimeState, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processIsAlive(state.pid))) return true;
    if (!(await processMatchesPortableService(state.pid, state.packageRoot))) return true;
    await sleep(100);
  }
  return !(await processIsAlive(state.pid));
}

export async function stopManagedService(options: ManageOptions = {}): Promise<{ status: "stopped" | "stopping"; identity: ManagedIdentityCheck | null }> {
  const roots = managerRoots(options);
  const state = await readServiceRuntimeState(roots.dataDir);
  if (!state) {
    const foreign = await probeHealth(roots.origin);
    if (foreign.health && healthIdentity(foreign.health)) throw new Error("SERVICE_FOREIGN_INSTANCE");
    return { status: "stopped", identity: null };
  }
  const identity = await verifyManagedIdentity(state, { packageRoot: roots.packageRoot });
  if (!identity.pidAlive) {
    await removeServiceRuntimeState(roots.dataDir);
    return { status: "stopped", identity };
  }
  if (!identity.verified) throw new Error(`SERVICE_IDENTITY_MISMATCH:${identity.reason ?? "UNKNOWN"}`);
  const stopping: ServiceRuntimeState = { ...state, desired: "stopped", stopRequestedAt: new Date().toISOString() };
  await writeServiceRuntimeState(roots.dataDir, stopping);
  await writeServiceStopIntent(roots.dataDir, stopping);
  await requestShutdown(stopping);
  const stopped = await waitForExit(stopping, options.stopTimeoutMs ?? 15_000);
  if (stopped) {
    await removeServiceRuntimeState(roots.dataDir);
    return { status: "stopped", identity };
  }
  return { status: "stopping", identity };
}

export async function watchdogManagedService(options: ManageOptions = {}): Promise<{ status: "running" | "stopped" | "attention"; restarts: number }> {
  const roots = managerRoots(options);
  await ensureDirectory(roots.dataDir);
  const release = await acquireLock(roots.dataDir, "watchdog.lock");
  const maxRestarts = options.maxRestarts ?? 5;
  const restartWindowMs = options.restartWindowMs ?? 5 * 60_000;
  const baseBackoffMs = options.backoffMs ?? 500;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const pollMs = options.pollMs ?? 1_000;
  let restarts = options.restartCount ?? 0;
  let windowStarted = Date.now();
  let stopping = false;
  const onSignal = () => { stopping = true; };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    for (;;) {
      if (stopping || await readServiceStopIntent(roots.dataDir)) {
        const current = await readServiceRuntimeState(roots.dataDir);
        if (current) await stopManagedService(options).catch(() => undefined);
        return { status: "stopped", restarts };
      }
      const current = await inspectManagedService(options);
      if (current.status === "running") {
        if (options.once) return { status: "running", restarts };
        await sleep(pollMs);
        continue;
      }
      if (current.status === "foreign" || current.status === "stopping") throw new Error("WATCHDOG_FOREIGN_INSTANCE");
      if (Date.now() - windowStarted > restartWindowMs) { restarts = 0; windowStarted = Date.now(); }
      if (restarts >= maxRestarts) {
        const state = await readServiceRuntimeState(roots.dataDir);
        if (state) await writeServiceRuntimeState(roots.dataDir, { ...state, desired: "attention", restartCount: restarts, restartWindowStartedAt: new Date(windowStarted).toISOString() } as ServiceRuntimeState);
        return { status: "attention", restarts };
      }
      if (restarts > 0) await sleep(Math.min(maxBackoffMs, baseBackoffMs * (2 ** Math.min(restarts - 1, 10))));
      try {
        await startManagedService({ ...options, restartCount: restarts });
        restarts += 1;
        if (options.once) return { status: "running", restarts };
      } catch (error) {
        const message = error instanceof Error ? error.message : "SERVICE_START_FAILED";
        if (/FOREIGN|IDENTITY_MISMATCH|ALREADY_RUNNING/u.test(message)) throw error;
        restarts += 1;
        if (restarts >= maxRestarts) {
          const failedState = await readServiceRuntimeState(roots.dataDir);
          if (failedState) await writeServiceRuntimeState(roots.dataDir, { ...failedState, desired: "attention", restartCount: restarts, restartWindowStartedAt: new Date(windowStarted).toISOString() });
          return { status: "attention", restarts };
        }
        await sleep(Math.min(maxBackoffMs, baseBackoffMs * (2 ** Math.min(restarts - 1, 10))));
      }
    }
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    await release();
  }
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

export function renderSystemdUnit(options: ManageOptions = {}): string {
  const roots = managerRoots(options);
  const tsx = tsxLoader(roots.packageRoot);
  const script = serviceScript(roots.packageRoot);
  return `[Unit]\nDescription=cMOOC Grok course companion service\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemdQuote(roots.packageRoot)}\nEnvironment=${systemdQuote(`CMOOC_SERVICE_DATA_DIR=${roots.dataDir}`)}\nEnvironment=${systemdQuote(`CMOOC_SERVICE_PORT=${new URL(roots.origin).port}`)}\nEnvironment=CMOOC_PORTABLE_SERVICE=1\nEnvironment=LLM_MODE=mock\nEnvironment=CMOOC_DISABLE_WINDOWS_ENV_FALLBACK=1\nExecStart=/usr/bin/env node --import ${systemdQuote(pathToFileURL(tsx).href)} ${systemdQuote(script)} start\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nKillSignal=SIGTERM\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export async function writeSystemdUnit(options: ManageOptions = {}): Promise<{ status: "generated"; file: string }> {
  if (!options.output) throw new Error("SYSTEMD_OUTPUT_REQUIRED");
  const file = path.resolve(options.output);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, renderSystemdUnit(options), { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") await chmod(file, 0o600);
  return { status: "generated", file };
}

function parseManageArguments(args: readonly string[]): { command: ManageCommand; options: ManageOptions } {
  const command = args[0] as ManageCommand | undefined;
  if (!command || !["start", "status", "stop", "watchdog", "systemd"].includes(command)) throw new Error("USAGE: course-service-manage.ts start|status|stop|watchdog|systemd");
  const options: ManageOptions = {};
  let index = 1;
  while (index < args.length) {
    const option = args[index++];
    if (option === "--once") { options.once = true; continue; }
    const value = args[index++];
    if (!value) throw new Error("SERVICE_MANAGE_OPTIONS_INVALID");
    switch (option) {
      case "--data-dir": options.dataDir = value; break;
      case "--root": options.packageRoot = value; break;
      case "--port": options.port = optionNumber(value, 3050, 1024, 65535, "SERVICE_PORT_INVALID"); break;
      case "--startup-timeout-ms": options.startupTimeoutMs = optionNumber(value, 15_000, 100, 300_000, "SERVICE_TIMEOUT_INVALID"); break;
      case "--stop-timeout-ms": options.stopTimeoutMs = optionNumber(value, 15_000, 100, 300_000, "SERVICE_TIMEOUT_INVALID"); break;
      case "--poll-ms": options.pollMs = optionNumber(value, 1_000, 10, 300_000, "SERVICE_POLL_INVALID"); break;
      case "--backoff-ms": options.backoffMs = optionNumber(value, 500, 0, 300_000, "SERVICE_BACKOFF_INVALID"); break;
      case "--max-backoff-ms": options.maxBackoffMs = optionNumber(value, 30_000, 0, 3_600_000, "SERVICE_BACKOFF_INVALID"); break;
      case "--max-restarts": options.maxRestarts = positiveInteger(value, "SERVICE_RESTART_LIMIT_INVALID"); break;
      case "--restart-window-ms": options.restartWindowMs = optionNumber(value, 300_000, 100, 86_400_000, "SERVICE_RESTART_WINDOW_INVALID"); break;
      case "--output": options.output = value; break;
      default: throw new Error("SERVICE_MANAGE_OPTIONS_INVALID");
    }
  }
  return { command, options };
}

export async function runCourseServiceManage(args = process.argv.slice(2)): Promise<void> {
  if (!args.length || args[0] === "--help") {
    process.stdout.write("课程服务后台管理（不安装全局服务）\n用法: start|status|stop|watchdog [--data-dir PATH] [--root PACKAGE_ROOT] [--port PORT]\nwatchdog 支持 --max-restarts、--backoff-ms、--max-backoff-ms、--once；systemd --output PATH 只生成 unit。\nstop 通过 bridge-key + expectedInstanceId 请求本机 shutdown，身份不匹配时拒绝操作。\n");
    return;
  }
  const parsed = parseManageArguments(args);
  let value: unknown;
  if (parsed.command === "start") value = await startManagedService(parsed.options);
  else if (parsed.command === "status") value = await inspectManagedService(parsed.options);
  else if (parsed.command === "stop") value = await stopManagedService(parsed.options);
  else if (parsed.command === "watchdog") value = await watchdogManagedService(parsed.options);
  else value = await writeSystemdUnit(parsed.options);
  // runtimeToken is a local identity secret used only to fence manager state;
  // never echo it to a Bot or shell log.
  process.stdout.write(`${JSON.stringify(value, (key, nested) => key === "runtimeToken" ? undefined : nested)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCourseServiceManage().catch((error) => {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}(?::[A-Z0-9_]+)?$/.test(error.message) ? error.message : "SERVICE_MANAGEMENT_FAILED";
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = 1;
  });
}
