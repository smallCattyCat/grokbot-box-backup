import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "../../lib/facilitation-protocol";
import {
  DRAFT_STAGING_CAPTURE_SCHEMA_VERSION,
  buildDraftStagingReceipt,
  parseDraftStagingCapture
} from "../../lib/live-runtime/draft-staging";
import {
  LIVE_OPPORTUNITY_ASSESSMENT_SCHEMA_VERSION,
  buildLiveFacilitationOpportunity,
  parseLiveOpportunityAssessment,
  type LiveOpportunityAssessment,
  type TrustedSchedulingHistoryAttestation
} from "../../lib/live-runtime/facilitation-kernel";
import {
  LIVE_REVALIDATION_CAPTURE_SCHEMA_VERSION,
  buildLiveRevalidation,
  parseLiveRevalidationCapture
} from "../../lib/live-runtime/revalidation";
import {
  loadLatestDraftTransportSmoke,
  persistRuntimeReceipt
} from "../../lib/live-runtime/store";
import {
  DRAFT_TRANSPORT_SMOKE_CAPTURE_SCHEMA_VERSION,
  buildDraftTransportSmokeReceipt,
  parseDraftTransportSmokeCapture
} from "../../lib/live-runtime/transport-smoke";
import {
  createCmoocUiReadinessReceipt,
  type CmoocUiReadinessObservation
} from "../../lib/platform-readiness/cmooc-ui-readiness";
import {
  LIVE_UI_CAPTURE_SCHEMA_VERSION,
  liveUiSurfaceLocatorHash,
  sealLiveUiCapture,
  type LiveUiCapture,
  type LiveUiObservationReceipt
} from "../../lib/ui-agent/live-observation";

const COURSE_URL =
  "https://cmooc.bnu.edu.cn/cMOOC/course?courseId=2059000000000000000&isBack=1";
const SECRET = Buffer.alloc(32, 19);
const TARGET_HASH = sha("target-v1");
const PUBLISHED_AT = "2026-07-25T08:00:00.000Z";

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function baseline() {
  const observation: CmoocUiReadinessObservation = {
    finalUrl: COURSE_URL,
    browserRuntime: "playwright_chromium",
    courseShellDetected: true,
    categoryTabCount: 7,
    visibleCardCount: 1,
    publicLoginControlDetected: false,
    detailObservation: "interaction_no_transition",
    allowedGetOrHeadCount: 10,
    allowedSemanticReadPostCount: 2,
    blockedWriteRequestCount: 0,
    blockedCrossOriginRequestCount: 0,
    apiAssistKinds: ["sketch_page"],
    visibleCardKeys: ["a".repeat(24)],
    selectedThreadKey: null,
    detailEvidenceLevel: "none"
  };
  const created = createCmoocUiReadinessReceipt({
    canonicalUrl: COURSE_URL,
    normalizationSource: "exact_url",
    inputWasNormalized: false,
    observedAt: "2026-07-29T11:59:00.000Z",
    observation
  });
  return {
    evidenceHash: created.evidenceHash,
    receipt: created.receipt
  };
}

function capture(input: {
  observedAt: string;
  publishedAt?: string;
  targetVersionHash?: string;
  externalEvent?: boolean;
  authorEvent?: boolean;
  systemEvent?: boolean;
  distinctUnknownEvent?: boolean;
  omitRoot?: boolean;
  completeness?: "complete" | "visible_only";
}): LiveUiCapture {
  const base = baseline();
  const events: NonNullable<LiveUiCapture["detail"]>["events"] = [
    {
      eventRef: "thread-1",
      actorRef: "author-1",
      parentEventRef: null,
      createdAt: input.publishedAt ?? PUBLISHED_AT,
      actorRelation: "thread_author",
      actorRelationBasis: "stable_actor_match"
    }
  ];
  if (input.omitRoot) {
    events.length = 0;
  }
  if (input.externalEvent) {
    events.push({
      eventRef: "comment-1",
      actorRef: "external-1",
      parentEventRef: "thread-1",
      createdAt: "2026-07-29T12:01:30.000Z",
      actorRelation: "external_human",
      actorRelationBasis: "course_role_registry"
    });
  }
  if (input.authorEvent) {
    events.push({
      eventRef: "comment-author-1",
      actorRef: "author-1",
      parentEventRef: input.omitRoot ? null : "thread-1",
      createdAt: "2026-07-29T12:01:30.000Z",
      actorRelation: "thread_author",
      actorRelationBasis: "stable_actor_match"
    });
  }
  if (input.systemEvent) {
    events.push({
      eventRef: "comment-system-1",
      actorRef: "system-1",
      parentEventRef: input.omitRoot ? null : "thread-1",
      createdAt: "2026-07-29T12:01:30.000Z",
      actorRelation: "system_or_agent",
      actorRelationBasis: "course_role_registry"
    });
  }
  if (input.distinctUnknownEvent) {
    events.push({
      eventRef: "comment-unknown-stable-1",
      actorRef: "stable-other-account",
      parentEventRef: input.omitRoot ? null : "thread-1",
      createdAt: "2026-07-29T12:01:30.000Z",
      actorRelation: "unknown",
      actorRelationBasis: "unavailable"
    });
  }
  const commentCount = events.length - 1;
  return {
    schemaVersion: LIVE_UI_CAPTURE_SCHEMA_VERSION,
    baselineEvidenceHash: base.evidenceHash,
    targetInput: COURSE_URL,
    driverKind: "chrome_computer_use",
    driverSessionRef: "agent-owned-tab-1",
    observedAt: input.observedAt,
    finalUrl:
      "https://cmooc.bnu.edu.cn/cMOOC/detail?id=thread-1&type=SKETCH",
    courseShellDetected: true,
    categoryTabCount: 7,
    visibleCardCount: 1,
    detailObservation: "detail_observed",
    detail: {
      courseRef:
        new URL(COURSE_URL).searchParams.get("courseId") ?? "",
      threadRef: "thread-1",
      authorRef: "author-1",
      targetVersionHash:
        input.targetVersionHash ?? TARGET_HASH,
      eventCount: events.length,
      commentCount,
      externalCommentCount: input.externalEvent ? 1 : 0,
      selfCommentCount: input.authorEvent ? 1 : 0,
      uniqueExternalAuthorCount: input.externalEvent ? 1 : 0,
      replyEdgeCount: commentCount,
      maxReplyDepth: commentCount > 0 ? 1 : 0,
      latestEventAt:
        events[events.length - 1]?.createdAt ??
        input.publishedAt ??
        PUBLISHED_AT,
      commentCompleteness: input.completeness ?? "complete",
      identityBasis: "stable_platform_ref",
      versionBasis: "current_fingerprint",
      events
    },
    actions: [
      {
        sequence: 1,
        action: "navigate",
        outcome: "verified",
        postcondition: "target_url_verified",
        postconditionVerified: true
      },
      {
        sequence: 2,
        action: "observe_course",
        outcome: "verified",
        postcondition: "course_shell_present",
        postconditionVerified: true
      },
      {
        sequence: 3,
        action: "open_card",
        outcome: "verified",
        postcondition: "detail_state_changed",
        postconditionVerified: true
      }
    ],
    networkGuardAttached: true,
    requestedMutationCount: 0,
    blockedMutationCount: 0,
    sentMutationCount: 0,
    externalWriteAttempted: false,
    containsForumText: false
  };
}

function sealedObservation(
  input: Parameters<typeof capture>[0] & {
    guardExpiresAt?: string;
    role?: "learner" | "creator" | "helper";
  }
) {
  const base = baseline();
  const rawCapture = capture(input);
  return sealLiveUiCapture({
    capture: rawCapture,
    baseline: base,
    secret: SECRET,
    trustedGuardAttestation: {
      guardReceiptHash: sha("guard-receipt"),
      driverSessionRef: rawCapture.driverSessionRef,
      surfaceLocatorHash: liveUiSurfaceLocatorHash(
        rawCapture.finalUrl
      ),
      attachedAt: "2026-07-25T07:59:00.000Z",
      observedAt: rawCapture.observedAt,
      expiresAt:
        input.guardExpiresAt ??
        "2026-07-29T12:30:00.000Z",
      sentMutationCount: 0
    },
    trustedRoleAttestation: {
      roleReceiptHash: sha("role-receipt"),
      courseRef: rawCapture.detail?.courseRef ?? "",
      actorRef: rawCapture.detail?.authorRef ?? "",
      role: input.role ?? "learner",
      issuedAt: "2026-07-25T07:58:00.000Z",
      expiresAt: "2026-07-30T12:30:00.000Z"
    }
  });
}

function assessment(
  observation: ReturnType<typeof sealedObservation>,
  overrides: Partial<LiveOpportunityAssessment> = {}
) {
  return parseLiveOpportunityAssessment({
    schemaVersion: LIVE_OPPORTUNITY_ASSESSMENT_SCHEMA_VERSION,
    observationReceiptHash: observation.receiptHash,
    assessedAt: "2026-07-29T12:01:10.000Z",
    historyCutoffHash: sha("cutoff-1"),
    targetVersionHash: observation.receipt.targetVersionHash,
    eventSetHash: observation.receipt.eventSetHash,
    contributionPublishedAt: PUBLISHED_AT,
    runtimeMode: "real_course_shadow",
    targetActorRole: "learner",
    testActorAuthorized: false,
    contributionFunctions: ["meaning_making", "innovation"],
    sequenceCompletion: "open",
    atomicIdeaCount: 1,
    epistemicSeedStatus: "supported",
    needSignals: {
      connectionGap: "supported",
      conceptualTension: "supported",
      participationBarrier: "unsupported"
    },
    dominantNeed: "conceptual_tension",
    relationQualification: "supported",
    longitudinalHistoryStatus: "sufficient",
    candidateUniverse: "support_gap",
    authorTouchCount30d: 0,
    lastSystemTouchAt: null,
    budget: {
      availableSlots: 3,
      workloadCost: 1,
      authorTouchLimit30d: 2
    },
    containsForumText: false,
    ...overrides
  });
}

function trustedHistoryAttestation(
  currentAssessment: LiveOpportunityAssessment,
  observation: LiveUiObservationReceipt
): TrustedSchedulingHistoryAttestation {
  if (!observation.authorKey) {
    throw new Error("测试观察缺少作者键。");
  }
  return {
    historyReceiptHash: sha("history-receipt"),
    observationReceiptHash:
      currentAssessment.observationReceiptHash,
    courseKey: observation.courseKey,
    authorKey: observation.authorKey,
    historyCutoffHash: currentAssessment.historyCutoffHash,
    observedThrough: currentAssessment.assessedAt,
    issuedAt: currentAssessment.assessedAt,
    expiresAt: new Date(
      Date.parse(currentAssessment.assessedAt) + 5 * 60_000
    ).toISOString(),
    longitudinalHistoryStatus:
      currentAssessment.longitudinalHistoryStatus,
    candidateUniverse: currentAssessment.candidateUniverse,
    authorTouchCount30d:
      currentAssessment.authorTouchCount30d,
    lastSystemTouchAt: currentAssessment.lastSystemTouchAt,
    budget: currentAssessment.budget
  };
}

function buildOpportunity(
  input: Omit<
    Parameters<typeof buildLiveFacilitationOpportunity>[0],
    "trustedHistoryAttestation"
  >
) {
  return buildLiveFacilitationOpportunity({
    ...input,
    trustedHistoryAttestation: trustedHistoryAttestation(
      input.assessment,
      input.observation
    )
  });
}

function draftOpportunity() {
  const observation = sealedObservation({
    observedAt: "2026-07-29T12:01:00.000Z"
  });
  const result = buildOpportunity({
    assessment: assessment(observation),
    observation: observation.receipt,
    trustedNow: "2026-07-29T12:01:10.000Z"
  });
  return { observation, result };
}

function stagingCapture(input: {
  opportunityReceiptHash: string;
  revalidationReceiptHash: string;
  afterObservationReceiptHash: string;
  observedAt: string;
  targetVersionHash: string;
  draftContentHash: string;
}) {
  return parseDraftStagingCapture({
    schemaVersion: DRAFT_STAGING_CAPTURE_SCHEMA_VERSION,
    opportunityReceiptHash: input.opportunityReceiptHash,
    revalidationReceiptHash: input.revalidationReceiptHash,
    afterObservationReceiptHash:
      input.afterObservationReceiptHash,
    guardReceiptHash: sha("guard-receipt"),
    observedAt: input.observedAt,
    targetVersionHash: input.targetVersionHash,
    draftContentHash: input.draftContentHash,
    editorValueHash: input.draftContentHash,
    editorWriteOutcome: "verified",
    networkGuardAttachedBeforeTyping: true,
    localUiMutationPerformed: true,
    remoteWriteSent: false,
    sentMutationCount: 0,
    publishControlActivated: false,
    submitKeyboardShortcutUsed: false,
    formSubmitTriggered: false,
    publishNetworkRequestCount: 0,
    externalPublishAttempted: false,
    containsForumText: false
  });
}

test("严格资格链产生 P4 Intent、MoveSpec 和易失草稿，但不授予发布", () => {
  const { result } = draftOpportunity();
  assert.equal(result.receipt.decision, "draft");
  assert.equal(result.receipt.decisionMode, "DRAFT_ELIGIBLE");
  assert.equal(
    result.receipt.selectedFunction,
    "cognitive_conflict"
  );
  assert.equal(result.receipt.intent?.intervene, true);
  assert.equal(
    result.receipt.moveSpec?.facilitationMove,
    "pose_counterexample_and_request_explanation"
  );
  assert.equal(typeof result.transientDraft, "string");
  assert.equal(result.receipt.draftBodyPersisted, false);
  assert.equal(result.receipt.realPublishEnabled, false);
  assert.equal(result.receipt.publishCapabilityAvailable, false);
  assert.equal(
    JSON.stringify(result.receipt).includes(
      result.transientDraft ?? "missing"
    ),
    false
  );
});

test("可教回合只能收窄决定：复用影子草稿时等待且不再次生成正文", () => {
  const observation = sealedObservation({
    observedAt: "2026-07-29T12:01:00.000Z"
  });
  const receiptHash = sha("teachable-episode-reuse");
  const result = buildOpportunity({
    assessment: assessment(observation),
    observation: observation.receipt,
    trustedNow: "2026-07-29T12:01:10.000Z",
    teachableEpisodeDirective: {
      action: "wait",
      reasonCode: "shadow_draft_unchanged_reused",
      receiptHash
    }
  });

  assert.equal(result.receipt.decision, "wait");
  assert.equal(result.receipt.decisionMode, "WAIT_FORCED");
  assert.equal(
    result.receipt.reasonCode,
    "shadow_draft_unchanged_reused"
  );
  assert.equal(result.receipt.teachableEpisodeReceiptHash, receiptHash);
  assert.equal(result.receipt.draftCreated, false);
  assert.equal(result.transientDraft, null);

  assert.throws(
    () =>
      buildOpportunity({
        assessment: assessment(observation),
        observation: observation.receipt,
        trustedNow: "2026-07-29T12:01:10.000Z",
        teachableEpisodeDirective: {
          action: "yield",
          reasonCode: "shadow_draft_unchanged_reused",
          receiptHash
        }
      }),
    /动作与理由不匹配/
  );
});

test("真人已连接或序列已经社会性完成时让位且不生成草稿", () => {
  const humanObservation = sealedObservation({
    observedAt: "2026-07-29T12:02:00.000Z",
    externalEvent: true
  });
  const human = buildOpportunity({
    assessment: assessment(humanObservation, {
      assessedAt: "2026-07-29T12:02:10.000Z"
    }),
    observation: humanObservation.receipt,
    trustedNow: "2026-07-29T12:02:10.000Z"
  });
  assert.equal(human.receipt.decision, "yield");
  assert.equal(human.receipt.reasonCode, "external_human_response");
  assert.equal(human.transientDraft, null);

  const base = sealedObservation({
    observedAt: "2026-07-29T12:01:00.000Z"
  });
  const complete = buildOpportunity({
    assessment: assessment(base, {
      sequenceCompletion: "socially_complete"
    }),
    observation: base.receipt,
    trustedNow: "2026-07-29T12:01:10.000Z"
  });
  assert.equal(complete.receipt.decision, "yield");
  assert.equal(
    complete.receipt.reasonCode,
    "sequence_socially_complete"
  );
});

test("稳定异账号回复触发结构性让位，但不登记为真人回复", () => {
  const observation = sealedObservation({
    observedAt: "2026-07-29T12:02:00.000Z",
    distinctUnknownEvent: true,
    completeness: "visible_only"
  });
  const result = buildOpportunity({
    assessment: assessment(observation, {
      assessedAt: "2026-07-29T12:02:10.000Z",
      sequenceCompletion: "unknown",
      relationQualification: "unresolved"
    }),
    observation: observation.receipt,
    trustedNow: "2026-07-29T12:02:10.000Z"
  });

  assert.equal(result.receipt.decision, "yield");
  assert.equal(result.receipt.decisionMode, "YIELD_TO_EXISTING_RESPONSE");
  assert.equal(result.receipt.reasonCode, "distinct_actor_response");
  assert.equal(observation.receipt.externalCommentCount, 0);
  assert.equal(
    observation.receipt.eventEvidence.filter(
      (event) => event.actorRelation === "external_human"
    ).length,
    0
  );
  assert.equal(result.transientDraft, null);
});

test("72 小时未成熟、历史不足、冷却期和预算均形成显式 WAIT", () => {
  const observation = sealedObservation({
    observedAt: "2026-07-29T12:01:00.000Z"
  });
  const youngPublishedAt = "2026-07-28T12:01:00.000Z";
  const youngObservation = sealedObservation({
    observedAt: "2026-07-29T12:01:00.000Z",
    publishedAt: youngPublishedAt
  });
  const young = buildOpportunity({
    assessment: assessment(youngObservation, {
      contributionPublishedAt: youngPublishedAt
    }),
    observation: youngObservation.receipt,
    trustedNow: "2026-07-29T12:01:10.000Z"
  });
  assert.equal(young.receipt.decision, "wait");
  assert.equal(young.receipt.reasonCode, "support_gap_not_mature");
  const cases = [
    {
      override: {
        longitudinalHistoryStatus: "insufficient" as const
      },
      reason: "insufficient_longitudinal_history"
    },
    {
      override: {
        lastSystemTouchAt: "2026-07-28T12:00:00.000Z"
      },
      reason: "author_cooldown_active"
    },
    {
      override: {
        budget: {
          availableSlots: 0,
          workloadCost: 1,
          authorTouchLimit30d: 2
        }
      },
      reason: "budget_unavailable"
    }
  ];
  for (const item of cases) {
    const result = buildOpportunity({
      assessment: assessment(observation, item.override),
      observation: observation.receipt,
      trustedNow: "2026-07-29T12:01:10.000Z"
    });
    assert.equal(result.receipt.decision, "wait");
    assert.equal(result.receipt.reasonCode, item.reason);
  }
});

test("未知构念或不完整评论进入弃答，不用 0 冒充证据", () => {
  const observation = sealedObservation({
    observedAt: "2026-07-29T12:01:00.000Z"
  });
  const unknown = buildOpportunity({
    assessment: assessment(observation, {
      dominantNeed: "unknown"
    }),
    observation: observation.receipt,
    trustedNow: "2026-07-29T12:01:10.000Z"
  });
  assert.equal(unknown.receipt.decision, "abstain");
  assert.equal(unknown.receipt.reasonCode, "construct_unanswerable");

  const incomplete = sealedObservation({
    observedAt: "2026-07-29T12:01:00.000Z",
    completeness: "visible_only"
  });
  const censored = buildOpportunity({
    assessment: assessment(incomplete),
    observation: incomplete.receipt,
    trustedNow: "2026-07-29T12:01:10.000Z"
  });
  assert.equal(censored.receipt.decision, "abstain");
  assert.equal(censored.receipt.reasonCode, "source_censored");
});

test("未知角色不能冒充学习者，裸布尔测试授权也不能放行", () => {
  const observation = sealedObservation({
    observedAt: "2026-07-29T12:01:00.000Z"
  });
  const unknown = buildOpportunity({
    assessment: assessment(observation, {
      targetActorRole: "unknown"
    }),
    observation: observation.receipt,
    trustedNow: "2026-07-29T12:01:10.000Z"
  });
  assert.equal(unknown.receipt.decision, "abstain");
  assert.equal(unknown.receipt.reasonCode, "construct_unanswerable");
  assert.equal(
    unknown.receipt.qualification.reasonCodes.includes(
      "target_role_unknown"
    ),
    true
  );

  assert.throws(
    () =>
      assessment(observation, {
        runtimeMode: "test_platform_validation",
        targetActorRole: "unknown",
        testActorAuthorized: true
      }),
    /独立许可回执/
  );
});

test("评估自报 learner 不能覆盖课程角色回执中的非学习者身份", () => {
  const observation = sealedObservation({
    observedAt: "2026-07-29T12:01:00.000Z",
    role: "creator"
  });
  const result = buildOpportunity({
    assessment: assessment(observation),
    observation: observation.receipt,
    trustedNow: "2026-07-29T12:01:10.000Z"
  });
  assert.equal(result.receipt.decision, "abstain");
  assert.equal(result.receipt.targetRoleBasis, "unqualified");
  assert.equal(
    result.receipt.qualification.reasonCodes.includes(
      "target_actor_ineligible"
    ),
    true
  );
});

test("机会评估时间必须与服务器可信时钟相符", () => {
  const observation = sealedObservation({
    observedAt: "2026-07-29T12:01:00.000Z"
  });
  assert.throws(
    () =>
      buildOpportunity({
        assessment: assessment(observation),
        observation: observation.receipt,
        trustedNow: "2026-07-29T12:02:00.001Z"
      }),
    /服务器时钟绑定/
  );
});

test("72 小时、触达和预算必须来自受信 as-of 历史回执", () => {
  const observation = sealedObservation({
    observedAt: "2026-07-29T12:01:00.000Z"
  });
  const currentAssessment = assessment(observation);
  const missing = buildLiveFacilitationOpportunity({
    assessment: currentAssessment,
    observation: observation.receipt,
    trustedNow: "2026-07-29T12:01:10.000Z"
  });
  assert.equal(missing.receipt.decision, "abstain");
  assert.equal(
    missing.receipt.reasonCode,
    "history_evidence_unavailable"
  );
  assert.equal(missing.receipt.historyEvidenceHash, null);

  assert.throws(
    () =>
      buildOpportunity({
        assessment: assessment(observation, {
          contributionPublishedAt:
            "2026-07-20T08:00:00.000Z"
        }),
        observation: observation.receipt,
        trustedNow: "2026-07-29T12:01:10.000Z"
      }),
    /唯一的作者根事件/
  );

  assert.throws(
    () =>
      buildLiveFacilitationOpportunity({
        assessment: currentAssessment,
        observation: observation.receipt,
        trustedNow: "2026-07-29T12:01:10.000Z",
        trustedHistoryAttestation: {
          ...trustedHistoryAttestation(
            currentAssessment,
            observation.receipt
          ),
          historyCutoffHash: sha("different-cutoff")
        }
      }),
    /调度历史回执与当前观察/
  );
});

test("目标重读以事件级去标识差量识别真人回复并优先让位", () => {
  const { observation: before, result: opportunity } =
    draftOpportunity();
  const stableAfter = sealedObservation({
    observedAt: "2026-07-29T12:02:00.000Z"
  });
  const stableCapture = parseLiveRevalidationCapture({
    schemaVersion: LIVE_REVALIDATION_CAPTURE_SCHEMA_VERSION,
    opportunityReceiptHash: opportunity.receiptHash,
    afterObservationReceiptHash: stableAfter.receiptHash,
    checkedAt: "2026-07-29T12:02:05.000Z",
    containsForumText: false
  });
  const stable = buildLiveRevalidation({
    capture: stableCapture,
    opportunity: opportunity.receipt,
    beforeObservation: before.receipt,
    afterObservation: stableAfter.receipt,
    trustedNow: "2026-07-29T12:02:05.000Z"
  });
  assert.equal(stable.receipt.decision, "DRAFT_STAGING_ALLOWED");

  const humanAfter = sealedObservation({
    observedAt: "2026-07-29T12:02:00.000Z",
    externalEvent: true,
    targetVersionHash: sha("target-v2")
  });
  const human = buildLiveRevalidation({
    capture: parseLiveRevalidationCapture({
      schemaVersion: LIVE_REVALIDATION_CAPTURE_SCHEMA_VERSION,
      opportunityReceiptHash: opportunity.receiptHash,
      afterObservationReceiptHash: humanAfter.receiptHash,
      checkedAt: "2026-07-29T12:02:05.000Z",
      containsForumText: false
    }),
    opportunity: opportunity.receipt,
    beforeObservation: before.receipt,
    afterObservation: humanAfter.receipt,
    trustedNow: "2026-07-29T12:02:05.000Z"
  });
  assert.equal(
    human.receipt.decision,
    "WITHDRAWN_EXTERNAL_HUMAN_RESPONSE"
  );
  assert.equal(
    human.receipt.newlyObservedExternalHumanEventCount,
    1
  );
});

test("作者再参与或既有智能体新回复都会撤回旧草稿", () => {
  const { observation: before, result: opportunity } =
    draftOpportunity();
  const cases = [
    {
      after: sealedObservation({
        observedAt: "2026-07-29T12:02:00.000Z",
        authorEvent: true
      }),
      decision: "WITHDRAWN_ORIGINAL_AUTHOR_RETURN"
    },
    {
      after: sealedObservation({
        observedAt: "2026-07-29T12:02:00.000Z",
        systemEvent: true
      }),
      decision: "WITHDRAWN_EXISTING_SYSTEM_RESPONSE"
    }
  ] as const;
  for (const item of cases) {
    const result = buildLiveRevalidation({
      capture: parseLiveRevalidationCapture({
        schemaVersion: LIVE_REVALIDATION_CAPTURE_SCHEMA_VERSION,
        opportunityReceiptHash: opportunity.receiptHash,
        afterObservationReceiptHash: item.after.receiptHash,
        checkedAt: "2026-07-29T12:02:05.000Z",
        containsForumText: false
      }),
      opportunity: opportunity.receipt,
      beforeObservation: before.receipt,
      afterObservation: item.after.receipt,
      trustedNow: "2026-07-29T12:02:05.000Z"
    });
    assert.equal(result.receipt.decision, item.decision);
    assert.equal(result.receipt.draftStagingAllowed, false);
  }
});

test("重读发现稳定异账号未知角色回复时撤回旧草稿且不计真人 outcome", () => {
  const { observation: before, result: opportunity } =
    draftOpportunity();
  const after = sealedObservation({
    observedAt: "2026-07-29T12:02:00.000Z",
    distinctUnknownEvent: true
  });
  const result = buildLiveRevalidation({
    capture: parseLiveRevalidationCapture({
      schemaVersion: LIVE_REVALIDATION_CAPTURE_SCHEMA_VERSION,
      opportunityReceiptHash: opportunity.receiptHash,
      afterObservationReceiptHash: after.receiptHash,
      checkedAt: "2026-07-29T12:02:05.000Z",
      containsForumText: false
    }),
    opportunity: opportunity.receipt,
    beforeObservation: before.receipt,
    afterObservation: after.receipt,
    trustedNow: "2026-07-29T12:02:05.000Z"
  });

  assert.equal(
    result.receipt.decision,
    "WITHDRAWN_DISTINCT_ACTOR_RESPONSE"
  );
  assert.equal(result.receipt.reasonCode, "distinct_actor_response");
  assert.equal(result.receipt.newlyObservedDistinctActorEventCount, 1);
  assert.equal(
    result.receipt.newlyObservedExternalHumanEventCount,
    0
  );
});

test("重读若丢失先前事件前缀则转长期审核", () => {
  const { observation: before, result: opportunity } =
    draftOpportunity();
  const stableAfter = sealedObservation({
    observedAt: "2026-07-29T12:02:00.000Z"
  });
  const afterReceipt = {
    ...stableAfter.receipt,
    eventEvidence: [],
    eventSetHash: sha("censored-event-set")
  };
  const afterHash = canonicalProtocolHash(
    afterReceipt.schemaVersion,
    afterReceipt as CanonicalJsonValue
  );
  const result = buildLiveRevalidation({
    capture: parseLiveRevalidationCapture({
      schemaVersion: LIVE_REVALIDATION_CAPTURE_SCHEMA_VERSION,
      opportunityReceiptHash: opportunity.receiptHash,
      afterObservationReceiptHash: afterHash,
      checkedAt: "2026-07-29T12:02:05.000Z",
      containsForumText: false
    }),
    opportunity: opportunity.receipt,
    beforeObservation: before.receipt,
    afterObservation: afterReceipt,
    trustedNow: "2026-07-29T12:02:05.000Z"
  });
  assert.equal(
    result.receipt.decision,
    "REVIEW_REQUIRED_SOURCE_CENSORED"
  );
  assert.equal(
    result.receipt.removedPreviouslyObservedEventCount,
    1
  );
});

test("无真人回复但目标版本变化时转长期审核", () => {
  const { observation: before, result: opportunity } =
    draftOpportunity();
  const changedAfter = sealedObservation({
    observedAt: "2026-07-29T12:02:00.000Z",
    targetVersionHash: sha("target-v2")
  });
  const result = buildLiveRevalidation({
    capture: parseLiveRevalidationCapture({
      schemaVersion: LIVE_REVALIDATION_CAPTURE_SCHEMA_VERSION,
      opportunityReceiptHash: opportunity.receiptHash,
      afterObservationReceiptHash: changedAfter.receiptHash,
      checkedAt: "2026-07-29T12:02:05.000Z",
      containsForumText: false
    }),
    opportunity: opportunity.receipt,
    beforeObservation: before.receipt,
    afterObservation: changedAfter.receipt,
    trustedNow: "2026-07-29T12:02:05.000Z"
  });
  assert.equal(
    result.receipt.decision,
    "REVIEW_REQUIRED_TARGET_CHANGED"
  );
});

test("重读不能引用 checkedAt 之后的未来观察", () => {
  const { observation: before, result: opportunity } =
    draftOpportunity();
  const futureAfter = sealedObservation({
    observedAt: "2026-07-29T12:05:00.000Z"
  });
  assert.throws(
    () =>
      buildLiveRevalidation({
        capture: parseLiveRevalidationCapture({
          schemaVersion:
            LIVE_REVALIDATION_CAPTURE_SCHEMA_VERSION,
          opportunityReceiptHash: opportunity.receiptHash,
          afterObservationReceiptHash: futureAfter.receiptHash,
          checkedAt: "2026-07-29T12:04:59.000Z",
          containsForumText: false
        }),
        opportunity: opportunity.receipt,
        beforeObservation: before.receipt,
        afterObservation: futureAfter.receipt,
        trustedNow: "2026-07-29T12:04:59.000Z"
      }),
    /时间顺序/
  );
});

test("草稿只在同标签页守卫后形成 DRAFT_STAGED_NOT_PUBLISHED 回执", () => {
  const { observation: before, result: opportunity } =
    draftOpportunity();
  const after = sealedObservation({
    observedAt: "2026-07-29T12:02:00.000Z"
  });
  const revalidation = buildLiveRevalidation({
    capture: parseLiveRevalidationCapture({
      schemaVersion: LIVE_REVALIDATION_CAPTURE_SCHEMA_VERSION,
      opportunityReceiptHash: opportunity.receiptHash,
      afterObservationReceiptHash: after.receiptHash,
      checkedAt: "2026-07-29T12:02:05.000Z",
      containsForumText: false
    }),
    opportunity: opportunity.receipt,
    beforeObservation: before.receipt,
    afterObservation: after.receipt,
    trustedNow: "2026-07-29T12:02:05.000Z"
  });
  const staging = buildDraftStagingReceipt({
    capture: parseDraftStagingCapture({
      schemaVersion: DRAFT_STAGING_CAPTURE_SCHEMA_VERSION,
      opportunityReceiptHash: opportunity.receiptHash,
      revalidationReceiptHash: revalidation.receiptHash,
      afterObservationReceiptHash: after.receiptHash,
      guardReceiptHash: sha("guard-receipt"),
      observedAt: "2026-07-29T12:02:10.000Z",
      targetVersionHash: opportunity.receipt.targetVersionHash,
      draftContentHash: opportunity.receipt.draftContentHash,
      editorValueHash: opportunity.receipt.draftContentHash,
      editorWriteOutcome: "verified",
      networkGuardAttachedBeforeTyping: true,
      localUiMutationPerformed: true,
      remoteWriteSent: false,
      sentMutationCount: 0,
      publishControlActivated: false,
      submitKeyboardShortcutUsed: false,
      formSubmitTriggered: false,
      publishNetworkRequestCount: 0,
      externalPublishAttempted: false,
      containsForumText: false
    }),
    opportunity: opportunity.receipt,
    revalidation: revalidation.receipt,
    afterObservation: after.receipt,
    trustedNow: "2026-07-29T12:02:10.000Z"
  });
  assert.equal(
    staging.receipt.state,
    "DRAFT_STAGED_NOT_PUBLISHED"
  );
  assert.equal(staging.receipt.localUiMutationPerformed, true);
  assert.equal(staging.receipt.remoteWriteSent, false);
  assert.equal(staging.receipt.publishAttempted, false);

  assert.throws(
    () =>
      buildDraftStagingReceipt({
        capture: parseDraftStagingCapture({
          schemaVersion: DRAFT_STAGING_CAPTURE_SCHEMA_VERSION,
          opportunityReceiptHash: opportunity.receiptHash,
          revalidationReceiptHash: revalidation.receiptHash,
          afterObservationReceiptHash: after.receiptHash,
          guardReceiptHash: sha("guard-receipt"),
          observedAt: "2026-07-29T12:32:00.000Z",
          targetVersionHash:
            opportunity.receipt.targetVersionHash,
          draftContentHash:
            opportunity.receipt.draftContentHash,
          editorValueHash:
            opportunity.receipt.draftContentHash,
          editorWriteOutcome: "verified",
          networkGuardAttachedBeforeTyping: true,
          localUiMutationPerformed: true,
          remoteWriteSent: false,
          sentMutationCount: 0,
          publishControlActivated: false,
          submitKeyboardShortcutUsed: false,
          formSubmitTriggered: false,
          publishNetworkRequestCount: 0,
          externalPublishAttempted: false,
          containsForumText: false
        }),
        opportunity: opportunity.receipt,
        revalidation: revalidation.receipt,
        afterObservation: after.receipt,
        trustedNow: "2026-07-29T12:32:00.000Z"
      }),
    /网络守卫已经失效|候选失效之前/
  );
});

test("草稿暂存拒绝跨机会拼接、过期守卫与自报旧时间", () => {
  const { observation: before, result: opportunity } =
    draftOpportunity();
  const otherOpportunity = buildOpportunity({
    assessment: assessment(before, {
      historyCutoffHash: sha("cutoff-2")
    }),
    observation: before.receipt,
    trustedNow: "2026-07-29T12:01:10.000Z"
  });
  const after = sealedObservation({
    observedAt: "2026-07-29T12:02:00.000Z"
  });
  const revalidation = buildLiveRevalidation({
    capture: parseLiveRevalidationCapture({
      schemaVersion: LIVE_REVALIDATION_CAPTURE_SCHEMA_VERSION,
      opportunityReceiptHash: opportunity.receiptHash,
      afterObservationReceiptHash: after.receiptHash,
      checkedAt: "2026-07-29T12:02:05.000Z",
      containsForumText: false
    }),
    opportunity: opportunity.receipt,
    beforeObservation: before.receipt,
    afterObservation: after.receipt,
    trustedNow: "2026-07-29T12:02:05.000Z"
  });
  assert.throws(
    () =>
      buildDraftStagingReceipt({
        capture: stagingCapture({
          opportunityReceiptHash: otherOpportunity.receiptHash,
          revalidationReceiptHash: revalidation.receiptHash,
          afterObservationReceiptHash: after.receiptHash,
          observedAt: "2026-07-29T12:02:10.000Z",
          targetVersionHash:
            otherOpportunity.receipt.targetVersionHash,
          draftContentHash:
            otherOpportunity.receipt.draftContentHash ?? ""
        }),
        opportunity: otherOpportunity.receipt,
        revalidation: revalidation.receipt,
        afterObservation: after.receipt,
        trustedNow: "2026-07-29T12:02:10.000Z"
      }),
    /同一机会与重读回执/
  );

  const expiringAfter = sealedObservation({
    observedAt: "2026-07-29T12:02:00.000Z",
    guardExpiresAt: "2026-07-29T12:02:07.000Z"
  });
  const expiringRevalidation = buildLiveRevalidation({
    capture: parseLiveRevalidationCapture({
      schemaVersion: LIVE_REVALIDATION_CAPTURE_SCHEMA_VERSION,
      opportunityReceiptHash: opportunity.receiptHash,
      afterObservationReceiptHash: expiringAfter.receiptHash,
      checkedAt: "2026-07-29T12:02:05.000Z",
      containsForumText: false
    }),
    opportunity: opportunity.receipt,
    beforeObservation: before.receipt,
    afterObservation: expiringAfter.receipt,
    trustedNow: "2026-07-29T12:02:05.000Z"
  });
  const expiringCapture = stagingCapture({
    opportunityReceiptHash: opportunity.receiptHash,
    revalidationReceiptHash: expiringRevalidation.receiptHash,
    afterObservationReceiptHash: expiringAfter.receiptHash,
    observedAt: "2026-07-29T12:02:10.000Z",
    targetVersionHash: opportunity.receipt.targetVersionHash,
    draftContentHash: opportunity.receipt.draftContentHash ?? ""
  });
  assert.throws(
    () =>
      buildDraftStagingReceipt({
        capture: expiringCapture,
        opportunity: opportunity.receipt,
        revalidation: expiringRevalidation.receipt,
        afterObservation: expiringAfter.receipt,
        trustedNow: "2026-07-29T12:02:10.000Z"
      }),
    /网络守卫已经失效/
  );
  assert.throws(
    () =>
      buildDraftStagingReceipt({
        capture: stagingCapture({
          opportunityReceiptHash: opportunity.receiptHash,
          revalidationReceiptHash: revalidation.receiptHash,
          afterObservationReceiptHash: after.receiptHash,
          observedAt: "2026-07-29T12:02:10.000Z",
          targetVersionHash: opportunity.receipt.targetVersionHash,
          draftContentHash:
            opportunity.receipt.draftContentHash ?? ""
        }),
        opportunity: opportunity.receipt,
        revalidation: revalidation.receipt,
        afterObservation: after.receipt,
        trustedNow: "2026-07-29T12:03:00.001Z"
      }),
    /服务器时钟绑定/
  );
});

test("发布标志、编辑器哈希不一致和正文持久化均 fail closed", async () => {
  const { result } = draftOpportunity();
  assert.throws(
    () =>
      parseDraftStagingCapture({
        schemaVersion: DRAFT_STAGING_CAPTURE_SCHEMA_VERSION,
        opportunityReceiptHash: result.receiptHash,
        revalidationReceiptHash: sha("revalidation"),
        afterObservationReceiptHash: sha("after"),
        guardReceiptHash: sha("guard"),
        observedAt: "2026-07-29T12:02:10.000Z",
        targetVersionHash: result.receipt.targetVersionHash,
        draftContentHash: result.receipt.draftContentHash,
        editorValueHash: result.receipt.draftContentHash,
        editorWriteOutcome: "verified",
        networkGuardAttachedBeforeTyping: true,
        localUiMutationPerformed: true,
        remoteWriteSent: false,
        sentMutationCount: 0,
        publishControlActivated: true,
        submitKeyboardShortcutUsed: false,
        formSubmitTriggered: false,
        publishNetworkRequestCount: 0,
        externalPublishAttempted: false,
        containsForumText: false
      }),
    /未发布边界/
  );

  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "cmooc-live-runtime-")
  );
  const receiptPath = await persistRuntimeReceipt({
    kind: "opportunities",
    receipt: result.receipt,
    receiptHash: result.receiptHash,
    outputRoot
  });
  const stored = await readFile(receiptPath, "utf8");
  assert.equal(
    stored.includes(result.transientDraft ?? "missing"),
    false
  );
  assert.equal(stored.includes("publishCapabilityAvailable\": true"), false);
  await assert.rejects(
    () =>
      persistRuntimeReceipt({
        kind: "opportunities",
        receipt: result.receipt,
        receiptHash: sha("wrong-receipt-hash"),
        outputRoot
      }),
    /哈希与内容不一致/
  );
  await assert.rejects(
    () =>
      persistRuntimeReceipt({
        kind: "transport-smoke",
        receipt: result.receipt,
        receiptHash: result.receiptHash,
        outputRoot
      }),
    /类型与保存目录不一致/
  );
});

test("无网络守卫的真实 Chrome 写入只记录传输冒烟且按课程隔离", async () => {
  const draftHash = sha("transport-draft");
  const result = buildDraftTransportSmokeReceipt(
    parseDraftTransportSmokeCapture({
      schemaVersion: DRAFT_TRANSPORT_SMOKE_CAPTURE_SCHEMA_VERSION,
      courseLocatorHash: sha("course-locator"),
      targetLocatorHash: sha("target-locator"),
      observedAt: "2026-07-29T12:03:00.000Z",
      commentCountBefore: 0,
      targetReobservedBeforeTyping: true,
      draftContentHash: draftHash,
      editorValueHash: draftHash,
      editorWriteOutcome: "verified",
      networkGuardStatus: "unavailable_in_chrome_plugin",
      publishControlActivated: false,
      submitKeyboardShortcutUsed: false,
      formSubmitTriggered: false,
      externalPublishAttempted: false,
      containsForumText: false
    })
  );
  assert.equal(
    result.receipt.state,
    "TRANSPORT_SMOKE_DRAFT_VISIBLE_NOT_SUBMITTED"
  );
  assert.equal(result.receipt.certifiedRuntimeStage, false);
  assert.equal(
    result.receipt.certificationBlocker,
    "network_guard_unavailable"
  );
  assert.equal(result.receipt.publishAttempted, false);
  assert.equal(result.receipt.eligibleForPublish, false);

  const other = buildDraftTransportSmokeReceipt(
    parseDraftTransportSmokeCapture({
      schemaVersion: DRAFT_TRANSPORT_SMOKE_CAPTURE_SCHEMA_VERSION,
      courseLocatorHash: sha("other-course-locator"),
      targetLocatorHash: sha("other-target-locator"),
      observedAt: "2026-07-29T12:04:00.000Z",
      commentCountBefore: 0,
      targetReobservedBeforeTyping: true,
      draftContentHash: draftHash,
      editorValueHash: draftHash,
      editorWriteOutcome: "verified",
      networkGuardStatus: "unavailable_in_chrome_plugin",
      publishControlActivated: false,
      submitKeyboardShortcutUsed: false,
      formSubmitTriggered: false,
      externalPublishAttempted: false,
      containsForumText: false
    })
  );
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "cmooc-smoke-course-filter-")
  );
  await persistRuntimeReceipt({
    kind: "transport-smoke",
    receipt: result.receipt,
    receiptHash: result.receiptHash,
    outputRoot
  });
  await persistRuntimeReceipt({
    kind: "transport-smoke",
    receipt: other.receipt,
    receiptHash: other.receiptHash,
    outputRoot
  });
  const loaded = await loadLatestDraftTransportSmoke(
    sha("course-locator"),
    outputRoot
  );
  assert.equal(loaded?.receiptHash, result.receiptHash);
});
