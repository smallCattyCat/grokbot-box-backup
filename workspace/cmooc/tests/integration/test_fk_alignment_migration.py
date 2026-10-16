from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path


SOURCE_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_ROOT = SOURCE_ROOT / "prisma" / "migrations"
TARGET_MIGRATION = "20260802150000_align_intervention_publish_fks"


def apply_migrations_before(
    connection: sqlite3.Connection,
    target: str,
) -> None:
    for migration_dir in sorted(
        path
        for path in MIGRATIONS_ROOT.iterdir()
        if path.is_dir() and path.name < target
    ):
        connection.executescript(
            (migration_dir / "migration.sql").read_text(encoding="utf-8")
        )


def seed_fk_fixture(connection: sqlite3.Connection) -> None:
    timestamp = "2026-08-02T00:00:00.000Z"
    connection.execute(
        """
        INSERT INTO "ForumUser" (
            "id", "forumUserId", "name", "role", "tagsJson",
            "activityLevel", "emotionalState", "centralityScore",
            "lastActiveAt", "createdAt", "updatedAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "fk-user",
            "fk-user-platform",
            "fixture user",
            "LEARNER",
            "[]",
            1,
            "neutral",
            0.0,
            timestamp,
            timestamp,
            timestamp,
        ),
    )
    connection.execute(
        """
        INSERT INTO "ForumPost" (
            "id", "sourceKind", "forumPostId", "authorId", "title",
            "content", "url", "replyCount", "likeCount", "viewCount",
            "createdAt", "updatedAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "fk-post",
            "fixture",
            "fk-post-platform",
            "fk-user",
            "fixture title",
            "fixture body",
            "https://example.test/fk-post",
            0,
            0,
            0,
            timestamp,
            timestamp,
        ),
    )
    connection.execute(
        """
        INSERT INTO "InterventionTask" (
            "id", "postId", "targetUserId", "interventionType",
            "publishTarget", "priorityScore", "status", "createdAt",
            "updatedAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "fk-task",
            "fk-post",
            "fk-user",
            "cognitive_conflict",
            "post_comment",
            80.0,
            "published",
            timestamp,
            timestamp,
        ),
    )
    connection.execute(
        """
        INSERT INTO "PublishAuthorization" (
            "id", "taskId", "kind", "status", "contentHash",
            "targetHash", "expiresAt", "maxUses", "usedCount",
            "metadataJson", "authorizedAt", "createdAt", "updatedAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "fk-authorization",
            "fk-task",
            "single",
            "consumed",
            "a" * 64,
            "b" * 64,
            "2027-08-02T00:00:00.000Z",
            1,
            1,
            "{}",
            timestamp,
            timestamp,
            timestamp,
        ),
    )
    connection.execute(
        """
        INSERT INTO "PublishLog" (
            "id", "taskId", "authorizationId", "action", "status",
            "message", "createdAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "fk-log",
            "fk-task",
            "fk-authorization",
            "stage",
            "published",
            "fixture evidence",
            timestamp,
        ),
    )
    connection.execute(
        """
        INSERT INTO "AgentRun" (
            "id", "taskId", "agentName", "inputJson", "outputJson",
            "status", "startedAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "fk-agent-run",
            "fk-task",
            "fixture-agent",
            "{}",
            "{}",
            "completed",
            timestamp,
        ),
    )
    connection.commit()


def snapshot_rows(
    connection: sqlite3.Connection,
) -> dict[str, tuple[tuple[str, ...], list[tuple]]]:
    snapshot: dict[str, tuple[tuple[str, ...], list[tuple]]] = {}
    for table in (
        "InterventionTask",
        "PublishLog",
        "PublishAuthorization",
        "AgentRun",
    ):
        columns = tuple(
            sorted(
                row[1]
                for row in connection.execute(
                    f'PRAGMA table_info("{table}")'
                ).fetchall()
            )
        )
        projection = ", ".join(f'"{column}"' for column in columns)
        rows = connection.execute(
            f'SELECT {projection} FROM "{table}" ORDER BY "id"'
        ).fetchall()
        snapshot[table] = (columns, rows)
    return snapshot


def foreign_key_actions(
    connection: sqlite3.Connection,
    table: str,
) -> dict[str, tuple[str, str, str]]:
    return {
        row[3]: (row[2], row[5], row[6])
        for row in connection.execute(
            f'PRAGMA foreign_key_list("{table}")'
        ).fetchall()
    }


class ForeignKeyAlignmentMigrationTest(unittest.TestCase):
    def create_legacy_database(
        self,
        temp_dir: str,
        name: str,
    ) -> sqlite3.Connection:
        connection = sqlite3.connect(Path(temp_dir) / name)
        connection.execute("PRAGMA foreign_keys=ON")
        apply_migrations_before(connection, TARGET_MIGRATION)
        seed_fk_fixture(connection)
        return connection

    def test_alignment_is_atomic_and_preserves_evidence(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fk-alignment-") as temp_dir:
            connection = self.create_legacy_database(
                temp_dir,
                "success.db",
            )
            try:
                before = snapshot_rows(connection)
                migration_sql = (
                    MIGRATIONS_ROOT / TARGET_MIGRATION / "migration.sql"
                ).read_text(encoding="utf-8")
                connection.executescript(migration_sql)
                connection.execute("PRAGMA foreign_keys=ON")

                self.assertEqual(snapshot_rows(connection), before)
                self.assertEqual(
                    foreign_key_actions(connection, "InterventionTask")[
                        "sourceCandidateId"
                    ],
                    ("AutoInterventionCandidate", "CASCADE", "SET NULL"),
                )
                self.assertEqual(
                    foreign_key_actions(connection, "PublishLog")["taskId"],
                    ("InterventionTask", "CASCADE", "RESTRICT"),
                )
                self.assertEqual(
                    foreign_key_actions(connection, "PublishLog")[
                        "authorizationId"
                    ],
                    ("PublishAuthorization", "CASCADE", "SET NULL"),
                )
                action_column = next(
                    row
                    for row in connection.execute(
                        'PRAGMA table_info("PublishLog")'
                    ).fetchall()
                    if row[1] == "action"
                )
                self.assertEqual(action_column[4], "'publish'")
                partial_index_sql = connection.execute(
                    """
                    SELECT "sql" FROM "sqlite_master"
                    WHERE "type" = 'index'
                      AND "name" = 'InterventionTask_one_open_plan_per_post_key'
                    """
                ).fetchone()
                self.assertIsNotNone(partial_index_sql)
                self.assertIn("WHERE", partial_index_sql[0].upper())
                self.assertEqual(
                    connection.execute("PRAGMA integrity_check").fetchall(),
                    [("ok",)],
                )
                self.assertEqual(
                    connection.execute("PRAGMA foreign_key_check").fetchall(),
                    [],
                )
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(
                        'DELETE FROM "InterventionTask" WHERE "id" = ?',
                        ("fk-task",),
                    )
                connection.rollback()
                self.assertEqual(snapshot_rows(connection), before)
            finally:
                connection.close()

    def test_failure_before_commit_rolls_back_both_rebuilds(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fk-alignment-fail-") as temp_dir:
            connection = self.create_legacy_database(
                temp_dir,
                "failure.db",
            )
            try:
                before = snapshot_rows(connection)
                migration_sql = (
                    MIGRATIONS_ROOT / TARGET_MIGRATION / "migration.sql"
                ).read_text(encoding="utf-8")
                failing_sql = migration_sql.replace(
                    "COMMIT;",
                    "THIS_STATEMENT_MUST_FAIL;\nCOMMIT;",
                    1,
                )
                with self.assertRaises(sqlite3.DatabaseError):
                    connection.executescript(failing_sql)
                connection.rollback()
                connection.execute("PRAGMA foreign_keys=ON")

                self.assertEqual(snapshot_rows(connection), before)
                legacy_action = next(
                    row
                    for row in connection.execute(
                        'PRAGMA table_info("PublishLog")'
                    ).fetchall()
                    if row[1] == "action"
                )
                self.assertIsNone(legacy_action[4])
                self.assertEqual(
                    connection.execute("PRAGMA foreign_key_check").fetchall(),
                    [],
                )
            finally:
                connection.close()


if __name__ == "__main__":
    unittest.main()
