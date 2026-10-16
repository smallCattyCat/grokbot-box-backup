import { RESEARCH_READINESS_POLICY } from "@/lib/analytics/research-readiness";

export const OPERATOR_APP_ID = "cmooc-companion-system";
export const OPERATOR_APP_NAME = "cMOOC 智能学伴系统";
export const OPERATOR_REGISTRY_VERSION = 21;
export const OPERATOR_PREFERRED_ROUTE = "/";

export const OPERATOR_PATHS = {
  manifest: "/api/operator/manifest",
  apiDocs: "/api/operator/api-docs",
  actions: "/api/operator/actions",
  status: "/api/operator/status",
  authStatus: "/api/operator/auth-status",
  research: "/api/operator/research",
  researchDigest: "/api/operator/research?format=digest",
  review: "/review",
  authorizePublish: "/api/interventions/{id}/authorize-publish",
  publishAuthorized: "/api/interventions/{id}/publish",
  reconcilePublish: "/api/interventions/{id}/reconcile"
} as const;

export type OperatorActionCategory =
  | "read_only"
  | "preview"
  | "world_model_refresh"
  | "preview_scheduler";

export type OperatorActionDefinition = {
  id: string;
  title: string;
  category: OperatorActionCategory;
  description: string;
  safe: true;
  forumWrite: false;
  requiresConfirmation: false;
  inputExample: Readonly<Record<string, unknown>>;
  evidence: readonly string[];
};

export const OPERATOR_ACTION_DEFINITIONS = [
  {
    id: "inspect_status",
    title: "读取系统状态",
    category: "read_only",
    description: "读取运行、模型、候选、调度器和安全边界的轻量摘要。",
    safe: true,
    forumWrite: false,
    requiresConfirmation: false,
    inputExample: {},
    evidence: ["metrics", "llm", "scheduler", "latestRun"]
  },
  {
    id: "read_research_digest",
    title: "读取研究摘要",
    category: "read_only",
    description: "按需读取图小波、SNA、编码一致性和准实验摘要。",
    safe: true,
    forumWrite: false,
    requiresConfirmation: false,
    inputExample: {
      fresh: false
    },
    evidence: ["readiness", "algorithms.graphWavelet", "algorithms.research"]
  },
  {
    id: "read_cmooc_auth_status",
    title: "读取论坛认证状态",
    category: "read_only",
    description: "只报告认证来源是否可用，不返回令牌。",
    safe: true,
    forumWrite: false,
    requiresConfirmation: false,
    inputExample: {},
    evidence: ["readyForRealForumWrite", "sources", "guidance"]
  },
  {
    id: "run_preview",
    title: "生成一轮干预预演",
    category: "preview",
    description: "扫描、分析、更新候选并生成可审阅计划，不向论坛发布。",
    safe: true,
    forumWrite: false,
    requiresConfirmation: false,
    inputExample: {
      maxScanPosts: 10,
      maxCandidateCount: 5,
      minScore: 75
    },
    evidence: ["runId", "candidateCount", "plannedCount", "publishedCount=0"]
  },
  {
    id: "refresh_world_model",
    title: "刷新世界模型",
    category: "world_model_refresh",
    description: "可选采集新论坛快照，并重新计算社交网络与学习者画像；只更新本地研究数据。",
    safe: true,
    forumWrite: false,
    requiresConfirmation: false,
    inputExample: {
      sourceUrl: "optional cMOOC detail or course URL",
      maxPosts: 10,
      courseId: "optional"
    },
    evidence: [
      "ForumIngestionRun when sourceUrl is supplied",
      "social-network-sync-agent",
      "user-profile-sync-agent",
      "ForumUserCourseProfile"
    ]
  },
  {
    id: "start_preview_scheduler",
    title: "启动周期预演",
    category: "preview_scheduler",
    description: "按固定间隔生成干预预演；调度器不具备论坛写入能力。",
    safe: true,
    forumWrite: false,
    requiresConfirmation: false,
    inputExample: {
      intervalMinutes: 30,
      runImmediately: false,
      maxScanPosts: 10,
      maxCandidateCount: 5,
      minScore: 75
    },
    evidence: ["scheduler.running", "scheduler.config", "scheduler.lastResult"]
  },
  {
    id: "run_preview_scheduler_once",
    title: "立即执行一次周期预演",
    category: "preview_scheduler",
    description: "使用当前预演调度配置立即运行一次，不向论坛发布。",
    safe: true,
    forumWrite: false,
    requiresConfirmation: false,
    inputExample: {},
    evidence: ["scheduler.lastResult", "runId", "publishedCount=0"]
  },
  {
    id: "stop_preview_scheduler",
    title: "停止周期预演",
    category: "preview_scheduler",
    description: "停止当前周期预演计时器。",
    safe: true,
    forumWrite: false,
    requiresConfirmation: false,
    inputExample: {},
    evidence: ["scheduler.running=false"]
  }
] as const satisfies readonly OperatorActionDefinition[];

export type OperatorActionId = typeof OPERATOR_ACTION_DEFINITIONS[number]["id"];

export const OPERATOR_ACTION_IDS = OPERATOR_ACTION_DEFINITIONS.map(
  (action) => action.id
) as OperatorActionId[];

export function isOperatorActionId(value: string): value is OperatorActionId {
  return OPERATOR_ACTION_IDS.includes(value as OperatorActionId);
}

export function getOperatorAction(actionId: OperatorActionId) {
  return OPERATOR_ACTION_DEFINITIONS.find((action) => action.id === actionId)!;
}

const FULL_RESEARCH_SERVER_CACHE = {
  ttlSeconds: 15,
  bypassQuery: "fresh=true",
  signatureFields: [
    "counts",
    "latestRun.updatedAt",
    "topCandidate.updatedAt",
    "latestWaveRun.finishedAt",
    "llm",
    "scheduler"
  ]
} as const;

const RESEARCH_DIGEST_SERVER_CACHE = {
  ...FULL_RESEARCH_SERVER_CACHE,
  source: "shared_full_research_cache",
  includesReadinessGate: true,
  readinessPolicy: RESEARCH_READINESS_POLICY
} as const;

export const OPERATOR_ENDPOINTS = {
  operatorManifest: {
    method: "GET",
    path: OPERATOR_PATHS.manifest,
    category: "discovery",
    costTier: "cheap",
    pollingPolicy: "never",
    safe: true,
    operatorAction: false,
    requiresConfirmation: false
  },
  operatorApiDocs: {
    method: "GET",
    path: OPERATOR_PATHS.apiDocs,
    category: "discovery",
    costTier: "cheap",
    pollingPolicy: "never",
    safe: true,
    operatorAction: false,
    requiresConfirmation: false
  },
  operatorActions: {
    method: "POST",
    path: OPERATOR_PATHS.actions,
    category: "safe_operator_action",
    costTier: "safe_mutation",
    pollingPolicy: "never",
    safe: true,
    operatorAction: true,
    requiresConfirmation: false
  },
  operatorStatus: {
    method: "GET",
    path: OPERATOR_PATHS.status,
    category: "read_only",
    costTier: "cheap",
    pollingPolicy: "preferred",
    safe: true,
    operatorAction: false,
    requiresConfirmation: false
  },
  operatorAuthStatus: {
    method: "GET",
    path: OPERATOR_PATHS.authStatus,
    category: "read_only",
    costTier: "cheap",
    pollingPolicy: "manual",
    safe: true,
    operatorAction: false,
    requiresConfirmation: false
  },
  operatorResearchDigest: {
    method: "GET",
    path: OPERATOR_PATHS.researchDigest,
    category: "read_only_research",
    costTier: "full_research",
    pollingPolicy: "on_demand_only",
    safe: true,
    operatorAction: false,
    requiresConfirmation: false,
    serverCache: RESEARCH_DIGEST_SERVER_CACHE
  },
  operatorResearch: {
    method: "GET",
    path: OPERATOR_PATHS.research,
    category: "read_only_research",
    costTier: "full_research",
    pollingPolicy: "on_demand_only",
    safe: true,
    operatorAction: false,
    requiresConfirmation: false,
    serverCache: FULL_RESEARCH_SERVER_CACHE
  },
  operatorStatusFull: {
    method: "GET",
    path: `${OPERATOR_PATHS.status}?detail=full`,
    category: "read_only_research",
    costTier: "full_research",
    pollingPolicy: "on_demand_only",
    safe: true,
    operatorAction: false,
    requiresConfirmation: false,
    serverCache: FULL_RESEARCH_SERVER_CACHE
  },
  llmStatus: {
    method: "GET",
    path: "/api/auto-intervention/llm-status",
    category: "read_only",
    costTier: "cheap",
    pollingPolicy: "allowed",
    safe: true,
    operatorAction: false,
    requiresConfirmation: false
  },
  schedulerStatus: {
    method: "GET",
    path: "/api/auto-intervention/scheduler",
    category: "read_only",
    costTier: "cheap",
    pollingPolicy: "allowed",
    safe: true,
    operatorAction: false,
    requiresConfirmation: false
  },
  runs: {
    method: "GET",
    path: "/api/auto-intervention/runs",
    category: "read_only",
    costTier: "cheap",
    pollingPolicy: "manual",
    safe: true,
    operatorAction: false,
    requiresConfirmation: false
  },
  runDetail: {
    method: "GET",
    path: "/api/auto-intervention/runs/{runId}",
    category: "read_only",
    costTier: "cheap",
    pollingPolicy: "manual",
    safe: true,
    operatorAction: false,
    requiresConfirmation: false
  },
  review: {
    method: "GET",
    path: OPERATOR_PATHS.review,
    category: "human_review",
    costTier: "human_interaction",
    pollingPolicy: "never",
    safe: true,
    operatorAction: false,
    requiresConfirmation: false
  },
  authorizePublish: {
    method: "POST",
    path: OPERATOR_PATHS.authorizePublish,
    category: "content_bound_publish",
    costTier: "human_review_required",
    pollingPolicy: "never",
    safe: false,
    operatorAction: false,
    requiresConfirmation: true,
    requiresContentBinding: true,
    requiresTargetBinding: true
  },
  publishAuthorized: {
    method: "POST",
    path: OPERATOR_PATHS.publishAuthorized,
    category: "content_bound_publish",
    costTier: "human_review_required",
    pollingPolicy: "never",
    safe: false,
    operatorAction: false,
    requiresConfirmation: true,
    requiresContentBinding: true,
    requiresTargetBinding: true
  },
  reconcilePublish: {
    method: "POST",
    path: OPERATOR_PATHS.reconcilePublish,
    category: "human_reconciliation",
    costTier: "human_review_required",
    pollingPolicy: "never",
    safe: false,
    operatorAction: false,
    requiresConfirmation: true,
    requiresEvidenceNote: true
  }
} as const;

export const OPERATOR_STABLE_SELECTORS = {} as const;

export const OPERATOR_READ_ONLY_SELECTORS = [] as const;

export const OPERATOR_API_GROUP_DEFINITIONS = [
  {
    id: "discovery",
    title: "发现",
    endpointIds: ["operatorManifest", "operatorApiDocs", "operatorActions"]
  },
  {
    id: "observe",
    title: "只读状态、研究与认证",
    endpointIds: [
      "operatorStatus",
      "operatorStatusFull",
      "operatorResearchDigest",
      "operatorResearch",
      "operatorAuthStatus",
      "llmStatus",
      "schedulerStatus",
      "runs",
      "runDetail"
    ]
  },
  {
    id: "safe-operations",
    title: "预演与世界模型刷新",
    endpointIds: ["operatorActions"]
  },
  {
    id: "review-publish",
    title: "人工审阅与内容绑定发布",
    endpointIds: [
      "review",
      "authorizePublish",
      "publishAuthorized",
      "reconcilePublish"
    ]
  }
] as const;

export const OPERATOR_WORKFLOW_DEFINITIONS = [
  {
    id: "inspect_system",
    title: "检查系统",
    steps: [
      "GET /api/operator/manifest",
      "GET /api/operator/status",
      "GET /api/operator/auth-status"
    ]
  },
  {
    id: "inspect_research",
    title: "读取研究证据",
    steps: [
      "GET /api/operator/research?format=digest",
      "仅在深度诊断时 GET /api/operator/research"
    ]
  },
  {
    id: "run_preview",
    title: "生成预演",
    steps: [
      "POST /api/operator/actions { actionId: 'run_preview', input: {...} }",
      "GET /api/operator/status",
      "OPEN /review"
    ]
  },
  {
    id: "refresh_world_model",
    title: "刷新世界模型",
    steps: [
      "POST /api/operator/actions { actionId: 'refresh_world_model', input: {...} }",
      "GET /api/operator/research?format=digest"
    ]
  },
  {
    id: "preview_scheduler",
    title: "控制周期预演",
    steps: [
      "POST /api/operator/actions { actionId: 'start_preview_scheduler' }",
      "POST /api/operator/actions { actionId: 'run_preview_scheduler_once' }",
      "POST /api/operator/actions { actionId: 'stop_preview_scheduler' }"
    ]
  },
  {
    id: "review_and_publish",
    title: "逐条审阅并发布",
    steps: [
      "OPEN /review",
      "POST /api/interventions/{id}/authorize-publish with current content and target hashes",
      "POST /api/interventions/{id}/publish",
      "If the result is unknown, verify the forum and POST /api/interventions/{id}/reconcile with an evidence note"
    ],
    operatorAction: false,
    requiresHumanReview: true,
    requiresContentBinding: true
  }
] as const;

type SelectorTree = string | { readonly [key: string]: SelectorTree };

export type OperatorStableSelector = {
  id: string;
  surface: string;
  name: string;
  selector: string;
  testId: string | null;
};

function extractTestId(selector: string) {
  return selector.match(/data-testid(?:\^)?=['"]([^'"]+)['"]/)?.[1] ?? null;
}

function flattenSelectorTree(
  tree: SelectorTree,
  path: string[] = []
): OperatorStableSelector[] {
  if (typeof tree === "string") {
    const [surface = "root", name = "root"] = path;
    return [{
      id: path.join("."),
      surface,
      name,
      selector: tree,
      testId: extractTestId(tree)
    }];
  }
  return Object.entries(tree).flatMap(([key, value]) =>
    flattenSelectorTree(value, [...path, key])
  );
}

export function getOperatorStableSelectorList() {
  return flattenSelectorTree(OPERATOR_STABLE_SELECTORS);
}

export function getOperatorActionSummary() {
  return {
    actionCount: OPERATOR_ACTION_DEFINITIONS.length,
    safeActionIds: OPERATOR_ACTION_IDS,
    forumWriteActionIds: [] as string[]
  };
}

export function getOperatorEndpointSummary() {
  const entries = Object.entries(OPERATOR_ENDPOINTS);
  return {
    endpointCount: entries.length,
    safeEndpointIds: entries
      .filter(([, endpoint]) => endpoint.safe)
      .map(([id]) => id),
    cheapEndpointIds: entries
      .filter(([, endpoint]) => endpoint.costTier === "cheap")
      .map(([id]) => id),
    preferredPollingEndpointIds: entries
      .filter(([, endpoint]) =>
        endpoint.pollingPolicy === "preferred" ||
        endpoint.pollingPolicy === "allowed"
      )
      .map(([id]) => id),
    onDemandEndpointIds: entries
      .filter(([, endpoint]) => endpoint.pollingPolicy === "on_demand_only")
      .map(([id]) => id),
    nonPollingEndpointIds: entries
      .filter(([, endpoint]) => endpoint.pollingPolicy === "never")
      .map(([id]) => id),
    reviewRequiredEndpointIds: entries
      .filter(([, endpoint]) => endpoint.costTier === "human_review_required")
      .map(([id]) => id)
  };
}

export const OPERATOR_REGISTRY = {
  appId: OPERATOR_APP_ID,
  appName: OPERATOR_APP_NAME,
  version: OPERATOR_REGISTRY_VERSION,
  preferredRoute: OPERATOR_PREFERRED_ROUTE,
  paths: OPERATOR_PATHS,
  actions: OPERATOR_ACTION_DEFINITIONS,
  endpoints: OPERATOR_ENDPOINTS,
  apiGroups: OPERATOR_API_GROUP_DEFINITIONS,
  workflows: OPERATOR_WORKFLOW_DEFINITIONS,
  stableSelectors: OPERATOR_STABLE_SELECTORS,
  readOnlySelectors: OPERATOR_READ_ONLY_SELECTORS,
  publishBoundary: {
    route: OPERATOR_PATHS.review,
    authorizeEndpoint: OPERATOR_PATHS.authorizePublish,
    publishEndpoint: OPERATOR_PATHS.publishAuthorized,
    reconcileEndpoint: OPERATOR_PATHS.reconcilePublish,
    operatorAction: false,
    requiresHumanReview: true,
    requiresContentBinding: true,
    requiresTargetBinding: true
  }
} as const;

export function getOperatorManifest() {
  const stableSelectorList = getOperatorStableSelectorList();
  return {
    ...OPERATOR_REGISTRY,
    selectorCount: stableSelectorList.length,
    stableSelectorList,
    actionSummary: getOperatorActionSummary(),
    endpointSummary: getOperatorEndpointSummary(),
    safeDefault: {
      operation: "preview",
      forumWrite: false
    },
    actionTaxonomy: {
      read_only: "只读取状态、研究或认证证据。",
      preview: "只生成候选与计划，不向论坛发布。",
      world_model_refresh: "只采集或重算本地研究数据。",
      preview_scheduler: "只调度预演。"
    }
  };
}

export function getOperatorCatalog() {
  return {
    appId: OPERATOR_APP_ID,
    app: OPERATOR_APP_NAME,
    apiVersion: 2,
    operatorContractVersion: OPERATOR_REGISTRY_VERSION,
    preferredRoute: OPERATOR_PREFERRED_ROUTE,
    docsEndpoint: OPERATOR_PATHS.apiDocs,
    manifestEndpoint: OPERATOR_PATHS.manifest,
    actionRunnerEndpoint: OPERATOR_PATHS.actions,
    actions: OPERATOR_ACTION_DEFINITIONS,
    httpEndpoints: OPERATOR_ENDPOINTS,
    apiGroups: OPERATOR_API_GROUP_DEFINITIONS,
    workflows: OPERATOR_WORKFLOW_DEFINITIONS,
    publishBoundary: OPERATOR_REGISTRY.publishBoundary,
    actionRunner: {
      path: OPERATOR_PATHS.actions,
      method: "POST",
      actionIds: OPERATOR_ACTION_IDS,
      requestShape: { actionId: "run_preview", input: {} },
      responseShape: {
        ok: true,
        actionId: "run_preview",
        category: "preview",
        result: {}
      }
    },
    safetyRules: [
      "Operator 动作只能预演、刷新本地世界模型或控制预演调度。",
      "论坛写入不属于 operator action runner。",
      "所有论坛写入必须在 /review 逐条审阅，并绑定当前正文与目标。"
    ]
  };
}
