import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { buildLiveShadowQueue } from "../../lib/golden-path/live-shadow";
import {
  createCmoocUiReadinessReceipt,
  type CmoocUiReadinessObservation
} from "../../lib/platform-readiness/cmooc-ui-readiness";
import {
  LIVE_UI_CAPTURE_SCHEMA_VERSION,
  liveUiSurfaceLocatorHash,
  parseLiveUiCapture,
  sealLiveUiCapture,
  type LiveUiCapture
} from "../../lib/ui-agent/live-observation";

const COURSE_ID = "2059000000000000000";
const COURSE_URL =
  `https://cmooc.bnu.edu.cn/cMOOC/course?courseId=${COURSE_ID}&isBack=1`;
const SECRET = Buffer.alloc(32, 7);

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function readinessObservation(): CmoocUiReadinessObservation {
  return {
    finalUrl: COURSE_URL,
    browserRuntime: "playwright_chromium",
    courseShellDetected: true,
    categoryTabCount: 7,
    visibleCardCount: 2,
    publicLoginControlDetected: false,
    detailObservation: "interaction_no_transition",
    allowedGetOrHeadCount: 24,
    allowedSemanticReadPostCount: 2,
    blockedWriteRequestCount: 0,
    blockedCrossOriginRequestCount: 1,
    apiAssistKinds: ["course_columns", "sketch_page"],
    visibleCardKeys: [
      "111111111111111111111111",
      "222222222222222222222222"
    ],
    selectedThreadKey: null,
    detailEvidenceLevel: "none"
  };
}

function baseline() {
  const created = createCmoocUiReadinessReceipt({
    canonicalUrl: COURSE_URL,
    normalizationSource: "exact_url",
    inputWasNormalized: false,
    observedAt: "2026-07-29T12:00:00.000Z",
    observation: readinessObservation()
  });
  return {
    evidenceHash: created.evidenceHash,
    receipt: created.receipt
  };
}

function structuralCapture(
  overrides: Partial<LiveUiCapture> = {}
): LiveUiCapture {
  const base = baseline();
  return {
    schemaVersion: LIVE_UI_CAPTURE_SCHEMA_VERSION,
    baselineEvidenceHash: base.evidenceHash,
    targetInput: COURSE_URL,
    driverKind: "chrome_computer_use",
    driverSessionRef: "chrome-tab-local-1",
    observedAt: "2026-07-29T12:01:00.000Z",
    finalUrl: COURSE_URL,
    courseShellDetected: true,
    categoryTabCount: 7,
    visibleCardCount: 2,
    detailObservation: "interaction_no_transition",
    detail: null,
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
        action: "select_category",
        outcome: "unknown_timeout",
        postcondition: "category_state_changed",
        postconditionVerified: false
      }
    ],
    networkGuardAttached: false,
    requestedMutationCount: 0,
    blockedMutationCount: 0,
    sentMutationCount: 0,
    externalWriteAttempted: false,
    containsForumText: false,
    ...overrides
  };
}

test("真实 capture 严格拒绝正文或标题等额外字段", () => {
  const value = {
    ...structuralCapture(),
    title: "不应进入回执的帖子标题"
  };
  assert.throws(
    () => parseLiveUiCapture(value),
    /未允许字段/
  );
});

test("Chrome 动作超时后封存为 source_censored 且不重放", () => {
  const base = baseline();
  const sealed = sealLiveUiCapture({
    capture: structuralCapture({
      baselineEvidenceHash: base.evidenceHash
    }),
    baseline: base,
    secret: SECRET
  });

  assert.equal(
    sealed.receipt.attestationLevel,
    "same_target_correlated"
  );
  assert.equal(sealed.receipt.captureStatus, "source_censored");
  assert.equal(
    sealed.receipt.safeToAdvanceToSemanticReview,
    false
  );
  assert.equal(sealed.receipt.sentMutationCount, 0);
  assert.equal(sealed.receipt.containsForumText, false);
  const serialized = JSON.stringify(sealed);
  assert.equal(serialized.includes(COURSE_ID), false);
  assert.equal(serialized.includes(COURSE_URL), false);
  assert.equal(serialized.includes("chrome-tab-local-1"), false);
});

test("同路径但不同 courseId 的 Chrome 回执被拒绝", () => {
  const base = baseline();
  assert.throws(
    () =>
      sealLiveUiCapture({
        capture: structuralCapture({
          baselineEvidenceHash: base.evidenceHash,
          finalUrl:
            "https://cmooc.bnu.edu.cn/cMOOC/course?courseId=2059000000000000001&isBack=1"
        }),
        baseline: base,
        secret: SECRET
      }),
    /courseId/
  );
});

test("观察时间早于基线时拒绝封存", () => {
  const base = baseline();
  assert.throws(
    () =>
      sealLiveUiCapture({
        capture: structuralCapture({
          baselineEvidenceHash: base.evidenceHash,
          observedAt: "2026-07-29T11:59:59.000Z"
        }),
        baseline: base,
        secret: SECRET
      }),
    /观察时间早于/
  );
});

test("只有完整详情、可信学习者角色和同标签页守卫才进入 semantic_ready", () => {
  const base = baseline();
  const capture = structuralCapture({
    baselineEvidenceHash: base.evidenceHash,
    finalUrl:
      "https://cmooc.bnu.edu.cn/cMOOC/detail?id=thread-platform-ref&type=SKETCH",
    detailObservation: "detail_observed",
    detail: {
      courseRef:
        new URL(COURSE_URL).searchParams.get("courseId") ?? "",
      threadRef: "thread-platform-ref",
      authorRef: "author-platform-ref",
      targetVersionHash: sha("target-v1"),
      eventCount: 4,
      commentCount: 3,
      externalCommentCount: 2,
      selfCommentCount: 1,
      uniqueExternalAuthorCount: 2,
      replyEdgeCount: 3,
      maxReplyDepth: 3,
      latestEventAt: "2026-07-29T12:00:30.000Z",
      commentCompleteness: "complete",
      identityBasis: "stable_platform_ref",
      versionBasis: "current_fingerprint",
      events: [
        {
          eventRef: "thread-platform-ref",
          actorRef: "author-platform-ref",
          parentEventRef: null,
          createdAt: "2026-07-29T11:50:00.000Z",
          actorRelation: "thread_author",
          actorRelationBasis: "stable_actor_match"
        },
        {
          eventRef: "comment-1",
          actorRef: "external-1",
          parentEventRef: "thread-platform-ref",
          createdAt: "2026-07-29T11:55:00.000Z",
          actorRelation: "external_human",
          actorRelationBasis: "course_role_registry"
        },
        {
          eventRef: "comment-2",
          actorRef: "author-platform-ref",
          parentEventRef: "comment-1",
          createdAt: "2026-07-29T12:00:00.000Z",
          actorRelation: "thread_author",
          actorRelationBasis: "stable_actor_match"
        },
        {
          eventRef: "comment-3",
          actorRef: "external-2",
          parentEventRef: "comment-2",
          createdAt: "2026-07-29T12:00:30.000Z",
          actorRelation: "external_human",
          actorRelationBasis: "course_role_registry"
        }
      ]
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
    networkGuardAttached: true
  });
  const sealed = sealLiveUiCapture({
    capture,
    baseline: base,
    secret: SECRET,
    trustedGuardAttestation: {
      guardReceiptHash: sha("guard-receipt"),
      driverSessionRef: capture.driverSessionRef,
      surfaceLocatorHash: liveUiSurfaceLocatorHash(
        capture.finalUrl
      ),
      attachedAt: "2026-07-29T11:49:00.000Z",
      observedAt: capture.observedAt,
      expiresAt: "2026-07-29T12:10:00.000Z",
      sentMutationCount: 0
    },
    trustedRoleAttestation: {
      roleReceiptHash: sha("role-receipt"),
      courseRef: capture.detail?.courseRef ?? "",
      actorRef: capture.detail?.authorRef ?? "",
      role: "learner",
      issuedAt: "2026-07-29T11:40:00.000Z",
      expiresAt: "2026-07-29T12:10:00.000Z"
    }
  });
  assert.equal(sealed.receipt.captureStatus, "semantic_ready");
  assert.equal(sealed.receipt.attestationLevel, "same_tab_guarded");
  assert.equal(
    sealed.receipt.safeToAdvanceToSemanticReview,
    true
  );
  assert.equal(
    sealed.receipt.temporalEvidenceStatus,
    "live_prefix_observed"
  );
  assert.equal(
    sealed.receipt.contentRevisionStatus,
    "live_target_fingerprint_observed"
  );
  assert.equal(sealed.receipt.guardReceiptHash, sha("guard-receipt"));
  assert.equal(sealed.receipt.authorRole, "learner");
  assert.equal(
    sealed.receipt.authorRoleEvidenceHash,
    sha("role-receipt")
  );
  const withoutRoleReceipt = sealLiveUiCapture({
    capture,
    baseline: base,
    secret: SECRET,
    trustedGuardAttestation: {
      guardReceiptHash: sha("guard-receipt"),
      driverSessionRef: capture.driverSessionRef,
      surfaceLocatorHash: liveUiSurfaceLocatorHash(
        capture.finalUrl
      ),
      attachedAt: "2026-07-29T11:49:00.000Z",
      observedAt: capture.observedAt,
      expiresAt: "2026-07-29T12:10:00.000Z",
      sentMutationCount: 0
    }
  });
  assert.equal(
    withoutRoleReceipt.receipt.captureStatus,
    "structural_observed"
  );
  assert.equal(withoutRoleReceipt.receipt.authorRole, "unknown");
  assert.throws(
    () =>
      sealLiveUiCapture({
        capture: {
          ...capture,
          detail: {
            ...capture.detail!,
            courseRef: "different-course"
          }
        },
        baseline: base,
        secret: SECRET
      }),
    /courseId/
  );
});

test("调用方自报网络守卫不能升级为 same_tab_guarded", () => {
  const base = baseline();
  const capture = structuralCapture({
    baselineEvidenceHash: base.evidenceHash,
    networkGuardAttached: true
  });
  const sealed = sealLiveUiCapture({
    capture,
    baseline: base,
    secret: SECRET
  });
  assert.equal(
    sealed.receipt.attestationLevel,
    "same_target_correlated"
  );
  assert.equal(sealed.receipt.networkGuardAttached, false);
  assert.equal(sealed.receipt.guardReceiptHash, null);
  assert.equal(
    sealed.receipt.safeToAdvanceToSemanticReview,
    false
  );
});

test("队列忽略早于基线的旧观察回执", () => {
  const base = baseline();
  const sealed = sealLiveUiCapture({
    capture: structuralCapture({
      baselineEvidenceHash: base.evidenceHash
    }),
    baseline: base,
    secret: SECRET
  });
  const queue = buildLiveShadowQueue({
    readiness: base.receipt,
    baselineEvidenceHash: base.evidenceHash,
    observation: {
      receipt: {
        ...sealed.receipt,
        observedAt: "2026-07-29T11:59:59.000Z",
        evidenceAsOf: "2026-07-29T11:59:59.000Z"
      },
      receiptHash: sealed.receiptHash
    }
  });

  assert.equal(queue.observationReceiptHash, null);
  assert.equal(queue.driverLabel, "等待 Chrome / Computer Use");
  assert.equal(queue.waitReason, "awaiting_computer_use_receipt");
});

test("真实结构队列选择 wait，不创建 Intent、MoveSpec 或草稿", () => {
  const base = baseline();
  const sealed = sealLiveUiCapture({
    capture: structuralCapture({
      baselineEvidenceHash: base.evidenceHash
    }),
    baseline: base,
    secret: SECRET
  });
  const queue = buildLiveShadowQueue({
    readiness: base.receipt,
    baselineEvidenceHash: base.evidenceHash,
    observation: {
      receipt: sealed.receipt,
      receiptHash: sealed.receiptHash
    }
  });
  assert.equal(queue.sourceKind, "real_platform_live");
  assert.equal(queue.currentDecision, "wait");
  assert.equal(queue.waitReason, "action_outcome_unknown");
  assert.equal(queue.semanticCandidateCount, 0);
  assert.equal(queue.queueItems.length, 2);
  assert.equal(
    queue.queueItems.every(
      (item) =>
        !item.intentCreated &&
        !item.moveSpecCreated &&
        !item.draftCreated
    ),
    true
  );
});
