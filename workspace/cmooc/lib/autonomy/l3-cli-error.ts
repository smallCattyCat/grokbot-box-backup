/**
 * Stable public error code emitted by the L3 CLI when a failure cannot be
 * safely classified. The CLI must never expose an exception message, stack,
 * URL, token, or transient forum content.
 */
export const L3_COMMAND_FAILED_CODE = "L3_COMMAND_FAILED" as const;

type ProductionCommitErrorCode =
  | "PRODUCTION_COMMIT_REPLAY_BLOCKED"
  | "PRODUCTION_COMMIT_ABORTED_BEFORE_SEND"
  | "PRODUCTION_COMMIT_OUTCOME_UNKNOWN";

const PRODUCTION_COMMIT_ERROR_CODES = new Set<ProductionCommitErrorCode>([
  "PRODUCTION_COMMIT_REPLAY_BLOCKED",
  "PRODUCTION_COMMIT_ABORTED_BEFORE_SEND",
  "PRODUCTION_COMMIT_OUTCOME_UNKNOWN"
] as const);

const STABLE_L3_ERROR_CODE =
  /^(?:L3_[A-Z0-9_]{3,100}|CMOOC_QUILL_STAGE_[A-Z0-9_]{3,100}|STAGE_COMPANION_[A-Z0-9_]{3,100}|EXECUTION_STAGE_[A-Z0-9_]{3,100})$/;

const BUDGET_ERROR_CODE = /^BUDGET_[A-Z0-9_]{3,100}$/;
const EXECUTION_BASE_CODE =
  /^EXECUTION_(?:STAGE_[A-Z0-9_]{3,100}|(?!STAGE_)[A-Z0-9_]{1,100})$/;

type ErrorWithCode = {
  readonly code?: unknown;
};

function isObjectWithCode(value: unknown): value is ErrorWithCode {
  return typeof value === "object" && value !== null;
}

function isStableCode(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim()) {
    return false;
  }
  return (
    PRODUCTION_COMMIT_ERROR_CODES.has(value as ProductionCommitErrorCode) ||
    STABLE_L3_ERROR_CODE.test(value) ||
    BUDGET_ERROR_CODE.test(value) ||
    EXECUTION_BASE_CODE.test(value)
  );
}

function projectExecutionBaseCode(value: unknown): string | undefined {
  if (typeof value !== "string" || value !== value.trim()) {
    return undefined;
  }
  const separator = value.indexOf(":");
  const base = separator === -1 ? value : value.slice(0, separator);
  return EXECUTION_BASE_CODE.test(base) ? base : undefined;
}

/**
 * Projects an unknown thrown value to the small, stable code vocabulary that
 * the L3 CLI is allowed to expose.
 *
 * The structural `code` read keeps this helper compatible with serialized or
 * cross-realm ProductionCommitError values without importing the production
 * committer (and its runtime dependencies). A malformed or arbitrary code,
 * Error message, or non-Error value is collapsed to the generic failure code.
 */
export function projectL3CliErrorCode(error: unknown): string {
  let code: unknown;
  if (isObjectWithCode(error)) {
    try {
      code = error.code;
    } catch {
      code = undefined;
    }
  }
  if (isStableCode(code)) {
    return code;
  }

  let isError = false;
  try {
    isError = error instanceof Error;
  } catch {
    isError = false;
  }
  if (isError) {
    try {
      const message = (error as Error).message;
      if (isStableCode(message)) {
        return message;
      }
      const executionBaseCode = projectExecutionBaseCode(message);
      if (executionBaseCode) {
        return executionBaseCode;
      }
    } catch {
      // A hostile Error-like object must still collapse safely.
    }
  }

  return L3_COMMAND_FAILED_CODE;
}
