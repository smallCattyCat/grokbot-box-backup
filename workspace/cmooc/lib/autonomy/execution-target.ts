import { createHmac } from "node:crypto";
import {
  canonicalJson,
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  createCmoocTopicPageCursor,
  fetchCmoocCourseColumns,
  fetchCmoocPostDetail,
  fetchCmoocSketchPostPage,
  getCmoocApiToken,
  type CmoocApiWriteToken,
  type CmoocApiComment
} from "@/lib/forum/cmooc-api";
import {
  cmoocStableThreadRef
} from "@/lib/forum-adapters/cmooc-api-adapter";
import {
  deriveAutonomyThreadKey,
  normalizeObservedThread
} from "@/lib/world/live-event";
import type { CourseManifest } from "./course-manifest";
import {
  hashPreExecutionTargetObservation,
  PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
  type BoundPreExecutionTargetObservation
} from "./execution-permit";

export type TransientCmoocExecutionTarget = {
  postUrl: string;
  courseId: string;
  threadRef: string;
  threadKey: string;
  targetVersionHash: string;
  eventSetHash: string;
  comments: CmoocApiComment[];
  /** Legacy account-agnostic token. New account-bound targets use writeToken. */
  token?: string | null;
  writeToken?: CmoocApiWriteToken;
  executionAccountLeaseId?: string;
  executionAccountRefHash?: string;
  credentialRefHash?: string;
};

const EXECUTION_TARGET_HASH = /^[a-f0-9]{64}$/;

function assertOpaqueTargetHash(value: unknown, code: string): string {
  if (typeof value !== "string" || !EXECUTION_TARGET_HASH.test(value)) {
    throw new Error(code);
  }
  return value;
}

/**
 * Explicit write credentials and the legacy raw token are deliberately
 * mutually exclusive. This pure guard is shared by the locator and tests so
 * an account-bound path can never silently fall back to a process token.
 */
export function assertTransientExecutionTargetTokenInput(input: {
  token?: string | null;
  writeToken?: CmoocApiWriteToken;
}): CmoocApiWriteToken | null {
  if (input.token !== undefined && input.writeToken !== undefined) {
    throw new Error("EXECUTION_TARGET_TOKEN_INPUT_CONFLICT");
  }
  if (input.writeToken === undefined) return null;
  const token = input.writeToken;
  if (
    !token ||
    typeof token.token !== "string" ||
    token.token.length === 0 ||
    typeof token.source !== "string"
  ) {
    throw new Error("EXECUTION_TARGET_WRITE_TOKEN_INVALID");
  }
  if (token.accountRefHash !== undefined) {
    assertOpaqueTargetHash(
      token.accountRefHash,
      "EXECUTION_TARGET_ACCOUNT_REF_INVALID"
    );
  }
  if (token.credentialRefHash !== undefined) {
    assertOpaqueTargetHash(
      token.credentialRefHash,
      "EXECUTION_TARGET_CREDENTIAL_REF_INVALID"
    );
  }
  return token;
}

export function assertTransientExecutionTargetAccountBinding(input: {
  writeToken?: CmoocApiWriteToken | null;
  executionAccountLeaseId?: string;
  accountRefHash?: string;
  credentialRefHash?: string;
}): void {
  const hasAny =
    input.executionAccountLeaseId !== undefined ||
    input.accountRefHash !== undefined ||
    input.credentialRefHash !== undefined;
  if (!hasAny) return;
  if (
    input.executionAccountLeaseId === undefined ||
    input.accountRefHash === undefined ||
    input.credentialRefHash === undefined
  ) {
    throw new Error("EXECUTION_TARGET_ACCOUNT_BINDING_MISMATCH");
  }
  assertOpaqueTargetHash(
    input.executionAccountLeaseId,
    "EXECUTION_TARGET_LEASE_REF_INVALID"
  );
  assertOpaqueTargetHash(
    input.accountRefHash,
    "EXECUTION_TARGET_ACCOUNT_REF_INVALID"
  );
  assertOpaqueTargetHash(
    input.credentialRefHash,
    "EXECUTION_TARGET_CREDENTIAL_REF_INVALID"
  );
  if (
    !input.writeToken ||
    input.writeToken.source !== "partner_account" ||
    input.writeToken.accountRefHash !== input.accountRefHash ||
    input.writeToken.credentialRefHash !== input.credentialRefHash
  ) {
    throw new Error("EXECUTION_TARGET_ACCOUNT_BINDING_MISMATCH");
  }
}

function evidenceKey(secret: Buffer | string): Buffer {
  const key = Buffer.isBuffer(secret)
    ? secret
    : Buffer.from(secret, "utf8");
  if (key.byteLength < 32) {
    throw new Error("EXECUTION_EVIDENCE_KEY_TOO_SHORT");
  }
  return key;
}

export function hashTransientRemoteEvidence(input: {
  secret: Buffer | string;
  schemaVersion: string;
  value: CanonicalJsonValue;
}): string {
  return createHmac("sha256", evidenceKey(input.secret))
    .update(
      `${input.schemaVersion}\0${canonicalJson(input.value)}`,
      "utf8"
    )
    .digest("hex");
}

export function hashCommentBaseline(input: {
  secret: Buffer | string;
  comments: CmoocApiComment[];
}): string {
  return hashTransientRemoteEvidence({
    secret: input.secret,
    schemaVersion: "cmooc.remote-comment-baseline.v1",
    value: {
      comments: input.comments.map((comment) => ({
        id: comment.id,
        parentId: comment.parentId ?? null,
        content: comment.content,
        time: comment.time
      }))
    } as unknown as CanonicalJsonValue
  });
}

export async function locateTransientExecutionTarget(input: {
  manifest: CourseManifest;
  threadKey: string;
  secret: Buffer | string;
  token?: string | null;
  writeToken?: CmoocApiWriteToken;
  executionAccountLeaseId?: string;
  executionAccountRefHash?: string;
  credentialRefHash?: string;
  observedAt?: Date;
}): Promise<{
  target: TransientCmoocExecutionTarget;
  preExecutionObservation: BoundPreExecutionTargetObservation;
}> {
  const observedAt = input.observedAt ?? new Date();
  const writeToken = assertTransientExecutionTargetTokenInput(input);
  assertTransientExecutionTargetAccountBinding({
    writeToken,
    executionAccountLeaseId: input.executionAccountLeaseId,
    accountRefHash: input.executionAccountRefHash,
    credentialRefHash: input.credentialRefHash
  });
  const token = writeToken
    ? writeToken.token
    : input.token === undefined
      ? await getCmoocApiToken()
      : input.token;
  const columns = await fetchCmoocCourseColumns({
    courseId: input.manifest.courseId,
    token
  });
  const seenThreads = new Set<string>();
  let matchedPostUrl: string | null = null;
  let matchedThreadRef: string | null = null;
  let matchedCreatedTime: string | null = null;
  for (const column of columns) {
    let cursor: string | null = createCmoocTopicPageCursor({
      forumListUrl: input.manifest.canonicalUrl,
      expectedCourseId: input.manifest.courseId,
      columnId: column.columnId,
      pageSize: input.manifest.scan.pageSize
    });
    const seenCursors = new Set<string>();
    while (cursor && !seenCursors.has(cursor)) {
      seenCursors.add(cursor);
      const page = await fetchCmoocSketchPostPage({
        forumListUrl: input.manifest.canonicalUrl,
        expectedCourseId: input.manifest.courseId,
        pageSize: input.manifest.scan.pageSize,
        cursor,
        token,
        columnId: column.columnId,
        columnName: column.columnName
      });
      for (const post of page.items) {
        const threadRef = cmoocStableThreadRef(post.url);
        if (seenThreads.has(threadRef)) continue;
        seenThreads.add(threadRef);
        const threadKey = deriveAutonomyThreadKey({
          secret: input.secret,
          courseRef: input.manifest.courseId,
          threadRef
        });
        if (threadKey === input.threadKey) {
          matchedPostUrl = post.url;
          matchedThreadRef = threadRef;
          matchedCreatedTime = post.createdTime ?? null;
          break;
        }
        if (
          seenThreads.size >=
          input.manifest.scan.maxThreadsPerTick
        ) {
          break;
        }
      }
      if (
        matchedPostUrl ||
        seenThreads.size >=
          input.manifest.scan.maxThreadsPerTick
      ) {
        break;
      }
      cursor = page.receipt.nextCursor;
    }
    if (
      matchedPostUrl ||
      seenThreads.size >= input.manifest.scan.maxThreadsPerTick
    ) {
      break;
    }
  }
  if (!matchedPostUrl || !matchedThreadRef) {
    throw new Error("EXECUTION_TARGET_NOT_FOUND_IN_COURSE_SCAN");
  }
  const detail = await fetchCmoocPostDetail({
    postUrl: matchedPostUrl,
    token,
    expectedCourseId: input.manifest.courseId
  });
  if (
    !detail ||
    (detail.courseId &&
      detail.courseId !== input.manifest.courseId)
  ) {
    throw new Error("EXECUTION_TARGET_DETAIL_UNAVAILABLE");
  }
  const normalized = normalizeObservedThread({
    courseAlias: input.manifest.alias,
    secret: input.secret,
    maxComments: input.manifest.scan.maxCommentsPerThread,
    thread: {
      courseRef: input.manifest.courseId,
      threadRef: matchedThreadRef,
      authorRef: detail.authorPlatformId ?? null,
      occurredAt: matchedCreatedTime ?? detail.editedAt,
      observedAt: observedAt.toISOString(),
      versionMaterial: [
        detail.title,
        detail.content,
        detail.editedAt
      ].join("\0"),
      comments: detail.comments.map((comment) => ({
        eventRef: comment.id,
        actorRef: comment.authorPlatformId ?? null,
        parentEventRef:
          comment.parentId ?? matchedThreadRef,
        depth: comment.depth ?? 0,
        occurredAt: comment.time,
        versionMaterial:
          comment.contentStatus === "empty_or_deleted"
            ? ["empty_or_deleted", comment.time].join("\0")
            : [comment.content, comment.time].join("\0")
      }))
    }
  });
  if (normalized.threadKey !== input.threadKey) {
    throw new Error("EXECUTION_TARGET_THREAD_BINDING_MISMATCH");
  }
  const eventEvidence = normalized.events.map((event) => ({
    eventKey: event.eventKey,
    actorKey: event.actorKey,
    parentEventKey: event.parentEventKey,
    createdAt: event.occurredAt,
    actorRelation: event.actorRelation,
    actorRelationBasis:
      event.actorRelation === "thread_author"
        ? "stable_actor_match"
        : event.actorRelation === "unknown"
          ? "unavailable"
          : "course_role_registry"
  }));
  const eventSetHash = canonicalProtocolHash(
    "cmooc.live-event-evidence-set.v1",
    {
      schemaVersion: "cmooc.live-event-evidence-set.v1",
      events: eventEvidence
    } as unknown as CanonicalJsonValue
  );
  const receipt = {
    schemaVersion: PRE_EXECUTION_OBSERVATION_SCHEMA_VERSION,
    courseAlias: input.manifest.alias,
    threadKey: normalized.threadKey,
    targetVersionHash: normalized.targetVersionHash,
    eventSetHash,
    observedAt: observedAt.toISOString(),
    containsForumText: false
  } as const;
  return {
    target: {
      postUrl: matchedPostUrl,
      courseId: input.manifest.courseId,
      threadRef: matchedThreadRef,
      threadKey: normalized.threadKey,
      targetVersionHash: normalized.targetVersionHash,
      eventSetHash,
      comments: detail.comments,
      token: writeToken ? null : token,
      writeToken: writeToken ?? undefined,
      executionAccountLeaseId: input.executionAccountLeaseId,
      executionAccountRefHash: input.executionAccountRefHash,
      credentialRefHash: input.credentialRefHash
    },
    preExecutionObservation: {
      receipt,
      receiptHash: hashPreExecutionTargetObservation(receipt)
    }
  };
}
