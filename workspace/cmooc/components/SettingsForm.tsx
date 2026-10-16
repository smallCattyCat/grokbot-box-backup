"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ForumSettingsInput } from "@/lib/settings";

type SettingsFormProps = {
  initial: ForumSettingsInput;
  realWriteLocked?: boolean;
};

type TextFieldName = Exclude<keyof ForumSettingsInput, "realPublishEnabled">;

const basicFields: Array<{ name: TextFieldName; label: string; placeholder: string; help: string }> = [
  {
    name: "forumBaseUrl",
    label: "社区入口",
    placeholder: "https://community.example/course",
    help: "当前连接器执行只读巡检时使用的课程社区入口。"
  },
  {
    name: "loginUrl",
    label: "登录页面",
    placeholder: "https://community.example/login",
    help: "为当前连接器建立本机登录状态时打开的页面。"
  }
];

const adapterFields: Array<{ name: TextFieldName; label: string; placeholder: string; help: string }> = [
  {
    name: "postUrlPattern",
    label: "帖子链接规则",
    placeholder: "https://community.example/thread/{threadId}",
    help: "只在当前连接器无法自动解析讨论链接时修改。"
  },
  {
    name: "replyEditorSelector",
    label: "回复输入框定位",
    placeholder: "textarea[name='content']",
    help: "论坛页面结构变化时用于重新适配。"
  },
  {
    name: "replySubmitSelector",
    label: "发布按钮定位",
    placeholder: "button[type='submit']",
    help: "论坛页面结构变化时用于重新适配。"
  }
];

export function SettingsForm({
  initial,
  realWriteLocked = false
}: SettingsFormProps) {
  const router = useRouter();
  const [form, setForm] = useState<ForumSettingsInput>(initial);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();

  function updateField(name: TextFieldName, value: string) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  function updateRealPublishEnabled(value: boolean) {
    setForm((current) => ({ ...current, realPublishEnabled: value }));
  }

  function save() {
    startTransition(async () => {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
      setMessage(response.ok ? "连接设置已保存。" : "保存失败，请检查字段后重试。");
      router.refresh();
    });
  }

  return (
    <div className="glass-card p-5 sm:p-6">
      <div className="grid gap-4">
        {basicFields.map((field) => (
          <label key={field.name} className="block">
            <span className="text-sm font-semibold text-slate-100">{field.label}</span>
            <input
              value={form[field.name]}
              onChange={(event) => updateField(field.name, event.target.value)}
              placeholder={field.placeholder}
              className="mt-2 min-h-11 w-full rounded-md border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/40"
            />
            <span className="mt-1 block text-xs leading-5 text-slate-400">{field.help}</span>
          </label>
        ))}
        <label className="flex items-start gap-3 rounded-md border border-emerald-900/70 bg-emerald-950/20 p-4">
          <input
            type="checkbox"
            checked={form.realPublishEnabled}
            disabled={realWriteLocked}
            onChange={(event) => updateRealPublishEnabled(event.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-semibold text-slate-100">允许向课程社区发布</span>
            <span className="mt-1 block text-xs leading-5 text-slate-400">
              {realWriteLocked
                ? "当前交付环境保持代码级写入硬锁；此开关不可开启。"
                : "这是全局紧急开关。开启后仍需在审阅页逐条批准，运行中心不会直接发布。"}
            </span>
          </span>
        </label>
        <details className="rounded-md border border-slate-700 bg-slate-950/25">
          <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-semibold text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400">
            高级连接器适配
          </summary>
          <div className="grid gap-4 border-t border-slate-700 p-4">
            <p className="text-xs leading-5 text-slate-400">
              这些字段属于当前浏览器连接器的页面映射；新社区应由连接器包提供默认值，日常运行无需修改。
            </p>
            {adapterFields.map((field) => (
              <label key={field.name} className="block">
                <span className="text-sm font-semibold text-slate-100">{field.label}</span>
                <input
                  value={form[field.name]}
                  onChange={(event) => updateField(field.name, event.target.value)}
                  placeholder={field.placeholder}
                  className="mt-2 min-h-11 w-full rounded-md border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/40"
                />
                <span className="mt-1 block text-xs leading-5 text-slate-400">{field.help}</span>
              </label>
            ))}
          </div>
        </details>
      </div>
      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="min-h-11 rounded-md border border-cyan-700 bg-cyan-950/60 px-4 py-2 text-sm font-semibold text-cyan-100 hover:border-cyan-400 hover:bg-cyan-900/50 disabled:cursor-wait disabled:opacity-60"
        >
          {pending ? "保存中..." : "保存连接设置"}
        </button>
        {message ? <span className="text-sm text-slate-300" role="status">{message}</span> : null}
      </div>
    </div>
  );
}
