#!/usr/bin/env python3
"""Freeze exclusions and compare weak model labels with a primary-only human reference."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping, Sequence

from research_annotation_core import (
    MODEL_COLUMNS,
    OUTPUT_ROOT_ENV,
    _atomic_json,
    _now,
    _sha256_file,
    _validate_output_dir,
    validate_model_result,
)
from research_review import BLIND_COLUMNS, FUNCTION_LABELS
from research_review_server import ReviewServerError, _load_selection_file


SCHEMA_VERSION = "p1h-model-human-evaluation-v1"
EXCLUSION_SCHEMA_VERSION = "p1h-hard-evaluation-exclusions-v1"
REFERENCE_SCHEMA_VERSION = "p1g-human-primary-reference-candidate-v1"
LOCAL_MODEL_SCHEMA_VERSION = "p1h-local-model-annotation-v1"
ONLINE_MODEL_SCHEMA_VERSION = "p1h-online-model-annotation-v1"
EXCLUSION_COLUMNS = ("display_order", "review_item_id", "reason_code")
SELECTION_COLUMNS = ("display_order", "review_item_id")
ITEM_COLUMNS = (
    "display_order",
    "review_item_id",
    "evaluation_scope",
    "exclusion_reason",
    "human_presence",
    "model_presence",
    "human_primary",
    "model_primary",
    "presence_match",
    "primary_match",
    "joint_match",
    "model_abstained",
    "disagreement_reasons",
)
EXCLUSION_REASONS = {
    "codebook_boundary_conflict",
    "data_integrity_holdout",
    "predeclared_quality_holdout",
}


class EvaluationError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _read_json(path: Path, code: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise EvaluationError(code) from exc
    if not isinstance(value, dict):
        raise EvaluationError(code)
    return value


def _read_csv(path: Path, columns: Sequence[str], code: str) -> list[dict[str, str]]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if tuple(reader.fieldnames or ()) != tuple(columns):
                raise EvaluationError(code)
            return [dict(row) for row in reader]
    except OSError as exc:
        raise EvaluationError(code) from exc


def _write_csv(path: Path, columns: Sequence[str], rows: Sequence[Mapping[str, Any]]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows({column: row[column] for column in columns} for row in rows)
    temporary.replace(path)


def _load_reference(reference_dir_value: str) -> tuple[Path, Path, dict[str, Any], dict[str, dict[str, Any]]]:
    reference_dir = Path(reference_dir_value).expanduser().resolve()
    csv_path = reference_dir / "human-primary-reference.csv"
    manifest_path = reference_dir / "reference-manifest.json"
    manifest = _read_json(manifest_path, "REFERENCE_MANIFEST_INVALID")
    if (
        manifest.get("schema_version") != REFERENCE_SCHEMA_VERSION
        or manifest.get("reference_dimensions")
        != ["facilitation_present", "primary_function"]
        or manifest.get("secondary_functions_retained") is not False
        or manifest.get("gold_standard_claimed") is not False
        or manifest.get("identity_blind") is not True
        or manifest.get("content_copied") is not False
    ):
        raise EvaluationError("REFERENCE_PROVENANCE_INVALID")
    rows = _read_csv(csv_path, BLIND_COLUMNS, "REFERENCE_CSV_INVALID")
    expected_count = int(manifest.get("base", {}).get("item_count", -1))
    if not rows or len(rows) != expected_count:
        raise EvaluationError("REFERENCE_ITEM_COUNT_MISMATCH")
    normalized: dict[str, dict[str, Any]] = {}
    orders: set[int] = set()
    for row in rows:
        try:
            order = int(row["display_order"])
            confidence = float(row["confidence"])
            secondary = json.loads(row["secondary_functions"])
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            raise EvaluationError("REFERENCE_CSV_INVALID") from exc
        review_id = row["review_item_id"]
        presence = row["facilitation_present"]
        primary = row["primary_function"]
        if (
            not review_id
            or review_id in normalized
            or order in orders
            or presence not in {"yes", "no", "uncertain"}
            or not 0 <= confidence <= 1
            or secondary != []
            or (presence == "yes" and primary not in FUNCTION_LABELS)
            or (presence != "yes" and primary != "")
            or row["coder_id"] != "human_primary_reference_v1_1"
            or row["annotation_round"] != "1"
            or row["adjudication_status"] != "validation_single_coded"
        ):
            raise EvaluationError("REFERENCE_CSV_INVALID")
        orders.add(order)
        normalized[review_id] = {
            "display_order": order,
            "facilitation_present": presence,
            "primary_function": primary,
            "confidence": confidence,
        }
    return csv_path, manifest_path, manifest, normalized


def _parse_exclusion_specs(
    specs: Sequence[str], reference: Mapping[str, Mapping[str, Any]]
) -> list[dict[str, Any]]:
    exclusions: list[dict[str, Any]] = []
    seen: set[str] = set()
    for spec in specs:
        review_id, separator, reason = spec.partition(":")
        item = reference.get(review_id)
        if (
            not separator
            or item is None
            or review_id in seen
            or reason not in EXCLUSION_REASONS
            or item["facilitation_present"] == "uncertain"
        ):
            raise EvaluationError("EXCLUSION_SPEC_INVALID")
        seen.add(review_id)
        exclusions.append(
            {
                "display_order": item["display_order"],
                "review_item_id": review_id,
                "reason_code": reason,
            }
        )
    return sorted(exclusions, key=lambda row: int(row["display_order"]))


def freeze_exclusions(
    *,
    reference_dir_value: str,
    output_dir_value: str,
    exclusion_specs: Sequence[str],
) -> dict[str, Any]:
    reference_csv, reference_manifest_path, reference_manifest, reference = _load_reference(
        reference_dir_value
    )
    exclusions = _parse_exclusion_specs(exclusion_specs, reference)
    output_dir = _validate_output_dir(output_dir_value, resume=False)
    exclusions_path = output_dir / "exclusions.csv"
    _write_csv(exclusions_path, EXCLUSION_COLUMNS, exclusions)
    manifest = {
        "schema_version": EXCLUSION_SCHEMA_VERSION,
        "batch_id": reference_manifest["batch_id"],
        "frozen_at": _now(),
        "frozen_before_model_run_required": True,
        "reference_csv_sha256": _sha256_file(reference_csv),
        "reference_manifest_sha256": _sha256_file(reference_manifest_path),
        "exclusions_sha256": _sha256_file(exclusions_path),
        "excluded_item_count": len(exclusions),
        "allowed_reason_codes": sorted(EXCLUSION_REASONS),
        "human_uncertain_excluded_automatically": True,
        "identity_blind": True,
        "content_copied": False,
        "model_labels_loaded": False,
    }
    _atomic_json(output_dir / "exclusion-manifest.json", manifest)
    return {
        "ok": True,
        "mode": "freeze_exclusions",
        "excluded_item_count": len(exclusions),
        "output_dir": str(output_dir),
        "model_labels_loaded": False,
    }


def prepare_smoke_selection(
    *, selection_file_value: str, output_dir_value: str, item_count: int
) -> dict[str, Any]:
    source_path = Path(selection_file_value).expanduser().resolve()
    _, source_selection_id = _load_selection_file(str(source_path))
    rows = sorted(
        _read_csv(source_path, SELECTION_COLUMNS, "SELECTION_FILE_INVALID"),
        key=lambda row: int(row["display_order"]),
    )
    if not 1 <= item_count <= len(rows):
        raise EvaluationError("SMOKE_SELECTION_SIZE_INVALID")
    if item_count == 1:
        indices = [len(rows) // 2]
    else:
        indices = [
            round(position * (len(rows) - 1) / (item_count - 1))
            for position in range(item_count)
        ]
    if len(indices) != len(set(indices)):
        raise EvaluationError("SMOKE_SELECTION_SIZE_INVALID")
    selected = [rows[index] for index in indices]
    output_dir = _validate_output_dir(output_dir_value, resume=False)
    output_path = output_dir / "smoke-selection.csv"
    _write_csv(output_path, SELECTION_COLUMNS, selected)
    _, smoke_selection_id = _load_selection_file(str(output_path))
    manifest = {
        "schema_version": "p1h-smoke-selection-v1",
        "created_at": _now(),
        "source_selection_id": source_selection_id,
        "source_selection_sha256": _sha256_file(source_path),
        "smoke_selection_id": smoke_selection_id,
        "smoke_selection_sha256": _sha256_file(output_path),
        "source_item_count": len(rows),
        "item_count": len(selected),
        "strategy": "evenly_spaced_by_source_order_without_labels",
        "human_annotations_loaded": False,
        "content_loaded": False,
        "identity_blind": True,
    }
    _atomic_json(output_dir / "smoke-selection-manifest.json", manifest)
    return {
        "ok": True,
        "mode": "prepare_smoke_selection",
        "item_count": len(selected),
        "selection_id": smoke_selection_id,
        "output_dir": str(output_dir),
        "human_annotations_loaded": False,
        "content_loaded": False,
    }


def _load_exclusions(
    exclusion_dir_value: str,
    *,
    reference_csv: Path,
    reference_manifest_path: Path,
    reference: Mapping[str, Mapping[str, Any]],
) -> tuple[Path, Path, dict[str, Any], dict[str, str]]:
    exclusion_dir = Path(exclusion_dir_value).expanduser().resolve()
    csv_path = exclusion_dir / "exclusions.csv"
    manifest_path = exclusion_dir / "exclusion-manifest.json"
    manifest = _read_json(manifest_path, "EXCLUSION_MANIFEST_INVALID")
    rows = _read_csv(csv_path, EXCLUSION_COLUMNS, "EXCLUSION_CSV_INVALID")
    if (
        manifest.get("schema_version") != EXCLUSION_SCHEMA_VERSION
        or manifest.get("reference_csv_sha256") != _sha256_file(reference_csv)
        or manifest.get("reference_manifest_sha256") != _sha256_file(reference_manifest_path)
        or manifest.get("exclusions_sha256") != _sha256_file(csv_path)
        or manifest.get("excluded_item_count") != len(rows)
        or manifest.get("model_labels_loaded") is not False
    ):
        raise EvaluationError("EXCLUSION_PROVENANCE_INVALID")
    exclusions: dict[str, str] = {}
    for row in rows:
        review_id = row["review_item_id"]
        item = reference.get(review_id)
        reason = row["reason_code"]
        try:
            order = int(row["display_order"])
        except ValueError as exc:
            raise EvaluationError("EXCLUSION_CSV_INVALID") from exc
        if (
            item is None
            or review_id in exclusions
            or reason not in EXCLUSION_REASONS
            or order != item["display_order"]
            or item["facilitation_present"] == "uncertain"
        ):
            raise EvaluationError("EXCLUSION_CSV_INVALID")
        exclusions[review_id] = reason
    return csv_path, manifest_path, manifest, exclusions


def _safe_model_manifest(manifest: Mapping[str, Any]) -> bool:
    common = (
        manifest.get("status") == "complete"
        and manifest.get("human_annotations_loaded") is False
        and manifest.get("mock_fallback_allowed") is False
        and manifest.get("model_labels_are_gold_standard") is False
        and manifest.get("content_persisted") is False
        and manifest.get("identity_blind") is True
    )
    if not common:
        return False
    schema = manifest.get("schema_version")
    if schema == ONLINE_MODEL_SCHEMA_VERSION:
        common_online = (
            manifest.get("remote_endpoint_allowed") is True
            and manifest.get("remote_data_transfer_authorized") is True
            and manifest.get("redirects_allowed") is False
            and isinstance(manifest.get("provider_host"), str)
            and bool(manifest.get("provider_host"))
            and manifest.get("remote_consent_version")
            == "p1h-redacted-selected-posts-v1"
            and manifest.get("remote_data_scope")
            == "identity_blind_redacted_selected_posts"
        )
        if not common_online:
            return False
        protocol = manifest.get("protocol")
        if protocol == "anthropic_messages_2023_06_01":
            return manifest.get("application_layer_input_encryption") is False
        if protocol == "dashscope_encrypted_aes_gcm_v1":
            return (
                manifest.get("provider_host") == "dashscope.aliyuncs.com"
                and manifest.get("application_layer_input_encryption") is True
                and manifest.get("encryption_scheme")
                == "aes_256_gcm_with_provider_rsa_key"
            )
        return False
    if schema == LOCAL_MODEL_SCHEMA_VERSION:
        return manifest.get("remote_endpoint_allowed") is False
    return False


def _load_model_run(
    model_run_dir_value: str,
) -> tuple[Path, Path, dict[str, Any], dict[str, dict[str, Any]]]:
    model_dir = Path(model_run_dir_value).expanduser().resolve()
    csv_path = model_dir / "model-annotations.csv"
    manifest_path = model_dir / "run-manifest.json"
    manifest = _read_json(manifest_path, "MODEL_MANIFEST_INVALID")
    if not _safe_model_manifest(manifest):
        raise EvaluationError("MODEL_PROVENANCE_UNSAFE")
    if not csv_path.is_file():
        raise EvaluationError("MODEL_CSV_INVALID")
    if manifest.get("annotations_sha256") != _sha256_file(csv_path):
        raise EvaluationError("MODEL_ANNOTATIONS_HASH_MISMATCH")
    rows = _read_csv(csv_path, MODEL_COLUMNS, "MODEL_CSV_INVALID")
    if len(rows) != manifest.get("item_count") or len(rows) != manifest.get(
        "completed_item_count"
    ):
        raise EvaluationError("MODEL_ITEM_COUNT_MISMATCH")
    normalized: dict[str, dict[str, Any]] = {}
    orders: set[int] = set()
    for row in rows:
        try:
            order = int(row["display_order"])
            secondary = json.loads(row["secondary_functions"])
            evidence = json.loads(row["evidence_codes"])
            confidence = float(row["confidence"])
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            raise EvaluationError("MODEL_CSV_INVALID") from exc
        review_id = row["review_item_id"]
        if (
            not review_id
            or review_id in normalized
            or order in orders
            or row["model_run_id"] != manifest.get("run_id")
            or row["model_status"] != "model_weak_label"
        ):
            raise EvaluationError("MODEL_CSV_INVALID")
        try:
            result = validate_model_result(
                {
                    "facilitation_present": row["facilitation_present"],
                    "primary_function": row["primary_function"],
                    "secondary_functions": secondary,
                    "confidence": confidence,
                    "evidence_codes": evidence,
                }
            )
        except Exception as exc:
            raise EvaluationError("MODEL_CSV_INVALID") from exc
        orders.add(order)
        normalized[review_id] = {"display_order": order, **result}
    return csv_path, manifest_path, manifest, normalized


def _rate(numerator: int, denominator: int) -> float | None:
    return None if denominator == 0 else round(numerator / denominator, 4)


def _iso(value: Any, code: str) -> datetime:
    if not isinstance(value, str):
        raise EvaluationError(code)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise EvaluationError(code) from exc
    if parsed.tzinfo is None:
        raise EvaluationError(code)
    return parsed


def compare_model_to_reference(
    *,
    reference_dir_value: str,
    model_run_dir_value: str,
    exclusion_dir_value: str,
    output_dir_value: str,
) -> dict[str, Any]:
    reference_csv, reference_manifest_path, reference_manifest, reference = _load_reference(
        reference_dir_value
    )
    exclusion_csv, exclusion_manifest_path, exclusion_manifest, exclusions = _load_exclusions(
        exclusion_dir_value,
        reference_csv=reference_csv,
        reference_manifest_path=reference_manifest_path,
        reference=reference,
    )
    model_csv, model_manifest_path, model_manifest, model = _load_model_run(
        model_run_dir_value
    )
    if (
        reference_manifest.get("batch_id") != model_manifest.get("batch_id")
        or set(reference) != set(model)
        or any(
            reference[review_id]["display_order"] != model[review_id]["display_order"]
            for review_id in reference
        )
    ):
        raise EvaluationError("MODEL_REFERENCE_ITEM_SET_MISMATCH")
    if _iso(exclusion_manifest.get("frozen_at"), "EXCLUSION_TIMESTAMP_INVALID") >= _iso(
        model_manifest.get("started_at"), "MODEL_TIMESTAMP_INVALID"
    ):
        raise EvaluationError("EXCLUSIONS_NOT_PREDECLARED")

    item_rows: list[dict[str, Any]] = []
    disagreement_selection: list[dict[str, Any]] = []
    hard_pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    human_uncertain_count = 0
    predeclared_count = 0
    for review_id in sorted(reference, key=lambda item: reference[item]["display_order"]):
        human = reference[review_id]
        predicted = model[review_id]
        if human["facilitation_present"] == "uncertain":
            scope = "descriptive_only"
            exclusion_reason = "human_uncertain"
            human_uncertain_count += 1
        elif review_id in exclusions:
            scope = "descriptive_only"
            exclusion_reason = exclusions[review_id]
            predeclared_count += 1
        else:
            scope = "hard_evaluation"
            exclusion_reason = ""
            hard_pairs.append((human, predicted))
        presence_match = human["facilitation_present"] == predicted["facilitation_present"]
        primary_match = (
            human["primary_function"] == predicted["primary_function"]
            if human["facilitation_present"] == predicted["facilitation_present"] == "yes"
            else False
        )
        joint_match = presence_match and (
            human["facilitation_present"] != "yes" or primary_match
        )
        issues: list[str] = []
        if scope == "hard_evaluation":
            if predicted["facilitation_present"] == "uncertain":
                issues.append("model_abstention")
            elif not presence_match:
                issues.append("presence_disagreement")
            elif human["facilitation_present"] == "yes" and not primary_match:
                issues.append("primary_disagreement")
            if issues:
                disagreement_selection.append(
                    {
                        "display_order": human["display_order"],
                        "review_item_id": review_id,
                    }
                )
        item_rows.append(
            {
                "display_order": human["display_order"],
                "review_item_id": review_id,
                "evaluation_scope": scope,
                "exclusion_reason": exclusion_reason,
                "human_presence": human["facilitation_present"],
                "model_presence": predicted["facilitation_present"],
                "human_primary": human["primary_function"],
                "model_primary": predicted["primary_function"],
                "presence_match": str(presence_match).lower(),
                "primary_match": str(primary_match).lower(),
                "joint_match": str(joint_match).lower(),
                "model_abstained": str(
                    predicted["facilitation_present"] == "uncertain"
                ).lower(),
                "disagreement_reasons": json.dumps(issues, separators=(",", ":")),
            }
        )

    hard_n = len(hard_pairs)
    answered = [pair for pair in hard_pairs if pair[1]["facilitation_present"] != "uncertain"]
    abstentions = hard_n - len(answered)
    presence_correct = sum(
        human["facilitation_present"] == predicted["facilitation_present"]
        for human, predicted in hard_pairs
    )
    selective_presence_correct = sum(
        human["facilitation_present"] == predicted["facilitation_present"]
        for human, predicted in answered
    )
    joint_correct = sum(
        human["facilitation_present"] == predicted["facilitation_present"]
        and (
            human["facilitation_present"] != "yes"
            or human["primary_function"] == predicted["primary_function"]
        )
        for human, predicted in hard_pairs
    )
    selective_joint_correct = sum(
        human["facilitation_present"] == predicted["facilitation_present"]
        and (
            human["facilitation_present"] != "yes"
            or human["primary_function"] == predicted["primary_function"]
        )
        for human, predicted in answered
    )
    reference_yes = [pair for pair in hard_pairs if pair[0]["facilitation_present"] == "yes"]
    reference_no = [pair for pair in hard_pairs if pair[0]["facilitation_present"] == "no"]
    dual_yes = [
        pair
        for pair in hard_pairs
        if pair[0]["facilitation_present"] == pair[1]["facilitation_present"] == "yes"
    ]
    primary_reference_yes_correct = sum(
        predicted["facilitation_present"] == "yes"
        and human["primary_function"] == predicted["primary_function"]
        for human, predicted in reference_yes
    )
    primary_dual_yes_correct = sum(
        human["primary_function"] == predicted["primary_function"]
        for human, predicted in dual_yes
    )
    yes_recall = _rate(
        sum(predicted["facilitation_present"] == "yes" for _, predicted in reference_yes),
        len(reference_yes),
    )
    no_recall = _rate(
        sum(predicted["facilitation_present"] == "no" for _, predicted in reference_no),
        len(reference_no),
    )
    balanced_accuracy = (
        None
        if yes_recall is None or no_recall is None
        else round((yes_recall + no_recall) / 2, 4)
    )
    presence_confusion: dict[str, dict[str, int]] = {
        label: {predicted: 0 for predicted in ("yes", "no", "uncertain")}
        for label in ("yes", "no")
    }
    primary_confusion: dict[str, Counter[str]] = {}
    for human, predicted in hard_pairs:
        presence_confusion[human["facilitation_present"]][predicted["facilitation_present"]] += 1
    for human, predicted in dual_yes:
        primary_confusion.setdefault(human["primary_function"], Counter())[
            predicted["primary_function"]
        ] += 1
    report = {
        "schema_version": SCHEMA_VERSION,
        "batch_id": reference_manifest["batch_id"],
        "scope": {
            "reference_item_count": len(reference),
            "human_uncertain_excluded_count": human_uncertain_count,
            "predeclared_excluded_count": predeclared_count,
            "hard_evaluation_item_count": hard_n,
        },
        "model_abstention": {
            "count": abstentions,
            "coverage": _rate(len(answered), hard_n),
        },
        "presence": {
            "n": hard_n,
            "accuracy_abstention_incorrect": _rate(presence_correct, hard_n),
            "selective_n": len(answered),
            "selective_accuracy": _rate(selective_presence_correct, len(answered)),
            "yes_recall_abstention_incorrect": yes_recall,
            "no_recall_abstention_incorrect": no_recall,
            "balanced_accuracy_abstention_incorrect": balanced_accuracy,
            "confusion_matrix_human_rows": presence_confusion,
        },
        "joint_presence_primary": {
            "n": hard_n,
            "exact_accuracy": _rate(joint_correct, hard_n),
            "selective_n": len(answered),
            "selective_exact_accuracy": _rate(selective_joint_correct, len(answered)),
        },
        "primary_function_reference_yes": {
            "n": len(reference_yes),
            "accuracy": _rate(primary_reference_yes_correct, len(reference_yes)),
            "model_no_or_uncertain_counted_incorrect": True,
        },
        "primary_function_dual_yes": {
            "n": len(dual_yes),
            "accuracy": _rate(primary_dual_yes_correct, len(dual_yes)),
            "conditioning_warning": "descriptive_only_because_conditioning_on_both_yes_can_select_cases",
            "confusion_matrix_human_rows": {
                key: dict(value) for key, value in sorted(primary_confusion.items())
            },
        },
        "disagreement": {
            "item_count": len(disagreement_selection),
            "reason_counts": dict(
                sorted(
                    Counter(
                        reason
                        for row in item_rows
                        for reason in json.loads(row["disagreement_reasons"])
                    ).items()
                )
            ),
        },
        "claims": {
            "human_reference_is_single_coder_candidate": True,
            "gold_standard_claimed": False,
            "external_validity_claimed": False,
            "causal_validity_claimed": False,
            "full_population_representativeness_claimed": False,
        },
        "what_the_data_does_not_show": [
            "model_accuracy_against_an_independent_human_gold_standard",
            "generalization_to_all_140k_forum_records",
            "causal_effect_on_learning_or_participation",
        ],
        "next_validation_needed": [
            "blind_human_adjudication_of_disagreement_selection",
            "independent_review_of_predeclared_boundary_conflicts",
        ],
    }
    output_dir = _validate_output_dir(output_dir_value, resume=False)
    _atomic_json(output_dir / "model-human-evaluation.json", report)
    _write_csv(output_dir / "item-comparison.csv", ITEM_COLUMNS, item_rows)
    _write_csv(
        output_dir / "disagreement-selection.csv",
        SELECTION_COLUMNS,
        disagreement_selection,
    )
    comparison_manifest = {
        "schema_version": SCHEMA_VERSION,
        "created_at": _now(),
        "batch_id": reference_manifest["batch_id"],
        "reference_csv_sha256": _sha256_file(reference_csv),
        "reference_manifest_sha256": _sha256_file(reference_manifest_path),
        "model_annotations_sha256": _sha256_file(model_csv),
        "model_manifest_sha256": _sha256_file(model_manifest_path),
        "exclusions_sha256": _sha256_file(exclusion_csv),
        "exclusion_manifest_sha256": _sha256_file(exclusion_manifest_path),
        "exclusions_predeclared_before_model_run": True,
        "hard_evaluation_item_count": hard_n,
        "identity_blind": True,
        "content_copied": False,
    }
    _atomic_json(output_dir / "comparison-manifest.json", comparison_manifest)
    return {
        "ok": True,
        "mode": "compare_model_to_reference",
        "hard_evaluation_item_count": hard_n,
        "disagreement_item_count": len(disagreement_selection),
        "output_dir": str(output_dir),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    freeze = subparsers.add_parser("freeze-exclusions")
    freeze.add_argument("--reference-dir", required=True)
    freeze.add_argument("--output-dir", required=True)
    freeze.add_argument("--exclude", action="append", default=[])
    smoke = subparsers.add_parser("prepare-smoke")
    smoke.add_argument("--selection-file", required=True)
    smoke.add_argument("--output-dir", required=True)
    smoke.add_argument("--item-count", type=int, default=3)
    compare = subparsers.add_parser("compare")
    compare.add_argument("--reference-dir", required=True)
    compare.add_argument("--model-run-dir", required=True)
    compare.add_argument("--exclusion-dir", required=True)
    compare.add_argument("--output-dir", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "freeze-exclusions":
            result = freeze_exclusions(
                reference_dir_value=args.reference_dir,
                output_dir_value=args.output_dir,
                exclusion_specs=args.exclude,
            )
        elif args.command == "prepare-smoke":
            result = prepare_smoke_selection(
                selection_file_value=args.selection_file,
                output_dir_value=args.output_dir,
                item_count=args.item_count,
            )
        else:
            result = compare_model_to_reference(
                reference_dir_value=args.reference_dir,
                model_run_dir_value=args.model_run_dir,
                exclusion_dir_value=args.exclusion_dir,
                output_dir_value=args.output_dir,
            )
    except (EvaluationError, ModelAnnotationError, ReviewServerError) as exc:
        code = exc.code if hasattr(exc, "code") else "MODEL_EVALUATION_FAILED"
        print(json.dumps({"ok": False, "error": code}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
