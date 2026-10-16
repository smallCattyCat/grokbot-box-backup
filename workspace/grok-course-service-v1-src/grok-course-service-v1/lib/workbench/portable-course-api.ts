import { prisma } from "@/lib/db";
import { portableCourseActionSchema } from "./portable-course-contracts";
import { addBrowserCourse, createBrowserCourseRun, getBrowserWorkspace, interruptBrowserRun, resumeBrowserRun, BrowserCourseError } from "./browser-course-store";
import { resolveExperienceCourse } from "./community-experience-course";
import { readExperienceWorkspace } from "@/lib/community-memory/experience-service";
import { searchPublicPractice } from "./public-practice-library";

/** Called only after the portable server's bridge authentication. No teacher approval authority. */
export async function portableCourseAction(input: unknown) {
  const body = portableCourseActionSchema.parse(input);
  if (body.action === "workspace") return getBrowserWorkspace();
  if (body.action === "knowledge") return searchPublicPractice(body.query, body.limit);
  if (body.action === "add") return { course: await addBrowserCourse(body.course) };
  if (body.action === "run") return { run: await createBrowserCourseRun({ ...body, executor: "external_host" }) };
  if (body.action === "experience") {
    try {
      const alias = await resolveExperienceCourse(prisma, body.courseId);
      return { available: true, canReview: false, ...await readExperienceWorkspace(prisma, alias) };
    } catch (error) {
      if (error instanceof Error && error.message === "EXPERIENCE_COURSE_NOT_BOUND") return {
        available: false, canReview: false, reason: "尚无已投影课程回合。先保存观察与提议。", contexts: [], lessons: [], applications: []
      };
      throw error;
    }
  }
  const run = (await getBrowserWorkspace()).runs.find(value => value.id === body.runId);
  if (!run) throw new BrowserCourseError("RUN_MISSING", "课程任务不存在。", 404);
  if (body.action === "status") return { run };
  if (run.executor !== "external_host") throw new BrowserCourseError("HOST_SCOPE", "此入口只管理通用课程代理任务。", 409);
  return { run: body.action === "stop" ? await interruptBrowserRun(body.runId) : await resumeBrowserRun(body.runId) };
}
