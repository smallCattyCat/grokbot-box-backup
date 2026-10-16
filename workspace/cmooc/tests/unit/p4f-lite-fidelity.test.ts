import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import rubric from "../../fixtures/p4f-lite/fidelity-rubric-v1.json";
import {
  buildP4FLiteEvidence,
  persistP4FLiteEvidence,
  runP4FLiteReviewPreflight
} from "../../lib/golden-path/p4f-lite";
import {
  buildP4D1ReviewCase,
  createP4D1LocalReviewReceipt
} from "../../lib/golden-path/p4d1";
import {
  createP4ReviewPreflightReceipt,
  persistP4ReviewPreflightReceipt,
  resolveP4ReviewDecision
} from "../../lib/golden-path/review-preflight";

const FORBIDDEN_SYNTHETIC_TEXT = [
  "SYNTHETIC_P4F_TOPIC",
  "SYNTHETIC_P4F_ROOT_CONNECTION_GAP",
  "SYNTHETIC_P4F_ROOT_EDITED",
  "SYNTHETIC_P4F_HUMAN_RESPONSE",
  "SYNTHETIC_P4F_TIMELINE_TOPIC",
  "SYNTHETIC_P4F_TIMELINE_CONNECTION_GAP",
  "SYNTHETIC_P4F_TIMELINE_ROOT_EDITED",
  "SYNTHETIC_P4F_TIMELINE_HUMAN_RESPONSE"
];

test("P4F-lite 在两个合成 adapter 上完成三个预声明情境", async () => {
  const evidence = await buildP4FLiteEvidence();

  assert.equal(evidence.scenarioCount, 6);
  assert.equal(evidence.completedCount, 6);
  assert.equal(evidence.completionRate, 1);
  assert.equal(evidence.functionFidelityRate, 1);
  assert.equal(evidence.moveFidelityRate, 1);
  assert.equal(evidence.targetFidelityRate, 1);
  assert.equal(evidence.draftRuleFidelityRate, 1);
  assert.equal(evidence.decisionFidelityRate, 1);
  assert.equal(evidence.humanTakeoverCount, 4);
  assert.equal(evidence.externalWriteCalls, 0);
  assert.equal(evidence.realForumWriteCalls, 0);
  assert.equal(evidence.leakedForumTextCount, 0);
  assert.equal(
    new Set(
      evidence.results.map((result) => result.scenarioTraceHash)
    ).size,
    6
  );

  for (const adapterKind of [
    "mock_forum",
    "synthetic_timeline"
  ] as const) {
    const platform = evidence.results.filter(
      (result) => result.adapterKind === adapterKind
    );
    assert.deepEqual(
      platform.map((result) => result.scenarioId),
      [
        "stable_target",
        "target_version_changed",
        "post_as_of_human_response"
      ]
    );
    assert.deepEqual(
      platform.map((result) => result.preflightStatus),
      ["ready", "target_changed", "ready"]
    );
    assert.deepEqual(
      platform.map((result) => result.reviewDecision),
      ["accept", "reject", "reject"]
    );
    assert.deepEqual(
      platform.map((result) => result.withdrawalCondition),
      [null, "target_version_changed", "external_human_response"]
    );
  }
});

test("P4F-lite 固定时钟、rubric 与结果哈希可复跑", async () => {
  const first = await buildP4FLiteEvidence();
  const second = await buildP4FLiteEvidence();
  assert.deepEqual(second, first);
});

test("产品提交前重读复用 P4F 三情境并按社区状态让位", async () => {
  const stable = await runP4FLiteReviewPreflight({
    scenarioId: "stable_target"
  });
  const changed = await runP4FLiteReviewPreflight({
    scenarioId: "target_version_changed"
  });
  const human = await runP4FLiteReviewPreflight({
    scenarioId: "post_as_of_human_response"
  });

  assert.deepEqual(
    [stable.preflightStatus, changed.preflightStatus, human.preflightStatus],
    ["ready", "target_changed", "ready"]
  );
  assert.deepEqual(
    [
      stable.withdrawalCondition,
      changed.withdrawalCondition,
      human.withdrawalCondition
    ],
    [null, "target_version_changed", "external_human_response"]
  );
  assert.deepEqual(
    [
      resolveP4ReviewDecision({
        requestedDecision: "accept",
        preflight: stable
      }),
      resolveP4ReviewDecision({
        requestedDecision: "modify",
        preflight: changed
      }),
      resolveP4ReviewDecision({
        requestedDecision: "accept",
        preflight: human
      })
    ],
    [
      { finalDecision: "accept", disposition: "shadow_recorded" },
      {
        finalDecision: "reject",
        disposition: "needs_re_review_target_changed"
      },
      {
        finalDecision: "reject",
        disposition: "withdrawn_external_human_response"
      }
    ]
  );
});

test("提交前重读侧车回执记录审阅时长与让位原因但不保存正文", async () => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "cmooc-p4-review-preflight-")
  );
  try {
    const reviewCase = buildP4D1ReviewCase();
    const preflight = await runP4FLiteReviewPreflight({
      scenarioId: "post_as_of_human_response"
    });
    const decision = resolveP4ReviewDecision({
      requestedDecision: "accept",
      preflight
    });
    const localReview = createP4D1LocalReviewReceipt({
      reviewCase,
      decision: decision.finalDecision,
      draftText: reviewCase.deterministicDraft,
      reviewedAt: "2024-10-19T20:00:05.000Z"
    });
    const receipt = createP4ReviewPreflightReceipt({
      fixtureId: reviewCase.fixtureId,
      requestedDecision: "accept",
      ...decision,
      reviewStartedAt: "2024-10-19T20:00:00.000Z",
      reviewedAt: "2024-10-19T20:00:05.000Z",
      preflight,
      localReviewReceiptHash: localReview.receiptHash
    });
    const receiptPath = await persistP4ReviewPreflightReceipt({
      ...receipt,
      outputRoot
    });
    const serialized = await readFile(receiptPath, "utf8");

    assert.equal(receipt.receipt.reviewDurationMs, 5000);
    assert.equal(
      receipt.receipt.disposition,
      "withdrawn_external_human_response"
    );
    assert.equal(receipt.receipt.externalWriteAttempted, false);
    assert.equal(receipt.receipt.containsForumText, false);
    assert.equal(serialized.includes(reviewCase.syntheticSourceText), false);
    assert.equal(serialized.includes(reviewCase.deterministicDraft), false);
    for (const forbidden of FORBIDDEN_SYNTHETIC_TEXT) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("P4F-lite 证据不含合成论坛正文且没有执行调用", async () => {
  const evidence = await buildP4FLiteEvidence();
  const serialized = JSON.stringify(evidence);
  for (const forbidden of FORBIDDEN_SYNTHETIC_TEXT) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(serialized.includes("executeAuthorized"), false);
  assert.ok(
    evidence.results.every(
      (result) =>
        result.containsForumText === false &&
        result.externalWriteCalls === 0
    )
  );
});

test("P4F-lite 拒绝缺少三个预声明情境的 rubric", async () => {
  await assert.rejects(
    () =>
      buildP4FLiteEvidence({
        ...rubric,
        scenarios: rubric.scenarios.slice(0, 2)
      }),
    /三情境定义非法/
  );
});

test("P4F-lite 正式证据只在指定本地目录保存去正文结果", async () => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "cmooc-p4f-lite-")
  );
  try {
    const evidence = await buildP4FLiteEvidence();
    const evidencePath = await persistP4FLiteEvidence(
      evidence,
      outputRoot
    );
    const serialized = await readFile(evidencePath, "utf8");
    assert.deepEqual(JSON.parse(serialized), evidence);
    for (const forbidden of FORBIDDEN_SYNTHETIC_TEXT) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
