import { prisma as defaultPrisma } from "@/lib/db";

export const COURSE_CONTEXT_TOOL_SCHEMA_VERSION =
  "cmooc.course-tool.course-context.v1" as const;

export type ExactCourseAnchorInput = {
  courseAlias: string;
  invocationId: string;
  snapshotId: string;
};

export type ResolvedCourseContext = {
  schemaVersion: typeof COURSE_CONTEXT_TOOL_SCHEMA_VERSION;
  status: "resolved";
  anchor: ExactCourseAnchorInput & {
    manifestHash: string;
    worldHash: string;
    eventSetHash: string;
    coverageHash: string;
    candidateSetHash: string;
    worldAsOf: string;
  };
  evidenceRefs: Array<{
    kind: "manifest" | "invocation" | "snapshot" | "coverage" | "candidate";
    id: string;
    hash: string;
    observedAt: string;
  }>;
  containsForumText: false;
  containsIdentity: false;
};

export type CourseSnapshotReadResult = {
  schemaVersion: "cmooc.course-tool.course-snapshot.v1";
  status: "ready";
  anchor: ResolvedCourseContext["anchor"];
  snapshot: {
    eventCount: number;
    threadCount: number;
    actorCount: number;
    edgeCount: number;
    openGapCount: number;
  };
  freshness: {
    observedAt: string;
    basis: "exact_world_snapshot";
  };
  evidenceRefs: ResolvedCourseContext["evidenceRefs"];
  containsForumText: false;
  containsIdentity: false;
};

export class CourseContextToolError extends Error {
  constructor(
    readonly code:
      | "COURSE_CONTEXT_INPUT_INVALID"
      | "COURSE_CONTEXT_NOT_FOUND"
      | "COURSE_CONTEXT_CONFLICT",
    message: string
  ) {
    super(message);
    this.name = "CourseContextToolError";
  }
}

const ALIAS = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const OPAQUE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

function validAnchor(value: ExactCourseAnchorInput): boolean {
  return (
    ALIAS.test(value.courseAlias) &&
    OPAQUE_ID.test(value.invocationId) &&
    OPAQUE_ID.test(value.snapshotId)
  );
}

async function anchorFromContextRef(input: {
  prisma: typeof defaultPrisma;
  courseAlias: string;
  contextRef: string;
}): Promise<ExactCourseAnchorInput> {
  const separator = input.contextRef.indexOf(":");
  const kind = input.contextRef.slice(0, separator);
  const id = input.contextRef.slice(separator + 1);
  if (
    separator < 1 ||
    !["invocation", "snapshot", "decision", "outcome", "incident"].includes(kind) ||
    !OPAQUE_ID.test(id)
  ) {
    throw new CourseContextToolError(
      "COURSE_CONTEXT_INPUT_INVALID",
      "Context reference must be an exact invocation, snapshot, decision, outcome, or incident reference."
    );
  }

  if (kind === "invocation") {
    const invocation = await input.prisma.scheduledInvocation.findUnique({
      where: { id },
      select: {
        id: true,
        courseAlias: true,
        worldSnapshot: { select: { id: true, invocationId: true, courseAlias: true } }
      }
    });
    if (
      !invocation?.worldSnapshot ||
      invocation.worldSnapshot.invocationId !== invocation.id ||
      invocation.worldSnapshot.courseAlias !== invocation.courseAlias
    ) {
      throw new CourseContextToolError(
        "COURSE_CONTEXT_NOT_FOUND",
        "Referenced invocation has no uniquely bound world snapshot."
      );
    }
    return {
      courseAlias: invocation.courseAlias,
      invocationId: invocation.id,
      snapshotId: invocation.worldSnapshot.id
    };
  }

  if (kind === "snapshot") {
    const snapshot = await input.prisma.courseWorldSnapshot.findUnique({
      where: { id },
      select: { id: true, invocationId: true, courseAlias: true }
    });
    if (!snapshot) {
      throw new CourseContextToolError(
        "COURSE_CONTEXT_NOT_FOUND",
        "Referenced course snapshot was not found."
      );
    }
    return {
      courseAlias: snapshot.courseAlias,
      invocationId: snapshot.invocationId,
      snapshotId: snapshot.id
    };
  }

  if (kind === "decision") {
    const decision = await input.prisma.autonomyDecision.findUnique({
      where: { id },
      select: {
        invocationId: true,
        courseAlias: true,
        invocation: { select: { worldSnapshot: { select: { id: true } } } }
      }
    });
    if (!decision?.invocation.worldSnapshot) {
      throw new CourseContextToolError(
        "COURSE_CONTEXT_NOT_FOUND",
        "Referenced decision has no exact world snapshot."
      );
    }
    return {
      courseAlias: decision.courseAlias,
      invocationId: decision.invocationId,
      snapshotId: decision.invocation.worldSnapshot.id
    };
  }

  if (kind === "outcome") {
    const outcome = await input.prisma.proximalOutcome.findUnique({
      where: { id },
      select: {
        decision: {
          select: {
            invocationId: true,
            courseAlias: true,
            invocation: { select: { worldSnapshot: { select: { id: true } } } }
          }
        }
      }
    });
    if (!outcome?.decision.invocation.worldSnapshot) {
      throw new CourseContextToolError(
        "COURSE_CONTEXT_NOT_FOUND",
        "Referenced outcome has no exact world snapshot."
      );
    }
    return {
      courseAlias: outcome.decision.courseAlias,
      invocationId: outcome.decision.invocationId,
      snapshotId: outcome.decision.invocation.worldSnapshot.id
    };
  }

  const incident = await input.prisma.autonomyIncident.findUnique({
    where: { id },
    select: {
      courseAlias: true,
      invocationId: true,
      invocation: { select: { worldSnapshot: { select: { id: true } } } }
    }
  });
  if (!incident?.invocationId || !incident.invocation?.worldSnapshot) {
    throw new CourseContextToolError(
      "COURSE_CONTEXT_NOT_FOUND",
      "Referenced incident has no exact world snapshot."
    );
  }
  return {
    courseAlias: incident.courseAlias,
    invocationId: incident.invocationId,
    snapshotId: incident.invocation.worldSnapshot.id
  };
}

/** Resolve an explicit context without ever falling back to a latest course. */
export async function resolveCourseContext(input: {
  anchor?: ExactCourseAnchorInput;
  courseAlias?: string;
  contextRef?: string;
  prisma?: typeof defaultPrisma;
}): Promise<ResolvedCourseContext> {
  const db = input.prisma ?? defaultPrisma;
  if (
    Boolean(input.anchor) === Boolean(input.contextRef) ||
    (input.anchor && input.courseAlias !== undefined)
  ) {
    throw new CourseContextToolError(
      "COURSE_CONTEXT_INPUT_INVALID",
      "Provide either one exact anchor or courseAlias plus one exact contextRef."
    );
  }
  let anchor: ExactCourseAnchorInput;
  if (input.anchor) {
    anchor = input.anchor;
  } else {
    const courseAlias = input.courseAlias?.trim() ?? "";
    const contextRef = input.contextRef?.trim() ?? "";
    if (!ALIAS.test(courseAlias) || !contextRef) {
      throw new CourseContextToolError(
        "COURSE_CONTEXT_INPUT_INVALID",
        "A valid course alias and exact context reference are required."
      );
    }
    anchor = await anchorFromContextRef({
      prisma: db,
      courseAlias,
      contextRef
    });
    if (anchor.courseAlias !== courseAlias) {
      throw new CourseContextToolError(
        "COURSE_CONTEXT_CONFLICT",
        "Context reference belongs to a different course."
      );
    }
  }
  if (!validAnchor(anchor)) {
    throw new CourseContextToolError(
      "COURSE_CONTEXT_INPUT_INVALID",
      "Exact course anchor is invalid."
    );
  }

  const [manifest, invocation, snapshot, scan, candidateSet] = await Promise.all([
    db.autonomyCourseManifest.findUnique({
      where: { alias: anchor.courseAlias },
      select: { alias: true, manifestHash: true }
    }),
    db.scheduledInvocation.findUnique({
      where: { id: anchor.invocationId },
      select: {
        id: true,
        courseAlias: true,
        manifestHash: true,
        scheduledFor: true
      }
    }),
    db.courseWorldSnapshot.findUnique({
      where: { id: anchor.snapshotId },
      select: {
        id: true,
        invocationId: true,
        courseAlias: true,
        asOfAt: true,
        eventSetHash: true,
        worldHash: true,
        coverageHash: true
      }
    }),
    db.courseScanRun.findUnique({
      where: { invocationId: anchor.invocationId },
      select: {
        id: true,
        invocationId: true,
        courseAlias: true,
        status: true,
        coverageHash: true,
        finishedAt: true
      }
    }),
    db.candidateSet.findUnique({
      where: { invocationId: anchor.invocationId },
      select: {
        invocationId: true,
        snapshotId: true,
        asOfAt: true,
        candidateSetHash: true
      }
    })
  ]);
  if (!manifest || !invocation || !snapshot || !scan || !candidateSet) {
    throw new CourseContextToolError(
      "COURSE_CONTEXT_NOT_FOUND",
      "Exact course evidence context is incomplete."
    );
  }
  if (
    manifest.alias !== anchor.courseAlias ||
    invocation.courseAlias !== anchor.courseAlias ||
    invocation.manifestHash !== manifest.manifestHash ||
    snapshot.courseAlias !== anchor.courseAlias ||
    snapshot.invocationId !== anchor.invocationId ||
    scan.invocationId !== anchor.invocationId ||
    scan.courseAlias !== anchor.courseAlias ||
    scan.status !== "completed" ||
    scan.coverageHash !== snapshot.coverageHash ||
    candidateSet.invocationId !== anchor.invocationId ||
    candidateSet.snapshotId !== anchor.snapshotId ||
    candidateSet.asOfAt.getTime() !== snapshot.asOfAt.getTime() ||
    !candidateSet.candidateSetHash
  ) {
    throw new CourseContextToolError(
      "COURSE_CONTEXT_CONFLICT",
      "Course, invocation, snapshot, scan, and candidate evidence do not share one anchor."
    );
  }
  const observedAt = snapshot.asOfAt.toISOString();
  return {
    schemaVersion: COURSE_CONTEXT_TOOL_SCHEMA_VERSION,
    status: "resolved",
    anchor: {
      ...anchor,
      manifestHash: manifest.manifestHash,
      worldHash: snapshot.worldHash,
      eventSetHash: snapshot.eventSetHash,
      coverageHash: snapshot.coverageHash,
      candidateSetHash: candidateSet.candidateSetHash,
      worldAsOf: observedAt
    },
    evidenceRefs: [
      {
        kind: "manifest",
        id: manifest.alias,
        hash: manifest.manifestHash,
        observedAt: invocation.scheduledFor.toISOString()
      },
      {
        kind: "invocation",
        id: invocation.id,
        hash: invocation.manifestHash,
        observedAt: invocation.scheduledFor.toISOString()
      },
      {
        kind: "snapshot",
        id: snapshot.id,
        hash: snapshot.worldHash,
        observedAt
      },
      {
        kind: "coverage",
        id: scan.id,
        hash: snapshot.coverageHash,
        observedAt: scan.finishedAt?.toISOString() ?? observedAt
      },
      {
        kind: "candidate",
        id: `${anchor.invocationId}:candidate-set`,
        hash: candidateSet.candidateSetHash,
        observedAt
      }
    ],
    containsForumText: false,
    containsIdentity: false
  };
}

export async function readCourseSnapshot(input: {
  context?: ResolvedCourseContext;
  anchor?: ExactCourseAnchorInput;
  courseAlias?: string;
  contextRef?: string;
  prisma?: typeof defaultPrisma;
}): Promise<CourseSnapshotReadResult> {
  const db = input.prisma ?? defaultPrisma;
  const context =
    input.context ??
    (await resolveCourseContext({
      anchor: input.anchor,
      courseAlias: input.courseAlias,
      contextRef: input.contextRef,
      prisma: db
    }));
  const snapshot = await db.courseWorldSnapshot.findUnique({
    where: { id: context.anchor.snapshotId },
    select: {
      id: true,
      invocationId: true,
      courseAlias: true,
      asOfAt: true,
      worldHash: true,
      eventCount: true,
      threadCount: true,
      actorCount: true,
      edgeCount: true,
      openGapCount: true
    }
  });
  if (!snapshot) {
    throw new CourseContextToolError(
      "COURSE_CONTEXT_NOT_FOUND",
      "Exact world snapshot was not found."
    );
  }
  if (
    snapshot.id !== context.anchor.snapshotId ||
    snapshot.invocationId !== context.anchor.invocationId ||
    snapshot.courseAlias !== context.anchor.courseAlias ||
    snapshot.worldHash !== context.anchor.worldHash ||
    snapshot.asOfAt.toISOString() !== context.anchor.worldAsOf
  ) {
    throw new CourseContextToolError(
      "COURSE_CONTEXT_CONFLICT",
      "World snapshot drifted from the resolved course context."
    );
  }
  return {
    schemaVersion: "cmooc.course-tool.course-snapshot.v1",
    status: "ready",
    anchor: context.anchor,
    snapshot: {
      eventCount: snapshot.eventCount,
      threadCount: snapshot.threadCount,
      actorCount: snapshot.actorCount,
      edgeCount: snapshot.edgeCount,
      openGapCount: snapshot.openGapCount
    },
    freshness: {
      observedAt: snapshot.asOfAt.toISOString(),
      basis: "exact_world_snapshot"
    },
    evidenceRefs: context.evidenceRefs,
    containsForumText: false,
    containsIdentity: false
  };
}
