import type { Prisma, PrismaClient } from "@prisma/client";
import {
  parseCommunityTeacherJudgement,
  type CommunityTeacherJudgementV1
} from "@/lib/community-memory/teacher-judgement-bridge";
import type { CanonicalJsonValue } from "@/lib/facilitation-protocol";
import { appendDecisionTapeEntry } from "./decision-tape";

export const COMMUNITY_TEACHER_JUDGEMENT_TAPE_KIND =
  "community_teacher_judgement" as const;

export type CommunityTeacherJudgementTapeDb =
  | PrismaClient
  | Prisma.TransactionClient;

export type CommunityTeacherJudgementTapeAppendResult = {
  readonly replayed: boolean;
  readonly sequence: number;
  readonly entryHash: string;
  readonly payloadHash: string;
  readonly judgementHash: string;
};

export class CommunityTeacherJudgementTapeError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "CommunityTeacherJudgementTapeError";
    this.code = code;
  }
}

function fail(code: string, message = code): never {
  throw new CommunityTeacherJudgementTapeError(code, message);
}

function iso(value: Date): string {
  return value.toISOString();
}

function assertExactRuntimeScope(input: {
  readonly judgement: CommunityTeacherJudgementV1;
  readonly decision: {
    readonly invocationId: string;
    readonly courseAlias: string;
    readonly worldHash: string;
    readonly candidateSetHash: string;
    readonly evidenceAsOf: Date;
  };
  readonly world: {
    readonly invocationId: string;
    readonly courseAlias: string;
    readonly asOfAt: Date;
    readonly worldHash: string;
  };
  readonly graph: {
    readonly worldSnapshotId: string;
    readonly courseAlias: string;
    readonly asOfAt: Date;
    readonly contentGraphHash: string;
  };
  readonly candidateSet: {
    readonly invocationId: string;
    readonly snapshotId: string;
    readonly asOfAt: Date;
    readonly candidateSetHash: string;
  };
  readonly invocationId: string;
}): void {
  const { judgement, decision, world, graph, candidateSet, invocationId } = input;
  const anchor = judgement.anchor;
  if (
    anchor.invocationId !== invocationId ||
    judgement.courseAlias !== anchor.courseAlias ||
    decision.invocationId !== invocationId ||
    decision.courseAlias !== anchor.courseAlias ||
    decision.worldHash !== anchor.worldHash ||
    decision.candidateSetHash !== anchor.candidateSetHash ||
    iso(decision.evidenceAsOf) !== anchor.asOfAt ||
    world.invocationId !== invocationId ||
    world.courseAlias !== anchor.courseAlias ||
    world.worldHash !== anchor.worldHash ||
    iso(world.asOfAt) !== anchor.asOfAt ||
    graph.worldSnapshotId !== anchor.worldSnapshotId ||
    graph.courseAlias !== anchor.courseAlias ||
    graph.contentGraphHash !== anchor.graphHash ||
    iso(graph.asOfAt) !== anchor.asOfAt ||
    candidateSet.invocationId !== invocationId ||
    candidateSet.snapshotId !== anchor.worldSnapshotId ||
    candidateSet.candidateSetHash !== anchor.candidateSetHash ||
    iso(candidateSet.asOfAt) !== anchor.asOfAt
  ) {
    fail("COMMUNITY_TEACHER_JUDGEMENT_TAPE_ANCHOR_MISMATCH");
  }
}

/**
 * Append one canonical teacher judgement to the autonomy Decision Tape.
 *
 * This is intentionally not wired into the browser store or ordinary ticks:
 * a caller must supply the exact autonomy invocation and decision anchor. A
 * repeated judgement hash is idempotent; reusing an operation key with a
 * different judgement is rejected. No decision, permit, editor or publish
 * state is changed.
 */
export async function appendCommunityTeacherJudgementToDecisionTape(input: {
  readonly prisma: CommunityTeacherJudgementTapeDb;
  readonly invocationId: string;
  readonly judgement: CommunityTeacherJudgementV1 | unknown;
}): Promise<CommunityTeacherJudgementTapeAppendResult> {
  const judgement = parseCommunityTeacherJudgement(input.judgement);
  const anchor = judgement.anchor;
  if (anchor.invocationId !== input.invocationId) {
    fail("COMMUNITY_TEACHER_JUDGEMENT_TAPE_INVOCATION_MISMATCH");
  }
  const [decision, world, graph, candidateSet] = await Promise.all([
    input.prisma.autonomyDecision.findUnique({
      where: { decisionKey: judgement.decisionKey },
      select: {
        invocationId: true,
        courseAlias: true,
        worldHash: true,
        candidateSetHash: true,
        evidenceAsOf: true
      }
    }),
    input.prisma.courseWorldSnapshot.findUnique({
      where: { id: anchor.worldSnapshotId },
      select: {
        invocationId: true,
        courseAlias: true,
        asOfAt: true,
        worldHash: true
      }
    }),
    input.prisma.courseContentGraphSnapshot.findUnique({
      where: { id: anchor.graphSnapshotId },
      select: {
        worldSnapshotId: true,
        courseAlias: true,
        asOfAt: true,
        contentGraphHash: true
      }
    }),
    input.prisma.candidateSet.findUnique({
      where: { id: anchor.candidateSetId },
      select: {
        invocationId: true,
        snapshotId: true,
        asOfAt: true,
        candidateSetHash: true
      }
    })
  ]);
  if (!decision || !world || !graph || !candidateSet) {
    fail("COMMUNITY_TEACHER_JUDGEMENT_TAPE_ANCHOR_NOT_FOUND");
  }
  assertExactRuntimeScope({
    judgement,
    decision,
    world,
    graph,
    candidateSet,
    invocationId: input.invocationId
  });

  const existing = await input.prisma.decisionTapeEntry.findMany({
    where: {
      invocationId: input.invocationId,
      kind: COMMUNITY_TEACHER_JUDGEMENT_TAPE_KIND
    },
    orderBy: { sequence: "asc" },
    select: { sequence: true, entryHash: true, payloadHash: true, payloadJson: true }
  });
  for (const entry of existing) {
    let payload: { judgementHash?: unknown; operationKey?: unknown };
    try {
      payload = JSON.parse(entry.payloadJson) as { judgementHash?: unknown; operationKey?: unknown };
    } catch {
      fail("COMMUNITY_TEACHER_JUDGEMENT_TAPE_EXISTING_INVALID");
    }
    if (payload.judgementHash === judgement.judgementHash) {
      return {
        replayed: true,
        sequence: entry.sequence,
        entryHash: entry.entryHash,
        payloadHash: entry.payloadHash,
        judgementHash: judgement.judgementHash
      };
    }
    if (payload.operationKey === judgement.operationKey) {
      fail("COMMUNITY_TEACHER_JUDGEMENT_TAPE_OPERATION_CONFLICT");
    }
  }

  const appended = await appendDecisionTapeEntry({
    prisma: input.prisma,
    invocationId: input.invocationId,
    kind: COMMUNITY_TEACHER_JUDGEMENT_TAPE_KIND,
    payload: judgement as unknown as CanonicalJsonValue
  });
  return { replayed: false, ...appended, judgementHash: judgement.judgementHash };
}
