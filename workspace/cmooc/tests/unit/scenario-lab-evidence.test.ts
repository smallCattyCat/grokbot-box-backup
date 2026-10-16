import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildDeterministicP3aScenarioReport } from "../../lib/scenario-lab/deterministic-runtime";
import { readP3aScenarioEvidence } from "../../lib/scenario-lab/p3a-evidence-reader";

const formalRoot = process.env.LOCALAPPDATA
  ? join(
      process.env.LOCALAPPDATA,
      "cmooc-research",
      "p3a",
      "decision-snapshot-v1"
    )
  : "";

test(
  "正式 P3A 工件形成无正文、无身份、无行级键的 CourseWorld 报告",
  { skip: !formalRoot || !existsSync(join(formalRoot, "manifest.json")) },
  async () => {
    const { evidence, replayResults } = await readP3aScenarioEvidence({
      inputDirectory: formalRoot
    });
    assert.deepEqual(evidence.counts, {
      snapshotCount: 2_702,
      ineligibleOrAnsweredAtDecisionCount: 2_085,
      eligibleUnansweredCount: 617,
      organicExternalResponseInWindowCount: 217,
      supportGapAtHorizonCount: 400
    });
    assert.deepEqual(evidence.decisionCalendarYearCounts, [
      { year: 2025, count: 2_604 },
      { year: 2026, count: 98 }
    ]);
    assert.equal(evidence.clock.decisionLagHours, 22);
    assert.equal(evidence.clock.outcomeEndHours, 86);
    assert.equal(evidence.clock.outcomeWindowHours, 64);
    assert.deepEqual(
      replayResults.map((item) => [
        item.dailyBudgetK,
        item.selectedCount,
        item.withdrawnBeforeSelectionCount,
        item.expiredUnselectedCount
      ]),
      [
        [1, 71, 11, 535],
        [3, 167, 10, 440],
        [5, 238, 8, 371]
      ]
    );

    const report = buildDeterministicP3aScenarioReport(
      evidence,
      replayResults
    );
    const forbiddenKeys = new Set([
      "snapshotKey",
      "threadKey",
      "courseKey",
      "authorKey",
      "snapshot_key",
      "thread_key",
      "course_key",
      "author_key",
      "forumText",
      "inputDirectory",
      "localPath"
    ]);
    function visit(value: unknown): void {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        assert.equal(forbiddenKeys.has(key), false, `unexpected key: ${key}`);
        visit(child);
      }
    }
    visit(report);
    assert.match(report.reportHash, /^[a-f0-9]{64}$/u);
    assert.match(report.receipt.receiptHash, /^[a-f0-9]{64}$/u);
  }
);
