import { randomUUID } from "node:crypto";
import {
  hashTransientDraftBody,
  normalizeTransientDraftBody
} from "@/lib/live-runtime/draft-content";

/**
 * This is a process-memory boundary, not durable recovery.  A lost process
 * must rebuild the draft from its safe recipe and run all verifiers again.
 */
export const PROTECTED_ARTIFACT_RECOVERY_BOUNDARY = Object.freeze({
  storage: "process_memory_only" as const,
  exactResume: false as const,
  recovery: "regenerate_and_reverify" as const,
  bodyPersisted: false as const
});

export interface ProtectedDraftPutRequest {
  readonly taskId: string;
  readonly runId: string;
  readonly callId: string;
  readonly idempotencyKey: string;
  readonly body: string;
  readonly draftBodyHash: string;
  readonly storedAt: string;
  readonly expiresAt: string;
}

export interface ProtectedDraftHandle {
  /** Opaque, in-process lookup handle. Never put this value in a durable row. */
  readonly ref: string;
  readonly draftBodyHash: string;
  readonly storedAt: string;
  readonly expiresAt: string;
  readonly bodyPersisted: false;
  readonly recovery: "regenerate_and_reverify";
}

export interface ProtectedDraftReadRequest {
  readonly ref: string;
  readonly taskId: string;
  readonly runId: string;
  readonly expectedDraftBodyHash: string;
  readonly now: string;
}

export interface ProtectedArtifactStore {
  put(request: ProtectedDraftPutRequest): Promise<ProtectedDraftHandle>;
  getByRef(request: ProtectedDraftReadRequest): Promise<string | null>;
}

export class ProtectedArtifactStoreError extends Error {
  constructor(
    readonly code:
      | "PROTECTED_DRAFT_INPUT_INVALID"
      | "PROTECTED_DRAFT_IDEMPOTENCY_CONFLICT"
      | "PROTECTED_DRAFT_SCOPE_MISMATCH",
    message: string
  ) {
    super(message);
    this.name = "ProtectedArtifactStoreError";
  }
}

type StoredDraft = {
  readonly ref: string;
  readonly taskId: string;
  readonly runId: string;
  readonly callId: string;
  readonly idempotencyKey: string;
  readonly body: string;
  readonly draftBodyHash: string;
  readonly storedAt: string;
  readonly expiresAt: string;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function parseInstant(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new ProtectedArtifactStoreError(
      "PROTECTED_DRAFT_INPUT_INVALID",
      `${label} must be an ISO-8601 instant.`
    );
  }
  return milliseconds;
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) {
    throw new ProtectedArtifactStoreError(
      "PROTECTED_DRAFT_INPUT_INVALID",
      `${label} is invalid.`
    );
  }
}

/**
 * A bounded, explicitly ephemeral implementation suitable for the first
 * vertical slice and tests. It never serializes the body and exposes no
 * enumeration API.
 */
export class InMemoryProtectedArtifactStore
  implements ProtectedArtifactStore
{
  readonly #byRef = new Map<string, StoredDraft>();
  readonly #refByIdempotencyKey = new Map<string, string>();
  readonly #idFactory: () => string;

  constructor(options: { readonly idFactory?: () => string } = {}) {
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async put(request: ProtectedDraftPutRequest): Promise<ProtectedDraftHandle> {
    for (const [label, value] of [
      ["taskId", request.taskId],
      ["runId", request.runId],
      ["callId", request.callId],
      ["idempotencyKey", request.idempotencyKey]
    ] as const) {
      assertSafeId(value, label);
    }
    if (!SHA256.test(request.draftBodyHash)) {
      throw new ProtectedArtifactStoreError(
        "PROTECTED_DRAFT_INPUT_INVALID",
        "draftBodyHash is invalid."
      );
    }
    const storedAt = parseInstant(request.storedAt, "storedAt");
    const expiresAt = parseInstant(request.expiresAt, "expiresAt");
    if (expiresAt <= storedAt || expiresAt - storedAt > 30 * 60_000) {
      throw new ProtectedArtifactStoreError(
        "PROTECTED_DRAFT_INPUT_INVALID",
        "Protected draft expiry must be later than storage time and within 30 minutes."
      );
    }
    const body = normalizeTransientDraftBody(request.body).trim();
    if (
      !body ||
      Array.from(body).length > 4_000 ||
      hashTransientDraftBody(body) !== request.draftBodyHash
    ) {
      throw new ProtectedArtifactStoreError(
        "PROTECTED_DRAFT_INPUT_INVALID",
        "Protected draft body does not match its canonical body hash."
      );
    }

    const existingRef = this.#refByIdempotencyKey.get(request.idempotencyKey);
    if (existingRef) {
      const existing = this.#byRef.get(existingRef);
      if (
        existing &&
        existing.taskId === request.taskId &&
        existing.runId === request.runId &&
        existing.draftBodyHash === request.draftBodyHash &&
        existing.body === body &&
        existing.storedAt === request.storedAt &&
        existing.expiresAt === request.expiresAt
      ) {
        return this.#handle(existing);
      }
      throw new ProtectedArtifactStoreError(
        "PROTECTED_DRAFT_IDEMPOTENCY_CONFLICT",
        "Protected draft idempotency key is already bound to different content."
      );
    }

    const id = this.#idFactory();
    assertSafeId(id, "protected draft id");
    const ref = `protected-draft:${id}`;
    const stored: StoredDraft = Object.freeze({
      ref,
      taskId: request.taskId,
      runId: request.runId,
      callId: request.callId,
      idempotencyKey: request.idempotencyKey,
      body,
      draftBodyHash: request.draftBodyHash,
      storedAt: request.storedAt,
      expiresAt: request.expiresAt
    });
    this.#byRef.set(ref, stored);
    this.#refByIdempotencyKey.set(request.idempotencyKey, ref);
    return this.#handle(stored);
  }

  async getByRef(request: ProtectedDraftReadRequest): Promise<string | null> {
    assertSafeId(request.taskId, "taskId");
    assertSafeId(request.runId, "runId");
    if (!/^protected-draft:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(request.ref)) {
      throw new ProtectedArtifactStoreError(
        "PROTECTED_DRAFT_INPUT_INVALID",
        "Protected draft reference is invalid."
      );
    }
    if (!SHA256.test(request.expectedDraftBodyHash)) {
      throw new ProtectedArtifactStoreError(
        "PROTECTED_DRAFT_INPUT_INVALID",
        "Expected draft body hash is invalid."
      );
    }
    const now = parseInstant(request.now, "now");
    const stored = this.#byRef.get(request.ref);
    if (!stored) return null;
    if (Date.parse(stored.expiresAt) <= now) {
      this.#byRef.delete(stored.ref);
      this.#refByIdempotencyKey.delete(stored.idempotencyKey);
      return null;
    }
    if (
      stored.taskId !== request.taskId ||
      stored.runId !== request.runId ||
      stored.draftBodyHash !== request.expectedDraftBodyHash
    ) {
      throw new ProtectedArtifactStoreError(
        "PROTECTED_DRAFT_SCOPE_MISMATCH",
        "Protected draft reference is outside the requested task/run/hash scope."
      );
    }
    return stored.body;
  }

  #handle(stored: StoredDraft): ProtectedDraftHandle {
    return Object.freeze({
      ref: stored.ref,
      draftBodyHash: stored.draftBodyHash,
      storedAt: stored.storedAt,
      expiresAt: stored.expiresAt,
      bodyPersisted: false,
      recovery: "regenerate_and_reverify"
    });
  }
}
