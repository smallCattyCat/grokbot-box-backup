import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SafeLearnerPosition } from "../../lib/autonomy/world-read-model";
import type { AutonomyWorldReadModel } from "../../lib/autonomy/world-read-model";
import {
  buildWorldHref,
  parseWorldExplorerQuery
} from "../../lib/autonomy/world-explorer-state";
import {
  buildLearnerPageContext,
  createWorldPageBridgeState,
  rankWeakestLearnerPositions,
  transitionWorldPageAction,
  type WorldPageActionRuntimeState
} from "../../components/autonomy/world-graph-explorer";

function pageAction(action: Record<string, unknown>) {
  return action as Parameters<typeof transitionWorldPageAction>[0]["action"];
}

test("world query helpers are imported by the server page from a server-safe module", () => {
  const pageSource = readFileSync(
    new URL("../../app/autonomy/world/page.tsx", import.meta.url),
    "utf8"
  );
  const helperSource = readFileSync(
    new URL(
      "../../lib/autonomy/world-explorer-state.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.equal(
    pageSource.includes("@/lib/autonomy/world-explorer-state"),
    true
  );
  assert.doesNotMatch(
    pageSource,
    /import\s*\{[^}]*parseWorldExplorerQuery[^}]*\}\s*from\s*["']@\/components\/autonomy\/world-graph-explorer["']/su
  );
  assert.doesNotMatch(helperSource, /^\s*["']use client["']/u);
  assert.doesNotMatch(
    helperSource,
    /from\s*["'](?:react|next\/navigation)["']/u
  );
});

function position(
  input: Partial<SafeLearnerPosition> &
    Pick<SafeLearnerPosition, "actorId" | "actorLabel">
): SafeLearnerPosition {
  return {
    id: `position-${input.actorId}`,
    windowKind: "rolling_30d",
    coverageStatus: "lower_bound",
    eventCount: 0,
    authoredThreadCount: 0,
    replyCount: 0,
    inboundReplyCount: 0,
    outboundReplyCount: 0,
    uniqueInboundPeerCount: 0,
    uniqueOutboundPeerCount: 0,
    reciprocalPeerCount: 0,
    componentSize: 1,
    kCore: null,
    pageRank: null,
    ...input
  };
}

test("world query accepts canonical view, window, weakest and safe actor focus", () => {
  assert.deepEqual(
    parseWorldExplorerQuery({
      view: "learner_position",
      window: "rolling_30d",
      focus: "weakest"
    }),
    {
      view: "learner_position",
      window: "rolling_30d",
      focus: "weakest"
    }
  );
  assert.deepEqual(
    parseWorldExplorerQuery({
      view: "learner_position",
      window: "rolling_7d",
      focus: "actor-007"
    }),
    {
      view: "learner_position",
      window: "rolling_7d",
      focus: "actor-007"
    }
  );

  assert.deepEqual(
    parseWorldExplorerQuery({
      view: "unknown",
      window: "future",
      focus: "raw-platform-user@example.test"
    }),
    {
      view: "community_network",
      window: "rolling_30d",
      focus: null
    }
  );
});

test("world href carries canonical state across refresh and soft navigation", () => {
  assert.equal(
    buildWorldHref({
      courseAlias: "course_fixture",
      snapshotId: "snapshot_fixture",
      view: "learner_position",
      window: "rolling_30d",
      focus: "actor-003"
    }),
    "/autonomy/world?course=course_fixture&snapshot=snapshot_fixture&view=learner_position&window=rolling_30d&focus=actor-003"
  );
});

test("weakest learner ranking is learner-position only and deterministic", () => {
  const ranked = rankWeakestLearnerPositions([
    position({
      actorId: "actor-004",
      actorLabel: "学习者 04",
      reciprocalPeerCount: 1,
      uniqueInboundPeerCount: 1,
      uniqueOutboundPeerCount: 1,
      eventCount: 1
    }),
    position({
      actorId: "actor-003",
      actorLabel: "学习者 03",
      reciprocalPeerCount: 0,
      uniqueInboundPeerCount: 2,
      uniqueOutboundPeerCount: 0,
      inboundReplyCount: 2,
      eventCount: 1
    }),
    position({
      actorId: "actor-002",
      actorLabel: "学习者 02",
      reciprocalPeerCount: 0,
      uniqueInboundPeerCount: 1,
      uniqueOutboundPeerCount: 0,
      inboundReplyCount: 1,
      eventCount: 4
    }),
    position({
      actorId: "actor-001",
      actorLabel: "学习者 01",
      reciprocalPeerCount: 0,
      uniqueInboundPeerCount: 1,
      uniqueOutboundPeerCount: 0,
      inboundReplyCount: 1,
      eventCount: 4
    })
  ]);

  assert.deepEqual(
    ranked.map((item) => item.actorId),
    ["actor-001", "actor-002", "actor-003", "actor-004"]
  );
  assert.equal(ranked[0]?.coverageStatus, "lower_bound");
});

test("focused learner context is snapshot-scoped, anonymous and body-free", () => {
  const learner = position({
    actorId: "actor-006",
    actorLabel: "学习者 06",
    reciprocalPeerCount: 0,
    uniqueInboundPeerCount: 1,
    eventCount: 2
  });
  const context = buildLearnerPageContext({
    courseAlias: "course_fixture",
    snapshotId: "snapshot_fixture",
    position: learner
  });

  assert.deepEqual(context, {
    kind: "learner",
    id: "learner:snapshot_fixture__actor-006",
    label: "学习者 06",
    title: "当前可观察连接最弱",
    sourceHref:
      "/autonomy/world?course=course_fixture&snapshot=snapshot_fixture&view=learner_position&window=rolling_30d&focus=actor-006",
    summary: "当前可观察下界 · 双向同伴 0 · 去重连接 1 · 事件 2",
    containsIdentity: false,
    containsForumText: false
  });
  assert.equal(JSON.stringify(context).includes("raw"), false);
});

test("focus then attach succeeds synchronously without waiting for a React rerender", () => {
  const learner = position({
    actorId: "actor-008",
    actorLabel: "学习者 08",
    reciprocalPeerCount: 0
  });
  const model = {
    selectedCourse: { alias: "course_fixture", label: "课程 01" },
    snapshot: { id: "snapshot_fixture" },
    graph: { roleRegistryStatus: "complete" },
    learnerPositions: [learner]
  } as unknown as AutonomyWorldReadModel;
  let runtime: WorldPageActionRuntimeState = {
    explorerState: parseWorldExplorerQuery(),
    attachedContexts: [],
    revision: 1
  };

  const focused = transitionWorldPageAction({
    model,
    current: runtime,
    action: {
      id: "step-1",
      type: "world.focus_weakest",
      routeId: "autonomy.world",
      strategy: "lowest_observable_connections",
      window: "current_observable"
    }
  });
  assert.equal(focused.outcome.status, "completed");
  runtime = focused.next;

  const attached = transitionWorldPageAction({
    model,
    current: runtime,
    action: {
      id: "step-2",
      type: "context.attach_focused",
      routeId: "autonomy.world",
      contextKind: "learner"
    }
  });
  assert.equal(attached.outcome.status, "completed");
  assert.equal(attached.next.attachedContexts.length, 1);
  assert.equal(
    attached.outcome.context?.id,
    "learner:snapshot_fixture__actor-008"
  );
});

test("world bridge advertises the view, window, and learner focus actions", () => {
  const model = {
    selectedCourse: { alias: "course_fixture", label: "课程 01" },
    snapshot: { id: "snapshot_fixture" },
    graph: { roleRegistryStatus: "complete" },
    learnerPositions: []
  } as unknown as AutonomyWorldReadModel;

  const state = createWorldPageBridgeState({
    model,
    explorerState: parseWorldExplorerQuery(),
    revision: 1
  });

  assert.deepEqual(
    state.capabilities,
    [
      "world.focus_weakest",
      "world.set_view",
      "world.set_window",
      "world.focus_learner",
      "context.attach_focused"
    ]
  );
});

test("set_view preserves the current window and learner focus", () => {
  const learner = position({
    actorId: "actor-007",
    actorLabel: "学习者 07",
    windowKind: "rolling_30d"
  });
  const model = {
    selectedCourse: { alias: "course_fixture", label: "课程 01" },
    snapshot: { id: "snapshot_fixture" },
    graph: { roleRegistryStatus: "complete" },
    learnerPositions: [learner]
  } as unknown as AutonomyWorldReadModel;
  const current: WorldPageActionRuntimeState = {
    explorerState: {
      view: "learner_position",
      window: "rolling_30d",
      focus: "actor-007"
    },
    attachedContexts: [],
    revision: 4
  };

  const result = transitionWorldPageAction({
    model,
    current,
    action: pageAction({
      id: "view-1",
      type: "world.set_view",
      routeId: "autonomy.world",
      view: "course_structure"
    })
  });

  assert.equal(result.outcome.status, "completed");
  assert.deepEqual(result.next.explorerState, {
    view: "course_structure",
    window: "rolling_30d",
    focus: "actor-007"
  });
  assert.equal(result.next.revision, 5);
});

test("set_window changes the observation window and clears a stale focus", () => {
  const model = {
    selectedCourse: { alias: "course_fixture", label: "课程 01" },
    snapshot: { id: "snapshot_fixture" },
    graph: { roleRegistryStatus: "complete" },
    learnerPositions: []
  } as unknown as AutonomyWorldReadModel;
  const current: WorldPageActionRuntimeState = {
    explorerState: {
      view: "learner_position",
      window: "rolling_30d",
      focus: "actor-007"
    },
    attachedContexts: [],
    revision: 4
  };

  const result = transitionWorldPageAction({
    model,
    current,
    action: pageAction({
      id: "window-1",
      type: "world.set_window",
      routeId: "autonomy.world",
      window: "rolling_7d"
    })
  });

  assert.equal(result.outcome.status, "completed");
  assert.deepEqual(result.next.explorerState, {
    view: "learner_position",
    window: "rolling_7d",
    focus: null
  });
  assert.equal(result.next.revision, 5);
});

test("focus_learner matches anonymized labels despite whitespace and case", () => {
  const learner = position({
    actorId: "actor-007",
    actorLabel: "学习者 07",
    windowKind: "rolling_7d"
  });
  const outsideWindow = position({
    actorId: "actor-008",
    actorLabel: "学习者 08",
    windowKind: "all_time"
  });
  const model = {
    selectedCourse: { alias: "course_fixture", label: "课程 01" },
    snapshot: { id: "snapshot_fixture" },
    graph: { roleRegistryStatus: "complete" },
    learnerPositions: [learner, outsideWindow]
  } as unknown as AutonomyWorldReadModel;
  const current: WorldPageActionRuntimeState = {
    explorerState: {
      view: "community_network",
      window: "rolling_7d",
      focus: null
    },
    attachedContexts: [],
    revision: 8
  };

  const result = transitionWorldPageAction({
    model,
    current,
    action: pageAction({
      id: "learner-1",
      type: "world.focus_learner",
      routeId: "autonomy.world",
      learnerLabel: "  学习者07  "
    })
  });

  assert.equal(result.outcome.status, "completed");
  assert.equal(result.next.explorerState.view, "learner_position");
  assert.equal(result.next.explorerState.window, "rolling_7d");
  assert.equal(result.next.explorerState.focus, "actor-007");
  assert.equal(result.outcome.state?.focusedLearnerId, "actor-007");
  assert.equal(result.outcome.state?.focusedLearnerLabel, "学习者 07");
});

test("focus_learner treats learner and member as equivalent anonymous label prefixes", () => {
  const learner = position({
    actorId: "actor-008",
    actorLabel: "成员 08",
    windowKind: "rolling_30d"
  });
  const model = {
    selectedCourse: { alias: "course_fixture", label: "课程 01" },
    snapshot: { id: "snapshot_fixture" },
    graph: { roleRegistryStatus: "complete" },
    learnerPositions: [learner]
  } as unknown as AutonomyWorldReadModel;
  const current: WorldPageActionRuntimeState = {
    explorerState: {
      view: "community_network",
      window: "rolling_30d",
      focus: null
    },
    attachedContexts: [],
    revision: 3
  };

  const result = transitionWorldPageAction({
    model,
    current,
    action: pageAction({
      id: "learner-prefix-1",
      type: "world.focus_learner",
      routeId: "autonomy.world",
      learnerLabel: "学习者08"
    })
  });

  assert.equal(result.outcome.status, "completed");
  assert.equal(result.next.explorerState.focus, "actor-008");
  assert.equal(result.outcome.state?.focusedLearnerLabel, "成员 08");
});

test("focus_learner never crosses the active window and returns a safe error", () => {
  const learner = position({
    actorId: "actor-007",
    actorLabel: "学习者 07",
    windowKind: "rolling_30d"
  });
  const model = {
    selectedCourse: { alias: "course_fixture", label: "课程 01" },
    snapshot: { id: "snapshot_fixture" },
    graph: { roleRegistryStatus: "complete" },
    learnerPositions: [learner]
  } as unknown as AutonomyWorldReadModel;
  const current: WorldPageActionRuntimeState = {
    explorerState: {
      view: "community_network",
      window: "rolling_7d",
      focus: null
    },
    attachedContexts: [],
    revision: 2
  };

  const result = transitionWorldPageAction({
    model,
    current,
    action: pageAction({
      id: "learner-2",
      type: "world.focus_learner",
      routeId: "autonomy.world",
      learnerLabel: "学习者 07"
    })
  });

  assert.equal(result.outcome.status, "unavailable");
  assert.equal(result.outcome.errorCode, "WORLD_LEARNER_NOT_VISIBLE");
  assert.deepEqual(result.next, current);
});
