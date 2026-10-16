import { NextResponse } from "next/server";
import { getAgentContextTraces } from "@/lib/agents/context-trace";

type RouteContext = {
  params: { id: string };
};

export async function GET(_request: Request, context: RouteContext) {
  const payload = await getAgentContextTraces(context.params.id);
  if (!payload) {
    return NextResponse.json({ error: "Intervention task not found" }, { status: 404 });
  }
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "no-store" }
  });
}
