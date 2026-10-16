"use client";

import { useState } from "react";

export function MockReplyForm() {
  const [submitted, setSubmitted] = useState(false);

  return (
    <div className="rounded-lg border border-stone-300 bg-white p-5">
      <h2 className="text-lg font-semibold text-ink">发表回复</h2>
      <textarea
        data-testid="reply-editor"
        className="mt-3 min-h-36 w-full resize-y rounded-md border border-stone-300 p-3 text-sm outline-none focus:border-ocean"
        placeholder="写下你的学习回应..."
      />
      <button
        data-testid="reply-submit"
        type="button"
        onClick={() => setSubmitted(true)}
        className="mt-3 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-ocean"
      >
        模拟提交
      </button>
      {submitted ? (
        <p data-testid="reply-success" className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          已完成表单模拟；正式的 Mock 发布与数据库回写请使用开发实验室中的发布流程。
        </p>
      ) : null}
    </div>
  );
}
