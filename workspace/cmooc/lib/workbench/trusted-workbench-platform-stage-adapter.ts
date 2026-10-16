import { randomBytes } from "node:crypto";
import {
  assertEvidenceRefs,
  hashCourseScope,
  hashCourseToolValue,
  isSafeIdentifier,
  isSha256,
  type EvidenceRef,
  type ServerToolExecutionContext,
  type ToolExecutionEnvelope
} from "@/lib/course-tools/contracts";
import {
  PLATFORM_PREFLIGHT_OUTPUT_SCHEMA_VERSION,
  PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
  PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION,
  type PlatformStageReconciledOutput,
  type PlatformStageVerifiedOutput,
  type TrustedPlatformStageAdapter,
  type TrustedPlatformStageOutcome,
  type TrustedPlatformTargetPreflightMaterial
} from "@/lib/course-tools/tools/platform-stage";
import {
  CmoocQuillStageCompanionDriver,
  type CmoocQuillStageBaseline,
  type CmoocQuillStageReconcileResult
} from "@/lib/live-runtime/cmooc-quill-stage-driver";
import {
  openCmoocQuillStageBrowserBridge,
  type StageBrowserBridgeAudit
} from "@/lib/live-runtime/cmooc-quill-stage-browser-bridge";
import {
  executeStageCompanionRun,
  issueStageCompanionTokenV3,
  type StageCompanionPageStateV3,
  type StageRunNonceRegistry,
  type TrustedStageCompanionDriver
} from "@/lib/live-runtime/stage-companion";
import {
  PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
  hashPreExecutionTargetObservation,
  type BoundPreExecutionTargetObservation
} from "@/lib/autonomy/execution-permit";
import type {
  CourseAgentStageMaterialBinding,
  CourseAgentStageTargetMaterial
} from "@/lib/workbench/course-agent-artifact-runtime";
import type { CourseAgentProtectedMaterialVault } from "@/lib/workbench/course-agent-protected-material-vault";

export const TRUSTED_WORKBENCH_STAGE_ADAPTER_SCHEMA_VERSION =
  "cmooc.trusted-workbench-stage-adapter.v1" as const;
export const WORKBENCH_STAGE_TRANSACTION_V2_SCHEMA_VERSION =
  "cmooc.workbench-stage-transaction.v2" as const;
export const WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION =
  "cmooc.workbench-stage-transaction.v3" as const;
export const WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_SCHEMA_VERSION =
  "cmooc.workbench-stage-transaction-terminal-binding.v3" as const;
export const WORKBENCH_STAGE_RECONCILIATION_RECEIPT_V1_SCHEMA_VERSION =
  "cmooc.workbench-stage-reconciliation-receipt.v1" as const;
export const WORKBENCH_STAGE_RECONCILIATION_RECEIPT_SCHEMA_VERSION =
  "cmooc.workbench-stage-reconciliation-receipt.v2" as const;
export const WORKBENCH_STAGE_TARGET_RESOLUTION_SCHEMA_VERSION =
  "cmooc.workbench-stage-target-resolution.v2" as const;
export const WORKBENCH_RESOLVED_STAGE_TARGET_RECEIPT_SCHEMA_VERSION =
  "cmooc.workbench-resolved-stage-target-receipt.v2" as const;

const MAX_PREFLIGHT_AGE_MS = 5 * 60_000;
const MAX_RESOLVED_TARGET_AGE_MS = 30_000;
const MAX_RESOLVED_TARGET_FUTURE_SKEW_MS = 5_000;

export type WorkbenchResolvedStageTargetReceiptV2 = Readonly<{
  schemaVersion: typeof WORKBENCH_RESOLVED_STAGE_TARGET_RECEIPT_SCHEMA_VERSION;
  courseAlias: string;
  courseScopeHash: string;
  manifestHash: string;
  stageTargetBindingHash: string;
  targetRef: string;
  opportunityId: string;
  candidateKey: string;
  decisionId: string;
  threadKey: string;
  sourceRevalidationReceiptHash: string;
  sourceAfterObservationReceiptHash: string;
  courseLocatorHash: string;
  targetLocatorHash: string;
  targetVersionHash: string;
  eventSetHash: string;
  freshObservationRef: string;
  freshObservationHash: string;
  resolvedAt: string;
  readOnly: true;
  externalWriteAttempted: false;
  containsForumText: false;
  containsIdentity: false;
  containsSecrets: false;
}>;

export type ResolvedWorkbenchStageTarget = Readonly<{
  schemaVersion: typeof WORKBENCH_STAGE_TARGET_RESOLUTION_SCHEMA_VERSION;
  targetUrl: string;
  allowedOrigin: string;
  courseLocatorHash: string;
  targetLocatorHash: string;
  targetVersionHash: string;
  eventSetHash: string;
  sourceRevalidationReceiptHash: string;
  sourceAfterObservationReceiptHash: string;
  freshObservation: BoundPreExecutionTargetObservation;
  freshObservationRef: string;
  freshObservationHash: string;
  resolvedAt: string;
  resolvedTargetReceipt: WorkbenchResolvedStageTargetReceiptV2;
  resolvedTargetReceiptRef: string;
  resolvedTargetReceiptHash: string;
  evidenceRefs: readonly EvidenceRef[];
  readOnly: true;
  externalWriteAttempted: false;
  containsForumText: false;
  containsIdentity: false;
  containsSecrets: false;
}>;

export interface WorkbenchStageTargetResolver {
  resolve(input: {
    target: CourseAgentStageTargetMaterial;
    courseAlias: string;
    courseScopeHash: string;
    manifestHash: string;
    requestedAt: string;
  }): Promise<ResolvedWorkbenchStageTarget | null>;
}

export type WorkbenchStageBrowserCloseAudit = Readonly<{
  status: "passed" | "unknown";
  sentMutationCount: 0;
  publishAttempted: false;
  containsForumText: false;
}>;

export interface WorkbenchStageBrowserSession {
  readonly expectedPage: StageCompanionPageStateV3;
  readonly guardReceiptHash: string;
  readonly pageBindingRef: string;
  readonly pageBindingHash: string;
  readonly driver: TrustedStageCompanionDriver;
  inspectBaseline(): Promise<CmoocQuillStageBaseline>;
  reconcileOwned(input: {
    runNonceHash: string;
    transientDraft: string;
  }): Promise<CmoocQuillStageReconcileResult>;
  close(): Promise<WorkbenchStageBrowserCloseAudit>;
}

export interface WorkbenchStageBrowserSessionFactory {
  open(input: {
    target: ResolvedWorkbenchStageTarget;
    targetRef: string;
    courseAlias: string;
    observedAt: string;
  }): Promise<WorkbenchStageBrowserSession>;
}

/**
 * Body-free canonical checkpoint for the original STAGE attempt. Recovery
 * calls may have their own call id, but they can never rewrite these fields.
 */
type SafeStageTransactionCore = Readonly<{
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
  artifactVersionRef: string;
  draftBodyHash: string;
  runNonceHash: string;
  baselineRef: string;
  baselineHash: string;
  pageBindingRef: string;
  pageBindingHash: string;
  createdAt: string;
  updatedAt: string;
}>;

export type StageTransactionStageTerminalBindingV3 = Readonly<{
  schemaVersion: typeof WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_SCHEMA_VERSION;
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
  containsForumText: false;
  containsIdentity: false;
  containsSecrets: false;
}>;

export type StageTransactionReconcileTerminalBindingV3 = Readonly<{
  schemaVersion: typeof WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_SCHEMA_VERSION;
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
  containsForumText: false;
  containsIdentity: false;
  containsSecrets: false;
}>;

export type StageTransactionTerminalBindingV3 =
  | StageTransactionStageTerminalBindingV3
  | StageTransactionReconcileTerminalBindingV3;

export type SafeStageTransactionRecordV3 = Readonly<
  SafeStageTransactionCore & {
  schemaVersion: typeof WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION;
    target: CourseAgentStageTargetMaterial;
    preflightRef: string;
    preflightHash: string;
    resolvedTargetReceiptRef: string;
    resolvedTargetReceiptHash: string;
    freshObservationRef: string;
    freshObservationHash: string;
    eventSetHash: string;
    targetLocatorHash: string;
    resolvedAt: string;
    status: "pending" | "unknown" | "verified" | "reconciled";
    verifiedOutput:
      | PlatformStageVerifiedOutput
      | PlatformStageReconciledOutput
      | null;
    terminalBinding: StageTransactionTerminalBindingV3 | null;
  }
>;

export type SafeLegacyTerminalStageTransactionRecordV2 = Readonly<
  SafeStageTransactionCore & {
    schemaVersion: typeof WORKBENCH_STAGE_TRANSACTION_V2_SCHEMA_VERSION;
    target: Readonly<Omit<CourseAgentStageTargetMaterial, "eventSetHash">>;
    status: "verified" | "reconciled";
    verifiedOutput: PlatformStageVerifiedOutput | PlatformStageReconciledOutput;
    terminalBinding: null;
  }
>;

export type SafeStageTransactionRecord =
  | SafeStageTransactionRecordV3
  | SafeLegacyTerminalStageTransactionRecordV2;

export interface WorkbenchStageTransactionStore {
  createPending(record: SafeStageTransactionRecordV3): Promise<void>;
  markUnknown(stageTransactionRef: string, observedAt: string): Promise<void>;
  markVerified(
    stageTransactionRef: string,
    output: PlatformStageVerifiedOutput | PlatformStageReconciledOutput,
    observedAt: string,
    terminalBinding: StageTransactionTerminalBindingV3
  ): Promise<void>;
  get(stageTransactionRef: string): Promise<SafeStageTransactionRecord | null>;
}

export class InMemoryWorkbenchStageTransactionStore
  implements WorkbenchStageTransactionStore
{
  readonly #records = new Map<string, SafeStageTransactionRecord>();

  async createPending(record: SafeStageTransactionRecordV3): Promise<void> {
    const existing = this.#records.get(record.stageTransactionRef);
    if (existing) {
      if (
        existing.taskId !== record.taskId ||
        existing.runId !== record.runId ||
        existing.planRevisionId !== record.planRevisionId ||
        existing.stepId !== record.stepId ||
        existing.callId !== record.callId ||
        existing.courseAlias !== record.courseAlias ||
        existing.courseScopeHash !== record.courseScopeHash ||
        existing.manifestHash !== record.manifestHash ||
        existing.policyVersion !== record.policyVersion ||
        existing.integrityVerificationRef !== record.integrityVerificationRef ||
        JSON.stringify(existing.target) !== JSON.stringify(record.target) ||
        existing.artifactVersionRef !== record.artifactVersionRef ||
        existing.draftBodyHash !== record.draftBodyHash ||
        existing.runNonceHash !== record.runNonceHash ||
        existing.schemaVersion !== WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION ||
        existing.preflightRef !== record.preflightRef ||
        existing.preflightHash !== record.preflightHash ||
        existing.resolvedTargetReceiptRef !== record.resolvedTargetReceiptRef ||
        existing.resolvedTargetReceiptHash !== record.resolvedTargetReceiptHash ||
        existing.freshObservationRef !== record.freshObservationRef ||
        existing.freshObservationHash !== record.freshObservationHash ||
        existing.eventSetHash !== record.eventSetHash ||
        existing.targetLocatorHash !== record.targetLocatorHash ||
        existing.resolvedAt !== record.resolvedAt
      ) {
        throw new Error("WORKBENCH_STAGE_TRANSACTION_CONFLICT");
      }
      return;
    }
    this.#records.set(record.stageTransactionRef, Object.freeze({ ...record }));
  }

  async markUnknown(stageTransactionRef: string, observedAt: string): Promise<void> {
    const current = this.#records.get(stageTransactionRef);
    if (
      !current ||
      current.schemaVersion !== WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION ||
      current.status === "verified" ||
      current.status === "reconciled"
    ) {
      return;
    }
    this.#records.set(
      stageTransactionRef,
      Object.freeze({ ...current, status: "unknown", updatedAt: observedAt })
    );
  }

  async markVerified(
    stageTransactionRef: string,
    output: PlatformStageVerifiedOutput | PlatformStageReconciledOutput,
    observedAt: string,
    terminalBinding: StageTransactionTerminalBindingV3
  ): Promise<void> {
    const current = this.#records.get(stageTransactionRef);
    if (!current) throw new Error("WORKBENCH_STAGE_TRANSACTION_NOT_FOUND");
    if (current.schemaVersion !== WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION) {
      throw new Error("WORKBENCH_STAGE_TRANSACTION_LEGACY_TERMINAL");
    }
    if (
      output.stageTransactionRef !== stageTransactionRef ||
      output.observedAt !== observedAt ||
      terminalBinding.receiptRef !== output.receiptRef ||
      terminalBinding.receiptHash !== output.receiptHash ||
      terminalBinding.containsForumText !== false ||
      terminalBinding.containsIdentity !== false ||
      terminalBinding.containsSecrets !== false
    ) {
      throw new Error("WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_MISMATCH");
    }
    if (
      terminalBinding.kind === "stage" &&
      (terminalBinding.resolvedTargetReceiptRef !==
        current.resolvedTargetReceiptRef ||
        terminalBinding.resolvedTargetReceiptHash !==
          current.resolvedTargetReceiptHash ||
        terminalBinding.freshObservationRef !== current.freshObservationRef ||
        terminalBinding.freshObservationHash !== current.freshObservationHash ||
        terminalBinding.eventSetHash !== current.eventSetHash ||
        terminalBinding.targetLocatorHash !== current.targetLocatorHash ||
        terminalBinding.resolvedAt !== current.resolvedAt)
    ) {
      throw new Error("WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_MISMATCH");
    }
    if (
      terminalBinding.kind === "reconcile" &&
      (terminalBinding.originalResolvedTargetReceiptRef !==
        current.resolvedTargetReceiptRef ||
        terminalBinding.originalResolvedTargetReceiptHash !==
          current.resolvedTargetReceiptHash ||
        terminalBinding.reconcileTargetLocatorHash !==
          current.targetLocatorHash)
    ) {
      throw new Error("WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_MISMATCH");
    }
    this.#records.set(
      stageTransactionRef,
      Object.freeze({
        ...current,
        status:
          output.schemaVersion === PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION
            ? "reconciled"
            : "verified",
        verifiedOutput: Object.freeze({ ...output }),
        terminalBinding: Object.freeze({ ...terminalBinding }),
        updatedAt: observedAt
      })
    );
  }

  async get(stageTransactionRef: string): Promise<SafeStageTransactionRecord | null> {
    return this.#records.get(stageTransactionRef) ?? null;
  }
}

type PreflightRecord = Readonly<{
  taskId: string;
  runId: string;
  targetRef: string;
  targetVersionHash: string;
  eventSetHash: string;
  targetLocatorHash: string;
  freshObservationRef: string;
  freshObservationHash: string;
  resolvedTargetReceiptRef: string;
  resolvedTargetReceiptHash: string;
  resolvedAt: string;
  preflightRef: string;
  preflightHash: string;
  baselineRef: string;
  baselineHash: string;
  pageBindingRef: string;
  pageBindingHash: string;
  observedAt: string;
}>;

const RESOLVED_TARGET_RECEIPT_KEYS = Object.freeze([
  "schemaVersion",
  "courseAlias",
  "courseScopeHash",
  "manifestHash",
  "stageTargetBindingHash",
  "targetRef",
  "opportunityId",
  "candidateKey",
  "decisionId",
  "threadKey",
  "sourceRevalidationReceiptHash",
  "sourceAfterObservationReceiptHash",
  "courseLocatorHash",
  "targetLocatorHash",
  "targetVersionHash",
  "eventSetHash",
  "freshObservationRef",
  "freshObservationHash",
  "resolvedAt",
  "readOnly",
  "externalWriteAttempted",
  "containsForumText",
  "containsIdentity",
  "containsSecrets"
] as const);

const RESOLVED_TARGET_KEYS = Object.freeze([
  "schemaVersion",
  "targetUrl",
  "allowedOrigin",
  "courseLocatorHash",
  "targetLocatorHash",
  "targetVersionHash",
  "eventSetHash",
  "sourceRevalidationReceiptHash",
  "sourceAfterObservationReceiptHash",
  "freshObservation",
  "freshObservationRef",
  "freshObservationHash",
  "resolvedAt",
  "resolvedTargetReceipt",
  "resolvedTargetReceiptRef",
  "resolvedTargetReceiptHash",
  "evidenceRefs",
  "readOnly",
  "externalWriteAttempted",
  "containsForumText",
  "containsIdentity",
  "containsSecrets"
] as const);

const PRE_EXECUTION_OBSERVATION_KEYS = Object.freeze([
  "schemaVersion",
  "courseAlias",
  "threadKey",
  "targetVersionHash",
  "eventSetHash",
  "observedAt",
  "containsForumText"
] as const);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
}

function canonicalIsoInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString() === value ? value : null;
}

function stageTargetBindingHash(input: {
  target: CourseAgentStageTargetMaterial;
  courseAlias: string;
  courseScopeHash: string;
  manifestHash: string;
}): string {
  return hashCourseToolValue("cmooc.workbench-stage-target-binding.v2", {
    courseAlias: input.courseAlias,
    courseScopeHash: input.courseScopeHash,
    manifestHash: input.manifestHash,
    targetRef: input.target.targetRef,
    opportunityId: input.target.opportunityId,
    candidateKey: input.target.candidateKey,
    decisionId: input.target.decisionId,
    threadKey: input.target.threadKey,
    expectedTargetVersionHash: input.target.targetVersionHash,
    expectedEventSetHash: input.target.eventSetHash,
    opportunityReceiptHash: input.target.opportunityReceiptHash,
    sourceRevalidationReceiptHash: input.target.revalidationReceiptHash,
    sourceAfterObservationReceiptHash: input.target.afterObservationReceiptHash
  });
}

export function buildResolvedWorkbenchStageTargetReceiptV2(input: {
  target: CourseAgentStageTargetMaterial;
  courseAlias: string;
  courseScopeHash: string;
  manifestHash: string;
  courseLocatorHash: string;
  targetLocatorHash: string;
  freshObservation: BoundPreExecutionTargetObservation;
}): Readonly<{
  receipt: WorkbenchResolvedStageTargetReceiptV2;
  receiptRef: string;
  receiptHash: string;
}> {
  const fresh = input.freshObservation;
  const resolvedAt = canonicalIsoInstant(fresh.receipt.observedAt);
  if (
    !hasExactKeys(fresh, ["receipt", "receiptHash"]) ||
    !hasExactKeys(fresh.receipt, PRE_EXECUTION_OBSERVATION_KEYS) ||
    fresh.receipt.schemaVersion !== PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION ||
    fresh.receipt.containsForumText !== false ||
    fresh.receipt.courseAlias !== input.courseAlias ||
    fresh.receipt.threadKey !== input.target.threadKey ||
    !isSha256(fresh.receipt.targetVersionHash) ||
    !isSha256(fresh.receipt.eventSetHash) ||
    !isSha256(fresh.receiptHash) ||
    hashPreExecutionTargetObservation(fresh.receipt) !== fresh.receiptHash ||
    resolvedAt === null ||
    !isSafeIdentifier(input.courseAlias) ||
    !isSafeIdentifier(input.target.targetRef) ||
    !isSafeIdentifier(input.target.opportunityId) ||
    !isSafeIdentifier(input.target.candidateKey) ||
    !isSafeIdentifier(input.target.decisionId) ||
    !isSafeIdentifier(input.target.threadKey) ||
    !isSha256(input.courseScopeHash) ||
    !isSha256(input.manifestHash) ||
    !isSha256(input.courseLocatorHash) ||
    !isSha256(input.targetLocatorHash) ||
    !isSha256(input.target.targetVersionHash) ||
    !isSha256(input.target.eventSetHash) ||
    !isSha256(input.target.opportunityReceiptHash) ||
    !isSha256(input.target.revalidationReceiptHash) ||
    !isSha256(input.target.afterObservationReceiptHash)
  ) {
    throw new Error("WORKBENCH_STAGE_TARGET_RECEIPT_INVALID");
  }
  const freshObservationRef = `fresh-observation:${fresh.receiptHash}`;
  const receipt: WorkbenchResolvedStageTargetReceiptV2 = Object.freeze({
    schemaVersion: WORKBENCH_RESOLVED_STAGE_TARGET_RECEIPT_SCHEMA_VERSION,
    courseAlias: input.courseAlias,
    courseScopeHash: input.courseScopeHash,
    manifestHash: input.manifestHash,
    stageTargetBindingHash: stageTargetBindingHash(input),
    targetRef: input.target.targetRef,
    opportunityId: input.target.opportunityId,
    candidateKey: input.target.candidateKey,
    decisionId: input.target.decisionId,
    threadKey: input.target.threadKey,
    sourceRevalidationReceiptHash: input.target.revalidationReceiptHash,
    sourceAfterObservationReceiptHash: input.target.afterObservationReceiptHash,
    courseLocatorHash: input.courseLocatorHash,
    targetLocatorHash: input.targetLocatorHash,
    targetVersionHash: fresh.receipt.targetVersionHash,
    eventSetHash: fresh.receipt.eventSetHash,
    freshObservationRef,
    freshObservationHash: fresh.receiptHash,
    resolvedAt,
    readOnly: true,
    externalWriteAttempted: false,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  });
  const receiptHash = hashCourseToolValue(receipt.schemaVersion, receipt);
  return Object.freeze({
    receipt,
    receiptRef: `resolved-target:${receiptHash}`,
    receiptHash
  });
}

function dedupeRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const values = new Map<string, EvidenceRef>();
  for (const ref of refs) {
    values.set(`${ref.kind}\0${ref.id}\0${ref.hash}`, Object.freeze({ ...ref }));
  }
  return Object.freeze([...values.values()]);
}

function manifestRef(context: Readonly<ServerToolExecutionContext>): EvidenceRef {
  const hash = context.courseScope.manifestHash;
  if (!hash || !isSha256(hash)) throw new Error("WORKBENCH_STAGE_MANIFEST_REQUIRED");
  return Object.freeze({
    kind: "manifest",
    id: context.courseScope.alias,
    hash,
    observedAt: context.now
  });
}

function canonicalEnvelopeMatches(
  context: Readonly<ServerToolExecutionContext>,
  envelope: Readonly<ToolExecutionEnvelope>,
  expectedToolName:
    | "platform.editor.stage_verify_clear"
    | "platform.editor.reconcile_stage"
): boolean {
  return (
    envelope.toolName === expectedToolName &&
    envelope.toolVersion === "1" &&
    envelope.callId === context.callId &&
    envelope.taskId === context.taskId &&
    envelope.runId === context.runId &&
    envelope.planRevisionId === context.planRevisionId &&
    envelope.stepId === context.stepId &&
    envelope.policyVersion === context.policyVersion &&
    envelope.courseScope.alias === context.courseScope.alias &&
    envelope.courseScope.courseId === context.courseScope.courseId &&
    envelope.courseScope.manifestHash === context.courseScope.manifestHash &&
    envelope.courseScopeHash === hashCourseScope(context.courseScope)
  );
}

function canonicalMaterialMatches(
  material: CourseAgentStageMaterialBinding,
  manifestHash: string
): boolean {
  const integrityHash = material.integrityVerificationRef.startsWith(
    "integrity-verification:"
  )
    ? material.integrityVerificationRef.slice("integrity-verification:".length)
    : null;
  return (
    isSafeIdentifier(material.integrityVerificationRef) &&
    isSha256(integrityHash) &&
    material.target.evidenceRefs.some(
      (ref) =>
        ref.kind === "verification" &&
        ref.id === material.integrityVerificationRef &&
        ref.hash === integrityHash
    ) &&
    material.target.evidenceRefs.some(
      (ref) => ref.kind === "manifest" && ref.hash === manifestHash
    )
  );
}

function reconcileBindingMatches(
  transaction: SafeStageTransactionRecord,
  context: Readonly<ServerToolExecutionContext>,
  envelope: Readonly<ToolExecutionEnvelope>
): boolean {
  const manifestHash = context.courseScope.manifestHash;
  return (
    canonicalEnvelopeMatches(
      context,
      envelope,
      "platform.editor.reconcile_stage"
    ) &&
    isSha256(manifestHash) &&
    transaction.taskId === context.taskId &&
    transaction.runId === context.runId &&
    transaction.planRevisionId === context.planRevisionId &&
    transaction.stepId === context.stepId &&
    transaction.courseAlias === context.courseScope.alias &&
    transaction.courseScopeHash === envelope.courseScopeHash &&
    transaction.manifestHash === manifestHash &&
    transaction.policyVersion === context.policyVersion
  );
}

function assertResolvedTarget(
  resolved: ResolvedWorkbenchStageTarget,
  material: CourseAgentStageTargetMaterial,
  context: Readonly<ServerToolExecutionContext>,
  trustedNow: Date,
  requireOriginalState: boolean
): void {
  if (!hasExactKeys(resolved, RESOLVED_TARGET_KEYS)) {
    throw new Error("WORKBENCH_STAGE_TARGET_BINDING_MISMATCH");
  }
  let url: URL;
  let origin: URL;
  try {
    url = new URL(resolved.targetUrl);
    origin = new URL(resolved.allowedOrigin);
    assertEvidenceRefs(resolved.evidenceRefs);
    if (
      resolved.evidenceRefs.some(
        (ref) =>
          !hasExactKeys(ref, ["kind", "id", "hash", "observedAt"])
      )
    ) {
      throw new Error("WORKBENCH_STAGE_TARGET_EVIDENCE_INVALID");
    }
  } catch {
    throw new Error("WORKBENCH_STAGE_TARGET_BINDING_MISMATCH");
  }
  const manifestHash = context.courseScope.manifestHash;
  if (!isSha256(manifestHash)) {
    throw new Error("WORKBENCH_STAGE_MANIFEST_REQUIRED");
  }
  let rebuilt: ReturnType<typeof buildResolvedWorkbenchStageTargetReceiptV2>;
  try {
    rebuilt = buildResolvedWorkbenchStageTargetReceiptV2({
      target: material,
      courseAlias: context.courseScope.alias,
      courseScopeHash: hashCourseScope(context.courseScope),
      manifestHash,
      courseLocatorHash: resolved.courseLocatorHash,
      targetLocatorHash: resolved.targetLocatorHash,
      freshObservation: resolved.freshObservation
    });
  } catch {
    throw new Error("WORKBENCH_STAGE_TARGET_BINDING_MISMATCH");
  }
  const resolvedAt = Date.parse(resolved.resolvedAt);
  const now = trustedNow.getTime();
  if (
    resolved.schemaVersion !== WORKBENCH_STAGE_TARGET_RESOLUTION_SCHEMA_VERSION ||
    !hasExactKeys(resolved.resolvedTargetReceipt, RESOLVED_TARGET_RECEIPT_KEYS) ||
    url.protocol !== "https:" ||
    url.origin !== origin.origin ||
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    url.username ||
    url.password ||
    resolved.courseLocatorHash !== manifestHash ||
    resolved.sourceRevalidationReceiptHash !== material.revalidationReceiptHash ||
    resolved.sourceAfterObservationReceiptHash !== material.afterObservationReceiptHash ||
    resolved.freshObservationRef !== rebuilt.receipt.freshObservationRef ||
    resolved.freshObservationHash !== rebuilt.receipt.freshObservationHash ||
    resolved.resolvedAt !== rebuilt.receipt.resolvedAt ||
    resolved.resolvedTargetReceiptRef !== rebuilt.receiptRef ||
    resolved.resolvedTargetReceiptHash !== rebuilt.receiptHash ||
    hashCourseToolValue(
      resolved.resolvedTargetReceipt.schemaVersion,
      resolved.resolvedTargetReceipt
    ) !== resolved.resolvedTargetReceiptHash ||
    resolved.readOnly !== true ||
    resolved.externalWriteAttempted !== false ||
    resolved.containsForumText !== false ||
    resolved.containsIdentity !== false ||
    resolved.containsSecrets !== false ||
    !isSha256(resolved.courseLocatorHash) ||
    !isSha256(resolved.targetLocatorHash) ||
    !isSha256(resolved.targetVersionHash) ||
    !isSha256(resolved.eventSetHash) ||
    !Number.isFinite(resolvedAt)
  ) {
    throw new Error("WORKBENCH_STAGE_TARGET_BINDING_MISMATCH");
  }
  if (
    (requireOriginalState &&
      (resolved.targetVersionHash !== material.targetVersionHash ||
        resolved.eventSetHash !== material.eventSetHash)) ||
    resolvedAt > now + MAX_RESOLVED_TARGET_FUTURE_SKEW_MS ||
    now - resolvedAt > MAX_RESOLVED_TARGET_AGE_MS
  ) {
    throw new Error("WORKBENCH_STAGE_TARGET_STALE");
  }
}

function targetResolutionFailureReason(
  error: unknown
): "target_stale" | "target_mismatch" | null {
  if (!(error instanceof Error)) return null;
  if (error.message === "WORKBENCH_STAGE_TARGET_STALE") return "target_stale";
  if (
    error.message === "WORKBENCH_STAGE_TARGET_BINDING_MISMATCH" ||
    error.message === "WORKBENCH_STAGE_TARGET_RECEIPT_INVALID"
  ) {
    return "target_mismatch";
  }
  return null;
}

function stageTransactionRef(input: {
  context: Readonly<ServerToolExecutionContext>;
  envelope: Readonly<ToolExecutionEnvelope>;
  integrityVerificationRef: string;
  targetRef: string;
  artifactVersionRef: string;
  draftBodyHash: string;
  preflightRef: string;
  preflightHash: string;
  resolvedTargetReceiptRef: string;
  resolvedTargetReceiptHash: string;
  freshObservationRef: string;
  freshObservationHash: string;
  eventSetHash: string;
  targetLocatorHash: string;
  resolvedAt: string;
}): string {
  return `stage-transaction:${hashCourseToolValue(
    "cmooc.workbench-stage-transaction-ref.v3",
    {
      taskId: input.context.taskId,
      runId: input.context.runId,
      planRevisionId: input.context.planRevisionId,
      stepId: input.context.stepId,
      callId: input.context.callId,
      courseAlias: input.context.courseScope.alias,
      courseScopeHash: input.envelope.courseScopeHash,
      manifestHash: input.context.courseScope.manifestHash ?? null,
      policyVersion: input.context.policyVersion,
      integrityVerificationRef: input.integrityVerificationRef,
      targetRef: input.targetRef,
      artifactVersionRef: input.artifactVersionRef,
      draftBodyHash: input.draftBodyHash,
      preflightRef: input.preflightRef,
      preflightHash: input.preflightHash,
      resolvedTargetReceiptRef: input.resolvedTargetReceiptRef,
      resolvedTargetReceiptHash: input.resolvedTargetReceiptHash,
      freshObservationRef: input.freshObservationRef,
      freshObservationHash: input.freshObservationHash,
      eventSetHash: input.eventSetHash,
      targetLocatorHash: input.targetLocatorHash,
      resolvedAt: input.resolvedAt
    }
  )}`;
}

function stageEvidence(input: {
  context: Readonly<ServerToolExecutionContext>;
  target: CourseAgentStageTargetMaterial;
  artifactVersionRef: string;
  draftBodyHash: string;
  receiptRef?: EvidenceRef;
}): readonly EvidenceRef[] {
  return dedupeRefs([
    manifestRef(input.context),
    ...input.target.evidenceRefs,
    {
      kind: "artifact",
      id: input.artifactVersionRef,
      hash: input.draftBodyHash,
      observedAt: input.context.now
    },
    ...(input.receiptRef ? [input.receiptRef] : [])
  ]);
}

function closeAuditPassed(audit: WorkbenchStageBrowserCloseAudit): boolean {
  return (
    audit.status === "passed" &&
    audit.sentMutationCount === 0 &&
    audit.publishAttempted === false &&
    audit.containsForumText === false
  );
}

export function createTrustedWorkbenchPlatformStageAdapter(input: {
  materialLedger: {
    resolveStageMaterial(args: {
      targetRef: string;
      artifactVersionRef?: string;
      now?: string;
    }):
      | Promise<CourseAgentStageMaterialBinding | null>
      | CourseAgentStageMaterialBinding
      | null;
  };
  protectedMaterialVault: CourseAgentProtectedMaterialVault;
  targetResolver: WorkbenchStageTargetResolver;
  browserSessionFactory: WorkbenchStageBrowserSessionFactory;
  nonceRegistry: StageRunNonceRegistry;
  transactionStore?: WorkbenchStageTransactionStore;
  signingSecret: Buffer | string;
  now?: () => Date;
}): TrustedPlatformStageAdapter {
  const clock = input.now ?? (() => new Date());
  const transactions = input.transactionStore ?? new InMemoryWorkbenchStageTransactionStore();
  const preflights = new Map<string, PreflightRecord>();

  const resolveTarget = async (
    material: CourseAgentStageMaterialBinding,
    context: Readonly<ServerToolExecutionContext>,
    mode: "stage" | "reconcile" = "stage"
  ): Promise<ResolvedWorkbenchStageTarget> => {
    const manifestHash = context.courseScope.manifestHash;
    if (!manifestHash) throw new Error("WORKBENCH_STAGE_MANIFEST_REQUIRED");
    const resolved = await input.targetResolver.resolve({
      target: material.target,
      courseAlias: context.courseScope.alias,
      courseScopeHash: hashCourseScope(context.courseScope),
      manifestHash,
      requestedAt: clock().toISOString()
    });
    if (!resolved) throw new Error("WORKBENCH_STAGE_TARGET_UNAVAILABLE");
    assertResolvedTarget(
      resolved,
      material.target,
      context,
      clock(),
      mode === "stage"
    );
    return resolved;
  };

  const adapter: TrustedPlatformStageAdapter = {
    preflightRead: async ({ targetRef, context }) => {
      const material = await input.materialLedger.resolveStageMaterial({
        targetRef,
        now: context.now
      });
      if (!material) {
        return Object.freeze({
          schemaVersion: PLATFORM_PREFLIGHT_OUTPUT_SCHEMA_VERSION,
          status: "blocked",
          reasonCode: "target_mismatch",
          preflightRef: `preflight-blocked-${hashCourseToolValue("cmooc.workbench-stage-preflight-blocked.v1", { targetRef, taskId: context.taskId, runId: context.runId }).slice(0, 32)}`,
          preflightHash: hashCourseToolValue("cmooc.workbench-stage-preflight-blocked-hash.v1", { targetRef, taskId: context.taskId, runId: context.runId }),
          targetRef,
          targetVersionHash: null,
          baselineRef: null,
          baselineHash: null,
          pageBindingRef: null,
          pageBindingHash: null,
          baselineStatus: "unknown",
          observedAt: context.now,
          evidenceRefs: [manifestRef(context)],
          containsForumText: false,
          containsIdentity: false,
          containsSecrets: false
        });
      }
      let session: WorkbenchStageBrowserSession | null = null;
      try {
        const target = await resolveTarget(material, context);
        session = await input.browserSessionFactory.open({
          target,
          targetRef,
          courseAlias: context.courseScope.alias,
          observedAt: context.now
        });
        const baseline = await session.inspectBaseline();
        const pageBindingRef = session.pageBindingRef;
        const pageBindingHash = session.pageBindingHash;
        const audit = await session.close();
        session = null;
        if (!closeAuditPassed(audit)) throw new Error("WORKBENCH_STAGE_CLOSE_AUDIT_FAILED");
        const baselineHash = hashCourseToolValue("cmooc.workbench-stage-empty-baseline.v1", {
          targetRef,
          targetVersionHash: target.targetVersionHash,
          pageBindingHash,
          empty: baseline.editorEmpty
        });
        const baselineRef = `editor-baseline:${baselineHash}`;
        const preflightHash = hashCourseToolValue("cmooc.workbench-stage-preflight.v2", {
          taskId: context.taskId,
          runId: context.runId,
          targetRef,
          targetVersionHash: target.targetVersionHash,
          eventSetHash: target.eventSetHash,
          targetLocatorHash: target.targetLocatorHash,
          freshObservationHash: target.freshObservationHash,
          resolvedTargetReceiptHash: target.resolvedTargetReceiptHash,
          resolvedAt: target.resolvedAt,
          baselineHash,
          pageBindingHash,
          baselineStatus: baseline.editorEmpty ? "empty" : "non_empty",
          observedAt: context.now
        });
        const preflightRef = `preflight:${preflightHash}`;
        if (baseline.pageReady && baseline.editorVisible && baseline.editorEmpty) {
          preflights.set(
            preflightRef,
            Object.freeze({
              taskId: context.taskId,
              runId: context.runId,
              targetRef,
              targetVersionHash: target.targetVersionHash,
              eventSetHash: target.eventSetHash,
              targetLocatorHash: target.targetLocatorHash,
              freshObservationRef: target.freshObservationRef,
              freshObservationHash: target.freshObservationHash,
              resolvedTargetReceiptRef: target.resolvedTargetReceiptRef,
              resolvedTargetReceiptHash: target.resolvedTargetReceiptHash,
              resolvedAt: target.resolvedAt,
              preflightRef,
              preflightHash,
              baselineRef,
              baselineHash,
              pageBindingRef,
              pageBindingHash,
              observedAt: context.now
            })
          );
        }
        return Object.freeze({
          schemaVersion: PLATFORM_PREFLIGHT_OUTPUT_SCHEMA_VERSION,
          status:
            baseline.pageReady && baseline.editorVisible && baseline.editorEmpty
              ? "ready"
              : "blocked",
          reasonCode:
            baseline.pageReady && baseline.editorVisible && baseline.editorEmpty
              ? null
              : baseline.editorVisible
                ? "editor_not_empty"
                : "baseline_unavailable",
          preflightRef,
          preflightHash,
          targetRef,
          targetVersionHash: target.targetVersionHash,
          baselineRef,
          baselineHash,
          pageBindingRef,
          pageBindingHash,
          baselineStatus: baseline.editorEmpty ? "empty" : "non_empty",
          observedAt: context.now,
          evidenceRefs: dedupeRefs([
            manifestRef(context),
            ...material.target.evidenceRefs,
            ...target.evidenceRefs,
            {
              kind: "verification",
              id: target.freshObservationRef,
              hash: target.freshObservationHash,
              observedAt: target.resolvedAt
            },
            {
              kind: "verification",
              id: target.resolvedTargetReceiptRef,
              hash: target.resolvedTargetReceiptHash,
              observedAt: target.resolvedAt
            }
          ]),
          containsForumText: false,
          containsIdentity: false,
          containsSecrets: false
        } satisfies TrustedPlatformTargetPreflightMaterial);
      } catch (error) {
        if (session) await session.close().catch(() => undefined);
        const targetFailure = targetResolutionFailureReason(error);
        const fallbackHash = hashCourseToolValue("cmooc.workbench-stage-preflight-unavailable.v1", {
          taskId: context.taskId,
          runId: context.runId,
          targetRef,
          observedAt: context.now
        });
        return Object.freeze({
          schemaVersion: PLATFORM_PREFLIGHT_OUTPUT_SCHEMA_VERSION,
          status: targetFailure ? "blocked" : "waiting_for_browser",
          reasonCode: targetFailure ?? "browser_unavailable",
          preflightRef: `preflight-unavailable:${fallbackHash}`,
          preflightHash: fallbackHash,
          targetRef,
          targetVersionHash: null,
          baselineRef: null,
          baselineHash: null,
          pageBindingRef: null,
          pageBindingHash: null,
          baselineStatus: "unknown",
          observedAt: context.now,
          evidenceRefs: [manifestRef(context)],
          containsForumText: false,
          containsIdentity: false,
          containsSecrets: false
        });
      }
    },

    stageVerifyClear: async ({
      targetRef,
      artifactVersionRef,
      draftBodyHash,
      preflightRef,
      context,
      envelope
    }) => {
      const material = await input.materialLedger.resolveStageMaterial({
        targetRef,
        artifactVersionRef,
        now: context.now
      });
      const preflight = preflights.get(preflightRef);
      const manifestHash = context.courseScope.manifestHash;
      if (
        !material ||
        !isSha256(manifestHash) ||
        !canonicalEnvelopeMatches(
          context,
          envelope,
          "platform.editor.stage_verify_clear"
        ) ||
        !canonicalMaterialMatches(material, manifestHash) ||
        material.draftBodyHash !== draftBodyHash ||
        !preflight ||
        preflight.taskId !== context.taskId ||
        preflight.runId !== context.runId ||
        preflight.targetRef !== targetRef ||
        Date.parse(context.now) - Date.parse(preflight.observedAt) > MAX_PREFLIGHT_AGE_MS
      ) {
        return Object.freeze({
          status: "failed_before_write",
          reasonCode:
            material &&
            isSha256(manifestHash) &&
            canonicalEnvelopeMatches(
              context,
              envelope,
              "platform.editor.stage_verify_clear"
            ) &&
            canonicalMaterialMatches(material, manifestHash)
              ? "preflight_stale"
              : "grant_binding_invalid",
          evidenceRefs: stageEvidence({ context, target: material?.target ?? ({ evidenceRefs: [] } as unknown as CourseAgentStageTargetMaterial), artifactVersionRef, draftBodyHash }),
          observedAt: context.now
        });
      }
      const protectedDraft = await input.protectedMaterialVault.resolve({
        taskId: context.taskId,
        runId: context.runId,
        artifactVersionRef,
        expectedDraftBodyHash: draftBodyHash,
        now: context.now
      });
      if (!protectedDraft) {
        return Object.freeze({
          status: "failed_before_write",
          reasonCode: "artifact_unavailable",
          evidenceRefs: stageEvidence({ context, target: material.target, artifactVersionRef, draftBodyHash }),
          observedAt: context.now
        });
      }
      let transactionRef: string | null = null;
      let session: WorkbenchStageBrowserSession | null = null;
      let pendingCreated = false;
      try {
        const target = await resolveTarget(material, context);
        if (
          target.targetVersionHash !== preflight.targetVersionHash ||
          target.eventSetHash !== preflight.eventSetHash ||
          target.targetLocatorHash !== preflight.targetLocatorHash ||
          Date.parse(target.resolvedAt) < Date.parse(preflight.resolvedAt)
        ) {
          return Object.freeze({
            status: "failed_before_write",
            reasonCode: "target_stale",
            evidenceRefs: stageEvidence({ context, target: material.target, artifactVersionRef, draftBodyHash }),
            observedAt: context.now
          });
        }
        transactionRef = stageTransactionRef({
          context,
          envelope,
          integrityVerificationRef: material.integrityVerificationRef,
          targetRef,
          artifactVersionRef,
          draftBodyHash,
          preflightRef: preflight.preflightRef,
          preflightHash: preflight.preflightHash,
          resolvedTargetReceiptRef: target.resolvedTargetReceiptRef,
          resolvedTargetReceiptHash: target.resolvedTargetReceiptHash,
          freshObservationRef: target.freshObservationRef,
          freshObservationHash: target.freshObservationHash,
          eventSetHash: target.eventSetHash,
          targetLocatorHash: target.targetLocatorHash,
          resolvedAt: target.resolvedAt
        });
        session = await input.browserSessionFactory.open({
          target,
          targetRef,
          courseAlias: context.courseScope.alias,
          observedAt: context.now
        });
        const baseline = await session.inspectBaseline();
        if (!baseline.pageReady || !baseline.editorVisible || !baseline.editorEmpty) {
          await session.close().catch(() => undefined);
          session = null;
          return Object.freeze({
            status: "failed_before_write",
            reasonCode: baseline.editorVisible ? "editor_not_empty" : "page_binding_mismatch",
            evidenceRefs: stageEvidence({ context, target: material.target, artifactVersionRef, draftBodyHash }),
            observedAt: context.now
          });
        }
        const token = issueStageCompanionTokenV3({
          courseAlias: context.courseScope.alias,
          allowedOrigin: target.allowedOrigin,
          courseLocatorHash: target.courseLocatorHash,
          pageIdentityHash: session.expectedPage.pageIdentityHash,
          driverSessionKey: session.expectedPage.driverSessionKey,
          opportunityReceiptHash: material.target.opportunityReceiptHash,
          sourceRevalidationReceiptHash:
            target.sourceRevalidationReceiptHash,
          sourceAfterObservationReceiptHash:
            target.sourceAfterObservationReceiptHash,
          freshObservationHash: target.freshObservationHash,
          eventSetHash: target.eventSetHash,
          targetLocatorHash: target.targetLocatorHash,
          resolvedTargetReceiptHash: target.resolvedTargetReceiptHash,
          resolvedAt: target.resolvedAt,
          guardReceiptHash: session.guardReceiptHash,
          targetVersionHash: target.targetVersionHash,
          draftContentHash: draftBodyHash,
          signingSecret: input.signingSecret,
          now: clock(),
          expiresInSeconds: 90
        });
        const transactionCreatedAt = clock().toISOString();
        await transactions.createPending(
          Object.freeze({
            schemaVersion: WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION,
            stageTransactionRef: transactionRef,
            taskId: context.taskId,
            runId: context.runId,
            planRevisionId: context.planRevisionId,
            stepId: context.stepId,
            callId: context.callId,
            courseAlias: context.courseScope.alias,
            courseScopeHash: envelope.courseScopeHash,
            manifestHash,
            policyVersion: context.policyVersion,
            integrityVerificationRef: material.integrityVerificationRef,
            target: material.target,
            artifactVersionRef,
            draftBodyHash,
            runNonceHash: token.grant.runNonceHash,
            baselineRef: preflight.baselineRef,
            baselineHash: preflight.baselineHash,
            pageBindingRef: preflight.pageBindingRef,
            pageBindingHash: preflight.pageBindingHash,
            preflightRef: preflight.preflightRef,
            preflightHash: preflight.preflightHash,
            resolvedTargetReceiptRef: target.resolvedTargetReceiptRef,
            resolvedTargetReceiptHash: target.resolvedTargetReceiptHash,
            freshObservationRef: target.freshObservationRef,
            freshObservationHash: target.freshObservationHash,
            eventSetHash: target.eventSetHash,
            targetLocatorHash: target.targetLocatorHash,
            resolvedAt: target.resolvedAt,
            status: "pending",
            verifiedOutput: null,
            terminalBinding: null,
            createdAt: transactionCreatedAt,
            updatedAt: transactionCreatedAt
          })
        );
        pendingCreated = true;
        const executed = await executeStageCompanionRun({
          token,
          signingSecret: input.signingSecret,
          nonceRegistry: input.nonceRegistry,
          driver: session.driver,
          transientDraft: protectedDraft.body,
          now: clock
        });
        const stagePageBindingRef = session.pageBindingRef;
        const stagePageBindingHash = session.pageBindingHash;
        const audit = await session.close();
        session = null;
        if (!closeAuditPassed(audit)) throw new Error("WORKBENCH_STAGE_CLOSE_AUDIT_FAILED");
        const receiptRef: EvidenceRef = Object.freeze({
          kind: "stage_receipt",
          id: `stage-receipt:${executed.receiptHash}`,
          hash: executed.receiptHash,
          observedAt: executed.receipt.observedAt
        });
        const output: PlatformStageVerifiedOutput = Object.freeze({
          schemaVersion: PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION,
          status: "verified_cleared",
          stageTransactionRef: transactionRef,
          receiptRef: receiptRef.id,
          receiptHash: receiptRef.hash,
          targetRef,
          targetVersionHash: target.targetVersionHash,
          artifactVersionRef,
          draftBodyHash,
          pageBindingRef: stagePageBindingRef,
          pageBindingHash: stagePageBindingHash,
          baselineRef: preflight.baselineRef,
          baselineHash: preflight.baselineHash,
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
          observedAt: executed.receipt.observedAt,
          evidenceRefs: stageEvidence({
            context,
            target: material.target,
            artifactVersionRef,
            draftBodyHash,
            receiptRef
          }) as PlatformStageVerifiedOutput["evidenceRefs"],
          containsForumText: false,
          containsIdentity: false,
          containsSecrets: false
        });
        const terminalBinding: StageTransactionStageTerminalBindingV3 =
          Object.freeze({
            schemaVersion:
              WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_SCHEMA_VERSION,
            kind: "stage",
            receiptRef: output.receiptRef,
            receiptHash: output.receiptHash,
            resolvedTargetReceiptRef: target.resolvedTargetReceiptRef,
            resolvedTargetReceiptHash: target.resolvedTargetReceiptHash,
            freshObservationRef: target.freshObservationRef,
            freshObservationHash: target.freshObservationHash,
            eventSetHash: target.eventSetHash,
            targetLocatorHash: target.targetLocatorHash,
            resolvedAt: target.resolvedAt,
            containsForumText: false,
            containsIdentity: false,
            containsSecrets: false
          });
        await transactions.markVerified(
          transactionRef,
          output,
          output.observedAt,
          terminalBinding
        );
        preflights.delete(preflightRef);
        return output as TrustedPlatformStageOutcome;
      } catch (error) {
        if (session) await session.close().catch(() => undefined);
        if (pendingCreated && transactionRef) {
          await transactions.markUnknown(transactionRef, clock().toISOString()).catch(() => undefined);
          return Object.freeze({
            status: "unknown",
            reasonCode: "transaction_state_unknown",
            stageTransactionRef: transactionRef,
            evidenceRefs: stageEvidence({ context, target: material.target, artifactVersionRef, draftBodyHash }),
            observedAt: clock().toISOString()
          });
        }
        const targetFailure = targetResolutionFailureReason(error);
        return Object.freeze({
          status: "failed_before_write",
          reasonCode: targetFailure ?? "page_binding_mismatch",
          evidenceRefs: stageEvidence({ context, target: material.target, artifactVersionRef, draftBodyHash }),
          observedAt: clock().toISOString()
        });
      }
    },

    reconcileStage: async ({
      stageTransactionRef: transactionRef,
      context,
      envelope
    }) => {
      const transaction = await transactions.get(transactionRef);
      if (!transaction) {
        return Object.freeze({
          status: "blocked",
          reasonCode: "transaction_not_found",
          stageTransactionRef: transactionRef,
          evidenceRefs: [manifestRef(context)],
          observedAt: context.now
        });
      }
      if (!reconcileBindingMatches(transaction, context, envelope)) {
        return Object.freeze({
          status: "blocked",
          reasonCode: "transaction_binding_mismatch",
          stageTransactionRef: transactionRef,
          evidenceRefs: [manifestRef(context)],
          observedAt: context.now
        });
      }
      if (transaction.verifiedOutput) {
        const prior = transaction.verifiedOutput;
        return Object.freeze({
          ...prior,
          schemaVersion: PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
          status: "reconciled_cleared",
          resolution: "already_verified"
        });
      }
      if (transaction.schemaVersion !== WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION) {
        return Object.freeze({
          status: "blocked",
          reasonCode: "transaction_binding_mismatch",
          stageTransactionRef: transactionRef,
          evidenceRefs: [manifestRef(context)],
          observedAt: context.now
        });
      }
      const material = await input.materialLedger.resolveStageMaterial({
        targetRef: transaction.target.targetRef,
        artifactVersionRef: transaction.artifactVersionRef,
        now: context.now
      });
      if (
        !material ||
        material.draftBodyHash !== transaction.draftBodyHash ||
        material.integrityVerificationRef !==
          transaction.integrityVerificationRef ||
        !canonicalMaterialMatches(material, transaction.manifestHash)
      ) {
        return Object.freeze({
          status: "blocked",
          reasonCode: "transaction_binding_mismatch",
          stageTransactionRef: transactionRef,
          evidenceRefs: [manifestRef(context)],
          observedAt: context.now
        });
      }
      const protectedDraft = await input.protectedMaterialVault.resolve({
        taskId: context.taskId,
        runId: context.runId,
        artifactVersionRef: transaction.artifactVersionRef,
        expectedDraftBodyHash: transaction.draftBodyHash,
        now: context.now
      });
      if (!protectedDraft) {
        return Object.freeze({
          status: "blocked",
          reasonCode: "transaction_not_found",
          stageTransactionRef: transactionRef,
          evidenceRefs: stageEvidence({ context, target: transaction.target, artifactVersionRef: transaction.artifactVersionRef, draftBodyHash: transaction.draftBodyHash }),
          observedAt: context.now
        });
      }
      let session: WorkbenchStageBrowserSession | null = null;
      let reconcileAttempted = false;
      try {
        const target = await resolveTarget(material, context, "reconcile");
        if (
          target.targetLocatorHash !== transaction.targetLocatorHash ||
          Date.parse(target.resolvedAt) < Date.parse(transaction.resolvedAt)
        ) {
          return Object.freeze({
            status: "blocked",
            reasonCode: "transaction_binding_mismatch",
            stageTransactionRef: transactionRef,
            evidenceRefs: stageEvidence({
              context,
              target: transaction.target,
              artifactVersionRef: transaction.artifactVersionRef,
              draftBodyHash: transaction.draftBodyHash
            }),
            observedAt: context.now
          });
        }
        session = await input.browserSessionFactory.open({
          target,
          targetRef: transaction.target.targetRef,
          courseAlias: context.courseScope.alias,
          observedAt: context.now
        });
        reconcileAttempted = true;
        const reconciled = await session.reconcileOwned({
          runNonceHash: transaction.runNonceHash,
          transientDraft: protectedDraft.body
        });
        const audit = await session.close();
        session = null;
        if (!closeAuditPassed(audit)) throw new Error("WORKBENCH_STAGE_CLOSE_AUDIT_FAILED");
        if (reconciled.status !== "owned_draft_cleared") {
          return Object.freeze({
            status: "blocked",
            reasonCode:
              reconciled.status === "blocked_unowned_content" ||
              reconciled.status === "blocked_owned_content_mismatch"
                ? "blocked_unowned_content"
                : "blocked_stage_residue",
            stageTransactionRef: transactionRef,
            evidenceRefs: stageEvidence({ context, target: transaction.target, artifactVersionRef: transaction.artifactVersionRef, draftBodyHash: transaction.draftBodyHash }),
            observedAt: context.now
          });
        }
        const receiptHash = hashCourseToolValue(
          WORKBENCH_STAGE_RECONCILIATION_RECEIPT_SCHEMA_VERSION,
          {
            schemaVersion: WORKBENCH_STAGE_RECONCILIATION_RECEIPT_SCHEMA_VERSION,
            stageTransactionRef: transactionRef,
            runNonceHash: transaction.runNonceHash,
            originalResolvedTargetReceiptHash:
              transaction.resolvedTargetReceiptHash,
            reconcileResolvedTargetReceiptRef:
              target.resolvedTargetReceiptRef,
            reconcileResolvedTargetReceiptHash:
              target.resolvedTargetReceiptHash,
            reconcileFreshObservationRef: target.freshObservationRef,
            reconcileFreshObservationHash: target.freshObservationHash,
            reconcileEventSetHash: target.eventSetHash,
            reconcileTargetLocatorHash: target.targetLocatorHash,
            reconcileResolvedAt: target.resolvedAt,
            artifactVersionRef: transaction.artifactVersionRef,
            draftBodyHash: transaction.draftBodyHash,
            ownershipBinding: "run_nonce_and_draft_hash",
            ownedDraftMatched: true,
            editorReadbackVerified: reconciled.editorReadbackVerified,
            replayWriteCount: 0,
            editorClearCount: reconciled.editorClearCount,
            editorEmptyAfterClear: reconciled.editorEmptyAfterClear,
            publishAttempted: false,
            submitMutationCount: 0,
            sendMutationCount: 0,
            sentMutationCount: 0,
            realPublishEnabled: false,
            published: false,
            observedAt: context.now,
            containsForumText: false,
            containsIdentity: false,
            containsSecrets: false
          }
        );
        const receiptRef: EvidenceRef = Object.freeze({
          kind: "stage_receipt",
          id: `stage-reconciliation-receipt:${receiptHash}`,
          hash: receiptHash,
          observedAt: context.now
        });
        const output: PlatformStageReconciledOutput = Object.freeze({
          schemaVersion: PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
          status: "reconciled_cleared",
          resolution: "owned_draft_cleared",
          stageTransactionRef: transactionRef,
          receiptRef: receiptRef.id,
          receiptHash,
          targetRef: transaction.target.targetRef,
          targetVersionHash: transaction.target.targetVersionHash,
          artifactVersionRef: transaction.artifactVersionRef,
          draftBodyHash: transaction.draftBodyHash,
          pageBindingRef: transaction.pageBindingRef,
          pageBindingHash: transaction.pageBindingHash,
          baselineRef: transaction.baselineRef,
          baselineHash: transaction.baselineHash,
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
          observedAt: context.now,
          evidenceRefs: stageEvidence({
            context,
            target: transaction.target,
            artifactVersionRef: transaction.artifactVersionRef,
            draftBodyHash: transaction.draftBodyHash,
            receiptRef
          }) as PlatformStageReconciledOutput["evidenceRefs"],
          containsForumText: false,
          containsIdentity: false,
          containsSecrets: false
        });
        const terminalBinding: StageTransactionReconcileTerminalBindingV3 =
          Object.freeze({
            schemaVersion:
              WORKBENCH_STAGE_TRANSACTION_TERMINAL_BINDING_SCHEMA_VERSION,
            kind: "reconcile",
            receiptRef: output.receiptRef,
            receiptHash: output.receiptHash,
            originalResolvedTargetReceiptRef:
              transaction.resolvedTargetReceiptRef,
            originalResolvedTargetReceiptHash:
              transaction.resolvedTargetReceiptHash,
            reconcileResolvedTargetReceiptRef:
              target.resolvedTargetReceiptRef,
            reconcileResolvedTargetReceiptHash:
              target.resolvedTargetReceiptHash,
            reconcileFreshObservationRef: target.freshObservationRef,
            reconcileFreshObservationHash: target.freshObservationHash,
            reconcileEventSetHash: target.eventSetHash,
            reconcileTargetLocatorHash: target.targetLocatorHash,
            reconcileResolvedAt: target.resolvedAt,
            containsForumText: false,
            containsIdentity: false,
            containsSecrets: false
          });
        await transactions.markVerified(
          transactionRef,
          output,
          context.now,
          terminalBinding
        );
        return output;
      } catch (error) {
        if (session) await session.close().catch(() => undefined);
        if (!reconcileAttempted && targetResolutionFailureReason(error)) {
          return Object.freeze({
            status: "blocked",
            reasonCode: "transaction_binding_mismatch",
            stageTransactionRef: transactionRef,
            evidenceRefs: stageEvidence({
              context,
              target: transaction.target,
              artifactVersionRef: transaction.artifactVersionRef,
              draftBodyHash: transaction.draftBodyHash
            }),
            observedAt: clock().toISOString()
          });
        }
        await transactions.markUnknown(transactionRef, clock().toISOString()).catch(() => undefined);
        return Object.freeze({
          status: "unknown",
          reasonCode: "transaction_state_unknown",
          stageTransactionRef: transactionRef,
          evidenceRefs: stageEvidence({ context, target: transaction.target, artifactVersionRef: transaction.artifactVersionRef, draftBodyHash: transaction.draftBodyHash }),
          observedAt: clock().toISOString()
        });
      }
    }
  };
  return Object.freeze(adapter);
}

/**
 * Concrete Playwright/Quill session factory.  The caller supplies the path
 * provider; this module never discovers or logs credentials.  Opening occurs
 * only after the L3 policy gateway has admitted an exact action.
 */
export function createCmoocQuillWorkbenchStageSessionFactory(input: {
  storageStatePath: () => string | undefined;
  timeoutMs?: number;
}): WorkbenchStageBrowserSessionFactory {
  const factory: WorkbenchStageBrowserSessionFactory = {
    open: async ({ target, targetRef, courseAlias, observedAt }) => {
      const pageIdentityHash = hashCourseToolValue("cmooc.workbench-stage-page-identity.v1", {
        courseAlias,
        targetRef,
        targetVersionHash: target.targetVersionHash,
        targetLocatorHash: target.targetLocatorHash
      });
      const driverSessionKey = hashCourseToolValue("cmooc.workbench-stage-driver-session.v1", {
        pageIdentityHash,
        observedAt,
        nonce: randomBytes(32).toString("base64url")
      });
      const guardReceiptHash = hashCourseToolValue("cmooc.workbench-stage-browser-guard.v1", {
        pageIdentityHash,
        driverSessionKey,
        sentMutationCount: 0,
        realPublishEnabled: false
      });
      const pageBindingHash = hashCourseToolValue("cmooc.workbench-stage-page-binding.v2", {
        courseAlias,
        targetRef,
        targetVersionHash: target.targetVersionHash,
        eventSetHash: target.eventSetHash,
        targetLocatorHash: target.targetLocatorHash
      });
      const bridge = await openCmoocQuillStageBrowserBridge({
        targetUrl: target.targetUrl,
        allowedOrigin: target.allowedOrigin,
        storageStatePath: input.storageStatePath(),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
      });
      const expectedPage = Object.freeze({
        origin: target.allowedOrigin,
        courseAlias,
        courseLocatorHash: target.courseLocatorHash,
        pageIdentityHash,
        driverSessionKey,
        targetVersionHash: target.targetVersionHash,
        targetLocatorHash: target.targetLocatorHash,
        activeTab: true as const,
        pageReady: true as const,
        editorVisible: true as const,
        containsForumText: false as const
      });
      try {
        const driver = new CmoocQuillStageCompanionDriver({
          bridge,
          expectedPage,
          expectedTargetUrl: target.targetUrl,
          ...(input.timeoutMs === undefined ? {} : { operationTimeoutMs: input.timeoutMs })
        });
        let closed = false;
        const session: WorkbenchStageBrowserSession = {
          expectedPage,
          guardReceiptHash,
          pageBindingRef: `page-binding:${pageBindingHash}`,
          pageBindingHash,
          driver,
          inspectBaseline: () => driver.inspectBaseline(),
          reconcileOwned: (request) => driver.reconcileOwned(request),
          close: async () => {
            if (closed) {
              return Object.freeze({
                status: "passed",
                sentMutationCount: 0,
                publishAttempted: false,
                containsForumText: false
              });
            }
            closed = true;
            const audit: StageBrowserBridgeAudit = bridge.auditSnapshot();
            let status: "passed" | "unknown" =
              audit.sentMutationCount === 0 && audit.violationCodes.length === 0
                ? "passed"
                : "unknown";
            await bridge.close().catch(() => {
              status = "unknown";
            });
            return Object.freeze({
              status,
              sentMutationCount: 0,
              publishAttempted: false,
              containsForumText: false
            });
          }
        };
        return Object.freeze(session);
      } catch (error) {
        await bridge.close().catch(() => undefined);
        throw error;
      }
    }
  };
  return Object.freeze(factory);
}
