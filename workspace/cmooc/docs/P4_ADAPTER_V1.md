# P4B ForumAdapter 可验证适配层

## 当前状态

P4B 已完成两个纵向切片：

- P4B-1 建立 `ForumAdapter` v1、registry、`CmoocApiAdapter` 和
  `MockForumAdapter`；
- P4B-2 加入浏览器严格只读诊断、第二合成论坛、跨平台 conformance、严格时点
  视图和机器可计算的零真实写审计。

源码入口为 `lib/forum-adapters/index.ts`。本阶段没有新增数据库表、智能体、角色、
审批层、调度抽象或真实发布入口，也没有修改 P3A 决策、既有授权和发布状态机。

## 统一契约

```ts
interface ForumAdapter {
  manifest(): AdapterManifest;
  inspectAuth(): Promise<AuthSummary>;
  listThreads(scope: ForumScope, cursor?: string): Promise<ThreadPage>;
  observeThread(ref: ThreadRef): Promise<ObservationEnvelopeV1>;
  bindTarget(ref: TargetRef): Promise<BoundTargetV1>;
  preflight(command: ExecutionCommandV1): Promise<PreflightReceipt>;
  executeAuthorized(command: ExecutionCommandV1): Promise<ExecutionReceiptV1>;
}
```

adapter 只负责认证摘要、平台对象映射、观察、目标绑定和传输结果语义。它不决定
是否介入，不选择促进功能，不生成教育动作，也不承担预算、调度、人工批准、模型
推理或能力授予。契约不存在 `publishText(url, text)` 一类任意写接口。

`AuthSummary`、`ThreadPage`、`ThreadSummary`、`PreflightReceipt`、scope 和引用
对象均有严格运行时校验：未知字段、非法枚举、非 64 位哈希、非带时区 ISO 时间、
课程不一致和正文标记均 fail closed。locator 禁止携带 token、认证、Cookie、会话
或密码类查询参数。

## 四个 adapter

| adapter | 平台/传输 | 外部写模式 | 时点语义 |
|---|---|---|---|
| `cmooc.api` | cMOOC API | `none` | API 读取完成后记录观察时钟 |
| `cmooc.browser-diagnostic` | cMOOC browser diagnostic | `none` | DOM 完整性不作过度声明，固定 `as_of_unverified` |
| `mock.forum` | 本地 mock | `synthetic_only` | 固定虚拟时钟，严格 as-of |
| `synthetic.timeline` | 第二合成 timeline 平台 | `synthetic_only` | 固定虚拟时钟，严格 as-of |

第二合成平台不是 `MockForumAdapter` 的子类。它把 timeline 聚合映射为 thread，
root message 和 nested message 映射为不同稳定目标，以独立原生模型验证同一 P4A
观察、目标、preflight、回执和幂等契约确实可跨平台复用。

`synthetic_only` manifest 必须同时满足：

- `transport=mock`；
- `platformId` 使用受控的 `synthetic.*` 命名；
- 支持虚拟时钟；
- 执行只生成本地合成回执。

registry 中 `gateway_authorized` adapter 数固定为 0。

## 浏览器严格只读边界

`CmoocBrowserDiagnosticAdapter` 只接受三个观察操作：

```text
inspectAuth
readThreadList
readThreadDetail
```

仓库提供唯一内置的具体实现 `CmoocPlaywrightReadOnlyProbe`。它默认
`networkEnabled=false`，构造时不会启动浏览器。即使调用方未来显式启用，只读
会话也固定：

- `serviceWorkers="block"`；
- `acceptDownloads=false`；
- 导航前安装全局请求和 WebSocket 拦截；
- 只允许显式 HTTPS origin 的 `GET`/`HEAD`；
- POST、跨源、HTTP、内嵌凭据、敏感查询、WebSocket 和下载均在会话内阻断并
  记录为去正文审计码；
- DOM 只使用 locator 的计数、属性和文本读取方法；
- 不使用 click、fill、press、type、脚本注入、截图、trace、数据库或旧
  scan/extract/publish 链。

单元测试使用受控假驱动，不访问 cMOOC、不启动浏览器二进制。P4B 审计也不调用
该 probe 的网络依赖。本阶段没有把浏览器 adapter 接入 UI、operator 或智能体；
未来 P4C 接线只能选用此内置只读实现，不能把任意测试 probe 当作可授予能力。

## 时点和目标不变量

所有 `listThreads` 签发的完整 `ThreadRef` 都会被 adapter 记录。后续 observe 和
bind 必须精确匹配签发时的 `threadKey`、course、platform course、stable ref 和
locator；任一字段被篡改都拒绝。

`ExecutionCommand.expectedTargetHash` 定义为规范化 `BoundTargetV1` 哈希。合成
adapter 同时保存对应 `TargetRef + targetVersionHash`，preflight 在执行时重新计算
当前目标版本：

- 仅因再次绑定的时钟变化，不会使旧绑定失效；
- 正文、作者引用、parent、修订或目标删除会使旧绑定失效；
- 不明确的远端结果不得猜测为成功或自动重试。

虚拟时钟 adapter 只把 `createdAt <= observedAt` 的事件放入观察。已经创建但
`updatedAt > observedAt` 的对象因缺少历史正文版本而明确拒绝，不能伪装成
`as_of_verified`。timeline 的 topic 编辑必须伴随 root message 的单调 revision 和
更新时间；无版本编辑、回删既有 message、parent 晚于 child 均 fail closed。
加入 \(t\) 后的新事件不会改变 \(t\) 时的 page state、observation state 或既有
target version。

`synthetic.timeline` 支持确定性本地分页 cursor。cursor 绑定 adapter/version、
scope、locator、limit、offset 和可见集合状态哈希；伪造、跨 scope 重放、集合漂移
和越界均拒绝。

## 执行边界

| adapter 类型 | preflight | executeAuthorized |
|---|---|---|
| `externalWriteMode=none` | 固定 `denied` | 固定 `confirmed_not_attempted`，`attemptedAt=null` |
| `synthetic_only` | 目标和命令有效时 `ready` | 仅本地生成三态尝试结果；无效命令为未尝试 |

两个真实平台 adapter 即使检测到认证态，也不能表达执行能力。browser execute 不会
调用 probe；cMOOC API execute 不会调用读取或发布依赖。相同幂等键重复调用返回
同一回执，绑定不同命令则 fail closed。

## Conformance 与审计证据

四个 adapter 运行同一套 conformance，覆盖：

1. manifest、auth、page、observation、target、preflight 和 receipt 的严格字段；
2. 正文、凭据和身份字段不进入协议输出；
3. 时点状态、未来后缀、稳定引用签发和目标版本变化；
4. cursor、篡改引用、未知目标、过期命令和幂等冲突；
5. `none` 与 `synthetic_only` 的执行结果边界。

```powershell
npm run test:p4-adapter
npm run p4:adapter:audit
npm run type-check
npm run lint
npm run verify
```

`p4:adapter:audit` 使用固定虚拟时钟和合成对象，注册四个 adapter。它以 poison
依赖和回执实际计算而非硬编码：

- adapter 数为 4；
- `gateway_authorized` adapter 数为 0；
- 真实外部写尝试数为 0；
- 网络依赖调用数为 0；
- 本地合成执行数为 2；
- 输出不含论坛正文。

审计不读取真实论坛、不启动浏览器、不写文件或数据库、不调用模型，也不触发现有
发布链。

## 当前冻结状态

P4B 后续的 P4C-1、P4D-1 和 P4F-lite 均已完成。P4F-lite 已直接复用
`MockForumAdapter` 与 `SyntheticTimelineForumAdapter`，完成稳定目标、目标版本
变化和时点后真人回应三个预声明情境；没有为验证新增平台或页面操作角色。

真实写 adapter、`gateway_authorized`、持久目标绑定、持久调度和证据账本仍不属于
P4B，也不是当前 P4 最小工程闭环的缺口。`realPublishEnabled=false` 保持不变。
当前统一状态见
[产品机理与当前完成状态](PRODUCT_MECHANISM_AND_CURRENT_STATUS.md)。
