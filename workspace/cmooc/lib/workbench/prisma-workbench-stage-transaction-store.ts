import type {
  Prisma,
  WorkbenchStageTransactionRecord as PrismaWorkbenchStageTransactionRecord
} from "@prisma/client";
import {
  assertEvidenceRefs,
  isIsoInstant,
  isSafeIdentifier,
  isSha256,
  type EvidenceRef
} from "@/lib/course-tools/contracts";
import {
  PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
  PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION,
  type PlatformStageReconciledOutput,
  type PlatformStageVerifiedOutput
} from "@/lib/course-tools/tools/platform-stage";
import type { CourseAgentStageTargetMaterial } from "@/lib/workbench/course-agent-artifact-runtime";
import {
  assertSafeDurableValue,
  serializeSafeDurableValue,
  withWorkbenchTransaction,
  type WorkbenchDb
} from "@/lib/workbench/durable-ledger";
import type { WorkbenchStageTransactionStore } from "@/lib/workbench/trusted-workbench-platform-stage-adapter";
import { prisma as defaultPrisma } from "@/lib/db";

export const WORKBENCH_STAGE_TRANSACTION_STATUSES = [
  "pending",
  "unknown",
  "verified",
  "reconciled"
] as const;

export type WorkbenchStageTransactionStatus =
  (typeof WORKBENCH_STAGE_TRANSACTION_STATUSES)[number];

export const WORKBENCH_STAGE_TRANSACTION_V2_SCHEMA_VERSION =
  "cmooc.workbench-stage-transaction.v2" as const;
export const WORKBENCH_STAGE_TRANSACTION_V3_SCHEMA_VERSION =
  "cmooc.workbench-stage-transaction.v3" as const;
export const WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_V3_SCHEMA_VERSION =
  "cmooc.workbench-stage-transaction-terminal-binding.v3" as const;

export type LegacyCourseAgentStageTargetMaterialV2 = Readonly<
  Omit<CourseAgentStageTargetMaterial, "eventSetHash">
>;

type WorkbenchStageTransactionCore = Readonly<{
  stageTransactionRef: string;
  taskId: string;
  runId: string;
  planRevisionId: string;
  stepId: string;
  callId: string;
  courseAlias: string;
  courseScopeHash: string;
  manifestHash: string;
  policyVersion: string;
  integrityVerificationRef: string;
  target: CourseAgentStageTargetMaterial | LegacyCourseAgentStageTargetMaterialV2;
  artifactVersionRef: string;
  draftBodyHash: string;
  runNonceHash: string;
  baselineRef: string;
  baselineHash: string;
  pageBindingRef: string;
  pageBindingHash: string;
  status: WorkbenchStageTransactionStatus;
  verifiedOutput: PlatformStageVerifiedOutput | PlatformStageReconciledOutput | null;
  createdAt: string;
  updatedAt: string;
}>;

export type WorkbenchStageTransactionFreshBindingV3 = Readonly<{
  preflightRef: string;
  preflightHash: string;
  resolvedTargetReceiptRef: string;
  resolvedTargetReceiptHash: string;
  freshObservationRef: string;
  freshObservationHash: string;
  eventSetHash: string;
  targetLocatorHash: string;
  resolvedAt: string;
}>;

export type SafeWorkbenchStageTransactionRecordV3 = Readonly<
  Omit<WorkbenchStageTransactionCore, "target"> &
    WorkbenchStageTransactionFreshBindingV3 & {
      schemaVersion: typeof WORKBENCH_STAGE_TRANSACTION_V3_SCHEMA_VERSION;
      target: CourseAgentStageTargetMaterial;
      terminalBinding: StageTransactionTerminalBindingV3 | null;
    }
>;

export type SafeWorkbenchLegacyStageTransactionTerminalRecordV2 = Readonly<
  Omit<WorkbenchStageTransactionCore, "target" | "status" | "verifiedOutput"> & {
    schemaVersion: typeof WORKBENCH_STAGE_TRANSACTION_V2_SCHEMA_VERSION;
    target: LegacyCourseAgentStageTargetMaterialV2;
    status: "verified" | "reconciled";
    verifiedOutput: PlatformStageVerifiedOutput | PlatformStageReconciledOutput;
    terminalBinding: null;
  }
>;

export type SafeWorkbenchStageTransactionRecord =
  | SafeWorkbenchStageTransactionRecordV3
  | SafeWorkbenchLegacyStageTransactionTerminalRecordV2;

type TerminalBindingPrivacyClosure = Readonly<{
  containsForumText: false;
  containsIdentity: false;
  containsSecrets: false;
}>;

export type StageTransactionStageTerminalBindingV3 = Readonly<
  TerminalBindingPrivacyClosure & {
    schemaVersion: typeof WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_V3_SCHEMA_VERSION;
    kind: "stage";
    receiptRef: string;
    receiptHash: string;
    resolvedTargetReceiptRef: string;
    resolvedTargetReceiptHash: string;
    freshObservationRef: string;
    freshObservationHash: string;
    eventSetHash: string;
    targetLocatorHash: string;
    resolvedAt: string;
  }
>;

export type StageTransactionReconcileTerminalBindingV3 = Readonly<
  TerminalBindingPrivacyClosure & {
    schemaVersion: typeof WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_V3_SCHEMA_VERSION;
    kind: "reconcile";
    receiptRef: string;
    receiptHash: string;
    originalResolvedTargetReceiptRef: string;
    originalResolvedTargetReceiptHash: string;
    reconcileResolvedTargetReceiptRef: string;
    reconcileResolvedTargetReceiptHash: string;
    reconcileFreshObservationRef: string;
    reconcileFreshObservationHash: string;
    reconcileEventSetHash: string;
    reconcileTargetLocatorHash: string;
    reconcileResolvedAt: string;
  }
>;

export type StageTransactionTerminalBindingV3 =
  | StageTransactionStageTerminalBindingV3
  | StageTransactionReconcileTerminalBindingV3;

const RECORD_KEYS = [
  "schemaVersion",
  "stageTransactionRef",
  "taskId",
  "runId",
  "planRevisionId",
  "stepId",
  "callId",
  "courseAlias",
  "courseScopeHash",
  "manifestHash",
  "policyVersion",
  "integrityVerificationRef",
  "target",
  "artifactVersionRef",
  "draftBodyHash",
  "runNonceHash",
  "baselineRef",
  "baselineHash",
  "pageBindingRef",
  "pageBindingHash",
  "preflightRef",
  "preflightHash",
  "resolvedTargetReceiptRef",
  "resolvedTargetReceiptHash",
  "freshObservationRef",
  "freshObservationHash",
  "eventSetHash",
  "targetLocatorHash",
  "resolvedAt",
  "status",
  "verifiedOutput",
  "terminalBinding",
  "createdAt",
  "updatedAt"
] as const;

const TARGET_KEYS = [
  "targetRef",
  "opportunityId",
  "candidateKey",
  "decisionId",
  "threadKey",
  "targetVersionHash",
  "eventSetHash",
  "opportunityReceiptHash",
  "revalidationReceiptHash",
  "afterObservationReceiptHash",
  "evidenceRefs"
] as const;

const LEGACY_TARGET_KEYS = TARGET_KEYS.filter((key) => key !== "eventSetHash");

const EVIDENCE_REF_KEYS = ["kind", "id", "hash", "observedAt"] as const;

const VERIFIED_OUTPUT_KEYS = [
  "schemaVersion",
  "status",
  "stageTransactionRef",
  "receiptRef",
  "receiptHash",
  "targetRef",
  "targetVersionHash",
  "artifactVersionRef",
  "draftBodyHash",
  "pageBindingRef",
  "pageBindingHash",
  "baselineRef",
  "baselineHash",
  "editorWriteCount",
  "editorReadbackCount",
  "editorReadbackVerified",
  "editorClearCount",
  "editorEmptyAfterClear",
  "submitMutationCount",
  "sendMutationCount",
  "closeAuditStatus",
  "realPublishEnabled",
  "bodyPersisted",
  "published",
  "observedAt",
  "evidenceRefs",
  "containsForumText",
  "containsIdentity",
  "containsSecrets"
] as const;

const RECONCILED_OUTPUT_KEYS = [...VERIFIED_OUTPUT_KEYS, "resolution"] as const;

const STAGE_TERMINAL_BINDING_KEYS = [
  "schemaVersion",
  "kind",
  "receiptRef",
  "receiptHash",
  "resolvedTargetReceiptRef",
  "resolvedTargetReceiptHash",
  "freshObservationRef",
  "freshObservationHash",
  "eventSetHash",
  "targetLocatorHash",
  "resolvedAt",
  "containsForumText",
  "containsIdentity",
  "containsSecrets"
] as const;

const RECONCILE_TERMINAL_BINDING_KEYS = [
  "schemaVersion",
  "kind",
  "receiptRef",
  "receiptHash",
  "originalResolvedTargetReceiptRef",
  "originalResolvedTargetReceiptHash",
  "reconcileResolvedTargetReceiptRef",
  "reconcileResolvedTargetReceiptHash",
  "reconcileFreshObservationRef",
  "reconcileFreshObservationHash",
  "reconcileEventSetHash",
  "reconcileTargetLocatorHash",
  "reconcileResolvedAt",
  "containsForumText",
  "containsIdentity",
  "containsSecrets"
] as const;

type PlainObject = Record<string, unknown>;

function fail(code: string): never {
  throw new Error(code);
}

function assertPlainObject(value: unknown, code: string): asserts value is PlainObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
}

function assertExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
  code: string
): asserts value is PlainObject {
  assertPlainObject(value, code);
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(code);
  }
}

function assertSafeRef(value: unknown, code: string): asserts value is string {
  if (!isSafeIdentifier(value)) fail(code);
}

function assertHash(value: unknown, code: string): asserts value is string {
  if (!isSha256(value)) fail(code);
}

function assertInstant(value: unknown, code: string): asserts value is string {
  if (!isIsoInstant(value)) fail(code);
}

function normalizeEvidenceRefs(value: unknown, code: string): readonly EvidenceRef[] {
  if (!Array.isArray(value) || value.length > 64) fail(code);
  const refs = value.map((candidate) => {
    assertExactKeys(candidate, EVIDENCE_REF_KEYS, code);
    const ref = {
      kind: candidate.kind,
      id: candidate.id,
      hash: candidate.hash,
      observedAt: candidate.observedAt
    } as EvidenceRef;
    assertEvidenceRefs([ref]);
    return Object.freeze({ ...ref });
  });
  assertSafeDurableValue(refs, code);
  return Object.freeze(refs);
}

function normalizeTarget(value: unknown): CourseAgentStageTargetMaterial {
  const code = "WORKBENCH_STAGE_TRANSACTION_TARGET_INVALID";
  assertExactKeys(value, TARGET_KEYS, code);
  assertSafeRef(value.targetRef, code);
  assertSafeRef(value.opportunityId, code);
  assertSafeRef(value.candidateKey, code);
  assertSafeRef(value.decisionId, code);
  assertSafeRef(value.threadKey, code);
  assertHash(value.targetVersionHash, code);
  assertHash(value.eventSetHash, code);
  assertHash(value.opportunityReceiptHash, code);
  assertHash(value.revalidationReceiptHash, code);
  assertHash(value.afterObservationReceiptHash, code);
  const evidenceRefs = normalizeEvidenceRefs(value.evidenceRefs, code);
  return Object.freeze({
    targetRef: value.targetRef,
    opportunityId: value.opportunityId,
    candidateKey: value.candidateKey,
    decisionId: value.decisionId,
    threadKey: value.threadKey,
    targetVersionHash: value.targetVersionHash,
    eventSetHash: value.eventSetHash,
    opportunityReceiptHash: value.opportunityReceiptHash,
    revalidationReceiptHash: value.revalidationReceiptHash,
    afterObservationReceiptHash: value.afterObservationReceiptHash,
    evidenceRefs
  });
}

function normalizeLegacyTarget(
  value: unknown
): LegacyCourseAgentStageTargetMaterialV2 {
  const code = "WORKBENCH_STAGE_TRANSACTION_TARGET_INVALID";
  assertExactKeys(value, LEGACY_TARGET_KEYS, code);
  assertSafeRef(value.targetRef, code);
  assertSafeRef(value.opportunityId, code);
  assertSafeRef(value.candidateKey, code);
  assertSafeRef(value.decisionId, code);
  assertSafeRef(value.threadKey, code);
  assertHash(value.targetVersionHash, code);
  assertHash(value.opportunityReceiptHash, code);
  assertHash(value.revalidationReceiptHash, code);
  assertHash(value.afterObservationReceiptHash, code);
  const evidenceRefs = normalizeEvidenceRefs(value.evidenceRefs, code);
  return Object.freeze({
    targetRef: value.targetRef,
    opportunityId: value.opportunityId,
    candidateKey: value.candidateKey,
    decisionId: value.decisionId,
    threadKey: value.threadKey,
    targetVersionHash: value.targetVersionHash,
    opportunityReceiptHash: value.opportunityReceiptHash,
    revalidationReceiptHash: value.revalidationReceiptHash,
    afterObservationReceiptHash: value.afterObservationReceiptHash,
    evidenceRefs
  });
}

function normalizeVerifiedOutput(
  value: unknown
): PlatformStageVerifiedOutput | PlatformStageReconciledOutput {
  const code = "WORKBENCH_STAGE_TRANSACTION_OUTPUT_INVALID";
  assertPlainObject(value, code);
  const reconciled = value.schemaVersion === PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION;
  assertExactKeys(value, reconciled ? RECONCILED_OUTPUT_KEYS : VERIFIED_OUTPUT_KEYS, code);
  if (
    value.schemaVersion !==
      (reconciled
        ? PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION
        : PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION) ||
    value.status !== (reconciled ? "reconciled_cleared" : "verified_cleared")
  ) {
    fail(code);
  }
  if (
    reconciled &&
    value.resolution !== "already_verified" &&
    value.resolution !== "owned_draft_cleared"
  ) {
    fail(code);
  }
  for (const ref of [
    value.stageTransactionRef,
    value.receiptRef,
    value.targetRef,
    value.artifactVersionRef,
    value.pageBindingRef,
    value.baselineRef
  ]) {
    assertSafeRef(ref, code);
  }
  for (const hash of [
    value.receiptHash,
    value.targetVersionHash,
    value.draftBodyHash,
    value.pageBindingHash,
    value.baselineHash
  ]) {
    assertHash(hash, code);
  }
  assertInstant(value.observedAt, code);
  if (
    value.editorWriteCount !== 1 ||
    value.editorReadbackCount !== 1 ||
    value.editorReadbackVerified !== true ||
    value.editorClearCount !== 1 ||
    value.editorEmptyAfterClear !== true ||
    value.submitMutationCount !== 0 ||
    value.sendMutationCount !== 0 ||
    value.closeAuditStatus !== "passed" ||
    value.realPublishEnabled !== false ||
    value.bodyPersisted !== false ||
    value.published !== false ||
    value.containsForumText !== false ||
    value.containsIdentity !== false ||
    value.containsSecrets !== false
  ) {
    fail(code);
  }
  const evidenceRefs = normalizeEvidenceRefs(value.evidenceRefs, code);
  if (
    evidenceRefs.length < 2 ||
    !evidenceRefs.some(
      (ref) =>
        ref.kind === "stage_receipt" &&
        ref.id === value.receiptRef &&
        ref.hash === value.receiptHash &&
        ref.observedAt === value.observedAt
    )
  ) {
    fail(code);
  }
  const common = {
    schemaVersion: value.schemaVersion,
    status: value.status,
    stageTransactionRef: value.stageTransactionRef,
    receiptRef: value.receiptRef,
    receiptHash: value.receiptHash,
    targetRef: value.targetRef,
    targetVersionHash: value.targetVersionHash,
    artifactVersionRef: value.artifactVersionRef,
    draftBodyHash: value.draftBodyHash,
    pageBindingRef: value.pageBindingRef,
    pageBindingHash: value.pageBindingHash,
    baselineRef: value.baselineRef,
    baselineHash: value.baselineHash,
    editorWriteCount: 1 as const,
    editorReadbackCount: 1 as const,
    editorReadbackVerified: true as const,
    editorClearCount: 1 as const,
    editorEmptyAfterClear: true as const,
    submitMutationCount: 0 as const,
    sendMutationCount: 0 as const,
    closeAuditStatus: "passed" as const,
    realPublishEnabled: false as const,
    bodyPersisted: false as const,
    published: false as const,
    observedAt: value.observedAt,
    evidenceRefs,
    containsForumText: false as const,
    containsIdentity: false as const,
    containsSecrets: false as const
  };
  if (reconciled) {
    return Object.freeze({
      ...common,
      schemaVersion: PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
      status: "reconciled_cleared" as const,
      resolution: value.resolution as PlatformStageReconciledOutput["resolution"]
    }) as PlatformStageReconciledOutput;
  }
  return Object.freeze({
    ...common,
    schemaVersion: PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION,
    status: "verified_cleared" as const
  }) as PlatformStageVerifiedOutput;
}

function normalizeTerminalBinding(
  value: unknown
): StageTransactionTerminalBindingV3 {
  const code = "WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_INVALID";
  assertPlainObject(value, code);
  const reconcile = value.kind === "reconcile";
  assertExactKeys(
    value,
    reconcile ? RECONCILE_TERMINAL_BINDING_KEYS : STAGE_TERMINAL_BINDING_KEYS,
    code
  );
  if (
    value.schemaVersion !==
      WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_V3_SCHEMA_VERSION ||
    (value.kind !== "stage" && value.kind !== "reconcile") ||
    value.containsForumText !== false ||
    value.containsIdentity !== false ||
    value.containsSecrets !== false
  ) {
    fail(code);
  }
  assertSafeRef(value.receiptRef, code);
  assertHash(value.receiptHash, code);
  if (reconcile) {
    for (const ref of [
      value.originalResolvedTargetReceiptRef,
      value.reconcileResolvedTargetReceiptRef,
      value.reconcileFreshObservationRef
    ]) {
      assertSafeRef(ref, code);
    }
    for (const hash of [
      value.originalResolvedTargetReceiptHash,
      value.reconcileResolvedTargetReceiptHash,
      value.reconcileFreshObservationHash,
      value.reconcileEventSetHash,
      value.reconcileTargetLocatorHash
    ]) {
      assertHash(hash, code);
    }
    assertInstant(value.reconcileResolvedAt, code);
    const normalized = {
      schemaVersion: WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_V3_SCHEMA_VERSION,
      kind: "reconcile" as const,
      receiptRef: value.receiptRef,
      receiptHash: value.receiptHash,
      originalResolvedTargetReceiptRef: value.originalResolvedTargetReceiptRef,
      originalResolvedTargetReceiptHash: value.originalResolvedTargetReceiptHash,
      reconcileResolvedTargetReceiptRef: value.reconcileResolvedTargetReceiptRef,
      reconcileResolvedTargetReceiptHash: value.reconcileResolvedTargetReceiptHash,
      reconcileFreshObservationRef: value.reconcileFreshObservationRef,
      reconcileFreshObservationHash: value.reconcileFreshObservationHash,
      reconcileEventSetHash: value.reconcileEventSetHash,
      reconcileTargetLocatorHash: value.reconcileTargetLocatorHash,
      reconcileResolvedAt: value.reconcileResolvedAt,
      containsForumText: false as const,
      containsIdentity: false as const,
      containsSecrets: false as const
    };
    assertSafeDurableValue(normalized, code);
    return Object.freeze(
      normalized
    ) as StageTransactionReconcileTerminalBindingV3;
  }
  for (const ref of [
    value.resolvedTargetReceiptRef,
    value.freshObservationRef
  ]) {
    assertSafeRef(ref, code);
  }
  for (const hash of [
    value.resolvedTargetReceiptHash,
    value.freshObservationHash,
    value.eventSetHash,
    value.targetLocatorHash
  ]) {
    assertHash(hash, code);
  }
  assertInstant(value.resolvedAt, code);
  const normalized = {
    schemaVersion: WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_V3_SCHEMA_VERSION,
    kind: "stage" as const,
    receiptRef: value.receiptRef,
    receiptHash: value.receiptHash,
    resolvedTargetReceiptRef: value.resolvedTargetReceiptRef,
    resolvedTargetReceiptHash: value.resolvedTargetReceiptHash,
    freshObservationRef: value.freshObservationRef,
    freshObservationHash: value.freshObservationHash,
    eventSetHash: value.eventSetHash,
    targetLocatorHash: value.targetLocatorHash,
    resolvedAt: value.resolvedAt,
    containsForumText: false as const,
    containsIdentity: false as const,
    containsSecrets: false as const
  };
  assertSafeDurableValue(normalized, code);
  return Object.freeze(normalized) as StageTransactionStageTerminalBindingV3;
}

const V3_RECORD_ONLY_KEYS = new Set([
  "preflightRef",
  "preflightHash",
  "resolvedTargetReceiptRef",
  "resolvedTargetReceiptHash",
  "freshObservationRef",
  "freshObservationHash",
  "eventSetHash",
  "targetLocatorHash",
  "resolvedAt"
]);
const LEGACY_RECORD_KEYS = RECORD_KEYS.filter((key) => !V3_RECORD_ONLY_KEYS.has(key));

function normalizeRecord(value: unknown): SafeWorkbenchStageTransactionRecord {
  const code = "WORKBENCH_STAGE_TRANSACTION_INVALID";
  assertPlainObject(value, code);
  const legacy = value.schemaVersion === WORKBENCH_STAGE_TRANSACTION_V2_SCHEMA_VERSION;
  if (
    !legacy &&
    value.schemaVersion !== WORKBENCH_STAGE_TRANSACTION_V3_SCHEMA_VERSION
  ) {
    fail(code);
  }
  assertExactKeys(value, legacy ? LEGACY_RECORD_KEYS : RECORD_KEYS, code);
  assertSafeRef(value.stageTransactionRef, code);
  assertSafeRef(value.taskId, code);
  assertSafeRef(value.runId, code);
  assertSafeRef(value.planRevisionId, code);
  assertSafeRef(value.stepId, code);
  assertSafeRef(value.callId, code);
  assertSafeRef(value.courseAlias, code);
  assertHash(value.courseScopeHash, code);
  assertHash(value.manifestHash, code);
  assertSafeRef(value.policyVersion, code);
  assertSafeRef(value.integrityVerificationRef, code);
  assertSafeRef(value.artifactVersionRef, code);
  assertSafeRef(value.baselineRef, code);
  assertSafeRef(value.pageBindingRef, code);
  assertHash(value.draftBodyHash, code);
  assertHash(value.runNonceHash, code);
  assertHash(value.baselineHash, code);
  assertHash(value.pageBindingHash, code);
  assertInstant(value.createdAt, code);
  assertInstant(value.updatedAt, code);
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) fail(code);
  if (
    typeof value.status !== "string" ||
    !WORKBENCH_STAGE_TRANSACTION_STATUSES.includes(
      value.status as WorkbenchStageTransactionStatus
    )
  ) {
    fail(code);
  }
  const target = legacy
    ? normalizeLegacyTarget(value.target)
    : normalizeTarget(value.target);
  const integrityHash = value.integrityVerificationRef.startsWith(
    "integrity-verification:"
  )
    ? value.integrityVerificationRef.slice("integrity-verification:".length)
    : null;
  if (
    !isSha256(integrityHash) ||
    !target.evidenceRefs.some(
      (ref) =>
        ref.kind === "verification" &&
        ref.id === value.integrityVerificationRef &&
        ref.hash === integrityHash
    ) ||
    !target.evidenceRefs.some(
      (ref) => ref.kind === "manifest" && ref.hash === value.manifestHash
    )
  ) {
    fail(code);
  }
  const verifiedOutput =
    value.verifiedOutput === null ? null : normalizeVerifiedOutput(value.verifiedOutput);
  const terminal = value.status === "verified" || value.status === "reconciled";
  if (terminal !== (verifiedOutput !== null)) fail(code);
  if (
    verifiedOutput &&
    ((value.status === "verified" &&
      verifiedOutput.schemaVersion !== PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION) ||
      (value.status === "reconciled" &&
        verifiedOutput.schemaVersion !== PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION))
  ) {
    fail(code);
  }
  const common = {
    stageTransactionRef: value.stageTransactionRef,
    taskId: value.taskId,
    runId: value.runId,
    planRevisionId: value.planRevisionId,
    stepId: value.stepId,
    callId: value.callId,
    courseAlias: value.courseAlias,
    courseScopeHash: value.courseScopeHash,
    manifestHash: value.manifestHash,
    policyVersion: value.policyVersion,
    integrityVerificationRef: value.integrityVerificationRef,
    target,
    artifactVersionRef: value.artifactVersionRef,
    draftBodyHash: value.draftBodyHash,
    runNonceHash: value.runNonceHash,
    baselineRef: value.baselineRef,
    baselineHash: value.baselineHash,
    pageBindingRef: value.pageBindingRef,
    pageBindingHash: value.pageBindingHash,
    status: value.status as WorkbenchStageTransactionStatus,
    verifiedOutput,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  } as const;
  if (legacy) {
    if (!terminal || !verifiedOutput || value.terminalBinding !== null) {
      fail("WORKBENCH_STAGE_TRANSACTION_LEGACY_RECONCILE_ONLY");
    }
    const normalized = {
      schemaVersion: WORKBENCH_STAGE_TRANSACTION_V2_SCHEMA_VERSION,
      ...common,
      target: target as LegacyCourseAgentStageTargetMaterialV2,
      status: value.status as "verified" | "reconciled",
      verifiedOutput,
      terminalBinding: null
    } as const;
    assertOutputBinding(normalized);
    assertSafeDurableValue(normalized, code);
    return Object.freeze(normalized);
  }
  assertSafeRef(value.preflightRef, code);
  assertHash(value.preflightHash, code);
  assertSafeRef(value.resolvedTargetReceiptRef, code);
  assertHash(value.resolvedTargetReceiptHash, code);
  assertSafeRef(value.freshObservationRef, code);
  assertHash(value.freshObservationHash, code);
  assertHash(value.eventSetHash, code);
  assertHash(value.targetLocatorHash, code);
  assertInstant(value.resolvedAt, code);
  const v3Target = target as CourseAgentStageTargetMaterial;
  if (value.freshObservationHash === v3Target.afterObservationReceiptHash) {
    fail("WORKBENCH_STAGE_TRANSACTION_FRESH_OBSERVATION_ALIASED");
  }
  if (value.eventSetHash !== v3Target.eventSetHash) {
    fail("WORKBENCH_STAGE_TRANSACTION_EVENT_SET_MISMATCH");
  }
  if (Date.parse(value.resolvedAt) > Date.parse(value.createdAt)) {
    fail("WORKBENCH_STAGE_TRANSACTION_RESOLVED_AFTER_CREATE");
  }
  const terminalBinding =
    value.terminalBinding === null
      ? null
      : normalizeTerminalBinding(value.terminalBinding);
  if (terminal !== (terminalBinding !== null)) fail(code);
  const normalized = {
    schemaVersion: WORKBENCH_STAGE_TRANSACTION_V3_SCHEMA_VERSION,
    ...common,
    target: v3Target,
    preflightRef: value.preflightRef,
    preflightHash: value.preflightHash,
    resolvedTargetReceiptRef: value.resolvedTargetReceiptRef,
    resolvedTargetReceiptHash: value.resolvedTargetReceiptHash,
    freshObservationRef: value.freshObservationRef,
    freshObservationHash: value.freshObservationHash,
    eventSetHash: value.eventSetHash,
    targetLocatorHash: value.targetLocatorHash,
    resolvedAt: value.resolvedAt,
    terminalBinding
  } as const;
  assertOutputBinding(normalized);
  assertTerminalBinding(normalized);
  assertSafeDurableValue(normalized, code);
  return Object.freeze(normalized);
}

function assertOutputBinding(record: SafeWorkbenchStageTransactionRecord): void {
  const output = record.verifiedOutput;
  if (!output) return;
  if (
    output.stageTransactionRef !== record.stageTransactionRef ||
    output.targetRef !== record.target.targetRef ||
    output.targetVersionHash !== record.target.targetVersionHash ||
    output.artifactVersionRef !== record.artifactVersionRef ||
    output.draftBodyHash !== record.draftBodyHash ||
    output.pageBindingRef !== record.pageBindingRef ||
    output.pageBindingHash !== record.pageBindingHash ||
    output.baselineRef !== record.baselineRef ||
    output.baselineHash !== record.baselineHash
  ) {
    fail("WORKBENCH_STAGE_TRANSACTION_OUTPUT_BINDING_MISMATCH");
  }
}

function assertTerminalBinding(record: SafeWorkbenchStageTransactionRecordV3): void {
  const binding = record.terminalBinding;
  const output = record.verifiedOutput;
  if (!binding || !output) return;
  if (
    binding.receiptRef !== output.receiptRef ||
    binding.receiptHash !== output.receiptHash
  ) {
    fail("WORKBENCH_STAGE_TRANSACTION_TERMINAL_RECEIPT_MISMATCH");
  }
  if (binding.kind === "stage") {
    if (
      record.status !== "verified" ||
      binding.resolvedTargetReceiptRef !== record.resolvedTargetReceiptRef ||
      binding.resolvedTargetReceiptHash !== record.resolvedTargetReceiptHash ||
      binding.freshObservationRef !== record.freshObservationRef ||
      binding.freshObservationHash !== record.freshObservationHash ||
      binding.eventSetHash !== record.eventSetHash ||
      binding.targetLocatorHash !== record.targetLocatorHash ||
      binding.resolvedAt !== record.resolvedAt ||
      Date.parse(binding.resolvedAt) > Date.parse(output.observedAt)
    ) {
      fail("WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_MISMATCH");
    }
    return;
  }
  if (
    record.status !== "reconciled" ||
    binding.originalResolvedTargetReceiptRef !== record.resolvedTargetReceiptRef ||
    binding.originalResolvedTargetReceiptHash !== record.resolvedTargetReceiptHash ||
    binding.reconcileTargetLocatorHash !== record.targetLocatorHash ||
    binding.reconcileFreshObservationHash ===
      record.target.afterObservationReceiptHash ||
    Date.parse(binding.reconcileResolvedAt) < Date.parse(record.resolvedAt) ||
    Date.parse(binding.reconcileResolvedAt) > Date.parse(output.observedAt)
  ) {
    fail("WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_MISMATCH");
  }
}

function parseJson(value: string, code: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    assertSafeDurableValue(parsed, code);
    return parsed;
  } catch {
    return fail(code);
  }
}

function rowToRecord(
  row: PrismaWorkbenchStageTransactionRecord
): SafeWorkbenchStageTransactionRecord {
  if (row.containsForumText || row.containsIdentity || row.containsSecrets) {
    fail("WORKBENCH_STAGE_TRANSACTION_PRIVACY_VIOLATION");
  }
  const status = row.status as WorkbenchStageTransactionStatus;
  const terminal = status === "verified" || status === "reconciled";
  if (terminal !== Boolean(row.terminalAt)) {
    fail("WORKBENCH_STAGE_TRANSACTION_INVALID");
  }
  const legacy = row.schemaVersion === WORKBENCH_STAGE_TRANSACTION_V2_SCHEMA_VERSION;
  const target = {
    targetRef: row.targetRef,
    opportunityId: row.opportunityId,
    candidateKey: row.candidateKey,
    decisionId: row.decisionId,
    threadKey: row.threadKey,
    targetVersionHash: row.targetVersionHash,
    ...(legacy ? {} : { eventSetHash: row.eventSetHash }),
    opportunityReceiptHash: row.opportunityReceiptHash,
    revalidationReceiptHash: row.revalidationReceiptHash,
    afterObservationReceiptHash: row.afterObservationReceiptHash,
    evidenceRefs: parseJson(
      row.targetEvidenceRefsJson,
      "WORKBENCH_STAGE_TRANSACTION_EVIDENCE_INVALID"
    )
  };
  const record = normalizeRecord({
    schemaVersion: row.schemaVersion,
    stageTransactionRef: row.stageTransactionRef,
    taskId: row.taskId,
    runId: row.runId,
    planRevisionId: row.planRevisionId,
    stepId: row.stepId,
    callId: row.callId,
    courseAlias: row.courseAlias,
    courseScopeHash: row.courseScopeHash,
    manifestHash: row.manifestHash,
    policyVersion: row.policyVersion,
    integrityVerificationRef: row.integrityVerificationRef,
    target,
    artifactVersionRef: row.artifactVersionRef,
    draftBodyHash: row.draftBodyHash,
    runNonceHash: row.runNonceHash,
    baselineRef: row.baselineRef,
    baselineHash: row.baselineHash,
    pageBindingRef: row.pageBindingRef,
    pageBindingHash: row.pageBindingHash,
    ...(legacy
      ? {}
      : {
          preflightRef: row.preflightRef,
          preflightHash: row.preflightHash,
          resolvedTargetReceiptRef: row.resolvedTargetReceiptRef,
          resolvedTargetReceiptHash: row.resolvedTargetReceiptHash,
          freshObservationRef: row.freshObservationRef,
          freshObservationHash: row.freshObservationHash,
          eventSetHash: row.eventSetHash,
          targetLocatorHash: row.targetLocatorHash,
          resolvedAt: row.resolvedAt?.toISOString()
        }),
    status,
    verifiedOutput:
      row.verifiedOutputJson === null
        ? null
        : parseJson(
            row.verifiedOutputJson,
            "WORKBENCH_STAGE_TRANSACTION_OUTPUT_INVALID"
          ),
    terminalBinding:
      row.terminalBindingJson === null
        ? null
        : parseJson(
            row.terminalBindingJson,
            "WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_INVALID"
          ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  });
  if (
    terminal &&
    (row.terminalAt?.toISOString() !== record.updatedAt ||
      record.verifiedOutput?.observedAt !== record.updatedAt)
  ) {
    fail("WORKBENCH_STAGE_TRANSACTION_INVALID");
  }
  return record;
}

function immutableBindingJson(record: SafeWorkbenchStageTransactionRecord): string {
  return serializeSafeDurableValue(
    {
      schemaVersion: record.schemaVersion,
      stageTransactionRef: record.stageTransactionRef,
      taskId: record.taskId,
      runId: record.runId,
      planRevisionId: record.planRevisionId,
      stepId: record.stepId,
      callId: record.callId,
      courseAlias: record.courseAlias,
      courseScopeHash: record.courseScopeHash,
      manifestHash: record.manifestHash,
      policyVersion: record.policyVersion,
      integrityVerificationRef: record.integrityVerificationRef,
      target: record.target,
      artifactVersionRef: record.artifactVersionRef,
      draftBodyHash: record.draftBodyHash,
      runNonceHash: record.runNonceHash,
      baselineRef: record.baselineRef,
      baselineHash: record.baselineHash,
      pageBindingRef: record.pageBindingRef,
      pageBindingHash: record.pageBindingHash,
      ...(record.schemaVersion === WORKBENCH_STAGE_TRANSACTION_V3_SCHEMA_VERSION
        ? {
            preflightRef: record.preflightRef,
            preflightHash: record.preflightHash,
            resolvedTargetReceiptRef: record.resolvedTargetReceiptRef,
            resolvedTargetReceiptHash: record.resolvedTargetReceiptHash,
            freshObservationRef: record.freshObservationRef,
            freshObservationHash: record.freshObservationHash,
            eventSetHash: record.eventSetHash,
            targetLocatorHash: record.targetLocatorHash,
            resolvedAt: record.resolvedAt
          }
        : {})
    },
    "WORKBENCH_STAGE_TRANSACTION_BINDING_INVALID"
  );
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function createData(record: SafeWorkbenchStageTransactionRecordV3): Prisma.WorkbenchStageTransactionRecordCreateInput {
  return {
    stageTransactionRef: record.stageTransactionRef,
    schemaVersion: record.schemaVersion,
    task: { connect: { id: record.taskId } },
    run: { connect: { id: record.runId } },
    planRevision: { connect: { id: record.planRevisionId } },
    step: { connect: { id: record.stepId } },
    call: { connect: { id: record.callId } },
    courseAlias: record.courseAlias,
    courseScopeHash: record.courseScopeHash,
    manifestHash: record.manifestHash,
    policyVersion: record.policyVersion,
    integrityVerificationRef: record.integrityVerificationRef,
    targetRef: record.target.targetRef,
    opportunityId: record.target.opportunityId,
    candidateKey: record.target.candidateKey,
    decisionId: record.target.decisionId,
    threadKey: record.target.threadKey,
    targetVersionHash: record.target.targetVersionHash,
    opportunityReceiptHash: record.target.opportunityReceiptHash,
    revalidationReceiptHash: record.target.revalidationReceiptHash,
    afterObservationReceiptHash: record.target.afterObservationReceiptHash,
    targetEvidenceRefsJson: serializeSafeDurableValue(
      record.target.evidenceRefs,
      "WORKBENCH_STAGE_TRANSACTION_EVIDENCE_INVALID"
    ),
    artifactVersionRef: record.artifactVersionRef,
    draftBodyHash: record.draftBodyHash,
    runNonceHash: record.runNonceHash,
    baselineRef: record.baselineRef,
    baselineHash: record.baselineHash,
    pageBindingRef: record.pageBindingRef,
    pageBindingHash: record.pageBindingHash,
    preflightRef: record.preflightRef,
    preflightHash: record.preflightHash,
    resolvedTargetReceiptRef: record.resolvedTargetReceiptRef,
    resolvedTargetReceiptHash: record.resolvedTargetReceiptHash,
    freshObservationRef: record.freshObservationRef,
    freshObservationHash: record.freshObservationHash,
    eventSetHash: record.eventSetHash,
    targetLocatorHash: record.targetLocatorHash,
    resolvedAt: new Date(record.resolvedAt),
    status: "pending",
    verifiedOutputJson: null,
    terminalBindingJson: null,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    terminalAt: null
  };
}

export class PrismaWorkbenchStageTransactionStore
  implements WorkbenchStageTransactionStore
{
  readonly #db: WorkbenchDb;

  constructor(db: WorkbenchDb = defaultPrisma) {
    this.#db = db;
  }

  async createPending(value: SafeWorkbenchStageTransactionRecordV3): Promise<void> {
    if (
      (value as { schemaVersion?: unknown }).schemaVersion ===
      WORKBENCH_STAGE_TRANSACTION_V2_SCHEMA_VERSION
    ) {
      fail("WORKBENCH_STAGE_TRANSACTION_LEGACY_READ_ONLY");
    }
    const record = normalizeRecord(value);
    if (record.schemaVersion !== WORKBENCH_STAGE_TRANSACTION_V3_SCHEMA_VERSION) {
      fail("WORKBENCH_STAGE_TRANSACTION_LEGACY_READ_ONLY");
    }
    if (record.status !== "pending" || record.verifiedOutput !== null) {
      fail("WORKBENCH_STAGE_TRANSACTION_PENDING_REQUIRED");
    }
    const expectedBinding = immutableBindingJson(record);
    try {
      await withWorkbenchTransaction(this.#db, async (transaction) => {
        const [run, plan, step, call] = await Promise.all([
          transaction.workbenchRunRecord.findFirst({
            where: { id: record.runId, taskId: record.taskId },
            select: { id: true }
          }),
          transaction.workbenchPlanRevisionRecord.findFirst({
            where: {
              id: record.planRevisionId,
              taskId: record.taskId,
              runId: record.runId
            },
            select: { id: true }
          }),
          transaction.workbenchPlanStepRecord.findFirst({
            where: {
              id: record.stepId,
              planRevisionId: record.planRevisionId,
              toolName: "platform.editor.stage_verify_clear",
              toolVersion: "1"
            },
            select: { id: true }
          }),
          transaction.workbenchToolCallRecord.findFirst({
            where: {
              id: record.callId,
              taskId: record.taskId,
              runId: record.runId,
              stepId: record.stepId,
              toolName: "platform.editor.stage_verify_clear",
              toolVersion: "1"
            },
            select: { id: true }
          })
        ]);
        if (!run || !plan || !step || !call) {
          fail("WORKBENCH_STAGE_TRANSACTION_SCOPE_MISMATCH");
        }
        const existing = await transaction.workbenchStageTransactionRecord.findUnique({
          where: { stageTransactionRef: record.stageTransactionRef }
        });
        if (existing) {
          if (immutableBindingJson(rowToRecord(existing)) !== expectedBinding) {
            fail("WORKBENCH_STAGE_TRANSACTION_CONFLICT");
          }
          return;
        }
        await transaction.workbenchStageTransactionRecord.create({
          data: createData(record)
        });
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const existing = await this.get(record.stageTransactionRef);
      if (!existing || immutableBindingJson(existing) !== expectedBinding) {
        fail("WORKBENCH_STAGE_TRANSACTION_CONFLICT");
      }
    }
  }

  async markUnknown(stageTransactionRef: string, observedAt: string): Promise<void> {
    assertSafeRef(stageTransactionRef, "WORKBENCH_STAGE_TRANSACTION_REF_INVALID");
    assertInstant(observedAt, "WORKBENCH_STAGE_TRANSACTION_TIME_INVALID");
    await this.#db.workbenchStageTransactionRecord.updateMany({
      where: {
        stageTransactionRef,
        status: { in: ["pending", "unknown"] },
        verifiedOutputJson: null,
        terminalAt: null,
        updatedAt: { lte: new Date(observedAt) }
      },
      data: {
        status: "unknown",
        updatedAt: new Date(observedAt)
      }
    });
  }

  async markVerified(
    stageTransactionRef: string,
    value: PlatformStageVerifiedOutput | PlatformStageReconciledOutput,
    observedAt: string,
    valueBinding: StageTransactionTerminalBindingV3
  ): Promise<void> {
    assertSafeRef(stageTransactionRef, "WORKBENCH_STAGE_TRANSACTION_REF_INVALID");
    assertInstant(observedAt, "WORKBENCH_STAGE_TRANSACTION_TIME_INVALID");
    const output = normalizeVerifiedOutput(value);
    if (output.stageTransactionRef !== stageTransactionRef || output.observedAt !== observedAt) {
      fail("WORKBENCH_STAGE_TRANSACTION_OUTPUT_BINDING_MISMATCH");
    }
    if (!valueBinding) {
      fail("WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_REQUIRED");
    }
    const terminalBinding = normalizeTerminalBinding(valueBinding);
    const current = await this.get(stageTransactionRef);
    if (!current) fail("WORKBENCH_STAGE_TRANSACTION_NOT_FOUND");
    if (current.schemaVersion === WORKBENCH_STAGE_TRANSACTION_V2_SCHEMA_VERSION) {
      fail("WORKBENCH_STAGE_TRANSACTION_LEGACY_READ_ONLY");
    }
    const nextStatus =
      output.schemaVersion === PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION
        ? "reconciled"
        : "verified";
    const candidate = normalizeRecord({
      ...current,
      status: nextStatus,
      verifiedOutput: output,
      terminalBinding,
      updatedAt: observedAt
    });
    if (Date.parse(observedAt) < Date.parse(current.updatedAt)) {
      fail("WORKBENCH_STAGE_TRANSACTION_TIME_REGRESSION");
    }
    const outputJson = serializeSafeDurableValue(
      candidate.verifiedOutput,
      "WORKBENCH_STAGE_TRANSACTION_OUTPUT_INVALID"
    );
    const terminalBindingJson = serializeSafeDurableValue(
      candidate.terminalBinding,
      "WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_INVALID"
    );
    if (current.verifiedOutput) {
      const currentJson = serializeSafeDurableValue(
        current.verifiedOutput,
        "WORKBENCH_STAGE_TRANSACTION_OUTPUT_INVALID"
      );
      if (current.status === nextStatus && currentJson === outputJson) return;
      fail("WORKBENCH_STAGE_TRANSACTION_CONFLICT");
    }
    const updated = await this.#db.workbenchStageTransactionRecord.updateMany({
      where: {
        stageTransactionRef,
        status: { in: ["pending", "unknown"] },
        verifiedOutputJson: null,
        terminalAt: null,
        updatedAt: { lte: new Date(observedAt) }
      },
      data: {
        status: nextStatus,
        verifiedOutputJson: outputJson,
        terminalBindingJson,
        updatedAt: new Date(observedAt),
        terminalAt: new Date(observedAt)
      }
    });
    if (updated.count === 1) return;
    const raced = await this.get(stageTransactionRef);
    if (!raced) fail("WORKBENCH_STAGE_TRANSACTION_NOT_FOUND");
    const racedJson = raced.verifiedOutput
      ? serializeSafeDurableValue(
          raced.verifiedOutput,
          "WORKBENCH_STAGE_TRANSACTION_OUTPUT_INVALID"
        )
      : null;
    if (raced.status === nextStatus && racedJson === outputJson) return;
    fail("WORKBENCH_STAGE_TRANSACTION_CONFLICT");
  }

  async get(
    stageTransactionRef: string
  ): Promise<SafeWorkbenchStageTransactionRecord | null> {
    assertSafeRef(stageTransactionRef, "WORKBENCH_STAGE_TRANSACTION_REF_INVALID");
    const row = await this.#db.workbenchStageTransactionRecord.findUnique({
      where: { stageTransactionRef }
    });
    return row ? rowToRecord(row) : null;
  }
}
