import type { CanonicalTaskStatus, TaskStatus } from "./types";

const canonicalTransitions: Record<CanonicalTaskStatus, CanonicalTaskStatus[]> = {
  proposed: ["ready", "review_required", "skipped"],
  review_required: ["proposed", "ready", "skipped"],
  ready: ["proposed", "review_required", "publishing", "skipped"],
  publishing: ["published", "failed_retryable", "reconcile_required"],
  published: [],
  failed_retryable: ["ready", "review_required", "skipped"],
  reconcile_required: ["published", "failed_retryable"],
  skipped: []
};

const legacyStatusMap: Record<Exclude<TaskStatus, CanonicalTaskStatus>, CanonicalTaskStatus> = {
  discovered: "proposed",
  analyzed: "proposed",
  candidate: "proposed",
  drafted: "review_required",
  safety_checked: "review_required",
  queued: "ready",
  failed: "reconcile_required",
  manual_review: "review_required"
};

export function normalizeTaskStatus(status: TaskStatus | string): CanonicalTaskStatus {
  if (status in legacyStatusMap) {
    return legacyStatusMap[status as keyof typeof legacyStatusMap];
  }
  if (status in canonicalTransitions) {
    return status as CanonicalTaskStatus;
  }
  throw new Error(`未知任务状态：${status}`);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  const normalizedFrom = normalizeTaskStatus(from);
  const normalizedTo = normalizeTaskStatus(to);
  return canonicalTransitions[normalizedFrom].includes(normalizedTo);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法状态流转：${from} -> ${to}`);
  }
}

export function nextStatus(from: TaskStatus, to: TaskStatus): CanonicalTaskStatus {
  assertTransition(from, to);
  return normalizeTaskStatus(to);
}

export function getAllowedTransitions(status: TaskStatus): CanonicalTaskStatus[] {
  return canonicalTransitions[normalizeTaskStatus(status)];
}
