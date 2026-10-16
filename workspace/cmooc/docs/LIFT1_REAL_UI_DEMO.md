# LIFT-1 真实界面只读演示

- 验证日期：`2026-07-29`
- 文档更新：`2026-07-31`
- 状态：`READ-ONLY DIAGNOSTIC / COMPATIBILITY ENTRY`

LIFT-1 是 `感知—择机—促成—让位` 产品链的真实平台入口预检。它不保存论坛正文，
不调用真实发布，也不把页面可读性解释为教育效果。当前产品主入口已经是
`/autonomy`；LIFT-1 继续负责独立页面诊断，不代表 `autonomy:tick` 已使用同一
Computer Use 会话。

## 为什么需要这一层

浏览器地址可能来自地址栏、Markdown 链接或包含多个 URL 的聊天文本。把原字符串直接交给浏览器或白名单校验，会把合法课程目标误解析成错误路径。LIFT-1 先提取候选 URL，再按允许来源、`/cMOOC/course` 路径和 `courseId` 重建规范目标；最终导航结果还会再次核对来源、路径和完全相同的 `courseId`。同路径跳到另一门课程会 fail closed。

原型采用可替换的 UI-native 界面代理契约：Chrome 提供可信 URL、`courseId` 与 DOM 身份，Computer Use 负责真实页面操作，确定性 Chromium 提供只读网络守卫和实时降级。三者输出同一种去正文回执；不会只凭窗口标题判断页面，也不会在失败时切换到 mock。完整结构见 [Computer Use 真实平台 shadow 纵向切片](COMPUTER_USE_LIVE_SHADOW.md)。

## 页面入口

启动应用后访问：

```text
http://127.0.0.1:3000/platform
```

首次粘贴课程地址后，规范 URL 只保存在当前浏览器的 `localStorage`，下次进入页面会自动运行预检。也可以在本机环境中设置 `CMOOC_DEMO_COURSE_URL`，不把真实课程 ID 写入仓库。

页面只报告实际观察到的能力：

- `overview_ready`：课程壳、分区和至少一张卡片可见；
- `shell_only`：课程壳可见，但当前会话未读取到卡片；
- `blocked`：真实课程壳未通过核验。

帖子详情未进入时会显示 `not_available_public_session` 或其他明确状态，不会把卡片存在冒充为帖子语义可读。

## 命令行预检

```powershell
npm run demo:lift -- --target-url "<粘贴浏览器地址或包含链接的文本>"
```

或：

```powershell
$env:CMOOC_DEMO_COURSE_URL = "<课程地址>"
npm run demo:lift
```

正式去正文回执保存在：

```text
%LOCALAPPDATA%\cmooc-research\lift1\evidence-v1\
```

回执不包含课程 ID、帖子标题、作者、正文、Cookie、token 或截图。

## 网络与写入边界

界面代理只允许：

- 同源 GET / HEAD；
- 平台明确用于读取的 POST：`checkTokenValid`、`sketch/page`、`comment/list`。

`comment/commentModule`、`comment/commentReply`、加入课程和其他非白名单请求全部被阻断。除此之外，代码级真实写入硬锁同时覆盖：

- 设置接口；
- 单次发布授权接口；
- 发布接口；
- publisher agent 的真实模式入口和远端调用前复核；
- 浏览器发布适配器；
- cMOOC API 的加入课程、主评论和评论回复写入口。

解除硬锁必须显式修改 `lib/forum/real-write-lock.ts` 并重新运行测试；环境变量、数据库旧值或旧授权均不能绕过。

## 2026-07-29 实测边界

在预绑定测试课程的公开会话中，真实只读探针观察到：

- 课程壳可见；
- 7 个内容分区；
- 20 张当前可见卡片；
- 栏目、卡片列表、详情和回复列表的只读 API 协同；
- 公开未登录会话没有进入详情界面；
- 外部写入尝试为 0；
- `realPublishEnabled=false`；
- 回执不含论坛正文。

这些观察只证明该时点的真实界面结构接入可行，不证明候选正确、干预有效、真人回应识别完成或长期平台可靠性。

## 兼容诊断演示

1. 打开“平台”，页面自动重跑已保存课程的真实预检。
2. 展示入口归一化：即使粘贴混合 Markdown 文本，也会锁定规范课程入口。
3. 展示真实结构：课程壳、分区数、卡片数和当前会话边界。
4. 展示 API 辅助痕迹：API 是界面代理的具名辅助，不是产品主通道。
5. 展示详情能力分级：未达到详情时正确停止，不生成语义候选。
6. 展示零写回执和代码级发布硬锁。
7. 进入 `/review/live` 兼容队列，展示这次真实观察为何等待、为何没有生成
   Intent/MoveSpec/草稿，以及动作超时后停止重放的回执；
8. 回到 `/autonomy` 核对当前真实只读 World/Graph 和 ABSTAIN/YIELD；两套回执未
   合流前不得拼成一个完成的 DRAFT/STAGE 演示；
9. `/review` 的合成 P4D-1/P4F-lite 只作为研究复现。

学习者在当前开发模式下看不到任何系统内容。未来获得真实试运行授权并解除硬锁后，学习者只会在平台原生讨论界面看到最终一次性发布的促进回复，不会看到控制台、候选分数或内部理由。

## 产品与论文映射

- 感知：LIFT-1 真实 UI 结构预检与去正文观察回执；
- 择机：现有 P3A 时点、预算、覆盖和冷却调度；
- 促成：P4/兼容路径已有 Intent + MoveSpec 与 renderer 契约；当前自治 tick 尚无
  真实 DRAFT；
- 让位：当前自治 tick 已有结构性 ABSTAIN/YIELD，兼容路径另有提交前重读；二者
  尚待合流；
- RQ3：补充真实 UI、只读、shadow 条件下的实施链可追溯性；
- 不回答 RQ4：当前没有真实发布、随机分配或结果窗口。
