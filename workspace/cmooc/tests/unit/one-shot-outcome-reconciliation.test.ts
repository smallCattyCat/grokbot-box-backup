import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalProtocolHash
} from "../../lib/facilitation-protocol";
import {
  PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
} from "../../lib/autonomy/execution-permit";
import {
  hashTransientDraftBody
} from "../../lib/live-runtime/draft-content";
import {
  reconcileOneShotOutcomeUnknown,
  type OneShotOutcomeReconciliationDependencies,
  type OneShotOutcomeReconciliationSnapshot
} from "../../lib/autonomy/one-shot-outcome-reconciliation";

const NOW = new Date("2026-08-10T14:00:00.000Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const COURSE_ALIAS = "course-a";
const THREAD_KEY = "thread-a";
const BASELINE_POLICY_VERSION = "baseline-policy-a";
const PERMIT_POLICY_VERSION = "policy-a";
const CONTENT_HASH = hashTransientDraftBody("deterministic body");

function makeSnapshot(overrides: {
  attempt?: Partial<OneShotOutcomeReconciliationSnapshot["attempt"]>;
  target?: Partial<OneShotOutcomeReconciliationSnapshot["target"]>;
  receiptState?: "outcome_unknown" | "confirmed_not_published";
  receiptRemoteEvidenceHash?: string;
  preExecutionTape?: OneShotOutcomeReconciliationSnapshot["preExecutionTape"];
} = {}): OneShotOutcomeReconciliationSnapshot {
  const observationReceipt = {
    schemaVersion: "cmooc.live-ui-observation-receipt.v1",
    baselineEvidenceHash: HASH_C,
    driverKind: "deterministic_browser",
    attestationLevel: "target_only",
    courseKey: HASH_D,
    threadKey: THREAD_KEY,
    authorKey: null,
    authorRole: "unknown",
    observedAt: NOW.toISOString(),
    evidenceAsOf: NOW.toISOString(),
    targetLocatorHash: HASH_D,
    surfaceLocatorHash: HASH_E,
    temporalEvidenceStatus: "live_prefix_observed",
    contentRevisionStatus: "live_target_fingerprint_observed",
    captureStatus: "semantic_ready",
    courseShellDetected: true,
    categoryTabCount: 1,
    visibleCardCount: 1,
    detailObservation: "detail_observed",
    targetVersionHash: HASH_A,
    eventSetHash: HASH_B,
    eventEvidence: [],
    eventCount: 0,
    commentCount: 0,
    externalCommentCount: 0,
    selfCommentCount: 0,
    uniqueExternalAuthorCount: 0,
    replyEdgeCount: 0,
    maxReplyDepth: 0,
    latestEventAt: NOW.toISOString(),
    commentCompleteness: "complete",
    identityBasis: "unavailable",
    versionBasis: "current_fingerprint",
    actions: [],
    networkGuardAttached: false,
    guardReceiptHash: null,
    guardObservedAt: null,
    guardExpiresAt: null,
    requestedMutationCount: 0,
    blockedMutationCount: 0,
    sentMutationCount: 0,
    realPublishEnabled: false,
    externalWriteAttempted: false,
    containsForumText: false
  } as const;
  const observationReceiptHash = canonicalProtocolHash(
    observationReceipt.schemaVersion,
    observationReceipt
  );
  const targetHash = canonicalProtocolHash(
    "cmooc.execution-logical-target.v1",
    {
      courseAlias: COURSE_ALIAS,
      threadKey: THREAD_KEY,
      observationReceiptHash,
      targetVersionHash: HASH_A,
      eventSetHash: HASH_B
    }
  );
  const permitKey = "permit-key-a";
  const idempotencyKey = "idempotency-key-a";
  const receiptState = overrides.receiptState ?? "outcome_unknown";
  const productionReceipt = {
    schemaVersion: PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
    permitKey,
    idempotencyKey,
    targetHash,
    targetVersionHash: HASH_A,
    contentHash: CONTENT_HASH,
    state: receiptState,
    observedAt: NOW.toISOString(),
    remoteEvidenceHash: overrides.receiptRemoteEvidenceHash ?? HASH_C,
    requestedMutationCount: 1,
    sentMutationCount: 1,
    publishAttempted: true,
    realPublishEnabled: true,
    bodyPersisted: false,
    containsForumText: false
  } as const;
  const receiptHash = canonicalProtocolHash(
    PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
    productionReceipt
  );
  const decisionJson = JSON.stringify({
    candidateKey: "candidate-a",
    intent: { schemaVersion: "intent.v1", facilitationFunction: "resource_connection" },
    intentHash: HASH_D,
    moveSpec: { schemaVersion: "move.v1", intentHash: HASH_D },
    moveSpecHash: HASH_E,
    draftContentHash: CONTENT_HASH,
    semanticReceipt: {
      resolution: "deterministic_fallback",
      contentHash: CONTENT_HASH,
      bodyPersisted: false,
      containsForumText: false
    },
    revalidationReceipt: {
      schemaVersion: "revalidation.v1",
      decision: "EXECUTE",
      containsForumText: false
    },
    revalidationReceiptHash: canonicalProtocolHash(
      "revalidation.v1",
      {
        schemaVersion: "revalidation.v1",
        decision: "EXECUTE",
        containsForumText: false
      }
    ),
    draftBodyPersisted: false,
    publishAttempted: false,
    containsForumText: false
  });
  return {
    attempt: {
      id: "attempt-a",
      decisionId: "decision-a",
      permitId: "permit-a",
      mode: "AUTO",
      status: "outcome_unknown",
      transport: "real_platform",
      idempotencyKey,
      receiptJson: JSON.stringify(productionReceipt),
      remoteOutcomeHash: receiptHash,
      requestedMutationCount: 1,
      sentMutationCount: 1,
      publishAttempted: true,
      finishedAt: NOW,
      ...overrides.attempt
    },
    permit: {
      id: "permit-a",
      decisionId: "decision-a",
      courseAlias: COURSE_ALIAS,
      permitKey,
      policyVersion: PERMIT_POLICY_VERSION,
      targetHash,
      targetVersionHash: HASH_A,
      contentHash: CONTENT_HASH,
      idempotencyKey,
      status: "used",
      usedAt: NOW,
      revokedAt: null,
      realPublishEnabled: true
    },
    decision: {
      id: "decision-a",
      invocationId: "invocation-a",
      courseAlias: COURSE_ALIAS,
      threadKey: THREAD_KEY,
      policyVersion: BASELINE_POLICY_VERSION,
      decision: "draft",
      decisionMode: "DRAFT_ELIGIBLE",
      observationReceiptHash,
      decisionJson,
      draftContentHash: CONTENT_HASH,
      bodyPersisted: false,
      publishAttempted: true
    },
    invocation: {
      id: "invocation-a",
      courseAlias: COURSE_ALIAS,
      mode: "SHADOW",
      status: "completed",
      phase: "completed",
      manifestHash: HASH_D
    },
    stage: {
      decisionId: "decision-a",
      courseAlias: COURSE_ALIAS,
      policyVersion: PERMIT_POLICY_VERSION,
      targetVersionHash: HASH_A,
      contentHash: CONTENT_HASH,
      status: "consumed",
      usedAt: NOW,
      editorWriteCount: 1,
      editorClearCount: 1,
      sentMutationCount: 0,
      publishAttempted: false,
      bodyPersisted: false,
      containsForumText: false
    },
    observation: {
      receiptHash: observationReceiptHash,
      receiptJson: JSON.stringify(observationReceipt),
      threadKey: THREAD_KEY,
      containsForumText: false
    },
    preExecutionTape:
      "preExecutionTape" in overrides
        ? overrides.preExecutionTape
        : {
            kind: "pre_execution_revalidated",
            payloadJson: JSON.stringify({
              schemaVersion: "cmooc.l3-pre-execution-revalidated.v1",
              receiptHash: observationReceiptHash,
              targetVersionHash: HASH_A,
              eventSetHash: HASH_B,
              observedAt: NOW.toISOString(),
              targetUnchanged: true,
              containsForumText: false
            })
          },
    target: {
      postUrl: "https://course.invalid/thread-a",
      threadKey: THREAD_KEY,
      targetVersionHash: HASH_A,
      eventSetHash: HASH_B,
      comments: [],
      ...overrides.target
    }
  };
}

function makeDependencies(input: {
  snapshots?: readonly OneShotOutcomeReconciliationSnapshot[];
  locate?: OneShotOutcomeReconciliationDependencies["locateTransientExecutionTarget"];
  transition?: OneShotOutcomeReconciliationDependencies["reconcileOutcomeUnknownExecutionAttempt"];
  failCommittedOnce?: { value: boolean };
  calls?: {
    locate: number;
    transition: number;
    committed: number;
    observed: number;
    relock: number;
    policyRelocked: number;
    evidence?: Record<string, unknown>;
  };
} = {}): OneShotOutcomeReconciliationDependencies {
  const calls: {
    locate: number;
    transition: number;
    committed: number;
    observed: number;
    relock: number;
    policyRelocked: number;
    evidence?: Record<string, unknown>;
  } = input.calls ?? {
    locate: 0,
    transition: 0,
    committed: 0,
    observed: 0,
    relock: 0,
    policyRelocked: 0,
    evidence: undefined
  };
  return {
    readPersisted: async () =>
      input.snapshots ?? [makeSnapshot()],
    loadCourseManifest: async () =>
      ({
        allowedOrigins: ["https://course.invalid"],
        alias: COURSE_ALIAS,
        manifestHash: HASH_D,
        policyVersion: "baseline-policy-a",
        realPublishEnabled: false
      }) as never,
    locateTransientExecutionTarget: async (targetInput) => {
      calls.locate += 1;
      if (input.locate) return input.locate(targetInput);
      const snapshot = input.snapshots?.[0] ?? makeSnapshot();
      return {
        target: snapshot.target,
        preExecutionObservation: undefined
      } as never;
    },
    rebuildDeterministicSemanticDraft: () => "deterministic body",
    hashTransientRemoteEvidence: ({ value }) => {
      calls.evidence = value as Record<string, unknown>;
      return HASH_E;
    },
    reconcileOutcomeUnknownExecutionAttempt: async (transitionInput) => {
      calls.transition += 1;
      if (input.transition) return input.transition(transitionInput);
      return { idempotent: false } as never;
    },
    appendExecutionReceiptCommittedTape: async (auditInput) => {
      calls.committed += 1;
      assert.equal(auditInput.recoveredByReconciliation, true);
      assert.equal("transientBody" in auditInput, false);
      assert.equal("targetUrl" in auditInput, false);
      if (input.failCommittedOnce && !input.failCommittedOnce.value) {
        input.failCommittedOnce.value = true;
        throw new Error("simulated audit failure");
      }
    },
    appendPostExecutionObservedTape: async (auditInput) => {
      calls.observed += 1;
      assert.equal(auditInput.recoveredByReconciliation, true);
      assert.equal("transientBody" in auditInput, false);
      assert.equal("targetUrl" in auditInput, false);
    },
    relockOneShotPolicy: async () => {
      calls.relock += 1;
      return {
        manifestLocked: true,
        forumSettingLocked: true,
        globalHardLock: true,
        blockingRealAttemptCount: 0,
        activeRealPolicyCount: 0,
        openRealPermitCount: 0
      } as never;
    },
    appendExecutionPolicyRelockedTape: async (auditInput) => {
      calls.policyRelocked += 1;
      assert.equal(auditInput.manifestLocked, true);
      assert.equal(auditInput.globalHardLock, true);
      assert.equal("targetUrl" in auditInput, false);
      assert.equal("transientBody" in auditInput, false);
    },
    wait: async () => undefined,
    clock: () => NOW
  };
}

function baseInput(
  dependencies: OneShotOutcomeReconciliationDependencies
) {
  return {
    prisma: {} as never,
    courseAlias: COURSE_ALIAS,
    now: NOW,
    secret: "s".repeat(32),
    dependencies
  } as const;
}

test("all-empty stable reads transition once, audit, and relock", async () => {
  const calls = {
    locate: 0,
    transition: 0,
    committed: 0,
    observed: 0,
    relock: 0,
    policyRelocked: 0,
    evidence: undefined
  };
  const result = await reconcileOneShotOutcomeUnknown(
    baseInput(makeDependencies({ calls }))
  );
  assert.equal(result.status, "confirmed_not_published");
  assert.equal(result.successfulReadCount, 3);
  assert.equal(result.attemptedReadCount, 3);
  assert.equal(result.emptyCommentReadCount, 3);
  assert.equal(result.transitionIdempotent, false);
  assert.equal(result.manifestLocked, true);
  assert.equal(result.globalHardLock, true);
  assert.equal(result.containsForumText, false);
  assert.equal(calls.locate, 3);
  assert.equal(calls.transition, 1);
  assert.equal(calls.committed, 1);
  assert.equal(calls.observed, 1);
  assert.equal(calls.relock, 1);
  assert.equal(calls.policyRelocked, 1);
  assert.match(result.remoteEvidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes("attempt-a"), false);
  assert.equal(JSON.stringify(result).includes("course.invalid"), false);
  assert.equal(JSON.stringify(result).includes("deterministic body"), false);
  assert.equal(JSON.stringify(calls.evidence).includes("course.invalid"), false);
  assert.equal(JSON.stringify(calls.evidence).includes("token"), false);
});

test("account-bound history resolves the persisted account and never falls back to input.token", async () => {
  const accountRefHash = HASH_A;
  const credentialRefHash = HASH_B;
  const leaseId = HASH_C;
  const writeToken = {
    token: "account-token-marker",
    source: "partner_account" as const,
    accountRefHash,
    credentialRefHash
  };
  const snapshot = makeSnapshot();
  snapshot.permit = {
    ...snapshot.permit!,
    executionAccountLeaseId: leaseId,
    executionAccountRefHash: accountRefHash,
    credentialRefHash
  };
  snapshot.attempt.executionAccountRefHash = accountRefHash;
  snapshot.target = {
    ...snapshot.target!,
    writeToken,
    executionAccountLeaseId: leaseId,
    executionAccountRefHash: accountRefHash,
    credentialRefHash
  };
  const calls = {
    locate: 0,
    transition: 0,
    committed: 0,
    observed: 0,
    relock: 0,
    policyRelocked: 0
  };
  const dependencies = makeDependencies({ snapshots: [snapshot], calls });
  dependencies.resolveCmoocApiWriteToken = async (input) => {
    assert.equal(input.executionAccountRefHash, accountRefHash);
    return writeToken;
  };
  dependencies.locateTransientExecutionTarget = async (input) => {
    calls.locate += 1;
    assert.equal(input.token, undefined);
    assert.deepEqual(input.writeToken, writeToken);
    assert.equal(input.executionAccountLeaseId, leaseId);
    assert.equal(input.executionAccountRefHash, accountRefHash);
    assert.equal(input.credentialRefHash, credentialRefHash);
    return {
      target: snapshot.target!,
      preExecutionObservation: undefined
    };
  };
  const result = await reconcileOneShotOutcomeUnknown({
    ...baseInput(dependencies),
    token: "legacy-token-must-not-be-used"
  });
  assert.equal(result.status, "confirmed_not_published");
  assert.equal(calls.locate, 3);
  assert.equal(calls.transition, 1);
});

test("read failures are bounded and remain inconclusive without transition", async () => {
  const calls = {
    locate: 0,
    transition: 0,
    committed: 0,
    observed: 0,
    relock: 0,
    policyRelocked: 0
  };
  const dependencies = makeDependencies({ calls });
  dependencies.locateTransientExecutionTarget = async () => {
    calls.locate += 1;
    throw new Error("https://unsafe.invalid/token=secret");
  };
  await assert.rejects(
    () => reconcileOneShotOutcomeUnknown(baseInput(dependencies)),
    /^Error: L3_OUTCOME_RECONCILIATION_INCONCLUSIVE$/
  );
  assert.equal(calls.locate, 5);
  assert.equal(calls.transition, 0);
  assert.equal(calls.committed, 0);
  assert.equal(calls.relock, 0);
});

test("nonempty, mixed, and mismatched reads never transition", async () => {
  for (const target of [
    { comments: [{ id: "body-match", content: "private body" }] },
    { comments: [], eventSetHash: HASH_C },
    { comments: [], targetVersionHash: HASH_C }
  ]) {
    const calls = {
      locate: 0,
      transition: 0,
      committed: 0,
      observed: 0,
      relock: 0,
      policyRelocked: 0
    };
    const snapshot = makeSnapshot({ target });
    await assert.rejects(
      () =>
        reconcileOneShotOutcomeUnknown(
          baseInput(makeDependencies({ snapshots: [snapshot], calls }))
        ),
      /^Error: L3_OUTCOME_RECONCILIATION_INCONCLUSIVE$/
    );
    assert.equal(calls.transition, 0);
    assert.equal(calls.committed, 0);
    assert.equal(calls.relock, 0);
  }
});

test("a later positive read makes an earlier empty read inconclusive", async () => {
  const calls = {
    locate: 0,
    transition: 0,
    committed: 0,
    observed: 0,
    relock: 0,
    policyRelocked: 0
  };
  const snapshot = makeSnapshot();
  let read = 0;
  const dependencies = makeDependencies({
    snapshots: [snapshot],
    calls
  });
  dependencies.locateTransientExecutionTarget = async () => {
    calls.locate += 1;
    read += 1;
    return {
      target:
        read === 1
          ? snapshot.target!
          : { ...snapshot.target!, comments: [{ id: "new" }] },
      preExecutionObservation: undefined
    };
  };
  await assert.rejects(
    () => reconcileOneShotOutcomeUnknown(baseInput(dependencies)),
    /^Error: L3_OUTCOME_RECONCILIATION_INCONCLUSIVE$/
  );
  assert.equal(calls.locate, 2);
  assert.equal(calls.transition, 0);
  assert.equal(calls.committed, 0);
  assert.equal(calls.relock, 0);
});

test("invalid persisted receipt is rejected before any remote read", async () => {
  const calls = {
    locate: 0,
    transition: 0,
    committed: 0,
    observed: 0,
    relock: 0,
    policyRelocked: 0
  };
  const snapshot = makeSnapshot({
    attempt: { remoteOutcomeHash: HASH_A }
  });
  await assert.rejects(
    () =>
      reconcileOneShotOutcomeUnknown(
        baseInput(makeDependencies({ snapshots: [snapshot], calls }))
      ),
    /^Error: L3_OUTCOME_RECONCILIATION_INCONCLUSIVE$/
  );
  assert.equal(calls.locate, 0);
  assert.equal(calls.transition, 0);
});

test("missing pre-execution revalidation tape is inconclusive", async () => {
  const calls = {
    locate: 0,
    transition: 0,
    committed: 0,
    observed: 0,
    relock: 0,
    policyRelocked: 0
  };
  const snapshot = makeSnapshot({ preExecutionTape: null });
  await assert.rejects(
    () =>
      reconcileOneShotOutcomeUnknown(
        baseInput(makeDependencies({ snapshots: [snapshot], calls }))
      ),
    /^Error: L3_OUTCOME_RECONCILIATION_INCONCLUSIVE$/
  );
  assert.equal(calls.locate, 0);
  assert.equal(calls.transition, 0);
});

test("a read clock before the attempt finish is inconclusive", async () => {
  const calls = {
    locate: 0,
    transition: 0,
    committed: 0,
    observed: 0,
    relock: 0,
    policyRelocked: 0
  };
  const dependencies = makeDependencies({ calls });
  dependencies.clock = () => new Date(NOW.getTime() - 1);
  await assert.rejects(
    () => reconcileOneShotOutcomeUnknown(baseInput(dependencies)),
    /^Error: L3_OUTCOME_RECONCILIATION_INCONCLUSIVE$/
  );
  assert.equal(calls.locate, 1);
  assert.equal(calls.transition, 0);
});

test("a final transition can be reported idempotently without exposing identifiers", async () => {
  const calls = {
    locate: 0,
    transition: 0,
    committed: 0,
    observed: 0,
    relock: 0,
    policyRelocked: 0
  };
  const dependencies = makeDependencies({ calls });
  dependencies.reconcileOutcomeUnknownExecutionAttempt = async () => {
    calls.transition += 1;
    return { idempotent: true } as never;
  };
  const result = await reconcileOneShotOutcomeUnknown(
    baseInput(dependencies)
  );
  assert.equal(result.transitionIdempotent, true);
  assert.equal(JSON.stringify(result).includes("decision-a"), false);
  assert.equal(JSON.stringify(result).includes("permit-key-a"), false);
});

test("an audit append failure is repaired from the final receipt without another read", async () => {
  const calls = {
    locate: 0,
    transition: 0,
    committed: 0,
    observed: 0,
    relock: 0,
    policyRelocked: 0,
    evidence: undefined
  };
  const unknownSnapshot = makeSnapshot();
  const finalSnapshot = makeSnapshot({
    receiptState: "confirmed_not_published",
    receiptRemoteEvidenceHash: HASH_E,
    attempt: { status: "confirmed_not_published" }
  });
  let phase: "unknown" | "final" = "unknown";
  const failCommittedOnce = { value: false };
  const dependencies = makeDependencies({
    snapshots: [unknownSnapshot],
    calls,
    failCommittedOnce,
    transition: async (transitionInput) => {
      if (phase === "unknown") {
        assert.equal(transitionInput.state, "confirmed_not_published");
        phase = "final";
        return { idempotent: false } as never;
      }
      assert.equal(transitionInput.state, "confirmed_not_published");
      return { idempotent: true } as never;
    }
  });
  dependencies.readPersisted = async () =>
    phase === "unknown" ? [unknownSnapshot] : [finalSnapshot];

  await assert.rejects(
    () => reconcileOneShotOutcomeUnknown(baseInput(dependencies)),
    /^Error: L3_OUTCOME_RECONCILIATION_INCONCLUSIVE$/
  );
  const firstEvidence = calls.evidence;
  assert.ok(firstEvidence);
  assert.equal("observedAt" in firstEvidence, false);
  assert.equal("attemptedReadCount" in firstEvidence, false);

  const result = await reconcileOneShotOutcomeUnknown(
    baseInput(dependencies)
  );
  assert.equal(result.transitionIdempotent, true);
  assert.equal(result.successfulReadCount, 0);
  assert.equal(result.attemptedReadCount, 0);
  assert.equal(calls.locate, 3);
  assert.equal(calls.transition, 2);
  assert.equal(calls.committed, 2);
  assert.equal(calls.observed, 1);
  assert.equal(calls.relock, 1);
  assert.equal(calls.policyRelocked, 1);
  assert.equal(result.remoteEvidenceHash, HASH_E);
});
