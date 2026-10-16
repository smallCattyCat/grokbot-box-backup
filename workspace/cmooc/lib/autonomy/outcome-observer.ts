import type {
  AutonomyDecision,
  CourseEvent,
  ExecutionAttempt,
  ExecutionPermit,
  PrismaClient
} from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
  PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION
} from "./execution-permit";
import {
  loadCourseEventRevisionsAtCutoff
} from "@/lib/world/live-event";
import {
  COURSE_STRUCTURE_FACT_SCHEMA_VERSION,
  parseCanonicalCourseStructureFact
} from "@/lib/world/course-structure-fact";
import { appendDecisionTapeEntry } from "./decision-tape";

export const PROXIMAL_OUTCOME_SCHEDULE_SCHEMA_VERSION =
  "cmooc.proximal-outcome-schedule.v1" as const;
export const PROXIMAL_OUTCOME_OBSERVATION_SCHEMA_VERSION =
  "cmooc.proximal-outcome-observation.v1" as const;

const HOUR_MS = 60 * 60_000;
const DEFAULT_COVERAGE_GRACE_MS = 12 * HOUR_MS;

export const PROXIMAL_OUTCOME_WINDOWS = [
  { name: "R24", offsetMs: 24 * HOUR_MS },
  { name: "R72", offsetMs: 72 * HOUR_MS }
] as const;

type PublicationDecision = Pick<
  AutonomyDecision,
  | "id"
  | "courseAlias"
  | "threadKey"
  | "authorKey"
  | "decision"
  | "publishAttempted"
>;

type PublicationAttempt = Pick<
  ExecutionAttempt,
  | "id"
  | "decisionId"
  | "permitId"
  | "mode"
  | "status"
  | "idempotencyKey"
  | "receiptJson"
  | "requestedMutationCount"
  | "sentMutationCount"
  | "publishAttempted"
  | "remoteOutcomeHash"
  | "finishedAt"
>;

type PublicationPermit = Pick<
  ExecutionPermit,
  | "id"
  | "decisionId"
  | "permitKey"
  | "targetHash"
  | "targetVersionHash"
  | "contentHash"
  | "idempotencyKey"
  | "status"
  | "usedAt"
  | "revokedAt"
  | "realPublishEnabled"
>;

export type EventPrefixItem = Pick<
  CourseEvent,
  | "eventKey"
  | "parentEventKey"
  | "actorKey"
  | "actorRelation"
  | "kind"
  | "occurredAt"
  | "observedAt"
  | "depth"
  | "targetVersionHash"
>;

export type PublicationEligibility =
  | {
      eligible: true;
      publishedAt: Date;
    }
  | {
      eligible: false;
      reason:
        | "decision_not_publishable"
        | "decision_publish_not_attested"
        | "attempt_not_confirmed"
        | "attempt_not_auto"
        | "mutation_count_not_exactly_one"
        | "permit_missing"
        | "permit_mismatch"
        | "permit_not_consumed"
        | "permit_publish_disabled"
        | "publication_time_missing"
        | "publication_time_inconsistent"
        | "remote_outcome_receipt_missing"
        | "remote_outcome_receipt_invalid";
    };

function validDate(value: Date, label: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`${label}必须是有效时间。`);
  }
  return value;
}

const REMOTE_PUBLICATION_RECEIPT_KEYS = [
  "bodyPersisted",
  "containsForumText",
  "contentHash",
  "idempotencyKey",
  "observedAt",
  "permitKey",
  "publishAttempted",
  "realPublishEnabled",
  "requestedMutationCount",
  "schemaVersion",
  "sentMutationCount",
  "state",
  "targetHash",
  "targetVersionHash"
] as const;
const PRODUCTION_REMOTE_PUBLICATION_RECEIPT_KEYS = [
  ...REMOTE_PUBLICATION_RECEIPT_KEYS,
  "remoteEvidenceHash"
].sort();

/**
 * A remote outcome hash is meaningful only when it is the canonical hash of
 * the persisted, body-free execution receipt and that receipt is bound to the
 * same attempt and permit. A syntactically valid arbitrary digest is not an
 * execution attestation.
 */
export function remotePublicationReceiptIsBound(input: {
  attempt: PublicationAttempt;
  permit: PublicationPermit;
}): boolean {
  if (
    !input.attempt.remoteOutcomeHash ||
    !/^[a-f0-9]{64}$/.test(input.attempt.remoteOutcomeHash) ||
    !input.attempt.finishedAt
  ) {
    return false;
  }
  try {
    const parsed = JSON.parse(
      input.attempt.receiptJson
    ) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return false;
    }
    const receipt = parsed as Record<string, unknown>;
    const keys = Object.keys(receipt).sort();
    const productionReceipt =
      receipt.schemaVersion ===
      PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION;
    const expectedKeys = productionReceipt
      ? PRODUCTION_REMOTE_PUBLICATION_RECEIPT_KEYS
      : REMOTE_PUBLICATION_RECEIPT_KEYS;
    if (
      keys.length !== expectedKeys.length ||
      !expectedKeys.every(
        (key, index) => keys[index] === key
      )
    ) {
      return false;
    }
    if (
      (receipt.schemaVersion !==
        EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION &&
        !productionReceipt) ||
      receipt.permitKey !== input.permit.permitKey ||
      receipt.idempotencyKey !==
        input.attempt.idempotencyKey ||
      receipt.idempotencyKey !==
        input.permit.idempotencyKey ||
      receipt.targetHash !== input.permit.targetHash ||
      receipt.targetVersionHash !==
        input.permit.targetVersionHash ||
      receipt.contentHash !== input.permit.contentHash ||
      receipt.state !== "confirmed_published" ||
      receipt.observedAt !==
        input.attempt.finishedAt.toISOString() ||
      receipt.requestedMutationCount !==
        input.attempt.requestedMutationCount ||
      receipt.sentMutationCount !==
        input.attempt.sentMutationCount ||
      receipt.publishAttempted !==
        input.attempt.publishAttempted ||
      receipt.realPublishEnabled !== true ||
      receipt.bodyPersisted !== false ||
      receipt.containsForumText !== false
    ) {
      return false;
    }
    if (
      productionReceipt &&
      (typeof receipt.remoteEvidenceHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(receipt.remoteEvidenceHash))
    ) {
      return false;
    }
    return (
      canonicalProtocolHash(
        productionReceipt
          ? PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION
          : EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
        receipt as CanonicalJsonValue
      ) === input.attempt.remoteOutcomeHash
    );
  } catch {
    return false;
  }
}

/**
 * Only a fully attested AUTO publication is eligible. SHADOW and STAGE
 * executions cannot create an outcome row, even when a malformed receipt
 * claims a mutation.
 */
export function classifyPublicationEligibility(input: {
  decision: PublicationDecision;
  attempt: PublicationAttempt;
  permit: PublicationPermit | null;
}): PublicationEligibility {
  if (input.decision.decision.toLowerCase() !== "draft") {
    return {
      eligible: false,
      reason: "decision_not_publishable"
    };
  }
  if (!input.decision.publishAttempted) {
    return {
      eligible: false,
      reason: "decision_publish_not_attested"
    };
  }
  if (
    input.attempt.status !== "confirmed_published" ||
    !input.attempt.publishAttempted
  ) {
    return {
      eligible: false,
      reason: "attempt_not_confirmed"
    };
  }
  if (input.attempt.mode.toUpperCase() !== "AUTO") {
    return {
      eligible: false,
      reason: "attempt_not_auto"
    };
  }
  if (
    input.attempt.requestedMutationCount !== 1 ||
    input.attempt.sentMutationCount !== 1
  ) {
    return {
      eligible: false,
      reason: "mutation_count_not_exactly_one"
    };
  }
  if (!input.attempt.permitId || !input.permit) {
    return { eligible: false, reason: "permit_missing" };
  }
  if (
    input.permit.id !== input.attempt.permitId ||
    input.permit.decisionId !== input.decision.id ||
    input.attempt.decisionId !== input.decision.id
  ) {
    return { eligible: false, reason: "permit_mismatch" };
  }
  if (
    input.permit.status !== "used" ||
    !input.permit.usedAt ||
    input.permit.revokedAt
  ) {
    return {
      eligible: false,
      reason: "permit_not_consumed"
    };
  }
  if (!input.permit.realPublishEnabled) {
    return {
      eligible: false,
      reason: "permit_publish_disabled"
    };
  }
  if (!input.attempt.finishedAt) {
    return {
      eligible: false,
      reason: "publication_time_missing"
    };
  }
  if (
    !input.attempt.remoteOutcomeHash ||
    !/^[a-f0-9]{64}$/.test(
      input.attempt.remoteOutcomeHash
    )
  ) {
    return {
      eligible: false,
      reason: "remote_outcome_receipt_missing"
    };
  }
  if (
    !remotePublicationReceiptIsBound({
      attempt: input.attempt,
      permit: input.permit
    })
  ) {
    return {
      eligible: false,
      reason: "remote_outcome_receipt_invalid"
    };
  }
  if (
    input.attempt.finishedAt.getTime() <
    input.permit.usedAt.getTime()
  ) {
    return {
      eligible: false,
      reason: "publication_time_inconsistent"
    };
  }
  return {
    eligible: true,
    publishedAt: validDate(
      new Date(input.attempt.finishedAt),
      "真实发布确认时间"
    )
  };
}

function orderedEvents(
  events: readonly EventPrefixItem[]
): EventPrefixItem[] {
  return [...events].sort(
    (left, right) =>
      left.occurredAt.getTime() -
        right.occurredAt.getTime() ||
      left.eventKey.localeCompare(right.eventKey)
  );
}

export function buildEventPrefix(
  events: readonly EventPrefixItem[]
): {
  eventKeys: string[];
  prefixHash: string;
  maxDepth: number;
} {
  const ordered = orderedEvents(events);
  const eventKeys = ordered.map((event) => event.eventKey);
  return {
    eventKeys,
    prefixHash: canonicalProtocolHash(
      "cmooc.thread-event-prefix.v1",
      ordered.map((event) => ({
        eventKey: event.eventKey,
        parentEventKey: event.parentEventKey,
        actorKey: event.actorKey,
        actorRelation: event.actorRelation,
        kind: event.kind,
        occurredAt: event.occurredAt.toISOString(),
        depth: event.depth,
        targetVersionHash: event.targetVersionHash
      })) as unknown as CanonicalJsonValue
    ),
    maxDepth: ordered.reduce(
      (maximum, event) =>
        Math.max(maximum, event.depth),
      0
    )
  };
}

export function eventPrefixIsContinuous(input: {
  baselineEventKeys: readonly string[];
  currentEventKeys: readonly string[];
}): boolean {
  if (
    input.currentEventKeys.length <
    input.baselineEventKeys.length
  ) {
    return false;
  }
  return input.baselineEventKeys.every(
    (eventKey, index) =>
      input.currentEventKeys[index] === eventKey
  );
}

export function summarizePostPublicationEvents(input: {
  baselineEvents: readonly EventPrefixItem[];
  currentEvents: readonly EventPrefixItem[];
  authorKey: string | null;
  publishedAt: Date;
}): {
  firstExternalReplyAt: Date | null;
  authorReturned: boolean | null;
  replyDepthDelta: number;
  newAuthorCount: number;
} {
  const publishedAt = validDate(
    new Date(input.publishedAt),
    "发布确认时间"
  );
  const baseline = buildEventPrefix(input.baselineEvents);
  const baselineActors = new Set(
    input.baselineEvents
      .map((event) => event.actorKey)
      .filter((actorKey): actorKey is string =>
        Boolean(actorKey)
      )
  );
  const afterPublication = orderedEvents(
    input.currentEvents.filter(
      (event) =>
        event.occurredAt.getTime() >
        publishedAt.getTime()
    )
  );
  const firstExternalReply =
    afterPublication.find(
      (event) =>
        event.actorRelation === "external_human" &&
        event.actorKey !== input.authorKey
    ) ?? null;
  const authorReturned = input.authorKey
    ? afterPublication.some(
        (event) => event.actorKey === input.authorKey
      )
    : null;
  const newAuthors = new Set(
    afterPublication
      .filter(
        (event) =>
          event.actorRelation === "external_human" &&
          event.actorKey &&
          !baselineActors.has(event.actorKey)
      )
      .map((event) => event.actorKey as string)
  );
  const current = buildEventPrefix(input.currentEvents);
  return {
    firstExternalReplyAt:
      firstExternalReply?.occurredAt ?? null,
    authorReturned,
    replyDepthDelta: Math.max(
      0,
      current.maxDepth - baseline.maxDepth
    ),
    newAuthorCount: newAuthors.size
  };
}

function parseBaselineReceipt(value: string): {
  baselineEventPrefixHash: string;
  publishedAt: string;
} | null {
  try {
    const parsed = JSON.parse(value) as {
      schemaVersion?: unknown;
      baselineEventPrefixHash?: unknown;
      publishedAt?: unknown;
      containsForumText?: unknown;
    };
    if (
      parsed.schemaVersion !==
        PROXIMAL_OUTCOME_SCHEDULE_SCHEMA_VERSION ||
      typeof parsed.baselineEventPrefixHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(
        parsed.baselineEventPrefixHash
      ) ||
      typeof parsed.publishedAt !== "string" ||
      parsed.containsForumText !== false ||
      !Number.isFinite(Date.parse(parsed.publishedAt))
    ) {
      return null;
    }
    return {
      baselineEventPrefixHash:
        parsed.baselineEventPrefixHash,
      publishedAt: new Date(
        parsed.publishedAt
      ).toISOString()
    };
  } catch {
    return null;
  }
}

async function loadPublicationEvidence(input: {
  prisma: PrismaClient;
  decision: PublicationDecision;
}): Promise<
  | {
      eligibility: Extract<
        PublicationEligibility,
        { eligible: true }
      >;
      attempt: PublicationAttempt;
      permit: PublicationPermit;
    }
  | {
      eligibility: Extract<
        PublicationEligibility,
        { eligible: false }
      >;
    }
> {
  const attempts =
    await input.prisma.executionAttempt.findMany({
      where: {
        decisionId: input.decision.id,
        status: "confirmed_published"
      },
      orderBy: { finishedAt: "asc" },
      select: {
        id: true,
        decisionId: true,
        permitId: true,
        mode: true,
        status: true,
        idempotencyKey: true,
        receiptJson: true,
        requestedMutationCount: true,
        sentMutationCount: true,
        publishAttempted: true,
        remoteOutcomeHash: true,
        finishedAt: true
      }
    });
  if (attempts.length === 0) {
    return {
      eligibility: {
        eligible: false,
        reason: "attempt_not_confirmed"
      }
    };
  }
  let lastFailure: Extract<
    PublicationEligibility,
    { eligible: false }
  > = {
    eligible: false,
    reason: "attempt_not_confirmed"
  };
  for (const attempt of attempts) {
    const permit = attempt.permitId
      ? await input.prisma.executionPermit.findUnique({
          where: { id: attempt.permitId },
          select: {
            id: true,
            decisionId: true,
            permitKey: true,
            targetHash: true,
            targetVersionHash: true,
            contentHash: true,
            idempotencyKey: true,
            status: true,
            usedAt: true,
            revokedAt: true,
            realPublishEnabled: true
          }
        })
      : null;
    const eligibility = classifyPublicationEligibility({
      decision: input.decision,
      attempt,
      permit
    });
    if (eligibility.eligible && permit) {
      return { eligibility, attempt, permit };
    }
    if (!eligibility.eligible) lastFailure = eligibility;
  }
  return { eligibility: lastFailure };
}

async function loadThreadEvents(input: {
  prisma: PrismaClient;
  courseAlias: string;
  threadKey: string;
  occurredThrough: Date;
  observedThrough: Date;
}): Promise<EventPrefixItem[]> {
  const events = await input.prisma.courseEvent.findMany({
    where: {
      courseAlias: input.courseAlias,
      threadKey: input.threadKey,
      occurredAt: { lte: input.occurredThrough },
      observedAt: { lte: input.observedThrough }
    },
    orderBy: [
      { occurredAt: "asc" },
      { eventKey: "asc" }
    ],
    select: {
      eventKey: true,
      parentEventKey: true,
      actorKey: true,
      actorRelation: true,
      kind: true,
      occurredAt: true,
      observedAt: true,
      depth: true,
      targetVersionHash: true
    }
  });
  const revisions = await loadCourseEventRevisionsAtCutoff({
    prisma: input.prisma,
    eventKeys: events.map((event) => event.eventKey),
    cutoff: input.observedThrough
  });
  return events.map((event) => ({
    ...event,
    targetVersionHash:
      revisions.get(event.eventKey)?.targetVersionHash ??
      event.targetVersionHash
  }));
}

export async function scheduleProximalOutcomes(input: {
  prisma: PrismaClient;
  decisionIds?: string[];
  courseAliases?: string[];
  limit?: number;
}): Promise<{
  schemaVersion:
    typeof PROXIMAL_OUTCOME_SCHEDULE_SCHEMA_VERSION;
  eligiblePublicationCount: number;
  createdWindowCount: number;
  existingWindowCount: number;
  ineligibleDecisionCount: number;
  containsForumText: false;
}> {
  const limit = Math.min(
    250,
    Math.max(1, Math.trunc(input.limit ?? 100))
  );
  let eligiblePublicationCount = 0;
  let createdWindowCount = 0;
  let existingWindowCount = 0;
  let ineligibleDecisionCount = 0;
  let scheduledDecisionCount = 0;
  let cursorId: string | undefined;
  const pageSize = Math.min(
    250,
    Math.max(25, limit)
  );
  schedulingPages: while (true) {
    const decisions =
      await input.prisma.autonomyDecision.findMany({
        where: {
          ...(input.decisionIds
            ? { id: { in: input.decisionIds } }
            : {}),
          ...(input.courseAliases
            ? { courseAlias: { in: input.courseAliases } }
            : {}),
          publishAttempted: true
        },
        orderBy: [
          { createdAt: "asc" },
          { id: "asc" }
        ],
        take: pageSize,
        ...(cursorId
          ? {
              cursor: { id: cursorId },
              skip: 1
            }
          : {}),
        select: {
          id: true,
          invocationId: true,
          courseAlias: true,
          threadKey: true,
          authorKey: true,
          decision: true,
          publishAttempted: true
        }
      });
    if (decisions.length === 0) break;
    for (const decision of decisions) {
      cursorId = decision.id;
      const publication = await loadPublicationEvidence({
        prisma: input.prisma,
        decision
      });
      if (!publication.eligibility.eligible) {
        ineligibleDecisionCount += 1;
        continue;
      }
      eligiblePublicationCount += 1;
      const publishedAt =
        publication.eligibility.publishedAt;
      const baselineEvents = await loadThreadEvents({
        prisma: input.prisma,
        courseAlias: decision.courseAlias,
        threadKey: decision.threadKey,
        occurredThrough: publishedAt,
        observedThrough: publishedAt
      });
      const baseline = buildEventPrefix(baselineEvents);
      let createdForDecision = 0;
      for (const window of PROXIMAL_OUTCOME_WINDOWS) {
        const existing =
          await input.prisma.proximalOutcome.findUnique({
            where: {
              decisionId_observationWindow: {
                decisionId: decision.id,
                observationWindow: window.name
              }
            },
            select: { id: true }
          });
        if (existing) {
          existingWindowCount += 1;
          continue;
        }
        try {
          await input.prisma.proximalOutcome.create({
            data: {
              decisionId: decision.id,
              observationWindow: window.name,
              dueAt: new Date(
                publishedAt.getTime() + window.offsetMs
              ),
              status: "pending",
              eventPrefixHash: baseline.prefixHash,
              functionUptakeJson: JSON.stringify({
                schemaVersion:
                  PROXIMAL_OUTCOME_SCHEDULE_SCHEMA_VERSION,
                publishedAt: publishedAt.toISOString(),
                baselineEventPrefixHash:
                  baseline.prefixHash,
                semanticFunctionUptake:
                  "not_observed",
                attribution:
                  "descriptive_post_publication_observation_not_causal",
                containsForumText: false
              })
            }
          });
          createdWindowCount += 1;
          createdForDecision += 1;
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "P2002"
          ) {
            existingWindowCount += 1;
            continue;
          }
          throw error;
        }
      }
      if (createdForDecision > 0) {
        scheduledDecisionCount += 1;
        if (scheduledDecisionCount >= limit) {
          break schedulingPages;
        }
      }
    }
    if (decisions.length < pageSize) break;
  }
  return {
    schemaVersion:
      PROXIMAL_OUTCOME_SCHEDULE_SCHEMA_VERSION,
    eligiblePublicationCount,
    createdWindowCount,
    existingWindowCount,
    ineligibleDecisionCount,
    containsForumText: false
  };
}

function scanCoverageIsComplete(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as {
      complete?: unknown;
      containsForumText?: unknown;
    };
    return (
      parsed.complete === true &&
      parsed.containsForumText === false
    );
  } catch {
    return false;
  }
}

type OutcomeScanEvidenceSource =
  | "full_course"
  | "target_thread";

type OutcomeScanSelection = {
  finishedAt: Date;
  evidenceSource: OutcomeScanEvidenceSource;
};

/**
 * Thread-level coverage is deliberately stricter than the course summary.
 * The observer may use a partial course scan only when this exact target
 * thread was observed as a complete, admissible node in that same scan.
 */
function threadFactCoverageIsComplete(
  value: string
): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length !== 2 ||
      keys.some(
        (key) =>
          key !== "comment_coverage" && key !== "source"
      )
    ) {
      return false;
    }
    if (record.comment_coverage !== "complete") {
      return false;
    }
    return record.source === "cmooc_api";
  } catch {
    return false;
  }
}

function targetThreadFactIsCanonical(fact: {
  courseKey: string;
  factKey: string;
  factIdentityKey: string;
  factKind: string;
  subjectKey: string;
  subjectKind: string;
  predicate: string | null;
  objectKey: string | null;
  objectKind: string | null;
  revisionHash: string;
  occurredAt: Date | null;
  ordinal: number | null;
  attributesJson: string;
  legalityStatus: string;
  containsForumText: boolean;
}): boolean {
  try {
    const attributes = JSON.parse(fact.attributesJson) as unknown;
    const parsed = parseCanonicalCourseStructureFact({
      schemaVersion: COURSE_STRUCTURE_FACT_SCHEMA_VERSION,
      courseKey: fact.courseKey,
      factKey: fact.factKey,
      factIdentityKey: fact.factIdentityKey,
      factKind: fact.factKind,
      subjectKey: fact.subjectKey,
      subjectKind: fact.subjectKind,
      predicate: fact.predicate,
      objectKey: fact.objectKey,
      objectKind: fact.objectKind,
      revisionHash: fact.revisionHash,
      occurredAt: fact.occurredAt?.toISOString() ?? null,
      ordinal: fact.ordinal,
      attributes,
      legalityStatus: fact.legalityStatus,
      containsForumText: fact.containsForumText
    });
    return parsed.factKey === fact.factKey;
  } catch {
    return false;
  }
}

/**
 * Pick the first finished scan that can prove this outcome window. The
 * predicate is shared by the mutating observer and read-only preflight so
 * coverage decisions cannot drift between the two paths.
 */
async function selectOutcomeScan(input: {
  prisma: PrismaClient;
  courseAlias: string;
  threadKey: string;
  dueAt: Date;
  now: Date;
}): Promise<OutcomeScanSelection | null> {
  const scans = await input.prisma.courseScanRun.findMany({
    where: {
      courseAlias: input.courseAlias,
      status: "completed",
      finishedAt: {
        gte: input.dueAt,
        lte: input.now
      }
    },
    orderBy: [
      { finishedAt: "asc" },
      { id: "asc" }
    ],
    select: {
      id: true,
      sourceKind: true,
      finishedAt: true,
      coverageJson: true
    }
  });
  for (const scan of scans) {
    if (!scan.finishedAt) continue;
    const courseCoverageComplete = scanCoverageIsComplete(
      scan.coverageJson
    );
    const [factObservations, eventObservations] =
      await Promise.all([
        input.prisma.courseStructureFactObservation.findMany(
          {
            where: { scanRunId: scan.id },
            select: {
              observedAt: true,
              sourceKind: true,
              sourceVersionHash: true,
              fact: {
                select: {
                  courseAlias: true,
                  courseKey: true,
                  factKey: true,
                  factIdentityKey: true,
                  factKind: true,
                  subjectKey: true,
                  subjectKind: true,
                  predicate: true,
                  objectKey: true,
                  objectKind: true,
                  revisionHash: true,
                  occurredAt: true,
                  ordinal: true,
                  attributesJson: true,
                  legalityStatus: true,
                  containsForumText: true
                }
              }
            }
          }
        ),
        input.prisma.courseEventObservation.findMany({
          where: { scanRunId: scan.id },
          select: {
            observedAt: true,
            sourceKind: true,
            sourceVersionHash: true,
            targetVersionHash: true,
            event: {
              select: {
                courseAlias: true,
                threadKey: true,
                kind: true,
                occurredAt: true,
                observedAt: true,
                sourceKind: true,
                sourceVersionHash: true,
                targetVersionHash: true,
                legalityStatus: true
              }
            }
          }
        })
      ]);
    const matchingTargetFacts = factObservations.filter(
      ({
        observedAt,
        sourceKind,
        sourceVersionHash,
        fact
      }) => {
        if (
          observedAt.getTime() > scan.finishedAt!.getTime() ||
          sourceKind !== scan.sourceKind ||
          sourceVersionHash !== fact.revisionHash ||
          fact.courseAlias !== input.courseAlias ||
          fact.factKind !== "node" ||
          fact.subjectKind !== "thread" ||
          fact.subjectKey !== input.threadKey ||
          fact.predicate !== null ||
          fact.objectKey !== null ||
          fact.objectKind !== null ||
          fact.containsForumText !== false ||
          fact.legalityStatus !== "admissible" ||
          (fact.occurredAt !== null &&
            fact.occurredAt.getTime() > input.dueAt.getTime()) ||
          !targetThreadFactIsCanonical(fact) ||
          !threadFactCoverageIsComplete(
            fact.attributesJson
          )
        ) {
          return false;
        }
        return true;
      }
    );
    const targetThreadComplete =
      matchingTargetFacts.length === 1 &&
      matchingTargetFacts.some(({ fact }) =>
        eventObservations.some(
          (observation) => {
            const event = observation.event;
            if (
              observation.observedAt.getTime() >
                scan.finishedAt!.getTime() ||
              observation.sourceKind !== event.sourceKind ||
              event.courseAlias !== input.courseAlias ||
              event.threadKey !== input.threadKey ||
              event.kind !== "thread_root" ||
              event.legalityStatus !== "admissible" ||
              event.occurredAt.getTime() > input.dueAt.getTime() ||
              event.observedAt.getTime() >
                observation.observedAt.getTime()
            ) {
              return false;
            }
            const revisionHashes = new Set([
              observation.sourceVersionHash,
              observation.targetVersionHash,
              event.sourceVersionHash,
              event.targetVersionHash
            ]);
            return revisionHashes.has(fact.revisionHash);
          }
        )
      );
    if (targetThreadComplete) {
      return {
        finishedAt: scan.finishedAt,
        evidenceSource: courseCoverageComplete
          ? "full_course"
          : "target_thread"
      };
    }
  }
  return null;
}

function normalizeCoverageGraceMs(
  value: number | undefined
): number {
  const coverageGraceMs =
    value ?? DEFAULT_COVERAGE_GRACE_MS;
  if (
    !Number.isSafeInteger(coverageGraceMs) ||
    coverageGraceMs < 0 ||
    coverageGraceMs > 7 * 24 * HOUR_MS
  ) {
    throw new Error("结果覆盖等待期无效。");
  }
  return coverageGraceMs;
}

async function censorOutcome(input: {
  prisma: PrismaClient;
  outcomeId: string;
  observedAt: Date;
  reason: string;
  baselineEventPrefixHash: string | null;
}): Promise<boolean> {
  const updated =
    await input.prisma.proximalOutcome.updateMany({
      where: {
        id: input.outcomeId,
        status: "pending"
      },
      data: {
        status: "censored",
        observedAt: input.observedAt,
        censored: true,
        missingReason: input.reason,
        functionUptakeJson: JSON.stringify({
          schemaVersion:
            PROXIMAL_OUTCOME_OBSERVATION_SCHEMA_VERSION,
          outcome: "censored",
          missingReason: input.reason,
          baselineEventPrefixHash:
            input.baselineEventPrefixHash,
          semanticFunctionUptake: "not_estimable",
          attribution:
            "no_educational_effect_claim",
          containsForumText: false
        })
      }
    });
  return updated.count === 1;
}

export type ProximalOutcomePreflightStatus =
  | "ready"
  | "waiting_for_coverage"
  | "would_censor";

export type ProximalOutcomePreflightItem = {
  decisionId: string;
  outcomeId: string;
  courseAlias: string;
  observationWindow: string;
  status: ProximalOutcomePreflightStatus;
  evidenceSource: OutcomeScanEvidenceSource | null;
};

/**
 * Read-only coverage preflight for pending windows that are due as of `now`.
 * It intentionally returns only internal database keys and a course alias;
 * no body, platform identifier, or other forum content crosses this API.
 */
export async function preflightDueProximalOutcomes(input: {
  prisma: PrismaClient;
  now?: Date;
  limit?: number;
  coverageGraceMs?: number;
  decisionIds?: string[];
  outcomeIds?: string[];
  courseAliases?: string[];
}): Promise<{
  schemaVersion:
    typeof PROXIMAL_OUTCOME_OBSERVATION_SCHEMA_VERSION;
  asOf: string;
  dueCount: number;
  readyCount: number;
  waitingForCoverageCount: number;
  wouldCensorCount: number;
  counts: {
    due: number;
    ready: number;
    waitingForCoverage: number;
    wouldCensor: number;
  };
  outcomes: ProximalOutcomePreflightItem[];
  containsForumText: false;
}> {
  const now = validDate(
    new Date(input.now ?? new Date()),
    "结果预检时间"
  );
  const limit = Math.min(
    250,
    Math.max(1, Math.trunc(input.limit ?? 100))
  );
  const coverageGraceMs = normalizeCoverageGraceMs(
    input.coverageGraceMs
  );
  const due =
    await input.prisma.proximalOutcome.findMany({
      where: {
        status: "pending",
        dueAt: { lte: now },
        ...(input.decisionIds
          ? { decisionId: { in: input.decisionIds } }
          : {}),
        ...(input.outcomeIds
          ? { id: { in: input.outcomeIds } }
          : {}),
        ...(input.courseAliases
          ? {
              decision: {
                courseAlias: { in: input.courseAliases }
              }
            }
          : {})
      },
      orderBy: [
        { updatedAt: "asc" },
        { dueAt: "asc" },
        { id: "asc" }
      ],
      take: limit,
      select: {
        id: true,
        decisionId: true,
        observationWindow: true,
        dueAt: true,
        functionUptakeJson: true
      }
    });
  const outcomes: ProximalOutcomePreflightItem[] = [];
  let readyCount = 0;
  let waitingForCoverageCount = 0;
  let wouldCensorCount = 0;
  for (const outcome of due) {
    const decision =
      await input.prisma.autonomyDecision.findUnique({
        where: { id: outcome.decisionId },
        select: {
          id: true,
          invocationId: true,
          courseAlias: true,
          threadKey: true,
          authorKey: true,
          decision: true,
          publishAttempted: true
        }
      });
    let selection: OutcomeScanSelection | null = null;
    if (decision) {
      const receipt = parseBaselineReceipt(
        outcome.functionUptakeJson
      );
      if (receipt) {
        const publication = await loadPublicationEvidence({
          prisma: input.prisma,
          decision
        });
        if (
          publication.eligibility.eligible &&
          publication.eligibility.publishedAt.toISOString() ===
            receipt.publishedAt
        ) {
          selection = await selectOutcomeScan({
            prisma: input.prisma,
            courseAlias: decision.courseAlias,
            threadKey: decision.threadKey,
            dueAt: outcome.dueAt,
            now
          });
        }
      }
    }
    const status: ProximalOutcomePreflightStatus =
      selection
        ? "ready"
        : now.getTime() <
            outcome.dueAt.getTime() + coverageGraceMs
          ? "waiting_for_coverage"
          : "would_censor";
    if (status === "ready") readyCount += 1;
    else if (status === "waiting_for_coverage") {
      waitingForCoverageCount += 1;
    } else {
      wouldCensorCount += 1;
    }
    outcomes.push({
      decisionId: outcome.decisionId,
      outcomeId: outcome.id,
      courseAlias: decision?.courseAlias ?? "",
      observationWindow: outcome.observationWindow,
      status,
      evidenceSource: selection?.evidenceSource ?? null
    });
  }
  return {
    schemaVersion:
      PROXIMAL_OUTCOME_OBSERVATION_SCHEMA_VERSION,
    asOf: now.toISOString(),
    dueCount: due.length,
    readyCount,
    waitingForCoverageCount,
    wouldCensorCount,
    counts: {
      due: due.length,
      ready: readyCount,
      waitingForCoverage: waitingForCoverageCount,
      wouldCensor: wouldCensorCount
    },
    outcomes,
    containsForumText: false
  };
}

export async function observeDueProximalOutcomes(input: {
  prisma: PrismaClient;
  now?: Date;
  limit?: number;
  coverageGraceMs?: number;
  decisionIds?: string[];
  outcomeIds?: string[];
  courseAliases?: string[];
  /** Never convert a selected row to censored; requires explicit ids. */
  readyOnly?: boolean;
}): Promise<{
  schemaVersion:
    typeof PROXIMAL_OUTCOME_OBSERVATION_SCHEMA_VERSION;
  asOf: string;
  dueCount: number;
  observedCount: number;
  censoredCount: number;
  waitingForCoverageCount: number;
  containsForumText: false;
}> {
  const now = validDate(
    new Date(input.now ?? new Date()),
    "结果观察时间"
  );
  const limit = Math.min(
    250,
    Math.max(1, Math.trunc(input.limit ?? 100))
  );
  const coverageGraceMs = normalizeCoverageGraceMs(
    input.coverageGraceMs
  );
  if (
    input.readyOnly === true &&
    (!input.outcomeIds || input.outcomeIds.length === 0)
  ) {
    throw new Error("READY_ONLY_OUTCOME_IDS_REQUIRED");
  }
  const due =
    await input.prisma.proximalOutcome.findMany({
      where: {
        status: "pending",
        dueAt: { lte: now },
        ...(input.decisionIds
          ? { decisionId: { in: input.decisionIds } }
          : {}),
        ...(input.outcomeIds
          ? { id: { in: input.outcomeIds } }
          : {}),
        ...(input.courseAliases
          ? {
              decision: {
                courseAlias: { in: input.courseAliases }
              }
            }
          : {})
      },
      // `updatedAt` is a fair-reconciliation cursor: rows that cannot yet
      // be observed are touched below and rotate behind untouched due rows.
      // Otherwise a small limit lets the same oldest waiting rows starve
      // every later window indefinitely.
      orderBy: [
        { updatedAt: "asc" },
        { dueAt: "asc" },
        { id: "asc" }
      ],
      take: limit
    });
  let observedCount = 0;
  let censoredCount = 0;
  let waitingForCoverageCount = 0;
  for (const outcome of due) {
    const receipt = parseBaselineReceipt(
      outcome.functionUptakeJson
    );
    const decision =
      await input.prisma.autonomyDecision.findUnique({
        where: { id: outcome.decisionId },
        select: {
          id: true,
          invocationId: true,
          courseAlias: true,
          threadKey: true,
          authorKey: true,
          decision: true,
          publishAttempted: true
        }
      });
    if (!receipt || !decision) {
      if (input.readyOnly === true) {
        waitingForCoverageCount += 1;
        continue;
      }
      if (
        await censorOutcome({
          prisma: input.prisma,
          outcomeId: outcome.id,
          observedAt: now,
          reason: "baseline_or_decision_receipt_missing",
          baselineEventPrefixHash:
            receipt?.baselineEventPrefixHash ?? null
        })
      ) {
        censoredCount += 1;
      }
      continue;
    }
    const publication = await loadPublicationEvidence({
      prisma: input.prisma,
      decision
    });
    if (!publication.eligibility.eligible) {
      if (input.readyOnly === true) {
        waitingForCoverageCount += 1;
        continue;
      }
      if (
        await censorOutcome({
          prisma: input.prisma,
          outcomeId: outcome.id,
          observedAt: now,
          reason:
            "publication_attestation_missing_or_invalid",
          baselineEventPrefixHash:
            receipt.baselineEventPrefixHash
        })
      ) {
        censoredCount += 1;
      }
      continue;
    }
    if (
      publication.eligibility.publishedAt.toISOString() !==
      receipt.publishedAt
    ) {
      if (input.readyOnly === true) {
        waitingForCoverageCount += 1;
        continue;
      }
      if (
        await censorOutcome({
          prisma: input.prisma,
          outcomeId: outcome.id,
          observedAt: now,
          reason: "publication_time_changed",
          baselineEventPrefixHash:
            receipt.baselineEventPrefixHash
        })
      ) {
        censoredCount += 1;
      }
      continue;
    }
    const usableScan = await selectOutcomeScan({
      prisma: input.prisma,
      courseAlias: decision.courseAlias,
      threadKey: decision.threadKey,
      dueAt: outcome.dueAt,
      now
    });
    if (!usableScan?.finishedAt) {
      if (
        input.readyOnly === true ||
        now.getTime() <
        outcome.dueAt.getTime() + coverageGraceMs
      ) {
        await input.prisma.proximalOutcome.updateMany({
          where: {
            id: outcome.id,
            status: "pending",
            updatedAt: outcome.updatedAt
          },
          data: {
            updatedAt: new Date(
              Math.max(
                now.getTime(),
                outcome.updatedAt.getTime() + 1
              )
            )
          }
        });
        waitingForCoverageCount += 1;
        continue;
      }
      if (
        await censorOutcome({
          prisma: input.prisma,
          outcomeId: outcome.id,
          observedAt: now,
          reason: "complete_scan_missing_after_window",
          baselineEventPrefixHash:
            receipt.baselineEventPrefixHash
        })
      ) {
        censoredCount += 1;
      }
      continue;
    }
    const publishedAt =
      publication.eligibility.publishedAt;
    const [baselineEvents, currentEvents] =
      await Promise.all([
        loadThreadEvents({
          prisma: input.prisma,
          courseAlias: decision.courseAlias,
          threadKey: decision.threadKey,
          occurredThrough: publishedAt,
          observedThrough: publishedAt
        }),
        loadThreadEvents({
          prisma: input.prisma,
          courseAlias: decision.courseAlias,
          threadKey: decision.threadKey,
          occurredThrough: outcome.dueAt,
          observedThrough: usableScan.finishedAt
        })
      ]);
    const baseline = buildEventPrefix(baselineEvents);
    const current = buildEventPrefix(currentEvents);
    if (
      baseline.prefixHash !==
        receipt.baselineEventPrefixHash ||
      !eventPrefixIsContinuous({
        baselineEventKeys: baseline.eventKeys,
        currentEventKeys: current.eventKeys
      })
    ) {
      if (input.readyOnly === true) {
        waitingForCoverageCount += 1;
        continue;
      }
      if (
        await censorOutcome({
          prisma: input.prisma,
          outcomeId: outcome.id,
          observedAt: usableScan.finishedAt,
          reason: "event_prefix_not_continuous",
          baselineEventPrefixHash:
            receipt.baselineEventPrefixHash
        })
      ) {
        censoredCount += 1;
      }
      continue;
    }
    const metrics = summarizePostPublicationEvents({
      baselineEvents,
      currentEvents,
      authorKey: decision.authorKey,
      publishedAt
    });
    const auditPayload = {
      schemaVersion:
        PROXIMAL_OUTCOME_OBSERVATION_SCHEMA_VERSION,
      observationWindow: outcome.observationWindow,
      status: "observed",
      evidenceSource: usableScan.evidenceSource,
      windowEndedAt: outcome.dueAt.toISOString(),
      observedThrough: usableScan.finishedAt.toISOString(),
      eventPrefixHash: current.prefixHash,
      firstExternalReplyAt:
        metrics.firstExternalReplyAt?.toISOString() ?? null,
      authorReturned: metrics.authorReturned,
      replyDepthDelta: metrics.replyDepthDelta,
      newAuthorCount: metrics.newAuthorCount,
      attribution:
        "descriptive_post_publication_observation_not_causal",
      educationalEffectClaimed: false,
      containsForumText: false
    } as const;
    const transitioned = await input.prisma.$transaction(
      async (tx) => {
        const updated =
          await tx.proximalOutcome.updateMany({
            where: {
              id: outcome.id,
              status: "pending"
            },
            data: {
              status: "observed",
              observedAt: usableScan.finishedAt,
              eventPrefixHash: current.prefixHash,
              firstExternalReplyAt:
                metrics.firstExternalReplyAt,
              authorReturned: metrics.authorReturned,
              replyDepthDelta: metrics.replyDepthDelta,
              newAuthorCount: metrics.newAuthorCount,
              functionUptakeJson: JSON.stringify({
                ...auditPayload,
                outcome: "observed",
                baselineEventPrefixHash:
                  baseline.prefixHash,
                observedEventPrefixHash:
                  current.prefixHash,
                semanticFunctionUptake:
                  "not_estimable_from_hash_only_event_ledger"
              }),
              censored: false,
              missingReason: null
            }
          });
        if (updated.count !== 1) return false;
        const evidenceHash = canonicalProtocolHash(
          PROXIMAL_OUTCOME_OBSERVATION_SCHEMA_VERSION,
          auditPayload as unknown as CanonicalJsonValue
        );
        await appendDecisionTapeEntry({
          prisma: tx,
          invocationId: decision.invocationId,
          kind: "proximal_outcome_observed",
          payload: auditPayload as unknown as CanonicalJsonValue
        });
        await tx.reviewEvent.create({
          data: {
            decisionId: decision.id,
            invocationId: decision.invocationId,
            kind: "proximal_outcome_observed",
            outcome: "observed",
            reasonCode: usableScan.evidenceSource,
            evidenceHash,
            containsForumText: false
          }
        });
        return true;
      }
    );
    if (transitioned) observedCount += 1;
  }
  return {
    schemaVersion:
      PROXIMAL_OUTCOME_OBSERVATION_SCHEMA_VERSION,
    asOf: now.toISOString(),
    dueCount: due.length,
    observedCount,
    censoredCount,
    waitingForCoverageCount,
    containsForumText: false
  };
}
