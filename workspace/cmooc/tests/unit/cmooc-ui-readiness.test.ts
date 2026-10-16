import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeCmoocCourseTargetInput } from "../../lib/forum/normalize-target-input";
import {
  createCmoocUiReadinessReceipt,
  isAllowedCmoocSemanticReadPost,
  type CmoocUiReadinessObservation
} from "../../lib/platform-readiness/cmooc-ui-readiness";

const COURSE_ID = "2059000000000000000";
const COURSE_URL =
  `https://cmooc.bnu.edu.cn/cMOOC/course?courseId=${COURSE_ID}&isBack=1`;
const readinessSource = readFileSync(
  new URL("../../lib/platform-readiness/cmooc-ui-readiness.ts", import.meta.url),
  "utf8"
);

test("混合 Markdown 课程地址优先提取并锁定规范目标", () => {
  const mixed =
    `https://cmooc.bnu.edu.cn/[cMOOC](${COURSE_URL})/course?courseId=${COURSE_ID}&isBack=1`;
  const normalized = normalizeCmoocCourseTargetInput(mixed);

  assert.equal(normalized.url, COURSE_URL);
  assert.equal(normalized.source, "markdown_link");
  assert.equal(normalized.inputWasNormalized, true);
});

test("课程目标归一化不会放宽来源与路径白名单", () => {
  assert.throws(
    () =>
      normalizeCmoocCourseTargetInput(
        `https://attacker.example/cMOOC/course?courseId=${COURSE_ID}`
      ),
    /未找到可验证/
  );
  assert.throws(
    () =>
      normalizeCmoocCourseTargetInput(
        `https://cmooc.bnu.edu.cn/admin?courseId=${COURSE_ID}`
      ),
    /未找到可验证/
  );
});

test("只读 POST 白名单只允许概要读取并拒绝评论、敏感查询与写入", () => {
  const base = {
    method: "POST",
    targetOrigin: "https://cmooc.bnu.edu.cn"
  };
  assert.equal(
    isAllowedCmoocSemanticReadPost({
      ...base,
      url: "https://cmooc.bnu.edu.cn/cmooc-api/sketch/page"
    }),
    true
  );
  assert.equal(
    isAllowedCmoocSemanticReadPost({
      ...base,
      url: "https://cmooc.bnu.edu.cn/cmooc-api/comment/list"
    }),
    false
  );
  assert.equal(
    isAllowedCmoocSemanticReadPost({
      ...base,
      url: "https://cmooc.bnu.edu.cn/cmooc-api/sketch/page?access_token=fixture-secret"
    }),
    false
  );
  assert.equal(
    isAllowedCmoocSemanticReadPost({
      ...base,
      url: "https://cmooc.bnu.edu.cn/cmooc-api/comment/commentModule"
    }),
    false
  );
  assert.equal(
    isAllowedCmoocSemanticReadPost({
      ...base,
      url: "https://cmooc.bnu.edu.cn/cmooc-api/comment/commentReply"
    }),
    false
  );
  assert.equal(
    isAllowedCmoocSemanticReadPost({
      ...base,
      url: "https://attacker.example/cmooc-api/sketch/page"
    }),
    false
  );
});

test("平台 readiness 不提取卡片正文，也不点击卡片进入详情", () => {
  assert.doesNotMatch(readinessSource, /textFingerprintSource/u);
  assert.doesNotMatch(
    readinessSource,
    /locator\("#cSketch \.card"\)\.first\(\)\.click/u
  );
});

function observation(
  overrides: Partial<CmoocUiReadinessObservation> = {}
): CmoocUiReadinessObservation {
  return {
    finalUrl: COURSE_URL,
    browserRuntime: "playwright_chromium",
    courseShellDetected: true,
    categoryTabCount: 7,
    visibleCardCount: 12,
    publicLoginControlDetected: true,
    detailObservation: "not_available_public_session",
    allowedGetOrHeadCount: 18,
    allowedSemanticReadPostCount: 2,
    blockedWriteRequestCount: 2,
    blockedCrossOriginRequestCount: 3,
    apiAssistKinds: ["sketch_page", "course_columns"],
    visibleCardKeys: [
      "111111111111111111111111",
      "222222222222222222222222"
    ],
    selectedThreadKey: null,
    detailEvidenceLevel: "none",
    ...overrides
  };
}

test("真实课程壳、分区与卡片形成去正文概要就绪回执", () => {
  const created = createCmoocUiReadinessReceipt({
    canonicalUrl: COURSE_URL,
    normalizationSource: "exact_url",
    inputWasNormalized: false,
    observedAt: "2026-07-29T12:00:00.000Z",
    observation: observation()
  });

  assert.equal(created.receipt.status, "overview_ready");
  assert.equal(created.receipt.safeToDemonstrate, true);
  assert.equal(
    created.receipt.sessionBoundary,
    "public_unauthenticated"
  );
  assert.equal(created.receipt.realPublishEnabled, false);
  assert.equal(created.receipt.externalWriteAttempted, false);
  assert.equal(created.receipt.containsForumText, false);
  assert.equal(created.receipt.visibleCardKeys.length, 2);
  assert.equal(created.receipt.networkGuardActive, true);
  assert.equal(created.receipt.requestedMutationCount, 2);
  assert.equal(created.receipt.sentMutationCount, 0);
  assert.deepEqual(created.receipt.apiAssistKinds, [
    "course_columns",
    "sketch_page"
  ]);
  const serialized = JSON.stringify(created);
  assert.equal(serialized.includes(COURSE_ID), false);
  assert.equal(serialized.includes("论坛正文"), false);
});

test("只见课程壳时保持 shell_only，不冒充详情观察成功", () => {
  const created = createCmoocUiReadinessReceipt({
    canonicalUrl: COURSE_URL,
    normalizationSource: "course_id_recovery",
    inputWasNormalized: true,
    observedAt: "2026-07-29T12:00:00.000Z",
    observation: observation({
      categoryTabCount: 0,
      visibleCardCount: 0,
      detailObservation: "no_cards"
    })
  });

  assert.equal(created.receipt.status, "shell_only");
  assert.equal(created.receipt.detailObservation, "no_cards");
  assert.equal(created.receipt.safeToDemonstrate, false);
});

test("最终导航偏离已核验课程目标时 fail closed", () => {
  assert.throws(
    () =>
      createCmoocUiReadinessReceipt({
        canonicalUrl: COURSE_URL,
        normalizationSource: "exact_url",
        inputWasNormalized: false,
        observedAt: "2026-07-29T12:00:00.000Z",
        observation: observation({
          finalUrl: "https://cmooc.bnu.edu.cn/cMOOC/home"
        })
      }),
    /导航结果/
  );
});

test("相同课程路径但 courseId 不同仍然 fail closed", () => {
  assert.throws(
    () =>
      createCmoocUiReadinessReceipt({
        canonicalUrl: COURSE_URL,
        normalizationSource: "exact_url",
        inputWasNormalized: false,
        observedAt: "2026-07-29T12:00:00.000Z",
        observation: observation({
          finalUrl:
            "https://cmooc.bnu.edu.cn/cMOOC/course?courseId=2059000000000000001&isBack=1"
        })
      }),
    /导航结果/
  );
});
