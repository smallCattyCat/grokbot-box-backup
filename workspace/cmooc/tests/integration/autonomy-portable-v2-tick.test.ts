import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "../../lib/facilitation-protocol";
import {
  COURSE_MANIFEST_SCHEMA_VERSION_V2,
  COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION_V2,
  parseCourseManifestV2,
  type CourseManifestV2
} from "../../lib/autonomy/course-manifest";
import {
  buildKernelObservation,
  COURSE_SCAN_COVERAGE_SCHEMA_VERSION,
  type AutonomyCourseObserver,
  type CourseScanCoverage
} from "../../lib/autonomy/platform-observer";
import {
  createAutonomyObserverRegistry
} from "../../lib/autonomy/observer-registry";
import {
  issueCourseOperationGovernanceBaseline
} from "../../lib/autonomy/course-operation-governance";
import { runAutonomyTick } from "../../lib/autonomy/tick";
import { normalizeObservedThread } from "../../lib/world/live-event";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function portableManifest(alias: string): CourseManifestV2 {
  const courseId = `course:opaque:${alias}`;
  const canonicalUrl =
    `https://learning-community.example.test/courses/${alias}`;
  return parseCourseManifestV2({
    sourcePath: `C:\\test\\${alias}-course.json`,
    template: {
      schemaVersion: COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION_V2,
      alias,
      platformId: "learning-community.example",
      adapterId: "learning-community.readonly.v1",
      courseIdHash: sha256(courseId),
      canonicalUrlHash: sha256(canonicalUrl),
      allowedOrigins: ["https://learning-community.example.test"],
      timeZone: "Asia/Shanghai",
      defaultMode: "SHADOW",
      policyVersion: `${alias}.shadow.v1`,
      realPublishEnabled: false
    },
    value: {
      schemaVersion: COURSE_MANIFEST_SCHEMA_VERSION_V2,
      alias,
      platformId: "learning-community.example",
      adapterId: "learning-community.readonly.v1",
      courseId,
      courseIdHash: sha256(courseId),
      canonicalUrl,
      canonicalUrlHash: sha256(canonicalUrl),
      allowedOrigins: ["https://learning-community.example.test"],
      timeZone: "Asia/Shanghai",
      defaultMode: "SHADOW",
      policyVersion: `${alias}.shadow.v1`,
      scan: {
        maxThreadsPerTick: 20,
        maxCommentsPerThread: 200,
        pageSize: 50
      },
      budget: {
        dailySlots: 3,
        workloadCost: 1,
        authorTouchLimit30d: 2
      },
      schedule: { intervalMinutes: 30, leaseSeconds: 120 },
      realPublishEnabled: false
    }
  });
}

function portableObservation(input: {
  manifest: CourseManifestV2;
  observedAt: string;
  secret: Buffer | string;
}) {
  const normalized = normalizeObservedThread({
    courseAlias: input.manifest.alias,
    secret: input.secret,
    maxComments: input.manifest.scan.maxCommentsPerThread,
    thread: {
      courseRef: input.manifest.courseId,
      threadRef: "portable-thread-1",
      authorRef: "portable-learner-1",
      occurredAt: "2026-08-29T10:00:00.000Z",
      observedAt: input.observedAt,
      versionMaterial: "portable synthetic fixture",
      comments: []
    }
  });
  const uiEvidenceHash = canonicalProtocolHash(
    "platform.connector-ui-evidence.v1",
    { observedAt: input.observedAt, containsForumText: false }
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
    sourceKind: "platform_connector_read_only",
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
    roleRegistryMemberCount: 0,
    roleRegistrySnapshotHash: canonicalProtocolHash(
      "platform.connector-role-registry.v1",
      []
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
      "platform.connector-source-receipt.v1",
      { coverageHash, containsForumText: false }
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

test("generic v2 manifest 通过精确 registry 完成零发布 shadow tick", async () => {
  const { prisma } = await import("../../lib/db");
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const manifest = portableManifest(`portable-v2-${suffix}`);
  let factoryCount = 0;
  let observeCount = 0;
  const observer: AutonomyCourseObserver = {
    async observe(input) {
      observeCount += 1;
      assert.equal(input.manifest.manifestHash, manifest.manifestHash);
      assert.equal(input.manifest.courseId, manifest.courseId);
      assert.equal(
        input.manifest.schemaVersion,
        COURSE_MANIFEST_SCHEMA_VERSION_V2
      );
      return portableObservation({
        manifest: input.manifest,
        observedAt: input.observedAt,
        secret: input.secret
      });
    }
  };
  const registry = createAutonomyObserverRegistry([
    {
      platformId: manifest.platformId,
      adapterId: manifest.adapterId,
      factory: ({ manifest: selected }) => {
        factoryCount += 1;
        assert.equal(selected.manifestHash, manifest.manifestHash);
        return observer;
      }
    }
  ]);
  await issueCourseOperationGovernanceBaseline({
    prisma,
    manifest,
    version: `${manifest.alias}.governance.v1`,
    validFrom: "2026-08-01T00:00:00.000Z",
    validUntil: "2027-08-01T00:00:00.000Z"
  });

  try {
    const summary = await runAutonomyTick(
      {
        courseAlias: manifest.alias,
        requestedMode: "SHADOW",
        scheduledFor: "2026-08-29T12:00:00.000Z"
      },
      {
        prisma,
        manifest,
        observerRegistry: registry,
        identitySecret: Buffer.alloc(32, 41),
        now: () => new Date("2026-08-29T12:00:00.000Z")
      }
    );
    assert.equal(summary.status, "completed");
    assert.equal(summary.publishAttemptCount, 0);
    assert.equal(summary.editorWriteCount, 0);
    assert.equal(summary.realPublishEnabled, false);
    assert.equal(factoryCount, 1);
    assert.equal(observeCount, 1);

    const stored =
      await prisma.autonomyCourseManifest.findUniqueOrThrow({
        where: { alias: manifest.alias }
      });
    assert.equal(stored.platformId, manifest.platformId);
    assert.equal(stored.adapterId, manifest.adapterId);
    assert.equal(stored.manifestHash, manifest.manifestHash);
    const scan = await prisma.courseScanRun.findFirstOrThrow({
      where: { courseAlias: manifest.alias }
    });
    assert.equal(scan.sourceKind, "platform_connector_read_only");
    assert.equal(scan.status, "completed");
  } finally {
    await prisma.$disconnect();
  }
});

test("generic v2 未注册 adapter 在平台观察与 manifest 同步前拒绝", async () => {
  const { prisma } = await import("../../lib/db");
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const manifest = portableManifest(`portable-unknown-${suffix}`);
  await issueCourseOperationGovernanceBaseline({
    prisma,
    manifest,
    version: `${manifest.alias}.governance.v1`,
    validFrom: "2026-08-01T00:00:00.000Z",
    validUntil: "2027-08-01T00:00:00.000Z"
  });

  try {
    await assert.rejects(
      runAutonomyTick(
        {
          courseAlias: manifest.alias,
          requestedMode: "SHADOW",
          scheduledFor: "2026-08-29T12:00:00.000Z"
        },
        {
          prisma,
          manifest,
          observerRegistry: createAutonomyObserverRegistry(),
          identitySecret: Buffer.alloc(32, 42),
          now: () => new Date("2026-08-29T12:00:00.000Z")
        }
      ),
      /AUTONOMY_OBSERVER_NOT_REGISTERED/
    );
    assert.equal(
      await prisma.autonomyCourseManifest.count({
        where: { alias: manifest.alias }
      }),
      0
    );
    assert.equal(
      await prisma.scheduledInvocation.count({
        where: { courseAlias: manifest.alias }
      }),
      0
    );
  } finally {
    await prisma.$disconnect();
  }
});
