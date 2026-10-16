import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import { inspectCmoocUiReadiness } from "@/lib/platform-readiness/cmooc-ui-readiness";
import {
  LIVE_UI_CAPTURE_SCHEMA_VERSION,
  liveUiSurfaceLocatorHash,
  parseLiveUiCapture,
  sealAndPersistLiveUiCapture
} from "@/lib/ui-agent/live-observation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const guard = requireTrustedJsonMutation(
    request,
    "真实平台只读预检"
  );
  if (guard) return guard;

  try {
    const body = (await request.json()) as {
      targetInput?: unknown;
    };
    if (
      typeof body.targetInput !== "string" ||
      body.targetInput.trim() === ""
    ) {
      return NextResponse.json(
        {
          ok: false,
          message: "请提供 cMOOC 课程地址。"
        },
        { status: 400 }
      );
    }
    const result = await inspectCmoocUiReadiness({
      targetInput: body.targetInput
    });
    const driverSessionRef = `lift1:${result.evidenceHash}`;
    const capture = parseLiveUiCapture({
      schemaVersion: LIVE_UI_CAPTURE_SCHEMA_VERSION,
      baselineEvidenceHash: result.evidenceHash,
      targetInput: result.canonicalUrl,
      driverKind: "deterministic_browser",
      driverSessionRef,
      observedAt: result.receipt.observedAt,
      finalUrl: result.canonicalUrl,
      courseShellDetected:
        result.receipt.courseShellDetected,
      categoryTabCount: result.receipt.categoryTabCount,
      visibleCardCount: result.receipt.visibleCardCount,
      detailObservation:
        result.receipt.detailObservation === "detail_observed"
          ? "interaction_no_transition"
          : result.receipt.detailObservation,
      detail: null,
      actions: [
        {
          sequence: 1,
          action: "navigate",
          outcome: "verified",
          postcondition: "target_url_verified",
          postconditionVerified: true
        },
        {
          sequence: 2,
          action: "observe_course",
          outcome: result.receipt.courseShellDetected
            ? "verified"
            : "blocked",
          postcondition: "course_shell_present",
          postconditionVerified:
            result.receipt.courseShellDetected
        }
      ],
      networkGuardAttached:
        result.receipt.networkGuardActive,
      requestedMutationCount:
        result.receipt.requestedMutationCount,
      blockedMutationCount:
        result.receipt.blockedWriteRequestCount,
      sentMutationCount: result.receipt.sentMutationCount,
      externalWriteAttempted: false,
      containsForumText: false
    });
    const deterministicObservation =
      await sealAndPersistLiveUiCapture({
        baseline: {
          evidenceHash: result.evidenceHash,
          receipt: result.receipt
        },
        capture,
        trustedGuardAttestation: {
          guardReceiptHash: result.evidenceHash,
          driverSessionRef,
          surfaceLocatorHash: liveUiSurfaceLocatorHash(
            result.canonicalUrl
          ),
          attachedAt: result.receipt.observedAt,
          observedAt: result.receipt.observedAt,
          expiresAt: new Date(
            Date.parse(result.receipt.observedAt) + 5 * 60_000
          ).toISOString(),
          sentMutationCount: 0
        }
      });
    return NextResponse.json({
      ok: true,
      message:
        result.receipt.status === "overview_ready"
          ? "真实课程概要巡检已就绪；全程受只读端点白名单约束。"
          : result.receipt.status === "shell_only"
            ? "已定位真实课程壳，但当前会话尚未读取到可巡检卡片。"
            : "真实课程界面未通过演示预检。",
      canonicalUrl: result.canonicalUrl,
      evidenceHash: result.evidenceHash,
      receipt: result.receipt,
      liveObservationReceiptHash:
        deterministicObservation.receiptHash,
      liveObservationStatus:
        deterministicObservation.receipt.captureStatus
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "真实平台预检失败。"
      },
      { status: 400 }
    );
  }
}
