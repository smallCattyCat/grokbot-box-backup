#!/usr/bin/env python3
"""Serve a local-only P3B decision-reference coding workbench."""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import secrets
import sys
import tempfile
import threading
import webbrowser
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import unquote, urlsplit


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from decision_review_content import (  # noqa: E402
    CONTENT_REVISION_STATUS,
    MAX_REFERENCE_ITEMS,
    DecisionReviewContent,
    DecisionReviewContentError,
    DecisionReviewEvent,
    SelectionContract,
    SelectionItem,
    default_input_root,
    default_key_path,
    default_output_root,
    default_selection_file,
    ensure_selection_lock,
    load_decision_review_contents,
    public_item_payload,
    research_home,
)


UI_ROOT = Path(__file__).resolve().parents[1] / "research" / "decision_review_ui"
SESSION_TOKEN_ENV = "CMOOC_DECISION_REVIEW_SESSION_TOKEN"
MAX_REQUEST_BODY = 4 * 1024
CODER_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,64}")
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{32,128}")
FUNCTION_LABELS = {
    "resource_connection",
    "cognitive_conflict",
    "emotional_support",
}
TARGET_LABELS = {
    "thread_author",
    "specific_participant",
    "thread_participants",
}
EXPORT_FIELDS = (
    "reference_id",
    "snapshot_key",
    "thread_key",
    "intervene",
    "main_function",
    "target_object",
    "coder_id",
    "saved_at_utc",
    "exported_at_utc",
    "selection_fingerprint",
    "content_revision_status",
)
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}


class DecisionReviewServerError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _contains(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _validate_output_root(value: str | None) -> Path:
    allowed_root = research_home().resolve()
    output_root = (
        Path(value).expanduser().resolve()
        if value
        else default_output_root().resolve()
    )
    repo_root = Path(__file__).resolve().parents[1]
    if (
        output_root == allowed_root
        or not _contains(allowed_root, output_root)
        or _contains(repo_root, output_root)
        or str(output_root).startswith("\\\\")
    ):
        raise DecisionReviewServerError("OUTPUT_ROOT_FORBIDDEN")
    output_root.mkdir(parents=True, exist_ok=True)
    return output_root


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(
        timespec="seconds"
    ).replace("+00:00", "Z")


def _validate_annotation(
    value: Any, *, saved_at_utc: str | None = None
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "intervene",
        "main_function",
        "target_object",
    }:
        raise DecisionReviewServerError("ANNOTATION_INVALID")
    intervene = value["intervene"]
    main_function = value["main_function"]
    target_object = value["target_object"]
    if intervene == "yes":
        if (
            main_function not in FUNCTION_LABELS
            or target_object not in TARGET_LABELS
        ):
            raise DecisionReviewServerError("ANNOTATION_INVALID")
    elif intervene == "no":
        if (
            main_function != "none"
            or target_object not in {None, "", "not_applicable"}
        ):
            raise DecisionReviewServerError("ANNOTATION_INVALID")
        target_object = None
    else:
        raise DecisionReviewServerError("ANNOTATION_INVALID")
    return {
        "intervene": intervene,
        "main_function": main_function,
        "target_object": target_object,
        "saved_at_utc": saved_at_utc or _utc_now(),
    }


def _validate_saved_annotation(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "intervene",
        "main_function",
        "target_object",
        "saved_at_utc",
    }:
        raise DecisionReviewServerError("DRAFT_INVALID")
    timestamp = value["saved_at_utc"]
    if not isinstance(timestamp, str):
        raise DecisionReviewServerError("DRAFT_INVALID")
    try:
        datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as exc:
        raise DecisionReviewServerError("DRAFT_INVALID") from exc
    labels = {
        key: value[key]
        for key in ("intervene", "main_function", "target_object")
    }
    return _validate_annotation(labels, saved_at_utc=timestamp)


def _atomic_write(path: Path, body: bytes, *, prefix: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=prefix, suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            Path(temp_name).unlink(missing_ok=True)
        except OSError:
            pass


class DecisionReviewState:
    """Keep forum text in memory and persist labels plus anonymous keys only."""

    def __init__(
        self,
        *,
        contract: SelectionContract,
        contents: Mapping[str, DecisionReviewContent],
        coder_id: str,
        output_root: Path,
    ) -> None:
        if not CODER_PATTERN.fullmatch(coder_id):
            raise DecisionReviewServerError("CODER_ID_INVALID")
        if (
            contract.item_count < 1
            or contract.item_count > MAX_REFERENCE_ITEMS
            or len(contents) != contract.item_count
        ):
            raise DecisionReviewServerError("REVIEW_CONTENT_INVALID")
        item_ids = {item.reference_id for item in contract.items}
        if set(contents) != item_ids:
            raise DecisionReviewServerError("REVIEW_CONTENT_INVALID")
        for item in contents.values():
            decision_at = datetime.fromisoformat(item.decision_at)
            if (
                item.content_revision_status != CONTENT_REVISION_STATUS
                or any(
                    datetime.fromisoformat(event.event_at) > decision_at
                    for event in item.events
                )
            ):
                raise DecisionReviewServerError("ASOF_CONTENT_INVALID")

        self.contract = contract
        self.contents = dict(contents)
        self.ordered_ids = [
            item.reference_id
            for item in sorted(
                contract.items, key=lambda value: value.display_order
            )
        ]
        self.coder_id = coder_id
        self.output_root = output_root.expanduser().resolve()
        ensure_selection_lock(self.output_root, contract)
        suffix = contract.selection_fingerprint[:16]
        self.draft_path = (
            self.output_root
            / "drafts"
            / f"decision-reference-{coder_id}-{suffix}.json"
        )
        self.export_path = (
            self.output_root
            / "exports"
            / f"decision-reference-{coder_id}-{suffix}.csv"
        )
        self.annotations: dict[str, dict[str, Any]] = {}
        self.lock = threading.RLock()
        self._load_draft()

    def _load_draft(self) -> None:
        if not self.draft_path.is_file():
            return
        try:
            payload = json.loads(
                self.draft_path.read_text(encoding="utf-8")
            )
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise DecisionReviewServerError("DRAFT_INVALID") from exc
        if (
            not isinstance(payload, dict)
            or set(payload)
            != {
                "schema_version",
                "selection_fingerprint",
                "coder_id",
                "content_revision_status",
                "annotations",
            }
            or payload["schema_version"]
            != "cmooc-decision-reference-draft-v1"
            or payload["selection_fingerprint"]
            != self.contract.selection_fingerprint
            or payload["coder_id"] != self.coder_id
            or payload["content_revision_status"]
            != CONTENT_REVISION_STATUS
            or not isinstance(payload["annotations"], dict)
            or not set(payload["annotations"]).issubset(self.contents)
        ):
            raise DecisionReviewServerError("DRAFT_INVALID")
        self.annotations = {
            reference_id: _validate_saved_annotation(annotation)
            for reference_id, annotation in payload["annotations"].items()
        }

    def _save_draft(self) -> None:
        payload = {
            "schema_version": "cmooc-decision-reference-draft-v1",
            "selection_fingerprint": self.contract.selection_fingerprint,
            "coder_id": self.coder_id,
            "content_revision_status": CONTENT_REVISION_STATUS,
            "annotations": self.annotations,
        }
        body = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        _atomic_write(
            self.draft_path, body, prefix=".decision-reference-draft-"
        )

    def session_payload(self) -> dict[str, Any]:
        with self.lock:
            return {
                "schema_version": "cmooc-decision-reference-session-v1",
                "selected_count": len(self.ordered_ids),
                "completed_count": len(self.annotations),
                "maximum_batch_size": MAX_REFERENCE_ITEMS,
                "auto_advance_batch": False,
                "content_persisted": False,
                "content_revision_status": CONTENT_REVISION_STATUS,
                "items": [
                    {
                        "reference_id": reference_id,
                        "display_order": self.contents[
                            reference_id
                        ].display_order,
                        "completed": reference_id in self.annotations,
                    }
                    for reference_id in self.ordered_ids
                ],
            }

    def item_payload(self, reference_id: str) -> dict[str, Any]:
        with self.lock:
            content = self.contents.get(reference_id)
            if content is None:
                raise DecisionReviewServerError(
                    "REFERENCE_ITEM_NOT_FOUND"
                )
            payload = public_item_payload(content)
            payload["annotation"] = self.annotations.get(reference_id)
            return payload

    def save_annotation(
        self, reference_id: str, value: Any
    ) -> dict[str, Any]:
        if reference_id not in self.contents:
            raise DecisionReviewServerError("REFERENCE_ITEM_NOT_FOUND")
        annotation = _validate_annotation(value)
        with self.lock:
            self.annotations[reference_id] = annotation
            self._save_draft()
        return annotation

    def export_csv(self) -> bytes:
        with self.lock:
            if set(self.annotations) != set(self.contents):
                raise DecisionReviewServerError("REVIEW_INCOMPLETE")
            exported_at = _utc_now()
            by_reference = {
                item.reference_id: item for item in self.contract.items
            }
            stream = io.StringIO(newline="")
            writer = csv.DictWriter(
                stream, fieldnames=EXPORT_FIELDS, lineterminator="\n"
            )
            writer.writeheader()
            for reference_id in self.ordered_ids:
                selection = by_reference[reference_id]
                annotation = self.annotations[reference_id]
                writer.writerow(
                    {
                        "reference_id": reference_id,
                        "snapshot_key": selection.snapshot_key,
                        "thread_key": selection.thread_key,
                        "intervene": annotation["intervene"],
                        "main_function": annotation["main_function"],
                        "target_object": annotation["target_object"] or "",
                        "coder_id": self.coder_id,
                        "saved_at_utc": annotation["saved_at_utc"],
                        "exported_at_utc": exported_at,
                        "selection_fingerprint": (
                            self.contract.selection_fingerprint
                        ),
                        "content_revision_status": CONTENT_REVISION_STATUS,
                    }
                )
            body = ("\ufeff" + stream.getvalue()).encode("utf-8")
            _atomic_write(
                self.export_path,
                body,
                prefix=".decision-reference-export-",
            )
            return body


class DecisionReviewHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(
        self,
        address: tuple[str, int],
        state: DecisionReviewState,
        token: str,
    ) -> None:
        if (
            address[0] != "127.0.0.1"
            or not TOKEN_PATTERN.fullmatch(token)
        ):
            raise DecisionReviewServerError(
                "SERVER_CONFIGURATION_INVALID"
            )
        self.review_state = state
        self.review_token = token
        super().__init__(address, DecisionReviewRequestHandler)


class DecisionReviewRequestHandler(BaseHTTPRequestHandler):
    server: DecisionReviewHTTPServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:
        return

    def _headers(
        self,
        status: int,
        content_type: str,
        length: int,
        extra: Mapping[str, str] | None = None,
    ) -> None:
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=()",
        )
        self.send_header("Connection", "close")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self'; connect-src 'self'; object-src 'none'; "
            "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        )
        if extra:
            for name, value in extra.items():
                self.send_header(name, value)
        self.end_headers()

    def _send(
        self,
        status: int,
        body: bytes,
        content_type: str,
        extra: Mapping[str, str] | None = None,
    ) -> None:
        self._headers(status, content_type, len(body), extra)
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: Mapping[str, Any]) -> None:
        body = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        self._send(
            status, body, "application/json; charset=utf-8"
        )

    def _origin(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    def _host_valid(self) -> bool:
        return (
            self.headers.get("Host", "")
            == f"127.0.0.1:{self.server.server_port}"
        )

    def _api_authorized(self, *, write: bool = False) -> bool:
        if (
            not self._host_valid()
            or self.headers.get(
                "X-Decision-Review-Token", ""
            )
            != self.server.review_token
        ):
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin != self._origin():
            return False
        return not write or origin == self._origin()

    def _error(self, status: int, code: str) -> None:
        self._json(status, {"error": code})

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/favicon.ico":
            if not self._host_valid():
                self._error(HTTPStatus.BAD_REQUEST, "HOST_INVALID")
                return
            self._send(HTTPStatus.NO_CONTENT, b"", "image/x-icon")
            return
        if path in STATIC_FILES:
            if not self._host_valid():
                self._error(HTTPStatus.BAD_REQUEST, "HOST_INVALID")
                return
            filename, content_type = STATIC_FILES[path]
            try:
                body = (UI_ROOT / filename).read_bytes()
            except OSError:
                self._error(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    "STATIC_ASSET_UNAVAILABLE",
                )
                return
            self._send(HTTPStatus.OK, body, content_type)
            return
        if not self._api_authorized():
            self._error(HTTPStatus.FORBIDDEN, "SESSION_FORBIDDEN")
            return
        try:
            if path == "/api/session":
                self._json(
                    HTTPStatus.OK,
                    self.server.review_state.session_payload(),
                )
                return
            if path == "/api/export":
                body = self.server.review_state.export_csv()
                filename = self.server.review_state.export_path.name
                self._send(
                    HTTPStatus.OK,
                    body,
                    "text/csv; charset=utf-8",
                    {
                        "Content-Disposition": (
                            f'attachment; filename="{filename}"'
                        ),
                        "X-Export-Filename": filename,
                        "X-Exported-Count": str(
                            len(
                                self.server.review_state.annotations
                            )
                        ),
                    },
                )
                return
            prefix = "/api/items/"
            if (
                path.startswith(prefix)
                and "/" not in path[len(prefix) :]
            ):
                reference_id = unquote(path[len(prefix) :])
                self._json(
                    HTTPStatus.OK,
                    self.server.review_state.item_payload(reference_id),
                )
                return
        except DecisionReviewServerError as exc:
            status = (
                HTTPStatus.NOT_FOUND
                if exc.code == "REFERENCE_ITEM_NOT_FOUND"
                else HTTPStatus.CONFLICT
            )
            self._error(status, exc.code)
            return
        self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND")

    def do_PUT(self) -> None:
        path = urlsplit(self.path).path
        prefix = "/api/items/"
        suffix = "/annotation"
        if not self._api_authorized(write=True):
            self._error(HTTPStatus.FORBIDDEN, "SESSION_FORBIDDEN")
            return
        if not path.startswith(prefix) or not path.endswith(suffix):
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND")
            return
        reference_id = unquote(path[len(prefix) : -len(suffix)])
        if not reference_id or "/" in reference_id:
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND")
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if (
            length < 0
            or length > MAX_REQUEST_BODY
            or self.headers.get_content_type() != "application/json"
        ):
            self._error(HTTPStatus.BAD_REQUEST, "REQUEST_INVALID")
            return
        try:
            value = json.loads(self.rfile.read(length))
            annotation = self.server.review_state.save_annotation(
                reference_id, value
            )
            self._json(
                HTTPStatus.OK,
                {"ok": True, "annotation": annotation},
            )
        except json.JSONDecodeError:
            self._error(HTTPStatus.BAD_REQUEST, "REQUEST_INVALID")
        except DecisionReviewServerError as exc:
            status = (
                HTTPStatus.NOT_FOUND
                if exc.code == "REFERENCE_ITEM_NOT_FOUND"
                else HTTPStatus.BAD_REQUEST
            )
            self._error(status, exc.code)

    def do_POST(self) -> None:
        self._error(
            HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED"
        )

    def do_DELETE(self) -> None:
        self._error(
            HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED"
        )


def create_server(
    *,
    state: DecisionReviewState,
    token: str,
    port: int = 0,
) -> DecisionReviewHTTPServer:
    if not 0 <= port <= 65535:
        raise DecisionReviewServerError("PORT_INVALID")
    return DecisionReviewHTTPServer(("127.0.0.1", port), state, token)


def _add_source_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--selection-file")
    parser.add_argument("--input-root")
    parser.add_argument("--key-path")
    parser.add_argument("--source-audit")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    check = subparsers.add_parser(
        "check", help="validate the frozen batch without persisting content"
    )
    _add_source_arguments(check)
    check.add_argument("--json", action="store_true")

    serve = subparsers.add_parser(
        "serve", help="start the localhost-only coding workbench"
    )
    _add_source_arguments(serve)
    serve.add_argument("--coder-id", required=True)
    serve.add_argument("--output-root")
    serve.add_argument("--port", type=int, default=0)
    serve.add_argument("--no-open-browser", action="store_true")
    return parser


def _load_from_args(
    args: argparse.Namespace,
) -> tuple[SelectionContract, dict[str, DecisionReviewContent]]:
    return load_decision_review_contents(
        selection_file_value=str(
            Path(args.selection_file).expanduser().resolve()
            if args.selection_file
            else default_selection_file()
        ),
        input_root_value=str(
            Path(args.input_root).expanduser().resolve()
            if args.input_root
            else default_input_root().resolve()
        ),
        key_path_value=str(
            Path(args.key_path).expanduser().resolve()
            if args.key_path
            else default_key_path()
        ),
        source_audit_value=args.source_audit,
    )


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        contract, contents = _load_from_args(args)
        if args.command == "check":
            payload = {
                "ok": True,
                "mode": "check",
                "selected_count": contract.item_count,
                "maximum_batch_size": MAX_REFERENCE_ITEMS,
                "asof_boundary_violation_count": 0,
                "content_revision_status": CONTENT_REVISION_STATUS,
                "content_persisted": False,
                "network_used": False,
                "auto_advance_batch": False,
                "redacted_item_count": sum(
                    item.redaction_count > 0
                    for item in contents.values()
                ),
                "suspected_truncation_count": sum(
                    item.suspected_truncation
                    for item in contents.values()
                ),
            }
            if args.json:
                print(
                    json.dumps(
                        payload, ensure_ascii=False, sort_keys=True
                    )
                )
            else:
                print(
                    "P3B decision-reference 检查通过："
                    f"{contract.item_count} 条；正文未落盘；未使用网络。"
                )
            return 0

        output_root = _validate_output_root(args.output_root)
        state = DecisionReviewState(
            contract=contract,
            contents=contents,
            coder_id=args.coder_id,
            output_root=output_root,
        )
        configured_token = os.environ.get(SESSION_TOKEN_ENV, "")
        token = configured_token or secrets.token_urlsafe(32)
        if not TOKEN_PATTERN.fullmatch(token):
            raise DecisionReviewServerError("SESSION_TOKEN_INVALID")
        if args.no_open_browser and not configured_token:
            raise DecisionReviewServerError(
                "NONINTERACTIVE_TOKEN_REQUIRED"
            )
        server = create_server(
            state=state, token=token, port=args.port
        )
    except (
        DecisionReviewContentError,
        DecisionReviewServerError,
        OSError,
    ) as exc:
        code = getattr(exc, "code", str(exc))
        print(
            json.dumps(
                {"ok": False, "error": code}, ensure_ascii=False
            ),
            file=sys.stderr,
        )
        return 2

    url = f"http://127.0.0.1:{server.server_port}/#token={token}"
    print(
        json.dumps(
            {
                "ok": True,
                "host": "127.0.0.1",
                "port": server.server_port,
                "selected_count": contract.item_count,
                "content_persisted": False,
                "network_used": False,
                "auto_advance_batch": False,
            },
            ensure_ascii=False,
        )
    )
    if not args.no_open_browser:
        webbrowser.open(url, new=2)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
