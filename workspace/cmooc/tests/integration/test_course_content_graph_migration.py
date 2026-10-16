from __future__ import annotations

import hashlib
import sqlite3
import tempfile
import unittest
from pathlib import Path


SOURCE_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_ROOT = SOURCE_ROOT / "prisma" / "migrations"
GRAPH_V2_MIGRATION = "20260730030000_add_course_content_graph_v2"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def apply_migrations_before_graph_v2(
    connection: sqlite3.Connection,
) -> None:
    migration_dirs = sorted(
        path
        for path in MIGRATIONS_ROOT.iterdir()
        if path.is_dir() and path.name < GRAPH_V2_MIGRATION
    )
    for migration_dir in migration_dirs:
        migration_sql = migration_dir / "migration.sql"
        connection.executescript(
            migration_sql.read_text(encoding="utf-8")
        )


class CourseContentGraphMigrationTest(unittest.TestCase):
    def test_graph_v2_migrates_legacy_world_without_data_loss(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(
            prefix="graph-v2-migration-"
        ) as temp_dir:
            database_path = Path(temp_dir) / "legacy.db"
            connection = sqlite3.connect(database_path)
            try:
                connection.execute("PRAGMA foreign_keys = ON")
                apply_migrations_before_graph_v2(connection)

                observed_at = "2026-07-05T00:00:00.000Z"
                course_alias = "synthetic-legacy-course"
                manifest_hash = digest("synthetic-manifest")
                invocation_id = "synthetic-legacy-invocation"
                world_snapshot_id = "synthetic-legacy-world"
                world_hash = digest("synthetic-world-state")
                connection.execute(
                    """
                    INSERT INTO "AutonomyCourseManifest" (
                        "alias",
                        "manifestHash",
                        "platformId",
                        "platformCourseRefHash",
                        "canonicalLocatorHash",
                        "identityKeyFingerprint",
                        "allowedOrigin",
                        "timeZone",
                        "defaultMode",
                        "policyVersion",
                        "enabled",
                        "realPublishEnabled",
                        "createdAt",
                        "updatedAt"
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        course_alias,
                        manifest_hash,
                        "synthetic.test",
                        digest("synthetic-course-ref"),
                        digest("synthetic-locator"),
                        digest("synthetic-identity-key"),
                        "https://example.test",
                        "UTC",
                        "SHADOW",
                        "graph-v2-migration-test-v1",
                        1,
                        0,
                        observed_at,
                        observed_at,
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO "ScheduledInvocation" (
                        "id",
                        "invocationKey",
                        "courseAlias",
                        "manifestHash",
                        "scheduledFor",
                        "mode",
                        "status",
                        "phase",
                        "attempt",
                        "createdAt",
                        "updatedAt"
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        invocation_id,
                        digest("synthetic-invocation-key"),
                        course_alias,
                        manifest_hash,
                        observed_at,
                        "SHADOW",
                        "succeeded",
                        "completed",
                        1,
                        observed_at,
                        observed_at,
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO "CourseWorldSnapshot" (
                        "id",
                        "invocationId",
                        "courseAlias",
                        "asOfAt",
                        "eventSetHash",
                        "worldHash",
                        "graphHash",
                        "coverageHash",
                        "eventCount",
                        "threadCount",
                        "actorCount",
                        "edgeCount",
                        "openGapCount",
                        "stateJson",
                        "createdAt"
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        world_snapshot_id,
                        invocation_id,
                        course_alias,
                        observed_at,
                        digest("synthetic-event-set"),
                        world_hash,
                        digest("synthetic-graph-v1"),
                        digest("synthetic-coverage"),
                        2,
                        1,
                        2,
                        1,
                        0,
                        (
                            '{"schemaVersion":"course-event-world.v1",'
                            '"containsForumText":false}'
                        ),
                        observed_at,
                    ),
                )
                connection.commit()

                legacy_row = connection.execute(
                    """
                    SELECT "id", "invocationId", "courseAlias", "worldHash"
                    FROM "CourseWorldSnapshot"
                    WHERE "id" = ?
                    """,
                    (world_snapshot_id,),
                ).fetchone()

                graph_migration = (
                    MIGRATIONS_ROOT
                    / GRAPH_V2_MIGRATION
                    / "migration.sql"
                )
                connection.executescript(
                    graph_migration.read_text(encoding="utf-8")
                )
                connection.execute("PRAGMA foreign_keys = ON")

                self.assertEqual(
                    connection.execute(
                        """
                        SELECT "id", "invocationId", "courseAlias", "worldHash"
                        FROM "CourseWorldSnapshot"
                        WHERE "id" = ?
                        """,
                        (world_snapshot_id,),
                    ).fetchone(),
                    legacy_row,
                )

                expected_tables = {
                    "CourseStructureFact",
                    "CourseStructureFactObservation",
                    "CourseContentGraphSnapshot",
                    "CourseGraphNodeProjection",
                    "CourseGraphEdgeProjection",
                    "LearnerNetworkPositionAtCutoff",
                }
                created_tables = {
                    row[0]
                    for row in connection.execute(
                        """
                        SELECT "name"
                        FROM "sqlite_master"
                        WHERE "type" = 'table'
                        """
                    ).fetchall()
                }
                self.assertTrue(
                    expected_tables.issubset(created_tables)
                )

                structure_columns = {
                    row[1]: row
                    for row in connection.execute(
                        'PRAGMA table_info("CourseStructureFact")'
                    ).fetchall()
                }
                self.assertIn("courseKey", structure_columns)
                self.assertEqual(
                    structure_columns["courseKey"][3],
                    1,
                    "courseKey 必须是不可为空的课程隔离键",
                )

                unique_indexes = [
                    row[1]
                    for row in connection.execute(
                        (
                            'PRAGMA index_list('
                            '"CourseContentGraphSnapshot")'
                        )
                    ).fetchall()
                    if row[2] == 1
                ]
                unique_column_sets = {
                    tuple(
                        row[2]
                        for row in connection.execute(
                            f'PRAGMA index_info("{index_name}")'
                        ).fetchall()
                    )
                    for index_name in unique_indexes
                }
                self.assertIn(
                    ("worldSnapshotId", "schemaVersion"),
                    unique_column_sets,
                )

                course_key = digest("synthetic-course-key")
                connection.execute(
                    """
                    INSERT INTO "CourseStructureFact" (
                        "id",
                        "courseAlias",
                        "courseKey",
                        "factKey",
                        "factIdentityKey",
                        "factKind",
                        "subjectKey",
                        "subjectKind",
                        "revisionHash",
                        "attributesJson",
                        "legalityStatus",
                        "containsForumText",
                        "createdAt"
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "synthetic-structure-fact",
                        course_alias,
                        course_key,
                        digest("synthetic-structure-fact"),
                        digest("synthetic-structure-identity"),
                        "node",
                        course_key,
                        "course",
                        digest("synthetic-structure-revision"),
                        '{"source":"synthetic_manifest"}',
                        "admissible",
                        0,
                        observed_at,
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO "CourseContentGraphSnapshot" (
                        "id",
                        "worldSnapshotId",
                        "courseAlias",
                        "asOfAt",
                        "schemaVersion",
                        "structureFactSetHash",
                        "nodeSetHash",
                        "edgeSetHash",
                        "contentGraphHash",
                        "coverageHash",
                        "coverageStatus",
                        "roleRegistryStatus",
                        "nodeCount",
                        "edgeCount",
                        "learnerNodeCount",
                        "stateJson",
                        "createdAt"
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "synthetic-graph-v2-snapshot",
                        world_snapshot_id,
                        course_alias,
                        observed_at,
                        "course-content-graph.v2",
                        digest("synthetic-structure-facts"),
                        digest("synthetic-node-set"),
                        digest("synthetic-edge-set"),
                        digest("synthetic-content-graph"),
                        digest("synthetic-coverage"),
                        "complete",
                        "complete",
                        0,
                        0,
                        0,
                        (
                            '{"schemaVersion":"course-content-graph.v2",'
                            '"containsForumText":false}'
                        ),
                        observed_at,
                    ),
                )
                connection.commit()

                self.assertEqual(
                    connection.execute(
                        """
                        SELECT "worldSnapshotId"
                        FROM "CourseContentGraphSnapshot"
                        WHERE "id" = ?
                        """,
                        ("synthetic-graph-v2-snapshot",),
                    ).fetchone(),
                    (world_snapshot_id,),
                )
                self.assertEqual(
                    connection.execute(
                        """
                        SELECT "courseKey"
                        FROM "CourseStructureFact"
                        WHERE "id" = ?
                        """,
                        ("synthetic-structure-fact",),
                    ).fetchone(),
                    (course_key,),
                )
                self.assertEqual(
                    connection.execute(
                        "PRAGMA foreign_key_check"
                    ).fetchall(),
                    [],
                )
            finally:
                connection.close()


if __name__ == "__main__":
    unittest.main()
