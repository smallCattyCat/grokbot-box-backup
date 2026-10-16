import { loadCourseManifest } from "@/lib/autonomy/course-manifest";
import { prisma } from "@/lib/db";

const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const COURSE_NAME_MAX_LENGTH = 160;

export function selectVerifiedOperatorCourseName(input: {
  alias: string;
  manifestHash: string;
  expectedManifestHash: string;
  displayName: string | null | undefined;
}): string | null {
  const alias = input.alias.trim();
  const name = input.displayName?.replace(/\s+/gu, " ").trim() ?? "";
  const normalizedAlias = alias.toLocaleLowerCase("zh-CN");
  const normalizedName = name.toLocaleLowerCase("zh-CN");
  if (
    !alias ||
    !HASH_PATTERN.test(input.manifestHash) ||
    input.manifestHash !== input.expectedManifestHash ||
    !name ||
    name.length > COURSE_NAME_MAX_LENGTH ||
    normalizedName === normalizedAlias ||
    normalizedName.includes(normalizedAlias)
  ) {
    return null;
  }
  return name;
}

/**
 * Resolve names only from the exact local manifest binding. Hashes, aliases,
 * URL prefixes and "the only Course row" are deliberately not used as joins.
 */
export async function loadVerifiedOperatorCourseNames(
  aliases?: readonly string[]
): Promise<Map<string, string>> {
  const rows = await prisma.autonomyCourseManifest.findMany({
    where: {
      enabled: true,
      ...(aliases?.length ? { alias: { in: [...aliases] } } : {})
    },
    select: { alias: true, manifestHash: true }
  });
  const resolved = await Promise.all(
    rows.map(async (row) => {
      try {
        const manifest = await loadCourseManifest(row.alias);
        const course = await prisma.course.findUnique({
          where: { platformCourseId: manifest.courseId },
          select: { name: true, status: true }
        });
        const displayName = selectVerifiedOperatorCourseName({
          alias: row.alias,
          manifestHash: manifest.manifestHash,
          expectedManifestHash: row.manifestHash,
          displayName: course?.status === "active" ? course.name : null
        });
        return displayName ? ([row.alias, displayName] as const) : null;
      } catch {
        return null;
      }
    })
  );
  return new Map(
    resolved.filter(
      (item): item is readonly [string, string] => item !== null
    )
  );
}
