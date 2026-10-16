import { z } from "zod";
import { facilitationIntentSchema, facilitationPolicySchema, type FacilitationPolicy } from "./facilitation-policy";
import { browserPageProofSchema, type BrowserCoverageEvaluation } from "./browser-course-coverage";
import type { BrowserInteractionMetrics, BrowserTrajectoryEvaluation } from "./browser-course-insights";

const text = (max: number) => z.string().trim().min(1).max(max);
export const MAX_BROWSER_DISCUSSIONS = 200;
export const browserRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/);
export const courseUrl = z.string().max(2048).url().refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !url.hash &&
    (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) &&
    ![...url.searchParams.keys()].some((key) => /token|secret|password|auth|session|cookie/i.test(key));
}, "请使用不含登录信息的 HTTPS 课程链接；本机测试页面可使用 HTTP。");

export const createBrowserCourseSchema = z.object({
  title: text(100), entryUrl: courseUrl, platformLabel: text(50).default("浏览器课程"),
  goal: text(800).default("看看本周的讨论，帮助还没有得到回应的学习者。"),
  budget: z.number().int().min(0).max(5).default(1),
  facilitationPolicy: facilitationPolicySchema.optional()
}).strict();

export const browserObservationSchema = z.object({
  courseUrl,
  observedAt: z.string().datetime(),
  scope: z.enum(["course", "selected_discussions"]),
  complete: z.boolean(),
  expectedDiscussions: z.number().int().min(0).max(2000).nullable(),
  coverageNote: text(500),
  pages: z.array(z.object({ url: courseUrl, itemCount: z.number().int().min(0).max(2000), terminal: z.boolean(), proof: browserPageProofSchema.optional() }).strict()).min(1).max(200),
  discussions: z.array(z.object({
    ref: browserRef, url: courseUrl, title: text(120), summary: text(500), complete: z.boolean(),
    membership: z.object({ sourcePageUrl: courseUrl, observedAt: z.string().datetime(),
      method: z.literal("course_listing_link") }).strict().optional(),
    interpretation: z.object({
      activity_phase: z.enum(["question_opening", "explanation_development", "peer_review", "resource_connection", "collaborative_progress", "task_reentry", "unknown"]),
      purpose_compatible: z.enum(["true", "false", "unknown"]),
      teacher_required: z.enum(["true", "false", "unknown"]),
      evidenceRefs: z.array(browserRef).min(1).max(15), interpretedAt: z.string().datetime()
    }).strict().optional()
  }).strict()).max(MAX_BROWSER_DISCUSSIONS),
  posts: z.array(z.object({
    ref: browserRef, discussionRef: browserRef, parentRef: browserRef.nullable(),
    actorAlias: z.string().regex(/^[A-Z][A-Z0-9]{0,7}$/),
    role: z.enum(["learner", "teacher", "agent", "unknown"]),
    createdAt: z.string().datetime().nullable(), editedAt: z.string().datetime().optional(), url: courseUrl
  }).strict()).max(2000)
}).strict();

export const browserProposalSchema = z.object({
  discussionRef: browserRef, decision: z.enum(["DRAFT", "WAIT", "YIELD", "ABSTAIN"]),
  reason: text(600), draft: z.string().trim().max(1600).default(""),
  intent: facilitationIntentSchema.optional()
}).strict();

export const browserStageSchema = z.object({
  proposalId: z.string().uuid(), targetUrl: courseUrl,
  readback: z.string().max(1600), cleared: z.literal(true), submitted: z.literal(false)
}).strict();

export const REPLY_UPTAKE_KINDS = ["acknowledgement", "clarification", "explanation_advance", "correction", "resource_use", "peer_connection", "unknown"] as const;
export const browserReplyUptakeSchema = z.object({
  watchId: z.string().uuid(), postRef: browserRef,
  kind: z.enum(REPLY_UPTAKE_KINDS),
  evidenceRefs: z.array(browserRef).min(1).max(15),
  observedAt: z.string().datetime()
}).strict();
export const browserParticipationChoiceSchema = z.object({
  discussionRef: browserRef, actorAlias: z.string().regex(/^[A-Z][A-Z0-9]{0,7}$/),
  choice: z.enum(["wait_for_peers", "request_teacher", "decline", "stop", "resume"]),
  evidenceRefs: z.array(browserRef).min(1).max(15), observedAt: z.string().datetime(),
  supersedesChoiceId: z.string().uuid().optional()
}).strict();
export type BrowserReplyUptake = z.infer<typeof browserReplyUptakeSchema> & {
  id: string; recordedAt: string; source: "browser_observation" | "teacher_review";
};
export type BrowserParticipationChoice = z.infer<typeof browserParticipationChoiceSchema> & {
  id: string; recordedAt: string; source: "browser_observation" | "teacher_review";
};

/**
 * A post receipt is an observation of an already completed external action.
 * The browser companion never exposes this action; trusted connectors may
 * record the receipt so the follow-up scan stays on the same patrol tape.
 */
export const browserReplyReceiptSchema = z.object({
  proposalId: z.string().uuid(),
  discussionRef: browserRef,
  replyRef: browserRef,
  targetUrl: courseUrl,
  status: z.enum(["confirmed_published", "outcome_unknown", "staged_not_published"]),
  observedAt: z.string().datetime(),
  submitted: z.boolean(),
  externalReceiptHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null)
}).strict().superRefine((value, ctx) => {
  if (value.status === "confirmed_published" && (!value.submitted || !value.externalReceiptHash)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["externalReceiptHash"], message: "已确认发布的回执需要外部核验哈希。" });
  }
  if (value.status !== "confirmed_published" && value.submitted) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["submitted"], message: "未确认发布的回执不能标记为已提交。" });
  }
});

export type BrowserObservation = z.infer<typeof browserObservationSchema>;
export type BrowserProposalInput = z.infer<typeof browserProposalSchema>;
export type BrowserReplyReceipt = z.infer<typeof browserReplyReceiptSchema>;
export type BrowserProposal = BrowserProposalInput & { id: string; revision: number; updatedAt: string };
export type BrowserCourse = z.infer<typeof createBrowserCourseSchema> & {
  id: string; createdAt: string; source: "connected" | "local_fixture";
  policyRevision?: number;
  policyHistory?: Array<{ revision: number; at: string; policy: FacilitationPolicy }>;
};
export type BrowserRunStatus = "queued" | "running" | "completed" | "interrupted" | "needs_attention" | "cancelled";
export type BrowserDispatch = {
  version: 1;
  origin: string;
  state: "queued" | "executing" | "retry_wait" | "paused" | "complete" | "attention" |
    "host_queued" | "host_executing" | "watch_queued" | "watch_executing" | "watch_attention";
  attempts: number;
  nextAttemptAt: string;
  startedAt: string | null;
  lastFailureCode: string | null;
  failureClass?: string;
  retryable?: boolean;
  terminalAction?: "retry" | "relogin_required" | "attention";
};
export type BrowserAuthState = "unknown" | "authenticated" | "relogin_required";
export type BrowserReplyWatch = {
  id: string;
  tapeRef: string;
  proposalId: string;
  discussionRef: string;
  replyRef: string;
  baselinePostRefs: string[];
  state: "pending" | "waiting" | "received" | "needs_rethread" | "outcome_unknown" | "relogin_required";
  touchStatus: "confirmed_published" | "staged_not_published" | "outcome_unknown";
  createdAt: string;
  nextCheckAt: string | null;
  windowEndsAt?: string | null;
  windowBasis?: "course_policy" | "legacy_default";
  minimumRescanMinutes?: number;
  maximumRescanMinutes?: number;
  unchangedScans?: number;
  lastObservationFingerprint?: string;
  lastSuccessfulObservationAt?: string | null;
  observationGapStartedAt?: string | null;
  observationStatus?: "complete" | "incomplete" | "censored" | "unknown";
  receivedPostRef?: string | null;
  lastObservedAt: string | null;
  thirdPartyResponseAt: string | null;
}
export type BrowserTapePayload = Record<string, string | number | boolean | null>;
export type BrowserDecisionTapeEntry = {
  seq: number;
  at: string;
  kind: "patrol_queued" | "patrol_begin" | "observation" | "decision" | "reply_receipt" | "reply_watch" | "auth_attention" | "patrol_end" | "reply_uptake" | "participation_choice" | "teacher_judgement_pending" | "teacher_judgement" | "recovery";
  ref: string;
  previousHash: string | null;
  entryHash: string;
  payload: BrowserTapePayload;
};
export type BrowserConnectionHealth = {
  courseId: string;
  tapeRef: string | null;
  status: "idle" | "healthy" | "waiting" | "attention" | "relogin_required";
  queueState: BrowserDispatch["state"] | null;
  authState: BrowserAuthState;
  posts: number;
  touched: number;
  peerResponses: number;
  reciprocity: "not_started" | "waiting" | "received" | "no_response" | "outcome_unknown";
  decisions: { DRAFT: number; WAIT: number; YIELD: number; ABSTAIN: number };
  pendingWatches: number;
  lastPatrolAt: string | null;
  lastTouchAt: string | null;
  lastPeerResponseAt: string | null;
  interaction?: BrowserInteractionMetrics;
  coverage?: BrowserCoverageEvaluation;
  trajectory?: BrowserTrajectoryEvaluation;
  uptakeCounts?: Partial<Record<typeof REPLY_UPTAKE_KINDS[number], number>>;
};
export type BrowserRunReceipt = {
  schemaVersion: "browser-course-run-receipt.v1";
  runId: string; tapeRef: string | null; tapeHeadHash: string | null; tapeValid: boolean; tapeEntries: number;
  observationHash: string | null; proposalInputHash: string | null; policyHash: string | null;
  observedAt: string | null; coverage: "complete" | "partial" | "unknown";
  terminalDisposition: BrowserRunStatus;
  evidenceLevel: "not_observed" | "local_synthetic" | "browser_reported_observation" | "editor_readback" | "trusted_reply_receipt";
  editorReadbacks: number; trustedRepliesReported: number; interpretationRecords: number;
  runtimePublicationEnabled: false;
};
export type BrowserCourseRun = {
  projectionSeal?: { observationHash: string; decisionHash: string };
  id: string; courseId: string; requestId: string; goal: string;
  executor: "codex_host" | "codex_app_server" | "external_host"; mode: "observe" | "stage";
  phase?: "patrol" | "reply_watch";
  executionRunId?: string;
  dispatch?: BrowserDispatch;
  authState?: BrowserAuthState;
  tapeRef?: string;
  tape?: BrowserDecisionTapeEntry[];
  replyWatches?: BrowserReplyWatch[];
  uptakeObservations?: BrowserReplyUptake[];
  participationChoices?: BrowserParticipationChoice[];
  proposalInputs?: BrowserProposalInput[];
  coverageEvaluation?: BrowserCoverageEvaluation;
  policyRevision?: number;
  receipt?: BrowserRunReceipt;
  status: BrowserRunStatus; attempt: number; createdAt: string; updatedAt: string;
  observation: BrowserObservation | null; proposals: BrowserProposal[];
  stages: Array<{ proposalId: string; proposalRevision: number; targetUrl: string; at: string; source: "agent_readback"; cleared: true; submitted: false }>;
  events: Array<{ at: string; step: "queued" | "observing" | "observation" | "proposals" | "stage" | "completed" | "interrupted"; message: string }>;
  summary: string; cursor: string | null; revision: number;
  policy?: FacilitationPolicy;
  messages?: Array<{ id: string; requestId: string; text: string; at: string; delivery: "saved" | "delivered"; context?: { url: string; title: string; selection: string; capturedAt: string } }>;
};
export type BrowserGraph = { actors: Array<{ id: string; role: string }>; edges: Array<{ source: string; target: string; weight: number }> };
export type BrowserWorkspaceSnapshot = {
  schemaVersion: "course-browser-workspace.v1"; revision: number;
  courses: BrowserCourse[]; runs: BrowserCourseRun[];
  graphs: Record<string, BrowserGraph>;
  connectionHealth?: BrowserConnectionHealth[];
  execution: { nativeBrowserInherited: false; localBrowserMcp: boolean; realPublishEnabled: false };
};

export const LOCAL_COURSE_PATHS = ["/browser-lab/seminar", "/browser-lab/studio"] as const;
export function isLocalCourseFixture(value: string): boolean {
  try { const url = new URL(value); return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && LOCAL_COURSE_PATHS.some((p) => url.pathname === p); }
  catch { return false; }
}

export function sameCoursePage(entry: string, candidate: string): boolean {
  const base = new URL(entry); const target = new URL(candidate);
  if (base.origin !== target.origin) return false;
  // A course query is part of its identity. Do not let another course at the same origin substitute for it.
  for (const key of ["course", "courseId", "course_id", "id"]) {
    const baseValues = base.searchParams.getAll(key), targetValues = target.searchParams.getAll(key);
    if (baseValues.length > 1 || targetValues.length > 1) return false;
    if (key !== "id" || base.searchParams.has(key) || base.pathname === target.pathname) {
      if (base.searchParams.get(key) !== target.searchParams.get(key)) return false;
    }
  }
  const root = base.pathname.replace(/\/$/, "");
  return target.pathname === root || target.pathname.startsWith(`${root}/`);
}

/** A sibling cMOOC detail requires a course-listing observation from this bound course.
 * This is authenticated browser evidence, not a server claim of platform attestation.
 */
export function observedCoursePage(entry: string, candidate: string, observation: BrowserObservation): boolean {
  if (sameCoursePage(entry, candidate)) return true;
  const base = new URL(entry), target = new URL(candidate);
  if (base.origin !== "https://cmooc.bnu.edu.cn" || base.pathname !== "/cMOOC/course" ||
      !base.searchParams.get("courseId") || target.origin !== base.origin || target.pathname !== "/cMOOC/detail" ||
      !/^\d+$/.test(target.searchParams.get("id") ?? "")) return false;
  if (target.searchParams.has("courseId") && target.searchParams.get("courseId") !== base.searchParams.get("courseId")) return false;
  return observation.discussions.some(d => d.url === candidate && d.membership?.method === "course_listing_link" &&
    sameCoursePage(entry, d.membership.sourcePageUrl) &&
    Date.parse(d.membership.observedAt) <= Date.parse(observation.observedAt));
}

export function canonicalBrowserCourseUrl(value: string): string {
  const url = new URL(value);
  if (url.origin === "https://cmooc.bnu.edu.cn" && url.pathname === "/cMOOC/course" && url.searchParams.get("courseId")) {
    const canonical = new URL("/cMOOC/course", url.origin);
    canonical.searchParams.set("courseId", url.searchParams.get("courseId")!);
    return canonical.href;
  }
  return url.href;
}
