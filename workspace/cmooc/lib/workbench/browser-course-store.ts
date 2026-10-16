import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { companionContextSchema } from "./companion-context";
import { projectLiveInteractionGraph } from "@/lib/world/live-graph-projector";
import {
  browserObservationSchema, browserProposalSchema, browserReplyReceiptSchema, browserStageSchema, createBrowserCourseSchema,
  isLocalCourseFixture, sameCoursePage, MAX_BROWSER_DISCUSSIONS,
  type BrowserConnectionHealth, type BrowserCourse, type BrowserCourseRun, type BrowserDecisionTapeEntry,
  type BrowserGraph, type BrowserObservation, type BrowserReplyWatch,
  type BrowserTapePayload, type BrowserWorkspaceSnapshot
} from "./browser-course-contracts";

type StoredRun = BrowserCourseRun & { lease: { owner: string; token: string; expiresAt: number } | null };
type State = { version: 1; revision: number; courses: BrowserCourse[]; runs: StoredRun[] };
type StoredOperation = { key: string; action: string; payloadHash: string; at: string };
type StoredRunWithOperations = StoredRun & { operations?: StoredOperation[] };
const EMPTY: State = { version: 1, revision: 0, courses: [], runs: [] };
const LEASE_MS = 20 * 60_000;
const REPLY_WATCH_WINDOW_MS = 24 * 60 * 60_000;
const TAPE_DOMAIN = "cmooc.browser-decision-tape.v1";
let testRoot: string | undefined;
export function setBrowserCourseRootForTests(value?: string) { testRoot = value; }
export function browserCoursePrivateRoot() {
  const workspace = createHash("sha256").update(path.resolve(process.cwd()).toLowerCase()).digest("hex").slice(0, 20);
  return testRoot ?? path.join(process.env.LOCALAPPDATA || path.join(homedir(), ".local", "share"), "cmooc-workbench", "browser-courses", workspace);
}
export class BrowserCourseError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
function fail(code: string, message: string, status = 400): never { throw new BrowserCourseError(code, message, status); }
async function ensureRoot() {
  const root = browserCoursePrivateRoot(); await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) fail("STORE_INVALID", "课程存储目录不可用。", 503);
  return root;
}
async function loadState(): Promise<State> {
  const file = path.join(await ensureRoot(), "workspace.json");
  const stat = await lstat(file).catch((e: NodeJS.ErrnoException) => e.code === "ENOENT" ? null : Promise.reject(e));
  if (!stat) return structuredClone(EMPTY);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 15_000_000) fail("STORE_INVALID", "课程存储需要检查。", 503);
  const state = JSON.parse(await readFile(file, "utf8")) as State;
  if (state.version !== 1 || !Array.isArray(state.courses) || !Array.isArray(state.runs) || !Number.isInteger(state.revision)) fail("STORE_INVALID", "课程存储版本不可用。", 503);
  // R8 shipped before the patrol tape and reply-watch fields existed. Keep
  // those runs resumable while normalising the new append-only projections.
  for (const run of state.runs as StoredRun[]) {
    run.tapeRef ??= `tape:${run.id}`;
    run.tape ??= [];
    run.replyWatches ??= [];
    run.authState ??= "unknown";
    run.phase ??= "patrol";
  }
  return state;
}
async function saveState(state: State) {
  const file = path.join(await ensureRoot(), "workspace.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
}
// One Next service owns writes. The stdio MCP connects to this service instead of opening a second file writer.
const GLOBAL_KEY = "__cmooc_browser_course_queue__";
async function transaction<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
  const global = globalThis as typeof globalThis & { [GLOBAL_KEY]?: Map<string, Promise<unknown>> };
  const queues = global[GLOBAL_KEY] ??= new Map(); const key = browserCoursePrivateRoot();
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const state = await loadState(); const result = await fn(state); state.revision += 1; await saveState(state); return result;
  });
  queues.set(key, next); try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
function getCourse(state: State, id: string) { return state.courses.find((c) => c.id === id) ?? fail("COURSE_MISSING", "课程已不存在。", 404); }
function getRun(state: State, id: string) { return state.runs.find((r) => r.id === id) ?? fail("RUN_MISSING", "课程任务已不存在。", 404); }
function publicRun(run: StoredRun): BrowserCourseRun { const { lease: _lease, operations: _operations, ...rest } = run as StoredRunWithOperations; return structuredClone(rest); }
function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}
function operationDescriptor(action: string, payload: unknown, operationKey?: string) {
  const key = operationKey === undefined
    ? createHash("sha256").update(`${action}\0${stableJson(payload)}`, "utf8").digest("hex")
    : z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).parse(operationKey.trim());
  return { key, action, payloadHash: createHash("sha256").update(stableJson(payload), "utf8").digest("hex") };
}
function replayOperation(run: StoredRun, descriptor: ReturnType<typeof operationDescriptor>): boolean {
  const prior = (run as StoredRunWithOperations).operations?.find((entry) => entry.key === descriptor.key);
  if (!prior) return false;
  if (prior.action !== descriptor.action || prior.payloadHash !== descriptor.payloadHash) fail("OPERATION_CONFLICT", "操作编号已用于另一份课程数据。", 409);
  return true;
}
function rememberOperation(run: StoredRun, descriptor: ReturnType<typeof operationDescriptor>) {
  const value = run as StoredRunWithOperations;
  (value.operations ??= []).push({ ...descriptor, at: new Date().toISOString() });
  if (value.operations.length > 300) value.operations = value.operations.slice(-300);
}
function event(run: StoredRun, step: BrowserCourseRun["events"][number]["step"], message: string) {
  run.updatedAt = new Date().toISOString(); run.revision += 1;
  if (step !== "completed") run.summary = message;
  run.events.push({ at: run.updatedAt, step, message });
  if (run.events.length > 150) run.events = run.events.slice(-150);
}

function tapePayload(payload: BrowserTapePayload): BrowserTapePayload {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value)));
}

function appendTape(run: StoredRun, kind: BrowserDecisionTapeEntry["kind"], payload: BrowserTapePayload, at = new Date()) {
  const entries = (run.tape ??= []);
  const safePayload = tapePayload(payload);
  const seq = entries.length + 1;
  const previousHash = entries.at(-1)?.entryHash ?? null;
  const ref = `${run.tapeRef ?? `tape:${run.id}`}:${seq}`;
  const atIso = at.toISOString();
  const entryHash = createHash("sha256").update(`${TAPE_DOMAIN}\0${run.tapeRef ?? run.id}\0${seq}\0${atIso}\0${kind}\0${stableJson(safePayload)}\0${previousHash ?? ""}`, "utf8").digest("hex");
  entries.push({ seq, at: atIso, kind, ref, previousHash, entryHash, payload: safePayload });
  return entries.at(-1)!;
}

export function verifyBrowserDecisionTape(run: Pick<BrowserCourseRun, "id" | "tapeRef" | "tape">) {
  const entries = run.tape ?? [];
  let previousHash: string | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.seq !== index + 1 || entry.previousHash !== previousHash) return { valid: false as const, entryCount: entries.length, headHash: entries.at(-1)?.entryHash ?? null };
    const expected: string = createHash("sha256").update(`${TAPE_DOMAIN}\0${run.tapeRef ?? run.id}\0${entry.seq}\0${entry.at}\0${entry.kind}\0${stableJson(tapePayload(entry.payload))}\0${entry.previousHash ?? ""}`, "utf8").digest("hex");
    if (expected !== entry.entryHash) return { valid: false as const, entryCount: entries.length, headHash: entries.at(-1)?.entryHash ?? null };
    previousHash = entry.entryHash;
  }
  return { valid: true as const, entryCount: entries.length, headHash: previousHash };
}

function decisionCounts(run: BrowserCourseRun) {
  return run.proposals.reduce((counts, proposal) => {
    counts[proposal.decision] += 1;
    return counts;
  }, { DRAFT: 0, WAIT: 0, YIELD: 0, ABSTAIN: 0 });
}

function latestObservationPostRefs(run: BrowserCourseRun, discussionRef: string) {
  return new Set((run.observation?.posts ?? []).filter((post) => post.discussionRef === discussionRef).map((post) => post.ref));
}

function evaluateReplyWatches(run: StoredRun, observation: BrowserObservation, observedAt: Date) {
  const watches = run.replyWatches ?? [];
  for (const watch of watches) {
    if (["received", "needs_rethread", "outcome_unknown", "relogin_required"].includes(watch.state)) continue;
    const newReply = observation.posts.find((post) => post.discussionRef === watch.discussionRef &&
      post.parentRef === watch.replyRef && !watch.baselinePostRefs.includes(post.ref) &&
      post.role !== "agent" && post.actorAlias !== "AGENT");
    if (newReply && (newReply.role === "learner" || newReply.role === "teacher")) {
      watch.state = "received";
      watch.lastObservedAt = observation.observedAt;
      watch.thirdPartyResponseAt = newReply.createdAt;
      const proposal = run.proposals.find((item) => item.id === watch.proposalId);
      if (proposal?.decision === "DRAFT") { proposal.decision = "YIELD"; proposal.draft = ""; proposal.reason = "已观察到第三人对本次回复形成实质接续，交还共同体继续推进。"; proposal.revision += 1; proposal.updatedAt = observedAt.toISOString(); }
      appendTape(run, "reply_watch", { watchId: watch.id, discussionRef: watch.discussionRef, result: "third_party_substantive_reply", decision: "YIELD", observedPosts: observation.posts.length }, observedAt);
      event(run, "proposals", "已观察到第三人实质接球，本次促进自动让位。 ");
      continue;
    }
    watch.lastObservedAt = observation.observedAt;
    if (watch.nextCheckAt && observedAt.getTime() >= Date.parse(watch.nextCheckAt)) {
      watch.state = "needs_rethread";
      const proposal = run.proposals.find((item) => item.id === watch.proposalId);
      if (proposal?.decision === "DRAFT") { proposal.decision = "WAIT"; proposal.draft = ""; proposal.reason = "回执后的回应窗口已结束，未观察到第三人接球，转入待穿线。"; proposal.revision += 1; proposal.updatedAt = observedAt.toISOString(); }
      appendTape(run, "reply_watch", { watchId: watch.id, discussionRef: watch.discussionRef, result: "no_third_party_response", decision: "WAIT", observedPosts: observation.posts.length }, observedAt);
      event(run, "proposals", "回应窗口已结束，未观察到第三人接球，已转入待穿线。 ");
    } else {
      watch.state = "waiting";
      appendTape(run, "reply_watch", { watchId: watch.id, discussionRef: watch.discussionRef, result: "window_open", decision: "DRAFT", observedPosts: observation.posts.length }, observedAt);
    }
  }
}

function deriveConnectionHealth(courses: BrowserCourse[], runs: BrowserCourseRun[]): BrowserConnectionHealth[] {
  return courses.map((course) => {
    const scoped = runs.filter((run) => run.courseId === course.id).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const latest = scoped[0];
    if (!latest) return { courseId: course.id, tapeRef: null, status: "idle", queueState: null, authState: "unknown", posts: 0, touched: 0, peerResponses: 0, reciprocity: "not_started", decisions: { DRAFT: 0, WAIT: 0, YIELD: 0, ABSTAIN: 0 }, pendingWatches: 0, lastPatrolAt: null, lastTouchAt: null, lastPeerResponseAt: null };
    const watches = latest.replyWatches ?? [];
    const peerResponses = watches.filter((watch) => watch.state === "received");
    const touched = watches.filter((watch) => watch.touchStatus === "confirmed_published").length;
    const pendingWatches = watches.filter((watch) => ["pending", "waiting"].includes(watch.state)).length;
    const status = latest.authState === "relogin_required" ? "relogin_required" : latest.status === "needs_attention" ? "attention" : pendingWatches ? "waiting" : latest.status === "completed" ? "healthy" : "attention";
    const reciprocity = peerResponses.length ? "received" : watches.some((watch) => watch.state === "outcome_unknown") ? "outcome_unknown" : pendingWatches ? "waiting" : touched ? "no_response" : "not_started";
    return { courseId: course.id, tapeRef: latest.tapeRef ?? null, status, queueState: latest.dispatch?.state ?? null, authState: latest.authState ?? "unknown", posts: latest.observation?.posts.length ?? 0, touched, peerResponses: peerResponses.length, reciprocity, decisions: decisionCounts(latest), pendingWatches, lastPatrolAt: latest.tape?.filter((entry) => entry.kind === "patrol_begin").at(-1)?.at ?? null, lastTouchAt: latest.tape?.filter((entry) => entry.kind === "reply_receipt" && entry.payload.status === "confirmed_published").at(-1)?.at ?? null, lastPeerResponseAt: peerResponses.map((watch) => watch.thirdPartyResponseAt).filter((value): value is string => !!value).sort().at(-1) ?? null };
  });
}
function requireLease(run: StoredRun, owner: string, token: string) {
  if (run.status !== "running" || !run.lease || run.lease.owner !== owner || run.lease.token !== token || run.lease.expiresAt < Date.now()) fail("LEASE_STALE", "这次执行已停止或过期，请重新接手任务。", 409);
  run.lease.expiresAt = Date.now() + LEASE_MS;
}
function graphFor(observation: BrowserObservation | null): BrowserGraph {
  if (!observation) return { actors: [], edges: [] };
  const projected = projectLiveInteractionGraph(observation.posts.map((p) => ({
    eventKey: p.ref, threadKey: p.discussionRef, actorKey: p.actorAlias, parentEventKey: p.parentRef,
    kind: p.parentRef ? "comment" : "thread_root", actorRelation: "unknown", depth: p.parentRef ? 1 : 0,
    occurredAt: p.createdAt, sourceVersionHash: "browser-observation", targetVersionHash: "browser-observation", legalityStatus: "admissible"
  })));
  return { actors: [...new Map(observation.posts.map((p) => [p.actorAlias, { id: p.actorAlias, role: p.role }])).values()],
    edges: projected.edges.filter((e) => e.sourceActorKey && e.targetActorKey).map((e) => ({ source: e.sourceActorKey!, target: e.targetActorKey!, weight: e.weight })) };
}
export async function getBrowserWorkspace(): Promise<BrowserWorkspaceSnapshot> {
  const state = await loadState();
  const now = Date.now();
  const runs = state.runs.map((r) => {
    const value = publicRun(r);
    if (value.status === "running" && (!r.lease || r.lease.expiresAt < now)) { value.status = "interrupted"; value.summary = "执行连接已过期，可以从已有观察继续。"; }
    return value;
  });
  return { schemaVersion: "course-browser-workspace.v1", revision: state.revision, courses: state.courses, runs,
    graphs: Object.fromEntries(runs.map((r) => [r.id, graphFor(r.observation)])),
    connectionHealth: deriveConnectionHealth(state.courses, runs),
    execution: { nativeBrowserInherited: false, localBrowserMcp: true, realPublishEnabled: false } };
}
export async function addBrowserCourse(input: unknown) {
  const parsed = createBrowserCourseSchema.parse(input);
  return transaction((state) => {
    const existing = state.courses.find((c) => c.entryUrl === parsed.entryUrl);
    if (existing) return structuredClone(existing);
    if (state.courses.length >= 100) fail("COURSE_LIMIT", "当前本机最多管理 100 门课程。");
    const course: BrowserCourse = { ...parsed, id: randomUUID(), createdAt: new Date().toISOString(), source: isLocalCourseFixture(parsed.entryUrl) ? "local_fixture" : "connected" };
    state.courses.push(course); return structuredClone(course);
  });
}
export async function createBrowserCourseRun(input: { id?: string; courseId: string; requestId: string; goal?: string; executor: "codex_host" | "codex_app_server"; mode: "observe" | "stage"; dispatchOrigin?: string }) {
  z.string().uuid().parse(input.requestId);
  return transaction((state) => {
    const existing = state.runs.find((r) => r.requestId === input.requestId);
    if (existing) {
      if (existing.courseId !== input.courseId || existing.executor !== input.executor || existing.mode !== input.mode) fail("REQUEST_CONFLICT", "请求编号与原任务不一致。", 409);
      return publicRun(existing);
    }
    const course = getCourse(state, input.courseId);
    if (input.dispatchOrigin && (input.executor !== "codex_app_server" || !isLocalCourseFixture(course.entryUrl) || new URL(course.entryUrl).origin !== input.dispatchOrigin)) fail("DISPATCH_SCOPE", "后台执行与课程入口不一致。", 409);
    if (input.executor === "codex_app_server" && !isLocalCourseFixture(course.entryUrl)) fail("HOST_REQUIRED", "此课程请交给 Codex 原生浏览器，在已登录的页面中执行。", 409);
    if (state.runs.some((r) => r.courseId === input.courseId && ["queued", "running"].includes(r.status) && (!r.lease || r.lease.expiresAt > Date.now()))) fail("RUN_ACTIVE", "这门课程已有任务，请先继续或停止它。", 409);
    const id = input.id ? z.string().uuid().parse(input.id) : randomUUID(); const at = new Date().toISOString();
    const run: StoredRun = { id, courseId: course.id, requestId: input.requestId, goal: z.string().trim().min(1).max(800).parse(input.goal || course.goal), executor: input.executor, mode: input.mode, phase: "patrol", tapeRef: `tape:${randomUUID()}`, tape: [], replyWatches: [], authState: "unknown", ...(input.executor === "codex_app_server" ? { executionRunId: id } : {}),
      status: "queued", attempt: 0, createdAt: at, updatedAt: at, observation: null, proposals: [], stages: [], events: [], summary: "等待 Codex 接手。", cursor: null, revision: 0, lease: null,
      messages: [], ...(course.facilitationPolicy ? { policy: structuredClone(course.facilitationPolicy) } : {}) };
    if (input.dispatchOrigin) {
      delete run.executionRunId;
      run.dispatch = { version: 1, origin: input.dispatchOrigin, state: "queued", attempts: 0, nextAttemptAt: at, startedAt: null, lastFailureCode: null };
    } else if (input.executor === "codex_host") {
      run.dispatch = { version: 1, origin: "host", state: "host_queued", attempts: 0, nextAttemptAt: at, startedAt: null, lastFailureCode: null };
    }
    event(run, "queued", "课程任务已建立，等待浏览器执行。");
    appendTape(run, "patrol_queued", { executor: input.executor, mode: input.mode });
    state.runs.push(run);
    if (state.runs.length > 200) { const removable = state.runs.findIndex((r) => !["running", "queued"].includes(r.status)); if (removable >= 0) state.runs.splice(removable, 1); }
    return publicRun(run);
  });
}
export async function claimBrowserCourseRun(id: string, owner: string, executionRunId?: string) {
  return transaction((state) => {
    const run = getRun(state, id);
    if (run.authState === "relogin_required") fail("RELOGIN_REQUIRED", "课程登录已失效，请先重新登录后再接手任务。", 409);
    const watchExecution = run.dispatch?.state === "watch_executing" || (run.dispatch?.state === "host_queued" && run.phase === "reply_watch");
    const hostExecution = run.dispatch?.state === "host_queued";
    if (run.dispatch && !["executing", "watch_executing", "host_queued"].includes(run.dispatch.state)) fail("EXECUTION_STALE", "后台尚未分配本轮执行，或执行已被替换。", 409);
    if (run.executor === "codex_app_server" && executionRunId !== (run.executionRunId || run.id)) fail("EXECUTION_STALE", "该执行连接已被新的执行尝试替代。", 409);
    if (!["queued", "running"].includes(run.status) && !(watchExecution && run.status === "completed")) fail("RUN_NOT_QUEUED", "请先从工作台继续任务或创建新任务。", 409);
    if (run.lease && run.lease.expiresAt > Date.now() && run.lease.owner !== owner) fail("RUN_CLAIMED", "任务正由另一个执行连接处理。", 409);
    if (run.lease?.owner !== owner || run.lease.expiresAt < Date.now()) { run.attempt += 1; run.lease = { owner, token: randomBytes(24).toString("hex"), expiresAt: Date.now() + LEASE_MS }; }
    run.phase = watchExecution ? "reply_watch" : "patrol";
    run.status = "running";
    if (run.dispatch && hostExecution) { run.dispatch.state = "host_executing"; run.dispatch.attempts += 1; run.dispatch.startedAt = new Date().toISOString(); }
    appendTape(run, "patrol_begin", { executor: run.executor, mode: run.mode, phase: run.phase, attempt: run.attempt, resumed: run.attempt > 1 });
    event(run, "observing", run.phase === "reply_watch" ? "Codex 已接手，正在复扫回复后的接球。" : run.observation ? "Codex 已接手，继续核对课程观察。" : "Codex 已接手，正在观察课程页面。");
    for (const message of run.messages ?? []) message.delivery = "delivered";
    return { course: structuredClone(getCourse(state, run.courseId)), run: publicRun(run), leaseToken: run.lease!.token };
  });
}
function validateObservation(course: BrowserCourse, observation: BrowserObservation) {
  if (observation.courseUrl !== course.entryUrl || ![...observation.pages.map((p) => p.url), ...observation.discussions.map((d) => d.url), ...observation.posts.map((p) => p.url)].every((u) => sameCoursePage(course.entryUrl, u))) fail("COURSE_MISMATCH", "观察页面与已绑定课程不一致。");
  if (Date.parse(observation.observedAt) > Date.now() + 60_000 || observation.posts.some((p) => Date.parse(p.createdAt) > Date.parse(observation.observedAt))) fail("OBSERVATION_TIME", "观察时间或帖子时间无效。");
  const discussions = new Map(observation.discussions.map((d) => [d.ref, d])); const posts = new Map(observation.posts.map((p) => [p.ref, p]));
  if (discussions.size !== observation.discussions.length || posts.size !== observation.posts.length) fail("DUPLICATE_REF", "观察中存在重复标识。");
  for (const post of posts.values()) {
    if (!discussions.has(post.discussionRef)) fail("DISCUSSION_MISSING", "帖子没有对应讨论。");
    if (post.parentRef && (!posts.has(post.parentRef) || posts.get(post.parentRef)!.discussionRef !== post.discussionRef)) fail("PARENT_MISSING", "回复的父帖尚未读取或不属于同一讨论。");
    const visited = new Set<string>([post.ref]); let current = post;
    while (current.parentRef) { if (visited.has(current.parentRef)) fail("PARENT_CYCLE", "回复关系存在循环。"); visited.add(current.parentRef); current = posts.get(current.parentRef)!; }
  }
  for (const discussion of discussions.values()) if (observation.posts.filter((p) => p.discussionRef === discussion.ref && !p.parentRef).length !== 1) fail("ROOT_MISSING", "每个已读取讨论需要且只能包含一个主题帖。");
  if (observation.complete && (observation.scope !== "course" || !observation.pages.some((p) => p.terminal) || observation.discussions.some((d) => !d.complete) || (observation.expectedDiscussions !== null && observation.expectedDiscussions !== discussions.size))) fail("COVERAGE_INCOMPLETE", "分页或讨论数量尚未支持完整巡检。");
}
export async function recordBrowserObservation(id: string, owner: string, token: string, input: unknown, operationKey?: string) {
  const observation = browserObservationSchema.parse(input);
  const operation = operationDescriptor("observation", observation, operationKey);
  return transaction((state) => {
    const run = getRun(state, id); requireLease(run, owner, token);
    if (replayOperation(run, operation)) return publicRun(run);
    validateObservation(getCourse(state, run.courseId), observation);
    if (run.observation && Date.parse(observation.observedAt) < Date.parse(run.observation.observedAt)) fail("OBSERVATION_STALE", "不能用较早观察覆盖新的结果。", 409);
    run.observation = observation; run.proposals = run.phase === "reply_watch" ? run.proposals : []; run.stages = run.phase === "reply_watch" ? run.stages : []; run.cursor = observation.pages.at(-1)!.url;
    appendTape(run, "observation", { scope: observation.scope, complete: observation.complete, discussions: observation.discussions.length, posts: observation.posts.length }, new Date(observation.observedAt));
    if (run.phase === "reply_watch") evaluateReplyWatches(run, observation, new Date(observation.observedAt));
    run.authState = "authenticated";
    rememberOperation(run, operation); event(run, "observation", `已记录 ${observation.discussions.length} 个讨论、${observation.posts.length} 条帖子；${observation.complete ? "本次课程观察完整" : "保留观察范围"}。`);
    return publicRun(run);
  });
}
export async function recordBrowserProposals(id: string, owner: string, token: string, input: unknown, operationKey?: string) {
  const inputs = z.array(browserProposalSchema).max(MAX_BROWSER_DISCUSSIONS).parse(input);
  return transaction((state) => {
    const run = getRun(state, id); requireLease(run, owner, token);
    // A proposal retry is idempotent for the exact observation it judged. When
    // the caller omits an operation key, bind the derived key to that
    // observation so a later observation can legitimately produce a new
    // decision from the same candidate payload.
    const operation = operationDescriptor("proposals", operationKey === undefined ? { observation: run.observation, proposals: inputs } : inputs, operationKey);
    if (replayOperation(run, operation)) return publicRun(run);
    const course = getCourse(state, run.courseId); const observation = run.observation;
    if (!observation) fail("OBSERVE_FIRST", "请先记录浏览器观察。");
    const seen = new Set<string>(); let drafts = 0;
    run.proposals = inputs.map((proposal) => {
      if (seen.has(proposal.discussionRef)) fail("PROPOSAL_DUPLICATE", "同一讨论只能保留一个决定。"); seen.add(proposal.discussionRef);
      const discussion = observation.discussions.find((d) => d.ref === proposal.discussionRef);
      if (!discussion) fail("TARGET_MISSING", "建议目标不在已读取讨论中。");
      let { decision, reason, draft } = proposal;
      const posts = observation.posts.filter((p) => p.discussionRef === discussion.ref); const root = posts.find((p) => !p.parentRef)!;
      const peerResponded = posts.some((p) => p.parentRef && p.actorAlias !== root.actorAlias && p.role === "learner");
      if (decision === "DRAFT" && peerResponded) { decision = "YIELD"; draft = ""; reason = "已经观察到同伴回应，继续跟踪讨论，把回应机会交还共同体。"; }
      if (decision === "DRAFT" && (!discussion.complete || course.budget === 0 || drafts >= course.budget)) { decision = !discussion.complete && run.policy ? "ABSTAIN" : "WAIT"; draft = ""; reason = !discussion.complete ? "目标讨论尚未完整展开，继续观察。" : "本轮促进预算已用完，保留观察。"; }
      if (run.policy && decision === "DRAFT") {
        const teacherResponded = posts.some((p) => p.parentRef && p.role === "teacher");
        const ageMinutes = (Date.parse(observation.observedAt) - Date.parse(root.createdAt)) / 60_000;
        const refs = new Set([...observation.posts.map((p) => p.ref), ...observation.discussions.map((d) => d.ref)]);
        const signature = (value: BrowserObservation, ref: string) => JSON.stringify(value.posts.filter((p) => p.discussionRef === ref)
          .map((p) => [p.ref, p.parentRef, p.actorAlias, p.role, p.createdAt]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
        const previous = state.runs.filter((r) => r.id !== run.id && r.courseId === run.courseId &&
          Date.parse(r.createdAt) <= Date.parse(observation.observedAt) &&
          Date.parse(r.updatedAt) <= Date.parse(observation.observedAt) &&
          Date.parse(r.updatedAt) >= Date.parse(observation.observedAt) - run.policy!.repeatCooldownHours * 3600_000)
          .some((r) => {
            const oldDiscussion = r.observation?.discussions.find((d) => d.url === discussion.url);
            return oldDiscussion && r.observation && JSON.stringify(r.policy) === JSON.stringify(run.policy) && signature(r.observation, oldDiscussion.ref) === signature(observation, discussion.ref) &&
              r.proposals.some((p) => p.discussionRef === oldDiscussion.ref && p.decision === "DRAFT");
          });
        if (teacherResponded || posts.some((p) => p.parentRef && p.actorAlias === root.actorAlias) || proposal.intent?.responsibility === "teacher" || proposal.intent?.function === "teacher_handoff") {
          decision = "YIELD"; reason = "此处由教师承担接续责任，学伴保留观察。";
          if (!teacherResponded && proposal.intent?.responsibility !== "teacher" && proposal.intent?.function !== "teacher_handoff") reason = "原作者已经回返推进讨论，继续观察其接续。";
        } else if (root.role !== "learner") {
          decision = "ABSTAIN"; reason = "当前主题的学习者角色依据不足，暂不自动生成促进回复。";
        } else if (ageMinutes < run.policy.minimumWaitMinutes) {
          decision = "WAIT"; reason = "仍在课程设定的同伴回应窗口内，继续等待。";
        } else if (previous) {
          decision = "WAIT"; reason = "近期已有同一讨论的草稿，保留已有建议并继续观察，避免重复生成。";
        } else if (!proposal.intent || !run.policy.allowedFunctions.includes(proposal.intent.function) || proposal.intent.evidenceRefs.some((ref) => !refs.has(ref)) ||
          !proposal.intent.evidenceRefs.some((ref) => ref === discussion.ref || posts.some((post) => post.ref === ref))) {
          decision = "ABSTAIN"; reason = "促进功能、目标证据或接续条件尚不充分，暂不形成回复。";
        }
    if (decision !== "DRAFT") draft = "";
      }
      if (decision === "DRAFT") { if (!draft) fail("DRAFT_EMPTY", "促进建议需要具体草稿。"); drafts += 1; }
      else draft = "";
      return { ...proposal, decision, reason, draft, id: randomUUID(), revision: 1, updatedAt: new Date().toISOString() };
    });
    run.stages = [];
    const counts = decisionCounts(run);
    appendTape(run, "decision", { DRAFT: counts.DRAFT, WAIT: counts.WAIT, YIELD: counts.YIELD, ABSTAIN: counts.ABSTAIN });
    rememberOperation(run, operation); event(run, "proposals", `已形成 ${drafts} 条草稿，保留 ${run.proposals.length - drafts} 项等待或让位决定。`); return publicRun(run);
  });
}
export async function editBrowserDraft(id: string, proposalId: string, revision: number, draft: string) {
  z.string().trim().min(1).max(1600).parse(draft);
  return transaction((state) => { const run = getRun(state, id);
    if (run.status === "running") fail("RUN_ACTIVE", "请先停止执行，再修改草稿。", 409);
    const p = run.proposals.find((v) => v.id === proposalId); if (!p || p.decision !== "DRAFT") fail("PROPOSAL_MISSING", "草稿不存在。", 404);
    if (p.revision !== revision) fail("DRAFT_STALE", "草稿已有新版本，请刷新后修改。", 409);
    p.draft = draft.trim(); p.revision += 1; p.updatedAt = new Date().toISOString(); run.stages = run.stages.filter((s) => s.proposalId !== proposalId);
    event(run, "proposals", "草稿已保存为新版本。"); return publicRun(run); });
}

/** Records an already completed reply and schedules a same-tape follow-up scan. */
export async function recordBrowserReplyReceipt(id: string, owner: string, token: string, input: unknown, operationKey?: string, trust: "trusted_connector" | undefined = undefined) {
  const receipt = browserReplyReceiptSchema.parse(input);
  const operation = operationDescriptor("reply_receipt", receipt, operationKey);
  return transaction((state) => {
    const run = getRun(state, id); requireLease(run, owner, token);
    if (replayOperation(run, operation)) return publicRun(run);
    const proposal = run.proposals.find((item) => item.id === receipt.proposalId);
    const discussion = run.observation?.discussions.find((item) => item.ref === receipt.discussionRef);
    if (!proposal || proposal.decision !== "DRAFT" || !discussion || discussion.url !== receipt.targetUrl) fail("REPLY_RECEIPT_TARGET_MISMATCH", "回执目标与当前促进草稿不一致。", 409);
    if (receipt.status === "confirmed_published") {
      if (trust !== "trusted_connector") fail("REPLY_RECEIPT_TRUST_REQUIRED", "已确认发布回执只能由受信连接器写入。", 423);
      if (!receipt.submitted || !receipt.externalReceiptHash) fail("REPLY_RECEIPT_UNVERIFIED", "已确认发布的回执缺少外部核验。", 409);
    }
    const now = new Date(receipt.observedAt);
    if (now.getTime() > Date.now() + 60_000 || (run.observation && now.getTime() < Date.parse(run.observation.observedAt))) fail("REPLY_RECEIPT_TIME", "回执时间不在当前课程观察之后。", 409);
    const watch: BrowserReplyWatch = {
      id: randomUUID(), tapeRef: run.tapeRef ?? `tape:${run.id}`, proposalId: receipt.proposalId, discussionRef: receipt.discussionRef, replyRef: receipt.replyRef,
      baselinePostRefs: [...latestObservationPostRefs(run, receipt.discussionRef)], state: receipt.status === "confirmed_published" ? "pending" : receipt.status === "outcome_unknown" ? "outcome_unknown" : "waiting",
      touchStatus: receipt.status, createdAt: receipt.observedAt, nextCheckAt: receipt.status === "confirmed_published" ? new Date(now.getTime() + REPLY_WATCH_WINDOW_MS).toISOString() : null,
      lastObservedAt: run.observation?.observedAt ?? null, thirdPartyResponseAt: null
    };
    run.replyWatches = (run.replyWatches ?? []).filter((item) => item.proposalId !== receipt.proposalId);
    if (receipt.status !== "staged_not_published") run.replyWatches.push(watch);
    appendTape(run, "reply_receipt", { proposalId: receipt.proposalId, discussionRef: receipt.discussionRef, status: receipt.status, submitted: receipt.submitted, externalReceiptHash: receipt.externalReceiptHash });
    if (receipt.status === "confirmed_published" && run.dispatch) {
      run.dispatch.state = "watch_queued";
      run.dispatch.nextAttemptAt = watch.nextCheckAt!;
      run.dispatch.startedAt = null;
    }
    rememberOperation(run, operation);
    event(run, "stage", receipt.status === "confirmed_published" ? "已记录外部回执，后续接球复扫沿用同一条 Tape。" : "已记录未发布或结果不明回执，保留后续核对状态。");
    return publicRun(run);
  });
}

/** Internal seam for a connector that has already verified the remote receipt. */
export async function recordVerifiedBrowserReplyReceipt(id: string, owner: string, token: string, input: unknown, operationKey?: string) {
  return recordBrowserReplyReceipt(id, owner, token, input, operationKey, "trusted_connector");
}

export async function reportBrowserReloginRequired(id: string, owner: string, token: string, message = "课程登录已失效，请重新登录后继续。") {
  return transaction((state) => {
    const run = getRun(state, id); requireLease(run, owner, token);
    run.authState = "relogin_required";
    run.status = "needs_attention";
    run.lease = null;
    if (run.dispatch) { run.dispatch.state = "paused"; run.dispatch.lastFailureCode = "AUTH_RELOGIN_REQUIRED"; run.dispatch.startedAt = null; }
    for (const watch of run.replyWatches ?? []) if (["pending", "waiting"].includes(watch.state)) watch.state = "relogin_required";
    appendTape(run, "auth_attention", { status: "relogin_required", code: "AUTH_RELOGIN_REQUIRED" });
    run.summary = message;
    event(run, "interrupted", message);
    return publicRun(run);
  });
}
export async function appendBrowserGuidance(id: string, input: unknown) {
  const parsed = z.object({ requestId: z.string().uuid(), text: z.string().trim().min(1).max(4000), context: companionContextSchema.optional() }).strict().parse(input);
  return transaction((state) => {
    const run = getRun(state, id); const course = getCourse(state, run.courseId);
    if (run.status === "cancelled") fail("RUN_CANCELLED", "已取消的任务不能追加要求。", 409);
    const previous = (run.messages ?? []).find((m) => m.requestId === parsed.requestId);
    if (previous) {
      if (previous.text !== parsed.text || JSON.stringify(previous.context) !== JSON.stringify(parsed.context)) fail("REQUEST_CONFLICT", "请求编号与原补充要求不一致。", 409);
      return { run: publicRun(run), messageId: previous.id, replay: true };
    }
    if (parsed.context && !sameCoursePage(course.entryUrl, parsed.context.url)) fail("CONTEXT_COURSE_MISMATCH", "当前页面不属于这项任务绑定的课程，请切回原课程或新建任务。", 409);
    if ((run.messages?.length ?? 0) >= 100) fail("MESSAGE_LIMIT", "本任务已有 100 条补充，请新建后续任务。");
    const message = { ...parsed, id: randomUUID(), at: new Date().toISOString(), delivery: "saved" as const };
    (run.messages ??= []).push(message);
    event(run, "queued", "教师补充已保存，任务仍绑定原课程。");
    return { run: publicRun(run), messageId: message.id, replay: false };
  });
}
export async function markBrowserGuidanceDelivered(id: string, messageId: string) {
  return transaction((state) => { const run = getRun(state, id); const message = run.messages?.find((m) => m.id === messageId);
    if (message) message.delivery = "delivered"; return publicRun(run); });
}
export async function readBrowserGuidance(id: string, owner: string, token: string) {
  return transaction((state) => { const run = getRun(state, id); requireLease(run, owner, token);
    for (const message of run.messages ?? []) message.delivery = "delivered";
    return { goal: run.goal, policy: run.policy ?? null, messages: structuredClone(run.messages ?? []) }; });
}
export async function recordBrowserStage(id: string, owner: string, token: string, input: unknown, operationKey?: string) {
  const receipt = browserStageSchema.parse(input);
  const operation = operationDescriptor("stage", receipt, operationKey);
  return transaction((state) => { const run = getRun(state, id); requireLease(run, owner, token); if (replayOperation(run, operation)) return publicRun(run);
    if (run.mode !== "stage") fail("STAGE_NOT_REQUESTED", "当前任务只允许观察。");
    const p = run.proposals.find((v) => v.id === receipt.proposalId); const discussion = run.observation?.discussions.find((d) => d.ref === p?.discussionRef);
    if (!p || !discussion || p.decision !== "DRAFT" || discussion.url !== receipt.targetUrl || p.draft !== receipt.readback) fail("READBACK_MISMATCH", "编辑器回读与当前目标或草稿不一致。");
    if (!run.stages.some((s) => s.proposalId === p.id && s.proposalRevision === p.revision)) run.stages.push({ proposalId: p.id, proposalRevision: p.revision, targetUrl: discussion.url, at: new Date().toISOString(), source: "agent_readback", cleared: true, submitted: false });
    appendTape(run, "reply_receipt", { proposalId: p.id, discussionRef: p.discussionRef, status: "staged_not_published", submitted: false, externalReceiptHash: null });
    rememberOperation(run, operation); event(run, "stage", "Codex 已记录编辑器逐字回读与清空；未提交。"); return publicRun(run); });
}
export async function finishBrowserRun(id: string, owner: string, token: string, summary: string, operationKey?: string) {
  z.string().trim().min(1).max(800).parse(summary);
  const operation = operationDescriptor("finish", { summary: summary.trim() }, operationKey);
  return transaction((state) => { const run = getRun(state, id); requireLease(run, owner, token); if (replayOperation(run, operation)) return publicRun(run);
    if (!run.observation) fail("OBSERVATION_MISSING", "缺少课程观察，不能完成任务。");
    if (run.messages?.some((m) => m.delivery === "saved")) fail("GUIDANCE_PENDING", "有新的教师补充尚未读取，请先读取要求再完成任务。", 409);
    if (run.proposals.length !== run.observation.discussions.length) fail("DECISIONS_INCOMPLETE", "每个已读取讨论都需要记录一个决定。");
    if (run.mode === "stage" && run.proposals.some((p) => p.decision === "DRAFT" && !run.stages.some((s) => s.proposalId === p.id && s.proposalRevision === p.revision))) fail("STAGE_INCOMPLETE", "还没有完成当前草稿的编辑器回读与清空。");
    run.status = "completed"; run.summary = summary.trim(); run.lease = null;
    const pendingWatch = (run.replyWatches ?? []).some((watch) => ["pending", "waiting"].includes(watch.state));
    if (run.dispatch) {
      run.dispatch.state = pendingWatch ? "watch_queued" : "complete";
      if (pendingWatch) run.dispatch.nextAttemptAt = (run.replyWatches ?? []).filter((watch) => ["pending", "waiting"].includes(watch.state)).map((watch) => watch.nextCheckAt).filter((value): value is string => !!value).sort()[0] ?? new Date().toISOString();
    }
    const counts = decisionCounts(run);
    appendTape(run, "patrol_end", { phase: run.phase ?? "patrol", DRAFT: counts.DRAFT, WAIT: counts.WAIT, YIELD: counts.YIELD, ABSTAIN: counts.ABSTAIN, pendingWatches: pendingWatch });
    rememberOperation(run, operation); event(run, "completed", pendingWatch ? "本轮完成，已排入同一 Tape 的接球复扫。" : "本轮课程任务完成，成果已同步到工作台。"); return publicRun(run); });
}
export async function interruptBrowserRun(id: string, message = "任务已停止，已获得的观察和建议保留。", status: "interrupted" | "needs_attention" | "cancelled" = "interrupted") {
  return transaction((state) => { const run = getRun(state, id); if ((run.status === "completed" && !(run.replyWatches ?? []).some((watch) => ["pending", "waiting"].includes(watch.state))) || run.status === "cancelled") return publicRun(run);
    run.status = status; run.lease = null; if (run.dispatch) run.dispatch.state = status === "needs_attention" ? "attention" : "paused"; run.summary = message; event(run, "interrupted", message); return publicRun(run); });
}
export async function reportBrowserAttention(id: string, owner: string, token: string, message: string) {
  return transaction((state) => { const run = getRun(state, id); requireLease(run, owner, token);
    run.status = "needs_attention"; run.lease = null; if (run.dispatch) run.dispatch.state = "attention"; run.summary = message; event(run, "interrupted", message); return publicRun(run); });
}
export async function bindBrowserExecution(id: string, executionId: string) {
  z.string().uuid().parse(executionId);
  return transaction((state) => { const run = getRun(state, id);
    if (run.status !== "queued" || run.executor !== "codex_app_server") fail("RUN_NOT_QUEUED", "任务尚未准备执行。", 409);
    run.executionRunId = executionId; return publicRun(run); });
}
export async function resumeBrowserRun(id: string, dispatchOrigin?: string) {
  return transaction((state) => { const run = getRun(state, id);
    if (run.status === "cancelled" || run.status === "queued" || (run.status === "running" && run.lease && run.lease.expiresAt > Date.now())) fail("RUN_NOT_RESUMABLE", "当前任务不能重新接手。", 409);
    if (state.runs.some((other) => other.id !== id && other.courseId === run.courseId &&
      (other.status === "queued" || (other.status === "running" && other.lease && other.lease.expiresAt > Date.now()))))
      fail("RUN_ACTIVE", "这门课程已有任务，请先继续或停止它。", 409);
    const resumeReplyWatch = (run.replyWatches ?? []).some((watch) => watch.state === "relogin_required" && watch.touchStatus === "confirmed_published");
    if (resumeReplyWatch) {
      for (const watch of run.replyWatches ?? []) if (watch.state === "relogin_required") { watch.state = "pending"; watch.nextCheckAt = new Date().toISOString(); }
    }
    if (dispatchOrigin) {
      const course = getCourse(state, run.courseId);
      if (run.executor !== "codex_app_server" || !isLocalCourseFixture(course.entryUrl) || new URL(course.entryUrl).origin !== dispatchOrigin) fail("DISPATCH_SCOPE", "后台执行与课程入口不一致。", 409);
      run.dispatch = { version: 1, origin: dispatchOrigin, state: resumeReplyWatch ? "watch_queued" : "queued", attempts: 0, nextAttemptAt: new Date().toISOString(), startedAt: null, lastFailureCode: null };
      delete run.executionRunId;
    } else if (run.executor === "codex_host") {
      run.dispatch = { version: 1, origin: "host", state: "host_queued", attempts: 0, nextAttemptAt: new Date().toISOString(), startedAt: null, lastFailureCode: null };
    }
    run.status = "queued"; run.phase = resumeReplyWatch ? "reply_watch" : "patrol"; run.authState = "unknown"; run.lease = null; event(run, "queued", resumeReplyWatch ? "任务已准备继续接球复扫，已有观察和 Tape 保留。" : "任务已准备继续，已有观察和游标保留。"); return publicRun(run); });
}

export async function reserveBrowserExecution(id: string, executionId: string, origin: string, now = new Date()) {
  z.string().uuid().parse(executionId);
  return transaction((state) => {
    const run = getRun(state, id); const dispatch = run.dispatch; const course = getCourse(state, run.courseId);
    const watchQueued = dispatch?.state === "watch_queued" || run.phase === "reply_watch";
    if (!dispatch || (!watchQueued && run.status !== "queued") || (watchQueued && !["queued", "completed"].includes(run.status)) || !["queued", "retry_wait", "watch_queued"].includes(dispatch.state) ||
      dispatch.origin !== origin || new URL(course.entryUrl).origin !== origin || !isLocalCourseFixture(course.entryUrl) ||
      Date.parse(dispatch.nextAttemptAt) > now.getTime()) fail("DISPATCH_STALE", "该后台任务已被停止、领取或尚未到恢复时间。", 409);
    run.executionRunId = executionId; run.lease = null; run.phase = watchQueued ? "reply_watch" : "patrol";
    dispatch.state = watchQueued ? "watch_executing" : "executing"; dispatch.attempts += 1; dispatch.startedAt = now.toISOString();
    event(run, "queued", `后台已领取任务，第 ${dispatch.attempts} 次执行；已有观察保留。`);
    return publicRun(run);
  });
}

export async function recoverBrowserExecution(id: string, executionId: string, code: "EXECUTION_LOST" | "EXECUTION_FAILED" | "EXECUTION_INCOMPLETE" | "EXECUTION_EXPIRED" | "START_FAILED", now = new Date()) {
  return transaction((state) => {
    const run = getRun(state, id); const dispatch = run.dispatch;
    // Compare-and-set fences late errors from an old process, including errors after a teacher stop.
    const watchExecution = dispatch?.state === "watch_executing";
    if (!dispatch || (!watchExecution && dispatch.state !== "executing") || run.executionRunId !== executionId || (!watchExecution && !["queued", "running"].includes(run.status)) || (watchExecution && !["completed", "running"].includes(run.status))) return publicRun(run);
    dispatch.lastFailureCode = code; run.lease = null;
    if ((!watchExecution && run.mode === "stage") || dispatch.attempts >= 3) {
      dispatch.state = watchExecution ? "watch_attention" : "attention"; run.status = "needs_attention";
      event(run, "interrupted", watchExecution ? "接球复扫连接中断；已有回执保留，请检查后继续。" : run.mode === "stage" ? "编辑器任务的执行连接中断；已有成果保留，请核对编辑器后继续。" : "后台已达到本轮恢复次数上限，已有成果保留，需要检查。" );
    } else {
      dispatch.state = watchExecution ? "watch_queued" : "retry_wait"; dispatch.nextAttemptAt = new Date(now.getTime() + 30_000 * dispatch.attempts).toISOString();
      run.status = watchExecution ? "completed" : "queued"; delete run.executionRunId;
      event(run, "queued", "执行连接中断，后台将从已有观察自动继续。" );
    }
    return publicRun(run);
  });
}
export async function browserBridgeSecret(): Promise<string> {
  const file = path.join(await ensureRoot(), "bridge-key");
  const exists = await lstat(file).catch((e: NodeJS.ErrnoException) => e.code === "ENOENT" ? null : Promise.reject(e));
  if (!exists) try { await writeFile(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 64) fail("BRIDGE_INVALID", "执行连接不可用。", 503);
  return readFile(file, "utf8");
}
export async function verifyBrowserBridge(value: string | null) {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(await browserBridgeSecret()));
}
