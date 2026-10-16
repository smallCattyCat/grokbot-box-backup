import assert from "node:assert/strict";
import test from "node:test";
import {
  COURSE_TOOL_SCHEMA_VERSION,
  type CourseToolExecutionOutcome,
  type ServerToolExecutionContext
} from "../../lib/course-tools/contracts";
import {
  COURSE_TOOL_REGISTRY_SCHEMA_VERSION,
  type CourseToolRegistryManifest
} from "../../lib/course-tools/registry";
import {
  createCourseAgentTransport,
  CourseAgentRuntimeError,
  prepareCourseAgentRuntime,
  presentCanonicalCourseAgentPlan,
  type CourseAgentRuntimeRecovery,
  type CourseAgentTransportStore
} from "../../lib/workbench/course-agent-runtime";
import { createCourseAgentToolkit } from "../../lib/workbench/course-agent-toolkit";
import { COURSE_AGENT_RECOVERY_PLAN_COMPILER_VERSION } from "../../lib/workbench/course-agent-plan";
import { SUPPORT_GAP_SELECTION_POLICY_VERSION } from "../../lib/course-tools/tools/register-evidence-tools";
import type { CanonicalPlanRevision } from "../../lib/workbench/plan-store";
import type {
  ClaimedExecutionLease,
  WorkbenchDb
} from "../../lib/workbench/durable-ledger";
import type { WorkbenchRunSnapshot } from "../../lib/workbench/contracts";

const RUN_ID = "00000000-0000-4000-8000-000000000201";
const CHILD_RUN_ID = "00000000-0000-4000-8000-000000000202";
const TASK_ID = "task-00000000-0000-4000-8000-000000000201";
const PLAN_ID = "plan-00000000-0000-4000-8000-000000000201";
const NOW = "2026-08-12T20:00:00.000Z";
const CHECKPOINT_HASH = "b".repeat(64);
const CHECKPOINT_REF = `course-checkpoint:${CHECKPOINT_HASH}`;

const DEFAULT_TOOLS = ["course.context.resolve", "course.snapshot.read"] as const;

function manifest(
  toolNames: readonly string[] = DEFAULT_TOOLS
): CourseToolRegistryManifest {
  return {
    schemaVersion: COURSE_TOOL_REGISTRY_SCHEMA_VERSION,
    sealed: true,
    tools: toolNames.map(
      (name) => ({
        schemaVersion: COURSE_TOOL_SCHEMA_VERSION,
        name,
        version: "1",
        safeLabel: name === "course.context.resolve" ? "绑定课程上下文" : "读取课程快照",
        safeDescription: name === "course.context.resolve"
          ? "绑定服务器提供的精确课程证据锚点。"
          : "读取精确锚点对应的安全课程聚合。",
        capability: name === "platform.editor.stage_verify_clear"
          ? "L3_EXTERNAL_STAGE"
          : name === "test.reversible.apply"
            ? "L2_REVERSIBLE"
            : name === "test.irreversible.publish"
              ? "L4_IRREVERSIBLE"
              : "L0_READ",
        effect: name === "platform.editor.stage_verify_clear"
          ? "external_stage"
          : name === "test.reversible.apply"
            ? "reversible_write"
            : name === "test.irreversible.publish"
              ? "irreversible_external"
              : "read",
        dataClasses: [],
        inputSchemaVersion: `${name}.input.v1`,
        modelInputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {}
        },
        idempotency: { strategy: "input_hash", scope: "step" },
        evidenceRequired: true,
        verificationRequired: false,
        verifierRefs: [],
        retryMaxAttempts: 1,
        recoveryKind: null,
        defaultForName: true
      }))
  };
}

function plan(
  initialStatus = "pending",
  toolNames: readonly string[] = DEFAULT_TOOLS
): CanonicalPlanRevision {
  const createdAt = new Date(NOW);
  return {
    id: PLAN_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    revision: 1,
    objectiveHash: "a".repeat(64),
    source: "server_compiler",
    compilerVersion: "cmooc.course-agent-plan-compiler.v1",
    proposalHash: null,
    safeSummary: "读取精确课程证据。",
    createdAt,
    steps: toolNames.map(
      (toolName, index) => ({
        id: `step-${index + 1}`,
        planRevisionId: PLAN_ID,
        ordinal: index + 1,
        status: index === 0 ? initialStatus : "pending",
        toolName,
        toolVersion: "1",
        dependencyIdsJson: index === 0 ? "[]" : '["step-1"]',
        inputRefsJson: "[]",
        preconditionsJson: "[]",
        postconditionsJson: "[]",
        effectClass: toolName === "platform.editor.stage_verify_clear"
          ? "external_stage"
          : toolName === "test.reversible.apply"
            ? "reversible_write"
            : toolName === "test.irreversible.publish"
              ? "irreversible_external"
              : "read",
        requiredCapability: toolName === "platform.editor.stage_verify_clear"
          ? "L3_EXTERNAL_STAGE"
          : toolName === "test.reversible.apply"
            ? "L2_REVERSIBLE"
            : toolName === "test.irreversible.publish"
              ? "L4_IRREVERSIBLE"
              : "L0_READ",
        acceptanceJson: "{}",
        replanPolicyJson: "{}",
        safeSummary: `安全步骤 ${index + 1}`,
        startedAt: null,
        completedAt: null,
        createdAt
      })
    )
  };
}

function fakeStore(planState: CanonicalPlanRevision) {
  const transitions: Array<{ stepId: string; from: string; to: string }> = [];
  let releases = 0;
  const store: CourseAgentTransportStore = {
    loadPlan: async () => planState,
    transition: async (input) => {
      const step = planState.steps.find((candidate) => candidate.id === input.stepId);
      assert.ok(step);
      assert.equal(step.status, input.from);
      step.status = input.to;
      transitions.push({
        stepId: input.stepId,
        from: input.from,
        to: input.to
      });
    },
    completeBranch: async ({ stepId }) => {
      const step = planState.steps.find((candidate) => candidate.id === stepId);
      assert.ok(step);
      assert.equal(step.status, "running");
      step.status = "completed";
      transitions.push({ stepId, from: "running", to: "completed" });
      for (const downstream of planState.steps) {
        if (downstream.ordinal > step.ordinal && downstream.status === "pending") {
          downstream.status = "skipped";
          transitions.push({
            stepId: downstream.id,
            from: "pending",
            to: "skipped"
          });
        }
      }
    },
    claimLease: async ({ stepId, ownerInstanceId }) =>
      ({
        id: "lease-safe-1",
        taskId: TASK_ID,
        runId: RUN_ID,
        stepId,
        scopeKey: `step:${stepId}`,
        ownerInstanceId,
        generation: 1,
        fencingTokenHash: "b".repeat(64),
        fencingToken: "f".repeat(64),
        status: "active",
        acquiredAt: new Date(NOW),
        heartbeatAt: new Date(NOW),
        expiresAt: new Date("2026-08-12T20:02:00.000Z"),
        releasedAt: null,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW)
      }) as ClaimedExecutionLease,
    releaseLease: async () => {
      releases += 1;
    }
  };
  return { store, transitions, releaseCount: () => releases };
}

type SafeObjectiveRow = Readonly<{
  id: string;
  taskId: string;
  schemaVersion: string;
  objectiveHash: string;
  safeSummary: string;
  structuredGoalJson: string;
  source: string;
  expiresAt: Date | null;
  createdAt: Date;
}>;

type PlanStepCreate = Omit<
  CanonicalPlanRevision["steps"][number],
  "planRevisionId" | "startedAt" | "completedAt"
>;

type PlanCreateData = Omit<CanonicalPlanRevision, "steps"> & Readonly<{
  steps: Readonly<{ create: readonly PlanStepCreate[] }>;
}>;

function runtimeRun(input: {
  id: string;
  parentRunId?: string;
}): Pick<WorkbenchRunSnapshot, "id" | "lineage" | "context" | "createdAt"> {
  return {
    id: input.id,
    ...(input.parentRunId
      ? {
          lineage: {
            schemaVersion: "cmooc.workbench-lineage.v1",
            relation: "continuation" as const,
            rootRunId: RUN_ID,
            parentRunId: input.parentRunId,
            recoveryOfRunId: input.parentRunId,
            generation: 1
          }
        }
      : {}),
    context: {
      schemaVersion: "cmooc.workbench-context.v1",
      ref: "snapshot:safe-course:fixture-1",
      kind: "snapshot",
      title: "课程快照",
      courseAlias: "safe-course",
      state: "ready",
      evidenceAsOf: NOW,
      evidenceHash: "a".repeat(64),
      containsForumText: false,
      containsIdentity: false
    },
    createdAt: NOW
  };
}

function runtimeDbFixture() {
  let objective: SafeObjectiveRow | null = null;
  let objectiveCreates = 0;
  const plans: CanonicalPlanRevision[] = [];
  const runTaskIds = new Map([
    [RUN_ID, TASK_ID],
    [CHILD_RUN_ID, TASK_ID]
  ]);

  const db = {
    workbenchTask: {
      findUnique: async (input: { where: { id: string } }) =>
        input.where.id === TASK_ID ? { id: TASK_ID } : null
    },
    workbenchSafeTaskObjective: {
      findUnique: async (input: { where: { taskId: string } }) =>
        input.where.taskId === TASK_ID ? objective : null,
      create: async (input: { data: SafeObjectiveRow }) => {
        objectiveCreates += 1;
        objective = input.data;
        return objective;
      }
    },
    workbenchRunRecord: {
      findUnique: async (input: { where: { id: string } }) => {
        const taskId = runTaskIds.get(input.where.id);
        return taskId ? { taskId } : null;
      }
    },
    workbenchPlanRevisionRecord: {
      findFirst: async (input: {
        where: { taskId: string; runId?: string; source?: string };
        select?: { revision: true };
      }) => {
        const matching = plans
          .filter(
            (candidate) =>
              candidate.taskId === input.where.taskId &&
              (!input.where.runId || candidate.runId === input.where.runId) &&
              (!input.where.source || candidate.source === input.where.source)
          )
          .sort((left, right) => right.revision - left.revision)[0] ?? null;
        return input.select && matching
          ? { revision: matching.revision }
          : matching;
      },
      findUnique: async (input: {
        where: { taskId_revision: { taskId: string; revision: number } };
      }) =>
        plans.find(
          (candidate) =>
            candidate.taskId === input.where.taskId_revision.taskId &&
            candidate.revision === input.where.taskId_revision.revision
        ) ?? null,
      create: async (input: { data: PlanCreateData }) => {
        const { steps, ...revision } = input.data;
        const planRevision: CanonicalPlanRevision = {
          ...revision,
          steps: steps.create.map((step) => ({
            ...step,
            planRevisionId: revision.id,
            startedAt: null,
            completedAt: null
          }))
        };
        plans.push(planRevision);
        return planRevision;
      }
    }
  } as unknown as WorkbenchDb;

  return {
    db,
    plans,
    objectiveCreateCount: () => objectiveCreates
  };
}

function outcome(status: "succeeded" | "unknown" = "succeeded") {
  return {
    result: {
      status,
      safeModelProjection: { status: status === "succeeded" ? "ready" : "unknown" }
    },
    durableProjection: {
      safeOutputSummary: status === "succeeded"
        ? "课程证据读取完成。"
        : "课程证据结果未知。"
    }
  } as unknown as CourseToolExecutionOutcome;
}

function transportFixture(input?: {
  initialStatus?: string;
  intent?: "inspect" | "implement";
  onToolOutcome?: Parameters<typeof createCourseAgentTransport>[0]["onToolOutcome"];
  execute?: (
    request: unknown,
    context: ServerToolExecutionContext
  ) => Promise<CourseToolExecutionOutcome>;
  toolNames?: readonly string[];
  actionCoordinator?: Parameters<typeof createCourseAgentTransport>[0]["actionCoordinator"];
  actionPolicyMode?: Parameters<typeof createCourseAgentTransport>[0]["actionPolicyMode"];
  autoActionExecutor?: Parameters<typeof createCourseAgentTransport>[0]["autoActionExecutor"];
  causationId?: string;
}) {
  const planState = plan(input?.initialStatus, input?.toolNames);
  const state = fakeStore(planState);
  const contexts: ServerToolExecutionContext[] = [];
  const transport = createCourseAgentTransport({
    runId: RUN_ID,
    taskId: TASK_ID,
    intent: input?.intent ?? "inspect",
    courseScope: { courseId: "safe-course", alias: "safe-course" },
    manifest: manifest(input?.toolNames),
    plan: planState,
    executor: {
      execute: async (request, context) => {
        contexts.push(context);
        return input?.execute
          ? input.execute(request, context)
          : outcome();
      }
    },
    store: state.store,
    now: () => new Date(NOW),
    actionCoordinator: input?.actionCoordinator,
    actionPolicyMode: input?.actionPolicyMode,
    autoActionExecutor: input?.autoActionExecutor,
    onToolOutcome: input?.onToolOutcome,
    causationId: input?.causationId
  });
  return { transport, planState, contexts, ...state };
}

test("transport exposes only canonical plan tools with closed business schemas", () => {
  const { transport } = transportFixture();
  assert.deepEqual(
    transport.listTools().map((tool) => tool.protocolName),
    ["course_context_resolve", "course_snapshot_read"]
  );
  assert.equal(
    transport.listTools().every(
      (tool) => tool.modelInputSchema.additionalProperties === false
    ),
    true
  );
  assert.equal(JSON.stringify(transport.listTools()).includes("publish"), false);
});

test("canonical plan presentation preserves server state and marks recovery", () => {
  const planState = plan("blocked");
  const visible = presentCanonicalCourseAgentPlan(planState);
  assert.match(visible.explanation ?? "", /1 步需要核对/);
  assert.deepEqual(visible.steps[0], {
    step: "安全步骤 1（需要核对）",
    status: "pending"
  });
  assert.deepEqual(visible.steps[1], {
    step: "安全步骤 2",
    status: "pending"
  });
});

test("transport rejects an out-of-order tool before claiming a step", async () => {
  const { transport, transitions, contexts } = transportFixture();
  await assert.rejects(
    transport.invoke({
      runId: RUN_ID,
      callId: "protocol-call-1",
      request: {
        toolName: "course.snapshot.read",
        toolVersion: "1",
        input: {}
      },
      signal: new AbortController().signal
    }),
    (error: unknown) => {
      assert.equal(error instanceof CourseAgentRuntimeError, true);
      assert.equal(
        (error as CourseAgentRuntimeError).code,
        "COURSE_AGENT_STEP_ORDER_VIOLATION"
      );
      return true;
    }
  );
  assert.deepEqual(transitions, []);
  assert.deepEqual(contexts, []);
});

test("successful invocation is server-scoped, fenced, completed, and released", async () => {
  const { transport, transitions, contexts, releaseCount, planState } =
    transportFixture();
  const result = await transport.invoke({
    runId: RUN_ID,
    callId: "protocol-call-1",
    request: {
      toolName: "course.context.resolve",
      toolVersion: "1",
      input: {}
    },
    signal: new AbortController().signal
  });

  assert.equal(result.safeSummary, "课程证据读取完成。");
  assert.deepEqual(transitions, [
    { stepId: "step-1", from: "pending", to: "running" },
    { stepId: "step-1", from: "running", to: "completed" }
  ]);
  assert.equal(planState.steps[0]?.status, "completed");
  assert.equal(releaseCount(), 1);
  assert.equal(contexts.length, 1);
  assert.match(contexts[0]!.callId, /^call-[a-f0-9]{64}$/);
  assert.notEqual(contexts[0]!.callId, "protocol-call-1");
  assert.equal(contexts[0]!.taskId, TASK_ID);
  assert.equal(contexts[0]!.runId, RUN_ID);
  assert.equal(contexts[0]!.planRevisionId, PLAN_ID);
  assert.equal(contexts[0]!.stepId, "step-1");
  assert.equal(contexts[0]!.baseCapability, "L0_READ");
  assert.equal(contexts[0]!.executionLeaseId, "lease-safe-1");
  assert.equal(contexts[0]!.fencingToken, "f".repeat(64));
  assert.equal(contexts[0]!.causationId, undefined);
  assert.equal(JSON.stringify(result).includes("f".repeat(64)), false);
});

test("recovery transport fixes checkpoint causation across every genuine call", async () => {
  const fixture = transportFixture({ causationId: CHECKPOINT_REF });

  for (const [index, toolName] of DEFAULT_TOOLS.entries()) {
    await fixture.transport.invoke({
      runId: RUN_ID,
      callId: `protocol-recovery-${index + 1}`,
      request: { toolName, toolVersion: "1", input: {} },
      signal: new AbortController().signal
    });
  }

  assert.deepEqual(
    fixture.contexts.map((context) => context.causationId),
    [CHECKPOINT_REF, CHECKPOINT_REF]
  );
  assert.throws(
    () => transportFixture({ causationId: "checkpoint with spaces" }),
    (error: unknown) =>
      error instanceof CourseAgentRuntimeError &&
      error.code === "COURSE_AGENT_CAUSATION_INVALID"
  );
});

test("verified no-action selection completes the branch and skips downstream work", async () => {
  const toolNames = [
    "opportunity.select_support_gap",
    "evidence.read_opportunity",
    "artifact.reply_draft.create"
  ] as const;
  const noAction = {
    result: {
      status: "succeeded",
      safeModelProjection: {
        schemaVersion: "cmooc.course-tool.opportunity-selection-output.v1",
        status: "no_action",
        contextRef: "invocation:safe-1",
        snapshotRef: "snapshot-safe-1",
        asOf: NOW,
        candidateSetHash: "c".repeat(64),
        selectionRef: "selection-safe-1",
        evidenceBindingHash: "d".repeat(64),
        selectionPolicyVersion: SUPPORT_GAP_SELECTION_POLICY_VERSION,
        selectedOpportunityId: null,
        reasonCode: "all_sources_checked_no_mature_support_gap",
        exclusions: []
      }
    },
    durableProjection: { safeOutputSummary: "当前没有成熟且安全的支持缺口。" }
  } as unknown as CourseToolExecutionOutcome;
  const { transport, transitions, planState } = transportFixture({
    toolNames,
    execute: async () => noAction
  });

  const result = await transport.invoke({
    runId: RUN_ID,
    callId: "protocol-no-action-1",
    request: {
      toolName: "opportunity.select_support_gap",
      toolVersion: "1",
      input: {}
    },
    signal: new AbortController().signal
  });

  assert.equal(
    (result.model as Readonly<Record<string, unknown>>).status,
    "no_action"
  );
  assert.deepEqual(transitions, [
    { stepId: "step-1", from: "pending", to: "running" },
    { stepId: "step-1", from: "running", to: "completed" },
    { stepId: "step-2", from: "pending", to: "skipped" },
    { stepId: "step-3", from: "pending", to: "skipped" }
  ]);
  assert.deepEqual(
    planState.steps.map((step) => step.status),
    ["completed", "skipped", "skipped"]
  );
});

test("browser-unavailable preflight pauses the plan without attempting STAGE", async () => {
  const toolNames = [
    "platform.target.preflight_read",
    "platform.editor.stage_verify_clear"
  ] as const;
  let calls = 0;
  const { transport, transitions, planState } = transportFixture({
    toolNames,
    execute: async () => {
      calls += 1;
      return {
        result: {
          status: "succeeded",
          safeModelProjection: {
            status: "waiting_for_browser",
            reasonCode: "browser_unavailable"
          }
        },
        durableProjection: {
          safeOutputSummary: "Trusted preflight is waiting for a bound browser."
        }
      } as unknown as CourseToolExecutionOutcome;
    }
  });

  await transport.invoke({
    runId: RUN_ID,
    callId: "protocol-preflight-wait-1",
    request: {
      toolName: "platform.target.preflight_read",
      toolVersion: "1",
      input: { targetRef: "target-safe-1" }
    },
    signal: new AbortController().signal
  });
  assert.equal(calls, 1);
  assert.equal(planState.steps[0]?.status, "waiting_for_browser");
  assert.equal(planState.steps[1]?.status, "pending");
  assert.deepEqual(transitions, [
    { stepId: "step-1", from: "pending", to: "running" },
    { stepId: "step-1", from: "running", to: "waiting_for_browser" }
  ]);

  await assert.rejects(
    transport.invoke({
      runId: RUN_ID,
      callId: "protocol-stage-must-not-run-1",
      request: {
        toolName: "platform.editor.stage_verify_clear",
        toolVersion: "1",
        input: {}
      },
      signal: new AbortController().signal
    }),
    (error: unknown) =>
      error instanceof CourseAgentRuntimeError &&
      error.code === "COURSE_AGENT_STEP_WAITING"
  );
  assert.equal(calls, 1);
});

test("L3 invocation prepares one exact approval and never calls the handler", async () => {
  let executorCalls = 0;
  let preparedCalls = 0;
  const { transport, transitions, planState } = transportFixture({
    toolNames: ["platform.editor.stage_verify_clear"],
    execute: async () => {
      executorCalls += 1;
      return outcome();
    },
    actionCoordinator: {
      prepare: async ({ request, context }) => {
        preparedCalls += 1;
        assert.equal(request.toolName, "platform.editor.stage_verify_clear");
        assert.deepEqual(context.capabilityGrantRefs, []);
        return {
          schemaVersion: "cmooc.course-agent-action-coordinator.v1",
          kind: "approval_required",
          actionRef: "action-safe-1",
          approvalHash: "a".repeat(64),
          bindingHash: "b".repeat(64),
          toolName: "platform.editor.stage_verify_clear",
          toolVersion: "1",
          safeSummary: "准备执行一次零发布 STAGE。",
          validFrom: NOW,
          expiresAt: "2026-08-12T20:05:00.000Z",
          operationBoundary: {
            editorWriteCount: 1,
            editorReadbackCount: 1,
            editorClearCount: 1,
            publishCount: 0,
            notificationCount: 0,
            realPublishEnabled: false
          }
        };
      }
    }
  });

  const projection = await transport.invoke({
    runId: RUN_ID,
    callId: "protocol-stage-approval-1",
    request: {
      toolName: "platform.editor.stage_verify_clear",
      toolVersion: "1",
      input: {
        targetRef: "target-safe-1",
        artifactVersionRef: "artifact-version-safe-1",
        draftBodyHash: "d".repeat(64),
        preflightRef: "preflight-safe-1"
      }
    },
    signal: new AbortController().signal
  });

  assert.equal(preparedCalls, 1);
  assert.equal(executorCalls, 0);
  assert.equal(planState.steps[0]?.status, "waiting_for_approval");
  assert.equal(
    (projection.model as Readonly<Record<string, unknown>>).status,
    "approval_required"
  );
  assert.equal(JSON.stringify(projection).includes("grant"), false);
  assert.deepEqual(transitions, [
    { stepId: "step-1", from: "pending", to: "running" },
    { stepId: "step-1", from: "running", to: "waiting_for_approval" }
  ]);
});

test("auto_reversible releases the transport lease before exact STAGE execution and exposes no approval interaction", async () => {
  let executorCalls = 0;
  let preparedCalls = 0;
  let autoCalls = 0;
  let fixture!: ReturnType<typeof transportFixture>;
  fixture = transportFixture({
    toolNames: ["platform.editor.stage_verify_clear"],
    actionPolicyMode: "auto_reversible",
    execute: async () => {
      executorCalls += 1;
      return outcome();
    },
    actionCoordinator: {
      prepare: async () => {
        preparedCalls += 1;
        return {
          schemaVersion: "cmooc.course-agent-action-coordinator.v1",
          kind: "approval_required",
          actionRef: "action-safe-auto-1",
          approvalHash: "a".repeat(64),
          bindingHash: "b".repeat(64),
          toolName: "platform.editor.stage_verify_clear",
          toolVersion: "1",
          safeSummary: "准备执行一次零发布 STAGE。",
          validFrom: NOW,
          expiresAt: "2026-08-12T20:05:00.000Z",
          operationBoundary: {
            editorWriteCount: 1,
            editorReadbackCount: 1,
            editorClearCount: 1,
            publishCount: 0,
            notificationCount: 0,
            realPublishEnabled: false
          }
        };
      }
    },
    autoActionExecutor: async ({ pendingAction }) => {
      autoCalls += 1;
      assert.equal(fixture.releaseCount(), 1, "the preparation lease must be released first");
      assert.equal(fixture.planState.steps[0]?.status, "waiting_for_approval");
      assert.equal(pendingAction.actionRef, "action-safe-auto-1");
      fixture.planState.steps[0]!.status = "completed";
      return {
        status: "succeeded",
        actionRef: pendingAction.actionRef,
        safeSummary: "已完成零发布暂存、回读与清空。",
        receiptHash: "c".repeat(64),
        stageVerificationRef: "stage-receipt-safe-auto-1",
        safeModelProjection: {
          status: "verified_cleared",
          receiptRef: "stage-receipt-safe-auto-1",
          publicationStatus: "not_published"
        }
      };
    }
  });

  const projection = await fixture.transport.invoke({
    runId: RUN_ID,
    callId: "protocol-stage-auto-reversible-1",
    request: {
      toolName: "platform.editor.stage_verify_clear",
      toolVersion: "1",
      input: {
        targetRef: "target-safe-1",
        artifactVersionRef: "artifact-version-safe-1",
        draftBodyHash: "d".repeat(64),
        preflightRef: "preflight-safe-1"
      }
    },
    signal: new AbortController().signal
  });

  assert.equal(preparedCalls, 1);
  assert.equal(autoCalls, 1);
  assert.equal(executorCalls, 0);
  assert.equal(fixture.transport.pendingInteraction?.(), null);
  assert.equal(fixture.planState.steps[0]?.status, "completed");
  assert.deepEqual(projection.model, {
    status: "verified_cleared",
    receiptRef: "stage-receipt-safe-auto-1",
    publicationStatus: "not_published"
  });
});

test("auto_reversible grants only the L2 base ceiling while confirm_stage keeps L1 and L4 remains unavailable", async () => {
  const observed: string[] = [];
  const reversible = transportFixture({
    toolNames: ["test.reversible.apply"],
    intent: "implement",
    actionPolicyMode: "auto_reversible",
    autoActionExecutor: async () => {
      throw new Error("TEST_AUTO_EXECUTOR_MUST_NOT_HANDLE_L2");
    },
    execute: async (_request, context) => {
      observed.push(context.baseCapability);
      return outcome();
    }
  });
  await reversible.transport.invoke({
    runId: RUN_ID,
    callId: "protocol-reversible-auto-1",
    request: {
      toolName: "test.reversible.apply",
      toolVersion: "1",
      input: {}
    },
    signal: new AbortController().signal
  });
  assert.deepEqual(observed, ["L2_REVERSIBLE"]);

  const confirmed: string[] = [];
  const confirmStage = transportFixture({
    toolNames: ["test.reversible.apply"],
    intent: "implement",
    execute: async (_request, context) => {
      confirmed.push(context.baseCapability);
      return outcome();
    }
  });
  await confirmStage.transport.invoke({
    runId: RUN_ID,
    callId: "protocol-reversible-confirm-1",
    request: {
      toolName: "test.reversible.apply",
      toolVersion: "1",
      input: {}
    },
    signal: new AbortController().signal
  });
  assert.deepEqual(confirmed, ["L1_ARTIFACT"]);

  let irreversibleExecutorCalls = 0;
  let irreversibleAutoCalls = 0;
  const irreversible = transportFixture({
    toolNames: ["test.irreversible.publish"],
    intent: "implement",
    actionPolicyMode: "auto_reversible",
    autoActionExecutor: async () => {
      irreversibleAutoCalls += 1;
      throw new Error("TEST_L4_AUTO_AUTHORIZATION_FORBIDDEN");
    },
    execute: async () => {
      irreversibleExecutorCalls += 1;
      return outcome();
    }
  });
  await assert.rejects(
    irreversible.transport.invoke({
      runId: RUN_ID,
      callId: "protocol-irreversible-auto-1",
      request: {
        toolName: "test.irreversible.publish",
        toolVersion: "1",
        input: {}
      },
      signal: new AbortController().signal
    }),
    (error: unknown) =>
      error instanceof CourseAgentRuntimeError &&
      error.code === "COURSE_AGENT_STEP_EXECUTION_FAILED"
  );
  assert.equal(irreversibleAutoCalls, 0);
  assert.equal(irreversibleExecutorCalls, 0);
});

test("successful transient output is handed to the protected in-process listener before completion", async () => {
  const observed: Array<{
    toolName: string;
    status: string;
    stepId: string;
  }> = [];
  const fixture = transportFixture({
    onToolOutcome: ({ toolName, context, outcome: completedOutcome }) => {
      observed.push({
        toolName,
        status: completedOutcome.result.status,
        stepId: context.stepId
      });
    }
  });

  await fixture.transport.invoke({
    runId: RUN_ID,
    callId: "protocol-call-material-handoff",
    request: {
      toolName: "course.context.resolve",
      toolVersion: "1",
      input: {}
    },
    signal: new AbortController().signal
  });

  assert.deepEqual(observed, [
    {
      toolName: "course.context.resolve",
      status: "succeeded",
      stepId: "step-1"
    }
  ]);
  assert.equal(fixture.planState.steps[0]?.status, "completed");
});

test("unknown tool outcome blocks the canonical step without a retry", async () => {
  const { transport, transitions, releaseCount, planState } = transportFixture({
    execute: async () => outcome("unknown")
  });
  const result = await transport.invoke({
    runId: RUN_ID,
    callId: "protocol-call-unknown",
    request: {
      toolName: "course.context.resolve",
      toolVersion: "1",
      input: {}
    },
    signal: new AbortController().signal
  });
  assert.deepEqual(result.model, { status: "unknown" });
  assert.deepEqual(transitions, [
    { stepId: "step-1", from: "pending", to: "running" },
    { stepId: "step-1", from: "running", to: "blocked" }
  ]);
  assert.equal(planState.steps[0]?.status, "blocked");
  assert.equal(releaseCount(), 1);
});

test("executor failure blocks and releases while a blocked plan fails closed", async () => {
  const failed = transportFixture({
    execute: async () => {
      throw new Error("restricted raw failure");
    }
  });
  await assert.rejects(
    failed.transport.invoke({
      runId: RUN_ID,
      callId: "protocol-call-failed",
      request: {
        toolName: "course.context.resolve",
        toolVersion: "1",
        input: {}
      },
      signal: new AbortController().signal
    }),
    /Canonical course tool step failed/
  );
  assert.equal(failed.planState.steps[0]?.status, "blocked");
  assert.equal(failed.releaseCount(), 1);

  const blocked = transportFixture({ initialStatus: "blocked" });
  await assert.rejects(
    blocked.transport.invoke({
      runId: RUN_ID,
      callId: "protocol-call-blocked",
      request: {
        toolName: "course.context.resolve",
        toolVersion: "1",
        input: {}
      },
      signal: new AbortController().signal
    }),
    (error: unknown) => {
      assert.equal(
        (error as CourseAgentRuntimeError).code,
        "COURSE_AGENT_STEP_REQUIRES_RECOVERY"
      );
      return true;
    }
  );
  assert.deepEqual(blocked.transitions, []);
});

test("an aborted invocation performs no state transition", async () => {
  const { transport, transitions } = transportFixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    transport.invoke({
      runId: RUN_ID,
      callId: "protocol-call-aborted",
      request: {
        toolName: "course.context.resolve",
        toolVersion: "1",
        input: {}
      },
      signal: controller.signal
    }),
    /aborted before execution/
  );
  assert.deepEqual(transitions, []);
});

test("recovery prepare reuses the root objective and compiles a checkpoint-bound child plan", async () => {
  const fixture = runtimeDbFixture();
  const rootToolkit = createCourseAgentToolkit({
    taskId: TASK_ID,
    runId: RUN_ID,
    courseAlias: "safe-course"
  });
  const root = await prepareCourseAgentRuntime({
    run: runtimeRun({ id: RUN_ID }),
    goalCode: "schedule_review",
    intent: "implement",
    registry: rootToolkit.registry,
    verifierRegistry: rootToolkit.verifierRegistry,
    db: fixture.db,
    resolveCourseScope: async () => ({
      courseId: "safe-course-id",
      alias: "safe-course",
      manifestHash: "d".repeat(64)
    })
  });
  const childToolkit = createCourseAgentToolkit({
    taskId: TASK_ID,
    runId: CHILD_RUN_ID,
    courseAlias: "safe-course"
  });
  const child = await prepareCourseAgentRuntime({
    run: runtimeRun({ id: CHILD_RUN_ID, parentRunId: RUN_ID }),
    goalCode: "schedule_review",
    intent: "implement",
    registry: childToolkit.registry,
    verifierRegistry: childToolkit.verifierRegistry,
    db: fixture.db,
    recovery: {
      mode: "regenerate_draft",
      sourceCheckpointRef: CHECKPOINT_REF,
      sourceCheckpointHash: CHECKPOINT_HASH
    },
    resolveCourseScope: async () => ({
      courseId: "safe-course-id",
      alias: "safe-course",
      manifestHash: "d".repeat(64)
    })
  });

  assert.equal(fixture.objectiveCreateCount(), 1);
  assert.equal(child.taskId, root.taskId);
  assert.equal(child.objectiveHash, root.objectiveHash);
  assert.equal(child.plan.revision, 2);
  assert.equal(
    child.plan.compilerVersion,
    COURSE_AGENT_RECOVERY_PLAN_COMPILER_VERSION
  );
  assert.deepEqual(
    child.plan.steps.map((step) => step.toolName),
    [
      "artifact.reply_draft.regenerate",
      "platform.target.preflight_read",
      "platform.editor.stage_verify_clear",
      "delivery.bundle.create"
    ]
  );
  for (const step of child.plan.steps) {
    assert.match(step.inputRefsJson, new RegExp(CHECKPOINT_HASH));
    assert.match(step.inputRefsJson, /verified_checkpoint_causation/);
  }
});

test("recovery prepare rejects a tampered durable checkpoint binding", async () => {
  const fixture = runtimeDbFixture();
  const run = runtimeRun({ id: CHILD_RUN_ID, parentRunId: RUN_ID });
  const recovery: CourseAgentRuntimeRecovery = {
    mode: "regenerate_draft",
    sourceCheckpointRef: CHECKPOINT_REF,
    sourceCheckpointHash: CHECKPOINT_HASH
  };
  const prepare = () => {
    const toolkit = createCourseAgentToolkit({
      taskId: TASK_ID,
      runId: CHILD_RUN_ID,
      courseAlias: "safe-course"
    });
    return prepareCourseAgentRuntime({
      run,
      goalCode: "course_evidence_support_gap",
      intent: "implement",
      registry: toolkit.registry,
      verifierRegistry: toolkit.verifierRegistry,
      db: fixture.db,
      recovery,
      resolveCourseScope: async () => ({
        courseId: "safe-course-id",
        alias: "safe-course",
        manifestHash: "d".repeat(64)
      })
    });
  };
  const prepared = await prepare();
  prepared.plan.steps[0]!.inputRefsJson = JSON.stringify([
    {
      kind: "verified_checkpoint_causation",
      ref: `course-checkpoint:${"c".repeat(64)}`,
      checkpointHash: "c".repeat(64),
      recoveryMode: "regenerate_draft",
      source: "server_compiler"
    }
  ]);

  await assert.rejects(
    prepare(),
    (error: unknown) =>
      error instanceof CourseAgentRuntimeError &&
      error.code === "COURSE_AGENT_CANONICAL_PLAN_CONFLICT"
  );
  assert.equal(fixture.plans.length, 1);
});

test("recovery prepare rejects non-closed checkpoint input before durable writes", async () => {
  const toolkit = createCourseAgentToolkit({
    taskId: TASK_ID,
    runId: CHILD_RUN_ID,
    courseAlias: "safe-course"
  });
  const invalidRecovery = {
    mode: "regenerate_draft",
    sourceCheckpointRef: CHECKPOINT_REF,
    sourceCheckpointHash: CHECKPOINT_HASH,
    protectedRef: "must-not-enter-runtime"
  } as unknown as CourseAgentRuntimeRecovery;

  await assert.rejects(
    prepareCourseAgentRuntime({
      run: runtimeRun({ id: CHILD_RUN_ID, parentRunId: RUN_ID }),
      goalCode: "course_evidence_support_gap",
      intent: "implement",
      registry: toolkit.registry,
      verifierRegistry: toolkit.verifierRegistry,
      db: Object.freeze({}) as WorkbenchDb,
      recovery: invalidRecovery
    }),
    (error: unknown) =>
      error instanceof CourseAgentRuntimeError &&
      error.code === "COURSE_AGENT_RECOVERY_INPUT_INVALID"
  );
});
