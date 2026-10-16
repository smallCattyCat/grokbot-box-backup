import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  buildDraftStagingReceipt,
  parseDraftStagingCapture
} from "@/lib/live-runtime/draft-staging";
import type { LiveOpportunityReceipt } from "@/lib/live-runtime/facilitation-kernel";
import type { LiveRevalidationReceipt } from "@/lib/live-runtime/revalidation";
import {
  loadRuntimeReceipt,
  persistRuntimeReceipt
} from "@/lib/live-runtime/store";
import { loadLiveUiObservation } from "@/lib/ui-agent/live-observation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const denied = requireTrustedJsonMutation(
    request,
    "封存未发布草稿写入回执"
  );
  if (denied) return denied;
  try {
    const capture = parseDraftStagingCapture(
      await request.json()
    );
    const opportunity =
      await loadRuntimeReceipt<LiveOpportunityReceipt>(
        "opportunities",
        capture.opportunityReceiptHash
      );
    const revalidation =
      await loadRuntimeReceipt<LiveRevalidationReceipt>(
        "revalidations",
        capture.revalidationReceiptHash
      );
    const afterObservation = await loadLiveUiObservation(
      capture.afterObservationReceiptHash
    );
    const result = buildDraftStagingReceipt({
      capture,
      opportunity: opportunity.receipt,
      revalidation: revalidation.receipt,
      afterObservation: afterObservation.receipt,
      trustedNow: new Date().toISOString()
    });
    await persistRuntimeReceipt({
      kind: "draft-staging",
      receipt: result.receipt,
      receiptHash: result.receiptHash
    });
    return NextResponse.json({
      ok: true,
      message:
        result.receipt.state === "DRAFT_STAGED_NOT_PUBLISHED"
          ? "草稿已在真实编辑器中核对，未触发提交或发布。"
          : result.receipt.state === "DRAFT_WRITE_FAILED"
            ? "编辑器写入未通过回读核对，未重放、未发布。"
            : "编辑器写入结果未知，未重放、未发布。",
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
            : "未发布草稿回执封存失败。"
      },
      { status: 409 }
    );
  }
}
