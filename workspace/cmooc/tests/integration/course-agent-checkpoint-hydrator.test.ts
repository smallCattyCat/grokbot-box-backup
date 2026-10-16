import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
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
  CANDIDATE_SET_SCHEMA_VERSION,
  type AutonomyCandidateSet
} from "../../lib/autonomy/candidate-set";
import {
  SEMANTIC_RENDERER_CONTRACT_VERSION,
  SEMANTIC_RENDERER_RECEIPT_SCHEMA_VERSION,
  SEMANTIC_RENDERER_VERSION,
  type SemanticRendererReceipt
} from "../../lib/autonomy/semantic-renderer";
import {
  LIVE_BUDGET_POLICY_VERSION,
  LIVE_FACILITATION_POLICY_VERSION,
  LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION
} from "../../lib/live-runtime/facilitation-kernel";
import { hashTransientDraftBody } from "../../lib/live-runtime/draft-content";
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
import { OPPORTUNITY_INTEGRITY_REF_SCHEMA_VERSION } from "../../lib/course-tools/tools/register-evidence-tools";
import { COURSE_TOOL_POLICY_VERSION } from "../../lib/course-tools/policy-gateway";
import {
  COURSE_AGENT_OBJECTIVE_CLASSIFIER_VERSION,
  COURSE_AGENT_PLAN_COMPILER_VERSION
} from "../../lib/workbench/course-agent-plan";
import {
  hashPersistedEvidenceQualification,
  PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION,
  type PersistedEvidenceQualification
} from "../../lib/workbench/course-evidence-workspace";
import { loadVerifiedCourseAgentRecoveryBundle } from "../../lib/workbench/course-agent-checkpoint-hydrator";
import { createSafeTaskObjective } from "../../lib/workbench/durable-ledger";
import { createPlanRevision } from "../../lib/workbench/plan-store";

const require = createRequire(import.meta.url);
const testRoot = mkdtempSync(path.join(tmpdir(), "cmooc-checkpoint-hydrator-"));
const databasePath = path.join(testRoot, "hydrator.db").replace(/\\/gu, "/");
const databaseUrl = `file:${databasePath}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

const TASK = "task-recovery-integration";
const SOURCE_RUN = "run-recovery-parent";
const CHILD_RUN = "run-recovery-child-absent";
const PLAN = "plan-recovery-integration";
const COURSE_ALIAS = "course-recovery";
const INVOCATION = "invocation-recovery";
const SNAPSHOT = "snapshot-recovery";
const SCAN = "scan-recovery";
const DECISION = "decision-recovery";
const T0 = new Date("2026-08-13T18:00:00.000Z");
const WORLD_AS_OF = new Date("2026-08-13T19:00:00.000Z");
const NOW = new Date("2026-08-13T20:00:00.000Z");
const EXPIRES_AT = new Date("2026-08-14T20:00:00.000Z");

const TOOL_STEPS = [
  ["course.context.resolve", "read", "L0_READ"],
  ["course.snapshot.read", "read", "L0_READ"],
  ["opportunity.list", "read", "L0_READ"],
  ["opportunity.select_support_gap", "pure", "L0_READ"],
  ["evidence.read_opportunity", "read", "L0_READ"],
  ["evidence.verify_integrity", "read", "L0_READ"],
  ["facilitation.intent.compose", "local_write", "L1_ARTIFACT"],
  ["artifact.reply_draft.create", "local_write", "L1_ARTIFACT"],
  ["platform.target.preflight_read", "read", "L0_READ"],
  ["platform.editor.stage_verify_clear", "external_stage", "L3_EXTERNAL_STAGE"],
  ["delivery.bundle.create", "local_write", "L1_ARTIFACT"]
] as const;

function sha(label: string): string {
  return hashCourseToolValue("test.course-agent-checkpoint-hydrator.integration", label);
}

function ref(
  kind: EvidenceRef["kind"],
  id: string,
  hash: string,
  observedAt = WORLD_AS_OF.toISOString()
): EvidenceRef {
  return { kind, id, hash, observedAt };
}

function sortedRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const deduped = new Map<string, EvidenceRef>();
  for (const item of refs) {
    deduped.set(`${item.kind}\0${item.id}\0${item.hash}`, item);
  }
  return [...deduped.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id) ||
      left.hash.localeCompare(right.hash)
  );
}

function checkRows(codes: readonly string[]) {
  return codes.map((code) => ({
    code,
    status: "passed",
    safeSummary: "Safe mechanical verification passed."
  }));
}

before(async () => {
  const migrated = spawnSync(
    process.execPath,
    [require.resolve("prisma/build/index.js"), "migrate", "deploy"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        CMOOC_DISABLE_WINDOWS_ENV_FALLBACK: "1"
      },
      encoding: "utf8"
    }
  );
  assert.equal(
    migrated.status,
    0,
    `${migrated.stdout ?? ""}\n${migrated.stderr ?? ""}`
  );
  await prisma.$connect();

  const manifestHash = sha("manifest");
  const worldHash = sha("world");
  const eventSetHash = sha("event-set");
  const targetVersionHash = sha("target-version");
  const observationReceiptHash = sha("observation-receipt");
  const afterObservationReceiptHash = sha("after-observation-receipt");
  const historyCutoffHash = sha("history-cutoff");
  const historyEvidenceHash = sha("history-evidence");
  const candidateKey = "candidate-recovery";
  const threadKey = "thread-recovery";
  const rootEventKey = "event-root-recovery";
  const contributionPublishedAt = new Date("2026-08-09T19:00:00.000Z");
  const latestEventAt = contributionPublishedAt;
  const supportGapHours = 96;

  const coverageDocument = {
    schemaVersion: "cmooc.course-scan-coverage.v5",
    observedAt: WORLD_AS_OF.toISOString(),
    sourceKind: "deterministic_test_projection",
    apiReadAuthStatus: "not_required",
    uiStatus: "ready",
    uiEvidenceHash: sha("ui-evidence"),
    courseShellDetected: true,
    categoryCount: 1,
    categoryCompletedCount: 1,
    pageRequestCount: 1,
    discoveredThreadCount: 1,
    completedDetailCount: 1,
    observedEventCount: 1,
    incompleteCommentThreadCount: 0,
    failedTargetCount: 0,
    truncatedThreadListing: false,
    complete: true,
    failureCodeCounts: {},
    containsForumText: false
  };
  const coverageHash = canonicalProtocolHash(
    coverageDocument.schemaVersion,
    coverageDocument as CanonicalJsonValue
  );
  const threadStateHash = canonicalProtocolHash(
    "cmooc.thread-state-at-cutoff.v2",
    {
      threadKey,
      rootEventKey,
      authorKey: null,
      firstEventAt: contributionPublishedAt.toISOString(),
      latestEventAt: latestEventAt.toISOString(),
      eventCount: 1,
      externalHumanCount: 0,
      distinctActorResponseCount: 0,
      authorReturnCount: 0,
      systemResponseCount: 0,
      maxDepth: 0,
      completeness: "complete",
      supportGapHours
    }
  );
  const candidateSet: AutonomyCandidateSet = {
    schemaVersion: CANDIDATE_SET_SCHEMA_VERSION,
    courseAlias: COURSE_ALIAS,
    worldHash,
    eventSetHash,
    asOfAt: WORLD_AS_OF.toISOString(),
    candidates: [
      {
        candidateKey,
        threadKey,
        authorKey: null,
        rootEventKey,
        targetVersionHash,
        contributionPublishedAt: contributionPublishedAt.toISOString(),
        latestEventAt: latestEventAt.toISOString(),
        eventCount: 1,
        externalHumanCount: 0,
        authorReturnCount: 0,
        systemResponseCount: 0,
        supportGapHours,
        completeness: "complete",
        sourceObservationReceiptHash: observationReceiptHash
      }
    ],
    containsForumText: false
  };
  const candidateSetHash = canonicalProtocolHash(
    candidateSet.schemaVersion,
    candidateSet as unknown as CanonicalJsonValue
  );

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
  const opportunityReceiptHash = sha("opportunity-receipt");
  const intentEvidenceBindingHash = canonicalProtocolHash(
    "cmooc.live-qualified-evidence-ref.v1",
    {
      schemaVersion: "cmooc.live-qualified-evidence-ref.v1",
      observationReceiptHash,
      historyCutoffHash,
      historyEvidenceHash,
      targetVersionHash,
      eventSetHash,
      assessedAt: WORLD_AS_OF.toISOString(),
      qualification,
      containsForumText: false
    }
  );
  const intent = parseProtocolObject("interventionIntent", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.interventionIntent,
    evidenceRefHash: intentEvidenceBindingHash,
    evidenceAsOf: WORLD_AS_OF.toISOString(),
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
  const draftBodyHash = hashTransientDraftBody(
    "What boundary case would test this explanation?"
  );
  const semanticReceipt: SemanticRendererReceipt = {
    schemaVersion: SEMANTIC_RENDERER_RECEIPT_SCHEMA_VERSION,
    rendererVersion: SEMANTIC_RENDERER_VERSION,
    contractVersion: SEMANTIC_RENDERER_CONTRACT_VERSION,
    provider: "local_deterministic",
    model: "facilitation_template_v1",
    decision: "draft",
    decisionMode: "DRAFT_ELIGIBLE",
    resolution: "deterministic_fallback",
    fallbackReason: "renderer_disabled",
    modelInvoked: false,
    modelOutputAccepted: false,
    opportunityReceiptHash,
    evidenceAsOf: WORLD_AS_OF.toISOString(),
    observationReceiptHash,
    historyCutoffHash,
    historyEvidenceHash,
    eventSetHash,
    targetVersionHash,
    selectedFunction: "cognitive_conflict",
    targetObject: "thread_author",
    intentHash,
    moveSpecHash,
    contentHash: draftBodyHash,
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
    afterObservationReceiptHash,
    checkedAt: "2026-08-13T19:10:00.000Z",
    targetVersionHash,
    eventSetHash,
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
    qualificationHash: hashPersistedEvidenceQualification({
      opportunityReceiptHash,
      qualification
    }),
    qualificationSchemaVersion:
      PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION,
    evidenceBundleHash,
    intent,
    intentHash,
    moveSpec,
    moveSpecHash,
    draftContentHash: draftBodyHash,
    semanticReceipt,
    semanticReceiptHash,
    revalidationReceipt,
    revalidationReceiptHash,
    draftBodyPersisted: false,
    publishAttempted: false,
    editorWriteAttempted: false,
    containsForumText: false
  };

  await prisma.autonomyCourseManifest.create({
    data: {
      alias: COURSE_ALIAS,
      manifestHash,
      platformId: "platform-test",
      platformCourseRefHash: sha("platform-course-ref"),
      canonicalLocatorHash: sha("canonical-locator"),
      identityKeyFingerprint: sha("identity-key-fingerprint"),
      allowedOrigin: "https://invalid.example",
      timeZone: "UTC",
      defaultMode: "SHADOW",
      policyVersion: LIVE_FACILITATION_POLICY_VERSION,
      enabled: true,
      realPublishEnabled: false
    }
  });
  await prisma.scheduledInvocation.create({
    data: {
      id: INVOCATION,
      invocationKey: "invocation-key-recovery",
      courseAlias: COURSE_ALIAS,
      manifestHash,
      scheduledFor: T0,
      mode: "SHADOW",
      status: "completed",
      phase: "completed",
      attempt: 1,
      startedAt: T0,
      finishedAt: WORLD_AS_OF
    }
  });
  await prisma.courseScanRun.create({
    data: {
      id: SCAN,
      invocationId: INVOCATION,
      courseAlias: COURSE_ALIAS,
      scanKey: "scan-key-recovery",
      status: "completed",
      sourceKind: "deterministic_test_projection",
      cursorJson: "{}",
      coverageJson: JSON.stringify(coverageDocument),
      coverageHash,
      observedEventCount: 1,
      newEventCount: 1,
      failedTargetCount: 0,
      startedAt: T0,
      finishedAt: WORLD_AS_OF
    }
  });
  await prisma.courseWorldSnapshot.create({
    data: {
      id: SNAPSHOT,
      invocationId: INVOCATION,
      courseAlias: COURSE_ALIAS,
      asOfAt: WORLD_AS_OF,
      eventSetHash,
      worldHash,
      graphHash: sha("graph"),
      coverageHash,
      eventCount: 1,
      threadCount: 1,
      actorCount: 0,
      edgeCount: 0,
      openGapCount: 1,
      stateJson: JSON.stringify({ containsForumText: false })
    }
  });
  await prisma.threadStateAtCutoff.create({
    data: {
      id: "thread-state-recovery",
      snapshotId: SNAPSHOT,
      threadKey,
      rootEventKey,
      authorKey: null,
      firstEventAt: contributionPublishedAt,
      latestEventAt,
      eventCount: 1,
      externalHumanCount: 0,
      distinctActorResponseCount: 0,
      authorReturnCount: 0,
      systemResponseCount: 0,
      maxDepth: 0,
      completeness: "complete",
      supportGapHours,
      stateHash: threadStateHash
    }
  });
  await prisma.candidateSet.create({
    data: {
      id: "candidate-set-recovery",
      invocationId: INVOCATION,
      snapshotId: SNAPSHOT,
      candidateSetHash,
      asOfAt: WORLD_AS_OF,
      candidateCount: 1,
      candidatesJson: JSON.stringify(candidateSet)
    }
  });
  await prisma.autonomyDecision.create({
    data: {
      id: DECISION,
      invocationId: INVOCATION,
      courseAlias: COURSE_ALIAS,
      decisionKey: "decision-key-recovery",
      threadKey,
      authorKey: null,
      decision: "draft",
      decisionMode: "DRAFT_ELIGIBLE",
      reasonCode: "draft_eligible",
      observationReceiptHash,
      opportunityReceiptHash,
      evidenceBundleHash,
      intentHash,
      moveSpecHash,
      draftContentHash: draftBodyHash,
      policyVersion: LIVE_FACILITATION_POLICY_VERSION,
      worldHash,
      candidateSetHash,
      evidenceAsOf: WORLD_AS_OF,
      decisionJson: JSON.stringify(decisionSummary),
      bodyPersisted: false,
      publishAttempted: false,
      editorWriteAttempted: false,
      semanticRealization: {
        create: {
          id: "semantic-realization-recovery",
          rendererKind: "deterministic_fallback",
          rendererVersion: SEMANTIC_RENDERER_VERSION,
          modelProvider: "local_deterministic",
          modelName: "facilitation_template_v1",
          contractVersion: SEMANTIC_RENDERER_CONTRACT_VERSION,
          contentHash: draftBodyHash,
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
      }
    }
  });

  const baseEvidence = [
    ref("manifest", `manifest:${manifestHash}`, manifestHash, T0.toISOString()),
    ref("invocation", INVOCATION, manifestHash, T0.toISOString()),
    ref("snapshot", SNAPSHOT, worldHash),
    ref("coverage", SCAN, coverageHash),
    ref("candidate", `${INVOCATION}:candidate-set`, candidateSetHash),
    ref("candidate", `${candidateKey}:target`, threadStateHash),
    ref("decision", `decision:${DECISION}`, opportunityReceiptHash)
  ];
  const integrityHash = canonicalProtocolHash(
    OPPORTUNITY_INTEGRITY_REF_SCHEMA_VERSION,
    {
      schemaVersion: OPPORTUNITY_INTEGRITY_REF_SCHEMA_VERSION,
      contextRef: `snapshot:${SNAPSHOT}`,
      invocationRef: INVOCATION,
      snapshotRef: SNAPSHOT,
      worldHash,
      eventSetHash,
      coverageHash,
      candidateSetHash,
      opportunityId: `support-gap:${candidateKey}`,
      claim: "mature_support_gap",
      status: "eligible",
      evidenceHashes: [...new Set(baseEvidence.map((item) => item.hash))].sort()
    }
  );
  const integrityVerificationRef = `integrity-verification:${integrityHash}`;
  const compositionEvidence = sortedRefs([
    ...baseEvidence,
    ref("world", `world:${SNAPSHOT}`, worldHash),
    ref("verification", integrityVerificationRef, integrityHash)
  ]);
  const rawIntegrityEvidence = sortedRefs(baseEvidence);
  const integrityOutput = {
    schemaVersion: "cmooc.course-tool.opportunity-verification-output.v1",
    status: "eligible",
    contextRef: `snapshot:${SNAPSHOT}`,
    snapshotRef: SNAPSHOT,
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

  const compositionVersionId = "composition-version-recovery";
  const compositionArtifactId = "composition-artifact-recovery";
  const compositionReceiptHash = sha("composition-receipt");
  const selectionEvidenceBindingHash = sha("selection-evidence-binding");
  const compositionMetadata = {
    schemaVersion: FACILITATION_ARTIFACT_TOOL_SCHEMA_VERSION,
    receiptRef: `intent-compose:${compositionReceiptHash}`,
    receiptHash: compositionReceiptHash,
    selectionRef: "selection-recovery",
    selectionEvidenceBindingHash,
    integrityVerificationRef,
    evidenceBindingHash: intentEvidenceBindingHash,
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
      selectionEvidenceBindingHash,
      evidenceBindingHash: intentEvidenceBindingHash
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
    selectionEvidenceBindingHash,
    evidenceBindingHash: intentEvidenceBindingHash,
    integrityVerificationRef,
    receiptRef: compositionMetadata.receiptRef,
    receiptHash: compositionReceiptHash,
    artifact: compositionPointer,
    evidenceRefs:
      compositionEvidence as FacilitationIntentComposeOutput["evidenceRefs"],
    observedAt: "2026-08-13T19:30:00.000Z",
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };

  const contentMaterial: ReplyDraftContentMaterialV2 = {
    schemaVersion: FACILITATION_DRAFT_METADATA_SCHEMA_VERSION,
    compositionRef: compositionPointer.versionRef,
    intent,
    intentHash,
    moveSpec,
    moveSpecHash,
    draftBodyHash,
    rendererVersion: SEMANTIC_RENDERER_VERSION,
    rendererReceiptRef: `semantic-renderer-receipt:${semanticReceiptHash}`,
    rendererReceiptHash: semanticReceiptHash,
    lintVersion: FACILITATION_ARTIFACT_LINT_VERSION,
    lintReceiptRef: `draft-lint:${sha("lint")}`,
    lintReceiptHash: sha("lint"),
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
    compositionRef: compositionPointer.versionRef,
    intentHash,
    moveSpecHash,
    draftBodyHash,
    contentHash: draftContentHash,
    rendererVersion: SEMANTIC_RENDERER_VERSION,
    rendererReceiptHash: semanticReceiptHash,
    lintReceiptHash: sha("lint"),
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
    compositionRef: compositionPointer.versionRef,
    intentHash,
    moveSpecHash,
    draftBodyHash,
    contentHash: draftContentHash,
    rendererVersion: SEMANTIC_RENDERER_VERSION,
    rendererReceiptHash: semanticReceiptHash,
    lintReceiptHash: sha("lint"),
    integrityVerificationRef,
    intentPolicyVersion: LIVE_FACILITATION_POLICY_VERSION,
    toolPolicyVersion: COURSE_TOOL_POLICY_VERSION,
    revisionKind: "initial",
    priorVersionRef: null,
    feedbackRef: null,
    expiresAt: EXPIRES_AT.toISOString(),
    regenerationMaterialHash,
    requireReverification: true,
    recovery: "regenerate_and_reverify",
    bodyPersisted: false,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
  const regenerationRecipeHash = hashReplyDraftRegenerationRecipeV2(draftRecipe);
  const binding: ReplyDraftMaterialBindingV2 = {
    schemaVersion: FACILITATION_DRAFT_MATERIAL_BINDING_SCHEMA_VERSION,
    contentHash: draftContentHash,
    draftBodyHash,
    regenerationMaterialHash,
    regenerationRecipeHash,
    verifier: FACILITATION_DRAFT_VERIFIER_CONTRACT,
    expiresAt: EXPIRES_AT.toISOString(),
    requireReverification: true,
    recovery: "regenerate_and_reverify",
    bodyPersisted: false
  };
  const draftMetadata: ReplyDraftPersistedMetadataV2 = {
    ...contentMaterial,
    contentHash: draftContentHash,
    expiresAt: EXPIRES_AT.toISOString(),
    regenerationMaterialHash,
    regenerationRecipeHash,
    materialBindingHash: hashReplyDraftMaterialBindingV2(binding)
  };
  const artifactKey = `facilitation_reply_draft:${hashCourseToolValue(
    "facilitation-artifact-key.v1",
    { taskId: TASK, logicalKey: `support-gap-draft:${DECISION}` }
  )}`;
  const draftArtifactId = `course-artifact-${createHash("sha256")
    .update(artifactKey, "utf8")
    .digest("hex")}`;

  await prisma.workbenchTask.create({
    data: {
      id: TASK,
      title: "Safe course checkpoint recovery integration",
      status: "failed",
      createdAt: T0
    }
  });
  await prisma.workbenchRunRecord.create({
    data: {
      id: SOURCE_RUN,
      taskId: TASK,
      schemaVersion: "workbench-run-v1",
      source: "app-server",
      status: "failed",
      projectLabel: "Course recovery integration",
      snapshotJson: "{}",
      errorCode: "PROCESS_LOST",
      createdAt: T0,
      updatedAt: NOW,
      finishedAt: NOW
    }
  });
  const objectiveHash = sha("objective");
  await createSafeTaskObjective(prisma, {
    id: "objective-recovery-integration",
    taskId: TASK,
    objectiveHash,
    safeSummary: "Recover body-free verified course material.",
    structuredGoal: {
      goalCode: "course_evidence_support_gap",
      courseAlias: COURSE_ALIAS,
      contextRefs: ["context:recovery-integration"],
      requestedArtifactKinds: ["facilitation_draft", "delivery_bundle"],
      constraints: ["no_forum_text_persistence", "no_real_publish"],
      capabilityCeiling: "L1_ARTIFACT",
      policyVersion: COURSE_TOOL_POLICY_VERSION
    },
    source: COURSE_AGENT_OBJECTIVE_CLASSIFIER_VERSION,
    createdAt: T0,
    expiresAt: EXPIRES_AT
  });
  await createPlanRevision(prisma, {
    id: PLAN,
    taskId: TASK,
    runId: SOURCE_RUN,
    revision: 1,
    objectiveHash,
    compilerVersion: COURSE_AGENT_PLAN_COMPILER_VERSION,
    safeSummary: "Canonical body-free recovery plan.",
    createdAt: T0,
    steps: TOOL_STEPS.map(([toolName, effectClass, requiredCapability], index) => ({
      id: `step-recovery-${index + 1}`,
      ordinal: index + 1,
      toolName,
      toolVersion: "1",
      dependencyIds: index === 0 ? [] : [`step-recovery-${index}`],
      inputRefs: [{ kind: "safe_ref", ref: `recovery-input-${index + 1}` }],
      preconditions: [],
      postconditions: [{ code: "verified", required: true }],
      effectClass,
      requiredCapability,
      acceptance: { code: "verified" },
      replanPolicy: { on: "failed_or_unknown", action: "stop_and_replan" },
      safeSummary: `Safe recovery step ${index + 1}.`
    }))
  });
  await prisma.workbenchPlanStepRecord.updateMany({
    where: { planRevisionId: PLAN, ordinal: { lte: 8 } },
    data: { status: "completed", completedAt: new Date("2026-08-13T19:40:00.000Z") }
  });
  await prisma.workbenchPlanStepRecord.update({
    where: { id: "step-recovery-9" },
    data: { status: "running", startedAt: new Date("2026-08-13T19:45:00.000Z") }
  });
  await prisma.workbenchExecutionLease.create({
    data: {
      id: "lease-recovery-integration",
      taskId: TASK,
      runId: SOURCE_RUN,
      stepId: null,
      scopeKey: "recovery-source",
      ownerInstanceId: "integration-test",
      generation: 1,
      fencingTokenHash: sha("fencing-token"),
      status: "released",
      acquiredAt: T0,
      heartbeatAt: NOW,
      expiresAt: EXPIRES_AT,
      releasedAt: NOW
    }
  });

  const verificationIds: Record<number, string | null> = {
    6: "verification-integrity-recovery",
    7: "verification-composition-recovery",
    8: "verification-draft-recovery"
  };
  for (const [index, [toolName, effectClass, requiredCapability]] of TOOL_STEPS
    .slice(0, 8)
    .entries()) {
    const ordinal = index + 1;
    const callId = `call-recovery-${ordinal}`;
    await prisma.workbenchToolCallRecord.create({
      data: {
        id: callId,
        taskId: TASK,
        runId: SOURCE_RUN,
        stepId: `step-recovery-${ordinal}`,
        executionLeaseId: "lease-recovery-integration",
        toolName,
        toolVersion: "1",
        capability: requiredCapability,
        effectClass,
        safeInputSummary: "Safe deterministic integration input.",
        inputHash: sha(`input-${ordinal}`),
        idempotencyKey: `recovery-call-${ordinal}`,
        attempt: 1,
        leaseGeneration: 1,
        fencingTokenHash: sha("fencing-token"),
        status: "succeeded",
        causationId: "recovery-integration",
        createdAt: new Date("2026-08-13T19:20:00.000Z"),
        completedAt: new Date("2026-08-13T19:30:00.000Z")
      }
    });
    const outputHash =
      ordinal === 6
        ? hashCourseToolValue(
            "output:evidence.verify_integrity@1",
            integrityOutput as unknown as CourseToolJsonValue
          )
        : ordinal === 7
          ? hashCourseToolValue(
              "output:facilitation.intent.compose@1",
              compositionOutput as unknown as CourseToolJsonValue
            )
          : sha(`output-${ordinal}`);
    await prisma.workbenchToolReceiptRecord.create({
      data: {
        id: `receipt-recovery-${ordinal}`,
        callId,
        status: "succeeded",
        safeOutputSummary: "Safe deterministic integration output.",
        outputHash,
        evidenceRefsJson: JSON.stringify(
          ordinal === 6
            ? rawIntegrityEvidence
            : [ref("manifest", `manifest:${manifestHash}`, manifestHash)]
        ),
        verificationId: verificationIds[ordinal] ?? null,
        containsForumText: false,
        containsIdentity: false,
        observedAt: new Date("2026-08-13T19:30:00.000Z")
      }
    });
  }

  await prisma.workbenchArtifactVersionRecord.createMany({
    data: [
      {
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
        safeSummary: "Safe verified composition metadata.",
        metadataJson: JSON.stringify(compositionMetadata),
        sourceRefsJson: JSON.stringify(compositionEvidence),
        regenerationRecipeJson: null,
        createdByCallId: "call-recovery-7",
        expiresAt: EXPIRES_AT,
        createdAt: new Date("2026-08-13T19:31:00.000Z")
      },
      {
        id: "draft-version-recovery",
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
        createdByCallId: "call-recovery-8",
        expiresAt: EXPIRES_AT,
        createdAt: new Date("2026-08-13T19:32:00.000Z")
      }
    ]
  });
  const verificationEvidenceJson = JSON.stringify([
    ref("manifest", `manifest:${manifestHash}`, manifestHash)
  ]);
  await prisma.workbenchVerificationRecord.createMany({
    data: [
      {
        id: "verification-integrity-recovery",
        taskId: TASK,
        runId: SOURCE_RUN,
        subjectType: "tool_result",
        subjectId: integrityVerificationRef,
        verifier: "verification.course_tool_registry",
        verifierVersion: "1",
        status: "passed",
        safeSummary: "Safe exact integrity verification.",
        checksJson: JSON.stringify(
          checkRows([
            "verification.opportunity_integrity.server_scope_binding",
            "verification.opportunity_integrity.fresh_evidence_replay",
            "verification.opportunity_integrity.integrity_reference",
            "verification.opportunity_integrity.evidence_reference_binding"
          ])
        ),
        evidenceRefsJson: verificationEvidenceJson,
        observedAt: new Date("2026-08-13T19:35:00.000Z"),
        expiresAt: EXPIRES_AT,
        containsForumText: false,
        containsIdentity: false
      },
      {
        id: "verification-composition-recovery",
        taskId: TASK,
        runId: SOURCE_RUN,
        subjectType: "artifact_version",
        subjectId: compositionVersionId,
        verifier: "verification.course_tool_registry",
        verifierVersion: "1",
        status: "passed",
        safeSummary: "Safe exact composition verification.",
        checksJson: JSON.stringify(
          checkRows([
            "verification.facilitation_intent.intent_movespec_hashes",
            "verification.facilitation_intent.artifact_content_hash",
            "verification.facilitation_intent.verified_evidence_binding",
            "verification.facilitation_intent.policy_domain_binding"
          ])
        ),
        evidenceRefsJson: verificationEvidenceJson,
        observedAt: new Date("2026-08-13T19:35:00.000Z"),
        expiresAt: EXPIRES_AT,
        containsForumText: false,
        containsIdentity: false
      },
      {
        id: "verification-draft-recovery",
        taskId: TASK,
        runId: SOURCE_RUN,
        subjectType: "artifact_version",
        subjectId: "draft-version-recovery",
        verifier: "verification.course_tool_registry",
        verifierVersion: "1",
        status: "passed",
        safeSummary: "Safe exact draft verification.",
        checksJson: JSON.stringify(
          checkRows([
            "verification.facilitation_reply_draft.protected_body_hash",
            "verification.facilitation_reply_draft.restricted_transient_boundary",
            "verification.facilitation_reply_draft.privacy_claim_lint"
          ])
        ),
        evidenceRefsJson: verificationEvidenceJson,
        observedAt: new Date("2026-08-13T19:35:00.000Z"),
        expiresAt: EXPIRES_AT,
        containsForumText: false,
        containsIdentity: false
      }
    ]
  });
});

after(async () => {
  await prisma.$disconnect();
  rmSync(testRoot, { recursive: true, force: true });
});

test("migrated SQLite loads a strict body-free recovery bundle before child creation without writes", async () => {
  const beforeCounts = {
    runs: await prisma.workbenchRunRecord.count(),
    calls: await prisma.workbenchToolCallRecord.count(),
    receipts: await prisma.workbenchToolReceiptRecord.count(),
    verifications: await prisma.workbenchVerificationRecord.count(),
    artifacts: await prisma.workbenchArtifactVersionRecord.count()
  };
  assert.equal(
    await prisma.workbenchRunRecord.findUnique({ where: { id: CHILD_RUN } }),
    null
  );

  const bundle = await loadVerifiedCourseAgentRecoveryBundle(prisma, {
    taskId: TASK,
    sourceRunId: SOURCE_RUN,
    childRunId: CHILD_RUN,
    courseAlias: COURSE_ALIAS,
    now: NOW
  });

  assert.equal(bundle.checkpoint.state, "draft_regeneration_required");
  assert.equal(
    bundle.checkpoint.reasonCode,
    "fresh_stage_requires_regenerated_body"
  );
  assert.equal(bundle.source.sourceRunId, SOURCE_RUN);
  assert.equal(bundle.source.childRunId, CHILD_RUN);
  assert.equal(bundle.source.draftRecovery?.artifact.bodyPersisted, false);
  assert.equal(bundle.runtimeRecovery.verifiedCheckpointSource, bundle.source);
  assert.equal(JSON.stringify(bundle).includes("protected-draft:"), false);
  assert.equal(
    await prisma.workbenchRunRecord.findUnique({ where: { id: CHILD_RUN } }),
    null
  );
  assert.deepEqual(
    {
      runs: await prisma.workbenchRunRecord.count(),
      calls: await prisma.workbenchToolCallRecord.count(),
      receipts: await prisma.workbenchToolReceiptRecord.count(),
      verifications: await prisma.workbenchVerificationRecord.count(),
      artifacts: await prisma.workbenchArtifactVersionRecord.count()
    },
    beforeCounts
  );
});
