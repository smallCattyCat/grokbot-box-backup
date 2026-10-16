import {
  APP_ROUTES,
  type AppRouteDefinition,
  type AppRouteId,
  type CanonicalAppHref
} from "./app-routes";

export const AGENT_COMMAND_PLAN_VERSION = "cmooc.agent-command-plan.v3" as const;

export type AgentCollaborationMode = "default" | "plan";

export type NavigateAction = {
  id: string;
  type: "navigate";
  routeId: AppRouteId;
  href: CanonicalAppHref;
  label: string;
};

export type AppGoBackAction = {
  id: string;
  type: "app.go_back";
};

export type AppRefreshAction = {
  id: string;
  type: "app.refresh";
};

export type WorldFocusWeakestAction = {
  id: string;
  type: "world.focus_weakest";
  routeId: "autonomy.world";
  strategy: "lowest_observable_connections";
  window: "current_observable";
};

export type ContextAttachFocusedAction = {
  id: string;
  type: "context.attach_focused";
  routeId: "autonomy.world";
  contextKind: "learner";
};

export type WorldSetViewAction = {
  id: string;
  type: "world.set_view";
  routeId: "autonomy.world";
  view: "community_network" | "course_structure" | "learner_position";
};

export type WorldSetWindowAction = {
  id: string;
  type: "world.set_window";
  routeId: "autonomy.world";
  window: "rolling_7d" | "rolling_30d" | "all_time";
};

export type WorldFocusLearnerAction = {
  id: string;
  type: "world.focus_learner";
  routeId: "autonomy.world";
  learnerLabel: string;
};

export type WorkbenchShowSurfaceAction = {
  id: string;
  type: "workbench.show_surface";
  routeId: "workbench";
  surface: "conversation" | "schedule" | "history";
};

export type WorkbenchSetModeAction = {
  id: string;
  type: "workbench.set_mode";
  routeId: "workbench";
  mode: AgentCollaborationMode;
};

export type WorkbenchSetGoalAction = {
  id: string;
  type: "workbench.set_goal";
  routeId: "workbench";
  enabled: boolean;
};

export type WorkbenchStopAction = {
  id: string;
  type: "workbench.stop";
  routeId: "workbench";
};

export type PlatformInspectReadinessAction = {
  id: string;
  type: "platform.inspect_readiness";
  routeId: "platform";
  targetInput?: string;
};

export type WorkbenchDelegateAction = {
  id: string;
  type: "workbench.delegate";
  prompt: string;
  collaborationMode: AgentCollaborationMode;
  goalMode: boolean;
  contextFromPreviousActions: boolean;
};

export type AgentCommandAction =
  | NavigateAction
  | AppGoBackAction
  | AppRefreshAction
  | WorldFocusWeakestAction
  | ContextAttachFocusedAction
  | WorldSetViewAction
  | WorldSetWindowAction
  | WorldFocusLearnerAction
  | WorkbenchShowSurfaceAction
  | WorkbenchSetModeAction
  | WorkbenchSetGoalAction
  | WorkbenchStopAction
  | PlatformInspectReadinessAction
  | WorkbenchDelegateAction;

export type AgentCommandPlan = {
  schemaVersion: typeof AGENT_COMMAND_PLAN_VERSION;
  command: string;
  kind: "local" | "hybrid" | "delegated";
  collaborationMode: AgentCollaborationMode;
  goalMode: boolean;
  actions: readonly AgentCommandAction[];
  coverage: {
    status: "complete" | "partial" | "delegated";
    recognizedActionIds: readonly string[];
    residual: string;
  };
  safety: {
    localOnly: boolean;
    externalReads: boolean;
    externalWrites: false;
    requiresConfirmation: false;
  };
};

type LocalActionWithoutId =
  | Omit<NavigateAction, "id">
  | Omit<AppGoBackAction, "id">
  | Omit<AppRefreshAction, "id">
  | Omit<WorldFocusWeakestAction, "id">
  | Omit<ContextAttachFocusedAction, "id">
  | Omit<WorldSetViewAction, "id">
  | Omit<WorldSetWindowAction, "id">
  | Omit<WorldFocusLearnerAction, "id">
  | Omit<WorkbenchShowSurfaceAction, "id">
  | Omit<WorkbenchSetModeAction, "id">
  | Omit<WorkbenchSetGoalAction, "id">
  | Omit<WorkbenchStopAction, "id">
  | Omit<PlatformInspectReadinessAction, "id">;

type PositionedAction = {
  position: number;
  priority: number;
  action: LocalActionWithoutId;
};

type RecognizedSpan = {
  start: number;
  end: number;
};

const PLAN_LANGUAGE =
  /(?:计划模式|plan\s*mode|先.{0,8}(?:规划|计划)|制定.{0,8}(?:计划|方案)|(?:请|帮我).{0,4}规划|规划(?:一下|后再|步骤|方案)|支持计划|实施方案)/iu;
const GOAL_LANGUAGE =
  /(?:goal\s*mode|目标模式|持续目标|持续(?:跟进|执行|运行|观察|推进|处理|优化|完成|改进|修复)|长期跟进|继续跟进|跟进到底|直到|完成为止|不要停止|不停止|自动继续|反复执行)/iu;
const WEAKEST_LANGUAGE =
  /(?:(?:连接|互动|交互|联系).{0,10}(?:最弱|最少|最低)|(?:最弱|最少|最低|最孤立|边缘).{0,10}(?:学习者|学生|连接|互动))/iu;
const ATTACH_CONTEXT_LANGUAGE =
  /(?:(?:加入|添加|放入|带入|附加到).{0,12}(?:当前)?(?:任务)?上下文|上下文.{0,8}(?:加入|添加|附加))/iu;
const DELEGATED_WORK_LANGUAGE =
  /(?:制定|分析|比较|解释|总结|优化|修复|检查|排查|实现|编写|生成|设计|测试|验证|研究|调查|评估|继续完成|提出建议|支持计划|行动计划|方案)/iu;
const STANDALONE_URL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu;
const NAVIGATION_LANGUAGE =
  /(?:打开|去|进入|查看|看看|跳转(?:到|至)?|切换(?:到|至)?|回到|返回(?:到|至)?|带我到|前往|访问)\s*(?:一下|这个|那个|当前)?$/u;
const APP_GO_BACK_LANGUAGE =
  /(?:(?:返回|退回)(?:到)?(?:浏览器)?(?:的)?(?:上一页|前一页|上一个页面)|(?:浏览器)?(?:后退|回退)(?:一页)?)/iu;
const APP_REFRESH_LANGUAGE =
  /(?:(?:刷新|重新加载|重载)(?:一下)?(?:当前|这个|本)?(?:页面|网页)|(?:当前|这个|本)(?:页面|网页)(?:刷新|重新加载|重载)|^(?:请)?(?:刷新|重新加载|重载)(?:一下)?$)/iu;
const WORKBENCH_STOP_LANGUAGE =
  /(?:停止|终止|中止|取消)(?:一下)?(?:当前|这个|本次)?(?:的)?(?:控制台|智能体|本机执行)?(?:任务|运行)(?!\s*的?\s*(?:安全|限制|按钮|逻辑|机制|配置|策略))/iu;
const PLATFORM_READINESS_LANGUAGE =
  /(?:只读\s*(?:页面|平台|课程)?\s*(?:诊断|检查|巡检|观察|就绪检查)|(?:诊断|检查|巡检|观察|就绪检查).{0,8}只读)/iu;
const CMOOC_COURSE_PATH = /^\/cmooc\/course\/?$/iu;
const CMOOC_COURSE_ID = /^\d{8,127}$/u;
const SENSITIVE_QUERY_MARKER =
  /(?:token|auth|authorization|cookie|session|password|secret|credential|jwt)/iu;

const WORLD_VIEW_PATTERNS: ReadonlyArray<{
  expression: RegExp;
  view: WorldSetViewAction["view"];
}> = [
  {
    expression: /(?:切换(?:到|至)?|查看|显示|打开)?\s*(?:课程结构|结构视图)/iu,
    view: "course_structure"
  },
  {
    expression: /(?:切换(?:到|至)?|查看|显示|打开)?\s*(?:学习者位置|学习者视图|位置视图)/iu,
    view: "learner_position"
  },
  {
    expression: /(?:切换(?:到|至)?|查看|显示)\s*(?:社会网络|社区网络|网络)(?:视图)?|(?:社会网络|社区网络)视图/iu,
    view: "community_network"
  }
];

const WORLD_WINDOW_PATTERNS: ReadonlyArray<{
  expression: RegExp;
  window: WorldSetWindowAction["window"];
}> = [
  {
    expression: /(?:切换(?:到|至)?|查看|显示|筛选(?:到|为)?|使用)?\s*(?:最近|近)?\s*(?:7|七)\s*天(?:窗口|范围)?/iu,
    window: "rolling_7d"
  },
  {
    expression: /(?:切换(?:到|至)?|查看|显示|筛选(?:到|为)?|使用)?\s*(?:最近|近)?\s*(?:30|三十)\s*天(?:窗口|范围)?/iu,
    window: "rolling_30d"
  },
  {
    expression: /(?:切换(?:到|至)?|查看|显示|筛选(?:到|为)?|使用)?\s*(?:全时段|全部时间|所有时间|完整历史|历史全部)/iu,
    window: "all_time"
  }
];

const NAMED_LEARNER_LANGUAGE =
  /(?:选择|聚焦|定位|查看)\s*学习者\s*0*(\d{1,6})/iu;

const WORKBENCH_SURFACE_PATTERNS: ReadonlyArray<{
  expression: RegExp;
  surface: WorkbenchShowSurfaceAction["surface"];
}> = [
  {
    expression: /(?:打开|查看|切换(?:到|至)?)?\s*(?:周期运行|运行周期|调度计划|调度视图)/iu,
    surface: "schedule"
  },
  {
    expression: /(?:回到|打开|查看|切换(?:到|至)?)\s*(?:任务对话|对话区|对话视图)/iu,
    surface: "conversation"
  },
  {
    expression: /(?:打开|查看|展开|切换(?:到|至)?)\s*(?:任务历史|历史任务|运行历史)/iu,
    surface: "history"
  }
];

const WORKBENCH_MODE_PATTERNS: ReadonlyArray<{
  expression: RegExp;
  mode: WorkbenchSetModeAction["mode"];
}> = [
  {
    expression: /(?:切换|设置|开启|进入)(?:到|至|为)?\s*(?:计划模式|plan\s*mode)/iu,
    mode: "plan"
  },
  {
    expression: /(?:退出|关闭)\s*(?:计划模式|plan\s*mode)|(?:切换|设置)(?:到|至|为)?\s*(?:默认模式|普通模式)/iu,
    mode: "default"
  }
];

const WORKBENCH_GOAL_PATTERNS: ReadonlyArray<{
  expression: RegExp;
  enabled: boolean;
}> = [
  {
    expression: /(?:开启|启用|打开)\s*(?:持续目标|目标模式|goal\s*mode)/iu,
    enabled: true
  },
  {
    expression: /(?:关闭|停用|退出)\s*(?:持续目标|目标模式|goal\s*mode)/iu,
    enabled: false
  }
];

function firstMatchIndex(expression: RegExp, value: string): number | null {
  const match = expression.exec(value);
  return match?.index ?? null;
}

function firstMatch(expression: RegExp, value: string): RegExpExecArray | null {
  expression.lastIndex = 0;
  return expression.exec(value);
}

function isNegatedMatch(value: string, match: RegExpExecArray): boolean {
  const prefix = value.slice(Math.max(0, match.index - 12), match.index);
  return /(?:不要|别|无需|不必|禁止|不可|不能|不想|不希望|暂不|暂时不要|暂时不想|先不)(?:再)?\s*$/u.test(
    prefix
  );
}

function latestPatternValue<T>(
  patterns: ReadonlyArray<{ expression: RegExp; value: T }>,
  command: string
): T | null {
  let latest: { position: number; value: T } | null = null;
  for (const candidate of patterns) {
    const match = firstMatch(candidate.expression, command);
    if (match && (!latest || match.index >= latest.position)) {
      latest = { position: match.index, value: candidate.value };
    }
  }
  return latest?.value ?? null;
}

function findTrustedCmoocCourseTarget(command: string): {
  targetInput: string;
  start: number;
  end: number;
} | null {
  const urlPattern = /https:\/\/[^\s<>"'）)\]}，。；;]+/giu;
  for (const match of command.matchAll(urlPattern)) {
    const targetInput = match[0];
    try {
      const parsed = new URL(targetInput);
      const courseId = parsed.searchParams.get("courseId");
      const hasSensitiveQuery = [...parsed.searchParams.keys()].some((key) =>
        SENSITIVE_QUERY_MARKER.test(key.replace(/[-_]/gu, ""))
      );
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname.toLocaleLowerCase("en-US") !== "cmooc.bnu.edu.cn" ||
        parsed.port !== "" ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.hash !== "" ||
        !CMOOC_COURSE_PATH.test(parsed.pathname) ||
        !courseId ||
        !CMOOC_COURSE_ID.test(courseId) ||
        hasSensitiveQuery
      ) {
        continue;
      }
      return {
        targetInput,
        start: match.index,
        end: match.index + targetInput.length
      };
    } catch {
      // Keep looking for another independently valid, explicit course URL.
    }
  }
  return null;
}

function routeTerms(route: AppRouteDefinition): readonly string[] {
  return [
    ...(route.href === "/" ? [] : [route.href]),
    route.label,
    ...route.aliases
  ]
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => right.length - left.length);
}

function findRouteMentions(command: string): Array<{
  route: AppRouteDefinition;
  position: number;
  length: number;
}> {
  const trimmedCommand = command.trim();
  if (STANDALONE_URL.test(trimmedCommand)) return [];
  const normalizedCommand = trimmedCommand.toLocaleLowerCase("zh-CN");
  const commandWithoutPunctuation = normalizedCommand.replace(
    /[。！？!?.]+$/u,
    ""
  );

  const mentions: Array<{
    route: AppRouteDefinition;
    position: number;
    length: number;
  }> = [];
  for (const route of APP_ROUTES) {
    let earliest =
      commandWithoutPunctuation === route.href
        ? 0
        : Number.POSITIVE_INFINITY;
    let matchedLength = earliest === 0 ? route.href.length : 0;
    for (const term of routeTerms(route)) {
      const normalizedTerm = term.toLocaleLowerCase("zh-CN");
      if (
        commandWithoutPunctuation === normalizedTerm ||
        commandWithoutPunctuation === `${normalizedTerm}页面`
      ) {
        earliest = 0;
        matchedLength = normalizedTerm.length;
        break;
      }

      let searchFrom = 0;
      while (searchFrom < normalizedCommand.length) {
        const position = normalizedCommand.indexOf(normalizedTerm, searchFrom);
        if (position < 0) break;
        const prefix = normalizedCommand.slice(
          Math.max(0, position - 16),
          position
        );
        if (NAVIGATION_LANGUAGE.test(prefix) && position < earliest) {
          earliest = position;
          matchedLength = normalizedTerm.length;
        }
        searchFrom = position + Math.max(normalizedTerm.length, 1);
      }
    }
    if (Number.isFinite(earliest)) {
      mentions.push({ route, position: earliest, length: matchedLength });
    }
  }
  return mentions.sort((left, right) => left.position - right.position);
}

function addSpan(spans: RecognizedSpan[], match: RegExpExecArray): void {
  spans.push({ start: match.index, end: match.index + match[0].length });
}

function meaningfulResidual(
  command: string,
  spans: readonly RecognizedSpan[]
): string {
  if (!spans.length) return command;
  const masked = [...command];
  for (const span of spans) {
    for (
      let index = Math.max(0, span.start);
      index < Math.min(masked.length, span.end);
      index += 1
    ) {
      masked[index] = " ";
    }
  }
  return masked
    .join("")
    .replace(/[，,。！？!?.；;：:、（）()\[\]{}]/gu, " ")
    .replace(/(?:然后|接着|随后|同时|以及|并且|并|再|最后)/gu, " ")
    .replace(/(?:请|帮我|麻烦|一下|这个|那个|当前|页面)/gu, " ")
    .replace(/(?:打开|去|进入|查看|看看|跳转(?:到|至)?|切换(?:到|至)?|回到|返回(?:到|至)?|带我到|前往|访问|找到)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function ensureRouteBeforeActions(input: {
  localActions: PositionedAction[];
  routeId: "autonomy.world" | "workbench" | "platform";
  firstActionPosition: number;
}): void {
  const route = APP_ROUTES.find((candidate) => candidate.id === input.routeId);
  if (!route) return;
  const existing = input.localActions.find(
    ({ action }) => action.type === "navigate" && action.routeId === input.routeId
  );
  if (!existing) {
    input.localActions.push({
      position: input.firstActionPosition - 0.5,
      priority: 0,
      action: navigationAction(route)
    });
  } else if (existing.position > input.firstActionPosition) {
    existing.position = input.firstActionPosition - 0.5;
  }
}

function navigationAction(route: AppRouteDefinition): Omit<NavigateAction, "id"> {
  return {
    type: "navigate",
    routeId: route.id,
    href: route.href,
    label: route.label
  };
}

export function inferCommandModes(command: string): {
  collaborationMode: AgentCollaborationMode;
  goalMode: boolean;
} {
  const explicitCollaborationMode = latestPatternValue(
    WORKBENCH_MODE_PATTERNS.map(({ expression, mode }) => ({
      expression,
      value: mode
    })),
    command
  );
  const explicitGoalMode = latestPatternValue(
    WORKBENCH_GOAL_PATTERNS.map(({ expression, enabled }) => ({
      expression,
      value: enabled
    })),
    command
  );
  return {
    collaborationMode:
      explicitCollaborationMode ?? (PLAN_LANGUAGE.test(command) ? "plan" : "default"),
    goalMode: explicitGoalMode ?? GOAL_LANGUAGE.test(command)
  };
}

export function planAgentCommand(rawCommand: string): AgentCommandPlan {
  const command = rawCommand.trim();
  const modes = inferCommandModes(command);
  const routeMentions = findRouteMentions(command);
  const focusPosition = firstMatchIndex(WEAKEST_LANGUAGE, command);
  const attachPosition = firstMatchIndex(ATTACH_CONTEXT_LANGUAGE, command);
  const localActions: PositionedAction[] = [];
  const recognizedSpans: RecognizedSpan[] = [];

  const goBackMatch = firstMatch(APP_GO_BACK_LANGUAGE, command);
  if (goBackMatch) {
    addSpan(recognizedSpans, goBackMatch);
    localActions.push({
      position: goBackMatch.index,
      priority: 0,
      action: { type: "app.go_back" }
    });
  }

  const refreshMatch = firstMatch(APP_REFRESH_LANGUAGE, command);
  if (refreshMatch) {
    addSpan(recognizedSpans, refreshMatch);
    localActions.push({
      position: refreshMatch.index,
      priority: 0,
      action: { type: "app.refresh" }
    });
  }

  for (const mention of routeMentions) {
    localActions.push({
      position: mention.position,
      priority: 0,
      action: navigationAction(mention.route)
    });
    recognizedSpans.push({
      start: mention.position,
      end: mention.position + mention.length
    });
  }

  if (focusPosition !== null || attachPosition !== null) {
    const firstWorldActionPosition = Math.min(
      focusPosition ?? Number.POSITIVE_INFINITY,
      attachPosition ?? Number.POSITIVE_INFINITY
    );
    const worldRoute = APP_ROUTES.find(
      (route) => route.id === "autonomy.world"
    );
    const existingWorldNavigation = localActions.find(
      ({ action }) =>
        action.type === "navigate" && action.routeId === "autonomy.world"
    );
    if (worldRoute && !existingWorldNavigation) {
      localActions.push({
        position: firstWorldActionPosition - 0.5,
        priority: 0,
        action: navigationAction(worldRoute)
      });
    } else if (
      existingWorldNavigation &&
      existingWorldNavigation.position > firstWorldActionPosition
    ) {
      existingWorldNavigation.position = firstWorldActionPosition - 0.5;
    }
  }

  if (focusPosition !== null) {
    const match = firstMatch(WEAKEST_LANGUAGE, command);
    if (match) {
      addSpan(recognizedSpans, match);
      const suffix = command
        .slice(match.index + match[0].length)
        .match(/^(?:的)?(?:学习者|学生)/u);
      if (suffix) {
        recognizedSpans.push({
          start: match.index + match[0].length,
          end: match.index + match[0].length + suffix[0].length
        });
      }
    }
    localActions.push({
      position: focusPosition,
      priority: 1,
      action: {
        type: "world.focus_weakest",
        routeId: "autonomy.world",
        strategy: "lowest_observable_connections",
        window: "current_observable"
      }
    });
  }

  if (attachPosition !== null) {
    const match = firstMatch(ATTACH_CONTEXT_LANGUAGE, command);
    if (match) addSpan(recognizedSpans, match);
    localActions.push({
      position: attachPosition,
      priority: 2,
      action: {
        type: "context.attach_focused",
        routeId: "autonomy.world",
        contextKind: "learner"
      }
    });
  }


  for (const candidate of WORLD_WINDOW_PATTERNS) {
    const match = firstMatch(candidate.expression, command);
    if (!match) continue;
    addSpan(recognizedSpans, match);
    localActions.push({
      position: match.index,
      priority: 1,
      action: {
        type: "world.set_window",
        routeId: "autonomy.world",
        window: candidate.window
      }
    });
    break;
  }

  for (const candidate of WORLD_VIEW_PATTERNS) {
    const match = firstMatch(candidate.expression, command);
    if (!match) continue;
    addSpan(recognizedSpans, match);
    localActions.push({
      position: match.index,
      priority: 2,
      action: {
        type: "world.set_view",
        routeId: "autonomy.world",
        view: candidate.view
      }
    });
    break;
  }

  const namedLearnerMatch = firstMatch(NAMED_LEARNER_LANGUAGE, command);
  if (namedLearnerMatch) {
    addSpan(recognizedSpans, namedLearnerMatch);
    const learnerNumber = Number.parseInt(namedLearnerMatch[1] ?? "", 10);
    localActions.push({
      position: namedLearnerMatch.index,
      priority: 3,
      action: {
        type: "world.focus_learner",
        routeId: "autonomy.world",
        learnerLabel: `学习者 ${String(learnerNumber).padStart(2, "0")}`
      }
    });
  }

  const worldPageActions = localActions.filter(({ action }) =>
    action.type.startsWith("world.") || action.type === "context.attach_focused"
  );
  if (worldPageActions.length) {
    ensureRouteBeforeActions({
      localActions,
      routeId: "autonomy.world",
      firstActionPosition: Math.min(...worldPageActions.map(({ position }) => position))
    });
  }

  const platformReadinessMatch = firstMatch(
    PLATFORM_READINESS_LANGUAGE,
    command
  );
  const platformTarget = findTrustedCmoocCourseTarget(command);
  if (platformReadinessMatch && platformTarget) {
    addSpan(recognizedSpans, platformReadinessMatch);
    recognizedSpans.push({
      start: platformTarget.start,
      end: platformTarget.end
    });
    const actionPosition = Math.min(
      platformReadinessMatch.index,
      platformTarget.start
    );
    localActions.push({
      position: actionPosition,
      priority: 1,
      action: {
        type: "platform.inspect_readiness",
        routeId: "platform",
        targetInput: platformTarget.targetInput
      }
    });
    ensureRouteBeforeActions({
      localActions,
      routeId: "platform",
      firstActionPosition: actionPosition
    });
  }

  for (const candidate of WORKBENCH_SURFACE_PATTERNS) {
    const match = firstMatch(candidate.expression, command);
    if (!match) continue;
    addSpan(recognizedSpans, match);
    localActions.push({
      position: match.index,
      priority: 1,
      action: {
        type: "workbench.show_surface",
        routeId: "workbench",
        surface: candidate.surface
      }
    });
    break;
  }

  for (const candidate of WORKBENCH_MODE_PATTERNS) {
    const match = firstMatch(candidate.expression, command);
    if (!match) continue;
    addSpan(recognizedSpans, match);
    localActions.push({
      position: match.index,
      priority: 2,
      action: {
        type: "workbench.set_mode",
        routeId: "workbench",
        mode: candidate.mode
      }
    });
    break;
  }

  for (const candidate of WORKBENCH_GOAL_PATTERNS) {
    const match = firstMatch(candidate.expression, command);
    if (!match) continue;
    addSpan(recognizedSpans, match);
    localActions.push({
      position: match.index,
      priority: 3,
      action: {
        type: "workbench.set_goal",
        routeId: "workbench",
        enabled: candidate.enabled
      }
    });
    break;
  }

  const workbenchStopMatch = firstMatch(WORKBENCH_STOP_LANGUAGE, command);
  if (workbenchStopMatch && !isNegatedMatch(command, workbenchStopMatch)) {
    addSpan(recognizedSpans, workbenchStopMatch);
    localActions.push({
      position: workbenchStopMatch.index,
      priority: 4,
      action: {
        type: "workbench.stop",
        routeId: "workbench"
      }
    });
  }

  const workbenchPageActions = localActions.filter(({ action }) =>
    action.type.startsWith("workbench.")
  );
  if (workbenchPageActions.length) {
    ensureRouteBeforeActions({
      localActions,
      routeId: "workbench",
      firstActionPosition: Math.min(
        ...workbenchPageActions.map(({ position }) => position)
      )
    });
  }

  localActions.sort(
    (left, right) =>
      left.position - right.position || left.priority - right.priority
  );

  const residual = meaningfulResidual(command, recognizedSpans);
  const shouldDelegate =
    localActions.length === 0 ||
    residual.length > 0 ||
    DELEGATED_WORK_LANGUAGE.test(residual);
  const actions: AgentCommandAction[] = localActions.map(({ action }, index) => ({
    ...action,
    id: `step-${index + 1}`
  })) as AgentCommandAction[];

  if (shouldDelegate) {
    actions.push({
      id: `step-${actions.length + 1}`,
      type: "workbench.delegate",
      prompt: command,
      collaborationMode: modes.collaborationMode,
      goalMode: modes.goalMode,
      contextFromPreviousActions: localActions.some(
        ({ action }) => action.type === "context.attach_focused"
      )
    });
  }

  const hasLocalActions = localActions.length > 0;
  const externalReads = localActions.some(
    ({ action }) => action.type === "platform.inspect_readiness"
  );
  const recognizedActionIds = actions
    .filter((action) => action.type !== "workbench.delegate")
    .map((action) => action.id);
  return {
    schemaVersion: AGENT_COMMAND_PLAN_VERSION,
    command,
    kind: shouldDelegate
      ? hasLocalActions
        ? "hybrid"
        : "delegated"
      : "local",
    ...modes,
    actions,
    coverage: {
      status: shouldDelegate
        ? hasLocalActions
          ? "partial"
          : "delegated"
        : "complete",
      recognizedActionIds,
      residual: shouldDelegate ? residual || command : ""
    },
    safety: {
      localOnly: !externalReads,
      externalReads,
      externalWrites: false,
      requiresConfirmation: false
    }
  };
}

export function hasLocalPageActions(plan: AgentCommandPlan): boolean {
  return plan.actions.some((action) => action.type !== "workbench.delegate");
}
