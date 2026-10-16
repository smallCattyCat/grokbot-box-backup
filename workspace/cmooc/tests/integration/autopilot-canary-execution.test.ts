import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "../../lib/facilitation-protocol";
import {
  AUTONOMY_POLICY_SCHEMA_VERSION,
  registerCourseAutonomyPolicy
} from "../../lib/autonomy/autonomy-policy";
import {
  AUTOPILOT_CANARY_DEFAULT_ENABLED,
  runAutopilotCanaryExecution,
  verifyAutopilotCanaryTerminalReceipt
} from "../../lib/autonomy/autopilot-canary-execution";
import {
  claimExecutionPermit,
  issueExecutionPermit
} from "../../lib/autonomy/execution-permit";

const TRANSIENT_BODY =
  "AUTOPILOT_CANARY_TRANSIENT_BODY_MUST_NOT_PERSIST_OR_RETURN";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type TestPrisma = (typeof import("../../lib/db"))["prisma"];

type Fixture = {
  courseAlias: string;
  invocationId: string;
  decisionId: string;
  executionPolicyVersion: string;
  threadKey: string;
  targetVersionHash: string;
  contentHash: string;
  now: Date;
};

async function clearFixture(
  prisma: TestPrisma,
  courseAlias: string
): Promise<void> {
  const decisions = await prisma.autonomyDecision.findMany({
    where: { courseAlias },
    select: { id: true, invocationId: true }
  });
  const decisionIds = decisions.map(({ id }) => id);
  const invocationIds = decisions.map(
    ({ invocationId }) => invocationId
  );
  await prisma.executionAttempt.deleteMany({
    where: { decisionId: { in: decisionIds } }
  });
  await prisma.executionPermit.deleteMany({
    where: { decisionId: { in: decisionIds } }
  });
  await prisma.executionAccountLease.deleteMany({
    where: { decisionId: { in: decisionIds } }
  });
  await prisma.executionStageReceipt.deleteMany({
    where: { decisionId: { in: decisionIds } }
  });
  await prisma.authorizedActionPlan.deleteMany({
    where: { decisionId: { in: decisionIds } }
  });
  await prisma.budgetReservation.deleteMany({
    where: { decisionId: { in: decisionIds } }
  });
  await prisma.semanticRealization.deleteMany({
    where: { decisionId: { in: decisionIds } }
  });
  await prisma.autonomyDecision.deleteMany({
    where: { id: { in: decisionIds } }
  });
  await prisma.autonomyObservation.deleteMany({
    where: { invocationId: { in: invocationIds } }
  });
  await prisma.schedulingLedger.deleteMany({
    where: { invocationId: { in: invocationIds } }
  });
  await prisma.autonomyPolicy.deleteMany({
    where: { courseAlias }
  });
  await prisma.scheduledInvocation.deleteMany({
    where: { courseAlias }
  });
  await prisma.autonomyCourseManifest.deleteMany({
    where: { alias: courseAlias }
  });
}

async function seedFixture(input: {
  prisma: TestPrisma;
  suffix: string;
  now?: Date;
}): Promise<Fixture> {
  const now = input.now ?? new Date("2026-08-30T12:00:00.000Z");
  const courseAlias = `autopilot-canary-${input.suffix}`;
  const invocationId = `${courseAlias}-invocation`;
  const decisionId = `${courseAlias}-decision`;
  const executionPolicyVersion = `${courseAlias}.auto.v1`;
  const manifestHash = hash(`${courseAlias}:manifest`);
  const threadKey = hash(`${courseAlias}:thread`);
  const targetVersionHash = hash(`${courseAlias}:target-version`);
  const eventSetHash = hash(`${courseAlias}:event-set`);
  const contentHash = hash(TRANSIENT_BODY);
  const observation = {
    schemaVersion: "cmooc.test-safe-observation.v1",
    threadKey,
    targetVersionHash,
    eventSetHash,
    containsForumText: false
  } as const;
  const observationReceiptHash = canonicalProtocolHash(
    observation.schemaVersion,
    observation as CanonicalJsonValue
  );

  await clearFixture(input.prisma, courseAlias);
  await input.prisma.autonomyCourseManifest.create({
    data: {
      alias: courseAlias,
      manifestHash,
      platformId: "test.platform",
      platformCourseRefHash: hash(`${courseAlias}:course-ref`),
      canonicalLocatorHash: hash(`${courseAlias}:locator`),
      identityKeyFingerprint: hash(`${courseAlias}:identity`),
      allowedOrigin: "https://cmooc.example.test",
      timeZone: "Asia/Shanghai",
      defaultMode: "SHADOW",
      policyVersion: executionPolicyVersion,
      enabled: true,
      realPublishEnabled: false
    }
  });
  await input.prisma.scheduledInvocation.create({
    data: {
      id: invocationId,
      invocationKey: hash(`${courseAlias}:invocation-key`),
      courseAlias,
      manifestHash,
      scheduledFor: new Date(now.getTime() - 60_000),
      mode: "SHADOW",
      status: "completed",
      phase: "completed",
      attempt: 1,
      startedAt: new Date(now.getTime() - 30_000),
      finishedAt: now,
      summaryJson: JSON.stringify({
        schemaVersion: "cmooc.test-invocation-summary.v1",
        status: "completed",
        containsForumText: false
      })
    }
  });
  await input.prisma.autonomyObservation.create({
    data: {
      invocationId,
      threadKey,
      receiptHash: observationReceiptHash,
      observedAt: now,
      receiptJson: JSON.stringify(observation),
      containsForumText: false
    }
  });
  await input.prisma.autonomyDecision.create({
    data: {
      id: decisionId,
      invocationId,
      courseAlias,
      decisionKey: hash(`${courseAlias}:decision-key`),
      threadKey,
      authorKey: hash(`${courseAlias}:author`),
      decision: "draft",
      decisionMode: "DRAFT_ELIGIBLE",
      reasonCode: "draft_eligible",
      observationReceiptHash,
      opportunityReceiptHash: hash(`${courseAlias}:opportunity`),
      evidenceBundleHash: hash(`${courseAlias}:evidence`),
      intentHash: hash(`${courseAlias}:intent`),
      moveSpecHash: hash(`${courseAlias}:move-spec`),
      draftContentHash: contentHash,
      policyVersion: executionPolicyVersion,
      worldHash: hash(`${courseAlias}:world`),
      candidateSetHash: hash(`${courseAlias}:candidate-set`),
      evidenceAsOf: now,
      decisionJson: JSON.stringify({
        schemaVersion: "cmooc.test-decision.v1",
        draftContentHash: contentHash,
        budget: {
          availableSlots: 2,
          workloadCost: 1,
          authorTouchLimit30d: 1
        },
        containsForumText: false
      }),
      bodyPersisted: false,
      publishAttempted: false,
      editorWriteAttempted: false
    }
  });
  await registerCourseAutonomyPolicy({
    prisma: input.prisma,
    value: {
      schemaVersion: AUTONOMY_POLICY_SCHEMA_VERSION,
      courseAlias,
      version: executionPolicyVersion,
      mode: "AUTO",
      allowedActions: ["forum_reply"],
      budget: {
        dailyActionLimit: 2,
        perTickActionLimit: 1,
        authorTouchLimit30d: 1
      },
      validFrom: new Date(
        now.getTime() - 24 * 60 * 60_000
      ).toISOString(),
      validUntil: new Date(
        now.getTime() + 24 * 60 * 60_000
      ).toISOString(),
      realPublishEnabled: false,
      containsForumText: false
    }
  });
  return {
    courseAlias,
    invocationId,
    decisionId,
    executionPolicyVersion,
    threadKey,
    targetVersionHash,
    contentHash,
    now
  };
}

function canaryInput(
  prisma: TestPrisma,
  fixture: Fixture,
  now = fixture.now
) {
  return {
    prisma,
    courseAlias: fixture.courseAlias,
    invocationId: fixture.invocationId,
    decisionId: fixture.decisionId,
    executionPolicyVersion: fixture.executionPolicyVersion,
    now
  };
}

test("AUTOPILOT_CANARY 默认关闭，完整路径只生成 0/0/false 终态且可重放", async () => {
  const { prisma } = await import("../../lib/db");
  const fixture = await seedFixture({
    prisma,
    suffix: "full-path"
  });
  try {
    assert.equal(AUTOPILOT_CANARY_DEFAULT_ENABLED, false);
    const summary = await runAutopilotCanaryExecution(
      canaryInput(prisma, fixture)
    );
    assert.equal(summary.state, "completed_no_write");
    assert.equal(summary.recoveredFrom, "none");
    assert.equal(summary.idempotent, false);
    assert.equal(summary.requestedMutationCount, 0);
    assert.equal(summary.sentMutationCount, 0);
    assert.equal(summary.publishAttempted, false);
    assert.equal(summary.realPublishEnabled, false);
    assert.match(summary.terminalReceiptHash, /^[a-f0-9]{64}$/);

    const [permit, attempt, decision] = await Promise.all([
      prisma.executionPermit.findFirstOrThrow({
        where: { decisionId: fixture.decisionId }
      }),
      prisma.executionAttempt.findFirstOrThrow({
        where: { decisionId: fixture.decisionId }
      }),
      prisma.autonomyDecision.findUniqueOrThrow({
        where: { id: fixture.decisionId }
      })
    ]);
    assert.equal(permit.status, "used");
    assert.equal(permit.realPublishEnabled, false);
    assert.equal(permit.executionAccountLeaseId, null);
    assert.equal(permit.actionPlanHash, null);
    assert.equal(attempt.status, "completed_no_write");
    assert.equal(attempt.transport, "simulated_no_write");
    assert.equal(attempt.requestedMutationCount, 0);
    assert.equal(attempt.sentMutationCount, 0);
    assert.equal(attempt.publishAttempted, false);
    assert.equal(decision.publishAttempted, false);
    assert.equal(decision.editorWriteAttempted, false);
    assert.equal(decision.bodyPersisted, false);
    assert.equal(
      verifyAutopilotCanaryTerminalReceipt({ permit, attempt }),
      summary.terminalReceiptHash
    );
    assert.equal(
      await prisma.executionAccountLease.count({
        where: { decisionId: fixture.decisionId }
      }),
      0
    );
    assert.equal(
      await prisma.executionStageReceipt.count({
        where: { decisionId: fixture.decisionId }
      }),
      0
    );
    assert.equal(
      await prisma.authorizedActionPlan.count({
        where: { decisionId: fixture.decisionId }
      }),
      0
    );
    assert.equal(
      (
        await prisma.schedulingLedger.findUniqueOrThrow({
          where: { invocationId: fixture.invocationId }
        })
      ).reservedSlots,
      0
    );

    const serializedSummary = JSON.stringify(summary);
    for (const forbidden of [
      "permitKey",
      "contentHash",
      "targetHash",
      "targetVersionHash",
      permit.permitKey,
      fixture.contentHash,
      fixture.targetVersionHash,
      TRANSIENT_BODY
    ]) {
      assert.equal(serializedSummary.includes(forbidden), false);
    }

    const replay = await runAutopilotCanaryExecution(
      canaryInput(
        prisma,
        fixture,
        new Date(fixture.now.getTime() + 1_000)
      )
    );
    assert.equal(replay.recoveredFrom, "terminal");
    assert.equal(replay.idempotent, true);
    assert.equal(replay.attemptId, summary.attemptId);
    assert.equal(
      replay.terminalReceiptHash,
      summary.terminalReceiptHash
    );

    const receipt = JSON.parse(attempt.receiptJson) as Record<
      string,
      unknown
    >;
    await prisma.executionAttempt.update({
      where: { id: attempt.id },
      data: {
        receiptJson: JSON.stringify({
          ...receipt,
          forumBody: TRANSIENT_BODY
        })
      }
    });
    await assert.rejects(
      () =>
        runAutopilotCanaryExecution(
          canaryInput(
            prisma,
            fixture,
            new Date(fixture.now.getTime() + 2_000)
          )
        ),
      /AUTOPILOT_CANARY_RECEIPT_KEYS_INVALID/
    );
  } finally {
    await clearFixture(prisma, fixture.courseAlias);
    await prisma.$disconnect();
  }
});

test("AUTOPILOT_CANARY 可从已签发 permit 和已 claim 的无写尝试中断处恢复", async () => {
  const { prisma } = await import("../../lib/db");
  const active = await seedFixture({
    prisma,
    suffix: "recover-active"
  });
  const claimed = await seedFixture({
    prisma,
    suffix: "recover-claimed",
    now: new Date("2026-08-30T13:00:00.000Z")
  });
  try {
    await issueExecutionPermit({
      prisma,
      decisionId: active.decisionId,
      executionPolicyVersion: active.executionPolicyVersion,
      requireRealExecution: false,
      now: active.now
    });
    const activeRecovered = await runAutopilotCanaryExecution(
      canaryInput(
        prisma,
        active,
        new Date(active.now.getTime() + 1_000)
      )
    );
    assert.equal(activeRecovered.recoveredFrom, "permit_active");
    assert.equal(activeRecovered.idempotent, true);

    const issued = await issueExecutionPermit({
      prisma,
      decisionId: claimed.decisionId,
      executionPolicyVersion: claimed.executionPolicyVersion,
      requireRealExecution: false,
      now: claimed.now
    });
    const claim = await claimExecutionPermit({
      prisma,
      permitKey: issued.permit.permitKey,
      transport: "simulated_no_write",
      now: new Date(claimed.now.getTime() + 1_000)
    });
    assert.equal(claim.attempt.status, "claimed_no_write");
    await prisma.autonomyPolicy.update({
      where: {
        courseAlias_version: {
          courseAlias: claimed.courseAlias,
          version: claimed.executionPolicyVersion
        }
      },
      data: {
        status: "revoked",
        revokedAt: new Date(claimed.now.getTime() + 2_000),
        emergencyHalt: true
      }
    });
    await prisma.autonomyCourseManifest.update({
      where: { alias: claimed.courseAlias },
      data: { enabled: false }
    });
    const claimedRecovered = await runAutopilotCanaryExecution(
      canaryInput(
        prisma,
        claimed,
        new Date(claimed.now.getTime() + 5 * 60_000)
      )
    );
    assert.equal(
      claimedRecovered.recoveredFrom,
      "attempt_claimed"
    );
    assert.equal(claimedRecovered.idempotent, true);
    assert.equal(claimedRecovered.attemptId, claim.attempt.id);
  } finally {
    await clearFixture(prisma, active.courseAlias);
    await clearFixture(prisma, claimed.courseAlias);
    await prisma.$disconnect();
  }
});

test("AUTOPILOT_CANARY 对 real permit、lease、STAGE、action plan 和发送态全部 fail closed", async () => {
  const { prisma } = await import("../../lib/db");
  const suffixes = [
    "forbid-real",
    "forbid-lease",
    "forbid-stage",
    "forbid-plan",
    "forbid-mutation",
    "forbid-halt"
  ];
  const fixtures: Fixture[] = [];
  try {
    for (let index = 0; index < suffixes.length; index += 1) {
      fixtures.push(
        await seedFixture({
          prisma,
          suffix: suffixes[index],
          now: new Date(
            Date.parse("2026-08-30T14:00:00.000Z") +
              index * 60 * 60_000
          )
        })
      );
    }
    const [real, lease, stage, plan, mutation, halt] = fixtures;

    const realIssued = await issueExecutionPermit({
      prisma,
      decisionId: real.decisionId,
      executionPolicyVersion: real.executionPolicyVersion,
      requireRealExecution: false,
      now: real.now
    });
    await prisma.executionPermit.update({
      where: { id: realIssued.permit.id },
      data: { realPublishEnabled: true }
    });
    await assert.rejects(
      () => runAutopilotCanaryExecution(canaryInput(prisma, real)),
      /AUTOPILOT_CANARY_REAL_PERMIT_FORBIDDEN/
    );

    await prisma.executionAccountLease.create({
      data: {
        id: hash(`${lease.courseAlias}:lease-id`),
        leaseKey: hash(`${lease.courseAlias}:lease-key`),
        accountRefHash: hash(`${lease.courseAlias}:account`),
        credentialRefHash: hash(`${lease.courseAlias}:credential`),
        roleKey: "facilitator",
        courseAlias: lease.courseAlias,
        invocationId: lease.invocationId,
        decisionId: lease.decisionId,
        status: "active",
        expiresAt: new Date(lease.now.getTime() + 60_000)
      }
    });
    await assert.rejects(
      () => runAutopilotCanaryExecution(canaryInput(prisma, lease)),
      /AUTOPILOT_CANARY_ACCOUNT_LEASE_FORBIDDEN/
    );

    await prisma.executionStageReceipt.create({
      data: {
        decisionId: stage.decisionId,
        courseAlias: stage.courseAlias,
        policyVersion: stage.executionPolicyVersion,
        receiptHash: hash(`${stage.courseAlias}:stage-receipt`),
        targetVersionHash: stage.targetVersionHash,
        contentHash: stage.contentHash,
        status: "active",
        observedAt: stage.now,
        expiresAt: new Date(stage.now.getTime() + 60_000),
        editorWriteCount: 1,
        editorClearCount: 1,
        sentMutationCount: 0,
        publishAttempted: false,
        bodyPersisted: false,
        containsForumText: false
      }
    });
    await assert.rejects(
      () => runAutopilotCanaryExecution(canaryInput(prisma, stage)),
      /AUTOPILOT_CANARY_STAGE_FORBIDDEN/
    );

    await prisma.authorizedActionPlan.create({
      data: {
        decisionId: plan.decisionId,
        invocationId: plan.invocationId,
        courseAlias: plan.courseAlias,
        manifestHash: hash(`${plan.courseAlias}:manifest`),
        governanceHash: hash(`${plan.courseAlias}:governance`),
        policyVersion: plan.executionPolicyVersion,
        policyHash: hash(`${plan.courseAlias}:policy`),
        connectorBindingHash: hash(`${plan.courseAlias}:connector`),
        actionType: "forum_reply",
        executionProofKind: "connector_reread",
        planHash: hash(`${plan.courseAlias}:plan`),
        status: "active",
        validUntil: new Date(plan.now.getTime() + 60_000)
      }
    });
    await assert.rejects(
      () => runAutopilotCanaryExecution(canaryInput(prisma, plan)),
      /AUTOPILOT_CANARY_ACTION_PLAN_FORBIDDEN/
    );

    const mutationIssued = await issueExecutionPermit({
      prisma,
      decisionId: mutation.decisionId,
      executionPolicyVersion: mutation.executionPolicyVersion,
      requireRealExecution: false,
      now: mutation.now
    });
    const mutationClaimed = await claimExecutionPermit({
      prisma,
      permitKey: mutationIssued.permit.permitKey,
      transport: "simulated_no_write",
      now: mutation.now
    });
    await prisma.executionAttempt.update({
      where: { id: mutationClaimed.attempt.id },
      data: {
        status: "sending_real",
        transport: "real_platform",
        requestedMutationCount: 1
      }
    });
    await assert.rejects(
      () =>
        runAutopilotCanaryExecution(canaryInput(prisma, mutation)),
      /AUTOPILOT_CANARY_MUTATION_STATE_FORBIDDEN/
    );

    await prisma.autonomyPolicy.update({
      where: {
        courseAlias_version: {
          courseAlias: halt.courseAlias,
          version: halt.executionPolicyVersion
        }
      },
      data: { emergencyHalt: true }
    });
    await assert.rejects(
      () => runAutopilotCanaryExecution(canaryInput(prisma, halt)),
      /AUTOPILOT_CANARY_POLICY_LOCK_INVALID/
    );
  } finally {
    for (const fixture of fixtures) {
      await clearFixture(prisma, fixture.courseAlias);
    }
    await prisma.$disconnect();
  }
});
