import { createEvidenceRouteHandler } from "@/lib/workbench/evidence-route-handler";
import { getAnchoredCourseEvidenceWorkspace } from "@/lib/workbench/evidence-read-model";

export const dynamic = "force-dynamic";

export const GET = createEvidenceRouteHandler({
  readWorkspace: getAnchoredCourseEvidenceWorkspace
});
