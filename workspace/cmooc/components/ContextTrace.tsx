import type { AgentContextTrace } from "@/lib/agents/context-trace";

function show(value: string | number | null) {
  return value === null || value === "" ? "-" : String(value);
}

function metric(label: string, value: string | number | null) {
  return (
    <div className="flex justify-between gap-3 border-b border-slate-800/70 py-1 last:border-b-0">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right text-slate-200">{show(value)}</dd>
    </div>
  );
}

export function ContextTrace({ trace }: { trace: AgentContextTrace | null }) {
  if (!trace) {
    return <p className="mt-4 text-xs text-slate-500">尚无 O-I-E 上下文快照；生成草稿后会自动追加。</p>;
  }

  return (
    <details className="mt-5 rounded-md border border-cyan-400/20 bg-slate-950/35" data-testid="context-trace" data-context-revision={trace.revision}>
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-cyan-200">
        证据—推断—表达追溯 · revision {trace.revision} · {new Date(trace.asOfAt).toLocaleString("zh-CN")}
      </summary>
      <div className="border-t border-slate-800 p-4">
        <div className="mb-3 flex flex-wrap gap-2 text-[11px] text-slate-400">
          <span>O {trace.versions.observation}</span>
          <span>·</span>
          <span>I {trace.versions.inference}</span>
          <span>·</span>
          <span>E {trace.versions.expression}</span>
          <span>·</span>
          <span className={trace.futureInformationUsed ? "text-red-300" : "text-emerald-300"}>
            {trace.futureInformationUsed ? "检测到未来信息" : "未使用未来信息"}
          </span>
        </div>

        <div className="grid gap-3 xl:grid-cols-3">
          <section className="rounded-md border border-slate-800 bg-slate-950/45 p-3">
            <h3 className="text-sm font-semibold text-sky-200">Observation · 可见事实</h3>
            <dl className="mt-2 text-xs">
              {metric("来源", trace.observation.source)}
              {metric("观测时间", trace.observation.observedAt)}
              {metric("回复 / 点赞 / 浏览", `${show(trace.observation.post.replyCount)} / ${show(trace.observation.post.likeCount)} / ${show(trace.observation.post.viewCount)}`)}
              {metric("课程发帖 / 回复", trace.observation.learnerCourse ? `${show(trace.observation.learnerCourse.postCount)} / ${show(trace.observation.learnerCourse.replyCount)}` : null)}
              {metric("原文复制", trace.observation.rawPostContentCopied === false ? "否" : "未知")}
            </dl>
          </section>

          <section className="rounded-md border border-slate-800 bg-slate-950/45 p-3">
            <h3 className="text-sm font-semibold text-violet-200">Inference · 非诊断性假设</h3>
            <dl className="mt-2 text-xs">
              {metric("CIE", trace.inference.postSignals ? `${show(trace.inference.postSignals.cieLevel)} · ${show(trace.inference.postSignals.cieLabel)}` : null)}
              {metric("情绪标签", trace.inference.postSignals?.emotionLabel ?? null)}
              {metric("讨论潜力", trace.inference.postSignals?.discussionPotential ?? null)}
              {metric("孤立信号", trace.inference.postSignals?.isolatedLearnerScore ?? null)}
              {metric("稳定人格声明", trace.inference.stablePersonalityClaimed === false ? "否" : "未知")}
            </dl>
          </section>

          <section className="rounded-md border border-slate-800 bg-slate-950/45 p-3">
            <h3 className="text-sm font-semibold text-emerald-200">Expression · 外显策略</h3>
            <dl className="mt-2 text-xs">
              {metric("角色", trace.expression.companion.name)}
              {metric("语气", trace.expression.companion.tone)}
              {metric("本次焦点", trace.expression.regulation.focus)}
              {metric("角色边界", trace.expression.companion.roleBoundary)}
              {metric("持久人格改写", trace.expression.persistentAgentPersonalityMutated === false ? "否" : "未知")}
            </dl>
          </section>
        </div>
      </div>
    </details>
  );
}
