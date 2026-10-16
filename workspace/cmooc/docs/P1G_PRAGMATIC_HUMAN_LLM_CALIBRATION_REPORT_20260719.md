# P1g：现实可行的人机协同校准方案

日期：2026-07-19（Asia/Shanghai）

## 决策

毕业论文不再默认要求两名真人各自编码全部 300 条。300 条继续作为机器全量编码与分布评估样本；真人工作被拆成代码本试编码和独立留出验证两部分。该调整降低工作量，但不把 LLM 自洽误写成准确，也不把单人复测误写成双人信度。

2026-07-19 进一步固定了一个可立即执行的可行性版本：从 300 条盲化批次中按原抽样层比例确定性抽取 50 条人工参考集。选择过程不读取正文和任何功能标签。单人第一遍编码是候选参考标签，只有经独立复核或分歧裁决后才可称为人工参考标准，不使用“单人金标准”表述。

## 为什么修改

强 LLM 在部分开放文本分类任务上可以接近训练后的人类编码者，但不同模型、任务与数据之间差异显著，因此仍需要任务内的人类验证标签。Mellon 等（2024）在开放调查文本上报告了接近人类编码者的强模型表现；Pangakis 与 Wolken（2025）跨 27 个任务发现自动标注质量波动明显，并强调人类验证标签仍是必要基础。

- Mellon et al. (2024): https://doi.org/10.1177/20531680241231468
- Pangakis & Wolken (2025): https://doi.org/10.1609/icwsm.v19i1.35883
- Lin & Zhang (2025) 对效度、信度、可复现性和透明度风险的框架：https://arxiv.org/abs/2503.22040

因此，合理的减法不是取消人类，而是让人类只处理概念校准、独立留出和争议项。

## 三层工作流

### 1. Pilot：可随时停止的试编码

查看器新增“导出当前校准集”。只要至少保存一条即可导出；文件名包含 `pilot-X-of-N`，行状态固定为 `pilot_single_coded` 或 `pilot_double_coded`。

Pilot 可以用于：

- 发现代码本边界是否过细；
- 估计 `yes/no/uncertain` 在当前分层样本中的比例；
- 观察哪些主要功能频繁混淆；
- 估算正式验证的人力。

Pilot 不可以用于：

- 冒充完整编码表；
- 进入原 P1f 全量一致性与最终裁决；
- 同时用来修改提示词又报告模型最终效度。

### 2. Validation：与 pilot 隔离的固定子集

`research_calibration.py plan` 从未进入 pilot 的项目中确定性分层抽取验证子集。默认以 95% 置信水平、二元一致率最保守方差和有限总体修正计算精度代理，并结合 pilot 中 `yes/no` 的出现率，争取每个决定性类别至少获得预设数量。

这是一种工作量规划代理，不是正式 Cohen's kappa 功效分析；输出明确记录 `formal_kappa_power_claimed=false`。若类别稀有、pilot 缺少 `yes` 或 `no`，计划会给出警告，不能假装类别覆盖已经得到保证。

### 3. Agreement：两种设计强制分名

- `inter_rater`：两名不同的独立人类编码者，允许称为编码者间信度。
- `intra_rater`：同一人经过预先记录的间隔后复测，只能称为编码者内重复性。

比较报告同时给出观察一致率、Cohen's kappa、Gwet's AC1、`yes`/`no` 特异一致率、主要功能条件一致性、多标签 Jaccard 和确定性 bootstrap 区间。报告不自动宣布“通过”，也不把任何一方称作金标准。

## 实际命令

### 直接生成 50 条人工参考集（当前采用）

```powershell
$reference = "$env:LOCALAPPDATA\cmooc-research\p1g\human-reference-50-v1"
npm run research:calibration:reference -- `
  --batch-dir "$env:LOCALAPPDATA\cmooc-research\p1d\facilitation-review-300-v1" `
  --output-dir $reference `
  --sample-size 50 `
  --seed "p1g-human-reference-50-v1"
```

已生成的真实选择 ID 为 `d90cd1946eae4661`，分层数量为 `formal_role=18`、`learner_baseline=13`、`learner_p95=12`、`learner_p99=7`。这是基于可行工作量的固定分层抽样，不声称精度或统计功效保证。真实内容定位检查已通过 50/50；无重度遮蔽和疑似截断。

第一轮编码页面：

```powershell
npm run research:review:serve -- `
  -InputRoot "C:\Users\tiany\Nutstore\2\我的坚果云\cmooc研究数据24-25" `
  -CoderId coder_reference_a `
  -Round 1 `
  -SelectionFile "$reference\validation-selection.csv"
```

### 已完成的三遍人工修订

第一遍 50 条快标被原样归档，没有覆盖。其后依据 v1.1 边界规则定向抽取 15 条高风险项目复核；15/15 的至少一个字段发生变化，其中 11 条修改主要功能、10 条修改置信度。第三遍只保留 6 条主要功能边界项，以避免把重复劳动转嫁给编码者。

第三遍结果为：1 条从 `idea_bridging` 改为 `coordination`，2 条从肯定标签改为 `uncertain`，另外 3 条保留上一轮判断。最终合并的 50 条参考候选分布为：`yes=45`、`no=2`、`uncertain=3`；肯定项主要功能为 `resource_seeding=31`、`coordination=8`、`question_guiding=3`、`synthesis=2`、`idea_bridging=1`。所有次要功能已删除。

该结果表明第二遍复核显著修正了第一遍快标，但没有把单人重复判断变成客观真值。第三遍中仍有两条被编码为 `coordination` 的项目与 v1.1 中“方法文章/结束活动回顾不自动构成协调”的示例边界冲突；另有 3 条保持 `uncertain`。这些项目应在未来独立复核时优先检查，当前不得作为硬标签训练或效度评分依据。

合并命令：

```powershell
$archive = "$env:LOCALAPPDATA\cmooc-research\p1g\human-fastpass-d90cd1946eae4661-20260719"
npm run research:calibration:finalize-reference -- `
  --batch-dir "$env:LOCALAPPDATA\cmooc-research\p1d\facilitation-review-300-v1" `
  --base-selection "$env:LOCALAPPDATA\cmooc-research\p1g\human-reference-50-v1\validation-selection.csv" `
  --base-annotations "$archive\human-fastpass-round1.csv" `
  --targeted-selection "$archive\targeted-semantic-review-15.csv" `
  --targeted-annotations "$archive\targeted-semantic-review-15-round1.csv" `
  --final-selection "$archive\final-primary-adjudication-6.csv" `
  --final-annotations "$archive\final-primary-adjudication-6-round1.csv" `
  --output-dir "$env:LOCALAPPDATA\cmooc-research\p1g\human-primary-reference-v1-1"
```

输出 `human-primary-reference.csv` 与 `reference-manifest.json`。清单固定声明 `gold_standard_claimed=false`、`independent_human_review_completed=false`、`secondary_functions_retained=false`，并记录三轮输入和代码本的 SHA-256。

### 导出并验证当前 pilot

在盲审页面点击“导出当前校准集”，然后运行：

```powershell
npm run research:review:validate -- `
  --batch-dir "$env:LOCALAPPDATA\cmooc-research\p1d\facilitation-review-300-v1" `
  --annotations "C:\local\pilot.csv"
```

验证结果必须显示 `completion_scope=pilot`。

### 生成正式留出子集

```powershell
$plan = "$env:LOCALAPPDATA\cmooc-research\p1g\validation-plan-v1"
npm run research:calibration:plan -- `
  --batch-dir "$env:LOCALAPPDATA\cmooc-research\p1d\facilitation-review-300-v1" `
  --pilot-annotations "C:\local\pilot.csv" `
  --output-dir $plan
```

输出：

- `calibration-plan.json`：依据、估计、警告、推荐重叠量与 selection ID；
- `validation-selection.csv`：只含盲化项目号和原显示序号，不含正文、作者、课程或角色。

### 编码正式验证子集

第一轮：

```powershell
npm run research:review:serve -- `
  -InputRoot "C:\Users\tiany\Nutstore\2\我的坚果云\cmooc研究数据24-25" `
  -CoderId coder_validation_a `
  -Round 1 `
  -SelectionFile "$plan\validation-selection.csv"
```

第二名独立编码者只需对同一 selection 运行 Round 2，并使用不同 CoderId。若确实无人可协助，同一编码者可在预先记录的间隔后使用同一 CoderId 运行 Round 2，但后续只能选择 `intra_rater`。

### 比较

双人设计：

```powershell
npm run research:calibration:compare -- `
  --batch-dir "$env:LOCALAPPDATA\cmooc-research\p1d\facilitation-review-300-v1" `
  --selection-file "$plan\validation-selection.csv" `
  --coder-a "C:\local\validation-round-1.csv" `
  --coder-b "C:\local\validation-round-2.csv" `
  --design inter_rater `
  --output-dir "$env:LOCALAPPDATA\cmooc-research\p1g\comparison-inter-v1"
```

单人间隔复测：

```powershell
npm run research:calibration:compare -- `
  --batch-dir "$env:LOCALAPPDATA\cmooc-research\p1d\facilitation-review-300-v1" `
  --selection-file "$plan\validation-selection.csv" `
  --coder-a "C:\local\validation-round-1.csv" `
  --coder-b "C:\local\validation-round-2.csv" `
  --design intra_rater `
  --washout-days 14 `
  --output-dir "$env:LOCALAPPDATA\cmooc-research\p1g\comparison-intra-v1"
```

## 安全与防误用

- 原 P1f 全量比较仍要求两份完整 300 条文件、不同编码者和既定 round/status；pilot/validation 文件不能混入。
- selection 文件若位于仓库/同步目录、列结构错误、含未知 review ID 或重复项，查看器拒绝启动。
- selection 会产生独立 draft 文件，避免与完整 300 条草稿混用。
- 所有导出继续只含盲化 ID 和标签，不含论坛正文或身份字段。
- P1h 已按用户决策实现带显式远程授权和主机锁定的在线模型盲标运行器；合成 probe 已通过，但真实研究内容尚未被允许传输。不得因“模型看起来更一致”而跳过人工参考与效度检验。

## 自动化验收

- `npm run verify` 通过：8 项单元测试、3 项数据库集成测试、29 项研究工作流测试。
- `npm run build` 通过，Next.js 生产构建完成 23 个静态页面生成任务。
- 50 条真实选择的 `CheckOnly` 通过：50/50 内容定位，31 条含需净化线索，累计 90 次替换，无重度遮蔽和疑似截断，正文不持久化。
- 独立无头 Chromium 在 1440×1000 与 390×844 下均显示 `0/50`，无横向溢出、无控制台错误。验收截图在检查后立即删除，避免将论坛正文写入同步项目。

## 对论文可声称内容的约束

可以声称：建立了现实可实施、可追溯、严格区分 pilot/validation 和 inter/intra-rater 的校准基础设施。

暂时不能声称：LLM 比人类更准确、促进功能分类已经有效、验证子集代表全部 14 万条内容、或模型输出可以直接驱动线上干预。
