"""Outcome-blind queue policy for deterministic offline SHADOW replay."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Mapping, Sequence

from .policies import structural_score


def _value(item: object, name: str, default: Any = None) -> Any:
    if isinstance(item, Mapping):
        return item.get(name, default)
    return getattr(item, name, default)


def _record(candidate: object) -> Mapping[str, Any]:
    value = _value(candidate, "record")
    if isinstance(value, Mapping):
        return value
    features = _value(candidate, "features")
    if isinstance(features, Mapping):
        return features
    if isinstance(candidate, Mapping):
        return candidate
    raise TypeError("candidate must expose a record or features mapping")


def _snapshot_key(candidate: object) -> str:
    value = _value(candidate, "snapshot_key")
    if value is None:
        value = _record(candidate).get("snapshot_key")
    if value in (None, ""):
        raise ValueError("candidate snapshot_key is required")
    return str(value)


def _author_key(candidate: object) -> str:
    value = _value(candidate, "author_key")
    if value is None:
        value = _record(candidate).get("author_key")
    if value in (None, ""):
        raise ValueError("candidate author_key is required")
    return str(value)


def _parse_time(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value))


def _context_tick(context: object) -> datetime:
    value = _value(context, "tick_at")
    if value is None:
        raise ValueError("replay context must expose tick_at")
    return _parse_time(value)


def _context_actions(context: object) -> tuple[object, ...]:
    actions = _value(context, "prior_actions")
    if actions is None:
        actions = _value(context, "past_actions")
    if actions is None:
        actions = _value(context, "actions", ())
    return tuple(actions or ())


def _action_time(action: object) -> datetime:
    for name in ("selected_at", "tick_at", "action_at", "acted_at"):
        value = _value(action, name)
        if value is not None:
            return _parse_time(value)
    raise ValueError("action must expose its selection time")


def _action_author(action: object) -> str:
    value = _value(action, "author_key")
    if value is not None:
        return str(value)
    candidate = _value(action, "candidate")
    if candidate is not None:
        return _author_key(candidate)
    record = _value(action, "record")
    if isinstance(record, Mapping) and record.get("author_key"):
        return str(record["author_key"])
    raise ValueError("action must expose author_key")


def _action_snapshot_key(action: object) -> str:
    value = _value(action, "snapshot_key")
    if value is not None:
        return str(value)
    candidate = _value(action, "candidate")
    if candidate is not None:
        return _snapshot_key(candidate)
    record = _value(action, "record")
    if isinstance(record, Mapping) and record.get("snapshot_key"):
        return str(record["snapshot_key"])
    raise ValueError("action must expose snapshot_key")


def _matured_snapshot_keys(context: object) -> frozenset[str]:
    """Return settlement keys without reading any outcome value."""

    outcomes = _value(context, "matured_outcomes", ())
    keys: set[str] = set()
    for outcome in tuple(outcomes or ()):
        value = _value(outcome, "snapshot_key")
        if value not in (None, ""):
            keys.add(str(value))
    return frozenset(keys)


@dataclass(frozen=True)
class LyapunovQueuePolicy:
    """DPP-inspired, outcome-blind heuristic for offline SHADOW replay.

    The queues are reconstructed only from candidate as-of records, strictly
    prior selections, and the keys of outcomes already mature at the current
    replay tick. Outcome values are deliberately ignored. This transparent
    scheduling heuristic is neither a Lyapunov stability proof nor evidence of
    an intervention or educational effect.
    """

    utility_weight: float = 1.0
    exposure_deficit_weight: float = 8.0
    repeat_1d_penalty: float = 14.0
    repeat_7d_penalty: float = 7.0
    observation_debt_penalty: float = 10.0
    name: str = "lyapunov_queue_shadow_v1"

    def __post_init__(self) -> None:
        for field_name in (
            "utility_weight",
            "exposure_deficit_weight",
            "repeat_1d_penalty",
            "repeat_7d_penalty",
            "observation_debt_penalty",
        ):
            value = float(getattr(self, field_name))
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"{field_name} must be finite and nonnegative")
        if not str(self.name).strip():
            raise ValueError("name must be nonempty")

    def choose(
        self, candidates: Sequence[object], context: object, slots: int
    ) -> list[str]:
        target = max(0, int(slots))
        if target == 0 or not candidates:
            return []

        tick = _context_tick(context)
        history: list[tuple[datetime, str, str]] = []
        for action in _context_actions(context):
            action_at = _action_time(action)
            if action_at >= tick:
                continue
            history.append(
                (
                    action_at,
                    _action_author(action),
                    _action_snapshot_key(action),
                )
            )

        author_exposure: dict[str, int] = {}
        for item in candidates:
            author_exposure.setdefault(_author_key(item), 0)
        for _, author, _ in history:
            author_exposure[author] = author_exposure.get(author, 0) + 1
        mean_exposure = (
            sum(author_exposure.values()) / len(author_exposure)
            if author_exposure
            else 0.0
        )

        matured_keys = _matured_snapshot_keys(context)
        recent_1d: dict[str, int] = {}
        recent_7d: dict[str, int] = {}
        unresolved_debt: dict[str, int] = {}
        one_day_ago = tick - timedelta(days=1)
        seven_days_ago = tick - timedelta(days=7)
        for action_at, author, snapshot_key in history:
            if action_at > one_day_ago:
                recent_1d[author] = recent_1d.get(author, 0) + 1
            if action_at > seven_days_ago:
                recent_7d[author] = recent_7d.get(author, 0) + 1
            if snapshot_key not in matured_keys:
                unresolved_debt[author] = unresolved_debt.get(author, 0) + 1

        remaining: dict[str, object] = {}
        scores: dict[str, float] = {}
        for item in candidates:
            key = _snapshot_key(item)
            if key in remaining:
                raise ValueError(f"duplicate candidate snapshot_key: {key}")
            author = _author_key(item)
            remaining[key] = item
            exposure_deficit = max(
                0.0,
                mean_exposure - author_exposure.get(author, 0),
            )
            scores[key] = (
                structural_score(_record(item)) * self.utility_weight
                + exposure_deficit * self.exposure_deficit_weight
                - recent_1d.get(author, 0) * self.repeat_1d_penalty
                - recent_7d.get(author, 0) * self.repeat_7d_penalty
                - unresolved_debt.get(author, 0)
                * self.observation_debt_penalty
            )

        selected: list[str] = []
        selected_authors: set[str] = set()
        while remaining and len(selected) < target:
            distinct_author_pool = [
                key
                for key, item in remaining.items()
                if _author_key(item) not in selected_authors
            ]
            # Relax author uniqueness only after every still-available author
            # has already received a slot in this call.
            pool = distinct_author_pool or list(remaining)
            chosen_key = min(pool, key=lambda key: (-scores[key], key))
            chosen = remaining.pop(chosen_key)
            selected.append(chosen_key)
            selected_authors.add(_author_key(chosen))

        return selected
