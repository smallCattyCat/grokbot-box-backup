"use client";

import Link from "next/link";

export default function AppError({
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section
      className="command-shell"
      role="alert"
      aria-labelledby="app-error-title"
    >
      <p className="command-context">只读界面暂时不可用</p>
      <h1 id="app-error-title" className="mt-2">
        课程运行数据未能载入
      </h1>
      <p className="command-description">
        页面没有执行任何外部写入。可以重新读取本地状态，或返回课程全景选择其他视图。
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-md border border-cyan-300/60 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-50"
        >
          重新载入
        </button>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-md border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-100"
        >
          返回课程全景
        </Link>
      </div>
    </section>
  );
}
