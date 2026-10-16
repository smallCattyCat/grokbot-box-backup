import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCourseAgentTaskFamily,
  courseAgentGoalAcceptsContext,
  safeCourseAgentGoalObjective
} from "../../lib/workbench/course-agent-task-family";

test("course task family classifier selects each closed workflow without echoing the prompt", () => {
  const cases = [
    ["请为这个精确锚点识别支持缺口并形成回复草稿", "course_evidence_support_gap"],
    ["请生成一份研究证据包，供后续方法审计", "research_evidence_package"],
    ["请做课程排期审查，但不要启动调度", "schedule_review"]
  ] as const;

  for (const [prompt, expected] of cases) {
    const result = classifyCourseAgentTaskFamily(prompt);
    assert.equal(result.goalCode, expected);
    assert.equal(result.containsPrompt, false);
    assert.equal(result.containsForumText, false);
    assert.equal(result.containsIdentity, false);
    assert.equal(JSON.stringify(result).includes(prompt), false);
  }
});

test("all course task families require an exact non-learner anchor and expose only safe goal text", () => {
  for (const goalCode of [
    "course_evidence_support_gap",
    "research_evidence_package",
    "schedule_review",
    "open_course_task"
  ] as const) {
    assert.equal(
      courseAgentGoalAcceptsContext(goalCode, {
        kind: "snapshot",
        invocationId: "invocation-safe"
      }),
      true
    );
    assert.equal(
      courseAgentGoalAcceptsContext(goalCode, {
        kind: "course",
        invocationId: undefined
      }),
      false
    );
    assert.equal(
      courseAgentGoalAcceptsContext(goalCode, {
        kind: "learner",
        invocationId: "invocation-safe"
      }),
      false
    );
    const safeObjective = safeCourseAgentGoalObjective(goalCode);
    assert.ok(safeObjective.length > 20);
    assert.equal(safeObjective.includes("private-sentinel"), false);
  }
  assert.equal(
    courseAgentGoalAcceptsContext("schedule_review", {
      kind: "incident",
      invocationId: undefined
    }),
    false
  );
});

test("course task family classifier abstains on ambiguous and unsupported prompts", () => {
  const ambiguous = classifyCourseAgentTaskFamily(
    "同时生成研究证据包并完成课程排期审查"
  );
  assert.equal(ambiguous.goalCode, null);
  assert.equal(ambiguous.reasonCode, "ambiguous");

  const unsupportedPrompt = "private-sentinel-raw-goal: 请帮我看看这里";
  const unsupported = classifyCourseAgentTaskFamily(unsupportedPrompt);
  assert.equal(unsupported.goalCode, null);
  assert.equal(unsupported.reasonCode, "unsupported");
  assert.equal(JSON.stringify(unsupported).includes("private-sentinel"), false);
});

test("negated cross-family wording remains ambiguous instead of silently selecting a workflow", () => {
  const result = classifyCourseAgentTaskFamily(
    "不要做课程排期审查，只处理支持缺口"
  );
  assert.equal(result.goalCode, null);
  assert.equal(result.reasonCode, "ambiguous");
});
