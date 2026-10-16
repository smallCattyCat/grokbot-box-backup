import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import { prepareInterventionPlan } from "@/lib/interventions/intervention-service";

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const denied = requireTrustedJsonMutation(request, "生成干预计划");
    if (denied) return denied;
    return NextResponse.json(await prepareInterventionPlan({ taskId: params.id, force: true }));
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "干预计划生成失败。"
    }, { status: 409 });
  }
}
