import { buildCourseSummary } from "./browser-course-summary";
import { portableRuntimeIdentity } from "./portable-runtime-identity";
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
  if (body.action === "identity") return portableRuntimeIdentity();
  if (body.action === "summary") {
    const workspace = await getBrowserWorkspace();
    if (body.courseId && !workspace.courses.some(course => course.id === body.courseId)) throw new BrowserCourseError("COURSE_MISSING", "课程不存在。", 404);
    return buildCourseSummary(workspace, body.courseId);
  }
  if (body.action === "knowledge") return searchPublicPractice(body.query, body.limit);
  if (body.action === "add") return { course: await addBrowserCourse(body.course) };
  if (body.action === "run") return { run: await createBrowserCourseRun({ ...body, executor: "external_host" }) };
  if (body.action === "experience") {
    try {
      const alias = await resolveExperienceCourse(prisma, body.courseId);
      const workspace = await readExperienceWorkspace(prisma, alias);
      const labels = { candidate: "本课程待审经验", approved: "本课程已接纳经验", rejected: "本课程已拒绝经验 · 不可采用", retracted: "本课程已撤回经验 · 不可采用" };
      return { available: true, canReview: false, ...workspace, courseId: body.courseId, knowledgeClass: "COURSE_EXPERIENCE_REGISTRY", mustPreserveLabel: true,
        lessons: workspace.lessons.map(lesson => ({ ...lesson, courseId: body.courseId,
          knowledgeClass: `COURSE_${lesson.status.toUpperCase()}`, label: labels[lesson.status],
          acceptedForCourse: lesson.status === "approved", requiresApplicabilityCheck: true })) };
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
