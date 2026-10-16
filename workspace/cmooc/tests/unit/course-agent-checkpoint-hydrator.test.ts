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
  hashCourseToolValue,
  type CourseToolJsonValue,
  type EvidenceRef
} from "../../lib/course-tools/contracts";
import {
  FACILITATION_ARTIFACT_LINT_VERSION,
  FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION,
  FACILITATION_DRAFT_MATERIAL_BINDING_SCHEMA_VERSION,
  FACILITATION_DRAFT_METADATA_SCHEMA_VERSION,
  FACILITATION_DRAFT_REGENERATION_MATERIAL_SCHEMA_VERSION,
  FACILITATION_DRAFT_REGENERATION_RECIPE_SCHEMA_VERSION,
  FACILITATION_DRAFT_VERIFIER_CONTRACT,
  hashReplyDraftContentMaterialV2,
  hashReplyDraftMaterialBindingV2,
  hashReplyDraftRegenerationMaterialV2,
  hashReplyDraftRegenerationRecipeV2,
  type FacilitationIntentComposeOutput,
  type ReplyDraftContentMaterialV2,
  type ReplyDraftMaterialBindingV2,
  type ReplyDraftPersistedMetadataV2,
  type ReplyDraftRegenerationMaterialV2,
  type ReplyDraftRegenerationRecipeV2
} from "../../lib/course-tools/tools/facilitation-artifacts";
import { COURSE_TOOL_POLICY_VERSION } from "../../lib/course-tools/policy-gateway";
import { SEMANTIC_RENDERER_VERSION } from "../../lib/autonomy/semantic-renderer";
import { LIVE_FACILITATION_POLICY_VERSION } from "../../lib/live-runtime/facilitation-kernel";
import {
  COURSE_AGENT_OBJECTIVE_CLASSIFIER_VERSION,
  COURSE_AGENT_PLAN_COMPILER_VERSION
} from "../../lib/workbench/course-agent-plan";
import {
  CourseAgentCheckpointHydratorError,
  loadVerifiedCourseAgentRecoveryBundle
} from "../../lib/workbench/course-agent-checkpoint-hydrator";
import {
  WORKBENCH_SAFE_OBJECTIVE_SCHEMA_VERSION,
  type WorkbenchDb
} from "../../lib/workbench/durable-ledger";

const NOW = "2026-08-13T20:00:00.000Z";
const TASK = "task-recovery";
const SOURCE_RUN = "run-parent-failed";
const CHILD_RUN = "run-child-not-created-yet";
const COURSE_ALIAS = "course-safe";
const TOOL_NAMES = [
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

function fixtureHash(label: string): string {
  return hashCourseToolValue("test.course-agent-checkpoint-hydrator", label);
}

function evidenceRef(
  kind: EvidenceRef["kind"],
  id: string,
  hash = fixtureHash(`${kind}:${id}`)
): EvidenceRef {
  return Object.freeze({
    kind,
    id,
    hash,
    observedAt: "2026-08-13T19:00:00.000Z"
  });
}

function sortedEvidence(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  return Object.freeze(
    [...refs].sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.id.localeCompare(right.id) ||
        left.hash.localeCompare(right.hash)
    )
  );
}

function successfulRecoveryDb(input: {
  driftOnConfirmation?: boolean;
  tamperIntegrityChecks?: boolean;
} = {}) {
  const objectiveHash = fixtureHash("objective");
  const manifestHash = fixtureHash("manifest");
  const integrityHash = fixtureHash("integrity-verification");
  const integrityVerificationRef = `integrity-verification:${integrityHash}`;
  const decisionId = "decision-recovery";
  const candidateKey = "candidate-recovery";
  const snapshotId = "snapshot-recovery";
  const snapshotHash = fixtureHash("snapshot");
  const opportunityReceiptHash = fixtureHash("opportunity-receipt");
  const evidenceBindingHash = fixtureHash("composition-evidence-binding");
  const intent = parseProtocolObject("interventionIntent", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.interventionIntent,
    evidenceRefHash: evidenceBindingHash,
    evidenceAsOf: "2026-08-13T19:00:00.000Z",
    intervene: true,
    facilitationFunction: "cognitive_conflict",
    targetObject: "thread_author",
    workloadCost: 1,
    candidateExpiresAt: "2026-08-14T19:00:00.000Z",
    withdrawalConditions: [
      "external_human_response",
      "source_censored",
      "candidate_expired",
      "budget_unavailable",
      "target_version_changed",
      "author_cooldown_active"
    ],
    policyVersion: LIVE_FACILITATION_POLICY_VERSION,
    budgetVersion: "budget-recovery-v1",
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
    requiredContentElements: [
      "boundary_question",
      "counterexample_invitation"
    ],
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
  const compositionEvidence = sortedEvidence([
    evidenceRef("manifest", COURSE_ALIAS, manifestHash),
    evidenceRef("invocation", "invocation-recovery"),
    evidenceRef("snapshot", snapshotId, snapshotHash),
    evidenceRef("world", `world:${snapshotId}`, snapshotHash),
    evidenceRef("coverage", "coverage-recovery"),
    evidenceRef("candidate", `candidate:${candidateKey}`),
    evidenceRef("decision", `decision:${decisionId}`, opportunityReceiptHash),
    evidenceRef("verification", integrityVerificationRef, integrityHash)
  ]);
  const rawIntegrityEvidence = sortedEvidence(
    compositionEvidence.filter(
      (ref) => ref.kind !== "world" && ref.kind !== "verification"
    )
  );
  const compositionVersionId = "composition-version";
  const compositionArtifactId = "composition-artifact";
  const compositionReceiptHash = fixtureHash("composition-receipt-material");
  const compositionMetadata = {
    schemaVersion: FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION,
    receiptRef: `intent-compose:${compositionReceiptHash}`,
    receiptHash: compositionReceiptHash,
    selectionRef: "selection-recovery",
    selectionEvidenceBindingHash: fixtureHash("selection-evidence-binding"),
    integrityVerificationRef,
    evidenceBindingHash,
    intentPolicyVersion: LIVE_FACILITATION_POLICY_VERSION,
    toolPolicyVersion: COURSE_TOOL_POLICY_VERSION,
    intent,
    intentHash,
    moveSpec,
    moveSpecHash,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
  const compositionContentHash = hashCourseToolValue(
    "facilitation-intent-artifact.v2",
    {
      schemaVersion: FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION,
      intent,
      intentHash,
      moveSpec,
      moveSpecHash,
      receiptHash: compositionReceiptHash,
      intentPolicyVersion: LIVE_FACILITATION_POLICY_VERSION,
      toolPolicyVersion: COURSE_TOOL_POLICY_VERSION,
      selectionEvidenceBindingHash:
        compositionMetadata.selectionEvidenceBindingHash,
      evidenceBindingHash
    }
  );
  const compositionPointer = {
    artifactId: compositionArtifactId,
    versionId: compositionVersionId,
    artifactRef: `artifact:${compositionArtifactId}`,
    versionRef: `artifact-version:${compositionVersionId}`,
    version: 1,
    contentHash: compositionContentHash
  };
  const compositionOutput: FacilitationIntentComposeOutput = {
    schemaVersion: "cmooc.course-tool.facilitation-intent-output.v2",
    status: "composed",
    compositionRef: compositionPointer.versionRef,
    intent,
    intentHash,
    moveSpec,
    moveSpecHash,
    intentPolicyVersion: LIVE_FACILITATION_POLICY_VERSION,
    toolPolicyVersion: COURSE_TOOL_POLICY_VERSION,
    selectionEvidenceBindingHash:
      compositionMetadata.selectionEvidenceBindingHash,
    evidenceBindingHash,
    integrityVerificationRef,
    receiptRef: compositionMetadata.receiptRef,
    receiptHash: compositionReceiptHash,
    artifact: compositionPointer,
    evidenceRefs:
      compositionEvidence as FacilitationIntentComposeOutput["evidenceRefs"],
    observedAt: "2026-08-13T19:20:00.000Z",
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
  const integrityOutput = {
    schemaVersion: "cmooc.course-tool.opportunity-verification-output.v1",
    status: "eligible",
    contextRef: `snapshot:${snapshotId}`,
    snapshotRef: snapshotId,
    opportunityId: `support-gap:${candidateKey}`,
    integrityVerificationRef,
    claim: "mature_support_gap",
    candidateSetCheck: "passed",
    targetProjectionCheck: "passed",
    targetPredicatesCheck: "passed",
    qualificationCheck: "passed",
    graphCheck: "not_required",
    policyCheck: "passed",
    limitationCode: "none",
    evidenceRefCount: rawIntegrityEvidence.length
  } as const;

  const draftBodyHash = fixtureHash("draft-body");
  const expiresAt = "2026-08-14T20:00:00.000Z";
  const contentMaterial: ReplyDraftContentMaterialV2 = {
    schemaVersion: FACILITATION_DRAFT_METADATA_SCHEMA_VERSION,
    compositionRef: compositionPointer.versionRef,
    intent,
    intentHash,
    moveSpec,
    moveSpecHash,
    draftBodyHash,
    rendererVersion: SEMANTIC_RENDERER_VERSION,
    rendererReceiptRef: `semantic-renderer-receipt:${fixtureHash("renderer")}`,
    rendererReceiptHash: fixtureHash("renderer"),
    lintVersion: FACILITATION_ARTIFACT_LINT_VERSION,
    lintReceiptRef: `draft-lint:${fixtureHash("lint")}`,
    lintReceiptHash: fixtureHash("lint"),
    integrityVerificationRef,
    intentPolicyVersion: LIVE_FACILITATION_POLICY_VERSION,
    toolPolicyVersion: COURSE_TOOL_POLICY_VERSION,
    revisionKind: "initial",
    priorVersionRef: null,
    feedbackRef: null,
    recovery: "regenerate_and_reverify",
    bodyPersisted: false,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
  const draftContentHash = hashReplyDraftContentMaterialV2(contentMaterial);
  const regenerationMaterial: ReplyDraftRegenerationMaterialV2 = {
    schemaVersion: FACILITATION_DRAFT_REGENERATION_MATERIAL_SCHEMA_VERSION,
    compositionRef: contentMaterial.compositionRef,
    intentHash,
    moveSpecHash,
    draftBodyHash,
    contentHash: draftContentHash,
    rendererVersion: SEMANTIC_RENDERER_VERSION,
    rendererReceiptHash: contentMaterial.rendererReceiptHash,
    lintReceiptHash: contentMaterial.lintReceiptHash,
    integrityVerificationRef,
    intentPolicyVersion: LIVE_FACILITATION_POLICY_VERSION,
    toolPolicyVersion: COURSE_TOOL_POLICY_VERSION,
    revisionKind: "initial",
    priorVersionRef: null,
    feedbackRef: null
  };
  const regenerationMaterialHash =
    hashReplyDraftRegenerationMaterialV2(regenerationMaterial);
  const draftRecipe: ReplyDraftRegenerationRecipeV2 = {
    schemaVersion: FACILITATION_DRAFT_REGENERATION_RECIPE_SCHEMA_VERSION,
    strategy: "reinvoke_semantic_renderer",
    compositionRef: regenerationMaterial.compositionRef,
    intentHash: regenerationMaterial.intentHash,
    moveSpecHash: regenerationMaterial.moveSpecHash,
    draftBodyHash: regenerationMaterial.draftBodyHash,
    contentHash: regenerationMaterial.contentHash,
    rendererVersion: regenerationMaterial.rendererVersion,
    rendererReceiptHash: regenerationMaterial.rendererReceiptHash,
    lintReceiptHash: regenerationMaterial.lintReceiptHash,
    integrityVerificationRef: regenerationMaterial.integrityVerificationRef,
    intentPolicyVersion: regenerationMaterial.intentPolicyVersion,
    toolPolicyVersion: regenerationMaterial.toolPolicyVersion,
    revisionKind: regenerationMaterial.revisionKind,
    priorVersionRef: regenerationMaterial.priorVersionRef,
    feedbackRef: regenerationMaterial.feedbackRef,
    expiresAt,
    regenerationMaterialHash,
    requireReverification: true,
    recovery: "regenerate_and_reverify",
    bodyPersisted: false,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
  const regenerationRecipeHash = hashReplyDraftRegenerationRecipeV2(draftRecipe);
  const materialBinding: ReplyDraftMaterialBindingV2 = {
    schemaVersion: FACILITATION_DRAFT_MATERIAL_BINDING_SCHEMA_VERSION,
    contentHash: draftContentHash,
    draftBodyHash,
    regenerationMaterialHash,
    regenerationRecipeHash,
    verifier: FACILITATION_DRAFT_VERIFIER_CONTRACT,
    expiresAt,
    requireReverification: true,
    recovery: "regenerate_and_reverify",
    bodyPersisted: false
  };
  const draftMetadata: ReplyDraftPersistedMetadataV2 = {
    ...contentMaterial,
    contentHash: draftContentHash,
    expiresAt,
    regenerationMaterialHash,
    regenerationRecipeHash,
    materialBindingHash: hashReplyDraftMaterialBindingV2(materialBinding)
  };
  const logicalDraftKey = `support-gap-draft:${decisionId}`;
  const artifactKey = `facilitation_reply_draft:${hashCourseToolValue(
    "facilitation-artifact-key.v1",
    { taskId: TASK, logicalKey: logicalDraftKey }
  )}`;
  const draftArtifactId = `course-artifact-${createHash("sha256")
    .update(artifactKey, "utf8")
    .digest("hex")}`;

  const steps = TOOL_NAMES.map((toolName, index) => ({
    id: `step-${index + 1}`,
    planRevisionId: "plan-recovery",
    ordinal: index + 1,
    status: index < 8 ? "completed" : index === 8 ? "running" : "pending",
    toolName,
    toolVersion: "1",
    dependencyIdsJson: JSON.stringify(index ? [`step-${index}`] : []),
    inputRefsJson: JSON.stringify([
      { kind: "safe_ref", ref: `step:${Math.max(index, 1)}` }
    ]),
    preconditionsJson: "[]",
    postconditionsJson: JSON.stringify([{ code: "verified", required: true }]),
    effectClass: index === 9 ? "external_stage" : index >= 6 ? "local_write" : "read",
    requiredCapability:
      index === 9 ? "L3_EXTERNAL_STAGE" : index >= 6 ? "L1_ARTIFACT" : "L0_READ",
    acceptanceJson: JSON.stringify({ code: "verified" }),
    replanPolicyJson: JSON.stringify({ on: "failed", action: "stop" }),
    safeSummary: "Safe canonical recovery step.",
    startedAt: null,
    completedAt:
      index < 8 ? new Date("2026-08-13T19:30:00.000Z") : null,
    createdAt: new Date("2026-08-13T19:00:00.000Z")
  }));
  const verificationIds: Record<number, string | null> = {
    6: "verification-integrity",
    7: "verification-composition",
    8: "verification-draft"
  };
  const calls = steps.slice(0, 8).map((step) => ({
    id: `call-${step.ordinal}`,
    taskId: TASK,
    runId: SOURCE_RUN,
    stepId: step.id,
    toolName: step.toolName,
    toolVersion: "1",
    status: "succeeded",
    createdAt: new Date("2026-08-13T19:10:00.000Z"),
    receipt: {
      id: `receipt-${step.ordinal}`,
      status: "succeeded",
      outputHash:
        step.ordinal === 6
          ? hashCourseToolValue(
              "output:evidence.verify_integrity@1",
              integrityOutput as unknown as CourseToolJsonValue
            )
          : step.ordinal === 7
            ? hashCourseToolValue(
                "output:facilitation.intent.compose@1",
                compositionOutput as unknown as CourseToolJsonValue
              )
            : fixtureHash(`output:${step.ordinal}`),
      evidenceRefsJson: JSON.stringify(
        step.ordinal === 6
          ? rawIntegrityEvidence
          : [evidenceRef("manifest", COURSE_ALIAS, manifestHash)]
      ),
      verificationId: verificationIds[step.ordinal] ?? null,
      containsForumText: false,
      containsIdentity: false,
      observedAt: new Date("2026-08-13T19:20:00.000Z")
    }
  }));
  const compositionArtifact = {
    id: compositionVersionId,
    taskId: TASK,
    runId: SOURCE_RUN,
    artifactId: compositionArtifactId,
    version: 1,
    schemaVersion: "cmooc.workbench.artifact-version.v1",
    artifactKind: "facilitation_intent",
    contentClass: "safe_generated",
    contentHash: compositionContentHash,
    draftBodyHash: null,
    contentRef: null,
    safeSummary: "Safe composition metadata.",
    metadataJson: JSON.stringify(compositionMetadata),
    sourceRefsJson: JSON.stringify(compositionEvidence),
    regenerationRecipeJson: null,
    createdByCallId: "call-7",
    expiresAt: new Date(expiresAt),
    createdAt: new Date("2026-08-13T19:30:00.000Z")
  };
  const draftArtifact = {
    id: "draft-version",
    taskId: TASK,
    runId: SOURCE_RUN,
    artifactId: draftArtifactId,
    version: 1,
    schemaVersion: "cmooc.workbench.artifact-version.v1",
    artifactKind: "facilitation_reply_draft",
    contentClass: "restricted_transient",
    contentHash: draftContentHash,
    draftBodyHash,
    contentRef: null,
    safeSummary: "Safe body-free draft recovery metadata.",
    metadataJson: JSON.stringify(draftMetadata),
    sourceRefsJson: JSON.stringify(compositionEvidence),
    regenerationRecipeJson: JSON.stringify(draftRecipe),
    createdByCallId: "call-8",
    expiresAt: new Date(expiresAt),
    createdAt: new Date("2026-08-13T19:35:00.000Z")
  };

  const passedChecks = (codes: readonly string[]) =>
    codes.map((code) => ({
      code,
      status: "passed",
      safeSummary: "Safe mechanical check passed."
    }));
  const verification = (
    id: string,
    subjectType: string,
    subjectId: string,
    codes: readonly string[]
  ) => ({
    id,
    taskId: TASK,
    runId: SOURCE_RUN,
    subjectType,
    subjectId,
    verifier: "verification.course_tool_registry",
    verifierVersion: "1",
    status: "passed",
    safeSummary: "Safe verification.",
    checksJson: JSON.stringify(passedChecks(codes)),
    evidenceRefsJson: JSON.stringify([
      evidenceRef("manifest", COURSE_ALIAS, manifestHash)
    ]),
    observedAt: new Date("2026-08-13T19:40:00.000Z"),
    expiresAt: new Date(expiresAt),
    containsForumText: false,
    containsIdentity: false,
    createdAt: new Date("2026-08-13T19:40:00.000Z")
  });
  const verifications = [
    verification(
      "verification-integrity",
      "tool_result",
      integrityVerificationRef,
      input.tamperIntegrityChecks
        ? ["verification.opportunity_integrity.integrity_reference"]
        : [
            "verification.opportunity_integrity.server_scope_binding",
            "verification.opportunity_integrity.fresh_evidence_replay",
            "verification.opportunity_integrity.integrity_reference",
            "verification.opportunity_integrity.evidence_reference_binding"
          ]
    ),
    verification(
      "verification-composition",
      "artifact_version",
      compositionVersionId,
      [
        "verification.facilitation_intent.intent_movespec_hashes",
        "verification.facilitation_intent.artifact_content_hash",
        "verification.facilitation_intent.verified_evidence_binding",
        "verification.facilitation_intent.policy_domain_binding"
      ]
    ),
    verification(
      "verification-draft",
      "artifact_version",
      draftArtifact.id,
      [
        "verification.facilitation_reply_draft.protected_body_hash",
        "verification.facilitation_reply_draft.restricted_transient_boundary",
        "verification.facilitation_reply_draft.privacy_claim_lint"
      ]
    )
  ];
  const revalidationReceipt = {
    schemaVersion: "cmooc.autonomy-draft-revalidation.v1",
    afterObservationReceiptHash: fixtureHash("after-observation"),
    targetVersionHash: fixtureHash("target-version")
  };
  const revalidationReceiptHash = canonicalProtocolHash(
    revalidationReceipt.schemaVersion,
    revalidationReceipt as CanonicalJsonValue
  );
  const decision = {
    id: decisionId,
    courseAlias: COURSE_ALIAS,
    threadKey: "thread-recovery",
    decision: "draft",
    decisionMode: "DRAFT_ELIGIBLE",
    reasonCode: "draft_eligible",
    opportunityReceiptHash,
    observationReceiptHash: fixtureHash("observation-receipt"),
    intentHash,
    moveSpecHash,
    policyVersion: LIVE_FACILITATION_POLICY_VERSION,
    decisionJson: JSON.stringify({
      candidateKey,
      revalidationReceipt,
      revalidationReceiptHash,
      semanticReceiptHash: fixtureHash("semantic-receipt"),
      semanticReceipt: {
        targetVersionHash: revalidationReceipt.targetVersionHash
      }
    }),
    bodyPersisted: false,
    publishAttempted: false,
    editorWriteAttempted: false
  };
  const plan = {
    id: "plan-recovery",
    taskId: TASK,
    runId: SOURCE_RUN,
    revision: 1,
    objectiveHash,
    source: "server_compiler",
    compilerVersion: COURSE_AGENT_PLAN_COMPILER_VERSION,
    proposalHash: null,
    safeSummary: "Safe canonical recovery plan.",
    createdAt: new Date("2026-08-13T19:00:00.000Z"),
    steps
  };
  const queriedRunIds: string[] = [];
  let planReads = 0;
  let writes = 0;
  const db = {
    workbenchRunRecord: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        queriedRunIds.push(where.id);
        return {
          taskId: TASK,
          status: "failed",
          task: {
            safeObjective: {
              schemaVersion: WORKBENCH_SAFE_OBJECTIVE_SCHEMA_VERSION,
              objectiveHash,
              structuredGoalJson: JSON.stringify({
                goalCode: "course_evidence_support_gap",
                courseAlias: COURSE_ALIAS,
                policyVersion: COURSE_TOOL_POLICY_VERSION
              }),
              source: COURSE_AGENT_OBJECTIVE_CLASSIFIER_VERSION,
              expiresAt: new Date(expiresAt)
            }
          }
        };
      },
      create: async () => {
        writes += 1;
        throw new Error("loader must remain read-only");
      }
    },
    workbenchPlanRevisionRecord: {
      findMany: async () => {
        planReads += 1;
        return input.driftOnConfirmation && planReads === 2 ? [] : [plan];
      }
    },
    workbenchToolCallRecord: { findMany: async () => calls },
    workbenchCourseToolActionRecord: { findMany: async () => [] },
    workbenchVerificationRecord: { findMany: async () => verifications },
    workbenchArtifactVersionRecord: {
      findMany: async () => [compositionArtifact, draftArtifact]
    },
    workbenchStageTransactionRecord: {
      findMany: async () => [],
      count: async () => 0
    },
    autonomyDecision: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === decisionId ? decision : null
    }
  } as unknown as WorkbenchDb;
  return {
    db,
    queriedRunIds,
    planReads: () => planReads,
    writes: () => writes,
    integrityVerificationRef,
    compositionPointer,
    draftContentHash,
    draftBodyHash,
    decisionMaterial: Object.freeze({
      decisionId,
      threadKey: decision.threadKey,
      candidateKey,
      opportunityId: integrityOutput.opportunityId,
      targetVersionHash: revalidationReceipt.targetVersionHash,
      eventSetHash: fixtureHash("event-set"),
      opportunityReceiptHash,
      integrityVerificationRef,
      revalidationReceiptHash,
      afterObservationReceiptHash:
        revalidationReceipt.afterObservationReceiptHash,
      intentHash,
      moveSpecHash,
      evidenceBindingHash
    })
  };
}

function scopeDb(input: {
  sourceStatus?: string;
  sourceTaskId?: string;
  planRows?: readonly unknown[];
}) {
  const queriedRunIds: string[] = [];
  let writes = 0;
  const db = {
    workbenchRunRecord: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        queriedRunIds.push(where.id);
        return {
          taskId: input.sourceTaskId ?? "task-recovery",
          status: input.sourceStatus ?? "failed",
          task: { safeObjective: null }
        };
      },
      create: async () => {
        writes += 1;
        throw new Error("loader must remain read-only");
      }
    },
    workbenchPlanRevisionRecord: {
      findMany: async () => input.planRows ?? []
    }
  } as unknown as WorkbenchDb;
  return { db, queriedRunIds, writes: () => writes };
}

function load(
  db: WorkbenchDb,
  overrides: Partial<Parameters<typeof loadVerifiedCourseAgentRecoveryBundle>[1]> = {},
  dependencies: Parameters<typeof loadVerifiedCourseAgentRecoveryBundle>[2] = {}
) {
  return loadVerifiedCourseAgentRecoveryBundle(db, {
    taskId: "task-recovery",
    sourceRunId: "run-parent-failed",
    childRunId: "run-child-not-created-yet",
    courseAlias: "course-safe",
    now: NOW,
    ...overrides
  }, dependencies);
}

test("loader runs before child creation and unsupported checkpoint exposes typed state without writes", async () => {
  const fixture = scopeDb({});
  await assert.rejects(
    load(fixture.db),
    (error: unknown) => {
      assert.ok(error instanceof CourseAgentCheckpointHydratorError);
      assert.equal(error.code, "COURSE_AGENT_RECOVERY_CHECKPOINT_UNSUPPORTED");
      assert.equal(error.checkpointState, "none");
      assert.equal(error.checkpointReasonCode, "canonical_plan_absent");
      return true;
    }
  );
  assert.deepEqual(fixture.queriedRunIds, ["run-parent-failed", "run-parent-failed"]);
  assert.equal(
    fixture.queriedRunIds.includes("run-child-not-created-yet"),
    false
  );
  assert.equal(fixture.writes(), 0);
});

test("loader rejects a non-failed source before checkpoint or child lookup", async () => {
  const fixture = scopeDb({ sourceStatus: "running" });
  await assert.rejects(
    load(fixture.db),
    (error: unknown) =>
      error instanceof CourseAgentCheckpointHydratorError &&
      error.code === "COURSE_AGENT_RECOVERY_SOURCE_RUN_NOT_FAILED" &&
      error.checkpointState === null
  );
  assert.deepEqual(fixture.queriedRunIds, ["run-parent-failed"]);
  assert.equal(fixture.writes(), 0);
});

test("loader rejects same-run recovery and caller-bound checkpoint mismatch without mutations", async () => {
  const sameRun = scopeDb({});
  await assert.rejects(
    load(sameRun.db, { childRunId: "run-parent-failed" }),
    (error: unknown) =>
      error instanceof CourseAgentCheckpointHydratorError &&
      error.code === "COURSE_AGENT_RECOVERY_CHILD_SCOPE_INVALID"
  );
  assert.deepEqual(sameRun.queriedRunIds, []);

  const mismatch = scopeDb({});
  await assert.rejects(
    load(mismatch.db, {
      expectedCheckpointRef: `course-checkpoint:${"a".repeat(64)}`
    }),
    (error: unknown) => {
      assert.ok(error instanceof CourseAgentCheckpointHydratorError);
      assert.equal(error.code, "COURSE_AGENT_RECOVERY_CHECKPOINT_REF_MISMATCH");
      assert.equal(error.checkpointState, "none");
      return true;
    }
  );
  assert.equal(mismatch.writes(), 0);
});

test("loader rebuilds an exact body-free recovery bundle before the child row exists", async () => {
  const fixture = successfulRecoveryDb();
  const bundle = await load(fixture.db, {}, {
    loadVerifiedDecisionMaterial: async () => fixture.decisionMaterial
  });

  assert.equal(bundle.checkpoint.state, "draft_regeneration_required");
  assert.equal(
    bundle.checkpoint.reasonCode,
    "fresh_stage_requires_regenerated_body"
  );
  assert.equal(bundle.source.sourceRunId, SOURCE_RUN);
  assert.equal(bundle.source.childRunId, CHILD_RUN);
  assert.equal(bundle.source.courseAlias, COURSE_ALIAS);
  assert.equal(
    bundle.source.composition.output.compositionRef,
    fixture.compositionPointer.versionRef
  );
  assert.equal(
    bundle.source.integrity.output.integrityVerificationRef,
    fixture.integrityVerificationRef
  );
  assert.equal(
    bundle.source.draftRecovery?.artifact.contentHash,
    fixture.draftContentHash
  );
  assert.equal(
    bundle.source.draftRecovery?.artifact.draftBodyHash,
    fixture.draftBodyHash
  );
  assert.equal(bundle.source.draftRecovery?.artifact.bodyPersisted, false);
  assert.equal(bundle.runtimeRecovery.verifiedCheckpointSource, bundle.source);
  assert.equal(fixture.planReads(), 2);
  assert.deepEqual(fixture.queriedRunIds, [
    SOURCE_RUN,
    SOURCE_RUN,
    SOURCE_RUN
  ]);
  assert.equal(fixture.queriedRunIds.includes(CHILD_RUN), false);
  assert.equal(fixture.writes(), 0);
  assert.equal(JSON.stringify(bundle).includes("protected-draft:"), false);
});

test("loader fails closed when the checkpoint drifts during material loading", async () => {
  const fixture = successfulRecoveryDb({ driftOnConfirmation: true });

  await assert.rejects(
    load(fixture.db, {}, {
      loadVerifiedDecisionMaterial: async () => fixture.decisionMaterial
    }),
    (error: unknown) => {
      assert.ok(error instanceof CourseAgentCheckpointHydratorError);
      assert.equal(
        error.code,
        "COURSE_AGENT_RECOVERY_CHECKPOINT_CHANGED_DURING_LOAD"
      );
      assert.equal(error.checkpointState, "none");
      assert.equal(error.checkpointReasonCode, "canonical_plan_absent");
      return true;
    }
  );
  assert.equal(fixture.planReads(), 2);
  assert.equal(fixture.queriedRunIds.includes(CHILD_RUN), false);
  assert.equal(fixture.writes(), 0);
});

test("loader rejects a passed verification row with tampered required checks", async () => {
  const fixture = successfulRecoveryDb({ tamperIntegrityChecks: true });

  await assert.rejects(
    load(fixture.db, {}, {
      loadVerifiedDecisionMaterial: async () => fixture.decisionMaterial
    }),
    (error: unknown) =>
      error instanceof CourseAgentCheckpointHydratorError &&
      error.code === "COURSE_AGENT_RECOVERY_VERIFICATION_CONTRACT_GAP" &&
      error.checkpointState === "draft_regeneration_required"
  );
  assert.equal(fixture.writes(), 0);
});
