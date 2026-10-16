# 文档地图与权威层级

- 更新日期：`2026-08-30`
- 状态：`CURRENT / DOCUMENTATION AUTHORITY`

本目录同时保存当前产品契约、目标架构、兼容运行面、前瞻研究方向和冻结研究证据。它们回答的
问题不同，不能互相替代。阅读或修改时按下面的层级判断事实。

## 1. 当前产品事实

| 文档 | 作用 | 冲突时的优先级 |
| --- | --- | --- |
| [产品当前状态](PRODUCT_CURRENT.md) | 当前工作树真实可达链、证据级别、缺口与唯一下一切片 | 产品事实最高 |
| [自主产品总计划](AUTONOMOUS_PRODUCT_MASTER_PLAN.md) | 目标架构、V0—V10 依赖和成熟验收条件 | 规范目标，不冒充现状 |
| [旗舰产品研究整合纲领 R1](FLAGSHIP_PRODUCT_RESEARCH_INTEGRATION_R1_2026-08-30.md) | 将近期 cMOOC 研究与最新 LLM/harness 编译为统一产品对象、体验主线和下一纵向切片 | 设计已收敛，尚未实现 |
| [在线学习社区接入包](PLATFORM_CONNECTOR_KIT.md) | 单客户白标、通用 manifest/observer 接缝、目标社区六步迁移与验收清单 | 接入实施权威；目标平台实际支持仍以联调证据为准 |
| [Codex 连续型课程运营工作台蓝图](CODEX_CONTIGUOUS_OPERATOR_WORKSPACE_BLUEPRINT.md) | 统一课程现场、Codex 任务、多角色/多账号溯源与持久任务历史的产品及开发方案 | 目标体验与实施切片，不冒充当前已实现能力 |
| [产品机理与当前完成状态](PRODUCT_MECHANISM_AND_CURRENT_STATUS.md) | 用产品语言解释机制、当前能力与尚未合流的模块 | 以当前状态为准 |
| [Course Content Graph v2](COURSE_CONTENT_GRAPH_V2.md) | Graph 数据契约、93/156/71 口径和 lower-bound 边界 | Graph 专项事实 |
| [代理决策规则](AGENT_DECISION_POLICY.md) | 开发推进与外部边界 | 不产生产品完成声明 |
| [S1 实现归档](archive/2026-07-31_AUTONOMY_V1_SEMANTIC_DRAFT_AND_REREAD_S1/IMPLEMENTATION_ARCHIVE.md) | 本轮修改、迁移、验证命令和证据等级 | 历史检查点；当前事实仍以 PRODUCT_CURRENT 为准 |
| [L3 单动作生产执行归档](archive/2026-07-31_AUTONOMY_L3_ONE_SHOT_PRODUCTION/IMPLEMENTATION_ARCHIVE.md) | STAGE、Permit、Committer、核对、建窗和重锁的去正文证据 | 一次真实外部路径检查点；不是教育效果 |

项目入口和日常命令见上级 [README](../README.md)。根目录
`PROJECT_RULES.md` 始终负责外部副作用、敏感数据与持续推进边界。

## 2. 当前运行契约与兼容面

| 文档 | 当前定位 |
| --- | --- |
| [自主促进运行内核 v1](LIVE_FACILITATION_RUNTIME_V1.md) | 自治数据库主链与旧 `/api/platform/*` 兼容链的边界说明 |
| [Computer Use live shadow](COMPUTER_USE_LIVE_SHADOW.md) | 已验证的真实页面诊断/传输切片；不是当前 `autonomy:tick` 的内嵌 companion |
| [LIFT-1 真实界面演示](LIFT1_REAL_UI_DEMO.md) | `/platform` 只读入口预检与历史实测 |
| [Operator 接口](operator-api.md) | 旧预演控制面的兼容 API；不代表自治主链 |
| [真实论坛接入](real-forum-integration.md) | 旧 MANUAL 与 L3 单动作生产链；当前已重锁 |
| [本地部署](../DEPLOY.md) | 本机/容器诊断部署；不是已具备真实自治发布能力的生产部署 |
| [自博弈迭代规程](self-play-governance.md) | 当前开发优先级与验证纪律 |

兼容面仍是可复用代码和回归资产，不应删除或降级实现；但它们不能覆盖
`PRODUCT_CURRENT.md` 对当前自治主链的判断。

## 3. 当前前瞻研究方向

[课程共同体促进研究纲领 R1](COMMUNITY_FACILITATION_RESEARCH_DIRECTION_R1_2026-08-30.md)
负责后继研究的问题选择、贡献层级和解释方向。它把“具有关系后果的参与机会”作为
主对象，区分 Graph 的描述、机制、设计和预测作用，并将教师与学习者的判断、课程生态
差异和近端人类互动重新置于技术工作包之前。运行资格限制对应产品动作，不成为研究发现
和机制探索的前置 Gate。

该纲领不修改任何冻结结果。未来研究方向与已经形成的证据含义发生冲突时，研究问题按
纲领组织，事实与结论仍按下节的冻结证据解释。

## 4. 冻结研究证据

[当前研究工作流](CURRENT_RESEARCH_WORKFLOW.md) 是冻结证据、方法边界和复现入口的
总索引。`P0_*`—`P4_*`、`DECISION_*`、`SCHEDULER_REPLAY_V2.md`、代码本和阶段报告
记录各自形成时的研究状态。它们继续约束研究结论的含义，但历史 Gate、candidate、
receipt 或一次性授权不会自动成为当前开发审批，也不会证明后来自治模块已接入
真实生产链。

以下内容不得被后来的产品文档倒写：

- P3A 的时点、TTL、预算和删失口径；
- P4A—P4C-1、P4D-1、P4F-lite 的冻结协议、fixture、回执与适用范围；
- 合成 adapter 的规则级结果不得写成真实平台干预；
- 历史观察性数据、Graph 指标和离线回放不得写成教育因果效果。

## 5. 证据状态词

当前文档统一使用以下状态：

| 状态 | 含义 |
| --- | --- |
| `真实只读路径已验证` | 当前代码对真实课程执行读取/投影并留下去正文证据 |
| `真实单动作路径已验证` | 一次明确授权动作完成 STAGE、发送、核对和重锁；不外推持续 AUTO |
| `本地验证` | 模块、契约、数据库或模拟驱动通过本地测试，但未接入真实主链 |
| `部分实现` | 已有重要模块，仍缺关键输入、调用或闭环 |
| `接口/合成验证` | 只有 API、schema、fixture、模拟 transport 或手工入口 |
| `未实现` | 所需生产能力不存在 |
| `有意未激活` | 代码或设计存在，但外部副作用因硬锁/授权边界保持关闭 |

“有代码”“测试通过”“真实只读 shadow”“真实外部运行”和“教育效果证据”必须分别
报告。当前 `realPublishEnabled=false`；Graph 的 38 个评论范围仍是删失，learner
网络只能报告 `lower_bound`，PageRank 和 k-core 不得补算。

## 6. 发生冲突时

1. 外部副作用和敏感数据以根目录 `PROJECT_RULES.md` 为准；
2. 当前实现事实以 `PRODUCT_CURRENT.md`、代码、迁移、测试和去正文运行回执为准；
3. 目标能力以 `AUTONOMOUS_PRODUCT_MASTER_PLAN.md` 为准；
4. 前瞻研究问题与贡献层级以
   `COMMUNITY_FACILITATION_RESEARCH_DIRECTION_R1_2026-08-30.md` 为准；
5. 研究事实与既有结论以 `CURRENT_RESEARCH_WORKFLOW.md` 和冻结专项契约为准；
6. 兼容/历史文档中的“当前”“下一步”不得覆盖以上五层。
