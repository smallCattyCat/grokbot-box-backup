import { runAutoIntervention, type AutoInterventionMode, type AutoInterventionRunResult } from "./run-auto-intervention";

export type AutoInterventionSchedulerConfig = {
  forumListUrl: string;
  maxScanPosts: number;
  maxPublishCount: number;
  minScoreToPublish: number;
  mode: AutoInterventionMode;
  allowRealPublish: boolean;
  intervalMinutes: number;
};

export type AutoInterventionSchedulerStatus = {
  running: boolean;
  isExecuting: boolean;
  config: AutoInterventionSchedulerConfig | null;
  startedAt: string | null;
  stoppedAt: string | null;
  nextRunAt: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastRunId: string | null;
  lastResult: AutoInterventionRunResult | null;
  lastError: string | null;
  skippedOverlapCount: number;
};

type InternalSchedulerState = {
  running: boolean;
  isExecuting: boolean;
  config: AutoInterventionSchedulerConfig | null;
  timer: NodeJS.Timeout | null;
  startedAt: Date | null;
  stoppedAt: Date | null;
  nextRunAt: Date | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastRunId: string | null;
  lastResult: AutoInterventionRunResult | null;
  lastError: string | null;
  skippedOverlapCount: number;
};

const globalForScheduler = globalThis as unknown as {
  autoInterventionScheduler?: InternalSchedulerState;
};

function createInitialState(): InternalSchedulerState {
  return {
    running: false,
    isExecuting: false,
    config: null,
    timer: null,
    startedAt: null,
    stoppedAt: null,
    nextRunAt: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastRunId: null,
    lastResult: null,
    lastError: null,
    skippedOverlapCount: 0
  };
}

const state = globalForScheduler.autoInterventionScheduler ?? createInitialState();
globalForScheduler.autoInterventionScheduler = state;

function dateToIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function normalizeConfig(input: AutoInterventionSchedulerConfig): AutoInterventionSchedulerConfig {
  return {
    forumListUrl: input.forumListUrl.trim(),
    maxScanPosts: Math.max(1, Math.min(30, Math.floor(input.maxScanPosts))),
    maxPublishCount: Math.max(0, Math.min(30, Math.floor(input.maxPublishCount))),
    minScoreToPublish: Math.max(0, Math.min(100, Number(input.minScoreToPublish))),
    mode: "dry_run",
    allowRealPublish: false,
    intervalMinutes: Math.max(1, Math.min(24 * 60, Math.floor(input.intervalMinutes || 30)))
  };
}

function clearScheduledTimer() {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function scheduleNextRun(delayMs?: number) {
  clearScheduledTimer();
  if (!state.running || !state.config) {
    state.nextRunAt = null;
    return;
  }
  const intervalMs = state.config.intervalMinutes * 60 * 1000;
  const nextDelayMs = Math.max(0, delayMs ?? intervalMs);
  state.nextRunAt = new Date(Date.now() + nextDelayMs);
  state.timer = setTimeout(() => {
    void executeScheduledRun();
  }, nextDelayMs);
}

async function executeScheduledRun() {
  if (!state.config) return;
  if (state.isExecuting) {
    state.skippedOverlapCount += 1;
    scheduleNextRun();
    return;
  }

  const config = state.config;
  state.isExecuting = true;
  state.lastStartedAt = new Date();
  state.lastFinishedAt = null;
  state.lastError = null;
  state.nextRunAt = null;

  try {
    const result = await runAutoIntervention(config);
    state.lastRunId = result.runId;
    state.lastResult = result;
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : "未知周期巡检错误";
  } finally {
    state.isExecuting = false;
    state.lastFinishedAt = new Date();
    if (state.running) scheduleNextRun();
  }
}

export function getAutoInterventionSchedulerStatus(): AutoInterventionSchedulerStatus {
  return {
    running: state.running,
    isExecuting: state.isExecuting,
    config: state.config,
    startedAt: dateToIso(state.startedAt),
    stoppedAt: dateToIso(state.stoppedAt),
    nextRunAt: dateToIso(state.nextRunAt),
    lastStartedAt: dateToIso(state.lastStartedAt),
    lastFinishedAt: dateToIso(state.lastFinishedAt),
    lastRunId: state.lastRunId,
    lastResult: state.lastResult,
    lastError: state.lastError,
    skippedOverlapCount: state.skippedOverlapCount
  };
}

export async function startAutoInterventionScheduler(input: AutoInterventionSchedulerConfig, runImmediately: boolean) {
  const config = normalizeConfig(input);
  state.running = true;
  state.config = config;
  state.startedAt = new Date();
  state.stoppedAt = null;
  state.lastError = null;
  scheduleNextRun(runImmediately ? 0 : config.intervalMinutes * 60 * 1000);
  return getAutoInterventionSchedulerStatus();
}

export function stopAutoInterventionScheduler() {
  clearScheduledTimer();
  state.running = false;
  state.stoppedAt = new Date();
  state.nextRunAt = null;
  return getAutoInterventionSchedulerStatus();
}

export async function runAutoInterventionSchedulerOnce(_input?: { mode?: AutoInterventionMode; allowRealPublish?: boolean }) {
  if (!state.config) {
    throw new Error("周期巡检尚未配置，请先启动一次周期巡检。");
  }
  clearScheduledTimer();
  await executeScheduledRun();
  return getAutoInterventionSchedulerStatus();
}
