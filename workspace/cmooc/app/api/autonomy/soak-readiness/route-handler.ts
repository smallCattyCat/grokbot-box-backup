import { NextResponse } from "next/server";
import {
  AUTONOMY_SOAK_READINESS_SCHEMA_VERSION,
  type AutonomySoakReadinessReceipt
} from "@/lib/autonomy/soak-readiness";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store"
} as const;

type SoakReadinessRouteDependencies = {
  loadReadiness: () => Promise<AutonomySoakReadinessReceipt>;
};

function safeReadinessProjection(
  receipt: AutonomySoakReadinessReceipt
): AutonomySoakReadinessReceipt | null {
  if (
    receipt.schemaVersion !== AUTONOMY_SOAK_READINESS_SCHEMA_VERSION ||
    !["unknown", "qualifying", "blocked", "qualified"].includes(
      receipt.status
    ) ||
    receipt.qualificationScope !== "local_runtime_evidence_only" ||
    receipt.matureV1Eligible !== false ||
    receipt.requestedMutationCount !== 0 ||
    receipt.sentMutationCount !== 0 ||
    receipt.realPublishEnabled !== false ||
    receipt.externalWriteAttempted !== false ||
    receipt.containsForumText !== false ||
    !/^[a-f0-9]{64}$/u.test(receipt.evidenceHash)
  ) {
    return null;
  }

  return {
    schemaVersion: receipt.schemaVersion,
    assessedAt: receipt.assessedAt,
    status: receipt.status,
    profile: {
      source: receipt.profile.source,
      runtimeVersion: receipt.profile.runtimeVersion,
      minimumSpanMs: receipt.profile.minimumSpanMs,
      cadenceMs: receipt.profile.cadenceMs,
      minimumCompletedCycles: receipt.profile.minimumCompletedCycles,
      maxWakeAgeMs: receipt.profile.maxWakeAgeMs,
      maxAdjacentGapMs: receipt.profile.maxAdjacentGapMs
    },
    qualificationScope: receipt.qualificationScope,
    evidence: {
      scopeRecordCount: receipt.evidence.scopeRecordCount,
      wakeCount: receipt.evidence.wakeCount,
      terminalCount: receipt.evidence.terminalCount,
      completedCount: receipt.evidence.completedCount,
      consecutiveCompletedCount: receipt.evidence.consecutiveCompletedCount,
      runningCount: receipt.evidence.runningCount,
      staleRunningCount: receipt.evidence.staleRunningCount,
      firstStartedAt: receipt.evidence.firstStartedAt,
      lastStartedAt: receipt.evidence.lastStartedAt,
      observationSpanMs: receipt.evidence.observationSpanMs,
      lastWakeAgeMs: receipt.evidence.lastWakeAgeMs,
      maxAdjacentGapMs: receipt.evidence.maxAdjacentGapMs
    },
    checks: receipt.checks.map((check) => ({
      id: check.id,
      kind: check.kind,
      status: check.status,
      operator: check.operator,
      observed: check.observed,
      expected: check.expected
    })),
    externalChecks: {
      failedOnlyDelivery: receipt.externalChecks.failedOnlyDelivery,
      successUiSuppression: receipt.externalChecks.successUiSuppression
    },
    matureV1Eligible: false,
    requestedMutationCount: 0,
    sentMutationCount: 0,
    realPublishEnabled: false,
    externalWriteAttempted: false,
    containsForumText: false,
    evidenceHash: receipt.evidenceHash
  };
}

export function createAutonomySoakReadinessRouteHandler(
  dependencies: SoakReadinessRouteDependencies
) {
  return async function getAutonomySoakReadiness(): Promise<NextResponse> {
    try {
      const readiness = safeReadinessProjection(
        await dependencies.loadReadiness()
      );
      if (!readiness) throw new Error("invalid_readiness_receipt");
      return NextResponse.json(
        {
          ok: true,
          readiness,
          externalMutationAttempted: false,
          containsForumText: false
        },
        { headers: NO_STORE_HEADERS }
      );
    } catch {
      return NextResponse.json(
        {
          ok: false,
          code: "autonomy_soak_readiness_unavailable",
          message: "自治耐久运行资格暂不可用。",
          externalMutationAttempted: false,
          containsForumText: false
        },
        { status: 503, headers: NO_STORE_HEADERS }
      );
    }
  };
}
