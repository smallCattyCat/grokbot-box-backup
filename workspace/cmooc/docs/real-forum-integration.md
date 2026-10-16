# 真实论坛接入与执行边界

- 更新日期：`2026-07-31`
- 状态：`ONE-SHOT PRODUCTION VERIFIED / CURRENTLY HARD-LOCKED`

当前真实论坛接入已经支持课程 URL/origin 核验、只读 API/浏览器诊断、全课程 shadow
扫描、World/Graph、结构性让位，以及 L3 的认证 STAGE、单动作 Permit、production
Committer 与写后 API 核对。一次授权发布已确认；结束后所有真实入口重新硬锁。旧
MANUAL 发布链继续作为兼容代码保留。

## 当前已接入

- 显式 CourseManifest 与规范课程边界；
- API 列表/详情/评论读取和浏览器 readiness；
- 去正文事件、覆盖/删失和恢复游标；
- 真实课程 World/Graph、CandidateSet 与 ABSTAIN/YIELD；
- 瞬时结构化语义证据、自然 DRAFT 和第二次只读重读的代码/本地纵向链；
- LIFT-1 页面诊断和历史编辑器 transport smoke；
- STAGE v2、单动作 Policy/Permit、production attempt 与 R24/R72 建窗；
- 所有真实写入口的默认代码级硬锁与一次性 scoped grant。

## 当前未接入

- 常规 `autonomy:tick` 对 STAGE/AUTO 的长期自动接续；
- 多轮、重启、登录失效和网络中断下的长期 production soak；
- 到期后的 R24/R72 真实观察与长期异常审核；
- 完整教师/PI 策略治理操作面；
- 教育效果或因果证据。

## 读取与登录边界

登录由研究者在平台允许的方式下手动完成。系统不读取浏览器密码、不导出普通
Chrome Cookie、不绕过验证码、课程权限或平台风控。认证状态只表示某个只读/诊断
通道可能可用，不代表课程、目标、正文或动作已获授权。

采集与诊断会独立校验 HTTPS origin、规范路径和课程身份；历史导入 URL 或调用方
参数不能绕过边界。普通日志、Git 和文档不保存完整目标 URL、课程/平台 ID、正文、
身份或登录态。

## 旧 MANUAL 链（兼容）

兼容链的设计顺序是：

```text
预演候选
→ 固化最终目标与正文
→ 人工重新审阅
→ 一次性授权绑定目标/正文/任务/有效期
→ 幂等发布尝试
→ 远端核对
→ confirmed / reconcile_required
```

路由和数据库状态仍有实现，用于回归旧的目标/正文绑定、结果不明和防重复语义。
当前硬锁下，它不能真实发布；设置页的开关不可开启。这条链也不是新产品希望长期
依赖的逐条人工审批架构。

## 新 AUTO 链（目标契约）

目标 AUTO 链必须是：

```text
active course-scoped AutonomyPolicy
→ fresh DRAFT + pre-write re-read
→ one-shot ExecutionPermit
→ production Committer
→ UI/API verification
→ confirmed / unknown + reconcile
→ eligible outcome windows
```

每次动作至少绑定课程、目标、目标版本、正文哈希、policy 版本、时限和幂等键；
真人连接、作者返回、目标变化、证据过期、预算不足或 emergency halt 必须在最后一刻
阻断。

当前 L3 已实现并真实走通该链的正常分支：1 个 STAGE、1 个 used Permit、1 个
`confirmed_published` attempt，requested/sent=1/1。结果不明与恢复分支通过本地故障
测试，本次真实运行未触发。结束后 0 active real policy、0 open Permit。

## STAGE 边界

历史真实编辑器验证只达到
`TRANSPORT_SMOKE_DRAFT_VISIBLE_NOT_SUBMITTED`：写入和回读成功，但没有同标签页
网络守卫。认证 `DRAFT_STAGED_NOT_PUBLISHED` 还必须由受信 companion 提供签名
nonce、同标签页请求守卫、零 mutation、readback 和清除证明。

L3 已补充第二类真实证据：v2 grant、持久 nonce、页面/来源绑定、写入 1、逐字回读、
清空 1、发送 mutation 0。该回执已消费，不能重放或升级为第二次发布许可。

测试平台上的编辑器写入也属于外部交互；只有项目规则允许的明确范围才可执行，且
绝不点击发布、使用提交快捷键或触发真实通知。

## 写后证据与结果不明

生产执行成功不能只依据 HTTP 200、页面上存在相同正文或调用函数返回。必须证明：

- 本次 attempt 与 Permit、目标和正文一致；
- 出现的是本次新增远端对象；
- 父目标和版本正确；
- UI/API 核对没有冲突；
- Decision Tape 与本地状态原子推进。

网络超时或证据不足时进入 unknown/reconcile，最多执行有界只读核对，禁止盲重试。
新自治生产链已实现该分支并用故障测试验证；本次真实运行直接唯一确认，因此没有用
恢复分支伪造第二次请求。

## 当前硬边界

- `realPublishEnabled=false`；
- 真实写锁覆盖设置、授权、发布、agent、浏览器和 API 写入口；
- 历史累计 1 个 used Permit、1 个 confirmed attempt；当前 0 active real policy、
  0 open Permit；
- R24/R72 为 pending，尚无 outcome 结果；
- 本次授权已消费，不继续进行真实发布或通知；
- 一次执行成功不等于持续 AUTO 或教育效果。

本机部署边界见 [DEPLOY](../DEPLOY.md)，当前产品事实见
[PRODUCT_CURRENT](PRODUCT_CURRENT.md)。
