import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { CommunityInquiryMemoryAnchor } from "@/lib/community-memory/inquiry-memory";

/**
 * A browser run is not an autonomy invocation.  This capability is the
 * explicit, server-created bridge between the two stores.  It is deliberately
 * issued only after the server has re-read the decision, world, graph and
 * candidate-set records on one exact as-of boundary.
 */
export const BROWSER_AUTONOMY_BINDING_SCHEMA_VERSION =
  "cmooc.browser-autonomy-binding.v1" as const;

const BINDING_CAPABILITY_BRAND: unique symbol = Symbol(
  "cmooc-browser-autonomy-binding"
);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const COURSE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export type BrowserAutonomyBindingV1 = Readonly<{
  readonly schemaVersion: typeof BROWSER_AUTONOMY_BINDING_SCHEMA_VERSION;
  readonly browserCourseId: string;
  readonly browserRunId: string;
  readonly browserTapeRef: string;
  readonly browserTapeHeadHash: string;
  readonly browserRunRevision: number;
  readonly browserObservationHash: string;
  readonly promotionId: string;
  readonly courseAlias: string;
  readonly invocationId: string;
  readonly decisionKey: string;
  readonly candidateKey: string;
  readonly anchor: CommunityInquiryMemoryAnchor;
  readonly containsForumText: false;
  readonly bindingHash: string;
}>;

/**
 * The brand is module-private.  A request body can copy the public binding
 * fields, but cannot manufacture the capability accepted by promotion.
 */
export type BrowserAutonomyBindingCapability = Readonly<{
  readonly [BINDING_CAPABILITY_BRAND]: true;
  readonly binding: BrowserAutonomyBindingV1;
}>;

export type BrowserAutonomyBindingSource = Readonly<{
  readonly browser: {
    readonly courseId: string;
    readonly runId: string;
    readonly tapeRef: string;
    readonly tapeHeadHash: string;
    readonly runRevision: number;
    readonly observationHash: string;
  };
  readonly invocation: {
    readonly id: string;
    readonly courseAlias: string;
  };
  readonly decision: {
    readonly decisionKey: string;
    readonly invocationId: string;
    readonly courseAlias: string;
    readonly worldHash: string;
    readonly candidateSetHash: string;
    readonly evidenceAsOf: Date | string;
    readonly decisionJson: string;
  };
  readonly world: {
    readonly id: string;
    readonly invocationId: string;
    readonly courseAlias: string;
    readonly asOfAt: Date | string;
    readonly worldHash: string;
    readonly graphHash: string;
  };
  readonly graph: {
    readonly id: string;
    readonly worldSnapshotId: string;
    readonly courseAlias: string;
    readonly asOfAt: Date | string;
    readonly contentGraphHash: string;
  };
  readonly candidateSet: {
    readonly id: string;
    readonly invocationId: string;
    readonly snapshotId: string;
    readonly asOfAt: Date | string;
    readonly candidateSetHash: string;
    readonly candidatesJson: string;
  };
}>;

export type BrowserAutonomyBindingDb = PrismaClient | Prisma.TransactionClient;

export class BrowserAutonomyBindingError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "BrowserAutonomyBindingError";
    this.code = code;
  }
}

function fail(code: string, message = code): never {
  throw new BrowserAutonomyBindingError(code, message);
}

function assertServerRuntime(): void {
  if (typeof globalThis !== "undefined" && "window" in globalThis) {
    fail("BROWSER_AUTONOMY_BINDING_SERVER_ONLY", "浏览器运行时不能签发自治绑定。");
  }
}

function ref(value: unknown, label: string): string {
  if (typeof value !== "string" || !REF_PATTERN.test(value)) {
    fail("BROWSER_AUTONOMY_BINDING_REF_INVALID", `${label}无效。`);
  }
  return value;
}

function courseAlias(value: unknown): string {
  if (typeof value !== "string" || !COURSE_ALIAS_PATTERN.test(value)) {
    fail("BROWSER_AUTONOMY_BINDING_COURSE_INVALID");
  }
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    fail("BROWSER_AUTONOMY_BINDING_HASH_INVALID", `${label}必须是小写 SHA-256。`);
  }
  return value;
}

function iso(value: unknown, label: string): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    fail("BROWSER_AUTONOMY_BINDING_TIME_INVALID", `${label}无效。`);
  }
  return date.toISOString();
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function sameTime(left: string, right: string): boolean {
  return left === right;
}

function parseDecisionCandidate(decisionJson: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = record(JSON.parse(decisionJson), "BROWSER_AUTONOMY_BINDING_DECISION_INVALID");
  } catch (error) {
    if (error instanceof BrowserAutonomyBindingError) throw error;
    fail("BROWSER_AUTONOMY_BINDING_DECISION_INVALID");
  }
  if (parsed.containsForumText !== false || typeof parsed.candidateKey !== "string") {
    fail("BROWSER_AUTONOMY_BINDING_DECISION_INVALID");
  }
  return hash(parsed.candidateKey, "decision.candidateKey");
}

function parseCandidateSet(
  candidatesJson: string,
  expected: {
    courseAlias: string;
    worldHash: string;
    asOfAt: string;
    candidateSetHash: string;
    candidateKey: string;
  }
): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = record(JSON.parse(candidatesJson), "BROWSER_AUTONOMY_BINDING_CANDIDATE_SET_INVALID");
  } catch (error) {
    if (error instanceof BrowserAutonomyBindingError) throw error;
    fail("BROWSER_AUTONOMY_BINDING_CANDIDATE_SET_INVALID");
  }
  if (
    parsed.containsForumText !== false ||
    typeof parsed.schemaVersion !== "string" ||
    parsed.courseAlias !== expected.courseAlias ||
    parsed.worldHash !== expected.worldHash ||
    parsed.asOfAt !== expected.asOfAt ||
    !Array.isArray(parsed.candidates) ||
    canonicalProtocolHash(
      parsed.schemaVersion,
      parsed as unknown as CanonicalJsonValue
    ) !== expected.candidateSetHash
  ) {
    fail("BROWSER_AUTONOMY_BINDING_CANDIDATE_SET_INVALID");
  }
  const found = parsed.candidates.some((candidate) => {
    const item = record(candidate, "BROWSER_AUTONOMY_BINDING_CANDIDATE_INVALID");
    return item.candidateKey === expected.candidateKey;
  });
  if (!found) fail("BROWSER_AUTONOMY_BINDING_CANDIDATE_MISSING");
}

function bindingHash(value: Omit<BrowserAutonomyBindingV1, "bindingHash">): string {
  return canonicalProtocolHash(
    BROWSER_AUTONOMY_BINDING_SCHEMA_VERSION,
    value as unknown as CanonicalJsonValue
  );
}

function parseBinding(value: unknown): BrowserAutonomyBindingV1 {
  const input = record(value, "BROWSER_AUTONOMY_BINDING_INVALID");
  if (
    input.schemaVersion !== BROWSER_AUTONOMY_BINDING_SCHEMA_VERSION ||
    input.containsForumText !== false ||
    !input.anchor ||
    typeof input.anchor !== "object" ||
    Array.isArray(input.anchor)
  ) {
    fail("BROWSER_AUTONOMY_BINDING_INVALID");
  }
  const anchorValue = input.anchor as Record<string, unknown>;
  const normalizedAnchor: CommunityInquiryMemoryAnchor = {
    courseAlias: courseAlias(anchorValue.courseAlias),
    invocationId: ref(anchorValue.invocationId, "anchor.invocationId"),
    worldSnapshotId: ref(anchorValue.worldSnapshotId, "anchor.worldSnapshotId"),
    graphSnapshotId: ref(anchorValue.graphSnapshotId, "anchor.graphSnapshotId"),
    candidateSetId: ref(anchorValue.candidateSetId, "anchor.candidateSetId"),
    asOfAt: iso(anchorValue.asOfAt, "anchor.asOfAt"),
    worldHash: hash(anchorValue.worldHash, "anchor.worldHash"),
    graphHash: hash(anchorValue.graphHash, "anchor.graphHash"),
    candidateSetHash: hash(anchorValue.candidateSetHash, "anchor.candidateSetHash")
  };
  const body = {
    schemaVersion: BROWSER_AUTONOMY_BINDING_SCHEMA_VERSION,
    browserCourseId: ref(input.browserCourseId, "browserCourseId"),
    browserRunId: ref(input.browserRunId, "browserRunId"),
    browserTapeRef: ref(input.browserTapeRef, "browserTapeRef"),
    browserTapeHeadHash: hash(input.browserTapeHeadHash, "browserTapeHeadHash"),
    browserRunRevision: (() => {
      if (typeof input.browserRunRevision !== "number" || !Number.isInteger(input.browserRunRevision) || input.browserRunRevision < 0) {
        fail("BROWSER_AUTONOMY_BINDING_REVISION_INVALID");
      }
      return input.browserRunRevision;
    })(),
    browserObservationHash: hash(input.browserObservationHash, "browserObservationHash"),
    promotionId: ref(input.promotionId, "promotionId"),
    courseAlias: courseAlias(input.courseAlias),
    invocationId: ref(input.invocationId, "invocationId"),
    decisionKey: hash(input.decisionKey, "decisionKey"),
    candidateKey: hash(input.candidateKey, "candidateKey"),
    anchor: normalizedAnchor,
    containsForumText: false as const
  } satisfies Omit<BrowserAutonomyBindingV1, "bindingHash">;
  if (
    body.courseAlias !== normalizedAnchor.courseAlias ||
    body.invocationId !== normalizedAnchor.invocationId
  ) {
    fail("BROWSER_AUTONOMY_BINDING_SCOPE_MISMATCH");
  }
  const suppliedHash = hash(input.bindingHash, "bindingHash");
  if (bindingHash(body) !== suppliedHash) fail("BROWSER_AUTONOMY_BINDING_HASH_MISMATCH");
  return Object.freeze({ ...body, bindingHash: suppliedHash });
}

/** Validate a serialized binding, without treating it as an issuance capability. */
export function parseBrowserAutonomyBinding(value: unknown): BrowserAutonomyBindingV1 {
  return parseBinding(value);
}

/**
 * Issue a capability only from server-loaded, exact records.  The caller is
 * responsible for loading these rows with a trusted Prisma/server adapter;
 * this function performs the cross-record proof and never accepts a browser
 * request as an authority source.
 */
export function issueBrowserAutonomyBinding(input: {
  readonly browserCourseId: string;
  readonly browserRunId: string;
  readonly promotionId: string;
  readonly candidateKey: string;
  readonly source: BrowserAutonomyBindingSource;
}): BrowserAutonomyBindingCapability {
  assertServerRuntime();
  const source = input.source;
  const browserCourseId = ref(input.browserCourseId, "browserCourseId");
  const browserRunId = ref(input.browserRunId, "browserRunId");
  const promotionId = ref(input.promotionId, "promotionId");
  const browserTapeRef = ref(source.browser.tapeRef, "browser.tapeRef");
  const browserTapeHeadHash = hash(source.browser.tapeHeadHash, "browser.tapeHeadHash");
  const browserObservationHash = hash(source.browser.observationHash, "browser.observationHash");
  if (
    source.browser.courseId !== browserCourseId ||
    source.browser.runId !== browserRunId ||
    !Number.isInteger(source.browser.runRevision) ||
    source.browser.runRevision < 0
  ) {
    fail("BROWSER_AUTONOMY_BINDING_BROWSER_SCOPE_MISMATCH");
  }
  const course = courseAlias(source.invocation.courseAlias);
  const invocationId = ref(source.invocation.id, "invocation.id");
  const decisionKey = hash(source.decision.decisionKey, "decision.decisionKey");
  const candidateKey = hash(input.candidateKey, "candidateKey");
  const asOfAt = iso(source.world.asOfAt, "world.asOfAt");
  const decisionAsOf = iso(source.decision.evidenceAsOf, "decision.evidenceAsOf");
  const graphAsOf = iso(source.graph.asOfAt, "graph.asOfAt");
  const candidateAsOf = iso(source.candidateSet.asOfAt, "candidateSet.asOfAt");
  const worldHash = hash(source.world.worldHash, "world.worldHash");
  const graphHash = hash(source.graph.contentGraphHash, "graph.contentGraphHash");
  const candidateSetHash = hash(source.candidateSet.candidateSetHash, "candidateSet.candidateSetHash");

  if (
    source.invocation.id !== invocationId ||
    source.decision.invocationId !== invocationId ||
    source.decision.courseAlias !== course ||
    source.world.id !== source.candidateSet.snapshotId ||
    source.world.invocationId !== invocationId ||
    source.world.courseAlias !== course ||
    source.graph.worldSnapshotId !== source.world.id ||
    source.graph.courseAlias !== course ||
    source.candidateSet.invocationId !== invocationId ||
    source.world.graphHash !== graphHash ||
    source.decision.worldHash !== worldHash ||
    source.decision.candidateSetHash !== candidateSetHash ||
    !sameTime(asOfAt, decisionAsOf) ||
    !sameTime(asOfAt, graphAsOf) ||
    !sameTime(asOfAt, candidateAsOf)
  ) {
    fail("BROWSER_AUTONOMY_BINDING_SCOPE_MISMATCH");
  }
  if (parseDecisionCandidate(source.decision.decisionJson) !== candidateKey) {
    fail("BROWSER_AUTONOMY_BINDING_DECISION_CANDIDATE_MISMATCH");
  }
  parseCandidateSet(source.candidateSet.candidatesJson, {
    courseAlias: course,
    worldHash,
    asOfAt,
    candidateSetHash,
    candidateKey
  });

  const anchor: CommunityInquiryMemoryAnchor = {
    courseAlias: course,
    invocationId,
    worldSnapshotId: ref(source.world.id, "world.id"),
    graphSnapshotId: ref(source.graph.id, "graph.id"),
    candidateSetId: ref(source.candidateSet.id, "candidateSet.id"),
    asOfAt,
    worldHash,
    graphHash,
    candidateSetHash
  };
  const body = {
    schemaVersion: BROWSER_AUTONOMY_BINDING_SCHEMA_VERSION,
    browserCourseId,
    browserRunId,
    browserTapeRef,
    browserTapeHeadHash,
    browserRunRevision: source.browser.runRevision,
    browserObservationHash,
    promotionId,
    courseAlias: course,
    invocationId,
    decisionKey,
    candidateKey,
    anchor,
    containsForumText: false as const
  } satisfies Omit<BrowserAutonomyBindingV1, "bindingHash">;
  const binding: BrowserAutonomyBindingV1 = Object.freeze({
    ...body,
    bindingHash: bindingHash(body)
  });
  return Object.freeze({
    [BINDING_CAPABILITY_BRAND]: true as const,
    binding
  });
}

/**
 * Server composition helper.  The caller supplies only the decision key,
 * graph id, candidate key and already-read browser lineage.  All autonomy
 * records are re-read from Prisma here; no client-provided anchor/hash is
 * trusted or copied into the binding.
 */
export async function issueBrowserAutonomyBindingFromPrisma(input: {
  readonly prisma: BrowserAutonomyBindingDb;
  readonly browserCourseId: string;
  readonly browserRunId: string;
  readonly browser: BrowserAutonomyBindingSource["browser"];
  readonly promotionId: string;
  readonly decisionKey: string;
  readonly graphSnapshotId: string;
  readonly candidateKey: string;
}): Promise<BrowserAutonomyBindingCapability> {
  assertServerRuntime();
  const decisionKey = hash(input.decisionKey, "decisionKey");
  const decision = await input.prisma.autonomyDecision.findUnique({
    where: { decisionKey },
    select: {
      decisionKey: true,
      invocationId: true,
      courseAlias: true,
      worldHash: true,
      candidateSetHash: true,
      evidenceAsOf: true,
      decisionJson: true
    }
  });
  if (!decision) fail("BROWSER_AUTONOMY_BINDING_DECISION_NOT_FOUND");
  const [invocation, world, graph, candidateSet] = await Promise.all([
    input.prisma.scheduledInvocation.findUnique({
      where: { id: decision.invocationId },
      select: { id: true, courseAlias: true }
    }),
    input.prisma.courseWorldSnapshot.findUnique({
      where: { invocationId: decision.invocationId },
      select: { id: true, invocationId: true, courseAlias: true, asOfAt: true, worldHash: true, graphHash: true }
    }),
    input.prisma.courseContentGraphSnapshot.findUnique({
      where: { id: input.graphSnapshotId },
      select: { id: true, worldSnapshotId: true, courseAlias: true, asOfAt: true, contentGraphHash: true }
    }),
    input.prisma.candidateSet.findUnique({
      where: { invocationId: decision.invocationId },
      select: { id: true, invocationId: true, snapshotId: true, asOfAt: true, candidateSetHash: true, candidatesJson: true }
    })
  ]);
  if (!invocation || !world || !graph || !candidateSet) {
    fail("BROWSER_AUTONOMY_BINDING_ANCHOR_NOT_FOUND");
  }
  return issueBrowserAutonomyBinding({
    browserCourseId: input.browserCourseId,
    browserRunId: input.browserRunId,
    candidateKey: input.candidateKey,
    promotionId: input.promotionId,
    source: {
      browser: input.browser,
      invocation,
      decision,
      world,
      graph,
      candidateSet
    }
  });
}

export function assertBrowserAutonomyBindingCapability(
  value: unknown
): BrowserAutonomyBindingV1 {
  assertServerRuntime();
  if (!value || typeof value !== "object") {
    fail("BROWSER_AUTONOMY_BINDING_CAPABILITY_REQUIRED");
  }
  const candidate = value as Partial<BrowserAutonomyBindingCapability> & Record<PropertyKey, unknown>;
  if (candidate[BINDING_CAPABILITY_BRAND] !== true || !candidate.binding) {
    fail("BROWSER_AUTONOMY_BINDING_CAPABILITY_REQUIRED");
  }
  return parseBinding(candidate.binding);
}
