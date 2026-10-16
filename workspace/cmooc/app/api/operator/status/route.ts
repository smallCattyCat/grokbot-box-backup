import { NextResponse } from "next/server";
import { getOperatorStatusPayload } from "@/lib/agent-console-operator-status";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const payload = await getOperatorStatusPayload({
    detail: searchParams.get("detail") === "full" ? "full" : "summary",
    fresh: searchParams.get("fresh") === "true"
  });
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
