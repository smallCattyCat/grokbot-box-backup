import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isSafeRunId,
  isWorkbenchRunLineage,
  isWorkbenchSessionWorkspaceSummary,
  redactPublicText,
  WORKBENCH_LINEAGE_SCHEMA_VERSION,
  WORKBENCH_SESSION_WORKSPACE_SCHEMA_VERSION,
  type WorkbenchRunLineage,
  type WorkbenchRunSnapshot,
  type WorkbenchSessionWorkspaceSummary
} from "@/lib/workbench/contracts";

const SESSION_ROOT_NAME = "智能控制台会话";
const SESSION_BUNDLE_SCHEMA_VERSION = "cmooc.workbench-session-bundle.v1" as const;
const syncSignatures = new Map<string, string>();
let sessionRootForTests: string | undefined;

type EnsureSessionWorkspaceInput = {
  runId: string;
  createdAt: string;
  taskTitle: string;
  lineage?: WorkbenchRunSnapshot["lineage"];
  sourceRoot?: string;
};

type SessionLineage = WorkbenchRunLineage;

type SessionManifest = {
  schemaVersion: typeof SESSION_BUNDLE_SCHEMA_VERSION;
  runId: string;
  title: string;
  status: WorkbenchRunSnapshot["status"];
  createdAt: string;
  updatedAt: string;
  sourceWorkspace: string;
  lineage: SessionLineage;
  context?: {
    ref: string;
    kind: string;
    title: string;
    courseAlias?: string;
  };
  plan?: {
    steps: Array<{ step: string; status: string }>;
  };
  goal?: {
    status: string;
    tokensUsed: number;
    timeUsedSeconds: number;
  };
  resultSummary?: string;
  artifacts: Array<{ label: string; relativePath: string; status: string }>;
  safety: {
    containsPrompt: false;
    containsForumText: false;
    containsIdentity: false;
    externalMutationAttempted: false;
    realPublishEnabled: false;
    editorWriteCount: 0;
    publishAttemptCount: 0;
  };
};

function stableError(code: string): Error {
  const error = new Error(code);
  error.name = "WorkbenchSessionWorkspaceError";
  return error;
}

function safeSessionLineage(runId: string, value: unknown): SessionLineage {
  if (!isSafeRunId(runId)) {
    throw stableError("WORKBENCH_SESSION_LINEAGE_INVALID");
  }
  if (value === undefined) {
    return {
      schemaVersion: WORKBENCH_LINEAGE_SCHEMA_VERSION,
      relation: "root",
      rootRunId: runId,
      generation: 0
    };
  }
  if (!isWorkbenchRunLineage(value, runId)) {
    throw stableError("WORKBENCH_SESSION_LINEAGE_INVALID");
  }
  return {
    ...value
  };
}

function managedSessionRoot(sourceRoot: string): string {
  return path.resolve(
    sessionRootForTests ?? path.join(path.resolve(sourceRoot, ".."), SESSION_ROOT_NAME)
  );
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw stableError("WORKBENCH_SESSION_WORKSPACE_INVALID");
  }
  return parsed.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function sessionKey(runId: string, createdAt: string): string {
  if (!isSafeRunId(runId)) {
    throw stableError("WORKBENCH_SESSION_WORKSPACE_INVALID");
  }
  return `${formatTimestamp(createdAt)}--run-${runId.toLowerCase()}`;
}

function workspaceSummary(key: string): WorkbenchSessionWorkspaceSummary {
  return {
    schemaVersion: WORKBENCH_SESSION_WORKSPACE_SCHEMA_VERSION,
    key,
    projectRelativePath: `${SESSION_ROOT_NAME}/${key}`,
    state: "ready",
    reusable: true,
    containsPrompt: false,
    containsForumText: false,
    containsIdentity: false
  };
}

function resolveBundleRoot(
  summary: WorkbenchSessionWorkspaceSummary,
  sourceRoot: string
): string {
  if (!isWorkbenchSessionWorkspaceSummary(summary)) {
    throw stableError("WORKBENCH_SESSION_WORKSPACE_INVALID");
  }
  const root = managedSessionRoot(sourceRoot);
  const target = path.resolve(root, summary.key);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw stableError("WORKBENCH_SESSION_WORKSPACE_INVALID");
  }
  return target;
}

async function assertPlainDirectory(directory: string): Promise<void> {
  const stats = await lstat(directory).catch(() => undefined);
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw stableError("WORKBENCH_SESSION_WORKSPACE_INVALID");
  }
}

function sourceWorkspaceReference(bundleRoot: string, sourceRoot: string): string {
  const relative = path.relative(bundleRoot, path.resolve(sourceRoot)).replace(/\\/g, "/");
  if (!relative || path.isAbsolute(relative) || relative.split("/").includes("")) {
    throw stableError("WORKBENCH_SESSION_WORKSPACE_INVALID");
  }
  return relative;
}

function safeArtifactPath(value: string): string | undefined {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return undefined;
  }
  return redactPublicText(normalized, 320) || undefined;
}

function safeManifest(
  snapshot: WorkbenchRunSnapshot,
  bundleRoot: string,
  sourceRoot: string
): SessionManifest {
  const context = snapshot.context
    ? {
        ref: redactPublicText(snapshot.context.ref, 240),
        kind: redactPublicText(snapshot.context.kind, 40),
        title: redactPublicText(snapshot.context.title, 160),
        ...(snapshot.context.courseAlias
          ? { courseAlias: redactPublicText(snapshot.context.courseAlias, 80) }
          : {})
      }
    : undefined;
  const artifacts = snapshot.artifacts.flatMap((artifact) => {
    const relativePath = safeArtifactPath(artifact.relativePath);
    if (!relativePath) return [];
    return [{
      label: redactPublicText(artifact.label, 160) || "会话产物",
      relativePath,
      status: artifact.status
    }];
  });
  return {
    schemaVersion: SESSION_BUNDLE_SCHEMA_VERSION,
    runId: snapshot.id,
    title: redactPublicText(snapshot.taskTitle, 160) || "课程研判任务",
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    sourceWorkspace: sourceWorkspaceReference(bundleRoot, sourceRoot),
    lineage: safeSessionLineage(snapshot.id, snapshot.lineage),
    ...(context ? { context } : {}),
    ...(snapshot.plan
      ? {
          plan: {
            steps: snapshot.plan.steps.slice(0, 12).map((step) => ({
              step: redactPublicText(step.step, 240),
              status: step.status
            }))
          }
        }
      : {}),
    ...(snapshot.goal
      ? {
          goal: {
            status: snapshot.goal.status,
            tokensUsed: snapshot.goal.tokensUsed,
            timeUsedSeconds: snapshot.goal.timeUsedSeconds
          }
        }
      : {}),
    ...(snapshot.finalResult
      ? { resultSummary: redactPublicText(snapshot.finalResult.summary, 1_200) }
      : {}),
    artifacts,
    safety: {
      containsPrompt: false,
      containsForumText: false,
      containsIdentity: false,
      externalMutationAttempted: false,
      realPublishEnabled: false,
      editorWriteCount: 0,
      publishAttemptCount: 0
    }
  };
}

function handoffMarkdown(manifest: SessionManifest): string {
  const lines = [
    "# 智能控制台会话",
    "",
    `- 状态：${manifest.status}`,
    `- 标题：${manifest.title}`,
    `- 创建时间：${manifest.createdAt}`,
    `- 更新时间：${manifest.updatedAt}`,
    `- 源码工作区：${manifest.sourceWorkspace}`,
    "- 课程平台外部写入：关闭",
    "- 旧线程恢复：否",
    ""
  ];
  const lineageLabel = manifest.lineage.relation === "restart"
    ? `恢复尝试 · 第 ${manifest.lineage.generation} 次`
    : manifest.lineage.relation === "plan-execution"
      ? `计划执行 · 第 ${manifest.lineage.generation} 代`
      : "根任务";
  lines.push(
    "## 任务血缘",
    "",
    `- 启动关系：${lineageLabel}`,
    `- 根任务：${manifest.lineage.rootRunId}`,
    ...(manifest.lineage.parentRunId
      ? [`- 来源任务：${manifest.lineage.parentRunId}`]
      : []),
    ...(manifest.lineage.recoveryOfRunId
      ? [`- 恢复来源：${manifest.lineage.recoveryOfRunId}`]
      : []),
    ...(manifest.lineage.planRunId
      ? [`- 计划来源：${manifest.lineage.planRunId}`]
      : []),
    `- 血缘代数：${manifest.lineage.generation}`,
    "- 旧线程恢复：否",
    ""
  );
  if (manifest.context) {
    lines.push("## 安全上下文", "", `${manifest.context.title}（${manifest.context.kind}）`, "");
  }
  if (manifest.resultSummary) {
    lines.push("## 最近结果", "", manifest.resultSummary, "");
  }
  if (manifest.plan?.steps.length) {
    lines.push(
      "## 计划",
      "",
      ...manifest.plan.steps.map((step) => `- [${step.status === "completed" ? "x" : " "}] ${step.step}`),
      ""
    );
  }
  if (manifest.artifacts.length) {
    lines.push(
      "## 产物索引",
      "",
      ...manifest.artifacts.map((artifact) => `- ${artifact.label}：${artifact.relativePath}`),
      ""
    );
  }
  lines.push(
    "## 持久化边界",
    "",
    "本目录只保存安全摘要和产物索引，不保存原始提示、过程推理、命令输出、论坛正文、身份、凭据或底层线程标识。",
    ""
  );
  return lines.join("\n");
}

async function readOwnedRunId(bundleRoot: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(bundleRoot, "session.json"), "utf8")
    ) as { schemaVersion?: unknown; runId?: unknown };
    return parsed.schemaVersion === SESSION_BUNDLE_SCHEMA_VERSION &&
      typeof parsed.runId === "string"
      ? parsed.runId
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeBundle(bundleRoot: string, manifest: SessionManifest): Promise<void> {
  await writeFile(
    path.join(bundleRoot, "session.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8" }
  );
  await writeFile(path.join(bundleRoot, "handoff.md"), handoffMarkdown(manifest), {
    encoding: "utf8"
  });
}

function meaningfulManifestSignature(manifest: SessionManifest): string {
  const { updatedAt: _updatedAt, ...meaningful } = manifest;
  return JSON.stringify(meaningful);
}

export async function ensureWorkbenchSessionWorkspace(
  input: EnsureSessionWorkspaceInput
): Promise<WorkbenchSessionWorkspaceSummary> {
  const sourceRoot = path.resolve(input.sourceRoot ?? process.cwd());
  const key = sessionKey(input.runId, input.createdAt);
  const summary = workspaceSummary(key);
  const root = managedSessionRoot(sourceRoot);
  const bundleRoot = resolveBundleRoot(summary, sourceRoot);
  await mkdir(root, { recursive: true });
  await assertPlainDirectory(root);
  try {
    await mkdir(bundleRoot, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw stableError("WORKBENCH_SESSION_WORKSPACE_UNAVAILABLE");
    }
    await assertPlainDirectory(bundleRoot);
    if ((await readOwnedRunId(bundleRoot)) !== input.runId) {
      throw stableError("WORKBENCH_SESSION_WORKSPACE_CONFLICT");
    }
    return summary;
  }
  await assertPlainDirectory(bundleRoot);
  await mkdir(path.join(bundleRoot, "artifacts"), { recursive: false });
  const initialManifest: SessionManifest = {
    schemaVersion: SESSION_BUNDLE_SCHEMA_VERSION,
    runId: input.runId,
    title: "课程研判任务",
    status: "queued",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    sourceWorkspace: sourceWorkspaceReference(bundleRoot, sourceRoot),
    lineage: safeSessionLineage(input.runId, input.lineage),
    artifacts: [],
    safety: {
      containsPrompt: false,
      containsForumText: false,
      containsIdentity: false,
      externalMutationAttempted: false,
      realPublishEnabled: false,
      editorWriteCount: 0,
      publishAttemptCount: 0
    }
  };
  await writeBundle(bundleRoot, initialManifest).catch(() => {
    throw stableError("WORKBENCH_SESSION_WORKSPACE_UNAVAILABLE");
  });
  return summary;
}

export async function syncWorkbenchSessionWorkspace(
  snapshot: WorkbenchRunSnapshot,
  sourceRoot = process.cwd()
): Promise<void> {
  const summary = snapshot.sessionWorkspace;
  if (!summary || !isWorkbenchSessionWorkspaceSummary(summary)) {
    throw stableError("WORKBENCH_SESSION_WORKSPACE_INVALID");
  }
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const bundleRoot = resolveBundleRoot(summary, resolvedSourceRoot);
  await assertPlainDirectory(managedSessionRoot(resolvedSourceRoot));
  await assertPlainDirectory(bundleRoot);
  await assertPlainDirectory(path.join(bundleRoot, "artifacts"));
  if ((await readOwnedRunId(bundleRoot)) !== snapshot.id) {
    throw stableError("WORKBENCH_SESSION_WORKSPACE_CONFLICT");
  }
  const manifest = safeManifest(snapshot, bundleRoot, resolvedSourceRoot);
  const signature = meaningfulManifestSignature(manifest);
  if (syncSignatures.get(snapshot.id) === signature) return;
  await writeBundle(bundleRoot, manifest);
  syncSignatures.set(snapshot.id, signature);
}

export function setWorkbenchSessionWorkspaceRootForTests(root: string): void {
  sessionRootForTests = path.resolve(root);
}

export function resetWorkbenchSessionWorkspaceForTests(): void {
  sessionRootForTests = undefined;
  syncSignatures.clear();
}

export const WORKBENCH_SESSION_ROOT_NAME = SESSION_ROOT_NAME;
