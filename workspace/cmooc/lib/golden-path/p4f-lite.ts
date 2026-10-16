import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import rubricJson from "@/fixtures/p4f-lite/fidelity-rubric-v1.json";
import {
  PROTOCOL_SCHEMA_VERSIONS,
  canonicalProtocolHash,
  parseProtocolObject,
  type CanonicalJsonValue,
  type ExecutionCommandV1
} from "@/lib/facilitation-protocol";
import {
  MockForumAdapter,
  SyntheticTimelineForumAdapter,
  type ForumAdapter,
  type MockForumThread,
  type PreflightStatus,
  type SyntheticTimeline,
  type TargetRef
} from "@/lib/forum-adapters";
import {
  buildP4D1ReviewCase,
  createP4D1LocalReviewReceipt,
  type P4D1ReviewCase,
  type P4D1ReviewDecision
} from "@/lib/golden-path/p4d1";

export const P4F_LITE_RUBRIC_SCHEMA_VERSION =
  "cmooc.p4f-lite-fidelity-rubric.v1" as const;
export const P4F_LITE_EVIDENCE_SCHEMA_VERSION =
  "cmooc.p4f-lite-fidelity-evidence.v1" as const;

export type P4FLiteScenarioId =
  | "stable_target"
  | "target_version_changed"
  | "post_as_of_human_response";
export type P4FLiteAdapterKind = "mock_forum" | "synthetic_timeline";
type WithdrawalCondition =
  | "target_version_changed"
  | "external_human_response"
  | null;

type RubricCheck = {
  checkId: string;
  literal: string;
};

type RubricScenario = {
  scenarioId: P4FLiteScenarioId;
  expectedPreflightStatus: PreflightStatus;
  expectedReviewDecision: P4D1ReviewDecision;
  expectedWithdrawalCondition: WithdrawalCondition;
};

type P4FLiteRubric = {
  schemaVersion: typeof P4F_LITE_RUBRIC_SCHEMA_VERSION;
  rubricId: string;
  fixedDecisionAt: string;
  fixedReviewAt: string;
  expectedFacilitationFunction: "resource_connection";
  expectedFacilitationMove:
    "connect_resource_and_invite_application";
  expectedTargetObject: "thread_author";
  requiredDraftChecks: RubricCheck[];
  prohibitedDraftChecks: RubricCheck[];
  scenarios: RubricScenario[];
};

export type P4FLiteScenarioResult = {
  adapterKind: P4FLiteAdapterKind;
  adapterId: string;
  scenarioId: P4FLiteScenarioId;
  observationBeforeHash: string;
  observationAfterHash: string;
  eventCountBefore: number;
  eventCountAfter: number;
  boundTargetHash: string;
  preflightStatus: PreflightStatus;
  reviewDecision: P4D1ReviewDecision;
  withdrawalCondition: WithdrawalCondition;
  receiptHash: string;
  scenarioTraceHash: string;
  functionFaithful: boolean;
  moveFaithful: boolean;
  targetFaithful: boolean;
  draftRuleFaithful: boolean;
  decisionFaithful: boolean;
  scenarioCompleted: boolean;
  externalWriteCalls: 0;
  containsForumText: false;
};

export type P4FLiteEvidence = {
  schemaVersion: typeof P4F_LITE_EVIDENCE_SCHEMA_VERSION;
  researchQuestion: "RQ3";
  evidenceName: string;
  claimBoundary: string;
  rubricId: string;
  rubricHash: string;
  fixedDecisionAt: string;
  fixedReviewAt: string;
  p4d1IntentHash: string;
  p4d1MoveSpecHash: string;
  scenarioCount: number;
  completedCount: number;
  completionRate: number;
  functionFidelityRate: number;
  moveFidelityRate: number;
  targetFidelityRate: number;
  draftRuleFidelityRate: number;
  decisionFidelityRate: number;
  humanTakeoverCount: number;
  externalWriteCalls: 0;
  realForumWriteCalls: 0;
  leakedForumTextCount: 0;
  results: P4FLiteScenarioResult[];
  reproducibility: {
    command: "npm run p4:fidelity:audit";
    rubricFixture: string;
    randomProcessUsed: false;
  };
  containsForumText: false;
};

type ScenarioAdapter = {
  adapter: ForumAdapter;
  adapterKind: P4FLiteAdapterKind;
  targetRef: (thread: TargetRef["thread"]) => TargetRef;
  advanceToReview: () => void;
  mutateTarget: () => void;
  addHumanResponse: () => void;
};

function parseRubric(input: unknown): P4FLiteRubric {
  if (!input || typeof input !== "object") {
    throw new Error("P4F-lite rubric 必须是对象。");
  }
  const rubric = input as Partial<P4FLiteRubric>;
  if (
    rubric.schemaVersion !== P4F_LITE_RUBRIC_SCHEMA_VERSION ||
    rubric.expectedFacilitationFunction !== "resource_connection" ||
    rubric.expectedFacilitationMove !==
      "connect_resource_and_invite_application" ||
    rubric.expectedTargetObject !== "thread_author" ||
    !Array.isArray(rubric.requiredDraftChecks) ||
    !Array.isArray(rubric.prohibitedDraftChecks) ||
    !Array.isArray(rubric.scenarios) ||
    rubric.scenarios.length !== 3
  ) {
    throw new Error("P4F-lite rubric 的协议预期或三情境定义非法。");
  }
  const scenarioIds = new Set(
    rubric.scenarios.map((scenario) => scenario.scenarioId)
  );
  if (
    ![
      "stable_target",
      "target_version_changed",
      "post_as_of_human_response"
    ].every((scenarioId) =>
      scenarioIds.has(scenarioId as P4FLiteScenarioId)
    )
  ) {
    throw new Error("P4F-lite rubric 必须覆盖三个预声明情境。");
  }
  for (const check of [
    ...rubric.requiredDraftChecks,
    ...rubric.prohibitedDraftChecks
  ]) {
    if (
      typeof check.checkId !== "string" ||
      !check.checkId.trim() ||
      typeof check.literal !== "string" ||
      !check.literal.trim()
    ) {
      throw new Error("P4F-lite rubric 的草稿检查项不能为空。");
    }
  }
  return rubric as P4FLiteRubric;
}

function mockThread(input: {
  updatedAt?: string;
  content?: string;
  includeResponse?: boolean;
} = {}): MockForumThread {
  return {
    stableThreadRef: "p4f-mock-thread-001",
    courseKey: "course:p4f-mock",
    platformCourseRef: "space:p4f-mock",
    locator: "mock://forum/p4f-mock-thread-001",
    authorRef: "actor:p4f-root",
    title: "SYNTHETIC_P4F_TOPIC",
    content:
      input.content ??
      "SYNTHETIC_P4F_ROOT_CONNECTION_GAP",
    createdAt: "2024-10-19T18:00:00.000Z",
    updatedAt:
      input.updatedAt ?? "2024-10-19T18:00:00.000Z",
    comments: input.includeResponse
      ? [
          {
            stableCommentRef: "p4f-mock-response-001",
            parentRef: null,
            authorRef: "actor:p4f-peer",
            content: "SYNTHETIC_P4F_HUMAN_RESPONSE",
            createdAt: "2024-10-19T19:55:00.000Z"
          }
        ]
      : []
  };
}

function syntheticTimeline(input: {
  rootRevision?: number;
  rootUpdatedAt?: string;
  rootBody?: string;
  includeResponse?: boolean;
} = {}): SyntheticTimeline {
  const rootRef = "p4f-timeline-root-001";
  return {
    stableTimelineRef: "p4f-timeline-001",
    courseKey: "course:p4f-timeline",
    platformCourseRef: "space:p4f-timeline",
    topicLabel: "SYNTHETIC_P4F_TIMELINE_TOPIC",
    rootMessageRef: rootRef,
    messages: [
      {
        stableMessageRef: rootRef,
        parentMessageRef: null,
        actorRef: "actor:p4f-root",
        body:
          input.rootBody ??
          "SYNTHETIC_P4F_TIMELINE_CONNECTION_GAP",
        createdAt: "2024-10-19T18:00:00.000Z",
        updatedAt:
          input.rootUpdatedAt ?? "2024-10-19T18:00:00.000Z",
        revision: input.rootRevision ?? 1
      },
      ...(input.includeResponse
        ? [
            {
              stableMessageRef: "p4f-timeline-response-001",
              parentMessageRef: rootRef,
              actorRef: "actor:p4f-peer",
              body: "SYNTHETIC_P4F_TIMELINE_HUMAN_RESPONSE",
              createdAt: "2024-10-19T19:55:00.000Z",
              updatedAt: "2024-10-19T19:55:00.000Z",
              revision: 1
            }
          ]
        : [])
    ]
  };
}

function scenarioAdapter(
  adapterKind: P4FLiteAdapterKind,
  rubric: P4FLiteRubric
): ScenarioAdapter {
  let now = rubric.fixedDecisionAt;
  if (adapterKind === "mock_forum") {
    const adapter = new MockForumAdapter({
      clock: () => new Date(now),
      threads: [mockThread()]
    });
    return {
      adapter,
      adapterKind,
      targetRef: (thread) => ({
        thread,
        targetType: "thread",
        targetObject: "thread_author",
        stableTargetRef: thread.stableThreadRef
      }),
      advanceToReview: () => {
        now = rubric.fixedReviewAt;
      },
      mutateTarget: () => {
        adapter.upsertThread(
          mockThread({
            updatedAt: "2024-10-19T19:55:00.000Z",
            content: "SYNTHETIC_P4F_ROOT_EDITED"
          })
        );
      },
      addHumanResponse: () => {
        adapter.upsertThread(mockThread({ includeResponse: true }));
      }
    };
  }

  const adapter = new SyntheticTimelineForumAdapter({
    clock: () => new Date(now),
    timelines: [syntheticTimeline()]
  });
  return {
    adapter,
    adapterKind,
    targetRef: (thread) => ({
      thread,
      targetType: "thread",
      targetObject: "thread_author",
      stableTargetRef: thread.stableThreadRef
    }),
    advanceToReview: () => {
      now = rubric.fixedReviewAt;
    },
    mutateTarget: () => {
      adapter.upsertTimeline(
        syntheticTimeline({
          rootRevision: 2,
          rootUpdatedAt: "2024-10-19T19:55:00.000Z",
          rootBody: "SYNTHETIC_P4F_TIMELINE_ROOT_EDITED"
        })
      );
    },
    addHumanResponse: () => {
      adapter.upsertTimeline(
        syntheticTimeline({ includeResponse: true })
      );
    }
  };
}

function command(input: {
  reviewCase: P4D1ReviewCase;
  expectedTargetHash: string;
  adapterKind: P4FLiteAdapterKind;
  scenarioId: P4FLiteScenarioId;
  rubric: P4FLiteRubric;
}): ExecutionCommandV1 {
  return parseProtocolObject("executionCommand", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.executionCommand,
    commandId: `command:${input.adapterKind}:${input.scenarioId}`,
    correlationId: `correlation:${input.adapterKind}:${input.scenarioId}`,
    capability: "forum.execute_authorized",
    taskRefHash: canonicalProtocolHash(
      "cmooc.p4f-lite-task-ref.v1",
      {
        adapterKind: input.adapterKind,
        scenarioId: input.scenarioId
      }
    ),
    reviewBundleHash: input.reviewCase.reviewBundleHash,
    authorizationRefHash: canonicalProtocolHash(
      "cmooc.p4f-lite-synthetic-authorization.v1",
      {
        adapterKind: input.adapterKind,
        scenarioId: input.scenarioId,
        syntheticOnly: true
      }
    ),
    idempotencyKey: canonicalProtocolHash(
      "cmooc.p4f-lite-idempotency.v1",
      {
        adapterKind: input.adapterKind,
        scenarioId: input.scenarioId
      }
    ),
    budgetReservationRefHash: canonicalProtocolHash(
      "cmooc.p4f-lite-budget-reservation.v1",
      { fixtureId: input.reviewCase.fixtureId }
    ),
    expectedTargetHash: input.expectedTargetHash,
    contentHash: input.reviewCase.reviewBundle.draftContentHash,
    gatewayPolicyVersion: "p4f-lite.preflight-only.v1",
    issuedAt: "2024-10-19T19:50:00.000Z",
    expiresAt: "2024-10-19T20:30:00.000Z",
    containsForumText: false
  });
}

function platformReviewCase(
  reviewCase: P4D1ReviewCase,
  targetHash: string,
  assembledAt: string
): P4D1ReviewCase {
  const reviewBundle = parseProtocolObject("reviewBundle", {
    ...reviewCase.reviewBundle,
    targetHash,
    assembledAt
  });
  return {
    ...reviewCase,
    targetHash,
    reviewBundle,
    reviewBundleHash: canonicalProtocolHash(
      reviewBundle.schemaVersion,
      reviewBundle
    )
  };
}

function draftRuleFaithful(
  reviewCase: P4D1ReviewCase,
  rubric: P4FLiteRubric
): boolean {
  return (
    rubric.requiredDraftChecks.every((check) =>
      reviewCase.deterministicDraft.includes(check.literal)
    ) &&
    rubric.prohibitedDraftChecks.every(
      (check) => !reviewCase.deterministicDraft.includes(check.literal)
    )
  );
}

async function runScenario(input: {
  adapterKind: P4FLiteAdapterKind;
  scenario: RubricScenario;
  rubric: P4FLiteRubric;
  baseReviewCase: P4D1ReviewCase;
}): Promise<P4FLiteScenarioResult> {
  const runtime = scenarioAdapter(input.adapterKind, input.rubric);
  const scope =
    input.adapterKind === "mock_forum"
      ? {
          courseKey: "course:p4f-mock",
          platformCourseRef: "space:p4f-mock"
        }
      : {
          courseKey: "course:p4f-timeline",
          platformCourseRef: "space:p4f-timeline"
        };
  const page = await runtime.adapter.listThreads(scope);
  if (page.items.length !== 1) {
    throw new Error("P4F-lite 合成 adapter 未返回唯一主题。");
  }
  const thread = page.items[0].threadRef;
  const before = await runtime.adapter.observeThread(thread);
  const bound = await runtime.adapter.bindTarget(
    runtime.targetRef(thread)
  );
  const boundTargetHash = canonicalProtocolHash(
    bound.schemaVersion,
    bound
  );
  const reviewCase = platformReviewCase(
    input.baseReviewCase,
    boundTargetHash,
    input.rubric.fixedDecisionAt
  );
  const executionCommand = command({
    reviewCase,
    expectedTargetHash: boundTargetHash,
    adapterKind: input.adapterKind,
    scenarioId: input.scenario.scenarioId,
    rubric: input.rubric
  });

  if (input.scenario.scenarioId === "target_version_changed") {
    runtime.mutateTarget();
  } else if (
    input.scenario.scenarioId === "post_as_of_human_response"
  ) {
    runtime.addHumanResponse();
  }
  runtime.advanceToReview();
  const preflight = await runtime.adapter.preflight(executionCommand);
  const after = await runtime.adapter.observeThread(thread);

  let withdrawalCondition: WithdrawalCondition = null;
  let reviewDecision: P4D1ReviewDecision = "accept";
  if (preflight.status === "target_changed") {
    withdrawalCondition = "target_version_changed";
    reviewDecision = "reject";
  } else if (
    after.eventCount > before.eventCount &&
    reviewCase.intent.withdrawalConditions.includes(
      "external_human_response"
    )
  ) {
    withdrawalCondition = "external_human_response";
    reviewDecision = "reject";
  }
  const receiptResult = createP4D1LocalReviewReceipt({
    reviewCase,
    decision: reviewDecision,
    draftText: reviewCase.deterministicDraft,
    reviewedAt: input.rubric.fixedReviewAt
  });

  const functionFaithful =
    reviewCase.intent.facilitationFunction ===
    input.rubric.expectedFacilitationFunction;
  const moveFaithful =
    reviewCase.moveSpec.facilitationMove ===
    input.rubric.expectedFacilitationMove;
  const targetFaithful =
    reviewCase.intent.targetObject ===
      input.rubric.expectedTargetObject &&
    reviewCase.moveSpec.targetObject ===
      input.rubric.expectedTargetObject &&
    bound.targetObject === input.rubric.expectedTargetObject &&
    preflight.status === input.scenario.expectedPreflightStatus;
  const decisionFaithful =
    reviewDecision === input.scenario.expectedReviewDecision &&
    withdrawalCondition ===
      input.scenario.expectedWithdrawalCondition;
  const draftFaithful = draftRuleFaithful(reviewCase, input.rubric);
  const observationBeforeHash = canonicalProtocolHash(
    before.schemaVersion,
    before
  );
  const observationAfterHash = canonicalProtocolHash(
    after.schemaVersion,
    after
  );
  const scenarioTraceHash = canonicalProtocolHash(
    "cmooc.p4f-lite-scenario-trace.v1",
    {
      adapterKind: input.adapterKind,
      scenarioId: input.scenario.scenarioId,
      observationBeforeHash,
      observationAfterHash,
      boundTargetHash,
      preflightEvidenceHash: preflight.evidenceHash,
      reviewDecision,
      withdrawalCondition,
      receiptHash: receiptResult.receiptHash
    }
  );

  return {
    adapterKind: input.adapterKind,
    adapterId: runtime.adapter.manifest().adapterId,
    scenarioId: input.scenario.scenarioId,
    observationBeforeHash,
    observationAfterHash,
    eventCountBefore: before.eventCount,
    eventCountAfter: after.eventCount,
    boundTargetHash,
    preflightStatus: preflight.status,
    reviewDecision,
    withdrawalCondition,
    receiptHash: receiptResult.receiptHash,
    scenarioTraceHash,
    functionFaithful,
    moveFaithful,
    targetFaithful,
    draftRuleFaithful: draftFaithful,
    decisionFaithful,
    scenarioCompleted:
      functionFaithful &&
      moveFaithful &&
      targetFaithful &&
      draftFaithful &&
      decisionFaithful,
    externalWriteCalls: 0,
    containsForumText: false
  };
}

export async function runP4FLiteReviewPreflight(input: {
  scenarioId: P4FLiteScenarioId;
  adapterKind?: P4FLiteAdapterKind;
}): Promise<P4FLiteScenarioResult> {
  const rubric = parseRubric(rubricJson);
  const scenario = rubric.scenarios.find(
    (candidate) => candidate.scenarioId === input.scenarioId
  );
  if (!scenario) {
    throw new Error("P4F-lite 未找到指定的预声明情境。");
  }
  return runScenario({
    adapterKind: input.adapterKind ?? "synthetic_timeline",
    scenario,
    rubric,
    baseReviewCase: buildP4D1ReviewCase()
  });
}

function rate(
  results: P4FLiteScenarioResult[],
  predicate: (result: P4FLiteScenarioResult) => boolean
): number {
  return results.filter(predicate).length / results.length;
}

export async function buildP4FLiteEvidence(
  rubricInput: unknown = rubricJson
): Promise<P4FLiteEvidence> {
  const rubric = parseRubric(rubricInput);
  const baseReviewCase = buildP4D1ReviewCase();
  if (
    JSON.stringify(
      rubric.requiredDraftChecks.map((check) => check.checkId)
    ) !==
      JSON.stringify(
        baseReviewCase.moveSpec.requiredContentElements
      ) ||
    JSON.stringify(
      rubric.prohibitedDraftChecks.map((check) => check.checkId)
    ) !== JSON.stringify(baseReviewCase.moveSpec.prohibitedMoves)
  ) {
    throw new Error(
      "P4F-lite rubric 的草稿规则必须与冻结 MoveSpec 一致。"
    );
  }
  const results: P4FLiteScenarioResult[] = [];
  for (const adapterKind of [
    "mock_forum",
    "synthetic_timeline"
  ] as const) {
    for (const scenario of rubric.scenarios) {
      results.push(
        await runScenario({
          adapterKind,
          scenario,
          rubric,
          baseReviewCase
        })
      );
    }
  }
  const completedCount = results.filter(
    (result) => result.scenarioCompleted
  ).length;
  return {
    schemaVersion: P4F_LITE_EVIDENCE_SCHEMA_VERSION,
    researchQuestion: "RQ3",
    evidenceName: "P4F-lite 三情境规则级实施保真证据",
    claimBoundary:
      "只支持两个合成 adapter、三个预声明情境中的规则级功能/动作/目标/人工决定保真；不支持真实学习效果、真实论坛可靠性或开放式语义质量结论。",
    rubricId: rubric.rubricId,
    rubricHash: canonicalProtocolHash(
      rubric.schemaVersion,
      rubric as unknown as CanonicalJsonValue
    ),
    fixedDecisionAt: rubric.fixedDecisionAt,
    fixedReviewAt: rubric.fixedReviewAt,
    p4d1IntentHash: baseReviewCase.intentHash,
    p4d1MoveSpecHash: baseReviewCase.moveSpecHash,
    scenarioCount: results.length,
    completedCount,
    completionRate: rate(results, (result) => result.scenarioCompleted),
    functionFidelityRate: rate(
      results,
      (result) => result.functionFaithful
    ),
    moveFidelityRate: rate(
      results,
      (result) => result.moveFaithful
    ),
    targetFidelityRate: rate(
      results,
      (result) => result.targetFaithful
    ),
    draftRuleFidelityRate: rate(
      results,
      (result) => result.draftRuleFaithful
    ),
    decisionFidelityRate: rate(
      results,
      (result) => result.decisionFaithful
    ),
    humanTakeoverCount: results.filter(
      (result) => result.reviewDecision === "reject"
    ).length,
    externalWriteCalls: 0,
    realForumWriteCalls: 0,
    leakedForumTextCount: 0,
    results,
    reproducibility: {
      command: "npm run p4:fidelity:audit",
      rubricFixture: "fixtures/p4f-lite/fidelity-rubric-v1.json",
      randomProcessUsed: false
    },
    containsForumText: false
  };
}

export function defaultP4FLiteOutputRoot(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("未设置 LOCALAPPDATA，无法保存正式 P4F-lite 证据。");
  }
  return path.resolve(
    localAppData,
    "cmooc-research",
    "p4f-lite"
  );
}

export async function persistP4FLiteEvidence(
  evidence: P4FLiteEvidence,
  outputRoot = defaultP4FLiteOutputRoot()
): Promise<string> {
  if (
    evidence.containsForumText ||
    evidence.leakedForumTextCount !== 0 ||
    evidence.externalWriteCalls !== 0 ||
    evidence.realForumWriteCalls !== 0
  ) {
    throw new Error("拒绝保存：P4F-lite 证据越过了去正文或零写入边界。");
  }
  const evidenceDirectory = path.join(
    path.resolve(outputRoot),
    "evidence-v1"
  );
  await mkdir(evidenceDirectory, { recursive: true });
  const evidencePath = path.join(
    evidenceDirectory,
    "three-scenario-fidelity.json"
  );
  await writeFile(
    evidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8"
  );
  return evidencePath;
}
