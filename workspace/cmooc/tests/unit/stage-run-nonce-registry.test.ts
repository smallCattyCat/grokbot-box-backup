import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { PrismaStageRunNonceRegistry } from "../../lib/live-runtime/stage-run-nonce-registry";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(result: number) {
  const calls: Array<{
    sql: string;
    values: unknown[];
  }> = [];
  const persistence = {
    $executeRaw: async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      calls.push({
        sql: strings.join("?"),
        values
      });
      return result;
    }
  } as unknown as ConstructorParameters<
    typeof PrismaStageRunNonceRegistry
  >[0];
  return {
    calls,
    registry: new PrismaStageRunNonceRegistry(persistence)
  };
}

test("Prisma nonce claim uses one atomic insert with only a hash and times", async () => {
  const current = fixture(1);
  const claimed = await current.registry.claim({
    runNonceHash: hash("nonce"),
    now: "2026-07-30T05:00:00.000Z",
    expiresAt: "2026-07-30T05:01:00.000Z"
  });

  assert.equal(claimed, true);
  assert.equal(current.calls.length, 1);
  assert.match(
    current.calls[0].sql,
    /INSERT OR IGNORE INTO "StageRunNonceClaim"/
  );
  assert.deepEqual(current.calls[0].values, [
    hash("nonce"),
    new Date("2026-07-30T05:01:00.000Z"),
    new Date("2026-07-30T05:00:00.000Z")
  ]);
});

test("duplicate and expired nonce claims fail closed", async () => {
  const duplicate = fixture(0);
  assert.equal(
    await duplicate.registry.claim({
      runNonceHash: hash("duplicate"),
      now: "2026-07-30T05:00:00.000Z",
      expiresAt: "2026-07-30T05:01:00.000Z"
    }),
    false
  );
  assert.equal(duplicate.calls.length, 1);

  const expired = fixture(1);
  assert.equal(
    await expired.registry.claim({
      runNonceHash: hash("expired"),
      now: "2026-07-30T05:01:00.000Z",
      expiresAt: "2026-07-30T05:01:00.000Z"
    }),
    false
  );
  assert.equal(expired.calls.length, 0);
});

test("malformed input and impossible database results are rejected", async () => {
  const invalid = fixture(1);
  await assert.rejects(
    () =>
      invalid.registry.claim({
        runNonceHash: "not-a-hash",
        now: "2026-07-30T05:00:00.000Z",
        expiresAt: "2026-07-30T05:01:00.000Z"
      }),
    /STAGE_RUN_NONCE_HASH_INVALID/
  );
  await assert.rejects(
    () =>
      invalid.registry.claim({
        runNonceHash: hash("invalid-time"),
        now: "not-a-time",
        expiresAt: "2026-07-30T05:01:00.000Z"
      }),
    /STAGE_RUN_NONCE_CLAIM_TIME_INVALID/
  );
  assert.equal(invalid.calls.length, 0);

  const impossible = fixture(2);
  await assert.rejects(
    () =>
      impossible.registry.claim({
        runNonceHash: hash("impossible"),
        now: "2026-07-30T05:00:00.000Z",
        expiresAt: "2026-07-30T05:01:00.000Z"
      }),
    /STAGE_RUN_NONCE_CLAIM_RESULT_INVALID/
  );
});
