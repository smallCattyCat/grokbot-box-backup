import { NextResponse } from "next/server";
import { getOperatorManifest } from "@/lib/operator-registry";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ...getOperatorManifest(),
    generatedAt: new Date().toISOString()
  }, {
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
