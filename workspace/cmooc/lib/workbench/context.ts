import { prisma as defaultPrisma } from "@/lib/db";
import {
  getAutonomyWorldReadModel,
  type AutonomyWorldReadModel
} from "@/lib/autonomy/world-read-model";
import type {
  WorkbenchContextKind,
  WorkbenchContextSummary
} from "@/lib/workbench/contracts";

const SAFE_REF =
  /^(course|snapshot|invocation|decision|outcome|incident):([A-Za-z0-9_-]{1,128})$/;
const SAFE_LEARNER_REF =
  /^learner:([A-Za-z0-9_-]{1,128})__(actor-[0-9]{3,6})$/;

type WorldReadModelLoader = (input: {
  courseAlias?: string | null;
  snapshotId?: string | null;
}) => Promise<AutonomyWorldReadModel>;

function summary(input: Omit<WorkbenchContextSummary, "schemaVersion" | "containsForumText" | "containsIdentity">): WorkbenchContextSummary {
  return {
    schemaVersion: "cmooc.workbench-context.v1",
    ...input,
    containsForumText: false,
    containsIdentity: false
  };
}

export async function resolveWorkbenchContext(
  ref: string,
  db = defaultPrisma,
  loadWorld: WorldReadModelLoader = getAutonomyWorldReadModel
): Promise<WorkbenchContextSummary | null> {
  const learnerMatch = SAFE_LEARNER_REF.exec(ref);
  if (learnerMatch) {
    const snapshotId = learnerMatch[1];
    const actorId = learnerMatch[2];
    const snapshot = await db.courseWorldSnapshot.findUnique({
      where: { id: snapshotId },
      select: {
        id: true,
        courseAlias: true,
        asOfAt: true,
        worldHash: true
      }
    });
    if (!snapshot) return null;

    const world = await loadWorld({
      courseAlias: snapshot.courseAlias,
      snapshotId: snapshot.id
    });
    if (
      world.snapshot?.id !== snapshot.id ||
      world.selectedCourse?.alias !== snapshot.courseAlias ||
      world.graph.roleRegistryStatus !== "complete"
    ) {
      return null;
    }

    const positions = world.learnerPositions.filter(
      (position) => position.actorId === actorId
    );
    const learner =
      positions.find(
        (position) => position.windowKind === "rolling_30d"
      ) ?? positions[0];
    if (!learner) return null;

    const evidenceBoundary =
      learner.coverageStatus === "complete" &&
      world.graph.coverageStatus === "complete"
        ? "当前可观察完整窗口"
        : learner.coverageStatus === "insufficient_data"
          ? "当前证据不足"
          : "当前可观察下界";
    const params = new URLSearchParams({
      course: snapshot.courseAlias,
      snapshot: snapshot.id,
      view: "learner_position",
      window: learner.windowKind,
      focus: learner.actorId
    });
    return summary({
      ref,
      kind: "learner",
      title: learner.actorLabel,
      courseAlias: snapshot.courseAlias,
      state: `${evidenceBoundary} · ${learner.windowKind} · 事件 ${learner.eventCount} · 双向同伴 ${learner.reciprocalPeerCount}`,
      evidenceAsOf: snapshot.asOfAt.toISOString(),
      evidenceHash: snapshot.worldHash,
      sourceHref: `/autonomy/world?${params.toString()}`
    });
  }

  const match = SAFE_REF.exec(ref);
  if (!match) return null;
  const kind = match[1] as WorkbenchContextKind;
  const id = match[2];

  if (kind === "snapshot") {
    const row = await db.courseWorldSnapshot.findUnique({
      where: { id },
      select: {
        id: true,
        invocationId: true,
        courseAlias: true,
        asOfAt: true,
        worldHash: true,
        eventCount: true,
        threadCount: true,
        openGapCount: true,
        invocation: {
          select: {
            id: true,
            courseAlias: true
          }
        }
      }
    });
    if (
      !row ||
      row.invocation.id !== row.invocationId ||
      row.invocation.courseAlias !== row.courseAlias
    ) {
      return null;
    }
    const params = new URLSearchParams({
      course: row.courseAlias,
      snapshot: row.id,
      view: "course_structure",
      window: "rolling_30d"
    });
    return summary({
      ref,
      kind,
      title: "课程世界快照",
      courseAlias: row.courseAlias,
      invocationId: row.invocationId,
      state: `事件 ${row.eventCount} · 讨论 ${row.threadCount} · 可见支持缺口 ${row.openGapCount}`,
      evidenceAsOf: row.asOfAt.toISOString(),
      evidenceHash: row.worldHash,
      sourceHref: `/autonomy/world?${params.toString()}`
    });
  }

  if (kind === "decision") {
    const row = await db.autonomyDecision.findUnique({
      where: { id },
      select: {
        id: true,
        courseAlias: true,
        invocationId: true,
        decision: true,
        reasonCode: true,
        evidenceAsOf: true,
        evidenceBundleHash: true
      }
    });
    if (!row) return null;
    return summary({
      ref,
      kind,
      title: `课程决定 · ${row.decision}`,
      courseAlias: row.courseAlias,
      invocationId: row.invocationId,
      state: `${row.decision}:${row.reasonCode}`,
      evidenceAsOf: row.evidenceAsOf.toISOString(),
      evidenceHash: row.evidenceBundleHash,
      sourceHref: `/autonomy/runs/${row.invocationId}`
    });
  }

  if (kind === "invocation") {
    const row = await db.scheduledInvocation.findUnique({
      where: { id },
      select: {
        id: true,
        courseAlias: true,
        status: true,
        phase: true,
        scheduledFor: true,
        invocationKey: true
      }
    });
    if (!row) return null;
    return summary({
      ref,
      kind,
      title: "课程运行证据",
      courseAlias: row.courseAlias,
      invocationId: row.id,
      state: `${row.status}:${row.phase}`,
      evidenceAsOf: row.scheduledFor.toISOString(),
      evidenceHash: row.invocationKey,
      sourceHref: `/autonomy/runs/${row.id}`
    });
  }

  if (kind === "outcome") {
    const row = await db.proximalOutcome.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        observationWindow: true,
        dueAt: true,
        eventPrefixHash: true,
        decision: {
          select: { courseAlias: true, invocationId: true }
        }
      }
    });
    if (!row) return null;
    return summary({
      ref,
      kind,
      title: `近端观察 · ${row.observationWindow}`,
      courseAlias: row.decision.courseAlias,
      invocationId: row.decision.invocationId,
      state: row.status,
      evidenceAsOf: row.dueAt.toISOString(),
      evidenceHash: row.eventPrefixHash ?? undefined,
      sourceHref: "/autonomy/outcomes"
    });
  }

  if (kind === "incident") {
    const row = await db.autonomyIncident.findUnique({
      where: { id },
      select: {
        id: true,
        courseAlias: true,
        invocationId: true,
        status: true,
        code: true,
        openedAt: true,
        evidenceHash: true
      }
    });
    if (!row) return null;
    return summary({
      ref,
      kind,
      title: "运行异常",
      courseAlias: row.courseAlias,
      invocationId: row.invocationId ?? undefined,
      state: `${row.status}:${row.code}`,
      evidenceAsOf: row.openedAt.toISOString(),
      evidenceHash: row.evidenceHash,
      sourceHref: "/review/live"
    });
  }

  const manifest = await db.autonomyCourseManifest.findUnique({
    where: { alias: id },
    select: {
      alias: true,
      enabled: true,
      defaultMode: true,
      manifestHash: true,
      updatedAt: true
    }
  });
  if (!manifest) return null;
  return summary({
    ref,
    kind: "course",
    title: "课程现场",
    courseAlias: manifest.alias,
    state: manifest.enabled ? manifest.defaultMode : "disabled",
    evidenceAsOf: manifest.updatedAt.toISOString(),
    evidenceHash: manifest.manifestHash,
    sourceHref: "/autonomy/world"
  });
}

export function buildWorkbenchContextEnvelope(
  context: WorkbenchContextSummary
): string {
  return [
    "已附加一份只含去正文事实的课程上下文。",
    `类型：${context.kind}`,
    `标题：${context.title}`,
    ...(context.kind === "learner" ? [] : [`定位引用：${context.ref}`]),
    `课程：${context.courseAlias ?? "未绑定"}`,
    `状态：${context.state}`,
    `证据时间：${context.evidenceAsOf ?? "未知"}`,
    "只把它作为定位与验收边界；不要推断或复述论坛正文、身份或凭据。"
  ].join("\n");
}
