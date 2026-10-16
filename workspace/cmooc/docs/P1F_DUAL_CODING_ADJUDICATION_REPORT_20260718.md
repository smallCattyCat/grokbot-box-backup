# P1f 双编码一致性与盲态裁决门禁

日期：2026-07-18（Asia/Shanghai）

## 结论

P1f 已完成双人独立编码后的机械处理链路，但没有生成任何真实标签。工具分别校验第一轮 `single_coded` 和第二轮 `double_coded` 编码表，要求两个不同编码者代号完整覆盖同一 P1d 批次，然后计算分阶段一致性并生成不含论坛身份和正文的裁决表。`CoderId` 必须使用预先分配的假名代号，不能填写编码者真实姓名。

真实的 300 条双人编码尚未发生，因此当前不能报告经验一致性数值，也不能写入 `event_function_score`。P1f 的作用是预先固定统计口径和裁决门禁，避免看到结果后改变算法。

## 统计口径

| 层次 | 分析集合 | 指标 |
|---|---|---|
| 促进功能存在性 | 全部项目 | 三分类观察一致率、Cohen’s κ、混淆矩阵 |
| 主要功能 | 两人均判为 `yes` 的项目 | 九分类观察一致率、Cohen’s κ、混淆矩阵 |
| 次要功能 | 两人均判为 `yes` 的项目 | 集合完全一致率、逐条 Jaccard 的均值与中位数 |
| 置信度 | 全部项目 | 两名编码者均值、低于 0.60 的数量 |

κ 与平均 Jaccard 使用固定种子的 2,000 次配对非参数 bootstrap 百分位区间。固定种子由批次标识和指标名派生，同一输入会得到相同结果。如果边际分布没有变异，κ 的分母为零，工具会返回 `null` 和 `degenerate_marginals=true`，不会把 100% 观察一致率伪装为可估计的 κ。

这些是预先定义的描述性一致性指标，不进行显著性检验，也不套用脱离语境的“较好/优秀”阈值。主要功能和次要功能只在双方均判为 `yes` 的条件子集中计算，报告必须同时给出该子集的 `n`，不能把它误称为全部 300 条的一致性。

## 裁决触发规则

任一条件满足即进入裁决：

- `facilitation_present` 不一致；
- 双方均为 `yes`，但主要功能不一致；
- 双方均为 `yes`，但次要功能集合不一致；
- 任一编码者置信度低于 0.60。

裁决表只包含盲化项目号、分歧代码、A/B 两侧标签和空白裁决字段。它不包含编码者真实身份、作者、课程、平台角色、来源、长度、帖子正文或后续互动结果。裁决者只能填写合法功能标签、0—1 置信度、代号和下列理由码之一：

- `consensus_after_review`
- `evidence_favors_a`
- `evidence_favors_b`
- `insufficient_context`

裁决表的来源列不可修改；最终化时会重新读取原始双编码表、验证 SHA-256 并逐字段重建预期分歧。最终共识表中，无分歧项目保留 `double_coded`，置信度取两名编码者的较小值；分歧项目标为 `adjudicated`。最终表仍须通过 P1d 的完整校验器。

## 使用方法

输出目录必须位于 `%LOCALAPPDATA%\cmooc-research\p1f`，不能位于项目、同步目录或 UNC 路径。

```powershell
$comparison = "$env:LOCALAPPDATA\cmooc-research\p1f\facilitation-review-300-r12-v1"

npm run research:review:compare -- `
  --batch-dir "$env:LOCALAPPDATA\cmooc-research\p1d\facilitation-review-300-v1" `
  --coder-a "C:\local\coder-a-round-1.csv" `
  --coder-b "C:\local\coder-b-round-2.csv" `
  --output-dir $comparison
```

比较完成后会生成：

- `agreement.json`：不含编码者代号的聚合一致性结果；
- `comparison-manifest.json`：本机保存的批次与输入哈希契约；
- `adjudication.csv`：仅包含需要裁决的盲化项目。

裁决者填写原目录中的 `adjudication.csv` 后运行：

```powershell
npm run research:review:finalize -- `
  --batch-dir "$env:LOCALAPPDATA\cmooc-research\p1d\facilitation-review-300-v1" `
  --coder-a "C:\local\coder-a-round-1.csv" `
  --coder-b "C:\local\coder-b-round-2.csv" `
  --comparison-dir $comparison `
  --adjudications "$comparison\adjudication.csv"
```

输出 `final-adjudicated.csv` 与 `final-summary.json`。此步骤仍不连接私有事件映射，也不写数据库。

## 自动化验证

专项测试覆盖：

- 已知存在性、主要功能、次要功能和低置信度分歧；
- 分阶段样本量与指标口径；
- κ 退化边际返回不可估计；
- 两个编码表来自同一编码者时拒绝；
- 裁决来源列被修改时拒绝；
- 最终共识表再次通过 P1d 表头、枚举、项目集和字段约束。

## 下一门槛

P1f 之后唯一不能由程序代替的工作是：两名获授权编码者独立完成真实 300 条编码，并由第三方或预先指定人员完成分歧裁决。在这些文件存在以前，不能计算真实一致性、训练促进功能识别模型、写入事件标签库或改造在线智能体人格。

## 2026-07-19 后续修订

P1f 的 300 条全量双编码器仍被保留为严格可选方案，但不再是默认毕业论文门槛。P1g 改为：partial pilot 只用于修订代码本；正式一致性在未见过的、功效/精度驱动的固定子集上计算；若没有第二名编码者，则只报告同一编码者的间隔复测重复性。原 `research:review:compare/finalize` 继续拒绝 pilot 与 validation 子集，防止小样本文件冒充全量共识数据。新流程见 [P1g 报告](P1G_PRAGMATIC_HUMAN_LLM_CALIBRATION_REPORT_20260719.md)。
