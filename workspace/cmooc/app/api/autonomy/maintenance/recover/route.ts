import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import { recoverExpiredInvocationLeases } from "@/lib/autonomy/runtime-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const denied = requireTrustedJsonMutation(
    request,
    "恢复过期自治租约"
  );
  if (denied) return denied;

  try {
    const result = await recoverExpiredInvocationLeases({
      prisma
    });
    return NextResponse.json({
      ok: true,
      result,
      externalMutationAttempted: false,
      containsForumText: false
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        code: "autonomy_lease_recovery_failed",
        message: "自治租约恢复失败。",
        externalMutationAttempted: false,
        containsForumText: false
      },
      { status: 409 }
    );
  }
}
