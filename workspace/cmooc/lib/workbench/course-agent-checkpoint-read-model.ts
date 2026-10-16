import {
  COURSE_AGENT_OBJECTIVE_CLASSIFIER_VERSION,
  COURSE_AGENT_PLAN_COMPILER_VERSION
} from "@/lib/workbench/course-agent-plan";
import { WORKBENCH_CANONICAL_PLAN_SCHEMA_VERSION } from "@/lib/workbench/plan-store";
import {
  assertOpaqueId,
  assertSafeDurableValue,
  normalizeDate,
  WORKBENCH_SAFE_OBJECTIVE_SCHEMA_VERSION,
  type SafeJsonValue,
  type WorkbenchDb
} from "@/lib/workbench/durable-ledger";
import {
  FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION,
  DELIVERY_BUNDLE_OUTPUT_SCHEMA_VERSION,
  parseReplyDraftPersistenceBindingV2
} from "@/lib/course-tools/tools/facilitation-artifacts";
import {
  PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
  PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION,
  PLATFORM_STAGE_VERIFIER_NAME,
  PLATFORM_STAGE_VERIFIER_VERSION
} from "@/lib/course-tools/tools/platform-stage";
import { COURSE_TOOL_POLICY_VERSION } from "@/lib/course-tools/policy-gateway";
import {
  hashCourseToolValue,
  assertCourseToolJsonValue,
  isIsoInstant,
  isSafeIdentifier,
  isSha256,
  type CourseToolJsonValue,
  type EvidenceRef
} from "@/lib/course-tools/contracts";
import { LIVE_FACILITATION_POLICY_VERSION } from "@/lib/live-runtime/facilitation-kernel";
import { SEMANTIC_RENDERER_VERSION } from "@/lib/autonomy/semantic-renderer";
import { WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION } from "@/lib/workbench/trusted-workbench-platform-stage-adapter";

export const COURSE_AGENT_CHECKPOINT_SCHEMA_VERSION =
  "cmooc.course-agent.derived-checkpoint.v1" as const;

export const COURSE_AGENT_CHECKPOINT_STATES = [
  "none",
  "evidence_replay_required",
  "composition_verified",
  "draft_regeneration_required",
  "stage_unknown_requires_reconcile",
  "stage_verified_delivery_ready",
  "completed",
  "blocked"
] as const;

export type CourseAgentCheckpointState =
  (typeof COURSE_AGENT_CHECKPOINT_STATES)[number];

export type CourseAgentCheckpointRecoveryAction =
  | "start_from_canonical_plan"
  | "replay_evidence_steps"
  | "regenerate_draft_and_reverify"
  | "reconcile_stage_without_replay"
  | "create_delivery_bundle"
  | "none"
  | "manual_review";

export type CourseAgentVerifiedCheckpoint = Readonly<{
  schemaVersion: typeof COURSE_AGENT_CHECKPOINT_SCHEMA_VERSION;
  checkpointRef: string;
  checkpointHash: string;
  state: CourseAgentCheckpointState;
  recoveryAction: CourseAgentCheckpointRecoveryAction;
  reasonCode: string;
  taskId: string;
  runId: string;
  planRef: string | null;
  planHash: string | null;
  currentStepRef: string | null;
  objectiveHash: string | null;
  compilerVersion: string | null;
  toolPolicyVersion: string | null;
  manifestHash: string | null;
  compositionVersionRef: string | null;
  compositionContentHash: string | null;
  draftVersionRef: string | null;
  draftContentHash: string | null;
  draftBodyHash: string | null;
  materialBindingHash: string | null;
  regenerationMaterialHash: string | null;
  integrityVerificationRef: string | null;
  stageTransactionRef: string | null;
  stageReceiptRef: string | null;
  stageReceiptHash: string | null;
  deliveryVersionRef: string | null;
  deliveryContentHash: string | null;
  derivedAt: string;
  containsForumText: false;
  containsIdentity: false;
  containsSecrets: false;
}>;

export type VerifiedDraftBinding = Readonly<{
  schemaVersion: string;
  compositionRef: string;
  intentHash: string;
  moveSpecHash: string;
  draftBodyHash: string;
  rendererVersion: string;
  rendererReceiptHash: string;
  lintReceiptHash: string;
  revisionKind: "initial" | "correction";
  materialBindingHash: string;
  regenerationMaterialHash: string;
}>;

export type CourseAgentDraftBindingParser = (input: Readonly<{
  metadata: unknown;
  regenerationRecipe: unknown;
  artifact: Readonly<{
    versionRef: string;
    contentHash: string;
    draftBodyHash: string;
    expiresAt: string;
  }>;
  composition: Readonly<{
    versionRef: string;
    intentHash: string;
    moveSpecHash: string;
    toolPolicyVersion: string;
  }>;
}>) => VerifiedDraftBinding | null;

export type DeriveVerifiedCourseAgentCheckpointOptions = Readonly<{
  draftBindingParser?: CourseAgentDraftBindingParser;
}>;

type AnyRecord = Record<string, unknown>;

type SafeArtifact = Readonly<{
  id: string;
  versionRef: string;
  artifactId: string;
  version: number;
  artifactKind: string;
  contentClass: string;
  contentHash: string;
  draftBodyHash: string | null;
  metadata: AnyRecord;
  sourceRefs: readonly EvidenceRef[];
  regenerationRecipe: AnyRecord | null;
  expiresAt: string | null;
  createdByCallId: string;
}>;

type VerifiedComposition = Readonly<{
  artifact: SafeArtifact;
  selectionRef: string;
  integrityVerificationRef: string;
  intentHash: string;
  moveSpecHash: string;
  receiptHash: string;
  toolPolicyVersion: string;
}>;

type VerifiedDraft = Readonly<{
  artifact: SafeArtifact;
  binding: VerifiedDraftBinding | null;
  compositionRef: string;
  integrityVerificationRef: string;
}>;

type ClosedStage = Readonly<{
  stageTransactionRef: string;
  status: string;
  planRevisionId: string;
  stepId: string;
  callId: string;
  courseAlias: string;
  courseScopeHash: string;
  artifactVersionRef: string;
  draftBodyHash: string;
  manifestHash: string;
  policyVersion: string;
  integrityVerificationRef: string;
  verifiedOutput: AnyRecord | null;
}>;

type DerivedCore = Omit<
  CourseAgentVerifiedCheckpoint,
  "schemaVersion" | "checkpointRef" | "checkpointHash" | "derivedAt" |
  "containsForumText" | "containsIdentity" | "containsSecrets"
>;

const IMPLEMENT_TOOL_NAMES = [
  "course.context.resolve",
  "course.snapshot.read",
  "opportunity.list",
  "opportunity.select_support_gap",
  "evidence.read_opportunity",
  "evidence.verify_integrity",
  "facilitation.intent.compose",
  "artifact.reply_draft.create",
  "platform.target.preflight_read",
  "platform.editor.stage_verify_clear",
  "delivery.bundle.create"
] as const;

const COMPLETED_STEP_STATUSES = new Set(["completed", "skipped"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "stopped"]);
const FORBIDDEN_KEYS = new Set([
  "body", "draftbody", "forumbody", "postbody", "replybody", "rawcontent",
  "contenttext", "text", "html", "markdown", "protectedref", "url",
  "targeturl", "identity", "name", "fullname", "displayname", "username",
  "userid", "email", "phone", "cookie", "setcookie", "token", "accesstoken",
  "refreshtoken", "secret", "password", "credential", "authstate",
  "authorization", "sessionstate"
]);

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: AnyRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertPrivacyClosed(value: unknown, path = "$", depth = 0): void {
  if (depth > 16) throw new Error("COURSE_AGENT_CHECKPOINT_UNSAFE_PERSISTED_VALUE");
  if (typeof value === "string") {
    if (
      /\b(?:https?|file):\/\//iu.test(value) ||
      /(?:^|[\s"'])(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|root)\/)/u.test(value) ||
      /\bBearer\s+/iu.test(value) ||
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(value)
    ) {
      throw new Error(`COURSE_AGENT_CHECKPOINT_UNSAFE_PERSISTED_VALUE:${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error("COURSE_AGENT_CHECKPOINT_UNSAFE_PERSISTED_VALUE");
    value.forEach((item, index) => assertPrivacyClosed(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(normalizeKey(key))) {
      throw new Error(`COURSE_AGENT_CHECKPOINT_UNSAFE_PERSISTED_VALUE:${path}.${key}`);
    }
    assertPrivacyClosed(child, `${path}.${key}`, depth + 1);
  }
}

function parseClosedObject(value: string | null, code: string): AnyRecord | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(code);
  }
  if (!isRecord(parsed)) throw new Error(code);
  assertPrivacyClosed(parsed);
  assertSafeDurableValue(parsed, code);
  return parsed;
}

function parseEvidenceRefs(value: string, code: string): readonly EvidenceRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(code);
  }
  assertPrivacyClosed(parsed);
  if (!Array.isArray(parsed) || parsed.length > 256) throw new Error(code);
  const refs = parsed.map((item) => {
    if (
      !isRecord(item) ||
      !exactKeys(item, ["kind", "id", "hash", "observedAt"]) ||
      typeof item.kind !== "string" ||
      !isSafeIdentifier(item.id) ||
      !isSha256(item.hash) ||
      !isIsoInstant(item.observedAt)
    ) {
      throw new Error(code);
    }
    return Object.freeze({
      kind: item.kind as EvidenceRef["kind"],
      id: item.id,
      hash: item.hash,
      observedAt: item.observedAt
    });
  });
  return Object.freeze(refs);
}

function artifactRef(id: string): string {
  return `artifact-version:${id}`;
}

function safeArtifact(row: {
  id: string;
  artifactId: string;
  version: number;
  artifactKind: string;
  contentClass: string;
  contentHash: string;
  draftBodyHash: string | null;
  metadataJson: string;
  sourceRefsJson: string;
  regenerationRecipeJson: string | null;
  expiresAt: Date | null;
  createdByCallId: string | null;
}): SafeArtifact {
  if (
    !isSafeIdentifier(row.id) ||
    !isSafeIdentifier(row.artifactId) ||
    !Number.isSafeInteger(row.version) || row.version < 1 ||
    !isSha256(row.contentHash) ||
    !row.createdByCallId || !isSafeIdentifier(row.createdByCallId)
  ) throw new Error("COURSE_AGENT_CHECKPOINT_ARTIFACT_INVALID");
  if (row.draftBodyHash !== null && !isSha256(row.draftBodyHash)) {
    throw new Error("COURSE_AGENT_CHECKPOINT_ARTIFACT_INVALID");
  }
  return Object.freeze({
    id: row.id,
    versionRef: artifactRef(row.id),
    artifactId: row.artifactId,
    version: row.version,
    artifactKind: row.artifactKind,
    contentClass: row.contentClass,
    contentHash: row.contentHash,
    draftBodyHash: row.draftBodyHash,
    metadata: parseClosedObject(row.metadataJson, "COURSE_AGENT_CHECKPOINT_ARTIFACT_METADATA_INVALID")!,
    sourceRefs: parseEvidenceRefs(row.sourceRefsJson, "COURSE_AGENT_CHECKPOINT_ARTIFACT_EVIDENCE_INVALID"),
    regenerationRecipe: parseClosedObject(row.regenerationRecipeJson, "COURSE_AGENT_CHECKPOINT_RECIPE_INVALID"),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdByCallId: row.createdByCallId
  });
}

function canonicalPlanHash(plan: {
  id: string;
  revision: number;
  objectiveHash: string;
  source: string;
  compilerVersion: string;
  proposalHash: string | null;
  steps: readonly {
    id: string;
    ordinal: number;
    status: string;
    toolName: string;
    toolVersion: string;
    dependencyIdsJson: string;
    inputRefsJson: string;
    preconditionsJson: string;
    postconditionsJson: string;
    effectClass: string;
    requiredCapability: string;
    acceptanceJson: string;
    replanPolicyJson: string;
  }[];
}): string {
  const steps = plan.steps.map((step) => ({
    id: step.id,
    ordinal: step.ordinal,
    status: step.status,
    toolName: step.toolName,
    toolVersion: step.toolVersion,
    dependencyIds: JSON.parse(step.dependencyIdsJson) as SafeJsonValue,
    inputRefs: JSON.parse(step.inputRefsJson) as SafeJsonValue,
    preconditions: JSON.parse(step.preconditionsJson) as SafeJsonValue,
    postconditions: JSON.parse(step.postconditionsJson) as SafeJsonValue,
    effectClass: step.effectClass,
    requiredCapability: step.requiredCapability,
    acceptance: JSON.parse(step.acceptanceJson) as SafeJsonValue,
    replanPolicy: JSON.parse(step.replanPolicyJson) as SafeJsonValue
  }));
  assertPrivacyClosed(steps);
  return hashCourseToolValue("cmooc.course-agent.canonical-plan-binding.v1", {
    schemaVersion: WORKBENCH_CANONICAL_PLAN_SCHEMA_VERSION,
    planRef: plan.id,
    revision: plan.revision,
    objectiveHash: plan.objectiveHash,
    source: plan.source,
    compilerVersion: plan.compilerVersion,
    proposalHash: plan.proposalHash,
    steps: steps as CourseToolJsonValue
  });
}

function passedVerification(rows: readonly {
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
}[], input: {
  subjectType: string;
  subjectId: string;
  verifier?: string;
  verifierVersion?: string;
  requiredCheckCodes?: readonly string[];
  allowExpired?: boolean;
  now: Date;
}): string | null {
  const matches = rows.filter((row) =>
    row.subjectType === input.subjectType && row.subjectId === input.subjectId &&
    row.status === "passed" && (!input.verifier || row.verifier === input.verifier) &&
    (!input.verifierVersion || row.verifierVersion === input.verifierVersion) &&
    (input.allowExpired || !row.expiresAt || row.expiresAt > input.now)
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error("COURSE_AGENT_CHECKPOINT_VERIFICATION_NOT_UNIQUE");
  const row = matches[0]!;
  if (row.containsForumText || row.containsIdentity || row.observedAt > input.now) {
    throw new Error("COURSE_AGENT_CHECKPOINT_VERIFICATION_INVALID");
  }
  let checks: unknown;
  try { checks = JSON.parse(row.checksJson) as unknown; } catch { throw new Error("COURSE_AGENT_CHECKPOINT_VERIFICATION_INVALID"); }
  assertPrivacyClosed(checks);
  if (!Array.isArray(checks) || checks.length < 1 || checks.some((check) =>
    !isRecord(check) || !exactKeys(check, ["code", "status", "safeSummary"]) ||
    check.status !== "passed" || typeof check.code !== "string" || typeof check.safeSummary !== "string"
  )) throw new Error("COURSE_AGENT_CHECKPOINT_VERIFICATION_INVALID");
  if (input.requiredCheckCodes) {
    const codes = checks.map((check) => (check as AnyRecord).code);
    if (
      new Set(codes).size !== codes.length ||
      input.requiredCheckCodes.some((code) => !codes.includes(code))
    ) throw new Error("COURSE_AGENT_CHECKPOINT_VERIFICATION_INVALID");
  }
  parseEvidenceRefs(row.evidenceRefsJson, "COURSE_AGENT_CHECKPOINT_VERIFICATION_EVIDENCE_INVALID");
  return row.id;
}

function manifestHashFromRefs(refs: readonly EvidenceRef[]): string | null {
  const manifests = [...new Set(refs.filter((ref) => ref.kind === "manifest").map((ref) => ref.hash))];
  if (manifests.length === 0) return null;
  if (manifests.length !== 1) throw new Error("COURSE_AGENT_CHECKPOINT_MANIFEST_NOT_UNIQUE");
  return manifests[0]!;
}

function parseComposition(artifact: SafeArtifact): VerifiedComposition {
  const metadata = artifact.metadata;
  if (
    artifact.artifactKind !== "facilitation_intent" || artifact.contentClass !== "safe_generated" ||
    artifact.draftBodyHash !== null || artifact.regenerationRecipe !== null ||
    !exactKeys(metadata, [
      "schemaVersion", "receiptRef", "receiptHash", "selectionRef",
      "selectionEvidenceBindingHash", "integrityVerificationRef",
      "evidenceBindingHash", "intentPolicyVersion", "toolPolicyVersion",
      "intent", "intentHash", "moveSpec", "moveSpecHash",
      "containsForumText", "containsIdentity", "containsSecrets"
    ]) ||
    metadata.schemaVersion !== FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION ||
    metadata.intentPolicyVersion !== LIVE_FACILITATION_POLICY_VERSION ||
    metadata.toolPolicyVersion !== COURSE_TOOL_POLICY_VERSION ||
    typeof metadata.selectionRef !== "string" || !isSafeIdentifier(metadata.selectionRef) ||
    typeof metadata.integrityVerificationRef !== "string" || !isSafeIdentifier(metadata.integrityVerificationRef) ||
    typeof metadata.intentHash !== "string" || !isSha256(metadata.intentHash) ||
    typeof metadata.moveSpecHash !== "string" || !isSha256(metadata.moveSpecHash) ||
    typeof metadata.receiptHash !== "string" || !isSha256(metadata.receiptHash) ||
    metadata.receiptRef !== `intent-compose:${metadata.receiptHash}` ||
    typeof metadata.selectionEvidenceBindingHash !== "string" || !isSha256(metadata.selectionEvidenceBindingHash) ||
    typeof metadata.evidenceBindingHash !== "string" || !isSha256(metadata.evidenceBindingHash) ||
    metadata.containsForumText !== false || metadata.containsIdentity !== false || metadata.containsSecrets !== false
  ) throw new Error("COURSE_AGENT_CHECKPOINT_COMPOSITION_BINDING_INVALID");
  const expectedContentHash = hashCourseToolValue("facilitation-intent-artifact.v2", {
    schemaVersion: FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION,
    intent: metadata.intent as CourseToolJsonValue,
    intentHash: metadata.intentHash,
    moveSpec: metadata.moveSpec as CourseToolJsonValue,
    moveSpecHash: metadata.moveSpecHash,
    receiptHash: metadata.receiptHash,
    intentPolicyVersion: metadata.intentPolicyVersion,
    toolPolicyVersion: metadata.toolPolicyVersion,
    selectionEvidenceBindingHash: metadata.selectionEvidenceBindingHash,
    evidenceBindingHash: metadata.evidenceBindingHash
  });
  if (artifact.contentHash !== expectedContentHash) {
    throw new Error("COURSE_AGENT_CHECKPOINT_COMPOSITION_HASH_INVALID");
  }
  return Object.freeze({
    artifact,
    selectionRef: metadata.selectionRef,
    integrityVerificationRef: metadata.integrityVerificationRef,
    intentHash: metadata.intentHash,
    moveSpecHash: metadata.moveSpecHash,
    receiptHash: metadata.receiptHash,
    toolPolicyVersion: metadata.toolPolicyVersion
  });
}

export const parseLegacyCourseAgentDraftBinding: CourseAgentDraftBindingParser = () => null;

function assertLegacyDraftEnvelope(artifact: SafeArtifact): void {
  const metadata = artifact.metadata;
  const recipe = artifact.regenerationRecipe;
  if (
    !recipe ||
    !exactKeys(metadata, [
      "schemaVersion", "compositionRef", "intent", "intentHash", "moveSpec",
      "moveSpecHash", "draftBodyHash", "rendererVersion", "rendererReceiptRef",
      "rendererReceiptHash", "lintReceiptRef", "lintReceiptHash", "revisionKind",
      "priorVersionRef", "feedbackRef", "bodyPersisted", "containsForumText",
      "containsIdentity", "containsSecrets"
    ]) ||
    !exactKeys(recipe, [
      "schemaVersion", "strategy", "compositionRef", "intentHash", "moveSpecHash",
      "rendererVersion", "requireReverification", "bodyPersisted"
    ]) ||
    metadata.schemaVersion !== FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION ||
    typeof metadata.compositionRef !== "string" || !isSafeIdentifier(metadata.compositionRef) ||
    typeof metadata.intentHash !== "string" || !isSha256(metadata.intentHash) ||
    typeof metadata.moveSpecHash !== "string" || !isSha256(metadata.moveSpecHash) ||
    typeof metadata.draftBodyHash !== "string" || !isSha256(metadata.draftBodyHash) ||
    metadata.rendererVersion !== SEMANTIC_RENDERER_VERSION ||
    typeof metadata.rendererReceiptHash !== "string" || !isSha256(metadata.rendererReceiptHash) ||
    metadata.rendererReceiptRef !== `semantic-renderer-receipt:${metadata.rendererReceiptHash}` ||
    typeof metadata.lintReceiptHash !== "string" || !isSha256(metadata.lintReceiptHash) ||
    metadata.lintReceiptRef !== `draft-lint:${metadata.lintReceiptHash}` ||
    metadata.revisionKind !== "initial" || metadata.priorVersionRef !== null || metadata.feedbackRef !== null ||
    recipe.schemaVersion !== "cmooc.facilitation-draft-regeneration-recipe.v1" ||
    recipe.strategy !== "reinvoke_semantic_renderer" ||
    recipe.compositionRef !== metadata.compositionRef || recipe.intentHash !== metadata.intentHash ||
    recipe.moveSpecHash !== metadata.moveSpecHash || recipe.rendererVersion !== metadata.rendererVersion ||
    recipe.requireReverification !== true || recipe.bodyPersisted !== false
  ) throw new Error("COURSE_AGENT_CHECKPOINT_DRAFT_ENVELOPE_INVALID");
  const expectedContentHash = hashCourseToolValue("facilitation-reply-draft-artifact.v1", {
    schemaVersion: FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION,
    compositionRef: metadata.compositionRef,
    intentHash: metadata.intentHash,
    moveSpecHash: metadata.moveSpecHash,
    draftBodyHash: metadata.draftBodyHash,
    rendererReceiptHash: metadata.rendererReceiptHash,
    lintReceiptHash: metadata.lintReceiptHash,
    revisionKind: metadata.revisionKind,
    priorVersionRef: metadata.priorVersionRef,
    feedbackRef: metadata.feedbackRef
  });
  if (artifact.contentHash !== expectedContentHash) {
    throw new Error("COURSE_AGENT_CHECKPOINT_DRAFT_HASH_INVALID");
  }
}

function parseDraft(
  artifact: SafeArtifact,
  composition: VerifiedComposition,
  parser: CourseAgentDraftBindingParser
): VerifiedDraft {
  if (
    artifact.artifactKind !== "facilitation_reply_draft" ||
    artifact.contentClass !== "restricted_transient" ||
    !artifact.draftBodyHash || !artifact.expiresAt ||
    artifact.metadata.compositionRef !== composition.artifact.versionRef ||
    artifact.metadata.intentHash !== composition.intentHash ||
    artifact.metadata.moveSpecHash !== composition.moveSpecHash ||
    artifact.metadata.draftBodyHash !== artifact.draftBodyHash ||
    artifact.metadata.bodyPersisted !== false ||
    artifact.metadata.containsForumText !== false ||
    artifact.metadata.containsIdentity !== false ||
    artifact.metadata.containsSecrets !== false
  ) throw new Error("COURSE_AGENT_CHECKPOINT_DRAFT_BINDING_INVALID");
  const binding = parser({
    metadata: artifact.metadata,
    regenerationRecipe: artifact.regenerationRecipe,
    artifact: {
      versionRef: artifact.versionRef,
      contentHash: artifact.contentHash,
      draftBodyHash: artifact.draftBodyHash,
      expiresAt: artifact.expiresAt
    },
    composition: {
      versionRef: composition.artifact.versionRef,
      intentHash: composition.intentHash,
      moveSpecHash: composition.moveSpecHash,
      toolPolicyVersion: composition.toolPolicyVersion
    }
  });
  if (binding) {
    assertPrivacyClosed(binding);
    if (
      binding.compositionRef !== composition.artifact.versionRef ||
      binding.intentHash !== composition.intentHash || binding.moveSpecHash !== composition.moveSpecHash ||
      binding.draftBodyHash !== artifact.draftBodyHash ||
      binding.rendererVersion !== SEMANTIC_RENDERER_VERSION ||
      !isSha256(binding.materialBindingHash) || !isSha256(binding.regenerationMaterialHash)
    ) throw new Error("COURSE_AGENT_CHECKPOINT_DRAFT_BINDING_INVALID");
  } else {
    assertLegacyDraftEnvelope(artifact);
  }
  return Object.freeze({ artifact, binding, compositionRef: composition.artifact.versionRef, integrityVerificationRef: composition.integrityVerificationRef });
}

function closeStage(row: {
  stageTransactionRef: string;
  schemaVersion: string;
  status: string;
  planRevisionId: string;
  stepId: string;
  callId: string;
  courseAlias: string;
  courseScopeHash: string;
  manifestHash: string;
  policyVersion: string;
  integrityVerificationRef: string;
  targetEvidenceRefsJson: string;
  artifactVersionRef: string;
  draftBodyHash: string;
  verifiedOutputJson: string | null;
  containsForumText: boolean;
  containsIdentity: boolean;
  containsSecrets: boolean;
  createdAt: Date;
  updatedAt: Date;
  terminalAt: Date | null;
}, now: Date): ClosedStage {
  if (
    row.schemaVersion !== WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION ||
    row.containsForumText || row.containsIdentity || row.containsSecrets ||
    row.createdAt > row.updatedAt || row.updatedAt > now ||
    !isSafeIdentifier(row.planRevisionId) || !isSafeIdentifier(row.stepId) ||
    !isSafeIdentifier(row.callId) || !isSafeIdentifier(row.courseAlias) ||
    !isSha256(row.courseScopeHash) || !isSha256(row.manifestHash) ||
    !isSafeIdentifier(row.policyVersion) || !isSafeIdentifier(row.integrityVerificationRef) ||
    !["pending", "unknown", "verified", "reconciled"].includes(row.status)
  ) throw new Error("COURSE_AGENT_CHECKPOINT_STAGE_BINDING_INVALID");
  const refs = parseEvidenceRefs(row.targetEvidenceRefsJson, "COURSE_AGENT_CHECKPOINT_STAGE_EVIDENCE_INVALID");
  if (manifestHashFromRefs(refs) !== row.manifestHash) {
    throw new Error("COURSE_AGENT_CHECKPOINT_STAGE_MANIFEST_INVALID");
  }
  const output = parseClosedObject(row.verifiedOutputJson, "COURSE_AGENT_CHECKPOINT_STAGE_OUTPUT_INVALID");
  const terminal = row.status === "verified" || row.status === "reconciled";
  if (terminal !== Boolean(row.terminalAt) || terminal !== Boolean(output)) {
    throw new Error("COURSE_AGENT_CHECKPOINT_STAGE_BINDING_INVALID");
  }
  if (output) {
    const expectedSchema = row.status === "verified" ? PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION : PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION;
    const outputEvidenceRefs = parseEvidenceRefs(
      JSON.stringify(output.evidenceRefs),
      "COURSE_AGENT_CHECKPOINT_STAGE_OUTPUT_EVIDENCE_INVALID"
    );
    if (
      output.schemaVersion !== expectedSchema || output.stageTransactionRef !== row.stageTransactionRef ||
      output.artifactVersionRef !== row.artifactVersionRef || output.draftBodyHash !== row.draftBodyHash ||
      typeof output.receiptRef !== "string" || !isSafeIdentifier(output.receiptRef) ||
      typeof output.receiptHash !== "string" || !isSha256(output.receiptHash) ||
      output.editorWriteCount !== 1 || output.editorReadbackCount !== 1 || output.editorReadbackVerified !== true ||
      output.editorClearCount !== 1 || output.editorEmptyAfterClear !== true ||
      output.submitMutationCount !== 0 || output.sendMutationCount !== 0 || output.closeAuditStatus !== "passed" ||
      output.realPublishEnabled !== false || output.bodyPersisted !== false || output.published !== false ||
      output.containsForumText !== false || output.containsIdentity !== false || output.containsSecrets !== false ||
      typeof output.observedAt !== "string" || !isIsoInstant(output.observedAt) || new Date(output.observedAt) > now
    ) throw new Error("COURSE_AGENT_CHECKPOINT_STAGE_BINDING_INVALID");
    if (!outputEvidenceRefs.some((ref) =>
      ref.kind === "stage_receipt" && ref.id === output.receiptRef && ref.hash === output.receiptHash
    )) throw new Error("COURSE_AGENT_CHECKPOINT_STAGE_RECEIPT_INVALID");
  }
  return Object.freeze({
    stageTransactionRef: row.stageTransactionRef,
    status: row.status,
    planRevisionId: row.planRevisionId,
    stepId: row.stepId,
    callId: row.callId,
    courseAlias: row.courseAlias,
    courseScopeHash: row.courseScopeHash,
    artifactVersionRef: row.artifactVersionRef,
    draftBodyHash: row.draftBodyHash,
    manifestHash: row.manifestHash,
    policyVersion: row.policyVersion,
    integrityVerificationRef: row.integrityVerificationRef,
    verifiedOutput: output
  });
}

function terminalToolReceiptHash(
  call: Readonly<{
    id: string;
    taskId: string;
    runId: string;
    stepId: string;
    toolName: string;
    toolVersion: string;
    status: string;
    receipt: Readonly<{
      id: string;
      status: string;
      outputHash: string;
      verificationId: string | null;
      containsForumText: boolean;
      containsIdentity: boolean;
    }> | null;
  }>,
  input: Readonly<{
    taskId: string;
    runId: string;
    stepId: string;
    toolName: "platform.editor.stage_verify_clear" | "platform.editor.reconcile_stage";
    verificationId: string;
    output: unknown;
  }>
): string | null {
  const receipt = call.receipt;
  if (
    call.taskId !== input.taskId ||
    call.runId !== input.runId ||
    call.stepId !== input.stepId ||
    call.toolName !== input.toolName ||
    call.toolVersion !== "1" ||
    call.status !== "succeeded" ||
    !receipt ||
    receipt.status !== "succeeded" ||
    receipt.verificationId !== input.verificationId ||
    receipt.containsForumText ||
    receipt.containsIdentity ||
    !isSafeIdentifier(receipt.id) ||
    !isSha256(receipt.outputHash)
  ) {
    return null;
  }
  assertCourseToolJsonValue(input.output, "checkpoint terminal tool output");
  const expectedOutputHash = hashCourseToolValue(
    `output:${input.toolName}@1`,
    input.output
  );
  if (receipt.outputHash !== expectedOutputHash) return null;
  return hashCourseToolValue("cmooc.course-agent-terminal-tool-receipt.v1", {
    receiptId: receipt.id,
    callId: call.id,
    status: receipt.status,
    outputHash: receipt.outputHash,
    verificationId: receipt.verificationId
  });
}

function baseCore(input: {
  taskId: string;
  runId: string;
  planRef: string | null;
  planHash: string | null;
  currentStepRef: string | null;
  objectiveHash: string | null;
  compilerVersion: string | null;
  manifestHash?: string | null;
}): Omit<DerivedCore, "state" | "recoveryAction" | "reasonCode"> {
  return {
    ...input,
    toolPolicyVersion: COURSE_TOOL_POLICY_VERSION,
    manifestHash: input.manifestHash ?? null,
    compositionVersionRef: null,
    compositionContentHash: null,
    draftVersionRef: null,
    draftContentHash: null,
    draftBodyHash: null,
    materialBindingHash: null,
    regenerationMaterialHash: null,
    integrityVerificationRef: null,
    stageTransactionRef: null,
    stageReceiptRef: null,
    stageReceiptHash: null,
    deliveryVersionRef: null,
    deliveryContentHash: null
  };
}

function finalized(core: DerivedCore, now: Date): CourseAgentVerifiedCheckpoint {
  const stablePayload = {
    schemaVersion: COURSE_AGENT_CHECKPOINT_SCHEMA_VERSION,
    ...core,
    containsForumText: false as const,
    containsIdentity: false as const,
    containsSecrets: false as const
  };
  assertPrivacyClosed(stablePayload);
  assertCourseToolJsonValue(stablePayload, "course agent checkpoint stable payload");
  const checkpointHash = hashCourseToolValue(
    "cmooc.course-agent.derived-checkpoint-hash.v1",
    stablePayload
  );
  return Object.freeze({
    ...stablePayload,
    checkpointRef: `course-checkpoint:${checkpointHash}`,
    checkpointHash,
    derivedAt: now.toISOString()
  });
}

function blocked(core: Omit<DerivedCore, "state" | "recoveryAction" | "reasonCode">, reasonCode: string, now: Date): CourseAgentVerifiedCheckpoint {
  return finalized({ ...core, state: "blocked", recoveryAction: "manual_review", reasonCode }, now);
}

export async function deriveVerifiedCourseAgentCheckpoint(
  db: WorkbenchDb,
  input: Readonly<{ taskId: string; runId: string; now?: Date | string }>,
  options: DeriveVerifiedCourseAgentCheckpointOptions = {}
): Promise<CourseAgentVerifiedCheckpoint> {
  const taskId = assertOpaqueId(input.taskId, "taskId");
  const runId = assertOpaqueId(input.runId, "runId");
  const now = normalizeDate(input.now ?? new Date(), "now");
  const scope = await db.workbenchRunRecord.findUnique({
    where: { id: runId },
    select: {
      taskId: true,
      status: true,
      task: {
        select: {
          safeObjective: {
            select: {
              schemaVersion: true,
              objectiveHash: true,
              structuredGoalJson: true,
              source: true,
              expiresAt: true
            }
          }
        }
      }
    }
  });
  if (!scope || scope.taskId !== taskId) throw new Error("COURSE_AGENT_CHECKPOINT_SCOPE_MISMATCH");
  const plans = await db.workbenchPlanRevisionRecord.findMany({
    where: { taskId, runId, source: "server_compiler" },
    orderBy: { revision: "desc" },
    include: { steps: { orderBy: { ordinal: "asc" } } },
    take: 2
  });
  if (plans.length === 0) {
    return finalized({
      ...baseCore({ taskId, runId, planRef: null, planHash: null, currentStepRef: null, objectiveHash: scope.task.safeObjective?.objectiveHash ?? null, compilerVersion: null }),
      state: "none", recoveryAction: "start_from_canonical_plan", reasonCode: "canonical_plan_absent"
    }, now);
  }
  const plan = plans[0]!;
  let planHash: string;
  try { planHash = canonicalPlanHash(plan); } catch {
    return blocked(baseCore({ taskId, runId, planRef: plan.id, planHash: null, currentStepRef: null, objectiveHash: plan.objectiveHash, compilerVersion: plan.compilerVersion }), "canonical_plan_corrupt", now);
  }
  const currentStep = plan.steps.find((step) => !COMPLETED_STEP_STATUSES.has(step.status)) ?? null;
  const core = baseCore({ taskId, runId, planRef: plan.id, planHash, currentStepRef: currentStep?.id ?? null, objectiveHash: plan.objectiveHash, compilerVersion: plan.compilerVersion });
  const objective = scope.task.safeObjective;
  let objectiveGoal: AnyRecord | null = null;
  try {
    objectiveGoal = objective
      ? parseClosedObject(objective.structuredGoalJson, "COURSE_AGENT_CHECKPOINT_OBJECTIVE_INVALID")
      : null;
  } catch {
    return blocked(core, "safe_objective_corrupt", now);
  }
  const expectedToolCount = plan.steps.length === 6 ? 6 : IMPLEMENT_TOOL_NAMES.length;
  if (
    plan.compilerVersion !== COURSE_AGENT_PLAN_COMPILER_VERSION ||
    !objective || objective.schemaVersion !== WORKBENCH_SAFE_OBJECTIVE_SCHEMA_VERSION ||
    objective.source !== COURSE_AGENT_OBJECTIVE_CLASSIFIER_VERSION ||
    objective.objectiveHash !== plan.objectiveHash || (objective.expiresAt && objective.expiresAt <= now) ||
    !objectiveGoal || objectiveGoal.goalCode !== "course_evidence_support_gap" ||
    objectiveGoal.policyVersion !== COURSE_TOOL_POLICY_VERSION ||
    (plan.steps.length !== 6 && plan.steps.length !== IMPLEMENT_TOOL_NAMES.length) ||
    plan.steps.length !== expectedToolCount ||
    plan.steps.some((step, index) => step.ordinal !== index + 1 || step.toolName !== IMPLEMENT_TOOL_NAMES[index] || step.toolVersion !== "1")
  ) return blocked(core, "canonical_plan_binding_invalid", now);

  const calls = await db.workbenchToolCallRecord.findMany({
    where: { taskId, runId, step: { planRevisionId: plan.id } },
    include: { receipt: true }, orderBy: { createdAt: "asc" }
  });
  const verifications = await db.workbenchVerificationRecord.findMany({ where: { taskId, runId } });
  const actions = await db.workbenchCourseToolActionRecord.findMany({
    where: { taskId, runId, planRevisionId: plan.id },
    select: {
      id: true,
      taskId: true,
      runId: true,
      planRevisionId: true,
      stepId: true,
      callId: true,
      toolName: true,
      toolVersion: true,
      courseScopeHash: true,
      policyVersion: true,
      status: true,
      terminalReceiptHash: true,
      reconciliationHash: true,
      parentActionId: true,
      recoveryOfActionId: true,
      containsForumText: true,
      containsIdentity: true,
      containsSecrets: true
    }
  });
  try {
    for (const step of plan.steps.filter((item) => item.status === "completed")) {
      const stepCalls = calls.filter((call) => call.stepId === step.id && call.status === "succeeded" && call.receipt?.status === "succeeded");
      if (stepCalls.length !== 1 || !stepCalls[0]!.receipt || stepCalls[0]!.receipt!.containsForumText || stepCalls[0]!.receipt!.containsIdentity) {
        return blocked(core, "completed_step_receipt_not_unique", now);
      }
      const receipt = stepCalls[0]!.receipt!;
      if (!isSha256(receipt.outputHash) || receipt.observedAt > now) return blocked(core, "completed_step_receipt_invalid", now);
      parseEvidenceRefs(receipt.evidenceRefsJson, "COURSE_AGENT_CHECKPOINT_RECEIPT_EVIDENCE_INVALID");
      if (step.requiredCapability !== "L0_READ" && !receipt.verificationId) return blocked(core, "completed_step_verification_missing", now);
    }
  } catch {
    return blocked(core, "completed_step_receipt_corrupt", now);
  }

  let artifacts: SafeArtifact[];
  try {
    artifacts = (await db.workbenchArtifactVersionRecord.findMany({
      where: { taskId, runId },
      orderBy: { createdAt: "asc" }
    })).map(safeArtifact);
  } catch {
    return blocked(core, "artifact_projection_corrupt", now);
  }
  const artifactCreatorIsExact = (
    artifact: SafeArtifact,
    toolName: string,
    verificationId: string
  ): boolean => {
    const matches = calls.filter((call) =>
      call.id === artifact.createdByCallId &&
      call.toolName === toolName &&
      call.status === "succeeded" &&
      call.receipt?.status === "succeeded" &&
      call.receipt.verificationId === verificationId &&
      plan.steps.some((step) =>
        step.id === call.stepId && step.toolName === toolName && step.status === "completed"
      )
    );
    return matches.length === 1;
  };
  const byKind = (kind: string) => artifacts.filter((artifact) => artifact.artifactKind === kind);
  if (byKind("facilitation_delivery_bundle").length > 1 || byKind("facilitation_reply_draft").length > 1 || byKind("facilitation_intent").length > 1) {
    return blocked(core, "artifact_candidate_not_unique", now);
  }
  const compositionArtifact = byKind("facilitation_intent")[0] ?? null;
  if (!compositionArtifact) {
    return finalized({ ...core, state: "evidence_replay_required", recoveryAction: "replay_evidence_steps", reasonCode: "verified_composition_absent" }, now);
  }

  let composition: VerifiedComposition;
  try {
    composition = parseComposition(compositionArtifact);
    const verification = passedVerification(verifications, {
      subjectType: "artifact_version", subjectId: compositionArtifact.id,
      verifier: "verification.course_tool_registry", verifierVersion: "1",
      requiredCheckCodes: [
        "verification.facilitation_intent.intent_movespec_hashes",
        "verification.facilitation_intent.artifact_content_hash",
        "verification.facilitation_intent.verified_evidence_binding",
        "verification.facilitation_intent.policy_domain_binding"
      ],
      allowExpired: true,
      now
    });
    if (!verification || !artifactCreatorIsExact(compositionArtifact, "facilitation.intent.compose", verification)) {
      return blocked(core, "composition_verification_absent_or_expired", now);
    }
  } catch {
    return blocked(core, "composition_binding_invalid", now);
  }
  const withComposition = {
    ...core,
    compositionVersionRef: composition.artifact.versionRef,
    compositionContentHash: composition.artifact.contentHash,
    integrityVerificationRef: composition.integrityVerificationRef,
    manifestHash: manifestHashFromRefs(composition.artifact.sourceRefs)
  };
  const draftArtifact = byKind("facilitation_reply_draft")[0] ?? null;
  if (!draftArtifact) {
    return finalized({ ...withComposition, state: "composition_verified", recoveryAction: "regenerate_draft_and_reverify", reasonCode: "composition_verified_draft_absent" }, now);
  }
  let draft: VerifiedDraft;
  try {
    draft = parseDraft(
      draftArtifact,
      composition,
      options.draftBindingParser ?? parseReplyDraftPersistenceBindingV2
    );
    const verification = passedVerification(verifications, {
      subjectType: "artifact_version", subjectId: draftArtifact.id,
      verifier: "verification.course_tool_registry", verifierVersion: "1",
      requiredCheckCodes: [
        "verification.facilitation_reply_draft.protected_body_hash",
        "verification.facilitation_reply_draft.restricted_transient_boundary",
        "verification.facilitation_reply_draft.privacy_claim_lint"
      ],
      allowExpired: true,
      now
    });
    if (!verification || !artifactCreatorIsExact(draftArtifact, "artifact.reply_draft.create", verification)) {
      return blocked(withComposition, "draft_verification_absent_or_expired", now);
    }
  } catch {
    return blocked(withComposition, "draft_binding_invalid", now);
  }
  const withDraft = {
    ...withComposition,
    draftVersionRef: draft.artifact.versionRef,
    draftContentHash: draft.artifact.contentHash,
    draftBodyHash: draft.artifact.draftBodyHash,
    materialBindingHash: draft.binding?.materialBindingHash ?? null,
    regenerationMaterialHash: draft.binding?.regenerationMaterialHash ?? null
  };

  const stageRows = await db.workbenchStageTransactionRecord.findMany({ where: { taskId, runId, artifactVersionRef: draft.artifact.versionRef }, orderBy: { createdAt: "desc" } });
  if (stageRows.length > 1) return blocked(withDraft, "stage_transaction_not_unique", now);
  if (stageRows.length === 1) {
    let stage: ClosedStage;
    let stageCall: typeof calls;
    let stageAction: typeof actions;
    try {
      stage = closeStage(stageRows[0]!, now);
      const stageStep = plan.steps.find((step) => step.toolName === "platform.editor.stage_verify_clear");
      stageCall = calls.filter((call) => call.id === stage.callId);
      stageAction = actions.filter((action) => action.callId === stage.callId);
      if (
        !stageStep || stage.planRevisionId !== plan.id || stage.stepId !== stageStep.id ||
        stageCall.length !== 1 || stageCall[0]!.taskId !== taskId || stageCall[0]!.runId !== runId ||
        stageCall[0]!.stepId !== stage.stepId || stageCall[0]!.toolName !== "platform.editor.stage_verify_clear" ||
        stageAction.length !== 1 || stageAction[0]!.taskId !== taskId || stageAction[0]!.runId !== runId ||
        stageAction[0]!.planRevisionId !== plan.id || stageAction[0]!.stepId !== stage.stepId ||
        stageAction[0]!.toolName !== "platform.editor.stage_verify_clear" || stageAction[0]!.toolVersion !== "1" ||
        stageAction[0]!.courseScopeHash !== stage.courseScopeHash || stageAction[0]!.policyVersion !== stage.policyVersion ||
        stageAction[0]!.containsForumText || stageAction[0]!.containsIdentity || stageAction[0]!.containsSecrets ||
        stage.courseAlias !== objectiveGoal!.courseAlias || stage.policyVersion !== COURSE_TOOL_POLICY_VERSION ||
        stage.integrityVerificationRef !== composition.integrityVerificationRef ||
        stage.artifactVersionRef !== draft.artifact.versionRef || stage.draftBodyHash !== draft.artifact.draftBodyHash ||
        !stage.manifestHash || stage.manifestHash !== withDraft.manifestHash
      ) {
        return blocked(withDraft, "stage_transaction_artifact_binding_invalid", now);
      }
    } catch {
      return blocked(withDraft, "stage_transaction_binding_invalid", now);
    }
    const withStage = { ...withDraft, stageTransactionRef: stage.stageTransactionRef };
    if (stage.status === "pending" || stage.status === "unknown") {
      return finalized({ ...withStage, state: "stage_unknown_requires_reconcile", recoveryAction: "reconcile_stage_without_replay", reasonCode: stage.status === "unknown" ? "stage_outcome_unknown" : "stage_transaction_incomplete_after_process_loss" }, now);
    }
    let stageVerificationRef: string | null;
    try {
      stageVerificationRef = passedVerification(verifications, {
        subjectType: "stage_transaction", subjectId: stage.stageTransactionRef,
        verifier: "verification.course_tool_registry", verifierVersion: "1",
        requiredCheckCodes: [
          `${PLATFORM_STAGE_VERIFIER_NAME}.atomic_editor_round_trip`,
          `${PLATFORM_STAGE_VERIFIER_NAME}.zero_external_mutations`,
          `${PLATFORM_STAGE_VERIFIER_NAME}.trusted_close_audit`,
          `${PLATFORM_STAGE_VERIFIER_NAME}.publication_hard_lock`,
          `${PLATFORM_STAGE_VERIFIER_NAME}.restricted_body_not_persisted`,
          `${PLATFORM_STAGE_VERIFIER_NAME}.trusted_receipt_binding`
        ],
        now
      });
    } catch {
      return blocked(withStage, "stage_verification_not_unique", now);
    }
    if (!stageVerificationRef || !stage.verifiedOutput) return blocked(withStage, "stage_verification_absent_or_expired", now);
    const originalAction = stageAction[0]!;
    if (stage.status === "verified") {
      const terminalCall = stageCall[0]!;
      const terminalHash = terminalToolReceiptHash(terminalCall, {
        taskId,
        runId,
        stepId: stage.stepId,
        toolName: "platform.editor.stage_verify_clear",
        verificationId: stageVerificationRef,
        output: stage.verifiedOutput
      });
      if (
        !terminalHash ||
        originalAction.status !== "succeeded" ||
        originalAction.parentActionId !== null ||
        originalAction.recoveryOfActionId !== null ||
        originalAction.terminalReceiptHash !== terminalHash ||
        originalAction.reconciliationHash !== null
      ) return blocked(withStage, "stage_tool_receipt_binding_invalid", now);
    } else {
      const recoveryActions = actions.filter((action) =>
        action.parentActionId === originalAction.id &&
        action.recoveryOfActionId === originalAction.id
      );
      if (recoveryActions.length !== 1) {
        return blocked(withStage, "stage_recovery_action_not_unique", now);
      }
      const recoveryAction = recoveryActions[0]!;
      const recoveryCalls = calls.filter((call) => call.id === recoveryAction.callId);
      const recoveryCall = recoveryCalls[0];
      const terminalHash = recoveryCall
        ? terminalToolReceiptHash(recoveryCall, {
            taskId,
            runId,
            stepId: stage.stepId,
            toolName: "platform.editor.reconcile_stage",
            verificationId: stageVerificationRef,
            output: stage.verifiedOutput
          })
        : null;
      if (
        recoveryCalls.length !== 1 ||
        !terminalHash ||
        originalAction.status !== "reconciled" ||
        originalAction.parentActionId !== null ||
        originalAction.recoveryOfActionId !== null ||
        originalAction.terminalReceiptHash !== null ||
        originalAction.reconciliationHash !== terminalHash ||
        recoveryAction.taskId !== taskId ||
        recoveryAction.runId !== runId ||
        recoveryAction.planRevisionId !== plan.id ||
        recoveryAction.stepId !== stage.stepId ||
        recoveryAction.toolName !== "platform.editor.reconcile_stage" ||
        recoveryAction.toolVersion !== "1" ||
        recoveryAction.status !== "succeeded" ||
        recoveryAction.courseScopeHash !== stage.courseScopeHash ||
        recoveryAction.policyVersion !== stage.policyVersion ||
        recoveryAction.terminalReceiptHash !== terminalHash ||
        recoveryAction.reconciliationHash !== null ||
        recoveryAction.containsForumText ||
        recoveryAction.containsIdentity ||
        recoveryAction.containsSecrets
      ) return blocked(withStage, "stage_recovery_receipt_binding_invalid", now);
    }
    const receiptRef = stage.verifiedOutput.receiptRef as string;
    const receiptHash = stage.verifiedOutput.receiptHash as string;
    const withVerifiedStage = { ...withStage, stageReceiptRef: receiptRef, stageReceiptHash: receiptHash };
    const delivery = byKind("facilitation_delivery_bundle")[0] ?? null;
    if (!delivery) {
      return finalized({ ...withVerifiedStage, state: "stage_verified_delivery_ready", recoveryAction: "create_delivery_bundle", reasonCode: "stage_verified_delivery_absent" }, now);
    }
    try {
      const metadata = delivery.metadata;
      if (
        delivery.contentClass !== "safe_aggregate" || delivery.regenerationRecipe !== null ||
        metadata.schemaVersion !== DELIVERY_BUNDLE_OUTPUT_SCHEMA_VERSION ||
        metadata.draftVersionRef !== draft.artifact.versionRef ||
        metadata.draftContentHash !== draft.artifact.contentHash || metadata.draftBodyHash !== draft.artifact.draftBodyHash ||
        metadata.integrityVerificationRef !== composition.integrityVerificationRef || metadata.stageVerificationRef !== receiptRef ||
        metadata.clearVerified !== true || metadata.editorEmptyAfter !== true || metadata.submitMutationCount !== 0 ||
        metadata.sendMutationCount !== 0 || metadata.realPublishEnabled !== false || metadata.published !== false ||
        metadata.containsForumText !== false || metadata.containsIdentity !== false || metadata.containsSecrets !== false ||
        !(() => {
          const verification = passedVerification(verifications, {
          subjectType: "artifact_version", subjectId: delivery.id,
          verifier: "verification.course_tool_registry", verifierVersion: "1",
          requiredCheckCodes: [
            "verification.facilitation_delivery_bundle.stage_safe_state",
            "verification.facilitation_delivery_bundle.zero_publish_boundary",
            "verification.facilitation_delivery_bundle.evidence_claim_boundary"
          ],
            now
          });
          return Boolean(
            verification &&
            artifactCreatorIsExact(delivery, "delivery.bundle.create", verification)
          );
        })()
      ) throw new Error("delivery invalid");
    } catch {
      return blocked(withVerifiedStage, "delivery_binding_invalid", now);
    }
    return finalized({
      ...withVerifiedStage,
      deliveryVersionRef: delivery.versionRef,
      deliveryContentHash: delivery.contentHash,
      state: "completed",
      recoveryAction: "none",
      reasonCode: TERMINAL_RUN_STATUSES.has(scope.status) ? "verified_delivery_completed" : "verified_delivery_present_run_not_terminal"
    }, now);
  }
  if (composition.artifact.expiresAt && new Date(composition.artifact.expiresAt) <= now) {
    return finalized({ ...withDraft, state: "evidence_replay_required", recoveryAction: "replay_evidence_steps", reasonCode: "composition_expired_fresh_evidence_required" }, now);
  }
  if (!draft.binding) {
    return finalized({
      ...withDraft,
      state: "evidence_replay_required",
      recoveryAction: "replay_evidence_steps",
      reasonCode: "draft_v1_restart_binding_insufficient"
    }, now);
  }
  return finalized({
    ...withDraft,
    state: "draft_regeneration_required",
    recoveryAction: "regenerate_draft_and_reverify",
    reasonCode: draft.artifact.expiresAt && new Date(draft.artifact.expiresAt) <= now
      ? "protected_draft_expired"
      : "fresh_stage_requires_regenerated_body"
  }, now);
}
