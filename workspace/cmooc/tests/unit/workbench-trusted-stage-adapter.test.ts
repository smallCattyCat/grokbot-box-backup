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
import { hashTransientDraftBody } from "../../lib/live-runtime/draft-content";
import {
  PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
  hashPreExecutionTargetObservation,
  type BoundPreExecutionTargetObservation
} from "../../lib/autonomy/execution-permit";
import {
  InMemoryStageRunNonceRegistry,
  type AtomicStageCompanionDriver,
  type StageCompanionNetworkGuard,
  type StageCompanionPageStateV3
} from "../../lib/live-runtime/stage-companion";
import type {
  CourseAgentStageMaterialBinding,
  CourseAgentStageTargetMaterial
} from "../../lib/workbench/course-agent-artifact-runtime";
import { CourseAgentProtectedMaterialVault } from "../../lib/workbench/course-agent-protected-material-vault";
import { InMemoryProtectedArtifactStore } from "../../lib/workbench/protected-artifact-store";
import {
  WORKBENCH_STAGE_TARGET_RESOLUTION_SCHEMA_VERSION,
  WORKBENCH_STAGE_RECONCILIATION_RECEIPT_SCHEMA_VERSION,
  WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION,
  InMemoryWorkbenchStageTransactionStore,
  buildResolvedWorkbenchStageTargetReceiptV2,
  createTrustedWorkbenchPlatformStageAdapter,
  type ResolvedWorkbenchStageTarget,
  type WorkbenchStageBrowserSession,
  type WorkbenchStageBrowserSessionFactory,
  type WorkbenchStageTargetResolver
} from "../../lib/workbench/trusted-workbench-platform-stage-adapter";

const NOW = "2026-08-13T12:00:00.000Z";
const MANIFEST_HASH = hashCourseToolValue("fixture.manifest", "bnu-test");
const TARGET_VERSION_HASH = hashCourseToolValue("fixture.target", "target-v1");
const OPPORTUNITY_RECEIPT_HASH = hashCourseToolValue("fixture.opportunity", "receipt");
const REVALIDATION_HASH = hashCourseToolValue("fixture.revalidation", "receipt");
const OBSERVATION_HASH = hashCourseToolValue("fixture.observation", "receipt");
const EVENT_SET_HASH = hashCourseToolValue("fixture.event-set", "event-set-v1");
const TARGET_LOCATOR_HASH = hashCourseToolValue("fixture.target-locator", "post-1");
const TARGET_REF = "support-gap:candidate-1";
const ARTIFACT_VERSION_REF = "artifact-version:draft-1";
const BODY = "请比较两种解释，并标明证据限制。";
const BODY_HASH = hashTransientDraftBody(BODY);
const INTEGRITY_HASH = hashCourseToolValue("fixture.integrity", "1");
const INTEGRITY_VERIFICATION_REF = `integrity-verification:${INTEGRITY_HASH}`;

function evidence(kind: EvidenceRef["kind"], id: string, hash: string): EvidenceRef {
  return { kind, id, hash, observedAt: NOW };
}

const TARGET: CourseAgentStageTargetMaterial = Object.freeze({
  targetRef: TARGET_REF,
  opportunityId: TARGET_REF,
  candidateKey: "candidate-1",
  decisionId: "decision-1",
  threadKey: "thread-1",
  targetVersionHash: TARGET_VERSION_HASH,
  eventSetHash: EVENT_SET_HASH,
  opportunityReceiptHash: OPPORTUNITY_RECEIPT_HASH,
  revalidationReceiptHash: REVALIDATION_HASH,
  afterObservationReceiptHash: OBSERVATION_HASH,
  evidenceRefs: [
    evidence("manifest", "bnu-test", MANIFEST_HASH),
    evidence("verification", INTEGRITY_VERIFICATION_REF, INTEGRITY_HASH),
    evidence("decision", "decision-1", OPPORTUNITY_RECEIPT_HASH)
  ]
});

const MATERIAL: CourseAgentStageMaterialBinding = Object.freeze({
  target: TARGET,
  artifactVersionRef: ARTIFACT_VERSION_REF,
  draftBodyHash: BODY_HASH,
  integrityVerificationRef: INTEGRITY_VERIFICATION_REF
});

function context(
  callId: string,
  overrides: Partial<ServerToolExecutionContext> = {}
): ServerToolExecutionContext {
  return Object.freeze({
    callId,
    taskId: "task-1",
    runId: "run-1",
    planRevisionId: "plan-1",
    stepId: "step-stage",
    courseScope: { courseId: "course-1", alias: "bnu-test", manifestHash: MANIFEST_HASH },
    intent: "implement",
    baseCapability: "L1_ARTIFACT",
    capabilityGrantRefs: ["grant-1"],
    policyVersion: "cmooc.course-tool.policy.v1",
    now: NOW,
    deadlineAt: "2026-08-13T12:10:00.000Z",
    idempotencyKey: `idempotency-${callId}`,
    attempt: 1,
    executionLeaseId: "lease-1",
    leaseGeneration: 1,
    fencingToken: "fence-secret",
    ...overrides
  });
}

function envelope<I extends CourseToolBusinessInput>(
  ctx: ServerToolExecutionContext,
  toolName: string,
  input: I
): ToolExecutionEnvelope<I> {
  return Object.freeze({
    schemaVersion: COURSE_TOOL_ENVELOPE_SCHEMA_VERSION,
    callId: ctx.callId,
    taskId: ctx.taskId,
    runId: ctx.runId,
    planRevisionId: ctx.planRevisionId,
    stepId: ctx.stepId,
    courseScope: ctx.courseScope,
    courseScopeHash: hashCourseScope(ctx.courseScope),
    toolName,
    toolVersion: "1",
    input,
    inputHash: hashCourseToolValue("fixture.input", input),
    idempotencyKey: ctx.idempotencyKey,
    grantedCapability: "L3_EXTERNAL_STAGE",
    grantRef: "grant-1",
    policyVersion: ctx.policyVersion,
    attempt: 1,
    executionLeaseId: ctx.executionLeaseId,
    leaseGeneration: ctx.leaseGeneration,
    fencingToken: ctx.fencingToken,
    startedAt: ctx.now,
    deadlineAt: ctx.deadlineAt
  });
}

async function protectedFixture() {
  const store = new InMemoryProtectedArtifactStore({ idFactory: () => "stage-draft" });
  const handle = await store.put({
    taskId: "task-1",
    runId: "run-1",
    callId: "draft-call",
    idempotencyKey: "draft-key",
    body: BODY,
    draftBodyHash: BODY_HASH,
    storedAt: NOW,
    expiresAt: "2026-08-13T12:20:00.000Z"
  });
  const vault = new CourseAgentProtectedMaterialVault({
    taskId: "task-1",
    runId: "run-1",
    protectedStore: store
  });
  vault.bind({
    taskId: "task-1",
    runId: "run-1",
    artifactVersionRef: ARTIFACT_VERSION_REF,
    protectedRef: handle.ref,
    draftBodyHash: BODY_HASH,
    expiresAt: handle.expiresAt
  });
  return vault;
}

function sessionFactory(input: {
  failStage: boolean;
  counters: {
    resolve: number;
    open: number;
    stage: number;
    reconcile: number;
    close: number;
  };
}): WorkbenchStageBrowserSessionFactory {
  return {
    open: async ({ target, courseAlias }) => {
      input.counters.open += 1;
      const page: StageCompanionPageStateV3 = {
        origin: target.allowedOrigin,
        courseAlias,
        courseLocatorHash: target.courseLocatorHash,
        pageIdentityHash: hashCourseToolValue("fixture.page", TARGET_REF),
        driverSessionKey: hashCourseToolValue("fixture.session", "session-1"),
        targetVersionHash: target.targetVersionHash,
        targetLocatorHash: target.targetLocatorHash,
        activeTab: true,
        pageReady: true,
        editorVisible: true,
        containsForumText: false
      };
      const guard = (hash: string): StageCompanionNetworkGuard => ({
        guardReceiptHash: hash,
        attached: true,
        sentMutationCount: 0,
        publishControlActivated: false,
        submitKeyboardShortcutUsed: false,
        formSubmitTriggered: false,
        externalPublishAttempted: false,
        containsForumText: false
      });
      const driver: AtomicStageCompanionDriver = {
        executeStageTransaction: async ({ expectedGuardReceiptHash, transientDraft }) => {
          input.counters.stage += 1;
          if (input.failStage) throw new Error("fixture_driver_disconnected");
          return {
            pageBeforeWrite: page,
            pageAfterWrite: page,
            pageAfterClear: page,
            guardAfterAttach: guard(expectedGuardReceiptHash),
            guardAfterWrite: guard(expectedGuardReceiptHash),
            guardAfterClear: guard(expectedGuardReceiptHash),
            editorValue: transientDraft,
            editorEmptyAfterClear: true
          };
        }
      };
      const pageBindingHash = hashCourseToolValue("fixture.page-binding", TARGET_REF);
      const session: WorkbenchStageBrowserSession = {
        expectedPage: page,
        guardReceiptHash: hashCourseToolValue("fixture.guard", TARGET_REF),
        pageBindingRef: `page-binding:${pageBindingHash}`,
        pageBindingHash,
        driver,
        inspectBaseline: async () => ({
          pageReady: true,
          editorVisible: true,
          editorEmpty: true
        }),
        reconcileOwned: async () => {
          input.counters.reconcile += 1;
          return {
            status: "owned_draft_cleared",
            editorReadbackVerified: true,
            editorEmptyAfterClear: true,
            editorClearCount: 1
          };
        },
        close: async () => {
          input.counters.close += 1;
          return {
            status: "passed",
            sentMutationCount: 0,
            publishAttempted: false,
            containsForumText: false
          };
        }
      };
      return session;
    }
  };
}

function freshObservation(input: {
  resolvedAt?: string;
  targetVersionHash?: string;
  eventSetHash?: string;
} = {}): BoundPreExecutionTargetObservation {
  const receipt = Object.freeze({
    schemaVersion: PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
    courseAlias: "bnu-test",
    threadKey: TARGET.threadKey,
    targetVersionHash: input.targetVersionHash ?? TARGET_VERSION_HASH,
    eventSetHash: input.eventSetHash ?? EVENT_SET_HASH,
    observedAt: input.resolvedAt ?? NOW,
    containsForumText: false as const
  });
  return Object.freeze({
    receipt,
    receiptHash: hashPreExecutionTargetObservation(receipt)
  });
}

function resolvedTarget(input: {
  resolvedAt?: string;
  targetVersionHash?: string;
  eventSetHash?: string;
  targetLocatorHash?: string;
  mutateReceipt?: (
    receipt: ReturnType<typeof buildResolvedWorkbenchStageTargetReceiptV2>["receipt"]
  ) => unknown;
  receiptHash?: string;
  extraOutput?: Readonly<Record<string, unknown>>;
} = {}): ResolvedWorkbenchStageTarget {
  const observation = freshObservation(input);
  const bound = buildResolvedWorkbenchStageTargetReceiptV2({
    target: TARGET,
    courseAlias: "bnu-test",
    courseScopeHash: hashCourseScope({
      courseId: "course-1",
      alias: "bnu-test",
      manifestHash: MANIFEST_HASH
    }),
    manifestHash: MANIFEST_HASH,
    courseLocatorHash: MANIFEST_HASH,
    targetLocatorHash: input.targetLocatorHash ?? TARGET_LOCATOR_HASH,
    freshObservation: observation
  });
  return {
    schemaVersion: WORKBENCH_STAGE_TARGET_RESOLUTION_SCHEMA_VERSION,
    targetUrl: "https://example.edu/forum/post/1",
    allowedOrigin: "https://example.edu",
    courseLocatorHash: bound.receipt.courseLocatorHash,
    targetLocatorHash: bound.receipt.targetLocatorHash,
    targetVersionHash: bound.receipt.targetVersionHash,
    eventSetHash: bound.receipt.eventSetHash,
    sourceRevalidationReceiptHash:
      bound.receipt.sourceRevalidationReceiptHash,
    sourceAfterObservationReceiptHash:
      bound.receipt.sourceAfterObservationReceiptHash,
    freshObservation: observation,
    freshObservationRef: bound.receipt.freshObservationRef,
    freshObservationHash: bound.receipt.freshObservationHash,
    resolvedAt: bound.receipt.resolvedAt,
    resolvedTargetReceipt: (input.mutateReceipt?.(bound.receipt) ??
      bound.receipt) as typeof bound.receipt,
    resolvedTargetReceiptRef: bound.receiptRef,
    resolvedTargetReceiptHash: input.receiptHash ?? bound.receiptHash,
    evidenceRefs: [
      evidence(
        "snapshot",
        "snapshot-1",
        hashCourseToolValue("fixture.snapshot", "1")
      )
    ],
    readOnly: true,
    externalWriteAttempted: false,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false,
    ...(input.extraOutput ?? {})
  } as ResolvedWorkbenchStageTarget;
}

async function fixture(
  failStage: boolean,
  options: {
    resolutions?: readonly (ResolvedWorkbenchStageTarget | null)[];
    resolver?: WorkbenchStageTargetResolver;
  } = {}
) {
  const counters = {
    resolve: 0,
    open: 0,
    stage: 0,
    reconcile: 0,
    close: 0
  };
  const transactionStore = new InMemoryWorkbenchStageTransactionStore();
  const resolutions = [...(options.resolutions ?? [resolvedTarget()])];
  const resolver: WorkbenchStageTargetResolver =
    options.resolver ?? {
      resolve: async () => {
        const index = Math.min(counters.resolve, resolutions.length - 1);
        counters.resolve += 1;
        return resolutions[index] ?? null;
      }
    };
  const adapter = createTrustedWorkbenchPlatformStageAdapter({
    materialLedger: {
      resolveStageMaterial: ({ targetRef, artifactVersionRef }) =>
        targetRef === TARGET_REF &&
        (artifactVersionRef === undefined || artifactVersionRef === ARTIFACT_VERSION_REF)
          ? artifactVersionRef === undefined
            ? { ...MATERIAL, artifactVersionRef: null, draftBodyHash: null }
            : MATERIAL
          : null
    },
    protectedMaterialVault: await protectedFixture(),
    targetResolver: resolver,
    browserSessionFactory: sessionFactory({ failStage, counters }),
    nonceRegistry: new InMemoryStageRunNonceRegistry(),
    transactionStore,
    signingSecret: Buffer.alloc(32, 7),
    now: () => new Date(NOW)
  });
  return { adapter, counters, transactionStore };
}

async function readyPreflight(adapter: Awaited<ReturnType<typeof fixture>>["adapter"]) {
  const ctx = context("preflight-call");
  const input = { targetRef: TARGET_REF };
  return adapter.preflightRead({
    targetRef: TARGET_REF,
    context: ctx,
    envelope: envelope(ctx, "platform.target.preflight_read", input)
  });
}

test("trusted Workbench adapter executes the real stage-companion contract once with zero publish", async () => {
  const { adapter, counters, transactionStore } = await fixture(false);
  const preflight = await readyPreflight(adapter);
  assert.equal(preflight.status, "ready");
  const ctx = context("stage-call");
  const businessInput = {
    targetRef: TARGET_REF,
    artifactVersionRef: ARTIFACT_VERSION_REF,
    draftBodyHash: BODY_HASH,
    preflightRef: preflight.preflightRef
  };
  const staged = await adapter.stageVerifyClear({
    ...businessInput,
    context: ctx,
    envelope: envelope(ctx, "platform.editor.stage_verify_clear", businessInput)
  });
  assert.equal(staged.status, "verified_cleared");
  if (staged.status !== "verified_cleared") return;
  assert.equal(counters.stage, 1);
  assert.equal(counters.resolve, 2, "STAGE must perform a second fresh target read");
  assert.equal(staged.editorWriteCount, 1);
  assert.equal(staged.editorReadbackCount, 1);
  assert.equal(staged.editorClearCount, 1);
  assert.equal(staged.submitMutationCount, 0);
  assert.equal(staged.sendMutationCount, 0);
  assert.equal(staged.realPublishEnabled, false);
  assert.equal(staged.published, false);
  const transaction = await transactionStore.get(staged.stageTransactionRef);
  assert.equal(transaction?.status, "verified");
  assert.equal(transaction?.planRevisionId, ctx.planRevisionId);
  assert.equal(transaction?.stepId, ctx.stepId);
  assert.equal(transaction?.callId, ctx.callId);
  assert.equal(transaction?.courseAlias, ctx.courseScope.alias);
  assert.equal(transaction?.courseScopeHash, hashCourseScope(ctx.courseScope));
  assert.equal(transaction?.manifestHash, MANIFEST_HASH);
  assert.equal(transaction?.policyVersion, ctx.policyVersion);
  assert.equal(
    transaction?.schemaVersion,
    WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION
  );
  assert.equal(
    transaction?.integrityVerificationRef,
    INTEGRITY_VERIFICATION_REF
  );
  if (transaction?.schemaVersion === WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION) {
    assert.equal(transaction.preflightRef, preflight.preflightRef);
    assert.equal(transaction.preflightHash, preflight.preflightHash);
    assert.equal(transaction.eventSetHash, EVENT_SET_HASH);
    assert.equal(transaction.targetLocatorHash, TARGET_LOCATOR_HASH);
    assert.equal(transaction.terminalBinding?.kind, "stage");
    if (transaction.terminalBinding?.kind === "stage") {
      assert.equal(
        transaction.terminalBinding.resolvedTargetReceiptHash,
        transaction.resolvedTargetReceiptHash
      );
      assert.equal(
        transaction.terminalBinding.freshObservationHash,
        transaction.freshObservationHash
      );
    }
  }
  const serialized = JSON.stringify(transaction);
  assert.equal(serialized.includes(BODY), false);
  assert.equal(serialized.includes("example.edu"), false);
});

test("stage accepts a second fresh receipt only when event set and locator remain unchanged", async () => {
  const { adapter, counters } = await fixture(false, {
    resolutions: [
      resolvedTarget({ resolvedAt: "2026-08-13T11:59:45.000Z" }),
      resolvedTarget({ resolvedAt: NOW })
    ]
  });
  const preflight = await readyPreflight(adapter);
  assert.equal(preflight.status, "ready");
  const ctx = context("stage-fresh-unchanged");
  const businessInput = {
    targetRef: TARGET_REF,
    artifactVersionRef: ARTIFACT_VERSION_REF,
    draftBodyHash: BODY_HASH,
    preflightRef: preflight.preflightRef
  };
  const result = await adapter.stageVerifyClear({
    ...businessInput,
    context: ctx,
    envelope: envelope(ctx, "platform.editor.stage_verify_clear", businessInput)
  });
  assert.equal(result.status, "verified_cleared");
  assert.equal(counters.resolve, 2);
  assert.equal(counters.open, 2);
  assert.equal(counters.stage, 1);
});

test("transaction ref changes when only the second fresh resolved-target receipt changes", async () => {
  const run = async (stageResolvedAt: string) => {
    const { adapter } = await fixture(false, {
      resolutions: [
        resolvedTarget({ resolvedAt: "2026-08-13T11:59:45.000Z" }),
        resolvedTarget({ resolvedAt: stageResolvedAt })
      ]
    });
    const preflight = await readyPreflight(adapter);
    assert.equal(preflight.status, "ready");
    const ctx = context("stage-transaction-ref-binding");
    const businessInput = {
      targetRef: TARGET_REF,
      artifactVersionRef: ARTIFACT_VERSION_REF,
      draftBodyHash: BODY_HASH,
      preflightRef: preflight.preflightRef
    };
    const result = await adapter.stageVerifyClear({
      ...businessInput,
      context: ctx,
      envelope: envelope(ctx, "platform.editor.stage_verify_clear", businessInput)
    });
    assert.equal(result.status, "verified_cleared");
    if (result.status !== "verified_cleared") throw new Error("fixture failed");
    return { preflightRef: preflight.preflightRef, transactionRef: result.stageTransactionRef };
  };

  const first = await run("2026-08-13T11:59:46.000Z");
  const second = await run("2026-08-13T11:59:47.000Z");
  assert.equal(first.preflightRef, second.preflightRef);
  assert.notEqual(first.transactionRef, second.transactionRef);
});

test("stage stops before editor access when a new event appears without a target-version change", async () => {
  const changedEventSet = hashCourseToolValue(
    "fixture.event-set",
    "event-set-v2-new-reply"
  );
  const { adapter, counters } = await fixture(false, {
    resolutions: [
      resolvedTarget(),
      resolvedTarget({ eventSetHash: changedEventSet })
    ]
  });
  const preflight = await readyPreflight(adapter);
  assert.equal(preflight.status, "ready");
  const ctx = context("stage-event-set-drift");
  const businessInput = {
    targetRef: TARGET_REF,
    artifactVersionRef: ARTIFACT_VERSION_REF,
    draftBodyHash: BODY_HASH,
    preflightRef: preflight.preflightRef
  };
  const result = await adapter.stageVerifyClear({
    ...businessInput,
    context: ctx,
    envelope: envelope(ctx, "platform.editor.stage_verify_clear", businessInput)
  });
  assert.equal(result.status, "failed_before_write");
  if (result.status === "failed_before_write") {
    assert.equal(result.reasonCode, "target_stale");
  }
  assert.equal(counters.resolve, 2);
  assert.equal(counters.open, 1, "the changed target must not open a STAGE session");
  assert.equal(counters.stage, 0);
});

test("stage stops before editor access when the opaque target locator changes", async () => {
  const { adapter, counters } = await fixture(false, {
    resolutions: [
      resolvedTarget(),
      resolvedTarget({
        targetLocatorHash: hashCourseToolValue(
          "fixture.target-locator",
          "different-post"
        )
      })
    ]
  });
  const preflight = await readyPreflight(adapter);
  const ctx = context("stage-locator-drift");
  const businessInput = {
    targetRef: TARGET_REF,
    artifactVersionRef: ARTIFACT_VERSION_REF,
    draftBodyHash: BODY_HASH,
    preflightRef: preflight.preflightRef
  };
  const result = await adapter.stageVerifyClear({
    ...businessInput,
    context: ctx,
    envelope: envelope(ctx, "platform.editor.stage_verify_clear", businessInput)
  });
  assert.equal(result.status, "failed_before_write");
  if (result.status === "failed_before_write") {
    assert.equal(result.reasonCode, "target_stale");
  }
  assert.equal(counters.open, 1);
  assert.equal(counters.stage, 0);
});

test("preflight accepts freshness boundaries and rejects stale or future receipts before browser access", async () => {
  const cases = [
    {
      name: "exact-age-boundary",
      resolvedAt: "2026-08-13T11:59:30.000Z",
      expected: "ready",
      opened: 1
    },
    {
      name: "one-millisecond-stale",
      resolvedAt: "2026-08-13T11:59:29.999Z",
      expected: "blocked",
      opened: 0
    },
    {
      name: "exact-future-skew-boundary",
      resolvedAt: "2026-08-13T12:00:05.000Z",
      expected: "ready",
      opened: 1
    },
    {
      name: "one-millisecond-too-far-in-future",
      resolvedAt: "2026-08-13T12:00:05.001Z",
      expected: "blocked",
      opened: 0
    }
  ] as const;
  for (const item of cases) {
    const { adapter, counters } = await fixture(false, {
      resolutions: [resolvedTarget({ resolvedAt: item.resolvedAt })]
    });
    const result = await readyPreflight(adapter);
    assert.equal(result.status, item.expected, item.name);
    if (result.status === "blocked") assert.equal(result.reasonCode, "target_stale");
    assert.equal(counters.open, item.opened, item.name);
  }
});

test("preflight rejects extra or tampered resolved-target receipts fail-closed", async () => {
  const tamperedHash = hashCourseToolValue("fixture.tampered", "receipt");
  const cases: readonly ResolvedWorkbenchStageTarget[] = [
    resolvedTarget({
      mutateReceipt: (receipt) => ({ ...receipt, unexpected: "forbidden" })
    }),
    resolvedTarget({
      mutateReceipt: (receipt) => ({
        ...receipt,
        eventSetHash: hashCourseToolValue("fixture.event-set", "tampered")
      })
    }),
    resolvedTarget({ receiptHash: tamperedHash }),
    resolvedTarget({ extraOutput: { unexpected: "forbidden" } })
  ];
  for (const [index, resolution] of cases.entries()) {
    const { adapter, counters } = await fixture(false, {
      resolutions: [resolution]
    });
    const result = await readyPreflight(adapter);
    assert.equal(result.status, "blocked", `case ${index}`);
    if (result.status === "blocked") {
      assert.equal(result.reasonCode, "target_mismatch", `case ${index}`);
    }
    assert.equal(counters.open, 0, `case ${index}`);
  }
});

test("ambiguous stage keeps one transaction ref and reconciliation clears only owned draft without replay", async () => {
  const reconcileEventSetHash = hashCourseToolValue(
    "fixture.event-set",
    "event-set-after-ambiguous-stage"
  );
  const reconcileTargetVersionHash = hashCourseToolValue(
    "fixture.target",
    "target-version-after-ambiguous-stage"
  );
  const { adapter, counters, transactionStore } = await fixture(true, {
    resolutions: [
      resolvedTarget(),
      resolvedTarget(),
      resolvedTarget({
        eventSetHash: reconcileEventSetHash,
        targetVersionHash: reconcileTargetVersionHash
      })
    ]
  });
  const preflight = await readyPreflight(adapter);
  const ctx = context("stage-unknown-call");
  const businessInput = {
    targetRef: TARGET_REF,
    artifactVersionRef: ARTIFACT_VERSION_REF,
    draftBodyHash: BODY_HASH,
    preflightRef: preflight.preflightRef
  };
  const staged = await adapter.stageVerifyClear({
    ...businessInput,
    context: ctx,
    envelope: envelope(ctx, "platform.editor.stage_verify_clear", businessInput)
  });
  assert.equal(staged.status, "unknown");
  if (staged.status !== "unknown") return;
  assert.equal(counters.stage, 1);
  assert.equal((await transactionStore.get(staged.stageTransactionRef))?.status, "unknown");
  assert.equal(
    (await transactionStore.get(staged.stageTransactionRef))?.callId,
    ctx.callId,
    "the recovery child must not rewrite the original STAGE call binding"
  );

  const reconcileContext = context("reconcile-call");
  const reconcileInput = { stageTransactionRef: staged.stageTransactionRef };
  const reconciled = await adapter.reconcileStage({
    stageTransactionRef: staged.stageTransactionRef,
    context: reconcileContext,
    envelope: envelope(
      reconcileContext,
      "platform.editor.reconcile_stage",
      reconcileInput
    )
  });
  assert.equal(reconciled.status, "reconciled_cleared");
  assert.equal(counters.stage, 1, "the ambiguous STAGE transaction must never replay");
  assert.equal(counters.reconcile, 1);
  if (reconciled.status === "reconciled_cleared") {
    assert.equal(reconciled.resolution, "owned_draft_cleared");
    assert.equal(reconciled.submitMutationCount, 0);
    assert.equal(reconciled.sendMutationCount, 0);
    assert.equal(reconciled.published, false);
  }
  assert.equal(
    (await transactionStore.get(staged.stageTransactionRef))?.status,
    "reconciled"
  );
  const terminal = await transactionStore.get(staged.stageTransactionRef);
  assert.equal(terminal?.schemaVersion, WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION);
  if (terminal?.schemaVersion !== WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION) return;
  assert.equal(terminal.terminalBinding?.kind, "reconcile");
  if (terminal.terminalBinding?.kind !== "reconcile") return;
  assert.equal(
    terminal.terminalBinding.reconcileEventSetHash,
    reconcileEventSetHash
  );
  assert.equal(
    terminal.terminalBinding.reconcileTargetLocatorHash,
    terminal.targetLocatorHash
  );
  const expectedReceiptHash = hashCourseToolValue(
    WORKBENCH_STAGE_RECONCILIATION_RECEIPT_SCHEMA_VERSION,
    {
      schemaVersion: WORKBENCH_STAGE_RECONCILIATION_RECEIPT_SCHEMA_VERSION,
      stageTransactionRef: staged.stageTransactionRef,
      runNonceHash: terminal.runNonceHash,
      originalResolvedTargetReceiptHash: terminal.resolvedTargetReceiptHash,
      reconcileResolvedTargetReceiptRef:
        terminal.terminalBinding.reconcileResolvedTargetReceiptRef,
      reconcileResolvedTargetReceiptHash:
        terminal.terminalBinding.reconcileResolvedTargetReceiptHash,
      reconcileFreshObservationRef:
        terminal.terminalBinding.reconcileFreshObservationRef,
      reconcileFreshObservationHash:
        terminal.terminalBinding.reconcileFreshObservationHash,
      reconcileEventSetHash,
      reconcileTargetLocatorHash: terminal.targetLocatorHash,
      reconcileResolvedAt: terminal.terminalBinding.reconcileResolvedAt,
      artifactVersionRef: terminal.artifactVersionRef,
      draftBodyHash: terminal.draftBodyHash,
      ownershipBinding: "run_nonce_and_draft_hash",
      ownedDraftMatched: true,
      editorReadbackVerified: true,
      replayWriteCount: 0,
      editorClearCount: 1,
      editorEmptyAfterClear: true,
      publishAttempted: false,
      submitMutationCount: 0,
      sendMutationCount: 0,
      sentMutationCount: 0,
      realPublishEnabled: false,
      published: false,
      observedAt: NOW,
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false
    }
  );
  assert.equal(reconciled.receiptHash, expectedReceiptHash);
});

test("reconcile allows later event-set drift but blocks target-locator drift before browser access", async () => {
  const { adapter, counters, transactionStore } = await fixture(true, {
    resolutions: [
      resolvedTarget(),
      resolvedTarget(),
      resolvedTarget({
        eventSetHash: hashCourseToolValue("fixture.event-set", "later"),
        targetLocatorHash: hashCourseToolValue(
          "fixture.target-locator",
          "different-target"
        )
      })
    ]
  });
  const preflight = await readyPreflight(adapter);
  const stageContext = context("stage-before-reconcile-locator-drift");
  const stageInput = {
    targetRef: TARGET_REF,
    artifactVersionRef: ARTIFACT_VERSION_REF,
    draftBodyHash: BODY_HASH,
    preflightRef: preflight.preflightRef
  };
  const staged = await adapter.stageVerifyClear({
    ...stageInput,
    context: stageContext,
    envelope: envelope(
      stageContext,
      "platform.editor.stage_verify_clear",
      stageInput
    )
  });
  assert.equal(staged.status, "unknown");
  if (staged.status !== "unknown") return;

  const reconcileContext = context("reconcile-locator-drift");
  const reconcileInput = { stageTransactionRef: staged.stageTransactionRef };
  const result = await adapter.reconcileStage({
    ...reconcileInput,
    context: reconcileContext,
    envelope: envelope(
      reconcileContext,
      "platform.editor.reconcile_stage",
      reconcileInput
    )
  });
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") {
    assert.equal(result.reasonCode, "transaction_binding_mismatch");
  }
  assert.equal(counters.open, 2, "reconcile must not open a drifted locator");
  assert.equal(counters.reconcile, 0);
  assert.equal(
    (await transactionStore.get(staged.stageTransactionRef))?.status,
    "unknown"
  );
});

test("reconcile rejects cross-plan, course, manifest, policy, and envelope binding drift before browser access", async () => {
  const { adapter, counters, transactionStore } = await fixture(true);
  const preflight = await readyPreflight(adapter);
  const stageContext = context("stage-canonical-call");
  const businessInput = {
    targetRef: TARGET_REF,
    artifactVersionRef: ARTIFACT_VERSION_REF,
    draftBodyHash: BODY_HASH,
    preflightRef: preflight.preflightRef
  };
  const staged = await adapter.stageVerifyClear({
    ...businessInput,
    context: stageContext,
    envelope: envelope(
      stageContext,
      "platform.editor.stage_verify_clear",
      businessInput
    )
  });
  assert.equal(staged.status, "unknown");
  if (staged.status !== "unknown") return;

  const differentManifest = hashCourseToolValue("fixture.manifest", "other");
  const recoveryContexts = [
    context("recovery-plan", { planRevisionId: "plan-2" }),
    context("recovery-step", { stepId: "step-other" }),
    context("recovery-policy", { policyVersion: "cmooc.course-tool.policy.v2" }),
    context("recovery-course", {
      courseScope: {
        courseId: "course-1",
        alias: "other-course",
        manifestHash: MANIFEST_HASH
      }
    }),
    context("recovery-manifest", {
      courseScope: {
        courseId: "course-1",
        alias: "bnu-test",
        manifestHash: differentManifest
      }
    })
  ];
  const reconcileInput = { stageTransactionRef: staged.stageTransactionRef };
  for (const recoveryContext of recoveryContexts) {
    const result = await adapter.reconcileStage({
      ...reconcileInput,
      context: recoveryContext,
      envelope: envelope(
        recoveryContext,
        "platform.editor.reconcile_stage",
        reconcileInput
      )
    });
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") {
      assert.equal(result.reasonCode, "transaction_binding_mismatch");
    }
  }

  const recoveryContext = context("recovery-envelope-drift");
  const validEnvelope = envelope(
    recoveryContext,
    "platform.editor.reconcile_stage",
    reconcileInput
  );
  const envelopeDrift = await adapter.reconcileStage({
    ...reconcileInput,
    context: recoveryContext,
    envelope: {
      ...validEnvelope,
      courseScopeHash: hashCourseToolValue("fixture.scope", "tampered")
    }
  });
  assert.equal(envelopeDrift.status, "blocked");
  assert.equal(counters.reconcile, 0);
  assert.equal(
    (await transactionStore.get(staged.stageTransactionRef))?.status,
    "unknown"
  );
});

test("stage rejects a forged server envelope before transaction creation or editor access", async () => {
  const { adapter, counters, transactionStore } = await fixture(false);
  const preflight = await readyPreflight(adapter);
  const stageContext = context("stage-forged-envelope");
  const businessInput = {
    targetRef: TARGET_REF,
    artifactVersionRef: ARTIFACT_VERSION_REF,
    draftBodyHash: BODY_HASH,
    preflightRef: preflight.preflightRef
  };
  const validEnvelope = envelope(
    stageContext,
    "platform.editor.stage_verify_clear",
    businessInput
  );
  const result = await adapter.stageVerifyClear({
    ...businessInput,
    context: stageContext,
    envelope: {
      ...validEnvelope,
      courseScopeHash: hashCourseToolValue("fixture.scope", "forged")
    }
  });
  assert.equal(result.status, "failed_before_write");
  if (result.status === "failed_before_write") {
    assert.equal(result.reasonCode, "grant_binding_invalid");
  }
  assert.equal(counters.stage, 0);
  assert.equal(await transactionStore.get(`stage-transaction:${"0".repeat(64)}`), null);
});
