import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  P4D1_EVIDENCE_SCHEMA_VERSION,
  buildP4D1ReviewCase,
  createP4D1LocalReviewReceipt,
  defaultP4D1OutputRoot,
  persistP4D1LocalReviewReceipt
} from "../lib/golden-path/p4d1";

async function main() {
  const reviewCase = buildP4D1ReviewCase();
  const receiptResult = createP4D1LocalReviewReceipt({
    reviewCase,
    decision: "accept",
    draftText: reviewCase.deterministicDraft,
    reviewedAt: reviewCase.fixedClock
  });
  const outputRoot = defaultP4D1OutputRoot();
  await persistP4D1LocalReviewReceipt({
    ...receiptResult,
    outputRoot
  });

  const evidence = {
    schemaVersion: P4D1_EVIDENCE_SCHEMA_VERSION,
    researchQuestion: "RQ3",
    evidenceName: "P4D-1 固定时点实施链追溯证据",
    claimBoundary:
      "只支持从时点证据到人工决定的可追溯、可复跑与规则一致，不支持因果效果或语义保真结论。",
    fixtureId: reviewCase.fixtureId,
    fixedClock: reviewCase.fixedClock,
    decisionAt: reviewCase.candidate.decisionAt,
    evidenceRefHash: reviewCase.evidenceRefHash,
    intentHash: reviewCase.intentHash,
    moveSpecHash: reviewCase.moveSpecHash,
    reviewBundleHash: reviewCase.reviewBundleHash,
    localReviewReceiptHash: receiptResult.receiptHash,
    reviewDecision: receiptResult.receipt.decision,
    checks: {
      developmentSplit2024:
        reviewCase.evidenceRef.year === 2024 &&
        reviewCase.evidenceRef.split === "development",
      asOfVerified:
        reviewCase.evidenceRef.temporalEvidenceStatus === "as_of_verified",
      decisionTimeContentVersionVerified:
        reviewCase.contentRevisionStatus ===
        "decision_time_version_verified",
      validIntentMoveBinding:
        reviewCase.moveSpec.intentHash === reviewCase.intentHash,
      protocolContainsForumText: reviewCase.containsForumTextInProtocol,
      receiptContainsForumText: receiptResult.receipt.containsForumText,
      realPublishEnabled: receiptResult.receipt.realPublishEnabled,
      externalWriteAttempted: receiptResult.receipt.externalWriteAttempted
    },
    reproducibility: {
      command: "npm run p4:golden-path:audit",
      fixture:
        "fixtures/p4d1/golden-path-resource-connection-v1.json",
      randomProcessUsed: false
    }
  };

  if (
    evidence.checks.protocolContainsForumText ||
    evidence.checks.receiptContainsForumText ||
    evidence.checks.realPublishEnabled ||
    evidence.checks.externalWriteAttempted ||
    !evidence.checks.developmentSplit2024 ||
    !evidence.checks.asOfVerified ||
    !evidence.checks.decisionTimeContentVersionVerified ||
    !evidence.checks.validIntentMoveBinding
  ) {
    throw new Error("P4D-1 黄金路径审计未通过。");
  }

  const evidenceDirectory = path.join(outputRoot, "evidence-v1");
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    path.join(evidenceDirectory, "rq3-trace-evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8"
  );
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
