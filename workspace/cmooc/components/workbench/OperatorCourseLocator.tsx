"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type SyntheticEvent
} from "react";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import type { OperatorCourseLocator as OperatorCourseLocatorResult } from "@/lib/workbench/operator-locator";
import styles from "./Workbench.module.css";

function isLocatorResult(value: unknown): value is OperatorCourseLocatorResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<OperatorCourseLocatorResult>;
  return (
    record.schemaVersion === "cmooc.operator-course-locator.v1" &&
    record.operatorOnly === true &&
    record.containsForumText === true &&
    record.containsIdentity === true &&
    Boolean(record.course) &&
    Array.isArray(record.items)
  );
}

export function OperatorCourseLocator({
  courseAlias,
  courseName,
  runId = null,
  snapshotId = null
}: {
  courseAlias: string | null;
  courseName: string | null;
  runId?: string | null;
  snapshotId?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<OperatorCourseLocatorResult | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [copiedAccount, setCopiedAccount] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setQuery("");
    setResult(null);
    setState("idle");
    setCopiedAccount(null);
  }, [courseAlias]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const load = async (nextQuery: string) => {
    if (!courseAlias || state === "loading") return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setState("loading");
    setCopiedAccount(null);
    try {
      const response = await fetch("/api/workbench/operator-locator", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseAlias,
          query: nextQuery.trim(),
          ...(runId ? { runId } : {}),
          ...(snapshotId ? { snapshotId } : {})
        }),
        signal: controller.signal
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !isLocatorResult(body)) {
        throw new Error("operator_locator_unavailable");
      }
      setResult(body);
      setState("ready");
    } catch (error) {
      if (controller.signal.aborted) return;
      setResult(null);
      setState("error");
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  };

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open && state === "idle" && courseAlias) {
      void load("");
    }
  };

  const onSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void load(query);
  };

  const copyAccount = async (accountName: string) => {
    try {
      await navigator.clipboard.writeText(accountName);
      setCopiedAccount(accountName);
    } catch {
      setCopiedAccount(null);
    }
  };

  return (
    <details className={styles.operatorLocator} onToggle={onToggle}>
      <summary>
        <span>
          <strong>课程内容与账号</strong>
          <small>仅运营界面</small>
        </span>
        <ArrowRight size={13} aria-hidden="true" />
      </summary>
      <div className={styles.operatorLocatorBody}>
        <p className={styles.operatorLocatorCourse}>
          {courseName ?? result?.course.name ?? "课程名称待核验"}
        </p>
        {!courseAlias ? (
          <p className={styles.operatorLocatorState}>当前尚未绑定可定位的课程。</p>
        ) : (
          <>
            <form className={styles.operatorLocatorSearch} onSubmit={onSearch}>
              <label htmlFor="operator-course-locator-query" className="sr-only">
                查找帖子、正文或账号
              </label>
              <MagnifyingGlass size={14} aria-hidden="true" />
              <input
                id="operator-course-locator-query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="查找帖子、正文或账号"
                maxLength={80}
                autoComplete="off"
              />
              <button type="submit" disabled={state === "loading"}>
                {state === "loading" ? "查找中" : "查找"}
              </button>
            </form>
            <div className={styles.operatorLocatorResults} aria-live="polite">
              {state === "loading" ? (
                <p className={styles.operatorLocatorState}>正在读取已同步的课程内容…</p>
              ) : state === "error" ? (
                <p className={styles.operatorLocatorState}>暂时无法读取，请稍后重试。</p>
              ) : result?.items.length ? (
                result.items.map((item) => (
                  <article className={styles.operatorLocatorItem} key={item.postRef}>
                    <header>
                      <strong>{item.title}</strong>
                      <span>{item.replyCount} 条回复</span>
                    </header>
                    <p>{item.preview}</p>
                    <div className={styles.operatorLocatorIdentity}>
                      <span>{item.author.displayName}</span>
                      <code>@{item.author.accountName}</code>
                      <button
                        type="button"
                        onClick={() => void copyAccount(item.author.accountName)}
                      >
                        {copiedAccount === item.author.accountName ? "已复制" : "复制账号"}
                      </button>
                    </div>
                    <details className={styles.operatorLocatorContent}>
                      <summary>查看内容</summary>
                      <p>{item.content}</p>
                    </details>
                    {item.sourceUrl ? (
                      <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                        打开原帖 <ArrowRight size={12} aria-hidden="true" />
                      </a>
                    ) : null}
                  </article>
                ))
              ) : state === "ready" ? (
                <p className={styles.operatorLocatorState}>没有找到匹配的课程帖子。</p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </details>
  );
}

export function OperatorReplyTargetCard({
  courseAlias,
  runId
}: {
  courseAlias: string | null;
  runId: string;
}) {
  const [result, setResult] = useState<OperatorCourseLocatorResult | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (!courseAlias) {
      setState("ready");
      setResult(null);
      return;
    }
    const controller = new AbortController();
    setState("loading");
    void fetch("/api/workbench/operator-locator", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courseAlias, runId, query: "" }),
      signal: controller.signal
    })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok || !isLocatorResult(body)) {
          throw new Error("operator_reply_target_unavailable");
        }
        setResult(body);
        setState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("error");
      });
    return () => controller.abort();
  }, [courseAlias, runId]);

  if (!courseAlias) {
    return (
      <section className={styles.operatorReplyTarget} data-status="unbound">
        <span>回复目标</span>
        <strong>这个任务没有绑定课程快照</strong>
        <p>答复中的候选编号不能作为运营定位信息。请从当前课程快照新建任务。</p>
      </section>
    );
  }
  if (state === "loading") {
    return (
      <section className={styles.operatorReplyTarget} data-status="loading" aria-live="polite">
        <span>回复目标</span>
        <strong>正在解析原帖与作者…</strong>
      </section>
    );
  }
  const target = result?.replyTarget ?? null;
  if (state === "error") {
    return (
      <section className={styles.operatorReplyTarget} data-status="error">
        <span>回复目标</span>
        <strong>暂时无法读取运营定位信息</strong>
      </section>
    );
  }
  if (!target || target.status === "unbound") {
    return (
      <section className={styles.operatorReplyTarget} data-status="unbound">
        <span>回复目标 · 未绑定</span>
        <strong>这是通用分析，不是可执行的课程回复任务</strong>
        <p>系统没有找到唯一的课程决定→原帖证据链，所以不会把“候选①②③”伪装成真实目标。新任务将默认绑定最新课程快照。</p>
      </section>
    );
  }
  return (
    <section className={styles.operatorReplyTarget} data-status="resolved">
      <div className={styles.operatorReplyTargetHeading}>
        <span>本次回复目标 · 运营者视图</span>
        <strong>{target.title}</strong>
      </div>
      <p>{target.preview}</p>
      <div className={styles.operatorLocatorIdentity}>
        <span>{target.author.displayName}</span>
        <code>@{target.author.accountName}</code>
      </div>
      <details className={styles.operatorLocatorContent}>
        <summary>展开原帖内容</summary>
        <p>{target.content}</p>
      </details>
      {target.sourceUrl ? (
        <a href={target.sourceUrl} target="_blank" rel="noreferrer">
          打开原帖 <ArrowRight size={12} aria-hidden="true" />
        </a>
      ) : null}
      <small>帖子与身份只在运营界面解析；智能体工具和持久回执仍使用匿名引用。</small>
    </section>
  );
}
