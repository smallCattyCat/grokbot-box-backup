import assert from "node:assert/strict";
import { test } from "node:test";
import { hashArtifactSelection } from "../../lib/workbench/artifact-selection-store";

const BASE = Object.freeze({
  id: "selection-safe-001",
  taskId: "task-safe-001",
  runId: "run-safe-001",
  artifactId: "artifact-safe-001",
  versionId: "artifact-version-id-safe-001",
  versionRef: "artifact-version:artifact-version-id-safe-001",
  version: 1,
  contentHash: "a".repeat(64),
  draftBodyHash: "b".repeat(64),
  verificationId: "verification-safe-001",
  generation: 1,
  selectedAt: new Date("2026-08-13T20:00:00.000Z")
});

test("artifact selection hash is deterministic and binds every CAS/version field", () => {
  const baseline = hashArtifactSelection(BASE);
  assert.match(baseline, /^[a-f0-9]{64}$/u);
  assert.equal(hashArtifactSelection({ ...BASE }), baseline);

  const variants = [
    { runId: "run-safe-002" },
    { versionId: "artifact-version-id-safe-002", versionRef: "artifact-version:artifact-version-id-safe-002" },
    { contentHash: "c".repeat(64) },
    { draftBodyHash: "d".repeat(64) },
    { verificationId: "verification-safe-002" },
    { generation: 2 },
    { selectedAt: new Date("2026-08-13T20:00:01.000Z") }
  ] as const;
  for (const variant of variants) {
    assert.notEqual(hashArtifactSelection({ ...BASE, ...variant }), baseline);
  }
});
