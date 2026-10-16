import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { MockReplyForm } from "@/components/MockReplyForm";
import { CommandShell } from "@/components/ui/command-shell";
import { GlassCard } from "@/components/ui/glass-card";
import { StatusPill } from "@/components/ui/status-pill";

export const dynamic = "force-dynamic";

export default async function MockForumPostPage({ params }: { params: { id: string } }) {
  if (process.env.NODE_ENV === "production") notFound();
  const post = await prisma.forumPost.findFirst({
    where: { url: { startsWith: "/mock-forum" }, OR: [{ id: params.id }, { forumPostId: params.id }] },
    include: {
      author: true,
      replies: { include: { author: true }, orderBy: { createdAt: "asc" } }
    }
  });
  if (!post) notFound();

  return (
    <div className="mx-auto max-w-4xl fade-in space-y-6">
      <CommandShell
        eyebrow="Mock Post"
        title={post.title}
        description={`${post.author.name} · ${formatDate(post.createdAt)}`}
        actions={<Link href="/mock-forum" className="rounded-md border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-300 hover:border-cyan-300 hover:text-cyan-200">返回 Mock 论坛</Link>}
        status={<StatusPill label={`Replies ${post.replies.length}`} tone="amber" />}
      />

      <GlassCard>
        <p data-testid="post-content" className="whitespace-pre-wrap leading-7 text-slate-300">{post.content}</p>
      </GlassCard>

      <GlassCard>
        <h2 className="text-lg font-semibold text-slate-50">回复</h2>
        <div className="mt-4 space-y-3">
          {post.replies.map((reply) => (
            <div key={reply.id} className="rounded-md border border-slate-700/50 bg-slate-950/30 p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-100">
                {reply.author.name}
                {reply.isCompanionReply ? <StatusPill label="学伴" tone="cyan" /> : null}
                <span className="font-normal text-slate-500">{formatDate(reply.createdAt)}</span>
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-300">{reply.content}</p>
            </div>
          ))}
          {post.replies.length === 0 ? <p className="text-sm text-slate-500">暂无回复。</p> : null}
        </div>
      </GlassCard>

      <MockReplyForm />
    </div>
  );
}
