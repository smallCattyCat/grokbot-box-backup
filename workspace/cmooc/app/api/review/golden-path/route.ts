import { NextRequest, NextResponse } from "next/server";
import {
  buildP4D1ReviewCase,
  createP4D1LocalReviewReceipt,
  defaultP4D1OutputRoot,
  persistP4D1LocalReviewReceipt,
  type P4D1ReviewDecision
} from "@/lib/golden-path/p4d1";
import {
  createP4ReviewPreflightReceipt,
  persistP4ReviewPreflightReceipt,
  resolveP4ReviewDecision
} from "@/lib/golden-path/review-preflight";
import {
  runP4FLiteReviewPreflight,
  type P4FLiteScenarioId
} from "@/lib/golden-path/p4f-lite";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";

const PREFLIGHT_SCENARIOS = [
  "stable_target",
  "target_version_changed",
  "post_as_of_human_response"
] as const satisfies readonly P4FLiteScenarioId[];

export async function POST(request: NextRequest) {
  try {
    const denied = requireTrustedJsonMutation(request, "保存本地审阅决定");
    if (denied) return denied;
    const body = await request.json() as {
      fixtureId?: unknown;
      decision?: unknown;
      draftText?: unknown;
      reviewBundleHash?: unknown;
      targetHash?: unknown;
      reviewStartedAt?: unknown;
      preflightScenario?: unknown;
    };
    const reviewCase = buildP4D1ReviewCase();
    if (body.fixtureId !== reviewCase.fixtureId) {
      return NextResponse.json(
        { error: "审阅对象与当前固定候选不一致，请刷新页面。" },
        { status: 409 }
      );
    }
    if (
      body.reviewBundleHash !== reviewCase.reviewBundleHash ||
      body.targetHash !== reviewCase.targetHash
    ) {
      return NextResponse.json(
        { error: "审阅版本或目标版本已失效，请刷新后重新审阅。" },
        { status: 409 }
      );
    }
    if (
      typeof body.decision !== "string" ||
      !["accept", "modify", "reject"].includes(body.decision)
    ) {
      return NextResponse.json(
        { error: "请选择接受、修改或拒绝。" },
        { status: 400 }
      );
    }
    const preflightScenario =
      typeof body.preflightScenario === "string" &&
      PREFLIGHT_SCENARIOS.includes(
        body.preflightScenario as P4FLiteScenarioId
      )
        ? (body.preflightScenario as P4FLiteScenarioId)
        : null;
    if (!preflightScenario) {
      return NextResponse.json(
        { error: "请选择一个固定合成重读情境。" },
        { status: 400 }
      );
    }
    const requestedDecision = body.decision as P4D1ReviewDecision;
    const preflight = await runP4FLiteReviewPreflight({
      scenarioId: preflightScenario
    });
    const { finalDecision, disposition } = resolveP4ReviewDecision({
      requestedDecision,
      preflight
    });
    const reviewedAt = new Date().toISOString();
    const result = createP4D1LocalReviewReceipt({
      reviewCase,
      decision: finalDecision,
      draftText: typeof body.draftText === "string" ? body.draftText : "",
      reviewedAt
    });
    await persistP4D1LocalReviewReceipt(result);
    const preflightReceipt = createP4ReviewPreflightReceipt({
      fixtureId: reviewCase.fixtureId,
      requestedDecision,
      finalDecision,
      disposition,
      reviewStartedAt:
        typeof body.reviewStartedAt === "string"
          ? body.reviewStartedAt
          : undefined,
      reviewedAt,
      preflight,
      localReviewReceiptHash: result.receiptHash
    });
    await persistP4ReviewPreflightReceipt({
      ...preflightReceipt,
      outputRoot: defaultP4D1OutputRoot()
    });
    const message =
      disposition === "withdrawn_external_human_response"
        ? "提交前重读发现真人连接，系统已让位并撤回原动作。"
        : disposition === "needs_re_review_target_changed"
          ? "提交前重读发现目标版本变化，旧草稿已撤回并转为重新审阅。"
          : disposition === "human_rejected"
            ? "已记录人工放弃；未尝试发布或访问真实论坛。"
            : "提交前重读通过，shadow 决定已记录；未尝试真实发布。";
    return NextResponse.json({
      schemaVersion: "cmooc.p4-review-result.v1",
      requestedDecision,
      decision: finalDecision,
      disposition,
      receiptHash: result.receiptHash,
      preflightReceiptHash: preflightReceipt.receiptHash,
      reviewedAt: result.receipt.reviewedAt,
      wasEdited: result.receipt.wasEdited,
      reviewDurationMs: preflightReceipt.receipt.reviewDurationMs,
      preflightScenario,
      preflightStatus: preflight.preflightStatus,
      withdrawalCondition: preflight.withdrawalCondition,
      eventCountBefore: preflight.eventCountBefore,
      eventCountAfter: preflight.eventCountAfter,
      externalWriteAttempted: false,
      containsForumText: false,
      message
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "本地审阅决定未能保存。"
      },
      { status: 409 }
    );
  }
}
