import type { PrismaClient } from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import type {
  LiveOpportunityAssessment,
  TrustedSchedulingHistoryAttestation,
  TrustedSemanticEvidenceAttestation
} from "@/lib/live-runtime/facilitation-kernel";
import type { LiveUiObservationReceipt } from "@/lib/ui-agent/live-observation";
import type { CourseManifest } from "./course-manifest";
import type { AutonomyCandidate } from "./candidate-set";
import { readBudgetUsage } from "./budget-reservation";
import {
  computeCourseRoleEvidenceMac,
  verifyCourseRoleEvidenceMac
} from "./role-attestation";
import type {
  AutonomySemanticEvidenceReceipt
} from "./transient-semantic-evidence";

export const SERVER_EVIDENCE_BUNDLE_SCHEMA_VERSION =
  "cmooc.server-evidence-bundle.v2" as const;

export type ServerRoleEvidence = {
  status: "verified" | "unknown";
  role: "learner" | "creator" | "helper" | "unknown";
  basis:
    | "trusted_course_role_attestation"
    | "role_registry_unavailable";
  evidenceHash: string;
};

export type ServerEvidenceBundle = {
  schemaVersion: typeof SERVER_EVIDENCE_BUNDLE_SCHEMA_VERSION;
  observationReceiptHash: string;
  courseKey: string;
  threadKey: string;
  authorKey: string | null;
  issuedAt: string;
  expiresAt: string;
  role: ServerRoleEvidence;
  historyReceiptHash: string;
  historyCutoffHash: string;
  longitudinalHistoryStatus:
    | "sufficient"
    | "insufficient"
    | "unknown";
  candidateUniverse: "recent" | "support_gap" | "full_history";
  semanticEvidenceHash: string | null;
  semanticEvidenceStatus: "supported" | "insufficient" | "unavailable";
  targetReason:
    | "mature_unreplied_root"
    | "stalled_existing_thread";
  communityProcessGoal:
    | "continue_existing_discussion"
    | "support_relational_bridge"
    | "broaden_participation"
    | null;
  authorTouchCount30d: number | null;
  lastSystemTouchAt: string | null;
  budget: {
    availableSlots: number;
    workloadCost: number;
    authorTouchLimit30d: number;
  };
  containsForumText: false;
};

function shanghaiDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(value);
}

export function computeBoundRoleEvidenceHash(input: {
  secret: Buffer | string;
  courseKey: string;
  threadKey: string;
  authorKey: string;
  role: "learner" | "creator" | "helper";
  evidenceAsOf: string;
  expiresAt: string;
  targetVersionHash: string;
}): string {
  return computeCourseRoleEvidenceMac(input);
}

export function resolveServerRoleEvidence(input: {
  observation: LiveUiObservationReceipt;
  candidate: AutonomyCandidate;
  assessedAt: string;
  secret: Buffer | string;
}): ServerRoleEvidence {
  const observation = input.observation;
  const role = observation.authorRole;
  const expiresAt = observation.authorRoleEvidenceExpiresAt;
  const evidenceHash = observation.authorRoleEvidenceHash;
  if (
    role !== "unknown" &&
    input.candidate.authorKey !== null &&
    observation.authorKey === input.candidate.authorKey &&
    typeof evidenceHash === "string" &&
    /^[a-f0-9]{64}$/i.test(evidenceHash) &&
    typeof expiresAt === "string" &&
    Number.isFinite(Date.parse(expiresAt)) &&
    Date.parse(observation.evidenceAsOf) <=
      Date.parse(input.assessedAt) &&
    Date.parse(expiresAt) > Date.parse(input.assessedAt) &&
    verifyCourseRoleEvidenceMac({
      secret: input.secret,
      evidenceHash,
        courseKey: observation.courseKey,
        threadKey: input.candidate.threadKey,
        authorKey: input.candidate.authorKey,
        role,
        evidenceAsOf: observation.evidenceAsOf,
        expiresAt,
      targetVersionHash: input.candidate.targetVersionHash
    })
  ) {
    return {
      status: "verified",
      role,
      basis: "trusted_course_role_attestation",
      evidenceHash: evidenceHash.toLowerCase()
    };
  }
  const unknownWithoutHash = {
    status: "unknown" as const,
    role: "unknown" as const,
    basis: "role_registry_unavailable" as const
  };
  return {
    ...unknownWithoutHash,
    evidenceHash: canonicalProtocolHash(
      "cmooc.server-role-evidence.v1",
      {
        ...unknownWithoutHash,
        courseKey: observation.courseKey,
        authorKey: input.candidate.authorKey,
        assessedAt: input.assessedAt
      } as unknown as CanonicalJsonValue
    )
  };
}

export async function issueServerEvidence(input: {
  prisma: PrismaClient;
  manifest: CourseManifest;
  invocationId: string;
  worldHash: string;
  candidateSetHash: string;
  candidate: AutonomyCandidate;
  observation: LiveUiObservationReceipt;
  observationReceiptHash: string;
  semanticEvidence?: AutonomySemanticEvidenceReceipt;
  semanticEvidenceHash?: string;
  assessedAt: string;
  coverageComplete: boolean;
  secret: Buffer | string;
  governanceLimits?: {
    dailySlotLimit: number;
    perTickActionLimit: number;
    authorTouchLimit30d: number;
  };
}): Promise<{
  bundle: ServerEvidenceBundle;
  bundleHash: string;
  assessment: LiveOpportunityAssessment;
  trustedHistory: TrustedSchedulingHistoryAttestation | null;
  trustedSemantic: TrustedSemanticEvidenceAttestation | null;
}> {
  if (
    input.observation.threadKey !== input.candidate.threadKey ||
    input.observation.authorKey !== input.candidate.authorKey ||
    input.observationReceiptHash !==
      input.candidate.sourceObservationReceiptHash
  ) {
    throw new Error("SERVER_EVIDENCE_OBSERVATION_MISMATCH");
  }
  const assessedAt = new Date(input.assessedAt).toISOString();
  const expiresAt = new Date(
    Date.parse(assessedAt) + 5 * 60_000
  ).toISOString();
  if (
    Boolean(input.semanticEvidence) !==
    Boolean(input.semanticEvidenceHash)
  ) {
    throw new Error("SERVER_SEMANTIC_EVIDENCE_INCOMPLETE");
  }
  let semanticEvidence:
    | AutonomySemanticEvidenceReceipt
    | null = null;
  let semanticEvidenceHash: string | null = null;
  if (input.semanticEvidence && input.semanticEvidenceHash) {
    const actualHash = canonicalProtocolHash(
      input.semanticEvidence.schemaVersion,
      input.semanticEvidence as unknown as CanonicalJsonValue
    );
    if (
      actualHash !== input.semanticEvidenceHash ||
      input.semanticEvidence.observationReceiptHash !==
        input.observationReceiptHash ||
      input.semanticEvidence.targetVersionHash !==
        input.candidate.targetVersionHash ||
      input.semanticEvidence.eventSetHash !==
        input.observation.eventSetHash ||
      Date.parse(input.semanticEvidence.observedAt) >
        Date.parse(assessedAt) ||
      input.semanticEvidence.containsForumText !== false
    ) {
      throw new Error("SERVER_SEMANTIC_EVIDENCE_MISMATCH");
    }
    semanticEvidence = input.semanticEvidence;
    semanticEvidenceHash = actualHash;
  }
  const historyCutoffHash = canonicalProtocolHash(
    "cmooc.scheduling-history-cutoff.v1",
    {
      worldHash: input.worldHash,
      candidateSetHash: input.candidateSetHash,
      threadKey: input.candidate.threadKey,
      authorKey: input.candidate.authorKey,
      assessedAt
    }
  );
  const completedScanCount =
    await input.prisma.courseScanRun.count({
      where: {
        courseAlias: input.manifest.alias,
        status: "completed",
        finishedAt: { lte: new Date(assessedAt) }
      }
    });
  const longitudinalHistoryStatus:
    ServerEvidenceBundle["longitudinalHistoryStatus"] =
    completedScanCount >= 2 ? "sufficient" : "insufficient";
  const candidateUniverse:
    ServerEvidenceBundle["candidateUniverse"] =
    input.coverageComplete
      ? input.candidate.supportGapHours >= 72
        ? "support_gap"
        : "full_history"
      : "recent";
  const usage = await readBudgetUsage({
    prisma: input.prisma,
    courseAlias: input.manifest.alias,
    invocationId: input.invocationId,
    authorKey: input.candidate.authorKey,
    now: new Date(assessedAt),
    legacyWorkloadCost: input.manifest.budget.workloadCost
  });
  const authorTouchCount30d = usage.authorTouches30d;
  const lastSystemTouchAt =
    usage.lastSystemTouchAt?.toISOString() ?? null;
  const budget = {
    availableSlots: Math.max(
      0,
      (input.governanceLimits?.dailySlotLimit ??
        input.manifest.budget.dailySlots) -
        usage.consumedUnitsToday -
        usage.reservedUnitsToday
    ),
    workloadCost: input.manifest.budget.workloadCost,
    authorTouchLimit30d:
      Math.min(
        input.manifest.budget.authorTouchLimit30d,
        input.governanceLimits?.authorTouchLimit30d ??
          input.manifest.budget.authorTouchLimit30d
      )
  };
  const role = resolveServerRoleEvidence({
    observation: input.observation,
    candidate: input.candidate,
    assessedAt,
    secret: input.secret
  });
  const targetReason:
    ServerEvidenceBundle["targetReason"] =
    input.candidate.supportGapHours >= 72 &&
    input.observation.commentCount === 0
      ? "mature_unreplied_root"
      : "stalled_existing_thread";
  const communityProcessGoal:
    ServerEvidenceBundle["communityProcessGoal"] =
    semanticEvidence?.dominantNeed === "conceptual_tension"
      ? "continue_existing_discussion"
      : semanticEvidence?.dominantNeed === "connection_gap"
        ? "support_relational_bridge"
        : semanticEvidence?.dominantNeed ===
            "participation_barrier"
          ? "broaden_participation"
          : null;
  const historyWithoutHash = {
    observationReceiptHash: input.observationReceiptHash,
    courseKey: input.observation.courseKey,
    authorKey: input.candidate.authorKey,
    historyCutoffHash,
    observedThrough: assessedAt,
    issuedAt: assessedAt,
    expiresAt,
    longitudinalHistoryStatus,
    candidateUniverse,
    authorTouchCount30d,
    lastSystemTouchAt,
    budget
  };
  const historyReceiptHash = canonicalProtocolHash(
    "cmooc.trusted-scheduling-history.v1",
    historyWithoutHash as unknown as CanonicalJsonValue
  );
  const bundle: ServerEvidenceBundle = {
    schemaVersion: SERVER_EVIDENCE_BUNDLE_SCHEMA_VERSION,
    observationReceiptHash: input.observationReceiptHash,
    courseKey: input.observation.courseKey,
    threadKey: input.candidate.threadKey,
    authorKey: input.candidate.authorKey,
    issuedAt: assessedAt,
    expiresAt,
    role,
    historyReceiptHash,
    historyCutoffHash,
    longitudinalHistoryStatus,
    candidateUniverse,
    semanticEvidenceHash,
    semanticEvidenceStatus:
      semanticEvidence?.semanticEvidenceStatus ?? "unavailable",
    targetReason,
    communityProcessGoal,
    authorTouchCount30d,
    lastSystemTouchAt,
    budget,
    containsForumText: false
  };
  const bundleHash = canonicalProtocolHash(
    bundle.schemaVersion,
    bundle as unknown as CanonicalJsonValue
  );
  await input.prisma.schedulingLedger.upsert({
    where: { invocationId: input.invocationId },
    create: {
      invocationId: input.invocationId,
      courseAlias: input.manifest.alias,
      snapshotHash: input.worldHash,
      candidateSetHash: input.candidateSetHash,
      budgetDate: shanghaiDate(new Date(assessedAt)),
      availableSlots: budget.availableSlots,
      reservedSlots: usage.reservedUnitsToday,
      consumedSlots: usage.consumedUnitsToday,
      authorTouchWindowDays: 30,
      authorTouchLimit: budget.authorTouchLimit30d,
      reason: "server_as_of_ledger",
      ledgerHash: canonicalProtocolHash(
        "cmooc.scheduling-ledger.v1",
        {
          worldHash: input.worldHash,
          candidateSetHash: input.candidateSetHash,
          budgetDate: shanghaiDate(new Date(assessedAt)),
          availableSlots: budget.availableSlots,
          reservedSlots: usage.reservedUnitsToday,
          consumedSlots: usage.consumedUnitsToday,
          authorTouchLimit: budget.authorTouchLimit30d
        }
      )
    },
    update: {
      availableSlots: budget.availableSlots,
      reservedSlots: usage.reservedUnitsToday,
      consumedSlots: usage.consumedUnitsToday,
      authorTouchLimit: budget.authorTouchLimit30d,
      reason: "server_as_of_ledger",
      ledgerHash: canonicalProtocolHash(
        "cmooc.scheduling-ledger.v1",
        {
          worldHash: input.worldHash,
          candidateSetHash: input.candidateSetHash,
          budgetDate: shanghaiDate(new Date(assessedAt)),
          availableSlots: budget.availableSlots,
          reservedSlots: usage.reservedUnitsToday,
          consumedSlots: usage.consumedUnitsToday,
          authorTouchLimit: budget.authorTouchLimit30d
        }
      )
    }
  });
  const trustedHistory: TrustedSchedulingHistoryAttestation | null =
    input.candidate.authorKey
      ? {
          historyReceiptHash,
          observationReceiptHash: input.observationReceiptHash,
          courseKey: input.observation.courseKey,
          authorKey: input.candidate.authorKey,
          historyCutoffHash,
          observedThrough: assessedAt,
          issuedAt: assessedAt,
          expiresAt,
          longitudinalHistoryStatus,
          candidateUniverse,
          authorTouchCount30d,
          lastSystemTouchAt,
          budget
        }
      : null;
  const trustedSemantic: TrustedSemanticEvidenceAttestation | null =
    semanticEvidence && semanticEvidenceHash
      ? {
          semanticEvidenceHash,
          observationReceiptHash: input.observationReceiptHash,
          targetVersionHash: input.candidate.targetVersionHash,
          eventSetHash: semanticEvidence.eventSetHash,
          issuedAt: assessedAt,
          expiresAt,
          authority: "server_course_scan",
          containsForumText: false
        }
      : null;
  const rootEvents = input.observation.eventEvidence.filter(
    (event) => event.parentEventKey === null
  );
  if (rootEvents.length !== 1) {
    throw new Error("SERVER_EVIDENCE_ROOT_EVENT_MISMATCH");
  }
  const hasExternalHuman = input.observation.eventEvidence.some(
    (event) => event.actorRelation === "external_human"
  );
  const hasUnknownRelation = input.observation.eventEvidence.some(
    (event) => event.actorRelation === "unknown"
  );
  const assessment: LiveOpportunityAssessment = {
    schemaVersion: "cmooc.live-opportunity-assessment.v1",
    observationReceiptHash: input.observationReceiptHash,
    assessedAt,
    historyCutoffHash,
    targetVersionHash: input.candidate.targetVersionHash,
    eventSetHash: input.observation.eventSetHash ??
      canonicalProtocolHash("cmooc.empty-event-set.v1", []),
    contributionPublishedAt: rootEvents[0].createdAt,
    runtimeMode: "real_course_shadow",
    targetActorRole: role.role,
    testActorAuthorized: false,
    contributionFunctions:
      semanticEvidence?.contributionFunctions ?? [],
    sequenceCompletion:
      semanticEvidence?.sequenceCompletion ??
      (hasExternalHuman
        ? "socially_complete"
        : hasUnknownRelation
          ? "unknown"
          : "open"),
    atomicIdeaCount: Math.max(
      1,
      semanticEvidence?.atomicIdeaCount ?? 1
    ),
    epistemicSeedStatus:
      semanticEvidence?.epistemicSeedStatus ?? "unknown",
    needSignals:
      semanticEvidence?.needSignals ?? {
        connectionGap: "unknown",
        conceptualTension: "unknown",
        participationBarrier: "unknown"
      },
    dominantNeed:
      semanticEvidence?.dominantNeed ?? "unknown",
    relationQualification: hasUnknownRelation
      ? "unresolved"
      : "supported",
    longitudinalHistoryStatus,
    candidateUniverse,
    authorTouchCount30d,
    lastSystemTouchAt,
    budget,
    containsForumText: false
  };
  return {
    bundle,
    bundleHash,
    assessment,
    trustedHistory,
    trustedSemantic
  };
}
