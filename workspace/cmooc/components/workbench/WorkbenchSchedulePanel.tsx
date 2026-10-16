import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CalendarBlank } from "@phosphor-icons/react/dist/csr/CalendarBlank";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { ListChecks } from "@phosphor-icons/react/dist/csr/ListChecks";
import { LockKey } from "@phosphor-icons/react/dist/csr/LockKey";
import { Pulse } from "@phosphor-icons/react/dist/csr/Pulse";
import { ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import type { OperatorScheduleSummary } from "@/lib/workbench/operator-schedule";
import styles from "./WorkbenchSchedulePanel.module.css";

type WorkbenchSchedulePanelProps = {
  schedule: OperatorScheduleSummary;
  courseName: string | null;
  courseBound: boolean;
  openIncidentCount: number;
  onInspectPlan: () => void;
};

const STATUS_LABELS: Record<OperatorScheduleSummary["state"], string> = {
  active: "近期已观察到唤醒",
  configured: "排期已配置",
  paused: "已暂停",
  attention: "需要关注",
  unavailable: "不可用"
};

const WAKE_STATUS_LABELS: Record<string, string> = {
  running: "唤醒中",
  completed: "已完成",
  failed: "失败",
  abandoned: "已中止"
};

const SCHEDULE_MODE_LABELS: Record<string, string> = {
  SHADOW: "只读运行",
  OBSERVE: "只读观察",
  DEMO: "演示只读"
};

const WINDOW_LABELS: Record<
  OperatorScheduleSummary["nextWindowState"],
  string
> = {
  due: "已到期",
  upcoming: "下一轮",
  unavailable: "暂无窗口"
};

function formatDate(value: string | null, timeZone: string | null): string {
  if (!value) return "暂无";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间待同步";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timeZone || "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }
}

function safeWindowValues(schedule: OperatorScheduleSummary): string[] {
  return Array.isArray(schedule.upcomingWindows)
    ? schedule.upcomingWindows.filter((value) => typeof value === "string").slice(0, 4)
    : [];
}

function scheduleModeLabel(mode: string | null): string {
  const normalized = mode?.trim().toUpperCase() ?? "";
  if (!normalized) return "待命";
  return SCHEDULE_MODE_LABELS[normalized] ?? "待核验";
}

function wakeStatusLabel(status: string): string {
  return WAKE_STATUS_LABELS[status] ?? "待核验";
}

export function WorkbenchSchedulePanel({
  schedule,
  courseName,
  courseBound,
  openIncidentCount,
  onInspectPlan
}: WorkbenchSchedulePanelProps) {
  const windows = safeWindowValues(schedule);
  const configuredOnly = schedule.state === "configured";
  const statusLabel = STATUS_LABELS[schedule.state];
  const nextWindowLabel = configuredOnly
    ? schedule.nextWindowState === "due"
      ? "计划已到期"
      : schedule.nextWindowState === "upcoming"
        ? "计划窗口"
        : WINDOW_LABELS.unavailable
    : WINDOW_LABELS[schedule.nextWindowState];
  const worker = schedule.latestWake;
  const zeroWrite = worker?.zeroWrite === true;
  const incidentCount = Number.isSafeInteger(openIncidentCount)
    ? Math.max(0, openIncidentCount)
    : 0;

  return (
    <section className={styles.panel} aria-labelledby="workbench-schedule-heading">
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <div className={styles.kicker}>
            <Pulse size={14} aria-hidden="true" />
            周期运行概览
          </div>
          <div className={styles.titleLine}>
            <h2 id="workbench-schedule-heading">周期运行</h2>
            <span className={styles.status} data-state={schedule.state}>
              <span className={styles.statusDot} aria-hidden="true" />
              {statusLabel}
            </span>
          </div>
          <p className={styles.scope}>
            {courseName ? `${courseName} · ` : courseBound ? "已绑定课程 · " : "课程名称待核验 · "}
            只读运行窗口
          </p>
        </div>
        <div className={styles.lockMark} title="课程平台写入保持关闭">
          <LockKey size={18} aria-hidden="true" />
          <span>写入关闭</span>
        </div>
      </header>

      {configuredOnly ? (
        <p className={styles.activationNote} role="status">
          宿主定时唤醒尚未验证；以下仅为内部计划窗口。
        </p>
      ) : null}

      <dl className={styles.facts} aria-label="周期运行事实">
        <div>
          <dt><Clock size={14} aria-hidden="true" />有效周期</dt>
          <dd>{schedule.intervalMinutes ? `每 ${schedule.intervalMinutes} 分钟` : "不可用"}</dd>
        </div>
        <div>
          <dt><ShieldCheck size={14} aria-hidden="true" />模式</dt>
          <dd>{scheduleModeLabel(schedule.mode)}</dd>
        </div>
        <div>
          <dt><CalendarBlank size={14} aria-hidden="true" />下一窗口</dt>
          <dd data-state={schedule.nextWindowState}>
            <span>{nextWindowLabel}</span>
            <time dateTime={schedule.nextWindowAt ?? undefined}>
              {formatDate(schedule.nextWindowAt, schedule.timeZone)}
            </time>
          </dd>
        </div>
        <div>
          <dt><Clock size={14} aria-hidden="true" />时区</dt>
          <dd>{schedule.timeZone || "—"}</dd>
        </div>
      </dl>

      <div className={styles.windowSection}>
        <div className={styles.sectionHeading}>
          <div>
            <span className={styles.sectionKicker}>周期窗口</span>
            <h3>{configuredOnly ? "接下来四个计划窗口" : "接下来四个窗口"}</h3>
          </div>
          <span className={styles.slotCount}>{windows.length}/4</span>
        </div>
        {windows.length ? (
          <ol className={styles.windowList} aria-label="即将到来的周期窗口">
            {windows.map((windowAt, index) => {
              const isFirst = index === 0;
              const label = configuredOnly
                ? isFirst
                  ? schedule.nextWindowState === "due"
                    ? "计划到期"
                    : "计划窗口"
                  : `计划 ${index + 1}`
                : isFirst
                  ? schedule.nextWindowState === "due"
                    ? "当前到期"
                    : "下一轮"
                  : `后续 ${index + 1}`;
              return (
                <li className={styles.windowRow} data-current={isFirst} key={`${windowAt}-${index}`}>
                  <span className={styles.windowIndex}>{String(index + 1).padStart(2, "0")}</span>
                  <span className={styles.windowName}>{label}</span>
                  <time dateTime={windowAt}>{formatDate(windowAt, schedule.timeZone)}</time>
                  {isFirst ? <span className={styles.windowState}>{nextWindowLabel}</span> : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className={styles.empty}>当前没有可确认的周期窗口。</p>
        )}
      </div>

      <div className={styles.receipt} aria-label="最近一次运行回执">
        <div className={styles.receiptIcon} aria-hidden="true">
          <Pulse size={16} />
        </div>
        <div className={styles.receiptBody}>
          <span>最近一次运行回执</span>
          {worker ? (
            <strong>{wakeStatusLabel(worker.status)} · {formatDate(worker.observedAt, schedule.timeZone)}</strong>
          ) : (
            <strong>暂无本地或宿主回执</strong>
          )}
        </div>
        <span className={styles.zeroWrite} data-safe={zeroWrite}>
          {zeroWrite ? <CheckCircle size={14} aria-hidden="true" /> : <Warning size={14} aria-hidden="true" />}
          {zeroWrite ? "已写入 0 条" : "需核对"}
        </span>
      </div>

      {incidentCount > 0 ? (
        <div className={styles.incident} role="status">
          <Warning size={16} aria-hidden="true" />
          <span>有 {incidentCount} 项开放异常待复核</span>
        </div>
      ) : null}

      <div className={styles.flow} aria-label="周期运行流程">
        <span>定时唤醒</span>
        <ArrowRight size={13} aria-hidden="true" />
        <span>重复唤醒保护</span>
        <ArrowRight size={13} aria-hidden="true" />
        <span>完整巡检</span>
        <ArrowRight size={13} aria-hidden="true" />
        <span>证据记录</span>
        <ArrowRight size={13} aria-hidden="true" />
        <span>异常回流</span>
      </div>

      <footer className={styles.footer}>
        <button type="button" className={styles.planButton} onClick={onInspectPlan}>
          <ListChecks size={16} aria-hidden="true" />
          用计划模式检查本周期
        </button>
        <Link className={styles.policyLink} href="/autonomy/policy">
          查看治理边界
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </footer>
      <p className={styles.boundary}>
        <LockKey size={13} aria-hidden="true" />
        此处只读，不修改调度或发布权限 · 课程平台写入保持关闭
      </p>
    </section>
  );
}
