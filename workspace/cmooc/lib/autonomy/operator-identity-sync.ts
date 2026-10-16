import type {
  CmoocCourseMemberType
} from "@/lib/forum/cmooc-api";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type OperatorIdentitySource =
  | "course_member"
  | "post_author"
  | "reply_author";

export type OperatorIdentityObservation = Readonly<{
  actorKey: string;
  platformAccountId: string;
  displayName: string;
  memberType: CmoocCourseMemberType | null;
  source: OperatorIdentitySource;
}>;

export type OperatorIdentitySyncDb = Readonly<{
  course: {
    findUnique(input: {
      where: { platformCourseId: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  forumUser: {
    upsert(input: {
      where: { forumUserId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      select: { id: true };
    }): Promise<{ id: string }>;
  };
  courseMembership: {
    upsert(input: {
      where: { courseId_userId: { courseId: string; userId: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      select: { id: true };
    }): Promise<{ id: string }>;
  };
}>;

function bounded(value: string, max: number): string {
  return Array.from(value.replace(/\s+/gu, " ").trim())
    .slice(0, max)
    .join("");
}

function roleForUser(memberType: CmoocCourseMemberType | null): string {
  if (memberType === "CREATOR") return "teacher";
  if (memberType === "HELPER") return "facilitator";
  return "learner";
}

function roleForCourse(memberType: CmoocCourseMemberType | null): string {
  return memberType?.toLocaleLowerCase("en-US") ?? "participant";
}

export async function syncOperatorCourseIdentities(input: {
  prisma: OperatorIdentitySyncDb;
  platformCourseId: string;
  observedAt: string;
  identities: readonly OperatorIdentityObservation[];
}): Promise<Readonly<{
  courseFound: boolean;
  observedIdentityCount: number;
  syncedIdentityCount: number;
}>> {
  const platformCourseId = bounded(input.platformCourseId, 512);
  const observedAt = new Date(input.observedAt);
  if (!platformCourseId || Number.isNaN(observedAt.getTime())) {
    throw new Error("OPERATOR_IDENTITY_SYNC_INPUT_INVALID");
  }
  const course = await input.prisma.course.findUnique({
    where: { platformCourseId },
    select: { id: true }
  });
  if (!course) {
    return Object.freeze({
      courseFound: false,
      observedIdentityCount: input.identities.length,
      syncedIdentityCount: 0
    });
  }

  const byPlatformAccount = new Map<string, OperatorIdentityObservation>();
  for (const identity of input.identities) {
    const platformAccountId = bounded(identity.platformAccountId, 160);
    const displayName = bounded(identity.displayName, 120);
    if (
      !platformAccountId ||
      !displayName ||
      !SHA256_PATTERN.test(identity.actorKey)
    ) {
      throw new Error("OPERATOR_IDENTITY_OBSERVATION_INVALID");
    }
    const existing = byPlatformAccount.get(platformAccountId);
    if (existing && existing.actorKey !== identity.actorKey) {
      throw new Error("OPERATOR_IDENTITY_ACTOR_KEY_CONFLICT");
    }
    byPlatformAccount.set(platformAccountId, {
      ...identity,
      platformAccountId,
      displayName,
      memberType: existing?.memberType ?? identity.memberType
    });
  }

  let syncedIdentityCount = 0;
  for (const identity of [...byPlatformAccount.values()].sort((left, right) =>
    left.actorKey.localeCompare(right.actorKey)
  )) {
    const forumUserId = `real-user-id-${identity.platformAccountId}`;
    const evidenceJson = JSON.stringify({
      schemaVersion: "cmooc.operator-identity-evidence.v1",
      actorKey: identity.actorKey,
      source: identity.source,
      observedAt: observedAt.toISOString(),
      containsForumText: false
    });
    const user = await input.prisma.forumUser.upsert({
      where: { forumUserId },
      create: {
        forumUserId,
        name: identity.displayName,
        role: roleForUser(identity.memberType),
        tagsJson: JSON.stringify(["real-forum", "operator-identity"]),
        activityLevel: 0,
        emotionalState: "unknown",
        centralityScore: 0,
        lastActiveAt: observedAt
      },
      update: {
        name: identity.displayName,
        lastActiveAt: observedAt
      },
      select: { id: true }
    });
    await input.prisma.courseMembership.upsert({
      where: {
        courseId_userId: { courseId: course.id, userId: user.id }
      },
      create: {
        courseId: course.id,
        userId: user.id,
        forumUserId,
        displayName: identity.displayName,
        roleInCourse: roleForCourse(identity.memberType),
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        tagsJson: JSON.stringify(["operator-identity"]),
        evidenceJson
      },
      update: {
        forumUserId,
        displayName: identity.displayName,
        ...(identity.memberType
          ? { roleInCourse: roleForCourse(identity.memberType) }
          : {}),
        lastSeenAt: observedAt,
        evidenceJson
      },
      select: { id: true }
    });
    syncedIdentityCount += 1;
  }

  return Object.freeze({
    courseFound: true,
    observedIdentityCount: input.identities.length,
    syncedIdentityCount
  });
}
