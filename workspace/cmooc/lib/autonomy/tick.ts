import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  buildLiveFacilitationOpportunity,
  parseLiveOpportunityAssessment,
  hasStableDistinctActorResponse
} from "@/lib/live-runtime/facilitation-kernel";
import {
  loadOrCreateLocalEvidenceSecret,
  localEvidenceHmac
} from "@/lib/privacy/local-evidence-hmac";
import type {
  LiveUiEventEvidence,
  LiveUiObservationReceipt
} from "@/lib/ui-agent/live-observation";
import {
  appendObservedCourseEvents,
  LIVE_COURSE_EVENT_SCHEMA_VERSION,
  loadCourseEventRevisionsAtCutoff,
  type NormalizedCourseEvent
} from "@/lib/world/live-event";
import {
  projectAndPersistLiveWorld
} from "@/lib/world/live-world-projector";
import {
  projectAndPersistCourseContentGraphV2
} from "@/lib/world/course-content-graph-store";
import {
  hashCourseStructureFactSet
} from "@/lib/world/course-structure-fact";
import {
  appendCourseStructureFacts,
  loadCourseStructureFactsForScan
} from "@/lib/world/course-structure-store";
import {
  buildAndPersistCandidateSet,
  type AutonomyCandidate
} from "./candidate-set";
import {
  COURSE_MANIFEST_SCHEMA_VERSION_V2,
  loadAnyCourseManifest,
  normalizeRequestedMode,
  type AutonomyMode,
  type CourseManifest
} from "./course-manifest";
import {
  appendDecisionTapeEntry,
  verifyDecisionTape
} from "./decision-tape";
import {
  acquireInvocationLease,
  completeInvocation,
  failInvocation,
  heartbeatInvocation
} from "./invocation-store";
import {
  CmoocHybridShadowObserver,
  parseCourseScanResumeCursor,
  type AutonomyCourseObserver,
  type CourseScanResumeCursor,
  type CourseScanCoverage,
  type CourseScanObservation,
  type ObservedThreadBundle
} from "./platform-observer";
import { issueServerEvidence } from "./server-evidence";
import {
  buildAutonomyDraftRevalidation,
  type AutonomyDraftRevalidationReceipt
} from "./draft-revalidation";
import {
  renderSemanticDraft,
  SEMANTIC_RENDERER_CONTRACT_VERSION,
  SEMANTIC_RENDERER_VERSION
} from "./semantic-renderer";
import {
  resolveTeachableEpisode,
  type TeachableEpisodeReceipt
} from "./teachable-episode";
import {
  loadCourseOperationGovernance,
  type VerifiedCourseOperationGovernance,
  CourseOperationGovernanceError
} from "./course-operation-governance";
import {
  PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION,
  hashPersistedEvidenceQualification
} from "@/lib/workbench/course-evidence-workspace";
import {
  syncOperatorCourseIdentities,
  type OperatorIdentitySyncDb
} from "./operator-identity-sync";
import {
  createAutonomyObserverRegistry,
  type AutonomyObserverRegistry
} from "./observer-registry";
import {
  parseAutonomySemanticEvidenceReceipt,
  type AutonomySemanticEvidenceReceipt
} from "./transient-semantic-evidence";

export const AUTONOMY_TICK_SUMMARY_SCHEMA_VERSION =
  "cmooc.autonomy-tick-summary.v1" as const;

export type AutonomyTickSummary = {
  schemaVersion: typeof AUTONOMY_TICK_SUMMARY_SCHEMA_VERSION;
  status:
    | "completed"
    | "completed_partial"
    | "lease_busy"
    | "already_completed";
  invocationId: string;
  invocationKey: string;
  courseAlias: string;
  mode: AutonomyMode;
  scheduledFor: string;
  leaseAcquired: boolean;
  recovered: boolean;
  scanCoverageHash: string | null;
  sourceReceiptHash: string | null;
  observedEventCount: number;
  newEventCount: number;
  unrecoveredCommentCompanionFailureCount: number;
  worldHash: string | null;
  graphHash: string | null;
  contentGraphHash?: string | null;
  candidateSetHash: string | null;
  decisionCounts: {
    draft: number;
    wait: number;
    abstain: number;
    yield: number;
  };
  decisionTapeHeadHash: string | null;
  decisionTapeEntryCount: number;
  publishAttemptCount: 0;
  editorWriteCount: 0;
  realPublishEnabled: false;
  containsForumText: false;
  governancePolicyId: string | null;
  governanceVersion: string | null;
  governanceHash: string | null;
  governanceLimits: {
    dailySlotLimit: number;
    perTickActionLimit: number;
    authorTouchLimit30d: number;
    intervalMinutes: number;
  } | null;
};

type TickDependencies = {
  prisma: PrismaClient;
  observer?: AutonomyCourseObserver;
  observerRegistry?: AutonomyObserverRegistry;
  manifest?: CourseManifest;
  identitySecret?: Buffer | string;
  now?: () => Date;
  heartbeatIntervalMs?: number;
};

export class AutonomyTickError extends Error {
  readonly code: string;
  readonly evidenceHash: string;

  constructor(code: string, evidenceHash: string) {
    super(code);
    this.name = "AutonomyTickError";
    this.code = code;
    this.evidenceHash = evidenceHash;
  }
}

type AutonomyCandidatePriorityTier = 0 | 1 | 2;

function candidateHasNoObviousResponse(
  candidate: AutonomyCandidate,
  observation: ObservedThreadBundle | undefined
): boolean {
  return (
    candidate.externalHumanCount === 0 &&
    candidate.authorReturnCount === 0 &&
    candidate.systemResponseCount === 0 &&
    observation !== undefined &&
    !hasStableDistinctActorResponse(observation.kernelObservation)
  );
}

function candidateHasReadyEvidence(
  candidate: AutonomyCandidate,
  observation: ObservedThreadBundle | undefined
): boolean {
  if (!observation || candidate.completeness !== "complete") {
    return false;
  }
  const kernel = observation.kernelObservation;
  return (
    candidateHasNoObviousResponse(candidate, observation) &&
    kernel.commentCompleteness === "complete" &&
    kernel.safeToAdvanceToSemanticReview === true &&
    kernel.authorRole === "learner" &&
    typeof kernel.authorRoleEvidenceHash === "string" &&
    kernel.authorRoleEvidenceHash.length > 0 &&
    typeof kernel.authorRoleEvidenceExpiresAt === "string" &&
    kernel.authorRoleEvidenceExpiresAt.length > 0 &&
    observation.semanticEvidence != null &&
    typeof observation.semanticEvidenceHash === "string" &&
    observation.semanticEvidenceHash.length > 0
  );
}

function candidatePriorityTier(
  candidate: AutonomyCandidate,
  observation: ObservedThreadBundle | undefined
): AutonomyCandidatePriorityTier {
  if (candidateHasReadyEvidence(candidate, observation)) {
    return 0;
  }
  if (
    candidate.completeness === "complete" &&
    candidateHasNoObviousResponse(candidate, observation) &&
    observation?.kernelObservation.commentCompleteness ===
      "complete"
  ) {
    return 1;
  }
  return 2;
}

/**
 * Selects the bounded pre-screen set without changing CandidateSet contents,
 * original ordering, or hash. Kernel qualification still runs for every selected
 * candidate with an observation; this helper only puts the more actionable
 * opportunities first.
 */
export function selectCandidatesForAutonomyTick(
  candidates: readonly AutonomyCandidate[],
  observationByThread: ReadonlyMap<string, ObservedThreadBundle>,
  limit: number
): AutonomyCandidate[] {
  const boundedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : 0;
  return candidates
    .slice()
    .sort((left, right) => {
      const leftObservation = observationByThread.get(
        left.threadKey
      );
      const rightObservation = observationByThread.get(
        right.threadKey
      );
      const tierDifference =
        candidatePriorityTier(left, leftObservation) -
        candidatePriorityTier(right, rightObservation);
      if (tierDifference !== 0) return tierDifference;

      const supportGapDifference =
        right.supportGapHours - left.supportGapHours;
      if (supportGapDifference !== 0) {
        return supportGapDifference;
      }

      const publishedAtDifference =
        left.contributionPublishedAt.localeCompare(
          right.contributionPublishedAt
        );
      if (publishedAtDifference !== 0) {
        return publishedAtDifference;
      }
      return left.candidateKey.localeCompare(right.candidateKey);
    })
    .slice(0, boundedLimit);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorCodeChain(error: unknown): string[] {
  const codes: string[] = [];
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const record = current as { code?: unknown; cause?: unknown };
    if (
      typeof record.code === "string" &&
      /^[A-Z0-9_]{2,80}$/.test(record.code)
    ) {
      codes.push(record.code);
    }
    current = record.cause;
  }
  return codes;
}

export function classifyAutonomyTickErrorCode(
  error: unknown
): string {
  if (error instanceof AutonomyTickError) return error.code;
  if (error instanceof CourseOperationGovernanceError) {
    return error.code;
  }
  if (!(error instanceof Error)) return "tick_failed";
  if (
    errorCodeChain(error).some((code) =>
      /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/.test(
        code
      )
    )
  ) {
    return "read_transport_unavailable";
  }
  const upperMessage = error.message.toUpperCase();
  if (
    upperMessage.includes("READ_AUTH") ||
    upperMessage.includes("AUTH_UNAVAILABLE") ||
    upperMessage.includes("TOKEN") ||
    /(^|\D)(401|403)(\D|$)/.test(upperMessage) ||
    /登录|认证|未授权/.test(error.message)
  ) {
    return "read_auth_unavailable";
  }
  if (/^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)) {
    return error.message.toLowerCase();
  }
  if (error.message.includes("manifest")) return "manifest_invalid";
  if (error.message.includes("COURSE_SCAN")) return "course_scan_failed";
  if (error.message.includes("WORLD")) return "world_projection_failed";
  if (error.message.includes("LEASE")) return "lease_lost";
  if (error.message.includes("EVENT_LEDGER")) {
    return "event_ledger_failed";
  }
  return "tick_failed";
}

async function runWithPeriodicHeartbeat<T>(input: {
  intervalMs: number;
  heartbeat: () => Promise<unknown>;
  task: () => Promise<T>;
}): Promise<T> {
  if (
    !Number.isSafeInteger(input.intervalMs) ||
    input.intervalMs < 1
  ) {
    throw new Error("INVOCATION_HEARTBEAT_INTERVAL_INVALID");
  }
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let heartbeatError: unknown = null;
  const pulse = () => {
    if (stopped || inFlight || heartbeatError) return;
    inFlight = input
      .heartbeat()
      .then(() => undefined)
      .catch((error: unknown) => {
        heartbeatError = error;
      })
      .finally(() => {
        inFlight = null;
      });
  };
  const timer = setInterval(pulse, input.intervalMs);
  timer.unref();
  const stop = async () => {
    stopped = true;
    clearInterval(timer);
    const pending = inFlight;
    if (pending) await pending;
  };
  let result: T;
  try {
    result = await input.task();
  } catch (error) {
    await stop();
    throw error;
  }
  await stop();
  if (heartbeatError) throw heartbeatError;
  return result;
}

async function syncManifestState(input: {
  prisma: PrismaClient;
  manifest: CourseManifest;
  secret: Buffer | string;
  governance: VerifiedCourseOperationGovernance;
  expectedScheduleId?: string;
  now: Date;
}): Promise<{
  governance: VerifiedCourseOperationGovernance;
  scheduleId: string;
  scheduleKey: string;
}> {
  const identityKeyFingerprint = sha256(input.secret);
  const platformCourseRefHash = localEvidenceHmac({
    secret: input.secret,
    scope: "autonomy-manifest-course-ref-v1",
    value: input.manifest.courseId,
    length: 64
  });
  const canonicalLocatorHash = localEvidenceHmac({
    secret: input.secret,
    scope: "autonomy-manifest-locator-v1",
    value: input.manifest.canonicalUrl,
    length: 64
  });
  const scheduleKey = canonicalProtocolHash(
    "cmooc.operation-schedule.v1",
    {
      courseAlias: input.manifest.alias,
      intervalMinutes: input.governance.effectiveLimits.intervalMinutes,
      mode: input.governance.policy.mode,
      timeZone: input.manifest.timeZone
    }
  );
  const budgetJson = JSON.stringify({
    schemaVersion: "cmooc.operation-budget.v1",
    dailySlots: input.governance.effectiveLimits.dailySlotLimit,
    workloadCost: input.manifest.budget.workloadCost,
    authorTouchLimit30d:
      input.governance.effectiveLimits.authorTouchLimit30d,
    containsForumText: false
  });

  return input.prisma.$transaction(async (transaction) => {
    const governanceAtSync = await loadCourseOperationGovernance({
      prisma: transaction,
      manifest: input.manifest,
      now: input.now
    });
    if (
      governanceAtSync.record.id !== input.governance.record.id ||
      governanceAtSync.policy.version !== input.governance.policy.version ||
      governanceAtSync.governanceHash !== input.governance.governanceHash
    ) {
      throw new CourseOperationGovernanceError(
        "course_operation_governance_manifest_stale",
        governanceAtSync.governanceHash
      );
    }
    // Read both existing bindings before any mutation. A disabled manifest or
    // disabled current schedule is an explicit operator stop and may never be
    // revived by a tick.
    const [existingManifest, existingSchedule, courseSchedules] = await Promise.all([
      transaction.autonomyCourseManifest.findUnique({
        where: { alias: input.manifest.alias }
      }),
      transaction.operationSchedule.findUnique({
        where: { scheduleKey }
      }),
      transaction.operationSchedule.findMany({
        where: { courseAlias: input.manifest.alias },
        select: { id: true, enabled: true }
      })
    ]);
    if (existingManifest?.enabled === false) {
      throw new Error("AUTONOMY_MANIFEST_DISABLED");
    }
    if (
      existingManifest &&
      existingManifest.identityKeyFingerprint !== identityKeyFingerprint
    ) {
      throw new Error("AUTONOMY_IDENTITY_KEY_CHANGED");
    }
    if (
      existingManifest?.adapterId &&
      existingManifest.adapterId !== input.manifest.adapterId
    ) {
      throw new Error("AUTONOMY_ADAPTER_BINDING_MISMATCH");
    }
    if (
      existingSchedule &&
      existingSchedule.courseAlias !== input.manifest.alias
    ) {
      throw new Error("AUTONOMY_SCHEDULE_ALIAS_MISMATCH");
    }
    if (existingSchedule?.enabled === false) {
      throw new Error("AUTONOMY_SCHEDULE_DISABLED");
    }
    if (
      !existingSchedule &&
      courseSchedules.length > 0 &&
      !courseSchedules.some((schedule) => schedule.enabled)
    ) {
      throw new Error("AUTONOMY_SCHEDULE_DISABLED");
    }
    if (
      input.expectedScheduleId !== undefined &&
      existingSchedule?.id !== input.expectedScheduleId
    ) {
      throw new Error("AUTONOMY_SCHEDULE_BINDING_MISMATCH");
    }

    await transaction.autonomyCourseManifest.upsert({
      where: { alias: input.manifest.alias },
      create: {
        alias: input.manifest.alias,
        manifestHash: input.manifest.manifestHash,
        platformId: input.manifest.platformId,
        adapterId: input.manifest.adapterId,
        platformCourseRefHash,
        canonicalLocatorHash,
        identityKeyFingerprint,
        allowedOrigin: input.manifest.allowedOrigins[0],
        timeZone: input.manifest.timeZone,
        defaultMode: input.manifest.defaultMode,
        policyVersion: input.manifest.policyVersion,
        enabled: true,
        realPublishEnabled: false
      },
      update: {
        manifestHash: input.manifest.manifestHash,
        platformId: input.manifest.platformId,
        adapterId: input.manifest.adapterId,
        platformCourseRefHash,
        canonicalLocatorHash,
        allowedOrigin: input.manifest.allowedOrigins[0],
        timeZone: input.manifest.timeZone,
        defaultMode: input.manifest.defaultMode,
        policyVersion: input.manifest.policyVersion,
        // Preserve an operator's explicit enabled state; the guard above
        // rejects false and this update never broadens it to true.
        realPublishEnabled: false
      }
    });
    const schedule = await transaction.operationSchedule.upsert({
      where: { scheduleKey },
      create: {
        courseAlias: input.manifest.alias,
        scheduleKey,
        mode: input.governance.policy.mode,
        intervalMinutes: input.governance.effectiveLimits.intervalMinutes,
        timeZone: input.manifest.timeZone,
        enabled: true,
        budgetJson
      },
      update: {
        mode: input.governance.policy.mode,
        intervalMinutes: input.governance.effectiveLimits.intervalMinutes,
        timeZone: input.manifest.timeZone,
        budgetJson
      }
    });
    // A changed governance mode/interval gets a new immutable schedule key;
    // stale rows must not remain enabled and inflate health/due counts.
    await transaction.operationSchedule.updateMany({
      where: {
        courseAlias: input.manifest.alias,
        enabled: true,
        id: { not: schedule.id }
      },
      data: { enabled: false }
    });
    return {
      governance: input.governance,
      scheduleId: schedule.id,
      scheduleKey
    };
  });
}

function scanKey(invocationId: string): string {
  return canonicalProtocolHash("cmooc.course-scan-run.v1", {
    invocationId
  });
}

async function persistObservationReceipts(input: {
  prisma: PrismaClient;
  invocationId: string;
  threads: ObservedThreadBundle[];
}): Promise<void> {
  for (const thread of input.threads) {
    const computed = canonicalProtocolHash(
      thread.kernelObservation.schemaVersion,
      thread.kernelObservation as unknown as CanonicalJsonValue
    );
    if (computed !== thread.kernelObservationHash) {
      throw new Error("AUTONOMY_OBSERVATION_HASH_MISMATCH");
    }
    let semanticReceipt:
      | AutonomySemanticEvidenceReceipt
      | undefined;
    let semanticReceiptHash: string | undefined;
    if (
      (thread.semanticEvidence === undefined) !==
      (thread.semanticEvidenceHash === undefined)
    ) {
      throw new Error("AUTONOMY_SEMANTIC_EVIDENCE_PAIR_INCOMPLETE");
    }
    if (thread.semanticEvidence && thread.semanticEvidenceHash) {
      semanticReceipt = parseAutonomySemanticEvidenceReceipt(
        thread.semanticEvidence
      );
      semanticReceiptHash = canonicalProtocolHash(
        semanticReceipt.schemaVersion,
        semanticReceipt as unknown as CanonicalJsonValue
      );
      if (
        semanticReceiptHash !== thread.semanticEvidenceHash ||
        semanticReceipt.observationReceiptHash !==
          thread.kernelObservationHash ||
        semanticReceipt.eventSetHash !==
          thread.kernelObservation.eventSetHash ||
        semanticReceipt.targetVersionHash !==
          thread.targetVersionHash
      ) {
        throw new Error("AUTONOMY_SEMANTIC_EVIDENCE_BINDING_MISMATCH");
      }
    }
    const existing = await input.prisma.autonomyObservation.findUnique({
      where: { receiptHash: thread.kernelObservationHash },
      select: {
        invocationId: true,
        threadKey: true,
        semanticReceiptHash: true
      }
    });
    if (
      existing &&
      (existing.invocationId !== input.invocationId ||
        existing.threadKey !== thread.threadKey)
    ) {
      throw new Error("AUTONOMY_OBSERVATION_BINDING_MISMATCH");
    }
    if (
      existing?.semanticReceiptHash &&
      existing.semanticReceiptHash !== semanticReceiptHash
    ) {
      throw new Error("AUTONOMY_SEMANTIC_EVIDENCE_IMMUTABLE");
    }
    await input.prisma.autonomyObservation.upsert({
      where: { receiptHash: thread.kernelObservationHash },
      create: {
        invocationId: input.invocationId,
        threadKey: thread.threadKey,
        receiptHash: thread.kernelObservationHash,
        observedAt: new Date(
          thread.kernelObservation.observedAt
        ),
        receiptJson: JSON.stringify(
          thread.kernelObservation
        ),
        semanticReceiptHash,
        semanticReceiptJson: semanticReceipt
          ? JSON.stringify(semanticReceipt)
          : undefined,
        containsForumText: false
      },
      update: semanticReceipt
        ? {
            semanticReceiptHash,
            semanticReceiptJson: JSON.stringify(semanticReceipt)
          }
        : {}
    });
  }
}

async function loadPersistedObservationBundles(input: {
  prisma: PrismaClient;
  invocationId: string;
  courseAlias: string;
}): Promise<ObservedThreadBundle[]> {
  const stored = await input.prisma.autonomyObservation.findMany({
    where: { invocationId: input.invocationId },
    orderBy: { observedAt: "desc" }
  });
  const latestByThread = new Map<
    string,
    (typeof stored)[number]
  >();
  for (const observation of stored) {
    if (!latestByThread.has(observation.threadKey)) {
      latestByThread.set(observation.threadKey, observation);
    }
  }
  const bundles: ObservedThreadBundle[] = [];
  for (const observation of latestByThread.values()) {
    const receipt = JSON.parse(
      observation.receiptJson
    ) as LiveUiObservationReceipt;
    const receiptHash = canonicalProtocolHash(
      receipt.schemaVersion,
      receipt as unknown as CanonicalJsonValue
    );
    if (
      receiptHash !== observation.receiptHash ||
      receipt.containsForumText ||
      receipt.realPublishEnabled ||
      receipt.sentMutationCount !== 0
    ) {
      throw new Error("AUTONOMY_STORED_OBSERVATION_INVALID");
    }
    if (
      (observation.semanticReceiptHash === null) !==
      (observation.semanticReceiptJson === null)
    ) {
      throw new Error("AUTONOMY_STORED_SEMANTIC_EVIDENCE_INCOMPLETE");
    }
    let semanticEvidence:
      | AutonomySemanticEvidenceReceipt
      | undefined;
    if (
      observation.semanticReceiptHash &&
      observation.semanticReceiptJson
    ) {
      semanticEvidence = parseAutonomySemanticEvidenceReceipt(
        JSON.parse(observation.semanticReceiptJson)
      );
      const semanticHash = canonicalProtocolHash(
        semanticEvidence.schemaVersion,
        semanticEvidence as unknown as CanonicalJsonValue
      );
      if (
        semanticHash !== observation.semanticReceiptHash ||
        semanticEvidence.observationReceiptHash !== receiptHash ||
        semanticEvidence.eventSetHash !== receipt.eventSetHash ||
        semanticEvidence.targetVersionHash !==
          receipt.targetVersionHash
      ) {
        throw new Error("AUTONOMY_STORED_SEMANTIC_EVIDENCE_INVALID");
      }
    }
    const storedEvents = await input.prisma.courseEvent.findMany({
      where: {
        courseAlias: input.courseAlias,
        eventKey: {
          in: receipt.eventEvidence.map((event) => event.eventKey)
        }
      }
    });
    const revisions = await loadCourseEventRevisionsAtCutoff({
      prisma: input.prisma,
      eventKeys: storedEvents.map((event) => event.eventKey),
      cutoff: observation.observedAt
    });
    const eventsByKey = new Map(
      storedEvents.map((event) => [event.eventKey, event])
    );
    const events: NormalizedCourseEvent[] =
      receipt.eventEvidence.map((evidence) => {
        const event = eventsByKey.get(evidence.eventKey);
        if (!event) {
          throw new Error(
            "AUTONOMY_OBSERVATION_EVENT_NOT_FOUND"
          );
        }
        const revision = revisions.get(event.eventKey);
        return {
          schemaVersion: LIVE_COURSE_EVENT_SCHEMA_VERSION,
          courseAlias: input.courseAlias,
          eventKey: event.eventKey,
          threadKey: event.threadKey,
          actorKey: event.actorKey,
          parentEventKey: event.parentEventKey,
          kind:
            event.kind === "thread_root"
              ? "thread_root"
              : "comment",
          actorRelation:
            event.actorRelation as NormalizedCourseEvent["actorRelation"],
          relationBasis:
            event.relationBasis as NormalizedCourseEvent["relationBasis"],
          depth: event.depth,
          occurredAt: event.occurredAt.toISOString(),
          observedAt:
            revision?.observedAt ??
            event.observedAt.toISOString(),
          sourceKind: "cmooc_api",
          sourceVersionHash:
            revision?.sourceVersionHash ??
            event.sourceVersionHash,
          targetVersionHash:
            revision?.targetVersionHash ??
            event.targetVersionHash,
          legalityStatus: "admissible"
        };
      });
    bundles.push({
      threadKey: observation.threadKey,
      authorKey: receipt.authorKey,
      targetVersionHash:
        receipt.targetVersionHash ??
        events[0]?.targetVersionHash ??
        "",
      events,
      kernelObservation: receipt,
      kernelObservationHash: receiptHash,
      ...(semanticEvidence && observation.semanticReceiptHash
        ? {
            semanticEvidence,
            semanticEvidenceHash: observation.semanticReceiptHash
          }
        : {})
    });
  }
  return bundles.sort((left, right) =>
    left.threadKey.localeCompare(right.threadKey)
  );
}

function parseStoredScanCursor(
  value: string | null | undefined
): CourseScanResumeCursor | undefined {
  if (!value) return undefined;
  try {
    return (
      parseCourseScanResumeCursor(JSON.parse(value)) ??
      undefined
    );
  } catch {
    return undefined;
  }
}

function ledgerEventEvidence(
  event: NormalizedCourseEvent
): LiveUiEventEvidence {
  return {
    eventKey: event.eventKey,
    actorKey: event.actorKey,
    parentEventKey: event.parentEventKey,
    createdAt: event.occurredAt,
    actorRelation: event.actorRelation,
    actorRelationBasis:
      event.relationBasis === "stable_actor_match"
        ? "stable_actor_match"
        : event.relationBasis === "server_actor_registry"
          ? "course_role_registry"
          : "unavailable"
  };
}

async function hydrateObservationBundlesFromLedger(input: {
  prisma: PrismaClient;
  courseAlias: string;
  observedAt: string;
  threads: ObservedThreadBundle[];
}): Promise<ObservedThreadBundle[]> {
  const cutoff = new Date(input.observedAt);
  const hydrated: ObservedThreadBundle[] = [];
  for (const thread of input.threads) {
    const stored = await input.prisma.courseEvent.findMany({
      where: {
        courseAlias: input.courseAlias,
        threadKey: thread.threadKey,
        observedAt: { lte: cutoff },
        occurredAt: { lte: cutoff },
        legalityStatus: "admissible"
      },
      orderBy: [{ occurredAt: "asc" }, { eventKey: "asc" }]
    });
    if (stored.length === 0) {
      throw new Error("AUTONOMY_LEDGER_THREAD_EMPTY");
    }
    const threadRoots = stored.filter(
      (event) =>
        event.kind === "thread_root" &&
        event.parentEventKey === null
    );
    if (threadRoots.length !== 1) {
      throw new Error(
        "AUTONOMY_LEDGER_THREAD_ROOT_INVALID"
      );
    }
    const revisions = await loadCourseEventRevisionsAtCutoff({
      prisma: input.prisma,
      eventKeys: stored.map((event) => event.eventKey),
      cutoff
    });
    const rootRevision = revisions.get(threadRoots[0].eventKey);
    const canonicalTargetVersionHash =
      rootRevision?.targetVersionHash ??
      threadRoots[0].targetVersionHash;
    const events: NormalizedCourseEvent[] = stored.map(
      (event) => {
        const revision = revisions.get(event.eventKey);
        if (
          event.kind !== "thread_root" &&
          event.kind !== "comment"
        ) {
          throw new Error(
            "AUTONOMY_LEDGER_EVENT_KIND_INVALID"
          );
        }
        return {
          schemaVersion: LIVE_COURSE_EVENT_SCHEMA_VERSION,
          courseAlias: input.courseAlias,
          eventKey: event.eventKey,
          threadKey: event.threadKey,
          actorKey: event.actorKey,
          parentEventKey: event.parentEventKey,
          kind: event.kind,
          actorRelation:
            event.actorRelation as NormalizedCourseEvent["actorRelation"],
          relationBasis:
            event.relationBasis as NormalizedCourseEvent["relationBasis"],
          depth: event.depth,
          occurredAt: event.occurredAt.toISOString(),
          observedAt:
            revision?.observedAt ??
            event.observedAt.toISOString(),
          sourceKind: "cmooc_api",
          sourceVersionHash:
            revision?.sourceVersionHash ??
            event.sourceVersionHash,
          targetVersionHash:
            revision?.targetVersionHash ??
            event.targetVersionHash,
          legalityStatus: "admissible"
        };
      }
    );
    const eventEvidence = events.map(ledgerEventEvidence);
    const eventSetHash = canonicalProtocolHash(
      "cmooc.live-event-evidence-set.v1",
      {
        schemaVersion:
          "cmooc.live-event-evidence-set.v1",
        events: eventEvidence
      } as unknown as CanonicalJsonValue
    );
    const receiptWithoutKey = {
      ...thread.kernelObservation,
      observationKey: undefined,
      targetVersionHash: canonicalTargetVersionHash,
      eventSetHash,
      eventEvidence,
      eventCount: events.length,
      commentCount: events.filter(
        (event) => event.parentEventKey !== null
      ).length,
      externalCommentCount: events.filter(
        (event) =>
          event.parentEventKey !== null &&
          event.actorRelation === "external_human"
      ).length,
      selfCommentCount: events.filter(
        (event) =>
          event.parentEventKey !== null &&
          event.actorRelation === "thread_author"
      ).length,
      uniqueExternalAuthorCount: new Set(
        events
          .filter(
            (event) =>
              event.actorRelation === "external_human" &&
              event.actorKey !== null
          )
          .map((event) => event.actorKey as string)
      ).size,
      replyEdgeCount: events.filter(
        (event) => event.parentEventKey !== null
      ).length,
      maxReplyDepth: Math.max(
        0,
        ...events.map((event) => event.depth)
      ),
      latestEventAt:
        events
          .map((event) => event.occurredAt)
          .sort(
            (left, right) =>
              Date.parse(left) - Date.parse(right) ||
              left.localeCompare(right)
          )
          .at(-1) ?? null
    };
    const {
      observationKey: _discardedObservationKey,
      ...canonicalReceipt
    } = receiptWithoutKey;
    void _discardedObservationKey;
    const observationKey = canonicalProtocolHash(
      "cmooc.live-ui-observation-receipt.v1",
      canonicalReceipt as unknown as CanonicalJsonValue
    );
    const receipt: LiveUiObservationReceipt = {
      ...(canonicalReceipt as Omit<
        LiveUiObservationReceipt,
        "observationKey"
      >),
      observationKey
    };
    const receiptHash = canonicalProtocolHash(
      receipt.schemaVersion,
      receipt as unknown as CanonicalJsonValue
    );
    const semanticBindingsMatch =
      thread.semanticEvidence !== undefined &&
      thread.semanticEvidenceHash !== undefined &&
      thread.semanticEvidence.observationReceiptHash ===
        receiptHash &&
      thread.semanticEvidence.eventSetHash ===
        receipt.eventSetHash &&
      thread.semanticEvidence.targetVersionHash ===
        receipt.targetVersionHash;
    hydrated.push({
      ...thread,
      targetVersionHash: canonicalTargetVersionHash,
      events,
      kernelObservation: receipt,
      kernelObservationHash: receiptHash,
      semanticEvidence: semanticBindingsMatch
        ? thread.semanticEvidence
        : undefined,
      semanticEvidenceHash: semanticBindingsMatch
        ? thread.semanticEvidenceHash
        : undefined
    });
  }
  return hydrated.sort((left, right) =>
    left.threadKey.localeCompare(right.threadKey)
  );
}

function singleObservedCourseKey(
  threads: readonly ObservedThreadBundle[]
): string {
  const courseKeys = new Set(
    threads.map(
      (thread) => thread.kernelObservation.courseKey
    )
  );
  if (courseKeys.size !== 1) {
    throw new Error("COURSE_CONTENT_GRAPH_COURSE_KEY_MISMATCH");
  }
  return [...courseKeys][0];
}

async function observeOrResumeScan(input: {
  prisma: PrismaClient;
  invocationId: string;
  manifest: CourseManifest;
  observer: AutonomyCourseObserver;
  secret: Buffer | string;
  observedAt: string;
  now: () => Date;
  onProgress?: () => Promise<void>;
}): Promise<{
  scanRunId: string;
  observation: CourseScanObservation;
  newEventCount: number;
}> {
  const existing = await input.prisma.courseScanRun.findUnique({
    where: { invocationId: input.invocationId }
  });
  if (
    existing?.status === "completed" &&
    existing.coverageHash &&
    existing.sourceReceiptHash
  ) {
    const coverage = JSON.parse(
      existing.coverageJson
    ) as CourseScanCoverage;
    const threads = await loadPersistedObservationBundles({
      prisma: input.prisma,
      invocationId: input.invocationId,
      courseAlias: input.manifest.alias
    });
    const courseKey = singleObservedCourseKey(threads);
    const structureFacts =
      await loadCourseStructureFactsForScan({
        prisma: input.prisma,
        scanRunId: existing.id,
        courseKey,
        requireCompleted: true
      });
    return {
      scanRunId: existing.id,
      observation: {
        coverage,
        coverageHash: existing.coverageHash,
        sourceReceiptHash: existing.sourceReceiptHash,
        threads,
        structureFacts,
        structureFactSetHash:
          hashCourseStructureFactSet(structureFacts)
      },
      newEventCount: existing.newEventCount
    };
  }
  let resumeCursor = parseStoredScanCursor(
    existing?.cursorJson
  );
  if (!resumeCursor) {
    const previous =
      await input.prisma.courseScanRun.findFirst({
        where: {
          courseAlias: input.manifest.alias,
          invocationId: { not: input.invocationId },
          status: "completed"
        },
        orderBy: [
          { finishedAt: "desc" },
          { createdAt: "desc" }
        ],
        select: { cursorJson: true }
      });
    resumeCursor = parseStoredScanCursor(
      previous?.cursorJson
    );
  }
  let latestCursor: CourseScanResumeCursor =
    resumeCursor ?? {
      schemaVersion: "cmooc.course-scan-cursor.v2",
      scopeCursors: {},
      observedByScope: {},
      completedTopicScopes: [],
      containsForumText: false
    };
  const scanStartedAt = input.now();
  const currentScan = await input.prisma.courseScanRun.upsert({
    where: { invocationId: input.invocationId },
    create: {
      invocationId: input.invocationId,
      courseAlias: input.manifest.alias,
      scanKey: scanKey(input.invocationId),
      status: "running",
      sourceKind:
        input.manifest.schemaVersion ===
        COURSE_MANIFEST_SCHEMA_VERSION_V2
          ? "platform_connector_read_only"
          : "cmooc_api_plus_read_only_browser",
      cursorJson: JSON.stringify(latestCursor),
      coverageJson: JSON.stringify({
        schemaVersion: "cmooc.course-scan-coverage.v1",
        state: "pending",
        containsForumText: false
      }),
      startedAt: scanStartedAt
    },
    update: {
      status: "running",
      cursorJson: JSON.stringify(latestCursor),
      finishedAt: null
    }
  });
  let observation = await input.observer.observe({
    manifest: input.manifest,
    secret: input.secret,
    observedAt: input.observedAt,
    resumeCursor,
    onProgress: async (cursor) => {
      latestCursor = cursor;
      await input.onProgress?.();
      const updated =
        await input.prisma.courseScanRun.updateMany({
          where: {
            id: currentScan.id,
            status: "running"
          },
          data: {
            cursorJson: JSON.stringify(cursor)
          }
        });
      if (updated.count !== 1) {
        throw new Error("COURSE_SCAN_PROGRESS_LEASE_LOST");
      }
    }
  });
  if (observation.threads.length === 0) {
    throw new Error("COURSE_SCAN_NO_REAL_DETAIL_EVENTS");
  }
  const courseKey = singleObservedCourseKey(
    observation.threads
  );
  const ledger = await appendObservedCourseEvents({
    prisma: input.prisma,
    scanRunId: currentScan.id,
    courseAlias: input.manifest.alias,
    events: observation.threads.flatMap(
      (thread) => thread.events
    )
  });
  if (ledger.conflictEventKeys.length > 0) {
    const conflictEvidenceHash = canonicalProtocolHash(
      "cmooc.event-conflict-set.v1",
      [...ledger.conflictEventKeys].sort()
    );
    await input.prisma.autonomyIncident.create({
      data: {
        courseAlias: input.manifest.alias,
        invocationId: input.invocationId,
        severity: "high",
        code: "event_version_conflict",
        status: "open",
        evidenceHash: conflictEvidenceHash,
        summaryJson: JSON.stringify({
          schemaVersion: "cmooc.autonomy-incident-summary.v1",
          conflictCount: ledger.conflictEventKeys.length,
          containsForumText: false
        })
      }
    });
    throw new AutonomyTickError(
      "event_version_conflict",
      conflictEvidenceHash
    );
  }
  const structureFacts = observation.structureFacts ?? [];
  const structureFactSetHash =
    hashCourseStructureFactSet(structureFacts);
  if (
    observation.structureFactSetHash &&
    observation.structureFactSetHash !== structureFactSetHash
  ) {
    throw new Error("COURSE_STRUCTURE_FACT_SET_HASH_MISMATCH");
  }
  const structureLedger = await appendCourseStructureFacts({
    prisma: input.prisma,
    scanRunId: currentScan.id,
    courseAlias: input.manifest.alias,
    courseKey,
    observedAt: input.observedAt,
    sourceKind: observation.coverage.sourceKind,
    facts: structureFacts
  });
  if (structureLedger.conflictFactKeys.length > 0) {
    const conflictEvidenceHash = canonicalProtocolHash(
      "cmooc.structure-fact-conflict-set.v1",
      [...structureLedger.conflictFactKeys].sort()
    );
    await input.prisma.autonomyIncident.create({
      data: {
        courseAlias: input.manifest.alias,
        invocationId: input.invocationId,
        severity: "high",
        code: "structure_fact_version_conflict",
        status: "open",
        evidenceHash: conflictEvidenceHash,
        summaryJson: JSON.stringify({
          schemaVersion: "cmooc.autonomy-incident-summary.v1",
          conflictCount:
            structureLedger.conflictFactKeys.length,
          containsForumText: false
        })
      }
    });
    throw new AutonomyTickError(
      "structure_fact_version_conflict",
      conflictEvidenceHash
    );
  }
  observation = {
    ...observation,
    structureFacts,
    structureFactSetHash,
    threads: await hydrateObservationBundlesFromLedger({
      prisma: input.prisma,
      courseAlias: input.manifest.alias,
      observedAt: input.observedAt,
      threads: observation.threads
    })
  };
  await persistObservationReceipts({
    prisma: input.prisma,
    invocationId: input.invocationId,
    threads: observation.threads
  });
  const finishedAt = new Date(
    Math.max(
      input.now().getTime(),
      currentScan.startedAt.getTime()
    )
  );
  await input.prisma.courseScanRun.update({
    where: { id: currentScan.id },
    data: {
      status: "completed",
      sourceKind: observation.coverage.sourceKind,
      cursorJson: JSON.stringify(latestCursor),
      coverageJson: JSON.stringify(observation.coverage),
      coverageHash: observation.coverageHash,
      sourceReceiptHash: observation.sourceReceiptHash,
      observedEventCount: ledger.observedEventCount,
      newEventCount: ledger.newEventCount,
      failedTargetCount:
        observation.coverage.failedTargetCount,
      finishedAt
    }
  });
  return {
    scanRunId: currentScan.id,
    observation,
    newEventCount: ledger.newEventCount
  };
}

async function persistDecision(input: {
  prisma: PrismaClient;
  invocationId: string;
  manifest: CourseManifest;
  candidate: AutonomyCandidate;
  candidateSetHash: string;
  worldHash: string;
  observation: ObservedThreadBundle;
  coverageComplete: boolean;
  assessedAt: string;
  secret: Buffer | string;
  governance: VerifiedCourseOperationGovernance;
  rereadTarget: () => Promise<{
    observation: ObservedThreadBundle | null;
    checkedAt: string;
  }>;
}): Promise<{
  decision: "draft" | "wait" | "abstain" | "yield";
  reasonCode: string;
  receiptHash: string;
  evidenceBundleHash: string;
  revalidationReceipt: AutonomyDraftRevalidationReceipt | null;
  revalidationReceiptHash: string | null;
  teachableEpisode: TeachableEpisodeReceipt | null;
  teachableEpisodeReceiptHash: string | null;
}> {
  const existing =
    await input.prisma.autonomyDecision.findUnique({
      where: {
        invocationId_threadKey: {
          invocationId: input.invocationId,
          threadKey: input.candidate.threadKey
        }
      }
    });
  if (existing) {
    const summary = JSON.parse(existing.decisionJson) as {
      revalidationReceipt?: AutonomyDraftRevalidationReceipt;
      revalidationReceiptHash?: string;
      teachableEpisode?: TeachableEpisodeReceipt | null;
      teachableEpisodeReceiptHash?: string | null;
    };
    return {
      decision:
        existing.decision as
          | "draft"
          | "wait"
          | "abstain"
          | "yield",
      reasonCode: existing.reasonCode,
      receiptHash: existing.opportunityReceiptHash,
      evidenceBundleHash: existing.evidenceBundleHash,
      revalidationReceipt:
        summary.revalidationReceipt ?? null,
      revalidationReceiptHash:
        summary.revalidationReceiptHash ?? null,
      teachableEpisode: summary.teachableEpisode ?? null,
      teachableEpisodeReceiptHash:
        summary.teachableEpisodeReceiptHash ?? null
    };
  }
  const evidence = await issueServerEvidence({
    prisma: input.prisma,
    manifest: input.manifest,
    invocationId: input.invocationId,
    worldHash: input.worldHash,
    candidateSetHash: input.candidateSetHash,
    candidate: input.candidate,
    observation: input.observation.kernelObservation,
    observationReceiptHash:
      input.observation.kernelObservationHash,
    semanticEvidence: input.observation.semanticEvidence,
    semanticEvidenceHash:
      input.observation.semanticEvidenceHash,
    assessedAt: input.assessedAt,
    coverageComplete: input.coverageComplete,
    secret: input.secret,
    governanceLimits: input.governance.effectiveLimits
  });
  const assessment = parseLiveOpportunityAssessment(
    evidence.assessment
  );
  const baseOpportunity = buildLiveFacilitationOpportunity({
    assessment,
    observation: input.observation.kernelObservation,
    trustedNow: input.assessedAt,
    trustedHistoryAttestation:
      evidence.trustedHistory ?? undefined,
    trustedSemanticEvidenceAttestation:
      evidence.trustedSemantic ?? undefined
  });
  const teachableEpisode = await resolveTeachableEpisode({
    prisma: input.prisma,
    current: {
      courseAlias: input.manifest.alias,
      threadKey: input.candidate.threadKey,
      authorKey: input.candidate.authorKey,
      asOf: input.assessedAt,
      targetVersionHash: input.candidate.targetVersionHash,
      policyVersion: input.manifest.policyVersion,
      governanceHash: input.governance.governanceHash,
      selectedFunction:
        baseOpportunity.receipt.selectedFunction,
      rendererVersion: SEMANTIC_RENDERER_VERSION,
      rendererContractVersion:
        SEMANTIC_RENDERER_CONTRACT_VERSION,
      baseDecision: baseOpportunity.receipt.decision,
      baseReasonCode: baseOpportunity.receipt.reasonCode
    }
  });
  const opportunity = teachableEpisode.directive
    ? buildLiveFacilitationOpportunity({
        assessment,
        observation: input.observation.kernelObservation,
        trustedNow: input.assessedAt,
        trustedHistoryAttestation:
          evidence.trustedHistory ?? undefined,
        trustedSemanticEvidenceAttestation:
          evidence.trustedSemantic ?? undefined,
        teachableEpisodeDirective:
          teachableEpisode.directive
      })
    : baseOpportunity;
  const semantic = await renderSemanticDraft({
    opportunity,
    config: {
      enabled: true,
      provider: "local_deterministic",
      model: "facilitation_template_v1",
      maximumBodyCharacters: 2_000
    }
  });
  let revalidation: ReturnType<
    typeof buildAutonomyDraftRevalidation
  > | null = null;
  if (opportunity.receipt.decision === "draft") {
    let reread: {
      observation: ObservedThreadBundle | null;
      checkedAt: string;
    } = {
      observation: null,
      checkedAt: input.assessedAt
    };
    try {
      reread = await input.rereadTarget();
    } catch {
      reread = {
        observation: null,
        checkedAt: input.assessedAt
      };
    }
    revalidation = buildAutonomyDraftRevalidation({
      opportunity,
      beforeObservation:
        input.observation.kernelObservation,
      beforeObservationHash:
        input.observation.kernelObservationHash,
      afterObservation:
        reread.observation?.kernelObservation ?? null,
      afterObservationHash:
        reread.observation?.kernelObservationHash ?? null,
      checkedAt: reread.checkedAt
    });
  }
  const realizedContentHash =
    semantic.receipt.contentHash;
  const decisionKey = canonicalProtocolHash(
    "cmooc.autonomy-decision.v1",
    {
      invocationId: input.invocationId,
      candidateKey: input.candidate.candidateKey,
      opportunityReceiptHash: opportunity.receiptHash
    }
  );
  const decisionSummary = {
    schemaVersion: "cmooc.autonomy-decision-summary.v1",
    candidateKey: input.candidate.candidateKey,
    decision: opportunity.receipt.decision,
    decisionMode: opportunity.receipt.decisionMode,
    reasonCode: opportunity.receipt.reasonCode,
    observationReceiptHash:
      input.observation.kernelObservationHash,
    opportunityReceiptHash: opportunity.receiptHash,
    opportunityReceiptSchemaVersion:
      opportunity.receipt.schemaVersion,
    qualification: opportunity.receipt.qualification,
    qualificationHash: hashPersistedEvidenceQualification({
      opportunityReceiptHash: opportunity.receiptHash,
      qualification: opportunity.receipt.qualification
    }),
    qualificationSchemaVersion:
      PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION,
    evidenceBundleHash: evidence.bundleHash,
    roleEvidenceHash: evidence.bundle.role.evidenceHash,
    historyReceiptHash: evidence.bundle.historyReceiptHash,
    budget: evidence.bundle.budget,
    governanceVersion: input.governance.policy.version,
    governanceHash: input.governance.governanceHash,
    effectiveGovernanceLimits: input.governance.effectiveLimits,
    semanticEvidence: input.observation.semanticEvidence ?? null,
    semanticEvidenceHash:
      input.observation.semanticEvidenceHash ?? null,
    semanticEvidenceStatus:
      evidence.bundle.semanticEvidenceStatus,
    targetReason: evidence.bundle.targetReason,
    communityProcessGoal:
      evidence.bundle.communityProcessGoal,
    targetVersionHash: input.candidate.targetVersionHash,
    selectedFunction: opportunity.receipt.selectedFunction,
    intent: opportunity.receipt.intent,
    intentHash: opportunity.receipt.intentHash,
    moveSpec: opportunity.receipt.moveSpec,
    moveSpecHash: opportunity.receipt.moveSpecHash,
    opportunityDraftContentHash:
      opportunity.receipt.draftContentHash,
    draftContentHash: realizedContentHash,
    semanticReceipt: semantic.receipt,
    semanticReceiptHash: semantic.receiptHash,
    teachableEpisode: teachableEpisode.receipt,
    teachableEpisodeReceiptHash:
      teachableEpisode.receiptHash,
    revalidationReceipt: revalidation?.receipt ?? null,
    revalidationReceiptHash:
      revalidation?.receiptHash ?? null,
    draftBodyPersisted: false,
    publishAttempted: false,
    editorWriteAttempted: false,
    containsForumText: false
  };
  await input.prisma.$transaction(async (transaction) => {
    const decision =
      await transaction.autonomyDecision.create({
        data: {
        invocationId: input.invocationId,
        courseAlias: input.manifest.alias,
        decisionKey,
        threadKey: input.candidate.threadKey,
        authorKey: input.candidate.authorKey,
        decision: opportunity.receipt.decision,
        decisionMode: opportunity.receipt.decisionMode,
        reasonCode: opportunity.receipt.reasonCode,
        observationReceiptHash:
          input.observation.kernelObservationHash,
        opportunityReceiptHash: opportunity.receiptHash,
        evidenceBundleHash: evidence.bundleHash,
        intentHash: opportunity.receipt.intentHash,
        moveSpecHash: opportunity.receipt.moveSpecHash,
        draftContentHash: realizedContentHash,
        policyVersion: input.manifest.policyVersion,
        governanceVersion: input.governance.policy.version,
        governanceHash: input.governance.governanceHash,
        worldHash: input.worldHash,
        candidateSetHash: input.candidateSetHash,
        evidenceAsOf: new Date(input.assessedAt),
        decisionJson: JSON.stringify(decisionSummary),
        bodyPersisted: false,
        publishAttempted: false,
        editorWriteAttempted: false
        }
      });
    if (
      opportunity.receipt.decision === "draft" &&
      realizedContentHash
    ) {
      await transaction.semanticRealization.create({
        data: {
          decisionId: decision.id,
          rendererKind: semantic.receipt.resolution,
          rendererVersion:
            semantic.receipt.rendererVersion,
          modelProvider: semantic.receipt.provider,
          modelName: semantic.receipt.model,
          contractVersion:
            SEMANTIC_RENDERER_CONTRACT_VERSION,
          contentHash: realizedContentHash,
          validationJson: JSON.stringify({
          schemaVersion:
            "cmooc.semantic-realization-validation.v1",
          targetBound: true,
          intentBound:
            opportunity.receipt.intentHash !== null,
          moveSpecBound:
            opportunity.receipt.moveSpecHash !== null,
            semanticReceiptHash: semantic.receiptHash,
            modelInvoked: semantic.receipt.modelInvoked,
            modelOutputAccepted:
              semantic.receipt.modelOutputAccepted,
            bodyPersisted: false,
            containsForumText: false
          }),
          bodyPersisted: false
        }
      });
    }
  });
  return {
    decision:
      opportunity.receipt.decision,
    reasonCode: opportunity.receipt.reasonCode,
    receiptHash: opportunity.receiptHash,
    evidenceBundleHash: evidence.bundleHash,
    revalidationReceipt: revalidation?.receipt ?? null,
    revalidationReceiptHash:
      revalidation?.receiptHash ?? null,
    teachableEpisode: teachableEpisode.receipt,
    teachableEpisodeReceiptHash:
      teachableEpisode.receiptHash
  };
}

function emptyDecisionCounts(): AutonomyTickSummary["decisionCounts"] {
  return { draft: 0, wait: 0, abstain: 0, yield: 0 };
}

function summaryForUnacquired(input: {
  invocation: {
    id: string;
    invocationKey: string;
    courseAlias: string;
    mode: string;
    scheduledFor: Date;
    summaryJson: string | null;
  };
  reason: "lease_busy" | "already_completed";
}): AutonomyTickSummary {
  const stored = input.invocation.summaryJson
    ? (JSON.parse(
        input.invocation.summaryJson
      ) as Partial<AutonomyTickSummary>)
    : null;
  return {
    schemaVersion: AUTONOMY_TICK_SUMMARY_SCHEMA_VERSION,
    status: input.reason,
    invocationId: input.invocation.id,
    invocationKey: input.invocation.invocationKey,
    courseAlias: input.invocation.courseAlias,
    mode: input.invocation.mode as AutonomyMode,
    scheduledFor: input.invocation.scheduledFor.toISOString(),
    leaseAcquired: false,
    recovered: false,
    scanCoverageHash: stored?.scanCoverageHash ?? null,
    sourceReceiptHash: stored?.sourceReceiptHash ?? null,
    observedEventCount: stored?.observedEventCount ?? 0,
    newEventCount: 0,
    unrecoveredCommentCompanionFailureCount:
      stored?.unrecoveredCommentCompanionFailureCount ?? 0,
    worldHash: stored?.worldHash ?? null,
    graphHash: stored?.graphHash ?? null,
    contentGraphHash: stored?.contentGraphHash ?? null,
    candidateSetHash: stored?.candidateSetHash ?? null,
    decisionCounts:
      stored?.decisionCounts ?? emptyDecisionCounts(),
    decisionTapeHeadHash:
      stored?.decisionTapeHeadHash ?? null,
    decisionTapeEntryCount:
      stored?.decisionTapeEntryCount ?? 0,
    publishAttemptCount: 0,
    editorWriteCount: 0,
    realPublishEnabled: false,
    containsForumText: false,
    governancePolicyId:
      (stored as { governancePolicyId?: string | null } | null)
        ?.governancePolicyId ?? null,
    governanceVersion:
      (stored as { governanceVersion?: string | null } | null)
        ?.governanceVersion ?? null,
    governanceHash:
      (stored as { governanceHash?: string | null } | null)
        ?.governanceHash ?? null,
    governanceLimits:
      (stored as {
        governanceLimits?: AutonomyTickSummary["governanceLimits"];
      } | null)?.governanceLimits ?? null
  };
}

export async function runAutonomyTick(
  input: {
    courseAlias: string;
    requestedMode?: string;
    scheduledFor?: Date | string;
    scheduleId?: string;
  },
  dependencies: TickDependencies
): Promise<AutonomyTickSummary> {
  const now = dependencies.now ?? (() => new Date());
  const manifest =
    dependencies.manifest ??
    (await loadAnyCourseManifest(input.courseAlias));
  if (manifest.alias !== input.courseAlias) {
    throw new Error("COURSE_MANIFEST_ALIAS_MISMATCH");
  }
  const secret =
    dependencies.identitySecret ??
    (await loadOrCreateLocalEvidenceSecret());
  const governance = await loadCourseOperationGovernance({
    prisma: dependencies.prisma,
    manifest,
    now: now()
  });
  const requestedMode = input.requestedMode
    ? normalizeRequestedMode(input.requestedMode, manifest)
    : governance.policy.mode;
  const mode = requestedMode as AutonomyMode;
  if (
    mode !== "OBSERVE" &&
    mode !== "SHADOW"
  ) {
    throw new CourseOperationGovernanceError(
      "course_operation_governance_mode_not_allowed",
      governance.governanceHash
    );
  }
  if (mode === "SHADOW" && governance.policy.mode === "OBSERVE") {
    throw new CourseOperationGovernanceError(
      "course_operation_governance_mode_not_allowed",
      governance.governanceHash
    );
  }
  const observer = dependencies.observer ??
    (dependencies.observerRegistry ??
      createAutonomyObserverRegistry([
        {
          platformId: "cmooc.bnu",
          adapterId: "cmooc.api.v2",
          factory: () =>
            new CmoocHybridShadowObserver({
              recordOperatorIdentities: async (identityInput) => {
                await syncOperatorCourseIdentities({
                  prisma:
                    dependencies.prisma as unknown as OperatorIdentitySyncDb,
                  platformCourseId: identityInput.courseRef,
                  observedAt: identityInput.observedAt,
                  identities: identityInput.identities
                });
              }
            })
        }
      ])).create(manifest);
  const synced = await syncManifestState({
    prisma: dependencies.prisma,
    manifest,
    secret,
    governance,
    expectedScheduleId: input.scheduleId,
    now: now()
  });
  const acquired = await acquireInvocationLease({
    prisma: dependencies.prisma,
    manifest,
    scheduleId: synced.scheduleId,
    mode,
    governance: {
      policyId: governance.record.id,
      version: governance.policy.version,
      hash: governance.governanceHash,
      limits: governance.effectiveLimits
    },
    intervalMinutes: governance.effectiveLimits.intervalMinutes,
    scheduledFor: input.scheduledFor,
    now: now()
  });
  if (!acquired.acquired) {
    return summaryForUnacquired(acquired);
  }
  const { invocation, leaseOwner } = acquired;
  try {
    // Re-read immediately after lease acquisition. A pause or emergency halt
    // racing the due query must prevent observation/decision from starting.
    const governanceAfterLease = await loadCourseOperationGovernance({
      prisma: dependencies.prisma,
      manifest,
      now: now()
    });
    const modeAllowedAfterLease =
      mode === governanceAfterLease.policy.mode ||
      (mode === "OBSERVE" &&
        governanceAfterLease.policy.mode === "SHADOW");
    if (!modeAllowedAfterLease) {
      throw new CourseOperationGovernanceError(
        "course_operation_governance_mode_not_allowed",
        governanceAfterLease.governanceHash
      );
    }
    if (
      governanceAfterLease.governanceHash !== governance.governanceHash ||
      governanceAfterLease.record.id !== governance.record.id ||
      governanceAfterLease.policy.version !== governance.policy.version ||
      governanceAfterLease.effectiveLimits.intervalMinutes !==
        governance.effectiveLimits.intervalMinutes
    ) {
      throw new CourseOperationGovernanceError(
        "course_operation_governance_manifest_stale",
        governanceAfterLease.governanceHash
      );
    }
    await appendDecisionTapeEntry({
      prisma: dependencies.prisma,
      invocationId: invocation.id,
      kind: "operation_governance_resolved",
      payload: {
        schemaVersion: "cmooc.operation-governance-resolved.v1",
        courseAlias: manifest.alias,
        policyIdHash: canonicalProtocolHash(
          "cmooc.operation-governance-policy-id.v1",
          { id: governance.record.id, containsForumText: false }
        ),
        governanceVersion: governance.policy.version,
        governanceHash: governance.governanceHash,
        mode: governance.policy.mode,
        status: governance.policy.status,
        emergencyHalt: governance.policy.emergencyHalt,
        limits: governance.effectiveLimits,
        containsForumText: false
      }
    });
    await appendDecisionTapeEntry({
      prisma: dependencies.prisma,
      invocationId: invocation.id,
      kind: acquired.recovered
        ? "invocation_recovered"
        : "invocation_started",
      payload: {
        schemaVersion: "cmooc.invocation-start.v1",
        courseAlias: manifest.alias,
        manifestHash: manifest.manifestHash,
        mode,
        scheduledFor: invocation.scheduledFor.toISOString(),
        attempt: invocation.attempt,
        recovered: acquired.recovered,
        realPublishEnabled: false,
        containsForumText: false
      }
    });
    await heartbeatInvocation({
      prisma: dependencies.prisma,
      invocationId: invocation.id,
      leaseOwner,
      phase: "observing",
      leaseSeconds: manifest.schedule.leaseSeconds,
      now: now()
    });
    const observedAt = now().toISOString();
    const scan = await runWithPeriodicHeartbeat({
      intervalMs:
        dependencies.heartbeatIntervalMs ??
        Math.max(
          1_000,
          Math.floor(
            (manifest.schedule.leaseSeconds * 1_000) / 3
          )
        ),
      heartbeat: () =>
        heartbeatInvocation({
          prisma: dependencies.prisma,
          invocationId: invocation.id,
          leaseOwner,
          phase: "observing_active",
          leaseSeconds: manifest.schedule.leaseSeconds,
          now: now()
        }),
      task: () =>
        observeOrResumeScan({
          prisma: dependencies.prisma,
          invocationId: invocation.id,
          manifest,
          observer,
          secret,
          observedAt,
          now,
          onProgress: () =>
            heartbeatInvocation({
              prisma: dependencies.prisma,
              invocationId: invocation.id,
              leaseOwner,
              phase: "observing_checkpoint",
              leaseSeconds:
                manifest.schedule.leaseSeconds,
              now: now()
            }).then(() => undefined)
        })
    });
    const unrecoveredCommentCompanionFailureCount =
      scan.observation.coverage.failureCodeCounts[
        "comment_browser_companion_failed"
      ] ?? 0;
    await appendDecisionTapeEntry({
      prisma: dependencies.prisma,
      invocationId: invocation.id,
      kind: "observation_committed",
      payload: {
        schemaVersion: "cmooc.observation-commit.v2",
        coverageHash: scan.observation.coverageHash,
        sourceReceiptHash:
          scan.observation.sourceReceiptHash,
        observedEventCount:
          scan.observation.coverage.observedEventCount,
        newEventCount: scan.newEventCount,
        completedDetailCount:
          scan.observation.coverage.completedDetailCount,
        failedTargetCount:
          scan.observation.coverage.failedTargetCount,
        unrecoveredCommentCompanionFailureCount,
        structureFactSetHash:
          scan.observation.structureFactSetHash ??
          hashCourseStructureFactSet([]),
        structureFactCount:
          scan.observation.structureFacts?.length ?? 0,
        complete: scan.observation.coverage.complete,
        containsForumText: false
      }
    });
    await heartbeatInvocation({
      prisma: dependencies.prisma,
      invocationId: invocation.id,
      leaseOwner,
      phase: "projecting_world",
      leaseSeconds: manifest.schedule.leaseSeconds,
      now: now()
    });
    const world = await projectAndPersistLiveWorld({
      prisma: dependencies.prisma,
      invocationId: invocation.id,
      courseAlias: manifest.alias,
      coverageHash: scan.observation.coverageHash,
      asOfAt: scan.observation.coverage.observedAt,
      coverageComplete: scan.observation.coverage.complete,
      completeThreadKeys: scan.observation.threads
        .filter(
          (thread) =>
            thread.kernelObservation.commentCompleteness ===
            "complete"
        )
        .map((thread) => thread.threadKey)
    });
    await appendDecisionTapeEntry({
      prisma: dependencies.prisma,
      invocationId: invocation.id,
      kind: "world_committed",
      payload: {
        schemaVersion: "cmooc.world-commit.v1",
        worldHash: world.projection.worldHash,
        eventSetHash: world.projection.eventSetHash,
        graphHash: world.projection.graphHash,
        eventCount: world.projection.eventCount,
        threadCount: world.projection.threads.length,
        actorCount: world.projection.actors.length,
        edgeCount: world.projection.edges.length,
        containsForumText: false
      }
    });
    const observedCourseKey = singleObservedCourseKey(
      scan.observation.threads
    );
    await heartbeatInvocation({
      prisma: dependencies.prisma,
      invocationId: invocation.id,
      leaseOwner,
      phase: "projecting_content_graph_v2",
      leaseSeconds: manifest.schedule.leaseSeconds,
      now: now()
    });
    const contentGraph =
      await projectAndPersistCourseContentGraphV2({
        prisma: dependencies.prisma,
        worldSnapshotId: world.snapshotId,
        scanRunId: scan.scanRunId,
        courseAlias: manifest.alias,
        courseKey: observedCourseKey,
        coverageHash: scan.observation.coverageHash,
        asOfAt: scan.observation.coverage.observedAt,
        coverageComplete: scan.observation.coverage.complete,
        roleRegistryStatus:
          scan.observation.coverage.roleRegistryStatus
      });
    await appendDecisionTapeEntry({
      prisma: dependencies.prisma,
      invocationId: invocation.id,
      kind: "content_graph_v2_committed",
      payload: {
        schemaVersion: "cmooc.content-graph-v2-commit.v1",
        worldHash: world.projection.worldHash,
        structureFactSetHash:
          contentGraph.structureFactSetHash,
        contentGraphHash:
          contentGraph.projection.graphHash,
        nodeSetHash: contentGraph.projection.nodeSetHash,
        edgeSetHash: contentGraph.projection.edgeSetHash,
        nodeCount: contentGraph.projection.nodes.length,
        edgeCount: contentGraph.projection.edges.length,
        learnerNodeCount:
          contentGraph.projection.nodes.filter(
            (node) =>
              node.kind === "actor" &&
              node.role === "learner"
          ).length,
        learnerPositionCount:
          contentGraph.projection.learnerPositions.length,
        coverageStatus:
          contentGraph.projection.coverageStatus,
        containsForumText: false
      }
    });
    const candidateResult =
      await buildAndPersistCandidateSet({
        prisma: dependencies.prisma,
        invocationId: invocation.id,
        snapshotId: world.snapshotId,
        manifest,
        projection: world.projection,
        observedThreads: scan.observation.threads
      });
    await appendDecisionTapeEntry({
      prisma: dependencies.prisma,
      invocationId: invocation.id,
      kind: "candidate_set_committed",
      payload: {
        schemaVersion: "cmooc.candidate-set-commit.v1",
        candidateSetHash: candidateResult.candidateSetHash,
        candidateCount:
          candidateResult.candidateSet.candidates.length,
        effectiveCandidateCount: Math.min(
          candidateResult.candidateSet.candidates.length,
          governance.effectiveLimits.perTickActionLimit
        ),
        governanceHash: governance.governanceHash,
        governanceVersion: governance.policy.version,
        worldHash: world.projection.worldHash,
        containsForumText: false
      }
    });
    await heartbeatInvocation({
      prisma: dependencies.prisma,
      invocationId: invocation.id,
      leaseOwner,
      phase: "deciding",
      leaseSeconds: manifest.schedule.leaseSeconds,
      now: now()
    });
    const observationByThread = new Map(
      scan.observation.threads.map((thread) => [
        thread.threadKey,
        thread
      ])
    );
    let rereadPromise: Promise<CourseScanObservation> | null = null;
    const rereadTarget = async (
      threadKey: string
    ): Promise<{
      observation: ObservedThreadBundle | null;
      checkedAt: string;
    }> => {
      if (!rereadPromise) {
        await heartbeatInvocation({
          prisma: dependencies.prisma,
          invocationId: invocation.id,
          leaseOwner,
          phase: "revalidating",
          leaseSeconds: manifest.schedule.leaseSeconds,
          now: now()
        });
        const rereadObservedAt = now().toISOString();
        rereadPromise = runWithPeriodicHeartbeat({
          intervalMs:
            dependencies.heartbeatIntervalMs ??
            Math.max(
              1_000,
              Math.floor(
                (manifest.schedule.leaseSeconds * 1_000) / 3
              )
            ),
          heartbeat: () =>
            heartbeatInvocation({
              prisma: dependencies.prisma,
              invocationId: invocation.id,
              leaseOwner,
              phase: "revalidating_active",
              leaseSeconds: manifest.schedule.leaseSeconds,
              now: now()
            }),
          task: () =>
            observer.observe({
              manifest,
              secret,
              observedAt: rereadObservedAt,
              onProgress: () =>
                heartbeatInvocation({
                  prisma: dependencies.prisma,
                  invocationId: invocation.id,
                  leaseOwner,
                  phase: "revalidating_checkpoint",
                  leaseSeconds: manifest.schedule.leaseSeconds,
                  now: now()
                }).then(() => undefined)
            })
        });
      }
      const reread = await rereadPromise;
      return {
        observation:
          reread.threads.find(
            (thread) => thread.threadKey === threadKey
          ) ?? null,
        checkedAt: now().toISOString()
      };
    };
    const decisionCounts = emptyDecisionCounts();
    const effectiveCandidates = selectCandidatesForAutonomyTick(
      candidateResult.candidateSet.candidates,
      observationByThread,
      governance.effectiveLimits.perTickActionLimit
    );
    for (const candidate of effectiveCandidates) {
      const observation = observationByThread.get(
        candidate.threadKey
      );
      if (!observation) continue;
      const assessedAt = now().toISOString();
      const decision = await persistDecision({
        prisma: dependencies.prisma,
        invocationId: invocation.id,
        manifest,
        candidate,
        candidateSetHash: candidateResult.candidateSetHash,
        worldHash: world.projection.worldHash,
        observation,
        coverageComplete:
          observation.kernelObservation.commentCompleteness ===
          "complete",
        assessedAt,
        secret,
        governance,
        rereadTarget: () =>
          rereadTarget(candidate.threadKey)
      });
      decisionCounts[decision.decision] += 1;
      if (
        decision.teachableEpisode &&
        decision.teachableEpisodeReceiptHash &&
        decision.teachableEpisode.state !== "none"
      ) {
        await appendDecisionTapeEntry({
          prisma: dependencies.prisma,
          invocationId: invocation.id,
          kind: "teachable_episode_resolved",
          payload: {
            schemaVersion:
              "cmooc.teachable-episode-resolution-commit.v1",
            candidateKey: candidate.candidateKey,
            receiptHash:
              decision.teachableEpisodeReceiptHash,
            sourceDecisionKey:
              decision.teachableEpisode.sourceDecisionKey,
            state: decision.teachableEpisode.state,
            action: decision.teachableEpisode.action,
            reasonCode:
              decision.teachableEpisode.reasonCode,
            humanResponsePriority:
              decision.teachableEpisode.authorityFootprint
                .humanResponsePriority,
            learnerJudgmentSubstituted: false,
            publishAuthorityChanged: false,
            containsForumText: false
          }
        });
      }
      if (
        decision.revalidationReceipt &&
        decision.revalidationReceiptHash
      ) {
        await appendDecisionTapeEntry({
          prisma: dependencies.prisma,
          invocationId: invocation.id,
          kind: "target_revalidated",
          payload: {
            schemaVersion:
              "cmooc.target-revalidation-commit.v1",
            candidateKey: candidate.candidateKey,
            opportunityReceiptHash: decision.receiptHash,
            revalidationReceiptHash:
              decision.revalidationReceiptHash,
            decision:
              decision.revalidationReceipt.decision,
            reasonCode:
              decision.revalidationReceipt.reasonCode,
            shadowContinuationAllowed:
              decision.revalidationReceipt
                .shadowContinuationAllowed,
            editorWriteAllowed: false,
            publishAllowed: false,
            containsForumText: false
          }
        });
      }
      await appendDecisionTapeEntry({
        prisma: dependencies.prisma,
        invocationId: invocation.id,
        kind: "decision_committed",
        payload: {
          schemaVersion: "cmooc.decision-commit.v1",
          candidateKey: candidate.candidateKey,
          decision: decision.decision,
          reasonCode: decision.reasonCode,
          opportunityReceiptHash: decision.receiptHash,
          evidenceBundleHash: decision.evidenceBundleHash,
          governanceVersion: governance.policy.version,
          governanceHash: governance.governanceHash,
          teachableEpisodeReceiptHash:
            decision.teachableEpisodeReceiptHash,
          teachableEpisodeState:
            decision.teachableEpisode?.state ?? null,
          publishAttempted: false,
          editorWriteAttempted: false,
          containsForumText: false
        }
      });
    }
    await appendDecisionTapeEntry({
      prisma: dependencies.prisma,
      invocationId: invocation.id,
      kind: "invocation_completed",
      payload: {
        schemaVersion: "cmooc.invocation-complete.v2",
        worldHash: world.projection.worldHash,
        contentGraphHash:
          contentGraph.projection.graphHash,
        candidateSetHash: candidateResult.candidateSetHash,
        decisionCounts,
        unrecoveredCommentCompanionFailureCount,
        publishAttemptCount: 0,
        editorWriteCount: 0,
        realPublishEnabled: false,
        containsForumText: false
      }
    });
    const tape = await verifyDecisionTape({
      prisma: dependencies.prisma,
      invocationId: invocation.id
    });
    if (!tape.valid) {
      throw new Error("DECISION_TAPE_VERIFICATION_FAILED");
    }
    const summary: AutonomyTickSummary = {
      schemaVersion: AUTONOMY_TICK_SUMMARY_SCHEMA_VERSION,
      status: scan.observation.coverage.complete
        ? "completed"
        : "completed_partial",
      invocationId: invocation.id,
      invocationKey: invocation.invocationKey,
      courseAlias: manifest.alias,
      mode,
      scheduledFor: invocation.scheduledFor.toISOString(),
      leaseAcquired: true,
      recovered: acquired.recovered,
      scanCoverageHash: scan.observation.coverageHash,
      sourceReceiptHash:
        scan.observation.sourceReceiptHash,
      observedEventCount:
        scan.observation.coverage.observedEventCount,
      newEventCount: scan.newEventCount,
      unrecoveredCommentCompanionFailureCount,
      worldHash: world.projection.worldHash,
      graphHash: world.projection.graphHash,
      contentGraphHash:
        contentGraph.projection.graphHash,
      candidateSetHash: candidateResult.candidateSetHash,
      decisionCounts,
      decisionTapeHeadHash: tape.headHash,
      decisionTapeEntryCount: tape.entryCount,
      publishAttemptCount: 0,
      editorWriteCount: 0,
      realPublishEnabled: false,
      containsForumText: false,
      governancePolicyId: governance.record.id,
      governanceVersion: governance.policy.version,
      governanceHash: governance.governanceHash,
      governanceLimits: governance.effectiveLimits
    };
    await completeInvocation({
      prisma: dependencies.prisma,
      invocationId: invocation.id,
      leaseOwner,
      summary: summary as unknown as Record<string, unknown>,
      now: now()
    });
    return summary;
  } catch (error) {
    const code = classifyAutonomyTickErrorCode(error);
    const evidenceHash = localEvidenceHmac({
      secret,
      scope: "autonomy-tick-error-v1",
      value:
        error instanceof Error
          ? `${error.name}\0${error.message}`
          : String(error),
      length: 64
    });
    await appendDecisionTapeEntry({
      prisma: dependencies.prisma,
      invocationId: invocation.id,
      kind: "invocation_failed",
      payload: {
        schemaVersion: "cmooc.invocation-failure.v1",
        reasonCode: code,
        evidenceHash,
        containsForumText: false
      }
    }).catch(() => undefined);
    await dependencies.prisma.autonomyIncident
      .create({
        data: {
          courseAlias: manifest.alias,
          invocationId: invocation.id,
          severity: "high",
          code,
          status: "open",
          evidenceHash,
          summaryJson: JSON.stringify({
            schemaVersion:
              "cmooc.autonomy-incident-summary.v1",
            reasonCode: code,
            containsForumText: false
          })
        }
      })
      .catch(() => undefined);
    await failInvocation({
      prisma: dependencies.prisma,
      invocationId: invocation.id,
      leaseOwner,
      reasonCode: code,
      evidenceHash,
      now: now()
    }).catch(() => undefined);
    throw new AutonomyTickError(code, evidenceHash);
  }
}
