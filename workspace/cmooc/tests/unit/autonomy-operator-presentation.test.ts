import assert from "node:assert/strict";
import test from "node:test";
import {
  assessOperatorCourseVisibility,
  buildOperatorCoursePresentation,
  deriveOperatorCourseDisplayName,
  filterOperatorCourses,
  isSyntheticOperatorCourseAlias
} from "../../lib/autonomy/operator-presentation";
import {
  selectVerifiedOperatorCourseName
} from "../../lib/autonomy/operator-course-name";
import { selectAutonomyWorldCourse } from "../../lib/autonomy/world-read-model";

test("运营者课程可见性保留真实 bnu-test", () => {
  assert.equal(isSyntheticOperatorCourseAlias("bnu-test"), false);
  assert.deepEqual(
    assessOperatorCourseVisibility({ alias: "bnu-test", enabled: true }),
    { visible: true, reason: "visible" }
  );
});

test("运营者课程列表排除已知回归与 synthetic fixture", () => {
  const visible = filterOperatorCourses([
    { alias: "bnu-test" },
    { alias: "autonomy-integration" },
    { alias: "autonomy-scan-clock-regression-20260810" },
    { alias: "autonomy-semantic-ledger-regression" },
    { alias: "governance-cli-fixture" },
    { alias: "production-course-2026" }
  ]);
  assert.deepEqual(
    visible.map((course) => course.alias),
    ["bnu-test", "production-course-2026"]
  );
});

test("名称启发式保持普通合法 alias，不把课程名误杀", () => {
  assert.equal(isSyntheticOperatorCourseAlias("autonomy-course-2026"), false);
  assert.equal(isSyntheticOperatorCourseAlias("autonomy-scan-course"), false);
  assert.equal(isSyntheticOperatorCourseAlias("community-regression-study"), false);
  assert.equal(isSyntheticOperatorCourseAlias("history-and-memory"), false);
  assert.equal(
    assessOperatorCourseVisibility({
      alias: "autonomy-course-2026",
      source: "live"
    }).visible,
    true
  );
});

test("显式来源与 flags 优先于名称启发式并 fail closed", () => {
  assert.equal(
    assessOperatorCourseVisibility({
      alias: "production-course",
      synthetic: true
    }).reason,
    "explicit_synthetic"
  );
  assert.equal(
    assessOperatorCourseVisibility({
      alias: "production-course",
      source: "regression"
    }).reason,
    "fixture_source"
  );
  assert.equal(
    assessOperatorCourseVisibility({
      alias: "production-course",
      enabled: false
    }).reason,
    "disabled_manifest"
  );
});

test("请求隐藏课程时选择器回退到可见课程并保留 notice 所需差异", () => {
  const courses = [
    { alias: "bnu-test", label: "课程 01", operatorVisible: true },
    {
      alias: "autonomy-scan-clock-regression-20260810",
      label: "课程 02",
      operatorVisible: false
    }
  ];
  assert.equal(
    selectAutonomyWorldCourse({
      courses,
      requestedCourse: "autonomy-scan-clock-regression-20260810",
      latestSnapshotCourseAlias: "autonomy-scan-clock-regression-20260810"
    })?.alias,
    "bnu-test"
  );
});

test("展示名优先使用可信人类名称，alias 或生成编号不被冒充", () => {
  assert.equal(
    deriveOperatorCourseDisplayName({
      alias: "bnu-test",
      label: "AI 课程 · bnu-test"
    }),
    "AI 课程"
  );
  assert.equal(
    deriveOperatorCourseDisplayName({
      alias: "bnu-test",
      label: "课程 01 · bnu-test"
    }),
    null
  );
  assert.equal(
    deriveOperatorCourseDisplayName({ alias: "bnu-test", label: "bnu-test" }),
    null
  );
  assert.deepEqual(
    buildOperatorCoursePresentation({
      alias: "bnu-test",
      label: "课程 01 · bnu-test",
      ordinal: 1
    }),
    { alias: "bnu-test", label: "课程 01", displayName: null }
  );
});

test("课程名称只接受精确 Manifest 绑定的非空标题", () => {
  assert.equal(
    selectVerifiedOperatorCourseName({
      alias: "bnu-test",
      manifestHash: "a".repeat(64),
      expectedManifestHash: "a".repeat(64),
      displayName: "生成式课程的设计与实施（常态公开课）"
    }),
    "生成式课程的设计与实施（常态公开课）"
  );
  assert.equal(
    selectVerifiedOperatorCourseName({
      alias: "bnu-test",
      manifestHash: "a".repeat(64),
      expectedManifestHash: "b".repeat(64),
      displayName: "不应显示"
    }),
    null
  );
  assert.equal(
    selectVerifiedOperatorCourseName({
      alias: "bnu-test",
      manifestHash: "a".repeat(64),
      expectedManifestHash: "a".repeat(64),
      displayName: "bnu-test"
    }),
    null
  );
  assert.equal(
    selectVerifiedOperatorCourseName({
      alias: "bnu-test",
      manifestHash: "a".repeat(64),
      expectedManifestHash: "a".repeat(64),
      displayName: "生成式课程 · bnu-test"
    }),
    null
  );
});
