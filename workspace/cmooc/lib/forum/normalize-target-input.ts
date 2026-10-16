import { assertAllowedForumUrl } from "@/lib/forum/allowed-url";

export type ForumTargetNormalizationSource =
  | "exact_url"
  | "markdown_link"
  | "embedded_url"
  | "course_id_recovery";

export type NormalizedForumTarget = {
  url: string;
  source: ForumTargetNormalizationSource;
  inputWasNormalized: boolean;
};

const COURSE_ID_PATTERN = /^\d{8,127}$/;
const HTTPS_START_PATTERN = /https:\/\//gi;

function markdownLinkTargets(value: string): string[] {
  const targets: string[] = [];
  const pattern = /\]\(\s*(https:\/\/[^)\s]+)\s*\)/gi;
  for (const match of value.matchAll(pattern)) {
    if (match[1]) targets.push(match[1]);
  }
  return targets;
}

function embeddedHttpsTargets(value: string): string[] {
  const targets: string[] = [];
  for (const match of value.matchAll(HTTPS_START_PATTERN)) {
    const start = match.index;
    if (start === undefined) continue;
    const remainder = value.slice(start);
    const end = remainder.search(/[\s<>"']/);
    const candidate = (end === -1 ? remainder : remainder.slice(0, end))
      .replace(/[)\]},;，。；]+$/u, "")
      .trim();
    if (candidate) targets.push(candidate);
  }
  return targets;
}

function recoveredCourseTarget(value: string): string | null {
  const courseId = value.match(/(?:[?&]|\b)courseId=(\d{8,127})/i)?.[1];
  if (
    !courseId ||
    !COURSE_ID_PATTERN.test(courseId) ||
    !/\/cMOOC\/course/i.test(value)
  ) {
    return null;
  }

  for (const candidate of embeddedHttpsTargets(value)) {
    try {
      const parsed = new URL(candidate);
      const recovered =
        `${parsed.origin}/cMOOC/course?courseId=${courseId}&isBack=1`;
      return assertAllowedForumUrl(recovered, "课程地址");
    } catch {
      // Continue until a recoverable cMOOC origin is found.
    }
  }
  return null;
}

function isCourseTarget(url: string): boolean {
  const parsed = new URL(url);
  const courseId = parsed.searchParams.get("courseId");
  return (
    /^\/cMOOC\/course\/?$/i.test(parsed.pathname) &&
    courseId !== null &&
    COURSE_ID_PATTERN.test(courseId)
  );
}

/**
 * Accepts copied browser addresses and Markdown-style links without weakening
 * the strict URL boundary used by collection and publishing code.
 */
export function normalizeCmoocCourseTargetInput(
  value: string,
  label = "课程地址"
): NormalizedForumTarget {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label}不能为空。`);
  }

  const candidates: Array<{
    value: string;
    source: ForumTargetNormalizationSource;
  }> = [
    ...markdownLinkTargets(trimmed).map((candidate) => ({
      value: candidate,
      source: "markdown_link" as const
    })),
    { value: trimmed, source: "exact_url" as const },
    ...embeddedHttpsTargets(trimmed).map((candidate) => ({
      value: candidate,
      source: "embedded_url" as const
    }))
  ];
  const recovered = recoveredCourseTarget(trimmed);
  if (recovered) {
    candidates.push({
      value: recovered,
      source: "course_id_recovery"
    });
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.value)) continue;
    seen.add(candidate.value);
    try {
      const url = assertAllowedForumUrl(candidate.value, label);
      if (!isCourseTarget(url)) continue;
      return {
        url,
        source: candidate.source,
        inputWasNormalized:
          candidate.source !== "exact_url" || url !== trimmed
      };
    } catch {
      // Try the next independently validated candidate.
    }
  }

  throw new Error(
    `${label}中未找到可验证的 cMOOC 课程链接；请包含 HTTPS 地址和 courseId。`
  );
}
