#!/usr/bin/env python3
"""Read-only successor evaluation for the frozen formal P3A artifacts.

``audit`` verifies the formal decision snapshot, split, temporal contract,
privacy flags, and the implementation hashes pinned by scheduler benchmark v2.
It never writes. ``run`` replays two outcome-blind queue resolvers, performs
determinism and future-outcome leakage controls, and writes a new local-only
research artifact directory without modifying the frozen P3A input.

This module intentionally uses only the Python standard library and the
existing standard-library-only ``research_decision`` package.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import random
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from research_decision.benchmark import evaluate_replay_benchmark
from research_decision.lyapunov_policy import LyapunovQueuePolicy
from research_decision.policies import ConstrainedStructuralPolicy


SCHEMA_VERSION = "cmooc-connectivity-reliability-v1"
FORMAL_SNAPSHOT_SCHEMA_VERSION = "cmooc-decision-snapshot-v1"
FORMAL_BENCHMARK_SCHEMA_VERSION = "cmooc-scheduler-benchmark-v2"
DEVELOPMENT_YEAR = 2024
HOLDOUT_YEAR = 2025
DEFAULT_BUDGETS = (1, 3, 5)
DEFAULT_BOOTSTRAP_SEED = 20260830
DEFAULT_BOOTSTRAP_REPETITIONS = 2000
MINIMUM_BOOTSTRAP_REPETITIONS = 1000
MAX_SELECTION_DELAY_MINUTES = 30.0
GRAPH_NOT_EVALUABLE_STATUS = (
    "not_evaluable_no_asof_actor_edge_sidecar"
)
DECISION_USE = "research_only"
OBSERVATION_BOUNDARY = (
    "historical natural-interaction scheduling replay only; estimates and "
    "bootstrap intervals are descriptive associations, not causal "
    "intervention effects, learning effects, or educational effects"
)

FORMAL_CORE_MODULES = ("benchmark", "metrics", "policies", "replay")
REQUIRED_FORMAL_FIELDS = frozenset(
    {
        "schema_version",
        "snapshot_key",
        "thread_key",
        "course_key",
        "author_key",
        "year",
        "decision_at",
        "decision_date",
        "outcome_window_end_at",
        "decision_eligibility",
        "outcome_observable",
        "source_observation_end_after_decision_microseconds",
        "first_external_response_after_decision_microseconds",
        "organic_external_response_in_window",
        "external_response_count_in_window",
        "unique_external_responder_count_in_window",
        "support_gap_at_horizon",
    }
)
FORBIDDEN_FORMAL_FIELD_NAMES = frozenset(
    {
        "body",
        "content",
        "forum_body",
        "forum_content",
        "forum_text",
        "post_text",
        "reply_text",
        "raw_id",
        "raw_platform_id",
        "platform_id",
        "post_id",
        "comment_id",
        "user_id",
    }
)

# These profiles are declared before reading either split. Only their 2024
# actions are evaluated below; 2025 is never used to select among them.
LYAPUNOV_PROFILES: tuple[tuple[str, Mapping[str, Any]], ...] = (
    (
        "conservative",
        {
            "utility_weight": 1.0,
            "exposure_deficit_weight": 6.0,
            "repeat_1d_penalty": 20.0,
            "repeat_7d_penalty": 10.0,
            "observation_debt_penalty": 16.0,
        },
    ),
    (
        "balanced",
        {
            "utility_weight": 1.0,
            "exposure_deficit_weight": 8.0,
            "repeat_1d_penalty": 14.0,
            "repeat_7d_penalty": 7.0,
            "observation_debt_penalty": 10.0,
        },
    ),
    (
        "equity",
        {
            "utility_weight": 0.75,
            "exposure_deficit_weight": 16.0,
            "repeat_1d_penalty": 14.0,
            "repeat_7d_penalty": 7.0,
            "observation_debt_penalty": 10.0,
        },
    ),
)

ACTION_FIELDS = (
    "run_scope",
    "profile",
    "year",
    "split",
    "policy",
    "daily_budget_k",
    "snapshot_key",
    "thread_key",
    "course_key",
    "author_key",
    "decision_at",
    "tick_at",
    "selection_delay_minutes",
    "selection_rank_at_tick",
)


class ConnectivityReliabilityError(RuntimeError):
    """Stable, non-sensitive failure for audit or successor generation."""

    def __init__(self, code: str, detail: str | None = None):
        self.code = str(code)
        self.detail = str(detail) if detail else None
        super().__init__(
            self.code if self.detail is None else f"{self.code}:{self.detail}"
        )


def _default_input_root() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        base = Path(local_app_data)
    else:
        base = Path.home() / "AppData" / "Local"
    return base / "cmooc-research" / "p3a" / "decision-snapshot-v1"


def _canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _canonical_hash(value: Any) -> str:
    return hashlib.sha256(_canonical_json_bytes(value)).hexdigest()


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise ConnectivityReliabilityError(
            "SOURCE_FILE_READ_FAILED", path.name
        ) from exc
    return digest.hexdigest()


def _read_json(path: Path, *, code: str) -> dict[str, Any]:
    if not path.is_file():
        raise ConnectivityReliabilityError(code, path.name)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ConnectivityReliabilityError(code, path.name) from exc
    if not isinstance(value, dict):
        raise ConnectivityReliabilityError(code, path.name)
    return value


def _parse_datetime(value: Any, *, field: str) -> datetime:
    text = str(value).strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        return datetime.fromisoformat(text)
    except (TypeError, ValueError) as exc:
        raise ConnectivityReliabilityError(
            "INVALID_FORMAL_DATETIME", field
        ) from exc


def _read_formal_csv(
    path: Path,
    *,
    expected_sha256: str | None = None,
) -> tuple[tuple[str, ...], list[dict[str, str]]]:
    if not path.is_file():
        raise ConnectivityReliabilityError(
            "DECISION_SNAPSHOTS_REQUIRED", path.name
        )
    try:
        payload = path.read_bytes()
        if (
            expected_sha256 is not None
            and _sha256_bytes(payload) != str(expected_sha256)
        ):
            raise ConnectivityReliabilityError(
                "DECISION_SNAPSHOT_CHANGED_AFTER_AUDIT"
            )
        with io.StringIO(
            payload.decode("utf-8-sig"), newline=""
        ) as handle:
            reader = csv.DictReader(handle)
            fields = tuple(reader.fieldnames or ())
            rows = list(reader)
    except (OSError, UnicodeError, csv.Error) as exc:
        raise ConnectivityReliabilityError(
            "DECISION_SNAPSHOT_CSV_INVALID", path.name
        ) from exc
    if not fields or not rows:
        raise ConnectivityReliabilityError("DECISION_SNAPSHOT_CSV_EMPTY")
    if any(None in row for row in rows):
        raise ConnectivityReliabilityError(
            "DECISION_SNAPSHOT_CSV_EXTRA_COLUMNS"
        )
    return fields, rows


def _formal_core_hashes() -> dict[str, str]:
    module_dir = Path(__file__).resolve().parent / "research_decision"
    return {
        name: _sha256_file(module_dir / f"{name}.py")
        for name in FORMAL_CORE_MODULES
    }


def _successor_implementation_hashes() -> dict[str, str]:
    script_dir = Path(__file__).resolve().parent
    return {
        "connectivity_reliability": _sha256_file(Path(__file__).resolve()),
        "lyapunov_policy": _sha256_file(
            script_dir / "research_decision" / "lyapunov_policy.py"
        ),
    }


def _require_false(value: Any, code: str) -> None:
    if value is not False:
        raise ConnectivityReliabilityError(code)


def _validate_temporal_contract(
    input_root: Path,
    manifest: Mapping[str, Any],
) -> dict[str, str]:
    temporal = manifest.get("temporal_contract")
    if not isinstance(temporal, Mapping):
        raise ConnectivityReliabilityError(
            "TEMPORAL_CONTRACT_BINDING_MISSING"
        )
    if temporal.get("decision_clock_audit_status") != "passed":
        raise ConnectivityReliabilityError(
            "DECISION_CLOCK_AUDIT_NOT_PASSED"
        )

    contract_path = input_root / "audit-v2" / "temporal-contract.json"
    audit_path = input_root / "audit-v2" / "decision-clock-audit.json"
    contract = _read_json(
        contract_path, code="TEMPORAL_CONTRACT_INVALID"
    )
    audit = _read_json(audit_path, code="DECISION_CLOCK_AUDIT_INVALID")

    expected_schema = temporal.get("schema_version")
    expected_hash = temporal.get("contract_hash")
    if (
        not isinstance(expected_schema, str)
        or not isinstance(expected_hash, str)
        or len(expected_hash) != 64
    ):
        raise ConnectivityReliabilityError(
            "TEMPORAL_CONTRACT_BINDING_INVALID"
        )
    if contract.get("schema_version") != expected_schema:
        raise ConnectivityReliabilityError(
            "TEMPORAL_CONTRACT_SCHEMA_MISMATCH"
        )
    if contract.get("contract_hash") != expected_hash:
        raise ConnectivityReliabilityError(
            "TEMPORAL_CONTRACT_HASH_MISMATCH"
        )
    _require_false(
        contract.get("contains_row_level_data"),
        "TEMPORAL_CONTRACT_ROW_DATA_FLAG_INVALID",
    )
    if audit.get("status") != "passed":
        raise ConnectivityReliabilityError(
            "DECISION_CLOCK_AUDIT_NOT_PASSED"
        )
    if int(audit.get("violation_count", -1)) != 0:
        raise ConnectivityReliabilityError(
            "DECISION_CLOCK_AUDIT_HAS_VIOLATIONS"
        )
    if audit.get("contract_schema_version") != expected_schema:
        raise ConnectivityReliabilityError(
            "DECISION_CLOCK_AUDIT_SCHEMA_MISMATCH"
        )
    if audit.get("contract_hash") != expected_hash:
        raise ConnectivityReliabilityError(
            "DECISION_CLOCK_AUDIT_CONTRACT_HASH_MISMATCH"
        )
    _require_false(
        audit.get("contains_row_level_data"),
        "DECISION_CLOCK_AUDIT_ROW_DATA_FLAG_INVALID",
    )

    hashes = {
        "temporal_contract_json_sha256": _sha256_file(contract_path),
        "decision_clock_audit_json_sha256": _sha256_file(audit_path),
    }
    optional_audits = (
        (
            "point_in_time_oracle_status",
            "point-in-time-oracle.json",
            "POINT_IN_TIME_ORACLE_NOT_PASSED",
            "point_in_time_oracle_json_sha256",
        ),
        (
            "history_feature_audit_status",
            "history-feature-audit.json",
            "HISTORY_FEATURE_AUDIT_NOT_PASSED",
            "history_feature_audit_json_sha256",
        ),
    )
    for binding, filename, error_code, hash_name in optional_audits:
        if binding not in temporal:
            continue
        if temporal.get(binding) != "passed":
            raise ConnectivityReliabilityError(error_code)
        optional_path = input_root / "audit-v2" / filename
        optional = _read_json(optional_path, code=error_code)
        if optional.get("status") != "passed":
            raise ConnectivityReliabilityError(error_code)
        hashes[hash_name] = _sha256_file(optional_path)
    return hashes


def audit_formal_artifacts(input_root: Path | str) -> dict[str, Any]:
    """Verify the frozen formal P3A input without writing any file."""

    root = Path(input_root).expanduser().resolve()
    manifest_path = root / "manifest.json"
    snapshot_path = root / "decision_snapshots.csv"
    replay_manifest_path = root / "benchmark-v2" / "replay-manifest.json"
    formal_metrics_path = root / "benchmark-v2" / "metrics.json"
    formal_actions_path = root / "benchmark-v2" / "actions.csv"
    manifest = _read_json(manifest_path, code="FORMAL_MANIFEST_INVALID")
    replay_manifest = _read_json(
        replay_manifest_path, code="REPLAY_MANIFEST_INVALID"
    )

    if manifest.get("schema_version") != FORMAL_SNAPSHOT_SCHEMA_VERSION:
        raise ConnectivityReliabilityError(
            "FORMAL_SNAPSHOT_SCHEMA_VERSION_MISMATCH"
        )
    if replay_manifest.get("schema_version") != FORMAL_BENCHMARK_SCHEMA_VERSION:
        raise ConnectivityReliabilityError(
            "FORMAL_BENCHMARK_SCHEMA_VERSION_MISMATCH"
        )

    snapshot_sha = _sha256_file(snapshot_path)
    artifact_hashes = replay_manifest.get("artifact_file_hashes")
    expected_snapshot_sha = (
        artifact_hashes.get("decision_snapshots_csv_sha256")
        if isinstance(artifact_hashes, Mapping)
        else None
    )
    if not isinstance(expected_snapshot_sha, str) or len(expected_snapshot_sha) != 64:
        raise ConnectivityReliabilityError(
            "DECISION_SNAPSHOT_SHA256_BINDING_MISSING"
        )
    if snapshot_sha != expected_snapshot_sha:
        raise ConnectivityReliabilityError(
            "DECISION_SNAPSHOT_SHA256_MISMATCH"
        )
    formal_artifact_paths = (
        (
            "metrics_json_sha256",
            formal_metrics_path,
            "FORMAL_METRICS_SHA256_MISMATCH",
        ),
        (
            "actions_csv_sha256",
            formal_actions_path,
            "FORMAL_ACTIONS_SHA256_MISMATCH",
        ),
    )
    formal_benchmark_hashes: dict[str, str] = {}
    for hash_name, artifact_path, error_code in formal_artifact_paths:
        expected_hash = artifact_hashes.get(hash_name)
        if not isinstance(expected_hash, str) or len(expected_hash) != 64:
            raise ConnectivityReliabilityError(
                "FORMAL_BENCHMARK_SHA256_BINDING_MISSING", hash_name
            )
        actual_hash = _sha256_file(artifact_path)
        if actual_hash != expected_hash:
            raise ConnectivityReliabilityError(error_code)
        formal_benchmark_hashes[hash_name] = actual_hash

    formal_fields = manifest.get("formal_fields")
    if not isinstance(formal_fields, list) or not all(
        isinstance(item, str) and item for item in formal_fields
    ):
        raise ConnectivityReliabilityError("FORMAL_SCHEMA_INVALID")
    if len(formal_fields) != len(set(formal_fields)):
        raise ConnectivityReliabilityError("FORMAL_SCHEMA_DUPLICATE_FIELDS")
    missing = sorted(REQUIRED_FORMAL_FIELDS - set(formal_fields))
    if missing:
        raise ConnectivityReliabilityError(
            "FORMAL_SCHEMA_REQUIRED_FIELDS_MISSING", ",".join(missing)
        )
    forbidden = sorted(
        field
        for field in formal_fields
        if field.casefold() in FORBIDDEN_FORMAL_FIELD_NAMES
        or field.casefold().startswith("raw_")
    )
    if forbidden:
        raise ConnectivityReliabilityError(
            "FORBIDDEN_FORMAL_FIELDS", ",".join(forbidden)
        )

    fields, rows = _read_formal_csv(
        snapshot_path, expected_sha256=snapshot_sha
    )
    if fields != tuple(formal_fields):
        raise ConnectivityReliabilityError("FORMAL_SCHEMA_HEADER_MISMATCH")
    try:
        declared_row_count = int(manifest.get("row_count", -1))
    except (TypeError, ValueError) as exc:
        raise ConnectivityReliabilityError(
            "FORMAL_ROW_COUNT_INVALID"
        ) from exc
    if declared_row_count != len(rows):
        raise ConnectivityReliabilityError("FORMAL_ROW_COUNT_MISMATCH")

    split_policy = manifest.get("split_policy")
    expected_split = {
        "development_year": DEVELOPMENT_YEAR,
        "time_holdout_year": HOLDOUT_YEAR,
    }
    if split_policy != expected_split:
        raise ConnectivityReliabilityError("FORMAL_SPLIT_POLICY_MISMATCH")

    split_counts: Counter[int] = Counter()
    seen_keys: set[str] = set()
    for row in rows:
        if row.get("schema_version") != FORMAL_SNAPSHOT_SCHEMA_VERSION:
            raise ConnectivityReliabilityError(
                "FORMAL_ROW_SCHEMA_VERSION_MISMATCH"
            )
        key = str(row.get("snapshot_key", "")).strip()
        if not key:
            raise ConnectivityReliabilityError("FORMAL_SNAPSHOT_KEY_MISSING")
        if key in seen_keys:
            raise ConnectivityReliabilityError(
                "FORMAL_DUPLICATE_SNAPSHOT_KEY"
            )
        seen_keys.add(key)
        try:
            year = int(row.get("year", 0))
        except (TypeError, ValueError) as exc:
            raise ConnectivityReliabilityError(
                "FORMAL_ROW_YEAR_INVALID"
            ) from exc
        if year not in expected_split.values():
            raise ConnectivityReliabilityError(
                "FORMAL_ROW_OUTSIDE_FROZEN_SPLIT"
            )
        decision_at = _parse_datetime(
            row.get("decision_at"), field="decision_at"
        )
        if str(row.get("decision_date")) != decision_at.date().isoformat():
            raise ConnectivityReliabilityError(
                "FORMAL_DECISION_DATE_CLOCK_MISMATCH"
            )
        if "asof_boundary_ok" in row and str(
            row.get("asof_boundary_ok", "")
        ) not in {"1", "1.0", "True", "true"}:
            raise ConnectivityReliabilityError(
                "FORMAL_ASOF_BOUNDARY_NOT_OK"
            )
        split_counts[year] += 1
    if any(split_counts.get(year, 0) <= 0 for year in expected_split.values()):
        raise ConnectivityReliabilityError("FORMAL_SPLIT_EMPTY")

    privacy = manifest.get("privacy")
    if not isinstance(privacy, Mapping):
        raise ConnectivityReliabilityError("FORMAL_PRIVACY_FLAGS_MISSING")
    _require_false(
        privacy.get("forum_text_written"),
        "FORMAL_FORUM_TEXT_FLAG_INVALID",
    )
    _require_false(
        privacy.get("raw_platform_ids_written_to_formal_outputs"),
        "FORMAL_RAW_PLATFORM_ID_FLAG_INVALID",
    )
    _require_false(
        replay_manifest.get("contains_forum_text"),
        "REPLAY_FORUM_TEXT_FLAG_INVALID",
    )
    _require_false(
        replay_manifest.get("contains_raw_platform_ids"),
        "REPLAY_RAW_PLATFORM_ID_FLAG_INVALID",
    )

    temporal_hashes = _validate_temporal_contract(root, manifest)
    pinned_hashes = replay_manifest.get("implementation_hashes")
    if not isinstance(pinned_hashes, Mapping):
        raise ConnectivityReliabilityError(
            "FORMAL_CORE_IMPLEMENTATION_HASHES_MISSING"
        )
    actual_core_hashes = _formal_core_hashes()
    for name, actual in actual_core_hashes.items():
        if pinned_hashes.get(name) != actual:
            raise ConnectivityReliabilityError(
                "FORMAL_CORE_IMPLEMENTATION_HASH_MISMATCH", name
            )

    source_hashes = {
        "decision_snapshots_csv_sha256": snapshot_sha,
        "formal_manifest_json_sha256": _sha256_file(manifest_path),
        "formal_replay_manifest_json_sha256": _sha256_file(
            replay_manifest_path
        ),
        "formal_metrics_json_sha256": formal_benchmark_hashes[
            "metrics_json_sha256"
        ],
        "formal_actions_csv_sha256": formal_benchmark_hashes[
            "actions_csv_sha256"
        ],
        **temporal_hashes,
    }
    return {
        "ok": True,
        "command": "audit",
        "schema_version": SCHEMA_VERSION,
        "network_used": False,
        "files_written": 0,
        "row_count": len(rows),
        "split_policy": expected_split,
        "split_row_counts": {
            str(year): split_counts[year] for year in sorted(split_counts)
        },
        "formal_schema_version": FORMAL_SNAPSHOT_SCHEMA_VERSION,
        "formal_benchmark_schema_version": FORMAL_BENCHMARK_SCHEMA_VERSION,
        "temporal_contract_schema_version": manifest["temporal_contract"][
            "schema_version"
        ],
        "source_artifact_hashes": source_hashes,
        "formal_pinned_core_implementation_hashes": actual_core_hashes,
        "contains_forum_text": False,
        "contains_raw_platform_ids": False,
        "decision_use": DECISION_USE,
        "observation_only_boundary": OBSERVATION_BOUNDARY,
    }


def load_formal_records(
    input_root: Path | str,
    *,
    expected_sha256: str | None = None,
) -> list[dict[str, str]]:
    """Load rows after a caller has completed :func:`audit_formal_artifacts`."""

    _, rows = _read_formal_csv(
        Path(input_root).expanduser().resolve() / "decision_snapshots.csv",
        expected_sha256=expected_sha256,
    )
    return rows


def _without_action_log(result: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in result.items() if key != "action_log"}


def _run_main_benchmark(
    records: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    return evaluate_replay_benchmark(
        records,
        budgets=DEFAULT_BUDGETS,
        policies=(
            ConstrainedStructuralPolicy(),
            LyapunovQueuePolicy(),
        ),
        tick_minutes=30,
        max_actions_per_tick=1,
    )


def _perturb_future_outcomes(
    records: Sequence[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], tuple[int, ...]]:
    changed: list[dict[str, Any]] = []
    changed_years: set[int] = set()
    for source in records:
        row = dict(source)
        if (
            row.get("decision_eligibility") == "eligible_unanswered"
            and int(row.get("outcome_observable", 0) or 0) == 1
            and int(row.get("year", 0)) in (DEVELOPMENT_YEAR, HOLDOUT_YEAR)
        ):
            prior_gap = int(row.get("support_gap_at_horizon", 0) or 0)
            new_gap = 1 - prior_gap
            row["support_gap_at_horizon"] = new_gap
            row["organic_external_response_in_window"] = 1 - new_gap
            row["external_response_count_in_window"] = 1 - new_gap
            row["unique_external_responder_count_in_window"] = 1 - new_gap
            changed_years.add(int(row["year"]))
        changed.append(row)
    if not changed_years:
        raise ConnectivityReliabilityError(
            "NO_EVALUABLE_FUTURE_OUTCOMES_TO_PERTURB"
        )
    return changed, tuple(sorted(changed_years))


def _input_hashes_by_year(
    result: Mapping[str, Any],
) -> dict[int, Mapping[str, Any]]:
    return {
        int(item["year"]): item
        for item in result.get("input_hashes_by_year", [])
    }


def verify_determinism_and_outcome_isolation(
    records: Sequence[Mapping[str, Any]],
    baseline: Mapping[str, Any],
) -> dict[str, Any]:
    """Run reversed-input and future-outcome negative controls."""

    reversed_result = _run_main_benchmark(list(reversed(records)))
    reverse_checks = {
        "policy_replay_input_hash_match": (
            baseline["policy_replay_input_hash"]
            == reversed_result["policy_replay_input_hash"]
        ),
        "benchmark_input_hash_match": (
            baseline["benchmark_input_hash"]
            == reversed_result["benchmark_input_hash"]
        ),
        "action_log_hash_match": (
            baseline["action_log_hash"]
            == reversed_result["action_log_hash"]
        ),
        "metrics_result_hash_match": (
            baseline["metrics_result_hash"]
            == reversed_result["metrics_result_hash"]
        ),
        "run_action_hashes_match": (
            [item["action_hash"] for item in baseline["run_summaries"]]
            == [
                item["action_hash"]
                for item in reversed_result["run_summaries"]
            ]
        ),
    }
    if not all(reverse_checks.values()):
        raise ConnectivityReliabilityError(
            "REVERSED_INPUT_DETERMINISM_FAILED"
        )

    perturbed_records, changed_years = _perturb_future_outcomes(records)
    perturbed = _run_main_benchmark(perturbed_records)
    baseline_years = _input_hashes_by_year(baseline)
    perturbed_years = _input_hashes_by_year(perturbed)
    policy_hashes_unchanged = all(
        baseline_years[year]["policy_input_hash"]
        == perturbed_years[year]["policy_input_hash"]
        for year in changed_years
    )
    replay_hashes_unchanged = all(
        baseline_years[year]["replay_state_event_hash"]
        == perturbed_years[year]["replay_state_event_hash"]
        for year in changed_years
    )
    evaluation_hashes_changed = all(
        baseline_years[year]["evaluation_outcome_hash"]
        != perturbed_years[year]["evaluation_outcome_hash"]
        for year in changed_years
    )
    outcome_checks = {
        "perturbed_years": list(changed_years),
        "policy_input_hashes_unchanged": policy_hashes_unchanged,
        "replay_state_event_hashes_unchanged": replay_hashes_unchanged,
        "policy_replay_input_hash_unchanged": (
            baseline["policy_replay_input_hash"]
            == perturbed["policy_replay_input_hash"]
        ),
        "action_log_hash_unchanged": (
            baseline["action_log_hash"] == perturbed["action_log_hash"]
        ),
        "evaluation_outcome_hashes_changed": evaluation_hashes_changed,
        "benchmark_input_hash_changed": (
            baseline["benchmark_input_hash"]
            != perturbed["benchmark_input_hash"]
        ),
        "metrics_result_hash_changed": (
            baseline["metrics_result_hash"]
            != perturbed["metrics_result_hash"]
        ),
    }
    required_outcome_checks = (
        policy_hashes_unchanged,
        replay_hashes_unchanged,
        outcome_checks["policy_replay_input_hash_unchanged"],
        outcome_checks["action_log_hash_unchanged"],
        evaluation_hashes_changed,
        outcome_checks["benchmark_input_hash_changed"],
        outcome_checks["metrics_result_hash_changed"],
    )
    if not all(required_outcome_checks):
        raise ConnectivityReliabilityError(
            "FUTURE_OUTCOME_ISOLATION_FAILED"
        )
    return {
        "status": "passed",
        "reversed_input_duplicate": {
            "status": "passed",
            **reverse_checks,
        },
        "future_outcome_perturbation": {
            "status": "passed",
            **outcome_checks,
        },
    }


def _profile_policy(profile: str, parameters: Mapping[str, Any]) -> object:
    return LyapunovQueuePolicy(
        **dict(parameters),
        name=f"lyapunov_profile_{profile}",
    )


def _jaccard(left: set[str], right: set[str]) -> float:
    union = left | right
    return len(left & right) / len(union) if union else 1.0


def run_development_profile_sensitivity(
    records: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Evaluate three predeclared Lyapunov profiles on 2024 only."""

    development = [
        row for row in records if int(row.get("year", 0)) == DEVELOPMENT_YEAR
    ]
    if not development:
        raise ConnectivityReliabilityError("DEVELOPMENT_SPLIT_EMPTY")
    policies = tuple(
        _profile_policy(profile, parameters)
        for profile, parameters in LYAPUNOV_PROFILES
    )
    result = evaluate_replay_benchmark(
        development,
        budgets=DEFAULT_BUDGETS,
        policies=policies,
        tick_minutes=30,
        max_actions_per_tick=1,
    )
    actions = list(result["action_log"])
    if any(int(item["year"]) != DEVELOPMENT_YEAR for item in actions):
        raise ConnectivityReliabilityError(
            "HOLDOUT_USED_IN_PARAMETER_SENSITIVITY"
        )

    profile_names = [profile for profile, _ in LYAPUNOV_PROFILES]
    sets: dict[tuple[str, int], set[str]] = {}
    for profile in profile_names:
        policy_name = f"lyapunov_profile_{profile}"
        for budget in DEFAULT_BUDGETS:
            sets[(profile, budget)] = {
                str(item["snapshot_key"])
                for item in actions
                if item["policy"] == policy_name
                and int(item["daily_budget_k"]) == budget
            }
    comparisons: list[dict[str, Any]] = []
    for left_index, left in enumerate(profile_names):
        for right in profile_names[left_index + 1 :]:
            for budget in DEFAULT_BUDGETS:
                left_set = sets[(left, budget)]
                right_set = sets[(right, budget)]
                comparisons.append(
                    {
                        "left_profile": left,
                        "right_profile": right,
                        "daily_budget_k": budget,
                        "left_action_count": len(left_set),
                        "right_action_count": len(right_set),
                        "intersection_count": len(left_set & right_set),
                        "union_count": len(left_set | right_set),
                        "action_set_jaccard": _jaccard(
                            left_set, right_set
                        ),
                    }
                )

    summary = {
        "status": "completed_development_only",
        "parameter_declaration": "predeclared_before_split_evaluation",
        "selection_year": DEVELOPMENT_YEAR,
        "holdout_year": HOLDOUT_YEAR,
        "holdout_used_for_parameter_choice": False,
        "profiles": [
            {"profile": profile, **dict(parameters)}
            for profile, parameters in LYAPUNOV_PROFILES
        ],
        "pairwise_action_set_jaccard_by_budget": comparisons,
        "benchmark": _without_action_log(result),
    }
    return summary, actions


def _action_scope_rows(
    actions: Iterable[Mapping[str, Any]],
    *,
    run_scope: str,
    profile_by_policy: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    profile_lookup = dict(profile_by_policy or {})
    return [
        {
            "run_scope": run_scope,
            "profile": profile_lookup.get(str(item["policy"]), ""),
            **{field: item[field] for field in ACTION_FIELDS[2:]},
        }
        for item in actions
    ]


def verify_action_constraints(
    actions: Sequence[Mapping[str, Any]],
    *,
    max_actions_per_tick: int = 1,
    ttl_minutes: float = MAX_SELECTION_DELAY_MINUTES,
) -> dict[str, Any]:
    """Count all mechanical replay violations over emitted actions."""

    daily: Counter[tuple[Any, ...]] = Counter()
    ticks: Counter[tuple[Any, ...]] = Counter()
    snapshots: Counter[tuple[Any, ...]] = Counter()
    before_decision = 0
    ttl_over = 0
    ttl_at_or_after = 0
    for item in actions:
        tick_at = _parse_datetime(item.get("tick_at"), field="tick_at")
        decision_at = _parse_datetime(
            item.get("decision_at"), field="decision_at"
        )
        scope = str(item.get("run_scope", "main_benchmark"))
        year = int(item["year"])
        policy = str(item["policy"])
        budget = int(item["daily_budget_k"])
        base = (scope, year, policy, budget)
        daily[(*base, tick_at.date().isoformat())] += 1
        ticks[(*base, tick_at.isoformat())] += 1
        snapshots[(*base, str(item["snapshot_key"]))] += 1
        delay = (tick_at - decision_at).total_seconds() / 60.0
        if delay < 0:
            before_decision += 1
        if delay > float(ttl_minutes):
            ttl_over += 1
        if delay >= float(ttl_minutes):
            ttl_at_or_after += 1

    daily_violations = sum(
        1 for key, count in daily.items() if count > int(key[3])
    )
    per_tick_violations = sum(
        1 for count in ticks.values() if count > int(max_actions_per_tick)
    )
    duplicate_violations = sum(
        max(0, count - 1) for count in snapshots.values()
    )
    counts = {
        "daily_budget_violation_count": daily_violations,
        "per_tick_violation_count": per_tick_violations,
        "duplicate_action_violation_count": duplicate_violations,
        "selection_before_decision_violation_count": before_decision,
        "ttl_over_30_minutes_violation_count": ttl_over,
        "ttl_at_or_after_30_minutes_violation_count": ttl_at_or_after,
    }
    return {
        "status": (
            "passed" if not any(counts.values()) else "failed"
        ),
        "action_count": len(actions),
        "daily_budget_unit": "platform-calendar tick date",
        "max_actions_per_tick": int(max_actions_per_tick),
        "candidate_ttl_minutes": float(ttl_minutes),
        **counts,
    }


def _quantile(values: Sequence[float], probability: float) -> float:
    if not values:
        raise ConnectivityReliabilityError("BOOTSTRAP_REPLICATES_EMPTY")
    ordered = sorted(float(value) for value in values)
    position = (len(ordered) - 1) * float(probability)
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def _bootstrap_seed(base_seed: int, budget: int) -> int:
    digest = hashlib.sha256(
        f"{int(base_seed)}:decision-date:{int(budget)}".encode("ascii")
    ).digest()
    return int.from_bytes(digest[:8], "big", signed=False)


def decision_date_block_bootstrap(
    records: Sequence[Mapping[str, Any]],
    actions: Sequence[Mapping[str, Any]],
    *,
    constrained_policy: str = "constrained_structural",
    lyapunov_policy: str = "lyapunov_queue_shadow_v1",
    budgets: Sequence[int] = DEFAULT_BUDGETS,
    seed: int = DEFAULT_BOOTSTRAP_SEED,
    repetitions: int = DEFAULT_BOOTSTRAP_REPETITIONS,
) -> dict[str, Any]:
    """Bootstrap 2025 selected support-gap proportions by decision date.

    The same resampled date blocks are used for both policies, so the
    Lyapunov-minus-constrained interval is paired. Undefined zero-denominator
    draws are deterministically redrawn and reported.
    """

    repetitions = int(repetitions)
    if repetitions < MINIMUM_BOOTSTRAP_REPETITIONS:
        raise ConnectivityReliabilityError(
            "BOOTSTRAP_REPETITIONS_BELOW_MINIMUM"
        )
    normalized_budgets = tuple(sorted({int(value) for value in budgets}))
    holdout = [
        row
        for row in records
        if int(row.get("year", 0)) == HOLDOUT_YEAR
        and row.get("decision_eligibility") == "eligible_unanswered"
    ]
    by_key = {str(row["snapshot_key"]): row for row in holdout}
    rows_by_day: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in holdout:
        rows_by_day[str(row["decision_date"])].append(row)
    evaluable_days = tuple(
        sorted(
            day
            for day, day_rows in rows_by_day.items()
            if all(
                int(row.get("outcome_observable", 0) or 0) == 1
                for row in day_rows
            )
        )
    )

    results: list[dict[str, Any]] = []
    for budget in normalized_budgets:
        block_counts: dict[str, dict[str, tuple[int, int]]] = {
            day: {
                constrained_policy: (0, 0),
                lyapunov_policy: (0, 0),
            }
            for day in evaluable_days
        }
        for action in actions:
            if int(action.get("year", 0)) != HOLDOUT_YEAR:
                continue
            if int(action.get("daily_budget_k", 0)) != budget:
                continue
            policy = str(action.get("policy"))
            if policy not in (constrained_policy, lyapunov_policy):
                continue
            key = str(action.get("snapshot_key"))
            if key not in by_key:
                raise ConnectivityReliabilityError(
                    "BOOTSTRAP_ACTION_NOT_IN_HOLDOUT", key
                )
            row = by_key[key]
            day = str(row["decision_date"])
            if day not in block_counts:
                continue
            gap = int(row.get("support_gap_at_horizon", 0) or 0)
            prior_gap, prior_count = block_counts[day][policy]
            block_counts[day][policy] = (
                prior_gap + gap,
                prior_count + 1,
            )

        totals: dict[str, tuple[int, int]] = {}
        for policy in (constrained_policy, lyapunov_policy):
            gaps = sum(block_counts[day][policy][0] for day in evaluable_days)
            count = sum(block_counts[day][policy][1] for day in evaluable_days)
            totals[policy] = (gaps, count)

        if not evaluable_days or any(
            totals[policy][1] == 0
            for policy in (constrained_policy, lyapunov_policy)
        ):
            results.append(
                {
                    "daily_budget_k": budget,
                    "status": "not_evaluable_no_selected_holdout_actions",
                    "evaluable_decision_date_count": len(evaluable_days),
                }
            )
            continue

        derived_seed = _bootstrap_seed(seed, budget)
        generator = random.Random(derived_seed)
        policy_samples: dict[str, list[float]] = {
            constrained_policy: [],
            lyapunov_policy: [],
        }
        differences: list[float] = []
        redrawn_zero_denominator_count = 0
        attempts = 0
        maximum_attempts = max(repetitions * 100, repetitions + 1000)
        while len(differences) < repetitions and attempts < maximum_attempts:
            attempts += 1
            sampled_days = [
                evaluable_days[generator.randrange(len(evaluable_days))]
                for _ in range(len(evaluable_days))
            ]
            proportions: dict[str, float] = {}
            valid = True
            for policy in (constrained_policy, lyapunov_policy):
                gap_count = sum(
                    block_counts[day][policy][0] for day in sampled_days
                )
                selected_count = sum(
                    block_counts[day][policy][1] for day in sampled_days
                )
                if selected_count == 0:
                    valid = False
                    break
                proportions[policy] = gap_count / selected_count
            if not valid:
                redrawn_zero_denominator_count += 1
                continue
            for policy, proportion in proportions.items():
                policy_samples[policy].append(proportion)
            differences.append(
                proportions[lyapunov_policy]
                - proportions[constrained_policy]
            )
        if len(differences) != repetitions:
            raise ConnectivityReliabilityError(
                "BOOTSTRAP_VALID_REPLICATES_INSUFFICIENT"
            )

        policy_output: dict[str, Any] = {}
        estimates: dict[str, float] = {}
        for policy in (constrained_policy, lyapunov_policy):
            gaps, selected = totals[policy]
            estimate = gaps / selected
            estimates[policy] = estimate
            samples = policy_samples[policy]
            policy_output[policy] = {
                "selected_support_gap_count": gaps,
                "selected_outcome_evaluable_count": selected,
                "selected_support_gap_proportion": estimate,
                "bootstrap_95_percentile_interval": {
                    "lower": _quantile(samples, 0.025),
                    "upper": _quantile(samples, 0.975),
                },
            }
        results.append(
            {
                "daily_budget_k": budget,
                "status": "evaluated",
                "evaluable_decision_date_count": len(evaluable_days),
                "derived_seed": derived_seed,
                "valid_replicate_count": len(differences),
                "redrawn_zero_denominator_count": (
                    redrawn_zero_denominator_count
                ),
                "policies": policy_output,
                "paired_lyapunov_minus_constrained": {
                    "estimate": (
                        estimates[lyapunov_policy]
                        - estimates[constrained_policy]
                    ),
                    "bootstrap_95_percentile_interval": {
                        "lower": _quantile(differences, 0.025),
                        "upper": _quantile(differences, 0.975),
                    },
                },
            }
        )
    return {
        "schema_version": "cmooc-decision-date-block-bootstrap-v1",
        "status": "descriptive_uncertainty_not_causal_effect",
        "estimand": "selected_support_gap_proportion",
        "year": HOLDOUT_YEAR,
        "resampling_unit": "decision_date",
        "resampling_method": "nonparametric blocks with replacement",
        "confidence_interval": "95_percentile",
        "seed": int(seed),
        "repetitions": repetitions,
        "minimum_repetitions": MINIMUM_BOOTSTRAP_REPETITIONS,
        "paired_comparison": (
            f"{lyapunov_policy}_minus_{constrained_policy}"
        ),
        "interpretation_boundary": OBSERVATION_BOUNDARY,
        "by_budget": results,
    }


def _holdout_main_result_table(
    records: Sequence[Mapping[str, Any]],
    benchmark: Mapping[str, Any],
) -> list[dict[str, Any]]:
    eligible = [
        row
        for row in records
        if int(row.get("year", 0)) == HOLDOUT_YEAR
        and row.get("decision_eligibility") == "eligible_unanswered"
    ]
    by_key = {str(row["snapshot_key"]): row for row in eligible}
    rows_by_day: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in eligible:
        rows_by_day[str(row["decision_date"])].append(row)
    target_days = {
        day
        for day, day_rows in rows_by_day.items()
        if all(
            int(row.get("outcome_observable", 0) or 0) == 1
            for row in day_rows
        )
    }
    actions_by_run: dict[tuple[str, int], list[Mapping[str, Any]]] = defaultdict(
        list
    )
    for action in benchmark.get("action_log", []):
        if int(action["year"]) == HOLDOUT_YEAR:
            actions_by_run[
                (str(action["policy"]), int(action["daily_budget_k"]))
            ].append(action)

    result: list[dict[str, Any]] = []
    for metric in benchmark.get("by_year", []):
        if int(metric.get("year", 0)) != HOLDOUT_YEAR:
            continue
        policy = str(metric["policy"])
        budget = int(metric["daily_budget_k"])
        run_actions = actions_by_run[(policy, budget)]
        evaluable_selected = [
            by_key[str(action["snapshot_key"])]
            for action in run_actions
            if str(action["snapshot_key"]) in by_key
            and str(by_key[str(action["snapshot_key"])]["decision_date"])
            in target_days
        ]
        selected_gap_count = sum(
            int(row.get("support_gap_at_horizon", 0) or 0)
            for row in evaluable_selected
        )
        selected_gap_proportion = (
            selected_gap_count / len(evaluable_selected)
            if evaluable_selected
            else 0.0
        )
        if abs(
            selected_gap_proportion
            - float(metric["selection_precision_yearly_micro"])
        ) > 1e-12:
            raise ConnectivityReliabilityError(
                "HOLDOUT_RESULT_TABLE_METRIC_MISMATCH"
            )
        result.append(
            {
                "year": HOLDOUT_YEAR,
                "split": "time_holdout",
                "policy": policy,
                "daily_budget_k": budget,
                "selected_count": int(metric["selected_count"]),
                "selected_outcome_evaluable_count": len(
                    evaluable_selected
                ),
                "selected_support_gap_count": selected_gap_count,
                "selected_support_gap_proportion": (
                    selected_gap_proportion
                ),
                "selection_precision_yearly_micro": float(
                    metric["selection_precision_yearly_micro"]
                ),
                "coverage": float(metric["coverage"]),
                "author_repeat_touch_rate_7d": float(
                    metric["author_repeat_touch_rate_7d"]
                ),
                "unique_author_coverage": float(
                    metric["unique_author_coverage"]
                ),
                "interpretation_boundary": OBSERVATION_BOUNDARY,
            }
        )
    return sorted(
        result,
        key=lambda item: (
            str(item["policy"]), int(item["daily_budget_k"])
        ),
    )


def _graph_boundary() -> dict[str, Any]:
    return {
        "component": "full_multiscale_connectivity_graph",
        "status": GRAPH_NOT_EVALUABLE_STATUS,
        "evaluated_precursor": "lyapunov_queue_resolver_only",
        "queue_resolver_precursor_evaluated": True,
        "full_multiscale_graph_evaluated": False,
        "reason": (
            "the formal snapshot has no decision-time actor-edge sidecar "
            "from which a leakage-safe multiscale graph can be reconstructed"
        ),
    }


def evaluate_reliability(
    records: Sequence[Mapping[str, Any]],
    audit: Mapping[str, Any],
    *,
    bootstrap_repetitions: int = DEFAULT_BOOTSTRAP_REPETITIONS,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Build all successor metrics in memory without writing artifacts."""

    main = _run_main_benchmark(records)
    reproducibility = verify_determinism_and_outcome_isolation(
        records, main
    )
    sensitivity, profile_actions = run_development_profile_sensitivity(records)
    profile_lookup = {
        f"lyapunov_profile_{profile}": profile
        for profile, _ in LYAPUNOV_PROFILES
    }
    main_actions = _action_scope_rows(
        main["action_log"], run_scope="main_benchmark"
    )
    development_actions = _action_scope_rows(
        profile_actions,
        run_scope="development_parameter_sensitivity",
        profile_by_policy=profile_lookup,
    )
    actions = sorted(
        [*main_actions, *development_actions],
        key=lambda item: (
            str(item["run_scope"]),
            int(item["year"]),
            str(item["policy"]),
            int(item["daily_budget_k"]),
            str(item["tick_at"]),
            int(item["selection_rank_at_tick"]),
            str(item["snapshot_key"]),
        ),
    )
    constraints = verify_action_constraints(actions)
    if constraints["status"] != "passed":
        raise ConnectivityReliabilityError(
            "SUCCESSOR_ACTION_CONSTRAINTS_FAILED"
        )
    bootstrap = decision_date_block_bootstrap(
        records,
        main["action_log"],
        repetitions=bootstrap_repetitions,
    )
    holdout_main_results = _holdout_main_result_table(records, main)
    graph = _graph_boundary()
    metrics = {
        "schema_version": SCHEMA_VERSION,
        "contains_forum_text": False,
        "contains_raw_platform_ids": False,
        "decision_use": DECISION_USE,
        "observation_only_boundary": OBSERVATION_BOUNDARY,
        "formal_input_audit": dict(audit),
        "main_benchmark": _without_action_log(main),
        "reproducibility_controls": reproducibility,
        "mechanical_constraint_audit": constraints,
        "development_parameter_sensitivity": sensitivity,
        "holdout_main_results": holdout_main_results,
        "holdout_descriptive_uncertainty": bootstrap,
        "graph_component": graph,
        "combined_action_log_hash": _canonical_hash(actions),
    }
    return metrics, actions


def _json_artifact_bytes(value: Mapping[str, Any]) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2)
        + "\n"
    ).encode("utf-8")


def _actions_csv_bytes(actions: Sequence[Mapping[str, Any]]) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(
        output,
        fieldnames=ACTION_FIELDS,
        extrasaction="raise",
        lineterminator="\n",
    )
    writer.writeheader()
    writer.writerows(actions)
    return output.getvalue().encode("utf-8")


def _format_float(value: Any) -> str:
    return f"{float(value):.4f}"


def _report_text(metrics: Mapping[str, Any]) -> str:
    audit = metrics["formal_input_audit"]
    constraints = metrics["mechanical_constraint_audit"]
    sensitivity = metrics["development_parameter_sensitivity"]
    holdout_results = metrics["holdout_main_results"]
    bootstrap = metrics["holdout_descriptive_uncertainty"]
    lines = [
        "# P3A connectivity reliability successor",
        "",
        "## Scope and evidence boundary",
        "",
        f"Decision use: `{DECISION_USE}`.",
        "",
        OBSERVATION_BOUNDARY + ".",
        "",
        (
            f"The frozen input audit passed for {audit['row_count']} rows: "
            f"{audit['split_row_counts'][str(DEVELOPMENT_YEAR)]} development "
            f"rows and {audit['split_row_counts'][str(HOLDOUT_YEAR)]} frozen "
            "time-holdout rows."
        ),
        "",
        "## Reproducibility and constraints",
        "",
        (
            "Reversed-input determinism and future-outcome isolation both "
            "passed. Future outcomes changed evaluation and result hashes "
            "without changing the policy-input or action hashes."
        ),
        "",
        (
            f"The combined {constraints['action_count']} emitted actions had "
            "zero daily-budget, per-tick, duplicate-action, "
            "selection-before-decision, and 30-minute TTL violations."
        ),
        "",
        "## 2025 frozen-holdout main results",
        "",
        (
            "Selected-support-gap proportion is the observed proportion of "
            "outcome-evaluable selected threads that remained without an "
            "external human response at the frozen horizon."
        ),
        "",
        "| Policy | K | Selected | Selected gaps | Selected-gap proportion | "
        "Coverage | 7d repeat | Unique-author coverage |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for item in holdout_results:
        lines.append(
            f"| {item['policy']} | {item['daily_budget_k']} | "
            f"{item['selected_count']} | "
            f"{item['selected_support_gap_count']} | "
            f"{_format_float(item['selected_support_gap_proportion'])} | "
            f"{_format_float(item['coverage'])} | "
            f"{_format_float(item['author_repeat_touch_rate_7d'])} | "
            f"{_format_float(item['unique_author_coverage'])} |"
        )
    lines.extend(
        [
        "",
        "## Predeclared 2024 Lyapunov profiles",
        "",
        (
            "Conservative, balanced/default, and equity profiles were run "
            "only on 2024. The 2025 holdout was not used to choose parameters."
        ),
        "",
        "| Profiles | K | Action-set Jaccard |",
        "|---|---:|---:|",
        ]
    )
    for item in sensitivity["pairwise_action_set_jaccard_by_budget"]:
        lines.append(
            "| "
            f"{item['left_profile']} / {item['right_profile']} | "
            f"{item['daily_budget_k']} | "
            f"{_format_float(item['action_set_jaccard'])} |"
        )
    lines.extend(
        [
            "",
            "## 2025 descriptive block-bootstrap uncertainty",
            "",
            (
                f"Intervals use {bootstrap['repetitions']} deterministic "
                f"decision-date block replicates with seed "
                f"{bootstrap['seed']}. They are descriptive, not causal."
            ),
            "",
            "| K | Constrained proportion (95% CI) | "
            "Lyapunov proportion (95% CI) | Paired difference (95% CI) |",
            "|---:|---:|---:|---:|",
        ]
    )
    for item in bootstrap["by_budget"]:
        if item["status"] != "evaluated":
            lines.append(
                f"| {item['daily_budget_k']} | not evaluable | "
                "not evaluable | not evaluable |"
            )
            continue
        policies = item["policies"]
        constrained = policies["constrained_structural"]
        lyapunov = policies["lyapunov_queue_shadow_v1"]
        difference = item["paired_lyapunov_minus_constrained"]
        c_interval = constrained["bootstrap_95_percentile_interval"]
        l_interval = lyapunov["bootstrap_95_percentile_interval"]
        d_interval = difference["bootstrap_95_percentile_interval"]
        lines.append(
            f"| {item['daily_budget_k']} | "
            f"{_format_float(constrained['selected_support_gap_proportion'])} "
            f"[{_format_float(c_interval['lower'])}, "
            f"{_format_float(c_interval['upper'])}] | "
            f"{_format_float(lyapunov['selected_support_gap_proportion'])} "
            f"[{_format_float(l_interval['lower'])}, "
            f"{_format_float(l_interval['upper'])}] | "
            f"{_format_float(difference['estimate'])} "
            f"[{_format_float(d_interval['lower'])}, "
            f"{_format_float(d_interval['upper'])}] |"
        )
    lines.extend(
        [
            "",
            "## Graph boundary",
            "",
            f"Full multiscale graph: `{GRAPH_NOT_EVALUABLE_STATUS}`.",
            "",
            (
                "Only the queue-resolver precursor is evaluated. The formal "
                "snapshot does not contain an as-of actor-edge sidecar, so a "
                "full multiscale connectivity graph cannot be evaluated "
                "without inventing or leaking graph state."
            ),
            "",
        ]
    )
    return "\n".join(lines)


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _allowed_output_root() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise ConnectivityReliabilityError(
            "LOCALAPPDATA_REQUIRED_FOR_RESEARCH_OUTPUT"
        )
    return (
        Path(local_app_data).expanduser().resolve() / "cmooc-research"
    )


def _assert_output_available(output_dir: Path, input_root: Path) -> None:
    output = output_dir.expanduser().resolve()
    source = input_root.expanduser().resolve()
    allowed_root = _allowed_output_root()
    if output == allowed_root or not _is_within(output, allowed_root):
        raise ConnectivityReliabilityError(
            "OUTPUT_OUTSIDE_LOCAL_RESEARCH_ROOT"
        )
    if len(output.relative_to(allowed_root).parts) < 2:
        raise ConnectivityReliabilityError(
            "OUTPUT_VERSION_DIRECTORY_REQUIRED"
        )
    if output == source or _is_within(output, source):
        raise ConnectivityReliabilityError(
            "OUTPUT_INSIDE_FROZEN_INPUT_FORBIDDEN"
        )
    if output.exists():
        if not output.is_dir():
            raise ConnectivityReliabilityError("OUTPUT_PATH_NOT_DIRECTORY")
        try:
            if any(output.iterdir()):
                raise ConnectivityReliabilityError(
                    "OUTPUT_DIRECTORY_NOT_EMPTY"
                )
        except OSError as exc:
            raise ConnectivityReliabilityError(
                "OUTPUT_DIRECTORY_READ_FAILED"
            ) from exc


def _write_exclusive(path: Path, payload: bytes) -> None:
    try:
        with path.open("xb") as handle:
            handle.write(payload)
    except FileExistsError as exc:
        raise ConnectivityReliabilityError(
            "OUTPUT_OVERWRITE_REFUSED", path.name
        ) from exc
    except OSError as exc:
        raise ConnectivityReliabilityError(
            "OUTPUT_WRITE_FAILED", path.name
        ) from exc


def run_evaluation(
    input_root: Path | str,
    output_dir: Path | str,
    *,
    bootstrap_repetitions: int = DEFAULT_BOOTSTRAP_REPETITIONS,
) -> dict[str, Any]:
    """Audit, evaluate, and write one new non-overwriting successor."""

    source = Path(input_root).expanduser().resolve()
    output = Path(output_dir).expanduser().resolve()
    _assert_output_available(output, source)
    audit = audit_formal_artifacts(source)
    records = load_formal_records(
        source,
        expected_sha256=audit["source_artifact_hashes"][
            "decision_snapshots_csv_sha256"
        ],
    )
    metrics, actions = evaluate_reliability(
        records,
        audit,
        bootstrap_repetitions=bootstrap_repetitions,
    )

    metrics_bytes = _json_artifact_bytes(metrics)
    actions_bytes = _actions_csv_bytes(actions)
    report_bytes = _report_text(metrics).encode("utf-8")
    output_hashes = {
        "metrics_json_sha256": _sha256_bytes(metrics_bytes),
        "actions_csv_sha256": _sha256_bytes(actions_bytes),
        "report_md_sha256": _sha256_bytes(report_bytes),
    }
    manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "artifact_files": [
            "metrics.json",
            "actions.csv",
            "manifest.json",
            "report.md",
        ],
        "source_artifact_hashes": audit["source_artifact_hashes"],
        "formal_pinned_core_implementation_hashes": audit[
            "formal_pinned_core_implementation_hashes"
        ],
        "successor_implementation_hashes": (
            _successor_implementation_hashes()
        ),
        "main_benchmark_reproducibility_hashes": {
            key: metrics["main_benchmark"][key]
            for key in (
                "policy_replay_input_hash",
                "benchmark_input_hash",
                "action_log_hash",
                "metrics_result_hash",
            )
        },
        "combined_action_log_hash": metrics["combined_action_log_hash"],
        "output_hashes": output_hashes,
        "contains_forum_text": False,
        "contains_raw_platform_ids": False,
        "decision_use": DECISION_USE,
        "observation_only_boundary": OBSERVATION_BOUNDARY,
        "graph_component_status": GRAPH_NOT_EVALUABLE_STATUS,
        "network_used": False,
        "external_write_attempted": False,
    }
    manifest["manifest_payload_hash"] = _canonical_hash(manifest)
    manifest_bytes = _json_artifact_bytes(manifest)

    _assert_output_available(output, source)
    try:
        output.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ConnectivityReliabilityError(
            "OUTPUT_DIRECTORY_CREATE_FAILED"
        ) from exc
    _write_exclusive(output / "metrics.json", metrics_bytes)
    _write_exclusive(output / "actions.csv", actions_bytes)
    _write_exclusive(output / "report.md", report_bytes)
    _write_exclusive(output / "manifest.json", manifest_bytes)
    return {
        "ok": True,
        "command": "run",
        "schema_version": SCHEMA_VERSION,
        "output_dir": str(output),
        "artifact_count": 4,
        "action_count": len(actions),
        "output_hashes": output_hashes,
        "manifest_payload_hash": manifest["manifest_payload_hash"],
        "contains_forum_text": False,
        "contains_raw_platform_ids": False,
        "decision_use": DECISION_USE,
        "network_used": False,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Audit frozen P3A formal artifacts and run a local-only "
            "connectivity reliability successor"
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    audit = subparsers.add_parser("audit")
    audit.add_argument("--input-root", default=str(_default_input_root()))
    audit.add_argument("--json", action="store_true")
    run = subparsers.add_parser("run")
    run.add_argument("--input-root", default=str(_default_input_root()))
    run.add_argument("--output-dir", required=True)
    run.add_argument(
        "--bootstrap-repetitions",
        type=int,
        default=DEFAULT_BOOTSTRAP_REPETITIONS,
    )
    run.add_argument("--json", action="store_true")
    return parser


def _emit(value: Mapping[str, Any], *, json_mode: bool) -> None:
    if json_mode:
        print(json.dumps(value, ensure_ascii=False, sort_keys=True))
        return
    if value.get("ok") is False:
        print(f"Connectivity reliability stopped: {value.get('error')}")
        return
    if value.get("command") == "audit":
        print(
            "Formal P3A audit passed: "
            f"{value.get('row_count')} rows, no files written."
        )
    else:
        print(
            "Connectivity reliability successor completed: "
            f"{value.get('output_dir')}"
        )


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(argv) if argv is not None else sys.argv[1:]
    parser = _parser()
    args = parser.parse_args(arguments)
    try:
        if args.command == "audit":
            result = audit_formal_artifacts(args.input_root)
        else:
            result = run_evaluation(
                args.input_root,
                args.output_dir,
                bootstrap_repetitions=args.bootstrap_repetitions,
            )
    except ConnectivityReliabilityError as exc:
        result = {
            "ok": False,
            "command": args.command,
            "error": exc.code,
            "detail": exc.detail,
            "network_used": False,
            "files_written": 0 if args.command == "audit" else None,
        }
        _emit(result, json_mode=bool(args.json))
        return 2
    _emit(result, json_mode=bool(args.json))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
