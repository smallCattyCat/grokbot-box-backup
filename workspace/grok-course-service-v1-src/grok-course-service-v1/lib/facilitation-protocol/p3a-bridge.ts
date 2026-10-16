import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalHashList,
  canonicalJson,
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "./canonical-hash";
import { PROTOCOL_SCHEMA_VERSIONS } from "./schemas";
import type { DecisionEvidenceRefV1 } from "./types";
import { parseProtocolObject } from "./validation";

const SNAPSHOT_SCHEMA_VERSION = "cmooc-decision-snapshot-v1";
const TEMPORAL_CONTRACT_VERSION =
  "cmooc-decision-snapshot-temporal-contract-v2";
const TIME_BASIS = "naive_platform_local_time_no_dst_adjustment";
const INTERPRETATION_BOUNDARY =
  "outcomes are observed subsequent human interaction, not effects of an intervention that did not occur";
const STABLE_KEY_PATTERN = /^[a-f0-9]{24}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export const P3A_FIXED_CLOCK = {
  decisionLagHours: 22,
  outcomeEndHours: 86,
  outcomeWindowHours: 64
} as const;

export const P3A_FORMAL_FIELDS = [
  "schema_version",
  "snapshot_key",
  "thread_key",
  "course_key",
  "author_key",
  "year",
  "decision_at",
  "decision_date",
  "decision_lag_hours",
  "outcome_window_end_at",
  "outcome_window_hours",
  "comment_count_asof",
  "external_comment_count_asof",
  "self_comment_count_asof",
  "unique_external_author_count_asof",
  "reply_edge_count_asof",
  "max_reply_depth_asof",
  "future_parent_reference_count_asof",
  "author_prior_post_count_asof",
  "author_prior_external_response_count_asof",
  "author_prior_external_response_rate_asof",
  "author_prior_matured_gap_count_asof",
  "course_post_count_prior_7d_asof",
  "course_external_comment_count_prior_7d_asof",
  "decision_eligibility",
  "suggested_function",
  "outcome_observable",
  "source_observation_end_after_decision_microseconds",
  "first_external_response_after_decision_microseconds",
  "organic_external_response_in_window",
  "external_response_count_in_window",
  "unique_external_responder_count_in_window",
  "support_gap_at_horizon",
  "feature_hash",
  "asof_boundary_ok"
] as const;

export type P3aFormalField = (typeof P3A_FORMAL_FIELDS)[number];
export type P3aSnapshotRow = Record<P3aFormalField, string>;

type JsonRecord = Record<string, unknown>;

export interface P3aSnapshotManifest extends JsonRecord {
  schema_version: typeof SNAPSHOT_SCHEMA_VERSION;
  row_count: number;
  formal_fields: string[];
  source_time_assumption: typeof TIME_BASIS;
  split_policy: {
    development_year: 2024;
    time_holdout_year: 2025;
  };
  time_policy: {
    decision_lag_hours: 22;
    outcome_end_hours: 86;
  };
  privacy: {
    forum_text_written: false;
    raw_platform_ids_written_to_formal_outputs: false;
  };
  interpretation_boundary: typeof INTERPRETATION_BOUNDARY;
  temporal_contract: {
    schema_version: typeof TEMPORAL_CONTRACT_VERSION;
    contract_hash: string;
    decision_clock_audit_status: "passed";
    point_in_time_oracle_status: "passed";
    history_feature_audit_status: "passed";
  };
}

export interface P3aTemporalContract extends JsonRecord {
  schema_version: typeof TEMPORAL_CONTRACT_VERSION;
  time_basis: typeof TIME_BASIS;
  contains_row_level_data: false;
  contract_hash: string;
  stable_key_fields: string[];
  decision_time_field: "decision_at";
  outcome_end_field: "outcome_window_end_at";
  fields: Array<{ name: string } & JsonRecord>;
}

export interface P3aProtocolAuditSummary {
  ok: true;
  schemaVersion: "cmooc.p4a-p3a-bridge-audit.v1";
  inputSnapshotSchemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  protocolSchemaVersion: typeof PROTOCOL_SCHEMA_VERSIONS.decisionEvidenceRef;
  rowCount: number;
  developmentCount: number;
  timeHoldoutCount: number;
  fixedDecisionLagHours: 22;
  fixedOutcomeEndHours: 86;
  temporalContractHash: string;
  evidenceRefSetHash: string;
  containsForumText: false;
  networkUsed: false;
  writesPerformed: false;
}

export class P3aBridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "P3aBridgeError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function assertRecord(
  value: unknown,
  code: string,
  label: string
): JsonRecord {
  if (!isRecord(value)) {
    throw new P3aBridgeError(code, `${label} 必须是对象。`);
  }
  return value;
}

function assertExactArray(
  value: unknown,
  expected: readonly string[],
  code: string,
  label: string
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((item, index) => item !== expected[index])
  ) {
    throw new P3aBridgeError(
      code,
      `${label} 必须与冻结字段顺序完全一致。`
    );
  }
}

function assertExactFieldSet(
  value: readonly string[],
  expected: readonly string[],
  code: string,
  label: string
): void {
  const actualSet = new Set(value);
  if (
    value.length !== expected.length ||
    actualSet.size !== value.length ||
    expected.some((field) => !actualSet.has(field))
  ) {
    throw new P3aBridgeError(
      code,
      `${label} 必须与冻结字段集合完全一致。`
    );
  }
}

function assertProperty(
  record: JsonRecord,
  property: string,
  expected: unknown,
  code: string
): void {
  if (record[property] !== expected) {
    throw new P3aBridgeError(code, `${property} 与冻结契约不一致。`);
  }
}

function legacyCanonicalSha256(value: CanonicalJsonValue): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function validateP3aSnapshotManifest(
  input: unknown
): P3aSnapshotManifest {
  const manifest = assertRecord(
    input,
    "INVALID_SNAPSHOT_MANIFEST",
    "P3A manifest"
  );
  assertProperty(
    manifest,
    "schema_version",
    SNAPSHOT_SCHEMA_VERSION,
    "SNAPSHOT_SCHEMA_MISMATCH"
  );
  if (
    !Number.isSafeInteger(manifest.row_count) ||
    Number(manifest.row_count) < 0
  ) {
    throw new P3aBridgeError(
      "INVALID_ROW_COUNT",
      "manifest.row_count 必须是非负安全整数。"
    );
  }
  assertExactArray(
    manifest.formal_fields,
    P3A_FORMAL_FIELDS,
    "FORMAL_FIELDS_MISMATCH",
    "manifest.formal_fields"
  );
  assertProperty(
    manifest,
    "source_time_assumption",
    TIME_BASIS,
    "TIME_BASIS_MISMATCH"
  );
  assertProperty(
    manifest,
    "interpretation_boundary",
    INTERPRETATION_BOUNDARY,
    "INTERPRETATION_BOUNDARY_MISMATCH"
  );

  const splitPolicy = assertRecord(
    manifest.split_policy,
    "INVALID_SPLIT_POLICY",
    "split_policy"
  );
  assertProperty(
    splitPolicy,
    "development_year",
    2024,
    "DEVELOPMENT_YEAR_MISMATCH"
  );
  assertProperty(
    splitPolicy,
    "time_holdout_year",
    2025,
    "HOLDOUT_YEAR_MISMATCH"
  );

  const timePolicy = assertRecord(
    manifest.time_policy,
    "INVALID_TIME_POLICY",
    "time_policy"
  );
  assertProperty(
    timePolicy,
    "decision_lag_hours",
    P3A_FIXED_CLOCK.decisionLagHours,
    "DECISION_CLOCK_MISMATCH"
  );
  assertProperty(
    timePolicy,
    "outcome_end_hours",
    P3A_FIXED_CLOCK.outcomeEndHours,
    "OUTCOME_CLOCK_MISMATCH"
  );

  const privacy = assertRecord(
    manifest.privacy,
    "INVALID_PRIVACY_MANIFEST",
    "privacy"
  );
  assertProperty(
    privacy,
    "forum_text_written",
    false,
    "FORUM_TEXT_PRESENT"
  );
  assertProperty(
    privacy,
    "raw_platform_ids_written_to_formal_outputs",
    false,
    "RAW_IDENTIFIERS_PRESENT"
  );

  const temporal = assertRecord(
    manifest.temporal_contract,
    "INVALID_TEMPORAL_SUMMARY",
    "temporal_contract"
  );
  assertProperty(
    temporal,
    "schema_version",
    TEMPORAL_CONTRACT_VERSION,
    "TEMPORAL_SCHEMA_MISMATCH"
  );
  for (const status of [
    "decision_clock_audit_status",
    "point_in_time_oracle_status",
    "history_feature_audit_status"
  ]) {
    assertProperty(
      temporal,
      status,
      "passed",
      "UPSTREAM_TEMPORAL_AUDIT_FAILED"
    );
  }
  if (
    typeof temporal.contract_hash !== "string" ||
    !HASH_PATTERN.test(temporal.contract_hash)
  ) {
    throw new P3aBridgeError(
      "INVALID_TEMPORAL_HASH",
      "manifest temporal contract hash 非法。"
    );
  }
  return manifest as P3aSnapshotManifest;
}

export function validateP3aTemporalContract(
  input: unknown
): P3aTemporalContract {
  const contract = assertRecord(
    input,
    "INVALID_TEMPORAL_CONTRACT",
    "P3A temporal contract"
  );
  assertProperty(
    contract,
    "schema_version",
    TEMPORAL_CONTRACT_VERSION,
    "TEMPORAL_SCHEMA_MISMATCH"
  );
  assertProperty(
    contract,
    "time_basis",
    TIME_BASIS,
    "TIME_BASIS_MISMATCH"
  );
  assertProperty(
    contract,
    "contains_row_level_data",
    false,
    "ROW_LEVEL_DATA_IN_CONTRACT"
  );
  assertProperty(
    contract,
    "decision_time_field",
    "decision_at",
    "DECISION_FIELD_MISMATCH"
  );
  assertProperty(
    contract,
    "outcome_end_field",
    "outcome_window_end_at",
    "OUTCOME_FIELD_MISMATCH"
  );
  assertExactArray(
    contract.stable_key_fields,
    ["snapshot_key", "thread_key", "course_key", "author_key"],
    "STABLE_KEY_FIELDS_MISMATCH",
    "temporal contract stable_key_fields"
  );
  if (!Array.isArray(contract.fields)) {
    throw new P3aBridgeError(
      "INVALID_TEMPORAL_FIELDS",
      "temporal contract fields 必须是数组。"
    );
  }
  const fieldNames = contract.fields.map((field) => {
    const record = assertRecord(
      field,
      "INVALID_TEMPORAL_FIELD",
      "temporal field"
    );
    if (typeof record.name !== "string") {
      throw new P3aBridgeError(
        "INVALID_TEMPORAL_FIELD",
        "temporal field 缺少名称。"
      );
    }
    return record.name;
  });
  assertExactArray(
    fieldNames,
    P3A_FORMAL_FIELDS,
    "TEMPORAL_FIELD_COVERAGE_MISMATCH",
    "temporal contract field names"
  );
  if (
    typeof contract.contract_hash !== "string" ||
    !HASH_PATTERN.test(contract.contract_hash)
  ) {
    throw new P3aBridgeError(
      "INVALID_TEMPORAL_HASH",
      "temporal contract hash 非法。"
    );
  }
  const { contract_hash: ignored, ...hashBody } = contract;
  void ignored;
  const computedHash = legacyCanonicalSha256(
    hashBody as CanonicalJsonValue
  );
  if (computedHash !== contract.contract_hash) {
    throw new P3aBridgeError(
      "TEMPORAL_HASH_MISMATCH",
      "temporal contract 内容与 contract_hash 不一致。"
    );
  }
  return contract as P3aTemporalContract;
}

function parseFrozenInteger(
  row: P3aSnapshotRow,
  field: P3aFormalField,
  expected: number
): void {
  if (row[field] !== String(expected)) {
    throw new P3aBridgeError(
      "ROW_CLOCK_MISMATCH",
      `${field} 与冻结真实时钟不一致。`
    );
  }
}

function timestampMilliseconds(value: string, field: string): number {
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ? value
    : `${value}Z`;
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) {
    throw new P3aBridgeError(
      "INVALID_ROW_TIMESTAMP",
      `${field} 不是有效的 ISO-8601 时间。`
    );
  }
  return milliseconds;
}

function validateP3aSnapshotRow(
  input: Record<string, string>
): P3aSnapshotRow {
  assertExactFieldSet(
    Object.keys(input),
    P3A_FORMAL_FIELDS,
    "ROW_FIELDS_MISMATCH",
    "decision snapshot row"
  );
  const row = input as P3aSnapshotRow;
  if (row.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    throw new P3aBridgeError(
      "ROW_SCHEMA_MISMATCH",
      "行 schema_version 与冻结快照版本不一致。"
    );
  }
  for (const field of [
    "snapshot_key",
    "thread_key",
    "course_key",
    "author_key"
  ] as const) {
    if (!STABLE_KEY_PATTERN.test(row[field])) {
      throw new P3aBridgeError(
        "INVALID_STABLE_KEY",
        `${field} 不是匿名稳定键。`
      );
    }
  }
  if (!HASH_PATTERN.test(row.feature_hash)) {
    throw new P3aBridgeError(
      "INVALID_FEATURE_HASH",
      "feature_hash 非法。"
    );
  }
  if (row.asof_boundary_ok !== "1") {
    throw new P3aBridgeError(
      "AS_OF_BOUNDARY_FAILED",
      "只允许 asof_boundary_ok=1 的快照进入协议。"
    );
  }
  if (row.year !== "2024" && row.year !== "2025") {
    throw new P3aBridgeError(
      "ROW_SPLIT_MISMATCH",
      "年份必须属于 2024 开发集或 2025 时间留出。"
    );
  }
  if (row.decision_date !== row.decision_at.slice(0, 10)) {
    throw new P3aBridgeError(
      "ROW_DECISION_CLOCK_MISMATCH",
      "decision_date 与 decision_at 不一致。"
    );
  }
  parseFrozenInteger(
    row,
    "decision_lag_hours",
    P3A_FIXED_CLOCK.decisionLagHours
  );
  parseFrozenInteger(
    row,
    "outcome_window_hours",
    P3A_FIXED_CLOCK.outcomeWindowHours
  );
  const decisionAt = timestampMilliseconds(
    row.decision_at,
    "decision_at"
  );
  const outcomeEnd = timestampMilliseconds(
    row.outcome_window_end_at,
    "outcome_window_end_at"
  );
  if (
    outcomeEnd - decisionAt !==
    P3A_FIXED_CLOCK.outcomeWindowHours * 60 * 60 * 1000
  ) {
    throw new P3aBridgeError(
      "ROW_OUTCOME_CLOCK_MISMATCH",
      "outcome_window_end_at 未保持冻结的 64 小时观察窗。"
    );
  }
  return row;
}

function buildValidatedDecisionEvidenceRef(
  row: P3aSnapshotRow,
  manifest: P3aSnapshotManifest,
  contract: P3aTemporalContract
): DecisionEvidenceRefV1 {
  if (
    manifest.temporal_contract.contract_hash !== contract.contract_hash
  ) {
    throw new P3aBridgeError(
      "CROSS_MANIFEST_HASH_MISMATCH",
      "manifest 与 temporal contract 的哈希不一致。"
    );
  }
  const year = Number(row.year) as 2024 | 2025;
  return parseProtocolObject("decisionEvidenceRef", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.decisionEvidenceRef,
    snapshotKey: row.snapshot_key,
    threadKey: row.thread_key,
    courseKey: row.course_key,
    authorKey: row.author_key,
    year,
    split: year === 2024 ? "development" : "time_holdout",
    decisionAt: row.decision_at,
    snapshotSchemaVersion: manifest.schema_version,
    temporalContractVersion: contract.schema_version,
    temporalContractHash: contract.contract_hash,
    featureHash: row.feature_hash,
    timeBasis: contract.time_basis,
    temporalEvidenceStatus: "as_of_verified",
    contentRevisionStatus: "not_included",
    containsForumText: false
  });
}

export function buildDecisionEvidenceRef(
  rowInput: Record<string, string>,
  manifestInput: unknown,
  contractInput: unknown
): DecisionEvidenceRefV1 {
  const manifest = validateP3aSnapshotManifest(manifestInput);
  const contract = validateP3aTemporalContract(contractInput);
  const row = validateP3aSnapshotRow(rowInput);
  return buildValidatedDecisionEvidenceRef(row, manifest, contract);
}

export function parseP3aCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let justClosedQuote = false;
  const input = text.replace(/^\uFEFF/, "");

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          justClosedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      if (field.length === 0 && !justClosedQuote) {
        quoted = true;
        continue;
      }
      throw new P3aBridgeError(
        "INVALID_CSV",
        "CSV 未转义的引号非法。"
      );
    }
    if (character === ",") {
      row.push(field);
      field = "";
      justClosedQuote = false;
      continue;
    }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") {
        index += 1;
      }
      row.push(field);
      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }
      row = [];
      field = "";
      justClosedQuote = false;
      continue;
    }
    if (justClosedQuote) {
      throw new P3aBridgeError(
        "INVALID_CSV",
        "CSV 引号结束后存在非法字符。"
      );
    }
    field += character;
  }
  if (quoted) {
    throw new P3aBridgeError("INVALID_CSV", "CSV 存在未闭合引号。");
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) {
    throw new P3aBridgeError("EMPTY_CSV", "decision snapshots CSV 为空。");
  }
  const [header, ...dataRows] = rows;
  assertExactArray(
    header,
    P3A_FORMAL_FIELDS,
    "CSV_HEADER_MISMATCH",
    "CSV header"
  );
  return dataRows.map((values, index) => {
    if (values.length !== header.length) {
      throw new P3aBridgeError(
        "CSV_ROW_WIDTH_MISMATCH",
        `CSV 第 ${index + 2} 行列数与冻结表头不一致。`
      );
    }
    return Object.fromEntries(
      header.map((name, fieldIndex) => [name, values[fieldIndex]])
    );
  });
}

function parseJsonArtifact(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new P3aBridgeError(
      "INVALID_JSON_ARTIFACT",
      `${label} 不是有效 JSON。`
    );
  }
}

export async function auditP3aDecisionArtifacts(
  inputDirectory: string
): Promise<P3aProtocolAuditSummary> {
  const [manifestText, contractText, snapshotText] = await Promise.all([
    readFile(join(inputDirectory, "manifest.json"), "utf8"),
    readFile(
      join(inputDirectory, "audit-v2", "temporal-contract.json"),
      "utf8"
    ),
    readFile(join(inputDirectory, "decision_snapshots.csv"), "utf8")
  ]);
  const manifest = validateP3aSnapshotManifest(
    parseJsonArtifact(manifestText, "manifest.json")
  );
  const contract = validateP3aTemporalContract(
    parseJsonArtifact(contractText, "temporal-contract.json")
  );
  if (
    manifest.temporal_contract.contract_hash !== contract.contract_hash
  ) {
    throw new P3aBridgeError(
      "CROSS_MANIFEST_HASH_MISMATCH",
      "manifest 与 temporal contract 的哈希不一致。"
    );
  }
  const rows = parseP3aCsv(snapshotText);
  if (rows.length !== manifest.row_count) {
    throw new P3aBridgeError(
      "ROW_COUNT_MISMATCH",
      "CSV 行数与 manifest.row_count 不一致。"
    );
  }

  let developmentCount = 0;
  let timeHoldoutCount = 0;
  const evidenceHashes = rows.map((input) => {
    const row = validateP3aSnapshotRow(input);
    const evidenceRef = buildValidatedDecisionEvidenceRef(
      row,
      manifest,
      contract
    );
    if (evidenceRef.split === "development") {
      developmentCount += 1;
    } else {
      timeHoldoutCount += 1;
    }
    return canonicalProtocolHash(
      evidenceRef.schemaVersion,
      evidenceRef
    );
  });

  return {
    ok: true,
    schemaVersion: "cmooc.p4a-p3a-bridge-audit.v1",
    inputSnapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    protocolSchemaVersion:
      PROTOCOL_SCHEMA_VERSIONS.decisionEvidenceRef,
    rowCount: rows.length,
    developmentCount,
    timeHoldoutCount,
    fixedDecisionLagHours: P3A_FIXED_CLOCK.decisionLagHours,
    fixedOutcomeEndHours: P3A_FIXED_CLOCK.outcomeEndHours,
    temporalContractHash: contract.contract_hash,
    evidenceRefSetHash: canonicalHashList(
      "cmooc.p4a-decision-evidence-ref-set.v1",
      evidenceHashes
    ),
    containsForumText: false,
    networkUsed: false,
    writesPerformed: false
  };
}
