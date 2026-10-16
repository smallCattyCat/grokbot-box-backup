import { NextResponse } from "next/server";
import { getOperatorApiCatalog } from "@/lib/operator-api-catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ...getOperatorApiCatalog(),
    generatedAt: new Date().toISOString()
  }, {
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
