import { prisma as defaultPrisma } from "@/lib/db";
import {
  SAFE_WORKBENCH_STATE,
  WORKBENCH_LINEAGE_SCHEMA_VERSION,
  WORKBENCH_SCHEMA_VERSION,
  isWorkbenchRunLineage,
  isWorkbenchSessionWorkspaceSummary,
  isWorkbenchPendingAction,
  isSafeRunId,
  isTerminalWorkbenchStatus,
  redactPublicText,
  type WorkbenchRunSnapshot,
  type WorkbenchRunStatus
} from "@/lib/workbench/contracts";
import { syncWorkbenchSessionWorkspace } from "@/lib/workbench/session-workspace";
import { quarantineCourseToolRunAfterProcessLoss } from "@/lib/workbench/course-tool-action-store";
import {
  getWorkbenchRun,
  subscribeWorkbenchRun
} from "@/lib/workbench/run-store";

export type WorkbenchHistoryItem = {
  id: string;
  title: string;
  status: WorkbenchRunStatus;
  source: "app-server" | "demo";
  contextTitle?: string;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  recoveryState?: "interrupted";
  lineage?: WorkbenchRunSnapshot["lineage"];
  sessionWorkspace?: WorkbenchRunSnapshot["sessionWorkspace"];
  canReuse?: boolean;
  containsForumText: false;
};

const persistenceQueue = new Map<string, Promise<void>>();
const subscriptions = new Map<string, () => void>();

function safeDate(value: string): Date {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function lineageRootRunId(snapshot: WorkbenchRunSnapshot): string {
  if (isWorkbenchRunLineage(snapshot.lineage, snapshot.id)) {
    return snapshot.lineage.rootRunId;
  }
  return snapshot.id;
}

function parseSnapshot(value: string): WorkbenchRunSnapshot | null {
  try {
    const parsed = JSON.parse(value) as WorkbenchRunSnapshot;
    if (
      parsed.schemaVersion === WORKBENCH_SCHEMA_VERSION &&
      isSafeRunId(parsed.id) &&
      parsed.lineage === undefined
    ) {
      parsed.lineage = {
        schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
        relation: "root",
        rootRunId: parsed.id,
        generation: 0
      };
    }
    if (
      parsed.schemaVersion !== WORKBENCH_SCHEMA_VERSION ||
      !isSafeRunId(parsed.id) ||
      !isWorkbenchRunLineage(parsed.lineage, parsed.id) ||
      (parsed.courseGoalCode !== undefined &&
        parsed.courseGoalCode !== "course_evidence_support_gap" &&
        parsed.courseGoalCode !== "research_evidence_package" &&
        parsed.courseGoalCode !== "schedule_review" &&
        parsed.courseGoalCode !== "open_course_task") ||
      parsed.safety?.externalWritesLocked !== true ||
      parsed.safety?.realPublishEnabled !== false ||
      parsed.safety?.externalMutationAttempted !== false ||
      parsed.safety?.editorWriteCount !== 0 ||
      parsed.safety?.publishAttemptCount !== 0 ||
      parsed.safety?.containsForumText !== false ||
      !Array.isArray(parsed.events) ||
      !Array.isArray(parsed.agents) ||
      !Array.isArray(parsed.tools) ||
      !Array.isArray(parsed.artifacts) ||
      (parsed.pendingAction !== undefined &&
        !isWorkbenchPendingAction(parsed.pendingAction)) ||
      (parsed.sessionWorkspace !== undefined &&
        !isWorkbenchSessionWorkspaceSummary(parsed.sessionWorkspace))
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function toDurableSnapshot(snapshot: WorkbenchRunSnapshot): WorkbenchRunSnapshot {
  const terminalResourceStatus = snapshot.status === "completed" ||
    snapshot.status === "failed" ||
    snapshot.status === "stopped"
      ? snapshot.status
      : undefined;
  return {
    ...snapshot,
    events: snapshot.events.map((event) => {
      const durableEvent = { ...event };
      delete durableEvent.liveExcerpt;
      return durableEvent;
    }),
    agents: snapshot.agents.map((agent) =>
      terminalResourceStatus && agent.status === "running"
        ? { ...agent, status: terminalResourceStatus }
        : { ...agent }
    ),
    tools: snapshot.tools.map((tool) =>
      terminalResourceStatus && tool.status === "running"
        ? { ...tool, status: terminalResourceStatus }
        : { ...tool }
    ),
    pendingAction: snapshot.pendingAction
      ? {
          ...snapshot.pendingAction,
          operationBoundary: { ...snapshot.pendingAction.operationBoundary }
        }
      : undefined,
    lineage: snapshot.lineage ? { ...snapshot.lineage } : undefined,
    ...(snapshot.goal?.status === "active"
      ? {
          goal: {
            ...snapshot.goal,
            status: "paused" as const,
            updatedAt: snapshot.updatedAt
          }
        }
      : {}),
    capabilities: {
      ...snapshot.capabilities,
      canSteer: false,
      canStop: false,
      canRestart:
        snapshot.status === "failed" &&
        snapshot.source === "app-server" &&
        Boolean(snapshot.sessionWorkspace),
      canContinue:
        snapshot.status === "completed" &&
        snapshot.source === "app-server" &&
        Boolean(snapshot.finalResult)
    }
  };
}

async function persistNow(
  snapshot: WorkbenchRunSnapshot,
  db = defaultPrisma
): Promise<void> {
  const durableSnapshot = toDurableSnapshot(snapshot);
  const taskId = `task-${lineageRootRunId(snapshot)}`;
  const existingTask = await db.workbenchTask.findUnique({
    where: { id: taskId },
    select: { id: true, contextSnapshotId: true }
  });
  let contextSnapshotId = existingTask?.contextSnapshotId ?? undefined;
  if (!existingTask && snapshot.context) {
    const contextRow = await db.workbenchContextSnapshot.create({
      data: {
        schemaVersion: snapshot.context.schemaVersion,
        contextRef: snapshot.context.ref,
        kind: snapshot.context.kind,
        courseAlias: snapshot.context.courseAlias,
        invocationId: snapshot.context.invocationId,
        evidenceHash: snapshot.context.evidenceHash,
        contextJson: JSON.stringify(snapshot.context),
        containsForumText: false
      },
      select: { id: true }
    });
    contextSnapshotId = contextRow.id;
  }

  const title = redactPublicText(
    snapshot.taskTitle ?? snapshot.context?.title ?? "课程研判任务",
    160
  );
  const finishedAt = isTerminalWorkbenchStatus(snapshot.status)
    ? safeDate(snapshot.finalResult?.completedAt ?? snapshot.updatedAt)
    : null;

  await db.$transaction(async (tx) => {
    await tx.workbenchTask.upsert({
      where: { id: taskId },
      create: {
        id: taskId,
        title,
        status: snapshot.status,
        contextSnapshotId,
        createdAt: safeDate(snapshot.createdAt),
        completedAt: finishedAt
      },
      update: {}
    });
    await tx.workbenchRunRecord.upsert({
      where: { id: snapshot.id },
      create: {
        id: snapshot.id,
        taskId,
        schemaVersion: snapshot.schemaVersion,
        source: snapshot.source,
        status: snapshot.status,
        projectLabel: snapshot.projectLabel,
        snapshotJson: JSON.stringify(durableSnapshot),
        errorCode: snapshot.errorCode,
        createdAt: safeDate(snapshot.createdAt),
        updatedAt: safeDate(snapshot.updatedAt),
        finishedAt
      },
      update: {
        taskId,
        status: snapshot.status,
        snapshotJson: JSON.stringify(durableSnapshot),
        errorCode: snapshot.errorCode,
        recoveryState: null,
        updatedAt: safeDate(snapshot.updatedAt),
        finishedAt
      }
    });
    const latestTaskRun = await tx.workbenchRunRecord.findFirst({
      where: { taskId },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true }
    });
    if (latestTaskRun?.id === snapshot.id) {
      await tx.workbenchTask.update({
        where: { id: taskId },
        data: {
          title,
          status: snapshot.status,
          completedAt: finishedAt
        }
      });
    }
    for (const event of snapshot.events) {
      await tx.workbenchEventRecord.upsert({
        where: { runId_sequence: { runId: snapshot.id, sequence: event.seq } },
        create: {
          runId: snapshot.id,
          sequence: event.seq,
          kind: event.kind,
          status: event.status,
          title: event.title,
          summary: event.summary,
          agentLabel: event.agentLabel,
          agentRole: event.agentRole,
          createdAt: safeDate(event.at)
        },
        update: {}
      });
    }
    for (const artifact of snapshot.artifacts) {
      await tx.workbenchArtifactRecord.upsert({
        where: {
          runId_artifactId: { runId: snapshot.id, artifactId: artifact.id }
        },
        create: {
          runId: snapshot.id,
          artifactId: artifact.id,
          label: artifact.label,
          relativePath: artifact.relativePath,
          kind: artifact.kind,
          status: artifact.status,
          observedAt: safeDate(artifact.observedAt)
        },
        update: {
          label: artifact.label,
          relativePath: artifact.relativePath,
          kind: artifact.kind,
          status: artifact.status,
          observedAt: safeDate(artifact.observedAt)
        }
      });
    }
  });
  if (durableSnapshot.sessionWorkspace) {
    // Keep the Nutstore bundle aligned with the durable projection.  In
    // particular, an in-memory active goal is intentionally paused at the
    // persistence boundary and must not remain active only in session.json.
    await syncWorkbenchSessionWorkspace(durableSnapshot).catch(() => undefined);
  }
}

export function persistWorkbenchRunSnapshot(
  snapshot: WorkbenchRunSnapshot,
  db = defaultPrisma
): Promise<void> {
  const previous = persistenceQueue.get(snapshot.id) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => persistNow(snapshot, db));
  persistenceQueue.set(snapshot.id, current);
  void current
    .finally(() => {
      if (persistenceQueue.get(snapshot.id) === current) {
        persistenceQueue.delete(snapshot.id);
      }
    })
    .catch(() => undefined);
  return current;
}

export function attachWorkbenchPersistence(runId: string): () => void {
  subscriptions.get(runId)?.();
  const unsubscribe = subscribeWorkbenchRun(runId, () => {
    const snapshot = getWorkbenchRun(runId);
    if (!snapshot) return;
    void persistWorkbenchRunSnapshot(snapshot).finally(() => {
      if (isTerminalWorkbenchStatus(snapshot.status) && !snapshot.capabilities.canSteer) {
        subscriptions.get(runId)?.();
        subscriptions.delete(runId);
      }
    });
  });
  if (!unsubscribe) return () => undefined;
  subscriptions.set(runId, unsubscribe);
  return () => {
    unsubscribe();
    if (subscriptions.get(runId) === unsubscribe) subscriptions.delete(runId);
  };
}

export async function loadPersistentWorkbenchRun(
  runId: string,
  db = defaultPrisma
): Promise<WorkbenchRunSnapshot | null> {
  const row = await db.workbenchRunRecord.findUnique({
    where: { id: runId },
    select: { snapshotJson: true }
  });
  const snapshot = row ? parseSnapshot(row.snapshotJson) : null;
  return snapshot ? toDurableSnapshot(snapshot) : null;
}

export async function recoverInterruptedWorkbenchRuns(
  db = defaultPrisma
): Promise<number> {
  const rows = await db.workbenchRunRecord.findMany({
    where: { status: { in: ["queued", "starting", "running", "awaiting_action"] } },
    select: { id: true, taskId: true, snapshotJson: true }
  });
  let recovered = 0;
  for (const row of rows) {
    if (getWorkbenchRun(row.id)) continue;
    const at = new Date().toISOString();
    const snapshot = parseSnapshot(row.snapshotJson);
    if (!snapshot) {
      await db.$transaction([
        db.workbenchRunRecord.update({
          where: { id: row.id },
          data: {
            status: "failed",
            errorCode: "WORKBENCH_SNAPSHOT_INVALID",
            recoveryState: "interrupted",
            updatedAt: new Date(at),
            finishedAt: new Date(at)
          }
        }),
        db.workbenchTask.update({
          where: { id: row.taskId },
          data: { status: "failed", completedAt: new Date(at) }
        })
      ]);
      recovered += 1;
      continue;
    }
    const lostPendingAction =
      snapshot.status === "awaiting_action" || Boolean(snapshot.pendingAction);
    if (lostPendingAction) {
      const ledgerTables = await db.$queryRaw<Array<{ name: string }>>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'WorkbenchCourseToolActionRecord'
        LIMIT 1
      `;
      if (ledgerTables.length === 1) {
        await quarantineCourseToolRunAfterProcessLoss(db, {
          taskId: row.taskId,
          runId: row.id,
          at
        });
      }
    }
    const failed: WorkbenchRunSnapshot = {
      ...snapshot,
      status: "failed",
      updatedAt: at,
      pendingAction: undefined,
      errorCode: lostPendingAction
        ? "WORKBENCH_ACTION_SESSION_LOST"
        : "WORKBENCH_PROCESS_LOST",
      finalResult: {
        status: "failed",
        summary: lostPendingAction
          ? "本机进程在等待受保护动作决定时中断；旧审批卡及任何未消费授权已失效，系统没有自动执行或重放动作，可以从原上下文重新启动。"
          : "本机进程曾中断；这次任务保留为可查看的运行证据，可以从原上下文重新启动。",
        completedAt: at
      },
      capabilities: {
        ...snapshot.capabilities,
        canSteer: false,
        canStop: false,
        canRestart: snapshot.source === "app-server" && Boolean(snapshot.sessionWorkspace),
        canContinue: false
      },
      safety: { ...SAFE_WORKBENCH_STATE }
    };
    // A process-loss recovery is a durable lifecycle transition.  Normalize
    // the same paused goal projection that API loads and session bundles use,
    // so no surface can continue advertising an active goal after recovery.
    const durableFailed = toDurableSnapshot(failed);
    await db.$transaction([
      db.workbenchRunRecord.update({
        where: { id: row.id },
        data: {
          status: "failed",
          snapshotJson: JSON.stringify(durableFailed),
          errorCode: lostPendingAction
            ? "WORKBENCH_ACTION_SESSION_LOST"
            : "WORKBENCH_PROCESS_LOST",
          recoveryState: "interrupted",
          updatedAt: new Date(at),
          finishedAt: new Date(at)
        }
      }),
      db.workbenchTask.update({
        where: { id: row.taskId },
        data: { status: "failed", completedAt: new Date(at) }
      })
    ]);
    if (durableFailed.sessionWorkspace) {
      await syncWorkbenchSessionWorkspace(durableFailed).catch(() => undefined);
    }
    recovered += 1;
  }
  return recovered;
}

export async function listPersistentWorkbenchRuns(
  limit = 12,
  db = defaultPrisma
): Promise<WorkbenchHistoryItem[]> {
  await recoverInterruptedWorkbenchRuns(db);
  const rows = await db.workbenchRunRecord.findMany({
    orderBy: { updatedAt: "desc" },
    take: 20,
    include: {
      task: { include: { contextSnapshot: true } },
      _count: { select: { events: true } }
    }
  });
  return rows.flatMap((row) => {
    const snapshot = parseSnapshot(row.snapshotJson);
    if (!snapshot) return [];
    const sessionWorkspace = snapshot.sessionWorkspace;
    return [{
      id: row.id,
      title: row.task.title,
      status: row.status as WorkbenchRunStatus,
      source: row.source === "demo" ? "demo" as const : "app-server" as const,
      contextTitle: row.task.contextSnapshot
        ? (JSON.parse(row.task.contextSnapshot.contextJson) as { title?: string }).title
        : undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      eventCount: row._count.events,
      recoveryState:
        row.recoveryState === "interrupted" ? "interrupted" as const : undefined,
      lineage: snapshot.lineage ? { ...snapshot.lineage } : undefined,
      sessionWorkspace: isWorkbenchSessionWorkspaceSummary(sessionWorkspace)
        ? { ...sessionWorkspace }
        : undefined,
      canReuse: row.source !== "demo" && Boolean(sessionWorkspace),
      containsForumText: false as const
    }];
  }).slice(0, Math.max(1, Math.min(20, Math.floor(limit))));
}

export async function resetWorkbenchHistorySubscriptionsForTests(): Promise<void> {
  for (const unsubscribe of subscriptions.values()) unsubscribe();
  subscriptions.clear();

  while (persistenceQueue.size > 0) {
    const pending = [...persistenceQueue.values()];
    await Promise.allSettled(pending);
    for (const [runId, queued] of persistenceQueue) {
      if (pending.includes(queued)) persistenceQueue.delete(runId);
    }
  }
  persistenceQueue.clear();
}
