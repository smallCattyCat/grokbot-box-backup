import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AutonomyCandidate } from "../../lib/autonomy/candidate-set";
import {
  computeBoundRoleEvidenceHash,
  resolveServerRoleEvidence
} from "../../lib/autonomy/server-evidence";
import type { LiveUiObservationReceipt } from "../../lib/ui-agent/live-observation";
import { readBudgetUsage } from "../../lib/autonomy/budget-reservation";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("服务端角色证据必须绑定课程、目标、作者、版本和有效期", () => {
  const secret = Buffer.alloc(32, 21);
  const assessedAt = "2026-07-10T12:00:00.000Z";
  const expiresAt = "2026-07-10T12:05:00.000Z";
  const candidate = {
    threadKey: hash("role-thread"),
    authorKey: hash("role-author"),
    targetVersionHash: hash("role-target-version")
  } as AutonomyCandidate;
  const observation = {
    courseKey: hash("role-course"),
    threadKey: candidate.threadKey,
    authorKey: candidate.authorKey,
    authorRole: "learner",
    evidenceAsOf: assessedAt,
    authorRoleEvidenceExpiresAt: expiresAt
  } as LiveUiObservationReceipt;
  observation.authorRoleEvidenceHash =
    computeBoundRoleEvidenceHash({
      secret,
      courseKey: observation.courseKey,
      threadKey: candidate.threadKey,
      authorKey: candidate.authorKey!,
      role: "learner",
      evidenceAsOf: assessedAt,
      expiresAt,
      targetVersionHash: candidate.targetVersionHash
    });

  assert.equal(
    resolveServerRoleEvidence({
      observation,
      candidate,
      assessedAt,
      secret
    }).status,
    "verified"
  );
  assert.deepEqual(
    resolveServerRoleEvidence({
      observation: {
        ...observation,
        authorRoleEvidenceHash: hash("self-certified")
      },
      candidate,
      assessedAt,
      secret
    }).role,
    "unknown"
  );
  assert.deepEqual(
    resolveServerRoleEvidence({
      observation,
      candidate,
      assessedAt: expiresAt,
      secret
    }).role,
    "unknown"
  );
  assert.equal(
    resolveServerRoleEvidence({
      observation,
      candidate,
      assessedAt,
      secret: Buffer.alloc(32, 22)
    }).role,
    "unknown",
    "普通调用方不知道服务端 HMAC 密钥时不能自签角色"
  );
  for (const changedCandidate of [
    { ...candidate, threadKey: hash("different-thread") },
    { ...candidate, authorKey: hash("different-author") },
    {
      ...candidate,
      targetVersionHash: hash("different-target-version")
    }
  ]) {
    assert.equal(
      resolveServerRoleEvidence({
        observation,
        candidate: changedCandidate,
        assessedAt,
        secret
      }).role,
      "unknown"
    );
  }
});

test("真实触达冷却只读取 as-of 内 confirmed publish，不把 SHADOW 草稿当触达", async () => {
  const asOf = new Date("2026-07-10T12:00:00.000Z");
  const confirmedAt = new Date("2026-07-09T09:30:00.000Z");
  let reservationRead = 0;
  let attemptRead = 0;
  const prisma = {
    budgetReservation: {
      findMany: async () => {
        reservationRead += 1;
        return [];
      }
    },
    autonomyDecision: {
      findMany: async () => [
        {
          id: "confirmed-decision",
          invocationId: "prior-invocation",
          authorKey: "author-key"
        },
        {
          id: "shadow-only-decision",
          invocationId: "shadow-invocation",
          authorKey: "author-key"
        }
      ]
    },
    executionAttempt: {
      findMany: async () => {
        attemptRead += 1;
        return attemptRead === 1
          ? [{ decisionId: "confirmed-decision" }]
          : [
              {
                decisionId: "confirmed-decision",
                finishedAt: confirmedAt
              }
            ];
      }
    }
  };

  const usage = await readBudgetUsage({
    prisma: prisma as never,
    courseAlias: "course-a",
    invocationId: "current-invocation",
    authorKey: "author-key",
    now: asOf,
    legacyWorkloadCost: 1
  });

  assert.equal(reservationRead, 3);
  assert.equal(attemptRead, 2);
  assert.equal(usage.authorTouches30d, 1);
  assert.equal(usage.lastSystemTouchAt?.toISOString(), confirmedAt.toISOString());
});
