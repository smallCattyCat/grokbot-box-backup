import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "../../lib/facilitation-protocol";
import {
  COURSE_MANIFEST_SCHEMA_VERSION,
  COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION,
  parseCourseManifest,
  type CourseManifest,
  type CourseManifestTemplate
} from "../../lib/autonomy/course-manifest";
import {
  buildKernelObservation,
  COURSE_SCAN_COVERAGE_SCHEMA_VERSION,
  type AutonomyCourseObserver,
  type CourseScanCoverage
} from "../../lib/autonomy/platform-observer";
import {
  AutonomyTickError,
  runAutonomyTick
} from "../../lib/autonomy/tick";
import {
  createCourseOperationGovernancePolicy,
  issueCourseOperationGovernanceBaseline
} from "../../lib/autonomy/course-operation-governance";
import {
  analyzeTransientSemanticEvidence
} from "../../lib/autonomy/transient-semantic-evidence";
import {
  acquireInvocationLease,
  completeInvocation,
  failInvocation
} from "../../lib/autonomy/invocation-store";
import {
  appendDecisionTapeEntry
} from "../../lib/autonomy/decision-tape";
import {
  normalizeObservedThread
} from "../../lib/world/live-event";
import {
  LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION
} from "../../lib/live-runtime/facilitation-kernel";
import {
  PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION,
  hashPersistedEvidenceQualification
} from "../../lib/workbench/course-evidence-workspace";

const TRANSIENT_MARKER =
  "TRANSIENT_FORUM_BODY_MUST_NEVER_ENTER_AUTONOMY_DB";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifestFor(alias: string): CourseManifest {
  const courseId = "1234567890";
  const template: CourseManifestTemplate = {
    schemaVersion:
      COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION,
    alias,
    platformId: "cmooc.bnu",
    courseIdSha256: sha256(courseId),
    canonicalOrigin: "https://cmooc.example.test",
    canonicalPath: "/cMOOC/course",
    timeZone: "Asia/Shanghai",
    defaultMode: "SHADOW",
    policyVersion: `${alias}.shadow.v1`,
    realPublishEnabled: false
  };
  return parseCourseManifest({
    template,
    sourcePath: `C:\\tmp\\${alias}-course.json`,
    value: {
      schemaVersion: COURSE_MANIFEST_SCHEMA_VERSION,
      alias,
      platformId: "cmooc.bnu",
      courseId,
      canonicalUrl:
        `https://cmooc.example.test/cMOOC/course?courseId=${courseId}&isBack=1`,
      allowedOrigins: ["https://cmooc.example.test"],
      adapterId: "test.adapter.v1",
      timeZone: "Asia/Shanghai",
      defaultMode: "SHADOW",
      policyVersion: `${alias}.shadow.v1`,
      scan: {
        maxThreadsPerTick: 20,
        maxCommentsPerThread: 500,
        pageSize: 50
      },
      budget: {
        dailySlots: 3,
        workloadCost: 1,
        authorTouchLimit30d: 2
      },
      schedule: {
        intervalMinutes: 30,
        leaseSeconds: 120
      },
      realPublishEnabled: false
    }
  });
}

async function createGovernanceBaseline(
  prisma: import("@prisma/client").PrismaClient,
  manifest: CourseManifest
) {
  return issueCourseOperationGovernanceBaseline({
    prisma,
    manifest,
    version: `${manifest.alias}.governance.v1`,
    validFrom: "2026-07-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z"
  });
}

async function acquireBoundInvocationLease(input: {
  prisma: import("@prisma/client").PrismaClient;
  manifest: CourseManifest;
  mode: "OBSERVE" | "SHADOW";
  scheduledFor: Date;
  now: Date;
  leaseOwner: string;
}) {
  const [schedule, governance] = await Promise.all([
    input.prisma.operationSchedule.findFirstOrThrow({
      where: {
        courseAlias: input.manifest.alias,
        enabled: true
      },
      orderBy: { updatedAt: "desc" }
    }),
    input.prisma.courseOperationGovernancePolicy.findFirstOrThrow({
      where: { courseAlias: input.manifest.alias },
      orderBy: { updatedAt: "desc" }
    })
  ]);
  return acquireInvocationLease({
    prisma: input.prisma,
    manifest: input.manifest,
    scheduleId: schedule.id,
    mode: input.mode,
    scheduledFor: input.scheduledFor,
    now: input.now,
    leaseOwner: input.leaseOwner,
    intervalMinutes: Math.max(
      input.manifest.schedule.intervalMinutes,
      governance.minIntervalMinutes
    ),
    governance: {
      policyId: governance.id,
      version: governance.version,
      hash: governance.governanceHash,
      limits: {
        dailySlotLimit: Math.min(
          input.manifest.budget.dailySlots,
          governance.dailySlotLimit
        ),
        perTickActionLimit: Math.min(
          input.manifest.budget.dailySlots,
          governance.perTickActionLimit
        ),
        authorTouchLimit30d: Math.min(
          input.manifest.budget.authorTouchLimit30d,
          governance.authorTouchLimit30d
        ),
        intervalMinutes: Math.max(
          input.manifest.schedule.intervalMinutes,
          governance.minIntervalMinutes
        )
      }
    }
  });
}

class FixedRealDetailObserver implements AutonomyCourseObserver {
  constructor(
    private readonly delayMs = 0,
    private readonly onObserveStarted?: () => void
  ) {}

  async observe(input: {
    manifest: CourseManifest;
    secret: Buffer | string;
    observedAt: string;
  }) {
    this.onObserveStarted?.();
    if (this.delayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.delayMs)
      );
    }
    const normalized = normalizeObservedThread({
      courseAlias: input.manifest.alias,
      secret: input.secret,
      maxComments:
        input.manifest.scan.maxCommentsPerThread,
      thread: {
        courseRef: input.manifest.courseId,
        threadRef: "thread-fixture-1",
        authorRef: "actor-fixture-1",
        occurredAt: "2026-07-01T00:00:00.000Z",
        observedAt: input.observedAt,
        versionMaterial: TRANSIENT_MARKER,
        comments: []
      }
    });
    const uiEvidenceHash = canonicalProtocolHash(
      "cmooc.test-ui-evidence.v1",
      {
        manifestHash: input.manifest.manifestHash,
        observedAt: input.observedAt
      }
    );
    const kernel = buildKernelObservation({
      manifest: input.manifest,
      baselineEvidenceHash: uiEvidenceHash,
      courseShellDetected: true,
      categoryCount: 1,
      visibleCardCount: 1,
      thread: normalized,
      observedAt: input.observedAt,
      completeComments: true,
      secret: input.secret,
      roleByActorKey: new Map()
    });
    const coverage: CourseScanCoverage = {
      schemaVersion: COURSE_SCAN_COVERAGE_SCHEMA_VERSION,
      observedAt: input.observedAt,
      sourceKind: "cmooc_api_plus_read_only_browser",
      apiReadAuthStatus: "anonymous",
      uiStatus: "overview_ready",
      uiEvidenceHash,
      courseShellDetected: true,
      categoryCount: 1,
      categoryCompletedCount: 1,
      pageRequestCount: 1,
      discoveredThreadCount: 1,
      attemptedDetailCount: 1,
      completedDetailCount: 1,
      failedTargetCount: 0,
      observedEventCount: normalized.events.length,
      truncatedThreadListing: false,
      incompleteCommentThreadCount: 0,
      complete: true,
      failureCodeCounts: {},
      recoveryCodeCounts: {},
      roleRegistryStatus: "unavailable",
      roleRegistryMemberCount: 0,
      roleRegistrySnapshotHash: null,
      containsForumText: false
    };
    const coverageHash = canonicalProtocolHash(
      coverage.schemaVersion,
      coverage as unknown as CanonicalJsonValue
    );
    return {
      coverage,
      coverageHash,
      sourceReceiptHash: canonicalProtocolHash(
        "cmooc.test-source-receipt.v1",
        {
          uiEvidenceHash,
          coverageHash,
          containsForumText: false
        }
      ),
      threads: [
        {
          threadKey: normalized.threadKey,
          authorKey: normalized.authorKey,
          targetVersionHash: normalized.targetVersionHash,
          events: normalized.events,
          kernelObservation: kernel.receipt,
          kernelObservationHash: kernel.receiptHash
        }
      ]
    };
  }
}

class SemanticDraftObserver implements AutonomyCourseObserver {
  observeCount = 0;
  private firstTargetVersionHash: string | undefined;

  constructor(
    private readonly rereadMode:
      | "stable"
      | "external_response"
      | "history_superset" = "stable",
    private readonly revisionMode:
      | "none"
      | "ledger_v2_stale"
      | "ledger_v2_current" = "none"
  ) {}

  async observe(input: {
    manifest: CourseManifest;
    secret: Buffer | string;
    observedAt: string;
  }) {
    this.observeCount += 1;
    const threadRef = "semantic-draft-thread-fixture";
    const externalActorRef = "semantic-draft-peer-fixture";
    const includeExternalResponse =
      this.rereadMode === "external_response" &&
      this.observeCount >= 3;
    const includeHistoricalResponse =
      this.rereadMode === "history_superset" &&
      this.observeCount === 1;
    const includeComment =
      includeExternalResponse || includeHistoricalResponse;
    const versionMaterial =
      this.revisionMode === "none"
        ? TRANSIENT_MARKER
        : `${TRANSIENT_MARKER}:v${
            this.observeCount >= 2 ? "2" : "1"
          }`;
    const normalized = normalizeObservedThread({
      courseAlias: input.manifest.alias,
      secret: input.secret,
      maxComments:
        input.manifest.scan.maxCommentsPerThread,
      thread: {
        courseRef: input.manifest.courseId,
        threadRef,
        authorRef: "semantic-draft-learner-fixture",
        occurredAt: "2026-07-01T00:00:00.000Z",
        observedAt: input.observedAt,
        versionMaterial,
        knownExternalHumanActorRefs: includeComment
          ? [externalActorRef]
          : [],
        comments: includeComment
          ? [
              {
                eventRef:
                  includeHistoricalResponse
                    ? "semantic-draft-history-comment-fixture"
                    : "semantic-draft-external-comment-fixture",
                actorRef: externalActorRef,
                parentEventRef: threadRef,
                depth: 0,
                occurredAt: "2026-07-02T00:00:00.000Z",
                versionMaterial: includeHistoricalResponse
                  ? "history-response-v1"
                  : "external-response-v1"
              }
            ]
        : []
      }
    });
    if (this.observeCount === 1) {
      this.firstTargetVersionHash =
        normalized.targetVersionHash;
    }
    const targetVersionHash =
      this.revisionMode === "ledger_v2_stale" &&
      this.observeCount >= 2
        ? this.firstTargetVersionHash ??
          normalized.targetVersionHash
        : normalized.targetVersionHash;
    const kernelThread =
      targetVersionHash === normalized.targetVersionHash
        ? normalized
        : {
            ...normalized,
            targetVersionHash
          };
    assert.ok(normalized.authorKey);
    const uiEvidenceHash = canonicalProtocolHash(
      "cmooc.semantic-draft-ui-evidence.v1",
      {
        manifestHash: input.manifest.manifestHash,
        observedAt: input.observedAt,
        observeCount: this.observeCount
      }
    );
    const kernel = buildKernelObservation({
      manifest: input.manifest,
      baselineEvidenceHash: uiEvidenceHash,
      courseShellDetected: true,
      categoryCount: 1,
      visibleCardCount: 1,
      thread: kernelThread,
      observedAt: input.observedAt,
      completeComments: true,
      secret: input.secret,
      roleByActorKey: new Map([
        [normalized.authorKey, "LEARNER"]
      ])
    });
    assert.ok(kernel.receipt.eventSetHash);
    const semanticEvidence = analyzeTransientSemanticEvidence({
      observationReceiptHash: kernel.receiptHash,
      targetVersionHash,
      eventSetHash: kernel.receipt.eventSetHash,
      observedAt: input.observedAt,
      texts: [
        TRANSIENT_MARKER,
        "我认为这个解释成立，但是如果边界条件改变，结论是否还会保持？为什么？"
      ],
      sequenceCompletion: "open"
    });
    const coverage: CourseScanCoverage = {
      schemaVersion: COURSE_SCAN_COVERAGE_SCHEMA_VERSION,
      observedAt: input.observedAt,
      sourceKind: "cmooc_api_plus_read_only_browser",
      apiReadAuthStatus: "authenticated",
      uiStatus: "overview_ready",
      uiEvidenceHash,
      courseShellDetected: true,
      categoryCount: 1,
      categoryCompletedCount: 1,
      pageRequestCount: 1,
      discoveredThreadCount: 1,
      attemptedDetailCount: 1,
      completedDetailCount: 1,
      failedTargetCount: 0,
      observedEventCount: normalized.events.length,
      truncatedThreadListing: false,
      incompleteCommentThreadCount: 0,
      complete: true,
      failureCodeCounts: {},
      recoveryCodeCounts: {},
      roleRegistryStatus: "complete",
      roleRegistryMemberCount: 1,
      roleRegistrySnapshotHash: canonicalProtocolHash(
        "cmooc.test-role-registry.v1",
        [normalized.authorKey]
      ),
      containsForumText: false
    };
    const coverageHash = canonicalProtocolHash(
      coverage.schemaVersion,
      coverage as unknown as CanonicalJsonValue
    );
    return {
      coverage,
      coverageHash,
      sourceReceiptHash: canonicalProtocolHash(
        "cmooc.semantic-draft-source-receipt.v1",
        {
          uiEvidenceHash,
          coverageHash,
          containsForumText: false
        }
      ),
      threads: [
        {
          threadKey: normalized.threadKey,
          authorKey: normalized.authorKey,
          targetVersionHash,
          events: normalized.events,
          kernelObservation: kernel.receipt,
          kernelObservationHash: kernel.receiptHash,
          semanticEvidence: semanticEvidence.receipt,
          semanticEvidenceHash: semanticEvidence.receiptHash
        }
      ]
    };
  }
}

test("真实详情 shadow tick 幂等、课程级 lease、恢复、FK 与去正文边界", async () => {
  const { prisma } = await import("../../lib/db");
  const manifest = manifestFor("autonomy-integration");
  await createGovernanceBaseline(prisma, manifest);
  let signalObserveStarted: (() => void) | undefined;
  const observeStarted = new Promise<void>((resolve) => {
    signalObserveStarted = resolve;
  });
  const observer = new FixedRealDetailObserver(
    80,
    signalObserveStarted
  );
  const secret = Buffer.alloc(32, 23);
  const firstNow = new Date("2026-07-05T12:00:00.000Z");
  const secondNow = new Date("2026-07-05T12:01:00.000Z");

  try {
    const firstPromise = runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: firstNow
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: secret,
        now: () => new Date(firstNow),
        heartbeatIntervalMs: 10
      }
    );
    await observeStarted;
    await new Promise((resolve) => setTimeout(resolve, 35));
    const activeDuringScan =
      await prisma.scheduledInvocation.findFirstOrThrow({
        where: {
          courseAlias: manifest.alias,
          status: "running"
        },
        orderBy: { scheduledFor: "desc" }
      });
    assert.equal(
      activeDuringScan.phase,
      "observing_active",
      "长扫描期间必须续租并留下活动心跳阶段"
    );
    const first = await firstPromise;
    const firstScan = await prisma.courseScanRun.findUniqueOrThrow({
      where: { invocationId: first.invocationId },
      select: { startedAt: true, finishedAt: true }
    });
    assert.ok(
      firstScan.finishedAt,
      "成功扫描必须记录完成时间"
    );
    assert.ok(
      firstScan.startedAt.getTime() <=
        firstScan.finishedAt.getTime(),
      "扫描 startedAt 不得晚于 finishedAt"
    );
    const boundManifest =
      await prisma.autonomyCourseManifest.findUniqueOrThrow({
        where: { alias: manifest.alias }
      });
    const boundSchedule =
      await prisma.operationSchedule.findFirstOrThrow({
        where: {
          courseAlias: manifest.alias,
          enabled: true
        },
        orderBy: { updatedAt: "desc" }
      });
    const beforeDisabledInvocationCount =
      await prisma.scheduledInvocation.count({
        where: { courseAlias: manifest.alias }
      });
    await prisma.autonomyCourseManifest.update({
      where: { alias: manifest.alias },
      data: { enabled: false }
    });
    await assert.rejects(
      () =>
        runAutonomyTick(
          {
            courseAlias: manifest.alias,
            requestedMode: "shadow",
            scheduledFor: new Date("2026-07-05T12:00:30.000Z")
          },
          {
            prisma,
            manifest,
            observer,
            identitySecret: secret,
            now: () => new Date("2026-07-05T12:00:30.000Z")
          }
        ),
      /AUTONOMY_MANIFEST_DISABLED/
    );
    const afterDisabledManifest =
      await prisma.autonomyCourseManifest.findUniqueOrThrow({
        where: { alias: manifest.alias }
      });
    const afterDisabledManifestSchedule =
      await prisma.operationSchedule.findUniqueOrThrow({
        where: { id: boundSchedule.id }
      });
    assert.equal(afterDisabledManifest.manifestHash, boundManifest.manifestHash);
    assert.equal(afterDisabledManifest.enabled, false);
    assert.equal(afterDisabledManifestSchedule.updatedAt.getTime(), boundSchedule.updatedAt.getTime());
    assert.equal(
      await prisma.scheduledInvocation.count({
        where: { courseAlias: manifest.alias }
      }),
      beforeDisabledInvocationCount
    );
    await prisma.autonomyCourseManifest.update({
      where: { alias: manifest.alias },
      data: { enabled: true }
    });
    await prisma.operationSchedule.update({
      where: { id: boundSchedule.id },
      data: { enabled: false }
    });
    const beforeDisabledScheduleInvocationCount =
      await prisma.scheduledInvocation.count({
        where: { courseAlias: manifest.alias }
      });
    await assert.rejects(
      () =>
        runAutonomyTick(
          {
            courseAlias: manifest.alias,
            requestedMode: "shadow",
            scheduledFor: new Date("2026-07-05T12:00:45.000Z")
          },
          {
            prisma,
            manifest,
            observer,
            identitySecret: secret,
            now: () => new Date("2026-07-05T12:00:45.000Z")
          }
        ),
      /AUTONOMY_SCHEDULE_DISABLED/
    );
    const afterDisabledSchedule =
      await prisma.operationSchedule.findUniqueOrThrow({
        where: { id: boundSchedule.id }
      });
    assert.equal(afterDisabledSchedule.enabled, false);
    assert.equal(
      await prisma.scheduledInvocation.count({
        where: { courseAlias: manifest.alias }
      }),
      beforeDisabledScheduleInvocationCount
    );
    const scheduleCountBeforeGovernanceChange =
      await prisma.operationSchedule.count({
        where: { courseAlias: manifest.alias }
      });
    await createCourseOperationGovernancePolicy({
      prisma,
      manifest,
      policy: {
        schemaVersion: "cmooc.course-operation-governance-policy.v1",
        courseAlias: manifest.alias,
        version: `${manifest.alias}.governance.v2`,
        baseManifestHash: manifest.manifestHash,
        status: "active",
        mode: "SHADOW",
        limits: {
          dailySlotLimit: manifest.budget.dailySlots,
          perTickActionLimit: manifest.budget.dailySlots,
          authorTouchLimit30d: manifest.budget.authorTouchLimit30d,
          minIntervalMinutes: 60
        },
        validFrom: "2026-07-01T00:00:00.000Z",
        validUntil: "2027-01-01T00:00:00.000Z",
        emergencyHalt: false,
        containsForumText: false
      }
    });
    await assert.rejects(
      () =>
        runAutonomyTick(
          {
            courseAlias: manifest.alias,
            requestedMode: "shadow",
            scheduledFor: new Date("2026-07-05T12:00:47.000Z")
          },
          {
            prisma,
            manifest,
            observer,
            identitySecret: secret,
            now: () => new Date("2026-07-05T12:00:47.000Z")
          }
        ),
      /AUTONOMY_SCHEDULE_DISABLED/
    );
    assert.equal(
      await prisma.operationSchedule.count({
        where: { courseAlias: manifest.alias }
      }),
      scheduleCountBeforeGovernanceChange
    );
    await prisma.operationSchedule.update({
      where: { id: boundSchedule.id },
      data: { enabled: true }
    });
    const beforeStaleBindingManifest =
      await prisma.autonomyCourseManifest.findUniqueOrThrow({
        where: { alias: manifest.alias }
      });
    const beforeStaleBindingSchedule =
      await prisma.operationSchedule.findUniqueOrThrow({
        where: { id: boundSchedule.id }
      });
    const beforeStaleBindingInvocationCount =
      await prisma.scheduledInvocation.count({
        where: { courseAlias: manifest.alias }
      });
    await assert.rejects(
      () =>
        runAutonomyTick(
          {
            courseAlias: manifest.alias,
            requestedMode: "shadow",
            scheduledFor: new Date("2026-07-05T12:00:50.000Z"),
            scheduleId: "stale-schedule-id"
          },
          {
            prisma,
            manifest,
            observer,
            identitySecret: secret,
            now: () => new Date("2026-07-05T12:00:50.000Z")
          }
        ),
      /AUTONOMY_SCHEDULE_BINDING_MISMATCH/
    );
    assert.equal(
      (
        await prisma.autonomyCourseManifest.findUniqueOrThrow({
          where: { alias: manifest.alias }
        })
      ).updatedAt.getTime(),
      beforeStaleBindingManifest.updatedAt.getTime()
    );
    assert.equal(
      (
        await prisma.operationSchedule.findUniqueOrThrow({
          where: { id: boundSchedule.id }
        })
      ).updatedAt.getTime(),
      beforeStaleBindingSchedule.updatedAt.getTime()
    );
    assert.equal(
      await prisma.scheduledInvocation.count({
        where: { courseAlias: manifest.alias }
      }),
      beforeStaleBindingInvocationCount
    );
    const second = await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: secondNow
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: secret,
        now: () => new Date(secondNow)
      }
    );

    assert.equal(first.newEventCount, 1);
    assert.equal(second.newEventCount, 0);
    assert.equal(second.graphHash, first.graphHash);
    assert.notEqual(
      second.worldHash,
      first.worldHash,
      "新的可信 cutoff 会推进静默线程时钟"
    );
    assert.equal(first.publishAttemptCount, 0);
    assert.equal(first.editorWriteCount, 0);
    assert.ok(
      first.decisionCounts.abstain +
        first.decisionCounts.wait +
        first.decisionCounts.yield +
        first.decisionCounts.draft >=
        1,
      "至少一个决定必须来自真实详情事件"
    );
    const invocationDecisionIds =
      await prisma.autonomyDecision.findMany({
        where: {
          invocationId: {
            in: [first.invocationId, second.invocationId]
          }
        },
        select: { id: true }
      });
    assert.equal(
      await prisma.executionAttempt.count({
        where: {
          decisionId: {
            in: invocationDecisionIds.map(
              (decision) => decision.id
            )
          }
        }
      }),
      0
    );

    const persisted = JSON.stringify({
      events: await prisma.courseEvent.findMany(),
      observations:
        await prisma.autonomyObservation.findMany(),
      decisions: await prisma.autonomyDecision.findMany(),
      tape: await prisma.decisionTapeEntry.findMany()
    });
    assert.equal(
      persisted.includes(TRANSIENT_MARKER),
      false,
      "自治数据库不得保存瞬态论坛正文"
    );

    const concurrentAt = new Date(
      "2026-07-05T12:02:00.000Z"
    );
    const beforeInvalidSlotCount =
      await prisma.scheduledInvocation.count({
        where: { courseAlias: manifest.alias }
      });
    await assert.rejects(
      () =>
        acquireBoundInvocationLease({
          prisma,
          manifest,
          mode: "SHADOW",
          scheduledFor: new Date("2026-07-05T10:00:00.000Z"),
          now: concurrentAt,
          leaseOwner: "stale-slot-rejected"
        }),
      /AUTONOMY_SCHEDULED_FOR_OUTSIDE_CADENCE/
    );
    await assert.rejects(
      () =>
        acquireBoundInvocationLease({
          prisma,
          manifest,
          mode: "SHADOW",
          scheduledFor: new Date("2026-07-05T12:03:00.000Z"),
          now: concurrentAt,
          leaseOwner: "future-slot-rejected"
        }),
      /AUTONOMY_SCHEDULED_FOR_FUTURE/
    );
    assert.equal(
      await prisma.scheduledInvocation.count({
        where: { courseAlias: manifest.alias }
      }),
      beforeInvalidSlotCount
    );
    const leases = await Promise.all([
      acquireBoundInvocationLease({
        prisma,
        manifest,
        mode: "SHADOW",
        scheduledFor: concurrentAt,
        now: concurrentAt,
        leaseOwner: "worker-a"
      }),
      acquireBoundInvocationLease({
        prisma,
        manifest,
        mode: "SHADOW",
        scheduledFor: concurrentAt,
        now: concurrentAt,
        leaseOwner: "worker-b"
      })
    ]);
    const winners = leases.filter(
      (result) => result.acquired
    );
    assert.equal(winners.length, 1);
    const winner = winners[0];
    assert.ok(winner.acquired);
    await completeInvocation({
      prisma,
      invocationId: winner.invocation.id,
      leaseOwner: winner.leaseOwner,
      summary: {
        schemaVersion: "cmooc.test-complete.v1",
        containsForumText: false
      },
      now: concurrentAt
    });

    const recoveryAt = new Date(
      "2026-07-05T12:03:00.000Z"
    );
    const original = await acquireBoundInvocationLease({
      prisma,
      manifest,
      mode: "SHADOW",
      scheduledFor: recoveryAt,
      now: recoveryAt,
      leaseOwner: "crashed-worker"
    });
    assert.ok(original.acquired);
    await prisma.scheduledInvocation.update({
      where: { id: original.invocation.id },
      data: {
        leaseExpiresAt: new Date(
          recoveryAt.getTime() + 1_000
        )
      }
    });
    const recovered = await acquireBoundInvocationLease({
      prisma,
      manifest,
      mode: "SHADOW",
      scheduledFor: recoveryAt,
      now: new Date(recoveryAt.getTime() + 2_000),
      leaseOwner: "recovery-worker"
    });
    assert.ok(recovered.acquired);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.invocation.attempt, 2);

    await assert.rejects(
      () =>
        appendDecisionTapeEntry({
          prisma,
          invocationId: recovered.invocation.id,
          kind: "invalid_payload",
          payload: {
            content: TRANSIENT_MARKER
          }
        }),
      /禁止字段/
    );
    await assert.rejects(
      () =>
        prisma.courseEvent.create({
          data: {
            courseAlias: manifest.alias,
            scanRunId: "missing-scan-run",
            eventKey: "f".repeat(64),
            threadKey: "e".repeat(64),
            actorKey: null,
            parentEventKey: null,
            kind: "thread_root",
            actorRelation: "thread_author",
            relationBasis: "stable_actor_match",
            depth: 0,
            occurredAt: firstNow,
            observedAt: firstNow,
            sourceKind: "cmooc_api",
            sourceVersionHash: "d".repeat(64),
            targetVersionHash: "c".repeat(64),
            legalityStatus: "admissible"
          }
      }),
      /Foreign key constraint|foreign key/i
    );
    await completeInvocation({
      prisma,
      invocationId: recovered.invocation.id,
      leaseOwner: recovered.leaseOwner,
      summary: {
        schemaVersion: "cmooc.test-complete.v1",
        containsForumText: false
      },
      now: new Date(recoveryAt.getTime() + 3_000)
    });

    const failedAt = new Date(
      "2026-07-05T12:03:30.000Z"
    );
    const failedLease = await acquireBoundInvocationLease({
      prisma,
      manifest,
      mode: "SHADOW",
      scheduledFor: failedAt,
      now: failedAt,
      leaseOwner: "failed-worker"
    });
    assert.ok(failedLease.acquired);
    await failInvocation({
      prisma,
      invocationId: failedLease.invocation.id,
      leaseOwner: failedLease.leaseOwner,
      reasonCode: "test_failure",
      evidenceHash: "9".repeat(64),
      now: new Date(failedAt.getTime() + 1_000)
    });
    const failedRetries = await Promise.all([
      acquireBoundInvocationLease({
        prisma,
        manifest,
        mode: "SHADOW",
        scheduledFor: failedAt,
        now: new Date(failedAt.getTime() + 2_000),
        leaseOwner: "failed-retry-a"
      }),
      acquireBoundInvocationLease({
        prisma,
        manifest,
        mode: "SHADOW",
        scheduledFor: failedAt,
        now: new Date(failedAt.getTime() + 2_000),
        leaseOwner: "failed-retry-b"
      })
    ]);
    const failedRetryWinners = failedRetries.filter(
      (result) => result.acquired
    );
    assert.equal(
      failedRetryWinners.length,
      1,
      "失败 cadence 的并发重试仍只能有一个 lease owner"
    );
    const failedRetryWinner = failedRetryWinners[0];
    assert.ok(failedRetryWinner.acquired);
    assert.equal(failedRetryWinner.recovered, true);
    assert.equal(failedRetryWinner.invocation.attempt, 2);
    await completeInvocation({
      prisma,
      invocationId: failedRetryWinner.invocation.id,
      leaseOwner: failedRetryWinner.leaseOwner,
      summary: {
        schemaVersion: "cmooc.test-complete.v1",
        containsForumText: false
      },
      now: new Date(failedAt.getTime() + 3_000)
    });

    const pendingAt = new Date("2026-07-05T12:03:45.000Z");
    const pendingLease = await acquireBoundInvocationLease({
      prisma,
      manifest,
      mode: "SHADOW",
      scheduledFor: pendingAt,
      now: pendingAt,
      leaseOwner: "pending-crash-worker"
    });
    assert.ok(pendingLease.acquired);
    await prisma.scheduledInvocation.update({
      where: { id: pendingLease.invocation.id },
      data: {
        status: "pending",
        phase: "created",
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        finishedAt: null
      }
    });
    const recoveredPending = await acquireBoundInvocationLease({
      prisma,
      manifest,
      mode: "SHADOW",
      scheduledFor: pendingAt,
      now: new Date("2026-07-05T13:00:00.000Z"),
      leaseOwner: "pending-recovery-worker"
    });
    assert.ok(recoveredPending.acquired);
    assert.equal(recoveredPending.recovered, true);
    await completeInvocation({
      prisma,
      invocationId: recoveredPending.invocation.id,
      leaseOwner: recoveredPending.leaseOwner,
      summary: {
        schemaVersion: "cmooc.test-complete.v1",
        containsForumText: false
      },
      now: new Date("2026-07-05T13:00:01.000Z")
    });

    await assert.rejects(
      () =>
        runAutonomyTick(
          {
            courseAlias: manifest.alias,
            requestedMode: "shadow",
            scheduledFor: new Date(
              "2026-07-05T12:04:00.000Z"
            )
          },
          {
            prisma,
            manifest,
            observer,
            identitySecret: Buffer.alloc(32, 24),
            now: () =>
              new Date("2026-07-05T12:04:00.000Z")
          }
        ),
      /AUTONOMY_IDENTITY_KEY_CHANGED/
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("扫描恢复在时钟回拨与既有 startedAt 下保持完成时间单调", async () => {
  const { prisma } = await import("../../lib/db");
  const manifest = manifestFor(
    `autonomy-scan-clock-regression-${Date.now()}`
  );
  await createGovernanceBaseline(prisma, manifest);
  const firstNow = new Date("2026-07-05T12:00:00.000Z");
  const recoveryNow = new Date("2026-07-05T12:01:00.000Z");
  const recoveredStartedAt = new Date(
    "2026-07-05T12:05:00.000Z"
  );
  let observeCount = 0;
  const successfulObserver = new FixedRealDetailObserver();
  const observer: AutonomyCourseObserver = {
    async observe(input) {
      observeCount += 1;
      if (observeCount === 1) {
        throw new Error("TEST_SCAN_RECOVERY_INTERRUPTION");
      }
      const runningScan =
        await prisma.courseScanRun.findFirstOrThrow({
          where: {
            courseAlias: manifest.alias,
            status: "running"
          }
        });
      assert.equal(
        runningScan.finishedAt,
        null,
        "恢复重入 running upsert 必须清除旧 finishedAt"
      );
      return successfulObserver.observe(input);
    }
  };

  try {
    await assert.rejects(() =>
      runAutonomyTick(
        {
          courseAlias: manifest.alias,
          requestedMode: "shadow",
          scheduledFor: firstNow
        },
        {
          prisma,
          manifest,
          observer,
          identitySecret: Buffer.alloc(32, 34),
          now: () => new Date(firstNow)
        }
      )
    );
    const interruptedScan =
      await prisma.courseScanRun.findFirstOrThrow({
        where: { courseAlias: manifest.alias }
      });
    assert.equal(interruptedScan.status, "running");
    await prisma.courseScanRun.update({
      where: { id: interruptedScan.id },
      data: {
        startedAt: recoveredStartedAt,
        finishedAt: new Date("2026-07-05T12:06:00.000Z")
      }
    });

    await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: firstNow
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: Buffer.alloc(32, 34),
        now: () => new Date(recoveryNow)
      }
    );
    const recoveredScan =
      await prisma.courseScanRun.findUniqueOrThrow({
        where: { id: interruptedScan.id },
        select: { startedAt: true, finishedAt: true }
      });
    assert.equal(
      recoveredScan.startedAt.getTime(),
      recoveredStartedAt.getTime(),
      "恢复不得回写既有 startedAt"
    );
    assert.equal(
      recoveredScan.finishedAt?.getTime(),
      recoveredStartedAt.getTime(),
      "finishedAt 必须至少等于既有 startedAt"
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("完整历史与瞬时语义证据可自然形成 DRAFT，并在同链只读重读后保持零外部效果", async () => {
  const { prisma } = await import("../../lib/db");
  const manifest = manifestFor("autonomy-semantic-draft");
  await createGovernanceBaseline(prisma, manifest);
  const observer = new SemanticDraftObserver();
  const secret = Buffer.alloc(32, 29);
  const firstNow = new Date("2026-07-05T12:00:00.000Z");
  const secondNow = new Date("2026-07-05T12:30:00.000Z");
  const thirdNow = new Date("2026-07-05T13:00:00.000Z");

  try {
    const first = await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: firstNow
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: secret,
        now: () => new Date(firstNow)
      }
    );
    assert.equal(first.decisionCounts.wait, 1);

    const second = await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: secondNow
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: secret,
        now: () => new Date(secondNow)
      }
    );
    assert.equal(second.decisionCounts.draft, 1);
    assert.equal(observer.observeCount, 3);
    assert.equal(second.publishAttemptCount, 0);
    assert.equal(second.editorWriteCount, 0);

    const decision =
      await prisma.autonomyDecision.findFirstOrThrow({
        where: {
          invocationId: second.invocationId,
          decision: "draft"
        }
      });
    const decisionSummary = JSON.parse(decision.decisionJson);
    assert.equal(
      decisionSummary.targetReason,
      "mature_unreplied_root"
    );
    assert.equal(
      decisionSummary.communityProcessGoal,
      "continue_existing_discussion"
    );
    assert.equal(
      decisionSummary.opportunityReceiptSchemaVersion,
      LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION
    );
    assert.equal(
      decisionSummary.qualificationSchemaVersion,
      PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION
    );
    assert.equal(decisionSummary.qualification.formatValid, true);
    assert.equal(decisionSummary.qualification.decision, "qualify");
    assert.equal(
      decisionSummary.qualificationHash,
      hashPersistedEvidenceQualification({
        opportunityReceiptHash: decision.opportunityReceiptHash,
        qualification: decisionSummary.qualification
      })
    );
    assert.equal(
      decisionSummary.revalidationReceipt.decision,
      "EXECUTE"
    );
    assert.equal(
      decisionSummary.revalidationReceipt.shadowContinuationAllowed,
      true
    );
    assert.equal(decisionSummary.editorWriteAttempted, false);
    assert.equal(decisionSummary.publishAttempted, false);
    assert.equal(
      JSON.stringify(decisionSummary).includes(TRANSIENT_MARKER),
      false
    );
    assert.equal(
      await prisma.semanticRealization.count({
        where: { decisionId: decision.id }
      }),
      1
    );
    const revalidationTape =
      await prisma.decisionTapeEntry.findFirst({
        where: {
          invocationId: second.invocationId,
          kind: "target_revalidated"
        }
      });
    assert.ok(revalidationTape);
    assert.equal(
      revalidationTape.payloadJson.includes(TRANSIENT_MARKER),
      false
    );

    const third = await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: thirdNow
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: secret,
        now: () => new Date(thirdNow)
      }
    );
    assert.equal(third.decisionCounts.draft, 0);
    assert.equal(third.decisionCounts.wait, 1);
    assert.equal(
      observer.observeCount,
      4,
      "复用影子提议时只观察，不再执行 DRAFT 写前重读"
    );
    const reusedDecision =
      await prisma.autonomyDecision.findFirstOrThrow({
        where: { invocationId: third.invocationId }
      });
    assert.equal(
      reusedDecision.reasonCode,
      "shadow_draft_unchanged_reused"
    );
    const reusedSummary = JSON.parse(
      reusedDecision.decisionJson
    );
    assert.equal(
      reusedSummary.teachableEpisode.state,
      "shadow_proposed_unchanged"
    );
    assert.equal(
      reusedSummary.teachableEpisode.action,
      "wait"
    );
    assert.equal(
      reusedSummary.teachableEpisode.authorityFootprint
        .humanResponsePriority,
      true
    );
    assert.equal(
      await prisma.semanticRealization.count({
        where: {
          decisionId: {
            in: [decision.id, reusedDecision.id]
          }
        }
      }),
      1,
      "相同目标只能保留首个语义实现"
    );
    const episodeTape =
      await prisma.decisionTapeEntry.findFirst({
        where: {
          invocationId: third.invocationId,
          kind: "teachable_episode_resolved"
        }
      });
    assert.ok(episodeTape);
    assert.equal(
      episodeTape.payloadJson.includes(TRANSIENT_MARKER),
      false
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("完成扫描后的失败重试保留无正文语义回执且不重复扫描", async () => {
  const { prisma } = await import("../../lib/db");
  const manifest = manifestFor(
    `autonomy-semantic-retry-${Date.now()}`
  );
  await createGovernanceBaseline(prisma, manifest);
  const observer = new SemanticDraftObserver();
  const secret = Buffer.alloc(32, 41);
  const firstNow = new Date("2026-07-05T20:00:00.000Z");
  const retryNow = new Date("2026-07-05T20:30:00.000Z");
  const triggerName = "test_fail_world_after_completed_scan";

  try {
    const baseline = await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: firstNow
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: secret,
        now: () => new Date(firstNow)
      }
    );
    assert.equal(baseline.decisionCounts.wait, 1);
    assert.equal(observer.observeCount, 1);

    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "CourseWorldSnapshot" BEGIN SELECT RAISE(ABORT, 'TEST_WORLD_PROJECTION_FAILURE'); END`
    );
    try {
      await assert.rejects(() =>
        runAutonomyTick(
          {
            courseAlias: manifest.alias,
            requestedMode: "shadow",
            scheduledFor: retryNow
          },
          {
            prisma,
            manifest,
            observer,
            identitySecret: secret,
            now: () => new Date(retryNow)
          }
        )
      );
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${triggerName}"`
      );
    }

    assert.equal(
      observer.observeCount,
      2,
      "失败必须发生在第二轮扫描已经完成之后"
    );
    const failedInvocation =
      await prisma.scheduledInvocation.findFirstOrThrow({
        where: {
          courseAlias: manifest.alias,
          scheduledFor: retryNow
        }
      });
    const completedScan = await prisma.courseScanRun.findUniqueOrThrow({
      where: { invocationId: failedInvocation.id }
    });
    assert.equal(completedScan.status, "completed");
    const storedSemantic =
      await prisma.autonomyObservation.findFirstOrThrow({
        where: { invocationId: failedInvocation.id }
      });
    assert.match(storedSemantic.semanticReceiptHash ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(
      storedSemantic.semanticReceiptJson?.includes(TRANSIENT_MARKER),
      false
    );

    const recovered = await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: retryNow
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: secret,
        now: () => new Date(retryNow.getTime() + 2_000)
      }
    );
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.decisionCounts.draft, 1);
    assert.equal(
      observer.observeCount,
      3,
      "重试应复用完成扫描，仅为 DRAFT 写前重读再观察一次"
    );
    assert.equal(recovered.publishAttemptCount, 0);
    assert.equal(recovered.editorWriteCount, 0);
  } finally {
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "${triggerName}"`
    );
    await prisma.$disconnect();
  }
});

test("ledger 根事件升级到 v2 时清除仍绑定 v1 的语义证据", async () => {
  const { prisma } = await import("../../lib/db");
  const manifest = manifestFor(
    `autonomy-semantic-ledger-revision-stale-${Date.now()}`
  );
  await createGovernanceBaseline(prisma, manifest);
  const observer = new SemanticDraftObserver(
    "stable",
    "ledger_v2_stale"
  );
  const secret = Buffer.alloc(32, 35);
  const firstNow = new Date("2026-07-05T17:00:00.000Z");
  const secondNow = new Date("2026-07-05T17:30:00.000Z");

  try {
    const first = await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: firstNow
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: secret,
        now: () => new Date(firstNow)
      }
    );
    assert.equal(first.decisionCounts.wait, 1);

    const second = await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: secondNow
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: secret,
        now: () => new Date(secondNow)
      }
    );
    assert.equal(second.decisionCounts.draft, 0);
    const decision =
      await prisma.autonomyDecision.findFirstOrThrow({
        where: { invocationId: second.invocationId }
      });
    const summary = JSON.parse(decision.decisionJson) as {
      semanticEvidence: unknown;
      semanticEvidenceHash: unknown;
      semanticEvidenceStatus: string;
    };
    assert.equal(summary.semanticEvidence, null);
    assert.equal(summary.semanticEvidenceHash, null);
    assert.equal(summary.semanticEvidenceStatus, "unavailable");

    const root =
      await prisma.courseEvent.findFirstOrThrow({
        where: {
          courseAlias: manifest.alias,
          kind: "thread_root"
        },
        select: { eventKey: true }
      });
    const rootRevisions =
      await prisma.courseEventObservation.findMany({
        where: { eventKey: root.eventKey },
        orderBy: { observedAt: "asc" },
        select: { targetVersionHash: true }
      });
    assert.equal(rootRevisions.length, 2);
    assert.notEqual(
      rootRevisions[0]?.targetVersionHash,
      rootRevisions[1]?.targetVersionHash,
      "测试必须实际产生 v1→v2 ledger revision"
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("ledger 根事件升级到 v2 且观察同步到 v2 时保留 DRAFT 语义链", async () => {
  const { prisma } = await import("../../lib/db");
  const manifest = manifestFor(
    `autonomy-semantic-ledger-revision-current-${Date.now()}`
  );
  await createGovernanceBaseline(prisma, manifest);
  const observer = new SemanticDraftObserver(
    "stable",
    "ledger_v2_current"
  );
  const secret = Buffer.alloc(32, 36);
  const firstNow = new Date("2026-07-05T18:00:00.000Z");
  const secondNow = new Date("2026-07-05T18:30:00.000Z");

  try {
    const first = await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: firstNow
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: secret,
        now: () => new Date(firstNow)
      }
    );
    assert.equal(first.decisionCounts.wait, 1);

    const second = await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: secondNow
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: secret,
        now: () => new Date(secondNow)
      }
    );
    assert.equal(second.decisionCounts.draft, 1);
    const decision =
      await prisma.autonomyDecision.findFirstOrThrow({
        where: {
          invocationId: second.invocationId,
          decision: "draft"
        }
      });
    const summary = JSON.parse(decision.decisionJson) as {
      semanticEvidence: unknown;
      semanticEvidenceHash: unknown;
    };
    assert.ok(summary.semanticEvidence);
    assert.ok(summary.semanticEvidenceHash);

    const root =
      await prisma.courseEvent.findFirstOrThrow({
        where: {
          courseAlias: manifest.alias,
          kind: "thread_root"
        },
        select: { eventKey: true }
      });
    const rootRevisions =
      await prisma.courseEventObservation.findMany({
        where: { eventKey: root.eventKey },
        orderBy: { observedAt: "asc" },
        select: { targetVersionHash: true }
      });
    assert.equal(rootRevisions.length, 2);
    assert.notEqual(
      rootRevisions[0]?.targetVersionHash,
      rootRevisions[1]?.targetVersionHash
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("ledger hydrate 对 partial semantic pair 成对清空", async () => {
  const { prisma } = await import("../../lib/db");
  const manifest = manifestFor(
    `autonomy-semantic-ledger-partial-${Date.now()}`
  );
  await createGovernanceBaseline(prisma, manifest);
  const baseObserver = new SemanticDraftObserver();
  const observer: AutonomyCourseObserver = {
    async observe(input) {
      const observed = await baseObserver.observe(input);
      return {
        ...observed,
        threads: observed.threads.map((thread) => ({
          ...thread,
          semanticEvidenceHash: undefined
        }))
      };
    }
  };
  const now = new Date("2026-07-05T19:00:00.000Z");

  try {
    const result = await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: now
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: Buffer.alloc(32, 37),
        now: () => new Date(now)
      }
    );
    assert.equal(result.decisionCounts.draft, 0);
    const decision =
      await prisma.autonomyDecision.findFirstOrThrow({
        where: { invocationId: result.invocationId }
      });
    const summary = JSON.parse(decision.decisionJson) as {
      semanticEvidence: unknown;
      semanticEvidenceHash: unknown;
    };
    assert.equal(summary.semanticEvidence, null);
    assert.equal(summary.semanticEvidenceHash, null);
  } finally {
    await prisma.$disconnect();
  }
});

test("历史 ledger 超出当前观察前缀时丢弃失配语义并安全降级", async () => {
  const { prisma } = await import("../../lib/db");
  const manifest = manifestFor("autonomy-semantic-ledger-superset");
  await createGovernanceBaseline(prisma, manifest);
  const observer = new SemanticDraftObserver("history_superset");
  const secret = Buffer.alloc(32, 32);
  const firstNow = new Date("2026-07-05T16:00:00.000Z");
  const secondNow = new Date("2026-07-05T16:30:00.000Z");

  try {
    const first = await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: firstNow
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: secret,
        now: () => new Date(firstNow)
      }
    );
    assert.equal(first.publishAttemptCount, 0);
    assert.equal(first.editorWriteCount, 0);

    const second = await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: secondNow
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: secret,
        now: () => new Date(secondNow)
      }
    );
    assert.equal(second.publishAttemptCount, 0);
    assert.equal(second.editorWriteCount, 0);
    assert.equal(second.decisionCounts.draft, 0);
    assert.equal(
      second.decisionCounts.abstain +
        second.decisionCounts.wait +
        second.decisionCounts.yield,
      1
    );

    const decision =
      await prisma.autonomyDecision.findFirstOrThrow({
        where: {
          invocationId: second.invocationId
        }
      });
    const summary = JSON.parse(decision.decisionJson) as {
      semanticEvidence: unknown;
      semanticEvidenceHash: unknown;
      semanticEvidenceStatus: string;
      publishAttempted: boolean;
      editorWriteAttempted: boolean;
      containsForumText: false;
    };
    assert.equal(summary.semanticEvidence, null);
    assert.equal(summary.semanticEvidenceHash, null);
    assert.equal(summary.semanticEvidenceStatus, "unavailable");
    assert.equal(summary.publishAttempted, false);
    assert.equal(summary.editorWriteAttempted, false);
    assert.equal(summary.containsForumText, false);
    assert.equal(
      JSON.stringify(summary).includes(TRANSIENT_MARKER),
      false
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("DRAFT 后第二次只读观察发现外部回应时让位，且仍不产生编辑器或发布动作", async () => {
  const { prisma } = await import("../../lib/db");
  const manifest = manifestFor("autonomy-semantic-yield");
  await createGovernanceBaseline(prisma, manifest);
  const observer = new SemanticDraftObserver(
    "external_response"
  );
  const secret = Buffer.alloc(32, 30);
  const firstNow = new Date("2026-07-05T13:00:00.000Z");
  const secondNow = new Date("2026-07-05T13:30:00.000Z");

  try {
    await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: firstNow
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: secret,
        now: () => new Date(firstNow)
      }
    );
    const second = await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "shadow",
        scheduledFor: secondNow
      },
      {
        prisma,
        manifest,
        observer,
        identitySecret: secret,
        now: () => new Date(secondNow)
      }
    );
    assert.equal(second.decisionCounts.draft, 1);
    assert.equal(second.editorWriteCount, 0);
    assert.equal(second.publishAttemptCount, 0);
    const decision =
      await prisma.autonomyDecision.findFirstOrThrow({
        where: {
          invocationId: second.invocationId,
          decision: "draft"
        }
      });
    const summary = JSON.parse(decision.decisionJson);
    assert.equal(summary.revalidationReceipt.decision, "YIELD");
    assert.equal(
      summary.revalidationReceipt.reasonCode,
      "external_human_response"
    );
    assert.equal(
      summary.revalidationReceipt.shadowContinuationAllowed,
      false
    );
    assert.equal(
      summary.revalidationReceipt.editorWriteAllowed,
      false
    );
    assert.equal(
      summary.revalidationReceipt.publishAllowed,
      false
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("读取鉴权失效 fail closed、留下安全 incident 且不产生外部动作", async () => {
  const { prisma } = await import("../../lib/db");
  const alias = `autonomy-auth-failure-${Date.now()}`;
  const manifest = manifestFor(alias);
  await createGovernanceBaseline(prisma, manifest);
  const identitySecret = Buffer.alloc(32, 31);
  const now = new Date("2026-07-05T15:00:00.000Z");
  const authMarker =
    "AUTH_FAILURE_TRANSIENT_MARKER_MUST_NOT_BE_PERSISTED";
  const observer: AutonomyCourseObserver = {
    async observe() {
      throw new Error(
        `cMOOC API 401 登录态失效 ${authMarker}`
      );
    }
  };

  try {
    let thrown: unknown;
    await assert.rejects(
      () =>
        runAutonomyTick(
          {
            courseAlias: alias,
            requestedMode: "shadow",
            scheduledFor: now
          },
          {
            prisma,
            manifest,
            observer,
            identitySecret,
            now: () => new Date(now)
          }
        ),
      (error: unknown) => {
        thrown = error;
        return (
          error instanceof AutonomyTickError &&
          error.code === "read_auth_unavailable"
        );
      }
    );
    assert.ok(thrown instanceof AutonomyTickError);
    assert.equal(
      (thrown as AutonomyTickError).code,
      "read_auth_unavailable"
    );

    const invocation =
      await prisma.scheduledInvocation.findFirstOrThrow({
        where: { courseAlias: alias },
        orderBy: { createdAt: "desc" }
      });
    assert.equal(invocation.status, "failed");
    const invocationSummary = JSON.parse(
      invocation.summaryJson ?? "{}"
    ) as Record<string, unknown>;
    assert.equal(
      invocationSummary.reasonCode,
      "read_auth_unavailable"
    );
    assert.equal(invocationSummary.containsForumText, false);

    const incidents = await prisma.autonomyIncident.findMany({
      where: { invocationId: invocation.id }
    });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.code, "read_auth_unavailable");
    assert.equal(incidents[0]?.status, "open");
    assert.equal(incidents[0]?.evidenceHash.includes(authMarker), false);
    const incidentSummary = JSON.parse(
      incidents[0]?.summaryJson ?? "{}"
    ) as Record<string, unknown>;
    assert.equal(incidentSummary.reasonCode, "read_auth_unavailable");
    assert.equal(incidentSummary.containsForumText, false);

    const tape = await prisma.decisionTapeEntry.findMany({
      where: { invocationId: invocation.id },
      orderBy: { sequence: "asc" }
    });
    assert.ok(tape.length >= 2);
    assert.equal(
      tape.every((entry) => entry.containsForumText === false),
      true
    );
    assert.equal(
      tape.some((entry) => entry.payloadJson.includes(authMarker)),
      false
    );
    const failureEntry = tape.find(
      (entry) => entry.kind === "invocation_failed"
    );
    assert.ok(failureEntry);
    const failurePayload = JSON.parse(
      failureEntry?.payloadJson ?? "{}"
    ) as Record<string, unknown>;
    assert.equal(failurePayload.reasonCode, "read_auth_unavailable");
    assert.equal(failurePayload.containsForumText, false);

    const scanRuns = await prisma.courseScanRun.findMany({
      where: { invocationId: invocation.id }
    });
    const decisions = await prisma.autonomyDecision.findMany({
      where: { invocationId: invocation.id },
      select: {
        id: true,
        editorWriteAttempted: true,
        publishAttempted: true
      }
    });
    assert.equal(decisions.length, 0);
    const decisionIds = decisions.map((decision) => decision.id);
    assert.equal(
      await prisma.executionStageReceipt.count({
        where: { decisionId: { in: decisionIds } }
      }),
      0
    );
    assert.equal(
      await prisma.executionPermit.count({
        where: { decisionId: { in: decisionIds } }
      }),
      0
    );
    assert.equal(
      await prisma.executionAttempt.count({
        where: { decisionId: { in: decisionIds } }
      }),
      0
    );
    const persisted = JSON.stringify({
      invocation,
      invocationSummary,
      incidents,
      tape,
      scanRuns
    });
    assert.equal(persisted.includes(authMarker), false);
  } finally {
    await prisma.$transaction(async (tx) => {
      await tx.autonomyIncident.deleteMany({
        where: { courseAlias: alias }
      });
      await tx.decisionTapeEntry.deleteMany({
        where: { invocation: { courseAlias: alias } }
      });
      await tx.courseScanRun.deleteMany({
        where: { courseAlias: alias }
      });
      await tx.scheduledInvocation.deleteMany({
        where: { courseAlias: alias }
      });
      await tx.operationSchedule.deleteMany({
        where: { courseAlias: alias }
      });
      await tx.autonomyCourseManifest.deleteMany({
        where: { alias }
      });
    });
    await prisma.$disconnect();
  }
});
