import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  CourseOpportunityBriefReadError,
  getAnchoredCourseOpportunityBrief
} from "../../lib/workbench/operator-read-model";

const WORLD_AS_OF = new Date("2026-08-12T11:00:00.000Z");

function fakeDb(input: {
  invocationCourse?: string;
  snapshotCourse?: string;
  snapshotInvocation?: string;
  decisionCourse?: string;
  decisionWorldHash?: string;
  decisionCandidateSetHash?: string;
} = {}) {
  const calls: Array<{ model: string; args: unknown }> = [];
  const record = <T>(model: string, value: T) => async (args: unknown) => {
    calls.push({ model, args });
    return value;
  };
  const db = {
    autonomyCourseManifest: {
      findUnique: record("manifest", {
        alias: "safe-course",
        manifestHash: "manifest-current"
      })
    },
    scheduledInvocation: {
      findUnique: record("invocation", {
        id: "invocation-current",
        courseAlias: input.invocationCourse ?? "safe-course",
        manifestHash: "manifest-current"
      })
    },
    courseWorldSnapshot: {
      findUnique: record("snapshot", {
        id: "snapshot-current",
        invocationId: input.snapshotInvocation ?? "invocation-current",
        courseAlias: input.snapshotCourse ?? "safe-course",
        asOfAt: WORLD_AS_OF,
        worldHash: "world-current",
        coverageHash: "coverage-current"
      })
    },
    courseScanRun: {
      findUnique: record("scan", {
        invocationId: "invocation-current",
        courseAlias: "safe-course",
        status: "completed",
        coverageJson: JSON.stringify({
          containsForumText: false,
          uiStatus: "ready",
          courseShellDetected: true,
          categoryCount: 1,
          categoryCompletedCount: 1,
          pageRequestCount: 1,
          discoveredThreadCount: 1,
          completedDetailCount: 1,
          complete: true,
          observedEventCount: 6,
          incompleteCommentThreadCount: 0,
          failedTargetCount: 0,
          truncatedThreadListing: false,
          failureCodeCounts: {}
        }),
        coverageHash: "coverage-current",
        failedTargetCount: 0
      })
    },
    candidateSet: {
      findUnique: record("candidateSet", {
        invocationId: "invocation-current",
        snapshotId: "snapshot-current",
        candidateSetHash: "candidates-current",
        asOfAt: WORLD_AS_OF,
        candidateCount: 1
      })
    },
    autonomyDecision: {
      findMany: record("decisions", [
        {
          id: "decision-current",
          invocationId: "invocation-current",
          courseAlias: input.decisionCourse ?? "safe-course",
          decision: "draft",
          reasonCode: "draft_eligible",
          evidenceAsOf: new Date("2026-08-12T11:00:00.000Z"),
          worldHash: input.decisionWorldHash ?? "world-current",
          candidateSetHash:
            input.decisionCandidateSetHash ?? "candidates-current"
        }
      ])
    },
    autonomyIncident: {
      findMany: record("incidents", [])
    },
    proximalOutcome: {
      findMany: record("outcomes", [])
    },
    threadStateAtCutoff: {
      aggregate: record("supportGaps", {
        _count: { _all: 0 },
        _max: { supportGapHours: null }
      })
    }
  } as unknown as PrismaClient;
  return { db, calls };
}

const ANCHOR = {
  courseAlias: "safe-course",
  invocationId: "invocation-current",
  snapshotId: "snapshot-current"
};

test("anchored brief reads only the exact course, invocation, and snapshot", async () => {
  const { db, calls } = fakeDb();
  const brief = await getAnchoredCourseOpportunityBrief({
    anchor: ANCHOR,
    prisma: db,
    now: new Date("2026-08-12T12:00:00.000Z")
  });

  assert.equal(brief.status, "ready");
  assert.deepEqual(brief.anchor, {
    courseAlias: "safe-course",
    courseName: "当前课程",
    invocationId: "invocation-current",
    snapshotId: "snapshot-current",
    manifestHash: "manifest-current",
    worldHash: "world-current",
    coverageHash: "coverage-current",
    worldAsOf: "2026-08-12T11:00:00.000Z",
    evidenceAsOf: "2026-08-12T11:00:00.000Z"
  });
  assert.deepEqual(brief.items.map((item) => item.id), ["decision:decision-current"]);

  const decisionsCall = calls.find((call) => call.model === "decisions");
  const incidentsCall = calls.find((call) => call.model === "incidents");
  const outcomesCall = calls.find((call) => call.model === "outcomes");
  const supportCall = calls.find((call) => call.model === "supportGaps");
  assert.deepEqual(
    (decisionsCall?.args as { where: unknown }).where,
    { invocationId: "invocation-current" }
  );
  assert.deepEqual(
    (incidentsCall?.args as { where: unknown }).where,
    {
      invocationId: "invocation-current",
      status: { in: ["open", "acknowledged"] }
    }
  );
  assert.deepEqual(
    (outcomesCall?.args as { where: unknown }).where,
    {
      status: "pending",
      dueAt: { lte: new Date("2026-08-12T12:00:00.000Z") },
      decision: { is: { invocationId: "invocation-current" } }
    }
  );
  assert.equal(
    (supportCall?.args as { where: { snapshotId: string } }).where.snapshotId,
    "snapshot-current"
  );
  assert.equal(JSON.stringify(calls).includes("summaryJson"), false);
  assert.equal(JSON.stringify(calls).includes("decisionJson"), false);
});

test("anchored brief fails closed for cross-course and cross-snapshot decoys", async () => {
  for (const db of [
    fakeDb({ invocationCourse: "decoy-course" }).db,
    fakeDb({ snapshotCourse: "decoy-course" }).db,
    fakeDb({ snapshotInvocation: "invocation-decoy" }).db,
    fakeDb({ decisionCourse: "decoy-course" }).db,
    fakeDb({ decisionWorldHash: "world-decoy" }).db,
    fakeDb({ decisionCandidateSetHash: "candidates-decoy" }).db
  ]) {
    await assert.rejects(
      getAnchoredCourseOpportunityBrief({ anchor: ANCHOR, prisma: db }),
      (error: unknown) => {
        assert.equal(error instanceof CourseOpportunityBriefReadError, true);
        assert.equal(
          (error as CourseOpportunityBriefReadError).code,
          "BRIEF_ANCHOR_CONFLICT"
        );
        return true;
      }
    );
  }
});
