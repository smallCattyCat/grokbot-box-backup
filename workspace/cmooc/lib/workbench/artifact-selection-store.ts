import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type WorkbenchArtifactSelectionRecord,
  type WorkbenchArtifactVersionRecord,
  type WorkbenchVerificationRecord
} from "@prisma/client";
import {
  assertOpaqueId,
  assertOpaqueRef,
  assertSha256,
  assertTaskRunScope,
  normalizeDate,
  withWorkbenchTransaction,
  type WorkbenchDb
} from "./durable-ledger";

export const WORKBENCH_ARTIFACT_SELECTION_SCHEMA_VERSION =
  "cmooc.workbench.artifact-selection.v1" as const;
const SELECTION_HASH_DOMAIN = "cmooc.workbench.artifact-selection-hash.v1";

export class WorkbenchArtifactSelectionError extends Error {
  constructor(readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkbenchArtifactSelectionError";
  }
}

export type ArtifactSelectionExpectation = Readonly<{
  generation: number;
  selectionHash: string;
}> | null;

export type ArtifactVersionSelectionBinding = Readonly<{
  taskId: string;
  runId: string;
  artifactId: string;
  versionId: string;
  versionRef: string;
  contentHash: string;
  draftBodyHash: string | null;
}>;

export type SelectArtifactVersionInput = ArtifactVersionSelectionBinding &
  Readonly<{
    verificationId: string;
    expected: ArtifactSelectionExpectation;
    selectedAt?: Date | string;
  }>;

function fail(code: string, message: string, cause?: unknown): never {
  throw new WorkbenchArtifactSelectionError(code, message, { cause });
}

function assertGeneration(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("WORKBENCH_ARTIFACT_SELECTION_INPUT_INVALID", `${field} 必须是正整数。`);
  }
  return value;
}

function normalizeBinding(
  input: ArtifactVersionSelectionBinding
): ArtifactVersionSelectionBinding {
  const versionId = assertOpaqueId(input.versionId, "versionId");
  const versionRef = assertOpaqueRef(input.versionRef, "versionRef");
  if (versionRef !== `artifact-version:${versionId}`) {
    fail(
      "WORKBENCH_ARTIFACT_SELECTION_INPUT_INVALID",
      "versionRef 必须精确绑定 versionId。"
    );
  }
  return Object.freeze({
    taskId: assertOpaqueId(input.taskId, "taskId"),
    runId: assertOpaqueId(input.runId, "runId"),
    artifactId: assertOpaqueId(input.artifactId, "artifactId"),
    versionId,
    versionRef,
    contentHash: assertSha256(input.contentHash, "contentHash"),
    draftBodyHash: input.draftBodyHash
      ? assertSha256(input.draftBodyHash, "draftBodyHash")
      : null
  });
}

type SelectionHashInput = Readonly<{
  id: string;
  taskId: string;
  runId: string;
  artifactId: string;
  versionId: string;
  versionRef: string;
  version: number;
  contentHash: string;
  draftBodyHash: string | null;
  verificationId: string;
  generation: number;
  selectedAt: Date | string;
}>;

export function hashArtifactSelection(input: SelectionHashInput): string {
  const payload = JSON.stringify({
    schemaVersion: WORKBENCH_ARTIFACT_SELECTION_SCHEMA_VERSION,
    id: input.id,
    taskId: input.taskId,
    runId: input.runId,
    artifactId: input.artifactId,
    versionId: input.versionId,
    versionRef: input.versionRef,
    version: input.version,
    contentHash: input.contentHash,
    draftBodyHash: input.draftBodyHash,
    verificationId: input.verificationId,
    generation: input.generation,
    selectedAt: new Date(input.selectedAt).toISOString()
  });
  return createHash("sha256")
    .update(SELECTION_HASH_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(payload, "utf8")
    .digest("hex");
}

function rowHash(row: WorkbenchArtifactSelectionRecord): string {
  return hashArtifactSelection(row);
}

function assertSelectionRowIntegrity(row: WorkbenchArtifactSelectionRecord): void {
  assertGeneration(row.generation, "generation");
  if (row.selectionHash !== rowHash(row)) {
    fail(
      "WORKBENCH_ARTIFACT_SELECTION_INTEGRITY_INVALID",
      "持久 artifact selection hash 无法重算。"
    );
  }
}

function assertVersionBinding(
  version: WorkbenchArtifactVersionRecord | null,
  binding: ArtifactVersionSelectionBinding
): asserts version is WorkbenchArtifactVersionRecord {
  if (
    !version ||
    version.taskId !== binding.taskId ||
    version.runId !== binding.runId ||
    version.artifactId !== binding.artifactId ||
    version.contentHash !== binding.contentHash ||
    version.draftBodyHash !== binding.draftBodyHash ||
    binding.versionRef !== `artifact-version:${version.id}`
  ) {
    fail(
      "WORKBENCH_ARTIFACT_SELECTION_VERSION_BINDING_INVALID",
      "选择目标未绑定同一 task/run/logical artifact 的不可变版本。"
    );
  }
}

function verificationPassed(
  verification: WorkbenchVerificationRecord | null,
  binding: ArtifactVersionSelectionBinding,
  verificationId: string,
  at: Date
): verification is WorkbenchVerificationRecord {
  return Boolean(
    verification &&
      verification.id === verificationId &&
      verification.taskId === binding.taskId &&
      verification.runId === binding.runId &&
      verification.subjectType === "artifact_version" &&
      verification.subjectId === binding.versionId &&
      verification.status === "passed" &&
      verification.containsForumText === false &&
      verification.containsIdentity === false &&
      verification.observedAt <= at &&
      (!verification.expiresAt || verification.expiresAt > at)
  );
}

async function validateCandidate(
  db: Prisma.TransactionClient,
  binding: ArtifactVersionSelectionBinding,
  verificationId: string,
  at: Date
): Promise<WorkbenchArtifactVersionRecord> {
  const [version, verification] = await Promise.all([
    db.workbenchArtifactVersionRecord.findUnique({ where: { id: binding.versionId } }),
    db.workbenchVerificationRecord.findUnique({ where: { id: verificationId } })
  ]);
  assertVersionBinding(version, binding);
  if (!verificationPassed(verification, binding, verificationId, at)) {
    fail(
      "WORKBENCH_ARTIFACT_SELECTION_VERIFICATION_INVALID",
      "artifact version 没有当前有效且精确绑定的 passed verification。"
    );
  }
  return version;
}

function rowMatchesBinding(
  row: WorkbenchArtifactSelectionRecord,
  binding: ArtifactVersionSelectionBinding
): boolean {
  return (
    row.taskId === binding.taskId &&
    row.runId === binding.runId &&
    row.artifactId === binding.artifactId &&
    row.versionId === binding.versionId &&
    row.versionRef === binding.versionRef &&
    row.contentHash === binding.contentHash &&
    row.draftBodyHash === binding.draftBodyHash
  );
}

export async function selectArtifactVersion(
  db: WorkbenchDb,
  rawInput: SelectArtifactVersionInput
): Promise<WorkbenchArtifactSelectionRecord> {
  const binding = normalizeBinding(rawInput);
  const verificationId = assertOpaqueId(rawInput.verificationId, "verificationId");
  const selectedAt = normalizeDate(rawInput.selectedAt ?? new Date(), "selectedAt");
  const expected = rawInput.expected
    ? Object.freeze({
        generation: assertGeneration(rawInput.expected.generation, "expected.generation"),
        selectionHash: assertSha256(
          rawInput.expected.selectionHash,
          "expected.selectionHash"
        )
      })
    : null;

  try {
    return await withWorkbenchTransaction(db, async (transaction) => {
      await assertTaskRunScope(transaction, binding);
      const candidate = await validateCandidate(
        transaction,
        binding,
        verificationId,
        selectedAt
      );
      const current = await transaction.workbenchArtifactSelectionRecord.findUnique({
        where: {
          taskId_artifactId: {
            taskId: binding.taskId,
            artifactId: binding.artifactId
          }
        }
      });
      if (!current) {
        if (expected !== null || candidate.version !== 1) {
          fail(
            "WORKBENCH_ARTIFACT_SELECTION_CONFLICT",
            "只有逻辑 artifact 的首个版本可在无 CAS 前态时机械初始化。"
          );
        }
        const id = randomUUID();
        const generation = 1;
        const selectionHash = hashArtifactSelection({
          id,
          ...binding,
          version: candidate.version,
          verificationId,
          generation,
          selectedAt
        });
        return transaction.workbenchArtifactSelectionRecord.create({
          data: {
            id,
            ...binding,
            version: candidate.version,
            verificationId,
            generation,
            selectionHash,
            selectedAt,
            updatedAt: selectedAt
          }
        });
      }

      assertSelectionRowIntegrity(current);
      if (rowMatchesBinding(current, binding) && current.verificationId === verificationId) {
        return current;
      }
      if (
        !expected ||
        expected.generation !== current.generation ||
        expected.selectionHash !== current.selectionHash ||
        candidate.version <= current.version
      ) {
        fail(
          "WORKBENCH_ARTIFACT_SELECTION_CONFLICT",
          "artifact selection CAS 前态已变化或候选不是单调后继版本。"
        );
      }
      const generation = current.generation + 1;
      const selectionHash = hashArtifactSelection({
        id: current.id,
        ...binding,
        version: candidate.version,
        verificationId,
        generation,
        selectedAt
      });
      const updated = await transaction.workbenchArtifactSelectionRecord.updateMany({
        where: {
          id: current.id,
          generation: expected.generation,
          selectionHash: expected.selectionHash
        },
        data: {
          runId: binding.runId,
          versionId: binding.versionId,
          versionRef: binding.versionRef,
          version: candidate.version,
          contentHash: binding.contentHash,
          draftBodyHash: binding.draftBodyHash,
          verificationId,
          generation,
          selectionHash,
          selectedAt,
          updatedAt: selectedAt
        }
      });
      if (updated.count !== 1) {
        fail(
          "WORKBENCH_ARTIFACT_SELECTION_CONFLICT",
          "artifact selection CAS 被并发更新击败。"
        );
      }
      const selected = await transaction.workbenchArtifactSelectionRecord.findUnique({
        where: { id: current.id }
      });
      if (!selected) {
        fail(
          "WORKBENCH_ARTIFACT_SELECTION_INTEGRITY_INVALID",
          "CAS 成功后无法回读 artifact selection。"
        );
      }
      return selected;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      fail(
        "WORKBENCH_ARTIFACT_SELECTION_CONFLICT",
        "artifact selection 初始化被并发写入击败。",
        error
      );
    }
    throw error;
  }
}

export async function resolveSelectedArtifactVersion(
  db: WorkbenchDb,
  rawInput: ArtifactVersionSelectionBinding & { now?: Date | string }
): Promise<WorkbenchArtifactSelectionRecord | null> {
  const binding = normalizeBinding(rawInput);
  const now = normalizeDate(rawInput.now ?? new Date(), "now");
  return withWorkbenchTransaction(db, async (transaction) => {
    await assertTaskRunScope(transaction, binding);
    const selected = await transaction.workbenchArtifactSelectionRecord.findUnique({
      where: {
        taskId_artifactId: {
          taskId: binding.taskId,
          artifactId: binding.artifactId
        }
      }
    });
    if (!selected) return null;
    assertSelectionRowIntegrity(selected);
    if (!rowMatchesBinding(selected, binding)) return null;
    await validateCandidate(
      transaction,
      binding,
      selected.verificationId,
      now
    );
    return selected;
  });
}

/** Lazily establishes only v1; later versions always require explicit CAS. */
export async function resolveOrInitializeSelectedArtifactVersion(
  db: WorkbenchDb,
  rawInput: ArtifactVersionSelectionBinding & { now?: Date | string }
): Promise<WorkbenchArtifactSelectionRecord | null> {
  const binding = normalizeBinding(rawInput);
  const now = normalizeDate(rawInput.now ?? new Date(), "now");
  const existing = await resolveSelectedArtifactVersion(db, { ...binding, now });
  if (existing) return existing;
  const candidate = await db.workbenchArtifactVersionRecord.findUnique({
    where: { id: binding.versionId }
  });
  if (!candidate || candidate.version !== 1) return null;
  const verification = await db.workbenchVerificationRecord.findFirst({
    where: {
      taskId: binding.taskId,
      runId: binding.runId,
      subjectType: "artifact_version",
      subjectId: binding.versionId,
      status: "passed",
      containsForumText: false,
      containsIdentity: false,
      observedAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
    },
    orderBy: [{ observedAt: "desc" }, { id: "asc" }]
  });
  if (!verification) return null;
  try {
    return await selectArtifactVersion(db, {
      ...binding,
      verificationId: verification.id,
      expected: null,
      selectedAt: now
    });
  } catch (error) {
    if (
      error instanceof WorkbenchArtifactSelectionError &&
      error.code === "WORKBENCH_ARTIFACT_SELECTION_CONFLICT"
    ) {
      return resolveSelectedArtifactVersion(db, { ...binding, now });
    }
    throw error;
  }
}
