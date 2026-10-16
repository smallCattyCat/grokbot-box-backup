import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCourseLabel as formatDecisionCourseLabel,
  formatDecisionReason,
  formatExecutionBoundary,
  formatRunMode as formatDecisionRunMode,
  formatCourseLabel as formatRunCourseLabel,
  formatRunMode,
  formatRunSafetyMessage,
  formatTapeStageLabel
} from "../../lib/autonomy/run-operator-presentation";

test("运行记录默认把课程和运行模式翻译成人类语言", () => {
  assert.equal(formatDecisionRunMode("shadow"), "只读运行");
  assert.equal(formatRunMode("SHADOW"), "只读运行");
  assert.equal(
    formatDecisionCourseLabel(
      "bnu-test",
      new Map([["bnu-test", "生成式课程的设计与实施（常态公开课）"]])
    ),
    "生成式课程的设计与实施（常态公开课）"
  );
  assert.equal(formatRunCourseLabel("bnu-test"), "已绑定课程");
});

test("运行记录用人类理由替代原因码，但仍允许未知原因安全回退", () => {
  assert.equal(
    formatDecisionReason("external_human_response"),
    "检测到新的真人互动，系统让位"
  );
  assert.equal(
    formatDecisionReason("source_censored"),
    "评论范围不完整，暂不行动"
  );
  assert.equal(
    formatDecisionReason("unrecognised_future_reason"),
    "按当前证据保持克制"
  );
});

test("运行记录明确保留未发布边界", () => {
  assert.equal(
    formatExecutionBoundary({
      bodyPersisted: false,
      editorWriteAttempted: false,
      publishAttempted: false
    }),
    "未写入课程平台"
  );
  assert.equal(
    formatExecutionBoundary({
      bodyPersisted: true,
      editorWriteAttempted: true,
      publishAttempted: false
    }),
    "仅暂存于编辑器，未发布"
  );
  assert.equal(
    formatExecutionBoundary({
      bodyPersisted: false,
      editorWriteAttempted: false,
      publishAttempted: true
    }),
    "记录了发布尝试，真实发布仍受硬锁"
  );
});

test("运行详情默认隐藏内部阶段码并保留安全运行摘要", () => {
  assert.equal(
    formatTapeStageLabel("content_graph_v2_committed"),
    "互动关系已更新"
  );
  assert.equal(formatTapeStageLabel("future_internal_stage"), "运行阶段");
  assert.equal(
    formatRunSafetyMessage({
      editorWriteAttemptCount: 0,
      externalWriteAttemptCount: 0,
      requestedMutationCount: 0,
      sentMutationCount: 0,
      publishAttemptCount: 0
    }),
    "本次运行未向课程平台写入，真实发布仍关闭。"
  );
  assert.equal(
    formatRunSafetyMessage({
      editorWriteAttemptCount: 1,
      externalWriteAttemptCount: 1,
      requestedMutationCount: 1,
      sentMutationCount: 0,
      publishAttemptCount: 0
    }),
    "本次运行记录了编辑器或平台写入尝试；真实发布仍关闭。"
  );
});
