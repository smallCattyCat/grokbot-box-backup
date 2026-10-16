import assert from "node:assert/strict";
import test from "node:test";
import {
  COURSE_OPERATION_GOVERNANCE_SCHEMA_VERSION,
  assessCourseOperationGovernanceIntegrity,
  CourseOperationGovernanceError,
  courseOperationGovernanceCurrentOrderBy,
  createCourseOperationGovernancePolicy,
  currentCourseOperationGovernanceHashes,
  hashCourseOperationGovernancePolicy,
  issueCourseOperationGovernanceBaseline,
  loadCurrentCourseOperationGovernanceBinding,
  loadCourseOperationGovernance,
  parseCourseOperationGovernancePolicy,
  safeGovernanceSummary,
  safeCourseOperationGovernanceState,
  validateCourseOperationGovernancePolicy,
  verifyCourseOperationGovernanceRecord,
  type CourseOperationGovernancePolicy
} from "../../lib/autonomy/course-operation-governance";
import type { CourseManifest } from "../../lib/autonomy/course-manifest";

const manifest = {
  schemaVersion: "cmooc.course-manifest.v1",
  alias: "governance-test",
  platformId: "cmooc.bnu",
  courseId: "1234567890",
  courseIdSha256: "a".repeat(64),
  canonicalUrl: "https://example.test/course",
  allowedOrigins: ["https://example.test"],
  adapterId: "test",
  timeZone: "UTC",
  defaultMode: "SHADOW",
  policyVersion: "test.shadow.v1",
  scan: { maxThreadsPerTick: 10, maxCommentsPerThread: 10, pageSize: 10 },
  budget: { dailySlots: 4, workloadCost: 1, authorTouchLimit30d: 3 },
  schedule: { intervalMinutes: 30, leaseSeconds: 30 },
  realPublishEnabled: false,
  manifestHash: "b".repeat(64),
  sourcePath: "C:\\tmp\\governance-test-course.json"
} as CourseManifest;

function policy(overrides: Partial<CourseOperationGovernancePolicy> = {}) {
  return {
    schemaVersion: COURSE_OPERATION_GOVERNANCE_SCHEMA_VERSION,
    courseAlias: manifest.alias,
    version: "baseline.v1",
    baseManifestHash: manifest.manifestHash,
    status: "active",
    mode: "SHADOW",
    limits: {
      dailySlotLimit: 3,
      perTickActionLimit: 2,
      authorTouchLimit30d: 2,
      minIntervalMinutes: 60
    },
    validFrom: "2026-08-01T00:00:00.000Z",
    validUntil: "2026-09-01T00:00:00.000Z",
    emergencyHalt: false,
    containsForumText: false,
    ...overrides
  } as CourseOperationGovernancePolicy;
}

function recordFromPolicy(value: CourseOperationGovernancePolicy) {
  return {
    id: "governance-record-1",
    courseAlias: value.courseAlias,
    version: value.version,
    baseManifestHash: value.baseManifestHash,
    status: value.status,
    mode: value.mode,
    dailySlotLimit: value.limits.dailySlotLimit,
    perTickActionLimit: value.limits.perTickActionLimit,
    authorTouchLimit30d: value.limits.authorTouchLimit30d,
    minIntervalMinutes: value.limits.minIntervalMinutes,
    validFrom: new Date(value.validFrom),
    validUntil: new Date(value.validUntil),
    emergencyHalt: value.emergencyHalt,
    governanceHash: hashCourseOperationGovernancePolicy(value),
    containsForumText: false,
    createdAt: new Date(value.validFrom),
    updatedAt: new Date(value.validFrom)
  } as any;
}

test("治理策略 exact schema、哈希覆盖状态与 emergency halt", () => {
  const parsed = parseCourseOperationGovernancePolicy(policy());
  const hash = hashCourseOperationGovernancePolicy(parsed);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(
    hashCourseOperationGovernancePolicy({ ...parsed, status: "paused" }),
    hash
  );
  assert.notEqual(
    hashCourseOperationGovernancePolicy({ ...parsed, emergencyHalt: true }),
    hash
  );
  assert.throws(
    () => parseCourseOperationGovernancePolicy({ ...parsed, body: "secret" }),
    /未允许字段/
  );
  assert.throws(
    () => parseCourseOperationGovernancePolicy({ ...parsed, mode: "AUTO" }),
    /OBSERVE 或 SHADOW/
  );
});

test("治理只收紧 manifest，预算取 min、间隔取 max", () => {
  const parsed = parseCourseOperationGovernancePolicy(policy());
  assert.deepEqual(
    validateCourseOperationGovernancePolicy({ policy: parsed, manifest }),
    {
      dailySlotLimit: 3,
      perTickActionLimit: 2,
      authorTouchLimit30d: 2,
      intervalMinutes: 60
    }
  );
  assert.throws(
    () =>
      validateCourseOperationGovernancePolicy({
        policy: {
          ...parsed,
          limits: { ...parsed.limits, dailySlotLimit: 5 }
        },
        manifest
      }),
    /不能放宽 Manifest/
  );
  assert.throws(
    () =>
      validateCourseOperationGovernancePolicy({
        policy: {
          ...parsed,
          limits: { ...parsed.limits, minIntervalMinutes: 10 }
        },
        manifest
      }),
    /不能快于 Manifest/
  );
});

test("缺失、暂停、撤销、过期、halt 与 Manifest 漂移全部 fail closed", async () => {
  const now = new Date("2026-08-02T12:00:00.000Z");
  const fakePrisma = (record: any) => ({
    courseOperationGovernancePolicy: {
      findFirst: async () => record
    }
  }) as any;

  await assert.rejects(
    () =>
      loadCourseOperationGovernance({
        prisma: fakePrisma(null),
        manifest,
        now
      }),
    (error: unknown) =>
      error instanceof CourseOperationGovernanceError &&
      error.code === "course_operation_governance_missing"
  );
  await assert.rejects(
    () =>
      loadCourseOperationGovernance({
        prisma: fakePrisma(recordFromPolicy(policy())),
        manifest,
        now: new Date("invalid")
      }),
    (error: unknown) =>
      error instanceof CourseOperationGovernanceError &&
      error.code === "course_operation_governance_invalid"
  );

  for (const [state, expected] of [
    ["paused", "course_operation_governance_paused"],
    ["revoked", "course_operation_governance_revoked"]
  ] as const) {
    const value = policy({ status: state });
    await assert.rejects(
      () =>
        loadCourseOperationGovernance({
          prisma: fakePrisma(recordFromPolicy(value)),
          manifest,
          now
        }),
      (error: unknown) =>
        error instanceof CourseOperationGovernanceError &&
        error.code === expected
    );
  }

  const expired = policy({ validUntil: "2026-08-02T00:00:00.000Z" });
  await assert.rejects(
    () =>
      loadCourseOperationGovernance({
        prisma: fakePrisma(recordFromPolicy(expired)),
        manifest,
        now
      }),
    (error: unknown) =>
      error instanceof CourseOperationGovernanceError &&
      error.code === "course_operation_governance_expired"
  );

  const halted = policy({ emergencyHalt: true });
  await assert.rejects(
    () =>
      loadCourseOperationGovernance({
        prisma: fakePrisma(recordFromPolicy(halted)),
        manifest,
        now
      }),
    (error: unknown) =>
      error instanceof CourseOperationGovernanceError &&
      error.code === "course_operation_governance_halted"
  );

  const drifted = recordFromPolicy(policy());
  drifted.baseManifestHash = "c".repeat(64);
  await assert.rejects(
    () =>
      loadCourseOperationGovernance({
        prisma: fakePrisma(drifted),
        manifest,
        now
      }),
    (error: unknown) =>
      error instanceof CourseOperationGovernanceError &&
      error.code === "course_operation_governance_manifest_stale"
  );

  const shadowPolicy = policy({ mode: "SHADOW" });
  const narrowed = await loadCourseOperationGovernance({
    prisma: fakePrisma(recordFromPolicy(shadowPolicy)),
    manifest,
    requestedMode: "OBSERVE",
    now
  });
  assert.equal(narrowed.policy.mode, "SHADOW");

  const observePolicy = policy({ mode: "OBSERVE" });
  await assert.rejects(
    () =>
      loadCourseOperationGovernance({
        prisma: fakePrisma(recordFromPolicy(observePolicy)),
        manifest,
        requestedMode: "SHADOW",
        now
      }),
    (error: unknown) =>
      error instanceof CourseOperationGovernanceError &&
      error.code === "course_operation_governance_mode_not_allowed"
  );
});

test("current policy selection uses a deterministic immutable-event order", async () => {
  let observedOrder: unknown;
  const value = policy();
  const fakePrisma = {
    courseOperationGovernancePolicy: {
      findFirst: async (args: { orderBy: unknown }) => {
        observedOrder = args.orderBy;
        return recordFromPolicy(value);
      }
    }
  } as any;
  await loadCourseOperationGovernance({
    prisma: fakePrisma,
    manifest,
    now: new Date("2026-08-02T12:00:00.000Z"),
    requireExecutable: false
  });
  assert.deepEqual(observedOrder, courseOperationGovernanceCurrentOrderBy());
  assert.deepEqual(observedOrder, [{ createdAt: "desc" }, { id: "desc" }]);
});

test("future rotation does not preempt the currently effective policy", async () => {
  const currentPolicy = policy({ version: "current.v1" });
  const futurePolicy = policy({
    version: "future.v2",
    validFrom: "2026-08-10T00:00:00.000Z",
    validUntil: "2026-10-01T00:00:00.000Z"
  });
  const currentRecord = {
    ...recordFromPolicy(currentPolicy),
    id: "current-record",
    createdAt: new Date("2026-08-01T00:00:00.000Z")
  };
  const futureRecord = {
    ...recordFromPolicy(futurePolicy),
    id: "future-record",
    createdAt: new Date("2026-08-02T00:00:00.000Z")
  };
  const fakePrisma = {
    courseOperationGovernancePolicy: {
      findFirst: async ({ where }: any) => {
        const asOf = where?.validFrom?.lte as Date | undefined;
        if (!asOf) return futureRecord;
        return [futureRecord, currentRecord].find(
          (row) => row.validFrom <= asOf
        ) ?? null;
      }
    }
  } as any;

  const beforeRotation = await loadCourseOperationGovernance({
    prisma: fakePrisma,
    manifest,
    now: new Date("2026-08-02T12:00:00.000Z"),
    requireExecutable: false
  });
  assert.equal(beforeRotation.policy.version, "current.v1");

  const afterRotation = await loadCourseOperationGovernance({
    prisma: fakePrisma,
    manifest,
    now: new Date("2026-08-10T00:00:00.000Z"),
    requireExecutable: false
  });
  assert.equal(afterRotation.policy.version, "future.v2");
});

test("hash-only current governance binding ignores future rows and detects rotation", async () => {
  const currentPolicy = policy({ version: "current.v1" });
  const futurePolicy = policy({
    version: "future.v2",
    validFrom: "2026-08-10T00:00:00.000Z",
    validUntil: "2026-10-01T00:00:00.000Z"
  });
  const currentRecord = {
    ...recordFromPolicy(currentPolicy),
    id: "binding-current-record",
    createdAt: new Date("2026-08-01T00:00:00.000Z")
  };
  const futureRecord = {
    ...recordFromPolicy(futurePolicy),
    id: "binding-future-record",
    createdAt: new Date("2026-08-02T00:00:00.000Z")
  };
  const fakePrisma = {
    courseOperationGovernancePolicy: {
      findFirst: async ({ where }: any) => {
        const asOf = where?.validFrom?.lte as Date | undefined;
        const candidates = [futureRecord, currentRecord].filter(
          (row) =>
            row.courseAlias === where.courseAlias &&
            (!asOf || row.validFrom <= asOf)
        );
        return candidates.sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() ||
            right.id.localeCompare(left.id)
        )[0] ?? null;
      }
    }
  } as any;

  const current = await loadCurrentCourseOperationGovernanceBinding({
    prisma: fakePrisma,
    courseAlias: manifest.alias,
    manifestHash: manifest.manifestHash,
    expectedGovernanceHash: currentRecord.governanceHash,
    now: new Date("2026-08-02T12:00:00.000Z")
  });
  assert.equal(current.record.id, currentRecord.id);
  assert.equal(current.policy.version, "current.v1");
  assert.equal(current.governanceHash, currentRecord.governanceHash);

  await assert.rejects(
    () =>
      loadCurrentCourseOperationGovernanceBinding({
        prisma: fakePrisma,
        courseAlias: manifest.alias,
        manifestHash: manifest.manifestHash,
        expectedGovernanceHash: currentRecord.governanceHash,
        now: new Date("2026-08-10T00:00:00.000Z")
      }),
    (error: unknown) =>
      error instanceof CourseOperationGovernanceError &&
      error.code === "course_operation_governance_hash_mismatch"
  );
});

test("hash-only current governance binding fails closed on unsafe current state", async () => {
  const now = new Date("2026-08-02T12:00:00.000Z");
  const fakePrisma = (record: any) =>
    ({
      courseOperationGovernancePolicy: {
        findFirst: async () => record
      }
    }) as any;

  for (const [value, expected] of [
    [
      policy({ status: "paused" }),
      "course_operation_governance_paused"
    ],
    [
      policy({ status: "revoked" }),
      "course_operation_governance_revoked"
    ],
    [
      policy({ emergencyHalt: true }),
      "course_operation_governance_halted"
    ],
    [
      policy({ validUntil: "2026-08-02T00:00:00.000Z" }),
      "course_operation_governance_expired"
    ]
  ] as const) {
    await assert.rejects(
      () =>
        loadCurrentCourseOperationGovernanceBinding({
          prisma: fakePrisma(recordFromPolicy(value)),
          courseAlias: manifest.alias,
          manifestHash: manifest.manifestHash,
          now
        }),
      (error: unknown) =>
        error instanceof CourseOperationGovernanceError &&
        error.code === expected
    );
  }

  const staleManifestRecord = recordFromPolicy(policy());
  staleManifestRecord.baseManifestHash = "c".repeat(64);
  await assert.rejects(
    () =>
      loadCurrentCourseOperationGovernanceBinding({
        prisma: fakePrisma(staleManifestRecord),
        courseAlias: manifest.alias,
        manifestHash: manifest.manifestHash,
        now
      }),
    (error: unknown) =>
      error instanceof CourseOperationGovernanceError &&
      error.code === "course_operation_governance_manifest_stale"
  );

  const tamperedRecord = recordFromPolicy(policy());
  tamperedRecord.governanceHash = "d".repeat(64);
  await assert.rejects(
    () =>
      loadCurrentCourseOperationGovernanceBinding({
        prisma: fakePrisma(tamperedRecord),
        courseAlias: manifest.alias,
        manifestHash: manifest.manifestHash,
        now
      }),
    (error: unknown) =>
      error instanceof CourseOperationGovernanceError &&
      error.code === "course_operation_governance_invalid"
  );
});

test("只读治理历史每门课程只标记一个 as-of current hash", () => {
  const rows = [
    {
      courseAlias: manifest.alias,
      governanceHash: "3".repeat(64),
      validFrom: new Date("2026-08-10T00:00:00.000Z")
    },
    {
      courseAlias: manifest.alias,
      governanceHash: "2".repeat(64),
      validFrom: new Date("2026-08-02T00:00:00.000Z")
    },
    {
      courseAlias: manifest.alias,
      governanceHash: "1".repeat(64),
      validFrom: new Date("2026-08-01T00:00:00.000Z")
    }
  ];
  assert.deepEqual(
    currentCourseOperationGovernanceHashes(
      rows,
      new Date("2026-08-05T00:00:00.000Z")
    ),
    new Set(["2".repeat(64)])
  );
});

test("baseline 只能显式 issue，同版本 hash 冲突拒绝，摘要无正文", async () => {
  const rows: any[] = [];
  const fakePrisma = {
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
      callback(fakePrisma),
    courseOperationGovernancePolicy: {
      findFirst: async ({ where }: any) =>
        rows.find((row) => row.courseAlias === where.courseAlias) ?? null,
      findUnique: async ({ where }: any) =>
        rows.find(
          (row) =>
            row.courseAlias === where.courseAlias_version.courseAlias &&
            row.version === where.courseAlias_version.version
        ) ?? null,
      create: async ({ data }: any) => {
        const row = {
          id: "baseline-1",
          ...data,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        rows.push(row);
        return row;
      }
    }
  } as any;
  const issued = await issueCourseOperationGovernanceBaseline({
    prisma: fakePrisma,
    manifest,
    version: "baseline.v1",
    validFrom: "2026-08-01T00:00:00.000Z",
    validUntil: "2026-09-01T00:00:00.000Z"
  });
  assert.equal(issued.policy.status, "active");
  assert.equal(issued.policy.mode, "SHADOW");
  assert.equal(safeGovernanceSummary(issued).containsForumText, false);
  assert.equal(JSON.stringify(safeGovernanceSummary(issued)).includes("body"), false);
  await assert.rejects(
    () =>
      issueCourseOperationGovernanceBaseline({
        prisma: fakePrisma,
        manifest: { ...manifest, manifestHash: "d".repeat(64) },
        version: "baseline.v1",
        validFrom: "2026-08-01T00:00:00.000Z",
        validUntil: "2026-09-01T00:00:00.000Z"
      }),
    /治理版本冲突|version_conflict/
  );
});

test("同版本已发行记录任一字段漂移都拒绝幂等返回", async () => {
  const rows: any[] = [];
  const fakePrisma = {
    courseOperationGovernancePolicy: {
      findUnique: async ({ where }: any) =>
        rows.find(
          (row) =>
            row.courseAlias === where.courseAlias_version.courseAlias &&
            row.version === where.courseAlias_version.version
        ) ?? null,
      create: async ({ data }: any) => {
        const row = {
          id: "drift-record-1",
          ...data,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        rows.push(row);
        return row;
      }
    }
  } as any;
  await createCourseOperationGovernancePolicy({
    prisma: fakePrisma,
    manifest,
    policy: policy({ version: "drift.v1" })
  });
  rows[0].dailySlotLimit += 1;
  await assert.rejects(
    () =>
      createCourseOperationGovernancePolicy({
        prisma: fakePrisma,
        manifest,
        policy: policy({ version: "drift.v1" })
      }),
    (error: unknown) =>
      error instanceof CourseOperationGovernanceError &&
      error.code === "course_operation_governance_version_conflict"
  );
});

test("治理记录哈希漂移不能验证为历史 as-of", () => {
  const value = policy();
  const record = recordFromPolicy(value);
  record.governanceHash = "e".repeat(64);
  assert.throws(
    () => verifyCourseOperationGovernanceRecord(record, manifest),
    /HASH_MISMATCH/
  );
});

test("只读状态把哈希漂移、正文标记和 Manifest 漂移排除在 active 之外", () => {
  const value = policy();
  const validRecord = recordFromPolicy(value);
  assert.equal(
    assessCourseOperationGovernanceIntegrity({
      record: validRecord,
      currentManifestHash: manifest.manifestHash
    }).state,
    "valid"
  );
  const stale = safeCourseOperationGovernanceState({
    record: validRecord,
    currentManifestHash: "c".repeat(64),
    now: new Date("2026-08-02T12:00:00.000Z")
  });
  assert.equal(stale.status, "manifest_stale");
  const tampered = recordFromPolicy(value);
  tampered.governanceHash = "f".repeat(64);
  const invalid = safeCourseOperationGovernanceState({
    record: tampered,
    currentManifestHash: manifest.manifestHash,
    now: new Date("2026-08-02T12:00:00.000Z")
  });
  assert.equal(invalid.status, "integrity_invalid");
  const forumMarked = recordFromPolicy(value);
  forumMarked.containsForumText = true;
  const forumIntegrity = assessCourseOperationGovernanceIntegrity({
      record: forumMarked,
      currentManifestHash: manifest.manifestHash
    });
  assert.equal(forumIntegrity.state, "integrity_invalid");
  assert.equal(
    safeCourseOperationGovernanceState({
      record: forumMarked,
      currentManifestHash: manifest.manifestHash,
      now: new Date("2026-08-02T12:00:00.000Z")
    }).containsForumText,
    false
  );
});
