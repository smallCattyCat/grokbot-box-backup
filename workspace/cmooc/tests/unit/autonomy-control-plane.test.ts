import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AutonomyPolicy } from "@prisma/client";
import {
  AUTONOMY_POLICY_SCHEMA_VERSION,
  hashCourseAutonomyPolicy,
  parseCourseAutonomyPolicy,
  validateAutonomyPolicy,
  verifyAutonomyPolicyRecord
} from "../../lib/autonomy/autonomy-policy";
import {
  executeStageCompanionRun,
  InMemoryStageRunNonceRegistry,
  issueStageCompanionToken,
  SimulatedStageCompanionDriver,
  type StageCompanionPageState
} from "../../lib/live-runtime/stage-companion";
import {
  hashTransientDraftBody
} from "../../lib/live-runtime/draft-content";

const TRANSIENT_DRAFT =
  "TRANSIENT_STAGE_BODY_MUST_BE_CLEARED_AND_NEVER_PERSISTED";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function policyRecord(
  overrides: Partial<AutonomyPolicy> = {}
): AutonomyPolicy {
  const policy = parseCourseAutonomyPolicy({
    schemaVersion: AUTONOMY_POLICY_SCHEMA_VERSION,
    courseAlias: "safe-control-course",
    version: "safe-control.auto.v1",
    mode: "AUTO",
    allowedActions: ["forum_reply", "stage_editor"],
    budget: {
      dailyActionLimit: 4,
      perTickActionLimit: 1,
      authorTouchLimit30d: 2
    },
    validFrom: "2026-07-01T00:00:00.000Z",
    validUntil: "2026-08-01T00:00:00.000Z",
    realPublishEnabled: false,
    containsForumText: false
  });
  return {
    id: "policy-safe-control",
    courseAlias: policy.courseAlias,
    version: policy.version,
    status: "active",
    mode: policy.mode,
    allowedActionsJson: JSON.stringify(
      policy.allowedActions
    ),
    budgetJson: JSON.stringify(policy.budget),
    policyHash: hashCourseAutonomyPolicy(policy),
    validFrom: new Date(policy.validFrom),
    validUntil: new Date(policy.validUntil),
    revokedAt: null,
    emergencyHalt: false,
    realPublishEnabled: false,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides
  };
}

test("AutonomyPolicy 严格绑定课程、版本、动作、窗口与真实发布开关", () => {
  const verified = verifyAutonomyPolicyRecord(
    policyRecord()
  );
  assert.equal(
    validateAutonomyPolicy({
      verified,
      courseAlias: "safe-control-course",
      policyVersion: "safe-control.auto.v1",
      action: "forum_reply",
      mode: "AUTO",
      now: new Date("2026-07-10T00:00:00.000Z")
    }).valid,
    true
  );
  assert.deepEqual(
    validateAutonomyPolicy({
      verified,
      courseAlias: "safe-control-course",
      policyVersion: "safe-control.auto.v1",
      action: "forum_reply",
      mode: "AUTO",
      now: new Date("2026-07-10T00:00:00.000Z"),
      requireRealPublish: true
    }).code,
    "real_publish_not_authorized"
  );
  assert.deepEqual(
    validateAutonomyPolicy({
      verified: verifyAutonomyPolicyRecord(
        policyRecord({ emergencyHalt: true })
      ),
      courseAlias: "safe-control-course",
      policyVersion: "safe-control.auto.v1",
      action: "forum_reply",
      mode: "AUTO",
      now: new Date("2026-07-10T00:00:00.000Z")
    }).code,
    "emergency_halt"
  );
  assert.throws(
    () =>
      verifyAutonomyPolicyRecord(
        policyRecord({ policyHash: "f".repeat(64) })
      ),
    /AUTONOMY_POLICY_HASH_MISMATCH/
  );
  assert.throws(
    () =>
      parseCourseAutonomyPolicy({
        schemaVersion: AUTONOMY_POLICY_SCHEMA_VERSION,
        courseAlias: "safe-control-course",
        version: "safe-control.auto.v2",
        mode: "AUTO",
        allowedActions: ["forum_reply"],
        budget: {
          dailyActionLimit: 1,
          perTickActionLimit: 1,
          authorTouchLimit30d: 1
        },
        validFrom: "2026-07-01T00:00:00.000Z",
        validUntil: "2026-08-01T00:00:00.000Z",
        realPublishEnabled: false,
        containsForumText: false,
        rawCourseId: "forbidden"
      }),
    /未允许字段/
  );
});

function stageFixture() {
  const now = new Date("2026-07-10T12:00:00.000Z");
  const secret = Buffer.alloc(32, 37);
  const hashes = {
    courseLocatorHash: hash("course-locator"),
    pageIdentityHash: hash("page-identity"),
    driverSessionKey: hash("driver-session"),
    opportunityReceiptHash: hash("opportunity"),
    revalidationReceiptHash: hash("revalidation"),
    afterObservationReceiptHash: hash("after-observation"),
    guardReceiptHash: hash("network-guard"),
    targetVersionHash: hash("target-version"),
    draftContentHash: hashTransientDraftBody(TRANSIENT_DRAFT)
  };
  const token = issueStageCompanionToken({
    courseAlias: "safe-control-course",
    allowedOrigin: "https://cmooc.example.test",
    ...hashes,
    signingSecret: secret,
    now,
    expiresInSeconds: 90,
    nonce:
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  });
  const pageState: StageCompanionPageState = {
    origin: "https://cmooc.example.test",
    courseAlias: "safe-control-course",
    courseLocatorHash: hashes.courseLocatorHash,
    pageIdentityHash: hashes.pageIdentityHash,
    driverSessionKey: hashes.driverSessionKey,
    targetVersionHash: hashes.targetVersionHash,
    activeTab: true,
    pageReady: true,
    editorVisible: true,
    containsForumText: false
  };
  return { now, secret, hashes, token, pageState };
}

test("认证 STAGE companion 只在同标签页写入、回读并清空，回执不含正文", async () => {
  const fixture = stageFixture();
  const nonceRegistry = new InMemoryStageRunNonceRegistry();
  const driver = new SimulatedStageCompanionDriver(
    fixture.pageState,
    fixture.hashes.guardReceiptHash
  );
  const result = await executeStageCompanionRun({
    token: fixture.token,
    signingSecret: fixture.secret,
    nonceRegistry,
    driver,
    transientDraft: TRANSIENT_DRAFT,
    now: () =>
      new Date(fixture.now.getTime() + 1_000)
  });

  assert.equal(
    result.receipt.state,
    "DRAFT_STAGED_VERIFIED_AND_CLEARED_NOT_PUBLISHED"
  );
  assert.equal(result.capture.editorWriteOutcome, "verified");
  assert.equal(result.capture.remoteWriteSent, false);
  assert.equal(result.receipt.sentMutationCount, 0);
  assert.equal(driver.counters.writes, 1);
  assert.equal(driver.counters.clears, 1);
  assert.equal(await driver.readEditor(), "");
  assert.equal(
    JSON.stringify(result).includes(TRANSIENT_DRAFT),
    false
  );

  await assert.rejects(
    () =>
      executeStageCompanionRun({
        token: fixture.token,
        signingSecret: fixture.secret,
        nonceRegistry,
        driver,
        transientDraft: TRANSIENT_DRAFT,
        now: () =>
          new Date(fixture.now.getTime() + 2_000)
      }),
    /STAGE_COMPANION_NONCE_ALREADY_USED/
  );
});

test("STAGE companion 在页面、课程或签名漂移时先拒绝且不写编辑器", async () => {
  const fixture = stageFixture();
  const mismatchedDriver =
    new SimulatedStageCompanionDriver(
      {
        ...fixture.pageState,
        pageIdentityHash: hash("different-page")
      },
      fixture.hashes.guardReceiptHash
    );
  await assert.rejects(
    () =>
      executeStageCompanionRun({
        token: fixture.token,
        signingSecret: fixture.secret,
        nonceRegistry: new InMemoryStageRunNonceRegistry(),
        driver: mismatchedDriver,
        transientDraft: TRANSIENT_DRAFT,
        now: () =>
          new Date(fixture.now.getTime() + 1_000)
      }),
    /STAGE_COMPANION_PAGE_GUARD_MISMATCH/
  );
  assert.equal(mismatchedDriver.counters.writes, 0);

  const tampered = structuredClone(fixture.token);
  tampered.grant.targetVersionHash = hash(
    "tampered-target-version"
  );
  const untamperedDriver =
    new SimulatedStageCompanionDriver(
      fixture.pageState,
      fixture.hashes.guardReceiptHash
    );
  await assert.rejects(
    () =>
      executeStageCompanionRun({
        token: tampered,
        signingSecret: fixture.secret,
        nonceRegistry: new InMemoryStageRunNonceRegistry(),
        driver: untamperedDriver,
        transientDraft: TRANSIENT_DRAFT,
        now: () =>
          new Date(fixture.now.getTime() + 1_000)
      }),
    /STAGE_COMPANION_TOKEN_AUTH_FAILED/
  );
  assert.equal(untamperedDriver.counters.writes, 0);
});
