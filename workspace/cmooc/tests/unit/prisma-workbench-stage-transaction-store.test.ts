import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hashCourseScope,
  hashCourseToolValue
} from "../../lib/course-tools/contracts";
import {
  PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION,
  type PlatformStageVerifiedOutput
} from "../../lib/course-tools/tools/platform-stage";
import type { WorkbenchDb } from "../../lib/workbench/durable-ledger";
import {
  PrismaWorkbenchStageTransactionStore,
  WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_V3_SCHEMA_VERSION,
  type StageTransactionStageTerminalBindingV3,
  type SafeWorkbenchStageTransactionRecordV3
} from "../../lib/workbench/prisma-workbench-stage-transaction-store";
import {
  type WorkbenchStageTransactionStore
} from "../../lib/workbench/trusted-workbench-platform-stage-adapter";

const t0 = "2026-08-13T16:00:00.000Z";
const WORKBENCH_STAGE_TRANSACTION_V2 =
  "cmooc.workbench-stage-transaction.v2" as const;
const WORKBENCH_STAGE_TRANSACTION_V3 =
  "cmooc.workbench-stage-transaction.v3" as const;

type V3Record = SafeWorkbenchStageTransactionRecordV3;

function hash(label: string): string {
  return hashCourseToolValue("test.workbench-stage-transaction", label);
}

function pendingRecord(): V3Record {
  const manifestHash = hash("manifest");
  const integrityVerificationRef = `integrity-verification:${hash("integrity")}`;
  return {
    schemaVersion: WORKBENCH_STAGE_TRANSACTION_V3,
    stageTransactionRef: `stage-transaction:${hash("transaction")}`,
    taskId: "task:stage-store-unit",
    runId: "run:stage-store-unit",
    planRevisionId: "plan:stage-store-unit",
    stepId: "step:stage-store-unit",
    callId: "call:stage-store-unit",
    courseAlias: "bnu-test",
    courseScopeHash: hashCourseScope({
      courseId: "course-private-unit",
      alias: "bnu-test",
      manifestHash
    }),
    manifestHash,
    policyVersion: "cmooc.course-tool.policy.v1",
    integrityVerificationRef,
    target: {
      targetRef: `support-gap:${hash("candidate")}`,
      opportunityId: `support-gap:${hash("candidate")}`,
      candidateKey: hash("candidate"),
      decisionId: "decision:stage-store-unit",
      threadKey: "thread:stage-store-unit",
      targetVersionHash: hash("target-version"),
      eventSetHash: hash("fresh-event-set"),
      opportunityReceiptHash: hash("opportunity-receipt"),
      revalidationReceiptHash: hash("revalidation-receipt"),
      afterObservationReceiptHash: hash("after-observation"),
      evidenceRefs: [
        {
          kind: "manifest",
          id: "bnu-test",
          hash: manifestHash,
          observedAt: t0
        },
        {
          kind: "verification",
          id: integrityVerificationRef,
          hash: hash("integrity"),
          observedAt: t0
        }
      ]
    },
    artifactVersionRef: "artifact-version:stage-store-unit",
    draftBodyHash: hash("draft"),
    runNonceHash: hash("nonce"),
    baselineRef: `editor-baseline:${hash("baseline")}`,
    baselineHash: hash("baseline"),
    pageBindingRef: `page-binding:${hash("page-binding")}`,
    pageBindingHash: hash("page-binding"),
    preflightRef: `preflight:${hash("preflight")}`,
    preflightHash: hash("preflight"),
    resolvedTargetReceiptRef: `resolved-target:${hash("resolved-target")}`,
    resolvedTargetReceiptHash: hash("resolved-target"),
    freshObservationRef: `fresh-observation:${hash("fresh-observation")}`,
    freshObservationHash: hash("fresh-observation"),
    eventSetHash: hash("fresh-event-set"),
    targetLocatorHash: hash("target-locator"),
    resolvedAt: t0,
    status: "pending",
    verifiedOutput: null,
    terminalBinding: null,
    createdAt: t0,
    updatedAt: t0
  } as V3Record;
}

function verifiedOutput(
  record: V3Record
): PlatformStageVerifiedOutput {
  const observedAt = "2026-08-13T16:01:00.000Z";
  return {
    schemaVersion: PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION,
    status: "verified_cleared",
    stageTransactionRef: record.stageTransactionRef,
    receiptRef: `stage-receipt:${hash("receipt")}`,
    receiptHash: hash("receipt"),
    targetRef: record.target.targetRef,
    targetVersionHash: record.target.targetVersionHash,
    artifactVersionRef: record.artifactVersionRef,
    draftBodyHash: record.draftBodyHash,
    pageBindingRef: record.pageBindingRef,
    pageBindingHash: record.pageBindingHash,
    baselineRef: record.baselineRef,
    baselineHash: record.baselineHash,
    editorWriteCount: 1,
    editorReadbackCount: 1,
    editorReadbackVerified: true,
    editorClearCount: 1,
    editorEmptyAfterClear: true,
    submitMutationCount: 0,
    sendMutationCount: 0,
    closeAuditStatus: "passed",
    realPublishEnabled: false,
    bodyPersisted: false,
    published: false,
    observedAt,
    evidenceRefs: [
      ...record.target.evidenceRefs,
      {
        kind: "stage_receipt",
        id: `stage-receipt:${hash("receipt")}`,
        hash: hash("receipt"),
        observedAt
      }
    ] as unknown as PlatformStageVerifiedOutput["evidenceRefs"],
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
}

function terminalBinding(
  record: V3Record,
  output: PlatformStageVerifiedOutput
): StageTransactionStageTerminalBindingV3 {
  return {
    schemaVersion: WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_V3_SCHEMA_VERSION,
    kind: "stage",
    receiptRef: output.receiptRef,
    receiptHash: output.receiptHash,
    resolvedTargetReceiptRef: record.resolvedTargetReceiptRef,
    resolvedTargetReceiptHash: record.resolvedTargetReceiptHash,
    freshObservationRef: record.freshObservationRef,
    freshObservationHash: record.freshObservationHash,
    eventSetHash: record.eventSetHash,
    targetLocatorHash: record.targetLocatorHash,
    resolvedAt: record.resolvedAt,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
}

function inaccessibleDb(): WorkbenchDb {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("DATABASE_MUST_NOT_BE_TOUCHED");
      }
    }
  ) as WorkbenchDb;
}

test("the Prisma implementation satisfies the trusted transaction-store contract", () => {
  const contract: WorkbenchStageTransactionStore =
    new PrismaWorkbenchStageTransactionStore(inaccessibleDb());
  assert.ok(contract);
});

test("body-like extra fields and URL-shaped target references fail before persistence", async () => {
  const store = new PrismaWorkbenchStageTransactionStore(inaccessibleDb());
  const record = pendingRecord();
  await assert.rejects(
    store.createPending({
      ...record,
      target: { ...record.target, body: "must-never-persist" }
    } as unknown as V3Record),
    /WORKBENCH_STAGE_TRANSACTION_TARGET_INVALID/
  );
  await assert.rejects(
    store.createPending({
      ...record,
      target: { ...record.target, targetRef: "https://example.invalid/private" }
    }),
    /WORKBENCH_STAGE_TRANSACTION_TARGET_INVALID/
  );
});

test("closed v3 checkpoint rejects courseId, URL, body, identity, and credential sentinels", async () => {
  const store = new PrismaWorkbenchStageTransactionStore(inaccessibleDb());
  const record = pendingRecord();
  for (const extra of [
    { courseId: "private-course-id" },
    { targetUrl: "https://example.invalid/private" },
    { body: "must-never-persist" },
    { identity: "person@example.invalid" },
    { cookie: "secret-cookie" },
    { token: "bearer secret" }
  ]) {
    await assert.rejects(
      store.createPending({
        ...record,
        ...extra
      } as unknown as V3Record),
      /WORKBENCH_STAGE_TRANSACTION_INVALID/
    );
  }
});

test("v3 requires every fresh-target binding and rejects aliases of the source observation", async () => {
  const store = new PrismaWorkbenchStageTransactionStore(inaccessibleDb());
  const record = pendingRecord();
  for (const field of [
    "preflightRef",
    "preflightHash",
    "resolvedTargetReceiptRef",
    "resolvedTargetReceiptHash",
    "freshObservationRef",
    "freshObservationHash",
    "eventSetHash",
    "targetLocatorHash",
    "resolvedAt"
  ] as const) {
    const missing = { ...record } as Record<string, unknown>;
    delete missing[field];
    await assert.rejects(
      store.createPending(missing as unknown as V3Record),
      /WORKBENCH_STAGE_TRANSACTION_INVALID/
    );
  }
  await assert.rejects(
    store.createPending({
      ...record,
      freshObservationHash: record.target.afterObservationReceiptHash
    } as V3Record),
    /WORKBENCH_STAGE_TRANSACTION_FRESH_OBSERVATION_ALIASED/
  );
  await assert.rejects(
    store.createPending({
      ...record,
      resolvedAt: "2026-08-13T16:00:00.001Z"
    } as V3Record),
    /WORKBENCH_STAGE_TRANSACTION_RESOLVED_AFTER_CREATE/
  );
});

test("v3 opaque receipts reject URL, identity and credential shaped persistence", async () => {
  const store = new PrismaWorkbenchStageTransactionStore(inaccessibleDb());
  const record = pendingRecord();
  for (const [field, value] of [
    ["preflightRef", "https://example.invalid/private"],
    ["resolvedTargetReceiptRef", "person@example.invalid"],
    ["freshObservationRef", "bearer secret"]
  ] as const) {
    await assert.rejects(
      store.createPending({
        ...record,
        [field]: value
      } as V3Record),
      /WORKBENCH_STAGE_TRANSACTION_INVALID/
    );
  }
});

test("legacy v2 records are read-only and cannot start a new transaction", async () => {
  const store = new PrismaWorkbenchStageTransactionStore(inaccessibleDb());
  const record = pendingRecord();
  const legacy = { ...record } as Record<string, unknown>;
  legacy.schemaVersion = WORKBENCH_STAGE_TRANSACTION_V2;
  for (const field of [
    "preflightRef",
    "preflightHash",
    "resolvedTargetReceiptRef",
    "resolvedTargetReceiptHash",
    "freshObservationRef",
    "freshObservationHash",
    "eventSetHash",
    "targetLocatorHash",
    "resolvedAt"
  ]) {
    delete legacy[field];
  }
  await assert.rejects(
    store.createPending(legacy as unknown as V3Record),
    /WORKBENCH_STAGE_TRANSACTION_LEGACY_READ_ONLY/
  );
});

test("integrity and manifest evidence must close the canonical checkpoint", async () => {
  const store = new PrismaWorkbenchStageTransactionStore(inaccessibleDb());
  const record = pendingRecord();
  await assert.rejects(
    store.createPending({
      ...record,
      integrityVerificationRef: "integrity-verification:other"
    }),
    /WORKBENCH_STAGE_TRANSACTION_INVALID/
  );
  await assert.rejects(
    store.createPending({
      ...record,
      manifestHash: hash("other-manifest")
    }),
    /WORKBENCH_STAGE_TRANSACTION_INVALID/
  );
});

test("a receipt that claims body persistence is rejected before database access", async () => {
  const store = new PrismaWorkbenchStageTransactionStore(inaccessibleDb());
  const record = pendingRecord();
  const output = verifiedOutput(record);
  await assert.rejects(
    store.markVerified(
      record.stageTransactionRef,
      { ...output, bodyPersisted: true } as unknown as PlatformStageVerifiedOutput,
      output.observedAt,
      terminalBinding(record, output)
    ),
    /WORKBENCH_STAGE_TRANSACTION_OUTPUT_INVALID/
  );
});

test("v3 terminal binding is privacy-closed before database access", async () => {
  const store = new PrismaWorkbenchStageTransactionStore(inaccessibleDb());
  const record = pendingRecord();
  const output = verifiedOutput(record);
  for (const binding of [
    { ...terminalBinding(record, output), body: "must-never-persist" },
    { ...terminalBinding(record, output), containsSecrets: true },
    {
      ...terminalBinding(record, output),
      resolvedTargetReceiptRef: "https://example.invalid/private"
    }
  ]) {
    await assert.rejects(
      store.markVerified(
        record.stageTransactionRef,
        output,
        output.observedAt,
        binding as StageTransactionStageTerminalBindingV3
      ),
      /WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_INVALID/
    );
  }
});
