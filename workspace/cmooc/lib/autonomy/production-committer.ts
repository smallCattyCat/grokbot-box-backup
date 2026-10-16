import type {
  ExecutionAttempt,
  PrismaClient
} from "@prisma/client";
import type {
  CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  fetchCmoocPostDetail,
  findNewPublishedCommentEvidence,
  publishCmoocPostComment,
  type CmoocApiComment
} from "@/lib/forum/cmooc-api";
import {
  issueRealForumWriteGrant,
  runWithRealForumWriteGrant,
  type RealForumWriteMutationBinding
} from "@/lib/forum/real-write-lock";
import {
  hashTransientDraftBody
} from "@/lib/live-runtime/draft-content";
import {
  abortPreparedExecutionAttempt,
  claimExecutionPermit,
  markExecutionAttemptSending,
  settleExecutionAttemptReal,
  type BoundPreExecutionTargetObservation
} from "./execution-permit";
import {
  hashCommentBaseline,
  hashTransientRemoteEvidence,
  type TransientCmoocExecutionTarget
} from "./execution-target";

const OPAQUE_HASH = /^[a-f0-9]{64}$/;

type ProductionAccountBindingRefs = {
  executionAccountLeaseId?: string | null;
  executionAccountRefHash?: string | null;
  credentialRefHash?: string | null;
};

/**
 * Verify that the account chosen during the write-time locate is exactly the
 * account persisted on the permit and attempt.  This guard is deliberately
 * pure so callers/tests can exercise the no-send boundary without a DB or
 * remote platform.
 */
export function assertProductionAccountBinding(input: {
  target: ProductionAccountBindingRefs &
    Pick<TransientCmoocExecutionTarget, "token" | "writeToken">;
  permit: ProductionAccountBindingRefs;
  attempt: { executionAccountRefHash?: string | null };
}): void {
  const permitValues = [
    input.permit.executionAccountLeaseId,
    input.permit.executionAccountRefHash,
    input.permit.credentialRefHash
  ];
  const permitBound = permitValues.some(
    (value) => value !== undefined && value !== null
  );
  const targetValues = [
    input.target.executionAccountLeaseId,
    input.target.executionAccountRefHash,
    input.target.credentialRefHash
  ];
  const targetBound = targetValues.some(
    (value) => value !== undefined && value !== null
  );
  const attemptRef = input.attempt.executionAccountRefHash;
  if (!permitBound) {
    if (
      targetBound ||
      input.target.writeToken !== undefined ||
      (attemptRef !== undefined && attemptRef !== null)
    ) {
      throw new Error("PRODUCTION_COMMIT_ACCOUNT_BINDING_MISMATCH");
    }
    return;
  }
  if (
    permitValues.some(
      (value) => typeof value !== "string" || !OPAQUE_HASH.test(value)
    ) ||
    targetValues.some(
      (value) => typeof value !== "string" || !OPAQUE_HASH.test(value)
    ) ||
    input.target.executionAccountLeaseId !==
      input.permit.executionAccountLeaseId ||
    input.target.executionAccountRefHash !==
      input.permit.executionAccountRefHash ||
    input.target.credentialRefHash !==
      input.permit.credentialRefHash ||
    attemptRef !== input.permit.executionAccountRefHash ||
    !input.target.writeToken ||
    input.target.writeToken.source !== "partner_account" ||
    input.target.writeToken.accountRefHash !==
      input.permit.executionAccountRefHash ||
    input.target.writeToken.credentialRefHash !==
      input.permit.credentialRefHash ||
    input.target.token !== undefined && input.target.token !== null
  ) {
    throw new Error("PRODUCTION_COMMIT_ACCOUNT_BINDING_MISMATCH");
  }
}

function targetWriteToken(target: TransientCmoocExecutionTarget): string {
  if (target.writeToken) {
    return target.writeToken.token;
  }
  if (typeof target.token === "string" && target.token.length > 0) {
    return target.token;
  }
  throw new Error("PRODUCTION_COMMIT_ACCOUNT_BINDING_MISMATCH");
}

export type ProductionCommitResult = {
  status: "confirmed_published";
  attemptId: string;
  permitKey: string;
  remoteOutcomeHash: string;
  recoveredByReconciliation: boolean;
  requestedMutationCount: 1;
  sentMutationCount: 1;
  containsForumText: false;
};

export class ProductionCommitError extends Error {
  constructor(
    readonly code:
      | "PRODUCTION_COMMIT_REPLAY_BLOCKED"
      | "PRODUCTION_COMMIT_ABORTED_BEFORE_SEND"
      | "PRODUCTION_COMMIT_OUTCOME_UNKNOWN"
  ) {
    super(code);
    this.name = "ProductionCommitError";
  }
}

function safeResult(input: {
  attempt: ExecutionAttempt;
  permitKey: string;
  recoveredByReconciliation: boolean;
}): ProductionCommitResult {
  if (
    input.attempt.status !== "confirmed_published" ||
    !input.attempt.remoteOutcomeHash ||
    input.attempt.requestedMutationCount !== 1 ||
    input.attempt.sentMutationCount !== 1
  ) {
    throw new Error("PRODUCTION_COMMIT_RESULT_NOT_CONFIRMED");
  }
  return {
    status: "confirmed_published",
    attemptId: input.attempt.id,
    permitKey: input.permitKey,
    remoteOutcomeHash: input.attempt.remoteOutcomeHash,
    recoveredByReconciliation:
      input.recoveredByReconciliation,
    requestedMutationCount: 1,
    sentMutationCount: 1,
    containsForumText: false
  };
}

async function reconcilePublishedComment(input: {
  target: TransientCmoocExecutionTarget;
  token: string;
  transientBody: string;
  baseline: CmoocApiComment[];
  secret: Buffer | string;
  contentHash: string;
  targetHash: string;
  wait: (milliseconds: number) => Promise<void>;
}): Promise<
  | { state: "confirmed_published"; remoteEvidenceHash: string }
  | { state: "outcome_unknown"; remoteEvidenceHash: string }
> {
  const baselineHash = hashCommentBaseline({
    secret: input.secret,
    comments: input.baseline
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await input.wait(1_000);
    try {
      const detail = await fetchCmoocPostDetail({
        postUrl: input.target.postUrl,
        token: input.token,
        expectedCourseId: input.target.courseId
      });
      if (!detail) continue;
      const matched = findNewPublishedCommentEvidence({
        before: input.baseline,
        after: detail.comments,
        content: input.transientBody,
        expectedParentId: null
      });
      if (matched) {
        return {
          state: "confirmed_published",
          remoteEvidenceHash: hashTransientRemoteEvidence({
            secret: input.secret,
            schemaVersion:
              "cmooc.production-remote-reconciliation.v1",
            value: {
              baselineHash,
              matchedCommentId: matched.id,
              afterCommentCount: detail.comments.length,
              contentHash: input.contentHash,
              targetHash: input.targetHash,
              uniqueMatchCount: 1,
              containsForumText: false
            }
          })
        };
      }
    } catch {
      // A failed read cannot justify a retry or a negative outcome.
    }
  }
  return {
    state: "outcome_unknown",
    remoteEvidenceHash: hashTransientRemoteEvidence({
      secret: input.secret,
      schemaVersion: "cmooc.production-remote-outcome-unknown.v1",
      value: {
        baselineHash,
        contentHash: input.contentHash,
        targetHash: input.targetHash,
        reconciliationReadCount: 3,
        containsForumText: false
      }
    })
  };
}

export async function executeCmoocProductionCommit(input: {
  prisma: PrismaClient;
  permitKey: string;
  preExecutionObservation: BoundPreExecutionTargetObservation;
  target: TransientCmoocExecutionTarget;
  transientBody: string;
  signingSecret: Buffer | string;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<ProductionCommitResult> {
  const now = input.now ?? (() => new Date());
  const wait =
    input.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) =>
        setTimeout(resolve, milliseconds)
      ));
  const claimed = await claimExecutionPermit({
    prisma: input.prisma,
    permitKey: input.permitKey,
    transport: "real_platform",
    now: now(),
    preExecutionObservation: input.preExecutionObservation
  });
  if (claimed.idempotent) {
    if (claimed.attempt.status === "confirmed_published") {
      return safeResult({
        attempt: claimed.attempt,
        permitKey: claimed.permit.permitKey,
        recoveredByReconciliation: false
      });
    }
    throw new ProductionCommitError(
      "PRODUCTION_COMMIT_REPLAY_BLOCKED"
    );
  }
  try {
    assertProductionAccountBinding({
      target: input.target,
      permit: claimed.permit,
      attempt: claimed.attempt
    });
  } catch {
    const evidenceHash = hashTransientRemoteEvidence({
      secret: input.signingSecret,
      schemaVersion: "cmooc.production-preflight-abort.v1",
      value: {
        attemptId: claimed.attempt.id,
        reason: "account_binding_mismatch",
        containsForumText: false
      }
    });
    await abortPreparedExecutionAttempt({
      prisma: input.prisma,
      attemptId: claimed.attempt.id,
      evidenceHash,
      now: now()
    });
    throw new ProductionCommitError(
      "PRODUCTION_COMMIT_ABORTED_BEFORE_SEND"
    );
  }
  const targetToken = targetWriteToken(input.target);
  if (
    hashTransientDraftBody(input.transientBody) !==
      claimed.permit.contentHash ||
    input.target.threadKey !==
      input.preExecutionObservation.receipt.threadKey ||
    input.target.targetVersionHash !==
      claimed.permit.targetVersionHash ||
    input.target.eventSetHash !==
      input.preExecutionObservation.receipt.eventSetHash
  ) {
    const evidenceHash = hashTransientRemoteEvidence({
      secret: input.signingSecret,
      schemaVersion: "cmooc.production-preflight-abort.v1",
      value: {
        attemptId: claimed.attempt.id,
        reason: "transient_binding_mismatch",
        containsForumText: false
      }
    });
    await abortPreparedExecutionAttempt({
      prisma: input.prisma,
      attemptId: claimed.attempt.id,
      evidenceHash,
      now: now()
    });
    throw new ProductionCommitError(
      "PRODUCTION_COMMIT_ABORTED_BEFORE_SEND"
    );
  }
  const binding: RealForumWriteMutationBinding = {
    permitKey: claimed.permit.permitKey,
    attemptId: claimed.attempt.id,
    idempotencyKey: claimed.permit.idempotencyKey,
    targetHash: claimed.permit.targetHash,
    contentHash: claimed.permit.contentHash,
    containsForumText: false
  };
  const grantedAt = now();
  const grant = issueRealForumWriteGrant({
    binding,
    signingSecret: input.signingSecret,
    now: grantedAt,
    expiresAt: new Date(
      Math.min(
        claimed.permit.expiresAt.getTime(),
        grantedAt.getTime() + 60_000
      )
    )
  });
  let baseline = input.target.comments;
  let mutationMarked = false;
  try {
    const published = await runWithRealForumWriteGrant({
      grant,
      signingSecret: input.signingSecret,
      binding,
      now: grantedAt,
      currentTime: now,
      requireConsumption: true,
      action: async () =>
        publishCmoocPostComment({
          postUrl: input.target.postUrl,
          content: input.transientBody,
          token: targetToken,
          courseId: input.target.courseId,
          writeBinding: binding,
          allowCourseJoinRetry: false,
          onBeforeMutation: async ({ beforeComments }) => {
            if (mutationMarked) {
              throw new Error(
                "PRODUCTION_MUTATION_CALLBACK_REPEATED"
              );
            }
            baseline = beforeComments;
            const sending = await markExecutionAttemptSending({
              prisma: input.prisma,
              attemptId: claimed.attempt.id,
              now: now(),
              preExecutionObservation: input.preExecutionObservation
            });
            if (sending.idempotent) {
              throw new Error(
                "PRODUCTION_MUTATION_ALREADY_MARKED"
              );
            }
            mutationMarked = true;
          }
        })
    });
    if (!mutationMarked) {
      throw new Error("PRODUCTION_MUTATION_NOT_MARKED");
    }
    const remoteEvidenceHash = hashTransientRemoteEvidence({
      secret: input.signingSecret,
      schemaVersion: "cmooc.production-remote-confirmation.v1",
      value: {
        baselineHash: hashCommentBaseline({
          secret: input.signingSecret,
          comments: baseline
        }),
        publishedUrl: published.publishedUrl,
        moduleId: published.moduleId,
        commentId: published.commentId,
        beforeCommentCount: published.beforeCommentCount,
        afterCommentCount: published.afterCommentCount,
        contentHash: claimed.permit.contentHash,
        targetHash: claimed.permit.targetHash,
        transport: published.transport,
        containsForumText: false
      } as unknown as CanonicalJsonValue
    });
    const settled = await settleExecutionAttemptReal({
      prisma: input.prisma,
      attemptId: claimed.attempt.id,
      state: "confirmed_published",
      remoteEvidenceHash,
      now: now()
    });
    return safeResult({
      attempt: settled.attempt,
      permitKey: settled.permit.permitKey,
      recoveredByReconciliation: false
    });
  } catch {
    const current =
      await input.prisma.executionAttempt.findUniqueOrThrow({
        where: { id: claimed.attempt.id }
      });
    if (
      current.status === "confirmed_published" &&
      current.remoteOutcomeHash
    ) {
      return safeResult({
        attempt: current,
        permitKey: claimed.permit.permitKey,
        recoveredByReconciliation: true
      });
    }
    if (
      current.status === "prepared_real" &&
      current.sentMutationCount === 0
    ) {
      const evidenceHash = hashTransientRemoteEvidence({
        secret: input.signingSecret,
        schemaVersion: "cmooc.production-pre-send-failure.v1",
        value: {
          attemptId: current.id,
          contentHash: claimed.permit.contentHash,
          targetHash: claimed.permit.targetHash,
          containsForumText: false
        }
      });
      await abortPreparedExecutionAttempt({
        prisma: input.prisma,
        attemptId: current.id,
        evidenceHash,
        now: now()
      });
      throw new ProductionCommitError(
        "PRODUCTION_COMMIT_ABORTED_BEFORE_SEND"
      );
    }
    if (
      current.status !== "sending_real" ||
      current.sentMutationCount !== 1
    ) {
      throw new ProductionCommitError(
        "PRODUCTION_COMMIT_OUTCOME_UNKNOWN"
      );
    }
    const reconciled = await reconcilePublishedComment({
      target: input.target,
      token: targetToken,
      transientBody: input.transientBody,
      baseline,
      secret: input.signingSecret,
      contentHash: claimed.permit.contentHash,
      targetHash: claimed.permit.targetHash,
      wait
    });
    const settled = await settleExecutionAttemptReal({
      prisma: input.prisma,
      attemptId: current.id,
      state: reconciled.state,
      remoteEvidenceHash: reconciled.remoteEvidenceHash,
      now: now()
    });
    if (reconciled.state === "confirmed_published") {
      return safeResult({
        attempt: settled.attempt,
        permitKey: settled.permit.permitKey,
        recoveredByReconciliation: true
      });
    }
    throw new ProductionCommitError(
      "PRODUCTION_COMMIT_OUTCOME_UNKNOWN"
    );
  }
}
