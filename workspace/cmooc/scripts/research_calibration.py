#!/usr/bin/env python3
"""Plan a held-out human calibration subset from a partial blind pilot."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import shutil
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Mapping, Sequence

from research_review import BLIND_COLUMNS, ReviewError, validate_annotations
from research_adjudication import (
    ADJUDICATION_COLUMNS,
    Annotation,
    _agreement_report,
    _bootstrap_ci,
    _write_csv,
)


SCHEMA_VERSION = "p1g-human-calibration-plan-v1"
REFERENCE_SCHEMA_VERSION = "p1g-human-reference-selection-v1"
PRIMARY_REFERENCE_SCHEMA_VERSION = "p1g-human-primary-reference-candidate-v1"
COMPARISON_SCHEMA_VERSION = "p1g-human-calibration-comparison-v1"
BATCH_SCHEMA_VERSION = "p1d-facilitation-review-v1"
OUTPUT_ROOT_ENV = "CMOOC_CALIBRATION_OUTPUT_ROOT"
SELECTION_COLUMNS = ("display_order", "review_item_id")
Z_95 = 1.959963984540054


class CalibrationError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _contains(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _default_output_root() -> Path:
    configured = os.environ.get(OUTPUT_ROOT_ENV)
    if configured:
        return Path(configured).expanduser().resolve()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise CalibrationError("LOCAL_OUTPUT_ROOT_REQUIRED")
    return Path(local_app_data).resolve() / "cmooc-research" / "p1g"


def _validate_new_output_dir(value: str) -> Path:
    root = _default_output_root()
    output = Path(value).expanduser().resolve(strict=False)
    if (
        str(root).startswith("\\\\")
        or str(output).startswith("\\\\")
        or not _contains(root, output)
        or output == root
        or _contains(_repo_root().resolve(), output)
    ):
        raise CalibrationError("OUTPUT_OUTSIDE_LOCAL_ROOT")
    if output.exists():
        raise CalibrationError("OUTPUT_ALREADY_EXISTS")
    root.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    return output


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_batch(batch_dir: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    try:
        manifest = json.loads((batch_dir / "private-manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CalibrationError("REVIEW_BATCH_INVALID") from exc
    items = manifest.get("items")
    if manifest.get("schema_version") != BATCH_SCHEMA_VERSION or not isinstance(items, list):
        raise CalibrationError("REVIEW_BATCH_INVALID")
    normalized: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_orders: set[int] = set()
    for item in items:
        if not isinstance(item, dict):
            raise CalibrationError("REVIEW_BATCH_INVALID")
        review_id = str(item.get("review_item_id", ""))
        category = str(item.get("sampling_category", ""))
        try:
            display_order = int(item.get("display_order", 0))
        except (TypeError, ValueError) as exc:
            raise CalibrationError("REVIEW_BATCH_INVALID") from exc
        if (
            not re.fullmatch(r"review_[A-Za-z0-9_-]{1,64}", review_id)
            or not category
            or display_order <= 0
            or review_id in seen_ids
            or display_order in seen_orders
        ):
            raise CalibrationError("REVIEW_BATCH_INVALID")
        seen_ids.add(review_id)
        seen_orders.add(display_order)
        normalized.append({
            "review_item_id": review_id,
            "display_order": display_order,
            "sampling_category": category,
        })
    if not normalized:
        raise CalibrationError("REVIEW_BATCH_INVALID")
    return manifest, normalized


def _load_pilot_rows(path: Path) -> list[dict[str, str]]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            return list(csv.DictReader(handle))
    except OSError as exc:
        raise CalibrationError("PILOT_FILE_UNAVAILABLE") from exc


def _load_validation_selection(path: Path) -> tuple[dict[str, int], str]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if tuple(reader.fieldnames or ()) != SELECTION_COLUMNS:
                raise CalibrationError("SELECTION_FILE_INVALID")
            rows = list(reader)
    except OSError as exc:
        raise CalibrationError("SELECTION_FILE_UNAVAILABLE") from exc
    expected: dict[str, int] = {}
    orders: set[int] = set()
    for row in rows:
        review_id = str(row.get("review_item_id", ""))
        try:
            display_order = int(str(row.get("display_order", "")))
        except ValueError as exc:
            raise CalibrationError("SELECTION_FILE_INVALID") from exc
        if (
            not re.fullmatch(r"review_[A-Za-z0-9_-]{1,64}", review_id)
            or display_order <= 0
            or review_id in expected
            or display_order in orders
        ):
            raise CalibrationError("SELECTION_FILE_INVALID")
        expected[review_id] = display_order
        orders.add(display_order)
    if not expected:
        raise CalibrationError("SELECTION_FILE_INVALID")
    canonical = "\n".join(
        f"{expected[review_id]}\t{review_id}"
        for review_id in sorted(expected, key=expected.__getitem__)
    )
    return expected, hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _read_validation_annotations(
    batch_dir: Path,
    path: Path,
    *,
    expected_round: int,
) -> tuple[str, dict[str, Annotation]]:
    try:
        validation = validate_annotations(str(batch_dir), str(path))
    except ReviewError as exc:
        raise CalibrationError(f"VALIDATION_SHEET_{exc.code}") from exc
    expected_status = "validation_single_coded" if expected_round == 1 else "validation_double_coded"
    if (
        validation["completion_scope"] != "validation"
        or validation["coder_count"] != 1
        or validation["annotation_rounds"] != [expected_round]
        or validation["adjudication_statuses"] != [expected_status]
    ):
        raise CalibrationError("VALIDATION_SHEET_PROVENANCE_INVALID")
    rows: dict[str, Annotation] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if tuple(reader.fieldnames or ()) != BLIND_COLUMNS:
            raise CalibrationError("VALIDATION_SHEET_HEADERS_INVALID")
        for row in reader:
            secondary = json.loads(row["secondary_functions"])
            annotation = Annotation(
                display_order=int(row["display_order"]),
                review_item_id=row["review_item_id"],
                facilitation_present=row["facilitation_present"],
                primary_function=row["primary_function"],
                secondary_functions=tuple(sorted(secondary)),
                confidence=float(row["confidence"]),
                coder_id=row["coder_id"],
                annotation_round=int(row["annotation_round"]),
                adjudication_status=row["adjudication_status"],
            )
            rows[annotation.review_item_id] = annotation
    coder_ids = {row.coder_id for row in rows.values()}
    if len(coder_ids) != 1:
        raise CalibrationError("VALIDATION_SHEET_PROVENANCE_INVALID")
    return next(iter(coder_ids)), rows


def _gwet_ac1(pairs: Sequence[tuple[str, str]], categories: Sequence[str]) -> float | None:
    if not pairs or len(categories) < 2:
        return None
    n = len(pairs)
    observed = sum(left == right for left, right in pairs) / n
    average_marginals = {
        category: (
            sum(left == category for left, _ in pairs)
            + sum(right == category for _, right in pairs)
        ) / (2 * n)
        for category in categories
    }
    chance = sum(value * (1.0 - value) for value in average_marginals.values()) / (len(categories) - 1)
    if math.isclose(chance, 1.0):
        return None
    return (observed - chance) / (1.0 - chance)


def _specific_agreement(pairs: Sequence[tuple[str, str]], target: str) -> float | None:
    both = sum(left == right == target for left, right in pairs)
    left_only = sum(left == target and right != target for left, right in pairs)
    right_only = sum(left != target and right == target for left, right in pairs)
    denominator = 2 * both + left_only + right_only
    return None if denominator == 0 else (2 * both) / denominator


def _precision_sample_size(population: int, half_width: float) -> int:
    if population <= 0:
        return 0
    n0 = (Z_95 ** 2) * 0.25 / (half_width ** 2)
    return min(population, math.ceil((population * n0) / (population + n0 - 1.0)))


def _class_coverage_size(counts: Counter[str], pilot_n: int, min_class_count: int) -> int | None:
    if pilot_n <= 0 or counts["yes"] == 0 or counts["no"] == 0:
        return None
    yes_rate = counts["yes"] / pilot_n
    no_rate = counts["no"] / pilot_n
    return math.ceil(max(min_class_count / yes_rate, min_class_count / no_rate))


def _allocate(groups: Mapping[str, Sequence[dict[str, Any]]], target: int) -> dict[str, int]:
    population = sum(len(items) for items in groups.values())
    if target > population:
        raise CalibrationError("SELECTION_SIZE_INVALID")
    raw = {name: target * len(items) / population for name, items in groups.items()}
    result = {name: min(len(groups[name]), math.floor(value)) for name, value in raw.items()}
    remaining = target - sum(result.values())
    order = sorted(groups, key=lambda name: (-(raw[name] - math.floor(raw[name])), name))
    while remaining:
        progressed = False
        for name in order:
            if result[name] < len(groups[name]):
                result[name] += 1
                remaining -= 1
                progressed = True
                if remaining == 0:
                    break
        if not progressed:
            raise CalibrationError("SELECTION_SIZE_INVALID")
    return result


def _stable_order(seed: str, batch_id: str, review_id: str) -> str:
    return hashlib.sha256(f"{SCHEMA_VERSION}\x1f{seed}\x1f{batch_id}\x1f{review_id}".encode("utf-8")).hexdigest()


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8", newline="\n")


def plan_calibration(
    *,
    batch_dir_value: str,
    pilot_annotations_value: str,
    output_dir_value: str,
    target_half_width: float = 0.10,
    min_class_count: int = 15,
    seed: str = "p1g-validation-v1",
) -> dict[str, Any]:
    if not 0.05 <= target_half_width <= 0.20 or not 5 <= min_class_count <= 100:
        raise CalibrationError("PLANNING_PARAMETER_INVALID")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", seed):
        raise CalibrationError("SEED_INVALID")
    batch_dir = Path(batch_dir_value).expanduser().resolve()
    pilot_path = Path(pilot_annotations_value).expanduser().resolve()
    try:
        validation = validate_annotations(str(batch_dir), str(pilot_path))
    except ReviewError as exc:
        raise CalibrationError(f"PILOT_{exc.code}") from exc
    if (
        validation["completion_scope"] != "pilot"
        or validation["coder_count"] != 1
        or validation["annotation_rounds"] != [1]
        or validation["adjudication_statuses"] != ["pilot_single_coded"]
    ):
        raise CalibrationError("PILOT_PROVENANCE_INVALID")

    manifest, items = _load_batch(batch_dir)
    pilot_rows = _load_pilot_rows(pilot_path)
    pilot_ids = {row["review_item_id"] for row in pilot_rows}
    remaining = [item for item in items if item["review_item_id"] not in pilot_ids]
    if not remaining:
        raise CalibrationError("NO_HELD_OUT_ITEMS")

    counts = Counter(str(row["facilitation_present"]) for row in pilot_rows)
    precision_n = _precision_sample_size(len(remaining), target_half_width)
    class_n = _class_coverage_size(counts, len(pilot_rows), min_class_count)
    warnings: list[str] = []
    if class_n is None:
        warnings.append("PILOT_DOES_NOT_CONTAIN_BOTH_DECISIVE_CLASSES")
    recommended = min(len(remaining), max(precision_n, class_n or 0))
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in remaining:
        groups[item["sampling_category"]].append(item)
    allocations = _allocate(groups, recommended)
    selected: list[dict[str, Any]] = []
    for category, group in sorted(groups.items()):
        ordered = sorted(group, key=lambda item: (_stable_order(seed, str(manifest["batch_id"]), item["review_item_id"]), item["review_item_id"]))
        selected.extend(ordered[:allocations[category]])
    selected.sort(key=lambda item: item["display_order"])
    canonical = "\n".join(f"{item['display_order']}\t{item['review_item_id']}" for item in selected)
    selection_id = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]

    output_dir = _validate_new_output_dir(output_dir_value)
    temp_dir = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}.", dir=output_dir.parent))
    try:
        with (temp_dir / "validation-selection.csv").open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=SELECTION_COLUMNS)
            writer.writeheader()
            writer.writerows({column: item[column] for column in SELECTION_COLUMNS} for item in selected)
        plan = {
            "schema_version": SCHEMA_VERSION,
            "batch_id": manifest["batch_id"],
            "batch_manifest_sha256": _sha256_file(batch_dir / "private-manifest.json"),
            "pilot_annotations_sha256": _sha256_file(pilot_path),
            "pilot_item_count": len(pilot_rows),
            "pilot_presence_counts": dict(sorted(counts.items())),
            "held_out_population": len(remaining),
            "target_95pct_half_width": target_half_width,
            "precision_proxy_sample_size": precision_n,
            "minimum_expected_items_per_yes_no_class": min_class_count,
            "class_coverage_sample_size": class_n,
            "recommended_overlap_size": recommended,
            "selection_id": selection_id,
            "selection_category_counts": dict(sorted(Counter(item["sampling_category"] for item in selected).items())),
            "selection_excludes_pilot": True,
            "planning_basis": "finite_population_conservative_binary_agreement_precision_proxy",
            "formal_kappa_power_claimed": False,
            "requires_two_independent_humans_for_inter_rater_reliability": True,
            "intra_rater_alternative_must_be_reported_as_intra_rater": True,
            "warnings": warnings,
            "identity_blind": True,
            "content_copied": False,
        }
        _write_json(temp_dir / "calibration-plan.json", plan)
        temp_dir.rename(output_dir)
    except FileExistsError as exc:
        raise CalibrationError("OUTPUT_ALREADY_EXISTS") from exc
    finally:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
    return {"ok": True, "mode": "plan", **plan, "output_dir": str(output_dir)}


def plan_reference_subset(
    *,
    batch_dir_value: str,
    output_dir_value: str,
    sample_size: int = 50,
    seed: str = "p1g-human-reference-50-v1",
) -> dict[str, Any]:
    if sample_size < 20 or sample_size > 100:
        raise CalibrationError("REFERENCE_SAMPLE_SIZE_INVALID")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", seed):
        raise CalibrationError("SEED_INVALID")
    batch_dir = Path(batch_dir_value).expanduser().resolve()
    manifest, items = _load_batch(batch_dir)
    if sample_size > len(items):
        raise CalibrationError("REFERENCE_SAMPLE_SIZE_INVALID")

    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        groups[item["sampling_category"]].append(item)
    allocations = _allocate(groups, sample_size)
    selected: list[dict[str, Any]] = []
    for category, group in sorted(groups.items()):
        ordered = sorted(
            group,
            key=lambda item: (
                _stable_order(seed, str(manifest["batch_id"]), item["review_item_id"]),
                item["review_item_id"],
            ),
        )
        selected.extend(ordered[: allocations[category]])
    selected.sort(key=lambda item: item["display_order"])
    canonical = "\n".join(
        f"{item['display_order']}\t{item['review_item_id']}" for item in selected
    )
    selection_id = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]

    output_dir = _validate_new_output_dir(output_dir_value)
    temp_dir = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}.", dir=output_dir.parent))
    plan = {
        "schema_version": REFERENCE_SCHEMA_VERSION,
        "batch_id": manifest["batch_id"],
        "batch_manifest_sha256": _sha256_file(batch_dir / "private-manifest.json"),
        "population_item_count": len(items),
        "selected_item_count": len(selected),
        "selection_id": selection_id,
        "seed": seed,
        "selection_category_counts": dict(
            sorted(Counter(item["sampling_category"] for item in selected).items())
        ),
        "planning_basis": "fixed_feasibility_budget_proportional_stratified_selection",
        "formal_precision_or_power_claimed": False,
        "single_pass_gold_standard_claimed": False,
        "requires_independent_review_or_adjudication": True,
        "identity_blind": True,
        "label_blind_selection": True,
        "content_copied": False,
    }
    try:
        with (temp_dir / "validation-selection.csv").open(
            "w", encoding="utf-8-sig", newline=""
        ) as handle:
            writer = csv.DictWriter(handle, fieldnames=SELECTION_COLUMNS)
            writer.writeheader()
            writer.writerows(
                {column: item[column] for column in SELECTION_COLUMNS}
                for item in selected
            )
        _write_json(temp_dir / "reference-selection-plan.json", plan)
        temp_dir.rename(output_dir)
    except FileExistsError as exc:
        raise CalibrationError("OUTPUT_ALREADY_EXISTS") from exc
    finally:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
    return {"ok": True, "mode": "reference", **plan, "output_dir": str(output_dir)}


def _load_selected_validation(
    *,
    batch_dir: Path,
    selection_value: str,
    annotations_value: str,
) -> tuple[Path, Path, str, dict[str, int], dict[str, Annotation]]:
    selection_path = Path(selection_value).expanduser().resolve()
    annotations_path = Path(annotations_value).expanduser().resolve()
    expected, selection_id = _load_validation_selection(selection_path)
    _coder_id, annotations = _read_validation_annotations(
        batch_dir, annotations_path, expected_round=1
    )
    if set(annotations) != set(expected):
        raise CalibrationError("REFERENCE_ITEM_SET_MISMATCH")
    if any(
        annotations[review_id].display_order != display_order
        for review_id, display_order in expected.items()
    ):
        raise CalibrationError("REFERENCE_DISPLAY_ORDER_MISMATCH")
    return selection_path, annotations_path, selection_id, expected, annotations


def finalize_primary_reference(
    *,
    batch_dir_value: str,
    base_selection_value: str,
    base_annotations_value: str,
    targeted_selection_value: str,
    targeted_annotations_value: str,
    output_dir_value: str,
    final_selection_value: str | None = None,
    final_annotations_value: str | None = None,
) -> dict[str, Any]:
    if bool(final_selection_value) != bool(final_annotations_value):
        raise CalibrationError("FINAL_REFERENCE_PAIR_REQUIRED")
    batch_dir = Path(batch_dir_value).expanduser().resolve()
    batch, _items = _load_batch(batch_dir)
    (
        base_selection_path,
        base_annotations_path,
        base_selection_id,
        base_expected,
        base_annotations,
    ) = _load_selected_validation(
        batch_dir=batch_dir,
        selection_value=base_selection_value,
        annotations_value=base_annotations_value,
    )
    (
        targeted_selection_path,
        targeted_annotations_path,
        targeted_selection_id,
        targeted_expected,
        targeted_annotations,
    ) = _load_selected_validation(
        batch_dir=batch_dir,
        selection_value=targeted_selection_value,
        annotations_value=targeted_annotations_value,
    )
    if not set(targeted_expected).issubset(base_expected):
        raise CalibrationError("TARGETED_REFERENCE_NOT_SUBSET")

    merged = dict(base_annotations)
    merged.update(targeted_annotations)
    final_metadata: dict[str, Any] | None = None
    if final_selection_value and final_annotations_value:
        (
            final_selection_path,
            final_annotations_path,
            final_selection_id,
            final_expected,
            final_annotations,
        ) = _load_selected_validation(
            batch_dir=batch_dir,
            selection_value=final_selection_value,
            annotations_value=final_annotations_value,
        )
        if not set(final_expected).issubset(targeted_expected):
            raise CalibrationError("FINAL_REFERENCE_NOT_SUBSET")
        merged.update(final_annotations)
        final_metadata = {
            "selection_id": final_selection_id,
            "selection_sha256": _sha256_file(final_selection_path),
            "annotations_sha256": _sha256_file(final_annotations_path),
            "item_count": len(final_expected),
        }

    output_dir = _validate_new_output_dir(output_dir_value)
    temp_dir = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}.", dir=output_dir.parent))
    rows: list[dict[str, Any]] = []
    for review_id in sorted(base_expected, key=base_expected.__getitem__):
        annotation = merged[review_id]
        rows.append({
            "display_order": base_expected[review_id],
            "review_item_id": review_id,
            "facilitation_present": annotation.facilitation_present,
            "primary_function": annotation.primary_function,
            "secondary_functions": "[]",
            "confidence": f"{annotation.confidence:.2f}",
            "coder_id": "human_primary_reference_v1_1",
            "annotation_round": 1,
            "adjudication_status": "validation_single_coded",
        })
    manifest = {
        "schema_version": PRIMARY_REFERENCE_SCHEMA_VERSION,
        "batch_id": batch["batch_id"],
        "batch_manifest_sha256": _sha256_file(batch_dir / "private-manifest.json"),
        "base": {
            "selection_id": base_selection_id,
            "selection_sha256": _sha256_file(base_selection_path),
            "annotations_sha256": _sha256_file(base_annotations_path),
            "item_count": len(base_expected),
        },
        "targeted_revision": {
            "selection_id": targeted_selection_id,
            "selection_sha256": _sha256_file(targeted_selection_path),
            "annotations_sha256": _sha256_file(targeted_annotations_path),
            "item_count": len(targeted_expected),
        },
        "final_adjudication": final_metadata,
        "codebook_version": "facilitation-function-v1.1",
        "codebook_sha256": _sha256_file(
            _repo_root() / "docs" / "FACILITATION_FUNCTION_CODEBOOK_V1_1.md"
        ),
        "reference_dimensions": ["facilitation_present", "primary_function"],
        "secondary_functions_retained": False,
        "targeted_revision_after_label_review": True,
        "independent_human_review_completed": False,
        "inter_rater_reliability_claimed": False,
        "gold_standard_claimed": False,
        "identity_blind": True,
        "content_copied": False,
    }
    try:
        _write_csv(temp_dir / "human-primary-reference.csv", BLIND_COLUMNS, rows)
        validation = validate_annotations(
            str(batch_dir), str(temp_dir / "human-primary-reference.csv")
        )
        if (
            validation["completion_scope"] != "validation"
            or validation["annotation_rows"] != len(base_expected)
        ):
            raise CalibrationError("PRIMARY_REFERENCE_VALIDATION_FAILED")
        _write_json(temp_dir / "reference-manifest.json", manifest)
        temp_dir.rename(output_dir)
    except FileExistsError as exc:
        raise CalibrationError("OUTPUT_ALREADY_EXISTS") from exc
    finally:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
    return {
        "ok": True,
        "mode": "finalize_reference",
        "item_count": len(rows),
        "targeted_revision_item_count": len(targeted_expected),
        "final_adjudication_item_count": 0 if final_metadata is None else final_metadata["item_count"],
        "secondary_functions_retained": False,
        "gold_standard_claimed": False,
        "output_dir": str(output_dir),
    }


def compare_calibration(
    *,
    batch_dir_value: str,
    coder_a_value: str,
    coder_b_value: str,
    selection_file_value: str,
    output_dir_value: str,
    design: str,
    washout_days: int | None = None,
) -> dict[str, Any]:
    if design not in {"inter_rater", "intra_rater"}:
        raise CalibrationError("COMPARISON_DESIGN_INVALID")
    if design == "intra_rater" and (washout_days is None or washout_days <= 0):
        raise CalibrationError("WASHOUT_DAYS_REQUIRED")
    batch_dir = Path(batch_dir_value).expanduser().resolve()
    coder_a_path = Path(coder_a_value).expanduser().resolve()
    coder_b_path = Path(coder_b_value).expanduser().resolve()
    selection_path = Path(selection_file_value).expanduser().resolve()
    if not coder_a_path.is_file() or not coder_b_path.is_file():
        raise CalibrationError("VALIDATION_SHEET_UNAVAILABLE")
    expected, selection_id = _load_validation_selection(selection_path)
    coder_a_id, coder_a = _read_validation_annotations(batch_dir, coder_a_path, expected_round=1)
    coder_b_id, coder_b = _read_validation_annotations(batch_dir, coder_b_path, expected_round=2)
    if set(coder_a) != set(coder_b) or set(coder_a) != set(expected) or not coder_a:
        raise CalibrationError("VALIDATION_ITEM_SET_MISMATCH")
    if design == "inter_rater" and coder_a_id == coder_b_id:
        raise CalibrationError("INTER_RATER_CODERS_MUST_BE_DISTINCT")
    if design == "intra_rater" and coder_a_id != coder_b_id:
        raise CalibrationError("INTRA_RATER_CODER_MUST_MATCH")
    if any(
        coder_a[review_id].display_order != order
        or coder_b[review_id].display_order != order
        for review_id, order in expected.items()
    ):
        raise CalibrationError("VALIDATION_DISPLAY_ORDER_MISMATCH")

    batch, _ = _load_batch(batch_dir)
    report, queue = _agreement_report(str(batch["batch_id"]), expected, coder_a, coder_b)
    pairs = [
        (coder_a[review_id].facilitation_present, coder_b[review_id].facilitation_present)
        for review_id in sorted(expected, key=expected.__getitem__)
    ]
    ac1 = _gwet_ac1(pairs, ("yes", "no", "uncertain"))
    ac1_ci = _bootstrap_ci(
        pairs,
        lambda sample: _gwet_ac1([(str(left), str(right)) for left, right in sample], ("yes", "no", "uncertain")),
        f"{batch['batch_id']}|{design}|presence|gwet-ac1",
    )
    report["schema_version"] = COMPARISON_SCHEMA_VERSION
    report["design"] = design
    report["washout_days"] = washout_days if design == "intra_rater" else None
    report["presence"].update({
        "gwet_ac1": None if ac1 is None else round(ac1, 4),
        "gwet_ac1_bootstrap_95_ci": ac1_ci,
        "yes_specific_agreement": None if _specific_agreement(pairs, "yes") is None else round(_specific_agreement(pairs, "yes") or 0.0, 4),
        "no_specific_agreement": None if _specific_agreement(pairs, "no") is None else round(_specific_agreement(pairs, "no") or 0.0, 4),
    })
    report["interpretation_boundary"] = (
        "inter_rater_reliability_between_two_independent_humans"
        if design == "inter_rater"
        else "intra_rater_repeatability_for_one_human_not_inter_rater_reliability"
    )
    report["llm_accuracy_claimed"] = False
    report["gold_standard_claimed"] = False

    comparison_manifest = {
        "schema_version": COMPARISON_SCHEMA_VERSION,
        "batch_id": batch["batch_id"],
        "design": design,
        "washout_days": washout_days if design == "intra_rater" else None,
        "selection_id": selection_id,
        "selection_file_sha256": _sha256_file(selection_path),
        "item_count": len(expected),
        "coder_a": {"coder_id": coder_a_id, "sha256": _sha256_file(coder_a_path), "annotation_round": 1},
        "coder_b": {"coder_id": coder_b_id, "sha256": _sha256_file(coder_b_path), "annotation_round": 2},
        "identity_blind": True,
        "content_copied": False,
    }
    output_dir = _validate_new_output_dir(output_dir_value)
    temp_dir = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}.", dir=output_dir.parent))
    try:
        _write_json(temp_dir / "agreement.json", report)
        _write_json(temp_dir / "comparison-manifest.json", comparison_manifest)
        _write_csv(temp_dir / "disagreement-review.csv", ADJUDICATION_COLUMNS, queue)
        temp_dir.rename(output_dir)
    except FileExistsError as exc:
        raise CalibrationError("OUTPUT_ALREADY_EXISTS") from exc
    finally:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
    return {
        "ok": True,
        "mode": "compare",
        "design": design,
        "item_count": len(expected),
        "disagreement_item_count": len(queue),
        "selection_id": selection_id,
        "output_dir": str(output_dir),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    plan = subparsers.add_parser("plan", help="plan a held-out validation subset")
    plan.add_argument("--batch-dir", required=True)
    plan.add_argument("--pilot-annotations", required=True)
    plan.add_argument("--output-dir", required=True)
    plan.add_argument("--target-half-width", type=float, default=0.10)
    plan.add_argument("--min-class-count", type=int, default=15)
    plan.add_argument("--seed", default="p1g-validation-v1")
    reference = subparsers.add_parser(
        "reference", help="select a fixed, label-blind human reference subset"
    )
    reference.add_argument("--batch-dir", required=True)
    reference.add_argument("--output-dir", required=True)
    reference.add_argument("--sample-size", type=int, default=50)
    reference.add_argument("--seed", default="p1g-human-reference-50-v1")
    finalize_reference = subparsers.add_parser(
        "finalize-reference", help="overlay targeted human revisions into a primary-only reference"
    )
    finalize_reference.add_argument("--batch-dir", required=True)
    finalize_reference.add_argument("--base-selection", required=True)
    finalize_reference.add_argument("--base-annotations", required=True)
    finalize_reference.add_argument("--targeted-selection", required=True)
    finalize_reference.add_argument("--targeted-annotations", required=True)
    finalize_reference.add_argument("--final-selection")
    finalize_reference.add_argument("--final-annotations")
    finalize_reference.add_argument("--output-dir", required=True)
    compare = subparsers.add_parser("compare", help="compare a fixed human validation subset")
    compare.add_argument("--batch-dir", required=True)
    compare.add_argument("--coder-a", required=True)
    compare.add_argument("--coder-b", required=True)
    compare.add_argument("--selection-file", required=True)
    compare.add_argument("--output-dir", required=True)
    compare.add_argument("--design", choices=("inter_rater", "intra_rater"), required=True)
    compare.add_argument("--washout-days", type=int)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "plan":
            result = plan_calibration(
                batch_dir_value=args.batch_dir,
                pilot_annotations_value=args.pilot_annotations,
                output_dir_value=args.output_dir,
                target_half_width=args.target_half_width,
                min_class_count=args.min_class_count,
                seed=args.seed,
            )
        elif args.command == "reference":
            result = plan_reference_subset(
                batch_dir_value=args.batch_dir,
                output_dir_value=args.output_dir,
                sample_size=args.sample_size,
                seed=args.seed,
            )
        elif args.command == "finalize-reference":
            result = finalize_primary_reference(
                batch_dir_value=args.batch_dir,
                base_selection_value=args.base_selection,
                base_annotations_value=args.base_annotations,
                targeted_selection_value=args.targeted_selection,
                targeted_annotations_value=args.targeted_annotations,
                final_selection_value=args.final_selection,
                final_annotations_value=args.final_annotations,
                output_dir_value=args.output_dir,
            )
        else:
            result = compare_calibration(
                batch_dir_value=args.batch_dir,
                coder_a_value=args.coder_a,
                coder_b_value=args.coder_b,
                selection_file_value=args.selection_file,
                output_dir_value=args.output_dir,
                design=args.design,
                washout_days=args.washout_days,
            )
    except CalibrationError as exc:
        print(json.dumps({"ok": False, "error": exc.code}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
