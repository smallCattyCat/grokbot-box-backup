import assert from "node:assert/strict";
import test from "node:test";
import {
  autonomySoakReadinessExitCode,
  runAutonomySoakReadinessCli
} from "../../scripts/autonomy-soak-readiness";
import type {
  AutonomySoakReadinessReceipt,
  AutonomySoakReadinessStatus
} from "../../lib/autonomy/soak-readiness";

function readiness(
  status: AutonomySoakReadinessStatus
): AutonomySoakReadinessReceipt {
  return {
    status,
    containsForumText: false
  } as AutonomySoakReadinessReceipt;
}

test("soak readiness CLI maps qualified, pending and blocked states", async () => {
  const cases = [
    ["qualified", 0],
    ["unknown", 2],
    ["qualifying", 2],
    ["blocked", 1]
  ] as const;

  for (const [status, expectedExitCode] of cases) {
    let output = "";
    const exitCode = await runAutonomySoakReadinessCli({
      loadReadiness: async () => readiness(status),
      write: (text) => {
        output += text;
      }
    });
    assert.equal(exitCode, expectedExitCode);
    assert.equal(autonomySoakReadinessExitCode(status), expectedExitCode);
    assert.equal(JSON.parse(output).status, status);
    assert.equal(output.endsWith("\n"), true);
  }
});

test("soak readiness CLI emits one redacted JSON error and exits 1", async () => {
  let output = "";
  const exitCode = await runAutonomySoakReadinessCli({
    loadReadiness: async () => {
      throw new Error("DATABASE_URL=SECRET_TOKEN C:\\private\\dev.db");
    },
    write: (text) => {
      output += text;
    }
  });
  const payload = JSON.parse(output) as {
    status: string;
    code: string;
    externalMutationAttempted: boolean;
    containsForumText: boolean;
  };

  assert.equal(exitCode, 1);
  assert.equal(payload.status, "error");
  assert.equal(payload.code, "autonomy_soak_readiness_unavailable");
  assert.equal(payload.externalMutationAttempted, false);
  assert.equal(payload.containsForumText, false);
  assert.doesNotMatch(output, /SECRET|DATABASE_URL|private|dev\.db/u);
  assert.equal(output.trim().split("\n").length, 1);
});
