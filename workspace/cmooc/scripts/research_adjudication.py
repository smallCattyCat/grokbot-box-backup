#!/usr/bin/env python3
"""Compare two independent blind coding sheets and finalize adjudication."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import random
import re
import shutil
import tempfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from statistics import mean, median
from typing import Any, Iterable, Mapping, Sequence

from research_review import (
    BLIND_COLUMNS,
    FUNCTION_LABELS,
    ReviewError,
    validate_annotations,
)


SCHEMA_VERSION = "p1f-dual-coder-agreement-v1"
BATCH_SCHEMA_VERSION = "p1d-facilitation-review-v1"
OUTPUT_ROOT_ENV = "CMOOC_ADJUDICATION_OUTPUT_ROOT"
BOOTSTRAP_REPLICATES = 2000
LOW_CONFIDENCE_THRESHOLD = 0.60
CONSENSUS_CODER_ID = "consensus_round12"

ISSUE_CODES = {
    "presence_disagreement",
    "primary_disagreement",
    "secondary_disagreement",
    "low_confidence",
}
REASON_CODES = {
    "consensus_after_review",
    "evidence_favors_a",
    "evidence_favors_b",
    "insufficient_context",
}
IMMUTABLE_ADJUDICATION_COLUMNS = (
    "display_order",
    "review_item_id",
    "issue_codes",
    "coder_a_presence",
    "coder_b_presence",
    "coder_a_primary",
    "coder_b_primary",
    "coder_a_secondary",
    "coder_b_secondary",
    "coder_a_confidence",
    "coder_b_confidence",
)
ADJUDICATION_COLUMNS = IMMUTABLE_ADJUDICATION_COLUMNS + (
    "adjudicated_presence",
    "adjudicated_primary",
    "adjudicated_secondary",
    "adjudication_confidence",
    "adjudicator_id",
    "reason_code",
    "adjudication_status",
)


class AdjudicationError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Annotation:
    display_order: int
    review_item_id: str
    facilitation_present: str
    primary_function: str
    secondary_functions: tuple[str, ...]
    confidence: float
    coder_id: str
    annotation_round: int
    adjudication_status: str


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _contains(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _is_unc(path: Path) -> bool:
    return str(path).startswith("\\\\")


def _default_output_root() -> Path:
    configured = os.environ.get(OUTPUT_ROOT_ENV)
    if configured:
        return Path(configured).expanduser().resolve()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise AdjudicationError("LOCAL_OUTPUT_ROOT_REQUIRED")
    return Path(local_app_data).resolve() / "cmooc-research" / "p1f"


def _validate_new_output_dir(value: str) -> Path:
    root = _default_output_root()
    output = Path(value).expanduser().resolve(strict=False)
    if _is_unc(root) or _is_unc(output):
        raise AdjudicationError("UNC_OUTPUT_FORBIDDEN")
    if not _contains(root, output) or output == root:
        raise AdjudicationError("OUTPUT_OUTSIDE_LOCAL_ROOT")
    if _contains(_repo_root().resolve(), output):
        raise AdjudicationError("SYNCED_OUTPUT_FORBIDDEN")
    if output.exists():
        raise AdjudicationError("OUTPUT_ALREADY_EXISTS")
    root.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    return output


def _validate_comparison_dir(value: str) -> Path:
    root = _default_output_root()
    comparison = Path(value).expanduser().resolve()
    if _is_unc(root) or _is_unc(comparison) or not _contains(root, comparison):
        raise AdjudicationError("COMPARISON_OUTSIDE_LOCAL_ROOT")
    if not comparison.is_dir() or _contains(_repo_root().resolve(), comparison):
        raise AdjudicationError("COMPARISON_UNAVAILABLE")
    return comparison


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _load_batch(batch_dir: Path) -> tuple[dict[str, Any], dict[str, int]]:
    try:
        manifest = json.loads(
            (batch_dir / "private-manifest.json").read_text(encoding="utf-8")
        )
    except (OSError, json.JSONDecodeError) as exc:
        raise AdjudicationError("REVIEW_BATCH_INVALID") from exc
    if (
        manifest.get("schema_version") != BATCH_SCHEMA_VERSION
        or not isinstance(manifest.get("items"), list)
        or not re.fullmatch(r"batch_[A-Za-z0-9_-]{1,64}", str(manifest.get("batch_id", "")))
    ):
        raise AdjudicationError("REVIEW_BATCH_INVALID")
    try:
        expected = {
            str(item.get("review_item_id", "")): int(item.get("display_order", 0))
            for item in manifest["items"]
        }
    except (AttributeError, TypeError, ValueError) as exc:
        raise AdjudicationError("REVIEW_BATCH_INVALID") from exc
    if (
        not expected
        or len(expected) != len(manifest["items"])
        or any(
            not re.fullmatch(r"review_[A-Za-z0-9_-]{1,64}", review_id) or order <= 0
            for review_id, order in expected.items()
        )
        or len(set(expected.values())) != len(expected)
    ):
        raise AdjudicationError("REVIEW_BATCH_INVALID")
    return manifest, expected


def _read_annotations(
    batch_dir: Path,
    path: Path,
    *,
    expected_round: int,
    expected_status: str,
) -> tuple[str, dict[str, Annotation]]:
    try:
        validation = validate_annotations(str(batch_dir), str(path))
    except ReviewError as exc:
        raise AdjudicationError(f"CODER_SHEET_{exc.code}") from exc
    if validation["coder_count"] != 1 or validation["annotation_rounds"] != [expected_round]:
        raise AdjudicationError("CODER_SHEET_PROVENANCE_INVALID")
    rows: dict[str, Annotation] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            secondary = json.loads(str(row["secondary_functions"]))
            annotation = Annotation(
                display_order=int(str(row["display_order"])),
                review_item_id=str(row["review_item_id"]),
                facilitation_present=str(row["facilitation_present"]),
                primary_function=str(row["primary_function"]),
                secondary_functions=tuple(sorted(secondary)),
                confidence=float(str(row["confidence"])),
                coder_id=str(row["coder_id"]),
                annotation_round=int(str(row["annotation_round"])),
                adjudication_status=str(row["adjudication_status"]),
            )
            if annotation.adjudication_status != expected_status:
                raise AdjudicationError("CODER_SHEET_PROVENANCE_INVALID")
            rows[annotation.review_item_id] = annotation
    coder_ids = {annotation.coder_id for annotation in rows.values()}
    if len(coder_ids) != 1:
        raise AdjudicationError("CODER_SHEET_PROVENANCE_INVALID")
    return next(iter(coder_ids)), rows


def _cohen_kappa(labels_a: Sequence[str], labels_b: Sequence[str]) -> float | None:
    if len(labels_a) != len(labels_b) or not labels_a:
        return None
    n = len(labels_a)
    observed = sum(a == b for a, b in zip(labels_a, labels_b)) / n
    counts_a = Counter(labels_a)
    counts_b = Counter(labels_b)
    expected = sum(
        (counts_a[label] / n) * (counts_b[label] / n)
        for label in set(counts_a) | set(counts_b)
    )
    if math.isclose(expected, 1.0):
        return None
    return (observed - expected) / (1.0 - expected)


def _quantile(values: Sequence[float], probability: float) -> float:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("values required")
    position = (len(ordered) - 1) * probability
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def _bootstrap_ci(
    paired_values: Sequence[tuple[Any, Any]],
    statistic: Any,
    seed: str,
) -> list[float] | None:
    if len(paired_values) < 2:
        return None
    seed_value = int(hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16], 16)
    generator = random.Random(seed_value)
    estimates: list[float] = []
    for _ in range(BOOTSTRAP_REPLICATES):
        sample = [paired_values[generator.randrange(len(paired_values))] for _ in paired_values]
        value = statistic(sample)
        if value is not None and math.isfinite(value):
            estimates.append(float(value))
    if len(estimates) < BOOTSTRAP_REPLICATES // 2:
        return None
    return [round(_quantile(estimates, 0.025), 4), round(_quantile(estimates, 0.975), 4)]


def _nominal_agreement(labels_a: Sequence[str], labels_b: Sequence[str], seed: str) -> dict[str, Any]:
    pairs = list(zip(labels_a, labels_b))
    observed = sum(a == b for a, b in pairs) / len(pairs) if pairs else None
    kappa = _cohen_kappa(labels_a, labels_b)
    ci = _bootstrap_ci(
        pairs,
        lambda sample: _cohen_kappa(
            [str(pair[0]) for pair in sample], [str(pair[1]) for pair in sample]
        ),
        seed,
    )
    return {
        "n": len(pairs),
        "observed_agreement": None if observed is None else round(observed, 4),
        "cohen_kappa": None if kappa is None else round(kappa, 4),
        "cohen_kappa_bootstrap_95_ci": ci,
        "bootstrap_replicates": BOOTSTRAP_REPLICATES,
        "degenerate_marginals": kappa is None and bool(pairs),
    }


def _confusion(labels_a: Sequence[str], labels_b: Sequence[str]) -> dict[str, dict[str, int]]:
    categories = sorted(set(labels_a) | set(labels_b))
    return {
        row: {column: sum(a == row and b == column for a, b in zip(labels_a, labels_b)) for column in categories}
        for row in categories
    }


def _jaccard(first: Sequence[str], second: Sequence[str]) -> float:
    left, right = set(first), set(second)
    union = left | right
    return 1.0 if not union else len(left & right) / len(union)


def _secondary_agreement(pairs: Sequence[tuple[tuple[str, ...], tuple[str, ...]]], seed: str) -> dict[str, Any]:
    values = [_jaccard(first, second) for first, second in pairs]
    ci = _bootstrap_ci(
        list(pairs),
        lambda sample: mean(_jaccard(first, second) for first, second in sample),
        seed,
    )
    return {
        "n": len(values),
        "exact_set_agreement": None if not values else round(sum(value == 1.0 for value in values) / len(values), 4),
        "mean_jaccard": None if not values else round(mean(values), 4),
        "median_jaccard": None if not values else round(median(values), 4),
        "mean_jaccard_bootstrap_95_ci": ci,
        "bootstrap_replicates": BOOTSTRAP_REPLICATES,
    }


def _issues(first: Annotation, second: Annotation) -> tuple[str, ...]:
    issues: list[str] = []
    if first.facilitation_present != second.facilitation_present:
        issues.append("presence_disagreement")
    elif first.facilitation_present == "yes":
        if first.primary_function != second.primary_function:
            issues.append("primary_disagreement")
        if set(first.secondary_functions) != set(second.secondary_functions):
            issues.append("secondary_disagreement")
    if min(first.confidence, second.confidence) < LOW_CONFIDENCE_THRESHOLD:
        issues.append("low_confidence")
    return tuple(sorted(issues))


def _secondary_json(values: Sequence[str]) -> str:
    return json.dumps(sorted(values), ensure_ascii=False, separators=(",", ":"))


def _immutable_row(first: Annotation, second: Annotation) -> dict[str, str]:
    issues = _issues(first, second)
    return {
        "display_order": str(first.display_order),
        "review_item_id": first.review_item_id,
        "issue_codes": "|".join(issues),
        "coder_a_presence": first.facilitation_present,
        "coder_b_presence": second.facilitation_present,
        "coder_a_primary": first.primary_function,
        "coder_b_primary": second.primary_function,
        "coder_a_secondary": _secondary_json(first.secondary_functions),
        "coder_b_secondary": _secondary_json(second.secondary_functions),
        "coder_a_confidence": f"{first.confidence:.2f}",
        "coder_b_confidence": f"{second.confidence:.2f}",
    }


def _adjudication_template_row(first: Annotation, second: Annotation) -> dict[str, str]:
    row = _immutable_row(first, second)
    row.update({column: "" for column in ADJUDICATION_COLUMNS if column not in row})
    return row


def _write_csv(path: Path, columns: Sequence[str], rows: Sequence[Mapping[str, Any]]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def _load_pair(
    batch_dir_value: str,
    coder_a_value: str,
    coder_b_value: str,
) -> tuple[
    Path,
    Path,
    Path,
    dict[str, Any],
    dict[str, int],
    str,
    str,
    dict[str, Annotation],
    dict[str, Annotation],
]:
    batch_dir = Path(batch_dir_value).expanduser().resolve()
    coder_a_path = Path(coder_a_value).expanduser().resolve()
    coder_b_path = Path(coder_b_value).expanduser().resolve()
    if not coder_a_path.is_file() or not coder_b_path.is_file():
        raise AdjudicationError("CODER_SHEET_UNAVAILABLE")
    manifest, expected = _load_batch(batch_dir)
    coder_a_id, coder_a = _read_annotations(
        batch_dir, coder_a_path, expected_round=1, expected_status="single_coded"
    )
    coder_b_id, coder_b = _read_annotations(
        batch_dir, coder_b_path, expected_round=2, expected_status="double_coded"
    )
    if coder_a_id == coder_b_id:
        raise AdjudicationError("CODERS_MUST_BE_DISTINCT")
    if set(coder_a) != set(expected) or set(coder_b) != set(expected):
        raise AdjudicationError("CODER_SHEET_ITEM_SET_INVALID")
    return (
        batch_dir,
        coder_a_path,
        coder_b_path,
        manifest,
        expected,
        coder_a_id,
        coder_b_id,
        coder_a,
        coder_b,
    )


def _agreement_report(
    batch_id: str,
    expected: Mapping[str, int],
    coder_a: Mapping[str, Annotation],
    coder_b: Mapping[str, Annotation],
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    ordered_ids = sorted(expected, key=expected.__getitem__)
    first = [coder_a[review_id] for review_id in ordered_ids]
    second = [coder_b[review_id] for review_id in ordered_ids]
    presence_a = [item.facilitation_present for item in first]
    presence_b = [item.facilitation_present for item in second]
    dual_yes = [
        (left, right)
        for left, right in zip(first, second)
        if left.facilitation_present == right.facilitation_present == "yes"
    ]
    primary_a = [left.primary_function for left, _ in dual_yes]
    primary_b = [right.primary_function for _, right in dual_yes]
    secondary_pairs = [
        (left.secondary_functions, right.secondary_functions) for left, right in dual_yes
    ]
    queue = [
        _adjudication_template_row(left, right)
        for left, right in zip(first, second)
        if _issues(left, right)
    ]
    issue_counts = Counter(
        issue
        for left, right in zip(first, second)
        for issue in _issues(left, right)
    )
    report = {
        "schema_version": SCHEMA_VERSION,
        "batch_id": batch_id,
        "item_count": len(ordered_ids),
        "presence": {
            **_nominal_agreement(presence_a, presence_b, f"{batch_id}|presence"),
            "confusion_matrix_coder_a_rows": _confusion(presence_a, presence_b),
        },
        "primary_function_dual_yes": {
            **_nominal_agreement(primary_a, primary_b, f"{batch_id}|primary"),
            "confusion_matrix_coder_a_rows": _confusion(primary_a, primary_b),
            "conditioning_rule": "both_coders_facilitation_present_yes",
        },
        "secondary_functions_dual_yes": _secondary_agreement(
            secondary_pairs, f"{batch_id}|secondary"
        ),
        "confidence": {
            "coder_a_mean": round(mean(item.confidence for item in first), 4),
            "coder_b_mean": round(mean(item.confidence for item in second), 4),
            "coder_a_below_0_60": sum(item.confidence < LOW_CONFIDENCE_THRESHOLD for item in first),
            "coder_b_below_0_60": sum(item.confidence < LOW_CONFIDENCE_THRESHOLD for item in second),
        },
        "adjudication": {
            "item_count": len(queue),
            "item_share": round(len(queue) / len(ordered_ids), 4),
            "issue_counts": dict(sorted(issue_counts.items())),
            "trigger_rule": "presence_or_primary_or_secondary_disagreement_or_any_confidence_below_0.60",
        },
        "identity_blind": True,
        "content_copied": False,
        "inference_performed": False,
    }
    return report, queue


def compare_annotations(
    *,
    batch_dir_value: str,
    coder_a_value: str,
    coder_b_value: str,
    output_dir_value: str,
) -> dict[str, Any]:
    (
        batch_dir,
        coder_a_path,
        coder_b_path,
        batch,
        expected,
        coder_a_id,
        coder_b_id,
        coder_a,
        coder_b,
    ) = _load_pair(batch_dir_value, coder_a_value, coder_b_value)
    output_dir = _validate_new_output_dir(output_dir_value)
    report, queue = _agreement_report(
        str(batch["batch_id"]), expected, coder_a, coder_b
    )
    comparison_manifest = {
        "schema_version": SCHEMA_VERSION,
        "batch_id": batch["batch_id"],
        "batch_manifest_sha256": _file_sha256(batch_dir / "private-manifest.json"),
        "coder_a": {"coder_id": coder_a_id, "sha256": _file_sha256(coder_a_path), "annotation_round": 1},
        "coder_b": {"coder_id": coder_b_id, "sha256": _file_sha256(coder_b_path), "annotation_round": 2},
        "item_count": len(expected),
        "adjudication_item_count": len(queue),
        "identity_blind": True,
        "content_copied": False,
    }
    temp_dir = Path(tempfile.mkdtemp(prefix=".p1f-compare-", dir=output_dir.parent))
    try:
        _write_json(temp_dir / "agreement.json", report)
        _write_json(temp_dir / "comparison-manifest.json", comparison_manifest)
        _write_csv(temp_dir / "adjudication.csv", ADJUDICATION_COLUMNS, queue)
        try:
            temp_dir.rename(output_dir)
        except FileExistsError as exc:
            raise AdjudicationError("OUTPUT_ALREADY_EXISTS") from exc
    finally:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
    return {
        "ok": True,
        "mode": "compare",
        "schema_version": SCHEMA_VERSION,
        "batch_id": batch["batch_id"],
        "item_count": len(expected),
        "adjudication_item_count": len(queue),
        "identity_blind": True,
        "content_copied": False,
    }


def _load_comparison_manifest(comparison_dir: Path) -> dict[str, Any]:
    try:
        manifest = json.loads(
            (comparison_dir / "comparison-manifest.json").read_text(encoding="utf-8")
        )
    except (OSError, json.JSONDecodeError) as exc:
        raise AdjudicationError("COMPARISON_MANIFEST_INVALID") from exc
    required = {
        "schema_version",
        "batch_id",
        "batch_manifest_sha256",
        "coder_a",
        "coder_b",
        "item_count",
        "adjudication_item_count",
        "identity_blind",
        "content_copied",
    }
    if (
        not isinstance(manifest, dict)
        or set(manifest) != required
        or manifest["schema_version"] != SCHEMA_VERSION
        or manifest["identity_blind"] is not True
        or manifest["content_copied"] is not False
    ):
        raise AdjudicationError("COMPARISON_MANIFEST_INVALID")
    return manifest


def _validate_outcome(row: Mapping[str, str]) -> tuple[str, str, tuple[str, ...], float, str, str]:
    presence = row["adjudicated_presence"].strip()
    primary = row["adjudicated_primary"].strip()
    try:
        secondary_raw = json.loads(row["adjudicated_secondary"])
        confidence = float(row["adjudication_confidence"])
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise AdjudicationError("ADJUDICATION_VALUE_INVALID") from exc
    adjudicator_id = row["adjudicator_id"].strip()
    reason_code = row["reason_code"].strip()
    if (
        presence not in {"yes", "no", "uncertain"}
        or isinstance(confidence, bool)
        or not 0.0 <= confidence <= 1.0
        or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", adjudicator_id)
        or reason_code not in REASON_CODES
        or row["adjudication_status"].strip() != "adjudicated"
        or not isinstance(secondary_raw, list)
        or any(not isinstance(label, str) for label in secondary_raw)
        or len(secondary_raw) != len(set(secondary_raw))
        or any(label not in FUNCTION_LABELS for label in secondary_raw)
    ):
        raise AdjudicationError("ADJUDICATION_VALUE_INVALID")
    secondary = tuple(sorted(secondary_raw))
    if presence == "yes":
        if primary not in FUNCTION_LABELS or primary in secondary:
            raise AdjudicationError("ADJUDICATION_VALUE_INVALID")
    elif primary or secondary:
        raise AdjudicationError("ADJUDICATION_VALUE_INVALID")
    return presence, primary, secondary, confidence, adjudicator_id, reason_code


def _read_adjudications(
    path: Path,
    expected_rows: Mapping[str, Mapping[str, str]],
) -> dict[str, tuple[str, str, tuple[str, ...], float, str, str]]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if tuple(reader.fieldnames or ()) != ADJUDICATION_COLUMNS:
                raise AdjudicationError("ADJUDICATION_HEADERS_INVALID")
            rows = list(reader)
    except OSError as exc:
        raise AdjudicationError("ADJUDICATION_FILE_UNAVAILABLE") from exc
    observed_ids = [str(row.get("review_item_id", "")) for row in rows]
    if len(observed_ids) != len(set(observed_ids)) or set(observed_ids) != set(expected_rows):
        raise AdjudicationError("ADJUDICATION_ITEM_SET_INVALID")
    outcomes: dict[str, tuple[str, str, tuple[str, ...], float, str, str]] = {}
    for row in rows:
        review_id = str(row["review_item_id"])
        expected = expected_rows[review_id]
        if any(str(row[column]) != str(expected[column]) for column in IMMUTABLE_ADJUDICATION_COLUMNS):
            raise AdjudicationError("ADJUDICATION_SOURCE_CHANGED")
        outcomes[review_id] = _validate_outcome(row)
    return outcomes


def finalize_adjudication(
    *,
    batch_dir_value: str,
    coder_a_value: str,
    coder_b_value: str,
    comparison_dir_value: str,
    adjudications_value: str,
) -> dict[str, Any]:
    (
        batch_dir,
        coder_a_path,
        coder_b_path,
        batch,
        expected,
        coder_a_id,
        coder_b_id,
        coder_a,
        coder_b,
    ) = _load_pair(batch_dir_value, coder_a_value, coder_b_value)
    comparison_dir = _validate_comparison_dir(comparison_dir_value)
    adjudications_path = Path(adjudications_value).expanduser().resolve()
    if not adjudications_path.is_file() or not _contains(comparison_dir, adjudications_path):
        raise AdjudicationError("ADJUDICATION_OUTSIDE_COMPARISON_DIR")
    manifest = _load_comparison_manifest(comparison_dir)
    if (
        manifest["batch_id"] != batch["batch_id"]
        or manifest["batch_manifest_sha256"] != _file_sha256(batch_dir / "private-manifest.json")
        or manifest["coder_a"] != {"coder_id": coder_a_id, "sha256": _file_sha256(coder_a_path), "annotation_round": 1}
        or manifest["coder_b"] != {"coder_id": coder_b_id, "sha256": _file_sha256(coder_b_path), "annotation_round": 2}
        or manifest["item_count"] != len(expected)
    ):
        raise AdjudicationError("COMPARISON_SOURCE_CHANGED")

    ordered_ids = sorted(expected, key=expected.__getitem__)
    expected_queue = {
        review_id: _immutable_row(coder_a[review_id], coder_b[review_id])
        for review_id in ordered_ids
        if _issues(coder_a[review_id], coder_b[review_id])
    }
    if manifest["adjudication_item_count"] != len(expected_queue):
        raise AdjudicationError("COMPARISON_SOURCE_CHANGED")
    outcomes = _read_adjudications(adjudications_path, expected_queue)

    final_rows: list[dict[str, Any]] = []
    reason_counts: Counter[str] = Counter()
    for review_id in ordered_ids:
        first, second = coder_a[review_id], coder_b[review_id]
        if review_id in outcomes:
            presence, primary, secondary, confidence, _, reason_code = outcomes[review_id]
            status = "adjudicated"
            reason_counts[reason_code] += 1
        else:
            presence = first.facilitation_present
            primary = first.primary_function
            secondary = first.secondary_functions
            confidence = min(first.confidence, second.confidence)
            status = "double_coded"
        final_rows.append(
            {
                "display_order": expected[review_id],
                "review_item_id": review_id,
                "facilitation_present": presence,
                "primary_function": primary,
                "secondary_functions": _secondary_json(secondary),
                "confidence": f"{confidence:.2f}",
                "coder_id": CONSENSUS_CODER_ID,
                "annotation_round": 2,
                "adjudication_status": status,
            }
        )

    final_path = comparison_dir / "final-adjudicated.csv"
    summary_path = comparison_dir / "final-summary.json"
    if final_path.exists() or summary_path.exists():
        raise AdjudicationError("FINAL_OUTPUT_ALREADY_EXISTS")
    temp_dir = Path(tempfile.mkdtemp(prefix=".p1f-final-", dir=comparison_dir))
    try:
        temp_final = temp_dir / final_path.name
        _write_csv(temp_final, BLIND_COLUMNS, final_rows)
        try:
            validation = validate_annotations(str(batch_dir), str(temp_final))
        except ReviewError as exc:
            raise AdjudicationError(f"FINAL_{exc.code}") from exc
        summary = {
            "schema_version": SCHEMA_VERSION,
            "batch_id": batch["batch_id"],
            "item_count": len(final_rows),
            "double_coded_count": sum(row["adjudication_status"] == "double_coded" for row in final_rows),
            "adjudicated_count": len(outcomes),
            "adjudication_reason_counts": dict(sorted(reason_counts.items())),
            "presence_counts": validation["presence_counts"],
            "primary_function_counts": validation["primary_function_counts"],
            "confidence_for_agreements": "minimum_of_two_coders",
            "identity_blind": True,
            "content_copied": False,
            "database_written": False,
        }
        _write_json(temp_dir / summary_path.name, summary)
        try:
            os.replace(temp_final, final_path)
            os.replace(temp_dir / summary_path.name, summary_path)
        except OSError as exc:
            final_path.unlink(missing_ok=True)
            summary_path.unlink(missing_ok=True)
            raise AdjudicationError("FINAL_WRITE_FAILED") from exc
    finally:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
    return {
        "ok": True,
        "mode": "finalize",
        "schema_version": SCHEMA_VERSION,
        "batch_id": batch["batch_id"],
        "item_count": len(final_rows),
        "adjudicated_count": len(outcomes),
        "identity_blind": True,
        "content_copied": False,
        "database_written": False,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    compare = subparsers.add_parser("compare", help="compare two independent coding sheets")
    compare.add_argument("--batch-dir", required=True)
    compare.add_argument("--coder-a", required=True)
    compare.add_argument("--coder-b", required=True)
    compare.add_argument("--output-dir", required=True)
    finalize = subparsers.add_parser("finalize", help="validate adjudication and create consensus CSV")
    finalize.add_argument("--batch-dir", required=True)
    finalize.add_argument("--coder-a", required=True)
    finalize.add_argument("--coder-b", required=True)
    finalize.add_argument("--comparison-dir", required=True)
    finalize.add_argument("--adjudications", required=True)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = _parser().parse_args(list(argv) if argv is not None else None)
    try:
        if args.command == "compare":
            result = compare_annotations(
                batch_dir_value=args.batch_dir,
                coder_a_value=args.coder_a,
                coder_b_value=args.coder_b,
                output_dir_value=args.output_dir,
            )
        else:
            result = finalize_adjudication(
                batch_dir_value=args.batch_dir,
                coder_a_value=args.coder_a,
                coder_b_value=args.coder_b,
                comparison_dir_value=args.comparison_dir,
                adjudications_value=args.adjudications,
            )
    except AdjudicationError as exc:
        print(json.dumps({"ok": False, "error": exc.code}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
