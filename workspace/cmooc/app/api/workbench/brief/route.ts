import { createBriefRouteHandler } from "@/lib/workbench/brief-route-handler";
import { getAnchoredCourseOpportunityBrief } from "@/lib/workbench/operator-read-model";

export const dynamic = "force-dynamic";

export const GET = createBriefRouteHandler({
  readBrief: getAnchoredCourseOpportunityBrief
});
