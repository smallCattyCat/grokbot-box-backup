import { createHash } from "node:crypto";
import Ajv2020, {
  type AnySchemaObject,
  type ErrorObject,
  type ValidateFunction
} from "ajv/dist/2020";
import {
  canonicalJson,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol/canonical-hash";

export const COURSE_TOOL_SCHEMA_VERSION =
  "cmooc.course-tool.v1" as const;
export const COURSE_TOOL_REQUEST_SCHEMA_VERSION =
  "cmooc.course-tool-request.v1" as const;
export const COURSE_TOOL_ENVELOPE_SCHEMA_VERSION =
  "cmooc.course-tool-envelope.v1" as const;
export const COURSE_TOOL_RESULT_SCHEMA_VERSION =
  "cmooc.course-tool-result.v1" as const;
export const COURSE_TOOL_DURABLE_CALL_SCHEMA_VERSION =
  "cmooc.course-tool-durable-call.v1" as const;
export const COURSE_TOOL_DURABLE_RECEIPT_SCHEMA_VERSION =
  "cmooc.course-tool-durable-receipt.v1" as const;
export const COURSE_TOOL_VERIFICATION_SCHEMA_VERSION =
  "cmooc.course-tool-verification.v1" as const;
export const COURSE_TOOL_GRANT_SCHEMA_VERSION =
  "cmooc.course-tool-scoped-grant.v1" as const;

export const CAPABILITY_LEVELS = [
  "L0_READ",
  "L1_ARTIFACT",
  "L2_REVERSIBLE",
  "L3_EXTERNAL_STAGE",
  "L4_IRREVERSIBLE"
] as const;

export const EFFECT_CLASSES = [
  "pure",
  "read",
  "local_write",
  "reversible_write",
  "external_stage",
  "irreversible_external"
] as const;

export type CapabilityLevel = (typeof CAPABILITY_LEVELS)[number];
export type EffectClass = (typeof EFFECT_CLASSES)[number];
export type CourseToolJsonValue = CanonicalJsonValue;
export type CourseToolBusinessInput = Readonly<{
  [key: string]: CourseToolJsonValue;
}>;

export type CourseToolStatus =
  | "succeeded"
  | "failed"
  | "unknown"
  | "compensated";

export type CourseToolIntent = "inspect" | "implement";

export type EvidenceRefKind =
  | "manifest"
  | "invocation"
  | "snapshot"
  | "world"
  | "coverage"
  | "content_graph"
  | "candidate"
  | "decision"
  | "outcome"
  | "artifact"
  | "stage_receipt"
  | "verification";

export type VerificationSubjectType =
  | "tool_result"
  | "evidence"
  | "artifact_version"
  | "target"
  | "stage_transaction";

export interface EvidenceRef {
  readonly kind: EvidenceRefKind;
  readonly id: string;
  readonly hash: string;
  readonly observedAt: string;
}

export interface StateRef {
  readonly kind: string;
  readonly id: string;
  readonly hash: string;
  readonly observedAt: string;
}

export interface CourseScope {
  /** Raw platform course identity. It remains server-side and transient. */
  readonly courseId: string;
  readonly alias: string;
  readonly manifestHash?: string;
}

/**
 * The orchestrator constructs this object. No field in it is accepted from a
 * model tool request or a browser result.
 */
export interface ServerToolExecutionContext {
  readonly callId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly planRevisionId: string;
  readonly stepId: string;
  readonly courseScope: CourseScope;
  readonly intent: CourseToolIntent;
  readonly baseCapability: CapabilityLevel;
  readonly capabilityGrantRefs: readonly string[];
  readonly policyVersion: string;
  readonly now: string;
  readonly deadlineAt: string;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly executionLeaseId: string;
  readonly leaseGeneration: number;
  /** Opaque lease secret. It is never put in an ordinary projection. */
  readonly fencingToken: string;
  readonly causationId?: string;
}

export interface ModelToolRequest<
  I extends CourseToolBusinessInput = CourseToolBusinessInput
> {
  readonly toolName: string;
  readonly toolVersion?: string;
  readonly input: I;
}

export interface ToolExecutionEnvelope<
  I extends CourseToolBusinessInput = CourseToolBusinessInput
> {
  readonly schemaVersion: typeof COURSE_TOOL_ENVELOPE_SCHEMA_VERSION;
  readonly callId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly planRevisionId: string;
  readonly stepId: string;
  readonly courseScope: CourseScope;
  readonly courseScopeHash: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly input: Readonly<I>;
  readonly inputHash: string;
  readonly idempotencyKey: string;
  readonly grantedCapability: CapabilityLevel;
  readonly grantRef?: string;
  readonly policyVersion: string;
  readonly attempt: number;
  readonly executionLeaseId: string;
  readonly leaseGeneration: number;
  readonly fencingToken: string;
  readonly startedAt: string;
  readonly deadlineAt: string;
}

export interface CourseToolSchema<T extends CourseToolJsonValue> {
  readonly schemaVersion: string;
  /** Model-facing schema. It must describe business parameters only. */
  readonly modelJsonSchema?: Readonly<Record<string, unknown>>;
  parse(value: unknown): T;
}

export interface CourseToolPrecondition {
  readonly code: string;
  readonly safeDescription: string;
}

export interface CourseToolIdempotencyPolicy {
  readonly strategy:
    | "input_hash"
    | "server_key"
    | "stage_nonce"
    | "not_retryable";
  readonly scope: "step" | "run" | "task" | "course";
}

export interface CourseToolEvidencePolicy {
  readonly required: boolean;
  readonly minimumRefs: number;
  readonly allowedKinds?: readonly EvidenceRefKind[];
}

export interface CourseToolVerifierRef {
  readonly name: string;
  readonly version: string;
  readonly required: boolean;
}

export interface CourseToolVerificationPolicy {
  readonly required: boolean;
  readonly subjectType: VerificationSubjectType;
  readonly verifiers: readonly CourseToolVerifierRef[];
  readonly mode: "all" | "any";
  /** A failed postcondition for an external effect must resolve to unknown. */
  readonly onFailure: "failed" | "unknown";
}

export interface CourseToolRetryPolicy {
  readonly maxAttempts: number;
  readonly retryableStatuses: readonly Extract<
    CourseToolStatus,
    "failed"
  >[];
  readonly backoff: "none" | "exponential";
}

export type CourseToolRecoveryPolicy =
  | {
      readonly kind: "compensation" | "safe_state";
      readonly toolName: string;
      readonly toolVersion: string;
      readonly ttlSeconds?: number;
    }
  | {
      readonly kind: "trusted_reconcile";
      readonly toolName: string;
      readonly toolVersion: string;
    }
  | {
      /** This definition is itself the terminal, ownership-safe reconciler. */
      readonly kind: "terminal_reconcile";
    };

export interface CourseToolDefinition<
  I extends CourseToolBusinessInput = CourseToolBusinessInput,
  O extends CourseToolJsonValue = CourseToolJsonValue
> {
  readonly schemaVersion: typeof COURSE_TOOL_SCHEMA_VERSION;
  readonly name: string;
  readonly version: string;
  readonly safeLabel: string;
  readonly safeDescription: string;
  readonly capability: CapabilityLevel;
  readonly effect: EffectClass;
  readonly inputSchema: CourseToolSchema<I>;
  readonly outputSchema: CourseToolSchema<O>;
  readonly dataClasses: readonly string[];
  readonly preconditions: readonly CourseToolPrecondition[];
  readonly idempotency: CourseToolIdempotencyPolicy;
  readonly evidence: CourseToolEvidencePolicy;
  readonly verification: CourseToolVerificationPolicy;
  readonly retry: CourseToolRetryPolicy;
  readonly recovery?: CourseToolRecoveryPolicy;
}

export interface CourseToolHandlerResult<
  O extends CourseToolJsonValue = CourseToolJsonValue
> {
  readonly output: O;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly beforeRef?: StateRef;
  readonly afterRef?: StateRef;
  /** Non-replayable reference only; a compensation secret stays protected. */
  readonly compensationRef?: string;
  readonly verificationSubject?: {
    readonly type: VerificationSubjectType;
    readonly id: string;
  };
  readonly expiresAt?: string;
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
}

export interface CourseToolHandlerRequest<
  I extends CourseToolBusinessInput = CourseToolBusinessInput
> {
  readonly input: Readonly<I>;
  readonly context: Readonly<ServerToolExecutionContext>;
  readonly envelope: Readonly<ToolExecutionEnvelope<I>>;
}

export type CourseToolHandler<
  I extends CourseToolBusinessInput = CourseToolBusinessInput,
  O extends CourseToolJsonValue = CourseToolJsonValue
> = (
  request: CourseToolHandlerRequest<I>
) => Promise<CourseToolHandlerResult<O>>;

export interface CourseToolSafeProjection {
  /** Transient, bounded model view. It never enters the ordinary ledger. */
  readonly model: CourseToolJsonValue;
  readonly safeSummary: string;
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
}

export interface CourseToolRegistration<
  I extends CourseToolBusinessInput = CourseToolBusinessInput,
  O extends CourseToolJsonValue = CourseToolJsonValue
> {
  readonly definition: CourseToolDefinition<I, O>;
  readonly handler: CourseToolHandler<I, O>;
  /** Must summarize without serializing the original business input. */
  readonly summarizeInput?: (input: Readonly<I>) => string;
  /** Trusted projector separating transient output from model/durable views. */
  readonly projectOutput: (
    output: Readonly<O>,
    context: Readonly<ServerToolExecutionContext>
  ) => CourseToolSafeProjection;
  readonly defaultForName?: boolean;
}

export interface CourseToolVerificationCheck {
  readonly code: string;
  readonly status: "passed" | "failed" | "unknown" | "not_evaluated";
  readonly safeSummary: string;
}

export interface CourseToolVerificationReceipt {
  readonly schemaVersion: typeof COURSE_TOOL_VERIFICATION_SCHEMA_VERSION;
  readonly id: string;
  readonly verifier: string;
  readonly verifierVersion: string;
  readonly subjectType: VerificationSubjectType;
  readonly subjectId: string;
  readonly status: "passed" | "failed" | "unknown";
  readonly checks: readonly CourseToolVerificationCheck[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly observedAt: string;
  readonly expiresAt?: string;
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
}

export interface CourseToolVerificationReport {
  readonly id: string;
  readonly subjectType: VerificationSubjectType;
  readonly subjectId: string;
  readonly status: "passed" | "failed" | "unknown";
  readonly receipts: readonly CourseToolVerificationReceipt[];
  readonly observedAt: string;
}

export interface ToolExecutionResult<
  O extends CourseToolJsonValue = CourseToolJsonValue
> {
  readonly schemaVersion: typeof COURSE_TOOL_RESULT_SCHEMA_VERSION;
  readonly receiptId: string;
  readonly callId: string;
  readonly status: CourseToolStatus;
  /** Non-enumerable and in-process only. */
  readonly transientOutput?: O;
  readonly safeModelProjection: CourseToolJsonValue;
  readonly outputHash: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly beforeRef?: StateRef;
  readonly afterRef?: StateRef;
  readonly verificationId?: string;
  readonly compensationRef?: string;
  readonly observedAt: string;
  readonly expiresAt?: string;
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
}

export interface DurableToolCallStartProjection {
  readonly schemaVersion: typeof COURSE_TOOL_DURABLE_CALL_SCHEMA_VERSION;
  readonly id: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly capability: CapabilityLevel;
  readonly effectClass: EffectClass;
  readonly safeInputSummary: string;
  readonly inputHash: string;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly grantRef?: string;
  readonly leaseGeneration: number;
  /** Hash only. The plain fencing token is never durable. */
  readonly fencingTokenHash: string;
  readonly status: "started";
  readonly causationId?: string;
  readonly createdAt: string;
}

export interface DurableToolCallProjection {
  readonly schemaVersion: typeof COURSE_TOOL_DURABLE_RECEIPT_SCHEMA_VERSION;
  readonly receiptId: string;
  readonly callId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly status: CourseToolStatus;
  readonly safeInputSummary: string;
  readonly safeOutputSummary: string;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly beforeRef?: StateRef;
  readonly afterRef?: StateRef;
  readonly verificationId?: string;
  readonly compensationRef?: string;
  readonly observedAt: string;
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
}

export interface CourseToolExecutionOutcome<
  O extends CourseToolJsonValue = CourseToolJsonValue
> {
  readonly result: ToolExecutionResult<O>;
  readonly durableProjection: DurableToolCallProjection;
  readonly verification?: CourseToolVerificationReport;
}

export interface ToolReceiptCommitFence {
  readonly callId: string;
  readonly executionLeaseId: string;
  readonly leaseGeneration: number;
  /** Transient comparison material; implementations must never persist it. */
  readonly fencingToken: string;
}

export interface ToolVerificationCommitContext extends ToolReceiptCommitFence {
  readonly taskId: string;
  readonly runId: string;
  readonly stepId: string;
}

export interface CourseToolExecutionSink {
  appendToolCall(
    projection: DurableToolCallStartProjection,
    fence: ToolReceiptCommitFence
  ): Promise<"accepted" | "duplicate">;
  recordVerification(
    report: CourseToolVerificationReport,
    context: ToolVerificationCommitContext
  ): Promise<void>;
  commitToolReceipt(
    projection: DurableToolCallProjection,
    fence: ToolReceiptCommitFence
  ): Promise<void>;
}

export type CourseToolFailureOutcome = "failed" | "unknown";

export class CourseToolContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CourseToolContractError";
    this.code = code;
  }
}

/** A handler can expose only a bounded safe failure, never a raw error/output. */
export class CourseToolOperationError extends Error {
  readonly outcome: CourseToolFailureOutcome;
  readonly safeCode: string;
  readonly safeSummary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly beforeRef?: StateRef;
  readonly afterRef?: StateRef;
  /**
   * Safe, opaque recovery handle for an effect whose terminal state is not yet
   * known. The executor validates this as a non-secret identifier before it can
   * enter a receipt; protected compensation material remains server-side.
   */
  readonly compensationRef?: string;

  constructor(input: {
    outcome: CourseToolFailureOutcome;
    safeCode: string;
    safeSummary: string;
    evidenceRefs?: readonly EvidenceRef[];
    beforeRef?: StateRef;
    afterRef?: StateRef;
    compensationRef?: string;
  }) {
    super(input.safeCode);
    this.name = "CourseToolOperationError";
    this.outcome = input.outcome;
    this.safeCode = input.safeCode;
    this.safeSummary = input.safeSummary;
    this.evidenceRefs = input.evidenceRefs ?? [];
    this.beforeRef = input.beforeRef;
    this.afterRef = input.afterRef;
    this.compensationRef = input.compensationRef;
  }
}

const TOOL_NAME_PATTERN =
  /^[a-z][a-z0-9]*(?:[._-][a-z][a-z0-9]*)+$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 20_000;
const MAX_JSON_STRING_LENGTH = 262_144;
export const COURSE_TOOL_SAFE_SUMMARY_MAX_LENGTH = 360;

const RESERVED_SERVER_FIELDS = new Set([
  "callid",
  "task",
  "taskid",
  "run",
  "runid",
  "planrevisionid",
  "step",
  "stepid",
  "course",
  "courseid",
  "coursealias",
  "coursescope",
  "coursescopehash",
  "capability",
  "basecapability",
  "requiredcapability",
  "grantedcapability",
  "capabilitygrantrefs",
  "grantref",
  "policyversion",
  "inputhash",
  "outputhash",
  "idempotency",
  "idempotencykey",
  "attempt",
  "lease",
  "executionleaseid",
  "leasegeneration",
  "fencing",
  "fencingtoken",
  "deadlineat",
  "receiptid"
]);

const SENSITIVE_PROJECTION_FIELDS = new Set([
  "secret",
  "secrets",
  "token",
  "accesstoken",
  "refreshtoken",
  "stagetoken",
  "capabilitytoken",
  "password",
  "passwd",
  "cookie",
  "cookies",
  "authorization",
  "authstate",
  "credential",
  "credentials",
  "fencingtoken",
  "compensationsecret",
  "body",
  "draftbody",
  "rawbody",
  "text",
  "rawtext",
  "content",
  "rawcontent",
  "posttitle",
  "targettext",
  "username",
  "displayname",
  "email",
  "phone",
  "identity",
  "platformid",
  "accountid",
  "courseid",
  "rawoutput",
  "transientoutput",
  "browserprofile",
  "forumtext",
  "forumbody"
]);

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "[credential redacted]"],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[credential redacted]"],
  [
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    "[credential redacted]"
  ],
  [
    /\b(?:api[_-]?key|token|password|passwd|cookie|authorization|auth[_-]?state)\b\s*[:=]\s*[^\s,;]+/gi,
    "[sensitive field redacted]"
  ],
  [/https?:\/\/[^\s<>"']+/gi, "[link redacted]"],
  [/(?:[A-Za-z]:\\|\\\\)[^\r\n<>"|?*]+/g, "[local path redacted]"],
  [/(?:\/Users\/|\/home\/)[^\s<>"']+/g, "[local path redacted]"]
] as const;

function normalizeControlField(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertCourseToolJsonValue(
  value: unknown,
  label = "value"
): asserts value is CourseToolJsonValue {
  let nodes = 0;
  const visit = (candidate: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new CourseToolContractError(
        "COURSE_TOOL_JSON_LIMIT_EXCEEDED",
        `${label} exceeds the bounded JSON contract at ${path}.`
      );
    }
    if (
      candidate === null ||
      typeof candidate === "boolean"
    ) {
      return;
    }
    if (typeof candidate === "string") {
      if (candidate.length > MAX_JSON_STRING_LENGTH) {
        throw new CourseToolContractError(
          "COURSE_TOOL_JSON_STRING_TOO_LONG",
          `${label} contains an oversized string at ${path}.`
        );
      }
      return;
    }
    if (typeof candidate === "number") {
      if (!Number.isSafeInteger(candidate) || Object.is(candidate, -0)) {
        throw new CourseToolContractError(
          "COURSE_TOOL_JSON_NUMBER_INVALID",
          `${label} contains a non-canonical number at ${path}.`
        );
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (let index = 0; index < candidate.length; index += 1) {
        if (!(index in candidate)) {
          throw new CourseToolContractError(
            "COURSE_TOOL_JSON_SPARSE_ARRAY",
            `${label} contains a sparse array at ${path}.`
          );
        }
        visit(candidate[index], `${path}[${index}]`, depth + 1);
      }
      return;
    }
    if (!isPlainObject(candidate)) {
      throw new CourseToolContractError(
        "COURSE_TOOL_JSON_OBJECT_INVALID",
        `${label} must contain only plain JSON objects at ${path}.`
      );
    }
    for (const [key, child] of Object.entries(candidate)) {
      visit(child, `${path}.${key}`, depth + 1);
    }
  };
  visit(value, "$", 0);
}

export function cloneAndFreezeCourseToolJson<
  T extends CourseToolJsonValue
>(value: T): T {
  assertCourseToolJsonValue(value);
  const clone = (candidate: CourseToolJsonValue): CourseToolJsonValue => {
    if (Array.isArray(candidate)) {
      return Object.freeze(candidate.map((item) => clone(item)));
    }
    if (candidate !== null && typeof candidate === "object") {
      return Object.freeze(
        Object.fromEntries(
          Object.entries(candidate).map(([key, child]) => [key, clone(child)])
        )
      );
    }
    return candidate;
  };
  return clone(value) as T;
}

export function assertNoServerControlledFields(value: unknown): void {
  assertCourseToolJsonValue(value, "model tool input");
  const visit = (candidate: CourseToolJsonValue, path: string): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate)) {
      if (RESERVED_SERVER_FIELDS.has(normalizeControlField(key))) {
        throw new CourseToolContractError(
          "COURSE_TOOL_SERVER_FIELD_INJECTION",
          `Model tool input cannot provide server-controlled field ${path}.${key}.`
        );
      }
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, "$input");
}

export function assertModelSchemaHasNoServerControlledFields(
  schema: Readonly<Record<string, unknown>>
): void {
  const visit = (candidate: unknown, path: string): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (!isPlainObject(candidate)) return;
    if (isPlainObject(candidate.properties)) {
      for (const [propertyName, propertySchema] of Object.entries(
        candidate.properties
      )) {
        if (RESERVED_SERVER_FIELDS.has(normalizeControlField(propertyName))) {
          throw new CourseToolContractError(
            "COURSE_TOOL_SCHEMA_EXPOSES_SERVER_FIELD",
            `Model schema exposes server-controlled property ${path}.${propertyName}.`
          );
        }
        visit(propertySchema, `${path}.${propertyName}`);
      }
    }
    for (const [key, child] of Object.entries(candidate)) {
      if (key !== "properties") visit(child, `${path}.${key}`);
    }
  };
  visit(schema, "$schema");
}

export function parseModelToolRequest(
  value: unknown
): ModelToolRequest {
  if (!isPlainObject(value)) {
    throw new CourseToolContractError(
      "COURSE_TOOL_REQUEST_INVALID",
      "Model tool request must be an object."
    );
  }
  const allowed = new Set(["toolName", "toolVersion", "input"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new CourseToolContractError(
        "COURSE_TOOL_REQUEST_UNKNOWN_FIELD",
        `Model tool request contains unsupported field ${key}.`
      );
    }
  }
  if (
    typeof value.toolName !== "string" ||
    !isCourseToolName(value.toolName)
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_NAME_INVALID",
      "Model tool request has an invalid namespaced tool name."
    );
  }
  if (
    value.toolVersion !== undefined &&
    (typeof value.toolVersion !== "string" ||
      !isCourseToolVersion(value.toolVersion))
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_VERSION_INVALID",
      "Model tool request has an invalid tool version."
    );
  }
  if (!isPlainObject(value.input)) {
    throw new CourseToolContractError(
      "COURSE_TOOL_INPUT_INVALID",
      "Model tool input must be a business-parameter object."
    );
  }
  assertCourseToolJsonValue(value.input, "model tool input");
  assertNoServerControlledFields(value.input);
  const businessInput = cloneAndFreezeCourseToolJson(value.input);
  return Object.freeze({
    toolName: value.toolName,
    ...(value.toolVersion === undefined
      ? {}
      : { toolVersion: value.toolVersion }),
    input: businessInput
  });
}

export function createJsonCourseToolSchema<
  T extends CourseToolJsonValue
>(input: {
  schemaVersion: string;
  modelJsonSchema: Readonly<Record<string, unknown>>;
}): CourseToolSchema<T> {
  assertNonEmptySafeString(input.schemaVersion, "schemaVersion", 128);
  assertModelSchemaHasNoServerControlledFields(input.modelJsonSchema);
  if (
    input.modelJsonSchema.type === "object" &&
    input.modelJsonSchema.additionalProperties !== false
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_SCHEMA_MUST_BE_CLOSED",
      "Object tool schemas must set additionalProperties=false."
    );
  }
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true
  });
  const validator = ajv.compile(
    input.modelJsonSchema as AnySchemaObject
  ) as ValidateFunction;
  return Object.freeze({
    schemaVersion: input.schemaVersion,
    modelJsonSchema: clonePlainObject(input.modelJsonSchema),
    parse(value: unknown): T {
      if (!validator(value)) {
        throw new CourseToolContractError(
          "COURSE_TOOL_SCHEMA_VALIDATION_FAILED",
          formatSchemaErrors(input.schemaVersion, validator.errors)
        );
      }
      assertCourseToolJsonValue(value, input.schemaVersion);
      return cloneAndFreezeCourseToolJson(value) as T;
    }
  });
}

/**
 * Compiles a transient tool-output schema without advertising it to the model
 * or applying the model-input reserved-field rule. The trusted projector still
 * decides which subset can enter model or durable views.
 */
export function createJsonCourseToolOutputSchema<
  T extends CourseToolJsonValue
>(input: {
  schemaVersion: string;
  jsonSchema: Readonly<Record<string, unknown>>;
}): CourseToolSchema<T> {
  assertNonEmptySafeString(input.schemaVersion, "schemaVersion", 128);
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true
  });
  const validator = ajv.compile(input.jsonSchema as AnySchemaObject) as ValidateFunction;
  return Object.freeze({
    schemaVersion: input.schemaVersion,
    parse(value: unknown): T {
      if (!validator(value)) {
        throw new CourseToolContractError(
          "COURSE_TOOL_SCHEMA_VALIDATION_FAILED",
          formatSchemaErrors(input.schemaVersion, validator.errors)
        );
      }
      assertCourseToolJsonValue(value, input.schemaVersion);
      return cloneAndFreezeCourseToolJson(value) as T;
    }
  });
}

function clonePlainObject(
  value: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const clone = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) {
      return Object.freeze(candidate.map((child) => clone(child)));
    }
    if (isPlainObject(candidate)) {
      return Object.freeze(
        Object.fromEntries(
          Object.entries(candidate).map(([key, child]) => [key, clone(child)])
        )
      );
    }
    return candidate;
  };
  return clone(value) as Readonly<Record<string, unknown>>;
}

function formatSchemaErrors(
  schemaVersion: string,
  errors: readonly ErrorObject[] | null | undefined
): string {
  const details = (errors ?? [])
    .slice(0, 8)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
    .join("; ");
  return `Course tool value failed ${schemaVersion}: ${details || "invalid"}.`;
}

export function hashCourseToolValue(
  domain: string,
  value: CourseToolJsonValue
): string {
  assertNonEmptySafeString(domain, "hash domain", 128);
  assertCourseToolJsonValue(value);
  return createHash("sha256")
    .update(`cmooc.course-tool.canonical-sha256.v1\0${domain}\0`, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function hashCourseScope(scope: CourseScope): string {
  assertCourseScope(scope);
  return hashCourseToolValue("course-scope.v1", {
    alias: scope.alias,
    courseId: scope.courseId,
    manifestHash: scope.manifestHash ?? null
  });
}

export function hashOpaqueCourseToolValue(
  domain: string,
  value: string
): string {
  assertNonEmptySafeString(domain, "opaque hash domain", 128);
  if (!value) {
    throw new CourseToolContractError(
      "COURSE_TOOL_OPAQUE_VALUE_EMPTY",
      "Opaque server value cannot be empty."
    );
  }
  return createHash("sha256")
    .update(`cmooc.course-tool.opaque-sha256.v1\0${domain}\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function sanitizeCourseToolSummary(
  value: unknown,
  maxLength = COURSE_TOOL_SAFE_SUMMARY_MAX_LENGTH
): string {
  if (typeof value !== "string") return "";
  let output = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n");
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  output = output.replace(/\s+/g, " ").trim();
  if (output.length <= maxLength) return output;
  return `${output.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function assertSafeCourseToolProjection(
  projection: CourseToolSafeProjection
): void {
  if (
    projection.containsForumText !== false ||
    projection.containsIdentity !== false ||
    projection.containsSecrets !== false
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_PROJECTION_PRIVACY_FLAGS_INVALID",
      "Course tool safe projection must explicitly exclude restricted data."
    );
  }
  assertCourseToolJsonValue(projection.model, "safe model projection");
  const visit = (candidate: CourseToolJsonValue, path: string): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (typeof candidate === "string") {
      if (containsRestrictedProjectionText(candidate)) {
        throw new CourseToolContractError(
          "COURSE_TOOL_PROJECTION_CONTAINS_SENSITIVE_TEXT",
          `Safe model projection contains restricted text at ${path}.`
        );
      }
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate)) {
      if (SENSITIVE_PROJECTION_FIELDS.has(normalizeControlField(key))) {
        throw new CourseToolContractError(
          "COURSE_TOOL_PROJECTION_CONTAINS_SENSITIVE_FIELD",
          `Safe model projection contains restricted field ${path}.${key}.`
        );
      }
      visit(child, `${path}.${key}`);
    }
  };
  visit(projection.model, "$projection");
  const summary = sanitizeCourseToolSummary(projection.safeSummary);
  if (!summary) {
    throw new CourseToolContractError(
      "COURSE_TOOL_PROJECTION_SUMMARY_INVALID",
      "Course tool safe projection requires a non-empty safe summary."
    );
  }
}

function containsRestrictedProjectionText(value: string): boolean {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    return true;
  }
  for (const [pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      pattern.lastIndex = 0;
      return true;
    }
    pattern.lastIndex = 0;
  }
  return false;
}

export function assertEvidenceRefs(
  refs: readonly EvidenceRef[],
  policy?: CourseToolEvidencePolicy
): void {
  if (!Array.isArray(refs)) {
    throw new CourseToolContractError(
      "COURSE_TOOL_EVIDENCE_REFS_INVALID",
      "Course tool evidence references must be an array."
    );
  }
  if (policy?.required && refs.length < policy.minimumRefs) {
    throw new CourseToolContractError(
      "COURSE_TOOL_EVIDENCE_REQUIRED",
      "Course tool result does not satisfy its evidence policy."
    );
  }
  const allowedKinds = policy?.allowedKinds
    ? new Set(policy.allowedKinds)
    : undefined;
  for (const ref of refs) {
    if (
      !ref ||
      !isSafeIdentifier(ref.id) ||
      !HASH_PATTERN.test(ref.hash) ||
      !isIsoInstant(ref.observedAt) ||
      !(
        [
          "manifest",
          "invocation",
          "snapshot",
          "world",
          "coverage",
          "content_graph",
          "candidate",
          "decision",
          "outcome",
          "artifact",
          "stage_receipt",
          "verification"
        ] as const
      ).includes(ref.kind)
    ) {
      throw new CourseToolContractError(
        "COURSE_TOOL_EVIDENCE_REF_INVALID",
        "Course tool result contains an invalid evidence reference."
      );
    }
    if (allowedKinds && !allowedKinds.has(ref.kind)) {
      throw new CourseToolContractError(
        "COURSE_TOOL_EVIDENCE_KIND_NOT_ALLOWED",
        `Evidence kind ${ref.kind} is not allowed by this tool.`
      );
    }
  }
}

export function assertStateRef(ref: StateRef | undefined): void {
  if (ref === undefined) return;
  if (
    !ref ||
    !isSafeIdentifier(ref.kind) ||
    !isSafeIdentifier(ref.id) ||
    !HASH_PATTERN.test(ref.hash) ||
    !isIsoInstant(ref.observedAt)
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_STATE_REF_INVALID",
      "Course tool result contains an invalid state reference."
    );
  }
}

export function assertServerToolExecutionContext(
  context: ServerToolExecutionContext
): void {
  for (const [label, value] of [
    ["callId", context.callId],
    ["taskId", context.taskId],
    ["runId", context.runId],
    ["planRevisionId", context.planRevisionId],
    ["stepId", context.stepId],
    ["policyVersion", context.policyVersion],
    ["idempotencyKey", context.idempotencyKey],
    ["executionLeaseId", context.executionLeaseId]
  ] as const) {
    if (!isSafeIdentifier(value)) {
      throw new CourseToolContractError(
        "COURSE_TOOL_SERVER_CONTEXT_INVALID",
        `Server execution context has an invalid ${label}.`
      );
    }
  }
  assertCourseScope(context.courseScope);
  if (
    !CAPABILITY_LEVELS.includes(context.baseCapability) ||
    !["inspect", "implement"].includes(context.intent) ||
    !isIsoInstant(context.now) ||
    !isIsoInstant(context.deadlineAt) ||
    Date.parse(context.deadlineAt) <= Date.parse(context.now) ||
    !Number.isInteger(context.attempt) ||
    context.attempt < 1 ||
    context.attempt > 100 ||
    !Number.isInteger(context.leaseGeneration) ||
    context.leaseGeneration < 1 ||
    typeof context.fencingToken !== "string" ||
    context.fencingToken.length < 16 ||
    context.fencingToken.length > 1024 ||
    !Array.isArray(context.capabilityGrantRefs) ||
    context.capabilityGrantRefs.some((ref) => !isSafeIdentifier(ref))
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_SERVER_CONTEXT_INVALID",
      "Server execution context is incomplete, expired, or malformed."
    );
  }
  if (context.causationId !== undefined && !isSafeIdentifier(context.causationId)) {
    throw new CourseToolContractError(
      "COURSE_TOOL_SERVER_CONTEXT_INVALID",
      "Server execution context has an invalid causationId."
    );
  }
}

export function assertCourseScope(scope: CourseScope): void {
  if (
    !scope ||
    typeof scope.courseId !== "string" ||
    !scope.courseId.trim() ||
    scope.courseId.length > 256 ||
    /[\u0000-\u001F\u007F]/.test(scope.courseId) ||
    typeof scope.alias !== "string" ||
    !isSafeIdentifier(scope.alias) ||
    (scope.manifestHash !== undefined && !HASH_PATTERN.test(scope.manifestHash))
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_COURSE_SCOPE_INVALID",
      "Server course scope is invalid."
    );
  }
}

export function isCourseToolName(value: string): boolean {
  return TOOL_NAME_PATTERN.test(value) && value.length <= 128;
}

export function isCourseToolVersion(value: string): boolean {
  return VERSION_PATTERN.test(value);
}

export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && SAFE_IDENTIFIER_PATTERN.test(value);
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

export function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function assertNonEmptySafeString(
  value: unknown,
  label: string,
  maxLength: number
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_STRING_INVALID",
      `${label} must be a bounded non-empty string.`
    );
  }
}

export function capabilityRank(capability: CapabilityLevel): number {
  return CAPABILITY_LEVELS.indexOf(capability);
}

export function minimumCapabilityForEffect(effect: EffectClass): CapabilityLevel {
  switch (effect) {
    case "pure":
    case "read":
      return "L0_READ";
    case "local_write":
      return "L1_ARTIFACT";
    case "reversible_write":
      return "L2_REVERSIBLE";
    case "external_stage":
      return "L3_EXTERNAL_STAGE";
    case "irreversible_external":
      return "L4_IRREVERSIBLE";
  }
}
