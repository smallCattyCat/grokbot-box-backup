import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const layoutSource = read("../../app/layout.tsx");
const globalsSource = read("../../app/globals.css");
const subnavSource = read("../../components/AutonomySubnav.tsx");
const workbenchSource = read("../../components/workbench/AgentWorkbench.tsx");
const workbenchCss = read("../../components/workbench/Workbench.module.css");
const policySource = read("../../app/autonomy/policy/page.tsx");

test("主导航只保留五个运营工作域，研究实验进入治理二级入口", () => {
  const navBlock = layoutSource.match(/const navItems = \[([\s\S]*?)\n\];/u)?.[1] ?? "";
  const labels = [...navBlock.matchAll(/label:\s*"([^"]+)"/gu)].map((match) => match[1]);

  assert.deepEqual(labels, ["工作台", "课程世界", "运行记录", "结果观察", "治理"]);
  assert.doesNotMatch(navBlock, /scenario-lab/u);
  assert.match(subnavSource, /\["\/scenario-lab",\s*"研究实验"\]/u);
  assert.match(subnavSource, /\["\/platform",\s*"社区接入"\]/u);
  assert.match(subnavSource, /研究实验/u);
});

test("空闲工作台首屏显示课程脉搏与单一安全边界", () => {
  assert.match(workbenchSource, /课程脉搏/u);
  assert.match(workbenchSource, /观察事件/u);
  assert.match(workbenchSource, /讨论线程/u);
  assert.match(workbenchSource, /待研判/u);
  assert.match(workbenchSource, /只读观察 · 平台写入 0/u);
  assert.match(workbenchSource, /formatDecisionReason\(normalized\)/u);
});

test("移动空闲工作台不保留大段顶部空白或空输入滚动", () => {
  assert.match(
    workbenchCss,
    /\.page\[data-idle-landing="true"\] \.conversationPane\s*\{[\s\S]*?padding: clamp\(2rem, 8vh, 5rem\)/u
  );
  assert.match(
    workbenchCss,
    /\.page\[data-idle-landing="true"\] \.conversationComposer \.promptInput\s*\{[\s\S]*?overflow-y: hidden/u
  );
  assert.match(
    globalsSource,
    /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/u
  );
});

test("治理页可见呈现可教回合的跨轮记忆、自动让位与零写边界", () => {
  assert.match(policySource, /Teachable Episode Controller/u);
  assert.match(policySource, /后续自动等待、让位或结束/u);
  assert.match(policySource, /相同目标与策略不会重复生成 SHADOW 草稿/u);
  assert.match(policySource, /学习者可忽略、纠正、改向或停止/u);
  assert.match(policySource, /外置状态 · 零平台写入/u);
});
