import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(
  new URL("../../app/platform/page.tsx", import.meta.url),
  "utf8"
);

test("community connection center separates portable foundation from target-platform integration", () => {
  assert.match(pageSource, /把课程智能内核接到新的学习社区/u);
  assert.match(pageSource, /白标入口已就绪/u);
  assert.match(pageSource, /连接器错配即拒绝/u);
  assert.match(pageSource, /平台写入 0/u);
  assert.match(pageSource, /待目标环境/u);
  assert.match(pageSource, /目标社区的只读 API、认证方式和页面结构/u);
  assert.doesNotMatch(pageSource, /小盒(?:已|可直接|开箱即用)/u);
});

test("current cMOOC diagnostic stays available as an advanced detail", () => {
  assert.match(pageSource, /<details[\s\S]*?open>/u);
  assert.match(pageSource, /当前 cMOOC 连接器只读诊断/u);
  assert.match(pageSource, /<PlatformReadinessPanel \/>/u);
});
