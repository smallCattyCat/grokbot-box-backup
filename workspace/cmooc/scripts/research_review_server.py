#!/usr/bin/env python3
"""Serve a token-protected, localhost-only P1e blind review interface."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import secrets
import sys
import tempfile
import threading
import webbrowser
from dataclasses import asdict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import parse_qs, unquote, urlsplit


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from research_review import BLIND_COLUMNS, FUNCTION_LABELS  # noqa: E402
from research_review_content import (  # noqa: E402
    HMAC_ENV,
    ReviewContent,
    ReviewContentError,
    load_hmac_key,
    load_review_contents,
)


UI_ROOT = Path(__file__).resolve().parents[1] / "research" / "review_ui"
DRAFT_ROOT_ENV = "CMOOC_REVIEW_DRAFT_ROOT"
SESSION_TOKEN_ENV = "CMOOC_REVIEW_SESSION_TOKEN"
MAX_REQUEST_BODY = 16 * 1024
CODER_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,64}")
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{32,128}")
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}


class ReviewServerError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _contains(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _default_draft_root() -> Path:
    configured = os.environ.get(DRAFT_ROOT_ENV)
    if configured:
        return Path(configured).expanduser().resolve()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise ReviewServerError("LOCAL_DRAFT_ROOT_REQUIRED")
    return Path(local_app_data).resolve() / "cmooc-research" / "p1e"


def _validate_draft_root(value: str | None) -> Path:
    root = Path(value).expanduser().resolve() if value else _default_draft_root()
    repo = Path(__file__).resolve().parents[1]
    if str(root).startswith("\\\\"):
        raise ReviewServerError("UNC_DRAFT_ROOT_FORBIDDEN")
    if _contains(repo, root):
        raise ReviewServerError("SYNCED_DRAFT_ROOT_FORBIDDEN")
    root.mkdir(parents=True, exist_ok=True)
    return root


def _load_selection_file(value: str | None) -> tuple[set[str] | None, str | None]:
    if not value:
        return None, None
    path = Path(value).expanduser().resolve()
    repo = Path(__file__).resolve().parents[1]
    if str(path).startswith("\\\\") or _contains(repo, path) or not path.is_file():
        raise ReviewServerError("SELECTION_FILE_INVALID")
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if tuple(reader.fieldnames or ()) != ("display_order", "review_item_id"):
                raise ReviewServerError("SELECTION_FILE_INVALID")
            rows = list(reader)
    except OSError as exc:
        raise ReviewServerError("SELECTION_FILE_INVALID") from exc
    review_ids = [str(row.get("review_item_id", "")) for row in rows]
    try:
        orders = [int(str(row.get("display_order", ""))) for row in rows]
    except ValueError as exc:
        raise ReviewServerError("SELECTION_FILE_INVALID") from exc
    if (
        not review_ids
        or len(review_ids) != len(set(review_ids))
        or len(orders) != len(set(orders))
        or any(order <= 0 for order in orders)
        or any(not re.fullmatch(r"review_[A-Za-z0-9_-]{1,64}", review_id) for review_id in review_ids)
    ):
        raise ReviewServerError("SELECTION_FILE_INVALID")
    canonical = "\n".join(
        f"{order}\t{review_id}" for order, review_id in sorted(zip(orders, review_ids))
    )
    selection_id = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
    return set(review_ids), selection_id


def _validate_annotation(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "facilitation_present",
        "primary_function",
        "secondary_functions",
        "confidence",
    }:
        raise ReviewServerError("ANNOTATION_INVALID")
    presence = value["facilitation_present"]
    primary = value["primary_function"]
    secondary = value["secondary_functions"]
    confidence = value["confidence"]
    if presence not in {"yes", "no", "uncertain"}:
        raise ReviewServerError("ANNOTATION_INVALID")
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        raise ReviewServerError("ANNOTATION_INVALID")
    if not 0.0 <= float(confidence) <= 1.0:
        raise ReviewServerError("ANNOTATION_INVALID")
    if (
        not isinstance(primary, str)
        or not isinstance(secondary, list)
        or any(not isinstance(label, str) for label in secondary)
        or len(secondary) != len(set(secondary))
        or any(label not in FUNCTION_LABELS for label in secondary)
    ):
        raise ReviewServerError("ANNOTATION_INVALID")
    if presence == "yes":
        if primary not in FUNCTION_LABELS or primary in secondary:
            raise ReviewServerError("ANNOTATION_INVALID")
    elif primary or secondary:
        raise ReviewServerError("ANNOTATION_INVALID")
    return {
        "facilitation_present": presence,
        "primary_function": primary,
        "secondary_functions": secondary,
        "confidence": round(float(confidence), 2),
    }


class ReviewState:
    """Own in-memory content and persist only identity-blind annotation labels."""

    def __init__(
        self,
        *,
        public_batch: Mapping[str, Any],
        contents: Mapping[str, ReviewContent],
        coder_id: str,
        annotation_round: int,
        draft_root: Path,
        selection_id: str | None = None,
    ) -> None:
        if not CODER_PATTERN.fullmatch(coder_id) or annotation_round not in {1, 2}:
            raise ReviewServerError("CODER_OR_ROUND_INVALID")
        if not contents:
            raise ReviewServerError("REVIEW_CONTENT_EMPTY")
        self.public_batch = dict(public_batch)
        self.contents = dict(contents)
        self.ordered_ids = [
            content.review_item_id
            for content in sorted(contents.values(), key=lambda item: item.display_order)
        ]
        if len(self.ordered_ids) != len(set(self.ordered_ids)):
            raise ReviewServerError("REVIEW_CONTENT_INVALID")
        self.coder_id = coder_id
        self.annotation_round = annotation_round
        self.selection_id = selection_id
        selection_suffix = f"-selection-{selection_id}" if selection_id else ""
        self.draft_path = draft_root / (
            f"{public_batch['batch_id']}-{coder_id}-round-{annotation_round}{selection_suffix}.json"
        )
        self.annotations: dict[str, dict[str, Any]] = {}
        self.lock = threading.RLock()
        self._load_draft()

    def _load_draft(self) -> None:
        if not self.draft_path.exists():
            return
        try:
            payload = json.loads(self.draft_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ReviewServerError("DRAFT_INVALID") from exc
        expected_keys = {"schema_version", "batch_id", "coder_id", "annotation_round", "annotations"}
        if (
            not isinstance(payload, dict)
            or set(payload) != expected_keys
            or payload["schema_version"] != "p1e-review-draft-v1"
            or payload["batch_id"] != self.public_batch["batch_id"]
            or payload["coder_id"] != self.coder_id
            or payload["annotation_round"] != self.annotation_round
            or not isinstance(payload["annotations"], dict)
            or not set(payload["annotations"]).issubset(self.contents)
        ):
            raise ReviewServerError("DRAFT_INVALID")
        self.annotations = {
            review_id: _validate_annotation(annotation)
            for review_id, annotation in payload["annotations"].items()
        }

    def _save_draft(self) -> None:
        payload = {
            "schema_version": "p1e-review-draft-v1",
            "batch_id": self.public_batch["batch_id"],
            "coder_id": self.coder_id,
            "annotation_round": self.annotation_round,
            "annotations": self.annotations,
        }
        fd, temp_name = tempfile.mkstemp(prefix=".p1e-draft-", suffix=".tmp", dir=self.draft_path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, self.draft_path)
        finally:
            try:
                Path(temp_name).unlink(missing_ok=True)
            except OSError:
                pass

    def session_payload(self) -> dict[str, Any]:
        with self.lock:
            return {
                "schema_version": "p1e-review-session-v1",
                "selected_count": len(self.ordered_ids),
                "completed_count": len(self.annotations),
                "population_count": int(self.public_batch.get("population_count", len(self.ordered_ids))),
                "selection_applied": self.selection_id is not None,
                "items": [
                    {
                        "review_item_id": review_id,
                        "display_order": self.contents[review_id].display_order,
                        "completed": review_id in self.annotations,
                    }
                    for review_id in self.ordered_ids
                ],
            }

    def item_payload(self, review_id: str) -> dict[str, Any]:
        with self.lock:
            content = self.contents.get(review_id)
            if content is None:
                raise ReviewServerError("REVIEW_ITEM_NOT_FOUND")
            payload = asdict(content)
            payload["annotation"] = self.annotations.get(review_id)
            return payload

    def save_annotation(self, review_id: str, value: Any) -> dict[str, Any]:
        if review_id not in self.contents:
            raise ReviewServerError("REVIEW_ITEM_NOT_FOUND")
        annotation = _validate_annotation(value)
        with self.lock:
            self.annotations[review_id] = annotation
            self._save_draft()
        return annotation

    def export_csv(self, *, scope: str = "complete") -> bytes:
        with self.lock:
            if scope not in {"complete", "pilot"}:
                raise ReviewServerError("EXPORT_SCOPE_INVALID")
            if scope == "complete" and set(self.annotations) != set(self.contents):
                raise ReviewServerError("REVIEW_INCOMPLETE")
            if scope == "pilot" and not self.annotations:
                raise ReviewServerError("REVIEW_EMPTY")
            exported_ids = [
                review_id for review_id in self.ordered_ids if review_id in self.annotations
            ]
            status = (
                "pilot_single_coded" if self.annotation_round == 1 else "pilot_double_coded"
            ) if scope == "pilot" else (
                ("validation_single_coded" if self.annotation_round == 1 else "validation_double_coded")
                if self.selection_id else
                ("single_coded" if self.annotation_round == 1 else "double_coded")
            )
            stream = io.StringIO(newline="")
            writer = csv.DictWriter(stream, fieldnames=BLIND_COLUMNS, lineterminator="\n")
            writer.writeheader()
            for review_id in exported_ids:
                annotation = self.annotations[review_id]
                writer.writerow(
                    {
                        "display_order": self.contents[review_id].display_order,
                        "review_item_id": review_id,
                        "facilitation_present": annotation["facilitation_present"],
                        "primary_function": annotation["primary_function"],
                        "secondary_functions": json.dumps(annotation["secondary_functions"], ensure_ascii=False, separators=(",", ":")),
                        "confidence": f"{annotation['confidence']:.2f}",
                        "coder_id": self.coder_id,
                        "annotation_round": self.annotation_round,
                        "adjudication_status": status,
                    }
                )
            return ("\ufeff" + stream.getvalue()).encode("utf-8")


class ReviewHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address: tuple[str, int], state: ReviewState, token: str):
        if address[0] != "127.0.0.1" or not TOKEN_PATTERN.fullmatch(token):
            raise ReviewServerError("SERVER_CONFIGURATION_INVALID")
        self.review_state = state
        self.review_token = token
        super().__init__(address, ReviewRequestHandler)


class ReviewRequestHandler(BaseHTTPRequestHandler):
    server: ReviewHTTPServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:
        return

    def _headers(self, status: int, content_type: str, length: int, extra: Mapping[str, str] | None = None) -> None:
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Connection", "close")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
        if extra:
            for name, value in extra.items():
                self.send_header(name, value)
        self.end_headers()

    def _send(self, status: int, body: bytes, content_type: str, extra: Mapping[str, str] | None = None) -> None:
        self._headers(status, content_type, len(body), extra)
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: Mapping[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _origin(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    def _host_valid(self) -> bool:
        return self.headers.get("Host", "") == f"127.0.0.1:{self.server.server_port}"

    def _api_authorized(self, *, write: bool = False) -> bool:
        if not self._host_valid() or self.headers.get("X-Review-Token", "") != self.server.review_token:
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin != self._origin():
            return False
        if write and origin != self._origin():
            return False
        return True

    def _error(self, status: int, code: str) -> None:
        self._json(status, {"error": code})

    def do_GET(self) -> None:
        request_url = urlsplit(self.path)
        path = request_url.path
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
                self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "STATIC_ASSET_UNAVAILABLE")
                return
            self._send(HTTPStatus.OK, body, content_type)
            return
        if not self._api_authorized():
            self._error(HTTPStatus.FORBIDDEN, "SESSION_FORBIDDEN")
            return
        try:
            if path == "/api/session":
                self._json(HTTPStatus.OK, self.server.review_state.session_payload())
                return
            if path == "/api/export":
                scope = parse_qs(request_url.query).get("scope", ["complete"])[0]
                body = self.server.review_state.export_csv(scope=scope)
                exported_count = len(self.server.review_state.annotations)
                if scope == "pilot":
                    scope_suffix = f"-pilot-{exported_count}-of-{len(self.server.review_state.contents)}"
                elif self.server.review_state.selection_id:
                    scope_suffix = f"-validation-{len(self.server.review_state.contents)}-{self.server.review_state.selection_id}"
                else:
                    scope_suffix = ""
                filename = f"{self.server.review_state.public_batch['batch_id']}-{self.server.review_state.coder_id}-round-{self.server.review_state.annotation_round}{scope_suffix}.csv"
                self._send(HTTPStatus.OK, body, "text/csv; charset=utf-8", {
                    "Content-Disposition": f'attachment; filename="{filename}"',
                    "X-Export-Filename": filename,
                    "X-Export-Scope": scope,
                    "X-Exported-Count": str(exported_count),
                })
                return
            prefix = "/api/items/"
            if path.startswith(prefix) and "/" not in path[len(prefix):]:
                review_id = unquote(path[len(prefix):])
                self._json(HTTPStatus.OK, self.server.review_state.item_payload(review_id))
                return
        except ReviewServerError as exc:
            status = HTTPStatus.NOT_FOUND if exc.code == "REVIEW_ITEM_NOT_FOUND" else HTTPStatus.CONFLICT
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
        review_id = unquote(path[len(prefix):-len(suffix)])
        if not review_id or "/" in review_id:
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND")
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_REQUEST_BODY or self.headers.get_content_type() != "application/json":
            self._error(HTTPStatus.BAD_REQUEST, "REQUEST_INVALID")
            return
        try:
            payload = json.loads(self.rfile.read(length))
            annotation = self.server.review_state.save_annotation(review_id, payload)
            self._json(HTTPStatus.OK, {"ok": True, "annotation": annotation})
        except json.JSONDecodeError:
            self._error(HTTPStatus.BAD_REQUEST, "REQUEST_INVALID")
        except ReviewServerError as exc:
            status = HTTPStatus.NOT_FOUND if exc.code == "REVIEW_ITEM_NOT_FOUND" else HTTPStatus.BAD_REQUEST
            self._error(status, exc.code)

    def do_POST(self) -> None:
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED")

    def do_DELETE(self) -> None:
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED")


def create_server(*, state: ReviewState, token: str, port: int = 0) -> ReviewHTTPServer:
    if not 0 <= port <= 65535:
        raise ReviewServerError("PORT_INVALID")
    return ReviewHTTPServer(("127.0.0.1", port), state, token)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-dir", required=True)
    parser.add_argument("--research-database", required=True)
    parser.add_argument("--input-root", required=True)
    parser.add_argument("--coder-id", required=True)
    parser.add_argument("--annotation-round", required=True, type=int)
    parser.add_argument("--draft-root")
    parser.add_argument("--selection-file")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--no-open-browser", action="store_true")
    parser.add_argument("--check-only", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        key = load_hmac_key()
        os.environ.pop(HMAC_ENV, None)
        selected_review_ids, selection_id = _load_selection_file(args.selection_file)
        public_batch, contents = load_review_contents(
            batch_dir_value=args.batch_dir,
            research_database_value=args.research_database,
            input_root_value=args.input_root,
            key=key,
            selected_review_ids=selected_review_ids,
        )
        del key
        state = ReviewState(
            public_batch=public_batch,
            contents=contents,
            coder_id=args.coder_id,
            annotation_round=args.annotation_round,
            draft_root=_validate_draft_root(args.draft_root),
            selection_id=selection_id,
        )
        if args.check_only:
            redaction_counts = sorted(
                content.redaction_count for content in state.contents.values()
            )
            print(
                json.dumps(
                    {
                        "ok": True,
                        "mode": "check",
                        "selected_count": len(state.ordered_ids),
                        "redacted_item_count": sum(
                            content.redaction_count > 0
                            for content in state.contents.values()
                        ),
                        "redaction_count": sum(
                            redaction_counts
                        ),
                        "redaction_p95": redaction_counts[
                            min(len(redaction_counts) - 1, int(len(redaction_counts) * 0.95))
                        ],
                        "redaction_max": redaction_counts[-1],
                        "heavily_redacted_item_count": sum(
                            count >= 20 for count in redaction_counts
                        ),
                        "suspected_truncation_count": sum(
                            content.suspected_truncation
                            for content in state.contents.values()
                        ),
                        "content_persisted": False,
                        "identity_blind": True,
                    },
                    ensure_ascii=False,
                )
            )
            return 0
        configured_token = os.environ.get(SESSION_TOKEN_ENV, "")
        token = configured_token or secrets.token_urlsafe(32)
        if not TOKEN_PATTERN.fullmatch(token):
            raise ReviewServerError("SESSION_TOKEN_INVALID")
        if args.no_open_browser and not configured_token:
            raise ReviewServerError("NONINTERACTIVE_TOKEN_REQUIRED")
        server = create_server(state=state, token=token, port=args.port)
    except (ReviewContentError, ReviewServerError) as exc:
        print(json.dumps({"ok": False, "error": exc.code}, ensure_ascii=False), file=sys.stderr)
        return 2

    url = f"http://127.0.0.1:{server.server_port}/#token={token}"
    print(json.dumps({"ok": True, "host": "127.0.0.1", "port": server.server_port, "content_persisted": False}, ensure_ascii=False))
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
