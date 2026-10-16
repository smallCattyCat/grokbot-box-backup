import type { Metadata } from "next";
import Link from "next/link";
import { Graph } from "@phosphor-icons/react/dist/ssr/Graph";
import { AppNav } from "@/components/AppNav";
import { AgentSessionProvider } from "@/components/agent/AgentSessionProvider";
import { resolveProductProfile } from "@/lib/product-profile";
import "./globals.css";

const productProfile = resolveProductProfile();

export const metadata: Metadata = {
  title: productProfile.productName,
  description: productProfile.productDescription
};

const navItems = [
  { href: "/workbench", label: "工作台" },
  { href: "/autonomy/world", label: "课程世界" },
  {
    href: "/autonomy/decisions",
    label: "运行记录",
    matchPrefixes: ["/autonomy/runs"]
  },
  { href: "/autonomy/outcomes", label: "结果观察" },
  {
    href: "/autonomy/governance",
    label: "治理",
    matchPrefixes: [
      "/autonomy/policy",
      "/platform",
      "/review/live",
      "/evidence",
      "/settings"
    ]
  }
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AgentSessionProvider>
          <a className="skip-link" href="#main-content">
            跳到主要内容
          </a>
          <div className="app-shell min-h-[100dvh]">
            <header className="app-header sticky top-0 z-20">
              <div className="mx-auto flex max-w-[1440px] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <Link href="/" className="brand-lockup text-lg font-semibold text-ink">
                  <Graph className="brand-mark" size={22} weight="duotone" aria-hidden="true" />
                  <span>{productProfile.productName}</span>
                </Link>
                <AppNav items={navItems} />
              </div>
            </header>
            <main
              id="main-content"
              className="app-main mx-auto max-w-[1440px] px-4 py-5 sm:px-6 sm:py-7"
            >
              {children}
            </main>
          </div>
        </AgentSessionProvider>
      </body>
    </html>
  );
}
