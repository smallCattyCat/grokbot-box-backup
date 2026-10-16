"""Event-clock scheduler benchmark orchestration."""

from __future__ import annotations

import copy
import hashlib
import inspect
import json
from dataclasses import asdict, is_dataclass
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Any, Mapping, Sequence

from research_decision.metrics import (
    INTERPRETATION_BOUNDARY,
    evaluate_policy_run,
    summarize_cross_year_stability,
)
from research_decision.policies import FifoPolicy, default_policies
from research_decision.replay import (
    ReplayConfig,
    VisibleCandidate,
    candidates_from_records,
    run_scheduler_replay,
)


BENCHMARK_SCHEMA_VERSION = "cmooc-scheduler-benchmark-v2"
DEVELOPMENT_YEAR = 2024
HOLDOUT_YEAR = 2025
DEFAULT_BUDGETS = (1, 3, 5)
DEFAULT_TICK_MINUTES = 30


def _canonical_hash(value: Any) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _implementation_hashes() -> dict[str, str]:
    module_dir = Path(__file__).resolve().parent
    return {
        name: _file_sha256(module_dir / f"{name}.py")
        for name in ("benchmark", "metrics", "policies", "replay")
    }


def _policy_definition(policy: object) -> dict[str, Any]:
    parameters = asdict(policy) if is_dataclass(policy) else {}
    try:
        class_source_hash = hashlib.sha256(
            inspect.getsource(type(policy)).encode("utf-8")
        ).hexdigest()
    except (OSError, TypeError):
        class_source_hash = None
    try:
        source_path_value = inspect.getsourcefile(type(policy))
        module_source_hash = (
            _file_sha256(Path(source_path_value).resolve())
            if source_path_value
            else None
        )
    except OSError:
        module_source_hash = None
    return {
        "policy": str(getattr(policy, "name", type(policy).__name__)),
        "implementation": type(policy).__name__,
        "implementation_module": type(policy).__module__,
        "implementation_source_sha256": module_source_hash,
        "implementation_class_source_sha256": class_source_hash,
        "parameters": parameters,
        "future_outcomes_visible": False,
    }


def _parse_time(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value))


def _day_start(value: datetime) -> datetime:
    return datetime.combine(value.date(), time.min, tzinfo=value.tzinfo)


def _eligible_records(
    records: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    return [
        row
        for row in records
        if row.get("decision_eligibility") == "eligible_unanswered"
        and int(row.get("year", 0)) in (DEVELOPMENT_YEAR, HOLDOUT_YEAR)
    ]


def evaluate_replay_benchmark(
    records: Sequence[Mapping[str, Any]],
    *,
    budgets: Sequence[int] = DEFAULT_BUDGETS,
    policies: Sequence[object] | None = None,
    tick_minutes: int = DEFAULT_TICK_MINUTES,
    max_actions_per_tick: int = 1,
) -> dict[str, Any]:
    """Run transparent policies on explicit ticks using 2024/2025 separately."""

    if int(tick_minutes) <= 0:
        raise ValueError("tick_minutes must be positive")
    if int(max_actions_per_tick) <= 0:
        raise ValueError("max_actions_per_tick must be positive")
    normalized_budgets = tuple(sorted({int(value) for value in budgets}))
    if not normalized_budgets or any(value <= 0 for value in normalized_budgets):
        raise ValueError("budgets must contain positive integers")
    chosen_policies = tuple(policies or default_policies())
    implementation_hashes = _implementation_hashes()
    policy_definitions = [
        _policy_definition(item) for item in chosen_policies
    ]
    policy_definition_by_name = {
        str(item["policy"]): item for item in policy_definitions
    }
    policy_names = [str(getattr(item, "name", type(item).__name__)) for item in chosen_policies]
    if len(policy_names) != len(set(policy_names)):
        raise ValueError("policy names must be unique")

    eligible = _eligible_records(records)
    by_year: list[dict[str, Any]] = []
    action_log: list[dict[str, Any]] = []
    run_summaries: list[dict[str, Any]] = []
    input_hashes_by_year: list[dict[str, Any]] = []
    replay_contract: dict[str, Any] | None = None

    for year in sorted({int(row["year"]) for row in eligible}):
        cohort = [row for row in eligible if int(row["year"]) == year]
        decision_times = [_parse_time(row["decision_at"]) for row in cohort]
        start_at = _day_start(min(decision_times))
        end_at = _day_start(max(decision_times)) + timedelta(days=1) - timedelta(
            microseconds=1
        )
        candidates = candidates_from_records(cohort)
        hash_candidates = sorted(
            candidates,
            key=lambda item: (item.decision_at, item.snapshot_key),
        )
        policy_input_rows = [
            dict(VisibleCandidate.from_candidate(item).record)
            for item in hash_candidates
        ]
        replay_state_rows = [
            {
                "snapshot_key": item.snapshot_key,
                "withdraw_at": (
                    item.withdraw_at.isoformat()
                    if item.withdraw_at is not None
                    else None
                ),
                "state_observed_until": (
                    item.state_observed_until.isoformat()
                    if item.state_observed_until is not None
                    else None
                ),
            }
            for item in hash_candidates
        ]
        evaluation_rows = [
            {
                "snapshot_key": str(row["snapshot_key"]),
                "outcome_observable": row.get("outcome_observable"),
                "organic_external_response_in_window": row.get(
                    "organic_external_response_in_window"
                ),
                "external_response_count_in_window": row.get(
                    "external_response_count_in_window"
                ),
                "unique_external_responder_count_in_window": row.get(
                    "unique_external_responder_count_in_window"
                ),
                "support_gap_at_horizon": row.get(
                    "support_gap_at_horizon"
                ),
            }
            for row in sorted(
                cohort, key=lambda row: str(row["snapshot_key"])
            )
        ]
        year_input_hashes = {
            "year": year,
            "candidate_count": len(candidates),
            "policy_input_hash": _canonical_hash(policy_input_rows),
            "replay_state_event_hash": _canonical_hash(
                replay_state_rows
            ),
            "evaluation_outcome_hash": _canonical_hash(evaluation_rows),
        }
        input_hashes_by_year.append(year_input_hashes)

        capacity_runs: dict[int, Any] = {}
        for budget in normalized_budgets:
            capacity_runs[budget] = run_scheduler_replay(
                candidates,
                FifoPolicy(),
                ReplayConfig(
                    start_at=start_at,
                    end_at=end_at,
                    tick_interval=timedelta(minutes=int(tick_minutes)),
                    daily_budget=budget,
                    max_actions_per_tick=int(max_actions_per_tick),
                    candidate_ttl=timedelta(minutes=int(tick_minutes)),
                ),
            )

        for policy in chosen_policies:
            policy_name = str(getattr(policy, "name", type(policy).__name__))
            for budget in normalized_budgets:
                config = ReplayConfig(
                    start_at=start_at,
                    end_at=end_at,
                    tick_interval=timedelta(minutes=int(tick_minutes)),
                    daily_budget=budget,
                    max_actions_per_tick=int(max_actions_per_tick),
                    candidate_ttl=timedelta(minutes=int(tick_minutes)),
                )
                replay = run_scheduler_replay(
                    candidates, copy.deepcopy(policy), config
                )
                capacity_replay = capacity_runs[budget]
                metric = evaluate_policy_run(
                    cohort,
                    replay.actions,
                    policy=policy_name,
                    daily_budget=budget,
                    replay_feasible_capacity=len(
                        capacity_replay.actions
                    ),
                    replay_feasible_daily_capacity=capacity_replay.summary[
                        "daily_action_counts"
                    ],
                )
                by_year.append(metric)
                if replay_contract is None:
                    replay_contract = {
                        key: replay.manifest[key]
                        for key in (
                            "schema_version",
                            "clock_mode",
                            "tick_interval_seconds",
                            "max_actions_per_tick",
                            "candidate_ttl_seconds",
                            "candidate_ttl_boundary",
                            "candidate_visibility_boundary",
                            "candidate_withdrawal_boundary",
                            "scheduler_state_observation_boundary",
                            "outcome_visibility_boundary",
                            "action_history_boundary",
                            "stable_candidate_order",
                            "candidate_expiry",
                            "candidate_queue_semantics",
                        )
                    }
                record_by_key = {
                    str(row["snapshot_key"]): row for row in cohort
                }
                run_action_rows: list[dict[str, Any]] = []
                for action in replay.actions:
                    source = record_by_key[action.snapshot_key]
                    delay_minutes = (
                        action.tick_at - action.decision_at
                    ).total_seconds() / 60
                    run_action_rows.append(
                        {
                            "year": year,
                            "split": metric["split"],
                            "policy": policy_name,
                            "daily_budget_k": budget,
                            "snapshot_key": action.snapshot_key,
                            "thread_key": str(source["thread_key"]),
                            "course_key": str(source["course_key"]),
                            "author_key": action.author_key,
                            "decision_at": action.decision_at.isoformat(),
                            "tick_at": action.tick_at.isoformat(),
                            "selection_delay_minutes": delay_minutes,
                            "selection_rank_at_tick": (
                                action.selection_rank_at_tick
                            ),
                        }
                    )
                action_log.extend(run_action_rows)
                run_summaries.append(
                    {
                        "year": year,
                        "split": metric["split"],
                        "policy": policy_name,
                        "daily_budget_k": budget,
                        "policy_input_hash": year_input_hashes[
                            "policy_input_hash"
                        ],
                        "replay_state_event_hash": year_input_hashes[
                            "replay_state_event_hash"
                        ],
                        "policy_definition_hash": _canonical_hash(
                            policy_definition_by_name[policy_name]
                        ),
                        "action_hash": _canonical_hash(run_action_rows),
                        **dict(replay.summary),
                    }
                )

    by_year.sort(
        key=lambda item: (
            int(item["year"]),
            str(item["policy"]),
            int(item["daily_budget_k"]),
        )
    )
    action_log.sort(
        key=lambda item: (
            int(item["year"]),
            str(item["policy"]),
            int(item["daily_budget_k"]),
            str(item["tick_at"]),
            int(item["selection_rank_at_tick"]),
            str(item["snapshot_key"]),
        )
    )
    run_summaries.sort(
        key=lambda item: (
            int(item["year"]),
            str(item["policy"]),
            int(item["daily_budget_k"]),
        )
    )
    replay_input_hashes = [
        {
            key: item[key]
            for key in (
                "year",
                "candidate_count",
                "policy_input_hash",
                "replay_state_event_hash",
            )
        }
        for item in input_hashes_by_year
    ]
    policy_replay_input = {
        "input_hashes_by_year": replay_input_hashes,
        "workload": {
            "daily_budgets_k": list(normalized_budgets),
            "tick_minutes": int(tick_minutes),
            "max_actions_per_tick": int(max_actions_per_tick),
        },
        "policy_definitions": policy_definitions,
        "implementation_hashes": implementation_hashes,
    }
    benchmark_input = {
        **policy_replay_input,
        "input_hashes_by_year": input_hashes_by_year,
    }
    cross_year_stability = summarize_cross_year_stability(by_year)
    metrics_result_hash = _canonical_hash(
        {
            "by_year": by_year,
            "cross_year_stability": cross_year_stability,
            "run_summaries": run_summaries,
        }
    )
    return {
        "schema_version": BENCHMARK_SCHEMA_VERSION,
        "target_definition": (
            "support_gap_at_horizon = no external human response by the "
            "development-frozen observation endpoint"
        ),
        "interpretation_boundary": INTERPRETATION_BOUNDARY,
        "split_policy": {
            "development_year": DEVELOPMENT_YEAR,
            "time_holdout_year": HOLDOUT_YEAR,
        },
        "workload_contract": {
            "budget_unit": "maximum selections per platform-calendar decision date",
            "daily_budgets_k": list(normalized_budgets),
            "tick_minutes": int(tick_minutes),
            "max_actions_per_tick": int(max_actions_per_tick),
        },
        "policy_definitions": policy_definitions,
        "implementation_hashes": implementation_hashes,
        "input_hashes_by_year": input_hashes_by_year,
        "policy_replay_input_hash": _canonical_hash(policy_replay_input),
        "benchmark_input_hash": _canonical_hash(benchmark_input),
        "action_log_hash": _canonical_hash(action_log),
        "metrics_result_hash": metrics_result_hash,
        "replay_contract": replay_contract or {
            "schema_version": "cmooc-scheduler-replay-v2",
            "candidate_visibility_boundary": "decision_at <= tick_at",
            "outcome_visibility_boundary": "outcome_window_end_at <= tick_at",
            "action_history_boundary": "action.tick_at < current tick_at",
        },
        "by_year": by_year,
        "cross_year_stability": cross_year_stability,
        "run_summaries": run_summaries,
        "action_log": action_log,
    }
