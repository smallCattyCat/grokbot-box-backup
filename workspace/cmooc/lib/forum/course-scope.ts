import { prisma } from "@/lib/db";

export const DEFAULT_PLATFORM_COURSE_ID =
  process.env.CMOOC_COURSE_ID?.trim() || null;
export const DEFAULT_COURSE_NAME = process.env.CMOOC_COURSE_NAME || "生成式课程的设计与实施（常态公开课）";

export type CourseScopeInput = {
  courseId?: string;
  platformCourseId?: string;
  sourceUrl?: string;
  name?: string;
};

export function extractPlatformCourseId(sourceUrl?: string | null) {
  if (!sourceUrl) return null;
  try {
    return new URL(sourceUrl).searchParams.get("courseId");
  } catch {
    return sourceUrl.match(/courseId=(\d{8,})/)?.[1] ?? null;
  }
}

export function defaultCourseSourceUrl(
  platformCourseId = DEFAULT_PLATFORM_COURSE_ID
) {
  if (!platformCourseId) {
    throw new Error("COURSE_SCOPE_PLATFORM_COURSE_ID_REQUIRED");
  }
  return `https://cmooc.bnu.edu.cn/cMOOC/course?courseId=${platformCourseId}&isBack=1`;
}

export async function ensureDefaultCourse() {
  if (!DEFAULT_PLATFORM_COURSE_ID) {
    throw new Error("COURSE_SCOPE_PLATFORM_COURSE_ID_REQUIRED");
  }
  return prisma.course.upsert({
    where: { platformCourseId: DEFAULT_PLATFORM_COURSE_ID },
    update: {
      name: DEFAULT_COURSE_NAME,
      sourceUrl: defaultCourseSourceUrl(),
      status: "active",
      metadataJson: JSON.stringify({ seededFrom: "default-course-scope" }, null, 2)
    },
    create: {
      platformCourseId: DEFAULT_PLATFORM_COURSE_ID,
      name: DEFAULT_COURSE_NAME,
      sourceUrl: defaultCourseSourceUrl(),
      status: "active",
      metadataJson: JSON.stringify({ seededFrom: "default-course-scope" }, null, 2)
    }
  });
}

export async function upsertCourseFromSource(input: CourseScopeInput) {
  if (input.courseId) {
    const course = await prisma.course.findUnique({ where: { id: input.courseId } });
    if (!course) throw new Error(`找不到课程：${input.courseId}`);
    return course;
  }

  const platformCourseId =
    input.platformCourseId ||
    extractPlatformCourseId(input.sourceUrl) ||
    DEFAULT_PLATFORM_COURSE_ID;
  if (!platformCourseId) {
    throw new Error("COURSE_SCOPE_PLATFORM_COURSE_ID_REQUIRED");
  }
  const name = input.name || (platformCourseId === DEFAULT_PLATFORM_COURSE_ID ? DEFAULT_COURSE_NAME : `课程-${platformCourseId.slice(-6)}`);
  return prisma.course.upsert({
    where: { platformCourseId },
    update: {
      name,
      sourceUrl: input.sourceUrl || defaultCourseSourceUrl(platformCourseId),
      status: "active",
      lastSyncedAt: new Date(),
      metadataJson: JSON.stringify({
        platformCourseId,
        sourceUrl: input.sourceUrl || null,
        updatedBy: "course-scope-resolver"
      }, null, 2)
    },
    create: {
      platformCourseId,
      name,
      sourceUrl: input.sourceUrl || defaultCourseSourceUrl(platformCourseId),
      status: "active",
      lastSyncedAt: new Date(),
      metadataJson: JSON.stringify({
        platformCourseId,
        sourceUrl: input.sourceUrl || null,
        createdBy: "course-scope-resolver"
      }, null, 2)
    }
  });
}

export async function resolveCourseScope(input: CourseScopeInput = {}) {
  if (input.courseId || input.platformCourseId || input.sourceUrl) {
    return upsertCourseFromSource(input);
  }

  const latestRun = await prisma.forumIngestionRun.findFirst({
    where: { status: "completed", courseId: { not: null } },
    orderBy: { createdAt: "desc" },
    include: { course: true }
  });
  if (latestRun?.course) return latestRun.course;

  return ensureDefaultCourse();
}
