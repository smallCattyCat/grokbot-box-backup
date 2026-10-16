import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../../app/autonomy/outcomes/page.tsx", import.meta.url),
  "utf8"
);

test("outcomes uses an operational, human-readable masthead and keeps safety boundaries visible", () => {
  assert.match(source, /variant="operational"/u);
  assert.match(source, /testId="outcomes-masthead"/u);
  assert.match(source, /title="结果观察"/u);
  assert.match(source, /仅真实确认发布有资格/u);
  assert.match(source, /非因果观察/u);
  assert.match(source, /真实发布关闭/u);
  assert.doesNotMatch(source, /title="近端观察"/u);
  assert.doesNotMatch(
    source,
    /真实 AUTO 执行|SHADOW、STAGE|AUTO 执行已确认发布/u
  );
});

test("outcome rows keep the operator columns compact and fold protocol evidence into audit details", () => {
  assert.match(
    source,
    /formatCourseLabel\(outcome\.decision\.courseAlias, courseNames\)/u
  );
  assert.doesNotMatch(source, /\{outcome\.decision\.courseAlias\}/u);
  assert.match(source, /<summary[^>]*>\s*核查信息/u);
  assert.match(source, /compactHash\(outcome\.eventPrefixHash\)/u);
  assert.match(source, /outcome\.missingReason/u);
  assert.match(source, /pendingPreflight\?\.status/u);

  const tableHead = source.match(/<thead[\s\S]*?<\/thead>/u)?.[0] ?? "";
  assert.match(tableHead, /课程/u);
  assert.match(tableHead, /窗口/u);
  assert.match(tableHead, /状态/u);
  assert.match(tableHead, /观察时间/u);
  assert.match(tableHead, /作者返回/u);
  assert.match(tableHead, /深度/u);
  assert.match(tableHead, /新参与者/u);
  assert.match(tableHead, /证据来源/u);
  assert.match(tableHead, /覆盖状态/u);
  assert.doesNotMatch(tableHead, /事件前缀|删失原因|预检/u);
});
