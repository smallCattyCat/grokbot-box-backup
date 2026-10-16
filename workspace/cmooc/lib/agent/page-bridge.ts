import type {
  ContextAttachFocusedAction,
  PlatformInspectReadinessAction,
  WorkbenchSetGoalAction,
  WorkbenchSetModeAction,
  WorkbenchShowSurfaceAction,
  WorkbenchStopAction,
  WorldFocusLearnerAction,
  WorldFocusWeakestAction,
  WorldSetViewAction,
  WorldSetWindowAction
} from "./command-planner";
import {
  isCanonicalAppHref,
  type AppRouteId,
  type CanonicalAppHref
} from "./app-routes";

export const PAGE_BRIDGE_STATE_VERSION = "cmooc.page-bridge-state.v1" as const;
export const PAGE_ACTION_RESULT_VERSION = "cmooc.page-action-result.v1" as const;

export type PageBridgeAction =
  | WorldFocusWeakestAction
  | ContextAttachFocusedAction
  | WorldSetViewAction
  | WorldSetWindowAction
  | WorldFocusLearnerAction
  | PlatformInspectReadinessAction
  | WorkbenchShowSurfaceAction
  | WorkbenchSetModeAction
  | WorkbenchSetGoalAction
  | WorkbenchStopAction;
export type PageBridgeActionType = PageBridgeAction["type"];

export type PageBridgeMetadataValue =
  | string
  | number
  | boolean
  | null
  | readonly PageBridgeMetadataValue[]
  | { readonly [key: string]: PageBridgeMetadataValue };

export type PageBridgeMetadata = Readonly<
  Record<string, PageBridgeMetadataValue>
>;

export type PageBridgeContext = {
  kind: "learner";
  id: string;
  ref?: string;
  label: string;
  title?: string;
  sourceHref: string;
  summary?: string;
  containsIdentity: false;
  containsForumText: false;
};

export type PageBridgeState = {
  schemaVersion: typeof PAGE_BRIDGE_STATE_VERSION;
  routeId: AppRouteId;
  href: CanonicalAppHref;
  status: "ready" | "busy" | "error";
  capabilities: readonly PageBridgeActionType[];
  revision: number;
  summary: string;
  focusedContext?: PageBridgeContext;
  attachedContexts: readonly PageBridgeContext[];
  metadata?: PageBridgeMetadata;
  courseAlias?: string | null;
  snapshotId?: string | null;
  view?: string;
  window?: string;
  focusedLearnerId?: string | null;
  focusedLearnerLabel?: string | null;
  containsIdentity?: false;
  containsForumText: false;
  externalWrites: false;
};

export type PageActionStatus =
  | "completed"
  | "failed"
  | "unsupported"
  | "unavailable"
  | "cancelled";

export type PageActionResult = {
  schemaVersion: typeof PAGE_ACTION_RESULT_VERSION;
  actionId: string;
  actionType: PageBridgeActionType;
  routeId: AppRouteId;
  status: PageActionStatus;
  summary: string;
  retryable: boolean;
  state?: PageBridgeState;
  context?: PageBridgeContext;
  errorCode?: string;
  containsForumText: false;
  externalWrites: false;
};

export type PageBridgeExecutionOutcome = {
  status: PageActionStatus;
  summary: string;
  retryable?: boolean;
  state?: PageBridgeState;
  context?: PageBridgeContext;
  errorCode?: string;
};

export type PageBridgeRegistration = {
  routeId: AppRouteId;
  capabilities: readonly PageBridgeActionType[];
  readState: () => PageBridgeState;
  execute: (
    action: PageBridgeAction
  ) =>
    | PageBridgeExecutionOutcome
    | PageActionResult
    | Promise<PageBridgeExecutionOutcome | PageActionResult>;
};

export type PageBridgeWaitOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type PageActionExecutionOptions = {
  waitForMs?: number;
  signal?: AbortSignal;
};

type RegisteredBridge = {
  token: symbol;
  registration: PageBridgeRegistration;
};

type BridgeRegistry = {
  registrations: Map<AppRouteId, RegisteredBridge>;
  listeners: Set<() => void>;
};

type BrowserHost = Record<PropertyKey, unknown>;

const REGISTRY_KEY = Symbol.for("cmooc.page-bridge.registry.v1");
const DEFAULT_WAIT_MS = 2_000;

function getBrowserHost(): BrowserHost | null {
  const candidate = (globalThis as typeof globalThis & { window?: unknown })
    .window;
  if (
    (typeof candidate !== "object" || candidate === null) &&
    typeof candidate !== "function"
  ) {
    return null;
  }
  return candidate as unknown as BrowserHost;
}

function getRegistry(create: boolean): BridgeRegistry | null {
  const host = getBrowserHost();
  if (!host) return null;
  const current = host[REGISTRY_KEY];
  if (isBridgeRegistry(current)) return current;
  if (!create) return null;
  const registry: BridgeRegistry = {
    registrations: new Map(),
    listeners: new Set()
  };
  host[REGISTRY_KEY] = registry;
  return registry;
}

function isBridgeRegistry(value: unknown): value is BridgeRegistry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BridgeRegistry>;
  return (
    candidate.registrations instanceof Map &&
    candidate.listeners instanceof Set
  );
}

function notify(registry: BridgeRegistry): void {
  for (const listener of [...registry.listeners]) listener();
}

function safeReadState(
  registration: PageBridgeRegistration
): PageBridgeState | null {
  try {
    const state = registration.readState();
    return isSafePageState(state, registration.routeId) ? state : null;
  } catch {
    return null;
  }
}

export function isLocalAppHref(value: string): boolean {
  if (
    value.trim() !== value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  const pathname = value.split(/[?#]/u, 1)[0] ?? "";
  return isCanonicalAppHref(pathname);
}

function isSafePageContext(context: PageBridgeContext): boolean {
  return (
    context.containsIdentity === false &&
    context.containsForumText === false &&
    isLocalAppHref(context.sourceHref)
  );
}

function isSafePageState(
  state: PageBridgeState,
  routeId: AppRouteId
): boolean {
  return (
    state.schemaVersion === PAGE_BRIDGE_STATE_VERSION &&
    state.routeId === routeId &&
    isCanonicalAppHref(state.href) &&
    state.containsForumText === false &&
    state.externalWrites === false &&
    Number.isSafeInteger(state.revision) &&
    state.revision >= 0 &&
    (!state.focusedContext || isSafePageContext(state.focusedContext)) &&
    state.attachedContexts.every(isSafePageContext)
  );
}

function unavailableResult(
  action: PageBridgeAction,
  status: "unavailable" | "cancelled" = "unavailable"
): PageActionResult {
  return {
    schemaVersion: PAGE_ACTION_RESULT_VERSION,
    actionId: action.id,
    actionType: action.type,
    routeId: action.routeId,
    status,
    summary:
      status === "cancelled" ? "页面动作已取消。" : "目标页面尚未就绪。",
    retryable: status === "unavailable",
    errorCode:
      status === "cancelled"
        ? "PAGE_ACTION_CANCELLED"
        : "PAGE_BRIDGE_UNAVAILABLE",
    containsForumText: false,
    externalWrites: false
  };
}

export function registerPageBridge(
  registration: PageBridgeRegistration
): () => void {
  const registry = getRegistry(true);
  if (!registry) return () => undefined;

  const token = Symbol(registration.routeId);
  registry.registrations.set(registration.routeId, { token, registration });
  notify(registry);

  return () => {
    const current = registry.registrations.get(registration.routeId);
    if (current?.token !== token) return;
    registry.registrations.delete(registration.routeId);
    notify(registry);
  };
}

export function readPageBridgeState(
  routeId?: AppRouteId
): PageBridgeState | null {
  const registry = getRegistry(false);
  if (!registry) return null;

  if (routeId) {
    const bridge = registry.registrations.get(routeId);
    return bridge ? safeReadState(bridge.registration) : null;
  }

  const bridge = [...registry.registrations.values()].at(-1);
  return bridge ? safeReadState(bridge.registration) : null;
}

export async function waitForPageBridge(
  routeId: AppRouteId,
  options: PageBridgeWaitOptions = {}
): Promise<PageBridgeState | null> {
  const registry = getRegistry(true);
  if (!registry || options.signal?.aborted) return null;

  const existing = readPageBridgeState(routeId);
  if (existing) return existing;

  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
  if (timeoutMs <= 0) return null;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (state: PageBridgeState | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      registry.listeners.delete(onRegistryChange);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(state);
    };
    const onRegistryChange = () => {
      const state = readPageBridgeState(routeId);
      if (state) finish(state);
    };
    const onAbort = () => finish(null);
    const timeout = setTimeout(() => finish(null), timeoutMs);

    registry.listeners.add(onRegistryChange);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    onRegistryChange();
  });
}

export async function executePageAction(
  action: PageBridgeAction,
  options: PageActionExecutionOptions = {}
): Promise<PageActionResult> {
  if (options.signal?.aborted) return unavailableResult(action, "cancelled");

  let registry = getRegistry(false);
  let registered = registry?.registrations.get(action.routeId);
  if (!registered && (options.waitForMs ?? 0) > 0) {
    await waitForPageBridge(action.routeId, {
      timeoutMs: options.waitForMs,
      signal: options.signal
    });
    registry = getRegistry(false);
    registered = registry?.registrations.get(action.routeId);
  }

  if (options.signal?.aborted) return unavailableResult(action, "cancelled");
  if (!registered) return unavailableResult(action);

  const registration = registered.registration;
  if (!registration.capabilities.includes(action.type)) {
    return {
      schemaVersion: PAGE_ACTION_RESULT_VERSION,
      actionId: action.id,
      actionType: action.type,
      routeId: action.routeId,
      status: "unsupported",
      summary: "当前页面不支持此动作。",
      retryable: false,
      errorCode: "PAGE_ACTION_UNSUPPORTED",
      containsForumText: false,
      externalWrites: false
    };
  }

  try {
    const outcome = await registration.execute(action);
    if (
      (outcome.context && !isSafePageContext(outcome.context)) ||
      (outcome.state &&
        !isSafePageState(outcome.state, registration.routeId))
    ) {
      return {
        schemaVersion: PAGE_ACTION_RESULT_VERSION,
        actionId: action.id,
        actionType: action.type,
        routeId: action.routeId,
        status: "failed",
        summary: "页面返回了不安全的动作结果。",
        retryable: false,
        errorCode: "PAGE_BRIDGE_UNSAFE_RESULT",
        containsForumText: false,
        externalWrites: false
      };
    }
    return {
      schemaVersion: PAGE_ACTION_RESULT_VERSION,
      actionId: action.id,
      actionType: action.type,
      routeId: action.routeId,
      status: outcome.status,
      summary: outcome.summary,
      retryable: outcome.retryable ?? outcome.status === "failed",
      ...(outcome.state ? { state: outcome.state } : {}),
      ...(outcome.context ? { context: outcome.context } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      containsForumText: false,
      externalWrites: false
    };
  } catch {
    return {
      schemaVersion: PAGE_ACTION_RESULT_VERSION,
      actionId: action.id,
      actionType: action.type,
      routeId: action.routeId,
      status: "failed",
      summary: "页面动作执行失败。",
      retryable: true,
      errorCode: "PAGE_BRIDGE_EXECUTION_FAILED",
      containsForumText: false,
      externalWrites: false
    };
  }
}
