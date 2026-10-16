import { z } from "zod";
import { createBrowserCourseSchema } from "./browser-course-contracts";

const runId = z.string().uuid();
export const portableCourseActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("workspace") }).strict(),
  z.object({ action: z.literal("identity") }).strict(),
  z.object({ action: z.literal("summary"), courseId: runId.optional() }).strict(),
  z.object({ action: z.literal("knowledge"), query: z.string().max(200).default(""), limit: z.number().int().min(1).max(20).default(5) }).strict(),
  z.object({ action: z.literal("add"), course: createBrowserCourseSchema }).strict(),
  z.object({ action: z.literal("run"), courseId: runId, requestId: runId, goal: z.string().trim().min(1).max(800).optional(), mode: z.enum(["observe", "stage"]).default("observe") }).strict(),
  z.object({ action: z.literal("status"), runId }).strict(),
  z.object({ action: z.literal("stop"), runId }).strict(),
  z.object({ action: z.literal("resume"), runId }).strict(),
  z.object({ action: z.literal("experience"), courseId: runId }).strict()
]);

