#!/usr/bin/env python3
"""Shared blind-order and integrity contract for decision-reference batches."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping, Sequence


REFERENCE_INTEGRITY_VERSION = "cmooc-decision-reference-integrity-v1"
REFERENCE_BLIND_ORDER_VERSION = "cmooc-decision-reference-blind-order-v1"
REFERENCE_INTEGRITY_FIELDS = (
    "selection_integrity_version",
    "blind_order_version",
    "selection_membership_sha256",
    "selection_order_sha256",
)
_MEMBERSHIP_FIELDS = (
    "snapshot_key",
    "thread_key",
    "course_key",
    "author_key",
    "year",
    "decision_at",
)


class ReferenceIntegrityError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _field(row: Any, name: str) -> str:
    if isinstance(row, Mapping):
        value = row.get(name, "")
    else:
        value = getattr(row, name, "")
    return "" if value is None else str(value)


def _canonical_sha256(value: Any) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def reference_blind_order_key(row: Any) -> tuple[str, str]:
    """Order solely by a domain-separated hash of the anonymous snapshot key."""
    snapshot_key = _field(row, "snapshot_key")
    digest = hashlib.sha256(
        (
            REFERENCE_BLIND_ORDER_VERSION
            + "\x1f"
            + snapshot_key
        ).encode("utf-8")
    ).hexdigest()
    return digest, snapshot_key


def reference_integrity(rows: Sequence[Any]) -> dict[str, str]:
    membership = sorted(
        (
            {field: _field(row, field) for field in _MEMBERSHIP_FIELDS}
            for row in rows
        ),
        key=lambda item: (
            item["snapshot_key"],
            item["thread_key"],
        ),
    )
    order = [
        {
            "reference_id": _field(row, "reference_id"),
            "snapshot_key": _field(row, "snapshot_key"),
        }
        for row in rows
    ]
    return {
        "selection_integrity_version": REFERENCE_INTEGRITY_VERSION,
        "blind_order_version": REFERENCE_BLIND_ORDER_VERSION,
        "selection_membership_sha256": _canonical_sha256(membership),
        "selection_order_sha256": _canonical_sha256(order),
    }


def has_complete_reference_integrity(manifest: Mapping[str, Any]) -> bool:
    present = {
        field for field in REFERENCE_INTEGRITY_FIELDS if field in manifest
    }
    if present and len(present) != len(REFERENCE_INTEGRITY_FIELDS):
        raise ReferenceIntegrityError(
            "REFERENCE_INTEGRITY_MANIFEST_INVALID"
        )
    return len(present) == len(REFERENCE_INTEGRITY_FIELDS)


def verify_reference_integrity(
    manifest: Mapping[str, Any], rows: Sequence[Any]
) -> dict[str, str]:
    if not has_complete_reference_integrity(manifest):
        raise ReferenceIntegrityError(
            "REFERENCE_INTEGRITY_MANIFEST_REQUIRED"
        )
    if (
        manifest.get("selection_integrity_version")
        != REFERENCE_INTEGRITY_VERSION
        or manifest.get("blind_order_version")
        != REFERENCE_BLIND_ORDER_VERSION
    ):
        raise ReferenceIntegrityError(
            "REFERENCE_INTEGRITY_VERSION_INVALID"
        )

    expected = reference_integrity(rows)
    if (
        manifest.get("selection_membership_sha256")
        != expected["selection_membership_sha256"]
    ):
        raise ReferenceIntegrityError(
            "REFERENCE_MEMBERSHIP_DIGEST_MISMATCH"
        )
    if (
        manifest.get("selection_order_sha256")
        != expected["selection_order_sha256"]
    ):
        raise ReferenceIntegrityError(
            "REFERENCE_ORDER_DIGEST_MISMATCH"
        )

    canonical = sorted(rows, key=reference_blind_order_key)
    canonical_snapshots = [
        _field(row, "snapshot_key") for row in canonical
    ]
    actual_snapshots = [
        _field(row, "snapshot_key") for row in rows
    ]
    expected_references = [
        f"DR{index:03d}" for index in range(1, len(rows) + 1)
    ]
    actual_references = [
        _field(row, "reference_id") for row in rows
    ]
    if (
        actual_snapshots != canonical_snapshots
        or actual_references != expected_references
    ):
        raise ReferenceIntegrityError(
            "REFERENCE_ORDER_DIGEST_MISMATCH"
        )
    return expected
