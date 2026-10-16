import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Portable service smoke contract.
 *
 * This script deliberately talks to the service over HTTP.  It does not import
 * the browser store, use the MCP worker, start Next, or inspect a production
 * database.  Every course, run, observation, and timestamp below is synthetic.
 */

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE_SCRIPT = path.join(SOURCE_ROOT, "scripts", "portable-course-service.ts");
const CLI_SCRIPT = path.join(SOURCE_ROOT, "scripts", "course-service-cli.ts");
const MCP_SCRIPT = path.join(SOURCE_ROOT, "scripts", "portable-course-mcp.ts");
const TSX_CLI = path.join(SOURCE_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const JSON_HEADERS = { "Content-Type": "application/json" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type JsonObject = Record<string, unknown>;
type HttpResult = { status: number; body: unknown };
type ServiceProcess = ChildProcess & { capturedStdout?: string; capturedStderr?: string };

function asObject(value: unknown, context: string): JsonObject {
  assert.equal(typeof value, "object", `${context} should be an object`);
  assert.notEqual(value, null, `${context} should not be null`);
  assert.equal(Array.isArray(value), false, `${context} should not be an array`);
  return value as JsonObject;
}

function nestedObject(value: unknown, key: string, context: string): JsonObject {
  return asObject(asObject(value, context)[key], `${context}.${key}`);
}

async function request(base: URL, pathname: string, init: RequestInit = {}): Promise<HttpResult> {
  const response = await fetch(new URL(pathname, base), {
    ...init,
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(10_000)
  });
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  return { status: response.status, body };
}

async function authorizedRequest(base: URL, pathname: string, bridgeKey: string, body: unknown): Promise<HttpResult> {
  return request(base, pathname, {
    method: "POST",
    headers: { ...JSON_HEADERS, "X-Course-Bridge-Key": bridgeKey },
    body: JSON.stringify(body)
  });
}

async function expectStatus(result: HttpResult, statuses: number[], context: string): Promise<void> {
  assert.ok(statuses.includes(result.status), `${context}: unexpected HTTP ${result.status}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "free port allocation failed");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function commandEnv(dataDir: string, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CMOOC_SERVICE_DATA_DIR: dataDir,
    CMOOC_SERVICE_PORT: String(port),
    CMOOC_PORTABLE_SERVICE_ORIGIN: `http://127.0.0.1:${port}`,
    CMOOC_WORKBENCH_ROOT: SOURCE_ROOT,
    CMOOC_DISABLE_WINDOWS_ENV_FALLBACK: "1",
    LLM_MODE: "mock"
  };
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function runCommand(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, SERVICE_SCRIPT, ...args], {
      cwd: SOURCE_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8").slice(0, 4000); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8").slice(0, 4000); });
    child.once("error", () => reject(new Error(`service command failed to start: ${args[0]}`)));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`service command timed out: ${args[0]}`));
    }, 60_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      // Keep failures useful without exposing arbitrary child output, which may
      // contain an environment-specific path or an implementation detail.
      const detail = `${stdout} ${stderr}`.replace(/\s+/g, " ").trim().slice(0, 240);
      reject(new Error(`service command ${args[0]} exited ${code ?? signal}${detail ? ` (${detail})` : ""}`));
    });
  });
}

function startService(env: NodeJS.ProcessEnv): ServiceProcess {
  const child = spawn(process.execPath, [TSX_CLI, SERVICE_SCRIPT, "start"], {
    cwd: SOURCE_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  }) as ServiceProcess;
  child.capturedStdout = "";
  child.capturedStderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    child.capturedStdout = `${child.capturedStdout}${chunk.toString("utf8")}`.slice(-4000);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    child.capturedStderr = `${child.capturedStderr}${chunk.toString("utf8")}`.slice(-4000);
  });
  return child;
}

async function stopService(child: ServiceProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve();
    }, 8_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function waitForHealth(base: URL, child: ServiceProcess): Promise<JsonObject> {
  const deadline = Date.now() + 30_000;
  let lastError = "service did not answer";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`portable service exited before health check (${child.exitCode ?? child.signalCode})`);
    }
    try {
      const result = await request(base, "/health", { signal: AbortSignal.timeout(1_000) });
      if (result.status === 200) return asObject(result.body, "health response");
      lastError = `health HTTP ${result.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "health request failed";
    }
    await sleep(100);
  }
  throw new Error(`portable service health timeout: ${lastError}`);
}

async function processCommandLine(pid: number): Promise<string> {
  if (process.platform === "linux") {
    try {
      const raw = await readFile(`/proc/${pid}/cmdline`);
      return raw.toString("utf8").replaceAll("\0", " ").trim();
    } catch {
      return "";
    }
  }
  return new Promise((resolve) => {
    const child = spawn("ps", ["-p", String(pid), "-o", "command="], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.once("error", () => resolve(""));
    child.once("exit", () => resolve(output.trim()));
  });
}

async function runJsonChild(args: string[], env: NodeJS.ProcessEnv, label: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: SOURCE_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8").slice(0, 1_000_000); });
    child.stderr?.resume();
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${label} timed out`));
    }, 30_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error(`${label} failed to start`));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${label} exited ${code ?? signal}`));
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      if (!lines.length) return reject(new Error(`${label} returned no JSON`));
      try {
        resolve(JSON.parse(lines.at(-1)!));
      } catch {
        reject(new Error(`${label} returned invalid JSON`));
      }
    });
  });
}

async function runCliAction(action: string, inputPath: string, session: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  const value = await runJsonChild([TSX_CLI, CLI_SCRIPT, action, "--input", inputPath, "--session", session], env, `CLI ${action}`);
  assert.equal(JSON.stringify(value).includes("leaseToken"), false, `CLI ${action} must not expose its lease token`);
  return value;
}

function mcpText(value: unknown, context: string): string {
  const object = asObject(value, context);
  const content = object.content;
  assert.ok(Array.isArray(content), `${context} should return MCP content`);
  const textBlock = content.find((item) => asObject(item, `${context}.content`).type === "text");
  assert.ok(textBlock, `${context} should return a text block`);
  const textValue = asObject(textBlock, `${context}.text block`).text;
  assert.equal(typeof textValue, "string", `${context} text should be a string`);
  return textValue as string;
}

async function runPortableMcpSmoke(env: NodeJS.ProcessEnv): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, MCP_SCRIPT],
    cwd: SOURCE_ROOT,
    env: stringEnv({ ...env, CMOOC_PORTABLE_MODE: "1" }),
    stderr: "pipe"
  });
  const client = new Client({ name: "portable-course-smoke", version: "1" });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    const names = catalog.tools.map((tool) => tool.name);
    assert.ok(names.includes("get_course_workspace"), "portable MCP should expose get_course_workspace");
    assert.ok(names.includes("search_public_practice"), "portable MCP should expose search_public_practice");
    assert.ok(names.includes("get_portable_service_health"), "portable MCP should expose health");
    const workspace = JSON.parse(mcpText(await client.callTool({ name: "get_course_workspace", arguments: {} }), "MCP workspace"));
    const workspaceObject = asObject(workspace, "MCP workspace result");
    assert.ok(Array.isArray(workspaceObject.courses), "MCP workspace should expose courses");
    const knowledge = JSON.parse(mcpText(await client.callTool({ name: "search_public_practice", arguments: { query: "反馈", limit: 3 } }), "MCP knowledge"));
    const knowledgeObject = asObject(knowledge, "MCP knowledge result");
    assert.ok(Array.isArray(knowledgeObject.results), "MCP knowledge should expose results");
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

function syntheticObservation(entryUrl: string, observedAt: string): JsonObject {
  return {
    courseUrl: entryUrl,
    observedAt,
    scope: "course",
    complete: false,
    expectedDiscussions: 1,
    coverageNote: "Synthetic smoke observation; discussion creation time is unavailable.",
    pages: [{ url: entryUrl, itemCount: 1, terminal: true }],
    discussions: [{
      ref: "SMOKE-D1",
      url: entryUrl,
      title: "Synthetic discussion",
      summary: "Synthetic observation with intentionally missing time evidence.",
      complete: false
    }],
    posts: [{
      ref: "SMOKE-P1",
      discussionRef: "SMOKE-D1",
      parentRef: null,
      actorAlias: "A",
      role: "learner",
      createdAt: null,
      url: entryUrl
    }]
  };
}

function proposal(): JsonObject {
  return {
    discussionRef: "SMOKE-D1",
    decision: "ABSTAIN",
    reason: "Creation time is unavailable; do not infer a support-gap duration.",
    draft: ""
  };
}

function assertNoCodexOrNextStart(commandLine: string): void {
  assert.ok(commandLine, "portable service process should be inspectable");
  assert.equal(/codex/i.test(commandLine), false, "portable service must not launch Codex");
  assert.equal(/next(?:\.js)?\s+start/i.test(commandLine), false, "portable service must not launch Next start");
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "cmooc-portable-service-smoke-"));
  const port = Number(process.env.CMOOC_SERVICE_PORT || await freePort());
  const env = commandEnv(dataDir, port);
  const base = new URL(`http://127.0.0.1:${port}`);
  let service: ServiceProcess | undefined;
  const checks: string[] = [];

  try {
    await runCommand(["setup"], env);
    checks.push("setup");
    await runCommand(["doctor"], env);
    checks.push("doctor");

    service = startService(env);
    const health = await waitForHealth(base, service);
    assert.equal(health.codexRequired, false);
    assert.equal(health.realPublishEnabled, false);
    checks.push("health");

    const unauthenticated = await request(base, "/api/portable/courses", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ action: "workspace" })
    });
    assert.ok([401, 403].includes(unauthenticated.status), `unauthenticated request should be rejected, got ${unauthenticated.status}`);
    checks.push("unauthenticated-rejected");

    const keyPath = path.join(dataDir, "browser-courses", "bridge-key");
    const bridgeKey = (await readFile(keyPath, "utf8")).trim();
    assert.ok(bridgeKey.length >= 32, "setup should create a private bridge key");

    const courseBody = {
      action: "add",
      course: {
        title: "Portable synthetic smoke course",
        entryUrl: "https://example.invalid/courses/portable-smoke",
        platformLabel: "synthetic",
        goal: "Exercise the portable course bridge with synthetic evidence.",
        budget: 1
      }
    };
    const added = await authorizedRequest(base, "/api/portable/courses", bridgeKey, courseBody);
    await expectStatus(added, [200], "course registration");
    const course = nestedObject(added.body, "course", "course registration");
    const courseId = String(course.id);
    assert.match(courseId, /^[0-9a-f-]{36}$/i, "registered course id should be a UUID");
    assert.equal(course.entryUrl, courseBody.course.entryUrl);
    checks.push("synthetic-course-registration");

    const requestId = randomUUID();
    const created = await authorizedRequest(base, "/api/portable/courses", bridgeKey, {
      action: "run", courseId, requestId, goal: "Observe synthetic course evidence.", mode: "observe"
    });
    await expectStatus(created, [200, 202], "external-host run creation");
    const createdRun = nestedObject(created.body, "run", "run creation");
    const runId = String(createdRun.id);
    assert.equal(createdRun.executor, "external_host");
    assert.equal(createdRun.status, "queued");
    checks.push("external-host-run");

    const owner = randomUUID();
    const claim = await authorizedRequest(base, "/api/workbench/browser-agent", bridgeKey, {
      action: "claim", runId, owner
    });
    await expectStatus(claim, [200], "run claim");
    const claimValue = asObject(claim.body, "run claim");
    const claimRun = nestedObject(claim.body, "run", "run claim");
    const leaseToken = String(claimValue.leaseToken || "");
    assert.ok(leaseToken.length >= 32, "claim should issue a lease token");
    assert.equal(claimRun.status, "running");

    const observedAt = new Date(Date.now() - 2_000).toISOString();
    const observation = await authorizedRequest(base, "/api/workbench/browser-agent", bridgeKey, {
      action: "observation",
      runId,
      owner,
      leaseToken,
      operationKey: "portable-smoke-observation-v1",
      observation: syntheticObservation(courseBody.course.entryUrl, observedAt)
    });
    await expectStatus(observation, [200], "synthetic observation");

    const proposals = await authorizedRequest(base, "/api/workbench/browser-agent", bridgeKey, {
      action: "proposals",
      runId,
      owner,
      leaseToken,
      operationKey: "portable-smoke-proposals-v1",
      proposals: [proposal()]
    });
    await expectStatus(proposals, [200], "synthetic proposals");
    const proposalValue = asObject(proposals.body, "synthetic proposals");
    const middleLayer = asObject(proposalValue.middleLayer, "synthetic proposals.middleLayer");
    assert.equal(middleLayer.publishAllowed, false);
    const middleResults = middleLayer.results;
    assert.ok(Array.isArray(middleResults) && middleResults.length === 1, "middle layer should evaluate one synthetic discussion");
    assert.equal(asObject(middleResults[0], "middle layer result").baseline, "ABSTAIN");
    checks.push("observation-proposals-abstain-middle-layer");

    const proposalsReplay = await authorizedRequest(base, "/api/workbench/browser-agent", bridgeKey, {
      action: "proposals",
      runId,
      owner,
      leaseToken,
      operationKey: "portable-smoke-proposals-v1",
      proposals: [proposal()]
    });
    await expectStatus(proposalsReplay, [200], "idempotent proposals retry");
    assert.equal(asObject(asObject(proposalsReplay.body, "idempotent proposals retry").middleLayer, "idempotent proposals retry.middleLayer").replayed, true);
    checks.push("operation-idempotence");

    const finished = await authorizedRequest(base, "/api/workbench/browser-agent", bridgeKey, {
      action: "finish",
      runId,
      owner,
      leaseToken,
      operationKey: "portable-smoke-finish-v1",
      summary: "Synthetic portable smoke run completed in observe mode."
    });
    await expectStatus(finished, [200], "run finish");
    const finishedRun = asObject(finished.body, "run finish");
    assert.equal(finishedRun.status, "completed");
    const finishedMiddleLayer = asObject(finishedRun.middleLayer, "run finish.middleLayer");
    assert.equal(finishedMiddleLayer.publishAllowed, false);
    checks.push("finish-and-publish-lock");

    await stopService(service);
    service = undefined;
    const restarted = startService(env);
    service = restarted;
    const restartedHealth = await waitForHealth(base, restarted);
    assert.equal(restartedHealth.codexRequired, false);

    const statusAfterRestart = await authorizedRequest(base, "/api/portable/courses", bridgeKey, { action: "status", runId });
    await expectStatus(statusAfterRestart, [200], "status after restart");
    assert.equal(nestedObject(statusAfterRestart.body, "run", "status after restart").status, "completed");
    const experience = await authorizedRequest(base, "/api/portable/courses", bridgeKey, { action: "experience", courseId });
    await expectStatus(experience, [200], "experience after restart");
    const experienceValue = asObject(experience.body, "experience after restart");
    assert.equal(experienceValue.available, true);
    assert.ok(Array.isArray(experienceValue.contexts), "experience should expose persisted contexts");
    checks.push("restart-status-experience-readback");

    const replay = await authorizedRequest(base, "/api/portable/courses", bridgeKey, {
      action: "run", courseId, requestId, goal: "Observe synthetic course evidence.", mode: "observe"
    });
    await expectStatus(replay, [200, 202], "idempotent run retry");
    assert.equal(nestedObject(replay.body, "run", "idempotent run retry").id, runId);
    const workspace = await authorizedRequest(base, "/api/portable/courses", bridgeKey, { action: "workspace" });
    await expectStatus(workspace, [200], "workspace readback");
    const workspaceValue = asObject(workspace.body, "workspace readback");
    const runs = workspaceValue.runs;
    assert.ok(Array.isArray(runs), "workspace should return runs");
    assert.equal(runs.filter((item) => asObject(item, "workspace run").requestId === requestId).length, 1);
    checks.push("retry-idempotence");

    const commandLine = await processCommandLine(restarted.pid!);
    assertNoCodexOrNextStart(commandLine);
    const unsupportedPublishRoute = await request(base, "/api/portable/publish", { method: "POST", headers: { ...JSON_HEADERS, "X-Course-Bridge-Key": bridgeKey }, body: "{}" });
    assert.ok([404, 405].includes(unsupportedPublishRoute.status), `portable publish route should be absent, got ${unsupportedPublishRoute.status}`);
    const unsupportedPublishAction = await authorizedRequest(base, "/api/portable/courses", bridgeKey, { action: "publish", courseId });
    assert.ok([400, 404, 405].includes(unsupportedPublishAction.status), `publish action should be absent, got ${unsupportedPublishAction.status}`);
    checks.push("no-codex-no-publish-api");

    const cliInputDir = path.join(dataDir, "smoke-input");
    await mkdir(cliInputDir, { recursive: true, mode: 0o700 });
    async function cliInput(name: string, value: unknown): Promise<string> {
      const file = path.join(cliInputDir, `${name}.json`);
      await writeFile(file, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
      return file;
    }
    const cliWorkspace = asObject(await runCliAction("workspace", await cliInput("workspace", {}), "portable-smoke", env), "CLI workspace");
    assert.ok(Array.isArray(cliWorkspace.courses), "CLI workspace should expose courses");
    const cliKnowledge = asObject(await runCliAction("knowledge", await cliInput("knowledge", { query: "反馈", limit: 3 }), "portable-smoke", env), "CLI knowledge");
    assert.ok(Array.isArray(cliKnowledge.results), "CLI knowledge should expose results");

    const cliRunId = randomUUID();
    const cliRun = asObject(await runCliAction("run", await cliInput("run", { courseId, requestId: cliRunId, mode: "observe" }), "portable-smoke", env), "CLI run");
    assert.equal(cliRun.executor, "external_host");
    const cliTaskId = String(cliRun.id);
    const cliClaim = asObject(await runCliAction("claim", await cliInput("claim", { runId: cliTaskId }), "portable-smoke", env), "CLI claim");
    assert.equal(nestedObject(cliClaim, "run", "CLI claim").status, "running");
    const cliAttention = asObject(await runCliAction("attention", await cliInput("attention", { runId: cliTaskId, message: "Synthetic CLI attention." }), "portable-smoke", env), "CLI attention");
    assert.equal(cliAttention.status, "needs_attention");
    const sessionFile = path.join(dataDir, "cli-sessions", "portable-smoke.json");
    assert.equal((await stat(sessionFile)).mode & 0o077, 0, "CLI session containing the private lease must be owner-only");
    const cliResumed = asObject(await runCliAction("resume", await cliInput("resume", { runId: cliTaskId }), "portable-smoke", env), "CLI resume");
    assert.equal(cliResumed.status, "queued");
    await runCliAction("stop", await cliInput("stop", { runId: cliTaskId }), "portable-smoke", env);
    checks.push("cross-process-cli-workspace-knowledge-lease");

    await runPortableMcpSmoke(env);
    checks.push("portable-mcp-list-tools-workspace-knowledge");

    // Stop releases the lease and leaves an interrupted task resumable.  A
    // second independent task exercises the recoverable needs_attention path.
    const stoppedRequestId = randomUUID();
    const stoppedCreated = await authorizedRequest(base, "/api/portable/courses", bridgeKey, { action: "run", courseId, requestId: stoppedRequestId, mode: "observe" });
    await expectStatus(stoppedCreated, [200, 202], "stop test run creation");
    const stoppedRunId = String(nestedObject(stoppedCreated.body, "run", "stop test run creation").id);
    const stopped = await authorizedRequest(base, "/api/portable/courses", bridgeKey, { action: "stop", runId: stoppedRunId });
    await expectStatus(stopped, [200], "stop test run");
    const stoppedValue = nestedObject(stopped.body, "run", "stop test run");
    assert.equal(stoppedValue.status, "interrupted");
    const stoppedResume = await authorizedRequest(base, "/api/portable/courses", bridgeKey, { action: "resume", runId: stoppedRunId });
    await expectStatus(stoppedResume, [200], "stop then resume");
    assert.equal(nestedObject(stoppedResume.body, "run", "stop then resume").status, "queued");
    await expectStatus(await authorizedRequest(base, "/api/portable/courses", bridgeKey, { action: "stop", runId: stoppedRunId }), [200], "stop resumed run cleanup");

    const recoverRequestId = randomUUID();
    const recoverCreated = await authorizedRequest(base, "/api/portable/courses", bridgeKey, { action: "run", courseId, requestId: recoverRequestId, mode: "observe" });
    await expectStatus(recoverCreated, [200, 202], "resume test run creation");
    const recoverRunId = String(nestedObject(recoverCreated.body, "run", "resume test run creation").id);
    const recoverOwner = randomUUID();
    const recoverClaim = await authorizedRequest(base, "/api/workbench/browser-agent", bridgeKey, { action: "claim", runId: recoverRunId, owner: recoverOwner });
    await expectStatus(recoverClaim, [200], "resume test claim");
    const recoverToken = String(asObject(recoverClaim.body, "resume test claim").leaseToken || "");
    const attention = await authorizedRequest(base, "/api/workbench/browser-agent", bridgeKey, { action: "attention", runId: recoverRunId, owner: recoverOwner, leaseToken: recoverToken, message: "Synthetic recoverable attention." });
    await expectStatus(attention, [200], "recoverable attention");
    assert.equal(asObject(attention.body, "recoverable attention").status, "needs_attention");
    const resumed = await authorizedRequest(base, "/api/portable/courses", bridgeKey, { action: "resume", runId: recoverRunId });
    await expectStatus(resumed, [200], "recoverable resume");
    assert.equal(nestedObject(resumed.body, "run", "recoverable resume").status, "queued");
    await expectStatus(await authorizedRequest(base, "/api/portable/courses", bridgeKey, { action: "stop", runId: recoverRunId }), [200], "recoverable run cleanup");
    checks.push("stop-and-attention-resume");

    console.log(JSON.stringify({
      status: "PASS",
      checkedAt: new Date().toISOString(),
      service: "portable-course-service",
      syntheticOnly: true,
      realPublishEnabled: false,
      codexRequired: false,
      checks,
      dataDirRemoved: true
    }));
  } finally {
    if (service) await stopService(service);
    await rm(dataDir, { recursive: true, force: true });
  }
}

export { SOURCE_ROOT, SERVICE_SCRIPT, CLI_SCRIPT, MCP_SCRIPT, TSX_CLI, asObject, nestedObject, request, authorizedRequest, expectStatus, freePort, commandEnv, stringEnv, runCommand, startService, stopService, waitForHealth, mcpText };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch((error) => {
  const message = error instanceof Error ? error.message : "portable smoke failed";
  console.error(JSON.stringify({ status: "FAIL", error: message.replace(/bridge-key|leaseToken/gi, "redacted") }));
  process.exitCode = 1;
});
