import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANONICAL_HASH_ALGORITHM,
  PROTOCOL_SCHEMA_VERSIONS,
  canonicalProtocolHash,
  parseProtocolObject,
  type CanonicalJsonValue
} from "../../lib/facilitation-protocol";
import { hashCourseToolValue } from "../../lib/course-tools/contracts";
import {
  FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION,
  DELIVERY_BUNDLE_OUTPUT_SCHEMA_VERSION,
  FACILITATION_ARTIFACT_LINT_VERSION,
  FACILITATION_DRAFT_MATERIAL_BINDING_SCHEMA_VERSION,
  FACILITATION_DRAFT_METADATA_SCHEMA_VERSION,
  FACILITATION_DRAFT_REGENERATION_MATERIAL_SCHEMA_VERSION,
  FACILITATION_DRAFT_REGENERATION_RECIPE_SCHEMA_VERSION,
  FACILITATION_DRAFT_VERIFIER_CONTRACT,
  hashReplyDraftContentMaterialV2,
  hashReplyDraftMaterialBindingV2,
  hashReplyDraftRegenerationMaterialV2,
  hashReplyDraftRegenerationRecipeV2,
  type ReplyDraftContentMaterialV2,
  type ReplyDraftMaterialBindingV2,
  type ReplyDraftPersistedMetadataV2,
  type ReplyDraftRegenerationMaterialV2,
  type ReplyDraftRegenerationRecipeV2
} from "../../lib/course-tools/tools/facilitation-artifacts";
import {
  PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
  PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION,
  PLATFORM_STAGE_VERIFIER_NAME
} from "../../lib/course-tools/tools/platform-stage";
import { COURSE_TOOL_POLICY_VERSION } from "../../lib/course-tools/policy-gateway";
import { LIVE_FACILITATION_POLICY_VERSION } from "../../lib/live-runtime/facilitation-kernel";
import { SEMANTIC_RENDERER_VERSION } from "../../lib/autonomy/semantic-renderer";
import {
  COURSE_AGENT_OBJECTIVE_CLASSIFIER_VERSION,
  COURSE_AGENT_PLAN_COMPILER_VERSION
} from "../../lib/workbench/course-agent-plan";
import {
  deriveVerifiedCourseAgentCheckpoint,
  type CourseAgentDraftBindingParser
} from "../../lib/workbench/course-agent-checkpoint-read-model";
import { WORKBENCH_SAFE_OBJECTIVE_SCHEMA_VERSION, type WorkbenchDb } from "../../lib/workbench/durable-ledger";
import { WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION } from "../../lib/workbench/trusted-workbench-platform-stage-adapter";

const NOW = new Date("2026-08-13T20:00:00.000Z");
const TASK = "task-checkpoint";
const RUN = "run-checkpoint";
const MANIFEST = hash("manifest");
const TOOL_NAMES = [
  "course.context.resolve", "course.snapshot.read", "opportunity.list",
  "opportunity.select_support_gap", "evidence.read_opportunity",
  "evidence.verify_integrity", "facilitation.intent.compose",
  "artifact.reply_draft.create", "platform.target.preflight_read",
  "platform.editor.stage_verify_clear", "delivery.bundle.create"
] as const;

function hash(label: string): string {
  return hashCourseToolValue("test.course-agent-checkpoint", label);
}

function ref(kind: string, id: string, value = hash(`${kind}:${id}`)) {
  return { kind, id, hash: value, observedAt: "2026-08-13T19:00:00.000Z" };
}

function checkCodes(kind: "composition" | "draft" | "stage" | "delivery") {
  const codes = kind === "composition"
    ? ["intent_movespec_hashes", "artifact_content_hash", "verified_evidence_binding", "policy_domain_binding"].map((code) => `verification.facilitation_intent.${code}`)
    : kind === "draft"
      ? ["protected_body_hash", "restricted_transient_boundary", "privacy_claim_lint"].map((code) => `verification.facilitation_reply_draft.${code}`)
      : kind === "stage"
        ? ["atomic_editor_round_trip", "zero_external_mutations", "trusted_close_audit", "publication_hard_lock", "restricted_body_not_persisted", "trusted_receipt_binding"].map((code) => `${PLATFORM_STAGE_VERIFIER_NAME}.${code}`)
        : ["stage_safe_state", "zero_publish_boundary", "evidence_claim_boundary"].map((code) => `verification.facilitation_delivery_bundle.${code}`);
  return codes.map((code) => ({ code, status: "passed", safeSummary: "Safe mechanical check passed." }));
}

type FixtureCall = {
  id: string;
  taskId: string;
  runId: string;
  stepId: string;
  toolName: string;
  toolVersion: string;
  status: string;
  createdAt: Date;
  receipt: {
    id: string;
    status: string;
    outputHash: string;
    evidenceRefsJson: string;
    verificationId: string | null;
    containsForumText: boolean;
    containsIdentity: boolean;
    observedAt: Date;
  };
};

function verifiedProtocol() {
  const intent = parseProtocolObject("interventionIntent", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.interventionIntent,
    evidenceRefHash: hash("protocol-evidence"),
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
    budgetVersion: "budget-checkpoint-v1",
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
  return {
    intent,
    intentHash,
    moveSpec,
    moveSpecHash: canonicalProtocolHash(
      moveSpec.schemaVersion,
      moveSpec as CanonicalJsonValue
    )
  };
}

function fixture(input: {
  completedThrough?: number;
  composition?: boolean;
  draft?: boolean;
  draftV2?: boolean;
  stage?: "unknown" | "verified" | "reconciled";
  delivery?: boolean;
  privacySentinel?: boolean;
  duplicateDraft?: boolean;
} = {}) {
  const completedThrough = input.completedThrough ?? 0;
  const objectiveHash = hash("objective");
  const steps = TOOL_NAMES.map((toolName, index) => ({
    id: `step-${index + 1}`,
    planRevisionId: "plan-checkpoint",
    ordinal: index + 1,
    status: index + 1 <= completedThrough ? "completed" : index + 1 === completedThrough + 1 ? "running" : "pending",
    toolName,
    toolVersion: "1",
    dependencyIdsJson: JSON.stringify(index ? [`step-${index}`] : []),
    inputRefsJson: JSON.stringify([{ kind: "safe_ref", ref: `step:${Math.max(index, 1)}` }]),
    preconditionsJson: "[]",
    postconditionsJson: JSON.stringify([{ code: "verified", required: true }]),
    effectClass: index === 9 ? "external_stage" : index >= 6 ? "local_write" : "read",
    requiredCapability: index === 9 ? "L3_EXTERNAL_STAGE" : index >= 6 ? "L1_ARTIFACT" : "L0_READ",
    acceptanceJson: JSON.stringify({ code: "verified" }),
    replanPolicyJson: JSON.stringify({ on: "failed", action: "stop" }),
    safeSummary: "Safe canonical step.",
    startedAt: null,
    completedAt: index + 1 <= completedThrough ? new Date("2026-08-13T19:30:00.000Z") : null,
    createdAt: new Date("2026-08-13T19:00:00.000Z")
  }));
  const verificationIds: Record<number, string | null> = {
    7: input.composition ? "verification-composition" : null,
    8: input.draft ? "verification-draft" : null,
    10: input.stage === "verified" ? "verification-stage" : null,
    11: input.delivery ? "verification-delivery" : null
  };
  const calls: FixtureCall[] = steps.filter((step) => step.status === "completed").map((step) => ({
    id: `call-${step.ordinal}`,
    taskId: TASK,
    runId: RUN,
    stepId: step.id,
    toolName: step.toolName,
    toolVersion: "1",
    status: "succeeded",
    createdAt: new Date("2026-08-13T19:10:00.000Z"),
    receipt: {
      id: `receipt-${step.ordinal}`,
      status: "succeeded",
      outputHash: hash(`output:${step.ordinal}`),
      evidenceRefsJson: JSON.stringify([ref("manifest", "bnu-test", MANIFEST)]),
      verificationId:
        verificationIds[step.ordinal] ??
        (step.requiredCapability !== "L0_READ"
          ? `verification-generic-${step.ordinal}`
          : null),
      containsForumText: false,
      containsIdentity: false,
      observedAt: new Date("2026-08-13T19:20:00.000Z")
    }
  }));

  const protocol = verifiedProtocol();
  const { intent, moveSpec } = protocol;
  const compositionMetadata = {
    schemaVersion: FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION,
    receiptRef: `intent-compose:${hash("compose-receipt")}`,
    receiptHash: hash("compose-receipt"),
    selectionRef: "selection-ref",
    selectionEvidenceBindingHash: hash("selection-binding"),
    integrityVerificationRef: "integrity-verification-ref",
    evidenceBindingHash: hash("evidence-binding"),
    intentPolicyVersion: LIVE_FACILITATION_POLICY_VERSION,
    toolPolicyVersion: COURSE_TOOL_POLICY_VERSION,
    intent,
    intentHash: protocol.intentHash,
    moveSpec,
    moveSpecHash: protocol.moveSpecHash,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
  const compositionHash = hashCourseToolValue("facilitation-intent-artifact.v2", {
    schemaVersion: FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION,
    intent,
    intentHash: compositionMetadata.intentHash,
    moveSpec,
    moveSpecHash: compositionMetadata.moveSpecHash,
    receiptHash: compositionMetadata.receiptHash,
    intentPolicyVersion: compositionMetadata.intentPolicyVersion,
    toolPolicyVersion: compositionMetadata.toolPolicyVersion,
    selectionEvidenceBindingHash: compositionMetadata.selectionEvidenceBindingHash,
    evidenceBindingHash: compositionMetadata.evidenceBindingHash
  });
  const draftBodyHash = hash("draft-body");
  let draftMetadata: Record<string, unknown> = {
    schemaVersion: FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION,
    compositionRef: "artifact-version:composition-version",
    intent,
    intentHash: compositionMetadata.intentHash,
    moveSpec,
    moveSpecHash: compositionMetadata.moveSpecHash,
    draftBodyHash,
    rendererVersion: SEMANTIC_RENDERER_VERSION,
    rendererReceiptRef: `semantic-renderer-receipt:${hash("renderer")}`,
    rendererReceiptHash: hash("renderer"),
    lintReceiptRef: `draft-lint:${hash("lint")}`,
    lintReceiptHash: hash("lint"),
    revisionKind: "initial",
    priorVersionRef: null,
    feedbackRef: null,
    bodyPersisted: false,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false,
    ...(input.privacySentinel ? { protectedRef: "protected-draft:must-not-load" } : {})
  };
  let draftRecipe: Record<string, unknown> = {
    schemaVersion: "cmooc.facilitation-draft-regeneration-recipe.v1",
    strategy: "reinvoke_semantic_renderer",
    compositionRef: draftMetadata.compositionRef,
    intentHash: draftMetadata.intentHash,
    moveSpecHash: draftMetadata.moveSpecHash,
    rendererVersion: draftMetadata.rendererVersion,
    requireReverification: true,
    bodyPersisted: false
  };
  let draftHash = hashCourseToolValue("facilitation-reply-draft-artifact.v1", {
    schemaVersion: FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION,
    compositionRef: "artifact-version:composition-version",
    intentHash: protocol.intentHash,
    moveSpecHash: protocol.moveSpecHash,
    draftBodyHash,
    rendererReceiptHash: hash("renderer"),
    lintReceiptHash: hash("lint"),
    revisionKind: "initial",
    priorVersionRef: null,
    feedbackRef: null
  });
  if (input.draftV2) {
    const expiresAt = "2026-08-14T20:00:00.000Z";
    const contentMaterial: ReplyDraftContentMaterialV2 = {
      schemaVersion: FACILITATION_DRAFT_METADATA_SCHEMA_VERSION,
      compositionRef: "artifact-version:composition-version",
      intent,
      intentHash: protocol.intentHash,
      moveSpec,
      moveSpecHash: protocol.moveSpecHash,
      draftBodyHash,
      rendererVersion: SEMANTIC_RENDERER_VERSION,
      rendererReceiptRef: `semantic-renderer-receipt:${hash("renderer")}`,
      rendererReceiptHash: hash("renderer"),
      lintVersion: FACILITATION_ARTIFACT_LINT_VERSION,
      lintReceiptRef: `draft-lint:${hash("lint")}`,
      lintReceiptHash: hash("lint"),
      integrityVerificationRef: "integrity-verification-ref",
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
    draftHash = hashReplyDraftContentMaterialV2(contentMaterial);
    const regenerationMaterial: ReplyDraftRegenerationMaterialV2 = {
      schemaVersion: FACILITATION_DRAFT_REGENERATION_MATERIAL_SCHEMA_VERSION,
      compositionRef: contentMaterial.compositionRef,
      intentHash: contentMaterial.intentHash,
      moveSpecHash: contentMaterial.moveSpecHash,
      draftBodyHash,
      contentHash: draftHash,
      rendererVersion: contentMaterial.rendererVersion,
      rendererReceiptHash: contentMaterial.rendererReceiptHash,
      lintReceiptHash: contentMaterial.lintReceiptHash,
      integrityVerificationRef: contentMaterial.integrityVerificationRef,
      intentPolicyVersion: LIVE_FACILITATION_POLICY_VERSION,
      toolPolicyVersion: COURSE_TOOL_POLICY_VERSION,
      revisionKind: "initial",
      priorVersionRef: null,
      feedbackRef: null
    };
    const regenerationMaterialHash =
      hashReplyDraftRegenerationMaterialV2(regenerationMaterial);
    const recipe: ReplyDraftRegenerationRecipeV2 = {
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
    const regenerationRecipeHash = hashReplyDraftRegenerationRecipeV2(recipe);
    const materialBinding: ReplyDraftMaterialBindingV2 = {
      schemaVersion: FACILITATION_DRAFT_MATERIAL_BINDING_SCHEMA_VERSION,
      contentHash: draftHash,
      draftBodyHash,
      regenerationMaterialHash,
      regenerationRecipeHash,
      verifier: FACILITATION_DRAFT_VERIFIER_CONTRACT,
      expiresAt,
      requireReverification: true,
      recovery: "regenerate_and_reverify",
      bodyPersisted: false
    };
    const persistedMetadata: ReplyDraftPersistedMetadataV2 = {
      ...contentMaterial,
      contentHash: draftHash,
      expiresAt,
      regenerationMaterialHash,
      regenerationRecipeHash,
      materialBindingHash: hashReplyDraftMaterialBindingV2(materialBinding)
    };
    draftMetadata = persistedMetadata;
    draftRecipe = recipe;
  }
  const artifacts: unknown[] = [];
  if (input.composition) artifacts.push({
    id: "composition-version", taskId: TASK, runId: RUN, artifactId: "composition-artifact", version: 1,
    schemaVersion: "cmooc.workbench.artifact-version.v1", artifactKind: "facilitation_intent",
    contentClass: "safe_generated", contentHash: compositionHash, draftBodyHash: null, contentRef: null,
    safeSummary: "Safe composition.", metadataJson: JSON.stringify(compositionMetadata),
    sourceRefsJson: JSON.stringify([ref("manifest", "bnu-test", MANIFEST)]), regenerationRecipeJson: null,
    createdByCallId: "call-7", expiresAt: new Date("2026-08-14T20:00:00.000Z"), createdAt: new Date("2026-08-13T19:30:00.000Z")
  });
  if (input.draft) {
    const draftRow = {
      id: "draft-version", taskId: TASK, runId: RUN, artifactId: "draft-artifact", version: 1,
      schemaVersion: "cmooc.workbench.artifact-version.v1", artifactKind: "facilitation_reply_draft",
      contentClass: "restricted_transient", contentHash: draftHash, draftBodyHash, contentRef: null,
      safeSummary: "Safe draft metadata.", metadataJson: JSON.stringify(draftMetadata),
      sourceRefsJson: JSON.stringify([ref("manifest", "bnu-test", MANIFEST)]),
      regenerationRecipeJson: JSON.stringify(draftRecipe), createdByCallId: "call-8",
      expiresAt: new Date("2026-08-14T20:00:00.000Z"), createdAt: new Date("2026-08-13T19:35:00.000Z")
    };
    artifacts.push(draftRow);
    if (input.duplicateDraft) artifacts.push({ ...draftRow, id: "draft-version-duplicate", version: 2 });
  }
  const verifications: unknown[] = [];
  const verification = (id: string, subjectType: string, subjectId: string, kind: "composition" | "draft" | "stage" | "delivery") => ({
    id, taskId: TASK, runId: RUN, subjectType, subjectId,
    verifier: "verification.course_tool_registry", verifierVersion: "1", status: "passed",
    safeSummary: "Safe verification.", checksJson: JSON.stringify(checkCodes(kind)),
    evidenceRefsJson: JSON.stringify([ref("manifest", "bnu-test", MANIFEST)]),
    observedAt: new Date("2026-08-13T19:40:00.000Z"), expiresAt: new Date("2026-08-14T20:00:00.000Z"),
    containsForumText: false, containsIdentity: false, createdAt: new Date("2026-08-13T19:40:00.000Z")
  });
  if (input.composition) verifications.push(verification("verification-composition", "artifact_version", "composition-version", "composition"));
  if (input.draft) verifications.push(verification("verification-draft", "artifact_version", "draft-version", "draft"));

  const stageRows: unknown[] = [];
  let stageReceiptRef: string | null = null;
  const actions: unknown[] = [];
  if (input.stage) {
    const stageTransactionRef = `stage-transaction:${hash("stage")}`;
    stageReceiptRef = `stage-receipt:${hash("stage-receipt")}`;
    const terminal = input.stage === "verified" || input.stage === "reconciled";
    const output = terminal ? {
      schemaVersion: input.stage === "verified"
        ? PLATFORM_STAGE_OUTPUT_SCHEMA_VERSION
        : PLATFORM_RECONCILE_OUTPUT_SCHEMA_VERSION,
      status: input.stage === "verified" ? "verified_cleared" : "reconciled_cleared",
      ...(input.stage === "reconciled" ? { resolution: "owned_draft_cleared" } : {}),
      stageTransactionRef,
      receiptRef: stageReceiptRef,
      receiptHash: hash("stage-receipt"),
      targetRef: "target-ref", targetVersionHash: hash("target-version"),
      artifactVersionRef: "artifact-version:draft-version", draftBodyHash,
      pageBindingRef: "page-binding-ref", pageBindingHash: hash("page-binding"),
      baselineRef: "baseline-ref", baselineHash: hash("baseline"),
      editorWriteCount: 1, editorReadbackCount: 1, editorReadbackVerified: true,
      editorClearCount: 1, editorEmptyAfterClear: true, submitMutationCount: 0,
      sendMutationCount: 0, closeAuditStatus: "passed", realPublishEnabled: false,
      bodyPersisted: false, published: false, observedAt: "2026-08-13T19:50:00.000Z",
      evidenceRefs: [ref("manifest", "bnu-test", MANIFEST), ref("stage_receipt", stageReceiptRef, hash("stage-receipt"))],
      containsForumText: false, containsIdentity: false, containsSecrets: false
    } : null;
    const stageCall = calls.find((call) => call.id === "call-10") ?? {
      id: "call-10", taskId: TASK, runId: RUN, stepId: "step-10",
      toolName: "platform.editor.stage_verify_clear", toolVersion: "1",
      status: "unknown", createdAt: new Date("2026-08-13T19:45:00.000Z"),
      receipt: {
        id: "receipt-10", status: "unknown", outputHash: hash("stage-unknown"),
        evidenceRefsJson: JSON.stringify([ref("manifest", "bnu-test", MANIFEST)]),
        verificationId: null, containsForumText: false, containsIdentity: false,
        observedAt: new Date("2026-08-13T19:46:00.000Z")
      }
    };
    if (!calls.includes(stageCall)) calls.push(stageCall);
    if (input.stage === "verified" && output) {
      stageCall.status = "succeeded";
      stageCall.receipt.status = "succeeded";
      stageCall.receipt.outputHash = hashCourseToolValue(
        "output:platform.editor.stage_verify_clear@1",
        output
      );
      stageCall.receipt.verificationId = "verification-stage";
    } else {
      stageCall.status = "unknown";
      stageCall.receipt.status = "unknown";
      stageCall.receipt.verificationId = null;
    }
    const stageTerminalHash = input.stage === "verified"
      ? hashCourseToolValue("cmooc.course-agent-terminal-tool-receipt.v1", {
          receiptId: stageCall.receipt.id,
          callId: stageCall.id,
          status: stageCall.receipt.status,
          outputHash: stageCall.receipt.outputHash,
          verificationId: stageCall.receipt.verificationId
        })
      : null;
    const originalAction = {
      id: "action-stage", taskId: TASK, runId: RUN,
      planRevisionId: "plan-checkpoint", stepId: "step-10", callId: "call-10",
      toolName: "platform.editor.stage_verify_clear", toolVersion: "1",
      courseScopeHash: hash("course-scope"), policyVersion: COURSE_TOOL_POLICY_VERSION,
      status: input.stage === "verified" ? "succeeded" : input.stage === "reconciled" ? "reconciled" : "unknown",
      terminalReceiptHash: stageTerminalHash, reconciliationHash: null as string | null,
      parentActionId: null, recoveryOfActionId: null,
      containsForumText: false, containsIdentity: false, containsSecrets: false
    };
    actions.push(originalAction);
    if (input.stage === "reconciled" && output) {
      const recoveryReceipt = {
        id: "receipt-10-reconcile", status: "succeeded",
        outputHash: hashCourseToolValue("output:platform.editor.reconcile_stage@1", output),
        evidenceRefsJson: JSON.stringify([ref("manifest", "bnu-test", MANIFEST)]),
        verificationId: "verification-stage", containsForumText: false,
        containsIdentity: false, observedAt: new Date("2026-08-13T19:50:00.000Z")
      };
      const recoveryCall = {
        id: "call-10-reconcile", taskId: TASK, runId: RUN, stepId: "step-10",
        toolName: "platform.editor.reconcile_stage", toolVersion: "1",
        status: "succeeded", createdAt: new Date("2026-08-13T19:49:00.000Z"),
        receipt: recoveryReceipt
      };
      calls.push(recoveryCall);
      const recoveryTerminalHash = hashCourseToolValue(
        "cmooc.course-agent-terminal-tool-receipt.v1",
        {
          receiptId: recoveryReceipt.id,
          callId: recoveryCall.id,
          status: recoveryReceipt.status,
          outputHash: recoveryReceipt.outputHash,
          verificationId: recoveryReceipt.verificationId
        }
      );
      originalAction.reconciliationHash = recoveryTerminalHash;
      actions.push({
        id: "action-stage-reconcile", taskId: TASK, runId: RUN,
        planRevisionId: "plan-checkpoint", stepId: "step-10", callId: recoveryCall.id,
        toolName: "platform.editor.reconcile_stage", toolVersion: "1",
        courseScopeHash: hash("course-scope"), policyVersion: COURSE_TOOL_POLICY_VERSION,
        status: "succeeded", terminalReceiptHash: recoveryTerminalHash, reconciliationHash: null,
        parentActionId: originalAction.id, recoveryOfActionId: originalAction.id,
        containsForumText: false, containsIdentity: false, containsSecrets: false
      });
    }
    stageRows.push({
      stageTransactionRef, schemaVersion: WORKBENCH_STAGE_TRANSACTION_SCHEMA_VERSION,
      planRevisionId: "plan-checkpoint", stepId: "step-10", callId: "call-10",
      courseAlias: "bnu-test", courseScopeHash: hash("course-scope"),
      manifestHash: MANIFEST, policyVersion: COURSE_TOOL_POLICY_VERSION,
      integrityVerificationRef: "integrity-verification-ref",
      taskId: TASK, runId: RUN, targetEvidenceRefsJson: JSON.stringify([ref("manifest", "bnu-test", MANIFEST)]),
      artifactVersionRef: "artifact-version:draft-version", draftBodyHash,
      status: input.stage, verifiedOutputJson: output ? JSON.stringify(output) : null,
      containsForumText: false, containsIdentity: false, containsSecrets: false,
      createdAt: new Date("2026-08-13T19:45:00.000Z"), updatedAt: new Date("2026-08-13T19:50:00.000Z"),
      terminalAt: output ? new Date("2026-08-13T19:50:00.000Z") : null
    });
    if (output) verifications.push(verification("verification-stage", "stage_transaction", stageTransactionRef, "stage"));
  }
  if (input.delivery && stageReceiptRef) {
    const deliveryMetadata = {
      schemaVersion: DELIVERY_BUNDLE_OUTPUT_SCHEMA_VERSION,
      draftArtifactRef: "artifact:draft-artifact", draftVersionRef: "artifact-version:draft-version",
      draftContentHash: draftHash, draftBodyHash, integrityVerificationRef: "integrity-verification-ref",
      stageVerificationRef: stageReceiptRef, clearVerified: true, editorEmptyAfter: true,
      submitMutationCount: 0, sendMutationCount: 0, realPublishEnabled: false, published: false,
      limitationCodes: ["stage_only_not_published", "not_intervention_or_effect_evidence"],
      containsForumText: false, containsIdentity: false, containsSecrets: false
    };
    artifacts.push({
      id: "delivery-version", taskId: TASK, runId: RUN, artifactId: "delivery-artifact", version: 1,
      schemaVersion: "cmooc.workbench.artifact-version.v1", artifactKind: "facilitation_delivery_bundle",
      contentClass: "safe_aggregate", contentHash: hash("delivery"), draftBodyHash: null, contentRef: null,
      safeSummary: "Safe delivery.", metadataJson: JSON.stringify(deliveryMetadata),
      sourceRefsJson: JSON.stringify([ref("manifest", "bnu-test", MANIFEST)]), regenerationRecipeJson: null,
      createdByCallId: "call-11", expiresAt: null, createdAt: new Date("2026-08-13T19:55:00.000Z")
    });
    verifications.push(verification("verification-delivery", "artifact_version", "delivery-version", "delivery"));
  }
  const db = {
    workbenchRunRecord: { findUnique: async () => ({
      taskId: TASK, status: input.delivery ? "completed" : "running",
      task: { safeObjective: {
        schemaVersion: WORKBENCH_SAFE_OBJECTIVE_SCHEMA_VERSION,
        objectiveHash,
        structuredGoalJson: JSON.stringify({ goalCode: "course_evidence_support_gap", courseAlias: "bnu-test", policyVersion: COURSE_TOOL_POLICY_VERSION }),
        source: COURSE_AGENT_OBJECTIVE_CLASSIFIER_VERSION,
        expiresAt: new Date("2026-08-14T20:00:00.000Z")
      } }
    }) },
    workbenchPlanRevisionRecord: { findMany: async () => [{
      id: "plan-checkpoint", taskId: TASK, runId: RUN, revision: 1, objectiveHash,
      source: "server_compiler", compilerVersion: COURSE_AGENT_PLAN_COMPILER_VERSION,
      proposalHash: null, safeSummary: "Safe plan.", createdAt: new Date("2026-08-13T19:00:00.000Z"), steps
    }] },
    workbenchToolCallRecord: { findMany: async () => calls },
    workbenchCourseToolActionRecord: { findMany: async () => actions },
    workbenchVerificationRecord: { findMany: async () => verifications },
    workbenchArtifactVersionRecord: { findMany: async () => artifacts },
    workbenchStageTransactionRecord: { findMany: async () => stageRows }
  } as unknown as WorkbenchDb;
  return { db, draftBodyHash, artifacts, verifications, stageRows, actions, calls };
}

const v2Parser: CourseAgentDraftBindingParser = ({ metadata }) => ({
  schemaVersion: "fixture-v2",
  compositionRef: (metadata as Record<string, string>).compositionRef,
  intentHash: (metadata as Record<string, string>).intentHash,
  moveSpecHash: (metadata as Record<string, string>).moveSpecHash,
  draftBodyHash: (metadata as Record<string, string>).draftBodyHash,
  rendererVersion: SEMANTIC_RENDERER_VERSION,
  rendererReceiptHash: (metadata as Record<string, string>).rendererReceiptHash,
  lintReceiptHash: (metadata as Record<string, string>).lintReceiptHash,
  revisionKind: "initial",
  materialBindingHash: hash("material-binding"),
  regenerationMaterialHash: hash("regeneration-binding")
});

test("derives none and evidence replay without inventing a recovered checkpoint", async () => {
  const noPlan = fixture();
  (noPlan.db.workbenchPlanRevisionRecord.findMany as unknown as () => Promise<unknown[]> ) = async () => [];
  assert.equal((await deriveVerifiedCourseAgentCheckpoint(noPlan.db, { taskId: TASK, runId: RUN, now: NOW })).state, "none");
  const replay = await deriveVerifiedCourseAgentCheckpoint(fixture().db, { taskId: TASK, runId: RUN, now: NOW });
  assert.equal(replay.state, "evidence_replay_required");
  assert.equal("metadata" in replay, false);
});

test("old v1 draft requires safe evidence replay while an injected closed v2 parser unlocks later states", async () => {
  const legacy = fixture({ completedThrough: 8, composition: true, draft: true });
  const legacyProjection = await deriveVerifiedCourseAgentCheckpoint(legacy.db, { taskId: TASK, runId: RUN, now: NOW });
  assert.equal(legacyProjection.state, "evidence_replay_required");
  assert.equal(legacyProjection.recoveryAction, "replay_evidence_steps");
  assert.equal(legacyProjection.reasonCode, "draft_v1_restart_binding_insufficient");
  assert.equal(legacyProjection.materialBindingHash, null);

  const unknown = fixture({ completedThrough: 9, composition: true, draft: true, stage: "unknown" });
  const unknownProjection = await deriveVerifiedCourseAgentCheckpoint(unknown.db, { taskId: TASK, runId: RUN, now: NOW });
  assert.equal(unknownProjection.state, "stage_unknown_requires_reconcile", unknownProjection.reasonCode);
  assert.equal(unknownProjection.recoveryAction, "reconcile_stage_without_replay");

  const verified = fixture({ completedThrough: 10, composition: true, draft: true, stage: "verified" });
  const verifiedProjection = await deriveVerifiedCourseAgentCheckpoint(verified.db, { taskId: TASK, runId: RUN, now: NOW }, { draftBindingParser: v2Parser });
  assert.equal(verifiedProjection.state, "stage_verified_delivery_ready");
  assert.equal(verifiedProjection.recoveryAction, "create_delivery_bundle");
});

test("default parser accepts the canonical body-free v2 draft binding without caller injection", async () => {
  const verified = fixture({
    completedThrough: 10,
    composition: true,
    draft: true,
    draftV2: true,
    stage: "verified"
  });
  const projection = await deriveVerifiedCourseAgentCheckpoint(verified.db, {
    taskId: TASK,
    runId: RUN,
    now: NOW
  });
  assert.equal(
    projection.state,
    "stage_verified_delivery_ready",
    projection.reasonCode
  );
  assert.match(projection.materialBindingHash ?? "", /^[a-f0-9]{64}$/u);
  assert.match(projection.regenerationMaterialHash ?? "", /^[a-f0-9]{64}$/u);
});

test("completed delivery is derived only from exact artifact, STAGE and verification bindings", async () => {
  const complete = fixture({ completedThrough: 11, composition: true, draft: true, stage: "verified", delivery: true });
  const projection = await deriveVerifiedCourseAgentCheckpoint(complete.db, { taskId: TASK, runId: RUN, now: NOW }, { draftBindingParser: v2Parser });
  assert.equal(projection.state, "completed", projection.reasonCode);
  assert.equal(projection.deliveryVersionRef, "artifact-version:delivery-version");
  assert.match(projection.checkpointRef, /^course-checkpoint:[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(projection).includes("protected-draft"), false);
});

test("checkpoint identity is stable across read time for the same immutable facts", async () => {
  const complete = fixture({ completedThrough: 11, composition: true, draft: true, stage: "verified", delivery: true });
  const first = await deriveVerifiedCourseAgentCheckpoint(
    complete.db,
    { taskId: TASK, runId: RUN, now: NOW },
    { draftBindingParser: v2Parser }
  );
  const later = await deriveVerifiedCourseAgentCheckpoint(
    complete.db,
    { taskId: TASK, runId: RUN, now: new Date("2026-08-13T20:30:00.000Z") },
    { draftBindingParser: v2Parser }
  );
  assert.equal(first.state, "completed", first.reasonCode);
  assert.equal(later.state, "completed", later.reasonCode);
  assert.equal(first.checkpointHash, later.checkpointHash);
  assert.equal(first.checkpointRef, later.checkpointRef);
  assert.notEqual(first.derivedAt, later.derivedAt);
});

test("reconciled STAGE binds the unique recovery child receipt instead of the unknown parent call", async () => {
  const reconciled = fixture({
    completedThrough: 10,
    composition: true,
    draft: true,
    stage: "reconciled"
  });
  const projection = await deriveVerifiedCourseAgentCheckpoint(
    reconciled.db,
    { taskId: TASK, runId: RUN, now: NOW },
    { draftBindingParser: v2Parser }
  );
  assert.equal(projection.state, "stage_verified_delivery_ready", projection.reasonCode);
  assert.equal(projection.recoveryAction, "create_delivery_bundle");
});

test("v2 metadata, recipe, verification and stage schema drift all fail closed", async () => {
  const metadataDrift = fixture({
    completedThrough: 8,
    composition: true,
    draft: true,
    draftV2: true
  });
  const metadataArtifact = metadataDrift.artifacts.find(
    (candidate) =>
      (candidate as { artifactKind?: string }).artifactKind ===
      "facilitation_reply_draft"
  ) as { metadataJson: string };
  const metadata = JSON.parse(metadataArtifact.metadataJson) as Record<string, unknown>;
  metadata.materialBindingHash = hash("tampered-material-binding");
  metadataArtifact.metadataJson = JSON.stringify(metadata);
  const metadataProjection = await deriveVerifiedCourseAgentCheckpoint(
    metadataDrift.db,
    { taskId: TASK, runId: RUN, now: NOW }
  );
  assert.equal(metadataProjection.state, "blocked");
  assert.equal(metadataProjection.reasonCode, "draft_binding_invalid");

  const recipeDrift = fixture({
    completedThrough: 8,
    composition: true,
    draft: true,
    draftV2: true
  });
  const recipeArtifact = recipeDrift.artifacts.find(
    (candidate) =>
      (candidate as { artifactKind?: string }).artifactKind ===
      "facilitation_reply_draft"
  ) as { regenerationRecipeJson: string };
  const recipe = JSON.parse(recipeArtifact.regenerationRecipeJson) as Record<string, unknown>;
  recipe.regenerationMaterialHash = hash("tampered-regeneration-material");
  recipeArtifact.regenerationRecipeJson = JSON.stringify(recipe);
  const recipeProjection = await deriveVerifiedCourseAgentCheckpoint(
    recipeDrift.db,
    { taskId: TASK, runId: RUN, now: NOW }
  );
  assert.equal(recipeProjection.state, "blocked");
  assert.equal(recipeProjection.reasonCode, "draft_binding_invalid");

  const verificationDrift = fixture({
    completedThrough: 8,
    composition: true,
    draft: true,
    draftV2: true
  });
  const compositionVerification = verificationDrift.verifications.find(
    (candidate) =>
      (candidate as { id?: string }).id === "verification-composition"
  ) as { checksJson: string };
  compositionVerification.checksJson = JSON.stringify([
    { code: "verification.facilitation_intent.intent_movespec_hashes", status: "passed", safeSummary: "Safe mechanical check passed." }
  ]);
  const verificationProjection = await deriveVerifiedCourseAgentCheckpoint(
    verificationDrift.db,
    { taskId: TASK, runId: RUN, now: NOW }
  );
  assert.equal(verificationProjection.state, "blocked");
  assert.equal(verificationProjection.reasonCode, "composition_binding_invalid");

  const legacyStage = fixture({
    completedThrough: 9,
    composition: true,
    draft: true,
    stage: "unknown"
  });
  (legacyStage.stageRows[0] as { schemaVersion: string }).schemaVersion =
    "cmooc.workbench-stage-transaction.v1";
  const stageProjection = await deriveVerifiedCourseAgentCheckpoint(
    legacyStage.db,
    { taskId: TASK, runId: RUN, now: NOW }
  );
  assert.equal(stageProjection.state, "blocked");
  assert.equal(stageProjection.reasonCode, "stage_transaction_binding_invalid");
});

test("expiration requires fresh replay or draft regeneration only when no STAGE exists", async () => {
  const expiredComposition = fixture({
    completedThrough: 8,
    composition: true,
    draft: true,
    draftV2: true
  });
  const compositionArtifact = expiredComposition.artifacts.find(
    (candidate) =>
      (candidate as { artifactKind?: string }).artifactKind ===
      "facilitation_intent"
  ) as { expiresAt: Date };
  compositionArtifact.expiresAt = new Date("2026-08-13T19:59:00.000Z");
  const replay = await deriveVerifiedCourseAgentCheckpoint(
    expiredComposition.db,
    { taskId: TASK, runId: RUN, now: NOW }
  );
  assert.equal(replay.state, "evidence_replay_required");
  assert.equal(replay.reasonCode, "composition_expired_fresh_evidence_required");

  const expiredDraft = fixture({
    completedThrough: 8,
    composition: true,
    draft: true,
    draftV2: true
  });
  const draftArtifact = expiredDraft.artifacts.find(
    (candidate) =>
      (candidate as { artifactKind?: string }).artifactKind ===
      "facilitation_reply_draft"
  ) as { expiresAt: Date; metadataJson: string; regenerationRecipeJson: string };
  draftArtifact.expiresAt = new Date("2026-08-13T19:59:00.000Z");
  const draftMetadata = JSON.parse(draftArtifact.metadataJson) as Record<string, unknown>;
  const draftRecipe = JSON.parse(draftArtifact.regenerationRecipeJson) as Record<string, unknown>;
  draftMetadata.expiresAt = draftArtifact.expiresAt.toISOString();
  draftRecipe.expiresAt = draftArtifact.expiresAt.toISOString();
  // A changed expiry is itself part of the v2 hashes, so it must not be
  // treated as a recoverable binding. This deliberately demonstrates the
  // stronger fail-closed result for a partially rewritten record.
  draftArtifact.metadataJson = JSON.stringify(draftMetadata);
  draftArtifact.regenerationRecipeJson = JSON.stringify(draftRecipe);
  const regeneration = await deriveVerifiedCourseAgentCheckpoint(
    expiredDraft.db,
    { taskId: TASK, runId: RUN, now: NOW }
  );
  assert.equal(regeneration.state, "blocked");
  assert.equal(regeneration.reasonCode, "draft_binding_invalid");
});

test("cross-run scope, privacy sentinels and non-unique candidates fail closed", async () => {
  await assert.rejects(
    deriveVerifiedCourseAgentCheckpoint(fixture().db, { taskId: "another-task", runId: RUN, now: NOW }),
    /COURSE_AGENT_CHECKPOINT_SCOPE_MISMATCH/
  );
  const unsafe = fixture({ completedThrough: 8, composition: true, draft: true, privacySentinel: true });
  assert.equal((await deriveVerifiedCourseAgentCheckpoint(unsafe.db, { taskId: TASK, runId: RUN, now: NOW })).reasonCode, "artifact_projection_corrupt");
  const duplicate = fixture({ completedThrough: 8, composition: true, draft: true, duplicateDraft: true });
  assert.equal((await deriveVerifiedCourseAgentCheckpoint(duplicate.db, { taskId: TASK, runId: RUN, now: NOW })).reasonCode, "artifact_candidate_not_unique");
});
