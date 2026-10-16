import { NextResponse } from "next/server";
import { getCmoocAuthStatus } from "@/lib/forum/cmooc-auth-status";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getCmoocAuthStatus(), {
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
