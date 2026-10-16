import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  P3A_FORMAL_FIELDS,
  P3aBridgeError,
  auditP3aDecisionArtifacts,
  buildDecisionEvidenceRef,
  canonicalJson,
  canonicalProtocolHash,
  parseP3aCsv,
  type CanonicalJsonValue,
  type P3aSnapshotRow
} from "../../lib/facilitation-protocol";

const HASH_A = "a".repeat(64);
const KEY_A = "a".repeat(24);
const KEY_B = "b".repeat(24);
const KEY_C = "c".repeat(24);
const KEY_D = "d".repeat(24);

function temporalContract() {
  const body = {
    schema_version: "cmooc-decision-snapshot-temporal-contract-v2",
    time_basis: "naive_platform_local_time_no_dst_adjustment",
    stable_key_fields: [
      "snapshot_key",
      "thread_key",
      "course_key",
      "author_key"
    ],
    event_stable_key_fields: [
      "snapshot_key",
      "field_name",
      "event_key"
    ],
    decision_time_field: "decision_at",
    outcome_end_field: "outcome_window_end_at",
    contains_row_level_data: false,
    fields: P3A_FORMAL_FIELDS.map((name) => ({ name }))
  };
  const contractHash = createHash("sha256")
    .update(canonicalJson(body as CanonicalJsonValue), "utf8")
    .digest("hex");
  return { ...body, contract_hash: contractHash };
}

function snapshotManifest(
  contractHash: string,
  rowCount = 1
) {
  return {
    schema_version: "cmooc-decision-snapshot-v1",
    row_count: rowCount,
    formal_fields: [...P3A_FORMAL_FIELDS],
    source_time_assumption:
      "naive_platform_local_time_no_dst_adjustment",
    split_policy: {
      development_year: 2024,
      time_holdout_year: 2025
    },
    time_policy: {
      decision_lag_hours: 22,
      outcome_end_hours: 86
    },
    privacy: {
      forum_text_written: false,
      raw_platform_ids_written_to_formal_outputs: false
    },
    interpretation_boundary:
      "outcomes are observed subsequent human interaction, not effects of an intervention that did not occur",
    temporal_contract: {
      schema_version:
        "cmooc-decision-snapshot-temporal-contract-v2",
      contract_hash: contractHash,
      decision_clock_audit_status: "passed",
      point_in_time_oracle_status: "passed",
      history_feature_audit_status: "passed"
    }
  };
}

function snapshotRow(year: 2024 | 2025 = 2024): P3aSnapshotRow {
  const decisionAt = `${year}-01-02T22:00:00`;
  const outcomeEnd = `${year}-01-05T14:00:00`;
  return {
    schema_version: "cmooc-decision-snapshot-v1",
    snapshot_key: KEY_A,
    thread_key: KEY_B,
    course_key: KEY_C,
    author_key: KEY_D,
    year: String(year),
    decision_at: decisionAt,
    decision_date: `${year}-01-02`,
    decision_lag_hours: "22",
    outcome_window_end_at: outcomeEnd,
    outcome_window_hours: "64",
    comment_count_asof: "0",
    external_comment_count_asof: "0",
    self_comment_count_asof: "0",
    unique_external_author_count_asof: "0",
    reply_edge_count_asof: "0",
    max_reply_depth_asof: "0",
    future_parent_reference_count_asof: "0",
    author_prior_post_count_asof: "2",
    author_prior_external_response_count_asof: "1",
    author_prior_external_response_rate_asof: "0.5",
    author_prior_matured_gap_count_asof: "1",
    course_post_count_prior_7d_asof: "3",
    course_external_comment_count_prior_7d_asof: "4",
    decision_eligibility: "eligible_unanswered",
    suggested_function: "resource_connection",
    outcome_observable: "1",
    source_observation_end_after_decision_microseconds: "230400000000",
    first_external_response_after_decision_microseconds: "",
    organic_external_response_in_window: "0",
    external_response_count_in_window: "0",
    unique_external_responder_count_in_window: "0",
    support_gap_at_horizon: "1",
    feature_hash: HASH_A,
    asof_boundary_ok: "1"
  };
}

function csv(rows: P3aSnapshotRow[]): string {
  return [
    P3A_FORMAL_FIELDS.join(","),
    ...rows.map((row) =>
      P3A_FORMAL_FIELDS.map((field) => row[field]).join(",")
    )
  ].join("\n");
}

test("P3A 只读桥接只投影匿名决策证据字段", () => {
  const contract = temporalContract();
  const manifest = snapshotManifest(contract.contract_hash);
  const evidenceRef = buildDecisionEvidenceRef(
    snapshotRow(),
    manifest,
    contract
  );
  assert.deepEqual(evidenceRef, {
    schemaVersion: "cmooc.decision-evidence-ref.v1",
    snapshotKey: KEY_A,
    threadKey: KEY_B,
    courseKey: KEY_C,
    authorKey: KEY_D,
    year: 2024,
    split: "development",
    decisionAt: "2024-01-02T22:00:00",
    snapshotSchemaVersion: "cmooc-decision-snapshot-v1",
    temporalContractVersion:
      "cmooc-decision-snapshot-temporal-contract-v2",
    temporalContractHash: contract.contract_hash,
    featureHash: HASH_A,
    timeBasis: "naive_platform_local_time_no_dst_adjustment",
    temporalEvidenceStatus: "as_of_verified",
    contentRevisionStatus: "not_included",
    containsForumText: false
  });
  const serialized = JSON.stringify(evidenceRef);
  for (const excludedField of [
    "suggested_function",
    "organic_external_response_in_window",
    "support_gap_at_horizon",
    "outcome_observable"
  ]) {
    assert.equal(serialized.includes(excludedField), false);
  }
});

test("修改 decision_at 之后的结果后缀不能改变证据引用哈希", () => {
  const contract = temporalContract();
  const manifest = snapshotManifest(contract.contract_hash);
  const before = snapshotRow();
  const after = {
    ...before,
    first_external_response_after_decision_microseconds: "1",
    organic_external_response_in_window: "1",
    external_response_count_in_window: "99",
    unique_external_responder_count_in_window: "8",
    support_gap_at_horizon: "0"
  };
  const beforeRef = buildDecisionEvidenceRef(
    before,
    manifest,
    contract
  );
  const afterRef = buildDecisionEvidenceRef(
    after,
    manifest,
    contract
  );
  assert.deepEqual(afterRef, beforeRef);
  assert.equal(
    canonicalProtocolHash(beforeRef.schemaVersion, beforeRef),
    canonicalProtocolHash(afterRef.schemaVersion, afterRef)
  );
});

test("桥接拒绝失败的 as-of 边界、未知字段和拆分漂移", () => {
  const contract = temporalContract();
  const manifest = snapshotManifest(contract.contract_hash);
  for (const invalidRow of [
    { ...snapshotRow(), asof_boundary_ok: "0" },
    { ...snapshotRow(), unexpected_field: "must-fail" },
    { ...snapshotRow(), year: "2026" }
  ]) {
    assert.throws(
      () =>
        buildDecisionEvidenceRef(
          invalidRow,
          manifest,
          contract
        ),
      P3aBridgeError
    );
  }
});

test("CSV 解析保持冻结表头并拒绝列漂移", () => {
  const parsed = parseP3aCsv(csv([snapshotRow()]));
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], snapshotRow());
  assert.throws(
    () =>
      parseP3aCsv(
        csv([snapshotRow()]).replace(
          "schema_version,snapshot_key",
          "schema_version,unknown"
        )
      ),
    P3aBridgeError
  );
});

test("真实审计入口只返回聚合摘要并固定 2024/2025 拆分", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "cmooc-p4a-protocol-")
  );
  try {
    const contract = temporalContract();
    const manifest = snapshotManifest(contract.contract_hash, 2);
    const auditDirectory = join(directory, "audit-v2");
    await mkdir(auditDirectory);
    await Promise.all([
      writeFile(
        join(directory, "manifest.json"),
        JSON.stringify(manifest),
        "utf8"
      ),
      writeFile(
        join(auditDirectory, "temporal-contract.json"),
        JSON.stringify(contract),
        "utf8"
      ),
      writeFile(
        join(directory, "decision_snapshots.csv"),
        csv([snapshotRow(2024), snapshotRow(2025)]),
        "utf8"
      )
    ]);
    const summary = await auditP3aDecisionArtifacts(directory);
    assert.equal(summary.rowCount, 2);
    assert.equal(summary.developmentCount, 1);
    assert.equal(summary.timeHoldoutCount, 1);
    assert.equal(summary.fixedDecisionLagHours, 22);
    assert.equal(summary.fixedOutcomeEndHours, 86);
    assert.equal(summary.containsForumText, false);
    assert.equal(summary.networkUsed, false);
    assert.equal(summary.writesPerformed, false);
    assert.equal(
      JSON.stringify(summary).includes("snapshot_key"),
      false
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
