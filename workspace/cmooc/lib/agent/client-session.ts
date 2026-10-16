import type {
  WorkbenchPriorActionReceipt,
  WorkbenchPriorActionType
} from "@/lib/workbench/contracts";
import type {
  AgentCommandAction,
  NavigateAction
} from "./command-planner";
import {
  isCanonicalAppHref,
  type AppRouteId,
  type CanonicalAppHref
} from "./app-routes";

export const AGENT_CLIENT_SESSION_SCHEMA_VERSION = "cmooc.agent-client-session.v1" as const;
export const AGENT_CLIENT_SESSION_STORAGE_KEY = "cmooc.agent.client-session.v1";
export const WORKBENCH_RUN_STORAGE_KEY = "cmooc.workbench.runId";
export const WORKBENCH_TASK_STORAGE_KEY = "cmooc.workbench.taskTitle";
export const MAX_AGENT_JOURNAL_ENTRIES = 24;

const WORKBENCH_RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isSafeWorkbenchRunId(value: unknown): value is string {
  return typeof value === "string" && WORKBENCH_RUN_ID_PATTERN.test(value);
}

export function buildWorkbenchRunHandoffHref(
  runId: unknown
): `/workbench?run=${string}` {
  if (!isSafeWorkbenchRunId(runId)) {
    throw new Error("WORKBENCH_RUN_HANDOFF_INVALID");
  }
  return `/workbench?run=${encodeURIComponent(runId)}`;
}

export function resolveWorkbenchRestoreRunId(
  handoffRunId: unknown,
  storedRunId: unknown
): string {
  if (isSafeWorkbenchRunId(handoffRunId)) return handoffRunId;
  return isSafeWorkbenchRunId(storedRunId) ? storedRunId : "";
}

export type TransientWorkbenchPrompt = {
  runId: string;
  prompt: string;
};

export function createTransientWorkbenchPrompt(
  runId: unknown,
  prompt: unknown
): TransientWorkbenchPrompt | null {
  if (!isSafeWorkbenchRunId(runId) || typeof prompt !== "string") return null;
  const normalizedPrompt = prompt.replace(/\u0000/g, "").trim();
  return normalizedPrompt ? { runId, prompt: normalizedPrompt } : null;
}

export function resolveTransientWorkbenchPrompt(
  handoff: TransientWorkbenchPrompt | null | undefined,
  runId: unknown
): string {
  if (!handoff || !isSafeWorkbenchRunId(runId) || handoff.runId !== runId) return "";
  return handoff.prompt;
}

const MAX_ID_LENGTH = 96;
const MAX_LABEL_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 220;
const MAX_REF_LENGTH = 180;
const MAX_HREF_LENGTH = 360;

export type AgentSessionPhase = "idle" | "planning" | "running" | "completed" | "failed";
export type AgentJournalStatus = "queued" | "running" | "completed" | "failed";

export type AgentContextAttachment = {
  ref: string;
  title: string;
  sourceHref?: string;
};

export type AgentJournalEntry = {
  id: string;
  commandId: string;
  kind: string;
  label: string;
  status: AgentJournalStatus;
  summary?: string;
  at: string;
};

export type AgentClientSessionState = {
  hydrated: boolean;
  expanded: boolean;
  draft: string;
  phase: AgentSessionPhase;
  commandId: string | null;
  summary: string;
  error: string;
  journal: AgentJournalEntry[];
  attachment: AgentContextAttachment | null;
};

export type PersistedAgentClientSession = {
  schemaVersion: typeof AGENT_CLIENT_SESSION_SCHEMA_VERSION;
  journal: AgentJournalEntry[];
  attachment: AgentContextAttachment | null;
};

export type PlannedSessionAction = Pick<AgentJournalEntry, "id" | "kind" | "label">;

const MAX_CANONICAL_APP_ROUTE_HISTORY = 32;

export function appendCanonicalAppRoute(
  history: readonly string[],
  candidate: string
): CanonicalAppHref[] {
  const safeHistory = history.filter(isCanonicalAppHref).slice(
    -MAX_CANONICAL_APP_ROUTE_HISTORY
  );
  if (!isCanonicalAppHref(candidate) || safeHistory.at(-1) === candidate) {
    return safeHistory;
  }
  return [...safeHistory, candidate].slice(-MAX_CANONICAL_APP_ROUTE_HISTORY);
}

export function consumeCanonicalAppBackRoute(
  history: readonly string[]
): { href: CanonicalAppHref | null; history: CanonicalAppHref[] } {
  const safeHistory = history.reduce<CanonicalAppHref[]>(
    (current, candidate) => appendCanonicalAppRoute(current, candidate),
    []
  );
  if (safeHistory.length < 2) {
    return { href: null, history: safeHistory };
  }
  const nextHistory = safeHistory.slice(0, -1);
  return {
    href: nextHistory.at(-1) ?? null,
    history: nextHistory
  };
}

export type LocalAppActionRuntime = {
  resolveBackHref: () => CanonicalAppHref | null;
  navigate: (href: CanonicalAppHref) => void;
  refresh: () => void;
};

export type LocalAppActionOutcome =
  | {
      status: "completed";
      summary: string;
      href?: CanonicalAppHref;
    }
  | {
      status: "unavailable";
      summary: string;
      errorCode: "APP_BACK_UNAVAILABLE";
    };

export function executeLocalAppAction(
  action: { id?: string; type: "app.go_back" | "app.refresh" },
  runtime: LocalAppActionRuntime
): LocalAppActionOutcome {
  if (action.type === "app.go_back") {
    const href = runtime.resolveBackHref();
    if (!href || !isCanonicalAppHref(href)) {
      return {
        status: "unavailable",
        summary: "当前会话没有可安全返回的站内上一页。",
        errorCode: "APP_BACK_UNAVAILABLE"
      };
    }
    runtime.navigate(href);
    return {
      status: "completed",
      summary: "已返回站内上一页。",
      href
    };
  }
  runtime.refresh();
  return {
    status: "completed",
    summary: "已请求刷新当前页面数据。"
  };
}

export type AgentSessionAction =
  | { type: "hydrate"; snapshot: PersistedAgentClientSession | null }
  | { type: "set_expanded"; expanded: boolean }
  | { type: "set_draft"; draft: string }
  | { type: "set_attachment"; attachment: AgentContextAttachment | null }
  | { type: "command_planning" }
  | { type: "command_started"; commandId: string; actions: PlannedSessionAction[] }
  | { type: "action_started"; actionId: string }
  | { type: "action_completed"; actionId: string; summary?: string }
  | { type: "action_failed"; actionId: string; message: string }
  | { type: "command_completed"; summary: string }
  | { type: "command_failed"; message: string }
  | { type: "reset_after_failure" };

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type WorkbenchDelegationInput = {
  prompt: string;
  mode: "live";
  collaborationMode: "default" | "plan";
  goalMode: boolean;
  contextRef?: string;
  intent?: "implement";
  priorActionReceipts?: WorkbenchPriorActionReceipt[];
};

export type PriorActionReceiptCandidate = Omit<
  WorkbenchPriorActionReceipt,
  "actionType"
> & {
  actionType: Exclude<AgentCommandAction["type"], "workbench.delegate">;
};

const FORWARDABLE_PRIOR_ACTION_TYPES = new Set<WorkbenchPriorActionType>([
  "navigate",
  "world.focus_weakest",
  "world.set_view",
  "world.set_window",
  "world.focus_learner",
  "workbench.show_surface",
  "workbench.set_mode",
  "workbench.set_goal",
  "context.attach_focused"
]);

export function isForwardablePriorActionType(
  actionType: AgentCommandAction["type"]
): actionType is WorkbenchPriorActionType {
  return FORWARDABLE_PRIOR_ACTION_TYPES.has(
    actionType as WorkbenchPriorActionType
  );
}

export function filterForwardablePriorActionReceipts(
  receipts: readonly PriorActionReceiptCandidate[]
): WorkbenchPriorActionReceipt[] {
  return receipts
    .filter(({ actionType }) => isForwardablePriorActionType(actionType))
    .map((receipt) => ({
      ...receipt,
      actionType: receipt.actionType as WorkbenchPriorActionType
    }))
    .slice(0, 8);
}

/**
 * A route mention is often inserted before a typed page action by the planner.
 * When the target page is already mounted, pushing its canonical href would
 * silently discard useful view/window/focus query state. Keep that page in
 * place only when the current bridge owns the route and a later action will be
 * executed by that same bridge; standalone navigation must still normalize to
 * the canonical route.
 */
export function shouldPreserveCurrentPageNavigation(input: {
  action: NavigateAction;
  actions: readonly AgentCommandAction[];
  index: number;
  currentPathname: string;
  currentBridgeRouteId?: AppRouteId | null;
}): boolean {
  if (
    input.currentPathname !== input.action.href ||
    input.currentBridgeRouteId !== input.action.routeId
  ) {
    return false;
  }

  return input.actions.slice(input.index + 1).some((candidate) =>
    candidate.type !== "navigate" &&
    candidate.type !== "workbench.delegate" &&
    "routeId" in candidate &&
    candidate.routeId === input.action.routeId
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function safePublicText(value: unknown, maxLength: number): string {
  return boundedText(value, maxLength)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[已隐藏]")
    .replace(/\b(?:bearer\s+)?[A-Za-z0-9_-]{24,}\b/gi, "[已隐藏]")
    .replace(/\b(token|cookie|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]");
}

function safeId(value: unknown): string {
  const text = boundedText(value, MAX_ID_LENGTH);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text) ? text : "";
}

function safeHref(value: unknown): string | undefined {
  const href = boundedText(value, MAX_HREF_LENGTH);
  if (!href || !href.startsWith("/") || href.startsWith("//")) return undefined;
  if (/[?&](?:token|cookie|password|secret|authorization|api[_-]?key)=/i.test(href)) {
    return undefined;
  }
  return href;
}

function safeContextRef(value: unknown): string {
  const ref = boundedText(value, MAX_REF_LENGTH);
  return /^(?:learner|course|invocation|decision|outcome|incident):[A-Za-z0-9._:-]+$/.test(ref)
    ? ref
    : "";
}

function isJournalStatus(value: unknown): value is AgentJournalStatus {
  return value === "queued" || value === "running" || value === "completed" || value === "failed";
}

function sanitizeAttachment(value: unknown): AgentContextAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const ref = safeContextRef(record.ref);
  const title = safePublicText(record.title, MAX_LABEL_LENGTH);
  if (!ref || !title) return null;
  const sourceHref = safeHref(record.sourceHref);
  return { ref, title, ...(sourceHref ? { sourceHref } : {}) };
}

function sanitizeJournalEntry(value: unknown): AgentJournalEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = safeId(record.id);
  const commandId = safeId(record.commandId);
  const kind = safePublicText(record.kind, 64);
  const label = safePublicText(record.label, MAX_LABEL_LENGTH);
  if (!id || !commandId || !kind || !label || !isJournalStatus(record.status)) return null;
  const summary = safePublicText(record.summary, MAX_SUMMARY_LENGTH);
  const at = boundedText(record.at, 40);
  return {
    id,
    commandId,
    kind,
    label,
    status: record.status,
    ...(summary ? { summary } : {}),
    at: /^\d{4}-\d{2}-\d{2}T/.test(at) ? at : nowIso()
  };
}

function boundedJournal(entries: AgentJournalEntry[]): AgentJournalEntry[] {
  return entries.slice(-MAX_AGENT_JOURNAL_ENTRIES);
}

function recoverInterruptedJournal(entries: AgentJournalEntry[]): AgentJournalEntry[] {
  return entries.map((entry) =>
    entry.status === "running" || entry.status === "queued"
      ? {
          ...entry,
          status: "failed",
          summary: "页面刷新后动作已中断，可重新执行命令。"
        }
      : entry
  );
}

export function createInitialAgentSessionState(): AgentClientSessionState {
  return {
    hydrated: false,
    expanded: false,
    draft: "",
    phase: "idle",
    commandId: null,
    summary: "",
    error: "",
    journal: [],
    attachment: null
  };
}

export function buildWorkbenchDelegationInput(
  prompt: string,
  collaborationMode: "default" | "plan",
  goalMode: boolean,
  attachment: AgentContextAttachment | null,
  priorActionReceipts: readonly PriorActionReceiptCandidate[] = []
): WorkbenchDelegationInput {
  const forwardableReceipts = filterForwardablePriorActionReceipts(
    priorActionReceipts
  );
  return {
    prompt,
    mode: "live",
    collaborationMode,
    goalMode,
    ...(attachment
      ? { contextRef: attachment.ref, intent: "implement" as const }
      : {}),
    ...(forwardableReceipts.length
      ? { priorActionReceipts: forwardableReceipts }
      : {})
  };
}

export function buildDelegatedWorkbenchPrompt(
  prompt: string,
  attachment: AgentContextAttachment | null,
  completedActionReceipts: readonly PriorActionReceiptCandidate[] = []
): string {
  const sections: string[] = [];
  const receipts = filterForwardablePriorActionReceipts(
    completedActionReceipts
  )
    .map((receipt) => safePublicText(receipt.summary, MAX_SUMMARY_LENGTH))
    .filter(Boolean);
  if (receipts.length) {
    sections.push(
      "页面动作回执（已通过当前页面状态回读）：",
      ...receipts.map((receipt) => `- ${receipt}`),
      "上述动作由产品页面动作层执行并已完成；不要将它们描述为未执行，也不要重复执行。最终答复必须明确区分：页面层动作已完成，本机执行只承接尚未完成的控制台任务。"
    );
  }
  const safeAttachment = sanitizeAttachment(attachment);
  if (safeAttachment) {
    sections.push(
      `当前已附加安全页面上下文：${safeAttachment.title}（${safeAttachment.ref}）。`,
      "仅使用该匿名引用和页面可见摘要继续任务，不读取论坛正文、身份或凭据。"
    );
  }
  sections.push(prompt.trim().slice(0, 20_000));
  return sections.filter(Boolean).join("\n\n");
}

function advanceJournal(
  journal: AgentJournalEntry[],
  commandId: string | null,
  actionId: string,
  status: "completed" | "failed",
  summary?: string
): AgentJournalEntry[] {
  if (!commandId) return journal;
  const changed = journal.map((entry) =>
    entry.commandId === commandId && entry.id === actionId
      ? { ...entry, status, ...(summary ? { summary: safePublicText(summary, MAX_SUMMARY_LENGTH) } : {}) }
      : entry
  );
  if (status === "failed") return changed;
  const nextIndex = changed.findIndex((entry) =>
    entry.status === "queued" && entry.commandId === commandId
  );
  if (nextIndex < 0) return changed;
  return changed.map((entry, index) => index === nextIndex ? { ...entry, status: "running" } : entry);
}

export function reduceAgentSession(
  state: AgentClientSessionState,
  action: AgentSessionAction
): AgentClientSessionState {
  switch (action.type) {
    case "hydrate":
      return {
        ...state,
        hydrated: true,
        journal: action.snapshot?.journal ?? state.journal,
        attachment: action.snapshot?.attachment ?? state.attachment
      };
    case "set_expanded":
      return { ...state, expanded: action.expanded };
    case "set_draft":
      return { ...state, draft: action.draft };
    case "set_attachment":
      return { ...state, attachment: sanitizeAttachment(action.attachment) };
    case "command_planning":
      return { ...state, phase: "planning", error: "", summary: "" };
    case "command_started": {
      const at = nowIso();
      const commandId = safeId(action.commandId) || "local-command";
      const entries = action.actions.map((item, index) => ({
        id: safeId(item.id) || `${commandId}-${index + 1}`,
        commandId,
        kind: safePublicText(item.kind, 64) || "action",
        label: safePublicText(item.label, MAX_LABEL_LENGTH) || "执行页面动作",
        status: (index === 0 ? "running" : "queued") as AgentJournalStatus,
        at
      }));
      return {
        ...state,
        phase: "running",
        commandId,
        draft: "",
        summary: "",
        error: "",
        journal: boundedJournal([...state.journal, ...entries])
      };
    }
    case "action_started":
      return {
        ...state,
        journal: state.journal.map((entry) =>
          entry.commandId === state.commandId && entry.id === action.actionId
            ? { ...entry, status: "running" }
            : entry
        )
      };
    case "action_completed":
      return {
        ...state,
        journal: advanceJournal(
          state.journal,
          state.commandId,
          action.actionId,
          "completed",
          action.summary
        )
      };
    case "action_failed":
      return {
        ...state,
        phase: "failed",
        error: safePublicText(action.message, MAX_SUMMARY_LENGTH) || "动作未能完成。",
        journal: advanceJournal(
          state.journal,
          state.commandId,
          action.actionId,
          "failed",
          action.message
        )
      };
    case "command_completed":
      return {
        ...state,
        phase: "completed",
        commandId: null,
        summary: safePublicText(action.summary, MAX_SUMMARY_LENGTH),
        error: "",
        journal: state.journal.map((entry) =>
          entry.commandId === state.commandId &&
          (entry.status === "queued" || entry.status === "running")
            ? { ...entry, status: "completed" }
            : entry
        )
      };
    case "command_failed":
      return {
        ...state,
        phase: "failed",
        commandId: null,
        error: safePublicText(action.message, MAX_SUMMARY_LENGTH) || "任务未能完成。"
      };
    case "reset_after_failure":
      return { ...state, phase: "idle", commandId: null, summary: "", error: "" };
  }
}

export function persistAgentClientSession(
  storage: StorageLike,
  state: AgentClientSessionState
): void {
  const snapshot: PersistedAgentClientSession = {
    schemaVersion: AGENT_CLIENT_SESSION_SCHEMA_VERSION,
    journal: boundedJournal(
      state.journal
        .map(sanitizeJournalEntry)
        .filter((entry): entry is AgentJournalEntry => entry !== null)
    ),
    attachment: sanitizeAttachment(state.attachment)
  };
  try {
    storage.setItem(AGENT_CLIENT_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // sessionStorage can be unavailable or full; the live session remains usable.
  }
}

export function loadAgentClientSession(storage: StorageLike): PersistedAgentClientSession | null {
  try {
    const raw = storage.getItem(AGENT_CLIENT_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== AGENT_CLIENT_SESSION_SCHEMA_VERSION || !Array.isArray(record.journal)) {
      return null;
    }
    return {
      schemaVersion: AGENT_CLIENT_SESSION_SCHEMA_VERSION,
      journal: recoverInterruptedJournal(
        boundedJournal(
          record.journal
            .map(sanitizeJournalEntry)
            .filter((entry): entry is AgentJournalEntry => entry !== null)
        )
      ),
      attachment: sanitizeAttachment(record.attachment)
    };
  } catch {
    return null;
  }
}
