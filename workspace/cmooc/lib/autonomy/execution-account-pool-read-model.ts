import { prisma as defaultPrisma } from "@/lib/db";
import {
  CMOOC_EXECUTION_ACCOUNT_ROLE_KEYS,
  type CmoocExecutionAccountDescriptor,
  type CmoocExecutionAccountRoleKey
} from "@/lib/forum/cmooc-execution-account-config";

export const CMOOC_EXECUTION_ACCOUNT_POOL_READ_MODEL_SCHEMA_VERSION =
  "cmooc.execution-agent-pool-read-model.v1" as const;

export type SafeExecutionAgentPoolConfigurationState =
  | "ready"
  | "not_configured"
  | "unavailable";

export type SafeExecutionAgentRoleSummary = {
  roleKey: CmoocExecutionAccountRoleKey;
  configuredAgentCount: number;
  availableAgentCount: number;
  activeAgentCount: number;
  cooldownAgentCount: number;
  dailyLimitReachedAgentCount: number;
  consumedLeaseCountToday: number;
};

/**
 * Public dashboard/API projection.  Only counts, fixed role enums and stable
 * state values are allowed here; account hashes, database identifiers,
 * credentials, URLs and forum material never enter this shape.
 */
export type SafeExecutionAgentPoolSummary = {
  schemaVersion: typeof CMOOC_EXECUTION_ACCOUNT_POOL_READ_MODEL_SCHEMA_VERSION;
  scope: "enabled_courses";
  configurationState: SafeExecutionAgentPoolConfigurationState;
  configuredAgentCount: number;
  configuredRoleCount: number;
  availableAgentCount: number;
  activeAgentCount: number;
  cooldownAgentCount: number;
  dailyLimitReachedAgentCount: number;
  consumedLeaseCountToday: number;
  roles: SafeExecutionAgentRoleSummary[];
  containsAccountIdentity: false;
  containsCredentialMaterial: false;
  containsForumText: false;
};

type ReadModelPrisma = {
  autonomyCourseManifest: {
    findMany: (args: unknown) => Promise<unknown>;
  };
  executionAccountLease: {
    findMany: (args: unknown) => Promise<unknown>;
  };
};

type RuntimeLike = {
  listDescriptors: () => CmoocExecutionAccountDescriptor[];
};

async function loadDefaultRuntime(): Promise<RuntimeLike> {
  // Keep environment/auth loading out of pure read-model tests.  Production
  // callers still resolve the configured runtime through cmooc-api here.
  const cmoocApi = await import("@/lib/forum/cmooc-api");
  return cmoocApi.loadCmoocExecutionAccountRuntime();
}

export type SafeExecutionAgentPoolSummaryInput = {
  /** Injected only for deterministic tests or a request-scoped Prisma client. */
  prisma?: unknown;
  now?: Date;
  runtime?: RuntimeLike;
  runtimeLoader?: () => Promise<RuntimeLike> | RuntimeLike;
};

type LeaseRead = {
  accountRefHash?: unknown;
  status?: unknown;
  expiresAt?: unknown;
  consumedAt?: unknown;
};

const HASH_PATTERN = /^[a-f0-9]{64}$/;

function roleSummary(roleKey: CmoocExecutionAccountRoleKey): SafeExecutionAgentRoleSummary {
  return {
    roleKey,
    configuredAgentCount: 0,
    availableAgentCount: 0,
    activeAgentCount: 0,
    cooldownAgentCount: 0,
    dailyLimitReachedAgentCount: 0,
    consumedLeaseCountToday: 0
  };
}

function emptySummary(
  configurationState: SafeExecutionAgentPoolConfigurationState
): SafeExecutionAgentPoolSummary {
  return {
    schemaVersion: CMOOC_EXECUTION_ACCOUNT_POOL_READ_MODEL_SCHEMA_VERSION,
    scope: "enabled_courses",
    configurationState,
    configuredAgentCount: 0,
    configuredRoleCount: 0,
    availableAgentCount: 0,
    activeAgentCount: 0,
    cooldownAgentCount: 0,
    dailyLimitReachedAgentCount: 0,
    consumedLeaseCountToday: 0,
    roles: CMOOC_EXECUTION_ACCOUNT_ROLE_KEYS.map(roleSummary),
    containsAccountIdentity: false,
    containsCredentialMaterial: false,
    containsForumText: false
  };
}

function stableConfigurationState(error: unknown): SafeExecutionAgentPoolConfigurationState {
  const code = error instanceof Error ? error.message : "";
  return /EXECUTION_ACCOUNT_POOL_NOT_CONFIGURED|EXECUTION_ACCOUNT_CONFIG_NOT_CONFIGURED|CMOOC_EXECUTION_ACCOUNT_POOL_NOT_CONFIGURED|CMOOC_EXECUTION_ACCOUNT_NOT_CONFIGURED/.test(
    code
  )
    ? "not_configured"
    : "unavailable";
}

function dayBounds(now: Date): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("EXECUTION_ACCOUNT_DAY_BOUNDARY_UNAVAILABLE");
  }
  const start = new Date(`${year}-${month}-${day}T00:00:00+08:00`);
  return {
    start,
    end: new Date(start.getTime() + 24 * 60 * 60_000)
  };
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

function descriptorIsSafe(
  descriptor: CmoocExecutionAccountDescriptor
): descriptor is CmoocExecutionAccountDescriptor {
  return (
    Boolean(descriptor) &&
    HASH_PATTERN.test(descriptor.accountRefHash) &&
    HASH_PATTERN.test(descriptor.credentialRefHash) &&
    CMOOC_EXECUTION_ACCOUNT_ROLE_KEYS.includes(descriptor.roleKey) &&
    Array.isArray(descriptor.courseAliases) &&
    descriptor.courseAliases.length > 0 &&
    Number.isSafeInteger(descriptor.dailyActionLimit) &&
    descriptor.dailyActionLimit >= 1 &&
    descriptor.dailyActionLimit <= 5 &&
    Number.isSafeInteger(descriptor.cooldownMinutes) &&
    descriptor.cooldownMinutes >= 0 &&
    descriptor.cooldownMinutes <= 1_440 &&
    descriptor.disclosedAi === true &&
    descriptor.containsForumText === false
  );
}

function descriptorsEqual(
  left: CmoocExecutionAccountDescriptor,
  right: CmoocExecutionAccountDescriptor
): boolean {
  return (
    left.accountRefHash === right.accountRefHash &&
    left.credentialRefHash === right.credentialRefHash &&
    left.roleKey === right.roleKey &&
    left.dailyActionLimit === right.dailyActionLimit &&
    left.cooldownMinutes === right.cooldownMinutes &&
    left.disclosedAi === right.disclosedAi &&
    left.containsForumText === right.containsForumText &&
    left.courseAliases.length === right.courseAliases.length &&
    left.courseAliases.every(
      (alias, index) => alias === right.courseAliases[index]
    )
  );
}

function leaseRows(value: unknown): LeaseRead[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is LeaseRead =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
}

function consumedInWindow(
  row: LeaseRead,
  bounds: { start: Date; end: Date },
  now: Date
): Date | null {
  if (row.status !== "consumed") return null;
  const consumedAt = asDate(row.consumedAt);
  if (
    !consumedAt ||
    consumedAt.getTime() < bounds.start.getTime() ||
    consumedAt.getTime() >= bounds.end.getTime() ||
    consumedAt.getTime() > now.getTime()
  ) {
    return null;
  }
  return consumedAt;
}

function classifyDescriptor(input: {
  descriptor: CmoocExecutionAccountDescriptor;
  leases: LeaseRead[];
  now: Date;
  bounds: { start: Date; end: Date };
}): {
  state: "available" | "active" | "cooldown" | "daily";
  consumedLeaseCountToday: number;
} {
  const active = input.leases.some(
    (row) =>
      row.status === "active" &&
      (asDate(row.expiresAt)?.getTime() ?? Number.NEGATIVE_INFINITY) >
        input.now.getTime()
  );
  const consumedToday = input.leases
    .map((row) => consumedInWindow(row, input.bounds, input.now))
    .filter((value): value is Date => value !== null);
  if (active) {
    return {
      state: "active",
      consumedLeaseCountToday: consumedToday.length
    };
  }
  if (consumedToday.length >= input.descriptor.dailyActionLimit) {
    return {
      state: "daily",
      consumedLeaseCountToday: consumedToday.length
    };
  }
  const latestConsumed = input.leases.reduce<Date | null>((latest, row) => {
    if (row.status !== "consumed") return latest;
    const consumedAt = asDate(row.consumedAt);
    if (!consumedAt || consumedAt.getTime() > input.now.getTime()) {
      return latest;
    }
    return !latest || consumedAt.getTime() > latest.getTime()
      ? consumedAt
      : latest;
  }, null);
  if (
    latestConsumed &&
    input.now.getTime() - latestConsumed.getTime() <
      input.descriptor.cooldownMinutes * 60_000
  ) {
    return {
      state: "cooldown",
      consumedLeaseCountToday: consumedToday.length
    };
  }
  return {
    state: "available",
    consumedLeaseCountToday: consumedToday.length
  };
}

export async function getSafeExecutionAccountPoolSummary(
  input: SafeExecutionAgentPoolSummaryInput = {}
): Promise<SafeExecutionAgentPoolSummary> {
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return emptySummary("unavailable");
  }
  const db = (input.prisma ?? defaultPrisma) as ReadModelPrisma;
  let enabledAliases: Set<string>;
  try {
    const manifests = await db.autonomyCourseManifest.findMany({
      where: { enabled: true },
      select: { alias: true }
    });
    enabledAliases = new Set(
      Array.isArray(manifests)
        ? manifests.flatMap((manifest) => {
            if (
              !manifest ||
              typeof manifest !== "object" ||
              Array.isArray(manifest)
            ) {
              return [];
            }
            const alias = (manifest as { alias?: unknown }).alias;
            return typeof alias === "string" && alias.length > 0
              ? [alias]
              : [];
          })
        : []
    );
  } catch {
    return emptySummary("unavailable");
  }

  let runtime: RuntimeLike;
  try {
    runtime =
      input.runtime ??
      (await (input.runtimeLoader ?? loadDefaultRuntime)());
  } catch (error) {
    return emptySummary(stableConfigurationState(error));
  }

  try {
    const descriptorByAccount = new Map<
      string,
      CmoocExecutionAccountDescriptor
    >();
    const allDescriptors = runtime.listDescriptors();
    for (const candidate of allDescriptors) {
      if (!descriptorIsSafe(candidate)) {
        throw new Error("EXECUTION_ACCOUNT_POOL_READ_MODEL_DESCRIPTOR_UNSAFE");
      }
      const existing = descriptorByAccount.get(candidate.accountRefHash);
      if (existing && !descriptorsEqual(existing, candidate)) {
        throw new Error("EXECUTION_ACCOUNT_POOL_READ_MODEL_DESCRIPTOR_CONFLICT");
      }
      descriptorByAccount.set(candidate.accountRefHash, candidate);
    }
    const descriptors = [...descriptorByAccount.values()].filter((candidate) =>
      candidate.courseAliases.some((alias) => enabledAliases.has(alias))
    );
    const leases =
      descriptors.length === 0
        ? []
        : leaseRows(
            await db.executionAccountLease.findMany({
              where: {
                accountRefHash: {
                  in: descriptors.map((descriptor) => descriptor.accountRefHash)
                }
              },
              select: {
                accountRefHash: true,
                status: true,
                expiresAt: true,
                consumedAt: true
              }
            })
          );
    const leasesByAccount = new Map<string, LeaseRead[]>();
    for (const lease of leases) {
      if (typeof lease.accountRefHash !== "string") continue;
      const accountLeases = leasesByAccount.get(lease.accountRefHash) ?? [];
      accountLeases.push(lease);
      leasesByAccount.set(lease.accountRefHash, accountLeases);
    }
    const bounds = dayBounds(now);
    const roles = CMOOC_EXECUTION_ACCOUNT_ROLE_KEYS.map(roleSummary);
    const roleIndex = new Map(
      roles.map((role, index) => [role.roleKey, index] as const)
    );
    let availableAgentCount = 0;
    let activeAgentCount = 0;
    let cooldownAgentCount = 0;
    let dailyLimitReachedAgentCount = 0;
    let consumedLeaseCountToday = 0;
    for (const descriptor of descriptors) {
      const index = roleIndex.get(descriptor.roleKey);
      if (index === undefined) continue;
      const role = roles[index];
      role.configuredAgentCount += 1;
      const classification = classifyDescriptor({
        descriptor,
        leases: leasesByAccount.get(descriptor.accountRefHash) ?? [],
        now,
        bounds
      });
      role.consumedLeaseCountToday += classification.consumedLeaseCountToday;
      consumedLeaseCountToday += classification.consumedLeaseCountToday;
      if (classification.state === "active") {
        role.activeAgentCount += 1;
        activeAgentCount += 1;
      } else if (classification.state === "daily") {
        role.dailyLimitReachedAgentCount += 1;
        dailyLimitReachedAgentCount += 1;
      } else if (classification.state === "cooldown") {
        role.cooldownAgentCount += 1;
        cooldownAgentCount += 1;
      } else {
        role.availableAgentCount += 1;
        availableAgentCount += 1;
      }
    }
    return {
      schemaVersion: CMOOC_EXECUTION_ACCOUNT_POOL_READ_MODEL_SCHEMA_VERSION,
      scope: "enabled_courses",
      configurationState: "ready",
      configuredAgentCount: descriptors.length,
      configuredRoleCount: roles.filter(
        (role) => role.configuredAgentCount > 0
      ).length,
      availableAgentCount,
      activeAgentCount,
      cooldownAgentCount,
      dailyLimitReachedAgentCount,
      consumedLeaseCountToday,
      roles,
      containsAccountIdentity: false,
      containsCredentialMaterial: false,
      containsForumText: false
    };
  } catch {
    return emptySummary("unavailable");
  }
}

export const safeExecutionAgentPoolSummary =
  getSafeExecutionAccountPoolSummary;
