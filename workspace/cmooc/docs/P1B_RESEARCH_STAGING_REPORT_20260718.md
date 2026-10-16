# P1b 历史论坛研究分层实施报告

> 历史说明：本文保留 P1b 完成时的状态。真实 P1c 数据库现已建立，最新结果见 [P1c 角色来源与动态促进功能分层报告](P1C_ROLE_FUNCTION_REPORT_20260718.md)。

日期：2026-07-18（Asia/Shanghai）

## 结论

P1b 已建立独立于 Prisma/Next 的本地研究数据入口，并对 2024—2025 年 8 个原始 Excel 完成全量只读审计。当前没有创建真实 `research.db`，也没有把历史数据写入 `prisma/dev.db`；平台时区和历史学伴/系统/测试账号清单未确认前，画像投影在导入逻辑和 SQLite 约束中均保持关闭。

研究库输出被限制到 `%LOCALAPPDATA%\cmooc-research\p1b`。正文只在内存中参与候选敏感模式扫描和域分离 HMAC 计算，P1b schema 强制 `content_redacted=NULL`。成员姓名、网名、单位、职务、自我介绍及最终联结度、点赞、积分等字段不进入 staging。

## 真实数据审计结果

| 项目 | 结果 |
| --- | ---: |
| 课程 | 6 |
| 成员源记录 | 3,170 |
| 可用成员记录 | 3,169 |
| 主帖 | 12,627 |
| 评论/回复 | 112,296 |
| 论坛事件合计 | 124,923 |
| 可形成规范事件图 | 124,320 |
| 重复事件 ID | 0 |
| 可解析事件时间 | 124,923（100%） |
| 空主帖正文 | 79 |
| 疑似 Excel 32,767 字符截断 | 9 |

课程角色按平台成员表映射后的可用记录为：`learner=3,143`、`helper=20`、`teacher=6`。角色只在课程内有效；`source_kind` 是另一维度，当前因缺少历史账号清单而统一 fail closed 为 `unknown`。

事件时间范围为 `2024-10-18 21:49:17` 至 `2026-03-14 21:02:34`。这些值尚未绑定可信时区，因此只能作为本地原时间范围，不能在用户确认前转换成正式 UTC 回放时间。

### 隔离结果

| 原因 | 数量 | 处理 |
| --- | ---: | --- |
| `ORPHAN_POST` | 592 | 缺少所属主帖，不虚构 thread |
| `BROKEN_PARENT` | 10 | 直接父回复不存在，不猜测父节点 |
| `PARENT_NOT_CANONICAL` | 1 | 父记录存在但自身不可进入规范图，阻断级联污染 |
| `MISSING_ACTOR_ID` | 1 | 成员 ID 缺失，不生成 `HMAC("0")` 用户 |
| `POSSIBLE_EXCEL_TRUNCATION` | 9 | 事件元数据可保留，正文进入后续人工抽检清单 |

9 条疑似截断不计入结构性排除；规范事件图中的 603 条评论排除来自 592 个孤儿、10 个缺父节点和 1 个非规范父节点级联。

正文只做聚合候选扫描：联系账号模式 46 条、手机号模式 7 条、带查询参数 URL 542 条；邮箱、身份证号和凭证/token 模式均因计数低于 5 而作 k 抑制。它们是正则候选，不等同于已确认个人信息，但足以说明本阶段不应直接复制正文。

## 可复现产物

- 本机 manifest：`%LOCALAPPDATA%\cmooc-research\p1b\manifest-cmooc-2024-2025-raw-20260718-v1.json`
- manifest SHA-256：`33D0C9382FB9DC267FFC83ED569318BB4DA56974741B492D1E74E7429C442CDB`
- dataset fingerprint：`f7cc79ace26773b8bb790b3ac6695e1208b3ca90498cef7c8796c6b19f1cdeb4`
- manifest 大小：5,636 bytes
- source schema：`p1b-research-staging-v1`
- 工具链：Python 3.13.2、openpyxl 3.1.5、tzdata 2025.1、SQLite 3.45.3；manifest 同时绑定 importer、source schema、migration、et_xmlfile 和完整 tooling fingerprint。

manifest 使用独占创建，不允许覆盖；8 个源文件在审计前后 SHA-256 一致。manifest 不含绝对路径、Windows 用户名、原始 ID、正文、密钥或网名。

## 对业务库与外部服务的影响

- 审计前 `prisma/dev.db` SHA-256：`2F07407C673DAD3C422578E397CCDE508773E1BA594F7BA909DA368DC18557FC`
- 审计后 `prisma/dev.db` SHA-256：`2F07407C673DAD3C422578E397CCDE508773E1BA594F7BA909DA368DC18557FC`
- 真实 research.db：未创建。
- 外部 API/LLM 调用：0。
- 原始 Excel：只读，未复制、移动或改写。

## 已落地的安全门槛

- 只允许 8 个固定相对路径，不递归扫描研究目录中的盐、日志、代码、RAR 或模型产物。
- XLSX 拒绝公式、宏、外链、嵌入对象、路径穿越和异常压缩；精确校验重复表头。
- `stage` 必须同时提供不可变 manifest、有效 IANA 时区、至少 32 字节的 base64 HMAC 密钥、非秘密 key ID 和 `--apply`。
- HMAC 对 course、actor、post、thread、reply、content、quarantine 分域；actor 默认课程内稳定。
- 输出只能位于 canonical LocalAppData 子目录；拒绝 UNC、项目目录、源数据目录、`dev.db` 和 `test.db`。
- SQLite 使用同盘硬链接原子发布；并发导入只能有一个成功，绝不覆盖既有文件。
- 课程角色、来源类型和各自 authority 分列；最终快照的 `available_from` 保持 NULL。
- 弱标签有独立表，`eligible_for_profile` 被约束为 0，不能混入事实事件和画像证据。

## 进入下一阶段前需要确认

1. 平台时间是否确为 `Asia/Shanghai`。
2. 历史学伴、系统、教师代发和测试账号的课程内 allowlist。
3. 伦理审批/数据授权是否允许在项目外本地处理论坛正文。
4. 可复现 HMAC 密钥的项目外保管方式；不能把密钥或映射放回坚果云目录。
5. 正文脱敏的网名替换、自动 DLP 与人工抽检方案。

这些条件完成后，才能创建正式 research.db；随后仍应先做离线 Observation/Inference/Expression 快照和按课程/时间的回放验证，不直接接入自动发布链路。
