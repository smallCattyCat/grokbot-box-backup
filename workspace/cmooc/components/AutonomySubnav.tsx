"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  ["/autonomy/governance", "运行治理"],
  ["/autonomy/policy", "策略边界"],
  ["/platform", "社区接入"],
  ["/scenario-lab", "研究实验"]
] as const;

export function AutonomySubnav() {
  const pathname = usePathname();
  const governanceContext =
    pathname.startsWith("/autonomy/policy") ||
    pathname.startsWith("/autonomy/governance") ||
    pathname.startsWith("/platform") ||
    pathname.startsWith("/scenario-lab");

  if (!governanceContext) return null;

  return (
    <nav
      aria-label="治理视图"
      className="autonomy-subnav"
    >
      {items.map(([href, label]) => {
        const active =
          pathname === href ||
          pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={active ? "subnav-active" : undefined}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
