import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ONE_SHOT_DAILY_ACTION_LIMIT,
  normalizeOneShotDailyActionLimit
} from "../../lib/autonomy/one-shot-execution";
import {
  assertOneShotReadinessState
} from "../../lib/autonomy/one-shot-runner";

test("L3 重复执行允许已确认历史，但拒绝任何开放或结果不明状态", () => {
  assert.doesNotThrow(() =>
    assertOneShotReadinessState({
      globalHardLock: true,
      manifestRealPublishEnabled: false,
      forumSettingRealPublishEnabled: false,
      activeRealPolicyCount: 0,
      openRealPermitCount: 0,
      blockingRealAttemptCount: 0
    })
  );

  for (const override of [
    { activeRealPolicyCount: 1 },
    { openRealPermitCount: 1 },
    { blockingRealAttemptCount: 1 },
    { manifestRealPublishEnabled: true },
    { forumSettingRealPublishEnabled: true },
    { globalHardLock: false }
  ]) {
    assert.throws(
      () =>
        assertOneShotReadinessState({
          globalHardLock: true,
          manifestRealPublishEnabled: false,
          forumSettingRealPublishEnabled: false,
          activeRealPolicyCount: 0,
          openRealPermitCount: 0,
          blockingRealAttemptCount: 0,
          ...override
        }),
      /L3_PREFLIGHT_NOT_CLEANLY_LOCKED/
    );
  }
});

test("L3 单动作策略显式绑定绝对日上限且保持小范围", () => {
  assert.equal(normalizeOneShotDailyActionLimit(undefined), 1);
  assert.equal(normalizeOneShotDailyActionLimit(2), 2);
  assert.equal(
    normalizeOneShotDailyActionLimit(
      MAX_ONE_SHOT_DAILY_ACTION_LIMIT
    ),
    MAX_ONE_SHOT_DAILY_ACTION_LIMIT
  );
  for (const invalid of [
    0,
    -1,
    1.5,
    MAX_ONE_SHOT_DAILY_ACTION_LIMIT + 1
  ]) {
    assert.throws(
      () => normalizeOneShotDailyActionLimit(invalid),
      /L3_DAILY_ACTION_LIMIT_INVALID/
    );
  }
});
