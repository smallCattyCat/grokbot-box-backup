import {
  DETERMINISTIC_P3A_RUNTIME_ID,
  DETERMINISTIC_P3A_RUNTIME_VERSION,
  SCENARIO_LAB_SCHEMA_VERSIONS,
  SCENARIO_LAB_SCENARIO_SET_REF,
  type CourseWorldForecastEnvelopeV1,
  type CourseWorldFrozenEvidenceV1,
  type CourseWorldRunReceiptV1,
  type CourseWorldScenarioLabReportV1,
  type CourseWorldScenarioSpecV1,
  type OfflineSchedulerReplayResultV1,
  type ScenarioRuntimeAdapterV1,
  type ScenarioRuntimeCapabilityV1,
  assertBasisPoints,
  assertSha256,
  protocolHash,
  resultSetHash
} from "./contracts";

export const SCENARIO_RUNTIME_CAPABILITIES: ScenarioRuntimeCapabilityV1[] = [
  {
    runtimeId: DETERMINISTIC_P3A_RUNTIME_ID,
    label: "P3A 确定性回放",
    availability: "active",
    role: "historical_replay",
    contractVersion: "v1"
  },
  {
    runtimeId: "oasis_sidecar_v1",
    label: "OASIS 社交互动运行时",
    availability: "adapter_contract_ready",
    role: "social_interaction_simulation",
    contractVersion: "v1"
  },
  {
    runtimeId: "agentsociety2_sidecar_v1",
    label: "AgentSociety 2 实验编排",
    availability: "adapter_contract_ready",
    role: "distributed_experiment_orchestration",
    contractVersion: "v1"
  }
];

function verifyEvidence(evidence: CourseWorldFrozenEvidenceV1): void {
  assertSha256(evidence.evidenceHash, "evidenceHash");
  const { evidenceHash, ...body } = evidence;
  if (protocolHash(evidence.schemaVersion, body) !== evidenceHash) {
    throw new Error("SCENARIO_EVIDENCE_HASH_MISMATCH");
  }
  const counts = evidence.counts;
  if (
    counts.ineligibleOrAnsweredAtDecisionCount +
      counts.eligibleUnansweredCount !==
    counts.snapshotCount
  ) {
    throw new Error("SCENARIO_EVIDENCE_DECISION_PARTITION_MISMATCH");
  }
  if (
    counts.organicExternalResponseInWindowCount +
      counts.supportGapAtHorizonCount !==
    counts.eligibleUnansweredCount
  ) {
    throw new Error("SCENARIO_EVIDENCE_OUTCOME_PARTITION_MISMATCH");
  }
  if (
    evidence.clock.decisionLagHours +
      evidence.clock.outcomeWindowHours !==
    evidence.clock.outcomeEndHours
  ) {
    throw new Error("SCENARIO_EVIDENCE_CLOCK_MISMATCH");
  }
}

function normalizedResults(
  evidence: CourseWorldFrozenEvidenceV1,
  replayResults: readonly OfflineSchedulerReplayResultV1[]
): OfflineSchedulerReplayResultV1[] {
  const results = [...replayResults].sort(
    (left, right) => left.dailyBudgetK - right.dailyBudgetK
  );
  if (
    results.length !== 3 ||
    results.map((result) => result.dailyBudgetK).join(",") !== "1,3,5"
  ) {
    throw new Error("SCENARIO_REPLAY_SET_INCOMPLETE");
  }
  const policyInputHashes = new Set<string>();
  const replayStateHashes = new Set<string>();
  for (const result of results) {
    const { resultHash, ...body } = result;
    assertSha256(resultHash, `${result.scenarioId}.resultHash`);
    if (protocolHash(result.schemaVersion, body) !== resultHash) {
      throw new Error("SCENARIO_RESULT_HASH_MISMATCH");
    }
    if (result.candidateCount !== evidence.counts.eligibleUnansweredCount) {
      throw new Error("SCENARIO_RESULT_SOURCE_MISMATCH");
    }
    for (const [label, value] of [
      ["gapCoverageBps", result.gapCoverageBps],
      ["gapShareAmongSelectedBps", result.gapShareAmongSelectedBps],
      ["naturalResponseOverlapBps", result.naturalResponseOverlapBps],
      ["uniqueAuthorCoverageBps", result.uniqueAuthorCoverageBps],
      ["repeatTouch7dBps", result.repeatTouch7dBps],
      ["authorExposureGiniBps", result.authorExposureGiniBps]
    ] as const) {
      assertBasisPoints(value, `${result.scenarioId}.${label}`);
    }
    if (
      Math.abs(
        result.gapShareAmongSelectedBps +
          result.naturalResponseOverlapBps -
          10_000
      ) > 1
    ) {
      throw new Error("SCENARIO_RESULT_PRECISION_PARTITION_MISMATCH");
    }
    policyInputHashes.add(result.policyInputHash);
    replayStateHashes.add(result.replayStateEventHash);
  }
  if (policyInputHashes.size !== 1 || replayStateHashes.size !== 1) {
    throw new Error("SCENARIO_REPLAY_PAIRING_MISMATCH");
  }
  return results;
}

function buildSpec(
  evidence: CourseWorldFrozenEvidenceV1,
  results: readonly OfflineSchedulerReplayResultV1[]
): CourseWorldScenarioSpecV1 {
  const body = {
    schemaVersion: SCENARIO_LAB_SCHEMA_VERSIONS.scenarioSpec,
    datasetRef: evidence.datasetRef,
    scenarioSetRef: SCENARIO_LAB_SCENARIO_SET_REF,
    sourceEvidenceHash: evidence.evidenceHash,
    runtime: {
      runtimeId: DETERMINISTIC_P3A_RUNTIME_ID,
      version: DETERMINISTIC_P3A_RUNTIME_VERSION
    },
    scenarioIds: results.map((result) => result.scenarioId).sort(),
    referenceScenarioId: "constrained-structural-k3",
    clockKind: "p3a_historical" as const,
    decisionUse: "research_only" as const,
    externalWritesAllowed: false as const,
    interventionEligible: false as const
  };
  if (!body.scenarioIds.includes(body.referenceScenarioId)) {
    throw new Error("SCENARIO_REFERENCE_MISSING");
  }
  return {
    ...body,
    specHash: protocolHash(body.schemaVersion, body)
  };
}

function buildEnvelope(
  spec: CourseWorldScenarioSpecV1,
  results: readonly OfflineSchedulerReplayResultV1[]
): CourseWorldForecastEnvelopeV1 {
  const reference = results.find(
    (result) => result.scenarioId === spec.referenceScenarioId
  );
  if (!reference) throw new Error("SCENARIO_REFERENCE_MISSING");
  const comparisons = results.map((result) => ({
    scenarioId: result.scenarioId,
    relativeToScenarioId: reference.scenarioId,
    selectedDelta: result.selectedCount - reference.selectedCount,
    gapCoverageDeltaBps:
      result.gapCoverageBps - reference.gapCoverageBps,
    gapShareAmongSelectedDeltaBps:
      result.gapShareAmongSelectedBps -
      reference.gapShareAmongSelectedBps,
    uniqueAuthorCoverageDeltaBps:
      result.uniqueAuthorCoverageBps -
      reference.uniqueAuthorCoverageBps,
    repeatTouch7dDeltaBps:
      result.repeatTouch7dBps - reference.repeatTouch7dBps,
    authorExposureGiniDeltaBps:
      result.authorExposureGiniBps - reference.authorExposureGiniBps
  }));
  const body = {
    schemaVersion: SCENARIO_LAB_SCHEMA_VERSIONS.forecastEnvelope,
    validityClass: "offline_replay_only" as const,
    evidenceClasses: [
      "observed_frozen_aggregate",
      "offline_scheduler_replay"
    ] as ["observed_frozen_aggregate", "offline_scheduler_replay"],
    referenceScenarioId: reference.scenarioId,
    comparisons,
    findings: [
      {
        code: "coverage_capacity_tradeoff" as const,
        statement:
          "提高日预算会扩大支持缺口覆盖，同时增加进入队列的选择数量。"
      },
      {
        code: "precision_plateau" as const,
        statement:
          "K=3 与 K=5 的缺口占比接近，新增容量主要改变覆盖规模。"
      },
      {
        code: "distribution_tradeoff" as const,
        statement:
          "扩大容量提高作者覆盖并降低暴露集中度，同时提高七日重复触达。"
      }
    ],
    uncertaintyBasis:
      "frozen_time_holdout_observational_scheduler_replay" as const,
    decisionAuthority: "none" as const,
    interventionEligible: false as const
  };
  return {
    ...body,
    envelopeHash: protocolHash(body.schemaVersion, body)
  };
}

function buildReceipt(input: {
  evidence: CourseWorldFrozenEvidenceV1;
  spec: CourseWorldScenarioSpecV1;
  results: readonly OfflineSchedulerReplayResultV1[];
  envelope: CourseWorldForecastEnvelopeV1;
}): CourseWorldRunReceiptV1 {
  const body = {
    schemaVersion: SCENARIO_LAB_SCHEMA_VERSIONS.runReceipt,
    datasetRef: input.evidence.datasetRef,
    scenarioSetRef: input.spec.scenarioSetRef,
    runtimeId: DETERMINISTIC_P3A_RUNTIME_ID,
    runtimeVersion: DETERMINISTIC_P3A_RUNTIME_VERSION,
    sourceEvidenceHash: input.evidence.evidenceHash,
    scenarioSpecHash: input.spec.specHash,
    scenarioResultSetHash: resultSetHash(input.results),
    forecastEnvelopeHash: input.envelope.envelopeHash,
    networkUsed: false as const,
    externalWriteCount: 0 as const,
    containsForumText: false as const,
    containsIdentity: false as const,
    containsRowLevelKeys: false as const,
    interventionEligible: false as const,
    decisionUse: "research_only" as const
  };
  return {
    ...body,
    receiptHash: protocolHash(body.schemaVersion, body)
  };
}

export function buildDeterministicP3aScenarioReport(
  evidence: CourseWorldFrozenEvidenceV1,
  replayResults: readonly OfflineSchedulerReplayResultV1[]
): CourseWorldScenarioLabReportV1 {
  verifyEvidence(evidence);
  const scenarioResults = normalizedResults(evidence, replayResults);
  const spec = buildSpec(evidence, scenarioResults);
  const envelope = buildEnvelope(spec, scenarioResults);
  const receipt = buildReceipt({
    evidence,
    spec,
    results: scenarioResults,
    envelope
  });
  const body = {
    schemaVersion: SCENARIO_LAB_SCHEMA_VERSIONS.report,
    datasetRef: evidence.datasetRef,
    scenarioSetRef: SCENARIO_LAB_SCENARIO_SET_REF,
    evidence,
    spec,
    scenarioResults,
    envelope,
    receipt,
    runtimeCapabilities: SCENARIO_RUNTIME_CAPABILITIES.map(
      (capability) => ({ ...capability })
    )
  };
  return {
    ...body,
    reportHash: protocolHash(body.schemaVersion, body)
  };
}

export const deterministicP3aReplayAdapter: ScenarioRuntimeAdapterV1 = {
  runtimeId: DETERMINISTIC_P3A_RUNTIME_ID,
  version: DETERMINISTIC_P3A_RUNTIME_VERSION,
  run: buildDeterministicP3aScenarioReport
};
