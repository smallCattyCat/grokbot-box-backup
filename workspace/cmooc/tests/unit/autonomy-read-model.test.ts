import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAutonomyBriefNarrative,
  formatObservedOutcomeWindows,
  parseSafeDecisionTapeGovernancePayload,
  parseSafeOutcomeEvidenceSummary
} from "../../lib/autonomy/read-model";

test("成果简报优先展示最新运行状态，再解释本轮决定", () => {
  assert.equal(
    buildAutonomyBriefNarrative({
      latestStatus: "running",
      hasInvocation: true,
      draftCount: 0,
      abstainCount: 1,
      yieldCount: 2
    }),
    "系统正在巡检课程共同体"
  );
  assert.equal(
    buildAutonomyBriefNarrative({
      latestStatus: "completed",
      hasInvocation: true,
      draftCount: 0,
      abstainCount: 1,
      yieldCount: 2
    }),
    "课程共同体正在自行连接，系统本轮选择让位"
  );
  assert.equal(
    buildAutonomyBriefNarrative({
      latestStatus: "completed",
      hasInvocation: true,
      draftCount: 1,
      abstainCount: 0,
      yieldCount: 0
    }),
    "系统发现可促进机会，当前仍保持影子运行"
  );
});

test("成果简报只按既定顺序展示已观察的 R24/R72 窗口", () => {
  assert.equal(
    formatObservedOutcomeWindows(["R72", "other", "R24"]),
    "R24 / R72"
  );
  assert.equal(formatObservedOutcomeWindows([]), "尚未观察");
});

test("近端结果治理摘要只接受去正文、非因果且具名的证据来源", () => {
  assert.deepEqual(
    parseSafeOutcomeEvidenceSummary(
      JSON.stringify({
        schemaVersion:
          "cmooc.proximal-outcome-observation.v1",
        outcome: "observed",
        evidenceSource: "target_thread",
        attribution:
          "descriptive_post_publication_observation_not_causal",
        educationalEffectClaimed: false,
        containsForumText: false
      })
    ),
    {
      outcome: "observed",
      evidenceSource: "target_thread",
      attribution:
        "descriptive_post_publication_observation_not_causal",
      educationalEffectClaimed: false
    }
  );
  assert.equal(
    parseSafeOutcomeEvidenceSummary(
      JSON.stringify({
        outcome: "observed",
        evidenceSource: "full_course",
        educationalEffectClaimed: true,
        containsForumText: false
      })
    ),
    null
  );
  assert.equal(
    parseSafeOutcomeEvidenceSummary(
      JSON.stringify({
        outcome: "observed",
        evidenceSource: "target_thread",
        body: "不应进入治理摘要",
        educationalEffectClaimed: false,
        containsForumText: true
      })
    ),
    null
  );
});

test("运行页只投影 Decision Tape 中允许展示的治理字段", () => {
  assert.deepEqual(
    parseSafeDecisionTapeGovernancePayload(
      "proximal_outcome_observed",
      JSON.stringify({
        schemaVersion:
          "cmooc.proximal-outcome-observation.v1",
        observationWindow: "R24",
        status: "observed",
        evidenceSource: "target_thread",
        authorReturned: false,
        replyDepthDelta: 1,
        newAuthorCount: 0,
        educationalEffectClaimed: false,
        containsForumText: false,
        unexpected: "must be dropped"
      }),
      false
    ),
    {
      kind: "proximal_outcome_observed",
      observationWindow: "R24",
      status: "observed",
      evidenceSource: "target_thread",
      authorReturned: false,
      replyDepthDelta: 1,
      newAuthorCount: 0,
      educationalEffectClaimed: false
    }
  );
  assert.equal(
    parseSafeDecisionTapeGovernancePayload(
      "proximal_outcome_observed",
      JSON.stringify({
        observationWindow: "R24",
        containsForumText: true
      }),
      true
    ),
    null
  );
});
