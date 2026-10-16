#!/usr/bin/env python3
"""Create a deterministic, identity-blind facilitation review batch.

The command reads the isolated P1c SQLite database in read-only mode and writes
only pseudonymous metadata. Forum content is never selected or copied.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SCHEMA_VERSION = "p1d-facilitation-review-v1"
SOURCE_SCHEMA_VERSION = "p1c-role-function-staging-v1"
ALGORITHM_VERSION = "balanced-stratified-v1"
CODEBOOK_VERSION = "facilitation-functions-v1"
OUTPUT_ROOT_ENV = "CMOOC_REVIEW_OUTPUT_ROOT"
DEFAULT_SAMPLE_SIZE = 300

FUNCTION_LABELS = {
    "resource_seeding",
    "question_guiding",
    "idea_bridging",
    "amplification",
    "synthesis",
    "cognitive_challenge",
    "affective_support",
    "coordination",
    "peer_exchange",
}

CATEGORY_SHARES: tuple[tuple[str, float], ...] = (
    ("formal_role", 0.35),
    ("learner_p99", 0.15),
    ("learner_p95", 0.25),
    ("learner_baseline", 0.25),
)

BLIND_COLUMNS = (
    "display_order",
    "review_item_id",
    "facilitation_present",
    "primary_function",
    "secondary_functions",
    "confidence",
    "coder_id",
    "annotation_round",
    "adjudication_status",
)


class ReviewError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Candidate:
    event_id: str
    course_id: str
    actor_id: str
    platform_role: str
    source_kind: str
    normalized_char_count: int
    paragraph_count: int
    url_count: int
    course_length_cume_dist: float
    category: str
    fine_stratum: str


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
        raise ReviewError("LOCAL_OUTPUT_ROOT_REQUIRED")
    return (Path(local_app_data).expanduser().resolve() / "cmooc-research" / "p1d")


def _validate_output_dir(value: str) -> Path:
    output_root = _default_output_root()
    output_dir = Path(value).expanduser().resolve(strict=False)
    if _is_unc(output_root) or _is_unc(output_dir):
        raise ReviewError("UNC_OUTPUT_FORBIDDEN")
    if not _contains(output_root, output_dir):
        raise ReviewError("OUTPUT_OUTSIDE_LOCAL_ROOT")
    if output_dir == output_root:
        raise ReviewError("OUTPUT_DIR_REQUIRED")
    if _contains(_repo_root().resolve(), output_dir):
        raise ReviewError("SYNCED_OUTPUT_FORBIDDEN")
    if output_dir.exists():
        raise ReviewError("OUTPUT_ALREADY_EXISTS")
    output_root.mkdir(parents=True, exist_ok=True)
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    return output_dir


def _validate_seed(seed: str) -> str:
    normalized = seed.strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", normalized):
        raise ReviewError("SEED_INVALID")
    return normalized


def _stable_digest(seed: str, domain: str, value: str) -> str:
    payload = "\x1f".join((ALGORITHM_VERSION, seed, domain, value))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _category(platform_role: str, cume_dist: float) -> str | None:
    if platform_role in {"helper", "creator"}:
        return "formal_role"
    if platform_role != "learner":
        return None
    if cume_dist >= 0.99:
        return "learner_p99"
    if cume_dist >= 0.95:
        return "learner_p95"
    return "learner_baseline"


def _fine_stratum(category: str, course_id: str, platform_role: str) -> str:
    if category == "formal_role":
        return f"{category}|{course_id}|{platform_role}"
    return f"{category}|{course_id}"


def _load_candidates(database: Path) -> tuple[dict[str, Any], list[Candidate]]:
    if not database.is_file():
        raise ReviewError("DATABASE_UNAVAILABLE")
    try:
        connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
        manifests = connection.execute(
            "SELECT dataset_fingerprint, schema_version, source_timezone, source_profile, "
            "learner_projection_enabled, content_policy FROM dataset_manifest"
        ).fetchall()
        if len(manifests) != 1:
            raise ReviewError("DATASET_MANIFEST_INVALID")
        manifest = dict(manifests[0])
        if manifest["schema_version"] != SOURCE_SCHEMA_VERSION:
            raise ReviewError("SOURCE_SCHEMA_UNSUPPORTED")
        if manifest["learner_projection_enabled"] != 0:
            raise ReviewError("PROJECTION_MUST_REMAIN_DISABLED")
        stored_content = connection.execute(
            "SELECT COUNT(*) FROM forum_event_content WHERE content_redacted IS NOT NULL"
        ).fetchone()[0]
        if stored_content:
            raise ReviewError("STORED_CONTENT_FORBIDDEN")

        rows = connection.execute(
            """
            SELECT
              rank.event_id,
              rank.course_id,
              rank.actor_id,
              rank.platform_role,
              event.source_kind,
              rank.normalized_char_count,
              rank.paragraph_count,
              rank.url_count,
              rank.course_length_cume_dist
            FROM event_structure_rank AS rank
            JOIN forum_event AS event ON event.event_id = rank.event_id
            ORDER BY rank.event_id
            """
        ).fetchall()
    except sqlite3.DatabaseError as exc:
        raise ReviewError("DATABASE_SCHEMA_INVALID") from exc
    finally:
        if "connection" in locals():
            connection.close()

    candidates: list[Candidate] = []
    for row in rows:
        category = _category(str(row["platform_role"]), float(row["course_length_cume_dist"]))
        if category is None:
            continue
        candidates.append(
            Candidate(
                event_id=str(row["event_id"]),
                course_id=str(row["course_id"]),
                actor_id=str(row["actor_id"]),
                platform_role=str(row["platform_role"]),
                source_kind=str(row["source_kind"]),
                normalized_char_count=int(row["normalized_char_count"]),
                paragraph_count=int(row["paragraph_count"]),
                url_count=int(row["url_count"]),
                course_length_cume_dist=float(row["course_length_cume_dist"]),
                category=category,
                fine_stratum=_fine_stratum(
                    category, str(row["course_id"]), str(row["platform_role"])
                ),
            )
        )
    if not candidates:
        raise ReviewError("NO_ELIGIBLE_POSTS")
    return manifest, candidates


def _allocate_category_quotas(populations: Mapping[str, int], sample_size: int) -> dict[str, int]:
    quotas: dict[str, int] = {}
    assigned = 0
    shares = dict(CATEGORY_SHARES)
    for category, share in CATEGORY_SHARES:
        proposed = int(sample_size * share)
        quota = min(populations.get(category, 0), proposed)
        quotas[category] = quota
        assigned += quota

    while assigned < sample_size:
        available = [
            category
            for category, _ in CATEGORY_SHARES
            if quotas[category] < populations.get(category, 0)
        ]
        if not available:
            break
        category = max(
            available,
            key=lambda name: (
                shares[name] - (quotas[name] / max(sample_size, 1)),
                populations[name] - quotas[name],
                name,
            ),
        )
        quotas[category] += 1
        assigned += 1
    return quotas


def _allocate_fine_strata(populations: Mapping[str, int], quota: int) -> dict[str, int]:
    cells = sorted(name for name, count in populations.items() if count > 0)
    if quota <= 0 or not cells:
        return {name: 0 for name in cells}
    allocation = {name: 0 for name in cells}
    if quota >= len(cells):
        for name in cells:
            allocation[name] = 1
        remaining = quota - len(cells)
    else:
        prioritized = sorted(cells, key=lambda name: (-populations[name], name))[:quota]
        for name in prioritized:
            allocation[name] = 1
        return allocation

    while remaining > 0:
        available = [name for name in cells if allocation[name] < populations[name]]
        if not available:
            break
        name = max(
            available,
            key=lambda cell: (
                (populations[cell] / sum(populations.values()))
                - (allocation[cell] / max(quota, 1)),
                populations[cell] - allocation[cell],
                cell,
            ),
        )
        allocation[name] += 1
        remaining -= 1
    return allocation


def _sample_candidates(
    candidates: Sequence[Candidate], sample_size: int, seed: str
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if sample_size <= 0:
        raise ReviewError("SAMPLE_SIZE_INVALID")
    sample_size = min(sample_size, len(candidates))
    by_category: dict[str, list[Candidate]] = defaultdict(list)
    for candidate in candidates:
        by_category[candidate.category].append(candidate)
    category_populations = {name: len(values) for name, values in by_category.items()}
    category_quotas = _allocate_category_quotas(category_populations, sample_size)

    selected: list[Candidate] = []
    stratum_stats: dict[str, dict[str, int]] = {}
    for category, _ in CATEGORY_SHARES:
        category_candidates = by_category.get(category, [])
        fine_groups: dict[str, list[Candidate]] = defaultdict(list)
        for candidate in category_candidates:
            fine_groups[candidate.fine_stratum].append(candidate)
        fine_populations = {name: len(values) for name, values in fine_groups.items()}
        allocations = _allocate_fine_strata(fine_populations, category_quotas.get(category, 0))
        for fine_stratum, group in sorted(fine_groups.items()):
            ordered = sorted(
                group,
                key=lambda item: (_stable_digest(seed, "select", item.event_id), item.event_id),
            )
            count = allocations.get(fine_stratum, 0)
            selected.extend(ordered[:count])
            stratum_stats[fine_stratum] = {
                "population": len(group),
                "selected": count,
            }

    items: list[dict[str, Any]] = []
    for candidate in selected:
        stats = stratum_stats[candidate.fine_stratum]
        review_item_id = "review_" + _stable_digest(seed, "item", candidate.event_id)[:32]
        items.append(
            {
                "review_item_id": review_item_id,
                "source_event_id": candidate.event_id,
                "course_id": candidate.course_id,
                "actor_id": candidate.actor_id,
                "platform_role_private": candidate.platform_role,
                "source_kind_private": candidate.source_kind,
                "sampling_category": candidate.category,
                "sampling_stratum": candidate.fine_stratum,
                "stratum_population": stats["population"],
                "stratum_sample": stats["selected"],
                "sampling_weight": stats["population"] / stats["selected"],
                "normalized_char_count_private": candidate.normalized_char_count,
                "paragraph_count_private": candidate.paragraph_count,
                "url_count_private": candidate.url_count,
                "course_length_cume_dist_private": candidate.course_length_cume_dist,
            }
        )
    items.sort(key=lambda item: (_stable_digest(seed, "display", item["review_item_id"]), item["review_item_id"]))
    for index, item in enumerate(items, start=1):
        item["display_order"] = index

    summary = {
        "candidate_count": len(candidates),
        "selected_count": len(items),
        "category_population": dict(sorted(category_populations.items())),
        "category_selected": dict(sorted(Counter(item["sampling_category"] for item in items).items())),
        "strata": dict(sorted(stratum_stats.items())),
    }
    return items, summary


def _write_batch(
    output_dir: Path,
    database: Path,
    manifest: Mapping[str, Any],
    items: Sequence[Mapping[str, Any]],
    summary: Mapping[str, Any],
    seed: str,
) -> dict[str, Any]:
    dataset_fingerprint = str(manifest["dataset_fingerprint"])
    batch_id = "batch_" + hashlib.sha256(
        "\x1f".join((dataset_fingerprint, seed, ALGORITHM_VERSION)).encode("utf-8")
    ).hexdigest()[:24]
    temp_dir = Path(
        tempfile.mkdtemp(prefix=f".{output_dir.name}.", dir=str(output_dir.parent))
    )
    try:
        private_manifest = {
            "schema_version": SCHEMA_VERSION,
            "algorithm_version": ALGORITHM_VERSION,
            "codebook_version": CODEBOOK_VERSION,
            "batch_id": batch_id,
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "dataset_fingerprint": dataset_fingerprint,
            "source_database_sha256": _file_sha256(database),
            "source_timezone": manifest["source_timezone"],
            "source_profile": manifest["source_profile"],
            "seed": seed,
            "identity_blind": True,
            "content_copied": False,
            "identity_inference_allowed": False,
            "summary": summary,
            "items": list(items),
        }
        (temp_dir / "private-manifest.json").write_text(
            json.dumps(private_manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        with (temp_dir / "blind-review.csv").open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=BLIND_COLUMNS)
            writer.writeheader()
            for item in items:
                writer.writerow(
                    {
                        "display_order": item["display_order"],
                        "review_item_id": item["review_item_id"],
                        "facilitation_present": "",
                        "primary_function": "",
                        "secondary_functions": "[]",
                        "confidence": "",
                        "coder_id": "",
                        "annotation_round": "1",
                        "adjudication_status": "unreviewed",
                    }
                )
        public_summary = {
            "ok": True,
            "mode": "sample",
            "schema_version": SCHEMA_VERSION,
            "batch_id": batch_id,
            "dataset_fingerprint": dataset_fingerprint,
            "selected_count": len(items),
            "category_selected": summary["category_selected"],
            "identity_blind": True,
            "content_copied": False,
            "identity_inference_allowed": False,
        }
        (temp_dir / "summary.json").write_text(
            json.dumps(public_summary, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        try:
            temp_dir.rename(output_dir)
        except FileExistsError as exc:
            raise ReviewError("OUTPUT_ALREADY_EXISTS") from exc
        return public_summary
    finally:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)


def create_review_batch(database_value: str, output_dir_value: str, sample_size: int, seed: str) -> dict[str, Any]:
    database = Path(database_value).expanduser().resolve()
    output_dir = _validate_output_dir(output_dir_value)
    seed = _validate_seed(seed)
    manifest, candidates = _load_candidates(database)
    items, summary = _sample_candidates(candidates, sample_size, seed)
    return _write_batch(output_dir, database, manifest, items, summary, seed)


def validate_annotations(batch_dir_value: str, annotations_value: str) -> dict[str, Any]:
    batch_dir = Path(batch_dir_value).expanduser().resolve()
    annotations = Path(annotations_value).expanduser().resolve()
    try:
        private_manifest = json.loads(
            (batch_dir / "private-manifest.json").read_text(encoding="utf-8")
        )
    except (OSError, json.JSONDecodeError) as exc:
        raise ReviewError("REVIEW_BATCH_INVALID") from exc
    if private_manifest.get("schema_version") != SCHEMA_VERSION:
        raise ReviewError("REVIEW_BATCH_INVALID")
    expected = {
        str(item["review_item_id"]): int(item["display_order"])
        for item in private_manifest.get("items", [])
    }
    if not expected:
        raise ReviewError("REVIEW_BATCH_INVALID")
    try:
        with annotations.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if tuple(reader.fieldnames or ()) != BLIND_COLUMNS:
                raise ReviewError("ANNOTATION_HEADERS_INVALID")
            rows = list(reader)
    except OSError as exc:
        raise ReviewError("ANNOTATION_FILE_UNAVAILABLE") from exc

    observed_ids = [str(row.get("review_item_id", "")) for row in rows]
    if (
        not observed_ids
        or len(observed_ids) != len(set(observed_ids))
        or not set(observed_ids).issubset(expected)
    ):
        raise ReviewError("ANNOTATION_ITEM_SET_INVALID")

    presence_counts: Counter[str] = Counter()
    primary_counts: Counter[str] = Counter()
    coder_ids: set[str] = set()
    rounds: set[int] = set()
    statuses: set[str] = set()
    for row in rows:
        review_item_id = str(row["review_item_id"])
        try:
            display_order = int(str(row["display_order"]))
            confidence = float(str(row["confidence"]))
            annotation_round = int(str(row["annotation_round"]))
        except (TypeError, ValueError) as exc:
            raise ReviewError("ANNOTATION_VALUE_INVALID") from exc
        if display_order != expected[review_item_id] or not 0.0 <= confidence <= 1.0:
            raise ReviewError("ANNOTATION_VALUE_INVALID")
        if annotation_round not in {1, 2}:
            raise ReviewError("ANNOTATION_VALUE_INVALID")

        presence = str(row["facilitation_present"]).strip()
        primary = str(row["primary_function"]).strip()
        coder_id = str(row["coder_id"]).strip()
        status = str(row["adjudication_status"]).strip()
        if presence not in {"yes", "no", "uncertain"}:
            raise ReviewError("ANNOTATION_VALUE_INVALID")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", coder_id):
            raise ReviewError("ANNOTATION_VALUE_INVALID")
        allowed_statuses = {
            1: {"single_coded", "pilot_single_coded", "validation_single_coded"},
            2: {"double_coded", "pilot_double_coded", "validation_double_coded", "adjudicated"},
        }
        if status not in allowed_statuses[annotation_round]:
            raise ReviewError("ANNOTATION_VALUE_INVALID")
        try:
            secondary = json.loads(str(row["secondary_functions"]))
        except json.JSONDecodeError as exc:
            raise ReviewError("ANNOTATION_VALUE_INVALID") from exc
        if (
            not isinstance(secondary, list)
            or any(not isinstance(label, str) for label in secondary)
            or len(secondary) != len(set(secondary))
            or any(label not in FUNCTION_LABELS for label in secondary)
        ):
            raise ReviewError("ANNOTATION_VALUE_INVALID")
        if presence == "yes":
            if primary not in FUNCTION_LABELS or primary in secondary:
                raise ReviewError("ANNOTATION_VALUE_INVALID")
        elif primary or secondary:
            raise ReviewError("ANNOTATION_VALUE_INVALID")

        presence_counts[presence] += 1
        if primary:
            primary_counts[primary] += 1
        coder_ids.add(coder_id)
        rounds.add(annotation_round)
        statuses.add(status)

    if len(rounds) != 1:
        raise ReviewError("ANNOTATION_PROVENANCE_INVALID")
    round_value = next(iter(rounds))
    if round_value == 2 and statuses.issubset({"double_coded", "adjudicated"}):
        completion_scope = "complete"
    elif len(statuses) == 1:
        status = next(iter(statuses))
        completion_scope = (
            "pilot" if status.startswith("pilot_")
            else "validation" if status.startswith("validation_")
            else "complete"
        )
    else:
        raise ReviewError("ANNOTATION_PROVENANCE_INVALID")
    if completion_scope == "complete" and set(observed_ids) != set(expected):
        raise ReviewError("ANNOTATION_ITEM_SET_INVALID")

    return {
        "ok": True,
        "mode": "validate",
        "schema_version": SCHEMA_VERSION,
        "batch_id": private_manifest["batch_id"],
        "annotation_rows": len(rows),
        "expected_rows": len(expected),
        "completion_scope": completion_scope,
        "completion_ratio": round(len(rows) / len(expected), 6),
        "adjudication_statuses": sorted(statuses),
        "presence_counts": dict(sorted(presence_counts.items())),
        "primary_function_counts": dict(sorted(primary_counts.items())),
        "coder_count": len(coder_ids),
        "annotation_rounds": sorted(rounds),
        "content_copied": False,
        "identity_inference_allowed": False,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    sample = subparsers.add_parser("sample", help="create an identity-blind review batch")
    sample.add_argument("--database", required=True)
    sample.add_argument("--output-dir", required=True)
    sample.add_argument("--sample-size", type=int, default=DEFAULT_SAMPLE_SIZE)
    sample.add_argument("--seed", default="p1d-default-v1")
    validate = subparsers.add_parser("validate", help="validate a completed blind review sheet")
    validate.add_argument("--batch-dir", required=True)
    validate.add_argument("--annotations", required=True)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = _parser().parse_args(list(argv) if argv is not None else None)
    try:
        if args.command == "sample":
            result = create_review_batch(
                args.database, args.output_dir, args.sample_size, args.seed
            )
        elif args.command == "validate":
            result = validate_annotations(args.batch_dir, args.annotations)
        else:
            raise ReviewError("COMMAND_INVALID")
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except ReviewError as exc:
        print(
            json.dumps({"ok": False, "error_code": exc.code}, ensure_ascii=False, sort_keys=True),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
