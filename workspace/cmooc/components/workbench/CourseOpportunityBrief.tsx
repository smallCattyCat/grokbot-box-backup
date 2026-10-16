"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { ClockCountdown } from "@phosphor-icons/react/dist/csr/ClockCountdown";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { X } from "@phosphor-icons/react/dist/csr/X";
import type {
  CourseOpportunityBrief,
  CourseOpportunityBriefItem
} from "@/lib/workbench/course-opportunity-brief";
import type { CourseEvidenceWorkspace } from "@/lib/workbench/course-evidence-workspace";
import { OpportunityEvidenceWorkspace } from "@/components/workbench/opportunity-canvas/OpportunityEvidenceWorkspace";
import styles from "./Workbench.module.css";

type BriefOpenHandler = (
  item: CourseOpportunityBriefItem,
  trigger: HTMLButtonElement
) => void;

function briefTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间待核验";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function itemTone(item: CourseOpportunityBriefItem): "attention" | "ready" | "quiet" {
  if (item.priority === "high") return "attention";
  if (item.kind === "intervention_opportunity" || item.kind === "outcome_due") {
    return "ready";
  }
  return "quiet";
}

export function TodayBriefTrigger({
  brief,
  onOpen
}: {
  brief: CourseOpportunityBrief;
  onOpen: BriefOpenHandler;
}) {
  const firstItem = brief.items[0];
  if (brief.status !== "ready" || !firstItem) {
    return (
      <div className={styles.todayBriefUnavailable} role="status">
        <span className={styles.todayBriefSignal} aria-hidden="true" />
        <span>
          <strong>{brief.headline}</strong>
          <small>{brief.summaryLine}</small>
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={styles.todayBriefTrigger}
      data-tone={itemTone(firstItem)}
      onClick={(event: ReactMouseEvent<HTMLButtonElement>) =>
        onOpen(firstItem, event.currentTarget)
      }
      aria-haspopup="dialog"
    >
      <span className={styles.todayBriefSignal} aria-hidden="true" />
      <span>
        <strong>{brief.headline}</strong>
        <small>{brief.summaryLine}</small>
      </span>
      <ArrowRight size={15} aria-hidden="true" />
    </button>
  );
}

export function ConversationBrief({
  brief,
  onOpen
}: {
  brief: CourseOpportunityBrief;
  onOpen: BriefOpenHandler;
}) {
  if (brief.status !== "ready" || brief.items.length === 0) return null;

  return (
    <article className={styles.conversationBrief} aria-labelledby="conversation-brief-heading">
      <header>
        <div>
          <span>课程简报</span>
          <h2 id="conversation-brief-heading">{brief.headline}</h2>
        </div>
        <time dateTime={brief.anchor?.worldAsOf}>
          截至 {briefTime(brief.anchor?.worldAsOf ?? "")}
        </time>
      </header>
      <div className={styles.conversationBriefList}>
        {brief.items.slice(0, 3).map((item) => (
          <button
            key={item.id}
            type="button"
            data-tone={itemTone(item)}
            onClick={(event: ReactMouseEvent<HTMLButtonElement>) =>
              onOpen(item, event.currentTarget)
            }
            aria-haspopup="dialog"
          >
            <span>{item.stateLabel}</span>
            <strong>{item.headline}</strong>
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        ))}
      </div>
    </article>
  );
}

export function OpportunityCanvas({
  brief,
  evidenceWorkspace,
  selectedItemId,
  decisionInspector,
  onSelect,
  onClose,
  onHandoff
}: {
  brief: CourseOpportunityBrief;
  evidenceWorkspace?: CourseEvidenceWorkspace;
  selectedItemId: string;
  decisionInspector?: ReactNode;
  onSelect: (item: CourseOpportunityBriefItem) => void;
  onClose: () => void;
  onHandoff: (item: CourseOpportunityBriefItem) => void;
}) {
  const canvasRef = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const detailRef = useRef<HTMLElement | null>(null);
  const wasModalRef = useRef(false);
  const [isModal, setIsModal] = useState(false);
  const item =
    brief.items.find((candidate) => candidate.id === selectedItemId) ??
    brief.items[0] ??
    null;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const syncMode = () => setIsModal(media.matches);
    syncMode();
    media.addEventListener("change", syncMode);
    return () => media.removeEventListener("change", syncMode);
  }, []);

  useEffect(() => {
    const enteringModal = isModal && !wasModalRef.current;
    wasModalRef.current = isModal;
    if (enteringModal) {
      window.requestAnimationFrame(() => closeRef.current?.focus());
    }
  }, [isModal]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !isModal) return;
      const focusable = Array.from(
        canvas.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (!canvas.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isModal, onClose]);

  useEffect(() => {
    const detail = detailRef.current;
    if (detail) detail.scrollTop = 0;
    const selected = Array.from(
      canvasRef.current?.querySelectorAll<HTMLElement>("[data-brief-item-id]") ?? []
    ).find((node) => node.dataset.briefItemId === selectedItemId);
    selected?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
  }, [selectedItemId]);

  useEffect(() => {
    if (!isModal) return;
    const canvas = canvasRef.current;
    const backdrop = backdropRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";

    const background = Array.from(parent.children).filter(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node !== canvas && node !== backdrop
    );
    const previous = background.map((node) => ({
      node,
      inert: node.inert,
      ariaHidden: node.getAttribute("aria-hidden")
    }));
    for (const node of background) {
      node.inert = true;
      node.setAttribute("aria-hidden", "true");
    }

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.overscrollBehavior = previousBodyOverscroll;
      for (const entry of previous) {
        entry.node.inert = entry.inert;
        if (entry.ariaHidden === null) entry.node.removeAttribute("aria-hidden");
        else entry.node.setAttribute("aria-hidden", entry.ariaHidden);
      }
    };
  }, [isModal]);

  if (!item) return null;

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = Math.max(
      0,
      brief.items.findIndex((candidate) => candidate.id === item.id)
    );
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? brief.items.length - 1
        : event.key === "ArrowDown" || event.key === "ArrowRight"
          ? (currentIndex + 1) % brief.items.length
          : (currentIndex - 1 + brief.items.length) % brief.items.length;
    const next = brief.items[nextIndex];
    if (!next) return;
    onSelect(next);
    window.requestAnimationFrame(() =>
      document.getElementById(`brief-item-${nextIndex}`)?.focus()
    );
  };

  return (
    <>
      <button
        ref={backdropRef}
        type="button"
        className={styles.canvasBackdrop}
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        ref={canvasRef}
        className={styles.opportunityCanvas}
        role="dialog"
        aria-modal={isModal ? "true" : undefined}
        aria-labelledby="opportunity-canvas-title"
        data-tone={itemTone(item)}
      >
        <header className={styles.canvasHeader}>
          <div>
            <span>今日课程简报</span>
            <h2 id="opportunity-canvas-title">{brief.headline}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className={styles.canvasClose}
            onClick={onClose}
            aria-label="关闭课程简报"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.canvasBody}>
          <nav
            className={styles.canvasItemRail}
            aria-label="简报事项"
            onKeyDown={handleListKeyDown}
          >
            {brief.items.map((candidate, index) => (
              <button
                id={`brief-item-${index}`}
                key={candidate.id}
                data-brief-item-id={candidate.id}
                type="button"
                data-selected={candidate.id === item.id}
                data-tone={itemTone(candidate)}
                tabIndex={candidate.id === item.id ? 0 : -1}
                aria-current={candidate.id === item.id ? "true" : undefined}
                aria-controls="opportunity-canvas-detail"
                onClick={() => onSelect(candidate)}
              >
                <span>{candidate.stateLabel}</span>
                <strong>{candidate.headline}</strong>
              </button>
            ))}
          </nav>

          <article ref={detailRef} id="opportunity-canvas-detail" className={styles.canvasDetail}>
            <header>
              <div className={styles.canvasStateLine}>
                {item.priority === "high" ? (
                  <WarningCircle size={18} aria-hidden="true" />
                ) : item.kind === "outcome_due" || item.kind === "wait" ? (
                  <ClockCountdown size={18} aria-hidden="true" />
                ) : (
                  <CheckCircle size={18} aria-hidden="true" />
                )}
                <span>{item.stateLabel}</span>
                <time dateTime={item.evidenceAsOf}>{briefTime(item.evidenceAsOf)}</time>
              </div>
              <h3>{item.headline}</h3>
              <p>{item.summary}</p>
            </header>

            {decisionInspector}

            <OpportunityEvidenceWorkspace
              item={item}
              workspace={evidenceWorkspace}
              onHandoff={onHandoff}
              onViewChange={() => {
                if (detailRef.current) detailRef.current.scrollTop = 0;
              }}
            />
          </article>
        </div>

        <footer className={styles.canvasBoundary}>
          <span>只读 · 不含论坛正文与身份</span>
          <span>快照 {brief.anchor ? briefTime(brief.anchor.worldAsOf) : "待核验"}</span>
        </footer>
      </aside>
    </>
  );
}
