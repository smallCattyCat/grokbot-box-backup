import { randomUUID } from "node:crypto";
import {
  COURSE_TOOL_VERIFICATION_SCHEMA_VERSION,
  type CourseToolBusinessInput,
  type CourseToolDefinition,
  type CourseToolHandlerResult,
  type CourseToolJsonValue,
  type CourseToolVerificationCheck,
  type CourseToolVerificationPolicy,
  type CourseToolVerificationReceipt,
  type CourseToolVerificationReport,
  type ServerToolExecutionContext,
  type ToolExecutionEnvelope,
  CourseToolContractError,
  assertCourseToolJsonValue,
  assertEvidenceRefs,
  isCourseToolName,
  isCourseToolVersion,
  isIsoInstant,
  isSafeIdentifier,
  sanitizeCourseToolSummary
} from "./contracts";

export const COURSE_TOOL_VERIFIER_REGISTRY_SCHEMA_VERSION =
  "cmooc.course-tool-verifier-registry.v1" as const;

export interface CourseToolVerifierDefinition {
  readonly name: string;
  readonly version: string;
  readonly safeLabel: string;
}

export interface CourseToolVerifierInput<
  I extends CourseToolBusinessInput = CourseToolBusinessInput,
  O extends CourseToolJsonValue = CourseToolJsonValue
> {
  readonly definition: CourseToolDefinition<I, O>;
  readonly context: Readonly<ServerToolExecutionContext>;
  readonly envelope: Readonly<ToolExecutionEnvelope<I>>;
  readonly handlerResult: Readonly<CourseToolHandlerResult<O>>;
}

export interface CourseToolVerifierResult {
  readonly status: "passed" | "failed" | "unknown";
  readonly checks: readonly CourseToolVerificationCheck[];
  readonly evidenceRefs: readonly import("./contracts").EvidenceRef[];
  readonly expiresAt?: string;
  readonly containsForumText: false;
  readonly containsIdentity: false;
  readonly containsSecrets: false;
}

export interface CourseToolVerifierRegistration<
  I extends CourseToolBusinessInput = CourseToolBusinessInput,
  O extends CourseToolJsonValue = CourseToolJsonValue
> {
  readonly definition: CourseToolVerifierDefinition;
  readonly verify: (
    input: CourseToolVerifierInput<I, O>
  ) => Promise<CourseToolVerifierResult>;
}

type AnyVerifierRegistration = CourseToolVerifierRegistration<
  CourseToolBusinessInput,
  CourseToolJsonValue
>;

export interface CourseToolVerifierManifestEntry {
  readonly name: string;
  readonly version: string;
  readonly safeLabel: string;
}

export interface CourseToolVerifierRegistryManifest {
  readonly schemaVersion: typeof COURSE_TOOL_VERIFIER_REGISTRY_SCHEMA_VERSION;
  readonly sealed: boolean;
  readonly verifiers: readonly CourseToolVerifierManifestEntry[];
}

export class CourseToolVerifierRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CourseToolVerifierRegistryError";
    this.code = code;
  }
}

export interface CourseToolVerifierRegistryOptions {
  readonly idFactory?: () => string;
}

export class CourseToolVerifierRegistry {
  readonly #registrations = new Map<string, AnyVerifierRegistration>();
  readonly #idFactory: () => string;
  #sealed = false;

  constructor(options: CourseToolVerifierRegistryOptions = {}) {
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  register<I extends CourseToolBusinessInput, O extends CourseToolJsonValue>(
    registration: CourseToolVerifierRegistration<I, O>
  ): this {
    if (this.#sealed) {
      throw new CourseToolVerifierRegistryError(
        "COURSE_TOOL_VERIFIER_REGISTRY_SEALED",
        "Course tool verifier registry is sealed."
      );
    }
    validateVerifierRegistration(registration);
    const key = verifierKey(
      registration.definition.name,
      registration.definition.version
    );
    if (this.#registrations.has(key)) {
      throw new CourseToolVerifierRegistryError(
        "COURSE_TOOL_VERIFIER_COLLISION",
        `Verifier ${registration.definition.name}@${registration.definition.version} is already registered.`
      );
    }
    this.#registrations.set(
      key,
      Object.freeze({
        definition: Object.freeze({ ...registration.definition }),
        verify: registration.verify
      }) as AnyVerifierRegistration
    );
    return this;
  }

  seal(): this {
    this.#sealed = true;
    return this;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  resolve(name: string, version: string): AnyVerifierRegistration | undefined {
    return this.#registrations.get(verifierKey(name, version));
  }

  manifest(): CourseToolVerifierRegistryManifest {
    return Object.freeze({
      schemaVersion: COURSE_TOOL_VERIFIER_REGISTRY_SCHEMA_VERSION,
      sealed: this.#sealed,
      verifiers: Object.freeze(
        [...this.#registrations.values()]
          .sort((left, right) =>
            left.definition.name.localeCompare(right.definition.name) ||
            left.definition.version.localeCompare(right.definition.version)
          )
          .map((registration) =>
            Object.freeze({ ...registration.definition })
          )
      )
    });
  }

  async verify<I extends CourseToolBusinessInput, O extends CourseToolJsonValue>(
    input: CourseToolVerifierInput<I, O> & {
      readonly policy: CourseToolVerificationPolicy;
      readonly subject: {
        readonly type: import("./contracts").VerificationSubjectType;
        readonly id: string;
      };
      readonly observedAt: string;
    }
  ): Promise<CourseToolVerificationReport> {
    if (!isIsoInstant(input.observedAt) || !isSafeIdentifier(input.subject.id)) {
      throw new CourseToolVerifierRegistryError(
        "COURSE_TOOL_VERIFICATION_SUBJECT_INVALID",
        "Course tool verification subject is invalid."
      );
    }
    if (input.subject.type !== input.policy.subjectType) {
      throw new CourseToolVerifierRegistryError(
        "COURSE_TOOL_VERIFICATION_SUBJECT_MISMATCH",
        "Course tool verification subject does not match the tool policy."
      );
    }
    const receipts: CourseToolVerificationReceipt[] = [];
    for (const ref of input.policy.verifiers) {
      const registration = this.resolve(ref.name, ref.version);
      if (!registration) {
        receipts.push(
          this.#fallbackReceipt({
            verifier: ref.name,
            verifierVersion: ref.version,
            subject: input.subject,
            observedAt: input.observedAt,
            code: "verifier_unavailable",
            safeSummary: "Required verifier is unavailable."
          })
        );
        continue;
      }
      try {
        const result = await registration.verify(
          input as CourseToolVerifierInput<
            CourseToolBusinessInput,
            CourseToolJsonValue
          >
        );
        validateVerifierResult(result, input.observedAt);
        receipts.push(
          Object.freeze({
            schemaVersion: COURSE_TOOL_VERIFICATION_SCHEMA_VERSION,
            id: this.#nextId(),
            verifier: registration.definition.name,
            verifierVersion: registration.definition.version,
            subjectType: input.subject.type,
            subjectId: input.subject.id,
            status: result.status,
            checks: Object.freeze(
              result.checks.map((check) => Object.freeze({ ...check }))
            ),
            evidenceRefs: Object.freeze([...result.evidenceRefs]),
            observedAt: input.observedAt,
            ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
            containsForumText: false,
            containsIdentity: false,
            containsSecrets: false
          })
        );
      } catch {
        receipts.push(
          this.#fallbackReceipt({
            verifier: registration.definition.name,
            verifierVersion: registration.definition.version,
            subject: input.subject,
            observedAt: input.observedAt,
            code: "verifier_error",
            safeSummary: "Verifier could not establish the postcondition."
          })
        );
      }
    }
    const status = aggregateVerificationStatus(input.policy, receipts);
    return Object.freeze({
      id: this.#nextId(),
      subjectType: input.subject.type,
      subjectId: input.subject.id,
      status,
      receipts: Object.freeze(receipts),
      observedAt: input.observedAt
    });
  }

  #fallbackReceipt(input: {
    verifier: string;
    verifierVersion: string;
    subject: {
      type: import("./contracts").VerificationSubjectType;
      id: string;
    };
    observedAt: string;
    code: string;
    safeSummary: string;
  }): CourseToolVerificationReceipt {
    return Object.freeze({
      schemaVersion: COURSE_TOOL_VERIFICATION_SCHEMA_VERSION,
      id: this.#nextId(),
      verifier: input.verifier,
      verifierVersion: input.verifierVersion,
      subjectType: input.subject.type,
      subjectId: input.subject.id,
      status: "unknown",
      checks: Object.freeze([
        Object.freeze({
          code: input.code,
          status: "unknown" as const,
          safeSummary: input.safeSummary
        })
      ]),
      evidenceRefs: Object.freeze([]),
      observedAt: input.observedAt,
      containsForumText: false,
      containsIdentity: false,
      containsSecrets: false
    });
  }

  #nextId(): string {
    const id = this.#idFactory();
    if (!isSafeIdentifier(id)) {
      throw new CourseToolVerifierRegistryError(
        "COURSE_TOOL_VERIFICATION_ID_INVALID",
        "Verification id factory returned an invalid identifier."
      );
    }
    return id;
  }
}

function verifierKey(name: string, version: string): string {
  return `${name}\0${version}`;
}

function validateVerifierRegistration<
  I extends CourseToolBusinessInput,
  O extends CourseToolJsonValue
>(registration: CourseToolVerifierRegistration<I, O>): void {
  if (
    !registration ||
    !isCourseToolName(registration.definition?.name ?? "") ||
    !isCourseToolVersion(registration.definition?.version ?? "") ||
    typeof registration.verify !== "function"
  ) {
    throw new CourseToolVerifierRegistryError(
      "COURSE_TOOL_VERIFIER_INVALID",
      "Course tool verifier registration is invalid."
    );
  }
  const label = registration.definition.safeLabel;
  if (
    typeof label !== "string" ||
    !label.trim() ||
    label.length > 96 ||
    sanitizeCourseToolSummary(label, 96) !== label
  ) {
    throw new CourseToolVerifierRegistryError(
      "COURSE_TOOL_VERIFIER_LABEL_INVALID",
      "Course tool verifier safe label is invalid."
    );
  }
}

function validateVerifierResult(
  result: CourseToolVerifierResult,
  observedAt: string
): void {
  if (
    !result ||
    !["passed", "failed", "unknown"].includes(result.status) ||
    !Array.isArray(result.checks) ||
    result.checks.length === 0 ||
    result.checks.length > 64 ||
    result.containsForumText !== false ||
    result.containsIdentity !== false ||
    result.containsSecrets !== false
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_VERIFIER_RESULT_INVALID",
      "Course tool verifier returned an invalid result."
    );
  }
  const codes = new Set<string>();
  for (const check of result.checks) {
    if (
      !isSafeIdentifier(check.code) ||
      codes.has(check.code) ||
      !["passed", "failed", "unknown", "not_evaluated"].includes(
        check.status
      ) ||
      typeof check.safeSummary !== "string" ||
      !check.safeSummary ||
      sanitizeCourseToolSummary(check.safeSummary) !== check.safeSummary
    ) {
      throw new CourseToolContractError(
        "COURSE_TOOL_VERIFICATION_CHECK_INVALID",
        "Course tool verifier returned an invalid safe check."
      );
    }
    codes.add(check.code);
  }
  const evaluated = result.checks.map((check) => check.status);
  if (
    (result.status === "passed" &&
      evaluated.some((status) => status !== "passed")) ||
    (result.status === "failed" && !evaluated.includes("failed")) ||
    (result.status === "unknown" && !evaluated.includes("unknown"))
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_VERIFICATION_STATUS_INCONSISTENT",
      "Course tool verifier status is inconsistent with its checks."
    );
  }
  assertEvidenceRefs(result.evidenceRefs);
  if (
    result.expiresAt !== undefined &&
    (!isIsoInstant(result.expiresAt) ||
      Date.parse(result.expiresAt) <= Date.parse(observedAt))
  ) {
    throw new CourseToolContractError(
      "COURSE_TOOL_VERIFICATION_EXPIRY_INVALID",
      "Course tool verifier returned an invalid expiry."
    );
  }
  assertCourseToolJsonValue(result.checks as unknown, "verification checks");
}

function aggregateVerificationStatus(
  policy: CourseToolVerificationPolicy,
  receipts: readonly CourseToolVerificationReceipt[]
): CourseToolVerificationReport["status"] {
  if (!policy.required) return "passed";
  const requiredKeys = new Set(
    policy.verifiers
      .filter((ref) => ref.required)
      .map((ref) => verifierKey(ref.name, ref.version))
  );
  const requiredReceipts = receipts.filter((receipt) =>
    requiredKeys.has(verifierKey(receipt.verifier, receipt.verifierVersion))
  );
  if (requiredReceipts.length === 0) return "unknown";
  if (policy.mode === "any") {
    if (requiredReceipts.some((receipt) => receipt.status === "passed")) {
      return "passed";
    }
    if (requiredReceipts.some((receipt) => receipt.status === "unknown")) {
      return "unknown";
    }
    return "failed";
  }
  if (requiredReceipts.some((receipt) => receipt.status === "failed")) {
    return "failed";
  }
  if (
    requiredReceipts.length !== requiredKeys.size ||
    requiredReceipts.some((receipt) => receipt.status === "unknown")
  ) {
    return "unknown";
  }
  return "passed";
}
