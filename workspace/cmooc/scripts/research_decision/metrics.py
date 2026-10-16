"""Workload, targeting, and exposure metrics for observational replay."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Any, Iterable, Mapping, Sequence


INTERPRETATION_BOUNDARY = (
    "observational scheduling benchmark; associations with subsequent human "
    "interaction are not intervention causal effects"
)


def _parse_time(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value))


def _selected_item(
    item: object, records: Mapping[str, Mapping[str, Any]]
) -> tuple[str, datetime]:
    if isinstance(item, str):
        key = item
        selected_at = records[key]["decision_at"]
    elif isinstance(item, Mapping):
        key = str(item["snapshot_key"])
        selected_at = item.get("selected_at", item.get("tick_at"))
        if selected_at is None:
            selected_at = records[key]["decision_at"]
    else:
        key = str(getattr(item, "snapshot_key"))
        selected_at = getattr(
            item,
            "selected_at",
            getattr(item, "tick_at", records[key]["decision_at"]),
        )
    if key not in records:
        raise ValueError(f"selected snapshot is not in eligible cohort: {key}")
    return key, _parse_time(selected_at)


def _safe_rate(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def _gini(values: Sequence[int]) -> float:
    if not values or sum(values) == 0:
        return 0.0
    ordered = sorted(values)
    count = len(ordered)
    total = sum(ordered)
    weighted = sum((index + 1) * value for index, value in enumerate(ordered))
    return (2 * weighted) / (count * total) - (count + 1) / count


def _repeat_rate(
    selections: Sequence[tuple[Mapping[str, Any], datetime]], days: int
) -> float:
    prior_by_author: dict[str, list[datetime]] = defaultdict(list)
    repeated = 0
    for row, selected_at in sorted(
        selections,
        key=lambda item: (item[1], str(item[0]["snapshot_key"])),
    ):
        author = str(row["author_key"])
        lower = selected_at - timedelta(days=days)
        if any(lower <= prior <= selected_at for prior in prior_by_author[author]):
            repeated += 1
        prior_by_author[author].append(selected_at)
    return _safe_rate(repeated, len(selections))


def _subgroup_rows(
    eligible: Sequence[Mapping[str, Any]],
    selected: Sequence[tuple[Mapping[str, Any], datetime]],
    field: str,
) -> list[dict[str, Any]]:
    eligible_groups: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    selected_groups: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in eligible:
        if field == "month":
            group = str(row["decision_date"])[:7]
        else:
            group = str(row.get(field, ""))
        eligible_groups[group].append(row)
    for row, _ in selected:
        if field == "month":
            group = str(row["decision_date"])[:7]
        else:
            group = str(row.get(field, ""))
        selected_groups[group].append(row)
    result: list[dict[str, Any]] = []
    for group in sorted(eligible_groups):
        cohort = eligible_groups[group]
        chosen = selected_groups.get(group, [])
        positives = sum(int(row["support_gap_at_horizon"]) for row in cohort)
        true_positive = sum(
            int(row["support_gap_at_horizon"]) for row in chosen
        )
        result.append(
            {
                field: group,
                "eligible_count": len(cohort),
                "selected_count": len(chosen),
                "precision": _safe_rate(true_positive, len(chosen)),
                "coverage": _safe_rate(true_positive, positives),
            }
        )
    return result


def evaluate_policy_run(
    records: Sequence[Mapping[str, Any]],
    selected: Sequence[object],
    *,
    policy: str,
    daily_budget: int,
    replay_feasible_capacity: int | None = None,
    replay_feasible_daily_capacity: Mapping[str, int] | None = None,
) -> dict[str, Any]:
    """Evaluate one policy/year/budget run without making causal claims."""

    budget = max(0, int(daily_budget))
    candidates = [
        row
        for row in records
        if row.get("decision_eligibility") == "eligible_unanswered"
    ]
    by_key = {str(row["snapshot_key"]): row for row in candidates}
    normalized = [_selected_item(item, by_key) for item in selected]
    keys = [key for key, _ in normalized]
    if len(keys) != len(set(keys)):
        raise ValueError("a snapshot may be selected at most once")
    chosen = [(by_key[key], selected_at) for key, selected_at in normalized]

    candidates_by_day: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    selected_by_day: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in candidates:
        candidates_by_day[str(row["decision_date"])].append(row)
    for row, _ in chosen:
        selected_by_day[str(row["decision_date"])].append(row)

    nominal_daily_capacity = {
        day: min(budget, len(day_rows))
        for day, day_rows in candidates_by_day.items()
    }
    if replay_feasible_daily_capacity is None:
        feasible_daily_capacity = dict(nominal_daily_capacity)
    else:
        feasible_daily_capacity = {
            str(day): int(value)
            for day, value in replay_feasible_daily_capacity.items()
        }
        if any(value < 0 for value in feasible_daily_capacity.values()):
            raise ValueError("replay feasible capacity must be nonnegative")
        for day, rows in selected_by_day.items():
            if len(rows) > feasible_daily_capacity.get(day, 0):
                raise ValueError(
                    "selected actions exceed replay feasible daily capacity"
                )
    feasible_capacity = sum(feasible_daily_capacity.values())
    if replay_feasible_capacity is not None:
        declared_capacity = int(replay_feasible_capacity)
        if declared_capacity != feasible_capacity:
            raise ValueError(
                "replay feasible total and daily capacities disagree"
            )

    # Target metrics use only dates whose full candidate set has a mature
    # outcome. This prevents a future observability flag from changing actions
    # while avoiding treatment of right-censored outcomes as negatives.
    target_days = {
        day
        for day, day_rows in candidates_by_day.items()
        if all(
            int(row.get("outcome_observable", 0) or 0) == 1
            for row in day_rows
        )
    }
    target_candidates = [
        row
        for row in candidates
        if str(row["decision_date"]) in target_days
    ]
    target_selected = [
        (row, selected_at)
        for row, selected_at in chosen
        if str(row["decision_date"]) in target_days
    ]

    daily_precision_at_k: list[float] = []
    daily_selection_precision: list[float] = []
    for day in sorted(target_days):
        capacity = feasible_daily_capacity.get(day, 0)
        if capacity <= 0:
            continue
        day_selected = selected_by_day.get(day, [])
        day_positive = sum(
            int(row["support_gap_at_horizon"]) for row in day_selected
        )
        daily_precision_at_k.append(_safe_rate(day_positive, capacity))
        daily_selection_precision.append(
            _safe_rate(day_positive, len(day_selected))
        )

    positives = sum(
        int(row["support_gap_at_horizon"]) for row in target_candidates
    )
    selected_positive = sum(
        int(row["support_gap_at_horizon"]) for row, _ in target_selected
    )
    selected_organic = sum(
        int(row["organic_external_response_in_window"])
        for row, _ in target_selected
    )
    target_capacity = sum(
        feasible_daily_capacity.get(day, 0) for day in target_days
    )
    nominal_capacity = sum(nominal_daily_capacity.values())

    eligible_authors = {str(row["author_key"]) for row in candidates}
    author_counts = Counter(str(row["author_key"]) for row, _ in chosen)
    exposure_values = [author_counts.get(author, 0) for author in eligible_authors]
    selected_count = len(chosen)
    selected_authors = set(author_counts)
    exposure_shares = [
        _safe_rate(count, selected_count) for count in author_counts.values()
    ]
    years = sorted({int(row["year"]) for row in candidates})
    year: int | str = years[0] if len(years) == 1 else "mixed"

    return {
        "year": year,
        "split": (
            "development"
            if year == 2024
            else "time_holdout"
            if year == 2025
            else "mixed"
        ),
        "policy": policy,
        "daily_budget_k": budget,
        "eligible_count": len(candidates),
        "outcome_observable_count": sum(
            int(row.get("outcome_observable", 0) or 0)
            for row in candidates
        ),
        "target_evaluable_count": len(target_candidates),
        "outcome_censored_day_count": (
            len(candidates_by_day) - len(target_days)
        ),
        "support_gap_count": positives,
        "selected_count": selected_count,
        "selected_outcome_evaluable_count": sum(
            int(row.get("outcome_observable", 0) or 0) for row, _ in chosen
        ),
        "selected_outcome_censored_count": sum(
            int(row.get("outcome_observable", 0) or 0) != 1
            for row, _ in chosen
        ),
        "selected_target_evaluable_count": len(target_selected),
        "nominal_budget_capacity": nominal_capacity,
        "replay_feasible_budget_capacity": feasible_capacity,
        "feasible_budget_capacity": feasible_capacity,
        "target_evaluation_capacity": target_capacity,
        "precision_evaluation_day_count": len(daily_precision_at_k),
        "precision_at_k_daily_macro": _safe_rate(
            sum(daily_precision_at_k), len(daily_precision_at_k)
        ),
        "selection_precision_daily_macro": _safe_rate(
            sum(daily_selection_precision), len(daily_selection_precision)
        ),
        "precision_at_k_yearly_micro": _safe_rate(
            selected_positive, target_capacity
        ),
        "selection_precision_yearly_micro": _safe_rate(
            selected_positive, len(target_selected)
        ),
        "precision_at_k": _safe_rate(selected_positive, target_capacity),
        "coverage": _safe_rate(selected_positive, positives),
        "unnecessary_intervention_rate": _safe_rate(
            selected_organic, len(target_selected)
        ),
        "budget_utilization": _safe_rate(selected_count, feasible_capacity),
        "nominal_budget_utilization": _safe_rate(
            selected_count, nominal_capacity
        ),
        "author_repeat_touch_rate_1d": _repeat_rate(chosen, 1),
        "author_repeat_touch_rate_7d": _repeat_rate(chosen, 7),
        "author_repeat_touch_rate_28d": _repeat_rate(chosen, 28),
        "unique_author_coverage": _safe_rate(
            len(selected_authors), len(eligible_authors)
        ),
        "maximum_author_exposure_share": max(exposure_shares, default=0.0),
        "author_exposure_hhi": sum(share * share for share in exposure_shares),
        "author_exposure_gini": _gini(exposure_values),
        "by_month": _subgroup_rows(
            target_candidates, target_selected, "month"
        ),
        "by_course": _subgroup_rows(
            target_candidates, target_selected, "course_key"
        ),
        "interpretation_boundary": INTERPRETATION_BOUNDARY,
    }


def summarize_cross_year_stability(
    by_year: Sequence[Mapping[str, Any]],
    *,
    development_year: int = 2024,
    holdout_year: int = 2025,
) -> list[dict[str, Any]]:
    indexed = {
        (
            int(item["year"]),
            str(item["policy"]),
            int(item["daily_budget_k"]),
        ): item
        for item in by_year
        if isinstance(item.get("year"), int)
    }
    policies = sorted(
        {
            (str(item["policy"]), int(item["daily_budget_k"]))
            for item in by_year
        }
    )
    result: list[dict[str, Any]] = []
    for policy, budget in policies:
        development = indexed.get((development_year, policy, budget))
        holdout = indexed.get((holdout_year, policy, budget))
        if development is None or holdout is None:
            continue
        result.append(
            {
                "policy": policy,
                "daily_budget_k": budget,
                "development_year": development_year,
                "holdout_year": holdout_year,
                "precision_delta_holdout_minus_development": float(
                    holdout["precision_at_k_yearly_micro"]
                )
                - float(development["precision_at_k_yearly_micro"]),
                "coverage_delta_holdout_minus_development": float(
                    holdout["coverage"]
                )
                - float(development["coverage"]),
                "unnecessary_rate_delta_holdout_minus_development": float(
                    holdout["unnecessary_intervention_rate"]
                )
                - float(development["unnecessary_intervention_rate"]),
                "repeat_touch_delta_holdout_minus_development": float(
                    holdout["author_repeat_touch_rate_7d"]
                )
                - float(development["author_repeat_touch_rate_7d"]),
                "budget_utilization_delta_holdout_minus_development": float(
                    holdout["budget_utilization"]
                )
                - float(development["budget_utilization"]),
            }
        )
    return result
