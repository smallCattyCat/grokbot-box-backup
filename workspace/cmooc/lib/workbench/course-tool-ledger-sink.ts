import {
  type CourseToolExecutionSink,
  type CourseToolVerificationReport,
  type DurableToolCallProjection,
  type DurableToolCallStartProjection,
  type EvidenceRef,
  type ToolReceiptCommitFence,
  type ToolVerificationCommitContext
} from "@/lib/course-tools/contracts";
import {
  appendToolCall,
  commitToolReceipt,
  recordVerification,
  type DurableEvidenceRef,
  type WorkbenchDb
} from "@/lib/workbench/durable-ledger";

export const COURSE_TOOL_LEDGER_SINK_SCHEMA_VERSION =
  "cmooc.course-tool-ledger-sink.v1" as const;

export class CourseToolLedgerSinkError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CourseToolLedgerSinkError";
    this.code = code;
  }
}

function assertFenceMatches(
  callId: string,
  leaseGeneration: number,
  fence: ToolReceiptCommitFence
): void {
  if (
    fence.callId !== callId ||
    fence.leaseGeneration !== leaseGeneration ||
    !fence.executionLeaseId ||
    !fence.fencingToken
  ) {
    throw new CourseToolLedgerSinkError(
      "COURSE_TOOL_LEDGER_FENCE_MISMATCH",
      "Course tool projection does not match its transient lease fence."
    );
  }
}

function durableEvidenceRefs(
  refs: readonly EvidenceRef[]
): DurableEvidenceRef[] {
  return refs.map((ref) => ({
    kind: ref.kind,
    id: ref.id,
    hash: ref.hash,
    observedAt: ref.observedAt
  }));
}

function distinctEvidenceRefs(
  report: CourseToolVerificationReport
): DurableEvidenceRef[] {
  const refs = new Map<string, DurableEvidenceRef>();
  for (const receipt of report.receipts) {
    for (const ref of receipt.evidenceRefs) {
      const durable = durableEvidenceRefs([ref])[0]!;
      refs.set(
        `${durable.kind}\0${durable.id}\0${durable.hash}\0${durable.observedAt}`,
        durable
      );
    }
  }
  return [...refs.values()];
}

function earliestExpiry(
  report: CourseToolVerificationReport
): string | undefined {
  const expiries = report.receipts
    .flatMap((receipt) =>
      receipt.expiresAt ? [receipt.expiresAt] : []
    )
    .sort();
  return expiries[0];
}

function verificationSummary(
  report: CourseToolVerificationReport
): string {
  const checkCount = report.receipts.reduce(
    (total, receipt) => total + receipt.checks.length,
    0
  );
  if (report.status === "passed") {
    return `工具后置条件已通过 ${checkCount} 项机械检查。`;
  }
  if (report.status === "failed") {
    return `工具后置条件未通过；已记录 ${checkCount} 项安全检查。`;
  }
  return `工具后置条件仍为未知；已记录 ${checkCount} 项安全检查。`;
}

/**
 * Maps the generic tool runtime to the ordinary safe ledger. This adapter
 * never persists transient output, model projections, course bodies, raw
 * fencing tokens, or handler errors.
 */
export class DurableCourseToolExecutionSink
implements CourseToolExecutionSink {
  readonly #db: WorkbenchDb;
  readonly #now: () => Date;

  constructor(
    db: WorkbenchDb,
    options: Readonly<{ now?: () => Date }> = {}
  ) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
  }

  async appendToolCall(
    projection: DurableToolCallStartProjection,
    fence: ToolReceiptCommitFence
  ): Promise<"accepted" | "duplicate"> {
    assertFenceMatches(
      projection.id,
      projection.leaseGeneration,
      fence
    );
    const claimed = await appendToolCall(this.#db, {
      id: projection.id,
      taskId: projection.taskId,
      runId: projection.runId,
      stepId: projection.stepId,
      executionLeaseId: fence.executionLeaseId,
      toolName: projection.toolName,
      toolVersion: projection.toolVersion,
      capability: projection.capability,
      effectClass: projection.effectClass,
      safeInputSummary: projection.safeInputSummary,
      inputHash: projection.inputHash,
      idempotencyKey: projection.idempotencyKey,
      attempt: projection.attempt,
      grantRef: projection.grantRef,
      leaseGeneration: fence.leaseGeneration,
      fencingToken: fence.fencingToken,
      causationId: projection.causationId,
      createdAt: projection.createdAt
    });
    return claimed.disposition;
  }

  async recordVerification(
    report: CourseToolVerificationReport,
    context: ToolVerificationCommitContext
  ): Promise<void> {
    if (
      !report.receipts.length ||
      report.receipts.some(
        (receipt) =>
          receipt.subjectType !== report.subjectType ||
          receipt.subjectId !== report.subjectId
      )
    ) {
      throw new CourseToolLedgerSinkError(
        "COURSE_TOOL_VERIFICATION_REPORT_INVALID",
        "Course tool verification report has no coherent receipts."
      );
    }
    await recordVerification(this.#db, {
      id: report.id,
      taskId: context.taskId,
      runId: context.runId,
      subjectType: report.subjectType,
      subjectId: report.subjectId,
      verifier: "verification.course_tool_registry",
      verifierVersion: "1",
      status: report.status,
      safeSummary: verificationSummary(report),
      checks: report.receipts.flatMap((receipt) =>
        receipt.checks.map((check) => ({
          code: `${receipt.verifier}.${check.code}`,
          status: check.status,
          safeSummary: check.safeSummary
        }))
      ),
      evidenceRefs: distinctEvidenceRefs(report),
      observedAt: report.observedAt,
      expiresAt: earliestExpiry(report),
      executionLeaseId: context.executionLeaseId,
      stepId: context.stepId,
      leaseGeneration: context.leaseGeneration,
      fencingToken: context.fencingToken,
      committedAt: this.#now()
    });
  }

  async commitToolReceipt(
    projection: DurableToolCallProjection,
    fence: ToolReceiptCommitFence
  ): Promise<void> {
    assertFenceMatches(
      projection.callId,
      fence.leaseGeneration,
      fence
    );
    await commitToolReceipt(this.#db, {
      id: projection.receiptId,
      callId: projection.callId,
      status: projection.status,
      safeOutputSummary: projection.safeOutputSummary,
      outputHash: projection.outputHash,
      evidenceRefs: durableEvidenceRefs(projection.evidenceRefs),
      beforeRef: projection.beforeRef,
      afterRef: projection.afterRef,
      verificationId: projection.verificationId,
      compensationRef: projection.compensationRef,
      observedAt: projection.observedAt,
      leaseGeneration: fence.leaseGeneration,
      fencingToken: fence.fencingToken,
      committedAt: this.#now()
    });
  }
}
