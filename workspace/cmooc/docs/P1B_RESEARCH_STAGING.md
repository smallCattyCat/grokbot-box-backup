# P1b 历史论坛研究分层

> 历史说明：本文记录 P1b 的安全设计基线。当前可执行实现已升级到 P1c，运行路径与角色语义以 [P1c 角色来源与动态促进功能分层报告](P1C_ROLE_FUNCTION_REPORT_20260718.md) 为准。

## 本阶段的边界

P1b 把 2024—2025 年论坛导出转换为独立、可审计的研究事件层，但不接入 Prisma、Next API、画像同步、角色选择或自动干预。研究库与 `prisma/dev.db`、`prisma/test.db` 物理隔离，默认只允许写到 `%LOCALAPPDATA%\cmooc-research\p1b`。项目位于坚果云同步目录，因此 Git ignore 不能替代这条路径门禁。

当前原始文件应称为“去标识化/假名化数据”，不能称为完全匿名数据。成员表仍含真实姓名、网名、单位、职务与自我介绍等字段。为完成公式、超长单元格和表头安全检查，Excel 解析器会遍历工作表单元格；业务转换只选择 `course_id / member_type / user_id`，其他成员字段不会被返回给转换逻辑、输出或持久化。

## 为什么暂不复制正文

帖子与评论正文可能包含姓名、联系方式、外部账号或带令牌链接。P1b 会在内存中计算带密钥、域分离的内容 HMAC，并只输出敏感模式的聚合计数；SQLite 中 `content_redacted` 强制为 `NULL`。在完成伦理范围确认、网名替换表隔离和本地脱敏抽检之前，不新增一份正文副本。

这并不妨碍先完成以下工作：

- 课程内成员角色与事件作者对齐；
- 主帖、顶层回复和嵌套回复的图结构恢复；
- 秒级事件时间解析与稳定排序；
- 孤儿帖子引用、断裂父链、缺失用户和疑似 Excel 截断隔离；
- 后续按课程/时间切分的离线回放准备。

## 固定输入与事实/标签隔离

`research/source-schema-v1.json` 只允许读取下列 8 个文件，不递归扫描研究目录：

- 2024/2025 课程；
- 2024/2025 课程成员；
- 2024/2025 图文；
- 2024/2025 图文评论。

第 1 行是字段名，第 2 行是字段说明，第 3 行起才是业务数据。成员表的重复 `user_real_name`、`user_identity` 表头会被精确校验，但这些列不会被业务转换选取、输出或持久化。最终点赞数、联结度、联结度排名、积分和等级不进入历史事件层。

既有 `thread_overview / thread_dynamics / trigger_snapshots` 只可登记到 `weak_label_run / weak_label`。这些是多模型弱标签，触发快照还存在未来条件化风险；它们不得写入 `forum_event`，数据库约束也禁止弱标签成为画像证据。

## 两步运行

先安装本地依赖：

```powershell
python -m pip install -r requirements-research.txt
```

### 1. 只读审计并生成不可覆盖的 manifest

```powershell
$root = "$env:LOCALAPPDATA\cmooc-research\p1b"
New-Item -ItemType Directory -Force -Path $root | Out-Null

npm run research:audit -- `
  --input-root "C:\path\to\cmooc研究数据24-25" `
  --dataset-version "cmooc-2024-2025-raw-v1" `
  --manifest-out "$root\manifest-cmooc-2024-2025-raw-v1.json"
```

审计会检查固定文件、路径包含关系、XLSX 容器、压缩比、公式/宏/外链、精确表头、源文件前后 SHA-256、行数、ID、父链和时间。manifest 使用独占创建；目标已存在时拒绝覆盖。stdout 只输出聚合 JSON，不输出原始 ID、正文或单元格上下文。

### 2. 显式创建新的 research.db

先在当前终端注入至少 32 字节的随机密钥。密钥必须保存在坚果云项目和源数据目录之外，不能写入 `.env`、命令行、manifest 或 Git。示例只生成本次终端变量；正式复现前需自行建立受控的持久密钥保管方式。

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$env:CMOOC_RESEARCH_HMAC_KEY_B64 = [Convert]::ToBase64String($bytes)
$env:CMOOC_RESEARCH_HMAC_KEY_ID = "p1b-v1"

npm run research:stage -- `
  --input-root "C:\path\to\cmooc研究数据24-25" `
  --manifest "$root\manifest-cmooc-2024-2025-raw-v1.json" `
  --db "$root\cmooc-2024-2025-v1.research.db" `
  --timezone "Asia/Shanghai" `
  --source-profile "unclassified" `
  --apply
```

`stage` 需要 manifest、有效 IANA 时区、HMAC 密钥与 `--apply` 同时满足。它拒绝覆盖现有文件，拒绝项目/源数据/UNC 路径，拒绝 `dev.db` 与 `test.db`，并在同目录临时文件完成事务和完整性检查后原子改名。

目前没有历史学伴、系统和测试账号的可信清单，因此默认 `source_kind=unknown`，`learner_profile_evidence` 视图必为空。只有数据负责人确认历史导出中账号来源的适用范围后，才能讨论 `historical-human-forum-export-v1`；即使选择该 profile，dataset 级画像开关在 P1b 仍被约束为关闭。

## 时间与回复链语义

- 原始时间按显式 `source_timezone` 转成 UTC，同时保留原时间字符串；不允许用导出时间替代事件时间。
- 当前数据只有最终快照，`operation=snapshot`，`available_from_utc=NULL`。
- 顶层评论的父节点是主帖。
- 嵌套回复优先使用 `comment_reply_child_id`；该字段为 `-1/0/空` 时回退到 `comment_reply_id`。
- 缺主帖或缺父回复时不猜测、不虚构 thread，只在 quarantine 保存域分离 HMAC 引用和原因码。
- 历史顺序固定为 `(source_occurred_at_utc, event_id)`。

## 后续进入角色模拟前仍需通过的门槛

1. 确认平台时间确为 `Asia/Shanghai`，或给出正确时区。
2. 提供课程内历史学伴/系统/测试账号 allowlist，避免把模拟账号当学生。
3. 确认研究伦理和数据授权是否允许本地处理论坛正文。
4. 建立项目外的密钥保管与网名替换映射；完成脱敏自动扫描和人工抽检。
5. 用按课程、按时间的 holdout 验证画像/角色表达，弱标签只作旁路校准。
6. 最后才增加 research staging 到应用 Observation/Inference/Expression 快照的单向 materializer；不得直接把研究库接到发布链路。
