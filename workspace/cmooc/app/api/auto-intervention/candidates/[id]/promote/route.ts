import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  prepareInterventionPlan,
  promoteAutoCandidateToInterventionTask
} from "@/lib/interventions/intervention-service";
import { normalizeTaskStatus } from "@/lib/state-machine";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const denied = requireTrustedJsonMutation(request, "固化候选计划");
    if (denied) return denied;
    const promoted = await promoteAutoCandidateToInterventionTask({
      candidateId: params.id
    });
    const status = normalizeTaskStatus(promoted.task.status);
    const task = status === "proposed" || status === "review_required"
      ? await prepareInterventionPlan({ taskId: promoted.task.id })
      : promoted.task;
    return NextResponse.json({ task, created: promoted.created });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "候选转换为干预计划失败。"
    }, { status: 400 });
  }
}
