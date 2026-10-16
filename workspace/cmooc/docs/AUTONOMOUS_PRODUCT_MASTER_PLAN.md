# cMOOC Community Autopilot 自主产品总计划

- 版本：`v1.14`
- 日期：`2026-08-30`
- 状态：`CURRENT / PRODUCT IMPLEMENTATION AUTHORITY`
- 当前切片：`PRODUCT_CURRENT.md`
- 长期规则：`../../PROJECT_RULES.md`

本文件定义目标架构和验收条件，不把“已有类/表/测试”自动写成当前生产链已完成。
当前事实和下一切片只以 `PRODUCT_CURRENT.md` 为准；文档层级见 `README.md`。

## 实施状态（2026-08-30）

| 切片 | 当前状态 | 证据边界 |
| --- | --- | --- |
| V0 | 完成 | 自主产品入口、文档权威和研究证据边界已重置 |
| V1 | 真实只读路径已验证 | 单次/重复 shadow、事件账本、World/Graph、决定和零编辑器/零发布 |
| V2 | 可信 companion 已覆盖历史 API 漂移；tombstone 边界保留 | RC12 UI 原生 companion 已恢复全部 38 个历史 API 重复第一页范围，并通过独立分页、稳定 ID、父链闭合、零失败和权威终止校验；2 个空/删除正文 tombstone 仍标为 visible_only/censored 与 graph lower_bound |
| V3 | 已实现且本地验证 | 追加式 observation revision 与 cutoff 回放已接入；旧真实 incident 保留，不倒改历史 |
| V4 | 已实现；本地与单次真实执行路径验证 | CandidateSet、服务器角色/历史/预算与受信语义证据形成机械可选 DRAFT |
| V5 | 已实现；本地与单次真实执行路径验证 | DRAFT-only renderer、确定性回退、正文零持久化和同目标重读已绑定执行链 |
| V6 | 已实现；一次真实 STAGE 验证 | v2 签名 grant、持久 nonce、网络/提交守卫、编辑器逐字回读和清空均留下去正文回执 |
| V7 | RC13 可运行 release 与两轮真实只读路径已验证；宿主自动化暂停，soak readiness blocked | 历史 RC12 自然轮和 20 分钟 timeout 证据保留；旧 release 不传播 `governanceFiltered`，不得恢复。RC13 使用 worker/wake v2 契约、`codex_automation/v1-rc13` scoped readiness、72 小时/144 completed 门槛与只读 API/CLI/UI；源码原槽恢复和独立 `v1-rc13-release` 均以 `local_cli` completed/exit 0、zero-write，runtime receipt 为 `runtimeReady=true`。目标宿主回执仍为 0，active unresolved high/critical=1，不能把 release 候选冒充宿主自动化证据 |
| V8 | 单动作真实证据保留；持续执行内核已完成本地加固 | 不可变 AuthorizedActionPlan、当前治理/策略解析、connector 写前重读、发送后历史绑定结算与默认关闭的零写 AUTOPILOT_CANARY 已通过本地故障/恢复验证；计划和 canary 均不授予真实发布，持续 AUTO 未激活 |
| V9 | R24/R72 与治理回流已实现 | R24 与 R72 均由目标线程 fact/root 证据 ready-only 核对为 observed；证据来源、Decision Tape 与事故确认/解决已接入；两窗均为非删失、非因果描述，没有教育效果结论 |
| T1 | 可教回合控制器已实现并完成本地纵向验证 | 外部、去正文、版本化 episode state 跨 tick 复用同一 SHADOW 提议；严格 as-of 结果只能触发 WAIT/YIELD/CLOSE，学习者保留 ignore/correct/redirect/stop，真人回应优先；不改变模型权重或发布权限，不构成学习效果证据 |
| V10 | 未启动 | 必须等待真实 outcome 数据资格 |
| UX1 | 已实现且本地验证 | `/workbench` 今日课程简报、按需机会 Canvas、精确快照证据链接和只读学伴交接；不改变发布权限 |
| UX2 | 已实现且本地与浏览器验证 | 同一机会 Canvas 内的六段证据资格、严格快照变化、双分母课程画像与确定性聚合研究包；缺证据保持 UNKNOWN/不可比，不改变发布权限 |
| FR1 | 旗舰内容与切片设计已收敛；未实现 | 近期 cMOOC 研究与 2026 LLM/harness 进展已编译为关系性促进回合；下一候选切片须在同输入 SHADOW 中让关系证据实际改变并解释至少一种决定、功能、对象或责任，同时保持零外部写入 |
| P1 | 通用只读运行接缝已实现并以 synthetic v2 纵向验证；目标平台连接器待联调 | 通用 manifest v2、精确 observer registry、DB adapter 绑定、worker/runtime health 通用 loader、单客户白标与社区接入中心已落地；当前没有小盒 API、认证或页面证据，不得写成已支持小盒 |

当前产品已证明一条完整的单动作真实纵向切片，签发并消费了不可变 SHADOW 课程运行
baseline，并完成历史自动回执、课程策略 CLI 生命周期、R24/R72 描述性回流与 38/38
companion 恢复；连续两轮自然任务也已验证外层 timeout 缓解、worker/外层双终态与直接
安全 stdout。RC13 又补齐治理过滤告警、未恢复 companion 失败门槛、source/runtime
隔离、active-visible operator 视图与可计算 soak 资格，并形成已通过真实只读 worker 的
自包含 `v1-rc13-release`；但宿主自动任务当前暂停，旧 RC12 release 不具备新契约；
1 条 active acknowledged high 仍未解决，使 readiness 保持 blocked。封闭六键 JSON
本体正确，但自动任务框架仍追加 UI 指令；连续 soak 和 2 个
tombstone 的删失边界仍未
满足成熟 v1 Definition of Done。最新回执、删失范围和
下一切片以 `PRODUCT_CURRENT.md` 为准。

P1 把平台依赖收敛到版本化 manifest 与只读 observer：课程研判、World/Graph、预算、
调度、回执和运营界面保持共用；目标平台只需实现精确注册的观察连接器并通过课程绑定、
分页完整性、重试、隐私与零发布验收。首次商业交付采用一个客户一套隔离部署，不把当前
基础冒充多租户 SaaS。目标社区的 API、认证和页面契约以
[在线学习社区接入包](PLATFORM_CONNECTOR_KIT.md) 为准。

UX1 是用户工作入口，不是新的 autonomy 执行级别。它把同一课程、同一 invocation、同一
world snapshot 下的异常、覆盖边界、成熟支持缺口、干预决定与到期结果压缩为最多 5 个
待核事项；复杂结构继续留在按需证据 Canvas 和既有治理页。跨项目证据、评分和后续路线
见 [CROSS_PROJECT_PRODUCT_OPPORTUNITY_MAP_2026-08-12](CROSS_PROJECT_PRODUCT_OPPORTUNITY_MAP_2026-08-12.md)。

UX2 继续保持“对话主线 + 一个按需画布”的极简信息架构，不把研究资产铺成课程驾驶舱。
四个视角一次只渲染一个：资格链不伪造缺失 receipt，变化只用同 Manifest 严格早期快照，
课程画像始终保留双分母与 unsupported，相容范围明确为识别区间，研究导出只含确定性
聚合证据。所有入口绑定 `courseAlias + invocationId + snapshotId`，跨课程、跨快照或哈希
冲突 fail closed。UX2 不授权自动发布，也不把结构变化、画像或离线 LLM 评估写成真实
学习效果。

2026-08-30 的执行内核切片把一次性 L3 中可复用的安全状态机与持续 worker 解耦：
`AuthorizedActionPlan` 持久绑定 completed SHADOW DRAFT、Manifest、当前治理、执行策略和
Connector；真正发送前必须再次读取目标并重新解析治理。发送后的结算只核验历史不可变
绑定，避免立即重锁、策略撤销或计划过期把 `sending_real` 卡住。worker 另有一个默认不
安装的 AUTOPILOT_CANARY dispatcher，只能以 false Policy/Permit 走
`simulated_no_write → completed_no_write`，不导入外部执行组件。测试库空库已通过全部 29 条
migration，关键集成 38/38、安全单元 57/57、类型、lint 与 production build 均通过；没有
真实课程读取、自动任务变更或外部写入。这是开发基础，不是持续 AUTO 或 soak 证据。

## 1. 产品结论

本项目的最终产品不是“AI 自动回帖器”，也不是“教师逐条审批台”，而是一个长期运行
的共同体促进自动驾驶系统。它周期性理解课程正在发生什么，在有限促进预算内决定是否
介入、面向谁、采用什么促进功能，并在社区已经自行连接时主动让位。

核心用户：

- **课程 PI：**设定课程级运行策略、预算、有效期和停止条件；
- **课程运营者：**维护课程入口、登录态、运行时段和异常处置；
- **教师/研究者：**查看长期质量、近端过程指标和抽样 Decision Tape；
- **学习者：**只在 cMOOC 原生讨论区看到最终促进回复。

正常运行不要求人类坐在控制台前逐条接受、编辑或拒绝。人类负责策略治理、长期抽查、
异常处理和紧急停止。每次外部动作仍必须由机器签发一次性、内容和目标绑定的执行许可。

产品可靠性链与前瞻研究发现是并行完成面。运行事故、release、soak 和外部授权决定
相应产品能力能否启用，不决定课程现象、关系机制、教师/学习者判断和只读 shadow 研究
能否展开；研究主张与方向见
[课程共同体促进研究纲领 R1](COMMUNITY_FACILITATION_RESEARCH_DIRECTION_R1_2026-08-30.md)。
研究发现进入产品时另建版本化策略或契约，不倒改冻结 P3/P4，也不把产品运行证据自动
登记为教育效果。

近期 cMOOC 小论文与最新 LLM/agent harness 如何进入同一旗舰体验、统一产品对象和下一
纵向切片，见
[cMOOC 旗舰产品研究整合纲领 R1](FLAGSHIP_PRODUCT_RESEARCH_INTEGRATION_R1_2026-08-30.md)。
该文档负责内容整合与切片设计；本文件继续承担产品实现权威，`PRODUCT_CURRENT.md`
继续承担当前事实权威。

## 2. 目标产品黄金路径

```text
Codex Scheduled Task / 本机时钟
→ autonomy:worker
→ disk/DB CourseManifest + 当前 CourseOperationGovernancePolicy 精确核验
→ schedule/governance 双绑定 invocation
→ autonomy:tick
→ API + Chrome 完整巡检
→ ObservedEventLedger 追加事件
→ EventWorldKernel 原子投影
→ CourseWorldSnapshot + Graph
→ Opportunity + CandidateSet
→ 角色 / 历史 / 预算受信回执
→ PolicyKernel: DRAFT / WAIT / ABSTAIN / YIELD
→ TeachableEpisodeProjector: NONE / REUSE+WAIT / YIELD / CLOSE
→ Intent + MoveSpec
→ SemanticRealizer
→ Chrome 写前重新观察
→ Resolver: EXECUTE / YIELD / REVIEW
→ shadow / STAGE / AUTO
→ 发布核对
→ OutcomeObserver
→ ProximalOutcome + 新世界状态
```

Codex 定时任务只负责唤醒一次幂等命令并读取运行摘要。长期状态、游标、预算、租约、
幂等键和恢复全部属于项目数据库，不依赖 Codex 对话记忆，也不叠加应用内易失
`setTimeout` 调度器。

截至本轮更新，除既有真实只读前半链外，另有一条明确授权的单动作执行证据：

```text
CourseManifest → 真实只读扫描 → Event Ledger → World/Graph
→ CandidateSet → 服务器证据 → 机械 DRAFT + re-read
→ 认证 STAGE → Policy/Permit → production Committer
→ confirmed_published → R24 observed / R72 observed
→ HARD RELOCK
```

该证据包含一次且仅一次远端 mutation，不证明持续 AUTO、长期可靠性或教育效果。
2026-08-02 又完成 one-shot SHADOW worker 的真实只读运行、R24 ready-only 核对和
RC9 自然自动回执。2026-08-03，关机中断的 RC11 invocation 由 worker 回收过期租约；
RC11 随后暴露 3 个 companion 竞态失败并未获提升。RC12 通过显式详情绑定等待和有界
瞬时重试，在无数据库探针与持久化到期槽中都恢复 38/38 个历史 API 位置漂移范围，
编辑器/发布均为 0；R72 也已 ready-only observed。唯一 Codex cron 已保持
`gpt-5.6-luna`、reasoning `max`、每 30 分钟、failed-only、
`wake-source=codex_automation`，并指向 `runtime-version=v1-rc12`。首条自然 RC12 worker
虽 completed/exit 0，其 Codex 外层曾在 300 秒误超时；底层进程仍持有有效租约并在约
14 分 47 秒后完成。将 timeout 调整为 20 分钟并移除自建 stdout 解析后，随后两轮自然
worker 分别约 13 分 30 秒和 13 分 38 秒 completed/exit 0，外层任务分别约 15 分 51 秒
和 15 分 39 秒 completed，直接捕获安全 JSON，单轮
due/considered/executed/failed=1/1/1/0。当前共 23 条终态回执，22 completed /
1 shutdown-abandoned，自动/本地来源为 13/10，累计
`due/considered/executed/skipped/failed=17/17/16/1/0`。第二轮封闭六键 JSON 本体正确，
但 Codex 自动任务框架仍追加 UI 收件箱指令；课程平台无副作用，提示词层无法消除该行为。
唤醒方式不改变能力边界，也不构成长期 soak 已完成。

2026-08-23 的 RC13 源码候选把 worker summary 升为
`cmooc.autonomy-worker-once.v2`、wake receipt 升为 v2，并把当前资格 scope 固定为
`codex_automation/v1-rc13`。测试污染防护与活动课程 scope 隔离完成后，开发库只保留
1 个 enabled 真实 manifest/schedule；一次真实 `local_cli/v1-rc13` 原槽恢复完成
1,581 个观察事件，0 新事件、0 目标失败、0 治理过滤、0 编辑器写入、0 发布。三条
2026-08-09/10 high 事故均以追加式 transition resolved，当前 active open high/critical
为 0；另有 1 条 active high `tick_failed` 已 acknowledged 但尚未 resolved，所以 active
unresolved high/critical=1，readiness=`blocked`。该回执不是 Codex 宿主自动化回执，目标
`codex_automation/v1-rc13` 仍无回执。2026-08-24 又形成自包含 `v1-rc13-release`：402 个
受控源码文件、26 个 migration、路径型环境、独立依赖、生产构建、硬锁和本机登录态
存在性通过 v2 runtime receipt 核验为 `runtimeReady=true`。该 release 的真实只读 worker
完成 64/64 详情、1,581 个观察事件、0 个目标失败、0 个未恢复 companion 失败和零写入；
仅 2 个 tombstone 保持删失。自动任务和旧 RC12 release 继续暂停，直到用户明确允许原子
切换、恢复；release 成功不替代目标宿主回执或长期 soak。

## 3. 从 BJET81 迁移的机制，而不是流程负担

### 3.1 Course Event World

第一版“世界模型”正式称为 `Course Event World + State Projection`。它是确定性的
事件世界：

- 真实事件、线程、参与者、父回复、资源和平台状态；
- 严格时间、完整时点 bucket、稳定引用和观测游标；
- 合法候选、状态转移、提交、回放和哈希；
- 由事件账本可重建的线程、参与者和关系 Graph。

它不是 learned world model，不预测未观察心理状态，也不把一次发言固化为人格。

### 3.2 Strict-prior Observation 与 CandidateSet

每次决定绑定：

- `asOfCursor`
- `worldSnapshotHash`
- `eventSetHash`
- `candidateSetHash`
- `budgetSnapshotHash`
- `policyVersion`

候选只能由服务器从严格先验事件机械产生。LLM 不得浏览全课后自由选人，也不能创建
CandidateSet 之外的目标。

### 3.3 四责分离

1. `PolicyKernel` 决定是否行动、目标、促进功能和结构化 proposal；
2. `Resolver` 拥有时间、目标合法性、forced WAIT、预算和最终 resolved action；
3. `SemanticRealizer` 只把 Intent/MoveSpec 实现为文本；
4. `Committer` 只执行已经解析并取得许可的动作。

语言模型不能控制 courseId、时钟、身份、候选、预算、world commit 或发布权限。

### 3.4 Decision Tape

每个机会形成追加式 Decision Tape：

```text
invocation
→ observation
→ world snapshot
→ candidate set
→ proposal
→ resolution
→ Intent / MoveSpec
→ semantic digest
→ pre-execution observation
→ execution permit
→ execution receipt
→ post-execution observation
→ outcome windows
→ policy/world state transition
```

Decision Tape 必须能在不调用 LLM、不操作浏览器和不写论坛的情况下重放并核验结构、
哈希、合法性和状态转换。

### 3.5 Teachable Episode Controller

第一层“可教”不是让语言模型自由吸收偏好，也不是把教师和学习者变成逐条审批者，而是
一份模型外、版本化、可核验的回合状态。它只读取严格先于当前决定的同课程、同线程证据，
并绑定目标版本、策略、治理、渲染器、促进功能和既有 SHADOW 回执：

- 完全相同的 SHADOW 提议跨 tick 复用，避免重复正文生成与重复目标详情读取；
- 真实发布后尚无回应时等待；学习者返回或同伴接续时立即让位；R72 成熟且仍无回应时关闭；
- 所有 episode directive 只能把当前决定收窄为 WAIT、YIELD 或 ABSTAIN，不能创造候选、
  扩大预算、改变正文、取得编辑器写入或发布权限；
- `AuthorityFootprint` 明示智能体可做的促进动作与学习者的 ignore/correct/redirect/stop
  权利，真人回应在任何自动延续之前；
- outcome 仅是描述性过程状态，不是奖励、因果效果、学习效果或模型权重更新。

下一层才是课程级、可版本化的 teaching delta 与有界角色路由；它必须继续绑定证据来源、
有效期、适用范围和撤销路径，并在进入自主主链前证明不会把一次互动固化为学习者人格。

### 3.6 ProspectiveWorldModel 后置

动作条件前瞻模型只有在真实运行积累足够 outcome 后加入。它对候选动作预测短期社会
后果和不确定性，只向 policy 提供密封 forecast，不能写世界或替代 resolver。只有
记录 forecast 被读取且确实改变行动，才可称为 prospective mechanism engagement。

## 4. 运行模式

| 模式 | 平台读取 | LLM | 编辑器 | 发布 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `OBSERVE` | 是 | 否 | 否 | 否 | 巡检、世界状态和 Graph |
| `SHADOW` | 是 | 可选 | 否 | 否 | 候选、决定、Intent/MoveSpec 与草稿 |
| `STAGE` | 是 | 是 | 写入、回读、清除 | 否 | 测试平台伴随驱动和写守卫 |
| `AUTO` | 是 | 是 | 是 | 策略允许时是 | 课程级预授权自治运行 |
| `HALTED` | 只读诊断 | 否 | 否 | 否 | 紧急停止或信任边界异常 |

`AUTO` 由版本化 `AutonomyPolicy` 激活，不由客户端布尔值或普通环境变量启用。L3
通过一次性策略、单个 Permit 和签名作用域写锁完成了一次真实动作；结束后
`realPublishEnabled=false`、0 active real policy、0 open Permit、global hard lock=true。
持续 AUTO 仍不是当前激活模式。`AUTOPILOT_CANARY` 也不是第五种模式；它是 completed
SHADOW 后显式安装、默认关闭的本地零写状态机演练。

## 5. 系统架构

### 5.1 控制平面

- `CourseManifest`：课程别名、精确 courseId、规范 URL、允许 origin、driver、时区；
- `OperationSchedule`：RRULE/间隔、模式、预算、有效时间；
- `AutonomyPolicy`：允许功能、动作、运行时段、最大频率、撤销和紧急停止；
- `ModelUsePolicy`：provider、模型、允许字段、去标识方式、预算和有效期；
- `ScheduledInvocation`：`(scheduleId, scheduledFor)` 唯一，保存 lease、heartbeat、
  attempt、状态和总回执；
- `AuthorizedActionPlan`：不可变绑定 decision/invocation/Manifest/治理/策略/Connector/
  action/proof/expiry；只证明动作计划，不授予平台写入；
- `ExecutionPermit`：一次性绑定 target/version/content/policy/expiry/idempotency，并在
  connector 路径绑定 ActionPlan 和写前重读证明。

### 5.2 感知平面

- Chrome 是已登录页面身份、写前/写后重读和 UI 执行权威；
- cMOOC API 用于列表、详情、评论分页和发布后核对；
- Playwright 保留为确定性只读诊断与测试 fallback；
- 所有来源归一为同一 `ObservedCourseEvent`；
- 每次扫描产生栏目、分页、线程、评论、失败和删失的 `CoverageReceipt`。

API 和 Chrome 冲突时不静默择优。执行前以同标签页 Chrome 重读为目标权威，冲突进入
当前目标的 `ABSTAIN/REVIEW`，但其他独立线程继续巡检。

### 5.3 世界平面

- `ObservedEventLedger` 是追加式事实源；
- `EventWorldKernel` 处理时间、完整时点、父边、角色引用、版本和原子游标；
- `ThreadStateAtCutoff` 保存根事件、事件集合、完整性、外部作者和最大深度；
- `ActorCourseStateAtCutoff` 保存角色证据、活动、连接和触达历史；
- `InteractionEdgeProjection` 保存 actor→actor、reply-to、resource-link 等边；
- `CourseWorldSnapshot` 保存 cutoff、源事件哈希、开放缺口、覆盖和图指标。
- `CourseStructureFact` 保存当前 scan 观察到的课程、栏目、主题、成员、受控概念和
  匿名资源事实；每条事实严格绑定 `courseKey`、scan 和修订哈希；
- `CourseContentGraphSnapshot` 是与 World 快照同 cutoff 的版本化 sidecar，
  节点、边和 learner 位置均有子状态哈希，读取时按课程和 schema 关闭串课；
- learner 位置只使用服务器角色名册的明确 learner 证据；当评论覆盖被删失时，
  计数为下界，PageRank 与 k-core 不计算。

Graph 是事件世界的派生视图，不是第二事实源。初版使用 SQLite/Prisma 即可，不引入
Neo4j。Graph v2 描述可观察的课程结构与互动过程，不声明心理特质、社会孤立、教育
效果或因果作用。

### 5.4 决策平面

- 从 P3A 复用 72 小时支持缺口、显式 tick、TTL、预算、作者覆盖、冷却和重复触达；
- 服务器签发 `TrustedCourseRoleAttestation` 和
  `TrustedSchedulingHistoryAttestation`；
- 服务器详情正文只在有界内存中形成 `TrustedSemanticEvidenceAttestation`，并绑定
  observation、target version、event prefix 与失效时间；
- `targetReason` 描述为什么选择这个目标，`communityProcessGoal` 描述希望促进的
  共同体过程，两者不得互相替代；
- `PolicyKernel` 只在签发的 CandidateSet 中运行；
- `WAIT`、`ABSTAIN`、`YIELD` 是正式行动，不是失败；
- 真实真人连接或作者再参与优先 `YIELD`；目标编辑、事件前缀退化、来源删失或证据
  过期进入 fail-closed `REVIEW`，两类结果都禁止继续写入或发布。

### 5.5 语言实现平面

- 语义分析器只输出 dominant need、relation evidence、sequence completion 等受约束
  信号及证据引用；
- P4 生成 `InterventionIntentV1 + FacilitationMoveSpecV1`；
- LLM renderer 只能读取已解析的目标、功能、MoveSpec 和最小文本上下文；
- schema、长度、引用、目标、语气和功能检查失败时只使当前候选降级，不停止整轮；
- 正文不进入普通日志、Decision Tape 公共层或研究证据包。

### 5.6 执行与结果平面

- Chrome companion 提供 run nonce、同标签页网络守卫、editor readback 和写后证明；
- 写入前重新观察目标版本和事件前缀；
- STAGE 只写入、回读和清除，不触发发布；
- AUTO 使用单次 ExecutionPermit 和稳定幂等键；
- 默认关闭的 AUTOPILOT_CANARY 只消费 false Permit 并生成本地 `completed_no_write`，不调用
  Connector、浏览器、编辑器、production Committer 或网络；
- 结果未知时先从 UI/API 核对，禁止盲重试；
- `OutcomeObserver` 计划 R24/R72 等窗口并记录删失。

## 6. 最小持久模型

| 对象 | 关键用途 |
| --- | --- |
| `CourseManifest` | 消除错误默认课程和目标漂移 |
| `OperationSchedule` | 课程级运行节奏和模式 |
| `ScheduledInvocation` | 幂等唤醒、lease、heartbeat、恢复 |
| `CourseScanRun` | 完整巡检、游标和覆盖证明 |
| `CourseEvent` | HMAC 事件、actor、parent、时间、版本和来源 |
| `CourseEventObservation` | 追加每次观察的 source/target 修订，支持旧 cutoff 重放 |
| `CourseWorldSnapshot` | 版本化事件世界和 Graph 输入 |
| `ThreadStateAtCutoff` | 线程状态、回复深度、完整性和支持缺口 |
| `ActorCourseStateAtCutoff` | 角色、连接、覆盖、冷却和触达 |
| `SchedulingLedger` | tick、候选域、预算日和理由 |
| `BudgetReservation` | 原子预算预留、消费和释放 |
| `AutonomyDecision` | DRAFT/WAIT/ABSTAIN/YIELD 与证据 |
| `SemanticRealization` | 模型/模板版本、正文哈希和验证结果 |
| `AuthorizedActionPlan` | 已授权计划的 Manifest、治理、策略、Connector 与有效期快照；本身无写权限 |
| `ExecutionPermit` | 一次性目标/版本/正文/策略绑定 |
| `ExecutionAttempt` | 发送、核对、结果不明和幂等 |
| `ProximalOutcome` | 真人回复、作者返回、深度、摄取和删失 |
| `ReviewEvent` | 长期抽查、异常处置和用时，不保存正文 |

## 7. 纵向切片

### V0：规则与唯一入口

目标契约与当前验收项：

- 默认终点变为成熟自治闭环；
- `PRODUCT_CURRENT.md` 是唯一当前状态；
- 总计划与研究证据边界分开；
- 历史 Gate/review 不再产生开发停门。

验收：

- `npm run verify:agent-guidance`
- `git diff --check`

### V1：真实课程单次 shadow tick

新增目标模块：

```text
configs/courses/bnu-test-course.json
lib/autonomy/course-manifest.ts
lib/autonomy/invocation-store.ts
lib/autonomy/tick.ts
lib/world/live-event.ts
lib/world/live-world-projector.ts
lib/world/live-graph-projector.ts
scripts/autonomy-tick.ts
tests/unit/autonomy-tick.test.ts
tests/integration/autonomy-shadow-tick.test.ts
```

结果：

- 一条命令从显式测试课程进入真实事件决定；
- 持久 invocation/lease；
- 最小事件账本、world snapshot 和 Graph；
- observation→history/role/budget→P3A/P4 路由连通；
- 不触碰编辑器、不发布。

### V2：全课程覆盖与断点续扫

结果：

- 全栏目、全分页、评论树和覆盖证明；
- API/Chrome source reconciliation；
- 重复、乱序和中断输入幂等；
- 一个目标失败不停止其他线程。

验收场景包括多页、超过 100 评论、中断恢复、栏目 SPA 超时和来源冲突。

### V3：版本化事件世界与 Graph

结果：

- full replay 与 incremental projection 一致；
- 同一时点事件置换不改变世界；
- 决策后未来后缀不改变旧快照；
- Graph v2 支持 course、column、thread、actor、受控 concept、匿名 resource，
  以及 contains、authored、participated-in、reply-to、discusses 和 resource 边；
- 7 日、30 日和全时段 learner 位置由服务器角色证据门控；覆盖删失时只给下界；
- `/autonomy/world` 可按时间回放，并提供课程结构、事件参与者网络和学习者位置
  三种可核验视角。

当前实现已区分新修订、重复观察和不可解释冲突。稳定 `CourseEvent` 不覆盖，新的
`CourseEventObservation` 追加修订；World、Graph 和 outcome 前缀按 cutoff 选择当时
可见版本。该语义已通过 migration/数据库测试，更新后真实课程回放仍需单独验收；
已有 `event_version_conflict` incident 继续保留为历史运行证据。

### V4：服务器可信在线调度

结果：

- 客户端不再自报角色、历史、预算和候选全集；
- 目标 live HTTP 路径可以到达真实 DRAFT；
- 并发 tick 不超预算；
- 冷却、作者覆盖和重复触达由账本计算；
- P3A 离线策略与在线实现共享时点语义。

当前已把瞬时语义回执、服务器受信语义 attestation、target reason/process goal 和
自然 DRAFT 接入自治 tick，并以真实形状的本地 observer 完成纵向测试。真实课程在
更新后是否存在自然合格 DRAFT 尚未验证；没有合格目标时必须保留
WAIT/ABSTAIN/YIELD，不能为验收制造 DRAFT。

### V5：结构化促进与受约束 LLM

结果：

- WAIT/YIELD 不调用 LLM；
- LLM 不能修改目标、功能和动作；
- renderer 可替换、可回退到确定性模板；
- 每个语义结果绑定模型、提示/契约版本和证据时点；
- 理由—Intent—MoveSpec—草稿哈希形成可核对链。

当前 renderer 已在 `autonomy:tick` 中按 DRAFT-only 启用。没有 generator 时使用
显式确定性回退，持久层只保存 Intent/MoveSpec、版本、验证结果和正文哈希；非 DRAFT
保持零模型调用。该能力已本地验证，仍不得用本地 DRAFT 代替真实课程链验收。

### V6：Chrome companion 与认证 STAGE

结果：

- run nonce 和同标签页网络守卫；
- 编辑器写入、readback、清除和写后守卫；
- 真人回复或目标变化自动撤回；
- `DRAFT_STAGED_NOT_PUBLISHED` 不再依赖调用方自报；
- 重复 STAGE 不发送论坛写请求。

签名协议已升级为 v2，并统一使用 `cmooc.transient-draft-content.v1` 规范哈希。L3
在真实编辑器完成写入 1、逐字回读、清空 1，拦截/观察到的外部 mutation 为 0；回执
已与同一 DRAFT、目标版本、事件前缀和执行 policy 绑定。常规 `autonomy:tick` 尚未把
该 companion 作为持续模式调用。

### V7：Codex 定时无人 shadow

结果：

- Codex standalone scheduled task 只执行一次有界 `autonomy:worker`；
- 数据库 lease、heartbeat、expired tick 和崩溃恢复；
- 目标是例行成功只进入日报、异常进入 inbox；当前应用已配置 failed-only，但 Codex
  自动任务框架仍会在成功 JSON 后追加 UI 指令，尚未达到该目标契约；
- 连续 soak 无游标丢失、重复决定或预算泄漏。

唯一 30 分钟 Codex 任务当前为 `PAUSED`。它历史上以 `gpt-5.6-luna`、reasoning `max`、
failed-only 通知、`wake-source=codex_automation`、`runtime-version=v1-rc12` 从
`%LOCALAPPDATA%\cmooc-autonomy-runtime\v1-rc12-release` 调用有界 worker；该历史镜像缺少
RC13 的治理过滤传播，不能直接恢复。1 个 SHADOW baseline 仍精确绑定 Manifest；历史
RC12 本地到期槽证明 schedule/governance 绑定、38/38 companion 恢复和 0 编辑器/发布，
RC13 源码又完成一次真实原槽恢复。新的自包含 `v1-rc13-release` 已按 v2 worker/wake 契约和
`codex_automation/v1-rc13` scope 生成，并通过 runtime finalizer 与 release 内真实只读 worker；
未恢复 companion 现在会使 worker 失败，不能误计入 soak。原子切换和恢复因会开始真实
课程周期读取并可能产生 failed-only 通知，保留为用户决定。封闭六键 JSON 本体也已验证，
但 Codex 自动任务框架仍追加 UI 指令，应用层抑制能力保持开放。长期 soak 的可靠性仍必须
由连续自动周期、重启和故障证据证明，不能由任务配置、两次本地槽或单元测试推断。

### V8：测试课程策略授权 AUTO

结果：

- `AutonomyPolicy` 代替逐条人工批准；
- 每个动作仍获得单次 ExecutionPermit；
- 内容/目标/版本/策略/时限和幂等绑定；
- API 与 UI 核对；
- 结果未知不盲重试；
- 紧急停止即时阻断新 permit。

历史 L3 已实现 scoped write grant、单动作策略、数据库唯一约束、一次性 Permit、发送前
记账、production Committer、写后唯一新增核对、最多三次只读恢复和 outcome-unknown
禁止盲重试。一次真实运行进入 `confirmed_published`，requested/sent 均为 1；恢复
分支因未发生异常只具有本地验证。结束后所有真实开关与策略已重锁。该全局历史
attempt=1 与当前 focal SHADOW invocation 的 editor/publish=0 分层统计。

持续执行基础现已补入不可变 AuthorizedActionPlan、connector-neutral 写前重读、计划/
Permit/发送边界的当前治理校验，以及发送后的历史绑定结算。另有默认关闭的
AUTOPILOT_CANARY 通过同一 Permit/Attempt 内核完成 0/0/false 演练和中断恢复。它不调用
外部平台，也不把 SHADOW 提升为 AUTO；真实发送仍要求独立的当前权限链、账户租约、
写前证明和全局写锁作用域。

### V9：近端结果闭环

结果：

- 首个外部真人回复及时间；
- 作者再参与；
- 回复深度与跨作者边变化；
- 资源连接、认知冲突和情感支持的功能摄取；
- 新作者覆盖和 30 日重复触达；
- 自动接受/编辑/拒绝、异常处置和审阅时间；
- 观察终点、删失和缺失状态。

确认发布后已按资格建立 R24 与 R72 两个真实观察窗口。两窗都已通过同一扫描的目标
线程完整 fact、版本绑定和 root observation 核对为 observed；作者未返回、首个外部
回复为空、回复深度增量 1、新作者 0，均非删失。先前 high `tick_failed`、
`read_transport_unavailable` 与 `server_semantic_evidence_mismatch` 已保留原证据；RC13
真实原槽恢复与对应回归成立后，三者均追加 resolved 转移，当前 active
open high/critical 为 0。另一条 active high `tick_failed` 仍为 acknowledged，故 active
unresolved high/critical 为 1。这些是去正文、
非因果的过程与治理状态，不是促进效果或教育效果。

### V10：动作条件前瞻

在 V9 数据量和质量满足后再进入：

- 比较 WAIT、资源连接、认知冲突和情感支持的短期社会后果；
- 输出不确定性；
- 记录 forecast-read 和 action-change；
- 用隐藏/置乱 forecast 检验前瞻是否实际参与；
- 不把预测准确率直接当作课程效度或学习效果。

V10 不阻塞成熟 v1。

## 8. 依赖与并行方式

主依赖：

长期依赖仍是：

```text
V0 → V1 → V2 → V3 → V4 → V5 → V6 → V7 → V8 → V9 → V10
```

但当前工作树不再按编号机械补齐。L3 后最近的真实阻塞链为：

```text
active acknowledged high 的可验证解决
→ 已验证 RC13 release 获准后的原子切换
→ 38/38 companion 恢复的连续稳定性 + 2 个 tombstone 的 lower-bound 边界
→ codex_automation/v1-rc13 至少 72 小时 scoped shadow soak
→ 无新增发布的长期重启、重复调用与 unknown/reconcile 演练
→ failed-only 送达与成功轮 UI 指令抑制的外部可观测核对
→ 新授权下才允许后续真实动作
```

默认关闭 canary 只为上述链提供本地状态机演练，不代替 acknowledged high 的解决、RC13
release 原子切换授权、宿主回执或 72 小时 soak。

V7 外部唤醒不阻塞当前语义闭环。模块可并行开发，但只有进入同一真实纵向链并通过
相应证据级别的验收才算完成。

## 9. 当前模块处置

### 已进入当前自治主链

- `lib/autonomy/tick.ts`、`invocation-store.ts`：幂等 tick、lease、恢复与主编排；
- `lib/autonomy/worker.ts`、`scripts/autonomy-worker.ts`：安全 due 选择、租约恢复、严格
  summary 核验、ready-only outcome 回流，以及默认不安装、只能显式启用的零写 canary
  dispatcher；
- `lib/autonomy/course-operation-governance.ts`、`scripts/autonomy-governance.ts`：
  Manifest 绑定的追加式课程运行上限、显式 baseline CLI、hash 重算与 fail-closed
  preflight；
- `lib/autonomy/platform-observer.ts`：真实只读 API/浏览器 readiness 观察；
- `lib/world/*`：事件账本、World 与 Course Content Graph v2；
- `lib/autonomy/candidate-set.ts`、`server-evidence.ts`、`budget-reservation.ts`：候选与
  服务器证据；
- `lib/autonomy/transient-semantic-evidence.ts`、`semantic-renderer.ts`：正文零持久化
  的语义回执和 DRAFT-only 语言实现；
- `lib/autonomy/draft-revalidation.ts`：同一自治 tick 的第二次只读观察与
  EXECUTE/YIELD/REVIEW shadow resolver；
- `lib/autonomy/decision-tape.ts`：追加式运行证据。
- `lib/autonomy/one-shot-stage.ts`、`execution-stage-receipt.ts`：真实 STAGE v2 与去正文
  持久回执；
- `lib/autonomy/authorized-action-plan.ts`、`execution-permit.ts`：不可变动作计划、当前
  治理/策略解析、Permit 消费、真正发送边界重核验、发送后历史结算和结果不明核对；
- `lib/autonomy/autopilot-canary-execution.ts`：默认关闭、无外部执行依赖的 false Permit /
  `simulated_no_write` 演练与中断恢复；
- `lib/autonomy/one-shot-execution.ts`：机械选择、单动作 policy 和强制重锁；
- `lib/autonomy/production-committer.ts`、`one-shot-runner.ts`：发送前记账、真实 API
  mutation、唯一核对、只读恢复和 outcome 建窗。
- `lib/autonomy/outcome-observer.ts`：目标线程级覆盖预检、显式 outcomeIds 核对和
  ready-only 不删失路径；R24 与 R72 均已完成真实核对。
- `lib/autonomy/incident-governance.ts`、`/api/autonomy/incidents/[id]` 与
  `/review/live`：事故确认/解决 CAS、去正文 ReviewEvent/Decision Tape 和长期审核操作面。

### 已实现但待合流

- `lib/forum-adapters`：统一读取契约；
- `lib/ui-agent/live-observation.ts`：事件级回执、HMAC 和内容边界；
- `lib/live-runtime/facilitation-kernel.ts`：当前被调用的资格/四态内核，以及 DRAFT 时
  的 Intent/MoveSpec；
- `lib/live-runtime/revalidation.ts`：兼容 live-runtime 的同标签页 STAGE 前重读；
- `lib/live-runtime/draft-staging.ts`：兼容暂存状态机；
- `lib/interventions/publish-service.ts`、`lib/forum/publish-reply.ts`：幂等、目标核对和
  结果不明语义；
- `lib/analytics/graph-wavelet.ts`：图数学；
- P3A replay/policies：严格 tick、TTL、预算和撤回语义；
- context snapshot/trace：observation/inference/expression 分离。

### 继续改造后复用

- `cmooc-api-adapter.ts`：补分页、cursor、完整性和发布后核对；
- 浏览器 diagnostic adapter：保留测试 fallback，产品执行改为 Chrome companion；
- `social-network-sync.ts`、`research-evaluation.ts`：只复用边定义和指标，不再把旧可变
  raw-text 表作为自治世界事实源；
- `expression-agent.ts`：改为只接受 Intent/MoveSpec 的 renderer；
- `safety-agent.ts`：作为草稿验证器，单候选失败不停止整轮；
- `PublishAuthorization/PublishAttempt`：保留 MANUAL 兼容链；自治链使用新的 policy、
  permit 和 attempt，不假定旧记录等价。

### 冻结为历史兼容

- `lib/auto-intervention/scheduler.ts` 的 `globalThis + setTimeout`；
- `run-auto-intervention.ts` 旧候选主链；
- `global-monitor.ts`、旧 `scheduler-agent.ts`；
- 旧 ForumPost/Reply/raw-text 画像作为新运行主事实源；
- `/auto-intervention` 主导航入口。

### 保留但不作为产品主演示

- P4D-1 `/review`；
- P4F synthetic adapters；
- mock/fixture；
- historical research dashboards。

它们继续承担协议回归和研究复现，不进入真实课程世界，也不冒充产品运行。

### 后置

- Neo4j 或独立图数据库；
- 多平台通用 MCP；
- 多 worker 集群；
- persona、心理诊断和角色扮演多智能体；
- ProspectiveWorldModel。

单机 SQLite 与单 worker 足以完成第一版；Chrome companion 必须先形成受信实现。
外部唤醒可以替换，不属于语义与执行闭环的事实来源。

## 10. 产品页面

- `/autonomy`：课程脉搏、上次巡检、运行模式、覆盖率、预算和异常；
- `/autonomy/world`：事件 Graph、线程状态、关系变化和时间回放；
- `/autonomy/decisions`：四态决定与结构化理由，不提供逐条批准按钮；
- `/autonomy/runs/[id]`：完整 Decision Tape；
- `/autonomy/outcomes`：展示真实 R24/R72 状态与去正文近端指标；不得解释为因果效果；
- `/autonomy/policy`：当前是 manifest、schedule、policy、permit 与 Teachable Episode
  Controller 的只读治理视图，可见复用、等待、真人接管和超时关闭；尚不是完整策略编辑
  控制台，也不授予发布权限；
- `/autonomy/governance`：默认只展示 active-visible course 的 baseline、精确 Manifest
  绑定、有效期、模式、预算上限与同课程不可变历史；disabled/fixture 历史仍留在数据库
  审计面，不进入当前计数；无编辑按钮，不是发布授权；
- `/review/live`：默认只聚合 active-visible course 的去正文 incident、运行与审核事件，
  同时保留跨课程 worker wake 审计；disabled/fixture 历史不删除，但不污染默认当前态；
- `/platform`：LIFT-1 真实页面只读诊断；
- `/review`：冻结 P4D-1/P4F-lite 合成研究复现。

目标产品不为例行成功发送即时通知；认证丢失、courseId 错配、覆盖不完整、连续驱动
失败、预算/触达异常、发布结果未知或策略停止才进入异常箱。当前已有 incident、
确认/解决操作与只读健康视图；三条历史 high 事故保留原记录并已追加 resolved 转移，
当前 active open high/critical 为 0，但另有 1 条 acknowledged high 尚未 resolved，故
active unresolved high/critical 为 1、soak readiness=`blocked`。例行成功不通知；定时
任务当前暂停，获准恢复后仍只对
失败运行发出通知。最近运行的 editor/external-write 计数按 focal invocation
作用域计算，不把历史全局 L3 attempt 归给当前运行。

## 11. 成熟 v1 Definition of Done

成熟 v1 必须同时满足：

1. Codex 定时任务只需调用一条有界幂等 `autonomy:worker` 命令；
2. 机器或应用重启后不丢游标、不重复事件、不重复决定、不重复发布；
3. 每次全课程巡检有覆盖和删失证明；
4. API 与 Chrome 可以组合且冲突有明确处置；
5. 追加事件的 full replay 与 incremental world/Graph 完全一致；
6. 每个决定绑定 as-of 世界、CandidateSet、预算、理由和 policy 版本；
7. LLM 不能选择课程、目标、发布时间或越过 MoveSpec；
8. 真人连接或作者返回自动 `YIELD`；目标变化、来源删失或证据过期自动进入
   fail-closed `REVIEW`；
9. STAGE 具备同标签页写前/写后证明并确保零提交；
10. AUTO 具备课程策略、单次 permit、幂等、核对和紧急停止；
11. 结果观察形成近端指标、删失和异常；
12. PI 只查看摘要、异常和抽样运行，不逐条审批；
13. 真实课程连续 soak 覆盖重启、重复唤醒、网络中断和登录失效；
14. `npm run verify`、类型检查、单元/集成测试、构建和真实浏览器 E2E 通过；
15. 普通日志和 Git 中不存在论坛正文、真实身份或凭据；
16. 产品运行证据与教育效果主张保持严格分离。

截至 2026-08-24，历史 L3 已为第 9—10 项提供一次真实单动作证据；第 11 项已有 R24/R72
描述性观察与治理回流。第 1 项曾由唯一 30 分钟 Codex 任务接通，历史 RC12 连续两轮已
验证外层 timeout 缓解与 worker/外层双终态；RC13 源码恢复与独立 release 真实只读轮均已
通过，runtime receipt 为 `runtimeReady=true`，但任务当前暂停、active unresolved
high/critical=1，因此
第 1 和第 13 项都不能标为完成。封闭 JSON 本体正确但框架 UI
指令限制仍开放；第 3 项已由 companion 恢复 38/38 个历史
API 位置漂移范围，仍保留 2 个空/删除正文 tombstone；第 12 项事故操作与不可变策略链、
CLI 生命周期已具备；第 13 项连续 soak 仍缺。
460/460 测试、类型检查、lint、30 页面/路由生产构建与 340 文件独立制品审计已通过，但当前仍未满足
本 Definition of Done。

## 12. 目标 PI 验收故事

下面是成熟 v1 的验收故事，不是当前已经全部可演示的脚本：

1. Codex 定时任务唤醒系统；
2. 系统核验测试课程并展示完整扫描覆盖；
3. 新事件进入课程时间线和互动 Graph；
4. 系统展示 ABSTAIN/YIELD，以及证据充分时的一条合格 DRAFT；
5. DRAFT 形成 Intent/MoveSpec 和草稿；
6. 在系统写入编辑器前注入或观察到真人回复；
7. 系统重读、撤回并让位，Graph 更新真人连接；
8. 对另一稳定目标执行 STAGE，展示 editor readback 和零发布证明；
9. 重启应用并重复 tick，系统证明没有重复事件或动作；
10. PI 在异常/Decision Tape 页面核查全过程，不做逐条批准。

当前已有去正文回执可证明前 8 步、一次历史单动作 Permit 发布、API 核对、R24/R72
observed、受治理真实 SHADOW 槽位和 38/38 companion 恢复，但不能为演示而重放第二次
真实发布。可运行 RC13 release 已准备并验证；下一批先为 active acknowledged high 补足
可验证根因/修复依据，再在获准后原子切换并进入连续自动周期；同时维持 2 个 tombstone
边界、历史事故长期复核与只读 soak。成功轮
UI 指令抑制等待 Codex 自动任务框架支持。

## 13. 验证策略

治理策略、生命周期与外键对齐 migrations `20260802130000`、`20260802140000`、
`20260802150000` 已在数据库长度/SHA-256 备份后通过 `prisma migrate deploy` 应用并
核验为 18/18；先前 `InterventionTask`/`PublishLog` 外键动作 drift 已消除。
当前测试库另已从空库连续应用 29 条 migration，包括
`20260830180000_add_authorized_action_plan`；这不等于已把历史 RC13 release 或开发库自动
升级到当前源码。

- L0：规则和局部纯函数——定向测试；
- L1：纵向切片——单元、集成、类型检查和一个真实场景；
- L2：新信任边界——故障注入、恢复、浏览器 shadow 和定向红队；
- L3：AUTO 激活——完整 verify/build、并发、幂等、结果不明和紧急停止演练。

review finding、测试失败和历史 Gate 不产生新权限；在当前范围内自动修复并复验。
只有实际跨越外部副作用、敏感数据或不可逆边界时，才请求用户决定。
