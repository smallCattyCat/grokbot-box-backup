"""Independent point-in-time SQL oracle for anonymous or synthetic events.

DuckDB is preferred when it is already installed. The module never installs
dependencies; Python's standard-library SQLite engine is the deterministic
fallback. The SQL implementation is intentionally separate from the Python
reference loop so the two paths can expose boundary mistakes in each other.
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.util
import json
import sqlite3
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Sequence


ORACLE_SCHEMA_VERSION = "cmooc-decision-point-in-time-oracle-v2"
ORACLE_AUDIT_SCHEMA_VERSION = "cmooc-decision-point-in-time-oracle-audit-v2"

ORACLE_RESULT_FIELDS = (
    "snapshot_key",
    "comment_count_asof",
    "external_comment_count_asof",
    "self_comment_count_asof",
    "unique_external_author_count_asof",
    "reply_edge_count_asof",
    "first_external_response_after_decision_microseconds",
    "external_response_count_in_window",
    "unique_external_responder_count_in_window",
    "organic_external_response_in_window",
    "support_gap_at_horizon",
)


class OracleInputError(ValueError):
    pass


class OracleBackendUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class SqlBackendStatus:
    """Read-only dependency probe result."""

    selected_backend: str
    duckdb_available: bool
    fallback_used: bool
    detail: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def detect_sql_backend(preferred: str = "auto") -> SqlBackendStatus:
    """Select DuckDB when present, otherwise use standard-library SQLite."""

    if preferred not in {"auto", "duckdb", "sqlite"}:
        raise ValueError("preferred backend must be auto, duckdb, or sqlite")

    duckdb_available = importlib.util.find_spec("duckdb") is not None
    if preferred == "sqlite":
        return SqlBackendStatus(
            selected_backend="sqlite",
            duckdb_available=duckdb_available,
            fallback_used=False,
            detail="sqlite_explicitly_selected",
        )
    if duckdb_available:
        return SqlBackendStatus(
            selected_backend="duckdb",
            duckdb_available=True,
            fallback_used=False,
            detail="duckdb_available",
        )
    if preferred == "duckdb":
        return SqlBackendStatus(
            selected_backend="sqlite",
            duckdb_available=False,
            fallback_used=True,
            detail="duckdb_not_installed_using_stdlib_sqlite",
        )
    return SqlBackendStatus(
        selected_backend="sqlite",
        duckdb_available=False,
        fallback_used=True,
        detail="duckdb_not_installed_using_stdlib_sqlite",
    )


def _parse_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        text = value.strip()
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        parsed = datetime.fromisoformat(text)
    else:
        raise OracleInputError(
            "timestamp must be a datetime or ISO-8601 string"
        )

    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _timestamp_microseconds(value: Any) -> int:
    parsed = _parse_timestamp(value)
    epoch = datetime(1970, 1, 1)
    delta = parsed - epoch
    return (
        delta.days * 86_400_000_000
        + delta.seconds * 1_000_000
        + delta.microseconds
    )


def _required_text(row: Mapping[str, Any], field: str) -> str:
    value = row.get(field)
    if not isinstance(value, str) or not value.strip():
        raise OracleInputError(f"missing or invalid {field}")
    if any(ord(character) < 32 for character in value):
        raise OracleInputError(f"control character in {field}")
    return value


def _binary_flag(row: Mapping[str, Any], field: str, *, default: int = 0) -> int:
    value = row.get(field, default)
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int) and value in (0, 1):
        return value
    raise OracleInputError(f"{field} must be 0 or 1")


def _prepare_inputs(
    decisions: Iterable[Mapping[str, Any]],
    events: Iterable[Mapping[str, Any]],
) -> tuple[list[tuple[str, str, int, int]], list[tuple[str, str, str, int, int, int]]]:
    prepared_decisions: list[tuple[str, str, int, int]] = []
    prepared_events: list[tuple[str, str, str, int, int, int]] = []
    snapshot_keys: set[str] = set()
    event_keys: set[str] = set()

    for row in decisions:
        snapshot_key = _required_text(row, "snapshot_key")
        thread_key = _required_text(row, "thread_key")
        if snapshot_key in snapshot_keys:
            raise OracleInputError("duplicate snapshot_key")
        snapshot_keys.add(snapshot_key)
        decision_at = _timestamp_microseconds(row.get("decision_at"))
        outcome_end = _timestamp_microseconds(
            row.get("outcome_window_end_at")
        )
        if outcome_end <= decision_at:
            raise OracleInputError(
                "outcome_window_end_at must be after decision_at"
            )
        prepared_decisions.append(
            (snapshot_key, thread_key, decision_at, outcome_end)
        )

    for row in events:
        event_key = _required_text(row, "event_key")
        thread_key = _required_text(row, "thread_key")
        actor_key = _required_text(row, "actor_key")
        if event_key in event_keys:
            raise OracleInputError("duplicate event_key")
        event_keys.add(event_key)
        prepared_events.append(
            (
                event_key,
                thread_key,
                actor_key,
                _timestamp_microseconds(row.get("event_time")),
                _binary_flag(row, "is_external"),
                _binary_flag(row, "is_reply"),
            )
        )

    prepared_decisions.sort(key=lambda row: row[0])
    prepared_events.sort(key=lambda row: row[0])
    return prepared_decisions, prepared_events


def _result_row(
    *,
    snapshot_key: str,
    comment_count_asof: int,
    external_comment_count_asof: int,
    self_comment_count_asof: int,
    unique_external_author_count_asof: int,
    reply_edge_count_asof: int,
    first_external_response_after_decision_microseconds: int,
    external_response_count_in_window: int,
    unique_external_responder_count_in_window: int,
) -> dict[str, Any]:
    return {
        "snapshot_key": snapshot_key,
        "comment_count_asof": int(comment_count_asof),
        "external_comment_count_asof": int(
            external_comment_count_asof
        ),
        "self_comment_count_asof": int(self_comment_count_asof),
        "unique_external_author_count_asof": int(
            unique_external_author_count_asof
        ),
        "reply_edge_count_asof": int(reply_edge_count_asof),
        "first_external_response_after_decision_microseconds": int(
            first_external_response_after_decision_microseconds
        ),
        "external_response_count_in_window": int(
            external_response_count_in_window
        ),
        "unique_external_responder_count_in_window": int(
            unique_external_responder_count_in_window
        ),
        "organic_external_response_in_window": int(
            external_response_count_in_window > 0
        ),
        "support_gap_at_horizon": int(
            external_comment_count_asof == 0
            and external_response_count_in_window == 0
        ),
    }


def python_point_in_time_recompute(
    decisions: Iterable[Mapping[str, Any]],
    events: Iterable[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Reference implementation using explicit Python boundary checks."""

    prepared_decisions, prepared_events = _prepare_inputs(decisions, events)
    events_by_thread: dict[
        str, list[tuple[str, str, str, int, int, int]]
    ] = defaultdict(list)
    for event in prepared_events:
        events_by_thread[event[1]].append(event)
    results: list[dict[str, Any]] = []
    for snapshot_key, thread_key, decision_at, outcome_end in prepared_decisions:
        thread_events = events_by_thread.get(thread_key, [])
        asof = [row for row in thread_events if row[3] <= decision_at]
        outcome = [
            row
            for row in thread_events
            if decision_at < row[3] <= outcome_end and row[4] == 1
        ]
        external_asof = [row for row in asof if row[4] == 1]
        results.append(
            _result_row(
                snapshot_key=snapshot_key,
                comment_count_asof=len(asof),
                external_comment_count_asof=len(external_asof),
                self_comment_count_asof=sum(
                    1 for row in asof if row[4] == 0
                ),
                unique_external_author_count_asof=len(
                    {row[2] for row in external_asof}
                ),
                reply_edge_count_asof=sum(row[5] for row in asof),
                first_external_response_after_decision_microseconds=(
                    min(row[3] - decision_at for row in outcome)
                    if outcome
                    else -1
                ),
                external_response_count_in_window=len(outcome),
                unique_external_responder_count_in_window=len(
                    {row[2] for row in outcome}
                ),
            )
        )
    return results


_POINT_IN_TIME_SQL = """
WITH aggregated AS (
    SELECT
        d.snapshot_key AS snapshot_key,
        COALESCE(SUM(
            CASE WHEN e.event_at_us <= d.decision_at_us THEN 1 ELSE 0 END
        ), 0) AS comment_count_asof,
        COALESCE(SUM(
            CASE
                WHEN e.event_at_us <= d.decision_at_us
                 AND e.is_external = 1
                THEN 1 ELSE 0
            END
        ), 0) AS external_comment_count_asof,
        COALESCE(SUM(
            CASE
                WHEN e.event_at_us <= d.decision_at_us
                 AND e.is_external = 0
                THEN 1 ELSE 0
            END
        ), 0) AS self_comment_count_asof,
        COUNT(DISTINCT CASE
            WHEN e.event_at_us <= d.decision_at_us
             AND e.is_external = 1
            THEN e.actor_key
        END) AS unique_external_author_count_asof,
        COALESCE(SUM(
            CASE
                WHEN e.event_at_us <= d.decision_at_us
                 AND e.is_reply = 1
                THEN 1 ELSE 0
            END
        ), 0) AS reply_edge_count_asof,
        COALESCE(MIN(
            CASE
                WHEN e.event_at_us > d.decision_at_us
                 AND e.event_at_us <= d.outcome_end_us
                 AND e.is_external = 1
                THEN e.event_at_us - d.decision_at_us
            END
        ), -1) AS first_external_response_after_decision_microseconds,
        COALESCE(SUM(
            CASE
                WHEN e.event_at_us > d.decision_at_us
                 AND e.event_at_us <= d.outcome_end_us
                 AND e.is_external = 1
                THEN 1 ELSE 0
            END
        ), 0) AS external_response_count_in_window,
        COUNT(DISTINCT CASE
            WHEN e.event_at_us > d.decision_at_us
             AND e.event_at_us <= d.outcome_end_us
             AND e.is_external = 1
            THEN e.actor_key
        END) AS unique_external_responder_count_in_window
    FROM oracle_decisions AS d
    LEFT JOIN oracle_events AS e
      ON e.thread_key = d.thread_key
    GROUP BY d.snapshot_key
)
SELECT
    snapshot_key,
    comment_count_asof,
    external_comment_count_asof,
    self_comment_count_asof,
    unique_external_author_count_asof,
    reply_edge_count_asof,
    first_external_response_after_decision_microseconds,
    external_response_count_in_window,
    unique_external_responder_count_in_window,
    CASE
        WHEN external_response_count_in_window > 0 THEN 1 ELSE 0
    END AS organic_external_response_in_window,
    CASE
        WHEN external_comment_count_asof = 0
         AND external_response_count_in_window = 0
        THEN 1 ELSE 0
    END AS support_gap_at_horizon
FROM aggregated
ORDER BY snapshot_key
"""


def _create_sql_tables(
    connection: Any,
    decisions: Sequence[tuple[str, str, int, int]],
    events: Sequence[tuple[str, str, str, int, int, int]],
) -> None:
    connection.execute(
        """
        CREATE TABLE oracle_decisions (
            snapshot_key TEXT PRIMARY KEY,
            thread_key TEXT NOT NULL,
            decision_at_us BIGINT NOT NULL,
            outcome_end_us BIGINT NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE oracle_events (
            event_key TEXT PRIMARY KEY,
            thread_key TEXT NOT NULL,
            actor_key TEXT NOT NULL,
            event_at_us BIGINT NOT NULL,
            is_external INTEGER NOT NULL,
            is_reply INTEGER NOT NULL
        )
        """
    )
    connection.executemany(
        "INSERT INTO oracle_decisions VALUES (?, ?, ?, ?)",
        decisions,
    )
    connection.executemany(
        "INSERT INTO oracle_events VALUES (?, ?, ?, ?, ?, ?)",
        events,
    )
    connection.execute(
        "CREATE INDEX oracle_events_thread_time_idx "
        "ON oracle_events(thread_key, event_at_us)"
    )


def sql_point_in_time_recompute(
    decisions: Iterable[Mapping[str, Any]],
    events: Iterable[Mapping[str, Any]],
    *,
    preferred_backend: str = "auto",
) -> tuple[list[dict[str, Any]], SqlBackendStatus]:
    """Run the independent SQL implementation and report the selected engine."""

    prepared_decisions, prepared_events = _prepare_inputs(decisions, events)
    backend = detect_sql_backend(preferred_backend)
    if backend.selected_backend == "duckdb":
        try:
            duckdb = importlib.import_module("duckdb")
        except (ImportError, OSError) as error:
            if preferred_backend == "duckdb":
                raise OracleBackendUnavailable(
                    "DuckDB was detected but could not be imported"
                ) from error
            backend = SqlBackendStatus(
                selected_backend="sqlite",
                duckdb_available=False,
                fallback_used=True,
                detail="duckdb_import_failed_using_stdlib_sqlite",
            )
            connection: Any = sqlite3.connect(":memory:")
        else:
            connection = duckdb.connect(database=":memory:")
    else:
        connection = sqlite3.connect(":memory:")

    try:
        _create_sql_tables(connection, prepared_decisions, prepared_events)
        cursor = connection.execute(_POINT_IN_TIME_SQL)
        raw_rows = cursor.fetchall()
        columns = [item[0] for item in cursor.description]
    finally:
        connection.close()

    results: list[dict[str, Any]] = []
    for raw in raw_rows:
        row = dict(zip(columns, raw, strict=True))
        normalized = {
            field: (
                str(row[field])
                if field == "snapshot_key"
                else int(row[field])
            )
            for field in ORACLE_RESULT_FIELDS
        }
        results.append(normalized)
    return results, backend


def _result_hash(rows: Sequence[Mapping[str, Any]]) -> str:
    payload = json.dumps(
        list(rows),
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def compare_point_in_time_implementations(
    decisions: Iterable[Mapping[str, Any]],
    events: Iterable[Mapping[str, Any]],
    *,
    preferred_backend: str = "auto",
) -> dict[str, Any]:
    """Return a row-free equality audit for Python versus SQL."""

    decision_rows = list(decisions)
    event_rows = list(events)
    python_rows = python_point_in_time_recompute(decision_rows, event_rows)
    sql_rows, backend = sql_point_in_time_recompute(
        decision_rows,
        event_rows,
        preferred_backend=preferred_backend,
    )

    python_by_key = {str(row["snapshot_key"]): row for row in python_rows}
    sql_by_key = {str(row["snapshot_key"]): row for row in sql_rows}
    mismatches_by_field: dict[str, int] = {}
    key_set_mismatch_count = len(
        set(python_by_key).symmetric_difference(sql_by_key)
    )
    shared_keys = sorted(set(python_by_key).intersection(sql_by_key))
    for field in ORACLE_RESULT_FIELDS[1:]:
        count = sum(
            python_by_key[key].get(field) != sql_by_key[key].get(field)
            for key in shared_keys
        )
        if count:
            mismatches_by_field[field] = count

    mismatch_count = key_set_mismatch_count + sum(
        mismatches_by_field.values()
    )
    summary: dict[str, Any] = {
        "schema_version": ORACLE_AUDIT_SCHEMA_VERSION,
        "oracle_schema_version": ORACLE_SCHEMA_VERSION,
        "contains_row_level_data": False,
        "status": "passed" if mismatch_count == 0 else "failed",
        "decision_count": len(decision_rows),
        "event_count": len(event_rows),
        "compared_row_count": len(shared_keys),
        "key_set_mismatch_count": key_set_mismatch_count,
        "mismatch_count": mismatch_count,
        "mismatches_by_field": dict(sorted(mismatches_by_field.items())),
        "python_result_hash": _result_hash(python_rows),
        "sql_result_hash": _result_hash(sql_rows),
        "backend": backend.to_dict(),
    }
    summary["audit_hash"] = hashlib.sha256(
        json.dumps(
            summary,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    return summary


__all__ = [
    "ORACLE_AUDIT_SCHEMA_VERSION",
    "ORACLE_RESULT_FIELDS",
    "ORACLE_SCHEMA_VERSION",
    "OracleBackendUnavailable",
    "OracleInputError",
    "SqlBackendStatus",
    "compare_point_in_time_implementations",
    "detect_sql_backend",
    "python_point_in_time_recompute",
    "sql_point_in_time_recompute",
]
