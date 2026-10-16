export type DefaultWorkbenchCourseContext = Readonly<{
  ref: string;
  title: string;
  sourceHref: string;
}>;

type OperatorWithCourseAnchor = Readonly<{
  courseName?: string | null;
  brief?: Readonly<{
    anchor?: Readonly<{
      courseAlias: string;
      courseName: string;
      snapshotId: string;
    }> | null;
  }> | null;
}>;

const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const COURSE_ALIAS = /^[a-z0-9][a-z0-9-]{0,62}$/u;

/**
 * The idle console is a course product, so its default task context must be
 * the latest immutable course snapshot rather than an unbound aggregate
 * label. The operator can still remove this attachment explicitly.
 */
export function defaultCourseContext(
  operator: OperatorWithCourseAnchor
): DefaultWorkbenchCourseContext | null {
  const anchor = operator.brief?.anchor ?? null;
  if (
    !anchor ||
    !COURSE_ALIAS.test(anchor.courseAlias) ||
    !SAFE_ID.test(anchor.snapshotId)
  ) {
    return null;
  }
  const courseName =
    anchor.courseName.trim() || operator.courseName?.trim() || "当前课程";
  return Object.freeze({
    ref: `snapshot:${anchor.snapshotId}`,
    title: `${courseName} · 最新课程快照`,
    sourceHref: `/autonomy/world?course=${encodeURIComponent(anchor.courseAlias)}&snapshot=${encodeURIComponent(anchor.snapshotId)}`
  });
}
