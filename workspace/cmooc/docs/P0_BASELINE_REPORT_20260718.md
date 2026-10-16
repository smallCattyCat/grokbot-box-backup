# P0 可回滚重构基线报告

日期：2026-07-18（Asia/Shanghai）

## 结论

P0 已建立可回滚、可迁移、可重复验证的工程基线。开发数据库的 20 张业务表在迁移前后行数与规范化数据哈希完全一致；当前数据库通过 SQLite 完整性检查和外键检查。此阶段没有运行论坛扫描、分析、自动干预或任何真实/模拟发布流程。

## Git 基线

- Git 根目录：`源码`
- 默认分支：`main`
- 重构前冻结提交：`afcecce`（`chore: freeze pre-refactor baseline`）
- 数据库、环境文件、登录态、截图、Next.js 构建物和测试数据库均保持忽略，不进入版本库。

## 冷备份

- 目录：`../backups/P0_20260718_before_refactor`
- 原始数据库：`dev.db`
- 大小：4,923,392 bytes
- SHA-256：`ED411B4B7007447D38B7D1068A3DAD303BFB6C704021DB99240338A53F361AD5`
- 外键违规：0
- 业务表：20 张
- 业务数据规范化聚合 SHA-256：`97AA3CD3EE51328306117E3D57C68665A1A0C3BAFFE31AC1C57777B000CC60DD`

备份还包含当时的 `schema.prisma`、`create-db.ts`、`seed.ts`、`package.json`、`package-lock.json` 和逐文件哈希清单。备份数据库保持原样，未在原件上执行修复或迁移。

### 冻结时表计数

| 表 | 行数 | 表 | 行数 |
| --- | ---: | --- | ---: |
| AgentRun | 416 | AutoInterventionCandidate | 84 |
| AutoInterventionRun | 26 | CommunityMetric | 7 |
| CompanionProfile | 4 | Course | 1 |
| CourseMembership | 53 | ForumIngestionRun | 8 |
| ForumPost | 47 | ForumPostSnapshot | 212 |
| ForumReply | 267 | ForumSetting | 1 |
| ForumUser | 90 | ForumUserCourseProfile | 53 |
| ForumUserProfile | 53 | ForumUserSnapshot | 153 |
| ForumUserUtteranceAnalysis | 265 | InteractionAnalysis | 23 |
| InterventionTask | 26 | PublishLog | 21 |

### 原库已知完整性问题

冻结时的快速检查首先发现 `ForumPostSnapshot_columnId_idx` 缺少第 1 行索引项；后续对同一只读备份执行完整 `PRAGMA integrity_check` 时同时报告第 1、2 行索引项缺失。备份文件哈希未变化，外键检查为 0，这属于索引损坏而非业务行丢失。

工作库先执行该单一索引的 `REINDEX`，再进入迁移；当前 `PRAGMA integrity_check` 返回 `ok`。

## 正式迁移基线

新增两段 Prisma migration：

1. `20260718000000_legacy_baseline`：准确描述冻结开发库的既有结构。
2. `20260718001000_align_prisma_schema`：把既有结构对齐到当前 `schema.prisma`，补齐后期 `courseId` 等字段缺失的声明式外键和索引。

迁移按三个层级演练：

| 场景 | 方法 | 结果 |
| --- | --- | --- |
| 全新空库 | 顺序执行两段 migration | 成功，schema diff 为 0 |
| 冻结库副本 | 标记 legacy baseline 后执行 align migration | 成功，20 张业务表数据哈希一致 |
| 实际 `dev.db` | 应用经副本验证的相同步骤 | 成功，业务数据无差异 |

迁移后的工作库：

- 大小：6,074,368 bytes
- 文件 SHA-256：`5E1F10E2D2F58F5EFBCFD648966C64D6FA1442EE13FB0288AF87F1948D98F29C`
- 业务数据规范化聚合 SHA-256：`97AA3CD3EE51328306117E3D57C68665A1A0C3BAFFE31AC1C57777B000CC60DD`
- 与冻结备份不一致的业务表：0
- `PRAGMA integrity_check`：`ok`
- `PRAGMA foreign_key_check`：0 条违规
- 已完成 migration：2 条

迁移后文件哈希和大小发生变化是预期结果，来源包括索引修复、表结构重建和 `_prisma_migrations` 元数据；业务数据聚合哈希保持不变。

## 防误操作与测试隔离

- `npm run prisma:migrate` 现在使用版本化的 `prisma migrate deploy`；旧的建库脚本仅保留为 `prisma:legacy-bootstrap`，不再是默认路径。
- fixture seed 只允许写入精确的 `file:./test.db`。
- fixture seed 还会比较 `test.db` 与 `dev.db` 的规范路径及文件标识，拒绝符号链接或硬链接指向同一数据库。
- demo seed 只允许写入精确的 `file:./dev.db`，并要求口令 `CMOOC_ALLOW_DEMO_RESET=RESET_CMOOC_DEMO_DATABASE`。
- seed 的清库和重建在单个 Prisma transaction 中执行。
- 测试重置脚本只删除固定路径 `prisma/test.db` 及其 journal/WAL/SHM 文件。
- 测试环境缺省数据库为 `test.db`，开发和生产缺省数据库为 `dev.db`。
- `verify` 的 npm 调用兼容 Windows，且已纳入单元测试和数据库集成测试。

## 可重复验证结果

以下检查均在 P0 工作树上通过：

- `npm run verify`
  - operator contract invariants：通过
  - TypeScript：通过
  - ESLint：0 warning / 0 error
  - Node 单元测试：5/5 通过（含 `.env` 不得覆盖测试库隔离的子进程回归测试）
  - 数据库集成测试：1/1 通过
- 集成测试从空 `test.db` 应用两段正式 migration，连续执行两次 fixture seed，并检查固定计数、完整性、外键和迁移记录。
- `npx prisma validate`：通过
- `npx prisma migrate status`：up to date
- `npx prisma migrate diff ... --exit-code`：no difference
- `npm run build`：生产构建成功，23 个静态页面生成完成
- `npm run check:multi-agent`：核心流水线 ready、自动干预 ready、真实发布关闭、默认 dry run

第一次与 `verify` 并行启动生产构建时，坚果云目录中的 Next.js 依赖文件短暂返回 Windows `EBUSY`；停止并行读取后单独重试即完整通过。构建末尾仅有 webpack 缓存快照警告，不影响产物生成。

## 保留到后续阶段的问题

- 尚无 `auto-reply-agent` 的历史运行证据。
- 多学伴真实运行尚未配置至少两个合规账号，协作 planner/safety/publish 的真实 AgentRun 证据尚未形成。
- `scripts/create-db.ts` 暂作历史恢复参考；P1/P2 稳定后可决定删除，而不是在 P0 直接移除。
- 本阶段只建立工程安全底座，没有改变角色人格模型、论坛数据驱动画像、世界模型或干预策略。

## 从冻结备份恢复

恢复属于破坏性操作，必须先停止应用并再次备份当前 `prisma/dev.db`。冻结库属于 legacy schema，复制回工作路径后应先修复已知索引，再将 legacy baseline 标记为已应用，最后执行正式迁移：

1. 停止所有访问 SQLite 的 Next.js、Prisma 和脚本进程。
2. 把当前工作库复制到新的时间戳备份目录。
3. 将冻结的 `dev.db` 复制到 `prisma/dev.db`。
4. 对 `ForumPostSnapshot_columnId_idx` 执行 `REINDEX` 并确认 `PRAGMA integrity_check` 为 `ok`。
5. 执行 `npx prisma migrate resolve --applied 20260718000000_legacy_baseline`。
6. 执行 `npm run prisma:migrate`。
7. 复查表计数、`PRAGMA foreign_key_check` 和关键页面。

不要对非空 legacy 库直接执行第一段建表 migration，也不要在未另存当前工作库时覆盖 `dev.db`。
