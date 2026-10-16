import { randomUUID } from "node:crypto";
import {
  COURSE_TOOL_DURABLE_CALL_SCHEMA_VERSION,
  COURSE_TOOL_DURABLE_RECEIPT_SCHEMA_VERSION,
  COURSE_TOOL_ENVELOPE_SCHEMA_VERSION,
  COURSE_TOOL_RESULT_SCHEMA_VERSION,
  type CourseToolBusinessInput,
  type CourseToolExecutionOutcome,
  type CourseToolExecutionSink,
  type CourseToolHandlerResult,
  type CourseToolJsonValue,
  type CourseToolOperationError,
  type CourseToolRegistration,
  type CourseToolSafeProjection,
  type CourseToolStatus,
  type DurableToolCallProjection,
  type DurableToolCallStartProjection,
  type ModelToolRequest,
  type ServerToolExecutionContext,
  type ToolExecutionEnvelope,
  type ToolExecutionResult,
  CourseToolContractError,
  assertCourseToolJsonValue,
  assertEvidenceRefs,
  assertNoServerControlledFields,
  assertSafeCourseToolProjection,
  assertServerToolExecutionContext,
  assertStateRef,
  cloneAndFreezeCourseToolJson,
  hashCourseScope,
  hashCourseToolValue,
  hashOpaqueCourseToolValue,
  isIsoInstant,
  isSafeIdentifier,
  parseModelToolRequest,
  sanitizeCourseToolSummary
} from "./contracts";
import {
  CourseToolPolicyGateway,
  type CourseToolPolicyDecision
} from "./policy-gateway";
import { CourseToolRegistry } from "./registry";
import { CourseToolVerifierRegistry } from "./verifier-registry";

export interface CourseToolExecutorOptions {
  readonly registry: CourseToolRegistry;
  readonly policyGateway: CourseToolPolicyGateway;
  readonly verifierRegistry: CourseToolVerifierRegistry;
  readonly sink: CourseToolExecutionSink;
  readonly receiptIdFactory?: () => string;
}

export class CourseToolExecutionError extends Error {
  readonly code: string;
  readonly outcome?: "failed" | "unknown";

  constructor(
    code: string,
    message: string,
    options?: { cause?: unknown; outcome?: "failed" | "unknown" }
  ) {
    super(message, options);
    this.name = "CourseToolExecutionError";
    this.code = code;
    this.outcome = options?.outcome;
  }
}

export type ResolvedCourseToolRegistration = CourseToolRegistration<
  CourseToolBusinessInput,
  CourseToolJsonValue
>;

type AnyRegistration = ResolvedCourseToolRegistration;

export type PreparedCourseToolExecution = Readonly<{
  request: ModelToolRequest;
  registration: ResolvedCourseToolRegistration;
  parsedInput: CourseToolBusinessInput;
  inputHash: string;
  courseScopeHash: string;
  idempotencyKey: string;
  authorizationContext: Readonly<ServerToolExecutionContext>;
}>;

/**
 * Single canonicalization path shared by normal execution and a server-side
 * approval preparer. It validates business-only model input and derives the
 * exact hashes used by the policy gateway without claiming authority or
 * invoking a handler.
 */
export function prepareCourseToolExecution(input: {
  registry: CourseToolRegistry;
  modelRequest: unknown;
  context: ServerToolExecutionContext;
}): PreparedCourseToolExecution {
  assertServerToolExecutionContext(input.context);
  const request = parseModelToolRequest(input.modelRequest);
  const registration = input.registry.resolve(
    request.toolName,
    request.toolVersion
  );
  const definition = registration.definition;
  if (input.context.attempt > definition.retry.maxAttempts) {
    throw new CourseToolExecutionError(
      "COURSE_TOOL_ATTEMPT_LIMIT_EXCEEDED",
      `Course tool attempt ${input.context.attempt} exceeds its retry policy.`
    );
  }
  let parsedInput: CourseToolBusinessInput;
  try {
    const parsed = definition.inputSchema.parse(request.input);
    assertCourseToolJsonValue(parsed, "parsed course tool input");
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new CourseToolContractError(
        "COURSE_TOOL_PARSED_INPUT_INVALID",
        "Course tool input schema must return a business-parameter object."
      );
    }
    assertNoServerControlledFields(parsed);
    parsedInput = cloneAndFreezeCourseToolJson(parsed);
  } catch (error) {
    throw new CourseToolExecutionError(
      "COURSE_TOOL_INPUT_SCHEMA_REJECTED",
      `Course tool ${definition.name}@${definition.version} rejected its business input.`,
      { cause: error }
    );
  }
  const inputHash = hashCourseToolValue(
    `input:${definition.name}@${definition.version}`,
    parsedInput
  );
  const courseScopeHash = hashCourseScope(input.context.courseScope);
  const idempotencyKey = deriveCourseToolIdempotencyKey({
    registration,
    context: input.context,
    inputHash,
    courseScopeHash
  });
  return Object.freeze({
    request,
    registration,
    parsedInput,
    inputHash,
    courseScopeHash,
    idempotencyKey,
    authorizationContext: Object.freeze({
      ...input.context,
      idempotencyKey
    })
  });
}

export class CourseToolExecutor {
  readonly #registry: CourseToolRegistry;
  readonly #policyGateway: CourseToolPolicyGateway;
  readonly #verifierRegistry: CourseToolVerifierRegistry;
  readonly #sink: CourseToolExecutionSink;
  readonly #receiptIdFactory: () => string;

  constructor(options: CourseToolExecutorOptions) {
    this.#registry = options.registry;
    this.#policyGateway = options.policyGateway;
    this.#verifierRegistry = options.verifierRegistry;
    this.#sink = options.sink;
    this.#receiptIdFactory = options.receiptIdFactory ?? randomUUID;
  }

  async execute(
    modelRequest: unknown,
    context: ServerToolExecutionContext
  ): Promise<CourseToolExecutionOutcome> {
    const prepared = prepareCourseToolExecution({
      registry: this.#registry,
      modelRequest,
      context
    });
    const {
      registration,
      parsedInput,
      inputHash,
      courseScopeHash,
      idempotencyKey,
      authorizationContext
    } = prepared;
    const definition = registration.definition;
    const policyDecision = await this.#policyGateway.authorize({
      definition,
      context: authorizationContext,
      courseScopeHash,
      inputHash
    });
    const envelope = createEnvelope({
      registration,
      context: authorizationContext,
      parsedInput,
      inputHash,
      courseScopeHash,
      idempotencyKey,
      policyDecision
    });
    const safeInputSummary = summarizeInput(registration, parsedInput);
    const startProjection = createStartProjection({
      registration,
      context,
      envelope,
      safeInputSummary
    });
    const appended = await this.#sink.appendToolCall(startProjection, {
      callId: context.callId,
      executionLeaseId: context.executionLeaseId,
      leaseGeneration: context.leaseGeneration,
      fencingToken: context.fencingToken
    });
    if (appended !== "accepted") {
      throw new CourseToolExecutionError(
        "COURSE_TOOL_DUPLICATE_CALL",
        `Course tool call ${context.callId} was already claimed; handler execution was suppressed.`
      );
    }

    let outcome: CourseToolExecutionOutcome;
    try {
      outcome = await this.#executeClaimed({
        registration,
        context: authorizationContext,
        envelope,
        safeInputSummary
      });
    } catch (error) {
      outcome = await this.#projectFailure({
        registration,
        context: authorizationContext,
        envelope,
        safeInputSummary,
        error
      });
    }
    try {
      if (outcome.verification) {
        await this.#sink.recordVerification(outcome.verification, {
          callId: context.callId,
          taskId: context.taskId,
          runId: context.runId,
          stepId: context.stepId,
          executionLeaseId: context.executionLeaseId,
          leaseGeneration: context.leaseGeneration,
          fencingToken: context.fencingToken
        });
      }
    } catch (error) {
      throw new CourseToolExecutionError(
        "COURSE_TOOL_VERIFICATION_COMMIT_FAILED",
        "Course tool verification could not be committed under the active lease fence.",
        {
          cause: error,
          outcome: effectMayHaveAmbiguousOutcome(definition.effect)
            ? "unknown"
            : "failed"
        }
      );
    }
    try {
      await this.#sink.commitToolReceipt(outcome.durableProjection, {
        callId: context.callId,
        executionLeaseId: context.executionLeaseId,
        leaseGeneration: context.leaseGeneration,
        fencingToken: context.fencingToken
      });
    } catch (error) {
      throw new CourseToolExecutionError(
        "COURSE_TOOL_RECEIPT_COMMIT_FAILED",
        "Course tool receipt could not be committed under the active lease fence.",
        {
          cause: error,
          outcome: effectMayHaveAmbiguousOutcome(definition.effect)
            ? "unknown"
            : "failed"
        }
      );
    }
    return outcome;
  }

  async #executeClaimed(input: {
    registration: AnyRegistration;
    context: ServerToolExecutionContext;
    envelope: ToolExecutionEnvelope;
    safeInputSummary: string;
  }): Promise<CourseToolExecutionOutcome> {
    const { registration, context, envelope, safeInputSummary } = input;
    const handlerResult = await registration.handler({
      input: envelope.input,
      context,
      envelope
    });
    validateHandlerResult(handlerResult, registration, context.now);
    const output = registration.definition.outputSchema.parse(
      handlerResult.output
    );
    assertCourseToolJsonValue(output, "course tool output");
    const frozenOutput = cloneAndFreezeCourseToolJson(output);
    const outputHash = hashCourseToolValue(
      `output:${registration.definition.name}@${registration.definition.version}`,
      frozenOutput
    );
    const safeProjection = registration.projectOutput(frozenOutput, context);
    assertSafeCourseToolProjection(safeProjection);

    const subject = handlerResult.verificationSubject ?? {
      type: registration.definition.verification.subjectType,
      id: context.callId
    };
    const verification =
      registration.definition.verification.required ||
      registration.definition.verification.verifiers.length > 0
        ? await this.#verifierRegistry.verify({
            definition: registration.definition,
            context,
            envelope,
            handlerResult: Object.freeze({
              ...handlerResult,
              output: frozenOutput
            }),
            policy: registration.definition.verification,
            subject,
            observedAt: context.now
          })
        : undefined;
    const verificationPassed =
      !registration.definition.verification.required ||
      verification?.status === "passed";
    const status: CourseToolStatus = verificationPassed
      ? "succeeded"
      : registration.definition.verification.onFailure;
    const modelProjection = verificationPassed
      ? safeProjection.model
      : Object.freeze({
          status,
          code: "verification_not_passed",
          verificationId: verification?.id ?? "verification-unavailable"
        });
    const safeOutputSummary = verificationPassed
      ? safeSummaryOrFallback(
          safeProjection.safeSummary,
          `Course tool ${registration.definition.safeLabel} completed.`
        )
      : `Course tool postcondition is ${verification?.status ?? "unknown"}; result is ${status}.`;
    const receiptId = this.#nextReceiptId();
    const result = createExecutionResult({
      receiptId,
      callId: context.callId,
      status,
      transientOutput: frozenOutput,
      safeModelProjection: modelProjection,
      outputHash,
      evidenceRefs: handlerResult.evidenceRefs,
      beforeRef: handlerResult.beforeRef,
      afterRef: handlerResult.afterRef,
      verificationId: verification?.id,
      compensationRef: handlerResult.compensationRef,
      observedAt: context.now,
      expiresAt: handlerResult.expiresAt
    });
    const durableProjection = createDurableProjection({
      receiptId,
      envelope,
      status,
      safeInputSummary,
      safeOutputSummary,
      outputHash,
      evidenceRefs: handlerResult.evidenceRefs,
      beforeRef: handlerResult.beforeRef,
      afterRef: handlerResult.afterRef,
      verificationId: verification?.id,
      compensationRef: handlerResult.compensationRef,
      observedAt: context.now
    });
    return Object.freeze({
      result,
      durableProjection,
      ...(verification ? { verification } : {})
    });
  }

  async #projectFailure(input: {
    registration: AnyRegistration;
    context: ServerToolExecutionContext;
    envelope: ToolExecutionEnvelope;
    safeInputSummary: string;
    error: unknown;
  }): Promise<CourseToolExecutionOutcome> {
    const { registration, context, envelope, safeInputSummary, error } = input;
    const operationError = isCourseToolOperationError(error) ? error : undefined;
    const status: Extract<CourseToolStatus, "failed" | "unknown"> =
      operationError?.outcome ??
      (effectMayHaveAmbiguousOutcome(registration.definition.effect)
        ? "unknown"
        : "failed");
    const safeCode = operationError?.safeCode ?? "tool_execution_error";
    const safeOutputSummary = safeSummaryOrFallback(
      operationError?.safeSummary,
      status === "unknown"
        ? "Course tool outcome is unknown and requires verification or reconciliation."
        : "Course tool execution failed before its postcondition was established."
    );
    const evidenceRefs = operationError?.evidenceRefs ?? [];
    const compensationRef = operationError?.compensationRef;
    assertEvidenceRefs(evidenceRefs);
    assertStateRef(operationError?.beforeRef);
    assertStateRef(operationError?.afterRef);
    const outputHash = hashCourseToolValue("failure.v1", {
      code: safeCode,
      status,
      toolName: registration.definition.name,
      toolVersion: registration.definition.version,
      ...(compensationRef ? { compensationRef } : {})
    });
    const receiptId = this.#nextReceiptId();
    const safeModelProjection = Object.freeze({ status, code: safeCode });
    const result = createExecutionResult({
      receiptId,
      callId: context.callId,
      status,
      safeModelProjection,
      outputHash,
      evidenceRefs,
      beforeRef: operationError?.beforeRef,
      afterRef: operationError?.afterRef,
      compensationRef,
      observedAt: context.now
    });
    const durableProjection = createDurableProjection({
      receiptId,
      envelope,
      status,
      safeInputSummary,
      safeOutputSummary,
      outputHash,
      evidenceRefs,
      beforeRef: operationError?.beforeRef,
      afterRef: operationError?.afterRef,
      compensationRef,
      observedAt: context.now
    });
    return Object.freeze({ result, durableProjection });
  }

  #nextReceiptId(): string {
    const value = this.#receiptIdFactory();
    if (!isSafeIdentifier(value)) {
      throw new CourseToolExecutionError(
        "COURSE_TOOL_RECEIPT_ID_INVALID",
        "Course tool receipt id factory returned an invalid identifier."
      );
    }
    return value;
  }
}

export function deriveCourseToolIdempotencyKey(input: {
  registration: AnyRegistration;
  context: ServerToolExecutionContext;
  inputHash: string;
  courseScopeHash: string;
}): string {
  const { definition } = input.registration;
  if (definition.idempotency.strategy !== "input_hash") {
    return hashOpaqueCourseToolValue(
      `idempotency:${definition.idempotency.strategy}.v1`,
      input.context.idempotencyKey
    );
  }
  const scopeRef = (() => {
    switch (definition.idempotency.scope) {
      case "step":
        return input.context.stepId;
      case "run":
        return input.context.runId;
      case "task":
        return input.context.taskId;
      case "course":
        return input.courseScopeHash;
    }
  })();
  return hashCourseToolValue("idempotency.v1", {
    toolName: definition.name,
    toolVersion: definition.version,
    scope: definition.idempotency.scope,
    scopeRef,
    inputHash: input.inputHash
  });
}

function createEnvelope(input: {
  registration: AnyRegistration;
  context: ServerToolExecutionContext;
  parsedInput: CourseToolBusinessInput;
  inputHash: string;
  courseScopeHash: string;
  idempotencyKey: string;
  policyDecision: CourseToolPolicyDecision;
}): ToolExecutionEnvelope {
  const { registration, context, policyDecision } = input;
  if (!policyDecision.grantedCapability) {
    throw new CourseToolExecutionError(
      "COURSE_TOOL_POLICY_DECISION_INVALID",
      "Allowed course tool policy decision omitted its capability."
    );
  }
  return Object.freeze({
    schemaVersion: COURSE_TOOL_ENVELOPE_SCHEMA_VERSION,
    callId: context.callId,
    taskId: context.taskId,
    runId: context.runId,
    planRevisionId: context.planRevisionId,
    stepId: context.stepId,
    courseScope: Object.freeze({ ...context.courseScope }),
    courseScopeHash: input.courseScopeHash,
    toolName: registration.definition.name,
    toolVersion: registration.definition.version,
    input: input.parsedInput,
    inputHash: input.inputHash,
    idempotencyKey: input.idempotencyKey,
    grantedCapability: policyDecision.grantedCapability,
    ...(policyDecision.grantRef ? { grantRef: policyDecision.grantRef } : {}),
    policyVersion: context.policyVersion,
    attempt: context.attempt,
    executionLeaseId: context.executionLeaseId,
    leaseGeneration: context.leaseGeneration,
    fencingToken: context.fencingToken,
    startedAt: context.now,
    deadlineAt: context.deadlineAt
  });
}

function createStartProjection(input: {
  registration: AnyRegistration;
  context: ServerToolExecutionContext;
  envelope: ToolExecutionEnvelope;
  safeInputSummary: string;
}): DurableToolCallStartProjection {
  return Object.freeze({
    schemaVersion: COURSE_TOOL_DURABLE_CALL_SCHEMA_VERSION,
    id: input.context.callId,
    taskId: input.context.taskId,
    runId: input.context.runId,
    stepId: input.context.stepId,
    toolName: input.registration.definition.name,
    toolVersion: input.registration.definition.version,
    capability: input.registration.definition.capability,
    effectClass: input.registration.definition.effect,
    safeInputSummary: input.safeInputSummary,
    inputHash: input.envelope.inputHash,
    idempotencyKey: input.envelope.idempotencyKey,
    attempt: input.context.attempt,
    ...(input.envelope.grantRef ? { grantRef: input.envelope.grantRef } : {}),
    leaseGeneration: input.context.leaseGeneration,
    fencingTokenHash: hashOpaqueCourseToolValue(
      "fencing-token.v1",
      input.context.fencingToken
    ),
    status: "started",
    ...(input.context.causationId
      ? { causationId: input.context.causationId }
      : {}),
    createdAt: input.context.now
  });
}

function createDurableProjection(input: {
  receiptId: string;
  envelope: ToolExecutionEnvelope;
  status: CourseToolStatus;
  safeInputSummary: string;
  safeOutputSummary: string;
  outputHash: string;
  evidenceRefs: readonly import("./contracts").EvidenceRef[];
  beforeRef?: import("./contracts").StateRef;
  afterRef?: import("./contracts").StateRef;
  verificationId?: string;
  compensationRef?: string;
  observedAt: string;
}): DurableToolCallProjection {
  return Object.freeze({
    schemaVersion: COURSE_TOOL_DURABLE_RECEIPT_SCHEMA_VERSION,
    receiptId: input.receiptId,
    callId: input.envelope.callId,
    taskId: input.envelope.taskId,
    runId: input.envelope.runId,
    stepId: input.envelope.stepId,
    toolName: input.envelope.toolName,
    toolVersion: input.envelope.toolVersion,
    status: input.status,
    safeInputSummary: input.safeInputSummary,
    safeOutputSummary: input.safeOutputSummary,
    inputHash: input.envelope.inputHash,
    outputHash: input.outputHash,
    evidenceRefs: Object.freeze([...input.evidenceRefs]),
    ...(input.beforeRef ? { beforeRef: Object.freeze({ ...input.beforeRef }) } : {}),
    ...(input.afterRef ? { afterRef: Object.freeze({ ...input.afterRef }) } : {}),
    ...(input.verificationId ? { verificationId: input.verificationId } : {}),
    ...(input.compensationRef ? { compensationRef: input.compensationRef } : {}),
    observedAt: input.observedAt,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  });
}

function createExecutionResult<O extends CourseToolJsonValue>(input: {
  receiptId: string;
  callId: string;
  status: CourseToolStatus;
  transientOutput?: O;
  safeModelProjection: CourseToolJsonValue;
  outputHash: string;
  evidenceRefs: readonly import("./contracts").EvidenceRef[];
  beforeRef?: import("./contracts").StateRef;
  afterRef?: import("./contracts").StateRef;
  verificationId?: string;
  compensationRef?: string;
  observedAt: string;
  expiresAt?: string;
}): ToolExecutionResult<O> {
  const result: Record<string, unknown> = {
    schemaVersion: COURSE_TOOL_RESULT_SCHEMA_VERSION,
    receiptId: input.receiptId,
    callId: input.callId,
    status: input.status,
    safeModelProjection: cloneAndFreezeCourseToolJson(input.safeModelProjection),
    outputHash: input.outputHash,
    evidenceRefs: Object.freeze([...input.evidenceRefs]),
    ...(input.beforeRef ? { beforeRef: Object.freeze({ ...input.beforeRef }) } : {}),
    ...(input.afterRef ? { afterRef: Object.freeze({ ...input.afterRef }) } : {}),
    ...(input.verificationId ? { verificationId: input.verificationId } : {}),
    ...(input.compensationRef ? { compensationRef: input.compensationRef } : {}),
    observedAt: input.observedAt,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
  if (input.transientOutput !== undefined) {
    Object.defineProperty(result, "transientOutput", {
      value: input.transientOutput,
      enumerable: false,
      configurable: false,
      writable: false
    });
  }
  return Object.freeze(result) as unknown as ToolExecutionResult<O>;
}

function summarizeInput(
  registration: AnyRegistration,
  input: CourseToolBusinessInput
): string {
  let candidate = "";
  try {
    candidate = registration.summarizeInput?.(input) ?? "";
  } catch {
    candidate = "";
  }
  return safeSummaryOrFallback(
    candidate,
    `Validated business parameters for ${registration.definition.safeLabel}.`
  );
}

function safeSummaryOrFallback(
  candidate: unknown,
  fallback: string
): string {
  const safe = sanitizeCourseToolSummary(candidate);
  return safe || sanitizeCourseToolSummary(fallback);
}

function validateHandlerResult(
  result: CourseToolHandlerResult,
  registration: AnyRegistration,
  observedAt: string
): void {
  if (
    !result ||
    result.containsForumText !== false ||
    result.containsIdentity !== false ||
    result.containsSecrets !== false
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_HANDLER_PRIVACY_FLAGS_INVALID",
      "Course tool handler must explicitly exclude restricted durable data."
    );
  }
  assertCourseToolJsonValue(result.output, "course tool handler output");
  assertEvidenceRefs(result.evidenceRefs, registration.definition.evidence);
  assertStateRef(result.beforeRef);
  assertStateRef(result.afterRef);
  if (
    result.compensationRef !== undefined &&
    !isSafeIdentifier(result.compensationRef)
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_COMPENSATION_REF_INVALID",
      "Course tool handler returned an invalid compensation reference."
    );
  }
  if (
    registration.definition.recovery?.kind === "compensation" &&
    !result.compensationRef
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_COMPENSATION_REF_REQUIRED",
      "Reversible course tool omitted its protected compensation reference."
    );
  }
  if (
    result.verificationSubject &&
    (!isSafeIdentifier(result.verificationSubject.id) ||
      result.verificationSubject.type !==
        registration.definition.verification.subjectType)
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_VERIFICATION_SUBJECT_INVALID",
      "Course tool handler returned an invalid verification subject."
    );
  }
  if (
    result.expiresAt !== undefined &&
    (!isIsoInstant(result.expiresAt) ||
      Date.parse(result.expiresAt) <= Date.parse(observedAt))
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_RESULT_EXPIRY_INVALID",
      "Course tool handler returned an invalid result expiry."
    );
  }
}

function isCourseToolOperationError(
  error: unknown
): error is CourseToolOperationError {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Partial<CourseToolOperationError>;
  return (
    (candidate.outcome === "failed" || candidate.outcome === "unknown") &&
    typeof candidate.safeCode === "string" &&
    isSafeIdentifier(candidate.safeCode) &&
    typeof candidate.safeSummary === "string" &&
    Array.isArray(candidate.evidenceRefs) &&
    (candidate.compensationRef === undefined ||
      isSafeIdentifier(candidate.compensationRef))
  );
}

function effectMayHaveAmbiguousOutcome(
  effect: AnyRegistration["definition"]["effect"]
): boolean {
  return [
    "reversible_write",
    "external_stage",
    "irreversible_external"
  ].includes(effect);
}
