import { randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type WorkbenchCourseToolActionRecord,
  type WorkbenchCourseToolGrantRecord
} from "@prisma/client";
import { canonicalJson } from "@/lib/facilitation-protocol/canonical-hash";
import {
  COURSE_TOOL_GRANT_SCHEMA_VERSION,
  assertCourseToolJsonValue,
  assertNoServerControlledFields,
  hashCourseToolValue,
  isCourseToolName,
  isCourseToolVersion,
  isSafeIdentifier,
  isSha256,
  type CourseToolBusinessInput
} from "@/lib/course-tools/contracts";
import type { CourseToolGrantBinding } from "@/lib/course-tools/policy-gateway";
import {
  assertOpaqueId,
  assertSafeDurableValue,
  assertSafeSummary,
  serializeSafeDurableValue,
  type WorkbenchDb
} from "@/lib/workbench/durable-ledger";

export const WORKBENCH_COURSE_TOOL_ACTION_SCHEMA_VERSION =
  "cmooc.workbench.course-tool-action.v1" as const;
export const WORKBENCH_COURSE_TOOL_ACTION_BINDING_DOMAIN =
  "workbench-course-tool-action-binding.v1" as const;
export const WORKBENCH_COURSE_TOOL_ACTION_APPROVAL_DOMAIN =
  "workbench-course-tool-action-approval.v1" as const;

export const COURSE_TOOL_ACTION_STATUSES = [
  "prepared",
  "awaiting_approval",
  "approved",
  "executing",
  "succeeded",
  "failed_before_write",
  "unknown",
  "reconciling",
  "reconciled",
  "manual_review"
] as const;

export const COURSE_TOOL_GRANT_STATUSES = [
  "available",
  "consumed",
  "expired",
  "revoked"
] as const;

export type CourseToolActionStatus =
  (typeof COURSE_TOOL_ACTION_STATUSES)[number];
export type CourseToolGrantStatus =
  (typeof COURSE_TOOL_GRANT_STATUSES)[number];

export const WORKBENCH_COURSE_ACTION_TOOL_NAMES = [
  "platform.editor.stage_verify_clear",
  "platform.editor.reconcile_stage"
] as const;

export type WorkbenchCourseActionToolName =
  (typeof WORKBENCH_COURSE_ACTION_TOOL_NAMES)[number];

export interface ServerPreparedCourseToolAction {
  readonly actionRef?: string;
  readonly grantRef?: string;
  readonly binding: CourseToolGrantBinding;
  readonly businessInput: CourseToolBusinessInput;
  readonly safeSummary: string;
  readonly validFrom: Date | string;
  readonly expiresAt: Date | string;
  readonly preparedAt?: Date | string;
  /** Recovery actions bind both fields to the exact ambiguous STAGE action. */
  readonly parentActionRef?: string;
  readonly recoveryOfActionRef?: string;
  readonly oneShot: true;
  readonly realPublishEnabled: false;
}

export interface PreparedCourseToolActionProjection {
  readonly actionRef: string;
  readonly bindingHash: string;
  readonly approvalHash: string;
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly status: CourseToolActionStatus;
  readonly safeSummary: string;
  readonly realPublishEnabled: false;
}

export interface CourseToolGrantClaimStoreResult {
  readonly status:
    | "claimed"
    | "not_found"
    | "scope_mismatch"
    | "expired"
    | "consumed"
    | "revoked";
  readonly grant?: WorkbenchCourseToolGrantRecord;
}

export class CourseToolActionStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CourseToolActionStoreError";
    this.code = code;
  }
}

const PREPARED_MATERIAL_KEYS = new Set([
  "actionRef",
  "grantRef",
  "binding",
  "businessInput",
  "safeSummary",
  "validFrom",
  "expiresAt",
  "preparedAt",
  "parentActionRef",
  "recoveryOfActionRef",
  "oneShot",
  "realPublishEnabled"
]);

const BINDING_KEYS = new Set([
  "capability",
  "effect",
  "toolName",
  "toolVersion",
  "callId",
  "taskId",
  "runId",
  "planRevisionId",
  "stepId",
  "courseScopeHash",
  "inputHash",
  "idempotencyKeyHash",
  "policyVersion",
  "attempt"
]);

const TERMINAL_ACTION_STATUSES = new Set<CourseToolActionStatus>([
  "succeeded",
  "failed_before_write",
  "reconciled",
  "manual_review"
]);

const ACTION_TRANSITIONS = new Set([
  "prepared->awaiting_approval",
  "prepared->failed_before_write",
  "awaiting_approval->failed_before_write",
  "awaiting_approval->manual_review",
  "approved->failed_before_write",
  "executing->succeeded",
  "executing->failed_before_write",
  "executing->unknown",
  "executing->manual_review",
  "unknown->reconciling",
  "unknown->manual_review",
  "reconciling->reconciled",
  "reconciling->unknown",
  "reconciling->manual_review"
]);

function storeError(code: string, message: string): never {
  throw new CourseToolActionStoreError(code, message);
}

function assertPlainObject(
  value: unknown,
  path: string
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    storeError("COURSE_TOOL_ACTION_MATERIAL_INVALID", `${path} 必须是普通对象。`);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      storeError(
        "COURSE_TOOL_ACTION_MATERIAL_UNKNOWN_FIELD",
        `${path}.${key} 不是服务器 prepared material 的允许字段。`
      );
    }
  }
}

function normalizeDate(value: Date | string, path: string): Date {
  const normalized = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(normalized.getTime())) {
    storeError("COURSE_TOOL_ACTION_TIME_INVALID", `${path} 不是有效时间。`);
  }
  return normalized;
}

function assertHash(value: unknown, path: string): string {
  if (typeof value !== "string" || !isSha256(value)) {
    storeError("COURSE_TOOL_ACTION_BINDING_INVALID", `${path} 必须是小写 SHA-256。`);
  }
  return value;
}

function assertIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !isSafeIdentifier(value)) {
    storeError("COURSE_TOOL_ACTION_BINDING_INVALID", `${path} 不是安全标识。`);
  }
  return value;
}

function assertStageBinding(
  value: unknown
): asserts value is CourseToolGrantBinding {
  assertPlainObject(value, "binding");
  assertOnlyKeys(value, BINDING_KEYS, "binding");
  if (
    value.capability !== "L3_EXTERNAL_STAGE" ||
    value.effect !== "external_stage"
  ) {
    storeError(
      "COURSE_TOOL_ACTION_STAGE_ONLY",
      "持久 action/grant authority 只接受 L3_EXTERNAL_STAGE + external_stage。"
    );
  }
  if (typeof value.toolName !== "string" || !isCourseToolName(value.toolName)) {
    storeError("COURSE_TOOL_ACTION_BINDING_INVALID", "binding.toolName 无效。");
  }
  if (
    !WORKBENCH_COURSE_ACTION_TOOL_NAMES.includes(
      value.toolName as WorkbenchCourseActionToolName
    )
  ) {
    storeError(
      "COURSE_TOOL_ACTION_STAGE_ONLY",
      "持久 action/grant authority 只接受受信 STAGE 或其所有权核对工具。"
    );
  }
  if (
    typeof value.toolVersion !== "string" ||
    !isCourseToolVersion(value.toolVersion) ||
    value.toolVersion !== "1"
  ) {
    storeError("COURSE_TOOL_ACTION_BINDING_INVALID", "binding.toolVersion 无效。");
  }
  for (const key of [
    "callId",
    "taskId",
    "runId",
    "planRevisionId",
    "stepId",
    "policyVersion"
  ] as const) {
    assertIdentifier(value[key], `binding.${key}`);
  }
  for (const key of [
    "courseScopeHash",
    "inputHash",
    "idempotencyKeyHash"
  ] as const) {
    assertHash(value[key], `binding.${key}`);
  }
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1) {
    storeError("COURSE_TOOL_ACTION_BINDING_INVALID", "binding.attempt 无效。");
  }
}

function normalizePreparedMaterial(
  material: ServerPreparedCourseToolAction
): {
  actionRef: string;
  grantRef: string;
  binding: CourseToolGrantBinding;
  businessInputJson: string;
  safeSummary: string;
  bindingHash: string;
  approvalHash: string;
  validFrom: Date;
  expiresAt: Date;
  preparedAt: Date;
  parentActionRef: string | null;
  recoveryOfActionRef: string | null;
} {
  assertPlainObject(material, "material");
  assertOnlyKeys(material, PREPARED_MATERIAL_KEYS, "material");
  if (material.oneShot !== true || material.realPublishEnabled !== false) {
    storeError(
      "COURSE_TOOL_ACTION_PUBLISH_FORBIDDEN",
      "action 必须为 one-shot 且 realPublishEnabled=false。"
    );
  }
  assertStageBinding(material.binding);
  assertPlainObject(material.businessInput, "businessInput");
  assertCourseToolJsonValue(material.businessInput, "course tool business input");
  assertNoServerControlledFields(material.businessInput);
  assertSafeDurableValue(material.businessInput, "businessInput");
  serializeSafeDurableValue(material.businessInput, "businessInput");
  const businessInputJson = canonicalJson(material.businessInput);
  const expectedInputHash = hashCourseToolValue(
    `input:${material.binding.toolName}@${material.binding.toolVersion}`,
    material.businessInput
  );
  if (expectedInputHash !== material.binding.inputHash) {
    storeError(
      "COURSE_TOOL_ACTION_INPUT_HASH_MISMATCH",
      "businessInput 与 binding.inputHash 不一致。"
    );
  }
  const actionRef = assertOpaqueId(
    material.actionRef ?? `action:${randomUUID()}`,
    "actionRef"
  );
  const grantRef = assertOpaqueId(
    material.grantRef ?? `grant:${randomUUID()}`,
    "grantRef"
  );
  const validFrom = normalizeDate(material.validFrom, "validFrom");
  const expiresAt = normalizeDate(material.expiresAt, "expiresAt");
  const preparedAt = normalizeDate(material.preparedAt ?? new Date(), "preparedAt");
  if (validFrom >= expiresAt || preparedAt >= expiresAt) {
    storeError(
      "COURSE_TOOL_ACTION_WINDOW_INVALID",
      "action/grant 有效期必须覆盖 preparedAt，且 validFrom 早于 expiresAt。"
    );
  }
  const safeSummary = assertSafeSummary(material.safeSummary, "safeSummary");
  const parentActionRef = material.parentActionRef
    ? assertOpaqueId(material.parentActionRef, "parentActionRef")
    : null;
  const recoveryOfActionRef = material.recoveryOfActionRef
    ? assertOpaqueId(material.recoveryOfActionRef, "recoveryOfActionRef")
    : null;
  const isRecovery = material.binding.toolName === "platform.editor.reconcile_stage";
  if (
    (isRecovery &&
      (!parentActionRef ||
        !recoveryOfActionRef ||
        parentActionRef !== recoveryOfActionRef)) ||
    (!isRecovery && (parentActionRef || recoveryOfActionRef))
  ) {
    storeError(
      "COURSE_TOOL_ACTION_RECOVERY_LINEAGE_INVALID",
      "reconcile action 必须精确绑定同一个 parent/recoveryOf；普通 STAGE action 不得声明恢复 lineage。"
    );
  }
  const bindingHash = hashCourseToolActionBinding(material.binding);
  const approvalHash = hashCourseToolActionApproval({
    actionRef,
    grantRef,
    bindingHash,
    validFrom,
    expiresAt
  });
  return {
    actionRef,
    grantRef,
    binding: material.binding,
    businessInputJson,
    safeSummary,
    bindingHash,
    approvalHash,
    validFrom,
    expiresAt,
    preparedAt,
    parentActionRef,
    recoveryOfActionRef
  };
}

export function hashCourseToolActionBinding(
  binding: CourseToolGrantBinding
): string {
  assertStageBinding(binding);
  return hashCourseToolValue(WORKBENCH_COURSE_TOOL_ACTION_BINDING_DOMAIN, {
    attempt: binding.attempt,
    callId: binding.callId,
    capability: binding.capability,
    courseScopeHash: binding.courseScopeHash,
    effect: binding.effect,
    idempotencyKeyHash: binding.idempotencyKeyHash,
    inputHash: binding.inputHash,
    planRevisionId: binding.planRevisionId,
    policyVersion: binding.policyVersion,
    runId: binding.runId,
    stepId: binding.stepId,
    taskId: binding.taskId,
    toolName: binding.toolName,
    toolVersion: binding.toolVersion
  });
}

export function hashCourseToolActionApproval(input: {
  readonly actionRef: string;
  readonly grantRef: string;
  readonly bindingHash: string;
  readonly validFrom: Date | string;
  readonly expiresAt: Date | string;
}): string {
  const actionRef = assertOpaqueId(input.actionRef, "actionRef");
  const grantRef = assertOpaqueId(input.grantRef, "grantRef");
  const bindingHash = assertHash(input.bindingHash, "bindingHash");
  const validFrom = normalizeDate(input.validFrom, "validFrom");
  const expiresAt = normalizeDate(input.expiresAt, "expiresAt");
  if (validFrom >= expiresAt) {
    storeError("COURSE_TOOL_ACTION_WINDOW_INVALID", "grant 有效期无效。");
  }
  return hashCourseToolValue(WORKBENCH_COURSE_TOOL_ACTION_APPROVAL_DOMAIN, {
    actionRef,
    bindingHash,
    capability: "L3_EXTERNAL_STAGE",
    effect: "external_stage",
    expiresAt: expiresAt.toISOString(),
    grantRef,
    oneShot: true,
    realPublishEnabled: false,
    validFrom: validFrom.toISOString()
  });
}

export function isCourseToolActionTransitionAllowed(
  from: CourseToolActionStatus,
  to: CourseToolActionStatus
): boolean {
  return ACTION_TRANSITIONS.has(`${from}->${to}`);
}

async function withTransaction<T>(
  db: WorkbenchDb,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  if ("$transaction" in db && typeof db.$transaction === "function") {
    return (db as PrismaClient).$transaction((transaction) => operation(transaction));
  }
  return operation(db as Prisma.TransactionClient);
}

function samePreparedAction(
  existing: WorkbenchCourseToolActionRecord,
  normalized: ReturnType<typeof normalizePreparedMaterial>
): boolean {
  const binding = normalized.binding;
  return (
    existing.id === normalized.actionRef &&
    existing.grantRef === normalized.grantRef &&
    existing.callId === binding.callId &&
    existing.taskId === binding.taskId &&
    existing.runId === binding.runId &&
    existing.planRevisionId === binding.planRevisionId &&
    existing.stepId === binding.stepId &&
    existing.toolName === binding.toolName &&
    existing.toolVersion === binding.toolVersion &&
    existing.capability === binding.capability &&
    existing.effectClass === binding.effect &&
    existing.courseScopeHash === binding.courseScopeHash &&
    existing.inputHash === binding.inputHash &&
    existing.idempotencyKeyHash === binding.idempotencyKeyHash &&
    existing.policyVersion === binding.policyVersion &&
    existing.attempt === binding.attempt &&
    existing.businessInputJson === normalized.businessInputJson &&
    existing.safeSummary === normalized.safeSummary &&
    existing.bindingHash === normalized.bindingHash &&
    existing.approvalHash === normalized.approvalHash &&
    existing.validFrom.getTime() === normalized.validFrom.getTime() &&
    existing.expiresAt.getTime() === normalized.expiresAt.getTime() &&
    existing.parentActionId === normalized.parentActionRef &&
    existing.recoveryOfActionId === normalized.recoveryOfActionRef &&
    existing.oneShot === true &&
    existing.realPublishEnabled === false
  );
}

async function assertPreparedScope(
  transaction: Prisma.TransactionClient,
  normalized: ReturnType<typeof normalizePreparedMaterial>
): Promise<void> {
  const binding = normalized.binding;
  const [run, plan, step, recoveryOf] = await Promise.all([
    transaction.workbenchRunRecord.findUnique({
      where: { id: binding.runId },
      select: { taskId: true }
    }),
    transaction.workbenchPlanRevisionRecord.findUnique({
      where: { id: binding.planRevisionId },
      select: { taskId: true, runId: true }
    }),
    transaction.workbenchPlanStepRecord.findUnique({
      where: { id: binding.stepId },
      select: {
        planRevisionId: true,
        toolName: true,
        toolVersion: true,
        effectClass: true,
        requiredCapability: true
      }
    }),
    normalized.recoveryOfActionRef
      ? transaction.workbenchCourseToolActionRecord.findUnique({
          where: { id: normalized.recoveryOfActionRef }
        })
      : Promise.resolve(null)
  ]);
  if (!run || run.taskId !== binding.taskId) {
    storeError("COURSE_TOOL_ACTION_SCOPE_MISMATCH", "run 与 task 绑定不一致。");
  }
  if (
    !plan ||
    plan.taskId !== binding.taskId ||
    plan.runId !== binding.runId
  ) {
    storeError("COURSE_TOOL_ACTION_SCOPE_MISMATCH", "plan 与 task/run 绑定不一致。");
  }
  const isRecovery = binding.toolName === "platform.editor.reconcile_stage";
  const stepToolMatches = isRecovery
    ? step?.toolName === "platform.editor.stage_verify_clear" &&
      step.toolVersion === "1"
    : step?.toolName === binding.toolName &&
      step.toolVersion === binding.toolVersion;
  if (
    !step ||
    step.planRevisionId !== binding.planRevisionId ||
    !stepToolMatches ||
    step.effectClass !== binding.effect ||
    step.requiredCapability !== binding.capability
  ) {
    storeError("COURSE_TOOL_ACTION_SCOPE_MISMATCH", "step 与 L3 工具绑定不一致。");
  }
  if (!isRecovery) return;
  const parsedInput = JSON.parse(normalized.businessInputJson) as {
    stageTransactionRef?: unknown;
  };
  if (
    !recoveryOf ||
    normalized.parentActionRef !== recoveryOf.id ||
    recoveryOf.taskId !== binding.taskId ||
    recoveryOf.runId !== binding.runId ||
    recoveryOf.planRevisionId !== binding.planRevisionId ||
    recoveryOf.stepId !== binding.stepId ||
    recoveryOf.toolName !== "platform.editor.stage_verify_clear" ||
    recoveryOf.toolVersion !== "1" ||
    recoveryOf.capability !== binding.capability ||
    recoveryOf.effectClass !== binding.effect ||
    recoveryOf.courseScopeHash !== binding.courseScopeHash ||
    recoveryOf.policyVersion !== binding.policyVersion ||
    recoveryOf.status !== "unknown" ||
    !recoveryOf.compensationRef ||
    parsedInput.stageTransactionRef !== recoveryOf.compensationRef
  ) {
    storeError(
      "COURSE_TOOL_ACTION_RECOVERY_SCOPE_MISMATCH",
      "reconcile action 未绑定同一 unknown STAGE、事务引用、课程、计划与策略。"
    );
  }
}

export async function prepareCourseToolAction(
  db: WorkbenchDb,
  material: ServerPreparedCourseToolAction
): Promise<WorkbenchCourseToolActionRecord> {
  const normalized = normalizePreparedMaterial(material);
  return withTransaction(db, async (transaction) => {
    await assertPreparedScope(transaction, normalized);
    const existing = await transaction.workbenchCourseToolActionRecord.findFirst({
      where: {
        OR: [
          { id: normalized.actionRef },
          { callId: normalized.binding.callId },
          { bindingHash: normalized.bindingHash },
          { approvalHash: normalized.approvalHash },
          { grantRef: normalized.grantRef }
        ]
      }
    });
    if (existing) {
      if (samePreparedAction(existing, normalized)) return existing;
      storeError(
        "COURSE_TOOL_ACTION_BINDING_CONFLICT",
        "action、call、binding、approval 或 grant ref 已绑定另一份 prepared material。"
      );
    }
    const binding = normalized.binding;
    return transaction.workbenchCourseToolActionRecord.create({
      data: {
        id: normalized.actionRef,
        schemaVersion: WORKBENCH_COURSE_TOOL_ACTION_SCHEMA_VERSION,
        taskId: binding.taskId,
        runId: binding.runId,
        planRevisionId: binding.planRevisionId,
        stepId: binding.stepId,
        callId: binding.callId,
        toolName: binding.toolName,
        toolVersion: binding.toolVersion,
        capability: binding.capability,
        effectClass: binding.effect,
        courseScopeHash: binding.courseScopeHash,
        inputHash: binding.inputHash,
        idempotencyKeyHash: binding.idempotencyKeyHash,
        policyVersion: binding.policyVersion,
        attempt: binding.attempt,
        businessInputJson: normalized.businessInputJson,
        safeSummary: normalized.safeSummary,
        bindingHash: normalized.bindingHash,
        approvalHash: normalized.approvalHash,
        grantRef: normalized.grantRef,
        validFrom: normalized.validFrom,
        expiresAt: normalized.expiresAt,
        parentActionId: normalized.parentActionRef,
        recoveryOfActionId: normalized.recoveryOfActionRef,
        oneShot: true,
        realPublishEnabled: false,
        status: "prepared",
        statusReasonCode: "server_prepared",
        containsForumText: false,
        containsIdentity: false,
        containsSecrets: false,
        preparedAt: normalized.preparedAt
      }
    });
  });
}

export function projectPreparedCourseToolAction(
  action: WorkbenchCourseToolActionRecord
): PreparedCourseToolActionProjection {
  if (
    action.capability !== "L3_EXTERNAL_STAGE" ||
    action.effectClass !== "external_stage" ||
    !WORKBENCH_COURSE_ACTION_TOOL_NAMES.includes(
      action.toolName as WorkbenchCourseActionToolName
    ) ||
    action.toolVersion !== "1" ||
    action.realPublishEnabled !== false ||
    action.oneShot !== true ||
    !COURSE_TOOL_ACTION_STATUSES.includes(action.status as CourseToolActionStatus)
  ) {
    storeError("COURSE_TOOL_ACTION_RECORD_INVALID", "action 持久投影不符合 L3 STAGE 契约。");
  }
  return Object.freeze({
    actionRef: action.id,
    bindingHash: action.bindingHash,
    approvalHash: action.approvalHash,
    validFrom: action.validFrom.toISOString(),
    expiresAt: action.expiresAt.toISOString(),
    status: action.status as CourseToolActionStatus,
    safeSummary: action.safeSummary,
    realPublishEnabled: false
  });
}

/**
 * Server-only exact action read. The returned database row contains the
 * internal grant reference and must never be serialized into a browser
 * response; public callers use projectPreparedCourseToolAction instead.
 */
export async function loadCourseToolAction(
  db: WorkbenchDb,
  input: {
    readonly actionRef: string;
    readonly taskId: string;
    readonly runId: string;
  }
): Promise<WorkbenchCourseToolActionRecord | null> {
  const actionRef = assertOpaqueId(input.actionRef, "actionRef");
  const taskId = assertOpaqueId(input.taskId, "taskId");
  const runId = assertOpaqueId(input.runId, "runId");
  return db.workbenchCourseToolActionRecord.findFirst({
    where: {
      id: actionRef,
      taskId,
      runId,
      capability: "L3_EXTERNAL_STAGE",
      effectClass: "external_stage",
      oneShot: true,
      realPublishEnabled: false
    }
  });
}

/** Returns the newest server-only action row for durable run recovery. */
export async function loadCurrentCourseToolAction(
  db: WorkbenchDb,
  input: { readonly taskId: string; readonly runId: string }
): Promise<WorkbenchCourseToolActionRecord | null> {
  const taskId = assertOpaqueId(input.taskId, "taskId");
  const runId = assertOpaqueId(input.runId, "runId");
  return db.workbenchCourseToolActionRecord.findFirst({
    where: {
      taskId,
      runId,
      capability: "L3_EXTERNAL_STAGE",
      effectClass: "external_stage",
      oneShot: true,
      realPublishEnabled: false
    },
    orderBy: [{ preparedAt: "desc" }, { id: "desc" }]
  });
}

/** Exact server-only recovery child lookup. No grant reference is projected. */
export async function loadCourseToolRecoveryAction(
  db: WorkbenchDb,
  input: {
    readonly recoveryOfActionRef: string;
    readonly taskId: string;
    readonly runId: string;
  }
): Promise<WorkbenchCourseToolActionRecord | null> {
  const recoveryOfActionId = assertOpaqueId(
    input.recoveryOfActionRef,
    "recoveryOfActionRef"
  );
  const taskId = assertOpaqueId(input.taskId, "taskId");
  const runId = assertOpaqueId(input.runId, "runId");
  return db.workbenchCourseToolActionRecord.findFirst({
    where: {
      taskId,
      runId,
      parentActionId: recoveryOfActionId,
      recoveryOfActionId,
      toolName: "platform.editor.reconcile_stage",
      toolVersion: "1",
      capability: "L3_EXTERNAL_STAGE",
      effectClass: "external_stage",
      oneShot: true,
      realPublishEnabled: false
    },
    orderBy: [{ preparedAt: "desc" }, { id: "desc" }]
  });
}

export async function requestCourseToolActionApproval(
  db: WorkbenchDb,
  input: {
    readonly actionRef: string;
    readonly bindingHash: string;
    readonly approvalHash: string;
    readonly requestedAt?: Date | string;
  }
): Promise<WorkbenchCourseToolActionRecord> {
  const actionRef = assertOpaqueId(input.actionRef, "actionRef");
  const bindingHash = assertHash(input.bindingHash, "bindingHash");
  const approvalHash = assertHash(input.approvalHash, "approvalHash");
  const requestedAt = normalizeDate(input.requestedAt ?? new Date(), "requestedAt");
  return withTransaction(db, async (transaction) => {
    const updated = await transaction.workbenchCourseToolActionRecord.updateMany({
      where: {
        id: actionRef,
        bindingHash,
        approvalHash,
        status: "prepared",
        expiresAt: { gt: requestedAt },
        oneShot: true,
        realPublishEnabled: false
      },
      data: {
        status: "awaiting_approval",
        statusReasonCode: "approval_requested",
        approvalRequestedAt: requestedAt
      }
    });
    if (updated.count === 1) {
      return transaction.workbenchCourseToolActionRecord.findUniqueOrThrow({
        where: { id: actionRef }
      });
    }
    const existing = await transaction.workbenchCourseToolActionRecord.findUnique({
      where: { id: actionRef }
    });
    if (!existing) {
      storeError("COURSE_TOOL_ACTION_NOT_FOUND", "找不到 prepared action。");
    }
    if (
      existing.bindingHash !== bindingHash ||
      existing.approvalHash !== approvalHash
    ) {
      storeError("COURSE_TOOL_ACTION_APPROVAL_MISMATCH", "审批 hash 与 action 不一致。");
    }
    if (existing.status === "awaiting_approval") return existing;
    if (existing.expiresAt <= requestedAt) {
      await transaction.workbenchCourseToolActionRecord.updateMany({
        where: { id: actionRef, status: { in: ["prepared", "awaiting_approval"] } },
        data: {
          status: "failed_before_write",
          statusReasonCode: "approval_window_expired",
          completedAt: requestedAt
        }
      });
      return transaction.workbenchCourseToolActionRecord.findUniqueOrThrow({
        where: { id: actionRef }
      });
    }
    storeError("COURSE_TOOL_ACTION_STATE_CONFLICT", "action 当前状态不能请求审批。");
  });
}

function sameIssuedGrant(
  action: WorkbenchCourseToolActionRecord,
  grant: WorkbenchCourseToolGrantRecord
): boolean {
  return (
    grant.id === action.grantRef &&
    grant.actionId === action.id &&
    grant.capability === action.capability &&
    grant.effectClass === action.effectClass &&
    grant.toolName === action.toolName &&
    grant.toolVersion === action.toolVersion &&
    grant.callId === action.callId &&
    grant.taskId === action.taskId &&
    grant.runId === action.runId &&
    grant.planRevisionId === action.planRevisionId &&
    grant.stepId === action.stepId &&
    grant.courseScopeHash === action.courseScopeHash &&
    grant.inputHash === action.inputHash &&
    grant.idempotencyKeyHash === action.idempotencyKeyHash &&
    grant.policyVersion === action.policyVersion &&
    grant.attempt === action.attempt &&
    grant.bindingHash === action.bindingHash &&
    grant.approvalHash === action.approvalHash &&
    grant.validFrom.getTime() === action.validFrom.getTime() &&
    grant.expiresAt.getTime() === action.expiresAt.getTime() &&
    grant.oneShot === true &&
    grant.realPublishEnabled === false
  );
}

export async function approveCourseToolAction(
  db: WorkbenchDb,
  input: {
    readonly actionRef: string;
    readonly bindingHash: string;
    readonly approvalHash: string;
    readonly approvedAt?: Date | string;
  }
): Promise<{
  action: WorkbenchCourseToolActionRecord;
  grant: WorkbenchCourseToolGrantRecord;
}> {
  const actionRef = assertOpaqueId(input.actionRef, "actionRef");
  const bindingHash = assertHash(input.bindingHash, "bindingHash");
  const approvalHash = assertHash(input.approvalHash, "approvalHash");
  const approvedAt = normalizeDate(input.approvedAt ?? new Date(), "approvedAt");
  const result = await withTransaction(db, async (transaction) => {
    const action = await transaction.workbenchCourseToolActionRecord.findUnique({
      where: { id: actionRef }
    });
    if (!action) storeError("COURSE_TOOL_ACTION_NOT_FOUND", "找不到待审批 action。");
    if (
      action.bindingHash !== bindingHash ||
      action.approvalHash !== approvalHash
    ) {
      storeError("COURSE_TOOL_ACTION_APPROVAL_MISMATCH", "审批 hash 与 action 不一致。");
    }
    if (
      action.capability !== "L3_EXTERNAL_STAGE" ||
      action.effectClass !== "external_stage" ||
      !WORKBENCH_COURSE_ACTION_TOOL_NAMES.includes(
        action.toolName as WorkbenchCourseActionToolName
      ) ||
      action.toolVersion !== "1" ||
      action.realPublishEnabled !== false ||
      action.oneShot !== true
    ) {
      storeError("COURSE_TOOL_ACTION_STAGE_ONLY", "action 不是可审批的 L3 STAGE/reconcile action。");
    }
    const existingGrant = await transaction.workbenchCourseToolGrantRecord.findUnique({
      where: { actionId: action.id }
    });
    if (existingGrant) {
      if (sameIssuedGrant(action, existingGrant)) {
        return {
          kind: "approved" as const,
          action,
          grant: existingGrant
        };
      }
      storeError("COURSE_TOOL_GRANT_BINDING_CONFLICT", "action 已绑定另一份 grant。");
    }
    if (action.status !== "awaiting_approval") {
      storeError("COURSE_TOOL_ACTION_STATE_CONFLICT", "action 当前不在 awaiting_approval。" );
    }
    if (action.expiresAt <= approvedAt) {
      await transaction.workbenchCourseToolActionRecord.updateMany({
        where: { id: action.id, status: "awaiting_approval" },
        data: {
          status: "failed_before_write",
          statusReasonCode: "approval_window_expired",
          completedAt: approvedAt
        }
      });
      return { kind: "expired" as const };
    }
    const updated = await transaction.workbenchCourseToolActionRecord.updateMany({
      where: {
        id: action.id,
        status: "awaiting_approval",
        bindingHash,
        approvalHash,
        expiresAt: { gt: approvedAt },
        capability: "L3_EXTERNAL_STAGE",
        effectClass: "external_stage",
        oneShot: true,
        realPublishEnabled: false
      },
      data: {
        status: "approved",
        statusReasonCode: "exact_approval_recorded",
        approvedAt
      }
    });
    if (updated.count !== 1) {
      storeError("COURSE_TOOL_ACTION_STATE_CONFLICT", "action 审批 CAS 失败。");
    }
    const grant = await transaction.workbenchCourseToolGrantRecord.create({
      data: {
        id: action.grantRef,
        schemaVersion: COURSE_TOOL_GRANT_SCHEMA_VERSION,
        actionId: action.id,
        capability: action.capability,
        effectClass: action.effectClass,
        toolName: action.toolName,
        toolVersion: action.toolVersion,
        callId: action.callId,
        taskId: action.taskId,
        runId: action.runId,
        planRevisionId: action.planRevisionId,
        stepId: action.stepId,
        courseScopeHash: action.courseScopeHash,
        inputHash: action.inputHash,
        idempotencyKeyHash: action.idempotencyKeyHash,
        policyVersion: action.policyVersion,
        attempt: action.attempt,
        bindingHash: action.bindingHash,
        approvalHash: action.approvalHash,
        validFrom: action.validFrom,
        expiresAt: action.expiresAt,
        oneShot: true,
        realPublishEnabled: false,
        status: "available"
      }
    });
    const approved = await transaction.workbenchCourseToolActionRecord.findUniqueOrThrow({
      where: { id: action.id }
    });
    return { kind: "approved" as const, action: approved, grant };
  });
  if (result.kind === "expired") {
    storeError("COURSE_TOOL_ACTION_EXPIRED", "action 审批窗口已过期。");
  }
  return { action: result.action, grant: result.grant };
}

function bindingMatchesGrant(
  binding: CourseToolGrantBinding,
  bindingHash: string,
  grant: WorkbenchCourseToolGrantRecord
): boolean {
  return (
    grant.capability === binding.capability &&
    grant.effectClass === binding.effect &&
    grant.toolName === binding.toolName &&
    grant.toolVersion === binding.toolVersion &&
    grant.callId === binding.callId &&
    grant.taskId === binding.taskId &&
    grant.runId === binding.runId &&
    grant.planRevisionId === binding.planRevisionId &&
    grant.stepId === binding.stepId &&
    grant.courseScopeHash === binding.courseScopeHash &&
    grant.inputHash === binding.inputHash &&
    grant.idempotencyKeyHash === binding.idempotencyKeyHash &&
    grant.policyVersion === binding.policyVersion &&
    grant.attempt === binding.attempt &&
    grant.bindingHash === bindingHash &&
    grant.oneShot === true &&
    grant.realPublishEnabled === false
  );
}

/**
 * The first updateMany below is the single database CAS that consumes the
 * one-shot authority. Every scope/hash/window field participates in its WHERE
 * clause. The accompanying action transition is in the same transaction; if
 * that transition cannot prove `approved -> executing`, the grant CAS rolls
 * back.
 */
export async function claimCourseToolGrant(
  db: WorkbenchDb,
  input: {
    readonly grantRef: string;
    readonly binding: CourseToolGrantBinding;
    readonly now: Date | string;
  }
): Promise<CourseToolGrantClaimStoreResult> {
  const grantRef = assertOpaqueId(input.grantRef, "grantRef");
  try {
    assertStageBinding(input.binding);
  } catch (error) {
    if (error instanceof CourseToolActionStoreError) {
      return { status: "scope_mismatch" };
    }
    throw error;
  }
  const now = normalizeDate(input.now, "now");
  const bindingHash = hashCourseToolActionBinding(input.binding);
  return withTransaction(db, async (transaction) => {
    const binding = input.binding;
    const claimed = await transaction.workbenchCourseToolGrantRecord.updateMany({
      where: {
        id: grantRef,
        status: "available",
        capability: "L3_EXTERNAL_STAGE",
        effectClass: "external_stage",
        toolName: binding.toolName,
        toolVersion: binding.toolVersion,
        callId: binding.callId,
        taskId: binding.taskId,
        runId: binding.runId,
        planRevisionId: binding.planRevisionId,
        stepId: binding.stepId,
        courseScopeHash: binding.courseScopeHash,
        inputHash: binding.inputHash,
        idempotencyKeyHash: binding.idempotencyKeyHash,
        policyVersion: binding.policyVersion,
        attempt: binding.attempt,
        bindingHash,
        validFrom: { lte: now },
        expiresAt: { gt: now },
        oneShot: true,
        realPublishEnabled: false
      },
      data: { status: "consumed", consumedAt: now }
    });
    if (claimed.count === 1) {
      const grant = await transaction.workbenchCourseToolGrantRecord.findUniqueOrThrow({
        where: { id: grantRef }
      });
      const actionStarted = await transaction.workbenchCourseToolActionRecord.updateMany({
        where: {
          id: grant.actionId,
          status: "approved",
          bindingHash: grant.bindingHash,
          approvalHash: grant.approvalHash,
          grantRef: grant.id,
          oneShot: true,
          realPublishEnabled: false
        },
        data: {
          status: "executing",
          statusReasonCode: "one_shot_grant_claimed",
          executionStartedAt: now
        }
      });
      if (actionStarted.count !== 1) {
        storeError(
          "COURSE_TOOL_ACTION_AUTHORITY_INCONSISTENT",
          "grant 已命中但 action 不处于 exact approved 状态。"
        );
      }
      const action = await transaction.workbenchCourseToolActionRecord.findUniqueOrThrow({
        where: { id: grant.actionId },
        select: {
          recoveryOfActionId: true,
          parentActionId: true,
          taskId: true,
          runId: true,
          planRevisionId: true,
          stepId: true,
          toolName: true,
          businessInputJson: true
        }
      });
      if (action.toolName === "platform.editor.reconcile_stage") {
        let recoveryTransactionRef: string | null = null;
        try {
          const recoveryInput = JSON.parse(action.businessInputJson) as {
            stageTransactionRef?: unknown;
          };
          recoveryTransactionRef = typeof recoveryInput.stageTransactionRef === "string" &&
            isSafeIdentifier(recoveryInput.stageTransactionRef)
            ? recoveryInput.stageTransactionRef
            : null;
        } catch {
          recoveryTransactionRef = null;
        }
        if (
          !action.recoveryOfActionId ||
          action.parentActionId !== action.recoveryOfActionId ||
          !recoveryTransactionRef
        ) {
          storeError(
            "COURSE_TOOL_ACTION_RECOVERY_LINEAGE_INVALID",
            "reconcile grant 缺少 exact parent/recoveryOf lineage。"
          );
        }
        const parentStarted =
          await transaction.workbenchCourseToolActionRecord.updateMany({
            where: {
              id: action.recoveryOfActionId,
              taskId: action.taskId,
              runId: action.runId,
              planRevisionId: action.planRevisionId,
              stepId: action.stepId,
              toolName: "platform.editor.stage_verify_clear",
              toolVersion: "1",
              status: "unknown",
              compensationRef: recoveryTransactionRef,
              oneShot: true,
              realPublishEnabled: false
            },
            data: {
              status: "reconciling",
              statusReasonCode: "trusted_reconcile_grant_claimed"
            }
          });
        if (parentStarted.count !== 1) {
          storeError(
            "COURSE_TOOL_ACTION_RECOVERY_PARENT_CONFLICT",
            "reconcile grant 已命中，但 parent unknown action 不能原子进入 reconciling。"
          );
        }
      }
      return { status: "claimed", grant };
    }

    const existing = await transaction.workbenchCourseToolGrantRecord.findUnique({
      where: { id: grantRef }
    });
    if (!existing) return { status: "not_found" };
    if (existing.status === "consumed") return { status: "consumed" };
    if (existing.status === "revoked") return { status: "revoked" };
    if (existing.status === "expired") return { status: "expired" };
    if (existing.expiresAt <= now) {
      const expired = await transaction.workbenchCourseToolGrantRecord.updateMany({
        where: { id: grantRef, status: "available", expiresAt: { lte: now } },
        data: { status: "expired", expiredAt: now }
      });
      if (expired.count === 1) {
        await transaction.workbenchCourseToolActionRecord.updateMany({
          where: { id: existing.actionId, status: "approved" },
          data: {
            status: "failed_before_write",
            statusReasonCode: "grant_expired",
            completedAt: now
          }
        });
      }
      return { status: "expired" };
    }
    if (
      existing.validFrom > now ||
      !bindingMatchesGrant(input.binding, bindingHash, existing)
    ) {
      return { status: "scope_mismatch" };
    }
    return { status: "scope_mismatch" };
  });
}

export async function revokeCourseToolGrant(
  db: WorkbenchDb,
  input: {
    readonly grantRef: string;
    readonly bindingHash: string;
    readonly approvalHash: string;
    readonly revokedAt?: Date | string;
  }
): Promise<WorkbenchCourseToolGrantRecord> {
  const grantRef = assertOpaqueId(input.grantRef, "grantRef");
  const bindingHash = assertHash(input.bindingHash, "bindingHash");
  const approvalHash = assertHash(input.approvalHash, "approvalHash");
  const revokedAt = normalizeDate(input.revokedAt ?? new Date(), "revokedAt");
  return withTransaction(db, async (transaction) => {
    const revoked = await transaction.workbenchCourseToolGrantRecord.updateMany({
      where: {
        id: grantRef,
        bindingHash,
        approvalHash,
        status: "available",
        capability: "L3_EXTERNAL_STAGE",
        effectClass: "external_stage",
        realPublishEnabled: false
      },
      data: { status: "revoked", revokedAt }
    });
    const grant = await transaction.workbenchCourseToolGrantRecord.findUnique({
      where: { id: grantRef }
    });
    if (!grant) storeError("COURSE_TOOL_GRANT_NOT_FOUND", "找不到 grant。");
    if (
      grant.bindingHash !== bindingHash ||
      grant.approvalHash !== approvalHash
    ) {
      storeError("COURSE_TOOL_GRANT_SCOPE_MISMATCH", "撤销 hash 与 grant 不一致。");
    }
    if (revoked.count === 1) {
      await transaction.workbenchCourseToolActionRecord.updateMany({
        where: { id: grant.actionId, status: "approved" },
        data: {
          status: "failed_before_write",
          statusReasonCode: "grant_revoked",
          completedAt: revokedAt
        }
      });
      return grant;
    }
    if (grant.status === "revoked") return grant;
    storeError(
      grant.status === "consumed"
        ? "COURSE_TOOL_GRANT_ALREADY_CONSUMED"
        : "COURSE_TOOL_GRANT_STATE_CONFLICT",
      "grant 当前状态不能撤销。"
    );
  });
}

export async function expireCourseToolGrant(
  db: WorkbenchDb,
  input: { readonly grantRef: string; readonly now?: Date | string }
): Promise<WorkbenchCourseToolGrantRecord> {
  const grantRef = assertOpaqueId(input.grantRef, "grantRef");
  const now = normalizeDate(input.now ?? new Date(), "now");
  return withTransaction(db, async (transaction) => {
    const expired = await transaction.workbenchCourseToolGrantRecord.updateMany({
      where: { id: grantRef, status: "available", expiresAt: { lte: now } },
      data: { status: "expired", expiredAt: now }
    });
    const grant = await transaction.workbenchCourseToolGrantRecord.findUnique({
      where: { id: grantRef }
    });
    if (!grant) storeError("COURSE_TOOL_GRANT_NOT_FOUND", "找不到 grant。");
    if (expired.count === 1) {
      await transaction.workbenchCourseToolActionRecord.updateMany({
        where: { id: grant.actionId, status: "approved" },
        data: {
          status: "failed_before_write",
          statusReasonCode: "grant_expired",
          completedAt: now
        }
      });
      return grant;
    }
    if (grant.status === "expired") return grant;
    if (grant.status === "available") {
      storeError("COURSE_TOOL_GRANT_NOT_EXPIRED", "grant 尚未到期。");
    }
    storeError("COURSE_TOOL_GRANT_STATE_CONFLICT", "grant 已进入其他终态。");
  });
}

export async function transitionCourseToolAction(
  db: WorkbenchDb,
  input: {
    readonly actionRef: string;
    readonly from: CourseToolActionStatus;
    readonly to: CourseToolActionStatus;
    readonly reasonCode: string;
    readonly at?: Date | string;
    readonly terminalReceiptHash?: string;
    readonly reconciliationHash?: string;
    readonly compensationRef?: string;
  }
): Promise<WorkbenchCourseToolActionRecord> {
  const actionRef = assertOpaqueId(input.actionRef, "actionRef");
  if (!isCourseToolActionTransitionAllowed(input.from, input.to)) {
    storeError(
      "COURSE_TOOL_ACTION_TRANSITION_INVALID",
      `${input.from} -> ${input.to} 不是允许的 action 状态转换。`
    );
  }
  const reasonCode = assertIdentifier(input.reasonCode, "reasonCode");
  const at = normalizeDate(input.at ?? new Date(), "at");
  const terminalReceiptHash = input.terminalReceiptHash
    ? assertHash(input.terminalReceiptHash, "terminalReceiptHash")
    : undefined;
  const reconciliationHash = input.reconciliationHash
    ? assertHash(input.reconciliationHash, "reconciliationHash")
    : undefined;
  const compensationRef = input.compensationRef
    ? assertIdentifier(input.compensationRef, "compensationRef")
    : undefined;
  if (input.to === "succeeded" && !terminalReceiptHash) {
    storeError(
      "COURSE_TOOL_ACTION_TERMINAL_RECEIPT_REQUIRED",
      "succeeded action 必须绑定 terminalReceiptHash。"
    );
  }
  if (input.to === "reconciled" && !reconciliationHash) {
    storeError(
      "COURSE_TOOL_ACTION_RECONCILIATION_REQUIRED",
      "reconciled action 必须绑定 reconciliationHash。"
    );
  }
  const completedAt = TERMINAL_ACTION_STATUSES.has(input.to) ? at : undefined;
  const updated = await db.workbenchCourseToolActionRecord.updateMany({
    where: {
      id: actionRef,
      status: input.from,
      capability: "L3_EXTERNAL_STAGE",
      effectClass: "external_stage",
      toolName: { in: [...WORKBENCH_COURSE_ACTION_TOOL_NAMES] },
      toolVersion: "1",
      oneShot: true,
      realPublishEnabled: false
    },
    data: {
      status: input.to,
      statusReasonCode: reasonCode,
      ...(terminalReceiptHash ? { terminalReceiptHash } : {}),
      ...(reconciliationHash ? { reconciliationHash } : {}),
      ...(compensationRef ? { compensationRef } : {}),
      ...(completedAt ? { completedAt } : {})
    }
  });
  if (updated.count !== 1) {
    storeError("COURSE_TOOL_ACTION_STATE_CONFLICT", "action 状态 CAS 失败。");
  }
  return db.workbenchCourseToolActionRecord.findUniqueOrThrow({
    where: { id: actionRef }
  });
}

/**
 * Commits a verified reconcile child, its ambiguous parent, and the canonical
 * plan step together. A restart can therefore never observe reconciled actions
 * while the plan still looks executable.
 */
export async function completeCourseToolRecovery(
  db: WorkbenchDb,
  input: {
    readonly recoveryActionRef: string;
    readonly parentActionRef: string;
    readonly receiptHash: string;
    readonly at?: Date | string;
  }
): Promise<{
  readonly recovery: WorkbenchCourseToolActionRecord;
  readonly parent: WorkbenchCourseToolActionRecord;
}> {
  const recoveryActionRef = assertOpaqueId(
    input.recoveryActionRef,
    "recoveryActionRef"
  );
  const parentActionRef = assertOpaqueId(input.parentActionRef, "parentActionRef");
  const receiptHash = assertHash(input.receiptHash, "receiptHash");
  const at = normalizeDate(input.at ?? new Date(), "at");
  return withTransaction(db, async (transaction) => {
    const recovery = await transaction.workbenchCourseToolActionRecord.findUnique({
      where: { id: recoveryActionRef }
    });
    if (
      !recovery ||
      recovery.parentActionId !== parentActionRef ||
      recovery.recoveryOfActionId !== parentActionRef ||
      recovery.toolName !== "platform.editor.reconcile_stage" ||
      recovery.toolVersion !== "1"
    ) {
      storeError(
        "COURSE_TOOL_ACTION_RECOVERY_LINEAGE_INVALID",
        "reconcile completion 缺少 exact parent/recoveryOf lineage。"
      );
    }
    const currentPlan = await transaction.workbenchPlanRevisionRecord.findFirst({
      where: {
        taskId: recovery.taskId,
        runId: recovery.runId,
        source: "server_compiler"
      },
      orderBy: { revision: "desc" },
      select: { id: true }
    });
    if (currentPlan?.id !== recovery.planRevisionId) {
      storeError(
        "COURSE_TOOL_ACTION_RECOVERY_PLAN_CONFLICT",
        "reconcile action 不属于当前 canonical plan。"
      );
    }
    const recovered = await transaction.workbenchCourseToolActionRecord.updateMany({
      where: {
        id: recovery.id,
        status: "executing",
        parentActionId: parentActionRef,
        recoveryOfActionId: parentActionRef,
        oneShot: true,
        realPublishEnabled: false
      },
      data: {
        status: "succeeded",
        statusReasonCode: "verified_reconcile_completed",
        terminalReceiptHash: receiptHash,
        completedAt: at
      }
    });
    const parent = await transaction.workbenchCourseToolActionRecord.updateMany({
      where: {
        id: parentActionRef,
        taskId: recovery.taskId,
        runId: recovery.runId,
        planRevisionId: recovery.planRevisionId,
        stepId: recovery.stepId,
        toolName: "platform.editor.stage_verify_clear",
        toolVersion: "1",
        status: "reconciling",
        compensationRef: { not: null },
        oneShot: true,
        realPublishEnabled: false
      },
      data: {
        status: "reconciled",
        statusReasonCode: "editor_safe_state_reconciled",
        reconciliationHash: receiptHash,
        completedAt: at
      }
    });
    const planStep = await transaction.workbenchPlanStepRecord.updateMany({
      where: {
        id: recovery.stepId,
        planRevisionId: recovery.planRevisionId,
        status: "running",
        completedAt: null
      },
      data: {
        status: "completed",
        completedAt: at
      }
    });
    if (
      recovered.count !== 1 ||
      parent.count !== 1 ||
      planStep.count !== 1
    ) {
      storeError(
        "COURSE_TOOL_ACTION_RECOVERY_STATE_CONFLICT",
        "reconcile child、parent 与 canonical plan 不能原子提交 verified 终态。"
      );
    }
    return {
      recovery: await transaction.workbenchCourseToolActionRecord.findUniqueOrThrow({
        where: { id: recoveryActionRef }
      }),
      parent: await transaction.workbenchCourseToolActionRecord.findUniqueOrThrow({
        where: { id: parentActionRef }
      })
    };
  });
}

/**
 * Fail-closes an executing reconcile child, its parent, and the canonical plan
 * into manual review/blocked in one transaction.
 */
export async function markCourseToolRecoveryManualReview(
  db: WorkbenchDb,
  input: {
    readonly recoveryActionRef: string;
    readonly parentActionRef: string;
    readonly reasonCode: string;
    readonly at?: Date | string;
  }
): Promise<void> {
  const recoveryActionRef = assertOpaqueId(
    input.recoveryActionRef,
    "recoveryActionRef"
  );
  const parentActionRef = assertOpaqueId(input.parentActionRef, "parentActionRef");
  const reasonCode = assertIdentifier(input.reasonCode, "reasonCode");
  const at = normalizeDate(input.at ?? new Date(), "at");
  await withTransaction(db, async (transaction) => {
    const recovery = await transaction.workbenchCourseToolActionRecord.findFirst({
      where: {
        id: recoveryActionRef,
        parentActionId: parentActionRef,
        recoveryOfActionId: parentActionRef,
        toolName: "platform.editor.reconcile_stage",
        toolVersion: "1"
      }
    });
    if (!recovery) {
      storeError(
        "COURSE_TOOL_ACTION_RECOVERY_LINEAGE_INVALID",
        "manual review 缺少 exact recovery lineage。"
      );
    }
    const currentPlan = await transaction.workbenchPlanRevisionRecord.findFirst({
      where: {
        taskId: recovery.taskId,
        runId: recovery.runId,
        source: "server_compiler"
      },
      orderBy: { revision: "desc" },
      select: { id: true }
    });
    if (currentPlan?.id !== recovery.planRevisionId) {
      storeError(
        "COURSE_TOOL_ACTION_RECOVERY_PLAN_CONFLICT",
        "reconcile action 不属于当前 canonical plan。"
      );
    }
    const childUpdated = await transaction.workbenchCourseToolActionRecord.updateMany({
      where: {
        id: recovery.id,
        status: "executing",
        oneShot: true,
        realPublishEnabled: false
      },
      data: {
        status: "manual_review",
        statusReasonCode: reasonCode,
        completedAt: at
      }
    });
    const parentUpdated = await transaction.workbenchCourseToolActionRecord.updateMany({
      where: {
        id: parentActionRef,
        taskId: recovery.taskId,
        runId: recovery.runId,
        planRevisionId: recovery.planRevisionId,
        stepId: recovery.stepId,
        status: "reconciling",
        oneShot: true,
        realPublishEnabled: false
      },
      data: {
        status: "manual_review",
        statusReasonCode: reasonCode,
        completedAt: at
      }
    });
    const planStepUpdated = await transaction.workbenchPlanStepRecord.updateMany({
      where: {
        id: recovery.stepId,
        planRevisionId: recovery.planRevisionId,
        status: "running",
        completedAt: null
      },
      data: { status: "blocked" }
    });
    if (
      childUpdated.count !== 1 ||
      parentUpdated.count !== 1 ||
      planStepUpdated.count !== 1
    ) {
      storeError(
        "COURSE_TOOL_ACTION_RECOVERY_STATE_CONFLICT",
        "reconcile child、parent 与 canonical plan 不能原子进入 manual_review。"
      );
    }
  });
}

/** Records an operator-declined recovery without ever issuing a grant. */
export async function declineCourseToolRecovery(
  db: WorkbenchDb,
  input: {
    readonly recoveryActionRef: string;
    readonly parentActionRef: string;
    readonly at?: Date | string;
  }
): Promise<void> {
  const recoveryActionRef = assertOpaqueId(
    input.recoveryActionRef,
    "recoveryActionRef"
  );
  const parentActionRef = assertOpaqueId(input.parentActionRef, "parentActionRef");
  const at = normalizeDate(input.at ?? new Date(), "at");
  await withTransaction(db, async (transaction) => {
    const recovery = await transaction.workbenchCourseToolActionRecord.findFirst({
      where: {
        id: recoveryActionRef,
        parentActionId: parentActionRef,
        recoveryOfActionId: parentActionRef,
        toolName: "platform.editor.reconcile_stage",
        toolVersion: "1"
      }
    });
    if (!recovery) {
      storeError(
        "COURSE_TOOL_ACTION_RECOVERY_LINEAGE_INVALID",
        "decline 缺少 exact recovery lineage。"
      );
    }
    const childUpdated = await transaction.workbenchCourseToolActionRecord.updateMany({
      where: {
        id: recovery.id,
        status: { in: ["awaiting_approval", "failed_before_write"] },
        oneShot: true,
        realPublishEnabled: false
      },
      data: {
        status: "manual_review",
        statusReasonCode: "operator_declined_reconcile",
        completedAt: at
      }
    });
    const parentUpdated = await transaction.workbenchCourseToolActionRecord.updateMany({
      where: {
        id: parentActionRef,
        taskId: recovery.taskId,
        runId: recovery.runId,
        planRevisionId: recovery.planRevisionId,
        stepId: recovery.stepId,
        status: "unknown",
        oneShot: true,
        realPublishEnabled: false
      },
      data: {
        status: "manual_review",
        statusReasonCode: "operator_declined_reconcile",
        completedAt: at
      }
    });
    if (childUpdated.count !== 1 || parentUpdated.count !== 1) {
      storeError(
        "COURSE_TOOL_ACTION_RECOVERY_STATE_CONFLICT",
        "declined reconcile child 与 parent 不能原子进入 manual_review。"
      );
    }
  });
}

/**
 * Fences every still-live L3 action after the owning Workbench process is
 * known to be gone.  Unconsumed grants are revoked before the public run is
 * made restartable; an action that may already have touched the editor is
 * quarantined for manual review and is never represented as a safe retry.
 */
export async function quarantineCourseToolRunAfterProcessLoss(
  db: WorkbenchDb,
  input: {
    readonly taskId: string;
    readonly runId: string;
    readonly at?: Date | string;
  }
): Promise<Readonly<{
  revokedGrantCount: number;
  failedBeforeWriteCount: number;
  manualReviewCount: number;
  blockedStepCount: number;
  releasedLeaseCount: number;
}>> {
  const taskId = assertOpaqueId(input.taskId, "taskId");
  const runId = assertOpaqueId(input.runId, "runId");
  const at = normalizeDate(input.at ?? new Date(), "at");
  return withTransaction(db, async (transaction) => {
    const liveActions = await transaction.workbenchCourseToolActionRecord.findMany({
      where: {
        taskId,
        runId,
        status: {
          in: [
            "prepared",
            "awaiting_approval",
            "approved",
            "executing",
            "unknown",
            "reconciling"
          ]
        },
        capability: "L3_EXTERNAL_STAGE",
        effectClass: "external_stage",
        oneShot: true,
        realPublishEnabled: false
      },
      select: { stepId: true }
    });
    const stepIds = [...new Set(liveActions.map((action) => action.stepId))];
    const revoked = await transaction.workbenchCourseToolGrantRecord.updateMany({
      where: {
        taskId,
        runId,
        status: "available",
        capability: "L3_EXTERNAL_STAGE",
        effectClass: "external_stage",
        oneShot: true,
        realPublishEnabled: false
      },
      data: { status: "revoked", revokedAt: at }
    });
    const failedBeforeWrite =
      await transaction.workbenchCourseToolActionRecord.updateMany({
        where: {
          taskId,
          runId,
          status: { in: ["prepared", "awaiting_approval", "approved"] },
          capability: "L3_EXTERNAL_STAGE",
          effectClass: "external_stage",
          oneShot: true,
          realPublishEnabled: false
        },
        data: {
          status: "failed_before_write",
          statusReasonCode: "workbench_process_lost_before_execution",
          completedAt: at
        }
      });
    const manualReview =
      await transaction.workbenchCourseToolActionRecord.updateMany({
        where: {
          taskId,
          runId,
          status: { in: ["executing", "unknown", "reconciling"] },
          capability: "L3_EXTERNAL_STAGE",
          effectClass: "external_stage",
          oneShot: true,
          realPublishEnabled: false
        },
        data: {
          status: "manual_review",
          statusReasonCode: "workbench_process_lost_after_execution_started",
          completedAt: at
        }
      });
    const blockedSteps = stepIds.length
      ? await transaction.workbenchPlanStepRecord.updateMany({
          where: {
            id: { in: stepIds },
            planRevision: { taskId, runId },
            status: {
              in: [
                "pending",
                "running",
                "waiting_for_approval",
                "waiting_for_reconcile"
              ]
            }
          },
          data: { status: "blocked", completedAt: at }
        })
      : { count: 0 };
    const releasedLeases = await transaction.workbenchExecutionLease.updateMany({
      where: { taskId, runId, status: "active" },
      data: {
        status: "released",
        heartbeatAt: at,
        expiresAt: at,
        releasedAt: at
      }
    });
    return Object.freeze({
      revokedGrantCount: revoked.count,
      failedBeforeWriteCount: failedBeforeWrite.count,
      manualReviewCount: manualReview.count,
      blockedStepCount: blockedSteps.count,
      releasedLeaseCount: releasedLeases.count
    });
  });
}

export function isPrismaUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
