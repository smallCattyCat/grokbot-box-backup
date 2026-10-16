import {
  addWorkbenchArtifact,
  appendWorkbenchEvent,
  completeWorkbenchRun,
  getWorkbenchRun,
  setWorkbenchPlan,
  setWorkbenchRunStatus,
  updateWorkbenchAgent,
  updateWorkbenchTool
} from "@/lib/workbench/run-store";

export const DEMO_FINAL_SUMMARY = [
  "演示任务已完成；未连接真实执行引擎，未执行任何外部写入。",
  "",
  "已完成：",
  "- 建立受约束计划与角色分工",
  "- 汇总工具状态和演示产物元数据",
  "- 核验课程平台写入与外部通知均为 0",
  "",
  "下一步：可以追加更具体的目标，或基于左侧匿名关系证据发起新的研判。"
].join("\n");

const demoTimers = new Set<ReturnType<typeof setTimeout>>();
const DEMO_INITIAL_DELAY_MS = 250;
const DEMO_STEP_DELAY_MS = 450;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      demoTimers.delete(timer);
      resolve();
    }, milliseconds);
    demoTimers.add(timer);
  });
}

/**
 * Starts the deterministic, non-networked workbench fixture. The fixture only
 * emits safe labels and never includes the submitted prompt in an event.
 */
export function scheduleDemoRun(runId: string): void {
  void (async () => {
    await wait(DEMO_INITIAL_DELAY_MS);
    if (!getWorkbenchRun(runId)) return;
    setWorkbenchRunStatus(runId, "starting", { summary: "演示运行正在启动。" });
    updateWorkbenchAgent(runId, {
      key: "sol",
      label: "主任务智能体",
      role: "sol",
      status: "running"
    });
    appendWorkbenchEvent(runId, {
      kind: "agent",
      status: "running",
      title: "主任务智能体已接手演示任务",
      agentKey: "sol",
      agentLabel: "主任务智能体",
      agentRole: "sol"
    });
    setWorkbenchPlan(runId, {
      explanation: "按可验证步骤推进演示任务。",
      steps: [
        { step: "核对任务边界", status: "completed" },
        { step: "检查工具与文件变化", status: "inProgress" },
        { step: "整理安全答复", status: "pending" }
      ]
    });

    await wait(DEMO_STEP_DELAY_MS);
    if (getWorkbenchRun(runId)?.status !== "starting") return;
    setWorkbenchRunStatus(runId, "running", { summary: "演示事件正在生成。" });
    appendWorkbenchEvent(runId, {
      kind: "plan",
      status: "completed",
      title: "已生成受约束计划",
      summary: "检查任务、整理本地工作区并返回安全摘要。",
      agentKey: "sol",
      agentLabel: "主任务智能体",
      agentRole: "sol"
    });

    updateWorkbenchAgent(runId, {
      key: "luna-1",
      label: "协作智能体 #1",
      role: "luna",
      status: "completed",
      taskSummary: "演示协作子任务"
    });
    appendWorkbenchEvent(runId, {
      kind: "agent",
      status: "completed",
      title: "协作智能体 #1 已完成协作子任务",
      summary: "演示协作仅使用静态安全标签。",
      agentKey: "luna-1",
      agentLabel: "协作智能体 #1",
      agentRole: "luna"
    });

    await wait(DEMO_STEP_DELAY_MS);
    if (getWorkbenchRun(runId)?.status !== "running") return;
    updateWorkbenchTool(runId, {
      key: "demo-observer",
      label: "演示观察器",
      category: "other",
      status: "completed",
      callCount: 1
    });
    appendWorkbenchEvent(runId, {
      kind: "tool",
      status: "completed",
      title: "演示观察器已完成",
      summary: "仅生成静态演示数据；未访问课程平台。",
      toolKey: "demo-observer"
    });
    addWorkbenchArtifact(runId, {
      id: "artifact-demo-handoff",
      label: "演示交接摘要（fixture）",
      relativePath: "artifacts/demo-handoff.json",
      kind: "created",
      status: "ready",
      observedAt: new Date().toISOString()
    });
    appendWorkbenchEvent(runId, {
      kind: "artifact",
      status: "completed",
      title: "演示产物元数据已生成",
      summary: "这是 fixture 元数据，不代表真实执行引擎创建了文件。",
      artifactId: "artifact-demo-handoff"
    });
    setWorkbenchPlan(runId, {
      explanation: "按可验证步骤推进演示任务。",
      steps: [
        { step: "核对任务边界", status: "completed" },
        { step: "检查工具与文件变化", status: "completed" },
        { step: "整理安全答复", status: "inProgress" }
      ]
    });

    await wait(DEMO_STEP_DELAY_MS);
    if (getWorkbenchRun(runId)?.status !== "running") return;
    appendWorkbenchEvent(runId, {
      kind: "message",
      status: "completed",
      title: "主任务智能体返回安全摘要",
      summary: "这是受约束的工作台演示消息。",
      liveExcerpt: "已完成受约束计划和静态工具核对，正在整理最终安全摘要。",
      agentKey: "sol",
      agentLabel: "主任务智能体",
      agentRole: "sol"
    });
    setWorkbenchPlan(runId, {
      explanation: "按可验证步骤推进演示任务。",
      steps: [
        { step: "核对任务边界", status: "completed" },
        { step: "检查工具与文件变化", status: "completed" },
        { step: "整理安全答复", status: "completed" }
      ]
    });
    updateWorkbenchAgent(runId, {
      key: "sol",
      label: "主任务智能体",
      role: "sol",
      status: "completed"
    });
    completeWorkbenchRun(
      runId,
      "completed",
      DEMO_FINAL_SUMMARY
    );
  })().catch(() => {
    completeWorkbenchRun(
      runId,
      "failed",
      "演示运行未完成。",
      "DEMO_RUN_FAILED"
    );
  });
}

export function resetDemoRunsForTests(): void {
  for (const timer of demoTimers) clearTimeout(timer);
  demoTimers.clear();
}
