import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildOperatorScheduleSummary,
  projectScheduleWindows
} from "../../lib/workbench/operator-schedule";

const schedulePanelSource = readFileSync(
  new URL("../../components/workbench/WorkbenchSchedulePanel.tsx", import.meta.url),
  "utf8"
);

const now = new Date("2026-08-10T12:07:00.000Z");

test("recent host wake activates the configured cadence and exposes the latest safe run receipt", () => {
  const wake = {
    status: "completed",
    startedAt: new Date("2026-08-10T11:31:00.000Z"),
    editorWriteCount: 0,
    publishAttemptCount: 0,
    realPublishEnabled: false,
    containsForumText: false
  };
  const summary = buildOperatorScheduleSummary({
    now,
    schedules: [{
      id: "schedule-1",
      enabled: true,
      mode: "SHADOW",
      intervalMinutes: 30,
      timeZone: "Asia/Shanghai",
      nextRunAt: new Date("2026-08-10T10:00:00.000Z")
    }],
    governance: {
      status: "active",
      mode: "SHADOW",
      minIntervalMinutes: 30,
      emergencyHalt: false,
      validFrom: new Date("2026-08-01T00:00:00.000Z"),
      validUntil: new Date("2026-09-01T00:00:00.000Z")
    },
    latestInvocation: {
      scheduleId: "schedule-1",
      status: "completed",
      scheduledFor: new Date("2026-08-10T11:30:00.000Z")
    },
    latestHostWake: wake,
    latestWake: wake
  });

  assert.equal(summary.state, "active");
  assert.equal(summary.intervalMinutes, 30);
  assert.equal(summary.nextWindowAt, "2026-08-10T12:00:00.000Z");
  assert.equal(summary.nextWindowState, "due");
  assert.equal(summary.latestWake?.status, "completed");
  assert.equal(summary.externalWritesLocked, true);
  assert.equal(summary.containsForumText, false);
  assert.equal(summary.upcomingWindows.length, 4);
  assert.deepEqual(projectScheduleWindows(summary, 3), [
    "2026-08-10T12:00:00.000Z",
    "2026-08-10T12:30:00.000Z",
    "2026-08-10T13:00:00.000Z"
  ]);
});

test("enabled database schedule without current host evidence remains configured rather than active", () => {
  const summary = buildOperatorScheduleSummary({
    now,
    schedules: [{
      id: "schedule-configured",
      enabled: true,
      mode: "SHADOW",
      intervalMinutes: 30,
      timeZone: "Asia/Shanghai",
      nextRunAt: new Date("2026-08-10T10:00:00.000Z")
    }],
    governance: {
      status: "active",
      mode: "SHADOW",
      minIntervalMinutes: 30,
      emergencyHalt: false,
      validFrom: new Date("2026-08-01T00:00:00.000Z"),
      validUntil: new Date("2026-09-01T00:00:00.000Z")
    },
    latestInvocation: {
      scheduleId: "schedule-configured",
      status: "completed",
      scheduledFor: new Date("2026-08-10T11:30:00.000Z")
    },
    latestHostWake: null,
    latestWake: {
      status: "failed",
      startedAt: new Date("2026-08-10T11:45:00.000Z"),
      editorWriteCount: 0,
      publishAttemptCount: 0,
      realPublishEnabled: false,
      containsForumText: false
    }
  });

  assert.equal(summary.state, "configured");
  assert.equal(summary.latestWake?.status, "failed");
  assert.equal(summary.nextWindowAt, "2026-08-10T12:00:00.000Z");
  assert.equal(summary.upcomingWindows.length, 4);
});

test("duplicate enabled schedules fail closed as attention", () => {
  const summary = buildOperatorScheduleSummary({
    now,
    schedules: [
      { id: "a", enabled: true, mode: "SHADOW", intervalMinutes: 30, timeZone: "Asia/Shanghai", nextRunAt: now },
      { id: "b", enabled: true, mode: "SHADOW", intervalMinutes: 60, timeZone: "Asia/Shanghai", nextRunAt: now }
    ],
    governance: null,
    latestInvocation: null,
    latestHostWake: null,
    latestWake: null
  });

  assert.equal(summary.state, "attention");
  assert.equal(summary.nextWindowAt, null);
  assert.deepEqual(projectScheduleWindows(summary, 3), []);
});

test("disabled schedule is visible as paused without claiming a next window", () => {
  const summary = buildOperatorScheduleSummary({
    now,
    schedules: [{
      id: "paused",
      enabled: false,
      mode: "SHADOW",
      intervalMinutes: 30,
      timeZone: "Asia/Shanghai",
      nextRunAt: now
    }],
    governance: null,
    latestInvocation: null,
    latestHostWake: null,
    latestWake: null
  });

  assert.equal(summary.state, "paused");
  assert.equal(summary.intervalMinutes, 30);
  assert.equal(summary.nextWindowAt, null);
});

test("schedule panel uses operator language instead of runtime implementation labels", () => {
  assert.match(schedulePanelSource, /周期运行概览/);
  assert.match(schedulePanelSource, /function scheduleModeLabel/);
  assert.match(schedulePanelSource, /只读运行/);
  assert.match(schedulePanelSource, /待命/);
  assert.match(schedulePanelSource, /已写入 0 条/);
  assert.match(schedulePanelSource, /证据记录/);
  assert.match(schedulePanelSource, /重复唤醒保护/);
  assert.match(schedulePanelSource, /排期已配置/);
  assert.match(schedulePanelSource, /宿主定时唤醒尚未验证/);
  assert.match(schedulePanelSource, /最近一次运行回执/);
  assert.doesNotMatch(schedulePanelSource, /RUNTIME MONITOR/);
  assert.doesNotMatch(schedulePanelSource, /zero-write/);
  assert.doesNotMatch(schedulePanelSource, /Decision Tape/);
  assert.doesNotMatch(schedulePanelSource, /幂等 worker/);
  assert.doesNotMatch(schedulePanelSource, /<dd>\{schedule\.mode/);
});
