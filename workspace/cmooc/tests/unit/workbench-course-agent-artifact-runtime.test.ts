import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CANONICAL_HASH_ALGORITHM,
  PROTOCOL_SCHEMA_VERSIONS,
  canonicalProtocolHash,
  parseProtocolObject,
  type CanonicalJsonValue
} from "../../lib/facilitation-protocol";
import {
  AUTONOMY_DRAFT_REVALIDATION_SCHEMA_VERSION,
  type AutonomyDraftRevalidationReceipt
} from "../../lib/autonomy/draft-revalidation";
import {
  SEMANTIC_RENDERER_CONTRACT_VERSION,
  SEMANTIC_RENDERER_RECEIPT_SCHEMA_VERSION,
  SEMANTIC_RENDERER_VERSION,
  type SemanticRendererReceipt
} from "../../lib/autonomy/semantic-renderer";
import {
  LIVE_BUDGET_POLICY_VERSION,
  LIVE_DRAFT_GENERATOR_VERSION,
  LIVE_FACILITATION_POLICY_VERSION,
  LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION,
  buildDeterministicFacilitationDraft
} from "../../lib/live-runtime/facilitation-kernel";
import { hashTransientDraftBody } from "../../lib/live-runtime/draft-content";
import {
  COURSE_TOOL_VERIFICATION_SCHEMA_VERSION,
  hashCourseToolValue,
  type CourseToolExecutionOutcome,
  type CourseToolJsonValue,
  type CourseToolVerificationReport,
  type DurableToolCallProjection,
  type EvidenceRef,
  type ServerToolExecutionContext,
  type ToolExecutionResult
} from "../../lib/course-tools/contracts";
import {
  OPPORTUNITY_INTEGRITY_REF_SCHEMA_VERSION,
  OPPORTUNITY_INTEGRITY_VERIFIER_NAME,
  SUPPORT_GAP_EVIDENCE_BINDING_SCHEMA_VERSION,
  SUPPORT_GAP_SELECTION_POLICY_VERSION,
  SUPPORT_GAP_SELECTION_REF_SCHEMA_VERSION,
  type OpportunitySelectionToolOutput,
  type OpportunityVerificationToolOutput
} from "../../lib/course-tools/tools/register-evidence-tools";
import { COURSE_TOOL_POLICY_VERSION } from "../../lib/course-tools/policy-gateway";
import type {
  OpportunityListResult,
  SupportGapOpportunityEvidence
} from "../../lib/course-tools/tools/opportunity-evidence";
import type { ResolvedCourseContext } from "../../lib/course-tools/tools/course-context";
import {
  createFacilitationArtifactToolRegistrations,
  type ArtifactVersionPointer,
  type FacilitationArtifactVersionWrite,
  type FacilitationIntentComposeOutput,
  type ReplyDraftCreateOutput
} from "../../lib/course-tools/tools/facilitation-artifacts";
import {
  PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
  type PlatformStageReconciledOutput
} from "../../lib/course-tools/tools/platform-stage";
import {
  hashPersistedEvidenceQualification,
  PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION,
  type PersistedEvidenceQualification
} from "../../lib/workbench/course-evidence-workspace";
import { InMemoryProtectedArtifactStore } from "../../lib/workbench/protected-artifact-store";
import {
  CourseAgentArtifactRuntimeError,
  COURSE_AGENT_VERIFIED_CHECKPOINT_SOURCE_SCHEMA_VERSION,
  createCourseAgentArtifactRuntime,
  loadVerifiedCourseAgentRecoveryDecisionMaterial,
  type CourseAgentArtifactDecisionRow,
  type CourseAgentVerifiedCheckpointSource
} from "../../lib/workbench/course-agent-artifact-runtime";

const NOW = "2026-08-12T12:00:00.000Z";
const DEADLINE = "2026-08-12T12:05:00.000Z";
const COURSE_ALIAS = "course-fixture";
const TASK_ID = "task-artifact-runtime";
const RUN_ID = "run-artifact-runtime";
const TOOL_POLICY_VERSION = "cmooc.course-tool.policy.v1";
const INVOCATION_ID = "invocation-fixture";
const SNAPSHOT_ID = "snapshot-fixture";
const DECISION_ID = "decision-fixture";

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function context(
  callId: string,
  overrides: Partial<
    Pick<ServerToolExecutionContext, "taskId" | "runId" | "policyVersion">
  > = {}
): ServerToolExecutionContext {
  return {
    callId,
    taskId: overrides.taskId ?? TASK_ID,
    runId: overrides.runId ?? RUN_ID,
    planRevisionId: "plan-artifact-runtime",
    stepId: `step-${callId}`,
    courseScope: {
      courseId: COURSE_ALIAS,
      alias: COURSE_ALIAS,
      manifestHash: sha("manifest")
    },
    intent: "implement",
    baseCapability: "L1_ARTIFACT",
    capabilityGrantRefs: [],
    policyVersion: overrides.policyVersion ?? TOOL_POLICY_VERSION,
    now: NOW,
    deadlineAt: DEADLINE,
    idempotencyKey: `idem-${callId}`,
    attempt: 1,
    executionLeaseId: `lease-${callId}`,
    leaseGeneration: 1,
    fencingToken: `fence-${callId}-0123456789abcdef`
  };
}

function evidenceRef<K extends EvidenceRef["kind"]>(
  kind: K,
  id: string,
  hash = sha(`${kind}:${id}`)
): EvidenceRef &
  { readonly kind: K } &
  Readonly<Record<string, CourseToolJsonValue>> {
  return Object.freeze({ kind, id, hash, observedAt: NOW }) as EvidenceRef &
    { readonly kind: K } &
    Readonly<Record<string, CourseToolJsonValue>>;
}

const anchor: ResolvedCourseContext["anchor"] = {
  courseAlias: COURSE_ALIAS,
  invocationId: INVOCATION_ID,
  snapshotId: SNAPSHOT_ID,
  manifestHash: sha("manifest"),
  worldHash: sha("world"),
  eventSetHash: sha("events"),
  coverageHash: sha("coverage"),
  candidateSetHash: sha("candidate-set"),
  worldAsOf: NOW
};

const resolvedContext: ResolvedCourseContext = {
  schemaVersion: "cmooc.course-tool.course-context.v1",
  status: "resolved",
  anchor,
  evidenceRefs: [
    evidenceRef("manifest", COURSE_ALIAS, anchor.manifestHash),
    evidenceRef("invocation", INVOCATION_ID, anchor.manifestHash),
    evidenceRef("snapshot", SNAPSHOT_ID, anchor.worldHash),
    evidenceRef("coverage", "coverage-fixture", anchor.coverageHash),
    evidenceRef("candidate", `${INVOCATION_ID}:candidate-set`, anchor.candidateSetHash)
  ],
  containsForumText: false,
  containsIdentity: false
};

function buildFixture() {
  const candidateKey = sha("candidate");
  const opportunityId = `support-gap:${candidateKey}`;
  const targetVersionHash = sha("target-version");
  const observationReceiptHash = sha("observation-receipt");
  const historyCutoffHash = sha("history-cutoff");
  const historyEvidenceHash = sha("history-evidence");
  const qualification: PersistedEvidenceQualification = {
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
  const intentEvidenceBindingHash = canonicalProtocolHash(
    "cmooc.live-qualified-evidence-ref.v1",
    {
      schemaVersion: "cmooc.live-qualified-evidence-ref.v1",
      observationReceiptHash,
      historyCutoffHash,
      historyEvidenceHash,
      targetVersionHash,
      eventSetHash: anchor.eventSetHash,
      assessedAt: NOW,
      qualification,
      containsForumText: false
    }
  );
  const intent = parseProtocolObject("interventionIntent", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.interventionIntent,
    evidenceRefHash: intentEvidenceBindingHash,
    evidenceAsOf: NOW,
    intervene: true,
    facilitationFunction: "cognitive_conflict",
    targetObject: "thread_author",
    workloadCost: 1,
    candidateExpiresAt: "2026-08-12T12:30:00.000Z",
    withdrawalConditions: [
      "external_human_response",
      "source_censored",
      "candidate_expired",
      "budget_unavailable",
      "target_version_changed",
      "author_cooldown_active"
    ],
    policyVersion: LIVE_FACILITATION_POLICY_VERSION,
    budgetVersion: LIVE_BUDGET_POLICY_VERSION,
    hashAlgorithm: CANONICAL_HASH_ALGORITHM,
    containsForumText: false
  });
  const intentHash = canonicalProtocolHash(
    intent.schemaVersion,
    intent as CanonicalJsonValue
  );
  const moveSpec = parseProtocolObject("facilitationMoveSpec", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.facilitationMoveSpec,
    intentHash,
    needState: "conceptual_tension",
    mechanismTarget: "surface_explanatory_tension",
    facilitationMove: "pose_counterexample_and_request_explanation",
    targetObject: "thread_author",
    requiredContentElements: ["boundary_question", "counterexample_invitation"],
    prohibitedMoves: [
      "answer_on_behalf_of_learner",
      "identity_ranking",
      "stable_personality_judgment",
      "diagnostic_mental_state_claim",
      "unverifiable_learning_effect_claim"
    ],
    observableSuccessCriteria: [
      "external_human_response",
      "reply_chain_extension",
      "explanatory_revision"
    ],
    specVersion: "cmooc.live-move-spec.v1",
    containsForumText: false
  });
  const moveSpecHash = canonicalProtocolHash(
    moveSpec.schemaVersion,
    moveSpec as CanonicalJsonValue
  );
  const draftBody = buildDeterministicFacilitationDraft("cognitive_conflict");
  const draftContentHash = hashTransientDraftBody(draftBody);
  const opportunityReceiptHash = sha("opportunity-receipt");
  const semanticReceipt: SemanticRendererReceipt = {
    schemaVersion: SEMANTIC_RENDERER_RECEIPT_SCHEMA_VERSION,
    rendererVersion: SEMANTIC_RENDERER_VERSION,
    contractVersion: SEMANTIC_RENDERER_CONTRACT_VERSION,
    provider: "local_deterministic",
    model: "facilitation_template_v1",
    decision: "draft",
    decisionMode: "DRAFT_ELIGIBLE",
    resolution: "deterministic_fallback",
    fallbackReason: "generator_unavailable",
    modelInvoked: false,
    modelOutputAccepted: false,
    opportunityReceiptHash,
    evidenceAsOf: NOW,
    observationReceiptHash,
    historyCutoffHash,
    historyEvidenceHash,
    eventSetHash: anchor.eventSetHash,
    targetVersionHash,
    selectedFunction: "cognitive_conflict",
    targetObject: "thread_author",
    intentHash,
    moveSpecHash,
    contentHash: draftContentHash,
    bodyPersisted: false,
    containsForumText: false
  };
  const semanticReceiptHash = canonicalProtocolHash(
    semanticReceipt.schemaVersion,
    semanticReceipt as unknown as CanonicalJsonValue
  );
  const revalidationReceipt: AutonomyDraftRevalidationReceipt = {
    schemaVersion: AUTONOMY_DRAFT_REVALIDATION_SCHEMA_VERSION,
    opportunityReceiptHash,
    beforeObservationReceiptHash: observationReceiptHash,
    afterObservationReceiptHash: sha("after-observation"),
    checkedAt: NOW,
    targetVersionHash,
    eventSetHash: anchor.eventSetHash,
    rereadObserved: true,
    newlyObservedExternalHumanEventCount: 0,
    newlyObservedDistinctActorEventCount: 0,
    newlyObservedAuthorEventCount: 0,
    newlyObservedSystemEventCount: 0,
    removedPreviouslyObservedEventCount: 0,
    changedPreviouslyObservedEventCount: 0,
    decision: "EXECUTE",
    reasonCode: "stable_no_human_response",
    shadowContinuationAllowed: true,
    editorWriteAllowed: false,
    publishAllowed: false,
    containsForumText: false
  };
  const revalidationReceiptHash = canonicalProtocolHash(
    revalidationReceipt.schemaVersion,
    revalidationReceipt as unknown as CanonicalJsonValue
  );
  const qualificationHash = hashPersistedEvidenceQualification({
    opportunityReceiptHash,
    qualification
  });
  const evidenceBundleHash = sha("evidence-bundle");
  const decisionSummary = {
    schemaVersion: "cmooc.autonomy-decision-summary.v1",
    candidateKey,
    decision: "draft",
    decisionMode: "DRAFT_ELIGIBLE",
    reasonCode: "draft_eligible",
    observationReceiptHash,
    opportunityReceiptHash,
    opportunityReceiptSchemaVersion: LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION,
    qualification,
    qualificationHash,
    qualificationSchemaVersion: PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION,
    evidenceBundleHash,
    intent,
    intentHash,
    moveSpec,
    moveSpecHash,
    draftContentHash,
    semanticReceipt,
    semanticReceiptHash,
    revalidationReceipt,
    revalidationReceiptHash,
    draftBodyPersisted: false,
    publishAttempted: false,
    editorWriteAttempted: false,
    containsForumText: false
  };
  const decision: CourseAgentArtifactDecisionRow = {
    id: DECISION_ID,
    invocationId: INVOCATION_ID,
    courseAlias: COURSE_ALIAS,
    threadKey: "thread-fixture",
    decision: "draft",
    decisionMode: "DRAFT_ELIGIBLE",
    reasonCode: "draft_eligible",
    observationReceiptHash,
    opportunityReceiptHash,
    evidenceBundleHash,
    intentHash,
    moveSpecHash,
    draftContentHash,
    policyVersion: LIVE_FACILITATION_POLICY_VERSION,
    worldHash: anchor.worldHash,
    candidateSetHash: anchor.candidateSetHash,
    evidenceAsOf: new Date(NOW),
    decisionJson: JSON.stringify(decisionSummary),
    bodyPersisted: false,
    publishAttempted: false,
    editorWriteAttempted: false,
    semanticRealization: {
      rendererKind: "deterministic_fallback",
      rendererVersion: SEMANTIC_RENDERER_VERSION,
      contractVersion: SEMANTIC_RENDERER_CONTRACT_VERSION,
      contentHash: draftContentHash,
      validationJson: JSON.stringify({
        schemaVersion: "cmooc.semantic-realization-validation.v1",
        targetBound: true,
        intentBound: true,
        moveSpecBound: true,
        semanticReceiptHash,
        modelInvoked: false,
        modelOutputAccepted: false,
        bodyPersisted: false,
        containsForumText: false
      }),
      bodyPersisted: false
    }
  };
  const opportunity: SupportGapOpportunityEvidence = {
    schemaVersion: "cmooc.course-tool.opportunity-evidence.v1",
    opportunityId,
    kind: "support_gap",
    candidateKey,
    exactAnchor: anchor,
    claim: { kind: "mature_support_gap", contentGraphRequired: false },
    target: {
      targetVersionHash,
      stateHash: sha("thread-state"),
      supportGapHours: 96,
      predicates: [
        { code: "candidate_target_bound", status: "passed", safeValue: true },
        { code: "target_state_hash_valid", status: "passed", safeValue: true },
        { code: "target_complete", status: "passed", safeValue: "complete" },
        { code: "support_gap_mature", status: "passed", safeValue: 96 },
        { code: "no_external_human_response", status: "passed", safeValue: 0 },
        { code: "no_distinct_actor_response", status: "passed", safeValue: 0 },
        { code: "no_author_return", status: "passed", safeValue: 0 },
        { code: "no_system_response", status: "passed", safeValue: 0 }
      ]
    },
    qualification: {
      status: "qualified",
      decisionRef: `decision:${DECISION_ID}`,
      opportunityReceiptHash,
      waterfall: {
        status: "qualified",
        headline: "qualified",
        stopAt: null,
        missing: [],
        stages: []
      }
    },
    graphIntegrity: {
      status: "unavailable",
      reasonCode: "content_graph_missing",
      contentGraphHash: null,
      nodeSetHash: null,
      edgeSetHash: null,
      nodeCount: null,
      edgeCount: null,
      learnerNodeCount: null,
      requiredForClaim: false
    },
    policy: { decision: "draft", reasonCodes: [] },
    integrity: {
      candidateSet: "verified",
      targetProjection: "verified",
      qualification: "verified"
    },
    status: "eligible",
    limitations: [],
    evidenceRefs: [
      ...resolvedContext.evidenceRefs,
      {
        kind: "target_projection",
        id: candidateKey,
        hash: sha("thread-state"),
        observedAt: NOW
      },
      {
        kind: "qualification",
        id: `decision:${DECISION_ID}`,
        hash: opportunityReceiptHash,
        observedAt: NOW
      }
    ],
    containsForumText: false,
    containsIdentity: false
  };
  const list: OpportunityListResult = {
    schemaVersion: "cmooc.course-tool.opportunity-list.v1",
    status: "ready",
    outcome: "opportunities_available",
    exactAnchor: anchor,
    sourceCompleteness: {
      coverageReceiptVerified: true,
      courseCoverageComplete: true,
      candidateSetVerified: true,
      allCandidateTargetsAccountedFor: true
    },
    totalCandidateCount: 1,
    items: [opportunity],
    limitations: [],
    containsForumText: false,
    containsIdentity: false
  };
  const selectionReason = "mature_support_gap_highest_age_then_candidate_key" as const;
  const selectionEvidenceBindingHash = canonicalProtocolHash(
    SUPPORT_GAP_EVIDENCE_BINDING_SCHEMA_VERSION,
    {
      schemaVersion: SUPPORT_GAP_EVIDENCE_BINDING_SCHEMA_VERSION,
      contextRef: `snapshot:${SNAPSHOT_ID}`,
      invocationRef: INVOCATION_ID,
      snapshotRef: SNAPSHOT_ID,
      worldHash: anchor.worldHash,
      eventSetHash: anchor.eventSetHash,
      coverageHash: anchor.coverageHash,
      candidateSetHash: anchor.candidateSetHash,
      toolPolicyVersion: TOOL_POLICY_VERSION,
      selectionPolicyVersion: SUPPORT_GAP_SELECTION_POLICY_VERSION,
      selectedOpportunityId: opportunityId,
      reasonCode: selectionReason
    }
  );
  const selectionHash = canonicalProtocolHash(
    SUPPORT_GAP_SELECTION_REF_SCHEMA_VERSION,
    {
      schemaVersion: SUPPORT_GAP_SELECTION_REF_SCHEMA_VERSION,
      evidenceBindingHash: selectionEvidenceBindingHash,
      status: "selected",
      selectedOpportunityId: opportunityId,
      reasonCode: selectionReason,
      exclusions: []
    }
  );
  const selection: OpportunitySelectionToolOutput = {
    schemaVersion: "cmooc.course-tool.opportunity-selection-output.v1",
    status: "selected",
    contextRef: `snapshot:${SNAPSHOT_ID}`,
    snapshotRef: SNAPSHOT_ID,
    asOf: NOW,
    candidateSetHash: anchor.candidateSetHash,
    selectionRef: `support-gap-selection:${selectionHash}`,
    evidenceBindingHash: selectionEvidenceBindingHash,
    selectionPolicyVersion: SUPPORT_GAP_SELECTION_POLICY_VERSION,
    selectedOpportunityId: opportunityId,
    reasonCode: selectionReason,
    exclusions: []
  };
  const integrityHash = canonicalProtocolHash(
    OPPORTUNITY_INTEGRITY_REF_SCHEMA_VERSION,
    {
      schemaVersion: OPPORTUNITY_INTEGRITY_REF_SCHEMA_VERSION,
      contextRef: `snapshot:${SNAPSHOT_ID}`,
      invocationRef: INVOCATION_ID,
      snapshotRef: SNAPSHOT_ID,
      worldHash: anchor.worldHash,
      eventSetHash: anchor.eventSetHash,
      coverageHash: anchor.coverageHash,
      candidateSetHash: anchor.candidateSetHash,
      opportunityId,
      claim: "mature_support_gap",
      status: "eligible",
      evidenceHashes: [...new Set(opportunity.evidenceRefs.map((ref) => ref.hash))].sort()
    }
  );
  const integrity: OpportunityVerificationToolOutput = {
    schemaVersion: "cmooc.course-tool.opportunity-verification-output.v1",
    status: "eligible",
    contextRef: `snapshot:${SNAPSHOT_ID}`,
    snapshotRef: SNAPSHOT_ID,
    opportunityId,
    integrityVerificationRef: `integrity-verification:${integrityHash}`,
    claim: "mature_support_gap",
    candidateSetCheck: "passed",
    targetProjectionCheck: "passed",
    targetPredicatesCheck: "passed",
    qualificationCheck: "passed",
    graphCheck: "not_required",
    policyCheck: "passed",
    limitationCode: "none",
    evidenceRefCount: opportunity.evidenceRefs.length
  };
  return {
    opportunity,
    list,
    decision,
    selection,
    integrity,
    draftBody,
    draftContentHash,
    intentEvidenceBindingHash,
    selectionEvidenceBindingHash,
    semanticReceiptHash,
    revalidationReceipt,
    revalidationReceiptHash,
    intent,
    intentHash,
    moveSpec,
    moveSpecHash
  };
}

test("server-only recovery decision helper reuses the ordinary strict decision verifier", async () => {
  const fixture = buildFixture();
  const material = await loadVerifiedCourseAgentRecoveryDecisionMaterial({
    db: {} as Parameters<
      typeof loadVerifiedCourseAgentRecoveryDecisionMaterial
    >[0]["db"],
    courseAlias: COURSE_ALIAS,
    snapshotId: SNAPSHOT_ID,
    decisionId: DECISION_ID,
    toolPolicyVersion: COURSE_TOOL_POLICY_VERSION,
    now: NOW,
    resolveContext: async () => resolvedContext,
    readOpportunity: async () => fixture.opportunity,
    loadDecision: async () => fixture.decision
  });

  assert.deepEqual(material, {
    decisionId: DECISION_ID,
    threadKey: fixture.decision.threadKey,
    candidateKey: fixture.opportunity.candidateKey,
    opportunityId: fixture.opportunity.opportunityId,
    targetVersionHash: fixture.opportunity.target.targetVersionHash,
    eventSetHash: fixture.opportunity.exactAnchor.eventSetHash,
    opportunityReceiptHash: fixture.decision.opportunityReceiptHash,
    integrityVerificationRef:
      fixture.integrity.integrityVerificationRef,
    revalidationReceiptHash: fixture.revalidationReceiptHash,
    afterObservationReceiptHash:
      fixture.revalidationReceipt.afterObservationReceiptHash,
    intentHash: fixture.intentHash,
    moveSpecHash: fixture.moveSpecHash,
    evidenceBindingHash: fixture.intentEvidenceBindingHash
  });
  assert.equal(JSON.stringify(material).includes("decisionJson"), false);
});

test("server-only recovery decision helper rejects tampered revalidation through the shared verifier", async () => {
  const fixture = buildFixture();
  const summary = JSON.parse(fixture.decision.decisionJson) as Record<
    string,
    unknown
  >;
  summary.revalidationReceipt = {
    ...(summary.revalidationReceipt as Record<string, unknown>),
    newlyObservedExternalHumanEventCount: 1
  };
  const tampered = {
    ...fixture.decision,
    decisionJson: JSON.stringify(summary)
  };

  await assert.rejects(
    loadVerifiedCourseAgentRecoveryDecisionMaterial({
      db: {} as Parameters<
        typeof loadVerifiedCourseAgentRecoveryDecisionMaterial
      >[0]["db"],
      courseAlias: COURSE_ALIAS,
      snapshotId: SNAPSHOT_ID,
      decisionId: DECISION_ID,
      toolPolicyVersion: COURSE_TOOL_POLICY_VERSION,
      now: NOW,
      resolveContext: async () => resolvedContext,
      readOpportunity: async () => fixture.opportunity,
      loadDecision: async () => tampered
    }),
    (error: unknown) =>
      error instanceof CourseAgentArtifactRuntimeError &&
      error.code === "COURSE_AGENT_REVALIDATION_NOT_EXECUTABLE"
  );
});

function durableProjection(
  toolName: string,
  outputHash: string,
  evidenceRefs: readonly EvidenceRef[]
): DurableToolCallProjection {
  return {
    schemaVersion: "cmooc.course-tool-durable-receipt.v1",
    receiptId: `receipt-${toolName.replace(/\./gu, "-")}`,
    callId: `call-${toolName.replace(/\./gu, "-")}`,
    taskId: TASK_ID,
    runId: RUN_ID,
    stepId: `step-${toolName.replace(/\./gu, "-")}`,
    toolName,
    toolVersion: "1",
    status: "succeeded",
    safeInputSummary: "safe input",
    safeOutputSummary: "safe output",
    inputHash: sha(`input:${toolName}`),
    outputHash,
    evidenceRefs,
    observedAt: NOW,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
}

function outcome(
  toolName: string,
  output: CourseToolJsonValue,
  evidenceRefs: readonly EvidenceRef[],
  verificationSubjectId?: string
): CourseToolExecutionOutcome {
  const outputHash = sha(JSON.stringify(output));
  const resultBase: ToolExecutionResult = {
    schemaVersion: "cmooc.course-tool-result.v1",
    receiptId: `receipt-${toolName.replace(/\./gu, "-")}`,
    callId: `call-${toolName.replace(/\./gu, "-")}`,
    status: "succeeded",
    safeModelProjection: { status: "succeeded" },
    outputHash,
    evidenceRefs,
    observedAt: NOW,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
  Object.defineProperty(resultBase, "transientOutput", {
    value: output,
    enumerable: false
  });
  const verification: CourseToolVerificationReport | undefined =
    verificationSubjectId
      ? {
          id: `verification-report:${sha(verificationSubjectId)}`,
          subjectType: toolName.includes("stage")
            ? "stage_transaction"
            : toolName === "evidence.verify_integrity"
              ? "tool_result"
              : "artifact_version",
          subjectId: verificationSubjectId,
          status: "passed",
          receipts: [
            {
              schemaVersion: COURSE_TOOL_VERIFICATION_SCHEMA_VERSION,
              id: `verification-receipt:${sha(verificationSubjectId)}`,
              verifier: OPPORTUNITY_INTEGRITY_VERIFIER_NAME,
              verifierVersion: "1",
              subjectType: toolName.includes("stage")
                ? "stage_transaction"
                : toolName === "evidence.verify_integrity"
                  ? "tool_result"
                  : "artifact_version",
              subjectId: verificationSubjectId,
              status: "passed",
              checks: [],
              evidenceRefs,
              observedAt: NOW,
              containsForumText: false,
              containsIdentity: false,
              containsSecrets: false
            }
          ],
          observedAt: NOW
        }
      : undefined;
  return {
    result: resultBase,
    durableProjection: durableProjection(toolName, outputHash, evidenceRefs),
    ...(verification ? { verification } : {})
  };
}

function artifactWriter() {
  const writes: FacilitationArtifactVersionWrite[] = [];
  const pointers = new Map<string, ArtifactVersionPointer>();
  return {
    writes,
    create: async (write: Readonly<FacilitationArtifactVersionWrite>) => {
      const existing = pointers.get(write.versionKey);
      if (existing) return existing;
      const index = writes.length + 1;
      const pointer: ArtifactVersionPointer = {
        artifactId: `artifact-${index}`,
        versionId: `version-${index}`,
        artifactRef: `artifact:artifact-${index}`,
        versionRef: `artifact-version:version-${index}`,
        version: 1,
        contentHash: write.contentHash
      };
      writes.push(structuredClone(write));
      pointers.set(write.versionKey, pointer);
      return pointer;
    }
  };
}

async function buildVerifiedCompositionFixture() {
  const fixture = buildFixture();
  const writer = artifactWriter();
  const runtime = createCourseAgentArtifactRuntime({
    taskId: TASK_ID,
    runId: RUN_ID,
    courseAlias: COURSE_ALIAS,
    prisma: {} as never,
    resolveCourseContext: async () => resolvedContext,
    listOpportunities: async () => fixture.list,
    readOpportunityEvidence: async () => fixture.opportunity,
    loadDecision: async () => fixture.decision,
    createArtifactVersion: writer.create,
    protectedStore: new InMemoryProtectedArtifactStore({
      idFactory: () => "checkpoint-parent-draft"
    })
  });
  const integrityEvidence = [
    ...fixture.opportunity.evidenceRefs.map((ref) => ({
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
    })),
    evidenceRef("world", `world:${SNAPSHOT_ID}`, anchor.worldHash),
    evidenceRef(
      "verification",
      fixture.integrity.integrityVerificationRef,
      fixture.integrity.integrityVerificationRef.replace(
        "integrity-verification:",
        ""
      )
    )
  ] as readonly EvidenceRef[];
  runtime.materialLedger.recordToolOutcome({
    toolName: "opportunity.select_support_gap",
    outcome: outcome(
      "opportunity.select_support_gap",
      fixture.selection as unknown as CourseToolJsonValue,
      []
    ),
    context: context("selection")
  });
  runtime.materialLedger.recordToolOutcome({
    toolName: "evidence.verify_integrity",
    outcome: outcome(
      "evidence.verify_integrity",
      fixture.integrity as unknown as CourseToolJsonValue,
      integrityEvidence,
      fixture.integrity.integrityVerificationRef
    ),
    context: context("integrity")
  });
  const registrations = createFacilitationArtifactToolRegistrations(
    runtime.dependencies
  );
  const composeContext = context("compose");
  const composeResult = await invokeRegistration(
    "facilitation.intent.compose",
    registrations,
    {
      selectionRef: fixture.selection.selectionRef,
      integrityVerificationRef: fixture.integrity.integrityVerificationRef
    },
    composeContext
  );
  const composeOutput = composeResult.output as FacilitationIntentComposeOutput;
  const composeOutcome = outcome(
    "facilitation.intent.compose",
    composeOutput as unknown as CourseToolJsonValue,
    composeResult.evidenceRefs,
    composeOutput.artifact.versionId
  );
  runtime.materialLedger.recordToolOutcome({
    toolName: "facilitation.intent.compose",
    outcome: composeOutcome,
    context: composeContext
  });
  return {
    fixture,
    writer,
    runtime,
    registrations,
    composeOutput,
    composeOutcome,
    integrityEvidence
  };
}

function verifiedCheckpointSource(input: {
  fixture: ReturnType<typeof buildFixture>;
  composeOutput: FacilitationIntentComposeOutput;
  composeOutcome: CourseToolExecutionOutcome;
  integrityEvidence: readonly EvidenceRef[];
  childRunId: string;
}): CourseAgentVerifiedCheckpointSource {
  const integrityVerificationId = `verification-report:${sha(
    input.fixture.integrity.integrityVerificationRef
  )}`;
  const compositionVerificationId = input.composeOutcome.verification!.id;
  const stableCheckpoint = {
    schemaVersion: "cmooc.course-agent.derived-checkpoint.v1" as const,
    state: "composition_verified" as const,
    recoveryAction: "regenerate_draft_and_reverify" as const,
    reasonCode: "composition_verified_draft_absent",
    taskId: TASK_ID,
    runId: RUN_ID,
    planRef: "plan-parent-fixture",
    planHash: sha("parent-plan"),
    currentStepRef: "step-compose-parent",
    objectiveHash: sha("parent-objective"),
    compilerVersion: "cmooc.course-agent-plan-compiler.v3",
    toolPolicyVersion: TOOL_POLICY_VERSION,
    manifestHash: sha("manifest"),
    compositionVersionRef: input.composeOutput.artifact.versionRef,
    compositionContentHash: input.composeOutput.artifact.contentHash,
    draftVersionRef: null,
    draftContentHash: null,
    draftBodyHash: null,
    materialBindingHash: null,
    regenerationMaterialHash: null,
    integrityVerificationRef:
      input.fixture.integrity.integrityVerificationRef,
    stageTransactionRef: null,
    stageReceiptRef: null,
    stageReceiptHash: null,
    deliveryVersionRef: null,
    deliveryContentHash: null,
    containsForumText: false as const,
    containsIdentity: false as const,
    containsSecrets: false as const
  };
  const checkpointHash = hashCourseToolValue(
    "cmooc.course-agent.derived-checkpoint-hash.v1",
    stableCheckpoint as unknown as CourseToolJsonValue
  );
  return Object.freeze({
    schemaVersion: COURSE_AGENT_VERIFIED_CHECKPOINT_SOURCE_SCHEMA_VERSION,
    sourceTaskId: TASK_ID,
    sourceRunId: RUN_ID,
    childTaskId: TASK_ID,
    childRunId: input.childRunId,
    courseAlias: COURSE_ALIAS,
    toolPolicyVersion: TOOL_POLICY_VERSION,
    sourceCheckpoint: Object.freeze({
      ...stableCheckpoint,
      checkpointRef: `course-checkpoint:${checkpointHash}`,
      checkpointHash,
      derivedAt: NOW
    }),
    provenance: Object.freeze({
      kind: "verified_checkpoint" as const,
      sourceCallId: "call-facilitation-intent-compose",
      sourceCompositionVerificationId: compositionVerificationId,
      sourceIntegrityVerificationId: integrityVerificationId
    }),
    composition: Object.freeze({
      output: input.composeOutput,
      selectionRef: input.fixture.selection.selectionRef,
      decisionId: DECISION_ID,
      stageTarget: Object.freeze({
        targetRef: input.fixture.opportunity.opportunityId,
        opportunityId: input.fixture.opportunity.opportunityId,
        candidateKey: input.fixture.opportunity.candidateKey,
        decisionId: DECISION_ID,
        threadKey: input.fixture.decision.threadKey,
        targetVersionHash: input.fixture.opportunity.target.targetVersionHash,
        eventSetHash: input.fixture.opportunity.exactAnchor.eventSetHash,
        opportunityReceiptHash:
          input.fixture.decision.opportunityReceiptHash,
        revalidationReceiptHash: input.fixture.revalidationReceiptHash,
        afterObservationReceiptHash:
          input.fixture.revalidationReceipt.afterObservationReceiptHash,
        evidenceRefs: input.composeOutput.evidenceRefs as readonly EvidenceRef[]
      }),
      evidenceRefs: input.composeOutput.evidenceRefs as readonly EvidenceRef[],
      verifier: Object.freeze({
        name: "verification.facilitation_intent" as const,
        version: "1" as const,
        status: "passed" as const,
        reportId: compositionVerificationId,
        subjectVersionRef: input.composeOutput.artifact.versionRef
      })
    }),
    integrity: Object.freeze({
      output: input.fixture.integrity,
      evidenceRefs: input.integrityEvidence,
      verifier: Object.freeze({
        name: OPPORTUNITY_INTEGRITY_VERIFIER_NAME,
        version: "1" as const,
        status: "passed" as const,
        reportId: integrityVerificationId,
        subjectRef: input.fixture.integrity.integrityVerificationRef
      })
    }),
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  });
}

function refreshCheckpointHash(source: CourseAgentVerifiedCheckpointSource): void {
  const checkpoint = source.sourceCheckpoint as unknown as Record<string, unknown>;
  const {
    checkpointRef: _checkpointRef,
    checkpointHash: _checkpointHash,
    derivedAt: _derivedAt,
    ...stableCheckpoint
  } = checkpoint;
  const refreshedHash = hashCourseToolValue(
    "cmooc.course-agent.derived-checkpoint-hash.v1",
    stableCheckpoint as CourseToolJsonValue
  );
  checkpoint.checkpointHash = refreshedHash;
  checkpoint.checkpointRef = `course-checkpoint:${refreshedHash}`;
}

async function invokeRegistration(
  name: string,
  registrations: ReturnType<typeof createFacilitationArtifactToolRegistrations>,
  input: Record<string, CourseToolJsonValue>,
  executionContext: ServerToolExecutionContext
) {
  const registration = registrations.find(
    (candidate) => candidate.definition.name === name
  );
  assert.ok(registration);
  const parsedInput = registration.definition.inputSchema.parse(input);
  return registration.handler({
    input: parsedInput,
    context: executionContext,
    envelope: {} as never
  });
}

test("verified parent checkpoint hydrates child integrity and composition atomically with provenance", async () => {
  const parent = await buildVerifiedCompositionFixture();
  const childRunId = "run-artifact-runtime-child";
  const child = createCourseAgentArtifactRuntime({
    taskId: TASK_ID,
    runId: childRunId,
    courseAlias: COURSE_ALIAS,
    prisma: {} as never,
    loadDecision: async () => parent.fixture.decision,
    createArtifactVersion: artifactWriter().create
  });
  const source = verifiedCheckpointSource({
    ...parent,
    childRunId
  });
  const childContext = context("hydrate-child", { runId: childRunId });

  child.materialLedger.hydrateVerifiedCheckpointSource(source, childContext);
  child.materialLedger.hydrateVerifiedCheckpointSource(source, childContext);

  const integrity = child.materialLedger.integrity(
    parent.fixture.integrity.integrityVerificationRef
  );
  const composition = child.materialLedger.composition(
    parent.composeOutput.compositionRef
  );
  assert.ok(integrity);
  assert.ok(composition);
  assert.equal(integrity.context.runId, childRunId);
  assert.equal(composition.context.runId, childRunId);
  assert.equal(composition.provenance?.sourceRunId, RUN_ID);
  assert.equal(
    composition.provenance?.checkpointRef,
    source.sourceCheckpoint.checkpointRef
  );
  assert.equal(
    composition.provenance?.sourceCompositionVerificationId,
    source.composition.verifier.reportId
  );
  assert.equal(
    (await child.materialLedger.resolveStageMaterial({
      targetRef: parent.fixture.opportunity.opportunityId
    }))?.integrityVerificationRef,
    parent.fixture.integrity.integrityVerificationRef
  );
  assert.equal(
    JSON.stringify(source).includes(parent.fixture.draftBody),
    false
  );
  assert.equal(JSON.stringify(source).includes("protectedRef"), false);
  assert.equal(JSON.stringify(child.materialLedger).includes(RUN_ID), false);
});

test("checkpoint hydration rejects child scope, policy, hash, material tamper, and conflicts without partial state", async () => {
  const parent = await buildVerifiedCompositionFixture();
  const childRunId = "run-artifact-runtime-child-tamper";
  const makeChild = () =>
    createCourseAgentArtifactRuntime({
      taskId: TASK_ID,
      runId: childRunId,
      courseAlias: COURSE_ALIAS,
      prisma: {} as never,
      loadDecision: async () => parent.fixture.decision,
      createArtifactVersion: artifactWriter().create
    });
  const source = verifiedCheckpointSource({ ...parent, childRunId });
  const childContext = context("hydrate-child", { runId: childRunId });
  const cases: Array<{
    mutate: (copy: CourseAgentVerifiedCheckpointSource) => void;
    code: string;
  }> = [
    {
      mutate: (copy) => {
        (copy as { childRunId: string }).childRunId = "run-other-child";
      },
      code: "COURSE_AGENT_CHECKPOINT_SOURCE_SCOPE_OR_HASH_MISMATCH"
    },
    {
      mutate: (copy) => {
        (copy as { toolPolicyVersion: string }).toolPolicyVersion = "policy-drift";
      },
      code: "COURSE_AGENT_CHECKPOINT_SOURCE_SCOPE_OR_HASH_MISMATCH"
    },
    {
      mutate: (copy) => {
        (copy.sourceCheckpoint as { checkpointHash: string }).checkpointHash =
          sha("tampered-checkpoint");
      },
      code: "COURSE_AGENT_CHECKPOINT_SOURCE_SCOPE_OR_HASH_MISMATCH"
    },
    {
      mutate: (copy) => {
        (copy.composition.output as { intentHash: string }).intentHash =
          sha("tampered-intent");
      },
      code: "COURSE_AGENT_CHECKPOINT_SOURCE_MATERIAL_MISMATCH"
    }
  ];
  for (const fixtureCase of cases) {
    const child = makeChild();
    const copy = structuredClone(source);
    fixtureCase.mutate(copy);
    assert.throws(
      () =>
        child.materialLedger.hydrateVerifiedCheckpointSource(
          copy,
          childContext
        ),
      (error: unknown) =>
        error instanceof CourseAgentArtifactRuntimeError &&
        error.code === fixtureCase.code
    );
    assert.equal(
      child.materialLedger.integrity(
        parent.fixture.integrity.integrityVerificationRef
      ),
      null
    );
    assert.equal(
      child.materialLedger.composition(parent.composeOutput.compositionRef),
      null
    );
  }

  const child = makeChild();
  child.materialLedger.hydrateVerifiedCheckpointSource(source, childContext);
  const conflict = structuredClone(source);
  (conflict.provenance as { sourceCallId: string }).sourceCallId =
    "call-conflicting-parent";
  assert.throws(
    () =>
      child.materialLedger.hydrateVerifiedCheckpointSource(
        conflict,
        childContext
      ),
    (error: unknown) =>
      error instanceof CourseAgentArtifactRuntimeError &&
      error.code === "COURSE_AGENT_CHECKPOINT_SOURCE_CONFLICT"
  );
});

test("checkpoint hydration requires one exact manifest binding across checkpoint, child context, composition, and stage evidence", async () => {
  const parent = await buildVerifiedCompositionFixture();
  const childRunId = "run-artifact-runtime-child-manifest-binding";
  const source = verifiedCheckpointSource({ ...parent, childRunId });
  const genuineContext = context("hydrate-child-manifest", { runId: childRunId });
  const makeChild = () =>
    createCourseAgentArtifactRuntime({
      taskId: TASK_ID,
      runId: childRunId,
      courseAlias: COURSE_ALIAS,
      prisma: {} as never,
      loadDecision: async () => parent.fixture.decision,
      createArtifactVersion: artifactWriter().create
    });
  const assertNoPartialHydration = (child: ReturnType<typeof makeChild>) => {
    assert.equal(
      child.materialLedger.integrity(
        parent.fixture.integrity.integrityVerificationRef
      ),
      null
    );
    assert.equal(
      child.materialLedger.composition(parent.composeOutput.compositionRef),
      null
    );
  };
  const expectManifestFailure = (
    candidate: CourseAgentVerifiedCheckpointSource,
    executionContext: ServerToolExecutionContext = genuineContext
  ) => {
    const child = makeChild();
    assert.throws(
      () =>
        child.materialLedger.hydrateVerifiedCheckpointSource(
          candidate,
          executionContext
        ),
      (error: unknown) =>
        error instanceof CourseAgentArtifactRuntimeError &&
        error.code === "COURSE_AGENT_CHECKPOINT_MANIFEST_BINDING_MISMATCH"
    );
    assertNoPartialHydration(child);
  };

  const missingCheckpointManifest = structuredClone(source);
  (
    missingCheckpointManifest.sourceCheckpoint as unknown as {
      manifestHash: string | null;
    }
  ).manifestHash = null;
  refreshCheckpointHash(missingCheckpointManifest);
  expectManifestFailure(missingCheckpointManifest);

  expectManifestFailure(source, {
    ...genuineContext,
    courseScope: {
      courseId: COURSE_ALIAS,
      alias: COURSE_ALIAS
    }
  });
  expectManifestFailure(source, {
    ...genuineContext,
    courseScope: {
      ...genuineContext.courseScope,
      manifestHash: sha("different-child-manifest")
    }
  });

  const missingCompositionManifest = structuredClone(source);
  (
    missingCompositionManifest.composition as unknown as {
      evidenceRefs: EvidenceRef[];
    }
  ).evidenceRefs = missingCompositionManifest.composition.evidenceRefs.filter(
    (ref) => ref.kind !== "manifest"
  );
  expectManifestFailure(missingCompositionManifest);

  const driftedCompositionManifest = structuredClone(source);
  (
    driftedCompositionManifest.composition as unknown as {
      evidenceRefs: EvidenceRef[];
    }
  ).evidenceRefs = driftedCompositionManifest.composition.evidenceRefs.map(
    (ref) =>
      ref.kind === "manifest"
        ? { ...ref, hash: sha("different-composition-manifest") }
        : ref
  );
  expectManifestFailure(driftedCompositionManifest);

  const missingStageManifest = structuredClone(source);
  (
    missingStageManifest.composition.stageTarget as unknown as {
      evidenceRefs: EvidenceRef[];
    }
  ).evidenceRefs =
    missingStageManifest.composition.stageTarget.evidenceRefs.filter(
      (ref) => ref.kind !== "manifest"
    );
  expectManifestFailure(missingStageManifest);

  const ambiguousStageManifest = structuredClone(source);
  (
    ambiguousStageManifest.composition.stageTarget as unknown as {
      evidenceRefs: EvidenceRef[];
    }
  ).evidenceRefs = [
    ...ambiguousStageManifest.composition.stageTarget.evidenceRefs,
    evidenceRef(
      "manifest",
      "manifest:conflicting-checkpoint-source",
      sha("different-stage-manifest")
    )
  ];
  expectManifestFailure(ambiguousStageManifest);

  const child = makeChild();
  child.materialLedger.hydrateVerifiedCheckpointSource(source, genuineContext);
  assert.ok(
    child.materialLedger.integrity(
      parent.fixture.integrity.integrityVerificationRef
    )
  );
  assert.ok(
    child.materialLedger.composition(parent.composeOutput.compositionRef)
  );
});

test("regenerated draft genuine outcome binds the fresh child draft for STAGE", async () => {
  const parent = await buildVerifiedCompositionFixture();
  const childRunId = "run-artifact-runtime-child-regenerate";
  const protectedStore = new InMemoryProtectedArtifactStore({
    idFactory: () => "regenerated-child-draft"
  });
  const child = createCourseAgentArtifactRuntime({
    taskId: TASK_ID,
    runId: childRunId,
    courseAlias: COURSE_ALIAS,
    prisma: {} as never,
    loadDecision: async () => parent.fixture.decision,
    createArtifactVersion: artifactWriter().create,
    resolveSelectedArtifactVersion: async () => true,
    protectedStore
  });
  const source = verifiedCheckpointSource({ ...parent, childRunId });
  const childContext = context("hydrate-child", { runId: childRunId });
  child.materialLedger.hydrateVerifiedCheckpointSource(source, childContext);

  const genuineOutput = structuredClone(
    await (async () => {
      const draftResult = await invokeRegistration(
        "artifact.reply_draft.create",
        parent.registrations,
        {
          compositionRef: parent.composeOutput.compositionRef,
          revisionKind: "initial"
        },
        context("parent-draft")
      );
      return draftResult.output as ReplyDraftCreateOutput;
    })()
  );
  const regenerateContext = context("regenerate-child", { runId: childRunId });
  child.materialLedger.recordToolOutcome({
    toolName: "artifact.reply_draft.regenerate",
    outcome: outcome(
      "artifact.reply_draft.regenerate",
      genuineOutput as unknown as CourseToolJsonValue,
      genuineOutput.evidenceRefs as readonly EvidenceRef[],
      genuineOutput.artifact.versionId
    ),
    context: regenerateContext
  });
  const stage = await child.materialLedger.resolveStageMaterial({
    targetRef: parent.fixture.opportunity.opportunityId,
    artifactVersionRef: genuineOutput.artifact.versionRef
  });
  assert.ok(stage);
  assert.equal(stage.draftBodyHash, genuineOutput.artifact.draftBodyHash);
  assert.equal(stage.artifactVersionRef, genuineOutput.artifact.versionRef);
});

test("verified checkpoint source hydrates on demand inside the genuine recovery call context", async () => {
  const parent = await buildVerifiedCompositionFixture();
  const childRunId = "run-artifact-runtime-child-on-demand";
  const source = verifiedCheckpointSource({ ...parent, childRunId });
  const child = createCourseAgentArtifactRuntime({
    taskId: TASK_ID,
    runId: childRunId,
    courseAlias: COURSE_ALIAS,
    prisma: {} as never,
    loadDecision: async () => parent.fixture.decision,
    createArtifactVersion: artifactWriter().create,
    verifiedCheckpointSource: source
  });
  const genuineContext = context("regenerate-on-demand", { runId: childRunId });

  assert.equal(
    child.materialLedger.composition(parent.composeOutput.compositionRef),
    null
  );
  await assert.rejects(
    () => child.dependencies.resolveVerifiedDraftRecoveryMaterial!({
      context: genuineContext
    }),
    (error: unknown) =>
      error instanceof CourseAgentArtifactRuntimeError &&
      error.code === "COURSE_AGENT_DRAFT_RECOVERY_SOURCE_MISSING"
  );
  assert.ok(
    child.materialLedger.composition(parent.composeOutput.compositionRef)
  );
  assert.ok(
    child.materialLedger.integrity(
      parent.fixture.integrity.integrityVerificationRef
    )
  );
  await assert.rejects(
    () => child.dependencies.resolveVerifiedDraftRecoveryMaterial!({
      context: genuineContext
    }),
    (error: unknown) =>
      error instanceof CourseAgentArtifactRuntimeError &&
      error.code === "COURSE_AGENT_DRAFT_RECOVERY_SOURCE_MISSING"
  );

  const withoutSource = createCourseAgentArtifactRuntime({
    taskId: TASK_ID,
    runId: "run-artifact-runtime-child-no-source",
    courseAlias: COURSE_ALIAS,
    prisma: {} as never,
    createArtifactVersion: artifactWriter().create
  });
  await assert.rejects(
    () => withoutSource.dependencies.resolveVerifiedDraftRecoveryMaterial!({
      context: context("regenerate-no-source", {
        runId: "run-artifact-runtime-child-no-source"
      })
    }),
    (error: unknown) =>
      error instanceof CourseAgentArtifactRuntimeError &&
      error.code === "COURSE_AGENT_DRAFT_RECOVERY_SOURCE_MISSING"
  );
});

test("exact selection and verified integrity resolve one persisted decision with dual evidence and policy bindings", async () => {
  const fixture = buildFixture();
  const writer = artifactWriter();
  const runtime = createCourseAgentArtifactRuntime({
    taskId: TASK_ID,
    runId: RUN_ID,
    courseAlias: COURSE_ALIAS,
    prisma: {} as never,
    resolveCourseContext: async () => resolvedContext,
    listOpportunities: async () => fixture.list,
    readOpportunityEvidence: async () => fixture.opportunity,
    loadDecision: async () => fixture.decision,
    createArtifactVersion: writer.create,
    protectedStore: new InMemoryProtectedArtifactStore({ idFactory: () => "draft-fixture" })
  });
  runtime.materialLedger.recordToolOutcome({
    toolName: "opportunity.select_support_gap",
    outcome: outcome(
      "opportunity.select_support_gap",
      fixture.selection as unknown as CourseToolJsonValue,
      []
    ),
    context: context("selection")
  });
  runtime.materialLedger.recordToolOutcome({
    toolName: "evidence.verify_integrity",
    outcome: outcome(
      "evidence.verify_integrity",
      fixture.integrity as unknown as CourseToolJsonValue,
      [],
      fixture.integrity.integrityVerificationRef
    ),
    context: context("integrity")
  });
  const material = await runtime.dependencies.composeIntent({
    selectionRef: fixture.selection.selectionRef,
    integrityVerificationRef: fixture.integrity.integrityVerificationRef,
    context: context("compose")
  });
  assert.equal(material.selectionEvidenceBindingHash, fixture.selectionEvidenceBindingHash);
  assert.equal(material.evidenceBindingHash, fixture.intentEvidenceBindingHash);
  assert.notEqual(material.selectionEvidenceBindingHash, material.evidenceBindingHash);
  assert.equal(material.intentPolicyVersion, LIVE_FACILITATION_POLICY_VERSION);
  assert.equal(material.toolPolicyVersion, TOOL_POLICY_VERSION);
  assert.equal(material.intent.evidenceRefHash, fixture.intentEvidenceBindingHash);
  assert.equal(material.evidenceRefs.some((ref) => ref.kind === "world"), true);
  assert.equal(
    material.evidenceRefs.some(
      (ref) => ref.kind === "verification" && ref.id === fixture.integrity.integrityVerificationRef
    ),
    true
  );
});

test("deterministic draft body enters only the protected store and run material ledger never serializes it or protectedRef", async () => {
  const fixture = buildFixture();
  const writer = artifactWriter();
  const protectedStore = new InMemoryProtectedArtifactStore({
    idFactory: () => "draft-fixture"
  });
  let selectedVersionRef: string | null = null;
  const runtime = createCourseAgentArtifactRuntime({
    taskId: TASK_ID,
    runId: RUN_ID,
    courseAlias: COURSE_ALIAS,
    prisma: {} as never,
    resolveCourseContext: async () => resolvedContext,
    listOpportunities: async () => fixture.list,
    readOpportunityEvidence: async () => fixture.opportunity,
    loadDecision: async () => fixture.decision,
    createArtifactVersion: writer.create,
    resolveSelectedArtifactVersion: async (binding) =>
      binding.taskId === TASK_ID &&
      binding.runId === RUN_ID &&
      binding.versionRef === selectedVersionRef,
    protectedStore,
    protectedDraftTtlMs: 120_000
  });
  runtime.materialLedger.recordToolOutcome({
    toolName: "opportunity.select_support_gap",
    outcome: outcome(
      "opportunity.select_support_gap",
      fixture.selection as unknown as CourseToolJsonValue,
      []
    ),
    context: context("selection")
  });
  runtime.materialLedger.recordToolOutcome({
    toolName: "evidence.verify_integrity",
    outcome: outcome(
      "evidence.verify_integrity",
      fixture.integrity as unknown as CourseToolJsonValue,
      [],
      fixture.integrity.integrityVerificationRef
    ),
    context: context("integrity")
  });
  const registrations = createFacilitationArtifactToolRegistrations(runtime.dependencies);
  const composeContext = context("compose");
  const composeResult = await invokeRegistration(
    "facilitation.intent.compose",
    registrations,
    {
      selectionRef: fixture.selection.selectionRef,
      integrityVerificationRef: fixture.integrity.integrityVerificationRef
    },
    composeContext
  );
  const composeOutput = composeResult.output as FacilitationIntentComposeOutput;
  runtime.materialLedger.recordToolOutcome({
    toolName: "facilitation.intent.compose",
    outcome: outcome(
      "facilitation.intent.compose",
      composeOutput as unknown as CourseToolJsonValue,
      composeResult.evidenceRefs,
      composeOutput.artifact.versionId
    ),
    context: composeContext
  });
  const draftContext = context("draft");
  const draftResult = await invokeRegistration(
    "artifact.reply_draft.create",
    registrations,
    { compositionRef: composeOutput.compositionRef, revisionKind: "initial" },
    draftContext
  );
  const draftOutput = draftResult.output as ReplyDraftCreateOutput;
  assert.equal(
    await protectedStore.getByRef({
      ref: draftOutput.artifact.protectedRef,
      taskId: TASK_ID,
      runId: RUN_ID,
      expectedDraftBodyHash: draftOutput.artifact.draftBodyHash,
      now: NOW
    }),
    fixture.draftBody
  );
  assert.equal(JSON.stringify(writer.writes).includes(fixture.draftBody), false);
  assert.equal(JSON.stringify(writer.writes).includes("protected-draft:"), false);
  const driftedOutput = structuredClone(draftOutput);
  (driftedOutput as { regenerationMaterialHash: string }).regenerationMaterialHash =
    sha("drifted-regeneration-material");
  assert.throws(
    () =>
      runtime.materialLedger.recordToolOutcome({
        toolName: "artifact.reply_draft.create",
        outcome: outcome(
          "artifact.reply_draft.create",
          driftedOutput as unknown as CourseToolJsonValue,
          draftResult.evidenceRefs,
          draftOutput.artifact.versionId
        ),
        context: draftContext
      }),
    (error: unknown) =>
      error instanceof CourseAgentArtifactRuntimeError &&
      error.code === "COURSE_AGENT_DRAFT_OUTPUT_INVALID"
  );
  runtime.materialLedger.recordToolOutcome({
    toolName: "artifact.reply_draft.create",
    outcome: outcome(
      "artifact.reply_draft.create",
      draftOutput as unknown as CourseToolJsonValue,
      draftResult.evidenceRefs,
      draftOutput.artifact.versionId
    ),
    context: draftContext
  });
  selectedVersionRef = draftOutput.artifact.versionRef;
  const stageMaterial = await runtime.materialLedger.resolveStageMaterial({
    targetRef: fixture.opportunity.opportunityId,
    artifactVersionRef: draftOutput.artifact.versionRef
  });
  assert.ok(stageMaterial);
  assert.equal(
    stageMaterial.target.revalidationReceiptHash,
    fixture.revalidationReceiptHash
  );
  assert.equal(
    stageMaterial.target.afterObservationReceiptHash,
    fixture.revalidationReceipt.afterObservationReceiptHash
  );
  assert.equal(
    stageMaterial.target.eventSetHash,
    fixture.revalidationReceipt.eventSetHash
  );
  assert.notEqual(
    stageMaterial.target.afterObservationReceiptHash,
    fixture.decision.observationReceiptHash
  );
  selectedVersionRef = "artifact-version:version-newer-selected";
  assert.equal(
    await runtime.materialLedger.resolveStageMaterial({
      targetRef: fixture.opportunity.opportunityId,
      artifactVersionRef: draftOutput.artifact.versionRef,
      now: NOW
    }),
    null
  );
  assert.equal(JSON.stringify(runtime.materialLedger).includes(fixture.draftBody), false);
  assert.equal(JSON.stringify(runtime.materialLedger).includes("protected-draft:"), false);
});

test("delivery resolves only an exact verified-cleared zero-publish STAGE receipt", async () => {
  const fixture = buildFixture();
  const writer = artifactWriter();
  const runtime = createCourseAgentArtifactRuntime({
    taskId: TASK_ID,
    runId: RUN_ID,
    courseAlias: COURSE_ALIAS,
    prisma: {} as never,
    resolveCourseContext: async () => resolvedContext,
    listOpportunities: async () => fixture.list,
    readOpportunityEvidence: async () => fixture.opportunity,
    loadDecision: async () => fixture.decision,
    createArtifactVersion: writer.create,
    protectedStore: new InMemoryProtectedArtifactStore({ idFactory: () => "draft-fixture" })
  });
  runtime.materialLedger.recordToolOutcome({
    toolName: "opportunity.select_support_gap",
    outcome: outcome("opportunity.select_support_gap", fixture.selection as unknown as CourseToolJsonValue, []),
    context: context("selection")
  });
  runtime.materialLedger.recordToolOutcome({
    toolName: "evidence.verify_integrity",
    outcome: outcome(
      "evidence.verify_integrity",
      fixture.integrity as unknown as CourseToolJsonValue,
      [],
      fixture.integrity.integrityVerificationRef
    ),
    context: context("integrity")
  });
  const registrations = createFacilitationArtifactToolRegistrations(runtime.dependencies);
  const composeContext = context("compose");
  const composeResult = await invokeRegistration(
    "facilitation.intent.compose",
    registrations,
    {
      selectionRef: fixture.selection.selectionRef,
      integrityVerificationRef: fixture.integrity.integrityVerificationRef
    },
    composeContext
  );
  const composeOutput = composeResult.output as FacilitationIntentComposeOutput;
  runtime.materialLedger.recordToolOutcome({
    toolName: "facilitation.intent.compose",
    outcome: outcome("facilitation.intent.compose", composeOutput as unknown as CourseToolJsonValue, composeResult.evidenceRefs, composeOutput.artifact.versionId),
    context: composeContext
  });
  const draftContext = context("draft");
  const draftResult = await invokeRegistration(
    "artifact.reply_draft.create",
    registrations,
    { compositionRef: composeOutput.compositionRef, revisionKind: "initial" },
    draftContext
  );
  const draftOutput = draftResult.output as ReplyDraftCreateOutput;
  runtime.materialLedger.recordToolOutcome({
    toolName: "artifact.reply_draft.create",
    outcome: outcome("artifact.reply_draft.create", draftOutput as unknown as CourseToolJsonValue, draftResult.evidenceRefs, draftOutput.artifact.versionId),
    context: draftContext
  });
  const stageReceipt = evidenceRef("stage_receipt", "stage-receipt:fixture");
  const stageOutput: PlatformStageReconciledOutput = {
    schemaVersion: PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
    status: "reconciled_cleared",
    resolution: "owned_draft_cleared",
    stageTransactionRef: "stage-transaction:fixture",
    receiptRef: stageReceipt.id,
    receiptHash: stageReceipt.hash,
    targetRef: "target:fixture",
    targetVersionHash: fixture.opportunity.target.targetVersionHash,
    artifactVersionRef: draftOutput.artifact.versionRef,
    draftBodyHash: draftOutput.artifact.draftBodyHash,
    pageBindingRef: "page-binding:fixture",
    pageBindingHash: sha("page-binding"),
    baselineRef: "editor-baseline:fixture",
    baselineHash: sha("empty-editor"),
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
    observedAt: NOW,
    evidenceRefs: [
      evidenceRef("artifact", draftOutput.artifact.versionRef, draftOutput.artifact.contentHash),
      stageReceipt
    ],
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
  runtime.materialLedger.recordToolOutcome({
    toolName: "platform.editor.reconcile_stage",
    outcome: outcome(
      "platform.editor.reconcile_stage",
      stageOutput as unknown as CourseToolJsonValue,
      stageOutput.evidenceRefs,
      stageOutput.stageTransactionRef
    ),
    context: context("stage")
  });
  const resolved = await runtime.dependencies.resolveDeliveryInputs({
    draftVersionRef: draftOutput.artifact.versionRef,
    integrityVerificationRef: fixture.integrity.integrityVerificationRef,
    stageVerificationRef: stageOutput.receiptRef,
    context: context("delivery")
  });
  assert.equal(resolved.stageVerification.clearVerified, true);
  assert.equal(resolved.stageVerification.editorEmptyAfter, true);
  assert.equal(resolved.stageVerification.submitMutationCount, 0);
  assert.equal(resolved.stageVerification.sendMutationCount, 0);
  assert.equal(resolved.stageVerification.realPublishEnabled, false);
  assert.equal(resolved.stageVerification.receiptEvidenceRef.id, stageOutput.receiptRef);
});

test("tampered selection, verification, decision protocol, and cross-run material all fail closed", async () => {
  const fixture = buildFixture();
  const makeRuntime = (decision: CourseAgentArtifactDecisionRow = fixture.decision) =>
    createCourseAgentArtifactRuntime({
      taskId: TASK_ID,
      runId: RUN_ID,
      courseAlias: COURSE_ALIAS,
      prisma: {} as never,
      resolveCourseContext: async () => resolvedContext,
      listOpportunities: async () => fixture.list,
      readOpportunityEvidence: async () => fixture.opportunity,
      loadDecision: async () => decision,
      createArtifactVersion: artifactWriter().create
    });

  const tamperedSelection = {
    ...fixture.selection,
    evidenceBindingHash: sha("tampered-selection-binding")
  };
  const first = makeRuntime();
  first.materialLedger.recordToolOutcome({
    toolName: "opportunity.select_support_gap",
    outcome: outcome("opportunity.select_support_gap", tamperedSelection as unknown as CourseToolJsonValue, []),
    context: context("selection")
  });
  first.materialLedger.recordToolOutcome({
    toolName: "evidence.verify_integrity",
    outcome: outcome("evidence.verify_integrity", fixture.integrity as unknown as CourseToolJsonValue, [], fixture.integrity.integrityVerificationRef),
    context: context("integrity")
  });
  await assert.rejects(
    first.dependencies.composeIntent({
      selectionRef: fixture.selection.selectionRef,
      integrityVerificationRef: fixture.integrity.integrityVerificationRef,
      context: context("compose")
    }),
    (error: unknown) =>
      error instanceof CourseAgentArtifactRuntimeError &&
      error.code === "COURSE_AGENT_SELECTION_REPLAY_MISMATCH"
  );

  const missingVerification = makeRuntime();
  assert.throws(
    () =>
      missingVerification.materialLedger.recordToolOutcome({
        toolName: "evidence.verify_integrity",
        outcome: outcome(
          "evidence.verify_integrity",
          fixture.integrity as unknown as CourseToolJsonValue,
          []
        ),
        context: context("integrity")
      }),
    (error: unknown) =>
      error instanceof CourseAgentArtifactRuntimeError &&
      error.code === "COURSE_AGENT_MATERIAL_VERIFICATION_NOT_PASSED"
  );

  const summary = JSON.parse(fixture.decision.decisionJson) as Record<string, unknown>;
  const tamperedDecision: CourseAgentArtifactDecisionRow = {
    ...fixture.decision,
    decisionJson: JSON.stringify({ ...summary, intentHash: sha("tampered-intent") })
  };
  const third = makeRuntime(tamperedDecision);
  third.materialLedger.recordToolOutcome({
    toolName: "opportunity.select_support_gap",
    outcome: outcome("opportunity.select_support_gap", fixture.selection as unknown as CourseToolJsonValue, []),
    context: context("selection")
  });
  third.materialLedger.recordToolOutcome({
    toolName: "evidence.verify_integrity",
    outcome: outcome("evidence.verify_integrity", fixture.integrity as unknown as CourseToolJsonValue, [], fixture.integrity.integrityVerificationRef),
    context: context("integrity")
  });
  await assert.rejects(
    third.dependencies.composeIntent({
      selectionRef: fixture.selection.selectionRef,
      integrityVerificationRef: fixture.integrity.integrityVerificationRef,
      context: context("compose")
    }),
    (error: unknown) =>
      error instanceof CourseAgentArtifactRuntimeError &&
      error.code === "COURSE_AGENT_DECISION_BINDING_MISMATCH"
  );

  const fourth = makeRuntime();
  assert.throws(
    () =>
      fourth.materialLedger.recordToolOutcome({
        toolName: "opportunity.select_support_gap",
        outcome: outcome("opportunity.select_support_gap", fixture.selection as unknown as CourseToolJsonValue, []),
        context: { ...context("selection"), runId: "another-run" }
      }),
    (error: unknown) =>
      error instanceof CourseAgentArtifactRuntimeError &&
      error.code === "COURSE_AGENT_MATERIAL_SCOPE_MISMATCH"
  );
});

test("missing, tampered, or initial-observation reread bindings fail closed before STAGE material exists", async (t) => {
  async function expectRevalidationFailure(
    mutate: (summary: Record<string, unknown>, receipt: Record<string, unknown>) => void
  ) {
    const fixture = buildFixture();
    const summary = JSON.parse(fixture.decision.decisionJson) as Record<string, unknown>;
    const receipt = structuredClone(
      summary.revalidationReceipt as Record<string, unknown>
    );
    summary.revalidationReceipt = receipt;
    mutate(summary, receipt);
    const runtime = createCourseAgentArtifactRuntime({
      taskId: TASK_ID,
      runId: RUN_ID,
      courseAlias: COURSE_ALIAS,
      prisma: {} as never,
      resolveCourseContext: async () => resolvedContext,
      listOpportunities: async () => fixture.list,
      readOpportunityEvidence: async () => fixture.opportunity,
      loadDecision: async () => ({
        ...fixture.decision,
        decisionJson: JSON.stringify(summary)
      }),
      createArtifactVersion: artifactWriter().create
    });
    runtime.materialLedger.recordToolOutcome({
      toolName: "opportunity.select_support_gap",
      outcome: outcome(
        "opportunity.select_support_gap",
        fixture.selection as unknown as CourseToolJsonValue,
        []
      ),
      context: context("selection")
    });
    runtime.materialLedger.recordToolOutcome({
      toolName: "evidence.verify_integrity",
      outcome: outcome(
        "evidence.verify_integrity",
        fixture.integrity as unknown as CourseToolJsonValue,
        [],
        fixture.integrity.integrityVerificationRef
      ),
      context: context("integrity")
    });
    await assert.rejects(
      runtime.dependencies.composeIntent({
        selectionRef: fixture.selection.selectionRef,
        integrityVerificationRef: fixture.integrity.integrityVerificationRef,
        context: context("compose")
      }),
      (error: unknown) =>
        error instanceof CourseAgentArtifactRuntimeError &&
        error.code === "COURSE_AGENT_REVALIDATION_NOT_EXECUTABLE"
    );
    assert.equal(
      await runtime.materialLedger.resolveStageMaterial({
        targetRef: fixture.opportunity.opportunityId
      }),
      null
    );
  }

  await t.test("tampered canonical receipt hash", async () => {
    await expectRevalidationFailure((summary) => {
      summary.revalidationReceiptHash = sha("tampered-revalidation");
    });
  });

  await t.test("missing fresh after-observation receipt hash", async () => {
    await expectRevalidationFailure((summary, receipt) => {
      delete receipt.afterObservationReceiptHash;
      summary.revalidationReceiptHash = canonicalProtocolHash(
        AUTONOMY_DRAFT_REVALIDATION_SCHEMA_VERSION,
        receipt as CanonicalJsonValue
      );
    });
  });

  await t.test("initial observation hash cannot masquerade as the fresh reread", async () => {
    await expectRevalidationFailure((summary, receipt) => {
      receipt.afterObservationReceiptHash = summary.observationReceiptHash;
      summary.revalidationReceiptHash = canonicalProtocolHash(
        AUTONOMY_DRAFT_REVALIDATION_SCHEMA_VERSION,
        receipt as CanonicalJsonValue
      );
    });
  });
});

test("a verified no-action selection is a normal terminal result and creates no artifact material", async () => {
  const fixture = buildFixture();
  const runtime = createCourseAgentArtifactRuntime({
    taskId: TASK_ID,
    runId: RUN_ID,
    courseAlias: COURSE_ALIAS,
    prisma: {} as never,
    resolveCourseContext: async () => resolvedContext,
    listOpportunities: async () => fixture.list,
    readOpportunityEvidence: async () => fixture.opportunity,
    loadDecision: async () => fixture.decision,
    createArtifactVersion: artifactWriter().create
  });
  const noAction: OpportunitySelectionToolOutput = {
    ...fixture.selection,
    status: "no_action",
    selectedOpportunityId: null,
    reasonCode: "all_sources_checked_no_mature_support_gap"
  };
  assert.doesNotThrow(() =>
    runtime.materialLedger.recordToolOutcome({
      toolName: "opportunity.select_support_gap",
      outcome: outcome(
        "opportunity.select_support_gap",
        noAction as unknown as CourseToolJsonValue,
        []
      ),
      context: context("selection-no-action")
    })
  );
  assert.equal(runtime.materialLedger.selection(noAction.selectionRef), null);
  await assert.rejects(
    runtime.dependencies.composeIntent({
      selectionRef: noAction.selectionRef,
      integrityVerificationRef: fixture.integrity.integrityVerificationRef,
      context: context("compose-after-no-action")
    }),
    (error: unknown) =>
      error instanceof CourseAgentArtifactRuntimeError &&
      error.code === "COURSE_AGENT_REQUIRED_MATERIAL_MISSING"
  );
});

test("decision material containing a body, identity, token, or protectedRef sentinel is rejected before composition", async () => {
  const fixture = buildFixture();
  for (const restricted of [
    { draftBody: "FORUM_BODY_SENTINEL" },
    { identity: "PERSON_IDENTITY_SENTINEL" },
    { accessToken: "SECRET_TOKEN_SENTINEL" },
    { protectedRef: "protected-draft:leak" }
  ]) {
    const summary = JSON.parse(fixture.decision.decisionJson) as Record<string, unknown>;
    const runtime = createCourseAgentArtifactRuntime({
      taskId: TASK_ID,
      runId: RUN_ID,
      courseAlias: COURSE_ALIAS,
      prisma: {} as never,
      resolveCourseContext: async () => resolvedContext,
      listOpportunities: async () => fixture.list,
      readOpportunityEvidence: async () => fixture.opportunity,
      loadDecision: async () => ({
        ...fixture.decision,
        decisionJson: JSON.stringify({ ...summary, ...restricted })
      }),
      createArtifactVersion: artifactWriter().create
    });
    runtime.materialLedger.recordToolOutcome({
      toolName: "opportunity.select_support_gap",
      outcome: outcome(
        "opportunity.select_support_gap",
        fixture.selection as unknown as CourseToolJsonValue,
        []
      ),
      context: context("selection")
    });
    runtime.materialLedger.recordToolOutcome({
      toolName: "evidence.verify_integrity",
      outcome: outcome(
        "evidence.verify_integrity",
        fixture.integrity as unknown as CourseToolJsonValue,
        [],
        fixture.integrity.integrityVerificationRef
      ),
      context: context("integrity")
    });
    await assert.rejects(
      runtime.dependencies.composeIntent({
        selectionRef: fixture.selection.selectionRef,
        integrityVerificationRef: fixture.integrity.integrityVerificationRef,
        context: context("compose")
      }),
      (error: unknown) =>
        error instanceof CourseAgentArtifactRuntimeError &&
        error.code === "COURSE_AGENT_DECISION_RESTRICTED"
    );
  }
});
