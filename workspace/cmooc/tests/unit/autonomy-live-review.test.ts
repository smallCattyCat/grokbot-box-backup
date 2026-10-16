import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../../app/review/live/page.tsx", import.meta.url),
  "utf8"
);

test("长期审核页直接读取安全的外层唤醒回执投影", () => {
  const query = source.match(
    /prisma\.autonomyWorkerWakeReceipt\.findMany\(\{([\s\S]*?)\n\s*\}\),\n\s*prisma\.reviewEvent/u
  );
  assert.ok(query, "应独立查询 AutonomyWorkerWakeReceipt");

  const select = query[1].match(/select:\s*\{([\s\S]*?)\n\s*\}/u);
  assert.ok(select, "wake 查询必须使用显式 select");

  const selectedFields = [
    ...select[1].matchAll(/^\s+([A-Za-z][A-Za-z0-9]*): true,?$/gmu)
  ].map((match) => match[1]);
  assert.deepEqual(selectedFields, [
    "source",
    "runtimeVersion",
    "status",
    "reasonCode",
    "startedAt",
    "finishedAt"
  ]);
  assert.doesNotMatch(
    query[0],
    /forum|body|content|title|author|cookie|token|password|secret|url|path|identity/iu,
    "wake 查询不得投影正文、身份、地址、凭据或本机路径"
  );
});

test("外层唤醒与课程运行在长期审核页保持不同语义", () => {
  assert.match(source, />\s*外层唤醒回执\s*</u);
  assert.match(source, />\s*近期课程运行\s*</u);
  assert.match(source, /即使本轮有 0/u);
  assert.match(source, /它不是课程运行，也不表示发生了课程干预/u);
  assert.match(source, /它不是外层唤醒回执/u);
  assert.match(source, /来源 ·/u);
  assert.match(source, /运行时 ·/u);
  assert.match(source, /data\.workerWakeReceipts\.map/u);
  assert.doesNotMatch(source, /每次唤醒均可进入独立回执/u);
});

test("长期审核读取失败时不暴露底层错误", () => {
  assert.match(source, /catch \{\s*data = null;/u);
  assert.match(source, /系统没有展示底层错误信息/u);
  assert.doesNotMatch(source, /catch \(error\)/u);
});

test("长期审核默认只聚合 active operator course，外层唤醒保持独立", () => {
  assert.match(source, /filterOperatorCourses/u);
  assert.match(source, /where:\s*\{ enabled: true \}/u);
  assert.match(source, /visibleCourseAliases/u);
  assert.equal(
    (source.match(/courseAlias:\s*\{ in: visibleCourseAliases \}/gu) ?? [])
      .length >= 4,
    true
  );
  assert.match(
    source,
    /invocation:\s*\{\s*is:\s*\{ courseAlias:\s*\{ in: visibleCourseAliases \} \}/u
  );
  assert.match(source, /停用课程历史仍保留在审计表中/u);

  const wakeQuery = source.match(
    /prisma\.autonomyWorkerWakeReceipt\.findMany\(\{([\s\S]*?)\n\s*\}\),\n\s*prisma\.reviewEvent/u
  );
  assert.ok(wakeQuery);
  assert.doesNotMatch(wakeQuery[1], /visibleCourseAliases/u);
});
