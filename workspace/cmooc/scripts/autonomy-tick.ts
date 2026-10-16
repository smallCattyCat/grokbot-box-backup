import { prisma } from "@/lib/db";
import {
  AutonomyTickError,
  runAutonomyTick
} from "@/lib/autonomy/tick";

type CliArgs = {
  courseAlias: string;
  mode?: string;
  scheduledFor?: string;
};

function parseArgs(argv: string[]): CliArgs {
  let courseAlias = "";
  let mode: string | undefined;
  let scheduledFor: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--course") {
      courseAlias = argv[index + 1]?.trim() ?? "";
      index += 1;
      continue;
    }
    if (arg === "--mode") {
      mode = argv[index + 1]?.trim();
      index += 1;
      continue;
    }
    if (arg === "--scheduled-for") {
      scheduledFor = argv[index + 1]?.trim();
      index += 1;
      continue;
    }
    throw new Error("AUTONOMY_TICK_UNKNOWN_ARGUMENT");
  }
  if (!courseAlias) {
    throw new Error("AUTONOMY_TICK_COURSE_REQUIRED");
  }
  return { courseAlias, mode, scheduledFor };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runAutonomyTick(
    {
      courseAlias: args.courseAlias,
      requestedMode: args.mode,
      scheduledFor: args.scheduledFor
    },
    { prisma }
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main()
  .catch((error) => {
    const payload =
      error instanceof AutonomyTickError
        ? {
            ok: false,
            code: error.code,
            evidenceHash: error.evidenceHash,
            containsForumText: false
          }
        : {
            ok: false,
            code: "autonomy_tick_failed",
            containsForumText: false
          };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
