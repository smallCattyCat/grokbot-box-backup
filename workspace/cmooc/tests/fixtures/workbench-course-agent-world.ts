import type { PrismaClient } from "@prisma/client";
import {
  CANDIDATE_SET_SCHEMA_VERSION,
  type AutonomyCandidateSet
} from "../../lib/autonomy/candidate-set";
import {
  AUTONOMY_DRAFT_REVALIDATION_SCHEMA_VERSION,
  type AutonomyDraftRevalidationReceipt
} from "../../lib/autonomy/draft-revalidation";
import {
  rebuildDeterministicSemanticDraft,
  SEMANTIC_RENDERER_CONTRACT_VERSION,
  SEMANTIC_RENDERER_RECEIPT_SCHEMA_VERSION,
  SEMANTIC_RENDERER_VERSION,
  type SemanticRendererReceipt
} from "../../lib/autonomy/semantic-renderer";
import {
  hashCourseToolValue
} from "../../lib/course-tools/contracts";
import {
  CANONICAL_HASH_ALGORITHM,
  PROTOCOL_SCHEMA_VERSIONS,
  canonicalProtocolHash,
  parseProtocolObject,
  type CanonicalJsonValue
} from "../../lib/facilitation-protocol";
import { hashTransientDraftBody } from "../../lib/live-runtime/draft-content";
import {
  LIVE_BUDGET_POLICY_VERSION,
  LIVE_FACILITATION_POLICY_VERSION,
  LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION
} from "../../lib/live-runtime/facilitation-kernel";
import {
  hashPersistedEvidenceQualification,
  PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION,
  type PersistedEvidenceQualification
} from "../../lib/workbench/course-evidence-workspace";

export type SyntheticCourseAgentWorld = Readonly<{
  courseAlias: string;
  invocationId: string;
  scanId: string;
  snapshotId: string;
  decisionId: string;
  candidateKey: string;
  threadKey: string;
  rootEventKey: string;
  worldAsOf: string;
  manifestHash: string;
  worldHash: string;
  eventSetHash: string;
  targetVersionHash: string;
  opportunityReceiptHash: string;
  revalidationReceiptHash: string;
  afterObservationReceiptHash: string;
  draftBody: string;
  draftBodyHash: string;
}>;

function hash(label: string): string {
  return hashCourseToolValue(
    "test.workbench-course-agent-one-sentence-world.v1",
    label
  );
}

/**
 * Seeds one complete, body-free support-gap evidence chain for the real
 * Workbench course tools. The only transient body is returned to the caller so
 * it can assert that SQLite, public snapshots, and session files never retain
 * it.
 */
export async function seedSyntheticCourseAgentWorld(input: {
  prisma: PrismaClient;
  courseAlias: string;
  manifestHash: string;
  now?: Date;
  suffix?: string;
}): Promise<SyntheticCourseAgentWorld> {
  const db = input.prisma;
  const suffix = input.suffix ?? "one-sentence-e2e";
  const now = input.now ?? new Date();
  const worldAsOf = new Date(now.getTime() - 60 * 60_000);
  const scheduledFor = new Date(worldAsOf.getTime() - 60 * 60_000);
  const contributionPublishedAt = new Date(
    worldAsOf.getTime() - 96 * 60 * 60_000
  );
  const revalidatedAt = new Date(worldAsOf.getTime() + 10 * 60_000);
  const candidateExpiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
  const invocationId = `invocation-${suffix}`;
  const scanId = `scan-${suffix}`;
  const snapshotId = `snapshot-${suffix}`;
  const decisionId = `decision-${suffix}`;
  const candidateKey = `candidate-${suffix}`;
  const threadKey = `thread-${suffix}`;
  const rootEventKey = `event-root-${suffix}`;
  const worldHash = hash(`world:${suffix}`);
  const eventSetHash = hash(`event-set:${suffix}`);
  const targetVersionHash = hash(`target-version:${suffix}`);
  const observationReceiptHash = hash(`observation:${suffix}`);
  const afterObservationReceiptHash = hash(`after-observation:${suffix}`);
  const historyCutoffHash = hash(`history-cutoff:${suffix}`);
  const historyEvidenceHash = hash(`history-evidence:${suffix}`);
  const opportunityReceiptHash = hash(`opportunity-receipt:${suffix}`);
  const evidenceBundleHash = hash(`evidence-bundle:${suffix}`);
  const supportGapHours = 96;

  const coverageDocument = {
    schemaVersion: "cmooc.course-scan-coverage.v5",
    observedAt: worldAsOf.toISOString(),
    sourceKind: "deterministic_test_projection",
    apiReadAuthStatus: "not_required",
    uiStatus: "ready",
    uiEvidenceHash: hash(`ui-evidence:${suffix}`),
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
      latestEventAt: contributionPublishedAt.toISOString(),
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
    courseAlias: input.courseAlias,
    worldHash,
    eventSetHash,
    asOfAt: worldAsOf.toISOString(),
    candidates: [
      {
        candidateKey,
        threadKey,
        authorKey: null,
        rootEventKey,
        targetVersionHash,
        contributionPublishedAt: contributionPublishedAt.toISOString(),
        latestEventAt: contributionPublishedAt.toISOString(),
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
  const intentEvidenceBindingHash = canonicalProtocolHash(
    "cmooc.live-qualified-evidence-ref.v1",
    {
      schemaVersion: "cmooc.live-qualified-evidence-ref.v1",
      observationReceiptHash,
      historyCutoffHash,
      historyEvidenceHash,
      targetVersionHash,
      eventSetHash,
      assessedAt: worldAsOf.toISOString(),
      qualification,
      containsForumText: false
    }
  );
  const intent = parseProtocolObject("interventionIntent", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.interventionIntent,
    evidenceRefHash: intentEvidenceBindingHash,
    evidenceAsOf: worldAsOf.toISOString(),
    intervene: true,
    facilitationFunction: "cognitive_conflict",
    targetObject: "thread_author",
    workloadCost: 1,
    candidateExpiresAt: candidateExpiresAt.toISOString(),
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
  const expectedDraft = [
    "你已经把一个值得继续检验的观点放到了讨论里。",
    "想邀请你再往前走一步：如果关键条件发生变化，这个判断还会成立吗？",
    "可以用一个具体例子或反例说明它的适用边界，也欢迎其他同学从不同经验出发接续这个问题。"
  ].join("");
  const draftBodyHash = hashTransientDraftBody(expectedDraft);
  const draftBody = rebuildDeterministicSemanticDraft({
    intent,
    moveSpec,
    intentHash,
    moveSpecHash,
    expectedContentHash: draftBodyHash
  });
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
    evidenceAsOf: worldAsOf.toISOString(),
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
    checkedAt: revalidatedAt.toISOString(),
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

  const manifest = await db.autonomyCourseManifest.upsert({
    where: { alias: input.courseAlias },
    create: {
      alias: input.courseAlias,
      manifestHash: input.manifestHash,
      platformId: "cmooc.bnu",
      platformCourseRefHash: hash(`platform-course:${suffix}`),
      canonicalLocatorHash: hash(`course-locator:${suffix}`),
      identityKeyFingerprint: hash(`identity-fingerprint:${suffix}`),
      allowedOrigin: "https://example.test",
      timeZone: "UTC",
      defaultMode: "SHADOW",
      policyVersion: LIVE_FACILITATION_POLICY_VERSION,
      enabled: true,
      realPublishEnabled: false
    },
    update: {}
  });
  if (manifest.manifestHash !== input.manifestHash) {
    throw new Error("SYNTHETIC_COURSE_MANIFEST_CONFLICT");
  }
  await db.scheduledInvocation.create({
    data: {
      id: invocationId,
      invocationKey: `invocation-key-${suffix}`,
      courseAlias: input.courseAlias,
      manifestHash: input.manifestHash,
      scheduledFor,
      mode: "SHADOW",
      status: "completed",
      phase: "completed",
      attempt: 1,
      startedAt: scheduledFor,
      finishedAt: worldAsOf
    }
  });
  await db.courseScanRun.create({
    data: {
      id: scanId,
      invocationId,
      courseAlias: input.courseAlias,
      scanKey: `scan-key-${suffix}`,
      status: "completed",
      sourceKind: "deterministic_test_projection",
      cursorJson: "{}",
      coverageJson: JSON.stringify(coverageDocument),
      coverageHash,
      observedEventCount: 1,
      newEventCount: 1,
      failedTargetCount: 0,
      startedAt: scheduledFor,
      finishedAt: worldAsOf
    }
  });
  await db.courseWorldSnapshot.create({
    data: {
      id: snapshotId,
      invocationId,
      courseAlias: input.courseAlias,
      asOfAt: worldAsOf,
      eventSetHash,
      worldHash,
      graphHash: hash(`graph:${suffix}`),
      coverageHash,
      eventCount: 1,
      threadCount: 1,
      actorCount: 0,
      edgeCount: 0,
      openGapCount: 1,
      stateJson: JSON.stringify({ containsForumText: false })
    }
  });
  await db.threadStateAtCutoff.create({
    data: {
      id: `thread-state-${suffix}`,
      snapshotId,
      threadKey,
      rootEventKey,
      authorKey: null,
      firstEventAt: contributionPublishedAt,
      latestEventAt: contributionPublishedAt,
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
  await db.candidateSet.create({
    data: {
      id: `candidate-set-${suffix}`,
      invocationId,
      snapshotId,
      candidateSetHash,
      asOfAt: worldAsOf,
      candidateCount: 1,
      candidatesJson: JSON.stringify(candidateSet)
    }
  });
  await db.autonomyDecision.create({
    data: {
      id: decisionId,
      invocationId,
      courseAlias: input.courseAlias,
      decisionKey: `decision-key-${suffix}`,
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
      evidenceAsOf: worldAsOf,
      decisionJson: JSON.stringify(decisionSummary),
      bodyPersisted: false,
      publishAttempted: false,
      editorWriteAttempted: false,
      semanticRealization: {
        create: {
          id: `semantic-realization-${suffix}`,
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

  return Object.freeze({
    courseAlias: input.courseAlias,
    invocationId,
    scanId,
    snapshotId,
    decisionId,
    candidateKey,
    threadKey,
    rootEventKey,
    worldAsOf: worldAsOf.toISOString(),
    manifestHash: input.manifestHash,
    worldHash,
    eventSetHash,
    targetVersionHash,
    opportunityReceiptHash,
    revalidationReceiptHash,
    afterObservationReceiptHash,
    draftBody,
    draftBodyHash
  });
}
