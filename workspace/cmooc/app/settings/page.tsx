import { existsSync } from "node:fs";
import path from "node:path";
import { SettingsForm } from "@/components/SettingsForm";
import { CommandShell } from "@/components/ui/command-shell";
import { GlassCard } from "@/components/ui/glass-card";
import { StatusPill } from "@/components/ui/status-pill";
import { getLlmRuntimeStatus } from "@/lib/llm/client";
import { getForumSettings, validateRealForumSettings } from "@/lib/settings";
import { REAL_FORUM_WRITE_LOCKED } from "@/lib/forum/real-write-lock";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [settings, llmStatus] = await Promise.all([getForumSettings(), Promise.resolve(getLlmRuntimeStatus())]);
  const missing = validateRealForumSettings(settings);
  const hasAuthState = existsSync(path.join(process.cwd(), "playwright", "auth-state.json"));

  return (
    <div className="fade-in space-y-6">
      <CommandShell
        title="连接与安全设置"
        description="日常只需确认论坛入口、在线模型、登录状态和发布总开关。页面适配参数已折叠到高级设置中。"
        status={
          <>
            <StatusPill label={missing.length === 0 ? "论坛配置完整" : "论坛配置待补全"} tone={missing.length === 0 ? "emerald" : "amber"} />
            <StatusPill label={hasAuthState ? "登录状态已保存" : "登录状态缺失"} tone={hasAuthState ? "emerald" : "amber"} />
            <StatusPill label={REAL_FORUM_WRITE_LOCKED ? "发布硬锁已启用" : settings.realPublishEnabled ? "发布能力已开启" : "发布能力关闭"} tone={settings.realPublishEnabled ? "danger" : "muted"} />
          </>
        }
      />

      <section className="grid gap-4 lg:grid-cols-3">
        <GlassCard tone={missing.length === 0 ? "success" : "danger"}>
          <h2 className="text-lg font-semibold text-slate-50">论坛连接</h2>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            {missing.length === 0 ? "论坛入口和发布适配信息已经保存。" : `仍需补全：${missing.join("、")}。`}
          </p>
        </GlassCard>
        <GlassCard tone={llmStatus.mode === "real" ? "success" : "default"}>
          <h2 className="text-lg font-semibold text-slate-50">在线模型</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <StatusPill label={llmStatus.provider} tone="cyan" />
            <StatusPill label={llmStatus.model} tone="violet" />
            <StatusPill label={llmStatus.hasApiKey ? "凭据已配置" : "凭据缺失"} tone={llmStatus.hasApiKey ? "emerald" : "amber"} />
          </div>
        </GlassCard>
        <GlassCard tone={settings.realPublishEnabled ? "danger" : "success"}>
          <h2 className="text-lg font-semibold text-slate-50">发布总开关</h2>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            {REAL_FORUM_WRITE_LOCKED
              ? "开发与 PI 演示阶段由代码级硬锁拦截授权、路由和最终传输。"
              : settings.realPublishEnabled
              ? "论坛写入能力已开启，但每条内容仍须在审阅页单独批准。"
              : "论坛写入能力已关闭，系统仍可正常生成和审阅预览。"}
          </p>
        </GlassCard>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <SettingsForm
          realWriteLocked={REAL_FORUM_WRITE_LOCKED}
          initial={{
            forumBaseUrl: settings.forumBaseUrl,
            loginUrl: settings.loginUrl,
            postUrlPattern: settings.postUrlPattern,
            replyEditorSelector: settings.replyEditorSelector,
            replySubmitSelector: settings.replySubmitSelector,
            replySuccessSelector: settings.replySuccessSelector,
            realPublishEnabled: settings.realPublishEnabled
          }}
        />

        <div className="space-y-4">
          <GlassCard tone={hasAuthState ? "success" : "danger"}>
            <h2 className="text-lg font-semibold text-slate-50">浏览器登录状态</h2>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              {hasAuthState
                ? "已保存登录状态，系统可以在不保存密码的前提下访问论坛。"
                : "尚未保存登录状态。请运行登录状态保存流程，并在打开的浏览器中手动完成登录。"}
            </p>
          </GlassCard>
          <GlassCard>
            <h2 className="text-lg font-semibold text-slate-50">安全边界</h2>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              系统不会绕过验证码、登录限制或平台风控，也不会在项目中保存真实密码。
            </p>
          </GlassCard>
        </div>
      </section>
    </div>
  );
}
