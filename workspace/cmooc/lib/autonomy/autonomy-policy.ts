import type {
  AutonomyPolicy as AutonomyPolicyRecord,
  Prisma,
  PrismaClient
} from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";

export const AUTONOMY_POLICY_SCHEMA_VERSION =
  "cmooc.course-autonomy-policy.v1" as const;

export type AutonomyPolicyAction =
  | "stage_editor"
  | "forum_reply";

export type AutonomyPolicyBudget = {
  dailyActionLimit: number;
  perTickActionLimit: number;
  authorTouchLimit30d: number;
};

export type CourseAutonomyPolicy = {
  schemaVersion: typeof AUTONOMY_POLICY_SCHEMA_VERSION;
  courseAlias: string;
  version: string;
  mode: "STAGE" | "AUTO";
  allowedActions: AutonomyPolicyAction[];
  budget: AutonomyPolicyBudget;
  validFrom: string;
  validUntil: string;
  realPublishEnabled: boolean;
  containsForumText: false;
};

export type VerifiedAutonomyPolicy = {
  policy: CourseAutonomyPolicy;
  policyHash: string;
  record: AutonomyPolicyRecord;
};

export type AutonomyPolicyValidation = {
  valid: boolean;
  code:
    | "valid"
    | "course_mismatch"
    | "version_mismatch"
    | "inactive"
    | "revoked"
    | "emergency_halt"
    | "not_yet_valid"
    | "expired"
    | "mode_not_authorized"
    | "action_not_authorized"
    | "real_publish_not_authorized";
  reason: string;
};

type PrismaLike = PrismaClient | Prisma.TransactionClient;

const COURSE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,159}$/i;
const POLICY_KEYS = new Set([
  "schemaVersion",
  "courseAlias",
  "version",
  "mode",
  "allowedActions",
  "budget",
  "validFrom",
  "validUntil",
  "realPublishEnabled",
  "containsForumText"
]);
const BUDGET_KEYS = new Set([
  "dailyActionLimit",
  "perTickActionLimit",
  "authorTouchLimit30d"
]);
const ACTIONS = new Set<AutonomyPolicyAction>([
  "stage_editor",
  "forum_reply"
]);

function recordValue(
  value: unknown,
  label: string
): Record<string, unknown> {
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
    throw new Error(`${label}包含未允许字段：${extra.sort().join("、")}。`);
  }
}

function requiredString(
  value: unknown,
  label: string,
  maxLength: number
): string {
  if (typeof value !== "string") {
    throw new Error(`${label}必须是字符串。`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label}不能为空且不能超过 ${maxLength} 个字符。`);
  }
  return normalized;
}

function positiveInteger(
  value: unknown,
  label: string,
  max: number
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new Error(`${label}必须是 1 到 ${max} 的安全整数。`);
  }
  return value;
}

function isoTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}必须是有效时间。`);
  }
  return new Date(value).toISOString();
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label}不是有效 JSON。`);
  }
}

export function parseCourseAutonomyPolicy(
  value: unknown
): CourseAutonomyPolicy {
  const input = recordValue(value, "课程自主策略");
  assertExactKeys(input, POLICY_KEYS, "课程自主策略");
  if (
    input.schemaVersion !== AUTONOMY_POLICY_SCHEMA_VERSION ||
    input.containsForumText !== false
  ) {
    throw new Error("课程自主策略 schema 或去正文边界无效。");
  }
  const courseAlias = requiredString(
    input.courseAlias,
    "课程别名",
    63
  );
  if (!COURSE_ALIAS_PATTERN.test(courseAlias)) {
    throw new Error("课程别名格式无效。");
  }
  const version = requiredString(input.version, "策略版本", 160);
  if (!VERSION_PATTERN.test(version)) {
    throw new Error("策略版本格式无效。");
  }
  if (input.mode !== "STAGE" && input.mode !== "AUTO") {
    throw new Error("自主策略模式必须是 STAGE 或 AUTO。");
  }
  if (
    !Array.isArray(input.allowedActions) ||
    input.allowedActions.length < 1
  ) {
    throw new Error("自主策略必须声明至少一项允许动作。");
  }
  const allowedActions = input.allowedActions.map((action) => {
    if (typeof action !== "string" || !ACTIONS.has(action as AutonomyPolicyAction)) {
      throw new Error("自主策略包含未知动作。");
    }
    return action as AutonomyPolicyAction;
  });
  if (new Set(allowedActions).size !== allowedActions.length) {
    throw new Error("自主策略允许动作不能重复。");
  }
  allowedActions.sort();

  const budgetInput = recordValue(input.budget, "课程自主策略预算");
  assertExactKeys(budgetInput, BUDGET_KEYS, "课程自主策略预算");
  const budget: AutonomyPolicyBudget = {
    dailyActionLimit: positiveInteger(
      budgetInput.dailyActionLimit,
      "每日动作上限",
      10_000
    ),
    perTickActionLimit: positiveInteger(
      budgetInput.perTickActionLimit,
      "单次动作上限",
      1_000
    ),
    authorTouchLimit30d: positiveInteger(
      budgetInput.authorTouchLimit30d,
      "作者三十日触达上限",
      1_000
    )
  };
  if (budget.perTickActionLimit > budget.dailyActionLimit) {
    throw new Error("单次动作上限不能超过每日动作上限。");
  }
  const validFrom = isoTime(input.validFrom, "策略生效时间");
  const validUntil = isoTime(input.validUntil, "策略失效时间");
  if (Date.parse(validUntil) <= Date.parse(validFrom)) {
    throw new Error("策略失效时间必须晚于生效时间。");
  }
  if (typeof input.realPublishEnabled !== "boolean") {
    throw new Error("策略必须显式声明真实发布开关。");
  }
  if (
    input.realPublishEnabled &&
    (input.mode !== "AUTO" ||
      !allowedActions.includes("forum_reply"))
  ) {
    throw new Error(
      "真实发布策略必须是 AUTO 且显式允许 forum_reply。"
    );
  }
  return {
    schemaVersion: AUTONOMY_POLICY_SCHEMA_VERSION,
    courseAlias,
    version,
    mode: input.mode,
    allowedActions,
    budget,
    validFrom,
    validUntil,
    realPublishEnabled: input.realPublishEnabled,
    containsForumText: false
  };
}

export function hashCourseAutonomyPolicy(
  policy: CourseAutonomyPolicy
): string {
  return canonicalProtocolHash(
    policy.schemaVersion,
    policy as unknown as CanonicalJsonValue
  );
}

export function verifyAutonomyPolicyRecord(
  record: AutonomyPolicyRecord
): VerifiedAutonomyPolicy {
  const policy = parseCourseAutonomyPolicy({
    schemaVersion: AUTONOMY_POLICY_SCHEMA_VERSION,
    courseAlias: record.courseAlias,
    version: record.version,
    mode: record.mode,
    allowedActions: parseJson(
      record.allowedActionsJson,
      "策略允许动作"
    ),
    budget: parseJson(record.budgetJson, "策略预算"),
    validFrom: record.validFrom.toISOString(),
    validUntil: record.validUntil.toISOString(),
    realPublishEnabled: record.realPublishEnabled,
    containsForumText: false
  });
  const policyHash = hashCourseAutonomyPolicy(policy);
  if (policyHash !== record.policyHash) {
    throw new Error("AUTONOMY_POLICY_HASH_MISMATCH");
  }
  return { policy, policyHash, record };
}

export function validateAutonomyPolicy(input: {
  verified: VerifiedAutonomyPolicy;
  courseAlias: string;
  policyVersion: string;
  action: AutonomyPolicyAction;
  mode: "STAGE" | "AUTO";
  now: Date;
  requireRealPublish?: boolean;
}): AutonomyPolicyValidation {
  const { record, policy } = input.verified;
  if (policy.courseAlias !== input.courseAlias) {
    return {
      valid: false,
      code: "course_mismatch",
      reason: "策略不属于当前课程。"
    };
  }
  if (policy.version !== input.policyVersion) {
    return {
      valid: false,
      code: "version_mismatch",
      reason: "策略版本与当前决定不一致。"
    };
  }
  if (record.status !== "active") {
    return {
      valid: false,
      code: "inactive",
      reason: "策略当前不是 active 状态。"
    };
  }
  if (record.revokedAt) {
    return {
      valid: false,
      code: "revoked",
      reason: "策略已经撤销。"
    };
  }
  if (record.emergencyHalt) {
    return {
      valid: false,
      code: "emergency_halt",
      reason: "策略紧急停机已启用。"
    };
  }
  if (input.now.getTime() < record.validFrom.getTime()) {
    return {
      valid: false,
      code: "not_yet_valid",
      reason: "策略尚未生效。"
    };
  }
  if (input.now.getTime() >= record.validUntil.getTime()) {
    return {
      valid: false,
      code: "expired",
      reason: "策略已经过期。"
    };
  }
  if (
    policy.mode !== input.mode &&
    !(policy.mode === "AUTO" && input.mode === "STAGE")
  ) {
    return {
      valid: false,
      code: "mode_not_authorized",
      reason: "策略未授权当前运行模式。"
    };
  }
  if (!policy.allowedActions.includes(input.action)) {
    return {
      valid: false,
      code: "action_not_authorized",
      reason: "策略未授权当前动作。"
    };
  }
  if (input.requireRealPublish && !policy.realPublishEnabled) {
    return {
      valid: false,
      code: "real_publish_not_authorized",
      reason: "策略没有启用真实发布。"
    };
  }
  return {
    valid: true,
    code: "valid",
    reason: "策略在当前课程、模式、动作和有效期内有效。"
  };
}

export async function registerCourseAutonomyPolicy(input: {
  prisma: PrismaLike;
  value: unknown;
  allowRealPublishActivation?: boolean;
}): Promise<AutonomyPolicyRecord> {
  const policy = parseCourseAutonomyPolicy(input.value);
  if (
    policy.realPublishEnabled &&
    input.allowRealPublishActivation !== true
  ) {
    throw new Error("AUTONOMY_POLICY_REAL_PUBLISH_ACTIVATION_FORBIDDEN");
  }
  const manifest =
    await input.prisma.autonomyCourseManifest.findUnique({
      where: { alias: policy.courseAlias }
    });
  if (!manifest || !manifest.enabled) {
    throw new Error("AUTONOMY_POLICY_COURSE_MANIFEST_UNAVAILABLE");
  }
  if (
    policy.realPublishEnabled &&
    !manifest.realPublishEnabled
  ) {
    throw new Error("AUTONOMY_POLICY_MANIFEST_REAL_PUBLISH_DISABLED");
  }
  const policyHash = hashCourseAutonomyPolicy(policy);
  const existing = await input.prisma.autonomyPolicy.findUnique({
    where: {
      courseAlias_version: {
        courseAlias: policy.courseAlias,
        version: policy.version
      }
    }
  });
  if (existing) {
    if (existing.policyHash !== policyHash) {
      throw new Error("AUTONOMY_POLICY_VERSION_IMMUTABLE");
    }
    verifyAutonomyPolicyRecord(existing);
    return existing;
  }
  return input.prisma.autonomyPolicy.create({
    data: {
      courseAlias: policy.courseAlias,
      version: policy.version,
      status: "active",
      mode: policy.mode,
      allowedActionsJson: JSON.stringify(
        policy.allowedActions
      ),
      budgetJson: JSON.stringify(policy.budget),
      policyHash,
      validFrom: new Date(policy.validFrom),
      validUntil: new Date(policy.validUntil),
      revokedAt: null,
      emergencyHalt: false,
      realPublishEnabled: policy.realPublishEnabled
    }
  });
}
