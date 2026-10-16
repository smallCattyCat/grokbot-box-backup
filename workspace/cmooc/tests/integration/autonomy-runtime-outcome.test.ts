import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  getAutonomyRuntimeHealth,
  listDueAutonomyInvocations,
  recoverExpiredInvocationLeases
} from "../../lib/autonomy/runtime-health";
import {
  observeDueProximalOutcomes,
  preflightDueProximalOutcomes,
  scheduleProximalOutcomes
} from "../../lib/autonomy/outcome-observer";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "../../lib/facilitation-protocol";
import {
  EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION
} from "../../lib/autonomy/execution-permit";
import {
  issueCourseOperationGovernanceBaseline
} from "../../lib/autonomy/course-operation-governance";
import type { CourseManifest } from "../../lib/autonomy/course-manifest";
import {
  createCourseStructureNodeFact,
  type CourseStructureFact
} from "../../lib/world/course-structure-fact";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function governanceManifest(alias: string, manifestHash: string): CourseManifest {
  return {
    schemaVersion: "cmooc.course-manifest.v1",
    alias,
    platformId: "cmooc.bnu",
    courseId: "1234567890",
    courseIdSha256: hash("1234567890"),
    canonicalUrl: "https://example.test/course",
    allowedOrigins: ["https://example.test"],
    adapterId: "test.adapter",
    timeZone: "UTC",
    defaultMode: "SHADOW",
    policyVersion: "test.policy.v1",
    scan: { maxThreadsPerTick: 10, maxCommentsPerThread: 10, pageSize: 10 },
    budget: { dailySlots: 3, workloadCost: 1, authorTouchLimit30d: 2 },
    schedule: { intervalMinutes: 30, leaseSeconds: 30 },
    realPublishEnabled: false,
    manifestHash,
    sourcePath: "C:\\tmp\\outcome-course.json"
  } as CourseManifest;
}

function persistedStructureFact(
  courseAlias: string,
  fact: CourseStructureFact
) {
  return {
    courseAlias,
    courseKey: fact.courseKey,
    factKey: fact.factKey,
    factIdentityKey: fact.factIdentityKey,
    factKind: fact.factKind,
    subjectKey: fact.subjectKey,
    subjectKind: fact.subjectKind,
    predicate: fact.predicate,
    objectKey: fact.objectKey,
    objectKind: fact.objectKind,
    revisionHash: fact.revisionHash,
    occurredAt: fact.occurredAt
      ? new Date(fact.occurredAt)
      : null,
    ordinal: fact.ordinal,
    attributesJson: JSON.stringify(fact.attributes),
    legalityStatus: fact.legalityStatus,
    containsForumText: fact.containsForumText
  };
}

test("V7/V9 调度恢复与结果回流保持零外部写入、零 shadow 效果", async () => {
  const { prisma } = await import("../../lib/db");
  const suffix = randomUUID().replaceAll("-", "");
  const alias = `autonomy-runtime-${suffix}`;
  const manifestHash = hash(`manifest-${suffix}`);
  const courseKey = hash(`course-key-${suffix}`);
  const threadKey = hash(`thread-${suffix}`);
  const authorKey = hash(`author-${suffix}`);
  const externalActorKey = hash(`external-${suffix}`);
  const rootEventKey = hash(`root-${suffix}`);
  const replyEventKey = hash(`reply-${suffix}`);
  const start = new Date("2026-07-05T10:00:00.000Z");
  const publishedAt = new Date(
    "2026-07-05T12:00:00.000Z"
  );
  const r24DueAt = new Date(
    publishedAt.getTime() + 24 * 60 * 60_000
  );
  const afterR24 = new Date(
    r24DueAt.getTime() + 60 * 60_000
  );

  try {
    await prisma.autonomyCourseManifest.create({
      data: {
        alias,
        manifestHash,
        platformId: "test-platform",
        platformCourseRefHash: hash(`course-${suffix}`),
        canonicalLocatorHash: hash(`locator-${suffix}`),
        identityKeyFingerprint: hash(`identity-${suffix}`),
        allowedOrigin: "https://example.test",
        timeZone: "Asia/Shanghai",
        defaultMode: "SHADOW",
        policyVersion: "test.policy.v1",
        enabled: true,
        realPublishEnabled: false
      }
    });
    await issueCourseOperationGovernanceBaseline({
      prisma,
      manifest: governanceManifest(alias, manifestHash),
      version: `${alias}.governance.v1`,
      validFrom: "2026-07-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z"
    });
    const schedule = await prisma.operationSchedule.create({
      data: {
        courseAlias: alias,
        scheduleKey: hash(`schedule-${suffix}`),
        mode: "SHADOW",
        intervalMinutes: 30,
        timeZone: "Asia/Shanghai",
        enabled: true,
        nextRunAt: new Date(
          "2026-07-05T09:00:00.000Z"
        ),
        budgetJson: JSON.stringify({
          containsForumText: false
        })
      }
    });
    const invocation =
      await prisma.scheduledInvocation.create({
        data: {
          invocationKey: hash(`invocation-${suffix}`),
          courseAlias: alias,
          scheduleId: schedule.id,
          manifestHash,
          scheduledFor: start,
          mode: "SHADOW",
          status: "completed",
          phase: "completed",
          attempt: 1,
          startedAt: start,
          finishedAt: new Date(
            start.getTime() + 60_000
          ),
          summaryJson: JSON.stringify({
            containsForumText: false
          })
        }
      });
    const scan = await prisma.courseScanRun.create({
      data: {
        invocationId: invocation.id,
        courseAlias: alias,
        scanKey: hash(`scan-${suffix}`),
        status: "completed",
        sourceKind: "test_read_only",
        cursorJson: JSON.stringify({
          state: "complete",
          containsForumText: false
        }),
        coverageJson: JSON.stringify({
          complete: true,
          containsForumText: false
        }),
        coverageHash: hash(`coverage-${suffix}`),
        sourceReceiptHash: hash(`receipt-${suffix}`),
        observedEventCount: 1,
        newEventCount: 1,
        failedTargetCount: 0,
        startedAt: start,
        finishedAt: new Date(
          start.getTime() + 60_000
        )
      }
    });
    await prisma.courseEvent.create({
      data: {
        courseAlias: alias,
        scanRunId: scan.id,
        eventKey: rootEventKey,
        threadKey,
        actorKey: authorKey,
        parentEventKey: null,
        kind: "thread_root",
        actorRelation: "thread_author",
        relationBasis: "stable_actor_match",
        depth: 0,
        occurredAt: start,
        observedAt: start,
        sourceKind: "test_read_only",
        sourceVersionHash: hash(`source-root-${suffix}`),
        targetVersionHash: hash(`target-root-${suffix}`),
        legalityStatus: "admissible"
      }
    });
    const decision = await prisma.autonomyDecision.create({
      data: {
        invocationId: invocation.id,
        courseAlias: alias,
        decisionKey: hash(`decision-${suffix}`),
        threadKey,
        authorKey,
        decision: "draft",
        decisionMode: "DRAFT_ELIGIBLE",
        reasonCode: "test_eligible",
        observationReceiptHash: hash(`obs-${suffix}`),
        opportunityReceiptHash: hash(`opp-${suffix}`),
        evidenceBundleHash: hash(`evidence-${suffix}`),
        intentHash: hash(`intent-${suffix}`),
        moveSpecHash: hash(`move-${suffix}`),
        draftContentHash: hash(`draft-${suffix}`),
        policyVersion: "test.policy.v1",
        worldHash: hash(`world-${suffix}`),
        candidateSetHash: hash(`candidate-${suffix}`),
        evidenceAsOf: new Date(
          start.getTime() + 2 * 60_000
        ),
        decisionJson: JSON.stringify({
          containsForumText: false
        }),
        bodyPersisted: false,
        publishAttempted: true,
        editorWriteAttempted: false,
        createdAt: start
      }
    });
    const permit = await prisma.executionPermit.create({
      data: {
        decisionId: decision.id,
        courseAlias: alias,
        permitKey: hash(`permit-${suffix}`),
        policyVersion: "test.policy.v1",
        targetHash: hash(`target-${suffix}`),
        targetVersionHash: hash(`target-version-${suffix}`),
        contentHash: hash(`content-${suffix}`),
        idempotencyKey: hash(`permit-idem-${suffix}`),
        status: "used",
        expiresAt: new Date(
          publishedAt.getTime() + 5 * 60_000
        ),
        usedAt: publishedAt,
        realPublishEnabled: true
      }
    });
    const remoteReceipt = {
      schemaVersion:
        EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
      permitKey: permit.permitKey,
      idempotencyKey: permit.idempotencyKey,
      targetHash: permit.targetHash,
      targetVersionHash: permit.targetVersionHash,
      contentHash: permit.contentHash,
      state: "confirmed_published",
      observedAt: publishedAt.toISOString(),
      requestedMutationCount: 1,
      sentMutationCount: 1,
      publishAttempted: true,
      realPublishEnabled: true,
      bodyPersisted: false,
      containsForumText: false
    };
    await prisma.executionAttempt.create({
      data: {
        decisionId: decision.id,
        permitId: permit.id,
        mode: "AUTO",
        status: "confirmed_published",
        transport: "test_intercepted_transport",
        idempotencyKey: permit.idempotencyKey,
        receiptJson: JSON.stringify(remoteReceipt),
        remoteOutcomeHash: canonicalProtocolHash(
          EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
          remoteReceipt as unknown as CanonicalJsonValue
        ),
        requestedMutationCount: 1,
        sentMutationCount: 1,
        publishAttempted: true,
        startedAt: publishedAt,
        finishedAt: publishedAt
      }
    });

    const shadowDecision =
      await prisma.autonomyDecision.create({
        data: {
          invocationId: invocation.id,
          courseAlias: alias,
          decisionKey: hash(`shadow-decision-${suffix}`),
          threadKey: hash(`shadow-thread-${suffix}`),
          authorKey: null,
          decision: "draft",
          decisionMode: "DRAFT_ELIGIBLE",
          reasonCode: "test_shadow",
          observationReceiptHash: hash(
            `shadow-obs-${suffix}`
          ),
          opportunityReceiptHash: hash(
            `shadow-opp-${suffix}`
          ),
          evidenceBundleHash: hash(
            `shadow-evidence-${suffix}`
          ),
          policyVersion: "test.policy.v1",
          worldHash: hash(`shadow-world-${suffix}`),
          candidateSetHash: hash(
            `shadow-candidate-${suffix}`
          ),
          evidenceAsOf: start,
          decisionJson: JSON.stringify({
            containsForumText: false
          }),
          bodyPersisted: false,
          publishAttempted: true,
          editorWriteAttempted: true,
          createdAt: new Date(start.getTime() + 1)
        }
      });
    await prisma.executionAttempt.create({
      data: {
        decisionId: shadowDecision.id,
        permitId: null,
        mode: "STAGE",
        status: "staged_not_published",
        transport: "test_intercepted_transport",
        idempotencyKey: hash(`stage-idem-${suffix}`),
        receiptJson: JSON.stringify({
          containsForumText: false
        }),
        requestedMutationCount: 0,
        sentMutationCount: 0,
        publishAttempted: false,
        startedAt: publishedAt,
        finishedAt: publishedAt
      }
    });

    const firstSchedule = await scheduleProximalOutcomes({
      prisma,
      decisionIds: [decision.id, shadowDecision.id]
    });
    assert.equal(firstSchedule.eligiblePublicationCount, 1);
    assert.equal(firstSchedule.createdWindowCount, 2);
    assert.equal(firstSchedule.ineligibleDecisionCount, 1);
    assert.equal(
      await prisma.proximalOutcome.count({
        where: { decisionId: shadowDecision.id }
      }),
      0
    );
    const secondSchedule = await scheduleProximalOutcomes({
      prisma,
      decisionIds: [decision.id, shadowDecision.id]
    });
    assert.equal(secondSchedule.eligiblePublicationCount, 1);
    assert.equal(
      await prisma.proximalOutcome.count({
        where: { decisionId: decision.id }
      }),
      2
    );

    const laterDecision =
      await prisma.autonomyDecision.create({
        data: {
          invocationId: invocation.id,
          courseAlias: alias,
          decisionKey: hash(
            `later-decision-${suffix}`
          ),
          threadKey: hash(`later-thread-${suffix}`),
          authorKey: hash(`later-author-${suffix}`),
          decision: "draft",
          decisionMode: "DRAFT_ELIGIBLE",
          reasonCode: "test_later_eligible",
          observationReceiptHash: hash(
            `later-obs-${suffix}`
          ),
          opportunityReceiptHash: hash(
            `later-opp-${suffix}`
          ),
          evidenceBundleHash: hash(
            `later-evidence-${suffix}`
          ),
          intentHash: hash(`later-intent-${suffix}`),
          moveSpecHash: hash(`later-move-${suffix}`),
          draftContentHash: hash(
            `later-draft-${suffix}`
          ),
          policyVersion: "test.policy.v2",
          worldHash: hash(`later-world-${suffix}`),
          candidateSetHash: hash(
            `later-candidate-${suffix}`
          ),
          evidenceAsOf: new Date(
            start.getTime() + 3 * 60_000
          ),
          decisionJson: JSON.stringify({
            containsForumText: false
          }),
          bodyPersisted: false,
          publishAttempted: true,
          editorWriteAttempted: false,
          createdAt: new Date(start.getTime() + 2)
        }
      });
    const laterPublishedAt = new Date(
      publishedAt.getTime() + 60_000
    );
    const laterPermit =
      await prisma.executionPermit.create({
        data: {
          decisionId: laterDecision.id,
          courseAlias: alias,
          permitKey: hash(`later-permit-${suffix}`),
          policyVersion: "test.policy.v2",
          targetHash: hash(
            `later-target-${suffix}`
          ),
          targetVersionHash: hash(
            `later-target-version-${suffix}`
          ),
          contentHash: hash(
            `later-content-${suffix}`
          ),
          idempotencyKey: hash(
            `later-permit-idem-${suffix}`
          ),
          status: "used",
          expiresAt: new Date(
            laterPublishedAt.getTime() + 5 * 60_000
          ),
          usedAt: laterPublishedAt,
          realPublishEnabled: true
        }
      });
    const laterReceipt = {
      schemaVersion:
        EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
      permitKey: laterPermit.permitKey,
      idempotencyKey: laterPermit.idempotencyKey,
      targetHash: laterPermit.targetHash,
      targetVersionHash: laterPermit.targetVersionHash,
      contentHash: laterPermit.contentHash,
      state: "confirmed_published",
      observedAt: laterPublishedAt.toISOString(),
      requestedMutationCount: 1,
      sentMutationCount: 1,
      publishAttempted: true,
      realPublishEnabled: true,
      bodyPersisted: false,
      containsForumText: false
    };
    await prisma.executionAttempt.create({
      data: {
        decisionId: laterDecision.id,
        permitId: laterPermit.id,
        mode: "AUTO",
        status: "confirmed_published",
        transport: "test_intercepted_transport",
        idempotencyKey: laterPermit.idempotencyKey,
        receiptJson: JSON.stringify(laterReceipt),
        remoteOutcomeHash: canonicalProtocolHash(
          EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
          laterReceipt as unknown as CanonicalJsonValue
        ),
        requestedMutationCount: 1,
        sentMutationCount: 1,
        publishAttempted: true,
        startedAt: laterPublishedAt,
        finishedAt: laterPublishedAt
      }
    });
    const starvationSafeSchedule =
      await scheduleProximalOutcomes({
        prisma,
        decisionIds: [decision.id, laterDecision.id],
        limit: 1
      });
    assert.equal(
      starvationSafeSchedule.createdWindowCount,
      2,
      "已有窗口的最老 decision 不得耗尽建窗 limit"
    );
    assert.equal(
      await prisma.proximalOutcome.count({
        where: { decisionId: laterDecision.id }
      }),
      2
    );

    const coverageInvocation =
      await prisma.scheduledInvocation.create({
        data: {
          invocationKey: hash(
            `coverage-invocation-${suffix}`
          ),
          courseAlias: alias,
          scheduleId: schedule.id,
          manifestHash,
          scheduledFor: r24DueAt,
          mode: "SHADOW",
          status: "completed",
          phase: "completed",
          attempt: 1,
          startedAt: r24DueAt,
          finishedAt: afterR24,
          summaryJson: JSON.stringify({
            containsForumText: false
          })
        }
      });
    const coverageScan =
      await prisma.courseScanRun.create({
        data: {
          invocationId: coverageInvocation.id,
          courseAlias: alias,
          scanKey: hash(`coverage-scan-${suffix}`),
          status: "completed",
          sourceKind: "test_read_only",
          cursorJson: JSON.stringify({
            state: "complete",
            containsForumText: false
          }),
          coverageJson: JSON.stringify({
            complete: true,
            containsForumText: false
          }),
          coverageHash: hash(
            `coverage-later-${suffix}`
          ),
          sourceReceiptHash: hash(
            `receipt-later-${suffix}`
          ),
          observedEventCount: 2,
          newEventCount: 1,
          failedTargetCount: 0,
          startedAt: r24DueAt,
          finishedAt: afterR24
        }
      });
    await prisma.courseEventObservation.create({
      data: {
        scanRunId: coverageScan.id,
        eventKey: rootEventKey,
        observedAt: afterR24,
        sourceKind: "test_read_only",
        sourceVersionHash: hash(`source-root-${suffix}`),
        targetVersionHash: hash(`target-root-${suffix}`),
        revisionKind: "duplicate"
      }
    });
    const targetFact = createCourseStructureNodeFact({
      courseKey,
      subjectKey: threadKey,
      subjectKind: "thread",
      revisionHash: hash(`target-root-${suffix}`),
      occurredAt: start.toISOString(),
      attributes: {
        comment_coverage: "complete",
        source: "cmooc_api"
      }
    });
    await prisma.courseStructureFact.create({
      data: persistedStructureFact(alias, targetFact)
    });
    await prisma.courseStructureFactObservation.create({
      data: {
        scanRunId: coverageScan.id,
        factKey: targetFact.factKey,
        observedAt: afterR24,
        sourceKind: "test_read_only",
        sourceVersionHash: targetFact.revisionHash
      }
    });
    await prisma.courseEvent.create({
      data: {
        courseAlias: alias,
        scanRunId: coverageScan.id,
        eventKey: replyEventKey,
        threadKey,
        actorKey: externalActorKey,
        parentEventKey: rootEventKey,
        kind: "comment",
        actorRelation: "external_human",
        relationBasis: "stable_actor_mismatch",
        depth: 1,
        occurredAt: new Date(
          publishedAt.getTime() + 3 * 60 * 60_000
        ),
        observedAt: afterR24,
        sourceKind: "test_read_only",
        sourceVersionHash: hash(
          `source-reply-${suffix}`
        ),
        targetVersionHash: hash(
          `target-reply-${suffix}`
        ),
        legalityStatus: "admissible"
      }
    });
    const observation =
      await observeDueProximalOutcomes({
        prisma,
        now: afterR24,
        decisionIds: [decision.id]
      });
    assert.equal(observation.observedCount, 1);
    const r24 =
      await prisma.proximalOutcome.findUniqueOrThrow({
        where: {
          decisionId_observationWindow: {
            decisionId: decision.id,
            observationWindow: "R24"
          }
        }
      });
    assert.equal(r24.status, "observed");
    assert.equal(r24.censored, false);
    assert.equal(r24.authorReturned, false);
    assert.equal(r24.replyDepthDelta, 1);
    assert.equal(r24.newAuthorCount, 1);
    const outcomeReceipt = JSON.parse(
      r24.functionUptakeJson
    ) as Record<string, unknown>;
    assert.equal(
      outcomeReceipt.evidenceSource,
      "full_course"
    );
    assert.equal(
      outcomeReceipt.educationalEffectClaimed,
      false
    );
    const outcomeTapeEntry =
      await prisma.decisionTapeEntry.findFirst({
        where: {
          invocationId: invocation.id,
          kind: "proximal_outcome_observed"
        },
        orderBy: { sequence: "desc" }
      });
    assert.ok(outcomeTapeEntry);
    assert.equal(outcomeTapeEntry.containsForumText, false);
    const outcomeTapePayload = JSON.parse(
      outcomeTapeEntry.payloadJson
    ) as Record<string, unknown>;
    assert.equal(outcomeTapePayload.observationWindow, "R24");
    assert.equal(outcomeTapePayload.evidenceSource, "full_course");
    assert.equal(
      outcomeTapePayload.educationalEffectClaimed,
      false
    );
    const outcomeReviewEvent =
      await prisma.reviewEvent.findFirst({
        where: {
          decisionId: decision.id,
          kind: "proximal_outcome_observed"
        }
      });
    assert.ok(outcomeReviewEvent);
    assert.equal(outcomeReviewEvent.outcome, "observed");
    assert.equal(outcomeReviewEvent.containsForumText, false);
    assert.equal(
      JSON.stringify(r24).includes("FORUM_BODY"),
      false
    );
    const r72DueAt = new Date(
      publishedAt.getTime() + 72 * 60 * 60_000
    );
    await prisma.proximalOutcome.update({
      where: {
        decisionId_observationWindow: {
          decisionId: decision.id,
          observationWindow: "R72"
        }
      },
      data: { updatedAt: publishedAt }
    });
    const laterDue = await prisma.proximalOutcome.create({
      data: {
        decisionId: shadowDecision.id,
        observationWindow: "FAIRNESS",
        dueAt: new Date(r72DueAt.getTime() - 60_000),
        status: "pending",
        functionUptakeJson: JSON.stringify({
          containsForumText: false
        }),
        updatedAt: new Date(publishedAt.getTime() + 1)
      }
    });
    const waiting =
      await observeDueProximalOutcomes({
        prisma,
        now: r72DueAt,
        decisionIds: [decision.id, shadowDecision.id],
        limit: 1
      });
    assert.equal(waiting.waitingForCoverageCount, 1);
    const fairSecondPass =
      await observeDueProximalOutcomes({
        prisma,
        now: r72DueAt,
        decisionIds: [decision.id, shadowDecision.id],
        limit: 1
      });
    assert.equal(
      fairSecondPass.censoredCount,
      1,
      "等待覆盖的最老窗口不得在小批次中饿死后续到期窗口"
    );
    assert.equal(
      (
        await prisma.proximalOutcome.findUniqueOrThrow({
          where: { id: laterDue.id }
        })
      ).status,
      "censored"
    );
    const censored =
      await observeDueProximalOutcomes({
        prisma,
        now: new Date(r72DueAt.getTime() + 1),
        coverageGraceMs: 0,
        decisionIds: [decision.id]
      });
    assert.equal(censored.censoredCount, 1);
    const r72 =
      await prisma.proximalOutcome.findUniqueOrThrow({
        where: {
          decisionId_observationWindow: {
            decisionId: decision.id,
            observationWindow: "R72"
          }
        }
      });
    assert.equal(r72.status, "censored");
    assert.equal(r72.censored, true);
    assert.equal(
      r72.missingReason,
      "complete_scan_missing_after_window"
    );

    const expired =
      await prisma.scheduledInvocation.create({
        data: {
          invocationKey: hash(`expired-${suffix}`),
          courseAlias: alias,
          scheduleId: schedule.id,
          manifestHash,
          scheduledFor: new Date(
            afterR24.getTime() + 60_000
          ),
          mode: "SHADOW",
          status: "running",
          phase: "observing",
          leaseOwner: "test-worker",
          leaseExpiresAt: new Date(
            afterR24.getTime() - 60_000
          ),
          heartbeatAt: new Date(
            afterR24.getTime() - 2 * 60_000
          ),
          attempt: 1,
          startedAt: new Date(
            afterR24.getTime() - 3 * 60_000
          )
        }
      });
    const recovery = await recoverExpiredInvocationLeases({
      prisma,
      now: afterR24
    });
    assert.equal(recovery.recoveredCount, 1);
    assert.equal(
      (
        await prisma.scheduledInvocation.findUniqueOrThrow({
          where: { id: expired.id }
        })
      ).status,
      "abandoned"
    );
    assert.equal(
      (
        await recoverExpiredInvocationLeases({
          prisma,
          now: afterR24
        })
      ).recoveredCount,
      0
    );

    const due = await listDueAutonomyInvocations({
      prisma,
      now: new Date(
        afterR24.getTime() + 31 * 60_000
      ),
      resolveManifest: async () =>
        governanceManifest(alias, manifestHash)
    });
    assert.equal(
      due.due.some(
        (entry) =>
          entry.courseAlias === alias &&
          entry.state === "runnable"
      ),
      true
    );
    const health = await getAutonomyRuntimeHealth({
      prisma,
      now: afterR24,
      resolveManifest: async () =>
        governanceManifest(alias, manifestHash)
    });
    assert.equal(health.containsForumText, false);
    assert.equal(health.manifests.enabled >= 1, true);
  } finally {
    await prisma.$disconnect();
  }
});

type CoverageFixture = {
  prisma: PrismaClient;
  decisionId: string;
  alias: string;
  threadKey: string;
  r24: { id: string; dueAt: Date };
  r72: { id: string; dueAt: Date };
  scanFinishedAt: Date;
};

async function createOutcomeCoverageFixture(input: {
  targetCoverage: "complete" | "censored";
  scanFinishedAt: Date;
  includeRootObservation?: boolean;
  courseCoverageComplete?: boolean;
  scanStartedAt?: Date;
}): Promise<CoverageFixture> {
  const { prisma } = await import("../../lib/db");
  await prisma.$connect();
  const suffix = randomUUID().replaceAll("-", "");
  const alias = `autonomy-outcome-coverage-${suffix}`;
  const manifestHash = hash(`manifest-${suffix}`);
  const courseKey = hash(`course-key-${suffix}`);
  const threadKey = hash(`thread-${suffix}`);
  const authorKey = hash(`author-${suffix}`);
  const rootEventKey = hash(`root-${suffix}`);
  const start = new Date("2026-07-01T00:00:00.000Z");
  const publishedAt = new Date("2026-07-01T02:00:00.000Z");

  await prisma.autonomyCourseManifest.create({
    data: {
      alias,
      manifestHash,
      platformId: "test-platform",
      platformCourseRefHash: hash(`course-${suffix}`),
      canonicalLocatorHash: hash(`locator-${suffix}`),
      identityKeyFingerprint: hash(`identity-${suffix}`),
      allowedOrigin: "https://example.test",
      timeZone: "Asia/Shanghai",
      defaultMode: "SHADOW",
      policyVersion: "test.policy.v1",
      enabled: true,
      realPublishEnabled: false
    }
  });
  await issueCourseOperationGovernanceBaseline({
    prisma,
    manifest: governanceManifest(alias, manifestHash),
    version: `${alias}.governance.v1`,
    validFrom: "2026-07-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z"
  });
  const schedule = await prisma.operationSchedule.create({
    data: {
      courseAlias: alias,
      scheduleKey: hash(`schedule-${suffix}`),
      mode: "SHADOW",
      intervalMinutes: 30,
      timeZone: "Asia/Shanghai",
      enabled: true,
      nextRunAt: start,
      budgetJson: JSON.stringify({ containsForumText: false })
    }
  });
  const invocation = await prisma.scheduledInvocation.create({
    data: {
      invocationKey: hash(`invocation-${suffix}`),
      courseAlias: alias,
      scheduleId: schedule.id,
      manifestHash,
      scheduledFor: start,
      mode: "SHADOW",
      status: "completed",
      phase: "completed",
      attempt: 1,
      startedAt: start,
      finishedAt: new Date(start.getTime() + 60_000),
      summaryJson: JSON.stringify({ containsForumText: false })
    }
  });
  const baseScan = await prisma.courseScanRun.create({
    data: {
      invocationId: invocation.id,
      courseAlias: alias,
      scanKey: hash(`scan-${suffix}`),
      status: "completed",
      sourceKind: "test_read_only",
      cursorJson: JSON.stringify({ state: "complete", containsForumText: false }),
      coverageJson: JSON.stringify({ complete: true, containsForumText: false }),
      coverageHash: hash(`coverage-${suffix}`),
      sourceReceiptHash: hash(`receipt-${suffix}`),
      observedEventCount: 1,
      newEventCount: 1,
      failedTargetCount: 0,
      startedAt: start,
      finishedAt: new Date(start.getTime() + 60_000)
    }
  });
  await prisma.courseEvent.create({
    data: {
      courseAlias: alias,
      scanRunId: baseScan.id,
      eventKey: rootEventKey,
      threadKey,
      actorKey: authorKey,
      parentEventKey: null,
      kind: "thread_root",
      actorRelation: "thread_author",
      relationBasis: "stable_actor_match",
      depth: 0,
      occurredAt: start,
      observedAt: start,
      sourceKind: "test_read_only",
      sourceVersionHash: hash(`source-root-${suffix}`),
      targetVersionHash: hash(`target-root-${suffix}`),
      legalityStatus: "admissible"
    }
  });
  const decision = await prisma.autonomyDecision.create({
    data: {
      invocationId: invocation.id,
      courseAlias: alias,
      decisionKey: hash(`decision-${suffix}`),
      threadKey,
      authorKey,
      decision: "draft",
      decisionMode: "DRAFT_ELIGIBLE",
      reasonCode: "test_eligible",
      observationReceiptHash: hash(`obs-${suffix}`),
      opportunityReceiptHash: hash(`opp-${suffix}`),
      evidenceBundleHash: hash(`evidence-${suffix}`),
      intentHash: hash(`intent-${suffix}`),
      moveSpecHash: hash(`move-${suffix}`),
      draftContentHash: hash(`draft-${suffix}`),
      policyVersion: "test.policy.v1",
      worldHash: hash(`world-${suffix}`),
      candidateSetHash: hash(`candidate-${suffix}`),
      evidenceAsOf: new Date(start.getTime() + 2 * 60_000),
      decisionJson: JSON.stringify({ containsForumText: false }),
      bodyPersisted: false,
      publishAttempted: true,
      editorWriteAttempted: false,
      createdAt: start
    }
  });
  const permit = await prisma.executionPermit.create({
    data: {
      decisionId: decision.id,
      courseAlias: alias,
      permitKey: hash(`permit-${suffix}`),
      policyVersion: "test.policy.v1",
      targetHash: hash(`target-${suffix}`),
      targetVersionHash: hash(`target-version-${suffix}`),
      contentHash: hash(`content-${suffix}`),
      idempotencyKey: hash(`permit-idem-${suffix}`),
      status: "used",
      expiresAt: new Date(publishedAt.getTime() + 5 * 60_000),
      usedAt: publishedAt,
      realPublishEnabled: true
    }
  });
  const remoteReceipt = {
    schemaVersion: EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
    permitKey: permit.permitKey,
    idempotencyKey: permit.idempotencyKey,
    targetHash: permit.targetHash,
    targetVersionHash: permit.targetVersionHash,
    contentHash: permit.contentHash,
    state: "confirmed_published",
    observedAt: publishedAt.toISOString(),
    requestedMutationCount: 1,
    sentMutationCount: 1,
    publishAttempted: true,
    realPublishEnabled: true,
    bodyPersisted: false,
    containsForumText: false
  };
  await prisma.executionAttempt.create({
    data: {
      decisionId: decision.id,
      permitId: permit.id,
      mode: "AUTO",
      status: "confirmed_published",
      transport: "test_intercepted_transport",
      idempotencyKey: permit.idempotencyKey,
      receiptJson: JSON.stringify(remoteReceipt),
      remoteOutcomeHash: canonicalProtocolHash(
        EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
        remoteReceipt as unknown as CanonicalJsonValue
      ),
      requestedMutationCount: 1,
      sentMutationCount: 1,
      publishAttempted: true,
      startedAt: publishedAt,
      finishedAt: publishedAt
    }
  });
  const scheduled = await scheduleProximalOutcomes({
    prisma,
    decisionIds: [decision.id]
  });
  assert.equal(scheduled.createdWindowCount, 2);
  const coverageInvocation = await prisma.scheduledInvocation.create({
    data: {
      invocationKey: hash(`coverage-invocation-${suffix}`),
      courseAlias: alias,
      scheduleId: schedule.id,
      manifestHash,
      scheduledFor: input.scanFinishedAt,
      mode: "SHADOW",
      status: "completed",
      phase: "completed",
      attempt: 1,
      startedAt: new Date(input.scanFinishedAt.getTime() - 60_000),
      finishedAt: input.scanFinishedAt,
      summaryJson: JSON.stringify({ containsForumText: false })
    }
  });
  const coverageScan = await prisma.courseScanRun.create({
    data: {
      invocationId: coverageInvocation.id,
      courseAlias: alias,
      scanKey: hash(`coverage-scan-${suffix}`),
      status: "completed",
      sourceKind: "test_read_only",
      cursorJson: JSON.stringify({ state: "partial", containsForumText: false }),
      coverageJson: JSON.stringify({
        complete: input.courseCoverageComplete === true,
        containsForumText: false
      }),
      coverageHash: hash(`coverage-partial-${suffix}`),
      sourceReceiptHash: hash(`receipt-partial-${suffix}`),
      observedEventCount: 1,
      newEventCount: 0,
      failedTargetCount: 1,
      startedAt:
        input.scanStartedAt ??
        new Date(input.scanFinishedAt.getTime() - 60_000),
      finishedAt: input.scanFinishedAt
    }
  });
  if (input.includeRootObservation !== false) {
    await prisma.courseEventObservation.create({
      data: {
        scanRunId: coverageScan.id,
        eventKey: rootEventKey,
        observedAt: input.scanFinishedAt,
        sourceKind: "test_read_only",
        sourceVersionHash: hash(`source-root-${suffix}`),
        targetVersionHash: hash(`target-root-${suffix}`),
        revisionKind: "duplicate"
      }
    });
  }
  const targetFact = createCourseStructureNodeFact({
    courseKey,
    subjectKey: threadKey,
    subjectKind: "thread",
    revisionHash: hash(`target-root-${suffix}`),
    occurredAt: start.toISOString(),
    attributes: {
      comment_coverage: input.targetCoverage,
      source: "cmooc_api"
    }
  });
  const fact = await prisma.courseStructureFact.create({
    data: persistedStructureFact(alias, targetFact)
  });
  await prisma.courseStructureFactObservation.create({
    data: {
      scanRunId: coverageScan.id,
      factKey: fact.factKey,
      observedAt: input.scanFinishedAt,
      sourceKind: "test_read_only",
      sourceVersionHash: fact.revisionHash
    }
  });
  const unrelatedThreadKey = hash(`unrelated-thread-${suffix}`);
  const unrelatedStructureFact = createCourseStructureNodeFact({
    courseKey,
    subjectKey: unrelatedThreadKey,
    subjectKind: "thread",
    revisionHash: hash(`unrelated-revision-${suffix}`),
    occurredAt: start.toISOString(),
    attributes: {
      comment_coverage: "censored",
      source: "cmooc_api"
    }
  });
  const unrelatedFact = await prisma.courseStructureFact.create({
    data: persistedStructureFact(alias, unrelatedStructureFact)
  });
  await prisma.courseStructureFactObservation.create({
    data: {
      scanRunId: coverageScan.id,
      factKey: unrelatedFact.factKey,
      observedAt: input.scanFinishedAt,
      sourceKind: "test_read_only",
      sourceVersionHash: unrelatedFact.revisionHash
    }
  });
  const outcomes = await prisma.proximalOutcome.findMany({
    where: { decisionId: decision.id },
    orderBy: { dueAt: "asc" },
    select: { id: true, dueAt: true }
  });
  return {
    prisma,
    decisionId: decision.id,
    alias,
    threadKey,
    r24: outcomes[0],
    r72: outcomes[1],
    scanFinishedAt: input.scanFinishedAt
  };
}

test("目标线程完整 fact 可越过无关线程删失，并按 outcomeIds 只观察 R24", async () => {
  const publishedAt = new Date("2026-07-01T02:00:00.000Z");
  const r24DueAt = new Date(publishedAt.getTime() + 24 * 60 * 60_000);
  const r72DueAt = new Date(publishedAt.getTime() + 72 * 60 * 60_000);
  const fixture = await createOutcomeCoverageFixture({
    targetCoverage: "complete",
    scanFinishedAt: new Date(r24DueAt.getTime() + 60 * 60_000)
  });
  try {
    const now = new Date(r72DueAt.getTime() + 60 * 60_000);
    const preflight = await preflightDueProximalOutcomes({
      prisma: fixture.prisma,
      now,
      coverageGraceMs: 0,
      decisionIds: [fixture.decisionId]
    });
    assert.equal(preflight.readyCount, 1);
    assert.equal(preflight.wouldCensorCount, 1);
    const r24Preflight = preflight.outcomes.find(
      (entry: { outcomeId: string }) => entry.outcomeId === fixture.r24.id
    );
    assert.deepEqual(r24Preflight, {
      decisionId: fixture.decisionId,
      outcomeId: fixture.r24.id,
      courseAlias: fixture.alias,
      observationWindow: "R24",
      status: "ready",
      evidenceSource: "target_thread"
    });
    const observed = await observeDueProximalOutcomes({
      prisma: fixture.prisma,
      now,
      coverageGraceMs: 0,
      decisionIds: [fixture.decisionId],
      outcomeIds: [fixture.r24.id]
    });
    assert.equal(observed.observedCount, 1);
    assert.equal(observed.censoredCount, 0);
    assert.equal(
      (await fixture.prisma.proximalOutcome.findUniqueOrThrow({ where: { id: fixture.r72.id } })).status,
      "pending"
    );
  } finally {
    await fixture.prisma.$disconnect();
  }
});

test("readyOnly 在预检后证据漂移时保留 pending，绝不改写为 censored", async () => {
  const publishedAt = new Date("2026-07-01T02:00:00.000Z");
  const r24DueAt = new Date(publishedAt.getTime() + 24 * 60 * 60_000);
  const fixture = await createOutcomeCoverageFixture({
    targetCoverage: "complete",
    scanFinishedAt: new Date(r24DueAt.getTime() + 60 * 60_000)
  });
  try {
    const now = new Date(r24DueAt.getTime() + 2 * 60 * 60_000);
    const preflight = await preflightDueProximalOutcomes({
      prisma: fixture.prisma,
      now,
      coverageGraceMs: 0,
      outcomeIds: [fixture.r24.id]
    });
    assert.equal(preflight.readyCount, 1);
    await fixture.prisma.courseStructureFact.updateMany({
      where: {
        courseAlias: fixture.alias,
        subjectKey: fixture.threadKey,
        subjectKind: "thread"
      },
      data: {
        attributesJson: JSON.stringify({
          comment_coverage: "censored",
          source: "cmooc_api"
        })
      }
    });
    const observed = await observeDueProximalOutcomes({
      prisma: fixture.prisma,
      now,
      coverageGraceMs: 0,
      outcomeIds: [fixture.r24.id],
      readyOnly: true
    });
    assert.equal(observed.observedCount, 0);
    assert.equal(observed.censoredCount, 0);
    assert.equal(observed.waitingForCoverageCount, 1);
    const outcome =
      await fixture.prisma.proximalOutcome.findUniqueOrThrow({
        where: { id: fixture.r24.id },
        select: { status: true, censored: true }
      });
    assert.deepEqual(outcome, {
      status: "pending",
      censored: false
    });
  } finally {
    await fixture.prisma.$disconnect();
  }
});

test("证据截止时间可略早于本地 scan 行创建时间，目标证据仍有效", async () => {
  const publishedAt = new Date("2026-07-01T02:00:00.000Z");
  const r24DueAt = new Date(publishedAt.getTime() + 24 * 60 * 60_000);
  const scanFinishedAt = new Date(r24DueAt.getTime() + 60 * 60_000);
  const fixture = await createOutcomeCoverageFixture({
    targetCoverage: "complete",
    scanFinishedAt,
    scanStartedAt: new Date(scanFinishedAt.getTime() + 25)
  });
  try {
    const preflight = await preflightDueProximalOutcomes({
      prisma: fixture.prisma,
      now: new Date(scanFinishedAt.getTime() + 60_000),
      coverageGraceMs: 0,
      outcomeIds: [fixture.r24.id]
    });
    assert.equal(preflight.readyCount, 1);
    assert.equal(
      preflight.outcomes[0]?.evidenceSource,
      "target_thread"
    );
  } finally {
    await fixture.prisma.$disconnect();
  }
});

test("目标线程删失时 preflight 在 grace 后仅报告 would_censor 且不写库", async () => {
  const publishedAt = new Date("2026-07-01T02:00:00.000Z");
  const r24DueAt = new Date(publishedAt.getTime() + 24 * 60 * 60_000);
  const fixture = await createOutcomeCoverageFixture({
    targetCoverage: "censored",
    scanFinishedAt: new Date(r24DueAt.getTime() + 60 * 60_000)
  });
  try {
    const now = new Date(r24DueAt.getTime() + 2 * 60 * 60_000);
    const before = await fixture.prisma.proximalOutcome.findUniqueOrThrow({
      where: { id: fixture.r24.id },
      select: { status: true, updatedAt: true, censored: true }
    });
    const preflight = await preflightDueProximalOutcomes({
      prisma: fixture.prisma,
      now,
      coverageGraceMs: 0,
      decisionIds: [fixture.decisionId]
    });
    assert.equal(preflight.wouldCensorCount, 1);
    assert.deepEqual(preflight.outcomes, [
      {
        decisionId: fixture.decisionId,
        outcomeId: fixture.r24.id,
        courseAlias: fixture.alias,
        observationWindow: "R24",
        status: "would_censor",
        evidenceSource: null
      }
    ]);
    const after = await fixture.prisma.proximalOutcome.findUniqueOrThrow({
      where: { id: fixture.r24.id },
      select: { status: true, updatedAt: true, censored: true }
    });
    assert.deepEqual(after, before);
  } finally {
    await fixture.prisma.$disconnect();
  }
});

test("全课 complete 与目标线程 censored 冲突时仍 fail closed", async () => {
  const publishedAt = new Date("2026-07-01T02:00:00.000Z");
  const r24DueAt = new Date(publishedAt.getTime() + 24 * 60 * 60_000);
  const fixture = await createOutcomeCoverageFixture({
    targetCoverage: "censored",
    courseCoverageComplete: true,
    scanFinishedAt: new Date(r24DueAt.getTime() + 60 * 60_000)
  });
  try {
    const preflight = await preflightDueProximalOutcomes({
      prisma: fixture.prisma,
      now: new Date(r24DueAt.getTime() + 2 * 60 * 60_000),
      coverageGraceMs: 0,
      outcomeIds: [fixture.r24.id]
    });
    assert.equal(preflight.readyCount, 0);
    assert.equal(preflight.wouldCensorCount, 1);
    assert.equal(preflight.outcomes[0]?.evidenceSource, null);
  } finally {
    await fixture.prisma.$disconnect();
  }
});

test("目标 fact 缺少同一扫描的 thread_root observation 时 fail closed", async () => {
  const publishedAt = new Date("2026-07-01T02:00:00.000Z");
  const r24DueAt = new Date(publishedAt.getTime() + 24 * 60 * 60_000);
  const fixture = await createOutcomeCoverageFixture({
    targetCoverage: "complete",
    scanFinishedAt: new Date(r24DueAt.getTime() + 60 * 60_000),
    includeRootObservation: false
  });
  try {
    const preflight = await preflightDueProximalOutcomes({
      prisma: fixture.prisma,
      now: new Date(r24DueAt.getTime() + 2 * 60 * 60_000),
      coverageGraceMs: 0,
      decisionIds: [fixture.decisionId]
    });
    assert.equal(preflight.wouldCensorCount, 1);
    assert.equal(preflight.outcomes[0]?.evidenceSource, null);
  } finally {
    await fixture.prisma.$disconnect();
  }
});
