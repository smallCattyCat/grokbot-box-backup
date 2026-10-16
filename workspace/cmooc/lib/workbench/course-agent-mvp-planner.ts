import type { JsonGenerationInput } from "@/lib/llm/client";
import { generateJson, getLlmRuntimeStatus } from "@/lib/llm/client";
import type {
  CourseToolManifestEntry,
  CourseToolRegistryManifest
} from "@/lib/course-tools/registry";
import type { SafeJsonValue } from "@/lib/workbench/durable-ledger";
import type {
  CanonicalPlanStepInput,
  CreatePlanRevisionInput
} from "@/lib/workbench/plan-store";
import type { WorkbenchContextSummary, WorkbenchRunSnapshot } from "@/lib/workbench/contracts";
import { workbenchTaskId, type CourseAgentExecutionIntent } from "@/lib/workbench/course-agent-plan";

export const MVP_COURSE_AGENT_GOAL_CODE = "open_course_task" as const;
export const MVP_COURSE_AGENT_PLAN_SCHEMA_VERSION =
  "cmooc.course-agent-mvp-plan.v1" as const;
export const MVP_COURSE_AGENT_PLAN_COMPILER_VERSION =
  "cmooc.course-agent-mvp-plan-compiler.v1" as const;

export type CourseAgentMvpToolSelection = Readonly<{
  name: string;
  version: string;
}>;

export type CourseAgentMvpPlanSelection = Readonly<{
  schemaVersion: typeof MVP_COURSE_AGENT_PLAN_SCHEMA_VERSION;
  goalCode: typeof MVP_COURSE_AGENT_GOAL_CODE;
  tools: readonly CourseAgentMvpToolSelection[];
  containsPrompt: false;
}>;

type PlanGenerator = (input: JsonGenerationInput) => Promise<unknown>;

export class CourseAgentMvpPlannerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CourseAgentMvpPlannerError";
  }
}

function invalid(message: string): never {
  throw new CourseAgentMvpPlannerError("COURSE_AGENT_MVP_PLAN_INVALID", message);
}

function toolKey(tool: Pick<CourseToolManifestEntry, "name" | "version">): string {
  return `${tool.name}@${tool.version}`;
}

const MVP_COMPOSABLE_ARTIFACT_TOOLS = new Set([
  "research.evidence_package.prepare",
  "schedule.review_bundle.create"
]);

function mvpTools(
  manifest: CourseToolRegistryManifest,
  intent: CourseAgentExecutionIntent
): readonly CourseToolManifestEntry[] {
  return manifest.tools.filter(
    (tool) =>
      tool.capability === "L0_READ" ||
      (intent === "implement" &&
        tool.capability === "L1_ARTIFACT" &&
        MVP_COMPOSABLE_ARTIFACT_TOOLS.has(tool.name))
  );
}

function mockPlan(prompt: string, intent: CourseAgentExecutionIntent): readonly string[] {
  const wantsResearch = /研究|证据包|research|evidence/iu.test(prompt);
  const wantsSchedule = /排期|调度|时间表|schedule|cadence/iu.test(prompt);
  if (wantsResearch && wantsSchedule) {
    return intent === "implement"
      ? [
          "course.context.resolve@1",
          "course.snapshot.read@1",
          "research.evidence_package.prepare@1",
          "course.schedule.read@1",
          "schedule.review_bundle.create@1"
        ]
      : [
          "course.context.resolve@1",
          "course.snapshot.read@1",
          "course.schedule.read@1"
        ];
  }
  return ["course.context.resolve@1", "course.snapshot.read@1"];
}

function parseGeneratedPlan(
  value: unknown,
  manifest: CourseToolRegistryManifest,
  intent: CourseAgentExecutionIntent
): CourseAgentMvpPlanSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("MVP planner must return one JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.tools)) {
    invalid("MVP planner output must contain only a tools array.");
  }
  if (record.tools.length < 1 || record.tools.length > 8) {
    invalid("MVP plan must contain 1 to 8 tools.");
  }
  const allowed = new Map(
    mvpTools(manifest, intent).map((tool) => [toolKey(tool), tool])
  );
  const seen = new Set<string>();
  const tools = record.tools.map((value) => {
    if (typeof value !== "string" || seen.has(value)) {
      invalid("MVP plan tool references must be unique name@version strings.");
    }
    const entry = allowed.get(value);
    if (!entry) {
      invalid("MVP plan selected an unavailable or non-MVP tool.");
    }
    seen.add(value);
    return Object.freeze({ name: entry.name, version: entry.version });
  });
  return Object.freeze({
    schemaVersion: MVP_COURSE_AGENT_PLAN_SCHEMA_VERSION,
    goalCode: MVP_COURSE_AGENT_GOAL_CODE,
    tools: Object.freeze(tools),
    containsPrompt: false
  });
}

export async function planCourseAgentMvpGoal(input: {
  prompt: string;
  intent: CourseAgentExecutionIntent;
  registryManifest: CourseToolRegistryManifest;
  mode?: "mock" | "real";
  generate?: PlanGenerator;
}): Promise<CourseAgentMvpPlanSelection> {
  const available = mvpTools(input.registryManifest, input.intent);
  if (available.length === 0) invalid("No MVP course tools are available.");
  let generated: unknown;
  if (input.generate) {
    generated = await input.generate({
      system: "Select a short course-operations tool plan from the provided registry.",
      user: input.prompt,
      schemaName: "CourseAgentMvpPlan",
      temperature: 0
    });
  } else if ((input.mode ?? getLlmRuntimeStatus().mode) === "mock") {
    generated = { tools: mockPlan(input.prompt, input.intent) };
  } else {
    const catalog = available.map((tool) => ({
      tool: toolKey(tool),
      description: tool.safeDescription,
      effect: tool.effect
    }));
    generated = await generateJson<unknown>({
      system: [
        "You are a compact course-operations planner.",
        "Return JSON with exactly one key: tools.",
        "tools must be an array of 1-8 unique name@version values from the catalog.",
        "Choose the shortest sequence that can honestly advance the goal.",
        "Do not select publishing, external-stage, or recovery tools."
      ].join("\n"),
      user: `Goal:\n${input.prompt}\n\nIntent: ${input.intent}\n\nCatalog:\n${JSON.stringify(catalog)}`,
      schemaName: "CourseAgentMvpPlan",
      temperature: 0
    });
  }
  return parseGeneratedPlan(generated, input.registryManifest, input.intent);
}

export function restoreCourseAgentMvpPlanSelection(input: {
  tools: readonly Readonly<{ name: string; version: string }>[];
  intent: CourseAgentExecutionIntent;
  registryManifest: CourseToolRegistryManifest;
}): CourseAgentMvpPlanSelection {
  return parseGeneratedPlan(
    { tools: input.tools.map((tool) => toolKey(tool)) },
    input.registryManifest,
    input.intent
  );
}

function contextRef(context: WorkbenchContextSummary): string {
  if (!context.ref || !context.courseAlias || context.kind === "learner") {
    throw new CourseAgentMvpPlannerError(
      "COURSE_AGENT_MVP_CONTEXT_REQUIRED",
      "MVP course planning requires a course-scoped context reference."
    );
  }
  return context.ref;
}

export function compileCourseAgentMvpPlan(input: {
  run: Pick<WorkbenchRunSnapshot, "id" | "lineage" | "context">;
  objectiveHash: string;
  selection: CourseAgentMvpPlanSelection;
  intent: CourseAgentExecutionIntent;
  registryManifest: CourseToolRegistryManifest;
  createdAt?: string;
}): CreatePlanRevisionInput {
  const context = input.run.context;
  if (!context) {
    throw new CourseAgentMvpPlannerError(
      "COURSE_AGENT_MVP_CONTEXT_REQUIRED",
      "MVP course planning requires a course context."
    );
  }
  const exactContextRef = contextRef(context);
  const available = new Map(
    mvpTools(input.registryManifest, input.intent).map((tool) => [toolKey(tool), tool])
  );
  const steps: CanonicalPlanStepInput[] = input.selection.tools.map((selected, index) => {
    const tool = available.get(toolKey(selected));
    if (!tool) invalid("MVP plan no longer matches the current tool registry.");
    const stepId = `mvp-step-${input.run.id}-${index + 1}`;
    const previousStepId = index > 0 ? `mvp-step-${input.run.id}-${index}` : null;
    const inputRefs: SafeJsonValue[] = previousStepId
      ? [{ kind: "verified_step_output", ref: previousStepId }]
      : [{
          kind: "workbench_context",
          ref: exactContextRef,
          evidenceHash: context.evidenceHash ?? null
        }];
    return {
      id: stepId,
      ordinal: index + 1,
      toolName: tool.name,
      toolVersion: tool.version,
      dependencyIds: previousStepId ? [previousStepId] : [],
      inputRefs,
      preconditions: [{
        code: previousStepId ? "dependency_completed" : "course_context_available",
        required: true
      }],
      postconditions: [{ code: "tool_result_recorded", required: true }],
      effectClass: tool.effect,
      requiredCapability: tool.capability,
      acceptance: { code: "tool_result_recorded", status: "passed_or_bounded_no_action" },
      replanPolicy: { on: "failed_or_unknown", action: "stop_and_replan" },
      safeSummary: tool.safeLabel
    };
  });
  return {
    id: `mvp-plan-${input.run.id}`,
    taskId: workbenchTaskId(input.run),
    runId: input.run.id,
    objectiveHash: input.objectiveHash,
    compilerVersion: MVP_COURSE_AGENT_PLAN_COMPILER_VERSION,
    safeSummary: "按当前课程目标组合已有工具，并交付可验证结果。",
    steps,
    ...(input.createdAt ? { createdAt: input.createdAt } : {})
  };
}
