import type {
  CourseOperationGovernancePolicy as GovernanceRecord,
  Prisma,
  PrismaClient
} from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import type { AnyCourseManifest } from "./course-manifest";

export const COURSE_OPERATION_GOVERNANCE_SCHEMA_VERSION =
  "cmooc.course-operation-governance-policy.v1" as const;

export type CourseOperationGovernanceStatus =
  | "active"
  | "paused"
  | "revoked";
export type CourseOperationGovernanceMode = "OBSERVE" | "SHADOW";

export type CourseOperationGovernanceLimits = {
  dailySlotLimit: number;
  perTickActionLimit: number;
  authorTouchLimit30d: number;
  minIntervalMinutes: number;
};

export type CourseOperationGovernancePolicy = {
  schemaVersion: typeof COURSE_OPERATION_GOVERNANCE_SCHEMA_VERSION;
  courseAlias: string;
  version: string;
  baseManifestHash: string;
  status: CourseOperationGovernanceStatus;
  mode: CourseOperationGovernanceMode;
  limits: CourseOperationGovernanceLimits;
  validFrom: string;
  validUntil: string;
  emergencyHalt: boolean;
  containsForumText: false;
};

export type EffectiveCourseOperationLimits = {
  dailySlotLimit: number;
  perTickActionLimit: number;
  authorTouchLimit30d: number;
  intervalMinutes: number;
};

export type VerifiedCourseOperationGovernance = {
  policy: CourseOperationGovernancePolicy;
  governanceHash: string;
  record: GovernanceRecord;
  effectiveLimits: EffectiveCourseOperationLimits;
};

/**
 * The immutable/current governance facts that can be re-checked from the
 * database alone.  Post-tick execution deliberately uses this narrower view:
 * the action plan already froze the effective limits, while this check makes
 * pause, revoke, halt, expiry, and hash rotation take effect immediately.
 */
export type CurrentCourseOperationGovernanceBinding = {
  policy: CourseOperationGovernancePolicy;
  governanceHash: string;
  record: GovernanceRecord;
};

/**
 * Governance policies are append-only events.  Whenever a caller needs the
 * current row for a course, it must use this total order rather than
 * `updatedAt`: `updatedAt` is mutable metadata and therefore cannot be used
 * to determine the as-of policy when rows share a timestamp.
 */
export function courseOperationGovernanceCurrentOrderBy(): Prisma.CourseOperationGovernancePolicyOrderByWithRelationInput[] {
  return [{ createdAt: "desc" }, { id: "desc" }];
}

/** Stable list order used by read-only governance views. */
export function courseOperationGovernanceListOrderBy(): Prisma.CourseOperationGovernancePolicyOrderByWithRelationInput[] {
  return [{ courseAlias: "asc" }, ...courseOperationGovernanceCurrentOrderBy()];
}

/**
 * Select one effective current hash per course from rows already ordered with
 * `courseOperationGovernanceListOrderBy()`. Future scheduled transitions and
 * older immutable history remain visible but are not counted as current.
 */
export function currentCourseOperationGovernanceHashes(
  rows: ReadonlyArray<{
    courseAlias: string;
    governanceHash: string;
    validFrom: Date;
  }>,
  asOf: Date
): Set<string> {
  const selectedCourses = new Set<string>();
  const hashes = new Set<string>();
  for (const row of rows) {
    if (row.validFrom > asOf || selectedCourses.has(row.courseAlias)) {
      continue;
    }
    selectedCourses.add(row.courseAlias);
    hashes.add(row.governanceHash);
  }
  return hashes;
}

type PrismaLike = PrismaClient | Prisma.TransactionClient;

/** The persisted fields that are part of the immutable policy event. */
export type CourseOperationGovernanceRecordFields = Pick<
  GovernanceRecord,
  | "courseAlias"
  | "version"
  | "baseManifestHash"
  | "status"
  | "mode"
  | "dailySlotLimit"
  | "perTickActionLimit"
  | "authorTouchLimit30d"
  | "minIntervalMinutes"
  | "validFrom"
  | "validUntil"
  | "emergencyHalt"
  | "governanceHash"
  | "containsForumText"
>;

export type CourseOperationGovernanceIntegrityState =
  | "valid"
  | "integrity_invalid"
  | "manifest_stale";

export type CourseOperationGovernanceIntegrity = {
  state: CourseOperationGovernanceIntegrityState;
  governanceHashMatches: boolean;
  manifestHashMatches: boolean;
  containsForumTextValid: boolean;
};

const COURSE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,159}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const MAX_LIMIT = 10_000;
const POLICY_KEYS = new Set([
  "schemaVersion",
  "courseAlias",
  "version",
  "baseManifestHash",
  "status",
  "mode",
  "limits",
  "validFrom",
  "validUntil",
  "emergencyHalt",
  "containsForumText"
]);
const LIMIT_KEYS = new Set([
  "dailySlotLimit",
  "perTickActionLimit",
  "authorTouchLimit30d",
  "minIntervalMinutes"
]);

export type CourseOperationGovernanceErrorCode =
  | "course_operation_governance_missing"
  | "course_operation_governance_hash_mismatch"
  | "course_operation_governance_version_conflict"
  | "course_operation_governance_baseline_exists"
  | "course_operation_governance_manifest_stale"
  | "course_operation_governance_paused"
  | "course_operation_governance_revoked"
  | "course_operation_governance_halted"
  | "course_operation_governance_not_yet_valid"
  | "course_operation_governance_expired"
  | "course_operation_governance_mode_not_allowed"
  | "course_operation_governance_manifest_broadened"
  | "course_operation_governance_invalid";

export class CourseOperationGovernanceError extends Error {
  readonly code: CourseOperationGovernanceErrorCode;
  readonly evidenceHash: string;

  constructor(
    code: CourseOperationGovernanceErrorCode,
    evidenceHash: string,
    message = code
  ) {
    super(message);
    this.name = "CourseOperationGovernanceError";
    this.code = code;
    this.evidenceHash = evidenceHash;
  }
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: Set<string>,
  label: string
): void {
  const extra = Object.keys(value).filter((key) => !keys.has(key));
  if (extra.length > 0) {
    throw new Error(`${label}包含未允许字段。`);
  }
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${label}必须是字符串。`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label}无效。`);
  }
  return normalized;
}

function safeInteger(value: unknown, label: string, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  ) {
    throw new Error(`${label}必须是非负安全整数。`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new Error(`${label}必须是正安全整数。`);
  }
  return value;
}

function isoTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}必须是有效时间。`);
  }
  return new Date(value).toISOString();
}

function parseStatus(value: unknown): CourseOperationGovernanceStatus {
  if (value !== "active" && value !== "paused" && value !== "revoked") {
    throw new Error("课程运行治理状态无效。");
  }
  return value;
}

function parseMode(value: unknown): CourseOperationGovernanceMode {
  if (value !== "OBSERVE" && value !== "SHADOW") {
    throw new Error("课程运行治理模式只能是 OBSERVE 或 SHADOW。");
  }
  return value;
}

export function parseCourseOperationGovernancePolicy(
  value: unknown
): CourseOperationGovernancePolicy {
  const input = recordValue(value, "课程运行治理策略");
  assertExactKeys(input, POLICY_KEYS, "课程运行治理策略");
  if (
    input.schemaVersion !== COURSE_OPERATION_GOVERNANCE_SCHEMA_VERSION ||
    input.containsForumText !== false
  ) {
    throw new Error("课程运行治理策略 schema 或去正文边界无效。");
  }
  const courseAlias = requiredString(input.courseAlias, "课程别名", 63);
  if (!COURSE_ALIAS_PATTERN.test(courseAlias)) {
    throw new Error("课程别名格式无效。");
  }
  const version = requiredString(input.version, "治理版本", 160);
  if (!VERSION_PATTERN.test(version)) {
    throw new Error("治理版本格式无效。");
  }
  const baseManifestHash = requiredString(
    input.baseManifestHash,
    "Manifest 哈希",
    64
  ).toLowerCase();
  if (!HASH_PATTERN.test(baseManifestHash)) {
    throw new Error("Manifest 哈希必须是 SHA-256。");
  }
  const limitsInput = recordValue(input.limits, "治理上限");
  assertExactKeys(limitsInput, LIMIT_KEYS, "治理上限");
  const limits: CourseOperationGovernanceLimits = {
    dailySlotLimit: safeInteger(
      limitsInput.dailySlotLimit,
      "每日槽位上限",
      MAX_LIMIT
    ),
    perTickActionLimit: safeInteger(
      limitsInput.perTickActionLimit,
      "单轮动作上限",
      MAX_LIMIT
    ),
    authorTouchLimit30d: safeInteger(
      limitsInput.authorTouchLimit30d,
      "作者触达上限",
      MAX_LIMIT
    ),
    minIntervalMinutes: positiveInteger(
      limitsInput.minIntervalMinutes,
      "最小调度间隔",
      MAX_INTERVAL_MINUTES
    )
  };
  if (limits.perTickActionLimit > limits.dailySlotLimit) {
    throw new Error("单轮动作上限不能超过每日槽位上限。");
  }
  const validFrom = isoTime(input.validFrom, "治理生效时间");
  const validUntil = isoTime(input.validUntil, "治理失效时间");
  if (Date.parse(validUntil) <= Date.parse(validFrom)) {
    throw new Error("治理失效时间必须晚于生效时间。");
  }
  if (typeof input.emergencyHalt !== "boolean") {
    throw new Error("治理 emergencyHalt 必须是布尔值。");
  }
  return {
    schemaVersion: COURSE_OPERATION_GOVERNANCE_SCHEMA_VERSION,
    courseAlias,
    version,
    baseManifestHash,
    status: parseStatus(input.status),
    mode: parseMode(input.mode),
    limits,
    validFrom,
    validUntil,
    emergencyHalt: input.emergencyHalt,
    containsForumText: false
  };
}

export function hashCourseOperationGovernancePolicy(
  policy: CourseOperationGovernancePolicy
): string {
  return canonicalProtocolHash(
    COURSE_OPERATION_GOVERNANCE_SCHEMA_VERSION,
    policy as unknown as CanonicalJsonValue
  );
}

export function validateCourseOperationGovernancePolicy(input: {
  policy: CourseOperationGovernancePolicy;
  manifest: AnyCourseManifest;
}): EffectiveCourseOperationLimits {
  const { policy, manifest } = input;
  if (policy.courseAlias !== manifest.alias) {
    throw new Error("课程运行治理策略课程不匹配。");
  }
  if (policy.baseManifestHash !== manifest.manifestHash) {
    throw new Error("课程运行治理策略绑定的 Manifest 已漂移。");
  }
  if (manifest.defaultMode !== "OBSERVE" && manifest.defaultMode !== "SHADOW") {
    throw new Error("当前 Manifest 模式不能由课程运行治理接管。");
  }
  if (policy.mode === "SHADOW" && manifest.defaultMode === "OBSERVE") {
    throw new Error("课程运行治理不能放宽 OBSERVE Manifest。");
  }
  if (policy.limits.dailySlotLimit > manifest.budget.dailySlots) {
    throw new Error("治理每日槽位上限不能放宽 Manifest。");
  }
  if (policy.limits.perTickActionLimit > manifest.budget.dailySlots) {
    throw new Error("治理单轮动作上限不能放宽 Manifest。");
  }
  if (policy.limits.authorTouchLimit30d > manifest.budget.authorTouchLimit30d) {
    throw new Error("治理作者触达上限不能放宽 Manifest。");
  }
  if (policy.limits.minIntervalMinutes < manifest.schedule.intervalMinutes) {
    throw new Error("治理调度间隔不能快于 Manifest。");
  }
  if (policy.limits.perTickActionLimit > policy.limits.dailySlotLimit) {
    throw new Error("治理单轮动作上限不能超过每日槽位上限。");
  }
  return {
    dailySlotLimit: Math.min(
      manifest.budget.dailySlots,
      policy.limits.dailySlotLimit
    ),
    perTickActionLimit: Math.min(
      manifest.budget.dailySlots,
      policy.limits.perTickActionLimit
    ),
    authorTouchLimit30d: Math.min(
      manifest.budget.authorTouchLimit30d,
      policy.limits.authorTouchLimit30d
    ),
    intervalMinutes: Math.max(
      manifest.schedule.intervalMinutes,
      policy.limits.minIntervalMinutes
    )
  };
}

export function policyFromGovernanceRecord(
  record: CourseOperationGovernanceRecordFields
): CourseOperationGovernancePolicy {
  return parseCourseOperationGovernancePolicy({
    schemaVersion: COURSE_OPERATION_GOVERNANCE_SCHEMA_VERSION,
    courseAlias: record.courseAlias,
    version: record.version,
    baseManifestHash: record.baseManifestHash,
    status: record.status,
    mode: record.mode,
    limits: {
      dailySlotLimit: record.dailySlotLimit,
      perTickActionLimit: record.perTickActionLimit,
      authorTouchLimit30d: record.authorTouchLimit30d,
      minIntervalMinutes: record.minIntervalMinutes
    },
    validFrom: record.validFrom.toISOString(),
    validUntil: record.validUntil.toISOString(),
    emergencyHalt: record.emergencyHalt,
    containsForumText: record.containsForumText
  });
}

/**
 * Recompute the immutable event hash and compare it to the enabled manifest
 * currently persisted in the database.  This is deliberately read-only and
 * is shared by the API and server-rendered page so neither can label a
 * tampered or stale policy as active.
 */
export function assessCourseOperationGovernanceIntegrity(input: {
  record: CourseOperationGovernanceRecordFields;
  currentManifestHash: string | null;
}): CourseOperationGovernanceIntegrity {
  const { record, currentManifestHash } = input;
  const containsForumTextValid = record.containsForumText === false;
  let governanceHashMatches = false;
  if (containsForumTextValid) {
    try {
      const policy = policyFromGovernanceRecord(record);
      governanceHashMatches =
        hashCourseOperationGovernancePolicy(policy) === record.governanceHash;
    } catch {
      governanceHashMatches = false;
    }
  }
  const manifestHashMatches =
    currentManifestHash !== null &&
    record.baseManifestHash === currentManifestHash;
  const state = !containsForumTextValid || !governanceHashMatches
    ? "integrity_invalid"
    : !manifestHashMatches
      ? "manifest_stale"
      : "valid";
  return {
    state,
    governanceHashMatches,
    manifestHashMatches,
    containsForumTextValid
  };
}

export function verifyCourseOperationGovernanceRecord(
  record: GovernanceRecord,
  manifest: AnyCourseManifest
): VerifiedCourseOperationGovernance {
  if (record.containsForumText) {
    throw new Error("课程运行治理记录违反去正文边界。");
  }
  const policy = policyFromGovernanceRecord(record);
  const governanceHash = hashCourseOperationGovernancePolicy(policy);
  if (governanceHash !== record.governanceHash) {
    throw new Error("COURSE_OPERATION_GOVERNANCE_HASH_MISMATCH");
  }
  const effectiveLimits = validateCourseOperationGovernancePolicy({
    policy,
    manifest
  });
  return { policy, governanceHash, record, effectiveLimits };
}

/**
 * Idempotent issuance may return an existing row only when every immutable
 * field is exactly the requested policy and the stored hash re-computes to the
 * same value.  Checking the hash alone would allow a row whose fields drifted
 * together with (or independently from) its hash to be silently accepted.
 */
function governanceRecordMatchesPolicy(input: {
  record: CourseOperationGovernanceRecordFields;
  policy: CourseOperationGovernancePolicy;
  governanceHash: string;
}): boolean {
  if (input.record.governanceHash !== input.governanceHash) return false;
  try {
    const persisted = policyFromGovernanceRecord(input.record);
    return JSON.stringify(persisted) === JSON.stringify(input.policy);
  } catch {
    return false;
  }
}

function evidenceHash(value: unknown): string {
  return canonicalProtocolHash(
    "cmooc.course-operation-governance-error.v1",
    (value ?? null) as CanonicalJsonValue
  );
}

export function governanceError(
  code: CourseOperationGovernanceErrorCode,
  input: {
    courseAlias: string;
    governanceHash?: string | null;
    manifestHash?: string | null;
    version?: string | null;
  }
): CourseOperationGovernanceError {
  return new CourseOperationGovernanceError(
    code,
    evidenceHash({
      courseAlias: input.courseAlias,
      governanceHash: input.governanceHash ?? null,
      manifestHash: input.manifestHash ?? null,
      version: input.version ?? null,
      containsForumText: false
    })
  );
}

export async function loadCurrentCourseOperationGovernanceBinding(input: {
  prisma: PrismaLike;
  courseAlias: string;
  manifestHash: string;
  expectedGovernanceHash?: string;
  now: Date;
}): Promise<CurrentCourseOperationGovernanceBinding> {
  if (!Number.isFinite(input.now.getTime())) {
    throw governanceError("course_operation_governance_invalid", {
      courseAlias: input.courseAlias,
      manifestHash: input.manifestHash
    });
  }
  const record = await input.prisma.courseOperationGovernancePolicy.findFirst({
    where: {
      courseAlias: input.courseAlias,
      validFrom: { lte: input.now }
    },
    orderBy: courseOperationGovernanceCurrentOrderBy()
  });
  if (!record) {
    const nextRecord =
      await input.prisma.courseOperationGovernancePolicy.findFirst({
        where: { courseAlias: input.courseAlias },
        orderBy: courseOperationGovernanceCurrentOrderBy()
      });
    if (nextRecord && nextRecord.validFrom > input.now) {
      throw governanceError("course_operation_governance_not_yet_valid", {
        courseAlias: input.courseAlias,
        governanceHash: nextRecord.governanceHash,
        manifestHash: input.manifestHash,
        version: nextRecord.version
      });
    }
    throw governanceError("course_operation_governance_missing", {
      courseAlias: input.courseAlias,
      manifestHash: input.manifestHash
    });
  }
  if (record.baseManifestHash !== input.manifestHash) {
    throw governanceError("course_operation_governance_manifest_stale", {
      courseAlias: input.courseAlias,
      governanceHash: record.governanceHash,
      manifestHash: input.manifestHash,
      version: record.version
    });
  }
  let policy: CourseOperationGovernancePolicy;
  let governanceHash: string;
  try {
    if (record.containsForumText) throw new Error("unsafe");
    policy = policyFromGovernanceRecord(record);
    governanceHash = hashCourseOperationGovernancePolicy(policy);
    if (governanceHash !== record.governanceHash) {
      throw new Error("hash mismatch");
    }
  } catch {
    throw governanceError("course_operation_governance_invalid", {
      courseAlias: input.courseAlias,
      governanceHash: record.governanceHash,
      manifestHash: input.manifestHash,
      version: record.version
    });
  }
  if (
    input.expectedGovernanceHash &&
    governanceHash !== input.expectedGovernanceHash
  ) {
    throw governanceError("course_operation_governance_hash_mismatch", {
      courseAlias: input.courseAlias,
      governanceHash,
      manifestHash: input.manifestHash,
      version: record.version
    });
  }
  if (policy.emergencyHalt) {
    throw governanceError("course_operation_governance_halted", {
      courseAlias: input.courseAlias,
      governanceHash,
      manifestHash: input.manifestHash,
      version: policy.version
    });
  }
  if (policy.status === "paused") {
    throw governanceError("course_operation_governance_paused", {
      courseAlias: input.courseAlias,
      governanceHash,
      manifestHash: input.manifestHash,
      version: policy.version
    });
  }
  if (policy.status === "revoked") {
    throw governanceError("course_operation_governance_revoked", {
      courseAlias: input.courseAlias,
      governanceHash,
      manifestHash: input.manifestHash,
      version: policy.version
    });
  }
  const asOf = input.now.getTime();
  if (asOf < Date.parse(policy.validFrom)) {
    throw governanceError("course_operation_governance_not_yet_valid", {
      courseAlias: input.courseAlias,
      governanceHash,
      manifestHash: input.manifestHash,
      version: policy.version
    });
  }
  if (asOf >= Date.parse(policy.validUntil)) {
    throw governanceError("course_operation_governance_expired", {
      courseAlias: input.courseAlias,
      governanceHash,
      manifestHash: input.manifestHash,
      version: policy.version
    });
  }
  return { policy, governanceHash, record };
}

export async function loadCourseOperationGovernance(input: {
  prisma: PrismaLike;
  manifest: AnyCourseManifest;
  now?: Date;
  requestedMode?: CourseOperationGovernanceMode;
  requireExecutable?: boolean;
}): Promise<VerifiedCourseOperationGovernance> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw governanceError("course_operation_governance_invalid", {
      courseAlias: input.manifest.alias,
      manifestHash: input.manifest.manifestHash
    });
  }
  let record = await input.prisma.courseOperationGovernancePolicy.findFirst({
    where: {
      courseAlias: input.manifest.alias,
      // A scheduled future rotation is append-only history, but it must not
      // preempt the policy that is effective at this as-of time.
      validFrom: { lte: now }
    },
    orderBy: courseOperationGovernanceCurrentOrderBy()
  });
  if (!record) {
    const nextRecord =
      await input.prisma.courseOperationGovernancePolicy.findFirst({
        where: { courseAlias: input.manifest.alias },
        orderBy: courseOperationGovernanceCurrentOrderBy()
      });
    if (nextRecord && nextRecord.validFrom > now) {
      throw governanceError("course_operation_governance_not_yet_valid", {
        courseAlias: input.manifest.alias,
        governanceHash: nextRecord.governanceHash,
        manifestHash: input.manifest.manifestHash,
        version: nextRecord.version
      });
    }
    throw governanceError("course_operation_governance_missing", {
      courseAlias: input.manifest.alias,
      manifestHash: input.manifest.manifestHash
    });
  }
  if (record.baseManifestHash !== input.manifest.manifestHash) {
    throw governanceError("course_operation_governance_manifest_stale", {
      courseAlias: input.manifest.alias,
      governanceHash: record.governanceHash,
      manifestHash: input.manifest.manifestHash,
      version: record.version
    });
  }
  let verified: VerifiedCourseOperationGovernance;
  try {
    verified = verifyCourseOperationGovernanceRecord(record, input.manifest);
  } catch (error) {
    if (error instanceof CourseOperationGovernanceError) throw error;
    throw governanceError("course_operation_governance_invalid", {
      courseAlias: input.manifest.alias,
      governanceHash: record.governanceHash,
      manifestHash: input.manifest.manifestHash,
      version: record.version
    });
  }
  if (
    input.requestedMode &&
    verified.policy.mode !== input.requestedMode &&
    !(
      input.requestedMode === "OBSERVE" &&
      verified.policy.mode === "SHADOW"
    )
  ) {
    throw governanceError("course_operation_governance_mode_not_allowed", {
      courseAlias: input.manifest.alias,
      governanceHash: verified.governanceHash,
      manifestHash: input.manifest.manifestHash,
      version: verified.policy.version
    });
  }
  if (input.requireExecutable === false) return verified;
  if (verified.policy.emergencyHalt) {
    throw governanceError("course_operation_governance_halted", {
      courseAlias: input.manifest.alias,
      governanceHash: verified.governanceHash,
      manifestHash: input.manifest.manifestHash,
      version: verified.policy.version
    });
  }
  if (verified.policy.status === "paused") {
    throw governanceError("course_operation_governance_paused", {
      courseAlias: input.manifest.alias,
      governanceHash: verified.governanceHash,
      manifestHash: input.manifest.manifestHash,
      version: verified.policy.version
    });
  }
  if (verified.policy.status === "revoked") {
    throw governanceError("course_operation_governance_revoked", {
      courseAlias: input.manifest.alias,
      governanceHash: verified.governanceHash,
      manifestHash: input.manifest.manifestHash,
      version: verified.policy.version
    });
  }
  const time = now.getTime();
  if (time < Date.parse(verified.policy.validFrom)) {
    throw governanceError("course_operation_governance_not_yet_valid", {
      courseAlias: input.manifest.alias,
      governanceHash: verified.governanceHash,
      manifestHash: input.manifest.manifestHash,
      version: verified.policy.version
    });
  }
  if (time >= Date.parse(verified.policy.validUntil)) {
    throw governanceError("course_operation_governance_expired", {
      courseAlias: input.manifest.alias,
      governanceHash: verified.governanceHash,
      manifestHash: input.manifest.manifestHash,
      version: verified.policy.version
    });
  }
  return verified;
}

/**
 * @internal Persistence primitive for the guarded root-issuance and lifecycle
 * services. It does not establish lineage by itself; production callers must
 * use issueCourseOperationGovernanceBaseline or the lifecycle service.
 */
export async function createCourseOperationGovernancePolicy(input: {
  prisma: PrismaLike;
  manifest: AnyCourseManifest;
  policy: CourseOperationGovernancePolicy;
}): Promise<VerifiedCourseOperationGovernance> {
  const policy = parseCourseOperationGovernancePolicy(input.policy);
  const effectiveLimits = validateCourseOperationGovernancePolicy({
    policy,
    manifest: input.manifest
  });
  const governanceHash = hashCourseOperationGovernancePolicy(policy);
  const data = {
    courseAlias: policy.courseAlias,
    version: policy.version,
    baseManifestHash: policy.baseManifestHash,
    status: policy.status,
    mode: policy.mode,
    dailySlotLimit: policy.limits.dailySlotLimit,
    perTickActionLimit: policy.limits.perTickActionLimit,
    authorTouchLimit30d: policy.limits.authorTouchLimit30d,
    minIntervalMinutes: policy.limits.minIntervalMinutes,
    validFrom: new Date(policy.validFrom),
    validUntil: new Date(policy.validUntil),
    emergencyHalt: policy.emergencyHalt,
    governanceHash,
    containsForumText: false
  };
  const existing = await input.prisma.courseOperationGovernancePolicy.findUnique({
    where: {
      courseAlias_version: {
        courseAlias: policy.courseAlias,
        version: policy.version
      }
    }
  });
  if (existing) {
    if (
      !governanceRecordMatchesPolicy({
        record: existing,
        policy,
        governanceHash
      })
    ) {
      throw governanceError("course_operation_governance_version_conflict", {
        courseAlias: policy.courseAlias,
        governanceHash: existing.governanceHash,
        manifestHash: input.manifest.manifestHash,
        version: policy.version
      });
    }
    return {
      policy,
      governanceHash,
      record: existing,
      effectiveLimits
    };
  }
  try {
    const record = await input.prisma.courseOperationGovernancePolicy.create({
      data
    });
    return { policy, governanceHash, record, effectiveLimits };
  } catch (error) {
    const raced = await input.prisma.courseOperationGovernancePolicy.findUnique({
      where: {
        courseAlias_version: {
          courseAlias: policy.courseAlias,
          version: policy.version
        }
      }
    });
    if (raced) {
      if (
        governanceRecordMatchesPolicy({
          record: raced,
          policy,
          governanceHash
        })
      ) {
        return { policy, governanceHash, record: raced, effectiveLimits };
      }
      throw governanceError("course_operation_governance_version_conflict", {
        courseAlias: policy.courseAlias,
        governanceHash: raced.governanceHash,
        manifestHash: input.manifest.manifestHash,
        version: policy.version
      });
    }
    throw error;
  }
}

/** Build an explicit baseline without touching the database. */
export function buildCourseOperationGovernanceBaseline(input: {
  manifest: AnyCourseManifest;
  version: string;
  validFrom: Date | string;
  validUntil: Date | string;
}): CourseOperationGovernancePolicy {
  if (input.manifest.defaultMode !== "OBSERVE" && input.manifest.defaultMode !== "SHADOW") {
    throw new Error("治理 baseline 只能为 OBSERVE 或 SHADOW Manifest 创建。");
  }
  return parseCourseOperationGovernancePolicy({
    schemaVersion: COURSE_OPERATION_GOVERNANCE_SCHEMA_VERSION,
    courseAlias: input.manifest.alias,
    version: input.version,
    baseManifestHash: input.manifest.manifestHash,
    status: "active",
    mode: input.manifest.defaultMode,
    limits: {
      dailySlotLimit: input.manifest.budget.dailySlots,
      perTickActionLimit: input.manifest.budget.dailySlots,
      authorTouchLimit30d: input.manifest.budget.authorTouchLimit30d,
      minIntervalMinutes: input.manifest.schedule.intervalMinutes
    },
    validFrom: new Date(input.validFrom).toISOString(),
    validUntil: new Date(input.validUntil).toISOString(),
    emergencyHalt: false,
    containsForumText: false
  });
}

export type CourseOperationGovernanceBaselinePreview = {
  policy: CourseOperationGovernancePolicy;
  governanceHash: string;
  effectiveLimits: EffectiveCourseOperationLimits;
  replayed: boolean;
};

async function inspectCourseOperationGovernanceBaseline(input: {
  prisma: PrismaLike;
  manifest: AnyCourseManifest;
  policy: CourseOperationGovernancePolicy;
}): Promise<
  CourseOperationGovernanceBaselinePreview & { record: GovernanceRecord | null }
> {
  const policy = parseCourseOperationGovernancePolicy(input.policy);
  const effectiveLimits = validateCourseOperationGovernancePolicy({
    policy,
    manifest: input.manifest
  });
  const governanceHash = hashCourseOperationGovernancePolicy(policy);
  const requested =
    await input.prisma.courseOperationGovernancePolicy.findUnique({
      where: {
        courseAlias_version: {
          courseAlias: policy.courseAlias,
          version: policy.version
        }
      },
      include: { incomingTransition: true }
    });
  if (requested) {
    if (
      requested.incomingTransition ||
      !governanceRecordMatchesPolicy({
        record: requested,
        policy,
        governanceHash
      })
    ) {
      throw governanceError(
        requested.incomingTransition
          ? "course_operation_governance_baseline_exists"
          : "course_operation_governance_version_conflict",
        {
          courseAlias: policy.courseAlias,
          governanceHash: requested.governanceHash,
          manifestHash: input.manifest.manifestHash,
          version: requested.version
        }
      );
    }
    return {
      policy,
      governanceHash,
      effectiveLimits,
      replayed: true,
      record: requested
    };
  }

  const existing = await input.prisma.courseOperationGovernancePolicy.findFirst({
    where: { courseAlias: policy.courseAlias },
    orderBy: courseOperationGovernanceCurrentOrderBy()
  });
  if (existing) {
    throw governanceError("course_operation_governance_baseline_exists", {
      courseAlias: policy.courseAlias,
      governanceHash: existing.governanceHash,
      manifestHash: input.manifest.manifestHash,
      version: existing.version
    });
  }
  return {
    policy,
    governanceHash,
    effectiveLimits,
    replayed: false,
    record: null
  };
}

/** Read-only root issuance preview with the same conflict checks as apply. */
export async function previewCourseOperationGovernanceBaseline(input: {
  prisma: PrismaLike;
  manifest: AnyCourseManifest;
  version: string;
  validFrom: Date | string;
  validUntil: Date | string;
}): Promise<CourseOperationGovernanceBaselinePreview> {
  const inspected = await inspectCourseOperationGovernanceBaseline({
    prisma: input.prisma,
    manifest: input.manifest,
    policy: buildCourseOperationGovernanceBaseline(input)
  });
  return {
    policy: inspected.policy,
    governanceHash: inspected.governanceHash,
    effectiveLimits: inspected.effectiveLimits,
    replayed: inspected.replayed
  };
}

async function issueCourseOperationGovernanceBaselineInTransaction(input: {
  prisma: PrismaLike;
  manifest: AnyCourseManifest;
  policy: CourseOperationGovernancePolicy;
}): Promise<VerifiedCourseOperationGovernance> {
  await inspectCourseOperationGovernanceBaseline(input);
  return createCourseOperationGovernancePolicy({
    prisma: input.prisma,
    manifest: input.manifest,
    policy: input.policy
  });
}

/**
 * Explicit root-baseline issuance. Runtime sync never calls this helper. The
 * official issuance surface permits one root per course; every later policy
 * must be appended through the lifecycle transition service.
 */
export async function issueCourseOperationGovernanceBaseline(input: {
  prisma: PrismaClient;
  manifest: AnyCourseManifest;
  version: string;
  validFrom: Date | string;
  validUntil: Date | string;
}): Promise<VerifiedCourseOperationGovernance> {
  const policy = buildCourseOperationGovernanceBaseline(input);
  try {
    return await input.prisma.$transaction(
      (transaction) =>
        issueCourseOperationGovernanceBaselineInTransaction({
          prisma: transaction,
          manifest: input.manifest,
          policy
        }),
      { maxWait: 10_000, timeout: 20_000 }
    );
  } catch (error) {
    if (error instanceof CourseOperationGovernanceError) throw error;

    // If another issuer won while this transaction was waiting, only an exact
    // replay of that same root is idempotent. A different version is an
    // unlinked second root and must fail closed.
    const raced = await inspectCourseOperationGovernanceBaseline({
      prisma: input.prisma,
      manifest: input.manifest,
      policy
    });
    if (raced.record) {
      return createCourseOperationGovernancePolicy({
        prisma: input.prisma,
        manifest: input.manifest,
        policy
      });
    }
    throw error;
  }
}

export function safeGovernanceSummary(input: VerifiedCourseOperationGovernance) {
  return {
    courseAlias: input.policy.courseAlias,
    version: input.policy.version,
    status: input.policy.status,
    mode: input.policy.mode,
    baseManifestHash: input.policy.baseManifestHash,
    governanceHash: input.governanceHash,
    limits: input.effectiveLimits,
    configuredLimits: input.policy.limits,
    validFrom: input.policy.validFrom,
    validUntil: input.policy.validUntil,
    emergencyHalt: input.policy.emergencyHalt,
    containsForumText: false as const
  };
}

/**
 * Public, read-only state for governance screens.  Integrity failures take
 * precedence over temporal status, so a tampered/manifest-stale active row is
 * never represented as `active`.
 */
export function safeCourseOperationGovernanceState(input: {
  record: CourseOperationGovernanceRecordFields;
  currentManifestHash: string | null;
  now: Date;
}) {
  const { record, now } = input;
  const integrity = assessCourseOperationGovernanceIntegrity({
    record,
    currentManifestHash: input.currentManifestHash
  });
  const temporalStatus = record.emergencyHalt
    ? "emergency_halt"
    : record.status === "active" && record.validFrom > now
      ? "not_yet_valid"
      : record.status === "active" && record.validUntil <= now
        ? "expired"
        : record.status;
  const status = integrity.state === "valid" ? temporalStatus : integrity.state;
  return {
    courseAlias: record.courseAlias,
    version: record.version,
    baseManifestHash: record.baseManifestHash,
    status,
    integrityState: integrity.state,
    integrity: {
      governanceHashMatches: integrity.governanceHashMatches,
      manifestHashMatches: integrity.manifestHashMatches,
      containsForumTextValid: integrity.containsForumTextValid
    },
    mode: record.mode,
    limits: {
      dailySlotLimit: record.dailySlotLimit,
      perTickActionLimit: record.perTickActionLimit,
      authorTouchLimit30d: record.authorTouchLimit30d,
      intervalMinutes: record.minIntervalMinutes
    },
    validFrom: record.validFrom.toISOString(),
    validUntil: record.validUntil.toISOString(),
    emergencyHalt: record.emergencyHalt,
    governanceHash: record.governanceHash,
    containsForumText: false as const
  };
}
