import Link from "next/link";

export default function NotFound() {
  return (
    <section className="command-shell" aria-labelledby="not-found-title">
      <p className="command-context">未找到本地回执</p>
      <h1 id="not-found-title" className="mt-2">
        这个页面或运行证据不存在
      </h1>
      <p className="command-description">
        链接可能已经过期，或该运行不属于当前保存项目。系统没有回退到其他课程或运行。
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-md border border-cyan-300/60 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-50"
        >
          返回课程全景
        </Link>
        <Link
          href="/autonomy/decisions"
          className="inline-flex min-h-11 items-center rounded-md border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-100"
        >
          查看最近自主决定
        </Link>
      </div>
    </section>
  );
}
