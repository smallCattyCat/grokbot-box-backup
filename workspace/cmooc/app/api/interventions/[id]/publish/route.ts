import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  REAL_FORUM_WRITE_LOCKED,
  REAL_FORUM_WRITE_LOCK_CODE,
  REAL_FORUM_WRITE_LOCK_MESSAGE
} from "@/lib/forum/real-write-lock";
import { publishQueuedIntervention } from "@/lib/workflow";
import type { PublishMode, RealPublishTargetMode, RealPublishTransport, TargetCommentStrategy } from "@/lib/forum/publish-reply";

function parseTransport(value: unknown): RealPublishTransport | undefined {
  if (value === "browser") return "browser";
  if (value === "api" || value === "auto") return "api";
  return undefined;
}

function parseTargetMode(value: unknown): RealPublishTargetMode | undefined {
  return value === "post_comment" || value === "comment_reply" ? value : undefined;
}

function parseTargetCommentStrategy(value: unknown): TargetCommentStrategy | undefined {
  return value === "first" || value === "last" || value === "by_text" ? value : undefined;
}

function parseTargetCommentIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const denied = requireTrustedJsonMutation(request, "发布");
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
    const body = (await request.json()) as {
      mode?: PublishMode;
      targetMode?: RealPublishTargetMode;
      targetCommentIndex?: number;
      targetCommentStrategy?: TargetCommentStrategy;
      targetCommentText?: string;
      transport?: RealPublishTransport;
    };
    if (body.mode === "mock") {
      return NextResponse.json({ error: "Mock 发布已隔离到开发实验室，主流程只允许发布已授权的真实计划。" }, { status: 400 });
    }
    const task = await publishQueuedIntervention(params.id, request.nextUrl.origin, "real", {
      targetMode: parseTargetMode(body.targetMode),
      targetCommentIndex: parseTargetCommentIndex(body.targetCommentIndex),
      targetCommentStrategy: parseTargetCommentStrategy(body.targetCommentStrategy),
      targetCommentText: typeof body.targetCommentText === "string" ? body.targetCommentText : undefined,
      transport: parseTransport(body.transport)
    });
    return NextResponse.json(task);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "发布没有完成。"
    }, { status: 409 });
  }
}
