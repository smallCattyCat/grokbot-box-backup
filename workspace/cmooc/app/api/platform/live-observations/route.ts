import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import { loadCmoocUiReadinessEvidence } from "@/lib/platform-readiness/cmooc-ui-readiness";
import {
  loadLatestLiveUiObservationForBaseline,
  parseLiveUiCapture,
  sealAndPersistLiveUiCapture
} from "@/lib/ui-agent/live-observation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const baseline = request.nextUrl.searchParams.get("baseline");
  if (!baseline) {
    return NextResponse.json(
      { ok: false, message: "缺少基线证据哈希。" },
      { status: 400 }
    );
  }
  try {
    const result =
      await loadLatestLiveUiObservationForBaseline(baseline);
    return NextResponse.json({
      ok: true,
      observation: result
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "读取真实界面观察回执失败。"
      },
      { status: 400 }
    );
  }
}

export async function POST(request: NextRequest) {
  const denied = requireTrustedJsonMutation(
    request,
    "封存真实界面观察"
  );
  if (denied) return denied;

  try {
    const capture = parseLiveUiCapture(await request.json());
    const baseline = await loadCmoocUiReadinessEvidence(
      capture.baselineEvidenceHash
    );
    const sealed = await sealAndPersistLiveUiCapture({
      capture,
      baseline
    });
    return NextResponse.json({
      ok: true,
      message:
        sealed.receipt.captureStatus === "semantic_ready"
          ? "真实详情证据已封存，可以进入语义 shadow 决策。"
          : sealed.receipt.captureStatus === "source_censored"
            ? "真实观察已封存；动作结果不完整，系统已停止重放并转为长期审核。"
            : sealed.receipt.captureStatus === "structural_observed"
              ? "真实结构观察已封存；详情不足，系统选择等待。"
              : "真实观察被页面能力边界阻断。",
      receiptHash: sealed.receiptHash,
      receipt: sealed.receipt
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "真实界面观察未能封存。"
      },
      { status: 409 }
    );
  }
}
