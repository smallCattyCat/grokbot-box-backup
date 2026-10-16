import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import { skipIntervention } from "@/lib/workflow";

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const denied = requireTrustedJsonMutation(request, "跳过干预计划");
    if (denied) return denied;
    const task = await skipIntervention(params.id);
    return NextResponse.json(task);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "干预计划未能跳过。"
    }, { status: 409 });
  }
}
