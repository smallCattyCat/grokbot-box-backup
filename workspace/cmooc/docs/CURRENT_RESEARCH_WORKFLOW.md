# 当前研究工作流

- 文档更新：`2026-08-30`
- 状态：`CURRENT RESEARCH EVIDENCE INDEX / FROZEN RESULTS PRESERVED`

> 本文是冻结研究证据、方法边界和复现入口的当前说明。产品里程碑与唯一下一纵向
> 切片以 [产品当前状态](PRODUCT_CURRENT.md) 为准，完整开发顺序以
> [自主产品开发总计划](AUTONOMOUS_PRODUCT_MASTER_PLAN.md) 为准。旧阶段中“后置
> 持久调度/真实适配”的判断不再约束产品路线；已发布研究证据仍保持不可倒改。

> 后继研究的问题选择、贡献层级和反防御性解释以
> [课程共同体促进研究纲领 R1](COMMUNITY_FACILITATION_RESEARCH_DIRECTION_R1_2026-08-30.md)
> 为准；本文继续只承担既有证据含义与复现入口。P3A v1 在形成时使用 2024 开发、
> 2025 time-holdout 的历史设计保持冻结；2025 已在 2026-08-30 queue-shadow 结果中打开
> 并用于后继方向判断，今后只作为已暴露的历史外部基准，不再称为未触碰确认集。

> 2026-08-24 产品运行补记：历史 RC12 自动任务现为 `PAUSED`，旧 release 因缺少
> `governanceFiltered` 传播不得恢复；RC13 源码真实恢复轮与独立 `v1-rc13-release` 的
> `local_cli` 真实只读轮均已完成，runtime receipt 为 `runtimeReady=true`，38 个 companion
> 范围恢复且零编辑器/发布。但 active unresolved high/critical=1，目标
> `codex_automation/v1-rc13` 仍无回执，因此长期 soak readiness 仍为 `blocked/not started`。
> 这不修改下述冻结研究结果，也不新增教育效果证据。

## 研究基线与当前产品接口

P4A、P4B、P4C-1、P4D-1 和 P4F-lite 继续保持冻结。冻结保护既有协议、fixture、
回执、统计口径和适用范围；它不阻止后续产品建设，也不允许后来的产品文档把合成
证据倒写成真实平台结果。

当前产品已经超过研究阶段的 `/review` 黄金路径和 `/platform → /review/live`
页面原型：默认 operator 页面已把 disabled/fixture 历史排除在当前态之外，同时保留其
数据库审计证据；`autonomy:tick` 已把真实课程扫描、ObservedEventLedger、Course Event
World、Graph v2、CandidateSet、服务器角色/历史/预算证据、ABSTAIN/YIELD 和
Decision Tape 接成真实只读主链。

当前工作树进一步把事件 observation revision、瞬时去正文语义证据、自然 DRAFT、
Intent/MoveSpec、DRAFT-only renderer 和第二次只读重读接入自治 tick，并完成本地
纵向验证。此后 L3 又在一次明确授权下完成真实认证 STAGE、单动作 Policy/Permit、
production Committer、写后唯一核对、一次确认发布和 R24/R72 建窗，并立即恢复硬锁。
2026-08-02 又完成一次无发布的 one-shot SHADOW worker 巡检，并用同一扫描的目标线程
完整 fact 与 root observation 对 R24 做 ready-only 核对。rc8 随后加入追加式、不可变
的 `CourseOperationGovernancePolicy`，在运行写入前精确绑定 disk/DB Manifest、schedule
与 invocation；RC9 又补齐 baseline/pause/resume/revoke/emergency-halt/rotate 追加式
生命周期。2026-08-03，RC11 关机中断留下的过期租约被正常回收；RC11 随后暴露 3 个
companion 详情绑定竞态失败并未获提升。RC12 显式等待详情绑定，只对“尚未观察到绑定”
做一次有界重试；无数据库真实探针与持久化到期槽都恢复 38/38 个历史 API 位置漂移
范围。最新扫描为 7/7 栏目、64/64 详情、1,578 个事件，Graph 为 408 nodes / 2,103
edges / 72 learner nodes；仅 2 个空/删除正文 tombstone 保持 lower-bound。

唯一 30 分钟 Codex 任务历史上使用 `gpt-5.6-luna`、reasoning `max`、failed-only、
`wake-source=codex_automation`，并曾指向 RC12 release / `runtime-version=v1-rc12`。
首条自然 RC12 worker 回执虽 completed/exit 0，其 Codex 外层曾在 300 秒误超时；底层进程
仍持有有效租约并在约 14 分 47 秒后完成。将 shell timeout 改为 20 分钟、移除自建 stdout
解析后，随后两轮自然 worker 分别约 13 分 30 秒和 13 分 38 秒 completed/exit 0，外层任务
分别约 15 分 51 秒和 15 分 39 秒 completed，均直接捕获安全 JSON，单轮
`due/considered/executed/failed=1/1/1/0`。当时 23 条终态回执为 22 completed /
1 shutdown-abandoned，自动/本地来源为 13/10，累计
`due/considered/executed/skipped/failed=17/17/16/1/0`、recovered=1、reconciled=1，
编辑器写入和发布均为 0。第二轮封闭六键 JSON 本体正确，但 Codex 自动任务框架仍追加
UI 收件箱指令；它未触及课程平台，应用仍配置 failed-only，提示词层无法消除此框架行为。
该任务当前保持 `PAUSED`；上述 RC12 历史回执不能替代 RC13 soak。
R72 已通过 ready-only 路径 observed。

这项产品实现不修改 P3/P4 冻结结果，也不自动新增教育效果证据。研究文档中的合成
Intent/MoveSpec、草稿、重读和暂存结果仍只按原适用范围解释；本地 S1 DRAFT 也不能
写成真实平台干预或开放式语义质量结论。L3 的一次确认发布只能作为产品执行路径
证据。历史 L3 的全局真实 attempt=1 与当前 SHADOW invocation 的 editor/publish=0
必须分层；界面最近运行按 invocation 作用域计数。R24 与 R72 的 observed 记录都只是
发布后非删失、非因果的描述性过程结果，不能写成促进效果、学习效果或因果结果。

当前产品事实与下一切片见 [产品当前状态](PRODUCT_CURRENT.md)；产品机理见
[产品机理与当前完成状态](PRODUCT_MECHANISM_AND_CURRENT_STATUS.md)；自治主链与
兼容接口边界见 [真实 cMOOC 自主促进运行内核 v1](LIVE_FACILITATION_RUNTIME_V1.md)。

## 2026-07-31 L3 单动作产品证据（非冻结研究结果）

- 一个机械选定的持久 DRAFT 完成真实 STAGE：编辑器写入 1、回读匹配、清空 1、
  外部 mutation 0；
- 同一目标、版本、事件前缀、内容、policy 与幂等键签发并消费 1 个 Permit；
- production Committer 请求 1、发送 1，写后 API 唯一核对为
  `confirmed_published`；
- R24 与 R72 各建立一个 pending 观察窗口；
- active real policy 与 open Permit 均恢复为 0，发布开关关闭，全局硬锁开启；
- 归档只保存哈希、状态和计数，不保存正文、身份、凭据或平台 ID。

该记录属于历史全局 L3 产品运行与安全工程证据，不进入 P3/P4 冻结结果，也不改变
既有 RQ 的样本、指标、Gate 或效应解释。rc8 当前 focal invocation 的 0 写入计数不
删除或覆盖这条历史事实。

## 2026-08-02 R24 产品观察证据（非冻结研究结果）

- worker 先恢复过期租约，再从扩大后的 due 窗口跳过失效测试别名并执行
  `bnu-test / SHADOW`；
- tick 为 `completed_partial`，真实发布与编辑器写入计数均为 0，代码硬锁保持开启，
  active real policy 与 open Permit 均为 0；
- 平台服务端在 38 个评论范围重复返回第一页，因此全课覆盖只能是
  `visible_only/censored`；但 R24 目标线程在同一扫描中具有唯一 canonical
  complete fact、版本绑定和 admissible root observation；
- ready-only observer 只接收预检为 ready 的 R24 outcomeId，R72 未到期且保持
  pending（due `2026-08-03T12:47:59.120Z`）；证据漂移时该路径只等待，不自动删失；
- R24 记录为 `observed`：作者未返回、首个外部回复为空、回复深度增量 1、新作者 0；
- 这些字段只描述发布后事件前缀，不能识别干预造成了何种变化，也不进入冻结研究
  结果或教育效果证据。

## 2026-08-02 rc8 课程运行治理与 SHADOW 产品证据（非冻结研究结果）

- governance migration `20260802130000` 在开发库 SHA-256 备份后通过
  `prisma migrate deploy` 应用，达到 16/16 migrations；策略表和 UPDATE/DELETE 拒绝
  trigger 已核验；
- 1 个 active SHADOW baseline 绑定精确 Manifest，策略哈希可重算；同步、worker 与
  direct tick 对缺失、漂移、暂停、撤销、过期和 emergency halt 均 fail closed；
- 源码运行面和最终 rc8 release 先完成 2 个 `local_cli` 槽位，定时任务再自然形成首个
  `codex_automation` 槽位；3 个真实 SHADOW due 槽位都 schedule/governance 双绑定，
  均为 `due=1 / executed=1 / failed=0`，合计 1 DRAFT、8 YIELD、1 条去正文
  SemanticRealization，编辑器与发布均为 0；
- 当前仍有 1 个 open high 长期事故，属于产品治理状态；它不构成教育效果、限制清单
  或冻结研究结果；
- 247 单元、53 TypeScript 数据库集成、1 图迁移集成、130 研究测试（431/431）、
  type-check、生产构建、浏览器 E2E 与独立制品审计通过；这些只证明产品实现与运行
  边界，不自动成为研究结论；
- 已知 `InterventionTask`/`PublishLog` 外键动作 drift 与本次治理 migration 无关，需
  单独迁移；在此之前开发库只用 `migrate deploy`，不得用 `migrate dev` 自动改写。

该 rc8 记录不修改 P3/P4 的样本、指标、Gate、效应或适用范围，也不把治理 baseline、
SHADOW DRAFT、Graph 指标、测试数或页面状态解释为真实干预成效。

## 2026-07-29 真实页面 shadow 证据（兼容切片）

`/platform → /review/live` 保存一条较早但仍有效的真实页面证据：

1. LIFT-1 核验课程来源、路径、课程身份、课程壳、分区、卡片和零写边界；
2. 真实卡片只保存本机 HMAC 别名，不保存标题、正文、作者或平台 ID；
3. Chrome/Computer Use 只执行导航、观察、切换、打开、滚动和重读；
4. 动作后置条件未知时封存 `source_censored`，不自动重放；
5. 只有结构证据时不生成 Intent、MoveSpec 或草稿；
6. 一次经明确授权的测试目标完成编辑器草稿写入与回读，没有点击发布或使用提交
   快捷键；
7. 因缺少同标签页网络守卫，该回执严格标为
   `TRANSPORT_SMOKE_DRAFT_VISIBLE_NOT_SUBMITTED`，不是认证 STAGE。

这条证据支持真实页面可达性、故障处置和编辑器传输可执行性；它不证明已经接入
`autonomy:tick`，不证明真实干预或教育成效。完整说明见
[Computer Use 真实平台 shadow 纵向切片](COMPUTER_USE_LIVE_SHADOW.md)。

## P4D-1：已完成的产品黄金路径

`/review` 现在保留为合成研究复现入口。研究者可在其中完成：

1. 打开固定 `as-of` 合成候选，阅读为何此时、为何该对象及既有 P3A 预算依据；
2. 查看合法 `Intent + MoveSpec` 和由版本化合成输入形成的确定性草稿；
3. 接受原稿、保存修改或拒绝动作；
4. 在 `%LOCALAPPDATA%\cmooc-research\p4d1` 保存去正文、只含哈希的本地回执。

产品演示入口在不改变 P4D-1 冻结研究证据的前提下，增加了一个合成
“提交前重读—让位”切片：研究者可选择稳定目标、目标版本变化或决策后真人回应，
再提交接受、修改或放弃决定。服务端复用 P4F-lite 的
`SyntheticTimelineForumAdapter` 规则，在保存决定前重新观察事件和目标；稳定时只
记录 shadow 决定，真人回应时撤回并让位，目标变化时撤回并要求重新审阅。新增
侧车回执记录请求决定、最终处理、让位原因、事件计数、审阅时间和稳定哈希，仍不
保存正文、不访问真实论坛、不产生外部写入。

固定 P4D-1 fixture 是时点/预算语义兼容的合成产品案例，不是正式 P3A
scheduler action 的候选级文本配对。P3A 的 RQ2 证据继续只由正式 snapshot 和
benchmark 支持。

固定复现命令为：

```powershell
npm run p4:golden-path:audit
```

它用固定真实时钟、严格 `as-of` 和
`fixtures/p4d1/golden-path-resource-connection-v1.json` 从证据引用复跑到
review receipt，并输出
`evidence-v1/rq3-trace-evidence.json`。该证据只支持 RQ3 的实施链可追溯、
可复跑与规则一致；RQ2 继续复用 P3A benchmark，不宣称新增预算效果。桌面和
375px 浏览器路径已验收，网络写入和真实论坛写入均为零。

草稿的文本输入必须来自 synthetic/versioned fixture，或明确携带
`contentRevisionStatus`。历史 `final_export_revision_unknown` 正文只可证明流程
可行性，不能作为严格 `as-of` 文本或语义判断证据。

P3A snapshot/replay 回答有限注意力下“何时介入”，P4 协议与黄金路径回答“如何把
判断转为可审阅行动”。P4F-lite 只对预声明合成情境给出规则级实施保真结果，
不替代开放式语义质量评价。代码行、测试数、manifest 或控制入口本身不构成
研究结果。
自主产品已从真实课程 SHADOW、增量事件账本与课程图、Intent/MoveSpec/草稿、发布前
重读推进到一次历史 L3 单动作执行、R24/R72 描述性观察、不可变课程运行 baseline、
RC12 companion 38/38 恢复和连续自然 RC12 worker/Codex 外层双 completed 终态。RC13
自包含 release 已形成 `runtimeReady=true` 回执，并以真实只读 worker 复验 38 个 companion
范围与零写入；下一阶段先为 active acknowledged high 补足可验证根因/修复依据，获准
恢复后再积累真实自动周期证据，并在应用层能够控制
成功轮 UI 指令时复验 failed-only 行为，同时完成恢复/重启、unknown/reconcile、2 个
tombstone 的 lower-bound 边界维护和长期 shadow soak；
不是立即重复发布。更多人格角色和逐层审批仍然后置；
stdio/MCP 只在出现真实第二消费者时建设。产品切片可独立完成，不要求每一步都重新
包装为论文证据。

## P4F-lite：已完成的三情境规则级保真比较

P4F-lite 复用 `MockForumAdapter` 与 `SyntheticTimelineForumAdapter`，各运行
稳定目标、目标版本变化和决策后真人回应三个预声明情境。固定 rubric 位于
`fixtures/p4f-lite/fidelity-rubric-v1.json`，具名复现命令为：

```powershell
npm run p4:fidelity:audit
```

固定审计共运行 6 个实例：6/6 完成；功能、具体动作、目标、确定性草稿规则和人工
决定保真率均为 1.0；其中 4 个变化情境触发拒绝/人工接管。执行调用、真实论坛
写入和结构化证据正文泄漏均为 0。去正文证据写入
`%LOCALAPPDATA%\cmooc-research\p4f-lite\evidence-v1\three-scenario-fidelity.json`。

该结果只支持 RQ3 在两个合成 adapter、三个预声明情境中的规则级实施保真，不支持
真实学习效果、真实论坛可靠性或开放式语义质量结论。

## P3A：离线 intervention decision snapshot

P3A 时点证据基础使用一条完全本地的调度验证路径。它从全体 12,627 个主帖构造主帖后 22 小时的 `decision_snapshot_v1`，结果观察到主帖后 86 小时；时点由 2024 外部首次回应的 P75/P90 冻结，2025 只作时间留出。`scheduler replay v2` 再按显式 30 分钟 tick、一个 tick 的候选 TTL 和每日预算回放，避免一次看到整日未来候选。候选若在动作 tick 前已经获得外部回应，会按真实事件时钟撤回；若来源数据未完整观测到 tick，则按行政删失移出。TTL 在 `decision_at + TTL <= tick_at` 时到期，因此每个候选只有一次调度机会。标签指标只使用整日结果窗完整的日期，工作量与作者暴露仍覆盖全部回放动作。

```powershell
npm run research:decision -- audit   # 只读，不生成产物
npm run research:decision -- all     # 构建、时间审计、replay、冻结60条选择
npm run research:decision -- status
npm run research:decision-review -- check --json
```

默认产物位于：

```text
%LOCALAPPDATA%\cmooc-research\p3a\decision-snapshot-v1
```

该路径不调用本地或在线模型，不读取 API token，不执行论坛发布，也不修改 `01_原始数据`。旧 `trigger_snapshots` 不作为上线决策数据。构建阶段用机器契约、Python 和独立 SQL 三路检查时点边界；正式检查为 0 差异。详细字段见 [intervention decision snapshot v1](DECISION_SNAPSHOT_V1.md)，回放与指标见 [scheduler replay v2](SCHEDULER_REPLAY_V2.md)。

首批人工 decision-reference 只在用户实际准备编码时启动：

```powershell
npm run research:decision-review -- serve --coder-id coder_a
```

工作台只绑定 localhost，正文仅在服务端与当前页面易失内存中显示，页面隐藏未来结果与抽样层，输出只有匿名稳定键、三项标签和审计元数据。抽样成员选定后用只依赖匿名 `snapshot_key` 的稳定散列盲化排序，再分配 `DR001..`；manifest 冻结成员与顺序摘要，P3A 重跑和 P3B `check/serve` 均会复核。旧版空标签集合可保持成员不变做一次盲序迁移，已有任一标签时拒绝改排。完成冻结的 60 条后停止，不自动扩批。见 [decision-reference v1 本地标注台](DECISION_REFERENCE_V1.md)。

## P4A：P3A 证据到促进协议的只读桥接

P4A 已实现十类 JSON Schema 2020-12 协议对象、TypeScript 类型、运行时严格校验、
规范哈希和教育语义不变量。P3A 桥接只投影匿名稳定键、决策时点、特征哈希与时间
契约；结果窗字段不进入协议证据引用，因而未来结果后缀变化不会改变既有引用哈希。

```powershell
npm run test:p4-protocol
npm run p4:protocol:audit -- --json
```

审计固定检查 22/86 小时真实时钟、逐行 as-of 边界、2024 开发/2025 时间留出、
上游时间审计和无正文边界。命令只读本地 P3A 正式产物，只输出聚合摘要，不调用
模型或网络，也不产生论坛写操作。完整契约见 [P4A 可执行促进协议 v1](P4_PROTOCOL_V1.md)。

## P4B：ForumAdapter 可验证适配层

P4B 已实现统一 adapter contract、registry、cMOOC API、mock、cMOOC 浏览器严格
只读诊断和第二合成 timeline adapter。四个 adapter 共用 conformance suite，覆盖
严格输出字段、观察时钟、完整 ThreadRef 签发、目标版本、分页、异常、回执和
幂等性：

```powershell
npm run test:p4-adapter
npm run p4:adapter:audit
```

审计只使用合成对象，不连接真实论坛。内置 Playwright probe 默认关闭网络；即使
未来显式启用，也只允许白名单 HTTPS origin 的 GET/HEAD，并阻断 POST、WebSocket、
下载、敏感查询、截图和交互操作。浏览器 DOM 观察固定标为 `as_of_unverified`，
不虚报分页或懒加载完整性。两个虚拟时钟 adapter 排除未来新事件，对无法还原的
未来修订 fail closed。

cMOOC API 和浏览器 adapter 不调用发布函数或旧版落库扫描入口；即使存在有效
登录态，其外部写模式仍为 `none`，执行命令只会产生
`confirmed_not_attempted` 回执。完整契约见
[P4B ForumAdapter 可验证适配层](P4_ADAPTER_V1.md)。

## P4C-1：deny-by-default 能力网关与只读控制入口（已冻结）

P4C-1 已复用 P4A `CapabilityRequestV1` 和 P4B `ForumAdapterRegistry`，实现
principal、11 项能力目录、默认拒绝策略与统一 `ControlApplicationService`。
`local_ui`、`local_cli` 和 `agent_client` 的真实论坛写授权数均为 0，
`realPublishEnabled=false`。未知能力、附加字段和发布升级参数全部 fail closed。

```powershell
npm run cmoocctl -- manifest --json
npm run cmoocctl -- status
npm run cmoocctl -- adapter doctor --adapter cmooc
npm run test:p4-capability
npm run p4:capability:audit
```

三个 CLI 命令都返回 `cmooc.control-result.v1`、关联 ID 和
`containsForumText=false`。本地 doctor 只读取认证配置与 cookie 元数据，不访问
论坛认证端点，不调用论坛观察或执行方法。当前能力入口足以支撑黄金路径，不单独
推进 P4C-2、stdio/MCP 或更多客户端。完整契约见
[P4C-1 能力网关与只读控制入口](P4_CAPABILITY_GATEWAY_V1.md)。

## 保留的在线模型辅助评估（非当前开发阻塞项）

以下 P1/P1H 路径用于在用户明确返回该问题时比较促进功能模型。它不是当前产品
黄金路径，也不阻塞当前 P4 最小工程闭环或毕业产品完成；涉及在线标注时仍需要
当前任务的明确授权。

```powershell
npm run research -- status
npm run research -- doctor
npm run research -- pack
npm run research -- annotate --authorize
npm run research -- evaluate
```

`status/doctor/pack` 只做本地检查与加密打包；`annotate --authorize` 才会在当前
进程内授权发送固定 50 条匿名内容，授权不得继承。输出只保存受控标签、模型标识、
用量和来源哈希，不保存正文、人工标签或 token。当前尚缺的真实盲标与冻结参考
评估不会自动成为下一开发任务。

固定产物、DPAPI、模型端点、exclusions 和高级可选研究的完整历史协议见
[P1H 在线模型标注报告](P1H_ONLINE_MODEL_ANNOTATION_REPORT_20260719.md) 及相关
`docs/P1*.md`。只有用户明确恢复该辅助分析时才读取这些文档；不要把它们重新加入
默认产品主线。
