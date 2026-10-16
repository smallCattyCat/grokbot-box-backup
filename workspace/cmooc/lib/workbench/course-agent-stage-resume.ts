import {
  assertEvidenceRefs,
  hashCourseToolValue,
  isSafeIdentifier,
  isSha256,
  type EvidenceRef
} from "@/lib/course-tools/contracts";

export const COURSE_AGENT_STAGE_DELIVERY_RESUME_SCHEMA_VERSION =
  "cmooc.course-agent-stage-delivery-resume.v1" as const;

type SucceededStageActionBinding = Readonly<{
  callId: string;
  toolName:
    | "platform.editor.stage_verify_clear"
    | "platform.editor.reconcile_stage";
  terminalReceiptHash: string | null;
}>;

type DurableStageToolReceipt = Readonly<{
  id: string;
  callId: string;
  status: string;
  outputHash: string;
  verificationId: string | null;
  evidenceRefsJson: string;
  containsForumText: boolean;
  containsIdentity: boolean;
}>;

type DurableStageVerification = Readonly<{
  id: string;
  status: string;
}>;

function fail(code: string): never {
  throw new Error(code);
}

function parseExactEvidenceRefs(value: string): readonly EvidenceRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail("COURSE_AGENT_STAGE_RESUME_EVIDENCE_INVALID");
  }
  if (!Array.isArray(parsed)) {
    fail("COURSE_AGENT_STAGE_RESUME_EVIDENCE_INVALID");
  }
  for (const candidate of parsed) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.keys(candidate).sort().join("\0") !==
        ["hash", "id", "kind", "observedAt"].join("\0")
    ) {
      fail("COURSE_AGENT_STAGE_RESUME_EVIDENCE_INVALID");
    }
  }
  try {
    assertEvidenceRefs(parsed as readonly EvidenceRef[]);
  } catch {
    fail("COURSE_AGENT_STAGE_RESUME_EVIDENCE_INVALID");
  }
  return Object.freeze(
    (parsed as readonly EvidenceRef[]).map((ref) => Object.freeze({ ...ref }))
  );
}

/**
 * Reconstructs only the safe opaque stage receipt reference for an interrupted
 * post-approval response. It binds the action terminal hash to the exact
 * durable tool receipt and its passed verifier; it never reads tool output or
 * platform content.
 */
export function extractStageVerificationRefFromDurableReceipt(input: Readonly<{
  action: SucceededStageActionBinding;
  receipt: DurableStageToolReceipt;
  verification: DurableStageVerification;
}>): string {
  const { action, receipt, verification } = input;
  if (
    (action.toolName !== "platform.editor.stage_verify_clear" &&
      action.toolName !== "platform.editor.reconcile_stage") ||
    !isSafeIdentifier(action.callId) ||
    !action.terminalReceiptHash ||
    !isSha256(action.terminalReceiptHash) ||
    receipt.callId !== action.callId ||
    receipt.status !== "succeeded" ||
    !isSafeIdentifier(receipt.id) ||
    !isSha256(receipt.outputHash) ||
    !receipt.verificationId ||
    receipt.verificationId !== verification.id ||
    receipt.containsForumText !== false ||
    receipt.containsIdentity !== false
  ) {
    fail("COURSE_AGENT_STAGE_RESUME_RECEIPT_INVALID");
  }
  if (
    !isSafeIdentifier(verification.id) ||
    verification.status !== "passed"
  ) {
    fail("COURSE_AGENT_STAGE_RESUME_VERIFICATION_INVALID");
  }
  const expectedTerminalHash = hashCourseToolValue(
    "cmooc.course-agent-terminal-tool-receipt.v1",
    {
      receiptId: receipt.id,
      callId: receipt.callId,
      status: "succeeded",
      outputHash: receipt.outputHash,
      verificationId: receipt.verificationId
    }
  );
  if (expectedTerminalHash !== action.terminalReceiptHash) {
    fail("COURSE_AGENT_STAGE_RESUME_RECEIPT_MISMATCH");
  }

  const stageRefs = parseExactEvidenceRefs(receipt.evidenceRefsJson).filter(
    (ref) => ref.kind === "stage_receipt"
  );
  if (stageRefs.length !== 1 || !isSafeIdentifier(stageRefs[0]!.id)) {
    fail("COURSE_AGENT_STAGE_RESUME_EVIDENCE_INVALID");
  }
  return stageRefs[0]!.id;
}

/** Safe server-built handoff for the one remaining delivery tool call. */
export function buildVerifiedStageDeliveryResumePrompt(
  stageVerificationRef: string
): string {
  if (!isSafeIdentifier(stageVerificationRef)) {
    fail("COURSE_AGENT_STAGE_VERIFICATION_REF_INVALID");
  }
  const envelope = JSON.stringify({
    schemaVersion: COURSE_AGENT_STAGE_DELIVERY_RESUME_SCHEMA_VERSION,
    nextTool: "delivery.bundle.create",
    stageVerificationRef,
    publicationStatus: "not_published",
    realPublishEnabled: false
  });
  return [
    "服务端已验证完成当前 canonical STAGE 步骤，且编辑器已清空，发布与通知均为 0。",
    envelope,
    "请仅继续当前计划的下一步 delivery.bundle.create，并将上述 stageVerificationRef 原样用于工具输入；不得重放任何已完成工具。"
  ].join("\n");
}
