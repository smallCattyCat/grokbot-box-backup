import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  parseTeachableEpisodeReceipt,
  projectTeachableEpisode,
  type PriorTeachableDecision,
  type TeachableEpisodeCurrent,
  type TeachableEpisodeOutcome
} from "../../lib/autonomy/teachable-episode";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function current(
  overrides: Partial<TeachableEpisodeCurrent> = {}
): TeachableEpisodeCurrent {
  return {
    courseAlias: "teachable-course",
    threadKey: hash("thread"),
    authorKey: hash("author"),
    asOf: "2026-08-29T12:00:00.000Z",
    targetVersionHash: hash("target-v1"),
    policyVersion: "teachable.shadow.v1",
    governanceHash: hash("governance-v1"),
    selectedFunction: "cognitive_conflict",
    rendererVersion: "cmooc.semantic-renderer.v1",
    rendererContractVersion:
      "cmooc.semantic-renderer-contract.v1",
    baseDecision: "draft",
    baseReasonCode: "draft_eligible",
    ...overrides
  };
}

function prior(
  overrides: Partial<PriorTeachableDecision> = {}
): PriorTeachableDecision {
  return {
    decisionKey: hash("prior-decision"),
    evidenceAsOf: "2026-08-29T11:00:00.000Z",
    authorKey: hash("author"),
    targetVersionHash: hash("target-v1"),
    policyVersion: "teachable.shadow.v1",
    governanceHash: hash("governance-v1"),
    selectedFunction: "cognitive_conflict",
    rendererVersion: "cmooc.semantic-renderer.v1",
    rendererContractVersion:
      "cmooc.semantic-renderer-contract.v1",
    bodyPersisted: false,
    editorWriteAttempted: false,
    publishAttempted: false,
    confirmedPublishedAt: null,
    outcomes: [],
    ...overrides
  };
}

function outcome(
  overrides: Partial<TeachableEpisodeOutcome> = {}
): TeachableEpisodeOutcome {
  return {
    observationWindow: "R24",
    status: "pending",
    dueAt: "2026-08-30T11:00:00.000Z",
    observedAt: null,
    firstExternalReplyAt: null,
    authorReturned: null,
    newAuthorCount: null,
    censored: false,
    createdAt: "2026-08-29T11:05:00.000Z",
    ...overrides
  };
}

test("相同目标、策略、治理、渲染器与功能复用 SHADOW 草稿", () => {
  const result = projectTeachableEpisode({
    current: current(),
    prior: prior()
  });
  assert.equal(result.receipt.state, "shadow_proposed_unchanged");
  assert.equal(result.receipt.action, "wait");
  assert.equal(
    result.directive?.reasonCode,
    "shadow_draft_unchanged_reused"
  );
  assert.match(result.receiptHash, /^[a-f0-9]{64}$/u);
  assert.equal(result.receipt.containsForumText, false);
  assert.equal(result.receipt.authorityFootprint.humanResponsePriority, true);
  assert.deepEqual(result.receipt.authorityFootprint.learnerRights, [
    "ignore",
    "correct",
    "redirect",
    "stop"
  ]);
});

test("任一关键绑定变化或发生编辑、发布、正文持久化都禁止 SHADOW 复用", () => {
  const cases: Array<{
    current?: Partial<TeachableEpisodeCurrent>;
    prior?: Partial<PriorTeachableDecision>;
  }> = [
    { current: { targetVersionHash: hash("target-v2") } },
    { current: { policyVersion: "teachable.shadow.v2" } },
    { current: { governanceHash: hash("governance-v2") } },
    { current: { rendererVersion: "semantic-renderer.v2" } },
    {
      current: {
        rendererContractVersion: "semantic-renderer-contract.v2"
      }
    },
    { current: { selectedFunction: "resource_connection" } },
    { prior: { editorWriteAttempted: true } },
    { prior: { publishAttempted: true } },
    { prior: { bodyPersisted: true } }
  ];
  for (const item of cases) {
    const result = projectTeachableEpisode({
      current: current(item.current),
      prior: prior(item.prior)
    });
    assert.equal(result.receipt.state, "none");
    assert.equal(result.directive, null);
  }
});

test("真实发布后只用 as-of 内 outcome：等待、学习者返回、同伴接续与 R72 关闭", () => {
  const published = {
    publishAttempted: true,
    confirmedPublishedAt: "2026-08-29T11:05:00.000Z"
  } as const;
  const waiting = projectTeachableEpisode({
    current: current(),
    prior: prior({ ...published, outcomes: [outcome()] })
  });
  assert.equal(waiting.receipt.state, "awaiting_learner");
  assert.equal(waiting.directive?.action, "wait");

  const futureReturn = projectTeachableEpisode({
    current: current(),
    prior: prior({
      ...published,
      outcomes: [
        outcome({
          status: "observed",
          observedAt: "2026-08-29T13:00:00.000Z",
          authorReturned: true
        })
      ]
    })
  });
  assert.equal(
    futureReturn.receipt.state,
    "awaiting_learner",
    "未来 outcome 不能穿越 as-of 改写当前状态"
  );

  const learner = projectTeachableEpisode({
    current: current(),
    prior: prior({
      ...published,
      outcomes: [
        outcome({
          status: "observed",
          observedAt: "2026-08-29T11:30:00.000Z",
          authorReturned: true
        })
      ]
    })
  });
  assert.equal(learner.receipt.state, "learner_returned");
  assert.equal(learner.directive?.action, "yield");

  const peer = projectTeachableEpisode({
    current: current(),
    prior: prior({
      ...published,
      outcomes: [
        outcome({
          status: "observed",
          observedAt: "2026-08-29T11:30:00.000Z",
          firstExternalReplyAt: "2026-08-29T11:20:00.000Z",
          newAuthorCount: 1
        })
      ]
    })
  });
  assert.equal(peer.receipt.state, "peer_taken_over");
  assert.equal(peer.directive?.action, "yield");

  const stalled = projectTeachableEpisode({
    current: current(),
    prior: prior({
      ...published,
      outcomes: [
        outcome({
          observationWindow: "R72",
          status: "observed",
          observedAt: "2026-08-29T11:30:00.000Z",
          authorReturned: false,
          newAuthorCount: 0
        })
      ]
    })
  });
  assert.equal(stalled.receipt.state, "stalled_closed");
  assert.equal(stalled.directive?.action, "close");
  assert.equal(
    stalled.receipt.outcomeInterpretation,
    "descriptive_process_state_not_learning_effect"
  );
});

test("当前观察中的学习者或同伴返回优先让位", () => {
  const learner = projectTeachableEpisode({
    current: current({
      baseDecision: "yield",
      baseReasonCode: "original_author_return",
      selectedFunction: null
    }),
    prior: prior()
  });
  assert.equal(learner.receipt.state, "learner_returned");

  const peer = projectTeachableEpisode({
    current: current({
      baseDecision: "yield",
      baseReasonCode: "external_human_response",
      selectedFunction: null
    }),
    prior: prior()
  });
  assert.equal(peer.receipt.state, "peer_taken_over");
});

test("回执哈希可重放且严格拒绝正文键", () => {
  const first = projectTeachableEpisode({
    current: current(),
    prior: prior()
  });
  const second = projectTeachableEpisode({
    current: current(),
    prior: prior()
  });
  assert.equal(first.receiptHash, second.receiptHash);
  assert.deepEqual(
    parseTeachableEpisodeReceipt(first.receipt),
    first.receipt
  );
  assert.throws(
    () =>
      parseTeachableEpisodeReceipt({
        ...first.receipt,
        body: "forum text must never persist"
      }),
    /禁止字段/
  );
  assert.throws(
    () =>
      parseTeachableEpisodeReceipt({
        ...first.receipt,
        action: "yield"
      }),
    /状态、动作与理由不一致/
  );
  assert.throws(
    () =>
      parseTeachableEpisodeReceipt({
        ...first.receipt,
        reasonCode: "teachable_episode_human_returned"
      }),
    /状态、动作与理由不一致/
  );
  assert.throws(
    () =>
      parseTeachableEpisodeReceipt({
        ...first.receipt,
        authorityFootprint: {
          ...first.receipt.authorityFootprint,
          aiAuthorityUses: ["ask", "judge_answer"]
        }
      }),
    /权威足迹边界无效/
  );
});
