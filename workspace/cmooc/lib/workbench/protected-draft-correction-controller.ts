import { hashTransientDraftBody } from "@/lib/live-runtime/draft-content";

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_SESSIONS = 24;
const STORE_KEY = "__cmooc_protected_draft_correction_sessions__";

type CorrectionSession = Readonly<{
  taskId: string;
  runId: string;
  versionRef: string;
  contentHash: string;
  draftBodyHash: string;
  priorBody: string;
  openedAt: string;
  expiresAt: string;
}>;

type Store = Map<string, CorrectionSession>;

export class ProtectedDraftCorrectionError extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "ProtectedDraftCorrectionError";
  }
}

function fail(code: string, reason: string, message: string): never {
  throw new ProtectedDraftCorrectionError(code, reason, message);
}

function sessions(): Store {
  const root = globalThis as typeof globalThis & { [STORE_KEY]?: Store };
  root[STORE_KEY] ??= new Map<string, CorrectionSession>();
  return root[STORE_KEY];
}

function key(input: { taskId: string; runId: string; versionRef: string }): string {
  return `${input.taskId}\0${input.runId}\0${input.versionRef}`;
}

function assertBinding(input: {
  taskId: string;
  runId: string;
  versionRef: string;
  contentHash: string;
  draftBodyHash: string;
}): void {
  if (
    !SAFE_REF.test(input.taskId) ||
    !SAFE_REF.test(input.runId) ||
    !SAFE_REF.test(input.versionRef) ||
    !SHA256.test(input.contentHash) ||
    !SHA256.test(input.draftBodyHash)
  ) {
    fail(
      "PROTECTED_DRAFT_CORRECTION_INPUT_INVALID",
      "binding_invalid",
      "Protected correction binding is invalid."
    );
  }
}

function prune(nowMs: number): void {
  const store = sessions();
  for (const [sessionKey, session] of store) {
    if (Date.parse(session.expiresAt) <= nowMs) store.delete(sessionKey);
  }
  while (store.size >= MAX_SESSIONS) {
    const oldest = store.keys().next().value as string | undefined;
    if (!oldest) break;
    store.delete(oldest);
  }
}

/** Opens a server-only edit session after the ordinary one-shot preview has
 * succeeded. No token or protected handle leaves this module. */
export function openProtectedDraftCorrectionSession(input: {
  taskId: string;
  runId: string;
  versionRef: string;
  contentHash: string;
  draftBodyHash: string;
  priorBody: string;
  now?: Date;
  ttlMs?: number;
}): Readonly<{ expiresAt: string }> {
  assertBinding(input);
  if (hashTransientDraftBody(input.priorBody) !== input.draftBodyHash) {
    fail(
      "PROTECTED_DRAFT_CORRECTION_INPUT_INVALID",
      "body_hash_mismatch",
      "Protected correction body does not match its exact version hash."
    );
  }
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > DEFAULT_TTL_MS) {
    fail(
      "PROTECTED_DRAFT_CORRECTION_INPUT_INVALID",
      "ttl_invalid",
      "Protected correction session TTL is invalid."
    );
  }
  prune(now.getTime());
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  sessions().set(
    key(input),
    Object.freeze({
      taskId: input.taskId,
      runId: input.runId,
      versionRef: input.versionRef,
      contentHash: input.contentHash,
      draftBodyHash: input.draftBodyHash,
      priorBody: input.priorBody,
      openedAt: now.toISOString(),
      expiresAt
    })
  );
  return Object.freeze({ expiresAt });
}

/** Atomically consumes one exact edit session. Concurrent or repeated submits
 * cannot both obtain the prior body. */
export function consumeProtectedDraftCorrectionSession(input: {
  taskId: string;
  runId: string;
  versionRef: string;
  contentHash: string;
  draftBodyHash: string;
  now?: Date;
}): Readonly<{ priorBody: string; openedAt: string }> {
  assertBinding(input);
  const now = input.now ?? new Date();
  const sessionKey = key(input);
  const session = sessions().get(sessionKey);
  if (!session) {
    fail(
      "PROTECTED_DRAFT_CORRECTION_SESSION_UNAVAILABLE",
      "preview_or_edit_session_missing",
      "Protected correction requires reopening the exact draft preview."
    );
  }
  sessions().delete(sessionKey);
  if (Date.parse(session.expiresAt) <= now.getTime()) {
    fail(
      "PROTECTED_DRAFT_CORRECTION_SESSION_UNAVAILABLE",
      "edit_session_expired",
      "Protected correction edit session expired."
    );
  }
  if (
    session.contentHash !== input.contentHash ||
    session.draftBodyHash !== input.draftBodyHash
  ) {
    fail(
      "PROTECTED_DRAFT_CORRECTION_SCOPE_MISMATCH",
      "version_hash_changed",
      "Protected correction no longer matches the exact opened version."
    );
  }
  return Object.freeze({ priorBody: session.priorBody, openedAt: session.openedAt });
}

export function resetProtectedDraftCorrectionSessionsForTests(): void {
  sessions().clear();
}
