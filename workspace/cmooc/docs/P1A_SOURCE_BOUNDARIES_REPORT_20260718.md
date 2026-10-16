# P1a 论坛证据来源与时间边界报告

日期：2026-07-18（Asia/Shanghai）

## 结论

P1a 已把画像同步从“读取当前帖子及全部回复”改为“读取指定课程/批次在截止时点可见的、来源可信的学习者发言”。本阶段没有把画像接入角色选择或回复生成，也没有运行真实论坛扫描、画像重算、自动干预或发布。

## 本阶段做了什么

- `ForumPost`、`ForumReply`、`ForumUserUtteranceAnalysis` 新增 `sourceKind`：`learner / companion / system / test / unknown`。
- 默认来源为 `unknown`；只有 `learner` 进入画像、风险、persona 和出入互动计数。
- 扫描器占位帖子写入 `system`，fixture/mock 写入 `test`，本地学伴回复写入 `companion`，真实详情采集在持久化边界统一推断来源。
- 学伴标记在回复 update/create 两条路径上同步更新，不再只在首次创建时判断。
- 重复采集采用单调来源合并：既有 companion/system/test 可信分类不会被较弱的文本或默认 learner 角色降级；只有扫描器尚未解析详情的 system 占位帖允许升级为真实来源。
- 浏览器兜底若拿不到平台评论 ID，本地键改用稳定 `post.id + index + author`，不再包含正文或截断 URL；普通评论默认 `unknown`，只有明确 companion/test/system 证据才分类。旧版正文相关键留下的弱 learner 记录在重采时会降为 `unknown`。
- 指定采集批次使用 `finishedAt` 作为 `asOfAt`；批次完成后新增的回复不会进入旧批次结果。
- 明确课程的空 ID 集合不会再退化为全库查询；空批次不会读取或覆盖其他课程画像。
- 课程范围同时约束主帖和回复；显式属于其他课程的脏回复即使挂在当前课程主帖下也会排除，`courseId=null` 的旧回复仍可继承主帖课程。
- 同时传入不匹配的 `runId` 与课程会直接报错。
- 显式 `runId` 默认 `preview`，不写逐条分析和用户画像；只有显式 `mode=materialize` 才会用历史批次更新物化画像。
- `materialize` 会删除当前课程内缺少 learner 证据的旧课程画像，并把对应成员记录标为 `excluded_no_learner_evidence`；若该用户在全库也没有 learner 或 unknown 证据，旧全局画像一并删除。

## 数据库迁移

新增 migration：

```text
20260718002000_add_forum_source_boundaries
```

迁移只增加三列、确定性回填来源并创建三个索引，不删除或重命名既有字段。

### P1a 冷备份

- 目录：`../backups/P1A_20260718_before_source_boundaries`
- Git 基线：`d216ccd`
- 迁移前数据库大小：6,074,368 bytes
- 迁移前 SHA-256：`5E1F10E2D2F58F5EFBCFD648966C64D6FA1442EE13FB0288AF87F1948D98F29C`
- 完整性：`ok`
- 外键违规：0
- 已应用 migration：2

### 副本演练

- 在冷备份副本上应用第三段 migration：成功。
- 20 张业务表全部旧字段的规范化数据哈希差异：0。
- `PRAGMA integrity_check`：`ok`。
- `PRAGMA foreign_key_check`：0 条违规。
- schema diff：0。

### 实际开发库

- 第三段 migration：成功。
- 20 张业务表全部旧字段的规范化数据哈希差异：0。
- 迁移后 SHA-256：`2F07407C673DAD3C422578E397CCDE508773E1BA594F7BA909DA368DC18557FC`
- 完整性：`ok`。
- 外键违规：0。
- 已应用 migration：3。
- schema diff：0。

来源回填分布：

| 表 | learner | companion | system | test | unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| ForumPost | 38 | 0 | 0 | 9 | 0 |
| ForumReply | 228 | 11 | 0 | 28 | 0 |
| ForumUserUtteranceAnalysis | 261 | 4 | 0 | 0 | 0 |

这些回填值依据既有作者角色、mock URL、学伴标记和 companionType 得出，不代表已经获得平台官方课程角色表。

## 测试覆盖

- 来源优先级：`companion > system > test > learner > unknown`。
- 只有 `learner` 可进入画像。
- 课程 A 的批次不会读取课程 B。
- companion 发言保留逐条分析，但不进入画像和互动计数。
- 迁移前残留的 companion 课程画像和无其他学习者证据的全局画像会被清理，成员关系保留但明确失效。
- `asOfAt + 1ms` 的未来回复不会进入旧批次。
- 挂在课程 A 主帖下但显式标为课程 B 的回复不会越界。
- 重复采集不会把既有 companion 回复或可信 system 帖降级为 learner。
- 无平台评论 ID 的正文编辑不会生成新的 learner 证据；旧弱 learner 记录会失效，编辑后的可信 companion 分类保持不变。
- 具有相同长 URL 前缀、同一作者和同一评论序号的不同帖子不会发生回复键碰撞或跨帖串写。
- 空批次结果为 0，且不会改动已有课程画像。
- 显式历史批次默认 preview，物化画像的更新时间保持不变。
- run/course 不一致直接拒绝。
- 空测试库可依次应用三段 migration，并连续装载 fixture。

## 14 万真实论坛数据如何使用

已新增 `docs/FORUM_DATA_CONTRACT_V1.md`。建议先交付：

1. manifest 与文件 SHA-256；
2. 数据字典、枚举和 ID 生成说明；
3. 约 5,000 条分层脱敏事件；
4. 课程内角色有效区间表。

首批样本通过字段完整性、父链、来源时间、角色、脱敏和未来后缀不变性检查后，再接全量约 14 万条记录。全量数据优先用于状态构建、规则校准、检索和离线回放，不直接用于宣称稳定学生人格或因果干预效果。

## 仍然保留的限制

- 当前 `createdAt` 主要作为本地首次可见时间的代理；尚未解析和保存所有平台原始时间字符串。严格事件时间回放需要真实数据中的 `source_occurred_at / source_time_raw / available_from`。
- 浏览器兜底拿不到稳定评论 ID 时会 fail closed 为 `unknown`，因此这些普通评论暂不进入画像；14 万数据若能提供稳定事件 ID，可恢复这部分可信覆盖率。
- 既有真实论坛用户大多由采集器假设为 learner；没有平台 roster 或账号 allowlist 时，仍可能存在漏标系统账号。未知来源以后应继续 fail closed。
- 全局 `ForumUserProfile` 仍有跨课程物化语义；动态决策后续应只读取版本化课程内快照。
- `ForumUserUtteranceAnalysis.sourceRunId` 仍是单值字段，不能表示同一发言被多个批次观察的完整历史。
- 尚未建立 Observation/Inference/Expression 快照，也未替换全局可变 mental state。

## 回滚

新增列为向后兼容的加法迁移，代码回滚时可以暂时保留，不应执行破坏性 down migration。若必须恢复数据库文件：停止所有 SQLite 访问，先另存当前库，再恢复 P1a 冷备份，并同时将代码切回 `d216ccd` 或重新应用第三段 migration 后使用新代码。
