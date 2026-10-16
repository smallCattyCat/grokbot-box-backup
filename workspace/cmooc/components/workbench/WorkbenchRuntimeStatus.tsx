"use client";

import { useEffect, useState } from "react";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleNotch } from "@phosphor-icons/react/dist/csr/CircleNotch";
import { LockKeyOpen } from "@phosphor-icons/react/dist/csr/LockKeyOpen";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import styles from "./Workbench.module.css";

type RuntimeStatus =
  | "checking"
  | "ready"
  | "auth-required"
  | "authorizing"
  | "unavailable";

type RuntimeState = {
  status: RuntimeStatus;
  summary: string;
  canStartAuthorization: boolean;
};

const INITIAL_STATE: RuntimeState = {
  status: "checking",
  summary: "正在检查本机执行状态。",
  canStartAuthorization: false
};

function parseRuntimeState(value: unknown): RuntimeState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.status !== "ready" &&
    record.status !== "auth-required" &&
    record.status !== "authorizing" &&
    record.status !== "unavailable"
  ) return null;
  if (typeof record.summary !== "string" || record.summary.length > 160) return null;
  if (typeof record.canStartAuthorization !== "boolean") return null;
  return {
    status: record.status,
    summary: record.summary,
    canStartAuthorization: record.canStartAuthorization
  };
}

async function requestRuntimeState(
  method: "GET" | "POST",
  signal?: AbortSignal
): Promise<RuntimeState> {
  const response = await fetch("/api/workbench/runtime", {
    method,
    cache: "no-store",
    credentials: "same-origin",
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: method === "POST" ? "{}" : undefined,
    signal
  });
  const parsed = parseRuntimeState(await response.json().catch(() => null));
  if (parsed) return parsed;
  throw new Error("WORKBENCH_RUNTIME_INVALID_RESPONSE");
}

export function WorkbenchRuntimeStatus() {
  const [runtime, setRuntime] = useState<RuntimeState>(INITIAL_STATE);

  useEffect(() => {
    const controller = new AbortController();
    void requestRuntimeState("GET", controller.signal)
      .then(setRuntime)
      .catch(() => {
        if (controller.signal.aborted) return;
        setRuntime({
          status: "unavailable",
          summary: "暂时无法检查本机执行状态。",
          canStartAuthorization: true
        });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (runtime.status !== "authorizing") return;
    const controller = new AbortController();
    let timer = 0;
    let attempt = 0;
    let disposed = false;
    const poll = async () => {
      attempt += 1;
      try {
        const next = await requestRuntimeState("GET", controller.signal);
        if (disposed) return;
        if (next.status === "ready" || next.status === "unavailable") {
          setRuntime(next);
          return;
        }
        if (attempt >= 150) {
          setRuntime({
            status: "auth-required",
            summary: "本机授权尚未完成，可在完成后重新连接。",
            canStartAuthorization: true
          });
          return;
        }
      } catch {
        if (disposed || controller.signal.aborted) return;
      }
      timer = window.setTimeout(() => void poll(), 2_000);
    };
    timer = window.setTimeout(() => void poll(), 1_200);
    return () => {
      disposed = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [runtime.status]);

  const startAuthorization = async () => {
    setRuntime({
      status: "authorizing",
      summary: "正在打开本机授权页面。",
      canStartAuthorization: false
    });
    try {
      setRuntime(await requestRuntimeState("POST"));
    } catch {
      setRuntime({
        status: "unavailable",
        summary: "本机授权页面未能打开。",
        canStartAuthorization: true
      });
    }
  };

  if (runtime.status === "auth-required" || (
    runtime.status === "unavailable" && runtime.canStartAuthorization
  )) {
    return (
      <button
        type="button"
        className={styles.runtimeStatusButton}
        title={runtime.summary}
        onClick={() => void startAuthorization()}
      >
        <LockKeyOpen size={14} aria-hidden="true" />
        {runtime.status === "auth-required" ? "连接本机" : "重试连接"}
      </button>
    );
  }

  const label = runtime.status === "ready"
    ? "本机就绪"
    : runtime.status === "authorizing"
      ? "等待授权"
      : runtime.status === "unavailable"
        ? "本机不可用"
        : "检查本机";
  const Icon = runtime.status === "ready"
    ? CheckCircle
    : runtime.status === "unavailable"
      ? WarningCircle
      : CircleNotch;

  return (
    <span
      className={styles.runtimeStatus}
      data-state={runtime.status}
      title={runtime.summary}
      role="status"
      aria-live="polite"
    >
      <Icon size={14} aria-hidden="true" />
      {label}
    </span>
  );
}
