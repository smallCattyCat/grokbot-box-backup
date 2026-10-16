/**
 * Routes the in-app agent is allowed to navigate to directly.
 *
 * Keep this registry limited to stable, static application pages. Dynamic
 * identifiers and query strings must be produced by a page action rather than
 * accepted as arbitrary navigation input.
 */
export const APP_ROUTES = [
  {
    id: "home",
    href: "/",
    label: "产品总览",
    aliases: ["首页", "主页", "产品总览"]
  },
  {
    id: "workbench",
    href: "/workbench",
    label: "智能控制台",
    aliases: ["智能控制台", "控制台", "任务控制台", "工作台", "对话区"]
  },
  {
    id: "autonomy.world",
    href: "/autonomy/world",
    label: "社会网络",
    aliases: [
      "社会网络",
      "学习者社会网络",
      "互动网络",
      "学习网络",
      "网络图",
      "世界模型"
    ]
  },
  {
    id: "autonomy.decisions",
    href: "/autonomy/decisions",
    label: "运行记录",
    aliases: ["运行记录", "自主决定", "决策记录", "运行决定"]
  },
  {
    id: "autonomy.outcomes",
    href: "/autonomy/outcomes",
    label: "结果观察",
    aliases: ["结果观察", "近端观察", "结果页", "结果"]
  },
  {
    id: "autonomy.governance",
    href: "/autonomy/governance",
    label: "课程治理",
    aliases: ["课程治理", "运行治理", "治理中心", "治理"]
  },
  {
    id: "autonomy.policy",
    href: "/autonomy/policy",
    label: "策略边界",
    aliases: ["策略边界", "策略设置", "课程策略", "策略"]
  },
  {
    id: "platform",
    href: "/platform",
    label: "平台只读诊断",
    aliases: ["平台只读诊断", "平台诊断", "电脑观察", "平台"]
  },
  {
    id: "review.live",
    href: "/review/live",
    label: "长期运行审核",
    aliases: ["长期运行审核", "长期审核", "异常审核"]
  },
  {
    id: "evidence",
    href: "/evidence",
    label: "研究与运行证据",
    aliases: ["研究与运行证据", "运行证据", "研究证据", "证据"]
  },
  {
    id: "review",
    href: "/review",
    label: "候选审阅",
    aliases: ["候选审阅", "候选审核", "审阅"]
  },
  {
    id: "settings",
    href: "/settings",
    label: "连接与安全设置",
    aliases: ["连接与安全设置", "连接设置", "安全设置", "设置"]
  },
  {
    id: "mock",
    href: "/mock",
    label: "开发实验室",
    aliases: ["开发实验室", "本地实验室"]
  },
  {
    id: "mock.forum",
    href: "/mock-forum",
    label: "Mock cMOOC 论坛",
    aliases: ["Mock cMOOC 论坛", "Mock 论坛", "本地论坛"]
  }
] as const;

export type AppRouteDefinition = (typeof APP_ROUTES)[number];
export type AppRouteId = AppRouteDefinition["id"];
export type CanonicalAppHref = AppRouteDefinition["href"];

const ROUTES_BY_HREF = new Map<CanonicalAppHref, AppRouteDefinition>(
  APP_ROUTES.map((route) => [route.href, route])
);

const ROUTES_BY_NAME = new Map<string, AppRouteDefinition>();
for (const route of APP_ROUTES) {
  for (const name of [route.id, route.label, ...route.aliases]) {
    ROUTES_BY_NAME.set(normalizeRouteName(name), route);
  }
}

function normalizeRouteName(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, " ");
}

export function isCanonicalAppHref(value: string): value is CanonicalAppHref {
  return ROUTES_BY_HREF.has(value as CanonicalAppHref);
}

export function resolveAppRoute(input: string): AppRouteDefinition | null {
  const value = input.trim();
  if (isCanonicalAppHref(value)) {
    return ROUTES_BY_HREF.get(value) ?? null;
  }
  return ROUTES_BY_NAME.get(normalizeRouteName(value)) ?? null;
}

export function normalizeAppHref(input: string): CanonicalAppHref | null {
  return resolveAppRoute(input)?.href ?? null;
}
