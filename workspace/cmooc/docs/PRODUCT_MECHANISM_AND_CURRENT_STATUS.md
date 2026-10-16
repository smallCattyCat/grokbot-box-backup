# 产品机理与当前完成状态

- 更新日期：`2026-08-03`
- 功能检查点：`v1-rc12 governed shadow runtime + trusted UI pagination companion`
- 状态来源：[PRODUCT_CURRENT](PRODUCT_CURRENT.md)
- 文档层级：[README](README.md)

## 1. 一句话定位

cMOOC 智能学伴是一个课程级共同体促进系统：它应当长期感知课程、在有限预算内
选择机会、把教育意图实现为受约束动作，并在社区已经连接或证据变化时主动让位。
教师/PI 负责策略、异常和长期质量，而不是逐条批准回复。

这个定位是目标产品。真实课程证据已经覆盖事件世界、机械 DRAFT、真实 STAGE、单动作
Policy/Permit、production Committer、一次确认发布、R24/R72 描述性回流、事故治理，
以及由不可变课程运行策略链约束的定时只读 worker。RC12 已在真实只读持久化槽中完成
7/7 栏目、64/64 详情和 38/38 UI 原生 companion 范围恢复，全程 0 编辑器写入、0 发布；
baseline、pause、resume、revoke、emergency halt 和 rotate 的 CLI 生命周期已完成。
连续两轮自然 RC12 worker 与 Codex 外层均已 completed，20 分钟超时缓解和直接安全
stdout 捕获得到验证；第二轮封闭六键 JSON 本体正确，但 Codex 自动任务框架仍追加 UI
收件箱指令，提示词层缓解已证伪。持续 AUTO、长期 soak 与教育效果仍未完成。

## 2. 当前链与目标链

当前受治理的真实可达链：

```text
显式课程绑定
→ disk/DB Manifest + 当前 CourseOperationGovernancePolicy 精确核验
→ schedule + governance 双绑定 invocation
→ API + 浏览器就绪核验
→ API 分页 + 受约束 UI 原生 companion + 完整性/删失回执
→ ObservedEventLedger
→ Course Event World + Graph v2
→ CandidateSet + 服务器角色/历史/预算证据
→ DRAFT / YIELD
→ DRAFT-only renderer + 写前同目标重读
→ Decision Tape + 课程级只读页面
→ 0 editor write / 0 publish
```

当前代码已本地验证的后续链：

```text
当前真实可达链的代码实现
→ 瞬时结构化语义证据
→ DRAFT + Intent + MoveSpec
→ 受约束语言实现
→ 写前同目标重读
→ SHADOW resolver
```

L3 已验证的一次性后半链：

```text
机械 DRAFT + 写前重读
→ 认证 STAGE v2
→ 单动作 Policy + Permit + Committer
→ 写后唯一核对
→ R24 observed / R72 observed
→ HARD RELOCK
```

冻结 P3A/P4D-1/P4F-lite 为时点调度、动作结构和合成让位提供研究/回归底座，但不
代替目标链中的真实输入与执行证据。

## 3. 产品机理

### 3.1 严格时点事件世界

`ObservedEventLedger` 是追加式事实源。World 与 Graph 按 cutoff、事件集合和状态
哈希投影，不从最终论坛快照倒推早期状态。它回答“当时可观察到什么”，不预测心理
状态，也不把一次发言固化为人格。

当前已实现：真实事件、线程、匿名参与者、父子边、覆盖/删失、World/Graph 快照、
full/incremental replay 和页面读取。

当前已实现追加式 event observation revision：稳定事件身份不覆盖，每次观察保存
source/target version 与 revision kind，投影按 cutoff 选当时版本。数据库测试已验证
旧 cutoff 不被未来修订倒改；历史 `event_version_conflict` incident 继续保留。

### 3.2 CandidateSet 与预算内择机

候选由服务器从当前 World 机械产生，并绑定 world、candidate set、角色、纵向历史、
触达和预算证据。模型不能浏览全课后自由选人，也不能把 CandidateSet 外对象升级为
目标。

`WAIT`、`ABSTAIN`、`YIELD` 是正式行动。外部连接、原作者返回、覆盖不足、角色不明
或证据过期时，系统应等待或让位，而不是为了展示生成回复。

当前已实现：CandidateSet、服务器 HMAC 角色回执、历史/预算回执、预算预留库、四态
决定和持久决定。

当前代码已用受信语义 attestation 填充促进功能、认识种子和 need 信号，并在完整
前缀、稳定身份、learner 角色与历史/预算合格时自然形成 DRAFT。该链先通过本地验证，
随后在 RC9 历史七个受治理真实 SHADOW 槽位中形成 2 个 DRAFT、19 个 YIELD；这只证明真实
只读语义链可达，不是发布或效果证据。

### 3.3 Intent 与 MoveSpec

`InterventionIntentV1` 固定是否介入、促进功能、目标、成本、有效期和撤回条件；
`FacilitationMoveSpecV1` 固定机制目标、具体动作、必须内容、禁止动作和可观察成功
条件。语言层只能实现这两个对象，不能改变课程、目标、时点、预算或发布权限。

当前代码保留三类事件级促进功能：

- `resource_connection`：资源连接；
- `cognitive_conflict`：认知冲突；
- `emotional_support`：情感支持。

P4A 协议、P4D-1 合成黄金路径和 live-runtime 资格内核继续提供兼容基线；自治 tick
现在能在本地纵向链和受治理真实 SHADOW 槽位生成合法对象实例。L3 前的 0 DRAFT
快照仍是历史基线，不能用后验倒写。

### 3.4 受约束语言实现

`semantic-renderer` 已实现 DRAFT-only 输入检查、结构化输出、目标/Intent/MoveSpec
绑定、确定性回退和正文零持久化。只有正文哈希、renderer/模型版本和校验结果可以
进入普通持久层。

当前 renderer 已在 `autonomy:tick` 中按 DRAFT-only 启用；没有 generator 时使用
确定性回退，非 DRAFT 保持零模型调用。集成测试与受治理真实 SHADOW 分别验证了该链，
后者合计形成 2 个去正文 `SemanticRealization`。设置在线模型不会绕过证据门、扩大目标或
开启发布。

### 3.5 写前重读与让位

正确执行前必须重新观察同一目标版本和事件前缀：

- 稳定且仍需促进：`EXECUTE`；
- 出现真人连接、原作者返回或既有系统接续：`YIELD`；
- 目标变化、事件前缀退化、覆盖删失或动作结果未知：`REVIEW`。

自治 tick 现在会在 DRAFT 后共享一次第二轮只读观察，并输出
`EXECUTE/YIELD/REVIEW` 去正文回执；`EXECUTE` 固定禁止编辑器写入和发布。旧
`/api/platform/live-opportunities/revalidate` 仍负责同标签页 STAGE 兼容链，两种
重读不能互相冒充。新链已在本地和受治理真实 SHADOW 验证，七个槽位都没有进入编辑器
或发布。

### 3.6 STAGE 与 AUTO

STAGE 的目标是同标签页写入、逐字回读、清除并证明零提交；AUTO 的目标是课程级
Policy、单动作 Permit、幂等 Committer、UI/API 核对、结果不明恢复和紧急停止。

当前代码已实现 STAGE v2 grant、短租约、持久 nonce、真实编辑器逐字回读/清空、
Policy/Permit、发送前记账、scoped write grant、production Committer、写后唯一核对、
结果不明只读恢复和 outcome eligibility。

一次明确授权的运行已经确认发布：STAGE mutation 0，production requested/sent 各 1，
Permit 和 STAGE 回执均已消费。随后 manifest、论坛设置、policy 和全局硬锁全部恢复
关闭。常规 `autonomy:tick` 仍不会自行进入持续 AUTO。

### 3.7 outcome 与长期治理

近端结果应分开记录首个合格外部回应、作者再参与、回复深度/跨作者边、功能摄取、
新作者覆盖、重复触达、观察终点和删失，不能压成单一“参与度”分数。

outcome observer、R24/R72 建窗、连续事件前缀、ready-only reconcile、证据来源与
Decision Tape 已实现。当前唯一确认发布 attempt 的 R24 与 R72 均已形成去正文、
非删失、非因果的描述性结果。事故确认/解决使用 CAS、
可信同源 JSON、ReviewEvent 与可选 Decision Tape；先前 high `tick_failed` 已在原证据
不变的前提下标记为 acknowledged，因缺少可验证根因/修复记录而未 resolved；当前
open high/critical 为 0。这些治理记录都不能解释为促进效果。

### 3.8 课程运行治理

`CourseOperationGovernancePolicy` 与动作级 `AutonomyPolicy/ExecutionPermit` 分层：前者
是追加式课程运行上限，绑定精确 Manifest、模式、有效期、频率和触达预算，不授权
STAGE 或发布。官方 baseline 每课程只允许一个 root，精确 replay 幂等，并发不同 root
一胜一拒；`pause/resume/revoke/emergency-halt/rotate` CLI 默认 preview，只有显式
`--apply` 写本地治理 DB。future rotate 按 as-of 生效，普通后继不允许早于 predecessor
的 `validFrom`，emergency halt 只接受服务层五分钟时钟偏差。数据库 trigger 拒绝原地
UPDATE/DELETE。同步、worker 和 direct tick 都会在任何运行写入前重算 disk/DB
Manifest 与治理哈希，并把 schedule、策略版本、策略哈希和有效上限持久绑定到
invocation；缺失、漂移、暂停、撤销、过期或 emergency halt 一律 fail closed。当前
已有 1 个 active SHADOW baseline；页面/API 只读并显式标注 200 条窗口截断，图形编辑
控制台不是当前运行前提。

## 4. 当前真实能力与证据

### 4.1 已有真实只读路径证据

- `autonomy:tick` 的 manifest、幂等 invocation、lease/heartbeat 和恢复槽；
- RC12 的 7/7 栏目、64/64 详情、1,578 个观察事件真实扫描；
- UI 原生 companion 恢复全部 38 个历史 API 位置漂移范围，38 条严格回执均满足稳定
  ID、父链闭合、零分页失败和权威终止，仅 2 个空/删除正文 tombstone 保持删失；
- 408 节点、2,103 边、72 个 learner nodes 的 Graph v2 lower-bound；
- CandidateSet、服务器证据、四态决定和追加式 Tape；
- `/autonomy`、World、决定、运行详情、outcome、policy 和 governance 的只读页面；
- 当前 23 条终态 worker 回执为 22 completed / 1 shutdown-abandoned，自动/本地来源为
  13/10；累计 due/considered/executed/skipped/failed=17/17/16/1/0，恢复 1、回流 1，
  编辑器写入和发布尝试均为 0；连续两轮自然 RC12 worker 为 1/1/0，worker/外层双终态、
  20 分钟等待和直接 stdout 捕获已验证；框架追加 UI 指令的限制保持开放；
- L3 前历史快照保持 0 编辑器写入/发布；L3 后新增一次 STAGE 和一次确认发布，当前
  `realPublishEnabled=false` 且 global hard lock=true。

### 4.2 历史 L3 真实外部路径证据

- 机械候选序位固定为 64 个中的零基序位 6（第 7 个），selection hash 在
  preflight/STAGE/publish 间一致；
- STAGE：write 1 / clear 1 / sent mutation 0 / body persisted 0；
- Permit：1 used / 0 open；
- 全局历史 Attempt：1 confirmed_published / requested 1 / sent 1；它不属于当前
  SHADOW invocation；
- 写后恢复未触发，`recoveredByReconciliation=false`；
- ProximalOutcome：R24 observed、R72 observed；两者均为非删失、非因果描述；
- active real policy 0，manifest/forum setting 两个发布开关均 false。

### 4.3 仍为部分实现

- 平台 API 曾在 38 个评论范围重复返回第一页；RC12 可信 companion 现已逐一恢复并
  通过稳定 ID、父链闭合、零失败和权威终止校验。仍有 2 个空/删除正文 tombstone，
  因而课程事件世界继续标记 `visible_only+censored`、Graph 继续标记 `lower_bound`，
  不计算 PageRank/k-core；
- outcome/incident 治理与不可变课程运行生命周期已接通；CLI 可写本地追加链，页面/API
  保持只读；
- recovery/unknown 分支通过本地故障测试；RC11 关机中断留下的过期租约已由 worker
  回收，RC9 并发自然唤醒也在 RC12 持有租约时安全让位；
- 单动作成功不能代替连续 soak、重启/登录失效演练或多轮预算验证。
- high `tick_failed` 历史事故现为 acknowledged、未 resolved；当前 open
  high/critical 为 0，仍保留长期复核入口。

### 4.4 本地或兼容验证

- event revision migration 与 cutoff 回放；
- 瞬时语义证据、自然 DRAFT、renderer 与确定性回退；
- 自治第二次只读观察和 shadow resolver；
- live-runtime revalidation；
- STAGE grant/nonce 的模拟失败分支；
- AutonomyPolicy、ExecutionPermit、并发/幂等/unknown/recovery 失败分支；
- outcome eligibility、建窗和观察；
- 旧 MANUAL 发布授权、核对和结果不明状态机；
- P4D-1/P4F-lite 合成研究路径。

这些代码应继续复用和向前合流，不应删除或回退；真实正常路径已发生一次，但未触发
的故障分支仍只能按本地验证报告。

## 5. Graph 与学习者位置口径

当前可安全报告的 Graph 口径必须分开：

| 口径 | 数量 | 含义 |
| --- | ---: | --- |
| Graph node | 408 | 最新 RC12 描述性 Graph 中的匿名节点总数 |
| Graph edge | 2,103 | 最新 RC12 描述性 Graph 中的有向边总数 |
| learner node | 72 | 具有服务器 learner 角色证据的节点子集 |

38 个历史 API 位置漂移范围已经由 companion 完整恢复，但 2 个空/删除正文 tombstone
仍不可见，所以 72 个 learner 的位置口径继续是 `lower_bound`。PageRank 和 k-core
保持 `null`，不能从存在删失边界的网络伪算，也不能反推社会孤立、能力或人格。

Graph 是描述性过程证据，不是 learned world model，也不构成干预效果或学习效果。

## 6. 冻结研究证据

### P3A

P3A 在固定真实时钟、显式 tick、TTL 和每日预算下构造离线决策快照与 replay。2024
用于开发、2025 保持时间留出；未来事件不进入早期特征。它支持有限预算下的离线
选择/工作量结论，不支持真实智能学伴因果效果。

### P4D-1

固定合成候选贯通 as-of 理由、预算、Intent/MoveSpec、可编辑确定性草稿和本地去
正文人工决定回执。它是研究与回归基线，不是成熟产品要求教师逐条批准的架构。

### P4F-lite

两个合成 adapter × 三个预声明情境共 6 个实例，6/6 完成；功能、动作、目标、草稿
规则和人工决定保真率为 1.0，4 个变化情境转人工接管，外部写入为 0。该结果只适用
于固定合成情境，不外推真实平台或教育效果。

复现：

```powershell
npm run p4:golden-path:audit
npm run p4:fidelity:audit
```

冻结专项文档和回执不得为了配合当前产品完成度而改写。

## 7. 证据层级

| 层级 | 当前结论 |
| --- | --- |
| 代码能力 | S1、STAGE v2、单动作 Policy/Permit、production Committer、核对/恢复、受治理定时 worker、outcome/incident 与课程策略生命周期已合流 |
| 本地验证 | 270 单元、57 TypeScript 数据库集成、1 图迁移集成、2 外键迁移集成、130 研究测试，合计 460 项通过；类型检查、lint、30 页面/路由生产构建与 340 文件独立制品审计通过 |
| 真实只读闭环 | RC12 课程扫描、38/38 companion、World/Graph、机械选择、目标重读和 R24/R72 核对已验证；2 个 tombstone 保持 lower-bound |
| 真实外部运行 | 一次 confirmed_published；requested/sent=1/1；已硬重锁 |
| 教育效果证据 | 0；R24/R72 都只是非删失、非因果的过程描述，尚无合格对照结果 |

不能用较高的本地验证完成度抬高真实外部运行或教育效果层级。

## 8. 验证状态

2026-08-03 对当前工作树的完整验证：

```text
270 个 TypeScript 单元测试
57 个 TypeScript 数据库集成测试
1 个图迁移集成测试
2 个外键迁移集成测试
130 个研究测试
TypeScript 类型检查
Next.js RC12 独立目录生产构建（30 个页面/路由）
340 个受控文件 build/runtime 独立制品审计
RC12 持久化到期槽：7/7 categories / 64/64 details / 1,578 events /
38/38 companion / 0 editor writes / 0 publish attempts
```

相关命令：

```powershell
npm run verify:agent-guidance
npm run type-check
npm run lint
npm test
npm run build
```

## 9. 当前推进顺序

唯一下一切片是 `AUTONOMY-V1-RC12-NATURAL-AUTOMATION-AND-LONG-SOAK`：唯一 30 分钟
Codex worker 已保持 `gpt-5.6-luna`、reasoning `max`、failed-only 通知和
`wake-source=codex_automation`，并已指向 `v1-rc12-release` / `runtime-version=v1-rc12`。
RC12 本地到期槽和最新自然 worker 都已 completed、due/executed/failed=1/1/0、
zero-write。首条自然轮 Codex 外层曾在 300 秒误超时，但底层进程持有有效租约并在约
14 分 47 秒后完成；调整为 20 分钟 timeout 并移除自建 stdout 解析后，随后两轮自然 worker
分别约 13 分 30 秒和 13 分 38 秒完成，外层任务分别约 15 分 51 秒和 15 分 39 秒
completed，并直接捕获安全 JSON。当前 23 条终态回执为 22 completed /
1 shutdown-abandoned，自动/本地来源为 13/10，累计
`due/considered/executed/skipped/failed=17/17/16/1/0`。第二轮封闭六键 JSON 本体正确，
但 Codex 自动任务框架仍追加 UI 指令；课程平台无副作用，提示词层无法消除该行为。
连续 soak 仍未完成。接下来在不新增真实发布的前提下，继续验证重启、
重复调用、unknown/reconcile、认证失效、已 acknowledged 的历史事故复核，以及
38/38 companion 恢复在连续运行中的稳定性；2 个 tombstone 始终保留删失边界。
治理与外键对齐 migrations `20260802130000`、
`20260802140000`、`20260802150000` 已在哈希备份后用 `prisma migrate deploy` 应用并
达到 18/18，先前外键 drift 已消除。任何新真实动作都需要新的策略、Permit、完整重读
和明确授权。

## 10. 文档关系

- 当前唯一产品事实：[PRODUCT_CURRENT](PRODUCT_CURRENT.md)
- 目标架构和成熟 DoD：[AUTONOMOUS_PRODUCT_MASTER_PLAN](AUTONOMOUS_PRODUCT_MASTER_PLAN.md)
- 文档权威层级：[README](README.md)
- 自治/兼容运行边界：[LIVE_FACILITATION_RUNTIME_V1](LIVE_FACILITATION_RUNTIME_V1.md)
- Graph 契约：[COURSE_CONTENT_GRAPH_V2](COURSE_CONTENT_GRAPH_V2.md)
- 冻结研究证据：[CURRENT_RESEARCH_WORKFLOW](CURRENT_RESEARCH_WORKFLOW.md)

历史阶段报告中的“当前”“下一步”和 Gate 只记录形成时状态；它们不覆盖当前产品
事实，也不改变冻结研究证据的原意。
