import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../../app/autonomy/governance/page.tsx", import.meta.url),
  "utf8"
);
const apiSource = readFileSync(
  new URL("../../app/api/autonomy/governance/route.ts", import.meta.url),
  "utf8"
);

test("治理页使用紧凑 operational header，并明确只读/真实写入边界", () => {
  assert.match(source, /<CommandShell\s+variant="operational"/);
  assert.match(source, /eyebrow="治理 · 只读视图"/);
  assert.match(source, /真实(?:发布|写入)关闭/);
  assert.match(source, /缺策略即拒绝/);
});

test("治理页优先显示可信课程名，缺失时才回退中性编号", () => {
  assert.match(source, /courseLabels/);
  assert.match(source, /verifiedCourseNames\.get\(alias\)/);
  assert.match(source, /课程 \$\{String\(index \+ 1\)\.padStart\(2, "0"\)\}/);
  assert.match(source, /内部课程别名/);
  assert.doesNotMatch(source, /<p className="mt-1 text-slate-100">\{row\.courseAlias\}<\/p>/);
});

test("治理页把版本、hash、动作码和 lineage 收进默认折叠核查区", () => {
  assert.match(source, /<summary[^>]*>核查信息<\/summary>/);
  assert.match(source, /策略版本/);
  assert.match(source, /Manifest/);
  assert.match(source, /治理链/);
  assert.match(source, /内部动作/);
  assert.match(source, /原因码/);
  assert.match(source, /变更链/);
  assert.doesNotMatch(source, /当前只有 root baseline/u);
  assert.doesNotMatch(source, /显示不可变 lineage/u);
});

test("治理页使用人类状态/模式标签", () => {
  assert.match(source, /function modeLabel/);
  assert.match(source, /function transitionActionLabel/);
  assert.match(source, /仅观察/);
  assert.match(source, /影子运行/);
  assert.match(source, /已暂停/);
  assert.match(source, /紧急停止/);
});

test("治理页呈现限定 scope 的 soak readiness，且不把本地 qualified 冒充成熟认证", () => {
  const card = source.match(
    /<GlassCard[\s\S]*?data-testid="soak-readiness"[\s\S]*?<\/GlassCard>/u
  );
  assert.ok(card, "应有独立的 soak readiness 卡片");
  assert.match(card[0], /RC13 · 长时运行证据/u);
  assert.match(card[0], /soakStatusLabel\(soakReadiness\.status\)/u);
  assert.match(card[0], /soakReadiness\.profile\.source/u);
  assert.match(card[0], /soakReadiness\.profile\.runtimeVersion/u);
  assert.match(card[0], /soakReadiness\.evidence\.observationSpanMs/u);
  assert.match(card[0], /soakReadiness\.evidence\.completedCount/u);
  assert.match(card[0], /soakReadiness\.evidence\.consecutiveCompletedCount/u);
  assert.match(card[0], /关键 blocker \/ check/u);
  assert.match(source, /unresolved_high_incident_count:\s*"高优先级未解决事件数"/u);
  assert.doesNotMatch(source, /当前无高优先级未结事件/u);
  assert.match(card[0], /本地 qualified ≠ mature-v1 外部认证/u);
  assert.match(card[0], /失败通知送达与成功运行界面抑制仍缺少外部可观测证据/u);
  assert.doesNotMatch(card[0], /evidenceHash|forumText|courseAlias|error\.message/iu);
});

test("治理页 soak readiness 读取失败时保持 fail-closed 且不暴露底层错误", () => {
  assert.match(source, /getAutonomyRuntimeHealth\(\{ prisma, now \}\)/u);
  assert.match(source, /\.then\(\(health\) => health\.soakReadiness\)\s*\.catch\(\(\) => null\)/u);
  assert.match(source, /不会把缺失证据解释为通过/u);
  assert.doesNotMatch(source, /catch \((?:error|cause)\)/u);
});

test("治理页面与 API 只投影 active operator course 的不可变历史", () => {
  for (const surface of [source, apiSource]) {
    assert.match(surface, /filterOperatorCourses/u);
    assert.match(surface, /where:\s*\{ enabled: true \}/u);
    assert.match(surface, /visibleCourseAliases/u);
    assert.match(
      surface,
      /where:\s*\{ courseAlias:\s*\{ in: visibleCourseAliases \} \}/u
    );
  }
  assert.match(source, /停用课程的历史记录继续保留在不可变审计表中/u);
});
