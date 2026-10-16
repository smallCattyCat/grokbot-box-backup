#!/usr/bin/env python3
"""Shared, transport-agnostic contract for cMOOC research annotation."""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from research_review_content import ReviewContent


PROMPT_VERSION = "facilitation-function-v1.1-model-prompt-v1"
OUTPUT_ROOT_ENV = "CMOOC_MODEL_OUTPUT_ROOT"
MODEL_COLUMNS = (
    "display_order",
    "review_item_id",
    "facilitation_present",
    "primary_function",
    "secondary_functions",
    "confidence",
    "evidence_codes",
    "model_run_id",
    "model_status",
)
FUNCTIONS = {
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
EVIDENCE_CODES = {
    "resource_shared",
    "open_question",
    "explicit_connection",
    "prior_contribution_highlighted",
    "multi_contribution_synthesis",
    "counterexample_or_boundary",
    "specific_affective_response",
    "participation_steps",
    "experience_plus_invitation",
    "no_other_directed_action",
    "insufficient_context",
}
PRIMARY_EVIDENCE = {
    "resource_seeding": "resource_shared",
    "question_guiding": "open_question",
    "idea_bridging": "explicit_connection",
    "amplification": "prior_contribution_highlighted",
    "synthesis": "multi_contribution_synthesis",
    "cognitive_challenge": "counterexample_or_boundary",
    "affective_support": "specific_affective_response",
    "coordination": "participation_steps",
    "peer_exchange": "experience_plus_invitation",
}
EXPECTED_RESULT_KEYS = {
    "facilitation_present",
    "primary_function",
    "secondary_functions",
    "confidence",
    "evidence_codes",
}

SYSTEM_PROMPT = """You are a research annotation engine for cMOOC forum posts.
Classify the function performed by this single post at publication time. Never infer the
author's identity, stable personality, teacher status, learner state, or later outcomes.

Decision boundary:
- Long, detailed, well-structured, or informative does not automatically mean facilitation.
- resource_seeding requires a relevant resource, case, tool, or actionable scheme that others can continue using.
- question_guiding requires an answerable open, staged, or clarifying question intended to elicit later inquiry; rhetorical, heading, and self-answered questions do not count.
- idea_bridging requires an explicit relationship between at least two identifiable ideas, posts, people, or practice contexts; merely listing sections does not count.
- amplification requires highlighting a specific existing contribution by another participant; recommending an article or describing amplification as a method does not count.
- synthesis requires integrating multiple existing contributions or discussion evidence into a structure that can move the discussion forward; summarizing one's own post does not count.
- cognitive_challenge requires a counterexample, contradiction, boundary condition, or alternative explanation directed at an existing claim.
- affective_support requires a concrete response to expressed difficulty, frustration, or isolation, with tailored encouragement or task support.
- coordination requires actionable participation steps, times, roles, or task allocation; an ended-event recap or unsupported administrative notice does not count.
- peer_exchange requires both first-person experience and an explicit invitation to compare, add, or learn mutually; a generic essay or one-way repost does not count.

Return exactly one JSON object with these keys only:
facilitation_present: yes | no | uncertain
primary_function: one controlled function above, or empty string
secondary_functions: array of distinct controlled functions excluding the primary
confidence: number from 0 to 1
evidence_codes: array chosen only from resource_shared, open_question, explicit_connection,
prior_contribution_highlighted, multi_contribution_synthesis, counterexample_or_boundary,
specific_affective_response, participation_steps, experience_plus_invitation,
no_other_directed_action, insufficient_context.

For yes, the evidence code matching the primary and every secondary function is mandatory.
For no or uncertain, primary_function and secondary_functions must be empty and the only
evidence code must be no_other_directed_action or insufficient_context respectively. Use
uncertain when necessary context is missing. Do not output explanations, quotes, names, or
free text."""


class ModelAnnotationError(RuntimeError):
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


def _output_root() -> Path:
    configured = os.environ.get(OUTPUT_ROOT_ENV)
    if configured:
        return Path(configured).expanduser().resolve()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise ModelAnnotationError("LOCAL_OUTPUT_ROOT_REQUIRED")
    return Path(local_app_data).resolve() / "cmooc-research" / "p1h"


def _validate_output_dir(value: str, *, resume: bool) -> Path:
    root = _output_root()
    output = Path(value).expanduser().resolve(strict=False)
    if (
        str(root).startswith("\\\\")
        or str(output).startswith("\\\\")
        or output == root
        or not _contains(root, output)
        or _contains(_repo_root().resolve(), output)
    ):
        raise ModelAnnotationError("OUTPUT_OUTSIDE_LOCAL_ROOT")
    if resume:
        if not output.is_dir():
            raise ModelAnnotationError("RESUME_OUTPUT_UNAVAILABLE")
    elif output.exists():
        raise ModelAnnotationError("OUTPUT_ALREADY_EXISTS")
    else:
        root.mkdir(parents=True, exist_ok=True)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.mkdir()
    return output


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_json(path: Path, payload: Mapping[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    temporary.replace(path)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_user_prompt(content: ReviewContent) -> str:
    truncation = "yes" if content.suspected_truncation else "no"
    return (
        f"Title:\n{content.title}\n\n"
        f"Body:\n{content.body}\n\n"
        f"Source cell suspected truncated: {truncation}\n"
        "Classify only this redacted content using the required JSON schema."
    )


def validate_model_result(value: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != EXPECTED_RESULT_KEYS:
        raise ModelAnnotationError("MODEL_RESULT_SCHEMA_INVALID")
    presence = value.get("facilitation_present")
    primary = value.get("primary_function")
    secondary = value.get("secondary_functions")
    confidence = value.get("confidence")
    evidence = value.get("evidence_codes")
    if (
        presence not in {"yes", "no", "uncertain"}
        or not isinstance(primary, str)
        or not isinstance(secondary, list)
        or not isinstance(evidence, list)
        or isinstance(confidence, bool)
        or not isinstance(confidence, (int, float))
        or not 0.0 <= float(confidence) <= 1.0
        or any(not isinstance(item, str) for item in secondary)
        or any(not isinstance(item, str) for item in evidence)
        or len(secondary) != len(set(secondary))
        or len(evidence) != len(set(evidence))
        or not set(secondary).issubset(FUNCTIONS)
        or not set(evidence).issubset(EVIDENCE_CODES)
        or not evidence
    ):
        raise ModelAnnotationError("MODEL_RESULT_VALUE_INVALID")
    if presence == "yes":
        if (
            primary not in FUNCTIONS
            or primary in secondary
            or float(confidence) < 0.4
            or PRIMARY_EVIDENCE[primary] not in evidence
            or any(PRIMARY_EVIDENCE[label] not in evidence for label in secondary)
            or "no_other_directed_action" in evidence
            or "insufficient_context" in evidence
        ):
            raise ModelAnnotationError("MODEL_RESULT_EVIDENCE_INVALID")
    elif (
        primary
        or secondary
        or (presence == "no" and set(evidence) != {"no_other_directed_action"})
        or (presence == "uncertain" and set(evidence) != {"insufficient_context"})
    ):
        raise ModelAnnotationError("MODEL_RESULT_EVIDENCE_INVALID")
    return {
        "facilitation_present": presence,
        "primary_function": primary,
        "secondary_functions": sorted(secondary),
        "confidence": round(float(confidence), 4),
        "evidence_codes": sorted(evidence),
    }


def _extract_json_object(text: str) -> Mapping[str, Any]:
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.I)
    candidate = fenced.group(1).strip() if fenced else text.strip()
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start < 0 or end <= start:
            raise ModelAnnotationError("MODEL_RESPONSE_JSON_INVALID")
        try:
            parsed = json.loads(candidate[start : end + 1])
        except json.JSONDecodeError as exc:
            raise ModelAnnotationError("MODEL_RESPONSE_JSON_INVALID") from exc
    if not isinstance(parsed, Mapping):
        raise ModelAnnotationError("MODEL_RESPONSE_JSON_INVALID")
    return parsed


def _write_csv(path: Path, records: Sequence[Mapping[str, Any]]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=MODEL_COLUMNS, lineterminator="\n")
        writer.writeheader()
        for record in records:
            writer.writerow({column: record[column] for column in MODEL_COLUMNS})
    temporary.replace(path)
