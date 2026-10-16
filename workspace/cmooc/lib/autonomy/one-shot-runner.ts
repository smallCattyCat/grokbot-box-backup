import type {
  AutonomyCourseManifest,
  AutonomyDecision,
  PrismaClient,
  ScheduledInvocation
} from "@prisma/client";
import {
  canonicalProtocolHash,
  canonicalJson,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  REAL_FORUM_WRITE_LOCKED
} from "@/lib/forum/real-write-lock";
import {
  resolveCmoocApiWriteToken,
  loadCmoocExecutionAccountRuntime,
  type CmoocApiWriteToken
} from "@/lib/forum/cmooc-api";
import type { CmoocExecutionAccountDescriptor } from "@/lib/forum/cmooc-execution-account-config";
import {
  loadOrCreateLocalEvidenceSecret
} from "@/lib/privacy/local-evidence-hmac";
import { loadCourseManifest } from "./course-manifest";
import {
  issueExecutionPermit
} from "./execution-permit";
import {
  locateTransientExecutionTarget
} from "./execution-target";
import {
  executeCmoocProductionCommit,
  ProductionCommitError
} from "./production-committer";

/** Preserve a durable remote-outcome stop code across later cleanup errors. */
export function preserveOneShotOutcomeUnknownRootError(
  rootError: unknown
): ProductionCommitError | null {
  return rootError instanceof ProductionCommitError &&
    rootError.code === "PRODUCTION_COMMIT_OUTCOME_UNKNOWN"
    ? rootError
    : null;
}
import {
  loadActiveOneShotPolicy,
  relockOneShotPolicy,
  selectMechanicalDraft,
  type OneShotPublicationHandoff
} from "./one-shot-execution";
import { assertTrustedStagePublishGuards } from "./one-shot-publish-guard";
import {
  scheduleProximalOutcomes
} from "./outcome-observer";
import { appendDecisionTapeEntry } from "./decision-tape";
import {
  assertExecutionStageTapeBinding
} from "./execution-stage-receipt";
import {
  acquire as acquireExecutionAccountLease,
  loadActive as loadActiveExecutionAccountLease,
  release as releaseExecutionAccountLease,
  type ExecutionAccountLeaseSummary,
  type ExecutionAccountRoleKey
} from "./execution-account-pool";

const TERMINAL_REAL_ATTEMPT_STATUSES = [
  "aborted_before_send",
  "confirmed_not_published",
  "confirmed_published"
] as const;

const ONE_SHOT_TAPE_FORBIDDEN_KEYS = new Set([
  "attemptId",
  "author",
  "authorId",
  "authorKey",
  "body",
  "canonicalUrl",
  "content",
  "courseAlias",
  "courseId",
  "eventId",
  "idempotencyKey",
  "nativeId",
  "platform",
  "platformId",
  "permitKey",
  "postUrl",
  "targetUrl",
  "thread",
  "threadId",
  "threadKey",
  "token",
  "url"
]);

type OneShotTerminalExecutionStatus =
  | "confirmed_published"
  | "aborted_before_send"
  | "outcome_unknown"
  // Kept for compatibility with older settled attempts. New production
  // execution paths do not manufacture this state, but existing rows may
  // legitimately contain it and must remain replayable.
  | "confirmed_not_published";

const ONE_SHOT_TERMINAL_EXECUTION_STATUSES = new Set<
  OneShotTerminalExecutionStatus
>([
  "confirmed_published",
  "aborted_before_send",
  "outcome_unknown",
  "confirmed_not_published"
]);

const FACILITATION_ACCOUNT_ROLE_MAP: Record<
  string,
  readonly ExecutionAccountRoleKey[]
> = {
  cognitive_conflict: ["socratic_guide"],
  resource_connection: ["evidence_connector", "community_host"],
  emotional_support: ["reflection_coach", "community_host"]
};
const EXECUTION_ACCOUNT_HASH = /^[a-f0-9]{64}$/;

export function compatibleAccountRolesForFacilitationFunction(
  facilitationFunction: string
): readonly ExecutionAccountRoleKey[] {
  return FACILITATION_ACCOUNT_ROLE_MAP[facilitationFunction] ?? [];
}

export function filterExecutionAccountDescriptorsByFacilitationFunction(
  descriptors: readonly CmoocExecutionAccountDescriptor[],
  facilitationFunction: string
): CmoocExecutionAccountDescriptor[] {
  const compatible = new Set(
    compatibleAccountRolesForFacilitationFunction(facilitationFunction)
  );
  return descriptors
    .filter((descriptor) => compatible.has(descriptor.roleKey))
    .map((descriptor) => ({
      ...descriptor,
      courseAliases: [...descriptor.courseAliases]
    }));
}

export function assertOneShotAccountWriteToken(input: {
  writeToken?: CmoocApiWriteToken | null;
  accountRefHash: string;
  credentialRefHash: string;
}): CmoocApiWriteToken {
  if (
    !EXECUTION_ACCOUNT_HASH.test(input.accountRefHash) ||
    !EXECUTION_ACCOUNT_HASH.test(input.credentialRefHash) ||
    !input.writeToken ||
    input.writeToken.source !== "partner_account" ||
    input.writeToken.accountRefHash !== input.accountRefHash ||
    input.writeToken.credentialRefHash !== input.credentialRefHash
  ) {
    throw new Error("L3_EXECUTION_ACCOUNT_AUTH_BINDING_MISMATCH");
  }
  return input.writeToken;
}

function selectedFacilitationFunction(decisionJson: string): string {
  try {
    const parsed = JSON.parse(decisionJson) as {
      intent?: { facilitationFunction?: unknown };
    };
    const value = parsed.intent?.facilitationFunction;
    if (typeof value === "string" && value.length > 0) return value;
  } catch {
    // Stable fail-closed error below; never echo decision JSON/body.
  }
  throw new Error("L3_EXECUTION_ACCOUNT_ROLE_UNAVAILABLE");
}

function isP2002(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function stableAuditAppendFailure(
  cause: unknown,
  stage: string
): Error {
  const failure = new Error("L3_EXECUTION_AUDIT_APPEND_FAILED");
  // Preserve the underlying reason without putting it in a tape payload or
  // exposing potentially sensitive remote text in the public error code.
  Object.assign(failure, { cause, auditStage: stage });
  return failure;
}

async function appendAuditFact<T>(input: {
  stage: string;
  append: () => Promise<T>;
}): Promise<T> {
  try {
    return await input.append();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "L3_EXECUTION_AUDIT_APPEND_FAILED"
    ) {
      throw error;
    }
    throw stableAuditAppendFailure(error, input.stage);
  }
}

function assertOneShotTapePayload(
  value: unknown,
  path: string[] = []
): asserts value is CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertOneShotTapePayload(item, [...path, String(index)])
    );
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (
        ONE_SHOT_TAPE_FORBIDDEN_KEYS.has(key) ||
        /(?:^|_)(?:attempt|author|platform|thread)(?:_|$)/i.test(key)
      ) {
        throw new Error(
          `L3_DECISION_TAPE_PAYLOAD_UNSAFE:${[
            ...path,
            key
          ].join(".")}`
        );
      }
      assertOneShotTapePayload(item, [...path, key]);
    }
    return;
  }
  throw new Error("L3_DECISION_TAPE_PAYLOAD_UNSAFE");
}

export function hashOneShotOpaque(
  schemaVersion: string,
  value: CanonicalJsonValue
): string {
  return canonicalProtocolHash(schemaVersion, {
    schemaVersion,
    value,
    containsForumText: false
  });
}

function parseTapePayload(
  payloadJson: string
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch {
    throw new Error("L3_DECISION_TAPE_EXISTING_INVALID");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("L3_DECISION_TAPE_EXISTING_INVALID");
  }
  return parsed as Record<string, unknown>;
}

function assertExistingReceiptMatchesInput(input: {
  existing: Record<string, unknown>;
  expected: CanonicalJsonValue;
}): void {
  assertOneShotTapePayload(
    input.existing as unknown as CanonicalJsonValue
  );
  if (
    canonicalJson(
      input.existing as unknown as CanonicalJsonValue
    ) !== canonicalJson(input.expected)
  ) {
    throw new Error("L3_DECISION_TAPE_RECEIPT_CONFLICT");
  }
}

/**
 * Appends one of the L3 execution facts while making a replay with the same
 * event kind and receipt hash a no-op. The underlying Decision Tape append is
 * deliberately not made best-effort: a failed append is surfaced to the
 * caller so a real mutation can never be reported as a complete orchestration
 * when its audit fact is missing.
 */
export async function appendOneShotDecisionTapeEntry(input: {
  prisma: PrismaClient;
  invocationId: string;
  kind: string;
  payload: CanonicalJsonValue;
  receiptHash: string;
}): Promise<{
  sequence: number;
  entryHash: string;
  payloadHash: string;
  idempotent: boolean;
}> {
  if (
    !input.payload ||
    typeof input.payload !== "object" ||
    Array.isArray(input.payload)
  ) {
    throw new Error("L3_DECISION_TAPE_PAYLOAD_UNSAFE");
  }
  const payload = input.payload as {
    readonly [key: string]: CanonicalJsonValue;
  };
  if (
    payload.schemaVersion === undefined ||
    payload.containsForumText !== false
  ) {
    throw new Error("L3_DECISION_TAPE_PAYLOAD_UNSAFE");
  }
  assertOneShotTapePayload(payload);
  const existing = await input.prisma.decisionTapeEntry.findMany({
    where: {
      invocationId: input.invocationId,
      kind: input.kind
    },
    orderBy: { sequence: "asc" },
    select: {
      sequence: true,
      entryHash: true,
      payloadHash: true,
      payloadJson: true
    }
  });
  for (const entry of existing) {
    const payload = parseTapePayload(entry.payloadJson);
    if (payload.receiptHash === input.receiptHash) {
      assertExistingReceiptMatchesInput({
        existing: payload,
        expected: input.payload
      });
      return {
        sequence: entry.sequence,
        entryHash: entry.entryHash,
        payloadHash: entry.payloadHash,
        idempotent: true
      };
    }
  }
  // DecisionTape computes the next sequence in a read-then-create pair. Two
  // L3 facts may therefore race on the same invocation. Keep the immutable
  // payload/hash checks above, then retry only the unique-sequence conflict;
  // after each conflict re-read by receipt hash so a duplicate is a no-op.
  let lastConflict: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const appended = await appendDecisionTapeEntry({
        prisma: input.prisma,
        invocationId: input.invocationId,
        kind: input.kind,
        payload: input.payload
      });
      return { ...appended, idempotent: false };
    } catch (error) {
      if (!isP2002(error)) throw error;
      lastConflict = error;
      const afterConflict =
        await input.prisma.decisionTapeEntry.findMany({
          where: {
            invocationId: input.invocationId,
            kind: input.kind
          },
          orderBy: { sequence: "asc" },
          select: {
            sequence: true,
            entryHash: true,
            payloadHash: true,
            payloadJson: true
          }
      });
      for (const entry of afterConflict) {
        const payload = parseTapePayload(entry.payloadJson);
        if (payload.receiptHash === input.receiptHash) {
          assertExistingReceiptMatchesInput({
            existing: payload,
            expected: input.payload
          });
          return {
            sequence: entry.sequence,
            entryHash: entry.entryHash,
            payloadHash: entry.payloadHash,
            idempotent: true
          };
        }
      }
    }
  }
  throw stableAuditAppendFailure(
    lastConflict,
    "decision_tape_sequence_conflict"
  );
}

export async function appendPreExecutionRevalidatedTape(input: {
  prisma: PrismaClient;
  invocationId: string;
  receiptHash: string;
  targetVersionHash: string;
  eventSetHash: string | null;
  observedAt: Date;
}): Promise<void> {
  await appendOneShotDecisionTapeEntry({
    prisma: input.prisma,
    invocationId: input.invocationId,
    kind: "pre_execution_revalidated",
    receiptHash: input.receiptHash,
    payload: {
      schemaVersion:
        "cmooc.l3-pre-execution-revalidated.v1",
      receiptHash: input.receiptHash,
      targetVersionHash: input.targetVersionHash,
      eventSetHash: input.eventSetHash,
      observedAt: input.observedAt.toISOString(),
      targetUnchanged: true,
      containsForumText: false
    }
  });
}

/**
 * Ensure that the durable STAGE receipt and its corresponding Decision Tape
 * fact are both present before a real permit can be issued. The STAGE module
 * owns receipt creation; this local assertion keeps the publication boundary
 * fail-closed even while the companion helper is being migrated.
 */
export async function assertExecutionStageTapeRecorded(input: {
  prisma: PrismaClient;
  decisionId: string;
}): Promise<void> {
  const decision = await input.prisma.autonomyDecision.findUnique({
    where: { id: input.decisionId },
    select: { invocationId: true }
  });
  if (!decision) throw new Error("L3_STAGE_DECISION_NOT_FOUND");
  const receipt =
    await input.prisma.executionStageReceipt.findUnique({
      where: { decisionId: input.decisionId },
      select: {
        receiptHash: true,
        status: true,
        usedAt: true,
        containsForumText: true,
        sentMutationCount: true,
        publishAttempted: true,
        bodyPersisted: true
      }
    });
  if (
    !receipt ||
    receipt.status !== "verified_cleared" ||
    receipt.usedAt !== null ||
    receipt.containsForumText ||
    receipt.sentMutationCount !== 0 ||
    receipt.publishAttempted ||
    receipt.bodyPersisted
  ) {
    throw new Error("L3_EXECUTION_STAGE_REQUIRED");
  }
  await assertExecutionStageTapeBinding({
    prisma: input.prisma,
    decisionId: input.decisionId,
    receiptHash: receipt.receiptHash
  });
}

/**
 * The locate helper intentionally focuses on finding the bound thread. The
 * publication runner adds the final mechanical origin check here so no
 * cross-origin URL can reach the committer; errors never echo the URL.
 */
export function assertOneShotTargetOrigin(input: {
  postUrl: string;
  allowedOrigins: readonly string[];
}): void {
  let origin: string;
  try {
    origin = new URL(input.postUrl).origin;
  } catch {
    throw new Error("L3_PUBLISH_TARGET_ORIGIN_INVALID");
  }
  if (!input.allowedOrigins.includes(origin)) {
    throw new Error("L3_PUBLISH_TARGET_ORIGIN_INVALID");
  }
}

export async function appendExecutionPermitIssuedTape(input: {
  prisma: PrismaClient;
  invocationId: string;
  permitKey: string;
  binding: CanonicalJsonValue;
  expiresAt: Date;
  idempotent: boolean;
  realPublishEnabled: boolean;
  issuedAt: Date;
}): Promise<void> {
  const permitHash = hashOneShotOpaque(
    "cmooc.l3-execution-permit-key-opaque.v1",
    input.permitKey
  );
  const bindingHash = hashOneShotOpaque(
    "cmooc.l3-execution-permit-binding-opaque.v1",
    input.binding
  );
  const receiptHash = hashOneShotOpaque(
    "cmooc.l3-execution-permit-issued-receipt.v1",
    {
      permitHash,
      bindingHash,
      expiresAt: input.expiresAt.toISOString(),
      issuedAt: input.issuedAt.toISOString(),
      idempotent: input.idempotent,
      realPublishEnabled: input.realPublishEnabled
    }
  );
  await appendOneShotDecisionTapeEntry({
    prisma: input.prisma,
    invocationId: input.invocationId,
    kind: "execution_permit_issued",
    receiptHash,
    payload: {
      schemaVersion: "cmooc.l3-execution-permit-issued.v1",
      receiptHash,
      permitHash,
      bindingHash,
      expiresAt: input.expiresAt.toISOString(),
      issuedAt: input.issuedAt.toISOString(),
      idempotent: input.idempotent,
      realPublishEnabled: input.realPublishEnabled,
      containsForumText: false
    }
  });
}

export async function appendExecutionReceiptCommittedTape(input: {
  prisma: PrismaClient;
  invocationId: string;
  attemptId: string;
  permitKey?: string;
  remoteOutcomeHash?: string | null;
  status?: OneShotTerminalExecutionStatus;
  requestedMutationCount?: number;
  sentMutationCount?: number;
  recoveredByReconciliation?: boolean;
  committedAt?: Date;
}): Promise<void> {
  let permitKey = input.permitKey;
  let remoteOutcomeHash = input.remoteOutcomeHash ?? null;
  let status = input.status;
  let requestedMutationCount = input.requestedMutationCount;
  let sentMutationCount = input.sentMutationCount;
  let committedAt = input.committedAt;
  let recoveredByReconciliation =
    input.recoveredByReconciliation ?? false;
  if (input.prisma) {
    const persisted = await input.prisma.executionAttempt.findUnique({
      where: { id: input.attemptId },
      include: {
        permit: true,
        decision: { select: { invocationId: true } }
      }
    });
    if (!persisted) {
      throw new Error("L3_EXECUTION_ATTEMPT_NOT_FOUND");
    }
    if (
      !ONE_SHOT_TERMINAL_EXECUTION_STATUSES.has(
        persisted.status as OneShotTerminalExecutionStatus
      ) ||
      !persisted.finishedAt ||
      persisted.transport !== "real_platform"
    ) {
      throw new Error("L3_EXECUTION_RECEIPT_NOT_TERMINAL");
    }
    if (!persisted.permit) {
      throw new Error("L3_EXECUTION_ATTEMPT_PERMIT_MISSING");
    }
    if (persisted.decision.invocationId !== input.invocationId) {
      throw new Error("L3_EXECUTION_RECEIPT_INVOCATION_MISMATCH");
    }
    if (status !== undefined && status !== persisted.status) {
      throw new Error("L3_EXECUTION_RECEIPT_FACT_MISMATCH");
    }
    if (
      permitKey !== undefined &&
      permitKey !== persisted.permit.permitKey
    ) {
      throw new Error("L3_EXECUTION_RECEIPT_FACT_MISMATCH");
    }
    if (
      remoteOutcomeHash !== null &&
      remoteOutcomeHash !== undefined &&
      remoteOutcomeHash !== persisted.remoteOutcomeHash
    ) {
      throw new Error("L3_EXECUTION_RECEIPT_FACT_MISMATCH");
    }
    permitKey = persisted.permit.permitKey;
    remoteOutcomeHash = persisted.remoteOutcomeHash;
    status = persisted.status as OneShotTerminalExecutionStatus;
    requestedMutationCount = persisted.requestedMutationCount;
    sentMutationCount = persisted.sentMutationCount;
    // A terminal attempt's DB finish time is the authoritative receipt time;
    // never replace it with a caller-supplied wall-clock value.
    committedAt = persisted.finishedAt;
  }
  if (
    !permitKey ||
    !status ||
    requestedMutationCount === undefined ||
    sentMutationCount === undefined ||
    !committedAt
  ) {
    throw new Error("L3_EXECUTION_RECEIPT_FACT_INVALID");
  }
  if (
    !Number.isSafeInteger(requestedMutationCount) ||
    !Number.isSafeInteger(sentMutationCount) ||
    requestedMutationCount < 0 ||
    sentMutationCount < 0
  ) {
    throw new Error("L3_EXECUTION_RECEIPT_FACT_INVALID");
  }
  const attemptHash = hashOneShotOpaque(
    "cmooc.l3-execution-attempt-opaque.v1",
    input.attemptId
  );
  const permitHash = hashOneShotOpaque(
    "cmooc.l3-execution-permit-key-opaque.v1",
    permitKey
  );
  const receiptHash = hashOneShotOpaque(
    "cmooc.l3-execution-receipt-committed.v1",
    {
      attemptHash,
      permitHash,
      remoteOutcomeHash,
      status,
      requestedMutationCount,
      sentMutationCount,
      committedAt: committedAt.toISOString()
    }
  );
  await appendOneShotDecisionTapeEntry({
    prisma: input.prisma,
    invocationId: input.invocationId,
    kind: "execution_receipt_committed",
    receiptHash,
    payload: {
      schemaVersion:
        "cmooc.l3-execution-receipt-committed.v1",
      receiptHash,
      executionAttemptHash: attemptHash,
      executionPermitHash: permitHash,
      remoteOutcomeHash,
      status,
      requestedMutationCount,
      sentMutationCount,
      recoveredByReconciliation,
      committedAt: committedAt.toISOString(),
      containsForumText: false
    }
  });
}

export async function appendPostExecutionObservedTape(input: {
  prisma: PrismaClient;
  invocationId: string;
  attemptId: string;
  remoteOutcomeHash?: string | null;
  status?: OneShotTerminalExecutionStatus;
  recoveredByReconciliation?: boolean;
  observedAt?: Date;
}): Promise<void> {
  let remoteOutcomeHash = input.remoteOutcomeHash ?? null;
  let status = input.status;
  let observedAt = input.observedAt;
  if (input.prisma) {
    const persisted = await input.prisma.executionAttempt.findUnique({
      where: { id: input.attemptId },
      include: { decision: { select: { invocationId: true } } }
    });
    if (!persisted) {
      throw new Error("L3_EXECUTION_ATTEMPT_NOT_FOUND");
    }
    if (
      !ONE_SHOT_TERMINAL_EXECUTION_STATUSES.has(
        persisted.status as OneShotTerminalExecutionStatus
      ) ||
      !persisted.finishedAt ||
      persisted.transport !== "real_platform"
    ) {
      throw new Error("L3_EXECUTION_RECEIPT_NOT_TERMINAL");
    }
    if (persisted.decision.invocationId !== input.invocationId) {
      throw new Error("L3_EXECUTION_RECEIPT_INVOCATION_MISMATCH");
    }
    if (status !== undefined && status !== persisted.status) {
      throw new Error("L3_EXECUTION_RECEIPT_FACT_MISMATCH");
    }
    if (
      remoteOutcomeHash !== null &&
      remoteOutcomeHash !== undefined &&
      remoteOutcomeHash !== persisted.remoteOutcomeHash
    ) {
      throw new Error("L3_EXECUTION_RECEIPT_FACT_MISMATCH");
    }
    status = persisted.status as OneShotTerminalExecutionStatus;
    remoteOutcomeHash = persisted.remoteOutcomeHash;
    observedAt = persisted.finishedAt;
  }
  if (!status || !observedAt) {
    throw new Error("L3_EXECUTION_RECEIPT_FACT_INVALID");
  }
  const attemptHash = hashOneShotOpaque(
    "cmooc.l3-execution-attempt-opaque.v1",
    input.attemptId
  );
  const receiptHash = hashOneShotOpaque(
    "cmooc.l3-post-execution-observed.v1",
    {
      attemptHash,
      remoteOutcomeHash,
      status
    }
  );
  await appendOneShotDecisionTapeEntry({
    prisma: input.prisma,
    invocationId: input.invocationId,
    kind: "post_execution_observed",
    receiptHash,
    payload: {
      schemaVersion: "cmooc.l3-post-execution-observed.v1",
      receiptHash,
      executionAttemptHash: attemptHash,
      remoteOutcomeHash,
      status,
      recoveredByReconciliation:
        input.recoveredByReconciliation ?? false,
      observedAt: observedAt.toISOString(),
      containsForumText: false
    }
  });
}

export async function appendOutcomeWindowsScheduledTape(input: {
  prisma: PrismaClient;
  invocationId: string;
  eligiblePublicationCount: number;
  createdWindowCount: number;
  existingWindowCount: number;
  ineligibleDecisionCount: number;
  scheduleSucceeded: boolean;
  scheduledAt: Date;
  windowsPresent?: boolean;
  scheduleErrorCode?: string | null;
}): Promise<void> {
  const windowsPresent =
    input.windowsPresent ??
    input.createdWindowCount + input.existingWindowCount > 0;
  const scheduleErrorCode = input.scheduleErrorCode ?? null;
  const receiptHash = hashOneShotOpaque(
    "cmooc.l3-outcome-windows-scheduled.v1",
    {
      eligiblePublicationCount:
        input.eligiblePublicationCount,
      createdWindowCount: input.createdWindowCount,
      existingWindowCount: input.existingWindowCount,
      ineligibleDecisionCount:
        input.ineligibleDecisionCount,
      scheduleSucceeded: input.scheduleSucceeded,
      created: input.createdWindowCount,
      existing: input.existingWindowCount,
      windowsPresent,
      scheduleErrorCode
    }
  );
  await appendOneShotDecisionTapeEntry({
    prisma: input.prisma,
    invocationId: input.invocationId,
    kind: "outcome_windows_scheduled",
    receiptHash,
    payload: {
      schemaVersion:
        "cmooc.l3-outcome-windows-scheduled.v1",
      receiptHash,
      eligiblePublicationCount:
        input.eligiblePublicationCount,
      createdWindowCount: input.createdWindowCount,
      existingWindowCount: input.existingWindowCount,
      ineligibleDecisionCount:
        input.ineligibleDecisionCount,
      scheduleSucceeded: input.scheduleSucceeded,
      created: input.createdWindowCount,
      existing: input.existingWindowCount,
      windowsPresent,
      scheduleErrorCode,
      scheduledAt: input.scheduledAt.toISOString(),
      containsForumText: false
    }
  });
}

export async function appendExecutionPolicyRelockedTape(input: {
  prisma: PrismaClient;
  invocationId: string;
  revokedPolicyCount: number;
  closedPermitCount: number;
  manifestLocked: boolean;
  globalHardLock: boolean;
  relockedAt: Date;
}): Promise<void> {
  let relockedAt = input.relockedAt.toISOString();
  const receiptHash = hashOneShotOpaque(
    "cmooc.l3-execution-policy-relocked.v1",
    {
      revokedPolicyCount: input.revokedPolicyCount,
      closedPermitCount: input.closedPermitCount,
      manifestLocked: input.manifestLocked,
      globalHardLock: input.globalHardLock
    }
  );
  // The relock timestamp is an audit detail, not an identity key. On a
  // replay, reuse the first persisted timestamp so strict canonical receipt
  // comparison still yields a true idempotent no-op.
  const existing = await input.prisma.decisionTapeEntry.findMany({
    where: {
      invocationId: input.invocationId,
      kind: "execution_policy_relocked"
    },
    select: { payloadJson: true }
  });
  for (const entry of existing) {
    try {
      const payload = parseTapePayload(entry.payloadJson);
      if (
        payload.receiptHash === receiptHash &&
        typeof payload.relockedAt === "string"
      ) {
        relockedAt = payload.relockedAt;
        break;
      }
    } catch {
      // appendOneShotDecisionTapeEntry performs the authoritative validation.
    }
  }
  await appendOneShotDecisionTapeEntry({
    prisma: input.prisma,
    invocationId: input.invocationId,
    kind: "execution_policy_relocked",
    receiptHash,
    payload: {
      schemaVersion:
        "cmooc.l3-execution-policy-relocked.v1",
      receiptHash,
      revokedPolicyCount: input.revokedPolicyCount,
      closedPermitCount: input.closedPermitCount,
      manifestLocked: input.manifestLocked,
      globalHardLock: input.globalHardLock,
      relockedAt,
      containsForumText: false
    }
  });
}

type OneShotManifestBindingInput = {
  courseAlias: string;
  manifest: {
    alias: string;
    manifestHash: string;
    policyVersion: string;
    realPublishEnabled: false;
  };
  manifestState: Pick<
    AutonomyCourseManifest,
    | "alias"
    | "manifestHash"
    | "policyVersion"
    | "enabled"
    | "realPublishEnabled"
  >;
  invocation: Pick<
    ScheduledInvocation,
    "id" | "courseAlias" | "manifestHash" | "mode" | "status" | "phase"
  >;
  decision: Pick<
    AutonomyDecision,
    "invocationId" | "courseAlias" | "policyVersion"
  >;
  expectedDbRealPublishEnabled: boolean;
};

/**
 * Binds the immutable disk manifest to the database row and the selected
 * completed SHADOW invocation before any target/authentication work. This is
 * intentionally a stable-code-only guard: no caller-visible value is echoed.
 */
export function assertOneShotManifestBinding(
  input: OneShotManifestBindingInput
): void {
  if (
    input.manifest.alias !== input.courseAlias ||
    input.manifestState.alias !== input.courseAlias ||
    input.manifestState.manifestHash !== input.manifest.manifestHash ||
    input.manifestState.policyVersion !== input.manifest.policyVersion ||
    input.manifestState.enabled !== true ||
    input.manifestState.realPublishEnabled !==
      input.expectedDbRealPublishEnabled ||
    input.decision.courseAlias !== input.courseAlias ||
    input.decision.policyVersion !== input.manifest.policyVersion
  ) {
    throw new Error("L3_MANIFEST_BINDING_MISMATCH");
  }
  if (
    input.invocation.id !== input.decision.invocationId ||
    input.invocation.courseAlias !== input.courseAlias ||
    input.invocation.manifestHash !== input.manifest.manifestHash ||
    input.invocation.mode !== "SHADOW" ||
    input.invocation.status !== "completed" ||
    input.invocation.phase !== "completed"
  ) {
    throw new Error("L3_SHADOW_INVOCATION_BINDING_MISMATCH");
  }
}

function preserveStableL3Error(
  error: unknown,
  fallback: string
): never {
  if (
    error instanceof Error &&
    /^L3_[A-Z0-9_]+$/.test(error.message)
  ) {
    throw error;
  }
  throw new Error(fallback);
}

export function assertOneShotReadinessState(input: {
  globalHardLock: boolean;
  manifestRealPublishEnabled: boolean;
  forumSettingRealPublishEnabled: boolean;
  activeRealPolicyCount: number;
  openRealPermitCount: number;
  blockingRealAttemptCount: number;
}): void {
  if (
    !input.globalHardLock ||
    input.manifestRealPublishEnabled ||
    input.forumSettingRealPublishEnabled ||
    input.activeRealPolicyCount !== 0 ||
    input.openRealPermitCount !== 0 ||
    input.blockingRealAttemptCount !== 0
  ) {
    throw new Error("L3_PREFLIGHT_NOT_CLEANLY_LOCKED");
  }
}

export async function inspectOneShotReadiness(input: {
  prisma: PrismaClient;
  courseAlias: string;
}) {
  let manifest: Awaited<ReturnType<typeof loadCourseManifest>>;
  try {
    manifest = await loadCourseManifest(input.courseAlias);
  } catch {
    throw new Error("L3_PREFLIGHT_MANIFEST_INVALID");
  }
  let selection: Awaited<ReturnType<typeof selectMechanicalDraft>>;
  try {
    selection = await selectMechanicalDraft({
      prisma: input.prisma,
      courseAlias: input.courseAlias
    });
  } catch (error) {
    preserveStableL3Error(error, "L3_PREFLIGHT_SELECTION_INVALID");
  }
  const [manifestState, invocation] = await Promise.all([
    input.prisma.autonomyCourseManifest.findUnique({
      where: { alias: input.courseAlias }
    }),
    input.prisma.scheduledInvocation.findUnique({
      where: { id: selection.decision.invocationId },
      select: {
        id: true,
        courseAlias: true,
        manifestHash: true,
        mode: true,
        status: true,
        phase: true
      }
    })
  ]);
  if (!manifestState) {
    throw new Error("L3_MANIFEST_BINDING_MISMATCH");
  }
  if (!invocation) {
    throw new Error("L3_SHADOW_INVOCATION_BINDING_MISMATCH");
  }
  assertOneShotManifestBinding({
    courseAlias: input.courseAlias,
    manifest,
    manifestState,
    invocation,
    decision: selection.decision,
    expectedDbRealPublishEnabled: false
  });
  let located: Awaited<
    ReturnType<typeof locateTransientExecutionTarget>
  >;
  let secret: Awaited<
    ReturnType<typeof loadOrCreateLocalEvidenceSecret>
  >;
  try {
    secret = await loadOrCreateLocalEvidenceSecret();
  } catch {
    throw new Error("L3_PREFLIGHT_EVIDENCE_SECRET_UNAVAILABLE");
  }

  const [forumSetting, activeRealPolicies, openRealPermits,
    blockingRealAttempts, historicalRealPermits, historicalRealAttempts] =
    await Promise.all([
      input.prisma.forumSetting.findUnique({
        where: { id: "default" }
      }),
      input.prisma.autonomyPolicy.count({
        where: {
          courseAlias: input.courseAlias,
          status: "active",
          realPublishEnabled: true,
          revokedAt: null
        }
      }),
      input.prisma.executionPermit.count({
        where: {
          courseAlias: input.courseAlias,
          realPublishEnabled: true,
          status: { in: ["active", "claimed"] },
          usedAt: null,
          revokedAt: null
        }
      }),
      input.prisma.executionAttempt.count({
        where: {
          decision: { courseAlias: input.courseAlias },
          transport: "real_platform",
          status: {
            notIn: [...TERMINAL_REAL_ATTEMPT_STATUSES]
          }
        }
      }),
      input.prisma.executionPermit.count({
        where: {
          courseAlias: input.courseAlias,
          realPublishEnabled: true
        }
      }),
      input.prisma.executionAttempt.count({
        where: {
          decision: { courseAlias: input.courseAlias },
          transport: "real_platform"
        }
      })
    ]);
  assertOneShotReadinessState({
    globalHardLock: REAL_FORUM_WRITE_LOCKED,
    manifestRealPublishEnabled:
      manifestState.realPublishEnabled,
    forumSettingRealPublishEnabled:
      forumSetting?.realPublishEnabled ?? false,
    activeRealPolicyCount: activeRealPolicies,
    openRealPermitCount: openRealPermits,
    blockingRealAttemptCount: blockingRealAttempts
  });
  try {
    located = await locateTransientExecutionTarget({
      manifest,
      threadKey: selection.decision.threadKey,
      secret,
      observedAt: new Date()
    });
    assertOneShotTargetOrigin({
      postUrl: located.target.postUrl,
      allowedOrigins: manifest.allowedOrigins
    });
  } catch {
    throw new Error("L3_PREFLIGHT_TARGET_READ_FAILED");
  }
  let writeToken: Awaited<
    ReturnType<typeof resolveCmoocApiWriteToken>
  >;
  try {
    writeToken = await resolveCmoocApiWriteToken({
      includePlaywrightStorageState: true
    });
  } catch {
    throw new Error("L3_PREFLIGHT_WRITE_AUTH_UNAVAILABLE");
  }
  let originalObservation: Record<string, unknown>;
  try {
    const observation =
      await input.prisma.autonomyObservation.findUnique({
        where: {
          receiptHash:
            selection.decision.observationReceiptHash
        }
      });
    if (!observation) {
      throw new Error("missing");
    }
    originalObservation = JSON.parse(
      observation.receiptJson
    ) as Record<string, unknown>;
  } catch {
    throw new Error("L3_PREFLIGHT_OBSERVATION_INVALID");
  }
  if (
    typeof originalObservation.targetVersionHash !== "string" ||
    typeof originalObservation.eventSetHash !== "string" ||
    located.target.targetVersionHash !==
      located.preExecutionObservation.receipt.targetVersionHash ||
    located.target.targetVersionHash !==
      originalObservation.targetVersionHash ||
    located.target.eventSetHash !==
      located.preExecutionObservation.receipt.eventSetHash ||
      located.target.eventSetHash !==
      originalObservation.eventSetHash
  ) {
    throw new Error("L3_PREFLIGHT_TARGET_CHANGED");
  }
  return {
    ready: true,
    courseAlias: input.courseAlias,
    selectionHash: selection.selectionHash,
    candidateOrdinal: selection.candidateOrdinal,
    candidateCount: selection.candidateCount,
    targetVersionUnchanged: true,
    deterministicDraftRebuilt: true,
    writeCredentialSource: writeToken.source,
    globalHardLock: true,
    manifestRealPublishEnabled: false,
    forumSettingRealPublishEnabled: false,
    activeRealPolicyCount: 0,
    openRealPermitCount: 0,
    blockingRealAttemptCount: 0,
    historicalRealPermitCount: historicalRealPermits,
    historicalRealAttemptCount: historicalRealAttempts,
    containsForumText: false
  } as const;
}

function parseObservedAt(value: string): Date {
  const observedAt = new Date(value);
  if (!Number.isFinite(observedAt.getTime())) {
    throw new Error("L3_PUBLISH_OBSERVATION_INVALID");
  }
  return observedAt;
}

async function appendTerminalAttemptAudit(input: {
  prisma: PrismaClient;
  invocationId: string;
  decisionId: string;
  recoveredByReconciliation?: boolean;
}): Promise<boolean> {
  const attempt =
    await input.prisma.executionAttempt.findFirst({
      where: {
        decisionId: input.decisionId,
        transport: "real_platform",
        status: { in: [...ONE_SHOT_TERMINAL_EXECUTION_STATUSES] }
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        decision: { select: { invocationId: true } }
      }
    });
  if (!attempt) return false;
  if (attempt.decision.invocationId !== input.invocationId) {
    throw new Error("L3_EXECUTION_RECEIPT_INVOCATION_MISMATCH");
  }
  const status = attempt.status as OneShotTerminalExecutionStatus;
  if (!ONE_SHOT_TERMINAL_EXECUTION_STATUSES.has(status)) {
    return false;
  }
  await appendExecutionReceiptCommittedTape({
    prisma: input.prisma,
    invocationId: input.invocationId,
    attemptId: attempt.id,
    status,
    // ExecutionAttempt has no durable reconciliation flag. Preserve the
    // conservative fact and do not label catch-path recovery as remote
    // reconciliation without proof.
    recoveredByReconciliation:
      input.recoveredByReconciliation ?? false
  });
  await appendPostExecutionObservedTape({
    prisma: input.prisma,
    invocationId: input.invocationId,
    attemptId: attempt.id,
    status,
    recoveredByReconciliation:
      input.recoveredByReconciliation ?? false
  });
  return true;
}

async function releaseOwnedExecutionAccountLeaseIfActive(input: {
  prisma: PrismaClient;
  lease: ExecutionAccountLeaseSummary | null;
  decisionId: string | null;
  now: Date;
}): Promise<void> {
  const lease = input.lease;
  if (!lease || !input.decisionId) return;
  try {
    const active = await loadActiveExecutionAccountLease({
      prisma: input.prisma,
      leaseId: lease.leaseId,
      decisionId: input.decisionId,
      accountRefHash: lease.accountRefHash,
      now: input.now
    });
    if (!active) return;
    await releaseExecutionAccountLease({
      prisma: input.prisma,
      leaseId: lease.leaseId,
      decisionId: input.decisionId,
      accountRefHash: lease.accountRefHash,
      now: input.now
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (
      message === "EXECUTION_ACCOUNT_LEASE_ALREADY_CONSUMED" ||
      message === "EXECUTION_ACCOUNT_LEASE_ALREADY_RELEASED" ||
      message === "EXECUTION_ACCOUNT_LEASE_EXPIRED" ||
      message === "EXECUTION_ACCOUNT_LEASE_NOT_FOUND"
    ) {
      return;
    }
    throw new Error("L3_EXECUTION_ACCOUNT_LEASE_CLEANUP_FAILED");
  }
}

export async function executeOneShotPublication(input: {
  prisma: PrismaClient;
  courseAlias: string;
  /** Exact in-process STAGE handoff; standalone publication is not allowed. */
  handoff?: OneShotPublicationHandoff;
  /** Alias used by callers that name the binding explicitly as expected. */
  expectedHandoff?: OneShotPublicationHandoff;
}) {
  // Guard the real publication function itself; a CLI-only check is not a
  // boundary for other server-side callers of this exported function.
  assertTrustedStagePublishGuards(process.env);
  if (
    input.handoff &&
    input.expectedHandoff &&
    (input.handoff.decisionId !== input.expectedHandoff.decisionId ||
      input.handoff.selectionHash !== input.expectedHandoff.selectionHash ||
      input.handoff.policyVersion !== input.expectedHandoff.policyVersion)
  ) {
    throw new Error("L3_PUBLICATION_HANDOFF_CONFLICT");
  }
  const handoff = input.handoff ?? input.expectedHandoff;
  if (!handoff) {
    throw new Error("L3_PUBLICATION_HANDOFF_REQUIRED");
  }
  if (
    handoff.decisionId.length === 0 ||
    handoff.selectionHash.length === 0 ||
    handoff.policyVersion.length === 0
  ) {
    throw new Error("L3_PUBLICATION_HANDOFF_INVALID");
  }
  const startedAt = new Date();
  let selectedInvocationId: string | null = null;
  let selectedDecisionId: string | null = null;
  let executionRecoveredByReconciliation: boolean | null = null;
  let ownedExecutionAccountLease: ExecutionAccountLeaseSummary | null = null;
  let rootError: unknown = null;
  let relock:
    | Awaited<ReturnType<typeof relockOneShotPolicy>>
    | null = null;
  let ownsHandoffPolicy = false;
  try {
    let manifest: Awaited<ReturnType<typeof loadCourseManifest>>;
    try {
      manifest = await loadCourseManifest(input.courseAlias);
    } catch {
      throw new Error("L3_PUBLISH_MANIFEST_INVALID");
    }
    let policy: Awaited<
      ReturnType<typeof loadActiveOneShotPolicy>
    >;
    try {
      policy = await loadActiveOneShotPolicy({
        prisma: input.prisma,
        courseAlias: input.courseAlias,
        now: startedAt,
        expectedPolicyVersion: handoff.policyVersion
      });
    } catch (error) {
      preserveStableL3Error(error, "L3_PUBLISH_POLICY_INVALID");
    }
    const selection = await selectMechanicalDraft({
      prisma: input.prisma,
      courseAlias: input.courseAlias,
      allowStagedForPolicyVersion: policy.version
    });
    if (
      policy.version !== handoff.policyVersion ||
      selection.selectionHash !== handoff.selectionHash ||
      selection.decision.id !== handoff.decisionId
    ) {
      throw new Error("L3_PUBLICATION_HANDOFF_MISMATCH");
    }
    // From this point the exact policy/decision/selection binding has been
    // proven. Any later failure must relock this policy, but a binding/load
    // failure above must not revoke a foreign active policy.
    ownsHandoffPolicy = true;
    // Save the selected invocation immediately so every subsequent failure
    // can still be tied to a successful relock fact.
    selectedInvocationId = selection.decision.invocationId;
    selectedDecisionId = selection.decision.id;
    const [manifestState, invocation] = await Promise.all([
      input.prisma.autonomyCourseManifest.findUnique({
        where: { alias: input.courseAlias }
      }),
      input.prisma.scheduledInvocation.findUnique({
        where: { id: selection.decision.invocationId },
        select: {
          id: true,
          courseAlias: true,
          manifestHash: true,
          mode: true,
          status: true,
          phase: true
        }
      })
    ]);
    if (!manifestState) {
      throw new Error("L3_MANIFEST_BINDING_MISMATCH");
    }
    if (!invocation) {
      throw new Error("L3_SHADOW_INVOCATION_BINDING_MISMATCH");
    }
    assertOneShotManifestBinding({
      courseAlias: input.courseAlias,
      manifest,
      manifestState,
      invocation,
      decision: selection.decision,
      expectedDbRealPublishEnabled: true
    });
    const priorSuccessfulTape =
      await input.prisma.decisionTapeEntry.findFirst({
        where: {
          invocationId: selection.decision.invocationId,
          kind: "execution_receipt_committed"
        },
        select: { sequence: true }
      });
    if (priorSuccessfulTape) {
      throw new Error("L3_PUBLISH_REPLAY_BLOCKED");
    }
    let secret: Awaited<
      ReturnType<typeof loadOrCreateLocalEvidenceSecret>
    >;
    try {
      secret = await loadOrCreateLocalEvidenceSecret();
    } catch {
      throw new Error("L3_PUBLISH_EVIDENCE_SECRET_UNAVAILABLE");
    }
    const originalObservation =
      await input.prisma.autonomyObservation.findUnique({
        where: {
          receiptHash: selection.decision.observationReceiptHash
        }
      });
    if (!originalObservation) {
      throw new Error("L3_PUBLISH_OBSERVATION_INVALID");
    }
    let originalTargetVersionHash: Record<string, unknown>;
    try {
      originalTargetVersionHash = JSON.parse(
        originalObservation.receiptJson
      ) as Record<string, unknown>;
    } catch {
      throw new Error("L3_PUBLISH_OBSERVATION_INVALID");
    }
    await assertExecutionStageTapeRecorded({
      prisma: input.prisma,
      decisionId: selection.decision.id
    });
    const facilitationFunction = selectedFacilitationFunction(
      selection.decision.decisionJson
    );
    let accountDescriptors: CmoocExecutionAccountDescriptor[];
    try {
      const runtime = await loadCmoocExecutionAccountRuntime();
      accountDescriptors =
        filterExecutionAccountDescriptorsByFacilitationFunction(
          runtime.listDescriptors(input.courseAlias),
          facilitationFunction
        );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "L3_EXECUTION_ACCOUNT_ROLE_UNAVAILABLE"
      ) {
        throw error;
      }
      throw new Error("L3_EXECUTION_ACCOUNT_POOL_UNAVAILABLE");
    }
    if (accountDescriptors.length === 0) {
      throw new Error("L3_EXECUTION_ACCOUNT_ROLE_UNAVAILABLE");
    }
    try {
      ownedExecutionAccountLease =
        await acquireExecutionAccountLease({
          prisma: input.prisma,
          courseAlias: input.courseAlias,
          invocationId: selection.decision.invocationId,
          decisionId: selection.decision.id,
          accounts: accountDescriptors,
          now: new Date(),
          validForMinutes: 5
        });
    } catch (error) {
      preserveStableL3Error(
        error,
        "L3_EXECUTION_ACCOUNT_LEASE_UNAVAILABLE"
      );
    }
    let accountWriteToken: CmoocApiWriteToken;
    try {
      accountWriteToken = assertOneShotAccountWriteToken({
        writeToken: await resolveCmoocApiWriteToken({
          executionAccountRefHash:
            ownedExecutionAccountLease.accountRefHash
        }),
        accountRefHash: ownedExecutionAccountLease.accountRefHash,
        credentialRefHash: ownedExecutionAccountLease.credentialRefHash
      });
    } catch (error) {
      preserveStableL3Error(
        error,
        "L3_EXECUTION_ACCOUNT_AUTH_UNAVAILABLE"
      );
    }
    let located: Awaited<
      ReturnType<typeof locateTransientExecutionTarget>
    >;
    try {
      located = await locateTransientExecutionTarget({
        manifest,
        threadKey: selection.decision.threadKey,
        secret,
        writeToken: accountWriteToken,
        executionAccountLeaseId: ownedExecutionAccountLease.leaseId,
        executionAccountRefHash: ownedExecutionAccountLease.accountRefHash,
        credentialRefHash: ownedExecutionAccountLease.credentialRefHash,
        observedAt: new Date()
      });
      assertOneShotTargetOrigin({
        postUrl: located.target.postUrl,
        allowedOrigins: manifest.allowedOrigins
      });
    } catch (error) {
      preserveStableL3Error(
        error,
        "L3_PUBLISH_ACCOUNT_BOUND_TARGET_READ_FAILED"
      );
    }
    if (
      typeof originalTargetVersionHash.targetVersionHash !==
        "string" ||
      typeof originalTargetVersionHash.eventSetHash !== "string" ||
      originalTargetVersionHash.targetVersionHash !==
        located.target.targetVersionHash ||
      located.target.targetVersionHash !==
        located.preExecutionObservation.receipt.targetVersionHash ||
      originalTargetVersionHash.eventSetHash !==
        located.target.eventSetHash ||
      located.target.eventSetHash !==
        located.preExecutionObservation.receipt.eventSetHash
    ) {
      throw new Error("L3_PUBLISH_TARGET_CHANGED");
    }
    await appendAuditFact({
      stage: "pre_execution_revalidated",
      append: () =>
        appendPreExecutionRevalidatedTape({
          prisma: input.prisma,
          invocationId: selection.decision.invocationId,
          receiptHash: located.preExecutionObservation.receiptHash,
          targetVersionHash:
            located.preExecutionObservation.receipt.targetVersionHash,
          eventSetHash:
            located.preExecutionObservation.receipt.eventSetHash ?? null,
          observedAt: parseObservedAt(
            located.preExecutionObservation.receipt.observedAt
          )
        })
    });
    const permitRequestedAt = new Date();
    const issued = await issueExecutionPermit({
      prisma: input.prisma,
      decisionId: selection.decision.id,
      executionPolicyVersion: policy.version,
      now: permitRequestedAt,
      expiresInSeconds: 120,
      requireRealExecution: true,
      executionAccountLeaseId: ownedExecutionAccountLease.leaseId
    });
    await appendAuditFact({
      stage: "execution_permit_issued",
      append: () =>
        appendExecutionPermitIssuedTape({
          prisma: input.prisma,
          invocationId: selection.decision.invocationId,
          permitKey: issued.permit.permitKey,
          binding: issued.binding as unknown as CanonicalJsonValue,
          expiresAt: issued.permit.expiresAt,
          idempotent: issued.idempotent,
          realPublishEnabled: issued.permit.realPublishEnabled,
          issuedAt: issued.permit.createdAt
        })
    });
    const result = await executeCmoocProductionCommit({
      prisma: input.prisma,
      permitKey: issued.permit.permitKey,
      preExecutionObservation:
        located.preExecutionObservation,
      target: located.target,
      transientBody: selection.transientBody,
      signingSecret: secret
    });
    executionRecoveredByReconciliation =
      result.recoveredByReconciliation;
    await appendAuditFact({
      stage: "execution_receipt_committed",
      append: () =>
        appendExecutionReceiptCommittedTape({
          prisma: input.prisma,
          invocationId: selection.decision.invocationId,
          attemptId: result.attemptId,
          permitKey: result.permitKey,
          remoteOutcomeHash: result.remoteOutcomeHash,
          status: result.status,
          requestedMutationCount:
            result.requestedMutationCount,
          sentMutationCount: result.sentMutationCount,
          recoveredByReconciliation:
            result.recoveredByReconciliation
        })
    });
    await appendAuditFact({
      stage: "post_execution_observed",
      append: () =>
        appendPostExecutionObservedTape({
          prisma: input.prisma,
          invocationId: selection.decision.invocationId,
          attemptId: result.attemptId,
          remoteOutcomeHash: result.remoteOutcomeHash,
          status: result.status,
          recoveredByReconciliation:
            result.recoveredByReconciliation
        })
    });

    let proximalOutcomeWindowsScheduled = false;
    let scheduleSucceeded = true;
    let scheduleErrorCode: string | null = null;
    let outcomeSchedule = {
      eligiblePublicationCount: 0,
      createdWindowCount: 0,
      existingWindowCount: 0,
      ineligibleDecisionCount: 0
    };
    const scheduleObservedAt = new Date();
    try {
      const scheduled = await scheduleProximalOutcomes({
        prisma: input.prisma,
        decisionIds: [selection.decision.id]
      });
      outcomeSchedule = {
        eligiblePublicationCount:
          scheduled.eligiblePublicationCount,
        createdWindowCount: scheduled.createdWindowCount,
        existingWindowCount: scheduled.existingWindowCount,
      ineligibleDecisionCount:
          scheduled.ineligibleDecisionCount
      };
    } catch {
      scheduleSucceeded = false;
      // The remote publication remains confirmed. This marker lets a later
      // worker compensate only the outcome scheduling step.
      scheduleErrorCode = "L3_OUTCOME_SCHEDULE_FAILED";
    }
    const windowsPresent =
      outcomeSchedule.createdWindowCount +
        outcomeSchedule.existingWindowCount >
      0;
    proximalOutcomeWindowsScheduled =
      scheduleSucceeded && windowsPresent;
    await appendAuditFact({
      stage: "outcome_windows_scheduled",
      append: () =>
        appendOutcomeWindowsScheduledTape({
          prisma: input.prisma,
          invocationId: selection.decision.invocationId,
          ...outcomeSchedule,
          scheduleSucceeded,
          windowsPresent,
          scheduleErrorCode,
          scheduledAt: scheduleObservedAt
        })
    });
    return {
      ...result,
      courseAlias: input.courseAlias,
      selectionHash: selection.selectionHash,
      policyVersion: policy.version,
      proximalOutcomeWindowsScheduled,
      scheduleSucceeded,
      outcomeWindowsCreated: outcomeSchedule.createdWindowCount,
      outcomeWindowsExisting: outcomeSchedule.existingWindowCount,
      outcomeWindowsPresent: windowsPresent,
      outcomeScheduleErrorCode: scheduleErrorCode,
      containsForumText: false as const
    };
  } catch (error) {
    rootError = error;
    let auditError: unknown = null;
    if (selectedInvocationId && selectedDecisionId) {
      try {
        await appendTerminalAttemptAudit({
          prisma: input.prisma,
          invocationId: selectedInvocationId,
          decisionId: selectedDecisionId,
          recoveredByReconciliation:
            executionRecoveredByReconciliation ?? false
        });
      } catch (terminalAuditError) {
        auditError = terminalAuditError;
      }
    }
    if (auditError) {
      throw stableAuditAppendFailure(
        { originalError: error, auditError },
        "terminal_execution_receipt"
      );
    }
    throw error;
  } finally {
    let accountLeaseCleanupFailure: unknown = null;
    // A policy is owned only after the exact handoff binding has matched. A
    // wrong/missing handoff therefore exits without touching a foreign
    // active policy; all later execution paths retain the full relock barrier.
    const relockAt = new Date();
    let relockFailure: unknown = null;
    if (ownsHandoffPolicy) {
      try {
        relock = await relockOneShotPolicy({
          prisma: input.prisma,
          courseAlias: input.courseAlias,
          ownedPolicyVersion: handoff.policyVersion,
          now: relockAt
        });
      } catch (error) {
        relockFailure =
          error instanceof Error &&
          /^L3_[A-Z0-9_]+$/.test(error.message)
            ? error
            : new Error("L3_FINAL_RELOCK_FAILED");
      }
      if (
        relock &&
        (!relock.manifestLocked || !relock.globalHardLock)
      ) {
        relockFailure = new Error("L3_FINAL_RELOCK_FAILED");
      }
    }
    // Relock first: it may atomically consume/release the permit's lease while
    // settling a sending attempt.  Only an owned lease that remains active
    // after that transition is a leftover eligible for cleanup.
    let finalAuditError: unknown = null;
    if (ownsHandoffPolicy && selectedInvocationId && selectedDecisionId) {
      // relockOneShotPolicy may settle a sending attempt as outcome_unknown;
      // append that DB fact before recording the successful relock.
      try {
        await appendTerminalAttemptAudit({
          prisma: input.prisma,
          invocationId: selectedInvocationId,
          decisionId: selectedDecisionId,
          recoveredByReconciliation:
            executionRecoveredByReconciliation ?? false
        });
      } catch (terminalAuditError) {
        finalAuditError = terminalAuditError;
      }
      if (relock && relockFailure === null) {
        try {
          await appendExecutionPolicyRelockedTape({
            prisma: input.prisma,
            invocationId: selectedInvocationId,
            revokedPolicyCount: relock.revokedPolicyCount,
            closedPermitCount: relock.closedPermitCount,
            manifestLocked: relock.manifestLocked,
            globalHardLock: relock.globalHardLock,
            relockedAt: relockAt
          });
        } catch (relockAuditError) {
          finalAuditError = relockAuditError;
        }
      }
    }
    try {
      await releaseOwnedExecutionAccountLeaseIfActive({
        prisma: input.prisma,
        lease: ownedExecutionAccountLease,
        decisionId: selectedDecisionId,
        now: new Date()
      });
    } catch (error) {
      accountLeaseCleanupFailure = error;
    }
    // A remote outcome is intentionally a durable blocking state.  Preserve
    // that stable code even if a later audit/cleanup projection also fails;
    // callers must not interpret the wrapper as safe to retry.
    const preservedOutcomeUnknown =
      preserveOneShotOutcomeUnknownRootError(rootError);
    if (preservedOutcomeUnknown) throw preservedOutcomeUnknown;
    if (finalAuditError) {
      throw stableAuditAppendFailure(
        { originalError: rootError, auditError: finalAuditError },
        "relock_or_terminal_execution_receipt"
      );
    }
    if (accountLeaseCleanupFailure) {
      const preserved =
        preserveOneShotOutcomeUnknownRootError(rootError);
      if (preserved) throw preserved;
      throw accountLeaseCleanupFailure;
    }
    if (relockFailure) {
      // outcome_unknown is a durable stop condition, not a generic cleanup
      // failure. Preserve it so operators never interpret this path as safe
      // to retry merely because the relock postcondition also reports the
      // intentionally blocking attempt.
      const preserved =
        preserveOneShotOutcomeUnknownRootError(rootError);
      if (preserved) throw preserved;
      throw relockFailure;
    }
  }
}
