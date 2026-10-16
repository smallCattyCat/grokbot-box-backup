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
  authorizeConnectorActionPlan
} from "../../lib/autonomy/authorized-action-plan";
import {
  COURSE_OPERATION_GOVERNANCE_SCHEMA_VERSION,
  hashCourseOperationGovernancePolicy
} from "../../lib/autonomy/course-operation-governance";
import { acquire } from "../../lib/autonomy/execution-account-pool";
import {
  claimExecutionPermit,
  hashPreExecutionTargetObservation,
  issueExecutionPermit,
  markExecutionAttemptSending,
  PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
  reconcileOutcomeUnknownExecutionAttempt,
  revokeExecutionPermit,
  settleExecutionAttemptNoWrite,
  settleExecutionAttemptReal,
  validateExecutionPermit
} from "../../lib/autonomy/execution-permit";

const COURSE_ALIAS = "execution-permit-integration";
const POLICY_VERSION = "execution-permit.auto.v1";
const TRANSIENT_BODY =
  "TRANSIENT_EXECUTION_BODY_MUST_NEVER_ENTER_DATABASE";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function clearFixture(
  prisma: (typeof import("../../lib/db"))["prisma"]
) {
  const decisions = await prisma.autonomyDecision.findMany({
    where: { courseAlias: COURSE_ALIAS },
    select: { id: true, invocationId: true }
  });
  const decisionIds = decisions.map((item) => item.id);
  const invocationIds = decisions.map(
    (item) => item.invocationId
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
    where: { courseAlias: COURSE_ALIAS }
  });
  await prisma.scheduledInvocation.deleteMany({
    where: { courseAlias: COURSE_ALIAS }
  });
  await prisma.autonomyCourseManifest.deleteMany({
    where: { alias: COURSE_ALIAS }
  });
}

test("ExecutionPermit 绑定策略、目标版本、内容和幂等键，真实传输 fail closed", async () => {
  const { prisma } = await import("../../lib/db");
  const now = new Date("2026-07-10T12:00:00.000Z");
  const threadKey = hash("permit-thread");
  const targetVersionHash = hash("permit-target-version");
  const observation = {
    schemaVersion: "cmooc.test-safe-observation.v1",
    threadKey,
    targetVersionHash,
    containsForumText: false
  } as const;
  const observationReceiptHash = canonicalProtocolHash(
    observation.schemaVersion,
    observation as CanonicalJsonValue
  );
  const invocationId = "execution-permit-invocation";
  const decisionId = "execution-permit-decision";

  await clearFixture(prisma);
  try {
    await prisma.autonomyCourseManifest.create({
      data: {
        alias: COURSE_ALIAS,
        manifestHash: hash("permit-manifest"),
        platformId: "test.platform",
        platformCourseRefHash: hash("permit-course-ref"),
        canonicalLocatorHash: hash("permit-locator"),
        identityKeyFingerprint: hash("permit-identity-key"),
        allowedOrigin: "https://cmooc.example.test",
        timeZone: "Asia/Shanghai",
        defaultMode: "SHADOW",
        policyVersion: POLICY_VERSION,
        enabled: true,
        realPublishEnabled: false
      }
    });
    await prisma.scheduledInvocation.create({
      data: {
        id: invocationId,
        invocationKey: hash("permit-invocation-key"),
        courseAlias: COURSE_ALIAS,
        manifestHash: hash("permit-manifest"),
        scheduledFor: now,
        mode: "AUTO",
        status: "completed",
        phase: "decided",
        attempt: 1,
        startedAt: now,
        finishedAt: now,
        summaryJson: JSON.stringify({
          schemaVersion: "cmooc.test-invocation.v1",
          containsForumText: false
        })
      }
    });
    await prisma.autonomyObservation.create({
      data: {
        invocationId,
        threadKey,
        receiptHash: observationReceiptHash,
        observedAt: now,
        receiptJson: JSON.stringify(observation),
        containsForumText: false
      }
    });
    await prisma.autonomyDecision.create({
      data: {
        id: decisionId,
        invocationId,
        courseAlias: COURSE_ALIAS,
        decisionKey: hash("permit-decision-key"),
        threadKey,
        authorKey: hash("permit-author"),
        decision: "draft",
        decisionMode: "DRAFT_ELIGIBLE",
        reasonCode: "draft_eligible",
        observationReceiptHash,
        opportunityReceiptHash: hash("permit-opportunity"),
        evidenceBundleHash: hash("permit-evidence"),
        intentHash: hash("permit-intent"),
        moveSpecHash: hash("permit-move"),
        draftContentHash: hash(TRANSIENT_BODY),
        policyVersion: POLICY_VERSION,
        worldHash: hash("permit-world"),
        candidateSetHash: hash("permit-candidates"),
        evidenceAsOf: now,
        decisionJson: JSON.stringify({
          schemaVersion: "cmooc.test-decision.v1",
          draftContentHash: hash(TRANSIENT_BODY),
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
      prisma,
      value: {
        schemaVersion: AUTONOMY_POLICY_SCHEMA_VERSION,
        courseAlias: COURSE_ALIAS,
        version: POLICY_VERSION,
        mode: "AUTO",
        allowedActions: ["forum_reply"],
        budget: {
          dailyActionLimit: 2,
          perTickActionLimit: 1,
          authorTouchLimit30d: 1
        },
        validFrom: "2026-07-01T00:00:00.000Z",
        validUntil: "2026-08-01T00:00:00.000Z",
        realPublishEnabled: false,
        containsForumText: false
      }
    });

    const issued = await issueExecutionPermit({
      prisma,
      decisionId,
      now
    });
    assert.equal(issued.permit.realPublishEnabled, false);
    assert.equal(issued.binding.targetVersionHash, targetVersionHash);
    assert.equal(
      issued.binding.contentHash,
      hash(TRANSIENT_BODY)
    );
    assert.equal(issued.reservation.status, "active");
    assert.equal(
      (
        await prisma.schedulingLedger.findUniqueOrThrow({
          where: { invocationId }
        })
      ).reservedSlots,
      1
    );
    const repeated = await issueExecutionPermit({
      prisma,
      decisionId,
      now: new Date(now.getTime() + 1_000)
    });
    assert.equal(repeated.idempotent, true);
    assert.equal(repeated.permit.id, issued.permit.id);

    await assert.rejects(
      () =>
        issueExecutionPermit({
          prisma,
          decisionId,
          now,
          requireRealExecution: true
        }),
      /EXECUTION_ACCOUNT_LEASE_REQUIRED/
    );
    await assert.rejects(
      () =>
        claimExecutionPermit({
          prisma,
          permitKey: issued.permit.permitKey,
          transport: "real_platform",
          now: new Date(now.getTime() + 2_000),
          preExecutionObservation: (() => {
            const receipt = {
              schemaVersion:
                PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
              courseAlias: COURSE_ALIAS,
              threadKey,
              targetVersionHash,
              observedAt: new Date(
                now.getTime() + 1_500
              ).toISOString(),
              containsForumText: false
            } as const;
            return {
              receipt,
              receiptHash:
                hashPreExecutionTargetObservation(receipt)
            };
          })()
        }),
      /EXECUTION_ACCOUNT_LEASE_REQUIRED/
    );
    assert.equal(
      await prisma.executionAttempt.count({
        where: { decisionId }
      }),
      0
    );

    const claimed = await claimExecutionPermit({
      prisma,
      permitKey: issued.permit.permitKey,
      transport: "simulated_no_write",
      now: new Date(now.getTime() + 3_000)
    });
    assert.equal(claimed.attempt.status, "claimed_no_write");
    assert.equal(claimed.attempt.sentMutationCount, 0);
    assert.equal(claimed.attempt.publishAttempted, false);

    const settled = await settleExecutionAttemptNoWrite({
      prisma,
      attemptId: claimed.attempt.id,
      now: new Date(now.getTime() + 4_000)
    });
    assert.equal(settled.attempt.status, "completed_no_write");
    assert.equal(settled.permit.status, "used");
    assert.equal(
      (
        await prisma.budgetReservation.findUniqueOrThrow({
          where: {
            reservationKey:
              issued.binding.reservationKey
          }
        })
      ).status,
      "released"
    );
    assert.equal(
      (
        await prisma.schedulingLedger.findUniqueOrThrow({
          where: { invocationId }
        })
      ).reservedSlots,
      0
    );
    const replayedClaim = await claimExecutionPermit({
      prisma,
      permitKey: issued.permit.permitKey,
      transport: "simulated_no_write",
      now: new Date(now.getTime() + 4_500)
    });
    assert.equal(replayedClaim.idempotent, true);
    assert.equal(
      replayedClaim.attempt.id,
      settled.attempt.id
    );
    const afterUse = await validateExecutionPermit({
      prisma,
      permitKey: issued.permit.permitKey,
      now: new Date(now.getTime() + 5_000)
    });
    assert.equal(afterUse.valid, false);
    assert.equal(afterUse.code, "used");

    const persisted = JSON.stringify({
      policy: await prisma.autonomyPolicy.findMany({
        where: { courseAlias: COURSE_ALIAS }
      }),
      permits: await prisma.executionPermit.findMany({
        where: { courseAlias: COURSE_ALIAS }
      }),
      attempts: await prisma.executionAttempt.findMany({
        where: { decisionId }
      })
    });
    assert.equal(persisted.includes(TRANSIENT_BODY), false);
  } finally {
    await clearFixture(prisma);
    await prisma.$disconnect();
  }
});

test("并发许可不会超额预留；撤销释放预算；陈旧 manifest 与目标版本 fail closed", async () => {
  const { prisma } = await import("../../lib/db");
  const now = new Date("2026-07-11T12:00:00.000Z");
  const manifestHash = hash("concurrent-manifest");
  const invocationId = "execution-permit-concurrent-invocation";
  const fixtures = [0, 1].map((index) => {
    const threadKey = hash(`concurrent-thread-${index}`);
    const targetVersionHash = hash(
      `concurrent-target-${index}`
    );
    const observation = {
      schemaVersion: "cmooc.test-safe-observation.v1",
      threadKey,
      targetVersionHash,
      containsForumText: false
    } as const;
    return {
      decisionId: `execution-permit-concurrent-decision-${index}`,
      threadKey,
      targetVersionHash,
      observation,
      observationReceiptHash: canonicalProtocolHash(
        observation.schemaVersion,
        observation as CanonicalJsonValue
      )
    };
  });

  await clearFixture(prisma);
  try {
    await prisma.autonomyCourseManifest.create({
      data: {
        alias: COURSE_ALIAS,
        manifestHash,
        platformId: "test.platform",
        platformCourseRefHash: hash("concurrent-course-ref"),
        canonicalLocatorHash: hash("concurrent-locator"),
        identityKeyFingerprint: hash("concurrent-identity"),
        allowedOrigin: "https://cmooc.example.test",
        timeZone: "Asia/Shanghai",
        defaultMode: "SHADOW",
        policyVersion: POLICY_VERSION,
        enabled: true,
        realPublishEnabled: false
      }
    });
    await prisma.scheduledInvocation.create({
      data: {
        id: invocationId,
        invocationKey: hash("concurrent-invocation-key"),
        courseAlias: COURSE_ALIAS,
        manifestHash,
        scheduledFor: now,
        mode: "AUTO",
        status: "completed",
        phase: "decided",
        attempt: 1,
        startedAt: now,
        finishedAt: now
      }
    });
    for (const [index, fixture] of fixtures.entries()) {
      await prisma.autonomyObservation.create({
        data: {
          invocationId,
          threadKey: fixture.threadKey,
          receiptHash: fixture.observationReceiptHash,
          observedAt: now,
          receiptJson: JSON.stringify(fixture.observation),
          containsForumText: false
        }
      });
      await prisma.autonomyDecision.create({
        data: {
          id: fixture.decisionId,
          invocationId,
          courseAlias: COURSE_ALIAS,
          decisionKey: hash(`concurrent-decision-key-${index}`),
          threadKey: fixture.threadKey,
          authorKey: hash(`concurrent-author-${index}`),
          decision: "draft",
          decisionMode: "DRAFT_ELIGIBLE",
          reasonCode: "draft_eligible",
          observationReceiptHash:
            fixture.observationReceiptHash,
          opportunityReceiptHash: hash(
            `concurrent-opportunity-${index}`
          ),
          evidenceBundleHash: hash(
            `concurrent-evidence-${index}`
          ),
          intentHash: hash(`concurrent-intent-${index}`),
          moveSpecHash: hash(`concurrent-move-${index}`),
          draftContentHash: hash(
            `concurrent-transient-body-${index}`
          ),
          policyVersion: POLICY_VERSION,
          worldHash: hash("concurrent-world"),
          candidateSetHash: hash("concurrent-candidates"),
          evidenceAsOf: now,
          decisionJson: JSON.stringify({
            schemaVersion: "cmooc.test-decision.v1",
            budget: {
              availableSlots: 1,
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
    }
    await registerCourseAutonomyPolicy({
      prisma,
      value: {
        schemaVersion: AUTONOMY_POLICY_SCHEMA_VERSION,
        courseAlias: COURSE_ALIAS,
        version: POLICY_VERSION,
        mode: "AUTO",
        allowedActions: ["forum_reply"],
        budget: {
          dailyActionLimit: 1,
          perTickActionLimit: 1,
          authorTouchLimit30d: 1
        },
        validFrom: "2026-07-01T00:00:00.000Z",
        validUntil: "2026-08-01T00:00:00.000Z",
        realPublishEnabled: false,
        containsForumText: false
      }
    });

    const raced = await Promise.allSettled(
      fixtures.map((fixture) =>
        issueExecutionPermit({
          prisma,
          decisionId: fixture.decisionId,
          now
        })
      )
    );
    const fulfilled = raced.filter(
      (
        result
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof issueExecutionPermit>>
      > => result.status === "fulfilled"
    );
    assert.equal(fulfilled.length, 1);
    assert.equal(
      await prisma.budgetReservation.count({
        where: {
          courseAlias: COURSE_ALIAS,
          status: "active",
          expiresAt: { gt: now }
        }
      }),
      1
    );
    assert.equal(
      (
        await prisma.schedulingLedger.findUniqueOrThrow({
          where: { invocationId }
        })
      ).reservedSlots,
      1
    );

    const winning = fulfilled[0].value;
    await revokeExecutionPermit({
      prisma,
      permitKey: winning.permit.permitKey,
      now: new Date(now.getTime() + 1_000)
    });
    assert.equal(
      (
        await prisma.budgetReservation.findUniqueOrThrow({
          where: {
            reservationKey:
              winning.binding.reservationKey
          }
        })
      ).status,
      "released"
    );
    const losingFixture = fixtures.find(
      (fixture) =>
        fixture.decisionId !== winning.binding.decisionId
    );
    assert.ok(losingFixture);
    const afterRelease = await issueExecutionPermit({
      prisma,
      decisionId: losingFixture.decisionId,
      now: new Date(now.getTime() + 2_000)
    });
    assert.equal(afterRelease.reservation.status, "active");

    const staleReceipt = {
      schemaVersion:
        PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
      courseAlias: COURSE_ALIAS,
      threadKey: losingFixture.threadKey,
      targetVersionHash: hash("changed-target"),
      observedAt: new Date(now.getTime() + 2_500).toISOString(),
      containsForumText: false
    } as const;
    const staleTarget = await validateExecutionPermit({
      prisma,
      permitKey: afterRelease.permit.permitKey,
      now: new Date(now.getTime() + 3_000),
      requireRealExecution: true,
      preExecutionObservation: {
        receipt: staleReceipt,
        receiptHash:
          hashPreExecutionTargetObservation(staleReceipt)
      }
    });
    assert.equal(staleTarget.valid, false);
    assert.equal(staleTarget.code, "account_lease_required");

    await prisma.autonomyCourseManifest.update({
      where: { alias: COURSE_ALIAS },
      data: { manifestHash: hash("stale-manifest") }
    });
    await assert.rejects(
      () =>
        validateExecutionPermit({
          prisma,
          permitKey: afterRelease.permit.permitKey,
          now: new Date(now.getTime() + 4_000)
        }),
      /EXECUTION_COURSE_MANIFEST_STALE/
    );
  } finally {
    await clearFixture(prisma);
    await prisma.$disconnect();
  }
});

test("connector 重读可替代浏览器 STAGE，并以持久授权计划签发真实 Permit", async () => {
  const { prisma } = await import("../../lib/db");
  const now = new Date("2026-07-12T12:00:00.000Z");
  const invocationId = "execution-permit-connector-invocation";
  const decisionId = "execution-permit-connector-decision";
  const manifestHash = hash("connector-manifest");
  const governancePolicy = {
    schemaVersion: COURSE_OPERATION_GOVERNANCE_SCHEMA_VERSION,
    courseAlias: COURSE_ALIAS,
    version: "execution-permit.connector-governance.v1",
    baseManifestHash: manifestHash,
    status: "active" as const,
    mode: "SHADOW" as const,
    limits: {
      dailySlotLimit: 1,
      perTickActionLimit: 1,
      authorTouchLimit30d: 1,
      minIntervalMinutes: 1
    },
    validFrom: "2026-07-01T00:00:00.000Z",
    validUntil: "2026-08-01T00:00:00.000Z",
    emergencyHalt: false,
    containsForumText: false as const
  };
  const governanceHash =
    hashCourseOperationGovernancePolicy(governancePolicy);
  const threadKey = hash("connector-thread");
  const targetVersionHash = hash("connector-target-version");
  const eventSetHash = hash("connector-event-set");
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

  await clearFixture(prisma);
  try {
    await prisma.autonomyCourseManifest.create({
      data: {
        alias: COURSE_ALIAS,
        manifestHash,
        platformId: "test.platform",
        adapterId: "test.connector.v1",
        platformCourseRefHash: hash("connector-course-ref"),
        canonicalLocatorHash: hash("connector-locator"),
        identityKeyFingerprint: hash("connector-identity"),
        allowedOrigin: "https://cmooc.example.test",
        timeZone: "Asia/Shanghai",
        defaultMode: "SHADOW",
        policyVersion: POLICY_VERSION,
        enabled: true,
        realPublishEnabled: true
      }
    });
    const existingGovernance =
      await prisma.courseOperationGovernancePolicy.findUnique({
        where: {
          courseAlias_version: {
            courseAlias: COURSE_ALIAS,
            version: governancePolicy.version
          }
        }
      });
    if (existingGovernance) {
      assert.equal(existingGovernance.governanceHash, governanceHash);
      assert.equal(existingGovernance.baseManifestHash, manifestHash);
    } else {
      await prisma.courseOperationGovernancePolicy.create({
        data: {
          courseAlias: COURSE_ALIAS,
          version: governancePolicy.version,
          baseManifestHash: manifestHash,
          status: governancePolicy.status,
          mode: governancePolicy.mode,
          dailySlotLimit: governancePolicy.limits.dailySlotLimit,
          perTickActionLimit:
            governancePolicy.limits.perTickActionLimit,
          authorTouchLimit30d:
            governancePolicy.limits.authorTouchLimit30d,
          minIntervalMinutes:
            governancePolicy.limits.minIntervalMinutes,
          validFrom: new Date(governancePolicy.validFrom),
          validUntil: new Date(governancePolicy.validUntil),
          emergencyHalt: false,
          governanceHash,
          containsForumText: false
        }
      });
    }
    await prisma.scheduledInvocation.create({
      data: {
        id: invocationId,
        invocationKey: hash("connector-invocation-key"),
        courseAlias: COURSE_ALIAS,
        manifestHash,
        governanceHash,
        governanceLimitsJson: JSON.stringify({
          dailySlotLimit: 1,
          perTickActionLimit: 1,
          authorTouchLimit30d: 1
        }),
        scheduledFor: now,
        mode: "SHADOW",
        status: "completed",
        phase: "completed",
        attempt: 1,
        startedAt: now,
        finishedAt: now
      }
    });
    await prisma.autonomyObservation.create({
      data: {
        invocationId,
        threadKey,
        receiptHash: observationReceiptHash,
        observedAt: now,
        receiptJson: JSON.stringify(observation),
        containsForumText: false
      }
    });
    await prisma.autonomyDecision.create({
      data: {
        id: decisionId,
        invocationId,
        courseAlias: COURSE_ALIAS,
        governanceHash,
        decisionKey: hash("connector-decision-key"),
        threadKey,
        authorKey: hash("connector-author"),
        decision: "draft",
        decisionMode: "DRAFT_ELIGIBLE",
        reasonCode: "draft_eligible",
        observationReceiptHash,
        opportunityReceiptHash: hash("connector-opportunity"),
        evidenceBundleHash: hash("connector-evidence"),
        intentHash: hash("connector-intent"),
        moveSpecHash: hash("connector-move"),
        draftContentHash: hash("connector-transient-body"),
        policyVersion: POLICY_VERSION,
        worldHash: hash("connector-world"),
        candidateSetHash: hash("connector-candidates"),
        evidenceAsOf: now,
        decisionJson: JSON.stringify({
          schemaVersion: "cmooc.test-decision.v1",
          budget: {
            availableSlots: 1,
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
      prisma,
      allowRealPublishActivation: true,
      value: {
        schemaVersion: AUTONOMY_POLICY_SCHEMA_VERSION,
        courseAlias: COURSE_ALIAS,
        version: POLICY_VERSION,
        mode: "AUTO",
        allowedActions: ["forum_reply"],
        budget: {
          dailyActionLimit: 1,
          perTickActionLimit: 1,
          authorTouchLimit30d: 1
        },
        validFrom: "2026-07-01T00:00:00.000Z",
        validUntil: "2026-08-01T00:00:00.000Z",
        realPublishEnabled: true,
        containsForumText: false
      }
    });

    await assert.rejects(
      () => authorizeConnectorActionPlan({
        prisma,
        decisionId,
        executionPolicyVersion: "execution-permit.auto.stale",
        now
      }),
      /AUTHORIZED_ACTION_PLAN_POLICY_NOT_FOUND/
    );
    const planned = await authorizeConnectorActionPlan({
      prisma,
      decisionId,
      executionPolicyVersion: POLICY_VERSION,
      now,
      validForSeconds: 30
    });
    const repeatedPlan = await authorizeConnectorActionPlan({
      prisma,
      decisionId,
      executionPolicyVersion: POLICY_VERSION,
      now: new Date(now.getTime() + 500),
      validForSeconds: 30
    });
    assert.equal(repeatedPlan.idempotent, true);
    assert.equal(repeatedPlan.record.planHash, planned.record.planHash);

    const executionAccount = await acquire({
      prisma,
      courseAlias: COURSE_ALIAS,
      invocationId,
      decisionId,
      accounts: [
        {
          accountRefHash: hash("connector-account"),
          credentialRefHash: hash("connector-credential"),
          roleKey: "socratic_guide",
          courseAliases: [COURSE_ALIAS],
          dailyActionLimit: 5,
          cooldownMinutes: 0,
          disclosedAi: true,
          containsForumText: false
        }
      ],
      now
    });
    const staleReceipt = {
      schemaVersion: PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
      courseAlias: COURSE_ALIAS,
      threadKey,
      targetVersionHash: hash("connector-target-changed"),
      eventSetHash,
      observedAt: new Date(now.getTime() + 1_000).toISOString(),
      containsForumText: false
    } as const;
    await assert.rejects(
      () => issueExecutionPermit({
        prisma,
        decisionId,
        now: new Date(now.getTime() + 1_000),
        executionPolicyVersion: POLICY_VERSION,
        executionProofKind: "connector_reread",
        actionPlanHash: planned.record.planHash,
        requireRealExecution: true,
        executionAccountLeaseId: executionAccount.leaseId,
        preExecutionObservation: {
          receipt: staleReceipt,
          receiptHash: hashPreExecutionTargetObservation(staleReceipt)
        }
      }),
      /EXECUTION_CONNECTOR_REREAD_INVALID:target_stale/
    );
    assert.equal(await prisma.executionPermit.count({ where: { decisionId } }), 0);
    assert.equal(await prisma.budgetReservation.count({ where: { decisionId } }), 0);
    assert.equal(
      (await prisma.authorizedActionPlan.findUniqueOrThrow({
        where: { decisionId }
      })).status,
      "active"
    );

    const freshReceipt = {
      ...staleReceipt,
      targetVersionHash,
      observedAt: new Date(now.getTime() + 1_500).toISOString()
    };
    const freshObservation = {
      receipt: freshReceipt,
      receiptHash: hashPreExecutionTargetObservation(freshReceipt)
    };
    const issued = await issueExecutionPermit({
      prisma,
      decisionId,
      now: new Date(now.getTime() + 1_500),
      expiresInSeconds: 120,
      executionPolicyVersion: POLICY_VERSION,
      executionProofKind: "connector_reread",
      actionPlanHash: planned.record.planHash,
      requireRealExecution: true,
      executionAccountLeaseId: executionAccount.leaseId,
      preExecutionObservation: freshObservation
    });
    assert.equal(issued.binding.schemaVersion, "cmooc.execution-permit-binding.v2");
    assert.equal(issued.permit.executionProofKind, "connector_reread");
    assert.equal(issued.permit.actionPlanHash, planned.record.planHash);
    assert.equal(
      issued.permit.expiresAt.getTime(),
      planned.record.validUntil.getTime()
    );
    assert.equal(
      (await prisma.authorizedActionPlan.findUniqueOrThrow({
        where: { decisionId }
      })).status,
      "permit_issued"
    );
    assert.equal(
      await prisma.executionStageReceipt.count({ where: { decisionId } }),
      0
    );

    const repeatedPermit = await issueExecutionPermit({
      prisma,
      decisionId,
      now: new Date(now.getTime() + 2_000),
      executionPolicyVersion: POLICY_VERSION,
      executionProofKind: "connector_reread",
      actionPlanHash: planned.record.planHash,
      requireRealExecution: true,
      executionAccountLeaseId: executionAccount.leaseId,
      preExecutionObservation: freshObservation
    });
    assert.equal(repeatedPermit.idempotent, true);
    assert.equal(repeatedPermit.permit.id, issued.permit.id);

    const validated = await validateExecutionPermit({
      prisma,
      permitKey: issued.permit.permitKey,
      now: new Date(now.getTime() + 2_500),
      requireRealExecution: true,
      preExecutionObservation: freshObservation
    });
    assert.equal(validated.valid, true);
    assert.equal(validated.code, "valid");

    const claimed = await claimExecutionPermit({
      prisma,
      permitKey: issued.permit.permitKey,
      transport: "real_platform",
      now: new Date(now.getTime() + 2_600),
      preExecutionObservation: freshObservation
    });
    await assert.rejects(
      () => markExecutionAttemptSending({
        prisma,
        attemptId: claimed.attempt.id,
        now: new Date(now.getTime() + 2_700)
      }),
      /EXECUTION_CONNECTOR_REREAD_INVALID:pre_execution_observation_required/
    );
    await assert.rejects(
      () => markExecutionAttemptSending({
        prisma,
        attemptId: claimed.attempt.id,
        now: new Date(now.getTime() + 2_800),
        preExecutionObservation: {
          receipt: staleReceipt,
          receiptHash: hashPreExecutionTargetObservation(staleReceipt)
        }
      }),
      /EXECUTION_CONNECTOR_REREAD_INVALID:target_stale/
    );
    const sending = await markExecutionAttemptSending({
      prisma,
      attemptId: claimed.attempt.id,
      now: new Date(now.getTime() + 3_000),
      preExecutionObservation: freshObservation
    });
    assert.equal(sending.attempt.status, "sending_real");

    // Once the mutation boundary has been crossed, a later policy relock and
    // plan expiry must not strand terminal bookkeeping or reconciliation.
    await prisma.autonomyPolicy.update({
      where: {
        courseAlias_version: {
          courseAlias: COURSE_ALIAS,
          version: POLICY_VERSION
        }
      },
      data: {
        status: "revoked",
        revokedAt: new Date(now.getTime() + 4_000),
        emergencyHalt: true
      }
    });
    await prisma.autonomyCourseManifest.update({
      where: { alias: COURSE_ALIAS },
      data: { enabled: false, realPublishEnabled: false }
    });
    const unknown = await settleExecutionAttemptReal({
      prisma,
      attemptId: claimed.attempt.id,
      state: "outcome_unknown",
      remoteEvidenceHash: hash("connector-outcome-unknown"),
      now: new Date(now.getTime() + 31_000)
    });
    assert.equal(unknown.attempt.status, "outcome_unknown");
    const reconciled = await reconcileOutcomeUnknownExecutionAttempt({
      prisma,
      attemptId: claimed.attempt.id,
      state: "confirmed_not_published",
      remoteEvidenceHash: hash("connector-confirmed-not-published"),
      now: new Date(now.getTime() + 32_000)
    });
    assert.equal(reconciled.attempt.status, "confirmed_not_published");
    assert.equal(reconciled.idempotent, false);
    const repeatedReconcile =
      await reconcileOutcomeUnknownExecutionAttempt({
        prisma,
        attemptId: claimed.attempt.id,
        state: "confirmed_not_published",
        remoteEvidenceHash: hash("connector-confirmed-not-published"),
        now: new Date(now.getTime() + 33_000)
      });
    assert.equal(repeatedReconcile.idempotent, true);
    assert.equal(
      await prisma.executionStageReceipt.count({ where: { decisionId } }),
      0
    );
  } finally {
    await clearFixture(prisma);
    await prisma.$disconnect();
  }
});
