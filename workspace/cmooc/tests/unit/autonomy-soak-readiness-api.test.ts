import assert from "node:assert/strict";
import test from "node:test";
import { createAutonomySoakReadinessRouteHandler } from "../../app/api/autonomy/soak-readiness/route-handler";
import {
  AUTONOMY_SOAK_READINESS_SCHEMA_VERSION,
  DEFAULT_AUTONOMY_SOAK_READINESS_PROFILE,
  type AutonomySoakReadinessReceipt,
  type AutonomySoakReadinessStatus
} from "../../lib/autonomy/soak-readiness";

function readiness(
  status: AutonomySoakReadinessStatus = "qualifying"
): AutonomySoakReadinessReceipt {
  return {
    schemaVersion: AUTONOMY_SOAK_READINESS_SCHEMA_VERSION,
    assessedAt: "2026-08-23T12:00:00.000Z",
    status,
    profile: DEFAULT_AUTONOMY_SOAK_READINESS_PROFILE,
    qualificationScope: "local_runtime_evidence_only",
    evidence: {
      scopeRecordCount: 1,
      wakeCount: 2,
      terminalCount: 2,
      completedCount: 2,
      consecutiveCompletedCount: 2,
      runningCount: 0,
      staleRunningCount: 0,
      firstStartedAt: "2026-08-23T11:30:00.000Z",
      lastStartedAt: "2026-08-23T12:00:00.000Z",
      observationSpanMs: 30 * 60_000,
      lastWakeAgeMs: 0,
      maxAdjacentGapMs: 30 * 60_000
    },
    checks: [
      {
        id: "minimum_completed_cycles",
        kind: "qualification",
        status: "pending",
        operator: "gte",
        observed: 2,
        expected: 144
      }
    ],
    externalChecks: {
      failedOnlyDelivery: "unknown",
      successUiSuppression: "unknown"
    },
    matureV1Eligible: false,
    requestedMutationCount: 0,
    sentMutationCount: 0,
    realPublishEnabled: false,
    externalWriteAttempted: false,
    containsForumText: false,
    evidenceHash: "a".repeat(64)
  };
}

test("soak readiness API returns only a no-store safe projection", async () => {
  const source = Object.assign(readiness(), {
    forumBody: "SHOULD_NEVER_APPEAR",
    localPath: "SHOULD_NEVER_APPEAR"
  });
  const handler = createAutonomySoakReadinessRouteHandler({
    loadReadiness: async () => source
  });
  const response = await handler();
  const serialized = JSON.stringify(await response.json());
  const payload = JSON.parse(serialized) as {
    ok: boolean;
    readiness: AutonomySoakReadinessReceipt;
    externalMutationAttempted: boolean;
    containsForumText: boolean;
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(payload.ok, true);
  assert.equal(payload.readiness.status, "qualifying");
  assert.equal(payload.readiness.matureV1Eligible, false);
  assert.equal(payload.externalMutationAttempted, false);
  assert.equal(payload.containsForumText, false);
  assert.doesNotMatch(serialized, /SHOULD_NEVER_APPEAR/u);
  assert.doesNotMatch(serialized, /forumBody|localPath/u);
});

test("blocked is an observed readiness result, not an API transport error", async () => {
  const handler = createAutonomySoakReadinessRouteHandler({
    loadReadiness: async () => readiness("blocked")
  });
  const response = await handler();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).readiness.status, "blocked");
});

test("soak readiness API fails closed without leaking source errors", async () => {
  const fixtures = [
    async () => {
      throw new Error("DATABASE_URL=SECRET_TOKEN C:\\private\\dev.db");
    },
    async () =>
      ({
        ...readiness(),
        realPublishEnabled: true
      }) as unknown as AutonomySoakReadinessReceipt
  ];

  for (const loadReadiness of fixtures) {
    const handler = createAutonomySoakReadinessRouteHandler({ loadReadiness });
    const response = await handler();
    const serialized = JSON.stringify(await response.json());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      JSON.parse(serialized).code,
      "autonomy_soak_readiness_unavailable"
    );
    assert.doesNotMatch(
      serialized,
      /SECRET|DATABASE_URL|private|dev\.db/u
    );
  }
});
