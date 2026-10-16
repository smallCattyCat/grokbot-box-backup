import { getCmoocAuthStatus } from "@/lib/forum/cmooc-auth-status";
import { prisma } from "@/lib/db";

async function main() {
  const status = await getCmoocAuthStatus();
  console.log(JSON.stringify(status, null, 2));
  if (!status.readyForRealForumWrite) process.exitCode = 1;
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
