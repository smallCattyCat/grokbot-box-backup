# AUTONOMY-V1 Semantic Draft and Reread S1 实现归档

- 归档日期：`2026-07-31`
- 归档类型：`PRODUCT IMPLEMENTATION CHECKPOINT`
- 证据等级：`CODE + LOCAL VERTICAL VALIDATION`
- 真实课程新链：`NOT YET VALIDATED`
- 外部效果：`OFF`
- 当前事实入口：[PRODUCT_CURRENT](../../PRODUCT_CURRENT.md)

## 1. 范围

本检查点完成以下一条纵向切片：

```text
event observation revision
→ cutoff-safe World / Graph replay
→ bounded transient semantic evidence
→ trusted server semantic attestation
→ DRAFT / WAIT / ABSTAIN / YIELD
→ Intent + MoveSpec
→ DRAFT-only deterministic renderer
→ second read-only observation
→ EXECUTE / YIELD / REVIEW shadow resolver
→ body-free decision and Decision Tape receipts
```

本轮没有接入编辑器、STAGE、真实发布、通知、Policy/Permit 消费或 outcome 建窗。
`realPublishEnabled=false` 保持不变。

## 2. 关键实现决定

### 2.1 事件身份与修订分离

`CourseEvent` 继续保存稳定事件身份。每次扫描在 `CourseEventObservation` 追加
source version、target version 和 `initial/duplicate/revision` 分类。身份漂移、同一
或倒退观察时点上的不同版本仍按 conflict 关闭。

投影不覆盖 canonical event，而是按 requested cutoff 读取当时最新 observation。
因此未来修订不会倒改旧 World、Graph 或 outcome event prefix。

### 2.2 正文只作瞬时输入

详情标题、正文与标签仅在观察进程内进入有界词法语义分析。持久回执只保存受控枚举、
计数、绑定哈希和时间；不保存正文片段、身份、平台 ID 或认证材料。

### 2.3 两类重读保持分权

- `lib/autonomy/draft-revalidation.ts`：第二次只读课程观察，只能授权 shadow
  continuation；
- `lib/live-runtime/revalidation.ts`：旧同标签页守卫链，为兼容 STAGE 使用。

自治 resolver 的 `EXECUTE` 固定为 `editorWriteAllowed=false`、
`publishAllowed=false`，不能升级为 STAGE 或发布许可。

### 2.4 目标理由与共同体目标分离

`targetReason` 回答“为什么这个目标进入候选”；`communityProcessGoal` 回答“希望促进
什么共同体过程”。两者单独持久化，避免把择机理由误作教育机制或效果。

## 3. 主要文件

| 范围 | 文件 |
| --- | --- |
| 瞬时语义 | `lib/autonomy/transient-semantic-evidence.ts` |
| 观察接入 | `lib/autonomy/platform-observer.ts` |
| 服务器证据 | `lib/autonomy/server-evidence.ts` |
| 四态资格 | `lib/live-runtime/facilitation-kernel.ts` |
| 同链重读 | `lib/autonomy/draft-revalidation.ts` |
| 主编排 | `lib/autonomy/tick.ts` |
| 事件修订 | `lib/world/live-event.ts` |
| cutoff 投影 | `lib/world/live-world-projector.ts`、`lib/world/course-content-graph-store.ts`、`lib/autonomy/outcome-observer.ts` |
| 数据库 | `prisma/schema.prisma`、`prisma/migrations/20260731040000_add_event_revision_semantics/migration.sql` |
| 测试 | `tests/unit/autonomy-tick.test.ts`、`tests/integration/autonomy-shadow-tick.test.ts`、`tests/integration/course-content-graph-persistence.test.ts` |

## 4. 已核验行为

- 重复观察、合法晚到修订和不可解释冲突得到不同分类；
- 旧 cutoff 重放旧版本，后续 cutoff 才看到新版本；
- 瞬时正文只形成去正文结构化语义回执；
- 第一次完整历史不足时形成 WAIT，第二次合格扫描自然形成 DRAFT；
- DRAFT 绑定 Intent、MoveSpec、renderer receipt 和正文哈希；
- DRAFT 后执行第二次只读观察，稳定目标产生 `EXECUTE` shadow receipt；
- 0 `ExecutionAttempt`、0 editor write、0 publish；
- 测试正文标记未进入 decision JSON 或 Decision Tape；
- 旧 same-tab guarded STAGE 测试继续通过，没有放宽其网络守卫要求。

## 5. 验证记录

本轮最终验证结果：

```text
npm run type-check
npx prisma validate
npx tsx --test --test-concurrency=1 \
  tests/unit/autonomy-tick.test.ts \
  tests/unit/live-facilitation-runtime.test.ts \
  tests/unit/semantic-renderer.test.ts
  → 42/42 passed

tests/integration/autonomy-shadow-tick.test.ts
  → 2/2 passed

tests/integration/course-content-graph-persistence.test.ts
  → 4/4 passed

npm run verify
  → agent guidance、operator invariants、type-check、lint 全部通过
  → 206/206 TypeScript unit passed
  → 27/27 TypeScript database integration passed
  → 1/1 migration integration passed
  → 130/130 research tests passed

npm run build
  → Next.js production build passed，29/29 static pages generated

npx prisma migrate deploy
  → 13 个 migration 完整识别
  → 20260731040000_add_event_revision_semantics 已应用到本地 dev.db
```

`db:test:reset` 现在执行 `prisma validate` 后重建隔离测试库，不再在开发服务器运行时
强制替换被 Windows 占用的 Prisma DLL。正式 `prisma:migrate` 仍保留 client generate；
若开发服务器占用引擎，应在停止该进程后再单独 generate。该环境约束不影响本轮
migration、类型、测试或构建结果。

上述结果不得表述为真实课程或真实外部运行证据。

## 6. 未升级的证据

- 更新前真实课程数据库仍为 0 DRAFT、0 SemanticRealization；
- 本地 `SemanticDraftObserver` 只证明生产形状代码链，不证明真实课程当前有合格目标；
- 38 个评论范围仍删失；93/156/71 口径不变；
- learner 网络仍为 `lower_bound`，PageRank/k-core 不计算；
- Graph、DRAFT 和重读回执都不是教育效果；
- P3/P4 冻结回执、fixture、统计和结论没有修改。

## 7. 下一检查点

下一任务是 `AUTONOMY-V1-REAL-SEMANTIC-SHADOW-VALIDATION`。它只运行真实课程读取和
本地持久验证，不写编辑器、不发布、不通知。若真实课程没有自然合格 DRAFT，应以
WAIT/ABSTAIN/YIELD 和理由完成验收，而不是制造 DRAFT。
