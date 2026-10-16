import {
  COURSE_TOOL_SCHEMA_VERSION,
  type CourseToolBusinessInput,
  type CourseToolDefinition,
  type CourseToolJsonValue,
  type CourseToolRegistration,
  type CourseToolRecoveryPolicy,
  type CourseToolVerifierRef,
  CourseToolContractError,
  assertModelSchemaHasNoServerControlledFields,
  assertNonEmptySafeString,
  capabilityRank,
  isCourseToolName,
  isCourseToolVersion,
  isSafeIdentifier,
  minimumCapabilityForEffect,
  sanitizeCourseToolSummary
} from "./contracts";

export const COURSE_TOOL_REGISTRY_SCHEMA_VERSION =
  "cmooc.course-tool-registry.v1" as const;

export interface CourseToolManifestEntry {
  readonly schemaVersion: typeof COURSE_TOOL_SCHEMA_VERSION;
  readonly name: string;
  readonly version: string;
  readonly safeLabel: string;
  readonly safeDescription: string;
  readonly capability: CourseToolDefinition["capability"];
  readonly effect: CourseToolDefinition["effect"];
  readonly dataClasses: readonly string[];
  readonly inputSchemaVersion: string;
  readonly modelInputSchema: Readonly<Record<string, unknown>> | null;
  readonly idempotency: CourseToolDefinition["idempotency"];
  readonly evidenceRequired: boolean;
  readonly verificationRequired: boolean;
  readonly verifierRefs: readonly CourseToolVerifierRef[];
  readonly retryMaxAttempts: number;
  readonly recoveryKind: CourseToolRecoveryPolicy["kind"] | null;
  readonly defaultForName: boolean;
}

export interface CourseToolRegistryManifest {
  readonly schemaVersion: typeof COURSE_TOOL_REGISTRY_SCHEMA_VERSION;
  readonly sealed: boolean;
  readonly tools: readonly CourseToolManifestEntry[];
}

type AnyCourseToolRegistration = CourseToolRegistration<
  CourseToolBusinessInput,
  CourseToolJsonValue
>;

export class CourseToolRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CourseToolRegistryError";
    this.code = code;
  }
}

export function defineCourseTool<
  I extends CourseToolBusinessInput,
  O extends CourseToolJsonValue
>(registration: CourseToolRegistration<I, O>): CourseToolRegistration<I, O> {
  validateRegistration(registration);
  return freezeRegistration(registration);
}

export class CourseToolRegistry {
  readonly #registrations = new Map<string, AnyCourseToolRegistration>();
  readonly #versionsByName = new Map<string, Set<string>>();
  readonly #defaultVersionByName = new Map<string, string>();
  #sealed = false;

  register<I extends CourseToolBusinessInput, O extends CourseToolJsonValue>(
    registration: CourseToolRegistration<I, O>
  ): this {
    if (this.#sealed) {
      throw new CourseToolRegistryError(
        "COURSE_TOOL_REGISTRY_SEALED",
        "Course tool registry is sealed."
      );
    }
    let normalized: CourseToolRegistration<I, O>;
    try {
      normalized = defineCourseTool(registration);
    } catch (error) {
      throw new CourseToolRegistryError(
        "COURSE_TOOL_DEFINITION_INVALID",
        "Course tool definition failed registry validation.",
        { cause: error }
      );
    }
    const { name, version } = normalized.definition;
    const key = registryKey(name, version);
    if (this.#registrations.has(key)) {
      throw new CourseToolRegistryError(
        "COURSE_TOOL_REGISTRY_COLLISION",
        `Course tool ${name}@${version} is already registered.`
      );
    }
    if (
      normalized.defaultForName &&
      this.#defaultVersionByName.has(name)
    ) {
      throw new CourseToolRegistryError(
        "COURSE_TOOL_DEFAULT_VERSION_COLLISION",
        `Course tool ${name} already has a default version.`
      );
    }
    this.#registrations.set(
      key,
      normalized as unknown as AnyCourseToolRegistration
    );
    const versions = this.#versionsByName.get(name) ?? new Set<string>();
    versions.add(version);
    this.#versionsByName.set(name, versions);
    if (normalized.defaultForName) {
      this.#defaultVersionByName.set(name, version);
    }
    return this;
  }

  seal(): this {
    this.#sealed = true;
    return this;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  has(name: string, version: string): boolean {
    return this.#registrations.has(registryKey(name, version));
  }

  resolve(name: string, requestedVersion?: string): AnyCourseToolRegistration {
    if (!isCourseToolName(name)) {
      throw new CourseToolRegistryError(
        "COURSE_TOOL_NOT_FOUND",
        "Requested course tool is not registered."
      );
    }
    let version = requestedVersion;
    if (version === undefined) {
      const versions = this.#versionsByName.get(name);
      if (!versions || versions.size === 0) {
        throw new CourseToolRegistryError(
          "COURSE_TOOL_NOT_FOUND",
          `Course tool ${name} is not registered.`
        );
      }
      if (versions.size === 1) {
        version = [...versions][0];
      } else {
        version = this.#defaultVersionByName.get(name);
        if (!version) {
          throw new CourseToolRegistryError(
            "COURSE_TOOL_VERSION_REQUIRED",
            `Course tool ${name} has multiple versions and no explicit default.`
          );
        }
      }
    }
    if (!isCourseToolVersion(version)) {
      throw new CourseToolRegistryError(
        "COURSE_TOOL_VERSION_INVALID",
        "Requested course tool version is invalid."
      );
    }
    const registration = this.#registrations.get(registryKey(name, version));
    if (!registration) {
      throw new CourseToolRegistryError(
        "COURSE_TOOL_VERSION_NOT_FOUND",
        `Course tool ${name}@${version} is not registered.`
      );
    }
    return registration;
  }

  list(): readonly AnyCourseToolRegistration[] {
    return Object.freeze(
      [...this.#registrations.values()].sort(compareRegistrations)
    );
  }

  manifest(): CourseToolRegistryManifest {
    return Object.freeze({
      schemaVersion: COURSE_TOOL_REGISTRY_SCHEMA_VERSION,
      sealed: this.#sealed,
      tools: Object.freeze(
        this.list().map((registration) => manifestEntry(registration))
      )
    });
  }
}

function registryKey(name: string, version: string): string {
  return `${name}\0${version}`;
}

function compareRegistrations(
  left: AnyCourseToolRegistration,
  right: AnyCourseToolRegistration
): number {
  return (
    left.definition.name.localeCompare(right.definition.name) ||
    left.definition.version.localeCompare(right.definition.version)
  );
}

function validateRegistration<
  I extends CourseToolBusinessInput,
  O extends CourseToolJsonValue
>(registration: CourseToolRegistration<I, O>): void {
  if (!registration || typeof registration !== "object") {
    throw new CourseToolContractError(
      "COURSE_TOOL_REGISTRATION_INVALID",
      "Course tool registration must be an object."
    );
  }
  const definition = registration.definition;
  if (!definition || definition.schemaVersion !== COURSE_TOOL_SCHEMA_VERSION) {
    throw new CourseToolContractError(
      "COURSE_TOOL_SCHEMA_VERSION_INVALID",
      "Course tool definition has an unsupported schemaVersion."
    );
  }
  if (!isCourseToolName(definition.name)) {
    throw new CourseToolContractError(
      "COURSE_TOOL_NAME_INVALID",
      "Course tool name must be a stable lowercase namespace."
    );
  }
  if (!isCourseToolVersion(definition.version)) {
    throw new CourseToolContractError(
      "COURSE_TOOL_VERSION_INVALID",
      "Course tool version is invalid."
    );
  }
  assertSafeMetadataText(definition.safeLabel, "safeLabel", 96);
  assertSafeMetadataText(definition.safeDescription, "safeDescription", 360);
  if (
    definition.capability !== minimumCapabilityForEffect(definition.effect)
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_CAPABILITY_EFFECT_MISMATCH",
      `Course tool ${definition.name} capability does not match its effect class.`
    );
  }
  if (
    !definition.inputSchema ||
    typeof definition.inputSchema.parse !== "function" ||
    !definition.outputSchema ||
    typeof definition.outputSchema.parse !== "function"
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_RUNTIME_SCHEMA_MISSING",
      "Course tool definition requires executable input and output schemas."
    );
  }
  assertNonEmptySafeString(
    definition.inputSchema.schemaVersion,
    "input schema version",
    128
  );
  assertNonEmptySafeString(
    definition.outputSchema.schemaVersion,
    "output schema version",
    128
  );
  if (definition.inputSchema.modelJsonSchema) {
    assertModelSchemaHasNoServerControlledFields(
      definition.inputSchema.modelJsonSchema
    );
  }
  validateDataClasses(definition.dataClasses);
  validatePreconditions(definition.preconditions);
  validateIdempotency(definition);
  validateEvidencePolicy(definition);
  validateVerificationPolicy(definition);
  validateRetryPolicy(definition);
  validateRecoveryPolicy(definition);
  if (typeof registration.handler !== "function") {
    throw new CourseToolContractError(
      "COURSE_TOOL_HANDLER_MISSING",
      "Course tool registration requires a handler."
    );
  }
  if (typeof registration.projectOutput !== "function") {
    throw new CourseToolContractError(
      "COURSE_TOOL_PROJECTOR_MISSING",
      "Course tool registration requires a trusted output projector."
    );
  }
  if (
    registration.summarizeInput !== undefined &&
    typeof registration.summarizeInput !== "function"
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_INPUT_SUMMARIZER_INVALID",
      "Course tool input summarizer must be a function."
    );
  }
}

function validateDataClasses(dataClasses: readonly string[]): void {
  if (
    !Array.isArray(dataClasses) ||
    dataClasses.length > 32 ||
    dataClasses.some((value) => !isSafeIdentifier(value)) ||
    new Set(dataClasses).size !== dataClasses.length
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_DATA_CLASSES_INVALID",
      "Course tool dataClasses must be unique safe identifiers."
    );
  }
}

function validatePreconditions(
  preconditions: CourseToolDefinition["preconditions"]
): void {
  if (!Array.isArray(preconditions) || preconditions.length > 32) {
    throw new CourseToolContractError(
      "COURSE_TOOL_PRECONDITIONS_INVALID",
      "Course tool preconditions are invalid."
    );
  }
  const codes = new Set<string>();
  for (const precondition of preconditions) {
    if (!isSafeIdentifier(precondition.code) || codes.has(precondition.code)) {
      throw new CourseToolContractError(
        "COURSE_TOOL_PRECONDITIONS_INVALID",
        "Course tool precondition codes must be unique safe identifiers."
      );
    }
    assertSafeMetadataText(
      precondition.safeDescription,
      "precondition safeDescription",
      240
    );
    codes.add(precondition.code);
  }
}

function validateIdempotency(definition: CourseToolDefinition): void {
  const { strategy, scope } = definition.idempotency;
  if (
    !["input_hash", "server_key", "stage_nonce", "not_retryable"].includes(
      strategy
    ) ||
    !["step", "run", "task", "course"].includes(scope)
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_IDEMPOTENCY_INVALID",
      "Course tool idempotency policy is invalid."
    );
  }
  if (
    definition.effect === "external_stage" &&
    !["stage_nonce", "server_key"].includes(strategy)
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_STAGE_IDEMPOTENCY_INVALID",
      "External STAGE tools require a server key or trusted stage nonce."
    );
  }
  if (
    definition.effect === "irreversible_external" &&
    !["server_key", "not_retryable"].includes(strategy)
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_IRREVERSIBLE_IDEMPOTENCY_INVALID",
      "Irreversible tools require a server idempotency key or no retry."
    );
  }
}

function validateEvidencePolicy(definition: CourseToolDefinition): void {
  const policy = definition.evidence;
  if (
    typeof policy.required !== "boolean" ||
    !Number.isInteger(policy.minimumRefs) ||
    policy.minimumRefs < 0 ||
    policy.minimumRefs > 128 ||
    (policy.required && policy.minimumRefs < 1) ||
    (policy.allowedKinds !== undefined &&
      (!Array.isArray(policy.allowedKinds) ||
        new Set(policy.allowedKinds).size !== policy.allowedKinds.length))
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_EVIDENCE_POLICY_INVALID",
      "Course tool evidence policy is invalid."
    );
  }
}

function validateVerificationPolicy(definition: CourseToolDefinition): void {
  const policy = definition.verification;
  if (
    typeof policy.required !== "boolean" ||
    !["all", "any"].includes(policy.mode) ||
    !["failed", "unknown"].includes(policy.onFailure) ||
    !Array.isArray(policy.verifiers) ||
    policy.verifiers.length > 16 ||
    (policy.required &&
      !policy.verifiers.some((verifier) => verifier.required))
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_VERIFICATION_POLICY_INVALID",
      "Course tool verification policy is invalid."
    );
  }
  const refs = new Set<string>();
  for (const verifier of policy.verifiers) {
    const key = `${verifier.name}@${verifier.version}`;
    if (
      !isCourseToolName(verifier.name) ||
      !isCourseToolVersion(verifier.version) ||
      typeof verifier.required !== "boolean" ||
      refs.has(key)
    ) {
      throw new CourseToolContractError(
        "COURSE_TOOL_VERIFIER_REF_INVALID",
        "Course tool verifier references must be unique and versioned."
      );
    }
    refs.add(key);
  }
  if (
    capabilityRank(definition.capability) >=
      capabilityRank("L3_EXTERNAL_STAGE") &&
    (!policy.required || policy.onFailure !== "unknown")
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_EXTERNAL_VERIFICATION_INVALID",
      "External effects require fail-closed verification with unknown outcome."
    );
  }
}

function validateRetryPolicy(definition: CourseToolDefinition): void {
  const policy = definition.retry;
  if (
    !Number.isInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 8 ||
    !["none", "exponential"].includes(policy.backoff) ||
    !Array.isArray(policy.retryableStatuses) ||
    policy.retryableStatuses.some((status) => status !== "failed") ||
    new Set(policy.retryableStatuses).size !== policy.retryableStatuses.length ||
    (definition.idempotency.strategy === "not_retryable" &&
      policy.maxAttempts !== 1)
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_RETRY_POLICY_INVALID",
      "Course tool retry policy is invalid or permits blind unknown retry."
    );
  }
}

function validateRecoveryPolicy(definition: CourseToolDefinition): void {
  const recovery = definition.recovery;
  if (
    definition.effect === "reversible_write" &&
    (!recovery ||
      !["compensation", "safe_state", "terminal_reconcile"].includes(
        recovery.kind
      ))
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_REVERSIBLE_RECOVERY_REQUIRED",
      "Reversible tools require a real compensation or safe-state path."
    );
  }
  if (
    definition.effect === "external_stage" &&
    (!recovery ||
      !["trusted_reconcile", "terminal_reconcile"].includes(recovery.kind))
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_STAGE_RECONCILE_REQUIRED",
      "External STAGE tools require a trusted reconcile path."
    );
  }
  if (
    definition.effect === "irreversible_external" &&
    recovery?.kind === "compensation"
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_IRREVERSIBLE_FAKE_UNDO",
      "Irreversible external tools cannot advertise generic compensation."
    );
  }
  if (
    recovery &&
    recovery.kind !== "terminal_reconcile" &&
    (!isCourseToolName(recovery.toolName) ||
      !isCourseToolVersion(recovery.toolVersion) ||
      ("ttlSeconds" in recovery &&
        recovery.ttlSeconds !== undefined &&
        (!Number.isInteger(recovery.ttlSeconds) ||
          recovery.ttlSeconds < 1 ||
          recovery.ttlSeconds > 2_592_000)))
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_RECOVERY_POLICY_INVALID",
      "Course tool recovery policy is invalid."
    );
  }
}

function assertSafeMetadataText(
  value: unknown,
  label: string,
  maxLength: number
): asserts value is string {
  assertNonEmptySafeString(value, label, maxLength);
  if (sanitizeCourseToolSummary(value, maxLength) !== value) {
    throw new CourseToolContractError(
      "COURSE_TOOL_METADATA_NOT_SAFE",
      `${label} contains restricted or non-canonical text.`
    );
  }
}

function freezeRegistration<
  I extends CourseToolBusinessInput,
  O extends CourseToolJsonValue
>(
  registration: CourseToolRegistration<I, O>
): CourseToolRegistration<I, O> {
  const definition = registration.definition;
  const frozenDefinition = Object.freeze({
    ...definition,
    dataClasses: Object.freeze([...definition.dataClasses]),
    preconditions: Object.freeze(
      definition.preconditions.map((value) => Object.freeze({ ...value }))
    ),
    idempotency: Object.freeze({ ...definition.idempotency }),
    evidence: Object.freeze({
      ...definition.evidence,
      ...(definition.evidence.allowedKinds
        ? { allowedKinds: Object.freeze([...definition.evidence.allowedKinds]) }
        : {})
    }),
    verification: Object.freeze({
      ...definition.verification,
      verifiers: Object.freeze(
        definition.verification.verifiers.map((value) =>
          Object.freeze({ ...value })
        )
      )
    }),
    retry: Object.freeze({
      ...definition.retry,
      retryableStatuses: Object.freeze([
        ...definition.retry.retryableStatuses
      ])
    }),
    ...(definition.recovery
      ? { recovery: Object.freeze({ ...definition.recovery }) }
      : {})
  }) as CourseToolDefinition<I, O>;
  return Object.freeze({
    ...registration,
    definition: frozenDefinition,
    defaultForName: registration.defaultForName === true
  });
}

function manifestEntry(
  registration: AnyCourseToolRegistration
): CourseToolManifestEntry {
  const definition = registration.definition;
  return Object.freeze({
    schemaVersion: definition.schemaVersion,
    name: definition.name,
    version: definition.version,
    safeLabel: definition.safeLabel,
    safeDescription: definition.safeDescription,
    capability: definition.capability,
    effect: definition.effect,
    dataClasses: Object.freeze([...definition.dataClasses]),
    inputSchemaVersion: definition.inputSchema.schemaVersion,
    modelInputSchema: definition.inputSchema.modelJsonSchema ?? null,
    idempotency: definition.idempotency,
    evidenceRequired: definition.evidence.required,
    verificationRequired: definition.verification.required,
    verifierRefs: definition.verification.verifiers,
    retryMaxAttempts: definition.retry.maxAttempts,
    recoveryKind: definition.recovery?.kind ?? null,
    defaultForName: registration.defaultForName === true
  });
}
