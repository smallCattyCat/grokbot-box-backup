#!/usr/bin/env python3
"""Nutstore slim-ledger mirror ops for mcp-bridge (raw sqlite3, no prisma).

Ops: sync_status | get_by_post | append | patrol_begin | patrol_end
DB: CMOOC_LEDGER_DB or /workspace/cmooc-ledger-mirror/ledger-slim.db

DecisionTapeEntry is the MCP + cmooc助手 read/write contract (hash-chained on
invocationId+sequence; same rules as lib/autonomy/decision-tape.ts).
AgentPatrolLedger is deprecated read-compat only — never the write path.
ScheduledInvocation rows are created only via patrol_begin (slim lease claim
mirroring lib/autonomy/invocation-store.ts) — tape_append never invents them.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

DEFAULT_DB = "/workspace/cmooc-ledger-mirror/ledger-slim.db"
MIRROR_DIR = "/workspace/cmooc-ledger-mirror"

CANONICAL_HASH_ALGORITHM = "cmooc-canonical-json-sha256-v1"
DECISION_TAPE_ENTRY_SCHEMA_VERSION = "cmooc.decision-tape-entry.v1"
DECISION_TAPE_PAYLOAD_SCHEMA_VERSION = f"{DECISION_TAPE_ENTRY_SCHEMA_VERSION}.payload"
MCP_TAPE_PAYLOAD_SCHEMA = "cmooc.mcp-decision-tape.v1"

# Mirror lib/autonomy/decision-tape.ts FORBIDDEN_KEYS
FORBIDDEN_KEYS = {
    "courseId",
    "platformCourseRef",
    "stableThreadRef",
    "threadRef",
    "authorRef",
    "actorRef",
    "eventRef",
    "canonicalUrl",
    "locator",
    "url",
    "title",
    "content",
    "body",
    "text",
    "cookie",
    "token",
    "password",
    "raw",
}

SECRET_KEY_RE = re.compile(
    r"(password|passwd|secret|token|api[_-]?key|satoken|authorization|cookie|credential)",
    re.I,
)
FORUM_BODY_KEYS = {
    "content",
    "body",
    "text",
    "title",
    "raw",
    "url",
    "forumText",
    "forum_body",
}
KIND_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
R7_DECISIONS = {"DRAFT", "WAIT", "YIELD", "ABSTAIN"}
KNOWN_KINDS = {
    "patrol_judgment",
    "publish_receipt",
    "decision_committed",
}

COUNT_TABLES = [
    "DecisionTapeEntry",
    "AutonomyDecision",
    "ForumPost",
    "ReviewEvent",
    "ScheduledInvocation",
    "AgentPatrolLedger",
    "AutonomyIncident",
    "BudgetReservation",
    "ExecutionAttempt",
    "WorkbenchRunRecord",
]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def utc_now_ms() -> int:
    return int(time.time() * 1000)


def resolve_db() -> str:
    env = (os.environ.get("CMOOC_LEDGER_DB") or "").strip()
    if env:
        return env
    for key in ("CMOOC_DATABASE_URL", "DATABASE_URL"):
        raw = (os.environ.get(key) or "").strip()
        if raw.startswith("file:"):
            return raw[5:]
        if raw and not raw.startswith(("postgres", "mysql", "sqlserver")):
            return raw
    return DEFAULT_DB


def emit(obj: Any, code: int = 0) -> None:
    sys.stdout.write(json.dumps(scrub(obj), ensure_ascii=False) + "\n")
    sys.exit(code)


def fail(code: str, message: str, **extra: Any) -> None:
    emit(
        {
            "ok": False,
            "error": {"code": code, "message": message},
            "externalMutationAttempted": False,
            "containsForumText": False,
            **extra,
        },
        1,
    )


def scrub(value: Any) -> Any:
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if SECRET_KEY_RE.search(k):
                if isinstance(v, bool) or v is None:
                    out[k] = v
                elif isinstance(v, dict):
                    out[k] = scrub(v)
                else:
                    out[k] = "[redacted]"
            else:
                out[k] = scrub(v)
        return out
    return value


def file_stat(path: str) -> dict[str, Any]:
    try:
        st = os.stat(path)
        return {
            "exists": True,
            "size": st.st_size,
            "mtime": datetime.fromtimestamp(st.st_mtime, timezone.utc)
            .isoformat()
            .replace("+00:00", "Z"),
        }
    except OSError:
        return {"exists": False, "size": None, "mtime": None}


def connect(db_path: str, *, writable: bool = False) -> sqlite3.Connection:
    if not os.path.exists(db_path):
        fail("LEDGER_DB_MISSING", f"Slim ledger DB not found: {db_path}", path=db_path)
    uri = f"file:{db_path}" + ("" if writable else "?mode=ro")
    conn = sqlite3.connect(uri, uri=True, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def ensure_patrol_table(conn: sqlite3.Connection) -> None:
    """Keep AgentPatrolLedger present for deprecated read-compat only."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS AgentPatrolLedger (
          id TEXT PRIMARY KEY NOT NULL,
          forumPostId TEXT NOT NULL,
          postId TEXT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'recorded',
          payloadJson TEXT NOT NULL,
          containsForumText INTEGER NOT NULL DEFAULT 0,
          createdAt TEXT NOT NULL
        )
        """
    )
    cols = {r[1] for r in conn.execute("PRAGMA table_info(AgentPatrolLedger)")}
    alters = []
    if "postId" not in cols:
        alters.append("ALTER TABLE AgentPatrolLedger ADD COLUMN postId TEXT")
    if "containsForumText" not in cols:
        alters.append(
            "ALTER TABLE AgentPatrolLedger ADD COLUMN containsForumText INTEGER NOT NULL DEFAULT 0"
        )
    if "createdAt" not in cols:
        alters.append("ALTER TABLE AgentPatrolLedger ADD COLUMN createdAt TEXT")
    for sql in alters:
        conn.execute(sql)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS AgentPatrolLedger_forumPostId_idx ON AgentPatrolLedger(forumPostId)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS AgentPatrolLedger_kind_createdAt_idx ON AgentPatrolLedger(kind, createdAt)"
    )
    conn.commit()


def table_counts(conn: sqlite3.Connection) -> dict[str, int | None]:
    existing = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    out: dict[str, int | None] = {}
    for t in COUNT_TABLES:
        if t not in existing:
            out[t] = None
            continue
        try:
            out[t] = conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        except sqlite3.Error:
            out[t] = None
    return out


def parse_payload(raw: str | None) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"rawTruncated": raw[:200]}


def truncate_payload(payload: Any, max_len: int = 400) -> Any:
    if not isinstance(payload, dict):
        s = json.dumps(payload, ensure_ascii=False) if payload is not None else None
        if s and len(s) > max_len:
            return {"truncated": s[:max_len] + "…"}
        return payload
    out: dict[str, Any] = {}
    for k, v in payload.items():
        if k in FORUM_BODY_KEYS or k in FORBIDDEN_KEYS or SECRET_KEY_RE.search(k):
            continue
        if isinstance(v, str) and len(v) > 200:
            out[k] = v[:200] + "…"
        elif isinstance(v, (dict, list)):
            s = json.dumps(v, ensure_ascii=False)
            out[k] = (s[:200] + "…") if len(s) > 200 else v
        else:
            out[k] = v
    out["containsForumText"] = False
    return out


def host_of(url: str | None) -> str | None:
    if not url:
        return None
    try:
        return urlparse(url).hostname
    except Exception:
        return None


def normalize_decision(value: Any) -> str | None:
    if value is None:
        return None
    s = str(value).strip().upper()
    if s in R7_DECISIONS:
        return s
    return None


def format_created_at(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            ms = int(value)
            if ms > 10_000_000_000:  # ms epoch
                return (
                    datetime.fromtimestamp(ms / 1000, timezone.utc)
                    .isoformat()
                    .replace("+00:00", "Z")
                )
        except (OverflowError, OSError, ValueError):
            return value
    return value


# --- Canonical hash (match lib/facilitation-protocol/canonical-hash.ts) ---


def canonicalize_value(value: Any, path: str = "$") -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > 9007199254740991:
            raise ValueError(f"Canonical JSON 只接受安全整数，非法位置：{path}")
        return str(value)
    if isinstance(value, float):
        raise ValueError(f"Canonical JSON 只接受安全整数，非法位置：{path}")
    if isinstance(value, list):
        parts = [
            canonicalize_value(item, f"{path}[{index}]")
            for index, item in enumerate(value)
        ]
        return "[" + ",".join(parts) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        parts = []
        for key in keys:
            child = value[key]
            parts.append(
                f"{json.dumps(key, ensure_ascii=False)}:"
                f"{canonicalize_value(child, f'{path}.{key}')}"
            )
        return "{" + ",".join(parts) + "}"
    raise ValueError(f"Canonical JSON 不接受 {type(value).__name__}：{path}")


def canonical_protocol_hash(schema_version: str, value: Any) -> str:
    if not str(schema_version).strip():
        raise ValueError("协议哈希缺少 schemaVersion。")
    if (
        isinstance(value, dict)
        and "schemaVersion" in value
        and value["schemaVersion"] != schema_version
    ):
        raise ValueError("协议哈希域与对象 schemaVersion 不一致。")
    domain = f"{CANONICAL_HASH_ALGORITHM}\0{schema_version}\0"
    h = hashlib.sha256()
    h.update(domain.encode("utf-8"))
    h.update(canonicalize_value(value).encode("utf-8"))
    return h.hexdigest()


def decision_tape_payload_hash(payload: Any) -> str:
    return canonical_protocol_hash(
        DECISION_TAPE_PAYLOAD_SCHEMA_VERSION,
        {
            "schemaVersion": DECISION_TAPE_PAYLOAD_SCHEMA_VERSION,
            "payload": payload,
        },
    )


def assert_redacted(value: Any, path: list[str] | None = None) -> None:
    """Match decision-tape.ts assertRedacted; raises ValueError on violation."""
    path = path or []
    if value is None or isinstance(value, bool) or isinstance(value, int):
        if isinstance(value, int) and not isinstance(value, bool):
            if abs(value) > 9007199254740991:
                raise ValueError("Decision Tape 只接受规范 JSON。")
        return
    if isinstance(value, float):
        raise ValueError("Decision Tape 只接受规范 JSON。")
    if isinstance(value, str):
        if (
            len(value) > 512
            or re.search(r"https?://", value, re.I)
            or re.search(r"\b(?:Satoken|Bearer)\b", value, re.I)
        ):
            raise ValueError(
                f"Decision Tape 字符串字段 {'.'.join(path) or '$'} 未通过去正文边界。"
            )
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            assert_redacted(item, path + [str(index)])
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if key in FORBIDDEN_KEYS:
                raise ValueError(
                    f"Decision Tape 禁止字段：{'.'.join(path + [key])}."
                )
            assert_redacted(item, path + [key])
        return
    raise ValueError("Decision Tape 只接受规范 JSON。")


def new_cuid_like() -> str:
    return f"c{utc_now_ms():x}{uuid.uuid4().hex[:16]}"


def op_sync_status(db_path: str) -> dict[str, Any]:
    os.makedirs(MIRROR_DIR, exist_ok=True)
    slim = file_stat(db_path)
    counts = None
    if slim["exists"]:
        try:
            w = connect(db_path, writable=True)
            ensure_patrol_table(w)
            w.close()
            conn = connect(db_path, writable=False)
            counts = table_counts(conn)
            conn.close()
        except SystemExit:
            raise
        except Exception as e:
            counts = {"error": str(e)}
    return {
        "ok": True,
        "mirrorDir": MIRROR_DIR,
        "path": db_path,
        "size": slim["size"],
        "mtime": slim["mtime"],
        "exists": slim["exists"],
        "tableCounts": counts,
        "env": {
            "CMOOC_LEDGER_DB": os.environ.get("CMOOC_LEDGER_DB") or DEFAULT_DB,
            "resolved": db_path,
        },
        "refreshPath": {
            "onTYL": "python export_slim.py → AppData Local cmooc-ledger-slim/ledger-slim.db",
            "toBox": "CopyToBox → /workspace/cmooc-ledger-mirror/ledger-slim.db",
            "writesBack": "CopyFromBox ledger-slim.db with Nutstore lock caution",
        },
        "cutover": {
            "writePath": "DecisionTapeEntry",
            "readPrimary": "DecisionTapeEntry (+ AutonomyDecision when linkable)",
            "deprecatedReadCompat": "AgentPatrolLedger → deprecatedPatrolRows",
            "r7Decisions": sorted(R7_DECISIONS),
        },
        "note": "Authority is Nutstore; this op only verifies the local slim mirror.",
        "externalMutationAttempted": False,
        "containsForumText": False,
    }


def _load_deprecated_patrol(
    conn: sqlite3.Connection, post_id: str, limit: int
) -> list[dict[str, Any]]:
    existing = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    if "AgentPatrolLedger" not in existing:
        return []
    cols = {r[1] for r in conn.execute("PRAGMA table_info(AgentPatrolLedger)")}
    if "postId" in cols:
        patrol_rows = conn.execute(
            """
            SELECT * FROM AgentPatrolLedger
            WHERE forumPostId = ? OR postId = ?
            ORDER BY datetime(createdAt) DESC
            LIMIT ?
            """,
            (post_id, post_id, limit),
        ).fetchall()
    else:
        patrol_rows = conn.execute(
            """
            SELECT * FROM AgentPatrolLedger
            WHERE forumPostId = ?
            ORDER BY datetime(createdAt) DESC
            LIMIT ?
            """,
            (post_id, limit),
        ).fetchall()
    out = []
    for row in patrol_rows:
        d = dict(row)
        payload = truncate_payload(parse_payload(d.get("payloadJson")))
        judgment = None
        if isinstance(payload, dict):
            judgment = normalize_decision(
                payload.get("decision") or payload.get("judgment")
            )
        out.append(
            {
                "id": d.get("id"),
                "forumPostId": d.get("forumPostId"),
                "postId": d.get("postId"),
                "kind": d.get("kind"),
                "status": d.get("status"),
                "decision": judgment,
                "payload": payload,
                "invocationId": d.get("invocationId"),
                "decisionTapeEntryId": d.get("decisionTapeEntryId"),
                "containsForumText": False,
                "createdAt": d.get("createdAt"),
                "updatedAt": d.get("updatedAt"),
                "source": "AgentPatrolLedger",
                "deprecated": True,
            }
        )
    return out


def _decision_row(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "invocationId": r["invocationId"],
        "courseAlias": r["courseAlias"],
        "decisionKey": r["decisionKey"],
        "threadKey": r["threadKey"],
        "decision": normalize_decision(r["decision"]),
        "decisionRaw": r["decision"],
        "decisionMode": r["decisionMode"],
        "reasonCode": r["reasonCode"],
        "publishAttempted": bool(r["publishAttempted"]),
        "editorWriteAttempted": bool(r["editorWriteAttempted"]),
        "bodyPersisted": bool(r["bodyPersisted"]),
        "createdAt": format_created_at(r["createdAt"]),
    }


def op_get_by_post(db_path: str, post_id: str, limit: int) -> dict[str, Any]:
    post_id = (post_id or "").strip()
    if not post_id:
        fail("POST_ID_REQUIRED", "forumPostId / postId required")
    limit = max(1, min(int(limit or 50), 200))

    w = connect(db_path, writable=True)
    ensure_patrol_table(w)
    w.close()

    conn = connect(db_path, writable=False)

    forum = conn.execute(
        """
        SELECT id, forumPostId, courseId, title, url, createdAt, replyCount, likeCount, viewCount, sourceKind
        FROM ForumPost
        WHERE forumPostId = ? OR id = ?
        LIMIT 1
        """,
        (post_id, post_id),
    ).fetchone()

    forum_summary = None
    internal_post_id = None
    if forum:
        title = forum["title"] or ""
        forum_summary = {
            "id": forum["id"],
            "forumPostId": forum["forumPostId"],
            "courseId": forum["courseId"],
            "hasTitle": bool(title),
            "titleLen": len(title),
            "titlePreview": (title[:40] + "…") if len(title) > 40 else title,
            "urlHost": host_of(forum["url"]),
            "replyCount": forum["replyCount"],
            "likeCount": forum["likeCount"],
            "viewCount": forum["viewCount"],
            "sourceKind": forum["sourceKind"],
            "createdAt": format_created_at(forum["createdAt"]),
        }
        post_id = forum["forumPostId"] or post_id
        internal_post_id = forum["id"]

    deprecated_patrol = _load_deprecated_patrol(conn, post_id, limit)
    if internal_post_id and internal_post_id != post_id:
        extra = _load_deprecated_patrol(conn, internal_post_id, limit)
        seen_p = {e["id"] for e in deprecated_patrol}
        for e in extra:
            if e["id"] not in seen_p:
                deprecated_patrol.append(e)

    like_patterns = [
        f'%"forumPostId":"{post_id}"%',
        f'%"postId":"{post_id}"%',
        f'%"forumPostId": "{post_id}"%',
        f'%"postId": "{post_id}"%',
    ]
    if internal_post_id:
        like_patterns.extend(
            [
                f'%"forumPostId":"{internal_post_id}"%',
                f'%"postId":"{internal_post_id}"%',
            ]
        )

    tape_rows: list[sqlite3.Row] = []
    seen_ids: set[str] = set()
    for pat in like_patterns:
        rows = conn.execute(
            """
            SELECT id, invocationId, sequence, kind, payloadHash, previousEntryHash, entryHash,
                   payloadJson, containsForumText, createdAt
            FROM DecisionTapeEntry
            WHERE payloadJson LIKE ?
            ORDER BY datetime(createdAt) DESC, sequence DESC
            LIMIT ?
            """,
            (pat, limit),
        ).fetchall()
        for r in rows:
            if r["id"] in seen_ids:
                continue
            seen_ids.add(r["id"])
            tape_rows.append(r)
            if len(tape_rows) >= limit:
                break
        if len(tape_rows) >= limit:
            break

    # Best-effort: CandidateSet may mention forumPostId in candidatesJson
    cand_inv_ids: list[str] = []
    try:
        for pat in like_patterns[:4]:
            for r in conn.execute(
                """
                SELECT DISTINCT invocationId FROM CandidateSet
                WHERE candidatesJson LIKE ?
                LIMIT ?
                """,
                (pat, limit),
            ).fetchall():
                if r["invocationId"] and r["invocationId"] not in cand_inv_ids:
                    cand_inv_ids.append(r["invocationId"])
    except sqlite3.Error:
        pass

    # AutonomyDecision by threadKey == postId (rare) + related invocations
    decisions = conn.execute(
        """
        SELECT id, invocationId, courseAlias, decisionKey, threadKey, decision, decisionMode,
               reasonCode, publishAttempted, editorWriteAttempted, bodyPersisted, createdAt
        FROM AutonomyDecision
        WHERE threadKey = ?
        ORDER BY datetime(createdAt) DESC
        LIMIT ?
        """,
        (post_id, limit),
    ).fetchall()

    invocation_ids = list(
        {
            *[r["invocationId"] for r in tape_rows if r["invocationId"]],
            *[r["invocationId"] for r in decisions if r["invocationId"]],
            *cand_inv_ids,
            *[
                e["invocationId"]
                for e in deprecated_patrol
                if e.get("invocationId")
            ],
        }
    )

    # If candidate invocations found but no tape rows yet, pull recent tape for those invs
    if cand_inv_ids and len(tape_rows) < limit:
        placeholders = ",".join("?" * len(cand_inv_ids))
        for r in conn.execute(
            f"""
            SELECT id, invocationId, sequence, kind, payloadHash, previousEntryHash, entryHash,
                   payloadJson, containsForumText, createdAt
            FROM DecisionTapeEntry
            WHERE invocationId IN ({placeholders})
              AND (
                payloadJson LIKE ?
                OR payloadJson LIKE ?
                OR kind IN ('patrol_judgment','publish_receipt','decision_committed')
              )
            ORDER BY datetime(createdAt) DESC, sequence DESC
            LIMIT ?
            """,
            (*cand_inv_ids, f"%{post_id}%", f"%forumPostId%", limit),
        ).fetchall():
            if r["id"] in seen_ids:
                continue
            # Prefer rows that mention the post; for others keep only if payload has forumPostId match
            payload = parse_payload(r["payloadJson"])
            mentions = False
            if isinstance(payload, dict):
                mentions = (
                    str(payload.get("forumPostId") or "") == post_id
                    or str(payload.get("postId") or "") == post_id
                )
            if not mentions and f'"{post_id}"' not in (r["payloadJson"] or ""):
                continue
            seen_ids.add(r["id"])
            tape_rows.append(r)
            if len(tape_rows) >= limit:
                break

    related_decisions: list[sqlite3.Row] = []
    if invocation_ids:
        placeholders = ",".join("?" * len(invocation_ids))
        related_decisions = conn.execute(
            f"""
            SELECT id, invocationId, courseAlias, decisionKey, threadKey, decision, decisionMode,
                   reasonCode, publishAttempted, editorWriteAttempted, bodyPersisted, createdAt
            FROM AutonomyDecision
            WHERE invocationId IN ({placeholders})
            ORDER BY datetime(createdAt) DESC
            LIMIT ?
            """,
            (*invocation_ids, limit),
        ).fetchall()

    decision_ids = list(
        {
            *[r["id"] for r in decisions],
            *[r["id"] for r in related_decisions],
        }
    )

    review_events: list[sqlite3.Row] = []
    if decision_ids or invocation_ids:
        clauses = []
        params: list[Any] = []
        if decision_ids:
            clauses.append(
                f"decisionId IN ({','.join('?' * len(decision_ids))})"
            )
            params.extend(decision_ids)
        if invocation_ids:
            clauses.append(
                f"invocationId IN ({','.join('?' * len(invocation_ids))})"
            )
            params.extend(invocation_ids)
        review_events = conn.execute(
            f"""
            SELECT id, decisionId, invocationId, kind, outcome, reasonCode, evidenceHash,
                   containsForumText, createdAt
            FROM ReviewEvent
            WHERE {' OR '.join(clauses)}
            ORDER BY datetime(createdAt) DESC
            LIMIT ?
            """,
            (*params, limit),
        ).fetchall()

    all_decisions = [_decision_row(r) for r in decisions]
    seen_d = {d["id"] for d in all_decisions}
    for r in related_decisions:
        if r["id"] not in seen_d:
            all_decisions.append(_decision_row(r))
            seen_d.add(r["id"])

    decisions_by_inv: dict[str, list[dict[str, Any]]] = {}
    for d in all_decisions:
        decisions_by_inv.setdefault(d["invocationId"], []).append(d)

    entries: list[dict[str, Any]] = []
    for r in tape_rows:
        payload = truncate_payload(parse_payload(r["payloadJson"]))
        decision = None
        reason_code = None
        status = None
        if isinstance(payload, dict):
            decision = normalize_decision(
                payload.get("decision") or payload.get("judgment")
            )
            reason_code = payload.get("reasonCode")
            status = payload.get("status")
        linked = None
        for d in decisions_by_inv.get(r["invocationId"] or "", []):
            if decision and d.get("decision") == decision:
                linked = d
                break
        if linked is None and decisions_by_inv.get(r["invocationId"] or ""):
            # single decision on invocation → link when kinds suggest it
            inv_decs = decisions_by_inv[r["invocationId"]]
            if len(inv_decs) == 1 and r["kind"] in (
                "decision_committed",
                "patrol_judgment",
                "publish_receipt",
            ):
                linked = inv_decs[0]
                if decision is None:
                    decision = linked.get("decision")
        if decision is None and linked:
            decision = linked.get("decision")
        entries.append(
            {
                "id": r["id"],
                "invocationId": r["invocationId"],
                "sequence": r["sequence"],
                "kind": r["kind"],
                "decision": decision,
                "reasonCode": reason_code
                or (linked.get("reasonCode") if linked else None),
                "status": status,
                "payloadHash": r["payloadHash"],
                "previousEntryHash": r["previousEntryHash"],
                "entryHash": r["entryHash"],
                "payload": payload,
                "containsForumText": False,
                "createdAt": format_created_at(r["createdAt"]),
                "source": "DecisionTapeEntry",
                "autonomyDecision": linked,
            }
        )

    conn.close()
    return {
        "ok": True,
        "forumPostId": post_id,
        "forumPost": forum_summary,
        "entries": entries,
        "decisionTapeEntries": entries,
        "autonomyDecisions": all_decisions,
        "reviewEvents": [
            {
                "id": r["id"],
                "decisionId": r["decisionId"],
                "invocationId": r["invocationId"],
                "kind": r["kind"],
                "outcome": r["outcome"],
                "reasonCode": r["reasonCode"],
                "evidenceHash": r["evidenceHash"],
                "containsForumText": False,
                "createdAt": format_created_at(r["createdAt"]),
            }
            for r in review_events
        ],
        "deprecatedPatrolRows": deprecated_patrol,
        "counts": {
            "entries": len(entries),
            "decisionTape": len(entries),
            "autonomyDecisions": len(all_decisions),
            "reviewEvents": len(review_events),
            "deprecatedPatrol": len(deprecated_patrol),
        },
        "cutover": {
            "writePath": "DecisionTapeEntry",
            "r7Decisions": sorted(R7_DECISIONS),
            "deprecatedReadCompat": "AgentPatrolLedger → deprecatedPatrolRows",
        },
        "notes": [
            "Primary result is DecisionTapeEntry (hash-chained on invocationId+sequence).",
            "decision is R7 four-state: DRAFT|WAIT|YIELD|ABSTAIN when present.",
            "AgentPatrolLedger is deprecated read-compat only (deprecatedPatrolRows).",
            "Append requires a real ScheduledInvocation id — never invents invocations.",
        ],
        "databasePath": db_path,
        "externalMutationAttempted": False,
        "containsForumText": False,
    }


def redact_payload_dict(base: dict[str, Any]) -> dict[str, Any]:
    """Strip forbidden/secret/forum keys; leave a DecisionTape-safe object."""
    out: dict[str, Any] = {}
    for k, v in base.items():
        if k in FORBIDDEN_KEYS or k in FORUM_BODY_KEYS or SECRET_KEY_RE.search(k):
            continue
        if isinstance(v, dict):
            out[k] = redact_payload_dict(v)
        elif isinstance(v, list):
            cleaned = []
            for item in v:
                if isinstance(item, dict):
                    cleaned.append(redact_payload_dict(item))
                else:
                    cleaned.append(item)
            out[k] = cleaned
        else:
            out[k] = v
    out["containsForumText"] = False
    return out



def _as_ms(value: Any) -> int | None:
    """Normalize sqlite DATETIME (ms int / numeric string / ISO) to epoch ms."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        if s.isdigit() or (s.startswith("-") and s[1:].isdigit()):
            return int(s)
        try:
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            return int(datetime.fromisoformat(s).timestamp() * 1000)
        except ValueError:
            return None
    return None


def _truthy(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _invocation_key_patrol(
    course_alias: str,
    scheduled_for_iso: str,
    mode: str,
    manifest_hash: str,
    nonce: str,
) -> str:
    material = "\0".join(
        [
            "cmooc.scheduled-invocation.patrol.v1",
            course_alias,
            scheduled_for_iso,
            mode,
            manifest_hash,
            nonce,
        ]
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _default_scheduled_for_ms(now_ms: int, interval_minutes: int) -> int:
    interval_ms = max(1, int(interval_minutes)) * 60_000
    return (now_ms // interval_ms) * interval_ms


def _load_active_governance(
    conn: sqlite3.Connection, course_alias: str, now_ms: int
) -> sqlite3.Row | None:
    tables = {
        r[0]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    if "CourseOperationGovernancePolicy" not in tables:
        return None
    rows = conn.execute(
        """
        SELECT * FROM CourseOperationGovernancePolicy
        WHERE courseAlias = ?
          AND lower(coalesce(status, '')) = 'active'
        ORDER BY createdAt DESC
        """,
        (course_alias,),
    ).fetchall()
    for row in rows:
        vf = _as_ms(row["validFrom"])
        vu = _as_ms(row["validUntil"])
        if vf is not None and now_ms < vf:
            continue
        if vu is not None and now_ms > vu:
            continue
        return row
    return rows[0] if rows else None


def op_patrol_begin(
    db_path: str,
    *,
    course_alias: str,
    lease_seconds: int = 900,
) -> dict[str, Any]:
    """Claim a legitimate ScheduledInvocation lease for browser patrol (SHADOW)."""
    course_alias = (course_alias or "").strip()
    if not course_alias:
        fail("COURSE_ALIAS_REQUIRED", "courseAlias is required")
    try:
        lease_seconds = int(lease_seconds)
    except (TypeError, ValueError):
        fail("LEASE_SECONDS_INVALID", "leaseSeconds must be an integer")
    if lease_seconds < 30 or lease_seconds > 7 * 24 * 3600:
        fail(
            "LEASE_SECONDS_INVALID",
            "leaseSeconds must be between 30 and 604800 (7d)",
        )

    conn = connect(db_path, writable=True)
    try:
        conn.execute("BEGIN IMMEDIATE")
        now_ms = utc_now_ms()

        manifest = conn.execute(
            "SELECT * FROM AutonomyCourseManifest WHERE alias = ? LIMIT 1",
            (course_alias,),
        ).fetchone()
        if not manifest:
            fail(
                "COURSE_ALIAS_UNKNOWN",
                f"AutonomyCourseManifest not found for courseAlias={course_alias}",
                courseAlias=course_alias,
            )
        if not _truthy(manifest["enabled"]):
            fail(
                "MANIFEST_DISABLED",
                f"AutonomyCourseManifest disabled for courseAlias={course_alias}",
                courseAlias=course_alias,
            )

        schedule = conn.execute(
            """
            SELECT * FROM OperationSchedule
            WHERE courseAlias = ?
              AND enabled IN (1, '1', 'true', 'TRUE')
              AND mode = 'SHADOW'
            ORDER BY updatedAt DESC
            LIMIT 1
            """,
            (course_alias,),
        ).fetchone()
        if not schedule:
            # fallback: any enabled schedule for alias
            schedule = conn.execute(
                """
                SELECT * FROM OperationSchedule
                WHERE courseAlias = ?
                  AND enabled IN (1, '1', 'true', 'TRUE')
                ORDER BY updatedAt DESC
                LIMIT 1
                """,
                (course_alias,),
            ).fetchone()
        if not schedule:
            fail(
                "SCHEDULE_MISSING",
                f"No OperationSchedule for courseAlias={course_alias}",
                courseAlias=course_alias,
            )

        gov = _load_active_governance(conn, course_alias, now_ms)
        if gov is not None and _truthy(gov["emergencyHalt"]):
            fail(
                "GOVERNANCE_EMERGENCY_HALT",
                f"CourseOperationGovernancePolicy emergencyHalt for {course_alias}",
                courseAlias=course_alias,
                governancePolicyId=gov["id"],
            )

        # Abandon expired running leases (mirror invocation-store recovery)
        conn.execute(
            """
            UPDATE ScheduledInvocation
            SET status = 'abandoned',
                phase = 'lease_expired',
                leaseOwner = NULL,
                leaseExpiresAt = NULL,
                finishedAt = ?,
                updatedAt = ?,
                summaryJson = ?
            WHERE courseAlias = ?
              AND status = 'running'
              AND leaseExpiresAt IS NOT NULL
              AND leaseExpiresAt < ?
            """,
            (
                now_ms,
                now_ms,
                json.dumps(
                    {
                        "schemaVersion": "cmooc.invocation-summary.v1",
                        "status": "abandoned",
                        "reasonCode": "lease_expired",
                        "containsForumText": False,
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                course_alias,
                now_ms,
            ),
        )

        busy = conn.execute(
            """
            SELECT id, leaseOwner, leaseExpiresAt, status, phase
            FROM ScheduledInvocation
            WHERE courseAlias = ?
              AND status = 'running'
              AND (
                leaseExpiresAt IS NULL
                OR leaseExpiresAt >= ?
              )
            ORDER BY startedAt DESC
            LIMIT 1
            """,
            (course_alias, now_ms),
        ).fetchone()
        if busy:
            fail(
                "LEASE_BUSY",
                f"Unexpired running lease on courseAlias={course_alias}",
                courseAlias=course_alias,
                busyInvocationId=busy["id"],
                busyLeaseOwner=busy["leaseOwner"],
                busyLeaseExpiresAt=format_created_at(busy["leaseExpiresAt"]),
            )

        interval_minutes = int(schedule["intervalMinutes"] or 30)
        if interval_minutes < 1:
            interval_minutes = 30
        scheduled_for_ms = _default_scheduled_for_ms(now_ms, interval_minutes)
        scheduled_for_iso = (
            datetime.fromtimestamp(scheduled_for_ms / 1000.0, timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )
        nonce = uuid.uuid4().hex
        inv_key = _invocation_key_patrol(
            course_alias,
            scheduled_for_iso,
            "SHADOW",
            manifest["manifestHash"],
            nonce,
        )
        lease_owner = f"grok-patrol:{uuid.uuid4()}"
        lease_expires_at = now_ms + lease_seconds * 1000
        invocation_id = new_cuid_like()

        gov_policy_id = gov["id"] if gov is not None else None
        gov_version = gov["version"] if gov is not None else None
        gov_hash = gov["governanceHash"] if gov is not None else None
        gov_limits_json = None
        if gov is not None:
            gov_limits_json = json.dumps(
                {
                    "dailySlotLimit": gov["dailySlotLimit"],
                    "perTickActionLimit": gov["perTickActionLimit"],
                    "authorTouchLimit30d": gov["authorTouchLimit30d"],
                    "intervalMinutes": gov["minIntervalMinutes"]
                    if gov["minIntervalMinutes"] is not None
                    else interval_minutes,
                    "containsForumText": False,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )

        conn.execute(
            """
            INSERT INTO ScheduledInvocation (
              id, invocationKey, courseAlias, scheduleId, manifestHash,
              scheduledFor, mode, status, phase, leaseOwner, leaseExpiresAt,
              heartbeatAt, attempt, startedAt, finishedAt, summaryJson,
              createdAt, updatedAt,
              governancePolicyId, governanceVersion, governanceHash,
              governanceLimitsJson
            ) VALUES (
              ?, ?, ?, ?, ?,
              ?, 'SHADOW', 'running', 'lease_acquired', ?, ?,
              ?, 1, ?, NULL, NULL,
              ?, ?,
              ?, ?, ?,
              ?
            )
            """,
            (
                invocation_id,
                inv_key,
                course_alias,
                schedule["id"],
                manifest["manifestHash"],
                scheduled_for_ms,
                lease_owner,
                lease_expires_at,
                now_ms,
                now_ms,
                now_ms,
                now_ms,
                gov_policy_id,
                gov_version,
                gov_hash,
                gov_limits_json,
            ),
        )
        conn.commit()
    except SystemExit:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    except Exception as err:
        try:
            conn.rollback()
        except Exception:
            pass
        fail("PATROL_BEGIN_FAILED", str(err), courseAlias=course_alias)
    finally:
        conn.close()

    return {
        "ok": True,
        "invocationId": invocation_id,
        "courseAlias": course_alias,
        "mode": "SHADOW",
        "leaseOwner": lease_owner,
        "leaseExpiresAt": format_created_at(lease_expires_at),
        "status": "running",
        "phase": "lease_acquired",
        "scheduleId": schedule["id"],
        "manifestHash": manifest["manifestHash"],
        "invocationKey": inv_key,
        "leaseSeconds": lease_seconds,
        "note": (
            "Created ScheduledInvocation under slim lease rules for browser patrol; "
            "use invocationId with cmooc_tape_append. Call cmooc_patrol_end when done."
        ),
        "databasePath": db_path,
        "externalMutationAttempted": False,
        "containsForumText": False,
        "mutatesLocal": True,
        "mirrorWrite": True,
        "writePath": "ScheduledInvocation",
    }


def op_patrol_end(
    db_path: str,
    *,
    invocation_id: str,
    lease_owner: str | None = None,
) -> dict[str, Any]:
    """Mark a patrol ScheduledInvocation completed if lease still held / running."""
    invocation_id = (invocation_id or "").strip()
    if not invocation_id:
        fail("INVOCATION_ID_REQUIRED", "invocationId is required")
    lease_owner = (lease_owner or "").strip() or None

    conn = connect(db_path, writable=True)
    try:
        conn.execute("BEGIN IMMEDIATE")
        now_ms = utc_now_ms()
        row = conn.execute(
            "SELECT * FROM ScheduledInvocation WHERE id = ? LIMIT 1",
            (invocation_id,),
        ).fetchone()
        if not row:
            fail(
                "INVOCATION_NOT_FOUND",
                f"ScheduledInvocation not found: {invocation_id}",
                invocationId=invocation_id,
            )
        if row["status"] != "running":
            fail(
                "INVOCATION_NOT_RUNNING",
                f"ScheduledInvocation status is {row['status']}, expected running",
                invocationId=invocation_id,
                status=row["status"],
            )
        if lease_owner and row["leaseOwner"] and row["leaseOwner"] != lease_owner:
            fail(
                "LEASE_OWNER_MISMATCH",
                "leaseOwner does not match running invocation",
                invocationId=invocation_id,
            )
        # If leaseOwner omitted, require grok-patrol: prefix for safety
        if not lease_owner:
            owner = row["leaseOwner"] or ""
            if not str(owner).startswith("grok-patrol:"):
                fail(
                    "LEASE_OWNER_REQUIRED",
                    "Provide leaseOwner to complete non-patrol (or mismatched) leases",
                    invocationId=invocation_id,
                )

        summary = json.dumps(
            {
                "schemaVersion": "cmooc.invocation-summary.v1",
                "status": "completed",
                "reasonCode": "patrol_end",
                "containsForumText": False,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        cur = conn.execute(
            """
            UPDATE ScheduledInvocation
            SET status = 'completed',
                phase = 'completed',
                leaseOwner = NULL,
                leaseExpiresAt = NULL,
                heartbeatAt = ?,
                finishedAt = ?,
                updatedAt = ?,
                summaryJson = ?
            WHERE id = ?
              AND status = 'running'
              AND (? IS NULL OR leaseOwner = ? OR leaseOwner LIKE 'grok-patrol:%')
            """,
            (
                now_ms,
                now_ms,
                now_ms,
                summary,
                invocation_id,
                lease_owner,
                lease_owner,
            ),
        )
        if cur.rowcount != 1:
            fail(
                "PATROL_END_FAILED",
                "Could not complete invocation (lease lost or race)",
                invocationId=invocation_id,
            )
        conn.commit()
    except SystemExit:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    except Exception as err:
        try:
            conn.rollback()
        except Exception:
            pass
        fail("PATROL_END_FAILED", str(err), invocationId=invocation_id)
    finally:
        conn.close()

    return {
        "ok": True,
        "invocationId": invocation_id,
        "courseAlias": row["courseAlias"],
        "mode": row["mode"],
        "status": "completed",
        "finishedAt": format_created_at(now_ms),
        "note": "Marked ScheduledInvocation completed; lease cleared.",
        "databasePath": db_path,
        "externalMutationAttempted": False,
        "containsForumText": False,
        "mutatesLocal": True,
        "mirrorWrite": True,
        "writePath": "ScheduledInvocation",
    }



def op_append(
    db_path: str,
    *,
    invocation_id: str | None,
    forum_post_id: str | None,
    kind: str,
    decision: str | None,
    reason_code: str | None,
    status: str | None,
    payload: dict[str, Any] | None,
) -> dict[str, Any]:
    invocation_id = (invocation_id or "").strip()
    kind = (kind or "").strip()
    forum_post_id = (forum_post_id or "").strip() or None

    if not invocation_id:
        fail(
            "INVOCATION_ID_REQUIRED",
            "cmooc_tape_append requires a real invocationId (ScheduledInvocation). "
            "Fail closed — will not invent invocations or write AgentPatrolLedger.",
        )
    if not kind or (kind not in KNOWN_KINDS and not KIND_RE.match(kind)):
        fail(
            "KIND_INVALID",
            "kind must be patrol_judgment | publish_receipt | decision_committed "
            "(or lowercase snake_case)",
        )

    decision_n = normalize_decision(decision) if decision else None
    if decision and decision_n is None:
        fail(
            "DECISION_INVALID",
            "decision must be one of DRAFT|WAIT|YIELD|ABSTAIN (R7 四态)",
        )

    status_s = ((status or "recorded").strip() or "recorded")[:64]
    reason_s = (reason_code or "").strip()[:128] or None

    base: dict[str, Any] = {
        "schemaVersion": MCP_TAPE_PAYLOAD_SCHEMA,
        "kind": kind,
        "status": status_s,
        "containsForumText": False,
    }
    if forum_post_id:
        base["forumPostId"] = forum_post_id
    if decision_n:
        base["decision"] = decision_n
    if reason_s:
        base["reasonCode"] = reason_s
    if payload and isinstance(payload, dict):
        for k, v in payload.items():
            if k in ("schemaVersion", "containsForumText"):
                continue
            base[k] = v
        # Re-apply authoritative fields after merge
        base["schemaVersion"] = MCP_TAPE_PAYLOAD_SCHEMA
        base["kind"] = kind
        base["status"] = status_s
        if forum_post_id:
            base["forumPostId"] = forum_post_id
        if decision_n:
            base["decision"] = decision_n
        if reason_s:
            base["reasonCode"] = reason_s

    # Fail closed on forbidden forum/raw keys (match decision-tape.ts) before strip
    def _find_forbidden(obj: Any, path: list[str] | None = None) -> str | None:
        path = path or []
        if isinstance(obj, dict):
            for k, v in obj.items():
                if k in FORBIDDEN_KEYS:
                    return ".".join(path + [k])
                hit = _find_forbidden(v, path + [k])
                if hit:
                    return hit
        elif isinstance(obj, list):
            for i, v in enumerate(obj):
                hit = _find_forbidden(v, path + [str(i)])
                if hit:
                    return hit
        return None

    forbidden_path = _find_forbidden(base)
    if forbidden_path:
        fail(
            "PAYLOAD_FORBIDDEN_KEY",
            f"Decision Tape 禁止字段：{forbidden_path}。",
        )

    # Strip secret-shaped keys; then assert redaction bounds (length / URL / Bearer)
    base = redact_payload_dict(base)

    try:
        assert_redacted(base)
    except ValueError as err:
        fail("PAYLOAD_NOT_REDACTED", str(err))

    conn = connect(db_path, writable=True)
    try:
        inv = conn.execute(
            "SELECT id FROM ScheduledInvocation WHERE id = ? LIMIT 1",
            (invocation_id,),
        ).fetchone()
        if not inv:
            fail(
                "DECISION_TAPE_INVOCATION_NOT_FOUND",
                f"ScheduledInvocation not found: {invocation_id}. "
                "Fail closed — no DecisionTapeEntry written, no AgentPatrolLedger fallback.",
                invocationId=invocation_id,
            )

        if forum_post_id:
            row = conn.execute(
                "SELECT id, forumPostId FROM ForumPost WHERE forumPostId = ? OR id = ? LIMIT 1",
                (forum_post_id, forum_post_id),
            ).fetchone()
            if row and row["forumPostId"]:
                forum_post_id = row["forumPostId"]
                base["forumPostId"] = forum_post_id
                try:
                    assert_redacted(base)
                except ValueError as err:
                    fail("PAYLOAD_NOT_REDACTED", str(err))

        previous = conn.execute(
            """
            SELECT sequence, entryHash FROM DecisionTapeEntry
            WHERE invocationId = ?
            ORDER BY sequence DESC
            LIMIT 1
            """,
            (invocation_id,),
        ).fetchone()
        sequence = (previous["sequence"] if previous else 0) + 1
        previous_hash = previous["entryHash"] if previous else None

        payload_hash = decision_tape_payload_hash(base)
        entry_hash = canonical_protocol_hash(
            DECISION_TAPE_ENTRY_SCHEMA_VERSION,
            {
                "schemaVersion": DECISION_TAPE_ENTRY_SCHEMA_VERSION,
                "invocationId": invocation_id,
                "sequence": sequence,
                "kind": kind,
                "payloadHash": payload_hash,
                "previousEntryHash": previous_hash,
                "containsForumText": False,
            },
        )

        entry_id = new_cuid_like()
        now_ms = utc_now_ms()
        payload_json = json.dumps(base, ensure_ascii=False, separators=(",", ":"))

        conn.execute(
            """
            INSERT INTO DecisionTapeEntry (
              id, invocationId, sequence, kind, payloadHash, previousEntryHash,
              entryHash, payloadJson, containsForumText, createdAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                entry_id,
                invocation_id,
                sequence,
                kind,
                payload_hash,
                previous_hash,
                entry_hash,
                payload_json,
                0,
                now_ms,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    return {
        "ok": True,
        "entry": {
            "id": entry_id,
            "invocationId": invocation_id,
            "sequence": sequence,
            "kind": kind,
            "decision": decision_n,
            "reasonCode": reason_s,
            "status": status_s,
            "forumPostId": forum_post_id,
            "payloadHash": payload_hash,
            "previousEntryHash": previous_hash,
            "entryHash": entry_hash,
            "payload": base,
            "containsForumText": False,
            "createdAt": format_created_at(now_ms),
            "source": "DecisionTapeEntry",
        },
        "note": (
            "Wrote DecisionTapeEntry on local slim mirror using hash-chain rules "
            "from lib/autonomy/decision-tape.ts. AgentPatrolLedger was not written."
        ),
        "databasePath": db_path,
        "externalMutationAttempted": False,
        "containsForumText": False,
        "mutatesLocal": True,
        "mirrorWrite": True,
        "writePath": "DecisionTapeEntry",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Slim ledger ops (sqlite3)")
    parser.add_argument(
        "op",
        choices=[
            "sync_status",
            "get_by_post",
            "append",
            "ledger_sync_status",
            "tape_get_by_post",
            "tape_append",
            "patrol_begin",
            "patrol_end",
        ],
    )
    parser.add_argument("--db", default=None)
    parser.add_argument("--forumPostId", default=None)
    parser.add_argument("--postId", default=None)
    parser.add_argument("--invocationId", default=None)
    parser.add_argument("--kind", default=None)
    parser.add_argument("--decision", default=None)
    parser.add_argument("--reasonCode", default=None)
    parser.add_argument("--status", default=None)
    parser.add_argument("--payload", default=None, help="JSON object string")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--courseAlias", default=None)
    parser.add_argument("--leaseSeconds", type=int, default=900)
    parser.add_argument("--leaseOwner", default=None)
    args = parser.parse_args()

    db_path = args.db or resolve_db()
    op = args.op
    if op in ("sync_status", "ledger_sync_status"):
        emit(op_sync_status(db_path))
    elif op in ("get_by_post", "tape_get_by_post"):
        pid = args.forumPostId or args.postId
        emit(op_get_by_post(db_path, pid or "", args.limit))
    elif op in ("append", "tape_append"):
        payload = None
        if args.payload:
            try:
                payload = json.loads(args.payload)
            except json.JSONDecodeError:
                fail("PAYLOAD_INVALID", "--payload must be valid JSON")
            if not isinstance(payload, dict):
                fail("PAYLOAD_INVALID", "--payload must be a JSON object")
        # Allow invocationId inside payload as fallback, but prefer flag
        inv = args.invocationId
        if not inv and payload and isinstance(payload.get("invocationId"), str):
            inv = payload.get("invocationId")
            payload = {k: v for k, v in payload.items() if k != "invocationId"}
        decision = args.decision
        if not decision and payload and payload.get("decision") is not None:
            decision = str(payload.get("decision"))
        reason = args.reasonCode
        if not reason and payload and payload.get("reasonCode") is not None:
            reason = str(payload.get("reasonCode"))
        pid = args.forumPostId or args.postId
        emit(
            op_append(
                db_path,
                invocation_id=inv,
                forum_post_id=pid,
                kind=args.kind or "",
                decision=decision,
                reason_code=reason,
                status=args.status,
                payload=payload,
            )
        )
    elif op == "patrol_begin":
        emit(
            op_patrol_begin(
                db_path,
                course_alias=args.courseAlias or "",
                lease_seconds=args.leaseSeconds if args.leaseSeconds is not None else 900,
            )
        )
    elif op == "patrol_end":
        emit(
            op_patrol_end(
                db_path,
                invocation_id=args.invocationId or "",
                lease_owner=args.leaseOwner,
            )
        )
    else:
        fail("UNKNOWN_OP", f"Unknown op: {op}")


if __name__ == "__main__":
    main()
