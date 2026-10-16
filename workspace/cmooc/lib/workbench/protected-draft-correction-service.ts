import { createHash } from "node:crypto";
import type { WorkbenchArtifactVersionRecord } from "@prisma/client";
import {
  FACILITATION_DRAFT_VERIFIER_CONTRACT,
  parseReplyDraftRecoveryMaterialV2,
  type ReplyDraftCreateOutput
} from "@/lib/course-tools/tools/facilitation-artifacts";
import { hashCourseToolValue, type EvidenceRef } from "@/lib/course-tools/contracts";
import { hashTransientDraftBody } from "@/lib/live-runtime/draft-content";
import {
  resolveOrInitializeSelectedArtifactVersion,
  selectArtifactVersion
} from "@/lib/workbench/artifact-selection-store";
import type { WorkbenchDb } from "@/lib/workbench/durable-ledger";
import { getCourseAgentProcessSession } from "@/lib/workbench/course-agent-session";
import {
  consumeProtectedDraftCorrectionSession,
  ProtectedDraftCorrectionError
} from "@/lib/workbench/protected-draft-correction-controller";

const MAX_BODY_CODE_POINTS = 4_000;

export class WorkbenchProtectedDraftCorrectionError extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "WorkbenchProtectedDraftCorrectionError";
  }
}

function fail(code: string, reason: string, message: string): never {
  throw new WorkbenchProtectedDraftCorrectionError(code, reason, message);
}

function parseRecord(value: string, code: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    return fail(code, "prior_contract_invalid", "Prior draft contract is invalid.");
  }
}

function parseEvidence(value: string): readonly EvidenceRef[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed as EvidenceRef[];
  } catch {
    return fail(
      "WORKBENCH_PROTECTED_CORRECTION_PRIOR_INVALID",
      "prior_contract_invalid",
      "Prior draft evidence is invalid."
    );
  }
}

function feedbackRef(input: {
  versionRef: string;
  contentHash: string;
  draftBodyHash: string;
  correctedDraftBodyHash: string;
}): string {
  return `correction-feedback:${hashCourseToolValue(
    "cmooc.protected-draft-correction-feedback.v1",
    input
  )}`;
}

function idempotencyKey(input: {
  taskId: string;
  runId: string;
  versionRef: string;
  correctedDraftBodyHash: string;
}): string {
  return `protected-correction-${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")}`;
}

function pointer(record: WorkbenchArtifactVersionRecord) {
  return Object.freeze({
    artifactId: record.artifactId,
    versionId: record.id,
    artifactRef: `artifact:${record.artifactId}`,
    versionRef: `artifact-version:${record.id}`,
    version: record.version,
    contentHash: record.contentHash
  });
}

function singleSpanDiff(from: string, to: string) {
  let prefix = 0;
  const limit = Math.min(from.length, to.length);
  while (prefix < limit && from[prefix] === to[prefix]) prefix += 1;
  let fromEnd = from.length;
  let toEnd = to.length;
  while (
    fromEnd > prefix &&
    toEnd > prefix &&
    from[fromEnd - 1] === to[toEnd - 1]
  ) {
    fromEnd -= 1;
    toEnd -= 1;
  }
  return Object.freeze(
    [
      prefix ? { kind: "equal" as const, text: from.slice(0, prefix) } : null,
      fromEnd > prefix
        ? { kind: "remove" as const, text: from.slice(prefix, fromEnd) }
        : null,
      toEnd > prefix
        ? { kind: "add" as const, text: to.slice(prefix, toEnd) }
        : null,
      fromEnd < from.length
        ? { kind: "equal" as const, text: from.slice(fromEnd) }
        : null
    ].filter(
      (value): value is { kind: "equal" | "remove" | "add"; text: string } =>
        value !== null
    )
  );
}

export async function correctProtectedWorkbenchDraft(input: {
  db: WorkbenchDb;
  runId: string;
  versionId: string;
  expectedContentHash: string;
  expectedDraftBodyHash: string;
  correctedBody: string;
  now?: Date;
}) {
  if (
    typeof input.correctedBody !== "string" ||
    Array.from(input.correctedBody).length > MAX_BODY_CODE_POINTS
  ) {
    fail(
      "WORKBENCH_PROTECTED_CORRECTION_INPUT_INVALID",
      "corrected_body_invalid",
      "Corrected draft body is invalid."
    );
  }
  const now = input.now ?? new Date();
  const run = await input.db.workbenchRunRecord.findUnique({
    where: { id: input.runId },
    select: { taskId: true }
  });
  if (!run) fail("WORKBENCH_NOT_FOUND", "run_not_found", "Workbench run was not found.");
  const priorRow = await input.db.workbenchArtifactVersionRecord.findFirst({
    where: { id: input.versionId, runId: input.runId, taskId: run.taskId }
  });
  if (!priorRow) {
    fail(
      "WORKBENCH_ARTIFACT_NOT_FOUND",
      "prior_version_not_found",
      "Prior artifact version was not found."
    );
  }
  const priorVersionRef = `artifact-version:${priorRow.id}`;
  if (
    priorRow.artifactKind !== "facilitation_reply_draft" ||
    priorRow.contentClass !== "restricted_transient" ||
    priorRow.contentHash !== input.expectedContentHash ||
    priorRow.draftBodyHash !== input.expectedDraftBodyHash ||
    !priorRow.draftBodyHash ||
    !priorRow.expiresAt ||
    priorRow.expiresAt <= now
  ) {
    fail(
      "WORKBENCH_PROTECTED_CORRECTION_SCOPE_MISMATCH",
      "version_hash_changed_or_expired",
      "Prior artifact is unavailable, changed, or expired."
    );
  }
  const latest = await input.db.workbenchArtifactVersionRecord.findFirst({
    where: { artifactId: priorRow.artifactId },
    orderBy: { version: "desc" },
    select: { id: true }
  });
  if (!latest || latest.id !== priorRow.id) {
    fail(
      "WORKBENCH_PROTECTED_CORRECTION_STALE_VERSION",
      "prior_version_superseded",
      "Only the latest exact artifact version can be corrected."
    );
  }
  const priorSelection = await resolveOrInitializeSelectedArtifactVersion(
    input.db,
    {
      taskId: run.taskId,
      runId: input.runId,
      artifactId: priorRow.artifactId,
      versionId: priorRow.id,
      versionRef: priorVersionRef,
      contentHash: priorRow.contentHash,
      draftBodyHash: priorRow.draftBodyHash,
      now
    }
  );
  if (!priorSelection) {
    fail(
      "WORKBENCH_PROTECTED_CORRECTION_SCOPE_MISMATCH",
      "prior_version_not_selected",
      "Only the exact selected artifact version can be corrected."
    );
  }
  let edit;
  try {
    edit = consumeProtectedDraftCorrectionSession({
      taskId: run.taskId,
      runId: input.runId,
      versionRef: priorVersionRef,
      contentHash: priorRow.contentHash,
      draftBodyHash: priorRow.draftBodyHash,
      now
    });
  } catch (error) {
    if (error instanceof ProtectedDraftCorrectionError) {
      fail(error.code, error.reason, error.message);
    }
    throw error;
  }
  const session = getCourseAgentProcessSession(input.runId, now);
  if (
    !session ||
    session.taskId !== run.taskId ||
    !session.toolkit.correctProtectedDraft
  ) {
    fail(
      "WORKBENCH_PROTECTED_CORRECTION_RUNTIME_UNAVAILABLE",
      "process_session_missing",
      "Protected correction runtime is unavailable."
    );
  }
  const metadata = parseRecord(
    priorRow.metadataJson,
    "WORKBENCH_PROTECTED_CORRECTION_PRIOR_INVALID"
  );
  const recipe = parseRecord(
    priorRow.regenerationRecipeJson ?? "null",
    "WORKBENCH_PROTECTED_CORRECTION_PRIOR_INVALID"
  );
  const compositionRef = metadata.compositionRef;
  const compositionRow =
    typeof compositionRef === "string" && compositionRef.startsWith("artifact-version:")
      ? await input.db.workbenchArtifactVersionRecord.findFirst({
          where: {
            id: compositionRef.slice("artifact-version:".length),
            taskId: run.taskId,
            runId: input.runId
          }
        })
      : null;
  if (!compositionRow) {
    fail(
      "WORKBENCH_PROTECTED_CORRECTION_PRIOR_INVALID",
      "composition_missing",
      "Verified composition for the prior draft is unavailable."
    );
  }
  const prior = parseReplyDraftRecoveryMaterialV2({
    metadata,
    regenerationRecipe: recipe,
    artifact: {
      versionRef: priorVersionRef,
      contentHash: priorRow.contentHash,
      draftBodyHash: priorRow.draftBodyHash,
      expiresAt: priorRow.expiresAt.toISOString()
    },
    composition: {
      versionRef: compositionRef as string,
      intentHash: String(metadata.intentHash ?? ""),
      moveSpecHash: String(metadata.moveSpecHash ?? ""),
      toolPolicyVersion: String(metadata.toolPolicyVersion ?? "")
    }
  });
  if (!prior) {
    fail(
      "WORKBENCH_PROTECTED_CORRECTION_PRIOR_INVALID",
      "prior_contract_invalid",
      "Prior draft failed its closed v2 persistence contract."
    );
  }
  const correctedDraftBodyHash = hashTransientDraftBody(input.correctedBody);
  const correction = await session.toolkit.correctProtectedDraft({
    prior,
    priorVersionRef,
    feedbackRef: feedbackRef({
      versionRef: priorVersionRef,
      contentHash: priorRow.contentHash,
      draftBodyHash: priorRow.draftBodyHash,
      correctedDraftBodyHash
    }),
    evidenceRefs: parseEvidence(priorRow.sourceRefsJson),
    correctedBody: input.correctedBody,
    idempotencyKey: idempotencyKey({
      taskId: run.taskId,
      runId: input.runId,
      versionRef: priorVersionRef,
      correctedDraftBodyHash
    }),
    now: now.toISOString()
  });
  const output: ReplyDraftCreateOutput = correction.output;
  if (
    output.priorVersionRef !== priorVersionRef ||
    output.artifact.artifactId !== priorRow.artifactId ||
    output.artifact.version !== priorRow.version + 1 ||
    output.artifact.draftBodyHash !== correctedDraftBodyHash
  ) {
    fail(
      "WORKBENCH_PROTECTED_CORRECTION_OUTPUT_INVALID",
      "version_binding_invalid",
      "Protected correction did not create the exact next immutable version."
    );
  }
  const verificationId = `protected-correction-verification-${createHash("sha256")
    .update(output.artifact.versionRef, "utf8")
    .digest("hex")}`;
  await input.db.workbenchVerificationRecord.create({
    data: {
      id: verificationId,
      taskId: run.taskId,
      runId: input.runId,
      subjectType: "artifact_version",
      subjectId: output.artifact.versionId,
      verifier: "verification.course_tool_registry",
      verifierVersion: "1",
      status: "passed",
      safeSummary: "Protected draft correction passed exact body, boundary and lint verification.",
      checksJson: JSON.stringify(
        correction.verification.checks.map((check) => ({
          code: `${FACILITATION_DRAFT_VERIFIER_CONTRACT.name}.${check.code}`,
          status: check.status,
          safeSummary: check.safeSummary
        }))
      ),
      evidenceRefsJson: priorRow.sourceRefsJson,
      observedAt: now,
      expiresAt: new Date(output.artifact.expiresAt),
      containsForumText: false,
      containsIdentity: false
    }
  });
  await selectArtifactVersion(input.db, {
    taskId: run.taskId,
    runId: input.runId,
    artifactId: output.artifact.artifactId,
    versionId: output.artifact.versionId,
    versionRef: output.artifact.versionRef,
    contentHash: output.artifact.contentHash,
    draftBodyHash: output.artifact.draftBodyHash,
    verificationId,
    expected: {
      generation: priorSelection.generation,
      selectionHash: priorSelection.selectionHash
    },
    selectedAt: now
  });
  return Object.freeze({
    correction: Object.freeze({
      ...pointer(
        (await input.db.workbenchArtifactVersionRecord.findUniqueOrThrow({
          where: { id: output.artifact.versionId }
        })) as WorkbenchArtifactVersionRecord
      ),
      draftBodyHash: output.artifact.draftBodyHash,
      safeSummary: "Restricted transient facilitation reply draft corrected and verified.",
      verification: Object.freeze({ status: "passed" as const, ref: verificationId }),
      preview: Object.freeze({ status: "available" as const, expiresAt: output.artifact.expiresAt }),
      bodyPersisted: false as const
    }),
    diff: Object.freeze({
      changed: edit.priorBody !== input.correctedBody,
      operations: singleSpanDiff(edit.priorBody, input.correctedBody)
    })
  });
}
