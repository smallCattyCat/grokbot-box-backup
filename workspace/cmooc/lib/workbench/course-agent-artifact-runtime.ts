import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import {
  canonicalProtocolHash,
  parseProtocolObject,
  type CanonicalJsonValue,
  type FacilitationMoveSpecV1,
  type InterventionIntentV1
} from "@/lib/facilitation-protocol";
import {
  AUTONOMY_DRAFT_REVALIDATION_SCHEMA_VERSION,
  type AutonomyDraftRevalidationReceipt
} from "@/lib/autonomy/draft-revalidation";
import {
  rebuildDeterministicSemanticDraft,
  SEMANTIC_RENDERER_CONTRACT_VERSION,
  SEMANTIC_RENDERER_RECEIPT_SCHEMA_VERSION,
  SEMANTIC_RENDERER_VERSION,
  type SemanticRendererReceipt
} from "@/lib/autonomy/semantic-renderer";
import {
  LIVE_DRAFT_GENERATOR_VERSION,
  LIVE_FACILITATION_POLICY_VERSION,
  LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION
} from "@/lib/live-runtime/facilitation-kernel";
import type {
  CourseToolExecutionOutcome,
  CourseToolJsonValue,
  EvidenceRef,
  ServerToolExecutionContext
} from "@/lib/course-tools/contracts";
import {
  hashCourseToolValue,
  isSafeIdentifier,
  isSha256
} from "@/lib/course-tools/contracts";
import {
  OPPORTUNITY_INTEGRITY_VERIFIER_NAME,
  OPPORTUNITY_INTEGRITY_VERIFIER_VERSION,
  OPPORTUNITY_INTEGRITY_REF_SCHEMA_VERSION,
  SUPPORT_GAP_EVIDENCE_BINDING_SCHEMA_VERSION,
  SUPPORT_GAP_SELECTION_POLICY_VERSION,
  SUPPORT_GAP_SELECTION_REF_SCHEMA_VERSION,
  parseOpportunitySelectionToolOutput,
  parseOpportunityVerificationToolOutput,
  type OpportunitySelectionToolOutput,
  type OpportunityVerificationToolOutput
} from "@/lib/course-tools/tools/register-evidence-tools";
import {
  listOpportunities,
  readOpportunityEvidence,
  selectSupportGap,
  verifyOpportunityIntegrity,
  type OpportunityListResult,
  type SupportGapOpportunityEvidence,
  type SupportGapSelection
} from "@/lib/course-tools/tools/opportunity-evidence";
import {
  resolveCourseContext,
  type ResolvedCourseContext
} from "@/lib/course-tools/tools/course-context";
import {
  parseReplyDraftCreateOutputV2,
  type DeliveryBundleResolvedInputs,
  type FacilitationArtifactToolDependencies,
  type FacilitationArtifactVersionWrite,
  type FacilitationIntentComposeOutput,
  type ReplyDraftCreateOutput,
  type ReplyDraftRecoverySourceV2,
  type RenderedFacilitationDraftMaterial,
  type VerifiedIntentCompositionMaterial,
  type ArtifactVersionPointer,
  type CreateFacilitationArtifactVersion
} from "@/lib/course-tools/tools/facilitation-artifacts";
import type {
  PlatformStageReconciledOutput,
  PlatformStageVerifiedOutput
} from "@/lib/course-tools/tools/platform-stage";
import { COURSE_TOOL_POLICY_VERSION } from "@/lib/course-tools/policy-gateway";
import {
  createArtifactVersion,
  type CreateArtifactVersionInput
} from "@/lib/workbench/artifact-store";
import { resolveOrInitializeSelectedArtifactVersion } from "@/lib/workbench/artifact-selection-store";
import {
  normalizeEvidenceRefs,
  serializeSafeDurableValue,
  type SafeJsonValue,
  type WorkbenchDb
} from "@/lib/workbench/durable-ledger";
import {
  hashPersistedEvidenceQualification,
  PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION,
  type PersistedEvidenceQualification
} from "@/lib/workbench/course-evidence-workspace";
import { readPersistedDecisionQualification } from "@/lib/workbench/evidence-read-model";
import {
  InMemoryProtectedArtifactStore,
  type ProtectedArtifactStore
} from "@/lib/workbench/protected-artifact-store";
import { CourseAgentProtectedMaterialVault } from "@/lib/workbench/course-agent-protected-material-vault";

export const COURSE_AGENT_ARTIFACT_RUNTIME_SCHEMA_VERSION =
  "cmooc.course-agent-artifact-runtime.v1" as const;
export const COURSE_AGENT_VERIFIED_CHECKPOINT_SOURCE_SCHEMA_VERSION =
  "cmooc.course-agent.verified-checkpoint-source.v2" as const;
const COURSE_AGENT_CHECKPOINT_SCHEMA_VERSION =
  "cmooc.course-agent.derived-checkpoint.v1" as const;
const COURSE_AGENT_CHECKPOINT_HASH_DOMAIN =
  "cmooc.course-agent.derived-checkpoint-hash.v1" as const;

type DecisionSemanticRealization = {
  rendererKind: string;
  rendererVersion: string;
  contractVersion: string;
  contentHash: string;
  validationJson: string;
  bodyPersisted: boolean;
};

export type CourseAgentArtifactDecisionRow = {
  id: string;
  invocationId: string;
  courseAlias: string;
  threadKey: string;
  decision: string;
  decisionMode: string;
  reasonCode: string;
  observationReceiptHash: string;
  opportunityReceiptHash: string;
  evidenceBundleHash: string;
  intentHash: string | null;
  moveSpecHash: string | null;
  draftContentHash: string | null;
  policyVersion: string;
  worldHash: string;
  candidateSetHash: string;
  evidenceAsOf: Date;
  decisionJson: string;
  bodyPersisted: boolean;
  publishAttempted: boolean;
  editorWriteAttempted: boolean;
  semanticRealization: DecisionSemanticRealization | null;
};

type SelectionRecord = {
  output: OpportunitySelectionToolOutput;
  context: MaterialContext;
  evidenceRefs: readonly EvidenceRef[];
};

type IntegrityRecord = {
  output: OpportunityVerificationToolOutput;
  context: MaterialContext;
  evidenceRefs: readonly EvidenceRef[];
  verifierReportId: string;
};

type CompositionRecord = {
  output: FacilitationIntentComposeOutput;
  context: MaterialContext;
  selectionRef: string;
  decisionId: string;
  stageTarget: CourseAgentStageTargetMaterial;
  evidenceRefs: readonly EvidenceRef[];
  provenance?: CourseAgentVerifiedCheckpointProvenance & {
    sourceRunId: string;
    checkpointRef: string;
    checkpointHash: string;
  };
};

type DraftRecord = {
  versionRef: string;
  artifactRef: string;
  artifactId: string;
  versionId: string;
  version: number;
  contentHash: string;
  draftBodyHash: string;
  compositionRef: string;
  integrityVerificationRef: string;
  evidenceRefs: readonly EvidenceRef[];
  context: MaterialContext;
};

type StageRecord = {
  output: PlatformStageVerifiedOutput | PlatformStageReconciledOutput;
  evidenceRefs: readonly EvidenceRef[];
  receiptEvidenceRef: EvidenceRef;
  context: MaterialContext;
  verifierReportId: string;
};

type PendingComposition = {
  material: VerifiedIntentCompositionMaterial;
  selectionRef: string;
  decisionId: string;
  stageTarget: CourseAgentStageTargetMaterial;
  context: MaterialContext;
};

export type CourseAgentStageTargetMaterial = Readonly<{
  targetRef: string;
  opportunityId: string;
  candidateKey: string;
  decisionId: string;
  threadKey: string;
  targetVersionHash: string;
  eventSetHash: string;
  opportunityReceiptHash: string;
  revalidationReceiptHash: string;
  afterObservationReceiptHash: string;
  evidenceRefs: readonly EvidenceRef[];
}>;

export type CourseAgentStageMaterialBinding = Readonly<{
  target: CourseAgentStageTargetMaterial;
  artifactVersionRef: string | null;
  draftBodyHash: string | null;
  integrityVerificationRef: string;
}>;

export type CourseAgentVerifiedCheckpointProvenance = Readonly<{
  kind: "verified_checkpoint";
  sourceCallId: string;
  sourceCompositionVerificationId: string;
  sourceIntegrityVerificationId: string;
}>;

export type CourseAgentVerifiedCheckpointSource = Readonly<{
  schemaVersion: typeof COURSE_AGENT_VERIFIED_CHECKPOINT_SOURCE_SCHEMA_VERSION;
  sourceTaskId: string;
  sourceRunId: string;
  childTaskId: string;
  childRunId: string;
  courseAlias: string;
  toolPolicyVersion: string;
  sourceCheckpoint: Readonly<{
    schemaVersion: typeof COURSE_AGENT_CHECKPOINT_SCHEMA_VERSION;
    checkpointRef: string;
    checkpointHash: string;
    state:
      | "composition_verified"
      | "draft_regeneration_required"
      | "stage_unknown_requires_reconcile"
      | "stage_verified_delivery_ready";
    recoveryAction:
      | "regenerate_draft_and_reverify"
      | "reconcile_stage_without_replay"
      | "create_delivery_bundle";
    reasonCode: string;
    taskId: string;
    runId: string;
    planRef: string | null;
    planHash: string | null;
    currentStepRef: string | null;
    objectiveHash: string | null;
    compilerVersion: string | null;
    toolPolicyVersion: string;
    manifestHash: string | null;
    compositionVersionRef: string;
    compositionContentHash: string;
    draftVersionRef: string | null;
    draftContentHash: string | null;
    draftBodyHash: string | null;
    materialBindingHash: string | null;
    regenerationMaterialHash: string | null;
    integrityVerificationRef: string;
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
  provenance: CourseAgentVerifiedCheckpointProvenance;
  composition: Readonly<{
    output: FacilitationIntentComposeOutput;
    selectionRef: string;
    decisionId: string;
    stageTarget: CourseAgentStageTargetMaterial;
    evidenceRefs: readonly EvidenceRef[];
    verifier: Readonly<{
      name: "verification.facilitation_intent";
      version: "1";
      status: "passed";
      reportId: string;
      subjectVersionRef: string;
    }>;
  }>;
  integrity: Readonly<{
    output: OpportunityVerificationToolOutput;
    evidenceRefs: readonly EvidenceRef[];
    verifier: Readonly<{
      name: typeof OPPORTUNITY_INTEGRITY_VERIFIER_NAME;
      version: typeof OPPORTUNITY_INTEGRITY_VERIFIER_VERSION;
      status: "passed";
      reportId: string;
      subjectRef: string;
    }>;
  }>;
  draftRecovery?: ReplyDraftRecoverySourceV2;
  containsForumText: false;
  containsIdentity: false;
  containsSecrets: false;
}>;

type MaterialContext = {
  taskId: string;
  runId: string;
  callId: string;
  courseAlias: string;
  toolPolicyVersion: string;
  observedAt: string;
};

type VerifiedRevalidationReceipt = AutonomyDraftRevalidationReceipt &
  Readonly<{
    afterObservationReceiptHash: string;
    targetVersionHash: string;
    eventSetHash: string;
  }>;

type VerifiedDecision = {
  row: CourseAgentArtifactDecisionRow;
  summary: Record<string, unknown>;
  intent: InterventionIntentV1;
  intentHash: string;
  moveSpec: FacilitationMoveSpecV1;
  moveSpecHash: string;
  semanticReceipt: SemanticRendererReceipt;
  semanticReceiptHash: string;
  revalidationReceipt: VerifiedRevalidationReceipt;
  revalidationReceiptHash: string;
  evidenceBindingHash: string;
  evidenceRefs: readonly EvidenceRef[];
};

export type CourseAgentVerifiedRecoveryDecisionMaterial = Readonly<{
  decisionId: string;
  threadKey: string;
  candidateKey: string;
  opportunityId: string;
  targetVersionHash: string;
  eventSetHash: string;
  opportunityReceiptHash: string;
  integrityVerificationRef: string;
  revalidationReceiptHash: string;
  afterObservationReceiptHash: string;
  intentHash: string;
  moveSpecHash: string;
  evidenceBindingHash: string;
}>;

type ResolveContext = (input: {
  courseAlias: string;
  contextRef: string;
  prisma: typeof defaultPrisma;
}) => Promise<ResolvedCourseContext>;

type ListOpportunities = (input: {
  context: ResolvedCourseContext;
  prisma: typeof defaultPrisma;
}) => Promise<OpportunityListResult>;

type ReadOpportunity = (input: {
  context: ResolvedCourseContext;
  opportunityId: string;
  prisma: typeof defaultPrisma;
}) => Promise<SupportGapOpportunityEvidence>;

export type CourseAgentArtifactRuntimeOptions = {
  readonly taskId: string;
  readonly runId: string;
  readonly courseAlias: string;
  readonly prisma?: typeof defaultPrisma;
  readonly artifactDb?: WorkbenchDb;
  readonly protectedStore?: ProtectedArtifactStore;
  readonly protectedDraftTtlMs?: number;
  readonly resolveCourseContext?: ResolveContext;
  readonly listOpportunities?: ListOpportunities;
  readonly readOpportunityEvidence?: ReadOpportunity;
  readonly selectSupportGap?: (input: OpportunityListResult) => SupportGapSelection;
  readonly loadDecision?: (decisionId: string) => Promise<CourseAgentArtifactDecisionRow | null>;
  readonly createArtifactVersion?: CreateFacilitationArtifactVersion;
  readonly resolveSelectedArtifactVersion?: ResolveSelectedArtifactVersion;
  /** Trusted server-only parent material; hydrated only inside a genuine child call. */
  readonly verifiedCheckpointSource?: CourseAgentVerifiedCheckpointSource;
};

export type ResolveSelectedArtifactVersion = (
  input: ArtifactVersionSelectionBinding & { readonly now: string }
) => Promise<boolean>;

type ArtifactVersionSelectionBinding = Readonly<{
  taskId: string;
  runId: string;
  artifactId: string;
  versionId: string;
  versionRef: string;
  contentHash: string;
  draftBodyHash: string | null;
}>;

export class CourseAgentArtifactRuntimeError extends Error {
  constructor(readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CourseAgentArtifactRuntimeError";
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new CourseAgentArtifactRuntimeError(code, message, { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) fail(code, "Trusted material failed its closed object boundary.");
  return value;
}

const RESTRICTED_MATERIAL_KEYS = new Set([
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
  "protectedref"
]);

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function assertNoRestrictedMaterialKeys(
  value: unknown,
  code: string,
  depth = 0
): void {
  if (depth > 16) {
    fail(code, "Trusted material exceeds the bounded structure depth.");
  }
  if (Array.isArray(value)) {
    if (value.length > 256) {
      fail(code, "Trusted material exceeds the bounded collection size.");
    }
    for (const item of value) assertNoRestrictedMaterialKeys(item, code, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  if (Object.keys(value).length > 256) {
    fail(code, "Trusted material exceeds the bounded object size.");
  }
  for (const [key, child] of Object.entries(value)) {
    if (RESTRICTED_MATERIAL_KEYS.has(normalizedKey(key))) {
      fail(
        code,
        `Trusted material crossed the protected body, identity, or secret boundary (${key}).`
      );
    }
    assertNoRestrictedMaterialKeys(child, code, depth + 1);
  }
}

function iso(value: string, code: string): string {
  if (!Number.isFinite(Date.parse(value))) fail(code, "Trusted material contains an invalid instant.");
  return new Date(value).toISOString();
}

function asFalse(value: unknown): value is false {
  return value === false;
}

function checkpointStablePayload(
  checkpoint: CourseAgentVerifiedCheckpointSource["sourceCheckpoint"]
): Record<string, unknown> {
  const {
    checkpointRef: _checkpointRef,
    checkpointHash: _checkpointHash,
    derivedAt: _derivedAt,
    ...stable
  } = checkpoint;
  return stable;
}

function checkpointHash(
  checkpoint: CourseAgentVerifiedCheckpointSource["sourceCheckpoint"]
): string {
  return hashCourseToolValue(
    COURSE_AGENT_CHECKPOINT_HASH_DOMAIN,
    checkpointStablePayload(checkpoint) as CourseToolJsonValue
  );
}

function safeMaterialHash(value: unknown, code: string): string {
  try {
    return canonicalProtocolHash(
      COURSE_AGENT_VERIFIED_CHECKPOINT_SOURCE_SCHEMA_VERSION,
      value as CanonicalJsonValue
    );
  } catch (cause) {
    fail(code, "Verified checkpoint material is not canonical safe JSON.", cause);
  }
}

function sameMaterial(left: unknown, right: unknown): boolean {
  return safeMaterialHash(left, "COURSE_AGENT_CHECKPOINT_SOURCE_INVALID") ===
    safeMaterialHash(right, "COURSE_AGENT_CHECKPOINT_SOURCE_INVALID");
}

function checkpointPrivacyProjection(
  source: CourseAgentVerifiedCheckpointSource
): unknown {
  const {
    draftRecovery: _draftRecovery,
    ...sourceWithoutDraftRecovery
  } = source;
  const {
    output: { intent, moveSpec, ...compositionOutput },
    verifier: {
      name: _compositionVerifierName,
      ...compositionVerifier
    },
    stageTarget: { threadKey: _threadKey, ...stageTarget },
    ...composition
  } = source.composition;
  const {
    verifier: { name: _integrityVerifierName, ...integrityVerifier },
    ...integrity
  } = source.integrity;
  return {
    ...sourceWithoutDraftRecovery,
    composition: {
      ...composition,
      verifier: compositionVerifier,
      stageTarget,
      output: compositionOutput
    },
    integrity: {
      ...integrity,
      verifier: integrityVerifier
    },
    protocolHashes: {
      intentHash: canonicalProtocolHash(
        intent.schemaVersion,
        intent as CanonicalJsonValue
      ),
      moveSpecHash: canonicalProtocolHash(
        moveSpec.schemaVersion,
        moveSpec as CanonicalJsonValue
      )
    }
  };
}

function contextRecord(context: Readonly<ServerToolExecutionContext>): MaterialContext {
  return Object.freeze({
    taskId: context.taskId,
    runId: context.runId,
    callId: context.callId,
    courseAlias: context.courseScope.alias,
    toolPolicyVersion: context.policyVersion,
    observedAt: iso(context.now, "COURSE_AGENT_MATERIAL_TIME_INVALID")
  });
}

function assertRuntimeScope(
  expected: { taskId: string; runId: string; courseAlias: string },
  context: Readonly<ServerToolExecutionContext>
): void {
  if (
    context.taskId !== expected.taskId ||
    context.runId !== expected.runId ||
    context.courseScope.alias !== expected.courseAlias
  ) {
    fail(
      "COURSE_AGENT_MATERIAL_SCOPE_MISMATCH",
      "Course artifact material belongs to another task, run, or course."
    );
  }
}

function assertSameMaterialContext(
  left: MaterialContext,
  context: Readonly<ServerToolExecutionContext>
): void {
  if (
    left.taskId !== context.taskId ||
    left.runId !== context.runId ||
    left.courseAlias !== context.courseScope.alias ||
    left.toolPolicyVersion !== context.policyVersion
  ) {
    fail(
      "COURSE_AGENT_MATERIAL_CONTEXT_CONFLICT",
      "Course artifact material is not bound to the current run and tool policy."
    );
  }
}

function dedupeEvidenceRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const byKey = new Map<string, EvidenceRef>();
  for (const ref of refs) {
    if (
      !isSafeIdentifier(ref.id) ||
      !isSha256(ref.hash) ||
      !Number.isFinite(Date.parse(ref.observedAt))
    ) {
      fail("COURSE_AGENT_EVIDENCE_REF_INVALID", "An evidence reference is invalid.");
    }
    byKey.set(`${ref.kind}\0${ref.id}\0${ref.hash}`, Object.freeze({ ...ref }));
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

function uniqueManifestEvidenceHash(
  refs: readonly EvidenceRef[]
): string | null {
  const manifestHashes = new Set(
    refs.filter((ref) => ref.kind === "manifest").map((ref) => ref.hash)
  );
  if (manifestHashes.size !== 1) return null;
  const [manifestHash] = manifestHashes;
  return isSha256(manifestHash) ? manifestHash : null;
}

function coreOpportunityEvidenceRefs(
  evidence: SupportGapOpportunityEvidence,
  integrityVerificationRef: string
): readonly EvidenceRef[] {
  const refs: EvidenceRef[] = evidence.evidenceRefs.map((ref) => ({
    kind:
      ref.kind === "target_projection"
        ? "candidate"
        : ref.kind === "qualification"
          ? "decision"
          : ref.kind,
    id:
      ref.kind === "manifest"
        ? `manifest:${ref.hash}`
        : ref.kind === "target_projection"
          ? `${ref.id}:target`
          : ref.id,
    hash: ref.hash,
    observedAt: ref.observedAt
  }));
  refs.push({
    kind: "world",
    id: `world:${evidence.exactAnchor.snapshotId}`,
    hash: evidence.exactAnchor.worldHash,
    observedAt: evidence.exactAnchor.worldAsOf
  });
  const verificationHash = integrityVerificationRef.slice(
    "integrity-verification:".length
  );
  if (!isSha256(verificationHash)) {
    fail(
      "COURSE_AGENT_INTEGRITY_REF_INVALID",
      "Integrity verification reference is not canonically hashed."
    );
  }
  refs.push({
    kind: "verification",
    id: integrityVerificationRef,
    hash: verificationHash,
    observedAt: evidence.exactAnchor.worldAsOf
  });
  return dedupeEvidenceRefs(refs);
}

function selectionBinding(input: {
  list: OpportunityListResult;
  selection: SupportGapSelection;
  toolPolicyVersion: string;
}): { output: OpportunitySelectionToolOutput; selectionHash: string } {
  const selectedOpportunityId = input.selection.selected?.opportunityId ?? null;
  const reasonCode: OpportunitySelectionToolOutput["reasonCode"] =
    input.selection.status === "selected"
      ? "mature_support_gap_highest_age_then_candidate_key"
      : input.selection.status === "no_action"
        ? "all_sources_checked_no_mature_support_gap"
        : input.selection.status === "policy_no_safe_action"
          ? "qualified_candidates_blocked_by_policy"
          : "candidate_evidence_unknown_or_unavailable";
  const contextRef = `snapshot:${input.list.exactAnchor.snapshotId}`;
  const evidenceBindingHash = canonicalProtocolHash(
    SUPPORT_GAP_EVIDENCE_BINDING_SCHEMA_VERSION,
    {
      schemaVersion: SUPPORT_GAP_EVIDENCE_BINDING_SCHEMA_VERSION,
      contextRef,
      invocationRef: input.list.exactAnchor.invocationId,
      snapshotRef: input.list.exactAnchor.snapshotId,
      worldHash: input.list.exactAnchor.worldHash,
      eventSetHash: input.list.exactAnchor.eventSetHash,
      coverageHash: input.list.exactAnchor.coverageHash,
      candidateSetHash: input.list.exactAnchor.candidateSetHash,
      toolPolicyVersion: input.toolPolicyVersion,
      selectionPolicyVersion: SUPPORT_GAP_SELECTION_POLICY_VERSION,
      selectedOpportunityId,
      reasonCode
    }
  );
  const exclusions = input.selection.exclusions.slice(0, 5);
  const selectionHash = canonicalProtocolHash(
    SUPPORT_GAP_SELECTION_REF_SCHEMA_VERSION,
    {
      schemaVersion: SUPPORT_GAP_SELECTION_REF_SCHEMA_VERSION,
      evidenceBindingHash,
      status: input.selection.status,
      selectedOpportunityId,
      reasonCode,
      exclusions
    }
  );
  return {
    selectionHash,
    output: {
      schemaVersion: "cmooc.course-tool.opportunity-selection-output.v1",
      status: input.selection.status,
      contextRef,
      snapshotRef: input.list.exactAnchor.snapshotId,
      asOf: input.list.exactAnchor.worldAsOf,
      candidateSetHash: input.list.exactAnchor.candidateSetHash,
      selectionRef: `support-gap-selection:${selectionHash}`,
      evidenceBindingHash,
      selectionPolicyVersion: SUPPORT_GAP_SELECTION_POLICY_VERSION,
      selectedOpportunityId,
      reasonCode,
      exclusions
    }
  };
}

function integrityReference(
  evidence: SupportGapOpportunityEvidence,
  status: SupportGapOpportunityEvidence["status"]
): string {
  const hash = canonicalProtocolHash(OPPORTUNITY_INTEGRITY_REF_SCHEMA_VERSION, {
    schemaVersion: OPPORTUNITY_INTEGRITY_REF_SCHEMA_VERSION,
    contextRef: `snapshot:${evidence.exactAnchor.snapshotId}`,
    invocationRef: evidence.exactAnchor.invocationId,
    snapshotRef: evidence.exactAnchor.snapshotId,
    worldHash: evidence.exactAnchor.worldHash,
    eventSetHash: evidence.exactAnchor.eventSetHash,
    coverageHash: evidence.exactAnchor.coverageHash,
    candidateSetHash: evidence.exactAnchor.candidateSetHash,
    opportunityId: evidence.opportunityId,
    claim: evidence.claim.kind,
    status,
    evidenceHashes: [...new Set(evidence.evidenceRefs.map((ref) => ref.hash))].sort()
  });
  return `integrity-verification:${hash}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertExactSelection(
  actual: OpportunitySelectionToolOutput,
  expected: OpportunitySelectionToolOutput
): void {
  if (!sameJson(actual, expected)) {
    fail(
      "COURSE_AGENT_SELECTION_REPLAY_MISMATCH",
      "Recorded support-gap selection differs from an exact anchored replay."
    );
  }
}

function parseQualification(value: unknown): PersistedEvidenceQualification {
  const object = asRecord(value, "COURSE_AGENT_QUALIFICATION_INVALID");
  const reasonCodes = object.reasonCodes;
  if (
    object.answerability !== "qualified" ||
    object.formatValid !== true ||
    object.evidenceLegal !== true ||
    object.relationCorrect !== true ||
    object.temporalLegal !== true ||
    object.supportResolution !== "resolved" ||
    object.appropriateAbstention !== false ||
    object.decision !== "qualify" ||
    !Array.isArray(reasonCodes) ||
    reasonCodes.length !== 0
  ) {
    fail(
      "COURSE_AGENT_QUALIFICATION_NOT_PASSED",
      "Persisted decision is not fully qualified for artifact composition."
    );
  }
  return {
    answerability: "qualified",
    formatValid: true,
    evidenceLegal: true,
    relationCorrect: true,
    temporalLegal: true,
    supportResolution: "resolved",
    appropriateAbstention: false,
    decision: "qualify",
    reasonCodes: []
  };
}

function parseSemanticReceipt(value: unknown): SemanticRendererReceipt {
  assertNoRestrictedMaterialKeys(value, "COURSE_AGENT_SEMANTIC_RECEIPT_RESTRICTED");
  const object = asRecord(value, "COURSE_AGENT_SEMANTIC_RECEIPT_INVALID");
  if (
    object.schemaVersion !== SEMANTIC_RENDERER_RECEIPT_SCHEMA_VERSION ||
    object.rendererVersion !== SEMANTIC_RENDERER_VERSION ||
    object.contractVersion !== SEMANTIC_RENDERER_CONTRACT_VERSION ||
    object.resolution !== "deterministic_fallback" ||
    object.modelInvoked !== false ||
    object.modelOutputAccepted !== false ||
    object.bodyPersisted !== false ||
    object.containsForumText !== false
  ) {
    fail(
      "COURSE_AGENT_SEMANTIC_RECEIPT_UNSUPPORTED",
      "Only a verified deterministic, body-free semantic receipt can be rebuilt."
    );
  }
  return object as unknown as SemanticRendererReceipt;
}

function parseRevalidation(
  value: unknown,
  expectedHash: unknown,
  opportunityReceiptHash: string,
  beforeObservationReceiptHash: string,
  targetVersionHash: string,
  eventSetHash: string,
  evidenceAsOf: string,
  now: string
): VerifiedRevalidationReceipt {
  assertNoRestrictedMaterialKeys(value, "COURSE_AGENT_REVALIDATION_RESTRICTED");
  const receipt = asRecord(value, "COURSE_AGENT_REVALIDATION_MISSING");
  if (
    receipt.schemaVersion !== AUTONOMY_DRAFT_REVALIDATION_SCHEMA_VERSION ||
    receipt.opportunityReceiptHash !== opportunityReceiptHash ||
    receipt.beforeObservationReceiptHash !== beforeObservationReceiptHash ||
    typeof receipt.beforeObservationReceiptHash !== "string" ||
    !isSha256(receipt.beforeObservationReceiptHash) ||
    typeof receipt.afterObservationReceiptHash !== "string" ||
    !isSha256(receipt.afterObservationReceiptHash) ||
    receipt.afterObservationReceiptHash === beforeObservationReceiptHash ||
    receipt.targetVersionHash !== targetVersionHash ||
    receipt.eventSetHash !== eventSetHash ||
    receipt.rereadObserved !== true ||
    receipt.decision !== "EXECUTE" ||
    receipt.reasonCode !== "stable_no_human_response" ||
    receipt.shadowContinuationAllowed !== true ||
    receipt.editorWriteAllowed !== false ||
    receipt.publishAllowed !== false ||
    receipt.containsForumText !== false ||
    receipt.newlyObservedExternalHumanEventCount !== 0 ||
    receipt.newlyObservedDistinctActorEventCount !== 0 ||
    receipt.newlyObservedAuthorEventCount !== 0 ||
    receipt.newlyObservedSystemEventCount !== 0 ||
    receipt.removedPreviouslyObservedEventCount !== 0 ||
    receipt.changedPreviouslyObservedEventCount !== 0 ||
    typeof expectedHash !== "string" ||
    !isSha256(expectedHash) ||
    canonicalProtocolHash(
      AUTONOMY_DRAFT_REVALIDATION_SCHEMA_VERSION,
      receipt as CanonicalJsonValue
    ) !== expectedHash ||
    typeof receipt.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.checkedAt)) ||
    Date.parse(receipt.checkedAt) < Date.parse(evidenceAsOf) ||
    Date.parse(receipt.checkedAt) > Date.parse(now)
  ) {
    fail(
      "COURSE_AGENT_REVALIDATION_NOT_EXECUTABLE",
      "Persisted target reread does not prove a stable, non-publishing continuation."
    );
  }
  return receipt as unknown as VerifiedRevalidationReceipt;
}

function parseSemanticRealization(
  row: DecisionSemanticRealization | null,
  semanticReceiptHash: string,
  expectedContentHash: string
): void {
  if (
    !row ||
    row.rendererKind !== "deterministic_fallback" ||
    row.rendererVersion !== SEMANTIC_RENDERER_VERSION ||
    row.contractVersion !== SEMANTIC_RENDERER_CONTRACT_VERSION ||
    row.contentHash !== expectedContentHash ||
    row.bodyPersisted !== false
  ) {
    fail(
      "COURSE_AGENT_SEMANTIC_REALIZATION_INVALID",
      "Persisted semantic realization is missing or conflicts with its deterministic receipt."
    );
  }
  const validation = asRecord(
    JSON.parse(row.validationJson) as unknown,
    "COURSE_AGENT_SEMANTIC_REALIZATION_INVALID"
  );
  assertNoRestrictedMaterialKeys(
    validation,
    "COURSE_AGENT_SEMANTIC_REALIZATION_RESTRICTED"
  );
  if (
    validation.schemaVersion !== "cmooc.semantic-realization-validation.v1" ||
    validation.targetBound !== true ||
    validation.intentBound !== true ||
    validation.moveSpecBound !== true ||
    validation.semanticReceiptHash !== semanticReceiptHash ||
    validation.modelInvoked !== false ||
    validation.modelOutputAccepted !== false ||
    validation.bodyPersisted !== false ||
    validation.containsForumText !== false
  ) {
    fail(
      "COURSE_AGENT_SEMANTIC_REALIZATION_INVALID",
      "Semantic realization validation does not preserve its trusted bindings."
    );
  }
}

function parseDecisionSummary(
  row: CourseAgentArtifactDecisionRow,
  evidence: SupportGapOpportunityEvidence,
  context: Readonly<ServerToolExecutionContext>
): VerifiedDecision {
  let summary: Record<string, unknown>;
  try {
    summary = asRecord(
      JSON.parse(row.decisionJson) as unknown,
      "COURSE_AGENT_DECISION_JSON_INVALID"
    );
  } catch (error) {
    if (error instanceof CourseAgentArtifactRuntimeError) throw error;
    fail("COURSE_AGENT_DECISION_JSON_INVALID", "Persisted decision JSON is invalid.", error);
  }
  assertNoRestrictedMaterialKeys(summary, "COURSE_AGENT_DECISION_RESTRICTED");
  if (
    row.invocationId !== evidence.exactAnchor.invocationId ||
    row.courseAlias !== evidence.exactAnchor.courseAlias ||
    row.worldHash !== evidence.exactAnchor.worldHash ||
    row.candidateSetHash !== evidence.exactAnchor.candidateSetHash ||
    row.decision !== "draft" ||
    row.decisionMode !== "DRAFT_ELIGIBLE" ||
    row.reasonCode !== "draft_eligible" ||
    row.policyVersion !== LIVE_FACILITATION_POLICY_VERSION ||
    row.bodyPersisted !== false ||
    row.publishAttempted !== false ||
    row.editorWriteAttempted !== false ||
    row.intentHash === null ||
    row.moveSpecHash === null ||
    row.draftContentHash === null ||
    summary.schemaVersion !== "cmooc.autonomy-decision-summary.v1" ||
    summary.candidateKey !== evidence.candidateKey ||
    summary.decision !== row.decision ||
    summary.decisionMode !== row.decisionMode ||
    summary.reasonCode !== row.reasonCode ||
    summary.observationReceiptHash !== row.observationReceiptHash ||
    summary.opportunityReceiptHash !== row.opportunityReceiptHash ||
    summary.opportunityReceiptSchemaVersion !== LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION ||
    summary.evidenceBundleHash !== row.evidenceBundleHash ||
    summary.intentHash !== row.intentHash ||
    summary.moveSpecHash !== row.moveSpecHash ||
    summary.draftContentHash !== row.draftContentHash ||
    summary.draftBodyPersisted !== false ||
    summary.publishAttempted !== false ||
    summary.editorWriteAttempted !== false ||
    summary.containsForumText !== false ||
    summary.qualificationSchemaVersion !== PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION
  ) {
    fail(
      "COURSE_AGENT_DECISION_BINDING_MISMATCH",
      "Persisted decision does not match the exact selected opportunity and safe execution boundary."
    );
  }
  const safeQualification = readPersistedDecisionQualification({
    id: row.id,
    decision: row.decision,
    opportunityReceiptHash: row.opportunityReceiptHash,
    decisionJson: row.decisionJson
  });
  const qualification = parseQualification(summary.qualification);
  if (
    !safeQualification ||
    typeof summary.qualificationHash !== "string" ||
    hashPersistedEvidenceQualification({
      opportunityReceiptHash: row.opportunityReceiptHash,
      qualification
    }) !== summary.qualificationHash
  ) {
    fail(
      "COURSE_AGENT_QUALIFICATION_HASH_MISMATCH",
      "Persisted evidence qualification failed its canonical hash."
    );
  }
  const intent = parseProtocolObject("interventionIntent", summary.intent);
  const moveSpec = parseProtocolObject("facilitationMoveSpec", summary.moveSpec);
  const intentHash = canonicalProtocolHash(
    intent.schemaVersion,
    intent as CanonicalJsonValue
  );
  const moveSpecHash = canonicalProtocolHash(
    moveSpec.schemaVersion,
    moveSpec as CanonicalJsonValue
  );
  if (
    intentHash !== row.intentHash ||
    moveSpecHash !== row.moveSpecHash ||
    moveSpec.intentHash !== intentHash ||
    intent.policyVersion !== LIVE_FACILITATION_POLICY_VERSION ||
    intent.intervene !== true ||
    intent.evidenceAsOf !== row.evidenceAsOf.toISOString() ||
    Date.parse(intent.candidateExpiresAt) <= Date.parse(context.now)
  ) {
    fail(
      "COURSE_AGENT_PROTOCOL_BINDING_MISMATCH",
      "Persisted Intent and MoveSpec are invalid, stale, or not bound to the decision."
    );
  }
  const semanticReceipt = parseSemanticReceipt(summary.semanticReceipt);
  if (
    typeof summary.semanticReceiptHash !== "string" ||
    !isSha256(summary.semanticReceiptHash) ||
    canonicalProtocolHash(
      semanticReceipt.schemaVersion,
      semanticReceipt as unknown as CanonicalJsonValue
    ) !== summary.semanticReceiptHash ||
    semanticReceipt.opportunityReceiptHash !== row.opportunityReceiptHash ||
    semanticReceipt.observationReceiptHash !== row.observationReceiptHash ||
    semanticReceipt.targetVersionHash !== evidence.target.targetVersionHash ||
    semanticReceipt.eventSetHash !== evidence.exactAnchor.eventSetHash ||
    semanticReceipt.intentHash !== intentHash ||
    semanticReceipt.moveSpecHash !== moveSpecHash ||
    semanticReceipt.contentHash !== row.draftContentHash ||
    semanticReceipt.selectedFunction !== intent.facilitationFunction ||
    semanticReceipt.targetObject !== intent.targetObject
  ) {
    fail(
      "COURSE_AGENT_SEMANTIC_RECEIPT_BINDING_MISMATCH",
      "Semantic renderer receipt conflicts with the selected opportunity or protocol objects."
    );
  }
  const evidenceRefHash = canonicalProtocolHash(
    "cmooc.live-qualified-evidence-ref.v1",
    {
      schemaVersion: "cmooc.live-qualified-evidence-ref.v1",
      observationReceiptHash: row.observationReceiptHash,
      historyCutoffHash: semanticReceipt.historyCutoffHash,
      historyEvidenceHash: semanticReceipt.historyEvidenceHash,
      targetVersionHash: semanticReceipt.targetVersionHash,
      eventSetHash: semanticReceipt.eventSetHash,
      assessedAt: intent.evidenceAsOf,
      qualification,
      containsForumText: false
    }
  );
  if (intent.evidenceRefHash !== evidenceRefHash) {
    fail(
      "COURSE_AGENT_INTENT_EVIDENCE_BINDING_MISMATCH",
      "Intervention Intent does not bind the qualified evidence projection."
    );
  }
  const revalidationReceiptHash = summary.revalidationReceiptHash;
  if (typeof revalidationReceiptHash !== "string") {
    fail(
      "COURSE_AGENT_REVALIDATION_NOT_EXECUTABLE",
      "Persisted target reread is missing its canonical receipt hash."
    );
  }
  const revalidationReceipt = parseRevalidation(
    summary.revalidationReceipt,
    revalidationReceiptHash,
    row.opportunityReceiptHash,
    row.observationReceiptHash,
    evidence.target.targetVersionHash,
    evidence.exactAnchor.eventSetHash,
    row.evidenceAsOf.toISOString(),
    context.now
  );
  parseSemanticRealization(
    row.semanticRealization,
    summary.semanticReceiptHash,
    row.draftContentHash
  );
  return {
    row,
    summary,
    intent,
    intentHash,
    moveSpec,
    moveSpecHash,
    semanticReceipt,
    semanticReceiptHash: summary.semanticReceiptHash,
    revalidationReceipt,
    revalidationReceiptHash,
    evidenceBindingHash: evidenceRefHash,
    evidenceRefs: []
  };
}

function defaultDecisionLoader(
  db: typeof defaultPrisma
): (decisionId: string) => Promise<CourseAgentArtifactDecisionRow | null> {
  return async (decisionId) =>
    db.autonomyDecision.findUnique({
      where: { id: decisionId },
      select: {
        id: true,
        invocationId: true,
        courseAlias: true,
        threadKey: true,
        decision: true,
        decisionMode: true,
        reasonCode: true,
        observationReceiptHash: true,
        opportunityReceiptHash: true,
        evidenceBundleHash: true,
        intentHash: true,
        moveSpecHash: true,
        draftContentHash: true,
        policyVersion: true,
        worldHash: true,
        candidateSetHash: true,
        evidenceAsOf: true,
        decisionJson: true,
        bodyPersisted: true,
        publishAttempted: true,
        editorWriteAttempted: true,
        semanticRealization: {
          select: {
            rendererKind: true,
            rendererVersion: true,
            contractVersion: true,
            contentHash: true,
            validationJson: true,
            bodyPersisted: true
          }
        }
      }
    });
}

/**
 * Server-only checkpoint recovery bridge. It deliberately replays the same
 * exact, body-free evidence and decision verifier used by ordinary artifact
 * composition, and returns only safe hashes/refs needed by child-run STAGE.
 */
export async function loadVerifiedCourseAgentRecoveryDecisionMaterial(input: {
  db: typeof defaultPrisma;
  courseAlias: string;
  snapshotId: string;
  decisionId: string;
  toolPolicyVersion: string;
  now: Date | string;
  resolveContext?: typeof resolveCourseContext;
  readOpportunity?: typeof readOpportunityEvidence;
  loadDecision?: (
    decisionId: string
  ) => Promise<CourseAgentArtifactDecisionRow | null>;
}): Promise<CourseAgentVerifiedRecoveryDecisionMaterial> {
  const now =
    input.now instanceof Date ? input.now.toISOString() : new Date(input.now).toISOString();
  if (
    !isSafeIdentifier(input.courseAlias) ||
    !isSafeIdentifier(input.snapshotId) ||
    !isSafeIdentifier(input.decisionId) ||
    input.toolPolicyVersion !== COURSE_TOOL_POLICY_VERSION ||
    !Number.isFinite(Date.parse(now))
  ) {
    fail(
      "COURSE_AGENT_RECOVERY_DECISION_SCOPE_INVALID",
      "Recovery decision replay scope is invalid."
    );
  }
  const resolve = input.resolveContext ?? resolveCourseContext;
  const read = input.readOpportunity ?? readOpportunityEvidence;
  const row = await (input.loadDecision ?? defaultDecisionLoader(input.db))(
    input.decisionId
  );
  let candidateKey: unknown;
  try {
    candidateKey = JSON.parse(row?.decisionJson ?? "null")?.candidateKey;
  } catch {
    candidateKey = null;
  }
  if (!row || typeof candidateKey !== "string" || !isSafeIdentifier(candidateKey)) {
    fail(
      "COURSE_AGENT_RECOVERY_DECISION_NOT_FOUND",
      "Exact recovery decision or its safe candidate locator is absent."
    );
  }
  const opportunityId = `support-gap:${candidateKey}`;
  const context = await resolve({
    courseAlias: input.courseAlias,
    contextRef: `snapshot:${input.snapshotId}`,
    prisma: input.db
  });
  const evidence = await read({
    context,
    opportunityId,
    prisma: input.db
  });
  if (
    context.anchor.courseAlias !== input.courseAlias ||
    context.anchor.snapshotId !== input.snapshotId ||
    evidence.exactAnchor.courseAlias !== input.courseAlias ||
    evidence.exactAnchor.snapshotId !== input.snapshotId ||
    evidence.opportunityId !== opportunityId ||
    evidence.qualification.decisionRef !== `decision:${input.decisionId}` ||
    evidence.qualification.status !== "qualified" ||
    evidence.integrity.candidateSet !== "verified" ||
    evidence.integrity.targetProjection !== "verified" ||
    evidence.integrity.qualification !== "verified" ||
    evidence.policy.decision !== "draft" ||
    evidence.policy.reasonCodes.length !== 0 ||
    evidence.status !== "eligible"
  ) {
    fail(
      "COURSE_AGENT_RECOVERY_DECISION_EVIDENCE_MISMATCH",
      "Recovery decision does not replay to one exact eligible opportunity."
    );
  }
  if (
    row.id !== input.decisionId ||
    row.opportunityReceiptHash !==
      evidence.qualification.opportunityReceiptHash
  ) {
    fail(
      "COURSE_AGENT_RECOVERY_DECISION_NOT_FOUND",
      "Exact recovery decision is absent."
    );
  }
  const verified = parseDecisionSummary(row, evidence, {
    callId: `checkpoint-recovery:${input.decisionId}`,
    taskId: "checkpoint-recovery",
    runId: "checkpoint-recovery",
    planRevisionId: "checkpoint-recovery",
    stepId: "checkpoint-recovery",
    courseScope: {
      courseId: input.courseAlias,
      alias: input.courseAlias,
      manifestHash: context.anchor.manifestHash
    },
    intent: "implement",
    baseCapability: "L1_ARTIFACT",
    capabilityGrantRefs: [],
    policyVersion: input.toolPolicyVersion,
    now,
    deadlineAt: now,
    idempotencyKey: `checkpoint-recovery:${input.decisionId}`,
    attempt: 1,
    executionLeaseId: "checkpoint-recovery",
    leaseGeneration: 1,
    fencingToken: "checkpoint-recovery-fence",
    causationId: `checkpoint-recovery:${input.decisionId}`
  });
  const integrityVerificationRef = integrityReference(
    evidence,
    evidence.status
  );
  return Object.freeze({
    decisionId: row.id,
    threadKey: row.threadKey,
    candidateKey: evidence.candidateKey,
    opportunityId: evidence.opportunityId,
    targetVersionHash: evidence.target.targetVersionHash,
    eventSetHash: verified.revalidationReceipt.eventSetHash,
    opportunityReceiptHash: row.opportunityReceiptHash,
    integrityVerificationRef,
    revalidationReceiptHash: verified.revalidationReceiptHash,
    afterObservationReceiptHash:
      verified.revalidationReceipt.afterObservationReceiptHash,
    intentHash: verified.intentHash,
    moveSpecHash: verified.moveSpecHash,
    evidenceBindingHash: verified.evidenceBindingHash
  });
}

function safeIdHash(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function pointerFromRecord(record: {
  id: string;
  artifactId: string;
  version: number;
  contentHash: string;
}): ArtifactVersionPointer {
  return Object.freeze({
    artifactId: record.artifactId,
    versionId: record.id,
    artifactRef: `artifact:${record.artifactId}`,
    versionRef: `artifact-version:${record.id}`,
    version: record.version,
    contentHash: record.contentHash
  });
}

function durableInput(write: Readonly<FacilitationArtifactVersionWrite>): {
  id: string;
  artifactId: string;
  input: CreateArtifactVersionInput;
} {
  const artifactId = safeIdHash("course-artifact", write.artifactKey);
  const id = safeIdHash(
    "course-artifact-version",
    `${write.taskId}\0${write.runId}\0${write.versionKey}`
  );
  return {
    id,
    artifactId,
    input: {
      id,
      taskId: write.taskId,
      runId: write.runId,
      artifactId,
      artifactKind: write.artifactKind,
      contentClass: write.contentClass,
      contentHash: write.contentHash,
      draftBodyHash: write.draftBodyHash,
      contentRef: null,
      safeSummary: write.safeSummary,
      metadata: write.metadata as SafeJsonValue,
      sourceRefs: write.sourceRefs,
      regenerationRecipe: write.regenerationRecipe as SafeJsonValue | null,
      createdByCallId: write.createdByCallId,
      expiresAt: write.expiresAt
    }
  };
}

function assertExistingArtifactMatches(
  existing: {
    id: string;
    taskId: string;
    runId: string;
    artifactId: string;
    version: number;
    artifactKind: string;
    contentClass: string;
    contentHash: string;
    draftBodyHash: string | null;
    safeSummary: string;
    metadataJson: string;
    sourceRefsJson: string;
    regenerationRecipeJson: string | null;
    createdByCallId: string | null;
    expiresAt: Date | null;
  },
  write: Readonly<FacilitationArtifactVersionWrite>,
  artifactId: string
): void {
  const metadataJson = serializeSafeDurableValue(write.metadata as SafeJsonValue, "metadata");
  const sourceRefsJson = serializeSafeDurableValue(
    normalizeEvidenceRefs(write.sourceRefs, "sourceRefs"),
    "sourceRefs"
  );
  const recipeJson = write.regenerationRecipe
    ? serializeSafeDurableValue(write.regenerationRecipe as SafeJsonValue, "regenerationRecipe")
    : null;
  if (
    existing.taskId !== write.taskId ||
    existing.runId !== write.runId ||
    existing.artifactId !== artifactId ||
    existing.artifactKind !== write.artifactKind ||
    existing.contentClass !== write.contentClass ||
    existing.contentHash !== write.contentHash ||
    existing.draftBodyHash !== write.draftBodyHash ||
    existing.safeSummary !== write.safeSummary ||
    existing.metadataJson !== metadataJson ||
    existing.sourceRefsJson !== sourceRefsJson ||
    existing.regenerationRecipeJson !== recipeJson ||
    existing.createdByCallId !== write.createdByCallId ||
    (existing.expiresAt?.toISOString() ?? null) !== write.expiresAt
  ) {
    fail(
      "COURSE_AGENT_ARTIFACT_IDEMPOTENCY_CONFLICT",
      "Artifact version key is already bound to different immutable metadata."
    );
  }
}

export function createDurableFacilitationArtifactVersionAdapter(
  db: WorkbenchDb = defaultPrisma
): CreateFacilitationArtifactVersion {
  return async (write) => {
    const { id, artifactId, input } = durableInput(write);
    if (write.previousVersionRef !== null) {
      const prefix = "artifact-version:";
      if (!write.previousVersionRef.startsWith(prefix)) {
        fail(
          "COURSE_AGENT_PREVIOUS_ARTIFACT_REF_INVALID",
          "Previous artifact version reference is invalid."
        );
      }
      const previous = await db.workbenchArtifactVersionRecord.findUnique({
        where: { id: write.previousVersionRef.slice(prefix.length) }
      });
      if (
        !previous ||
        previous.taskId !== write.taskId ||
        previous.artifactId !== artifactId
      ) {
        fail(
          "COURSE_AGENT_PREVIOUS_ARTIFACT_SCOPE_MISMATCH",
          "Previous artifact version is unavailable or belongs to another artifact."
        );
      }
    }
    const existing = await db.workbenchArtifactVersionRecord.findUnique({ where: { id } });
    if (existing) {
      assertExistingArtifactMatches(existing, write, artifactId);
      return pointerFromRecord(existing);
    }
    try {
      return pointerFromRecord(await createArtifactVersion(db, input));
    } catch (error) {
      const raced = await db.workbenchArtifactVersionRecord.findUnique({ where: { id } });
      if (!raced) throw error;
      assertExistingArtifactMatches(raced, write, artifactId);
      return pointerFromRecord(raced);
    }
  };
}

function transientOutput(outcome: CourseToolExecutionOutcome): CourseToolJsonValue {
  if (outcome.result.status !== "succeeded" || outcome.result.transientOutput === undefined) {
    fail(
      "COURSE_AGENT_MATERIAL_OUTCOME_NOT_SUCCEEDED",
      "Only a succeeded transient tool output can enter the run material ledger."
    );
  }
  return outcome.result.transientOutput;
}

function requirePassedVerification(
  outcome: CourseToolExecutionOutcome,
  subjectId: string
): string {
  if (
    !outcome.verification ||
    outcome.verification.status !== "passed" ||
    outcome.verification.subjectId !== subjectId
  ) {
    fail(
      "COURSE_AGENT_MATERIAL_VERIFICATION_NOT_PASSED",
      "Tool material lacks a passed verification bound to its exact subject."
    );
  }
  return outcome.verification.id;
}

function jsonEvidenceRefs(value: unknown): readonly EvidenceRef[] {
  if (!Array.isArray(value)) {
    fail("COURSE_AGENT_EVIDENCE_REF_INVALID", "Material evidence references are missing.");
  }
  return dedupeEvidenceRefs(
    value.map((item) => {
      const ref = asRecord(item, "COURSE_AGENT_EVIDENCE_REF_INVALID");
      return {
        kind: ref.kind as EvidenceRef["kind"],
        id: String(ref.id ?? ""),
        hash: String(ref.hash ?? ""),
        observedAt: String(ref.observedAt ?? "")
      };
    })
  );
}

function parseIntentOutput(value: CourseToolJsonValue): FacilitationIntentComposeOutput {
  const output = asRecord(value, "COURSE_AGENT_COMPOSITION_OUTPUT_INVALID");
  if (
    output.schemaVersion !== "cmooc.course-tool.facilitation-intent-output.v2" ||
    output.status !== "composed" ||
    typeof output.compositionRef !== "string" ||
    typeof output.integrityVerificationRef !== "string" ||
    typeof output.selectionEvidenceBindingHash !== "string" ||
    typeof output.evidenceBindingHash !== "string" ||
    output.intentPolicyVersion !== LIVE_FACILITATION_POLICY_VERSION ||
    typeof output.toolPolicyVersion !== "string" ||
    !asFalse(output.containsForumText) ||
    !asFalse(output.containsIdentity) ||
    !asFalse(output.containsSecrets)
  ) {
    fail("COURSE_AGENT_COMPOSITION_OUTPUT_INVALID", "Composition output is invalid.");
  }
  return output as unknown as FacilitationIntentComposeOutput;
}

function parseDraftOutput(value: CourseToolJsonValue): ReplyDraftCreateOutput {
  const output = parseReplyDraftCreateOutputV2(value);
  if (!output) {
    fail("COURSE_AGENT_DRAFT_OUTPUT_INVALID", "Draft output is invalid.");
  }
  return output;
}

function parseStageOutput(
  value: CourseToolJsonValue
): PlatformStageVerifiedOutput | PlatformStageReconciledOutput {
  const output = asRecord(value, "COURSE_AGENT_STAGE_OUTPUT_INVALID");
  const isInitial =
    output.schemaVersion === "cmooc.course-tool.platform-stage-output.v1" &&
    output.status === "verified_cleared";
  const isReconciled =
    output.schemaVersion ===
      "cmooc.course-tool.platform-stage-reconcile-output.v1" &&
    output.status === "reconciled_cleared" &&
    ["already_verified", "owned_draft_cleared"].includes(
      String(output.resolution)
    );
  if (
    (!isInitial && !isReconciled) ||
    typeof output.stageTransactionRef !== "string" ||
    typeof output.receiptRef !== "string" ||
    typeof output.artifactVersionRef !== "string" ||
    typeof output.draftBodyHash !== "string" ||
    output.editorReadbackVerified !== true ||
    output.editorEmptyAfterClear !== true ||
    output.submitMutationCount !== 0 ||
    output.sendMutationCount !== 0 ||
    output.closeAuditStatus !== "passed" ||
    output.realPublishEnabled !== false ||
    output.bodyPersisted !== false ||
    output.published !== false ||
    !asFalse(output.containsForumText) ||
    !asFalse(output.containsIdentity) ||
    !asFalse(output.containsSecrets)
  ) {
    fail("COURSE_AGENT_STAGE_OUTPUT_INVALID", "STAGE output is invalid.");
  }
  return output as unknown as
    | PlatformStageVerifiedOutput
    | PlatformStageReconciledOutput;
}

/**
 * Process-local, non-enumerable material spine for one run. It retains only
 * safe protocol structures, hashes and opaque references. Draft bodies and
 * protectedRef handles never enter this ledger.
 */
export class CourseAgentRunMaterialLedger {
  readonly #scope: { taskId: string; runId: string; courseAlias: string };
  readonly #protectedVault: CourseAgentProtectedMaterialVault;
  readonly #resolveSelectedArtifactVersion: ResolveSelectedArtifactVersion;
  readonly #selections = new Map<string, SelectionRecord>();
  readonly #integrities = new Map<string, IntegrityRecord>();
  readonly #pendingCompositions = new Map<string, PendingComposition>();
  readonly #compositions = new Map<string, CompositionRecord>();
  readonly #drafts = new Map<string, DraftRecord>();
  readonly #stages = new Map<string, StageRecord>();
  #hydratedCheckpoint: Readonly<{
    sourceHash: string;
    checkpointRef: string;
    sourceRunId: string;
    draftRecovery?: ReplyDraftRecoverySourceV2;
  }> | null = null;

  constructor(
    scope: { taskId: string; runId: string; courseAlias: string },
    protectedVault: CourseAgentProtectedMaterialVault,
    resolveSelectedArtifactVersion: ResolveSelectedArtifactVersion
  ) {
    this.#scope = Object.freeze({ ...scope });
    this.#protectedVault = protectedVault;
    this.#resolveSelectedArtifactVersion = resolveSelectedArtifactVersion;
  }

  bindPendingComposition(
    context: Readonly<ServerToolExecutionContext>,
    input: {
      material: VerifiedIntentCompositionMaterial;
      selectionRef: string;
      decisionId: string;
      stageTarget: CourseAgentStageTargetMaterial;
    }
  ): void {
    assertRuntimeScope(this.#scope, context);
    this.#pendingCompositions.set(
      context.callId,
      Object.freeze({ ...input, context: contextRecord(context) })
    );
  }

  hydrateVerifiedCheckpointSource(
    source: CourseAgentVerifiedCheckpointSource,
    context: Readonly<ServerToolExecutionContext>
  ): void {
    assertRuntimeScope(this.#scope, context);
    assertNoRestrictedMaterialKeys(
      checkpointPrivacyProjection(source),
      "COURSE_AGENT_CHECKPOINT_SOURCE_PRIVACY_BOUNDARY"
    );
    const checkpoint = source.sourceCheckpoint;
    const expectedCheckpointHash = checkpointHash(checkpoint);
    const childManifestHash = context.courseScope.manifestHash;
    if (
      !isSha256(checkpoint.manifestHash) ||
      !isSha256(childManifestHash) ||
      checkpoint.manifestHash !== childManifestHash
    ) {
      fail(
        "COURSE_AGENT_CHECKPOINT_MANIFEST_BINDING_MISMATCH",
        "Verified checkpoint recovery requires one exact source and child CourseManifest binding."
      );
    }
    if (
      source.schemaVersion !==
        COURSE_AGENT_VERIFIED_CHECKPOINT_SOURCE_SCHEMA_VERSION ||
      source.containsForumText !== false ||
      source.containsIdentity !== false ||
      source.containsSecrets !== false ||
      source.childTaskId !== this.#scope.taskId ||
      source.childRunId !== this.#scope.runId ||
      source.courseAlias !== this.#scope.courseAlias ||
      source.toolPolicyVersion !== context.policyVersion ||
      source.sourceTaskId !== this.#scope.taskId ||
      source.sourceRunId === this.#scope.runId ||
      !isSafeIdentifier(source.sourceRunId) ||
      checkpoint.schemaVersion !== COURSE_AGENT_CHECKPOINT_SCHEMA_VERSION ||
      checkpoint.taskId !== source.sourceTaskId ||
      checkpoint.runId !== source.sourceRunId ||
      checkpoint.toolPolicyVersion !== source.toolPolicyVersion ||
      checkpoint.containsForumText !== false ||
      checkpoint.containsIdentity !== false ||
      checkpoint.containsSecrets !== false ||
      checkpoint.checkpointHash !== expectedCheckpointHash ||
      checkpoint.checkpointRef !== `course-checkpoint:${expectedCheckpointHash}` ||
      checkpoint.compositionVersionRef !== source.composition.output.compositionRef ||
      checkpoint.compositionVersionRef !==
        source.composition.output.artifact.versionRef ||
      checkpoint.compositionContentHash !==
        source.composition.output.artifact.contentHash ||
      checkpoint.integrityVerificationRef !==
        source.integrity.output.integrityVerificationRef ||
      checkpoint.integrityVerificationRef !==
        source.composition.output.integrityVerificationRef ||
      !Number.isFinite(Date.parse(checkpoint.derivedAt)) ||
      Date.parse(checkpoint.derivedAt) > Date.parse(context.now)
    ) {
      fail(
        "COURSE_AGENT_CHECKPOINT_SOURCE_SCOPE_OR_HASH_MISMATCH",
        "Verified checkpoint source does not bind the parent and child scopes exactly."
      );
    }
    if (
      (checkpoint.state === "composition_verified" &&
        checkpoint.recoveryAction !== "regenerate_draft_and_reverify") ||
      (checkpoint.state === "draft_regeneration_required" &&
        checkpoint.recoveryAction !== "regenerate_draft_and_reverify") ||
      (checkpoint.state === "stage_unknown_requires_reconcile" &&
        checkpoint.recoveryAction !== "reconcile_stage_without_replay") ||
      (checkpoint.state === "stage_verified_delivery_ready" &&
        checkpoint.recoveryAction !== "create_delivery_bundle")
    ) {
      fail(
        "COURSE_AGENT_CHECKPOINT_SOURCE_STATE_MISMATCH",
        "Verified checkpoint state does not permit its requested recovery action."
      );
    }

    const parsedComposition = parseIntentOutput(
      source.composition.output as unknown as CourseToolJsonValue
    );
    const parsedIntegrity = parseOpportunityVerificationToolOutput(
      source.integrity.output as unknown as CourseToolJsonValue
    );
    const compositionEvidence = dedupeEvidenceRefs(
      source.composition.evidenceRefs
    );
    const compositionOutputEvidence = jsonEvidenceRefs(
      parsedComposition.evidenceRefs
    );
    const integrityEvidence = dedupeEvidenceRefs(source.integrity.evidenceRefs);
    const stageEvidence = dedupeEvidenceRefs(source.composition.stageTarget.evidenceRefs);
    if (
      uniqueManifestEvidenceHash(compositionEvidence) !== childManifestHash ||
      uniqueManifestEvidenceHash(compositionOutputEvidence) !== childManifestHash ||
      uniqueManifestEvidenceHash(stageEvidence) !== childManifestHash
    ) {
      fail(
        "COURSE_AGENT_CHECKPOINT_MANIFEST_BINDING_MISMATCH",
        "Checkpoint composition and STAGE evidence do not carry one exact CourseManifest hash."
      );
    }
    const integrityEvidenceRef = integrityEvidence.find(
      (ref) =>
        ref.kind === "verification" &&
        ref.id === parsedIntegrity.integrityVerificationRef
    );
    if (
      parsedIntegrity.status !== "eligible" ||
      parsedIntegrity.opportunityId !== source.composition.stageTarget.opportunityId ||
      source.composition.stageTarget.targetRef !==
        source.composition.stageTarget.opportunityId ||
      source.composition.stageTarget.decisionId !== source.composition.decisionId ||
      !isSafeIdentifier(source.composition.selectionRef) ||
      !isSafeIdentifier(source.composition.decisionId) ||
      !isSafeIdentifier(source.composition.stageTarget.threadKey) ||
      !isSha256(source.composition.stageTarget.eventSetHash) ||
      parsedComposition.toolPolicyVersion !== context.policyVersion ||
      parsedComposition.intentPolicyVersion !== LIVE_FACILITATION_POLICY_VERSION ||
      parsedComposition.intentHash !== canonicalProtocolHash(
        parsedComposition.intent.schemaVersion,
        parsedComposition.intent as CanonicalJsonValue
      ) ||
      parsedComposition.moveSpecHash !== canonicalProtocolHash(
        parsedComposition.moveSpec.schemaVersion,
        parsedComposition.moveSpec as CanonicalJsonValue
      ) ||
      parsedComposition.intent.evidenceRefHash !==
        parsedComposition.evidenceBindingHash ||
      Date.parse(parsedComposition.intent.candidateExpiresAt) <=
        Date.parse(context.now) ||
      source.composition.verifier.name !== "verification.facilitation_intent" ||
      source.composition.verifier.version !== "1" ||
      source.composition.verifier.status !== "passed" ||
      source.composition.verifier.subjectVersionRef !==
        parsedComposition.artifact.versionRef ||
      source.provenance.kind !== "verified_checkpoint" ||
      source.provenance.sourceCallId.length === 0 ||
      source.provenance.sourceCompositionVerificationId !==
        source.composition.verifier.reportId ||
      source.provenance.sourceIntegrityVerificationId !==
        source.integrity.verifier.reportId ||
      source.integrity.verifier.name !== OPPORTUNITY_INTEGRITY_VERIFIER_NAME ||
      source.integrity.verifier.version !==
        OPPORTUNITY_INTEGRITY_VERIFIER_VERSION ||
      source.integrity.verifier.status !== "passed" ||
      source.integrity.verifier.subjectRef !==
        parsedIntegrity.integrityVerificationRef ||
      !integrityEvidenceRef ||
      !compositionEvidence.some(
        (ref) =>
          ref.kind === "verification" &&
          ref.id === parsedIntegrity.integrityVerificationRef &&
          ref.hash === integrityEvidenceRef.hash
      ) ||
      !stageEvidence.some(
        (ref) =>
          ref.kind === "verification" &&
          ref.id === parsedIntegrity.integrityVerificationRef &&
          ref.hash === integrityEvidenceRef.hash
      )
    ) {
      fail(
        "COURSE_AGENT_CHECKPOINT_SOURCE_MATERIAL_MISMATCH",
        "Verified checkpoint composition, integrity, and provenance do not bind one source."
      );
    }
    if (
      source.draftRecovery &&
      (checkpoint.draftVersionRef !== source.draftRecovery.artifact.versionRef ||
        checkpoint.draftContentHash !== source.draftRecovery.artifact.contentHash ||
        checkpoint.draftBodyHash !== source.draftRecovery.artifact.draftBodyHash ||
        source.draftRecovery.composition.versionRef !==
          parsedComposition.compositionRef ||
        source.draftRecovery.composition.intentHash !==
          parsedComposition.intentHash ||
        source.draftRecovery.composition.moveSpecHash !==
          parsedComposition.moveSpecHash ||
        source.draftRecovery.composition.toolPolicyVersion !==
          context.policyVersion)
    ) {
      fail(
        "COURSE_AGENT_CHECKPOINT_DRAFT_RECOVERY_MISMATCH",
        "Draft recovery source is not bound to the verified checkpoint composition."
      );
    }

    const materialContext = contextRecord(context);
    const provenance = Object.freeze({
      ...source.provenance,
      sourceRunId: source.sourceRunId,
      checkpointRef: checkpoint.checkpointRef,
      checkpointHash: checkpoint.checkpointHash
    });
    const nextIntegrity: IntegrityRecord = Object.freeze({
      output: parsedIntegrity,
      context: materialContext,
      evidenceRefs: integrityEvidence,
      verifierReportId: source.integrity.verifier.reportId
    });
    const nextComposition: CompositionRecord = Object.freeze({
      output: parsedComposition,
      context: materialContext,
      selectionRef: source.composition.selectionRef,
      decisionId: source.composition.decisionId,
      stageTarget: Object.freeze({
        ...source.composition.stageTarget,
        evidenceRefs: stageEvidence
      }),
      evidenceRefs: compositionEvidence,
      provenance
    });
    const sourceHash = safeMaterialHash(
      source,
      "COURSE_AGENT_CHECKPOINT_SOURCE_INVALID"
    );
    const existingIntegrity = this.#integrities.get(
      parsedIntegrity.integrityVerificationRef
    );
    const existingComposition = this.#compositions.get(
      parsedComposition.compositionRef
    );
    if (
      (this.#hydratedCheckpoint &&
        this.#hydratedCheckpoint.sourceHash !== sourceHash) ||
      (existingIntegrity && !sameMaterial(existingIntegrity, nextIntegrity)) ||
      (existingComposition && !sameMaterial(existingComposition, nextComposition))
    ) {
      fail(
        "COURSE_AGENT_CHECKPOINT_SOURCE_CONFLICT",
        "A different verified checkpoint source is already bound to this child run."
      );
    }

    // Validate every candidate first, then commit the set together. No
    // fabricated CourseToolExecutionOutcome enters this cross-run path.
    this.#integrities.set(parsedIntegrity.integrityVerificationRef, nextIntegrity);
    this.#compositions.set(parsedComposition.compositionRef, nextComposition);
    this.#hydratedCheckpoint = Object.freeze({
      sourceHash,
      checkpointRef: checkpoint.checkpointRef,
      sourceRunId: source.sourceRunId,
      ...(source.draftRecovery
        ? { draftRecovery: source.draftRecovery }
        : {})
    });
  }

  recordToolOutcome(input: {
    toolName: string;
    outcome: CourseToolExecutionOutcome;
    context: Readonly<ServerToolExecutionContext>;
  }): void {
    assertRuntimeScope(this.#scope, input.context);
    if (input.outcome.result.status !== "succeeded") {
      this.#pendingCompositions.delete(input.context.callId);
      return;
    }
    const output = transientOutput(input.outcome);
    const materialContext = contextRecord(input.context);
    if (input.toolName === "opportunity.select_support_gap") {
      const parsed = parseOpportunitySelectionToolOutput(output);
      if (parsed.status !== "selected" || parsed.selectedOpportunityId === null) {
        // This is a valid terminal evidence result, not an execution error.
        // It simply creates no artifact-capable material for a later compose.
        return;
      }
      this.#selections.set(
        parsed.selectionRef,
        Object.freeze({
          output: parsed,
          context: materialContext,
          evidenceRefs: dedupeEvidenceRefs(input.outcome.result.evidenceRefs)
        })
      );
      return;
    }
    if (input.toolName === "evidence.verify_integrity") {
      const parsed = parseOpportunityVerificationToolOutput(output);
      if (parsed.status !== "eligible") {
        fail(
          "COURSE_AGENT_INTEGRITY_NOT_ELIGIBLE",
          "Opportunity integrity is not eligible for artifact composition."
        );
      }
      const verifierReportId = requirePassedVerification(
        input.outcome,
        parsed.integrityVerificationRef
      );
      this.#integrities.set(
        parsed.integrityVerificationRef,
        Object.freeze({
          output: parsed,
          context: materialContext,
          evidenceRefs: dedupeEvidenceRefs(input.outcome.result.evidenceRefs),
          verifierReportId
        })
      );
      return;
    }
    if (input.toolName === "facilitation.intent.compose") {
      const parsed = parseIntentOutput(output);
      const pending = this.#pendingCompositions.get(input.context.callId);
      this.#pendingCompositions.delete(input.context.callId);
      if (
        !pending ||
        parsed.selectionEvidenceBindingHash !==
          pending.material.selectionEvidenceBindingHash ||
        parsed.evidenceBindingHash !== pending.material.evidenceBindingHash ||
        parsed.integrityVerificationRef !==
          pending.material.integrityVerificationRef ||
        parsed.intentPolicyVersion !== pending.material.intentPolicyVersion ||
        parsed.toolPolicyVersion !== pending.material.toolPolicyVersion
      ) {
        fail(
          "COURSE_AGENT_COMPOSITION_PENDING_BINDING_MISMATCH",
          "Composition output does not match its verified pending material."
        );
      }
      requirePassedVerification(input.outcome, parsed.artifact.versionId);
      this.#compositions.set(
        parsed.compositionRef,
        Object.freeze({
          output: parsed,
          context: materialContext,
          selectionRef: pending.selectionRef,
          decisionId: pending.decisionId,
          stageTarget: pending.stageTarget,
          evidenceRefs: jsonEvidenceRefs(parsed.evidenceRefs)
        })
      );
      return;
    }
    if (
      input.toolName === "artifact.reply_draft.create" ||
      input.toolName === "artifact.reply_draft.regenerate"
    ) {
      const parsed = parseDraftOutput(output);
      const composition = this.#compositions.get(parsed.compositionRef);
      if (
        !composition ||
        parsed.intentHash !== composition.output.intentHash ||
        parsed.moveSpecHash !== composition.output.moveSpecHash ||
        parsed.integrityVerificationRef !== composition.output.integrityVerificationRef
      ) {
        fail(
          "COURSE_AGENT_DRAFT_COMPOSITION_MISMATCH",
          "Draft output is not bound to a verified composition."
        );
      }
      requirePassedVerification(input.outcome, parsed.artifact.versionId);
      this.#protectedVault.bind({
        taskId: input.context.taskId,
        runId: input.context.runId,
        artifactVersionRef: parsed.artifact.versionRef,
        protectedRef: parsed.artifact.protectedRef,
        draftBodyHash: parsed.artifact.draftBodyHash,
        expiresAt: parsed.artifact.expiresAt
      });
      this.#drafts.set(
        parsed.artifact.versionRef,
        Object.freeze({
          versionRef: parsed.artifact.versionRef,
          artifactRef: parsed.artifact.artifactRef,
          artifactId: parsed.artifact.artifactId,
          versionId: parsed.artifact.versionId,
          version: parsed.artifact.version,
          contentHash: parsed.artifact.contentHash,
          draftBodyHash: parsed.artifact.draftBodyHash,
          compositionRef: parsed.compositionRef,
          integrityVerificationRef: parsed.integrityVerificationRef,
          evidenceRefs: jsonEvidenceRefs(parsed.evidenceRefs),
          context: materialContext
        })
      );
      return;
    }
    if (
      input.toolName === "platform.editor.stage_verify_clear" ||
      input.toolName === "platform.editor.reconcile_stage"
    ) {
      const parsed = parseStageOutput(output);
      const verifierReportId = requirePassedVerification(
        input.outcome,
        parsed.stageTransactionRef
      );
      const evidenceRefs = jsonEvidenceRefs(parsed.evidenceRefs);
      const receiptEvidenceRef = evidenceRefs.find(
        (ref) =>
          ref.kind === "stage_receipt" &&
          ref.id === parsed.receiptRef &&
          ref.hash === parsed.receiptHash
      );
      if (!receiptEvidenceRef) {
        fail(
          "COURSE_AGENT_STAGE_RECEIPT_MISSING",
          "Verified STAGE output lacks its exact zero-publish receipt."
        );
      }
      this.#stages.set(
        parsed.receiptRef,
        Object.freeze({
          output: parsed,
          evidenceRefs,
          receiptEvidenceRef,
          context: materialContext,
          verifierReportId
        })
      );
    }
  }

  async resolveStageMaterial(input: {
    targetRef: string;
    artifactVersionRef?: string;
    now?: string;
  }): Promise<CourseAgentStageMaterialBinding | null> {
    if (!isSafeIdentifier(input.targetRef)) return null;
    if (input.artifactVersionRef !== undefined) {
      const draft = this.#drafts.get(input.artifactVersionRef);
      if (!draft) return null;
      const composition = this.#compositions.get(draft.compositionRef);
      if (!composition || composition.stageTarget.targetRef !== input.targetRef) {
        return null;
      }
      let selected = false;
      try {
        selected = await this.#resolveSelectedArtifactVersion({
          taskId: this.#scope.taskId,
          runId: this.#scope.runId,
          artifactId: draft.artifactId,
          versionId: draft.versionId,
          versionRef: draft.versionRef,
          contentHash: draft.contentHash,
          draftBodyHash: draft.draftBodyHash,
          now: input.now ?? new Date().toISOString()
        });
      } catch {
        return null;
      }
      if (!selected) return null;
      return Object.freeze({
        target: composition.stageTarget,
        artifactVersionRef: draft.versionRef,
        draftBodyHash: draft.draftBodyHash,
        integrityVerificationRef: draft.integrityVerificationRef
      });
    }
    const matches = [...this.#compositions.values()].filter(
      (composition) => composition.stageTarget.targetRef === input.targetRef
    );
    if (matches.length !== 1) return null;
    const composition = matches[0];
    return Object.freeze({
      target: composition.stageTarget,
      artifactVersionRef: null,
      draftBodyHash: null,
      integrityVerificationRef: composition.output.integrityVerificationRef
    });
  }

  selection(ref: string): SelectionRecord | null {
    return this.#selections.get(ref) ?? null;
  }

  integrity(ref: string): IntegrityRecord | null {
    return this.#integrities.get(ref) ?? null;
  }

  composition(ref: string): CompositionRecord | null {
    return this.#compositions.get(ref) ?? null;
  }

  draft(ref: string): DraftRecord | null {
    return this.#drafts.get(ref) ?? null;
  }

  stage(ref: string): StageRecord | null {
    return this.#stages.get(ref) ?? null;
  }

  verifiedDraftRecoverySource(): ReplyDraftRecoverySourceV2 | null {
    return this.#hydratedCheckpoint?.draftRecovery ?? null;
  }
}

export function createCourseAgentArtifactRuntime(
  options: CourseAgentArtifactRuntimeOptions
): {
  readonly schemaVersion: typeof COURSE_AGENT_ARTIFACT_RUNTIME_SCHEMA_VERSION;
  readonly materialLedger: CourseAgentRunMaterialLedger;
  readonly protectedMaterialVault: CourseAgentProtectedMaterialVault;
  readonly dependencies: FacilitationArtifactToolDependencies;
} {
  const db = options.prisma ?? defaultPrisma;
  const resolveContext = options.resolveCourseContext ?? resolveCourseContext;
  const listAdapter = options.listOpportunities ?? listOpportunities;
  const readAdapter = options.readOpportunityEvidence ?? readOpportunityEvidence;
  const selectAdapter = options.selectSupportGap ?? selectSupportGap;
  const loadDecision = options.loadDecision ?? defaultDecisionLoader(db);
  const protectedStore = options.protectedStore ?? new InMemoryProtectedArtifactStore();
  const protectedMaterialVault = new CourseAgentProtectedMaterialVault({
    taskId: options.taskId,
    runId: options.runId,
    protectedStore
  });
  const selectionDb = options.artifactDb ?? db;
  const resolveSelected =
    options.resolveSelectedArtifactVersion ??
    (async (binding: ArtifactVersionSelectionBinding & { readonly now: string }) =>
      Boolean(
        await resolveOrInitializeSelectedArtifactVersion(selectionDb, binding)
      ));
  const versionAdapter =
    options.createArtifactVersion ??
    createDurableFacilitationArtifactVersionAdapter(options.artifactDb ?? db);
  const materialLedger = new CourseAgentRunMaterialLedger(
    {
      taskId: options.taskId,
      runId: options.runId,
      courseAlias: options.courseAlias
    },
    protectedMaterialVault,
    resolveSelected
  );

  const composeIntent: FacilitationArtifactToolDependencies["composeIntent"] = async (
    input
  ) => {
    assertRuntimeScope(options, input.context);
    const selectionRecord = materialLedger.selection(input.selectionRef);
    const integrityRecord = materialLedger.integrity(input.integrityVerificationRef);
    if (!selectionRecord || !integrityRecord) {
      fail(
        "COURSE_AGENT_REQUIRED_MATERIAL_MISSING",
        "Exact selection and passed integrity material are required."
      );
    }
    assertSameMaterialContext(selectionRecord.context, input.context);
    assertSameMaterialContext(integrityRecord.context, input.context);
    const selectionOutput = selectionRecord.output;
    const integrityOutput = integrityRecord.output;
    if (
      selectionOutput.selectedOpportunityId === null ||
      integrityOutput.opportunityId !== selectionOutput.selectedOpportunityId ||
      integrityOutput.contextRef !== selectionOutput.contextRef ||
      integrityOutput.snapshotRef !== selectionOutput.snapshotRef ||
      integrityOutput.candidateSetCheck !== "passed" ||
      integrityOutput.targetProjectionCheck !== "passed" ||
      integrityOutput.targetPredicatesCheck !== "passed" ||
      integrityOutput.qualificationCheck !== "passed" ||
      !["passed", "not_required"].includes(integrityOutput.graphCheck) ||
      integrityOutput.policyCheck !== "passed" ||
      integrityOutput.limitationCode !== "none"
    ) {
      fail(
        "COURSE_AGENT_SELECTION_INTEGRITY_MISMATCH",
        "Selection and integrity verification do not bind one eligible opportunity."
      );
    }
    const resolved = await resolveContext({
      courseAlias: options.courseAlias,
      contextRef: selectionOutput.contextRef,
      prisma: db
    });
    if (
      resolved.anchor.courseAlias !== options.courseAlias ||
      resolved.anchor.snapshotId !== selectionOutput.snapshotRef ||
      resolved.anchor.candidateSetHash !== selectionOutput.candidateSetHash ||
      (input.context.courseScope.manifestHash !== undefined &&
        resolved.anchor.manifestHash !== input.context.courseScope.manifestHash)
    ) {
      fail(
        "COURSE_AGENT_EXACT_ANCHOR_CONFLICT",
        "Resolved course anchor conflicts with the recorded selection."
      );
    }
    const list = await listAdapter({ context: resolved, prisma: db });
    const replay = selectionBinding({
      list,
      selection: selectAdapter(list),
      toolPolicyVersion: input.context.policyVersion
    });
    assertExactSelection(selectionOutput, replay.output);
    const evidence = await readAdapter({
      context: resolved,
      opportunityId: selectionOutput.selectedOpportunityId,
      prisma: db
    });
    const verdict = verifyOpportunityIntegrity({
      evidence: (({ status: _status, limitations: _limitations, ...base }) => base)(evidence)
    });
    const expectedIntegrityRef = integrityReference(evidence, verdict.status);
    if (
      verdict.status !== "eligible" ||
      evidence.status !== "eligible" ||
      expectedIntegrityRef !== input.integrityVerificationRef ||
      evidence.qualification.decisionRef === null ||
      evidence.qualification.opportunityReceiptHash === null ||
      evidence.qualification.status !== "qualified" ||
      evidence.integrity.qualification !== "verified" ||
      evidence.policy.decision !== "draft" ||
      evidence.policy.reasonCodes.length !== 0
    ) {
      fail(
        "COURSE_AGENT_FRESH_INTEGRITY_REPLAY_FAILED",
        "Fresh exact opportunity replay is not eligible or changed its binding."
      );
    }
    const decisionId = evidence.qualification.decisionRef.replace(/^decision:/u, "");
    if (!isSafeIdentifier(decisionId)) {
      fail("COURSE_AGENT_DECISION_REF_INVALID", "Decision reference is invalid.");
    }
    const row = await loadDecision(decisionId);
    if (
      !row ||
      row.id !== decisionId ||
      row.opportunityReceiptHash !== evidence.qualification.opportunityReceiptHash
    ) {
      fail(
        "COURSE_AGENT_DECISION_NOT_FOUND",
        "Exact selected opportunity has no matching persisted decision."
      );
    }
    const verified = parseDecisionSummary(row, evidence, input.context);
    const evidenceRefs = coreOpportunityEvidenceRefs(
      evidence,
      input.integrityVerificationRef
    );
    if (
      !isSafeIdentifier(evidence.opportunityId) ||
      !isSafeIdentifier(evidence.candidateKey) ||
      !isSafeIdentifier(row.threadKey) ||
      !isSha256(evidence.target.targetVersionHash) ||
      !isSha256(row.opportunityReceiptHash) ||
      !isSha256(row.observationReceiptHash)
    ) {
      fail(
        "COURSE_AGENT_STAGE_TARGET_BINDING_INVALID",
        "Verified opportunity cannot form a safe exact platform target binding."
      );
    }
    const stageTarget: CourseAgentStageTargetMaterial = Object.freeze({
      targetRef: evidence.opportunityId,
      opportunityId: evidence.opportunityId,
      candidateKey: evidence.candidateKey,
      decisionId,
      threadKey: row.threadKey,
      targetVersionHash: evidence.target.targetVersionHash,
      eventSetHash: verified.revalidationReceipt.eventSetHash,
      opportunityReceiptHash: row.opportunityReceiptHash,
      revalidationReceiptHash: verified.revalidationReceiptHash,
      afterObservationReceiptHash:
        verified.revalidationReceipt.afterObservationReceiptHash,
      evidenceRefs
    });
    const material: VerifiedIntentCompositionMaterial = Object.freeze({
      selectionRef: input.selectionRef,
      selectionEvidenceBindingHash: replay.output.evidenceBindingHash,
      integrityVerificationRef: input.integrityVerificationRef,
      integrityStatus: "passed",
      intentPolicyVersion: LIVE_FACILITATION_POLICY_VERSION,
      toolPolicyVersion: input.context.policyVersion,
      evidenceBindingHash: verified.evidenceBindingHash,
      intent: verified.intent,
      moveSpec: verified.moveSpec,
      evidenceRefs,
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false
    });
    materialLedger.bindPendingComposition(input.context, {
      material,
      selectionRef: input.selectionRef,
      decisionId,
      stageTarget
    });
    return material;
  };

  const renderDraft: FacilitationArtifactToolDependencies["renderDraft"] = async (
    input
  ): Promise<RenderedFacilitationDraftMaterial> => {
    assertRuntimeScope(options, input.context);
    const composition = materialLedger.composition(input.compositionRef);
    if (!composition) {
      fail(
        "COURSE_AGENT_COMPOSITION_NOT_FOUND",
        "Verified composition is unavailable in this run."
      );
    }
    assertSameMaterialContext(composition.context, input.context);
    if (
      input.revisionKind !== "initial" ||
      input.priorVersionRef !== null ||
      input.feedbackRef !== null
    ) {
      fail(
        "COURSE_AGENT_CORRECTION_RECIPE_UNAVAILABLE",
        "Correction requires a separately verified feedback-bound renderer recipe."
      );
    }
    const row = await loadDecision(composition.decisionId);
    if (!row) {
      fail("COURSE_AGENT_DECISION_NOT_FOUND", "Composition decision is unavailable.");
    }
    const output = composition.output;
    const intent = parseProtocolObject("interventionIntent", output.intent);
    const moveSpec = parseProtocolObject("facilitationMoveSpec", output.moveSpec);
    if (
      row.intentHash !== output.intentHash ||
      row.moveSpecHash !== output.moveSpecHash ||
      row.draftContentHash === null ||
      intent.policyVersion !== LIVE_FACILITATION_POLICY_VERSION ||
      output.intentPolicyVersion !== LIVE_FACILITATION_POLICY_VERSION ||
      output.toolPolicyVersion !== input.context.policyVersion ||
      Date.parse(intent.candidateExpiresAt) <= Date.parse(input.context.now)
    ) {
      fail(
        "COURSE_AGENT_COMPOSITION_STALE",
        "Composition is stale or conflicts with its persisted decision."
      );
    }
    const summary = asRecord(
      JSON.parse(row.decisionJson) as unknown,
      "COURSE_AGENT_DECISION_JSON_INVALID"
    );
    const semanticReceipt = parseSemanticReceipt(summary.semanticReceipt);
    if (
      typeof summary.semanticReceiptHash !== "string" ||
      semanticReceipt.contentHash !== row.draftContentHash ||
      semanticReceipt.intentHash !== output.intentHash ||
      semanticReceipt.moveSpecHash !== output.moveSpecHash
    ) {
      fail(
        "COURSE_AGENT_RENDER_RECIPE_MISMATCH",
        "Deterministic renderer recipe conflicts with the composition."
      );
    }
    const body = rebuildDeterministicSemanticDraft({
      intent,
      moveSpec,
      intentHash: output.intentHash,
      moveSpecHash: output.moveSpecHash,
      expectedContentHash: row.draftContentHash
    });
    const rendered: RenderedFacilitationDraftMaterial = {
      compositionRef: input.compositionRef,
      logicalDraftKey: `support-gap-draft:${composition.decisionId}`,
      intent,
      intentHash: output.intentHash,
      moveSpec,
      moveSpecHash: output.moveSpecHash,
      integrityVerificationRef: output.integrityVerificationRef,
      intentPolicyVersion: LIVE_FACILITATION_POLICY_VERSION,
      toolPolicyVersion: input.context.policyVersion,
      evidenceRefs: composition.evidenceRefs,
      renderer: {
        version: SEMANTIC_RENDERER_VERSION,
        receiptRef: `semantic-renderer-receipt:${summary.semanticReceiptHash}`,
        receiptHash: summary.semanticReceiptHash,
        inputContainsForumText: false as const,
        inputContainsIdentity: false as const,
        inputContainsSecrets: false as const
      },
      body,
      resolvedPriorVersionRef: null,
      resolvedFeedbackRef: null,
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false
    };
    return Object.freeze(rendered);
  };

  const resolveDeliveryInputs: FacilitationArtifactToolDependencies["resolveDeliveryInputs"] =
    async (input): Promise<DeliveryBundleResolvedInputs> => {
      assertRuntimeScope(options, input.context);
      const draft = materialLedger.draft(input.draftVersionRef);
      const integrity = materialLedger.integrity(input.integrityVerificationRef);
      const stage = materialLedger.stage(input.stageVerificationRef);
      if (!draft || !integrity || !stage) {
        fail(
          "COURSE_AGENT_DELIVERY_MATERIAL_MISSING",
          "Delivery requires exact draft, integrity, and STAGE material from this run."
        );
      }
      assertSameMaterialContext(draft.context, input.context);
      assertSameMaterialContext(integrity.context, input.context);
      assertSameMaterialContext(stage.context, input.context);
      if (
        draft.integrityVerificationRef !== input.integrityVerificationRef ||
        stage.output.receiptRef !== input.stageVerificationRef ||
        stage.output.artifactVersionRef !== input.draftVersionRef ||
        stage.output.draftBodyHash !== draft.draftBodyHash
      ) {
        fail(
          "COURSE_AGENT_DELIVERY_BINDING_MISMATCH",
          "Delivery material does not bind one draft, integrity replay, and cleared STAGE receipt."
        );
      }
      const resolved: DeliveryBundleResolvedInputs = {
        draft: {
          versionRef: draft.versionRef,
          artifactRef: draft.artifactRef,
          artifactId: draft.artifactId,
          versionId: draft.versionId,
          version: draft.version,
          contentClass: "restricted_transient" as const,
          contentHash: draft.contentHash,
          draftBodyHash: draft.draftBodyHash,
          status: "validated" as const,
          evidenceRefs: draft.evidenceRefs
        },
        integrity: {
          ref: input.integrityVerificationRef,
          status: "passed" as const,
          evidenceRefs: integrity.evidenceRefs
        },
        stageVerification: {
          ref: input.stageVerificationRef,
          status: "passed" as const,
          subjectType: "stage_transaction" as const,
          artifactVersionRef: stage.output.artifactVersionRef,
          draftBodyHash: stage.output.draftBodyHash,
          clearVerified: true,
          editorEmptyAfter: true,
          submitMutationCount: 0,
          sendMutationCount: 0,
          realPublishEnabled: false,
          bodyPersisted: false,
          observedAt: stage.output.observedAt,
          receiptEvidenceRef: stage.receiptEvidenceRef
        },
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false
      };
      return Object.freeze(resolved);
    };

  const resolveVerifiedDraftRecoveryMaterial: NonNullable<
    FacilitationArtifactToolDependencies["resolveVerifiedDraftRecoveryMaterial"]
  > = async ({ context }) => {
    assertRuntimeScope(options, context);
    if (options.verifiedCheckpointSource) {
      materialLedger.hydrateVerifiedCheckpointSource(
        options.verifiedCheckpointSource,
        context
      );
    }
    const source = materialLedger.verifiedDraftRecoverySource();
    if (!source) {
      fail(
        "COURSE_AGENT_DRAFT_RECOVERY_SOURCE_MISSING",
        "No verified checkpoint draft recovery source is bound to this run."
      );
    }
    return source;
  };

  return Object.freeze({
    schemaVersion: COURSE_AGENT_ARTIFACT_RUNTIME_SCHEMA_VERSION,
    materialLedger,
    protectedMaterialVault,
    dependencies: Object.freeze({
      composeIntent,
      renderDraft,
      resolveDeliveryInputs,
      resolveVerifiedDraftRecoveryMaterial,
      protectedStore,
      createArtifactVersion: versionAdapter,
      ...(options.protectedDraftTtlMs !== undefined
        ? { protectedDraftTtlMs: options.protectedDraftTtlMs }
        : {})
    })
  });
}
