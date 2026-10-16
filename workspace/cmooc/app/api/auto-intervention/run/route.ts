import { NextRequest, NextResponse } from "next/server";
import { runAutoIntervention } from "@/lib/auto-intervention/run-auto-intervention";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";

export async function POST(request: NextRequest) {
  try {
    const denied = requireTrustedJsonMutation(request, "生成干预预览");
    if (denied) return denied;
    const body = (await request.json().catch(() => ({}))) as {
      forumListUrl?: string;
      maxScanPosts?: number;
      minScoreToPublish?: number;
    };
    const maxScanPosts = Number(body.maxScanPosts ?? 10);
    const minScoreToPublish = Number(body.minScoreToPublish ?? 75);
    const forumListUrl = body.forumListUrl?.trim();
    if (!forumListUrl) {
      return NextResponse.json(
        {
          isError: true,
          error: "PREVIEW_FORUM_LIST_URL_REQUIRED",
          safeDefault: { previewOnly: true }
        },
        { status: 400 }
      );
    }
    if (![maxScanPosts, minScoreToPublish].every(Number.isFinite)) {
      return NextResponse.json({
        isError: true,
        error: "自动干预参数必须是有效数字。",
        safeDefault: { previewOnly: true }
      }, { status: 400 });
    }
    const result = await runAutoIntervention({
      forumListUrl,
      maxScanPosts: Math.max(1, Math.min(30, maxScanPosts)),
      maxPublishCount: 1,
      minScoreToPublish: Math.max(0, Math.min(100, minScoreToPublish)),
      mode: "dry_run",
      allowRealPublish: false
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ isError: true, error: error instanceof Error ? error.message : "未知自动干预错误", safeDefault: { previewOnly: true } }, { status: 500 });
  }
}
