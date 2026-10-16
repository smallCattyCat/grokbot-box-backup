import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getBrowserWorkspace } from "./browser-course-store";
import { loadOrCreateLocalEvidenceSecret, localEvidenceHmac } from "@/lib/privacy/local-evidence-hmac";
import { canonicalBrowserCourseUrl } from "./browser-course-contracts";

/** Browser course selection is mapped by its exact locator and local identity key. */
export async function resolveExperienceCourse(prisma: PrismaClient, courseId: string) {
  const workspace = await getBrowserWorkspace();
  const course = workspace.courses.find(value => value.id === courseId);
  if (!course) throw new Error("EXPERIENCE_BROWSER_COURSE_MISSING");
  const secret = await loadOrCreateLocalEvidenceSecret();
  const canonicalLocatorHash = localEvidenceHmac({ secret, scope: "autonomy-manifest-locator-v1", value: canonicalBrowserCourseUrl(course.entryUrl), length: 64 });
  const matches = await prisma.autonomyCourseManifest.findMany({
    where: { canonicalLocatorHash, identityKeyFingerprint: createHash("sha256").update(secret).digest("hex"), enabled: true }, take: 2
  });
  if (matches.length !== 1 || matches[0].allowedOrigin !== new URL(course.entryUrl).origin) {
    throw new Error("EXPERIENCE_COURSE_NOT_BOUND");
  }
  return matches[0].alias;
}
