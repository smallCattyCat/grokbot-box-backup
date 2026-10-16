import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import type {
  LiveOpportunityResult
} from "@/lib/live-runtime/facilitation-kernel";
import type {
  LiveUiObservationReceipt
} from "@/lib/ui-agent/live-observation";

export const AUTONOMY_DRAFT_REVALIDATION_SCHEMA_VERSION =
  "cmooc.autonomy-draft-revalidation.v1" as const;

export type AutonomyDraftRevalidationReceipt = {
  schemaVersion: typeof AUTONOMY_DRAFT_REVALIDATION_SCHEMA_VERSION;
  opportunityReceiptHash: string;
  beforeObservationReceiptHash: string;
  afterObservationReceiptHash: string;
  checkedAt: string;
  targetVersionHash: string | null;
  eventSetHash: string | null;
  rereadObserved: boolean;
  newlyObservedExternalHumanEventCount: number;
  newlyObservedDistinctActorEventCount: number;
  newlyObservedAuthorEventCount: number;
  newlyObservedSystemEventCount: number;
  removedPreviouslyObservedEventCount: number;
  changedPreviouslyObservedEventCount: number;
  decision: "EXECUTE" | "YIELD" | "REVIEW";
  reasonCode:
    | "stable_no_human_response"
    | "external_human_response"
    | "distinct_actor_response"
    | "original_author_return"
    | "existing_system_or_agent_response"
    | "target_version_changed"
    | "target_identity_changed"
    | "event_prefix_changed"
    | "source_censored"
    | "candidate_expired"
    | "reread_unavailable";
  shadowContinuationAllowed: boolean;
  editorWriteAllowed: false;
  publishAllowed: false;
  containsForumText: false;
};

function observationHash(
  observation: LiveUiObservationReceipt
): string {
  return canonicalProtocolHash(
    observation.schemaVersion,
    observation as CanonicalJsonValue
  );
}

function normalizedTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("AUTONOMY_REVALIDATION_TIME_INVALID");
  }
  return new Date(value).toISOString();
}

export function buildAutonomyDraftRevalidation(input: {
  opportunity: LiveOpportunityResult;
  beforeObservation: LiveUiObservationReceipt;
  beforeObservationHash: string;
  afterObservation: LiveUiObservationReceipt | null;
  afterObservationHash: string | null;
  checkedAt: string;
}): {
  receipt: AutonomyDraftRevalidationReceipt;
  receiptHash: string;
} {
  const checkedAt = normalizedTime(input.checkedAt);
  const actualBeforeHash = observationHash(input.beforeObservation);
  if (
    input.opportunity.receipt.decision !== "draft" ||
    !input.opportunity.receipt.requiresTargetRevalidation ||
    input.opportunity.receiptHash !==
      canonicalProtocolHash(
        input.opportunity.receipt.schemaVersion,
        input.opportunity.receipt as CanonicalJsonValue
      ) ||
    input.beforeObservationHash !== actualBeforeHash ||
    input.opportunity.receipt.observationReceiptHash !==
      actualBeforeHash ||
    Date.parse(checkedAt) <
      Date.parse(input.opportunity.receipt.assessedAt)
  ) {
    throw new Error("AUTONOMY_REVALIDATION_BINDING_INVALID");
  }

  const afterObservation = input.afterObservation;
  const actualAfterHash = afterObservation
    ? observationHash(afterObservation)
    : canonicalProtocolHash(
        "cmooc.autonomy-reread-unavailable.v1",
        {
          opportunityReceiptHash: input.opportunity.receiptHash,
          checkedAt,
          containsForumText: false
        }
      );
  if (
    afterObservation &&
    input.afterObservationHash !== actualAfterHash
  ) {
    throw new Error("AUTONOMY_REVALIDATION_AFTER_HASH_INVALID");
  }

  const beforeEvents = input.beforeObservation.eventEvidence;
  const afterEvents = afterObservation?.eventEvidence ?? [];
  const beforeByKey = new Map(
    beforeEvents.map((event) => [event.eventKey, event])
  );
  const afterByKey = new Map(
    afterEvents.map((event) => [event.eventKey, event])
  );
  const removedEvents = beforeEvents.filter(
    (event) => !afterByKey.has(event.eventKey)
  );
  const changedEvents = beforeEvents.filter((event) => {
    const after = afterByKey.get(event.eventKey);
    return Boolean(
      after &&
        canonicalProtocolHash(
          "cmooc.live-event-evidence.v1",
          event as CanonicalJsonValue
        ) !==
          canonicalProtocolHash(
            "cmooc.live-event-evidence.v1",
            after as CanonicalJsonValue
          )
    );
  });
  const newEvents = afterEvents.filter(
    (event) => !beforeByKey.has(event.eventKey)
  );
  const newExternal = newEvents.filter(
    (event) => event.actorRelation === "external_human"
  );
  const newAuthor = newEvents.filter(
    (event) =>
      event.parentEventKey !== null &&
      event.actorRelation === "thread_author"
  );
  const newSystem = newEvents.filter(
    (event) => event.actorRelation === "system_or_agent"
  );
  const newDistinct = newEvents.filter(
    (event) =>
      event.parentEventKey !== null &&
      event.actorRelation === "unknown" &&
      event.actorKey !== null &&
      afterObservation?.authorKey !== null &&
      event.actorKey !== afterObservation?.authorKey
  );
  const identityChanged = Boolean(
    afterObservation &&
      (afterObservation.courseKey !==
        input.beforeObservation.courseKey ||
        afterObservation.threadKey !==
          input.beforeObservation.threadKey ||
        afterObservation.authorKey !==
          input.beforeObservation.authorKey ||
        afterObservation.targetLocatorHash !==
          input.beforeObservation.targetLocatorHash ||
        afterObservation.surfaceLocatorHash !==
          input.beforeObservation.surfaceLocatorHash)
  );
  const timeInvalid = Boolean(
    afterObservation &&
      (Date.parse(afterObservation.observedAt) <
        Date.parse(input.beforeObservation.observedAt) ||
        Date.parse(afterObservation.observedAt) >
          Date.parse(checkedAt) ||
        Date.parse(afterObservation.evidenceAsOf) >
          Date.parse(checkedAt))
  );
  const sourceCensored = Boolean(
    afterObservation &&
      (timeInvalid ||
        afterObservation.captureStatus !== "semantic_ready" ||
        !afterObservation.safeToAdvanceToSemanticReview ||
        afterObservation.temporalEvidenceStatus !==
          "live_prefix_observed" ||
        afterObservation.contentRevisionStatus !==
          "live_target_fingerprint_observed" ||
        afterObservation.commentCompleteness !== "complete" ||
        afterObservation.identityBasis !== "stable_platform_ref" ||
        afterObservation.authorRole !== "learner" ||
        afterObservation.authorRoleEvidenceHash === null ||
        afterObservation.authorRoleEvidenceExpiresAt === null ||
        Date.parse(checkedAt) >
          Date.parse(
            afterObservation.authorRoleEvidenceExpiresAt ?? ""
          ) ||
        afterEvents.some(
          (event) => event.actorRelation === "unknown"
        ))
  );
  const targetChanged = Boolean(
    afterObservation &&
      afterObservation.targetVersionHash !==
        input.opportunity.receipt.targetVersionHash
  );
  const candidateExpired = Boolean(
    input.opportunity.receipt.intent &&
      Date.parse(checkedAt) >
        Date.parse(
          input.opportunity.receipt.intent.candidateExpiresAt
        )
  );

  let decision: AutonomyDraftRevalidationReceipt["decision"];
  let reasonCode: AutonomyDraftRevalidationReceipt["reasonCode"];
  if (!afterObservation) {
    decision = "REVIEW";
    reasonCode = "reread_unavailable";
  } else if (newExternal.length > 0) {
    decision = "YIELD";
    reasonCode = "external_human_response";
  } else if (newAuthor.length > 0) {
    decision = "YIELD";
    reasonCode = "original_author_return";
  } else if (newSystem.length > 0) {
    decision = "YIELD";
    reasonCode = "existing_system_or_agent_response";
  } else if (newDistinct.length > 0) {
    decision = "YIELD";
    reasonCode = "distinct_actor_response";
  } else if (identityChanged) {
    decision = "REVIEW";
    reasonCode = "target_identity_changed";
  } else if (targetChanged) {
    decision = "REVIEW";
    reasonCode = "target_version_changed";
  } else if (
    removedEvents.length > 0 ||
    changedEvents.length > 0
  ) {
    decision = "REVIEW";
    reasonCode = "event_prefix_changed";
  } else if (sourceCensored) {
    decision = "REVIEW";
    reasonCode = "source_censored";
  } else if (candidateExpired) {
    decision = "REVIEW";
    reasonCode = "candidate_expired";
  } else {
    decision = "EXECUTE";
    reasonCode = "stable_no_human_response";
  }

  const receipt: AutonomyDraftRevalidationReceipt = {
    schemaVersion: AUTONOMY_DRAFT_REVALIDATION_SCHEMA_VERSION,
    opportunityReceiptHash: input.opportunity.receiptHash,
    beforeObservationReceiptHash: actualBeforeHash,
    afterObservationReceiptHash: actualAfterHash,
    checkedAt,
    targetVersionHash:
      afterObservation?.targetVersionHash ?? null,
    eventSetHash: afterObservation?.eventSetHash ?? null,
    rereadObserved: afterObservation !== null,
    newlyObservedExternalHumanEventCount: newExternal.length,
    newlyObservedDistinctActorEventCount: newDistinct.length,
    newlyObservedAuthorEventCount: newAuthor.length,
    newlyObservedSystemEventCount: newSystem.length,
    removedPreviouslyObservedEventCount: removedEvents.length,
    changedPreviouslyObservedEventCount: changedEvents.length,
    decision,
    reasonCode,
    shadowContinuationAllowed: decision === "EXECUTE",
    editorWriteAllowed: false,
    publishAllowed: false,
    containsForumText: false
  };
  return {
    receipt,
    receiptHash: canonicalProtocolHash(
      receipt.schemaVersion,
      receipt as unknown as CanonicalJsonValue
    )
  };
}
