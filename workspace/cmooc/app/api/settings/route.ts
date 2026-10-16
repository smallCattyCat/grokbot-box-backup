import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  REAL_FORUM_WRITE_LOCKED,
  REAL_FORUM_WRITE_LOCK_CODE,
  REAL_FORUM_WRITE_LOCK_MESSAGE
} from "@/lib/forum/real-write-lock";
import { getForumSettings, updateForumSettings, type ForumSettingsInput } from "@/lib/settings";

export async function GET() {
  const settings = await getForumSettings();
  return NextResponse.json(settings);
}

export async function POST(request: NextRequest) {
  try {
    const denied = requireTrustedJsonMutation(request, "设置");
    if (denied) return denied;
    const body = (await request.json()) as ForumSettingsInput;
    if (body.realPublishEnabled === true && REAL_FORUM_WRITE_LOCKED) {
      return NextResponse.json(
        {
          error: REAL_FORUM_WRITE_LOCK_MESSAGE,
          code: REAL_FORUM_WRITE_LOCK_CODE
        },
        { status: 423 }
      );
    }
    const settings = await updateForumSettings({
      forumBaseUrl: body.forumBaseUrl?.trim() ?? "",
      loginUrl: body.loginUrl?.trim() ?? "",
      postUrlPattern: body.postUrlPattern?.trim() ?? "",
      replyEditorSelector: body.replyEditorSelector?.trim() ?? "",
      replySubmitSelector: body.replySubmitSelector?.trim() ?? "",
      replySuccessSelector: body.replySuccessSelector?.trim() ?? "",
      realPublishEnabled: body.realPublishEnabled === true
    });
    return NextResponse.json(settings);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "设置没有保存。"
    }, { status: 400 });
  }
}
