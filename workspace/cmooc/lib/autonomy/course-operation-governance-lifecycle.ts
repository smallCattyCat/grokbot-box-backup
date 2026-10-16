import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import type {
  CourseOperationGovernancePolicy as GovernanceRecord,
  CourseOperationGovernanceTransition as GovernanceTransitionRecord,
  Prisma,
  PrismaClient
} from "@prisma/client";
import type { CourseManifest } from "./course-manifest";
import {
  courseOperationGovernanceCurrentOrderBy,
  createCourseOperationGovernancePolicy,
  hashCourseOperationGovernancePolicy,
  parseCourseOperationGovernancePolicy,
  policyFromGovernanceRecord,
  validateCourseOperationGovernancePolicy,
  verifyCourseOperationGovernanceRecord,
  type CourseOperationGovernanceLimits,
  type CourseOperationGovernanceMode,
  type CourseOperationGovernancePolicy
} from "./course-operation-governance";

export const COURSE_OPERATION_GOVERNANCE_TRANSITION_SCHEMA_VERSION =
  "cmooc.course-operation-governance-transition.v1" as const;

export type CourseOperationGovernanceTransitionAction =
  | "pause"
  | "resume"
  | "revoke"
  | "emergency_halt"
  | "rotate";

export type CourseOperationGovernanceTransition = {
  schemaVersion: typeof COURSE_OPERATION_GOVERNANCE_TRANSITION_SCHEMA_VERSION;
  courseAlias: string;
  transitionKey: string;
  action: CourseOperationGovernanceTransitionAction;
  fromGovernanceHash: string;
  toGovernanceHash: string;
  expectedManifestHash: string;
  effectiveAt: string;
  reasonCode: string;
  containsForumText: false;
};

export type CourseOperationGovernanceTransitionCommand = {
  action: CourseOperationGovernanceTransitionAction;
  version: string;
  transitionKey: string;
  reasonCode: string;
  effectiveAt: string;
  validUntil?: string;
  mode?: CourseOperationGovernanceMode;
  limits?: CourseOperationGovernanceLimits;
};

export type BuiltCourseOperationGovernanceTransition = {
  policy: CourseOperationGovernancePolicy;
  governanceHash: string;
  transition: CourseOperationGovernanceTransition;
  eventHash: string;
};

export type CourseOperationGovernanceLifecycleResult =
  BuiltCourseOperationGovernanceTransition & {
    applied: boolean;
    replayed: boolean;
    policyRecord: GovernanceRecord | null;
    transitionRecord: GovernanceTransitionRecord | null;
  };

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_EMERGENCY_HALT_BACKDATE_MS = 5 * 60 * 1000;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,159}$/i;
const TRANSITION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,159}$/i;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9._-]{1,79}$/;
const TRANSITION_KEYS = new Set([
  "schemaVersion",
  "courseAlias",
  "transitionKey",
  "action",
  "fromGovernanceHash",
  "toGovernanceHash",
  "expectedManifestHash",
  "effectiveAt",
  "reasonCode",
  "containsForumText"
]);
const COMMAND_KEYS = new Set([
  "action",
  "version",
  "transitionKey",
  "reasonCode",
  "effectiveAt",
  "validUntil",
  "mode",
  "limits"
]);

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
  label: string
): void {
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new Error(`${label}包含未允许字段。`);
  }
}

function safeString(
  value: unknown,
  label: string,
  pattern: RegExp
): string {
  if (typeof value !== "string") throw new Error(`${label}必须是字符串。`);
  const normalized = value.trim();
  if (!pattern.test(normalized)) throw new Error(`${label}格式无效。`);
  return normalized;
}

function safeHash(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}必须是字符串。`);
  const normalized = value.trim().toLowerCase();
  if (!HASH_PATTERN.test(normalized)) throw new Error(`${label}必须是 SHA-256。`);
  return normalized;
}

function isoTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}必须是有效时间。`);
  }
  return new Date(value).toISOString();
}

function parseAction(value: unknown): CourseOperationGovernanceTransitionAction {
  if (
    value !== "pause" &&
    value !== "resume" &&
    value !== "revoke" &&
    value !== "emergency_halt" &&
    value !== "rotate"
  ) {
    throw new Error("治理 transition action 无效。");
  }
  return value;
}

export function parseCourseOperationGovernanceTransition(
  value: unknown
): CourseOperationGovernanceTransition {
  const input = recordValue(value, "课程运行治理 transition");
  assertExactKeys(input, TRANSITION_KEYS, "课程运行治理 transition");
  if (
    input.schemaVersion !==
      COURSE_OPERATION_GOVERNANCE_TRANSITION_SCHEMA_VERSION ||
    input.containsForumText !== false
  ) {
    throw new Error("治理 transition schema 或去正文边界无效。");
  }
  const courseAlias = safeString(
    input.courseAlias,
    "课程别名",
    /^[a-z0-9][a-z0-9-]{0,62}$/
  );
  return {
    schemaVersion: COURSE_OPERATION_GOVERNANCE_TRANSITION_SCHEMA_VERSION,
    courseAlias,
    transitionKey: safeString(
      input.transitionKey,
      "transition key",
      TRANSITION_KEY_PATTERN
    ),
    action: parseAction(input.action),
    fromGovernanceHash: safeHash(input.fromGovernanceHash, "from governance hash"),
    toGovernanceHash: safeHash(input.toGovernanceHash, "to governance hash"),
    expectedManifestHash: safeHash(
      input.expectedManifestHash,
      "expected Manifest hash"
    ),
    effectiveAt: isoTime(input.effectiveAt, "transition 生效时间"),
    reasonCode: safeString(
      input.reasonCode,
      "transition reason code",
      REASON_CODE_PATTERN
    ),
    containsForumText: false
  };
}

export function hashCourseOperationGovernanceTransition(
  transition: CourseOperationGovernanceTransition
): string {
  return canonicalProtocolHash(
    COURSE_OPERATION_GOVERNANCE_TRANSITION_SCHEMA_VERSION,
    transition as unknown as CanonicalJsonValue
  );
}

function parseCommand(
  value: CourseOperationGovernanceTransitionCommand
): CourseOperationGovernanceTransitionCommand {
  const input = recordValue(value, "课程运行治理 transition command");
  assertExactKeys(input, COMMAND_KEYS, "课程运行治理 transition command");
  const action = parseAction(input.action);
  const version = safeString(input.version, "治理版本", VERSION_PATTERN);
  const transitionKey = safeString(
    input.transitionKey,
    "transition key",
    TRANSITION_KEY_PATTERN
  );
  const reasonCode = safeString(
    input.reasonCode,
    "transition reason code",
    REASON_CODE_PATTERN
  );
  const effectiveAt = isoTime(input.effectiveAt, "transition 生效时间");
  const validUntil =
    input.validUntil === undefined
      ? undefined
      : isoTime(input.validUntil, "治理失效时间");
  const mode =
    input.mode === undefined
      ? undefined
      : input.mode === "OBSERVE" || input.mode === "SHADOW"
        ? input.mode
        : (() => {
            throw new Error("治理模式只能是 OBSERVE 或 SHADOW。");
          })();
  const limits = input.limits as CourseOperationGovernanceLimits | undefined;
  return {
    action,
    version,
    transitionKey,
    reasonCode,
    effectiveAt,
    ...(validUntil ? { validUntil } : {}),
    ...(mode ? { mode } : {}),
    ...(limits ? { limits } : {})
  };
}

function transitionState(input: {
  predecessor: CourseOperationGovernancePolicy;
  action: CourseOperationGovernanceTransitionAction;
}): Pick<CourseOperationGovernancePolicy, "status" | "emergencyHalt"> {
  const predecessor = input.predecessor;
  switch (input.action) {
    case "pause":
      if (predecessor.status !== "active" || predecessor.emergencyHalt) {
        throw new Error("当前治理状态不允许 pause。");
      }
      return { status: "paused", emergencyHalt: false };
    case "resume":
      if (predecessor.status !== "paused") {
        throw new Error("当前治理状态不允许 resume。");
      }
      return { status: "active", emergencyHalt: false };
    case "revoke":
      if (predecessor.status === "revoked") {
        throw new Error("revoked 治理版本不能再次撤销。");
      }
      return { status: "revoked", emergencyHalt: false };
    case "emergency_halt":
      if (predecessor.status === "revoked" || predecessor.emergencyHalt) {
        throw new Error("当前治理状态不允许 emergency halt。");
      }
      return { status: "paused", emergencyHalt: true };
    case "rotate":
      if (
        (predecessor.status !== "active" && predecessor.status !== "revoked") ||
        predecessor.emergencyHalt
      ) {
        throw new Error("当前治理状态不允许 rotate。");
      }
      return { status: "active", emergencyHalt: false };
  }
}

export function buildCourseOperationGovernanceTransition(input: {
  manifest: CourseManifest;
  predecessor: {
    policy: CourseOperationGovernancePolicy;
    governanceHash: string;
  };
  command: CourseOperationGovernanceTransitionCommand;
}): BuiltCourseOperationGovernanceTransition {
  const predecessor = parseCourseOperationGovernancePolicy(
    input.predecessor.policy
  );
  const predecessorHash = safeHash(
    input.predecessor.governanceHash,
    "predecessor governance hash"
  );
  if (
    hashCourseOperationGovernancePolicy(predecessor) !== predecessorHash
  ) {
    throw new Error("PREDECESSOR_GOVERNANCE_HASH_MISMATCH");
  }
  if (
    predecessor.courseAlias !== input.manifest.alias ||
    predecessor.baseManifestHash !== input.manifest.manifestHash
  ) {
    throw new Error("治理 predecessor 与 Manifest 不匹配。");
  }
  const command = parseCommand(input.command);
  if (command.version === predecessor.version) {
    throw new Error("治理 transition 必须使用新版本。");
  }
  const state = transitionState({
    predecessor,
    action: command.action
  });
  const targetMode = command.mode ?? predecessor.mode;
  const targetLimits = command.limits ?? predecessor.limits;
  const targetValidUntil =
    command.validUntil ?? predecessor.validUntil;

  if (command.action !== "rotate") {
    if (
      command.mode !== undefined ||
      command.limits !== undefined ||
      command.validUntil !== undefined
    ) {
      throw new Error("非 rotate transition 不允许改变模式、上限或有效期。");
    }
  }
  if (targetMode !== predecessor.mode) {
    throw new Error("当前生命周期版本不允许改变 schedule mode。");
  }
  if (
    targetLimits.minIntervalMinutes !==
    predecessor.limits.minIntervalMinutes
  ) {
    throw new Error("当前生命周期版本不允许改变 schedule cadence 间隔。");
  }
  if (
    command.action !== "emergency_halt" &&
    Date.parse(command.effectiveAt) < Date.parse(predecessor.validFrom)
  ) {
    throw new Error("transition 生效时间必须沿治理 lineage 单调递增。");
  }
  if (Date.parse(targetValidUntil) <= Date.parse(command.effectiveAt)) {
    throw new Error("transition 生效时间必须早于治理失效时间。");
  }

  const policy = parseCourseOperationGovernancePolicy({
    schemaVersion: predecessor.schemaVersion,
    courseAlias: predecessor.courseAlias,
    version: command.version,
    baseManifestHash: predecessor.baseManifestHash,
    status: state.status,
    mode: targetMode,
    limits: targetLimits,
    validFrom: command.effectiveAt,
    validUntil: targetValidUntil,
    emergencyHalt: state.emergencyHalt,
    containsForumText: false
  });
  validateCourseOperationGovernancePolicy({
    policy,
    manifest: input.manifest
  });
  const governanceHash = hashCourseOperationGovernancePolicy(policy);
  const transition = parseCourseOperationGovernanceTransition({
    schemaVersion: COURSE_OPERATION_GOVERNANCE_TRANSITION_SCHEMA_VERSION,
    courseAlias: policy.courseAlias,
    transitionKey: command.transitionKey,
    action: command.action,
    fromGovernanceHash: predecessorHash,
    toGovernanceHash: governanceHash,
    expectedManifestHash: input.manifest.manifestHash,
    effectiveAt: command.effectiveAt,
    reasonCode: command.reasonCode,
    containsForumText: false
  });
  return {
    policy,
    governanceHash,
    transition,
    eventHash: hashCourseOperationGovernanceTransition(transition)
  };
}

type LifecyclePrisma = PrismaClient | Prisma.TransactionClient;

function transitionFromRecord(
  record: GovernanceTransitionRecord
): CourseOperationGovernanceTransition {
  return parseCourseOperationGovernanceTransition({
    schemaVersion: record.schemaVersion,
    courseAlias: record.courseAlias,
    transitionKey: record.transitionKey,
    action: record.action,
    fromGovernanceHash: record.fromGovernanceHash,
    toGovernanceHash: record.toGovernanceHash,
    expectedManifestHash: record.expectedManifestHash,
    effectiveAt: record.effectiveAt.toISOString(),
    reasonCode: record.reasonCode,
    containsForumText: record.containsForumText
  });
}

export function safeCourseOperationGovernanceTransitionState(
  record: GovernanceTransitionRecord
) {
  try {
    const transition = transitionFromRecord(record);
    const integrityValid =
      record.containsForumText === false &&
      hashCourseOperationGovernanceTransition(transition) ===
        record.eventHash;
    if (!integrityValid) throw new Error("TRANSITION_INTEGRITY_INVALID");
    return {
      courseAlias: transition.courseAlias,
      transitionKey: transition.transitionKey,
      action: transition.action,
      fromGovernanceHash: transition.fromGovernanceHash,
      toGovernanceHash: transition.toGovernanceHash,
      expectedManifestHash: transition.expectedManifestHash,
      effectiveAt: transition.effectiveAt,
      reasonCode: transition.reasonCode,
      eventHash: record.eventHash,
      createdAt: record.createdAt.toISOString(),
      integrityState: "valid" as const,
      containsForumText: false as const
    };
  } catch {
    return {
      courseAlias: null,
      transitionKey: null,
      action: null,
      fromGovernanceHash: null,
      toGovernanceHash: null,
      expectedManifestHash: null,
      effectiveAt: null,
      reasonCode: null,
      eventHash:
        typeof record.eventHash === "string" &&
        HASH_PATTERN.test(record.eventHash)
          ? record.eventHash
          : null,
      createdAt:
        record.createdAt instanceof Date &&
        Number.isFinite(record.createdAt.getTime())
          ? record.createdAt.toISOString()
          : null,
      integrityState: "integrity_invalid" as const,
      containsForumText: false as const
    };
  }
}

function transitionRecordMatches(input: {
  record: GovernanceTransitionRecord;
  built: BuiltCourseOperationGovernanceTransition;
}): boolean {
  if (
    input.record.eventHash !== input.built.eventHash ||
    input.record.toGovernanceHash !== input.built.governanceHash ||
    input.record.containsForumText !== false
  ) {
    return false;
  }
  try {
    return (
      JSON.stringify(transitionFromRecord(input.record)) ===
      JSON.stringify(input.built.transition)
    );
  } catch {
    return false;
  }
}

async function resolveExistingTransition(input: {
  prisma: LifecyclePrisma;
  manifest: CourseManifest;
  expectedGovernanceHash: string;
  command: CourseOperationGovernanceTransitionCommand;
}): Promise<CourseOperationGovernanceLifecycleResult | null> {
  const existing =
    await input.prisma.courseOperationGovernanceTransition.findUnique({
      where: {
        courseAlias_transitionKey: {
          courseAlias: input.manifest.alias,
          transitionKey: input.command.transitionKey
        }
      },
      include: { fromPolicy: true, toPolicy: true }
    });
  if (!existing) return null;
  if (existing.fromGovernanceHash !== input.expectedGovernanceHash) {
    throw new Error("COURSE_OPERATION_GOVERNANCE_TRANSITION_CONFLICT");
  }
  const predecessor = verifyCourseOperationGovernanceRecord(
    existing.fromPolicy,
    input.manifest
  );
  const built = buildCourseOperationGovernanceTransition({
    manifest: input.manifest,
    predecessor: {
      policy: predecessor.policy,
      governanceHash: predecessor.governanceHash
    },
    command: input.command
  });
  if (
    !transitionRecordMatches({ record: existing, built }) ||
    existing.toPolicy.governanceHash !== built.governanceHash ||
    JSON.stringify(policyFromGovernanceRecord(existing.toPolicy)) !==
      JSON.stringify(built.policy)
  ) {
    throw new Error("COURSE_OPERATION_GOVERNANCE_TRANSITION_CONFLICT");
  }
  return {
    ...built,
    applied: true,
    replayed: true,
    policyRecord: existing.toPolicy,
    transitionRecord: existing
  };
}

async function prepareNewTransition(input: {
  prisma: LifecyclePrisma;
  manifest: CourseManifest;
  expectedGovernanceHash: string;
  command: CourseOperationGovernanceTransitionCommand;
}): Promise<BuiltCourseOperationGovernanceTransition> {
  const current =
    await input.prisma.courseOperationGovernancePolicy.findFirst({
      where: { courseAlias: input.manifest.alias },
      orderBy: courseOperationGovernanceCurrentOrderBy()
    });
  if (!current) {
    throw new Error("COURSE_OPERATION_GOVERNANCE_TRANSITION_BASELINE_REQUIRED");
  }
  const verified = verifyCourseOperationGovernanceRecord(
    current,
    input.manifest
  );
  if (verified.governanceHash !== input.expectedGovernanceHash) {
    throw new Error("COURSE_OPERATION_GOVERNANCE_TRANSITION_CAS_MISMATCH");
  }
  return buildCourseOperationGovernanceTransition({
    manifest: input.manifest,
    predecessor: {
      policy: verified.policy,
      governanceHash: verified.governanceHash
    },
    command: input.command
  });
}

/**
 * Preview or atomically append one governance lifecycle transition. Applying
 * writes only local immutable policy/event rows and never touches any forum,
 * editor, notification, AutonomyPolicy, ExecutionPermit, or publish surface.
 */
export async function transitionCourseOperationGovernance(input: {
  prisma: PrismaClient;
  manifest: CourseManifest;
  expectedManifestHash: string;
  expectedGovernanceHash: string;
  command: CourseOperationGovernanceTransitionCommand;
  apply: boolean;
  now?: Date;
}): Promise<CourseOperationGovernanceLifecycleResult> {
  const expectedManifestHash = safeHash(
    input.expectedManifestHash,
    "expected Manifest hash"
  );
  const expectedGovernanceHash = safeHash(
    input.expectedGovernanceHash,
    "expected governance hash"
  );
  if (expectedManifestHash !== input.manifest.manifestHash) {
    throw new Error("COURSE_OPERATION_GOVERNANCE_MANIFEST_HASH_MISMATCH");
  }
  const command = parseCommand(input.command);

  const replay = await resolveExistingTransition({
    prisma: input.prisma,
    manifest: input.manifest,
    expectedGovernanceHash,
    command
  });
  if (replay) return replay;

  if (command.action === "emergency_halt") {
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("COURSE_OPERATION_GOVERNANCE_NOW_INVALID");
    }
    if (
      Date.parse(command.effectiveAt) <
      now.getTime() - MAX_EMERGENCY_HALT_BACKDATE_MS
    ) {
      throw new Error("emergency halt effectiveAt 不允许回溯改写历史。");
    }
  }

  if (!input.apply) {
    const built = await prepareNewTransition({
      prisma: input.prisma,
      manifest: input.manifest,
      expectedGovernanceHash,
      command
    });
    return {
      ...built,
      applied: false,
      replayed: false,
      policyRecord: null,
      transitionRecord: null
    };
  }

  try {
    return await input.prisma.$transaction(
      async (transaction) => {
        const transactionReplay = await resolveExistingTransition({
          prisma: transaction,
          manifest: input.manifest,
          expectedGovernanceHash,
          command
        });
        if (transactionReplay) return transactionReplay;
        const built = await prepareNewTransition({
          prisma: transaction,
          manifest: input.manifest,
          expectedGovernanceHash,
          command
        });
        const issued = await createCourseOperationGovernancePolicy({
          prisma: transaction,
          manifest: input.manifest,
          policy: built.policy
        });
        const transitionRecord =
          await transaction.courseOperationGovernanceTransition.create({
            data: {
              schemaVersion: built.transition.schemaVersion,
              courseAlias: built.transition.courseAlias,
              transitionKey: built.transition.transitionKey,
              action: built.transition.action,
              fromGovernanceHash:
                built.transition.fromGovernanceHash,
              toGovernanceHash: built.transition.toGovernanceHash,
              expectedManifestHash:
                built.transition.expectedManifestHash,
              effectiveAt: new Date(built.transition.effectiveAt),
              reasonCode: built.transition.reasonCode,
              eventHash: built.eventHash,
              containsForumText: false
            }
          });
        return {
          ...built,
          applied: true,
          replayed: false,
          policyRecord: issued.record,
          transitionRecord
        };
      },
      { maxWait: 10_000, timeout: 20_000 }
    );
  } catch (error) {
    // A concurrent writer may have won the unique predecessor/transition-key
    // claim. Exact replay is safe; every other successor is a CAS conflict.
    const racedReplay = await resolveExistingTransition({
      prisma: input.prisma,
      manifest: input.manifest,
      expectedGovernanceHash,
      command
    });
    if (racedReplay) return racedReplay;
    const successor =
      await input.prisma.courseOperationGovernanceTransition.findUnique({
        where: { fromGovernanceHash: expectedGovernanceHash },
        select: { eventHash: true }
      });
    if (successor) {
      throw new Error("COURSE_OPERATION_GOVERNANCE_TRANSITION_CAS_MISMATCH");
    }
    throw error;
  }
}

export function safeCourseOperationGovernanceLifecycleSummary(
  result: CourseOperationGovernanceLifecycleResult
) {
  return {
    courseAlias: result.policy.courseAlias,
    version: result.policy.version,
    action: result.transition.action,
    transitionKey: result.transition.transitionKey,
    reasonCode: result.transition.reasonCode,
    fromGovernanceHash: result.transition.fromGovernanceHash,
    governanceHash: result.governanceHash,
    eventHash: result.eventHash,
    baseManifestHash: result.policy.baseManifestHash,
    status: result.policy.status,
    mode: result.policy.mode,
    configuredLimits: result.policy.limits,
    validFrom: result.policy.validFrom,
    validUntil: result.policy.validUntil,
    emergencyHalt: result.policy.emergencyHalt,
    applied: result.applied,
    replayed: result.replayed,
    externalMutationAttempted: false as const,
    containsForumText: false as const
  };
}
