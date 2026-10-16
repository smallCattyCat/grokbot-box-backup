export type BrowserFailureCode =
  | "EXECUTION_LOST"
  | "EXECUTION_EXPIRED"
  | "START_FAILED"
  | "EXECUTION_FAILED"
  | "EXECUTION_INCOMPLETE"
  | "HTTP_429"
  | "HTTP_502"
  | "HTTP_503"
  | "HTTP_504"
  | "NETWORK_TIMEOUT"
  | "RELOGIN_REQUIRED"
  | "AUTH_RELOGIN_REQUIRED"
  | "COURSE_MISMATCH"
  | "TARGET_MISSING"
  | "LOCATOR_DRIFT"
  | "COVERAGE_INCOMPLETE"
  | "COVERAGE_INCONSISTENT"
  | "STAGE_MISMATCH"
  | "STAGE_UNKNOWN"
  | "POLICY_CONFLICT";

export type BrowserFailureMode = "observe" | "stage";
export type BrowserFailurePhase = "patrol" | "reply_watch";

export type BrowserFailureClassification = {
  failureClass:
    | "transient_transport"
    | "host_lifecycle"
    | "auth_required"
    | "scope_or_locator"
    | "coverage_integrity"
    | "stage_unknown_or_policy"
    | "unknown";
  retryable: boolean;
  terminalAction: "retry" | "relogin_required" | "attention";
  retryDelayMs: number | null;
};

export type BrowserFailureContext = {
  mode: BrowserFailureMode;
  phase?: BrowserFailurePhase;
  attempts: number;
};

type FailureClass = BrowserFailureClassification["failureClass"];

const FAILURE_CLASS_BY_CODE: Readonly<Record<string, FailureClass>> = {
  EXECUTION_LOST: "host_lifecycle",
  EXECUTION_EXPIRED: "host_lifecycle",
  START_FAILED: "host_lifecycle",
  EXECUTION_FAILED: "unknown",
  EXECUTION_INCOMPLETE: "unknown",
  HTTP_429: "transient_transport",
  HTTP_502: "transient_transport",
  HTTP_503: "transient_transport",
  HTTP_504: "transient_transport",
  NETWORK_TIMEOUT: "transient_transport",
  RELOGIN_REQUIRED: "auth_required",
  AUTH_RELOGIN_REQUIRED: "auth_required",
  COURSE_MISMATCH: "scope_or_locator",
  TARGET_MISSING: "scope_or_locator",
  LOCATOR_DRIFT: "scope_or_locator",
  COVERAGE_INCOMPLETE: "coverage_integrity",
  COVERAGE_INCONSISTENT: "coverage_integrity",
  STAGE_MISMATCH: "stage_unknown_or_policy",
  STAGE_UNKNOWN: "stage_unknown_or_policy",
  POLICY_CONFLICT: "stage_unknown_or_policy"
};

const RETRYABLE_CLASSES = new Set<FailureClass>([
  "transient_transport",
  "host_lifecycle",
  "unknown"
]);

const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 120_000;
const MIN_DELAY_MS = 1_000;
const MAX_ATTEMPTS = 3;

/** Keep exception text and arbitrary provider payloads out of durable receipts. */
export function safeBrowserFailureCode(code: unknown): BrowserFailureCode | "UNKNOWN_FAILURE" {
  const candidate = typeof code === "string" ? code.trim().toUpperCase() : "";
  return Object.prototype.hasOwnProperty.call(FAILURE_CLASS_BY_CODE, candidate) ? candidate as BrowserFailureCode : "UNKNOWN_FAILURE";
}

function normalizedAttempts(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function boundedRetryDelay(attempts: number, random: () => number): number {
  const exponent = Math.min(normalizedAttempts(attempts), 2);
  const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent);
  const sample = Number(random());
  const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(cap * unit)));
}

export function classifyBrowserFailure(
  code: string,
  context: BrowserFailureContext,
  random: () => number = Math.random
): BrowserFailureClassification {
  const normalizedCode = typeof code === "string" ? code.trim().toUpperCase() : "";
  const knownCode = Object.prototype.hasOwnProperty.call(
    FAILURE_CLASS_BY_CODE,
    normalizedCode
  );
  const failureClass = FAILURE_CLASS_BY_CODE[normalizedCode] ?? "unknown";
  if (failureClass === "auth_required") {
    return {
      failureClass,
      retryable: false,
      terminalAction: "relogin_required",
      retryDelayMs: null
    };
  }

  const classCanRetry =
    RETRYABLE_CLASSES.has(failureClass) &&
    (failureClass !== "unknown" || knownCode);
  const stageMustNotReplay =
    context.mode === "stage" && context.phase !== "reply_watch";
  const bounded = normalizedAttempts(context.attempts);
  const canRetry =
    classCanRetry && !stageMustNotReplay && bounded < MAX_ATTEMPTS;

  if (!canRetry) {
    return {
      failureClass,
      retryable: false,
      terminalAction: "attention",
      retryDelayMs: null
    };
  }

  return {
    failureClass,
    retryable: true,
    terminalAction: "retry",
    retryDelayMs: boundedRetryDelay(bounded, random)
  };
}
