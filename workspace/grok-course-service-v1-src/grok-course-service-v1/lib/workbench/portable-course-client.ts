import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  browserObservationSchema,
  browserParticipationChoiceSchema,
  browserProposalSchema,
  browserReplyReceiptSchema,
  browserReplyUptakeSchema,
  browserStageSchema,
  createBrowserCourseSchema,
  MAX_BROWSER_DISCUSSIONS,
  type BrowserCourse,
  type BrowserCourseRun,
  type BrowserObservation,
  type BrowserParticipationChoice,
  type BrowserProposalInput,
  type BrowserReplyReceipt,
  type BrowserReplyUptake,
  type BrowserWorkspaceSnapshot,
} from "./browser-course-contracts";

/**
 * The portable host owns this state.  It is deliberately limited to the
 * execution identity and opaque lease tokens; bridge keys never belong in a
 * serialised session or an MCP response.
 */
export type PortableCourseClientSession = {
  owner: string;
  leases: Record<string, string>;
};

export type PortableCourseClientOptions = {
  /** Loopback HTTP origin of the independent course service. */
  serviceOrigin?: string;
  /** Directory containing bridge-key. Relative values are resolved from the package root. */
  dataDir?: string;
  /** Test-only or explicitly injected secret. Never included in exportSession(). */
  bridgeKey?: string;
  /** Optional legacy bridge-key location used by the Codex plugin compatibility path. */
  bridgeKeyPath?: string;
  /** Restrict every execution call to one already-created run. */
  fixedRunId?: string;
  /** Optional execution connection retained for legacy Codex-host runs. */
  executionRunId?: string;
  /** Existing host session restored by the caller (for example a CLI). */
  session?: Partial<PortableCourseClientSession>;
  /** Injectable transport for unit tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Use the old browser-agent workspace action for legacy Codex plugin checks. */
  workspaceTransport?: "portable" | "agent";
};

export type PortableCourse = BrowserCourse;
export type PortableCourseRun = BrowserCourseRun & {
  /** Added by the portable service; older local contracts do not know this value. */
  executor: BrowserCourseRun["executor"] | "external_host";
};

export type PortableExperienceWorkspace = Record<string, unknown>;
export type PortableServiceHealth = Record<string, unknown>;

const uuid = z.string().uuid();
const ownerSchema = uuid;
const leaseSchema = z.record(z.string().uuid(), z.string().min(1));
const sessionSchema = z.object({ owner: ownerSchema, leases: leaseSchema }).strict();

function packageRoot(): string {
  const configured = process.env.CMOOC_WORKBENCH_ROOT || process.env.CMOOC_PACKAGE_ROOT;
  if (configured) {
    const root = path.resolve(configured);
    if (existsSync(path.join(root, "package.json"))) return root;
    const sourceRoot = path.join(root, "源码");
    if (existsSync(path.join(sourceRoot, "package.json"))) return sourceRoot;
  }
  const cwd = path.resolve(process.cwd());
  if (existsSync(path.join(cwd, "package.json"))) return cwd;
  const sourceRoot = path.join(cwd, "源码");
  if (existsSync(path.join(sourceRoot, "package.json"))) return sourceRoot;
  return cwd;
}

export function resolvePortableServiceDataDir(value?: string): string {
  const configured = value ?? process.env.CMOOC_SERVICE_DATA_DIR;
  if (!configured) return path.join(packageRoot(), ".cmooc-service-data");
  return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(packageRoot(), configured);
}

export function resolvePortableServiceOrigin(value?: string): string {
  const raw = value ?? process.env.CMOOC_PORTABLE_SERVICE_ORIGIN ?? `http://127.0.0.1:${process.env.CMOOC_SERVICE_PORT || "3050"}`;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("PORTABLE_SERVICE_ORIGIN_INVALID"); }
  if (![
    "127.0.0.1",
    "localhost",
    "[::1]"
  ].includes(parsed.hostname) || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("PORTABLE_SERVICE_LOOPBACK_REQUIRED");
  }
  return parsed.origin;
}

function parseSession(value: Partial<PortableCourseClientSession> | undefined): PortableCourseClientSession {
  const candidate = {
    owner: value?.owner ?? randomUUID(),
    leases: value?.leases ?? {}
  };
  return sessionSchema.parse(candidate);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bodyValue<T>(value: unknown, key: string): T {
  const object = jsonObject(value);
  return (key in object ? object[key] : value) as T;
}

export class PortableCourseClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "PortableCourseClientError";
  }
}

export class PortableCourseClient {
  readonly serviceOrigin: string;
  readonly dataDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly fixedRunId?: string;
  private readonly executionRunId?: string;
  private readonly workspaceTransport: "portable" | "agent";
  private readonly injectedBridgeKey?: string;
  private readonly bridgeKeyPath?: string;
  private bridgeKeyPromise?: Promise<string>;
  private readonly sessionState: PortableCourseClientSession;

  constructor(options: PortableCourseClientOptions = {}) {
    this.serviceOrigin = resolvePortableServiceOrigin(options.serviceOrigin);
    this.dataDir = resolvePortableServiceDataDir(options.dataDir);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fixedRunId = options.fixedRunId ? uuid.parse(options.fixedRunId) : undefined;
    this.executionRunId = options.executionRunId ? uuid.parse(options.executionRunId) : undefined;
    this.workspaceTransport = options.workspaceTransport ?? "portable";
    this.injectedBridgeKey = options.bridgeKey;
    this.bridgeKeyPath = options.bridgeKeyPath;
    this.sessionState = parseSession(options.session);
  }

  /** Export only lease state needed to resume this host session. */
  exportSession(): PortableCourseClientSession {
    return { owner: this.sessionState.owner, leases: { ...this.sessionState.leases } };
  }

  get owner(): string { return this.sessionState.owner; }

  private resolveRunId(value?: string): string {
    const runId = value ?? this.fixedRunId;
    if (!runId) throw new PortableCourseClientError("RUN_ID_REQUIRED");
    const parsed = uuid.parse(runId);
    if (this.fixedRunId && parsed !== this.fixedRunId) throw new PortableCourseClientError("任务范围不一致。");
    return parsed;
  }

  private assertManagementScope(): void {
    if (this.fixedRunId) throw new PortableCourseClientError("FIXED_RUN_SCOPE");
  }

  private async bridgeKey(): Promise<string> {
    if (!this.bridgeKeyPromise) {
      this.bridgeKeyPromise = (async () => {
        let raw: string;
        if (this.injectedBridgeKey !== undefined) raw = this.injectedBridgeKey;
        else {
          try { raw = await readFile(this.bridgeKeyPath ?? path.join(this.dataDir, "browser-courses", "bridge-key"), "utf8"); }
          catch { throw new PortableCourseClientError("BRIDGE_KEY_UNAVAILABLE"); }
        }
        const value = raw.trim();
        if (!/^[a-f0-9]{64}$/.test(value)) throw new PortableCourseClientError("BRIDGE_KEY_INVALID");
        return value;
      })();
    }
    return this.bridgeKeyPromise;
  }

  private async request(pathname: string, init: RequestInit = {}, authenticated = true): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    if (authenticated) headers.set("X-Course-Bridge-Key", await this.bridgeKey());
    const controller = new AbortController();
    const timer = this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
    try {
      const response = await this.fetchImpl(new URL(pathname, this.serviceOrigin), { ...init, headers, signal: controller.signal, redirect: "error" });
      const text = await response.text();
      let value: unknown = null;
      if (text) {
        try { value = JSON.parse(text); } catch { value = { error: "SERVICE_RESPONSE_INVALID" }; }
      }
      if (!response.ok) {
        const payload = jsonObject(value);
        const message = typeof payload.error === "string" ? payload.error : `SERVICE_HTTP_${response.status}`;
        throw new PortableCourseClientError(message, response.status, typeof payload.code === "string" ? payload.code : undefined);
      }
      return value;
    } catch (error) {
      if (error instanceof PortableCourseClientError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw new PortableCourseClientError("SERVICE_TIMEOUT");
      throw new PortableCourseClientError(error instanceof Error ? error.message : "SERVICE_UNAVAILABLE");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async management(action: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return jsonObject(await this.request("/api/portable/courses", {
      method: "POST",
      body: JSON.stringify({ action, ...body })
    }));
  }

  private async agent(action: string, body: Record<string, unknown> = {}, runId?: string): Promise<Record<string, unknown>> {
    const resolvedRunId = action === "workspace" ? (runId ? this.resolveRunId(runId) : this.fixedRunId) : this.resolveRunId(runId);
    const payload: Record<string, unknown> = {
      action,
      owner: this.sessionState.owner,
      ...(resolvedRunId ? { runId: resolvedRunId } : {}),
      ...(this.executionRunId ? { executionRunId: this.executionRunId } : {}),
      ...(resolvedRunId && this.sessionState.leases[resolvedRunId] ? { leaseToken: this.sessionState.leases[resolvedRunId] } : {}),
      ...body
    };
    const value = jsonObject(await this.request("/api/workbench/browser-agent", {
      method: "POST",
      body: JSON.stringify(payload)
    }));
    if (resolvedRunId && typeof value.leaseToken === "string") {
      this.sessionState.leases[resolvedRunId] = value.leaseToken;
      delete value.leaseToken;
    }
    return value;
  }

  async health(): Promise<PortableServiceHealth> {
    return jsonObject(await this.request("/health", { method: "GET" }, false));
  }

  async workspace(): Promise<BrowserWorkspaceSnapshot> {
    const workspace = this.workspaceTransport === "agent"
      ? bodyValue<BrowserWorkspaceSnapshot>(await this.agent("workspace"), "workspace")
      : bodyValue<BrowserWorkspaceSnapshot>(await this.management("workspace"), "workspace");
    if (!this.fixedRunId) return workspace;
    const runs = workspace.runs.filter(run => run.id === this.fixedRunId);
    const courseIds = new Set(runs.map(run => run.courseId));
    return {
      ...workspace,
      courses: workspace.courses.filter(course => courseIds.has(course.id)),
      runs,
      graphs: Object.fromEntries(Object.entries(workspace.graphs).filter(([id]) => runs.some(run => run.id === id))),
      connectionHealth: workspace.connectionHealth?.filter(item => courseIds.has(item.courseId))
    };
  }

  async registerCourse(input: z.input<typeof createBrowserCourseSchema>): Promise<PortableCourse> {
    this.assertManagementScope();
    const course = createBrowserCourseSchema.parse(input);
    return bodyValue<PortableCourse>(await this.management("add", { course }), "course");
  }

  async createCourseRun(input: { courseId: string; requestId: string; goal?: string; mode?: "observe" | "stage" }): Promise<PortableCourseRun> {
    this.assertManagementScope();
    const payload = {
      courseId: uuid.parse(input.courseId), requestId: uuid.parse(input.requestId),
      ...(input.goal === undefined ? {} : { goal: z.string().trim().min(1).max(800).parse(input.goal) }), mode: z.enum(["observe", "stage"]).default("observe").parse(input.mode)
    };
    return bodyValue<PortableCourseRun>(await this.management("run", payload), "run");
  }

  async getCourseRun(runId?: string): Promise<PortableCourseRun> {
    return bodyValue<PortableCourseRun>(await this.management("status", { runId: this.resolveRunId(runId) }), "run");
  }

  async stopCourseRun(runId?: string): Promise<PortableCourseRun> {
    const resolvedRunId = this.resolveRunId(runId);
    const result = bodyValue<PortableCourseRun>(await this.management("stop", { runId: resolvedRunId }), "run");
    delete this.sessionState.leases[resolvedRunId];
    return result;
  }

  async resumeCourseRun(runId?: string): Promise<PortableCourseRun> {
    const resolvedRunId = this.resolveRunId(runId);
    const result = bodyValue<PortableCourseRun>(await this.management("resume", { runId: resolvedRunId }), "run");
    delete this.sessionState.leases[resolvedRunId];
    return result;
  }

  async readCourseExperience(courseId: string): Promise<PortableExperienceWorkspace> {
    const parsedCourseId = uuid.parse(courseId);
    if (this.fixedRunId) {
      const workspace = await this.workspace();
      if (!workspace.runs.some(run => run.id === this.fixedRunId && run.courseId === parsedCourseId)) throw new PortableCourseClientError("FIXED_RUN_SCOPE");
    }
    return bodyValue<PortableExperienceWorkspace>(await this.management("experience", { courseId: parsedCourseId }), "experience");
  }

  async searchPublicPractice(input: { query?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    const query = z.string().trim().max(200).default("").parse(input.query);
    const limit = z.number().int().min(1).max(20).default(5).parse(input.limit);
    return bodyValue<Record<string, unknown>>(await this.management("knowledge", { query, limit }), "knowledge");
  }

  async claimCourseRun(runId?: string): Promise<Record<string, unknown>> {
    return this.agent("claim", {}, runId);
  }

  async patrolBegin(runId?: string): Promise<Record<string, unknown>> {
    return this.agent("patrol_begin", {}, runId);
  }

  async readCourseGuidance(runId?: string): Promise<Record<string, unknown>> {
    return this.agent("guidance", {}, runId);
  }

  async recordCourseObservation(observation: BrowserObservation, runId?: string, operationKey?: string): Promise<Record<string, unknown>> {
    const parsed = browserObservationSchema.parse(observation);
    return this.agent("observation", { observation: parsed, ...(operationKey ? { operationKey } : {}) }, runId);
  }

  async saveCourseProposals(proposals: BrowserProposalInput[], runId?: string, operationKey?: string): Promise<Record<string, unknown>> {
    if (proposals.length > MAX_BROWSER_DISCUSSIONS) throw new PortableCourseClientError("PROPOSAL_LIMIT");
    const parsed = z.array(browserProposalSchema).max(MAX_BROWSER_DISCUSSIONS).parse(proposals);
    return this.agent("proposals", { proposals: parsed, ...(operationKey ? { operationKey } : {}) }, runId);
  }

  async recordReplyReceipt(receipt: BrowserReplyReceipt, runId?: string, operationKey?: string): Promise<Record<string, unknown>> {
    const parsed = browserReplyReceiptSchema.parse(receipt);
    return this.agent("reply_receipt", { receipt: parsed, ...(operationKey ? { operationKey } : {}) }, runId);
  }

  async recordReplyUptake(uptake: z.input<typeof browserReplyUptakeSchema>, runId?: string, operationKey?: string): Promise<Record<string, unknown>> {
    const parsed = browserReplyUptakeSchema.parse(uptake);
    return this.agent("reply_uptake", { uptake: parsed, ...(operationKey ? { operationKey } : {}) }, runId);
  }

  async recordParticipationChoice(choice: z.input<typeof browserParticipationChoiceSchema>, runId?: string, operationKey?: string): Promise<Record<string, unknown>> {
    const parsed = browserParticipationChoiceSchema.parse(choice);
    return this.agent("participation_choice", { choice: parsed, ...(operationKey ? { operationKey } : {}) }, runId);
  }

  async recordEditorReadback(receipt: z.input<typeof browserStageSchema>, runId?: string, operationKey?: string): Promise<Record<string, unknown>> {
    const parsed = browserStageSchema.parse(receipt);
    return this.agent("stage", { receipt: parsed, ...(operationKey ? { operationKey } : {}) }, runId);
  }

  async finishCourseRun(summary: string, runId?: string, operationKey?: string): Promise<Record<string, unknown>> {
    const resolvedRunId = this.resolveRunId(runId);
    return this.agent("finish", { summary: z.string().trim().min(1).max(800).parse(summary), ...(operationKey ? { operationKey } : {}) }, resolvedRunId);
  }

  async patrolEnd(summary: string, runId?: string, operationKey?: string): Promise<Record<string, unknown>> {
    const resolvedRunId = this.resolveRunId(runId);
    return this.agent("patrol_end", { summary: z.string().trim().min(1).max(800).parse(summary), ...(operationKey ? { operationKey } : {}) }, resolvedRunId);
  }

  async reportCourseAttention(message: string, runId?: string): Promise<Record<string, unknown>> {
    const resolvedRunId = this.resolveRunId(runId);
    const result = await this.agent("attention", { message: z.string().trim().min(1).max(500).parse(message) }, resolvedRunId);
    delete this.sessionState.leases[resolvedRunId];
    return result;
  }

  async markCourseReloginRequired(message: string, runId?: string): Promise<Record<string, unknown>> {
    const resolvedRunId = this.resolveRunId(runId);
    const result = await this.agent("relogin_required", { message: z.string().trim().min(1).max(500).parse(message) }, resolvedRunId);
    delete this.sessionState.leases[resolvedRunId];
    return result;
  }
}

export type {
  BrowserObservation,
  BrowserParticipationChoice,
  BrowserProposalInput,
  BrowserReplyReceipt,
  BrowserReplyUptake,
};
