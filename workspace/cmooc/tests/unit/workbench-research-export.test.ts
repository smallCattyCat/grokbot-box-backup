import assert from "node:assert/strict";
import test from "node:test";
import { canonicalProtocolHash } from "../../lib/facilitation-protocol/canonical-hash";
import {
  buildCourseEvidenceWorkspace,
  buildCourseResearchExport,
  COURSE_EVIDENCE_WORKSPACE_SCHEMA_VERSION,
  COURSE_RESEARCH_EXPORT_SCHEMA_VERSION,
  unavailableCourseEvidenceWorkspace,
  type BuildCourseEvidenceWorkspaceInput
} from "../../lib/workbench/course-evidence-workspace";

function readyInput(): BuildCourseEvidenceWorkspaceInput {
  return {
    anchor: {
      courseAlias: "safe-course",
      invocationId: "invocation-current",
      snapshotId: "snapshot-current"
    },
    current: {
      id: "snapshot-current",
      courseAlias: "safe-course",
      invocationId: "invocation-current",
      asOfAt: new Date("2026-08-12T11:00:00.000Z"),
      eventCount: 20,
      threadCount: 10,
      actorCount: 8,
      edgeCount: 7,
      openGapCount: 4
    },
    baseline: {
      id: "snapshot-baseline",
      courseAlias: "safe-course",
      invocationId: "invocation-baseline",
      asOfAt: new Date("2026-08-12T10:00:00.000Z"),
      eventCount: 12,
      threadCount: 7,
      actorCount: 6,
      edgeCount: 4,
      openGapCount: 2
    },
    coverage: {
      status: "complete",
      discoveredThreadCount: 10,
      completedDetailCount: 8,
      observedEventCount: 16,
      incompleteThreadCount: 2,
      failedTargetCount: 0
    },
    qualification: {
      answerability: "qualified",
      formatValid: true,
      evidenceLegal: true,
      relationCorrect: true,
      temporalLegal: true,
      supportResolution: "resolved"
    },
    matureSupportGapCount: 4,
    graph: { status: "complete" }
  };
}

test("research export has one versioned aggregate schema and explicit reconstruction provenance", () => {
  const workspace = buildCourseEvidenceWorkspace(readyInput());
  const result = buildCourseResearchExport(workspace);

  assert.deepEqual(Object.keys(result.document), [
    "schemaVersion",
    "generatedFrom",
    "anchor",
    "waterfall",
    "change",
    "portrait",
    "limitations",
    "reconstruction",
    "containsForumText",
    "containsIdentity"
  ]);
  assert.equal(result.document.schemaVersion, COURSE_RESEARCH_EXPORT_SCHEMA_VERSION);
  assert.equal(result.document.generatedFrom, "persisted_aggregate_evidence");
  assert.deepEqual(result.document.reconstruction, {
    deterministic: true,
    sourceSchemaVersion: COURSE_EVIDENCE_WORKSPACE_SCHEMA_VERSION
  });
  assert.equal(result.json.endsWith("\n"), true);
  assert.equal(result.sha256.length, 64);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(result.json), result.document);
});

test("research export is byte deterministic and its digest changes with aggregate evidence", () => {
  const workspace = buildCourseEvidenceWorkspace(readyInput());
  const first = buildCourseResearchExport(workspace);
  const second = buildCourseResearchExport(workspace);
  const changed = buildCourseResearchExport(
    buildCourseEvidenceWorkspace({
      ...readyInput(),
      current: { ...readyInput().current, eventCount: 21 }
    })
  );

  assert.equal(first.json, second.json);
  assert.equal(first.sha256, second.sha256);
  assert.notEqual(first.json, changed.json);
  assert.notEqual(first.sha256, changed.sha256);
  assert.equal(
    first.sha256,
    canonicalProtocolHash(COURSE_RESEARCH_EXPORT_SCHEMA_VERSION, {
      schemaVersion: COURSE_RESEARCH_EXPORT_SCHEMA_VERSION,
      exportJson: first.json
    })
  );
});

test("research export keeps privacy sentinels false and contains no row-level evidence identifiers", () => {
  const result = buildCourseResearchExport(
    buildCourseEvidenceWorkspace(readyInput())
  );
  const document = result.document as unknown as Record<string, unknown>;
  const forbiddenKeys: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (
        /^(?:actor|learner|author|thread|event|decision)(?:id|key|ref)s?$/iu.test(key) ||
        /^(?:nodes|edges|rows|forumText|forumBody|rawContent|identity)$/iu.test(key)
      ) {
        forbiddenKeys.push(key);
      }
      visit(child);
    }
  };
  visit(document);

  assert.equal(result.document.containsForumText, false);
  assert.equal(result.document.containsIdentity, false);
  assert.deepEqual(forbiddenKeys, []);
  assert.equal(result.json.includes("SECRET_FORUM_BODY_SENTINEL"), false);
  assert.equal(result.json.includes("SECRET_LEARNER_IDENTITY_SENTINEL"), false);
  assert.equal(result.json.includes("DATABASE_URL"), false);
  assert.equal(result.json.includes("Cookie"), false);
});

test("research export fails closed when aggregate evidence is unavailable", () => {
  assert.throws(
    () => buildCourseResearchExport(unavailableCourseEvidenceWorkspace()),
    /RESEARCH_EXPORT_EVIDENCE_UNAVAILABLE/
  );
});
