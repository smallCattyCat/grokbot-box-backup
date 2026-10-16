import { prisma as defaultPrisma } from "@/lib/db";
import { parseSafeCoverageSummary } from "@/lib/autonomy/read-model";
import type { AutonomyCandidate } from "@/lib/autonomy/candidate-set";
import { canonicalProtocolHash } from "@/lib/facilitation-protocol";
import { buildEvidenceWaterfall } from "@/lib/workbench/course-evidence-workspace";
import {
  readAnchoredContentGraphIntegrity,
  readPersistedDecisionQualification,
  readValidatedCandidateSet,
  verifyCoverageReceipt,
  type ContentGraphIntegrityResult
} from "@/lib/workbench/evidence-read-model";
import {
  resolveCourseContext,
  type ExactCourseAnchorInput,
  type ResolvedCourseContext
} from "./course-context";

export const OPPORTUNITY_EVIDENCE_TOOL_SCHEMA_VERSION =
  "cmooc.course-tool.opportunity-evidence.v1" as const;
export const MATURE_SUPPORT_GAP_HOURS = 72;

export type OpportunityClaimKind =
  | "mature_support_gap"
  | "content_graph_structure";

export type OpportunityEvidenceStatus =
  | "eligible"
  | "not_a_support_gap"
  | "evidence_unavailable"
  | "policy_no_safe_action";

export type OpportunityPredicate = {
  code:
    | "candidate_target_bound"
    | "target_state_hash_valid"
    | "target_complete"
    | "support_gap_mature"
    | "no_external_human_response"
    | "no_distinct_actor_response"
    | "no_author_return"
    | "no_system_response";
  status: "passed" | "failed" | "unknown";
  safeValue: string | number | boolean | null;
};

export type SupportGapOpportunityEvidence = {
  schemaVersion: typeof OPPORTUNITY_EVIDENCE_TOOL_SCHEMA_VERSION;
  opportunityId: string;
  kind: "support_gap";
  candidateKey: string;
  exactAnchor: ResolvedCourseContext["anchor"];
  claim: {
    kind: OpportunityClaimKind;
    contentGraphRequired: boolean;
  };
  target: {
    targetVersionHash: string;
    stateHash: string | null;
    supportGapHours: number | null;
    predicates: OpportunityPredicate[];
  };
  qualification: {
    status: "qualified" | "stopped" | "unknown";
    decisionRef: string | null;
    opportunityReceiptHash: string | null;
    waterfall: ReturnType<typeof buildEvidenceWaterfall>;
  };
  graphIntegrity: ContentGraphIntegrityResult & {
    requiredForClaim: boolean;
  };
  policy: {
    decision: "draft" | "wait" | "abstain" | "yield" | "unknown";
    reasonCodes: string[];
  };
  integrity: {
    candidateSet: "verified";
    targetProjection: "verified" | "failed" | "unavailable";
    qualification: "verified" | "failed" | "unavailable";
  };
  status: OpportunityEvidenceStatus;
  limitations: string[];
  evidenceRefs: Array<{
    kind:
      | "manifest"
      | "invocation"
      | "snapshot"
      | "coverage"
      | "candidate"
      | "target_projection"
      | "qualification"
      | "content_graph";
    id: string;
    hash: string;
    observedAt: string;
  }>;
  containsForumText: false;
  containsIdentity: false;
};

export type OpportunityListOutcome =
  | "opportunities_available"
  | "no_action"
  | "evidence_unavailable"
  | "policy_no_safe_action";

export type OpportunityListResult = {
  schemaVersion: "cmooc.course-tool.opportunity-list.v1";
  status: "ready";
  outcome: OpportunityListOutcome;
  exactAnchor: ResolvedCourseContext["anchor"];
  sourceCompleteness: {
    coverageReceiptVerified: boolean;
    courseCoverageComplete: boolean;
    candidateSetVerified: true;
    allCandidateTargetsAccountedFor: boolean;
  };
  totalCandidateCount: number;
  items: SupportGapOpportunityEvidence[];
  limitations: string[];
  containsForumText: false;
  containsIdentity: false;
};

export type SupportGapSelection =
  | {
      status: "selected";
      selected: SupportGapOpportunityEvidence;
      reasonCode: "mature_support_gap_highest_age_then_candidate_key";
      exclusions: Array<{ opportunityId: string; status: OpportunityEvidenceStatus }>;
    }
  | {
      status: "no_action" | "evidence_unavailable" | "policy_no_safe_action";
      selected: null;
      reasonCode: string;
      exclusions: Array<{ opportunityId: string; status: OpportunityEvidenceStatus }>;
    };

export class OpportunityEvidenceToolError extends Error {
  constructor(
    readonly code:
      | "OPPORTUNITY_EVIDENCE_NOT_FOUND"
      | "OPPORTUNITY_EVIDENCE_CONFLICT",
    message: string
  ) {
    super(message);
    this.name = "OpportunityEvidenceToolError";
  }
}

type ThreadProjection = {
  threadKey: string;
  rootEventKey: string;
  authorKey: string | null;
  firstEventAt: Date;
  latestEventAt: Date;
  eventCount: number;
  externalHumanCount: number;
  distinctActorResponseCount: number;
  authorReturnCount: number;
  systemResponseCount: number;
  maxDepth: number;
  completeness: string;
  supportGapHours: number;
  stateHash: string;
};

type DecisionProjection = {
  id: string;
  invocationId: string;
  courseAlias: string;
  threadKey: string;
  decision: string;
  decisionMode: string;
  reasonCode: string;
  opportunityReceiptHash: string;
  worldHash: string;
  candidateSetHash: string;
  evidenceAsOf: Date;
  decisionJson: string;
};

function safeDecision(value: string | undefined): SupportGapOpportunityEvidence["policy"]["decision"] {
  return value === "draft" ||
    value === "wait" ||
    value === "abstain" ||
    value === "yield"
    ? value
    : "unknown";
}

function verifyThreadState(row: ThreadProjection): boolean {
  return (
    canonicalProtocolHash(
      "cmooc.thread-state-at-cutoff.v2",
      {
        threadKey: row.threadKey,
        rootEventKey: row.rootEventKey,
        authorKey: row.authorKey,
        firstEventAt: row.firstEventAt.toISOString(),
        latestEventAt: row.latestEventAt.toISOString(),
        eventCount: row.eventCount,
        externalHumanCount: row.externalHumanCount,
        distinctActorResponseCount: row.distinctActorResponseCount,
        authorReturnCount: row.authorReturnCount,
        systemResponseCount: row.systemResponseCount,
        maxDepth: row.maxDepth,
        completeness: row.completeness,
        supportGapHours: row.supportGapHours
      }
    ) === row.stateHash
  );
}

function candidateMatchesThread(
  candidate: AutonomyCandidate,
  thread: ThreadProjection
): boolean {
  return (
    candidate.threadKey === thread.threadKey &&
    candidate.rootEventKey === thread.rootEventKey &&
    candidate.authorKey === thread.authorKey &&
    candidate.contributionPublishedAt === thread.firstEventAt.toISOString() &&
    candidate.latestEventAt === thread.latestEventAt.toISOString() &&
    candidate.eventCount === thread.eventCount &&
    candidate.externalHumanCount === thread.externalHumanCount &&
    candidate.authorReturnCount === thread.authorReturnCount &&
    candidate.systemResponseCount === thread.systemResponseCount &&
    candidate.supportGapHours === thread.supportGapHours &&
    candidate.completeness === thread.completeness &&
    Boolean(candidate.targetVersionHash) &&
    Boolean(candidate.sourceObservationReceiptHash)
  );
}

function predicate(
  code: OpportunityPredicate["code"],
  condition: boolean | null,
  safeValue: OpportunityPredicate["safeValue"]
): OpportunityPredicate {
  return {
    code,
    status: condition === null ? "unknown" : condition ? "passed" : "failed",
    safeValue
  };
}

function targetPredicates(input: {
  candidate: AutonomyCandidate;
  thread: ThreadProjection | null;
}): OpportunityPredicate[] {
  const row = input.thread;
  if (!row) {
    return [
      predicate("candidate_target_bound", null, null),
      predicate("target_state_hash_valid", null, null),
      predicate("target_complete", null, null),
      predicate("support_gap_mature", null, null),
      predicate("no_external_human_response", null, null),
      predicate("no_distinct_actor_response", null, null),
      predicate("no_author_return", null, null),
      predicate("no_system_response", null, null)
    ];
  }
  return [
    predicate(
      "candidate_target_bound",
      candidateMatchesThread(input.candidate, row),
      candidateMatchesThread(input.candidate, row)
    ),
    predicate("target_state_hash_valid", verifyThreadState(row), verifyThreadState(row)),
    predicate("target_complete", row.completeness === "complete", row.completeness),
    predicate(
      "support_gap_mature",
      row.supportGapHours >= MATURE_SUPPORT_GAP_HOURS,
      row.supportGapHours
    ),
    predicate(
      "no_external_human_response",
      row.externalHumanCount === 0,
      row.externalHumanCount
    ),
    predicate(
      "no_distinct_actor_response",
      row.distinctActorResponseCount === 0,
      row.distinctActorResponseCount
    ),
    predicate("no_author_return", row.authorReturnCount === 0, row.authorReturnCount),
    predicate("no_system_response", row.systemResponseCount === 0, row.systemResponseCount)
  ];
}

function decisionMatchesCandidate(
  decision: DecisionProjection,
  candidate: AutonomyCandidate,
  context: ResolvedCourseContext
): boolean {
  if (
    decision.invocationId !== context.anchor.invocationId ||
    decision.courseAlias !== context.anchor.courseAlias ||
    decision.threadKey !== candidate.threadKey ||
    decision.worldHash !== context.anchor.worldHash ||
    decision.candidateSetHash !== context.anchor.candidateSetHash ||
    !decision.opportunityReceiptHash
  ) {
    return false;
  }
  try {
    const summary = JSON.parse(decision.decisionJson) as Record<string, unknown>;
    return (
      summary.candidateKey === candidate.candidateKey &&
      summary.decision === decision.decision &&
      summary.opportunityReceiptHash === decision.opportunityReceiptHash
    );
  } catch {
    return false;
  }
}

export function verifyOpportunityIntegrity(input: {
  evidence: Omit<SupportGapOpportunityEvidence, "status" | "limitations">;
}): { status: OpportunityEvidenceStatus; limitations: string[] } {
  const evidence = input.evidence;
  const unknownTarget = evidence.target.predicates.some(
    (item) => item.status === "unknown"
  );
  const failedTarget = evidence.target.predicates.some(
    (item) => item.status === "failed"
  );
  if (
    unknownTarget ||
    evidence.integrity.targetProjection !== "verified"
  ) {
    return {
      status: "evidence_unavailable",
      limitations: [
        "The exact target or required qualification evidence is unavailable or failed integrity checks."
      ]
    };
  }
  if (failedTarget) {
    return {
      status: "not_a_support_gap",
      limitations: [
        "The exact target does not satisfy every mature support-gap predicate at this cutoff."
      ]
    };
  }
  if (
    evidence.integrity.qualification !== "verified" ||
    evidence.qualification.status !== "qualified" ||
    (evidence.claim.contentGraphRequired &&
      evidence.graphIntegrity.status !== "verified")
  ) {
    return {
      status: "evidence_unavailable",
      limitations: [
        "The qualification or claim-specific Content Graph evidence is unavailable or failed integrity checks."
      ]
    };
  }
  if (
    evidence.policy.decision !== "draft" ||
    evidence.policy.reasonCodes.length > 0
  ) {
    return {
      status: "policy_no_safe_action",
      limitations: [
        "Evidence is sufficient for the target claim, but the anchored policy state permits no safe action."
      ]
    };
  }
  return { status: "eligible", limitations: [] };
}

async function loadOpportunitySet(input: {
  context: ResolvedCourseContext;
  claim: OpportunityClaimKind;
  prisma: typeof defaultPrisma;
}): Promise<{
  evidence: SupportGapOpportunityEvidence[];
  coverageReceiptVerified: boolean;
  courseCoverageComplete: boolean;
  allCandidateTargetsAccountedFor: boolean;
  snapshotThreadCount: number;
}> {
  const { context, prisma: db } = input;
  const [snapshot, scan, candidateRow, threads, decisions, incidents, invocation] =
    await Promise.all([
      db.courseWorldSnapshot.findUnique({
        where: { id: context.anchor.snapshotId },
        select: { id: true, threadCount: true, asOfAt: true }
      }),
      db.courseScanRun.findUnique({
        where: { invocationId: context.anchor.invocationId },
        select: {
          id: true,
          coverageJson: true,
          coverageHash: true,
          observedEventCount: true,
          failedTargetCount: true
        }
      }),
      db.candidateSet.findUnique({
        where: { invocationId: context.anchor.invocationId },
        select: {
          snapshotId: true,
          candidateSetHash: true,
          candidateCount: true,
          candidatesJson: true,
          asOfAt: true
        }
      }),
      db.threadStateAtCutoff.findMany({
        where: { snapshotId: context.anchor.snapshotId },
        select: {
          threadKey: true,
          rootEventKey: true,
          authorKey: true,
          firstEventAt: true,
          latestEventAt: true,
          eventCount: true,
          externalHumanCount: true,
          distinctActorResponseCount: true,
          authorReturnCount: true,
          systemResponseCount: true,
          maxDepth: true,
          completeness: true,
          supportGapHours: true,
          stateHash: true
        },
        orderBy: { threadKey: "asc" }
      }),
      db.autonomyDecision.findMany({
        where: { invocationId: context.anchor.invocationId },
        orderBy: [{ evidenceAsOf: "desc" }, { id: "asc" }],
        select: {
          id: true,
          invocationId: true,
          courseAlias: true,
          threadKey: true,
          decision: true,
          decisionMode: true,
          reasonCode: true,
          opportunityReceiptHash: true,
          worldHash: true,
          candidateSetHash: true,
          evidenceAsOf: true,
          decisionJson: true
        }
      }),
      db.autonomyIncident.findMany({
        where: {
          invocationId: context.anchor.invocationId,
          status: { in: ["open", "acknowledged"] }
        },
        select: { targetKey: true, code: true }
      }),
      db.scheduledInvocation.findUnique({
        where: { id: context.anchor.invocationId },
        select: {
          id: true,
          status: true,
          governancePolicyId: true,
          governanceHash: true
        }
      })
    ]);
  if (!snapshot || !scan || !candidateRow || !invocation) {
    throw new OpportunityEvidenceToolError(
      "OPPORTUNITY_EVIDENCE_NOT_FOUND",
      "The exact opportunity evidence chain is incomplete."
    );
  }
  const candidateIntegrity = readValidatedCandidateSet({
    json: candidateRow.candidatesJson,
    hash: candidateRow.candidateSetHash,
    courseAlias: context.anchor.courseAlias,
    worldHash: context.anchor.worldHash,
    eventSetHash: context.anchor.eventSetHash,
    asOfAt: new Date(context.anchor.worldAsOf)
  });
  if (
    snapshot.id !== context.anchor.snapshotId ||
    snapshot.asOfAt.toISOString() !== context.anchor.worldAsOf ||
    candidateRow.snapshotId !== context.anchor.snapshotId ||
    candidateRow.candidateSetHash !== context.anchor.candidateSetHash ||
    candidateRow.asOfAt.toISOString() !== context.anchor.worldAsOf ||
    !candidateIntegrity.valid ||
    !candidateIntegrity.candidateSet ||
    candidateRow.candidateCount !== candidateIntegrity.count
  ) {
    throw new OpportunityEvidenceToolError(
      "OPPORTUNITY_EVIDENCE_CONFLICT",
      "Candidate evidence conflicts with the exact course anchor."
    );
  }
  const coverage = parseSafeCoverageSummary(scan.coverageJson);
  const coverageReceiptVerified =
    scan.coverageHash === context.anchor.coverageHash &&
    verifyCoverageReceipt({
      json: scan.coverageJson,
      hash: scan.coverageHash ?? "",
      observedEventCount: scan.observedEventCount,
      failedTargetCount: scan.failedTargetCount
    });
  const threadByKey = new Map(
    (threads as ThreadProjection[]).map((thread) => [thread.threadKey, thread])
  );
  const decisionByThread = new Map<string, DecisionProjection>();
  for (const decision of decisions as DecisionProjection[]) {
    if (!decisionByThread.has(decision.threadKey)) {
      decisionByThread.set(decision.threadKey, decision);
    }
  }
  const graphRequired = input.claim === "content_graph_structure";
  const graphIntegrity = graphRequired
    ? await readAnchoredContentGraphIntegrity({
        prisma: db,
        anchor: {
          snapshotId: context.anchor.snapshotId,
          courseAlias: context.anchor.courseAlias,
          worldHash: context.anchor.worldHash,
          coverageHash: context.anchor.coverageHash,
          asOfAt: new Date(context.anchor.worldAsOf)
        }
      })
    : ({
        status: "unavailable",
        reasonCode: "content_graph_missing",
        contentGraphHash: null,
        nodeSetHash: null,
        edgeSetHash: null,
        nodeCount: null,
        edgeCount: null,
        learnerNodeCount: null
      } satisfies ContentGraphIntegrityResult);

  let governanceBlocked = false;
  if (invocation.governancePolicyId) {
    const governance = await db.courseOperationGovernancePolicy.findUnique({
      where: { id: invocation.governancePolicyId },
      select: {
        governanceHash: true,
        status: true,
        mode: true,
        emergencyHalt: true
      }
    });
    governanceBlocked = Boolean(
      !governance ||
        governance.governanceHash !== invocation.governanceHash ||
        governance.status !== "active" ||
        governance.mode === "HALTED" ||
        governance.emergencyHalt
    );
  }

  const evidence = candidateIntegrity.candidateSet.candidates.map((candidate) => {
    const thread = threadByKey.get(candidate.threadKey) ?? null;
    const predicates = targetPredicates({ candidate, thread });
    const decision = decisionByThread.get(candidate.threadKey);
    const decisionBound = Boolean(
      decision && decisionMatchesCandidate(decision, candidate, context)
    );
    const qualificationInput =
      decision && decisionBound
        ? readPersistedDecisionQualification({
            id: decision.id,
            decision: decision.decision,
            opportunityReceiptHash: decision.opportunityReceiptHash,
            decisionJson: decision.decisionJson
          })
        : null;
    const waterfall = buildEvidenceWaterfall(qualificationInput);
    const qualificationStatus =
      qualificationInput === null
        ? "unknown"
        : waterfall.status === "qualified"
          ? "qualified"
          : "stopped";
    const targetIntegrity = !thread
      ? "unavailable"
      : predicates[0]?.status === "passed" && predicates[1]?.status === "passed"
        ? "verified"
        : "failed";
    const policyReasonCodes: string[] = [];
    if (decisionBound && decision && decision.decision !== "draft") {
      policyReasonCodes.push(decision.reasonCode || "anchored_decision_no_action");
    }
    if (
      incidents.some(
        (incident) =>
          incident.targetKey === null || incident.targetKey === candidate.threadKey
      )
    ) {
      policyReasonCodes.push("active_incident");
    }
    if (governanceBlocked) policyReasonCodes.push("governance_no_safe_action");
    if (invocation.status === "failed") {
      policyReasonCodes.push("anchored_invocation_failed");
    }
    const base = {
      schemaVersion: OPPORTUNITY_EVIDENCE_TOOL_SCHEMA_VERSION,
      opportunityId: `support-gap:${candidate.candidateKey}`,
      kind: "support_gap" as const,
      candidateKey: candidate.candidateKey,
      exactAnchor: context.anchor,
      claim: {
        kind: input.claim,
        contentGraphRequired: graphRequired
      },
      target: {
        targetVersionHash: candidate.targetVersionHash,
        stateHash: thread?.stateHash ?? null,
        supportGapHours: thread?.supportGapHours ?? null,
        predicates
      },
      qualification: {
        status: qualificationStatus as "qualified" | "stopped" | "unknown",
        decisionRef: decisionBound && decision ? `decision:${decision.id}` : null,
        opportunityReceiptHash:
          decisionBound && decision ? decision.opportunityReceiptHash : null,
        waterfall
      },
      graphIntegrity: {
        ...graphIntegrity,
        requiredForClaim: graphRequired
      },
      policy: {
        decision: decisionBound ? safeDecision(decision?.decision) : "unknown" as const,
        reasonCodes: [...new Set(policyReasonCodes)]
      },
      integrity: {
        candidateSet: "verified" as const,
        targetProjection: targetIntegrity as "verified" | "failed" | "unavailable",
        qualification:
          qualificationInput === null
            ? ("unavailable" as const)
            : waterfall.status === "qualified"
              ? ("verified" as const)
              : ("failed" as const)
      },
      evidenceRefs: [
        ...context.evidenceRefs,
        ...(thread
          ? [
              {
                kind: "target_projection" as const,
                id: candidate.candidateKey,
                hash: thread.stateHash,
                observedAt: context.anchor.worldAsOf
              }
            ]
          : []),
        ...(decisionBound && decision
          ? [
              {
                kind: "qualification" as const,
                id: `decision:${decision.id}`,
                hash: decision.opportunityReceiptHash,
                observedAt: decision.evidenceAsOf.toISOString()
              }
            ]
          : []),
        ...(graphRequired && graphIntegrity.contentGraphHash
          ? [
              {
                kind: "content_graph" as const,
                id: context.anchor.snapshotId,
                hash: graphIntegrity.contentGraphHash,
                observedAt: context.anchor.worldAsOf
              }
            ]
          : [])
      ],
      containsForumText: false as const,
      containsIdentity: false as const
    };
    const verdict = verifyOpportunityIntegrity({ evidence: base });
    return { ...base, ...verdict };
  });
  return {
    evidence,
    coverageReceiptVerified,
    courseCoverageComplete: Boolean(
      coverageReceiptVerified && coverage?.complete && scan.failedTargetCount === 0
    ),
    allCandidateTargetsAccountedFor:
      candidateIntegrity.count === threads.length &&
      threads.length === snapshot.threadCount,
    snapshotThreadCount: snapshot.threadCount
  };
}

export async function listOpportunities(input: {
  context?: ResolvedCourseContext;
  anchor?: ExactCourseAnchorInput;
  prisma?: typeof defaultPrisma;
}): Promise<OpportunityListResult> {
  const db = input.prisma ?? defaultPrisma;
  const context =
    input.context ??
    (await resolveCourseContext({ anchor: input.anchor, prisma: db }));
  const loaded = await loadOpportunitySet({
    context,
    claim: "mature_support_gap",
    prisma: db
  });
  const ranked = [...loaded.evidence].sort(
    (left, right) =>
      (right.target.supportGapHours ?? -1) - (left.target.supportGapHours ?? -1) ||
      left.candidateKey.localeCompare(right.candidateKey)
  );
  const eligible = ranked.filter((item) => item.status === "eligible");
  const unavailable = ranked.filter(
    (item) => item.status === "evidence_unavailable"
  );
  const policyBlocked = ranked.filter(
    (item) => item.status === "policy_no_safe_action"
  );
  const noActionSourcesComplete =
    loaded.coverageReceiptVerified &&
    loaded.courseCoverageComplete &&
    loaded.allCandidateTargetsAccountedFor;
  const outcome: OpportunityListOutcome =
    eligible.length > 0
      ? "opportunities_available"
      : unavailable.length > 0 || !noActionSourcesComplete
        ? "evidence_unavailable"
        : policyBlocked.length > 0
          ? "policy_no_safe_action"
          : "no_action";
  return {
    schemaVersion: "cmooc.course-tool.opportunity-list.v1",
    status: "ready",
    outcome,
    exactAnchor: context.anchor,
    sourceCompleteness: {
      coverageReceiptVerified: loaded.coverageReceiptVerified,
      courseCoverageComplete: loaded.courseCoverageComplete,
      candidateSetVerified: true,
      allCandidateTargetsAccountedFor: loaded.allCandidateTargetsAccountedFor
    },
    totalCandidateCount: ranked.length,
    items: ranked
      .filter((item) => item.status !== "not_a_support_gap")
      .slice(0, 5),
    limitations:
      outcome === "no_action"
        ? ["All exact sources were checked; no mature support-gap target exists at this cutoff."]
        : outcome === "evidence_unavailable"
          ? ["At least one candidate or required source is unavailable; this is not no_action."]
          : outcome === "policy_no_safe_action"
            ? ["Evidence is available, but the anchored policy state permits no safe action."]
            : [],
    containsForumText: false,
    containsIdentity: false
  };
}

export async function readOpportunityEvidence(input: {
  opportunityId: string;
  claim?: OpportunityClaimKind;
  context?: ResolvedCourseContext;
  anchor?: ExactCourseAnchorInput;
  prisma?: typeof defaultPrisma;
}): Promise<SupportGapOpportunityEvidence> {
  const db = input.prisma ?? defaultPrisma;
  const context =
    input.context ??
    (await resolveCourseContext({ anchor: input.anchor, prisma: db }));
  const loaded = await loadOpportunitySet({
    context,
    claim: input.claim ?? "mature_support_gap",
    prisma: db
  });
  const evidence = loaded.evidence.find(
    (item) => item.opportunityId === input.opportunityId
  );
  if (!evidence) {
    throw new OpportunityEvidenceToolError(
      "OPPORTUNITY_EVIDENCE_NOT_FOUND",
      "Opportunity is not part of the exact candidate set."
    );
  }
  return evidence;
}

export function selectSupportGap(
  input: OpportunityListResult
): SupportGapSelection {
  const selected = [...input.items]
    .filter((item) => item.status === "eligible")
    .sort(
      (left, right) =>
        (right.target.supportGapHours ?? -1) -
          (left.target.supportGapHours ?? -1) ||
        left.candidateKey.localeCompare(right.candidateKey)
    )[0];
  const exclusions = input.items
    .filter((item) => item.opportunityId !== selected?.opportunityId)
    .map((item) => ({
      opportunityId: item.opportunityId,
      status: item.status
    }));
  if (selected) {
    return {
      status: "selected",
      selected,
      reasonCode: "mature_support_gap_highest_age_then_candidate_key",
      exclusions
    };
  }
  return {
    status: input.outcome === "opportunities_available"
      ? "evidence_unavailable"
      : input.outcome,
    selected: null,
    reasonCode:
      input.outcome === "no_action"
        ? "all_sources_checked_no_mature_support_gap"
        : input.outcome === "policy_no_safe_action"
          ? "qualified_candidates_blocked_by_policy"
          : "candidate_evidence_unknown_or_unavailable",
    exclusions
  };
}
