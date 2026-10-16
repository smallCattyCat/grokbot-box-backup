# cMOOC 智能学伴干预系统

这是一个面向 cMOOC 课程社区的自主促进产品。当前工作树已经具备真实课程只读巡检、
持久事件世界、Graph、候选/预算决定和 Decision Tape；RC12 以追加式、不可变的课程
运行策略链把 disk/DB Manifest、schedule 与每次 SHADOW invocation 在运行写入前
精确绑定，并补齐 baseline、pause、resume、revoke、emergency halt 和 rotate 生命周期，
同时接入可信 UI 原生分页 companion、详情课程绑定等待和去正文失败码。
RC9 历史七个受治理真实槽位合计形成 2 DRAFT、19 YIELD、2 SemanticRealization，
编辑器写入和发布均为 0。历史 L3 单动作链曾完成真实认证 STAGE、一次性
Policy/Permit、production Committer、写后唯一核对、R24/R72 建窗和立即重锁；一次
明确授权的真实发布已确认成功，但持续 AUTO 仍未激活。

当前状态以 [产品当前状态](docs/PRODUCT_CURRENT.md) 为准，目标架构见
[自主产品总计划](docs/AUTONOMOUS_PRODUCT_MASTER_PLAN.md)，文档层级见
[文档地图](docs/README.md)。前瞻研究问题与贡献层级见
[课程共同体促进研究纲领 R1](docs/COMMUNITY_FACILITATION_RESEARCH_DIRECTION_R1_2026-08-30.md)，
研究证据的冻结含义见
[当前研究工作流](docs/CURRENT_RESEARCH_WORKFLOW.md)。迁移到小盒或其他相似社区的
实施边界与验收顺序见 [在线学习社区接入包](docs/PLATFORM_CONNECTOR_KIT.md)。

2026-08-29 的 connector-kit-v1 已把通用 v2 课程清单、精确 observer registry、数据库
adapter 绑定、worker/tick 通用加载、单客户白标和社区接入中心接入主链，并以 synthetic
非 cMOOC SHADOW tick 验证零编辑器、零发布。它降低了迁移成本，但目标平台的真实 API、
认证、分页和页面结构仍必须在其测试环境中联调。

## 当前可达与目标闭环

当前真实可达链：

```text
CourseManifest + CourseOperationGovernancePolicy
→ schedule/governance 双绑定 invocation
→ API + 浏览器就绪核验
→ 全课程有界扫描与恢复游标
→ ObservedEventLedger
→ Course Event World + Graph v2
→ CandidateSet + 服务器角色/历史/预算证据
→ DRAFT / YIELD
→ DRAFT-only renderer + 写前重读
→ Decision Tape + /autonomy 只读治理页
→ 0 editor write / 0 publish
```

当前代码已经本地接通：

```text
瞬时语义证据
→ DRAFT + Intent + MoveSpec
→ 受约束 renderer
→ 写前重读
→ EXECUTE / YIELD / REVIEW shadow resolver
```

本轮已验证的一次性后半链：

```text
机械选择持久 DRAFT
→ 目标/事件前缀重读
→ 认证 STAGE（写入、逐字回读、清空、零 mutation）
→ 单动作 Policy + Permit + production Committer
→ 唯一新增远端对象核对
→ R24 observed / R72 observed（均为去正文、非删失、非因果描述）
→ 立即硬重锁
```

当前 `realPublishEnabled=false`，代码级写锁为 true，活跃真实 policy 和开放 Permit
均为 0。本次一次性授权已经消费；不可变 SHADOW baseline 不是发布授权。产品具备受控
单动作能力，但不会继续向真实论坛提交内容或通知。

## 启动

Windows 下可双击项目根目录的：

```text
启动智能学伴系统.cmd
```

开发方式：

```powershell
npm install
npm run prisma:migrate
npm run autonomy:tick -- --course bnu-test --mode shadow
npm run dev
```

打开 `http://127.0.0.1:3000/autonomy`。

课程别名必须对应本机忽略的显式 manifest；仓库、命令输出和文档不保存真实平台
标识、论坛正文或登录态。相同 cadence 重复运行会复用幂等 invocation；失败槽按
数据库 lease/恢复语义处理。

## 页面

| 页面 | 当前用途 |
| --- | --- |
| `/autonomy` | 课程脉搏、最近运行、覆盖、事件/Graph、决定和风险边界 |
| `/autonomy/world` | 课程结构、事件参与者网络、learner 位置与快照回放 |
| `/autonomy/decisions` | 真实四态决定（含受治理 DRAFT/YIELD）和结构化理由 |
| `/autonomy/runs/[id]` | 单次运行与 Decision Tape |
| `/autonomy/outcomes` | R24/R72 observed 的去正文、非因果证据来源；不是效果页 |
| `/autonomy/policy` | manifest、schedule、policy、permit 的只读治理视图 |
| `/autonomy/governance` | 不可变课程运行策略链、转移历史、Manifest 绑定、有效期与上限的只读视图；200 条窗口会显式标注截断 |
| `/platform` | 社区接入准备度、白标/课程/连接器分层与当前 cMOOC 高级只读诊断；不冒充目标平台已接入 |
| `/review/live` | 旧 live-runtime 回执与传输 smoke 的兼容视图 |
| `/review` | 冻结 P4D-1/P4F-lite 合成研究复现 |
| `/settings` | 兼容论坛/模型配置与不可开启的发布硬锁开关 |

`/auto-intervention`、operator API 和旧 MANUAL 审阅链仍用于兼容与回归，不是当前
自治产品事实来源。

## 当前真实只读证据

2026-08-03 最新 RC12 真实只读课程快照包含：

- 7/7 个栏目、64/64 个主题详情、1,578 个观察事件，目标失败为 0；
- Graph v2 为 408 个节点、2,103 条边，明确 learner 角色节点为 72；覆盖仍按
  `lower_bound` 解释，因为仅剩 2 个空/删除正文 tombstone；
- 38/38 个历史 API 位置漂移范围均由可信 companion 恢复，形成稳定 ID、父链闭合、
  零分页失败和权威终止证明；没有失败尝试，编辑器写入和发布尝试均为 0；
- L3 前数据库 845 条历史自治决定全部为 ABSTAIN/YIELD、0 DRAFT；RC9 历史七个受治理
  真实 SHADOW 槽位随后新增 2 DRAFT、19 YIELD 与 2 SemanticRealization，不能倒写
  历史基线；
- 当时 semantic realization、AutonomyPolicy、ExecutionPermit、ExecutionAttempt、
  ProximalOutcome 和 ReviewEvent 均为 0；这是历史基线，不是 L3 后验值。

RC12 Graph 的 72 个 learner 角色节点仍受 2 个 tombstone 的覆盖边界约束，不得将
Graph 节点数合并成“学习者人数”。结构性异账号回复足以让系统让位，但不自动升级为
已核验真人、学习者或教育效果。

历史 L3 后验增量为：STAGE 回执 1（写入 1、清空 1、发送 mutation 0）、已消费 Permit
1、全局真实 attempt 1（requested 1、sent 1、confirmed 1），以及 R24/R72 两个窗。
R24 与 R72 均已 observed，且均为非删失、非因果的发布后描述性观察。最近 focal
invocation 的 editor/publish 均为 0，页面按 invocation 作用域显示，不把历史全局
attempt 归给当前运行。没有正文、身份或平台 ID 进入归档；这些计数不构成教育效果。

## 当前开发切片

`AUTONOMY-V1-SEMANTIC-DRAFT-AND-REREAD` 与 `AUTONOMY-L3-ONE-SHOT-PRODUCTION` 已完成，
当前推进切片为 `AUTONOMY-V1-RC13-QUALIFIED-AUTOMATION-AND-LONG-SOAK`。既有成果包括：

1. 修正真实事件修订/版本冲突语义；
2. 在正文不落盘的边界内生成绑定证据引用的结构化语义信号；
3. 让合格测试形状候选自然到达 DRAFT，不合格目标继续 WAIT/ABSTAIN/YIELD；
4. 只对 DRAFT 启用 renderer；
5. 在同一自治链完成目标版本与事件前缀的写前重读；
6. 本切片仍保持零编辑器写入、零发布。

历史 L3 随后完成：STAGE v2 规范哈希、真实编辑器零提交
暂存、单动作策略与 Permit、production Committer、发送前记账、写后唯一核对、
unknown 只读恢复、R24/R72 建窗与强制重锁。一次授权运行已确认发布，不能重放。

当前唯一 30 分钟 Codex 任务保持 `PAUSED`。它历史上使用 `gpt-5.6-luna`、reasoning
`max`、failed-only 通知，从 `%LOCALAPPDATA%\cmooc-autonomy-runtime\v1-rc12-release` 以
`wake-source=codex_automation`、`runtime-version=v1-rc12` 唤醒；该旧镜像没有传播 RC13
`governanceFiltered` 计数，不能直接恢复。首条自然 RC12 worker
曾因 Codex 外层 300 秒上限被误报超时，但底层进程继续持有有效租约并在约 14 分 47 秒后
完成。将 shell timeout 调整为 20 分钟并移除自建 stdout 解析后，随后两轮自然 worker
分别约 13 分 30 秒和 13 分 38 秒完成，外层任务分别约 15 分 51 秒和 15 分 39 秒
completed，均直接捕获安全 JSON，单轮 `due/considered/executed/failed=1/1/1/0`、
zero-write；由此 20 分钟缓解、worker/外层双终态和直接 stdout 捕获已得到连续自然轮验证。
当前 23 条 wake receipt 中 22 条 completed、1 条 shutdown-abandoned，自动/本地来源为
13/10，累计 `due/considered/executed/skipped/failed=17/17/16/1/0`，恢复租约 1、
结果回流 1，编辑器写入和发布尝试始终为 0。第二轮已使用封闭六键 JSON 且 JSON 本体正确，
但 Codex 自动任务框架仍在其后追加 UI 收件箱指令，说明提示词层无法消除这一界面副作用；
它没有触及课程平台，应用配置仍为 failed-only。该框架限制保持显式开放。

2026-08-24 已形成自包含 `v1-rc13-release`：402 个受控源码文件、26 个 migration、独立
依赖、路径型环境、生产构建、真实发布硬锁和本机登录态文件存在性通过 v2 runtime receipt
核验为 `runtimeReady=true`。release 内真实只读 worker 随后完成 64/64 个详情、1,581 个
观察事件、0 个目标失败、0 个未恢复 companion 失败和 0 编辑器/发布，worker 与 wake
receipt 均为 completed/exit 0。仅 2 个空/删除正文继续保持 censored；自动任务配置没有
切换，目标 `codex_automation/v1-rc13` 回执仍为 0，长期 shadow soak 尚未开始。

RC11 的关机中断、abandoned wake receipt、3 条 companion 失败及
`COURSE_ID_UNVERIFIED` 根因保留为历史证据；RC12 仅对详情绑定竞态做显式等待和一次
有界重试，结构不匹配仍 fail closed。最新连续两轮 RC12 任务已验证外层/worker 双终态；
当前另有 1 条 2026-07-30 high `tick_failed` 仅为 acknowledged，因缺少可验证根因/修复
记录仍阻断 readiness，不能以本轮成功倒写为 resolved。接下来需补足该事故依据；在获得
明确外部运行决定后，才可原子切换/恢复 RC13 自动任务并继续重启、重复调用、
unknown/reconcile、认证失效、长期 soak 与 tombstone 边界，同时等待 Codex 自动任务框架
提供成功轮 UI 指令抑制能力。
任何新外部动作都需要新的有效策略、Permit、完整重读和明确授权。

RC8/RC9 的早期运行基线也保持不可变：历史上形成过 10 条终态安全回执，累计
`due/executed/failed=7/7/0`，其中首条自然 `codex_automation/v1-rc9` 回执为
completed/exit 0；这些历史计数不替代当前 RC12 的自然回执与长期 soak 证据。

## 真实页面诊断与兼容 live-runtime

`/platform → /review/live` 曾完成真实课程壳/分区/卡片观察和一次经授权的编辑器
传输 smoke。该 smoke 只证明草稿写入与回读，没有同标签页网络守卫，状态只能是
`TRANSPORT_SMOKE_DRAFT_VISIBLE_NOT_SUBMITTED`，不能升级为认证 STAGE。

兼容接口包括：

```text
POST /api/platform/live-observations
POST /api/platform/live-opportunities
POST /api/platform/live-opportunities/revalidate
POST /api/platform/live-opportunities/stage-draft
POST /api/platform/draft-transport-smoke
```

它们提供可复用的观察、资格、同标签页重读和暂存协议。`autonomy:tick` 现在有独立
的跨第二次只读扫描 shadow revalidation，但尚未调用兼容 STAGE 链。详细边界见
[自主促进运行内核 v1](docs/LIVE_FACILITATION_RUNTIME_V1.md)和
[Computer Use live shadow](docs/COMPUTER_USE_LIVE_SHADOW.md)。

## 安装、数据库与验证

```powershell
npm install
Copy-Item .env.example .env
npm run prisma:migrate
```

数据库使用 SQLite。正式迁移不会清空 `prisma/dev.db`。RC12 的治理策略、生命周期与
外键对齐 migrations `20260802130000`、`20260802140000`、`20260802150000` 已在数据库
长度/SHA-256 备份后通过 `prisma migrate deploy` 应用，当前 18/18 migrations 到位。
迁移后 `integrity_check`、`foreign_key_check`、schema diff、既有 ID 集和部分唯一索引均
通过，先前 `InterventionTask`/`PublishLog` 外键动作 drift 已消除。演示 seed 会重建
目标开发库，
必须显式确认；普通开发和文档更新不要运行：

```powershell
$env:CMOOC_ALLOW_DEMO_RESET="RESET_CMOOC_DEMO_DATABASE"
npm run prisma:seed
Remove-Item Env:CMOOC_ALLOW_DEMO_RESET
```

测试使用独立 `prisma/test.db`。常规验证：

```powershell
npm run verify:agent-guidance
npm run type-check
npm run lint
npm test
npm run build
```

2026-08-03 RC12 工作树验证为：270 个 TypeScript 单元测试、57 个 TypeScript 数据库
集成测试、1 个图迁移集成测试、2 个外键迁移集成测试和 130 个研究测试，合计
460/460；type-check、lint 和生产构建通过，构建产物包含 30 个 pages/routes。受控
文件 340 个 byte-equal，auth/env parity 通过且受控产物中的数据库文件为 0；这些制品与界面检查
不替代真实执行回执。

## 在线模型

仓库保留 OpenAI-compatible 的在线模型配置和旧草稿流水线。密钥只放在本机环境变量
或 `.env.local`，不得进入源码、数据库、截图、普通日志或研究包。

需要特别区分：当前自治 tick 只在 DRAFT 上启用 `semantic-renderer`，但没有向它
提供在线 generator，因而使用确定性回退且不发送论坛正文。设置 `LLM_MODE=real`
不会让自治主链自动调用在线模型，也不会扩大课程、目标或发布权限。

## 真实论坛执行边界

仓库保留三层不同的执行/治理资产：

- 旧 MANUAL 链：一次性正文/目标绑定授权、幂等发布、结果不明核对；
- 新自治链：AutonomyPolicy、ExecutionStageReceipt、ExecutionPermit、production
  ExecutionAttempt 和 outcome 资格库；
- 课程运行层：追加式 `CourseOperationGovernancePolicy` 只约束 schedule/SHADOW 上限，
  不授予 STAGE、Permit 或发布。

当前代码级写锁覆盖设置、授权、发布、agent、浏览器和 API 写入口。L3 只在签名作用域
内把一个精确绑定的真实 mutation 临时放行，并在发送前消费锁；常规入口仍不能解除。
production transport 已完成一次真实确认，但这不意味着课程级持续 AUTO 正在运行。
先前 1 个 high `tick_failed` 长期事故已在保留原证据后标记为 acknowledged；由于没有
可验证的根因与修复记录，它没有被伪装为 resolved。当前 open high/critical 为 0，
外部写硬锁不变。

任何后续外部执行仍必须同时满足：有效课程 policy、单动作 permit、目标/版本/正文/
事件前缀/时限/幂等绑定、写前重读、写后核对、结果不明恢复和紧急停止，并取得当次
授权。当前后验是 `realPublishEnabled=false`、global hard lock=true、0 open Permit。

## 冻结研究资产

P3A 和 P4A—P4F-lite 继续作为方法与回归底座：

| 资产 | 可支持的结论 |
| --- | --- |
| P3A snapshot + scheduler replay | 固定时点、TTL、预算下的离线选择与工作量表现 |
| P4A 协议 | Intent/MoveSpec、证据引用和规范哈希 |
| P4B/P4C-1 | adapter 一致性、默认拒绝和零真实写能力 |
| P4D-1 | 合成候选到人工决定的可追溯性 |
| P4F-lite | 两个合成 adapter、三个预声明情境的规则级实施保真 |

这些资产不能证明真实平台干预、开放式语义质量或学习效果。不要修改冻结证据来配合
当前产品叙事；当前代码只通过兼容层复用其契约。

## 常用命令

```powershell
npm run dev
npm run build
npm run prisma:migrate
npm run autonomy:governance -- baseline --course bnu-test --version <new-version> --valid-from <iso> --valid-until <iso> --expected-manifest-hash <sha256>
npm run autonomy:governance -- pause --course bnu-test --version <new-version> --transition-key <key> --reason-code <code> --effective-at <iso> --expected-manifest-hash <sha256> --expected-governance-hash <sha256>
# pause/resume/revoke/emergency-halt/rotate 默认只预览；确认本地治理变更时显式追加 --apply
npm run autonomy:tick -- --course bnu-test --mode shadow
npm run autonomy:worker -- --limit 1 --wake-source local_cli --runtime-version v1-rc12
npm run autonomy:graph-status -- --course bnu-test
npm run autonomy:l3 -- preflight
npm test
npm run verify
npm run verify:agent-guidance
npm run p4:golden-path:audit
npm run p4:fidelity:audit
npm run research:decision -- status
npm run research:decision-review -- check --json
```

只读研究审计和合成 P4 命令不产生真实论坛写入。向在线服务发送研究内容、真实发布、
通知或其他外部副作用必须遵守根目录 `PROJECT_RULES.md`。

## 项目结构

- `app/autonomy/`、`app/api/autonomy/`：当前自治页面和 API；
- `lib/autonomy/`：manifest、tick、候选、证据、预算、Tape、renderer、policy、permit、
  outcome 和 read model；
- `lib/world/`：事件账本、World 与 Course Content Graph v2；
- `lib/live-runtime/`、`lib/ui-agent/`：旧真实页面观察/重读/STAGE 兼容协议；
- `lib/interventions/`、`lib/forum/`：旧 MANUAL 发布和论坛适配资产；
- `prisma/`：SQLite schema 与迁移；
- `scripts/`、`tests/`：运行、验证和冻结研究复现；
- `docs/README.md`：文档权威层级。

## 数据与安全

- `01_原始数据` 和正式研究数据保持只读；
- 不输出或提交凭据、Cookie、token、论坛正文、真实身份或平台 ID；
- `LEARNER/HELPER/CREATOR` 只是可追溯名册属性，不代表能力等级；
- Graph 是描述性过程证据，不是心理诊断或教育因果证据；
- 开发完整执行能力与允许它产生真实外部效果是两件事。
