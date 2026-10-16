import assert from "node:assert/strict";
import test from "node:test";
import {
  COURSE_TOOL_ENVELOPE_SCHEMA_VERSION,
  hashCourseScope,
  hashCourseToolValue,
  type CourseToolBusinessInput,
  type EvidenceRef,
  type ServerToolExecutionContext,
  type ToolExecutionEnvelope
} from "../../lib/course-tools/contracts";
import type { TrustedPlatformStageAdapter } from "../../lib/course-tools/tools/platform-stage";
import { hashTransientDraftBody } from "../../lib/live-runtime/draft-content";
import {
  PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
  hashPreExecutionTargetObservation
} from "../../lib/autonomy/execution-permit";
import type {
  AtomicStageCompanionDriver,
  StageCompanionNetworkGuard,
  StageCompanionPageStateV3
} from "../../lib/live-runtime/stage-companion";
import type {
  CourseAgentRunMaterialLedger,
  CourseAgentStageMaterialBinding,
  CourseAgentStageTargetMaterial
} from "../../lib/workbench/course-agent-artifact-runtime";
import { CourseAgentProtectedMaterialVault } from "../../lib/workbench/course-agent-protected-material-vault";
import type { WorkbenchDb } from "../../lib/workbench/durable-ledger";
import { InMemoryProtectedArtifactStore } from "../../lib/workbench/protected-artifact-store";
import {
  WORKBENCH_STAGE_TARGET_RESOLUTION_SCHEMA_VERSION,
  buildResolvedWorkbenchStageTargetReceiptV2,
  type ResolvedWorkbenchStageTarget,
  WorkbenchStageBrowserSession,
  WorkbenchStageBrowserSessionFactory,
  WorkbenchStageTargetResolver
} from "../../lib/workbench/trusted-workbench-platform-stage-adapter";
import { createWorkbenchTrustedStageProviders } from "../../lib/workbench/workbench-trusted-stage-providers";

const NOW = "2026-08-13T12:00:00.000Z";
const COURSE_ALIAS = "bnu-test";
const MANIFEST_HASH = hashCourseToolValue("fixture.provider.manifest", COURSE_ALIAS);
const TARGET_VERSION_HASH = hashCourseToolValue("fixture.provider.target", "v1");
const EVENT_SET_HASH = hashCourseToolValue("fixture.provider.event-set", "v1");
const TARGET_LOCATOR_HASH = hashCourseToolValue(
  "fixture.provider.target-locator",
  "v1"
);
const OPPORTUNITY_HASH = hashCourseToolValue("fixture.provider.opportunity", "v1");
const REVALIDATION_HASH = hashCourseToolValue("fixture.provider.revalidation", "v1");
const OBSERVATION_HASH = hashCourseToolValue("fixture.provider.observation", "v1");
const INTEGRITY_HASH = hashCourseToolValue("fixture.provider.integrity", "v1");
const INTEGRITY_REF = `integrity-verification:${INTEGRITY_HASH}`;
const TARGET_REF = "support-gap:provider-fixture";
const ARTIFACT_VERSION_REF = "artifact-version:provider-fixture";
const BODY = "请比较两种解释，并标明证据限制。";
const BODY_HASH = hashTransientDraftBody(BODY);
const SECRET_SENTINEL = Buffer.from(
  "provider-secret-sentinel-material-32-bytes-minimum",
  "utf8"
);

function evidence(kind: EvidenceRef["kind"], id: string, hash: string): EvidenceRef {
  return { kind, id, hash, observedAt: NOW };
}

const TARGET: CourseAgentStageTargetMaterial = Object.freeze({
  targetRef: TARGET_REF,
  opportunityId: TARGET_REF,
  candidateKey: "candidate-provider-fixture",
  decisionId: "decision-provider-fixture",
  threadKey: "thread-provider-fixture",
  targetVersionHash: TARGET_VERSION_HASH,
  eventSetHash: EVENT_SET_HASH,
  opportunityReceiptHash: OPPORTUNITY_HASH,
  revalidationReceiptHash: REVALIDATION_HASH,
  afterObservationReceiptHash: OBSERVATION_HASH,
  evidenceRefs: [
    evidence("manifest", COURSE_ALIAS, MANIFEST_HASH),
    evidence("verification", INTEGRITY_REF, INTEGRITY_HASH),
    evidence("decision", "decision-provider-fixture", OPPORTUNITY_HASH)
  ]
});

const MATERIAL: CourseAgentStageMaterialBinding = Object.freeze({
  target: TARGET,
  artifactVersionRef: ARTIFACT_VERSION_REF,
  draftBodyHash: BODY_HASH,
  integrityVerificationRef: INTEGRITY_REF
});

function context(
  callId: string,
  overrides: Partial<ServerToolExecutionContext> = {}
): ServerToolExecutionContext {
  return Object.freeze({
    callId,
    taskId: "task-provider-fixture",
    runId: "run-provider-fixture",
    planRevisionId: "plan-provider-fixture",
    stepId: "step-provider-fixture",
    courseScope: {
      courseId: "course-private-provider-fixture",
      alias: COURSE_ALIAS,
      manifestHash: MANIFEST_HASH
    },
    intent: "implement",
    baseCapability: "L1_ARTIFACT",
    capabilityGrantRefs: ["grant-provider-fixture"],
    policyVersion: "cmooc.course-tool.policy.v1",
    now: NOW,
    deadlineAt: "2026-08-13T12:10:00.000Z",
    idempotencyKey: `idempotency-${callId}`,
    attempt: 1,
    executionLeaseId: "lease-provider-fixture",
    leaseGeneration: 1,
    fencingToken: "fencing-provider-fixture",
    ...overrides
  });
}

function envelope<I extends CourseToolBusinessInput>(
  current: ServerToolExecutionContext,
  toolName: string,
  input: I
): ToolExecutionEnvelope<I> {
  return Object.freeze({
    schemaVersion: COURSE_TOOL_ENVELOPE_SCHEMA_VERSION,
    callId: current.callId,
    taskId: current.taskId,
    runId: current.runId,
    planRevisionId: current.planRevisionId,
    stepId: current.stepId,
    courseScope: current.courseScope,
    courseScopeHash: hashCourseScope(current.courseScope),
    toolName,
    toolVersion: "1",
    input,
    inputHash: hashCourseToolValue("fixture.provider.input", input),
    idempotencyKey: current.idempotencyKey,
    grantedCapability: "L3_EXTERNAL_STAGE",
    grantRef: "grant-provider-fixture",
    policyVersion: current.policyVersion,
    attempt: 1,
    executionLeaseId: current.executionLeaseId,
    leaseGeneration: current.leaseGeneration,
    fencingToken: current.fencingToken,
    startedAt: current.now,
    deadlineAt: current.deadlineAt
  });
}

function fakePersistentDb() {
  let row: Record<string, unknown> | null = null;
  const counters = {
    nonceClaims: 0,
    transactionCreates: 0,
    transactionReads: 0,
    transactionUpdates: 0
  };
  const stageRecords = {
    findUnique: async ({ where }: { where: { stageTransactionRef: string } }) => {
      counters.transactionReads += 1;
      return row?.stageTransactionRef === where.stageTransactionRef ? row : null;
    },
    create: async ({ data }: { data: Record<string, any> }) => {
      counters.transactionCreates += 1;
      row = {
        ...data,
        taskId: data.task.connect.id,
        runId: data.run.connect.id,
        planRevisionId: data.planRevision.connect.id,
        stepId: data.step.connect.id,
        callId: data.call.connect.id
      };
      delete row.task;
      delete row.run;
      delete row.planRevision;
      delete row.step;
      delete row.call;
      return row;
    },
    updateMany: async ({ data }: { data: Record<string, unknown> }) => {
      counters.transactionUpdates += 1;
      if (!row) return { count: 0 };
      row = { ...row, ...data };
      return { count: 1 };
    }
  };
  const db = {
    $executeRaw: async () => {
      counters.nonceClaims += 1;
      return 1;
    },
    workbenchRunRecord: { findFirst: async () => ({ id: "run-provider-fixture" }) },
    workbenchPlanRevisionRecord: {
      findFirst: async () => ({ id: "plan-provider-fixture" })
    },
    workbenchPlanStepRecord: {
      findFirst: async () => ({ id: "step-provider-fixture" })
    },
    workbenchToolCallRecord: {
      findFirst: async () => ({ id: "stage-provider-call" })
    },
    workbenchStageTransactionRecord: stageRecords
  } as unknown as WorkbenchDb;
  return {
    db,
    counters,
    serializedRow: () => JSON.stringify(row)
  };
}

async function protectedDependencies() {
  const protectedStore = new InMemoryProtectedArtifactStore({
    idFactory: () => "provider-protected-draft"
  });
  const handle = await protectedStore.put({
    taskId: "task-provider-fixture",
    runId: "run-provider-fixture",
    callId: "draft-provider-call",
    idempotencyKey: "draft-provider-idempotency",
    body: BODY,
    draftBodyHash: BODY_HASH,
    storedAt: NOW,
    expiresAt: "2026-08-13T12:20:00.000Z"
  });
  const protectedMaterialVault = new CourseAgentProtectedMaterialVault({
    taskId: "task-provider-fixture",
    runId: "run-provider-fixture",
    protectedStore
  });
  protectedMaterialVault.bind({
    taskId: "task-provider-fixture",
    runId: "run-provider-fixture",
    artifactVersionRef: ARTIFACT_VERSION_REF,
    protectedRef: handle.ref,
    draftBodyHash: BODY_HASH,
    expiresAt: handle.expiresAt
  });
  return {
    materialLedger: {
      resolveStageMaterial: ({
        targetRef,
        artifactVersionRef
      }: {
        targetRef: string;
        artifactVersionRef?: string;
      }) =>
        targetRef === TARGET_REF &&
        (artifactVersionRef === undefined || artifactVersionRef === ARTIFACT_VERSION_REF)
          ? artifactVersionRef === undefined
            ? { ...MATERIAL, artifactVersionRef: null, draftBodyHash: null }
            : MATERIAL
          : null
    } as unknown as CourseAgentRunMaterialLedger,
    protectedMaterialVault,
    protectedStore
  };
}

function fakeBrowserSessionFactory(counters: { opens: number }): WorkbenchStageBrowserSessionFactory {
  return {
    open: async ({ target, courseAlias }) => {
      counters.opens += 1;
      const page: StageCompanionPageStateV3 = {
        origin: target.allowedOrigin,
        courseAlias,
        courseLocatorHash: target.courseLocatorHash,
        pageIdentityHash: hashCourseToolValue("fixture.provider.page", TARGET_REF),
        driverSessionKey: hashCourseToolValue("fixture.provider.session", TARGET_REF),
        targetVersionHash: target.targetVersionHash,
        targetLocatorHash: target.targetLocatorHash,
        activeTab: true,
        pageReady: true,
        editorVisible: true,
        containsForumText: false
      };
      const guard = (receiptHash: string): StageCompanionNetworkGuard => ({
        guardReceiptHash: receiptHash,
        attached: true,
        sentMutationCount: 0,
        publishControlActivated: false,
        submitKeyboardShortcutUsed: false,
        formSubmitTriggered: false,
        externalPublishAttempted: false,
        containsForumText: false
      });
      const driver: AtomicStageCompanionDriver = {
        executeStageTransaction: async ({
          expectedGuardReceiptHash,
          transientDraft
        }) => ({
          pageBeforeWrite: page,
          pageAfterWrite: page,
          pageAfterClear: page,
          guardAfterAttach: guard(expectedGuardReceiptHash),
          guardAfterWrite: guard(expectedGuardReceiptHash),
          guardAfterClear: guard(expectedGuardReceiptHash),
          editorValue: transientDraft,
          editorEmptyAfterClear: true
        })
      };
      const pageBindingHash = hashCourseToolValue(
        "cmooc.workbench-stage-page-binding.v2",
        {
          courseAlias,
          targetRef: TARGET_REF,
          targetVersionHash: target.targetVersionHash,
          eventSetHash: target.eventSetHash,
          targetLocatorHash: target.targetLocatorHash
        }
      );
      const session: WorkbenchStageBrowserSession = {
        expectedPage: page,
        guardReceiptHash: hashCourseToolValue("fixture.provider.guard", TARGET_REF),
        pageBindingRef: `page-binding:${pageBindingHash}`,
        pageBindingHash,
        driver,
        inspectBaseline: async () => ({
          pageReady: true,
          editorVisible: true,
          editorEmpty: true
        }),
        reconcileOwned: async () => ({
          status: "owned_draft_cleared",
          editorReadbackVerified: true,
          editorEmptyAfterClear: true,
          editorClearCount: 1
        }),
        close: async () => ({
          status: "passed",
          sentMutationCount: 0,
          publishAttempted: false,
          containsForumText: false
        })
      };
      return session;
    }
  };
}

function fakeTargetResolver(counters: { resolves: number }): WorkbenchStageTargetResolver {
  return {
    resolve: async (input) => {
      counters.resolves += 1;
      const observationReceipt = Object.freeze({
        schemaVersion: PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
        courseAlias: COURSE_ALIAS,
        threadKey: TARGET.threadKey,
        targetVersionHash: TARGET_VERSION_HASH,
        eventSetHash: EVENT_SET_HASH,
        observedAt: input.requestedAt,
        containsForumText: false as const
      });
      const freshObservation = Object.freeze({
        receipt: observationReceipt,
        receiptHash: hashPreExecutionTargetObservation(observationReceipt)
      });
      const bound = buildResolvedWorkbenchStageTargetReceiptV2({
        target: input.target,
        courseAlias: input.courseAlias,
        courseScopeHash: input.courseScopeHash,
        manifestHash: input.manifestHash,
        courseLocatorHash: input.manifestHash,
        targetLocatorHash: TARGET_LOCATOR_HASH,
        freshObservation
      });
      const resolved: ResolvedWorkbenchStageTarget = Object.freeze({
        schemaVersion: WORKBENCH_STAGE_TARGET_RESOLUTION_SCHEMA_VERSION,
        targetUrl: "https://example.edu/forum/post/provider-fixture",
        allowedOrigin: "https://example.edu",
        courseLocatorHash: bound.receipt.courseLocatorHash,
        targetLocatorHash: bound.receipt.targetLocatorHash,
        targetVersionHash: bound.receipt.targetVersionHash,
        eventSetHash: bound.receipt.eventSetHash,
        sourceRevalidationReceiptHash:
          bound.receipt.sourceRevalidationReceiptHash,
        sourceAfterObservationReceiptHash:
          bound.receipt.sourceAfterObservationReceiptHash,
        freshObservation,
        freshObservationRef: bound.receipt.freshObservationRef,
        freshObservationHash: bound.receipt.freshObservationHash,
        resolvedAt: bound.receipt.resolvedAt,
        resolvedTargetReceipt: bound.receipt,
        resolvedTargetReceiptRef: bound.receiptRef,
        resolvedTargetReceiptHash: bound.receiptHash,
        evidenceRefs: [
          evidence(
            "snapshot",
            "snapshot-provider-fixture",
            hashCourseToolValue("fixture.provider.snapshot", "v1")
          )
        ],
        readOnly: true,
        externalWriteAttempted: false,
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      });
      return resolved;
    }
  };
}

async function preflight(
  adapter: TrustedPlatformStageAdapter,
  current = context("preflight-provider-call")
) {
  const input = { targetRef: TARGET_REF };
  return adapter.preflightRead({
    targetRef: TARGET_REF,
    context: current,
    envelope: envelope(current, "platform.target.preflight_read", input)
  });
}

test("provider construction and adapter resolution are inert until the first trusted operation", async () => {
  const persistent = fakePersistentDb();
  const counters = { secrets: 0, resolves: 0, opens: 0 };
  const providers = createWorkbenchTrustedStageProviders({
    db: persistent.db,
    courseAlias: COURSE_ALIAS,
    targetResolver: fakeTargetResolver(counters),
    browserSessionFactory: fakeBrowserSessionFactory(counters),
    signingSecretProvider: async () => {
      counters.secrets += 1;
      return SECRET_SENTINEL;
    }
  });
  const serializedProvider = JSON.stringify(providers);
  assert.equal(serializedProvider.includes(SECRET_SENTINEL.toString("utf8")), false);
  assert.deepEqual(counters, { secrets: 0, resolves: 0, opens: 0 });

  const dependencies = await protectedDependencies();
  const adapter = await providers.resolvePlatformStageAdapter(dependencies);
  assert.deepEqual(counters, { secrets: 0, resolves: 0, opens: 0 });
  assert.equal(JSON.stringify(adapter).includes(SECRET_SENTINEL.toString("utf8")), false);

  const result = await preflight(adapter);
  assert.equal(result.status, "ready");
  assert.deepEqual(counters, { secrets: 1, resolves: 1, opens: 1 });
  assert.equal(persistent.counters.nonceClaims, 0);
  assert.equal(persistent.counters.transactionCreates, 0);
});

test("the provider injects persistent transaction and nonce stores into a zero-publish STAGE", async () => {
  const persistent = fakePersistentDb();
  const counters = { secrets: 0, resolves: 0, opens: 0 };
  const providers = createWorkbenchTrustedStageProviders({
    db: persistent.db,
    courseAlias: COURSE_ALIAS,
    targetResolver: fakeTargetResolver(counters),
    browserSessionFactory: fakeBrowserSessionFactory(counters),
    signingSecretProvider: () => {
      counters.secrets += 1;
      return Buffer.from(SECRET_SENTINEL);
    }
  });
  const adapter = await providers.resolvePlatformStageAdapter(
    await protectedDependencies()
  );
  const ready = await preflight(adapter);
  assert.equal(ready.status, "ready");
  const current = context("stage-provider-call");
  const input = {
    targetRef: TARGET_REF,
    artifactVersionRef: ARTIFACT_VERSION_REF,
    draftBodyHash: BODY_HASH,
    preflightRef: ready.preflightRef
  };
  const staged = await adapter.stageVerifyClear({
    ...input,
    context: current,
    envelope: envelope(current, "platform.editor.stage_verify_clear", input)
  });

  assert.equal(
    staged.status,
    "verified_cleared",
    JSON.stringify({ staged, persistent: persistent.counters, counters })
  );
  if (staged.status !== "verified_cleared") return;
  assert.equal(staged.editorWriteCount, 1);
  assert.equal(staged.editorReadbackCount, 1);
  assert.equal(staged.editorClearCount, 1);
  assert.equal(staged.submitMutationCount, 0);
  assert.equal(staged.sendMutationCount, 0);
  assert.equal(staged.realPublishEnabled, false);
  assert.equal(staged.published, false);
  assert.equal(persistent.counters.nonceClaims, 1);
  assert.equal(persistent.counters.transactionCreates, 1);
  assert.ok(persistent.counters.transactionReads >= 2);
  assert.ok(persistent.counters.transactionUpdates >= 1);
  const serialized = persistent.serializedRow();
  assert.equal(serialized.includes(BODY), false);
  assert.equal(serialized.includes(SECRET_SENTINEL.toString("utf8")), false);
  assert.equal(serialized.includes("example.edu"), false);
  assert.equal(counters.secrets, 1);
});

test("course aliases are exact and fail before secret, resolver, or browser access", async () => {
  const persistent = fakePersistentDb();
  const counters = { secrets: 0, resolves: 0, opens: 0 };
  const providers = createWorkbenchTrustedStageProviders({
    db: persistent.db,
    courseAlias: COURSE_ALIAS,
    targetResolver: fakeTargetResolver(counters),
    browserSessionFactory: fakeBrowserSessionFactory(counters),
    signingSecretProvider: () => {
      counters.secrets += 1;
      return SECRET_SENTINEL;
    }
  });
  const adapter = await providers.resolvePlatformStageAdapter(
    await protectedDependencies()
  );
  const mismatched = context("preflight-course-mismatch", {
    courseScope: {
      courseId: "course-private-provider-fixture",
      alias: "BNU-test",
      manifestHash: MANIFEST_HASH
    }
  });
  await assert.rejects(
    preflight(adapter, mismatched),
    /WORKBENCH_TRUSTED_STAGE_COURSE_SCOPE_MISMATCH/
  );
  assert.deepEqual(counters, { secrets: 0, resolves: 0, opens: 0 });
});

test("invalid or unavailable signing material converges to one body-free error", async () => {
  const invalidSecrets: readonly (() => unknown | Promise<unknown>)[] = [
    () => "provider-secret-sentinel-material-32-bytes-minimum",
    () => Buffer.alloc(31, 7),
    () => new Uint8Array(32),
    async () => {
      throw new Error(`upstream leaked ${SECRET_SENTINEL.toString("utf8")}`);
    }
  ];
  for (const signingSecretProvider of invalidSecrets) {
    const persistent = fakePersistentDb();
    const counters = { resolves: 0, opens: 0 };
    const providers = createWorkbenchTrustedStageProviders({
      db: persistent.db,
      courseAlias: COURSE_ALIAS,
      targetResolver: fakeTargetResolver(counters),
      browserSessionFactory: fakeBrowserSessionFactory(counters),
      signingSecretProvider: signingSecretProvider as () => Buffer | Promise<Buffer>
    });
    const adapter = await providers.resolvePlatformStageAdapter(
      await protectedDependencies()
    );
    const error = await preflight(adapter).then(
      () => null,
      (caught: unknown) => caught
    );
    assert.ok(error instanceof Error);
    assert.equal(error.message, "WORKBENCH_TRUSTED_STAGE_PROVIDER_UNAVAILABLE");
    assert.equal(String(error).includes(SECRET_SENTINEL.toString("utf8")), false);
    assert.equal(JSON.stringify(error).includes(SECRET_SENTINEL.toString("utf8")), false);
    assert.deepEqual(counters, { resolves: 0, opens: 0 });
    assert.equal(persistent.counters.nonceClaims, 0);
    assert.equal(persistent.counters.transactionCreates, 0);
  }
});

test("incomplete server-only dependencies fail closed without invoking supplied providers", () => {
  let providerCalls = 0;
  const persistent = fakePersistentDb();
  const complete = {
    db: persistent.db,
    courseAlias: COURSE_ALIAS,
    targetResolver: fakeTargetResolver({ resolves: 0 }),
    browserSessionFactory: fakeBrowserSessionFactory({ opens: 0 }),
    signingSecretProvider: () => {
      providerCalls += 1;
      return SECRET_SENTINEL;
    }
  };
  for (const invalid of [
    { ...complete, db: null },
    { ...complete, courseAlias: "" },
    { ...complete, courseAlias: "BNU-test" },
    { ...complete, targetResolver: null },
    { ...complete, browserSessionFactory: null },
    { ...complete, signingSecretProvider: null }
  ]) {
    assert.throws(
      () => createWorkbenchTrustedStageProviders(invalid as never),
      /WORKBENCH_TRUSTED_STAGE_CONFIGURATION_INVALID/
    );
  }
  assert.equal(providerCalls, 0);
});
