import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  getAutonomyRuntimeHealth,
  listDueAutonomyInvocations
} from "@/lib/autonomy/runtime-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const now = new Date();
    const [health, due] = await Promise.all([
      getAutonomyRuntimeHealth({ prisma, now }),
      listDueAutonomyInvocations({ prisma, now })
    ]);
    return NextResponse.json(
      {
        ok: true,
        health,
        workerWake: health.workerWake,
        due,
        externalMutationAttempted: false,
        containsForumText: false
      },
      {
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  } catch {
    return NextResponse.json(
      {
        ok: false,
        code: "autonomy_status_unavailable",
        message: "自治运行状态暂不可用。",
        externalMutationAttempted: false,
        containsForumText: false
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  }
}
