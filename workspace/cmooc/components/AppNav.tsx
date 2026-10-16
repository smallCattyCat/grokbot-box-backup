"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type AppNavProps = {
  items: Array<{
    href: string;
    label: string;
    matchPrefixes?: string[];
  }>;
};

export function AppNav({ items }: AppNavProps) {
  const pathname = usePathname();

  return (
    <nav
      className="app-nav"
      data-testid="app-nav"
      data-current-path={pathname}
      aria-label="主导航"
    >
      {items.map(({ href, label, matchPrefixes = [] }) => {
        const active =
          pathname === href ||
          (href !== "/" && pathname.startsWith(`${href}/`)) ||
          matchPrefixes.some(
            (prefix) =>
              pathname === prefix ||
              pathname.startsWith(`${prefix}/`)
          );
        return (
          <Link
            key={href}
            href={href}
            data-testid={`nav-${href.replaceAll("/", "-").replace(/^-/, "") || "home"}`}
            data-active={active}
            aria-current={active ? "page" : undefined}
            className={active ? "nav-active" : undefined}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
