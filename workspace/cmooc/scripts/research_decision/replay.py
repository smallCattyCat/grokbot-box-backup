"""Strict event-clock replay for workload-constrained intervention scheduling.

The replay separates three clocks:

* a candidate is visible only when ``decision_at <= tick_at``;
* a scheduler may act only on explicit ticks and within the daily budget;
* an outcome is visible only when
  ``outcome_window_end_at <= tick_at``.

Policies receive :class:`VisibleCandidate` objects, which deliberately contain
no outcome fields, plus a :class:`ReplayContext` containing only strictly prior
actions and outcomes that have already matured. Unselected candidates can wait
for later ticks on their decision date, but never carry into another date.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from types import MappingProxyType
from typing import Any, Iterable, Mapping, Protocol, Sequence


REPLAY_SCHEMA_VERSION = "cmooc-scheduler-replay-v2"

# These fields are outcomes of the future observation window in
# decision_snapshot_v1. They must never be copied into a policy-visible record.
DEFAULT_OUTCOME_FIELDS = frozenset(
    {
        "outcome_observable",
        "organic_external_response_in_window",
        "external_response_count_in_window",
        "unique_external_responder_count_in_window",
        "support_gap_at_horizon",
    }
)

# This subsequent event is never policy-visible. Unlike a terminal outcome,
# however, it can become observable between the snapshot time and a scheduler
# tick. The replay uses it only to withdraw a candidate before selection.
SCHEDULER_STATE_FIELDS = frozenset(
    {
        "first_external_response_after_decision_microseconds",
        "source_observation_end_after_decision_microseconds",
    }
)

_CORE_FIELDS = frozenset(
    {
        "snapshot_key",
        "author_key",
        "decision_at",
        "decision_date",
        "outcome_window_end_at",
    }
)

POLICY_VISIBLE_FIELDS = frozenset(
    {
        "thread_key",
        "course_key",
        "year",
        "decision_lag_hours",
        "outcome_window_hours",
        "comment_count_asof",
        "external_comment_count_asof",
        "self_comment_count_asof",
        "unique_external_author_count_asof",
        "reply_edge_count_asof",
        "max_reply_depth_asof",
        "author_prior_post_count_asof",
        "author_prior_external_response_count_asof",
        "author_prior_external_response_rate_asof",
        "author_prior_matured_gap_count_asof",
        "course_post_count_prior_7d_asof",
        "course_external_comment_count_prior_7d_asof",
        "decision_eligibility",
        "suggested_function",
    }
)

POLICY_IGNORED_FIELDS = frozenset(
    {
        "schema_version",
        "future_parent_reference_count_asof",
        "feature_hash",
        "asof_boundary_ok",
    }
)


class ReplayValidationError(ValueError):
    """Raised when a replay contract or a policy response is invalid."""


def _parse_datetime(value: Any, *, field_name: str) -> datetime:
    if isinstance(value, datetime):
        return value
    text = str(value).strip()
    if not text:
        raise ReplayValidationError(f"INVALID_DATETIME:{field_name}")
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError as exc:
        raise ReplayValidationError(
            f"INVALID_DATETIME:{field_name}"
        ) from exc


def _time_mode(value: datetime) -> str:
    return "aware" if value.utcoffset() is not None else "naive"


def _normalize_datetime(value: datetime) -> datetime:
    if _time_mode(value) == "aware":
        return value.astimezone(timezone.utc)
    # Naive source timestamps have no recoverable timezone. The replay treats
    # them as one consistent UTC-like clock without silently attaching an
    # offset that the source does not provide.
    return value.replace(tzinfo=None)


def _require_same_time_mode(
    values: Iterable[tuple[str, datetime]],
) -> str:
    pairs = tuple(values)
    modes = {_time_mode(value) for _, value in pairs}
    if len(modes) > 1:
        detail = ",".join(f"{name}={_time_mode(value)}" for name, value in pairs)
        raise ReplayValidationError(f"MIXED_TIMEZONE_MODE:{detail}")
    return next(iter(modes), "naive")


def _freeze_mapping(value: Mapping[str, Any] | None) -> Mapping[str, Any]:
    return MappingProxyType(dict(value or {}))


def _iso(value: datetime) -> str:
    return value.isoformat()


@dataclass(frozen=True)
class ReplayCandidate:
    """Internal candidate containing both snapshot features and future outcome.

    Instances are safe replay inputs, but policies never receive this type.
    :func:`run_scheduler_replay` converts each one to a
    :class:`VisibleCandidate` with the outcome removed.
    """

    snapshot_key: str
    author_key: str
    decision_at: datetime
    outcome_window_end_at: datetime
    withdraw_at: datetime | None = None
    state_observed_until: datetime | None = None
    features: Mapping[str, Any] = field(default_factory=dict)
    outcome: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        key = str(self.snapshot_key).strip()
        author = str(self.author_key).strip()
        if not key:
            raise ReplayValidationError("SNAPSHOT_KEY_REQUIRED")
        if not author:
            raise ReplayValidationError("AUTHOR_KEY_REQUIRED")

        decision_at = _parse_datetime(
            self.decision_at, field_name=f"{key}.decision_at"
        )
        outcome_at = _parse_datetime(
            self.outcome_window_end_at,
            field_name=f"{key}.outcome_window_end_at",
        )
        clock_values = [
            (f"{key}.decision_at", decision_at),
            (f"{key}.outcome_window_end_at", outcome_at),
        ]
        withdraw_at: datetime | None = None
        if self.withdraw_at is not None:
            withdraw_at = _parse_datetime(
                self.withdraw_at, field_name=f"{key}.withdraw_at"
            )
            clock_values.append((f"{key}.withdraw_at", withdraw_at))
        state_observed_until: datetime | None = None
        if self.state_observed_until is not None:
            state_observed_until = _parse_datetime(
                self.state_observed_until,
                field_name=f"{key}.state_observed_until",
            )
            clock_values.append(
                (
                    f"{key}.state_observed_until",
                    state_observed_until,
                )
            )
        _require_same_time_mode(clock_values)
        decision_at = _normalize_datetime(decision_at)
        outcome_at = _normalize_datetime(outcome_at)
        if withdraw_at is not None:
            withdraw_at = _normalize_datetime(withdraw_at)
        if state_observed_until is not None:
            state_observed_until = _normalize_datetime(
                state_observed_until
            )
        if outcome_at <= decision_at:
            raise ReplayValidationError(
                f"INVALID_OUTCOME_WINDOW:{key}:"
                "outcome_window_end_at_must_follow_decision_at"
            )
        if withdraw_at is not None and not (
            decision_at < withdraw_at <= outcome_at
        ):
            raise ReplayValidationError(
                f"INVALID_WITHDRAWAL_TIME:{key}:"
                "decision_at_must_precede_withdraw_at_not_after_outcome_end"
            )
        if (
            state_observed_until is not None
            and state_observed_until > outcome_at
        ):
            raise ReplayValidationError(
                f"INVALID_STATE_OBSERVATION_HORIZON:{key}:"
                "state_observed_until_must_not_follow_outcome_end"
            )

        features = dict(self.features or {})
        forbidden = sorted(
            (DEFAULT_OUTCOME_FIELDS | SCHEDULER_STATE_FIELDS).intersection(
                features
            )
        )
        if forbidden:
            raise ReplayValidationError(
                "OUTCOME_FIELD_IN_POLICY_FEATURES:" + ",".join(forbidden)
            )

        object.__setattr__(self, "snapshot_key", key)
        object.__setattr__(self, "author_key", author)
        object.__setattr__(self, "decision_at", decision_at)
        object.__setattr__(self, "outcome_window_end_at", outcome_at)
        object.__setattr__(self, "withdraw_at", withdraw_at)
        object.__setattr__(
            self, "state_observed_until", state_observed_until
        )
        object.__setattr__(self, "features", _freeze_mapping(features))
        object.__setattr__(self, "outcome", _freeze_mapping(self.outcome))

    @property
    def decision_date(self) -> date:
        return self.decision_at.date()

    @classmethod
    def from_record(
        cls,
        record: Mapping[str, Any],
        *,
        outcome_fields: Iterable[str] = DEFAULT_OUTCOME_FIELDS,
    ) -> "ReplayCandidate":
        """Partition one formal snapshot row into safe features and outcomes."""

        missing = [
            name
            for name in (
                "snapshot_key",
                "author_key",
                "decision_at",
                "outcome_window_end_at",
            )
            if record.get(name) in (None, "")
        ]
        if missing:
            raise ReplayValidationError(
                "RECORD_MISSING_REQUIRED_FIELDS:" + ",".join(missing)
            )
        outcome_names = frozenset(str(name) for name in outcome_fields)
        unknown = sorted(
            set(str(name) for name in record)
            - _CORE_FIELDS
            - outcome_names
            - SCHEDULER_STATE_FIELDS
            - POLICY_VISIBLE_FIELDS
            - POLICY_IGNORED_FIELDS
        )
        if unknown:
            raise ReplayValidationError(
                "UNCLASSIFIED_FORMAL_FIELDS:" + ",".join(unknown)
            )
        features = {
            str(name): value
            for name, value in record.items()
            if str(name) in POLICY_VISIBLE_FIELDS
        }
        outcome = {
            str(name): record[name]
            for name in outcome_names
            if name in record
        }
        decision_at = _parse_datetime(
            record["decision_at"], field_name="decision_at"
        )
        outcome_window_end_at = _parse_datetime(
            record["outcome_window_end_at"],
            field_name="outcome_window_end_at",
        )
        if (
            record.get("schema_version")
            and "source_observation_end_after_decision_microseconds"
            not in record
        ):
            raise ReplayValidationError(
                "FORMAL_RECORD_MISSING_SCHEDULER_STATE_HORIZON"
            )
        state_horizon_lag = record.get(
            "source_observation_end_after_decision_microseconds"
        )
        state_observed_until: datetime | None = None
        if state_horizon_lag not in (None, ""):
            if isinstance(state_horizon_lag, bool):
                raise ReplayValidationError(
                    "STATE_HORIZON_LAG_MICROSECONDS_MUST_BE_INTEGER"
                )
            try:
                state_horizon_microseconds = int(state_horizon_lag)
            except (TypeError, ValueError) as exc:
                raise ReplayValidationError(
                    "STATE_HORIZON_LAG_MICROSECONDS_MUST_BE_INTEGER"
                ) from exc
            if str(state_horizon_lag).strip() not in {
                str(state_horizon_microseconds),
                f"{state_horizon_microseconds}.0",
            }:
                raise ReplayValidationError(
                    "STATE_HORIZON_LAG_MICROSECONDS_MUST_BE_INTEGER"
                )
            state_observed_until = decision_at + timedelta(
                microseconds=state_horizon_microseconds
            )
        withdrawal_lag = record.get(
            "first_external_response_after_decision_microseconds"
        )
        withdraw_at: datetime | None = None
        if withdrawal_lag not in (None, ""):
            if isinstance(withdrawal_lag, bool):
                raise ReplayValidationError(
                    "WITHDRAWAL_LAG_MICROSECONDS_MUST_BE_POSITIVE_INTEGER"
                )
            try:
                withdrawal_microseconds = int(withdrawal_lag)
            except (TypeError, ValueError) as exc:
                raise ReplayValidationError(
                    "WITHDRAWAL_LAG_MICROSECONDS_MUST_BE_POSITIVE_INTEGER"
                ) from exc
            if (
                withdrawal_microseconds <= 0
                or str(withdrawal_lag).strip()
                not in {
                    str(withdrawal_microseconds),
                    f"{withdrawal_microseconds}.0",
                }
            ):
                raise ReplayValidationError(
                    "WITHDRAWAL_LAG_MICROSECONDS_MUST_BE_POSITIVE_INTEGER"
                )
            withdraw_at = decision_at + timedelta(
                microseconds=withdrawal_microseconds
            )
        observable = outcome.get("outcome_observable")
        if observable in (0, "0", False):
            outcome = {
                "outcome_observable": 0,
                "evidence_state": "right_censored",
            }
        elif observable not in (None, 1, "1", True):
            raise ReplayValidationError("OUTCOME_OBSERVABLE_MUST_BE_BINARY")
        return cls(
            snapshot_key=str(record["snapshot_key"]),
            author_key=str(record["author_key"]),
            decision_at=decision_at,
            outcome_window_end_at=outcome_window_end_at,
            withdraw_at=withdraw_at,
            state_observed_until=state_observed_until,
            features=features,
            outcome=outcome,
        )


@dataclass(frozen=True)
class VisibleCandidate:
    """Leakage-safe candidate view supplied to a scheduler policy."""

    snapshot_key: str
    author_key: str
    decision_at: datetime
    outcome_window_end_at: datetime
    features: Mapping[str, Any]

    @classmethod
    def from_candidate(cls, candidate: ReplayCandidate) -> "VisibleCandidate":
        return cls(
            snapshot_key=candidate.snapshot_key,
            author_key=candidate.author_key,
            decision_at=candidate.decision_at,
            outcome_window_end_at=candidate.outcome_window_end_at,
            features=candidate.features,
        )

    @property
    def decision_date(self) -> date:
        return self.decision_at.date()

    @property
    def record(self) -> Mapping[str, Any]:
        """Original-like snapshot mapping with every future label removed."""

        result = dict(self.features)
        result.update(
            {
                "snapshot_key": self.snapshot_key,
                "author_key": self.author_key,
                "decision_at": _iso(self.decision_at),
                "decision_date": self.decision_date.isoformat(),
                "outcome_window_end_at": _iso(self.outcome_window_end_at),
            }
        )
        return MappingProxyType(result)

    def get(self, name: str, default: Any = None) -> Any:
        return self.record.get(name, default)

    def __getitem__(self, name: str) -> Any:
        return self.record[name]


@dataclass(frozen=True)
class ActionRecord:
    """One action committed by the scheduler at an explicit tick."""

    snapshot_key: str
    author_key: str
    decision_at: datetime
    tick_at: datetime
    policy_name: str
    selection_rank_at_tick: int

    @property
    def selected_at(self) -> datetime:
        """Compatibility alias used by benchmark metric helpers."""

        return self.tick_at


@dataclass(frozen=True)
class MaturedOutcome:
    """Outcome label that is observable at or after its maturity event."""

    snapshot_key: str
    matured_at: datetime
    values: Mapping[str, Any]


@dataclass(frozen=True)
class ReplayContext:
    """Only the evidence state observable to a policy at one tick."""

    tick_at: datetime
    daily_budget: int
    remaining_daily_budget: int
    max_actions_per_tick: int
    prior_actions: tuple[ActionRecord, ...]
    matured_outcomes: tuple[MaturedOutcome, ...]

    def __post_init__(self) -> None:
        if any(action.tick_at >= self.tick_at for action in self.prior_actions):
            raise ReplayValidationError("NON_PAST_ACTION_IN_CONTEXT")
        if any(
            outcome.matured_at > self.tick_at
            for outcome in self.matured_outcomes
        ):
            raise ReplayValidationError("UNMATURED_OUTCOME_IN_CONTEXT")

    @property
    def past_actions(self) -> tuple[ActionRecord, ...]:
        return self.prior_actions

    @property
    def actions(self) -> tuple[ActionRecord, ...]:
        return self.prior_actions

    @property
    def actions_today(self) -> tuple[ActionRecord, ...]:
        return tuple(
            item
            for item in self.prior_actions
            if item.tick_at.date() == self.tick_at.date()
        )

    def prior_actions_for_author(
        self,
        author_key: str,
        *,
        since: datetime | None = None,
    ) -> tuple[ActionRecord, ...]:
        if since is not None:
            _require_same_time_mode(
                (
                    ("context.tick_at", self.tick_at),
                    ("since", since),
                )
            )
        result = tuple(
            item
            for item in self.prior_actions
            if item.author_key == author_key
            and (since is None or item.tick_at >= since)
        )
        return result

    def outcome_for(self, snapshot_key: str) -> MaturedOutcome | None:
        for item in reversed(self.matured_outcomes):
            if item.snapshot_key == snapshot_key:
                return item
        return None


class SchedulerPolicy(Protocol):
    """Minimal policy interface accepted by :func:`run_scheduler_replay`."""

    name: str

    def choose(
        self,
        candidates: tuple[VisibleCandidate, ...],
        context: ReplayContext,
        slots: int,
    ) -> Sequence[str]:
        """Return up to ``slots`` distinct keys from ``candidates``."""


@dataclass(frozen=True)
class ReplayConfig:
    """Explicit clock and workload contract for a replay run."""

    start_at: datetime
    end_at: datetime
    tick_interval: timedelta
    daily_budget: int
    max_actions_per_tick: int = 1
    candidate_ttl: timedelta | None = None

    def __post_init__(self) -> None:
        start = _parse_datetime(self.start_at, field_name="config.start_at")
        end = _parse_datetime(self.end_at, field_name="config.end_at")
        _require_same_time_mode(
            (("config.start_at", start), ("config.end_at", end))
        )
        start = _normalize_datetime(start)
        end = _normalize_datetime(end)
        if end < start:
            raise ReplayValidationError("INVALID_REPLAY_WINDOW")
        if not isinstance(self.tick_interval, timedelta):
            raise ReplayValidationError("TICK_INTERVAL_MUST_BE_TIMEDELTA")
        if self.tick_interval <= timedelta(0):
            raise ReplayValidationError("TICK_INTERVAL_MUST_BE_POSITIVE")
        if isinstance(self.daily_budget, bool) or int(self.daily_budget) < 0:
            raise ReplayValidationError("DAILY_BUDGET_MUST_BE_NONNEGATIVE")
        if (
            isinstance(self.max_actions_per_tick, bool)
            or int(self.max_actions_per_tick) <= 0
        ):
            raise ReplayValidationError(
                "MAX_ACTIONS_PER_TICK_MUST_BE_POSITIVE"
            )
        if self.candidate_ttl is not None:
            if not isinstance(self.candidate_ttl, timedelta):
                raise ReplayValidationError(
                    "CANDIDATE_TTL_MUST_BE_TIMEDELTA"
                )
            if self.candidate_ttl <= timedelta(0):
                raise ReplayValidationError(
                    "CANDIDATE_TTL_MUST_BE_POSITIVE"
                )
        object.__setattr__(self, "start_at", start)
        object.__setattr__(self, "end_at", end)
        object.__setattr__(self, "daily_budget", int(self.daily_budget))
        object.__setattr__(
            self, "max_actions_per_tick", int(self.max_actions_per_tick)
        )


@dataclass(frozen=True)
class TickRecord:
    """Auditable state transition at one scheduler tick."""

    tick_at: datetime
    visible_candidate_keys: tuple[str, ...]
    selected_keys: tuple[str, ...]
    matured_outcome_keys: tuple[str, ...]
    withdrawn_candidate_keys: tuple[str, ...]
    state_censored_candidate_keys: tuple[str, ...]
    remaining_daily_budget_before: int
    slots_offered: int
    remaining_daily_budget_after: int


@dataclass(frozen=True)
class ReplayResult:
    """Deterministic replay output; all collections follow event/key order."""

    actions: tuple[ActionRecord, ...]
    matured_outcomes: tuple[MaturedOutcome, ...]
    ticks: tuple[TickRecord, ...]
    expired_candidate_keys: tuple[str, ...]
    withdrawn_candidate_keys: tuple[str, ...]
    state_censored_candidate_keys: tuple[str, ...]
    pending_candidate_keys: tuple[str, ...]
    future_candidate_keys: tuple[str, ...]
    manifest: Mapping[str, Any]
    summary: Mapping[str, Any]

    @property
    def selected_keys(self) -> tuple[str, ...]:
        return tuple(item.snapshot_key for item in self.actions)


def candidates_from_records(
    records: Iterable[Mapping[str, Any]],
    *,
    outcome_fields: Iterable[str] = DEFAULT_OUTCOME_FIELDS,
) -> tuple[ReplayCandidate, ...]:
    """Convert formal snapshot rows while enforcing outcome partitioning."""

    return tuple(
        ReplayCandidate.from_record(row, outcome_fields=outcome_fields)
        for row in records
    )


def _policy_name(policy: SchedulerPolicy) -> str:
    value = str(getattr(policy, "name", policy.__class__.__name__)).strip()
    return value or policy.__class__.__name__


def _validated_selection(
    raw_selection: Sequence[str],
    *,
    visible: tuple[VisibleCandidate, ...],
    slots: int,
) -> tuple[str, ...]:
    if isinstance(raw_selection, (str, bytes)):
        raise ReplayValidationError("POLICY_SELECTION_MUST_BE_KEY_SEQUENCE")
    try:
        selected = tuple(str(value) for value in raw_selection)
    except TypeError as exc:
        raise ReplayValidationError(
            "POLICY_SELECTION_MUST_BE_KEY_SEQUENCE"
        ) from exc
    if len(selected) > slots:
        raise ReplayValidationError("POLICY_EXCEEDED_TICK_CAPACITY")
    if len(selected) != len(set(selected)):
        raise ReplayValidationError("POLICY_SELECTED_DUPLICATE_CANDIDATE")
    visible_keys = {item.snapshot_key for item in visible}
    hidden = [key for key in selected if key not in visible_keys]
    if hidden:
        raise ReplayValidationError(
            "POLICY_SELECTED_HIDDEN_CANDIDATE:" + ",".join(hidden)
        )
    return selected


def _iter_ticks(config: ReplayConfig) -> Iterable[datetime]:
    tick = config.start_at
    while tick <= config.end_at:
        yield tick
        tick += config.tick_interval


def run_scheduler_replay(
    candidates: Iterable[ReplayCandidate],
    policy: SchedulerPolicy,
    config: ReplayConfig,
) -> ReplayResult:
    """Replay a policy without exposing future candidates, actions, or labels."""

    ordered = tuple(
        sorted(candidates, key=lambda item: (item.decision_at, item.snapshot_key))
    )
    keys = [item.snapshot_key for item in ordered]
    duplicate_keys = sorted(
        key for key, count in Counter(keys).items() if count > 1
    )
    if duplicate_keys:
        raise ReplayValidationError(
            "DUPLICATE_SNAPSHOT_KEY:" + ",".join(duplicate_keys)
        )

    clock_values: list[tuple[str, datetime]] = [
        ("config.start_at", config.start_at),
        ("config.end_at", config.end_at),
    ]
    for item in ordered:
        clock_values.extend(
            (
                (f"{item.snapshot_key}.decision_at", item.decision_at),
                (
                    f"{item.snapshot_key}.outcome_window_end_at",
                    item.outcome_window_end_at,
                ),
            )
        )
        if item.withdraw_at is not None:
            clock_values.append(
                (f"{item.snapshot_key}.withdraw_at", item.withdraw_at)
            )
        if item.state_observed_until is not None:
            clock_values.append(
                (
                    f"{item.snapshot_key}.state_observed_until",
                    item.state_observed_until,
                )
            )
    time_mode = _require_same_time_mode(clock_values)
    choose = getattr(policy, "choose", None)
    if not callable(choose):
        raise ReplayValidationError("POLICY_CHOOSE_REQUIRED")
    policy_name = _policy_name(policy)

    outcome_order = tuple(
        sorted(
            ordered,
            key=lambda item: (
                item.outcome_window_end_at,
                item.snapshot_key,
            ),
        )
    )
    by_key = {item.snapshot_key: item for item in ordered}
    visible_by_key = {
        item.snapshot_key: VisibleCandidate.from_candidate(item)
        for item in ordered
    }
    event_rank = {
        item.snapshot_key: (item.decision_at, item.snapshot_key)
        for item in ordered
    }

    actions: list[ActionRecord] = []
    matured: list[MaturedOutcome] = []
    ticks: list[TickRecord] = []
    pending: dict[str, ReplayCandidate] = {}
    expired: set[str] = set()
    withdrawn: set[str] = set()
    state_censored: set[str] = set()
    acted: set[str] = set()
    arrival_index = 0
    outcome_index = 0
    daily_action_counts: Counter[str] = Counter()

    def advance_state(
        to_time: datetime,
    ) -> tuple[
        tuple[str, ...],
        tuple[str, ...],
        tuple[str, ...],
    ]:
        nonlocal arrival_index, outcome_index

        newly_matured: list[str] = []
        newly_withdrawn: list[str] = []
        newly_state_censored: list[str] = []
        while (
            outcome_index < len(outcome_order)
            and outcome_order[outcome_index].outcome_window_end_at <= to_time
        ):
            item = outcome_order[outcome_index]
            matured.append(
                MaturedOutcome(
                    snapshot_key=item.snapshot_key,
                    matured_at=item.outcome_window_end_at,
                    values=item.outcome,
                )
            )
            newly_matured.append(item.snapshot_key)
            outcome_index += 1

        for key, item in tuple(pending.items()):
            if item.withdraw_at is not None and item.withdraw_at <= to_time:
                withdrawn.add(key)
                newly_withdrawn.append(key)
                del pending[key]
            elif (
                item.state_observed_until is not None
                and item.state_observed_until < to_time
            ):
                state_censored.add(key)
                newly_state_censored.append(key)
                del pending[key]
            elif (
                item.decision_date < to_time.date()
                or item.outcome_window_end_at <= to_time
                or (
                    config.candidate_ttl is not None
                    and item.decision_at + config.candidate_ttl <= to_time
                )
            ):
                expired.add(key)
                del pending[key]

        while (
            arrival_index < len(ordered)
            and ordered[arrival_index].decision_at <= to_time
        ):
            item = ordered[arrival_index]
            arrival_index += 1
            if item.snapshot_key in acted:
                continue
            if item.withdraw_at is not None and item.withdraw_at <= to_time:
                withdrawn.add(item.snapshot_key)
                newly_withdrawn.append(item.snapshot_key)
            elif (
                item.state_observed_until is not None
                and item.state_observed_until < to_time
            ):
                state_censored.add(item.snapshot_key)
                newly_state_censored.append(item.snapshot_key)
            elif (
                item.decision_date < to_time.date()
                or item.outcome_window_end_at <= to_time
                or (
                    config.candidate_ttl is not None
                    and item.decision_at + config.candidate_ttl <= to_time
                )
            ):
                expired.add(item.snapshot_key)
            else:
                pending[item.snapshot_key] = item

        return (
            tuple(newly_matured),
            tuple(newly_withdrawn),
            tuple(newly_state_censored),
        )

    last_tick: datetime | None = None
    for tick_at in _iter_ticks(config):
        (
            newly_matured,
            newly_withdrawn,
            newly_state_censored,
        ) = advance_state(tick_at)
        last_tick = tick_at
        day_key = tick_at.date().isoformat()
        used_today = daily_action_counts[day_key]
        remaining_before = max(0, config.daily_budget - used_today)
        visible = tuple(
            visible_by_key[key]
            for key in sorted(
                pending,
                key=lambda value: event_rank[value],
            )
            if by_key[key].decision_date == tick_at.date()
            and by_key[key].decision_at <= tick_at
            and by_key[key].outcome_window_end_at > tick_at
        )
        slots = min(
            remaining_before,
            config.max_actions_per_tick,
            len(visible),
        )
        selected: tuple[str, ...] = ()
        if slots > 0:
            context = ReplayContext(
                tick_at=tick_at,
                daily_budget=config.daily_budget,
                remaining_daily_budget=remaining_before,
                max_actions_per_tick=config.max_actions_per_tick,
                prior_actions=tuple(actions),
                matured_outcomes=tuple(matured),
            )
            selected = _validated_selection(
                choose(visible, context, slots),
                visible=visible,
                slots=slots,
            )
            for rank, key in enumerate(selected, start=1):
                item = by_key[key]
                actions.append(
                    ActionRecord(
                        snapshot_key=key,
                        author_key=item.author_key,
                        decision_at=item.decision_at,
                        tick_at=tick_at,
                        policy_name=policy_name,
                        selection_rank_at_tick=rank,
                    )
                )
                acted.add(key)
                pending.pop(key, None)
                daily_action_counts[day_key] += 1

        ticks.append(
            TickRecord(
                tick_at=tick_at,
                visible_candidate_keys=tuple(
                    item.snapshot_key for item in visible
                ),
                selected_keys=selected,
                matured_outcome_keys=newly_matured,
                withdrawn_candidate_keys=newly_withdrawn,
                state_censored_candidate_keys=newly_state_censored,
                remaining_daily_budget_before=remaining_before,
                slots_offered=slots,
                remaining_daily_budget_after=max(
                    0,
                    config.daily_budget - daily_action_counts[day_key],
                ),
            )
        )

    # If end_at does not land on the tick grid, advance event state through the
    # declared replay endpoint without inventing an extra scheduler decision.
    if last_tick != config.end_at:
        advance_state(config.end_at)

    expired_keys = tuple(
        sorted(expired, key=lambda key: event_rank[key])
    )
    withdrawn_keys = tuple(
        sorted(withdrawn, key=lambda key: event_rank[key])
    )
    state_censored_keys = tuple(
        sorted(state_censored, key=lambda key: event_rank[key])
    )
    pending_keys = tuple(
        sorted(pending, key=lambda key: event_rank[key])
    )
    future_keys = tuple(
        item.snapshot_key
        for item in ordered
        if item.decision_at > config.end_at
    )
    clock_mode = (
        "aware_normalized_to_utc"
        if time_mode == "aware"
        else "naive_assumed_single_utc_clock"
    )
    manifest: dict[str, Any] = {
        "schema_version": REPLAY_SCHEMA_VERSION,
        "policy": policy_name,
        "start_at": _iso(config.start_at),
        "end_at": _iso(config.end_at),
        "clock_mode": clock_mode,
        "tick_interval_seconds": config.tick_interval.total_seconds(),
        "daily_budget": config.daily_budget,
        "max_actions_per_tick": config.max_actions_per_tick,
        "candidate_ttl_seconds": (
            config.candidate_ttl.total_seconds()
            if config.candidate_ttl is not None
            else None
        ),
        "candidate_ttl_boundary": (
            "decision_at + candidate_ttl <= tick_at expires before selection"
            if config.candidate_ttl is not None
            else None
        ),
        "candidate_visibility_boundary": "decision_at <= tick_at",
        "candidate_withdrawal_boundary": (
            "first external response event_at <= tick_at"
        ),
        "scheduler_state_observation_boundary": (
            "state_observed_until < tick_at censors before selection"
        ),
        "outcome_visibility_boundary": (
            "outcome_window_end_at <= tick_at"
        ),
        "action_history_boundary": "action.tick_at < current tick_at",
        "stable_candidate_order": "decision_at ASC, snapshot_key ASC",
        "candidate_expiry": (
            "external response, source-state censoring, candidate TTL, end "
            "of decision_date, or outcome maturity, "
            "whichever comes first"
            if config.candidate_ttl is not None
            else (
                "external response, source-state censoring, end of "
                "decision_date, or outcome maturity, whichever comes first"
            )
        ),
        "candidate_queue_semantics": (
            "same-date ticks only; no cross-date carry"
        ),
    }
    summary: dict[str, Any] = {
        "candidate_count": len(ordered),
        "tick_count": len(ticks),
        "action_count": len(actions),
        "matured_outcome_count": len(matured),
        "right_censored_outcome_count": sum(
            item.outcome.get("evidence_state") == "right_censored"
            for item in ordered
        ),
        "expired_unselected_count": len(expired_keys),
        "withdrawn_after_external_response_count": len(withdrawn_keys),
        "scheduler_state_censored_count": len(state_censored_keys),
        "pending_at_end_count": len(pending_keys),
        "future_candidate_count": len(future_keys),
        "daily_action_counts": dict(sorted(daily_action_counts.items())),
    }
    return ReplayResult(
        actions=tuple(actions),
        matured_outcomes=tuple(matured),
        ticks=tuple(ticks),
        expired_candidate_keys=expired_keys,
        withdrawn_candidate_keys=withdrawn_keys,
        state_censored_candidate_keys=state_censored_keys,
        pending_candidate_keys=pending_keys,
        future_candidate_keys=future_keys,
        manifest=manifest,
        summary=summary,
    )
