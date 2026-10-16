import { createHash } from "node:crypto";
import { parseProtocolObject } from "@/lib/facilitation-protocol";
import {
  hashCourseToolValue,
  isIsoInstant,
  isSafeIdentifier,
  isSha256,
  type CourseToolJsonValue,
  type EvidenceRef
} from "@/lib/course-tools/contracts";
import {
  FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION,
  FACILITATION_DRAFT_VERIFIER_CONTRACT,
  parseReplyDraftRecoveryMaterialV2,
  type FacilitationIntentComposeOutput,
  type ReplyDraftRecoverySourceV2
} from "@/lib/course-tools/tools/facilitation-artifacts";
import {
  OPPORTUNITY_INTEGRITY_VERIFIER_NAME,
  OPPORTUNITY_INTEGRITY_VERIFIER_VERSION,
  parseOpportunityVerificationToolOutput,
  type OpportunityVerificationToolOutput
} from "@/lib/course-tools/tools/register-evidence-tools";
import { COURSE_TOOL_POLICY_VERSION } from "@/lib/course-tools/policy-gateway";
import {
  COURSE_AGENT_VERIFIED_CHECKPOINT_SOURCE_SCHEMA_VERSION,
  loadVerifiedCourseAgentRecoveryDecisionMaterial,
  type CourseAgentVerifiedCheckpointSource
} from "@/lib/workbench/course-agent-artifact-runtime";
import {
  deriveVerifiedCourseAgentCheckpoint,
  type CourseAgentCheckpointState,
  type CourseAgentVerifiedCheckpoint
} from "@/lib/workbench/course-agent-checkpoint-read-model";
import {
  assertOpaqueId,
  assertSafeDurableValue,
  normalizeDate,
  type WorkbenchDb
} from "@/lib/workbench/durable-ledger";

export const COURSE_AGENT_RECOVERY_BUNDLE_SCHEMA_VERSION =
  "cmooc.course-agent.recovery-bundle.v1" as const;

export type CourseAgentRecoveryRuntimeOptions = Readonly<{
  verifiedCheckpointSource: CourseAgentVerifiedCheckpointSource;
}>;

export type VerifiedCourseAgentRecoveryBundle = Readonly<{
  checkpoint: CourseAgentVerifiedCheckpoint;
  source: CourseAgentVerifiedCheckpointSource;
  runtimeRecovery: CourseAgentRecoveryRuntimeOptions;
}>;

export type CourseAgentCheckpointHydratorDependencies = Readonly<{
  loadVerifiedDecisionMaterial?:
    typeof loadVerifiedCourseAgentRecoveryDecisionMaterial;
}>;

export class CourseAgentCheckpointHydratorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly checkpointState: CourseAgentCheckpointState | null = null,
    readonly checkpointReasonCode: string | null = null,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "CourseAgentCheckpointHydratorError";
  }
}

function fail(
  code: string,
  message: string,
  checkpoint?: CourseAgentVerifiedCheckpoint,
  cause?: unknown
): never {
  throw new CourseAgentCheckpointHydratorError(
    code,
    message,
    checkpoint?.state ?? null,
    checkpoint?.reasonCode ?? null,
    { cause }
  );
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: RecordValue, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

const FORBIDDEN_KEYS = new Set([
  "body",
  "draftbody",
  "forumbody",
  "postbody",
  "replybody",
  "rawcontent",
  "contenttext",
  "text",
  "html",
  "markdown",
  "protectedref",
  "url",
  "targeturl",
  "identity",
  "name",
  "fullname",
  "displayname",
  "username",
  "userid",
  "email",
  "phone",
  "cookie",
  "setcookie",
  "token",
  "accesstoken",
  "refreshtoken",
  "secret",
  "password",
  "credential",
  "authstate",
  "authorization",
  "sessionstate"
]);

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function assertPrivacyClosed(value: unknown, path = "$", depth = 0): void {
  if (depth > 16) fail("COURSE_AGENT_RECOVERY_PRIVACY_BOUNDARY", "Recovery material exceeds its bounded depth.");
  if (typeof value === "string") {
    if (
      /\b(?:https?|file):\/\//iu.test(value) ||
      /(?:^|[\s"'])(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|root)\/)/u.test(value) ||
      /\bBearer\s+/iu.test(value) ||
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(value)
    ) {
      fail("COURSE_AGENT_RECOVERY_PRIVACY_BOUNDARY", `Unsafe persisted recovery value at ${path}.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) fail("COURSE_AGENT_RECOVERY_PRIVACY_BOUNDARY", "Recovery material exceeds its bounded collection size.");
    value.forEach((item, index) => assertPrivacyClosed(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(normalizedKey(key))) {
      fail("COURSE_AGENT_RECOVERY_PRIVACY_BOUNDARY", `Forbidden persisted recovery field at ${path}.${key}.`);
    }
    assertPrivacyClosed(child, `${path}.${key}`, depth + 1);
  }
}

function parseRecord(value: string | null, code: string): RecordValue {
  if (value === null) fail(code, "Required safe persisted JSON is absent.");
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) fail(code, "Required safe persisted JSON is not an object.");
    assertPrivacyClosed(parsed);
    assertSafeDurableValue(parsed, code);
    return parsed;
  } catch (error) {
    if (error instanceof CourseAgentCheckpointHydratorError) throw error;
    fail(code, "Required safe persisted JSON is invalid.", undefined, error);
  }
}

function parseEvidenceRefs(value: string, code: string): readonly EvidenceRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    fail(code, "Persisted evidence references are invalid JSON.", undefined, error);
  }
  assertPrivacyClosed(parsed);
  if (!Array.isArray(parsed) || parsed.length > 256) {
    fail(code, "Persisted evidence references are invalid.");
  }
  const byKey = new Map<string, EvidenceRef>();
  for (const item of parsed) {
    if (
      !isRecord(item) ||
      !exactKeys(item, ["kind", "id", "hash", "observedAt"]) ||
      typeof item.kind !== "string" ||
      typeof item.id !== "string" ||
      !isSafeIdentifier(item.id) ||
      typeof item.hash !== "string" ||
      !isSha256(item.hash) ||
      typeof item.observedAt !== "string" ||
      !isIsoInstant(item.observedAt)
    ) {
      fail(code, "Persisted evidence reference is not closed and canonical.");
    }
    const ref: EvidenceRef = {
      kind: item.kind as EvidenceRef["kind"],
      id: item.id,
      hash: item.hash,
      observedAt: item.observedAt
    };
    byKey.set(`${ref.kind}\0${ref.id}\0${ref.hash}`, Object.freeze(ref));
  }
  return Object.freeze(
    [...byKey.values()].sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.id.localeCompare(right.id) ||
        left.hash.localeCompare(right.hash)
    )
  );
}

function artifactPointer(row: {
  id: string;
  artifactId: string;
  version: number;
  contentHash: string;
}) {
  return Object.freeze({
    artifactId: row.artifactId,
    versionId: row.id,
    artifactRef: `artifact:${row.artifactId}`,
    versionRef: `artifact-version:${row.id}`,
    version: row.version,
    contentHash: row.contentHash
  });
}

function expectedOutputHash(toolName: string, value: CourseToolJsonValue): string {
  return hashCourseToolValue(`output:${toolName}@1`, value);
}

function verificationEvidenceRef(row: {
  id: string;
  subjectType: string;
  subjectId: string;
  verifier: string;
  verifierVersion: string;
  status: string;
  checksJson: string;
  evidenceRefsJson: string;
  observedAt: Date;
  expiresAt: Date | null;
  containsForumText: boolean;
  containsIdentity: boolean;
}): EvidenceRef {
  const checks = JSON.parse(row.checksJson) as unknown;
  const evidenceRefs = JSON.parse(row.evidenceRefsJson) as unknown;
  assertPrivacyClosed(checks);
  assertPrivacyClosed(evidenceRefs);
  const hash = hashCourseToolValue(
    "cmooc.course-agent.durable-verification-evidence.v1",
    {
      id: row.id,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      verifier: row.verifier,
      verifierVersion: row.verifierVersion,
      status: row.status,
      checks: checks as CourseToolJsonValue,
      evidenceRefs: evidenceRefs as CourseToolJsonValue,
      observedAt: row.observedAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      containsForumText: row.containsForumText,
      containsIdentity: row.containsIdentity
    }
  );
  return Object.freeze({
    kind: "verification" as const,
    id: row.id,
    hash,
    observedAt: row.observedAt.toISOString()
  });
}

const COMPOSITION_VERIFICATION_CHECKS = Object.freeze([
  "verification.facilitation_intent.intent_movespec_hashes",
  "verification.facilitation_intent.artifact_content_hash",
  "verification.facilitation_intent.verified_evidence_binding",
  "verification.facilitation_intent.policy_domain_binding"
]);
const DRAFT_VERIFICATION_CHECKS = Object.freeze([
  "verification.facilitation_reply_draft.protected_body_hash",
  "verification.facilitation_reply_draft.restricted_transient_boundary",
  "verification.facilitation_reply_draft.privacy_claim_lint"
]);
const INTEGRITY_VERIFICATION_CHECKS = Object.freeze([
  `${OPPORTUNITY_INTEGRITY_VERIFIER_NAME}.server_scope_binding`,
  `${OPPORTUNITY_INTEGRITY_VERIFIER_NAME}.fresh_evidence_replay`,
  `${OPPORTUNITY_INTEGRITY_VERIFIER_NAME}.integrity_reference`,
  `${OPPORTUNITY_INTEGRITY_VERIFIER_NAME}.evidence_reference_binding`
]);

function assertPassedVerificationRow(
  row: {
    id: string;
    subjectType: string;
    subjectId: string;
    verifier: string;
    verifierVersion: string;
    status: string;
    checksJson: string;
    evidenceRefsJson: string;
    observedAt: Date;
    expiresAt: Date | null;
    containsForumText: boolean;
    containsIdentity: boolean;
  },
  input: {
    requiredCheckCodes: readonly string[];
    now: Date;
    allowExpired: boolean;
    checkpoint: CourseAgentVerifiedCheckpoint;
  }
): void {
  if (
    row.status !== "passed" ||
    row.verifier !== "verification.course_tool_registry" ||
    row.verifierVersion !== "1" ||
    row.containsForumText ||
    row.containsIdentity ||
    row.observedAt > input.now ||
    (!input.allowExpired && row.expiresAt !== null && row.expiresAt <= input.now)
  ) {
    fail(
      "COURSE_AGENT_RECOVERY_VERIFICATION_CONTRACT_GAP",
      "Verification row is stale, unsafe, or outside its accepted time policy.",
      input.checkpoint
    );
  }
  let checks: unknown;
  try {
    checks = JSON.parse(row.checksJson) as unknown;
  } catch (error) {
    fail(
      "COURSE_AGENT_RECOVERY_VERIFICATION_CONTRACT_GAP",
      "Verification checks are invalid JSON.",
      input.checkpoint,
      error
    );
  }
  assertPrivacyClosed(checks);
  if (
    !Array.isArray(checks) ||
    checks.length < 1 ||
    checks.some(
      (check) =>
        !isRecord(check) ||
        !exactKeys(check, ["code", "status", "safeSummary"]) ||
        check.status !== "passed" ||
        typeof check.code !== "string" ||
        typeof check.safeSummary !== "string"
    )
  ) {
    fail(
      "COURSE_AGENT_RECOVERY_VERIFICATION_CONTRACT_GAP",
      "Verification checks are not a closed all-passed projection.",
      input.checkpoint
    );
  }
  const codes = checks.map((check) => (check as RecordValue).code);
  if (
    new Set(codes).size !== codes.length ||
    input.requiredCheckCodes.some((code) => !codes.includes(code))
  ) {
    fail(
      "COURSE_AGENT_RECOVERY_VERIFICATION_CONTRACT_GAP",
      "Verification does not contain every required mechanical check.",
      input.checkpoint
    );
  }
  parseEvidenceRefs(
    row.evidenceRefsJson,
    "COURSE_AGENT_RECOVERY_VERIFICATION_CONTRACT_GAP"
  );
}

function safeArtifactId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export async function loadVerifiedCourseAgentRecoveryBundle(
  db: WorkbenchDb,
  input: Readonly<{
    taskId: string;
    sourceRunId: string;
  childRunId: string;
  courseAlias: string;
  expectedCheckpointRef?: string;
  now: Date | string;
  }>,
  dependencies: CourseAgentCheckpointHydratorDependencies = {}
): Promise<VerifiedCourseAgentRecoveryBundle> {
  const taskId = assertOpaqueId(input.taskId, "taskId");
  const sourceRunId = assertOpaqueId(input.sourceRunId, "sourceRunId");
  const childRunId = assertOpaqueId(input.childRunId, "childRunId");
  const courseAlias = assertOpaqueId(input.courseAlias, "courseAlias");
  const now = normalizeDate(input.now, "now");
  if (sourceRunId === childRunId) {
    fail("COURSE_AGENT_RECOVERY_CHILD_SCOPE_INVALID", "Recovery requires a distinct child run.");
  }
  // The restart route calls this loader before it creates the child row so an
  // unsupported checkpoint cannot leave an orphan run. Child scope is bound
  // here by the caller-supplied safe id and later rechecked by runtime hydration.
  const sourceRun = await db.workbenchRunRecord.findUnique({
    where: { id: sourceRunId },
    select: { taskId: true, status: true }
  });
  if (!sourceRun || sourceRun.taskId !== taskId || sourceRun.status !== "failed") {
    fail("COURSE_AGENT_RECOVERY_SOURCE_RUN_NOT_FAILED", "Recovery source must be the exact failed parent run.");
  }
  const checkpoint = await deriveVerifiedCourseAgentCheckpoint(db, {
    taskId,
    runId: sourceRunId,
    now
  });
  if (
    input.expectedCheckpointRef !== undefined &&
    input.expectedCheckpointRef !== checkpoint.checkpointRef
  ) {
    fail(
      "COURSE_AGENT_RECOVERY_CHECKPOINT_REF_MISMATCH",
      "Derived checkpoint does not match the caller-bound restart checkpoint.",
      checkpoint
    );
  }
  if (
    checkpoint.state !== "draft_regeneration_required" ||
    checkpoint.recoveryAction !== "regenerate_draft_and_reverify" ||
    !["protected_draft_expired", "fresh_stage_requires_regenerated_body"].includes(
      checkpoint.reasonCode
    )
  ) {
    fail(
      "COURSE_AGENT_RECOVERY_CHECKPOINT_UNSUPPORTED",
      "Only a body-free v2 draft-regeneration checkpoint is supported.",
      checkpoint
    );
  }
  if (
    checkpoint.toolPolicyVersion !== COURSE_TOOL_POLICY_VERSION ||
    checkpoint.compositionVersionRef === null ||
    checkpoint.draftVersionRef === null ||
    checkpoint.draftBodyHash === null ||
    checkpoint.integrityVerificationRef === null
  ) {
    fail("COURSE_AGENT_RECOVERY_CHECKPOINT_UNSUPPORTED", "Checkpoint lacks exact draft recovery bindings.", checkpoint);
  }

  const stageCount = await db.workbenchStageTransactionRecord.count({
    where: { taskId, runId: sourceRunId }
  });
  if (stageCount !== 0) {
    fail("COURSE_AGENT_RECOVERY_STAGE_PRESENT_UNSUPPORTED", "Draft regeneration cannot cross an existing STAGE transaction.", checkpoint);
  }

  const artifacts = await db.workbenchArtifactVersionRecord.findMany({
    where: { taskId, runId: sourceRunId },
    orderBy: { createdAt: "asc" }
  });
  const compositionRows = artifacts.filter(
    (row) => `artifact-version:${row.id}` === checkpoint.compositionVersionRef
  );
  const draftRows = artifacts.filter(
    (row) => `artifact-version:${row.id}` === checkpoint.draftVersionRef
  );
  if (compositionRows.length !== 1) {
    fail("COURSE_AGENT_RECOVERY_COMPOSITION_CONTRACT_GAP", "Exact composition artifact is unavailable or non-unique.", checkpoint);
  }
  if (draftRows.length !== 1) {
    fail("COURSE_AGENT_RECOVERY_DRAFT_CONTRACT_GAP", "Exact draft artifact is unavailable or non-unique.", checkpoint);
  }
  const compositionRow = compositionRows[0]!;
  const draftRow = draftRows[0]!;
  if (!compositionRow.createdByCallId || !draftRow.createdByCallId) {
    fail("COURSE_AGENT_RECOVERY_COMPOSITION_CONTRACT_GAP", "Artifact creator provenance is absent.", checkpoint);
  }

  const calls = await db.workbenchToolCallRecord.findMany({
    where: { taskId, runId: sourceRunId },
    include: { receipt: true },
    orderBy: { createdAt: "asc" }
  });
  const compositionCalls = calls.filter(
    (call) =>
      call.id === compositionRow.createdByCallId &&
      call.toolName === "facilitation.intent.compose" &&
      call.toolVersion === "1" &&
      call.status === "succeeded" &&
      call.receipt?.status === "succeeded"
  );
  const integrityCalls = calls.filter(
    (call) =>
      call.toolName === "evidence.verify_integrity" &&
      call.toolVersion === "1" &&
      call.status === "succeeded" &&
      call.receipt?.status === "succeeded"
  );
  const draftCalls = calls.filter(
    (call) =>
      call.id === draftRow.createdByCallId &&
      call.toolName === "artifact.reply_draft.create" &&
      call.toolVersion === "1" &&
      call.status === "succeeded" &&
      call.receipt?.status === "succeeded"
  );
  if (compositionCalls.length !== 1 || !compositionCalls[0]!.receipt) {
    fail("COURSE_AGENT_RECOVERY_COMPOSITION_CONTRACT_GAP", "Exact succeeded composition call and receipt are unavailable.", checkpoint);
  }
  if (integrityCalls.length !== 1 || !integrityCalls[0]!.receipt) {
    fail("COURSE_AGENT_RECOVERY_INTEGRITY_OUTPUT_MATERIAL_UNAVAILABLE", "Exact succeeded integrity call and receipt are unavailable.", checkpoint);
  }
  if (draftCalls.length !== 1 || !draftCalls[0]!.receipt) {
    fail("COURSE_AGENT_RECOVERY_DRAFT_CONTRACT_GAP", "Exact succeeded draft call and receipt are unavailable.", checkpoint);
  }
  const compositionCall = compositionCalls[0]!;
  const compositionReceipt = compositionCall.receipt!;
  const integrityCall = integrityCalls[0]!;
  const integrityReceipt = integrityCall.receipt!;
  const draftReceipt = draftCalls[0]!.receipt!;
  if (
    !compositionReceipt.verificationId ||
    !integrityReceipt.verificationId ||
    !draftReceipt.verificationId
  ) {
    fail("COURSE_AGENT_RECOVERY_VERIFICATION_CONTRACT_GAP", "Required verification receipt linkage is absent.", checkpoint);
  }

  const compositionMetadata = parseRecord(
    compositionRow.metadataJson,
    "COURSE_AGENT_RECOVERY_COMPOSITION_CONTRACT_GAP"
  );
  const compositionEvidence = parseEvidenceRefs(
    compositionRow.sourceRefsJson,
    "COURSE_AGENT_RECOVERY_COMPOSITION_CONTRACT_GAP"
  );
  const compositionPointer = artifactPointer(compositionRow);
  if (
    compositionRow.artifactKind !== "facilitation_intent" ||
    compositionRow.contentClass !== "safe_generated" ||
    compositionRow.draftBodyHash !== null ||
    compositionRow.regenerationRecipeJson !== null ||
    compositionMetadata.schemaVersion !== FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION ||
    compositionMetadata.containsForumText !== false ||
    compositionMetadata.containsIdentity !== false ||
    compositionMetadata.containsSecrets !== false ||
    typeof compositionMetadata.selectionRef !== "string" ||
    typeof compositionMetadata.selectionEvidenceBindingHash !== "string" ||
    typeof compositionMetadata.integrityVerificationRef !== "string" ||
    typeof compositionMetadata.evidenceBindingHash !== "string" ||
    typeof compositionMetadata.intentHash !== "string" ||
    typeof compositionMetadata.moveSpecHash !== "string" ||
    typeof compositionMetadata.receiptRef !== "string" ||
    typeof compositionMetadata.receiptHash !== "string" ||
    compositionMetadata.toolPolicyVersion !== COURSE_TOOL_POLICY_VERSION
  ) {
    fail("COURSE_AGENT_RECOVERY_COMPOSITION_CONTRACT_GAP", "Composition artifact does not expose a closed v2 output projection.", checkpoint);
  }
  let intent;
  let moveSpec;
  try {
    intent = parseProtocolObject("interventionIntent", compositionMetadata.intent);
    moveSpec = parseProtocolObject("facilitationMoveSpec", compositionMetadata.moveSpec);
  } catch (error) {
    fail("COURSE_AGENT_RECOVERY_COMPOSITION_CONTRACT_GAP", "Composition protocol objects are invalid.", checkpoint, error);
  }
  const compositionOutput: FacilitationIntentComposeOutput = Object.freeze({
    schemaVersion: "cmooc.course-tool.facilitation-intent-output.v2",
    status: "composed",
    compositionRef: compositionPointer.versionRef,
    intent,
    intentHash: compositionMetadata.intentHash,
    moveSpec,
    moveSpecHash: compositionMetadata.moveSpecHash,
    intentPolicyVersion: compositionMetadata.intentPolicyVersion as FacilitationIntentComposeOutput["intentPolicyVersion"],
    toolPolicyVersion: compositionMetadata.toolPolicyVersion,
    selectionEvidenceBindingHash: compositionMetadata.selectionEvidenceBindingHash,
    evidenceBindingHash: compositionMetadata.evidenceBindingHash,
    integrityVerificationRef: compositionMetadata.integrityVerificationRef,
    receiptRef: compositionMetadata.receiptRef,
    receiptHash: compositionMetadata.receiptHash,
    artifact: compositionPointer,
    evidenceRefs: compositionEvidence as FacilitationIntentComposeOutput["evidenceRefs"],
    observedAt: compositionReceipt.observedAt.toISOString(),
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  });
  if (
    expectedOutputHash(
      "facilitation.intent.compose",
      compositionOutput as unknown as CourseToolJsonValue
    ) !== compositionReceipt.outputHash
  ) {
    fail("COURSE_AGENT_RECOVERY_COMPOSITION_OUTPUT_MATERIAL_UNAVAILABLE", "Persisted composition fields cannot reproduce the exact tool output hash.", checkpoint);
  }

  const decisionRefs = compositionEvidence.filter((ref) => ref.kind === "decision");
  if (decisionRefs.length !== 1 || !decisionRefs[0]!.id.startsWith("decision:")) {
    fail("COURSE_AGENT_RECOVERY_DECISION_CONTRACT_GAP", "Composition evidence does not uniquely bind a decision.", checkpoint);
  }
  const decisionId = decisionRefs[0]!.id.slice("decision:".length);
  const snapshotRefs = compositionEvidence.filter((ref) => ref.kind === "snapshot");
  if (snapshotRefs.length !== 1) {
    fail("COURSE_AGENT_RECOVERY_INTEGRITY_OUTPUT_MATERIAL_UNAVAILABLE", "Integrity snapshot cannot be uniquely recovered.", checkpoint);
  }
  let decisionMaterial;
  try {
    decisionMaterial =
      await (
        dependencies.loadVerifiedDecisionMaterial ??
        loadVerifiedCourseAgentRecoveryDecisionMaterial
      )({
        db: db as Parameters<
          typeof loadVerifiedCourseAgentRecoveryDecisionMaterial
        >[0]["db"],
        courseAlias,
        snapshotId: snapshotRefs[0]!.id,
        decisionId,
        toolPolicyVersion: checkpoint.toolPolicyVersion,
        now
      });
  } catch (error) {
    fail(
      "COURSE_AGENT_RECOVERY_DECISION_CONTRACT_GAP",
      "Exact decision failed the ordinary evidence and decision replay contract.",
      checkpoint,
      error
    );
  }
  if (
    decisionMaterial.decisionId !== decisionId ||
    decisionMaterial.intentHash !== compositionOutput.intentHash ||
    decisionMaterial.moveSpecHash !== compositionOutput.moveSpecHash ||
    decisionMaterial.evidenceBindingHash !== compositionOutput.evidenceBindingHash ||
    decisionMaterial.opportunityReceiptHash !== decisionRefs[0]!.hash ||
    decisionMaterial.integrityVerificationRef !==
      checkpoint.integrityVerificationRef
  ) {
    fail(
      "COURSE_AGENT_RECOVERY_DECISION_CONTRACT_GAP",
      "Strict replayed decision conflicts with the durable composition.",
      checkpoint
    );
  }
  const candidateKey = decisionMaterial.candidateKey;
  const opportunityId = decisionMaterial.opportunityId;
  const rawIntegrityEvidence = parseEvidenceRefs(
    integrityReceipt.evidenceRefsJson,
    "COURSE_AGENT_RECOVERY_INTEGRITY_OUTPUT_MATERIAL_UNAVAILABLE"
  );
  const integrityOutput: OpportunityVerificationToolOutput = {
    schemaVersion: "cmooc.course-tool.opportunity-verification-output.v1",
    status: "eligible",
    contextRef: `snapshot:${snapshotRefs[0]!.id}`,
    snapshotRef: snapshotRefs[0]!.id,
    opportunityId,
    integrityVerificationRef: checkpoint.integrityVerificationRef,
    claim: "mature_support_gap",
    candidateSetCheck: "passed",
    targetProjectionCheck: "passed",
    targetPredicatesCheck: "passed",
    qualificationCheck: "passed",
    graphCheck: "not_required",
    policyCheck: "passed",
    limitationCode: "none",
    evidenceRefCount: rawIntegrityEvidence.length
  };
  try {
    parseOpportunityVerificationToolOutput(integrityOutput);
  } catch (error) {
    fail("COURSE_AGENT_RECOVERY_INTEGRITY_OUTPUT_MATERIAL_UNAVAILABLE", "Recovered integrity output fails its closed schema.", checkpoint, error);
  }
  if (
    expectedOutputHash(
      "evidence.verify_integrity",
      integrityOutput as unknown as CourseToolJsonValue
    ) !== integrityReceipt.outputHash
  ) {
    fail("COURSE_AGENT_RECOVERY_INTEGRITY_OUTPUT_MATERIAL_UNAVAILABLE", "Durable fields cannot reproduce the exact integrity tool output hash.", checkpoint);
  }

  const verificationRows = await db.workbenchVerificationRecord.findMany({
    where: { taskId, runId: sourceRunId }
  });
  const compositionVerifications = verificationRows.filter(
    (row) =>
      row.id === compositionReceipt.verificationId &&
      row.subjectType === "artifact_version" &&
      row.subjectId === compositionRow.id &&
      row.status === "passed" &&
      row.verifier === "verification.course_tool_registry" &&
      row.verifierVersion === "1" &&
      !row.containsForumText &&
      !row.containsIdentity
  );
  const integrityVerifications = verificationRows.filter(
    (row) =>
      row.id === integrityReceipt.verificationId &&
      row.subjectType === "tool_result" &&
      row.subjectId === checkpoint.integrityVerificationRef &&
      row.status === "passed" &&
      row.verifier === "verification.course_tool_registry" &&
      row.verifierVersion === "1" &&
      !row.containsForumText &&
      !row.containsIdentity
  );
  const draftVerifications = verificationRows.filter(
    (row) =>
      row.id === draftReceipt.verificationId &&
      row.subjectType === "artifact_version" &&
      row.subjectId === draftRow.id &&
      row.status === "passed" &&
      row.verifier === "verification.course_tool_registry" &&
      row.verifierVersion === "1" &&
      !row.containsForumText &&
      !row.containsIdentity
  );
  if (
    compositionVerifications.length !== 1 ||
    integrityVerifications.length !== 1 ||
    draftVerifications.length !== 1
  ) {
    fail("COURSE_AGENT_RECOVERY_VERIFICATION_CONTRACT_GAP", "Exact passed verifications are absent or non-unique.", checkpoint);
  }
  const compositionVerification = compositionVerifications[0]!;
  const integrityVerification = integrityVerifications[0]!;
  const draftVerification = draftVerifications[0]!;
  assertPassedVerificationRow(compositionVerification, {
    requiredCheckCodes: COMPOSITION_VERIFICATION_CHECKS,
    now,
    allowExpired: true,
    checkpoint
  });
  assertPassedVerificationRow(integrityVerification, {
    requiredCheckCodes: INTEGRITY_VERIFICATION_CHECKS,
    now,
    allowExpired: false,
    checkpoint
  });
  assertPassedVerificationRow(draftVerification, {
    requiredCheckCodes: DRAFT_VERIFICATION_CHECKS,
    now,
    allowExpired: true,
    checkpoint
  });

  const draftMetadata = parseRecord(
    draftRow.metadataJson,
    "COURSE_AGENT_RECOVERY_DRAFT_CONTRACT_GAP"
  );
  const draftRecipe = parseRecord(
    draftRow.regenerationRecipeJson,
    "COURSE_AGENT_RECOVERY_DRAFT_CONTRACT_GAP"
  );
  const draftEvidence = parseEvidenceRefs(
    draftRow.sourceRefsJson,
    "COURSE_AGENT_RECOVERY_DRAFT_CONTRACT_GAP"
  );
  if (
    draftRow.artifactKind !== "facilitation_reply_draft" ||
    draftRow.contentClass !== "restricted_transient" ||
    draftRow.contentRef !== null ||
    !draftRow.draftBodyHash ||
    !draftRow.expiresAt ||
    draftRow.draftBodyHash !== checkpoint.draftBodyHash ||
    draftRow.contentHash !== checkpoint.draftContentHash
  ) {
    fail("COURSE_AGENT_RECOVERY_DRAFT_CONTRACT_GAP", "Draft row violates the restricted body-free recovery contract.", checkpoint);
  }
  const verifiedDraft = parseReplyDraftRecoveryMaterialV2({
    metadata: draftMetadata,
    regenerationRecipe: draftRecipe,
    artifact: {
      versionRef: `artifact-version:${draftRow.id}`,
      contentHash: draftRow.contentHash,
      draftBodyHash: draftRow.draftBodyHash,
      expiresAt: draftRow.expiresAt.toISOString()
    },
    composition: {
      versionRef: compositionOutput.compositionRef,
      intentHash: compositionOutput.intentHash,
      moveSpecHash: compositionOutput.moveSpecHash,
      toolPolicyVersion: compositionOutput.toolPolicyVersion
    }
  });
  if (
    !verifiedDraft ||
    verifiedDraft.revisionKind !== "initial" ||
    verifiedDraft.priorVersionRef !== null ||
    verifiedDraft.feedbackRef !== null ||
    Date.parse(verifiedDraft.intent.candidateExpiresAt) <= now.getTime()
  ) {
    fail("COURSE_AGENT_RECOVERY_DRAFT_CONTRACT_GAP", "Only current initial v2 draft material is recoverable.", checkpoint);
  }
  const logicalDraftKey = `support-gap-draft:${decisionId}`;
  const artifactKey = `facilitation_reply_draft:${hashCourseToolValue(
    "facilitation-artifact-key.v1",
    { taskId, logicalKey: logicalDraftKey }
  )}`;
  if (draftRow.artifactId !== safeArtifactId("course-artifact", artifactKey)) {
    fail("COURSE_AGENT_RECOVERY_DRAFT_CONTRACT_GAP", "Draft logical artifact lineage cannot be mechanically reproduced.", checkpoint);
  }

  const draftVerificationEvidence = verificationEvidenceRef(draftVerification);
  const draftRecovery: ReplyDraftRecoverySourceV2 = Object.freeze({
    metadata: draftMetadata as CourseToolJsonValue,
    regenerationRecipe: draftRecipe as CourseToolJsonValue,
    artifact: Object.freeze({
      ...artifactPointer(draftRow),
      contentClass: "restricted_transient" as const,
      draftBodyHash: draftRow.draftBodyHash,
      expiresAt: draftRow.expiresAt.toISOString(),
      observedAt: draftRow.createdAt.toISOString(),
      bodyPersisted: false as const
    }),
    composition: Object.freeze({
      versionRef: compositionOutput.compositionRef,
      intentHash: compositionOutput.intentHash,
      moveSpecHash: compositionOutput.moveSpecHash,
      toolPolicyVersion: compositionOutput.toolPolicyVersion
    }),
    logicalDraftKey,
    evidenceRefs: draftEvidence,
    sourceVerification: Object.freeze({
      subjectVersionRef: `artifact-version:${draftRow.id}`,
      verifier: FACILITATION_DRAFT_VERIFIER_CONTRACT,
      status: "passed" as const,
      evidenceRef: draftVerificationEvidence
    }),
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  });

  const integrityHash = checkpoint.integrityVerificationRef.slice(
    "integrity-verification:".length
  );
  if (!isSha256(integrityHash)) {
    fail("COURSE_AGENT_RECOVERY_INTEGRITY_OUTPUT_MATERIAL_UNAVAILABLE", "Integrity reference is not canonical.", checkpoint);
  }
  const integrityEvidence = Object.freeze([
    ...rawIntegrityEvidence,
    Object.freeze({
      kind: "world" as const,
      id: `world:${snapshotRefs[0]!.id}`,
      hash: snapshotRefs[0]!.hash,
      observedAt: snapshotRefs[0]!.observedAt
    }),
    Object.freeze({
      kind: "verification" as const,
      id: checkpoint.integrityVerificationRef,
      hash: integrityHash,
      observedAt: snapshotRefs[0]!.observedAt
    })
  ]);
  const source: CourseAgentVerifiedCheckpointSource = Object.freeze({
    schemaVersion: COURSE_AGENT_VERIFIED_CHECKPOINT_SOURCE_SCHEMA_VERSION,
    sourceTaskId: taskId,
    sourceRunId,
    childTaskId: taskId,
    childRunId,
    courseAlias,
    toolPolicyVersion: checkpoint.toolPolicyVersion,
    sourceCheckpoint: checkpoint as CourseAgentVerifiedCheckpointSource["sourceCheckpoint"],
    provenance: Object.freeze({
      kind: "verified_checkpoint" as const,
      sourceCallId: compositionCall.id,
      sourceCompositionVerificationId: compositionVerification.id,
      sourceIntegrityVerificationId: integrityVerification.id
    }),
    composition: Object.freeze({
      output: compositionOutput,
      selectionRef: compositionMetadata.selectionRef,
      decisionId,
      stageTarget: Object.freeze({
        targetRef: opportunityId,
        opportunityId,
        candidateKey,
        decisionId,
        threadKey: decisionMaterial.threadKey,
        targetVersionHash: decisionMaterial.targetVersionHash,
        eventSetHash: decisionMaterial.eventSetHash,
        opportunityReceiptHash: decisionMaterial.opportunityReceiptHash,
        revalidationReceiptHash:
          decisionMaterial.revalidationReceiptHash,
        afterObservationReceiptHash:
          decisionMaterial.afterObservationReceiptHash,
        evidenceRefs: compositionEvidence
      }),
      evidenceRefs: compositionEvidence,
      verifier: Object.freeze({
        name: "verification.facilitation_intent" as const,
        version: "1" as const,
        status: "passed" as const,
        reportId: compositionVerification.id,
        subjectVersionRef: compositionOutput.compositionRef
      })
    }),
    integrity: Object.freeze({
      output: integrityOutput,
      evidenceRefs: integrityEvidence,
      verifier: Object.freeze({
        name: OPPORTUNITY_INTEGRITY_VERIFIER_NAME,
        version: OPPORTUNITY_INTEGRITY_VERIFIER_VERSION,
        status: "passed" as const,
        reportId: integrityVerification.id,
        subjectRef: checkpoint.integrityVerificationRef
      })
    }),
    draftRecovery,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  });
  let confirmedCheckpoint: CourseAgentVerifiedCheckpoint;
  try {
    confirmedCheckpoint = await deriveVerifiedCourseAgentCheckpoint(db, {
      taskId,
      runId: sourceRunId,
      now
    });
  } catch (error) {
    fail(
      "COURSE_AGENT_RECOVERY_CHECKPOINT_CHANGED_DURING_LOAD",
      "Source checkpoint could not be re-derived after recovery material loading.",
      checkpoint,
      error
    );
  }
  if (
    confirmedCheckpoint.checkpointRef !== checkpoint.checkpointRef ||
    confirmedCheckpoint.checkpointHash !== checkpoint.checkpointHash ||
    confirmedCheckpoint.state !== checkpoint.state ||
    confirmedCheckpoint.reasonCode !== checkpoint.reasonCode ||
    confirmedCheckpoint.compositionVersionRef !==
      checkpoint.compositionVersionRef ||
    confirmedCheckpoint.compositionContentHash !==
      checkpoint.compositionContentHash ||
    confirmedCheckpoint.draftVersionRef !== checkpoint.draftVersionRef ||
    confirmedCheckpoint.draftContentHash !== checkpoint.draftContentHash ||
    confirmedCheckpoint.draftBodyHash !== checkpoint.draftBodyHash ||
    confirmedCheckpoint.materialBindingHash !== checkpoint.materialBindingHash ||
    confirmedCheckpoint.regenerationMaterialHash !==
      checkpoint.regenerationMaterialHash ||
    confirmedCheckpoint.integrityVerificationRef !==
      checkpoint.integrityVerificationRef ||
    confirmedCheckpoint.stageTransactionRef !== checkpoint.stageTransactionRef
  ) {
    fail(
      "COURSE_AGENT_RECOVERY_CHECKPOINT_CHANGED_DURING_LOAD",
      "Source checkpoint changed while the recovery bundle was being loaded.",
      confirmedCheckpoint
    );
  }
  assertPrivacyClosed({
    ...source,
    draftRecovery: undefined,
    composition: {
      ...source.composition,
      verifier: {
        verifierId: source.composition.verifier.name,
        version: source.composition.verifier.version,
        status: source.composition.verifier.status,
        reportId: source.composition.verifier.reportId,
        subjectVersionRef:
          source.composition.verifier.subjectVersionRef
      },
      output: {
        ...source.composition.output,
        intent: undefined,
        moveSpec: undefined
      },
      stageTarget: {
        ...source.composition.stageTarget,
        threadKey: undefined
      }
    },
    integrity: {
      ...source.integrity,
      verifier: {
        verifierId: source.integrity.verifier.name,
        version: source.integrity.verifier.version,
        status: source.integrity.verifier.status,
        reportId: source.integrity.verifier.reportId,
        subjectRef: source.integrity.verifier.subjectRef
      }
    }
  });
  const runtimeRecovery = Object.freeze({ verifiedCheckpointSource: source });
  return Object.freeze({ checkpoint, source, runtimeRecovery });
}
