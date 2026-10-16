import { createScenarioLabRouteHandler } from "@/lib/workbench/scenario-lab-route-handler";
import { runScenarioLab } from "@/lib/scenario-lab/scenario-lab";

export const dynamic = "force-dynamic";

export const POST = createScenarioLabRouteHandler({
  runScenario: runScenarioLab
});
