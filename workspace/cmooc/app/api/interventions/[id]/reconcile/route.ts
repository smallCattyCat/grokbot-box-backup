import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import { reconcilePublishOutcome } from "@/lib/interventions/publish-service";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const denied = requireTrustedJsonMutation(request, "人工核对");
    if (denied) return denied;
    const body = (await request.json()) as {
      resolution?: "published" | "not_published";
      evidenceNote?: string;
      publishedUrl?: string;
      confirmed?: boolean;
    };
    if (body.resolution !== "published" && body.resolution !== "not_published") {
      return NextResponse.json({ error: "核对结果必须是已发布或未发布。" }, { status: 400 });
    }
    const task = await reconcilePublishOutcome({
      taskId: params.id,
      resolution: body.resolution,
      evidenceNote: body.evidenceNote ?? "",
      publishedUrl: body.publishedUrl,
      confirmed: body.confirmed === true
    });
    return NextResponse.json(task);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "人工核对未完成。"
    }, { status: 409 });
  }
}
