import type {
  PrismaClient
} from "@prisma/client";
import type {
  CourseStructureFact,
  SafeCourseGraphAttributes
} from "./course-structure-fact";
import {
  parseCanonicalCourseStructureFact
} from "./course-structure-fact";

function attributesJson(
  attributes: SafeCourseGraphAttributes
): string {
  return JSON.stringify(attributes);
}

function persistedFactMatches(
  existing: {
    courseAlias: string;
    courseKey: string;
    factIdentityKey: string;
    factKind: string;
    subjectKey: string;
    subjectKind: string;
    predicate: string | null;
    objectKey: string | null;
    objectKind: string | null;
    revisionHash: string;
    occurredAt: Date | null;
    ordinal: number | null;
    attributesJson: string;
    legalityStatus: string;
    containsForumText: boolean;
  },
  courseAlias: string,
  fact: CourseStructureFact
): boolean {
  return (
    existing.courseAlias === courseAlias &&
    existing.courseKey === fact.courseKey &&
    existing.factIdentityKey === fact.factIdentityKey &&
    existing.factKind === fact.factKind &&
    existing.subjectKey === fact.subjectKey &&
    existing.subjectKind === fact.subjectKind &&
    existing.predicate === fact.predicate &&
    existing.objectKey === fact.objectKey &&
    existing.objectKind === fact.objectKind &&
    existing.revisionHash === fact.revisionHash &&
    (existing.occurredAt?.toISOString() ?? null) ===
      fact.occurredAt &&
    existing.ordinal === fact.ordinal &&
    existing.attributesJson === attributesJson(fact.attributes) &&
    existing.legalityStatus === fact.legalityStatus &&
    existing.containsForumText === false
  );
}

function fromPersistedFact(fact: {
  courseKey: string;
  factKey: string;
  factIdentityKey: string;
  factKind: string;
  subjectKey: string;
  subjectKind: string;
  predicate: string | null;
  objectKey: string | null;
  objectKind: string | null;
  revisionHash: string;
  occurredAt: Date | null;
  ordinal: number | null;
  attributesJson: string;
  legalityStatus: string;
  containsForumText: boolean;
}): CourseStructureFact {
  return parseCanonicalCourseStructureFact({
    schemaVersion: "cmooc.course-structure-fact.v1",
    courseKey: fact.courseKey,
    factKey: fact.factKey,
    factIdentityKey: fact.factIdentityKey,
    factKind: fact.factKind,
    subjectKey: fact.subjectKey,
    subjectKind: fact.subjectKind,
    predicate: fact.predicate,
    objectKey: fact.objectKey,
    objectKind: fact.objectKind,
    revisionHash: fact.revisionHash,
    occurredAt: fact.occurredAt?.toISOString() ?? null,
    ordinal: fact.ordinal,
    attributes: JSON.parse(fact.attributesJson) as unknown,
    legalityStatus: fact.legalityStatus,
    containsForumText: fact.containsForumText
  });
}

export async function appendCourseStructureFacts(input: {
  prisma: PrismaClient;
  scanRunId: string;
  courseAlias: string;
  courseKey: string;
  observedAt: string;
  sourceKind: string;
  facts: readonly CourseStructureFact[];
}): Promise<{
  observedFactCount: number;
  newFactCount: number;
  newObservationCount: number;
  conflictFactKeys: string[];
}> {
  const observedAt = new Date(input.observedAt);
  if (!Number.isFinite(observedAt.getTime())) {
    throw new Error("COURSE_STRUCTURE_FACT_OBSERVED_AT_INVALID");
  }
  const uniqueFacts = new Map<string, CourseStructureFact>();
  for (const inputFact of input.facts) {
    const fact = parseCanonicalCourseStructureFact(inputFact);
    if (fact.courseKey !== input.courseKey) {
      throw new Error("COURSE_STRUCTURE_FACT_COURSE_MISMATCH");
    }
    const existing = uniqueFacts.get(fact.factKey);
    if (
      existing &&
      JSON.stringify(existing) !== JSON.stringify(fact)
    ) {
      throw new Error("COURSE_STRUCTURE_FACT_INPUT_CONFLICT");
    }
    uniqueFacts.set(fact.factKey, fact);
  }
  const facts = [...uniqueFacts.values()].sort((left, right) =>
    left.factKey.localeCompare(right.factKey)
  );
  return input.prisma.$transaction(async (tx) => {
    const scanRun = await tx.courseScanRun.findUnique({
      where: { id: input.scanRunId },
      select: { courseAlias: true, status: true }
    });
    if (!scanRun || scanRun.courseAlias !== input.courseAlias) {
      throw new Error("COURSE_STRUCTURE_FACT_SCAN_RUN_MISMATCH");
    }
    const factKeys = facts.map((fact) => fact.factKey);
    const [existingFacts, existingObservations] =
      await Promise.all([
        tx.courseStructureFact.findMany({
          where: { factKey: { in: factKeys } }
        }),
        tx.courseStructureFactObservation.findMany({
          where: {
            scanRunId: input.scanRunId,
            factKey: { in: factKeys }
          },
          select: {
            factKey: true,
            observedAt: true,
            sourceKind: true,
            sourceVersionHash: true
          }
        })
      ]);
    const existingByKey = new Map(
      existingFacts.map((fact) => [fact.factKey, fact])
    );
    const conflictFactKeys = facts
      .filter((fact) => {
        const existing = existingByKey.get(fact.factKey);
        return (
          existing !== undefined &&
          !persistedFactMatches(
            existing,
            input.courseAlias,
            fact
          )
        );
      })
      .map((fact) => fact.factKey)
      .sort();
    if (conflictFactKeys.length > 0) {
      return {
        observedFactCount: facts.length,
        newFactCount: 0,
        newObservationCount: 0,
        conflictFactKeys
      };
    }
    const existingObservationByKey = new Map(
      existingObservations.map((observation) => [
        observation.factKey,
        observation
      ])
    );
    for (const fact of facts) {
      const observation =
        existingObservationByKey.get(fact.factKey);
      if (
        observation &&
        (observation.observedAt.getTime() !==
          observedAt.getTime() ||
          observation.sourceKind !== input.sourceKind ||
          observation.sourceVersionHash !== fact.revisionHash)
      ) {
        throw new Error(
          "COURSE_STRUCTURE_FACT_OBSERVATION_CONFLICT"
        );
      }
    }
    const missingFacts = facts.filter(
      (fact) => !existingByKey.has(fact.factKey)
    );
    const missingObservations = facts.filter(
      (fact) =>
        !existingObservationByKey.has(fact.factKey)
    );
    if (
      scanRun.status === "completed" &&
      (missingFacts.length > 0 ||
        missingObservations.length > 0)
    ) {
      throw new Error("COURSE_STRUCTURE_FACT_SCAN_SEALED");
    }
    if (
      !["running", "completed"].includes(scanRun.status)
    ) {
      throw new Error("COURSE_STRUCTURE_FACT_SCAN_NOT_WRITABLE");
    }
    for (const fact of missingFacts) {
      const persisted = await tx.courseStructureFact.upsert({
        where: { factKey: fact.factKey },
        create: {
          courseAlias: input.courseAlias,
          courseKey: fact.courseKey,
          factKey: fact.factKey,
          factIdentityKey: fact.factIdentityKey,
          factKind: fact.factKind,
          subjectKey: fact.subjectKey,
          subjectKind: fact.subjectKind,
          predicate: fact.predicate,
          objectKey: fact.objectKey,
          objectKind: fact.objectKind,
          revisionHash: fact.revisionHash,
          occurredAt: fact.occurredAt
            ? new Date(fact.occurredAt)
            : null,
          ordinal: fact.ordinal,
          attributesJson: attributesJson(fact.attributes),
          legalityStatus: fact.legalityStatus,
          containsForumText: false
        },
        update: {}
      });
      if (
        !persistedFactMatches(
          persisted,
          input.courseAlias,
          fact
        )
      ) {
        throw new Error(
          "COURSE_STRUCTURE_FACT_UPSERT_CONFLICT"
        );
      }
    }
    for (const fact of missingObservations) {
      const observation =
        await tx.courseStructureFactObservation.upsert({
          where: {
            scanRunId_factKey: {
              scanRunId: input.scanRunId,
              factKey: fact.factKey
            }
          },
          create: {
            scanRunId: input.scanRunId,
            factKey: fact.factKey,
            observedAt,
            sourceKind: input.sourceKind,
            sourceVersionHash: fact.revisionHash
          },
          update: {}
        });
      if (
        observation.observedAt.getTime() !==
          observedAt.getTime() ||
        observation.sourceKind !== input.sourceKind ||
        observation.sourceVersionHash !== fact.revisionHash
      ) {
        throw new Error(
          "COURSE_STRUCTURE_FACT_OBSERVATION_CONFLICT"
        );
      }
    }
    return {
      observedFactCount: facts.length,
      newFactCount: missingFacts.length,
      newObservationCount: missingObservations.length,
      conflictFactKeys: []
    };
  });
}

export async function loadCourseStructureFactsForScan(input: {
  prisma: PrismaClient;
  scanRunId: string;
  courseKey: string;
  requireCompleted?: boolean;
}): Promise<CourseStructureFact[]> {
  const scanRun = await input.prisma.courseScanRun.findUnique({
    where: { id: input.scanRunId },
    select: { status: true }
  });
  if (!scanRun) {
    throw new Error("COURSE_STRUCTURE_FACT_SCAN_NOT_FOUND");
  }
  if (
    input.requireCompleted &&
    scanRun.status !== "completed"
  ) {
    throw new Error("COURSE_STRUCTURE_FACT_SCAN_NOT_COMPLETED");
  }
  const observations =
    await input.prisma.courseStructureFactObservation.findMany({
      where: { scanRunId: input.scanRunId },
      include: { fact: true },
      orderBy: { factKey: "asc" }
    });
  return observations.map((item) => {
    const fact = fromPersistedFact(item.fact);
    if (fact.courseKey !== input.courseKey) {
      throw new Error("COURSE_STRUCTURE_FACT_COURSE_MISMATCH");
    }
    return fact;
  });
}

export async function loadLatestCourseStructureFacts(input: {
  prisma: PrismaClient;
  courseAlias: string;
  courseKey: string;
  asOfAt: Date | string;
}): Promise<CourseStructureFact[]> {
  const asOfAt = new Date(input.asOfAt);
  if (!Number.isFinite(asOfAt.getTime())) {
    throw new Error("COURSE_STRUCTURE_FACT_CUTOFF_INVALID");
  }
  const latestScan = await input.prisma.courseScanRun.findFirst({
    where: {
      courseAlias: input.courseAlias,
      status: "completed",
      finishedAt: { lte: asOfAt }
    },
    select: { id: true },
    orderBy: [
      { finishedAt: "desc" },
      { createdAt: "desc" }
    ]
  });
  if (!latestScan) return [];
  return loadCourseStructureFactsForScan({
    prisma: input.prisma,
    scanRunId: latestScan.id,
    courseKey: input.courseKey,
    requireCompleted: true
  });
}
