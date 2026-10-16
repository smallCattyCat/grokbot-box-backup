"""Transparent policies for event-clock scheduler replay.

Policies may inspect only candidate snapshot records and action history exposed
by the replay context. They never receive future outcome labels.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Mapping, Sequence


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


def _decision_at(candidate: object) -> datetime:
    value = _value(candidate, "decision_at")
    if value is None:
        value = _record(candidate).get("decision_at")
    return _parse_time(value)


def _context_tick(context: object) -> datetime:
    value = _value(context, "tick_at")
    if value is None:
        raise ValueError("replay context must expose tick_at")
    return _parse_time(value)


def _context_actions(context: object) -> tuple[object, ...]:
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


def structural_score(row: Mapping[str, Any]) -> float:
    """Reproduce the frozen, outcome-blind manual structural score."""

    response_rate = float(
        row.get("author_prior_external_response_rate_asof", 0) or 0
    )
    response_rate = min(max(response_rate, 0.0), 1.0)
    comment_count = int(row.get("comment_count_asof", 0) or 0)
    self_count = int(row.get("self_comment_count_asof", 0) or 0)
    depth = int(row.get("max_reply_depth_asof", 0) or 0)
    prior_gaps = int(row.get("author_prior_matured_gap_count_asof", 0) or 0)
    cognitive_need = min(24.0, depth * 1.6 + 1.0)
    urgency_need = min(
        24.0, 14.0 + (5.0 if comment_count <= 1 else 0.0) + self_count * 2.0
    )
    equity_need = min(
        24.0,
        (1.0 - response_rate) * 18.0
        + (5.0 if comment_count <= 1 else 0.0),
    )
    history_need = min(12.0, prior_gaps * 2.0)
    return round(
        min(
            120.0,
            50.0
            + cognitive_need
            + urgency_need
            + equity_need
            + history_need,
        ),
        4,
    )


def _limit(keys: Sequence[str], slots: int) -> list[str]:
    requested = max(0, int(slots))
    result = list(keys[:requested])
    if len(result) != len(set(result)):
        raise ValueError("policy returned duplicate snapshot keys")
    return result


@dataclass(frozen=True)
class FifoPolicy:
    name: str = "fifo"

    def choose(
        self, candidates: Sequence[object], context: object, slots: int
    ) -> list[str]:
        del context
        ordered = sorted(
            candidates, key=lambda item: (_decision_at(item), _snapshot_key(item))
        )
        return _limit([_snapshot_key(item) for item in ordered], slots)


@dataclass(frozen=True)
class SeededRandomPolicy:
    seed: str = "cmooc-scheduler-v1"
    name: str = "seeded_random"

    def choose(
        self, candidates: Sequence[object], context: object, slots: int
    ) -> list[str]:
        tick = _context_tick(context).isoformat()

        def rank(item: object) -> tuple[str, str]:
            key = _snapshot_key(item)
            digest = hashlib.sha256(
                f"{self.seed}\x1f{tick}\x1f{key}".encode("utf-8")
            ).hexdigest()
            return digest, key

        ordered = sorted(candidates, key=rank)
        return _limit([_snapshot_key(item) for item in ordered], slots)


@dataclass(frozen=True)
class StructuralScorePolicy:
    name: str = "structural_score_only"

    def choose(
        self, candidates: Sequence[object], context: object, slots: int
    ) -> list[str]:
        del context
        ordered = sorted(
            candidates,
            key=lambda item: (
                -structural_score(_record(item)),
                _snapshot_key(item),
            ),
        )
        return _limit([_snapshot_key(item) for item in ordered], slots)


@dataclass(frozen=True)
class ManualStructuralPolicy:
    """Offline form of the existing score with explicit repeat penalties."""

    cooldown_days: int = 7
    recent_penalty: float = 7.0
    same_day_penalty: float = 14.0
    name: str = "current_manual_structural"

    def choose(
        self, candidates: Sequence[object], context: object, slots: int
    ) -> list[str]:
        tick = _context_tick(context)
        history = [
            action
            for action in _context_actions(context)
            if _action_time(action) < tick
        ]
        selected: list[str] = []
        selected_authors: dict[str, int] = {}
        remaining = {_snapshot_key(item): item for item in candidates}
        while remaining and len(selected) < max(0, int(slots)):
            scored: list[tuple[float, str, object]] = []
            for key, item in remaining.items():
                author = _author_key(item)
                recent = sum(
                    1
                    for action in history
                    if _action_author(action) == author
                    and tick - timedelta(days=self.cooldown_days)
                    < _action_time(action)
                    < tick
                )
                same_day = sum(
                    1
                    for action in history
                    if _action_author(action) == author
                    and _action_time(action).date() == tick.date()
                )
                score = (
                    structural_score(_record(item))
                    - recent * self.recent_penalty
                    - (
                        same_day + selected_authors.get(author, 0)
                    )
                    * self.same_day_penalty
                )
                scored.append((score, key, item))
            scored.sort(key=lambda value: (-value[0], value[1]))
            _, chosen_key, chosen = scored[0]
            selected.append(chosen_key)
            author = _author_key(chosen)
            selected_authors[author] = selected_authors.get(author, 0) + 1
            del remaining[chosen_key]
        return _limit(selected, slots)


@dataclass(frozen=True)
class LeastRecentAuthorPolicy:
    name: str = "least_recent_author_then_score"

    def choose(
        self, candidates: Sequence[object], context: object, slots: int
    ) -> list[str]:
        tick = _context_tick(context)
        latest: dict[str, datetime] = {}
        for action in _context_actions(context):
            action_at = _action_time(action)
            if action_at >= tick:
                continue
            author = _action_author(action)
            if author not in latest or action_at > latest[author]:
                latest[author] = action_at

        floor = datetime.min.replace(tzinfo=tick.tzinfo)
        ordered = sorted(
            candidates,
            key=lambda item: (
                latest.get(_author_key(item), floor),
                -structural_score(_record(item)),
                _snapshot_key(item),
            ),
        )
        return _limit([_snapshot_key(item) for item in ordered], slots)


@dataclass(frozen=True)
class ConstrainedStructuralPolicy:
    """Structural score with staged, observable exposure constraints.

    Stage 1 admits authors untouched within the cooldown. Stage 2 relaxes only
    the cooldown. Stage 3 permits same-day repeats if capacity would otherwise
    remain unused. This ordering makes each relaxation auditable.
    """

    cooldown_days: int = 7
    name: str = "constrained_structural"

    def choose(
        self, candidates: Sequence[object], context: object, slots: int
    ) -> list[str]:
        tick = _context_tick(context)
        history = [
            action
            for action in _context_actions(context)
            if _action_time(action) < tick
        ]
        same_day_authors = {
            _action_author(action)
            for action in history
            if _action_time(action).date() == tick.date()
        }
        cooldown_authors = {
            _action_author(action)
            for action in history
            if tick - timedelta(days=self.cooldown_days)
            < _action_time(action)
            < tick
        }
        remaining = {_snapshot_key(item): item for item in candidates}
        chosen: list[str] = []
        chosen_authors: set[str] = set()
        target = max(0, int(slots))

        def ordered_candidates() -> list[object]:
            return sorted(
                remaining.values(),
                key=lambda item: (
                    -structural_score(_record(item)),
                    _snapshot_key(item),
                ),
            )

        # (allow cooldown author, allow same-day or same-call author)
        for allow_cooldown, allow_same_day in (
            (False, False),
            (True, False),
            (True, True),
        ):
            for item in ordered_candidates():
                if len(chosen) >= target:
                    break
                author = _author_key(item)
                if not allow_same_day and (
                    author in same_day_authors or author in chosen_authors
                ):
                    continue
                if not allow_cooldown and author in cooldown_authors:
                    continue
                key = _snapshot_key(item)
                chosen.append(key)
                chosen_authors.add(author)
                del remaining[key]
            if len(chosen) >= target:
                break
        return _limit(chosen, slots)


def default_policies(*, seed: str = "cmooc-scheduler-v1") -> tuple[object, ...]:
    """Return the frozen transparent comparison set in display order."""

    return (
        FifoPolicy(),
        SeededRandomPolicy(seed=seed),
        StructuralScorePolicy(),
        ManualStructuralPolicy(),
        LeastRecentAuthorPolicy(),
        ConstrainedStructuralPolicy(),
    )
