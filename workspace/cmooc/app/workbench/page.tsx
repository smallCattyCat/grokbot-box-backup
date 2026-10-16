import type { Metadata } from "next";
import { AgentWorkbench } from "@/components/workbench/AgentWorkbench";
import { buildAgentNativeWorkbenchViewModel } from "@/lib/workbench/agent-native-adapter";
import { getOperatorWorkspaceReadModel } from "@/lib/workbench/operator-read-model";

export const metadata: Metadata = {
  title: "智能控制台 | cMOOC 智能学伴",
  description: "通过清晰的任务对话、过程事件与最终答复完成可核验的课程研判。"
};

export const dynamic = "force-dynamic";

export default async function WorkbenchPage({
  searchParams
}: {
  searchParams?: {
    focus?: string | string[];
  };
}) {
  const operator = await getOperatorWorkspaceReadModel();
  const requestedFocus = Array.isArray(searchParams?.focus)
    ? searchParams.focus[0]
    : searchParams?.focus;
  const agentNative = buildAgentNativeWorkbenchViewModel({
    operator,
    focusQuery: requestedFocus
  });
  return <AgentWorkbench operator={operator} agentNative={agentNative} />;
}
