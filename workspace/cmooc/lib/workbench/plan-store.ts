import { randomUUID } from "node:crypto";
import {
  Prisma,
  type WorkbenchPlanRevisionRecord,
  type WorkbenchPlanStepRecord
} from "@prisma/client";
import {
  assertOpaqueId,
  assertSafeSummary,
  assertSha256,
  assertTaskRunScope,
  assertToolName,
  assertVersion,
  normalizeDate,
  serializeSafeDurableValue,
  withWorkbenchTransaction,
  WorkbenchDurableLedgerError,
  type SafeJsonValue,
  type WorkbenchCapabilityLevel,
  type WorkbenchDb,
  type WorkbenchEffectClass
} from "./durable-ledger";

export const WORKBENCH_CANONICAL_PLAN_SCHEMA_VERSION =
  "cmooc.workbench.canonical-plan.v1" as const;

export type CanonicalPlanStepInput = {
  id: string;
  ordinal: number;
  toolName: string;
  toolVersion: string;
  dependencyIds: readonly string[];
  inputRefs: readonly SafeJsonValue[];
  preconditions: readonly SafeJsonValue[];
  postconditions: readonly SafeJsonValue[];
  effectClass: WorkbenchEffectClass;
  requiredCapability: WorkbenchCapabilityLevel;
  acceptance: SafeJsonValue;
  replanPolicy: SafeJsonValue;
  safeSummary: string;
};

export type CreatePlanRevisionInput = {
  id?: string;
  taskId: string;
  runId: string;
  revision?: number;
  objectiveHash: string;
  compilerVersion: string;
  proposalHash?: string | null;
  safeSummary: string;
  steps: readonly CanonicalPlanStepInput[];
  createdAt?: Date | string;
};

export type CanonicalPlanRevision = WorkbenchPlanRevisionRecord & {
  steps: Array<{
    id: string;
    planRevisionId: string;
    ordinal: number;
    status: string;
    toolName: string;
    toolVersion: string;
    dependencyIdsJson: string;
    inputRefsJson: string;
    preconditionsJson: string;
    postconditionsJson: string;
    effectClass: string;
    requiredCapability: string;
    acceptanceJson: string;
    replanPolicyJson: string;
    safeSummary: string;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
  }>;
};

export type CanonicalPlanStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "blocked"
  | "waiting_for_browser"
  | "waiting_for_approval"
  | "waiting_for_reconcile"
  | "skipped";

export type TransitionPlanStepInput = {
  taskId: string;
  runId: string;
  stepId: string;
  from: CanonicalPlanStepStatus;
  to: CanonicalPlanStepStatus;
  at?: Date | string;
};

export type CompletePlanBranchInput = {
  taskId: string;
  runId: string;
  stepId: string;
  at?: Date | string;
};

export type SkipWaitingPlanBranchInput = CompletePlanBranchInput & {
  from: "waiting_for_approval" | "waiting_for_browser";
};

type NormalizedStep = {
  id: string;
  ordinal: number;
  status: "pending";
  toolName: string;
  toolVersion: string;
  dependencyIdsJson: string;
  inputRefsJson: string;
  preconditionsJson: string;
  postconditionsJson: string;
  effectClass: WorkbenchEffectClass;
  requiredCapability: WorkbenchCapabilityLevel;
  acceptanceJson: string;
  replanPolicyJson: string;
  safeSummary: string;
  createdAt: Date;
};

function planInputError(message: string): never {
  throw new WorkbenchDurableLedgerError(
    "WORKBENCH_CANONICAL_PLAN_INVALID",
    message
  );
}

export function isPlanStepTransitionAllowed(
  from: CanonicalPlanStepStatus,
  to: CanonicalPlanStepStatus
): boolean {
  return (
    (from === "pending" && to === "running") ||
    (from === "pending" && to === "skipped") ||
    (from === "running" &&
      (to === "completed" ||
        to === "blocked" ||
        to === "waiting_for_browser" ||
        to === "waiting_for_approval" ||
        to === "waiting_for_reconcile")) ||
    ((from === "blocked" ||
      from === "waiting_for_browser" ||
      from === "waiting_for_approval" ||
      from === "waiting_for_reconcile") &&
      to === "pending")
  );
}

function assertCapability(value: WorkbenchCapabilityLevel): void {
  if (
    ![
      "L0_READ",
      "L1_ARTIFACT",
      "L2_REVERSIBLE",
      "L3_EXTERNAL_STAGE",
      "L4_IRREVERSIBLE"
    ].includes(value)
  ) {
    planInputError("canonical step capability 无效。");
  }
}

function assertEffect(value: WorkbenchEffectClass): void {
  if (
    ![
      "pure",
      "read",
      "local_write",
      "reversible_write",
      "external_stage",
      "irreversible_external"
    ].includes(value)
  ) {
    planInputError("canonical step effectClass 无效。");
  }
}

function assertStructuredArray(
  value: readonly SafeJsonValue[],
  path: string,
  allowEmpty: boolean
): string {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    planInputError(`${path} 必须是明确的结构化数组。`);
  }
  return serializeSafeDurableValue(value, path);
}

function assertStructuredObject(value: SafeJsonValue, path: string): string {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    planInputError(`${path} 必须是明确的结构化对象。`);
  }
  return serializeSafeDurableValue(value, path);
}

function normalizeSteps(
  steps: readonly CanonicalPlanStepInput[],
  createdAt: Date
): NormalizedStep[] {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 64) {
    planInputError("canonical plan 必须包含 1 到 64 个步骤。");
  }
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  const normalized = steps.map((step, index): NormalizedStep => {
    if (!step || typeof step !== "object") planInputError(`steps[${index}] 无效。`);
    const id = assertOpaqueId(step.id, `steps[${index}].id`);
    if (ids.has(id)) planInputError("canonical plan step id 不得重复。");
    ids.add(id);
    if (!Number.isSafeInteger(step.ordinal) || step.ordinal < 1) {
      planInputError(`steps[${index}].ordinal 无效。`);
    }
    if (ordinals.has(step.ordinal)) planInputError("canonical plan ordinal 不得重复。");
    ordinals.add(step.ordinal);
    assertCapability(step.requiredCapability);
    assertEffect(step.effectClass);
    return {
      id,
      ordinal: step.ordinal,
      status: "pending",
      toolName: assertToolName(step.toolName, `steps[${index}].toolName`),
      toolVersion: assertVersion(
        step.toolVersion,
        `steps[${index}].toolVersion`
      ),
      dependencyIdsJson: "",
      inputRefsJson: assertStructuredArray(
        step.inputRefs,
        `steps[${index}].inputRefs`,
        false
      ),
      preconditionsJson: assertStructuredArray(
        step.preconditions,
        `steps[${index}].preconditions`,
        true
      ),
      postconditionsJson: assertStructuredArray(
        step.postconditions,
        `steps[${index}].postconditions`,
        false
      ),
      effectClass: step.effectClass,
      requiredCapability: step.requiredCapability,
      acceptanceJson: assertStructuredObject(
        step.acceptance,
        `steps[${index}].acceptance`
      ),
      replanPolicyJson: assertStructuredObject(
        step.replanPolicy,
        `steps[${index}].replanPolicy`
      ),
      safeSummary: assertSafeSummary(
        step.safeSummary,
        `steps[${index}].safeSummary`
      ),
      createdAt
    };
  });

  normalized.sort((left, right) => left.ordinal - right.ordinal);
  normalized.forEach((step, index) => {
    if (step.ordinal !== index + 1) {
      planInputError("canonical plan ordinal 必须从 1 开始连续递增。");
    }
  });
  const ordinalById = new Map(normalized.map((step) => [step.id, step.ordinal]));
  for (const [index, step] of normalized.entries()) {
    const source = steps.find((candidate) => candidate.id === step.id)!;
    if (!Array.isArray(source.dependencyIds)) {
      planInputError(`steps[${index}].dependencyIds 必须是数组。`);
    }
    const dependencies = source.dependencyIds.map(
      (dependencyId: string, dependencyIndex: number) =>
        assertOpaqueId(
          dependencyId,
          `steps[${index}].dependencyIds[${dependencyIndex}]`
        )
    );
    if (new Set(dependencies).size !== dependencies.length) {
      planInputError("canonical step dependency 不得重复。");
    }
    for (const dependencyId of dependencies) {
      const dependencyOrdinal = ordinalById.get(dependencyId);
      if (!dependencyOrdinal || dependencyOrdinal >= step.ordinal) {
        planInputError("canonical step 只能依赖同一 revision 中更早的步骤。");
      }
    }
    step.dependencyIdsJson = serializeSafeDurableValue(
      dependencies,
      `steps[${index}].dependencyIds`
    );
  }
  return normalized;
}

function sameStep(
  existing: CanonicalPlanRevision["steps"][number],
  expected: NormalizedStep
): boolean {
  return (
    existing.id === expected.id &&
    existing.ordinal === expected.ordinal &&
    existing.status === expected.status &&
    existing.toolName === expected.toolName &&
    existing.toolVersion === expected.toolVersion &&
    existing.dependencyIdsJson === expected.dependencyIdsJson &&
    existing.inputRefsJson === expected.inputRefsJson &&
    existing.preconditionsJson === expected.preconditionsJson &&
    existing.postconditionsJson === expected.postconditionsJson &&
    existing.effectClass === expected.effectClass &&
    existing.requiredCapability === expected.requiredCapability &&
    existing.acceptanceJson === expected.acceptanceJson &&
    existing.replanPolicyJson === expected.replanPolicyJson &&
    existing.safeSummary === expected.safeSummary
  );
}

async function createPlanRevisionOnce(
  db: WorkbenchDb,
  input: CreatePlanRevisionInput
): Promise<CanonicalPlanRevision> {
  const id = assertOpaqueId(input.id ?? randomUUID(), "id");
  const taskId = assertOpaqueId(input.taskId, "taskId");
  const runId = assertOpaqueId(input.runId, "runId");
  if (
    input.revision !== undefined &&
    (!Number.isSafeInteger(input.revision) || input.revision < 1)
  ) {
    planInputError("revision 必须是正整数。");
  }
  const objectiveHash = assertSha256(input.objectiveHash, "objectiveHash");
  const compilerVersion = assertVersion(input.compilerVersion, "compilerVersion");
  const proposalHash = input.proposalHash
    ? assertSha256(input.proposalHash, "proposalHash")
    : null;
  const safeSummary = assertSafeSummary(input.safeSummary, "safeSummary");
  const createdAt = normalizeDate(input.createdAt ?? new Date(), "createdAt");
  const steps = normalizeSteps(input.steps, createdAt);

  return withWorkbenchTransaction(db, async (transaction) => {
    await assertTaskRunScope(transaction, { taskId, runId });
    const objective = await transaction.workbenchSafeTaskObjective.findUnique({
      where: { taskId },
      select: { objectiveHash: true, expiresAt: true }
    });
    if (!objective || objective.objectiveHash !== objectiveHash) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_CANONICAL_PLAN_OBJECTIVE_MISMATCH",
        "canonical plan 未绑定当前任务的安全目标。"
      );
    }
    if (objective.expiresAt && objective.expiresAt <= createdAt) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_CANONICAL_PLAN_OBJECTIVE_EXPIRED",
        "安全目标已过期，不能编译新的 canonical plan。"
      );
    }
    const latest = await transaction.workbenchPlanRevisionRecord.findFirst({
      where: { taskId },
      orderBy: { revision: "desc" },
      select: { revision: true }
    });
    const revision = input.revision ?? (latest?.revision ?? 0) + 1;
    const existing = await transaction.workbenchPlanRevisionRecord.findUnique({
      where: { taskId_revision: { taskId, revision } },
      include: { steps: { orderBy: { ordinal: "asc" } } }
    });
    if (existing) {
      const same =
        existing.runId === runId &&
        existing.objectiveHash === objectiveHash &&
        existing.source === "server_compiler" &&
        existing.compilerVersion === compilerVersion &&
        existing.proposalHash === proposalHash &&
        existing.safeSummary === safeSummary &&
        existing.steps.length === steps.length &&
        existing.steps.every((step, index) => sameStep(step, steps[index]));
      if (same) return existing;
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_CANONICAL_PLAN_IMMUTABLE",
        "该 plan revision 已绑定另一份不可变 canonical plan。"
      );
    }
    return transaction.workbenchPlanRevisionRecord.create({
      data: {
        id,
        taskId,
        runId,
        revision,
        objectiveHash,
        source: "server_compiler",
        compilerVersion,
        proposalHash,
        safeSummary,
        createdAt,
        steps: { create: steps }
      },
      include: { steps: { orderBy: { ordinal: "asc" } } }
    });
  });
}

export async function createPlanRevision(
  db: WorkbenchDb,
  input: CreatePlanRevisionInput
): Promise<CanonicalPlanRevision> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await createPlanRevisionOnce(db, input);
    } catch (error) {
      const retryable =
        input.revision === undefined &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002";
      if (!retryable || attempt === 2) throw error;
    }
  }
  planInputError("无法分配 canonical plan revision。");
}

export async function loadCurrentCanonicalPlan(
  db: WorkbenchDb,
  input: { taskId: string; runId: string }
): Promise<CanonicalPlanRevision | null> {
  const taskId = assertOpaqueId(input.taskId, "taskId");
  const runId = assertOpaqueId(input.runId, "runId");
  await assertTaskRunScope(db, { taskId, runId });
  return db.workbenchPlanRevisionRecord.findFirst({
    where: { taskId, runId, source: "server_compiler" },
    orderBy: { revision: "desc" },
    include: { steps: { orderBy: { ordinal: "asc" } } }
  });
}

export async function transitionPlanStep(
  db: WorkbenchDb,
  input: TransitionPlanStepInput
): Promise<WorkbenchPlanStepRecord> {
  const taskId = assertOpaqueId(input.taskId, "taskId");
  const runId = assertOpaqueId(input.runId, "runId");
  const stepId = assertOpaqueId(input.stepId, "stepId");
  if (!isPlanStepTransitionAllowed(input.from, input.to)) {
    throw new WorkbenchDurableLedgerError(
      "WORKBENCH_PLAN_STEP_TRANSITION_INVALID",
      `canonical step 不允许 ${input.from} → ${input.to}。`
    );
  }
  const at = normalizeDate(input.at ?? new Date(), "at");

  return withWorkbenchTransaction(db, async (transaction) => {
    await assertTaskRunScope(transaction, { taskId, runId });
    const currentPlan = await transaction.workbenchPlanRevisionRecord.findFirst({
      where: { taskId, runId, source: "server_compiler" },
      orderBy: { revision: "desc" },
      select: { id: true }
    });
    if (!currentPlan) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_CANONICAL_PLAN_NOT_FOUND",
        "找不到当前 canonical plan。"
      );
    }
    const step = await transaction.workbenchPlanStepRecord.findUnique({
      where: { id: stepId },
      select: {
        id: true,
        planRevisionId: true,
        status: true,
        dependencyIdsJson: true,
        startedAt: true,
        completedAt: true,
        planRevision: { select: { taskId: true, runId: true } }
      }
    });
    if (
      !step ||
      step.planRevision.taskId !== taskId ||
      step.planRevision.runId !== runId ||
      step.planRevisionId !== currentPlan.id
    ) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_PLAN_STEP_SCOPE_MISMATCH",
        "step 不属于当前 task/run/revision。"
      );
    }
    if (step.status !== input.from) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_PLAN_STEP_CAS_CONFLICT",
        "step 状态已被其他执行者更新。"
      );
    }
    if (step.completedAt) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_PLAN_STEP_TERMINAL",
        "已完成的 canonical step 不可回退。"
      );
    }
    if (input.from === "pending" && input.to === "running") {
      const parsed = JSON.parse(step.dependencyIdsJson) as unknown;
      if (
        !Array.isArray(parsed) ||
        parsed.some((dependencyId) => typeof dependencyId !== "string")
      ) {
        throw new WorkbenchDurableLedgerError(
          "WORKBENCH_CANONICAL_PLAN_CORRUPT",
          "canonical step dependency 投影损坏。"
        );
      }
      const dependencyIds = parsed as string[];
      if (dependencyIds.length > 0) {
        const dependencies = await transaction.workbenchPlanStepRecord.findMany({
          where: {
            id: { in: dependencyIds },
            planRevisionId: currentPlan.id
          },
          select: { id: true, status: true }
        });
        if (
          dependencies.length !== dependencyIds.length ||
          dependencies.some((dependency) => dependency.status !== "completed")
        ) {
          throw new WorkbenchDurableLedgerError(
            "WORKBENCH_PLAN_STEP_DEPENDENCY_INCOMPLETE",
            "canonical step 的依赖尚未全部完成。"
          );
        }
      }
    }
    const data =
      input.to === "running"
        ? { status: input.to, startedAt: step.startedAt ?? at }
        : input.to === "completed" || input.to === "skipped"
          ? { status: input.to, completedAt: at }
          : { status: input.to };
    const transitioned = await transaction.workbenchPlanStepRecord.updateMany({
      where: {
        id: stepId,
        planRevisionId: currentPlan.id,
        status: input.from,
        completedAt: null
      },
      data
    });
    if (transitioned.count !== 1) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_PLAN_STEP_CAS_CONFLICT",
        "step 状态已被其他执行者更新。"
      );
    }
    return transaction.workbenchPlanStepRecord.findUniqueOrThrow({
      where: { id: stepId }
    });
  });
}

/**
 * Completes one running branch decision and marks every still-pending
 * downstream step as not applicable in the same transaction. This is used
 * only when a verified tool result establishes that the plan has no safe
 * action to continue with.
 */
export async function completePlanBranch(
  db: WorkbenchDb,
  input: CompletePlanBranchInput
): Promise<WorkbenchPlanStepRecord> {
  const taskId = assertOpaqueId(input.taskId, "taskId");
  const runId = assertOpaqueId(input.runId, "runId");
  const stepId = assertOpaqueId(input.stepId, "stepId");
  const at = normalizeDate(input.at ?? new Date(), "at");

  return withWorkbenchTransaction(db, async (transaction) => {
    await assertTaskRunScope(transaction, { taskId, runId });
    const currentPlan = await transaction.workbenchPlanRevisionRecord.findFirst({
      where: { taskId, runId, source: "server_compiler" },
      orderBy: { revision: "desc" },
      select: { id: true }
    });
    if (!currentPlan) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_CANONICAL_PLAN_NOT_FOUND",
        "找不到当前 canonical plan。"
      );
    }
    const step = await transaction.workbenchPlanStepRecord.findUnique({
      where: { id: stepId },
      select: {
        id: true,
        ordinal: true,
        planRevisionId: true,
        status: true,
        completedAt: true,
        planRevision: { select: { taskId: true, runId: true } }
      }
    });
    if (
      !step ||
      step.planRevision.taskId !== taskId ||
      step.planRevision.runId !== runId ||
      step.planRevisionId !== currentPlan.id
    ) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_PLAN_STEP_SCOPE_MISMATCH",
        "step 不属于当前 task/run/revision。"
      );
    }
    if (step.status !== "running" || step.completedAt) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_PLAN_STEP_CAS_CONFLICT",
        "分支决策步骤已被其他执行者更新。"
      );
    }
    const completed = await transaction.workbenchPlanStepRecord.updateMany({
      where: {
        id: step.id,
        planRevisionId: currentPlan.id,
        status: "running",
        completedAt: null
      },
      data: { status: "completed", completedAt: at }
    });
    if (completed.count !== 1) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_PLAN_STEP_CAS_CONFLICT",
        "分支决策步骤已被其他执行者更新。"
      );
    }
    await transaction.workbenchPlanStepRecord.updateMany({
      where: {
        planRevisionId: currentPlan.id,
        ordinal: { gt: step.ordinal },
        status: "pending",
        completedAt: null
      },
      data: { status: "skipped", completedAt: at }
    });
    return transaction.workbenchPlanStepRecord.findUniqueOrThrow({
      where: { id: step.id }
    });
  });
}

/** Safely closes a user-declined or unavailable waiting branch. */
export async function skipWaitingPlanBranch(
  db: WorkbenchDb,
  input: SkipWaitingPlanBranchInput
): Promise<WorkbenchPlanStepRecord> {
  const taskId = assertOpaqueId(input.taskId, "taskId");
  const runId = assertOpaqueId(input.runId, "runId");
  const stepId = assertOpaqueId(input.stepId, "stepId");
  const at = normalizeDate(input.at ?? new Date(), "at");
  return withWorkbenchTransaction(db, async (transaction) => {
    await assertTaskRunScope(transaction, { taskId, runId });
    const plan = await transaction.workbenchPlanRevisionRecord.findFirst({
      where: { taskId, runId, source: "server_compiler" },
      orderBy: { revision: "desc" },
      select: { id: true }
    });
    if (!plan) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_CANONICAL_PLAN_NOT_FOUND",
        "找不到当前 canonical plan。"
      );
    }
    const step = await transaction.workbenchPlanStepRecord.findFirst({
      where: {
        id: stepId,
        planRevisionId: plan.id,
        status: input.from,
        completedAt: null
      },
      select: { id: true, ordinal: true }
    });
    if (!step) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_PLAN_STEP_CAS_CONFLICT",
        "等待中的分支步骤已被其他执行者更新。"
      );
    }
    const skipped = await transaction.workbenchPlanStepRecord.updateMany({
      where: {
        id: step.id,
        planRevisionId: plan.id,
        status: input.from,
        completedAt: null
      },
      data: { status: "skipped", completedAt: at }
    });
    if (skipped.count !== 1) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_PLAN_STEP_CAS_CONFLICT",
        "等待中的分支步骤已被其他执行者更新。"
      );
    }
    await transaction.workbenchPlanStepRecord.updateMany({
      where: {
        planRevisionId: plan.id,
        ordinal: { gt: step.ordinal },
        status: "pending",
        completedAt: null
      },
      data: { status: "skipped", completedAt: at }
    });
    return transaction.workbenchPlanStepRecord.findUniqueOrThrow({
      where: { id: step.id }
    });
  });
}
