import type { PrismaClient } from "@prisma/client";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import type { CourseManifest } from "./course-manifest";
import type { ObservedThreadBundle } from "./platform-observer";
import type { LiveWorldProjection } from "@/lib/world/live-world-projector";

export const CANDIDATE_SET_SCHEMA_VERSION =
  "cmooc.autonomy-candidate-set.v1" as const;

export type AutonomyCandidate = {
  candidateKey: string;
  threadKey: string;
  authorKey: string | null;
  rootEventKey: string | null;
  targetVersionHash: string;
  contributionPublishedAt: string | null;
  latestEventAt: string | null;
  eventCount: number;
  externalHumanCount: number;
  authorReturnCount: number;
  systemResponseCount: number;
  supportGapHours: number | null;
  completeness: "complete" | "censored";
  sourceObservationReceiptHash: string;
};

export type AutonomyCandidateSet = {
  schemaVersion: typeof CANDIDATE_SET_SCHEMA_VERSION;
  courseAlias: string;
  worldHash: string;
  eventSetHash: string;
  asOfAt: string;
  candidates: AutonomyCandidate[];
  containsForumText: false;
};

export async function buildAndPersistCandidateSet(input: {
  prisma: PrismaClient;
  invocationId: string;
  snapshotId: string;
  manifest: CourseManifest;
  projection: LiveWorldProjection;
  observedThreads: ObservedThreadBundle[];
}): Promise<{
  candidateSet: AutonomyCandidateSet;
  candidateSetHash: string;
}> {
  const invocation =
    await input.prisma.scheduledInvocation.findUnique({
      where: { id: input.invocationId },
      select: { courseAlias: true }
    });
  if (
    !invocation ||
    invocation.courseAlias !== input.manifest.alias
  ) {
    throw new Error("CANDIDATE_SET_INVOCATION_MISMATCH");
  }
  const observationByThread = new Map(
    input.observedThreads.map((thread) => [
      thread.threadKey,
      thread
    ])
  );
  const candidates = input.projection.threads
    .flatMap((thread): AutonomyCandidate[] => {
      const observed = observationByThread.get(thread.threadKey);
      if (!observed) return [];
      const root = observed.events.find(
        (event) =>
          event.kind === "thread_root" &&
          event.parentEventKey === null
      );
      if (!root) return [];
      const candidateWithoutKey = {
        threadKey: thread.threadKey,
        authorKey: thread.authorKey,
        rootEventKey: thread.rootEventKey,
        targetVersionHash: observed.targetVersionHash,
        contributionPublishedAt: root.occurredAt,
        latestEventAt: thread.latestEventAt,
        eventCount: thread.eventCount,
        externalHumanCount: thread.externalHumanCount,
        authorReturnCount: thread.authorReturnCount,
        systemResponseCount: thread.systemResponseCount,
        supportGapHours: thread.supportGapHours,
        completeness: thread.completeness,
        sourceObservationReceiptHash:
          observed.kernelObservationHash
      };
      return [
        {
          ...candidateWithoutKey,
          candidateKey: canonicalProtocolHash(
            "cmooc.autonomy-candidate.v1",
            candidateWithoutKey as unknown as CanonicalJsonValue
          )
        }
      ];
    })
    .sort((left, right) =>
      left.candidateKey.localeCompare(right.candidateKey)
    );
  const candidateSet: AutonomyCandidateSet = {
    schemaVersion: CANDIDATE_SET_SCHEMA_VERSION,
    courseAlias: input.manifest.alias,
    worldHash: input.projection.worldHash,
    eventSetHash: input.projection.eventSetHash,
    asOfAt: input.projection.asOfAt,
    candidates,
    containsForumText: false
  };
  const candidateSetHash = canonicalProtocolHash(
    candidateSet.schemaVersion,
    candidateSet as unknown as CanonicalJsonValue
  );
  const existing = await input.prisma.candidateSet.findUnique({
    where: { invocationId: input.invocationId }
  });
  if (existing) {
    if (existing.candidateSetHash !== candidateSetHash) {
      throw new Error("CANDIDATE_SET_IMMUTABILITY_CONFLICT");
    }
    return { candidateSet, candidateSetHash };
  }
  await input.prisma.candidateSet.create({
    data: {
      invocationId: input.invocationId,
      snapshotId: input.snapshotId,
      candidateSetHash,
      asOfAt: new Date(candidateSet.asOfAt),
      candidateCount: candidates.length,
      candidatesJson: JSON.stringify(candidateSet)
    }
  });
  return { candidateSet, candidateSetHash };
}
