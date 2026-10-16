import type { PrismaClient } from "@prisma/client";
import {
  resolveCmoocApiWriteToken as resolveCmoocApiWriteTokenForAccount,
  type CmoocApiWriteToken
} from "@/lib/forum/cmooc-api";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  hashTransientDraftBody
} from "@/lib/live-runtime/draft-content";
import {
  hashTransientRemoteEvidence,
  locateTransientExecutionTarget
} from "./execution-target";
import {
  loadCourseManifest,
  type CourseManifest
} from "./course-manifest";
import {
  appendExecutionReceiptCommittedTape,
  appendExecutionPolicyRelockedTape,
  appendPostExecutionObservedTape
} from "./one-shot-runner";
import {
  rebuildDeterministicSemanticDraft
} from "./semantic-renderer";
import {
  relockOneShotPolicy
} from "./one-shot-execution";
import {
  PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
  reconcileOutcomeUnknownExecutionAttempt
} from "./execution-permit";

export const L3_OUTCOME_RECONCILIATION_INCONCLUSIVE =
  "L3_OUTCOME_RECONCILIATION_INCONCLUSIVE" as const;

const MAX_REMOTE_READ_ATTEMPTS = 5;
const REQUIRED_SUCCESSFUL_REMOTE_READS = 3;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PRODUCTION_RECEIPT_KEYS = new Set([
  "schemaVersion",
  "permitKey",
  "idempotencyKey",
  "targetHash",
  "targetVersionHash",
  "contentHash",
  "state",
  "observedAt",
  "remoteEvidenceHash",
  "requestedMutationCount",
  "sentMutationCount",
  "publishAttempted",
  "realPublishEnabled",
  "bodyPersisted",
  "containsForumText"
]);

export type OneShotOutcomeReconciliationTarget = {
  postUrl: string;
  threadKey: string;
  targetVersionHash: string;
  eventSetHash: string;
  comments: readonly unknown[];
  token?: string | null;
  writeToken?: CmoocApiWriteToken;
  executionAccountLeaseId?: string | null;
  executionAccountRefHash?: string | null;
  credentialRefHash?: string | null;
};

export type OneShotOutcomeReconciliationSnapshot = {
  attempt: {
    id: string;
    decisionId: string;
    permitId: string | null;
    mode: string;
    status: string;
    transport: string;
    idempotencyKey: string;
    receiptJson: string;
    remoteOutcomeHash: string | null;
    requestedMutationCount: number;
    sentMutationCount: number;
    publishAttempted: boolean;
    finishedAt: Date | string | null;
    executionAccountRefHash?: string | null;
  };
  permit: {
    id: string;
    decisionId: string;
    courseAlias: string;
    permitKey: string;
    policyVersion: string;
    targetHash: string;
    targetVersionHash: string;
    contentHash: string;
    idempotencyKey: string;
    status: string;
    usedAt: Date | string | null;
    revokedAt: Date | string | null;
    realPublishEnabled: boolean;
    executionAccountLeaseId?: string | null;
    executionAccountRefHash?: string | null;
    credentialRefHash?: string | null;
  } | null;
  decision: {
    id: string;
    invocationId: string;
    courseAlias: string;
    threadKey: string;
    policyVersion: string;
    decision: string;
    decisionMode: string;
    observationReceiptHash: string;
    decisionJson: string;
    draftContentHash: string | null;
    bodyPersisted: boolean;
    publishAttempted: boolean;
  } | null;
  invocation: {
    id: string;
    courseAlias: string;
    mode: string;
    manifestHash: string;
    status?: string;
    phase?: string;
  } | null;
  stage: {
    decisionId: string;
    courseAlias: string;
    policyVersion: string;
    targetVersionHash: string;
    contentHash: string;
    status: string;
    usedAt: Date | string | null;
    editorWriteCount: number;
    editorClearCount: number;
    sentMutationCount: number;
    publishAttempted: boolean;
    bodyPersisted: boolean;
    containsForumText: boolean;
  } | null;
  observation: {
    receiptHash: string;
    receiptJson: string;
    threadKey: string;
    containsForumText: boolean;
  } | null;
  preExecutionTape?: {
    kind: string;
    payloadJson: string;
  } | null;
  /** Optional test-only target fixture; production targets come from locate. */
  target?: OneShotOutcomeReconciliationTarget;
};

type LocateResult = {
  target: OneShotOutcomeReconciliationTarget;
  preExecutionObservation?: unknown;
};

type ReadPersisted = (input: {
  prisma: PrismaClient;
  courseAlias: string;
  now: Date;
}) => Promise<readonly OneShotOutcomeReconciliationSnapshot[]>;

type LocateDependency = (input: {
  manifest: CourseManifest;
  threadKey: string;
  secret: Buffer | string;
  token?: string | null;
  writeToken?: CmoocApiWriteToken;
  executionAccountLeaseId?: string;
  executionAccountRefHash?: string;
  credentialRefHash?: string;
  observedAt: Date;
}) => Promise<LocateResult>;

type RebuildDependency = (input: {
  intent: unknown;
  moveSpec: unknown;
  intentHash: string;
  moveSpecHash: string;
  expectedContentHash: string;
}) => string;

type EvidenceHashDependency = (input: {
  secret: Buffer | string;
  schemaVersion: string;
  value: CanonicalJsonValue;
}) => string;

type TransitionDependency = typeof reconcileOutcomeUnknownExecutionAttempt;
type CommittedTapeDependency = typeof appendExecutionReceiptCommittedTape;
type ObservedTapeDependency = typeof appendPostExecutionObservedTape;
type PolicyRelockedTapeDependency = typeof appendExecutionPolicyRelockedTape;
type RelockDependency = typeof relockOneShotPolicy;

export type OneShotOutcomeReconciliationDependencies = {
  readPersisted?: ReadPersisted;
  loadCourseManifest?: (alias: string) => Promise<CourseManifest>;
  locateTransientExecutionTarget?: LocateDependency;
  resolveCmoocApiWriteToken?: (input: {
    executionAccountRefHash: string;
  }) => Promise<CmoocApiWriteToken>;
  rebuildDeterministicSemanticDraft?: RebuildDependency;
  hashTransientRemoteEvidence?: EvidenceHashDependency;
  reconcileOutcomeUnknownExecutionAttempt?: TransitionDependency;
  appendExecutionReceiptCommittedTape?: CommittedTapeDependency;
  appendPostExecutionObservedTape?: ObservedTapeDependency;
  appendExecutionPolicyRelockedTape?: PolicyRelockedTapeDependency;
  relockOneShotPolicy?: RelockDependency;
  wait?: (milliseconds: number) => Promise<void>;
  clock?: () => Date;
};

export type ReconcileOneShotOutcomeUnknownInput = {
  prisma: PrismaClient;
  courseAlias: string;
  now: Date;
  secret: Buffer | string;
  token?: string | null;
  dependencies?: OneShotOutcomeReconciliationDependencies;
};

export type ReconcileOneShotOutcomeUnknownResult = {
  status: "confirmed_not_published";
  attemptedReadCount: number;
  successfulReadCount: number;
  emptyCommentReadCount: number;
  totalCommentCount: number;
  transitionIdempotent: boolean;
  manifestLocked: true;
  globalHardLock: true;
  blockingRealAttemptCount: 0;
  remoteEvidenceHash: string;
  containsForumText: false;
};

function inconclusive(): never {
  throw new Error(L3_OUTCOME_RECONCILIATION_INCONCLUSIVE);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

/**
 * Account-bound reconciliation may only use the credential resolved for the
 * persisted opaque account reference.  Environment/storage-state tokens and
 * any swapped credential fail closed; the caller must never fall back to the
 * legacy input token on this branch.
 */
export function assertOutcomeAccountWriteToken(input: {
  writeToken?: CmoocApiWriteToken | null;
  accountRefHash: string;
  credentialRefHash: string;
}): CmoocApiWriteToken {
  if (
    !isSha256(input.accountRefHash) ||
    !isSha256(input.credentialRefHash) ||
    !input.writeToken ||
    input.writeToken.source !== "partner_account" ||
    input.writeToken.accountRefHash !== input.accountRefHash ||
    input.writeToken.credentialRefHash !== input.credentialRefHash
  ) {
    throw new Error("L3_OUTCOME_ACCOUNT_AUTH_BINDING_MISMATCH");
  }
  return input.writeToken;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.size &&
    actual.every((key) => keys.has(key))
  );
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function hasDate(value: Date | string | null): boolean {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  return typeof value === "string" && isIsoDate(value);
}

function parseObservation(input: {
  snapshot: OneShotOutcomeReconciliationSnapshot;
}): {
  targetVersionHash: string;
  eventSetHash: string;
  observedAt: string;
} {
  const observation = input.snapshot.observation;
  const decision = input.snapshot.decision;
  if (!observation || !decision || !isSha256(observation.receiptHash)) {
    inconclusive();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(observation.receiptJson) as unknown;
  } catch {
    inconclusive();
  }
  if (!isRecord(raw)) {
    inconclusive();
  }
  if (
    raw.schemaVersion !== "cmooc.live-ui-observation-receipt.v1" ||
    raw.threadKey !== decision.threadKey ||
    observation.threadKey !== decision.threadKey ||
    raw.containsForumText !== false ||
    observation.containsForumText !== false ||
    typeof raw.targetVersionHash !== "string" ||
    typeof raw.eventSetHash !== "string" ||
    !isSha256(raw.targetVersionHash) ||
    !isSha256(raw.eventSetHash) ||
    !isIsoDate(raw.observedAt) ||
    raw.commentCount !== 0 ||
    raw.commentCompleteness !== "complete" ||
    !Array.isArray(raw.eventEvidence) ||
    !raw.eventEvidence.every(
      (event) =>
        isRecord(event) &&
        typeof event.eventKey === "string" &&
        typeof event.actorRelation === "string"
    )
  ) {
    inconclusive();
  }
  let computedHash: string;
  try {
    computedHash = canonicalProtocolHash(
      raw.schemaVersion as string,
      raw as unknown as CanonicalJsonValue
    );
  } catch {
    inconclusive();
  }
  if (
    computedHash !== observation.receiptHash ||
    computedHash !== decision.observationReceiptHash
  ) {
    inconclusive();
  }
  return {
    targetVersionHash: raw.targetVersionHash,
    eventSetHash: raw.eventSetHash,
    observedAt: raw.observedAt
  };
}

function validatePreExecutionTape(input: {
  snapshot: OneShotOutcomeReconciliationSnapshot;
  observation: { targetVersionHash: string; eventSetHash: string };
}): void {
  const tape = input.snapshot.preExecutionTape;
  if (!tape || tape.kind !== "pre_execution_revalidated") {
    inconclusive();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(tape.payloadJson) as unknown;
  } catch {
    inconclusive();
  }
  if (
    !isRecord(raw) ||
    raw.targetVersionHash !== input.observation.targetVersionHash ||
    raw.eventSetHash !== input.observation.eventSetHash ||
    raw.targetUnchanged !== true ||
    raw.containsForumText !== false ||
    typeof raw.observedAt !== "string" ||
    !isIsoDate(raw.observedAt)
  ) {
    inconclusive();
  }
}

function parseProductionReceipt(input: {
  snapshot: OneShotOutcomeReconciliationSnapshot;
  permit: NonNullable<OneShotOutcomeReconciliationSnapshot["permit"]>;
  decision: NonNullable<OneShotOutcomeReconciliationSnapshot["decision"]>;
  expectedState: "outcome_unknown" | "confirmed_not_published";
}): string {
  const { attempt } = input.snapshot;
  if (!isSha256(attempt.remoteOutcomeHash)) inconclusive();
  let raw: unknown;
  try {
    raw = JSON.parse(attempt.receiptJson) as unknown;
  } catch {
    inconclusive();
  }
  if (!isRecord(raw) || !hasExactKeys(raw, PRODUCTION_RECEIPT_KEYS)) {
    inconclusive();
  }
  if (
    raw.schemaVersion !==
      PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION ||
    raw.permitKey !== input.permit.permitKey ||
    raw.idempotencyKey !== input.permit.idempotencyKey ||
    raw.targetHash !== input.permit.targetHash ||
    raw.targetVersionHash !== input.permit.targetVersionHash ||
    raw.contentHash !== input.permit.contentHash ||
    raw.state !== input.expectedState ||
    !isIsoDate(raw.observedAt) ||
    !hasDate(attempt.finishedAt) ||
    raw.observedAt !==
      (attempt.finishedAt instanceof Date
        ? attempt.finishedAt.toISOString()
        : attempt.finishedAt) ||
    !isSha256(raw.remoteEvidenceHash) ||
    raw.requestedMutationCount !== 1 ||
    raw.sentMutationCount !== 1 ||
    raw.publishAttempted !== true ||
    raw.realPublishEnabled !== true ||
    raw.bodyPersisted !== false ||
    raw.containsForumText !== false
  ) {
    inconclusive();
  }
  let computedHash: string;
  try {
    computedHash = canonicalProtocolHash(
      PRODUCTION_EXECUTION_ATTEMPT_RECEIPT_SCHEMA_VERSION,
      raw as CanonicalJsonValue
    );
  } catch {
    inconclusive();
  }
  if (computedHash !== attempt.remoteOutcomeHash) {
    inconclusive();
  }
  return raw.remoteEvidenceHash as string;
}

function validatePersistedSnapshot(input: {
  snapshot: OneShotOutcomeReconciliationSnapshot;
  courseAlias: string;
  expectedState: "outcome_unknown" | "confirmed_not_published";
}): {
  permit: NonNullable<OneShotOutcomeReconciliationSnapshot["permit"]>;
  decision: NonNullable<OneShotOutcomeReconciliationSnapshot["decision"]>;
  observation: {
    targetVersionHash: string;
    eventSetHash: string;
    observedAt: string;
  };
  remoteEvidenceHash: string;
  accountBinding: {
    executionAccountLeaseId: string;
    accountRefHash: string;
    credentialRefHash: string;
  } | null;
} {
  const { snapshot, courseAlias } = input;
  const { attempt, permit, decision, invocation, stage } = snapshot;
  if (
    !permit ||
    !decision ||
    !invocation ||
    !stage ||
    attempt.mode !== "AUTO" ||
    attempt.status !== input.expectedState ||
    attempt.transport !== "real_platform" ||
    attempt.requestedMutationCount !== 1 ||
    attempt.sentMutationCount !== 1 ||
    attempt.publishAttempted !== true ||
    !hasDate(attempt.finishedAt) ||
    !attempt.permitId ||
    attempt.permitId !== permit.id ||
    attempt.decisionId !== decision.id ||
    attempt.idempotencyKey !== permit.idempotencyKey ||
    permit.decisionId !== decision.id ||
    permit.courseAlias !== courseAlias ||
    decision.courseAlias !== courseAlias ||
    decision.decision !== "draft" ||
    decision.decisionMode !== "DRAFT_ELIGIBLE" ||
    decision.bodyPersisted !== false ||
    decision.publishAttempted !== true ||
    !isSha256(decision.draftContentHash) ||
    permit.status !== "used" ||
    !hasDate(permit.usedAt) ||
    permit.revokedAt !== null ||
    permit.realPublishEnabled !== true ||
    !isSha256(permit.targetHash) ||
    !isSha256(permit.targetVersionHash) ||
    !isSha256(permit.contentHash) ||
    permit.contentHash !== decision.draftContentHash ||
    stage.decisionId !== decision.id ||
    stage.courseAlias !== courseAlias ||
    stage.policyVersion !== permit.policyVersion ||
    stage.targetVersionHash !== permit.targetVersionHash ||
    stage.contentHash !== permit.contentHash ||
    stage.status !== "consumed" ||
    !hasDate(stage.usedAt) ||
    stage.editorWriteCount !== 1 ||
    stage.editorClearCount !== 1 ||
    stage.sentMutationCount !== 0 ||
    stage.publishAttempted !== false ||
    stage.bodyPersisted !== false ||
    stage.containsForumText !== false ||
    invocation.id !== decision.invocationId ||
    invocation.courseAlias !== courseAlias ||
    invocation.mode !== "SHADOW" ||
    invocation.status !== "completed" ||
    invocation.phase !== "completed"
  ) {
    inconclusive();
  }
  const persistedAccountValues = [
    permit.executionAccountLeaseId,
    permit.executionAccountRefHash,
    permit.credentialRefHash
  ];
  const hasPersistedAccountBinding = persistedAccountValues.some(
    (value) => value !== undefined && value !== null
  );
  let accountBinding: {
    executionAccountLeaseId: string;
    accountRefHash: string;
    credentialRefHash: string;
  } | null = null;
  if (hasPersistedAccountBinding) {
    if (
      !isSha256(permit.executionAccountLeaseId) ||
      !isSha256(permit.executionAccountRefHash) ||
      !isSha256(permit.credentialRefHash) ||
      attempt.executionAccountRefHash !== permit.executionAccountRefHash
    ) {
      inconclusive();
    }
    accountBinding = {
      executionAccountLeaseId: permit.executionAccountLeaseId,
      accountRefHash: permit.executionAccountRefHash,
      credentialRefHash: permit.credentialRefHash
    };
  } else if (
    attempt.executionAccountRefHash !== undefined &&
    attempt.executionAccountRefHash !== null
  ) {
    inconclusive();
  }
  const observation = parseObservation({ snapshot });
  validatePreExecutionTape({ snapshot, observation });
  if (
    permit.targetVersionHash !== observation.targetVersionHash ||
    permit.targetHash !==
      canonicalProtocolHash(
        "cmooc.execution-logical-target.v1",
        {
          courseAlias,
          threadKey: decision.threadKey,
          observationReceiptHash: decision.observationReceiptHash,
          targetVersionHash: observation.targetVersionHash,
          eventSetHash: observation.eventSetHash
        }
      )
  ) {
    inconclusive();
  }
  const remoteEvidenceHash = parseProductionReceipt({
    snapshot,
    permit,
    decision,
    expectedState: input.expectedState
  });
  return {
    permit,
    decision,
    observation,
    remoteEvidenceHash,
    accountBinding
  };
}

function choosePersistedSnapshot(
  snapshots: readonly OneShotOutcomeReconciliationSnapshot[]
): {
  snapshot: OneShotOutcomeReconciliationSnapshot;
  expectedState: "outcome_unknown" | "confirmed_not_published";
} {
  const unknown = snapshots.filter(
    (candidate) => candidate.attempt.status === "outcome_unknown"
  );
  if (unknown.length > 1) inconclusive();
  if (unknown.length === 1) {
    return { snapshot: unknown[0], expectedState: "outcome_unknown" };
  }
  const final = snapshots.filter(
    (candidate) => candidate.attempt.status === "confirmed_not_published"
  );
  if (final.length === 0) inconclusive();
  const sorted = [...final].sort((left, right) => {
    const leftTime =
      left.attempt.finishedAt instanceof Date
        ? left.attempt.finishedAt.getTime()
        : Date.parse(left.attempt.finishedAt ?? "");
    const rightTime =
      right.attempt.finishedAt instanceof Date
        ? right.attempt.finishedAt.getTime()
        : Date.parse(right.attempt.finishedAt ?? "");
    return rightTime - leftTime;
  });
  return {
    snapshot: sorted[0],
    expectedState: "confirmed_not_published"
  };
}

function verifyDeterministicBody(input: {
  decision: NonNullable<OneShotOutcomeReconciliationSnapshot["decision"]>;
  permit: NonNullable<OneShotOutcomeReconciliationSnapshot["permit"]>;
  rebuild: RebuildDependency;
}): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.decision.decisionJson) as unknown;
  } catch {
    inconclusive();
  }
  if (!isRecord(parsed)) inconclusive();
  const semantic = parsed.semanticReceipt;
  const revalidation = parsed.revalidationReceipt;
  if (
    !isRecord(semantic) ||
    !isRecord(revalidation) ||
    !isRecord(parsed.intent) ||
    !isRecord(parsed.moveSpec) ||
    typeof parsed.intentHash !== "string" ||
    typeof parsed.moveSpecHash !== "string" ||
    !isSha256(parsed.intentHash) ||
    !isSha256(parsed.moveSpecHash) ||
    parsed.draftContentHash !== input.permit.contentHash ||
    parsed.draftBodyPersisted !== false ||
    parsed.publishAttempted !== false ||
    parsed.containsForumText !== false ||
    semantic.resolution !== "deterministic_fallback" ||
    semantic.contentHash !== input.permit.contentHash ||
    semantic.bodyPersisted !== false ||
    semantic.containsForumText !== false ||
    revalidation.decision !== "EXECUTE" ||
    revalidation.containsForumText !== false ||
    typeof revalidation.schemaVersion !== "string" ||
    typeof parsed.revalidationReceiptHash !== "string" ||
    !isSha256(parsed.revalidationReceiptHash)
  ) {
    inconclusive();
  }
  try {
    if (
      canonicalProtocolHash(
        revalidation.schemaVersion,
        revalidation as CanonicalJsonValue
      ) !== parsed.revalidationReceiptHash
    ) {
      inconclusive();
    }
    const rebuilt = input.rebuild({
      intent: parsed.intent,
      moveSpec: parsed.moveSpec,
      intentHash: parsed.intentHash,
      moveSpecHash: parsed.moveSpecHash,
      expectedContentHash: input.permit.contentHash
    });
    if (
      typeof rebuilt !== "string" ||
      hashTransientDraftBody(rebuilt) !== input.permit.contentHash
    ) {
      inconclusive();
    }
  } catch {
    inconclusive();
  }
}

function validateLocatedTarget(input: {
  located: LocateResult;
  manifest: CourseManifest;
  decision: NonNullable<OneShotOutcomeReconciliationSnapshot["decision"]>;
  permit: NonNullable<OneShotOutcomeReconciliationSnapshot["permit"]>;
  observation: { targetVersionHash: string; eventSetHash: string };
  accountBinding: {
    executionAccountLeaseId: string;
    accountRefHash: string;
    credentialRefHash: string;
  } | null;
}): void {
  const target = input.located.target;
  if (
    !target ||
    typeof target.postUrl !== "string" ||
    typeof target.threadKey !== "string" ||
    !isSha256(target.targetVersionHash) ||
    !isSha256(target.eventSetHash) ||
    !Array.isArray(target.comments)
  ) {
    inconclusive();
  }
  try {
    const origin = new URL(target.postUrl).origin;
    if (!input.manifest.allowedOrigins.includes(origin)) {
      inconclusive();
    }
  } catch {
    inconclusive();
  }
  if (
    target.threadKey !== input.decision.threadKey ||
    target.targetVersionHash !== input.permit.targetVersionHash ||
    target.targetVersionHash !== input.observation.targetVersionHash ||
    target.eventSetHash !== input.observation.eventSetHash ||
    target.comments.length !== 0
  ) {
    inconclusive();
  }
  if (input.accountBinding) {
    if (
      target.executionAccountLeaseId !==
        input.accountBinding.executionAccountLeaseId ||
      target.executionAccountRefHash !==
        input.accountBinding.accountRefHash ||
      target.credentialRefHash !==
        input.accountBinding.credentialRefHash ||
      !target.writeToken ||
      target.writeToken.source !== "partner_account" ||
      target.writeToken.accountRefHash !==
        input.accountBinding.accountRefHash ||
      target.writeToken.credentialRefHash !==
        input.accountBinding.credentialRefHash ||
      target.token !== undefined && target.token !== null
    ) {
      inconclusive();
    }
  } else if (
    target.writeToken !== undefined ||
    target.executionAccountLeaseId !== undefined ||
    target.executionAccountRefHash !== undefined ||
    target.credentialRefHash !== undefined
  ) {
    inconclusive();
  }
}

async function defaultReadPersisted(input: {
  prisma: PrismaClient;
  courseAlias: string;
}): Promise<readonly OneShotOutcomeReconciliationSnapshot[]> {
  const attempts = await input.prisma.executionAttempt.findMany({
    where: {
      decision: { courseAlias: input.courseAlias },
      mode: "AUTO",
      status: { in: ["outcome_unknown", "confirmed_not_published"] },
      transport: "real_platform"
    },
    include: {
      permit: true,
      decision: {
        include: {
          executionStageReceipt: true,
          invocation: true
        }
      }
    }
  });
  return Promise.all(
    attempts.map(async (attempt) => {
      const observation = await input.prisma.autonomyObservation.findUnique({
        where: {
          receiptHash: attempt.decision.observationReceiptHash
        }
      });
      const preExecutionTape = await input.prisma.decisionTapeEntry.findFirst({
        where: {
          invocationId: attempt.decision.invocationId,
          kind: "pre_execution_revalidated"
        },
        orderBy: [{ createdAt: "desc" }, { sequence: "desc" }]
      });
      return {
        attempt,
        permit: attempt.permit,
        decision: attempt.decision,
        invocation: attempt.decision.invocation,
        stage: attempt.decision.executionStageReceipt,
        observation,
        preExecutionTape
      } as unknown as OneShotOutcomeReconciliationSnapshot;
    })
  );
}

function defaultLocate(input: Parameters<LocateDependency>[0]): Promise<LocateResult> {
  return locateTransientExecutionTarget(input).then((located) => ({
    target: located.target,
    preExecutionObservation: located.preExecutionObservation
  }));
}

const DEFAULT_DEPENDENCIES: Required<OneShotOutcomeReconciliationDependencies> = {
  readPersisted: defaultReadPersisted,
  loadCourseManifest: (alias) => loadCourseManifest(alias),
  locateTransientExecutionTarget: defaultLocate,
  resolveCmoocApiWriteToken: ({ executionAccountRefHash }) =>
    resolveCmoocApiWriteTokenForAccount({ executionAccountRefHash }),
  rebuildDeterministicSemanticDraft: (input) =>
    rebuildDeterministicSemanticDraft(input as never),
  hashTransientRemoteEvidence,
  reconcileOutcomeUnknownExecutionAttempt,
  appendExecutionReceiptCommittedTape,
  appendPostExecutionObservedTape,
  appendExecutionPolicyRelockedTape,
  relockOneShotPolicy,
  wait: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  clock: () => new Date()
};

export async function reconcileOneShotOutcomeUnknown(
  input: ReconcileOneShotOutcomeUnknownInput
): Promise<ReconcileOneShotOutcomeUnknownResult> {
  try {
    if (
      !input ||
      typeof input.courseAlias !== "string" ||
      !input.courseAlias ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime()) ||
      !(typeof input.secret === "string" || Buffer.isBuffer(input.secret))
    ) {
      inconclusive();
    }
    const dependencies = {
      ...DEFAULT_DEPENDENCIES,
      ...(input.dependencies ?? {})
    };
    const snapshots = await dependencies.readPersisted({
      prisma: input.prisma,
      courseAlias: input.courseAlias,
      now: input.now
    });
    const selected = choosePersistedSnapshot(snapshots);
    const snapshot = selected.snapshot;
    const expectedState = selected.expectedState;
    const {
      permit,
      decision,
      observation,
      remoteEvidenceHash: persistedRemoteEvidenceHash,
      accountBinding
    } = validatePersistedSnapshot({
      snapshot,
      courseAlias: input.courseAlias,
      expectedState
    });
    const manifest = await dependencies.loadCourseManifest(
      input.courseAlias
    );
    if (
      manifest.alias !== input.courseAlias ||
      manifest.manifestHash !== snapshot.invocation?.manifestHash ||
      manifest.policyVersion !== decision.policyVersion ||
      manifest.realPublishEnabled !== false ||
      manifest.allowedOrigins.length === 0
    ) {
      inconclusive();
    }
    verifyDeterministicBody({
      decision,
      permit,
      rebuild: dependencies.rebuildDeterministicSemanticDraft
    });

    let attemptedReadCount = 0;
    let successfulReadCount = 0;
    let emptyCommentReadCount = 0;
    let totalCommentCount = 0;
    let firstObservedAt: string | null = null;
    let lastObservedAt: string | null = null;
    let remoteEvidenceHash = persistedRemoteEvidenceHash;
    const attemptFinishedAt =
      snapshot.attempt.finishedAt instanceof Date
        ? snapshot.attempt.finishedAt
        : new Date(snapshot.attempt.finishedAt as string);
    if (!Number.isFinite(attemptFinishedAt.getTime())) {
      inconclusive();
    }
    let accountWriteToken: CmoocApiWriteToken | null = null;
    if (accountBinding) {
      try {
        accountWriteToken = assertOutcomeAccountWriteToken({
          writeToken:
            await dependencies.resolveCmoocApiWriteToken({
              executionAccountRefHash: accountBinding.accountRefHash
            }),
          accountRefHash: accountBinding.accountRefHash,
          credentialRefHash: accountBinding.credentialRefHash
        });
      } catch {
        inconclusive();
      }
    }

    // A completed reconciliation may be retried after a tape append failure.
    // Revalidate its canonical receipt and repair the remaining audit facts
    // without another remote read or a second state transition.
    if (expectedState === "outcome_unknown") {
      while (
        attemptedReadCount < MAX_REMOTE_READ_ATTEMPTS &&
        successfulReadCount < REQUIRED_SUCCESSFUL_REMOTE_READS
      ) {
        if (attemptedReadCount > 0) {
          await dependencies.wait(1000);
        }
        attemptedReadCount += 1;
        const observedAt = dependencies.clock();
        if (
          !(observedAt instanceof Date) ||
          !Number.isFinite(observedAt.getTime())
        ) {
          inconclusive();
        }
        const observedAtIso = observedAt.toISOString();
        let located: LocateResult;
        try {
          located = await dependencies.locateTransientExecutionTarget({
            manifest,
            threadKey: decision.threadKey,
            secret: input.secret,
            ...(accountBinding
              ? {
                  writeToken: accountWriteToken ?? undefined,
                  executionAccountLeaseId:
                    accountBinding.executionAccountLeaseId,
                  executionAccountRefHash:
                    accountBinding.accountRefHash,
                  credentialRefHash:
                    accountBinding.credentialRefHash
                }
              : { token: input.token }),
            observedAt
          });
        } catch {
          continue;
        }
        validateLocatedTarget({
          located,
          manifest,
          decision,
          permit,
          observation,
          accountBinding
        });
        if (
          observedAt.getTime() < attemptFinishedAt.getTime() ||
          lastObservedAt !== null &&
          Date.parse(observedAtIso) < Date.parse(lastObservedAt)
        ) {
          inconclusive();
        }
        firstObservedAt ??= observedAtIso;
        lastObservedAt = observedAtIso;
        successfulReadCount += 1;
        emptyCommentReadCount += 1;
      }
      if (
        successfulReadCount !== REQUIRED_SUCCESSFUL_REMOTE_READS ||
        emptyCommentReadCount !== REQUIRED_SUCCESSFUL_REMOTE_READS
      ) {
        inconclusive();
      }

      // Do not include timestamps, failed-attempt counts, IDs, URLs, tokens,
      // or body text.  This stable value lets an audit/tape repair retry use
      // exactly the same HMAC after the transition has already committed.
      const evidenceValue = {
        schemaVersion: "cmooc.l3-outcome-reconciliation.v1",
        classification: "confirmed_not_published",
        stateBefore: "outcome_unknown",
        stateAfter: "confirmed_not_published",
        observationReceiptHash: decision.observationReceiptHash,
        targetHash: permit.targetHash,
        targetVersionHash: permit.targetVersionHash,
        eventSetHash: observation.eventSetHash,
        successfulReadCount: REQUIRED_SUCCESSFUL_REMOTE_READS,
        emptyCommentReadCount: REQUIRED_SUCCESSFUL_REMOTE_READS,
        totalCommentCount: 0,
        allReadsComplete: true,
        allReadsStable: true,
        noCommentMatch: true,
        containsForumText: false
      } as const;
      remoteEvidenceHash = dependencies.hashTransientRemoteEvidence({
        secret: input.secret,
        schemaVersion: evidenceValue.schemaVersion,
        value: evidenceValue as unknown as CanonicalJsonValue
      });
      if (!isSha256(remoteEvidenceHash)) inconclusive();
    } else if (!isSha256(remoteEvidenceHash)) {
      inconclusive();
    }
    const reconciledAt = dependencies.clock();
    if (
      !(reconciledAt instanceof Date) ||
      !Number.isFinite(reconciledAt.getTime()) ||
      reconciledAt.getTime() < attemptFinishedAt.getTime() ||
      (lastObservedAt !== null &&
        reconciledAt.getTime() < Date.parse(lastObservedAt))
    ) {
      inconclusive();
    }
    const transition = await dependencies.reconcileOutcomeUnknownExecutionAttempt({
      prisma: input.prisma,
      attemptId: snapshot.attempt.id,
      state: "confirmed_not_published",
      remoteEvidenceHash,
      now: reconciledAt
    });
    if (!transition || typeof transition.idempotent !== "boolean") {
      inconclusive();
    }
    await dependencies.appendExecutionReceiptCommittedTape({
      prisma: input.prisma,
      invocationId: decision.invocationId,
      attemptId: snapshot.attempt.id,
      status: "confirmed_not_published",
      recoveredByReconciliation: true
    });
    await dependencies.appendPostExecutionObservedTape({
      prisma: input.prisma,
      invocationId: decision.invocationId,
      attemptId: snapshot.attempt.id,
      status: "confirmed_not_published",
      recoveredByReconciliation: true
    });
    const relocked = await dependencies.relockOneShotPolicy({
      prisma: input.prisma,
      courseAlias: input.courseAlias,
      ownedPolicyVersion: permit.policyVersion,
      now: reconciledAt
    });
    if (
      !relocked.manifestLocked ||
      !relocked.globalHardLock ||
      !relocked.forumSettingLocked ||
      relocked.blockingRealAttemptCount !== 0 ||
      relocked.activeRealPolicyCount !== 0 ||
      relocked.openRealPermitCount !== 0
    ) {
      inconclusive();
    }
    await dependencies.appendExecutionPolicyRelockedTape({
      prisma: input.prisma,
      invocationId: decision.invocationId,
      revokedPolicyCount: relocked.revokedPolicyCount,
      closedPermitCount: relocked.closedPermitCount,
      manifestLocked: true,
      globalHardLock: true,
      relockedAt: reconciledAt
    });
    return {
      status: "confirmed_not_published",
      attemptedReadCount,
      successfulReadCount,
      emptyCommentReadCount,
      totalCommentCount,
      transitionIdempotent: transition.idempotent,
      manifestLocked: true,
      globalHardLock: true,
      blockingRealAttemptCount: 0,
      remoteEvidenceHash,
      containsForumText: false
    };
  } catch {
    throw new Error(L3_OUTCOME_RECONCILIATION_INCONCLUSIVE);
  }
}
