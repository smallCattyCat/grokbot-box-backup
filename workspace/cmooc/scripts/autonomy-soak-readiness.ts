import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AutonomySoakReadinessReceipt,
  AutonomySoakReadinessStatus
} from "../lib/autonomy/soak-readiness";

export type AutonomySoakReadinessCliExitCode = 0 | 1 | 2;

type AutonomySoakReadinessCliDependencies = {
  loadReadiness: () => Promise<AutonomySoakReadinessReceipt>;
  write: (text: string) => void;
};

export function autonomySoakReadinessExitCode(
  status: AutonomySoakReadinessStatus
): AutonomySoakReadinessCliExitCode {
  if (status === "qualified") return 0;
  if (status === "unknown" || status === "qualifying") return 2;
  return 1;
}

export async function runAutonomySoakReadinessCli(
  dependencies: AutonomySoakReadinessCliDependencies
): Promise<AutonomySoakReadinessCliExitCode> {
  try {
    const readiness = await dependencies.loadReadiness();
    dependencies.write(`${JSON.stringify(readiness)}\n`);
    return autonomySoakReadinessExitCode(readiness.status);
  } catch {
    dependencies.write(
      `${JSON.stringify({
        schemaVersion: "cmooc.autonomy-soak-readiness-cli-error.v1",
        status: "error",
        code: "autonomy_soak_readiness_unavailable",
        externalMutationAttempted: false,
        containsForumText: false
      })}\n`
    );
    return 1;
  }
}

async function main(): Promise<void> {
  const [{ prisma }, { getAutonomyRuntimeHealth }] = await Promise.all([
    import("../lib/db"),
    import("../lib/autonomy/runtime-health")
  ]);
  try {
    process.exitCode = await runAutonomySoakReadinessCli({
      loadReadiness: async () => {
        const health = await getAutonomyRuntimeHealth({
          prisma,
          now: new Date()
        });
        return health.soakReadiness;
      },
      write: (text) => process.stdout.write(text)
    });
  } finally {
    await prisma.$disconnect();
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (entryPath === modulePath) {
  void main().catch(() => {
    process.exitCode = 1;
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: "cmooc.autonomy-soak-readiness-cli-error.v1",
        status: "error",
        code: "autonomy_soak_readiness_unavailable",
        externalMutationAttempted: false,
        containsForumText: false
      })}\n`
    );
  });
}
