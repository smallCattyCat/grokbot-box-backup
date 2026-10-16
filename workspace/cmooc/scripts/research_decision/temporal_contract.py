"""Machine-readable temporal contract and aggregate leakage audit.

The audit API accepts in-memory provenance rows and deliberately returns only
aggregate counts. It never returns snapshot keys, event keys, or timestamps.
This keeps the contract useful for formal research artifacts without turning
the audit report into another row-level dataset.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Iterable, Mapping


CONTRACT_SCHEMA_VERSION = "cmooc-decision-snapshot-temporal-contract-v2"
AUDIT_SCHEMA_VERSION = "cmooc-decision-snapshot-temporal-audit-v2"
TIME_BASIS = "naive_platform_local_time_no_dst_adjustment"


class TemporalRole(str, Enum):
    """How a formal snapshot field relates to the decision clock."""

    METADATA = "metadata"
    STABLE_KEY = "stable_key"
    CLOCK = "clock"
    FEATURE = "feature"
    OUTCOME = "outcome"
    DERIVED_FEATURE = "derived_feature"
    DERIVED_OUTCOME = "derived_outcome"
    AUDIT = "audit"


@dataclass(frozen=True)
class TemporalFieldSpec:
    """Temporal definition for one formal decision-snapshot field."""

    name: str
    role: TemporalRole
    source_timestamp: str
    as_of_operator: str
    allowed_max_time: str
    lower_anchor: str | None = None
    lower_offset_seconds: int = 0
    lower_inclusive: bool = False
    upper_anchor: str | None = None
    upper_offset_seconds: int = 0
    upper_inclusive: bool = True
    description: str = ""

    @property
    def is_event_sourced(self) -> bool:
        return self.role in (TemporalRole.FEATURE, TemporalRole.OUTCOME)

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["role"] = self.role.value
        return result


@dataclass(frozen=True)
class TemporalContract:
    """Complete point-in-time contract for decision_snapshot v2."""

    schema_version: str
    time_basis: str
    stable_key_fields: tuple[str, ...]
    event_stable_key_fields: tuple[str, ...]
    decision_time_field: str
    outcome_end_field: str
    fields: tuple[TemporalFieldSpec, ...]

    def __post_init__(self) -> None:
        _validate_contract_definition(self)

    @property
    def fields_by_name(self) -> dict[str, TemporalFieldSpec]:
        return {field.name: field for field in self.fields}

    def to_manifest(self) -> dict[str, Any]:
        """Return a deterministic, row-free, machine-readable manifest."""

        body: dict[str, Any] = {
            "schema_version": self.schema_version,
            "time_basis": self.time_basis,
            "stable_key_fields": list(self.stable_key_fields),
            "event_stable_key_fields": list(self.event_stable_key_fields),
            "decision_time_field": self.decision_time_field,
            "outcome_end_field": self.outcome_end_field,
            "contains_row_level_data": False,
            "fields": [field.to_dict() for field in self.fields],
        }
        body["contract_hash"] = _canonical_hash(body)
        return body


class TemporalContractViolation(ValueError):
    """Raised with an aggregate summary when strict audit mode fails."""

    def __init__(self, summary: Mapping[str, Any]):
        self.summary = dict(summary)
        codes = ", ".join(
            f"{name}={count}"
            for name, count in self.summary.get("violations_by_code", {}).items()
        )
        super().__init__(
            f"temporal contract audit failed with "
            f"{self.summary.get('violation_count', 0)} violation(s)"
            + (f": {codes}" if codes else "")
        )


def _canonical_hash(value: Any) -> str:
    encoded = json.dumps(
        value, ensure_ascii=True, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _validate_contract_definition(contract: TemporalContract) -> None:
    names = [field.name for field in contract.fields]
    if len(names) != len(set(names)):
        raise ValueError("temporal contract field names must be unique")

    fields = {field.name: field for field in contract.fields}
    for key in contract.stable_key_fields:
        if key not in fields or fields[key].role is not TemporalRole.STABLE_KEY:
            raise ValueError(f"stable key field is not declared as stable_key: {key}")

    if contract.decision_time_field not in fields:
        raise ValueError("decision time field is not declared")
    if contract.outcome_end_field not in fields:
        raise ValueError("outcome end field is not declared")

    valid_anchors = {
        None,
        contract.decision_time_field,
        contract.outcome_end_field,
    }
    for field in contract.fields:
        if field.lower_anchor not in valid_anchors:
            raise ValueError(f"invalid lower anchor for {field.name}")
        if field.upper_anchor not in valid_anchors:
            raise ValueError(f"invalid upper anchor for {field.name}")
        if not field.source_timestamp or not field.as_of_operator:
            raise ValueError(f"incomplete temporal declaration for {field.name}")
        if not field.allowed_max_time:
            raise ValueError(f"missing allowed_max_time for {field.name}")

        if field.role is TemporalRole.FEATURE:
            if field.upper_anchor != contract.decision_time_field:
                raise ValueError(f"feature {field.name} must end at decision_at")
            if field.allowed_max_time != contract.decision_time_field:
                raise ValueError(
                    f"feature {field.name} must declare decision_at as max time"
                )
        elif field.role is TemporalRole.OUTCOME:
            if (
                field.lower_anchor != contract.decision_time_field
                or field.lower_inclusive
                or field.upper_anchor != contract.outcome_end_field
                or not field.upper_inclusive
            ):
                raise ValueError(
                    f"outcome {field.name} must use (decision_at, outcome_end]"
                )
            if field.allowed_max_time != contract.outcome_end_field:
                raise ValueError(
                    f"outcome {field.name} must declare outcome end as max time"
                )


def _plain(
    name: str,
    role: TemporalRole,
    *,
    source: str,
    operator: str,
    maximum: str = "not_applicable",
    description: str = "",
) -> TemporalFieldSpec:
    return TemporalFieldSpec(
        name=name,
        role=role,
        source_timestamp=source,
        as_of_operator=operator,
        allowed_max_time=maximum,
        description=description,
    )


def _feature(
    name: str,
    *,
    source: str,
    operator: str = "event_time <= decision_at",
    upper_inclusive: bool = True,
    lower_offset_seconds: int | None = None,
    lower_inclusive: bool = False,
    description: str = "",
) -> TemporalFieldSpec:
    return TemporalFieldSpec(
        name=name,
        role=TemporalRole.FEATURE,
        source_timestamp=source,
        as_of_operator=operator,
        allowed_max_time="decision_at",
        lower_anchor=(
            "decision_at" if lower_offset_seconds is not None else None
        ),
        lower_offset_seconds=lower_offset_seconds or 0,
        lower_inclusive=lower_inclusive,
        upper_anchor="decision_at",
        upper_inclusive=upper_inclusive,
        description=description,
    )


def _outcome(
    name: str,
    *,
    source: str,
    description: str = "",
) -> TemporalFieldSpec:
    return TemporalFieldSpec(
        name=name,
        role=TemporalRole.OUTCOME,
        source_timestamp=source,
        as_of_operator=(
            "decision_at < event_time <= outcome_window_end_at"
        ),
        allowed_max_time="outcome_window_end_at",
        lower_anchor="decision_at",
        lower_inclusive=False,
        upper_anchor="outcome_window_end_at",
        upper_inclusive=True,
        description=description,
    )


def build_default_contract() -> TemporalContract:
    """Build the frozen decision_snapshot v2 temporal contract."""

    prior_7d = -7 * 24 * 60 * 60
    fields = (
        _plain(
            "schema_version",
            TemporalRole.METADATA,
            source="not_event_sourced",
            operator="constant",
        ),
        _plain(
            "snapshot_key",
            TemporalRole.STABLE_KEY,
            source="stable_hmac_key",
            operator="identity",
        ),
        _plain(
            "thread_key",
            TemporalRole.STABLE_KEY,
            source="stable_hmac_key",
            operator="identity",
        ),
        _plain(
            "course_key",
            TemporalRole.STABLE_KEY,
            source="stable_hmac_key",
            operator="identity",
        ),
        _plain(
            "author_key",
            TemporalRole.STABLE_KEY,
            source="stable_hmac_key",
            operator="identity",
        ),
        _plain(
            "year",
            TemporalRole.METADATA,
            source="post.created_at",
            operator="calendar_year",
            maximum="decision_at",
        ),
        _plain(
            "decision_at",
            TemporalRole.CLOCK,
            source="post.created_at",
            operator="post.created_at + frozen_decision_lag",
            maximum="decision_at",
        ),
        _plain(
            "decision_date",
            TemporalRole.CLOCK,
            source="decision_at",
            operator="platform_calendar_date",
            maximum="decision_at",
        ),
        _plain(
            "decision_lag_hours",
            TemporalRole.METADATA,
            source="development_year_first_response_distribution",
            operator="frozen_constant",
        ),
        _plain(
            "outcome_window_end_at",
            TemporalRole.CLOCK,
            source="post.created_at",
            operator="post.created_at + frozen_outcome_lag",
            maximum="outcome_window_end_at",
        ),
        _plain(
            "outcome_window_hours",
            TemporalRole.METADATA,
            source="decision_at,outcome_window_end_at",
            operator="duration",
            maximum="outcome_window_end_at",
        ),
        _feature("comment_count_asof", source="comment.created_at"),
        _feature(
            "external_comment_count_asof",
            source="comment.created_at",
        ),
        _feature("self_comment_count_asof", source="comment.created_at"),
        _feature(
            "unique_external_author_count_asof",
            source="comment.created_at",
        ),
        _feature(
            "reply_edge_count_asof",
            source="max(comment.created_at,parent_comment.created_at)",
        ),
        _feature(
            "max_reply_depth_asof",
            source="max(comment.created_at,parent_chain.created_at)",
        ),
        _feature(
            "future_parent_reference_count_asof",
            source="comment.created_at",
            description=(
                "Legacy field name: count parent references unresolved among "
                "events visible at decision_at. Later events are never checked."
            ),
        ),
        _feature(
            "author_prior_post_count_asof",
            source="prior_post.created_at",
            operator="event_time < decision_at",
            upper_inclusive=False,
        ),
        _feature(
            "author_prior_external_response_count_asof",
            source="prior_post.first_external_response_at",
        ),
        _plain(
            "author_prior_external_response_rate_asof",
            TemporalRole.DERIVED_FEATURE,
            source=(
                "author_prior_post_count_asof,"
                "author_prior_external_response_count_asof"
            ),
            operator="derived_only_from_asof_features",
            maximum="decision_at",
        ),
        _feature(
            "author_prior_matured_gap_count_asof",
            source="prior_post.outcome_window_end_at",
            description=(
                "A prior gap is eligible only after its complete outcome "
                "window has matured."
            ),
        ),
        _feature(
            "course_post_count_prior_7d_asof",
            source="post.created_at",
            operator="decision_at - 7d < event_time <= decision_at",
            lower_offset_seconds=prior_7d,
            lower_inclusive=False,
        ),
        _feature(
            "course_external_comment_count_prior_7d_asof",
            source="comment.created_at",
            operator="decision_at - 7d < event_time <= decision_at",
            lower_offset_seconds=prior_7d,
            lower_inclusive=False,
        ),
        _plain(
            "decision_eligibility",
            TemporalRole.DERIVED_FEATURE,
            source="external_comment_count_asof",
            operator="derived_only_from_asof_features",
            maximum="decision_at",
        ),
        _plain(
            "suggested_function",
            TemporalRole.DERIVED_FEATURE,
            source="asof_structural_features",
            operator="controlled_label_from_asof_features",
            maximum="decision_at",
        ),
        _plain(
            "outcome_observable",
            TemporalRole.DERIVED_OUTCOME,
            source="dataset_observation_horizon",
            operator="horizon_reached",
            maximum="outcome_window_end_at",
        ),
        _plain(
            "source_observation_end_after_decision_microseconds",
            TemporalRole.AUDIT,
            source="dataset_observation_horizon",
            operator="exact_relative_scheduler_state_horizon",
            maximum="outcome_window_end_at",
            description=(
                "Exact integer-microsecond horizon through which scheduler "
                "state is observed, capped at the outcome endpoint. It is "
                "hidden from policies and censors a candidate when the source "
                "ends before a scheduler tick."
            ),
        ),
        _outcome(
            "first_external_response_after_decision_microseconds",
            source="comment.created_at",
            description=(
                "Exact integer-microsecond lag to the first subsequent external "
                "response. It is hidden from policies and becomes a replay "
                "withdrawal event only when that event time is at or before the "
                "scheduler tick."
            ),
        ),
        _outcome(
            "organic_external_response_in_window",
            source="comment.created_at",
        ),
        _outcome(
            "external_response_count_in_window",
            source="comment.created_at",
        ),
        _outcome(
            "unique_external_responder_count_in_window",
            source="comment.created_at",
        ),
        _plain(
            "support_gap_at_horizon",
            TemporalRole.DERIVED_OUTCOME,
            source=(
                "external_comment_count_asof,"
                "external_response_count_in_window"
            ),
            operator="derived_at_outcome_window_end",
            maximum="outcome_window_end_at",
        ),
        _plain(
            "feature_hash",
            TemporalRole.AUDIT,
            source="formal_asof_feature_fields",
            operator="canonical_hash",
            maximum="decision_at",
        ),
        _plain(
            "asof_boundary_ok",
            TemporalRole.AUDIT,
            source="temporal_contract_audit",
            operator="all_feature_provenance_within_contract",
            maximum="decision_at",
        ),
    )
    return TemporalContract(
        schema_version=CONTRACT_SCHEMA_VERSION,
        time_basis=TIME_BASIS,
        stable_key_fields=(
            "snapshot_key",
            "thread_key",
            "course_key",
            "author_key",
        ),
        event_stable_key_fields=(
            "snapshot_key",
            "field_name",
            "event_key",
        ),
        decision_time_field="decision_at",
        outcome_end_field="outcome_window_end_at",
        fields=fields,
    )


DEFAULT_CONTRACT = build_default_contract()


def contract_manifest(
    contract: TemporalContract = DEFAULT_CONTRACT,
) -> dict[str, Any]:
    """Public row-free manifest interface."""

    return contract.to_manifest()


def _parse_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        text = value.strip()
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        parsed = datetime.fromisoformat(text)
    else:
        raise ValueError("timestamp must be a datetime or ISO-8601 string")

    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _valid_key(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    return not any(ord(character) < 32 for character in value)


def _anchor_time(
    anchor: str | None,
    *,
    decision_at: datetime,
    outcome_end: datetime,
) -> datetime | None:
    if anchor is None:
        return None
    if anchor == "decision_at":
        return decision_at
    if anchor == "outcome_window_end_at":
        return outcome_end
    raise ValueError(f"unsupported temporal anchor: {anchor}")


def _event_window_violation(
    spec: TemporalFieldSpec,
    *,
    event_time: datetime,
    decision_at: datetime,
    outcome_end: datetime,
) -> str | None:
    lower = _anchor_time(
        spec.lower_anchor,
        decision_at=decision_at,
        outcome_end=outcome_end,
    )
    if lower is not None:
        lower += timedelta(seconds=spec.lower_offset_seconds)
        if event_time < lower or (
            event_time == lower and not spec.lower_inclusive
        ):
            if spec.role is TemporalRole.OUTCOME:
                return "outcome_not_after_decision"
            return "event_before_or_at_window_start"

    upper = _anchor_time(
        spec.upper_anchor,
        decision_at=decision_at,
        outcome_end=outcome_end,
    )
    if upper is not None:
        upper += timedelta(seconds=spec.upper_offset_seconds)
        if event_time > upper:
            if spec.role is TemporalRole.OUTCOME:
                return "outcome_after_window_end"
            return "feature_after_decision"
        if event_time == upper and not spec.upper_inclusive:
            return "feature_not_before_decision"
    return None


def audit_temporal_rows(
    decisions: Iterable[Mapping[str, Any]],
    feature_events: Iterable[Mapping[str, Any]] = (),
    outcome_events: Iterable[Mapping[str, Any]] = (),
    *,
    contract: TemporalContract = DEFAULT_CONTRACT,
    raise_on_violation: bool = False,
) -> dict[str, Any]:
    """Audit provenance without returning row-level values.

    Decision rows require all contract stable keys plus ``decision_at`` and
    ``outcome_window_end_at``. Event rows require ``snapshot_key``,
    ``field_name``, ``event_key``, ``source_timestamp``, and ``event_time``.
    Feature and outcome provenance are supplied separately so an outcome event
    cannot silently enter the feature namespace.
    """

    decision_rows = list(decisions)
    feature_rows = list(feature_events)
    outcome_rows = list(outcome_events)
    fields = contract.fields_by_name
    violations_by_code: Counter[str] = Counter()
    violations_by_field: Counter[str] = Counter()

    def add_violation(code: str, field: str = "<record>") -> None:
        violations_by_code[code] += 1
        violations_by_field[field] += 1

    clocks: dict[str, tuple[datetime, datetime]] = {}
    seen_snapshot_keys: set[str] = set()
    for row in decision_rows:
        for key_field in contract.stable_key_fields:
            if not _valid_key(row.get(key_field)):
                add_violation("invalid_or_missing_stable_key", key_field)

        snapshot_key = row.get("snapshot_key")
        snapshot_key_valid = _valid_key(snapshot_key)
        if snapshot_key_valid:
            snapshot_text = str(snapshot_key)
            if snapshot_text in seen_snapshot_keys:
                add_violation("duplicate_snapshot_key", "snapshot_key")
            seen_snapshot_keys.add(snapshot_text)

        try:
            decision_at = _parse_timestamp(
                row.get(contract.decision_time_field)
            )
            outcome_end = _parse_timestamp(row.get(contract.outcome_end_field))
        except (TypeError, ValueError):
            add_violation("invalid_decision_clock", "<clock>")
            continue

        if outcome_end <= decision_at:
            add_violation("nonpositive_outcome_window", "<clock>")
        if snapshot_key_valid and str(snapshot_key) not in clocks:
            clocks[str(snapshot_key)] = (decision_at, outcome_end)

    seen_event_refs: set[tuple[str, str, str, str]] = set()

    def audit_events(
        rows: list[Mapping[str, Any]], expected_role: TemporalRole
    ) -> None:
        namespace = expected_role.value
        for row in rows:
            field_name_value = row.get("field_name")
            field_name = (
                str(field_name_value)
                if isinstance(field_name_value, str)
                and field_name_value.strip()
                else "<unknown>"
            )
            spec = fields.get(field_name)
            if spec is None:
                add_violation("unknown_contract_field", field_name)
                continue
            if spec.role is not expected_role:
                add_violation("event_role_mismatch", field_name)
                continue

            snapshot_key = row.get("snapshot_key")
            event_key = row.get("event_key")
            if not _valid_key(snapshot_key) or not _valid_key(event_key):
                add_violation("invalid_or_missing_event_key", field_name)
                continue

            event_ref = (
                namespace,
                str(snapshot_key),
                field_name,
                str(event_key),
            )
            if event_ref in seen_event_refs:
                add_violation("duplicate_event_reference", field_name)
                continue
            seen_event_refs.add(event_ref)

            clock = clocks.get(str(snapshot_key))
            if clock is None:
                add_violation("unknown_snapshot_reference", field_name)
                continue

            if row.get("source_timestamp") != spec.source_timestamp:
                add_violation("source_timestamp_mismatch", field_name)

            try:
                event_time = _parse_timestamp(row.get("event_time"))
            except (TypeError, ValueError):
                add_violation("invalid_event_timestamp", field_name)
                continue

            window_violation = _event_window_violation(
                spec,
                event_time=event_time,
                decision_at=clock[0],
                outcome_end=clock[1],
            )
            if window_violation is not None:
                add_violation(window_violation, field_name)

    audit_events(feature_rows, TemporalRole.FEATURE)
    audit_events(outcome_rows, TemporalRole.OUTCOME)

    violation_count = sum(violations_by_code.values())
    summary: dict[str, Any] = {
        "schema_version": AUDIT_SCHEMA_VERSION,
        "contract_schema_version": contract.schema_version,
        "contract_hash": contract.to_manifest()["contract_hash"],
        "contains_row_level_data": False,
        "status": "passed" if violation_count == 0 else "failed",
        "decision_count": len(decision_rows),
        "feature_event_count": len(feature_rows),
        "outcome_event_count": len(outcome_rows),
        "checked_event_count": len(feature_rows) + len(outcome_rows),
        "violation_count": violation_count,
        "violations_by_code": dict(sorted(violations_by_code.items())),
        "violations_by_field": dict(sorted(violations_by_field.items())),
    }
    summary["audit_hash"] = _canonical_hash(summary)

    if raise_on_violation and violation_count:
        raise TemporalContractViolation(summary)
    return summary


__all__ = [
    "AUDIT_SCHEMA_VERSION",
    "CONTRACT_SCHEMA_VERSION",
    "DEFAULT_CONTRACT",
    "TIME_BASIS",
    "TemporalContract",
    "TemporalContractViolation",
    "TemporalFieldSpec",
    "TemporalRole",
    "audit_temporal_rows",
    "build_default_contract",
    "contract_manifest",
]
