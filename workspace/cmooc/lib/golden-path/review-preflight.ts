import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import type { P4D1ReviewDecision } from "@/lib/golden-path/p4d1";
import type {
  P4FLiteScenarioId,
  P4FLiteScenarioResult
} from "@/lib/golden-path/p4f-lite";

export const P4_REVIEW_PREFLIGHT_RECEIPT_SCHEMA_VERSION =
  "cmooc.p4-review-preflight-receipt.v1" as const;

export type P4ReviewDisposition =
  | "shadow_recorded"
  | "human_rejected"
  | "withdrawn_external_human_response"
  | "needs_re_review_target_changed";

export type P4ReviewPreflightReceipt = {
  schemaVersion: typeof P4_REVIEW_PREFLIGHT_RECEIPT_SCHEMA_VERSION;
  fixtureId: string;
  correlationId: string;
  scenarioId: P4FLiteScenarioId;
  adapterId: string;
  requestedDecision: P4D1ReviewDecision;
  finalDecision: P4D1ReviewDecision;
  disposition: P4ReviewDisposition;
  reviewStartedAt: string;
  reviewedAt: string;
  reviewDurationMs: number;
  preflightStatus: P4FLiteScenarioResult["preflightStatus"];
  withdrawalCondition: P4FLiteScenarioResult["withdrawalCondition"];
  eventCountBefore: number;
  eventCountAfter: number;
  scenarioTraceHash: string;
  localReviewReceiptHash: string;
  realPublishEnabled: false;
  externalWriteAttempted: false;
  containsForumText: false;
};

export function resolveP4ReviewDecision(input: {
  requestedDecision: P4D1ReviewDecision;
  preflight: P4FLiteScenarioResult;
}): {
  finalDecision: P4D1ReviewDecision;
  disposition: P4ReviewDisposition;
} {
  if (input.preflight.withdrawalCondition === "target_version_changed") {
    return {
      finalDecision: "reject",
      disposition: "needs_re_review_target_changed"
    };
  }
  if (input.preflight.withdrawalCondition === "external_human_response") {
    return {
      finalDecision: "reject",
      disposition: "withdrawn_external_human_response"
    };
  }
  return input.requestedDecision === "reject"
    ? { finalDecision: "reject", disposition: "human_rejected" }
    : {
        finalDecision: input.requestedDecision,
        disposition: "shadow_recorded"
      };
}

function normalizedStartTime(
  reviewStartedAt: string | undefined,
  reviewedAt: string
): string {
  if (!reviewStartedAt || !Number.isFinite(Date.parse(reviewStartedAt))) {
    return reviewedAt;
  }
  const started = Date.parse(reviewStartedAt);
  const reviewed = Date.parse(reviewedAt);
  if (started > reviewed || reviewed - started > 24 * 60 * 60 * 1000) {
    return reviewedAt;
  }
  return new Date(started).toISOString();
}

export function createP4ReviewPreflightReceipt(input: {
  fixtureId: string;
  requestedDecision: P4D1ReviewDecision;
  finalDecision: P4D1ReviewDecision;
  disposition: P4ReviewDisposition;
  reviewStartedAt?: string;
  reviewedAt: string;
  preflight: P4FLiteScenarioResult;
  localReviewReceiptHash: string;
}): {
  receipt: P4ReviewPreflightReceipt;
  receiptHash: string;
} {
  if (!Number.isFinite(Date.parse(input.reviewedAt))) {
    throw new Error("reviewedAt 必须是有效时间。");
  }
  const reviewStartedAt = normalizedStartTime(
    input.reviewStartedAt,
    input.reviewedAt
  );
  const receipt: P4ReviewPreflightReceipt = {
    schemaVersion: P4_REVIEW_PREFLIGHT_RECEIPT_SCHEMA_VERSION,
    fixtureId: input.fixtureId,
    correlationId: `p4-review:${input.fixtureId}`,
    scenarioId: input.preflight.scenarioId,
    adapterId: input.preflight.adapterId,
    requestedDecision: input.requestedDecision,
    finalDecision: input.finalDecision,
    disposition: input.disposition,
    reviewStartedAt,
    reviewedAt: input.reviewedAt,
    reviewDurationMs:
      Date.parse(input.reviewedAt) - Date.parse(reviewStartedAt),
    preflightStatus: input.preflight.preflightStatus,
    withdrawalCondition: input.preflight.withdrawalCondition,
    eventCountBefore: input.preflight.eventCountBefore,
    eventCountAfter: input.preflight.eventCountAfter,
    scenarioTraceHash: input.preflight.scenarioTraceHash,
    localReviewReceiptHash: input.localReviewReceiptHash,
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

export async function persistP4ReviewPreflightReceipt(input: {
  receipt: P4ReviewPreflightReceipt;
  receiptHash: string;
  outputRoot: string;
}): Promise<string> {
  if (
    input.receipt.containsForumText ||
    input.receipt.externalWriteAttempted ||
    input.receipt.realPublishEnabled
  ) {
    throw new Error("拒绝保存：提交前重读回执越过了去正文或零发布边界。");
  }
  const receiptDirectory = path.join(
    path.resolve(input.outputRoot),
    "review-preflight-receipts-v1"
  );
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
