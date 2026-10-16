import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import type { LiveUiObservationReceipt } from "@/lib/ui-agent/live-observation";
import type { LiveOpportunityReceipt } from "./facilitation-kernel";
import type { LiveRevalidationReceipt } from "./revalidation";
import { bindTrustedRuntimeTime } from "./trusted-clock";

export const DRAFT_STAGING_CAPTURE_SCHEMA_VERSION =
  "cmooc.live-draft-staging-capture.v1" as const;
export const DRAFT_STAGING_RECEIPT_SCHEMA_VERSION =
  "cmooc.live-draft-staging-receipt.v1" as const;

export type DraftStagingCapture = {
  schemaVersion: typeof DRAFT_STAGING_CAPTURE_SCHEMA_VERSION;
  opportunityReceiptHash: string;
  revalidationReceiptHash: string;
  afterObservationReceiptHash: string;
  guardReceiptHash: string;
  observedAt: string;
  targetVersionHash: string;
  draftContentHash: string;
  editorValueHash: string | null;
  editorWriteOutcome: "verified" | "failed" | "unknown";
  networkGuardAttachedBeforeTyping: true;
  localUiMutationPerformed: true;
  remoteWriteSent: false;
  sentMutationCount: 0;
  publishControlActivated: false;
  submitKeyboardShortcutUsed: false;
  formSubmitTriggered: false;
  publishNetworkRequestCount: 0;
  externalPublishAttempted: false;
  containsForumText: false;
};

export type DraftStagingReceipt = {
  schemaVersion: typeof DRAFT_STAGING_RECEIPT_SCHEMA_VERSION;
  stagingKey: string;
  opportunityReceiptHash: string;
  revalidationReceiptHash: string;
  afterObservationReceiptHash: string;
  guardReceiptHash: string;
  driverSessionKey: string;
  observedAt: string;
  targetVersionHash: string;
  draftContentHash: string;
  editorValueHash: string | null;
  state:
    | "DRAFT_STAGED_NOT_PUBLISHED"
    | "DRAFT_WRITE_FAILED"
    | "DRAFT_WRITE_OUTCOME_UNKNOWN";
  localUiMutationPerformed: true;
  remoteWriteSent: false;
  sentMutationCount: 0;
  publishAttempted: false;
  publishVerified: false;
  realPublishEnabled: false;
  bodyPersisted: false;
  containsForumText: false;
};

const CAPTURE_KEYS = new Set([
  "schemaVersion",
  "opportunityReceiptHash",
  "revalidationReceiptHash",
  "afterObservationReceiptHash",
  "guardReceiptHash",
  "observedAt",
  "targetVersionHash",
  "draftContentHash",
  "editorValueHash",
  "editorWriteOutcome",
  "networkGuardAttachedBeforeTyping",
  "localUiMutationPerformed",
  "remoteWriteSent",
  "sentMutationCount",
  "publishControlActivated",
  "submitKeyboardShortcutUsed",
  "formSubmitTriggered",
  "publishNetworkRequestCount",
  "externalPublishAttempted",
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

function optionalSha256(
  value: unknown,
  label: string
): string | null {
  return value === null ? null : sha256(value, label);
}

function isoTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}必须是有效时间。`);
  }
  return new Date(value).toISOString();
}

export function parseDraftStagingCapture(
  value: unknown
): DraftStagingCapture {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("草稿写入回执必须是对象。");
  }
  const input = value as Record<string, unknown>;
  const extra = Object.keys(input).filter(
    (key) => !CAPTURE_KEYS.has(key)
  );
  if (extra.length > 0) {
    throw new Error(
      `草稿写入回执包含未允许字段：${extra.sort().join("、")}。`
    );
  }
  if (
    input.schemaVersion !==
      DRAFT_STAGING_CAPTURE_SCHEMA_VERSION ||
    input.containsForumText !== false ||
    input.networkGuardAttachedBeforeTyping !== true ||
    input.localUiMutationPerformed !== true ||
    input.remoteWriteSent !== false ||
    input.sentMutationCount !== 0 ||
    input.publishControlActivated !== false ||
    input.submitKeyboardShortcutUsed !== false ||
    input.formSubmitTriggered !== false ||
    input.publishNetworkRequestCount !== 0 ||
    input.externalPublishAttempted !== false
  ) {
    throw new Error("草稿写入越过了仅本地、未发布边界。");
  }
  if (
    input.editorWriteOutcome !== "verified" &&
    input.editorWriteOutcome !== "failed" &&
    input.editorWriteOutcome !== "unknown"
  ) {
    throw new Error("编辑器写入结果无效。");
  }
  const editorValueHash = optionalSha256(
    input.editorValueHash,
    "编辑器值哈希"
  );
  if (
    input.editorWriteOutcome === "verified" &&
    editorValueHash === null
  ) {
    throw new Error("已核验写入必须提供编辑器值哈希。");
  }
  return {
    schemaVersion: DRAFT_STAGING_CAPTURE_SCHEMA_VERSION,
    opportunityReceiptHash: sha256(
      input.opportunityReceiptHash,
      "机会回执哈希"
    ),
    revalidationReceiptHash: sha256(
      input.revalidationReceiptHash,
      "重读回执哈希"
    ),
    afterObservationReceiptHash: sha256(
      input.afterObservationReceiptHash,
      "重读观察回执哈希"
    ),
    guardReceiptHash: sha256(
      input.guardReceiptHash,
      "网络守卫回执哈希"
    ),
    observedAt: isoTime(input.observedAt, "草稿写入观察时间"),
    targetVersionHash: sha256(
      input.targetVersionHash,
      "目标版本哈希"
    ),
    draftContentHash: sha256(
      input.draftContentHash,
      "草稿内容哈希"
    ),
    editorValueHash,
    editorWriteOutcome: input.editorWriteOutcome,
    networkGuardAttachedBeforeTyping: true,
    localUiMutationPerformed: true,
    remoteWriteSent: false,
    sentMutationCount: 0,
    publishControlActivated: false,
    submitKeyboardShortcutUsed: false,
    formSubmitTriggered: false,
    publishNetworkRequestCount: 0,
    externalPublishAttempted: false,
    containsForumText: false
  };
}

export function buildDraftStagingReceipt(input: {
  capture: DraftStagingCapture;
  opportunity: LiveOpportunityReceipt;
  revalidation: LiveRevalidationReceipt;
  afterObservation: LiveUiObservationReceipt;
  trustedNow: string;
}): {
  receipt: DraftStagingReceipt;
  receiptHash: string;
} {
  const opportunity = input.opportunity;
  const revalidation = input.revalidation;
  const afterObservation = input.afterObservation;
  const capture: DraftStagingCapture = {
    ...input.capture,
    observedAt: bindTrustedRuntimeTime({
      claimedAt: input.capture.observedAt,
      trustedNow: input.trustedNow,
      label: "草稿暂存时间"
    })
  };
  if (
    revalidation.decision !== "DRAFT_STAGING_ALLOWED" ||
    !revalidation.draftStagingAllowed
  ) {
    throw new Error("重读未放行，不能把草稿写入真实编辑器。");
  }
  const actualOpportunityReceiptHash = canonicalProtocolHash(
    opportunity.schemaVersion,
    opportunity as CanonicalJsonValue
  );
  const actualRevalidationReceiptHash = canonicalProtocolHash(
    revalidation.schemaVersion,
    revalidation as CanonicalJsonValue
  );
  if (
    actualOpportunityReceiptHash !==
      capture.opportunityReceiptHash ||
    actualRevalidationReceiptHash !==
      capture.revalidationReceiptHash ||
    revalidation.opportunityReceiptHash !==
      capture.opportunityReceiptHash ||
    revalidation.beforeObservationReceiptHash !==
      opportunity.observationReceiptHash ||
    revalidation.afterObservationReceiptHash !==
      capture.afterObservationReceiptHash
  ) {
    throw new Error("草稿暂存链未绑定到同一机会与重读回执。");
  }
  const actualAfterObservationHash = canonicalProtocolHash(
    afterObservation.schemaVersion,
    afterObservation as CanonicalJsonValue
  );
  if (
    actualAfterObservationHash !==
      capture.afterObservationReceiptHash ||
    actualAfterObservationHash !==
      revalidation.afterObservationReceiptHash ||
    afterObservation.attestationLevel !== "same_tab_guarded" ||
    !afterObservation.networkGuardAttached ||
    afterObservation.guardReceiptHash === null ||
    afterObservation.guardObservedAt === null ||
    afterObservation.guardExpiresAt === null ||
    capture.guardReceiptHash !==
      afterObservation.guardReceiptHash ||
    afterObservation.sentMutationCount !== 0
  ) {
    throw new Error("草稿写入缺少同标签页零写网络守卫。");
  }
  if (
    Date.parse(capture.observedAt) <
      Date.parse(afterObservation.guardObservedAt) ||
    Date.parse(capture.observedAt) >
      Date.parse(afterObservation.guardExpiresAt)
  ) {
    throw new Error("草稿写入使用的同标签页网络守卫已经失效。");
  }
  if (
    capture.targetVersionHash !== opportunity.targetVersionHash ||
    capture.targetVersionHash !== revalidation.targetVersionHash
  ) {
    throw new Error("草稿写入目标版本与重读版本不一致。");
  }
  if (
    !opportunity.draftContentHash ||
    capture.draftContentHash !== opportunity.draftContentHash
  ) {
    throw new Error("草稿内容与资格链生成内容不一致。");
  }
  if (
    Date.parse(capture.observedAt) <
      Date.parse(revalidation.checkedAt) ||
    !opportunity.intent ||
    Date.parse(capture.observedAt) >
      Date.parse(opportunity.intent.candidateExpiresAt)
  ) {
    throw new Error("草稿写入必须发生在重读之后且候选失效之前。");
  }
  const state: DraftStagingReceipt["state"] =
    capture.editorWriteOutcome === "verified" &&
    capture.editorValueHash === capture.draftContentHash
      ? "DRAFT_STAGED_NOT_PUBLISHED"
      : capture.editorWriteOutcome === "unknown"
        ? "DRAFT_WRITE_OUTCOME_UNKNOWN"
        : "DRAFT_WRITE_FAILED";
  const receiptWithoutKey = {
    schemaVersion: DRAFT_STAGING_RECEIPT_SCHEMA_VERSION,
    opportunityReceiptHash: capture.opportunityReceiptHash,
    revalidationReceiptHash: capture.revalidationReceiptHash,
    afterObservationReceiptHash:
      capture.afterObservationReceiptHash,
    guardReceiptHash: capture.guardReceiptHash,
    driverSessionKey: afterObservation.driverSessionKey,
    observedAt: capture.observedAt,
    targetVersionHash: capture.targetVersionHash,
    draftContentHash: capture.draftContentHash,
    editorValueHash: capture.editorValueHash,
    state,
    localUiMutationPerformed: true as const,
    remoteWriteSent: false as const,
    sentMutationCount: 0 as const,
    publishAttempted: false as const,
    publishVerified: false as const,
    realPublishEnabled: false as const,
    bodyPersisted: false as const,
    containsForumText: false as const
  };
  const stagingKey = canonicalProtocolHash(
    DRAFT_STAGING_RECEIPT_SCHEMA_VERSION,
    receiptWithoutKey as CanonicalJsonValue
  );
  const receipt: DraftStagingReceipt = {
    ...receiptWithoutKey,
    stagingKey
  };
  return {
    receipt,
    receiptHash: canonicalProtocolHash(
      receipt.schemaVersion,
      receipt as CanonicalJsonValue
    )
  };
}
