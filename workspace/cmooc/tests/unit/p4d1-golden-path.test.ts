import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import fixture from "../../fixtures/p4d1/golden-path-resource-connection-v1.json";
import {
  buildP4D1ReviewCase,
  createP4D1LocalReviewReceipt,
  persistP4D1LocalReviewReceipt
} from "../../lib/golden-path/p4d1";
import {
  assertMoveSpecMatchesIntent,
  parseProtocolObject
} from "../../lib/facilitation-protocol";

test("P4D-1 固定 fixture 生成合法且稳定的证据—动作链", () => {
  const first = buildP4D1ReviewCase();
  const second = buildP4D1ReviewCase();

  parseProtocolObject("decisionEvidenceRef", first.evidenceRef);
  parseProtocolObject("interventionIntent", first.intent);
  parseProtocolObject("facilitationMoveSpec", first.moveSpec);
  parseProtocolObject("reviewBundle", first.reviewBundle);
  assertMoveSpecMatchesIntent(first.intent, first.moveSpec);

  assert.equal(first.evidenceRef.temporalEvidenceStatus, "as_of_verified");
  assert.equal(first.evidenceRef.year, 2024);
  assert.equal(first.evidenceRef.split, "development");
  assert.equal(first.contentRevisionStatus, "decision_time_version_verified");
  assert.equal(first.intent.facilitationFunction, "resource_connection");
  assert.equal(first.moveSpec.targetObject, "thread_author");
  assert.equal(first.externalWriteCapability, false);
  assert.deepEqual(
    {
      evidenceRefHash: first.evidenceRefHash,
      intentHash: first.intentHash,
      moveSpecHash: first.moveSpecHash,
      reviewBundleHash: first.reviewBundleHash,
      draft: first.deterministicDraft
    },
    {
      evidenceRefHash: second.evidenceRefHash,
      intentHash: second.intentHash,
      moveSpecHash: second.moveSpecHash,
      reviewBundleHash: second.reviewBundleHash,
      draft: second.deterministicDraft
    }
  );
});

test("决策时点后的合成事件后缀不改变既有协议哈希或草稿", () => {
  const baseline = buildP4D1ReviewCase(fixture);
  const withFutureSuffix = buildP4D1ReviewCase({
    ...fixture,
    futureEvents: [
      {
        occurredAt: "2024-10-19T20:05:00",
        type: "external_human_response"
      }
    ]
  });

  assert.deepEqual(
    {
      evidenceRefHash: baseline.evidenceRefHash,
      intentHash: baseline.intentHash,
      moveSpecHash: baseline.moveSpecHash,
      reviewBundleHash: baseline.reviewBundleHash,
      draft: baseline.deterministicDraft
    },
    {
      evidenceRefHash: withFutureSuffix.evidenceRefHash,
      intentHash: withFutureSuffix.intentHash,
      moveSpecHash: withFutureSuffix.moveSpecHash,
      reviewBundleHash: withFutureSuffix.reviewBundleHash,
      draft: withFutureSuffix.deterministicDraft
    }
  );
});

test("接受、修改、拒绝均生成去正文且不发布的本地回执", () => {
  const reviewCase = buildP4D1ReviewCase();
  const fixedReviewedAt = reviewCase.fixedClock;
  const accepted = createP4D1LocalReviewReceipt({
    reviewCase,
    decision: "accept",
    draftText: reviewCase.deterministicDraft,
    reviewedAt: fixedReviewedAt
  });
  const modified = createP4D1LocalReviewReceipt({
    reviewCase,
    decision: "modify",
    draftText: `${reviewCase.deterministicDraft} 请结合你的小组经历作答。`,
    reviewedAt: fixedReviewedAt
  });
  const rejected = createP4D1LocalReviewReceipt({
    reviewCase,
    decision: "reject",
    draftText: reviewCase.deterministicDraft,
    reviewedAt: fixedReviewedAt
  });

  assert.equal(accepted.receipt.wasEdited, false);
  assert.equal(modified.receipt.wasEdited, true);
  assert.notEqual(
    modified.receipt.finalDraftHash,
    accepted.receipt.finalDraftHash
  );
  assert.equal(rejected.receipt.finalDraftHash, null);

  for (const result of [accepted, modified, rejected]) {
    assert.equal(result.receipt.containsForumText, false);
    assert.equal(result.receipt.realPublishEnabled, false);
    assert.equal(result.receipt.externalWriteAttempted, false);
    const serialized = JSON.stringify(result.receipt);
    assert.equal(serialized.includes(reviewCase.syntheticSourceText), false);
    assert.equal(serialized.includes(reviewCase.deterministicDraft), false);
  }
});

test("接受与修改动作不能互相冒充", () => {
  const reviewCase = buildP4D1ReviewCase();
  assert.throws(
    () =>
      createP4D1LocalReviewReceipt({
        reviewCase,
        decision: "accept",
        draftText: `${reviewCase.deterministicDraft} 修改`
      }),
    /使用“保存修改”/
  );
  assert.throws(
    () =>
      createP4D1LocalReviewReceipt({
        reviewCase,
        decision: "modify",
        draftText: reviewCase.deterministicDraft
      }),
    /使用“接受原稿”/
  );
});

test("本地回执落盘后仍不包含主题或草稿正文", async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "cmooc-p4d1-"));
  try {
    const reviewCase = buildP4D1ReviewCase();
    const result = createP4D1LocalReviewReceipt({
      reviewCase,
      decision: "accept",
      draftText: reviewCase.deterministicDraft,
      reviewedAt: reviewCase.fixedClock
    });
    const receiptPath = await persistP4D1LocalReviewReceipt({
      ...result,
      outputRoot
    });
    const serialized = await readFile(receiptPath, "utf8");
    assert.equal(serialized.includes(reviewCase.syntheticSourceText), false);
    assert.equal(serialized.includes(reviewCase.deterministicDraft), false);
    assert.equal(JSON.parse(serialized).containsForumText, false);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
