import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { CommandShell } from "@/components/ui/command-shell";
import { GlassCard } from "@/components/ui/glass-card";
import { StatusPill } from "@/components/ui/status-pill";

export const dynamic = "force-dynamic";

export default async function MockForumPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const posts = await prisma.forumPost.findMany({
    where: { url: { startsWith: "/mock-forum" } },
    include: { author: true },
    orderBy: { createdAt: "desc" }
  });

  return (
    <div className="fade-in space-y-6">
      <CommandShell
        eyebrow="Mock 实验室"
        title="Mock cMOOC 论坛"
        description="本地可控论坛页面，只用于开发调试和 mock 发布验证，不参与 real 虚拟论坛主流程。"
        actions={<Link href="/mock" className="rounded-md border border-amber-300/50 px-3 py-2 text-sm font-semibold text-amber-200 hover:border-amber-200">返回开发实验室</Link>}
        status={<StatusPill label={`Posts ${posts.length}`} tone="amber" />}
      />

      <div className="space-y-3">
        {posts.map((post) => (
          <Link key={post.id} href={`/mock-forum/posts/${post.id}`} className="glass-card block p-4 hover:border-cyan-300/40">
            <h2 className="text-lg font-semibold text-slate-50">{post.title}</h2>
            <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-300">{post.content}</p>
            <div className="mt-3 text-xs text-slate-500">
              {post.author.name} · {formatDate(post.createdAt)} · 回复 {post.replyCount} · 点赞 {post.likeCount}
            </div>
          </Link>
        ))}
        {posts.length === 0 ? (
          <GlassCard>
            <p className="text-sm text-slate-400">暂无 Mock 帖子。请先运行 npm run prisma:seed。</p>
          </GlassCard>
        ) : null}
      </div>
    </div>
  );
}
