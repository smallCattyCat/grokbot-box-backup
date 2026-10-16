import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import type { LiveUiObservationReceipt } from "@/lib/ui-agent/live-observation";
import type { LiveOpportunityReceipt } from "./facilitation-kernel";
import { bindTrustedRuntimeTime } from "./trusted-clock";

export const LIVE_REVALIDATION_CAPTURE_SCHEMA_VERSION =
  "cmooc.live-target-revalidation-capture.v1" as const;
export const LIVE_REVALIDATION_RECEIPT_SCHEMA_VERSION =
  "cmooc.live-target-revalidation-receipt.v2" as const;

export type LiveRevalidationCapture = {
  schemaVersion: typeof LIVE_REVALIDATION_CAPTURE_SCHEMA_VERSION;
  opportunityReceiptHash: string;
  afterObservationReceiptHash: string;
  checkedAt: string;
  containsForumText: false;
};

export type LiveRevalidationReceipt = {
  schemaVersion: typeof LIVE_REVALIDATION_RECEIPT_SCHEMA_VERSION;
  revalidationKey: string;
  opportunityReceiptHash: string;
  beforeObservationReceiptHash: string;
  afterObservationReceiptHash: string;
  checkedAt: string;
  targetVersionHash: string;
  eventSetHash: string;
  newlyObservedExternalHumanEventCount: number;
  newlyObservedDistinctActorEventCount: number;
  newlyObservedAuthorEventCount: number;
  newlyObservedSystemEventCount: number;
  removedPreviouslyObservedEventCount: number;
  decision:
    | "DRAFT_STAGING_ALLOWED"
    | "WITHDRAWN_EXTERNAL_HUMAN_RESPONSE"
    | "WITHDRAWN_DISTINCT_ACTOR_RESPONSE"
    | "WITHDRAWN_ORIGINAL_AUTHOR_RETURN"
    | "WITHDRAWN_EXISTING_SYSTEM_RESPONSE"
    | "REVIEW_REQUIRED_TARGET_CHANGED"
    | "REVIEW_REQUIRED_SOURCE_CENSORED"
    | "REVIEW_REQUIRED_CANDIDATE_EXPIRED";
  reasonCode:
    | "stable_no_human_response"
    | "external_human_response"
    | "distinct_actor_response"
    | "original_author_return"
    | "existing_system_or_agent_response"
    | "target_version_changed"
    | "source_censored"
    | "candidate_expired";
  draftStagingAllowed: boolean;
  publishAllowed: false;
  containsForumText: false;
};

const CAPTURE_KEYS = new Set([
  "schemaVersion",
  "opportunityReceiptHash",
  "afterObservationReceiptHash",
  "checkedAt",
  "containsForumText"
]);

function sha256(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{64}$/i.test(value)
  ) {
    throw new Error(`${label}必须是 SHA-256 十六进制摘要。`);
  }
  return value.toLowerCase();
}

function isoTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}必须是有效时间。`);
  }
  return new Date(value).toISOString();
}

export function parseLiveRevalidationCapture(
  value: unknown
): LiveRevalidationCapture {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("目标重读必须是对象。");
  }
  const input = value as Record<string, unknown>;
  const extra = Object.keys(input).filter(
    (key) => !CAPTURE_KEYS.has(key)
  );
  if (extra.length > 0) {
    throw new Error(
      `目标重读包含未允许字段：${extra.sort().join("、")}。`
    );
  }
  if (
    input.schemaVersion !==
      LIVE_REVALIDATION_CAPTURE_SCHEMA_VERSION ||
    input.containsForumText !== false
  ) {
    throw new Error("目标重读 schema 或去正文边界无效。");
  }
  return {
    schemaVersion: LIVE_REVALIDATION_CAPTURE_SCHEMA_VERSION,
    opportunityReceiptHash: sha256(
      input.opportunityReceiptHash,
      "机会回执哈希"
    ),
    afterObservationReceiptHash: sha256(
      input.afterObservationReceiptHash,
      "重读观察回执哈希"
    ),
    checkedAt: isoTime(input.checkedAt, "重读核对时间"),
    containsForumText: false
  };
}

function receiptHash(receipt: LiveUiObservationReceipt): string {
  return canonicalProtocolHash(
    receipt.schemaVersion,
    receipt as CanonicalJsonValue
  );
}

export function buildLiveRevalidation(input: {
  capture: LiveRevalidationCapture;
  opportunity: LiveOpportunityReceipt;
  beforeObservation: LiveUiObservationReceipt;
  afterObservation: LiveUiObservationReceipt;
  trustedNow: string;
}): {
  receipt: LiveRevalidationReceipt;
  receiptHash: string;
} {
  const opportunity = input.opportunity;
  const beforeObservation = input.beforeObservation;
  const afterObservation = input.afterObservation;
  const capture: LiveRevalidationCapture = {
    ...input.capture,
    checkedAt: bindTrustedRuntimeTime({
      claimedAt: input.capture.checkedAt,
      trustedNow: input.trustedNow,
      label: "目标重读时间"
    })
  };
  if (
    opportunity.decision !== "draft" ||
    !opportunity.requiresTargetRevalidation ||
    !opportunity.draftContentHash ||
    !opportunity.intent
  ) {
    throw new Error("只有已通过资格链的草稿机会可以重读。");
  }
  const actualOpportunityReceiptHash = canonicalProtocolHash(
    opportunity.schemaVersion,
    opportunity as CanonicalJsonValue
  );
  if (
    actualOpportunityReceiptHash !==
      capture.opportunityReceiptHash
  ) {
    throw new Error("目标重读引用了不同的机会回执。");
  }
  const beforeHash = receiptHash(beforeObservation);
  const afterHash = receiptHash(afterObservation);
  if (
    beforeHash !== opportunity.observationReceiptHash ||
    afterHash !== capture.afterObservationReceiptHash
  ) {
    throw new Error("目标重读引用了不同的前后观察回执。");
  }
  if (
    beforeObservation.courseKey !== afterObservation.courseKey ||
    beforeObservation.threadKey === null ||
    beforeObservation.threadKey !== afterObservation.threadKey ||
    beforeObservation.authorKey === null ||
    beforeObservation.authorKey !== afterObservation.authorKey ||
    beforeObservation.surfaceLocatorHash !==
      afterObservation.surfaceLocatorHash ||
    beforeObservation.driverSessionKey !==
      afterObservation.driverSessionKey
  ) {
    throw new Error("目标重读必须保持同课程、同线程和同驱动会话。");
  }
  if (
    Date.parse(capture.checkedAt) <
      Date.parse(opportunity.assessedAt) ||
    Date.parse(afterObservation.observedAt) >
      Date.parse(capture.checkedAt) ||
    Date.parse(afterObservation.evidenceAsOf) >
      Date.parse(capture.checkedAt) ||
    Date.parse(afterObservation.observedAt) <
      Date.parse(beforeObservation.observedAt)
  ) {
    throw new Error("目标重读时间顺序无效。");
  }

  const beforeEventKeys = new Set(
    beforeObservation.eventEvidence.map((event) => event.eventKey)
  );
  const afterEventsByKey = new Map(
    afterObservation.eventEvidence.map((event) => [
      event.eventKey,
      event
    ])
  );
  const removedPreviouslyObservedEvents =
    beforeObservation.eventEvidence.filter(
      (event) => !afterEventsByKey.has(event.eventKey)
    );
  const changedPreviouslyObservedEvents =
    beforeObservation.eventEvidence.filter((event) => {
      const afterEvent = afterEventsByKey.get(event.eventKey);
      return (
        afterEvent !== undefined &&
        canonicalProtocolHash(
          "cmooc.live-event-evidence.v1",
          event as CanonicalJsonValue
        ) !==
          canonicalProtocolHash(
            "cmooc.live-event-evidence.v1",
            afterEvent as CanonicalJsonValue
          )
      );
    });
  const newlyObservedEvents =
    afterObservation.eventEvidence.filter(
      (event) => !beforeEventKeys.has(event.eventKey)
    );
  const newExternalHumanEvents = newlyObservedEvents.filter(
    (event) => event.actorRelation === "external_human"
  );
  const newAuthorEvents = newlyObservedEvents.filter(
    (event) => event.actorRelation === "thread_author"
  );
  const newSystemEvents = newlyObservedEvents.filter(
    (event) => event.actorRelation === "system_or_agent"
  );
  const newUnknownEvents = newlyObservedEvents.filter(
    (event) => event.actorRelation === "unknown"
  );
  const newDistinctActorEvents = newUnknownEvents.filter(
    (event) =>
      event.parentEventKey !== null &&
      event.actorKey !== null &&
      afterObservation.authorKey !== null &&
      event.actorKey !== afterObservation.authorKey
  );
  const sourceCensored =
    afterObservation.captureStatus !== "semantic_ready" ||
    !afterObservation.safeToAdvanceToSemanticReview ||
    afterObservation.temporalEvidenceStatus !==
      "live_prefix_observed" ||
    afterObservation.contentRevisionStatus !==
      "live_target_fingerprint_observed" ||
    afterObservation.commentCompleteness !== "complete" ||
    afterObservation.identityBasis !== "stable_platform_ref" ||
    afterObservation.attestationLevel !== "same_tab_guarded" ||
    afterObservation.guardReceiptHash === null ||
    afterObservation.guardObservedAt === null ||
    afterObservation.guardExpiresAt === null ||
    Date.parse(afterObservation.guardObservedAt) >
      Date.parse(capture.checkedAt) ||
    Date.parse(capture.checkedAt) >
      Date.parse(afterObservation.guardExpiresAt) ||
    afterObservation.authorRole !== "learner" ||
    afterObservation.authorRoleEvidenceHash === null ||
    afterObservation.authorRoleEvidenceExpiresAt === null ||
    Date.parse(capture.checkedAt) >
      Date.parse(afterObservation.authorRoleEvidenceExpiresAt) ||
    removedPreviouslyObservedEvents.length > 0 ||
    changedPreviouslyObservedEvents.length > 0 ||
    newUnknownEvents.length > 0 ||
    afterObservation.eventEvidence.some(
      (event) => event.actorRelation === "unknown"
    );
  const candidateExpired =
    Date.parse(capture.checkedAt) >
    Date.parse(opportunity.intent.candidateExpiresAt);

  let decision: LiveRevalidationReceipt["decision"];
  let reasonCode: LiveRevalidationReceipt["reasonCode"];
  if (newExternalHumanEvents.length > 0) {
    decision = "WITHDRAWN_EXTERNAL_HUMAN_RESPONSE";
    reasonCode = "external_human_response";
  } else if (newAuthorEvents.length > 0) {
    decision = "WITHDRAWN_ORIGINAL_AUTHOR_RETURN";
    reasonCode = "original_author_return";
  } else if (newSystemEvents.length > 0) {
    decision = "WITHDRAWN_EXISTING_SYSTEM_RESPONSE";
    reasonCode = "existing_system_or_agent_response";
  } else if (newDistinctActorEvents.length > 0) {
    decision = "WITHDRAWN_DISTINCT_ACTOR_RESPONSE";
    reasonCode = "distinct_actor_response";
  } else if (sourceCensored) {
    decision = "REVIEW_REQUIRED_SOURCE_CENSORED";
    reasonCode = "source_censored";
  } else if (
    afterObservation.targetVersionHash !==
    opportunity.targetVersionHash
  ) {
    decision = "REVIEW_REQUIRED_TARGET_CHANGED";
    reasonCode = "target_version_changed";
  } else if (candidateExpired) {
    decision = "REVIEW_REQUIRED_CANDIDATE_EXPIRED";
    reasonCode = "candidate_expired";
  } else {
    decision = "DRAFT_STAGING_ALLOWED";
    reasonCode = "stable_no_human_response";
  }
  if (!afterObservation.targetVersionHash || !afterObservation.eventSetHash) {
    throw new Error("重读观察缺少目标或事件集合哈希。");
  }
  const receiptWithoutKey = {
    schemaVersion: LIVE_REVALIDATION_RECEIPT_SCHEMA_VERSION,
    opportunityReceiptHash: capture.opportunityReceiptHash,
    beforeObservationReceiptHash: beforeHash,
    afterObservationReceiptHash: afterHash,
    checkedAt: capture.checkedAt,
    targetVersionHash: afterObservation.targetVersionHash,
    eventSetHash: afterObservation.eventSetHash,
    newlyObservedExternalHumanEventCount:
      newExternalHumanEvents.length,
    newlyObservedDistinctActorEventCount:
      newDistinctActorEvents.length,
    newlyObservedAuthorEventCount: newAuthorEvents.length,
    newlyObservedSystemEventCount: newSystemEvents.length,
    removedPreviouslyObservedEventCount:
      removedPreviouslyObservedEvents.length,
    decision,
    reasonCode,
    draftStagingAllowed: decision === "DRAFT_STAGING_ALLOWED",
    publishAllowed: false as const,
    containsForumText: false as const
  };
  const revalidationKey = canonicalProtocolHash(
    LIVE_REVALIDATION_RECEIPT_SCHEMA_VERSION,
    receiptWithoutKey as CanonicalJsonValue
  );
  const receipt: LiveRevalidationReceipt = {
    ...receiptWithoutKey,
    revalidationKey
  };
  return {
    receipt,
    receiptHash: canonicalProtocolHash(
      receipt.schemaVersion,
      receipt as CanonicalJsonValue
    )
  };
}
