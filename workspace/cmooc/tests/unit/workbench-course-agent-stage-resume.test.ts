import assert from "node:assert/strict";
import { test } from "node:test";
import { hashCourseToolValue } from "../../lib/course-tools/contracts";
import {
  buildVerifiedStageDeliveryResumePrompt,
  extractStageVerificationRefFromDurableReceipt
} from "../../lib/workbench/course-agent-stage-resume";

const CALL_ID = "call-stage-resume-fixture";
const STAGE_REF = "stage-receipt:verified-fixture";
const STAGE_HASH = "a".repeat(64);
const OUTPUT_HASH = "b".repeat(64);
const VERIFICATION_ID = "verification-stage-resume-fixture";

function fixture() {
  const terminalReceiptHash = hashCourseToolValue(
    "cmooc.course-agent-terminal-tool-receipt.v1",
    {
      receiptId: "tool-receipt-stage-resume-fixture",
      callId: CALL_ID,
      status: "succeeded",
      outputHash: OUTPUT_HASH,
      verificationId: VERIFICATION_ID
    }
  );
  return {
    action: {
      callId: CALL_ID,
      toolName: "platform.editor.stage_verify_clear",
      terminalReceiptHash
    },
    receipt: {
      id: "tool-receipt-stage-resume-fixture",
      callId: CALL_ID,
      status: "succeeded",
      outputHash: OUTPUT_HASH,
      verificationId: VERIFICATION_ID,
      evidenceRefsJson: JSON.stringify([
        {
          kind: "artifact",
          id: "artifact-version:fixture",
          hash: "c".repeat(64),
          observedAt: "2026-08-13T16:00:00.000Z"
        },
        {
          kind: "stage_receipt",
          id: STAGE_REF,
          hash: STAGE_HASH,
          observedAt: "2026-08-13T16:00:01.000Z"
        }
      ]),
      containsForumText: false,
      containsIdentity: false
    },
    verification: {
      id: VERIFICATION_ID,
      status: "passed"
    }
  } as const;
}

test("durable succeeded STAGE recovery yields the exact verified stage receipt ref", () => {
  const input = fixture();
  assert.equal(extractStageVerificationRefFromDurableReceipt(input), STAGE_REF);

  const prompt = buildVerifiedStageDeliveryResumePrompt(STAGE_REF);
  assert.match(prompt, /delivery\.bundle\.create/);
  assert.match(prompt, new RegExp(STAGE_REF.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(prompt, new RegExp(input.action.terminalReceiptHash));
  assert.match(prompt, /not_published/);
});

test("durable recovery rejects terminal-hash drift, duplicate stage refs, and failed verification", () => {
  const base = fixture();
  assert.throws(
    () =>
      extractStageVerificationRefFromDurableReceipt({
        ...base,
        action: { ...base.action, terminalReceiptHash: "d".repeat(64) }
      }),
    /COURSE_AGENT_STAGE_RESUME_RECEIPT_MISMATCH/
  );
  assert.throws(
    () =>
      extractStageVerificationRefFromDurableReceipt({
        ...base,
        receipt: {
          ...base.receipt,
          evidenceRefsJson: JSON.stringify([
            ...JSON.parse(base.receipt.evidenceRefsJson),
            {
              kind: "stage_receipt",
              id: "stage-receipt:ambiguous",
              hash: "e".repeat(64),
              observedAt: "2026-08-13T16:00:02.000Z"
            }
          ])
        }
      }),
    /COURSE_AGENT_STAGE_RESUME_EVIDENCE_INVALID/
  );
  assert.throws(
    () =>
      extractStageVerificationRefFromDurableReceipt({
        ...base,
        verification: { ...base.verification, status: "failed" }
      }),
    /COURSE_AGENT_STAGE_RESUME_VERIFICATION_INVALID/
  );
});

test("delivery resume prompt rejects non-opaque or unsafe references", () => {
  assert.throws(
    () => buildVerifiedStageDeliveryResumePrompt("https://platform.example/reply/1"),
    /COURSE_AGENT_STAGE_VERIFICATION_REF_INVALID/
  );
});
