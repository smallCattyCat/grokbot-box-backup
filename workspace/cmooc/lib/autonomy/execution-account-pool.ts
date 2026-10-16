import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
  ExecutionAccountLease,
  PrismaClient
} from "@prisma/client";

export const EXECUTION_ACCOUNT_POOL_SCHEMA_VERSION =
  "cmooc.execution-account-pool.v1" as const;

export const EXECUTION_ACCOUNT_ROLE_KEYS = [
  "socratic_guide",
  "evidence_connector",
  "reflection_coach",
  "community_host"
] as const;

export type ExecutionAccountRoleKey =
  (typeof EXECUTION_ACCOUNT_ROLE_KEYS)[number];

export type ExecutionAccountDescriptor = {
  accountRefHash: string;
  credentialRefHash: string;
  roleKey: ExecutionAccountRoleKey;
  courseAliases: readonly string[];
  dailyActionLimit: number;
  cooldownMinutes: number;
  disclosedAi: true;
  containsForumText: false;
};

export type ExecutionAccountLeaseStatus =
  | "active"
  | "expired"
  | "consumed"
  | "released";

/**
 * Public lease output deliberately contains only opaque hashes, enums,
 * timestamps, counts and booleans.  The database id is itself a SHA-256
 * opaque value so callers can bind it to an ExecutionPermit without exposing
 * an account identity or credential material.
 */
export type ExecutionAccountLeaseSummary = {
  leaseId: string;
  leaseKey: string;
  accountRefHash: string;
  credentialRefHash: string;
  roleKey: ExecutionAccountRoleKey;
  status: ExecutionAccountLeaseStatus;
  expiresAt: Date;
  consumedAt: Date | null;
  releasedAt: Date | null;
  consumedToday: number;
  idempotent: boolean;
  containsForumText: false;
};

export type PrismaLike = PrismaClient | Prisma.TransactionClient;

type LeaseLookup = {
  leaseKey?: string;
  leaseId?: string;
  decisionId?: string;
  accountRefHash?: string;
};

type LeaseTransitionInput = LeaseLookup & {
  prisma: PrismaClient;
  accountRefHash?: string;
  now?: Date;
};

/**
 * Strict, transaction-scoped lease binding facts.  Callers must provide only
 * opaque hashes/identifiers; this shape deliberately has no credential or
 * platform identity fields.
 */
export type ExecutionAccountLeaseBinding = {
  executionAccountLeaseId: string;
  accountRefHash: string;
  credentialRefHash: string;
  decisionId: string;
  invocationId: string;
  courseAlias: string;
  roleKey?: ExecutionAccountRoleKey;
  now: Date;
};

export type AcquireExecutionAccountInput = {
  prisma: PrismaClient;
  courseAlias: string;
  invocationId: string;
  decisionId: string;
  accounts?: readonly ExecutionAccountDescriptor[];
  pool?: readonly ExecutionAccountDescriptor[];
  descriptors?: readonly ExecutionAccountDescriptor[];
  now?: Date;
  validForMinutes?: number;
  leaseDurationMinutes?: number;
  leaseMinutes?: number;
};

const HEX_64 = /^[a-f0-9]{64}$/;
const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ROLE_KEYS = new Set<string>(EXECUTION_ACCOUNT_ROLE_KEYS);
const MAX_TRANSACTION_RETRIES = 3;
const DEFAULT_LEASE_MINUTES = 15;

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isRetryableTransactionError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "P2002" || code === "P2034" || code === "P2028") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY|SQLITE_LOCKED|deadlock/i.test(message);
}

async function withSerializableRetry<T>(
  prisma: PrismaClient,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
    } catch (error) {
      lastError = error;
      if (
        !isRetryableTransactionError(error) ||
        attempt + 1 >= MAX_TRANSACTION_RETRIES
      ) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error("EXECUTION_ACCOUNT_POOL_TRANSACTION_FAILED");
}

function validDate(value: Date | undefined, label: string): Date {
  const date = value ?? new Date();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error(`${label}_INVALID`);
  }
  return date;
}

function validHash(value: unknown, code: string): string {
  if (typeof value !== "string" || !HEX_64.test(value)) {
    throw new Error(code);
  }
  return value;
}

function validAlias(value: unknown, code: string): string {
  if (typeof value !== "string" || !SAFE_ALIAS.test(value)) {
    throw new Error(code);
  }
  return value;
}

function validIdentifier(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new Error(code);
  }
  return value;
}

function normalizeDescriptor(
  input: ExecutionAccountDescriptor
): ExecutionAccountDescriptor {
  if (!input || typeof input !== "object") {
    throw new Error("EXECUTION_ACCOUNT_DESCRIPTOR_INVALID");
  }
  const accountRefHash = validHash(
    input.accountRefHash,
    "EXECUTION_ACCOUNT_REF_HASH_INVALID"
  );
  const credentialRefHash = validHash(
    input.credentialRefHash,
    "EXECUTION_CREDENTIAL_REF_HASH_INVALID"
  );
  if (
    typeof input.roleKey !== "string" ||
    !ROLE_KEYS.has(input.roleKey)
  ) {
    throw new Error("EXECUTION_ACCOUNT_ROLE_INVALID");
  }
  if (
    !Array.isArray(input.courseAliases) ||
    input.courseAliases.length === 0
  ) {
    throw new Error("EXECUTION_ACCOUNT_COURSE_SCOPE_REQUIRED");
  }
  const courseAliases = [
    ...new Set(
      input.courseAliases.map((alias) =>
        validAlias(alias, "EXECUTION_ACCOUNT_COURSE_ALIAS_INVALID")
      )
    )
  ].sort();
  if (
    !Number.isSafeInteger(input.dailyActionLimit) ||
    input.dailyActionLimit < 1 ||
    input.dailyActionLimit > 5
  ) {
    throw new Error("EXECUTION_ACCOUNT_DAILY_LIMIT_INVALID");
  }
  if (
    !Number.isSafeInteger(input.cooldownMinutes) ||
    input.cooldownMinutes < 0 ||
    input.cooldownMinutes > 1440
  ) {
    throw new Error("EXECUTION_ACCOUNT_COOLDOWN_INVALID");
  }
  if (input.disclosedAi !== true) {
    throw new Error("EXECUTION_ACCOUNT_DISCLOSURE_REQUIRED");
  }
  if (input.containsForumText !== false) {
    throw new Error("EXECUTION_ACCOUNT_FORUM_TEXT_FORBIDDEN");
  }
  return {
    accountRefHash,
    credentialRefHash,
    roleKey: input.roleKey,
    courseAliases,
    dailyActionLimit: input.dailyActionLimit,
    cooldownMinutes: input.cooldownMinutes,
    disclosedAi: true,
    containsForumText: false
  };
}

function normalizePool(
  input: readonly ExecutionAccountDescriptor[] | undefined
): ExecutionAccountDescriptor[] {
  if (!input || input.length === 0) {
    throw new Error("EXECUTION_ACCOUNT_POOL_EMPTY");
  }
  const byHash = new Map<string, ExecutionAccountDescriptor>();
  for (const raw of input) {
    const descriptor = normalizeDescriptor(raw);
    const existing = byHash.get(descriptor.accountRefHash);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(descriptor)) {
        throw new Error("EXECUTION_ACCOUNT_DESCRIPTOR_CONFLICT");
      }
      continue;
    }
    byHash.set(descriptor.accountRefHash, descriptor);
  }
  return [...byHash.values()];
}

function validLeaseMinutes(value: number | undefined): number {
  const minutes = value ?? DEFAULT_LEASE_MINUTES;
  if (
    !Number.isSafeInteger(minutes) ||
    minutes < 1 ||
    minutes > 1440
  ) {
    throw new Error("EXECUTION_ACCOUNT_LEASE_DURATION_INVALID");
  }
  return minutes;
}

function dayBounds(now: Date): { start: Date; end: Date } {
  const budgetDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
  const start = new Date(`${budgetDate}T00:00:00+08:00`);
  return {
    start,
    end: new Date(start.getTime() + 24 * 60 * 60_000)
  };
}

async function consumedToday(
  prisma: PrismaLike,
  accountRefHash: string,
  now: Date
): Promise<number> {
  const bounds = dayBounds(now);
  return prisma.executionAccountLease.count({
    where: {
      accountRefHash,
      status: "consumed",
      consumedAt: {
        gte: bounds.start,
        lt: bounds.end,
        lte: now
      }
    }
  });
}

async function lastConsumedAt(
  prisma: PrismaLike,
  accountRefHash: string
): Promise<Date | null> {
  const latest = await prisma.executionAccountLease.findFirst({
    where: {
      accountRefHash,
      status: "consumed",
      consumedAt: { not: null }
    },
    orderBy: { consumedAt: "desc" },
    select: { consumedAt: true }
  });
  return latest?.consumedAt ?? null;
}

async function assertBinding(
  prisma: PrismaLike,
  input: Pick<AcquireExecutionAccountInput, "courseAlias" | "invocationId" | "decisionId">
): Promise<void> {
  const courseAlias = validAlias(
    input.courseAlias,
    "EXECUTION_ACCOUNT_COURSE_ALIAS_INVALID"
  );
  const invocation = await prisma.scheduledInvocation.findUnique({
    where: { id: input.invocationId },
    select: { courseAlias: true }
  });
  if (!invocation) {
    throw new Error("EXECUTION_ACCOUNT_INVOCATION_NOT_FOUND");
  }
  if (invocation.courseAlias !== courseAlias) {
    throw new Error("EXECUTION_ACCOUNT_INVOCATION_COURSE_MISMATCH");
  }
  const decision = await prisma.autonomyDecision.findUnique({
    where: { id: input.decisionId },
    select: { invocationId: true, courseAlias: true }
  });
  if (!decision) {
    throw new Error("EXECUTION_ACCOUNT_DECISION_NOT_FOUND");
  }
  if (
    decision.invocationId !== input.invocationId ||
    decision.courseAlias !== courseAlias
  ) {
    throw new Error("EXECUTION_ACCOUNT_DECISION_BINDING_MISMATCH");
  }
}

function opaqueKey(label: string): string {
  return createHash("sha256")
    .update(`${EXECUTION_ACCOUNT_POOL_SCHEMA_VERSION}:${label}:${randomUUID()}`)
    .digest("hex");
}

function leaseStatus(value: string): ExecutionAccountLeaseStatus {
  if (
    value !== "active" &&
    value !== "expired" &&
    value !== "consumed" &&
    value !== "released"
  ) {
    throw new Error("EXECUTION_ACCOUNT_LEASE_STATUS_INVALID");
  }
  return value;
}

function roleKey(value: string): ExecutionAccountRoleKey {
  if (!ROLE_KEYS.has(value)) {
    throw new Error("EXECUTION_ACCOUNT_ROLE_INVALID");
  }
  return value as ExecutionAccountRoleKey;
}

function summary(
  lease: ExecutionAccountLease,
  count: number,
  idempotent: boolean
): ExecutionAccountLeaseSummary {
  return {
    leaseId: validHash(lease.id, "EXECUTION_ACCOUNT_LEASE_ID_INVALID"),
    leaseKey: validHash(lease.leaseKey, "EXECUTION_ACCOUNT_LEASE_KEY_INVALID"),
    accountRefHash: validHash(
      lease.accountRefHash,
      "EXECUTION_ACCOUNT_REF_HASH_INVALID"
    ),
    credentialRefHash: validHash(
      lease.credentialRefHash,
      "EXECUTION_CREDENTIAL_REF_HASH_INVALID"
    ),
    roleKey: roleKey(lease.roleKey),
    status: leaseStatus(lease.status),
    expiresAt: lease.expiresAt,
    consumedAt: lease.consumedAt,
    releasedAt: lease.releasedAt,
    consumedToday: count,
    idempotent,
    containsForumText: false
  };
}

type Candidate = {
  descriptor: ExecutionAccountDescriptor;
  consumedToday: number;
  lastConsumedAt: Date | null;
};

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.consumedToday !== right.consumedToday) {
    return left.consumedToday - right.consumedToday;
  }
  if (left.lastConsumedAt === null && right.lastConsumedAt !== null) return -1;
  if (left.lastConsumedAt !== null && right.lastConsumedAt === null) return 1;
  if (left.lastConsumedAt && right.lastConsumedAt) {
    const byTime = left.lastConsumedAt.getTime() - right.lastConsumedAt.getTime();
    if (byTime !== 0) return byTime;
  }
  return left.descriptor.accountRefHash.localeCompare(
    right.descriptor.accountRefHash
  );
}

export async function acquire(
  input: AcquireExecutionAccountInput
): Promise<ExecutionAccountLeaseSummary> {
  const now = validDate(input.now, "EXECUTION_ACCOUNT_NOW");
  validAlias(input.courseAlias, "EXECUTION_ACCOUNT_COURSE_ALIAS_INVALID");
  validIdentifier(input.invocationId, "EXECUTION_ACCOUNT_INVOCATION_ID_INVALID");
  validIdentifier(input.decisionId, "EXECUTION_ACCOUNT_DECISION_ID_INVALID");
  const accounts = normalizePool(
    input.accounts ?? input.pool ?? input.descriptors
  );
  const leaseMinutes = validLeaseMinutes(
    input.validForMinutes ?? input.leaseDurationMinutes ?? input.leaseMinutes
  );
  const courseAlias = input.courseAlias;

  return withSerializableRetry(input.prisma, async (transaction) => {
    await transaction.executionAccountLease.updateMany({
      where: { status: "active", expiresAt: { lte: now } },
      data: { status: "expired" }
    });
    await assertBinding(transaction, input);

    const existing = await transaction.executionAccountLease.findUnique({
      where: { decisionId: input.decisionId }
    });
    if (existing) {
      const status = leaseStatus(existing.status);
      const boundDescriptor = accounts.find(
        (account) =>
          account.accountRefHash === existing.accountRefHash &&
          account.courseAliases.includes(courseAlias)
      );
      if (
        !boundDescriptor ||
        boundDescriptor.credentialRefHash !== existing.credentialRefHash ||
        boundDescriptor.roleKey !== existing.roleKey
      ) {
        throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
      }
      if (status === "active" && existing.expiresAt.getTime() > now.getTime()) {
        return summary(
          existing,
          await consumedToday(transaction, existing.accountRefHash, now),
          true
        );
      }
      if (status === "active") {
        await transaction.executionAccountLease.updateMany({
          where: { id: existing.id, status: "active" },
          data: { status: "expired" }
        });
      }
      throw new Error("EXECUTION_ACCOUNT_DECISION_ALREADY_BOUND");
    }

    const candidates: Candidate[] = [];
    let activeBlocked = 0;
    let dailyBlocked = 0;
    let cooldownBlocked = 0;
    for (const descriptor of accounts) {
      if (!descriptor.courseAliases.includes(courseAlias)) continue;
      const active = await transaction.executionAccountLease.findFirst({
        where: { accountRefHash: descriptor.accountRefHash, status: "active" },
        select: { id: true }
      });
      if (active) {
        activeBlocked += 1;
        continue;
      }
      const count = await consumedToday(
        transaction,
        descriptor.accountRefHash,
        now
      );
      if (count >= descriptor.dailyActionLimit) {
        dailyBlocked += 1;
        continue;
      }
      const latest = await lastConsumedAt(
        transaction,
        descriptor.accountRefHash
      );
      if (
        latest &&
        now.getTime() - latest.getTime() < descriptor.cooldownMinutes * 60_000
      ) {
        cooldownBlocked += 1;
        continue;
      }
      candidates.push({
        descriptor,
        consumedToday: count,
        lastConsumedAt: latest
      });
    }
    if (candidates.length === 0) {
      const scoped = accounts.filter((account) =>
        account.courseAliases.includes(courseAlias)
      );
      if (scoped.length === 0) {
        throw new Error("EXECUTION_ACCOUNT_COURSE_SCOPE_INVALID");
      }
      if (dailyBlocked === scoped.length) {
        throw new Error("EXECUTION_ACCOUNT_DAILY_LIMIT_EXCEEDED");
      }
      if (cooldownBlocked === scoped.length) {
        throw new Error("EXECUTION_ACCOUNT_COOLDOWN_ACTIVE");
      }
      if (activeBlocked === scoped.length) {
        throw new Error("EXECUTION_ACCOUNT_ACTIVE");
      }
      throw new Error("EXECUTION_ACCOUNT_POOL_EXHAUSTED");
    }
    candidates.sort(compareCandidates);
    const selected = candidates[0];
    const leaseKey = opaqueKey(
      `${input.courseAlias}:${input.invocationId}:${input.decisionId}:${selected.descriptor.accountRefHash}`
    );
    const id = opaqueKey(`id:${leaseKey}`);
    const lease = await transaction.executionAccountLease.create({
      data: {
        id,
        leaseKey,
        accountRefHash: selected.descriptor.accountRefHash,
        credentialRefHash: selected.descriptor.credentialRefHash,
        roleKey: selected.descriptor.roleKey,
        courseAlias,
        invocationId: input.invocationId,
        decisionId: input.decisionId,
        status: "active",
        expiresAt: new Date(now.getTime() + leaseMinutes * 60_000),
        consumedAt: null,
        releasedAt: null
      }
    });
    return summary(lease, selected.consumedToday, false);
  });
}

function lookupWhere(input: LeaseLookup):
  | { leaseKey: string }
  | { id: string }
  | { decisionId: string } {
  if (input.leaseKey) {
    return {
      leaseKey: validHash(
        input.leaseKey,
        "EXECUTION_ACCOUNT_LEASE_KEY_INVALID"
      )
    };
  }
  if (input.leaseId) {
    return {
      id: validHash(input.leaseId, "EXECUTION_ACCOUNT_LEASE_ID_INVALID")
    };
  }
  if (input.decisionId) {
    return {
      decisionId: validIdentifier(
        input.decisionId,
        "EXECUTION_ACCOUNT_DECISION_ID_INVALID"
      )
    };
  }
  throw new Error("EXECUTION_ACCOUNT_LEASE_LOOKUP_REQUIRED");
}

export async function loadActive(
  input: LeaseLookup & { prisma: PrismaClient; now?: Date }
): Promise<ExecutionAccountLeaseSummary | null> {
  const now = validDate(input.now, "EXECUTION_ACCOUNT_NOW");
  const where = lookupWhere(input);
  return withSerializableRetry(input.prisma, async (transaction) => {
    const lease = await transaction.executionAccountLease.findUnique({ where });
    if (!lease) return null;
    if (input.accountRefHash) {
      validHash(input.accountRefHash, "EXECUTION_ACCOUNT_REF_HASH_INVALID");
      if (lease.accountRefHash !== input.accountRefHash) {
        throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
      }
    }
    if (lease.status !== "active") return null;
    if (lease.expiresAt.getTime() <= now.getTime()) {
      await transaction.executionAccountLease.updateMany({
        where: { id: lease.id, status: "active" },
        data: { status: "expired" }
      });
      return null;
    }
    return summary(
      lease,
      await consumedToday(transaction, lease.accountRefHash, now),
      false
    );
  });
}

function normalizeLeaseBinding(
  input: ExecutionAccountLeaseBinding
): ExecutionAccountLeaseBinding {
  if (!input || typeof input !== "object") {
    throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_INVALID");
  }
  return {
    executionAccountLeaseId: validHash(
      input.executionAccountLeaseId,
      "EXECUTION_ACCOUNT_LEASE_ID_INVALID"
    ),
    accountRefHash: validHash(
      input.accountRefHash,
      "EXECUTION_ACCOUNT_REF_HASH_INVALID"
    ),
    credentialRefHash: validHash(
      input.credentialRefHash,
      "EXECUTION_CREDENTIAL_REF_HASH_INVALID"
    ),
    decisionId: validIdentifier(
      input.decisionId,
      "EXECUTION_ACCOUNT_DECISION_ID_INVALID"
    ),
    invocationId: validIdentifier(
      input.invocationId,
      "EXECUTION_ACCOUNT_INVOCATION_ID_INVALID"
    ),
    courseAlias: validAlias(
      input.courseAlias,
      "EXECUTION_ACCOUNT_COURSE_ALIAS_INVALID"
    ),
    roleKey:
      input.roleKey === undefined
        ? undefined
        : roleKey(input.roleKey),
    now: validDate(input.now, "EXECUTION_ACCOUNT_NOW")
  };
}

type StrictLeaseStatus = "active" | "consumed" | "released" | "expired";

/**
 * Read and assert a lease inside an existing transaction.  This is the only
 * account binding primitive used by permits/attempts: it checks every
 * persisted binding column, the related decision/invocation scope and the
 * requested lifecycle status without exposing account material.
 */
export async function assertExecutionAccountLeaseBinding(
  input: ExecutionAccountLeaseBinding & {
    prisma: Prisma.TransactionClient;
    status?: StrictLeaseStatus;
  }
): Promise<ExecutionAccountLease> {
  const binding = normalizeLeaseBinding(input);
  const lease = await input.prisma.executionAccountLease.findUnique({
    where: { id: binding.executionAccountLeaseId }
  });
  if (!lease) {
    throw new Error("EXECUTION_ACCOUNT_LEASE_NOT_FOUND");
  }
  const invocation = await input.prisma.scheduledInvocation.findUnique({
    where: { id: binding.invocationId },
    select: { courseAlias: true }
  });
  if (!invocation) {
    throw new Error("EXECUTION_ACCOUNT_INVOCATION_NOT_FOUND");
  }
  const decision = await input.prisma.autonomyDecision.findUnique({
    where: { id: binding.decisionId },
    select: { invocationId: true, courseAlias: true }
  });
  if (!decision) {
    throw new Error("EXECUTION_ACCOUNT_DECISION_NOT_FOUND");
  }
  if (
    lease.accountRefHash !== binding.accountRefHash ||
    lease.credentialRefHash !== binding.credentialRefHash ||
    lease.decisionId !== binding.decisionId ||
    lease.invocationId !== binding.invocationId ||
    lease.courseAlias !== binding.courseAlias ||
    invocation.courseAlias !== binding.courseAlias ||
    decision.invocationId !== binding.invocationId ||
    decision.courseAlias !== binding.courseAlias
  ) {
    throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
  }
  const persistedRole = roleKey(lease.roleKey);
  if (binding.roleKey !== undefined && persistedRole !== binding.roleKey) {
    throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
  }
  const status = leaseStatus(lease.status);
  if (status === "active" && lease.expiresAt.getTime() <= binding.now.getTime()) {
    await input.prisma.executionAccountLease.updateMany({
      where: { id: lease.id, status: "active" },
      data: { status: "expired" }
    });
    throw new Error("EXECUTION_ACCOUNT_LEASE_EXPIRED");
  }
  const expectedStatus = input.status ?? "active";
  if (status !== expectedStatus) {
    if (status === "expired") {
      throw new Error("EXECUTION_ACCOUNT_LEASE_EXPIRED");
    }
    if (status === "consumed") {
      throw new Error("EXECUTION_ACCOUNT_LEASE_ALREADY_CONSUMED");
    }
    if (status === "released") {
      throw new Error("EXECUTION_ACCOUNT_LEASE_ALREADY_RELEASED");
    }
    throw new Error("EXECUTION_ACCOUNT_LEASE_NOT_ACTIVE");
  }
  return lease;
}

/** Alias emphasizing that this operation is intended for a transaction. */
export const loadExecutionAccountLeaseForBinding =
  assertExecutionAccountLeaseBinding;
export const loadExecutionAccountLeaseInTransaction =
  assertExecutionAccountLeaseBinding;

async function transitionExecutionAccountLeaseInTransaction(
  input: ExecutionAccountLeaseBinding & {
    prisma: Prisma.TransactionClient;
  },
  target: "consumed" | "released"
): Promise<ExecutionAccountLease> {
  const binding = normalizeLeaseBinding(input);
  const lease = await assertExecutionAccountLeaseBinding({
    ...binding,
    prisma: input.prisma,
    status: "active"
  });
  const changed = await input.prisma.executionAccountLease.updateMany({
    where: {
      id: lease.id,
      status: "active",
      expiresAt: { gt: binding.now }
    },
    data:
      target === "consumed"
        ? { status: "consumed", consumedAt: binding.now }
        : { status: "released", releasedAt: binding.now }
  });
  if (changed.count !== 1) {
    const raced = await input.prisma.executionAccountLease.findUnique({
      where: { id: lease.id }
    });
    if (raced?.status === target) {
      return raced;
    }
    throw new Error("EXECUTION_ACCOUNT_LEASE_CAS_CONFLICT");
  }
  return input.prisma.executionAccountLease.findUniqueOrThrow({
    where: { id: lease.id }
  });
}

export async function consumeExecutionAccountLeaseInTransaction(
  input: ExecutionAccountLeaseBinding & {
    prisma: Prisma.TransactionClient;
  }
): Promise<ExecutionAccountLease> {
  return transitionExecutionAccountLeaseInTransaction(input, "consumed");
}

export async function releaseExecutionAccountLeaseInTransaction(
  input: ExecutionAccountLeaseBinding & {
    prisma: Prisma.TransactionClient;
  }
): Promise<ExecutionAccountLease> {
  return transitionExecutionAccountLeaseInTransaction(input, "released");
}

export const consumeExecutionAccountLeaseTx =
  consumeExecutionAccountLeaseInTransaction;
export const releaseExecutionAccountLeaseTx =
  releaseExecutionAccountLeaseInTransaction;

async function transition(
  input: LeaseTransitionInput,
  target: "consumed" | "released"
): Promise<ExecutionAccountLeaseSummary> {
  const now = validDate(input.now, "EXECUTION_ACCOUNT_NOW");
  const where = lookupWhere(input);
  if (input.accountRefHash) {
    validHash(input.accountRefHash, "EXECUTION_ACCOUNT_REF_HASH_INVALID");
  }
  return withSerializableRetry(input.prisma, async (transaction) => {
    const lease = await transaction.executionAccountLease.findUnique({ where });
    if (!lease) throw new Error("EXECUTION_ACCOUNT_LEASE_NOT_FOUND");
    if (
      input.accountRefHash &&
      lease.accountRefHash !== input.accountRefHash
    ) {
      throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
    }
    if (input.decisionId && lease.decisionId !== input.decisionId) {
      throw new Error("EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH");
    }
    const currentStatus = leaseStatus(lease.status);
    if (currentStatus === target) {
      return summary(
        lease,
        await consumedToday(transaction, lease.accountRefHash, now),
        true
      );
    }
    if (currentStatus === "consumed") {
      throw new Error("EXECUTION_ACCOUNT_LEASE_ALREADY_CONSUMED");
    }
    if (currentStatus === "released") {
      throw new Error("EXECUTION_ACCOUNT_LEASE_ALREADY_RELEASED");
    }
    if (currentStatus === "expired") {
      throw new Error("EXECUTION_ACCOUNT_LEASE_EXPIRED");
    }
    if (lease.expiresAt.getTime() <= now.getTime()) {
      await transaction.executionAccountLease.updateMany({
        where: { id: lease.id, status: "active" },
        data: { status: "expired" }
      });
      throw new Error("EXECUTION_ACCOUNT_LEASE_EXPIRED");
    }
    const updated = await transaction.executionAccountLease.updateMany({
      where: {
        id: lease.id,
        status: "active",
        expiresAt: { gt: now }
      },
      data:
        target === "consumed"
          ? { status: target, consumedAt: now }
          : { status: target, releasedAt: now }
    });
    if (updated.count !== 1) {
      const raced = await transaction.executionAccountLease.findUnique({
        where: { id: lease.id }
      });
      if (raced?.status === target) {
        return summary(
          raced,
          await consumedToday(transaction, raced.accountRefHash, now),
          true
        );
      }
      throw new Error("EXECUTION_ACCOUNT_LEASE_CAS_CONFLICT");
    }
    const transitioned = await transaction.executionAccountLease.findUniqueOrThrow({
      where: { id: lease.id }
    });
    return summary(
      transitioned,
      await consumedToday(transaction, transitioned.accountRefHash, now),
      false
    );
  });
}

export async function consume(
  input: LeaseTransitionInput
): Promise<ExecutionAccountLeaseSummary> {
  return transition(input, "consumed");
}

export async function release(
  input: LeaseTransitionInput
): Promise<ExecutionAccountLeaseSummary> {
  return transition(input, "released");
}

export const acquireExecutionAccountLease = acquire;
export const loadActiveExecutionAccountLease = loadActive;
export const consumeExecutionAccountLease = consume;
export const releaseExecutionAccountLease = release;
