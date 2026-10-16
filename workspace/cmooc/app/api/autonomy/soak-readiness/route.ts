import { getAutonomyRuntimeHealth } from "@/lib/autonomy/runtime-health";
import { prisma } from "@/lib/db";
import { createAutonomySoakReadinessRouteHandler } from "./route-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handleGet = createAutonomySoakReadinessRouteHandler({
  loadReadiness: async () => {
    const health = await getAutonomyRuntimeHealth({
      prisma,
      now: new Date()
    });
    return health.soakReadiness;
  }
});

export async function GET() {
  return handleGet();
}
