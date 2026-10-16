# P4A 可执行促进协议 v1

## 已实现边界

P4A 把“证据—是否介入—促进功能—目标—动作—审阅—执行证据”定义为十类
版本化 JSON Schema 2020-12 对象。TypeScript 类型由同一组 schema 推导，运行时
使用严格校验：未知字段、非法枚举、正文标志和错误哈希格式均 fail closed。

| 协议对象 | v1 证据职责 |
|---|---|
| `ObservationEnvelopeV1` | 固定 adapter、观察时钟、来源观测终点和状态哈希 |
| `DecisionEvidenceRefV1` | 只引用 P3A 匿名稳定键、决策时点、特征哈希和时间契约 |
| `InterventionIntentV1` | 固定是否介入、主要促进功能、目标、成本、TTL 和撤回条件 |
| `FacilitationMoveSpecV1` | 固定事前需要、机制、促进动作、内容要求、禁止动作和成功判据 |
| `BoundTargetV1` | 固定 adapter 目标引用和目标版本哈希 |
| `ReviewBundleV1` | 固定人工看到的任务、证据、意图、草稿、目标和安全结果版本 |
| `CapabilityRequestV1` | 描述 principal 请求的结构化能力；它本身不授予能力 |
| `ExecutionCommandV1` | 描述未来能力网关可签发的短时、幂等执行命令 |
| `ExecutionReceiptV1` | 区分已核验发布、确认未尝试、确认未发布和结果不明 |
| `InterventionEventV1` | 固定双时间戳、关联/因果链和证据状态 |

源码入口为 `lib/facilitation-protocol/index.ts`。目前没有 ForumAdapter、能力网关或
真实执行器；`forum.execute_authorized` 只是后续网关契约中的受控标识，不构成授权
或可调用写能力。operator 和智能体的真实论坛写权限仍为零，
`realPublishEnabled=false` 保持不变。

## 规范哈希

协议哈希使用 `cmooc-canonical-json-sha256-v1`：

1. 对象键按字典序递归排序；
2. 只接受 JSON 的 `null`、布尔值、字符串、安全整数、数组和普通对象；
3. 拒绝浮点数、`-0`、`undefined`、稀疏数组和非普通对象；
4. 以哈希算法标识和 `schemaVersion` 作域分离后计算 SHA-256。

哈希用于不可变证据引用，不替代权限判断。数组顺序保留语义；对象键顺序不影响
哈希。

## 教育语义不变量

`FacilitationMoveSpecV1` 不能从自由标签任意生成。v1 固定以下映射：

| 促进功能 | 事前需要 | 机制目标 | 促进动作 |
|---|---|---|---|
| `resource_connection` | `connection_gap` | `reduce_connection_cost` | `connect_resource_and_invite_application` |
| `cognitive_conflict` | `conceptual_tension` | `surface_explanatory_tension` | `pose_counterexample_and_request_explanation` |
| `emotional_support` | `participation_barrier` | `lower_reentry_cost` | `acknowledge_contribution_and_invite_return` |

动作必须保持意图哈希和目标对象，并至少禁止替学习者作答和身份等级化。促进功能
是事件级功能；协议不包含教师/促进者等级、人格标签、诊断性心理状态或预先宣称的
学习效果。

证据时钟和实施语义另有跨字段校验：

- `as_of_verified` 要求来源观测终点覆盖 `evidenceAsOf`；
- 候选和命令 TTL 必须为正；
- 回执时间不得倒流；
- `verified_published` 必须有尝试时间和远端对象引用哈希；
- `confirmed_not_attempted` 不得伪装为已尝试；
- `outcome_unknown` 不能降格为“未尝试”。

## P3A 只读桥接

桥接读取以下既有正式产物，不写回任何文件：

```text
%LOCALAPPDATA%\cmooc-research\p3a\decision-snapshot-v1\
  manifest.json
  decision_snapshots.csv
  audit-v2\temporal-contract.json
```

进入 `DecisionEvidenceRefV1` 的字段只有：

```text
snapshot_key, thread_key, course_key, author_key, year, decision_at,
feature_hash, snapshot schema/version, temporal contract hash/time basis
```

桥接同时要求：

- 固定真实时钟为主帖后 22 小时决策、主帖后 86 小时观察终止；
- 2024 为开发集、2025 为时间留出；
- 每行 `asof_boundary_ok=1`；
- 三项上游时间审计均为 `passed`；
- manifest 与机器时间契约的内容哈希一致；
- 正式产物不含论坛正文和原始平台 ID；
- 后续真人互动结果只作 P3A 非因果观察，不进入证据引用。

因此，修改 `decision_at` 之后的结果后缀不会改变既有
`DecisionEvidenceRefV1` 或其哈希。审计输出只有行数、拆分计数和集合哈希，不输出
行级键、时间或结果。

## 验收命令

```powershell
npm run test:p4-protocol
npm run p4:protocol:audit -- --json
npm run type-check
npm run lint
npm run verify
```

`p4:protocol:audit` 是只读命令，不调用本地或在线模型，不使用网络，不读取论坛正文，
不修改 `01_原始数据`，也不触发论坛发布。

## 后续依赖

P4B-1 已在这组冻结协议之上实现首个 ForumAdapter 只读切片，见
[P4B-1 ForumAdapter 只读内核](P4_ADAPTER_V1.md)。P4C 才实现能力网关。P4A/P4B-1
均不新增智能体、角色、审批层或数据库表，也不改造既有发布状态机。
