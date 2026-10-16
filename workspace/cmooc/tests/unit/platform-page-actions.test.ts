import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { CmoocUiReadinessReceipt } from "../../lib/platform-readiness/cmooc-ui-readiness";
import {
  PLATFORM_PAGE_ACTION_CAPABILITIES,
  buildPlatformReadinessBridgeState,
  executePlatformReadinessAction,
  safePlatformReadinessSuccess,
  type PlatformReadinessBridgeSnapshot
} from "../../lib/agent/platform-page-actions";

const HASH = "a".repeat(64);

function receipt(
  overrides: Partial<CmoocUiReadinessReceipt> = {}
): CmoocUiReadinessReceipt {
  return {
    schemaVersion: "cmooc.ui-readiness-receipt.v1",
    observedAt: "2026-08-11T12:00:00.000Z",
    transport: "ui_native_browser",
    targetOrigin: "https://cmooc.bnu.edu.cn",
    targetPath: "/cMOOC/course",
    targetLocatorHash: "b".repeat(64),
    normalizationSource: "exact_url",
    inputWasNormalized: false,
    browserRuntime: "playwright_chromium",
    status: "overview_ready",
    safeToDemonstrate: true,
    courseShellDetected: true,
    categoryTabCount: 7,
    visibleCardCount: 20,
    visibleCardKeys: [],
    selectedThreadKey: null,
    detailEvidenceLevel: "none",
    sessionBoundary: "public_unauthenticated",
    detailObservation: "not_available_public_session",
    apiAssistKinds: ["course_columns", "sketch_page"],
    allowedGetOrHeadCount: 18,
    allowedSemanticReadPostCount: 2,
    blockedWriteRequestCount: 3,
    blockedCrossOriginRequestCount: 4,
    requestedMutationCount: 3,
    sentMutationCount: 0,
    networkGuardActive: true,
    requestPolicy: "READ_ONLY_ENDPOINT_ALLOWLIST",
    realPublishEnabled: false,
    externalWriteAttempted: false,
    containsForumText: false,
    ...overrides
  };
}

function snapshot(
  overrides: Partial<PlatformReadinessBridgeSnapshot> = {}
): PlatformReadinessBridgeSnapshot {
  return {
    phase: "idle",
    revision: 0,
    message: "等待只读诊断",
    result: null,
    ...overrides
  };
}

test("平台桥状态只暴露去正文、零写和可扫读诊断事实", () => {
  const state = buildPlatformReadinessBridgeState(
    snapshot({
      phase: "completed",
      revision: 3,
      message: "真实课程概要已就绪",
      result: { ok: true, evidenceHash: HASH, receipt: receipt() }
    })
  );

  assert.equal(state.routeId, "platform");
  assert.equal(state.href, "/platform");
  assert.deepEqual(state.capabilities, PLATFORM_PAGE_ACTION_CAPABILITIES);
  assert.equal(state.status, "ready");
  assert.equal(state.revision, 3);
  assert.equal(state.containsForumText, false);
  assert.equal(state.externalWrites, false);
  assert.deepEqual(state.metadata, {
    phase: "completed",
    externalReadOnly: true,
    readinessStatus: "overview_ready",
    courseShellDetected: true,
    categoryTabCount: 7,
    visibleCardCount: 20,
    blockedWriteRequestCount: 3,
    sentMutationCount: 0,
    networkGuardActive: true,
    evidenceHash: HASH
  });
  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, /courseId|论坛正文|cookie|token/i);
});

test("同源 API 回包只有通过去正文和零写事实校验才能进入页面状态", () => {
  const safe = safePlatformReadinessSuccess({
    ok: true,
    evidenceHash: HASH.toUpperCase(),
    receipt: receipt()
  });
  assert.equal(safe?.evidenceHash, HASH);
  assert.equal(safe?.receipt.sentMutationCount, 0);

  for (const unsafeReceipt of [
    receipt({
      containsForumText: true
    } as unknown as Partial<CmoocUiReadinessReceipt>),
    receipt({
      externalWriteAttempted: true
    } as unknown as Partial<CmoocUiReadinessReceipt>),
    receipt({
      realPublishEnabled: true
    } as unknown as Partial<CmoocUiReadinessReceipt>),
    receipt({ sentMutationCount: 1 as 0 }),
    receipt({ networkGuardActive: false as true })
  ]) {
    assert.equal(
      safePlatformReadinessSuccess({
        ok: true,
        evidenceHash: HASH,
        receipt: unsafeReceipt
      }),
      null
    );
  }
  assert.equal(
    safePlatformReadinessSuccess({
      ok: true,
      evidenceHash: "not-a-hash",
      receipt: receipt()
    }),
    null
  );
});

test("显式命令目标优先于页面输入并等待同一 readiness 原语", async () => {
  const seen: string[] = [];
  const completedSnapshot = snapshot({
    phase: "completed",
    revision: 2,
    message: "真实课程概要已就绪",
    result: { ok: true, evidenceHash: HASH, receipt: receipt() }
  });
  const outcome = await executePlatformReadinessAction({
    action: {
      id: "step-2",
      type: "platform.inspect_readiness",
      routeId: "platform",
      targetInput: "显式课程地址"
    },
    currentTargetInput: "页面中的旧地址",
    busy: false,
    runReadiness: async (targetInput) => {
      seen.push(targetInput);
      return completedSnapshot;
    }
  });

  assert.deepEqual(seen, ["显式课程地址"]);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.retryable, false);
  assert.equal(outcome.errorCode, undefined);
  assert.equal(outcome.state?.revision, 2);
  assert.match(outcome.summary, /概要已就绪/u);
});

test("没有显式目标时使用页面当前输入，二者都为空时不猜课程", async () => {
  const seen: string[] = [];
  const completedSnapshot = snapshot({
    phase: "completed",
    revision: 1,
    message: "课程壳已定位",
    result: {
      ok: true,
      evidenceHash: HASH,
      receipt: receipt({ status: "shell_only", safeToDemonstrate: false })
    }
  });
  const fallback = await executePlatformReadinessAction({
    action: {
      id: "step-1",
      type: "platform.inspect_readiness",
      routeId: "platform",
      targetInput: ""
    },
    currentTargetInput: "页面课程地址",
    busy: false,
    runReadiness: async (targetInput) => {
      seen.push(targetInput);
      return completedSnapshot;
    }
  });
  assert.deepEqual(seen, ["页面课程地址"]);
  assert.equal(fallback.status, "completed");
  assert.match(fallback.summary, /课程壳/u);

  const missing = await executePlatformReadinessAction({
    action: {
      id: "step-1",
      type: "platform.inspect_readiness",
      routeId: "platform",
      targetInput: ""
    },
    currentTargetInput: "  ",
    busy: false,
    runReadiness: async () => {
      assert.fail("没有显式课程目标时不得启动外部读取");
    }
  });
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.retryable, false);
  assert.equal(missing.errorCode, "PLATFORM_TARGET_REQUIRED");
  assert.doesNotMatch(missing.summary, /默认|猜测/u);
});

test("并发动作不会重复发起诊断", async () => {
  const outcome = await executePlatformReadinessAction({
    action: {
      id: "step-1",
      type: "platform.inspect_readiness",
      routeId: "platform",
      targetInput: "课程地址"
    },
    currentTargetInput: "",
    busy: true,
    runReadiness: async () => {
      assert.fail("忙碌状态不得重复发起 readiness 请求");
    }
  });

  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.retryable, true);
  assert.equal(outcome.errorCode, "PLATFORM_READINESS_BUSY");
});

test("诊断失败保留稳定错误和安全状态，不回显底层详情", async () => {
  const failedSnapshot = snapshot({
    phase: "failed",
    revision: 4,
    message: "平台诊断未完成。请检查课程入口和当前会话后重试。",
    result: {
      ok: false,
      errorCode: "PLATFORM_READINESS_FAILED"
    }
  });
  const outcome = await executePlatformReadinessAction({
    action: {
      id: "step-1",
      type: "platform.inspect_readiness",
      routeId: "platform",
      targetInput: "课程地址"
    },
    currentTargetInput: "",
    busy: false,
    runReadiness: async () => failedSnapshot
  });

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.retryable, true);
  assert.equal(outcome.errorCode, "PLATFORM_READINESS_FAILED");
  assert.equal(outcome.state?.status, "error");
  assert.equal(outcome.state?.containsForumText, false);
  assert.equal(outcome.state?.externalWrites, false);
  assert.doesNotMatch(JSON.stringify(outcome), /private raw|courseId|token/i);
});

test("平台按钮与自然语言页面动作共用同一个异步诊断原语", async () => {
  const source = await readFile(
    path.join(
      process.cwd(),
      "components",
      "PlatformReadinessPanel.tsx"
    ),
    "utf8"
  );

  assert.match(
    source,
    /registerPageBridge\(\{[\s\S]*?routeId:\s*"platform"[\s\S]*?capabilities:\s*PLATFORM_PAGE_ACTION_CAPABILITIES/u
  );
  assert.match(
    source,
    /executePlatformReadinessAction\(\{[\s\S]*?runReadiness/u
  );
  assert.match(
    source,
    /onClick=\{\(\)\s*=>[\s\S]*?runReadiness\(targetInputRef\.current\)/u
  );
  assert.match(source, /pendingRef\.current/u);
});
