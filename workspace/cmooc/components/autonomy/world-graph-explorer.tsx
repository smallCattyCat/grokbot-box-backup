"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { GlassCard } from "@/components/ui/glass-card";
import {
  registerPageBridge,
  type PageBridgeAction,
  type PageBridgeContext,
  type PageBridgeExecutionOutcome,
  type PageBridgeState
} from "@/lib/agent/page-bridge";
import {
  buildWorldHref,
  DEFAULT_WORLD_EXPLORER_STATE,
  type WorldExplorerState,
  type WorldView,
  type WorldWindowKind
} from "@/lib/autonomy/world-explorer-state";
import type {
  AutonomyWorldReadModel,
  SafeLearnerPosition,
  SafeWorldThread,
  WorldActorRole,
  WorldNodeKind,
  WorldThreadLane
} from "@/lib/autonomy/world-read-model";
import type { OperatorCourseIdentityOverlay } from "@/lib/autonomy/operator-course-identity";

type OperatorActorIdentity = OperatorCourseIdentityOverlay["actors"][number];
type OperatorThreadIdentity = OperatorCourseIdentityOverlay["threads"][number];

function operatorActor(
  operatorIdentity: OperatorCourseIdentityOverlay | null | undefined,
  nodeId: string | null | undefined
): OperatorActorIdentity | null {
  if (!nodeId) return null;
  return operatorIdentity?.actors.find((item) => item.nodeId === nodeId) ?? null;
}

function operatorThread(
  operatorIdentity: OperatorCourseIdentityOverlay | null | undefined,
  nodeId: string | null | undefined
): OperatorThreadIdentity | null {
  if (!nodeId) return null;
  return operatorIdentity?.threads.find((item) => item.nodeId === nodeId) ?? null;
}

function operatorActorLabel(
  operatorIdentity: OperatorCourseIdentityOverlay | null | undefined,
  nodeId: string,
  fallback: string
): string {
  return operatorActor(operatorIdentity, nodeId)?.displayName ?? fallback;
}

function uniquePeerCount(position: SafeLearnerPosition): number {
  return Math.max(
    0,
    position.uniqueInboundPeerCount +
      position.uniqueOutboundPeerCount -
      position.reciprocalPeerCount
  );
}

export function rankWeakestLearnerPositions(
  positions: readonly SafeLearnerPosition[]
): SafeLearnerPosition[] {
  return [...positions].sort(
    (left, right) =>
      left.reciprocalPeerCount - right.reciprocalPeerCount ||
      uniquePeerCount(left) - uniquePeerCount(right) ||
      left.inboundReplyCount +
        left.outboundReplyCount -
        (right.inboundReplyCount + right.outboundReplyCount) ||
      left.eventCount - right.eventCount ||
      left.actorLabel.localeCompare(right.actorLabel, "zh-CN")
  );
}

export function buildLearnerPageContext(input: {
  courseAlias: string;
  snapshotId: string;
  position: SafeLearnerPosition;
  title?: string;
}) {
  const { position } = input;
  return {
    kind: "learner" as const,
    id: `learner:${input.snapshotId}__${position.actorId}`,
    label: position.actorLabel,
    title: input.title ?? "当前可观察连接最弱",
    sourceHref: buildWorldHref({
      courseAlias: input.courseAlias,
      snapshotId: input.snapshotId,
      view: "learner_position",
      window: position.windowKind,
      focus: position.actorId
    }),
    summary: `${coverageLabel(position.coverageStatus)} · 双向同伴 ${position.reciprocalPeerCount} · 去重连接 ${uniquePeerCount(position)} · 事件 ${position.eventCount}`,
    containsIdentity: false as const,
    containsForumText: false as const
  };
}

export type WorldPageBridgeState = PageBridgeState & {
  courseAlias: string | null;
  snapshotId: string | null;
  view: WorldView;
  window: WorldWindowKind;
  focusedLearnerId: string | null;
  focusedLearnerLabel: string | null;
  containsIdentity: false;
};

/**
 * Keep the page transition runtime tolerant while the shared command contract
 * evolves.  These action shapes are intentionally local to the world page;
 * the canonical aliases are exported from command-planner/page-bridge.
 */
type WorldSetViewPageAction = {
  id: string;
  type: "world.set_view";
  routeId: "autonomy.world";
  view: WorldView;
};

type WorldSetWindowPageAction = {
  id: string;
  type: "world.set_window";
  routeId: "autonomy.world";
  window: WorldWindowKind;
};

type WorldFocusLearnerPageAction = {
  id: string;
  type: "world.focus_learner";
  routeId: "autonomy.world";
  learnerLabel: string;
};

type ExtendedWorldPageAction =
  | PageBridgeAction
  | WorldSetViewPageAction
  | WorldSetWindowPageAction
  | WorldFocusLearnerPageAction;

function normalizeLearnerLabel(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .toLocaleLowerCase("zh-CN");
  const anonymousNumericLabel = /^(?:学习者|成员)([0-9]+)$/u.exec(
    normalized
  );
  return anonymousNumericLabel
    ? `anonymous-learner-${anonymousNumericLabel[1]}`
    : normalized;
}

function transitionOutcomeState(input: {
  model: AutonomyWorldReadModel;
  next: WorldPageActionRuntimeState;
  summary: string;
}): PageBridgeExecutionOutcome {
  return {
    status: "completed",
    summary: input.summary,
    state: createWorldPageBridgeState({
      model: input.model,
      ...input.next
    })
  };
}

function focusedLearnerForState(
  model: AutonomyWorldReadModel,
  explorerState: WorldExplorerState
): SafeLearnerPosition | null {
  const positions = rankWeakestLearnerPositions(
    model.learnerPositions.filter(
      (position) => position.windowKind === explorerState.window
    )
  );
  return explorerState.focus === "weakest"
    ? positions[0] ?? null
    : positions.find(
        (position) => position.actorId === explorerState.focus
      ) ?? null;
}

export function createWorldPageBridgeState(input: {
  model: AutonomyWorldReadModel;
  explorerState: WorldExplorerState;
  attachedContexts?: readonly PageBridgeContext[];
  revision: number;
}): WorldPageBridgeState {
  const { model, explorerState } = input;
  const courseAlias = model.selectedCourse?.alias ?? null;
  const snapshotId = model.snapshot?.id ?? null;
  const learner = focusedLearnerForState(model, explorerState);
  const focusedContext =
    learner && courseAlias && snapshotId
      ? buildLearnerPageContext({
          courseAlias,
          snapshotId,
          position: learner,
          title:
            explorerState.focus === "weakest"
              ? "当前可观察连接最弱"
              : "当前聚焦学习者"
        })
      : null;
  const sourceHref = courseAlias
    ? buildWorldHref({
        courseAlias,
        ...(snapshotId ? { snapshotId } : {}),
        ...explorerState
      })
    : "/autonomy/world";
  const summary = learner
    ? `已聚焦 ${learner.actorLabel}；${coverageLabel(learner.coverageStatus)}。`
    : model.snapshot
      ? "社会网络已就绪，尚未聚焦学习者。"
      : "当前课程尚无可用世界快照。";

  return {
    schemaVersion: "cmooc.page-bridge-state.v1",
    routeId: "autonomy.world",
    href: "/autonomy/world",
    status: model.snapshot ? "ready" : "error",
    capabilities: [
      "world.focus_weakest",
      "world.set_view",
      "world.set_window",
      "world.focus_learner",
      "context.attach_focused"
    ],
    revision: input.revision,
    summary,
    ...(focusedContext ? { focusedContext } : {}),
    attachedContexts: [...(input.attachedContexts ?? [])],
    metadata: {
      courseAlias,
      snapshotId,
      view: explorerState.view,
      window: explorerState.window,
      focusedLearnerId: learner?.actorId ?? null,
      focusedLearnerLabel: learner?.actorLabel ?? null,
      sourceHref,
      containsIdentity: false
    },
    courseAlias,
    snapshotId,
    view: explorerState.view,
    window: explorerState.window,
    focusedLearnerId: learner?.actorId ?? null,
    focusedLearnerLabel: learner?.actorLabel ?? null,
    containsIdentity: false,
    containsForumText: false,
    externalWrites: false
  };
}

export type WorldPageActionRuntimeState = {
  explorerState: WorldExplorerState;
  attachedContexts: PageBridgeContext[];
  revision: number;
};

export function transitionWorldPageAction(input: {
  model: AutonomyWorldReadModel;
  current: WorldPageActionRuntimeState;
  action: PageBridgeAction;
}): {
  next: WorldPageActionRuntimeState;
  outcome: PageBridgeExecutionOutcome;
} {
  const { model, current } = input;
  const action = input.action as ExtendedWorldPageAction;

  if (action.type === "world.set_view") {
    const next: WorldPageActionRuntimeState = {
      explorerState: {
        ...current.explorerState,
        view: action.view
      },
      attachedContexts: current.attachedContexts,
      revision: current.revision + 1
    };
    return {
      next,
      outcome: transitionOutcomeState({
        model,
        next,
        summary: `已切换到${
          action.view === "community_network"
            ? "社会网络"
            : action.view === "course_structure"
              ? "课程结构"
              : "学习者位置"
        }视图。`
      })
    };
  }

  if (action.type === "world.set_window") {
    const next: WorldPageActionRuntimeState = {
      explorerState: {
        ...current.explorerState,
        window: action.window,
        focus: null
      },
      attachedContexts: current.attachedContexts,
      revision: current.revision + 1
    };
    return {
      next,
      outcome: transitionOutcomeState({
        model,
        next,
        summary: `观察窗口已切换为${
          action.window === "rolling_7d"
            ? "近 7 天"
            : action.window === "rolling_30d"
              ? "近 30 天"
              : "全时段"
        }，已清除旧的学习者聚焦。`
      })
    };
  }

  if (action.type === "world.focus_learner") {
    const courseAlias = model.selectedCourse?.alias;
    const snapshotId = model.snapshot?.id;
    const normalizedLabel = normalizeLearnerLabel(action.learnerLabel);
    const learner = rankWeakestLearnerPositions(
      model.learnerPositions.filter(
        (position) =>
          position.windowKind === current.explorerState.window &&
          normalizeLearnerLabel(position.actorLabel) === normalizedLabel
      )
    )[0];

    if (
      !learner ||
      !courseAlias ||
      !snapshotId ||
      model.graph.roleRegistryStatus !== "complete"
    ) {
      return {
        next: current,
        outcome: {
          status: "unavailable",
          summary: `当前${
            current.explorerState.window === "rolling_7d"
              ? "近 7 天"
              : current.explorerState.window === "rolling_30d"
                ? "近 30 天"
                : "全时段"
          }窗口没有可聚焦的匿名学习者位置。`,
          retryable: false,
          errorCode: learner
            ? "WORLD_LEARNER_POSITION_UNAVAILABLE"
            : "WORLD_LEARNER_NOT_VISIBLE"
        }
      };
    }

    const next: WorldPageActionRuntimeState = {
      explorerState: {
        view: "learner_position",
        window: current.explorerState.window,
        focus: learner.actorId
      },
      attachedContexts: current.attachedContexts,
      revision: current.revision + 1
    };
    const context = buildLearnerPageContext({
      courseAlias,
      snapshotId,
      position: learner,
      title: "当前聚焦学习者"
    });
    return {
      next,
      outcome: {
        ...transitionOutcomeState({
          model,
          next,
          summary: `已聚焦 ${learner.actorLabel}；${coverageLabel(
            learner.coverageStatus
          )}。`
        }),
        context
      }
    };
  }

  if (action.type === "world.focus_weakest") {
    const weakest = rankWeakestLearnerPositions(
      model.learnerPositions.filter(
        (position) =>
          position.windowKind === current.explorerState.window
      )
    )[0];
    const courseAlias = model.selectedCourse?.alias;
    const snapshotId = model.snapshot?.id;
    if (
      !weakest ||
      !courseAlias ||
      !snapshotId ||
      model.graph.roleRegistryStatus !== "complete"
    ) {
      return {
        next: current,
        outcome: {
          status: "unavailable",
          summary: "当前快照没有经过角色验证的学习者位置。",
          retryable: false,
          errorCode: "WORLD_LEARNER_POSITION_UNAVAILABLE"
        }
      };
    }
    const next: WorldPageActionRuntimeState = {
      explorerState: {
        view: "learner_position",
        window: current.explorerState.window,
        focus: "weakest"
      },
      attachedContexts: current.attachedContexts,
      revision: current.revision + 1
    };
    const context = buildLearnerPageContext({
      courseAlias,
      snapshotId,
      position: weakest
    });
    return {
      next,
      outcome: {
        status: "completed",
        summary: `已聚焦 ${weakest.actorLabel}；${coverageLabel(weakest.coverageStatus)}。`,
        context,
        state: createWorldPageBridgeState({
          model,
          ...next
        })
      }
    };
  }

  if (action.type !== "context.attach_focused") {
    return {
      next: current,
      outcome: {
        status: "unsupported",
        summary: "当前社会网络页面不支持此动作。",
        retryable: false,
        errorCode: "WORLD_ACTION_UNSUPPORTED"
      }
    };
  }

  const bridgeState = createWorldPageBridgeState({
    model,
    ...current
  });
  const context = bridgeState.focusedContext;
  if (!context) {
    return {
      next: current,
      outcome: {
        status: "unavailable",
        summary: "请先聚焦一名经过角色验证的学习者。",
        retryable: false,
        errorCode: "WORLD_FOCUSED_LEARNER_REQUIRED"
      }
    };
  }
  const next: WorldPageActionRuntimeState = {
    explorerState: current.explorerState,
    attachedContexts: [
      ...current.attachedContexts.filter(
        (item) => item.id !== context.id
      ),
      context
    ],
    revision: current.revision + 1
  };
  return {
    next,
    outcome: {
      status: "completed",
      summary: `已将 ${context.label} 的匿名聚合摘要加入当前任务上下文。`,
      context,
      state: createWorldPageBridgeState({
        model,
        ...next
      })
    }
  };
}

const VIEW_META: Array<{
  id: WorldView;
  label: string;
  kicker: string;
}> = [
  {
    id: "community_network",
    label: "社会网络",
    kicker: "运营成员与互动拓扑"
  },
  {
    id: "course_structure",
    label: "课程结构",
    kicker: "线程状态与支持缺口"
  },
  {
    id: "learner_position",
    label: "学习者位置",
    kicker: "可信角色的描述性指标"
  }
];

const LANE_META: Array<{
  id: WorldThreadLane;
  label: string;
  explanation: string;
  accent: string;
}> = [
  {
    id: "open_gap",
    label: "开放支持缺口",
    explanation: "完整线程中尚未观测到任何响应",
    accent: "border-amber-400/40 bg-amber-400/5"
  },
  {
    id: "verified_response",
    label: "可信真人回应",
    explanation: "已观测到角色证据支持的外部回应",
    accent: "border-emerald-400/40 bg-emerald-400/5"
  },
  {
    id: "distinct_response",
    label: "不同成员回应",
    explanation: "存在不同账号回应，但角色证据不足",
    accent: "border-cyan-400/40 bg-cyan-400/5"
  },
  {
    id: "follow_up",
    label: "作者 / 系统跟进",
    explanation: "只有作者返回或系统侧跟进",
    accent: "border-violet-400/40 bg-violet-400/5"
  },
  {
    id: "censored",
    label: "覆盖删失",
    explanation: "评论覆盖不完整，不判定为真实缺口",
    accent: "border-slate-600 bg-slate-900/40"
  }
];

const KIND_LABELS: Record<WorldNodeKind, string> = {
  course: "课程",
  column: "栏目",
  thread: "讨论",
  actor: "成员",
  concept: "受控概念",
  resource: "哈希资源"
};

const ROLE_LABELS: Record<
  Exclude<WorldActorRole, null>,
  string
> = {
  learner: "已验证学习者",
  creator: "课程创建者",
  helper: "助教 / 协作者",
  follower: "关注者",
  unknown: "角色未知"
};

const WINDOW_META = [
  ["rolling_7d", "近 7 天"],
  ["rolling_30d", "近 30 天"],
  ["all_time", "全时段"]
] as const;

function selectTabFromKeyboard({
  event,
  index,
  count,
  onSelect
}: {
  event: KeyboardEvent<HTMLButtonElement>;
  index: number;
  count: number;
  onSelect: (nextIndex: number) => void;
}) {
  const nextIndex =
    event.key === "ArrowRight"
      ? (index + 1) % count
      : event.key === "ArrowLeft"
        ? (index - 1 + count) % count
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? count - 1
            : null;
  if (nextIndex === null) return;

  event.preventDefault();
  onSelect(nextIndex);
  const tabs = event.currentTarget.parentElement?.querySelectorAll<
    HTMLButtonElement
  >('[role="tab"]');
  tabs?.[nextIndex]?.focus();
}

function dateTime(value: string | null): string {
  if (!value) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function roleLabel(role: WorldActorRole): string {
  return role ? ROLE_LABELS[role] : "角色证据未登记";
}

function nodeFill(role: WorldActorRole): string {
  if (role === "learner") return "#22d3ee";
  if (role === "creator") return "#a78bfa";
  if (role === "helper") return "#34d399";
  if (role === "follower") return "#fbbf24";
  return "#64748b";
}

/**
 * The community canvas must not pick an arbitrary anonymous member on first
 * paint. An explicit URL focus is still honored so deep links remain useful.
 */
export function getInitialCommunityNodeId(
  model: Pick<AutonomyWorldReadModel, "community">,
  state: Pick<WorldExplorerState, "view" | "focus">
): string | null {
  if (state.view !== "community_network" || !state.focus || state.focus === "weakest") {
    return null;
  }
  return model.community.nodes.some((node) => node.id === state.focus)
    ? state.focus
    : null;
}

/** Anonymous node labels are a response to an explicit selection, not canvas chrome. */
export function communityNodeLabelVisible(selected: boolean): boolean {
  return selected;
}

function StatCell({
  label,
  value,
  hint
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/45 px-3 py-3">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
        {label}
      </p>
      <p className="mt-2 font-mono text-lg font-bold tabular-nums text-slate-100">
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-[11px] leading-4 text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function EmptyState({
  title,
  children
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/30 px-5 py-10 text-center">
      <p className="font-semibold text-slate-200">{title}</p>
      <div className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-500">
        {children}
      </div>
    </div>
  );
}

function ThreadCard({
  thread,
  operatorIdentity,
  selected,
  onSelect
}: {
  thread: SafeWorldThread;
  operatorIdentity?: OperatorCourseIdentityOverlay | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const identity = operatorThread(operatorIdentity, thread.id);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`w-full rounded-lg border px-3 py-3 text-left transition focus:outline-none focus:ring-2 focus:ring-cyan-400/70 ${
        selected
          ? "border-cyan-300/70 bg-cyan-300/10"
          : "border-slate-800 bg-slate-950/45 hover:border-slate-600 hover:bg-slate-900/60"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs font-bold text-cyan-100">
          {identity?.title ?? thread.label}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 font-mono text-[9px] ${
            thread.completeness === "complete"
              ? "bg-emerald-400/10 text-emerald-300"
              : "bg-slate-700/60 text-slate-300"
          }`}
        >
          {thread.completeness === "complete"
            ? "完整"
            : "覆盖删失"}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="font-mono text-sm text-slate-100">
            {thread.eventCount}
          </p>
          <p className="text-xs text-slate-500">事件</p>
        </div>
        <div>
          <p className="font-mono text-sm text-slate-100">
            {thread.distinctActorResponseCount}
          </p>
          <p className="text-xs text-slate-500">不同回应者</p>
        </div>
        <div>
          <p className="font-mono text-sm text-slate-100">
            {thread.maxDepth}
          </p>
          <p className="text-xs text-slate-500">深度</p>
        </div>
      </div>
      <p className="mt-3 truncate text-[11px] text-slate-500">
        最近事件 {dateTime(thread.latestEventAt)}
      </p>
    </button>
  );
}

function ThreadInspector({
  thread,
  operatorIdentity
}: {
  thread: SafeWorldThread | null;
  operatorIdentity?: OperatorCourseIdentityOverlay | null;
}) {
  if (!thread) {
    return (
      <EmptyState title="选择一条讨论">
        点击左侧任意本地讨论标签，查看该快照截止时的聚合状态。
      </EmptyState>
    );
  }
  const identity = operatorThread(operatorIdentity, thread.id);
  const authorIdentity = operatorActor(operatorIdentity, thread.authorId);
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400">
            当前线程
          </p>
          <h3 className="mt-2 font-mono text-xl font-bold text-slate-50">
            {identity?.title ?? thread.label}
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            {identity
              ? `${identity.author.displayName} · @${identity.author.accountName}`
              : authorIdentity
                ? `${authorIdentity.displayName} · @${authorIdentity.accountName}`
              : thread.authorLabel
              ? `本地作者标签 ${thread.authorLabel}`
              : "作者角色或引用未解析"}
          </p>
        </div>
        <span
          className={`rounded-full border px-3 py-1 font-mono text-xs ${
            thread.openGapHours !== null
              ? "border-amber-400/40 bg-amber-400/10 text-amber-200"
              : "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
          }`}
        >
          {thread.openGapHours !== null
            ? `开放 ${thread.openGapHours} 小时`
            : "已观察到回应"}
        </span>
      </div>

      {identity ? (
        <div className="mt-4 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.05] p-3">
          <p className="text-xs font-semibold text-cyan-100">运营者可读原帖</p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-300">
            {identity.preview}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            <code className="text-slate-400">@{identity.author.accountName}</code>
            {identity.sourceUrl ? (
              <a
                className="font-semibold text-cyan-300 hover:text-cyan-100"
                href={identity.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                打开原帖
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatCell label="事件" value={thread.eventCount} />
        <StatCell
          label="可信外部回应"
          value={thread.externalHumanCount}
        />
        <StatCell
          label="不同回应者"
          value={thread.distinctActorResponseCount}
        />
        <StatCell
          label="作者返回"
          value={thread.authorReturnCount}
        />
        <StatCell
          label="系统回应"
          value={thread.systemResponseCount}
        />
        <StatCell label="最大深度" value={thread.maxDepth} />
      </div>

      <dl className="mt-5 space-y-3 border-t border-slate-800 pt-4 text-xs">
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500">根事件至快照</dt>
          <dd className="font-mono text-slate-200">
            {thread.ageAtCutoffHours}h
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500">首次事件</dt>
          <dd className="font-mono text-slate-200">
            {dateTime(thread.firstEventAt)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500">最近事件</dt>
          <dd className="font-mono text-slate-200">
            {dateTime(thread.latestEventAt)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500">评论覆盖</dt>
          <dd className="font-mono text-slate-200">
            {thread.completeness === "complete"
              ? "完整"
              : "覆盖删失"}
          </dd>
        </div>
      </dl>
      <p className="mt-4 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-[11px] leading-5 text-slate-500">
        “支持缺口”只在完整线程且没有观测到任何回应时成立；其余线程的小时数仅表示根事件到快照截止时间的年龄。
      </p>
    </div>
  );
}

function CourseStructureView({
  model,
  operatorIdentity
}: {
  model: AutonomyWorldReadModel;
  operatorIdentity?: OperatorCourseIdentityOverlay | null;
}) {
  const firstThread =
    model.threads.find((thread) => thread.lane === "open_gap") ??
    model.threads[0] ??
    null;
  const [selectedThreadId, setSelectedThreadId] = useState<
    string | null
  >(firstThread?.id ?? null);
  const selectedThread =
    model.threads.find(
      (thread) => thread.id === selectedThreadId
    ) ??
    firstThread ??
    null;

  if (!model.snapshot) {
    return (
      <EmptyState title="尚无课程世界快照">
        完成一次只读 shadow tick 后，这里会出现可重放的课程结构。
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {(
          Object.entries(
            model.structure.kindCounts
          ) as Array<[WorldNodeKind, number]>
        ).map(([kind, count]) => (
          <StatCell
            key={kind}
            label={KIND_LABELS[kind]}
            value={count}
          />
        ))}
      </div>

      {model.graph.source === "world_v1_fallback" ? (
        <div className="rounded-lg border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-xs leading-5 text-amber-100/80">
          当前课程结构数据尚未完整可读，页面暂以讨论与互动摘要展示；不会据此虚构栏目、概念或学习者角色。
        </div>
      ) : null}

      <div className="xl:hidden">
        <aside className="rounded-xl border border-slate-800 bg-slate-950/45 p-5">
          <ThreadInspector thread={selectedThread} operatorIdentity={operatorIdentity} />
        </aside>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {LANE_META.map((lane) => {
            const laneThreads = model.threads.filter(
              (thread) => thread.lane === lane.id
            );
            return (
              <section
                key={lane.id}
                aria-labelledby={`lane-${lane.id}`}
                className={`min-w-0 rounded-xl border p-3 ${lane.accent}`}
              >
                <div className="min-h-[72px]">
                  <div className="flex items-center justify-between gap-2">
                    <h3
                      id={`lane-${lane.id}`}
                      className="text-sm font-bold text-slate-100"
                    >
                      {lane.label}
                    </h3>
                    <span className="rounded-full bg-slate-950/60 px-2 py-0.5 font-mono text-xs text-slate-300">
                      {model.laneCounts[lane.id]}
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] leading-4 text-slate-500">
                    {lane.explanation}
                  </p>
                </div>
                <div className="mt-3 max-h-[560px] space-y-2 overflow-y-auto pr-1">
                  {laneThreads.map((thread) => (
                    <ThreadCard
                      key={thread.id}
                      thread={thread}
                      operatorIdentity={operatorIdentity}
                      selected={thread.id === selectedThread?.id}
                      onSelect={() =>
                        setSelectedThreadId(thread.id)
                      }
                    />
                  ))}
                  {laneThreads.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-slate-700/70 px-3 py-6 text-center text-[11px] text-slate-600">
                      此快照没有该状态
                    </p>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
        <aside className="hidden rounded-xl border border-slate-800 bg-slate-950/45 p-5 xl:sticky xl:top-4 xl:block xl:self-start">
          <ThreadInspector thread={selectedThread} operatorIdentity={operatorIdentity} />
        </aside>
      </div>
    </div>
  );
}

function CommunityNetworkView({
  model,
  initialFocus,
  operatorIdentity
}: {
  model: AutonomyWorldReadModel;
  initialFocus: string | null;
  operatorIdentity?: OperatorCourseIdentityOverlay | null;
}) {
  const initialCommunityNodeId = getInitialCommunityNodeId(model, {
    view: "community_network",
    focus: initialFocus
  });
  const [selectedNodeId, setSelectedNodeId] = useState<
    string | null
  >(initialCommunityNodeId);
  const nodeById = useMemo(
    () =>
      new Map(
        model.community.nodes.map((node) => [node.id, node])
      ),
    [model.community.nodes]
  );
  const selectedNode =
    nodeById.get(selectedNodeId ?? "") ?? null;
  const identityCoverage = operatorIdentity?.identityCoverage ?? null;
  const roleEvidenceCount = useMemo(
    () => model.structure.nodes.filter(
      (node) =>
        node.kind === "actor" &&
        node.role !== null &&
        node.role !== "unknown"
    ).length,
    [model.structure.nodes]
  );
  const roleEvidenceTotal =
    model.graph.actorNodeCount || model.community.totalActorCount;

  if (model.community.nodes.length === 0) {
    return (
      <EmptyState title="当前快照没有可绘制的社区互动边">
        这里仅绘制有本地安全节点映射的回复关系，不从正文或页面标识推断连接。
      </EmptyState>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 rounded-xl border border-slate-800 bg-[radial-gradient(circle_at_48%_45%,rgba(34,211,238,0.10),transparent_58%)] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-3 px-2 pb-3">
          <div>
            <h3 className="font-semibold text-slate-100">
              事件参与者网络
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              节点大小表示当前可见回复权重；箭头从回应者指向被回应者。
            </p>
            <p className="mt-2 max-w-3xl text-xs leading-5 text-slate-500">
              {identityCoverage?.matchedActorCount
                ? `运营者视图已从本机课程成员与论坛抓取记录中匹配 ${identityCoverage.matchedActorCount} 个成员；其余 ${identityCoverage.unmatchedActorCount} 个图节点还没有同期姓名映射，继续显示安全编号。智能体证据和工具回执仍使用匿名编号。`
                : "当前快照尚未匹配到本机运营身份目录，因此节点暂显示安全编号；互动关系与计数仍来自真实课程观察。"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 font-mono text-xs text-slate-400">
            <span className="rounded-full border border-slate-700 px-2 py-1">
              {model.community.visibleActorCount}/
              {model.community.totalActorCount} 节点
            </span>
            <span className="rounded-full border border-slate-700 px-2 py-1">
              {model.community.visibleReplyEdgeCount}/
              {model.community.totalReplyEdgeCount} 边
            </span>
            <span className="rounded-full border border-slate-700 px-2 py-1">
              {identityCoverage?.matchedActorCount ?? 0}/
              {identityCoverage?.graphActorCount ?? model.community.totalActorCount} 全图姓名已匹配
            </span>
            <span className="rounded-full border border-slate-700 px-2 py-1">
              {roleEvidenceCount}/{roleEvidenceTotal} 全图角色证据
            </span>
          </div>
        </div>
        <details className="mx-2 mb-3 rounded-lg border border-slate-800 bg-slate-950/55 px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-semibold text-slate-300 outline-none transition hover:text-slate-100 focus-visible:ring-2 focus-visible:ring-cyan-400/70">
            为什么还有编号？
          </summary>
          <p className="mt-2 border-t border-slate-800 pt-2 text-xs leading-5 text-slate-500">
            互动节点来自所选课程快照，姓名只在本机课程成员表或论坛抓取记录中存在同一平台账号时显示。姓名尚未同步不等于匿名注册；姓名匹配与角色判断是两条独立证据链，角色证据不足也不应抹掉已经核验的姓名。
          </p>
        </details>
        <details className="mt-3 rounded-lg border border-slate-800 bg-slate-950/55 px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-semibold text-slate-300 outline-none transition hover:text-slate-100 focus-visible:ring-2 focus-visible:ring-cyan-400/70">
            浏览节点
            <span className="ml-2 font-normal text-slate-500">
              使用键盘查找成员并查看互动摘要
            </span>
          </summary>
          <label className="mt-3 flex flex-col gap-2 border-t border-slate-800 pt-3 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between">
            <span className="font-semibold text-slate-200">
              节点选择
            </span>
            <select
              aria-label="选择课程互动成员"
              value={selectedNode?.id ?? ""}
              onChange={(event) =>
                setSelectedNodeId(event.target.value || null)
              }
              className="min-h-[44px] rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-xs text-slate-100 outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/70"
            >
              <option value="">选择一个节点…</option>
              {model.community.nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {operatorActorLabel(operatorIdentity, node.id, node.label)} · {roleLabel(node.role)}
                </option>
              ))}
            </select>
          </label>
        </details>
        <div className="overflow-hidden rounded-lg border border-slate-800/80 bg-[#080c0e] shadow-[inset_0_0_56px_rgba(34,211,238,0.035)]">
          <svg
            viewBox="0 0 900 540"
            className="h-auto min-h-[480px] w-full"
            role="img"
            aria-labelledby="community-network-title community-network-description"
          >
            <title id="community-network-title">
              课程成员互动网络
            </title>
            <desc id="community-network-description">
              由当前课程快照的真实回复关系构成；已匹配成员显示姓名与账号，未匹配成员保留安全编号。展开“浏览节点”后可搜索和查看聚合指标。
            </desc>
            <defs>
              <pattern id="world-network-grid" width="36" height="36" patternUnits="userSpaceOnUse">
                <path d="M 36 0 L 0 0 0 36" fill="none" stroke="#1e293b" strokeWidth="0.55" opacity="0.34" />
              </pattern>
              <radialGradient id="world-network-wash" cx="50%" cy="48%" r="65%">
                <stop offset="0%" stopColor="#0e7490" stopOpacity="0.13" />
                <stop offset="58%" stopColor="#0f172a" stopOpacity="0.04" />
                <stop offset="100%" stopColor="#020617" stopOpacity="0" />
              </radialGradient>
              <filter id="world-network-selected-glow" x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <marker
                id="world-network-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="4"
                markerHeight="4"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569" />
              </marker>
            </defs>
            <rect width="900" height="540" fill="url(#world-network-grid)" />
            <rect width="900" height="540" fill="url(#world-network-wash)" />
            {model.community.edges.map((edge) => {
              const source = nodeById.get(edge.sourceId);
              const target = nodeById.get(edge.targetId);
              if (!source || !target) return null;
              return (
                <line
                  key={edge.id}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke={
                    edge.completeness === "complete"
                      ? "#475569"
                      : "#334155"
                  }
                  strokeDasharray={
                    edge.completeness === "complete"
                      ? undefined
                      : "4 5"
                  }
                  strokeWidth={Math.min(
                    4,
                    0.65 + Math.sqrt(edge.weight) * 0.45
                  )}
                  opacity={selectedNode && (edge.sourceId === selectedNode.id || edge.targetId === selectedNode.id) ? 0.9 : 0.42}
                  markerEnd="url(#world-network-arrow)"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            {model.community.nodes.map((node) => {
              const selected = node.id === selectedNode?.id;
              const identity = operatorActor(operatorIdentity, node.id);
              return (
                <g
                  key={node.id}
                  onClick={() =>
                    setSelectedNodeId((current) =>
                      current === node.id ? null : node.id
                    )
                  }
                  className="cursor-pointer"
                >
                  <title>
                    {identity
                      ? `${identity.displayName} · ${roleLabel(node.role)} · ${node.eventCount} 个事件`
                      : `姓名尚未同步 · ${roleLabel(node.role)} · ${node.eventCount} 个事件`}
                  </title>
                  {selected ? (
                    <>
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={node.radius + 11}
                        fill="none"
                        stroke="#22d3ee"
                        strokeWidth="1"
                        strokeDasharray="3 4"
                        opacity="0.58"
                        vectorEffect="non-scaling-stroke"
                      />
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={node.radius + 6}
                        fill="none"
                        stroke="#f8fafc"
                        strokeWidth="1.5"
                        opacity="0.95"
                        filter="url(#world-network-selected-glow)"
                        vectorEffect="non-scaling-stroke"
                      />
                    </>
                  ) : null}
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.radius}
                    fill={nodeFill(node.role)}
                    fillOpacity={selected ? 1 : 0.82}
                    stroke="#0f172a"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                  {communityNodeLabelVisible(selected) ? (
                    <text
                      x={node.x}
                      y={node.y + node.radius + 14}
                      textAnchor="middle"
                      fill={selected ? "#f8fafc" : "#94a3b8"}
                      fontSize="11"
                      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    >
                      {operatorActorLabel(operatorIdentity, node.id, node.label)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 px-2 text-[11px] text-slate-500">
          {(
            [
              ["learner", "已验证学习者"],
              ["creator", "课程创建者"],
              ["helper", "助教 / 协作者"],
              ["follower", "关注者"],
              [null, "角色证据未登记"]
            ] as Array<[WorldActorRole, string]>
          ).map(([role, label]) => (
            <span
              key={role ?? "unregistered"}
              className="inline-flex items-center gap-1.5"
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: nodeFill(role) }}
              />
              {label}
            </span>
          ))}
        </div>
        {model.community.truncated ? (
          <p className="mt-3 px-2 text-[11px] leading-5 text-slate-500">
            为保持可读性，画布只绘制权重较高的节点与边；顶部计数保留当前快照的总量。
          </p>
        ) : null}
      </div>

      <aside className="rounded-xl border border-slate-800 bg-slate-950/45 p-5 xl:sticky xl:top-4 xl:self-start">
        {selectedNode ? (
          <>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400">
              {operatorActor(operatorIdentity, selectedNode.id)
                ? "运营者实名视图"
                : "姓名尚未同步"}
            </p>
            <h3 className="mt-2 font-mono text-xl font-bold text-slate-50">
              {operatorActorLabel(operatorIdentity, selectedNode.id, selectedNode.label)}
            </h3>
            {operatorActor(operatorIdentity, selectedNode.id) ? (
              <code className="mt-1 block text-xs text-cyan-300">
                @{operatorActor(operatorIdentity, selectedNode.id)?.accountName}
              </code>
            ) : (
              <p className="mt-2 rounded-lg border border-slate-800 bg-slate-950/55 p-3 text-xs leading-5 text-slate-500">
                该节点已有真实互动记录，但当前本机身份目录没有与其平台账号同期的姓名映射。姓名匹配与角色判断是两条独立证据链。
              </p>
            )}
            <p className="mt-1 text-xs text-slate-500">
              {roleLabel(selectedNode.role)}
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <StatCell
                label="事件"
                value={selectedNode.eventCount}
              />
              <StatCell
                label="讨论发起"
                value={selectedNode.authoredThreadCount}
              />
              <StatCell
                label="回复"
                value={selectedNode.replyCount}
              />
              <StatCell
                label="不同相邻成员"
                value={selectedNode.distinctPeerCount}
              />
              <StatCell
                label="入向权重"
                value={selectedNode.inboundWeight}
              />
              <StatCell
                label="出向权重"
                value={selectedNode.outboundWeight}
              />
            </div>
            <dl className="mt-5 space-y-3 border-t border-slate-800 pt-4 text-xs">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">近 30 天系统触达</dt>
                <dd className="font-mono text-slate-200">
                  {selectedNode.systemTouchCount30d}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">最近事件</dt>
                <dd className="font-mono text-slate-200">
                  {dateTime(selectedNode.lastSeenAt)}
                </dd>
              </div>
            </dl>
            <p className="mt-4 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-[11px] leading-5 text-slate-500">
              这些是当前快照的描述性互动计数，不代表学习能力、人格、教育效果或因果影响。
            </p>
          </>
        ) : (
          <EmptyState title="选择一个节点查看互动摘要">
            点击画布中的节点，或展开“浏览节点”使用键盘选择。默认不主动展示任意成员的详情。
          </EmptyState>
        )}
      </aside>
    </div>
  );
}

function coverageLabel(
  status: "complete" | "lower_bound" | "insufficient_data"
): string {
  if (status === "complete") return "完整窗口";
  if (status === "lower_bound") return "当前可观察下界";
  return "证据不足";
}

function LearnerPositionView({
  model,
  operatorIdentity,
  idPrefix,
  windowKind,
  focusedLearnerId,
  onWindowChange,
  onFocusLearner
}: {
  model: AutonomyWorldReadModel;
  operatorIdentity?: OperatorCourseIdentityOverlay | null;
  idPrefix: string;
  windowKind: WorldWindowKind;
  focusedLearnerId: string | null;
  onWindowChange: (window: WorldWindowKind) => void;
  onFocusLearner: (actorId: string) => void;
}) {
  const positions = useMemo(
    () =>
      rankWeakestLearnerPositions(
        model.learnerPositions.filter(
          (position) => position.windowKind === windowKind
        )
      ),
    [model.learnerPositions, windowKind]
  );
  const focusedLearner =
    positions.find(
      (position) => position.actorId === focusedLearnerId
    ) ?? null;

  if (model.graph.roleRegistryStatus !== "complete") {
    return (
      <EmptyState title="学习者角色证据尚未就绪">
        本视图只接受课程角色注册表明确标注为 learner
        的匿名节点。当前不会把活跃成员、帖子作者或外部账号自动推断为学习者。
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/35 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="font-semibold text-slate-100">
            已验证学习者的网络位置
          </h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            只展示原始互动计数；k-core 与 PageRank
            仅在完整覆盖和足量网络证据下计算。连通分量只描述当前可连接证据，不等同于学习者的社会孤立程度。
          </p>
        </div>
        <div
          role="tablist"
          aria-label="网络位置时间窗口"
          className="inline-flex self-start rounded-lg border border-slate-800 bg-slate-950/70 p-1"
        >
          {WINDOW_META.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`${idPrefix}-learner-window-tab-${id}`}
              aria-selected={windowKind === id}
              aria-controls={`${idPrefix}-learner-window-panel-${id}`}
              tabIndex={windowKind === id ? 0 : -1}
              onClick={() => onWindowChange(id)}
              onKeyDown={(event) =>
                selectTabFromKeyboard({
                  event,
                  index: WINDOW_META.findIndex(([windowId]) => windowId === id),
                  count: WINDOW_META.length,
                  onSelect: (nextIndex) =>
                    onWindowChange(WINDOW_META[nextIndex][0])
                })
              }
              className={`inline-flex min-h-[44px] items-center rounded-md px-3 py-2 text-xs font-semibold transition focus:outline-none focus:ring-2 focus:ring-cyan-400/70 ${
                windowKind === id
                  ? "bg-cyan-400/15 text-cyan-100"
                  : "text-slate-500 hover:text-slate-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {model.graph.coverageStatus !== "complete" ? (
        <p className="rounded-lg border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-xs leading-5 text-amber-100/85">
          当前真实数据处于覆盖删失状态：互动计数只表示当前可观察下界；没有补算 k-core 或 PageRank。当前不可连接的证据不能解释为学习者社会孤立。
        </p>
      ) : null}

      {focusedLearner ? (
        <section
          aria-live="polite"
          aria-label="当前聚焦学习者安全摘要"
          data-testid="world-focused-learner"
          className="rounded-xl border border-cyan-400/35 bg-cyan-400/[0.06] px-4 py-4"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">
                {operatorActor(operatorIdentity, focusedLearner.actorId)
                  ? "当前上下文 · 运营者实名视图"
                  : "当前上下文 · 匿名学习者"}
              </p>
              <h4 className="mt-1 font-mono text-base font-bold text-cyan-50">
                {operatorActorLabel(
                  operatorIdentity,
                  focusedLearner.actorId,
                  focusedLearner.actorLabel
                )}
              </h4>
              <p className="mt-2 text-xs leading-5 text-slate-400">
                {coverageLabel(focusedLearner.coverageStatus)} · 双向同伴 {focusedLearner.reciprocalPeerCount} · 去重连接 {uniquePeerCount(focusedLearner)} · 事件 {focusedLearner.eventCount}
              </p>
            </div>
            <span className="self-start rounded-full border border-cyan-400/25 bg-slate-950/45 px-3 py-1 font-mono text-xs text-cyan-200">
              可安全附加到控制台
            </span>
          </div>
          <p className="mt-3 text-[11px] leading-5 text-slate-500">
            摘要只含本地匿名标签和聚合计数，不含论坛正文、平台身份或原始成员键。
          </p>
        </section>
      ) : null}

      {WINDOW_META.map(([id, label]) => (
        <div
          key={id}
          id={`${idPrefix}-learner-window-panel-${id}`}
          role="tabpanel"
          aria-labelledby={`${idPrefix}-learner-window-tab-${id}`}
          hidden={windowKind !== id}
        >
          {positions.length > 0 ? (
            <div
              tabIndex={0}
              aria-label={`${label}学习者位置表，可横向滚动`}
              className="overflow-x-auto rounded-xl border border-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-400/70"
            >
              <table className="w-full min-w-[980px] text-left text-sm">
                <caption className="sr-only">
                  {label}已验证学习者的描述性网络位置；覆盖不完整时 k-core 与 PageRank 显示为未计算。
                </caption>
                <thead className="border-b border-slate-800 bg-slate-950/65 text-xs uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                <th scope="col" className="px-4 py-3">本地标签</th>
                <th scope="col" className="px-3 py-3">证据覆盖</th>
                <th scope="col" className="px-3 py-3 text-right">事件</th>
                <th scope="col" className="px-3 py-3 text-right">发起讨论</th>
                <th scope="col" className="px-3 py-3 text-right">回复</th>
                <th scope="col" className="px-3 py-3 text-right">入向 / 出向</th>
                <th scope="col" className="px-3 py-3 text-right">双向同伴</th>
                <th scope="col" className="px-3 py-3 text-right">连通分量</th>
                <th scope="col" className="px-3 py-3 text-right">k-core</th>
                <th scope="col" className="px-4 py-3 text-right">PageRank</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 bg-slate-950/30">
              {positions.map((position) => (
                <tr
                  key={position.id}
                  data-focused={
                    position.actorId === focusedLearnerId
                      ? "true"
                      : undefined
                  }
                  className={`transition hover:bg-slate-900/60 ${
                    position.actorId === focusedLearnerId
                      ? "bg-cyan-400/[0.08] ring-1 ring-inset ring-cyan-400/30"
                      : ""
                  }`}
                >
                  <td className="px-4 py-2 font-mono text-xs font-bold text-cyan-100">
                    <button
                      type="button"
                      aria-pressed={position.actorId === focusedLearnerId}
                      onClick={() => onFocusLearner(position.actorId)}
                      className="min-h-11 rounded-md px-2 text-left outline-none transition hover:bg-cyan-400/10 focus:ring-2 focus:ring-cyan-400/70"
                    >
                      {operatorActorLabel(operatorIdentity, position.actorId, position.actorLabel)}
                    </button>
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={`rounded-full px-2 py-1 text-xs ${
                        position.coverageStatus === "complete"
                          ? "bg-emerald-400/10 text-emerald-300"
                          : position.coverageStatus ===
                              "lower_bound"
                            ? "bg-amber-400/10 text-amber-300"
                            : "bg-slate-700/50 text-slate-400"
                      }`}
                    >
                      {coverageLabel(position.coverageStatus)}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-200">
                    {position.eventCount}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-200">
                    {position.authoredThreadCount}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-200">
                    {position.replyCount}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-200">
                    {position.inboundReplyCount} /{" "}
                    {position.outboundReplyCount}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-200">
                    {position.reciprocalPeerCount}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-200">
                    {position.componentSize}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-200">
                    {position.coverageStatus === "complete" &&
                    position.kCore !== null
                      ? position.kCore
                      : "未计算"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-200">
                    {position.coverageStatus === "complete" &&
                    position.pageRank !== null
                      ? position.pageRank.toFixed(4)
                      : "未计算"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="该窗口没有可展示的学习者位置">
          角色注册表已就绪，但当前窗口没有 learner
          节点，或尚未形成符合投影契约的互动事件。
        </EmptyState>
          )}
        </div>
      ))}
    </div>
  );
}

export function WorldGraphExplorer({
  model,
  initialState = DEFAULT_WORLD_EXPLORER_STATE,
  operatorIdentity = null
}: {
  model: AutonomyWorldReadModel;
  initialState?: WorldExplorerState;
  operatorIdentity?: OperatorCourseIdentityOverlay | null;
}) {
  const explorerId = useId();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [explorerState, setExplorerState] =
    useState<WorldExplorerState>(initialState);
  const [bridgeRevision, setBridgeRevision] = useState(1);
  const [attachedContexts, setAttachedContexts] = useState<
    PageBridgeContext[]
  >([]);
  const explorerStateRef = useRef(explorerState);
  const bridgeRevisionRef = useRef(bridgeRevision);
  const attachedContextsRef = useRef(attachedContexts);
  const view = explorerState.view;
  const positionsInWindow = useMemo(
    () =>
      rankWeakestLearnerPositions(
        model.learnerPositions.filter(
          (position) =>
            position.windowKind === explorerState.window
        )
      ),
    [explorerState.window, model.learnerPositions]
  );
  const focusedLearner =
    explorerState.focus === "weakest"
      ? positionsInWindow[0] ?? null
      : positionsInWindow.find(
          (position) =>
            position.actorId === explorerState.focus
        ) ?? null;

  useEffect(() => {
    const nextState = {
      view: initialState.view,
      window: initialState.window,
      focus: initialState.focus
    };
    explorerStateRef.current = nextState;
    setExplorerState(nextState);
  }, [initialState.focus, initialState.view, initialState.window]);

  const selectExplorerState = useCallback(
    (next: WorldExplorerState, revision?: number) => {
      explorerStateRef.current = next;
      setExplorerState(next);
      bridgeRevisionRef.current =
        revision ?? bridgeRevisionRef.current + 1;
      setBridgeRevision(bridgeRevisionRef.current);
      const params = new URLSearchParams(searchParams.toString());
      params.set("view", next.view);
      params.set("window", next.window);
      if (next.focus) {
        params.set("focus", next.focus);
      } else {
        params.delete("focus");
      }
      router.replace(`${pathname}?${params.toString()}`, {
        scroll: false
      });
    },
    [pathname, router, searchParams]
  );

  useEffect(() => {
    return registerPageBridge({
      routeId: "autonomy.world",
      capabilities: [
        "world.focus_weakest",
        "world.set_view",
        "world.set_window",
        "world.focus_learner",
        "context.attach_focused"
      ],
      readState: () =>
        createWorldPageBridgeState({
          model,
          explorerState: explorerStateRef.current,
          attachedContexts: attachedContextsRef.current,
          revision: bridgeRevisionRef.current
        }),
      execute: (action) => {
        const transition = transitionWorldPageAction({
          model,
          action,
          current: {
            explorerState: explorerStateRef.current,
            attachedContexts: attachedContextsRef.current,
            revision: bridgeRevisionRef.current
          }
        });
        if (transition.next !== undefined && transition.outcome.status === "completed") {
          attachedContextsRef.current = transition.next.attachedContexts;
          setAttachedContexts(transition.next.attachedContexts);
          if (
            transition.next.explorerState !==
            explorerStateRef.current
          ) {
            selectExplorerState(
              transition.next.explorerState,
              transition.next.revision
            );
          } else {
            bridgeRevisionRef.current = transition.next.revision;
            setBridgeRevision(transition.next.revision);
          }
        }
        return transition.outcome;
      }
    });
  }, [model, selectExplorerState]);

  return (
    <GlassCard
      className="overflow-hidden p-0"
      data-testid="world-explorer"
    >
      <div className="border-b border-slate-800 bg-slate-950/35 px-4 py-3 sm:px-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h2 className="text-base font-bold text-slate-50">
              课程世界视图
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              切换成员互动、课程结构与具有可信角色证据的学习者位置。
            </p>
          </div>
          <div
            role="tablist"
            aria-label="课程事件世界视图"
            className="grid gap-2 sm:grid-cols-3"
          >
            {VIEW_META.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`${explorerId}-view-tab-${item.id}`}
                aria-selected={view === item.id}
                aria-controls={`${explorerId}-view-panel-${item.id}`}
                tabIndex={view === item.id ? 0 : -1}
                onClick={() =>
                  selectExplorerState({
                    ...explorerState,
                    view: item.id
                  })
                }
                onKeyDown={(event) =>
                  selectTabFromKeyboard({
                    event,
                    index: VIEW_META.findIndex(
                      (candidate) => candidate.id === item.id
                    ),
                    count: VIEW_META.length,
                    onSelect: (nextIndex) =>
                      selectExplorerState({
                        ...explorerState,
                        view: VIEW_META[nextIndex].id
                      })
                  })
                }
                className={`min-h-[44px] min-w-[148px] rounded-md border px-3 py-2 text-left transition focus:outline-none focus:ring-2 focus:ring-cyan-400/70 ${
                  view === item.id
                    ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-50"
                    : "border-slate-800 bg-slate-950/45 text-slate-400 hover:border-slate-600 hover:text-slate-200"
                }`}
              >
                <span className="block text-sm font-bold">
                  {item.label}
                </span>
                <span className="mt-1 block text-xs text-slate-500">
                  {item.kicker}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {VIEW_META.map((item) => (
        <div
          key={item.id}
          id={`${explorerId}-view-panel-${item.id}`}
          role="tabpanel"
          aria-labelledby={`${explorerId}-view-tab-${item.id}`}
          hidden={view !== item.id}
          className="p-4 sm:p-6"
        >
          {view === item.id && item.id === "course_structure" ? (
            <CourseStructureView model={model} operatorIdentity={operatorIdentity} />
          ) : view === item.id && item.id === "community_network" ? (
            <CommunityNetworkView
              model={model}
              initialFocus={explorerState.focus}
              operatorIdentity={operatorIdentity}
            />
          ) : view === item.id ? (
            <LearnerPositionView
              model={model}
              operatorIdentity={operatorIdentity}
              idPrefix={explorerId}
              windowKind={explorerState.window}
              focusedLearnerId={focusedLearner?.actorId ?? null}
              onWindowChange={(windowKind) =>
                selectExplorerState({
                  ...explorerState,
                  window: windowKind
                })
              }
              onFocusLearner={(actorId) =>
                selectExplorerState({
                  view: "learner_position",
                  window: explorerState.window,
                  focus: actorId
                })
              }
            />
          ) : null}
        </div>
      ))}
    </GlassCard>
  );
}
