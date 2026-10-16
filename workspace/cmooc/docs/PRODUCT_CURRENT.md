# 当前产品状态

- 版本：`v1-rc13 runtime candidate / authorized-action-plan-v1 / autopilot-canary-foundation-v1 / scenario-lab-v1-wp2a / connector-kit-v1 / teachable-episode-v1`
- 日期：`2026-08-30`
- 状态：`HARD_RELOCKED / GOVERNED_SHADOW_READY / ACTION_PLAN_PERMIT_CHAIN_HARDENED / AUTOPILOT_CANARY_DEFAULT_OFF_NO_WRITE_VALIDATED / TEACHABLE_EPISODE_CONTROLLER_ACTIVE / PORTABLE_V2_SHADOW_RUNTIME_VERIFIED / CONNECTOR_CENTER_ACTIVE / TARGET_PLATFORM_INTEGRATION_PENDING / R24_R72_OBSERVED / RC13_RUNTIME_RELEASE_VALIDATED / RC13_SOAK_READINESS_BLOCKED / SCENARIO_LAB_V1_ACTIVE / SCENARIO_LAB_WP2A_PROTOCOL_PREVIEW_ACTIVE / AUTOMATION_PAUSED_SWITCH_AUTH_REQUIRED / LONG_SOAK_NOT_STARTED`
- 文档地图：[README](README.md)
- 产品总计划：[AUTONOMOUS_PRODUCT_MASTER_PLAN](AUTONOMOUS_PRODUCT_MASTER_PLAN.md)
- 社区接入包：[PLATFORM_CONNECTOR_KIT](PLATFORM_CONNECTOR_KIT.md)
- 跨项目产品机会地图：[CROSS_PROJECT_PRODUCT_OPPORTUNITY_MAP_2026-08-12](CROSS_PROJECT_PRODUCT_OPPORTUNITY_MAP_2026-08-12.md)
- 前瞻研究方向：[课程共同体促进研究纲领 R1](COMMUNITY_FACILITATION_RESEARCH_DIRECTION_R1_2026-08-30.md)
- 研究证据：[CURRENT_RESEARCH_WORKFLOW](CURRENT_RESEARCH_WORKFLOW.md)
- S1 归档：[2026-07-31 S1 实现归档](archive/2026-07-31_AUTONOMY_V1_SEMANTIC_DRAFT_AND_REREAD_S1/IMPLEMENTATION_ARCHIVE.md)
- L3 归档：[2026-07-31 L3 单动作生产执行归档](archive/2026-07-31_AUTONOMY_L3_ONE_SHOT_PRODUCTION/IMPLEMENTATION_ARCHIVE.md)

### 2026-08-30 持久授权计划、发送状态机与默认关闭 AUTOPILOT_CANARY

持续执行内核新增不可变 `AuthorizedActionPlan`：它把 completed SHADOW DRAFT 与
invocation、Manifest、当前课程运行治理、执行策略、Connector 绑定、动作类型、证明种类
和有效期组合成稳定哈希。ActionPlan 本身不是发送权限，不开启 Manifest 或论坛发布开关；
只有当前有效且与调用方精确一致的执行策略可进入计划。connector 路径在 Permit 签发和
真正 `prepared_real → sending_real` 边界都必须重新读取目标，且在计划创建、Permit 签发
和发送边界重新解析当前治理版本。策略或治理旋转、暂停、撤销、紧急停机、目标漂移、
计划过期和陈旧重读均 fail closed。

发送后的安全闭合改为核验不可变历史绑定，不再要求已经消费的真实策略、Manifest 或
ActionPlan 继续保持开放。因此，远端请求已经发出后，即使立即重锁、撤销、停机或计划
到期，`sending_real` 仍可幂等结算为确认结果或 `outcome_unknown`；connector 路径的结果
不明核对不伪造浏览器 STAGE。浏览器 STAGE 路径继续保留，二者共享 Permit、账户租约、
预算、一次发送和禁止盲重试状态机。

worker 新增一个依赖注入、默认不存在的 `AUTOPILOT_CANARY` 接缝；它不是新的运行模式。
普通 `autonomy:worker` 命令行为不变，只有显式提供
`--autopilot-canary-policy-version <false-policy-version>` 才安装 dispatcher。dispatcher
只接受完整 completed SHADOW tick 中与 invocation、课程、治理哈希和 false AUTO 策略精确
绑定的唯一 DRAFT，并执行
`issue(false) → validate(false) → claim(simulated_no_write) → settle(no_write)`。该模块不导入
Connector、浏览器、编辑器、production Committer 或网络客户端；拒绝真实 Permit、账号
租约、STAGE、ActionPlan 和任一 mutation 状态。公开回执不返回 permit、目标或正文哈希，
固定为 requested/sent=`0/0`、publish/body/forum-text=`false`。active、claimed 和 terminal
中断可幂等恢复；claim 后即使策略撤销/停机、Manifest 关闭或 Permit 过期，也只能安全闭合
本地零写终态，不能重新获得发送能力。

测试库已从空 SQLite 连续应用 29 条 migration；新增迁移为
`20260830180000_add_authorized_action_plan`。本轮 38 个关键集成测试和 57 个 worker/治理/
one-shot 安全单元测试均通过，Prisma validate、TypeScript、Lint 和 Next.js production
build 通过。本轮没有读取真实课程、没有调用 Connector 或浏览器、没有编辑器
写入、发布或通知，也没有切换或恢复宿主自动任务；全局真实论坛写锁继续为 true。该结果
只证明默认关闭的本地零写演练基础与发送状态机恢复能力，不证明持续 AUTO 已激活、RC13
soak 已开始或产生任何外部/教育效果。

### 2026-08-29 可教回合控制器与跨 tick 自动让位切片

自主主链新增 `Teachable Episode Controller v1`。它不是让模型修改自身权重，而是把上轮
SHADOW 提议、真实发布确认和后续 R24/R72 过程结果投影为一份版本化、去正文、可重放的
外部回合状态。相同课程、线程、目标版本、策略、治理、渲染器和功能再次出现时，系统会
复用既有 SHADOW 提议并进入 `WAIT`，不重复读取目标详情或生成第二份正文；若观察到原
学习者返回或同伴已经接续，则自动 `YIELD`；真实发布后仍无人响应且 R72 已成熟时自动
`CLOSE`。这些动作只能收窄当前决定，不能把 WAIT/ABSTAIN/YIELD 提升为 DRAFT，也不能
取得编辑器或发布权限。

每个回合回执显式记录 `AuthorityFootprint`：智能体只能追问、收窄焦点或邀请同伴回应，
学习者始终保留忽略、纠正、转向和停止的权利，真人回应优先。回执严格按 `asOf` 排除未来
结果，拒绝正文键，并把结果解释固定为 `descriptive_process_state_not_learning_effect`。
Decision Tape 与 `/autonomy/policy` 现在可审计复用、等待、真人接管和超时关闭计数，但
不会把过程状态写成学习效果、奖励信号或模型学习。

本切片同时修复 `lastSystemTouchAt` 长期恒为 `null` 的证据错误：冷却时间现在只取截至
决策时点最近一次 `confirmed_published`，SHADOW 草稿和编辑器暂存均不算真实触达。数据库
增加课程、线程和 `evidenceAsOf` 的回合查找索引；当前空库迁移链为 28 个 migration。
验收结果：完整单元测试 603/603，聚焦可教回合测试 31/31，Node 集成测试 97/97，Python
迁移与对齐测试 3/3，Prisma validate、TypeScript、Lint 与隔离目录 Next.js production
build 均通过。构建使用独立 dist 目录规避 Nutstore 对旧 `.next` 的缓存链接与文件锁，
不改变产品运行语义。本轮没有恢复宿主自动任务，没有发起真实课程周期读取、编辑器写入、
发布或通知。

### 2026-08-29 可移植连接器、可靠性与采购演示切片

通用 `platform.course-manifest.v2` 已进入实际运行主链，而不再只是配置草图。v2 支持
非数字 opaque 课程引用与非 cMOOC HTTPS 地址，并以课程引用摘要、规范地址摘要、允许
origin、`platformId` 与 `adapterId` 精确绑定。tick、worker、runtime health 和课程治理
现在共同接受 v1/v2 manifest；观察器只按 `[platformId, adapterId]` registry 选择，没有
默认回退。cMOOC hybrid observer 继续只接受精确的 cMOOC v1 + `cmooc.api.v2`，未知或
错配连接器在平台观察与数据库 Manifest 同步前拒绝。数据库 Manifest 新增持久
`adapterId` 绑定，已经运行的课程不能静默切换连接器。

一条 synthetic 非 cMOOC v2 课程已经通过精确 registry 完成数据库 SHADOW tick：观察
连接器被调用一次，课程/adapter 绑定与 `platform_connector_read_only` 扫描来源落库，
编辑器写入和发布尝试均为 0；未注册 adapter 的对照在观察、schedule 和 invocation 之前
拒绝。这证明通用运行接缝可执行，但不证明小盒或任何其他目标平台已经接入。小盒仍需
提供测试环境、只读 API 或页面结构、认证续期、分页/删除语义和样例对象，才能完成真实
连接器验收。实施与验收顺序见 [在线学习社区接入包](PLATFORM_CONNECTOR_KIT.md)。

本切片同时修复三类会在长期运行中积累的缺陷：完成扫描后的失败重试现在持久并恢复
去正文语义回执，不重复读取正文；启用 schedule 改为稳定 keyset 分页，501 门以上课程
不会因固定 500 条窗口而永久饥饿；旧单次/调度预演和课程 scope 删除了首页或固定课程
ID 的隐式后备，缺少显式目标时返回稳定错误。新增 migration 后，开发库与测试库均为
27 个 migration，外键检查为 0 violation，SQLite integrity 为 `ok`。

采购演示主路径也完成收口：一级导航固定为工作台、课程世界、运行记录、结果观察和
治理；研究实验与社区接入进入治理二级导航。工作台空闲态新增基于现有 operator 读模型
的课程脉搏，统一显示一个“只读观察 · 平台写入 0”边界；移动端修复六列换行、空输入框
滚动条和首屏留白。`/platform` 现在展示白标、课程绑定、观察连接器和目标社区联调四步
准备度，并保留当前 cMOOC 只读诊断作为高级检查。

验收结果：`test:unit` 595/595；integration 97/97；课程 Graph migration 1/1；FK 对齐
2/2；TypeScript、Lint 与 Next.js production build 通过。应用内浏览器在 1440×900 与
390×844 复验工作台和社区接入页：页面无横向溢出，五项一级导航与四项治理二级导航
可用，移动输入框无空滚动条，两个接入主链接均到达目标页；本轮生产预览控制台为
0 error / 0 warning。浏览器验收只访问本地产品页面，没有读取或写入真实课程平台。

本文区分代码能力、本地验证、真实只读运行、真实外部效果和教育效果。当前代码已从
S1 语义 DRAFT 与同链重读继续前进到 L3 单动作执行链，并在一次明确授权下完成了
真实认证 STAGE、一次性 Policy/Permit、production Committer、写后唯一核对、结果
建窗和立即重锁。此后又完成无发布的真实 SHADOW worker 巡检，以目标线程级完整
证据安全核对 R24，并把唯一的 30 分钟 Codex 定时唤醒接到有界 worker。结果回流、
事故确认/解决与 Decision Tape 已进入治理视图。历史 RC9 把独立、不可变的课程运行 baseline
扩展为可核验的 `pause/resume/revoke/emergency-halt/rotate` 追加式生命周期，把 disk
Manifest、数据库 Manifest、schedule 和每次 invocation 的 governance hash 在任何
写入前绑定；缺失、漂移、暂停、撤销、过期或 emergency halt 都会 fail closed。官方
baseline 每课程只允许一个 root，精确 replay 幂等，并发不同 root 一胜一拒；future
rotate 按 as-of 时间选择，普通后继不可倒置时间，emergency halt 仅允许服务层的短时钟
偏差。RC12 又加入可信 UI 原生分页 companion、详情课程绑定显式等待、一次有界的瞬时
竞态重试和去正文失败码；修复后的无数据库真实探针与持久化到期槽均恢复 38/38 个
历史 API 位置漂移范围。关机中断留下的过期租约已由 worker 正常恢复，R72 也已通过
ready-only 路径观察完成。首条自然 RC12 worker 数据库回执虽 completed/exit 0，自动任务
外层曾在 300 秒误超时；底层进程继续持有有效租约并自然完成。调整为 20 分钟 timeout、
移除自建 stdout 解析后，连续两轮自然 worker 与外层任务均 completed，并直接捕获安全
JSON。第二轮的封闭六键 JSON 本体正确，但 Codex 自动任务框架仍在其后追加 UI 收件箱
指令，证明提示词层无法消除该界面副作用；课程平台无写入，应用仍配置 failed-only。上述
事实只证明受控纵向切片和可靠调度起点成立，不等于长期
AUTO 已激活或长期 soak 已完成。历史运行镜像为
`C:\Users\tiany\AppData\Local\cmooc-autonomy-runtime\v1-rc12-release`；它形成过连续两轮
Codex 外层与数据库 worker 双终态。2026-08-23 审计发现该镜像未传播
`governanceFiltered`，且对应自动任务当前为 `PAUSED`，因此不得直接恢复。源码已升级为
RC13/v2 契约，并在独立目录形成可运行 `v1-rc13-release`：402 个受控源码文件、26 个
migration、自包含依赖、路径型环境、生产构建、真实发布硬锁和本机登录态文件存在性均由
v2 runtime receipt 核验为 `runtimeReady=true`。该候选随后以 `local_cli/v1-rc13` 完成一次
真实只读课程巡检；自动任务配置仍未切换、仍为 `PAUSED`，所以长期 soak 尚未开始。
UI 指令抑制仍需要 Codex 自动任务框架支持。

### 2026-08-24 RC13 长时资格、release 与恢复切片

RC13 把长期可靠性从叙述性判断改为可计算、可审计且按
`codex_automation + v1-rc13` 隔离的 readiness receipt。默认门槛为至少 72 小时、至少
144 个 completed 周期、连续完成、最近唤醒不超过 60 分钟、相邻间隔不超过 65 分钟，
并要求 attention/failed/abandoned/stale、worker/recovery/due/reconcile 失败、治理过滤、
过期租约、高优先级事故、编辑器写入、发布尝试和正文持久化均为 0。只读 API、CLI 与
治理页均展示同一投影；本地 `qualified` 仍明确不等于 mature-v1 外部认证，失败通知送达
与成功轮 UI 抑制继续保持 `unknown`。

本轮同时修复了会掩盖真实状态的问题：worker 现在把 `governanceFilteredCount` 传播进
v2 summary 并映射为 attention/exit 2；健康度和最近唤醒使用活动 source/runtime 与
enabled course scope；默认 operator 课程、治理、长期审核和最近运行视图只读取
active-visible course；直接运行单个 `node:test` 文件也强制落入 `test.db`，不再继承
开发库。开发库先生成 325,771,264 字节、SHA-256 一致的可恢复备份，随后仅把 7 组明确
测试 fixture 的 manifest/schedule 设为 disabled，没有删除其策略、事故、运行或审核
历史，也没有改变 `bnu-test` 或发布开关；这些历史仍可审计，但不再污染默认当前态。

源码 RC13 随后对真实课程执行一次有界 `local_cli` SHADOW 恢复轮：原
2026-08-10 失败槽位以 attempt 3 原槽完成，扫描 1,581 个观察事件、0 个新事件、0 个目标
失败；worker 为 completed/exit 0，`due/considered/executed/failed=1/1/1/0`，治理过滤、
编辑器写入和发布尝试均为 0。与该 invocation 绑定的 `tick_failed`、
`read_transport_unavailable`，以及已由 ledger 语义绑定回归和本轮完整链验证的
`server_semantic_evidence_mismatch`，均通过追加式治理转移标为 resolved，历史证据保留。
当前 enabled manifest/schedule 为 1/1，active open high/critical 为 0，真实发布硬锁完整。
但 active course 仍有 1 条 high `tick_failed` 处于 `acknowledged`、尚未 `resolved`；因此
active unresolved high/critical 为 1，不能写成“事故清零”。

2026-08-24，新 `v1-rc13-release` 在不修改自动任务的前提下完成独立依赖安装、26 个
migration、生产构建与 finalizer 核验；runtime receipt 为 ready，且明确记录未修改
automation、未尝试外部 mutation、不包含论坛正文。release 内随后的真实只读 worker 在
约 3 分 22 秒内完成 64/64 个详情、1,581 个观察事件、0 个新事件、0 个目标失败和 0 个
未恢复 companion 失败；仅 2 个空/删除正文继续标为 censored。worker 与 wake receipt 均为
completed/exit 0，`due/considered/executed/failed=1/1/1/0`，lease 正常释放，治理过滤、
编辑器写入和发布尝试均为 0。此前匿名 release 稳定出现的 38 个 companion 失败由此确认
来自未注入登录态；worker 现也会把任何未恢复 companion 退化映射为失败终态，不能进入
合格 soak。

当前 readiness 为 `blocked`：未解决 high/critical 事故检查尚未通过；同时 RC13 只有
2 条 `local_cli` 安全回执，目标 `codex_automation/v1-rc13` 仍为 0 条，72 小时资格证据
尚未开始积累。旧 RC12 release 缺少 v2 计数契约，自动任务仍暂停；不得用历史 RC12、
本地 CLI 回执或 `runtimeReady=true` 的 release 候选冒充新的宿主自动化 soak。

### 2026-08-23 CourseWorld Scenario Lab v1

产品新增独立 `/scenario-lab` 工作面和按需 `POST /api/scenario-lab/run`。它把 P3A 冻结
证据、正式 scheduler benchmark 与后续多智能体运行时放进同一个版本化 CourseWorld
实验协议，但不接管事实、候选、决策、许可或发布权威。页面从正式工件重新聚合 2025
时间留出：2,702 个快照中 617 个在 post+22h 决策时点仍符合未回应候选条件；到
post+86h 观察终点，217 个在 64 小时窗内自然获得外部回应，400 个仍为支持缺口。

首个激活运行时 `deterministic_p3a_replay_v1` 对同一冻结候选集比较
`constrained_structural` 的 K=1/3/5：分别选择 71/167/238 个事件，支持缺口覆盖为
10.25%/24.75%/35.00%，选择中的缺口占比为 57.75%/59.28%/58.82%。这些值是时间
留出上的观察性调度回放，不是教育效果或未发生干预的因果效果。加载器在内存中验证
12,627 行正式 CSV、P3A temporal contract、evidence-ref set，并对 decision snapshots、
metrics、actions 三个 benchmark 文件逐一核对 SHA-256；API 只返回聚合、契约哈希与
运行收据，不返回正文、身份、匿名行级键或本机路径。

`ScenarioRuntimeAdapterV1` 已形成三层运行时阶梯：确定性 P3A 回放当前激活；
`oasis_sidecar_v1` 用于后续社交互动仿真；`agentsociety2_sidecar_v1` 用于后续
trace/replay/checkpoint 与分布式实验编排。每次运行生成 ScenarioSpec、三份 result、
ForecastEnvelope、RunReceipt 和总报告哈希；相同正式输入得到相同哈希。外部 sidecar
只能回传该版本化信封，不能写 Course Event World、Decision Tape、ProximalOutcome、
CandidateSet、Resolver、Permit 或 Committer。

本切片没有 Prisma migration，没有修改 P3/P4 冻结工件，也没有触发课程平台写入。
新增 14 项定点测试通过；完整 `test:workbench` 为 621/621，TypeScript、Lint 与生产构建
通过。真实浏览器在 1440、1024、390 和 320 宽度核对了正式 API 数据、K=1/3/5 键盘
切换、响应式布局与触控尺寸；API 200/no-store，控制台 0 error / 0 warning。开发计划与
后续工作包见
[CourseWorld Scenario Lab 开发总计划](plans/COURSEWORLD_SCENARIO_LAB_MASTER_PLAN_2026-08-23.md)。

### 2026-08-23 Scenario Lab WP2A OASIS 协议参考预演

`POST /api/scenario-lab/oasis-preview` 现已闭合正式 P3A 冻结证据到合成协议回执的完整
只读链：证据核验后编译 96 个合成 Agent、64 个合成讨论线程、WAIT/K1/K3/K5 四臂
ScenePack，并在 16 个固定种子上形成 64 个 arm-seed run 的 p10/p50/p90 聚合、版本化
哈希和 PreviewReport。页面必须由用户显式点击才运行；响应 `no-store`，不返回正文、
身份、匿名行级键或本机路径，也不创建真实候选、许可、Decision Tape 动作或课程写入。

Node 侧车传输使用有界 JSONL 子进程协议：10 秒超时、256 KiB 输入上限、2 MiB 输出
上限、请求哈希回显、最小无凭据环境、AbortSignal 取消与进程树清理。Python 侧车只输出
聚合协议结果。回执中的 `externalNetworkUsed=false`、写入计数与
`process_contract_only` 是 sidecar self-report / 进程契约声明，不是操作系统沙箱证明。

当前运行时明确为 `oasis_contract_reference_v1`：本机未安装、也没有调用原生 OASIS；
它只证明 evidence → ScenePack → sidecar → report → API → UI 的协议闭环和固定种子
确定性，不证明 OASIS 原生动作/feed 循环、图拓扑仿真、成本标定、课程预测、因果效果或
教育效果。原生 OASIS 接入继续属于 WP2B。

验收结果：Scenario Lab 聚焦测试 34/34，其中 OASIS 定点测试 20/20；完整
`test:workbench` 641/641；TypeScript、Lint 与生产构建通过。真实浏览器完成显式点击，
API 返回 200/no-store，两次运行报告哈希一致；390 与 320 宽度无页面横向溢出，四臂表
保留容器内横向滚动，控制台 0 error / 0 warning。外部课程写入、数据库迁移、真实发布
和通知均为 0。

### 2026-08-13 Workbench 开放规划 MVP

Workbench 现在保留三条稳定课程任务族，同时为未命中预设或跨任务族的自然语言目标
提供一条开放规划入口。规划器只从当前 Course Tool Registry 中选择 1–8 个已注册工具，
服务端再把选择编译成同一套不可变目标、规范计划、执行租约、工具回执、验证记录和
ArtifactVersion；没有新增第二套执行引擎、数据库表或回执协议。MVP 开放目录限于 L0
只读工具和研究证据包、排期审查两类 L1 可恢复成果工具，不自动引入 STAGE 或发布。

真实路由验收已覆盖一句混合目标“先检查课程排期，再生成研究证据包”：系统形成
`context.resolve → snapshot.read → research package → schedule.read → schedule review`
五步计划，完成五个成功回执并生成两个版本化成果。原始目标只在当前规划/执行中使用，
不进入安全目标、规范计划、持久快照或会话交接文件。连同既有 11 步支持缺口链、真实
Chromium 零发布暂存、恢复与 Artifact Workspace，当前 `test:workbench` 为 588/588，
26 个 migration 可从空 SQLite 连续部署，TypeScript、Lint 和 Next.js 生产构建均通过。

最终答复安全投影现在按行过滤：单个疑似源正文、内部标识或命令行不会再清空同一摘要中
其余安全的答案或草稿。默认模式的模型指令同时要求 `summary` 先交付用户请求的实际内容，
`completedActions` 只作为后续执行记录，避免以“做了什么”替代“交付了什么”。

### 2026-08-12 教师工作入口纵向切片

该增量把 `/workbench` 确立为教师和课程运营者的日常入口，但不替代 `/autonomy/*`
的治理与深层核查能力。空闲页只增加一条“今日课程简报”：服务端从同一课程、同一
invocation、同一 world snapshot 和 candidate set 构建最多 5 个事项，每类来源最多
1 个。来源固定为事故、覆盖边界、成熟支持缺口、干预决定和结果到期；只有五类来源
都完成检查且没有事项时，才返回明确的 `no_action`。覆盖不可用会形成边界事项，不会
被写成“今天无事”。

简报展开为按需机会 Canvas：桌面与对话区按 38/62 并排，窄屏为全屏二级窗口；默认
只显示可读事实、证据限制和“准入—复核—条件”三关，完整证据仍通过精确快照链接进入。
“交给学伴研判”只创建带 `snapshot:<id>` 上下文的只读任务，显式保持课程平台写入关闭，
不发布消息。新增 `/api/workbench/brief` 要求精确的 `courseAlias + invocationId + snapshotId`
三元组，跨课程、跨快照、hash 漂移和缺失证据均 fail closed；响应不包含论坛正文、身份、
凭据或任意模型内部理由。该切片没有新增数据库 migration，也没有改变真实发布硬锁。

UX1 落地当时的本地验收包括 `npm run test:workbench` 262/262、类型检查、Lint 和独立生产构建；浏览器
在 1440×1024、1280×720、1024×768、390×844 与 320×568 核对了 38/62 布局、单一 H1、
移动端全屏与焦点循环、Escape/焦点归还、隐藏系统滚动条、零页面横向溢出以及控制台
0 error / 0 warning。
产品取舍、跨项目证据和后续路线见
[跨项目产品机会地图](CROSS_PROJECT_PRODUCT_OPPORTUNITY_MAP_2026-08-12.md)。

### 2026-08-12 机会 Canvas 证据工作区纵向切片

该增量在 UX1 的同一个 Opportunity Canvas 内完成证据工作区，不新增汇报式一级页面。
教师一次只看到一个当前视角，可在“判断依据 / 事件变化 / 课程画像 / 研究证据”间切换：

- 判断依据显示 `标签 → 格式 → 证据 → 关系 → 时间 → 支撑` 六段资格瀑布，只突出首个
  停点；缺少持久化 qualification receipt 时保持 `UNKNOWN`，不把离线评测分数冒充生产
  结论质量；
- 事件变化只比较同课程、同 Manifest 且严格早于当前时点的唯一最近快照。覆盖状态不相容
  时只显示可见下界或不可比，不生成趋势箭头；
- 课程画像显示完整讨论单位与观察任务覆盖两个分母、未支持讨论单位、成熟支持缺口和
  缺失边界下的相容范围。相容范围是识别区间而非置信区间，未支持单位不编码为 0；
- 研究证据只导出确定性聚合 JSON、限制和重建说明，明确排除论坛正文、身份、行级标识、
  模型原始尝试、凭据与本机路径。下载响应携带 SHA-256 回执。

`/api/workbench/evidence` 与 `/api/workbench/research-export` 都要求精确的
`courseAlias + invocationId + snapshotId` 三元组。reader 逐表校验 Manifest、invocation、
snapshot、scan、CandidateSet、decision、Graph 与线程聚合的一致性；候选哈希、课程、
世界、事件集和时点任一漂移都 fail closed，没有“回退到最近课程”。当前没有新增数据库
migration；qualification receipt 和五功能机器分类尚未持久化的部分继续显示未知，而不是
由结构计数推断。

浏览器在 1440×1024、1024×768、390×844 和 320×700 实测了桌面 38/62 非模态分栏、
移动全屏模态、背景 `inert`、Tab 焦点循环、Escape 与触发器焦点归还、事项与视角键盘
切换、单一活动 `tabpanel`、唯一详情纵向滚动和零横向溢出；控制台 0 error / 0 warning。
完整 `test:workbench` 298/298、类型检查、Lint、diff 检查和无临时 QA 路由的生产构建共同作为本
切片验收。设计概念与最终截图保存在 `artifacts/design-qa/`，只作视觉验收，不构成课程
效果证据。

### 2026-08-11 智能控制台增量

该增量不改变 `v1-rc12` autonomy 运行镜像或真实课程发布边界。持久化的
app-server 任务在已完成且保有安全最终答复时，会显式给出“继续任务”：服务端以同一
`WorkbenchTask` 和 lineage root 创建新的 `continuation` 子运行，为其建立新的坚果云
会话目录，并只把安全结果投影交给新线程。旧 thread、原始 prompt 和已经消失的实时会话
不会被伪装成已恢复；demo、失败或没有最终答复的运行也不会获得该能力。相同
`requestId` 的重试确定性返回同一个子运行，避免双击或网络重试产生并发副本。

智能控制台的用户可见角色改为职责命名：`sol` / `luna` 继续作为协议兼容键，但页面统一
显示“主任务智能体”与“协作智能体 #n”。非最终 `agentMessage` 可以显示最长 360 字的
“现场消息节选”；进入事件前会去除凭据、链接、本机路径、命令、diff、内部标识和推理
信息。节选只随当前进程的实时事件/SSE 展示，数据库快照、事件表和坚果云会话包均不
持久化该字段；历史恢复只显示稳定的可审计摘要，不能把节选当作完整原生消息或推理记录。

`npm run test:workbench` 现在先建立一次性 SQLite 数据库并应用全部 migration，再运行
工作台 unit/integration 套件，结束后清理临时库；测试不再向开发 `dev.db` 写入历史任务。
页面仍保持课程平台写入 0、真实发布关闭和去论坛正文投影。

### 2026-08-16 Grok 策略主脑与 Sol 执行器分离

Workbench 的策略层默认配置为 Grok，Codex app-server 继续使用本机已验证的
`gpt-5.6-sol` / `high` 执行通道。两者是可独立替换的职责，不把执行器模型名冒充为
“本轮已咨询 Grok”；只有服务端附带核验过的 BrainDecision 回执时，才可对外声称实际
使用了策略主脑。Brain Router 对 Grok 输出采用“先归一化、后严格契约校验”的接收路径，
而外部写入、真实发布、权限、课程范围、回读、receipt 与独立 verification 边界保持不变。

## 1. 一页结论

当前工作树已经接通并通过本地纵向测试的链是：

```text
显式 CourseManifest
→ 完整观察与追加式事件账本
→ 按 cutoff 的版本化 World / Graph
→ CandidateSet + 服务器角色 / 历史 / 预算证据
→ 瞬时正文语义分析（正文不持久化）
→ DRAFT / WAIT / ABSTAIN / YIELD
→ Intent + MoveSpec
→ DRAFT-only renderer + 确定性回退
→ 同一 tick 的第二次只读观察
→ EXECUTE / YIELD / REVIEW shadow resolver
→ 去正文 Decision Tape
→ 一次性 worker 恢复租约、选择 due、严格核验 tick summary
→ outcome 只读 preflight
→ 仅 ready outcomeIds 的结果回流
→ 去正文 outcome / incident 治理与 Decision Tape
→ 显式、追加式 CourseOperationGovernancePolicy
→ schedule + governance 双绑定 invocation
→ API 位置漂移时由受限 UI 原生 companion 完整分页
→ `gpt-5.6-luna` / reasoning `max` 的 30 分钟单 worker 唤醒
```

常规 `autonomy:tick` 中的 `EXECUTE` 仍只表示“允许继续 shadow 语义链”，不直接授予
编辑器写入或发布。L3 使用独立、受签名短租约和用户单次授权约束的执行入口：

```text
机械选择持久 DRAFT（64 个候选中的零基序位 6，即第 7 个）
→ 确定性重建正文 + 目标/事件前缀重读
→ 认证 STAGE v2：编辑器写入 1、逐字回读、清空 1、mutation 0
→ 单动作 AUTO Policy + ExecutionPermit
→ 发送前记账
→ production Committer 发送 1 次
→ API 写后唯一核对 confirmed_published
→ R24 / R72 建窗
→ policy / permit / manifest / forum setting 立即重锁
```

此前真实课程基线仍支持：

```text
真实课程扫描
→ ObservedEventLedger
→ World / Graph v2
→ CandidateSet + 服务器证据
→ ABSTAIN / YIELD
→ Decision Tape 与只读治理页
```

该历史快照不会倒改。L3 之后新增的生产事实是：1 条认证 STAGE 回执、1 个已消费
Permit、1 次真实 attempt、1 次确认发布以及 R24/R72 两个 outcome 窗。R24 与 R72
均已完成去正文、非因果的描述性观察：都没有观察到首个外部回复或作者返回，回复深度
增量均为 1，新作者均为 0，且均非删失。教育效果证据仍为 0。

RC9 历史七个受治理真实 SHADOW 槽位已完成，合计形成 2 个 DRAFT、19 个 YIELD 和 2 个
SemanticRealization；七轮均没有进入编辑器或发布。它们证明治理绑定后的真实只读语义
链可运行，不增加真实外部效果证据。历史全局 L3 external attempt=1 继续保留；最近
运行页的 editor/external-write 计数按 focal invocation 作用域显示为 0/0，不把历史
全局计数归给当前运行。

## 2. 本轮完成的 S1 能力

### 2.1 事件修订语义

- 同一稳定事件身份现在区分 `initial / duplicate / revision / conflict`；
- `CourseEvent` 保留稳定身份，`CourseEventObservation` 追加每次观察的 source/target
  版本与 revision kind；
- 合法晚到修订不再覆盖旧 canonical event，也不再自动形成 version-conflict；
- World、Graph、outcome 前缀和恢复 hydration 按 cutoff 选择当时最新修订；
- 数据库测试证明旧 cutoff 重放旧版本，后续 cutoff 才看到新版本。

已有历史 incident 仍保留为原运行证据，不会被迁移静默删除或改写。

### 2.2 瞬时语义证据

真实详情的标题、正文和标签只在当前观察进程的有界内存中分析。持久化对象仅包含：

- contribution functions；
- epistemic seed 状态；
- connection/conceptual/participation need signals；
- dominant need、原子想法计数和特征证据哈希；
- observation、target version、event set 与时间绑定；
- `containsForumText=false`。

正文、标题、身份、平台 ID 和认证信息不进入普通数据库字段、Decision Tape、归档或
测试输出。

### 2.3 自然 DRAFT、语言实现与重读

- 服务器扫描只有在完整评论前缀、稳定身份、明确 learner 角色和无 unknown relation
  时才可签发受信语义证据；
- 该服务器证据与旧 `same_tab_guarded` 兼容链分开，不能伪造 STAGE 授权；
- `targetReason` 与 `communityProcessGoal` 分开记录，避免把“为何选择目标”和“希望
  促进什么共同体过程”混为一个标签；
- 只有 DRAFT 进入 renderer；当前自治 tick 使用本地确定性 fallback，不调用在线
  模型，也不保存草稿正文；
- DRAFT 后共享一次第二轮只读观察，按事件差量和目标版本输出
  `EXECUTE / YIELD / REVIEW`；
- resolver 回执始终为 `editorWriteAllowed=false`、`publishAllowed=false`。

### 2.4 L3 单动作执行链

- `ExecutionStageReceipt` 只接受签名、短期、nonce 一次性的 v2 STAGE 回执；正文哈希
  统一使用 `cmooc.transient-draft-content.v1` 规范，避免原始 SHA-256 与产品内容哈希
  契约错配；
- `ExecutionPermit` 只在同一目标、目标版本、事件前缀、内容哈希、policy 和有效期
  全部一致时签发；同一课程/policy 的真实 Permit 受数据库部分唯一索引约束；
- production Committer 在发网前先把 attempt 原子标为 `sending`，随后只允许一个
  `/comment/commentModule` mutation；
- 写后通过 API 比较发送前后集合，只在唯一新增且规范内容一致时确认发布；发送后
  连接异常进入只读恢复，不能盲重试；
- `finally` 总是撤销真实 policy、关闭未用 Permit、设置 emergency halt，并恢复
  manifest、论坛设置与代码级硬锁；
- 本轮真实运行命中正常确认分支，未触发恢复分支。

## 3. 证据层级

| 层级 | 当前结论 |
| --- | --- |
| 代码能力 | S1 前半链 + STAGE v2 + 单动作 Policy/Permit + production Committer + 写后核对/恢复 + 受治理 one-shot worker + target-scoped outcome/incident + 课程运行策略生命周期 + coverage v5 可信 UI 分页 companion + RC13/v2 scoped soak readiness 已实现 |
| 本地验证 | 历史 RC12 的 460 项验收继续保留；RC13 新增 readiness、governance-filter 告警、active scope 隔离、测试库防污染与 release 构建路径，并重新执行当前完整回归、类型检查、lint 与生产构建（以本节末最新验收记录为准） |
| 真实只读闭环 | RC12 持久化扫描、World/Graph、CandidateSet、重读、R24/R72 ready-only 核对与 38/38 companion 分页均有路径证据；仅 2 个空/删除正文 tombstone 保持删失 |
| 真实外部运行 | 一次明确授权的合格 DRAFT 已确认发布；请求 1、发送 1、确认 1，随后硬重锁 |
| 教育效果证据 | 0；R24 与 R72 都只是非删失、非因果的发布后描述性观察，不能单独支持促进效果或因果结论 |

## 4. 既有真实只读快照

以下是形成于 L3 之前、在 2026-08-02 复核的去正文历史聚合快照，只保留为真实运行
基线，不是 RC12 或新代码的验收结果：

| 对象 | 审计值 | 解释 |
| --- | ---: | --- |
| ScheduledInvocation | 14 completed / 2 failed | 有真实运行与失败证据，不等于长期 soak |
| CourseScanRun | 15 completed / 1 running | running 项不能写成成功 |
| AutonomyDecision | 845 | 0 DRAFT、0 WAIT、259 ABSTAIN、586 YIELD |
| SemanticRealization | 0 | 更新前真实主链未到 DRAFT |
| AutonomyPolicy / ExecutionPermit / ExecutionAttempt | 0 / 0 / 0 | L3 前历史基线；不是当前后验值 |
| ProximalOutcome / ReviewEvent | 0 / 0 | L3 前历史基线；不是当前后验值 |
| DecisionTapeEntry | 928 | 真实只读链已有追加式结构证据 |

以下 2026-08-02 one-shot worker 数据是 RC8/RC9 历史快照，继续按三层口径保留：

- 扫描：7/7 栏目、64/64 详情、391 个观察事件、0 个新事件、0 个详情失败；
- World：391 个事件、64 个线程、93 个事件参与者、302 条互动边、5 个结构缺口；
- Graph v2：253 个节点、773 条边、72 个明确 learner 角色节点；
- 38 个评论范围仍不完整，平台服务端在这 38 个范围重复返回第一页，并另有 1 次评论
  内容删失；当前只能标为 `visible_only/censored`；
- 因全课覆盖仍为 `censored`，学习者网络继续只按 lower-bound 解释。

RC8 期间先在源码运行面、再在最终 release 镜像形成治理绑定槽位；唯一 30 分钟任务
随后形成真实 `codex_automation` 回执。RC9 release 又完成一次安全 `local_cli` 到期
槽位。当前七个 due 槽位均为
`due=1 / executed=1 / failed=0`，生命周期正常结束，编辑器写入和发布尝试均为 0，
租约正常清除。当前数据库共有 10 条终态安全唤醒回执：5 条 `local_cli`、5 条
`codex_automation`；版本分布为 RC7 1 条、RC8 6 条、RC9 3 条，全部 completed，累计
`due/executed/failed=7/7/0`、0 编辑器写入、0 发布，`containsForumText=false`。
首条自然 `codex_automation/v1-rc9` 回执为 exit 0、`due=0`，证明切换与幂等无到期
终态。2026-08-02 21:46 UTC 的一次
Codex 任务因基础设施/网络问题在安全 worker JSON 与数据库回执形成前退出，未伪造
成功、未自动重试；下一计划周期正常完成。

开发库清理在带哈希备份后删除了 181 条已知合成记录和 7 条误入的 manifest-only
记录。当前保留 3 个 manifest 与 3 个 schedule，仅真实课程各 1 个 enabled；这项
清理不改写真实运行、L3、outcome 或事故证据。

客户端已移除会把首个分页失败放大到后续线程的全局 breaker，并证明每个线程独立、
有界、fail closed；真实复验仍有 38 个线程各自重复返回第一页。前端公开代码与
JSON 请求契约均指向同一分页参数，因此当前剩余删失是平台服务端边界，不能由客户端
伪造 complete。解除边界必须取得稳定服务端 cursor/offset/snapshot、终止/total 证明与
稳定 ID，或由可信 companion 同时证明独立分页、稳定 ID、父链闭合、零分页失败和
权威终止；既有 Playwright、浏览器诊断、legacy scan/extract 与 transport smoke 都不足。

2026-08-03 的 RC12 当前快照另行追加，不倒改上述历史：

- 关机中断的 RC11 invocation 由 worker 回收 1 条过期租约；旧 wake receipt 标为
  `abandoned`，同一槽位恢复完成，没有删除或改写历史；
- 实测根因为评论先完成而详情课程绑定响应晚到，旧实现抛出
  `COURSE_ID_UNVERIFIED`；RC12 显式等待详情响应，只对“尚未观察到绑定”做一次有界
  重试，课程/线程/分页结构不匹配继续 fail closed；
- 修复后的无数据库探针与 RC12 持久化到期槽都恢复 38/38 个历史 API 位置漂移范围，
  形成 38 条稳定 ID、父链闭合、零分页失败和权威终止的 companion 回执；
- 最新扫描为 7/7 栏目、64/64 详情、1,578 个观察事件、0 个目标失败；只有 2 个
  空/删除正文 tombstone，因此 `complete=false` 与 Graph lower-bound 仍诚实保留；
- 最新 Graph v2 为 408 个节点、2,103 条边、72 个明确 learner 角色节点；
- RC12 到期槽为 `due/executed/failed=1/1/0`。同时发生的一次旧 RC9 自动唤醒因
  RC12 正持有课程租约而安全 skip，证明并发让位；
- 首条自然 `codex_automation/v1-rc12` worker 虽 completed/exit 0，其外层任务曾在 300 秒
  误超时；底层进程在约 14 分 47 秒后正常落终态。将 timeout 改为 20 分钟并移除自建
  stdout 解析后，随后两轮自然 worker 分别约 13 分 30 秒和 13 分 38 秒 completed/exit 0，
  外层任务分别约 15 分 51 秒和 15 分 39 秒 completed，并直接捕获安全 JSON，单轮
  `due/considered/executed/failed=1/1/1/0`；
- 当前 23 条 wake receipt 中 22 条 completed、1 条 shutdown-abandoned，自动/本地来源为
  13/10；累计 `due/considered/executed/skipped/failed=17/17/16/1/0`、恢复租约 1、
  结果回流 1，编辑器写入与发布尝试始终为 0。封闭 JSON 正确，框架追加 UI 指令的限制
  保持开放。

L3 完成后的去正文后验增量：

| 对象 | 当前后验 | 解释 |
| --- | ---: | --- |
| ExecutionStageReceipt | 1 used | 写入 1、清空 1、发送 mutation 0、正文不持久化 |
| ExecutionPermit | 1 used / 0 open | 绑定单一目标、版本、内容、policy 与幂等键 |
| ExecutionAttempt | 1 confirmed_published | requested 1 / sent 1；远端结果哈希已记录 |
| ProximalOutcome | R24 observed / R72 observed | 两窗都未观察到首个外部回复或作者返回，深度增量均为 1、新作者均为 0，均非删失；仅为非因果描述 |
| CourseOperationGovernancePolicy | 1 active SHADOW | 绑定精确 Manifest，策略哈希可重算，DB trigger 禁止 UPDATE/DELETE；它不是发布授权 |
| worker / invocation | 23 条终态回执；RC12 连续自然端到端已验证 | 22 completed / 1 shutdown-abandoned；累计 due/considered/executed/skipped/failed=17/17/16/1/0，恢复 1、回流 1，编辑器/发布为 0；20 分钟 timeout、worker/外层双终态和直接 stdout 已验证；封闭 JSON 正确，但框架仍追加 UI 指令 |
| 活跃真实 Policy | 0 | 一次性策略已撤销并 emergency halt |
| 发布开关 | manifest=false / forum setting=false / global hard lock=true | 当前不能继续发送第二次 |

治理策略、生命周期与外键对齐 migrations `20260802130000`、`20260802140000`、
`20260802150000` 已在开发库长度与 SHA-256 备份后使用 `prisma migrate deploy` 应用；
迁移后 SQLite integrity/外键、schema diff、既有 ID 集与部分唯一索引核验通过，18/18
migrations 到位，先前 `InterventionTask`/`PublishLog` 外键动作 drift 已消除。先前
1 个 high `tick_failed` 长期事故因缺少可验证根因/修复记录仅标记为 acknowledged，
原事故与失败 invocation 证据保持不变；当前 open high/critical 为 0，但 active
unresolved high/critical 为 1。

## 5. 能力状态矩阵

| 产品能力 | 当前证据 | 状态 |
| --- | --- | --- |
| 显式课程绑定、URL/origin 边界 | manifest 解析、哈希绑定、真实 tick | 真实只读路径已验证 |
| invocation 幂等、lease、heartbeat、恢复 | 数据库与集成测试 | 本地验证；长期 soak 未完成 |
| one-shot SHADOW worker | due 扩窗、租约恢复、manifest/hash/槽位/治理绑定、严格状态/退出码、`governanceFiltered` attention 与未恢复 companion failure；历史 `v1-rc12-release` 保留 | RC13 源码恢复轮与独立 `v1-rc13-release` 真实只读轮均 completed/exit 0；runtime receipt 为 `runtimeReady=true`，38 个 companion 范围恢复且 0 编辑器/发布；自动任务仍暂停，框架 UI 指令限制与连续 soak 仍开放 |
| 课程运行治理 | 追加式策略版本、单 root、as-of 选择、Manifest 上限收紧、DB 不可变 trigger、同步/worker/direct tick 三重 fail closed、只读页面/API与显式 lifecycle CLI | 1 个 active SHADOW baseline 持续约束每个真实槽位；RC9 历史七个槽位与后续 RC12 槽位均有绑定证据；CLI 默认 preview、`--apply` 仅写本地治理 DB，页面/API 不提供 mutation |
| 全课程扫描、游标和目标隔离 | 7/7 栏目、64/64 详情；UI 原生 companion 已恢复全部 38 个历史 API 位置漂移范围，零 companion 失败；仍有 2 个空/删除正文 tombstone | 稳定 ID、父链闭合、零分页失败与权威终止均已验证；课程事件世界继续按 tombstone 边界标记 lower-bound |
| Event Ledger、World、Graph v2 | 真实快照、回放与哈希 | 真实只读路径已验证 |
| 事件合法修订 | 新 migration、分类器与 cutoff 数据库测试 | 已实现且本地验证；真实历史 incident 未重判 |
| learner 位置 | 最新 Graph 为 408 nodes / 2,103 edges / 72 learner nodes，并保留 lower-bound 门控 | 真实只读路径已验证；不从删失网络外推 PageRank/k-core 或课程总体效果 |
| CandidateSet、角色/历史/预算证据 | 当前真实 tick 已持久化 | 真实只读路径已验证 |
| 瞬时语义证据 | 去正文回执、绑定哈希、单元/集成测试与 L3 持久 DRAFT | 已实现；本地与单次真实执行路径验证 |
| DRAFT + Intent/MoveSpec | 自然 DRAFT 测试与机械候选选择 | 已实现；单次真实执行路径验证 |
| DRAFT-only renderer | tick 已启用，generator 不可用时确定性回退 | 已实现且本地验证；当前无在线模型调用 |
| 自治同链重读 | 第二次只读观察与 EXECUTE/YIELD/REVIEW 回执 | 已实现且本地验证；不授权 STAGE |
| 认证 STAGE | v2 grant、签名、nonce、真实编辑器逐字回读/清空、零 mutation 回执 | 已实现；一次真实路径验证 |
| AuthorizedActionPlan / connector 重读 | 不可变计划绑定 decision、Manifest、当前治理、策略与 Connector；计划不授权发送；签发与真正发送边界均重读并 fail closed | 已实现且本地集成验证；未触发真实 Connector、STAGE 或 mutation |
| AutonomyPolicy / Permit | 当前策略选择、一次性消费、账户租约、发送前重核验、发送后历史绑定结算与重锁 | 已实现；一次历史真实路径及本轮本地故障/恢复验证，当前生产开关保持关闭 |
| AUTOPILOT_CANARY | completed SHADOW 后的显式 dispatcher；false Permit、`simulated_no_write` Attempt、严格零写回执及中断恢复 | 已实现且默认关闭；只在测试库验证，不是 AUTO 模式或真实课程运行证据 |
| AUTO Committer | 发送前记账、受作用域写锁、精确一次 API mutation | 已实现；一次 confirmed_published |
| 发布核对与恢复 | 唯一新增主评论核对、最多三次只读恢复、unknown 禁止盲重试 | 核对真实验证；恢复分支本地验证，本次未触发 |
| R24/R72 outcome | 目标线程 fact/root 证据、只读 preflight、ready-only CAS、证据来源与 Decision Tape | R24 与 R72 均已 observed、非删失；均不作因果解释 |
| 长期审核与 PI 治理 | incident CAS 状态机、可信同源 JSON API、确认/解决操作、ReviewEvent、Decision Tape、不可变课程运行策略链与 active-visible operator scope | 默认当前态只展示 active-visible course；disabled/fixture 策略、事故、运行和审核历史仍保留为审计证据；当前 active unresolved high/critical=1，图形编辑控制台不是运行前提 |
| CourseWorld Scenario Lab | P3A 正式聚合、K=1/3/5 确定性回放、版本化 spec/envelope/receipt、OASIS WP2A 合成协议参考预演、AgentSociety 适配契约 | v1 与 WP2A 已通过正式工件、API、侧车、浏览器和完整 Workbench 回归；原生 OASIS 与 AgentSociety 运行仍待后续，只作研究侧回放，不进入在线决策 |
| 真实发布/通知 | 一次授权发布已完成；硬锁与两个布尔开关已恢复关闭 | 产品具备单动作能力；持续外部效果有意未激活 |
| 教育效果 | 无真实干预和合格对照结果 | 未实现/无证据 |

## 6. 不可变边界

- 当前 `realPublishEnabled=false`，全局写锁为 true；
- `AUTOPILOT_CANARY` 默认关闭，只能生成 false Permit 和 `completed_no_write` Attempt；它不是
  AutonomyPolicy、ActionPlan、STAGE、真实发布许可或长期 soak 资格；
- CourseOperationGovernancePolicy 只收紧调度/SHADOW 上限，不是 AutonomyPolicy、Permit
  或发布授权；历史版本不可原地更新或删除；
- 本次授权、Policy、Permit 和 STAGE 回执均已消费，不授权第二次发布；
- S1 的 `EXECUTE` 不是 STAGE 或发布许可；
- 非 DRAFT 不调用 renderer；
- renderer 和决策持久层不保存论坛正文；
- 新事件修订不倒改旧 cutoff；
- P3/P4 冻结证据不因产品代码前进而改写；
- Scenario Lab 的 observed / replay / synthetic 三类证据不可混写；离线或合成 run 不得
  创建 R24/R72、CandidateSet、Permit、真实 Decision Tape 动作或发布结果；
- Graph 只作描述性过程证据，删失网络不计算 PageRank/k-core；
- 单次确认发布不得表述为教育效果、长期可靠性或课程级 AUTO 已激活。

## 7. 当前唯一下一纵向切片

任务 ID：`AUTONOMY-V1-RC13-QUALIFIED-AUTOMATION-AND-LONG-SOAK`

本轮 ActionPlan/Permit 加固与默认关闭 canary 已作为该路线的本地演练基础完成，但不改变
以下外部准入顺序，也不授权恢复自动任务：

1. 源码 RC13/v2 契约、真实课程原槽恢复与 active-visible operator scope 已完成；三条
   2026-08-09/10 事故均保留原证据并追加 resolved 转移，但另有 1 条 active high
   `tick_failed` 仍为 acknowledged，必须在有可验证依据后 resolve，不能以 open=0 冒充
   事故清零；
2. 可运行 `v1-rc13-release` 已形成 v2 runtime receipt，并以真实只读 `local_cli` worker
   核验 38 个 companion 范围、零写入和完整终态；自动任务仍暂停，因此它只是可核验的
   原子切换候选。真正切换/恢复会开始周期性真实课程读取并可能触发 failed-only 通知，
   必须先取得用户对该外部运行的明确决定；旧 RC12 自动化镜像继续暂停，不允许沿用旧
   runtime label；
3. 保持 38/38 companion 恢复能力和严格完整性校验；对 2 个空/删除正文 tombstone
   继续使用 `visible_only+censored / graph lower_bound`，不伪造不可见正文，也不计算
   PageRank/k-core；
4. 只有 unresolved high/critical 清零并获准恢复后，才以
   `codex_automation/v1-rc13` 连续积累至少 72 小时与 144 个 completed 周期，并验证游标、
   预算、幂等、认证失效、重复唤醒、重启和 unknown/reconcile；
5. 当前 active open high/critical 为 0、acknowledged high/critical 为 1，因此 active
   unresolved high/critical 为 1、readiness=`blocked`；后续任何
   attention/failed/stale/governance-filter 也会阻断资格；
6. 只有 readiness 达到 `qualified`，且 failed-only 通知送达与成功轮 UI 抑制取得外部
   可观测证据后，才评估成熟 v1 Definition of Done。

并行研究侧工作包不替代上述主运行切片，也不形成新的开发停止条件：

1. `SCENARIO-LAB-WP2B-OASIS-NATIVE-SIDECAR`：在现有 WP2A 协议参考预演之外，把去身份
   课程事件图拓扑、课程角色 archetype 与有限动作集编译给原生 OASIS，接通原生
   action/feed 循环并记录 wall-time、资源与成本回执；先做小规模固定种子一致性实验，
   当前 `oasis_contract_reference_v1` 不可替代该工作包，也不作为分布校准证据；
2. `SCENARIO-LAB-WP3-AGENTSOCIETY2-EXPERIMENTS`：将相同 ScenarioSpec 映射为
   AgentSociety 2 Experiment，接通 trace、replay、checkpoint/resume 与 Ray 并行，并做
   跨运行时契约一致性测试；
3. `SCENARIO-LAB-WP4-PROSPECTIVE-CALIBRATION`：积累多课程真实近端结果后再评估只读
   `policy_hint`。在校准前，Scenario Lab 继续只读，不进入在线 CandidateSet 或 Resolver。

当前不再需要第二次真实发布来证明 L3 代码能力。任何新外部动作都需要新的有效策略、
新 Permit、全套重读/预算条件和新的明确授权；默认状态保持冻结。

## 8. 运行与验证

```powershell
npm run prisma:migrate
npm run autonomy:governance -- baseline --course bnu-test --version <new-version> --valid-from <iso> --valid-until <iso> --expected-manifest-hash <sha256>
npm run autonomy:governance -- pause --course bnu-test --version <new-version> --transition-key <key> --reason-code <code> --effective-at <iso> --expected-manifest-hash <sha256> --expected-governance-hash <sha256>
npm run autonomy:tick -- --course bnu-test --mode shadow
npm run autonomy:worker -- --limit 1 --wake-source local_cli --runtime-version v1-rc13
# 默认关闭；仅本地零写演练时显式传入 realPublishEnabled=false 的精确策略版本
npm run autonomy:worker -- --limit 1 --autopilot-canary-policy-version <false-policy-version>
npm run autonomy:soak-readiness
npm run autonomy:release
npm run autonomy:graph-status -- --course bnu-test
npm run verify:agent-guidance
npm run type-check
npm run lint
npx tsx --test --test-concurrency=1 tests/unit/scenario-lab-runtime.test.ts tests/unit/scenario-lab-evidence.test.ts tests/unit/scenario-lab-route.test.ts tests/unit/scenario-lab-ui.test.ts tests/unit/scenario-lab-oasis-sidecar-transport.test.ts tests/unit/scenario-lab-oasis-preview-service.test.ts tests/unit/scenario-lab-oasis-preview-route.test.ts tests/unit/scenario-lab-oasis-preview-ui.test.ts
npm test
npm run build
npm run autonomy:l3 -- preflight
```

教师与课程运营者的日常产品入口为 `http://127.0.0.1:3000/workbench`；
CourseWorld 情景实验入口为 `http://127.0.0.1:3000/scenario-lab`；
`/autonomy` 保留为运行治理与深层证据入口，`/platform` 和 `/review/live` 是真实页面
诊断/兼容路径，`/review` 是冻结合成研究复现。本次工作台增量 262/262 项测试通过并
完成 32 个页面/路由的独立生产构建。历史 `v1-rc12-release` 归档仍保留当时 460 项测试、
18/18 migrations、30 个页面/路由构建和 340 个受控文件逐字节审计，不以本次增量倒改。
修复后的无数据库探针与持久化到期槽都恢复 38/38 个 companion 范围，
历史连续两轮自然 RC12 worker 与 Codex 外层均已 completed；RC13 源码恢复轮和独立
`v1-rc13-release` 真实只读轮也均 completed。release finalizer、574 项单元测试、94 项
TypeScript 数据库集成测试、3 项 Python migration 集成测试、type-check、lint 与 33 个
页面/路由的生产构建通过；但目标 `codex_automation/v1-rc13` 仍无回执，且 active
acknowledged high 使 readiness 为 `blocked`。自动任务保持暂停；这些单轮成功及仍开放的
框架 UI 指令限制不能替代长期可靠性或教育效果证据。
