import type { WorkbenchCourseToolTransport } from "@/lib/workbench/course-tool-transport";
import type { CourseAgentToolkit } from "@/lib/workbench/course-agent-toolkit";
import type { WorkbenchDb } from "@/lib/workbench/durable-ledger";

const SESSION_TTL_MS = 30 * 60_000;
const SESSION_LIMIT = 12;
const STORE_KEY = "__cmooc_course_agent_session_store__";

export type CourseAgentProcessSession = Readonly<{
  taskId: string;
  runId: string;
  courseAlias: string;
  toolkit: CourseAgentToolkit;
  transport: WorkbenchCourseToolTransport;
  db?: WorkbenchDb;
  registeredAt: string;
  expiresAt: string;
}>;

type SessionStore = Map<string, CourseAgentProcessSession>;

function store(): SessionStore {
  const root = globalThis as typeof globalThis & {
    [STORE_KEY]?: SessionStore;
  };
  root[STORE_KEY] ??= new Map<string, CourseAgentProcessSession>();
  return root[STORE_KEY];
}

function prune(now = Date.now()): void {
  const sessions = store();
  for (const [runId, session] of sessions) {
    if (Date.parse(session.expiresAt) <= now) sessions.delete(runId);
  }
  while (sessions.size >= SESSION_LIMIT) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (!oldest) break;
    sessions.delete(oldest);
  }
}

/**
 * Process-local only: this keeps protected artifact handles and exact runtime
 * closures available across the approval request. Nothing is serialized.
 */
export function registerCourseAgentProcessSession(input: {
  taskId: string;
  runId: string;
  courseAlias: string;
  toolkit: CourseAgentToolkit;
  transport: WorkbenchCourseToolTransport;
  db?: WorkbenchDb;
  now?: Date;
}): CourseAgentProcessSession {
  const now = input.now ?? new Date();
  prune(now.getTime());
  const session = Object.freeze({
    taskId: input.taskId,
    runId: input.runId,
    courseAlias: input.courseAlias,
    toolkit: input.toolkit,
    transport: input.transport,
    ...(input.db ? { db: input.db } : {}),
    registeredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString()
  });
  store().set(input.runId, session);
  return session;
}

export function getCourseAgentProcessSession(
  runId: string,
  now = new Date()
): CourseAgentProcessSession | null {
  prune(now.getTime());
  return store().get(runId) ?? null;
}

export function deleteCourseAgentProcessSession(runId: string): boolean {
  return store().delete(runId);
}

export function resetCourseAgentProcessSessionsForTests(): void {
  store().clear();
}
