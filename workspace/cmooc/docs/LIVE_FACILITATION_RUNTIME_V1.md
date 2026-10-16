# 真实 cMOOC 自主促进运行内核 v1

- 更新时间：`2026-08-23`
- 状态：`CURRENT RUNTIME BOUNDARY / RC13 SOURCE RECOVERY VALIDATED / SOAK READINESS BLOCKED / AUTOMATION PAUSED / LONG SOAK NOT STARTED / HISTORICAL L3 ONE-SHOT`
- 当前事实：[PRODUCT_CURRENT](PRODUCT_CURRENT.md)

本文同时说明三条仍在仓库中的运行面：

1. `autonomy:tick`：当前由不可变课程运行 baseline 约束的真实 SHADOW 产品主链；
2. `/api/platform/*`：较早的页面观察、资格、重读和 STAGE 兼容链。
3. `autonomy:l3`：机械 DRAFT → 认证 STAGE → 单动作 Policy/Permit → production
   Committer → 核对/建窗/重锁的一次性执行链。

第二条包含可复用协议与历史页面 smoke；第三条已完成一次历史真实正常路径。历史
RC12 release 位于 `%LOCALAPPDATA%\cmooc-autonomy-runtime\v1-rc12-release`，唯一
30 分钟 Codex 任务以 `wake-source=codex_automation`、`runtime-version=v1-rc12` 唤醒
单 worker。20 分钟 shell timeout、worker/外层双 completed 终态和直接安全 stdout 捕获已由
连续两轮自然任务验证。第二轮的封闭六键 JSON 本体正确，但 Codex 自动任务框架仍追加 UI
收件箱指令；课程平台无副作用，应用仍配置 failed-only，提示词层无法消除该框架行为。
常规 tick 尚未自动调用第三条，单次成功也不能拼接成“长期生产闭环已完成”的结论。

2026-08-23 的现行边界覆盖上述历史运行说明：Codex 自动任务当前为 `PAUSED`，旧 RC12
release 未传播 `governanceFiltered`，不能直接恢复。源码已升级 worker/wake v2 契约与
`codex_automation/v1-rc13` scoped readiness；一次真实 `local_cli/v1-rc13` 原槽恢复为
completed/exit 0、扫描 1,581 个观察事件、0 目标失败、0 编辑器写入、0 发布。三条相关
high 事故已追加 resolved 转移，但另有 1 条 active high `tick_failed` 仍为 acknowledged、
尚未 resolved，所以 active open high/critical=0、active unresolved high/critical=1，
readiness=`blocked`；目标宿主 scope 也尚无回执。源码 release builder 已能安全 dry-run，
但明确 `runtimeReady=false`。可运行 RC13 不可变 release 的切换与自动任务恢复仍需用户
明确决定；本说明不把源码恢复轮或 dry-run 写成长时 soak 或 mature-v1。

## 1. 产品结论

目标产品不是“模型看见帖子就回帖”，也不是教师逐条审批台，而是由真实观察、严格
时点证据、预算决策、受约束语言、写前重读、可信执行和结果回流组成的课程运行
智能体。

已有真实课程证据覆盖以下受治理只读链：

```text
CourseManifest + CourseOperationGovernancePolicy
→ schedule/governance 双绑定 invocation
→ API + 浏览器 readiness
→ 扫描/游标/事件账本
→ World + Graph
→ CandidateSet + 服务器证据
→ DRAFT / YIELD
→ renderer + second read-only observation
→ Decision Tape
```

当前代码把瞬时语义证据、DRAFT/Intent/MoveSpec、DRAFT-only renderer 和第二次只读
重读接入同一自治 tick，并通过本地纵向测试及 RC9 历史七个真实 SHADOW 槽位验证；后者
合计 2 DRAFT、19 YIELD、2 SemanticRealization，编辑器与发布计数均为 0。历史 L3 在
独立一次性入口中完成真实 STAGE、Policy/Permit、Committer、确认发布与 R24/R72
建窗。默认且当前的外部写能力仍为关闭；一次性授权已经消费。

## 2. 用户与治理

- **课程运营者：**维护课程绑定、运行边界和异常；
- **课程 PI/教师：**治理课程级策略、预算和长期质量，抽查 Decision Tape；
- **研究者：**读取去正文结构证据，区分代码、本地验证、真实只读和外部效果；
- **学习者：**历史 L3 一次授权动作曾在平台原生讨论区产生一个最终促进回复；系统
  内部理由、控制台与治理信息始终不可见。当前 SHADOW invocation 为 0 编辑器
  写入、0 发布，硬锁恢复后不会继续产生新内容。

`/autonomy/*` 当前主要是只读治理视图；`/autonomy/governance` 默认只核对 active-visible
course 的不可变 SHADOW 策略链与转移历史，`/review/live` 默认只聚合该作用域的去正文
异常、课程运行与审核事件。disabled/fixture 的策略、事故和 ScheduledInvocation 历史
仍保留为审计证据，但不进入默认当前计数或列表。课程策略的 baseline、pause、resume、
revoke、emergency halt、rotate 已由默认 preview、显式 `--apply` 的本地 CLI 接通；
页面/API 不提供 mutation。先前 high `tick_failed` 已保留原证据并标记为 acknowledged，
因没有可验证修复记录而未 resolved；当前 open high/critical 为 0，但 unresolved
high/critical 为 1。“PI 不逐条审批”不代表放宽外部写锁。

## 3. 当前自治主链

`runAutonomyTick` 的真实调用顺序是：

```text
disk/DB manifest + current governance + mode/write-lock validation
→ schedule/governance-bound invocation acquire/recover + lease/heartbeat
→ course scan + coverage/resume receipt
→ event ledger append
→ world + Graph v2 projection
→ CandidateSet
→ server role/history/budget evidence
→ bounded transient semantic evidence
→ facilitation kernel
→ DRAFT-only renderer（仅 DRAFT）
→ second read-only observation
→ EXECUTE / YIELD / REVIEW shadow resolver
→ decision + Decision Tape persistence
```

当前主链的关键事实：

- `CourseOperationGovernancePolicy` 是追加式运行上限，不是发布授权；缺失、Manifest
  漂移、暂停、撤销、过期或 emergency halt 时，worker、direct tick 与同步入口都在
  运行写入前 fail closed；
- 官方 baseline 每课程单 root，精确 replay 幂等，并发不同 root 一胜一拒；future
  rotate 按 as-of 选择，普通后继不允许时间倒置，emergency halt 只容忍服务层五分钟
  时钟偏差；
- 每个受治理 invocation 持久绑定 schedule、策略版本、策略哈希和有效上限，不能在
  运行中替换策略；
- 完整评论前缀、稳定身份、明确 learner 角色且无 unknown relation 的服务器详情可
  标为 `semantic_ready`；否则继续结构观察并 fail closed；
- 正文只在有界内存中生成去正文语义回执，绑定 observation、目标版本和事件前缀；
- 服务器语义 attestation 只能授权 shadow 资格判断，不等价于同标签页网络守卫；
- 资格内核可形成 DRAFT/WAIT/ABSTAIN/YIELD，target reason 与 community process goal
  分开记录；
- renderer 只处理 DRAFT；当前无 generator 时使用确定性回退，正文不持久化；
- DRAFT 后触发一次共享的第二轮只读观察，resolver 的 `EXECUTE` 也明确禁止 editor
  write 和 publish；
- 常规 tick 仍没有自动调用 STAGE、Permit/Committer 或 outcome observer；L3 由独立
  一次性 runner 接续其持久 DRAFT，并在结束时强制重锁。

## 4. 兼容 live-runtime 链

仓库保留以下接口：

```text
POST /api/platform/live-observations
POST /api/platform/live-opportunities
GET  /api/platform/live-opportunities?observation=<receipt-hash>
POST /api/platform/live-opportunities/revalidate
POST /api/platform/live-opportunities/stage-draft
POST /api/platform/draft-transport-smoke
```

这条链定义：

- `LiveUiObservationReceipt`：目标、版本、事件集合、动作和零写边界；
- `TrustedSchedulingHistoryAttestation`：历史 cutoff、触达、候选域和预算；
- `EvidenceQualificationReceipt`：可回答性、时点与关系资格；
- `LiveOpportunityReceipt`：四态决定、Intent/MoveSpec 和易失草稿哈希；
- `LiveRevalidationReceipt`：目标稳定、让位、变化、过期或删失；
- `DraftStagingReceipt`：带同标签页守卫的认证未发布暂存；
- `DraftTransportSmokeReceipt`：无网络守卫的编辑器传输证明。

这些对象仍有价值，应向自治主链合流而不是重写。但 HTTP 请求调用方提供的证据、
历史真实页面 smoke 和合成 adapter 都不能自动成为 `autonomy:tick` 的受信输入。

自治主链新增的 `TrustedSemanticEvidenceAttestation` 由服务器课程扫描内部签发，不从
普通 HTTP 调用方接收。自治 `draft-revalidation` 是跨第二次只读扫描的 shadow
resolver；兼容 `live-runtime/revalidation` 仍负责同标签页 STAGE 前重读。两者不可
互相冒充。

## 5. 决策与状态机

目标状态机：

```text
OBSERVED
→ EVIDENCE_GATHERING
→ WAIT / ABSTAIN / YIELD / DRAFT
→ INTENT_READY + MOVESPEC_READY
→ TARGET_REVALIDATED
→ SHADOW / DRAFT_STAGED_NOT_PUBLISHED / AUTO_ATTEMPT
→ RECONCILED
→ OUTCOME_WINDOWS
```

让位优先级：

```text
外部连接 / 原作者返回 / 既有系统接续 → YIELD
目标修订 / 事件前缀退化 / 覆盖删失 → REVIEW
动作结果未知 → STOP + RECONCILE，不盲重放
```

L3 前的历史真实自治基线只覆盖前半段并落在 ABSTAIN/YIELD；S1 本地纵向测试覆盖到
DRAFT、renderer 和 `TARGET_REVALIDATED`。RC9 历史七个 schedule/governance 双绑定的真实
SHADOW 槽位进一步覆盖 2 DRAFT、19 YIELD 与 2 SemanticRealization，当前 focal
invocation 的编辑器/发布计数均为 0。历史 L3 为另一个机械选定 DRAFT 追加真实
STAGE、AUTO_ATTEMPT、RECONCILED 和 OUTCOME_WINDOWS 证据，两层不能混算。

## 6. 严格时点与证据输入

所有决定必须绑定：

- observation/cutoff 与事件集合；
- world、candidate set 和预算快照；
- 目标版本与课程范围；
- 角色、纵向历史、触达和有效期；
- policy/contract 版本。

未知值必须保持 unknown/null，不能补成 0。“72 小时未回应”也不是充分介入条件；
还要有完整支持缺口、可发展的认识种子、可判定关系与角色、足够历史、冷却/重复
触达合格和可用预算。

当前服务器已经接管角色、历史、预算和语义证据签发，不再信任普通客户端自报。
语义分析只持久化结构化信号、引用和哈希；L3 已在单动作真实路径继续核验该边界。
下一切片以解决 active acknowledged high、准备可运行 RC13 release、获准后积累
`codex_automation/v1-rc13` 长期 soak 为主，而不是继续增加新语义字段。

## 7. 真实扫描、World 与 Graph

2026-08-03 最新 RC12 持久化真实只读快照：

| 项目 | 值 |
| --- | ---: |
| 栏目 | 7/7 |
| 主题详情 | 64/64 |
| World events | 1,578 |
| Graph nodes / edges | 408 / 2,103 |
| learner-role actors | 72 |
| 目标失败 / failed attempts | 0 / 0 |
| companion 恢复范围 | 38/38 |
| 空/删除正文 tombstone | 2 |

最新 Graph 有 72 个明确 learner 角色节点，但 2 个空/删除正文 tombstone 仍使覆盖保持
`lower_bound`；不计算 PageRank/k-core，也不把 Graph 节点数解释为学习者人数。38/38 个
历史 API 位置漂移范围已由可信 companion 提供独立分页、稳定 ID、父链闭合、零分页失败
和权威终止证据，当前不再存在分页/companion 失败。

## 8. 页面与 API

| 页面 | 当前状态 |
| --- | --- |
| `/autonomy` | 当前产品摘要 |
| `/autonomy/world` | World/Graph/learner 位置只读视图 |
| `/autonomy/decisions` | 真实决定只读视图 |
| `/autonomy/runs/[id]` | Decision Tape |
| `/autonomy/outcomes` | outcome 资格、证据来源与观察窗；R24/R72 observed，均为非删失、非因果描述 |
| `/autonomy/policy` | manifest/schedule/policy/permit 只读视图 |
| `/autonomy/governance` | 默认 active-visible course 的不可变课程运行策略链、转移历史、Manifest 绑定、有效期与上限；disabled/fixture 历史保留但不进入当前计数；显式标注 200 条窗口截断 |
| `/platform` | LIFT-1 真实页面只读诊断 |
| `/review/live` | 默认 active-visible course 的去正文 incident、ScheduledInvocation 与审核事件，以及独立 worker wake 审计；disabled/fixture 历史不污染当前态 |
| `/review` | 冻结合成研究复现 |

自治 API：

```text
GET  /api/autonomy/status
GET  /api/autonomy/governance
POST /api/autonomy/maintenance/recover
POST /api/autonomy/outcomes/reconcile
POST /api/autonomy/incidents/{id}
```

三个 POST 接口只修改本地运行状态、观察窗口或去正文事故状态，不执行真实平台写入；
governance GET 只读。页面最近运行的编辑器/外部写入计数按 focal invocation 作用域
计算，不把历史全局 L3 attempt 归给当前运行。
L3 production Committer 只由受控本机 CLI 使用，不暴露为普通策略写 API。

## 9. STAGE 证据等级

两类回执必须分开：

- `TRANSPORT_SMOKE_DRAFT_VISIBLE_NOT_SUBMITTED`：真实编辑器写入和回读成功，
  但没有同标签页网络守卫；只证明传输能力；
- `DRAFT_STAGED_NOT_PUBLISHED`：受信 companion 在同一标签页挂载守卫，写入后证明
  mutation、提交控件、快捷键和发布请求均为零，并完成回读/清除。

历史 smoke 属于第一类。本轮 L3 使用 v2 签名 grant、持久 nonce、真实页面请求/提交
守卫、逐字回读与清空，形成一条 `DRAFT_STAGED_VERIFIED_AND_CLEARED_NOT_PUBLISHED`
真实回执：editor write 1、clear 1、sent mutation 0。

自治重读回执中的 `EXECUTE` 只允许继续 shadow 链，固定
`editorWriteAllowed=false`、`publishAllowed=false`，不属于上述任一 STAGE 证据等级。

## 10. AUTO、核对与恢复

目标 AUTO 链要求：

```text
active course policy
→ fresh DRAFT + re-read
→ one-shot ExecutionPermit
→ production Committer
→ UI/API post-write verification
→ confirmed / unknown
→ reconcile or outcome windows
```

当前已有 policy/permit schema、数据库唯一约束、签发/消费库、scoped write grant、
production Committer、发送前记账、唯一新增核对和结果不明只读恢复。历史全局 L3
后验为 1 个 used Permit、0 open Permit、1 个 `confirmed_published` attempt，
requested/sent 均为 1；RC9 历史七个 focal SHADOW invocation 的 editor/publish 均为 0。

本次授权结束后 active real policy=0、manifest/forum setting=false、global hard
lock=true。再次执行不能复用原 STAGE、Permit 或 attempt。

## 11. 近端结果与研究边界

未来 outcome 至少分为：

| 域 | 指标 |
| --- | --- |
| 事件 | 首个合格外部回复与时间 |
| 作者 | 原作者再参与 |
| 讨论 | 最大深度、跨作者边和回复链延伸 |
| 功能 | 资源应用、解释修订或重新参与等功能摄取 |
| 覆盖 | 新作者覆盖、未支持作者与观察删失 |
| 负担 | 7/30 日触达、冷却和强制等待 |
| 治理 | 接受、编辑、拒绝、撤回、异常原因与用时 |

只有确认发布且与目标、内容、Permit、attempt 和远端回执严格绑定的 AUTO 动作可
建窗。当前唯一合格动作的 R24 与 R72 均已形成去正文、非删失、非因果描述；两窗均未
观察到首个外部回复或作者返回，深度增量均为 1、新作者均为 0。历史 high `tick_failed`
与 RC11 中断仍保留原证据，当前 open high/critical 为 0；其中 1 条 active high 仅为
acknowledged，故 unresolved high/critical 为 1。Graph、自然回复、建窗本身、治理记录
或合成 P4 结果都不能替代教育效果或因果结论。

## 12. 当前推进

以下保留 RC12 端到端自动任务的历史运行证据：唯一 30 分钟 Codex 任务当时以
`gpt-5.6-luna`、reasoning `max`、failed-only 通知、`wake-source=codex_automation`、
`runtime-version=v1-rc12` 从 `v1-rc12-release` 唤醒有界 worker。RC12 本地到期槽为
`due/executed/failed=1/1/0`；期间旧 RC9 自动唤醒因课程租约繁忙安全 skip。首条自然
RC12 worker 的 Codex 外层曾在 300 秒误超时，但底层进程在约 14 分 47 秒后正常落终态。
将 shell timeout 改为 20 分钟并移除自建 stdout 解析后，随后两轮自然 worker 分别约
13 分 30 秒和 13 分 38 秒 completed/exit 0，外层任务分别约 15 分 51 秒和 15 分 39 秒
completed，直接捕获安全 JSON，单轮 `due/considered/executed/failed=1/1/1/0`。当前
23 条 wake receipt 中 22 条 completed、1 条 shutdown-abandoned，自动/本地来源为
13/10，累计 `due/considered/executed/skipped/failed=17/17/16/1/0`，恢复租约 1、
结果回流 1，zero-write。封闭 JSON 本体正确，但框架仍追加 UI 指令；提示词层缓解已证伪，
应用当时配置 failed-only，长期 soak 未完成。当时 RC12 health 为 `healthy`：
running/expired/failed=0，pending/overdue outcomes=0，open incidents=0。

当前推进切片已转为 RC13：源码真实恢复轮 completed/exit 0，默认 operator 视图已限定
active-visible course；active open high/critical=0，但 acknowledged high/critical=1，
所以 unresolved high/critical=1、readiness=`blocked`。目标
`codex_automation/v1-rc13` 仍无回执；源码 release dry-run 已存在但
`runtimeReady=false`，宿主自动任务继续停在旧 RC12 release 且保持 `PAUSED`。

RC11 的关机中断、abandoned wake receipt、3 条 companion 失败及
`COURSE_ID_UNVERIFIED` 根因保留为历史证据；RC12 仅对详情绑定竞态做显式等待和一次
有界重试，结构不匹配继续 fail closed。当前 38/38 个位置漂移范围已恢复，只有 2 个
空/删除正文 tombstone 维持 `lower_bound`。治理与外键对齐 migrations
`20260802130000`、`20260802140000`、`20260802150000` 已应用并核验为 18/18；默认不
新增真实发布，后续继续验证重启、unknown/reconcile、认证失效和长期 soak；成功轮 UI
指令抑制等待 Codex 自动任务框架支持。

RC8/RC9 的早期运行基线（10 条终态安全回执、累计 `due/executed/failed=7/7/0`，
首条自然 `codex_automation/v1-rc9` 回执 completed/exit 0）保留为历史证据；它们不
替代 RC12 的自然回执或长期 soak 资格。
