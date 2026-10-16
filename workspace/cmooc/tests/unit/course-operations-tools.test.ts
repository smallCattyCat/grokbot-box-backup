import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  CANDIDATE_SET_SCHEMA_VERSION,
  type AutonomyCandidateSet
} from "../../lib/autonomy/candidate-set";
import {
  COURSE_OPERATION_GOVERNANCE_SCHEMA_VERSION,
  hashCourseOperationGovernancePolicy,
  type CourseOperationGovernancePolicy
} from "../../lib/autonomy/course-operation-governance";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "../../lib/facilitation-protocol";
import {
  COURSE_TOOL_ENVELOPE_SCHEMA_VERSION,
  assertSafeCourseToolProjection,
  hashCourseScope,
  hashCourseToolValue,
  type CourseToolBusinessInput,
  type CourseToolHandlerResult,
  type CourseToolJsonValue,
  type CourseToolRegistration,
  type ServerToolExecutionContext,
  type ToolExecutionEnvelope
} from "../../lib/course-tools/contracts";
import type { CourseToolVerifierRegistration } from "../../lib/course-tools/verifier-registry";
import {
  COURSE_OPERATIONS_TOOL_SCHEMA_VERSION,
  createDurableCourseOperationArtifactVersionAdapter,
  createCourseOperationsToolRegistrations,
  createCourseOperationsVerifierRegistrations,
  parseCourseScheduleReadOutput,
  parseResearchEvidencePackageOutput,
  parseScheduleReviewBundleOutput,
  type CourseOperationArtifactPointer,
  type CourseOperationArtifactVersionWrite,
  type CreateCourseOperationArtifactVersion
} from "../../lib/course-tools/tools/course-operations";
import {
  normalizeEvidenceRefs,
  serializeSafeDurableValue,
  type WorkbenchDb
} from "../../lib/workbench/durable-ledger";
import { serverContext, sha } from "./course-tool-test-fixtures";

const NOW = "2026-08-12T12:00:00.000Z";
const WORLD_AS_OF = new Date("2026-08-12T11:00:00.000Z");
const MANIFEST_HASH = sha("safe-course-manifest");
const WORLD_HASH = sha("safe-course-world");
const EVENT_SET_HASH = sha("safe-course-events");
const GRAPH_HASH = sha("safe-course-graph");

type StoredArtifact = {
  id: string;
  taskId: string;
  runId: string;
  artifactId: string;
  version: number;
  schemaVersion: string;
  artifactKind: string;
  contentClass: string;
  contentHash: string;
  draftBodyHash: null;
  contentRef: null;
  safeSummary: string;
  metadataJson: string;
  sourceRefsJson: string;
  regenerationRecipeJson: null;
  createdByCallId: string;
  expiresAt: null;
};

type FixtureOptions = {
  duplicateEnabledSchedules?: boolean;
  crossCourseSchedule?: boolean;
  tamperedGovernance?: boolean;
  wakeContainsForumText?: boolean;
  wakeEditorWriteCount?: number;
};

function coverageReceipt() {
  const document = {
    schemaVersion: "cmooc.course-scan-coverage.v5",
    observedAt: WORLD_AS_OF.toISOString(),
    sourceKind: "cmooc_api_plus_read_only_browser",
    apiReadAuthStatus: "authenticated",
    uiStatus: "ready",
    uiEvidenceHash: sha("safe-ui-evidence"),
    courseShellDetected: true,
    categoryCount: 1,
    categoryCompletedCount: 1,
    pageRequestCount: 1,
    discoveredThreadCount: 3,
    completedDetailCount: 2,
    observedEventCount: 4,
    incompleteCommentThreadCount: 1,
    failedTargetCount: 0,
    truncatedThreadListing: false,
    complete: false,
    failureCodeCounts: {},
    containsForumText: false
  };
  return {
    json: JSON.stringify(document),
    hash: canonicalProtocolHash(
      document.schemaVersion,
      document as CanonicalJsonValue
    )
  };
}

function governanceRow(options: FixtureOptions) {
  const policy: CourseOperationGovernancePolicy = {
    schemaVersion: COURSE_OPERATION_GOVERNANCE_SCHEMA_VERSION,
    courseAlias: "safe-course",
    version: "governance-v1",
    baseManifestHash: MANIFEST_HASH,
    status: "active",
    mode: "SHADOW",
    limits: {
      dailySlotLimit: 8,
      perTickActionLimit: 2,
      authorTouchLimit30d: 3,
      minIntervalMinutes: 30
    },
    validFrom: "2026-08-01T00:00:00.000Z",
    validUntil: "2026-09-01T00:00:00.000Z",
    emergencyHalt: false,
    containsForumText: false
  };
  return {
    id: "governance-record-1",
    courseAlias: policy.courseAlias,
    version: policy.version,
    baseManifestHash: policy.baseManifestHash,
    status: policy.status,
    mode: policy.mode,
    dailySlotLimit: policy.limits.dailySlotLimit,
    perTickActionLimit: policy.limits.perTickActionLimit,
    authorTouchLimit30d: policy.limits.authorTouchLimit30d,
    minIntervalMinutes: policy.limits.minIntervalMinutes,
    validFrom: new Date(policy.validFrom),
    validUntil: new Date(policy.validUntil),
    emergencyHalt: policy.emergencyHalt,
    governanceHash: options.tamperedGovernance
      ? sha("tampered-governance")
      : hashCourseOperationGovernancePolicy(policy),
    containsForumText: false
  };
}

function fixture(options: FixtureOptions = {}) {
  const coverage = coverageReceipt();
  const candidateDocument: AutonomyCandidateSet = {
    schemaVersion: CANDIDATE_SET_SCHEMA_VERSION,
    courseAlias: "safe-course",
    worldHash: WORLD_HASH,
    eventSetHash: EVENT_SET_HASH,
    asOfAt: WORLD_AS_OF.toISOString(),
    candidates: [],
    containsForumText: false
  };
  const candidateSetHash = canonicalProtocolHash(
    candidateDocument.schemaVersion,
    candidateDocument as unknown as CanonicalJsonValue
  );
  const calls: Array<{ model: string; method: string; args: unknown }> = [];
  const artifacts = new Map<string, StoredArtifact>();
  const writes: CourseOperationArtifactVersionWrite[] = [];
  const versionByKey = new Map<string, CourseOperationArtifactPointer>();
  const schedules = [
    {
      id: "schedule-1",
      courseAlias: options.crossCourseSchedule ? "other-course" : "safe-course",
      enabled: true,
      mode: "SHADOW",
      intervalMinutes: 30,
      timeZone: "Asia/Shanghai",
      nextRunAt: new Date("2026-08-12T10:00:00.000Z")
    },
    ...(options.duplicateEnabledSchedules
      ? [
          {
            id: "schedule-2",
            courseAlias: "safe-course",
            enabled: true,
            mode: "SHADOW",
            intervalMinutes: 60,
            timeZone: "Asia/Shanghai",
            nextRunAt: new Date("2026-08-12T10:00:00.000Z")
          }
        ]
      : [])
  ];
  const manifest = {
    alias: "safe-course",
    manifestHash: MANIFEST_HASH
  };
  const invocation = {
    id: "invocation-current",
    invocationId: "invocation-current",
    invocationKey: "invocation-key-current",
    courseAlias: "safe-course",
    scheduleId: "schedule-1",
    manifestHash: MANIFEST_HASH,
    status: "completed",
    scheduledFor: new Date("2026-08-12T11:30:00.000Z")
  };
  const snapshot = {
    id: "snapshot-current",
    invocationId: "invocation-current",
    courseAlias: "safe-course",
    asOfAt: WORLD_AS_OF,
    eventSetHash: EVENT_SET_HASH,
    worldHash: WORLD_HASH,
    graphHash: GRAPH_HASH,
    coverageHash: coverage.hash,
    eventCount: 4,
    threadCount: 3,
    actorCount: 3,
    edgeCount: 2,
    openGapCount: 1
  };
  const scan = {
    id: "scan-current",
    invocationId: "invocation-current",
    courseAlias: "safe-course",
    status: "completed",
    coverageJson: coverage.json,
    coverageHash: coverage.hash,
    observedEventCount: 4,
    failedTargetCount: 0,
    finishedAt: new Date("2026-08-12T11:01:00.000Z")
  };
  const candidate = {
    invocationId: "invocation-current",
    snapshotId: "snapshot-current",
    candidateSetHash,
    asOfAt: WORLD_AS_OF,
    candidateCount: 0,
    candidatesJson: JSON.stringify(candidateDocument)
  };
  const record = <T>(model: string, method: string, value: T) =>
    async (args: unknown): Promise<T> => {
      calls.push({ model, method, args });
      return value;
    };
  const db = {
    autonomyCourseManifest: {
      findUnique: record("manifest", "findUnique", manifest)
    },
    scheduledInvocation: {
      findUnique: record("invocation", "findUnique", {
        ...invocation,
        worldSnapshot: {
          id: snapshot.id,
          invocationId: invocation.id,
          courseAlias: invocation.courseAlias
        }
      }),
      findFirst: record("invocation", "findFirst", invocation)
    },
    courseWorldSnapshot: {
      findUnique: record("snapshot", "findUnique", snapshot),
      findMany: record("snapshot", "findMany", [])
    },
    courseScanRun: {
      findUnique: record("scan", "findUnique", scan)
    },
    candidateSet: {
      findUnique: record("candidate", "findUnique", candidate)
    },
    autonomyDecision: {
      findMany: record("decision", "findMany", [])
    },
    threadStateAtCutoff: {
      groupBy: record("thread", "groupBy", [
        { completeness: "complete", _count: { _all: 2 } },
        { completeness: "censored", _count: { _all: 1 } }
      ]),
      aggregate: record("thread", "aggregate", {
        _count: { _all: 1 }
      })
    },
    courseContentGraphSnapshot: {
      findUnique: record("graph", "findUnique", null)
    },
    operationSchedule: {
      findMany: record("schedule", "findMany", schedules),
      create: () => {
        throw new Error("WRITE_METHOD_CALLED:schedule.create");
      },
      update: () => {
        throw new Error("WRITE_METHOD_CALLED:schedule.update");
      },
      delete: () => {
        throw new Error("WRITE_METHOD_CALLED:schedule.delete");
      }
    },
    courseOperationGovernancePolicy: {
      findFirst: record("governance", "findFirst", governanceRow(options))
    },
    autonomyWorkerWakeReceipt: {
      findFirst: record("wake", "findFirst", {
        id: "wake-1",
        status: "completed",
        startedAt: new Date("2026-08-12T11:31:00.000Z"),
        editorWriteCount: options.wakeEditorWriteCount ?? 0,
        publishAttemptCount: 0,
        realPublishEnabled: false,
        containsForumText: options.wakeContainsForumText ?? false
      })
    },
    workbenchArtifactVersionRecord: {
      findUnique: async (args: { where: { id: string } }) => {
        calls.push({ model: "artifact", method: "findUnique", args });
        return artifacts.get(args.where.id) ?? null;
      }
    }
  } as unknown as PrismaClient;

  const createArtifactVersion: CreateCourseOperationArtifactVersion = async (
    write
  ) => {
    writes.push({ ...write, sourceRefs: [...write.sourceRefs] });
    const key = `${write.taskId}\0${write.runId}\0${write.versionKey}`;
    const existing = versionByKey.get(key);
    if (existing) {
      const record = artifacts.get(existing.versionId)!;
      assert.equal(record.contentHash, write.contentHash);
      assert.equal(
        record.metadataJson,
        serializeSafeDurableValue(write.metadata, "metadata")
      );
      return existing;
    }
    const artifactId = `course-operation-artifact-${hashCourseToolValue(
      "course-operation-artifact-id.v1",
      {
        taskId: write.taskId,
        artifactKind: write.artifactKind,
        artifactKey: write.artifactKey
      }
    )}`;
    const versionId = `course-operation-artifact-version-${hashCourseToolValue(
      "course-operation-artifact-version-id.v1",
      {
        taskId: write.taskId,
        runId: write.runId,
        artifactKind: write.artifactKind,
        versionKey: write.versionKey
      }
    )}`;
    const pointer: CourseOperationArtifactPointer = {
      artifactId,
      versionId,
      artifactRef: `artifact:${artifactId}`,
      versionRef: `artifact-version:${versionId}`,
      version: 1,
      contentHash: write.contentHash
    };
    artifacts.set(versionId, {
      id: versionId,
      taskId: write.taskId,
      runId: write.runId,
      artifactId,
      version: 1,
      schemaVersion: COURSE_OPERATIONS_TOOL_SCHEMA_VERSION,
      artifactKind: write.artifactKind,
      contentClass: "safe_aggregate",
      contentHash: write.contentHash,
      draftBodyHash: null,
      contentRef: null,
      safeSummary: write.safeSummary,
      metadataJson: serializeSafeDurableValue(write.metadata, "metadata"),
      sourceRefsJson: serializeSafeDurableValue(
        normalizeEvidenceRefs(write.sourceRefs, "sourceRefs"),
        "sourceRefs"
      ),
      regenerationRecipeJson: null,
      createdByCallId: write.createdByCallId,
      expiresAt: null
    });
    versionByKey.set(key, pointer);
    return pointer;
  };
  return {
    db,
    calls,
    writes,
    artifacts,
    createArtifactVersion,
    candidateSetHash
  };
}

function context(
  overrides: Partial<ServerToolExecutionContext> = {}
): ServerToolExecutionContext {
  return serverContext({
    courseScope: {
      courseId: "server-only-course-id",
      alias: "safe-course",
      manifestHash: MANIFEST_HASH
    },
    now: NOW,
    deadlineAt: "2026-08-12T12:10:00.000Z",
    ...overrides
  });
}

function envelope<I extends CourseToolBusinessInput>(input: {
  context: ServerToolExecutionContext;
  registration: CourseToolRegistration;
  businessInput: I;
}): ToolExecutionEnvelope<I> {
  return {
    schemaVersion: COURSE_TOOL_ENVELOPE_SCHEMA_VERSION,
    callId: input.context.callId,
    taskId: input.context.taskId,
    runId: input.context.runId,
    planRevisionId: input.context.planRevisionId,
    stepId: input.context.stepId,
    courseScope: input.context.courseScope,
    courseScopeHash: hashCourseScope(input.context.courseScope),
    toolName: input.registration.definition.name,
    toolVersion: input.registration.definition.version,
    input: input.businessInput,
    inputHash: hashCourseToolValue("test-course-operation-input.v1", input.businessInput),
    idempotencyKey: input.context.idempotencyKey,
    grantedCapability: input.context.baseCapability,
    policyVersion: input.context.policyVersion,
    attempt: input.context.attempt,
    executionLeaseId: input.context.executionLeaseId,
    leaseGeneration: input.context.leaseGeneration,
    fencingToken: input.context.fencingToken,
    startedAt: input.context.now,
    deadlineAt: input.context.deadlineAt
  };
}

function registration(
  registrations: readonly CourseToolRegistration[],
  name: string
): CourseToolRegistration {
  const found = registrations.find((item) => item.definition.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
}

function verifier(
  registrations: readonly CourseToolVerifierRegistration[],
  name: string
): CourseToolVerifierRegistration {
  const found = registrations.find((item) => item.definition.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
}

async function runHandler(input: {
  registration: CourseToolRegistration;
  context?: ServerToolExecutionContext;
}): Promise<{
  context: ServerToolExecutionContext;
  envelope: ToolExecutionEnvelope;
  result: CourseToolHandlerResult;
}> {
  const executionContext = input.context ?? context();
  const businessInput = input.registration.definition.inputSchema.parse({
    contextRef: "snapshot:snapshot-current"
  });
  const executionEnvelope = envelope({
    context: executionContext,
    registration: input.registration,
    businessInput
  });
  const result = await input.registration.handler({
    input: businessInput,
    context: executionContext,
    envelope: executionEnvelope
  });
  return {
    context: executionContext,
    envelope: executionEnvelope,
    result
  };
}

function assertNoRestrictedProjection(value: unknown): void {
  const forbidden = new Set([
    "body",
    "rawbody",
    "text",
    "rawtext",
    "content",
    "identity",
    "username",
    "displayname",
    "email",
    "secret",
    "token",
    "cookie",
    "credential",
    "url",
    "href",
    "path",
    "courseid",
    "platformid"
  ]);
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (typeof candidate === "string") {
      assert.equal(/https?:\/\//iu.test(candidate), false);
      assert.equal(/(?:[A-Za-z]:\\|\/(?:Users|home|root)\/)/u.test(candidate), false);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate)) {
      assert.equal(forbidden.has(key.replace(/[^A-Za-z0-9]/g, "").toLowerCase()), false, key);
      visit(child);
    }
  };
  visit(value);
}

test("registers exactly three closed non-alias course operation tools", () => {
  const fx = fixture();
  const registrations = createCourseOperationsToolRegistrations({
    prisma: fx.db,
    createArtifactVersion: fx.createArtifactVersion
  });
  assert.deepEqual(
    registrations.map((item) => [
      item.definition.name,
      item.definition.version,
      item.definition.capability,
      item.definition.effect
    ]),
    [
      ["research.evidence_package.prepare", "1", "L1_ARTIFACT", "local_write"],
      ["course.schedule.read", "1", "L0_READ", "read"],
      ["schedule.review_bundle.create", "1", "L1_ARTIFACT", "local_write"]
    ]
  );
  for (const item of registrations) {
    assert.equal(item.defaultForName, true);
    assert.equal(item.definition.verification.required, true);
    assert.throws(() =>
      item.definition.inputSchema.parse({
        contextRef: "snapshot:snapshot-current",
        courseAlias: "model-injected"
      })
    );
  }
});

test("durable artifact adapter reuses an exact immutable version and rejects idempotency drift", async () => {
  const write: CourseOperationArtifactVersionWrite = {
    taskId: "task-fixture-001",
    runId: "run-fixture-001",
    createdByCallId: "call-fixture-001",
    artifactKey: "schedule-review-bundle:safe-course",
    versionKey: "idempotency-fixture-001",
    artifactKind: "schedule_review_bundle",
    contentHash: sha("durable-schedule-review"),
    safeSummary: "Safe deterministic schedule review bundle.",
    metadata: {
      schemaVersion: "safe.schedule-review-metadata.v1",
      reviewHash: sha("durable-schedule-review"),
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false
    },
    sourceRefs: [
      {
        kind: "snapshot",
        id: "snapshot-current",
        hash: WORLD_HASH,
        observedAt: WORLD_AS_OF.toISOString()
      }
    ],
    observedAt: NOW
  };
  const artifactId = `course-operation-artifact-${hashCourseToolValue(
    "course-operation-artifact-id.v1",
    {
      taskId: write.taskId,
      artifactKind: write.artifactKind,
      artifactKey: write.artifactKey
    }
  )}`;
  const versionId = `course-operation-artifact-version-${hashCourseToolValue(
    "course-operation-artifact-version-id.v1",
    {
      taskId: write.taskId,
      runId: write.runId,
      artifactKind: write.artifactKind,
      versionKey: write.versionKey
    }
  )}`;
  const stored: StoredArtifact = {
    id: versionId,
    taskId: write.taskId,
    runId: write.runId,
    artifactId,
    version: 3,
    schemaVersion: COURSE_OPERATIONS_TOOL_SCHEMA_VERSION,
    artifactKind: write.artifactKind,
    contentClass: "safe_aggregate",
    contentHash: write.contentHash,
    draftBodyHash: null,
    contentRef: null,
    safeSummary: write.safeSummary,
    metadataJson: serializeSafeDurableValue(write.metadata, "metadata"),
    sourceRefsJson: serializeSafeDurableValue(
      normalizeEvidenceRefs(write.sourceRefs, "sourceRefs"),
      "sourceRefs"
    ),
    regenerationRecipeJson: null,
    createdByCallId: write.createdByCallId,
    expiresAt: null
  };
  let reads = 0;
  const db = {
    workbenchArtifactVersionRecord: {
      findUnique: async () => {
        reads += 1;
        return stored;
      }
    },
    $transaction: () => {
      throw new Error("CREATE_SHOULD_NOT_RUN_FOR_EXACT_REPLAY");
    }
  } as unknown as WorkbenchDb;
  const adapter = createDurableCourseOperationArtifactVersionAdapter(db);
  const first = await adapter(write);
  const second = await adapter(write);
  assert.deepEqual(first, second);
  assert.equal(first.versionId, versionId);
  assert.equal(first.version, 3);
  assert.equal(reads, 2);
  await assert.rejects(
    adapter({
      ...write,
      metadata: {
        schemaVersion: "safe.schedule-review-metadata.v1",
        reviewHash: sha("drifted-review"),
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      }
    }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "safeCode" in error &&
      (error as { safeCode: string }).safeCode ===
        "COURSE_OPERATION_ARTIFACT_IDEMPOTENCY_CONFLICT"
  );
  for (const drift of [
    { runId: "run-fixture-002" },
    { createdByCallId: "call-fixture-002" },
    { versionKey: "idempotency-fixture-002" }
  ]) {
    await assert.rejects(
      adapter({ ...write, ...drift }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "safeCode" in error &&
        (error as { safeCode: string }).safeCode ===
          "COURSE_OPERATION_ARTIFACT_IDEMPOTENCY_CONFLICT"
    );
  }
});

test("research package uses exact persisted aggregates, writes one bounded artifact, and is deterministic", async () => {
  const fx = fixture();
  const registrations = createCourseOperationsToolRegistrations({
    prisma: fx.db,
    createArtifactVersion: fx.createArtifactVersion
  });
  const tool = registration(registrations, "research.evidence_package.prepare");
  const first = await runHandler({ registration: tool });
  const second = await runHandler({ registration: tool });
  const output = parseResearchEvidencePackageOutput(first.result.output);
  const repeated = parseResearchEvidencePackageOutput(second.result.output);

  assert.equal(output.anchor.courseAlias, "safe-course");
  assert.equal(output.anchor.invocationRef, "invocation-current");
  assert.equal(output.anchor.snapshotRef, "snapshot-current");
  assert.equal(output.anchor.manifestHash, MANIFEST_HASH);
  assert.equal(output.anchor.worldHash, WORLD_HASH);
  assert.equal(output.anchor.eventSetHash, EVENT_SET_HASH);
  assert.equal(output.aggregateCounts.observedUnitCount, 3);
  assert.equal(output.aggregateCounts.eligibleCompleteUnitCount, 2);
  assert.equal(output.aggregateCounts.unsupportedUnitCount, 1);
  assert.equal(output.artifact.contentHash, output.exportSha256);
  assert.equal(output.artifact.versionId, repeated.artifact.versionId);
  assert.equal(output.exportSha256, repeated.exportSha256);
  assert.equal(fx.artifacts.size, 1);
  assert.equal(fx.writes.length, 2);
  assert.equal(fx.writes[0]?.artifactKind, "research_evidence_package");
  assert.equal(fx.writes[0]?.taskId, first.context.taskId);
  assert.equal(fx.writes[0]?.runId, first.context.runId);
  assert.equal(fx.writes[0]?.createdByCallId, first.context.callId);
  assert.equal(fx.writes[0]?.versionKey, first.context.idempotencyKey);
  assert.equal(
    fx.writes[0]?.artifactKey,
    `research-evidence-package:${output.anchor.courseAlias}`
  );
  assert.equal(fx.writes[0]?.sourceRefs.length, 5);
  assert.equal(JSON.stringify(output).includes("exportDocument"), false);
  assert.equal(JSON.stringify(output).includes("exportJson"), false);
  const metadata = JSON.parse(fx.artifacts.get(output.artifact.versionId)!.metadataJson);
  assert.equal(metadata.generatedFrom, "persisted_aggregate_evidence");
  assert.equal(metadata.exportSha256, output.exportSha256);
  assert.equal(metadata.exportDocument.containsForumText, false);
  assert.equal(metadata.exportDocument.containsIdentity, false);
  const projection = tool.projectOutput(output, first.context);
  assertSafeCourseToolProjection(projection);
  assertNoRestrictedProjection(projection.model);
});

test("research artifact verifier freshly recomputes aggregates and rejects a tampered DB version", async () => {
  const fx = fixture();
  const tools = createCourseOperationsToolRegistrations({
    prisma: fx.db,
    createArtifactVersion: fx.createArtifactVersion
  });
  const verifiers = createCourseOperationsVerifierRegistrations({ prisma: fx.db });
  const tool = registration(tools, "research.evidence_package.prepare");
  const check = verifier(verifiers, "verification.research_evidence_package");
  const execution = await runHandler({ registration: tool });
  const passed = await check.verify({
    definition: tool.definition,
    context: execution.context,
    envelope: execution.envelope,
    handlerResult: execution.result
  });
  assert.equal(passed.status, "passed");

  const output = parseResearchEvidencePackageOutput(execution.result.output);
  const pointerTamper = await check.verify({
    definition: tool.definition,
    context: execution.context,
    envelope: execution.envelope,
    handlerResult: {
      ...execution.result,
      output: {
        ...output,
        artifact: {
          ...output.artifact,
          artifactRef: "artifact:foreign-safe-artifact"
        }
      }
    }
  });
  assert.equal(pointerTamper.status, "failed");
  assert.equal(
    pointerTamper.checks.find(
      (item) => item.code === "artifact_record_binding"
    )?.status,
    "failed"
  );

  const anchorTamper = await check.verify({
    definition: tool.definition,
    context: execution.context,
    envelope: execution.envelope,
    handlerResult: {
      ...execution.result,
      output: {
        ...output,
        anchor: {
          ...output.anchor,
          contextRef: "snapshot:foreign-safe-snapshot"
        }
      }
    }
  });
  assert.equal(anchorTamper.status, "failed");
  assert.equal(
    anchorTamper.checks.find(
      (item) => item.code === "fresh_aggregate_replay"
    )?.status,
    "failed"
  );

  const subjectTamper = await check.verify({
    definition: tool.definition,
    context: execution.context,
    envelope: execution.envelope,
    handlerResult: {
      ...execution.result,
      verificationSubject: {
        type: "artifact_version",
        id: "foreign-safe-version"
      }
    }
  });
  assert.equal(subjectTamper.status, "failed");
  assert.equal(
    subjectTamper.checks.find(
      (item) => item.code === "verification_subject_binding"
    )?.status,
    "failed"
  );

  const stored = fx.artifacts.get(output.artifact.versionId)!;
  stored.contentHash = sha("tampered-artifact-content");
  const failed = await check.verify({
    definition: tool.definition,
    context: execution.context,
    envelope: execution.envelope,
    handlerResult: execution.result
  });
  assert.equal(failed.status, "failed");
  assert.equal(
    failed.checks.find((item) => item.code === "artifact_record_binding")?.status,
    "failed"
  );
});

test("schedule read is select-only, exact-manifest bound, deterministic, and verifier replayable", async () => {
  const fx = fixture();
  const tools = createCourseOperationsToolRegistrations({
    prisma: fx.db,
    createArtifactVersion: fx.createArtifactVersion
  });
  const verifiers = createCourseOperationsVerifierRegistrations({ prisma: fx.db });
  const tool = registration(tools, "course.schedule.read");
  const execution = await runHandler({ registration: tool });
  const output = parseCourseScheduleReadOutput(execution.result.output);

  assert.equal(output.anchor.manifestHash, MANIFEST_HASH);
  assert.equal(output.schedule.state, "active");
  assert.equal(output.schedule.scheduleRef, "schedule-1");
  assert.equal(output.schedule.nextWindowAt, "2026-08-12T12:00:00.000Z");
  assert.equal(output.schedule.upcomingWindows.length, 4);
  assert.equal(output.schedule.latestInvocation?.invocationRef, "invocation-current");
  assert.equal(output.schedule.latestWake?.wakeRef, "wake-1");
  assert.equal(output.zeroWriteStatus, "verified");
  assert.equal(output.governanceBoundary.integrityState, "valid");
  assert.equal(output.governanceBoundary.baseManifestHash, MANIFEST_HASH);
  assert.equal(fx.writes.length, 0);
  assert.equal(
    fx.calls.some((call) => /create|update|delete|upsert/i.test(call.method)),
    false
  );
  const calls = JSON.stringify(fx.calls);
  for (const forbidden of [
    "budgetJson",
    "countsJson",
    "summaryJson",
    "platformId",
    "allowedOrigin",
    "canonicalLocatorHash"
  ]) {
    assert.equal(calls.includes(forbidden), false, forbidden);
  }
  const projection = tool.projectOutput(output, execution.context);
  assertSafeCourseToolProjection(projection);
  assertNoRestrictedProjection(projection.model);

  const check = verifier(verifiers, "verification.course_schedule_read");
  const verification = await check.verify({
    definition: tool.definition,
    context: execution.context,
    envelope: execution.envelope,
    handlerResult: execution.result
  });
  assert.equal(verification.status, "passed");
});

test("schedule state fails closed for duplicate schedules, cross-course rows, governance tamper, and privacy sentinels", async () => {
  const cases: Array<{
    options: FixtureOptions;
    code: string;
  }> = [
    {
      options: { duplicateEnabledSchedules: true },
      code: "COURSE_SCHEDULE_AMBIGUOUS"
    },
    {
      options: { crossCourseSchedule: true },
      code: "COURSE_SCHEDULE_STATE_CONFLICT"
    },
    {
      options: { tamperedGovernance: true },
      code: "COURSE_SCHEDULE_GOVERNANCE_TAMPERED"
    },
    {
      options: { wakeContainsForumText: true },
      code: "COURSE_SCHEDULE_WAKE_PRIVACY_CONFLICT"
    }
  ];
  for (const entry of cases) {
    const fx = fixture(entry.options);
    const tool = registration(
      createCourseOperationsToolRegistrations({
        prisma: fx.db,
        createArtifactVersion: fx.createArtifactVersion
      }),
      "course.schedule.read"
    );
    await assert.rejects(
      runHandler({ registration: tool }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "safeCode" in error &&
        (error as { safeCode: string }).safeCode === entry.code
    );
    assert.equal(fx.writes.length, 0);
  }
});

test("schedule review rereads exact state, versions one safe artifact, and detects metadata tamper", async () => {
  const fx = fixture();
  const tools = createCourseOperationsToolRegistrations({
    prisma: fx.db,
    createArtifactVersion: fx.createArtifactVersion
  });
  const verifiers = createCourseOperationsVerifierRegistrations({ prisma: fx.db });
  const tool = registration(tools, "schedule.review_bundle.create");
  const first = await runHandler({ registration: tool });
  const second = await runHandler({ registration: tool });
  const output = parseScheduleReviewBundleOutput(first.result.output);
  const repeated = parseScheduleReviewBundleOutput(second.result.output);

  assert.equal(output.scheduleState, "active");
  assert.equal(output.nextWindows.length, 4);
  assert.equal(output.zeroWriteStatus, "verified");
  assert.equal(output.governanceBoundary.governanceHash, governanceRow({}).governanceHash);
  assert.equal(output.reviewHash, output.artifact.contentHash);
  assert.equal(output.reviewHash, repeated.reviewHash);
  assert.equal(output.artifact.versionId, repeated.artifact.versionId);
  assert.equal(fx.artifacts.size, 1);
  assert.equal(fx.writes[0]?.artifactKind, "schedule_review_bundle");
  assert.equal(fx.writes[0]?.taskId, first.context.taskId);
  assert.equal(fx.writes[0]?.runId, first.context.runId);
  assert.equal(fx.writes[0]?.createdByCallId, first.context.callId);
  assert.equal(fx.writes[0]?.versionKey, first.context.idempotencyKey);
  assert.equal(
    fx.writes[0]?.artifactKey,
    `schedule-review-bundle:${output.anchor.courseAlias}`
  );
  const metadata = JSON.parse(fx.artifacts.get(output.artifact.versionId)!.metadataJson);
  assert.equal(metadata.reviewDocument.containsForumText, false);
  assert.equal(metadata.reviewDocument.containsIdentity, false);
  assert.equal(metadata.reviewDocument.containsSecrets, false);
  assert.equal(metadata.reviewDocument.schedule.latestWake.zeroWrite, true);
  const projection = tool.projectOutput(output, first.context);
  assertSafeCourseToolProjection(projection);
  assertNoRestrictedProjection(projection.model);

  const check = verifier(verifiers, "verification.schedule_review_bundle");
  const passed = await check.verify({
    definition: tool.definition,
    context: first.context,
    envelope: first.envelope,
    handlerResult: first.result
  });
  assert.equal(passed.status, "passed");

  const anchorTamper = await check.verify({
    definition: tool.definition,
    context: first.context,
    envelope: first.envelope,
    handlerResult: {
      ...first.result,
      output: {
        ...output,
        anchor: {
          ...output.anchor,
          worldAsOf: "2026-08-12T11:00:01.000Z"
        }
      }
    }
  });
  assert.equal(anchorTamper.status, "failed");
  assert.equal(
    anchorTamper.checks.find(
      (item) => item.code === "fresh_schedule_replay"
    )?.status,
    "failed"
  );

  const subjectTamper = await check.verify({
    definition: tool.definition,
    context: first.context,
    envelope: first.envelope,
    handlerResult: {
      ...first.result,
      verificationSubject: {
        type: "artifact_version",
        id: "foreign-safe-version"
      }
    }
  });
  assert.equal(subjectTamper.status, "failed");
  assert.equal(
    subjectTamper.checks.find(
      (item) => item.code === "verification_subject_binding"
    )?.status,
    "failed"
  );

  fx.artifacts.get(output.artifact.versionId)!.metadataJson = JSON.stringify({
    schemaVersion: "tampered.safe.metadata.v1"
  });
  const failed = await check.verify({
    definition: tool.definition,
    context: first.context,
    envelope: first.envelope,
    handlerResult: first.result
  });
  assert.equal(failed.status, "failed");
  assert.equal(
    failed.checks.find((item) => item.code === "artifact_metadata_binding")?.status,
    "failed"
  );
});

test("trusted server context rejects a cross-course context without writing", async () => {
  const fx = fixture();
  const tool = registration(
    createCourseOperationsToolRegistrations({
      prisma: fx.db,
      createArtifactVersion: fx.createArtifactVersion
    }),
    "research.evidence_package.prepare"
  );
  await assert.rejects(
    runHandler({
      registration: tool,
      context: context({
        courseScope: {
          courseId: "server-only-other-course",
          alias: "other-course",
          manifestHash: MANIFEST_HASH
        }
      })
    })
  );
  assert.equal(fx.writes.length, 0);
});

test("a non-zero latest wake is surfaced only as a bounded failed zero-write status", async () => {
  const fx = fixture({ wakeEditorWriteCount: 1 });
  const tool = registration(
    createCourseOperationsToolRegistrations({
      prisma: fx.db,
      createArtifactVersion: fx.createArtifactVersion
    }),
    "course.schedule.read"
  );
  const execution = await runHandler({ registration: tool });
  const output = parseCourseScheduleReadOutput(execution.result.output);
  assert.equal(output.zeroWriteStatus, "failed");
  assert.equal(output.schedule.latestWake?.zeroWrite, false);
  assert.equal(JSON.stringify(output).includes("editorWriteCount"), false);
  assert.equal(JSON.stringify(output).includes("publishAttemptCount"), false);
});
