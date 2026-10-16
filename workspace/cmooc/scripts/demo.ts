import { scanAndAnalyzeForum, runFullAgentPipelineForPost } from "@/lib/workflow";
import { prisma } from "@/lib/db";

async function main() {
  const { tasks } = await scanAndAnalyzeForum();
  for (const task of tasks.slice(0, 5)) {
    await runFullAgentPipelineForPost(task.postId);
  }
  console.log("演示预览已完成：扫描、分析、生成回复和安全校验。启动 npm run dev 后可在 /review 审阅。");
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
