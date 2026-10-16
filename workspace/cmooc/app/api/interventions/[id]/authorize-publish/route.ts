import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  REAL_FORUM_WRITE_LOCKED,
  REAL_FORUM_WRITE_LOCK_CODE,
  REAL_FORUM_WRITE_LOCK_MESSAGE
} from "@/lib/forum/real-write-lock";
import { authorizeInterventionPublish } from "@/lib/interventions/publish-policy";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const denied = requireTrustedJsonMutation(request, "发布授权");
    if (denied) return denied;
    if (REAL_FORUM_WRITE_LOCKED) {
      return NextResponse.json(
        {
          error: REAL_FORUM_WRITE_LOCK_MESSAGE,
          code: REAL_FORUM_WRITE_LOCK_CODE
        },
        { status: 423 }
      );
    }
    const origin = request.headers.get("origin")!;
    const body = (await request.json()) as {
      expectedContentHash?: string;
      expectedTargetHash?: string;
      expiresInMinutes?: number;
      confirmed?: boolean;
      confirmationText?: string;
    };
    if (!/^[a-f0-9]{64}$/.test(body.expectedContentHash ?? "")) {
      return NextResponse.json({ error: "页面正文版本缺失或无效，请刷新后重新审阅。" }, { status: 400 });
    }
    if (!/^[a-f0-9]{64}$/.test(body.expectedTargetHash ?? "")) {
      return NextResponse.json({ error: "页面目标版本缺失或无效，请刷新后重新审阅。" }, { status: 400 });
    }
    if (
      body.confirmed !== true ||
      body.confirmationText !== "我已核对当前目标与当前回复正文"
    ) {
      return NextResponse.json({ error: "必须明确确认已经核对当前目标与正文。" }, { status: 400 });
    }
    const expiresInMinutes = Number(body.expiresInMinutes ?? 30);
    const result = await authorizeInterventionPublish({
      taskId: params.id,
      expectedContentHash: body.expectedContentHash!,
      expectedTargetHash: body.expectedTargetHash!,
      expiresInMinutes: Number.isFinite(expiresInMinutes)
        ? Math.max(5, Math.min(24 * 60, Math.floor(expiresInMinutes)))
        : 30,
      metadata: {
        route: `/api/interventions/${params.id}/authorize-publish`,
        reviewer: "local_human_reviewer",
        confirmationText: body.confirmationText,
        origin
      }
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "创建发布授权失败。"
    }, { status: 409 });
  }
}
