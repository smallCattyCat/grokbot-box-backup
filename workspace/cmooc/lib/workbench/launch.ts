import { createHash } from "node:crypto";
import {
  WORKBENCH_LINEAGE_SCHEMA_VERSION,
  isWorkbenchRunLineage,
  redactPublicText,
  type WorkbenchLaunchInput,
  type WorkbenchRunLineage,
  type WorkbenchRunSnapshot
} from "@/lib/workbench/contracts";
import { buildWorkbenchPlanExecutionRequest } from "@/lib/workbench/presentation";
import type { WorkbenchDb } from "@/lib/workbench/durable-ledger";
import {
  loadVerifiedCourseAgentRecoveryBundle,
  type VerifiedCourseAgentRecoveryBundle
} from "@/lib/workbench/course-agent-checkpoint-hydrator";

type RecoveryBundleLoader = typeof loadVerifiedCourseAgentRecoveryBundle;

let recoveryBundleLoader: RecoveryBundleLoader =
  loadVerifiedCourseAgentRecoveryBundle;

/** Server route seam kept outside Next route modules so their export surface stays valid. */
export function loadWorkbenchCourseRecoveryBundle(
  db: WorkbenchDb,
  input: Parameters<RecoveryBundleLoader>[1]
): Promise<VerifiedCourseAgentRecoveryBundle> {
  return recoveryBundleLoader(db, input);
}

export function setWorkbenchCourseRecoveryBundleLoaderForTests(
  loader: RecoveryBundleLoader | undefined
): void {
  recoveryBundleLoader = loader ?? loadVerifiedCourseAgentRecoveryBundle;
}

export function deriveWorkbenchChildRunId(
  sourceRunId: string,
  input: WorkbenchLaunchInput
): string {
  const hex = createHash("sha256")
    .update(`cmooc.workbench.launch.v1\0${sourceRunId}\0${input.kind}\0${input.requestId}`)
    .digest("hex")
    .slice(0, 32);
  const variant = ["8", "9", "a", "b"][Number.parseInt(hex[16]!, 16) % 4]!;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function deriveWorkbenchChildLineage(
  source: WorkbenchRunSnapshot,
  input: WorkbenchLaunchInput
): WorkbenchRunLineage {
  const sourceLineage = isWorkbenchRunLineage(source.lineage, source.id)
    ? source.lineage
    : undefined;
  const generation = (sourceLineage?.generation ?? 0) + 1;
  if (generation > 16) throw new Error("WORKBENCH_LINEAGE_LIMIT");
  if (input.kind === "plan-execution") {
    return {
      schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
      relation: "plan-execution",
      rootRunId: sourceLineage?.rootRunId ?? source.id,
      parentRunId: source.id,
      planRunId: source.id,
      generation,
      requestId: input.requestId
    };
  }
  if (input.kind === "continuation") {
    return {
      schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
      relation: "continuation",
      rootRunId: sourceLineage?.rootRunId ?? source.id,
      parentRunId: source.id,
      generation,
      requestId: input.requestId
    };
  }
  const inheritedPlanRunId = sourceLineage?.planRunId;
  return {
    schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
    relation: "restart",
    rootRunId: sourceLineage?.rootRunId ?? source.id,
    parentRunId: source.id,
    recoveryOfRunId: source.id,
    ...(inheritedPlanRunId ? { planRunId: inheritedPlanRunId } : {}),
    generation,
    requestId: input.requestId
  };
}

export function buildWorkbenchChildPrompt(
  source: WorkbenchRunSnapshot,
  kind: WorkbenchLaunchInput["kind"]
): { prompt: string; displayPrompt: string } {
  if (kind === "plan-execution" && source.plan) {
    return buildWorkbenchPlanExecutionRequest(source.plan, source.taskTitle);
  }
  const title = redactPublicText(source.taskTitle, 160) || "课程研判任务";
  const result = redactPublicText(source.finalResult?.summary, 800) || "上一任务未能完成。";
  const handoff = source.sessionWorkspace?.projectRelativePath;
  const plan = source.plan?.steps.length
    ? source.plan.steps
        .slice(0, 12)
        .map((step, index) => `${index + 1}. ${redactPublicText(step.step, 240)}`)
        .join("\n")
    : "";
  if (kind === "continuation") {
    return {
      displayPrompt: `基于结果继续：${title}`,
      prompt: [
        "请创建一个全新的本机任务，基于已完成父任务的安全摘要继续下一步。不要声称恢复了已经结束或消失的旧线程。",
        `父任务：${title}`,
        `父任务安全结果：${result}`,
        handoff
          ? `父任务安全交接目录：${handoff}。只可复用其中的 session.json、handoff.md 与产物索引；其中不含原始提示或底层线程标识。`
          : "没有可复用的安全交接目录，请从当前安全上下文重新核验。",
        ...(plan ? [`父任务记录的计划：\n${plan}`] : []),
        "先重新核验当前工作区状态，再完成父任务建议但尚未落实的下一步。保持课程平台零外部写入边界；完成后给出充分、可核验的答复。"
      ].join("\n\n")
    };
  }
  return {
    displayPrompt: `重新启动：${title}`,
    prompt: [
      "请创建一个全新的本机任务，重新核验并继续上一任务尚未完成的工作。不要声称恢复了旧线程。",
      `任务：${title}`,
      `上一任务结果：${result}`,
      source.errorCode ? `失败代码：${source.errorCode}` : "失败代码：未记录",
      handoff
        ? `安全交接目录：${handoff}。只可复用其中的 session.json、handoff.md 与产物索引；其中不含原始提示或底层线程标识。`
        : "没有可复用的安全交接目录，请从当前安全上下文重新核验。",
      ...(plan ? [`已确认计划：\n${plan}`] : []),
      "保持课程平台零外部写入边界；完成后给出充分、可核验的答复。"
    ].join("\n\n")
  };
}

/**
 * Fixed, body-free instruction for a server-verified draft recovery child.
 * The checkpoint reference and all recovery material stay in the typed tool
 * runtime; neither the model prompt nor the visible transcript receives them.
 */
export function buildWorkbenchCourseDraftRecoveryPrompt(
  source: Pick<WorkbenchRunSnapshot, "taskTitle">
): { prompt: string; displayPrompt: string } {
  const title = redactPublicText(source.taskTitle, 160) || "课程研判任务";
  return {
    displayPrompt: `恢复课程成果：${title}`,
    prompt: [
      "执行服务端已绑定并核验的课程草稿恢复计划。不要重放父任务，也不要声称恢复了已经结束的旧线程。",
      "严格按当前 canonical plan 调用课程工具；草稿正文与 checkpoint 材料只能由受约束工具在服务端重建，不得从提示、历史摘要或平台页面猜测。",
      "平台动作只允许预检、可清除的编辑器暂存核验与零发布成果交付。禁止发布、提交、发送或通知。",
      "若任何工具返回冲突、未知或验证失败，立即停止并如实报告；不得绕过验证、改变计划或扩大权限。"
    ].join("\n\n")
  };
}
