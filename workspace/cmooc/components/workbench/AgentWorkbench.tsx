"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { Brain } from "@phosphor-icons/react/dist/csr/Brain";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { FolderSimple } from "@phosphor-icons/react/dist/csr/FolderSimple";
import { Info } from "@phosphor-icons/react/dist/csr/Info";
import { LockKey } from "@phosphor-icons/react/dist/csr/LockKey";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { GlobeHemisphereWest } from "@phosphor-icons/react/dist/csr/GlobeHemisphereWest";
import { Monitor } from "@phosphor-icons/react/dist/csr/Monitor";
import { Play } from "@phosphor-icons/react/dist/csr/Play";
import { PlusCircle } from "@phosphor-icons/react/dist/csr/PlusCircle";
import { Robot } from "@phosphor-icons/react/dist/csr/Robot";
import { Stop } from "@phosphor-icons/react/dist/csr/Stop";
import { Toolbox } from "@phosphor-icons/react/dist/csr/Toolbox";
import { UsersThree } from "@phosphor-icons/react/dist/csr/UsersThree";
import { GlassCard } from "@/components/ui/glass-card";
import { StatusPill } from "@/components/ui/status-pill";
import { useAgentSession } from "@/components/agent/AgentSessionProvider";
import {
  ConversationBrief,
  OpportunityCanvas,
  TodayBriefTrigger
} from "@/components/workbench/CourseOpportunityBrief";
import { WorkbenchRuntimeStatus } from "@/components/workbench/WorkbenchRuntimeStatus";
import { WorkbenchSchedulePanel } from "@/components/workbench/WorkbenchSchedulePanel";
import {
  OperatorCourseLocator,
  OperatorReplyTargetCard
} from "@/components/workbench/OperatorCourseLocator";
import { defaultCourseContext } from "@/lib/workbench/default-course-context";
import {
  hasLocalPageActions,
  inferCommandModes,
  planAgentCommand
} from "@/lib/agent/command-planner";
import { registerPageBridge } from "@/lib/agent/page-bridge";
import {
  WORKBENCH_PAGE_ACTION_CAPABILITIES,
  createWorkbenchPageBridgeState,
  executeWorkbenchPageAction
} from "@/lib/agent/workbench-page-actions";
import {
  WORKBENCH_RUN_STORAGE_KEY,
  WORKBENCH_TASK_STORAGE_KEY,
  resolveTransientWorkbenchPrompt,
  resolveWorkbenchRestoreRunId
} from "@/lib/agent/client-session";
import {
  isSafeRunId,
  isTerminalWorkbenchStatus,
  isWorkbenchRunLineage,
  isWorkbenchSessionWorkspaceSummary,
  isWorkbenchPendingAction,
  sanitizeWorkbenchLiveExcerpt,
  sanitizeWorkbenchCitations,
  type WorkbenchAgent,
  type WorkbenchArtifact,
  type WorkbenchEvent,
  type WorkbenchEventKind,
  type WorkbenchEventStatus,
  type WorkbenchFinalResult,
  type WorkbenchCollaborationMode,
  type WorkbenchGoalState,
  type WorkbenchPlanState,
  type WorkbenchPlanStepStatus,
  type WorkbenchPendingAction,
  type WorkbenchRunSnapshot,
  type WorkbenchRunStatus,
  type WorkbenchTool,
  type WorkbenchContextSummary
} from "@/lib/workbench/contracts";
import type {
  OperatorOpportunity,
  OperatorWorkspaceReadModel
} from "@/lib/workbench/operator-read-model";
import type { CourseOpportunityBriefItem } from "@/lib/workbench/course-opportunity-brief";
import type { WorkbenchHistoryItem } from "@/lib/workbench/history-store";
import {
  type ActionPreview,
  type AgentNativeWorkbenchViewModel,
  type AttentionItem,
  type DecisionBrief
} from "@/lib/workbench/agent-native-contracts";
import { buildAgentNativeWorkbenchHref } from "@/lib/workbench/agent-native-adapter";
import { formatDecisionReason } from "@/lib/autonomy/run-operator-presentation";
import {
  buildWorkbenchConversation,
  formatWorkbenchAnswer,
  groupWorkbenchTaskHistory,
  projectWorkbenchActivity,
  reconcileWorkbenchHistory,
  resolveWorkbenchContextTitle,
  type WorkbenchActivityProjection,
  type WorkbenchConversationBlock
} from "@/lib/workbench/presentation";
import styles from "./Workbench.module.css";

const MAX_PROMPT_LENGTH = 20_000;
const MAX_PROTECTED_PREVIEW_LENGTH = 50_000;
const MAX_PROTECTED_DRAFT_EDIT_LENGTH = 4_000;
const LIVE_TASK_LABEL = "本机课程任务";
const DEMO_TASK_LABEL = "演示工作台任务";
const DECISION_REASON_CODE = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/u;

const STATUS_LABELS: Record<WorkbenchRunStatus, string> = {
  queued: "排队中",
  starting: "启动中",
  running: "运行中",
  awaiting_action: "等待本次授权",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止"
};

const EVENT_STATUS_LABELS: Record<WorkbenchEventStatus, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  info: "信息"
};

function planStepStatusLabel(status: WorkbenchPlanStepStatus): string {
  return {
    pending: "待处理",
    inProgress: "进行中",
    completed: "已完成"
  }[status];
}

type TransportState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";
type ConsoleView = "conversation" | "schedule";

type UnknownRecord = Record<string, unknown>;
type RequestFailure = Error & { status?: number };
type LocalUserMessage = {
  id: string;
  runId: string;
  at: string;
  text: string;
  kind: "task" | "guidance";
};

type CourseArtifactVerification = {
  status: "passed" | "failed" | "unknown" | "not_recorded";
  verifier: string | null;
  verifierVersion: string | null;
  safeSummary: string;
  observedAt: string | null;
  expiresAt: string | null;
};

type CourseArtifactRecovery = {
  bodyPersisted: false;
  exactResume: false;
  action: "regenerate_and_reverify" | "reenter_or_regenerate" | "durable_projection_only";
  reason: "restricted_body_is_process_local" | "restricted_body_expired" | "content_not_exposed_by_workspace";
};

type CourseArtifactPreviewAvailability = {
  status: "available" | "regenerate_or_reenter";
  oneShot: true;
  bodyPersisted: false;
  expiresAt: string | null;
  reason: "bound_in_current_process" | "binding_expired" | "binding_missing_or_process_restarted" | "binding_scope_changed";
};

type CourseArtifactVersion = {
  taskId: string;
  runId: string;
  versionId: string;
  versionRef: string;
  artifactId: string;
  artifactRef: string;
  version: number;
  artifactKind: string;
  contentClass: string;
  contentHash: string;
  draftBodyHash: string | null;
  safeSummary: string;
  createdAt: string;
  expiresAt: string | null;
  expired: boolean;
  verification: CourseArtifactVerification;
  recovery: CourseArtifactRecovery;
  preview: CourseArtifactPreviewAvailability;
};

type CourseArtifactWorkspaceProjection = {
  schemaVersion: "cmooc.workbench.artifact-workspace-read-model.v1";
  taskId: string;
  runId: string;
  versions: CourseArtifactVersion[];
  bodyIncluded: false;
  bodyPersistedByWorkspace: false;
};

type ProtectedArtifactView =
  | {
      kind: "preview";
      versionId: string;
      version: number;
      body: string;
      consumedAt: string;
    }
  | {
      kind: "diff";
      fromVersionId: string;
      fromVersion: number;
      toVersionId: string;
      toVersion: number;
      operations: Array<{ kind: "equal" | "remove" | "add"; text: string }>;
      consumedAt: string;
    };

type ProtectedArtifactCorrection = {
  versionId: string;
  versionRef: string;
  artifactId: string;
  version: number;
  contentHash: string;
  draftBodyHash: string;
  safeSummary: string;
  verificationRef: string;
  previewExpiresAt: string;
  changed: boolean;
  operations: Array<{ kind: "equal" | "remove" | "add"; text: string }>;
};

const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableSafeString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function normalizeCourseArtifactVerification(value: unknown): CourseArtifactVerification | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (
    status !== "passed" &&
    status !== "failed" &&
    status !== "unknown" &&
    status !== "not_recorded"
  ) {
    return null;
  }
  const safeSummary = stringValue(value.safeSummary);
  if (!safeSummary) return null;
  return {
    status,
    verifier: nullableSafeString(value.verifier),
    verifierVersion: nullableSafeString(value.verifierVersion),
    safeSummary,
    observedAt: nullableSafeString(value.observedAt),
    expiresAt: nullableSafeString(value.expiresAt)
  };
}

function normalizeCourseArtifactRecovery(value: unknown): CourseArtifactRecovery | null {
  if (!isRecord(value) || value.bodyPersisted !== false || value.exactResume !== false) {
    return null;
  }
  const action = value.action;
  const reason = value.reason;
  if (
    (action !== "regenerate_and_reverify" &&
      action !== "reenter_or_regenerate" &&
      action !== "durable_projection_only") ||
    (reason !== "restricted_body_is_process_local" &&
      reason !== "restricted_body_expired" &&
      reason !== "content_not_exposed_by_workspace")
  ) {
    return null;
  }
  return { bodyPersisted: false, exactResume: false, action, reason };
}

function normalizeCourseArtifactPreviewAvailability(
  value: unknown
): CourseArtifactPreviewAvailability | null {
  if (!isRecord(value) || value.oneShot !== true || value.bodyPersisted !== false) return null;
  const status = value.status;
  const reason = value.reason;
  if (
    (status !== "available" && status !== "regenerate_or_reenter") ||
    (reason !== "bound_in_current_process" &&
      reason !== "binding_expired" &&
      reason !== "binding_missing_or_process_restarted" &&
      reason !== "binding_scope_changed")
  ) {
    return null;
  }
  return {
    status,
    oneShot: true,
    bodyPersisted: false,
    expiresAt: nullableSafeString(value.expiresAt),
    reason
  };
}

function normalizeCourseArtifactVersion(
  value: unknown,
  expectedRunId: string,
  expectedTaskId: string
): CourseArtifactVersion | null {
  if (!isRecord(value)) return null;
  const versionId = stringValue(value.versionId);
  const versionRef = stringValue(value.versionRef);
  const artifactId = stringValue(value.artifactId);
  const artifactRef = stringValue(value.artifactRef);
  const contentHash = stringValue(value.contentHash);
  const draftBodyHash = nullableSafeString(value.draftBodyHash);
  const version = numberValue(value.version, NaN);
  const verification = normalizeCourseArtifactVerification(value.verification);
  const recovery = normalizeCourseArtifactRecovery(value.recovery);
  const preview = normalizeCourseArtifactPreviewAvailability(value.preview);
  if (
    stringValue(value.runId) !== expectedRunId ||
    stringValue(value.taskId) !== expectedTaskId ||
    !SAFE_ARTIFACT_ID.test(versionId) ||
    versionRef !== `artifact-version:${versionId}` ||
    !SAFE_ARTIFACT_ID.test(artifactId) ||
    artifactRef !== `artifact:${artifactId}` ||
    !Number.isInteger(version) ||
    version < 1 ||
    !stringValue(value.artifactKind) ||
    !stringValue(value.contentClass) ||
    !SHA256.test(contentHash) ||
    (draftBodyHash !== null && !SHA256.test(draftBodyHash)) ||
    !stringValue(value.safeSummary) ||
    !stringValue(value.createdAt) ||
    typeof value.expired !== "boolean" ||
    !verification ||
    !recovery ||
    !preview
  ) {
    return null;
  }
  return {
    taskId: expectedTaskId,
    runId: expectedRunId,
    versionId,
    versionRef,
    artifactId,
    artifactRef,
    version,
    artifactKind: stringValue(value.artifactKind),
    contentClass: stringValue(value.contentClass),
    contentHash,
    draftBodyHash,
    safeSummary: stringValue(value.safeSummary),
    createdAt: stringValue(value.createdAt),
    expiresAt: nullableSafeString(value.expiresAt),
    expired: value.expired,
    verification,
    recovery,
    preview
  };
}

function normalizeCourseArtifactWorkspace(
  value: unknown,
  expectedRunId: string
): CourseArtifactWorkspaceProjection | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== "cmooc.workbench.artifact-workspace-read-model.v1" ||
    stringValue(value.runId) !== expectedRunId ||
    !SAFE_ARTIFACT_ID.test(stringValue(value.taskId)) ||
    value.bodyIncluded !== false ||
    value.bodyPersistedByWorkspace !== false ||
    !Array.isArray(value.versions)
  ) {
    return null;
  }
  const taskId = stringValue(value.taskId);
  const versions = value.versions.map((item) =>
    normalizeCourseArtifactVersion(item, expectedRunId, taskId)
  );
  if (versions.some((version) => version === null)) return null;
  return {
    schemaVersion: "cmooc.workbench.artifact-workspace-read-model.v1",
    taskId,
    runId: expectedRunId,
    versions: versions as CourseArtifactVersion[],
    bodyIncluded: false,
    bodyPersistedByWorkspace: false
  };
}

function statusValue(value: unknown): WorkbenchRunStatus {
  return value === "queued" ||
    value === "starting" ||
    value === "running" ||
    value === "awaiting_action" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped"
    ? value
    : "queued";
}

function eventStatusValue(value: unknown): WorkbenchEventStatus {
  return value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped" ||
    value === "info"
    ? value
    : "info";
}

function eventKindValue(value: unknown): WorkbenchEventKind {
  return value === "run" ||
    value === "agent" ||
    value === "plan" ||
    value === "tool" ||
    value === "artifact" ||
    value === "message" ||
    value === "result" ||
    value === "warning" ||
    value === "error"
    ? value
    : "message";
}

function normalizeEvent(value: unknown): WorkbenchEvent | null {
  if (!isRecord(value)) {
    return null;
  }

  const seq = numberValue(value.seq, NaN);
  const runId = stringValue(value.runId);
  const at = stringValue(value.at);
  const title = stringValue(value.title);
  if (
    value.schemaVersion !== "cmooc.workbench.v1" ||
    !Number.isFinite(seq) ||
    !isSafeRunId(runId) ||
    !at ||
    !title
  ) {
    return null;
  }

  const event: WorkbenchEvent = {
    schemaVersion: "cmooc.workbench.v1",
    runId,
    seq,
    at,
    kind: eventKindValue(value.kind),
    status: eventStatusValue(value.status),
    title,
    summary: stringValue(value.summary) || undefined,
    liveExcerpt: sanitizeWorkbenchLiveExcerpt(value.liveExcerpt),
    agentKey: stringValue(value.agentKey) || undefined,
    agentLabel: stringValue(value.agentLabel) || undefined,
    agentRole:
      value.agentRole === "sol" || value.agentRole === "luna" || value.agentRole === "system"
        ? value.agentRole
        : undefined,
    presentationRole:
      value.presentationRole === "user" ||
      value.presentationRole === "assistant" ||
      value.presentationRole === "system" ||
      value.presentationRole === "tool"
        ? value.presentationRole
        : undefined,
    toolKey: stringValue(value.toolKey) || undefined,
    artifactId: stringValue(value.artifactId) || undefined,
    activityId: /^activity-[A-Za-z0-9_-]{1,72}$/.test(stringValue(value.activityId))
      ? stringValue(value.activityId)
      : undefined
  };
  return event;
}

function normalizeAgent(value: unknown): WorkbenchAgent | null {
  if (!isRecord(value) || !stringValue(value.key) || !stringValue(value.label)) {
    return null;
  }
  const status = value.status;
  return {
    key: stringValue(value.key),
    label: stringValue(value.label),
    role:
      value.role === "sol" || value.role === "luna" || value.role === "system"
        ? value.role
        : "system",
    status:
      status === "idle" ||
      status === "running" ||
      status === "completed" ||
      status === "failed" ||
      status === "stopped"
        ? status
        : "idle",
    taskSummary: stringValue(value.taskSummary) || undefined,
    lastActivityAt: stringValue(value.lastActivityAt) || new Date().toISOString()
  };
}

function normalizeTool(value: unknown): WorkbenchTool | null {
  if (!isRecord(value) || !stringValue(value.key) || !stringValue(value.label)) {
    return null;
  }
  const status = value.status;
  return {
    key: stringValue(value.key),
    label: stringValue(value.label),
    category:
      value.category === "shell" ||
      value.category === "filesystem" ||
      value.category === "search" ||
      value.category === "collaboration" ||
      value.category === "other"
        ? value.category
        : "other",
    status:
      status === "running" || status === "completed" || status === "failed" || status === "stopped"
        ? status
        : "completed",
    callCount: Math.max(0, Math.floor(numberValue(value.callCount))),
    lastActivityAt: stringValue(value.lastActivityAt) || new Date().toISOString()
  };
}

function normalizeSnapshot(value: unknown): WorkbenchRunSnapshot | null {
  if (!isRecord(value) || value.schemaVersion !== "cmooc.workbench.v1" || !stringValue(value.id) || !isSafeRunId(stringValue(value.id))) {
    return null;
  }
  if (value.source !== "app-server" && value.source !== "demo") {
    return null;
  }

  const safety = isRecord(value.safety) ? value.safety : null;
  if (
    !safety ||
    safety.externalWritesLocked !== true ||
    safety.realPublishEnabled !== false ||
    safety.externalMutationAttempted !== false ||
    safety.editorWriteCount !== 0 ||
    safety.publishAttemptCount !== 0 ||
    safety.containsForumText !== false
  ) {
    return null;
  }

  const rawEvents = Array.isArray(value.events)
    ? value.events.map(normalizeEvent).filter((item): item is WorkbenchEvent => Boolean(item))
    : [];
  const events = [...new Map(rawEvents.map((event) => [event.seq, event])).values()].sort(
    (left, right) => left.seq - right.seq
  );
  const rawAgents = Array.isArray(value.agents)
    ? value.agents.map(normalizeAgent).filter((item): item is WorkbenchAgent => Boolean(item))
    : [];
  const rawTools = Array.isArray(value.tools)
    ? value.tools.map(normalizeTool).filter((item): item is WorkbenchTool => Boolean(item))
    : [];
  const rawArtifacts: WorkbenchArtifact[] = Array.isArray(value.artifacts)
    ? value.artifacts
        .filter(isRecord)
        .filter((artifact) => stringValue(artifact.id) && stringValue(artifact.relativePath))
        .map((artifact) => ({
          id: stringValue(artifact.id),
          label: stringValue(artifact.label, "未命名产物"),
          relativePath: stringValue(artifact.relativePath),
          kind:
            artifact.kind === "created" ||
            artifact.kind === "updated" ||
            artifact.kind === "deleted" ||
            artifact.kind === "other"
              ? artifact.kind
              : "other",
          status: artifact.status === "failed" ? "failed" : "ready",
          observedAt: stringValue(artifact.observedAt) || new Date().toISOString()
        }))
    : [];

  const rawFinalResult = isRecord(value.finalResult) ? value.finalResult : undefined;
  const finalCitations = sanitizeWorkbenchCitations(rawFinalResult?.citations);
  const finalResult: WorkbenchFinalResult | undefined = rawFinalResult
    ? {
        status:
          rawFinalResult.status === "failed" || rawFinalResult.status === "stopped"
            ? rawFinalResult.status
            : "completed",
        summary: stringValue(rawFinalResult.summary),
        completedAt: stringValue(rawFinalResult.completedAt) || new Date().toISOString(),
        ...(finalCitations.length ? { citations: finalCitations } : {})
      }
    : undefined;

  const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
  const rawPlan = isRecord(value.plan) ? value.plan : null;
  const planSteps = rawPlan && Array.isArray(rawPlan.steps)
    ? rawPlan.steps.flatMap((entry) => {
        if (!isRecord(entry) || !stringValue(entry.step)) return [];
        const status: WorkbenchPlanStepStatus = entry.status === "completed"
          ? "completed"
          : entry.status === "inProgress"
            ? "inProgress"
            : "pending";
        return [{ step: stringValue(entry.step), status }];
      })
    : [];
  const plan: WorkbenchPlanState | undefined = rawPlan
    ? {
        explanation: stringValue(rawPlan.explanation) || undefined,
        steps: planSteps,
        updatedAt: stringValue(rawPlan.updatedAt) || new Date().toISOString()
      }
    : undefined;
  const rawGoal = isRecord(value.goal) ? value.goal : null;
  const goalStatus = rawGoal?.status;
  const goal: WorkbenchGoalState | undefined = rawGoal && (
    goalStatus === "active" ||
    goalStatus === "paused" ||
    goalStatus === "blocked" ||
    goalStatus === "usageLimited" ||
    goalStatus === "budgetLimited" ||
    goalStatus === "complete"
  )
    ? {
        status: goalStatus,
        tokenBudget: typeof rawGoal.tokenBudget === "number"
          ? Math.max(0, Math.floor(rawGoal.tokenBudget))
          : undefined,
        tokensUsed: Math.max(0, Math.floor(numberValue(rawGoal.tokensUsed))),
        timeUsedSeconds: Math.max(0, Math.floor(numberValue(rawGoal.timeUsedSeconds))),
        updatedAt: stringValue(rawGoal.updatedAt) || new Date().toISOString()
      }
    : undefined;
  const rawContext = isRecord(value.context) ? value.context : null;
  const context: WorkbenchContextSummary | undefined =
    rawContext &&
    rawContext.schemaVersion === "cmooc.workbench-context.v1" &&
    typeof rawContext.ref === "string" &&
    typeof rawContext.title === "string" &&
    (rawContext.kind === "course" ||
      rawContext.kind === "snapshot" ||
      rawContext.kind === "invocation" ||
      rawContext.kind === "decision" ||
      rawContext.kind === "outcome" ||
      rawContext.kind === "incident" ||
      rawContext.kind === "learner") &&
    rawContext.containsForumText === false
      ? {
          schemaVersion: "cmooc.workbench-context.v1",
          ref: rawContext.ref,
          kind: rawContext.kind,
          title: rawContext.title,
          courseAlias: stringValue(rawContext.courseAlias) || undefined,
          invocationId: stringValue(rawContext.invocationId) || undefined,
          state: stringValue(rawContext.state),
          evidenceAsOf: stringValue(rawContext.evidenceAsOf) || undefined,
          evidenceHash: stringValue(rawContext.evidenceHash) || undefined,
          sourceHref: stringValue(rawContext.sourceHref) || undefined,
          containsForumText: false,
          containsIdentity: false
        }
      : undefined;
  const firstEventSeq = numberValue(value.firstEventSeq, events[0]?.seq ?? 0);
  const lastEventSeq = numberValue(
    value.lastEventSeq,
    events[events.length - 1]?.seq ?? firstEventSeq
  );
  const sessionWorkspace = isWorkbenchSessionWorkspaceSummary(value.sessionWorkspace)
    ? { ...value.sessionWorkspace }
    : undefined;
  const lineage = isWorkbenchRunLineage(value.lineage, stringValue(value.id))
    ? { ...value.lineage }
    : undefined;

  return {
    schemaVersion: "cmooc.workbench.v1",
    id: stringValue(value.id),
    status: statusValue(value.status),
    source: value.source === "demo" ? "demo" : "app-server",
    projectLabel: "cMOOC 源码工作区",
    collaborationMode: value.collaborationMode === "plan" ? "plan" : "default",
    goalMode: value.goalMode === true,
    lineage,
    plan,
    goal,
    taskTitle: stringValue(value.taskTitle) || undefined,
    context,
    courseGoalCode:
      value.courseGoalCode === "course_evidence_support_gap" ||
      value.courseGoalCode === "research_evidence_package" ||
      value.courseGoalCode === "schedule_review" ||
      value.courseGoalCode === "open_course_task"
        ? value.courseGoalCode
        : undefined,
    sessionWorkspace,
    createdAt: stringValue(value.createdAt) || new Date().toISOString(),
    updatedAt: stringValue(value.updatedAt) || new Date().toISOString(),
    events,
    firstEventSeq,
    lastEventSeq,
    agents: rawAgents,
    tools: rawTools,
    artifacts: rawArtifacts,
    pendingAction: isWorkbenchPendingAction(value.pendingAction)
      ? {
          ...value.pendingAction,
          operationBoundary: { ...value.pendingAction.operationBoundary }
        }
      : undefined,
    finalResult,
    errorCode: stringValue(value.errorCode) || undefined,
    safety: safety as WorkbenchRunSnapshot["safety"],
    capabilities: {
      canSteer: Boolean(capabilities.canSteer),
      canStop: Boolean(capabilities.canStop),
      canRestart: Boolean(capabilities.canRestart),
      canContinue: Boolean(capabilities.canContinue),
      liveHarness: Boolean(capabilities.liveHarness),
      planMode: Boolean(capabilities.planMode),
      goalMode: Boolean(capabilities.goalMode),
      computerUse: capabilities.computerUse === "external-read-only"
        ? "external-read-only"
        : undefined
    }
  };
}

function extractSnapshot(value: unknown): WorkbenchRunSnapshot | null {
  const direct = normalizeSnapshot(value);
  if (direct) {
    return direct;
  }
  if (!isRecord(value)) {
    return null;
  }
  for (const key of ["snapshot", "run", "data"]) {
    const candidate = normalizeSnapshot(value[key]);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function extractRunId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const direct = stringValue(value.id) || stringValue(value.runId);
  if (direct) {
    return direct;
  }
  for (const key of ["snapshot", "run", "data"]) {
    const nested = extractRunId(value[key]);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (isRecord(value)) {
    for (const key of ["message", "error", "detail"]) {
      const nested = value[key];
      if (typeof nested === "string" && nested.trim()) {
        return nested.trim();
      }
      if (isRecord(nested) && typeof nested.message === "string" && nested.message.trim()) {
        return nested.message.trim();
      }
    }
  }
  return fallback;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function requestFailure(message: string, status?: number): RequestFailure {
  const failure = new Error(message) as RequestFailure;
  failure.status = status;
  return failure;
}

function isHarnessUnavailableStatus(status: number | undefined): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

async function fetchSnapshot(runId: string, signal?: AbortSignal): Promise<WorkbenchRunSnapshot> {
  const response = await fetch(`/api/workbench/runs/${encodeURIComponent(runId)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
    cache: "no-store"
  });
  const payload = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(errorMessage(payload, `读取运行状态失败（${response.status}）。`));
  }
  const snapshot = extractSnapshot(payload);
  if (!snapshot) {
    throw new Error("运行状态格式无法识别，请稍后重试。");
  }
  return snapshot;
}

function mergeSnapshots(
  previous: WorkbenchRunSnapshot | null,
  incoming: WorkbenchRunSnapshot
): WorkbenchRunSnapshot {
  if (!previous || previous.id !== incoming.id) {
    return incoming;
  }
  const events = [...new Map([...previous.events, ...incoming.events].map((event) => [event.seq, event])).values()].sort(
    (left, right) => left.seq - right.seq
  );
  return {
    ...previous,
    ...incoming,
    events,
    firstEventSeq:
      previous.firstEventSeq === 0
        ? incoming.firstEventSeq
        : incoming.firstEventSeq === 0
          ? previous.firstEventSeq
          : Math.min(previous.firstEventSeq, incoming.firstEventSeq),
    lastEventSeq: Math.max(previous.lastEventSeq, incoming.lastEventSeq)
  };
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function formatActionExpiry(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间待核验";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function pendingActionDecisionError(status?: number): string {
  if (status === 400) return "请求未通过安全校验，未执行任何操作。";
  if (status === 404 || status === 409) {
    return "本次操作状态已变化，未执行。请等待最新状态回流。";
  }
  if (status === 410) return "本次操作已过期，未执行。请等待系统重新核验。";
  if (status === 423) return "本次操作当前不可用，未执行。请等待系统重新核验。";
  return "决定未能提交，未执行任何操作。请稍后重试。";
}

function statusTone(status: WorkbenchRunStatus | WorkbenchEventStatus):
  | "cyan"
  | "blue"
  | "violet"
  | "emerald"
  | "amber"
  | "danger"
  | "muted" {
  if (status === "completed") return "emerald";
  if (status === "failed") return "danger";
  if (status === "stopped") return "amber";
  if (status === "awaiting_action") return "amber";
  if (status === "running" || status === "starting") return "cyan";
  if (status === "queued") return "violet";
  return "muted";
}

function agentStatusLabel(status: WorkbenchAgent["status"]): string {
  return {
    idle: "待命",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    stopped: "已停止"
  }[status];
}

function toolStatusLabel(status: WorkbenchTool["status"]): string {
  return {
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    stopped: "已停止"
  }[status];
}

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const props = { size, className: styles.icon, "aria-hidden": true } as const;
  if (name === "lock") return <LockKey {...props} />;
  if (name === "monitor") return <Monitor {...props} />;
  if (name === "play") return <Play {...props} />;
  if (name === "stop") return <Stop {...props} />;
  if (name === "plus") return <PlusCircle {...props} />;
  if (name === "chevron") return <CaretDown {...props} />;
  if (name === "check") return <Check {...props} />;
  if (name === "brain") return <Brain {...props} />;
  if (name === "robot") return <Robot {...props} />;
  if (name === "tool") return <Toolbox {...props} />;
  if (name === "file") return <FileText {...props} />;
  if (name === "users") return <UsersThree {...props} />;
  if (name === "refresh") return <ArrowRight {...props} />;
  return <Info {...props} />;
}

function IdleTimeline({
  courseName,
  courseBound,
  brief,
  metrics,
  coverage,
  scheduledFor,
  decisions,
  opportunityCount,
  historyItem,
  historyButtonRef,
  historyOpen,
  onOpenHistory,
  onOpenHistoryItem,
  onOpenBrief
}: {
  courseName: string;
  courseBound: boolean;
  brief: OperatorWorkspaceReadModel["brief"];
  metrics: OperatorWorkspaceReadModel["metrics"];
  coverage: OperatorWorkspaceReadModel["coverage"];
  scheduledFor: OperatorWorkspaceReadModel["scheduledFor"];
  decisions: OperatorWorkspaceReadModel["decisions"];
  opportunityCount: number;
  historyItem: WorkbenchHistoryItem | null;
  historyButtonRef: Ref<HTMLButtonElement>;
  historyOpen: boolean;
  onOpenHistory: () => void;
  onOpenHistoryItem: (item: WorkbenchHistoryItem) => void;
  onOpenBrief: (
    item: CourseOpportunityBriefItem,
    trigger: HTMLButtonElement
  ) => void;
}) {
  return (
    <div className={styles.idleHomeLayout}>
      <div className={styles.idleIntro}>
        <p className={styles.idleCourseLabel}>当前课程</p>
        <div className={styles.idleCourseContext}>
          <span aria-hidden="true" />
          <strong>{courseBound ? courseName : "课程名称待核验"}</strong>
        </div>
        <section className={styles.idlePulse} aria-labelledby="idle-pulse-heading">
          <header className={styles.idlePulseHeader}>
            <div>
              <p className={styles.idlePulseEyebrow}>课程脉搏</p>
              <h2 id="idle-pulse-heading">最近一次巡检</h2>
            </div>
            <div className={styles.idlePulseMeta}>
              <span data-status={coverage.status}>
                {coverage.status === "complete"
                  ? "完整覆盖"
                  : coverage.status === "partial"
                    ? "部分覆盖"
                    : "待同步"}
              </span>
              <time dateTime={scheduledFor ?? undefined}>
                截至 {formatWorkspaceDate(scheduledFor)}
              </time>
            </div>
          </header>
          <dl className={styles.idlePulseMetrics}>
            <div>
              <dt>观察事件</dt>
              <dd>{metrics.events.toLocaleString("zh-CN")}</dd>
            </div>
            <div>
              <dt>讨论线程</dt>
              <dd>{metrics.threads.toLocaleString("zh-CN")}</dd>
            </div>
            <div>
              <dt>参与者</dt>
              <dd>{metrics.actors.toLocaleString("zh-CN")}</dd>
            </div>
            <div>
              <dt>待研判</dt>
              <dd>{opportunityCount.toLocaleString("zh-CN")}</dd>
            </div>
          </dl>
          <p className={styles.idlePulseSummary}>
            {decisions.draft + decisions.wait + decisions.abstain + decisions.yield > 0
              ? `本轮 ${decisions.draft + decisions.wait + decisions.abstain + decisions.yield} 项决定 · 克制 ${decisions.abstain} · 让位 ${decisions.yield}`
              : "本轮尚未形成决定"}
          </p>
        </section>
        <h1 id="idle-workbench-heading">接下来希望智能学伴完成什么？</h1>
        <TodayBriefTrigger brief={brief} onOpen={onOpenBrief} />
      </div>

      <aside className={styles.idleHistoryPreview} aria-labelledby="idle-history-heading">
        <header>
          <p id="idle-history-heading">
            {historyItem?.recoveryState === "interrupted" || historyItem?.canReuse
              ? "继续上次任务"
              : "打开上次任务"}
          </p>
          <button
            ref={historyButtonRef}
            type="button"
            className={styles.idleHistoryAll}
            aria-controls="task-history-drawer"
            aria-expanded={historyOpen}
            onClick={onOpenHistory}
          >
            任务历史 <ArrowRight size={13} aria-hidden="true" />
          </button>
        </header>
        {historyItem ? (
          <button
            type="button"
            className={styles.idleHistoryCard}
            onClick={() => onOpenHistoryItem(historyItem)}
          >
            <span className={styles.idleHistoryIcon} aria-hidden="true">
              <FileText size={18} />
            </span>
            <span className={styles.idleHistoryMain}>
              <strong>{publicTaskDisplayTitle(historyItem.title)}</strong>
              <small>课程任务 · {historyItem.eventCount} 条进展</small>
            </span>
            <span className={styles.idleHistoryMeta}>
              <strong>
                {historyItem.recoveryState === "interrupted"
                  ? "可恢复"
                  : historyItem.canReuse
                    ? "可继续"
                  : STATUS_LABELS[historyItem.status]}
              </strong>
              <time dateTime={historyItem.updatedAt}>
                {formatWorkspaceDate(historyItem.updatedAt)}
              </time>
            </span>
          </button>
        ) : (
          <p className={styles.idleHistoryEmpty}>暂无可继续的课程任务。</p>
        )}
      </aside>
    </div>
  );
}

function UserMessage({ message, fallback }: { message?: LocalUserMessage; fallback: string }) {
  return (
    <article className={styles.userMessage}>
      <div className={styles.messageByline}>
        <strong>你</strong>
        {message ? <time dateTime={message.at}>{formatTime(message.at).slice(0, 5)}</time> : null}
      </div>
      <p>{message?.text || fallback}</p>
    </article>
  );
}

function SystemBlock({ block }: { block: Extract<WorkbenchConversationBlock, { type: "system" }> }) {
  const latest = block.events[block.events.length - 1]!;
  return (
    <details className={styles.systemGroup}>
      <summary>
        <span className={styles.roleMark} data-role="system" aria-hidden="true" />
        <strong>系统</strong>
        <span>{publicTaskDisplayTitle(latest.title)}</span>
        <time dateTime={latest.at}>{formatTime(latest.at).slice(0, 5)}</time>
      </summary>
      <ol>
        {block.events.map((event) => (
          <li key={event.seq}>
            <span>{publicTaskDisplayTitle(event.title)}</span>
            <small>{EVENT_STATUS_LABELS[event.status]}</small>
          </li>
        ))}
      </ol>
    </details>
  );
}

function ProcessDetails({
  className,
  defaultExpanded,
  children
}: {
  className: string;
  defaultExpanded: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <details
      className={`${className} ${styles.processDetails}`}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      {children}
    </details>
  );
}

function AnalysisBlock({ block }: { block: Extract<WorkbenchConversationBlock, { type: "analysis" }> }) {
  const latest = block.events[block.events.length - 1]!;
  const running = block.events.some((event) => event.status === "running");
  return (
    <ProcessDetails
      className={styles.analysisGroup}
      defaultExpanded={false}
    >
      <summary>
        <span className={styles.roleMark} data-role="sol" aria-hidden="true" />
        <strong>{block.label}</strong>
        <span>{running ? "正在分析与规划" : `已整理 ${block.events.length} 项进展`}</span>
        <time dateTime={latest.at}>{formatTime(latest.at).slice(0, 5)}</time>
        <CaretDown size={14} aria-hidden="true" />
      </summary>
      <ol>
        {block.events.map((event) => (
          <li key={event.seq} data-status={event.status}>
            <span>{publicTaskDisplayTitle(event.title)}</span>
            <small>{EVENT_STATUS_LABELS[event.status]}</small>
          </li>
        ))}
      </ol>
    </ProcessDetails>
  );
}

function ToolBlock({ block }: { block: Extract<WorkbenchConversationBlock, { type: "tools" }> }) {
  const latest = block.events[block.events.length - 1]!;
  const running = block.events.some((event) => event.status === "running");
  const callCount = block.items.reduce((sum, item) => sum + item.occurrences, 0);
  return (
    <ProcessDetails className={styles.toolGroup} defaultExpanded={false}>
      <summary>
        <span className={styles.roleMark} data-role="tool" aria-hidden="true" />
        <strong>工具</strong>
        <span>工具调用 {callCount} 次 · {block.items.length} 项工具</span>
        <time dateTime={latest.at}>{formatTime(latest.at).slice(0, 5)}</time>
        <CaretDown size={14} aria-hidden="true" />
      </summary>
      <ul>
        {block.items.map((item) => (
          <li key={item.key} data-status={item.status}>
            <span className={styles.toolCheck} aria-hidden="true"><Check size={11} /></span>
            <span>{publicTaskDisplayTitle(item.label)}</span>
            <small>{item.occurrences} 次 · {EVENT_STATUS_LABELS[item.status]}</small>
          </li>
        ))}
      </ul>
    </ProcessDetails>
  );
}

const ARTIFACT_KIND_LABELS: Record<WorkbenchArtifact["kind"], string> = {
  created: "已创建",
  updated: "已更新",
  deleted: "已删除",
  other: "变化已记录"
};

function ArtifactBlock({
  block,
  artifacts
}: {
  block: Extract<WorkbenchConversationBlock, { type: "artifacts" }>;
  artifacts: readonly WorkbenchArtifact[];
}) {
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  return (
    <section className={styles.artifactGroup} aria-label="文件变化">
      <header>
        <span className={styles.roleMark} data-role="tool" aria-hidden="true" />
        <strong>文件变化</strong>
        <span>{block.events.length} 项已核验</span>
      </header>
      <ul>
        {block.events.map((event) => {
          const artifact = event.artifactId ? artifactById.get(event.artifactId) : undefined;
          return (
            <li key={event.seq} data-status={artifact?.status ?? event.status}>
              <FileText size={15} aria-hidden="true" />
              <span>
                <strong>{artifact ? publicTaskDisplayTitle(artifact.label) : "文件变化已记录"}</strong>
                {artifact ? <code>{artifact.relativePath}</code> : <small>详细路径未通过公开边界核验</small>}
              </span>
              <small>{artifact ? ARTIFACT_KIND_LABELS[artifact.kind] : EVENT_STATUS_LABELS[event.status]}</small>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AssistantUpdate({ block }: { block: Extract<WorkbenchConversationBlock, { type: "assistant" }> }) {
  const { event } = block;
  const label = publicTaskDisplayTitle(
    event.agentLabel || (event.agentRole === "luna" ? "协作智能体" : "主任务智能体")
  );
  return (
    <article className={styles.assistantUpdate} data-role={event.agentRole ?? "sol"}>
      <div className={styles.messageByline}>
        <span className={styles.roleMark} data-role={event.agentRole ?? "sol"} aria-hidden="true" />
        <strong>{label}</strong>
        <time dateTime={event.at}>{formatTime(event.at).slice(0, 5)}</time>
        <small>{event.status === "completed" ? "进展已记录" : EVENT_STATUS_LABELS[event.status]}</small>
      </div>
      <h3>{event.kind === "message" ? "执行进展" : publicTaskDisplayTitle(event.title)}</h3>
      {event.liveExcerpt ? (
        <blockquote className={styles.liveExcerpt} aria-label="当前进展摘录">
          <span>当前进展</span>
          <p>{publicTaskDisplayTitle(event.liveExcerpt)}</p>
          <footer>安全摘录 · 内部推理和敏感信息已隐藏</footer>
        </blockquote>
      ) : event.summary ? <p>{publicTaskDisplayTitle(event.summary)}</p> : null}
    </article>
  );
}

const COURSE_ARTIFACT_KIND_LABELS: Record<string, string> = {
  facilitation_reply_draft: "促进草稿",
  teaching_plan: "教学方案",
  course_announcement: "课程公告",
  course_analysis: "课程分析",
  cohort_slice: "群体切片",
  research_package: "研究证据包",
  course_schedule: "课程时间表"
};

const COURSE_ARTIFACT_VERIFICATION_LABELS: Record<CourseArtifactVerification["status"], string> = {
  passed: "验证通过",
  failed: "验证失败",
  unknown: "验证未知",
  not_recorded: "尚无验证回执"
};

function courseArtifactRecoveryLabel(version: CourseArtifactVersion): string {
  if (version.expired || version.recovery.action === "reenter_or_regenerate") {
    return "已过期 · 重新进入或再生成";
  }
  if (version.recovery.action === "regenerate_and_reverify") {
    return "正文不持久化 · 可再生成并复核";
  }
  return "仅保留安全投影";
}

function courseArtifactKindLabel(kind: string): string {
  return COURSE_ARTIFACT_KIND_LABELS[kind] ?? "课程成果";
}

function parseProtectedPreview(
  value: unknown,
  version: CourseArtifactVersion
): Extract<ProtectedArtifactView, { kind: "preview" }> | null {
  if (!isRecord(value) || !isRecord(value.preview)) return null;
  const preview = value.preview;
  const body = stringValue(preview.body);
  if (
    preview.schemaVersion !== "cmooc.workbench.protected-artifact-preview.v1" ||
    stringValue(preview.versionRef) !== version.versionRef ||
    stringValue(preview.contentHash) !== version.contentHash ||
    stringValue(preview.draftBodyHash) !== version.draftBodyHash ||
    preview.oneShot !== true ||
    preview.bodyPersisted !== false ||
    !body ||
    body.length > MAX_PROTECTED_PREVIEW_LENGTH ||
    !stringValue(preview.consumedAt)
  ) {
    return null;
  }
  return {
    kind: "preview",
    versionId: version.versionId,
    version: version.version,
    body,
    consumedAt: stringValue(preview.consumedAt)
  };
}

function parseProtectedDiff(
  value: unknown,
  from: CourseArtifactVersion,
  to: CourseArtifactVersion
): Extract<ProtectedArtifactView, { kind: "diff" }> | null {
  if (!isRecord(value) || !isRecord(value.diff)) return null;
  const diff = value.diff;
  if (
    diff.schemaVersion !== "cmooc.workbench.protected-artifact-diff.v1" ||
    diff.format !== "single_span_text_diff_v1" ||
    stringValue(diff.fromVersionRef) !== from.versionRef ||
    stringValue(diff.toVersionRef) !== to.versionRef ||
    diff.oneShot !== true ||
    diff.bodyPersisted !== false ||
    !Array.isArray(diff.operations) ||
    !stringValue(diff.consumedAt)
  ) {
    return null;
  }
  const operations: Array<{ kind: "equal" | "remove" | "add"; text: string }> = [];
  let totalLength = 0;
  for (const item of diff.operations) {
    if (!isRecord(item)) return null;
    const kind = item.kind;
    const text = stringValue(item.text);
    if (kind !== "equal" && kind !== "remove" && kind !== "add") return null;
    totalLength += text.length;
    if (totalLength > MAX_PROTECTED_PREVIEW_LENGTH * 2) return null;
    operations.push({ kind, text });
  }
  return {
    kind: "diff",
    fromVersionId: from.versionId,
    fromVersion: from.version,
    toVersionId: to.versionId,
    toVersion: to.version,
    operations,
    consumedAt: stringValue(diff.consumedAt)
  };
}

function parseProtectedCorrection(
  value: unknown,
  prior: CourseArtifactVersion
): ProtectedArtifactCorrection | null {
  if (!isRecord(value) || !isRecord(value.correction) || !isRecord(value.diff)) {
    return null;
  }
  const correction = value.correction;
  const verification = correction.verification;
  const preview = correction.preview;
  const diff = value.diff;
  if (!isRecord(verification) || !isRecord(preview)) return null;

  const versionId = stringValue(correction.versionId);
  const versionRef = stringValue(correction.versionRef);
  const artifactId = stringValue(correction.artifactId);
  const version = numberValue(correction.version, NaN);
  const contentHash = stringValue(correction.contentHash);
  const draftBodyHash = stringValue(correction.draftBodyHash);
  const safeSummary = stringValue(correction.safeSummary);
  const verificationRef = stringValue(verification.ref);
  const previewExpiresAt = stringValue(preview.expiresAt);
  if (
    !SAFE_ARTIFACT_ID.test(versionId) ||
    versionRef !== `artifact-version:${versionId}` ||
    artifactId !== prior.artifactId ||
    !Number.isSafeInteger(version) ||
    version !== prior.version + 1 ||
    !SHA256.test(contentHash) ||
    !SHA256.test(draftBodyHash) ||
    !safeSummary ||
    safeSummary.length > 500 ||
    correction.bodyPersisted !== false ||
    verification.status !== "passed" ||
    !SAFE_ARTIFACT_ID.test(verificationRef) ||
    preview.status !== "available" ||
    !previewExpiresAt ||
    typeof diff.changed !== "boolean" ||
    (diff.operations !== undefined && !Array.isArray(diff.operations))
  ) {
    return null;
  }

  const operations: ProtectedArtifactCorrection["operations"] = [];
  let totalLength = 0;
  for (const item of Array.isArray(diff.operations) ? diff.operations : []) {
    if (!isRecord(item)) return null;
    const kind = item.kind;
    const text = stringValue(item.text);
    if (kind !== "equal" && kind !== "remove" && kind !== "add") return null;
    totalLength += text.length;
    if (totalLength > MAX_PROTECTED_PREVIEW_LENGTH * 2) return null;
    operations.push({ kind, text });
  }
  return {
    versionId,
    versionRef,
    artifactId,
    version,
    contentHash,
    draftBodyHash,
    safeSummary,
    verificationRef,
    previewExpiresAt,
    changed: diff.changed,
    operations
  };
}

function CourseArtifactWorkspace({ snapshot }: { snapshot: WorkbenchRunSnapshot }) {
  const [workspace, setWorkspace] = useState<CourseArtifactWorkspaceProjection | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [protectedView, setProtectedView] = useState<ProtectedArtifactView | null>(null);
  const [protectedEditBody, setProtectedEditBody] = useState<string | null>(null);
  const [protectedError, setProtectedError] = useState("");
  const [correctionStatus, setCorrectionStatus] = useState("");
  const [protectedLoading, setProtectedLoading] = useState("");
  const [consumedVersionIds, setConsumedVersionIds] = useState<ReadonlySet<string>>(() => new Set());
  const workspaceAbortRef = useRef<AbortController | null>(null);
  const protectedAbortRef = useRef<AbortController | null>(null);
  const correctionAbortRef = useRef<AbortController | null>(null);
  const protectedViewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const latestFileArtifact = snapshot.artifacts[snapshot.artifacts.length - 1];
  const latestCourseArtifact = workspace?.versions[0];
  const summaryTitle = latestCourseArtifact
    ? `${courseArtifactKindLabel(latestCourseArtifact.artifactKind)} · v${latestCourseArtifact.version}`
    : latestFileArtifact
      ? publicTaskDisplayTitle(latestFileArtifact.label)
      : "等待首项成果";
  const summaryStatus = latestCourseArtifact
    ? `${COURSE_ARTIFACT_VERIFICATION_LABELS[latestCourseArtifact.verification.status]} · ${courseArtifactRecoveryLabel(latestCourseArtifact)}`
    : latestFileArtifact?.status === "ready"
      ? "安全元数据就绪 · 独立验证未回流"
      : "课程成果按需读取 · 正文默认隐藏";

  const clearProtectedView = (restoreFocus = false) => {
    protectedAbortRef.current?.abort();
    protectedAbortRef.current = null;
    correctionAbortRef.current?.abort();
    correctionAbortRef.current = null;
    setProtectedView(null);
    setProtectedEditBody(null);
    setProtectedError("");
    setCorrectionStatus("");
    setProtectedLoading("");
    if (restoreFocus) {
      window.requestAnimationFrame(() => protectedViewTriggerRef.current?.focus());
    }
  };

  useEffect(() => {
    return () => {
      workspaceAbortRef.current?.abort();
      protectedAbortRef.current?.abort();
      correctionAbortRef.current?.abort();
    };
  }, []);

  const loadWorkspace = async (force = false) => {
    if (!force && (workspace || loadState === "loading")) return;
    workspaceAbortRef.current?.abort();
    const controller = new AbortController();
    workspaceAbortRef.current = controller;
    setLoadState("loading");
    setProtectedError("");
    try {
      const response = await fetch(
        `/api/workbench/runs/${encodeURIComponent(snapshot.id)}/artifacts`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal
        }
      );
      const payload = await readResponseBody(response);
      if (!response.ok) throw new Error("课程成果安全投影暂时不可用。");
      const next = normalizeCourseArtifactWorkspace(payload, snapshot.id);
      if (!next) throw new Error("课程成果安全投影无法核验。");
      setWorkspace(next);
      setLoadState("ready");
    } catch (cause) {
      if (controller.signal.aborted) return;
      setLoadState("error");
      setProtectedError(cause instanceof Error ? cause.message : "课程成果安全投影暂时不可用。");
    } finally {
      if (workspaceAbortRef.current === controller) workspaceAbortRef.current = null;
    }
  };

  const consumePreview = async (
    version: CourseArtifactVersion,
    trigger: HTMLButtonElement
  ) => {
    if (
      protectedLoading ||
      consumedVersionIds.has(version.versionId) ||
      version.preview.status !== "available" ||
      version.draftBodyHash === null
    ) {
      return;
    }
    protectedViewTriggerRef.current = trigger;
    clearProtectedView(false);
    const controller = new AbortController();
    protectedAbortRef.current = controller;
    setProtectedLoading(`preview:${version.versionId}`);
    try {
      const previewRequestBody = JSON.stringify({
        expectedContentHash: version.contentHash,
        expectedDraftBodyHash: version.draftBodyHash
      });
      const response = await fetch(
        `/api/workbench/runs/${encodeURIComponent(snapshot.id)}/artifacts/${encodeURIComponent(version.versionId)}/preview`,
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          cache: "no-store",
          signal: controller.signal,
          body: previewRequestBody
        }
      );
      const payload = await readResponseBody(response);
      if (!response.ok) {
        setConsumedVersionIds((previous) => new Set([...previous, version.versionId]));
        throw new Error("一次性正文已不可用；请重新进入任务或再生成并复核。");
      }
      const next = parseProtectedPreview(payload, version);
      if (!next) throw new Error("一次性正文响应无法核验，未展示内容。");
      setConsumedVersionIds((previous) => new Set([...previous, version.versionId]));
      setProtectedView(next);
      setProtectedEditBody(
        version.artifactKind === "facilitation_reply_draft" &&
          version.verification.status === "passed"
          ? next.body
          : null
      );
      setCorrectionStatus("");
    } catch (cause) {
      if (!controller.signal.aborted) {
        setProtectedError(cause instanceof Error ? cause.message : "一次性正文预览失败。");
      }
    } finally {
      if (protectedAbortRef.current === controller) {
        protectedAbortRef.current = null;
        setProtectedLoading("");
      }
    }
  };

  const submitProtectedCorrection = async (
    event: FormEvent<HTMLFormElement>,
    version: CourseArtifactVersion
  ) => {
    event.preventDefault();
    if (
      protectedEditBody === null ||
      protectedLoading ||
      protectedView?.kind !== "preview" ||
      protectedView.versionId !== version.versionId
    ) {
      return;
    }
    const codePointLength = [...protectedEditBody].length;
    if (!protectedEditBody.trim()) {
      setProtectedError("修订正文不能为空。");
      return;
    }
    if (codePointLength > MAX_PROTECTED_DRAFT_EDIT_LENGTH) {
      setProtectedError(`修订正文不能超过 ${MAX_PROTECTED_DRAFT_EDIT_LENGTH} 个字符。`);
      return;
    }
    if (protectedEditBody === protectedView.body) {
      setProtectedError("正文尚未修改，无需生成新版本。");
      return;
    }
    if (version.draftBodyHash === null) {
      setProtectedError("当前版本缺少草稿正文绑定，不能修订。");
      return;
    }

    correctionAbortRef.current?.abort();
    const controller = new AbortController();
    correctionAbortRef.current = controller;
    setProtectedLoading(`correction:${version.versionId}`);
    setProtectedError("");
    setCorrectionStatus("");
    try {
      const correctionRequestBody = JSON.stringify({
        expectedContentHash: version.contentHash,
        expectedDraftBodyHash: version.draftBodyHash,
        correctedBody: protectedEditBody
      });
      const response = await fetch(
        `/api/workbench/runs/${encodeURIComponent(snapshot.id)}/artifacts/${encodeURIComponent(version.versionId)}/corrections`,
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          cache: "no-store",
          signal: controller.signal,
          body: correctionRequestBody
        }
      );
      const payload = await readResponseBody(response);
      if (!response.ok) throw new Error("草稿修订未能生成新版本，请重试。");
      const correction = parseProtectedCorrection(payload, version);
      if (!correction) throw new Error("草稿修订响应无法核验，未采用新版本。");

      setProtectedEditBody(null);
      setCorrectionStatus(`已生成不可变 v${correction.version}，并重新验证通过。`);
      setProtectedView({
        kind: "diff",
        fromVersionId: version.versionId,
        fromVersion: version.version,
        toVersionId: correction.versionId,
        toVersion: correction.version,
        operations: correction.operations,
        consumedAt: new Date().toISOString()
      });
      void loadWorkspace(true);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setProtectedError(cause instanceof Error ? cause.message : "草稿修订失败。");
      }
    } finally {
      if (correctionAbortRef.current === controller) {
        correctionAbortRef.current = null;
        setProtectedLoading("");
      }
    }
  };

  const availableDiffPair = useMemo(() => {
    const versions = workspace?.versions ?? [];
    for (let index = 0; index < versions.length; index += 1) {
      const newer = versions[index]!;
      if (
        newer.preview.status !== "available" ||
        newer.expired ||
        consumedVersionIds.has(newer.versionId)
      ) continue;
      const older = versions.slice(index + 1).find((candidate) =>
        candidate.artifactId === newer.artifactId &&
        candidate.preview.status === "available" &&
        !candidate.expired &&
        !consumedVersionIds.has(candidate.versionId)
      );
      if (older) return { from: older, to: newer };
    }
    return null;
  }, [consumedVersionIds, workspace?.versions]);

  const consumeDiff = async (
    pair: { from: CourseArtifactVersion; to: CourseArtifactVersion },
    trigger: HTMLButtonElement
  ) => {
    if (protectedLoading) return;
    protectedViewTriggerRef.current = trigger;
    clearProtectedView(false);
    const controller = new AbortController();
    protectedAbortRef.current = controller;
    setProtectedLoading(`diff:${pair.from.versionId}:${pair.to.versionId}`);
    try {
      const diffRequestBody = JSON.stringify({
        fromVersionId: pair.from.versionId,
        toVersionId: pair.to.versionId,
        expectedFromContentHash: pair.from.contentHash,
        expectedToContentHash: pair.to.contentHash
      });
      const response = await fetch(
        `/api/workbench/runs/${encodeURIComponent(snapshot.id)}/artifacts/diff`,
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          cache: "no-store",
          signal: controller.signal,
          body: diffRequestBody
        }
      );
      const payload = await readResponseBody(response);
      if (!response.ok) {
        setConsumedVersionIds((previous) =>
          new Set([...previous, pair.from.versionId, pair.to.versionId])
        );
        throw new Error("一次性版本对比已不可用；请重新生成两个版本后再比较。");
      }
      const next = parseProtectedDiff(payload, pair.from, pair.to);
      if (!next) throw new Error("一次性版本对比响应无法核验，未展示内容。");
      setConsumedVersionIds((previous) =>
        new Set([...previous, pair.from.versionId, pair.to.versionId])
      );
      setProtectedView(next);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setProtectedError(cause instanceof Error ? cause.message : "一次性版本对比失败。");
      }
    } finally {
      if (protectedAbortRef.current === controller) {
        protectedAbortRef.current = null;
        setProtectedLoading("");
      }
    }
  };

  const protectedPreviewVersion =
    protectedView?.kind === "preview"
      ? workspace?.versions.find((version) => version.versionId === protectedView.versionId) ?? null
      : null;

  return (
    <details
      className={styles.spineArtifactDisclosure}
      onToggle={(event) => {
        if (event.currentTarget.open) void loadWorkspace();
        else clearProtectedView(false);
      }}
    >
      <summary>
        <span className={styles.spineArtifactIcon} aria-hidden="true"><FileText size={17} /></span>
        <span className={styles.spineArtifactCopy}>
          <span>最新成果与验证</span>
          <strong>{summaryTitle}</strong>
          <small>{summaryStatus}</small>
        </span>
        <CaretDown className={styles.spineDisclosureCaret} size={16} aria-hidden="true" />
      </summary>
      <div className={styles.artifactWorkspacePanel} aria-label="成果与验证工作区（仅安全元数据）">
        <header>
          <div>
            <strong>课程成果版本</strong>
            <small>默认只显示安全元数据；正文不进入对话、工具日志或持久成果空间</small>
          </div>
          <button
            type="button"
            className={styles.artifactRefreshButton}
            disabled={loadState === "loading"}
            onClick={() => void loadWorkspace(true)}
          >
            {loadState === "loading" ? "读取中" : "刷新"}
          </button>
        </header>

        <div className={styles.artifactWorkspaceStatus} role="status" aria-live="polite">
          {loadState === "idle" ? "展开后读取当前运行的安全成果投影。" : null}
          {loadState === "loading" ? "正在读取课程成果安全投影……" : null}
          {loadState === "ready" ? `已读取 ${workspace?.versions.length ?? 0} 个课程成果版本；正文仍隐藏。` : null}
          {loadState === "error" ? "课程成果安全投影读取失败，可重试。" : null}
        </div>

        {workspace?.versions.length ? (
          <ul className={styles.courseArtifactVersionList} aria-label="课程成果版本">
            {workspace.versions.map((version) => {
              const consumed = consumedVersionIds.has(version.versionId);
              const previewAvailable =
                version.preview.status === "available" &&
                version.draftBodyHash !== null &&
                !version.expired &&
                !consumed;
              const previewBusy = protectedLoading === `preview:${version.versionId}`;
              return (
                <li key={version.versionId} data-verification={version.verification.status}>
                  <div className={styles.courseArtifactVersionHeader}>
                    <span>{courseArtifactKindLabel(version.artifactKind)}</span>
                    <strong>v{version.version}</strong>
                    <time dateTime={version.createdAt}>{formatWorkspaceDate(version.createdAt)}</time>
                  </div>
                  <p>{publicTaskDisplayTitle(version.safeSummary)}</p>
                  <dl>
                    <div>
                      <dt>验证</dt>
                      <dd>{COURSE_ARTIFACT_VERIFICATION_LABELS[version.verification.status]}</dd>
                    </div>
                    <div>
                      <dt>恢复</dt>
                      <dd>{courseArtifactRecoveryLabel(version)}</dd>
                    </div>
                  </dl>
                  <div className={styles.courseArtifactActions}>
                    <button
                      type="button"
                      disabled={!previewAvailable || Boolean(protectedLoading)}
                      aria-describedby={`artifact-preview-boundary-${version.versionId}`}
                      onClick={(event) => void consumePreview(version, event.currentTarget)}
                    >
                      {previewBusy
                        ? "读取中……"
                        : consumed
                          ? "一次性读取已用"
                          : previewAvailable
                            ? "一次性预览正文"
                            : "需要再生成"}
                    </button>
                    <small id={`artifact-preview-boundary-${version.versionId}`}>
                      {previewAvailable
                        ? "点击会消耗本版本的进程内预览绑定"
                        : "正文未持久化，不能假装恢复"}
                    </small>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : loadState === "ready" ? (
          <p className={styles.spineArtifactEmpty}>当前运行还没有课程成果版本。</p>
        ) : null}

        {availableDiffPair ? (
          <div className={styles.artifactDiffEntry}>
            <div>
              <strong>受限版本对比</strong>
              <small>对比会同时消耗两个版本的一次性绑定，之后不能再预览这两版。</small>
            </div>
            <button
              type="button"
              disabled={Boolean(protectedLoading)}
              onClick={(event) => void consumeDiff(availableDiffPair, event.currentTarget)}
            >
              {protectedLoading.startsWith("diff:")
                ? "比较中……"
                : `一次性比较 v${availableDiffPair.from.version} → v${availableDiffPair.to.version}`}
            </button>
          </div>
        ) : null}

        {protectedError ? (
          <p className={styles.protectedArtifactError} role="alert">{protectedError}</p>
        ) : null}
        {correctionStatus ? (
          <p className={styles.protectedArtifactStatus} role="status">{correctionStatus}</p>
        ) : null}

        {protectedView ? (
          <section className={styles.protectedArtifactView} aria-label="一次性受保护成果视图">
            <header>
              <div>
                <strong>
                  {protectedView.kind === "preview"
                    ? `正文预览 · v${protectedView.version}`
                    : `版本对比 · v${protectedView.fromVersion} → v${protectedView.toVersion}`}
                </strong>
                <small>仅存在于当前页面内存；关闭后立即从 DOM 移除</small>
              </div>
              <button type="button" onClick={() => clearProtectedView(true)}>关闭</button>
            </header>
            {protectedView.kind === "preview" ? (
              protectedPreviewVersion?.artifactKind === "facilitation_reply_draft" &&
              protectedPreviewVersion.verification.status === "passed" &&
              protectedEditBody !== null ? (
                <form
                  className={styles.protectedArtifactEditor}
                  onSubmit={(event) => void submitProtectedCorrection(event, protectedPreviewVersion)}
                >
                  <label htmlFor={`protected-artifact-editor-${protectedPreviewVersion.versionId}`}>
                    受保护草稿正文
                  </label>
                  <textarea
                    id={`protected-artifact-editor-${protectedPreviewVersion.versionId}`}
                    value={protectedEditBody}
                    maxLength={MAX_PROTECTED_DRAFT_EDIT_LENGTH}
                    onChange={(event) => {
                      setProtectedEditBody(event.currentTarget.value);
                      setProtectedError("");
                    }}
                    spellCheck="true"
                  />
                  <div className={styles.protectedArtifactEditorFooter}>
                    <small>
                      正文只保留在当前页面与短期受保护编辑会话 · {[...protectedEditBody].length}/
                      {MAX_PROTECTED_DRAFT_EDIT_LENGTH}
                    </small>
                    <button
                      type="submit"
                      disabled={
                        protectedLoading.startsWith("correction:") ||
                        !protectedEditBody.trim() ||
                        protectedEditBody === protectedView.body
                      }
                    >
                      {protectedLoading.startsWith("correction:")
                        ? "正在验证……"
                        : "修订并重新验证"}
                    </button>
                  </div>
                </form>
              ) : (
                <pre>{protectedView.body}</pre>
              )
            ) : (
              <pre className={styles.protectedArtifactDiff}>
                {protectedView.operations.map((operation, index) =>
                  operation.kind === "remove" ? (
                    <del key={`${operation.kind}-${index}`}>{operation.text}</del>
                  ) : operation.kind === "add" ? (
                    <ins key={`${operation.kind}-${index}`}>{operation.text}</ins>
                  ) : (
                    <span key={`${operation.kind}-${index}`}>{operation.text}</span>
                  )
                )}
              </pre>
            )}
          </section>
        ) : null}

        <details className={styles.fileArtifactDisclosure}>
          <summary>Codex 文件变化 · {snapshot.artifacts.length} 项</summary>
          <div>
            <p>这是本机运行文件元数据，与课程成果版本分开；不预览正文，尚未收到独立验证回执。</p>
            {snapshot.artifacts.length ? (
              <ul className={styles.spineArtifactList}>
                {[...snapshot.artifacts].reverse().map((artifact) => (
                  <li key={artifact.id} data-status={artifact.status}>
                    <FileText size={15} aria-hidden="true" />
                    <span>
                      <strong>{publicTaskDisplayTitle(artifact.label)}</strong>
                      <code>{artifact.relativePath}</code>
                    </span>
                    <small>{artifact.status === "ready" ? ARTIFACT_KIND_LABELS[artifact.kind] : "记录失败"}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.spineArtifactEmpty}>当前运行没有文件变化。</p>
            )}
          </div>
        </details>

        <dl className={styles.spineVerificationFacts}>
          <div>
            <dt>持久边界</dt>
            <dd>只保存安全元数据、hash、验证与恢复状态</dd>
          </div>
          <div>
            <dt>正文恢复</dt>
            <dd>进程丢失或过期后必须重新进入或再生成</dd>
          </div>
          <div>
            <dt>外部动作</dt>
            <dd>{snapshot.safety.externalWritesLocked ? "真实发布关闭" : "状态不可验证"}</dd>
          </div>
        </dl>
      </div>
    </details>
  );
}

function AdaptiveRunSpine({
  activity,
  snapshot
}: {
  activity: WorkbenchActivityProjection;
  snapshot: WorkbenchRunSnapshot;
}) {
  const plan = snapshot.plan;
  const completedPlanSteps = plan?.steps.filter((step) => step.status === "completed").length ?? 0;
  const currentPlanStep = plan?.steps.find((step) => step.status === "inProgress") ??
    plan?.steps.find((step) => step.status === "pending");
  const awaitingAction = snapshot.status === "awaiting_action" && Boolean(snapshot.pendingAction);
  const currentStepLabel = awaitingAction
    ? "等待你决定本次编辑器暂存核验"
    : currentPlanStep
      ? publicTaskDisplayTitle(currentPlanStep.step)
      : publicTaskDisplayTitle(activity.title);
  return (
    <section
      className={styles.adaptiveRunSpine}
      data-state={activity.state}
      data-awaiting-action={awaitingAction}
      aria-label="当前计划、成果与验证"
      aria-live="off"
    >
      <div className={styles.spineCurrentStep}>
        <span className={styles.activityPulse} data-role={activity.role} aria-hidden="true" />
        <div className={styles.spineCurrentCopy}>
          <span>当前步骤</span>
          <strong>{currentStepLabel}</strong>
          <small>{activity.detail}</small>
        </div>
        <div className={styles.spinePlanProgress}>
          <span>
            {plan?.steps.length
              ? `计划 ${completedPlanSteps}/${plan.steps.length}`
              : "计划待建立"}
          </span>
          {plan?.steps.length ? (
            <progress
              value={completedPlanSteps}
              max={plan.steps.length}
              aria-label={`计划进度：${completedPlanSteps}/${plan.steps.length} 完成`}
            />
          ) : null}
        </div>
      </div>

      <span className={styles.activityAnnouncement} aria-hidden="true">最新成果与验证</span>
      <CourseArtifactWorkspace key={snapshot.id} snapshot={snapshot} />
    </section>
  );
}

function PendingActionCard({
  runId,
  action,
  onResolved
}: {
  runId: string;
  action: WorkbenchPendingAction;
  onResolved: (runId: string) => Promise<void>;
}) {
  const [submittingDecision, setSubmittingDecision] = useState<"approve" | "decline" | null>(null);
  const [submittedDecision, setSubmittedDecision] = useState<"approve" | "decline" | null>(null);
  const [decisionError, setDecisionError] = useState("");
  const decisionLocked = submittingDecision !== null || submittedDecision !== null;

  const submitDecision = async (decision: "approve" | "decline") => {
    if (decisionLocked) return;
    setDecisionError("");
    setSubmittingDecision(decision);

    let response: Response;
    try {
      response = await fetch(
        `/api/workbench/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(action.actionRef)}/decision`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            decision,
            expectedActionHash: action.approvalHash
          })
        }
      );
    } catch {
      setSubmittingDecision(null);
      setDecisionError(pendingActionDecisionError());
      return;
    }

    if (!response.ok) {
      setSubmittingDecision(null);
      setDecisionError(pendingActionDecisionError(response.status));
      return;
    }

    setSubmittingDecision(null);
    setSubmittedDecision(decision);
    try {
      await onResolved(runId);
    } catch {
      setDecisionError(
        "决定已提交，但最新状态尚未回流；当前不会重复提交。请等待实时连接。"
      );
    }
  };

  const decisionStatus = submittingDecision
    ? submittingDecision === "approve"
      ? "正在提交本次授权…"
      : "正在提交拒绝决定…"
    : submittedDecision === "approve"
      ? "本次授权已提交，等待执行与核验回流。"
      : submittedDecision === "decline"
        ? "拒绝决定已提交，系统不会执行该动作。"
        : "等待你的决定。";

  return (
    <article
      className={styles.pendingActionCard}
      data-pending-action-card="true"
      aria-labelledby="pending-action-heading"
      aria-describedby="pending-action-summary pending-action-status"
      aria-busy={submittingDecision !== null}
    >
      <header className={styles.pendingActionHeader}>
        <span className={styles.pendingActionIcon} aria-hidden="true">
          <LockKey size={18} />
        </span>
        <div>
          <span>等待本次授权</span>
          <h3 id="pending-action-heading">确认一次可恢复的编辑器核验</h3>
        </div>
        <time dateTime={action.expiresAt}>有效至 {formatActionExpiry(action.expiresAt)}</time>
      </header>

      <p id="pending-action-summary" className={styles.pendingActionSummary}>
        {publicTaskDisplayTitle(action.safeSummary)}
      </p>

      <div className={styles.pendingActionBoundary} aria-label="本次固定动作边界">
        <span>编辑器写入 <strong>{action.operationBoundary.editorWriteCount}</strong></span>
        <span>回读 <strong>{action.operationBoundary.editorReadbackCount}</strong></span>
        <span>清空 <strong>{action.operationBoundary.editorClearCount}</strong></span>
        <span data-zero="true">发布 <strong>{action.operationBoundary.publishCount}</strong></span>
        <span data-zero="true">通知 <strong>{action.operationBoundary.notificationCount}</strong></span>
      </div>

      <p className={styles.pendingActionGuardrail}>
        仅限本次暂存、逐字回读和清空；不会发布，也不会通知任何人。
      </p>

      <details className={styles.pendingActionDetails}>
        <summary>
          <span>技术绑定详情</span>
          <CaretDown className={styles.pendingActionDetailsCaret} size={14} aria-hidden="true" />
        </summary>
        <dl>
          <div><dt>actionRef</dt><dd><code>{action.actionRef}</code></dd></div>
          <div><dt>approvalHash</dt><dd><code>{action.approvalHash}</code></dd></div>
          <div><dt>bindingHash</dt><dd><code>{action.bindingHash}</code></dd></div>
        </dl>
      </details>

      <footer className={styles.pendingActionFooter}>
        <div className={styles.pendingActionButtons}>
          <button
            type="button"
            className={styles.pendingActionApprove}
            disabled={decisionLocked}
            onClick={() => void submitDecision("approve")}
          >
            {submittingDecision === "approve" ? "授权中…" : "授权本次暂存核验"}
          </button>
          <button
            type="button"
            className={styles.pendingActionDecline}
            disabled={decisionLocked}
            onClick={() => void submitDecision("decline")}
          >
            {submittingDecision === "decline" ? "处理中…" : "拒绝本次操作"}
          </button>
        </div>
        <p
          id="pending-action-status"
          className={styles.pendingActionStatus}
          data-error={Boolean(decisionError)}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {decisionError || decisionStatus}
        </p>
      </footer>
    </article>
  );
}

function FinalAnswer({ snapshot }: { snapshot: WorkbenchRunSnapshot }) {
  const finalResult = snapshot.finalResult;
  if (!finalResult) return null;
  const answer = formatWorkbenchAnswer(publicTaskDisplayTitle(finalResult.summary));
  const completed = finalResult.status === "completed";
  return (
    <article
      className={styles.finalAnswer}
      data-final-answer="true"
      data-status={finalResult.status}
      aria-labelledby="final-answer-heading"
    >
      <header>
        <div className={styles.messageByline}>
          <span className={styles.roleMark} data-role={completed ? "sol" : "system"} aria-hidden="true" />
          <strong>{completed ? "主任务智能体" : "系统"}</strong>
          <time dateTime={finalResult.completedAt}>{formatTime(finalResult.completedAt).slice(0, 5)}</time>
          <span className={styles.answerStatus}>{STATUS_LABELS[finalResult.status]}</span>
        </div>
        <h3 id="final-answer-heading">
          {completed ? "完整答复" : finalResult.status === "stopped" ? "任务已停止" : "任务未完成"}
        </h3>
      </header>
      <div className={styles.answerBody}>
        {answer.map((block, index) =>
          block.type === "heading" ? (
            <h4 key={`${block.type}-${index}`}>{block.text}</h4>
          ) : block.type === "list" ? (
            <ul key={`${block.type}-${index}`}>
              {block.items.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : block.type === "code" ? (
            <pre key={`${block.type}-${index}`} data-language={block.language}>
              <code>{block.text}</code>
            </pre>
          ) : (
            <p key={`${block.type}-${index}`}>{block.text}</p>
          )
        )}
      </div>
      {finalResult.citations?.length ? (
        <aside className={styles.answerSources} aria-label={`来源 ${finalResult.citations.length} 条`}>
          <h4>来源</h4>
          <ol>
            {finalResult.citations.map((citation, index) => (
              <li key={citation.url}>
                <span>{index + 1}</span>
                <a href={citation.url} target="_blank" rel="noreferrer">
                  <strong>{citation.title}</strong>
                  <small>{citation.source}</small>
                </a>
              </li>
            ))}
          </ol>
        </aside>
      ) : null}
      <footer>
        <span><Check size={14} aria-hidden="true" />安全边界已核验 · 课程平台写入 0</span>
      </footer>
    </article>
  );
}

function FailureRecovery({
  snapshot,
  isRestarting,
  onRestart
}: {
  snapshot: WorkbenchRunSnapshot;
  isRestarting: boolean;
  onRestart: () => void;
}) {
  if (snapshot.status !== "failed" || !snapshot.capabilities.canRestart) return null;
  return (
    <section className={styles.failureRecovery} data-recovery-action="true" aria-label="恢复失败任务">
      <div>
        <strong>恢复任务</strong>
        <span>创建新的执行尝试，不重放旧线程；保留当前上下文、历史与坚果云交接。</span>
      </div>
      <button
        type="button"
        className={styles.recoveryButton}
        onClick={onRestart}
        disabled={isRestarting}
      >
        {isRestarting ? "正在恢复…" : "恢复任务"}
        <ArrowRight size={15} aria-hidden="true" />
      </button>
    </section>
  );
}

function CompletedContinuation({
  snapshot,
  isContinuing,
  onContinue
}: {
  snapshot: WorkbenchRunSnapshot;
  isContinuing: boolean;
  onContinue: () => void;
}) {
  if (
    snapshot.status !== "completed" ||
    snapshot.capabilities.canSteer ||
    !snapshot.capabilities.canContinue
  ) {
    return null;
  }
  return (
    <section
      className={styles.resultContinuation}
      data-continuation-action="true"
      aria-label="已完成任务继续"
    >
      <div>
        <strong>在同一任务中继续</strong>
        <span>创建下一轮并重新核验当前状态；历史与成果仍归入当前任务。</span>
      </div>
      <button
        type="button"
        className={styles.continuationButton}
        onClick={onContinue}
        disabled={isContinuing}
      >
        {isContinuing ? "正在承接…" : "继续"}
        <ArrowRight size={15} aria-hidden="true" />
      </button>
    </section>
  );
}

function PlanGoalPanel({
  snapshot,
  isExecuting,
  onExecutePlan,
  compact = false
}: {
  snapshot: WorkbenchRunSnapshot;
  isExecuting: boolean;
  onExecutePlan: () => void;
  compact?: boolean;
}) {
  const plan = snapshot.plan;
  if (!plan && !snapshot.goalMode && snapshot.collaborationMode !== "plan") return null;
  const completed = plan?.steps.filter((step) => step.status === "completed").length ?? 0;
  const canExecutePlan =
    snapshot.collaborationMode === "plan" &&
    snapshot.status === "completed" &&
    Boolean(plan?.steps.length);
  const goalLabel = snapshot.goal
    ? {
        active: "进行中",
        paused: "已暂停",
        blocked: "受阻",
        usageLimited: "用量受限",
        budgetLimited: "预算受限",
        complete: "已完成"
      }[snapshot.goal.status]
    : snapshot.status === "queued" ||
        snapshot.status === "starting" ||
        snapshot.status === "running" ||
        snapshot.status === "awaiting_action"
      ? "正在建立"
      : snapshot.status === "stopped"
        ? "已停止"
        : "未建立";

  return (
    <section
      className={styles.planGoalPanel}
      aria-label="计划与持续目标"
      data-plan-outcome="true"
      data-compact={compact}
    >
      <header>
        <span><Brain size={15} aria-hidden="true" />{compact ? "可执行计划" : snapshot.collaborationMode === "plan" ? "计划模式" : "执行计划"}</span>
        {plan ? <small>{completed}/{plan.steps.length} 完成</small> : <small>等待计划</small>}
      </header>
      {!compact && plan?.explanation ? <p>{publicTaskDisplayTitle(plan.explanation)}</p> : null}
      {plan?.steps.length ? (
        <ol>
          {plan.steps.map((step, index) => (
            <li
              key={`${step.status}-${index}`}
              data-status={step.status}
              aria-label={`${planStepStatusLabel(step.status)}：${publicTaskDisplayTitle(step.step)}`}
            >
              <span aria-hidden="true">{step.status === "completed" ? "✓" : step.status === "inProgress" ? "→" : "·"}</span>
              <span>
                {publicTaskDisplayTitle(step.step)}
                <small className={styles.planStepStatus}>{planStepStatusLabel(step.status)}</small>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {snapshot.goalMode ? (
        <footer>
          <span>持续目标 · {goalLabel}</span>
          <small>{snapshot.goal ? "资源使用受控" : "工作台历史不保存目标原文"}</small>
        </footer>
      ) : null}
      {canExecutePlan ? (
        <div className={styles.planExecutionAction}>
          <span>计划已就绪；执行会开启新的本机任务。</span>
          <button
            type="button"
            className={styles.planExecuteButton}
            onClick={onExecutePlan}
            disabled={isExecuting}
          >
            {isExecuting ? "正在启动…" : "按计划执行"}
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </section>
  );
}

function TeamCard({ snapshot }: { snapshot: WorkbenchRunSnapshot | null }) {
  const fallbackAgents: WorkbenchAgent[] = [
    {
      key: "sol",
      label: "主任务智能体",
      role: "sol",
      status: snapshot && !isTerminalWorkbenchStatus(snapshot.status) ? "running" : "idle",
      taskSummary: "组织与验收课程任务",
      lastActivityAt: snapshot?.updatedAt ?? new Date().toISOString()
    },
    {
      key: "luna-observed",
      label: "协作智能体",
      role: "luna",
      status: "idle",
      taskSummary: "等待观察与证据分工",
      lastActivityAt: snapshot?.updatedAt ?? new Date().toISOString()
    }
  ];
  const agents = snapshot?.agents.length ? snapshot.agents : fallbackAgents;
  const visibleAgents = agents.filter((agent) => agent.role === "sol" || agent.role === "luna");
  const displayAgents = visibleAgents.length ? visibleAgents : fallbackAgents;

  return (
    <GlassCard className={styles.sideCard}>
      <div className={styles.sideHeading}>
        <div>
          <p className={styles.sideEyebrow}>COMPUTE</p>
          <h2>执行角色</h2>
        </div>
        <span className={styles.sideCount}>{displayAgents.length}</span>
      </div>
      <div className={styles.teamList}>
        {displayAgents.map((agent) => (
          <div className={styles.teamRow} key={agent.key}>
            <div className={`${styles.avatar} ${agent.role === "sol" ? styles.avatarSol : styles.avatarLuna}`}>
              <span aria-hidden="true">{agent.role === "sol" ? "主" : "协"}</span>
            </div>
            <div className={styles.teamDetails}>
              <div className={styles.teamNameLine}>
                <strong>{publicTaskDisplayTitle(agent.label)}</strong>
                <span className={`${styles.agentDot} ${styles[`agentDot${agent.status}`]}`} aria-hidden="true" />
              </div>
              <p>{agent.taskSummary || (agent.role === "luna" ? "观察与证据" : "规划与验收")}</p>
              <span className={styles.teamStatus}>{agentStatusLabel(agent.status)}</span>
            </div>
            <Icon name="chevron" size={17} />
          </div>
        ))}
      </div>
    </GlassCard>
  );
}

function ToolsCard({ snapshot }: { snapshot: WorkbenchRunSnapshot | null }) {
  const tools = snapshot?.tools ?? [];
  const artifacts = snapshot?.artifacts ?? [];
  const totalCalls = tools.reduce((sum, tool) => sum + tool.callCount, 0);
  return (
    <GlassCard className={styles.sideCard}>
      <div className={styles.sideHeading}>
        <div>
          <p className={styles.sideEyebrow}>OBSERVABILITY</p>
          <h2>工具与产物</h2>
        </div>
        <span className={styles.sideCount}>{totalCalls + artifacts.length}</span>
      </div>
      <div className={styles.toolSummary}>
        <span>工具调用</span>
        <strong>{totalCalls}</strong>
        <span>产物</span>
        <strong>{artifacts.length}</strong>
      </div>
      <div className={styles.toolList}>
        {tools.length ? (
          tools.map((tool) => (
            <div className={styles.toolRow} key={tool.key}>
              <div className={styles.toolIcon} aria-hidden="true">
                <Icon name="tool" size={17} />
              </div>
              <div className={styles.toolDetails}>
                <strong>{tool.label}</strong>
                <span>{tool.callCount} 次调用 · {toolStatusLabel(tool.status)}</span>
              </div>
              <span className={`${styles.toolState} ${styles[`toolState${tool.status}`]}`} aria-label={toolStatusLabel(tool.status)} />
            </div>
          ))
        ) : (
          <p className={styles.sideEmpty}>运行后，工具调用会在这里聚合。</p>
        )}
      </div>
      <div className={styles.artifactList}>
        {artifacts.length ? (
          artifacts.map((artifact) => (
            <div className={styles.artifactRow} key={artifact.id}>
              <Icon name="file" size={17} />
              <div>
                <strong>{artifact.label}</strong>
                <code>{artifact.relativePath}</code>
              </div>
            </div>
          ))
        ) : null}
      </div>
    </GlassCard>
  );
}

function formatWorkspaceDate(value: string | null | undefined): string {
  if (!value) return "尚无运行";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间待同步";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function formatVisibleDecisionReason(reasonCode: string): string {
  const normalized = reasonCode.trim();
  return normalized && DECISION_REASON_CODE.test(normalized)
    ? formatDecisionReason(normalized)
    : normalized || "按当前证据保持克制";
}

function publicTaskDisplayTitle(value: string): string {
  return value
    .replace(/\bLuna\s*#?\s*(\d+)\b/gi, "协作智能体 #$1")
    .replace(/\bLuna\b/gi, "协作智能体")
    .replace(/\bSol\b/gi, "主任务智能体")
    .replace(/Codex/gi, "课程研判")
    .replace(/OpenAI|ChatGPT/gi, "本机执行");
}

function CourseSituationPane({
  operator,
  attachedContextRef,
  onAttach
}: {
  operator: OperatorWorkspaceReadModel;
  attachedContextRef: string;
  onAttach: (opportunity: OperatorOpportunity) => void;
}) {
  const totalDecisions =
    operator.decisions.draft +
    operator.decisions.wait +
    operator.decisions.abstain +
    operator.decisions.yield;
  return (
    <section className={styles.coursePane} aria-labelledby="course-situation-heading">
      <header className={styles.paneHeader}>
        <div>
          <p className={styles.sectionEyebrow}>COURSE SITUATION</p>
          <h2 id="course-situation-heading">课程现场</h2>
        </div>
        <Link className={styles.textLink} href="/autonomy/world">
          打开课程世界
        </Link>
      </header>

      <div className={styles.runSummary}>
        <div>
          <span>最近巡检</span>
          <strong>{operator.invocationStatus === "completed" ? "运行完成" : operator.invocationStatus}</strong>
        </div>
        <div>
          <span>模式</span>
          <strong>只读运行</strong>
        </div>
        <div>
          <span>证据时间</span>
          <strong>{formatWorkspaceDate(operator.scheduledFor)}</strong>
        </div>
        <div>
          <span>覆盖</span>
          <strong>{operator.coverage.status === "complete" ? "完整" : operator.coverage.status === "partial" ? "部分" : "待同步"}</strong>
        </div>
      </div>

      <div className={styles.metricGrid} aria-label="课程世界摘要">
        <div><strong>{operator.metrics.events}</strong><span>事件</span></div>
        <div><strong>{operator.metrics.threads}</strong><span>讨论</span></div>
        <div><strong>{operator.metrics.actors}</strong><span>参与者</span></div>
        <div><strong>{operator.metrics.edges}</strong><span>互动连接</span></div>
      </div>

      <div className={styles.opportunityHeading}>
        <div>
          <span>本轮决定</span>
          <strong>{totalDecisions}</strong>
        </div>
        <p>
          可继续 {operator.decisions.draft} · 等待 {operator.decisions.wait} · 克制 {operator.decisions.abstain} · 让位 {operator.decisions.yield}
        </p>
      </div>

      <div className={styles.opportunityList}>
        {operator.opportunities.length ? (
          operator.opportunities.map((item) => {
            const selected = attachedContextRef === item.contextRef;
            return (
              <article className={styles.opportunityRow} data-state={item.state} key={item.id}>
                <div className={styles.opportunityIndex} aria-hidden="true" />
                <div className={styles.opportunityCopy}>
                  <div className={styles.opportunityTopline}>
                    <span>{item.stateLabel}</span>
                    <time dateTime={item.evidenceAsOf}>{formatWorkspaceDate(item.evidenceAsOf)}</time>
                  </div>
                  <h3>{item.title}</h3>
                  <p>{item.summary}</p>
                  <span className={styles.opportunityReason}>
                    理由：{formatVisibleDecisionReason(item.reasonCode)}
                  </span>
                </div>
                <button
                  type="button"
                  className={selected ? styles.contextButtonSelected : styles.contextButton}
                  onClick={() => onAttach(item)}
                  aria-pressed={selected}
                >
                  {selected ? "已附加" : item.actionLabel}
                </button>
              </article>
            );
          })
        ) : (
          <div className={styles.courseEmpty}>
            <strong>还没有可展示的课程决定</strong>
            <p>下一轮巡检完成后，机会、让位和克制理由会出现在这里。</p>
          </div>
        )}
      </div>

      <div className={styles.agentPoolSummary}>
        <div>
          <span>角色执行身份</span>
          <strong>
            {operator.executionAgents.configurationState === "ready"
              ? `${operator.executionAgents.availableAgentCount} 可用 / ${operator.executionAgents.configuredAgentCount} 已配置`
              : "账号池待配置"}
          </strong>
        </div>
        <div className={styles.roleRoster}>
          {operator.executionAgents.roles
            .filter((role) => role.configuredAgentCount > 0)
            .map((role) => (
              <span key={role.roleKey}>
                {role.roleKey} · {role.availableAgentCount}/{role.configuredAgentCount}
              </span>
            ))}
          <span>今日执行 {operator.executionAgents.consumedLeaseCountToday}</span>
        </div>
      </div>

      <footer className={styles.evidenceFooter}>
        <span>证据记录 {operator.evidence.decisionTapeEntryCount} 条</span>
        <span>候选 {operator.evidence.candidateCount}</span>
        <span>互动覆盖 {operator.evidence.graphCoverageStatus === "complete" ? "完整" : operator.evidence.graphCoverageStatus === "partial" ? "部分" : "待核验"}</span>
        <Link href={operator.invocationId ? `/autonomy/runs/${operator.invocationId}` : "/autonomy/decisions"}>
          查看运行证据
        </Link>
      </footer>
    </section>
  );
}

function TaskHistory({
  items,
  activeRootRunId,
  onOpen
}: {
  items: WorkbenchHistoryItem[];
  activeRootRunId?: string;
  onOpen: (item: WorkbenchHistoryItem) => void;
}) {
  const tasks = groupWorkbenchTaskHistory(items);
  return (
    <section className={styles.historySection} aria-labelledby="history-heading">
      <header className={styles.paneHeader}>
        <div>
          <p className={styles.sectionEyebrow}>RECENT TASKS</p>
          <h2 id="history-heading">近期任务</h2>
        </div>
        <span className={styles.connectionState}>保留最近 {Math.max(tasks.length, 0)} 个任务</span>
      </header>
      {tasks.length ? (
        <div className={styles.historyList}>
          {tasks.map((task) => (
              <button
                type="button"
                className={styles.historyRow}
                data-current={task.rootRunId === activeRootRunId}
                aria-current={task.rootRunId === activeRootRunId ? "true" : undefined}
                onClick={() => onOpen(task.latestRun)}
                key={task.rootRunId}
              >
                <span className={styles.historyStatus} data-status={task.status} />
                <span className={styles.historyMain}>
                  <strong>{publicTaskDisplayTitle(task.title)}</strong>
                  <span>
                    {[task.contextTitle ? "课程任务" : "通用任务", `${task.turnCount} 轮对话`, `${task.eventCount} 项进展`]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className={styles.historyMeta}>
                  <strong>{task.recoveryState === "interrupted" ? "中断 · 可恢复" : STATUS_LABELS[task.status]}</strong>
                  <time dateTime={task.updatedAt}>{formatWorkspaceDate(task.updatedAt)}</time>
                </span>
              </button>
          ))}
        </div>
      ) : (
        <div className={styles.courseEmpty}>
          <strong>还没有课程任务</strong>
          <p>运行任务或演示预览后，安全摘要与事件历史会保存在这里。</p>
        </div>
      )}
    </section>
  );
}

function NetworkTrendPanel({
  operator
}: {
  operator: OperatorWorkspaceReadModel;
}) {
  return (
    <section className={styles.monitorPanel} aria-labelledby="network-trend-heading">
      <header className={styles.monitorPanelHeader}>
        <div>
          <p>NETWORK CHANGE</p>
          <h2 id="network-trend-heading">网络变化</h2>
        </div>
        <Link href="/autonomy/world">查看完整趋势</Link>
      </header>
      <div className={styles.compactTableWrap}>
        <table className={styles.compactTable}>
          <caption className="sr-only">最近课程世界快照的网络计数</caption>
          <thead>
            <tr>
              <th scope="col">时间</th>
              <th scope="col">成员</th>
              <th scope="col">互动边</th>
              <th scope="col">讨论</th>
              <th scope="col">开放缺口</th>
            </tr>
          </thead>
          <tbody>
            {operator.networkTrend.length ? (
              operator.networkTrend.map((row) => (
                <tr key={row.observedAt}>
                  <td><time dateTime={row.observedAt}>{formatWorkspaceDate(row.observedAt)}</time></td>
                  <td>{row.learnerCount}</td>
                  <td>{row.interactionCount}</td>
                  <td>{row.relationCount}</td>
                  <td data-alert={row.openGapCount > 0}>{row.openGapCount}</td>
                </tr>
              ))
            ) : (
              <tr><td colSpan={5}>尚无可比较的课程世界快照</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RoleOperationsPanel({
  operator,
  snapshot
}: {
  operator: OperatorWorkspaceReadModel;
  snapshot: WorkbenchRunSnapshot | null;
}) {
  const roles = operator.executionAgents.roles.filter(
    (role) => role.configuredAgentCount > 0
  );
  const liveAgents = snapshot?.agents.filter(
    (agent) => agent.role === "sol" || agent.role === "luna"
  ) ?? [];
  return (
    <section className={styles.monitorPanel} aria-labelledby="role-operations-heading">
      <header className={styles.monitorPanelHeader}>
        <div>
          <p>OPERATING ROLES</p>
          <h2 id="role-operations-heading">协作角色</h2>
        </div>
        <span>{operator.executionAgents.activeAgentCount} 执行中</span>
      </header>
      <div className={styles.roleOperationsList}>
        {roles.length ? (
          roles.map((role) => (
            <div className={styles.roleOperationRow} key={role.roleKey}>
              <span className={styles.roleGlyph}><UsersThree size={18} /></span>
              <div>
                <strong>{role.roleKey}</strong>
                <small>课程角色执行身份</small>
              </div>
              <span>{role.availableAgentCount}/{role.configuredAgentCount} 可用</span>
            </div>
          ))
        ) : liveAgents.length ? (
          liveAgents.map((agent) => (
            <div className={styles.roleOperationRow} key={agent.key}>
              <span className={styles.roleGlyph}><Brain size={18} /></span>
              <div>
                <strong>{agent.taskSummary || "研判任务"}</strong>
                <small>本机执行角色</small>
              </div>
              <span>{agentStatusLabel(agent.status)}</span>
            </div>
          ))
        ) : (
          <div className={styles.panelEmpty}>账号池待接入，当前保持只读观察。</div>
        )}
      </div>
      <footer className={styles.panelFooter}>
        今日执行 {operator.executionAgents.consumedLeaseCountToday} · 不展示账号身份或凭据
      </footer>
    </section>
  );
}

function VerifiableResultsPanel({
  operator,
  history,
  onOpen
}: {
  operator: OperatorWorkspaceReadModel;
  history: WorkbenchHistoryItem[];
  onOpen: (item: WorkbenchHistoryItem) => void;
}) {
  return (
    <section className={styles.monitorPanel} aria-labelledby="verifiable-results-heading">
      <header className={styles.monitorPanelHeader}>
        <div>
          <p>VERIFIABLE OUTPUT</p>
          <h2 id="verifiable-results-heading">可核验结果</h2>
        </div>
        <Link href={operator.invocationId ? `/autonomy/runs/${operator.invocationId}` : "/autonomy/decisions"}>
          全部证据
        </Link>
      </header>
      <div className={styles.resultLedger}>
        {history.length ? (
          history.slice(0, 5).map((item) => (
            <button key={item.id} type="button" onClick={() => onOpen(item)}>
              <span className={styles.resultStatus} data-status={item.status} />
              <span>
                <strong>{publicTaskDisplayTitle(item.title)}</strong>
                <small>{item.eventCount} 项进展 · {formatWorkspaceDate(item.updatedAt)}</small>
              </span>
              <span>{STATUS_LABELS[item.status]}</span>
            </button>
          ))
        ) : (
          <div className={styles.panelEmpty}>创建研判任务后，安全摘要会出现在这里。</div>
        )}
      </div>
      <footer className={styles.panelFooter}>
        证据记录 {operator.evidence.decisionTapeEntryCount} 条 · 不含论坛正文
      </footer>
    </section>
  );
}

function agentNativeDisplay(value: string | null | undefined, fallback = "待核验") {
  return value?.trim() ? value : fallback;
}

function AgentNativeContextBar({
  viewModel
}: {
  viewModel: AgentNativeWorkbenchViewModel;
}) {
  const { scope } = viewModel;
  return (
    <section
      className={styles.agentNativeContext}
      aria-label="Agent Native 工作上下文"
      data-testid="agent-native-context"
    >
      <div className={styles.agentNativeContextBrand}>
        <span className={styles.agentNativeContextMark} aria-hidden="true">AN</span>
        <div>
          <strong>Agent Native</strong>
          <span>课程运营安全镜</span>
        </div>
      </div>
      <div className={styles.agentNativeContextGrid}>
        <div>
          <span>课程</span>
          <strong>{agentNativeDisplay(scope.courseName, "课程名称待核验")}</strong>
          <small>{scope.courseAlias ? `安全别名 ${scope.courseAlias}` : "安全别名待核验"}</small>
        </div>
        <div>
          <span>快照 / 调用</span>
          <strong>{agentNativeDisplay(scope.snapshotId)} / {agentNativeDisplay(scope.invocationId)}</strong>
          <small>范围 {agentNativeDisplay(scope.timeBoundary)}</small>
        </div>
        <div>
          <span>覆盖 / 新鲜度</span>
          <strong>{scope.coverage} · {scope.freshness}</strong>
          <small>仅按当前安全读模型解释</small>
        </div>
        <div className={styles.agentNativeContextLock}>
          <span>模式</span>
          <strong>{scope.writeMode}</strong>
          <small>平台写入 <b>0</b></small>
        </div>
      </div>
    </section>
  );
}

function AgentNativeAttentionRail({
  attention,
  selectedId,
  onSelect
}: {
  attention: AttentionItem[];
  selectedId: string;
  onSelect: (item: AttentionItem) => void;
}) {
  return (
    <section
      className={styles.agentNativeAttention}
      aria-labelledby="agent-native-attention-heading"
      data-testid="agent-native-attention-rail"
    >
      <header className={styles.agentNativeSectionHeader}>
        <div>
          <span>ATTENTION OBJECTS</span>
          <h2 id="agent-native-attention-heading">关注对象</h2>
        </div>
        <strong>{attention.length}</strong>
      </header>
      <p className={styles.agentNativeSectionHint}>按事项进入证据镜，不是 Agent 员工卡。</p>
      {attention.length ? (
        <div className={styles.agentNativeAttentionList}>
          {attention.map((item) => {
            const selected = item.id === selectedId;
            return (
              <button
                key={item.id}
                type="button"
                className={styles.agentNativeAttentionItem}
                data-selected={selected}
                data-status={item.disposition ?? item.systemState}
                data-entity-type="attention_item"
                data-entity-id={item.id}
                aria-pressed={selected}
                onClick={() => onSelect(item)}
              >
                <span className={styles.agentNativeAttentionMeta}>
                  <span data-priority={item.priority}>{item.priority}</span>
                  <span>{item.stateLabel}</span>
                </span>
                <strong>{item.title}</strong>
                <span>{item.summary}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className={styles.agentNativeAttentionEmpty}>当前没有可核验关注事项。</div>
      )}
    </section>
  );
}

function AgentNativeDecisionInspector({
  decisionBrief,
  actionPreview
}: {
  decisionBrief: DecisionBrief | null;
  actionPreview: ActionPreview | null;
}) {
  if (!decisionBrief || !actionPreview) return null;
  const disposition = decisionBrief.disposition ?? decisionBrief.systemState;
  return (
    <section
      className={styles.agentNativeDecisionInspector}
      aria-labelledby="agent-native-decision-heading"
      data-testid="agent-native-decision-inspector"
    >
      <header className={styles.agentNativeSectionHeader}>
        <div>
          <span>DECISION BRIEF</span>
          <h2 id="agent-native-decision-heading">研判摘要</h2>
        </div>
        <strong data-disposition={disposition}>{disposition}</strong>
      </header>
      <div className={styles.agentNativeDecisionBlock}>
        <span>why now</span>
        <p>{decisionBrief.whyNow}</p>
      </div>
      <div className={styles.agentNativeDecisionBlock}>
        <span>当前观察</span>
        <p>{decisionBrief.currentObservation}</p>
      </div>
      <div className={styles.agentNativeEvidenceList} aria-label="结构化证据">
        <span>证据</span>
        {decisionBrief.evidence.map((evidence) => (
          <div key={evidence.evidenceId}>
            <strong>{evidence.claim}</strong>
            <small>{evidence.evidenceId} · {agentNativeDisplay(evidence.timeBoundary)}</small>
          </div>
        ))}
      </div>
      <div className={styles.agentNativeActionPreview} data-testid="agent-native-action-preview">
        <div className={styles.agentNativeActionHeader}>
          <span>只读 ActionPreview</span>
          <strong>{actionPreview.actionType}</strong>
        </div>
        <dl>
          <div><dt>目标</dt><dd>{agentNativeDisplay(actionPreview.target)}</dd></div>
          <div><dt>允许</dt><dd>{actionPreview.allowed ? "允许受约束研判" : `已阻断 · ${agentNativeDisplay(actionPreview.blockedReason)}`}</dd></div>
          <div><dt>Policy / 模式</dt><dd>{agentNativeDisplay(actionPreview.policyVersion)} · {actionPreview.writeMode}</dd></div>
          <div><dt>成本 / 不确定性</dt><dd>{agentNativeDisplay(actionPreview.estimatedDuration, "成本待核验")} · {agentNativeDisplay(actionPreview.uncertainty, "不确定性待核验")}</dd></div>
          <div><dt>可逆性</dt><dd>{actionPreview.reversible}</dd></div>
          <div><dt>停止条件</dt><dd>{agentNativeDisplay(actionPreview.stopCondition)}</dd></div>
          <div><dt>执行者 / lease</dt><dd>{actionPreview.executor.label} · {actionPreview.executor.leaseStatus}</dd></div>
          <div><dt>平台写入</dt><dd>0（真实发布保持禁用）</dd></div>
        </dl>
      </div>
      {decisionBrief.recommendation ? (
        <p className={styles.agentNativeRecommendation}>{decisionBrief.recommendation}</p>
      ) : null}
    </section>
  );
}

export function AgentWorkbench({
  operator,
  agentNative
}: {
  operator: OperatorWorkspaceReadModel;
  agentNative: AgentNativeWorkbenchViewModel;
}) {
  const initialCourseContext = defaultCourseContext(operator);
  const router = useRouter();
  const searchParams = useSearchParams();
  const handoffRunId = resolveWorkbenchRestoreRunId(searchParams.get("run"), "");
  const {
    attachment: agentAttachment,
    setAttachment: setAgentAttachment,
    clearAttachment: clearAgentAttachment,
    executeCommand: executeAgentCommand,
    isExecuting: isAgentExecuting,
    error: agentCommandError,
    workbenchPromptHandoff
  } = useAgentSession();
  const agentAttachmentRef = agentAttachment?.ref ?? "";
  const agentAttachmentTitle = agentAttachment?.title ?? "";
  const [prompt, setPrompt] = useState("");
  const [collaborationMode, setCollaborationMode] = useState<WorkbenchCollaborationMode>("default");
  const [goalMode, setGoalMode] = useState(false);
  const [consoleView, setConsoleView] = useState<ConsoleView>("conversation");
  const [attachedContextRef, setAttachedContextRef] = useState(
    initialCourseContext?.ref ?? ""
  );
  const [attachedContextTitle, setAttachedContextTitle] = useState(
    initialCourseContext?.title ?? ""
  );
  const [activeTaskTitle, setActiveTaskTitle] = useState("");
  const [snapshot, setSnapshot] = useState<WorkbenchRunSnapshot | null>(null);
  const [error, setError] = useState("");
  const [showAgentCommandError, setShowAgentCommandError] = useState(false);
  const [fallbackAvailable, setFallbackAvailable] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [runRestorationComplete, setRunRestorationComplete] = useState(false);
  const [transport, setTransport] = useState<TransportState>("idle");
  const [history, setHistory] = useState<WorkbenchHistoryItem[]>([]);
  const [localUserMessages, setLocalUserMessages] = useState<LocalUserMessage[]>([]);
  const [isTaskRailOpen, setIsTaskRailOpen] = useState(false);
  const [selectedBriefItemId, setSelectedBriefItemId] = useState(agentNative.focus?.id ?? "");
  const [hasNewTimelineContent, setHasNewTimelineContent] = useState(false);
  const consoleViewRef = useRef<ConsoleView>(consoleView);
  const collaborationModeRef = useRef<WorkbenchCollaborationMode>(collaborationMode);
  const goalModeRef = useRef(goalMode);
  const isTaskRailOpenRef = useRef(isTaskRailOpen);
  const workbenchPageRevisionRef = useRef(1);
  const workbenchRunStatusRef = useRef<WorkbenchRunStatus | "idle">("idle");
  const snapshotRef = useRef<WorkbenchRunSnapshot | null>(null);
  const isStoppingRef = useRef(false);
  const stopRequestRef = useRef<{
    runId: string;
    promise: Promise<WorkbenchRunSnapshot | null>;
  } | null>(null);
  const stopRunRef = useRef<() => Promise<WorkbenchRunSnapshot | null>>(
    async () => null
  );
  const conversationStreamRef = useRef<HTMLDivElement | null>(null);
  const taskRailRef = useRef<HTMLElement | null>(null);
  const taskRailCloseRef = useRef<HTMLButtonElement | null>(null);
  const taskRailToggleRef = useRef<HTMLButtonElement | null>(null);
  const briefTriggerRef = useRef<HTMLButtonElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const timelineUserScrollIntentRef = useRef(false);
  const lastTimelineRunIdRef = useRef("");
  const streamRef = useRef<EventSource | null>(null);
  const streamTokenRef = useRef("");
  const mountedRef = useRef(false);
  const operationRef = useRef(0);
  const lastSeqRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const launchRequestIdsRef = useRef(new Map<string, string>());

  const closeTaskRail = useCallback((restoreFocus = true) => {
    isTaskRailOpenRef.current = false;
    setIsTaskRailOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => taskRailToggleRef.current?.focus());
    }
  }, []);

  const updateBriefFocus = useCallback((focusId: string | null) => {
    const href = buildAgentNativeWorkbenchHref(
      new URLSearchParams(searchParams.toString()),
      focusId
    );
    router.replace(href, { scroll: false });
  }, [router, searchParams]);

  const closeOpportunityCanvas = useCallback(() => {
    setSelectedBriefItemId("");
    updateBriefFocus(null);
    window.requestAnimationFrame(() => {
      const trigger = briefTriggerRef.current;
      if (trigger?.isConnected) trigger.focus();
    });
  }, [updateBriefFocus]);

  const selectBriefItem = useCallback((
    item: CourseOpportunityBriefItem,
    trigger?: HTMLButtonElement | null
  ) => {
    if (trigger) briefTriggerRef.current = trigger;
    closeTaskRail(false);
    setSelectedBriefItemId(item.id);
    updateBriefFocus(item.id);
  }, [closeTaskRail, updateBriefFocus]);

  const openOpportunityCanvas = useCallback((
    item: CourseOpportunityBriefItem,
    trigger: HTMLButtonElement
  ) => {
    briefTriggerRef.current = trigger;
    closeTaskRail(false);
    setSelectedBriefItemId(item.id);
    updateBriefFocus(item.id);
  }, [closeTaskRail, updateBriefFocus]);

  const selectAttentionItem = useCallback((item: AttentionItem) => {
    const briefItem = operator.brief.items.find((candidate) => candidate.id === item.id);
    if (briefItem) selectBriefItem(briefItem);
  }, [operator.brief.items, selectBriefItem]);

  useEffect(() => {
    setSelectedBriefItemId(agentNative.focus?.id ?? "");
  }, [agentNative.focus?.id]);

  useEffect(() => {
    let changed = false;
    if (consoleViewRef.current !== consoleView) {
      consoleViewRef.current = consoleView;
      changed = true;
    }
    if (collaborationModeRef.current !== collaborationMode) {
      collaborationModeRef.current = collaborationMode;
      changed = true;
    }
    if (goalModeRef.current !== goalMode) {
      goalModeRef.current = goalMode;
      changed = true;
    }
    if (isTaskRailOpenRef.current !== isTaskRailOpen) {
      isTaskRailOpenRef.current = isTaskRailOpen;
      changed = true;
    }
    const nextRunStatus = snapshot?.status ?? "idle";
    if (workbenchRunStatusRef.current !== nextRunStatus) {
      workbenchRunStatusRef.current = nextRunStatus;
      changed = true;
    }
    if (changed) workbenchPageRevisionRef.current += 1;
  }, [collaborationMode, consoleView, goalMode, isTaskRailOpen, snapshot?.status]);

  useEffect(() => {
    if (!runRestorationComplete) return;
    return registerPageBridge({
      routeId: "workbench",
      capabilities: WORKBENCH_PAGE_ACTION_CAPABILITIES,
      readState: () => {
      const currentRun = snapshotRef.current;
      return createWorkbenchPageBridgeState({
        surface: consoleViewRef.current,
        collaborationMode: collaborationModeRef.current,
        goalMode: goalModeRef.current,
        historyOpen: isTaskRailOpenRef.current,
        runStatus: currentRun?.status ?? "idle",
        canStop: Boolean(
          currentRun?.capabilities.canStop &&
          !isTerminalWorkbenchStatus(currentRun.status) &&
          !isStoppingRef.current
        ),
        stopPending: isStoppingRef.current,
        revision: workbenchPageRevisionRef.current
      });
      },
      execute: async (action) => {
      const currentRun = snapshotRef.current;
      const transition = await executeWorkbenchPageAction({
        current: {
          surface: consoleViewRef.current,
          collaborationMode: collaborationModeRef.current,
          goalMode: goalModeRef.current,
          historyOpen: isTaskRailOpenRef.current,
          runStatus: currentRun?.status ?? "idle",
          canStop: Boolean(
            currentRun?.capabilities.canStop &&
            !isTerminalWorkbenchStatus(currentRun.status) &&
            !isStoppingRef.current
          ),
          stopPending: isStoppingRef.current,
          revision: workbenchPageRevisionRef.current
        },
        action,
        stopCurrentRun: async () => {
          const stopped = await stopRunRef.current();
          return stopped
            ? {
                runStatus: stopped.status,
                canStop: Boolean(
                  stopped.capabilities.canStop &&
                  !isTerminalWorkbenchStatus(stopped.status)
                ),
                revision: workbenchPageRevisionRef.current
              }
            : null;
        }
      });
      if (transition.outcome.status !== "completed") return transition.outcome;

      const next = transition.next;
      consoleViewRef.current = next.surface;
      collaborationModeRef.current = next.collaborationMode;
      goalModeRef.current = next.goalMode;
      isTaskRailOpenRef.current = next.historyOpen;
      workbenchRunStatusRef.current = next.runStatus;
      isStoppingRef.current = next.stopPending;
      workbenchPageRevisionRef.current = Math.max(
        workbenchPageRevisionRef.current,
        next.revision
      );
      setConsoleView(next.surface);
      setCollaborationMode(next.collaborationMode);
      setGoalMode(next.goalMode);
      setIsTaskRailOpen(next.historyOpen);
      if (next.historyOpen) {
        window.requestAnimationFrame(() => taskRailCloseRef.current?.focus());
      }
      return transition.outcome;
      }
    });
  }, [runRestorationComplete]);

  const refreshHistory = async () => {
    try {
      const response = await fetch("/api/workbench/runs?limit=12", {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      if (!response.ok) return;
      const payload = await response.json() as { runs?: WorkbenchHistoryItem[] };
      if (Array.isArray(payload.runs)) {
        setHistory(reconcileWorkbenchHistory(payload.runs, snapshotRef.current));
      }
    } catch {
      // History is supplementary; the live run remains fully usable.
    }
  };

  const closeStream = () => {
    streamTokenRef.current = "";
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
  };

  const applySnapshot = (incoming: WorkbenchRunSnapshot, replaceEvents = false) => {
    if (!mountedRef.current) {
      return;
    }
    setSnapshot((previous) => {
      const next = replaceEvents ? incoming : mergeSnapshots(previous, incoming);
      snapshotRef.current = next;
      return next;
    });
    const incomingLastSeq = Math.max(
      incoming.lastEventSeq,
      incoming.events[incoming.events.length - 1]?.seq ?? 0
    );
    lastSeqRef.current = replaceEvents
      ? incomingLastSeq
      : Math.max(lastSeqRef.current, incomingLastSeq);
    if (isTerminalWorkbenchStatus(incoming.status)) {
      setHistory((previous) => reconcileWorkbenchHistory(previous, incoming));
      setTransport("closed");
      closeStream();
    }
  };

  const appendEvent = (incoming: WorkbenchEvent) => {
    const currentSnapshot = snapshotRef.current;
    if (!mountedRef.current || !currentSnapshot || incoming.runId !== currentSnapshot.id) {
      return;
    }
    if (!Number.isFinite(incoming.seq) || incoming.seq <= lastSeqRef.current) {
      return;
    }
    lastSeqRef.current = incoming.seq;
    setSnapshot((previous) => {
      if (!previous || previous.id !== incoming.runId) {
        return previous;
      }
      if (previous.events.some((event) => event.seq === incoming.seq)) {
        return previous;
      }
      const next = {
        ...previous,
        events: [...previous.events, incoming].sort((left, right) => left.seq - right.seq),
        lastEventSeq: Math.max(previous.lastEventSeq, incoming.seq),
        updatedAt: incoming.at
      };
      snapshotRef.current = next;
      return next;
    });
  };

  const handleStreamData = (rawData: string, explicitType: string, token: string) => {
    if (!mountedRef.current || streamTokenRef.current !== token) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData) as unknown;
    } catch {
      return;
    }

    let eventType = explicitType;
    let payload = parsed;
    if (isRecord(parsed)) {
      const wrappedType = stringValue(parsed.type) || stringValue(parsed.event);
      if (wrappedType) {
        eventType = wrappedType;
      }
      if (parsed.data !== undefined) {
        payload = parsed.data;
      } else if (parsed.payload !== undefined) {
        payload = parsed.payload;
      }
    }

    if (eventType === "snapshot" || eventType === "reset") {
      const next = extractSnapshot(payload);
      if (next) {
        applySnapshot(next, eventType === "reset");
      } else {
        setError("安全状态不可验证，实时连接已停止。");
        setTransport("closed");
        closeStream();
      }
      return;
    }
    if (eventType === "workbench_event" || eventType === "event") {
      const next = normalizeEvent(payload);
      if (next) {
        appendEvent(next);
      }
      return;
    }

    const maybeSnapshot = extractSnapshot(payload);
    if (maybeSnapshot) {
      applySnapshot(maybeSnapshot);
      return;
    }
    const maybeEvent = normalizeEvent(payload);
    if (maybeEvent) {
      appendEvent(maybeEvent);
    }
  };

  const openStream = (runId: string) => {
    closeStream();
    const token = `${runId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    streamTokenRef.current = token;
    setTransport("connecting");
    const source = new EventSource(`/api/workbench/runs/${encodeURIComponent(runId)}/events`);
    streamRef.current = source;
    source.onopen = () => {
      if (streamTokenRef.current === token && mountedRef.current) {
        setTransport("connected");
      }
    };
    source.onerror = () => {
      if (streamTokenRef.current === token && mountedRef.current) {
        setTransport("reconnecting");
      }
    };
    source.addEventListener("snapshot", (event) => {
      handleStreamData((event as MessageEvent<string>).data, "snapshot", token);
    });
    source.addEventListener("workbench_event", (event) => {
      handleStreamData((event as MessageEvent<string>).data, "workbench_event", token);
    });
    source.addEventListener("reset", (event) => {
      handleStreamData((event as MessageEvent<string>).data, "reset", token);
    });
    source.onmessage = (event) => {
      handleStreamData(event.data, "message", token);
    };
  };

  const refreshRunAfterActionDecision = async (runId: string) => {
    const next = await fetchSnapshot(runId);
    if (!mountedRef.current || snapshotRef.current?.id !== runId) return;
    applySnapshot(next);
    if (!isTerminalWorkbenchStatus(next.status) && !streamRef.current) {
      openStream(runId);
    }
  };

  const abortPendingRequest = () => {
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
  };

  const persistRun = (runId: string, title: string) => {
    try {
      window.sessionStorage.setItem(WORKBENCH_RUN_STORAGE_KEY, runId);
      window.sessionStorage.setItem(WORKBENCH_TASK_STORAGE_KEY, title.slice(0, 160));
    } catch {
      // Storage can be unavailable in private browsing; the run still remains usable.
    }
  };

  const clearPersistedRun = () => {
    try {
      window.sessionStorage.removeItem(WORKBENCH_RUN_STORAGE_KEY);
      window.sessionStorage.removeItem(WORKBENCH_TASK_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
  };

  const clearPersistedRunIfCurrent = (runId: string) => {
    try {
      if (window.sessionStorage.getItem(WORKBENCH_RUN_STORAGE_KEY) !== runId) return;
      clearPersistedRun();
    } catch {
      // Ignore storage failures; the visible recovery error remains sufficient.
    }
  };

  const beginNewTask = () => {
    const current = snapshotRef.current;
    operationRef.current += 1;
    abortPendingRequest();
    closeStream();
    clearPersistedRun();
    if (current) {
      setHistory((previous) => reconcileWorkbenchHistory(previous, current));
    }

    snapshotRef.current = null;
    lastSeqRef.current = 0;
    lastTimelineRunIdRef.current = "";
    shouldAutoScrollRef.current = true;
    timelineUserScrollIntentRef.current = false;
    stopRequestRef.current = null;
    isStoppingRef.current = false;
    workbenchRunStatusRef.current = "idle";
    consoleViewRef.current = "conversation";
    collaborationModeRef.current = "default";
    goalModeRef.current = false;
    isTaskRailOpenRef.current = false;
    workbenchPageRevisionRef.current += 1;

    setSnapshot(null);
    setPrompt("");
    setLocalUserMessages([]);
    setActiveTaskTitle("");
    setError("");
    setShowAgentCommandError(false);
    setFallbackAvailable(false);
    setIsCreating(false);
    setIsSending(false);
    setIsStopping(false);
    setTransport("idle");
    setConsoleView("conversation");
    setCollaborationMode("default");
    setGoalMode(false);
    setIsTaskRailOpen(false);
    setSelectedBriefItemId("");
    setHasNewTimelineContent(false);
    setRunRestorationComplete(true);
    setAttachedContextRef(initialCourseContext?.ref ?? "");
    setAttachedContextTitle(initialCourseContext?.title ?? "");
    if (initialCourseContext) {
      setAgentAttachment(initialCourseContext);
    } else {
      clearAgentAttachment();
    }
    try {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete("run");
      window.history.replaceState(
        window.history.state,
        "",
        `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`
      );
    } catch {
      // The in-memory task reset remains usable if browser history is unavailable.
    }
    window.requestAnimationFrame(() => {
      document.getElementById("workbench-prompt")?.focus();
    });
  };

  const createRun = async (
    mode: "live" | "demo",
    requestedPrompt: string,
    requestedModes?: {
      collaborationMode: WorkbenchCollaborationMode;
      goalMode: boolean;
      displayPrompt?: string;
    }
  ) => {
    const trimmedPrompt = requestedPrompt.trim();
    const displayPrompt = requestedModes?.displayPrompt?.trim() || trimmedPrompt;
    if (!trimmedPrompt) {
      setError("请先输入要交给 cMOOC 智能体的任务。");
      return;
    }
    if (trimmedPrompt.length > MAX_PROMPT_LENGTH) {
      setError(`任务不能超过 ${MAX_PROMPT_LENGTH} 个字符。`);
      return;
    }

    abortPendingRequest();
    closeStream();
    const operation = ++operationRef.current;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setIsCreating(true);
    setFallbackAvailable(false);
    setError("");
    setShowAgentCommandError(false);
    snapshotRef.current = null;
    setSnapshot(null);
    setLocalUserMessages([]);
    setTransport("connecting");
    setConsoleView("conversation");
    setIsTaskRailOpen(false);

    const effectiveCollaborationMode =
      requestedModes?.collaborationMode ?? collaborationMode;
    const effectiveGoalMode = requestedModes?.goalMode ?? goalMode;

    try {
      const response = await fetch("/api/workbench/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          prompt: trimmedPrompt,
          mode,
          ...(mode === "live"
            ? {
                collaborationMode: effectiveCollaborationMode,
                goalMode: effectiveGoalMode
              }
            : {}),
          ...(attachedContextRef
            ? { contextRef: attachedContextRef, intent: "implement" }
            : {})
        }),
        signal: controller.signal
      });
      const payload = await readResponseBody(response);
      if (!response.ok) {
        throw requestFailure(errorMessage(payload, `启动任务失败（${response.status}）。`), response.status);
      }
      let next = extractSnapshot(payload);
      const runId = next?.id ?? extractRunId(payload);
      if (!runId) {
        throw new Error("启动响应缺少运行编号。");
      }
      if (!next) {
        next = await fetchSnapshot(runId, controller.signal);
      }
      if (operation !== operationRef.current || !mountedRef.current || !next) {
        return;
      }
      const publicTaskTitle =
        attachedContextTitle ||
        (next.taskTitle && next.taskTitle !== "课程研判任务" ? next.taskTitle : "") ||
        publicTaskDisplayTitle(displayPrompt).slice(0, 160) ||
        (mode === "demo" ? DEMO_TASK_LABEL : LIVE_TASK_LABEL);
      setActiveTaskTitle(publicTaskTitle);
      setLocalUserMessages([{
        id: `task-${next.id}`,
        runId: next.id,
        at: next.createdAt,
        text: displayPrompt,
        kind: "task"
      }]);
      setPrompt("");
      snapshotRef.current = next;
      setSnapshot(next);
      setAttachedContextRef(next.context?.ref ?? attachedContextRef);
      setAttachedContextTitle(next.context?.title ?? attachedContextTitle);
      if (next.context) {
        setAgentAttachment({
          ref: next.context.ref,
          title: next.context.title,
          ...(next.context.sourceHref
            ? { sourceHref: next.context.sourceHref }
            : {})
        });
      }
      lastSeqRef.current = next.lastEventSeq;
      setTransport(isTerminalWorkbenchStatus(next.status) ? "closed" : "connecting");
      persistRun(next.id, publicTaskTitle);
      if (!isTerminalWorkbenchStatus(next.status)) {
        openStream(next.id);
      }
      void refreshHistory();
    } catch (cause) {
      if (controller.signal.aborted || operation !== operationRef.current || !mountedRef.current) {
        return;
      }
      const message = cause instanceof Error ? cause.message : "启动任务时发生未知错误。";
      setError(message);
      setTransport("idle");
      const failureStatus = cause instanceof Error ? (cause as RequestFailure).status : undefined;
      if (mode === "live" && isHarnessUnavailableStatus(failureStatus)) {
        setFallbackAvailable(true);
      }
    } finally {
      if (operation === operationRef.current) {
        requestAbortRef.current = null;
        setIsCreating(false);
      }
    }
  };

  const launchCurrentRun = async ({
    kind
  }: {
    kind: "restart" | "continuation" | "plan-execution";
  }) => {
    const source = snapshotRef.current;
    if (!source || isCreating) return;
    const launchKey = `${source.id}:${kind}`;
    const requestId = launchRequestIdsRef.current.get(launchKey) ?? crypto.randomUUID();
    launchRequestIdsRef.current.set(launchKey, requestId);
    abortPendingRequest();
    const operation = ++operationRef.current;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setIsCreating(true);
    setError("");
    setShowAgentCommandError(false);
    setFallbackAvailable(false);
    try {
      const response = await fetch(
        `/api/workbench/runs/${encodeURIComponent(source.id)}/launch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ kind, requestId }),
          signal: controller.signal
        }
      );
      const payload = await readResponseBody(response);
      if (!response.ok) {
        throw requestFailure(
          errorMessage(payload, `启动承接任务失败（${response.status}）。`),
          response.status
        );
      }
      let next = extractSnapshot(payload);
      const runId = next?.id ?? extractRunId(payload);
      if (!runId) throw new Error("启动响应缺少运行编号。");
      if (!next) next = await fetchSnapshot(runId, controller.signal);
      if (operation !== operationRef.current || !mountedRef.current || !next) return;

      launchRequestIdsRef.current.delete(launchKey);
      closeStream();
      const publicTaskTitle = next.taskTitle || source.taskTitle || LIVE_TASK_LABEL;
      const displayPrompt = isRecord(payload) && stringValue(payload.displayPrompt)
        ? stringValue(payload.displayPrompt)
        : kind === "plan-execution"
          ? `执行已确认的计划：${publicTaskTitle}`
          : kind === "continuation"
            ? `基于结果继续：${publicTaskTitle}`
          : `重新启动：${publicTaskTitle}`;
      setActiveTaskTitle(publicTaskTitle);
      setLocalUserMessages([{
        id: `task-${next.id}`,
        runId: next.id,
        at: next.createdAt,
        text: displayPrompt,
        kind: "task"
      }]);
      setPrompt("");
      snapshotRef.current = next;
      setSnapshot(next);
      setCollaborationMode(next.collaborationMode ?? "default");
      setGoalMode(Boolean(next.goalMode));
      setAttachedContextRef(next.context?.ref ?? "");
      setAttachedContextTitle(next.context?.title ?? "");
      lastSeqRef.current = next.lastEventSeq;
      setTransport(isTerminalWorkbenchStatus(next.status) ? "closed" : "connecting");
      persistRun(next.id, publicTaskTitle);
      if (!isTerminalWorkbenchStatus(next.status)) openStream(next.id);
      void refreshHistory();
    } catch (cause) {
      if (controller.signal.aborted || operation !== operationRef.current || !mountedRef.current) {
        return;
      }
      setError(cause instanceof Error ? cause.message : "承接任务启动失败。");
      const failureStatus = cause instanceof Error ? (cause as RequestFailure).status : undefined;
      if (isHarnessUnavailableStatus(failureStatus)) setFallbackAvailable(true);
    } finally {
      if (operation === operationRef.current) {
        requestAbortRef.current = null;
        setIsCreating(false);
      }
    }
  };

  const executeCurrentPlan = () => {
    if (
      isCreating ||
      snapshot?.collaborationMode !== "plan" ||
      snapshot.status !== "completed" ||
      !snapshot.plan?.steps.length
    ) {
      return;
    }
    const carryGoalMode = Boolean(snapshot.goalMode);
    setCollaborationMode("default");
    setGoalMode(carryGoalMode);
    void launchCurrentRun({ kind: "plan-execution" });
  };

  const restartCurrentRun = () => {
    if (
      isCreating ||
      snapshot?.status !== "failed" ||
      !snapshot.capabilities.canRestart
    ) {
      return;
    }
    void launchCurrentRun({ kind: "restart" });
  };

  const continueCompletedRun = () => {
    if (
      isCreating ||
      snapshot?.status !== "completed" ||
      snapshot.capabilities.canSteer ||
      !snapshot.capabilities.canContinue
    ) {
      return;
    }
    void launchCurrentRun({ kind: "continuation" });
  };

  const sendGuidance = async (requestedPrompt: string) => {
    const trimmedPrompt = requestedPrompt.trim();
    if (!snapshot || !trimmedPrompt || !snapshot.capabilities.canSteer || isSending) {
      if (!trimmedPrompt) setError("请输入要追加给运行中智能体的引导。");
      return;
    }
    const operation = ++operationRef.current;
    const controller = new AbortController();
    abortPendingRequest();
    requestAbortRef.current = controller;
    setIsSending(true);
    setError("");
    setShowAgentCommandError(false);
    try {
      const response = await fetch(`/api/workbench/runs/${encodeURIComponent(snapshot.id)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ prompt: trimmedPrompt }),
        signal: controller.signal
      });
      const payload = await readResponseBody(response);
      if (!response.ok) {
        throw new Error(errorMessage(payload, `追加引导失败（${response.status}）。`));
      }
      const nextSnapshot = extractSnapshot(payload);
      if (nextSnapshot) {
        applySnapshot(nextSnapshot);
        if (!isTerminalWorkbenchStatus(nextSnapshot.status)) {
          openStream(nextSnapshot.id);
        }
      } else {
        const nextEvent = normalizeEvent(payload) ?? (isRecord(payload) ? normalizeEvent(payload.data) : null);
        if (nextEvent) appendEvent(nextEvent);
      }
      setLocalUserMessages((previous) => [
        ...previous.filter((message) => message.runId === snapshot.id),
        {
          id: `guidance-${snapshot.id}-${Date.now()}`,
          runId: snapshot.id,
          at: new Date().toISOString(),
          text: trimmedPrompt,
          kind: "guidance"
        }
      ]);
      setPrompt("");
    } catch (cause) {
      if (controller.signal.aborted || operation !== operationRef.current || !mountedRef.current) {
        return;
      }
      setError(cause instanceof Error ? cause.message : "追加引导时发生未知错误。");
    } finally {
      if (operation === operationRef.current) {
        requestAbortRef.current = null;
        setIsSending(false);
      }
    }
  };

  const stopRun = async (): Promise<WorkbenchRunSnapshot | null> => {
    const current = snapshotRef.current;
    if (!current) return null;
    if (isTerminalWorkbenchStatus(current.status)) return current;

    const inFlight = stopRequestRef.current;
    if (inFlight?.runId === current.id) return await inFlight.promise;
    if (!current.capabilities.canStop) return current;

    const stopPromise = (async (): Promise<WorkbenchRunSnapshot | null> => {
      const operation = ++operationRef.current;
      const controller = new AbortController();
      abortPendingRequest();
      requestAbortRef.current = controller;
      isStoppingRef.current = true;
      workbenchPageRevisionRef.current += 1;
      setIsStopping(true);
      setError("");
      setShowAgentCommandError(false);
      try {
        const response = await fetch(
          `/api/workbench/runs/${encodeURIComponent(current.id)}/stop`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({}),
            signal: controller.signal
          }
        );
        const payload = await readResponseBody(response);
        if (!response.ok) {
          throw new Error(errorMessage(payload, `停止任务失败（${response.status}）。`));
        }
        const next = extractSnapshot(payload) ??
          await fetchSnapshot(current.id, controller.signal);
        if (
          controller.signal.aborted ||
          operation !== operationRef.current ||
          !mountedRef.current
        ) {
          return null;
        }
        workbenchRunStatusRef.current = next.status;
        applySnapshot(next);
        return next;
      } catch (cause) {
        if (
          controller.signal.aborted ||
          operation !== operationRef.current ||
          !mountedRef.current
        ) {
          return null;
        }
        setError(cause instanceof Error ? cause.message : "停止任务时发生未知错误。");
        return null;
      } finally {
        if (operation === operationRef.current) {
          requestAbortRef.current = null;
          isStoppingRef.current = false;
          workbenchPageRevisionRef.current += 1;
          setIsStopping(false);
        }
      }
    })();
    stopRequestRef.current = { runId: current.id, promise: stopPromise };
    try {
      return await stopPromise;
    } finally {
      if (stopRequestRef.current?.promise === stopPromise) {
        stopRequestRef.current = null;
      }
    }
  };
  stopRunRef.current = stopRun;

  useEffect(() => {
    mountedRef.current = true;
    setRunRestorationComplete(false);
    let restored = false;
    try {
      const storedRunId = window.sessionStorage.getItem(WORKBENCH_RUN_STORAGE_KEY);
      const restoreRunId = resolveWorkbenchRestoreRunId(handoffRunId, storedRunId);
      if (restoreRunId) {
        restored = true;
        const operation = ++operationRef.current;
        const controller = new AbortController();
        requestAbortRef.current = controller;
        setTransport("connecting");
        void fetchSnapshot(restoreRunId, controller.signal)
          .then((next) => {
            if (!mountedRef.current || operation !== operationRef.current) return;
            snapshotRef.current = next;
            setSnapshot(next);
            setActiveTaskTitle(next.taskTitle ?? "");
            persistRun(next.id, next.taskTitle ?? LIVE_TASK_LABEL);
            setAttachedContextRef(next.context?.ref ?? "");
            setAttachedContextTitle(next.context?.title ?? "");
            if (next.context) {
              setAgentAttachment({
                ref: next.context.ref,
                title: next.context.title,
                ...(next.context.sourceHref
                  ? { sourceHref: next.context.sourceHref }
                  : {})
              });
            }
            lastSeqRef.current = next.lastEventSeq;
            if (isTerminalWorkbenchStatus(next.status)) {
              setTransport("closed");
              return;
            }
            openStream(next.id);
          })
          .catch((cause: unknown) => {
            if (!mountedRef.current || controller.signal.aborted || operation !== operationRef.current) return;
            clearPersistedRunIfCurrent(restoreRunId);
            setActiveTaskTitle("");
            setTransport("idle");
            setError(cause instanceof Error ? cause.message : "恢复运行状态失败。");
          })
          .finally(() => {
            if (requestAbortRef.current === controller) requestAbortRef.current = null;
            if (mountedRef.current && operation === operationRef.current) {
              setRunRestorationComplete(true);
            }
          });
      }
    } catch {
      // The empty state remains usable when sessionStorage is unavailable.
    }
    if (!restored) {
      setTransport("idle");
      setRunRestorationComplete(true);
    }

    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
      abortPendingRequest();
      closeStream();
    };
    // A query handoff can arrive while the cached Workbench component is still mounted.
    // Re-run restoration for that exact safe id; session storage remains the reload fallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoffRunId]);

  useEffect(() => {
    if (!agentAttachmentRef || !agentAttachmentTitle || snapshotRef.current?.context) return;
    setAttachedContextRef(agentAttachmentRef);
    setAttachedContextTitle(agentAttachmentTitle);
  }, [agentAttachmentRef, agentAttachmentTitle]);

  useEffect(() => {
    void refreshHistory();
    // Refresh after every terminal transition so the durable row is visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.status]);

  useEffect(() => {
    const stream = conversationStreamRef.current;
    if (!stream || !snapshot?.id) return;
    const targetRunId = snapshot.id;
    if (lastTimelineRunIdRef.current !== targetRunId) {
      lastTimelineRunIdRef.current = targetRunId;
      shouldAutoScrollRef.current = true;
      timelineUserScrollIntentRef.current = false;
      setHasNewTimelineContent(false);
    }
    if (!shouldAutoScrollRef.current) {
      setHasNewTimelineContent(true);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (!shouldAutoScrollRef.current || snapshotRef.current?.id !== targetRunId) return;
      const finalAnswer = snapshotRef.current?.finalResult
        ? stream.querySelector<HTMLElement>('[data-final-answer="true"]') ??
          stream.querySelector<HTMLElement>('[data-plan-outcome="true"]')
        : null;
      if (finalAnswer) {
        const finalAnswerTop =
          finalAnswer.getBoundingClientRect().top -
          stream.getBoundingClientRect().top +
          stream.scrollTop;
        stream.scrollTop = Math.max(0, finalAnswerTop - 12);
      } else {
        stream.scrollTop = stream.scrollHeight;
      }
      setHasNewTimelineContent(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [snapshot?.id, snapshot?.lastEventSeq, snapshot?.finalResult?.completedAt]);

  useEffect(() => {
    if (!isTaskRailOpen) return;
    const rail = taskRailRef.current;
    if (!rail) return;
    const focusTimer = window.setTimeout(() => taskRailCloseRef.current?.focus(), 0);
    const handleRailKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeTaskRail();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(rail.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeElement = document.activeElement;
      if (!rail.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleRailKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleRailKeyDown);
    };
  }, [closeTaskRail, isTaskRailOpen]);

  const handleConversationScroll = () => {
    const stream = conversationStreamRef.current;
    if (!stream) return;
    const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 96;
    if (nearBottom) {
      shouldAutoScrollRef.current = true;
      timelineUserScrollIntentRef.current = false;
      setHasNewTimelineContent(false);
      return;
    }
    if (timelineUserScrollIntentRef.current) {
      shouldAutoScrollRef.current = false;
      timelineUserScrollIntentRef.current = false;
    }
  };

  const markTimelineUserScrollIntent = () => {
    timelineUserScrollIntentRef.current = true;
  };

  const handleConversationKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
      markTimelineUserScrollIntent();
    }
  };

  const jumpToLatest = () => {
    const stream = conversationStreamRef.current;
    if (!stream) return;
    shouldAutoScrollRef.current = true;
    timelineUserScrollIntentRef.current = false;
    stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
    setHasNewTimelineContent(false);
  };

  const openHistoryItem = async (item: WorkbenchHistoryItem) => {
    closeTaskRail();
    const operation = ++operationRef.current;
    abortPendingRequest();
    closeStream();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setTransport("connecting");
    setShowAgentCommandError(false);
    try {
      setError("");
      closeTaskRail(false);
      const next = await fetchSnapshot(item.id, controller.signal);
      if (!mountedRef.current || operation !== operationRef.current) return;
      snapshotRef.current = next;
      setSnapshot(next);
      setLocalUserMessages([]);
      setActiveTaskTitle(next.taskTitle ?? item.title);
      setAttachedContextRef(next.context?.ref ?? "");
      setAttachedContextTitle(next.context?.title ?? "");
      if (next.context) {
        setAgentAttachment({
          ref: next.context.ref,
          title: next.context.title,
          ...(next.context.sourceHref
            ? { sourceHref: next.context.sourceHref }
            : {})
        });
      } else {
        clearAgentAttachment();
      }
      lastSeqRef.current = next.lastEventSeq;
      persistRun(next.id, next.taskTitle ?? item.title);
      if (!isTerminalWorkbenchStatus(next.status)) openStream(next.id);
      else setTransport("closed");
    } catch (cause) {
      if (controller.signal.aborted || !mountedRef.current || operation !== operationRef.current) {
        return;
      }
      setTransport("closed");
      setError(cause instanceof Error ? cause.message : "任务历史暂时不可用。");
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isCreating || isSending) return;
      const trimmedPrompt = prompt.trim();
      if (trimmedPrompt) {
        const commandPlan = planAgentCommand(trimmedPrompt);
        if (hasLocalPageActions(commandPlan)) {
          if (isAgentExecuting) {
            setShowAgentCommandError(false);
            setError("上一组页面动作仍在执行，请稍候继续。");
            return;
          }
          setError("");
          setShowAgentCommandError(false);
          void executeAgentCommand(trimmedPrompt).then((completed) => {
            if (mountedRef.current) setShowAgentCommandError(!completed);
            if (mountedRef.current && completed) setPrompt("");
          });
          return;
      }
    }
    const active = Boolean(snapshot && !isTerminalWorkbenchStatus(snapshot.status));
    if (canGuide) {
      void sendGuidance(prompt);
    } else if (active) {
      setError(snapshot?.source === "demo" ? "演示运行只读，不能追加引导。" : "智能体仍在启动，请稍后追加引导。");
    } else {
      const inferredModes = inferCommandModes(prompt);
      void createRun("live", prompt, {
        collaborationMode:
          collaborationMode === "plan" || inferredModes.collaborationMode === "plan"
            ? "plan"
            : "default",
        goalMode: goalMode || inferredModes.goalMode
      });
    }
  };

  const sourceLabel = snapshot?.source === "demo" ? "演示运行" : "本机执行";
  const sourceTone = snapshot?.source === "demo" ? "muted" : "cyan";
  const status = snapshot?.status;
  const active = Boolean(snapshot && !isTerminalWorkbenchStatus(snapshot.status));
  const demoActive = Boolean(active && snapshot?.source === "demo");
  const composerHasLocalPageActions = useMemo(
    () => Boolean(prompt.trim()) && hasLocalPageActions(planAgentCommand(prompt)),
    [prompt]
  );
  const canGuide = Boolean(
    snapshot?.capabilities.canSteer &&
      (snapshot.status === "running" || snapshot.status === "completed")
  );
  const completedContinuation = status === "completed" && canGuide;
  const composerTitle = canGuide
    ? "继续当前任务"
    : active
      ? demoActive
        ? "演示运行（只读）"
        : "智能体启动中"
      : "交给智能体的任务";
  const composerPlaceholder = canGuide
    ? completedContinuation
      ? "继续追问、补充要求，或要求按计划执行……"
      : "给运行中的智能体追加目标、边界或验收标准……"
    : active
      ? demoActive
        ? "演示运行不接受追加引导；仍可输入“停止当前任务”等页面命令。"
        : "连接建立后即可追加目标、边界或验收标准……"
      : "例如：审计当前课程自主促进链，并给出一处可验证改动。";
  const canStop = Boolean(snapshot?.capabilities.canStop && active);
  const connectionLabel = {
    idle: "未启动",
    connecting: "正在连接",
    connected: "实时连接",
    reconnecting: "正在重连",
    closed: "连接已收束"
  }[transport];
  const scheduleTabMeta = operator.schedule.state === "active" && operator.schedule.intervalMinutes
    ? `${operator.schedule.intervalMinutes} 分钟`
    : operator.schedule.state === "paused"
      ? "已暂停"
      : operator.schedule.state === "attention"
        ? "需关注"
        : "未配置";

  const inspectSchedulePlan = () => {
    const cadence = operator.schedule.intervalMinutes
      ? `${operator.schedule.intervalMinutes} 分钟`
      : "当前";
    setCollaborationMode("plan");
    setGoalMode(true);
    setConsoleView("conversation");
    setPrompt(
      `检查${cadence}周期运行的调度、治理、最近回执与异常状态，先给出核验计划，再指出最需要处理的一项；保持课程平台写入关闭，不执行真实发布。`
    );
    window.setTimeout(() => document.getElementById("workbench-prompt")?.focus(), 0);
  };

  const handoffBriefItem = (item: CourseOpportunityBriefItem) => {
    setAttachedContextRef(item.contextRef);
    setAttachedContextTitle(item.headline);
    setAgentAttachment({
      ref: item.contextRef,
      title: item.headline,
      sourceHref: item.sourceHref
    });
    setCollaborationMode("default");
    setGoalMode(false);
    setConsoleView("conversation");
    setPrompt(
      `核验“${item.headline}”的证据、替代解释与行动条件，给出一项可验证的下一步；保持课程平台写入关闭，不执行真实发布。`
    );
    closeOpportunityCanvas();
    window.setTimeout(() => document.getElementById("workbench-prompt")?.focus(), 0);
  };

  const handleConsoleTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const order: ConsoleView[] = ["conversation", "schedule"];
    const current = order.indexOf(consoleView);
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % order.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + order.length) % order.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = order.length - 1;
    else return;
    event.preventDefault();
    const view = order[next]!;
    setConsoleView(view);
    window.requestAnimationFrame(() => document.getElementById(`${view}-tab`)?.focus());
  };

  const totalEvents = snapshot?.events.length ?? 0;
  const timelineLabel = useMemo(() => {
    if (!snapshot) return "等待任务";
    if (status && isTerminalWorkbenchStatus(status)) return `${totalEvents} 项进展`;
    return `${totalEvents} 项进展 · ${connectionLabel}`;
  }, [connectionLabel, snapshot, status, totalEvents]);
  const conversationBlocks = useMemo(() => {
    const blocks = buildWorkbenchConversation(snapshot?.events ?? [], snapshot?.status);
    const finalSummary = publicTaskDisplayTitle(snapshot?.finalResult?.summary ?? "").trim();
    if (!finalSummary) return blocks;
    return blocks.filter((block) => {
      if (block.type !== "assistant") return true;
      const eventSummary = publicTaskDisplayTitle(block.event.summary || block.event.title).trim();
      return eventSummary !== finalSummary;
    });
  }, [snapshot?.events, snapshot?.finalResult?.summary, snapshot?.status]);
  const activity = useMemo(
    () => projectWorkbenchActivity(snapshot?.events ?? [], snapshot?.status),
    [snapshot?.events, snapshot?.status]
  );
  const currentLocalMessages = snapshot
    ? localUserMessages.filter((message) => message.runId === snapshot.id)
    : [];
  const taskMessage = currentLocalMessages.find((message) => message.kind === "task");
  const guidanceMessages = currentLocalMessages.filter((message) => message.kind === "guidance");
  const transientTaskPrompt = resolveTransientWorkbenchPrompt(workbenchPromptHandoff, snapshot?.id);
  const visibleError = error || (showAgentCommandError ? agentCommandError : "");
  const terminalSnapshot = Boolean(status && isTerminalWorkbenchStatus(status));
  const eventChannelLabel = terminalSnapshot
    ? "运行已结束"
    : snapshot
      ? "实时进展"
      : "进展通道待命";
  const terminalResultMissing = Boolean(terminalSnapshot && !snapshot?.finalResult);
  const planOutcome = Boolean(
    snapshot?.collaborationMode === "plan" &&
    snapshot.status === "completed" &&
    snapshot.plan?.steps.length
  );
  const idleLanding =
    runRestorationComplete &&
    !snapshot &&
    !isCreating &&
    !isSending;
  const idleScheduleOpen = idleLanding && consoleView === "schedule";
  const resumableHistoryItem =
    history.find(
      (item) => item.recoveryState === "interrupted" || item.canReuse === true
    ) ?? null;
  let guidanceIndex = 0;

  return (
    <div
      className={styles.page}
      data-agent-workbench="true"
      data-run-state={snapshot?.status ?? "idle"}
      data-idle-landing={idleLanding}
      data-canvas-open={Boolean(selectedBriefItemId)}
    >
      <AgentNativeContextBar viewModel={agentNative} />
      <div className={styles.systemBar}>
        <div
          role="region"
          aria-label="运行安全事实，窄屏可横向滚动"
          tabIndex={0}
        >
          <span
            className={styles.modeFact}
            data-mode={snapshot?.source === "demo" ? "demo" : "governed"}
          >
            <Icon name="lock" size={15} />
            只读观察 · 平台写入 0
          </span>
          <span className={styles.liveFact}>{eventChannelLabel}</span>
          <span className={styles.systemSnapshotFact}>快照 {formatWorkspaceDate(operator.scheduledFor)}</span>
        </div>
        <div className={styles.systemBarStatus}>
          {snapshot ? <StatusPill label={sourceLabel} tone={sourceTone} /> : null}
          {status ? <StatusPill label={STATUS_LABELS[status]} tone={statusTone(status)} pulse={status === "running"} /> : null}
          {transport === "reconnecting" ? <StatusPill label="正在重连" tone="amber" pulse /> : null}
        </div>
      </div>

      <div
        className={styles.consoleWorkspace}
        data-canvas-open={Boolean(selectedBriefItemId)}
      >
        <button
          type="button"
          className={styles.taskRailBackdrop}
          aria-label="关闭任务历史"
          tabIndex={isTaskRailOpen ? 0 : -1}
          data-open={isTaskRailOpen}
          onClick={() => closeTaskRail()}
        />
        <aside
          id="task-history-drawer"
          ref={taskRailRef}
          className={styles.taskRail}
          aria-label="任务导航"
          data-open={isTaskRailOpen}
        >
          <div className={styles.taskRailHeader}>
            <div>
              <span>任务工作区</span>
              <strong>{active ? "正在执行" : "准备就绪"}</strong>
            </div>
            <button
              ref={taskRailCloseRef}
              type="button"
              className={styles.taskRailClose}
              onClick={() => closeTaskRail()}
            >关闭</button>
          </div>
          <AgentNativeAttentionRail
            attention={agentNative.attention}
            selectedId={selectedBriefItemId}
            onSelect={selectAttentionItem}
          />
          <TaskHistory
            items={history}
            activeRootRunId={snapshot?.lineage?.rootRunId ?? snapshot?.id}
            onOpen={(item) => void openHistoryItem(item)}
          />
          <section className={styles.railContext} aria-labelledby="rail-context-heading">
            <div>
              <span>当前上下文</span>
              <strong id="rail-context-heading">{publicTaskDisplayTitle(resolveWorkbenchContextTitle(snapshot?.context?.title, attachedContextTitle))}</strong>
            </div>
            <p>{operator.courseName ?? (operator.courseBound ? "已绑定课程" : "课程名称待核验")}</p>
            <Link href="/autonomy/world">打开社会网络 <ArrowRight size={13} aria-hidden="true" /></Link>
            <OperatorCourseLocator
              courseAlias={operator.courseAlias}
              courseName={operator.courseName}
              runId={snapshot?.id ?? null}
              snapshotId={operator.brief.anchor?.snapshotId ?? null}
            />
          </section>
        </aside>

        <section
          id="task-console"
          className={styles.conversationConsole}
          aria-labelledby={
            idleScheduleOpen
              ? "idle-schedule-page-heading"
              : idleLanding
                ? "idle-workbench-heading"
                : "task-console-heading"
          }
        >
          {!idleLanding ? <header className={styles.conversationHeader}>
            <div>
              <h1 id="task-console-heading">智能控制台</h1>
              <span>{operator.courseName ?? (operator.courseBound ? "已绑定课程" : "课程名称待核验")}</span>
            </div>
            <div className={styles.conversationHeaderActions}>
              {snapshot ? (
                <button
                  type="button"
                  className={styles.newTaskButton}
                  aria-label="新建独立任务"
                  title={active ? "新建独立任务；当前任务会继续运行，可从任务历史返回" : "新建独立任务"}
                  onClick={beginNewTask}
                >
                  <PlusCircle size={17} aria-hidden="true" />
                  <span>新建任务</span>
                </button>
              ) : null}
              <button
                ref={taskRailToggleRef}
                type="button"
                className={styles.taskRailToggle}
                aria-controls="task-history-drawer"
                aria-expanded={isTaskRailOpen}
                onClick={() => {
                  if (isTaskRailOpen) closeTaskRail(false);
                  else setIsTaskRailOpen(true);
                }}
              >
                <FileText size={17} aria-hidden="true" />任务历史
              </button>
            </div>
            <span className={styles.screenReaderStatus} role="status" aria-live="polite">
              {snapshot ? `${STATUS_LABELS[snapshot.status]}，${timelineLabel}` : "控制台准备就绪"}
            </span>
          </header> : null}

          {!idleLanding ? <div className={styles.consoleViewBar}>
            <div className={styles.consoleTabs} role="tablist" aria-label="控制台工作面" onKeyDown={handleConsoleTabsKeyDown}>
              <button
                id="conversation-tab"
                type="button"
                role="tab"
                aria-selected={consoleView === "conversation"}
                aria-controls="conversation-panel"
                tabIndex={consoleView === "conversation" ? 0 : -1}
                onClick={() => setConsoleView("conversation")}
              >
                任务对话
              </button>
              <button
                id="schedule-tab"
                type="button"
                role="tab"
                aria-selected={consoleView === "schedule"}
                aria-controls="schedule-panel"
                tabIndex={consoleView === "schedule" ? 0 : -1}
                onClick={() => setConsoleView("schedule")}
              >
                周期运行 <span>{scheduleTabMeta}</span>
              </button>
            </div>
            <div className={styles.consoleViewMeta}>
              {snapshot?.sessionWorkspace ? (
                <span
                  className={styles.sessionWorkspaceMeta}
                  title="当前任务已保存到受管会话目录"
                  aria-label="坚果云会话已保存"
                >
                  <FolderSimple size={14} aria-hidden="true" />坚果云会话
                </span>
              ) : null}
              {consoleView === "conversation" ? (
                !snapshot
                  ? <WorkbenchRuntimeStatus />
                  : active
                    ? <span>{connectionLabel}</span>
                    : null
              ) : null}
            </div>
          </div> : null}

          <div
            id="conversation-panel"
            className={styles.conversationPane}
            role={idleLanding ? "region" : "tabpanel"}
            aria-labelledby={idleLanding ? "idle-workbench-heading" : "conversation-tab"}
            hidden={idleScheduleOpen || (!idleLanding && consoleView !== "conversation")}
          >
          {snapshot && !terminalSnapshot ? (
            <div className={styles.activityDock}>
              <AdaptiveRunSpine activity={activity} snapshot={snapshot} />
              <span
                className={styles.activityAnnouncement}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {`当前步骤：${publicTaskDisplayTitle(activity.title)}；${snapshot.plan?.steps.length ? `计划已完成 ${snapshot.plan.steps.filter((step) => step.status === "completed").length}/${snapshot.plan.steps.length}` : "计划待建立"}；${snapshot.status === "awaiting_action" && snapshot.pendingAction ? "有一项本次暂存操作等待决定，发布与通知仍为 0" : snapshot.artifacts.length ? "已有安全成果元数据" : "尚无成果"}。`}
              </span>
            </div>
          ) : null}
          {snapshot && terminalSnapshot ? (
            <div className={styles.activityDock} data-terminal-artifacts="true">
              <section className={styles.terminalArtifactWorkspace} aria-label="已结束任务的课程成果空间">
                <CourseArtifactWorkspace key={`terminal:${snapshot.id}`} snapshot={snapshot} />
              </section>
            </div>
          ) : null}
          <div
            ref={conversationStreamRef}
            className={styles.conversationStream}
            role="region"
            aria-label="任务对话时间线"
            tabIndex={0}
            onScroll={handleConversationScroll}
            onWheel={markTimelineUserScrollIntent}
            onTouchMove={markTimelineUserScrollIntent}
            onKeyDown={handleConversationKeyDown}
          >
            <div className={styles.conversationColumn}>
              <div className={styles.contextBar} data-attached={Boolean(attachedContextRef)}>
                <div>
                  <span>上下文</span>
                  <strong>{publicTaskDisplayTitle(resolveWorkbenchContextTitle(snapshot?.context?.title, attachedContextTitle))}</strong>
                </div>
                {snapshot?.context?.sourceHref ? (
                  <Link href={snapshot.context.sourceHref}>打开证据</Link>
                ) : attachedContextRef ? (
                  <button type="button" onClick={() => {
                    setAttachedContextRef("");
                    setAttachedContextTitle("");
                    clearAgentAttachment();
                  }}>
                    移除
                  </button>
                ) : (
                  <span>聚合视图</span>
                )}
              </div>
              {!idleLanding ? (
                <ConversationBrief
                  brief={operator.brief}
                  onOpen={openOpportunityCanvas}
                />
              ) : null}
              {snapshot ? (
                <UserMessage
                  message={taskMessage}
                  fallback={transientTaskPrompt || activeTaskTitle || snapshot.taskTitle || "课程研判任务（原始要求未持久化）"}
                />
              ) : null}
              {snapshot && terminalSnapshot ? (
                <OperatorReplyTargetCard
                  courseAlias={snapshot.context?.courseAlias ?? operator.courseAlias}
                  runId={snapshot.id}
                />
              ) : null}
              {snapshot && !planOutcome ? (
                <PlanGoalPanel
                  snapshot={snapshot}
                  isExecuting={isCreating}
                  onExecutePlan={executeCurrentPlan}
                />
              ) : null}
              {snapshot?.status === "awaiting_action" && snapshot.pendingAction ? (
                <PendingActionCard
                  key={snapshot.pendingAction.actionRef}
                  runId={snapshot.id}
                  action={snapshot.pendingAction}
                  onResolved={refreshRunAfterActionDecision}
                />
              ) : null}
              {conversationBlocks.length ? (
                conversationBlocks.map((block) => {
                  if (block.type === "system") return <SystemBlock block={block} key={block.id} />;
                  if (block.type === "analysis") return <AnalysisBlock block={block} key={block.id} />;
                  if (block.type === "tools") return <ToolBlock block={block} key={block.id} />;
                  if (block.type === "artifacts") return <ArtifactBlock block={block} artifacts={snapshot?.artifacts ?? []} key={block.id} />;
                  if (block.type === "assistant") return <AssistantUpdate block={block} key={block.id} />;
                  const message = guidanceMessages[guidanceIndex];
                  guidanceIndex += 1;
                  return (
                    <UserMessage
                      key={block.id}
                      message={message}
                      fallback="已追加一项引导（原始要求未持久化）"
                    />
                  );
                })
              ) : null}
              {snapshot ? <FinalAnswer snapshot={snapshot} /> : null}
              {terminalResultMissing ? (
                <article className={styles.missingTerminalResult} role="status">
                  <strong>结果摘要尚未回流</strong>
                  <p>运行状态已经收束；当前没有可展示的最终答复，课程平台未产生写入。</p>
                </article>
              ) : null}
              {snapshot && planOutcome ? (
                <PlanGoalPanel
                  snapshot={snapshot}
                  isExecuting={isCreating}
                  onExecutePlan={executeCurrentPlan}
                  compact
                />
              ) : null}
              {snapshot && !planOutcome ? (
                <CompletedContinuation
                  snapshot={snapshot}
                  isContinuing={isCreating}
                  onContinue={continueCompletedRun}
                />
              ) : null}
              {snapshot ? (
                <FailureRecovery
                  snapshot={snapshot}
                  isRestarting={isCreating}
                  onRestart={restartCurrentRun}
                />
              ) : null}
              {snapshot ? (
                <details className={styles.executionDetails}>
                  <summary>执行详情 · {timelineLabel}</summary>
                  <div className={styles.provenanceGrid}>
                    <aside aria-label="执行代理来源"><TeamCard snapshot={snapshot} /></aside>
                    <aside aria-label="工具与产物"><ToolsCard snapshot={snapshot} /></aside>
                  </div>
                </details>
              ) : null}
            </div>
          </div>

          {idleLanding ? <IdleTimeline
            courseName={operator.courseName ?? ""}
            courseBound={operator.courseBound}
            brief={operator.brief}
            metrics={operator.metrics}
            coverage={operator.coverage}
            scheduledFor={operator.scheduledFor}
            decisions={operator.decisions}
            opportunityCount={operator.opportunities.length}
            historyItem={resumableHistoryItem}
            historyButtonRef={taskRailToggleRef}
            historyOpen={isTaskRailOpen}
            onOpenHistory={() => {
              if (isTaskRailOpen) closeTaskRail(false);
              else setIsTaskRailOpen(true);
            }}
            onOpenHistoryItem={(item) => void openHistoryItem(item)}
            onOpenBrief={openOpportunityCanvas}
          /> : null}

          {!runRestorationComplete && !snapshot ? (
            <div className={styles.workbenchTransition} role="status" aria-live="polite">
              正在恢复任务…
            </div>
          ) : isCreating && !snapshot ? (
            <div className={styles.workbenchTransition} role="status" aria-live="polite">
              正在启动任务…
            </div>
          ) : null}

          {hasNewTimelineContent ? (
            <button type="button" className={styles.newEventsButton} onClick={jumpToLatest}>
              有新进展 · 跳到最新
            </button>
          ) : null}

          {visibleError ? (
            <div className={styles.errorBanner} id="workbench-error" role="alert" aria-live="assertive">
              <Icon name="info" size={19} />
              <p>{visibleError}</p>
              {fallbackAvailable ? (
                <button type="button" className={styles.demoButton} onClick={() => void createRun("demo", prompt)} disabled={isCreating}>加载演示</button>
              ) : null}
            </div>
          ) : null}

          <form className={styles.conversationComposer} onSubmit={onSubmit}>
            <label className={styles.composerLabel} htmlFor="workbench-prompt">
              {composerTitle}
            </label>
            <div className={styles.composerShell}>
              <textarea
                id="workbench-prompt"
                className={styles.promptInput}
                value={prompt}
                rows={1}
                maxLength={MAX_PROMPT_LENGTH}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={composerPlaceholder}
                aria-describedby={visibleError ? "workbench-prompt-help workbench-error" : "workbench-prompt-help"}
              />
              <div className={styles.composerFooter}>
                <div className={styles.composerMetaStack}>
                  {!active && !canGuide ? (
                    <details className={styles.composerTools}>
                      <summary>
                        <PlusCircle size={18} aria-hidden="true" />
                        <span>搜索与工具</span>
                        <CaretDown size={13} aria-hidden="true" />
                      </summary>
                      <div className={styles.composerToolsMenu}>
                        <div className={styles.searchCapabilityList} aria-label="可用检索能力">
                          <div>
                            <MagnifyingGlass size={17} aria-hidden="true" />
                            <span><strong>项目检索</strong><small>源码、文档与测试</small></span>
                          </div>
                          <div>
                            <GlobeHemisphereWest size={17} aria-hidden="true" />
                            <span><strong>网页检索</strong><small>只读 · 来源随答复</small></span>
                          </div>
                        </div>
                        <div className={styles.taskModeBar}>
                          <div className={styles.modeSwitch} role="group" aria-label="任务执行模式">
                            <button
                              type="button"
                              aria-pressed={collaborationMode === "default"}
                              onClick={() => setCollaborationMode("default")}
                            >
                              直接执行
                            </button>
                            <button
                              type="button"
                              aria-pressed={collaborationMode === "plan"}
                              onClick={() => setCollaborationMode("plan")}
                            >
                              先规划
                            </button>
                          </div>
                          <label className={styles.goalToggle}>
                            <input
                              type="checkbox"
                              checked={goalMode}
                              onChange={(event) => setGoalMode(event.target.checked)}
                            />
                            <span>持续目标</span>
                          </label>
                          <Link href="/platform" className={styles.computerUseBoundary} title="打开受约束页面观察入口；当前接收仓库外可信驱动器的去正文只读回执，不授予任意桌面控制。">
                            <Monitor size={14} aria-hidden="true" />电脑观察
                          </Link>
                          <button className={styles.composerMenuAction} type="button" onClick={() => void createRun("demo", prompt)} disabled={isCreating || isSending}>
                            演示预览
                          </button>
                        </div>
                      </div>
                    </details>
                  ) : (
                    <span className={styles.searchReady} title="项目检索与只读网页检索可按任务需要使用">
                      <MagnifyingGlass size={15} aria-hidden="true" />检索可用
                    </span>
                  )}
                  <div className={styles.composerHint} id="workbench-prompt-help">
                    <span>{prompt.length ? `${prompt.length.toLocaleString("zh-CN")} / ${MAX_PROMPT_LENGTH.toLocaleString("zh-CN")}` : "Enter 发送 · Shift+Enter 换行"}</span>
                    {activeTaskTitle ? <span className={styles.activeTask}>当前任务：{publicTaskDisplayTitle(activeTaskTitle)}</span> : null}
                  </div>
                </div>
                <div className={styles.composerActions}>
                  <button className={styles.secondaryButton} type="submit" disabled={isCreating || isSending || (active && !canGuide && !composerHasLocalPageActions)}>
                    <Icon name={canGuide ? "plus" : "play"} size={18} />
                    {isCreating ? "启动中…" : isSending ? "发送中…" : canGuide ? "发送" : active ? composerHasLocalPageActions ? "执行页面动作" : demoActive ? "演示只读" : "暂不可引导" : "开始新任务"}
                  </button>
                  {canStop ? (
                    <button className={styles.stopButton} type="button" onClick={() => void stopRun()} disabled={isStopping}>
                      <Icon name="stop" size={17} />
                      {isStopping ? "停止中…" : "停止"}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
            {idleLanding ? (
            <div className={styles.idleComposerStatus}>
                <p
                  className={styles.idleSafetyBoundary}
                  aria-label="详细安全边界：只读运行 · 真实发布关闭"
                >
                  <LockKey size={13} aria-hidden="true" />
                  只读观察 · 平台写入 0
                </p>
                <WorkbenchRuntimeStatus />
                <button
                  type="button"
                  className={styles.idleScheduleAction}
                  onClick={() => {
                    setConsoleView("schedule");
                  }}
                >
                  周期运行
                </button>
              </div>
            ) : null}
          </form>

          </div>
          <div
            id="schedule-panel"
            className={styles.schedulePane}
            role={idleScheduleOpen ? "region" : "tabpanel"}
            aria-labelledby={idleScheduleOpen ? "idle-schedule-page-heading" : "schedule-tab"}
            hidden={!idleScheduleOpen && consoleView !== "schedule"}
          >
            {idleScheduleOpen ? (
              <h2 id="idle-schedule-page-heading" className={styles.screenReaderStatus}>
                周期运行
              </h2>
            ) : null}
            <WorkbenchSchedulePanel
              schedule={operator.schedule}
              courseName={operator.courseName}
              courseBound={operator.courseBound}
              openIncidentCount={operator.evidence.openIncidentCount}
              onInspectPlan={inspectSchedulePlan}
            />
            {idleScheduleOpen ? (
              <button
                type="button"
                className={styles.idleScheduleBack}
                onClick={() => {
                  setConsoleView("conversation");
                }}
              >
                返回任务输入
              </button>
            ) : null}
          </div>
        </section>
        {selectedBriefItemId ? (
          <OpportunityCanvas
            brief={operator.brief}
            evidenceWorkspace={operator.evidenceWorkspace}
            selectedItemId={selectedBriefItemId}
            decisionInspector={(
              <AgentNativeDecisionInspector
                decisionBrief={agentNative.focus?.id === selectedBriefItemId ? agentNative.decisionBrief : null}
                actionPreview={agentNative.focus?.id === selectedBriefItemId ? agentNative.actionPreview : null}
              />
            )}
            onSelect={(item) => selectBriefItem(item)}
            onClose={closeOpportunityCanvas}
            onHandoff={handoffBriefItem}
          />
        ) : null}
      </div>
    </div>
  );
}
