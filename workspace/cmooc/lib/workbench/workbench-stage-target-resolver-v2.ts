import { createHmac } from "node:crypto";
import {
  assertEvidenceRefs,
  hashCourseToolValue,
  isSafeIdentifier,
  isSha256,
  type EvidenceRef
} from "@/lib/course-tools/contracts";
import {
  canonicalJson,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol/canonical-hash";
import {
  PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
  hashPreExecutionTargetObservation,
  type BoundPreExecutionTargetObservation,
  type PreExecutionTargetObservation
} from "@/lib/autonomy/execution-permit";
import type { CourseAgentStageTargetMaterial } from "@/lib/workbench/course-agent-artifact-runtime";
import {
  WORKBENCH_RESOLVED_STAGE_TARGET_RECEIPT_SCHEMA_VERSION,
  WORKBENCH_STAGE_TARGET_RESOLUTION_SCHEMA_VERSION,
  buildResolvedWorkbenchStageTargetReceiptV2,
  type ResolvedWorkbenchStageTarget,
  type WorkbenchResolvedStageTargetReceiptV2,
  type WorkbenchStageTargetResolver
} from "@/lib/workbench/trusted-workbench-platform-stage-adapter";

/**
 * This module is a server composition primitive. It deliberately has no
 * manifest discovery, credential provider, browser state, filesystem, or
 * network dependency. The injected reader owns one transient, read-only
 * observation and must not return forum text or identities.
 */
export const WORKBENCH_STAGE_TARGET_TRANSIENT_READ_REQUEST_SCHEMA_VERSION =
  "cmooc.workbench-stage-target-transient-read-request.v2" as const;
export const WORKBENCH_STAGE_TARGET_TRANSIENT_READ_SCHEMA_VERSION =
  "cmooc.workbench-stage-target-transient-read.v2" as const;
export const WORKBENCH_STAGE_LOCATOR_HMAC_SCHEMA_VERSION =
  "cmooc.workbench-stage-locator-hmac.v2" as const;

export const WORKBENCH_STAGE_TARGET_MAX_AGE_MS = 30_000;
export const WORKBENCH_STAGE_TARGET_MAX_FUTURE_SKEW_MS = 5_000;

const MAX_EVIDENCE_REFS = 64;
const MAX_RAW_LOCATOR_LENGTH = 2_048;
const MAX_URL_LENGTH = 2_048;
const MINIMUM_SERVER_KEY_BYTES = 32;

const RESOLVE_INPUT_KEYS = Object.freeze([
  "target",
  "courseAlias",
  "courseScopeHash",
  "manifestHash",
  "requestedAt"
] as const);

const TARGET_KEYS = Object.freeze([
  "targetRef",
  "opportunityId",
  "candidateKey",
  "decisionId",
  "threadKey",
  "targetVersionHash",
  "eventSetHash",
  "opportunityReceiptHash",
  "revalidationReceiptHash",
  "afterObservationReceiptHash",
  "evidenceRefs"
] as const);

const EVIDENCE_REF_KEYS = Object.freeze([
  "kind",
  "id",
  "hash",
  "observedAt"
] as const);

const TRANSIENT_READ_KEYS = Object.freeze([
  "schemaVersion",
  "courseAlias",
  "courseScopeHash",
  "manifestHash",
  "targetRef",
  "opportunityId",
  "candidateKey",
  "decisionId",
  "threadKey",
  "opportunityReceiptHash",
  "sourceRevalidationReceiptHash",
  "sourceAfterObservationReceiptHash",
  "targetUrl",
  "allowedOrigin",
  "targetLocator",
  "targetVersionHash",
  "eventSetHash",
  "observedAt",
  "evidenceRefs",
  "readOnly",
  "externalWriteAttempted",
  "containsForumText",
  "containsIdentity",
  "containsSecrets"
] as const);

const PRE_EXECUTION_OBSERVATION_KEYS = Object.freeze([
  "schemaVersion",
  "courseAlias",
  "threadKey",
  "targetVersionHash",
  "eventSetHash",
  "observedAt",
  "containsForumText"
] as const);

const BOUND_OBSERVATION_KEYS = Object.freeze([
  "receipt",
  "receiptHash"
] as const);

const BUILT_RECEIPT_KEYS = Object.freeze([
  "receipt",
  "receiptRef",
  "receiptHash"
] as const);

const RESOLVED_RECEIPT_KEYS = Object.freeze([
  "schemaVersion",
  "courseAlias",
  "courseScopeHash",
  "manifestHash",
  "stageTargetBindingHash",
  "targetRef",
  "opportunityId",
  "candidateKey",
  "decisionId",
  "threadKey",
  "sourceRevalidationReceiptHash",
  "sourceAfterObservationReceiptHash",
  "courseLocatorHash",
  "targetLocatorHash",
  "targetVersionHash",
  "eventSetHash",
  "freshObservationRef",
  "freshObservationHash",
  "resolvedAt",
  "readOnly",
  "externalWriteAttempted",
  "containsForumText",
  "containsIdentity",
  "containsSecrets"
] as const);

const LOCATOR_HMAC_DOMAINS = Object.freeze([
  "course-origin",
  "target-url",
  "target-locator",
  "target-binding"
] as const);

const RAW_LOCATOR_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]{0,2047}$/;
const SENSITIVE_URL_PARAMETER =
  /^(?:access[_-]?token|api[_-]?key|auth|authorization|cookie|credential|jwt|password|secret|session|signature|token)$/i;

export type WorkbenchStageLocatorHmacDomainV2 =
  (typeof LOCATOR_HMAC_DOMAINS)[number];

export type WorkbenchStageTargetTransientReadRequestV2 = Readonly<{
  schemaVersion:
    typeof WORKBENCH_STAGE_TARGET_TRANSIENT_READ_REQUEST_SCHEMA_VERSION;
  courseAlias: string;
  courseScopeHash: string;
  manifestHash: string;
  targetRef: string;
  opportunityId: string;
  candidateKey: string;
  decisionId: string;
  threadKey: string;
  expectedTargetVersionHash: string;
  expectedEventSetHash: string;
  opportunityReceiptHash: string;
  sourceRevalidationReceiptHash: string;
  sourceAfterObservationReceiptHash: string;
  requestedAt: string;
  readOnly: true;
  containsForumText: false;
  containsIdentity: false;
  containsSecrets: false;
}>;

/**
 * Raw URL/origin/locator fields exist only for the duration of `resolve`.
 * Consumers may persist only the receipt/evidence projection returned on the
 * resolved target, never this reader result.
 */
export type WorkbenchStageTargetTransientReadV2 = Readonly<{
  schemaVersion: typeof WORKBENCH_STAGE_TARGET_TRANSIENT_READ_SCHEMA_VERSION;
  courseAlias: string;
  courseScopeHash: string;
  manifestHash: string;
  targetRef: string;
  opportunityId: string;
  candidateKey: string;
  decisionId: string;
  threadKey: string;
  opportunityReceiptHash: string;
  sourceRevalidationReceiptHash: string;
  sourceAfterObservationReceiptHash: string;
  targetUrl: string;
  allowedOrigin: string;
  targetLocator: string;
  targetVersionHash: string;
  eventSetHash: string;
  observedAt: string;
  evidenceRefs: readonly EvidenceRef[];
  readOnly: true;
  externalWriteAttempted: false;
  containsForumText: false;
  containsIdentity: false;
  containsSecrets: false;
}>;

export interface WorkbenchStageTargetTransientReaderV2 {
  read(
    request: WorkbenchStageTargetTransientReadRequestV2
  ): Promise<WorkbenchStageTargetTransientReadV2 | null | unknown>;
}

export type WorkbenchStageTargetResolverV2Configuration = Readonly<{
  reader: WorkbenchStageTargetTransientReaderV2;
  serverKey: Buffer | string;
  now?: () => Date;
}>;

type ParsedResolveInput = Readonly<{
  target: CourseAgentStageTargetMaterial;
  courseAlias: string;
  courseScopeHash: string;
  manifestHash: string;
  requestedAt: string;
}>;

type ParsedTransientRead = Readonly<{
  targetUrl: string;
  allowedOrigin: string;
  targetLocator: string;
  targetVersionHash: string;
  eventSetHash: string;
  observedAt: string;
  evidenceRefs: readonly EvidenceRef[];
}>;

function resolverError(
  code:
    | "WORKBENCH_STAGE_TARGET_RESOLVER_SERVER_ONLY"
    | "WORKBENCH_STAGE_TARGET_RESOLVER_CONFIGURATION_INVALID"
    | "WORKBENCH_STAGE_TARGET_LOCATOR_INVALID"
): Error {
  return new Error(code);
}

function assertServerOnlyRuntime(): void {
  if (typeof window !== "undefined") {
    throw resolverError("WORKBENCH_STAGE_TARGET_RESOLVER_SERVER_ONLY");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function canonicalInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? value : null;
}

function normalizeServerKey(value: unknown): Buffer {
  const key = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : typeof value === "string"
      ? Buffer.from(value, "utf8")
      : null;
  if (!key || key.byteLength < MINIMUM_SERVER_KEY_BYTES) {
    throw resolverError(
      "WORKBENCH_STAGE_TARGET_RESOLVER_CONFIGURATION_INVALID"
    );
  }
  return key;
}

function validLocatorDomain(
  value: unknown
): value is WorkbenchStageLocatorHmacDomainV2 {
  return (
    typeof value === "string" &&
    LOCATOR_HMAC_DOMAINS.includes(value as WorkbenchStageLocatorHmacDomainV2)
  );
}

/**
 * Keyed, full-length locator digest. The schema and purpose domain precede a
 * length-delimited raw value so the same locator cannot collide across uses.
 */
export function hmacWorkbenchStageLocatorV2(input: {
  serverKey: Buffer | string;
  domain: WorkbenchStageLocatorHmacDomainV2;
  locator: string;
}): string {
  assertServerOnlyRuntime();
  let key: Buffer;
  try {
    key = normalizeServerKey(input?.serverKey);
    if (
      !validLocatorDomain(input?.domain) ||
      typeof input?.locator !== "string" ||
      input.locator.length === 0 ||
      input.locator.length > 8_192 ||
      /[\u0000-\u001F\u007F]/.test(input.locator)
    ) {
      throw resolverError("WORKBENCH_STAGE_TARGET_LOCATOR_INVALID");
    }
    return createHmac("sha256", key)
      .update(
        `${WORKBENCH_STAGE_LOCATOR_HMAC_SCHEMA_VERSION}\0${input.domain}\0${Buffer.byteLength(input.locator, "utf8")}\0`,
        "utf8"
      )
      .update(input.locator, "utf8")
      .digest("hex");
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message ===
        "WORKBENCH_STAGE_TARGET_RESOLVER_CONFIGURATION_INVALID" ||
        error.message === "WORKBENCH_STAGE_TARGET_LOCATOR_INVALID")
    ) {
      throw error;
    }
    throw resolverError("WORKBENCH_STAGE_TARGET_LOCATOR_INVALID");
  }
}

function canonicalHttpsTarget(input: {
  targetUrl: unknown;
  allowedOrigin: unknown;
}): Readonly<{ targetUrl: string; allowedOrigin: string }> | null {
  if (
    typeof input.targetUrl !== "string" ||
    typeof input.allowedOrigin !== "string" ||
    input.targetUrl.length === 0 ||
    input.targetUrl.length > MAX_URL_LENGTH ||
    input.allowedOrigin.length === 0 ||
    input.allowedOrigin.length > MAX_URL_LENGTH ||
    /[\u0000-\u0020\u007F]/.test(input.targetUrl) ||
    /[\u0000-\u0020\u007F]/.test(input.allowedOrigin)
  ) {
    return null;
  }
  try {
    const targetUrl = new URL(input.targetUrl);
    const allowedOrigin = new URL(input.allowedOrigin);
    if (
      targetUrl.protocol !== "https:" ||
      allowedOrigin.protocol !== "https:" ||
      targetUrl.username !== "" ||
      targetUrl.password !== "" ||
      allowedOrigin.username !== "" ||
      allowedOrigin.password !== "" ||
      targetUrl.hash !== "" ||
      allowedOrigin.pathname !== "/" ||
      allowedOrigin.search !== "" ||
      allowedOrigin.hash !== "" ||
      input.allowedOrigin !== allowedOrigin.origin ||
      input.targetUrl !== targetUrl.href ||
      targetUrl.origin !== allowedOrigin.origin
    ) {
      return null;
    }
    for (const key of targetUrl.searchParams.keys()) {
      if (SENSITIVE_URL_PARAMETER.test(key)) return null;
    }
    return Object.freeze({
      targetUrl: targetUrl.href,
      allowedOrigin: allowedOrigin.origin
    });
  } catch {
    return null;
  }
}

/**
 * The opaque target locator binds both the logical target and every transient
 * navigation locator. Dynamic target/event versions are intentionally absent:
 * their freshness is carried by the pre-execution observation, while a later
 * reconcile read must still resolve the identical logical locator.
 */
export function hashWorkbenchStageTargetLocatorV2(input: {
  serverKey: Buffer | string;
  courseAlias: string;
  courseScopeHash: string;
  manifestHash: string;
  targetRef: string;
  threadKey: string;
  targetUrl: string;
  allowedOrigin: string;
  targetLocator: string;
}): string {
  assertServerOnlyRuntime();
  const canonicalTarget = canonicalHttpsTarget(input);
  if (
    !canonicalTarget ||
    !isSafeIdentifier(input?.courseAlias) ||
    !isSha256(input?.courseScopeHash) ||
    !isSha256(input?.manifestHash) ||
    !isSafeIdentifier(input?.targetRef) ||
    !isSafeIdentifier(input?.threadKey) ||
    typeof input?.targetLocator !== "string" ||
    input.targetLocator.length > MAX_RAW_LOCATOR_LENGTH ||
    !RAW_LOCATOR_PATTERN.test(input.targetLocator)
  ) {
    throw resolverError("WORKBENCH_STAGE_TARGET_LOCATOR_INVALID");
  }
  const binding = canonicalJson({
    courseAlias: input.courseAlias,
    courseScopeHash: input.courseScopeHash,
    manifestHash: input.manifestHash,
    targetRef: input.targetRef,
    threadKey: input.threadKey,
    targetUrl: canonicalTarget.targetUrl,
    allowedOrigin: canonicalTarget.allowedOrigin,
    targetLocator: input.targetLocator
  } as CanonicalJsonValue);
  return hmacWorkbenchStageLocatorV2({
    serverKey: input.serverKey,
    domain: "target-binding",
    locator: binding
  });
}

function parseEvidenceRefs(
  value: unknown,
  options: {
    minimum: number;
    latestAt?: number;
  }
): readonly EvidenceRef[] | null {
  if (
    !Array.isArray(value) ||
    value.length < options.minimum ||
    value.length > MAX_EVIDENCE_REFS
  ) {
    return null;
  }
  try {
    if (value.some((ref) => !hasExactKeys(ref, EVIDENCE_REF_KEYS))) return null;
    assertEvidenceRefs(value as readonly EvidenceRef[]);
    if (
      options.latestAt !== undefined &&
      value.some(
        (ref) => Date.parse((ref as EvidenceRef).observedAt) > options.latestAt!
      )
    ) {
      return null;
    }
    return Object.freeze(
      value.map((ref) => Object.freeze({ ...(ref as EvidenceRef) }))
    );
  } catch {
    return null;
  }
}

function parseResolveInput(value: unknown): ParsedResolveInput | null {
  if (!hasExactKeys(value, RESOLVE_INPUT_KEYS)) return null;
  const record = value as Record<string, unknown>;
  const targetValue = record.target;
  if (!hasExactKeys(targetValue, TARGET_KEYS)) return null;
  const target = targetValue as Record<string, unknown>;
  const requestedAt = canonicalInstant(record.requestedAt);
  const courseAlias = record.courseAlias;
  const courseScopeHash = record.courseScopeHash;
  const manifestHash = record.manifestHash;
  if (
    !requestedAt ||
    !isSafeIdentifier(courseAlias) ||
    !isSha256(courseScopeHash) ||
    !isSha256(manifestHash) ||
    !isSafeIdentifier(target.targetRef) ||
    !isSafeIdentifier(target.opportunityId) ||
    !isSafeIdentifier(target.candidateKey) ||
    !isSafeIdentifier(target.decisionId) ||
    !isSafeIdentifier(target.threadKey) ||
    !isSha256(target.targetVersionHash) ||
    !isSha256(target.eventSetHash) ||
    !isSha256(target.opportunityReceiptHash) ||
    !isSha256(target.revalidationReceiptHash) ||
    !isSha256(target.afterObservationReceiptHash)
  ) {
    return null;
  }
  const refs = parseEvidenceRefs(target.evidenceRefs, {
    minimum: 1,
    latestAt: Date.parse(requestedAt) + WORKBENCH_STAGE_TARGET_MAX_FUTURE_SKEW_MS
  });
  if (
    !refs ||
    !refs.some(
      (ref) =>
        ref.kind === "manifest" &&
        ref.id === courseAlias &&
        ref.hash === manifestHash
    ) ||
    !refs.some(
      (ref) => ref.kind === "decision" && ref.id === target.decisionId
    )
  ) {
    return null;
  }
  const targetSnapshot: CourseAgentStageTargetMaterial = Object.freeze({
    targetRef: target.targetRef,
    opportunityId: target.opportunityId,
    candidateKey: target.candidateKey,
    decisionId: target.decisionId,
    threadKey: target.threadKey,
    targetVersionHash: target.targetVersionHash,
    eventSetHash: target.eventSetHash,
    opportunityReceiptHash: target.opportunityReceiptHash,
    revalidationReceiptHash: target.revalidationReceiptHash,
    afterObservationReceiptHash: target.afterObservationReceiptHash,
    evidenceRefs: refs
  } as CourseAgentStageTargetMaterial);
  return Object.freeze({
    target: targetSnapshot,
    courseAlias,
    courseScopeHash,
    manifestHash,
    requestedAt
  });
}

function buildReadRequest(
  input: ParsedResolveInput
): WorkbenchStageTargetTransientReadRequestV2 {
  return Object.freeze({
    schemaVersion:
      WORKBENCH_STAGE_TARGET_TRANSIENT_READ_REQUEST_SCHEMA_VERSION,
    courseAlias: input.courseAlias,
    courseScopeHash: input.courseScopeHash,
    manifestHash: input.manifestHash,
    targetRef: input.target.targetRef,
    opportunityId: input.target.opportunityId,
    candidateKey: input.target.candidateKey,
    decisionId: input.target.decisionId,
    threadKey: input.target.threadKey,
    expectedTargetVersionHash: input.target.targetVersionHash,
    expectedEventSetHash: input.target.eventSetHash,
    opportunityReceiptHash: input.target.opportunityReceiptHash,
    sourceRevalidationReceiptHash: input.target.revalidationReceiptHash,
    sourceAfterObservationReceiptHash:
      input.target.afterObservationReceiptHash,
    requestedAt: input.requestedAt,
    readOnly: true,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  });
}

function projectionContainsRawValue(
  value: unknown,
  rawValues: readonly string[]
): boolean {
  const strings: string[] = [];
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      strings.push(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!isPlainRecord(candidate)) return;
    Object.values(candidate).forEach(visit);
  };
  visit(value);
  return rawValues.some((raw) =>
    strings.some((candidate) =>
      raw.length >= 8 ? candidate.includes(raw) : candidate === raw
    )
  );
}

function parseTransientRead(input: {
  value: unknown;
  expected: ParsedResolveInput;
  trustedNow: number;
}): ParsedTransientRead | null {
  if (!hasExactKeys(input.value, TRANSIENT_READ_KEYS)) return null;
  const value = input.value as Record<string, unknown>;
  const target = input.expected.target;
  if (
    value.schemaVersion !== WORKBENCH_STAGE_TARGET_TRANSIENT_READ_SCHEMA_VERSION ||
    value.courseAlias !== input.expected.courseAlias ||
    value.courseScopeHash !== input.expected.courseScopeHash ||
    value.manifestHash !== input.expected.manifestHash ||
    value.targetRef !== target.targetRef ||
    value.opportunityId !== target.opportunityId ||
    value.candidateKey !== target.candidateKey ||
    value.decisionId !== target.decisionId ||
    value.threadKey !== target.threadKey ||
    value.opportunityReceiptHash !== target.opportunityReceiptHash ||
    value.sourceRevalidationReceiptHash !== target.revalidationReceiptHash ||
    value.sourceAfterObservationReceiptHash !==
      target.afterObservationReceiptHash ||
    !isSha256(value.targetVersionHash) ||
    !isSha256(value.eventSetHash) ||
    value.readOnly !== true ||
    value.externalWriteAttempted !== false ||
    value.containsForumText !== false ||
    value.containsIdentity !== false ||
    value.containsSecrets !== false
  ) {
    return null;
  }
  const observedAt = canonicalInstant(value.observedAt);
  if (!observedAt) return null;
  const observedMilliseconds = Date.parse(observedAt);
  if (
    observedMilliseconds >
      input.trustedNow + WORKBENCH_STAGE_TARGET_MAX_FUTURE_SKEW_MS ||
    input.trustedNow - observedMilliseconds > WORKBENCH_STAGE_TARGET_MAX_AGE_MS
  ) {
    return null;
  }
  const canonicalTarget = canonicalHttpsTarget({
    targetUrl: value.targetUrl,
    allowedOrigin: value.allowedOrigin
  });
  if (
    !canonicalTarget ||
    typeof value.targetLocator !== "string" ||
    value.targetLocator.length > MAX_RAW_LOCATOR_LENGTH ||
    !RAW_LOCATOR_PATTERN.test(value.targetLocator)
  ) {
    return null;
  }
  const evidenceRefs = parseEvidenceRefs(value.evidenceRefs, {
    minimum: 1,
    latestAt: observedMilliseconds
  });
  if (
    !evidenceRefs ||
    projectionContainsRawValue(evidenceRefs, [
      canonicalTarget.targetUrl,
      canonicalTarget.allowedOrigin,
      value.targetLocator
    ])
  ) {
    return null;
  }
  return Object.freeze({
    targetUrl: canonicalTarget.targetUrl,
    allowedOrigin: canonicalTarget.allowedOrigin,
    targetLocator: value.targetLocator,
    targetVersionHash: value.targetVersionHash,
    eventSetHash: value.eventSetHash,
    observedAt,
    evidenceRefs
  });
}

function buildFreshObservation(input: {
  read: ParsedTransientRead;
  courseAlias: string;
  threadKey: string;
}): BoundPreExecutionTargetObservation | null {
  const receipt: PreExecutionTargetObservation = Object.freeze({
    schemaVersion: PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
    courseAlias: input.courseAlias,
    threadKey: input.threadKey,
    targetVersionHash: input.read.targetVersionHash,
    eventSetHash: input.read.eventSetHash,
    observedAt: input.read.observedAt,
    containsForumText: false
  });
  const observation: BoundPreExecutionTargetObservation = Object.freeze({
    receipt,
    receiptHash: hashPreExecutionTargetObservation(receipt)
  });
  if (
    !hasExactKeys(observation, BOUND_OBSERVATION_KEYS) ||
    !hasExactKeys(observation.receipt, PRE_EXECUTION_OBSERVATION_KEYS) ||
    observation.receipt.schemaVersion !==
      PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION ||
    observation.receipt.courseAlias !== input.courseAlias ||
    observation.receipt.threadKey !== input.threadKey ||
    observation.receipt.containsForumText !== false ||
    !isSha256(observation.receipt.targetVersionHash) ||
    !isSha256(observation.receipt.eventSetHash) ||
    canonicalInstant(observation.receipt.observedAt) === null ||
    !isSha256(observation.receiptHash) ||
    hashPreExecutionTargetObservation(observation.receipt) !==
      observation.receiptHash
  ) {
    return null;
  }
  return observation;
}

function dedupeEvidenceRefs(
  refs: readonly EvidenceRef[]
): readonly EvidenceRef[] {
  const deduped = new Map<string, EvidenceRef>();
  for (const ref of refs) {
    deduped.set(
      `${ref.kind}\0${ref.id}\0${ref.hash}\0${ref.observedAt}`,
      Object.freeze({ ...ref })
    );
  }
  return Object.freeze([...deduped.values()]);
}

function strictlyVerifyBuiltReceipt(
  built: ReturnType<typeof buildResolvedWorkbenchStageTargetReceiptV2>,
  observation: BoundPreExecutionTargetObservation,
  expected: Readonly<{
    input: ParsedResolveInput;
    targetLocatorHash: string;
  }>
): boolean {
  const receipt: WorkbenchResolvedStageTargetReceiptV2 = built.receipt;
  return (
    hasExactKeys(built, BUILT_RECEIPT_KEYS) &&
    hasExactKeys(receipt, RESOLVED_RECEIPT_KEYS) &&
    receipt.schemaVersion ===
      WORKBENCH_RESOLVED_STAGE_TARGET_RECEIPT_SCHEMA_VERSION &&
    receipt.freshObservationHash === observation.receiptHash &&
    receipt.freshObservationRef ===
      `fresh-observation:${observation.receiptHash}` &&
    receipt.resolvedAt === observation.receipt.observedAt &&
    receipt.courseAlias === expected.input.courseAlias &&
    receipt.courseScopeHash === expected.input.courseScopeHash &&
    receipt.manifestHash === expected.input.manifestHash &&
    receipt.courseLocatorHash === expected.input.manifestHash &&
    receipt.targetLocatorHash === expected.targetLocatorHash &&
    receipt.targetRef === expected.input.target.targetRef &&
    receipt.opportunityId === expected.input.target.opportunityId &&
    receipt.candidateKey === expected.input.target.candidateKey &&
    receipt.decisionId === expected.input.target.decisionId &&
    receipt.threadKey === expected.input.target.threadKey &&
    receipt.sourceRevalidationReceiptHash ===
      expected.input.target.revalidationReceiptHash &&
    receipt.sourceAfterObservationReceiptHash ===
      expected.input.target.afterObservationReceiptHash &&
    receipt.targetVersionHash === observation.receipt.targetVersionHash &&
    receipt.eventSetHash === observation.receipt.eventSetHash &&
    receipt.readOnly === true &&
    receipt.externalWriteAttempted === false &&
    receipt.containsForumText === false &&
    receipt.containsIdentity === false &&
    receipt.containsSecrets === false &&
    isSha256(receipt.stageTargetBindingHash) &&
    isSha256(built.receiptHash) &&
    built.receiptRef === `resolved-target:${built.receiptHash}` &&
    hashCourseToolValue(receipt.schemaVersion, receipt) === built.receiptHash
  );
}

function trustedClockMilliseconds(clock: () => Date): number | null {
  try {
    const value = clock();
    if (!(value instanceof Date)) return null;
    const milliseconds = value.getTime();
    return Number.isFinite(milliseconds) ? milliseconds : null;
  } catch {
    return null;
  }
}

/**
 * Production-safe composition is inert: construction captures an explicit
 * reader and a copied server key but performs no reads. Every untrusted read
 * failure converges to `null` without carrying its error or raw locators out.
 */
export function createWorkbenchStageTargetResolverV2(
  configuration: WorkbenchStageTargetResolverV2Configuration
): WorkbenchStageTargetResolver {
  assertServerOnlyRuntime();
  let readerRead: WorkbenchStageTargetTransientReaderV2["read"];
  let serverKey: Buffer;
  let clock: () => Date;
  try {
    if (
      !isPlainRecord(configuration) ||
      !Object.keys(configuration).every((key) =>
        ["reader", "serverKey", "now"].includes(key)
      ) ||
      !configuration.reader ||
      typeof configuration.reader !== "object" ||
      typeof configuration.reader.read !== "function" ||
      (configuration.now !== undefined &&
        typeof configuration.now !== "function")
    ) {
      throw resolverError(
        "WORKBENCH_STAGE_TARGET_RESOLVER_CONFIGURATION_INVALID"
      );
    }
    readerRead = configuration.reader.read.bind(configuration.reader);
    serverKey = normalizeServerKey(configuration.serverKey);
    clock = configuration.now ?? (() => new Date());
  } catch {
    throw resolverError(
      "WORKBENCH_STAGE_TARGET_RESOLVER_CONFIGURATION_INVALID"
    );
  }

  const resolver: WorkbenchStageTargetResolver = Object.freeze({
    resolve: async (
      untrustedInput: Parameters<WorkbenchStageTargetResolver["resolve"]>[0]
    ) => {
      assertServerOnlyRuntime();
      try {
        const input = parseResolveInput(untrustedInput);
        if (!input) return null;
        const beforeRead = trustedClockMilliseconds(clock);
        const requestedAt = Date.parse(input.requestedAt);
        if (
          beforeRead === null ||
          requestedAt >
            beforeRead + WORKBENCH_STAGE_TARGET_MAX_FUTURE_SKEW_MS ||
          beforeRead - requestedAt > WORKBENCH_STAGE_TARGET_MAX_AGE_MS
        ) {
          return null;
        }

        const untrustedRead = await readerRead(buildReadRequest(input));
        const afterRead = trustedClockMilliseconds(clock);
        if (afterRead === null || afterRead < beforeRead) return null;
        const read = parseTransientRead({
          value: untrustedRead,
          expected: input,
          trustedNow: afterRead
        });
        if (!read) return null;

        const targetLocatorHash = hashWorkbenchStageTargetLocatorV2({
          serverKey,
          courseAlias: input.courseAlias,
          courseScopeHash: input.courseScopeHash,
          manifestHash: input.manifestHash,
          targetRef: input.target.targetRef,
          threadKey: input.target.threadKey,
          targetUrl: read.targetUrl,
          allowedOrigin: read.allowedOrigin,
          targetLocator: read.targetLocator
        });
        const freshObservation = buildFreshObservation({
          read,
          courseAlias: input.courseAlias,
          threadKey: input.target.threadKey
        });
        if (!freshObservation) return null;

        const built = buildResolvedWorkbenchStageTargetReceiptV2({
          target: input.target,
          courseAlias: input.courseAlias,
          courseScopeHash: input.courseScopeHash,
          manifestHash: input.manifestHash,
          courseLocatorHash: input.manifestHash,
          targetLocatorHash,
          freshObservation
        });
        if (
          !strictlyVerifyBuiltReceipt(built, freshObservation, {
            input,
            targetLocatorHash
          })
        ) {
          return null;
        }

        const evidenceRefs = dedupeEvidenceRefs([
          ...input.target.evidenceRefs,
          ...read.evidenceRefs
        ]);
        assertEvidenceRefs(evidenceRefs);
        if (
          evidenceRefs.length > MAX_EVIDENCE_REFS ||
          evidenceRefs.some(
            (ref) =>
              Date.parse(ref.observedAt) >
              Date.parse(read.observedAt) +
                WORKBENCH_STAGE_TARGET_MAX_FUTURE_SKEW_MS
          ) ||
          projectionContainsRawValue(
            {
              receipt: built.receipt,
              receiptRef: built.receiptRef,
              receiptHash: built.receiptHash,
              evidenceRefs
            },
            [read.targetUrl, read.allowedOrigin, read.targetLocator]
          )
        ) {
          return null;
        }

        const resolved: ResolvedWorkbenchStageTarget = Object.freeze({
          schemaVersion: WORKBENCH_STAGE_TARGET_RESOLUTION_SCHEMA_VERSION,
          targetUrl: read.targetUrl,
          allowedOrigin: read.allowedOrigin,
          courseLocatorHash: input.manifestHash,
          targetLocatorHash,
          targetVersionHash: read.targetVersionHash,
          eventSetHash: read.eventSetHash,
          sourceRevalidationReceiptHash:
            input.target.revalidationReceiptHash,
          sourceAfterObservationReceiptHash:
            input.target.afterObservationReceiptHash,
          freshObservation,
          freshObservationRef: built.receipt.freshObservationRef,
          freshObservationHash: built.receipt.freshObservationHash,
          resolvedAt: built.receipt.resolvedAt,
          resolvedTargetReceipt: built.receipt,
          resolvedTargetReceiptRef: built.receiptRef,
          resolvedTargetReceiptHash: built.receiptHash,
          evidenceRefs,
          readOnly: true,
          externalWriteAttempted: false,
          containsForumText: false,
          containsIdentity: false,
          containsSecrets: false
        });
        return resolved;
      } catch {
        return null;
      }
    }
  });
  return resolver;
}
