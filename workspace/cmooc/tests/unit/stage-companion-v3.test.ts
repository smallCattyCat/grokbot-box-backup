import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  executeStageCompanionRun,
  InMemoryStageRunNonceRegistry,
  issueStageCompanionTokenV3,
  STAGE_COMPANION_GRANT_V3_SCHEMA_VERSION,
  STAGE_COMPANION_RECEIPT_V3_SCHEMA_VERSION,
  STAGE_COMPANION_TOKEN_V3_SCHEMA_VERSION,
  SimulatedStageCompanionDriver,
  verifyStageCompanionReceiptV3,
  verifyStageCompanionToken,
  type StageCompanionPageState
} from "../../lib/live-runtime/stage-companion";
import { hashTransientDraftBody } from "../../lib/live-runtime/draft-content";

const DRAFT = "transient v3 body";
const ISSUED_AT = new Date("2026-08-13T12:00:20.000Z");
const RESOLVED_AT = "2026-08-13T12:00:10.000Z";
const SECRET = Buffer.alloc(32, 83);

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixture() {
  const hashes = Object.freeze({
    courseLocatorHash: hash("course-locator"),
    pageIdentityHash: hash("page-identity"),
    driverSessionKey: hash("driver-session"),
    opportunityReceiptHash: hash("opportunity"),
    sourceRevalidationReceiptHash: hash("source-revalidation"),
    sourceAfterObservationReceiptHash: hash("source-after-observation"),
    freshObservationHash: hash("fresh-observation"),
    eventSetHash: hash("fresh-event-set"),
    targetLocatorHash: hash("fresh-target-locator"),
    resolvedTargetReceiptHash: hash("resolved-target-receipt"),
    guardReceiptHash: hash("guard"),
    targetVersionHash: hash("target-version"),
    draftContentHash: hashTransientDraftBody(DRAFT)
  });
  const token = issueStageCompanionTokenV3({
    courseAlias: "stage-v3-course",
    allowedOrigin: "https://stage.example.test",
    ...hashes,
    resolvedAt: RESOLVED_AT,
    signingSecret: SECRET,
    now: ISSUED_AT,
    expiresInSeconds: 90,
    nonce: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
  });
  const page: StageCompanionPageState = {
    origin: "https://stage.example.test",
    courseAlias: "stage-v3-course",
    courseLocatorHash: hashes.courseLocatorHash,
    pageIdentityHash: hashes.pageIdentityHash,
    driverSessionKey: hashes.driverSessionKey,
    targetVersionHash: hashes.targetVersionHash,
    targetLocatorHash: hashes.targetLocatorHash,
    activeTab: true,
    pageReady: true,
    editorVisible: true,
    containsForumText: false
  };
  return { hashes, page, token };
}

test("STAGE v3 grant closes and signs source, fresh-observation, event-set, locator, and resolved-target causality", () => {
  const { hashes, token } = fixture();
  assert.equal(STAGE_COMPANION_GRANT_V3_SCHEMA_VERSION, "cmooc.stage-companion-grant.v3");
  assert.equal(STAGE_COMPANION_TOKEN_V3_SCHEMA_VERSION, "cmooc.stage-companion-token.v3");
  assert.equal(STAGE_COMPANION_RECEIPT_V3_SCHEMA_VERSION, "cmooc.stage-companion-receipt.v3");
  assert.equal(token.grant.sourceRevalidationReceiptHash, hashes.sourceRevalidationReceiptHash);
  assert.equal(token.grant.sourceAfterObservationReceiptHash, hashes.sourceAfterObservationReceiptHash);
  assert.equal(token.grant.freshObservationHash, hashes.freshObservationHash);
  assert.notEqual(token.grant.freshObservationHash, token.grant.sourceAfterObservationReceiptHash);
  assert.equal(token.grant.eventSetHash, hashes.eventSetHash);
  assert.equal(token.grant.targetLocatorHash, hashes.targetLocatorHash);
  assert.equal(token.grant.resolvedTargetReceiptHash, hashes.resolvedTargetReceiptHash);
  assert.equal(token.grant.resolvedAt, RESOLVED_AT);
  assert.equal(token.grant.containsIdentity, false);
  assert.equal(token.grant.containsSecrets, false);
  assert.equal(token.containsIdentity, false);
  assert.equal(token.containsSecrets, false);
  assert.deepEqual(Object.keys(token).sort(), [
    "containsForumText",
    "containsIdentity",
    "containsSecrets",
    "grant",
    "runNonce",
    "schemaVersion",
    "signature"
  ]);
});

test("STAGE v3 refuses a fresh observation disguised as the source-after observation", () => {
  const { hashes } = fixture();
  assert.throws(
    () =>
      issueStageCompanionTokenV3({
        courseAlias: "stage-v3-course",
        allowedOrigin: "https://stage.example.test",
        ...hashes,
        freshObservationHash: hashes.sourceAfterObservationReceiptHash,
        resolvedAt: RESOLVED_AT,
        signingSecret: SECRET,
        now: ISSUED_AT
      }),
    /STAGE_COMPANION_CAUSAL_BINDING_INVALID/
  );
});

test("STAGE v3 rejects stale/future resolution and unsigned or signed schema expansion", () => {
  const { hashes, token } = fixture();
  for (const resolvedAt of [
    "2026-08-13T11:59:49.999Z",
    "2026-08-13T12:00:20.001Z",
    "2026-08-13T12:00:25.001Z",
    "2026-08-13T12:00:10+00:00"
  ]) {
    assert.throws(
      () =>
        issueStageCompanionTokenV3({
          courseAlias: "stage-v3-course",
          allowedOrigin: "https://stage.example.test",
          ...hashes,
          resolvedAt,
          signingSecret: SECRET,
          now: ISSUED_AT
        }),
      /STAGE_COMPANION_RESOLUTION_TIME_INVALID/
    );
  }

  const expandedToken = { ...structuredClone(token), forumBody: "forbidden" };
  assert.throws(
    () =>
      verifyStageCompanionToken({
        token: expandedToken,
        signingSecret: SECRET,
        now: new Date("2026-08-13T12:00:21.000Z")
      }),
    /STAGE_COMPANION_TOKEN_INVALID/
  );
  const expandedGrant = structuredClone(token);
  Object.assign(expandedGrant.grant, { identity: "forbidden" });
  assert.throws(
    () =>
      verifyStageCompanionToken({
        token: expandedGrant,
        signingSecret: SECRET,
        now: new Date("2026-08-13T12:00:21.000Z")
      }),
    /STAGE_COMPANION_TOKEN_INVALID/
  );
});

test("STAGE v3 receipt carries the exact fresh target proof while capture keeps source revalidation semantics", async () => {
  const { hashes, page, token } = fixture();
  const result = await executeStageCompanionRun({
    token,
    signingSecret: SECRET,
    nonceRegistry: new InMemoryStageRunNonceRegistry(),
    driver: new SimulatedStageCompanionDriver(page, hashes.guardReceiptHash),
    transientDraft: DRAFT,
    now: () => new Date("2026-08-13T12:00:21.000Z")
  });

  assert.equal(result.receipt.sourceRevalidationReceiptHash, hashes.sourceRevalidationReceiptHash);
  assert.equal(result.receipt.sourceAfterObservationReceiptHash, hashes.sourceAfterObservationReceiptHash);
  assert.equal(result.receipt.freshObservationHash, hashes.freshObservationHash);
  assert.equal(result.receipt.eventSetHash, hashes.eventSetHash);
  assert.equal(result.receipt.targetLocatorHash, hashes.targetLocatorHash);
  assert.equal(result.receipt.resolvedTargetReceiptHash, hashes.resolvedTargetReceiptHash);
  assert.equal(result.receipt.resolvedAt, RESOLVED_AT);
  assert.equal(result.receipt.sentMutationCount, 0);
  assert.equal(result.receipt.publishAttempted, false);
  assert.equal(result.receipt.realPublishEnabled, false);
  assert.equal(result.receipt.containsForumText, false);
  assert.equal(result.receipt.containsIdentity, false);
  assert.equal(result.receipt.containsSecrets, false);
  assert.deepEqual(
    verifyStageCompanionReceiptV3({
      receipt: result.receipt,
      receiptHash: result.receiptHash,
      grant: token.grant
    }),
    result.receipt
  );

  const expandedReceipt = {
    ...result.receipt,
    platformIdentity: "forbidden"
  };
  assert.throws(
    () =>
      verifyStageCompanionReceiptV3({
        receipt: expandedReceipt,
        receiptHash: result.receiptHash,
        grant: token.grant
      }),
    /STAGE_COMPANION_RECEIPT_V3_INVALID/
  );
  const nonCanonicalHash = {
    ...result.receipt,
    eventSetHash: result.receipt.eventSetHash.toUpperCase()
  };
  assert.throws(
    () =>
      verifyStageCompanionReceiptV3({
        receipt: nonCanonicalHash,
        receiptHash: result.receiptHash,
        grant: token.grant
      }),
    /STAGE_COMPANION_RECEIPT_V3_INVALID/
  );
  const driftedFresh = {
    ...result.receipt,
    freshObservationHash: hashes.sourceAfterObservationReceiptHash
  };
  assert.throws(
    () =>
      verifyStageCompanionReceiptV3({
        receipt: driftedFresh,
        receiptHash: result.receiptHash,
        grant: token.grant
      }),
    /STAGE_COMPANION_RECEIPT_V3_INVALID/
  );

  assert.equal(result.capture.revalidationReceiptHash, hashes.sourceRevalidationReceiptHash);
  assert.equal(result.capture.afterObservationReceiptHash, hashes.sourceAfterObservationReceiptHash);
  assert.notEqual(result.capture.afterObservationReceiptHash, hashes.freshObservationHash);
  assert.equal(JSON.stringify(result).includes(DRAFT), false);
});

test("STAGE v3 refuses target-locator drift before the first editor write", async () => {
  const { hashes, page, token } = fixture();
  const driver = new SimulatedStageCompanionDriver(
    {
      ...page,
      targetLocatorHash: hash("drifted-target-locator")
    },
    hashes.guardReceiptHash
  );
  await assert.rejects(
    () =>
      executeStageCompanionRun({
        token,
        signingSecret: SECRET,
        nonceRegistry: new InMemoryStageRunNonceRegistry(),
        driver,
        transientDraft: DRAFT,
        now: () => new Date("2026-08-13T12:00:21.000Z")
      }),
    /STAGE_COMPANION_PAGE_GUARD_MISMATCH/
  );
  assert.equal(driver.counters.writes, 0);
  assert.equal(driver.counters.clears, 0);
});
