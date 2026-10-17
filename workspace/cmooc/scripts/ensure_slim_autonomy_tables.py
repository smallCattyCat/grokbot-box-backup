#!/usr/bin/env python3
"""Ensure slim ledger has autonomy read stubs without inventing tape/post authority.

Adds empty (or safe-default) tables that prisma autonomy_status / soak_readiness
query but that export_slim historically omitted:
  ForumSetting, AutonomyPolicy, AutonomyWorkerWakeReceipt

Does NOT touch DecisionTapeEntry / ForumPost / ScheduledInvocation rows.
Forces ForumSetting.realPublishEnabled = 0.

Usage:
  python3 scripts/ensure_slim_autonomy_tables.py
  python3 scripts/ensure_slim_autonomy_tables.py --db /workspace/cmooc-ledger-mirror/ledger-slim.db
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

DEFAULT_SLIM = "/workspace/cmooc-ledger-mirror/ledger-slim.db"
DEFAULT_LOCAL = "/workspace/cmooc/prisma/dev.db"

DDL = {
    "ForumSetting": '''
CREATE TABLE IF NOT EXISTS "ForumSetting" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "forumBaseUrl" TEXT NOT NULL,
    "loginUrl" TEXT NOT NULL,
    "postUrlPattern" TEXT NOT NULL,
    "replyEditorSelector" TEXT NOT NULL,
    "replySubmitSelector" TEXT NOT NULL,
    "replySuccessSelector" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "realPublishEnabled" BOOLEAN NOT NULL DEFAULT false
);
''',
    "AutonomyPolicy": '''
CREATE TABLE IF NOT EXISTS "AutonomyPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseAlias" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "allowedActionsJson" TEXT NOT NULL,
    "budgetJson" TEXT NOT NULL,
    "policyHash" TEXT NOT NULL,
    "validFrom" DATETIME NOT NULL,
    "validUntil" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "emergencyHalt" BOOLEAN NOT NULL DEFAULT false,
    "realPublishEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
''',
    "AutonomyWorkerWakeReceipt": '''
CREATE TABLE IF NOT EXISTS "AutonomyWorkerWakeReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "runtimeVersion" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "exitCode" INTEGER,
    "countsJson" TEXT NOT NULL,
    "sourceTruncated" BOOLEAN NOT NULL DEFAULT false,
    "taskSetHash" TEXT NOT NULL,
    "summaryHash" TEXT NOT NULL,
    "editorWriteCount" INTEGER NOT NULL DEFAULT 0,
    "publishAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "realPublishEnabled" BOOLEAN NOT NULL DEFAULT false,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
''',
}

INDEXES = [
    'CREATE INDEX IF NOT EXISTS "AutonomyPolicy_courseAlias_status_idx" ON "AutonomyPolicy"("courseAlias", "status")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "AutonomyPolicy_courseAlias_version_key" ON "AutonomyPolicy"("courseAlias", "version")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "AutonomyPolicy_policyHash_key" ON "AutonomyPolicy"("policyHash")',
    'CREATE INDEX IF NOT EXISTS "AutonomyPolicy_validUntil_idx" ON "AutonomyPolicy"("validUntil")',
    'CREATE INDEX IF NOT EXISTS "AutonomyWorkerWakeReceipt_source_startedAt_idx" ON "AutonomyWorkerWakeReceipt"("source", "startedAt")',
    'CREATE INDEX IF NOT EXISTS "AutonomyWorkerWakeReceipt_status_startedAt_idx" ON "AutonomyWorkerWakeReceipt"("status", "startedAt")',
]


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return bool(row)


def seed_forum_setting(slim: sqlite3.Connection, local_path: str | None) -> str:
    """Insert default ForumSetting with realPublishEnabled=0 if missing."""
    existing = slim.execute('SELECT id, realPublishEnabled FROM "ForumSetting" WHERE id=?', ("default",)).fetchone()
    if existing:
        # Never allow publish flag to stay true on box slim stub
        if existing[1] in (1, "1", True, "true"):
            slim.execute(
                'UPDATE "ForumSetting" SET realPublishEnabled=0, updatedAt=? WHERE id=?',
                (now_iso(), "default"),
            )
            return "forced_realPublishEnabled_false"
        return "kept"
    forum_base = "https://cmooc.bnu.edu.cn/cMOOC/home"
    login_url = forum_base
    post_pat = ""
    editor = ".comment_container #edit .ql-editor"
    submit = ".comment_container .buttons .right"
    success = ""
    if local_path and os.path.exists(local_path):
        try:
            loc = sqlite3.connect(local_path)
            row = loc.execute(
                'SELECT forumBaseUrl, loginUrl, postUrlPattern, replyEditorSelector, '
                'replySubmitSelector, replySuccessSelector FROM "ForumSetting" WHERE id=?',
                ("default",),
            ).fetchone()
            loc.close()
            if row:
                forum_base, login_url, post_pat, editor, submit, success = row
        except Exception:
            pass
    ts = now_iso()
    slim.execute(
        'INSERT INTO "ForumSetting" '
        "(id, forumBaseUrl, loginUrl, postUrlPattern, replyEditorSelector, "
        "replySubmitSelector, replySuccessSelector, createdAt, updatedAt, realPublishEnabled) "
        "VALUES (?,?,?,?,?,?,?,?,?,0)",
        ("default", forum_base, login_url, post_pat, editor, submit, success, ts, ts),
    )
    return "seeded_realPublishEnabled_false"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("CMOOC_LEDGER_DB", DEFAULT_SLIM))
    ap.add_argument("--local-db", default=DEFAULT_LOCAL)
    ap.add_argument("--json", action="store_true", help="print JSON result")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        out = {"ok": False, "error": "SLIM_DB_MISSING", "db": args.db}
        print(json.dumps(out))
        return 1

    conn = sqlite3.connect(args.db)
    created = []
    existed = []
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
        for name, ddl in DDL.items():
            if table_exists(conn, name):
                existed.append(name)
            else:
                conn.executescript(ddl)
                created.append(name)
        for idx in INDEXES:
            conn.execute(idx)
        seed_action = seed_forum_setting(conn, args.local_db)
        conn.commit()
    finally:
        conn.close()

    out = {
        "ok": True,
        "db": args.db,
        "created": created,
        "alreadyPresent": existed,
        "forumSetting": seed_action,
        "note": "Stub tables only; DecisionTapeEntry/ForumPost authority unchanged; realPublishEnabled forced false",
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
