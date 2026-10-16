import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type WorkbenchExecutionLease,
  type WorkbenchSafeTaskObjective,
  type WorkbenchToolCallRecord,
  type WorkbenchToolReceiptRecord,
  type WorkbenchVerificationRecord
} from "@prisma/client";

export const WORKBENCH_DURABLE_LEDGER_SCHEMA_VERSION =
  "cmooc.workbench.durable-ledger.v1" as const;
export const WORKBENCH_SAFE_OBJECTIVE_SCHEMA_VERSION =
  "cmooc.workbench.safe-task-objective.v1" as const;

export type WorkbenchDb = PrismaClient | Prisma.TransactionClient;

export type SafeJsonValue =
  | null
  | boolean
  | number
  | string
  | SafeJsonValue[]
  | { [key: string]: SafeJsonValue };

export type WorkbenchCapabilityLevel =
  | "L0_READ"
  | "L1_ARTIFACT"
  | "L2_REVERSIBLE"
  | "L3_EXTERNAL_STAGE"
  | "L4_IRREVERSIBLE";

export type WorkbenchEffectClass =
  | "pure"
  | "read"
  | "local_write"
  | "reversible_write"
  | "external_stage"
  | "irreversible_external";

export type DurableEvidenceRef = {
  kind: string;
  id: string;
  hash: string;
  observedAt: string;
};

export type DurableStateRef = DurableEvidenceRef;

export type VerificationCheck = {
  code: string;
  status: "passed" | "failed" | "unknown" | "not_evaluated";
  safeSummary: string;
};

export type SafeStructuredTaskGoal = {
  goalCode: string;
  courseAlias?: string;
  contextRefs?: string[];
  requestedArtifactKinds?: string[];
  constraints?: string[];
  intent?: "inspect" | "implement";
  capabilityCeiling?: WorkbenchCapabilityLevel;
  policyVersion?: string;
};

export class WorkbenchDurableLedgerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkbenchDurableLedgerError";
    this.code = code;
  }
}

export class WorkbenchExecutionLeaseBusyError extends WorkbenchDurableLedgerError {
  constructor() {
    super(
      "WORKBENCH_EXECUTION_LEASE_BUSY",
      "该执行范围已有未过期的持有者。"
    );
    this.name = "WorkbenchExecutionLeaseBusyError";
  }
}

export class WorkbenchExecutionLeaseStaleError extends WorkbenchDurableLedgerError {
  constructor() {
    super(
      "WORKBENCH_EXECUTION_LEASE_STALE",
      "执行租约已过期、被替代，或 fencing generation 不再有效。"
    );
    this.name = "WorkbenchExecutionLeaseStaleError";
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SAFE_JSON_BYTES = 32 * 1024;
const MAX_SAFE_JSON_DEPTH = 12;
const MAX_SAFE_ARRAY_ITEMS = 256;
const MAX_SAFE_OBJECT_KEYS = 256;
const MAX_SAFE_STRING_LENGTH = 2_000;

const FORBIDDEN_DURABLE_KEYS = new Set([
  "prompt",
  "rawprompt",
  "originalprompt",
  "userprompt",
  "body",
  "draftbody",
  "forumbody",
  "postbody",
  "replybody",
  "rawcontent",
  "contenttext",
  "text",
  "html",
  "markdown",
  "identity",
  "name",
  "fullname",
  "displayname",
  "username",
  "userid",
  "email",
  "phone",
  "cookie",
  "setcookie",
  "token",
  "accesstoken",
  "refreshtoken",
  "fencingtoken",
  "secret",
  "password",
  "credential",
  "authstate",
  "sessionstate",
  "rawinput",
  "rawoutput",
  "transientoutput",
  "compensationsecret",
  "grantsecret"
]);

function inputError(message: string): never {
  throw new WorkbenchDurableLedgerError(
    "WORKBENCH_DURABLE_INPUT_INVALID",
    message
  );
}

function unsafeInputError(path: string): never {
  throw new WorkbenchDurableLedgerError(
    "WORKBENCH_DURABLE_INPUT_UNSAFE",
    `字段 ${path} 不符合普通持久账本的安全投影边界。`
  );
}

function normalizedKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function keyIsHashOrRef(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized.endsWith("hash") || normalized.endsWith("ref");
}

function assertSafeString(value: string, path: string): void {
  if (!value || value.length > MAX_SAFE_STRING_LENGTH || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) {
    unsafeInputError(path);
  }
  if (
    /\b(?:https?|file):\/\//iu.test(value) ||
    /(?:^|[\s"'])(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|root)\/)/u.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/iu.test(value) ||
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/u.test(value) ||
    /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u.test(value) ||
    /\b(?:password|passwd|secret|access[_-]?token|refresh[_-]?token|cookie)\s*[:=]\s*\S+/iu.test(value) ||
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(value)
  ) {
    unsafeInputError(path);
  }
}

export function assertSafeDurableValue(
  value: unknown,
  path = "$",
  depth = 0
): asserts value is SafeJsonValue {
  if (depth > MAX_SAFE_JSON_DEPTH) unsafeInputError(path);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) unsafeInputError(path);
    return;
  }
  if (typeof value === "string") {
    assertSafeString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_SAFE_ARRAY_ITEMS) unsafeInputError(path);
    value.forEach((item, index) =>
      assertSafeDurableValue(item, `${path}[${index}]`, depth + 1)
    );
    return;
  }
  if (typeof value !== "object" || value === undefined) unsafeInputError(path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) unsafeInputError(path);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_SAFE_OBJECT_KEYS) unsafeInputError(path);
  for (const [key, item] of entries) {
    if (!key || key.length > 128) unsafeInputError(path);
    if (FORBIDDEN_DURABLE_KEYS.has(normalizedKey(key)) && !keyIsHashOrRef(key)) {
      unsafeInputError(`${path}.${key}`);
    }
    assertSafeDurableValue(item, `${path}.${key}`, depth + 1);
  }
}

export function serializeSafeDurableValue(value: unknown, path = "$" ): string {
  assertSafeDurableValue(value, path);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SAFE_JSON_BYTES) {
    unsafeInputError(path);
  }
  return serialized;
}

export function assertSafeSummary(value: string, path: string): string {
  if (typeof value !== "string") unsafeInputError(path);
  const summary = value.trim();
  if (!summary || summary.length > 1_000 || /[\r\n]/u.test(summary)) {
    unsafeInputError(path);
  }
  assertSafeString(summary, path);
  return summary;
}

export function assertSha256(value: string, path: string): string {
  if (!SHA256_PATTERN.test(value)) inputError(`${path} 必须是小写 SHA-256。`);
  return value;
}

export function assertOpaqueId(value: string, path: string): string {
  if (!OPAQUE_ID_PATTERN.test(value)) inputError(`${path} 必须是安全的不透明标识。`);
  return value;
}

export function assertOpaqueRef(value: string, path: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    /[\s\\/?#]/u.test(value) ||
    /^(?:https?|file):/iu.test(value)
  ) {
    inputError(`${path} 必须是安全的不透明引用。`);
  }
  return value;
}

export function assertToolName(value: string, path = "toolName"): string {
  if (!TOOL_NAME_PATTERN.test(value)) inputError(`${path} 不是版本化命名空间工具名。`);
  return value;
}

export function assertVersion(value: string, path: string): string {
  if (!VERSION_PATTERN.test(value)) inputError(`${path} 不是安全版本标识。`);
  return value;
}

export function normalizeDate(value: Date | string, path: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) inputError(`${path} 不是有效时间。`);
  return date;
}

export function normalizeEvidenceRefs(
  refs: readonly DurableEvidenceRef[],
  path = "evidenceRefs"
): DurableEvidenceRef[] {
  if (!Array.isArray(refs) || refs.length > 256) inputError(`${path} 数量无效。`);
  return refs.map((ref, index) => {
    if (!ref || typeof ref !== "object") inputError(`${path}[${index}] 无效。`);
    const observedAt = normalizeDate(ref.observedAt, `${path}[${index}].observedAt`);
    return {
      kind: assertVersion(ref.kind, `${path}[${index}].kind`),
      id: assertOpaqueRef(ref.id, `${path}[${index}].id`),
      hash: assertSha256(ref.hash, `${path}[${index}].hash`),
      observedAt: observedAt.toISOString()
    };
  });
}

export function hashExecutionFencingToken(fencingToken: string): string {
  if (!/^[a-f0-9]{64}$/u.test(fencingToken)) {
    inputError("fencingToken 必须是服务端生成的 256-bit token。");
  }
  return createHash("sha256")
    .update("cmooc.workbench.execution-lease.fencing.v1\0", "utf8")
    .update(fencingToken, "utf8")
    .digest("hex");
}

function newFencingToken(): string {
  return randomBytes(32).toString("hex");
}

function isPrismaClient(db: WorkbenchDb): db is PrismaClient {
  return typeof (db as PrismaClient).$transaction === "function";
}

export async function withWorkbenchTransaction<T>(
  db: WorkbenchDb,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  if (isPrismaClient(db)) {
    return db.$transaction((transaction) => operation(transaction));
  }
  return operation(db);
}

export async function assertTaskRunScope(
  db: WorkbenchDb,
  input: { taskId: string; runId: string }
): Promise<void> {
  assertOpaqueId(input.taskId, "taskId");
  assertOpaqueId(input.runId, "runId");
  const run = await db.workbenchRunRecord.findUnique({
    where: { id: input.runId },
    select: { taskId: true }
  });
  if (!run) {
    throw new WorkbenchDurableLedgerError(
      "WORKBENCH_DURABLE_RUN_NOT_FOUND",
      "找不到持久运行记录。"
    );
  }
  if (run.taskId !== input.taskId) {
    throw new WorkbenchDurableLedgerError(
      "WORKBENCH_DURABLE_SCOPE_MISMATCH",
      "task 与 run 的持久作用域不一致。"
    );
  }
}

export async function assertPlanStepScope(
  db: WorkbenchDb,
  input: { taskId: string; runId: string; stepId: string }
): Promise<void> {
  assertOpaqueId(input.stepId, "stepId");
  const step = await db.workbenchPlanStepRecord.findUnique({
    where: { id: input.stepId },
    select: {
      planRevision: { select: { taskId: true, runId: true } }
    }
  });
  if (
    !step ||
    step.planRevision.taskId !== input.taskId ||
    step.planRevision.runId !== input.runId
  ) {
    throw new WorkbenchDurableLedgerError(
      "WORKBENCH_DURABLE_SCOPE_MISMATCH",
      "plan step 与 task/run 的持久作用域不一致。"
    );
  }
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
    inputError("capability 无效。");
  }
}

function assertEffectClass(value: WorkbenchEffectClass): void {
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
    inputError("effectClass 无效。");
  }
}

function normalizeSafeStructuredTaskGoal(value: unknown): SafeStructuredTaskGoal {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    unsafeInputError("structuredGoal");
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "goalCode",
    "courseAlias",
    "contextRefs",
    "requestedArtifactKinds",
    "constraints",
    "intent",
    "capabilityCeiling",
    "policyVersion"
  ]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) unsafeInputError(`structuredGoal.${key}`);
  }
  if (typeof record.goalCode !== "string") unsafeInputError("structuredGoal.goalCode");
  const normalized: SafeStructuredTaskGoal = {
    goalCode: assertVersion(record.goalCode, "structuredGoal.goalCode")
  };
  if (record.courseAlias !== undefined) {
    if (typeof record.courseAlias !== "string") {
      unsafeInputError("structuredGoal.courseAlias");
    }
    normalized.courseAlias = assertOpaqueId(
      record.courseAlias,
      "structuredGoal.courseAlias"
    );
  }
  for (const [key, validator] of [
    ["contextRefs", assertOpaqueRef],
    ["requestedArtifactKinds", assertVersion],
    ["constraints", assertVersion]
  ] as const) {
    const values = record[key];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length > 64) {
      unsafeInputError(`structuredGoal.${key}`);
    }
    normalized[key] = values.map((item, index) => {
      if (typeof item !== "string") unsafeInputError(`structuredGoal.${key}[${index}]`);
      return validator(item, `structuredGoal.${key}[${index}]`);
    });
  }
  if (record.intent !== undefined) {
    if (record.intent !== "inspect" && record.intent !== "implement") {
      unsafeInputError("structuredGoal.intent");
    }
    normalized.intent = record.intent;
  }
  if (record.capabilityCeiling !== undefined) {
    if (typeof record.capabilityCeiling !== "string") {
      unsafeInputError("structuredGoal.capabilityCeiling");
    }
    assertCapability(record.capabilityCeiling as WorkbenchCapabilityLevel);
    normalized.capabilityCeiling =
      record.capabilityCeiling as WorkbenchCapabilityLevel;
  }
  if (record.policyVersion !== undefined) {
    if (typeof record.policyVersion !== "string") {
      unsafeInputError("structuredGoal.policyVersion");
    }
    normalized.policyVersion = assertVersion(
      record.policyVersion,
      "structuredGoal.policyVersion"
    );
  }
  return normalized;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

export type CreateSafeTaskObjectiveInput = {
  id?: string;
  taskId: string;
  schemaVersion?: string;
  objectiveHash: string;
  safeSummary: string;
  structuredGoal: unknown;
  source: string;
  expiresAt?: Date | string | null;
  createdAt?: Date | string;
};

export async function createSafeTaskObjective(
  db: WorkbenchDb,
  input: CreateSafeTaskObjectiveInput
): Promise<WorkbenchSafeTaskObjective> {
  assertOpaqueId(input.taskId, "taskId");
  const id = assertOpaqueId(input.id ?? randomUUID(), "id");
  const schemaVersion = assertVersion(
    input.schemaVersion ?? WORKBENCH_SAFE_OBJECTIVE_SCHEMA_VERSION,
    "schemaVersion"
  );
  const objectiveHash = assertSha256(input.objectiveHash, "objectiveHash");
  const safeSummary = assertSafeSummary(input.safeSummary, "safeSummary");
  const source = assertVersion(input.source, "source");
  const structuredGoalJson = serializeSafeDurableValue(
    normalizeSafeStructuredTaskGoal(input.structuredGoal),
    "structuredGoal"
  );
  const createdAt = normalizeDate(input.createdAt ?? new Date(), "createdAt");
  const expiresAt = input.expiresAt
    ? normalizeDate(input.expiresAt, "expiresAt")
    : null;
  if (expiresAt && expiresAt <= createdAt) inputError("expiresAt 必须晚于 createdAt。");

  return withWorkbenchTransaction(db, async (transaction) => {
    const task = await transaction.workbenchTask.findUnique({
      where: { id: input.taskId },
      select: { id: true }
    });
    if (!task) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_DURABLE_TASK_NOT_FOUND",
        "找不到持久任务记录。"
      );
    }
    const existing = await transaction.workbenchSafeTaskObjective.findUnique({
      where: { taskId: input.taskId }
    });
    if (existing) {
      const same =
        existing.schemaVersion === schemaVersion &&
        existing.objectiveHash === objectiveHash &&
        existing.safeSummary === safeSummary &&
        existing.structuredGoalJson === structuredGoalJson &&
        existing.source === source &&
        (existing.expiresAt?.getTime() ?? null) === (expiresAt?.getTime() ?? null);
      if (same) return existing;
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_SAFE_OBJECTIVE_IMMUTABLE",
        "该任务已绑定另一份不可变安全目标。"
      );
    }
    return transaction.workbenchSafeTaskObjective.create({
      data: {
        id,
        taskId: input.taskId,
        schemaVersion,
        objectiveHash,
        safeSummary,
        structuredGoalJson,
        source,
        expiresAt,
        createdAt
      }
    });
  });
}

export type ClaimExecutionLeaseInput = {
  id?: string;
  taskId: string;
  runId: string;
  stepId?: string | null;
  ownerInstanceId: string;
  ttlMs: number;
  now?: Date | string;
};

export type ClaimedExecutionLease = WorkbenchExecutionLease & {
  fencingToken: string;
};

function validateLeaseTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 100 || ttlMs > 86_400_000) {
    inputError("ttlMs 必须在 100ms 到 24h 之间。 ");
  }
}

function leaseScopeKey(stepId: string | null): string {
  return stepId ? `step:${stepId}` : "run";
}

async function claimExecutionLeaseOnce(
  db: WorkbenchDb,
  input: ClaimExecutionLeaseInput
): Promise<ClaimedExecutionLease> {
  const taskId = assertOpaqueId(input.taskId, "taskId");
  const runId = assertOpaqueId(input.runId, "runId");
  const stepId = input.stepId ? assertOpaqueId(input.stepId, "stepId") : null;
  const ownerInstanceId = assertOpaqueId(input.ownerInstanceId, "ownerInstanceId");
  const id = assertOpaqueId(input.id ?? randomUUID(), "id");
  validateLeaseTtl(input.ttlMs);
  const now = normalizeDate(input.now ?? new Date(), "now");
  const expiresAt = new Date(now.getTime() + input.ttlMs);
  const fencingToken = newFencingToken();
  const fencingTokenHash = hashExecutionFencingToken(fencingToken);
  const scopeKey = leaseScopeKey(stepId);

  return withWorkbenchTransaction(db, async (transaction) => {
    await assertTaskRunScope(transaction, { taskId, runId });
    if (stepId) await assertPlanStepScope(transaction, { taskId, runId, stepId });
    const existing = await transaction.workbenchExecutionLease.findUnique({
      where: { runId_scopeKey: { runId, scopeKey } }
    });
    if (!existing) {
      const lease = await transaction.workbenchExecutionLease.create({
        data: {
          id,
          taskId,
          runId,
          stepId,
          scopeKey,
          ownerInstanceId,
          generation: 1,
          fencingTokenHash,
          status: "active",
          acquiredAt: now,
          heartbeatAt: now,
          expiresAt
        }
      });
      return { ...lease, fencingToken };
    }
    if (existing.status === "active" && existing.expiresAt > now) {
      throw new WorkbenchExecutionLeaseBusyError();
    }
    const claimed = await transaction.workbenchExecutionLease.updateMany({
      where: {
        id: existing.id,
        generation: existing.generation,
        OR: [{ status: { not: "active" } }, { expiresAt: { lte: now } }]
      },
      data: {
        ownerInstanceId,
        generation: { increment: 1 },
        fencingTokenHash,
        status: "active",
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt,
        releasedAt: null
      }
    });
    if (claimed.count !== 1) throw new WorkbenchExecutionLeaseStaleError();
    const lease = await transaction.workbenchExecutionLease.findUniqueOrThrow({
      where: { id: existing.id }
    });
    return { ...lease, fencingToken };
  });
}

export async function claimExecutionLease(
  db: WorkbenchDb,
  input: ClaimExecutionLeaseInput
): Promise<ClaimedExecutionLease> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await claimExecutionLeaseOnce(db, input);
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 2) throw error;
    }
  }
  throw new WorkbenchExecutionLeaseStaleError();
}

export type HeartbeatExecutionLeaseInput = {
  leaseId: string;
  ownerInstanceId: string;
  generation: number;
  fencingToken: string;
  ttlMs: number;
  now?: Date | string;
};

export async function heartbeatExecutionLease(
  db: WorkbenchDb,
  input: HeartbeatExecutionLeaseInput
): Promise<WorkbenchExecutionLease> {
  const leaseId = assertOpaqueId(input.leaseId, "leaseId");
  const ownerInstanceId = assertOpaqueId(input.ownerInstanceId, "ownerInstanceId");
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    inputError("generation 无效。");
  }
  validateLeaseTtl(input.ttlMs);
  const now = normalizeDate(input.now ?? new Date(), "now");
  const fencingTokenHash = hashExecutionFencingToken(input.fencingToken);
  const updated = await db.workbenchExecutionLease.updateMany({
    where: {
      id: leaseId,
      ownerInstanceId,
      generation: input.generation,
      fencingTokenHash,
      status: "active",
      expiresAt: { gt: now }
    },
    data: {
      heartbeatAt: now,
      expiresAt: new Date(now.getTime() + input.ttlMs)
    }
  });
  if (updated.count !== 1) throw new WorkbenchExecutionLeaseStaleError();
  return db.workbenchExecutionLease.findUniqueOrThrow({ where: { id: leaseId } });
}

export type ReleaseExecutionLeaseInput = {
  leaseId: string;
  ownerInstanceId: string;
  generation: number;
  fencingToken: string;
  now?: Date | string;
};

export async function releaseExecutionLease(
  db: WorkbenchDb,
  input: ReleaseExecutionLeaseInput
): Promise<WorkbenchExecutionLease> {
  const leaseId = assertOpaqueId(input.leaseId, "leaseId");
  const ownerInstanceId = assertOpaqueId(input.ownerInstanceId, "ownerInstanceId");
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    inputError("generation 无效。");
  }
  const now = normalizeDate(input.now ?? new Date(), "now");
  const fencingTokenHash = hashExecutionFencingToken(input.fencingToken);
  const updated = await db.workbenchExecutionLease.updateMany({
    where: {
      id: leaseId,
      ownerInstanceId,
      generation: input.generation,
      fencingTokenHash,
      status: "active"
    },
    data: {
      status: "released",
      heartbeatAt: now,
      expiresAt: now,
      releasedAt: now
    }
  });
  if (updated.count !== 1) throw new WorkbenchExecutionLeaseStaleError();
  return db.workbenchExecutionLease.findUniqueOrThrow({ where: { id: leaseId } });
}

async function touchExecutionLease(
  transaction: Prisma.TransactionClient,
  input: {
    leaseId: string;
    taskId: string;
    runId: string;
    stepId: string;
    generation: number;
    fencingTokenHash: string;
    now: Date;
  }
): Promise<void> {
  const updated = await transaction.workbenchExecutionLease.updateMany({
    where: {
      id: input.leaseId,
      taskId: input.taskId,
      runId: input.runId,
      stepId: input.stepId,
      generation: input.generation,
      fencingTokenHash: input.fencingTokenHash,
      status: "active",
      expiresAt: { gt: input.now }
    },
    data: { heartbeatAt: input.now }
  });
  if (updated.count !== 1) throw new WorkbenchExecutionLeaseStaleError();
}

export type AppendToolCallInput = {
  id?: string;
  taskId: string;
  runId: string;
  stepId: string;
  executionLeaseId: string;
  parentCallId?: string | null;
  toolName: string;
  toolVersion: string;
  capability: WorkbenchCapabilityLevel;
  effectClass: WorkbenchEffectClass;
  safeInputSummary: string;
  inputHash: string;
  idempotencyKey: string;
  attempt: number;
  grantRef?: string | null;
  leaseGeneration: number;
  fencingToken: string;
  causationId?: string | null;
  createdAt?: Date | string;
};

export type AppendToolCallResult = {
  record: WorkbenchToolCallRecord;
  disposition: "accepted" | "duplicate";
};

function sameToolCallProjection(
  existing: WorkbenchToolCallRecord,
  expected: {
    taskId: string;
    runId: string;
    stepId: string;
    executionLeaseId: string;
    parentCallId: string | null;
    toolVersion: string;
    capability: WorkbenchCapabilityLevel;
    effectClass: WorkbenchEffectClass;
    safeInputSummary: string;
    inputHash: string;
    grantRef: string | null;
    leaseGeneration: number;
    fencingTokenHash: string;
  }
): boolean {
  return (
    existing.taskId === expected.taskId &&
    existing.runId === expected.runId &&
    existing.stepId === expected.stepId &&
    existing.executionLeaseId === expected.executionLeaseId &&
    existing.parentCallId === expected.parentCallId &&
    existing.toolVersion === expected.toolVersion &&
    existing.capability === expected.capability &&
    existing.effectClass === expected.effectClass &&
    existing.safeInputSummary === expected.safeInputSummary &&
    existing.inputHash === expected.inputHash &&
    existing.grantRef === expected.grantRef &&
    existing.leaseGeneration === expected.leaseGeneration &&
    existing.fencingTokenHash === expected.fencingTokenHash
  );
}

export async function appendToolCall(
  db: WorkbenchDb,
  input: AppendToolCallInput
): Promise<AppendToolCallResult> {
  const id = assertOpaqueId(input.id ?? randomUUID(), "id");
  const taskId = assertOpaqueId(input.taskId, "taskId");
  const runId = assertOpaqueId(input.runId, "runId");
  const stepId = assertOpaqueId(input.stepId, "stepId");
  const executionLeaseId = assertOpaqueId(input.executionLeaseId, "executionLeaseId");
  const parentCallId = input.parentCallId
    ? assertOpaqueId(input.parentCallId, "parentCallId")
    : null;
  const toolName = assertToolName(input.toolName);
  const toolVersion = assertVersion(input.toolVersion, "toolVersion");
  assertCapability(input.capability);
  assertEffectClass(input.effectClass);
  const safeInputSummary = assertSafeSummary(input.safeInputSummary, "safeInputSummary");
  const inputHash = assertSha256(input.inputHash, "inputHash");
  const idempotencyKey = assertSha256(input.idempotencyKey, "idempotencyKey");
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) inputError("attempt 无效。");
  if (!Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration < 1) {
    inputError("leaseGeneration 无效。");
  }
  const grantRef = input.grantRef
    ? assertOpaqueRef(input.grantRef, "grantRef")
    : null;
  const causationId = input.causationId
    ? assertOpaqueRef(input.causationId, "causationId")
    : null;
  const createdAt = normalizeDate(input.createdAt ?? new Date(), "createdAt");
  const fencingTokenHash = hashExecutionFencingToken(input.fencingToken);

  const expected = {
    taskId,
    runId,
    stepId,
    executionLeaseId,
    parentCallId,
    toolVersion,
    capability: input.capability,
    effectClass: input.effectClass,
    safeInputSummary,
    inputHash,
    grantRef,
    leaseGeneration: input.leaseGeneration,
    fencingTokenHash
  };

  try {
    return await withWorkbenchTransaction(db, async (transaction) => {
      await assertTaskRunScope(transaction, { taskId, runId });
      await assertPlanStepScope(transaction, { taskId, runId, stepId });
      await touchExecutionLease(transaction, {
        leaseId: executionLeaseId,
        taskId,
        runId,
        stepId,
        generation: input.leaseGeneration,
        fencingTokenHash,
        now: createdAt
      });
      if (parentCallId) {
        const parent = await transaction.workbenchToolCallRecord.findUnique({
          where: { id: parentCallId },
          select: { taskId: true, runId: true }
        });
        if (!parent || parent.taskId !== taskId || parent.runId !== runId) {
          throw new WorkbenchDurableLedgerError(
            "WORKBENCH_DURABLE_SCOPE_MISMATCH",
            "parent tool call 与当前 task/run 不一致。"
          );
        }
      }
      const existing = await transaction.workbenchToolCallRecord.findUnique({
        where: {
          toolName_idempotencyKey_attempt: {
            toolName,
            idempotencyKey,
            attempt: input.attempt
          }
        }
      });
      if (existing) {
        if (sameToolCallProjection(existing, expected)) {
          return { record: existing, disposition: "duplicate" };
        }
        throw new WorkbenchDurableLedgerError(
          "WORKBENCH_TOOL_CALL_IDEMPOTENCY_CONFLICT",
          "相同工具幂等键已绑定另一份调用投影。"
        );
      }
      const record = await transaction.workbenchToolCallRecord.create({
        data: {
          id,
          taskId,
          runId,
          stepId,
          executionLeaseId,
          parentCallId,
          toolName,
          toolVersion,
          capability: input.capability,
          effectClass: input.effectClass,
          safeInputSummary,
          inputHash,
          idempotencyKey,
          attempt: input.attempt,
          grantRef,
          leaseGeneration: input.leaseGeneration,
          fencingTokenHash,
          status: "requested",
          causationId,
          createdAt
        }
      });
      return { record, disposition: "accepted" };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await db.workbenchToolCallRecord.findUnique({
      where: {
        toolName_idempotencyKey_attempt: {
          toolName,
          idempotencyKey,
          attempt: input.attempt
        }
      }
    });
    if (!existing || !sameToolCallProjection(existing, expected)) {
      throw error;
    }
    return { record: existing, disposition: "duplicate" };
  }
}

export type CommitToolReceiptInput = {
  id?: string;
  callId: string;
  status: "succeeded" | "failed" | "unknown" | "compensated";
  safeOutputSummary: string;
  outputHash: string;
  evidenceRefs: readonly DurableEvidenceRef[];
  beforeRef?: DurableStateRef | null;
  afterRef?: DurableStateRef | null;
  verificationId?: string | null;
  compensationRef?: string | null;
  observedAt: Date | string;
  leaseGeneration: number;
  fencingToken: string;
  committedAt?: Date | string;
};

function normalizeOptionalStateRef(
  ref: DurableStateRef | null | undefined,
  path: string
): DurableStateRef | null {
  return ref ? normalizeEvidenceRefs([ref], path)[0] : null;
}

export async function commitToolReceipt(
  db: WorkbenchDb,
  input: CommitToolReceiptInput
): Promise<WorkbenchToolReceiptRecord> {
  const id = assertOpaqueId(input.id ?? randomUUID(), "id");
  const callId = assertOpaqueId(input.callId, "callId");
  if (!["succeeded", "failed", "unknown", "compensated"].includes(input.status)) {
    inputError("receipt status 无效。");
  }
  const safeOutputSummary = assertSafeSummary(
    input.safeOutputSummary,
    "safeOutputSummary"
  );
  const outputHash = assertSha256(input.outputHash, "outputHash");
  const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs);
  const evidenceRefsJson = serializeSafeDurableValue(evidenceRefs, "evidenceRefs");
  const beforeRef = normalizeOptionalStateRef(input.beforeRef, "beforeRef");
  const afterRef = normalizeOptionalStateRef(input.afterRef, "afterRef");
  const beforeRefJson = beforeRef
    ? serializeSafeDurableValue(beforeRef, "beforeRef")
    : null;
  const afterRefJson = afterRef
    ? serializeSafeDurableValue(afterRef, "afterRef")
    : null;
  const verificationId = input.verificationId
    ? assertOpaqueId(input.verificationId, "verificationId")
    : null;
  const compensationRef = input.compensationRef
    ? assertOpaqueRef(input.compensationRef, "compensationRef")
    : null;
  const observedAt = normalizeDate(input.observedAt, "observedAt");
  const committedAt = normalizeDate(input.committedAt ?? new Date(), "committedAt");
  if (!Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration < 1) {
    inputError("leaseGeneration 无效。");
  }
  const fencingTokenHash = hashExecutionFencingToken(input.fencingToken);

  return withWorkbenchTransaction(db, async (transaction) => {
    const call = await transaction.workbenchToolCallRecord.findUnique({
      where: { id: callId }
    });
    if (!call) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_TOOL_CALL_NOT_FOUND",
        "找不到待提交回执的工具调用。"
      );
    }
    if (
      call.leaseGeneration !== input.leaseGeneration ||
      call.fencingTokenHash !== fencingTokenHash
    ) {
      throw new WorkbenchExecutionLeaseStaleError();
    }
    await touchExecutionLease(transaction, {
      leaseId: call.executionLeaseId,
      taskId: call.taskId,
      runId: call.runId,
      stepId: call.stepId,
      generation: input.leaseGeneration,
      fencingTokenHash,
      now: committedAt
    });
    if (verificationId) {
      const verification = await transaction.workbenchVerificationRecord.findUnique({
        where: { id: verificationId },
        select: { taskId: true, runId: true }
      });
      if (
        !verification ||
        verification.taskId !== call.taskId ||
        verification.runId !== call.runId
      ) {
        throw new WorkbenchDurableLedgerError(
          "WORKBENCH_DURABLE_SCOPE_MISMATCH",
          "verification 与 tool call 的 task/run 不一致。"
        );
      }
    }
    const existing = await transaction.workbenchToolReceiptRecord.findUnique({
      where: { callId }
    });
    if (existing) {
      const same =
        existing.status === input.status &&
        existing.safeOutputSummary === safeOutputSummary &&
        existing.outputHash === outputHash &&
        existing.evidenceRefsJson === evidenceRefsJson &&
        existing.beforeRefJson === beforeRefJson &&
        existing.afterRefJson === afterRefJson &&
        existing.verificationId === verificationId &&
        existing.compensationRef === compensationRef &&
        existing.observedAt.getTime() === observedAt.getTime();
      if (same) return existing;
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_TOOL_RECEIPT_IMMUTABLE",
        "工具调用已绑定另一份不可变回执。"
      );
    }
    if (!["requested", "running"].includes(call.status)) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_TOOL_CALL_TERMINAL",
        "工具调用已经进入终态。"
      );
    }
    const completed = await transaction.workbenchToolCallRecord.updateMany({
      where: {
        id: callId,
        status: { in: ["requested", "running"] },
        leaseGeneration: input.leaseGeneration,
        fencingTokenHash
      },
      data: { status: input.status, completedAt: committedAt }
    });
    if (completed.count !== 1) throw new WorkbenchExecutionLeaseStaleError();
    return transaction.workbenchToolReceiptRecord.create({
      data: {
        id,
        callId,
        status: input.status,
        safeOutputSummary,
        outputHash,
        evidenceRefsJson,
        beforeRefJson,
        afterRefJson,
        verificationId,
        compensationRef,
        containsForumText: false,
        containsIdentity: false,
        observedAt
      }
    });
  });
}

export type RecordVerificationInput = {
  id?: string;
  taskId: string;
  runId: string;
  subjectType:
    | "tool_result"
    | "evidence"
    | "artifact_version"
    | "target"
    | "stage_transaction";
  subjectId: string;
  verifier: string;
  verifierVersion: string;
  status: "passed" | "failed" | "unknown";
  safeSummary: string;
  checks: readonly VerificationCheck[];
  evidenceRefs: readonly DurableEvidenceRef[];
  observedAt: Date | string;
  expiresAt?: Date | string | null;
  executionLeaseId: string;
  stepId: string;
  leaseGeneration: number;
  fencingToken: string;
  committedAt?: Date | string;
};

export async function recordVerification(
  db: WorkbenchDb,
  input: RecordVerificationInput
): Promise<WorkbenchVerificationRecord> {
  const id = assertOpaqueId(input.id ?? randomUUID(), "id");
  const taskId = assertOpaqueId(input.taskId, "taskId");
  const runId = assertOpaqueId(input.runId, "runId");
  const executionLeaseId = assertOpaqueId(
    input.executionLeaseId,
    "executionLeaseId"
  );
  const stepId = assertOpaqueId(input.stepId, "stepId");
  if (!Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration < 1) {
    inputError("leaseGeneration 无效。");
  }
  const fencingTokenHash = hashExecutionFencingToken(input.fencingToken);
  if (
    ![
      "tool_result",
      "evidence",
      "artifact_version",
      "target",
      "stage_transaction"
    ].includes(input.subjectType)
  ) {
    inputError("subjectType 无效。");
  }
  const subjectId = assertOpaqueRef(input.subjectId, "subjectId");
  const verifier = assertToolName(input.verifier, "verifier");
  const verifierVersion = assertVersion(input.verifierVersion, "verifierVersion");
  if (!["passed", "failed", "unknown"].includes(input.status)) {
    inputError("verification status 无效。");
  }
  const safeSummary = assertSafeSummary(input.safeSummary, "safeSummary");
  if (!Array.isArray(input.checks) || input.checks.length < 1 || input.checks.length > 256) {
    inputError("checks 数量无效。");
  }
  const checks = input.checks.map((check, index) => {
    if (!check || typeof check !== "object") inputError(`checks[${index}] 无效。`);
    if (!["passed", "failed", "unknown", "not_evaluated"].includes(check.status)) {
      inputError(`checks[${index}].status 无效。`);
    }
    return {
      code: assertVersion(check.code, `checks[${index}].code`),
      status: check.status,
      safeSummary: assertSafeSummary(
        check.safeSummary,
        `checks[${index}].safeSummary`
      )
    };
  });
  const checksJson = serializeSafeDurableValue(checks, "checks");
  const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs);
  const evidenceRefsJson = serializeSafeDurableValue(evidenceRefs, "evidenceRefs");
  const observedAt = normalizeDate(input.observedAt, "observedAt");
  const committedAt = normalizeDate(input.committedAt ?? new Date(), "committedAt");
  const expiresAt = input.expiresAt
    ? normalizeDate(input.expiresAt, "expiresAt")
    : null;
  if (expiresAt && expiresAt <= observedAt) inputError("expiresAt 必须晚于 observedAt。");

  return withWorkbenchTransaction(db, async (transaction) => {
    await assertTaskRunScope(transaction, { taskId, runId });
    await assertPlanStepScope(transaction, { taskId, runId, stepId });
    await touchExecutionLease(transaction, {
      leaseId: executionLeaseId,
      taskId,
      runId,
      stepId,
      generation: input.leaseGeneration,
      fencingTokenHash,
      now: committedAt
    });
    const existing = await transaction.workbenchVerificationRecord.findUnique({
      where: { id }
    });
    if (existing) {
      const same =
        existing.taskId === taskId &&
        existing.runId === runId &&
        existing.subjectType === input.subjectType &&
        existing.subjectId === subjectId &&
        existing.verifier === verifier &&
        existing.verifierVersion === verifierVersion &&
        existing.status === input.status &&
        existing.safeSummary === safeSummary &&
        existing.checksJson === checksJson &&
        existing.evidenceRefsJson === evidenceRefsJson &&
        existing.observedAt.getTime() === observedAt.getTime() &&
        (existing.expiresAt?.getTime() ?? null) === (expiresAt?.getTime() ?? null);
      if (same) return existing;
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_VERIFICATION_IMMUTABLE",
        "verification id 已绑定另一份不可变回执。"
      );
    }
    return transaction.workbenchVerificationRecord.create({
      data: {
        id,
        taskId,
        runId,
        subjectType: input.subjectType,
        subjectId,
        verifier,
        verifierVersion,
        status: input.status,
        safeSummary,
        checksJson,
        evidenceRefsJson,
        observedAt,
        expiresAt,
        containsForumText: false,
        containsIdentity: false
      }
    });
  });
}
