import assert from "node:assert/strict";
import test from "node:test";
import {
  SCENARIO_LAB_SCHEMA_VERSIONS,
  type CourseWorldFrozenEvidenceV1,
  type DailyBudgetK,
  type OfflineSchedulerReplayResultV1,
  protocolHash
} from "../../lib/scenario-lab/contracts";
import { buildDeterministicP3aScenarioReport } from "../../lib/scenario-lab/deterministic-runtime";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function evidence(
  overrides: Partial<CourseWorldFrozenEvidenceV1["upstream"]> = {}
): CourseWorldFrozenEvidenceV1 {
  const body = {
    schemaVersion: SCENARIO_LAB_SCHEMA_VERSIONS.evidence,
    datasetRef: "p3a-2025-holdout-v1" as const,
    evidenceClass: "observed_frozen_aggregate" as const,
    cohortYear: 2025 as const,
    split: "time_holdout" as const,
    clock: {
      kind: "p3a_historical" as const,
      decisionLagHours: 22 as const,
      outcomeEndHours: 86 as const,
      outcomeWindowHours: 64 as const,
      schedulerTickMinutes: 30 as const,
      candidateTtlMinutes: 30 as const
    },
    counts: {
      snapshotCount: 2_702,
      ineligibleOrAnsweredAtDecisionCount: 2_085,
      eligibleUnansweredCount: 617,
      organicExternalResponseInWindowCount: 217,
      supportGapAtHorizonCount: 400
    },
    decisionCalendarYearCounts: [
      { year: 2025, count: 2_604 },
      { year: 2026, count: 98 }
    ],
    upstream: {
      snapshotSchemaVersion: "cmooc-decision-snapshot-v1" as const,
      benchmarkSchemaVersion: "cmooc-scheduler-benchmark-v2" as const,
      temporalContractHash: HASH_A,
      evidenceRefSetHash: HASH_A,
      benchmarkInputHash: HASH_A,
      metricsResultHash: HASH_A,
      actionLogHash: HASH_A,
      artifactFileHashes: {
        decisionSnapshotsCsvSha256: HASH_A,
        metricsJsonSha256: HASH_A,
        actionsCsvSha256: HASH_A
      },
      ...overrides
    },
    privacy: {
      containsForumText: false as const,
      containsIdentity: false as const,
      containsRawPlatformIds: false as const,
      containsRowLevelKeys: false as const
    },
    networkUsed: false as const,
    writesPerformed: false as const,
    interventionEligible: false as const
  };
  return {
    ...body,
    evidenceHash: protocolHash(body.schemaVersion, body)
  };
}

function replayResult(
  dailyBudgetK: DailyBudgetK
): OfflineSchedulerReplayResultV1 {
  const fixture = {
    1: {
      selectedCount: 71,
      gapCoverageBps: 1_025,
      gapShareAmongSelectedBps: 5_775,
      naturalResponseOverlapBps: 4_225,
      uniqueAuthorCoverageBps: 3_086,
      repeatTouch7dBps: 1_549,
      authorExposureGiniBps: 7_683,
      withdrawnBeforeSelectionCount: 11,
      expiredUnselectedCount: 535
    },
    3: {
      selectedCount: 167,
      gapCoverageBps: 2_475,
      gapShareAmongSelectedBps: 5_928,
      naturalResponseOverlapBps: 4_072,
      uniqueAuthorCoverageBps: 5_988,
      repeatTouch7dBps: 2_814,
      authorExposureGiniBps: 6_026,
      withdrawnBeforeSelectionCount: 10,
      expiredUnselectedCount: 440
    },
    5: {
      selectedCount: 238,
      gapCoverageBps: 3_500,
      gapShareAmongSelectedBps: 5_882,
      naturalResponseOverlapBps: 4_118,
      uniqueAuthorCoverageBps: 7_469,
      repeatTouch7dBps: 3_739,
      authorExposureGiniBps: 5_381,
      withdrawnBeforeSelectionCount: 8,
      expiredUnselectedCount: 371
    }
  }[dailyBudgetK];
  const body = {
    schemaVersion: SCENARIO_LAB_SCHEMA_VERSIONS.scenarioResult,
    scenarioId: `constrained-structural-k${dailyBudgetK}`,
    evidenceClass: "offline_scheduler_replay" as const,
    policy: "constrained_structural" as const,
    dailyBudgetK,
    candidateCount: 617,
    supportGapCount: 400,
    ...fixture,
    maturedOutcomeCount: 595,
    tickCount: 13_296,
    actionHash: dailyBudgetK === 1 ? HASH_A : HASH_B,
    policyDefinitionHash: HASH_A,
    policyInputHash: HASH_A,
    replayStateEventHash: HASH_A,
    externalWriteCount: 0 as const,
    interventionEligible: false as const
  };
  return {
    ...body,
    resultHash: protocolHash(body.schemaVersion, body)
  };
}

function replaySet(): OfflineSchedulerReplayResultV1[] {
  return [replayResult(1), replayResult(3), replayResult(5)];
}

test("Scenario Lab 对相同证据和情景集合生成逐字确定的哈希报告", () => {
  const source = evidence();
  const forward = buildDeterministicP3aScenarioReport(source, replaySet());
  const reversed = buildDeterministicP3aScenarioReport(
    source,
    replaySet().reverse()
  );

  assert.deepEqual(reversed, forward);
  assert.equal(forward.scenarioResults.map((item) => item.dailyBudgetK).join(","), "1,3,5");
  assert.equal(forward.spec.referenceScenarioId, "constrained-structural-k3");
  assert.equal(forward.receipt.externalWriteCount, 0);
  assert.equal(forward.receipt.decisionUse, "research_only");
  assert.equal(forward.envelope.decisionAuthority, "none");
  assert.equal(forward.envelope.validityClass, "offline_replay_only");
  assert.equal(forward.runtimeCapabilities[0]?.availability, "active");
  assert.deepEqual(
    forward.runtimeCapabilities.slice(1).map((item) => item.runtimeId),
    ["oasis_sidecar_v1", "agentsociety2_sidecar_v1"]
  );
});

test("证据哈希漂移会传递到 spec、receipt 与 report", () => {
  const first = buildDeterministicP3aScenarioReport(evidence(), replaySet());
  const second = buildDeterministicP3aScenarioReport(
    evidence({ actionLogHash: HASH_B }),
    replaySet()
  );

  assert.notEqual(first.evidence.evidenceHash, second.evidence.evidenceHash);
  assert.notEqual(first.spec.specHash, second.spec.specHash);
  assert.notEqual(first.receipt.receiptHash, second.receipt.receiptHash);
  assert.notEqual(first.reportHash, second.reportHash);
});

test("回放输出保持观察、回放与执行权限三层分离", () => {
  const report = buildDeterministicP3aScenarioReport(evidence(), replaySet());
  const serialized = JSON.stringify(report);
  for (const forbidden of [
    "snapshotKey",
    "threadKey",
    "courseKey",
    "authorKey",
    "candidateSet",
    "permit",
    "committer",
    "publish",
    "R24",
    "R72"
  ]) {
    assert.equal(serialized.includes(`\"${forbidden}\"`), false);
  }
  assert.equal(report.evidence.evidenceClass, "observed_frozen_aggregate");
  assert.ok(
    report.scenarioResults.every(
      (item) => item.evidenceClass === "offline_scheduler_replay"
    )
  );
  assert.ok(
    report.scenarioResults.every(
      (item) => item.externalWriteCount === 0 && !item.interventionEligible
    )
  );
});

test("非法基点、结果哈希和时钟漂移会被拒绝", () => {
  const invalidBpsBody = {
    ...replayResult(1),
    gapCoverageBps: 10_001
  };
  const { resultHash: ignored, ...body } = invalidBpsBody;
  void ignored;
  const invalidBps = {
    ...body,
    resultHash: protocolHash(body.schemaVersion, body)
  } as OfflineSchedulerReplayResultV1;
  assert.throws(
    () =>
      buildDeterministicP3aScenarioReport(evidence(), [
        invalidBps,
        replayResult(3),
        replayResult(5)
      ]),
    /INVALID_BASIS_POINTS/u
  );

  const tampered = replayResult(1);
  tampered.selectedCount += 1;
  assert.throws(
    () =>
      buildDeterministicP3aScenarioReport(evidence(), [
        tampered,
        replayResult(3),
        replayResult(5)
      ]),
    /SCENARIO_RESULT_HASH_MISMATCH/u
  );
});

