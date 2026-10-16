#!/usr/bin/env python3
"""Blindly annotate redacted P1d review content with a loopback-only model."""

from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from research_annotation_core import (
    EVIDENCE_CODES,
    EXPECTED_RESULT_KEYS,
    FUNCTIONS,
    MODEL_COLUMNS,
    OUTPUT_ROOT_ENV,
    PRIMARY_EVIDENCE,
    PROMPT_VERSION,
    SYSTEM_PROMPT,
    ModelAnnotationError,
    _atomic_json,
    _extract_json_object,
    _now,
    _sha256_bytes,
    _sha256_file,
    _validate_output_dir,
    _write_csv,
    build_user_prompt,
    validate_model_result,
)
from research_review_content import (
    HMAC_ENV,
    ReviewContent,
    ReviewContentError,
    load_hmac_key,
    load_review_contents,
)
from research_review_server import _load_selection_file


SCHEMA_VERSION = "p1h-local-model-annotation-v1"
API_KEY_ENV = "CMOOC_LOCAL_MODEL_API_KEY"


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(
        self,
        req: Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> Request | None:
        return None


@dataclass(frozen=True)
class ModelConfig:
    base_url: str
    model: str
    timeout_seconds: float = 120.0
    temperature: float = 0.0
    api_key: str = ""


ModelCaller = Callable[[str, str, ModelConfig], Mapping[str, Any]]


def validate_local_base_url(value: str) -> str:
    try:
        parsed = urlsplit(value.strip())
    except ValueError as exc:
        raise ModelAnnotationError("MODEL_BASE_URL_INVALID") from exc
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not parsed.netloc
    ):
        raise ModelAnnotationError("REMOTE_ENDPOINT_FORBIDDEN")
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _validate_model_name(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9._:/-]{1,160}", value):
        raise ModelAnnotationError("MODEL_NAME_INVALID")
    return value


def call_openai_compatible(system: str, user: str, config: ModelConfig) -> Mapping[str, Any]:
    payload = {
        "model": config.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": config.temperature,
        "response_format": {"type": "json_object"},
    }
    headers = {"Content-Type": "application/json"}
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"
    request = Request(
        f"{config.base_url}/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with build_opener(_RejectRedirects()).open(
            request, timeout=config.timeout_seconds
        ) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
    except HTTPError as exc:
        if 300 <= exc.code < 400:
            raise ModelAnnotationError(
                "MODEL_REDIRECT_FORBIDDEN"
            ) from exc
        raise ModelAnnotationError("MODEL_REQUEST_FAILED") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise ModelAnnotationError("MODEL_REQUEST_FAILED") from exc
    if len(raw) > 2 * 1024 * 1024:
        raise ModelAnnotationError("MODEL_RESPONSE_TOO_LARGE")
    try:
        envelope = json.loads(raw.decode("utf-8"))
        content = envelope["choices"][0]["message"]["content"]
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
        raise ModelAnnotationError("MODEL_RESPONSE_ENVELOPE_INVALID") from exc
    if not isinstance(content, str) or not content.strip():
        raise ModelAnnotationError("MODEL_RESPONSE_ENVELOPE_INVALID")
    return _extract_json_object(content)


def _fingerprint(
    *, batch_id: str, selection_id: str | None, base_url: str, model: str
) -> tuple[str, str]:
    prompt_sha256 = _sha256_bytes((SYSTEM_PROMPT + "\n" + PROMPT_VERSION).encode("utf-8"))
    canonical = "\x1f".join(
        [SCHEMA_VERSION, batch_id, selection_id or "full", base_url, model, prompt_sha256]
    )
    return _sha256_bytes(canonical.encode("utf-8")), prompt_sha256


def execute_annotation_run(
    *,
    public_batch: Mapping[str, Any],
    contents: Mapping[str, ReviewContent],
    output_dir_value: str,
    base_url: str,
    model: str,
    selection_id: str | None,
    caller: ModelCaller = call_openai_compatible,
    resume: bool = False,
    timeout_seconds: float = 120.0,
    api_key: str = "",
) -> dict[str, Any]:
    normalized_url = validate_local_base_url(base_url)
    normalized_model = _validate_model_name(model)
    if not 1.0 <= timeout_seconds <= 1800.0:
        raise ModelAnnotationError("MODEL_TIMEOUT_INVALID")
    if not contents:
        raise ModelAnnotationError("MODEL_INPUT_EMPTY")
    ordered = sorted(contents.values(), key=lambda item: item.display_order)
    if (
        len({item.review_item_id for item in ordered}) != len(ordered)
        or len({item.display_order for item in ordered}) != len(ordered)
        or any(contents.get(item.review_item_id) != item for item in ordered)
    ):
        raise ModelAnnotationError("MODEL_INPUT_INVALID")
    batch_id = str(public_batch.get("batch_id", ""))
    if not re.fullmatch(r"batch_[A-Za-z0-9_-]{1,96}", batch_id):
        raise ModelAnnotationError("MODEL_INPUT_INVALID")
    run_id, prompt_sha256 = _fingerprint(
        batch_id=batch_id,
        selection_id=selection_id,
        base_url=normalized_url,
        model=normalized_model,
    )
    output_dir = _validate_output_dir(output_dir_value, resume=resume)
    manifest_path = output_dir / "run-manifest.json"
    partial_path = output_dir / "model-annotations.partial.json"
    final_path = output_dir / "model-annotations.csv"
    expected_ids = [item.review_item_id for item in ordered]
    expected_manifest = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "batch_id": batch_id,
        "selection_id": selection_id,
        "item_count": len(ordered),
        "review_item_ids_sha256": _sha256_bytes("\n".join(expected_ids).encode("utf-8")),
        "model": normalized_model,
        "base_url": normalized_url,
        "prompt_version": PROMPT_VERSION,
        "prompt_sha256": prompt_sha256,
        "temperature": 0.0,
        "human_annotations_loaded": False,
        "remote_endpoint_allowed": False,
        "mock_fallback_allowed": False,
        "model_labels_are_gold_standard": False,
        "content_persisted": False,
        "identity_blind": True,
    }
    completed: dict[str, dict[str, Any]] = {}
    if resume:
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            partial = json.loads(partial_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ModelAnnotationError("RESUME_STATE_INVALID") from exc
        if any(manifest.get(key) != value for key, value in expected_manifest.items()):
            raise ModelAnnotationError("RESUME_PROVENANCE_MISMATCH")
        raw_completed = partial.get("annotations") if isinstance(partial, dict) else None
        if not isinstance(raw_completed, dict) or not set(raw_completed).issubset(expected_ids):
            raise ModelAnnotationError("RESUME_STATE_INVALID")
        for review_id, record in raw_completed.items():
            if not isinstance(record, dict):
                raise ModelAnnotationError("RESUME_STATE_INVALID")
            normalized = validate_model_result(
                {
                    "facilitation_present": record.get("facilitation_present"),
                    "primary_function": record.get("primary_function"),
                    "secondary_functions": record.get("secondary_functions"),
                    "confidence": record.get("confidence"),
                    "evidence_codes": record.get("evidence_codes"),
                }
            )
            completed[review_id] = normalized
    else:
        manifest = {
            **expected_manifest,
            "status": "running",
            "started_at": _now(),
            "updated_at": _now(),
            "completed_item_count": 0,
            "failed_item_id": None,
            "failure_code": None,
        }
        _atomic_json(manifest_path, manifest)
        _atomic_json(partial_path, {"schema_version": SCHEMA_VERSION, "annotations": {}})

    config = ModelConfig(
        base_url=normalized_url,
        model=normalized_model,
        timeout_seconds=timeout_seconds,
        temperature=0.0,
        api_key=api_key,
    )
    try:
        for item in ordered:
            if item.review_item_id in completed:
                continue
            raw = caller(SYSTEM_PROMPT, build_user_prompt(item), config)
            completed[item.review_item_id] = validate_model_result(raw)
            _atomic_json(
                partial_path,
                {"schema_version": SCHEMA_VERSION, "annotations": completed},
            )
            manifest = {
                **expected_manifest,
                "status": "running",
                "started_at": manifest.get("started_at", _now()),
                "updated_at": _now(),
                "completed_item_count": len(completed),
                "failed_item_id": None,
                "failure_code": None,
            }
            _atomic_json(manifest_path, manifest)
    except ModelAnnotationError as exc:
        failed_id = next(
            (item.review_item_id for item in ordered if item.review_item_id not in completed),
            None,
        )
        manifest = {
            **expected_manifest,
            "status": "failed",
            "started_at": manifest.get("started_at", _now()),
            "updated_at": _now(),
            "completed_item_count": len(completed),
            "failed_item_id": failed_id,
            "failure_code": exc.code,
        }
        _atomic_json(manifest_path, manifest)
        raise

    rows: list[dict[str, Any]] = []
    for item in ordered:
        annotation = completed[item.review_item_id]
        rows.append(
            {
                "display_order": item.display_order,
                "review_item_id": item.review_item_id,
                "facilitation_present": annotation["facilitation_present"],
                "primary_function": annotation["primary_function"],
                "secondary_functions": json.dumps(
                    annotation["secondary_functions"], ensure_ascii=False, separators=(",", ":")
                ),
                "confidence": f"{annotation['confidence']:.4f}",
                "evidence_codes": json.dumps(
                    annotation["evidence_codes"], ensure_ascii=False, separators=(",", ":")
                ),
                "model_run_id": run_id,
                "model_status": "model_weak_label",
            }
        )
    _write_csv(final_path, rows)
    if partial_path.exists():
        partial_path.unlink()
    manifest = {
        **expected_manifest,
        "status": "complete",
        "started_at": manifest.get("started_at", _now()),
        "updated_at": _now(),
        "completed_at": _now(),
        "completed_item_count": len(rows),
        "failed_item_id": None,
        "failure_code": None,
        "annotations_sha256": _sha256_file(final_path),
    }
    _atomic_json(manifest_path, manifest)
    return {
        "ok": True,
        "mode": "run",
        "status": "complete",
        "run_id": run_id,
        "item_count": len(rows),
        "output_dir": str(output_dir),
        "content_persisted": False,
        "human_annotations_loaded": False,
        "model_labels_are_gold_standard": False,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("check", "run"):
        sub = subparsers.add_parser(command)
        sub.add_argument("--batch-dir", required=True)
        sub.add_argument("--research-database", required=True)
        sub.add_argument("--input-root", required=True)
        sub.add_argument("--selection-file")
        sub.add_argument("--base-url", required=True)
        sub.add_argument("--model", required=True)
        if command == "run":
            sub.add_argument("--output-dir", required=True)
            sub.add_argument("--resume", action="store_true")
            sub.add_argument("--timeout-seconds", type=float, default=120.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        base_url = validate_local_base_url(args.base_url)
        model = _validate_model_name(args.model)
        selected_ids, selection_id = _load_selection_file(args.selection_file)
        key = load_hmac_key()
        os.environ.pop(HMAC_ENV, None)
        public_batch, contents = load_review_contents(
            batch_dir_value=args.batch_dir,
            research_database_value=args.research_database,
            input_root_value=args.input_root,
            key=key,
            selected_review_ids=selected_ids,
        )
        del key
        if args.command == "check":
            result = {
                "ok": True,
                "mode": "check",
                "batch_id": public_batch["batch_id"],
                "selected_count": len(contents),
                "selection_id": selection_id,
                "base_url": base_url,
                "model": model,
                "remote_endpoint_allowed": False,
                "human_annotations_loaded": False,
                "content_persisted": False,
                "identity_blind": True,
            }
        else:
            result = execute_annotation_run(
                public_batch=public_batch,
                contents=contents,
                output_dir_value=args.output_dir,
                base_url=base_url,
                model=model,
                selection_id=selection_id,
                resume=args.resume,
                timeout_seconds=args.timeout_seconds,
                api_key=os.environ.get(API_KEY_ENV, ""),
            )
    except (ModelAnnotationError, ReviewContentError) as exc:
        code = exc.code if hasattr(exc, "code") else "MODEL_ANNOTATION_FAILED"
        print(json.dumps({"ok": False, "error": code}, ensure_ascii=False))
        return 2
    finally:
        os.environ.pop(HMAC_ENV, None)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
