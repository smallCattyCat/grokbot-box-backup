import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import type { LiveOpportunityReceipt } from "@/lib/live-runtime/facilitation-kernel";
import {
  buildLiveRevalidation,
  parseLiveRevalidationCapture
} from "@/lib/live-runtime/revalidation";
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
    "重读真实草稿目标"
  );
  if (denied) return denied;
  try {
    const capture = parseLiveRevalidationCapture(
      await request.json()
    );
    const opportunity =
      await loadRuntimeReceipt<LiveOpportunityReceipt>(
        "opportunities",
        capture.opportunityReceiptHash
      );
    const beforeObservation = await loadLiveUiObservation(
      opportunity.receipt.observationReceiptHash
    );
    const afterObservation = await loadLiveUiObservation(
      capture.afterObservationReceiptHash
    );
    const result = buildLiveRevalidation({
      capture,
      opportunity: opportunity.receipt,
      beforeObservation: beforeObservation.receipt,
      afterObservation: afterObservation.receipt,
      trustedNow: new Date().toISOString()
    });
    await persistRuntimeReceipt({
      kind: "revalidations",
      receipt: result.receipt,
      receiptHash: result.receiptHash
    });
    return NextResponse.json({
      ok: true,
      message:
        result.receipt.decision === "DRAFT_STAGING_ALLOWED"
          ? "目标版本与真人回复已重读，允许仅写入编辑器。"
          : result.receipt.decision ===
              "WITHDRAWN_EXTERNAL_HUMAN_RESPONSE"
            ? "已出现新的外部真人回复，草稿已撤回并让位。"
            : "目标或证据发生变化，草稿转长期审核。",
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
            : "真实目标重读失败。"
      },
      { status: 409 }
    );
  }
}
