export const WORKBENCH_SCHEMA_VERSION = "cmooc.workbench.v1" as const;
export const WORKBENCH_PROMPT_MAX_LENGTH = 20_000;
export const WORKBENCH_PUBLIC_TEXT_MAX_LENGTH = 4_000;
export const WORKBENCH_LIVE_EXCERPT_MAX_LENGTH = 360;
export const WORKBENCH_PRIOR_ACTION_RECEIPT_LIMIT = 8;
export const WORKBENCH_CITATION_LIMIT = 8;
export const WORKBENCH_LINEAGE_SCHEMA_VERSION =
  "cmooc.workbench-lineage.v1" as const;

export type WorkbenchSource = "app-server" | "demo";
export type WorkbenchRunStatus =
  | "queued"
  | "starting"
  | "running"
  | "awaiting_action"
  | "completed"
  | "failed"
  | "stopped";

export type WorkbenchEventKind =
  | "run"
  | "agent"
  | "plan"
  | "tool"
  | "artifact"
  | "message"
  | "result"
  | "warning"
  | "error";

export type WorkbenchEventStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "info";

export type WorkbenchAgentRole = "sol" | "luna" | "system";
export type WorkbenchPresentationRole = "user" | "assistant" | "system" | "tool";
export type WorkbenchCollaborationMode = "default" | "plan";
export type WorkbenchPlanStepStatus = "pending" | "inProgress" | "completed";
/**
 * Server-classified, non-verbatim course objective. Raw user prompts remain
 * transient and must never be copied into a run snapshot or durable objective.
 */
export type WorkbenchCourseGoalCode =
  | "course_evidence_support_gap"
  | "research_evidence_package"
  | "schedule_review"
  | "open_course_task";
export type WorkbenchGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export type WorkbenchRunLineageRelation =
  | "root"
  | "restart"
  | "continuation"
  | "plan-execution";

export type WorkbenchRunLineage = {
  schemaVersion: typeof WORKBENCH_LINEAGE_SCHEMA_VERSION;
  relation: WorkbenchRunLineageRelation;
  rootRunId: string;
  parentRunId?: string;
  recoveryOfRunId?: string;
  planRunId?: string;
  generation: number;
  requestId?: string;
};

export type WorkbenchLaunchKind = "restart" | "continuation" | "plan-execution";

export type WorkbenchLaunchInput = {
  kind: WorkbenchLaunchKind;
  requestId: string;
};

export type WorkbenchPlanState = {
  explanation?: string;
  steps: Array<{ step: string; status: WorkbenchPlanStepStatus }>;
  updatedAt: string;
};

export type WorkbenchGoalState = {
  status: WorkbenchGoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  updatedAt: string;
};

export type WorkbenchEvent = {
  schemaVersion: typeof WORKBENCH_SCHEMA_VERSION;
  runId: string;
  seq: number;
  at: string;
  kind: WorkbenchEventKind;
  status: WorkbenchEventStatus;
  title: string;
  summary?: string;
  /** Current-process display only. Durable history must remove this field. */
  liveExcerpt?: string;
  agentKey?: string;
  agentLabel?: string;
  agentRole?: WorkbenchAgentRole;
  presentationRole?: WorkbenchPresentationRole;
  toolKey?: string;
  artifactId?: string;
  activityId?: string;
};

export type WorkbenchAgent = {
  key: string;
  label: string;
  role: WorkbenchAgentRole;
  status: "idle" | "running" | "completed" | "failed" | "stopped";
  taskSummary?: string;
  lastActivityAt: string;
};

export type WorkbenchTool = {
  key: string;
  label: string;
  category: "shell" | "filesystem" | "search" | "collaboration" | "other";
  status: "running" | "completed" | "failed" | "stopped";
  callCount: number;
  lastActivityAt: string;
};

export type WorkbenchArtifact = {
  id: string;
  label: string;
  relativePath: string;
  kind: "created" | "updated" | "deleted" | "other";
  status: "ready" | "failed";
  observedAt: string;
};

export type WorkbenchCitation = {
  title: string;
  url: string;
  source: string;
};

export type WorkbenchFinalResult = {
  status: "completed" | "failed" | "stopped";
  summary: string;
  completedAt: string;
  citations?: WorkbenchCitation[];
};

export type WorkbenchPendingAction = {
  schemaVersion: "cmooc.course-agent-action-coordinator.v1";
  kind: "approval_required";
  actionRef: string;
  approvalHash: string;
  bindingHash: string;
  toolName:
    | "platform.editor.stage_verify_clear"
    | "platform.editor.reconcile_stage";
  toolVersion: "1";
  parentActionRef?: string;
  recoveryOfActionRef?: string;
  safeSummary: string;
  validFrom: string;
  expiresAt: string;
  operationBoundary: {
    editorWriteCount: 0 | 1;
    editorReadbackCount: 1;
    editorClearCount: 1;
    publishCount: 0;
    notificationCount: 0;
    realPublishEnabled: false;
  };
};

export type WorkbenchSafetyState = {
  externalWritesLocked: true;
  realPublishEnabled: false;
  externalMutationAttempted: false;
  editorWriteCount: 0;
  publishAttemptCount: 0;
  containsForumText: false;
};

export type WorkbenchCapabilities = {
  canSteer: boolean;
  canStop: boolean;
  canRestart?: boolean;
  canContinue?: boolean;
  liveHarness: boolean;
  planMode?: boolean;
  goalMode?: boolean;
  computerUse?: "external-read-only";
};

export type WorkbenchContextKind =
  | "course"
  | "snapshot"
  | "invocation"
  | "decision"
  | "outcome"
  | "incident"
  | "learner";

export type WorkbenchContextSummary = {
  schemaVersion: "cmooc.workbench-context.v1";
  ref: string;
  kind: WorkbenchContextKind;
  title: string;
  courseAlias?: string;
  invocationId?: string;
  state: string;
  evidenceAsOf?: string;
  evidenceHash?: string;
  sourceHref?: string;
  containsForumText: false;
  containsIdentity?: false;
};

export const WORKBENCH_SESSION_WORKSPACE_SCHEMA_VERSION =
  "cmooc.workbench-session-workspace.v1" as const;

export type WorkbenchSessionWorkspaceSummary = {
  schemaVersion: typeof WORKBENCH_SESSION_WORKSPACE_SCHEMA_VERSION;
  key: string;
  projectRelativePath: string;
  state: "ready" | "degraded";
  reusable: true;
  containsPrompt: false;
  containsForumText: false;
  containsIdentity: false;
};

export type WorkbenchPriorActionType =
  | "navigate"
  | "world.focus_weakest"
  | "world.set_view"
  | "world.set_window"
  | "world.focus_learner"
  | "workbench.show_surface"
  | "workbench.set_mode"
  | "workbench.set_goal"
  | "context.attach_focused";

export type WorkbenchPriorActionReceipt = {
  actionType: WorkbenchPriorActionType;
  status: "completed";
  summary: string;
  contextRef?: string;
  containsForumText: false;
  externalWrites: false;
};

export type WorkbenchRunSnapshot = {
  schemaVersion: typeof WORKBENCH_SCHEMA_VERSION;
  id: string;
  status: WorkbenchRunStatus;
  source: WorkbenchSource;
  projectLabel: "cMOOC 源码工作区";
  collaborationMode?: WorkbenchCollaborationMode;
  goalMode?: boolean;
  lineage?: WorkbenchRunLineage;
  plan?: WorkbenchPlanState;
  goal?: WorkbenchGoalState;
  taskTitle?: string;
  context?: WorkbenchContextSummary;
  courseGoalCode?: WorkbenchCourseGoalCode;
  sessionWorkspace?: WorkbenchSessionWorkspaceSummary;
  createdAt: string;
  updatedAt: string;
  events: WorkbenchEvent[];
  firstEventSeq: number;
  lastEventSeq: number;
  agents: WorkbenchAgent[];
  tools: WorkbenchTool[];
  artifacts: WorkbenchArtifact[];
  pendingAction?: WorkbenchPendingAction;
  finalResult?: WorkbenchFinalResult;
  errorCode?: string;
  safety: WorkbenchSafetyState;
  capabilities: WorkbenchCapabilities;
};

export type WorkbenchCreateRunInput = {
  prompt: string;
  mode: "live" | "demo";
  collaborationMode?: WorkbenchCollaborationMode;
  goalMode?: boolean;
  contextRef?: string;
  intent?: "inspect" | "implement" | "summarize";
  priorActionReceipts?: WorkbenchPriorActionReceipt[];
};

export type WorkbenchMessageInput = {
  prompt: string;
  priorActionReceipts?: WorkbenchPriorActionReceipt[];
};

export class WorkbenchInputError extends Error {
  readonly status: 400 | 413;

  constructor(message: string, status: 400 | 413 = 400) {
    super(message);
    this.name = "WorkbenchInputError";
    this.status = status;
  }
}

export const SAFE_WORKBENCH_STATE: WorkbenchSafetyState = Object.freeze({
  externalWritesLocked: true,
  realPublishEnabled: false,
  externalMutationAttempted: false,
  editorWriteCount: 0,
  publishAttemptCount: 0,
  containsForumText: false
});

export function isWorkbenchPendingAction(
  value: unknown
): value is WorkbenchPendingAction {
  if (!isPlainObject(value) || !isPlainObject(value.operationBoundary)) {
    return false;
  }
  const boundary = value.operationBoundary;
  return (
    value.schemaVersion === "cmooc.course-agent-action-coordinator.v1" &&
    value.kind === "approval_required" &&
    typeof value.actionRef === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(value.actionRef) &&
    typeof value.approvalHash === "string" &&
    /^[a-f0-9]{64}$/u.test(value.approvalHash) &&
    typeof value.bindingHash === "string" &&
    /^[a-f0-9]{64}$/u.test(value.bindingHash) &&
    (value.toolName === "platform.editor.stage_verify_clear" ||
      value.toolName === "platform.editor.reconcile_stage") &&
    value.toolVersion === "1" &&
    typeof value.safeSummary === "string" &&
    value.safeSummary.length > 0 &&
    value.safeSummary.length <= WORKBENCH_PUBLIC_TEXT_MAX_LENGTH &&
    typeof value.validFrom === "string" &&
    Number.isFinite(Date.parse(value.validFrom)) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    Date.parse(value.validFrom) < Date.parse(value.expiresAt) &&
    boundary.editorWriteCount ===
      (value.toolName === "platform.editor.stage_verify_clear" ? 1 : 0) &&
    boundary.editorReadbackCount === 1 &&
    boundary.editorClearCount === 1 &&
    boundary.publishCount === 0 &&
    boundary.notificationCount === 0 &&
    boundary.realPublishEnabled === false &&
    (value.toolName === "platform.editor.stage_verify_clear"
      ? value.parentActionRef === undefined &&
        value.recoveryOfActionRef === undefined
      :
      (typeof value.parentActionRef === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(value.parentActionRef) &&
        value.recoveryOfActionRef === value.parentActionRef))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const WORKBENCH_SESSION_WORKSPACE_KEY =
  /^\d{8}T\d{6}Z--run-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isWorkbenchSessionWorkspaceSummary(
  value: unknown
): value is WorkbenchSessionWorkspaceSummary {
  if (!isPlainObject(value)) return false;
  if (
    value.schemaVersion !== WORKBENCH_SESSION_WORKSPACE_SCHEMA_VERSION ||
    typeof value.key !== "string" ||
    !WORKBENCH_SESSION_WORKSPACE_KEY.test(value.key) ||
    value.projectRelativePath !== `智能控制台会话/${value.key}` ||
    (value.state !== "ready" && value.state !== "degraded") ||
    value.reusable !== true ||
    value.containsPrompt !== false ||
    value.containsForumText !== false ||
    value.containsIdentity !== false
  ) {
    return false;
  }
  return true;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[]
) {
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unknownKey) {
    throw new WorkbenchInputError(`不支持字段：${unknownKey}`);
  }
}

function parsePrompt(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkbenchInputError("请输入要交给 cMOOC 智能体的任务。");
  }

  const prompt = value.trim();
  if (prompt.length > WORKBENCH_PROMPT_MAX_LENGTH) {
    throw new WorkbenchInputError(
      `任务不能超过 ${WORKBENCH_PROMPT_MAX_LENGTH} 个字符。`,
      413
    );
  }
  return prompt;
}

function parseContextRef(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !(
      /^(?:course|snapshot|invocation|decision|outcome|incident):[A-Za-z0-9_-]{1,128}$/.test(
        value
      ) ||
      /^learner:[A-Za-z0-9_-]{1,128}__actor-[0-9]{3,6}$/.test(value)
    )
  ) {
    throw new WorkbenchInputError("课程上下文编号无效。");
  }
  return value;
}

function parsePriorActionReceipts(
  value: unknown
): WorkbenchPriorActionReceipt[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > WORKBENCH_PRIOR_ACTION_RECEIPT_LIMIT) {
    throw new WorkbenchInputError(
      `页面动作回执必须是最多 ${WORKBENCH_PRIOR_ACTION_RECEIPT_LIMIT} 条的数组。`
    );
  }

  const receipts = value.map((candidate) => {
    if (!isPlainObject(candidate)) {
      throw new WorkbenchInputError("页面动作回执必须是 JSON 对象。");
    }
    assertExactKeys(candidate, [
      "actionType",
      "status",
      "summary",
      "contextRef",
      "containsForumText",
      "externalWrites"
    ]);
    const actionType = candidate.actionType;
    if (
      actionType !== "navigate" &&
      actionType !== "world.focus_weakest" &&
      actionType !== "world.set_view" &&
      actionType !== "world.set_window" &&
      actionType !== "world.focus_learner" &&
      actionType !== "workbench.show_surface" &&
      actionType !== "workbench.set_mode" &&
      actionType !== "workbench.set_goal" &&
      actionType !== "context.attach_focused"
    ) {
      throw new WorkbenchInputError("页面动作回执类型无效。");
    }
    const safeActionType: WorkbenchPriorActionType = actionType;
    if (
      candidate.status !== "completed" ||
      candidate.containsForumText !== false ||
      candidate.externalWrites !== false
    ) {
      throw new WorkbenchInputError("页面动作回执必须来自已完成的零外部写入动作。");
    }
    const summary = redactPublicText(candidate.summary, 220).trim();
    if (!summary) throw new WorkbenchInputError("页面动作回执摘要不能为空。");
    const contextRef = parseContextRef(candidate.contextRef);
    if (safeActionType === "context.attach_focused") {
      if (!contextRef?.startsWith("learner:")) {
        throw new WorkbenchInputError("上下文附加回执必须绑定匿名学习者上下文。");
      }
    } else if (contextRef) {
      throw new WorkbenchInputError("只有上下文附加回执可以携带上下文编号。");
    }
    return {
      actionType: safeActionType,
      status: "completed" as const,
      summary,
      ...(contextRef ? { contextRef } : {}),
      containsForumText: false as const,
      externalWrites: false as const
    };
  });

  return receipts.length ? receipts : undefined;
}

export function parseCreateRunInput(value: unknown): WorkbenchCreateRunInput {
  if (!isPlainObject(value)) {
    throw new WorkbenchInputError("任务请求必须是 JSON 对象。");
  }
  assertExactKeys(value, [
    "prompt",
    "mode",
    "collaborationMode",
    "goalMode",
    "contextRef",
    "intent",
    "priorActionReceipts"
  ]);

  const mode = value.mode ?? "live";
  if (mode !== "live" && mode !== "demo") {
    throw new WorkbenchInputError("mode 只能是 live 或 demo。");
  }

  const collaborationMode = value.collaborationMode;
  if (
    collaborationMode !== undefined &&
    collaborationMode !== "default" &&
    collaborationMode !== "plan"
  ) {
    throw new WorkbenchInputError("collaborationMode 只能是 default 或 plan。");
  }
  const goalMode = value.goalMode;
  if (goalMode !== undefined && typeof goalMode !== "boolean") {
    throw new WorkbenchInputError("goalMode 必须是布尔值。");
  }

  const contextRef = parseContextRef(value.contextRef);
  const priorActionReceipts = parsePriorActionReceipts(value.priorActionReceipts);
  const attachedContextRef = priorActionReceipts?.find(
    (receipt) => receipt.actionType === "context.attach_focused"
  )?.contextRef;
  if (attachedContextRef && attachedContextRef !== contextRef) {
    throw new WorkbenchInputError("页面上下文回执与任务上下文不一致。");
  }
  const intent = value.intent;
  if (
    intent !== undefined &&
    intent !== "inspect" &&
    intent !== "implement" &&
    intent !== "summarize"
  ) {
    throw new WorkbenchInputError("intent 只能是 inspect、implement 或 summarize。");
  }

  return {
    prompt: parsePrompt(value.prompt),
    mode,
    ...(collaborationMode ? { collaborationMode } : {}),
    ...(goalMode !== undefined ? { goalMode } : {}),
    ...(contextRef ? { contextRef } : {}),
    ...(intent ? { intent } : {}),
    ...(priorActionReceipts ? { priorActionReceipts } : {})
  };
}

const WORKBENCH_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseWorkbenchLaunchInput(value: unknown): WorkbenchLaunchInput {
  if (!isPlainObject(value)) {
    throw new WorkbenchInputError("启动请求必须是 JSON 对象。");
  }
  assertExactKeys(value, ["kind", "requestId"]);
  if (
    value.kind !== "restart" &&
    value.kind !== "continuation" &&
    value.kind !== "plan-execution"
  ) {
    throw new WorkbenchInputError(
      "kind 只能是 restart、continuation 或 plan-execution。"
    );
  }
  if (typeof value.requestId !== "string" || !WORKBENCH_REQUEST_ID.test(value.requestId)) {
    throw new WorkbenchInputError("启动请求编号无效。");
  }
  return { kind: value.kind, requestId: value.requestId.toLowerCase() };
}

export function isWorkbenchRunLineage(
  value: unknown,
  runId?: string
): value is WorkbenchRunLineage {
  if (!isPlainObject(value)) return false;
  const relation = value.relation;
  const rootRunId = value.rootRunId;
  const parentRunId = value.parentRunId;
  const recoveryOfRunId = value.recoveryOfRunId;
  const planRunId = value.planRunId;
  const generation = value.generation;
  const requestId = value.requestId;
  const allowedKeys = relation === "root"
    ? ["schemaVersion", "relation", "rootRunId", "generation"]
    : relation === "plan-execution"
      ? [
          "schemaVersion",
          "relation",
          "rootRunId",
          "parentRunId",
          "planRunId",
          "generation",
          "requestId"
        ]
      : relation === "restart"
        ? [
            "schemaVersion",
            "relation",
            "rootRunId",
            "parentRunId",
            "recoveryOfRunId",
            "planRunId",
            "generation",
            "requestId"
          ]
        : relation === "continuation"
          ? [
              "schemaVersion",
              "relation",
              "rootRunId",
              "parentRunId",
              "generation",
              "requestId"
            ]
        : [];
  if (
    Object.keys(value).some((key) => !allowedKeys.includes(key)) ||
    value.schemaVersion !== WORKBENCH_LINEAGE_SCHEMA_VERSION ||
    (
      relation !== "root" &&
      relation !== "restart" &&
      relation !== "continuation" &&
      relation !== "plan-execution"
    ) ||
    typeof rootRunId !== "string" ||
    !isSafeRunId(rootRunId) ||
    !Number.isInteger(generation) ||
    (generation as number) < 0 ||
    (generation as number) > 16
  ) {
    return false;
  }
  if (runId !== undefined && (!isSafeRunId(runId) || (relation === "root" && rootRunId !== runId))) {
    return false;
  }
  if (relation === "root") {
    return generation === 0 &&
      parentRunId === undefined &&
      recoveryOfRunId === undefined &&
      planRunId === undefined &&
      requestId === undefined;
  }
  if (
    typeof parentRunId !== "string" ||
    !isSafeRunId(parentRunId) ||
    typeof requestId !== "string" ||
    !WORKBENCH_REQUEST_ID.test(requestId) ||
    generation === 0 ||
    (runId !== undefined && parentRunId === runId)
  ) {
    return false;
  }
  if (relation === "plan-execution") {
    return recoveryOfRunId === undefined &&
      typeof planRunId === "string" &&
      isSafeRunId(planRunId) &&
      planRunId === parentRunId;
  }
  if (relation === "continuation") {
    return recoveryOfRunId === undefined && planRunId === undefined;
  }
  return typeof recoveryOfRunId === "string" &&
    isSafeRunId(recoveryOfRunId) &&
    recoveryOfRunId === parentRunId &&
    (planRunId === undefined || (typeof planRunId === "string" && isSafeRunId(planRunId)));
}

export function parseMessageInput(value: unknown): WorkbenchMessageInput {
  if (!isPlainObject(value)) {
    throw new WorkbenchInputError("追加引导必须是 JSON 对象。");
  }
  assertExactKeys(value, ["prompt", "priorActionReceipts"]);
  const priorActionReceipts = parsePriorActionReceipts(value.priorActionReceipts);
  return {
    prompt: parsePrompt(value.prompt),
    ...(priorActionReceipts ? { priorActionReceipts } : {})
  };
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "[凭据已隐藏]"],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[凭据已隐藏]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[凭据已隐藏]"],
  [
    /\b(?:api[_-]?key|token|password|passwd|cookie|authorization|auth[_-]?state)\b\s*[:=]\s*[^\s,;]+/gi,
    "[敏感字段已隐藏]"
  ],
  [/https?:\/\/[^\s<>"']+/gi, "[链接已隐藏]"],
  [/(?:[A-Za-z]:\\|\\\\)[^\r\n<>"|?*]+/g, "[本机路径已隐藏]"],
  [/(?:\/Users\/|\/home\/)[^\s<>"']+/g, "[本机路径已隐藏]"]
];

export function redactPublicText(
  value: unknown,
  maxLength = WORKBENCH_PUBLIC_TEXT_MAX_LENGTH
): string {
  if (typeof value !== "string") {
    return "";
  }

  let output = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n");
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  output = output.trim();

  if (output.length <= maxLength) {
    return output;
  }
  return `${output.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

const WORKBENCH_REDACTION_MARKER =
  /\[(?:凭据|敏感字段|链接|本机路径|内部标识|内部运行信息|命令信息|文件差异|代码细节)已隐藏\]/;

export function sanitizeWorkbenchLiveExcerpt(value: unknown): string | undefined {
  const excerpt = redactPublicText(value, WORKBENCH_LIVE_EXCERPT_MAX_LENGTH)
    .replace(/\s+/g, " ")
    .trim();
  if (!excerpt || WORKBENCH_REDACTION_MARKER.test(excerpt)) return undefined;
  return excerpt;
}

const SENSITIVE_CITATION_QUERY = /^(?:access[_-]?token|api[_-]?key|auth(?:orization)?|code|cookie|credential|key|password|session|sig(?:nature)?|token|utm_.+)$/i;

function isPrivateCitationHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host);
}

export function sanitizeWorkbenchCitations(value: unknown): WorkbenchCitation[] {
  if (!Array.isArray(value)) return [];
  const citations: WorkbenchCitation[] = [];
  const seen = new Set<string>();

  for (const candidate of value.slice(0, WORKBENCH_CITATION_LIMIT)) {
    if (!isPlainObject(candidate) || typeof candidate.url !== "string") continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate.url.trim());
    } catch {
      continue;
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      !parsed.hostname ||
      isPrivateCitationHost(parsed.hostname)
    ) {
      continue;
    }

    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_CITATION_QUERY.test(key)) parsed.searchParams.delete(key);
    }
    const url = parsed.toString();
    if (url.length > 1_024 || seen.has(url)) continue;
    const source = parsed.hostname.toLowerCase().replace(/^www\./, "").slice(0, 180);
    const title = redactPublicText(candidate.title, 180).trim() || source;
    if (!title) continue;
    seen.add(url);
    citations.push({ title, url, source });
  }
  return citations;
}

export function isTerminalWorkbenchStatus(status: WorkbenchRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

export function isSafeRunId(value: string): boolean {
  return /^[a-f0-9-]{16,64}$/i.test(value);
}
