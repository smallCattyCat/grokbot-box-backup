import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  P3A_FIXED_CLOCK,
  auditP3aDecisionArtifacts,
  parseP3aCsv
} from "@/lib/facilitation-protocol/p3a-bridge";
import {
  SCENARIO_LAB_DATASET_REF,
  SCENARIO_LAB_SCHEMA_VERSIONS,
  type CourseWorldFrozenEvidenceV1,
  type DailyBudgetK,
  type OfflineSchedulerReplayResultV1,
  assertBasisPoints,
  assertSafeCount,
  assertSha256,
  protocolHash
} from "./contracts";

type JsonRecord = Record<string, unknown>;

const EXPECTED_FORMAL_DATASET = {
  totalRowCount: 12_627,
  developmentCount: 9_925,
  snapshotCount: 2_702,
  eligibleUnansweredCount: 617,
  organicExternalResponseInWindowCount: 217,
  supportGapAtHorizonCount: 400,
  decisionCalendarYearCounts: [
    { year: 2025, count: 2_604 },
    { year: 2026, count: 98 }
  ]
} as const;

export type P3aScenarioEvidenceExpectation = {
  totalRowCount: number;
  developmentCount: number;
  snapshotCount: number;
  eligibleUnansweredCount: number;
  organicExternalResponseInWindowCount: number;
  supportGapAtHorizonCount: number;
  decisionCalendarYearCounts: Array<{ year: number; count: number }>;
};

export interface P3aScenarioEvidenceBundle {
  evidence: CourseWorldFrozenEvidenceV1;
  replayResults: OfflineSchedulerReplayResultV1[];
}

export class ScenarioLabEvidenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ScenarioLabEvidenceError";
    this.code = code;
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScenarioLabEvidenceError(
      "EVIDENCE_ARTIFACT_INVALID",
      `${label} 必须是对象。`
    );
  }
  return value as JsonRecord;
}

function stringValue(
  value: unknown,
  label: string,
  expected?: string
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ScenarioLabEvidenceError(
      "EVIDENCE_ARTIFACT_INVALID",
      `${label} 必须是非空字符串。`
    );
  }
  if (expected !== undefined && value !== expected) {
    throw new ScenarioLabEvidenceError(
      "EVIDENCE_CONTRACT_MISMATCH",
      `${label} 与冻结契约不一致。`
    );
  }
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ScenarioLabEvidenceError(
      "EVIDENCE_ARTIFACT_INVALID",
      `${label} 必须是有限数值。`
    );
  }
  return value;
}

function integerValue(value: unknown, label: string): number {
  const parsed = numberValue(value, label);
  assertSafeCount(parsed, label);
  return parsed;
}

function falseValue(value: unknown, label: string): false {
  if (value !== false) {
    throw new ScenarioLabEvidenceError(
      "EVIDENCE_PRIVACY_MISMATCH",
      `${label} 必须为 false。`
    );
  }
  return false;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ScenarioLabEvidenceError(
      "EVIDENCE_ARTIFACT_INVALID",
      `${label} 必须是数组。`
    );
  }
  return value;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ScenarioLabEvidenceError(
      "EVIDENCE_ARTIFACT_INVALID",
      `${label} 不是有效 JSON。`
    );
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireMatchingHash(
  actual: string,
  expected: string,
  label: string
): void {
  assertSha256(expected, label);
  if (actual !== expected) {
    throw new ScenarioLabEvidenceError(
      "EVIDENCE_HASH_MISMATCH",
      `${label} 与文件内容不一致。`
    );
  }
}

function toBasisPoints(value: unknown, label: string): number {
  const ratio = numberValue(value, label);
  if (ratio < 0 || ratio > 1) {
    throw new ScenarioLabEvidenceError(
      "EVIDENCE_METRIC_INVALID",
      `${label} 必须处于 0..1。`
    );
  }
  const basisPoints = Math.round(ratio * 10_000);
  assertBasisPoints(basisPoints, label);
  return basisPoints;
}

function dailyBudget(value: unknown, label: string): DailyBudgetK {
  if (value !== 1 && value !== 3 && value !== 5) {
    throw new ScenarioLabEvidenceError(
      "EVIDENCE_SCENARIO_SET_INCOMPLETE",
      `${label} 只允许 K=1/3/5。`
    );
  }
  return value;
}

function exactExpectation(
  actual: number,
  expected: number,
  label: string
): void {
  if (actual !== expected) {
    throw new ScenarioLabEvidenceError(
      "EVIDENCE_DATASET_DRIFT",
      `${label} 与数据集版本不一致。`
    );
  }
}

function defaultP3aRoot(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new ScenarioLabEvidenceError(
      "EVIDENCE_SOURCE_UNAVAILABLE",
      "当前运行环境没有可用的本机研究工件根目录。"
    );
  }
  return join(
    localAppData,
    "cmooc-research",
    "p3a",
    "decision-snapshot-v1"
  );
}

function compareCalendarCounts(
  actual: readonly { year: number; count: number }[],
  expected: readonly { year: number; count: number }[]
): void {
  const normalize = (items: readonly { year: number; count: number }[]) =>
    [...items].sort((left, right) => left.year - right.year);
  if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected))) {
    throw new ScenarioLabEvidenceError(
      "EVIDENCE_DATASET_DRIFT",
      "cohortYear 与 decisionCalendarYear 的冻结分布已漂移。"
    );
  }
}

function buildReplayResults(input: {
  metrics: JsonRecord;
  eligibleUnansweredCount: number;
  supportGapAtHorizonCount: number;
}): OfflineSchedulerReplayResultV1[] {
  const metricRows = arrayValue(input.metrics.by_year, "metrics.by_year")
    .map((value) => record(value, "metrics.by_year[]"))
    .filter(
      (row) =>
        row.year === 2025 &&
        row.split === "time_holdout" &&
        row.policy === "constrained_structural"
    );
  const summaryRows = arrayValue(
    input.metrics.run_summaries,
    "metrics.run_summaries"
  )
    .map((value) => record(value, "metrics.run_summaries[]"))
    .filter(
      (row) =>
        row.year === 2025 &&
        row.split === "time_holdout" &&
        row.policy === "constrained_structural"
    );
  if (metricRows.length !== 3 || summaryRows.length !== 3) {
    throw new ScenarioLabEvidenceError(
      "EVIDENCE_SCENARIO_SET_INCOMPLETE",
      "2025 constrained_structural 必须完整包含 K=1/3/5。"
    );
  }

  const results = metricRows.map((metricRow) => {
    const k = dailyBudget(
      metricRow.daily_budget_k,
      "metrics.daily_budget_k"
    );
    const summaryRow = summaryRows.find(
      (candidate) => candidate.daily_budget_k === k
    );
    if (!summaryRow) {
      throw new ScenarioLabEvidenceError(
        "EVIDENCE_SCENARIO_SET_INCOMPLETE",
        `K=${k} 缺少 replay summary。`
      );
    }
    const candidateCount = integerValue(
      summaryRow.candidate_count,
      `K=${k}.candidate_count`
    );
    const selectedCount = integerValue(
      metricRow.selected_count,
      `K=${k}.selected_count`
    );
    exactExpectation(
      candidateCount,
      input.eligibleUnansweredCount,
      `K=${k}.candidate_count`
    );
    exactExpectation(
      integerValue(metricRow.eligible_count, `K=${k}.eligible_count`),
      input.eligibleUnansweredCount,
      `K=${k}.eligible_count`
    );
    exactExpectation(
      integerValue(metricRow.support_gap_count, `K=${k}.support_gap_count`),
      input.supportGapAtHorizonCount,
      `K=${k}.support_gap_count`
    );
    exactExpectation(
      integerValue(summaryRow.action_count, `K=${k}.action_count`),
      selectedCount,
      `K=${k}.action_count`
    );

    const body = {
      schemaVersion: SCENARIO_LAB_SCHEMA_VERSIONS.scenarioResult,
      scenarioId: `constrained-structural-k${k}`,
      evidenceClass: "offline_scheduler_replay" as const,
      policy: "constrained_structural" as const,
      dailyBudgetK: k,
      candidateCount,
      selectedCount,
      supportGapCount: input.supportGapAtHorizonCount,
      gapCoverageBps: toBasisPoints(metricRow.coverage, `K=${k}.coverage`),
      gapShareAmongSelectedBps: toBasisPoints(
        metricRow.precision_at_k,
        `K=${k}.precision_at_k`
      ),
      naturalResponseOverlapBps: toBasisPoints(
        metricRow.unnecessary_intervention_rate,
        `K=${k}.unnecessary_intervention_rate`
      ),
      uniqueAuthorCoverageBps: toBasisPoints(
        metricRow.unique_author_coverage,
        `K=${k}.unique_author_coverage`
      ),
      repeatTouch7dBps: toBasisPoints(
        metricRow.author_repeat_touch_rate_7d,
        `K=${k}.author_repeat_touch_rate_7d`
      ),
      authorExposureGiniBps: toBasisPoints(
        metricRow.author_exposure_gini,
        `K=${k}.author_exposure_gini`
      ),
      withdrawnBeforeSelectionCount: integerValue(
        summaryRow.withdrawn_after_external_response_count,
        `K=${k}.withdrawn_after_external_response_count`
      ),
      expiredUnselectedCount: integerValue(
        summaryRow.expired_unselected_count,
        `K=${k}.expired_unselected_count`
      ),
      maturedOutcomeCount: integerValue(
        summaryRow.matured_outcome_count,
        `K=${k}.matured_outcome_count`
      ),
      tickCount: integerValue(summaryRow.tick_count, `K=${k}.tick_count`),
      actionHash: stringValue(summaryRow.action_hash, `K=${k}.action_hash`),
      policyDefinitionHash: stringValue(
        summaryRow.policy_definition_hash,
        `K=${k}.policy_definition_hash`
      ),
      policyInputHash: stringValue(
        summaryRow.policy_input_hash,
        `K=${k}.policy_input_hash`
      ),
      replayStateEventHash: stringValue(
        summaryRow.replay_state_event_hash,
        `K=${k}.replay_state_event_hash`
      ),
      externalWriteCount: 0 as const,
      interventionEligible: false as const
    };
    for (const [label, hash] of [
      ["actionHash", body.actionHash],
      ["policyDefinitionHash", body.policyDefinitionHash],
      ["policyInputHash", body.policyInputHash],
      ["replayStateEventHash", body.replayStateEventHash]
    ] as const) {
      assertSha256(hash, `K=${k}.${label}`);
    }
    return {
      ...body,
      resultHash: protocolHash(body.schemaVersion, body)
    };
  });

  const budgets = results.map((result) => result.dailyBudgetK).sort();
  if (budgets.join(",") !== "1,3,5") {
    throw new ScenarioLabEvidenceError(
      "EVIDENCE_SCENARIO_SET_INCOMPLETE",
      "回放预算集合必须恰好为 K=1/3/5。"
    );
  }
  return results.sort((left, right) => left.dailyBudgetK - right.dailyBudgetK);
}

export async function readP3aScenarioEvidence(input?: {
  inputDirectory?: string;
  expected?: P3aScenarioEvidenceExpectation;
}): Promise<P3aScenarioEvidenceBundle> {
  const inputDirectory = input?.inputDirectory ?? defaultP3aRoot();
  const expected = input?.expected ?? EXPECTED_FORMAL_DATASET;
  const benchmarkDirectory = join(inputDirectory, "benchmark-v2");

  const [
    audit,
    snapshotBuffer,
    metricsBuffer,
    replayManifestBuffer,
    actionsBuffer
  ] = await Promise.all([
    auditP3aDecisionArtifacts(inputDirectory),
    readFile(join(inputDirectory, "decision_snapshots.csv")),
    readFile(join(benchmarkDirectory, "metrics.json")),
    readFile(join(benchmarkDirectory, "replay-manifest.json")),
    readFile(join(benchmarkDirectory, "actions.csv"))
  ]);
  exactExpectation(audit.rowCount, expected.totalRowCount, "总快照数");
  exactExpectation(
    audit.developmentCount,
    expected.developmentCount,
    "development 快照数"
  );
  exactExpectation(
    audit.timeHoldoutCount,
    expected.snapshotCount,
    "time_holdout 快照数"
  );

  const snapshotText = snapshotBuffer.toString("utf8");
  const metricsText = metricsBuffer.toString("utf8");
  const metrics = record(parseJson(metricsText, "benchmark-v2/metrics.json"), "metrics");
  const replayManifest = record(
    parseJson(
      replayManifestBuffer.toString("utf8"),
      "benchmark-v2/replay-manifest.json"
    ),
    "replay manifest"
  );
  stringValue(
    metrics.schema_version,
    "metrics.schema_version",
    "cmooc-scheduler-benchmark-v2"
  );
  stringValue(
    replayManifest.schema_version,
    "replay_manifest.schema_version",
    "cmooc-scheduler-benchmark-v2"
  );
  falseValue(replayManifest.contains_forum_text, "contains_forum_text");
  falseValue(
    replayManifest.contains_raw_platform_ids,
    "contains_raw_platform_ids"
  );

  const artifactHashes = record(
    replayManifest.artifact_file_hashes,
    "artifact_file_hashes"
  );
  const decisionSnapshotsCsvSha256 = stringValue(
    artifactHashes.decision_snapshots_csv_sha256,
    "decision_snapshots_csv_sha256"
  );
  const metricsJsonSha256 = stringValue(
    artifactHashes.metrics_json_sha256,
    "metrics_json_sha256"
  );
  const actionsCsvSha256 = stringValue(
    artifactHashes.actions_csv_sha256,
    "actions_csv_sha256"
  );
  requireMatchingHash(
    sha256(snapshotBuffer),
    decisionSnapshotsCsvSha256,
    "decision snapshots 文件哈希"
  );
  requireMatchingHash(
    sha256(metricsBuffer),
    metricsJsonSha256,
    "metrics 文件哈希"
  );
  requireMatchingHash(
    sha256(actionsBuffer),
    actionsCsvSha256,
    "actions 文件哈希"
  );

  const benchmarkInputHash = stringValue(
    metrics.benchmark_input_hash,
    "metrics.benchmark_input_hash"
  );
  const metricsResultHash = stringValue(
    metrics.metrics_result_hash,
    "metrics.metrics_result_hash"
  );
  const actionLogHash = stringValue(
    metrics.action_log_hash,
    "metrics.action_log_hash"
  );
  for (const [label, left, right] of [
    [
      "benchmark_input_hash",
      benchmarkInputHash,
      replayManifest.benchmark_input_hash
    ],
    ["metrics_result_hash", metricsResultHash, replayManifest.metrics_result_hash],
    ["action_log_hash", actionLogHash, replayManifest.action_log_hash]
  ] as const) {
    assertSha256(left, label);
    if (left !== right) {
      throw new ScenarioLabEvidenceError(
        "EVIDENCE_CROSS_MANIFEST_MISMATCH",
        `${label} 在 metrics 与 replay manifest 之间不一致。`
      );
    }
  }

  const rows = parseP3aCsv(snapshotText);
  const holdoutRows = rows.filter((row) => row.year === "2025");
  exactExpectation(
    holdoutRows.length,
    expected.snapshotCount,
    "2025 cohort 快照数"
  );
  const eligibleRows = holdoutRows.filter(
    (row) => row.decision_eligibility === "eligible_unanswered"
  );
  const organicExternalResponseInWindowCount = eligibleRows.filter(
    (row) => row.organic_external_response_in_window === "1"
  ).length;
  const supportGapAtHorizonCount = eligibleRows.filter(
    (row) => row.support_gap_at_horizon === "1"
  ).length;
  exactExpectation(
    eligibleRows.length,
    expected.eligibleUnansweredCount,
    "eligible_unanswered 数"
  );
  exactExpectation(
    organicExternalResponseInWindowCount,
    expected.organicExternalResponseInWindowCount,
    "自然外部回应数"
  );
  exactExpectation(
    supportGapAtHorizonCount,
    expected.supportGapAtHorizonCount,
    "观察终点支持缺口数"
  );
  if (
    organicExternalResponseInWindowCount + supportGapAtHorizonCount !==
    eligibleRows.length
  ) {
    throw new ScenarioLabEvidenceError(
      "EVIDENCE_OUTCOME_PARTITION_MISMATCH",
      "eligible_unanswered 未被自然回应与支持缺口完整划分。"
    );
  }

  const calendarCounts = [...holdoutRows.reduce((counts, row) => {
    const yearText = row.decision_at.slice(0, 4);
    const year = Number(yearText);
    if (!Number.isSafeInteger(year)) {
      throw new ScenarioLabEvidenceError(
        "EVIDENCE_CLOCK_INVALID",
        "decision_at 缺少可解释的日历年份。"
      );
    }
    counts.set(year, (counts.get(year) ?? 0) + 1);
    return counts;
  }, new Map<number, number>())]
    .map(([year, count]) => ({ year, count }))
    .sort((left, right) => left.year - right.year);
  compareCalendarCounts(calendarCounts, expected.decisionCalendarYearCounts);

  const body = {
    schemaVersion: SCENARIO_LAB_SCHEMA_VERSIONS.evidence,
    datasetRef: SCENARIO_LAB_DATASET_REF,
    evidenceClass: "observed_frozen_aggregate" as const,
    cohortYear: 2025 as const,
    split: "time_holdout" as const,
    clock: {
      kind: "p3a_historical" as const,
      decisionLagHours: P3A_FIXED_CLOCK.decisionLagHours,
      outcomeEndHours: P3A_FIXED_CLOCK.outcomeEndHours,
      outcomeWindowHours: P3A_FIXED_CLOCK.outcomeWindowHours,
      schedulerTickMinutes: 30 as const,
      candidateTtlMinutes: 30 as const
    },
    counts: {
      snapshotCount: holdoutRows.length,
      ineligibleOrAnsweredAtDecisionCount:
        holdoutRows.length - eligibleRows.length,
      eligibleUnansweredCount: eligibleRows.length,
      organicExternalResponseInWindowCount,
      supportGapAtHorizonCount
    },
    decisionCalendarYearCounts: calendarCounts,
    upstream: {
      snapshotSchemaVersion: "cmooc-decision-snapshot-v1" as const,
      benchmarkSchemaVersion: "cmooc-scheduler-benchmark-v2" as const,
      temporalContractHash: audit.temporalContractHash,
      evidenceRefSetHash: audit.evidenceRefSetHash,
      benchmarkInputHash,
      metricsResultHash,
      actionLogHash,
      artifactFileHashes: {
        decisionSnapshotsCsvSha256,
        metricsJsonSha256,
        actionsCsvSha256
      }
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
  const evidence: CourseWorldFrozenEvidenceV1 = {
    ...body,
    evidenceHash: protocolHash(body.schemaVersion, body)
  };

  return {
    evidence,
    replayResults: buildReplayResults({
      metrics,
      eligibleUnansweredCount: eligibleRows.length,
      supportGapAtHorizonCount
    })
  };
}
