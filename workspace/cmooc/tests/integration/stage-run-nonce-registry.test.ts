import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  executeStageCompanionRun,
  issueStageCompanionToken,
  SimulatedStageCompanionDriver,
  type StageCompanionPageState
} from "../../lib/live-runtime/stage-companion";
import { PrismaStageRunNonceRegistry } from "../../lib/live-runtime/stage-run-nonce-registry";
import {
  hashTransientDraftBody
} from "../../lib/live-runtime/draft-content";

const TEST_DATABASE_URL = "file:./test.db";
const TRANSIENT_DRAFT =
  "TRANSIENT_STAGE_BODY_MUST_NOT_ENTER_NONCE_STORAGE";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function prismaClient(): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: { url: TEST_DATABASE_URL }
    }
  });
}

function stageFixture() {
  const issuedAt = new Date("2026-07-30T05:00:00.000Z");
  const signingSecret = Buffer.alloc(32, 41);
  const hashes = {
    courseLocatorHash: hash("nonce-course-locator"),
    pageIdentityHash: hash("nonce-page-identity"),
    driverSessionKey: hash("nonce-driver-session"),
    opportunityReceiptHash: hash("nonce-opportunity"),
    revalidationReceiptHash: hash("nonce-revalidation"),
    afterObservationReceiptHash: hash(
      "nonce-after-observation"
    ),
    guardReceiptHash: hash("nonce-network-guard"),
    targetVersionHash: hash("nonce-target-version"),
    draftContentHash: hashTransientDraftBody(TRANSIENT_DRAFT)
  };
  const token = issueStageCompanionToken({
    courseAlias: "nonce-registry-test",
    allowedOrigin: "https://stage.example.test",
    ...hashes,
    signingSecret,
    now: issuedAt,
    expiresInSeconds: 90,
    nonce:
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
  });
  const pageState: StageCompanionPageState = {
    origin: "https://stage.example.test",
    courseAlias: "nonce-registry-test",
    courseLocatorHash: hashes.courseLocatorHash,
    pageIdentityHash: hashes.pageIdentityHash,
    driverSessionKey: hashes.driverSessionKey,
    targetVersionHash: hashes.targetVersionHash,
    activeTab: true,
    pageReady: true,
    editorVisible: true,
    containsForumText: false
  };
  return {
    issuedAt,
    signingSecret,
    hashes,
    token,
    pageState
  };
}

test("Prisma registry prevents concurrent and post-restart STAGE replay without persisting body or platform identity", async () => {
  const firstClient = prismaClient();
  const secondClient = prismaClient();
  let restartedClient: PrismaClient | null = null;
  let firstDisconnected = false;
  try {
    await firstClient.$executeRaw`
      DELETE FROM "StageRunNonceClaim"
    `;
    const concurrentInput = {
      runNonceHash: hash("concurrent-nonce"),
      now: "2026-07-30T05:00:00.000Z",
      expiresAt: "2026-07-30T05:01:00.000Z"
    };
    const concurrentResults = await Promise.all([
      new PrismaStageRunNonceRegistry(firstClient).claim(
        concurrentInput
      ),
      new PrismaStageRunNonceRegistry(secondClient).claim(
        concurrentInput
      )
    ]);
    assert.deepEqual(
      [...concurrentResults].sort(),
      [false, true]
    );

    const fixture = stageFixture();
    const firstDriver = new SimulatedStageCompanionDriver(
      fixture.pageState,
      fixture.hashes.guardReceiptHash
    );
    const staged = await executeStageCompanionRun({
      token: fixture.token,
      signingSecret: fixture.signingSecret,
      nonceRegistry: new PrismaStageRunNonceRegistry(
        firstClient
      ),
      driver: firstDriver,
      transientDraft: TRANSIENT_DRAFT,
      now: () =>
        new Date(fixture.issuedAt.getTime() + 1_000)
    });
    assert.equal(staged.receipt.sentMutationCount, 0);
    assert.equal(staged.receipt.publishAttempted, false);
    assert.equal(await firstDriver.readEditor(), "");

    await firstClient.$disconnect();
    firstDisconnected = true;
    restartedClient = prismaClient();
    const replayDriver = new SimulatedStageCompanionDriver(
      fixture.pageState,
      fixture.hashes.guardReceiptHash
    );
    await assert.rejects(
      () =>
        executeStageCompanionRun({
          token: fixture.token,
          signingSecret: fixture.signingSecret,
          nonceRegistry: new PrismaStageRunNonceRegistry(
            restartedClient!
          ),
          driver: replayDriver,
          transientDraft: TRANSIENT_DRAFT,
          now: () =>
            new Date(fixture.issuedAt.getTime() + 2_000)
        }),
      /STAGE_COMPANION_NONCE_ALREADY_USED/
    );
    assert.equal(replayDriver.counters.writes, 0);

    const persisted = await restartedClient.$queryRaw<
      Array<{
        runNonceHash: string;
        expiresAt: Date;
        claimedAt: Date;
        createdAt: Date;
      }>
    >`
      SELECT
        "runNonceHash",
        "expiresAt",
        "claimedAt",
        "createdAt"
      FROM "StageRunNonceClaim"
      ORDER BY "runNonceHash"
    `;
    assert.equal(persisted.length, 2);
    assert.deepEqual(
      Object.keys(persisted[0]).sort(),
      [
        "claimedAt",
        "createdAt",
        "expiresAt",
        "runNonceHash"
      ]
    );
    const serialized = JSON.stringify(persisted);
    assert.equal(serialized.includes(TRANSIENT_DRAFT), false);
    assert.equal(
      serialized.includes("stage.example.test"),
      false
    );
    assert.equal(
      serialized.includes("nonce-registry-test"),
      false
    );
  } finally {
    const cleanupClient =
      restartedClient ?? secondClient;
    await cleanupClient.$executeRaw`
      DELETE FROM "StageRunNonceClaim"
    `.catch(() => undefined);
    if (!firstDisconnected) {
      await firstClient.$disconnect();
    }
    await secondClient.$disconnect();
    if (restartedClient) {
      await restartedClient.$disconnect();
    }
  }
});
