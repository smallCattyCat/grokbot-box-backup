import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  observeDueProximalOutcomes,
  preflightDueProximalOutcomes,
  scheduleProximalOutcomes
} from "@/lib/autonomy/outcome-observer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const preflight = await preflightDueProximalOutcomes({
      prisma
    });
    return NextResponse.json({
      ok: true,
      preflight: {
        schemaVersion: preflight.schemaVersion,
        asOf: preflight.asOf,
        counts: preflight.counts,
        outcomes: preflight.outcomes.map(
          ({
            outcomeId,
            courseAlias,
            observationWindow,
            status,
            evidenceSource
          }) => ({
            outcomeId,
            courseAlias,
            observationWindow,
            status,
            evidenceSource,
            containsForumText: false as const
          })
        ),
        containsForumText: false
      },
      externalMutationAttempted: false,
      educationalEffectClaimed: false,
      containsForumText: false
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        code: "proximal_outcome_preflight_failed",
        message: "近端结果预检失败。",
        externalMutationAttempted: false,
        educationalEffectClaimed: false,
        containsForumText: false
      },
      { status: 409 }
    );
  }
}

export async function POST(request: NextRequest) {
  const denied = requireTrustedJsonMutation(
    request,
    "核对自治近端结果"
  );
  if (denied) return denied;

  try {
    const now = new Date();
    const scheduled = await scheduleProximalOutcomes({
      prisma
    });
    const preflight = await preflightDueProximalOutcomes({
      prisma,
      now
    });
    const readyOutcomeIds = preflight.outcomes
      .filter((outcome) => outcome.status === "ready")
      .map((outcome) => outcome.outcomeId);
    const observed =
      readyOutcomeIds.length > 0
        ? await observeDueProximalOutcomes({
            prisma,
            now,
            outcomeIds: readyOutcomeIds,
            readyOnly: true,
            limit: readyOutcomeIds.length
          })
        : {
            schemaVersion: preflight.schemaVersion,
            asOf: preflight.asOf,
            dueCount: 0,
            observedCount: 0,
            censoredCount: 0,
            waitingForCoverageCount: 0,
            containsForumText: false as const
          };
    return NextResponse.json({
      ok: true,
      scheduled,
      observed,
      preflight: {
        schemaVersion: preflight.schemaVersion,
        asOf: preflight.asOf,
        counts: preflight.counts,
        outcomes: preflight.outcomes.map(
          ({
            outcomeId,
            courseAlias,
            observationWindow,
            status,
            evidenceSource
          }) => ({
            outcomeId,
            courseAlias,
            observationWindow,
            status,
            evidenceSource,
            containsForumText: false as const
          })
        ),
        containsForumText: false
      },
      observationSource: "local_hmac_event_ledger_only",
      externalMutationAttempted: false,
      educationalEffectClaimed: false,
      containsForumText: false
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        code: "proximal_outcome_reconciliation_failed",
        message: "近端结果核对失败。",
        externalMutationAttempted: false,
        educationalEffectClaimed: false,
        containsForumText: false
      },
      { status: 409 }
    );
  }
}
