import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import { skipAutoInterventionCandidate } from "@/lib/interventions/intervention-service";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const denied = requireTrustedJsonMutation(request, "忽略候选");
    if (denied) return denied;
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    const skipped = await skipAutoInterventionCandidate({
      candidateId: params.id,
      reason: body.reason
    });
    return NextResponse.json(skipped);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "候选未能跳过。"
    }, { status: 400 });
  }
}
