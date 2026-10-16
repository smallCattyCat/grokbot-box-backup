import {
  COURSE_TOOL_GRANT_SCHEMA_VERSION,
  type CapabilityLevel,
  type CourseToolBusinessInput,
  type CourseToolDefinition,
  type CourseToolJsonValue,
  type EffectClass,
  type ServerToolExecutionContext,
  CourseToolContractError,
  assertServerToolExecutionContext,
  capabilityRank,
  hashOpaqueCourseToolValue,
  isCourseToolName,
  isCourseToolVersion,
  isIsoInstant,
  isSafeIdentifier,
  isSha256
} from "./contracts";

export const COURSE_TOOL_POLICY_VERSION =
  "cmooc.course-tool-policy.v1" as const;
export const COURSE_TOOL_POLICY_DECISION_SCHEMA_VERSION =
  "cmooc.course-tool-policy-decision.v1" as const;

export type CourseToolPolicyReasonCode =
  | "base_capability_granted"
  | "scoped_grant_claimed"
  | "intent_capability_mismatch"
  | "base_capability_insufficient"
  | "scoped_grant_required"
  | "scoped_grant_unavailable"
  | "scoped_grant_scope_mismatch"
  | "scoped_grant_expired_or_consumed"
  | "irreversible_external_locked"
  | "stage_grant_publish_flag_invalid"
  | "irreversible_grant_publish_flag_invalid";

export interface ScopedCourseToolGrant {
  readonly schemaVersion: typeof COURSE_TOOL_GRANT_SCHEMA_VERSION;
  readonly grantRef: string;
  readonly issuer: "course_tool_server";
  readonly capability: CapabilityLevel;
  readonly effect: EffectClass;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly callId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly planRevisionId: string;
  readonly stepId: string;
  readonly courseScopeHash: string;
  readonly inputHash: string;
  readonly idempotencyKeyHash: string;
  readonly policyVersion: string;
  readonly attempt: number;
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly oneShot: true;
  readonly realPublishEnabled: boolean;
}

export interface CourseToolGrantBinding {
  readonly capability: CapabilityLevel;
  readonly effect: EffectClass;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly callId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly planRevisionId: string;
  readonly stepId: string;
  readonly courseScopeHash: string;
  readonly inputHash: string;
  readonly idempotencyKeyHash: string;
  readonly policyVersion: string;
  readonly attempt: number;
}

export type ScopedGrantClaimStatus =
  | "claimed"
  | "not_found"
  | "scope_mismatch"
  | "expired"
  | "consumed"
  | "revoked";

export interface ScopedGrantClaimResult {
  readonly status: ScopedGrantClaimStatus;
  readonly grant?: ScopedCourseToolGrant;
}

/**
 * Implementations own an atomic, protected server store. Returning `claimed`
 * means the one-shot grant was consumed for the supplied exact binding.
 */
export interface ScopedCourseToolGrantAuthority {
  claim(input: {
    readonly grantRef: string;
    readonly binding: CourseToolGrantBinding;
    readonly now: string;
  }): Promise<ScopedGrantClaimResult>;
}

export interface CourseToolAuthorizationRequest {
  readonly definition: CourseToolDefinition<
    CourseToolBusinessInput,
    CourseToolJsonValue
  >;
  readonly context: ServerToolExecutionContext;
  readonly courseScopeHash: string;
  readonly inputHash: string;
}

export interface CourseToolPolicyDecision {
  readonly schemaVersion: typeof COURSE_TOOL_POLICY_DECISION_SCHEMA_VERSION;
  readonly policyVersion: typeof COURSE_TOOL_POLICY_VERSION;
  readonly callId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly requiredCapability: CapabilityLevel;
  readonly effect: EffectClass;
  readonly effectDecision: "allow" | "deny";
  readonly reasonCode: CourseToolPolicyReasonCode;
  readonly grantedCapability?: CapabilityLevel;
  readonly grantRef?: string;
  readonly evaluatedAt: string;
  readonly realPublishEnabled: boolean;
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
}

export interface CourseToolPolicyDecisionSink {
  recordPolicyDecision(decision: CourseToolPolicyDecision): Promise<void>;
}

export interface CourseToolPolicyGatewayOptions {
  readonly grantAuthority?: ScopedCourseToolGrantAuthority;
  readonly decisionSink?: CourseToolPolicyDecisionSink;
  /** Current environment remains false. Enabling still requires an exact L4 grant. */
  readonly irreversibleExternalEnabled?: boolean;
}

export class CourseToolPolicyError extends Error {
  readonly code: "COURSE_TOOL_CAPABILITY_DENIED";
  readonly decision: CourseToolPolicyDecision;

  constructor(decision: CourseToolPolicyDecision) {
    super(
      `Course tool ${decision.toolName}@${decision.toolVersion} denied: ${decision.reasonCode}.`
    );
    this.name = "CourseToolPolicyError";
    this.code = "COURSE_TOOL_CAPABILITY_DENIED";
    this.decision = decision;
  }
}

export class CourseToolPolicyGateway {
  readonly #grantAuthority?: ScopedCourseToolGrantAuthority;
  readonly #decisionSink?: CourseToolPolicyDecisionSink;
  readonly #irreversibleExternalEnabled: boolean;

  constructor(options: CourseToolPolicyGatewayOptions = {}) {
    this.#grantAuthority = options.grantAuthority;
    this.#decisionSink = options.decisionSink;
    this.#irreversibleExternalEnabled =
      options.irreversibleExternalEnabled === true;
  }

  async evaluate(
    request: CourseToolAuthorizationRequest
  ): Promise<CourseToolPolicyDecision> {
    validateAuthorizationRequest(request);
    const { definition, context } = request;
    const evaluatedAt = context.now;
    const deny = async (
      reasonCode: Exclude<
        CourseToolPolicyReasonCode,
        "base_capability_granted" | "scoped_grant_claimed"
      >
    ): Promise<CourseToolPolicyDecision> => {
      const decision = decisionFor(request, {
        effectDecision: "deny",
        reasonCode,
        evaluatedAt,
        realPublishEnabled: false
      });
      await this.#record(decision);
      return decision;
    };

    if (
      context.intent === "inspect" &&
      definition.capability !== "L0_READ"
    ) {
      return deny("intent_capability_mismatch");
    }

    const highRisk = capabilityRank(definition.capability) >= 3;
    if (
      definition.capability === "L4_IRREVERSIBLE" &&
      !this.#irreversibleExternalEnabled
    ) {
      return deny("irreversible_external_locked");
    }

    if (
      !highRisk &&
      capabilityRank(context.baseCapability) >=
        capabilityRank(definition.capability)
    ) {
      const decision = decisionFor(request, {
        effectDecision: "allow",
        reasonCode: "base_capability_granted",
        grantedCapability: definition.capability,
        evaluatedAt,
        realPublishEnabled: false
      });
      await this.#record(decision);
      return decision;
    }

    if (
      context.capabilityGrantRefs.length === 0 ||
      !this.#grantAuthority
    ) {
      return deny(
        highRisk
          ? "scoped_grant_required"
          : "base_capability_insufficient"
      );
    }

    const binding = buildGrantBinding(request);
    let sawScopeMismatch = false;
    let sawExpiredOrConsumed = false;
    for (const grantRef of new Set(context.capabilityGrantRefs)) {
      const claim = await this.#grantAuthority.claim({
        grantRef,
        binding,
        now: evaluatedAt
      });
      if (claim.status === "scope_mismatch") {
        sawScopeMismatch = true;
        continue;
      }
      if (
        claim.status === "expired" ||
        claim.status === "consumed" ||
        claim.status === "revoked"
      ) {
        sawExpiredOrConsumed = true;
        continue;
      }
      if (claim.status !== "claimed" || !claim.grant) continue;
      if (!grantMatchesBinding(claim.grant, binding, evaluatedAt)) {
        sawScopeMismatch = true;
        continue;
      }
      if (
        definition.capability === "L3_EXTERNAL_STAGE" &&
        claim.grant.realPublishEnabled
      ) {
        return deny("stage_grant_publish_flag_invalid");
      }
      if (
        definition.capability === "L4_IRREVERSIBLE" &&
        !claim.grant.realPublishEnabled
      ) {
        return deny("irreversible_grant_publish_flag_invalid");
      }
      const decision = decisionFor(request, {
        effectDecision: "allow",
        reasonCode: "scoped_grant_claimed",
        grantedCapability: definition.capability,
        grantRef: claim.grant.grantRef,
        evaluatedAt,
        realPublishEnabled: claim.grant.realPublishEnabled
      });
      await this.#record(decision);
      return decision;
    }

    if (sawScopeMismatch) {
      return deny("scoped_grant_scope_mismatch");
    }
    if (sawExpiredOrConsumed) {
      return deny("scoped_grant_expired_or_consumed");
    }
    return deny("scoped_grant_unavailable");
  }

  async authorize(
    request: CourseToolAuthorizationRequest
  ): Promise<CourseToolPolicyDecision> {
    const decision = await this.evaluate(request);
    if (decision.effectDecision !== "allow") {
      throw new CourseToolPolicyError(decision);
    }
    return decision;
  }

  async #record(decision: CourseToolPolicyDecision): Promise<void> {
    await this.#decisionSink?.recordPolicyDecision(decision);
  }
}

export function buildGrantBinding(
  request: CourseToolAuthorizationRequest
): CourseToolGrantBinding {
  const { definition, context } = request;
  return Object.freeze({
    capability: definition.capability,
    effect: definition.effect,
    toolName: definition.name,
    toolVersion: definition.version,
    callId: context.callId,
    taskId: context.taskId,
    runId: context.runId,
    planRevisionId: context.planRevisionId,
    stepId: context.stepId,
    courseScopeHash: request.courseScopeHash,
    inputHash: request.inputHash,
    idempotencyKeyHash: hashOpaqueCourseToolValue(
      "idempotency-key.v1",
      context.idempotencyKey
    ),
    policyVersion: context.policyVersion,
    attempt: context.attempt
  });
}

export function grantMatchesBinding(
  grant: ScopedCourseToolGrant,
  binding: CourseToolGrantBinding,
  now: string
): boolean {
  if (!isValidScopedGrantShape(grant)) return false;
  if (
    Date.parse(grant.validFrom) > Date.parse(now) ||
    Date.parse(grant.expiresAt) <= Date.parse(now)
  ) {
    return false;
  }
  return (
    grant.capability === binding.capability &&
    grant.effect === binding.effect &&
    grant.toolName === binding.toolName &&
    grant.toolVersion === binding.toolVersion &&
    grant.callId === binding.callId &&
    grant.taskId === binding.taskId &&
    grant.runId === binding.runId &&
    grant.planRevisionId === binding.planRevisionId &&
    grant.stepId === binding.stepId &&
    grant.courseScopeHash === binding.courseScopeHash &&
    grant.inputHash === binding.inputHash &&
    grant.idempotencyKeyHash === binding.idempotencyKeyHash &&
    grant.policyVersion === binding.policyVersion &&
    grant.attempt === binding.attempt
  );
}

function validateAuthorizationRequest(
  request: CourseToolAuthorizationRequest
): void {
  if (!request || typeof request !== "object") {
    throw new CourseToolContractError(
      "COURSE_TOOL_AUTHORIZATION_REQUEST_INVALID",
      "Course tool authorization request is invalid."
    );
  }
  assertServerToolExecutionContext(request.context);
  if (
    !isSha256(request.courseScopeHash) ||
    !isSha256(request.inputHash) ||
    request.context.capabilityGrantRefs.length !==
      new Set(request.context.capabilityGrantRefs).size
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_AUTHORIZATION_BINDING_INVALID",
      "Course tool authorization binding is invalid."
    );
  }
}

function isValidScopedGrantShape(grant: ScopedCourseToolGrant): boolean {
  return (
    grant.schemaVersion === COURSE_TOOL_GRANT_SCHEMA_VERSION &&
    grant.issuer === "course_tool_server" &&
    isSafeIdentifier(grant.grantRef) &&
    isCourseToolName(grant.toolName) &&
    isCourseToolVersion(grant.toolVersion) &&
    isSafeIdentifier(grant.callId) &&
    isSafeIdentifier(grant.taskId) &&
    isSafeIdentifier(grant.runId) &&
    isSafeIdentifier(grant.planRevisionId) &&
    isSafeIdentifier(grant.stepId) &&
    isSha256(grant.courseScopeHash) &&
    isSha256(grant.inputHash) &&
    isSha256(grant.idempotencyKeyHash) &&
    isSafeIdentifier(grant.policyVersion) &&
    Number.isInteger(grant.attempt) &&
    grant.attempt >= 1 &&
    isIsoInstant(grant.validFrom) &&
    isIsoInstant(grant.expiresAt) &&
    Date.parse(grant.validFrom) < Date.parse(grant.expiresAt) &&
    grant.oneShot === true &&
    typeof grant.realPublishEnabled === "boolean"
  );
}

function decisionFor(
  request: CourseToolAuthorizationRequest,
  decision: {
    effectDecision: "allow" | "deny";
    reasonCode: CourseToolPolicyReasonCode;
    grantedCapability?: CapabilityLevel;
    grantRef?: string;
    evaluatedAt: string;
    realPublishEnabled: boolean;
  }
): CourseToolPolicyDecision {
  return Object.freeze({
    schemaVersion: COURSE_TOOL_POLICY_DECISION_SCHEMA_VERSION,
    policyVersion: COURSE_TOOL_POLICY_VERSION,
    callId: request.context.callId,
    toolName: request.definition.name,
    toolVersion: request.definition.version,
    requiredCapability: request.definition.capability,
    effect: request.definition.effect,
    effectDecision: decision.effectDecision,
    reasonCode: decision.reasonCode,
    ...(decision.grantedCapability
      ? { grantedCapability: decision.grantedCapability }
      : {}),
    ...(decision.grantRef ? { grantRef: decision.grantRef } : {}),
    evaluatedAt: decision.evaluatedAt,
    realPublishEnabled: decision.realPublishEnabled,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  });
}
