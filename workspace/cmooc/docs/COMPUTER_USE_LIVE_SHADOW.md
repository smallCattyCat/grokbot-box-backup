# Computer Use 真实平台 shadow 纵向切片

- 验证日期：`2026-07-29`
- 文档更新：`2026-07-31`
- 状态：`VALIDATED COMPATIBILITY SLICE / NOT EMBEDDED IN AUTONOMY TICK`

本文保存已验证的真实页面观察与编辑器传输切片。它的 observation、revalidation、
STAGE 协议仍应复用，但当前 `autonomy:tick` 只调用 API/浏览器 readiness 观察，没有
内嵌本文的受信 Computer Use companion、同标签页重读或 STAGE。当前产品事实见
[PRODUCT_CURRENT](PRODUCT_CURRENT.md)。

## 产品定义

这条切片把 Computer Use 作为仓库外的可替换界面驱动器，而不是把某个桌面产品
SDK 打包进 Next.js：

```text
真实 Chrome 标签页
→ Chrome 提供 URL / courseId / DOM 身份
→ Computer Use 执行可见页面导航与观察
→ 本地接口封存去正文动作回执
→ 真实结构 shadow 队列
→ 介入 / 等待 / 放弃
→ 达到门槛后才进入 Intent + MoveSpec
→ 写入前重新观察
→ 仅写入编辑器 / 撤回让位 / 长期审核
```

这种分工保留了 Computer Use 对未知页面和视觉交互的迁移性，同时把页面身份、
证据状态、重复动作与写入边界交给稳定协议。未来可以替换为其他 Computer Use、
浏览器扩展或确定性浏览器，不改产品状态与回执格式。

## 核心用户与学习者可见内容

- 课程运营者：配置真实课程入口，查看自治巡检是否持续运行以及异常是否积压；
- 教师 / 人类促进者：不需要守在控制面板逐条批准，只做长期抽查、异常复核和策略
  审计；
- 研究者：读取去正文证据链、审阅时延、选择 / 等待 / 撤回原因和近端结果指标；
- 学习者：当前开发与 shadow 模式下看不到任何系统内容。未来解除发布硬锁后，只会
  在平台原生讨论界面看到最终一次性促进回复。

## 页面关系

- `/autonomy`：当前真实只读产品主入口，展示 World/Graph、决定和 Decision Tape；
- `/platform`：输入真实课程地址，运行 LIFT-1 只读诊断，得到课程壳、分区、卡片、
  API 辅助痕迹和零写回执；
- `/review/live`：兼容 live-runtime 入口，只读取真实平台回执，展示
  `感知—择机—促成—让位` 状态、匿名结构队列、动作轨迹和真实编辑器草稿
  传输回执；
- `/review`：保留的 P4D-1 / P4F-lite 合成研究复现入口；
- `/settings`：显示发布硬锁；开发阶段不能通过设置或旧授权开启真实写入。

## 证据级别

1. `structural_observed`：课程壳、分区与卡片可见。只能进入结构队列；
2. `source_censored`：动作超时、后置条件未知或页面漂移。停止重放并转长期审核；
3. `semantic_ready`：同标签页只读守卫已挂载，UI 详情成功，目标版本、事件集合、
   身份依据和评论完整性达到门槛；
4. `blocked`：URL、`courseId`、课程壳或零写边界失败。

只有第 3 级可以继续构造语义候选。即使达到第 3 级，若持续支持缺口、作者覆盖、
冷却期或重复触达历史不足，P3A 仍应选择 `wait`。缺失指标不能用 0 补齐。

## 动作白名单与不确定结果

允许的动作只有：

- `navigate`
- `observe_course`
- `select_category`
- `open_card`
- `scroll`
- `reobserve`

每个动作都必须记录后置条件。动作超时后结果视为未知；系统先停止，再重新观察，
不能直接重放。默认 autonomous shadow 不执行登录、加入课程、关注、点赞、收藏、
回复、评论、发布、上传、下载和未知按钮。测试平台得到当前任务的显式授权后，可以
额外执行 `compose_draft`：重新定位目标、向原生编辑器输入易失草稿并回读，但不得
点击发布、使用提交快捷键或触发表单 / 网络提交。

## 同目标核验与同标签页核验

该兼容切片已验证：

- Chrome 标签页精确 URL / `courseId` 核验；
- 确定性只读浏览器对同一个真实目标执行网络写入拦截；
- 两条证据形成 `same_target_correlated` 回执。

`same_target_correlated` 证明两条实时观察指向同一规范课程目标，但不冒充同一标签页
的网络守卫。要升级为 `same_tab_guarded`，未来界面驱动桥必须在被 Computer Use
控制的同一 Chrome 标签页挂只读请求守卫，并共同回传一次性会话 nonce。窗口标题
不能代替 URL 证明。

因此草稿有两个明确不同的回执：

- `TRANSPORT_SMOKE_DRAFT_VISIBLE_NOT_SUBMITTED`：真实编辑器写入和回读成功，
  但当前驱动没有网络守卫；只证明传输能力；
- `DRAFT_STAGED_NOT_PUBLISHED`：写入前已经有同标签页网络守卫，且写入后确认
  mutation、发布请求、提交控件和快捷键均为零；才是认证暂存。

## 去正文与本机持久化

真实平台回执只保存：

- 本机 HMAC 的课程、帖子、作者和驱动会话别名；
- URL 目标哈希；
- 时间、数量、完整性状态和动作后置条件；
- 目标版本与事件集合摘要；
- 零写计数。

不保存课程 ID、帖子标题、作者显示名、正文、Cookie、token、截图或完整 URL。本机
HMAC 密钥位于：

```text
%LOCALAPPDATA%\cmooc-research\runtime\evidence-hmac-v1.key
```

LIFT-1 与 Computer Use 回执分别位于：

```text
%LOCALAPPDATA%\cmooc-research\lift1\evidence-v1\
%LOCALAPPDATA%\cmooc-research\live-ui-observations-v1\
%LOCALAPPDATA%\cmooc-research\live-facilitation-runtime-v1\
```

## 运行

```powershell
$env:CMOOC_DEMO_COURSE_URL = "<真实测试课程地址>"
npm run dev
```

打开：

```text
http://127.0.0.1:3000/platform
```

也可以先运行命令行真实巡检：

```powershell
npm run demo:lift -- --target-url "<真实测试课程地址>"
```

真实界面驱动向本机提交 `cmooc.live-ui-capture.v1`。接口只接受同源 JSON：

```text
POST /api/platform/live-observations
POST /api/platform/live-opportunities
POST /api/platform/live-opportunities/revalidate
POST /api/platform/live-opportunities/stage-draft
POST /api/platform/draft-transport-smoke
```

随后访问：

```text
/review/live?baseline=<LIFT-1 evidence hash>
```

若驱动回执缺失，页面显示等待；若动作结果未知，页面显示
`source_censored`；二者都不会静默切换到合成 fixture。

## 2026-07-29 历史实测结果

2026-07-29 的真实测试课程运行中，LIFT-1 观察到课程壳、7 个分区、20 张卡片，
以及由页面触发的栏目、卡片列表、详情与评论列表只读请求。Chrome 可精确核验课程
地址并读取真实页面结构；分区切换触发长时 SPA 请求后，界面控制连接未能确认后置
条件，因此本次动作按 `unknown_timeout` 封存并停止重放。

同日，在用户明确授权的测试帖子中，Chrome 再次核对目标与当时评论计数，将一条
资源连接草稿写入原生编辑器并完成逐字回读。没有点击发布、没有使用提交快捷键，也
没有触发表单提交。回执状态为
`TRANSPORT_SMOKE_DRAFT_VISIBLE_NOT_SUBMITTED`；草稿正文没有进入本地回执。

这证明当时真实页面接入、去正文结构队列、不确定动作停机和编辑器草稿传输路径
可运行；它不证明该能力已经接入当前自治 tick，不证明测试行为者是学习者、干预
已经发生或产生教育效果。

## 论文研究映射

- 感知：真实 UI / UI 触发 API 的去正文结构证据；
- 择机：当前真实切片可以合法选择 `wait`，后续由连续回执计算 P3A 所需历史；
- 促成：只有语义与历史门槛同时满足后才复用 P4 Intent + MoveSpec；
- 让位：动作未知先停机，提交前仍需重读目标版本和真人回复；
- RQ3：支持真实平台 shadow 条件下的可执行性、可追溯性与失效处置；
- 不回答 RQ4：没有真实发布、随机分配、近端结果窗或教育效果估计。

完整运行状态、资格链、指标和代码复用关系见
[真实 cMOOC 自主促进运行内核 v1](LIVE_FACILITATION_RUNTIME_V1.md)。

## 与当前主线的交接

本文较新的可复用资产包括去正文 observation、事件级 revalidation、短期守卫租约、
STAGE grant 和 transport smoke 证据分级。当前主线应在自然 DRAFT 之后把这些资产
接入同一 `autonomy:tick`，而不是继续维护第二套平行产品流程。接入前，
`/platform → /review/live` 仍是诊断/兼容路径。
