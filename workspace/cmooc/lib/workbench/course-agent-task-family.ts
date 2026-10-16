import type {
  WorkbenchContextSummary,
  WorkbenchCourseGoalCode
} from "@/lib/workbench/contracts";

export const COURSE_AGENT_TASK_FAMILY_CLASSIFIER_VERSION =
  "cmooc.course-agent-task-family-classifier.v1" as const;

export type CourseAgentTaskFamilyClassification = Readonly<{
  schemaVersion: typeof COURSE_AGENT_TASK_FAMILY_CLASSIFIER_VERSION;
  goalCode: WorkbenchCourseGoalCode | null;
  reasonCode:
    | "support_gap_match"
    | "research_evidence_package_match"
    | "schedule_review_match"
    | "ambiguous"
    | "unsupported";
  containsPrompt: false;
  containsForumText: false;
  containsIdentity: false;
}>;

const SAFE_GOAL_OBJECTIVES: Readonly<Record<WorkbenchCourseGoalCode, string>> =
  Object.freeze({
    course_evidence_support_gap:
      "在精确课程锚点下核验支持缺口，并交付受约束、零发布的课程促进成果。",
    research_evidence_package:
      "在精确课程锚点下生成版本化、可验证且不含正文或身份的研究证据包。",
    schedule_review:
      "核验课程排期与治理约束，并交付不改变调度的版本化审查成果。",
    open_course_task:
      "围绕当前精确课程锚点组合可用工具，完成课程分析并交付可验证成果。"
  });

export function safeCourseAgentGoalObjective(
  goalCode: WorkbenchCourseGoalCode
): string {
  return SAFE_GOAL_OBJECTIVES[goalCode];
}

export function courseAgentGoalAcceptsContext(
  goalCode: WorkbenchCourseGoalCode,
  context: Pick<WorkbenchContextSummary, "kind" | "invocationId">
): boolean {
  if (context.kind === "learner") return false;
  if (context.kind === "course") return false;
  return context.kind !== "incident" || Boolean(context.invocationId);
}

type FixedCourseAgentGoalCode = Exclude<
  WorkbenchCourseGoalCode,
  "open_course_task"
>;

const FAMILY_PATTERNS: Readonly<
  Record<FixedCourseAgentGoalCode, readonly RegExp[]>
> = Object.freeze({
  course_evidence_support_gap: Object.freeze([
    /支持缺口/u,
    /促进机会/u,
    /干预机会/u,
    /回复草稿/u,
    /促进草稿/u,
    /介入建议/u,
    /support\s+gap/iu,
    /facilitation\s+(?:opportunity|draft)/iu,
    /intervention\s+(?:opportunity|draft)/iu,
    /reply\s+draft/iu
  ]),
  research_evidence_package: Object.freeze([
    /研究证据包/u,
    /证据研究包/u,
    /研究导出/u,
    /导出.{0,8}研究证据/u,
    /evidence\s+(?:research\s+)?package/iu,
    /research\s+(?:evidence\s+)?package/iu,
    /research\s+export/iu
  ]),
  schedule_review: Object.freeze([
    /排期审查/u,
    /排期复核/u,
    /课程排期/u,
    /巡检排期/u,
    /调度审查/u,
    /时间表审查/u,
    /schedule\s+review/iu,
    /review\s+(?:the\s+)?schedule/iu,
    /course\s+schedule/iu,
    /inspection\s+cadence/iu
  ])
});

/**
 * A deliberately narrow, server-only classifier. It returns only a closed
 * goal code and never echoes, normalizes, hashes, logs, or persists the prompt.
 * Multiple or absent matches abstain instead of silently choosing a workflow.
 */
export function classifyCourseAgentTaskFamily(
  prompt: string
): CourseAgentTaskFamilyClassification {
  const matches = (Object.keys(FAMILY_PATTERNS) as FixedCourseAgentGoalCode[])
    .filter((goalCode) =>
      FAMILY_PATTERNS[goalCode].some((pattern) => pattern.test(prompt))
    );
  const goalCode = matches.length === 1 ? matches[0]! : null;
  const reasonCode =
    matches.length > 1
      ? "ambiguous"
      : goalCode === "course_evidence_support_gap"
        ? "support_gap_match"
        : goalCode === "research_evidence_package"
          ? "research_evidence_package_match"
          : goalCode === "schedule_review"
            ? "schedule_review_match"
            : "unsupported";
  return Object.freeze({
    schemaVersion: COURSE_AGENT_TASK_FAMILY_CLASSIFIER_VERSION,
    goalCode,
    reasonCode,
    containsPrompt: false,
    containsForumText: false,
    containsIdentity: false
  });
}
