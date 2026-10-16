import { getAnchoredCourseEvidenceWorkspace } from "@/lib/workbench/evidence-read-model";
import { createResearchExportRouteHandler } from "@/lib/workbench/research-export-route-handler";

export const dynamic = "force-dynamic";

export const GET = createResearchExportRouteHandler({
  readWorkspace: getAnchoredCourseEvidenceWorkspace
});
