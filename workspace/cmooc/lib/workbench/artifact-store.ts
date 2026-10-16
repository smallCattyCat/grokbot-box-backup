import { randomUUID } from "node:crypto";
import {
  Prisma,
  type WorkbenchArtifactVersionRecord
} from "@prisma/client";
import {
  assertOpaqueId,
  assertOpaqueRef,
  assertSafeSummary,
  assertSha256,
  assertTaskRunScope,
  assertVersion,
  normalizeDate,
  normalizeEvidenceRefs,
  serializeSafeDurableValue,
  withWorkbenchTransaction,
  WorkbenchDurableLedgerError,
  type DurableEvidenceRef,
  type SafeJsonValue,
  type WorkbenchDb
} from "./durable-ledger";

export const WORKBENCH_ARTIFACT_VERSION_SCHEMA_VERSION =
  "cmooc.workbench.artifact-version.v1" as const;

export type WorkbenchArtifactContentClass =
  | "safe_aggregate"
  | "safe_generated"
  | "restricted_transient"
  | "external_receipt";

export type CreateArtifactVersionInput = {
  id?: string;
  taskId: string;
  runId: string;
  artifactId: string;
  version?: number;
  schemaVersion?: string;
  artifactKind: string;
  contentClass: WorkbenchArtifactContentClass;
  contentHash: string;
  draftBodyHash?: string | null;
  contentRef?: string | null;
  safeSummary: string;
  metadata: SafeJsonValue;
  sourceRefs: readonly DurableEvidenceRef[];
  regenerationRecipe?: SafeJsonValue | null;
  createdByCallId?: string | null;
  expiresAt?: Date | string | null;
  createdAt?: Date | string;
};

function artifactInputError(message: string): never {
  throw new WorkbenchDurableLedgerError(
    "WORKBENCH_ARTIFACT_VERSION_INVALID",
    message
  );
}

function assertStructuredObject(value: SafeJsonValue, path: string): string {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    artifactInputError(`${path} 必须是安全结构化对象。`);
  }
  return serializeSafeDurableValue(value, path);
}

function normalizeContentRef(
  value: string | null | undefined,
  contentClass: WorkbenchArtifactContentClass
): string | null {
  if (!value) return null;
  if (contentClass === "restricted_transient") {
    throw new WorkbenchDurableLedgerError(
      "WORKBENCH_RESTRICTED_ARTIFACT_CONTENT_FORBIDDEN",
      "restricted_transient artifact 不能持久化正文或磁盘内容引用。"
    );
  }
  const ref = assertOpaqueRef(value, "contentRef");
  if (!/^(?:artifact|blob|export|receipt):[A-Za-z0-9._:@-]+$/u.test(ref)) {
    artifactInputError("contentRef 只能是受控服务签发的不透明引用。");
  }
  return ref;
}

function sameArtifactVersion(
  existing: WorkbenchArtifactVersionRecord,
  expected: {
    taskId: string;
    runId: string;
    schemaVersion: string;
    artifactKind: string;
    contentClass: WorkbenchArtifactContentClass;
    contentHash: string;
    draftBodyHash: string | null;
    contentRef: string | null;
    safeSummary: string;
    metadataJson: string;
    sourceRefsJson: string;
    regenerationRecipeJson: string | null;
    createdByCallId: string | null;
    expiresAt: Date | null;
  }
): boolean {
  return (
    existing.taskId === expected.taskId &&
    existing.runId === expected.runId &&
    existing.schemaVersion === expected.schemaVersion &&
    existing.artifactKind === expected.artifactKind &&
    existing.contentClass === expected.contentClass &&
    existing.contentHash === expected.contentHash &&
    existing.draftBodyHash === expected.draftBodyHash &&
    existing.contentRef === expected.contentRef &&
    existing.safeSummary === expected.safeSummary &&
    existing.metadataJson === expected.metadataJson &&
    existing.sourceRefsJson === expected.sourceRefsJson &&
    existing.regenerationRecipeJson === expected.regenerationRecipeJson &&
    existing.createdByCallId === expected.createdByCallId &&
    (existing.expiresAt?.getTime() ?? null) ===
      (expected.expiresAt?.getTime() ?? null)
  );
}

async function createArtifactVersionOnce(
  db: WorkbenchDb,
  input: CreateArtifactVersionInput
): Promise<WorkbenchArtifactVersionRecord> {
  const id = assertOpaqueId(input.id ?? randomUUID(), "id");
  const taskId = assertOpaqueId(input.taskId, "taskId");
  const runId = assertOpaqueId(input.runId, "runId");
  const artifactId = assertOpaqueId(input.artifactId, "artifactId");
  if (
    input.version !== undefined &&
    (!Number.isSafeInteger(input.version) || input.version < 1)
  ) {
    artifactInputError("version 必须是正整数。");
  }
  const schemaVersion = assertVersion(
    input.schemaVersion ?? WORKBENCH_ARTIFACT_VERSION_SCHEMA_VERSION,
    "schemaVersion"
  );
  const artifactKind = assertVersion(input.artifactKind, "artifactKind");
  if (
    ![
      "safe_aggregate",
      "safe_generated",
      "restricted_transient",
      "external_receipt"
    ].includes(input.contentClass)
  ) {
    artifactInputError("contentClass 无效。");
  }
  const contentHash = assertSha256(input.contentHash, "contentHash");
  const draftBodyHash = input.draftBodyHash
    ? assertSha256(input.draftBodyHash, "draftBodyHash")
    : null;
  const contentRef = normalizeContentRef(input.contentRef, input.contentClass);
  const safeSummary = assertSafeSummary(input.safeSummary, "safeSummary");
  const metadataJson = assertStructuredObject(input.metadata, "metadata");
  const sourceRefs = normalizeEvidenceRefs(input.sourceRefs, "sourceRefs");
  const sourceRefsJson = serializeSafeDurableValue(sourceRefs, "sourceRefs");
  const regenerationRecipeJson = input.regenerationRecipe
    ? assertStructuredObject(input.regenerationRecipe, "regenerationRecipe")
    : null;
  const createdByCallId = input.createdByCallId
    ? assertOpaqueId(input.createdByCallId, "createdByCallId")
    : null;
  const createdAt = normalizeDate(input.createdAt ?? new Date(), "createdAt");
  const expiresAt = input.expiresAt
    ? normalizeDate(input.expiresAt, "expiresAt")
    : null;
  if (expiresAt && expiresAt <= createdAt) {
    artifactInputError("expiresAt 必须晚于 createdAt。");
  }
  if (input.contentClass === "restricted_transient") {
    if (!draftBodyHash || !regenerationRecipeJson) {
      artifactInputError(
        "restricted_transient artifact 必须保存正文 hash 与安全再生成配方。"
      );
    }
  }
  if (input.contentClass === "external_receipt" && draftBodyHash) {
    artifactInputError("external_receipt 不得冒充草稿正文版本。");
  }

  return withWorkbenchTransaction(db, async (transaction) => {
    await assertTaskRunScope(transaction, { taskId, runId });
    if (createdByCallId) {
      const call = await transaction.workbenchToolCallRecord.findUnique({
        where: { id: createdByCallId },
        select: { taskId: true, runId: true }
      });
      if (!call || call.taskId !== taskId || call.runId !== runId) {
        throw new WorkbenchDurableLedgerError(
          "WORKBENCH_DURABLE_SCOPE_MISMATCH",
          "createdByCall 与 artifact task/run 不一致。"
        );
      }
    }
    const latest = await transaction.workbenchArtifactVersionRecord.findFirst({
      where: { artifactId },
      orderBy: { version: "desc" },
      select: { version: true, taskId: true }
    });
    if (latest && latest.taskId !== taskId) {
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_DURABLE_SCOPE_MISMATCH",
        "artifactId 已属于另一任务。"
      );
    }
    const version = input.version ?? (latest?.version ?? 0) + 1;
    const expected = {
      taskId,
      runId,
      schemaVersion,
      artifactKind,
      contentClass: input.contentClass,
      contentHash,
      draftBodyHash,
      contentRef,
      safeSummary,
      metadataJson,
      sourceRefsJson,
      regenerationRecipeJson,
      createdByCallId,
      expiresAt
    };
    const existing = await transaction.workbenchArtifactVersionRecord.findUnique({
      where: { artifactId_version: { artifactId, version } }
    });
    if (existing) {
      if (sameArtifactVersion(existing, expected)) return existing;
      throw new WorkbenchDurableLedgerError(
        "WORKBENCH_ARTIFACT_VERSION_IMMUTABLE",
        "该 artifact version 已绑定另一份不可变安全投影。"
      );
    }
    return transaction.workbenchArtifactVersionRecord.create({
      data: {
        id,
        taskId,
        runId,
        artifactId,
        version,
        schemaVersion,
        artifactKind,
        contentClass: input.contentClass,
        contentHash,
        draftBodyHash,
        contentRef,
        safeSummary,
        metadataJson,
        sourceRefsJson,
        regenerationRecipeJson,
        createdByCallId,
        expiresAt,
        createdAt
      }
    });
  });
}

export async function createArtifactVersion(
  db: WorkbenchDb,
  input: CreateArtifactVersionInput
): Promise<WorkbenchArtifactVersionRecord> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await createArtifactVersionOnce(db, input);
    } catch (error) {
      const retryable =
        input.version === undefined &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002";
      if (!retryable || attempt === 2) throw error;
    }
  }
  artifactInputError("无法分配 artifact version。");
}
