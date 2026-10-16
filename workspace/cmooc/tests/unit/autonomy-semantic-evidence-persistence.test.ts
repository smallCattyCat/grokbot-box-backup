import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeTransientSemanticEvidence,
  parseAutonomySemanticEvidenceReceipt
} from "../../lib/autonomy/transient-semantic-evidence";

const HASH = "a".repeat(64);

test("body-free semantic feature receipts survive strict durable parsing", () => {
  const analyzed = analyzeTransientSemanticEvidence({
    observationReceiptHash: HASH,
    targetVersionHash: "b".repeat(64),
    eventSetHash: "c".repeat(64),
    observedAt: "2026-08-29T12:00:00.000Z",
    texts: [
      "我的理解是开放课程中的连接需要学习者主动建立，但我还不确定如何找到合适的同伴回应。"
    ],
    sequenceCompletion: "open"
  });

  assert.deepEqual(
    parseAutonomySemanticEvidenceReceipt(
      JSON.parse(JSON.stringify(analyzed.receipt))
    ),
    analyzed.receipt
  );
  assert.equal(analyzed.receipt.containsForumText, false);
});

test("durable semantic receipts reject added source text or relaxed boundaries", () => {
  const analyzed = analyzeTransientSemanticEvidence({
    observationReceiptHash: HASH,
    targetVersionHash: "b".repeat(64),
    eventSetHash: "c".repeat(64),
    observedAt: "2026-08-29T12:00:00.000Z",
    texts: ["为什么课程讨论中的观点没有形成持续回应？我想进一步比较可能的连接路径。"]
  });

  assert.throws(
    () =>
      parseAutonomySemanticEvidenceReceipt({
        ...analyzed.receipt,
        sourceText: "must never persist"
      }),
    /FIELDS_INVALID/
  );
  assert.throws(
    () =>
      parseAutonomySemanticEvidenceReceipt({
        ...analyzed.receipt,
        containsForumText: true
      }),
    /BOUNDARY_INVALID/
  );
});
