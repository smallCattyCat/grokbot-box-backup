#!/usr/bin/env python3
"""Blindly annotate redacted P1d content through an explicitly authorized online model."""

from __future__ import annotations

import argparse
import base64
import ipaddress
import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from research_annotation_core import (
    MODEL_COLUMNS,
    OUTPUT_ROOT_ENV,
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


SCHEMA_VERSION = "p1h-online-model-annotation-v1"
API_KEY_ENV = "CMOOC_ONLINE_MODEL_API_KEY"
REMOTE_CONSENT_PHRASE = "I_AUTHORIZE_REDACTED_RESEARCH_DATA_TRANSFER"
REMOTE_CONSENT_VERSION = "p1h-redacted-selected-posts-v1"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
ANTHROPIC_PROTOCOL = "anthropic_messages_2023_06_01"
DASHSCOPE_ENCRYPTED_PROTOCOL = "dashscope_encrypted_aes_gcm_v1"
PROTOCOLS = (ANTHROPIC_PROTOCOL, DASHSCOPE_ENCRYPTED_PROTOCOL)
MODEL_NAME_PATTERN = re.compile(r"[A-Za-z0-9._:/\[\]-]{1,160}")
HOST_PATTERN = re.compile(
    r"(?=.{1,253}\Z)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}"
)


class OnlineAnnotationError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


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
        raise OnlineAnnotationError("ONLINE_REDIRECT_FORBIDDEN")


@dataclass(frozen=True)
class OnlineModelConfig:
    base_url: str
    model: str
    api_key: str
    timeout_seconds: float = 120.0
    max_tokens: int = 1024
    temperature: float = 0.0


@dataclass(frozen=True)
class OnlineModelResponse:
    result: Mapping[str, Any]
    input_tokens: int
    output_tokens: int
    response_model: str = ""


OnlineCaller = Callable[[str, str, OnlineModelConfig], OnlineModelResponse]


def _request_bytes(request: Request, *, timeout_seconds: float) -> bytes:
    try:
        with build_opener(_RejectRedirects()).open(
            request, timeout=timeout_seconds
        ) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except OnlineAnnotationError:
        raise
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise OnlineAnnotationError("ONLINE_REQUEST_FAILED") from exc
    if len(raw) > MAX_RESPONSE_BYTES:
        raise OnlineAnnotationError("ONLINE_RESPONSE_TOO_LARGE")
    return raw


def _request_json(request: Request, *, timeout_seconds: float) -> Mapping[str, Any]:
    raw = _request_bytes(request, timeout_seconds=timeout_seconds)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise OnlineAnnotationError("ONLINE_RESPONSE_ENVELOPE_INVALID") from exc
    if not isinstance(value, dict):
        raise OnlineAnnotationError("ONLINE_RESPONSE_ENVELOPE_INVALID")
    return value


def validate_online_base_url(value: str, *, expected_host: str) -> str:
    expected = expected_host.strip().lower().rstrip(".")
    if not HOST_PATTERN.fullmatch(expected):
        raise OnlineAnnotationError("ONLINE_EXPECTED_HOST_INVALID")
    try:
        parsed = urlsplit(value.strip())
    except ValueError as exc:
        raise OnlineAnnotationError("ONLINE_BASE_URL_INVALID") from exc
    hostname = (parsed.hostname or "").lower().rstrip(".")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if (
        parsed.scheme != "https"
        or hostname != expected
        or address is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not parsed.netloc
    ):
        raise OnlineAnnotationError("ONLINE_ENDPOINT_NOT_AUTHORIZED")
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _validate_model(value: str) -> str:
    if not MODEL_NAME_PATTERN.fullmatch(value):
        raise OnlineAnnotationError("ONLINE_MODEL_NAME_INVALID")
    return value


def call_anthropic_messages(
    system: str, user: str, config: OnlineModelConfig
) -> OnlineModelResponse:
    payload = {
        "model": config.model,
        "system": system,
        "messages": [{"role": "user", "content": user}],
        "max_tokens": config.max_tokens,
        "temperature": config.temperature,
    }
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(
        f"{config.base_url}/v1/messages",
        data=encoded,
        headers={
            "Authorization": f"Bearer {config.api_key}",
            "x-api-key": config.api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    envelope = _request_json(request, timeout_seconds=config.timeout_seconds)
    try:
        blocks = envelope["content"]
        usage = envelope["usage"]
        response_model = str(envelope.get("model", ""))
        text_blocks = [
            block["text"]
            for block in blocks
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        input_tokens = int(usage["input_tokens"])
        output_tokens = int(usage["output_tokens"])
    except (
        KeyError,
        TypeError,
        ValueError,
    ) as exc:
        raise OnlineAnnotationError("ONLINE_RESPONSE_ENVELOPE_INVALID") from exc
    if (
        not isinstance(blocks, list)
        or len(text_blocks) != 1
        or not isinstance(text_blocks[0], str)
        or not text_blocks[0].strip()
        or input_tokens < 0
        or output_tokens < 0
    ):
        raise OnlineAnnotationError("ONLINE_RESPONSE_ENVELOPE_INVALID")
    return OnlineModelResponse(
        result=_extract_json_object(text_blocks[0]),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        response_model=response_model,
    )


def _dashscope_output_text(value: Any) -> str:
    if isinstance(value, str) and value.strip():
        return value
    if not isinstance(value, dict):
        raise OnlineAnnotationError("ONLINE_RESPONSE_ENVELOPE_INVALID")
    choices = value.get("choices")
    if isinstance(choices, list) and len(choices) == 1 and isinstance(choices[0], dict):
        message = choices[0].get("message")
        if isinstance(message, dict) and isinstance(message.get("content"), str):
            return message["content"]
    for key in ("text", "content"):
        if isinstance(value.get(key), str) and value[key].strip():
            return value[key]
    raise OnlineAnnotationError("ONLINE_RESPONSE_ENVELOPE_INVALID")


class DashScopeEncryptedCaller:
    """DashScope text-generation transport with per-request AES-GCM input encryption."""

    def __init__(self) -> None:
        self._public_key_id = ""
        self._public_key: Any = None
        self._key_loaded_at = 0.0

    def _load_public_key(self, config: OnlineModelConfig) -> tuple[str, Any]:
        if self._public_key is not None and time.monotonic() - self._key_loaded_at < 55:
            return self._public_key_id, self._public_key
        request = Request(
            f"{config.base_url}/public-keys/latest",
            headers={"Authorization": f"Bearer {config.api_key}"},
            method="GET",
        )
        envelope = _request_json(request, timeout_seconds=config.timeout_seconds)
        try:
            data = envelope["data"]
            public_key_id = str(data["public_key_id"])
            encoded_key = str(data["public_key"])
            public_key = serialization.load_der_public_key(
                base64.b64decode(encoded_key, validate=True)
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise OnlineAnnotationError("DASHSCOPE_PUBLIC_KEY_INVALID") from exc
        if not public_key_id or not hasattr(public_key, "encrypt"):
            raise OnlineAnnotationError("DASHSCOPE_PUBLIC_KEY_INVALID")
        self._public_key_id = public_key_id
        self._public_key = public_key
        self._key_loaded_at = time.monotonic()
        return public_key_id, public_key

    def __call__(
        self, system: str, user: str, config: OnlineModelConfig
    ) -> OnlineModelResponse:
        public_key_id, public_key = self._load_public_key(config)
        aes_key = os.urandom(32)
        iv = os.urandom(12)
        plaintext = json.dumps(
            {
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ]
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        encrypted_input = AESGCM(aes_key).encrypt(iv, plaintext, b"")
        encrypted_key = public_key.encrypt(
            base64.b64encode(aes_key), padding.PKCS1v15()
        )
        encryption_header = json.dumps(
            {
                "public_key_id": public_key_id,
                "encrypt_key": base64.b64encode(encrypted_key).decode("ascii"),
                "iv": base64.b64encode(iv).decode("ascii"),
            },
            separators=(",", ":"),
        )
        payload = {
            "model": config.model,
            "input": base64.b64encode(encrypted_input).decode("ascii"),
            "parameters": {
                "result_format": "message",
                "temperature": config.temperature,
                "max_tokens": config.max_tokens,
                "enable_thinking": False,
            },
        }
        request = Request(
            f"{config.base_url}/services/aigc/text-generation/generation",
            data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {config.api_key}",
                "X-DashScope-EncryptionKey": encryption_header,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        envelope = _request_json(request, timeout_seconds=config.timeout_seconds)
        try:
            encrypted_output = base64.b64decode(str(envelope["output"]), validate=True)
            decrypted = AESGCM(aes_key).decrypt(iv, encrypted_output, b"")
            decoded = decrypted.decode("utf-8")
            try:
                output: Any = json.loads(decoded)
            except json.JSONDecodeError:
                output = decoded
            usage = envelope["usage"]
            input_tokens = int(usage["input_tokens"])
            output_tokens = int(usage["output_tokens"])
        except (
            KeyError,
            TypeError,
            ValueError,
            UnicodeDecodeError,
            InvalidTag,
        ) as exc:
            raise OnlineAnnotationError("ONLINE_RESPONSE_ENVELOPE_INVALID") from exc
        if input_tokens < 0 or output_tokens < 0:
            raise OnlineAnnotationError("ONLINE_RESPONSE_ENVELOPE_INVALID")
        return OnlineModelResponse(
            result=_extract_json_object(_dashscope_output_text(output)),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            response_model=config.model,
        )


def _fingerprint(
    *,
    batch_id: str,
    selection_id: str | None,
    base_url: str,
    model: str,
    protocol: str,
) -> tuple[str, str]:
    prompt_sha256 = _sha256_bytes((SYSTEM_PROMPT + "\n" + PROMPT_VERSION).encode("utf-8"))
    canonical = "\x1f".join(
        [
            SCHEMA_VERSION,
            batch_id,
            selection_id or "full",
            base_url,
            model,
            protocol,
            prompt_sha256,
        ]
    )
    return _sha256_bytes(canonical.encode("utf-8")), prompt_sha256


def execute_online_annotation_run(
    *,
    public_batch: Mapping[str, Any],
    contents: Mapping[str, ReviewContent],
    output_dir_value: str,
    base_url: str,
    expected_host: str,
    model: str,
    api_key: str,
    consent_phrase: str,
    selection_id: str | None,
    protocol: str = ANTHROPIC_PROTOCOL,
    caller: OnlineCaller | None = None,
    resume: bool = False,
    timeout_seconds: float = 120.0,
    max_tokens: int = 1024,
) -> dict[str, Any]:
    if consent_phrase != REMOTE_CONSENT_PHRASE:
        raise OnlineAnnotationError("REMOTE_DATA_CONSENT_REQUIRED")
    normalized_url = validate_online_base_url(base_url, expected_host=expected_host)
    normalized_model = _validate_model(model)
    if protocol not in PROTOCOLS:
        raise OnlineAnnotationError("ONLINE_PROTOCOL_INVALID")
    if caller is None:
        caller = (
            DashScopeEncryptedCaller()
            if protocol == DASHSCOPE_ENCRYPTED_PROTOCOL
            else call_anthropic_messages
        )
    if len(api_key) < 8:
        raise OnlineAnnotationError("ONLINE_API_KEY_INVALID")
    if not 1.0 <= timeout_seconds <= 1800.0 or not 128 <= max_tokens <= 4096:
        raise OnlineAnnotationError("ONLINE_GENERATION_LIMIT_INVALID")
    if not contents:
        raise OnlineAnnotationError("ONLINE_INPUT_EMPTY")
    ordered = sorted(contents.values(), key=lambda item: item.display_order)
    if (
        len({item.review_item_id for item in ordered}) != len(ordered)
        or len({item.display_order for item in ordered}) != len(ordered)
        or any(contents.get(item.review_item_id) != item for item in ordered)
    ):
        raise OnlineAnnotationError("ONLINE_INPUT_INVALID")
    batch_id = str(public_batch.get("batch_id", ""))
    if not re.fullmatch(r"batch_[A-Za-z0-9_-]{1,96}", batch_id):
        raise OnlineAnnotationError("ONLINE_INPUT_INVALID")
    run_id, prompt_sha256 = _fingerprint(
        batch_id=batch_id,
        selection_id=selection_id,
        base_url=normalized_url,
        model=normalized_model,
        protocol=protocol,
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
        "provider_host": expected_host.lower(),
        "protocol": protocol,
        "application_layer_input_encryption": protocol
        == DASHSCOPE_ENCRYPTED_PROTOCOL,
        "encryption_scheme": (
            "aes_256_gcm_with_provider_rsa_key"
            if protocol == DASHSCOPE_ENCRYPTED_PROTOCOL
            else None
        ),
        "prompt_version": PROMPT_VERSION,
        "prompt_sha256": prompt_sha256,
        "temperature": 0.0,
        "max_tokens": max_tokens,
        "remote_endpoint_allowed": True,
        "remote_data_transfer_authorized": True,
        "remote_consent_version": REMOTE_CONSENT_VERSION,
        "remote_data_scope": "identity_blind_redacted_selected_posts",
        "redirects_allowed": False,
        "human_annotations_loaded": False,
        "mock_fallback_allowed": False,
        "model_labels_are_gold_standard": False,
        "content_persisted": False,
        "identity_blind": True,
    }
    completed: dict[str, dict[str, Any]] = {}
    usage_totals = {"input_tokens": 0, "output_tokens": 0}
    response_models: set[str] = set()
    if resume:
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            partial = json.loads(partial_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise OnlineAnnotationError("ONLINE_RESUME_STATE_INVALID") from exc
        if any(manifest.get(key) != value for key, value in expected_manifest.items()):
            raise OnlineAnnotationError("ONLINE_RESUME_PROVENANCE_MISMATCH")
        raw_completed = partial.get("annotations") if isinstance(partial, dict) else None
        raw_usage = partial.get("usage") if isinstance(partial, dict) else None
        raw_models = partial.get("response_models") if isinstance(partial, dict) else None
        if (
            not isinstance(raw_completed, dict)
            or not set(raw_completed).issubset(expected_ids)
            or not isinstance(raw_usage, dict)
            or set(raw_usage) != {"input_tokens", "output_tokens"}
            or any(not isinstance(raw_usage[key], int) or raw_usage[key] < 0 for key in raw_usage)
            or not isinstance(raw_models, list)
            or any(
                not isinstance(value, str)
                or (value and not MODEL_NAME_PATTERN.fullmatch(value))
                for value in raw_models
            )
        ):
            raise OnlineAnnotationError("ONLINE_RESUME_STATE_INVALID")
        for review_id, record in raw_completed.items():
            if not isinstance(record, dict):
                raise OnlineAnnotationError("ONLINE_RESUME_STATE_INVALID")
            completed[review_id] = validate_model_result(record)
        usage_totals = dict(raw_usage)
        response_models = set(raw_models)
    else:
        manifest = {
            **expected_manifest,
            "status": "running",
            "started_at": _now(),
            "updated_at": _now(),
            "completed_item_count": 0,
            "failed_item_id": None,
            "failure_code": None,
            "usage": usage_totals,
            "response_models": [],
        }
        _atomic_json(manifest_path, manifest)
        _atomic_json(
            partial_path,
            {
                "schema_version": SCHEMA_VERSION,
                "annotations": {},
                "usage": usage_totals,
                "response_models": [],
            },
        )

    config = OnlineModelConfig(
        base_url=normalized_url,
        model=normalized_model,
        api_key=api_key,
        timeout_seconds=timeout_seconds,
        max_tokens=max_tokens,
        temperature=0.0,
    )
    try:
        for item in ordered:
            if item.review_item_id in completed:
                continue
            response = caller(SYSTEM_PROMPT, build_user_prompt(item), config)
            if (
                not isinstance(response, OnlineModelResponse)
                or response.input_tokens < 0
                or response.output_tokens < 0
                or (
                    response.response_model
                    and not MODEL_NAME_PATTERN.fullmatch(response.response_model)
                )
            ):
                raise OnlineAnnotationError("ONLINE_CALLER_RESULT_INVALID")
            completed[item.review_item_id] = validate_model_result(response.result)
            usage_totals["input_tokens"] += response.input_tokens
            usage_totals["output_tokens"] += response.output_tokens
            if response.response_model:
                response_models.add(response.response_model)
            _atomic_json(
                partial_path,
                {
                    "schema_version": SCHEMA_VERSION,
                    "annotations": completed,
                    "usage": usage_totals,
                    "response_models": sorted(response_models),
                },
            )
            manifest = {
                **expected_manifest,
                "status": "running",
                "started_at": manifest.get("started_at", _now()),
                "updated_at": _now(),
                "completed_item_count": len(completed),
                "failed_item_id": None,
                "failure_code": None,
                "usage": usage_totals,
                "response_models": sorted(response_models),
            }
            _atomic_json(manifest_path, manifest)
    except (OnlineAnnotationError, ModelAnnotationError) as exc:
        failed_id = next(
            (item.review_item_id for item in ordered if item.review_item_id not in completed),
            None,
        )
        code = exc.code
        manifest = {
            **expected_manifest,
            "status": "failed",
            "started_at": manifest.get("started_at", _now()),
            "updated_at": _now(),
            "completed_item_count": len(completed),
            "failed_item_id": failed_id,
            "failure_code": code,
            "usage": usage_totals,
            "response_models": sorted(response_models),
        }
        _atomic_json(manifest_path, manifest)
        raise
    except Exception as exc:
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
            "failure_code": "ONLINE_UNEXPECTED_FAILURE",
            "usage": usage_totals,
            "response_models": sorted(response_models),
        }
        _atomic_json(manifest_path, manifest)
        raise OnlineAnnotationError("ONLINE_UNEXPECTED_FAILURE") from exc

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
    partial_path.unlink(missing_ok=True)
    manifest = {
        **expected_manifest,
        "status": "complete",
        "started_at": manifest.get("started_at", _now()),
        "updated_at": _now(),
        "completed_at": _now(),
        "completed_item_count": len(rows),
        "failed_item_id": None,
        "failure_code": None,
        "usage": usage_totals,
        "response_models": sorted(response_models),
        "annotations_sha256": _sha256_file(final_path),
    }
    _atomic_json(manifest_path, manifest)
    return {
        "ok": True,
        "mode": "run",
        "status": "complete",
        "run_id": run_id,
        "item_count": len(rows),
        "usage": usage_totals,
        "output_dir": str(output_dir),
        "content_persisted": False,
        "human_annotations_loaded": False,
        "model_labels_are_gold_standard": False,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("check", "probe", "run"):
        sub = subparsers.add_parser(command)
        sub.add_argument("--base-url", required=True)
        sub.add_argument("--expected-host", required=True)
        sub.add_argument("--model", required=True)
        sub.add_argument("--protocol", choices=PROTOCOLS, default=ANTHROPIC_PROTOCOL)
        if command in {"check", "run"}:
            sub.add_argument("--batch-dir", required=True)
            sub.add_argument("--research-database", required=True)
            sub.add_argument("--input-root", required=True)
            sub.add_argument("--selection-file")
        if command == "run":
            sub.add_argument("--output-dir", required=True)
            sub.add_argument("--consent-phrase", required=True)
            sub.add_argument("--resume", action="store_true")
            sub.add_argument("--timeout-seconds", type=float, default=120.0)
            sub.add_argument("--max-tokens", type=int, default=1024)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    api_key = os.environ.get(API_KEY_ENV, "")
    os.environ.pop(API_KEY_ENV, None)
    try:
        base_url = validate_online_base_url(args.base_url, expected_host=args.expected_host)
        model = _validate_model(args.model)
        if len(api_key) < 8:
            raise OnlineAnnotationError("ONLINE_API_KEY_INVALID")
        caller: OnlineCaller = (
            DashScopeEncryptedCaller()
            if args.protocol == DASHSCOPE_ENCRYPTED_PROTOCOL
            else call_anthropic_messages
        )
        if args.command == "probe":
            response = caller(
                SYSTEM_PROMPT,
                "Title:\nSynthetic probe\n\nBody:\nA participant shares a relevant open resource for others to continue learning.\n\nClassify this synthetic content.",
                OnlineModelConfig(base_url=base_url, model=model, api_key=api_key),
            )
            result = {
                "ok": True,
                "mode": "probe",
                "model": model,
                "provider_host": args.expected_host.lower(),
                "protocol": args.protocol,
                "application_layer_input_encryption": args.protocol
                == DASHSCOPE_ENCRYPTED_PROTOCOL,
                "structured_result_valid": bool(validate_model_result(response.result)),
                "usage": {
                    "input_tokens": response.input_tokens,
                    "output_tokens": response.output_tokens,
                },
                "content_persisted": False,
                "real_research_content_sent": False,
            }
        else:
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
                    "provider_host": args.expected_host.lower(),
                    "model": model,
                    "protocol": args.protocol,
                    "application_layer_input_encryption": args.protocol
                    == DASHSCOPE_ENCRYPTED_PROTOCOL,
                    "api_key_configured": True,
                    "remote_data_transfer_requires_run_consent": True,
                    "human_annotations_loaded": False,
                    "content_persisted": False,
                    "identity_blind": True,
                }
            else:
                result = execute_online_annotation_run(
                    public_batch=public_batch,
                    contents=contents,
                    output_dir_value=args.output_dir,
                    base_url=base_url,
                    expected_host=args.expected_host,
                    model=model,
                    api_key=api_key,
                    consent_phrase=args.consent_phrase,
                    selection_id=selection_id,
                    protocol=args.protocol,
                    caller=caller,
                    resume=args.resume,
                    timeout_seconds=args.timeout_seconds,
                    max_tokens=args.max_tokens,
                )
    except (OnlineAnnotationError, ModelAnnotationError, ReviewContentError) as exc:
        code = exc.code if hasattr(exc, "code") else "ONLINE_ANNOTATION_FAILED"
        print(json.dumps({"ok": False, "error": code}, ensure_ascii=False))
        return 2
    finally:
        os.environ.pop(API_KEY_ENV, None)
        os.environ.pop(HMAC_ENV, None)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
