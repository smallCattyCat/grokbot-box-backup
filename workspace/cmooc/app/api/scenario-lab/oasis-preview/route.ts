import { runOasisPreview } from "@/lib/scenario-lab/oasis-preview";
import { createScenarioLabOasisPreviewRouteHandler } from "@/lib/workbench/scenario-lab-oasis-preview-route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = createScenarioLabOasisPreviewRouteHandler({
  runPreview: runOasisPreview
});
