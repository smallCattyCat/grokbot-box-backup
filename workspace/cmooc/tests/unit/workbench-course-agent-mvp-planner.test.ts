import assert from "node:assert/strict";
import test from "node:test";
import { createCourseAgentToolkit } from "../../lib/workbench/course-agent-toolkit";
import {
  compileCourseAgentMvpPlan,
  planCourseAgentMvpGoal,
  CourseAgentMvpPlannerError,
  MVP_COURSE_AGENT_GOAL_CODE,
  MVP_COURSE_AGENT_PLAN_COMPILER_VERSION
} from "../../lib/workbench/course-agent-mvp-planner";
import { classifyCourseAgentTaskFamily } from "../../lib/workbench/course-agent-task-family";

const CONTEXT = Object.freeze({
  schemaVersion: "cmooc.workbench-context.v1" as const,
  kind: "snapshot" as const,
  ref: "snapshot:mvp-open-goal",
  title: "MVP open goal fixture",
  courseAlias: "mvp-course",
  state: "ready",
  evidenceHash: "a".repeat(64),
  containsForumText: false as const
});

function manifest() {
  return createCourseAgentToolkit({
    taskId: "mvp-task",
    runId: "mvp-run",
    courseAlias: "mvp-course"
  }).registry.manifest();
}

test("an ambiguous mixed course goal becomes one validated open plan over existing tools", async () => {
  const prompt = "请先检查课程排期，再生成一份研究证据包。";
  assert.equal(classifyCourseAgentTaskFamily(prompt).goalCode, null);

  const selection = await planCourseAgentMvpGoal({
    prompt,
    intent: "implement",
    registryManifest: manifest(),
    generate: async () => ({
      tools: [
        "course.context.resolve@1",
        "course.snapshot.read@1",
        "research.evidence_package.prepare@1",
        "course.schedule.read@1",
        "schedule.review_bundle.create@1"
      ]
    })
  });

  assert.equal(selection.goalCode, MVP_COURSE_AGENT_GOAL_CODE);
  assert.deepEqual(selection.tools.map((tool) => tool.name), [
    "course.context.resolve",
    "course.snapshot.read",
    "research.evidence_package.prepare",
    "course.schedule.read",
    "schedule.review_bundle.create"
  ]);
  assert.equal(JSON.stringify(selection).includes(prompt), false);

  const plan = compileCourseAgentMvpPlan({
    run: {
      id: "mvp-run",
      context: CONTEXT,
      lineage: {
        schemaVersion: "cmooc.workbench-lineage.v1",
        rootRunId: "mvp-run",
        generation: 0,
        relation: "root"
      }
    },
    objectiveHash: "b".repeat(64),
    selection,
    intent: "implement",
    registryManifest: manifest(),
    createdAt: "2026-08-13T12:00:00.000Z"
  });

  assert.equal(plan.compilerVersion, MVP_COURSE_AGENT_PLAN_COMPILER_VERSION);
  assert.equal(plan.steps.length, 5);
  assert.deepEqual(plan.steps.map((step) => step.toolName), selection.tools.map((tool) => tool.name));
  assert.equal(JSON.stringify(plan).includes(prompt), false);
});

test("the MVP planner rejects unknown, duplicate and external-stage tools", async () => {
  for (const tools of [
    ["unknown.tool@1"],
    ["course.snapshot.read@1", "course.snapshot.read@1"],
    ["platform.editor.stage_verify_clear@1"]
  ]) {
    await assert.rejects(
      () => planCourseAgentMvpGoal({
        prompt: "完成当前课程任务",
        intent: "implement",
        registryManifest: manifest(),
        generate: async () => ({ tools })
      }),
      (error: unknown) =>
        error instanceof CourseAgentMvpPlannerError &&
        error.code === "COURSE_AGENT_MVP_PLAN_INVALID"
    );
  }
});

test("mock mode composes a useful mixed plan without an external model", async () => {
  const selection = await planCourseAgentMvpGoal({
    prompt: "把课程排期检查和研究证据整理放在同一次任务里。",
    intent: "implement",
    registryManifest: manifest(),
    mode: "mock"
  });
  assert.deepEqual(selection.tools.map((tool) => tool.name), [
    "course.context.resolve",
    "course.snapshot.read",
    "research.evidence_package.prepare",
    "course.schedule.read",
    "schedule.review_bundle.create"
  ]);
});
