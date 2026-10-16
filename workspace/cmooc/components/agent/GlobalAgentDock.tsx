"use client";

import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleNotch } from "@phosphor-icons/react/dist/csr/CircleNotch";
import { MagicWand } from "@phosphor-icons/react/dist/csr/MagicWand";
import { Paperclip } from "@phosphor-icons/react/dist/csr/Paperclip";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { X } from "@phosphor-icons/react/dist/csr/X";
import type {
  AgentContextAttachment,
  AgentJournalEntry,
  AgentSessionPhase
} from "@/lib/agent/client-session";
import { WORKBENCH_PROMPT_MAX_LENGTH } from "@/lib/workbench/contracts";
import styles from "./GlobalAgentDock.module.css";

export type GlobalAgentDockProps = {
  attachment: AgentContextAttachment | null;
  clearAttachment: () => void;
  draft: string;
  error: string;
  executeCommand: (command: string) => Promise<boolean>;
  expanded: boolean;
  isExecuting: boolean;
  journal: AgentJournalEntry[];
  phase: AgentSessionPhase;
  setDraft: (draft: string) => void;
  setExpanded: (expanded: boolean) => void;
  summary: string;
};

const PHASE_LABELS: Record<AgentSessionPhase, string> = {
  idle: "就绪",
  planning: "理解任务",
  running: "正在执行",
  completed: "已完成",
  failed: "需要处理"
};

function JournalStatusIcon({ status }: { status: AgentJournalEntry["status"] }) {
  if (status === "completed") {
    return <CheckCircle size={15} weight="fill" aria-hidden="true" />;
  }
  if (status === "failed") {
    return <WarningCircle size={15} weight="fill" aria-hidden="true" />;
  }
  if (status === "running") {
    return <CircleNotch className={styles.spinner} size={15} aria-hidden="true" />;
  }
  return <span className={styles.queuedDot} aria-hidden="true" />;
}

export function GlobalAgentDock({
  attachment,
  clearAttachment,
  draft,
  error,
  executeCommand,
  expanded,
  isExecuting,
  journal,
  phase,
  setDraft,
  setExpanded,
  summary
}: GlobalAgentDockProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const journalRef = useRef<HTMLDetailsElement>(null);
  const latestJournal = journal.slice(-8);
  const latestCommandId = latestJournal.at(-1)?.commandId ?? "";

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && expanded) {
        event.preventDefault();
        setExpanded(false);
        return;
      }
      if (event.altKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setExpanded(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [expanded, setExpanded]);

  useEffect(() => {
    if (isExecuting && journalRef.current) journalRef.current.open = true;
  }, [isExecuting, latestCommandId]);

  const openDock = () => {
    setExpanded(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const command = draft.trim();
    if (!command || isExecuting) return;
    void executeCommand(command);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  if (!expanded) {
    return (
      <aside className={styles.dock} aria-label="全局智能操作">
        <button
          className={styles.launcher}
          type="button"
          onClick={openDock}
          aria-label={`打开智能操作台，当前${PHASE_LABELS[phase]}`}
          aria-controls="global-agent-panel"
          aria-expanded="false"
          aria-keyshortcuts="Alt+A"
        >
          <MagicWand size={18} weight="duotone" aria-hidden="true" />
          <span>智能操作</span>
          <span className={styles.launcherStatus} data-phase={phase} aria-hidden="true" />
        </button>
      </aside>
    );
  }

  return (
    <aside className={styles.dock} aria-label="全局智能操作">
      <section id="global-agent-panel" className={styles.panel} aria-labelledby="agent-dock-title">
        <header className={styles.header}>
          <div className={styles.identity}>
            <span className={styles.mark} aria-hidden="true">
              <MagicWand size={17} weight="duotone" />
            </span>
            <div>
              <h2 id="agent-dock-title">智能操作台</h2>
              <p data-phase={phase} aria-live="polite">
                {isExecuting ? <CircleNotch className={styles.spinner} size={12} aria-hidden="true" /> : null}
                {PHASE_LABELS[phase]}
              </p>
            </div>
          </div>
          <button
            className={styles.iconButton}
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="收起智能操作台"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.body}>
          {attachment ? (
            <div className={styles.attachment}>
              <Paperclip size={14} aria-hidden="true" />
              <span title={attachment.title}>{attachment.title}</span>
              <button type="button" onClick={clearAttachment} aria-label="移除当前上下文">
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ) : null}

          {error ? (
            <div className={styles.feedback} data-tone="error" role="alert">
              <WarningCircle size={16} weight="fill" aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : summary ? (
            <div className={styles.feedback} data-tone="success" aria-live="polite">
              <CheckCircle size={16} weight="fill" aria-hidden="true" />
              <span>{summary}</span>
            </div>
          ) : null}

          {latestJournal.length > 0 ? (
            <details ref={journalRef} className={styles.journal}>
              <summary>
                <span>{isExecuting ? "正在执行" : "最近动作"}</span>
                <span>{latestJournal.filter((entry) => entry.status === "completed").length}/{latestJournal.length}</span>
              </summary>
              <ol>
                {latestJournal.map((entry) => (
                  <li key={`${entry.commandId}:${entry.id}`} data-status={entry.status}>
                    <JournalStatusIcon status={entry.status} />
                    <span>
                      <strong>{entry.label}</strong>
                      {entry.summary ? <small>{entry.summary}</small> : null}
                    </span>
                  </li>
                ))}
              </ol>
            </details>
          ) : (
            <p className={styles.emptyCopy}>
              直接描述目标。我可以跳转页面、操作当前视图，也可以把复杂任务交给控制台继续完成。
            </p>
          )}
        </div>

        <form className={styles.composer} onSubmit={submit}>
          <label className={styles.srOnly} htmlFor="global-agent-command">
            输入自然语言命令
          </label>
          <textarea
            ref={inputRef}
            id="global-agent-command"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="告诉我你想去哪里，或要完成什么…"
            rows={3}
            maxLength={WORKBENCH_PROMPT_MAX_LENGTH}
            disabled={isExecuting}
          />
          <div className={styles.composerFooter}>
            <span>{isExecuting ? "动作按顺序自动执行" : "Ctrl ↵ 发送 · Alt A 唤起"}</span>
            <button
              className={styles.sendButton}
              type="submit"
              disabled={isExecuting || !draft.trim()}
              aria-label="执行命令"
            >
              {isExecuting ? (
                <CircleNotch className={styles.spinner} size={18} aria-hidden="true" />
              ) : (
                <ArrowUp size={18} weight="bold" aria-hidden="true" />
              )}
            </button>
          </div>
        </form>

        <footer className={styles.boundary}>
          本机操作自动执行 · 真实课程发布保持锁定
        </footer>
      </section>
    </aside>
  );
}
