import {
  canonicalHashList,
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol/canonical-hash";

export const SCENARIO_LAB_SCHEMA_VERSIONS = {
  evidence: "cmooc.courseworld-frozen-evidence.v1",
  scenarioSpec: "cmooc.courseworld-scenario-spec.v1",
  scenarioResult: "cmooc.courseworld-scenario-result.v1",
  forecastEnvelope: "cmooc.courseworld-forecast-envelope.v1",
  runReceipt: "cmooc.courseworld-run-receipt.v1",
  report: "cmooc.courseworld-scenario-lab-report.v1"
} as const;

export const SCENARIO_LAB_DATASET_REF =
  "p3a-2025-holdout-v1" as const;
export const SCENARIO_LAB_SCENARIO_SET_REF =
  "scheduler-k-comparison-v1" as const;
export const DETERMINISTIC_P3A_RUNTIME_ID =
  "deterministic_p3a_replay_v1" as const;
export const DETERMINISTIC_P3A_RUNTIME_VERSION = "1.0.0" as const;

export type ScenarioLabDatasetRef =
  typeof SCENARIO_LAB_DATASET_REF;
export type ScenarioLabScenarioSetRef =
  typeof SCENARIO_LAB_SCENARIO_SET_REF;
export type ScenarioLabRuntimeId =
  | typeof DETERMINISTIC_P3A_RUNTIME_ID
  | "oasis_sidecar_v1"
  | "agentsociety2_sidecar_v1";
export type DailyBudgetK = 1 | 3 | 5;

export interface P3aHistoricalClockV1 {
  kind: "p3a_historical";
  decisionLagHours: 22;
  outcomeEndHours: 86;
  outcomeWindowHours: 64;
  schedulerTickMinutes: 30;
  candidateTtlMinutes: 30;
}

export interface CourseWorldEvidenceCountsV1 {
  snapshotCount: number;
  ineligibleOrAnsweredAtDecisionCount: number;
  eligibleUnansweredCount: number;
  organicExternalResponseInWindowCount: number;
  supportGapAtHorizonCount: number;
}

export interface DecisionCalendarYearCountV1 {
  year: number;
  count: number;
}

export interface CourseWorldFrozenEvidenceV1 {
  schemaVersion: typeof SCENARIO_LAB_SCHEMA_VERSIONS.evidence;
  datasetRef: ScenarioLabDatasetRef;
  evidenceClass: "observed_frozen_aggregate";
  cohortYear: 2025;
  split: "time_holdout";
  clock: P3aHistoricalClockV1;
  counts: CourseWorldEvidenceCountsV1;
  decisionCalendarYearCounts: DecisionCalendarYearCountV1[];
  upstream: {
    snapshotSchemaVersion: "cmooc-decision-snapshot-v1";
    benchmarkSchemaVersion: "cmooc-scheduler-benchmark-v2";
    temporalContractHash: string;
    evidenceRefSetHash: string;
    benchmarkInputHash: string;
    metricsResultHash: string;
    actionLogHash: string;
    artifactFileHashes: {
      decisionSnapshotsCsvSha256: string;
      metricsJsonSha256: string;
      actionsCsvSha256: string;
    };
  };
  privacy: {
    containsForumText: false;
    containsIdentity: false;
    containsRawPlatformIds: false;
    containsRowLevelKeys: false;
  };
  networkUsed: false;
  writesPerformed: false;
  interventionEligible: false;
  evidenceHash: string;
}

export interface CourseWorldScenarioSpecV1 {
  schemaVersion: typeof SCENARIO_LAB_SCHEMA_VERSIONS.scenarioSpec;
  datasetRef: ScenarioLabDatasetRef;
  scenarioSetRef: ScenarioLabScenarioSetRef;
  sourceEvidenceHash: string;
  runtime: {
    runtimeId: typeof DETERMINISTIC_P3A_RUNTIME_ID;
    version: typeof DETERMINISTIC_P3A_RUNTIME_VERSION;
  };
  scenarioIds: string[];
  referenceScenarioId: string;
  clockKind: "p3a_historical";
  decisionUse: "research_only";
  externalWritesAllowed: false;
  interventionEligible: false;
  specHash: string;
}

export interface OfflineSchedulerReplayResultV1 {
  schemaVersion: typeof SCENARIO_LAB_SCHEMA_VERSIONS.scenarioResult;
  scenarioId: string;
  evidenceClass: "offline_scheduler_replay";
  policy: "constrained_structural";
  dailyBudgetK: DailyBudgetK;
  candidateCount: number;
  selectedCount: number;
  supportGapCount: number;
  gapCoverageBps: number;
  gapShareAmongSelectedBps: number;
  naturalResponseOverlapBps: number;
  uniqueAuthorCoverageBps: number;
  repeatTouch7dBps: number;
  authorExposureGiniBps: number;
  withdrawnBeforeSelectionCount: number;
  expiredUnselectedCount: number;
  maturedOutcomeCount: number;
  tickCount: number;
  actionHash: string;
  policyDefinitionHash: string;
  policyInputHash: string;
  replayStateEventHash: string;
  externalWriteCount: 0;
  interventionEligible: false;
  resultHash: string;
}

export interface ScenarioComparisonV1 {
  scenarioId: string;
  relativeToScenarioId: string;
  selectedDelta: number;
  gapCoverageDeltaBps: number;
  gapShareAmongSelectedDeltaBps: number;
  uniqueAuthorCoverageDeltaBps: number;
  repeatTouch7dDeltaBps: number;
  authorExposureGiniDeltaBps: number;
}

export interface CourseWorldForecastEnvelopeV1 {
  schemaVersion: typeof SCENARIO_LAB_SCHEMA_VERSIONS.forecastEnvelope;
  validityClass: "offline_replay_only";
  evidenceClasses: [
    "observed_frozen_aggregate",
    "offline_scheduler_replay"
  ];
  referenceScenarioId: string;
  comparisons: ScenarioComparisonV1[];
  findings: Array<{
    code:
      | "coverage_capacity_tradeoff"
      | "precision_plateau"
      | "distribution_tradeoff";
    statement: string;
  }>;
  uncertaintyBasis:
    "frozen_time_holdout_observational_scheduler_replay";
  decisionAuthority: "none";
  interventionEligible: false;
  envelopeHash: string;
}

export interface ScenarioRuntimeCapabilityV1 {
  runtimeId: ScenarioLabRuntimeId;
  label: string;
  availability: "active" | "adapter_contract_ready";
  role:
    | "historical_replay"
    | "social_interaction_simulation"
    | "distributed_experiment_orchestration";
  contractVersion: "v1";
}

export interface CourseWorldRunReceiptV1 {
  schemaVersion: typeof SCENARIO_LAB_SCHEMA_VERSIONS.runReceipt;
  datasetRef: ScenarioLabDatasetRef;
  scenarioSetRef: ScenarioLabScenarioSetRef;
  runtimeId: typeof DETERMINISTIC_P3A_RUNTIME_ID;
  runtimeVersion: typeof DETERMINISTIC_P3A_RUNTIME_VERSION;
  sourceEvidenceHash: string;
  scenarioSpecHash: string;
  scenarioResultSetHash: string;
  forecastEnvelopeHash: string;
  networkUsed: false;
  externalWriteCount: 0;
  containsForumText: false;
  containsIdentity: false;
  containsRowLevelKeys: false;
  interventionEligible: false;
  decisionUse: "research_only";
  receiptHash: string;
}

export interface CourseWorldScenarioLabReportV1 {
  schemaVersion: typeof SCENARIO_LAB_SCHEMA_VERSIONS.report;
  datasetRef: ScenarioLabDatasetRef;
  scenarioSetRef: ScenarioLabScenarioSetRef;
  evidence: CourseWorldFrozenEvidenceV1;
  spec: CourseWorldScenarioSpecV1;
  scenarioResults: OfflineSchedulerReplayResultV1[];
  envelope: CourseWorldForecastEnvelopeV1;
  receipt: CourseWorldRunReceiptV1;
  runtimeCapabilities: ScenarioRuntimeCapabilityV1[];
  reportHash: string;
}

export interface ScenarioLabRunRequestV1 {
  datasetRef: ScenarioLabDatasetRef;
  scenarioSetRef: ScenarioLabScenarioSetRef;
  runtimeId: typeof DETERMINISTIC_P3A_RUNTIME_ID;
}

export interface ScenarioRuntimeAdapterV1 {
  readonly runtimeId: ScenarioLabRuntimeId;
  readonly version: string;
  run(
    evidence: CourseWorldFrozenEvidenceV1,
    replayResults: readonly OfflineSchedulerReplayResultV1[]
  ): CourseWorldScenarioLabReportV1;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export class ScenarioLabContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ScenarioLabContractError";
    this.code = code;
  }
}

export function assertSha256(value: string, label: string): void {
  if (!HASH_PATTERN.test(value)) {
    throw new ScenarioLabContractError(
      "INVALID_HASH",
      `${label} 必须是 SHA-256 十六进制哈希。`
    );
  }
}

export function assertSafeCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ScenarioLabContractError(
      "INVALID_COUNT",
      `${label} 必须是非负安全整数。`
    );
  }
}

export function assertBasisPoints(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new ScenarioLabContractError(
      "INVALID_BASIS_POINTS",
      `${label} 必须是 0..10000 的整数基点。`
    );
  }
}

export function protocolHash(
  schemaVersion: string,
  value: unknown
): string {
  return canonicalProtocolHash(
    schemaVersion,
    value as CanonicalJsonValue
  );
}

export function resultSetHash(
  results: readonly OfflineSchedulerReplayResultV1[]
): string {
  return canonicalHashList(
    "cmooc.courseworld-scenario-result-set.v1",
    results.map((result) => result.resultHash)
  );
}
