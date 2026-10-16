import assert from "node:assert/strict";
import test from "node:test";
import {
  isSafeRunId,
  isWorkbenchPendingAction,
  isWorkbenchRunLineage,
  isWorkbenchSessionWorkspaceSummary,
  isTerminalWorkbenchStatus,
  parseCreateRunInput,
  parseWorkbenchLaunchInput,
  parseMessageInput,
  redactPublicText,
  SAFE_WORKBENCH_STATE,
  WORKBENCH_PROMPT_MAX_LENGTH,
  WORKBENCH_PUBLIC_TEXT_MAX_LENGTH,
  WORKBENCH_SCHEMA_VERSION,
  WORKBENCH_LINEAGE_SCHEMA_VERSION,
  WORKBENCH_SESSION_WORKSPACE_SCHEMA_VERSION,
  WorkbenchInputError,
  type WorkbenchRunStatus
} from "../../lib/workbench/contracts";

test("pending action contract admits exact STAGE and reconcile boundaries but never publish", () => {
  const base = {
    schemaVersion: "cmooc.course-agent-action-coordinator.v1",
    kind: "approval_required",
    actionRef: "action-reconcile-safe",
    approvalHash: "a".repeat(64),
    bindingHash: "b".repeat(64),
    toolVersion: "1",
    safeSummary: "核对一笔不确定暂存。",
    validFrom: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T12:05:00.000Z",
    operationBoundary: {
      editorWriteCount: 0,
      editorReadbackCount: 1,
      editorClearCount: 1,
      publishCount: 0,
      notificationCount: 0,
      realPublishEnabled: false
    }
  } as const;
  const recovery = {
    ...base,
    toolName: "platform.editor.reconcile_stage",
    parentActionRef: "action-stage-safe",
    recoveryOfActionRef: "action-stage-safe"
  } as const;
  assert.equal(isWorkbenchPendingAction(recovery), true);
  assert.equal(
    isWorkbenchPendingAction({
      ...recovery,
      operationBoundary: {
        ...recovery.operationBoundary,
        editorWriteCount: 1
      }
    }),
    false
  );
  assert.equal(
    isWorkbenchPendingAction({
      ...recovery,
      operationBoundary: {
        ...recovery.operationBoundary,
        publishCount: 1
      }
    }),
    false
  );
  assert.equal(
    isWorkbenchPendingAction({
      ...recovery,
      recoveryOfActionRef: "action-other"
    }),
    false
  );
  assert.equal(
    isWorkbenchPendingAction({
      ...base,
      toolName: "platform.editor.stage_verify_clear",
      operationBoundary: {
        ...base.operationBoundary,
        editorWriteCount: 1
      }
    }),
    true
  );
});

test("session workspace projection is fixed to a safe project-relative Nutstore folder", () => {
  const key = "20260811T121500Z--run-99999999-8888-4777-8666-555555555555";
  const workspace = {
    schemaVersion: WORKBENCH_SESSION_WORKSPACE_SCHEMA_VERSION,
    key,
    projectRelativePath: `智能控制台会话/${key}`,
    state: "ready",
    reusable: true,
    containsPrompt: false,
    containsForumText: false,
    containsIdentity: false
  };
  assert.equal(isWorkbenchSessionWorkspaceSummary(workspace), true);
  assert.equal(
    isWorkbenchSessionWorkspaceSummary({
      ...workspace,
      projectRelativePath: "智能控制台会话/../源码"
    }),
    false
  );
  assert.equal(
    isWorkbenchSessionWorkspaceSummary({ ...workspace, containsPrompt: true }),
    false
  );
});

test("create input defaults to live and trims prompt; demo is explicit", () => {
  assert.deepEqual(parseCreateRunInput({ prompt: "  inspect the worktree  " }), {
    prompt: "inspect the worktree",
    mode: "live"
  });
  assert.deepEqual(
    parseCreateRunInput({ prompt: "  use the fixture harness  ", mode: "demo" }),
    {
      prompt: "use the fixture harness",
      mode: "demo"
    }
  );
});

test("create input accepts native plan and persistent-goal modes", () => {
  assert.deepEqual(
    parseCreateRunInput({
      prompt: "  inspect with a durable objective  ",
      collaborationMode: "plan",
      goalMode: true
    }),
    {
      prompt: "inspect with a durable objective",
      mode: "live",
      collaborationMode: "plan",
      goalMode: true
    }
  );

  for (const collaborationMode of ["PLAN", "execute", 1, true]) {
    assert.throws(
      () => parseCreateRunInput({ prompt: "fixture", collaborationMode }),
      WorkbenchInputError
    );
  }
  for (const goalMode of ["true", 1, null]) {
    assert.throws(
      () => parseCreateRunInput({ prompt: "fixture", goalMode }),
      WorkbenchInputError
    );
  }
});

test("launch input accepts exactly a restart, continuation, or plan execution with a UUID request id", () => {
  const planRunId = "11111111-2222-4333-8444-555555555555";
  const recoveryOfRunId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const requestId = "99999999-8888-4777-8666-555555555555";

  assert.deepEqual(
    parseWorkbenchLaunchInput({ kind: "restart", requestId }),
    { kind: "restart", requestId }
  );
  assert.deepEqual(
    parseWorkbenchLaunchInput({ kind: "plan-execution", requestId }),
    { kind: "plan-execution", requestId }
  );
  assert.deepEqual(
    parseWorkbenchLaunchInput({ kind: "continuation", requestId }),
    { kind: "continuation", requestId }
  );

  // Lineage and prompts are server-derived from the parent run; the browser
  // cannot forge either through the normal create endpoint or the launch body.
  for (const value of [
    { kind: "restart", requestId, prompt: "reuse a private prompt" },
    {
      kind: "restart",
      requestId,
      lineage: {
        relation: "restart",
        rootRunId: recoveryOfRunId,
        parentRunId: recoveryOfRunId,
        generation: 99
      }
    },
    { kind: "restart", requestId, recoveryOfRunId },
    { kind: "plan-execution", requestId, planRunId },
    { kind: "continuation", requestId, prompt: "forge a continuation prompt" },
    { kind: "recovery", requestId },
    { kind: "restart", requestId: "not-a-uuid" },
    { kind: "restart" },
    { requestId },
    null,
    []
  ]) {
    assert.throws(() => parseWorkbenchLaunchInput(value), WorkbenchInputError);
  }

  for (const value of [
    { prompt: "fixture", planRunId },
    { prompt: "fixture", recoveryOfRunId }
  ]) {
    assert.throws(() => parseCreateRunInput(value), WorkbenchInputError);
  }
});

test("run lineage validates exact root, restart, continuation, and plan-execution generations", () => {
  const rootRunId = "11111111-2222-4333-8444-555555555555";
  const childRunId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const requestId = "99999999-8888-4777-8666-555555555555";
  const root = {
    schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
    relation: "root",
    rootRunId,
    generation: 0
  };
  const restart = {
    schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
    relation: "restart",
    rootRunId,
    parentRunId: rootRunId,
    recoveryOfRunId: rootRunId,
    generation: 1,
    requestId
  };
  const planExecution = {
    schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
    relation: "plan-execution",
    rootRunId,
    parentRunId: rootRunId,
    planRunId: rootRunId,
    generation: 1,
    requestId
  };
  const continuation = {
    schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
    relation: "continuation",
    rootRunId,
    parentRunId: rootRunId,
    generation: 1,
    requestId
  };

  assert.equal(isWorkbenchRunLineage(root, rootRunId), true);
  assert.equal(isWorkbenchRunLineage(restart, childRunId), true);
  assert.equal(isWorkbenchRunLineage(planExecution, childRunId), true);
  assert.equal(isWorkbenchRunLineage(continuation, childRunId), true);
  for (const forged of [
    { ...root, parentRunId: childRunId },
    { ...restart, generation: 0 },
    { ...restart, requestId: undefined },
    { ...restart, recoveryOfRunId: childRunId },
    { ...planExecution, planRunId: childRunId },
    { ...planExecution, recoveryOfRunId: rootRunId },
    { ...continuation, recoveryOfRunId: rootRunId },
    { ...continuation, planRunId: rootRunId }
  ]) {
    assert.equal(isWorkbenchRunLineage(forged, childRunId), false);
  }
});

test("create input accepts a typed course context without changing the v1 default", () => {
  assert.deepEqual(
    parseCreateRunInput({
      prompt: "inspect the attached decision",
      mode: "live",
      contextRef: "decision:fixture_decision_01",
      intent: "implement"
    }),
    {
      prompt: "inspect the attached decision",
      mode: "live",
      contextRef: "decision:fixture_decision_01",
      intent: "implement"
    }
  );
  for (const contextRef of [
    "decision:",
    "unknown:fixture",
    "decision:https://fixture.example",
    "decision:fixture/value"
  ]) {
    assert.throws(
      () => parseCreateRunInput({ prompt: "fixture", contextRef }),
      WorkbenchInputError
    );
  }
});

test("create input accepts a snapshot-scoped anonymous learner context", () => {
  assert.deepEqual(
    parseCreateRunInput({
      prompt: "为当前学习者制定支持计划",
      contextRef: "learner:snapshot_fixture__actor-007"
    }),
    {
      prompt: "为当前学习者制定支持计划",
      mode: "live",
      contextRef: "learner:snapshot_fixture__actor-007"
    }
  );

  for (const contextRef of [
    "learner:snapshot_fixture__raw-user-key",
    "learner:snapshot_fixture__actor-1",
    "learner:snapshot/fixture__actor-001"
  ]) {
    assert.throws(
      () => parseCreateRunInput({ prompt: "fixture", contextRef }),
      WorkbenchInputError
    );
  }
});

test("create and message inputs accept bounded typed page-action receipts", () => {
  const learnerRef = "learner:snapshot_fixture__actor-007";
  const receipts = [
    {
      actionType: "navigate",
      status: "completed",
      summary: "已打开社会网络 token=fixture-secret",
      containsForumText: false,
      externalWrites: false
    },
    {
      actionType: "context.attach_focused",
      status: "completed",
      summary: "已加入匿名学习者上下文",
      contextRef: learnerRef,
      containsForumText: false,
      externalWrites: false
    }
  ];

  const parsed = parseCreateRunInput({
    prompt: "制定支持计划",
    contextRef: learnerRef,
    priorActionReceipts: receipts
  });
  assert.equal(parsed.priorActionReceipts?.length, 2);
  assert.equal(parsed.priorActionReceipts?.[1]?.contextRef, learnerRef);
  assert.equal(JSON.stringify(parsed).includes("fixture-secret"), false);

  assert.deepEqual(
    parseMessageInput({
      prompt: "继续分析",
      priorActionReceipts: [receipts[0]]
    }).priorActionReceipts?.map((receipt) => receipt.actionType),
    ["navigate"]
  );
});

test("page-action receipts reject forged completion, external writes, and context mismatch", () => {
  const base = {
    actionType: "navigate",
    status: "completed",
    summary: "已打开社会网络",
    containsForumText: false,
    externalWrites: false
  };
  for (const receipt of [
    { ...base, actionType: "unknown" },
    { ...base, status: "running" },
    { ...base, externalWrites: true },
    { ...base, containsForumText: true }
  ]) {
    assert.throws(
      () => parseCreateRunInput({ prompt: "fixture", priorActionReceipts: [receipt] }),
      WorkbenchInputError
    );
  }

  assert.throws(
    () => parseCreateRunInput({
      prompt: "fixture",
      contextRef: "learner:snapshot_fixture__actor-007",
      priorActionReceipts: [{
        ...base,
        actionType: "context.attach_focused",
        contextRef: "learner:snapshot_fixture__actor-008"
      }]
    }),
    WorkbenchInputError
  );
});

test("action-runtime v3 browser actions are not accepted as server-verified receipts", () => {
  const actionTypes = [
    "app.go_back",
    "app.refresh",
    "workbench.stop",
    "platform.inspect_readiness"
  ] as const;

  for (const actionType of actionTypes) {
    assert.throws(
      () =>
        parseMessageInput({
          prompt: "继续说明刚才完成的页面动作",
          priorActionReceipts: [{
            actionType,
            status: "completed",
            summary: `浏览器报告已完成 ${actionType}`,
            containsForumText: false,
            externalWrites: false
          }]
        }),
      WorkbenchInputError
    );
  }
});

test("create input rejects non-objects and unknown keys", () => {
  for (const value of [null, [], "prompt", 42]) {
    assert.throws(
      () => parseCreateRunInput(value),
      (error: unknown) =>
        error instanceof WorkbenchInputError && error.status === 400
    );
  }

  assert.throws(
    () =>
      parseCreateRunInput({
        prompt: "valid fixture prompt",
        mode: "live",
        extra: "not part of the contract"
      }),
    (error: unknown) =>
      error instanceof WorkbenchInputError &&
      error.status === 400 &&
      error.message.includes("extra")
  );
});

test("create input rejects empty prompts and invalid modes", () => {
  for (const prompt of ["", " \n\t", undefined, null]) {
    assert.throws(
      () => parseCreateRunInput({ prompt }),
      (error: unknown) =>
        error instanceof WorkbenchInputError && error.status === 400
    );
  }

  for (const mode of ["AUTO", "staging", 1, true]) {
    assert.throws(
      () => parseCreateRunInput({ prompt: "valid fixture prompt", mode }),
      (error: unknown) =>
        error instanceof WorkbenchInputError &&
        error.status === 400 &&
        error.message.includes("mode")
    );
  }
});

test("create input reports oversized prompts with HTTP 413", () => {
  const oversizedPrompt = "x".repeat(WORKBENCH_PROMPT_MAX_LENGTH + 1);
  assert.throws(
    () => parseCreateRunInput({ prompt: oversizedPrompt }),
    (error: unknown) =>
      error instanceof WorkbenchInputError && error.status === 413
  );
});

test("message input accepts exactly prompt and trims it", () => {
  assert.deepEqual(parseMessageInput({ prompt: "  steer the fixture run  " }), {
    prompt: "steer the fixture run"
  });

  assert.throws(
    () =>
      parseMessageInput({
        prompt: "valid fixture prompt",
        mode: "live"
      }),
    (error: unknown) =>
      error instanceof WorkbenchInputError &&
      error.status === 400 &&
      error.message.includes("mode")
  );
});

test("public text redaction removes credentials, URLs, paths, and controls", () => {
  const fixtureText = [
    "Bearer fixture-bearer-value",
    "sk-fixture-placeholder-123456",
    "eyJfixture-header.eyJfixture-payload.eyJfixture-signature",
    "token=fixture-token-value",
    "password:fixture-password-value",
    "cookie=fixture-cookie-value",
    "auth-state=fixture-auth-state-value",
    "http://fixture.example/path",
    "https://fixture.example/path",
    "C:\\Users\\fixture-user\\repo\\file.ts",
    "/home/fixture-user/repo/file.ts",
    "line\u0000with\u000Bcontrols\u001F\u007F"
  ].join(" | ");

  assert.doesNotThrow(() => redactPublicText(fixtureText));
  const redacted = redactPublicText(fixtureText);
  assert.equal(redacted.includes("fixture-bearer-value"), false);
  assert.equal(redacted.includes("sk-fixture-placeholder-123456"), false);
  assert.equal(
    redacted.includes(
      "eyJfixture-header.eyJfixture-payload.eyJfixture-signature"
    ),
    false
  );
  assert.equal(redacted.includes("fixture-token-value"), false);
  assert.equal(redacted.includes("fixture-password-value"), false);
  assert.equal(redacted.includes("fixture-cookie-value"), false);
  assert.equal(redacted.includes("fixture-auth-state-value"), false);
  assert.equal(redacted.includes("fixture.example"), false);
  assert.equal(redacted.includes("C:\\Users\\fixture-user"), false);
  assert.equal(redacted.includes("/home/fixture-user"), false);
  assert.equal(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(redacted), false);
  assert.equal(redacted.includes("[凭据已隐藏]"), true);
  assert.equal(redacted.includes("[敏感字段已隐藏]"), true);
  assert.equal(redacted.includes("[链接已隐藏]"), true);
  assert.equal(redacted.includes("[本机路径已隐藏]"), true);
});

test("public text redaction is total for non-strings and truncates safely", () => {
  assert.equal(redactPublicText(null), "");
  assert.equal(redactPublicText(undefined), "");
  assert.equal(redactPublicText(12345), "");

  const redacted = redactPublicText("abcdefghijklmno", 10);
  assert.equal(redacted, "abcdefghi…");
  assert.equal(redacted.length, 10);
  assert.equal(redacted.length <= WORKBENCH_PUBLIC_TEXT_MAX_LENGTH, true);
});

test("safe workbench state is frozen and permanently zero-write", () => {
  assert.equal(WORKBENCH_SCHEMA_VERSION, "cmooc.workbench.v1");
  assert.equal(Object.isFrozen(SAFE_WORKBENCH_STATE), true);
  assert.deepEqual(SAFE_WORKBENCH_STATE, {
    externalWritesLocked: true,
    realPublishEnabled: false,
    externalMutationAttempted: false,
    editorWriteCount: 0,
    publishAttemptCount: 0,
    containsForumText: false
  });

  assert.equal(
    Reflect.set(
      SAFE_WORKBENCH_STATE as object,
      "realPublishEnabled",
      true
    ),
    false
  );
  assert.equal(SAFE_WORKBENCH_STATE.realPublishEnabled, false);
  assert.equal(SAFE_WORKBENCH_STATE.editorWriteCount, 0);
  assert.equal(SAFE_WORKBENCH_STATE.publishAttemptCount, 0);
});

test("terminal status helper distinguishes active and terminal runs", () => {
  const terminal: WorkbenchRunStatus[] = ["completed", "failed", "stopped"];
  const active: WorkbenchRunStatus[] = ["queued", "starting", "running"];

  for (const status of terminal) {
    assert.equal(isTerminalWorkbenchStatus(status), true, status);
  }
  for (const status of active) {
    assert.equal(isTerminalWorkbenchStatus(status), false, status);
  }
});

test("run id validator accepts hex fixture ids and rejects malformed ids", () => {
  for (const value of [
    "a".repeat(16),
    "11111111-2222-3333-4444-555555555555",
    "ABCDEFAB-1234-5678-9ABC-DEF012345678"
  ]) {
    assert.equal(isSafeRunId(value), true, value);
  }

  for (const value of [
    "short",
    "fixture_run_id_with_underscore",
    "g".repeat(16),
    "a".repeat(65),
    ""
  ]) {
    assert.equal(isSafeRunId(value), false, value);
  }
});
