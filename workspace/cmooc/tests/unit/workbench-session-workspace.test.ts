import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  ensureWorkbenchSessionWorkspace,
  resetWorkbenchSessionWorkspaceForTests,
  setWorkbenchSessionWorkspaceRootForTests,
  syncWorkbenchSessionWorkspace
} from "../../lib/workbench/session-workspace";
import {
  SAFE_WORKBENCH_STATE,
  WORKBENCH_SCHEMA_VERSION,
  type WorkbenchRunLineage,
  type WorkbenchRunSnapshot
} from "../../lib/workbench/contracts";

const cleanupRoots = new Set<string>();

afterEach(async () => {
  resetWorkbenchSessionWorkspaceForTests();
  await Promise.all(
    [...cleanupRoots].map((root) => rm(root, { recursive: true, force: true }))
  );
  cleanupRoots.clear();
});

async function fixtureRoot(): Promise<{ projectRoot: string; sourceRoot: string; sessionRoot: string }> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "cmooc-workbench-session-"));
  cleanupRoots.add(projectRoot);
  const sourceRoot = path.join(projectRoot, "源码");
  const sessionRoot = path.join(projectRoot, "智能控制台会话");
  setWorkbenchSessionWorkspaceRootForTests(sessionRoot);
  return { projectRoot, sourceRoot, sessionRoot };
}

test("a live run receives a unique Nutstore-safe session bundle without prompt text", async () => {
  const { sourceRoot, sessionRoot } = await fixtureRoot();
  const runId = "11111111-2222-4333-8444-555555555555";
  const createdAt = "2026-08-11T11:45:30.000Z";
  const unsafePrompt = "CON / 学习者姓名：请读取 token=secret 并发布";

  const workspace = await ensureWorkbenchSessionWorkspace({
    runId,
    createdAt,
    taskTitle: unsafePrompt,
    sourceRoot
  });

  assert.match(workspace.key, /^20260811T114530Z--run-[0-9a-f-]{36}$/);
  assert.equal(workspace.projectRelativePath, `智能控制台会话/${workspace.key}`);
  assert.equal(workspace.state, "ready");
  assert.equal(workspace.reusable, true);
  assert.equal(workspace.containsPrompt, false);
  assert.equal(workspace.containsForumText, false);
  assert.equal(workspace.containsIdentity, false);
  assert.doesNotMatch(workspace.key, /CON|学习者|token|secret|[\\/:*?"<>|]/i);

  const bundleRoot = path.join(sessionRoot, workspace.key);
  const manifestText = await readFile(path.join(bundleRoot, "session.json"), "utf8");
  const handoffText = await readFile(path.join(bundleRoot, "handoff.md"), "utf8");
  const manifest = JSON.parse(manifestText) as {
    lineage?: Record<string, unknown>;
  };
  assert.match(manifestText, /cmooc\.workbench-session-bundle\.v1/);
  assert.match(manifestText, /"sourceWorkspace": "\.\.\/\.\.\/源码"/);
  assert.deepEqual(manifest.lineage, {
    schemaVersion: "cmooc.workbench-lineage.v1",
    relation: "root",
    rootRunId: runId,
    generation: 0
  });
  assert.match(handoffText, /旧线程恢复：否/);
  assert.doesNotMatch(manifestText, /token=secret|请读取|threadId|turnId|C:\\/i);
  assert.doesNotMatch(handoffText, /token=secret|请读取|threadId|turnId|C:\\/i);
});

test("the same run reuses its folder and terminal sync writes only the safe handoff", async () => {
  const { sourceRoot, sessionRoot } = await fixtureRoot();
  const runId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const createdAt = "2026-08-11T12:00:00.000Z";
  const lineage: WorkbenchRunLineage = {
    schemaVersion: "cmooc.workbench-lineage.v1",
    relation: "restart",
    rootRunId: "11111111-2222-4333-8444-555555555555",
    parentRunId: "22222222-3333-4444-8555-666666666666",
    recoveryOfRunId: "22222222-3333-4444-8555-666666666666",
    planRunId: "33333333-4444-4555-8666-777777777777",
    generation: 2,
    requestId: "44444444-5555-4666-8777-888888888888"
  };
  const workspace = await ensureWorkbenchSessionWorkspace({
    runId,
    createdAt,
    taskTitle: "课程研判任务",
    lineage,
    sourceRoot
  });
  const ensuredAgain = await ensureWorkbenchSessionWorkspace({
    runId,
    createdAt,
    taskTitle: "另一个不会进入目录名的标题",
    lineage,
    sourceRoot
  });
  assert.deepEqual(ensuredAgain, workspace);
  const bundleRoot = path.join(sessionRoot, workspace.key);
  const initialManifest = JSON.parse(
    await readFile(path.join(bundleRoot, "session.json"), "utf8")
  ) as Record<string, unknown>;
  assert.deepEqual(initialManifest.lineage, lineage);

  const snapshot: WorkbenchRunSnapshot = {
    schemaVersion: WORKBENCH_SCHEMA_VERSION,
    id: runId,
    status: "completed",
    source: "app-server",
    projectLabel: "cMOOC 源码工作区",
    taskTitle: "匿名学习者支持计划",
    lineage,
    sessionWorkspace: workspace,
    createdAt,
    updatedAt: "2026-08-11T12:03:00.000Z",
    events: [],
    firstEventSeq: 0,
    lastEventSeq: 0,
    agents: [],
    tools: [],
    artifacts: [
      {
        id: "artifact-1",
        label: "支持计划",
        relativePath: "docs/support-plan.md",
        kind: "created",
        status: "ready",
        observedAt: "2026-08-11T12:02:00.000Z"
      }
    ],
    finalResult: {
      status: "completed",
      summary: "已形成可复用的支持计划；未执行课程发布。",
      completedAt: "2026-08-11T12:03:00.000Z"
    },
    safety: { ...SAFE_WORKBENCH_STATE },
    capabilities: {
      canSteer: false,
      canStop: false,
      liveHarness: true
    }
  };

  await syncWorkbenchSessionWorkspace(snapshot, sourceRoot);
  const manifest = JSON.parse(
    await readFile(path.join(bundleRoot, "session.json"), "utf8")
  ) as Record<string, unknown>;
  const handoff = await readFile(path.join(bundleRoot, "handoff.md"), "utf8");

  assert.equal(manifest.status, "completed");
  assert.equal(manifest.resultSummary, "已形成可复用的支持计划；未执行课程发布。");
  assert.deepEqual(manifest.artifacts, [
    { label: "支持计划", relativePath: "docs/support-plan.md", status: "ready" }
  ]);
  assert.deepEqual(manifest.lineage, {
    schemaVersion: "cmooc.workbench-lineage.v1",
    relation: "restart",
    rootRunId: "11111111-2222-4333-8444-555555555555",
    parentRunId: "22222222-3333-4444-8555-666666666666",
    recoveryOfRunId: "22222222-3333-4444-8555-666666666666",
    planRunId: "33333333-4444-4555-8666-777777777777",
    generation: 2,
    requestId: "44444444-5555-4666-8777-888888888888"
  });
  assert.match(handoff, /已形成可复用的支持计划/);
  assert.match(handoff, /恢复尝试 · 第 2 次/);
  assert.match(handoff, /旧线程恢复：否/);
  assert.match(handoff, /计划来源：33333333-4444-4555-8666-777777777777/);
  assert.match(handoff, /docs\/support-plan\.md/);
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /threadId|turnId|"prompt"\s*:|reasoning|stderr/i
  );
});

test("workspace projection cannot escape the managed session root", async () => {
  const { sourceRoot } = await fixtureRoot();
  const runId = "99999999-8888-4777-8666-555555555555";
  const workspace = await ensureWorkbenchSessionWorkspace({
    runId,
    createdAt: "2026-08-11T12:15:00.000Z",
    taskTitle: "fixture",
    sourceRoot
  });
  const escaped = {
    ...workspace,
    key: "../outside",
    projectRelativePath: "智能控制台会话/../outside"
  };
  const snapshot = {
    schemaVersion: WORKBENCH_SCHEMA_VERSION,
    id: runId,
    status: "running",
    source: "app-server",
    projectLabel: "cMOOC 源码工作区",
    sessionWorkspace: escaped,
    createdAt: "2026-08-11T12:15:00.000Z",
    updatedAt: "2026-08-11T12:15:01.000Z",
    events: [],
    firstEventSeq: 0,
    lastEventSeq: 0,
    agents: [],
    tools: [],
    artifacts: [],
    safety: { ...SAFE_WORKBENCH_STATE },
    capabilities: { canSteer: true, canStop: true, liveHarness: true }
  } as WorkbenchRunSnapshot;

  await assert.rejects(
    () => syncWorkbenchSessionWorkspace(snapshot, sourceRoot),
    /WORKBENCH_SESSION_WORKSPACE_INVALID/
  );
});
