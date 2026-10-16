# 真实论坛数据交付契约 v1

## 用途边界

14 万条论坛记录可用于构建课程内学习轨迹、回复网络、主题变化、CIE/困惑信号、未回应窗口和离线干预回放。它提供的是观察性历史证据，不能单独证明智能学伴具有因果干预效果，也不能把稀疏发言解释为学生的稳定人格或心理状态。

第一轮不要直接交付全量原始库。建议先提供数据字典、manifest 和约 5,000 条分层脱敏事件；通过字段、时间、角色与隐私检查后再接全量。

## 首批交付物

建议放在项目外部目录，或放入已被 Git 忽略的 `data/incoming/`：

1. `manifest.json`：数据集版本、导出时间、文件名、SHA-256、行数、课程数、时间范围和脱敏说明。
2. `data_dictionary.xlsx` 或 `data_dictionary.csv`：字段含义、类型、枚举、缺失语义、时区及 ID 生成规则。
3. `forum_event_sample.csv` 或 `forum_event_sample.jsonl`：约 5,000 条 UTF-8 脱敏事件。
4. `course_membership_sample.csv`：课程内角色及有效时间范围；没有可靠角色表时也要明确说明。

样本应覆盖至少 3 门课程、300 名匿名学习者和 200 个线程，并尽量包含顶层回复、嵌套回复、同秒事件、编辑/删除、系统或学伴账号、孤儿父链及时间缺失记录。稀有类型应全部纳入，不只做简单随机抽样。

## `forum_event`：一行代表一个帖子或回复的一个版本

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `dataset_version` | 是 | 本次导出的稳定版本号 |
| `event_id` | 是 | 帖子/回复稳定 ID，不能由正文或行号生成 |
| `event_version_id` | 建议 | 某次创建、编辑或删除版本的唯一 ID |
| `operation` | 建议 | `create / edit / delete`；只有最终快照时填 `snapshot` |
| `platform` | 是 | 来源平台 |
| `course_id` | 是 | 脱敏但稳定的课程 ID |
| `thread_id` | 是 | 讨论线程稳定 ID |
| `post_id` | 是 | 所属主帖 ID；主帖可等于 `event_id` |
| `parent_event_id` | 回复建议 | 直接父帖子或父回复 ID |
| `event_type` | 是 | `post / reply` |
| `actor_id` | 是 | 跨事件稳定、不可逆脱敏的用户 ID |
| `target_actor_id` | 建议 | 被回复者的脱敏 ID |
| `course_role` | 是 | `learner / companion / teacher / helper / system / test / unknown` |
| `role_authority` | 建议 | `platform / roster / allowlist / assumed / unknown` |
| `source_kind` | 是 | `human / companion_generated / system / test / unknown` |
| `source_occurred_at` | 是 | 平台事件时间；无法解析时留空，不得用导出时间冒充 |
| `source_time_raw` | 是 | 平台原始时间字符串，用于复核解析 |
| `timestamp_precision` | 是 | `second / minute / date / relative / unknown` |
| `source_timezone` | 是 | 例如 `Asia/Shanghai` |
| `available_from` | 建议 | 该版本何时首次可被系统观察到，用于防止未来信息泄漏 |
| `edited_at` / `deleted_at` | 建议 | 编辑和删除时间 |
| `content_redacted` | 是 | 已脱敏正文；删除版本可为空 |
| `content_hmac` | 建议 | 原文的带密钥 HMAC，用于去重，不能使用可逆加密或裸 SHA |
| `language` | 建议 | 主要语言 |
| `ingested_at` | 是 | 本地导出或采集时间 |
| `ingestion_run_id` | 建议 | 采集批次 ID |

如果数据只有最终快照，必须在 manifest 中标记 `snapshot_only=true`。最终点赞数、回复总数、中心性和编辑后正文不能被当成早期时点已经可见的特征。

## `course_membership`：一行代表课程角色的一个有效区间

最低字段：

```text
course_id, actor_id, course_role, role_authority,
valid_from, valid_until, membership_version
```

角色必须绑定课程。同一用户在不同课程中可能是学习者、教师或助教，不能只提供一个全局角色。

## 内部来源映射

P1a 当前使用五类内部来源：

| 外部条件 | 内部 `sourceKind` | 是否进入学生画像 |
| --- | --- | --- |
| `course_role=learner` 且 `source_kind=human` | `learner` | 是 |
| `source_kind=companion_generated` | `companion` | 否 |
| `source_kind=system` 或扫描器账号 | `system` | 否 |
| `source_kind=test` | `test` | 否 |
| 角色、来源或时间证据不足 | `unknown` | 否 |

学伴回复可以作为学生后续回复的对话背景，但不得作为该学生的 CIE、能力、情绪或参与类型证据。

## 隐私要求

- 不提供姓名、学号、手机号、邮箱、账号、密码、cookie、token、身份证号和可识别头像 URL。
- `actor_id` 应由数据提供方使用项目专用密钥做 HMAC；不要把姓名 Base64 或直接 SHA 后当作匿名化。
- 正文中的姓名、联系方式、精确住址、外部账号和带令牌 URL 必须先脱敏。
- 原始未脱敏数据不要放入 Git、坚果云共享目录或模型提示词；应保存在独立受控目录。
- manifest 只记录不可逆统计和文件哈希，不记录密钥。

## 全量接入门槛

- `event_version_id` 唯一率 100%，稳定 ID 冲突为 0。
- `course_id / thread_id / actor_id / event_type` 完整率 100%。
- 来源时间可解析率建议不低于 99.5%；不可解析记录只可用于非时序描述。
- 父链解析率建议不低于 98%；孤儿节点必须保留明确原因，不能猜测父节点。
- 角色与来源未知必须显式写 `unknown`，不能默认写 `learner`。
- 已知学伴、系统和测试记录进入 learner-profile 视图的数量必须为 0。
- 增删截止时点之后的事件，不得改变此前画像哈希。
- 编辑和删除优先保留版本历史，不覆盖旧版本。
- 脱敏扫描加人工抽检不得发现直接身份标识或认证信息。

## 数据能支持和不能支持的研究任务

可支持：描述性参与模式、回复网络、时间序列、CIE/困惑分类校准、相似情境检索、24 小时回复和 7 日回访等预测信号，以及按时间/课程切分的离线回放。

不能直接支持：智能学伴干预的因果效果、稳定学生人格、心理诊断、完整世界模型有效性，或使用全课最终统计预测早期状态。
