import { prisma } from "@/lib/db";
import type { AgentStatus } from "@/lib/types";

export type RecordAgentRunInput<TInput, TOutput> = {
  courseId?: string;
  taskId?: string;
  postId?: string;
  agentName: string;
  input: TInput;
  output: TOutput;
  status?: AgentStatus;
  startedAt?: Date;
};

export type AgentRunRecorder = (
  input: RecordAgentRunInput<unknown, unknown>
) => Promise<unknown>;

export async function recordAgentRun<TInput, TOutput>({
  taskId,
  postId,
  courseId,
  agentName,
  input,
  output,
  status = "success",
  startedAt = new Date()
}: RecordAgentRunInput<TInput, TOutput>) {
  return prisma.agentRun.create({
    data: {
      taskId,
      postId,
      courseId,
      agentName,
      inputJson: JSON.stringify(input, null, 2),
      outputJson: JSON.stringify(output, null, 2),
      status,
      startedAt,
      finishedAt: new Date()
    }
  });
}

type BestEffortDependencies = {
  record?: AgentRunRecorder;
  warn?: (message: string) => void;
};

export async function recordAgentRunBestEffort<TInput, TOutput>(
  input: RecordAgentRunInput<TInput, TOutput>,
  dependencies: BestEffortDependencies = {}
) {
  try {
    return await (dependencies.record ?? recordAgentRun)(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (dependencies.warn ?? console.warn)(
      `[agent-run] ${input.agentName} 日志写入失败，但已提交的业务结果保持不变：${message}`
    );
    return null;
  }
}
