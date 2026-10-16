import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { CommandShell } from "@/components/ui/command-shell";
import { CockpitMetricCard } from "@/components/ui/metric-card";
import { GlassCard } from "@/components/ui/glass-card";
import { StatusPill } from "@/components/ui/status-pill";

export const dynamic = "force-dynamic";

export default async function MockPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const mockPostWhere = { url: { startsWith: "/mock-forum" } };
  const [postCount, companionReplies] = await Promise.all([
    prisma.forumPost.count({ where: mockPostWhere }),
    prisma.forumReply.count({ where: { isCompanionReply: true, post: mockPostWhere } })
  ]);

  return (
    <div className="fade-in space-y-6">
      <CommandShell
        title="开发实验室"
        description="本地论坛、模拟发布和自动化表单验证都集中在这里。该页面只用于开发调试，不会触发真实论坛发布。"
        status={<StatusPill label="仅本地运行" tone="emerald" />}
      />

      <section className="grid gap-4 md:grid-cols-3">
        <CockpitMetricCard label="本地帖子" value={postCount} hint="模拟论坛样例" tone="amber" />
        <CockpitMetricCard label="学伴回复" value={companionReplies} hint="本地发布验证结果" tone="emerald" />
        <CockpitMetricCard label="运行边界" value="Local" hint="不会写入真实论坛" tone="cyan" />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Link href="/mock-forum" className="glass-card block p-5 hover:border-amber">
          <h2 className="text-lg font-semibold text-slate-50">打开本地论坛</h2>
          <p className="mt-2 text-sm leading-6 text-slate-300">查看样例帖子、回复表单和本地自动化发布页面。</p>
        </Link>
        <GlassCard>
          <h2 className="text-lg font-semibold text-slate-50">开发说明</h2>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            命令行和选择器调试不再出现在普通运行流程中，需要排查自动化适配时再从这里进入。
          </p>
        </GlassCard>
      </section>
    </div>
  );
}
