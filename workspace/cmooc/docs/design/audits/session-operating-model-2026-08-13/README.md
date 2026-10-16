# Workbench 运营身份与 Session 模型审计

审计日期：2026-08-13

## 结论

当前 Workbench 的安全底座已经足够支持运营产品，但信息展示与任务心智模型仍偏“内部运行控制台”：课程名称在课程世界页可见，却没有稳定回流到 Workbench；参与者统一匿名化，无法直接帮助运营者在论坛中定位对象；同一个输入区同时承担新建运行、页面命令和继续线程三种语义；完成后的“继续任务”在进程会话消失时实际会创建新的子运行和新的 Codex thread。

建议把隐私边界从“所有界面都匿名”调整为“按消费者分层”：授权运营界面显示真实课程、帖子与成员定位信息；模型只接收用户明确附加的必要内容；日志、receipt、研究导出继续只保存哈希和安全引用。

Session 产品模型建议改为 Codex 式四层：

1. Task / Thread：用户可见的持久任务和对话。
2. Turn：一次用户输入及智能体回答。
3. Run / Attempt：某个 Turn 的执行、重试或恢复尝试。
4. Item：消息、工具调用、审批、成果和验证事件。

现有 `rootRunId` 可先作为 Task 分组键，现有 Run 保留为内部 Attempt；不必立即重建全部持久层。

## 实际界面证据

### 1. 初始页

![Workbench 初始页](./01-workbench-idle.png)

- “当前课程”没有稳定显示课程名称。
- 主按钮为“启动研判”，但系统实际还可生成成果、准备暂存和处理课程运营任务，名称过窄。
- 优点：入口克制，输入任务很直接，真实发布关闭也清晰。

### 2. 已完成任务

![已完成任务](./02-completed-run.png)

- 页面同时出现“继续任务”和底部任务输入，用户难以判断是在同一任务中继续、创建新任务，还是恢复旧运行。
- 左侧按运行罗列，测试/fixture 运行也进入历史，削弱真实运营感。
- 计划、成果和验证的折叠结构方向正确，但应归属于持久 Task，而不是孤立 Run。

### 3. 已绑定课程快照的任务

![课程任务](./03-bound-course-run.png)

- 已绑定课程上下文，但仍主要显示“课程世界快照”等技术标签，课程实名与帖子定位信息不突出。
- 完成任务后输入区仍使用新任务式动作文案，线程语义不稳定。

### 4. 课程世界页

![课程世界与匿名网络](./04-course-world-network.png)

- 课程世界页已经可以显示真实课程名，证明 Course → manifest 的本地可信映射已经存在。
- 网络明确采用匿名节点，适合研究展示或演示，但不够支持运营人员寻找实际帖子与账号。
- 图形可读、焦点样式清晰；小号低对比说明文本需做计算对比度复核。

## 代码事实

- 课程、论坛用户和课程成员表已经包含课程名、平台课程 ID、成员显示名和论坛用户 ID：`prisma/schema.prisma`。
- `loadVerifiedOperatorCourseNames` 已能按 manifest 精确绑定读取课程名称：`lib/autonomy/operator-course-name.ts`。
- 课程世界读模型将参与者强制投影为“学习者 01”等本地匿名标签：`lib/autonomy/world-read-model.ts`。
- 新事件世界中的 actorKey 由受保护稳定键派生，当前没有从该键到运营者可见身份的授权反查层：`lib/world/live-event.ts`。
- Opportunity Canvas 的“交给学伴研判”只附加 context、预填 prompt 并关闭面板，并不启动任务：`components/workbench/AgentWorkbench.tsx`。
- 底部输入按状态执行三种不同动作：本地页面命令、steer 当前内存 session、或创建新 run：`components/workbench/AgentWorkbench.tsx`。
- 每个 run 都调用 `thread/start`；配置显式关闭 history persistence 和 memories，未使用 `thread/resume` / `thread/fork`：`lib/workbench/codex-app-server.ts`。
- 只要进程内 session 尚在，完成任务可以 reopen 并在同一临时 thread 中 steer；session 消失后，“继续任务”会创建 continuation child run，并明确不得声称恢复旧 thread：`lib/workbench/run-store.ts`、`lib/workbench/launch.ts`。

## 推荐 MVP

### A. 运营定位信息

默认在 Workbench 顶部和任务上下文卡显示：

- 真实课程名称；
- 帖子标题、作者显示名、平台账号标识、发布时间；
- “在平台中打开”“复制账号”“查看原文”动作；
- 数据观察时间与来源状态。

正文采用按需展开的同源 `no-store` 预览。授权运营者可以看，但不自动进入模型输入、SSE、普通日志、receipt 或导出。用户点击“附加到任务”时，才把选定正文作为本 Turn 的受控上下文。

### B. 文案与动作

- 空白页“启动研判”改为“运行任务”或“开始任务”。
- 当前 Task 内的提交按钮统一为“发送”；运行中是“追加要求”。
- “交给学伴研判”改为“带入新任务”，除非点击后真的立即创建任务。
- “继续任务”在 UI 中表现为同一 Task 的下一 Turn；只有失败/中断才显示“恢复任务”。
- 显式提供“新任务”和“从这里分叉”。

### C. Session 映射

```text
Task / Thread
├─ Turn 1
│  └─ Run attempt 1
├─ Turn 2
│  ├─ Run attempt 1 (failed)
│  └─ Run attempt 2 (recovered)
└─ Artifacts / approvals / evidence
```

第一阶段不迁移数据库：按 `rootRunId` 聚合历史，把 child run 渲染成同一任务里的 Turn/Attempt；输入区始终绑定当前 Task；继续操作仍可复用现有 child-run 机制。第二阶段再持久化 Codex thread ID，接入 `thread/resume`、`thread/fork` 和 task-level artifact workspace。

## 优先级

1. 课程实名稳定回流 Workbench；侧栏按 root task 分组并过滤 synthetic/test runs。
2. 修正文案与输入区状态，消除“启动研判 / 继续任务 / 继续对话”重叠。
3. 增加运营者身份目录与帖子定位卡；正文只按需预览和显式附加。
4. 用现有 `rootRunId` 做 Task / Turn 视觉模型。
5. 后续再实现 durable Codex thread resume/fork。

## 可访问性与证据边界

- 保留现有 focus-visible 和键盘图节点浏览，这是当前明确优势。
- 需要实测小号灰字、状态文字与边框的 WCAG 对比度；截图只能提示风险，不能替代计算。
- 对输入按钮提供稳定、动作导向的 accessible name，避免读屏用户无法判断“新建”还是“继续”。
- 本审计未读取凭据、Cookie、论坛正文或个人身份信息，也未执行任何外部发布或修改。
