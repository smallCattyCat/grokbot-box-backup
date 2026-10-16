"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { GlassCard } from "@/components/ui/glass-card";
import { StatusPill } from "@/components/ui/status-pill";
import { registerPageBridge } from "@/lib/agent/page-bridge";
import {
  PLATFORM_PAGE_ACTION_CAPABILITIES,
  buildPlatformReadinessBridgeState,
  executePlatformReadinessAction,
  safePlatformReadinessSuccess,
  type PlatformReadinessBridgeSnapshot,
  type PlatformReadinessSuccess
} from "@/lib/agent/platform-page-actions";
import type {
  CmoocApiAssistKind,
  CmoocDetailObservation,
  CmoocUiReadinessReceipt
} from "@/lib/platform-readiness/cmooc-ui-readiness";

const IDLE_MESSAGE =
  "输入课程地址后可运行一次只读诊断；诊断不会创建或修改课程清单。";
const RUNNING_MESSAGE =
  "正在启动只读诊断，并核验课程壳、分区、卡片与零写边界…";
const FAILED_MESSAGE =
  "平台诊断未完成。请检查课程入口和当前会话后重试。";
const UNAVAILABLE_MESSAGE =
  "平台诊断暂时不可用。请稍后重试；系统没有展示底层错误信息。";
const COMPLETED_MESSAGE =
  "只读诊断已完成，结果仅保留去正文回执。";

const normalizationLabels: Record<
  CmoocUiReadinessReceipt["normalizationSource"],
  string
> = {
  exact_url: "浏览器原始地址",
  markdown_link: "已从 Markdown 链接提取",
  embedded_url: "已从混合文本提取",
  course_id_recovery: "已按课程标识恢复"
};

const detailLabels: Record<CmoocDetailObservation, string> = {
  detail_observed: "详情界面可达",
  not_available_public_session: "公开会话未进入详情",
  not_attempted_read_only_boundary: "只读边界未进入详情",
  interaction_no_transition: "卡片未产生页面切换",
  interaction_failed: "卡片交互未完成",
  no_cards: "当前分区没有卡片"
};

const apiKindLabels: Record<CmoocApiAssistKind, string> = {
  auth_check: "会话核验",
  course_columns: "课程栏目",
  sketch_page: "卡片列表",
  sketch_detail: "帖子详情",
  comment_list: "回复列表"
};

function shortHash(value: string) {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function statusLabel(
  status: CmoocUiReadinessReceipt["status"]
) {
  if (status === "overview_ready") return "真实概要已就绪";
  if (status === "shell_only") return "课程壳已定位";
  return "预检已阻断";
}

export function PlatformReadinessPanel() {
  const [targetInput, setTargetInput] = useState("");
  const [pending, setPending] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [message, setMessage] = useState(IDLE_MESSAGE);
  const [result, setResult] =
    useState<PlatformReadinessSuccess | null>(null);
  const pendingRef = useRef(false);
  const targetInputRef = useRef("");
  const bridgeSnapshotRef = useRef<PlatformReadinessBridgeSnapshot>({
    phase: "idle",
    revision: 0,
    message: IDLE_MESSAGE,
    result: null
  });

  const updateBridgeSnapshot = useCallback(
    (
      value: Omit<PlatformReadinessBridgeSnapshot, "revision">
    ): PlatformReadinessBridgeSnapshot => {
      const next: PlatformReadinessBridgeSnapshot = {
        ...value,
        revision: bridgeSnapshotRef.current.revision + 1
      };
      bridgeSnapshotRef.current = next;
      return next;
    },
    []
  );

  const runReadiness = useCallback(async (
    rawInput: string
  ): Promise<PlatformReadinessBridgeSnapshot> => {
    const input = rawInput.trim();
    if (!input) {
      const failed = updateBridgeSnapshot({
        phase: "failed",
        message: FAILED_MESSAGE,
        result: {
          ok: false,
          errorCode: "PLATFORM_TARGET_REQUIRED"
        }
      });
      setHasError(true);
      setMessage(FAILED_MESSAGE);
      return failed;
    }
    if (pendingRef.current) return bridgeSnapshotRef.current;
    pendingRef.current = true;
    setPending(true);
    setHasError(false);
    setResult(null);
    setMessage(RUNNING_MESSAGE);
    updateBridgeSnapshot({
      phase: "running",
      message: RUNNING_MESSAGE,
      result: null
    });
    try {
      const response = await fetch("/api/platform/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetInput: input })
      });
      const payload = await response.json().catch(() => null);
      const safeResult = response.ok
        ? safePlatformReadinessSuccess(payload)
        : null;
      if (!safeResult) {
        const failed = updateBridgeSnapshot({
          phase: "failed",
          message: FAILED_MESSAGE,
          result: {
            ok: false,
            errorCode: "PLATFORM_READINESS_FAILED"
          }
        });
        setHasError(true);
        setMessage(FAILED_MESSAGE);
        return failed;
      }
      setResult(safeResult);
      setTargetInput("");
      targetInputRef.current = "";
      setMessage(COMPLETED_MESSAGE);
      return updateBridgeSnapshot({
        phase: "completed",
        message: COMPLETED_MESSAGE,
        result: safeResult
      });
    } catch {
      const failed = updateBridgeSnapshot({
        phase: "failed",
        message: UNAVAILABLE_MESSAGE,
        result: {
          ok: false,
          errorCode: "PLATFORM_READINESS_UNAVAILABLE"
        }
      });
      setHasError(true);
      setMessage(UNAVAILABLE_MESSAGE);
      return failed;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [updateBridgeSnapshot]);

  useEffect(() => registerPageBridge({
    routeId: "platform",
    capabilities: PLATFORM_PAGE_ACTION_CAPABILITIES,
    readState: () =>
      buildPlatformReadinessBridgeState(
        bridgeSnapshotRef.current
      ),
    execute: (action) => {
      if (action.type !== "platform.inspect_readiness") {
        return {
          status: "unsupported",
          summary: "当前平台页面不支持此动作。",
          retryable: false,
          errorCode: "PLATFORM_ACTION_UNSUPPORTED"
        };
      }
      return executePlatformReadinessAction({
        action,
        currentTargetInput: targetInputRef.current,
        busy: pendingRef.current,
        runReadiness
      });
    }
  }), [runReadiness]);

  const receipt = result?.receipt ?? null;
  const overviewReady = receipt?.status === "overview_ready";

  return (
    <div className="space-y-5">
      <GlassCard tone="highlight">
        <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
          <section aria-busy={pending}>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill
                label={pending ? "正在只读诊断" : "真实界面诊断"}
                tone={pending ? "amber" : "cyan"}
                pulse={pending}
              />
              <StatusPill label="只读边界" tone="emerald" />
              <StatusPill label="发布硬锁" tone="muted" />
            </div>
            <h2 className="mt-4 text-xl font-semibold text-slate-50">
              执行一次只读课程诊断
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
              可输入浏览器地址、Markdown 链接或包含链接的文字。系统只从中提取允许入口用于本次诊断，不保存或显示规范化地址，也不会修改课程清单。
            </p>
            <label
              htmlFor="platform-target"
              className="mt-5 block text-sm font-semibold text-slate-200"
            >
              课程地址
            </label>
            <textarea
              id="platform-target"
              value={targetInput}
              onChange={(event) => {
                const value = event.target.value;
                targetInputRef.current = value;
                setTargetInput(value);
                setResult(null);
                setHasError(false);
                setMessage(IDLE_MESSAGE);
                updateBridgeSnapshot({
                  phase: "idle",
                  message: IDLE_MESSAGE,
                  result: null
                });
              }}
              rows={3}
              spellCheck={false}
              placeholder="粘贴 cMOOC 课程地址或包含该地址的文字"
              className="mt-2 w-full resize-y rounded-md border border-slate-700 bg-slate-950/70 p-3 font-mono text-sm leading-6 text-slate-100 outline-none transition focus:border-cyan-400"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending || !targetInput.trim()}
                onClick={() =>
                  void runReadiness(targetInputRef.current)
                }
                className="rounded-md bg-cyan-400 px-4 py-2 text-sm font-semibold text-black transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {pending ? "正在诊断…" : "运行只读诊断"}
              </button>
            </div>
            <p
              role={hasError ? "alert" : "status"}
              aria-live={hasError ? "assertive" : "polite"}
              className={`mt-3 text-xs leading-5 ${
                hasError ? "text-amber-200" : "text-slate-400"
              }`}
            >
              {message}
            </p>
          </section>

          <aside className="rounded-md border border-slate-800 bg-slate-950/45 p-4">
            <p className="text-sm font-semibold text-slate-100">
              现场防错闸门
            </p>
            <ol className="mt-4 space-y-3 text-sm">
              {[
                ["1", "入口归一化", "拒绝混合链接造成的错误路径"],
                ["2", "目标复核", "核验来源与课程路径"],
                ["3", "真实感知", "只读识别课程壳、分区与卡片"],
                ["4", "能力分级", "概要可读不冒充详情可读"],
                ["5", "零写回执", "不触发发布、加入课程或通知"]
              ].map(([index, title, detail]) => (
                <li key={index} className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-cyan-400/40 text-xs font-semibold text-cyan-200">
                    {index}
                  </span>
                  <span>
                    <b className="block text-slate-200">{title}</b>
                    <span className="mt-0.5 block text-xs leading-5 text-slate-500">
                      {detail}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </aside>
        </div>
      </GlassCard>

      {receipt ? (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <GlassCard>
              <p className="text-xs font-semibold text-slate-500">
                入口
              </p>
              <p className="mt-2 text-sm font-semibold text-slate-100">
                {normalizationLabels[receipt.normalizationSource]}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {receipt.inputWasNormalized
                  ? "已自动校准"
                  : "无需改写"}
              </p>
            </GlassCard>
            <GlassCard>
              <p className="text-xs font-semibold text-slate-500">
                真实结构
              </p>
              <p className="mt-2 text-2xl font-black text-cyan-200">
                {receipt.categoryTabCount} 个分区
              </p>
              <p className="mt-1 text-xs text-slate-500">
                当前可见 {receipt.visibleCardCount} 张卡片
              </p>
            </GlassCard>
            <GlassCard>
              <p className="text-xs font-semibold text-slate-500">
                会话能力
              </p>
              <p className="mt-2 text-sm font-semibold text-slate-100">
                {detailLabels[receipt.detailObservation]}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {receipt.sessionBoundary ===
                "public_unauthenticated"
                  ? "公开未登录会话"
                  : "未出现登录控件"}
              </p>
            </GlassCard>
            <GlassCard>
              <p className="text-xs font-semibold text-slate-500">
                写入边界
              </p>
              <p className="mt-2 text-2xl font-black text-emerald-200">
                0 次写入
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {receipt.blockedWriteRequestCount} 个非只读请求被阻断
              </p>
            </GlassCard>
          </section>

          <GlassCard
            tone={overviewReady ? "success" : "default"}
          >
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex flex-wrap gap-2">
                  <StatusPill
                    label={statusLabel(receipt.status)}
                    tone={overviewReady ? "emerald" : "amber"}
                  />
                  <StatusPill
                    label={
                      receipt.browserRuntime ===
                      "playwright_chromium"
                        ? "确定性浏览器"
                        : "系统浏览器后备"
                    }
                    tone="cyan"
                  />
                  <StatusPill
                    label="结构证据 · 非教育成效"
                    tone="muted"
                  />
                </div>
                <h2 className="mt-3 text-lg font-semibold text-slate-50">
                  真实界面只读诊断回执
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
                  这份回执证明当前时点的课程界面结构可达，并区分“课程概要可读”与“帖子详情可读”。它不会把卡片存在解释成语义候选，也不会把只读运行解释成干预效果。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  href="/review/live"
                  className="rounded-md bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-white"
                >
                  进入长期运行审核
                </Link>
              </div>
            </div>

            <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-md border border-slate-800 bg-slate-950/30 p-3">
                <dt className="text-xs text-slate-500">只读请求</dt>
                <dd className="mt-1 font-semibold text-slate-200">
                  {receipt.allowedGetOrHeadCount} 次普通读取 ·{" "}
                  {receipt.allowedSemanticReadPostCount} 次语义读取
                </dd>
              </div>
              <div className="rounded-md border border-slate-800 bg-slate-950/30 p-3">
                <dt className="text-xs text-slate-500">辅助读取痕迹</dt>
                <dd className="mt-1 font-semibold text-slate-200">
                  {receipt.apiAssistKinds.length > 0
                    ? receipt.apiAssistKinds
                        .map((kind) => apiKindLabels[kind])
                        .join("、")
                    : "未观察到"}
                </dd>
              </div>
              <div className="rounded-md border border-slate-800 bg-slate-950/30 p-3">
                <dt className="text-xs text-slate-500">观察时间</dt>
                <dd className="mt-1 font-semibold text-slate-200">
                  {new Date(receipt.observedAt).toLocaleString(
                    "zh-CN",
                    { hour12: false }
                  )}
                </dd>
              </div>
              <div className="rounded-md border border-slate-800 bg-slate-950/30 p-3">
                <dt className="text-xs text-slate-500">去正文证据</dt>
                <dd className="mt-1 break-all font-mono text-xs text-slate-300">
                  {shortHash(result?.evidenceHash ?? "")}
                </dd>
              </div>
            </dl>
          </GlassCard>
        </>
      ) : null}
    </div>
  );
}
