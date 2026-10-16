const DEFAULT_FORUM_ORIGIN = "https://cmooc.bnu.edu.cn";
const SENSITIVE_QUERY_MARKERS = [
  "token",
  "auth",
  "authorization",
  "cookie",
  "session",
  "password",
  "secret",
  "credential",
  "jwt"
] as const;

function configuredOrigins() {
  const configured = (process.env.CMOOC_ALLOWED_FORUM_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" ? [parsed.origin] : [];
      } catch {
        return [];
      }
    });
  return new Set([DEFAULT_FORUM_ORIGIN, ...configured]);
}

export function assertAllowedForumUrl(
  value: string,
  label = "论坛地址"
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label}不是有效的绝对 URL。`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${label}必须是无内嵌凭据的 HTTPS 地址。`);
  }
  if (!configuredOrigins().has(url.origin)) {
    throw new Error(
      `${label}不属于允许的 cMOOC 来源；额外可信来源必须通过 CMOOC_ALLOWED_FORUM_ORIGINS 显式配置。`
    );
  }
  if (
    url.origin === DEFAULT_FORUM_ORIGIN &&
    !/^\/cMOOC(?:\/|$)/i.test(url.pathname)
  ) {
    throw new Error(`${label}不属于 cMOOC 论坛页面路径。`);
  }
  for (const key of url.searchParams.keys()) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
    if (
      SENSITIVE_QUERY_MARKERS.some((marker) =>
        normalizedKey.includes(marker)
      )
    ) {
      throw new Error("CMOOC_SENSITIVE_QUERY_FORBIDDEN");
    }
  }
  url.hash = "";
  return url.toString();
}
