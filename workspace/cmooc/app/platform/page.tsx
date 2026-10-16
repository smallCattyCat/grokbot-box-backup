import Link from "next/link";
import {
  ArrowsLeftRight,
  CheckCircle,
  Circle,
  Palette,
  PlugsConnected,
  ShieldCheck
} from "@phosphor-icons/react/dist/ssr";
import { AutonomySubnav } from "@/components/AutonomySubnav";
import { PlatformReadinessPanel } from "@/components/PlatformReadinessPanel";
import { CommandShell } from "@/components/ui/command-shell";
import { GlassCard } from "@/components/ui/glass-card";
import { StatusPill } from "@/components/ui/status-pill";
import { resolveProductProfile } from "@/lib/product-profile";

export const dynamic = "force-dynamic";

export default function PlatformPage() {
  const profile = resolveProductProfile();
  const readiness = [
    {
      icon: Palette,
      step: "01",
      title: "品牌外观",
      state: "可配置",
      body: `${profile.productName} 的公开名称、短名称与运营方标签可按单客户部署切换。`,
      ready: true
    },
    {
      icon: ShieldCheck,
      step: "02",
      title: "课程绑定",
      state: "精确绑定",
      body: "课程引用、规范地址、允许来源和适配器进入同一份可校验清单。",
      ready: true
    },
    {
      icon: PlugsConnected,
      step: "03",
      title: "观察连接器",
      state: "工厂就绪",
      body: "运行时按平台与适配器选择观察器；未注册或错配时拒绝运行。",
      ready: true
    },
    {
      icon: ArrowsLeftRight,
      step: "04",
      title: "目标社区联调",
      state: "待目标环境",
      body: "仍需使用目标社区的只读 API、认证方式和页面结构完成连接器验收。",
      ready: false
    }
  ] as const;

  return (
    <div className="fade-in space-y-6">
      <CommandShell
        variant="operational"
        eyebrow="社区接入 · 单客户部署"
        title="把课程智能内核接到新的学习社区"
        description="品牌、课程清单、平台连接器与运行权限分层配置。迁移不会改写课程研判内核，也不会把接入成功等同于获得平台写入授权。"
        status={
          <>
            <StatusPill label="白标入口已就绪" tone="cyan" />
            <StatusPill label="连接器错配即拒绝" tone="violet" />
            <StatusPill label="平台写入 0" tone="emerald" />
          </>
        }
        actions={<AutonomySubnav />}
      />

      <section
        className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"
        aria-label="社区迁移准备度"
      >
        {readiness.map((item) => {
          const ItemIcon = item.icon;
          return (
            <GlassCard
              key={item.step}
              tone={item.ready ? "success" : "warning"}
              className="p-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2 text-cyan-200">
                  <ItemIcon size={22} weight="duotone" aria-hidden="true" />
                  <span className="font-mono text-xs tracking-[0.14em]">
                    {item.step}
                  </span>
                </div>
                <span className="inline-flex items-center gap-1 text-xs text-slate-300">
                  {item.ready ? (
                    <CheckCircle size={15} weight="fill" className="text-emerald-300" aria-hidden="true" />
                  ) : (
                    <Circle size={15} className="text-amber-300" aria-hidden="true" />
                  )}
                  {item.state}
                </span>
              </div>
              <h2 className="mt-4 text-base font-semibold text-slate-50">
                {item.title}
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-300">
                {item.body}
              </p>
            </GlassCard>
          );
        })}
      </section>

      <GlassCard className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">
              Connector delivery path
            </p>
            <h2 className="mt-2 text-lg font-semibold text-slate-50">
              首次迁移按“只读观察 → 影子研判 → 暂存回读”推进
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
              先验证课程、成员、讨论与回复的完整读取，再接入调度和研判。只有目标平台提供可核验的编辑器回读与清除能力后，才评估暂存；真实提交不属于本页接入检查。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/settings"
              className="inline-flex min-h-11 items-center rounded-md border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-cyan-400 hover:text-cyan-100"
            >
              打开高级连接设置
            </Link>
            <Link
              href="/review/live"
              className="inline-flex min-h-11 items-center rounded-md border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-cyan-400 hover:text-cyan-100"
            >
              查看长期运行审核
            </Link>
          </div>
        </div>
      </GlassCard>

      <details className="glass-card group overflow-hidden" open>
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 text-sm font-semibold text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400">
          当前 cMOOC 连接器只读诊断
          <span className="text-xs font-normal text-slate-400 group-open:hidden">
            展开检查
          </span>
          <span className="hidden text-xs font-normal text-slate-400 group-open:inline">
            收起检查
          </span>
        </summary>
        <div className="border-t border-slate-800 p-4 sm:p-5">
          <PlatformReadinessPanel />
        </div>
      </details>
    </div>
  );
}
