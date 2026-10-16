import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";

export const DRAFT_TRANSPORT_SMOKE_CAPTURE_SCHEMA_VERSION =
  "cmooc.draft-transport-smoke-capture.v1" as const;
export const DRAFT_TRANSPORT_SMOKE_RECEIPT_SCHEMA_VERSION =
  "cmooc.draft-transport-smoke-receipt.v1" as const;

export type DraftTransportSmokeCapture = {
  schemaVersion: typeof DRAFT_TRANSPORT_SMOKE_CAPTURE_SCHEMA_VERSION;
  courseLocatorHash: string;
  targetLocatorHash: string;
  observedAt: string;
  commentCountBefore: number;
  targetReobservedBeforeTyping: true;
  draftContentHash: string;
  editorValueHash: string;
  editorWriteOutcome: "verified";
  networkGuardStatus: "unavailable_in_chrome_plugin";
  publishControlActivated: false;
  submitKeyboardShortcutUsed: false;
  formSubmitTriggered: false;
  externalPublishAttempted: false;
  containsForumText: false;
};

export type DraftTransportSmokeReceipt = {
  schemaVersion: typeof DRAFT_TRANSPORT_SMOKE_RECEIPT_SCHEMA_VERSION;
  smokeKey: string;
  courseLocatorHash: string;
  targetLocatorHash: string;
  observedAt: string;
  commentCountBefore: number;
  draftContentHash: string;
  editorValueHash: string;
  state: "TRANSPORT_SMOKE_DRAFT_VISIBLE_NOT_SUBMITTED";
  editorReadbackVerified: true;
  certifiedRuntimeStage: false;
  certificationBlocker: "network_guard_unavailable";
  publishAttempted: false;
  eligibleForPublish: false;
  bodyPersisted: false;
  containsForumText: false;
};

const CAPTURE_KEYS = new Set([
  "schemaVersion",
  "courseLocatorHash",
  "targetLocatorHash",
  "observedAt",
  "commentCountBefore",
  "targetReobservedBeforeTyping",
  "draftContentHash",
  "editorValueHash",
  "editorWriteOutcome",
  "networkGuardStatus",
  "publishControlActivated",
  "submitKeyboardShortcutUsed",
  "formSubmitTriggered",
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

export function parseDraftTransportSmokeCapture(
  value: unknown
): DraftTransportSmokeCapture {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("草稿传输验证必须是对象。");
  }
  const input = value as Record<string, unknown>;
  const extra = Object.keys(input).filter(
    (key) => !CAPTURE_KEYS.has(key)
  );
  if (extra.length > 0) {
    throw new Error(
      `草稿传输验证包含未允许字段：${extra.sort().join("、")}。`
    );
  }
  if (
    input.schemaVersion !==
      DRAFT_TRANSPORT_SMOKE_CAPTURE_SCHEMA_VERSION ||
    input.targetReobservedBeforeTyping !== true ||
    input.editorWriteOutcome !== "verified" ||
    input.networkGuardStatus !==
      "unavailable_in_chrome_plugin" ||
    input.publishControlActivated !== false ||
    input.submitKeyboardShortcutUsed !== false ||
    input.formSubmitTriggered !== false ||
    input.externalPublishAttempted !== false ||
    input.containsForumText !== false
  ) {
    throw new Error("草稿传输验证越过了未提交边界。");
  }
  if (
    typeof input.commentCountBefore !== "number" ||
    !Number.isSafeInteger(input.commentCountBefore) ||
    input.commentCountBefore < 0
  ) {
    throw new Error("写入前评论数必须是非负安全整数。");
  }
  if (
    typeof input.observedAt !== "string" ||
    !Number.isFinite(Date.parse(input.observedAt))
  ) {
    throw new Error("草稿传输验证时间无效。");
  }
  const draftContentHash = sha256(
    input.draftContentHash,
    "草稿内容哈希"
  );
  const editorValueHash = sha256(
    input.editorValueHash,
    "编辑器值哈希"
  );
  if (draftContentHash !== editorValueHash) {
    throw new Error("编辑器回读内容与草稿内容不一致。");
  }
  return {
    schemaVersion: DRAFT_TRANSPORT_SMOKE_CAPTURE_SCHEMA_VERSION,
    courseLocatorHash: sha256(
      input.courseLocatorHash,
      "课程定位哈希"
    ),
    targetLocatorHash: sha256(
      input.targetLocatorHash,
      "目标定位哈希"
    ),
    observedAt: new Date(input.observedAt).toISOString(),
    commentCountBefore: input.commentCountBefore,
    targetReobservedBeforeTyping: true,
    draftContentHash,
    editorValueHash,
    editorWriteOutcome: "verified",
    networkGuardStatus: "unavailable_in_chrome_plugin",
    publishControlActivated: false,
    submitKeyboardShortcutUsed: false,
    formSubmitTriggered: false,
    externalPublishAttempted: false,
    containsForumText: false
  };
}

export function buildDraftTransportSmokeReceipt(
  capture: DraftTransportSmokeCapture
): {
  receipt: DraftTransportSmokeReceipt;
  receiptHash: string;
} {
  const receiptWithoutKey = {
    schemaVersion: DRAFT_TRANSPORT_SMOKE_RECEIPT_SCHEMA_VERSION,
    courseLocatorHash: capture.courseLocatorHash,
    targetLocatorHash: capture.targetLocatorHash,
    observedAt: capture.observedAt,
    commentCountBefore: capture.commentCountBefore,
    draftContentHash: capture.draftContentHash,
    editorValueHash: capture.editorValueHash,
    state: "TRANSPORT_SMOKE_DRAFT_VISIBLE_NOT_SUBMITTED" as const,
    editorReadbackVerified: true as const,
    certifiedRuntimeStage: false as const,
    certificationBlocker: "network_guard_unavailable" as const,
    publishAttempted: false as const,
    eligibleForPublish: false as const,
    bodyPersisted: false as const,
    containsForumText: false as const
  };
  const smokeKey = canonicalProtocolHash(
    DRAFT_TRANSPORT_SMOKE_RECEIPT_SCHEMA_VERSION,
    receiptWithoutKey as CanonicalJsonValue
  );
  const receipt: DraftTransportSmokeReceipt = {
    ...receiptWithoutKey,
    smokeKey
  };
  return {
    receipt,
    receiptHash: canonicalProtocolHash(
      receipt.schemaVersion,
      receipt as CanonicalJsonValue
    )
  };
}
