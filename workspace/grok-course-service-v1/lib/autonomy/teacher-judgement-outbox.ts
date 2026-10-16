import type { Prisma, PrismaClient } from "@prisma/client";
import { canonicalProtocolHash, type CanonicalJsonValue } from "@/lib/facilitation-protocol";
import {
  parseCommunityTeacherJudgement,
  type CommunityTeacherJudgementV1
} from "@/lib/community-memory/teacher-judgement-bridge";
import type { BrowserAutonomyBindingV1 } from "@/lib/workbench/browser-autonomy-binding";

export const COMMUNITY_TEACHER_JUDGEMENT_OUTBOX_SCHEMA_VERSION =
  "cmooc.community-teacher-judgement-outbox.v1" as const;

export const COMMUNITY_TEACHER_JUDGEMENT_OUTBOX_STATES = [
  "prepared",
  "autonomy_appended",
  "browser_mirrored",
  "needs_review"
] as const;

export type CommunityTeacherJudgementOutboxState =
  (typeof COMMUNITY_TEACHER_JUDGEMENT_OUTBOX_STATES)[number];

export type CommunityTeacherJudgementOutboxDb =
  | PrismaClient
  | Prisma.TransactionClient;

export class CommunityTeacherJudgementOutboxError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "CommunityTeacherJudgementOutboxError";
    this.code = code;
  }
}

function fail(code: string, message = code): never {
  throw new CommunityTeacherJudgementOutboxError(code, message);
}

function safeErrorCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[A-Z][A-Z0-9_.:-]{0,95}$/u.test(value) ? value : "OUTBOX_RETRY_REQUIRED";
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002"
  );
}

function allowedTransition(
  previous: CommunityTeacherJudgementOutboxState | null,
  next: CommunityTeacherJudgementOutboxState
): boolean {
  if (previous === null) return next === "prepared";
  if (previous === next) return true;
  if (previous === "prepared") return next === "autonomy_appended" || next === "needs_review";
  if (previous === "needs_review") return next === "prepared" || next === "autonomy_appended";
  if (previous === "autonomy_appended") return next === "browser_mirrored" || next === "needs_review";
  return false;
}

function outboxEventHash(value: Record<string, unknown>): string {
  return canonicalProtocolHash(
    COMMUNITY_TEACHER_JUDGEMENT_OUTBOX_SCHEMA_VERSION,
    value as unknown as CanonicalJsonValue
  );
}

export type AppendCommunityTeacherJudgementOutboxInput = {
  readonly prisma: CommunityTeacherJudgementOutboxDb;
  readonly judgement: CommunityTeacherJudgementV1 | unknown;
  readonly binding: BrowserAutonomyBindingV1;
  readonly browserCourseId: string;
  readonly state: CommunityTeacherJudgementOutboxState;
  readonly errorCode?: string | null;
};

export type AppendCommunityTeacherJudgementOutboxResult = {
  readonly replayed: boolean;
  readonly sequence: number;
  readonly eventHash: string;
  readonly state: CommunityTeacherJudgementOutboxState;
};

export type CommunityTeacherJudgementOutboxLatest = {
  readonly operationKey: string;
  readonly state: CommunityTeacherJudgementOutboxState;
  readonly judgementHash: string;
  readonly bindingHash: string;
  readonly sequence: number;
  readonly eventHash: string;
};

/**
 * Read the latest append-only event for one promotion operation.  The caller
 * uses this small projection to advance a durable outbox after a process
 * restart; it does not expose the canonical judgement body or any identity.
 */
export async function getLatestCommunityTeacherJudgementOutboxEvent(input: {
  readonly prisma: CommunityTeacherJudgementOutboxDb;
  readonly operationKey: string;
}): Promise<CommunityTeacherJudgementOutboxLatest | null> {
  const row = await input.prisma.communityTeacherJudgementOutbox.findFirst({
    where: { operationKey: input.operationKey },
    orderBy: { sequence: "desc" }
  });
  if (!row) return null;
  return {
    operationKey: row.operationKey,
    state: row.state as CommunityTeacherJudgementOutboxState,
    judgementHash: row.judgementHash,
    bindingHash: row.bindingHash,
    sequence: row.sequence,
    eventHash: row.eventHash
  };
}

/**
 * Append one body-free outbox event. The canonical judgement is re-parsed,
 * and the binding hash is checked before any database write. A repeated state
 * event is idempotent; a different judgement under one operation key is a
 * conflict. State changes are appended, never updated in place.
 */
export async function appendCommunityTeacherJudgementOutboxEvent(
  input: AppendCommunityTeacherJudgementOutboxInput
): Promise<AppendCommunityTeacherJudgementOutboxResult> {
  const judgement = parseCommunityTeacherJudgement(input.judgement);
  if (
    judgement.browserBindingHash !== input.binding.bindingHash ||
    judgement.browserRunRef !== input.binding.browserRunId ||
    judgement.operationKey !== input.binding.promotionId ||
    judgement.anchor.invocationId !== input.binding.invocationId ||
    judgement.decisionKey !== input.binding.decisionKey
  ) {
    fail("COMMUNITY_TEACHER_JUDGEMENT_OUTBOX_SCOPE_MISMATCH");
  }
  const errorCode = safeErrorCode(input.errorCode);
  const existing = await input.prisma.communityTeacherJudgementOutbox.findMany({
    where: { operationKey: judgement.operationKey },
    orderBy: { sequence: "asc" }
  });
  for (const event of existing) {
    if (event.judgementHash !== judgement.judgementHash || event.bindingHash !== input.binding.bindingHash) {
      fail("COMMUNITY_TEACHER_JUDGEMENT_OUTBOX_OPERATION_CONFLICT");
    }
  }
  const previous = existing.at(-1) ?? null;
  if (!allowedTransition(
    (previous?.state as CommunityTeacherJudgementOutboxState | undefined) ?? null,
    input.state
  )) {
    fail("COMMUNITY_TEACHER_JUDGEMENT_OUTBOX_TRANSITION_INVALID");
  }
  if (previous?.state === input.state) {
    return { replayed: true, sequence: previous.sequence, eventHash: previous.eventHash, state: previous.state as CommunityTeacherJudgementOutboxState };
  }
  const sequence = (previous?.sequence ?? 0) + 1;
  const body = {
    schemaVersion: COMMUNITY_TEACHER_JUDGEMENT_OUTBOX_SCHEMA_VERSION,
    operationKey: judgement.operationKey,
    sequence,
    state: input.state,
    judgementHash: judgement.judgementHash,
    judgementJson: JSON.stringify(judgement),
    courseAlias: input.binding.courseAlias,
    browserCourseId: input.browserCourseId,
    browserRunRef: input.binding.browserRunId,
    invocationId: input.binding.invocationId,
    decisionKey: input.binding.decisionKey,
    candidateKey: input.binding.candidateKey,
    worldSnapshotId: input.binding.anchor.worldSnapshotId,
    graphSnapshotId: input.binding.anchor.graphSnapshotId,
    candidateSetId: input.binding.anchor.candidateSetId,
    asOfAt: input.binding.anchor.asOfAt,
    worldHash: input.binding.anchor.worldHash,
    graphHash: input.binding.anchor.graphHash,
    candidateSetHash: input.binding.anchor.candidateSetHash,
    bindingHash: input.binding.bindingHash,
    browserTapeRef: input.binding.browserTapeRef,
    browserTapeHeadHash: input.binding.browserTapeHeadHash,
    browserRunRevision: input.binding.browserRunRevision,
    browserObservationHash: input.binding.browserObservationHash,
    previousEventHash: previous?.eventHash ?? null,
    errorCode
  } as const;
  const eventHash = outboxEventHash(body as unknown as Record<string, unknown>);
  try {
    await input.prisma.communityTeacherJudgementOutbox.create({
      data: {
        ...body,
        eventHash,
        asOfAt: new Date(body.asOfAt),
        createdAt: new Date()
      }
    });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const replay = await input.prisma.communityTeacherJudgementOutbox.findFirst({
      where: { operationKey: judgement.operationKey, sequence },
      orderBy: { sequence: "asc" }
    });
    if (
      replay &&
      replay.judgementHash === judgement.judgementHash &&
      replay.bindingHash === input.binding.bindingHash &&
      replay.state === input.state
    ) {
      return { replayed: true, sequence: replay.sequence, eventHash: replay.eventHash, state: replay.state as CommunityTeacherJudgementOutboxState };
    }
    fail("COMMUNITY_TEACHER_JUDGEMENT_OUTBOX_CONCURRENT_CONFLICT");
  }
  return { replayed: false, sequence, eventHash, state: input.state };
}

export type PendingCommunityTeacherJudgementOutbox = {
  readonly operationKey: string;
  readonly state: CommunityTeacherJudgementOutboxState;
  readonly judgementHash: string;
  readonly judgementJson: string;
  readonly browserCourseId: string;
  readonly browserRunRef: string;
  readonly bindingHash: string;
  readonly browserTapeRef: string;
  readonly browserTapeHeadHash: string;
  readonly browserRunRevision: number;
  readonly browserObservationHash: string;
  readonly invocationId: string;
  readonly decisionKey: string;
  readonly courseAlias: string;
  readonly worldSnapshotId: string;
  readonly graphSnapshotId: string;
  readonly candidateSetId: string;
  readonly asOfAt: string;
  readonly worldHash: string;
  readonly graphHash: string;
  readonly candidateSetHash: string;
  readonly candidateKey: string;
  readonly sequence: number;
  readonly eventHash: string;
};

/** Read the latest non-terminal event per operation for a future server scanner. */
export async function listPendingCommunityTeacherJudgementOutbox(input: {
  readonly prisma: CommunityTeacherJudgementOutboxDb;
  readonly limit?: number;
}): Promise<readonly PendingCommunityTeacherJudgementOutbox[]> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 20));
  const rows = await input.prisma.communityTeacherJudgementOutbox.findMany({
    orderBy: [{ createdAt: "asc" }, { sequence: "asc" }],
    take: limit * 10
  });
  const latest = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    const prior = latest.get(row.operationKey);
    if (!prior || row.sequence > prior.sequence) latest.set(row.operationKey, row);
  }
  return [...latest.values()]
    .filter((row) => ["prepared", "autonomy_appended", "needs_review"].includes(row.state))
    .slice(0, limit)
    .map((row) => ({
    operationKey: row.operationKey,
    state: row.state as CommunityTeacherJudgementOutboxState,
    judgementHash: row.judgementHash,
    judgementJson: row.judgementJson,
    browserCourseId: row.browserCourseId,
    browserRunRef: row.browserRunRef,
    bindingHash: row.bindingHash,
    browserTapeRef: row.browserTapeRef,
    browserTapeHeadHash: row.browserTapeHeadHash,
    browserRunRevision: row.browserRunRevision,
    browserObservationHash: row.browserObservationHash,
    invocationId: row.invocationId,
    decisionKey: row.decisionKey,
    courseAlias: row.courseAlias,
    worldSnapshotId: row.worldSnapshotId,
    graphSnapshotId: row.graphSnapshotId,
    candidateSetId: row.candidateSetId,
    asOfAt: row.asOfAt.toISOString(),
    worldHash: row.worldHash,
    graphHash: row.graphHash,
    candidateSetHash: row.candidateSetHash,
    candidateKey: row.candidateKey,
    sequence: row.sequence,
    eventHash: row.eventHash
    }));
}
