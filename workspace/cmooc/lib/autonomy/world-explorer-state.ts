export type WorldView =
  | "course_structure"
  | "community_network"
  | "learner_position";

export type WorldWindowKind =
  | "rolling_7d"
  | "rolling_30d"
  | "all_time";

export type WorldFocus = "weakest" | string | null;

export type WorldExplorerState = {
  view: WorldView;
  window: WorldWindowKind;
  focus: WorldFocus;
};

export type WorldExplorerQuery = {
  view?: string | string[];
  window?: string | string[];
  focus?: string | string[];
};

export const DEFAULT_WORLD_EXPLORER_STATE: WorldExplorerState = Object.freeze({
  view: "community_network",
  window: "rolling_30d",
  focus: null
});

function firstQueryValue(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isSafeActorId(value: string): boolean {
  return /^actor-[0-9]{3,6}$/.test(value);
}

export function parseWorldExplorerQuery(
  input?: WorldExplorerQuery
): WorldExplorerState {
  const view = firstQueryValue(input?.view);
  const windowKind = firstQueryValue(input?.window);
  const focus = firstQueryValue(input?.focus);
  return {
    view:
      view === "course_structure" ||
      view === "community_network" ||
      view === "learner_position"
        ? view
        : DEFAULT_WORLD_EXPLORER_STATE.view,
    window:
      windowKind === "rolling_7d" ||
      windowKind === "rolling_30d" ||
      windowKind === "all_time"
        ? windowKind
        : DEFAULT_WORLD_EXPLORER_STATE.window,
    focus:
      focus === "weakest" ||
      (focus !== undefined && isSafeActorId(focus))
        ? focus
        : null
  };
}

export function buildWorldHref(input: {
  courseAlias: string;
  snapshotId?: string;
  view?: WorldView;
  window?: WorldWindowKind;
  focus?: WorldFocus;
}): string {
  const params = new URLSearchParams({
    course: input.courseAlias,
    ...(input.snapshotId ? { snapshot: input.snapshotId } : {}),
    view: input.view ?? DEFAULT_WORLD_EXPLORER_STATE.view,
    window: input.window ?? DEFAULT_WORLD_EXPLORER_STATE.window,
    ...(input.focus ? { focus: input.focus } : {})
  });
  return `/autonomy/world?${params.toString()}`;
}
