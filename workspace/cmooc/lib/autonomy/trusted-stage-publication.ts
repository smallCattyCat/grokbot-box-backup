import type { PrismaClient } from "@prisma/client";
import { canonicalProtocolHash } from "@/lib/facilitation-protocol";
import {
  executeTrustedBrowserStage
} from "./one-shot-stage";
import {
  executeOneShotPublication
} from "./one-shot-runner";
import {
  relockOneShotPolicy,
  TRUSTED_ONE_SHOT_DAILY_ACTION_LIMIT,
  type OneShotPublicationHandoff
} from "./one-shot-execution";
import { assertTrustedStagePublishGuards } from "./one-shot-publish-guard";

export { assertTrustedStagePublishGuards } from "./one-shot-publish-guard";

export type TrustedStagePublicationProjection = {
  status:
    | "confirmed_published"
    | "confirmed_not_published"
    | "outcome_unknown";
  stageStatus: "verified_cleared";
  selectionHash: string;
  policyVersionHash: string;
  stageReceiptHash: string;
  publicationOutcomeHash: string | null;
  requestedMutationCount: number;
  sentMutationCount: number;
  editorWriteCount: number;
  editorClearCount: number;
  publishAttempted: boolean;
  recoveredByReconciliation: boolean;
  outcomeWindowsPresent: boolean;
  outcomeWindowsCreated: number;
  outcomeWindowsExisting: number;
  containsForumText: false;
};

/**
 * The handoff sequence is deliberately dependency-injected.  Production uses
 * the real Prisma/browser calls below; tests can exercise ownership, error
 * preservation and the no-retry property with in-memory fakes.
 */
export async function runTrustedStageAndPublishSequence<
  TStage extends {
    policyRetainedForImmediatePublication: boolean;
    handoff: OneShotPublicationHandoff;
    status: string;
    receiptHash: string;
    editorWriteCount: number;
    editorClearCount: number;
    sentMutationCount: number;
    publishAttempted: boolean;
  },
  TPublication extends {
    status: string;
    requestedMutationCount: number;
    sentMutationCount: number;
  }
>(input: {
  stage: () => Promise<TStage>;
  publish: (handoff: OneShotPublicationHandoff) => Promise<TPublication>;
  relock: (handoff: OneShotPublicationHandoff) => Promise<unknown>;
}): Promise<{
  stage: TStage;
  publication: TPublication;
  handoff: OneShotPublicationHandoff;
}> {
  let handoff: OneShotPublicationHandoff | null = null;
  let rootError: unknown = null;
  try {
    const stage = await input.stage();
    if (
      stage.policyRetainedForImmediatePublication !== true ||
      !stage.handoff ||
      typeof stage.handoff.decisionId !== "string" ||
      typeof stage.handoff.selectionHash !== "string" ||
      typeof stage.handoff.policyVersion !== "string" ||
      stage.handoff.decisionId.length === 0 ||
      stage.handoff.selectionHash.length === 0 ||
      stage.handoff.policyVersion.length === 0
    ) {
      throw new Error("L3_TRUSTED_STAGE_HANDOFF_NOT_RETAINED");
    }
    handoff = stage.handoff;
    if (
      stage.status !== "verified_cleared" ||
      stage.receiptHash.length === 0 ||
      stage.editorWriteCount !== 1 ||
      stage.editorClearCount !== 1 ||
      stage.sentMutationCount !== 0 ||
      stage.publishAttempted !== false
    ) {
      throw new Error("L3_TRUSTED_STAGE_FACTS_INVALID");
    }
    // Exactly one publication call.  There is intentionally no retry loop,
    // including for outcome_unknown, which remains a durable stop state.
    const publication = await input.publish(handoff);
    if (publication.status === "outcome_unknown") {
      throw new Error("L3_STAGE_PUBLISH_OUTCOME_UNKNOWN");
    }
    if (
      publication.status !== "confirmed_published" ||
      publication.requestedMutationCount !== 1 ||
      publication.sentMutationCount !== 1
    ) {
      throw new Error("L3_STAGE_PUBLISH_NOT_CONFIRMED");
    }
    return { stage, publication, handoff };
  } catch (error) {
    rootError = error;
    throw error;
  } finally {
    if (handoff !== null) {
      try {
        const relocked = await input.relock(handoff);
        if (
          !relocked ||
          typeof relocked !== "object" ||
          !("manifestLocked" in relocked) ||
          !("globalHardLock" in relocked) ||
          (relocked as { manifestLocked?: unknown }).manifestLocked !== true ||
          (relocked as { globalHardLock?: unknown }).globalHardLock !== true
        ) {
          throw new Error("L3_STAGE_PUBLISH_RELOCK_FAILED");
        }
      } catch {
        if (
          rootError instanceof Error &&
          (("code" in rootError &&
            (rootError as { code?: unknown }).code ===
              "PRODUCTION_COMMIT_OUTCOME_UNKNOWN") ||
            rootError.message === "PRODUCTION_COMMIT_OUTCOME_UNKNOWN" ||
            rootError.message === "L3_STAGE_PUBLISH_OUTCOME_UNKNOWN")
        ) {
          throw rootError;
        }
        // A cleanup failure is intentionally a stable fail-closed result.  It
        // supersedes the root stage/publication error; successful cleanup
        // leaves the original error untouched.
        throw new Error("L3_STAGE_PUBLISH_RELOCK_FAILED");
      }
    }
  }
}

function safePolicyVersionHash(policyVersion: string): string {
  return canonicalProtocolHash(
    "cmooc.l3-policy-version-output.v1",
    { policyVersion, containsForumText: false }
  );
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function assertSafeHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new Error("L3_STAGE_PUBLISH_OUTPUT_INVALID");
  }
}

function assertNonNegativeSafeInteger(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("L3_STAGE_PUBLISH_OUTPUT_INVALID");
  }
}

function fixedPublicationStatus(value: unknown):
  | TrustedStagePublicationProjection["status"] {
  if (
    value === "confirmed_published" ||
    value === "confirmed_not_published" ||
    value === "outcome_unknown"
  ) {
    return value;
  }
  // Production results are constrained by the committer.  Keep projection
  // total and enum-only if a test fake supplies an unexpected status.
  return "outcome_unknown";
}

/** Strict, redacted projection for the stage-and-publish CLI result. */
export function projectTrustedStagePublicationResult(input: {
  handoff: OneShotPublicationHandoff;
  stage: {
    status: string;
    receiptHash: string;
    editorWriteCount: number;
    editorClearCount: number;
    sentMutationCount: number;
    publishAttempted: boolean;
  };
  publication: {
    status: string;
    remoteOutcomeHash?: string | null;
    requestedMutationCount?: number;
    sentMutationCount?: number;
    recoveredByReconciliation?: boolean;
    outcomeWindowsPresent?: boolean;
    outcomeWindowsCreated?: number;
    outcomeWindowsExisting?: number;
  };
}): TrustedStagePublicationProjection {
  assertSafeHash(input.handoff.selectionHash);
  assertSafeHash(input.stage.receiptHash);
  if (input.publication.remoteOutcomeHash !== null) {
    assertSafeHash(input.publication.remoteOutcomeHash);
  }
  if (
    input.stage.status !== "verified_cleared" ||
    input.stage.editorWriteCount !== 1 ||
    input.stage.editorClearCount !== 1 ||
    input.stage.sentMutationCount !== 0 ||
    input.stage.publishAttempted !== false ||
    input.publication.status !== "confirmed_published" ||
    input.publication.requestedMutationCount !== 1 ||
    input.publication.sentMutationCount !== 1
  ) {
    throw new Error("L3_STAGE_PUBLISH_OUTPUT_INVALID");
  }
  assertNonNegativeSafeInteger(
    input.publication.outcomeWindowsCreated ?? 0
  );
  assertNonNegativeSafeInteger(
    input.publication.outcomeWindowsExisting ?? 0
  );
  return {
    status: fixedPublicationStatus(input.publication.status),
    stageStatus: "verified_cleared",
    selectionHash: input.handoff.selectionHash,
    policyVersionHash: safePolicyVersionHash(input.handoff.policyVersion),
    stageReceiptHash: input.stage.receiptHash,
    publicationOutcomeHash: input.publication.remoteOutcomeHash ?? null,
    requestedMutationCount: input.publication.requestedMutationCount ?? 0,
    sentMutationCount: input.publication.sentMutationCount ?? 0,
    editorWriteCount: input.stage.editorWriteCount,
    editorClearCount: input.stage.editorClearCount,
    publishAttempted: input.stage.publishAttempted,
    recoveredByReconciliation:
      input.publication.recoveredByReconciliation ?? false,
    outcomeWindowsPresent: input.publication.outcomeWindowsPresent ?? false,
    outcomeWindowsCreated: input.publication.outcomeWindowsCreated ?? 0,
    outcomeWindowsExisting: input.publication.outcomeWindowsExisting ?? 0,
    containsForumText: false
  };
}

/** Strict projection for a standalone STAGE CLI response. */
export function projectTrustedStageResult(input: {
  status: string;
  receiptHash: string;
  editorWriteCount: number;
  editorClearCount: number;
  sentMutationCount: number;
  publishAttempted: boolean;
  policyRetainedForImmediatePublication: boolean;
}): {
  status: "verified_cleared";
  receiptHash: string;
  editorWriteCount: number;
  editorClearCount: number;
  sentMutationCount: number;
  publishAttempted: boolean;
  policyRetainedForImmediatePublication: boolean;
  containsForumText: false;
} {
  assertSafeHash(input.receiptHash);
  if (
    input.status !== "verified_cleared" ||
    input.editorWriteCount !== 1 ||
    input.editorClearCount !== 1 ||
    input.sentMutationCount !== 0 ||
    input.publishAttempted !== false ||
    input.policyRetainedForImmediatePublication !== false
  ) {
    throw new Error("L3_TRUSTED_STAGE_OUTPUT_INVALID");
  }
  return {
    status: "verified_cleared",
    receiptHash: input.receiptHash,
    editorWriteCount: input.editorWriteCount,
    editorClearCount: input.editorClearCount,
    sentMutationCount: input.sentMutationCount,
    publishAttempted: input.publishAttempted,
    policyRetainedForImmediatePublication:
      input.policyRetainedForImmediatePublication,
    containsForumText: false
  };
}

export async function executeTrustedStageAndPublish(input: {
  prisma: PrismaClient;
  courseAlias: string;
  driverFactory: Parameters<
    typeof executeTrustedBrowserStage
  >[0]["driverFactory"];
  now?: () => Date;
}): Promise<TrustedStagePublicationProjection> {
  assertTrustedStagePublishGuards(process.env);
  const sequence = await runTrustedStageAndPublishSequence({
    stage: () =>
      executeTrustedBrowserStage({
        prisma: input.prisma,
        courseAlias: input.courseAlias,
        driverFactory: input.driverFactory,
        authorizedDailyActionLimit: TRUSTED_ONE_SHOT_DAILY_ACTION_LIMIT,
        validForMinutes: 5,
        retainPolicyForImmediatePublication: true,
        now: input.now
      }),
    publish: (handoff) =>
      executeOneShotPublication({
        prisma: input.prisma,
        courseAlias: input.courseAlias,
        handoff
      }),
    relock: (handoff) =>
      relockOneShotPolicy({
        prisma: input.prisma,
        courseAlias: input.courseAlias,
        ownedPolicyVersion: handoff.policyVersion,
        now: input.now ? input.now() : new Date()
      })
  });
  return projectTrustedStagePublicationResult({
    handoff: sequence.handoff,
    stage: sequence.stage,
    publication: sequence.publication
  });
}
