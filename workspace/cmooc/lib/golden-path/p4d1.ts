import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import fixtureJson from "@/fixtures/p4d1/golden-path-resource-connection-v1.json";
import {
  CANONICAL_HASH_ALGORITHM,
  PROTOCOL_SCHEMA_VERSIONS,
  assertDecisionEvidenceRefSemantics,
  assertMoveSpecMatchesIntent,
  canonicalProtocolHash,
  parseProtocolObject,
  type CanonicalJsonValue,
  type DecisionEvidenceRefV1,
  type FacilitationMoveSpecV1,
  type InterventionIntentV1,
  type ReviewBundleV1
} from "@/lib/facilitation-protocol";

export const P4D1_FIXTURE_SCHEMA_VERSION =
  "cmooc.p4d1-golden-path-fixture.v1" as const;
export const P4D1_REVIEW_RECEIPT_SCHEMA_VERSION =
  "cmooc.p4d1-local-review-receipt.v1" as const;
export const P4D1_EVIDENCE_SCHEMA_VERSION =
  "cmooc.p4d1-rq3-trace-evidence.v1" as const;

type P4D1Fixture = {
  schemaVersion: typeof P4D1_FIXTURE_SCHEMA_VERSION;
  fixtureId: string;
  fixtureKind: "synthetic";
  fixedClock: string;
  candidateExpiresAt: string;
  title: string;
  syntheticSourceText: string;
  resourceTitle: string;
  applicationQuestion: string;
  whyNow: string;
  whyTarget: string;
  budgetBasis: string;
  priorityRank: number;
  candidateCount: number;
  budgetSlots: number;
  workloadCost: number;
  policyVersion: string;
  budgetVersion: string;
  moveSpecVersion: string;
  snapshotKey: string;
  threadKey: string;
  courseKey: string;
  authorKey: string;
  year: 2024;
  split: "development";
  decisionAt: string;
  temporalContractHash: string;
  featureHash: string;
  targetVersionHash: string;
  contentRevisionStatus: "decision_time_version_verified";
};

export type P4D1ReviewDecision = "accept" | "modify" | "reject";

export type P4D1LocalReviewReceipt = {
  schemaVersion: typeof P4D1_REVIEW_RECEIPT_SCHEMA_VERSION;
  fixtureId: string;
  correlationId: string;
  decision: P4D1ReviewDecision;
  reviewedAt: string;
  evidenceRefHash: string;
  intentHash: string;
  moveSpecHash: string;
  reviewBundleHash: string;
  targetHash: string;
  originalDraftHash: string;
  finalDraftHash: string | null;
  wasEdited: boolean;
  contentRevisionStatus: "decision_time_version_verified";
  realPublishEnabled: false;
  externalWriteAttempted: false;
  containsForumText: false;
};

export type P4D1ReviewCase = {
  schemaVersion: "cmooc.p4d1-review-case.v1";
  fixtureId: string;
  fixtureKind: "synthetic";
  fixedClock: string;
  title: string;
  syntheticSourceText: string;
  contentRevisionStatus: "decision_time_version_verified";
  candidate: {
    whyNow: string;
    whyTarget: string;
    budgetBasis: string;
    priorityRank: number;
    candidateCount: number;
    budgetSlots: number;
    decisionAt: string;
    candidateExpiresAt: string;
  };
  evidenceRef: DecisionEvidenceRefV1;
  evidenceRefHash: string;
  intent: InterventionIntentV1;
  intentHash: string;
  moveSpec: FacilitationMoveSpecV1;
  moveSpecHash: string;
  deterministicDraft: string;
  reviewBundle: ReviewBundleV1;
  reviewBundleHash: string;
  targetHash: string;
  externalWriteCapability: false;
  containsForumTextInProtocol: false;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseFixture(input: unknown): P4D1Fixture {
  if (!input || typeof input !== "object") {
    throw new Error("P4D-1 fixture 必须是对象。");
  }
  const fixture = input as Partial<P4D1Fixture>;
  if (
    fixture.schemaVersion !== P4D1_FIXTURE_SCHEMA_VERSION ||
    fixture.fixtureKind !== "synthetic" ||
    fixture.year !== 2024 ||
    fixture.split !== "development" ||
    fixture.contentRevisionStatus !== "decision_time_version_verified"
  ) {
    throw new Error("P4D-1 fixture 不满足合成数据、2024 development 或正文版本边界。");
  }
  for (const field of [
    "fixtureId",
    "fixedClock",
    "candidateExpiresAt",
    "title",
    "syntheticSourceText",
    "resourceTitle",
    "applicationQuestion",
    "whyNow",
    "whyTarget",
    "budgetBasis",
    "policyVersion",
    "budgetVersion",
    "moveSpecVersion",
    "snapshotKey",
    "threadKey",
    "courseKey",
    "authorKey",
    "decisionAt",
    "temporalContractHash",
    "featureHash",
    "targetVersionHash"
  ] as const) {
    if (typeof fixture[field] !== "string" || !fixture[field]?.trim()) {
      throw new Error(`P4D-1 fixture 缺少 ${field}。`);
    }
  }
  for (const field of [
    "priorityRank",
    "candidateCount",
    "budgetSlots",
    "workloadCost"
  ] as const) {
    if (!Number.isInteger(fixture[field]) || Number(fixture[field]) < 1) {
      throw new Error(`P4D-1 fixture 的 ${field} 必须是正整数。`);
    }
  }
  if (
    Date.parse(fixture.decisionAt!) > Date.parse(fixture.fixedClock!) ||
    Date.parse(fixture.fixedClock!) >= Date.parse(fixture.candidateExpiresAt!)
  ) {
    throw new Error("P4D-1 fixture 的 decisionAt、fixedClock 与过期时间顺序非法。");
  }
  return fixture as P4D1Fixture;
}

function deterministicDraft(fixture: P4D1Fixture): string {
  return [
    "你把“知道概念”和“能在案例中辨认证据”之间的落差说得很清楚。",
    `可以对照${fixture.resourceTitle}，先标出一条“信息从哪里跨过小组边界”的互动证据。`,
    `再回到你的问题想一想：${fixture.applicationQuestion}`,
    "欢迎你用两三句话试着解释，也可以邀请同伴补充另一条证据。"
  ].join("");
}

export function buildP4D1ReviewCase(
  input: unknown = fixtureJson
): P4D1ReviewCase {
  const fixture = parseFixture(input);
  const evidenceRef = assertDecisionEvidenceRefSemantics({
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.decisionEvidenceRef,
    snapshotKey: fixture.snapshotKey,
    threadKey: fixture.threadKey,
    courseKey: fixture.courseKey,
    authorKey: fixture.authorKey,
    year: fixture.year,
    split: fixture.split,
    decisionAt: fixture.decisionAt,
    snapshotSchemaVersion: "cmooc-decision-snapshot-v1",
    temporalContractVersion: "cmooc-decision-snapshot-temporal-contract-v2",
    temporalContractHash: fixture.temporalContractHash,
    featureHash: fixture.featureHash,
    timeBasis: "naive_platform_local_time_no_dst_adjustment",
    temporalEvidenceStatus: "as_of_verified",
    contentRevisionStatus: "not_included",
    containsForumText: false
  });
  const evidenceRefHash = canonicalProtocolHash(
    evidenceRef.schemaVersion,
    evidenceRef
  );
  const intent = parseProtocolObject("interventionIntent", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.interventionIntent,
    evidenceRefHash,
    evidenceAsOf: fixture.decisionAt,
    intervene: true,
    facilitationFunction: "resource_connection",
    targetObject: "thread_author",
    workloadCost: fixture.workloadCost,
    candidateExpiresAt: fixture.candidateExpiresAt,
    withdrawalConditions: [
      "external_human_response",
      "candidate_expired",
      "target_version_changed",
      "human_rejected"
    ],
    policyVersion: fixture.policyVersion,
    budgetVersion: fixture.budgetVersion,
    hashAlgorithm: CANONICAL_HASH_ALGORITHM,
    containsForumText: false
  });
  const intentHash = canonicalProtocolHash(intent.schemaVersion, intent);
  const moveSpec = parseProtocolObject("facilitationMoveSpec", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.facilitationMoveSpec,
    intentHash,
    needState: "connection_gap",
    mechanismTarget: "reduce_connection_cost",
    facilitationMove: "connect_resource_and_invite_application",
    targetObject: "thread_author",
    requiredContentElements: [
      "acknowledge_specific_gap",
      "resource_reference",
      "application_invitation"
    ],
    prohibitedMoves: [
      "answer_on_behalf_of_learner",
      "identity_ranking",
      "stable_personality_judgment",
      "unverifiable_learning_effect_claim"
    ],
    observableSuccessCriteria: [
      "external_human_response",
      "resource_application_attempt"
    ],
    specVersion: fixture.moveSpecVersion,
    containsForumText: false
  });
  assertMoveSpecMatchesIntent(intent, moveSpec);
  const moveSpecHash = canonicalProtocolHash(moveSpec.schemaVersion, moveSpec);
  const draft = deterministicDraft(fixture);
  const reviewBundle = parseProtocolObject("reviewBundle", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.reviewBundle,
    taskRefHash: sha256(`synthetic-task\0${fixture.fixtureId}`),
    evidenceRefHash,
    intentHash,
    moveSpecHash,
    draftContentHash: sha256(draft),
    targetHash: fixture.targetVersionHash,
    safetyResultHash: sha256("p4d1.deterministic-safety-rules.v1\0pass"),
    policyVersion: fixture.policyVersion,
    assembledAt: fixture.fixedClock,
    containsForumText: false
  });
  const reviewBundleHash = canonicalProtocolHash(
    reviewBundle.schemaVersion,
    reviewBundle
  );

  return {
    schemaVersion: "cmooc.p4d1-review-case.v1",
    fixtureId: fixture.fixtureId,
    fixtureKind: fixture.fixtureKind,
    fixedClock: fixture.fixedClock,
    title: fixture.title,
    syntheticSourceText: fixture.syntheticSourceText,
    contentRevisionStatus: fixture.contentRevisionStatus,
    candidate: {
      whyNow: fixture.whyNow,
      whyTarget: fixture.whyTarget,
      budgetBasis: fixture.budgetBasis,
      priorityRank: fixture.priorityRank,
      candidateCount: fixture.candidateCount,
      budgetSlots: fixture.budgetSlots,
      decisionAt: fixture.decisionAt,
      candidateExpiresAt: fixture.candidateExpiresAt
    },
    evidenceRef,
    evidenceRefHash,
    intent,
    intentHash,
    moveSpec,
    moveSpecHash,
    deterministicDraft: draft,
    reviewBundle,
    reviewBundleHash,
    targetHash: fixture.targetVersionHash,
    externalWriteCapability: false,
    containsForumTextInProtocol: false
  };
}

function assertReviewText(
  reviewCase: P4D1ReviewCase,
  decision: P4D1ReviewDecision,
  draftText: string
): string | null {
  if (decision === "reject") return null;
  const normalized = draftText.trim();
  if (!normalized) throw new Error("接受或修改时，草稿不能为空。");
  if (normalized.length > 4000) throw new Error("草稿不能超过 4000 个字符。");
  if (decision === "accept" && normalized !== reviewCase.deterministicDraft) {
    throw new Error("草稿已被修改，请使用“保存修改”。");
  }
  if (decision === "modify" && normalized === reviewCase.deterministicDraft) {
    throw new Error("草稿尚未修改，请使用“接受原稿”。");
  }
  return normalized;
}

export function createP4D1LocalReviewReceipt(input: {
  reviewCase?: P4D1ReviewCase;
  decision: P4D1ReviewDecision;
  draftText: string;
  reviewedAt?: string;
}): {
  receipt: P4D1LocalReviewReceipt;
  receiptHash: string;
} {
  const reviewCase = input.reviewCase ?? buildP4D1ReviewCase();
  if (!["accept", "modify", "reject"].includes(input.decision)) {
    throw new Error("人工决定必须是 accept、modify 或 reject。");
  }
  const reviewedAt = input.reviewedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(reviewedAt))) {
    throw new Error("reviewedAt 必须是有效时间。");
  }
  const finalText = assertReviewText(
    reviewCase,
    input.decision,
    input.draftText
  );
  const receipt: P4D1LocalReviewReceipt = {
    schemaVersion: P4D1_REVIEW_RECEIPT_SCHEMA_VERSION,
    fixtureId: reviewCase.fixtureId,
    correlationId: `p4d1:${reviewCase.fixtureId}`,
    decision: input.decision,
    reviewedAt,
    evidenceRefHash: reviewCase.evidenceRefHash,
    intentHash: reviewCase.intentHash,
    moveSpecHash: reviewCase.moveSpecHash,
    reviewBundleHash: reviewCase.reviewBundleHash,
    targetHash: reviewCase.targetHash,
    originalDraftHash: sha256(reviewCase.deterministicDraft),
    finalDraftHash: finalText === null ? null : sha256(finalText),
    wasEdited: input.decision === "modify",
    contentRevisionStatus: reviewCase.contentRevisionStatus,
    realPublishEnabled: false,
    externalWriteAttempted: false,
    containsForumText: false
  };
  return {
    receipt,
    receiptHash: canonicalProtocolHash(
      receipt.schemaVersion,
      receipt as CanonicalJsonValue
    )
  };
}

export function defaultP4D1OutputRoot(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("未设置 LOCALAPPDATA，无法保存正式 P4D-1 本地回执。");
  }
  return path.resolve(localAppData, "cmooc-research", "p4d1");
}

export async function persistP4D1LocalReviewReceipt(input: {
  receipt: P4D1LocalReviewReceipt;
  receiptHash: string;
  outputRoot?: string;
}): Promise<string> {
  if (
    input.receipt.containsForumText ||
    input.receipt.externalWriteAttempted ||
    input.receipt.realPublishEnabled
  ) {
    throw new Error("拒绝保存：P4D-1 回执越过了本地、去正文或零发布边界。");
  }
  const outputRoot = path.resolve(
    input.outputRoot ?? defaultP4D1OutputRoot()
  );
  const receiptDirectory = path.join(outputRoot, "review-receipts-v1");
  await mkdir(receiptDirectory, { recursive: true });
  const receiptPath = path.join(
    receiptDirectory,
    `${input.receiptHash}.json`
  );
  await writeFile(
    receiptPath,
    `${JSON.stringify(input.receipt, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" }
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  return receiptPath;
}
