import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  buildLiveFacilitationOpportunity,
  parseLiveOpportunityAssessment
} from "@/lib/live-runtime/facilitation-kernel";
import {
  loadLatestLiveOpportunityForObservation,
  persistRuntimeReceipt
} from "@/lib/live-runtime/store";
import { loadLiveUiObservation } from "@/lib/ui-agent/live-observation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const observation = request.nextUrl.searchParams.get("observation");
  if (!observation) {
    return NextResponse.json(
      { ok: false, message: "缺少真实观察回执哈希。" },
      { status: 400 }
    );
  }
  try {
    return NextResponse.json({
      ok: true,
      opportunity:
        await loadLatestLiveOpportunityForObservation(observation)
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "读取真实机会回执失败。"
      },
      { status: 400 }
    );
  }
}

export async function POST(request: NextRequest) {
  const denied = requireTrustedJsonMutation(
    request,
    "运行真实机会资格链"
  );
  if (denied) return denied;
  try {
    const assessment = parseLiveOpportunityAssessment(
      await request.json()
    );
    const observation = await loadLiveUiObservation(
      assessment.observationReceiptHash
    );
    const result = buildLiveFacilitationOpportunity({
      assessment,
      observation: observation.receipt,
      trustedNow: new Date().toISOString()
    });
    await persistRuntimeReceipt({
      kind: "opportunities",
      receipt: result.receipt,
      receiptHash: result.receiptHash
    });
    return NextResponse.json({
      ok: true,
      message:
        result.receipt.decision === "draft"
          ? "真实机会已通过资格链；已生成易失草稿，写入前必须重读目标。"
          : result.receipt.decision === "yield"
            ? "已检测到真人连接或序列完成，系统让位。"
            : result.receipt.decision === "abstain"
              ? "证据资格不足，系统弃答并保留原因。"
              : "当前不满足调度条件，系统选择等待。",
      receiptHash: result.receiptHash,
      receipt: result.receipt,
      transientDraft: result.transientDraft
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "真实机会资格链运行失败。"
      },
      { status: 409 }
    );
  }
}
