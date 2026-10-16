import { AsyncLocalStorage } from "node:async_hooks";
import {
  createHmac,
  timingSafeEqual
} from "node:crypto";
import {
  canonicalJson,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";

export const REAL_FORUM_WRITE_LOCKED = true;
export const REAL_FORUM_WRITE_LOCK_CODE =
  "REAL_FORUM_WRITE_LOCKED" as const;
export const REAL_FORUM_WRITE_LOCK_MESSAGE =
  "真实论坛写入硬锁已启用；只有与 production Permit 精确绑定的一次性执行作用域可以消费一个写动作。";
export const REAL_FORUM_WRITE_GRANT_SCHEMA_VERSION =
  "cmooc.real-forum-write-grant.v1" as const;

export type RealForumWriteMutationBinding = {
  permitKey: string;
  attemptId: string;
  idempotencyKey: string;
  targetHash: string;
  contentHash: string;
  containsForumText: false;
};

export type RealForumWriteGrant = {
  schemaVersion: typeof REAL_FORUM_WRITE_GRANT_SCHEMA_VERSION;
  binding: RealForumWriteMutationBinding;
  issuedAt: string;
  expiresAt: string;
  maxMutations: 1;
  containsForumText: false;
};

export type SignedRealForumWriteGrant = {
  grant: RealForumWriteGrant;
  signature: string;
  containsForumText: false;
};

type ActiveWriteScope = {
  binding: RealForumWriteMutationBinding;
  remainingMutations: number;
  expiresAtMs: number;
  currentTime: () => Date;
};

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const writeScope = new AsyncLocalStorage<ActiveWriteScope>();

function signingKey(secret: Buffer | string): Buffer {
  const key = Buffer.isBuffer(secret)
    ? secret
    : Buffer.from(secret, "utf8");
  if (key.byteLength < 32) {
    throw new Error("REAL_FORUM_WRITE_SIGNING_KEY_TOO_SHORT");
  }
  return key;
}

function validBinding(
  value: RealForumWriteMutationBinding
): RealForumWriteMutationBinding {
  if (
    !value ||
    typeof value !== "object" ||
    value.containsForumText !== false ||
    typeof value.attemptId !== "string" ||
    !value.attemptId.trim() ||
    value.attemptId.length > 191 ||
    !HASH_PATTERN.test(value.permitKey) ||
    !HASH_PATTERN.test(value.idempotencyKey) ||
    !HASH_PATTERN.test(value.targetHash) ||
    !HASH_PATTERN.test(value.contentHash)
  ) {
    throw new Error("REAL_FORUM_WRITE_GRANT_BINDING_INVALID");
  }
  return {
    permitKey: value.permitKey,
    attemptId: value.attemptId,
    idempotencyKey: value.idempotencyKey,
    targetHash: value.targetHash,
    contentHash: value.contentHash,
    containsForumText: false
  };
}

function grantSignature(
  grant: RealForumWriteGrant,
  secret: Buffer | string
): string {
  return createHmac("sha256", signingKey(secret))
    .update(
      `cmooc.real-forum-write-auth.v1\0${canonicalJson(
        grant as unknown as CanonicalJsonValue
      )}`,
      "utf8"
    )
    .digest("hex");
}

function equalHex(left: string, right: string): boolean {
  if (!HASH_PATTERN.test(left) || !HASH_PATTERN.test(right)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(left, "hex"),
    Buffer.from(right, "hex")
  );
}

function sameBinding(
  left: RealForumWriteMutationBinding,
  right: RealForumWriteMutationBinding
): boolean {
  return (
    left.permitKey === right.permitKey &&
    left.attemptId === right.attemptId &&
    left.idempotencyKey === right.idempotencyKey &&
    left.targetHash === right.targetHash &&
    left.contentHash === right.contentHash &&
    left.containsForumText === false &&
    right.containsForumText === false
  );
}

export function issueRealForumWriteGrant(input: {
  binding: RealForumWriteMutationBinding;
  signingSecret: Buffer | string;
  now: Date;
  expiresAt: Date;
}): SignedRealForumWriteGrant {
  const binding = validBinding(input.binding);
  const issuedAt = input.now.getTime();
  const expiresAt = input.expiresAt.getTime();
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 10 * 60_000
  ) {
    throw new Error("REAL_FORUM_WRITE_GRANT_TIME_INVALID");
  }
  const grant: RealForumWriteGrant = {
    schemaVersion: REAL_FORUM_WRITE_GRANT_SCHEMA_VERSION,
    binding,
    issuedAt: input.now.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    maxMutations: 1,
    containsForumText: false
  };
  return {
    grant,
    signature: grantSignature(grant, input.signingSecret),
    containsForumText: false
  };
}

function verifyGrant(input: {
  grant: SignedRealForumWriteGrant;
  signingSecret: Buffer | string;
  binding: RealForumWriteMutationBinding;
  now: Date;
}): {
  binding: RealForumWriteMutationBinding;
  expiresAtMs: number;
} {
  const { grant: signed } = input;
  const binding = validBinding(input.binding);
  const issuedAt = Date.parse(signed.grant?.issuedAt ?? "");
  const expiresAt = Date.parse(signed.grant?.expiresAt ?? "");
  if (
    signed.containsForumText !== false ||
    signed.grant?.schemaVersion !==
      REAL_FORUM_WRITE_GRANT_SCHEMA_VERSION ||
    signed.grant.containsForumText !== false ||
    signed.grant.maxMutations !== 1 ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt ||
    input.now.getTime() < issuedAt ||
    input.now.getTime() >= expiresAt
  ) {
    throw new Error("REAL_FORUM_WRITE_GRANT_INVALID_OR_EXPIRED");
  }
  const persistedBinding = validBinding(signed.grant.binding);
  if (!sameBinding(persistedBinding, binding)) {
    throw new Error("REAL_FORUM_WRITE_GRANT_BINDING_MISMATCH");
  }
  const expected = grantSignature(
    signed.grant,
    input.signingSecret
  );
  if (!equalHex(signed.signature, expected)) {
    throw new Error("REAL_FORUM_WRITE_GRANT_AUTH_FAILED");
  }
  return { binding, expiresAtMs: expiresAt };
}

export async function runWithRealForumWriteGrant<T>(input: {
  grant: SignedRealForumWriteGrant;
  signingSecret: Buffer | string;
  binding: RealForumWriteMutationBinding;
  now: Date;
  /**
   * Re-read at the actual mutation boundary. Tests may inject a deterministic
   * clock; production callers must pass their live clock.
   */
  currentTime?: () => Date;
  action: () => Promise<T>;
  requireConsumption?: boolean;
}): Promise<T> {
  if (writeScope.getStore()) {
    throw new Error("REAL_FORUM_WRITE_GRANT_NESTED_SCOPE_FORBIDDEN");
  }
  const verified = verifyGrant(input);
  const scope: ActiveWriteScope = {
    binding: verified.binding,
    remainingMutations: 1,
    expiresAtMs: verified.expiresAtMs,
    currentTime: input.currentTime ?? (() => input.now)
  };
  return writeScope.run(scope, async () => {
    const result = await input.action();
    if (
      input.requireConsumption === true &&
      scope.remainingMutations !== 0
    ) {
      throw new Error("REAL_FORUM_WRITE_GRANT_NOT_CONSUMED");
    }
    return result;
  });
}

export function assertRealForumWriteUnlocked(
  binding?: RealForumWriteMutationBinding
): void {
  const active = writeScope.getStore();
  if (!active || !binding) {
    throw new Error(REAL_FORUM_WRITE_LOCK_CODE);
  }
  const checked = validBinding(binding);
  if (!sameBinding(active.binding, checked)) {
    throw new Error("REAL_FORUM_WRITE_GRANT_BINDING_MISMATCH");
  }
  if (active.remainingMutations !== 1) {
    throw new Error("REAL_FORUM_WRITE_GRANT_CONSUMED");
  }
  const consumedAt = active.currentTime().getTime();
  if (
    !Number.isFinite(consumedAt) ||
    consumedAt >= active.expiresAtMs
  ) {
    throw new Error("REAL_FORUM_WRITE_GRANT_INVALID_OR_EXPIRED");
  }
  active.remainingMutations = 0;
}
