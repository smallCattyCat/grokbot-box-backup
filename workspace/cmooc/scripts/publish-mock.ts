import { publishQueuedIntervention } from "@/lib/workflow";
import { prisma } from "@/lib/db";

async function main() {
  const explicitTaskId = process.argv[2];
  const task =
    explicitTaskId !== undefined
      ? await prisma.interventionTask.findFirstOrThrow({
          where: { id: explicitTaskId, post: { url: { startsWith: "/mock-forum" } } }
        })
      : await prisma.interventionTask.findFirstOrThrow({
          where: { status: "ready", post: { url: { startsWith: "/mock-forum" } } },
          orderBy: { priorityScore: "desc" }
        });
  const result = await publishQueuedIntervention(task.id, process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");
  console.log(`发布完成：${result.status} ${result.publishedUrl ?? result.errorMessage ?? ""}`);
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
