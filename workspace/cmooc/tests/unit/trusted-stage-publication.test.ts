import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_HASH_ALGORITHM,
  PROTOCOL_SCHEMA_VERSIONS,
  canonicalProtocolHash,
  parseProtocolObject
} from "../../lib/facilitation-protocol";
import {
  selectMechanicalDraft,
  TRUSTED_ONE_SHOT_DAILY_ACTION_LIMIT
} from "../../lib/autonomy/one-shot-execution";
import { rebuildDeterministicSemanticDraft } from "../../lib/autonomy/semantic-renderer";
import { hashTransientDraftBody } from "../../lib/live-runtime/draft-content";
import { buildDeterministicFacilitationDraft } from "../../lib/live-runtime/facilitation-kernel";
import {
  assertTrustedStagePublishGuards,
  projectTrustedStagePublicationResult,
  runTrustedStageAndPublishSequence
} from "../../lib/autonomy/trusted-stage-publication";
import {
  projectL3CliErrorCode
} from "../../lib/autonomy/l3-cli-error";
import { ProductionCommitError } from "../../lib/autonomy/production-committer";

const SELECTION_NOW = new Date("2026-08-03T04:00:00.000Z");
type TestStageReceipt = {
  status: "verified_cleared";
  policyVersion: string;
  usedAt: null;
};

function selectionHash(label: string): string {
  return canonicalProtocolHash("cmooc.trusted-stage-selection-test.v1", {
    label
  });
}

function makeMechanicalDecision(input: {
  id: string;
  threadKey: string;
  candidateKey: string;
  authorKey: string | null;
  invocationId: string;
  budget?: {
    availableSlots: number;
    workloadCost: number;
    authorTouchLimit30d: number;
  };
}) {
  const intent = parseProtocolObject("interventionIntent", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.interventionIntent,
    evidenceRefHash: selectionHash(`${input.id}-evidence`),
    evidenceAsOf: "2026-08-03T03:59:00.000Z",
    intervene: true,
    facilitationFunction: "cognitive_conflict",
    targetObject: "thread_author",
    workloadCost: 1,
    candidateExpiresAt: "2026-08-03T04:30:00.000Z",
    withdrawalConditions: [
      "external_human_response",
      "candidate_expired",
      "target_version_changed"
    ],
    policyVersion: "policy.v1",
    budgetVersion: "budget.v1",
    hashAlgorithm: CANONICAL_HASH_ALGORITHM,
    containsForumText: false
  });
  const intentHash = canonicalProtocolHash(
    intent.schemaVersion,
    intent
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
      "stable_personality_judgment"
    ],
    observableSuccessCriteria: [
      "external_human_response",
      "reply_chain_extension"
    ],
    specVersion: "cmooc.live-move-spec.v1",
    containsForumText: false
  });
  const moveSpecHash = canonicalProtocolHash(
    moveSpec.schemaVersion,
    moveSpec
  );
  const expectedContentHash = hashTransientDraftBody(
    buildDeterministicFacilitationDraft("cognitive_conflict")
  );
  const transientBody = rebuildDeterministicSemanticDraft({
    intent,
    moveSpec,
    intentHash,
    moveSpecHash,
    expectedContentHash
  });
  const draftContentHash = hashTransientDraftBody(transientBody);
  const revalidationReceipt = {
    schemaVersion: "cmooc.test-revalidation.v1",
    decision: "EXECUTE",
    containsForumText: false
  };
  const revalidationReceiptHash = canonicalProtocolHash(
    revalidationReceipt.schemaVersion,
    revalidationReceipt
  );
  const budget = input.budget ?? {
    availableSlots: 1,
    workloadCost: 1,
    authorTouchLimit30d: 1
  };
  return {
    id: input.id,
    invocationId: input.invocationId,
    courseAlias: "course-a",
    threadKey: input.threadKey,
    decisionKey: selectionHash(`${input.id}-decision`),
    authorKey: input.authorKey,
    decision: "draft",
    decisionMode: "DRAFT_ELIGIBLE",
    intentHash,
    moveSpecHash,
    draftContentHash,
    bodyPersisted: false,
    publishAttempted: false,
    semanticRealization: {
      bodyPersisted: false,
      contentHash: draftContentHash
    },
    executionPermits: [],
    executionAttempts: [],
    executionStageReceipt: null as TestStageReceipt | null,
    evidenceAsOf: SELECTION_NOW,
    decisionJson: JSON.stringify({
      candidateKey: input.candidateKey,
      intent,
      intentHash,
      moveSpec,
      moveSpecHash,
      draftContentHash,
      semanticReceipt: {
        resolution: "deterministic_fallback",
        contentHash: draftContentHash,
        bodyPersisted: false,
        containsForumText: false
      },
      revalidationReceipt,
      revalidationReceiptHash,
      draftBodyPersisted: false,
      publishAttempted: false,
      containsForumText: false,
      budget
    })
  };
}

function makeSelectionPrisma(input: {
  decisions: ReturnType<typeof makeMechanicalDecision>[];
  candidates: Array<{ threadKey: string; candidateKey: string }>;
  budgetReadCalls?: { count: number };
  stagedDecisionIds?: string[];
  usageByAuthor?: Record<
    string,
    {
      reservedToday?: number;
      consumedToday?: number;
      reservedInvocation?: number;
      consumedInvocation?: number;
      authorTouches?: number;
    }
  >;
}) {
  const candidates = {
    schemaVersion: "test.candidate.v1",
    containsForumText: false,
    candidates: input.candidates
  };
  const candidateSetHash = canonicalProtocolHash(
    candidates.schemaVersion,
    candidates as never
  );
  const usageByAuthor = input.usageByAuthor ?? {};
  const stagedDecisionIds = new Set(input.stagedDecisionIds ?? []);
  for (const decision of input.decisions) {
    if (stagedDecisionIds.has(decision.id)) {
      decision.executionStageReceipt = {
        status: "verified_cleared",
        policyVersion: "policy-a",
        usedAt: null
      } as TestStageReceipt;
    }
  }
  const prisma = {
    scheduledInvocation: {
      findFirst: async () => ({
        id: "invocation-a",
        invocationKey: "invocation-key-a"
      })
    },
    candidateSet: {
      findUnique: async () => ({
        candidatesJson: JSON.stringify(candidates),
        candidateSetHash
      })
    },
    autonomyDecision: {
      findMany: async (args: { select?: unknown } = {}) => {
        if (args.select) {
          return input.decisions.map((decision) => ({
            id: decision.id,
            invocationId: decision.invocationId,
            authorKey: decision.authorKey
          }));
        }
        return input.decisions;
      }
    },
    budgetReservation: {
      findMany: async (args: { where?: Record<string, unknown> } = {}) => {
        input.budgetReadCalls && (input.budgetReadCalls.count += 1);
        const where = args.where ?? {};
        if (where.status === "active" && !where.authorKey) {
          const rows = [];
          for (
            let index = 0;
            index < (usageByAuthor.__course__?.reservedToday ?? 0);
            index += 1
          ) {
            rows.push({
              decisionId: `active-course-${index}`,
              invocationId:
                index <
                (usageByAuthor.__course__?.reservedInvocation ?? 0)
                  ? "invocation-a"
                  : "other-invocation",
              authorKey: null,
              workloadCost: 1,
              createdAt: SELECTION_NOW
            });
          }
          return rows;
        }
        if (where.status === "consumed" && !where.authorKey) {
          const rows = [];
          for (
            let index = 0;
            index < (usageByAuthor.__course__?.consumedToday ?? 0);
            index += 1
          ) {
            rows.push({
              decisionId: `consumed-course-${index}`,
              invocationId:
                index <
                (usageByAuthor.__course__?.consumedInvocation ?? 0)
                  ? "invocation-a"
                  : "other-invocation",
              authorKey: null,
              workloadCost: 1,
              consumedAt: SELECTION_NOW
            });
          }
          return rows;
        }
        const authorKey = where.authorKey;
        if (typeof authorKey !== "string") return [];
        const usage = usageByAuthor[authorKey] ?? {};
        const rows = [];
        if (where.status === "active") {
          for (let index = 0; index < (usage.reservedToday ?? 0); index += 1) {
            rows.push({
              decisionId: `active-${authorKey}-${index}`,
              invocationId: "other-invocation",
              authorKey,
              workloadCost: 1,
              createdAt: SELECTION_NOW
            });
          }
        }
        if (where.OR) {
          for (let index = 0; index < (usage.authorTouches ?? 0); index += 1) {
            rows.push({ decisionId: `touch-${authorKey}-${index}` });
          }
        }
        return rows;
      }
    },
    executionAttempt: {
      findMany: async (args: { decisionId?: { in?: string[] } } = {}) => {
        const ids = args.decisionId?.in ?? [];
        const rows = [];
        for (const decision of input.decisions) {
          const usage = decision.authorKey
            ? usageByAuthor[decision.authorKey] ?? {}
            : {};
          if (
            ids.includes(decision.id) &&
            (usage.authorTouches ?? 0) > 0
          ) {
            rows.push({ decisionId: decision.id });
          }
        }
        return rows;
      }
    }
  };
  return prisma as never;
}

test("L3 CLI errors project only an allowlisted stable code", () => {
  const allowed = [
    "L3_STAGE_PUBLISH_FAILED",
    "CMOOC_QUILL_STAGE_EDITOR_READBACK_MISMATCH",
    "CMOOC_QUILL_STAGE_BROWSER_NAVIGATION_FAILED",
    "STAGE_COMPANION_PAGE_GUARD_MISMATCH",
    "EXECUTION_STAGE_RECEIPT_INVALID"
  ];
  for (const code of allowed) {
    assert.equal(projectL3CliErrorCode(new Error(code)), code);
    assert.equal(projectL3CliErrorCode({ code }), code);
  }

  for (const code of [
    "PRODUCTION_COMMIT_REPLAY_BLOCKED",
    "PRODUCTION_COMMIT_ABORTED_BEFORE_SEND",
    "PRODUCTION_COMMIT_OUTCOME_UNKNOWN"
  ] as const) {
    assert.equal(projectL3CliErrorCode(new ProductionCommitError(code)), code);
    assert.equal(projectL3CliErrorCode({ code }), code);
  }
});

test("L3 CLI error projection rejects unsafe, malformed, and non-Error inputs", () => {
  const fallback = "L3_COMMAND_FAILED";
  const unsafe = [
    new Error("https://unsafe.invalid/token=secret body text"),
    new Error("lowercase_l3_stage_failed"),
    new Error(" L3_STAGE_PUBLISH_FAILED"),
    new Error("L3_STAGE_PUBLISH_FAILED "),
    new Error(`L3_${"A".repeat(101)}`),
    new Error("CMOOC_QUILL_STAGE_BROWSER_NAVIGATION_FAILED\n"),
    { code: "L3_STAGE_PUBLISH_FAILED https://unsafe.invalid" },
    { code: "l3_stage_publish_failed" },
    { code: "L3_A" },
    { code: `L3_${"A".repeat(101)}` },
    { code: "PRODUCTION_COMMIT_NOT_REAL" },
    { code: "CMOOC_QUILL_STAGE_AB" },
    { code: "STAGE_COMPANION_X" },
    { code: "EXECUTION_STAGE_" },
    { code: "https://unsafe.invalid/token=secret" },
    null,
    undefined,
    "L3_STAGE_PUBLISH_FAILED",
    42,
    { message: "L3_STAGE_PUBLISH_FAILED" },
    { code: "L3_STAGE_PUBLISH_FAILED https://unsafe.invalid", body: "forum正文" }
  ];
  for (const error of unsafe) {
    assert.equal(projectL3CliErrorCode(error), fallback);
  }
});

test("staged mechanical selection requires a verified unused receipt bound to policy", async () => {
  const candidates = {
    schemaVersion: "test.candidate.v1",
    containsForumText: false,
    candidates: [{ threadKey: "thread-a", candidateKey: "candidate-a" }]
  };
  const candidateSetHash = canonicalProtocolHash(
    candidates.schemaVersion,
    candidates as never
  );
  const fakePrisma = {
    scheduledInvocation: {
      findFirst: async () => ({
        id: "invocation-a",
        invocationKey: "invocation-key-a"
      })
    },
    candidateSet: {
      findUnique: async () => ({
        candidatesJson: JSON.stringify(candidates),
        candidateSetHash
      })
    },
    autonomyDecision: {
      findMany: async () => [
        {
          threadKey: "thread-a",
          decision: "draft",
          decisionMode: "DRAFT_ELIGIBLE",
          authorKey: "author-a",
          intentHash: "intent-hash",
          moveSpecHash: "move-hash",
          draftContentHash: "content-hash",
          bodyPersisted: false,
          publishAttempted: false,
          semanticRealization: {
            bodyPersisted: false,
            contentHash: "content-hash"
          },
          executionPermits: [],
          executionAttempts: [],
    executionStageReceipt: null as TestStageReceipt | null,
          decisionJson: "{}"
        }
      ]
    }
  } as never;

  await assert.rejects(
    () =>
      selectMechanicalDraft({
        prisma: fakePrisma,
        courseAlias: "course-a",
        allowStagedForPolicyVersion: "policy-a"
      }),
    /L3_NO_MECHANICALLY_ELIGIBLE_DRAFT/
  );
});

test("clean mechanical selection skips an author whose 30-day touch budget is exhausted", async () => {
  const first = makeMechanicalDecision({
    id: "decision-first",
    threadKey: "thread-first",
    candidateKey: "candidate-first",
    authorKey: "author-first",
    invocationId: "invocation-a"
  });
  const second = makeMechanicalDecision({
    id: "decision-second",
    threadKey: "thread-second",
    candidateKey: "candidate-second",
    authorKey: "author-second",
    invocationId: "invocation-a"
  });
  const selection = await selectMechanicalDraft({
    prisma: makeSelectionPrisma({
      decisions: [first, second],
      candidates: [
        { threadKey: first.threadKey, candidateKey: "candidate-first" },
        { threadKey: second.threadKey, candidateKey: "candidate-second" }
      ],
      usageByAuthor: {
        "author-first": { authorTouches: 1 },
        "author-second": { authorTouches: 0 }
      }
    }),
    courseAlias: "course-a",
    now: SELECTION_NOW
  });
  assert.equal(selection.decision.id, "decision-second");
  assert.equal(selection.candidateOrdinal, 1);
});

test("clean mechanical selection skips exhausted budget evidence before usage reads", async () => {
  const exhausted = makeMechanicalDecision({
    id: "decision-evidence-exhausted",
    threadKey: "thread-evidence-exhausted",
    candidateKey: "candidate-evidence-exhausted",
    authorKey: "author-evidence-exhausted",
    invocationId: "invocation-a",
    budget: {
      availableSlots: 0,
      workloadCost: 1,
      authorTouchLimit30d: 2
    }
  });
  const usable = makeMechanicalDecision({
    id: "decision-evidence-usable",
    threadKey: "thread-evidence-usable",
    candidateKey: "candidate-evidence-usable",
    authorKey: "author-evidence-usable",
    invocationId: "invocation-a"
  });
  const budgetReadCalls = { count: 0 };
  const selection = await selectMechanicalDraft({
    prisma: makeSelectionPrisma({
      decisions: [exhausted, usable],
      candidates: [
        {
          threadKey: exhausted.threadKey,
          candidateKey: "candidate-evidence-exhausted"
        },
        {
          threadKey: usable.threadKey,
          candidateKey: "candidate-evidence-usable"
        }
      ],
      budgetReadCalls
    }),
    courseAlias: "course-a",
    now: SELECTION_NOW
  });
  assert.equal(selection.decision.id, usable.id);
  // The exhausted evidence is rejected before readBudgetUsage; only the
  // usable candidate needs the three read-only usage queries.
  assert.equal(budgetReadCalls.count, 3);
});

test("clean mechanical selection allows five daily actions but still limits each tick to one", async () => {
  assert.equal(TRUSTED_ONE_SHOT_DAILY_ACTION_LIMIT, 5);
  const first = makeMechanicalDecision({
    id: "decision-budget",
    threadKey: "thread-budget",
    candidateKey: "candidate-budget",
    authorKey: "author-budget",
    invocationId: "invocation-a"
  });

  for (const usage of [
    { consumedToday: 1 },
    { consumedToday: 4 },
    { reservedToday: 2, consumedToday: 2 }
  ]) {
    const selection = await selectMechanicalDraft({
      prisma: makeSelectionPrisma({
        decisions: [first],
        candidates: [
          {
            threadKey: first.threadKey,
            candidateKey: "candidate-budget"
          }
        ],
        usageByAuthor: {
          __course__: usage
        }
      }),
      courseAlias: "course-a",
      now: SELECTION_NOW
    });
    assert.equal(selection.decision.id, first.id);
  }

  for (const usage of [
    { consumedToday: 5 },
    { reservedToday: 5 },
    { reservedInvocation: 1, reservedToday: 1 },
    { consumedInvocation: 1, consumedToday: 1 }
  ]) {
    await assert.rejects(
      () =>
        selectMechanicalDraft({
          prisma: makeSelectionPrisma({
            decisions: [first],
            candidates: [
              {
                threadKey: first.threadKey,
                candidateKey: "candidate-budget"
              }
            ],
            usageByAuthor: {
              __course__: usage
            }
          }),
          courseAlias: "course-a",
          now: SELECTION_NOW
        }),
      /L3_NO_MECHANICALLY_ELIGIBLE_DRAFT/
    );
  }
});

test("clean mechanical selection skips a null author touch count", async () => {
  const unresolved = makeMechanicalDecision({
    id: "decision-null-author",
    threadKey: "thread-null-author",
    candidateKey: "candidate-null-author",
    authorKey: null,
    invocationId: "invocation-a"
  });
  const usable = makeMechanicalDecision({
    id: "decision-usable-author",
    threadKey: "thread-usable-author",
    candidateKey: "candidate-usable-author",
    authorKey: "author-usable",
    invocationId: "invocation-a"
  });
  const selection = await selectMechanicalDraft({
    prisma: makeSelectionPrisma({
      decisions: [unresolved, usable],
      candidates: [
        {
          threadKey: unresolved.threadKey,
          candidateKey: "candidate-null-author"
        },
        {
          threadKey: usable.threadKey,
          candidateKey: "candidate-usable-author"
        }
      ]
    }),
    courseAlias: "course-a",
    now: SELECTION_NOW
  });
  assert.equal(selection.decision.id, usable.id);
});

test("staged mechanical selection keeps the exact staged candidate without budget reads", async () => {
  const staged = makeMechanicalDecision({
    id: "decision-staged",
    threadKey: "thread-staged",
    candidateKey: "candidate-staged",
    authorKey: "author-staged",
    invocationId: "invocation-a"
  });
  const clean = makeMechanicalDecision({
    id: "decision-clean",
    threadKey: "thread-clean",
    candidateKey: "candidate-clean",
    authorKey: "author-clean",
    invocationId: "invocation-a"
  });
  const budgetReadCalls = { count: 0 };
  const selection = await selectMechanicalDraft({
    prisma: makeSelectionPrisma({
      decisions: [staged, clean],
      candidates: [
        { threadKey: staged.threadKey, candidateKey: "candidate-staged" },
        { threadKey: clean.threadKey, candidateKey: "candidate-clean" }
      ],
      stagedDecisionIds: [staged.id],
      budgetReadCalls,
      usageByAuthor: {
        "author-staged": { authorTouches: 1 },
        "author-clean": { authorTouches: 0 }
      }
    }),
    courseAlias: "course-a",
    allowStagedForPolicyVersion: "policy-a",
    now: SELECTION_NOW
  });
  assert.equal(selection.decision.id, staged.id);
  assert.equal(selection.candidateOrdinal, 0);
  assert.equal(budgetReadCalls.count, 0);
});

test("a losing stage does not relock the winner and outcome_unknown is never reported as success", async () => {
  let relockCalls = 0;
  await assert.rejects(
    () =>
      runTrustedStageAndPublishSequence({
        stage: async () => {
          throw new Error("L3_DIFFERENT_REAL_POLICY_ALREADY_ACTIVE");
        },
        publish: async () => {
          throw new Error("must-not-publish");
        },
        relock: async () => {
          relockCalls += 1;
        }
      }),
    /L3_DIFFERENT_REAL_POLICY_ALREADY_ACTIVE/
  );
  assert.equal(relockCalls, 0);

  let stageCalls = 0;
  let publishCalls = 0;
  await assert.rejects(
    () =>
      runTrustedStageAndPublishSequence({
        stage: async () => {
          stageCalls += 1;
          return {
            policyRetainedForImmediatePublication: true,
            status: "verified_cleared",
            receiptHash: "receipt-a",
            editorWriteCount: 1,
            editorClearCount: 1,
            sentMutationCount: 0,
            publishAttempted: false,
            handoff: {
              decisionId: "decision-a",
              selectionHash: "selection-a",
              policyVersion: "policy-a"
            }
          };
        },
        publish: async (handoff) => {
          publishCalls += 1;
          assert.equal(handoff.policyVersion, "policy-a");
          return {
            status: "outcome_unknown",
            requestedMutationCount: 1,
            sentMutationCount: 1
          };
        },
        relock: async (handoff) => {
          relockCalls += 1;
          assert.equal(handoff.decisionId, "decision-a");
        }
      }),
    /L3_STAGE_PUBLISH_OUTCOME_UNKNOWN/
  );
  assert.equal(stageCalls, 1);
  assert.equal(publishCalls, 1);
  assert.equal(relockCalls, 1);
});

test("combined sequence succeeds only for one confirmed mutation", async () => {
  let publishCalls = 0;
  let relockCalls = 0;
  const result = await runTrustedStageAndPublishSequence({
    stage: async () => ({
      policyRetainedForImmediatePublication: true,
      status: "verified_cleared",
      receiptHash: "receipt-a",
      editorWriteCount: 1,
      editorClearCount: 1,
      sentMutationCount: 0,
      publishAttempted: false,
      handoff: {
        decisionId: "decision-a",
        selectionHash: "selection-a",
        policyVersion: "policy-a"
      }
    }),
    publish: async () => {
      publishCalls += 1;
      return {
        status: "confirmed_published",
        requestedMutationCount: 1,
        sentMutationCount: 1
      };
    },
    relock: async () => {
      relockCalls += 1;
      return { manifestLocked: true, globalHardLock: true };
    }
  });
  assert.equal(result.publication.status, "confirmed_published");
  assert.equal(publishCalls, 1);
  assert.equal(relockCalls, 1);
});

test("relock failure is stable and strict projection contains no transient or identity fields", async () => {
  await assert.rejects(
    () =>
      runTrustedStageAndPublishSequence({
        stage: async () => ({
          policyRetainedForImmediatePublication: true,
          status: "verified_cleared",
          receiptHash: "receipt-a",
          editorWriteCount: 1,
          editorClearCount: 1,
          sentMutationCount: 0,
          publishAttempted: false,
          handoff: {
            decisionId: "decision-a",
            selectionHash: "selection-a",
            policyVersion: "policy-a"
          }
        }),
        publish: async () => {
          throw new Error("root-publication-error");
        },
        relock: async () => {
          throw new Error("relock-failed");
        }
      }),
    /L3_STAGE_PUBLISH_RELOCK_FAILED/
  );

  const projection = projectTrustedStagePublicationResult({
    handoff: {
      decisionId: "decision-a",
      selectionHash: "a".repeat(64),
      policyVersion: "policy-a"
    },
    stage: {
      status: "verified_cleared",
      receiptHash: "b".repeat(64),
      editorWriteCount: 1,
      editorClearCount: 1,
      sentMutationCount: 0,
      publishAttempted: false
    },
    publication: {
      status: "confirmed_published",
      remoteOutcomeHash: "c".repeat(64),
      requestedMutationCount: 1,
      sentMutationCount: 1
    }
  });
  const serialized = JSON.stringify(projection);
  for (const forbidden of [
    "transientBody",
    "token",
    "targetUrl",
    "decisionId",
    "permitKey",
    "attemptId",
    "courseAlias",
    "platformId"
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(projection.containsForumText, false);
  assert.throws(
    () =>
      projectTrustedStagePublicationResult({
        handoff: {
          decisionId: "decision-a",
          selectionHash: "https://unsafe.invalid/selection",
          policyVersion: "policy-a"
        },
        stage: {
          status: "verified_cleared",
          receiptHash: "b".repeat(64),
          editorWriteCount: 1,
          editorClearCount: 1,
          sentMutationCount: 0,
          publishAttempted: false
        },
        publication: {
          status: "confirmed_published",
          remoteOutcomeHash: "c".repeat(64),
          requestedMutationCount: 1,
          sentMutationCount: 1
        }
      }),
    /L3_STAGE_PUBLISH_OUTPUT_INVALID/
  );
});

test("malformed stage facts cannot be projected as verified and still relock the owned policy", async () => {
  let publishCalls = 0;
  let relockCalls = 0;
  await assert.rejects(
    () =>
      runTrustedStageAndPublishSequence({
        stage: async () => ({
          policyRetainedForImmediatePublication: true,
          status: "verified_cleared",
          receiptHash: "receipt-a",
          editorWriteCount: 1,
          editorClearCount: 0,
          sentMutationCount: 0,
          publishAttempted: false,
          handoff: {
            decisionId: "decision-a",
            selectionHash: "selection-a",
            policyVersion: "policy-a"
          }
        }),
        publish: async () => {
          publishCalls += 1;
          return {
            status: "confirmed_published",
            requestedMutationCount: 1,
            sentMutationCount: 1
          };
        },
        relock: async () => {
          relockCalls += 1;
          return { manifestLocked: true, globalHardLock: true };
        }
      }),
    /L3_TRUSTED_STAGE_FACTS_INVALID/
  );
  assert.equal(publishCalls, 0);
  assert.equal(relockCalls, 1);
});

test("outcome_unknown remains the operator-visible stop code when cleanup also reports it is blocking", async () => {
  const outcomeUnknown = Object.assign(
    new Error("PRODUCTION_COMMIT_OUTCOME_UNKNOWN"),
    { code: "PRODUCTION_COMMIT_OUTCOME_UNKNOWN" }
  );
  await assert.rejects(
    () =>
      runTrustedStageAndPublishSequence({
        stage: async () => ({
          policyRetainedForImmediatePublication: true,
          status: "verified_cleared",
          receiptHash: "receipt-a",
          editorWriteCount: 1,
          editorClearCount: 1,
          sentMutationCount: 0,
          publishAttempted: false,
          handoff: {
            decisionId: "decision-a",
            selectionHash: "selection-a",
            policyVersion: "policy-a"
          }
        }),
        publish: async () => {
          throw outcomeUnknown;
        },
        relock: async () => {
          throw new Error("L3_RELOCK_POSTCONDITION_FAILED");
        }
      }),
    (error: unknown) =>
      error === outcomeUnknown &&
      (error as { code?: unknown }).code ===
        "PRODUCTION_COMMIT_OUTCOME_UNKNOWN"
  );
});

test("outer cleanup requires explicit locked postconditions", async () => {
  await assert.rejects(
    () =>
      runTrustedStageAndPublishSequence({
        stage: async () => ({
          policyRetainedForImmediatePublication: true,
          status: "verified_cleared",
          receiptHash: "receipt-a",
          editorWriteCount: 1,
          editorClearCount: 1,
          sentMutationCount: 0,
          publishAttempted: false,
          handoff: {
            decisionId: "decision-a",
            selectionHash: "selection-a",
            policyVersion: "policy-a"
          }
        }),
        publish: async () => ({
          status: "confirmed_published",
          requestedMutationCount: 1,
          sentMutationCount: 1
        }),
        relock: async () => ({})
      }),
    /L3_STAGE_PUBLISH_RELOCK_FAILED/
  );
});

test("combined command requires both exact guards", () => {
  assert.throws(
    () =>
      assertTrustedStagePublishGuards({
        NODE_ENV: "test",
        CMOOC_L3_TRUSTED_STAGE_BRIDGE: "1"
      }),
    /L3_TRUSTED_STAGE_PUBLISH_GUARD_REQUIRED/
  );
  assert.throws(
    () =>
      assertTrustedStagePublishGuards({
        NODE_ENV: "test",
        CMOOC_L3_TRUSTED_STAGE_BRIDGE: "1",
        CMOOC_L3_TRUSTED_STAGE_PUBLISH: "true"
      }),
    /L3_TRUSTED_STAGE_PUBLISH_GUARD_REQUIRED/
  );
  assert.doesNotThrow(() =>
    assertTrustedStagePublishGuards({
      NODE_ENV: "test",
      CMOOC_L3_TRUSTED_STAGE_BRIDGE: "1",
      CMOOC_L3_TRUSTED_STAGE_PUBLISH: "1"
    })
  );
});
