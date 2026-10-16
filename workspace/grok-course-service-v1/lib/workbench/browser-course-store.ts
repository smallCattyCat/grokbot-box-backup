import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { browserProjectionSeal } from "./browser-projection-identity";
import { mkdir, readFile, writeFile, rename, lstat, open, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { companionContextSchema } from "./companion-context";
import { projectLiveInteractionGraph } from "@/lib/world/live-graph-projector";
import {
  browserObservationSchema, browserProposalSchema, browserReplyReceiptSchema, browserStageSchema, createBrowserCourseSchema,
  browserReplyUptakeSchema, browserParticipationChoiceSchema,
  isLocalCourseFixture, sameCoursePage, observedCoursePage, MAX_BROWSER_DISCUSSIONS,
  type BrowserConnectionHealth, type BrowserCourse, type BrowserCourseRun, type BrowserDecisionTapeEntry,
  type BrowserGraph, type BrowserObservation, type BrowserReplyWatch, type BrowserProposalInput,
  type BrowserTapePayload, type BrowserWorkspaceSnapshot
} from "./browser-course-contracts";
import { facilitationPolicySchema } from "./facilitation-policy";
import { deriveBrowserInteractionMetrics, evaluateBrowserTrajectory } from "./browser-course-insights";
import { evaluateBrowserCoverage } from "./browser-course-coverage";
import { classifyBrowserFailure, safeBrowserFailureCode } from "./browser-course-recovery";
import { effectiveParticipationChoice } from "./browser-course-participation";
import {
  buildCommunityTeacherJudgement,
  type CommunityTeacherJudgementInput,
  type CommunityTeacherJudgementV1
} from "@/lib/community-memory/teacher-judgement-bridge";
import {
  appendCommunityTeacherJudgementToDecisionTape,
  type CommunityTeacherJudgementTapeAppendResult,
  type CommunityTeacherJudgementTapeDb
} from "@/lib/autonomy/teacher-judgement-tape";
import {
  appendCommunityTeacherJudgementOutboxEvent,
  getLatestCommunityTeacherJudgementOutboxEvent,
  type CommunityTeacherJudgementOutboxState
} from "@/lib/autonomy/teacher-judgement-outbox";
import {
  assertBrowserAutonomyBindingCapability,
  issueBrowserAutonomyBindingFromPrisma,
  type BrowserAutonomyBindingCapability
} from "./browser-autonomy-binding";

type StoredRun = BrowserCourseRun & { lease: { owner: string; token: string; expiresAt: number } | null };
type State = { version: 1; revision: number; courses: BrowserCourse[]; runs: StoredRun[] };
type StoredOperation = { key: string; action: string; payloadHash: string; at: string };
type StoredRunWithOperations = StoredRun & { operations?: StoredOperation[] };
const BROWSER_TEACHER_JUDGEMENT_APPENDER_BRAND: unique symbol = Symbol(
  "browser-teacher-judgement-tape-appender"
);
const BROWSER_TEACHER_JUDGEMENT_PRISMA_BRAND: unique symbol = Symbol(
  "browser-teacher-judgement-prisma-capability"
);

/**
 * The browser companion and the autonomy runtime have separate stores.  This
 * callback is the only server-side seam that is allowed to promote a teacher
 * review between them.  A caller must bind it to the exact autonomy
 * invocation/Decision Tape records (normally by calling
 * appendCommunityTeacherJudgementToDecisionTape with a server-owned Prisma
 * client).  It is deliberately not serialisable and is never accepted from a
 * browser request.
 */
export type BrowserTeacherJudgementTapeAppender = ((input: {
  readonly invocationId: string;
  readonly judgement: CommunityTeacherJudgementV1;
}) => Promise<CommunityTeacherJudgementTapeAppendResult>) & {
  readonly [BROWSER_TEACHER_JUDGEMENT_APPENDER_BRAND]: true;
  /** Module-private database capability used only by the promotion outbox. */
  readonly [BROWSER_TEACHER_JUDGEMENT_PRISMA_BRAND]: CommunityTeacherJudgementTapeDb;
};

export type BrowserTeacherJudgementPromotionInput = Omit<
  CommunityTeacherJudgementInput,
  "anchor" | "decisionKey" | "browserRunRef" | "browserBindingHash"
> & {
  /** Module-private server-issued binding; never accepted from request JSON. */
  readonly binding: BrowserAutonomyBindingCapability;
};

export type BrowserTeacherJudgementPromotionResult = {
  readonly run: BrowserCourseRun;
  readonly judgementHash: string;
  readonly autonomyTape: {
    readonly replayed: boolean;
    readonly sequence: number;
    readonly entryHash: string;
    readonly payloadHash: string;
  };
  readonly browserTapeReplayed: boolean;
};
const EMPTY: State = { version: 1, revision: 0, courses: [], runs: [] };
const LEASE_MS = 20 * 60_000;
const REPLY_WATCH_WINDOW_MS = 24 * 60 * 60_000;
const TAPE_DOMAIN = "cmooc.browser-decision-tape.v1";
let testRoot: string | undefined;
export function setBrowserCourseRootForTests(value?: string) { testRoot = value; }
export function browserCoursePrivateRoot() {
  if (process.env.CMOOC_SERVICE_DATA_DIR) return testRoot ?? path.join(path.resolve(process.env.CMOOC_SERVICE_DATA_DIR), "browser-courses");
  const workspace = createHash("sha256").update(path.resolve(process.cwd()).toLowerCase()).digest("hex").slice(0, 20);
  const namespace = process.env.CMOOC_BROWSER_WORKSPACE_NAMESPACE;
  if (namespace && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(namespace)) throw new Error("BROWSER_WORKSPACE_NAMESPACE_INVALID");
  const root = path.join(process.env.LOCALAPPDATA || path.join(homedir(), ".local", "share"), "cmooc-workbench", "browser-courses", workspace);
  return testRoot ?? (namespace ? path.join(root, "isolated", namespace) : root);
}
export class BrowserCourseError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
function fail(code: string, message: string, status = 400): never { throw new BrowserCourseError(code, message, status); }
async function ensureRoot() {
  const root = browserCoursePrivateRoot(); await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) fail("STORE_INVALID", "课程存储目录不可用。", 503);
  if (process.platform !== "win32") await chmod(root, 0o700);
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
    run.uptakeObservations ??= [];
    run.participationChoices ??= [];
    for (const watch of run.replyWatches) {
      // The R9 retry clock may already have changed on relogin. Reconstruct
      // its fixed window from the receipt, never from the mutable next check.
      if (watch.windowEndsAt === undefined) {
        watch.windowEndsAt = watch.touchStatus === "confirmed_published"
          ? new Date(Date.parse(watch.createdAt) + REPLY_WATCH_WINDOW_MS).toISOString() : null;
        watch.windowBasis = "legacy_default";
      }
      watch.minimumRescanMinutes ??= 30;
      watch.maximumRescanMinutes ??= 240;
      watch.unchangedScans ??= 0;
      watch.observationStatus ??= "unknown";
      watch.lastSuccessfulObservationAt ??= null;
      watch.observationGapStartedAt ??= watch.state === "relogin_required" ? watch.lastObservedAt ?? watch.createdAt : null;
    }
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
  // The idempotency index lives as long as this durable run. Evicting a key
  // before its Tape/interpretations lets a delayed retry append a duplicate.
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

function discussionFingerprint(observation: BrowserObservation, discussionRef: string) {
  return createHash("sha256").update(stableJson(observation.posts.filter((post) => post.discussionRef === discussionRef)
    .map((post) => [post.ref, post.parentRef, post.actorAlias, post.role, post.createdAt]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest("hex");
}

function nextWatchCheck(watch: BrowserReplyWatch, at: Date, changed: boolean) {
  watch.unchangedScans = changed ? 0 : (watch.unchangedScans ?? 0) + 1;
  const minutes = Math.min(watch.maximumRescanMinutes ?? 240, (watch.minimumRescanMinutes ?? 30) * 2 ** Math.min(watch.unchangedScans, 8));
  const proposed = at.getTime() + minutes * 60_000;
  return new Date(watch.windowEndsAt ? Math.min(proposed, Date.parse(watch.windowEndsAt)) : proposed).toISOString();
}

function evaluateReplyWatches(run: StoredRun, observation: BrowserObservation, observedAt: Date) {
  const watches = run.replyWatches ?? [];
  for (const watch of watches) {
    if (["received", "needs_rethread", "outcome_unknown", "relogin_required"].includes(watch.state)) continue;
    const targetComplete = observation.discussions.some((discussion) => discussion.ref === watch.discussionRef && discussion.complete) &&
      !(run.coverageEvaluation?.affectedDiscussionRefs ?? []).includes(watch.discussionRef);
    const newReply = observation.posts.find((post) => post.createdAt !== null && post.discussionRef === watch.discussionRef &&
      post.parentRef === watch.replyRef && !watch.baselinePostRefs.includes(post.ref) &&
      post.role !== "agent" && post.actorAlias !== "AGENT");
    if (newReply && (newReply.role === "learner" || newReply.role === "teacher")) {
      watch.state = "received";
      watch.lastObservedAt = observation.observedAt;
      watch.thirdPartyResponseAt = newReply.createdAt;
      watch.receivedPostRef = newReply.ref;
      watch.nextCheckAt = null;
      watch.observationStatus = watch.observationGapStartedAt ? "censored" : targetComplete ? "complete" : "incomplete";
      if (targetComplete) watch.lastSuccessfulObservationAt = observation.observedAt;
      const proposal = run.proposals.find((item) => item.id === watch.proposalId);
      if (proposal?.decision === "DRAFT") { proposal.decision = "YIELD"; proposal.draft = ""; proposal.reason = "已观察到真人回复，先保留其接续回合；具体功能另行记录。"; proposal.revision += 1; proposal.updatedAt = observedAt.toISOString(); }
      appendTape(run, "reply_watch", { watchId: watch.id, discussionRef: watch.discussionRef, result: "human_reply_received", decision: "YIELD", receivedPostRef: newReply.ref, uptake: "unknown", observedPosts: observation.posts.length }, observedAt);
      event(run, "proposals", "已观察到真人回复，本次促进让位，继续区分后续接续功能。 ");
      continue;
    }
    watch.lastObservedAt = observation.observedAt;
    if (targetComplete) watch.lastSuccessfulObservationAt = observation.observedAt;
    else watch.observationGapStartedAt ??= observation.observedAt;
    watch.observationStatus = watch.observationGapStartedAt ? "censored" : targetComplete ? "complete" : "incomplete";
    if (watch.windowEndsAt && observedAt.getTime() >= Date.parse(watch.windowEndsAt)) {
      const censored = !targetComplete || !!watch.observationGapStartedAt;
      watch.state = censored ? "outcome_unknown" : "needs_rethread";
      watch.nextCheckAt = null;
      const proposal = run.proposals.find((item) => item.id === watch.proposalId);
      if (proposal?.decision === "DRAFT") { proposal.decision = "WAIT"; proposal.draft = ""; proposal.reason = censored ? "回应窗口已结束，但观察曾中断或目标未读全，结果保留未知。" : "回应窗口已结束，本次完整观察未见真人接球，保留待穿线。"; proposal.revision += 1; proposal.updatedAt = observedAt.toISOString(); }
      appendTape(run, "reply_watch", { watchId: watch.id, discussionRef: watch.discussionRef, result: censored ? "window_censored" : "no_human_reply_observed", decision: "WAIT", windowEndsAt: watch.windowEndsAt, observedPosts: observation.posts.length }, observedAt);
      event(run, "proposals", censored ? "回应窗口已结束，缺失观察使结果保持未知。" : "回应窗口已结束，本次未见真人接球，保留待穿线。 ");
    } else {
      watch.state = "waiting";
      const fingerprint = discussionFingerprint(observation, watch.discussionRef);
      watch.nextCheckAt = nextWatchCheck(watch, observedAt, fingerprint !== watch.lastObservationFingerprint);
      watch.lastObservationFingerprint = fingerprint;
      appendTape(run, "reply_watch", { watchId: watch.id, discussionRef: watch.discussionRef, result: "window_open", decision: "WAIT", nextCheckAt: watch.nextCheckAt, windowEndsAt: watch.windowEndsAt ?? null, observedPosts: observation.posts.length }, observedAt);
    }
  }
}

function deriveConnectionHealth(courses: BrowserCourse[], runs: BrowserCourseRun[]): BrowserConnectionHealth[] {
  return courses.map((course) => {
    const scoped = runs.filter((run) => run.courseId === course.id).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const latest = scoped[0];
    if (!latest) return { courseId: course.id, tapeRef: null, status: "idle", queueState: null, authState: "unknown", posts: 0, touched: 0, peerResponses: 0, reciprocity: "not_started", decisions: { DRAFT: 0, WAIT: 0, YIELD: 0, ABSTAIN: 0 }, pendingWatches: 0, lastPatrolAt: null, lastTouchAt: null, lastPeerResponseAt: null, interaction: deriveBrowserInteractionMetrics(null) };
    const watches = latest.replyWatches ?? [];
    const peerResponses = watches.filter((watch) => watch.state === "received");
    const touched = watches.filter((watch) => watch.touchStatus === "confirmed_published").length;
    const pendingWatches = watches.filter((watch) => ["pending", "waiting"].includes(watch.state)).length;
    const status = latest.authState === "relogin_required" ? "relogin_required" : latest.status === "needs_attention" || latest.receipt?.tapeValid === false ? "attention" : pendingWatches ? "waiting" : latest.status === "completed" ? "healthy" : "attention";
    const reciprocity = peerResponses.length ? "received" : watches.some((watch) => watch.state === "outcome_unknown") ? "outcome_unknown" : pendingWatches ? "waiting" : touched ? "no_response" : "not_started";
    const uptakeCounts: NonNullable<BrowserConnectionHealth["uptakeCounts"]> = {};
    const latestUptake = new Map<string, NonNullable<BrowserCourseRun["uptakeObservations"]>[number]>();
    for (const item of latest.uptakeObservations ?? []) {
      const key = `${item.watchId}:${item.postRef}`;
      if (item.source === "teacher_review" || latestUptake.get(key)?.source !== "teacher_review") latestUptake.set(key, item);
    }
    for (const item of latestUptake.values()) uptakeCounts[item.kind] = (uptakeCounts[item.kind] ?? 0) + 1;
    return { courseId: course.id, tapeRef: latest.tapeRef ?? null, status, queueState: latest.dispatch?.state ?? null, authState: latest.authState ?? "unknown", posts: latest.observation?.posts.length ?? 0, touched, peerResponses: peerResponses.length, reciprocity, decisions: decisionCounts(latest), pendingWatches, lastPatrolAt: latest.tape?.filter((entry) => entry.kind === "patrol_begin").at(-1)?.at ?? null, lastTouchAt: latest.tape?.filter((entry) => entry.kind === "reply_receipt" && entry.payload.status === "confirmed_published").at(-1)?.at ?? null, lastPeerResponseAt: peerResponses.map((watch) => watch.thirdPartyResponseAt).filter((value): value is string => !!value).sort().at(-1) ?? null,
      interaction: deriveBrowserInteractionMetrics(latest.observation), trajectory: evaluateBrowserTrajectory(latest), coverage: latest.coverageEvaluation, uptakeCounts };
  });
}
function requireLease(run: StoredRun, owner: string, token: string) {
  if (run.status !== "running" || !run.lease || run.lease.owner !== owner || run.lease.token !== token || run.lease.expiresAt < Date.now()) fail("LEASE_STALE", "这次执行已停止或过期，请重新接手任务。", 409);
  run.lease.expiresAt = Date.now() + LEASE_MS;
}
function graphFor(observation: BrowserObservation | null): BrowserGraph {
  if (!observation) return { actors: [], edges: [] };
  const projected = projectLiveInteractionGraph(observation.posts.filter((p): p is typeof p & { createdAt: string } => p.createdAt !== null).map((p) => ({
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
    const verified = verifyBrowserDecisionTape(value);
    const hash = (input: unknown) => input === null || input === undefined ? null : createHash("sha256").update(stableJson(input)).digest("hex");
    const trustedReplies = (value.replyWatches ?? []).filter((watch) => watch.touchStatus === "confirmed_published").length;
    value.receipt = {
      schemaVersion: "browser-course-run-receipt.v1", runId: value.id, tapeRef: value.tapeRef ?? null,
      tapeHeadHash: verified.headHash, tapeValid: verified.valid, tapeEntries: verified.entryCount,
      observationHash: hash(value.observation), proposalInputHash: hash(value.proposalInputs), policyHash: hash(value.policy),
      observedAt: value.observation?.observedAt ?? null, coverage: !value.observation ? "unknown" : value.observation.complete ? "complete" : "partial",
      terminalDisposition: value.status,
      evidenceLevel: !value.observation ? "not_observed" : state.courses.find((course) => course.id === value.courseId)?.source === "local_fixture" ? "local_synthetic" : trustedReplies ? "trusted_reply_receipt" : value.stages.length ? "editor_readback" : "browser_reported_observation",
      editorReadbacks: value.stages.length, trustedRepliesReported: trustedReplies,
      interpretationRecords: value.uptakeObservations?.length ?? 0, runtimePublicationEnabled: false
    };
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
export async function createBrowserCourseRun(input: { id?: string; courseId: string; requestId: string; goal?: string; executor: "codex_host" | "codex_app_server" | "external_host"; mode: "observe" | "stage"; dispatchOrigin?: string }) {
  z.string().uuid().parse(input.requestId);
  return transaction((state) => {
    const existing = state.runs.find((r) => r.requestId === input.requestId);
    if (existing) {
      if (existing.courseId !== input.courseId || existing.executor !== input.executor || existing.mode !== input.mode || (input.goal !== undefined && input.goal.trim() !== existing.goal)) fail("REQUEST_CONFLICT", "请求编号与原任务不一致。", 409);
      return publicRun(existing);
    }
    const course = getCourse(state, input.courseId);
    if (input.dispatchOrigin && (input.executor !== "codex_app_server" || !isLocalCourseFixture(course.entryUrl) || new URL(course.entryUrl).origin !== input.dispatchOrigin)) fail("DISPATCH_SCOPE", "后台执行与课程入口不一致。", 409);
    if (input.executor === "codex_app_server" && !isLocalCourseFixture(course.entryUrl)) fail("HOST_REQUIRED", "此课程请交给 Codex 原生浏览器，在已登录的页面中执行。", 409);
    if (state.runs.some((r) => r.courseId === input.courseId && ["queued", "running"].includes(r.status) && (!r.lease || r.lease.expiresAt > Date.now()))) fail("RUN_ACTIVE", "这门课程已有任务，请先继续或停止它。", 409);
    const id = input.id ? z.string().uuid().parse(input.id) : randomUUID(); const at = new Date().toISOString();
    const run: StoredRun = { id, courseId: course.id, requestId: input.requestId, goal: z.string().trim().min(1).max(800).parse(input.goal || course.goal), executor: input.executor, mode: input.mode, phase: "patrol", tapeRef: `tape:${randomUUID()}`, tape: [], replyWatches: [], authState: "unknown", ...(input.executor === "codex_app_server" ? { executionRunId: id } : {}),
      status: "queued", attempt: 0, createdAt: at, updatedAt: at, observation: null, proposals: [], stages: [], events: [], summary: input.executor === "external_host" ? "等待课程代理接手。" : "等待 Codex 接手。", cursor: null, revision: 0, lease: null,
      messages: [], uptakeObservations: [], participationChoices: [], policyRevision: course.policyRevision ?? 0,
      ...(course.facilitationPolicy ? { policy: structuredClone(course.facilitationPolicy) } : {}) };
    if (input.dispatchOrigin) {
      delete run.executionRunId;
      run.dispatch = { version: 1, origin: input.dispatchOrigin, state: "queued", attempts: 0, nextAttemptAt: at, startedAt: null, lastFailureCode: null };
    } else if (input.executor !== "codex_app_server") {
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
    if (watchExecution && hostExecution && run.dispatch && Date.parse(run.dispatch.nextAttemptAt) > Date.now()) fail("WATCH_NOT_DUE", "下次接球复扫尚未到期，请按课程复扫时间接手。", 409);
    if (run.dispatch && !["executing", "watch_executing", "host_queued"].includes(run.dispatch.state)) fail("EXECUTION_STALE", "后台尚未分配本轮执行，或执行已被替换。", 409);
    if (run.executor === "codex_app_server" && executionRunId !== (run.executionRunId || run.id)) fail("EXECUTION_STALE", "该执行连接已被新的执行尝试替代。", 409);
    if (!["queued", "running"].includes(run.status) && !(watchExecution && run.status === "completed")) fail("RUN_NOT_QUEUED", "请先从工作台继续任务或创建新任务。", 409);
    if (run.lease && run.lease.expiresAt > Date.now() && run.lease.owner !== owner) fail("RUN_CLAIMED", "任务正由另一个执行连接处理。", 409);
    if (run.lease?.owner !== owner || run.lease.expiresAt < Date.now()) { run.attempt += 1; run.lease = { owner, token: randomBytes(24).toString("hex"), expiresAt: Date.now() + LEASE_MS }; }
    run.phase = watchExecution ? "reply_watch" : "patrol";
    run.status = "running";
    if (run.dispatch && hostExecution) { run.dispatch.state = "host_executing"; run.dispatch.attempts += 1; run.dispatch.startedAt = new Date().toISOString(); }
    appendTape(run, "patrol_begin", { executor: run.executor, mode: run.mode, phase: run.phase, attempt: run.attempt, resumed: run.attempt > 1 });
    event(run, "observing", run.phase === "reply_watch" ? "课程代理已接手，正在复扫回复后的接球。" : run.observation ? "课程代理已接手，继续核对课程观察。" : "课程代理已接手，正在观察课程页面。");
    for (const message of run.messages ?? []) message.delivery = "delivered";
    return { course: structuredClone(getCourse(state, run.courseId)), run: publicRun(run), leaseToken: run.lease!.token };
  });
}
function validateObservation(course: BrowserCourse, observation: BrowserObservation) {
  if (observation.courseUrl !== course.entryUrl || ![...observation.pages.map((p) => p.url), ...observation.discussions.map((d) => d.url), ...observation.posts.map((p) => p.url)].every((u) => observedCoursePage(course.entryUrl, u, observation))) fail("COURSE_MISMATCH", "观察页面与已绑定课程不一致。");
  if (Date.parse(observation.observedAt) > Date.now() + 60_000 || observation.posts.some((p) => p.createdAt !== null && Date.parse(p.createdAt) > Date.parse(observation.observedAt))) fail("OBSERVATION_TIME", "观察时间或帖子时间无效。");
  const discussions = new Map(observation.discussions.map((d) => [d.ref, d])); const posts = new Map(observation.posts.map((p) => [p.ref, p]));
  if (discussions.size !== observation.discussions.length || posts.size !== observation.posts.length) fail("DUPLICATE_REF", "观察中存在重复标识。");
  for (const post of posts.values()) {
    if (!discussions.has(post.discussionRef)) fail("DISCUSSION_MISSING", "帖子没有对应讨论。");
    if (post.parentRef && ((!posts.has(post.parentRef) && discussions.get(post.discussionRef)!.complete) || (posts.has(post.parentRef) && posts.get(post.parentRef)!.discussionRef !== post.discussionRef))) fail("PARENT_MISSING", "完整讨论需包含父帖，回复不得跨讨论绑定。");
    const visited = new Set<string>([post.ref]); let current = post;
    while (current.parentRef) { if (visited.has(current.parentRef)) fail("PARENT_CYCLE", "回复关系存在循环。"); visited.add(current.parentRef); const parent = posts.get(current.parentRef); if (!parent) break; current = parent; }
  }
  for (const discussion of discussions.values()) {
    const roots = observation.posts.filter(p => p.discussionRef === discussion.ref && !p.parentRef);
    if (roots.length > 1 || (discussion.complete && roots.length !== 1)) fail("ROOT_MISSING", "完整讨论需要一个主题帖；局部观察可保留缺失。");
    if (discussion.complete && observation.posts.some(p => p.discussionRef === discussion.ref && p.createdAt === null)) fail("OBSERVATION_TIME_UNKNOWN", "创建时间未知的讨论必须保留为局部观察。");
    if (discussion.interpretation) {
      const interpretation = discussion.interpretation;
      const allowed = new Set([discussion.ref, ...observation.posts.filter(p => p.discussionRef === discussion.ref).map(p => p.ref)]);
      if (interpretation.evidenceRefs.some(ref => !allowed.has(ref)) || Date.parse(interpretation.interpretedAt) < Date.parse(observation.observedAt) || Date.parse(interpretation.interpretedAt) > Date.now() + 60_000) fail("INTERPRETATION_EVIDENCE_INVALID", "情境解释须引用同一讨论且保留真实解释时点。");
    }
  }
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
    if (run.projectionSeal && run.observation && observation.observedAt === run.observation.observedAt &&
        browserProjectionSeal(observation, []).observationHash !== run.projectionSeal.observationHash) {
      fail("PROJECTION_SNAPSHOT_IMMUTABLE", "该观察已经进入中层；请重新读取页面并记录新的观察时点。", 409);
    }
    if (run.observation && observation.observedAt !== run.observation.observedAt) delete run.projectionSeal;
    run.coverageEvaluation = evaluateBrowserCoverage(observation);
    if (["partial", "inconsistent"].includes(run.coverageEvaluation.status)) observation.complete = false;
    run.observation = observation; run.proposals = run.phase === "reply_watch" ? run.proposals : []; run.stages = run.phase === "reply_watch" ? run.stages : []; run.cursor = observation.pages.at(-1)!.url;
    if (run.phase !== "reply_watch") run.proposalInputs = [];
    appendTape(run, "observation", { scope: observation.scope, complete: observation.complete, coverageStatus: run.coverageEvaluation.status, coverageIssues: run.coverageEvaluation.issues.length, discussions: observation.discussions.length, posts: observation.posts.length }, new Date(observation.observedAt));
    if (run.phase === "reply_watch") evaluateReplyWatches(run, observation, new Date(observation.observedAt));
    run.authState = "authenticated";
    rememberOperation(run, operation); event(run, "observation", `已记录 ${observation.discussions.length} 个讨论、${observation.posts.length} 条帖子；${observation.complete ? "本次课程观察完整" : "保留观察范围"}。`);
    return publicRun(run);
  });
}
function orderProposalInputs(run: StoredRun, inputs: BrowserProposalInput[]) {
  const observation = run.observation;
  if (!observation || (!run.policy?.preferredFunction && run.policy?.allocation !== "author_coverage")) return inputs;
  const posts = new Map(observation.posts.map((post) => [post.ref, post]));
  const human = (role: string) => role === "learner" || role === "teacher";
  const coverage = new Map<string, number>();
  for (const post of posts.values()) {
    const parent = post.parentRef ? posts.get(post.parentRef) : undefined;
    if (parent && human(post.role) && human(parent.role) && post.actorAlias !== parent.actorAlias) {
      coverage.set(parent.actorAlias, (coverage.get(parent.actorAlias) ?? 0) + 1);
    }
  }
  // Alias comparisons are confined to this observation; aliases need not be
  // stable across separate course runs. No learner attributes are inferred.
  const occurrences = new Map<string, number>();
  return inputs.map((proposal, index) => {
    const root = observation.posts.find((post) => post.discussionRef === proposal.discussionRef && !post.parentRef);
    const author = root?.actorAlias ?? proposal.discussionRef;
    const repetition = occurrences.get(author) ?? 0;
    occurrences.set(author, repetition + 1);
    return { proposal, index, repetition, coverage: coverage.get(author) ?? 0,
      preferred: proposal.intent?.function === run.policy?.preferredFunction ? 0 : 1 };
  }).sort((a, b) => a.preferred - b.preferred || (run.policy?.allocation === "author_coverage" ? a.repetition - b.repetition || a.coverage - b.coverage : 0) || a.index - b.index)
    .map((item) => item.proposal);
}

function participationRestriction(run: StoredRun, discussionRef: string) {
  const observation = run.observation;
  if (!observation) return null;
  const root = observation.posts.find((post) => post.discussionRef === discussionRef && !post.parentRef);
  // References were validated when the choice was appended. A later partial
  // scan omitting that historical post cannot silently revoke the choice.
  const choice = root ? effectiveParticipationChoice(run.participationChoices ?? [], discussionRef, root.actorAlias, observation.observedAt) : undefined;
  if (!choice || choice.choice === "resume") return null;
  if (choice.choice === "wait_for_peers") return { decision: "WAIT" as const, reason: "原作者明确希望先等同伴，保留其回应机会。" };
  return { decision: "YIELD" as const, reason: choice.choice === "request_teacher" ? "原作者明确希望由教师接手，学伴保留观察。" : "原作者已明确拒绝或停止本次帮助，学伴让位。" };
}

function resolveBrowserProposalInputs(state: State, run: StoredRun, inputs: BrowserProposalInput[]) {
  const course = getCourse(state, run.courseId); const observation = run.observation;
  if (!observation) fail("OBSERVE_FIRST", "请先记录浏览器观察。");
    const seen = new Set<string>(); let drafts = 0;
    const proposals = orderProposalInputs(run, inputs).map((proposal) => {
      if (seen.has(proposal.discussionRef)) fail("PROPOSAL_DUPLICATE", "同一讨论只能保留一个决定。"); seen.add(proposal.discussionRef);
      const discussion = observation.discussions.find((d) => d.ref === proposal.discussionRef);
      if (!discussion) fail("TARGET_MISSING", "建议目标不在已读取讨论中。");
      let { decision, reason, draft } = proposal;
      const posts = observation.posts.filter((p) => p.discussionRef === discussion.ref); const root = posts.find((p) => !p.parentRef);
      const restriction = participationRestriction(run, discussion.ref);
      if (decision === "DRAFT" && (!root || root.createdAt === null || posts.some(p => p.createdAt === null))) {
        decision = "ABSTAIN"; reason = "主题帖或创建时间尚未核验，保留局部观察。"; draft = "";
      }
      if (decision === "DRAFT" && restriction) { decision = restriction.decision; reason = restriction.reason; draft = ""; }
      if (decision === "DRAFT" && (run.coverageEvaluation?.affectedDiscussionRefs ?? []).includes(discussion.ref)) {
        decision = "ABSTAIN"; reason = "目标依赖的分页证据不一致，先补足观察。"; draft = "";
      }
      const peerResponded = posts.some((p) => p.parentRef && p.actorAlias !== root?.actorAlias && p.role === "learner");
      if (decision === "DRAFT" && peerResponded) { decision = "YIELD"; draft = ""; reason = "已经观察到同伴回应，继续跟踪讨论，把回应机会交还共同体。"; }
      if (decision === "DRAFT" && (!discussion.complete || course.budget === 0 || drafts >= course.budget)) { decision = !discussion.complete && run.policy ? "ABSTAIN" : "WAIT"; draft = ""; reason = !discussion.complete ? "目标讨论尚未完整展开，继续观察。" : "本轮促进预算已用完，保留观察。"; }
      if (run.policy && decision === "DRAFT" && root && root.createdAt !== null) {
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
  return proposals;
}

export async function recordBrowserProposals(id: string, owner: string, token: string, input: unknown, operationKey?: string) {
  const inputs = z.array(browserProposalSchema).max(MAX_BROWSER_DISCUSSIONS).parse(input);
  return transaction((state) => {
    const run = getRun(state, id); requireLease(run, owner, token);
    if (run.phase === "reply_watch") fail("WATCH_READ_ONLY", "接球复扫只追加观察和解释，不重新生成促进草稿。", 409);
    // A proposal retry is idempotent for the exact observation it judged. When
    // the caller omits an operation key, bind the derived key to that
    // observation so a later observation can legitimately produce a new
    // decision from the same candidate payload.
    const operation = operationDescriptor("proposals", operationKey === undefined ? { observation: run.observation, proposals: inputs } : inputs, operationKey);
    if (replayOperation(run, operation)) return publicRun(run);
    const observation = run.observation;
    if (!observation) fail("OBSERVE_FIRST", "请先记录浏览器观察。");
    const resolved = resolveBrowserProposalInputs(state, run, inputs);
    if (run.projectionSeal && browserProjectionSeal(observation, resolved).decisionHash !== run.projectionSeal.decisionHash) {
      fail("PROJECTION_DECISION_IMMUTABLE", "当前观察的中层基线已保存；新的决定须先重新观察。草稿文字仍可编辑。", 409);
    }
    run.proposals = resolved;
    run.proposalInputs = structuredClone(inputs);
    const drafts = run.proposals.filter((proposal) => proposal.decision === "DRAFT").length;
    run.stages = [];
    const counts = decisionCounts(run);
    appendTape(run, "decision", { DRAFT: counts.DRAFT, WAIT: counts.WAIT, YIELD: counts.YIELD, ABSTAIN: counts.ABSTAIN });
    rememberOperation(run, operation); event(run, "proposals", `已形成 ${drafts} 条草稿，保留 ${run.proposals.length - drafts} 项等待或让位决定。`); return publicRun(run);
  });
}

/** Compare two policies on exactly the recorded input. No model calls or writes. */
export async function previewBrowserCoursePolicy(id: string, input: unknown) {
  const policy = facilitationPolicySchema.parse(input);
  const state = await loadState(); const run = getRun(state, id);
  if (!run.observation || !run.proposalInputs?.length) fail("PREVIEW_INPUT_MISSING", "先完成一轮带原始提议的巡检，再比较同一观察下的策略。", 409);
  const baselineRun = structuredClone(run); const proposedRun = structuredClone(run); proposedRun.policy = policy;
  const baseline = resolveBrowserProposalInputs(state, baselineRun, run.proposalInputs);
  const proposed = resolveBrowserProposalInputs(state, proposedRun, run.proposalInputs);
  const baselineMap = new Map(baseline.map((proposal) => [proposal.discussionRef, proposal]));
  return {
    observationHash: createHash("sha256").update(stableJson(run.observation)).digest("hex"),
    baselinePolicyHash: createHash("sha256").update(stableJson(run.policy ?? null)).digest("hex"),
    candidatePolicyHash: createHash("sha256").update(stableJson(policy)).digest("hex"),
    baselineDrafts: baseline.filter((proposal) => proposal.decision === "DRAFT").length,
    candidateDrafts: proposed.filter((proposal) => proposal.decision === "DRAFT").length,
    changes: proposed.flatMap((proposal) => {
      const before = baselineMap.get(proposal.discussionRef)!;
      return before.decision === proposal.decision && before.reason === proposal.reason ? [] :
        [{ discussionRef: proposal.discussionRef, before: before.decision, after: proposal.decision, reason: proposal.reason }];
    })
  };
}

/** Course settings govern subsequent runs. Existing run/Tape policies stay bound. */
export async function updateBrowserCoursePolicy(courseId: string, revision: number, input: unknown) {
  const policy = facilitationPolicySchema.parse(input); z.number().int().min(0).parse(revision);
  return transaction((state) => {
    const course = getCourse(state, courseId);
    if ((course.policyRevision ?? 0) !== revision) fail("POLICY_STALE", "课程设置已有新版本，请刷新后再保存。", 409);
    const history = course.policyHistory ??= [];
    if (history.length >= 100) fail("POLICY_HISTORY_LIMIT", "课程策略历史已达本机上限，请导出后建立后续课程配置。", 409);
    if (!history.length && course.facilitationPolicy) history.push({ revision, at: course.createdAt, policy: structuredClone(course.facilitationPolicy) });
    course.facilitationPolicy = policy; course.policyRevision = revision + 1;
    history.push({ revision: course.policyRevision, at: new Date().toISOString(), policy: structuredClone(policy) });
    return structuredClone(course);
  });
}

type ObservationRecorder = { source: "browser_observation"; owner: string; token: string } | { source: "teacher_review" };
function requireObservationRecorder(run: StoredRun, recorder: ObservationRecorder) {
  if (recorder.source === "browser_observation") requireLease(run, recorder.owner, recorder.token);
  else if (["running", "queued", "cancelled"].includes(run.status)) fail("RUN_ACTIVE", "先停止当前执行，再根据已保存的观察记录判断。", 409);
}
function validateInterpretationEvidence(run: StoredRun, discussionRef: string, refs: string[], observedAt: string) {
  const observation = run.observation;
  if (!observation) fail("OBSERVE_FIRST", "先保存课程观察，再记录接续判断。");
  if (Date.parse(observedAt) > Date.parse(observation.observedAt)) fail("EVIDENCE_FUTURE", "判断引用的时间不能晚于当前观察。", 409);
  const referenced = refs.map((ref) => observation.posts.find((post) => post.ref === ref));
  if (new Set(refs).size !== refs.length || referenced.some((post) => !post || post.createdAt === null || post.discussionRef !== discussionRef || Date.parse(post.createdAt) > Date.parse(observedAt))) {
    fail("EVIDENCE_INVALID", "依据必须来自该讨论在当前时点已观察到的帖子。", 409);
  }
  return observation;
}

async function appendReplyUptake(id: string, input: unknown, recorder: ObservationRecorder, operationKey?: string) {
  const parsed = browserReplyUptakeSchema.parse(input);
  const operation = operationDescriptor("reply_uptake", { ...parsed, source: recorder.source }, operationKey);
  return transaction((state) => {
    const run = getRun(state, id); requireObservationRecorder(run, recorder);
    if (replayOperation(run, operation)) return publicRun(run);
    const watch = run.replyWatches?.find((item) => item.id === parsed.watchId);
    if (!watch || watch.touchStatus !== "confirmed_published") fail("WATCH_MISSING", "该回合没有已核验的回复观察目标。", 409);
    const observation = validateInterpretationEvidence(run, watch.discussionRef, parsed.evidenceRefs, parsed.observedAt);
    const post = observation.posts.find((item) => item.ref === parsed.postRef);
    if (!post || !["learner", "teacher"].includes(post.role) || post.actorAlias === "AGENT" || !parsed.evidenceRefs.includes(post.ref) || watch.baselinePostRefs.includes(post.ref)) {
      fail("UPTAKE_TARGET_INVALID", "摄取判断必须引用本次回执后新观察到的真人回复。", 409);
    }
    const posts = new Map(observation.posts.map((item) => [item.ref, item]));
    let parent = post.parentRef; const visited = new Set<string>();
    while (parent && parent !== watch.replyRef && !visited.has(parent)) { visited.add(parent); parent = posts.get(parent)?.parentRef ?? null; }
    if (parent !== watch.replyRef) fail("UPTAKE_TARGET_INVALID", "该回复尚未与本次回合建立父链依据。", 409);
    if ((run.uptakeObservations?.length ?? 0) >= 500) fail("UPTAKE_LIMIT", "本回合判断记录已达上限，请导出后建立后续观察。");
    (run.uptakeObservations ??= []).push({ ...parsed, id: randomUUID(), recordedAt: new Date().toISOString(), source: recorder.source });
    appendTape(run, "reply_uptake", { watchId: watch.id, postRef: parsed.postRef, uptakeKind: parsed.kind, source: recorder.source,
      evidenceHash: createHash("sha256").update(stableJson(parsed.evidenceRefs)).digest("hex"), observedAt: parsed.observedAt });
    // Interpretation never revives a draft or changes the original human turn.
    rememberOperation(run, operation); event(run, "observation", "接续功能已追加记录，原让位决定保持。");
    return publicRun(run);
  });
}
export async function recordBrowserReplyUptake(id: string, owner: string, token: string, input: unknown, operationKey?: string) {
  return appendReplyUptake(id, input, { source: "browser_observation", owner, token }, operationKey);
}
export async function reviewBrowserReplyUptake(id: string, input: unknown, operationKey?: string) {
  return appendReplyUptake(id, input, { source: "teacher_review" }, operationKey);
}

async function appendParticipationChoice(id: string, input: unknown, recorder: ObservationRecorder, operationKey?: string) {
  const parsed = browserParticipationChoiceSchema.parse(input);
  const operation = operationDescriptor("participation_choice", { ...parsed, source: recorder.source }, operationKey);
  return transaction((state) => {
    const run = getRun(state, id); requireObservationRecorder(run, recorder);
    if (replayOperation(run, operation)) return publicRun(run);
    const observation = validateInterpretationEvidence(run, parsed.discussionRef, parsed.evidenceRefs, parsed.observedAt);
    const root = observation.posts.find((post) => post.discussionRef === parsed.discussionRef && !post.parentRef);
    if (root?.role !== "learner" || root.actorAlias !== parsed.actorAlias || !parsed.evidenceRefs.some((ref) => observation.posts.some((post) => post.ref === ref && post.actorAlias === parsed.actorAlias))) {
      fail("CHOICE_ACTOR_INVALID", "请引用原作者明确表达该选择的帖子；不能从沉默推断选择。", 409);
    }
    if (parsed.supersedesChoiceId) {
      const previous = run.participationChoices?.find((item) => item.id === parsed.supersedesChoiceId);
      if (recorder.source !== "teacher_review" || !previous || previous.discussionRef !== parsed.discussionRef || previous.actorAlias !== parsed.actorAlias || Date.parse(previous.observedAt) !== Date.parse(parsed.observedAt)) {
        fail("CHOICE_CORRECTION_INVALID", "只有教师可以明确修正同一时点、同一原作者的既有选择记录。", 409);
      }
    }
    if ((run.participationChoices?.length ?? 0) >= 200) fail("CHOICE_LIMIT", "本任务选择记录已达上限。");
    const choiceRecord = { ...parsed, id: randomUUID(), recordedAt: new Date().toISOString(), source: recorder.source };
    (run.participationChoices ??= []).push(choiceRecord);
    const restriction = participationRestriction(run, parsed.discussionRef);
    if (restriction) for (const proposal of run.proposals) {
      if (proposal.discussionRef !== parsed.discussionRef || proposal.decision !== "DRAFT") continue;
      proposal.decision = restriction.decision; proposal.reason = restriction.reason; proposal.draft = ""; proposal.revision += 1; proposal.updatedAt = new Date().toISOString();
      run.stages = run.stages.filter((stage) => stage.proposalId !== proposal.id);
    }
    appendTape(run, "participation_choice", { choiceId: choiceRecord.id, supersedesChoiceId: parsed.supersedesChoiceId ?? null, discussionRef: parsed.discussionRef, choice: parsed.choice, source: recorder.source,
      evidenceHash: createHash("sha256").update(stableJson(parsed.evidenceRefs)).digest("hex"), observedAt: parsed.observedAt, narrowsOnly: true });
    const effective = effectiveParticipationChoice(run.participationChoices, parsed.discussionRef, parsed.actorAlias, observation.observedAt);
    rememberOperation(run, operation); event(run, "proposals", effective?.id !== choiceRecord.id ? "已追加选择证据；较早或尚无先后依据的恢复不会撤销当前停止限制。" : parsed.choice === "resume" ? "已记录原作者恢复选择；后续决定仍须通过课程策略，尚未新增草稿。" : "已记录原作者明确选择，并调整本回合接续责任。");
    return publicRun(run);
  });
}
export async function recordBrowserParticipationChoice(id: string, owner: string, token: string, input: unknown, operationKey?: string) {
  return appendParticipationChoice(id, input, { source: "browser_observation", owner, token }, operationKey);
}
export async function reviewBrowserParticipationChoice(id: string, input: unknown, operationKey?: string) {
  return appendParticipationChoice(id, input, { source: "teacher_review" }, operationKey);
}

function assertBrowserTeacherJudgementServerOnly() {
  if (typeof globalThis !== "undefined" && "window" in globalThis) {
    fail("TEACHER_JUDGEMENT_SERVER_ONLY", "教师判断晋级只能在服务端运行。", 403);
  }
}

/**
 * Bind the explicit server-side Prisma boundary to the canonical autonomy
 * tape adapter.  The returned closure carries a database capability and
 * cannot be reconstructed from request JSON, which keeps approval and exact
 * anchor checks in the existing autonomy adapter.
 */
export function createBrowserTeacherJudgementTapeAppender(
  prisma: CommunityTeacherJudgementTapeDb
): BrowserTeacherJudgementTapeAppender {
  assertBrowserTeacherJudgementServerOnly();
  if (!prisma || typeof prisma !== "object") {
    fail("TEACHER_JUDGEMENT_TAPE_ADAPTER_INVALID", "教师判断 Tape 适配器不可用。", 503);
  }
  const appender = (async (input) => appendCommunityTeacherJudgementToDecisionTape({
    prisma,
    invocationId: input.invocationId,
    judgement: input.judgement
  })) as BrowserTeacherJudgementTapeAppender;
  Object.defineProperty(appender, BROWSER_TEACHER_JUDGEMENT_APPENDER_BRAND, {
    value: true,
    enumerable: false,
    configurable: false
  });
  Object.defineProperty(appender, BROWSER_TEACHER_JUDGEMENT_PRISMA_BRAND, {
    value: prisma,
    enumerable: false,
    configurable: false
  });
  return appender;
}

/**
 * Prepare the only supported browser-side lineage binding.  Browser state is
 * read here, while the autonomy records are reread by the Prisma loader; a
 * route must not assemble either half from request JSON.
 */
export async function createBrowserAutonomyBindingForRun(input: {
  readonly prisma: CommunityTeacherJudgementTapeDb;
  readonly browserRunId: string;
  readonly decisionKey: string;
  readonly graphSnapshotId: string;
  readonly candidateKey: string;
  readonly promotionId: string;
  /**
   * A durable outbox may have appended the local pending marker after the
   * original binding was issued.  In that one expected transition, re-use the
   * recorded pre-marker lineage only after proving the marker is the current
   * tape tail and its predecessor is the recorded head.
   */
  readonly expectedBrowserLineage?: {
    readonly tapeRef: string;
    readonly tapeHeadHash: string;
    readonly runRevision: number;
    readonly observationHash: string;
    readonly pendingJudgementHash?: string;
    readonly pendingBindingHash?: string;
  };
}): Promise<BrowserAutonomyBindingCapability> {
  assertBrowserTeacherJudgementServerOnly();
  const run = getRun(await loadState(), input.browserRunId);
  if (!run.observation) {
    fail("TEACHER_JUDGEMENT_BROWSER_OBSERVATION_REQUIRED", "教师判断晋级需要一份已核对的浏览器观察。", 409);
  }
  const tape = verifyBrowserDecisionTape(run);
  const observationHash = browserObservationHash(run);
  if (!run.tapeRef || !tape.headHash || !observationHash) {
    fail("TEACHER_JUDGEMENT_BROWSER_BINDING_UNAVAILABLE", "浏览器任务缺少可绑定的回执。", 409);
  }
  let browserLineage = {
    tapeRef: run.tapeRef,
    tapeHeadHash: tape.headHash,
    runRevision: run.revision,
    observationHash
  };
  const expected = input.expectedBrowserLineage;
  if (expected && (
    expected.tapeRef !== run.tapeRef ||
    expected.runRevision !== run.revision ||
    expected.observationHash !== observationHash
  )) {
    const pending = run.tape?.at(-1);
    if (
      !pending ||
      pending.kind !== "teacher_judgement_pending" ||
      pending.payload.operationKey !== input.promotionId ||
      (expected.pendingJudgementHash !== undefined && pending.payload.judgementHash !== expected.pendingJudgementHash) ||
      (expected.pendingBindingHash !== undefined && pending.payload.bindingHash !== expected.pendingBindingHash) ||
      pending.previousHash !== expected.tapeHeadHash ||
      expected.tapeRef !== run.tapeRef ||
      expected.observationHash !== observationHash ||
      expected.runRevision !== run.revision
    ) {
      fail("TEACHER_JUDGEMENT_BROWSER_BINDING_STALE", "浏览器任务已变化，请重新建立教师判断绑定。", 409);
    }
    browserLineage = { ...expected };
  } else if (expected && (
    expected.tapeHeadHash !== tape.headHash ||
    expected.tapeRef !== run.tapeRef
  )) {
    const pending = run.tape?.at(-1);
    if (
      !pending ||
      pending.kind !== "teacher_judgement_pending" ||
      pending.payload.operationKey !== input.promotionId ||
      (expected.pendingJudgementHash !== undefined && pending.payload.judgementHash !== expected.pendingJudgementHash) ||
      (expected.pendingBindingHash !== undefined && pending.payload.bindingHash !== expected.pendingBindingHash) ||
      pending.previousHash !== expected.tapeHeadHash
    ) {
      fail("TEACHER_JUDGEMENT_BROWSER_BINDING_STALE", "浏览器任务已变化，请重新建立教师判断绑定。", 409);
    }
    browserLineage = { ...expected };
  }
  return issueBrowserAutonomyBindingFromPrisma({
    prisma: input.prisma,
    browserCourseId: run.courseId,
    browserRunId: run.id,
    browser: {
      courseId: run.courseId,
      runId: run.id,
      tapeRef: browserLineage.tapeRef,
      tapeHeadHash: browserLineage.tapeHeadHash,
      runRevision: browserLineage.runRevision,
      observationHash: browserLineage.observationHash
    },
    promotionId: input.promotionId,
    decisionKey: input.decisionKey,
    graphSnapshotId: input.graphSnapshotId,
    candidateKey: input.candidateKey
  });
}

function browserObservationHash(run: StoredRun): string | null {
  return run.observation
    ? createHash("sha256").update(stableJson(run.observation), "utf8").digest("hex")
    : null;
}

function assertBrowserBindingState(run: StoredRun, binding: ReturnType<typeof assertBrowserAutonomyBindingCapability>) {
  const tape = verifyBrowserDecisionTape(run);
  if (
    run.courseId !== binding.browserCourseId ||
    run.tapeRef !== binding.browserTapeRef ||
    tape.headHash !== binding.browserTapeHeadHash ||
    run.revision !== binding.browserRunRevision ||
    browserObservationHash(run) !== binding.browserObservationHash
  ) {
    fail("TEACHER_JUDGEMENT_BROWSER_BINDING_STALE", "浏览器任务已变化，请重新建立教师判断绑定。", 409);
  }
}

function promotionErrorCode(error: unknown): string {
  const candidate = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  return typeof candidate === "string" && /^[A-Z][A-Z0-9_.:-]{0,95}$/u.test(candidate)
    ? candidate
    : "TEACHER_JUDGEMENT_PROMOTION_RETRY_REQUIRED";
}

/**
 * Advance the durable cross-store outbox without ever mutating an existing
 * row.  The prepared -> autonomy_appended -> browser_mirrored chain can be
 * resumed after a crash; needs_review is a retry marker, not an authority.
 */
async function advanceBrowserTeacherJudgementOutbox(input: {
  readonly prisma: CommunityTeacherJudgementTapeDb;
  readonly judgement: CommunityTeacherJudgementV1;
  readonly binding: ReturnType<typeof assertBrowserAutonomyBindingCapability>;
  readonly browserCourseId: string;
  readonly target: CommunityTeacherJudgementOutboxState;
  readonly errorCode?: string | null;
}): Promise<void> {
  let latest = await getLatestCommunityTeacherJudgementOutboxEvent({
    prisma: input.prisma,
    operationKey: input.judgement.operationKey
  });
  if (latest && (
    latest.judgementHash !== input.judgement.judgementHash ||
    latest.bindingHash !== input.binding.bindingHash
  )) {
    fail("TEACHER_JUDGEMENT_OUTBOX_OPERATION_CONFLICT", "教师判断 outbox 已绑定另一份判断。", 409);
  }

  const append = async (state: CommunityTeacherJudgementOutboxState, errorCode?: string | null) => {
    const result = await appendCommunityTeacherJudgementOutboxEvent({
      prisma: input.prisma,
      judgement: input.judgement,
      binding: input.binding,
      browserCourseId: input.browserCourseId,
      state,
      errorCode
    });
    latest = {
      operationKey: input.judgement.operationKey,
      state: result.state,
      judgementHash: input.judgement.judgementHash,
      bindingHash: input.binding.bindingHash,
      sequence: result.sequence,
      eventHash: result.eventHash
    };
  };

  if (input.target === "needs_review") {
    if (!latest) await append("prepared");
    if (latest?.state !== "needs_review" && latest?.state !== "browser_mirrored") {
      await append("needs_review", input.errorCode);
    }
    return;
  }

  // A terminal mirrored row is already the strongest durable state.
  if (latest?.state === "browser_mirrored") return;
  if (!latest) await append("prepared");
  if (latest?.state === "needs_review") await append("prepared");
  if (input.target === "prepared") return;
  if (latest?.state === "prepared") await append("autonomy_appended");
  if (input.target === "autonomy_appended") return;
  if (latest?.state === "autonomy_appended") await append("browser_mirrored");
}

/**
 * Promote one already-recorded browser teacher review into the autonomy
 * Decision Tape.  This is an explicit server-only operation: the caller must
 * provide the complete autonomy anchor, decision key, evidence and a
 * server-issued approval capability.  The browser run does not contain an
 * autonomy anchor, so this function never derives one from a course URL, run
 * id, discussion ref or review payload.
 *
 * The ordinary `reviewBrowserReplyUptake` and
 * `reviewBrowserParticipationChoice` paths remain unchanged.  Missing a
 * promotion request or server appender therefore preserves the existing
 * Browser Tape behaviour and cannot alter a decision or publish state.
 */
export async function promoteBrowserTeacherJudgement(
  id: string,
  input: BrowserTeacherJudgementPromotionInput,
  appendToAutonomyTape: BrowserTeacherJudgementTapeAppender
): Promise<BrowserTeacherJudgementPromotionResult> {
  assertBrowserTeacherJudgementServerOnly();
  const runSnapshot = getRun(await loadState(), id);
  const binding = assertBrowserAutonomyBindingCapability(input.binding);
  if (binding.browserRunId !== id || binding.browserCourseId !== runSnapshot.courseId) {
    fail("TEACHER_JUDGEMENT_BROWSER_RUN_MISMATCH", "教师判断没有绑定当前浏览器任务。", 409);
  }
  if (input.operationKey !== binding.promotionId) {
    fail("TEACHER_JUDGEMENT_OPERATION_MISMATCH", "教师判断操作编号与绑定不一致。", 409);
  }
  if (
    typeof appendToAutonomyTape !== "function" ||
    appendToAutonomyTape[BROWSER_TEACHER_JUDGEMENT_APPENDER_BRAND] !== true
  ) {
    fail("TEACHER_JUDGEMENT_TAPE_ADAPTER_INVALID", "教师判断 Tape 适配器不可用。", 503);
  }
  const prisma = appendToAutonomyTape[BROWSER_TEACHER_JUDGEMENT_PRISMA_BRAND];
  if (!prisma || typeof prisma !== "object") {
    fail("TEACHER_JUDGEMENT_OUTBOX_ADAPTER_INVALID", "教师判断 outbox 适配器不可用。", 503);
  }

  // The builder verifies the approval brand, exact evidence refs and all
  // body-free/canonical fields before the autonomy adapter is called.
  const judgement = buildCommunityTeacherJudgement({
    ...input,
    anchor: binding.anchor,
    decisionKey: binding.decisionKey,
    browserRunRef: binding.browserRunId,
    browserBindingHash: binding.bindingHash
  });
  if (judgement.browserRunRef !== runSnapshot.id) {
    fail("TEACHER_JUDGEMENT_BROWSER_RUN_MISMATCH", "教师判断没有绑定当前浏览器任务。", 409);
  }

  const existing = (runSnapshot.tape ?? []).find((entry) =>
    entry.kind === "teacher_judgement" &&
    entry.payload.operationKey === judgement.operationKey
  );
  if (existing) {
    if (
      existing.payload.judgementHash !== judgement.judgementHash ||
      existing.payload.bindingHash !== binding.bindingHash
    ) {
      fail("TEACHER_JUDGEMENT_OPERATION_CONFLICT", "教师判断操作编号已绑定另一份判断。", 409);
    }
  }
  const pending = (runSnapshot.tape ?? []).find((entry) =>
    entry.kind === "teacher_judgement_pending" &&
    entry.payload.operationKey === judgement.operationKey
  );
  if (!existing && pending && (
    pending.payload.judgementHash !== judgement.judgementHash ||
    pending.payload.bindingHash !== binding.bindingHash
  )) {
    fail("TEACHER_JUDGEMENT_OPERATION_CONFLICT", "教师判断操作编号已绑定另一份待结算判断。", 409);
  }
  if (!existing && !pending) assertBrowserBindingState(runSnapshot, binding);

  // Persist the canonical, body-free event before touching the local Browser
  // Tape.  If any later step fails, the durable outbox plus the local pending
  // marker can be resumed by a server worker without trusting request JSON.
  try {
    await advanceBrowserTeacherJudgementOutbox({
      prisma,
      judgement,
      binding,
      browserCourseId: runSnapshot.courseId,
      target: "prepared"
    });
    if (!existing && !pending) {
      await transaction((state) => {
        const run = getRun(state, id);
        const current = (run.tape ?? []).find((entry) =>
          entry.kind === "teacher_judgement_pending" &&
          entry.payload.operationKey === judgement.operationKey
        );
        if (current) {
          if (
            current.payload.judgementHash !== judgement.judgementHash ||
            current.payload.bindingHash !== binding.bindingHash
          ) {
            fail("TEACHER_JUDGEMENT_OPERATION_CONFLICT", "教师判断操作编号已绑定另一份待结算判断。", 409);
          }
          return;
        }
        assertBrowserBindingState(run, binding);
        appendTape(run, "teacher_judgement_pending", {
          judgementHash: judgement.judgementHash,
          decisionKey: judgement.decisionKey,
          invocationId: judgement.anchor.invocationId,
          browserRunRef: run.id,
          bindingHash: binding.bindingHash,
          operationKey: judgement.operationKey
        });
      });
    }
  } catch (error) {
    try {
      await advanceBrowserTeacherJudgementOutbox({
        prisma,
        judgement,
        binding,
        browserCourseId: runSnapshot.courseId,
        target: "needs_review",
        errorCode: promotionErrorCode(error)
      });
    } catch {
      // Preserve the original, stable failure code; the scanner can retry the
      // prepared event if the secondary marker write was unavailable.
    }
    throw error;
  }

  // The adapter performs the second, database-backed exact invocation/world/
  // graph/candidate/decision check.  If it rejects, no Browser Tape entry is
  // added and the legacy review state remains untouched; the outbox records a
  // retryable needs_review state.
  let autonomyTape: CommunityTeacherJudgementTapeAppendResult;
  try {
    autonomyTape = await appendToAutonomyTape({
      invocationId: judgement.anchor.invocationId,
      judgement
    });
    if (autonomyTape.judgementHash !== judgement.judgementHash) {
      fail("TEACHER_JUDGEMENT_TAPE_RECEIPT_MISMATCH", "自治 Tape 回执与教师判断不一致。", 503);
    }
    await advanceBrowserTeacherJudgementOutbox({
      prisma,
      judgement,
      binding,
      browserCourseId: runSnapshot.courseId,
      target: "autonomy_appended"
    });
  } catch (error) {
    try {
      await advanceBrowserTeacherJudgementOutbox({
        prisma,
        judgement,
        binding,
        browserCourseId: runSnapshot.courseId,
        target: "needs_review",
        errorCode: promotionErrorCode(error)
      });
    } catch {
      // Keep the autonomy adapter's failure visible to the caller.
    }
    throw error;
  }

  let browser: { run: BrowserCourseRun; browserTapeReplayed: boolean };
  try {
    browser = await transaction((state) => {
      const run = getRun(state, id);
      const existing = (run.tape ?? []).find((entry) =>
        entry.kind === "teacher_judgement" &&
        entry.payload.operationKey === judgement.operationKey
      );
      if (existing) {
        if (
          existing.payload.judgementHash !== judgement.judgementHash ||
          existing.payload.bindingHash !== binding.bindingHash
        ) {
          fail("TEACHER_JUDGEMENT_OPERATION_CONFLICT", "教师判断操作编号已绑定另一份判断。", 409);
        }
        return { run: publicRun(run), browserTapeReplayed: true };
      }
      const pendingEntry = (run.tape ?? []).find((entry) =>
        entry.kind === "teacher_judgement_pending" &&
        entry.payload.operationKey === judgement.operationKey
      );
      if (!pendingEntry ||
        pendingEntry.payload.judgementHash !== judgement.judgementHash ||
        pendingEntry.payload.bindingHash !== binding.bindingHash ||
        run.tape?.at(-1)?.entryHash !== pendingEntry.entryHash
      ) {
        fail("TEACHER_JUDGEMENT_BROWSER_BINDING_STALE", "教师判断待结算记录已变化，请重新建立绑定。", 409);
      }
      appendTape(run, "teacher_judgement", {
        judgementHash: judgement.judgementHash,
        decisionKey: judgement.decisionKey,
        invocationId: judgement.anchor.invocationId,
        browserRunRef: run.id,
        bindingHash: binding.bindingHash,
        action: judgement.action,
        reasonCode: judgement.reasonCode,
        reviewerRole: judgement.reviewerRole,
        reviewerRefHash: judgement.reviewerRefHash,
        operationKey: judgement.operationKey,
        pendingEntryHash: pendingEntry.entryHash,
        autonomyTapeSequence: autonomyTape.sequence,
        autonomyEntryHash: autonomyTape.entryHash,
        autonomyTapeReplayed: autonomyTape.replayed
      });
      return { run: publicRun(run), browserTapeReplayed: false };
    });
    await advanceBrowserTeacherJudgementOutbox({
      prisma,
      judgement,
      binding,
      browserCourseId: runSnapshot.courseId,
      target: "browser_mirrored"
    });
  } catch (error) {
    try {
      await advanceBrowserTeacherJudgementOutbox({
        prisma,
        judgement,
        binding,
        browserCourseId: runSnapshot.courseId,
        target: "needs_review",
        errorCode: promotionErrorCode(error)
      });
    } catch {
      // The Browser Tape may already contain the mirror; a later retry will
      // reconcile it against the autonomy_appended outbox row.
    }
    throw error;
  }
  return {
    run: browser.run,
    judgementHash: judgement.judgementHash,
    autonomyTape,
    browserTapeReplayed: browser.browserTapeReplayed
  };
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
    if (!proposal || proposal.decision !== "DRAFT" || proposal.discussionRef !== receipt.discussionRef || !discussion || discussion.url !== receipt.targetUrl) fail("REPLY_RECEIPT_TARGET_MISMATCH", "回执目标与当前促进草稿不一致。", 409);
    if (receipt.status === "confirmed_published") {
      if (trust !== "trusted_connector") fail("REPLY_RECEIPT_TRUST_REQUIRED", "已确认发布回执只能由受信连接器写入。", 423);
      if (!receipt.submitted || !receipt.externalReceiptHash) fail("REPLY_RECEIPT_UNVERIFIED", "已确认发布的回执缺少外部核验。", 409);
    }
    const now = new Date(receipt.observedAt);
    if (now.getTime() > Date.now() + 60_000 || (run.observation && now.getTime() < Date.parse(run.observation.observedAt))) fail("REPLY_RECEIPT_TIME", "回执时间不在当前课程观察之后。", 409);
    const existingWatch = run.replyWatches?.find((watch) => watch.proposalId === receipt.proposalId && watch.touchStatus === "confirmed_published");
    if (existingWatch) {
      if (receipt.status !== "confirmed_published" || existingWatch.replyRef !== receipt.replyRef) fail("REPLY_RECEIPT_CONFLICT", "该草稿已有确认回执，不能替换回复对象或重置回应窗口。", 409);
      rememberOperation(run, operation); return publicRun(run);
    }
    const watch: BrowserReplyWatch = {
      id: randomUUID(), tapeRef: run.tapeRef ?? `tape:${run.id}`, proposalId: receipt.proposalId, discussionRef: receipt.discussionRef, replyRef: receipt.replyRef,
      baselinePostRefs: [...latestObservationPostRefs(run, receipt.discussionRef)], state: receipt.status === "confirmed_published" ? "pending" : receipt.status === "outcome_unknown" ? "outcome_unknown" : "waiting",
      touchStatus: receipt.status, createdAt: receipt.observedAt,
      windowEndsAt: receipt.status === "confirmed_published" ? new Date(now.getTime() + (run.policy?.replyWindowHours ?? 24) * 3600_000).toISOString() : null,
      windowBasis: "course_policy",
      nextCheckAt: receipt.status === "confirmed_published" ? new Date(now.getTime() + Math.min((run.policy?.minimumRescanMinutes ?? 30) * 60_000, (run.policy?.replyWindowHours ?? 24) * 3600_000)).toISOString() : null,
      minimumRescanMinutes: run.policy?.minimumRescanMinutes ?? 30, maximumRescanMinutes: run.policy?.maximumRescanMinutes ?? 240,
      unchangedScans: 0, lastObservationFingerprint: run.observation ? discussionFingerprint(run.observation, receipt.discussionRef) : undefined,
      lastSuccessfulObservationAt: null, observationGapStartedAt: null, observationStatus: "unknown", receivedPostRef: null,
      lastObservedAt: run.observation?.observedAt ?? null, thirdPartyResponseAt: null
    };
    run.replyWatches = (run.replyWatches ?? []).filter((item) => item.proposalId !== receipt.proposalId);
    if (receipt.status !== "staged_not_published") run.replyWatches.push(watch);
    appendTape(run, "reply_receipt", { proposalId: receipt.proposalId, discussionRef: receipt.discussionRef, status: receipt.status, submitted: receipt.submitted, externalReceiptHash: receipt.externalReceiptHash, windowEndsAt: watch.windowEndsAt ?? null, nextCheckAt: watch.nextCheckAt });
    if (receipt.status === "confirmed_published" && run.dispatch) {
      run.dispatch.nextAttemptAt = watch.nextCheckAt!;
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
    for (const watch of run.replyWatches ?? []) if (["pending", "waiting"].includes(watch.state)) {
      watch.state = "relogin_required";
      watch.observationGapStartedAt ??= new Date().toISOString();
      watch.observationStatus = "censored";
    }
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
    if (parsed.context && !(run.observation ? observedCoursePage(course.entryUrl, parsed.context.url, run.observation) : sameCoursePage(course.entryUrl, parsed.context.url))) fail("CONTEXT_COURSE_MISMATCH", "当前页面不属于这项任务绑定的课程，请切回原课程或新建任务。", 409);
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
    return { goal: run.goal, policy: run.policy ?? null, policyRevision: run.policyRevision ?? 0,
      participationChoices: structuredClone(run.participationChoices ?? []), messages: structuredClone(run.messages ?? []) }; });
}
export async function recordBrowserStage(id: string, owner: string, token: string, input: unknown, operationKey?: string) {
  const receipt = browserStageSchema.parse(input);
  const operation = operationDescriptor("stage", receipt, operationKey);
  return transaction((state) => { const run = getRun(state, id); requireLease(run, owner, token); if (replayOperation(run, operation)) return publicRun(run);
    if (run.phase === "reply_watch") fail("WATCH_READ_ONLY", "接球复扫不重新执行编辑器暂存。", 409);
    if (run.mode !== "stage") fail("STAGE_NOT_REQUESTED", "当前任务只允许观察。");
    const p = run.proposals.find((v) => v.id === receipt.proposalId); const discussion = run.observation?.discussions.find((d) => d.ref === p?.discussionRef);
    if (!p || !discussion || p.decision !== "DRAFT" || discussion.url !== receipt.targetUrl || p.draft !== receipt.readback) fail("READBACK_MISMATCH", "编辑器回读与当前目标或草稿不一致。");
    if (!run.stages.some((s) => s.proposalId === p.id && s.proposalRevision === p.revision)) run.stages.push({ proposalId: p.id, proposalRevision: p.revision, targetUrl: discussion.url, at: new Date().toISOString(), source: "agent_readback", cleared: true, submitted: false });
    appendTape(run, "reply_receipt", { proposalId: p.id, discussionRef: p.discussionRef, status: "staged_not_published", submitted: false, externalReceiptHash: null });
    rememberOperation(run, operation); event(run, "stage", "课程代理已记录编辑器逐字回读与清空；未提交。"); return publicRun(run); });
}
export async function finishBrowserRun(id: string, owner: string, token: string, summary: string, operationKey?: string) {
  z.string().trim().min(1).max(800).parse(summary);
  const operation = operationDescriptor("finish", { summary: summary.trim() }, operationKey);
  return transaction((state) => { const run = getRun(state, id); requireLease(run, owner, token); if (replayOperation(run, operation)) return publicRun(run);
    if (!run.observation) fail("OBSERVATION_MISSING", "缺少课程观察，不能完成任务。");
    if (run.messages?.some((m) => m.delivery === "saved")) fail("GUIDANCE_PENDING", "有新的教师补充尚未读取，请先读取要求再完成任务。", 409);
    const lastBegin = (run.tape ?? []).map((entry) => entry.kind).lastIndexOf("patrol_begin");
    if (lastBegin >= 0 && !(run.tape ?? []).slice(lastBegin + 1).some((entry) => entry.kind === "observation")) fail("OBSERVATION_MISSING", "本轮还没有记录新的观察，不能沿用上轮观察完成任务。");
    if (run.phase !== "reply_watch" && run.proposals.length !== run.observation.discussions.length) fail("DECISIONS_INCOMPLETE", "每个已读取讨论都需要记录一个决定。");
    if (run.phase !== "reply_watch" && run.mode === "stage" && run.proposals.some((p) => p.decision === "DRAFT" && !run.stages.some((s) => s.proposalId === p.id && s.proposalRevision === p.revision))) fail("STAGE_INCOMPLETE", "还没有完成当前草稿的编辑器回读与清空。");
    run.status = "completed"; run.summary = summary.trim(); run.lease = null;
    const pendingWatch = (run.replyWatches ?? []).some((watch) => ["pending", "waiting"].includes(watch.state));
    if (run.dispatch) {
      run.dispatch.state = pendingWatch ? (run.executor !== "codex_app_server" ? "host_queued" : "watch_queued") : "complete";
      if (pendingWatch) run.dispatch.nextAttemptAt = (run.replyWatches ?? []).filter((watch) => ["pending", "waiting"].includes(watch.state)).map((watch) => watch.nextCheckAt).filter((value): value is string => !!value).sort()[0] ?? new Date().toISOString();
    }
    const counts = decisionCounts(run);
    appendTape(run, "patrol_end", { phase: run.phase ?? "patrol", DRAFT: counts.DRAFT, WAIT: counts.WAIT, YIELD: counts.YIELD, ABSTAIN: counts.ABSTAIN, pendingWatches: pendingWatch });
    if (pendingWatch) run.phase = "reply_watch";
    rememberOperation(run, operation); event(run, "completed", pendingWatch ? "本轮完成，已排入同一 Tape 的接球复扫。" : "本轮课程任务完成，成果已同步到工作台。"); return publicRun(run); });
}

/** Validate ownership before a cross-store, body-free projection. No guidance is consumed. */
export async function checkBrowserMiddleLayerLease(id: string, owner: string, token: string) {
  return transaction(state => {
    const run = getRun(state, id); requireLease(run, owner, token);
    if (run.messages?.some(m => m.delivery === "saved")) fail("GUIDANCE_PENDING", "请先读取本轮新的教师补充。", 409);
    return publicRun(run);
  });
}

/** Internal projection reservation. Failed DB writes can retry this exact input. */
export async function sealBrowserMiddleLayerInput(id: string) {
  return transaction(state => {
    const run = getRun(state, id);
    if (run.status !== "running") fail("RUN_NOT_RUNNING", "任务已停止，不能生成新的中层投影。", 409);
    if (run.phase === "reply_watch") fail("WATCH_READ_ONLY", "接球复扫仅记录近端结果，不重建促进基线。", 409);
    if (!run.observation || run.proposals.length !== run.observation.discussions.length) fail("DECISIONS_INCOMPLETE", "先完成当前观察的决定。", 409);
    const seal = browserProjectionSeal(run.observation, run.proposals);
    if (run.projectionSeal && (seal.observationHash !== run.projectionSeal.observationHash || seal.decisionHash !== run.projectionSeal.decisionHash)) {
      fail("PROJECTION_SNAPSHOT_IMMUTABLE", "中层输入已保存；请重新观察后继续。", 409);
    }
    run.projectionSeal = seal;
    return publicRun(run);
  });
}
export async function interruptBrowserRun(id: string, message = "任务已停止，已获得的观察和建议保留。", status: "interrupted" | "needs_attention" | "cancelled" = "interrupted") {
  return transaction((state) => { const run = getRun(state, id); if ((run.status === "completed" && !(run.replyWatches ?? []).some((watch) => ["pending", "waiting"].includes(watch.state))) || run.status === "cancelled") return publicRun(run);
    for (const watch of run.replyWatches ?? []) if (["pending", "waiting"].includes(watch.state)) {
      watch.observationGapStartedAt ??= new Date().toISOString(); watch.observationStatus = "censored";
    }
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
    const resumeReplyWatch = (run.replyWatches ?? []).some((watch) => ["pending", "waiting", "relogin_required"].includes(watch.state) && watch.touchStatus === "confirmed_published");
    if (resumeReplyWatch) {
      for (const watch of run.replyWatches ?? []) if (watch.state === "relogin_required") { watch.state = "pending"; watch.nextCheckAt = new Date().toISOString(); }
    }
    if (dispatchOrigin) {
      const course = getCourse(state, run.courseId);
      if (run.executor !== "codex_app_server" || !isLocalCourseFixture(course.entryUrl) || new URL(course.entryUrl).origin !== dispatchOrigin) fail("DISPATCH_SCOPE", "后台执行与课程入口不一致。", 409);
      run.dispatch = { version: 1, origin: dispatchOrigin, state: resumeReplyWatch ? "watch_queued" : "queued", attempts: 0, nextAttemptAt: new Date().toISOString(), startedAt: null, lastFailureCode: null };
      delete run.executionRunId;
    } else if (run.executor !== "codex_app_server") {
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

export async function recoverBrowserExecution(id: string, executionId: string, code: string, now = new Date()) {
  return transaction((state) => {
    const run = getRun(state, id); const dispatch = run.dispatch;
    // Compare-and-set fences late errors from an old process, including errors after a teacher stop.
    const watchExecution = dispatch?.state === "watch_executing";
    if (!dispatch || (!watchExecution && dispatch.state !== "executing") || run.executionRunId !== executionId || (!watchExecution && !["queued", "running"].includes(run.status)) || (watchExecution && !["completed", "running"].includes(run.status))) return publicRun(run);
    dispatch.lastFailureCode = safeBrowserFailureCode(code); run.lease = null;
    const failure = classifyBrowserFailure(dispatch.lastFailureCode, { mode: run.mode, phase: watchExecution ? "reply_watch" : "patrol", attempts: dispatch.attempts });
    dispatch.failureClass = failure.failureClass; dispatch.retryable = failure.retryable; dispatch.terminalAction = failure.terminalAction;
    appendTape(run, "recovery", { failureClass: failure.failureClass, retryable: failure.retryable, terminalAction: failure.terminalAction, attempt: dispatch.attempts, retryDelayMs: failure.retryDelayMs }, now);
    if (failure.terminalAction === "relogin_required") {
      dispatch.state = "paused"; run.status = "needs_attention"; run.authState = "relogin_required";
      for (const watch of run.replyWatches ?? []) if (["pending", "waiting"].includes(watch.state)) {
        watch.state = "relogin_required"; watch.observationGapStartedAt ??= now.toISOString(); watch.observationStatus = "censored";
      }
      appendTape(run, "auth_attention", { status: "relogin_required", code: "AUTH_RELOGIN_REQUIRED" }, now);
      event(run, "interrupted", "登录已失效，巡检暂停，等待重新登录。" );
    } else if (!failure.retryable) {
      dispatch.state = watchExecution ? "watch_attention" : "attention"; run.status = "needs_attention";
      event(run, "interrupted", watchExecution ? "接球复扫需要核对；已有回执保留，请检查后继续。" : run.mode === "stage" ? "编辑器任务的执行连接中断；已有成果保留，请核对编辑器后继续。" : dispatch.attempts >= 3 ? "后台已达到本轮恢复次数上限，已有成果保留，需要检查。" : "当前失败需要核对目标或证据，已停止自动重试。" );
    } else {
      dispatch.state = watchExecution ? "watch_queued" : "retry_wait"; dispatch.nextAttemptAt = new Date(now.getTime() + (failure.retryDelayMs ?? 30_000)).toISOString();
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
  if (process.platform !== "win32") await chmod(file, 0o600);
  return readFile(file, "utf8");
}
export async function verifyBrowserBridge(value: string | null) {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(await browserBridgeSecret()));
}
