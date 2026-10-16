import { createHash } from "node:crypto";
import { prisma as defaultPrisma } from "@/lib/db";
import { loadCourseManifest } from "@/lib/autonomy/course-manifest";
import {
  isSafeIdentifier,
  isSha256,
  type CapabilityLevel,
  type CourseToolExecutionOutcome,
  type CourseToolJsonValue,
  type CourseToolSafeProjection,
  type ModelToolRequest,
  type ServerToolExecutionContext
} from "@/lib/course-tools/contracts";
import { CourseToolExecutor } from "@/lib/course-tools/executor";
import {
  CourseToolPolicyGateway,
  COURSE_TOOL_POLICY_VERSION,
  type ScopedCourseToolGrantAuthority
} from "@/lib/course-tools/policy-gateway";
import {
  CourseToolRegistry,
  type CourseToolRegistryManifest
} from "@/lib/course-tools/registry";
import { CourseToolVerifierRegistry } from "@/lib/course-tools/verifier-registry";
import { parseOpportunitySelectionToolOutput } from "@/lib/course-tools/tools/register-evidence-tools";
import {
  claimExecutionLease,
  createSafeTaskObjective,
  releaseExecutionLease,
  serializeSafeDurableValue,
  type ClaimedExecutionLease,
  type WorkbenchDb
} from "@/lib/workbench/durable-ledger";
import {
  classifyCourseAgentObjective,
  compileCourseEvidencePlan,
  compileCourseRecoveryPlan,
  workbenchTaskId,
  COURSE_AGENT_PLAN_COMPILER_VERSION,
  COURSE_AGENT_RECOVERY_PLAN_COMPILER_VERSION,
  type CourseAgentExecutionIntent,
  type CourseAgentGoalCode,
  type CourseAgentRecoveryMode
} from "@/lib/workbench/course-agent-plan";
import {
  compileCourseAgentMvpPlan,
  MVP_COURSE_AGENT_PLAN_COMPILER_VERSION,
  type CourseAgentMvpPlanSelection
} from "@/lib/workbench/course-agent-mvp-planner";
import { DurableCourseToolExecutionSink } from "@/lib/workbench/course-tool-ledger-sink";
import type {
  WorkbenchCourseToolDescriptor,
  WorkbenchCourseToolInvocation,
  WorkbenchCourseToolTransport
} from "@/lib/workbench/course-tool-transport";
import {
  completePlanBranch,
  createPlanRevision,
  loadCurrentCanonicalPlan,
  transitionPlanStep,
  type CanonicalPlanRevision,
  type CanonicalPlanStepStatus
} from "@/lib/workbench/plan-store";
import type { WorkbenchRunSnapshot } from "@/lib/workbench/contracts";
import type { WorkbenchPlanState } from "@/lib/workbench/contracts";
import type {
  CourseAgentActionCoordinator,
  PendingCourseAgentAction
} from "@/lib/workbench/course-agent-action-coordinator";
import type {
  ApprovedCourseAgentActionResult
} from "@/lib/workbench/course-agent-action-execution";

export const COURSE_AGENT_RUNTIME_SCHEMA_VERSION =
  "cmooc.course-agent-runtime.v1" as const;

export const COURSE_AGENT_ACTION_POLICY_MODES = [
  "confirm_stage",
  "auto_reversible"
] as const;

export type CourseAgentActionPolicyMode =
  (typeof COURSE_AGENT_ACTION_POLICY_MODES)[number];

export type CourseAgentAutoActionExecutor = (input: Readonly<{
  pendingAction: PendingCourseAgentAction;
}>) => Promise<ApprovedCourseAgentActionResult>;

const EXECUTION_LEASE_TTL_MS = 2 * 60_000;
const TOOL_DEADLINE_MS = 60_000;

type CourseAgentExecutor = Pick<CourseToolExecutor, "execute">;

export type CourseAgentPlanChanged = (
  plan: CanonicalPlanRevision
) => void | Promise<void>;

/**
 * In-process handoff for downstream adapters. The listener may inspect the
 * executor's transient output but must never serialize protected draft bodies,
 * opaque protected-store handles, identity, or platform session material.
 */
export type CourseAgentToolOutcomeListener = (input: Readonly<{
  toolName: string;
  toolVersion: string;
  context: Readonly<ServerToolExecutionContext>;
  outcome: Readonly<CourseToolExecutionOutcome>;
}>) => void | Promise<void>;

export type CourseAgentCourseScopeResolver = (
  courseAlias: string
) => Promise<Readonly<ServerToolExecutionContext["courseScope"]>>;

export type CourseAgentRuntimeRecovery = Readonly<{
  mode: CourseAgentRecoveryMode;
  sourceCheckpointRef: string;
  sourceCheckpointHash: string;
}>;

export interface CourseAgentTransportStore {
  loadPlan(): Promise<CanonicalPlanRevision | null>;
  transition(input: {
    stepId: string;
    from: CanonicalPlanStepStatus;
    to: CanonicalPlanStepStatus;
    at: string;
  }): Promise<void>;
  completeBranch(input: {
    stepId: string;
    at: string;
  }): Promise<void>;
  claimLease(input: {
    stepId: string;
    ownerInstanceId: string;
    ttlMs: number;
    now: string;
  }): Promise<ClaimedExecutionLease>;
  releaseLease(input: {
    lease: ClaimedExecutionLease;
    ownerInstanceId: string;
    now: string;
  }): Promise<void>;
}

export type PreparedCourseAgentRuntime = Readonly<{
  schemaVersion: typeof COURSE_AGENT_RUNTIME_SCHEMA_VERSION;
  actionPolicyMode: CourseAgentActionPolicyMode;
  taskId: string;
  objectiveHash: string;
  plan: CanonicalPlanRevision;
  registryManifest: CourseToolRegistryManifest;
  transport: WorkbenchCourseToolTransport;
}>;

export class CourseAgentRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CourseAgentRuntimeError";
    this.code = code;
  }
}

export function presentCanonicalCourseAgentPlan(
  plan: CanonicalPlanRevision
): Omit<WorkbenchPlanState, "updatedAt"> {
  const blockedCount = plan.steps.filter(
    (step) => step.status === "blocked"
  ).length;
  return {
    explanation: blockedCount > 0
      ? `${plan.safeSummary} · ${blockedCount} 步需要核对后恢复。`
      : plan.safeSummary,
    steps: plan.steps.map((step) => ({
      step: step.status === "blocked"
        ? `${step.safeSummary}（需要核对）`
        : step.status === "waiting_for_browser"
          ? `${step.safeSummary}（等待受信浏览器）`
          : step.status === "waiting_for_approval"
            ? `${step.safeSummary}（等待本次精确授权）`
            : step.status === "waiting_for_reconcile"
              ? `${step.safeSummary}（等待所有权安全核对）`
        : step.status === "skipped"
          ? `${step.safeSummary}（当前无需继续）`
        : step.safeSummary,
      status: step.status === "completed" || step.status === "skipped"
        ? "completed"
        : step.status === "running"
          ? "inProgress"
          : "pending"
    }))
  };
}

function internalCallId(protocolCallId: string): string {
  return `call-${createHash("sha256")
    .update(protocolCallId, "utf8")
    .digest("hex")}`;
}

function protocolToolName(toolName: string): string {
  const candidate = toolName.replace(/\./g, "_");
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(candidate)) {
    throw new CourseAgentRuntimeError(
      "COURSE_AGENT_PROTOCOL_TOOL_NAME_INVALID",
      "Canonical course tool cannot be represented by the dynamic tool protocol."
    );
  }
  return candidate;
}

function descriptorsForPlan(input: {
  manifest: CourseToolRegistryManifest;
  plan: CanonicalPlanRevision;
}): readonly WorkbenchCourseToolDescriptor[] {
  const descriptors = new Map<string, WorkbenchCourseToolDescriptor>();
  for (const step of input.plan.steps) {
    const manifestEntry = input.manifest.tools.find(
      (entry) =>
        entry.name === step.toolName && entry.version === step.toolVersion
    );
    if (!manifestEntry?.modelInputSchema) {
      throw new CourseAgentRuntimeError(
        "COURSE_AGENT_PLAN_TOOL_UNAVAILABLE",
        `Canonical plan tool ${step.toolName}@${step.toolVersion} has no model schema.`
      );
    }
    const protocolName = protocolToolName(step.toolName);
    const existing = descriptors.get(protocolName);
    if (
      existing &&
      (existing.toolName !== step.toolName ||
        existing.toolVersion !== step.toolVersion)
    ) {
      throw new CourseAgentRuntimeError(
        "COURSE_AGENT_PROTOCOL_TOOL_COLLISION",
        "Two canonical tools map to the same dynamic tool name."
      );
    }
    descriptors.set(
      protocolName,
      Object.freeze({
        protocolName,
        toolName: manifestEntry.name,
        toolVersion: manifestEntry.version,
        safeLabel: manifestEntry.safeLabel,
        safeDescription: manifestEntry.safeDescription,
        modelInputSchema: manifestEntry.modelInputSchema
      })
    );
  }
  return Object.freeze([...descriptors.values()]);
}

function nextPlanStep(plan: CanonicalPlanRevision):
  | CanonicalPlanRevision["steps"][number]
  | null {
  const active = plan.steps.find(
    (step) =>
      step.status === "running" ||
      step.status === "blocked" ||
      step.status === "waiting_for_browser" ||
      step.status === "waiting_for_approval" ||
      step.status === "waiting_for_reconcile"
  );
  return active ?? plan.steps.find((step) => step.status === "pending") ?? null;
}

function selectionEndsCurrentPlan(input: {
  toolName: string;
  outcome: CourseToolExecutionOutcome;
}): boolean {
  if (
    input.toolName !== "opportunity.select_support_gap" ||
    input.outcome.result.status !== "succeeded"
  ) {
    return false;
  }
  return (
    parseOpportunitySelectionToolOutput(
      input.outcome.result.safeModelProjection
    ).status !== "selected"
  );
}

function platformPreflightState(input: {
  toolName: string;
  outcome: CourseToolExecutionOutcome;
}): "ready" | "waiting_for_browser" | "blocked" | null {
  if (
    input.toolName !== "platform.target.preflight_read" ||
    input.outcome.result.status !== "succeeded"
  ) {
    return null;
  }
  const model = input.outcome.result.safeModelProjection;
  if (!isCourseToolObject(model)) {
    return "blocked";
  }
  const status = model.status;
  return status === "ready"
    ? "ready"
    : status === "waiting_for_browser"
      ? "waiting_for_browser"
      : "blocked";
}

function isCourseToolObject(
  value: CourseToolJsonValue
): value is Readonly<{ [key: string]: CourseToolJsonValue }> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertPlanMatchesExpected(
  actual: CanonicalPlanRevision,
  expected:
    | ReturnType<typeof compileCourseEvidencePlan>
    | ReturnType<typeof compileCourseRecoveryPlan>
    | ReturnType<typeof compileCourseAgentMvpPlan>
): void {
  const compilerAccepted =
    expected.compilerVersion === COURSE_AGENT_PLAN_COMPILER_VERSION ||
    expected.compilerVersion === COURSE_AGENT_RECOVERY_PLAN_COMPILER_VERSION ||
    expected.compilerVersion === MVP_COURSE_AGENT_PLAN_COMPILER_VERSION;
  const immutableStepMatches = (
    actualStep: CanonicalPlanRevision["steps"][number],
    expectedStep: (typeof expected.steps)[number]
  ): boolean =>
    actualStep.id === expectedStep.id &&
    actualStep.ordinal === expectedStep.ordinal &&
    actualStep.toolName === expectedStep.toolName &&
    actualStep.toolVersion === expectedStep.toolVersion &&
    actualStep.dependencyIdsJson ===
      serializeSafeDurableValue(
        expectedStep.dependencyIds,
        `expected.steps[${expectedStep.ordinal - 1}].dependencyIds`
      ) &&
    actualStep.inputRefsJson ===
      serializeSafeDurableValue(
        expectedStep.inputRefs,
        `expected.steps[${expectedStep.ordinal - 1}].inputRefs`
      ) &&
    actualStep.preconditionsJson ===
      serializeSafeDurableValue(
        expectedStep.preconditions,
        `expected.steps[${expectedStep.ordinal - 1}].preconditions`
      ) &&
    actualStep.postconditionsJson ===
      serializeSafeDurableValue(
        expectedStep.postconditions,
        `expected.steps[${expectedStep.ordinal - 1}].postconditions`
      ) &&
    actualStep.effectClass === expectedStep.effectClass &&
    actualStep.requiredCapability === expectedStep.requiredCapability &&
    actualStep.acceptanceJson ===
      serializeSafeDurableValue(
        expectedStep.acceptance,
        `expected.steps[${expectedStep.ordinal - 1}].acceptance`
      ) &&
    actualStep.replanPolicyJson ===
      serializeSafeDurableValue(
        expectedStep.replanPolicy,
        `expected.steps[${expectedStep.ordinal - 1}].replanPolicy`
      ) &&
    actualStep.safeSummary === expectedStep.safeSummary;
  if (
    !compilerAccepted ||
    actual.taskId !== expected.taskId ||
    actual.runId !== expected.runId ||
    actual.objectiveHash !== expected.objectiveHash ||
    actual.compilerVersion !== expected.compilerVersion ||
    actual.steps.length !== expected.steps.length ||
    actual.steps.some((step, index) => {
      const expectedStep = expected.steps[index];
      return !expectedStep || !immutableStepMatches(step, expectedStep);
    })
  ) {
    throw new CourseAgentRuntimeError(
      "COURSE_AGENT_CANONICAL_PLAN_CONFLICT",
      "Existing canonical plan does not match the current server compiler."
    );
  }
}

function validateRuntimeRecovery(
  recovery: CourseAgentRuntimeRecovery | undefined
): CourseAgentRuntimeRecovery | undefined {
  if (recovery === undefined) return undefined;
  const keys = Object.keys(recovery).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "mode" ||
    keys[1] !== "sourceCheckpointHash" ||
    keys[2] !== "sourceCheckpointRef" ||
    recovery.mode !== "regenerate_draft" ||
    !isSha256(recovery.sourceCheckpointHash) ||
    recovery.sourceCheckpointRef !==
      `course-checkpoint:${recovery.sourceCheckpointHash}` ||
    !isSafeIdentifier(recovery.sourceCheckpointRef)
  ) {
    throw new CourseAgentRuntimeError(
      "COURSE_AGENT_RECOVERY_INPUT_INVALID",
      "Course agent recovery requires one exact verified checkpoint binding."
    );
  }
  return Object.freeze({ ...recovery });
}

async function reportPlan(
  store: CourseAgentTransportStore,
  callback: CourseAgentPlanChanged | undefined
): Promise<void> {
  if (!callback) return;
  const plan = await store.loadPlan();
  if (plan) await Promise.resolve(callback(plan)).catch(() => undefined);
}

/**
 * Creates the transport over an already persisted canonical plan. Every call
 * is matched to the single next step, fenced by a step lease, and reflected
 * back into that plan. The model can choose business parameters only.
 */
export function createCourseAgentTransport(input: {
  runId: string;
  taskId: string;
  intent: CourseAgentExecutionIntent;
  courseScope: ServerToolExecutionContext["courseScope"];
  manifest: CourseToolRegistryManifest;
  plan: CanonicalPlanRevision;
  executor: CourseAgentExecutor;
  store: CourseAgentTransportStore;
  actionCoordinator?: CourseAgentActionCoordinator;
  actionPolicyMode?: CourseAgentActionPolicyMode;
  autoActionExecutor?: CourseAgentAutoActionExecutor;
  now?: () => Date;
  onPlanChanged?: CourseAgentPlanChanged;
  onToolOutcome?: CourseAgentToolOutcomeListener;
  causationId?: string;
}): WorkbenchCourseToolTransport {
  if (input.causationId !== undefined && !isSafeIdentifier(input.causationId)) {
    throw new CourseAgentRuntimeError(
      "COURSE_AGENT_CAUSATION_INVALID",
      "Course agent transport causation is invalid."
    );
  }
  const descriptors = descriptorsForPlan({
    manifest: input.manifest,
    plan: input.plan
  });
  const clock = input.now ?? (() => new Date());
  const ownerInstanceId = `course-agent-${input.runId}`;
  const actionPolicyMode = input.actionPolicyMode ?? "confirm_stage";
  if (
    !COURSE_AGENT_ACTION_POLICY_MODES.includes(actionPolicyMode) ||
    (actionPolicyMode === "auto_reversible" && !input.autoActionExecutor) ||
    (actionPolicyMode === "confirm_stage" && input.autoActionExecutor)
  ) {
    throw new CourseAgentRuntimeError(
      "COURSE_AGENT_ACTION_POLICY_INVALID",
      "Course action policy mode and its server-side executor are inconsistent."
    );
  }
  let pendingAction: PendingCourseAgentAction | null = null;

  return Object.freeze({
    listTools: () => descriptors,
    pendingInteraction: () => pendingAction,
    resolvePendingInteraction: (actionRef: string) => {
      if (!pendingAction || pendingAction.actionRef !== actionRef) return false;
      pendingAction = null;
      return true;
    },
    invoke: async (
      invocation: WorkbenchCourseToolInvocation
    ): Promise<CourseToolSafeProjection> => {
      if (invocation.runId !== input.runId) {
        throw new CourseAgentRuntimeError(
          "COURSE_AGENT_RUN_SCOPE_MISMATCH",
          "Dynamic course tool call belongs to a different run."
        );
      }
      if (invocation.signal.aborted) {
        throw new CourseAgentRuntimeError(
          "COURSE_AGENT_CALL_ABORTED",
          "Dynamic course tool call was aborted before execution."
        );
      }

      const plan = await input.store.loadPlan();
      if (!plan || plan.id !== input.plan.id) {
        throw new CourseAgentRuntimeError(
          "COURSE_AGENT_CANONICAL_PLAN_UNAVAILABLE",
          "Current canonical plan is unavailable or superseded."
        );
      }
      const step = nextPlanStep(plan);
      if (!step) {
        throw new CourseAgentRuntimeError(
          "COURSE_AGENT_PLAN_COMPLETE",
          "Canonical plan has no remaining course tool step."
        );
      }
      if (
        step.status === "running" ||
        step.status === "blocked" ||
        step.status === "waiting_for_browser" ||
        step.status === "waiting_for_approval" ||
        step.status === "waiting_for_reconcile"
      ) {
        throw new CourseAgentRuntimeError(
          step.status === "running"
            ? "COURSE_AGENT_STEP_BUSY"
            : step.status.startsWith("waiting_")
              ? "COURSE_AGENT_STEP_WAITING"
              : "COURSE_AGENT_STEP_REQUIRES_RECOVERY",
          "Canonical step cannot be executed until its prior state is reconciled."
        );
      }
      if (
        invocation.request.toolName !== step.toolName ||
        invocation.request.toolVersion !== step.toolVersion
      ) {
        throw new CourseAgentRuntimeError(
          "COURSE_AGENT_STEP_ORDER_VIOLATION",
          `Expected ${step.toolName}@${step.toolVersion} as the next canonical step.`
        );
      }

      const startedAt = clock().toISOString();
      await input.store.transition({
        stepId: step.id,
        from: "pending",
        to: "running",
        at: startedAt
      });
      await reportPlan(input.store, input.onPlanChanged);

      let lease: ClaimedExecutionLease | undefined;
      let deferredAutoAction: PendingCourseAgentAction | undefined;
      try {
        lease = await input.store.claimLease({
          stepId: step.id,
          ownerInstanceId,
          ttlMs: EXECUTION_LEASE_TTL_MS,
          now: startedAt
        });
        const callId = internalCallId(invocation.callId);
        const now = clock();
        const context: ServerToolExecutionContext = Object.freeze({
          callId,
          taskId: input.taskId,
          runId: input.runId,
          planRevisionId: plan.id,
          stepId: step.id,
          courseScope: Object.freeze({ ...input.courseScope }),
          intent: input.intent,
          baseCapability: (
            input.intent === "inspect"
              ? "L0_READ"
              : actionPolicyMode === "auto_reversible"
                ? "L2_REVERSIBLE"
                : "L1_ARTIFACT"
          ) as CapabilityLevel,
          capabilityGrantRefs: Object.freeze([]),
          policyVersion: COURSE_TOOL_POLICY_VERSION,
          now: now.toISOString(),
          deadlineAt: new Date(now.getTime() + TOOL_DEADLINE_MS).toISOString(),
          idempotencyKey: `request-${callId}`,
          attempt: 1,
          executionLeaseId: lease.id,
          leaseGeneration: lease.generation,
          fencingToken: lease.fencingToken,
          ...(input.causationId
            ? { causationId: input.causationId }
            : {})
        });
        if (step.requiredCapability === "L3_EXTERNAL_STAGE") {
          if (!input.actionCoordinator) {
            throw new CourseAgentRuntimeError(
              "COURSE_AGENT_APPROVAL_COORDINATOR_REQUIRED",
              "L3 course action requires a server-side approval coordinator."
            );
          }
          pendingAction = await input.actionCoordinator.prepare({
            request: invocation.request,
            context
          });
          await input.store.transition({
            stepId: step.id,
            from: "running",
            to: "waiting_for_approval",
            at: clock().toISOString()
          });
          await reportPlan(input.store, input.onPlanChanged);
          if (actionPolicyMode === "auto_reversible") {
            deferredAutoAction = pendingAction;
          } else {
            return Object.freeze({
              model: Object.freeze({
                status: pendingAction.kind,
                actionRef: pendingAction.actionRef,
                approvalHash: pendingAction.approvalHash,
                expiresAt: pendingAction.expiresAt,
                operationBoundary: pendingAction.operationBoundary
              }),
              safeSummary: pendingAction.safeSummary,
              containsForumText: false,
              containsIdentity: false,
              containsSecrets: false
            });
          }
        } else {
          if (step.requiredCapability === "L4_IRREVERSIBLE") {
            throw new CourseAgentRuntimeError(
              "COURSE_AGENT_IRREVERSIBLE_ACTION_LOCKED",
              "L4 publish, send, and notification actions remain unavailable."
            );
          }
          const outcome: CourseToolExecutionOutcome =
            await input.executor.execute(invocation.request, context);
          if (outcome.result.status === "succeeded" && input.onToolOutcome) {
            await Promise.resolve(
              input.onToolOutcome({
                toolName: step.toolName,
                toolVersion: step.toolVersion,
                context,
                outcome
              })
            );
          }
          const terminalNoAction = selectionEndsCurrentPlan({
            toolName: step.toolName,
            outcome
          });
          if (terminalNoAction) {
            await input.store.completeBranch({
              stepId: step.id,
              at: clock().toISOString()
            });
          } else {
            const preflightState = platformPreflightState({
              toolName: step.toolName,
              outcome
            });
            await input.store.transition({
              stepId: step.id,
              from: "running",
              to:
                preflightState === "waiting_for_browser"
                  ? "waiting_for_browser"
                  : preflightState === "blocked"
                    ? "blocked"
                    : outcome.result.status === "succeeded"
                      ? "completed"
                      : "blocked",
              at: clock().toISOString()
            });
          }
          await reportPlan(input.store, input.onPlanChanged);
          return Object.freeze({
            model: outcome.result.safeModelProjection,
            safeSummary: outcome.durableProjection.safeOutputSummary,
            containsForumText: false,
            containsIdentity: false,
            containsSecrets: false
          });
        }
      } catch (error) {
        await input.store
          .transition({
            stepId: step.id,
            from: "running",
            to: "blocked",
            at: clock().toISOString()
          })
          .catch(() => undefined);
        await reportPlan(input.store, input.onPlanChanged).catch(
          () => undefined
        );
        throw new CourseAgentRuntimeError(
          "COURSE_AGENT_STEP_EXECUTION_FAILED",
          "Canonical course tool step failed or has an unknown outcome.",
          { cause: error }
        );
      } finally {
        if (lease) {
          await input.store
            .releaseLease({
              lease,
              ownerInstanceId,
              now: clock().toISOString()
            })
            .catch(() => undefined);
        }
      }
      if (deferredAutoAction) {
        pendingAction = null;
        const execution = await input.autoActionExecutor!({
          pendingAction: deferredAutoAction
        });
        await reportPlan(input.store, input.onPlanChanged);
        const verified = execution.status === "succeeded";
        if (
          verified &&
          (!execution.stageVerificationRef ||
            execution.safeModelProjection === undefined)
        ) {
          throw new CourseAgentRuntimeError(
            "COURSE_AGENT_AUTO_ACTION_RESULT_INVALID",
            "Verified automatic STAGE omitted its exact safe tool projection."
          );
        }
        return Object.freeze({
          model: verified
            ? execution.safeModelProjection!
            : Object.freeze({
                status: execution.status,
                actionRef: execution.actionRef,
                ...(execution.recoveryActionRef
                  ? { recoveryActionRef: execution.recoveryActionRef }
                  : {}),
                executionPolicyMode: "auto_reversible",
                operationBoundary: deferredAutoAction.operationBoundary
              }),
          safeSummary: execution.safeSummary,
          containsForumText: false,
          containsIdentity: false,
          containsSecrets: false
        });
      }
      throw new CourseAgentRuntimeError(
        "COURSE_AGENT_STEP_EXECUTION_FAILED",
        "Canonical course tool step did not produce a terminal projection."
      );
    }
  });
}

/**
 * Persists the safe objective and canonical plan, then builds the executor
 * over the same database ledger. Re-entering setup for the same run reuses
 * the existing matching plan instead of silently creating a new revision.
 */
export async function prepareCourseAgentRuntime(input: {
  run: Pick<WorkbenchRunSnapshot, "id" | "lineage" | "context" | "createdAt">;
  goalCode: CourseAgentGoalCode;
  intent: CourseAgentExecutionIntent;
  registry: CourseToolRegistry;
  verifierRegistry: CourseToolVerifierRegistry;
  db?: WorkbenchDb;
  grantAuthority?: ScopedCourseToolGrantAuthority;
  actionCoordinator?: CourseAgentActionCoordinator;
  actionPolicyMode?: CourseAgentActionPolicyMode;
  autoActionExecutor?: CourseAgentAutoActionExecutor;
  onPlanChanged?: CourseAgentPlanChanged;
  onToolOutcome?: CourseAgentToolOutcomeListener;
  resolveCourseScope?: CourseAgentCourseScopeResolver;
  recovery?: CourseAgentRuntimeRecovery;
  mvpPlan?: CourseAgentMvpPlanSelection;
}): Promise<PreparedCourseAgentRuntime> {
  const db = input.db ?? defaultPrisma;
  const recovery = validateRuntimeRecovery(input.recovery);
  input.registry.seal();
  input.verifierRegistry.seal();
  const registryManifest = input.registry.manifest();
  if (
    (input.goalCode === "open_course_task") !== Boolean(input.mvpPlan) ||
    (recovery && input.mvpPlan)
  ) {
    throw new CourseAgentRuntimeError(
      "COURSE_AGENT_MVP_PLAN_REQUIRED",
      "Open course goals require exactly one validated MVP plan."
    );
  }
  const objectiveInput = classifyCourseAgentObjective({
    run: input.run,
    goalCode: input.goalCode,
    intent: input.intent,
    createdAt: input.run.createdAt
  });
  const objective = await createSafeTaskObjective(db, objectiveInput);
  const expectedPlan = recovery
    ? compileCourseRecoveryPlan({
        run: input.run,
        objectiveHash: objective.objectiveHash,
        mode: recovery.mode,
        sourceCheckpointRef: recovery.sourceCheckpointRef,
        sourceCheckpointHash: recovery.sourceCheckpointHash,
        registryManifest,
        createdAt: input.run.createdAt
      })
    : input.mvpPlan
      ? compileCourseAgentMvpPlan({
          run: input.run,
          objectiveHash: objective.objectiveHash,
          selection: input.mvpPlan,
          intent: input.intent,
          registryManifest,
          createdAt: input.run.createdAt
        })
      : compileCourseEvidencePlan({
        run: input.run,
        objectiveHash: objective.objectiveHash,
        goalCode: input.goalCode,
        intent: input.intent,
        registryManifest,
        createdAt: input.run.createdAt
      });
  const taskId = workbenchTaskId(input.run);
  const existingPlan = await loadCurrentCanonicalPlan(db, {
    taskId,
    runId: input.run.id
  });
  const plan = existingPlan ?? (await createPlanRevision(db, expectedPlan));
  assertPlanMatchesExpected(plan, expectedPlan);

  const store: CourseAgentTransportStore = {
    loadPlan: () =>
      loadCurrentCanonicalPlan(db, { taskId, runId: input.run.id }),
    transition: async (transition) => {
      await transitionPlanStep(db, {
        taskId,
        runId: input.run.id,
        ...transition
      });
    },
    completeBranch: async (branch) => {
      await completePlanBranch(db, {
        taskId,
        runId: input.run.id,
        ...branch
      });
    },
    claimLease: (leaseInput) =>
      claimExecutionLease(db, {
        taskId,
        runId: input.run.id,
        stepId: leaseInput.stepId,
        ownerInstanceId: leaseInput.ownerInstanceId,
        ttlMs: leaseInput.ttlMs,
        now: leaseInput.now
      }),
    releaseLease: async (releaseInput) => {
      await releaseExecutionLease(db, {
        leaseId: releaseInput.lease.id,
        ownerInstanceId: releaseInput.ownerInstanceId,
        generation: releaseInput.lease.generation,
        fencingToken: releaseInput.lease.fencingToken,
        now: releaseInput.now
      });
    }
  };
  const executor = new CourseToolExecutor({
    registry: input.registry,
    verifierRegistry: input.verifierRegistry,
    policyGateway: new CourseToolPolicyGateway({
      grantAuthority: input.grantAuthority,
      irreversibleExternalEnabled: false
    }),
    sink: new DurableCourseToolExecutionSink(db)
  });
  const courseAlias = input.run.context?.courseAlias;
  if (!courseAlias) {
    throw new CourseAgentRuntimeError(
      "COURSE_AGENT_COURSE_SCOPE_REQUIRED",
      "Prepared course agent runtime requires a course-scoped context."
    );
  }
  const courseScope = input.resolveCourseScope
    ? await input.resolveCourseScope(courseAlias)
    : await loadCourseManifest(courseAlias).then((manifest) =>
        Object.freeze({
          courseId: manifest.courseId,
          alias: manifest.alias,
          manifestHash: manifest.manifestHash
        })
      );
  if (
    courseScope.alias !== courseAlias ||
    !courseScope.courseId ||
    !courseScope.manifestHash
  ) {
    throw new CourseAgentRuntimeError(
      "COURSE_AGENT_COURSE_SCOPE_INVALID",
      "Resolved course scope does not match the run context or exact manifest."
    );
  }
  const transport = createCourseAgentTransport({
    runId: input.run.id,
    taskId,
    intent: input.intent,
    courseScope,
    manifest: registryManifest,
    plan,
    executor,
    store,
    actionCoordinator: input.actionCoordinator,
    actionPolicyMode: input.actionPolicyMode,
    autoActionExecutor: input.autoActionExecutor,
    onPlanChanged: input.onPlanChanged,
    onToolOutcome: input.onToolOutcome,
    causationId: recovery?.sourceCheckpointRef
  });
  if (input.onPlanChanged) {
    await Promise.resolve(input.onPlanChanged(plan)).catch(() => undefined);
  }
  return Object.freeze({
    schemaVersion: COURSE_AGENT_RUNTIME_SCHEMA_VERSION,
    actionPolicyMode: input.actionPolicyMode ?? "confirm_stage",
    taskId,
    objectiveHash: objective.objectiveHash,
    plan,
    registryManifest,
    transport
  });
}
