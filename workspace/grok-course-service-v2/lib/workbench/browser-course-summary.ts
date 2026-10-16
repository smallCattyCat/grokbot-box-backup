import {
  getBrowserDiscussionIdentity,
  type BrowserCourse,
  type BrowserCourseRun,
  type BrowserConnectionHealth,
  type BrowserDiscussionIdentityBasis,
  type BrowserWorkspaceSnapshot
} from "./browser-course-contracts";

const HUMAN_ROLES = new Set(["learner", "teacher"]);
const SUBSTANTIVE_KINDS = new Set([
  "clarification", "explanation_advance", "correction", "resource_use", "peer_connection"
]);

export type BrowserCourseSummaryFunction = "courtesy" | "substantive" | "unknown";
export type BrowserCourseSummaryResponse = "present" | "absent" | "unknown";
export type BrowserCourseSummaryFollowup = "unknown" | "needed" | "not_needed";

export type BrowserDiscussionSummary = {
  identityKey: string;
  identityBasis: BrowserDiscussionIdentityBasis;
  longitudinalMerge: "allowed" | "blocked";
  discussionRef: string;
  url: string;
  title: string;
  observedAt: string;
  runId: string;
  structuralResponse: BrowserCourseSummaryResponse;
  continuationFunction: BrowserCourseSummaryFunction;
  continuationKind: string | null;
  followup: BrowserCourseSummaryFollowup;
  peerContinuation: "true" | "false" | "unknown";
  peerReplyRefs: string[];
  authorReturnRefs: string[];
  evidenceRefs: string[];
  decision: "DRAFT" | "WAIT" | "YIELD" | "ABSTAIN" | null;
  legacyStructuralOnly: boolean;
  interpretationSource: "browser_interpretation" | "unknown";
  nextSteps: string[];
};

export type BrowserCourseSummary = {
  schemaVersion: "browser-course-summary.v1";
  courseId: string | null;
  courseTitle: string | null;
  observationScope: {
    courseIds: string[];
    runCount: number;
    observedRunCount: number;
    latestObservedAt: string | null;
    latestScope: "course" | "selected_discussions" | null;
    completeRuns: number;
    partialRuns: number;
    discussionsObserved: number;
    postsObserved: number;
    observations: Array<{
      runId: string;
      observedAt: string;
      scope: "course" | "selected_discussions";
      complete: boolean;
      discussions: number;
      posts: number;
    }>;
    observationsTotal: number;
    observationsTruncated: boolean;
  };
  structuralResponses: {
    present: number;
    absent: number;
    unknown: number;
    total: number;
  };
  continuationFunctions: {
    courtesy: number;
    substantive: number;
    unknown: number;
    total: number;
  };
  followup: {
    needed: number;
    unknown: number;
    not_needed: number;
    total: number;
  };
  decisions: { DRAFT: number; WAIT: number; YIELD: number; ABSTAIN: number; unset: number };
  runtime: {
    latestRun: { id: string; status: BrowserCourseRun["status"]; authState: BrowserCourseRun["authState"]; queueState: NonNullable<BrowserCourseRun["dispatch"]>["state"] | null; phase: BrowserCourseRun["phase"] | null; updatedAt: string; summary: string } | null;
    connectionHealth: Pick<BrowserConnectionHealth, "courseId" | "status" | "authState" | "queueState" | "pendingWatches" | "lastPatrolAt" | "lastPeerResponseAt"> | null;
    nextAction: string;
  };
  details: { items: BrowserDiscussionSummary[]; total: number; truncated: boolean };
  discussions: BrowserDiscussionSummary[];
  nextSteps: Array<{ identityKey: string; action: string; evidenceRefs: string[] }>;
  nextStepsTotal: number;
  nextStepsTruncated: boolean;
};

type DiscussionEntry = {
  run: BrowserCourseRun;
  course: BrowserCourse | undefined;
  discussion: NonNullable<BrowserCourseRun["observation"]>["discussions"][number];
};

function latestFirst(left: DiscussionEntry, right: DiscussionEntry): number {
  const observed = Date.parse(right.run.observation?.observedAt ?? "") - Date.parse(left.run.observation?.observedAt ?? "");
  if (observed !== 0) return observed;
  const updated = Date.parse(right.run.updatedAt) - Date.parse(left.run.updatedAt);
  return updated !== 0 ? updated : right.run.id.localeCompare(left.run.id);
}

function postsFor(entry: DiscussionEntry) {
  return (entry.run.observation?.posts ?? []).filter((post) => post.discussionRef === entry.discussion.ref);
}

function isHumanReply(post: { parentRef: string | null; role: string; actorAlias: string }): boolean {
  return post.parentRef !== null && HUMAN_ROLES.has(post.role) && post.actorAlias !== "AGENT";
}

function classifyEntry(entry: DiscussionEntry): Omit<BrowserDiscussionSummary, "identityKey" | "identityBasis" | "longitudinalMerge" | "discussionRef" | "url" | "title" | "observedAt" | "runId"> {
  const posts = postsFor(entry);
  const root = posts.find((post) => post.parentRef === null);
  const humanReplies = posts.filter(isHumanReply);
  const peerReplies = root ? humanReplies.filter((post) => post.actorAlias !== root.actorAlias) : [];
  const authorReturns = root ? humanReplies.filter((post) => post.actorAlias === root.actorAlias) : [];
  const completeStructure = !!root && posts.every((post) => post.createdAt !== null && post.role !== "unknown");
  const structuralResponse: BrowserCourseSummaryResponse = humanReplies.length > 0
    ? "present" : entry.discussion.complete && completeStructure ? "absent" : "unknown";
  const continuation = entry.discussion.continuation;
  const continuationFunction: BrowserCourseSummaryFunction = !continuation || continuation.kind === "unknown"
    ? "unknown" : continuation.kind === "acknowledgement" ? "courtesy" : SUBSTANTIVE_KINDS.has(continuation.kind) ? "substantive" : "unknown";
  const peerReplyRefs = new Set(peerReplies.map((post) => post.ref));
  const peerContinuation: "true" | "false" | "unknown" = continuation
    ? continuation.kind === "unknown" ? "unknown"
      : !SUBSTANTIVE_KINDS.has(continuation.kind) ? "false"
        : continuation.evidenceRefs.some((ref) => peerReplyRefs.has(ref)) ? "true" : "false"
    : structuralResponse === "absent" && entry.discussion.complete ? "false" : "unknown";
  const followup: BrowserCourseSummaryFollowup = continuation?.followup ?? "unknown";
  const decision = entry.run.proposals.find((proposal) => proposal.discussionRef === entry.discussion.ref)?.decision ?? null;
  const evidenceRefs = continuation?.evidenceRefs.length ? [...continuation.evidenceRefs] : [...new Set(humanReplies.map((post) => post.ref))];
  const nextSteps: string[] = [];
  if (followup === "needed") nextSteps.push("follow_up_needed");
  if (followup === "unknown") nextSteps.push("interpret_or_reobserve");
  if (decision === "DRAFT") nextSteps.push("review_draft_before_any_external_action");
  if (decision === "WAIT") nextSteps.push("observe_again_when_window_allows");
  if (decision === "YIELD") nextSteps.push("preserve_human_turn_and_review_function");
  if (decision === "ABSTAIN") nextSteps.push("repair_observation_scope");
  return {
    structuralResponse,
    continuationFunction,
    continuationKind: continuation?.kind ?? null,
    followup,
    peerContinuation,
    peerReplyRefs: peerReplies.map((post) => post.ref),
    authorReturnRefs: authorReturns.map((post) => post.ref),
    evidenceRefs,
    decision,
    legacyStructuralOnly: !continuation && peerReplies.length > 0,
    interpretationSource: continuation ? "browser_interpretation" : "unknown",
    nextSteps
  };
}

/**
 * Build a Bot-facing summary from the private Browser workspace. It selects
 * the latest observation for each stable discussion identity, so repeated
 * patrols update one item instead of inflating response and decision counts.
 */
export function buildCourseSummary(workspace: BrowserWorkspaceSnapshot, courseId?: string): BrowserCourseSummary {
  const courses = workspace.courses.filter((course) => courseId === undefined || course.id === courseId);
  const courseIds = courses.map((course) => course.id);
  const runs = workspace.runs.filter((run) => courseIds.includes(run.courseId));
  const observedRuns = runs.filter((run) => run.observation !== null);
  const observations = observedRuns.map((run) => ({
    runId: run.id,
    observedAt: run.observation!.observedAt,
    scope: run.observation!.scope,
    complete: run.observation!.complete,
    discussions: run.observation!.discussions.length,
    posts: run.observation!.posts.length
  })).sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
  const latestByIdentity = new Map<string, DiscussionEntry>();
  for (const run of observedRuns) {
    const course = courses.find((item) => item.id === run.courseId);
    for (const discussion of run.observation!.discussions) {
      const identity = getBrowserDiscussionIdentity(run.observation!, discussion);
      const entry: DiscussionEntry = { run, course, discussion };
      const identityKey = identity.basis === "observation_local"
        ? `course:${run.courseId}:run:${run.id}:${identity.key}`
        : `course:${run.courseId}:${identity.key}`;
      const prior = latestByIdentity.get(identityKey);
      if (!prior || latestFirst(entry, prior) < 0) latestByIdentity.set(identityKey, entry);
    }
  }
  const allDiscussions = [...latestByIdentity.entries()].map(([identityKey, entry]) => {
    const identity = getBrowserDiscussionIdentity(entry.run.observation!, entry.discussion);
    const classified = classifyEntry(entry);
    return { identityKey, identityBasis: identity.basis, longitudinalMerge: identity.longitudinalMerge,
      discussionRef: entry.discussion.ref, url: entry.discussion.url, title: entry.discussion.title,
      observedAt: entry.run.observation!.observedAt, runId: entry.run.id, ...classified } satisfies BrowserDiscussionSummary;
  }).sort((left, right) => left.identityKey.localeCompare(right.identityKey));
  const discussions = [...allDiscussions].sort((left, right) => {
    const followupRank = (value: BrowserCourseSummaryFollowup) => value === "needed" ? 0 : value === "unknown" ? 1 : 2;
    return followupRank(left.followup) - followupRank(right.followup) || right.observedAt.localeCompare(left.observedAt) || left.identityKey.localeCompare(right.identityKey);
  }).slice(0, 20);
  const structuralResponses = { present: 0, absent: 0, unknown: 0, total: allDiscussions.length };
  const continuationFunctions = { courtesy: 0, substantive: 0, unknown: 0, total: allDiscussions.length };
  const followup = { needed: 0, unknown: 0, not_needed: 0, total: allDiscussions.length };
  const decisions = { DRAFT: 0, WAIT: 0, YIELD: 0, ABSTAIN: 0, unset: 0 };
  for (const discussion of allDiscussions) {
    structuralResponses[discussion.structuralResponse] += 1;
    continuationFunctions[discussion.continuationFunction] += 1;
    followup[discussion.followup === "not_needed" ? "not_needed" : discussion.followup] += 1;
    if (discussion.decision) decisions[discussion.decision] += 1;
    else decisions.unset += 1;
  }
  const allNextSteps = allDiscussions.flatMap((discussion) => discussion.nextSteps.map((action) => ({
    identityKey: discussion.identityKey,
    action,
    evidenceRefs: [...discussion.evidenceRefs]
  })));
  const nextSteps = allNextSteps.slice(0, 20);
  const latestIdentityPosts = [...latestByIdentity.values()].reduce((sum, entry) => sum + postsFor(entry).length, 0);
  const latestRun = [...runs].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  const healthCourseId = latestRun?.courseId ?? courseId ?? (courses.length === 1 ? courses[0]!.id : undefined);
  const latestHealth = (healthCourseId ? workspace.connectionHealth?.find((health) => health.courseId === healthCourseId) : undefined) ?? null;
  const latestRuntimeRun = latestRun ? {
    id: latestRun.id, status: latestRun.status, authState: latestRun.authState ?? "unknown",
    queueState: latestRun.dispatch?.state ?? null, phase: latestRun.phase ?? null,
    updatedAt: latestRun.updatedAt, summary: latestRun.summary
  } : null;
  const nextAction = latestRuntimeRun?.authState === "relogin_required" || latestHealth?.authState === "relogin_required"
    ? "relogin_required"
    : latestRuntimeRun?.status === "needs_attention" || latestRuntimeRun?.status === "interrupted"
      ? "resume_or_review"
      : latestRuntimeRun?.status === "running"
        ? "continue_current_run"
        : latestRuntimeRun?.status === "queued" || latestHealth?.queueState
          ? "wait_for_dispatch"
          : latestRuntimeRun?.status === "completed"
            ? "start_next_patrol"
            : "inspect_workspace";
  return {
    schemaVersion: "browser-course-summary.v1",
    courseId: courseId ?? (courses.length === 1 ? courses[0]!.id : null),
    courseTitle: courses.length === 1 ? courses[0]!.title : null,
    observationScope: {
      courseIds,
      runCount: runs.length,
      observedRunCount: observedRuns.length,
      latestObservedAt: observations[0]?.observedAt ?? null,
      latestScope: observations[0]?.scope ?? null,
      completeRuns: observations.filter((observation) => observation.complete).length,
      partialRuns: observations.filter((observation) => !observation.complete).length,
      discussionsObserved: allDiscussions.length,
      postsObserved: latestIdentityPosts,
      observations: observations.slice(0, 10),
      observationsTotal: observations.length,
      observationsTruncated: observations.length > 10
    },
    structuralResponses,
    continuationFunctions,
    followup,
    decisions,
    runtime: {
      latestRun: latestRuntimeRun,
      connectionHealth: latestHealth ? {
        courseId: latestHealth.courseId, status: latestHealth.status, authState: latestHealth.authState,
        queueState: latestHealth.queueState, pendingWatches: latestHealth.pendingWatches,
        lastPatrolAt: latestHealth.lastPatrolAt, lastPeerResponseAt: latestHealth.lastPeerResponseAt
      } : null,
      nextAction
    },
    details: { items: discussions, total: allDiscussions.length, truncated: allDiscussions.length > discussions.length },
    discussions,
    nextSteps,
    nextStepsTotal: allNextSteps.length,
    nextStepsTruncated: allNextSteps.length > nextSteps.length
  };
}
