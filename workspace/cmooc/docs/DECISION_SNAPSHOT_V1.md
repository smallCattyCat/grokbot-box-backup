# intervention decision snapshot v1

## 研究对象与证据边界

`decision_snapshot_v1` 把全体论坛主帖转换为固定真实时钟的离线决策样本。每个样本回答：

> 在主帖发布后 22 小时，只使用当时及以前可见的结构状态，有限预算的调度器应优先把哪些线程送入人工干预判断？

该数据用于评估调度选择性和工作量分配，不把历史相关性解释为智能学伴干预的因果效应。旧 `trigger_snapshots` 按最终线程的 25%/50%/75% 前缀产生，且只覆盖互动充分线程，因此不进入本流程的特征、标签或调参。

原始导出是最终快照，没有 `available_from`、编辑版本或删除版本。为避免把编辑后正文当成早期信息，v1 不使用正文关键词、最终点赞数、最终回复总数、最终网络中心性或最终全线程编码。成员名册没有角色有效区间，身份只保留为以后敏感性分析的来源，不进入主分析特征。

## 只读可行性审计

正式来源固定为：

```text
<local-research-data-root>
  ├─ 01_原始数据\数据统计
  └─ 03_分析数据\full_2026
```

审计得到 12,627 个具有稳定 `year + course_id + module_id` 和可解析发布时间的主帖。评论使用 `year + course_id + module_id + comment_id` 作为原始稳定键；直接父节点优先取 `comment_reply_child_id`，为空或 `-1` 时取 `comment_reply_id`。

| 项目 | 2024 | 2025 |
|---|---:|---:|
| 可用主帖 | 9,925 | 2,702 |
| 评论原始行 | 73,534 | 38,764 |
| 外部首次回应线程 | 7,896 | 2,392 |

两年各有 1 条主帖行和 1 条评论行缺少稳定键。合并审计发现 592 条评论找不到导出中的主帖，作为 orphan 保留在审计计数但不构造快照；33,892 条回复关系中 33,882 条可在同线程解析父节点。

原始时间没有正式时区字段。v1 将其标记为 `naive_platform_local_time_no_dst_adjustment`，只计算同一平台时间轴上的间隔，不擅自补写时区。

## 决策时点与结果窗口

只用 2024 开发集上“主帖作者以外的用户首次回应”分布冻结时钟：

| 分位数 | 2024 首次回应小时 | 2025 时间留出小时 |
|---|---:|---:|
| P50 | 5.307 | 1.696 |
| P75 | 21.921 | 10.225 |
| P90 | 85.871 | 27.877 |

冻结规则如下：

- 决策时点：2024 P75 向最近整小时取整，即主帖后 22 小时；
- 观察终点：2024 P90 向最近整小时取整，即主帖后 86 小时；
- 结果窗口：`(t, t + 64h]`；
- 2025 数据不参与时点、规则或预算选择，只作时间留出。

`t` 时刻发生的事件属于特征侧；结果窗口左开右闭，避免同一事件同时成为特征和结果。

## as-of 特征契约

| 字段组 | 允许的最大事件时间 | 说明 |
|---|---|---|
| 主帖状态 | `post.created_at <= t` | 只使用稳定键、作者键和发布时间 |
| 线程评论与外部回应计数 | `comment.created_at <= t` | 外部回应指作者不同于主帖作者 |
| 回复边与深度 | 父、子节点均 `<= t` | `t` 时无法解析父节点的引用不计入深度；审计只记录当时的 unresolved 状态，不查询该节点后来是否出现 |
| 作者历史帖子 | `prior_post.created_at < t` | 当前线程排除 |
| 作者历史已观测回应 | `first_external_response_at <= t` | 不读取该作者历史线程在 `t` 后的最终结果 |
| 作者历史成熟缺口 | `prior_post + 86h <= t` | 只有结果窗口已经完整结束的历史线程才计数 |
| 课程近 7 日活动 | `(t - 7d, t]` | 只统计已发生的帖子和外部评论 |

构建器对每行生成只覆盖上述特征的 `feature_hash`，并在测试中验证：添加 `t` 后事件可以改变结果，但不能改变特征哈希。课程近 7 日窗口使用严格左开边界，恰好位于 `t-7d` 的帖子或评论不会计入。正式输出字段经过白名单校验；正文、原始 ID 和最终快照字段无法进入 CSV。

除线程结构的 Python/SQL oracle 外，构建还独立重算作者历史、课程 7 日活动和来源数据终点等 7 个字段，并与 12,627 条正式快照逐行比较。`decision-clock-audit.json` 只审计稳定键和决策时钟，不伪装成行级事件 provenance；实际防泄漏证据由逐行 builder 边界不变量、SQL oracle、history-feature audit 和精确边界测试共同提供。

## 结果与调度基线

主结果代理为：

```text
support_gap_at_horizon =
  在 t 时尚无外部回应，且截至主帖后 86 小时仍无外部回应
```

`organic_external_response_in_window` 表示线程在没有本项目真实干预的历史中，于结果窗口自然获得外部回应。调度器选中这类线程时记入“不必要介入率”代理。该名称描述离线资源错配，不表示介入在现实中一定无价值。

`scheduler replay v2` 不再让策略一次看到整日候选。候选在精确 `decision_at` 到达，按 30 分钟 tick 处理，正式 benchmark 的候选 TTL 为一个 tick；每 tick 最多 1 条，每日预算 `K ∈ {1, 3, 5}`。若真人回应已在 tick 前发生，候选先撤回；若来源数据没有完整观测到该 tick，候选按行政删失移出，不把未观测状态当作无回应。两个事件分别由精确整数微秒字段重建，均不进入策略视图。策略只能读取严格过去动作和已成熟结果。

透明比较集包含 `fifo`、固定种子随机、纯结构评分、现有手工结构思想、最久未触达作者优先和带 7 日冷却的约束结构策略。指标分开报告日级宏平均与年度微平均 Precision@K，并加入预算利用率、1/7/28 日重复触达、作者暴露 HHI/Gini、月份/课程切片及跨年度差值。完整回放契约见 [scheduler replay v2](SCHEDULER_REPLAY_V2.md)。

## 小型人工 decision-reference

首轮固定上限 60 条，每年 30 条。抽样在每年内同时覆盖：

- 结构评分低/中/高三档；
- 后续自然回应/持续回应缺口两类观察结果；
- 尽量不同的作者。

编码表隐藏未来结果，只要求填写三个字段：

1. `intervene`：`yes / no`；
2. `main_function`：`resource_connection / cognitive_conflict / emotional_support / none`；
3. `target_object`：`thread_author / specific_participant / thread_participants`。

分层只用于选择成员。成员确定后，显示顺序仅由匿名 `snapshot_key` 的域分离 SHA-256 排列产生，`DR001..` 随该盲序分配，不按年度、层号或未来观察结果成组。`reference-manifest.json` 保存成员集合摘要、顺序摘要和算法版本；后续 P3A/P3B 入口均验证它们。旧版无摘要批次只有在三项标签全空时才可保持成员不变做一次盲序迁移，已有任一标签则拒绝改排。

完成首批后停止，不自动扩大编码规模。这个 reference 用于确定“是否介入、何种促进功能、面向谁”，不把教师、助教或历史促进者设成等级身份。

## 本地命令与产物

只读审计：

```powershell
npm run research:decision -- audit
```

构建全部本地产物：

```powershell
npm run research:decision -- all
```

分步运行：

```powershell
npm run research:decision -- build
npm run research:decision -- benchmark
npm run research:decision -- reference
npm run research:decision -- status
npm run research:decision-review -- check --json
```

默认输出：

```text
%LOCALAPPDATA%\cmooc-research\p3a\decision-snapshot-v1
```

其中 `decision_snapshots.csv`、`manifest.json`、`source_audit.json`、`audit-v2`、`benchmark-v2` 和 `reference\decision-reference-60.csv` 均不写入 Git。正式 manifest 只保存受控来源摘要与占位路径，不写本机用户名或绝对目录。HMAC 密钥仅保存在本机 `%LOCALAPPDATA%\cmooc-research\secrets`。人工标注台及其 label-only 输出见 [decision-reference v1](DECISION_REFERENCE_V1.md)。
