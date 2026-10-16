import { createHash } from "node:crypto";

/**
 * Roles that can approve or review a CommunityInquiryMemory revision.  The
 * role is selected by the server-side verifier; it is not accepted from a
 * browser request as an assertion of identity.
 */
export const COMMUNITY_MEMORY_REVIEW_ROLES = [
  "course_owner",
  "teacher"
] as const;

export type CommunityMemoryReviewRole =
  (typeof COMMUNITY_MEMORY_REVIEW_ROLES)[number];

export const COMMUNITY_MEMORY_APPROVAL_PRINCIPAL_SCHEMA_VERSION =
  "cmooc.community-inquiry-memory-approval-principal.v1" as const;

const COURSE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const PRINCIPAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * This brand is intentionally module-private.  A JSON/browser payload can
 * carry the public fields below, but it cannot manufacture a value accepted by
 * the registry without going through the server-side gate in this module.
 */
const APPROVAL_PRINCIPAL_BRAND: unique symbol = Symbol(
  "community-memory-approval-principal"
);

export type CommunityMemoryApprovalPrincipal = Readonly<{
  readonly [APPROVAL_PRINCIPAL_BRAND]: true;
  readonly schemaVersion:
    typeof COMMUNITY_MEMORY_APPROVAL_PRINCIPAL_SCHEMA_VERSION;
  readonly courseAlias: string;
  readonly reviewerRole: CommunityMemoryReviewRole;
  readonly reviewerRefHash: string;
  readonly issuedAt: string;
}>;

/**
 * Result returned by the server-owned auth adapter.  It must be resolved from
 * a session/credential provider or an equivalent trusted server boundary; it
 * must never be copied from request JSON.  Only the opaque principalRef is
 * retained by the gate, and the registry stores its hash rather than the ref.
 */
export type CommunityMemoryAuthenticatedPrincipal = Readonly<{
  readonly courseAlias: string;
  readonly role: CommunityMemoryReviewRole;
  readonly principalRef: string;
}>;

export type CommunityMemoryApprovalPrincipalRequest = Readonly<{
  readonly courseAlias: string;
  readonly role: CommunityMemoryReviewRole;
}>;

export type CommunityMemoryApprovalPrincipalResolver = (
  request: CommunityMemoryApprovalPrincipalRequest
) =>
  | CommunityMemoryAuthenticatedPrincipal
  | null
  | Promise<CommunityMemoryAuthenticatedPrincipal | null>;

export type CommunityMemoryApprovalGate = Readonly<{
  authorize(
    request: CommunityMemoryApprovalPrincipalRequest
  ): Promise<CommunityMemoryApprovalPrincipal>;
}>;

export class CommunityMemoryApprovalPrincipalError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "CommunityMemoryApprovalPrincipalError";
    this.code = code;
  }
}

function fail(code: string, message = code): never {
  throw new CommunityMemoryApprovalPrincipalError(code, message);
}

function assertServerRuntime(): void {
  // The module has no browser implementation.  This guard makes accidental
  // client invocation fail closed even when a bundler happens to include it.
  if (typeof globalThis !== "undefined" && "window" in globalThis) {
    fail(
      "COMMUNITY_MEMORY_APPROVAL_SERVER_ONLY",
      "记忆审批主体门控只能在服务端运行。"
    );
  }
}

function assertCourseAlias(value: unknown): string {
  if (typeof value !== "string" || !COURSE_ALIAS_PATTERN.test(value)) {
    fail("COMMUNITY_MEMORY_APPROVAL_COURSE_INVALID");
  }
  return value;
}

function assertRole(value: unknown): CommunityMemoryReviewRole {
  if (
    typeof value !== "string" ||
    !COMMUNITY_MEMORY_REVIEW_ROLES.includes(value as CommunityMemoryReviewRole)
  ) {
    fail("COMMUNITY_MEMORY_APPROVAL_ROLE_INVALID");
  }
  return value as CommunityMemoryReviewRole;
}

function assertPrincipalRef(value: unknown): string {
  if (typeof value !== "string" || !PRINCIPAL_REF_PATTERN.test(value)) {
    fail("COMMUNITY_MEMORY_APPROVAL_PRINCIPAL_REF_INVALID");
  }
  return value;
}

function normalizeIssuedAt(value: Date | string): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    fail("COMMUNITY_MEMORY_APPROVAL_TIME_INVALID");
  }
  return date.toISOString();
}

function reviewerRefHash(input: {
  courseAlias: string;
  role: CommunityMemoryReviewRole;
  principalRef: string;
}): string {
  return createHash("sha256")
    .update(
      `${COMMUNITY_MEMORY_APPROVAL_PRINCIPAL_SCHEMA_VERSION}\0${input.courseAlias}\0${input.role}\0${input.principalRef}`,
      "utf8"
    )
    .digest("hex");
}

function parseRequest(
  request: CommunityMemoryApprovalPrincipalRequest
): CommunityMemoryApprovalPrincipalRequest {
  const courseAlias = assertCourseAlias(request?.courseAlias);
  const role = assertRole(request?.role);
  return Object.freeze({ courseAlias, role });
}

/**
 * Build the only approval capability accepted by the memory registry.
 * `resolveAuthenticatedPrincipal` is deliberately injected at the server
 * composition boundary: this module does not pretend that a control request
 * or a reviewerRefHash is authentication.  A missing or rejected resolver
 * result leaves approval unavailable.
 */
export function createCommunityMemoryApprovalGate(input: {
  readonly resolveAuthenticatedPrincipal:
    CommunityMemoryApprovalPrincipalResolver;
  readonly now?: () => Date;
}): CommunityMemoryApprovalGate {
  assertServerRuntime();
  if (typeof input.resolveAuthenticatedPrincipal !== "function") {
    fail("COMMUNITY_MEMORY_APPROVAL_RESOLVER_INVALID");
  }
  const now = input.now ?? (() => new Date());
  return Object.freeze({
    async authorize(
      rawRequest: CommunityMemoryApprovalPrincipalRequest
    ): Promise<CommunityMemoryApprovalPrincipal> {
      assertServerRuntime();
      const request = parseRequest(rawRequest);
      let principal: CommunityMemoryAuthenticatedPrincipal | null;
      try {
        principal = await input.resolveAuthenticatedPrincipal(request);
      } catch {
        fail("COMMUNITY_MEMORY_APPROVAL_PRINCIPAL_UNAVAILABLE");
      }
      if (!principal) {
        fail("COMMUNITY_MEMORY_APPROVAL_PRINCIPAL_UNAVAILABLE");
      }
      const principalCourseAlias = assertCourseAlias(principal.courseAlias);
      const principalRole = assertRole(principal.role);
      const principalRef = assertPrincipalRef(principal.principalRef);
      if (
        principalCourseAlias !== request.courseAlias ||
        principalRole !== request.role
      ) {
        fail("COMMUNITY_MEMORY_APPROVAL_PRINCIPAL_SCOPE_MISMATCH");
      }
      const issuedAt = normalizeIssuedAt(now());
      return Object.freeze({
        [APPROVAL_PRINCIPAL_BRAND]: true as const,
        schemaVersion: COMMUNITY_MEMORY_APPROVAL_PRINCIPAL_SCHEMA_VERSION,
        courseAlias: request.courseAlias,
        reviewerRole: request.role,
        reviewerRefHash: reviewerRefHash({
          courseAlias: request.courseAlias,
          role: request.role,
          principalRef
        }),
        issuedAt
      });
    }
  });
}

/**
 * Validate a server-issued capability at the registry boundary and bind it to
 * the exact course revision being reviewed.  The returned hash is derived by
 * the server gate; no client-supplied reviewerRefHash is consulted.
 */
export function assertCommunityMemoryApprovalPrincipal(
  value: unknown,
  expected: Readonly<{
    courseAlias: string;
    role?: CommunityMemoryReviewRole;
  }>
): CommunityMemoryApprovalPrincipal {
  assertServerRuntime();
  const candidate =
    typeof value === "object" && value !== null
      ? value as Partial<CommunityMemoryApprovalPrincipal> &
          Record<PropertyKey, unknown>
      : null;
  if (!candidate || candidate[APPROVAL_PRINCIPAL_BRAND] !== true) {
    fail("COMMUNITY_MEMORY_APPROVAL_PRINCIPAL_REQUIRED");
  }
  const courseAlias = assertCourseAlias(candidate.courseAlias);
  const reviewerRole = assertRole(candidate.reviewerRole);
  const reviewerRefHash = candidate.reviewerRefHash;
  if (typeof reviewerRefHash !== "string" || !HASH_PATTERN.test(reviewerRefHash)) {
    fail("COMMUNITY_MEMORY_APPROVAL_PRINCIPAL_INVALID");
  }
  if (candidate.schemaVersion !== COMMUNITY_MEMORY_APPROVAL_PRINCIPAL_SCHEMA_VERSION) {
    fail("COMMUNITY_MEMORY_APPROVAL_PRINCIPAL_INVALID");
  }
  const issuedAt = normalizeIssuedAt(candidate.issuedAt as string);
  if (
    courseAlias !== assertCourseAlias(expected.courseAlias) ||
    (expected.role !== undefined && reviewerRole !== assertRole(expected.role))
  ) {
    fail("COMMUNITY_MEMORY_APPROVAL_PRINCIPAL_SCOPE_MISMATCH");
  }
  return candidate as CommunityMemoryApprovalPrincipal;
}

