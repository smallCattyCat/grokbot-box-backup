import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCourseEvidenceWorkspace,
  buildEvidenceWaterfall,
  type BuildCourseEvidenceWorkspaceInput,
  type EvidenceQualificationInput
} from "../../lib/workbench/course-evidence-workspace";

const CURRENT_AS_OF = new Date("2026-08-12T11:00:00.000Z");
const BASELINE_AS_OF = new Date("2026-08-12T10:00:00.000Z");

const QUALIFIED: EvidenceQualificationInput = {
  answerability: "qualified",
  formatValid: true,
  evidenceLegal: true,
  relationCorrect: true,
  temporalLegal: true,
  supportResolution: "resolved"
};

function input(
  overrides: Partial<BuildCourseEvidenceWorkspaceInput> = {}
): BuildCourseEvidenceWorkspaceInput {
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
      asOfAt: CURRENT_AS_OF,
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
      asOfAt: BASELINE_AS_OF,
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
    qualification: QUALIFIED,
    matureSupportGapCount: 4,
    graph: { status: "complete" },
    ...overrides
  };
}

test("evidence waterfall has one fixed order and qualifies only after all six stages pass", () => {
  const waterfall = buildEvidenceWaterfall(QUALIFIED);

  assert.deepEqual(
    waterfall.stages.map((stage) => stage.key),
    ["label", "format", "evidence", "relation", "time", "support"]
  );
  assert.deepEqual(
    waterfall.stages.map((stage) => stage.state),
    ["pass", "pass", "pass", "pass", "pass", "pass"]
  );
  assert.equal(waterfall.status, "qualified");
  assert.equal(waterfall.stopAt, null);
  assert.deepEqual(waterfall.missing, []);
});

test("evidence waterfall stops at the first failure and marks every later stage not evaluated", () => {
  const waterfall = buildEvidenceWaterfall({
    ...QUALIFIED,
    evidenceLegal: false,
    relationCorrect: false,
    temporalLegal: null,
    supportResolution: "conflicting"
  });

  assert.equal(waterfall.status, "stopped");
  assert.equal(waterfall.stopAt, "证据");
  assert.deepEqual(
    waterfall.stages.map((stage) => stage.state),
    ["pass", "pass", "fail", "not_evaluated", "not_evaluated", "not_evaluated"]
  );
  assert.equal(waterfall.missing.length, 1);
  assert.match(waterfall.stages[3]?.summary ?? "", /未继续判定/u);
});

test("UNKNOWN is an honest first stop rather than a pass or a fabricated downstream verdict", () => {
  const waterfall = buildEvidenceWaterfall({
    ...QUALIFIED,
    formatValid: null,
    evidenceLegal: false
  });

  assert.equal(waterfall.status, "unknown");
  assert.equal(waterfall.stopAt, "格式");
  assert.deepEqual(
    waterfall.stages.map((stage) => stage.state),
    ["pass", "unknown", "not_evaluated", "not_evaluated", "not_evaluated", "not_evaluated"]
  );
  assert.doesNotMatch(waterfall.headline, /通过/u);
});

test("missing persisted qualification is unavailable and does not evaluate inapplicable later stages", () => {
  const waterfall = buildEvidenceWaterfall(null);

  assert.equal(waterfall.status, "unavailable");
  assert.equal(waterfall.stages[0]?.state, "unknown");
  assert.deepEqual(
    waterfall.stages.slice(1).map((stage) => stage.state),
    ["not_evaluated", "not_evaluated", "not_evaluated", "not_evaluated", "not_evaluated"]
  );
});

test("workspace rejects a non-earlier, same-snapshot, or cross-course baseline", () => {
  for (const baseline of [
    { ...input().baseline!, courseAlias: "decoy-course" },
    { ...input().baseline!, id: "snapshot-current" },
    { ...input().baseline!, asOfAt: CURRENT_AS_OF },
    {
      ...input().baseline!,
      asOfAt: new Date("2026-08-12T12:00:00.000Z")
    }
  ]) {
    assert.throws(
      () => buildCourseEvidenceWorkspace(input({ baseline })),
      /EVIDENCE_WORKSPACE_ANCHOR_CONFLICT/
    );
  }
});

test("partial or unverifiable baseline coverage keeps change language at the visible lower bound", () => {
  for (const baselineCoverageStatus of ["partial", "unavailable"] as const) {
    const workspace = buildCourseEvidenceWorkspace(input({ baselineCoverageStatus }));
    assert.equal(workspace.change.status, "lower_bound");
    assert.match(workspace.change.summary, /可见下界/u);
    assert.doesNotMatch(workspace.change.summary, /可与.*比较/u);
  }
});

test("no eligible earlier baseline stays unavailable and never fabricates a zero delta", () => {
  const workspace = buildCourseEvidenceWorkspace(input({ baseline: null }));

  assert.equal(workspace.change.status, "unavailable");
  assert.equal(workspace.anchor?.baselineSnapshotId, null);
  assert.equal(workspace.change.baselineAsOf, null);
  assert.equal(workspace.change.metrics.every((metric) => metric.before === null), true);
  assert.equal(workspace.change.metrics.every((metric) => metric.delta === null), true);
  assert.match(workspace.change.summary, /不生成伪变化/u);
});

test("course portrait exposes both support denominators, unsupported mass, and an identification range", () => {
  const portrait = buildCourseEvidenceWorkspace(input()).portrait;
  const compatibleRange = portrait.compatibleRange;

  assert.equal(portrait.status, "supported");
  assert.equal(portrait.completeUnitCount, 8);
  assert.equal(portrait.totalUnitCount, 10);
  assert.equal(portrait.completeUnitShare, 0.8);
  assert.equal(portrait.observedEventCount, 16);
  assert.equal(portrait.declaredEventCount, 20);
  assert.equal(portrait.observedEventShare, 0.8);
  assert.equal(portrait.unsupportedEventShare, 0.2);
  assert.deepEqual(
    compatibleRange && [compatibleRange.lower, compatibleRange.upper],
    [0.4, 0.6]
  );
  assert.match(portrait.limitation, /(?:识别|相容).*区间/u);
  assert.match(portrait.limitation, /非.*置信区间/u);
});

test("zero denominators stay null instead of becoming zero, complete, NaN, or Infinity", () => {
  const workspace = buildCourseEvidenceWorkspace(
    input({
      current: {
        ...input().current,
        eventCount: 0
      },
      coverage: {
        ...input().coverage,
        discoveredThreadCount: 0,
        completedDetailCount: 0,
        observedEventCount: 0,
        incompleteThreadCount: 0
      },
      matureSupportGapCount: 0
    })
  );
  const compatibleRange = workspace.portrait.compatibleRange;

  assert.equal(workspace.portrait.completeUnitShare, null);
  assert.equal(workspace.portrait.observedEventShare, null);
  assert.equal(workspace.portrait.unsupportedEventShare, null);
  assert.equal(compatibleRange, null);
  assert.equal(JSON.stringify(workspace).includes("NaN"), false);
  assert.equal(JSON.stringify(workspace).includes("Infinity"), false);
});

test("partial coverage and censored graph are lower bounds while unavailable evidence stays unavailable", () => {
  const partial = buildCourseEvidenceWorkspace(
    input({ coverage: { ...input().coverage, status: "partial" } })
  );
  const censored = buildCourseEvidenceWorkspace(
    input({ graph: { status: "censored" } })
  );
  const unavailable = buildCourseEvidenceWorkspace(
    input({ graph: { status: "unavailable" } })
  );

  assert.equal(partial.change.status, "lower_bound");
  assert.equal(partial.portrait.status, "lower_bound");
  assert.equal(censored.portrait.status, "lower_bound");
  assert.equal(censored.portrait.interactionCoverage, "lower_bound");
  assert.equal(unavailable.portrait.status, "unavailable");
  assert.equal(unavailable.portrait.interactionCoverage, "unavailable");
});
