import { canonicalProtocolHash } from "@/lib/facilitation-protocol";
import {
  COURSE_TOOL_POLICY_VERSION
} from "@/lib/course-tools/policy-gateway";
import type {
  CourseToolManifestEntry,
  CourseToolRegistryManifest
} from "@/lib/course-tools/registry";
import type {
  CreateSafeTaskObjectiveInput,
  SafeJsonValue
} from "@/lib/workbench/durable-ledger";
import type {
  CanonicalPlanStepInput,
  CreatePlanRevisionInput
} from "@/lib/workbench/plan-store";
import type {
  WorkbenchContextSummary,
  WorkbenchCourseGoalCode,
  WorkbenchRunSnapshot
} from "@/lib/workbench/contracts";

export const COURSE_AGENT_OBJECTIVE_CLASSIFIER_VERSION =
  "cmooc.course-agent-objective-classifier.v2" as const;
export const COURSE_AGENT_PLAN_COMPILER_VERSION =
  "cmooc.course-agent-plan-compiler.v3" as const;
export const COURSE_AGENT_RECOVERY_PLAN_COMPILER_VERSION =
  "cmooc.course-agent-recovery-plan-compiler.v1" as const;

export type CourseAgentExecutionIntent = "inspect" | "implement";
export type CourseAgentGoalCode = WorkbenchCourseGoalCode;
export type CourseAgentRecoveryMode = "regenerate_draft";

type CourseAgentPlanToolSpec = Readonly<{
  name: string;
  version: string;
  safeSummary: string;
  postcondition: string;
  capability: "L0_READ" | "L1_ARTIFACT" | "L3_EXTERNAL_STAGE";
  effects: readonly (
    | "pure"
    | "read"
    | "local_write"
    | "external_stage"
  )[];
}>;

const COURSE_EVIDENCE_TOOLS: readonly CourseAgentPlanToolSpec[] = [
  {
    name: "course.context.resolve",
    version: "1",
    safeSummary: "绑定当前任务的精确课程证据上下文。",
    postcondition: "exact_course_context_resolved",
    capability: "L0_READ",
    effects: ["read"]
  },
  {
    name: "course.snapshot.read",
    version: "1",
    safeSummary: "读取精确锚点对应的课程世界快照。",
    postcondition: "exact_course_snapshot_read",
    capability: "L0_READ",
    effects: ["read"]
  },
  {
    name: "opportunity.list",
    version: "1",
    safeSummary: "列出精确截止点下的课程机会或证据边界。",
    postcondition: "opportunity_sources_accounted",
    capability: "L0_READ",
    effects: ["read"]
  },
  {
    name: "opportunity.select_support_gap",
    version: "1",
    safeSummary: "按版本化规则选择成熟支持缺口或明确不行动。",
    postcondition: "support_gap_selection_resolved",
    capability: "L0_READ",
    // The selection handler rereads the exact persisted candidate set under
    // the server-bound course scope. It is deterministic and zero-write, but
    // it is still a durable read rather than a context-free pure function.
    effects: ["read"]
  },
  {
    name: "evidence.read_opportunity",
    version: "1",
    safeSummary: "读取所选机会的事项级证据。",
    postcondition: "opportunity_evidence_read",
    capability: "L0_READ",
    effects: ["read"]
  },
  {
    name: "evidence.verify_integrity",
    version: "1",
    safeSummary: "机械核验候选、覆盖、资格与图证据完整性。",
    postcondition: "opportunity_integrity_classified",
    capability: "L0_READ",
    effects: ["read"]
  }
] as const;

const COURSE_IMPLEMENTATION_TOOLS: readonly CourseAgentPlanToolSpec[] = [
  {
    name: "facilitation.intent.compose",
    version: "1",
    safeSummary: "把已核验选择编译为协议有效的 Intent 与 MoveSpec。",
    postcondition: "facilitation_intent_verified",
    capability: "L1_ARTIFACT",
    effects: ["local_write"]
  },
  {
    name: "artifact.reply_draft.create",
    version: "1",
    safeSummary: "生成受保护的短期草稿并完成隐私与主张核验。",
    postcondition: "restricted_draft_verified",
    capability: "L1_ARTIFACT",
    effects: ["local_write"]
  },
  {
    name: "platform.target.preflight_read",
    version: "1",
    safeSummary: "只读预检精确目标、页面绑定与空编辑器基线。",
    postcondition: "platform_target_preflight_ready",
    capability: "L0_READ",
    effects: ["read"]
  },
  {
    name: "platform.editor.stage_verify_clear",
    version: "1",
    safeSummary: "在一次性授权下暂存、回读核验并清空编辑器。",
    postcondition: "platform_stage_verified_and_cleared",
    capability: "L3_EXTERNAL_STAGE",
    effects: ["external_stage"]
  },
  {
    name: "delivery.bundle.create",
    version: "1",
    safeSummary: "交付草稿、验证与零发布边界组成的成果包。",
    postcondition: "delivery_bundle_verified",
    capability: "L1_ARTIFACT",
    effects: ["local_write"]
  }
] as const;

const RESEARCH_EVIDENCE_TOOLS: readonly CourseAgentPlanToolSpec[] = [
  COURSE_EVIDENCE_TOOLS[0],
  COURSE_EVIDENCE_TOOLS[1]
] as const;

const RESEARCH_PACKAGE_TOOL: CourseAgentPlanToolSpec = {
  name: "research.evidence_package.prepare",
  version: "1",
  safeSummary: "从精确课程锚点生成版本化、可验证的研究证据包。",
  postcondition: "research_evidence_package_verified",
  capability: "L1_ARTIFACT",
  effects: ["local_write"]
};

const SCHEDULE_READ_TOOLS: readonly CourseAgentPlanToolSpec[] = [
  {
    name: "course.schedule.read",
    version: "1",
    safeSummary: "读取课程排期、治理约束与最近零写入巡检状态。",
    postcondition: "course_schedule_state_verified",
    capability: "L0_READ",
    effects: ["read"]
  }
] as const;

const SCHEDULE_REVIEW_TOOL: CourseAgentPlanToolSpec = {
  name: "schedule.review_bundle.create",
  version: "1",
  safeSummary: "生成版本化课程排期审查成果，不启动或修改调度。",
  postcondition: "schedule_review_bundle_verified",
  capability: "L1_ARTIFACT",
  effects: ["local_write"]
};

const REGENERATE_DRAFT_RECOVERY_TOOLS: readonly CourseAgentPlanToolSpec[] = [
  {
    name: "artifact.reply_draft.regenerate",
    version: "1",
    safeSummary:
      "从服务器核验的检查点材料重新生成短期受保护草稿并复验。",
    postcondition: "restricted_draft_regenerated_and_verified",
    capability: "L1_ARTIFACT",
    effects: ["local_write"]
  },
  COURSE_IMPLEMENTATION_TOOLS[2],
  COURSE_IMPLEMENTATION_TOOLS[3],
  COURSE_IMPLEMENTATION_TOOLS[4]
] as const;

function planToolSpecs(
  goalCode: CourseAgentGoalCode,
  intent: CourseAgentExecutionIntent
): readonly CourseAgentPlanToolSpec[] {
  if (goalCode === "open_course_task") {
    throw new CourseAgentPlanCompilerError(
      "COURSE_AGENT_MVP_PLAN_REQUIRED",
      "Open course goals require the bounded MVP planner."
    );
  }
  if (goalCode === "research_evidence_package") {
    return intent === "implement"
      ? [...RESEARCH_EVIDENCE_TOOLS, RESEARCH_PACKAGE_TOOL]
      : RESEARCH_EVIDENCE_TOOLS;
  }
  if (goalCode === "schedule_review") {
    return intent === "implement"
      ? [...SCHEDULE_READ_TOOLS, SCHEDULE_REVIEW_TOOL]
      : SCHEDULE_READ_TOOLS;
  }
  return intent === "implement"
    ? [...COURSE_EVIDENCE_TOOLS, ...COURSE_IMPLEMENTATION_TOOLS]
    : COURSE_EVIDENCE_TOOLS;
}

function recoveryPlanToolSpecs(
  mode: CourseAgentRecoveryMode
): readonly CourseAgentPlanToolSpec[] {
  if (mode === "regenerate_draft") {
    return REGENERATE_DRAFT_RECOVERY_TOOLS;
  }
  throw new CourseAgentPlanCompilerError(
    "COURSE_AGENT_RECOVERY_MODE_UNSUPPORTED",
    "Course agent recovery mode is unsupported."
  );
}

export class CourseAgentPlanCompilerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CourseAgentPlanCompilerError";
    this.code = code;
  }
}

export function workbenchTaskId(
  run: Pick<WorkbenchRunSnapshot, "id" | "lineage">
): string {
  const rootRunId =
    run.lineage?.rootRunId && run.lineage.rootRunId.trim()
      ? run.lineage.rootRunId
      : run.id;
  return `task-${rootRunId}`;
}

function safeContextRef(context: WorkbenchContextSummary): string {
  if (!context.ref || !context.courseAlias) {
    throw new CourseAgentPlanCompilerError(
      "COURSE_AGENT_CONTEXT_REQUIRED",
      "Course agent tools require a server-resolved course context."
    );
  }
  return context.ref;
}

export function classifyCourseAgentObjective(input: {
  run: Pick<WorkbenchRunSnapshot, "id" | "lineage" | "context">;
  goalCode?: CourseAgentGoalCode;
  intent: CourseAgentExecutionIntent;
  createdAt?: string;
}): CreateSafeTaskObjectiveInput {
  const context = input.run.context;
  if (!context) {
    throw new CourseAgentPlanCompilerError(
      "COURSE_AGENT_CONTEXT_REQUIRED",
      "Course agent tools require a server-resolved course context."
    );
  }
  const contextRef = safeContextRef(context);
  const goalCode = input.goalCode ?? "course_evidence_support_gap";
  if (
    context.kind === "learner" ||
    context.kind === "course" ||
    (context.kind === "incident" &&
      !context.invocationId)
  ) {
    throw new CourseAgentPlanCompilerError(
      "COURSE_AGENT_EXACT_ANCHOR_REQUIRED",
      "Course agent evidence plan requires an exact run or snapshot anchor."
    );
  }
  const courseAlias = context.courseAlias;
  if (!courseAlias) {
    throw new CourseAgentPlanCompilerError(
      "COURSE_AGENT_CONTEXT_REQUIRED",
      "Course agent tools require a course-scoped context."
    );
  }
  const structuredGoal = {
    goalCode,
    courseAlias,
    contextRefs: [contextRef],
    requestedArtifactKinds:
      goalCode === "research_evidence_package"
        ? ["research_evidence_package"]
        : goalCode === "schedule_review"
          ? ["schedule_review_bundle"]
          : goalCode === "open_course_task"
            ? ["course_artifact"]
          : ["evidence_summary", "opportunity_analysis"],
    constraints: [
      "exact_course_anchor",
      "no_forum_text_persistence",
      "no_identity_persistence",
      "no_real_publish"
    ],
    // Execution intent is a per-run policy constraint. Keeping it out of the
    // immutable task objective lets an inspect turn be resumed as an
    // implement turn without silently replacing the original goal.
    capabilityCeiling: "L1_ARTIFACT" as const,
    policyVersion: COURSE_TOOL_POLICY_VERSION
  };
  const objectiveHash = canonicalProtocolHash(
    COURSE_AGENT_OBJECTIVE_CLASSIFIER_VERSION,
    {
      schemaVersion: COURSE_AGENT_OBJECTIVE_CLASSIFIER_VERSION,
      ...structuredGoal
    }
  );
  return {
    id: `objective-${input.run.id}`,
    taskId: workbenchTaskId(input.run),
    objectiveHash,
    safeSummary:
      goalCode === "research_evidence_package"
        ? "在精确课程锚点下读取并验证研究证据，形成版本化研究证据包。"
        : goalCode === "schedule_review"
          ? "读取课程排期与治理约束，形成不改变调度的版本化审查成果。"
          : goalCode === "open_course_task"
            ? "围绕精确课程锚点组合现有只读与成果工具，完成一次可验证的课程运营任务。"
          : "在精确课程锚点下读取并验证课程状态，识别成熟支持缺口，并形成可审阅成果。",
    structuredGoal,
    source: COURSE_AGENT_OBJECTIVE_CLASSIFIER_VERSION,
    ...(input.createdAt ? { createdAt: input.createdAt } : {})
  };
}

function manifestTool(
  manifest: CourseToolRegistryManifest,
  required: CourseAgentPlanToolSpec
): CourseToolManifestEntry {
  const entry = manifest.tools.find(
    (candidate) =>
      candidate.name === required.name && candidate.version === required.version
  );
  if (
    !entry ||
    entry.capability !== required.capability ||
    !required.effects.includes(
      entry.effect as CourseAgentPlanToolSpec["effects"][number]
    )
  ) {
    throw new CourseAgentPlanCompilerError(
      "COURSE_AGENT_REQUIRED_TOOL_UNAVAILABLE",
      `Required course tool ${required.name}@${required.version} is unavailable or has the wrong capability.`
    );
  }
  return entry;
}

export function compileCourseEvidencePlan(input: {
  run: Pick<WorkbenchRunSnapshot, "id" | "lineage" | "context">;
  objectiveHash: string;
  goalCode?: CourseAgentGoalCode;
  intent: CourseAgentExecutionIntent;
  registryManifest: CourseToolRegistryManifest;
  createdAt?: string;
}): CreatePlanRevisionInput {
  const context = input.run.context;
  if (!context) {
    throw new CourseAgentPlanCompilerError(
      "COURSE_AGENT_CONTEXT_REQUIRED",
      "Course agent plan requires a server-resolved course context."
    );
  }
  const contextRef = safeContextRef(context);
  const goalCode = input.goalCode ?? "course_evidence_support_gap";
  if (
    context.kind === "learner" ||
    context.kind === "course" ||
    (context.kind === "incident" &&
      !context.invocationId)
  ) {
    throw new CourseAgentPlanCompilerError(
      "COURSE_AGENT_EXACT_ANCHOR_REQUIRED",
      "Course agent evidence plan requires an exact run or snapshot anchor."
    );
  }
  const steps: CanonicalPlanStepInput[] = [];
  const requiredTools = planToolSpecs(goalCode, input.intent);
  for (const [index, required] of requiredTools.entries()) {
    const tool = manifestTool(input.registryManifest, required);
    const stepId = `step-${input.run.id}-${index + 1}`;
    const previous = steps[index - 1];
    const inputRefs: SafeJsonValue[] = previous
      ? [
          {
            kind: "verified_step_output",
            ref: previous.id
          }
        ]
      : [
          {
            kind: "workbench_context",
            ref: contextRef,
            evidenceHash: context.evidenceHash ?? null
          }
        ];
    steps.push({
      id: stepId,
      ordinal: index + 1,
      toolName: tool.name,
      toolVersion: tool.version,
      dependencyIds: previous ? [previous.id] : [],
      inputRefs,
      preconditions: [
        {
          code: index === 0
            ? "server_context_bound"
            : "dependency_receipt_verified",
          required: true
        }
      ],
      postconditions: [
        {
          code: required.postcondition,
          required: true
        }
      ],
      effectClass: tool.effect,
      requiredCapability: tool.capability,
      acceptance: {
        code: required.postcondition,
        status: "passed_or_bounded_no_action"
      },
      replanPolicy: {
        on: "failed_or_unknown",
        action: "stop_and_replan"
      },
      safeSummary: required.safeSummary
    });
  }
  return {
    id: `plan-${input.run.id}`,
    taskId: workbenchTaskId(input.run),
    runId: input.run.id,
    objectiveHash: input.objectiveHash,
    compilerVersion: COURSE_AGENT_PLAN_COMPILER_VERSION,
    safeSummary:
      goalCode === "research_evidence_package"
        ? input.intent === "implement"
          ? "读取精确课程证据并交付版本化、可验证的研究证据包。"
          : "读取研究证据所需的精确课程上下文与快照。"
        : goalCode === "schedule_review"
          ? input.intent === "implement"
            ? "读取课程排期与治理约束并交付零调度写入的审查成果。"
            : "读取课程排期、治理约束与最近零写入巡检状态。"
          : input.intent === "implement"
            ? "读取并核验精确课程证据，生成受保护草稿，经末端授权暂存核验并交付零发布成果包。"
            : "读取精确课程上下文，选择并核验成熟支持缺口或明确证据边界。",
    steps,
    ...(input.createdAt ? { createdAt: input.createdAt } : {})
  };
}

function verifiedCheckpointCausation(input: {
  mode: CourseAgentRecoveryMode;
  sourceCheckpointRef: string;
  sourceCheckpointHash: string;
}): SafeJsonValue {
  if (!/^[a-f0-9]{64}$/u.test(input.sourceCheckpointHash)) {
    throw new CourseAgentPlanCompilerError(
      "COURSE_AGENT_RECOVERY_CHECKPOINT_HASH_INVALID",
      "Course agent recovery requires a canonical source checkpoint hash."
    );
  }
  if (
    input.sourceCheckpointRef !==
    `course-checkpoint:${input.sourceCheckpointHash}`
  ) {
    throw new CourseAgentPlanCompilerError(
      "COURSE_AGENT_RECOVERY_CHECKPOINT_REF_MISMATCH",
      "Course agent recovery checkpoint reference does not match its hash."
    );
  }
  return Object.freeze({
    kind: "verified_checkpoint_causation",
    ref: input.sourceCheckpointRef,
    checkpointHash: input.sourceCheckpointHash,
    recoveryMode: input.mode,
    source: "server_compiler"
  });
}

/**
 * Compiles a fresh child-run plan from one server-verified durable checkpoint.
 *
 * The checkpoint binding lives only in immutable canonical-plan input refs. It
 * is deliberately absent from every model-authored business input: tool
 * handlers recover the corresponding material from the server-owned hydrated
 * ledger, while each downstream step retains the same explicit causation.
 */
export function compileCourseRecoveryPlan(input: {
  run: Pick<WorkbenchRunSnapshot, "id" | "lineage">;
  objectiveHash: string;
  mode: CourseAgentRecoveryMode;
  sourceCheckpointRef: string;
  sourceCheckpointHash: string;
  registryManifest: CourseToolRegistryManifest;
  createdAt?: string;
}): CreatePlanRevisionInput {
  const requiredTools = recoveryPlanToolSpecs(input.mode);
  const checkpointCausation = verifiedCheckpointCausation(input);
  const steps: CanonicalPlanStepInput[] = [];

  for (const [index, required] of requiredTools.entries()) {
    const tool = manifestTool(input.registryManifest, required);
    const stepId = `recovery-step-${input.run.id}-${index + 1}`;
    const previous = steps[index - 1];
    const inputRefs: SafeJsonValue[] = previous
      ? [
          {
            kind: "verified_step_output",
            ref: previous.id
          },
          checkpointCausation
        ]
      : [checkpointCausation];
    steps.push({
      id: stepId,
      ordinal: index + 1,
      toolName: tool.name,
      toolVersion: tool.version,
      dependencyIds: previous ? [previous.id] : [],
      inputRefs,
      preconditions: [
        {
          code: index === 0
            ? "server_verified_checkpoint_hydrated"
            : "dependency_receipt_verified",
          required: true
        },
        {
          code: "recovery_checkpoint_causation_bound",
          required: true
        }
      ],
      postconditions: [
        {
          code: required.postcondition,
          required: true
        }
      ],
      effectClass: tool.effect,
      requiredCapability: tool.capability,
      acceptance: {
        code: required.postcondition,
        status: "passed_or_bounded_no_action"
      },
      replanPolicy: {
        on: "failed_or_unknown",
        action: "stop_and_replan"
      },
      safeSummary: required.safeSummary
    });
  }

  return {
    id: `recovery-plan-${input.run.id}`,
    taskId: workbenchTaskId(input.run),
    runId: input.run.id,
    objectiveHash: input.objectiveHash,
    compilerVersion: COURSE_AGENT_RECOVERY_PLAN_COMPILER_VERSION,
    safeSummary:
      "从已核验检查点重新生成受保护草稿，重新预检和暂存核验，并交付零发布成果包。",
    steps,
    ...(input.createdAt ? { createdAt: input.createdAt } : {})
  };
}

export function firstSliceToolNames(
  intent: CourseAgentExecutionIntent = "inspect",
  goalCode: CourseAgentGoalCode = "course_evidence_support_gap"
): readonly string[] {
  return planToolSpecs(goalCode, intent).map((tool) => tool.name);
}
