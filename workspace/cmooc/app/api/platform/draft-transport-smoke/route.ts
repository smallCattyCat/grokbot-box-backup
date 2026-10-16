import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  buildDraftTransportSmokeReceipt,
  parseDraftTransportSmokeCapture
} from "@/lib/live-runtime/transport-smoke";
import { persistRuntimeReceipt } from "@/lib/live-runtime/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const denied = requireTrustedJsonMutation(
    request,
    "封存真实编辑器传输验证"
  );
  if (denied) return denied;
  try {
    const capture = parseDraftTransportSmokeCapture(
      await request.json()
    );
    const result = buildDraftTransportSmokeReceipt(capture);
    await persistRuntimeReceipt({
      kind: "transport-smoke",
      receipt: result.receipt,
      receiptHash: result.receiptHash
    });
    return NextResponse.json({
      ok: true,
      message:
        "真实编辑器已读回草稿且未触发提交；因 Chrome 插件不提供网络守卫，此回执不升级为自动运行认证。",
      receiptHash: result.receiptHash,
      receipt: result.receipt
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "草稿传输验证封存失败。"
      },
      { status: 409 }
    );
  }
}
