import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCourseOpportunityBrief,
  COURSE_OPPORTUNITY_BRIEF_SCHEMA_VERSION,
  type BuildCourseOpportunityBriefInput
} from "../../lib/workbench/course-opportunity-brief";

const WORLD_AS_OF = new Date("2026-08-12T11:00:00.000Z");
const CHECKED: BuildCourseOpportunityBriefInput["sourceChecks"] = {
  coverage: "checked",
  supportGaps: "checked",
  decisions: "checked",
  incidents: "checked",
  dueOutcomes: "checked"
};

function fixture(
  overrides: Partial<BuildCourseOpportunityBriefInput> = {}
): BuildCourseOpportunityBriefInput {
  return {
    anchor: {
      courseAlias: "safe-course",
      courseName: "安全课程",
      invocationId: "invocation-current",
      snapshotId: "snapshot-current",
      manifestHash: "manifest-current",
      worldHash: "world-current",
      coverageHash: "coverage-current",
      candidateSetHash: "candidates-current",
      worldAsOf: WORLD_AS_OF
    },
    coverage: {
      status: "complete",
      incompleteThreadCount: 0,
      failedTargetCount: 0
    },
    supportGaps: { matureCount: 0, longestOpenHours: null },
    sourceChecks: CHECKED,
    decisions: [],
    incidents: [],
    dueOutcomes: [],
    ...overrides
  };
}

function decision(input: {
  id: string;
  decision: string;
  evidenceAsOf: string;
  reasonCode?: string;
  worldHash?: string;
  candidateSetHash?: string;
  courseAlias?: string;
}): BuildCourseOpportunityBriefInput["decisions"][number] {
  return {
    id: input.id,
    decision: input.decision,
    reasonCode: input.reasonCode ?? "draft_eligible",
    evidenceAsOf: new Date(input.evidenceAsOf),
    worldHash: input.worldHash ?? "world-current",
    candidateSetHash: input.candidateSetHash ?? "candidates-current",
    courseAlias: input.courseAlias ?? "safe-course"
  };
}

test("brief fails closed with a visible boundary when no exact anchor is available", () => {
  const brief = buildCourseOpportunityBrief(fixture({ anchor: null }));

  assert.equal(brief.schemaVersion, COURSE_OPPORTUNITY_BRIEF_SCHEMA_VERSION);
  assert.equal(brief.status, "unavailable");
  assert.equal(brief.anchor, null);
  assert.equal(brief.items.length, 1);
  assert.equal(brief.items[0]?.kind, "boundary");
  assert.equal(brief.items[0]?.canHandoff, false);
  assert.equal(brief.summary.needsAttention, 1);
  assert.equal(brief.containsForumText, false);
  assert.equal(brief.containsIdentity, false);
});

test("brief emits no-action only after every evidence source was checked", () => {
  const brief = buildCourseOpportunityBrief(fixture());

  assert.equal(brief.status, "ready");
  assert.equal(brief.headline, "当前无需处理");
  assert.equal(brief.items[0]?.kind, "no_action");
  assert.equal(brief.items[0]?.contextRef, "snapshot:snapshot-current");
  assert.equal(brief.items[0]?.canHandoff, false);
  assert.match(
    brief.items[0]?.sourceHref ?? "",
    /\/autonomy\/world\?.*course=safe-course.*snapshot=snapshot-current/
  );

  const unchecked = buildCourseOpportunityBrief(
    fixture({
      sourceChecks: { ...CHECKED, incidents: "unavailable" }
    })
  );
  assert.equal(unchecked.items[0]?.kind, "boundary");
  assert.equal(unchecked.headline, "今天有 1 件值得看");
});

test("decision admission requires exact lineage and keeps only the latest valid decision", () => {
  const brief = buildCourseOpportunityBrief(
    fixture({
      decisions: [
        decision({
          id: "valid",
          decision: "draft",
          evidenceAsOf: "2026-08-12T11:00:00.000Z"
        }),
        decision({
          id: "post-snapshot-valid",
          decision: "wait",
          evidenceAsOf: "2026-08-12T11:00:00.001Z",
          reasonCode: "insufficient_admissible_evidence"
        }),
        decision({
          id: "wrong-world",
          decision: "yield",
          evidenceAsOf: "2026-08-12T10:59:00.000Z",
          worldHash: "world-decoy"
        }),
        decision({
          id: "wrong-candidates",
          decision: "abstain",
          evidenceAsOf: "2026-08-12T10:58:00.000Z",
          candidateSetHash: "candidates-decoy"
        }),
        decision({
          id: "wrong-course",
          decision: "yield",
          evidenceAsOf: "2026-08-12T10:57:00.000Z",
          courseAlias: "decoy-course"
        })
      ]
    })
  );

  assert.deepEqual(brief.items.map((item) => item.id), ["decision:post-snapshot-valid"]);
  assert.equal(brief.anchor?.evidenceAsOf, "2026-08-12T11:00:00.001Z");
  assert.equal(JSON.stringify(brief).includes("wrong-world"), false);
  assert.equal(JSON.stringify(brief).includes("wrong-candidates"), false);
  assert.equal(JSON.stringify(brief).includes("wrong-course"), false);
});

test("brief ordering is deterministic, one-per-kind, and capped at five", () => {
  const input = fixture({
    coverage: {
      status: "partial",
      incompleteThreadCount: 2,
      failedTargetCount: 1
    },
    supportGaps: { matureCount: 4, longestOpenHours: 101 },
    incidents: [
      {
        id: "incident-old",
        severity: "high",
        code: "coverage_unavailable",
        openedAt: new Date("2026-08-12T10:00:00.000Z"),
        evidenceHash: "incident-old-hash",
        courseAlias: "safe-course",
        invocationId: "invocation-current"
      },
      {
        id: "incident-new",
        severity: "high",
        code: "event_version_conflict",
        openedAt: new Date("2026-08-12T10:59:00.000Z"),
        evidenceHash: "incident-new-hash",
        courseAlias: "safe-course",
        invocationId: "invocation-current"
      }
    ],
    dueOutcomes: [
      {
        id: "outcome-a",
        observationWindow: "R24",
        dueAt: new Date("2026-08-12T09:00:00.000Z"),
        decisionId: "decision-a",
        courseAlias: "safe-course",
        invocationId: "invocation-current",
        worldHash: "world-current",
        candidateSetHash: "candidates-current"
      }
    ],
    decisions: [
      decision({ id: "draft-b", decision: "draft", evidenceAsOf: "2026-08-12T10:58:00.000Z" }),
      decision({ id: "draft-a", decision: "draft", evidenceAsOf: "2026-08-12T10:58:00.000Z" }),
      decision({ id: "wait-a", decision: "wait", evidenceAsOf: "2026-08-12T10:57:00.000Z" }),
      decision({ id: "yield-a", decision: "yield", evidenceAsOf: "2026-08-12T10:56:00.000Z" })
    ]
  });

  const first = buildCourseOpportunityBrief(input);
  const second = buildCourseOpportunityBrief({
    ...input,
    decisions: [...input.decisions].reverse(),
    incidents: [...input.incidents].reverse()
  });

  assert.equal(first.items.length, 5);
  assert.deepEqual(first.items.map((item) => item.id), [
    "coverage:snapshot-current",
    "incident:incident-new",
    "support-gap:snapshot-current",
    "decision:draft-a",
    "outcome:outcome-a"
  ]);
  assert.deepEqual(second, first);
  assert.equal(first.items.filter((item) => item.kind === "intervention_opportunity").length, 1);
});

test("YIELD remains a first-class safe boundary and is never handed off", () => {
  const brief = buildCourseOpportunityBrief(
    fixture({
      decisions: [
        decision({
          id: "yield-a",
          decision: "yield",
          evidenceAsOf: "2026-08-12T10:30:00.000Z",
          reasonCode: "original_author_return"
        })
      ]
    })
  );

  assert.equal(brief.items[0]?.kind, "yield");
  assert.equal(brief.items[0]?.stateLabel, "让位");
  assert.equal(brief.items[0]?.canHandoff, false);
  assert.equal(brief.items[0]?.evidenceCode, "原作者已经返回");
  assert.equal(brief.summary.canYield, 1);
  assert.equal(brief.summary.needsAttention, 0);
});

test("output carries privacy sentinels and maps raw internal reason codes to safe labels", () => {
  const input = fixture({
    decisions: [
      decision({
        id: "safe",
        decision: "wait",
        evidenceAsOf: "2026-08-12T10:00:00.000Z",
        reasonCode: "INTERNAL_UNKNOWN_REASON_SENTINEL"
      })
    ]
  }) as BuildCourseOpportunityBriefInput & {
    forumText: string;
    learnerIdentity: string;
  };
  input.forumText = "SENSITIVE_FORUM_BODY_SENTINEL";
  input.learnerIdentity = "SENSITIVE_IDENTITY_SENTINEL";

  const brief = buildCourseOpportunityBrief(input);
  const serialized = JSON.stringify(brief);

  assert.equal(brief.items[0]?.evidenceCode, "按当前证据保持克制");
  assert.equal(brief.items.every((item) => item.containsForumText === false), true);
  assert.equal(brief.items.every((item) => item.containsIdentity === false), true);
  assert.equal(serialized.includes("INTERNAL_UNKNOWN_REASON_SENTINEL"), false);
  assert.equal(serialized.includes("SENSITIVE_FORUM_BODY_SENTINEL"), false);
  assert.equal(serialized.includes("SENSITIVE_IDENTITY_SENTINEL"), false);
});
