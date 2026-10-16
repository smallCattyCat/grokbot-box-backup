# AUTONOMY L3 单动作生产执行归档

- 日期：`2026-07-31`
- 状态：`CONFIRMED_PUBLISHED_ONCE / HARD_RELOCKED`
- 证据等级：真实单动作产品路径；不是教育效果证据
- 当前事实入口：[PRODUCT_CURRENT](../../PRODUCT_CURRENT.md)

## 1. 授权范围与结果

本轮授权只覆盖一个机械选定的合格持久 DRAFT：完成真实 STAGE、production
Committer、写后核对/恢复能力、单动作 Policy/Permit 和全量验证，真实发布最多一次，
随后立即恢复硬锁。

最终结果：

```text
STAGE verified_cleared
→ Permit used
→ requested mutation 1
→ sent mutation 1
→ confirmed_published 1
→ R24 pending + R72 pending
→ active real policy 0
→ open Permit 0
→ realPublishEnabled=false
→ global hard lock=true
```

未执行第二次发送、通知、课程加入重试或其他平台写操作。

## 2. 机械选择与安全回执

- 候选总数：64；零基机械序位：6（第 7 个）；
- selection hash：
  `36a66015151ce27144d4507e0aa50e480731439e9ea24a99b296168ac17ab52c`；
- STAGE receipt hash：
  `13053e1d13ae385a512218857eb4bdaf88dcbfc9b6444a03a5af8c26cfc665b8`；
- remote outcome hash：
  `0cc4ac83ccd244fd8ffb1ef15a01ea75e53d685c2be4b99bc741c90e610d58b9`；
- STAGE：editor write 1、readback verified、clear 1、sent mutation 0；
- production：requested 1、sent 1、唯一新增主评论核对成功；
- `recoveredByReconciliation=false`：本次正常确认，没有借恢复路径重发。

本归档不保存目标 URL、平台 ID、身份、凭据、Cookie、token 或论坛正文。

## 3. 实现增量

- `ExecutionStageReceipt`：只保存哈希、状态、计数和零正文边界；
- STAGE v2：签名 grant、短租约、nonce 一次性、页面/来源/目标版本绑定；
- `AutonomyPolicy`：从 SHADOW 决定派生独立单动作 AUTO policy，不改写历史决定；
- `ExecutionPermit`：目标、目标版本、内容、policy、时限和幂等键绑定；
- SQLite 部分唯一索引：同一课程/policy 只允许一个真实 Permit；
- scoped write grant：作用域、签名、精确绑定、一次消费；旧无绑定写入口继续拒绝；
- production Committer：发送前将 attempt 原子标记为 `sending`，随后只允许一个 API
  mutation；
- 写后核对：比较发送前后评论集合，只在唯一新增且规范内容一致时确认；
- 恢复：发送后异常只做最多三次只读核对，无法确认则进入 `outcome_unknown`，禁止
  盲重试；
- outcome：只有 confirmed、Permit 已消费且 mutation 计数为 1 的动作才能建立
  R24/R72；
- relock：无论成功或失败都撤销真实 policy、关闭 Permit、设置 emergency halt，
  恢复 manifest、论坛设置和代码级硬锁。

## 4. STAGE 哈希契约修复

第一次真实 STAGE 按安全策略失败关闭：编辑器已经清空，mutation 为 0，随后立即
重锁。原因是原 STAGE companion 使用原始 UTF-8 SHA-256，而语义 DRAFT 使用
`cmooc.transient-draft-content.v1` 规范哈希；页面逐字回读正确，但两套哈希契约不相等。

修复内容：

- grant/token/receipt 升级到 `cmooc.stage-companion-*.v2`；
- STAGE 写前和写后统一调用 `hashTransientDraftBody`；
- `prepareBrowserStagePayload` 在签发前显式比较确定性重建正文与持久 DRAFT 内容哈希；
- 单元和数据库 nonce 回归改为规范哈希，并先验证旧实现会失败，再验证修复通过。

修复后第二次 STAGE 才生成正式回执；失败尝试没有 STAGE 回执、Permit 或真实发送。

## 5. 验证

最终代码执行：

```text
npm run verify
  TypeScript: pass
  ESLint: pass
  unit: 208 / 208
  database integration: 28 / 28
  research: 130 / 130

npm run build
  Next.js production build: pass
```

真实前置检查确认目标版本未变化、确定性草稿可重建、认证来源可用、global hard lock
为 true、manifest/forum setting 为 false、active real policy/Permit/attempt 均为 0。

真实后验检查确认：

- manifest 与论坛设置均锁定；
- active real policy 0；
- 真实 Permit 1 used / 0 open；
- STAGE receipt 1 used，正文持久化和论坛正文标记均为 0；
- 真实 attempt 1，状态 `confirmed_published`，requested/sent=1/1；
- R24/R72 各 1 个 pending 窗口。

## 6. 证据边界

本轮能够支持：

- 产品代码可以在一次性签名和数据库状态约束下完成真实 STAGE、单次发送、核对、
  建窗与重锁；
- 正常路径没有重复发送；
- 默认硬锁在外部动作后恢复。

本轮不能支持：

- 持续 AUTO 已启用；
- 多轮、重启、登录失效和网络中断下已经长期可靠；
- R24/R72 已观察到正向结果；
- Graph、单次发布或 pending 窗口构成教育效果或因果证据。

下一阶段只读等待并观察 R24/R72，补治理视图和故障/soak 验证；任何新真实动作必须
重新满足策略、Permit、重读、预算和明确授权。
