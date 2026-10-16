import type { WorkbenchDb } from "@/lib/workbench/durable-ledger";

export const ARTIFACT_WORKSPACE_READ_MODEL_SCHEMA_VERSION =
  "cmooc.workbench.artifact-workspace-read-model.v1" as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;

export type ArtifactWorkspaceRecoveryProjection = Readonly<{
  bodyPersisted: false;
  exactResume: false;
  action:
    | "regenerate_and_reverify"
    | "reenter_or_regenerate"
    | "durable_projection_only";
  reason:
    | "restricted_body_is_process_local"
    | "restricted_body_expired"
    | "content_not_exposed_by_workspace";
}>;

export type ArtifactWorkspaceVerificationProjection = Readonly<{
  status: "passed" | "failed" | "unknown" | "not_recorded";
  verifier: string | null;
  verifierVersion: string | null;
  safeSummary: string;
  observedAt: string | null;
  expiresAt: string | null;
}>;

export type ArtifactWorkspaceVersionProjection = Readonly<{
  taskId: string;
  runId: string;
  versionId: string;
  versionRef: string;
  artifactId: string;
  artifactRef: string;
  version: number;
  artifactKind: string;
  contentClass: string;
  contentHash: string;
  draftBodyHash: string | null;
  safeSummary: string;
  createdAt: string;
  expiresAt: string | null;
  expired: boolean;
  verification: ArtifactWorkspaceVerificationProjection;
  recovery: ArtifactWorkspaceRecoveryProjection;
}>;

export type ArtifactWorkspaceProjection = Readonly<{
  schemaVersion: typeof ARTIFACT_WORKSPACE_READ_MODEL_SCHEMA_VERSION;
  taskId: string;
  runId: string;
  versions: readonly ArtifactWorkspaceVersionProjection[];
  bodyIncluded: false;
  bodyPersistedByWorkspace: false;
}>;

export class ArtifactWorkspaceReadError extends Error {
  constructor(
    readonly code:
      | "WORKBENCH_ARTIFACT_SCOPE_INVALID"
      | "WORKBENCH_ARTIFACT_RUN_NOT_FOUND"
      | "WORKBENCH_ARTIFACT_VERSION_NOT_FOUND",
    message: string
  ) {
    super(message);
    this.name = "ArtifactWorkspaceReadError";
  }
}

type SafeArtifactRow = Readonly<{
  id: string;
  taskId: string;
  runId: string;
  artifactId: string;
  version: number;
  artifactKind: string;
  contentClass: string;
  contentHash: string;
  draftBodyHash: string | null;
  safeSummary: string;
  expiresAt: Date | null;
  createdAt: Date;
}>;

type SafeVerificationRow = Readonly<{
  subjectId: string;
  verifier: string;
  verifierVersion: string;
  status: string;
  safeSummary: string;
  observedAt: Date;
  expiresAt: Date | null;
}>;

function assertSafeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) {
    throw new ArtifactWorkspaceReadError(
      "WORKBENCH_ARTIFACT_SCOPE_INVALID",
      `${label} is invalid.`
    );
  }
  return value;
}

function verificationProjection(
  row: SafeVerificationRow | undefined
): ArtifactWorkspaceVerificationProjection {
  if (!row) {
    return Object.freeze({
      status: "not_recorded" as const,
      verifier: null,
      verifierVersion: null,
      safeSummary: "No durable verification is recorded for this version.",
      observedAt: null,
      expiresAt: null
    });
  }
  const status = ["passed", "failed", "unknown"].includes(row.status)
    ? (row.status as "passed" | "failed" | "unknown")
    : "unknown";
  return Object.freeze({
    status,
    verifier: row.verifier,
    verifierVersion: row.verifierVersion,
    safeSummary: row.safeSummary,
    observedAt: row.observedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null
  });
}

function recoveryProjection(
  row: SafeArtifactRow,
  nowMs: number
): ArtifactWorkspaceRecoveryProjection {
  if (row.contentClass !== "restricted_transient") {
    return Object.freeze({
      bodyPersisted: false as const,
      exactResume: false as const,
      action: "durable_projection_only" as const,
      reason: "content_not_exposed_by_workspace" as const
    });
  }
  const expired = row.expiresAt !== null && row.expiresAt.getTime() <= nowMs;
  return Object.freeze({
    bodyPersisted: false as const,
    exactResume: false as const,
    action: expired
      ? ("reenter_or_regenerate" as const)
      : ("regenerate_and_reverify" as const),
    reason: expired
      ? ("restricted_body_expired" as const)
      : ("restricted_body_is_process_local" as const)
  });
}

function projectVersion(
  row: SafeArtifactRow,
  verification: SafeVerificationRow | undefined,
  nowMs: number
): ArtifactWorkspaceVersionProjection {
  return Object.freeze({
    taskId: row.taskId,
    runId: row.runId,
    versionId: row.id,
    versionRef: `artifact-version:${row.id}`,
    artifactId: row.artifactId,
    artifactRef: `artifact:${row.artifactId}`,
    version: row.version,
    artifactKind: row.artifactKind,
    contentClass: row.contentClass,
    contentHash: row.contentHash,
    draftBodyHash: row.draftBodyHash,
    safeSummary: row.safeSummary,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    expired: row.expiresAt !== null && row.expiresAt.getTime() <= nowMs,
    verification: verificationProjection(verification),
    recovery: recoveryProjection(row, nowMs)
  });
}

async function loadSafeRows(
  db: WorkbenchDb,
  input: Readonly<{ runId: string; versionId?: string }>
): Promise<Readonly<{ taskId: string; rows: readonly SafeArtifactRow[] }>> {
  const runId = assertSafeId(input.runId, "runId");
  const versionId = input.versionId
    ? assertSafeId(input.versionId, "versionId")
    : undefined;
  const run = await db.workbenchRunRecord.findUnique({
    where: { id: runId },
    select: { taskId: true }
  });
  if (!run) {
    throw new ArtifactWorkspaceReadError(
      "WORKBENCH_ARTIFACT_RUN_NOT_FOUND",
      "Workbench run was not found."
    );
  }
  const rows = await db.workbenchArtifactVersionRecord.findMany({
    where: {
      taskId: run.taskId,
      runId,
      ...(versionId ? { id: versionId } : {})
    },
    select: {
      id: true,
      taskId: true,
      runId: true,
      artifactId: true,
      version: true,
      artifactKind: true,
      contentClass: true,
      contentHash: true,
      draftBodyHash: true,
      safeSummary: true,
      expiresAt: true,
      createdAt: true
    },
    orderBy: [{ createdAt: "desc" }, { version: "desc" }]
  });
  if (versionId && rows.length !== 1) {
    throw new ArtifactWorkspaceReadError(
      "WORKBENCH_ARTIFACT_VERSION_NOT_FOUND",
      "Artifact version was not found in this task/run scope."
    );
  }
  return Object.freeze({ taskId: run.taskId, rows });
}

async function projectRows(
  db: WorkbenchDb,
  input: Readonly<{
    taskId: string;
    runId: string;
    rows: readonly SafeArtifactRow[];
    now: Date;
  }>
): Promise<readonly ArtifactWorkspaceVersionProjection[]> {
  if (input.rows.length === 0) return Object.freeze([]);
  const ids = input.rows.map((row) => row.id);
  const verifications = await db.workbenchVerificationRecord.findMany({
    where: {
      taskId: input.taskId,
      runId: input.runId,
      subjectType: "artifact_version",
      subjectId: { in: ids },
      containsForumText: false,
      containsIdentity: false
    },
    select: {
      subjectId: true,
      verifier: true,
      verifierVersion: true,
      status: true,
      safeSummary: true,
      observedAt: true,
      expiresAt: true
    },
    orderBy: [{ observedAt: "desc" }, { id: "desc" }]
  });
  const latestBySubject = new Map<string, SafeVerificationRow>();
  for (const verification of verifications) {
    if (!latestBySubject.has(verification.subjectId)) {
      latestBySubject.set(verification.subjectId, verification);
    }
  }
  const nowMs = input.now.getTime();
  return Object.freeze(
    input.rows.map((row) =>
      projectVersion(row, latestBySubject.get(row.id), nowMs)
    )
  );
}

/**
 * Reads only the explicit safe projection. The Prisma select intentionally
 * excludes metadataJson, regenerationRecipeJson, contentRef and every body.
 */
export async function readArtifactWorkspace(
  db: WorkbenchDb,
  input: Readonly<{ runId: string; now?: Date }>
): Promise<ArtifactWorkspaceProjection> {
  const now = input.now ?? new Date();
  const loaded = await loadSafeRows(db, { runId: input.runId });
  const versions = await projectRows(db, {
    taskId: loaded.taskId,
    runId: input.runId,
    rows: loaded.rows,
    now
  });
  return Object.freeze({
    schemaVersion: ARTIFACT_WORKSPACE_READ_MODEL_SCHEMA_VERSION,
    taskId: loaded.taskId,
    runId: input.runId,
    versions,
    bodyIncluded: false as const,
    bodyPersistedByWorkspace: false as const
  });
}

export async function readArtifactWorkspaceVersion(
  db: WorkbenchDb,
  input: Readonly<{ runId: string; versionId: string; now?: Date }>
): Promise<ArtifactWorkspaceVersionProjection> {
  const now = input.now ?? new Date();
  const loaded = await loadSafeRows(db, {
    runId: input.runId,
    versionId: input.versionId
  });
  const projected = await projectRows(db, {
    taskId: loaded.taskId,
    runId: input.runId,
    rows: loaded.rows,
    now
  });
  return projected[0]!;
}
