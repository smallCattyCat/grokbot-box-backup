import type { PrismaClient } from "@prisma/client";
import type { StageRunNonceRegistry } from "./stage-companion";

const HASH_PATTERN = /^[a-f0-9]{64}$/;

type StageRunNoncePersistence = Pick<
  PrismaClient,
  "$executeRaw"
>;

function canonicalHash(value: string): string {
  if (!HASH_PATTERN.test(value)) {
    throw new Error(
      "STAGE_RUN_NONCE_HASH_INVALID"
    );
  }
  return value;
}

function canonicalTime(value: string, code: string): Date {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(code);
  }
  return new Date(milliseconds);
}

export class PrismaStageRunNonceRegistry
implements StageRunNonceRegistry {
  constructor(
    private readonly prisma: StageRunNoncePersistence
  ) {}

  async claim(input: {
    runNonceHash: string;
    expiresAt: string;
    now: string;
  }): Promise<boolean> {
    const runNonceHash = canonicalHash(input.runNonceHash);
    const expiresAt = canonicalTime(
      input.expiresAt,
      "STAGE_RUN_NONCE_EXPIRY_INVALID"
    );
    const claimedAt = canonicalTime(
      input.now,
      "STAGE_RUN_NONCE_CLAIM_TIME_INVALID"
    );
    if (claimedAt.getTime() >= expiresAt.getTime()) {
      return false;
    }

    const inserted = await this.prisma.$executeRaw`
      INSERT OR IGNORE INTO "StageRunNonceClaim"
        ("runNonceHash", "expiresAt", "claimedAt")
      VALUES
        (${runNonceHash}, ${expiresAt}, ${claimedAt})
    `;
    if (inserted !== 0 && inserted !== 1) {
      throw new Error(
        "STAGE_RUN_NONCE_CLAIM_RESULT_INVALID"
      );
    }
    return inserted === 1;
  }
}
