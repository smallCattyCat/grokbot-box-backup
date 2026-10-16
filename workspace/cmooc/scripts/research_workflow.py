#!/usr/bin/env python3
"""One safe entry point for the fixed-reference cMOOC research workflow."""

from __future__ import annotations

import argparse
import base64
import csv
import ctypes
import hashlib
import json
import os
import re
from ctypes import wintypes
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Mapping


WORKFLOW_COMMANDS = ("status", "doctor", "pack", "annotate", "evaluate", "continue")
PACK_SCHEMA_VERSION = "cmooc-research-pack-v1"
PACK_WRAPPER_SCHEMA_VERSION = "cmooc-research-pack-wrapper-v1"
DEFAULT_PROVIDER = "DashScope"
DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/api/v1"
DEFAULT_PROVIDER_HOST = "dashscope.aliyuncs.com"
DEFAULT_MODEL = "qwen3.7-max"
CONSENT_PHRASE = "I_AUTHORIZE_REDACTED_RESEARCH_DATA_TRANSFER"
MAX_PACK_BYTES = 32 * 1024 * 1024
REMOTE_DATA_CONSENT_ERROR = "REMOTE_DATA_CONSENT_REQUIRED"


class ResearchWorkflowError(RuntimeError):
    def __init__(
        self,
        code: str,
        *,
        detail: str | None = None,
        network_used: bool = False,
        next_command: str | None = None,
    ):
        super().__init__(code)
        self.code = code
        self.detail = detail
        self.network_used = network_used
        self.next_command = next_command


@dataclass(frozen=True)
class WorkflowPaths:
    home: Path
    input_root: Path
    batch_dir: Path
    research_database: Path
    protected_key: Path
    selection_file: Path
    reference_dir: Path
    exclusion_dir: Path
    pack_file: Path
    model_run_dir: Path
    evaluation_dir: Path


class _DataBlob(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
    ]


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _contains(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _safe_output_path(paths: WorkflowPaths, value: Path) -> Path:
    output = value.expanduser().resolve(strict=False)
    if (
        str(output).startswith("\\\\")
        or output == paths.home
        or not _contains(paths.home, output)
        or _contains(_repo_root(), output)
    ):
        raise ResearchWorkflowError("OUTPUT_OUTSIDE_LOCAL_RESEARCH_HOME")
    return output


def _online_api_key() -> str:
    value = os.environ.get("DASHSCOPE_API_KEY", "")
    if value:
        return value
    if os.name != "nt":
        return ""
    try:
        import winreg

        locations = (
            (winreg.HKEY_CURRENT_USER, r"Environment"),
            (
                winreg.HKEY_LOCAL_MACHINE,
                r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
            ),
        )
        for hive, subkey in locations:
            try:
                with winreg.OpenKey(hive, subkey) as key:
                    candidate, _ = winreg.QueryValueEx(key, "DASHSCOPE_API_KEY")
            except OSError:
                continue
            if isinstance(candidate, str) and candidate:
                return candidate
    except (ImportError, OSError):
        return ""
    return ""


def _default_home() -> Path:
    configured = os.environ.get("CMOOC_RESEARCH_HOME")
    if configured:
        return Path(configured).expanduser().resolve()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise ResearchWorkflowError("LOCAL_RESEARCH_HOME_REQUIRED")
    return Path(local_app_data).resolve() / "cmooc-research"


def _default_input_root() -> Path:
    configured = os.environ.get("CMOOC_RESEARCH_INPUT_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    return _repo_root().parent.parent / "cmooc研究数据24-25"


def _paths(home_value: str | None = None, input_root_value: str | None = None) -> WorkflowPaths:
    home = Path(home_value).expanduser().resolve() if home_value else _default_home()
    input_root = (
        Path(input_root_value).expanduser().resolve()
        if input_root_value
        else _default_input_root()
    )
    p1h = home / "p1h"
    return WorkflowPaths(
        home=home,
        input_root=input_root,
        batch_dir=home / "p1d" / "facilitation-review-300-v1",
        research_database=home / "p1c" / "research-cmooc-2024-2025-p1c.db",
        protected_key=home / "secrets" / "research-hmac-p1c.dpapi",
        selection_file=home / "p1g" / "human-reference-50-v1" / "validation-selection.csv",
        reference_dir=home / "p1g" / "human-primary-reference-v1-1",
        exclusion_dir=p1h / "human-primary-reference-v1-1-exclusions",
        pack_file=home / "workflow" / "reference-50.pack.dpapi.json",
        model_run_dir=p1h / "online-reference-50-qwen3-7-max-v1",
        evaluation_dir=p1h / "model-human-evaluation-qwen3-7-max-v1",
    )


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _canonical_json_bytes(value: Mapping[str, Any]) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    temporary.replace(path)


def _blob(value: bytes) -> tuple[_DataBlob, Any]:
    buffer = ctypes.create_string_buffer(value)
    return (
        _DataBlob(
            len(value),
            ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)),
        ),
        buffer,
    )


def _dpapi_transform(value: bytes, *, protect: bool) -> bytes:
    if os.name != "nt" or not value:
        raise ResearchWorkflowError("DPAPI_UNAVAILABLE")
    input_blob, input_buffer = _blob(value)
    output_blob = _DataBlob()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    blob_pointer = ctypes.POINTER(_DataBlob)
    crypt32.CryptProtectData.argtypes = [
        blob_pointer,
        wintypes.LPCWSTR,
        blob_pointer,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        blob_pointer,
    ]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    crypt32.CryptUnprotectData.argtypes = [
        blob_pointer,
        ctypes.POINTER(wintypes.LPWSTR),
        blob_pointer,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        blob_pointer,
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    flags = 0x1  # CRYPTPROTECT_UI_FORBIDDEN
    if protect:
        success = crypt32.CryptProtectData(
            ctypes.byref(input_blob),
            "cMOOC redacted research pack",
            None,
            None,
            None,
            flags,
            ctypes.byref(output_blob),
        )
    else:
        success = crypt32.CryptUnprotectData(
            ctypes.byref(input_blob),
            None,
            None,
            None,
            None,
            flags,
            ctypes.byref(output_blob),
        )
    if not success:
        raise ResearchWorkflowError("DPAPI_OPERATION_FAILED")
    try:
        # Keep input_buffer alive until CryptProtectData/CryptUnprotectData returns.
        _ = input_buffer
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(output_blob.pbData, ctypes.c_void_p))


def _dpapi_protect(value: bytes) -> bytes:
    return _dpapi_transform(value, protect=True)


def _dpapi_unprotect(value: bytes) -> bytes:
    return _dpapi_transform(value, protect=False)


def _pack_wrapper_valid(value: Mapping[str, Any] | None) -> bool:
    if not value:
        return False
    return (
        value.get("schema_version") == PACK_WRAPPER_SCHEMA_VERSION
        and isinstance(value.get("batch_id"), str)
        and isinstance(value.get("selection_id"), str)
        and value.get("item_count") == 50
        and isinstance(value.get("payload_sha256"), str)
        and bool(re.fullmatch(r"[0-9a-f]{64}", str(value.get("payload_sha256"))))
        and isinstance(value.get("protected_payload_b64"), str)
        and value.get("plaintext_persisted") is False
        and value.get("identity_blind") is True
    )


def _read_identity_csv(
    path: Path, *, expected_header_prefix: tuple[str, ...]
) -> list[tuple[int, str]] | None:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            header = tuple(reader.fieldnames or ())
            if header[: len(expected_header_prefix)] != expected_header_prefix:
                return None
            rows = list(reader)
        parsed = [
            (int(str(row["display_order"])), str(row["review_item_id"]))
            for row in rows
        ]
    except (OSError, KeyError, TypeError, ValueError):
        return None
    if (
        any(
            order <= 0
            or not re.fullmatch(r"review_[A-Za-z0-9_-]{1,64}", review_id)
            for order, review_id in parsed
        )
        or len({order for order, _ in parsed}) != len(parsed)
        or len({review_id for _, review_id in parsed}) != len(parsed)
    ):
        return None
    return parsed


def _fixed_artifacts(
    paths: WorkflowPaths,
) -> tuple[dict[str, bool], str | None, str | None]:
    batch_manifest = _read_json(paths.batch_dir / "private-manifest.json")
    batch_id = (
        str(batch_manifest.get("batch_id"))
        if batch_manifest
        and batch_manifest.get("schema_version") == "p1d-facilitation-review-v1"
        and isinstance(batch_manifest.get("items"), list)
        and len(batch_manifest["items"]) == 300
        and re.fullmatch(
            r"batch_[A-Za-z0-9_-]{1,96}", str(batch_manifest.get("batch_id", ""))
        )
        else None
    )
    selection_rows = _read_identity_csv(
        paths.selection_file,
        expected_header_prefix=("display_order", "review_item_id"),
    )
    selection_id = None
    if selection_rows and len(selection_rows) == 50:
        canonical = "\n".join(
            f"{order}\t{review_id}"
            for order, review_id in sorted(selection_rows)
        )
        selection_id = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
    reference_manifest = _read_json(paths.reference_dir / "reference-manifest.json")
    reference_rows = _read_identity_csv(
        paths.reference_dir / "human-primary-reference.csv",
        expected_header_prefix=("display_order", "review_item_id"),
    )
    reference_ready = bool(
        reference_manifest
        and reference_manifest.get("schema_version")
        == "p1g-human-primary-reference-candidate-v1"
        and reference_manifest.get("batch_id") == batch_id
        and reference_rows
        and len(reference_rows) == 50
        and selection_rows
        and set(reference_rows) == set(selection_rows)
    )
    exclusion_manifest = _read_json(paths.exclusion_dir / "exclusion-manifest.json")
    exclusion_rows = _read_identity_csv(
        paths.exclusion_dir / "exclusions.csv",
        expected_header_prefix=("display_order", "review_item_id", "reason_code"),
    )
    exclusions_ready = bool(
        exclusion_manifest
        and exclusion_manifest.get("schema_version")
        == "p1h-hard-evaluation-exclusions-v1"
        and exclusion_manifest.get("batch_id") == batch_id
        and exclusion_rows is not None
        and exclusion_manifest.get("excluded_item_count") == len(exclusion_rows)
    )
    try:
        with paths.research_database.open("rb") as handle:
            database_ready = handle.read(16) == b"SQLite format 3\x00"
    except OSError:
        database_ready = False
    return (
        {
            "research_database": database_ready,
            "blind_batch": batch_id is not None,
            "reference_selection_50": selection_id is not None,
            "human_reference_50": reference_ready,
            "predeclared_exclusions": exclusions_ready,
        },
        batch_id,
        selection_id,
    )


def collect_status(paths: WorkflowPaths) -> dict[str, Any]:
    model_manifest_path = paths.model_run_dir / "run-manifest.json"
    model_manifest = _read_json(model_manifest_path)
    evaluation_manifest = paths.evaluation_dir / "comparison-manifest.json"
    evaluation_report = paths.evaluation_dir / "model-human-evaluation.json"
    pack_wrapper = _read_json(paths.pack_file)

    fixed, batch_id, selection_id = _fixed_artifacts(paths)
    pack_ready = bool(
        paths.pack_file.is_file()
        and _pack_wrapper_valid(pack_wrapper)
        and pack_wrapper
        and pack_wrapper.get("batch_id") == batch_id
        and pack_wrapper.get("selection_id") == selection_id
    )
    model_status = (
        str(model_manifest.get("status", "invalid"))
        if model_manifest
        else "not_started"
    )
    model_complete = (
        model_status == "complete"
        and (paths.model_run_dir / "model-annotations.csv").is_file()
    )
    evaluation_complete = evaluation_manifest.is_file() and evaluation_report.is_file()
    if not all(fixed.values()):
        next_action = "restore_fixed_artifacts"
    elif not pack_ready:
        next_action = "pack"
    elif not model_complete:
        next_action = "annotate"
    elif not evaluation_complete:
        next_action = "evaluate"
    else:
        next_action = "complete"
    return {
        "ok": True,
        "command": "status",
        "network_used": False,
        "fixed_artifacts": fixed,
        "pack": {
            "ready": pack_ready,
            "path": str(paths.pack_file),
            "item_count": pack_wrapper.get("item_count") if pack_ready else None,
            "selection_id": pack_wrapper.get("selection_id") if pack_ready else None,
        },
        "online_annotation": {
            "status": model_status,
            "complete": model_complete,
            "completed_item_count": (
                model_manifest.get("completed_item_count") if model_manifest else 0
            ),
            "path": str(paths.model_run_dir),
        },
        "evaluation": {
            "complete": evaluation_complete,
            "path": str(paths.evaluation_dir),
        },
        "next_action": next_action,
    }


def doctor(paths: WorkflowPaths) -> dict[str, Any]:
    status = collect_status(paths)
    checks: dict[str, bool] = {
        "windows_dpapi": os.name == "nt",
        "fixed_artifacts": all(status["fixed_artifacts"].values()),
        "pack_or_raw_input": status["pack"]["ready"]
        or (
            paths.input_root.is_dir()
            and paths.protected_key.is_file()
            and paths.batch_dir.is_dir()
            and paths.research_database.is_file()
            and paths.selection_file.is_file()
        ),
        "dashscope_token": len(_online_api_key()) >= 8,
    }
    try:
        from research_online_model_annotation import (
            DASHSCOPE_ENCRYPTED_PROTOCOL,
            validate_online_base_url,
        )

        checks["online_runtime"] = bool(DASHSCOPE_ENCRYPTED_PROTOCOL)
        checks["provider_endpoint"] = (
            validate_online_base_url(
                os.environ.get("CMOOC_RESEARCH_BASE_URL", DEFAULT_BASE_URL),
                expected_host=DEFAULT_PROVIDER_HOST,
            )
            == os.environ.get("CMOOC_RESEARCH_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
        )
    except Exception:
        checks["online_runtime"] = False
        checks["provider_endpoint"] = False
    ok = all(checks.values())
    return {
        "ok": ok,
        "command": "doctor",
        "network_used": False,
        "provider": DEFAULT_PROVIDER,
        "model": os.environ.get("CMOOC_RESEARCH_MODEL", DEFAULT_MODEL),
        "checks": checks,
        "next_action": status["next_action"] if ok else "fix_doctor_checks",
    }


def _create_pack(paths: WorkflowPaths, output: Path) -> dict[str, Any]:
    if output.exists():
        existing = _read_json(output)
        fixed, batch_id, selection_id = _fixed_artifacts(paths)
        if (
            _pack_wrapper_valid(existing)
            and all(fixed.values())
            and existing
            and existing.get("batch_id") == batch_id
            and existing.get("selection_id") == selection_id
        ):
            return {
                "ok": True,
                "command": "pack",
                "status": "already_ready",
                "network_used": False,
                "pack": str(output),
                "item_count": existing["item_count"],
                "selection_id": existing["selection_id"],
                "plaintext_persisted": False,
                "next_action": "annotate",
            }
        raise ResearchWorkflowError("PACK_OUTPUT_ALREADY_EXISTS")
    required = (
        paths.input_root,
        paths.batch_dir,
        paths.research_database,
        paths.protected_key,
        paths.selection_file,
    )
    if any(not path.exists() for path in required):
        raise ResearchWorkflowError("PACK_INPUT_UNAVAILABLE")
    try:
        from research_review_content import load_review_contents
        from research_review_server import _load_selection_file

        selected_ids, selection_id = _load_selection_file(str(paths.selection_file))
        protected_key = paths.protected_key.read_bytes()
        key_buffer = bytearray(_dpapi_unprotect(protected_key))
        try:
            public_batch, contents = load_review_contents(
                batch_dir_value=str(paths.batch_dir),
                research_database_value=str(paths.research_database),
                input_root_value=str(paths.input_root),
                key=bytes(key_buffer),
                selected_review_ids=selected_ids,
            )
        finally:
            for index in range(len(key_buffer)):
                key_buffer[index] = 0
    except ResearchWorkflowError:
        raise
    except Exception as exc:
        code = getattr(exc, "code", "PACK_BUILD_FAILED")
        raise ResearchWorkflowError(str(code)) from exc
    if selection_id is None or len(contents) != 50:
        raise ResearchWorkflowError("PACK_REQUIRES_FIXED_REFERENCE_50")
    items = [
        asdict(item)
        for item in sorted(contents.values(), key=lambda item: item.display_order)
    ]
    payload = {
        "schema_version": PACK_SCHEMA_VERSION,
        "public_batch": public_batch,
        "selection_id": selection_id,
        "item_count": len(items),
        "items": items,
        "identity_blind": True,
        "plaintext_persisted": False,
        "human_annotations_included": False,
    }
    payload_bytes = _canonical_json_bytes(payload)
    protected_payload = _dpapi_protect(payload_bytes)
    wrapper = {
        "schema_version": PACK_WRAPPER_SCHEMA_VERSION,
        "batch_id": public_batch["batch_id"],
        "selection_id": selection_id,
        "item_count": len(items),
        "payload_sha256": _sha256_bytes(payload_bytes),
        "protection": "windows-dpapi-current-user",
        "protected_payload_b64": base64.b64encode(protected_payload).decode("ascii"),
        "identity_blind": True,
        "plaintext_persisted": False,
        "human_annotations_included": False,
    }
    _atomic_json(output, wrapper)
    return {
        "ok": True,
        "command": "pack",
        "status": "created",
        "network_used": False,
        "pack": str(output),
        "item_count": len(items),
        "selection_id": selection_id,
        "plaintext_persisted": False,
        "next_action": "annotate",
    }


def _pack_contents(path: Path) -> tuple[dict[str, Any], dict[str, Any], str]:
    wrapper = _read_json(path)
    if not _pack_wrapper_valid(wrapper):
        raise ResearchWorkflowError("PACK_INVALID")
    assert wrapper is not None
    try:
        protected = base64.b64decode(
            wrapper["protected_payload_b64"], validate=True
        )
        if not protected or len(protected) > MAX_PACK_BYTES:
            raise ResearchWorkflowError("PACK_INVALID")
        payload_bytes = _dpapi_unprotect(protected)
        payload = json.loads(payload_bytes.decode("utf-8"))
    except ResearchWorkflowError:
        raise
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ResearchWorkflowError("PACK_INVALID") from exc
    if (
        _sha256_bytes(payload_bytes) != wrapper["payload_sha256"]
        or not isinstance(payload, dict)
        or payload.get("schema_version") != PACK_SCHEMA_VERSION
        or payload.get("selection_id") != wrapper["selection_id"]
        or payload.get("item_count") != 50
        or payload.get("identity_blind") is not True
        or payload.get("human_annotations_included") is not False
        or not isinstance(payload.get("public_batch"), dict)
        or payload["public_batch"].get("batch_id") != wrapper["batch_id"]
        or not isinstance(payload.get("items"), list)
        or len(payload["items"]) != 50
    ):
        raise ResearchWorkflowError("PACK_INVALID")
    try:
        from research_review_content import ReviewContent

        contents: dict[str, Any] = {}
        orders: set[int] = set()
        for raw in payload["items"]:
            if not isinstance(raw, dict) or set(raw) != {
                "review_item_id",
                "display_order",
                "title",
                "body",
                "suspected_truncation",
                "redaction_count",
            }:
                raise ResearchWorkflowError("PACK_INVALID")
            item = ReviewContent(**raw)
            if (
                not re.fullmatch(r"review_[A-Za-z0-9_-]{1,64}", item.review_item_id)
                or item.review_item_id in contents
                or not isinstance(item.display_order, int)
                or item.display_order <= 0
                or item.display_order in orders
                or not isinstance(item.title, str)
                or not isinstance(item.body, str)
                or not isinstance(item.suspected_truncation, bool)
                or not isinstance(item.redaction_count, int)
                or item.redaction_count < 0
            ):
                raise ResearchWorkflowError("PACK_INVALID")
            contents[item.review_item_id] = item
            orders.add(item.display_order)
    except (TypeError, ResearchWorkflowError):
        raise
    return payload["public_batch"], contents, payload["selection_id"]


def _model_is_complete(output_dir: Path) -> bool:
    manifest = _read_json(output_dir / "run-manifest.json")
    return bool(
        manifest
        and manifest.get("status") == "complete"
        and (output_dir / "model-annotations.csv").is_file()
    )


def _annotate(paths: WorkflowPaths, pack: Path, output_dir: Path, authorized: bool) -> dict[str, Any]:
    if _model_is_complete(output_dir):
        manifest = _read_json(output_dir / "run-manifest.json") or {}
        return {
            "ok": True,
            "command": "annotate",
            "status": "already_complete",
            "network_used": False,
            "item_count": manifest.get("completed_item_count", 50),
            "output_dir": str(output_dir),
            "next_action": "evaluate",
        }
    if not authorized:
        raise ResearchWorkflowError(
            REMOTE_DATA_CONSENT_ERROR,
            next_command="npm run research -- annotate --authorize",
        )
    api_key = _online_api_key()
    if len(api_key) < 8:
        raise ResearchWorkflowError("DASHSCOPE_API_KEY_REQUIRED")
    public_batch, contents, selection_id = _pack_contents(pack)
    try:
        from research_online_model_annotation import (
            DASHSCOPE_ENCRYPTED_PROTOCOL,
            execute_online_annotation_run,
        )

        previous_root = os.environ.get("CMOOC_MODEL_OUTPUT_ROOT")
        os.environ["CMOOC_MODEL_OUTPUT_ROOT"] = str(paths.home / "p1h")
        try:
            result = execute_online_annotation_run(
                public_batch=public_batch,
                contents=contents,
                output_dir_value=str(output_dir),
                base_url=os.environ.get("CMOOC_RESEARCH_BASE_URL", DEFAULT_BASE_URL),
                expected_host=DEFAULT_PROVIDER_HOST,
                model=os.environ.get("CMOOC_RESEARCH_MODEL", DEFAULT_MODEL),
                api_key=api_key,
                consent_phrase=CONSENT_PHRASE,
                selection_id=selection_id,
                protocol=DASHSCOPE_ENCRYPTED_PROTOCOL,
                resume=output_dir.exists(),
            )
        finally:
            if previous_root is None:
                os.environ.pop("CMOOC_MODEL_OUTPUT_ROOT", None)
            else:
                os.environ["CMOOC_MODEL_OUTPUT_ROOT"] = previous_root
    except ResearchWorkflowError:
        raise
    except Exception as exc:
        code = getattr(exc, "code", "ONLINE_ANNOTATION_FAILED")
        raise ResearchWorkflowError(str(code), network_used=True) from exc
    return {
        **result,
        "command": "annotate",
        "network_used": True,
        "next_action": "evaluate",
    }


def _evaluate(paths: WorkflowPaths, model_run_dir: Path, output_dir: Path) -> dict[str, Any]:
    if (
        (output_dir / "comparison-manifest.json").is_file()
        and (output_dir / "model-human-evaluation.json").is_file()
    ):
        return {
            "ok": True,
            "command": "evaluate",
            "status": "already_complete",
            "network_used": False,
            "output_dir": str(output_dir),
            "next_action": "complete",
        }
    if not _model_is_complete(model_run_dir):
        raise ResearchWorkflowError("ONLINE_ANNOTATION_INCOMPLETE")
    try:
        from research_model_evaluation import compare_model_to_reference

        previous_root = os.environ.get("CMOOC_MODEL_OUTPUT_ROOT")
        os.environ["CMOOC_MODEL_OUTPUT_ROOT"] = str(paths.home / "p1h")
        try:
            result = compare_model_to_reference(
                reference_dir_value=str(paths.reference_dir),
                model_run_dir_value=str(model_run_dir),
                exclusion_dir_value=str(paths.exclusion_dir),
                output_dir_value=str(output_dir),
            )
        finally:
            if previous_root is None:
                os.environ.pop("CMOOC_MODEL_OUTPUT_ROOT", None)
            else:
                os.environ["CMOOC_MODEL_OUTPUT_ROOT"] = previous_root
    except Exception as exc:
        code = getattr(exc, "code", "MODEL_EVALUATION_FAILED")
        raise ResearchWorkflowError(str(code)) from exc
    return {
        **result,
        "command": "evaluate",
        "network_used": False,
        "next_action": "complete",
    }


def _continue(paths: WorkflowPaths, authorized: bool) -> dict[str, Any]:
    status = collect_status(paths)
    next_action = status["next_action"]
    if next_action == "restore_fixed_artifacts":
        raise ResearchWorkflowError("FIXED_RESEARCH_ARTIFACTS_UNAVAILABLE")
    if next_action == "pack":
        return _create_pack(paths, paths.pack_file)
    if next_action == "annotate":
        return _annotate(
            paths,
            paths.pack_file,
            paths.model_run_dir,
            authorized,
        )
    if next_action == "evaluate":
        return _evaluate(paths, paths.model_run_dir, paths.evaluation_dir)
    return {
        "ok": True,
        "command": "continue",
        "status": "complete",
        "network_used": False,
        "next_action": "complete",
    }


def _add_common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--home", help="override the local research artifact root")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Simplified online-only research path: "
            "status → pack → authorize/annotate → evaluate"
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    status = subparsers.add_parser("status", help="show fixed evidence and the next action")
    _add_common_arguments(status)
    doctor_parser = subparsers.add_parser(
        "doctor", help="check local artifacts, DPAPI, and the configured online provider"
    )
    _add_common_arguments(doctor_parser)
    pack = subparsers.add_parser(
        "pack", help="create a DPAPI-protected, identity-blind 50-item pack"
    )
    _add_common_arguments(pack)
    pack.add_argument("--input-root")
    pack.add_argument("--output")
    annotate = subparsers.add_parser(
        "annotate", help="send the protected 50-item pack to the configured online model"
    )
    _add_common_arguments(annotate)
    annotate.add_argument("--pack")
    annotate.add_argument("--output-dir")
    annotate.add_argument(
        "--authorize",
        action="store_true",
        help="authorize this run's redacted research data transfer",
    )
    evaluate = subparsers.add_parser(
        "evaluate", help="compare completed model labels with the frozen human reference"
    )
    _add_common_arguments(evaluate)
    evaluate.add_argument("--model-run-dir")
    evaluate.add_argument("--output-dir")
    continue_parser = subparsers.add_parser(
        "continue", help="perform the next safe local step, or resume an authorized online run"
    )
    _add_common_arguments(continue_parser)
    continue_parser.add_argument(
        "--authorize",
        action="store_true",
        help="authorize this run's redacted research data transfer when annotation is next",
    )
    return parser


def _emit(value: Mapping[str, Any], *, json_mode: bool) -> None:
    if json_mode:
        print(json.dumps(value, ensure_ascii=False, sort_keys=True))
        return
    if value.get("ok") is False:
        print(f"研究流程未继续：{value.get('error')}")
        if value.get("next_command"):
            print(f"下一步：{value['next_command']}")
        return
    command = value.get("command", "research")
    next_action = value.get("next_action", "")
    print(f"研究流程：{command} 已完成")
    if next_action:
        print(f"下一步：{next_action}")
    if command == "status":
        print(
            "固定证据："
            + ("完整" if all(value["fixed_artifacts"].values()) else "不完整")
        )
        print(f"匿名内容包：{'就绪' if value['pack']['ready'] else '未生成'}")
        print(f"在线标注：{value['online_annotation']['status']}")
        print(f"评估：{'完成' if value['evaluation']['complete'] else '未完成'}")


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    json_mode = bool(getattr(args, "json", False))
    try:
        paths = _paths(
            getattr(args, "home", None),
            getattr(args, "input_root", None),
        )
        if args.command == "status":
            result = collect_status(paths)
        elif args.command == "doctor":
            result = doctor(paths)
        elif args.command == "pack":
            output = (
                Path(args.output).expanduser().resolve()
                if args.output
                else paths.pack_file
            )
            output = _safe_output_path(paths, output)
            result = _create_pack(paths, output)
        elif args.command == "annotate":
            pack = (
                Path(args.pack).expanduser().resolve()
                if args.pack
                else paths.pack_file
            )
            output_dir = (
                Path(args.output_dir).expanduser().resolve()
                if args.output_dir
                else paths.model_run_dir
            )
            pack = _safe_output_path(paths, pack)
            output_dir = _safe_output_path(paths, output_dir)
            result = _annotate(paths, pack, output_dir, args.authorize)
        elif args.command == "evaluate":
            model_run_dir = (
                Path(args.model_run_dir).expanduser().resolve()
                if args.model_run_dir
                else paths.model_run_dir
            )
            output_dir = (
                Path(args.output_dir).expanduser().resolve()
                if args.output_dir
                else paths.evaluation_dir
            )
            model_run_dir = _safe_output_path(paths, model_run_dir)
            output_dir = _safe_output_path(paths, output_dir)
            result = _evaluate(paths, model_run_dir, output_dir)
        else:
            result = _continue(paths, args.authorize)
        _emit(result, json_mode=json_mode)
        return 0 if result.get("ok", False) else 2
    except ResearchWorkflowError as exc:
        result = {
            "ok": False,
            "command": getattr(args, "command", "research"),
            "error": exc.code,
            "network_used": exc.network_used,
        }
        if exc.detail:
            result["detail"] = exc.detail
        if exc.next_command:
            result["next_command"] = exc.next_command
        _emit(result, json_mode=json_mode)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
