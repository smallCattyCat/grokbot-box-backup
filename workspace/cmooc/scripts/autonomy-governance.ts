import { prisma } from "@/lib/db";
import { loadCourseManifest } from "@/lib/autonomy/course-manifest";
import {
  issueCourseOperationGovernanceBaseline,
  previewCourseOperationGovernanceBaseline,
  safeGovernanceSummary,
  type CourseOperationGovernanceLimits,
  type CourseOperationGovernanceMode
} from "@/lib/autonomy/course-operation-governance";
import {
  safeCourseOperationGovernanceLifecycleSummary,
  transitionCourseOperationGovernance,
  type CourseOperationGovernanceTransitionAction
} from "@/lib/autonomy/course-operation-governance-lifecycle";

type CommandName =
  | "baseline"
  | "pause"
  | "resume"
  | "revoke"
  | "emergency-halt"
  | "rotate";

type ParsedArgs = {
  command: CommandName;
  courseAlias: string;
  version: string;
  expectedManifestHash: string;
  apply: boolean;
  validFrom?: string;
  validUntil?: string;
  expectedGovernanceHash?: string;
  transitionKey?: string;
  reasonCode?: string;
  effectiveAt?: string;
  mode?: CourseOperationGovernanceMode;
  limits?: CourseOperationGovernanceLimits;
};

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,159}$/i;
const SAFE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,159}$/i;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9._-]{1,79}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const COMMANDS = new Set<CommandName>([
  "baseline",
  "pause",
  "resume",
  "revoke",
  "emergency-halt",
  "rotate"
]);

function requiredValue(argv: string[], index: number, code: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(code);
  return value;
}

function safeInteger(value: string, code: string): number {
  if (!/^\d+$/.test(value)) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new Error(code);
  }
  return parsed;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] as CommandName | undefined;
  if (!command || !COMMANDS.has(command)) {
    throw new Error("AUTONOMY_GOVERNANCE_COMMAND_REQUIRED");
  }
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      if (apply) throw new Error("AUTONOMY_GOVERNANCE_DUPLICATE_APPLY");
      apply = true;
      continue;
    }
    if (!arg.startsWith("--") || values.has(arg)) {
      throw new Error("AUTONOMY_GOVERNANCE_UNKNOWN_ARGUMENT");
    }
    const value = requiredValue(
      argv,
      index,
      "AUTONOMY_GOVERNANCE_ARGUMENT_VALUE_REQUIRED"
    );
    const allowed = new Set([
      "--course",
      "--version",
      "--valid-from",
      "--valid-until",
      "--expected-manifest-hash",
      "--expected-governance-hash",
      "--transition-key",
      "--reason-code",
      "--effective-at",
      "--mode",
      "--daily-slot-limit",
      "--per-tick-action-limit",
      "--author-touch-limit-30d",
      "--min-interval-minutes"
    ]);
    if (!allowed.has(arg)) {
      throw new Error("AUTONOMY_GOVERNANCE_UNKNOWN_ARGUMENT");
    }
    values.set(arg, value);
    index += 1;
  }

  const courseAlias = values.get("--course") ?? "";
  const version = values.get("--version") ?? "";
  const expectedManifestHash = (
    values.get("--expected-manifest-hash") ?? ""
  ).toLowerCase();
  if (!ALIAS_PATTERN.test(courseAlias)) {
    throw new Error("AUTONOMY_GOVERNANCE_COURSE_INVALID");
  }
  if (!VERSION_PATTERN.test(version)) {
    throw new Error("AUTONOMY_GOVERNANCE_VERSION_INVALID");
  }
  if (!HASH_PATTERN.test(expectedManifestHash)) {
    throw new Error("AUTONOMY_GOVERNANCE_MANIFEST_HASH_INVALID");
  }

  if (command === "baseline") {
    const validFrom = values.get("--valid-from") ?? "";
    const validUntil = values.get("--valid-until") ?? "";
    if (
      !Number.isFinite(Date.parse(validFrom)) ||
      !Number.isFinite(Date.parse(validUntil))
    ) {
      throw new Error("AUTONOMY_GOVERNANCE_VALIDITY_INVALID");
    }
    const lifecycleOnly = [
      "--expected-governance-hash",
      "--transition-key",
      "--reason-code",
      "--effective-at",
      "--mode",
      "--daily-slot-limit",
      "--per-tick-action-limit",
      "--author-touch-limit-30d",
      "--min-interval-minutes"
    ];
    if (lifecycleOnly.some((key) => values.has(key))) {
      throw new Error("AUTONOMY_GOVERNANCE_BASELINE_ARGUMENT_INVALID");
    }
    return {
      command,
      courseAlias,
      version,
      validFrom: new Date(validFrom).toISOString(),
      validUntil: new Date(validUntil).toISOString(),
      expectedManifestHash,
      apply
    };
  }

  if (values.has("--valid-from")) {
    throw new Error("AUTONOMY_GOVERNANCE_TRANSITION_ARGUMENT_INVALID");
  }
  const expectedGovernanceHash = (
    values.get("--expected-governance-hash") ?? ""
  ).toLowerCase();
  const transitionKey = values.get("--transition-key") ?? "";
  const reasonCode = values.get("--reason-code") ?? "";
  const effectiveAt = values.get("--effective-at") ?? "";
  if (!HASH_PATTERN.test(expectedGovernanceHash)) {
    throw new Error("AUTONOMY_GOVERNANCE_CURRENT_HASH_INVALID");
  }
  if (!SAFE_KEY_PATTERN.test(transitionKey)) {
    throw new Error("AUTONOMY_GOVERNANCE_TRANSITION_KEY_INVALID");
  }
  if (!REASON_CODE_PATTERN.test(reasonCode)) {
    throw new Error("AUTONOMY_GOVERNANCE_REASON_CODE_INVALID");
  }
  if (!Number.isFinite(Date.parse(effectiveAt))) {
    throw new Error("AUTONOMY_GOVERNANCE_EFFECTIVE_AT_INVALID");
  }

  const rotateOnly = [
    "--valid-until",
    "--mode",
    "--daily-slot-limit",
    "--per-tick-action-limit",
    "--author-touch-limit-30d",
    "--min-interval-minutes"
  ];
  if (
    command !== "rotate" &&
    rotateOnly.some((key) => values.has(key))
  ) {
    throw new Error("AUTONOMY_GOVERNANCE_TRANSITION_ARGUMENT_INVALID");
  }
  const modeValue = values.get("--mode");
  const mode =
    modeValue === undefined
      ? undefined
      : modeValue === "OBSERVE" || modeValue === "SHADOW"
        ? modeValue
        : (() => {
            throw new Error("AUTONOMY_GOVERNANCE_MODE_INVALID");
          })();
  const limitKeys = [
    "--daily-slot-limit",
    "--per-tick-action-limit",
    "--author-touch-limit-30d",
    "--min-interval-minutes"
  ] as const;
  const anyLimit = limitKeys.some((key) => values.has(key));
  const allLimits = limitKeys.every((key) => values.has(key));
  if (anyLimit && !allLimits) {
    throw new Error("AUTONOMY_GOVERNANCE_LIMITS_INCOMPLETE");
  }
  const limits = allLimits
    ? {
        dailySlotLimit: safeInteger(
          values.get("--daily-slot-limit")!,
          "AUTONOMY_GOVERNANCE_LIMIT_INVALID"
        ),
        perTickActionLimit: safeInteger(
          values.get("--per-tick-action-limit")!,
          "AUTONOMY_GOVERNANCE_LIMIT_INVALID"
        ),
        authorTouchLimit30d: safeInteger(
          values.get("--author-touch-limit-30d")!,
          "AUTONOMY_GOVERNANCE_LIMIT_INVALID"
        ),
        minIntervalMinutes: safeInteger(
          values.get("--min-interval-minutes")!,
          "AUTONOMY_GOVERNANCE_LIMIT_INVALID"
        )
      }
    : undefined;
  const validUntilValue = values.get("--valid-until");
  if (
    validUntilValue !== undefined &&
    !Number.isFinite(Date.parse(validUntilValue))
  ) {
    throw new Error("AUTONOMY_GOVERNANCE_VALIDITY_INVALID");
  }
  return {
    command,
    courseAlias,
    version,
    expectedManifestHash,
    expectedGovernanceHash,
    transitionKey,
    reasonCode,
    effectiveAt: new Date(effectiveAt).toISOString(),
    ...(validUntilValue
      ? { validUntil: new Date(validUntilValue).toISOString() }
      : {}),
    ...(mode ? { mode } : {}),
    ...(limits ? { limits } : {}),
    apply
  };
}

function transitionAction(
  command: Exclude<CommandName, "baseline">
): CourseOperationGovernanceTransitionAction {
  return command === "emergency-halt" ? "emergency_halt" : command;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await loadCourseManifest(args.courseAlias);
  if (manifest.manifestHash !== args.expectedManifestHash) {
    throw new Error("AUTONOMY_GOVERNANCE_MANIFEST_HASH_MISMATCH");
  }

  if (args.command === "baseline") {
    const preview = await previewCourseOperationGovernanceBaseline({
      prisma,
      manifest,
      version: args.version,
      validFrom: args.validFrom!,
      validUntil: args.validUntil!
    });
    const summary = args.apply
      ? safeGovernanceSummary(
          await issueCourseOperationGovernanceBaseline({
            prisma,
            manifest,
            version: args.version,
            validFrom: args.validFrom!,
            validUntil: args.validUntil!
          })
        )
      : {
          courseAlias: preview.policy.courseAlias,
          version: preview.policy.version,
          status: preview.policy.status,
          mode: preview.policy.mode,
          baseManifestHash: preview.policy.baseManifestHash,
          governanceHash: preview.governanceHash,
          limits: preview.effectiveLimits,
          configuredLimits: preview.policy.limits,
          validFrom: preview.policy.validFrom,
          validUntil: preview.policy.validUntil,
          emergencyHalt: preview.policy.emergencyHalt,
          replayed: preview.replayed,
          containsForumText: false as const
        };
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        operation: "baseline",
        applied: args.apply,
        policy: summary,
        externalMutationAttempted: false,
        containsForumText: false
      })}\n`
    );
    return;
  }

  const lifecycle = await transitionCourseOperationGovernance({
    prisma,
    manifest,
    expectedManifestHash: args.expectedManifestHash,
    expectedGovernanceHash: args.expectedGovernanceHash!,
    command: {
      action: transitionAction(args.command),
      version: args.version,
      transitionKey: args.transitionKey!,
      reasonCode: args.reasonCode!,
      effectiveAt: args.effectiveAt!,
      ...(args.validUntil ? { validUntil: args.validUntil } : {}),
      ...(args.mode ? { mode: args.mode } : {}),
      ...(args.limits ? { limits: args.limits } : {})
    },
    apply: args.apply
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      operation: args.command,
      applied: lifecycle.applied,
      replayed: lifecycle.replayed,
      policy: safeCourseOperationGovernanceLifecycleSummary(lifecycle),
      externalMutationAttempted: false,
      containsForumText: false
    })}\n`
  );
}

void main()
  .catch(() => {
    const command = process.argv[2];
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        code:
          command === "baseline"
            ? "autonomy_governance_baseline_failed"
            : "autonomy_governance_transition_failed",
        externalMutationAttempted: false,
        containsForumText: false
      })}\n`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
