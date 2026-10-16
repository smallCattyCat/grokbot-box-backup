/**
 * Operator-facing presentation rules.
 *
 * The runtime must continue to accept every explicitly enabled manifest. This
 * module only shapes the read model used by operator pages: synthetic and
 * regression fixtures are not useful course choices for a human operator, so
 * they are filtered here rather than in the worker/execution path.
 */

export type OperatorCourseCandidate = {
  alias: string;
  label?: string | null;
  /** Name resolved from a trusted Course read-model relation, when present. */
  courseName?: string | null;
  enabled?: boolean | null;
  /** Optional provenance/flags supplied by a read model when available. */
  source?: string | null;
  synthetic?: boolean | null;
  regression?: boolean | null;
};

export type OperatorCourseVisibilityReason =
  | "visible"
  | "disabled_manifest"
  | "explicit_synthetic"
  | "explicit_regression"
  | "fixture_source"
  | "synthetic_alias"
  | "invalid_alias";

export type OperatorCourseVisibility = {
  visible: boolean;
  reason: OperatorCourseVisibilityReason;
};

const INTERNAL_AUTONOMY_ALIAS =
  /^(?:autonomy[-_](?:integration|test|fixture|mock|e2e|replay)(?:[-_]|$)|autonomy[-_]scan[-_]clock(?:[-_]|$)|autonomy[-_]semantic[-_]ledger(?:[-_]|$))/i;
const GENERIC_FIXTURE_ALIAS =
  /(?:^|[-_])(?:fixture|fixtures|synthetic|mock|e2e)(?:[-_]|$)/i;
const TEST_ALIAS_PREFIX =
  /^(?:test|tests|regression)(?:[-_]|$)/i;

function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase();
}

/**
 * A deliberately narrow fallback for older manifests that carry no explicit
 * presentation/provenance flag. `bnu-test` is intentionally not rejected:
 * it is the named read-only course used by the local operator environment.
 */
export function isSyntheticOperatorCourseAlias(alias: string): boolean {
  const normalized = normalizeAlias(alias);
  if (!normalized) return true;
  return (
    INTERNAL_AUTONOMY_ALIAS.test(normalized) ||
    GENERIC_FIXTURE_ALIAS.test(normalized) ||
    TEST_ALIAS_PREFIX.test(normalized) ||
    normalized === "integration"
  );
}

export function assessOperatorCourseVisibility(
  candidate: OperatorCourseCandidate
): OperatorCourseVisibility {
  const alias = normalizeAlias(candidate.alias);
  if (!alias) {
    return { visible: false, reason: "invalid_alias" };
  }
  if (candidate.enabled === false) {
    return { visible: false, reason: "disabled_manifest" };
  }
  if (candidate.synthetic === true) {
    return { visible: false, reason: "explicit_synthetic" };
  }
  if (candidate.regression === true) {
    return { visible: false, reason: "explicit_regression" };
  }

  const source = candidate.source?.trim().toLowerCase();
  if (
    source === "fixture" ||
    source === "fixtures" ||
    source === "synthetic" ||
    source === "test" ||
    source === "mock" ||
    source === "regression"
  ) {
    return { visible: false, reason: "fixture_source" };
  }
  if (isSyntheticOperatorCourseAlias(alias)) {
    return { visible: false, reason: "synthetic_alias" };
  }
  return { visible: true, reason: "visible" };
}

export function filterOperatorCourses<
  T extends OperatorCourseCandidate
>(courses: readonly T[]): T[] {
  return courses.filter(
    (course) => assessOperatorCourseVisibility(course).visible
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return only a trusted human label. Generated labels such as
 * `课程 01 · bnu-test` are reduced to no name rather than treating the alias
 * as if it were a course title. The caller can then choose a neutral ordinal
 * label while keeping the internal alias out of the default UI.
 */
export function deriveOperatorCourseDisplayName(input: {
  alias: string;
  label?: string | null;
  courseName?: string | null;
}): string | null {
  const alias = normalizeAlias(input.alias);
  const courseName = input.courseName?.trim() ?? "";
  if (
    courseName &&
    normalizeAlias(courseName) !== alias &&
    !normalizeAlias(courseName).includes(alias)
  ) {
    return courseName;
  }
  const raw = input.label?.trim() ?? "";
  if (!raw || !alias) return null;

  const withoutAlias = raw
    .replace(
      new RegExp(`\\s*[·•|/]\\s*${escapeRegExp(alias)}\\s*$`, "i"),
      ""
    )
    .trim();
  if (!withoutAlias || normalizeAlias(withoutAlias) === alias) {
    return null;
  }
  // This is the old read-model-generated ordinal, not a human course title.
  if (/^课程\s*\d{1,4}$/u.test(withoutAlias)) return null;
  return withoutAlias;
}

export type OperatorCoursePresentation = {
  alias: string;
  /** A safe label for a compact selector; it never contains the alias. */
  label: string;
  displayName: string | null;
};

export function buildOperatorCoursePresentation(
  input: OperatorCourseCandidate & { ordinal: number }
): OperatorCoursePresentation {
  const displayName = deriveOperatorCourseDisplayName(input);
  const ordinal = Number.isSafeInteger(input.ordinal) && input.ordinal > 0
    ? input.ordinal
    : 1;
  return {
    alias: input.alias,
    label:
      displayName ?? `课程 ${String(ordinal).padStart(2, "0")}`,
    displayName
  };
}
