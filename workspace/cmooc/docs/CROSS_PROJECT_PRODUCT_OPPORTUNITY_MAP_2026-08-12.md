# cMOOC 智能学伴跨项目产品机会地图

- 审计日期：2026-08-12
- 主产品：`cMOOC智能学伴自动干预系统`
- 面向用户：教师、课程运营者、研究者
- 审计方式：只读目录盘点与关键文档、聚合结果、契约和代码抽样
- 安全边界：未读取或复述凭据、Cookie、token、登录态、论坛正文、真实身份、原始作业、私有数据库或未经去标识的学习者内容

本文使用三种标签：

- **事实**：可由本地文件、代码或去标识聚合结果直接核对。
- **推断**：由多个事实组合得到，仍需产品验证。
- **建议**：产品与实施取舍，不是已有研究结论。

## 1. 一页结论

**事实**：当前主产品已经具备定时巡检、事件世界与 Graph、四态决定、受约束草稿、写前重读、发布硬锁、结果回流、异常治理、任务恢复和自然语言页面操作等底层能力，但这些能力分散在 `/autonomy/*`、`/review/live` 与智能控制台中，教师首先看到的是运行结构，而不是“今天需要判断什么”。

**推断**：产品的首要缺口不是再增加一张驾驶舱，而是建立一个面向真实工作节奏的入口：把同一课程、同一巡检、同一世界快照下的异常、证据边界、成熟支持缺口、结果核对和可让位事项，压成一份很短的任务简报；用户需要时再展开证据 Canvas，并可把精确证据锚点交给智能学伴继续研判。

**建议**：近期第一优先纵向切片为“今日课程简报 → 机会 Canvas → 精确证据/交给学伴”。保持现有 ChatGPT 式极简控制台，不新造汇报大屏。课程画像、互动结构、质量瀑布和研究复现作为后续 Canvas 能力，而不是并列一级页面。

## 2. 项目资产地图

体量是跳过 `.git`、`node_modules`、构建缓存、原始数据、数据库和明显敏感目录后的安全元数据估计，不等于物理总量。

### 2.1 直接相关项目

| 项目 | 安全体量概览 | 代表性证据 | 已有能力/资产 | 可复用价值 | 风险与边界 |
| --- | ---: | --- | --- | --- | --- |
| [cMOOC智能学伴自动干预系统](C:/Users/tiany/Nutstore/2/我的坚果云/cMOOC智能学伴自动干预系统) | 约 9,890 文件 / 305 MiB | [PRODUCT_CURRENT.md](C:/Users/tiany/Nutstore/2/我的坚果云/cMOOC智能学伴自动干预系统/源码/docs/PRODUCT_CURRENT.md)、[AUTONOMOUS_PRODUCT_MASTER_PLAN.md](C:/Users/tiany/Nutstore/2/我的坚果云/cMOOC智能学伴自动干预系统/源码/docs/AUTONOMOUS_PRODUCT_MASTER_PLAN.md) | 定时巡检、World/Graph、CandidateSet、四态决定、重读、治理、结果回流、持久任务 | 产品主链、页面框架、证据与执行契约 | 真实发布仍硬锁；离线或单次路径不等于教育效果 |
| [cmooc智能体BJET81](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc智能体BJET81) | 约 56,000 文件 / 1.9 GiB | [EVIDENCE_INDEX.md](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc智能体BJET81/项目开发留档/current/EVIDENCE_INDEX.md)、[世界观察台审计](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc智能体BJET81/项目开发留档/current/reports/progress/WORLD_MODEL_OBSERVATORY_SCHEME_AND_INTERFACE_AUDIT_2026-07-19.md) | CanonicalEvent、WorldSnapshot、replay、checkpoint、receipt、未来泄漏哨兵 | 教学事件时间线、证据重放、精确快照锚点、研究导出 | Lane B 与观察台包含模拟/合成验证；不得包装成数字孪生或真实效果 |
| [cmooc智能体BJET](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc智能体BJET) | 约 2,382 文件 / 22 MiB | [当前 README](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc智能体BJET/项目开发留档/current/README.md)、[PLAN.md](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc智能体BJET/项目开发留档/current/PLAN.md) | 早期/并行 BJET 工程基线 | 用于追溯契约来源和避免回归 | 与 BJET81 高度重复，不能重复计为独立证据 |
| [cmooc群体形象](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc群体形象) | 约 10,900 文件 / 1.4 GiB | [QA_REPORT.md](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc群体形象/00_最新成果_JCAL_v3_2026-08-02/QA_REPORT.md)、[课程画像图契约](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc群体形象/jcal_manuscript_revision_2026-08-01_v1.4/02_FIGURE_CONTRACTS.md) | 双分母覆盖、unsupported 质量、compatible range、eligible/LCB | 支撑感知课程画像、解释“看见多少、还不能说什么” | A–D 课程证据范围很宽；不能形成稳定个体画像或全课强解释 |
| [cmooc沉睡想法AI前视研究](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc沉睡想法AI前视研究) | 约 22,000 文件 / 2.5 GiB | [当前研究入口](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc沉睡想法AI前视研究/00_当前研究入口.md)、[正式召回结果](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc沉睡想法AI前视研究/10_2024正式召回结果_v1_2026-08-02/README.md) | 72h 后跨线程想法发展、固定候选池、review budget、人工终审 | 中期“沉睡想法候选收件箱”和可复现实验 | idea-level recall 83.3%，未达 .90 工程门；只能回顾性/shadow，不能自动干预或称预测 |
| [cmooc教育LLM评估](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc教育LLM评估) | 约 1,600 文件 / 164 MiB | [MeasureBench README](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc教育LLM评估/analysis/cmooc_measurebench_2026-07-29/README.md)、[scorer.py](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc教育LLM评估/analysis/cmooc_measurebench_2026-07-29/src/scorer.py)、[CommunityWorldBench README](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc教育LLM评估/analysis/community_worldbench_2026-07-29/README.md) | label→format→evidence→relation→time→support 质量瀑布、正确弃答、UNKNOWN、strict-prefix 世界状态 | AI 建议旁的证据瀑布、质量守门、按用途评估 | benchmark 通过率不是课程效果或模型总冠军；生产域迁移需再验证 |
| [cmooc的其他研究](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc的其他研究) | 约 12,700 文件 / 2.3 GiB | [当前 Route2 状态](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc的其他研究/00_最新成果_2026-07-19/08_原始方案自动化管线/CURRENT_ROUTE2_MEASUREMENT_STATE.md)、[自动化契约](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc的其他研究/00_最新成果_2026-07-19/07_研究推进/AUTOMATION_PIPELINE_CONTRACT_v0_1.yaml) | 五类互动贡献功能、显式 ABSTAIN、时间安全前缀、分层/权重/审计 | 互动机会标签、教学事件时间线、质量覆盖率与研究导出 | “72h 明确回复”是历史操作化；不等于曝光、学习、因果或实时真值 |
| [基于cmooc的第三个研究](C:/Users/tiany/Nutstore/2/我的坚果云/基于cmooc的第三个研究) | 26 文件 / 0.46 MiB | [执行蓝图 v0.2](C:/Users/tiany/Nutstore/2/我的坚果云/基于cmooc的第三个研究/第三项cMOOC研究_执行蓝图_v0.2.md)、[实验方案 v0.4](C:/Users/tiany/Nutstore/2/我的坚果云/基于cmooc的第三个研究/第三项cMOOC研究_数据与实验执行方案_v0.4.md) | 小型正式 pilot、图表与运行 manifest | 研究任务模板、最小复现包 | 证据体量小，不宜独立驱动主产品功能 |
| [analysis_cmooc_genai_2024_2025](C:/Users/tiany/Nutstore/2/我的坚果云/analysis_cmooc_genai_2024_2025) | 约 1,186 文件 / 98 MiB | [研究总导航](C:/Users/tiany/Nutstore/2/我的坚果云/analysis_cmooc_genai_2024_2025/00_cMOOC研究总导航_从这里开始/README.md)、[分析管线](C:/Users/tiany/Nutstore/2/我的坚果云/analysis_cmooc_genai_2024_2025/90_ANALYSIS_PIPELINE_2024_2025/README.md) | 分析导航、联合线程分析、深度复分析计划 | 研究任务恢复、跨项目导航、复现实验组织 | 数据文件仅审计元数据；不能把未核对分析直接送入产品 |
| [cmooc研究数据24-25](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc研究数据24-25) | 约 3,576 文件 / 565 MiB | [根 README](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc研究数据24-25/README.md)、[编码流程](C:/Users/tiany/Nutstore/2/我的坚果云/cmooc研究数据24-25/04_代码/README_编码流程.md) | 原始→准备→分析→代码→可视化→文档的数据生命周期 | 数据契约、研究导出和复现目录结构 | 原始/分析数据可能含学习者内容；本次未打开载荷 |
| [教育智能体_loopEngineer](C:/Users/tiany/Nutstore/2/我的坚果云/教育智能体_loopEngineer) | 约 1,900 文件 / 697 MiB | [README.md](C:/Users/tiany/Nutstore/2/我的坚果云/教育智能体_loopEngineer/README.md)、[反馈课程化结构](C:/Users/tiany/Nutstore/2/我的坚果云/教育智能体_loopEngineer/02_过程材料/06_20260801_反馈课程化结构重构/README.md) | 准入审查、意见复核、条件保障三关；未行动过程诊断；最小责任记录 | Canvas 中“为什么停在这里”、教师让位/复核/条件动作 | 概念机制，不是真实课堂效果；历史 G1/G2/G3 状态机不是当前论文事实 |

### 2.2 相邻可复用项目

| 项目 | 纳入理由 | 可迁移资产 | 不直接迁移的原因 |
| --- | --- | --- | --- |
| [学生画像旧版本](C:/Users/tiany/Nutstore/2/我的坚果云/学生画像旧版本) | 有画像、外部验证与教师读图方法 | coverage-aware 画像表达、脚本导航、公开聚合包 | 数据/身份边界不清；旧画像不能变成自动个体诊断 |
| [胜任力矩阵研究](C:/Users/tiany/Nutstore/2/我的坚果云/胜任力矩阵研究) | 有能力矩阵、可视化和公开 manifest | 指标矩阵表达、coverage-aware 图例 | 指标语义与 cMOOC 互动过程不同，不能直接等价 |
| [图小波胜任力矩阵与教育智能体_国家发明专利](C:/Users/tiany/Nutstore/2/我的坚果云/图小波胜任力矩阵与教育智能体_国家发明专利) | 有 Graph-PVI 和审计型控制原型 | 严格时间隔离、阶段回执、证据账本、风险/资格双状态 | 专利原型与合成解释器不是生产教育效果证据 |
| [图变换预测算法论文](C:/Users/tiany/Nutstore/2/我的坚果云/图变换预测算法论文) | 有动态图、教师评价和伦理治理材料 | 互动结构变化候选、研究版界面规范 | 算法与数据域需匿名校准；不得直接称预测真实学习行为 |
| [ToE对照试验论文](C:/Users/tiany/Nutstore/2/我的坚果云/ToE对照试验论文) | 提供干预/对照和长期效果设计线索 | 长期效果观察设计、版本说明与分析报告 | 成绩/原始数据未读；不能作为当前产品效果 |
| [以教为学还是委托生成_人-AI共调节视角下职前教师教学设计任务中的责任保持研究](C:/Users/tiany/Nutstore/2/我的坚果云/以教为学还是委托生成_人-AI共调节视角下职前教师教学设计任务中的责任保持研究) | 关注教师与 AI 共调节、责任保持 | 教师责任、协作/审批和人机边界设计 | 非 cMOOC 直接场景，需要单独验证 |
| [以教为学还是委托生成_旧版本](C:/Users/tiany/Nutstore/2/我的坚果云/以教为学还是委托生成_旧版本) | 上述研究的历史背景与版本线索 | 仅用于追溯责任保持概念的演变 | 新项目证据足够时不重复采用旧稿 |
| [毕业论文多智能体设计](C:/Users/tiany/Nutstore/2/我的坚果云/毕业论文多智能体设计) | 名称和少量材料涉及多智能体设计 | 仅作架构启发和术语检索入口 | 只有 2 个文件，证据过薄，不能驱动产品决策 |
| [自动控制原理论坛数据](C:/Users/tiany/Nutstore/2/我的坚果云/自动控制原理论坛数据) | 名称和匿名聚合报告直接涉及课程互动 | 匿名网络指标与可视化命名参考 | 原始表格/正文/身份边界受限；旧网络值不是 cMOOC 生产真值 |

### 2.3 空目录、受限范围与排除项

- **事实**：根目录下未找到精确名为 `cmooc研究` 的项目；未把相近目录冒充它，改为分别审计 `基于cmooc的第三个研究`、`cmooc研究数据24-25` 与 `analysis_cmooc_genai_2024_2025`。
- **事实**：[LLM在cmooc场景下的性能评估](C:/Users/tiany/Nutstore/2/我的坚果云/LLM在cmooc场景下的性能评估) 与 `自动控制原理_GenAI协作作业评估研究` 当前为空或未 materialize 的 reparse 占位，只有名称证据。
- **受限**：[MATLAB作业_共有78份作业](C:/Users/tiany/Nutstore/2/我的坚果云/MATLAB作业_共有78份作业) 含潜在身份化作业，完全未读；只记录存在，不纳入普通产品资产。
- **受限**：[华电伦理审查](C:/Users/tiany/Nutstore/2/我的坚果云/华电伦理审查) 只作为伦理流程边界；未列出或读取含姓名的文件。
- **排除**：通用论文写作、书籍格式、一般中文论文等目录未形成 cMOOC/教育智能体的实质产品能力证据。

## 3. 用户场景地图

| 用户 | 高频场景 | 关键决策 | 信息过载点 | 恢复/协作需求 | 当前隐藏能力 |
| --- | --- | --- | --- | --- | --- |
| 教师 | 上课前或每天查看课程状态 | 今天是否需要看、看哪一项、由谁继续 | 多页面状态、Graph 指标、运行术语 | 把一项证据交给学伴，稍后从同一快照继续 | 四态决定、覆盖状态、异常、结果窗口已存在但分散 |
| 课程运营者 | 发现运行或覆盖异常 | 是课程问题、数据边界还是系统问题 | 全局计数与当前课程混淆 | 异常确认、让位、恢复巡检、回到精确 invocation | incident、governance、wake receipt 和 replay 已存在 |
| 教师/助教 | 复核一个可能被忽略的互动机会 | 保留、忽略、等待、让位或继续研判 | 候选过多、模型理由不透明 | 固定审阅预算、三关口、逐项处理 | Route2 标签、72h 规则、Loop 三关可组合 |
| 研究者 | 复现一次分析或比较策略 | 数据/规则/模型版本是否一致 | 文件版本、分母、时间泄漏、模型尝试混杂 | 可恢复任务、manifest、checkpoint、导出包 | BJET replay、Route2/MeasureBench 审计与当前持久任务 |
| 课程负责人 | 观察长期结果 | 近端变化是否稳定、是否值得试验 | 单次变化容易被写成效果 | 跨周期对照、异常解释、伦理审批 | R24/R72 结果窗已有，但长期效果设计尚未接入 |

## 4. “当前能力—跨项目资产—用户缺口—功能机会”矩阵

| 当前产品能力 | 可复用跨项目资产 | 真实用户缺口 | 具体功能机会 | 证据边界 |
| --- | --- | --- | --- | --- |
| Workbench 持久任务、恢复、自然语言页面动作 | analysis 管线导航、BJET checkpoint/receipt | 用户需要从课程事项直接进入可恢复任务 | 简报事项“一键交给学伴”，附加精确 snapshot context | 只交付安全摘要与引用，不恢复正文或身份 |
| World/Graph、事件账本、时间回放 | BJET reducer/replay、CommunityWorldBench strict-prefix | 用户无法快速知道“变化发生在何时、依据是什么” | 教学事件时间线与按需证据重放 Canvas | 关系是可见结构，不等于曝光或学习 |
| coverage、Graph lower-bound | 群体形象双分母、compatible range、eligible/LCB | 画像容易被误看成全课真值 | 支撑感知课程画像：单位分母、评论分母、未支撑质量、相容范围 | 不做个体诊断，不外推 A–D 的全课功能比例 |
| DRAFT/WAIT/ABSTAIN/YIELD | Loop 三关、Route2 ABSTAIN 与贡献功能 | 决策代码对教师不够可解释 | 每项显示准入/复核/条件、缺什么、可以做什么 | 机制是责任结构，不是效果证明 |
| incident、outcome、Decision Tape | LLM 质量瀑布、Graph-PVI 证据资格/风险状态 | 用户难区分系统异常、证据不足和课程信号 | 异常解释与质量守门抽屉 | UNKNOWN/弃答是合格输出；不做模型总榜 |
| CandidateSet、预算与人工审核 | 沉睡想法 review-budget frontier | 候选太多且召回不足以自动行动 | 72h 沉睡想法候选收件箱，默认每周固定审阅预算 | 仅回顾性/shadow；人工确认；不称发生率或预测 |
| R24/R72 描述性观察 | ToE 长期观察设计 | 单个结果窗口不能回答长期价值 | 长期效果观察：跨周期、删失、对照设计入口 | 当前只展示描述性观察，因果需新研究授权与设计 |
| 研究文档与运行回执 | Route2/MeasureBench manifests、BJET rebuildability | 研究者难导出可复现而安全的包 | 聚合研究导出、版本清单、规则与质量报告 | 不导出行级正文、ID、私有尝试或凭据 |

## 5. 候选功能判定

评分为 1–5；“实施可控”和“风险可控”分数越高越好。总分只用于排序，不替代证据边界。

| 功能 | 用户价值 | 场景契合 | 证据基础 | 实施可控 | 风险可控 | 主链协同 | 总分 | 处置 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 今日课程简报 + 机会 Canvas | 5 | 5 | 5 | 4 | 5 | 5 | 29 | **近期第 1** |
| LLM 证据瀑布与质量守门 | 4 | 5 | 5 | 4 | 5 | 5 | 28 | 近期 |
| 支撑感知课程群体画像 | 5 | 5 | 5 | 3 | 4 | 5 | 27 | 近期 |
| 互动结构变化 + 教学事件时间线 | 5 | 5 | 4 | 3 | 4 | 5 | 26 | 近期 |
| 研究导出/复现实验 | 4 | 4 | 5 | 4 | 5 | 4 | 26 | 近期 |
| 可恢复研究任务 | 4 | 4 | 5 | 4 | 5 | 4 | 26 | 与导出组合 |
| 72h 沉睡想法候选收件箱 | 5 | 4 | 3 | 3 | 3 | 4 | 22 | 中期 shadow |
| 协作/审批 | 4 | 4 | 3 | 3 | 4 | 4 | 22 | 中期，先做任务交接而非逐条审批 |
| 长期效果观察 | 5 | 4 | 2 | 2 | 3 | 4 | 20 | 中期研究轨 |
| 自然语言跨页操作 | 4 | 4 | 4 | 4 | 4 | 5 | 25 | 已有基础，随各切片增量接入 |
| 独立课程驾驶舱 | 3 | 3 | 4 | 3 | 4 | 2 | 19 | **不单独做**；能力进入对话与 Canvas |
| 通用推荐/聊天页 | 2 | 2 | 2 | 4 | 2 | 2 | 14 | **不做**；缺少明确任务与证据锚点 |

## 6. 路线图

### 6.1 近期 3–5 个纵向切片

1. **今日课程简报 → 机会 Canvas → 精确证据/交给学伴**  
   同一 `courseAlias + invocationId + snapshotId` 下聚合最多五类事项；在现有极简 Workbench 内完成完整任务流。
2. **证据瀑布嵌入每项 AI 建议**  
   显示停在格式、证据、关系、时间或支持哪一层；UNKNOWN/弃答保持为正确结果。
3. **支撑感知课程画像 Canvas**  
   双分母、未支撑评论质量、compatible range、eligible/LCB；默认一句话，复杂图按需展开。
4. **互动结构变化与教学事件时间线**  
   strict-prefix 回放、长讨论质量集中、回复结构和匿名关系状态；不把中心性改名为“声音集中”。
5. **安全研究导出与可恢复实验**  
   导出聚合指标、manifest、模型/规则版本、覆盖/ABSTAIN/无效率、重建差异和审计报告。

### 6.2 中期能力组合

- 把 72h 想法发展检索作为人工审核、固定预算的 shadow 收件箱接入简报，而非自动发布器。
- 将任务恢复、协作交接和“准入—复核—条件”结合成教师/运营者责任工作流。
- 把 R24/R72 扩成跨周期观察与研究设计入口；在有合格对照前始终保持描述性。
- 让自然语言页面动作覆盖“打开当前简报、切换证据项、附加快照、导出复现包”，但不越过真实发布锁。

### 6.3 暂不做/不应做

- 不做稳定个体能力、人格、动机或心理风险画像。
- 不把沉默、未回复或网络弱连接解释为拒绝、能力不足或失去兴趣。
- 不自动发布干预，不把教师逐条审批变成产品默认负担。
- 不把合成 World Model 称为现实数字孪生，不宣称行动条件预测或因果最优策略。
- 不做模型“总冠军”榜单，不把 benchmark 通过率当课程效果。
- 不把课程年份当 AI treatment，不从观察性回复概率推断学习成效。
- 不导出论坛正文、真实身份、行级私有数据、模型原始尝试、数据库、Cookie、token 或凭据。
- 不把旧论坛中心性、长线程评论占比直接改名为“声音集中”。

## 7. 第一优先纵向切片规格

### 7.1 目标用户与触发

- 教师/课程运营者打开 `/workbench`，准备开始一天的课程工作。
- 系统已有一次完成的课程巡检、世界快照和相容证据链。
- 无需先理解运行控制台或进入多张统计页。

### 7.2 页面流程

```text
/workbench 极简首页
→ 对话区出现一条“今天有 N 件值得看”
→ 点击事项
→ 桌面右侧 62% Canvas / 对话保留 38%；移动端全屏 Canvas
→ 查看观察事实、准入/复核/条件、证据限制
→ 打开精确 World/运行证据，或“交给学伴研判”
→ Canvas 关闭，精确 snapshot/decision/outcome/incident 引用附加到输入框
→ 用户可直接编辑任务，也可启动只读研判
```

Canvas 是按需工作面，不是新的一级汇报页面；`/autonomy/world` 保持完整全屏分析页。

### 7.3 最小数据契约

```text
CourseOpportunityBrief
  schemaVersion
  status: ready | unavailable
  anchor:
    courseAlias
    invocationId
    snapshotId
    manifestHash
    worldHash
    candidateSetHash
    coverageHash
    worldAsOf
    evidenceAsOf
  summary:
    needsAttention
    canYield
    dueOutcomes
    incompleteScopes
  items[0..5]:
    kind: incident | coverage_boundary | support_gap |
          outcome_due | intervention_opportunity | yield | no_action
    priority
    human-readable state/headline/summary
    allowlisted observedFacts/limitations
    admission/review/conditions gates
    exact contextRef/sourceHref
    canHandoff
  containsForumText: false
  containsIdentity: false
```

精确一致性要求：

- invocation 的课程与 manifest 一致；
- snapshot 唯一绑定 invocation 和课程；
- scan 的课程与 `coverageHash` 一致；
- CandidateSet 同时绑定 invocation、snapshot 和 `candidateSetHash`；
- decision 同时绑定课程、`worldHash` 和 `candidateSetHash`；
- incident 同时绑定课程和 invocation；
- outcome 必须经 decision 绑定相同课程、world 和 CandidateSet；
- 不允许 world reader 在请求的 snapshot 不存在时静默回退到“最新快照”。

### 7.4 五类来源与最小动作

| 来源 | 用户看到什么 | 用户能做什么 | 最小实现 | 发布边界 |
| --- | --- | --- | --- | --- |
| 运行异常 | “本轮证据链需要核验”及安全异常类型 | 打开 `/review/live` 或交给学伴排查 | 同 invocation 聚合一项 | 不等于课程异常，不自动发布 |
| 覆盖边界 | 哪些观察范围不完整/不可用 | 查看精确 World；重新巡检 | coverage 状态与安全计数 | 只能按可见下界解释 |
| 成熟支持缺口 | 完整线程中 72h 后仍无外部/作者/系统回应的聚合数量 | 交给学伴核验替代解释 | exact snapshot 的匿名聚合 | 是审阅信号，不是行动授权 |
| 到期结果 | 哪个近端观察窗口已到 | 进入结果核对 | 相同 decision 锚点下聚合 | 只作描述性观察 |
| 决定/让位 | 有一项可继续研判，或本轮应让位/克制 | 附加上下文、等待或打开证据 | 每轮聚合一项代表状态 | WAIT/ABSTAIN/YIELD 都是合格结果 |

### 7.5 验收标准

1. 同一简报的课程、invocation、snapshot、world、CandidateSet 与 coverage 精确一致；跨课程/跨快照诱饵不能进入。
2. 相同数据库状态和锚点重复读取，排序、事项 ID、证据时点和文案稳定。
3. 每类最多一项，总数不超过 5；覆盖不可用时不能显示“无需行动”。
4. 正常 decision 可晚于 world cutoff 记录；不能因为 `decision.evidenceAsOf > world.asOfAt` 被误删，必须用绑定 hash 校验。
5. 输出与序列化中不出现 threadKey、authorKey、targetKey、正文、身份、summaryJson、decisionJson、candidate JSON 或任意私有载荷。
6. GET API 必须显式接受并核验 `courseAlias + invocationId + snapshotId`，返回 `no-store`，错误响应不泄露数据库细节。
7. 桌面 1440/1280/1024 下保持 38/62 对话与 Canvas；390/320 下 Canvas 全屏且无横向溢出。
8. 单一 `h1`；Canvas 有可读标题/描述、Escape、焦点管理和焦点归还；不会把几十个图节点加入 Tab 顺序。
9. 从事项交给学伴后，输入框收到可编辑的只读研判任务，并附加精确安全引用；不执行真实发布。
10. `test:workbench`、定向 read-model 测试、type-check、lint、build 和实际浏览器视觉检查通过。

### 7.6 最小实现边界

- 只做当前最新完成巡检的只读投影与精确锚定 API，不新建数据库表。
- 不在 Slice 1 内嵌完整 WorldGraphExplorer；Canvas 只呈现短事实、三关状态和深链。
- 不读取或展示帖子正文与身份，不新增真实课程 mutation。
- 不在 Slice 1 做画像、72h 语义检索或 LLM 在线调用；只为后续 Canvas 插槽保留契约。

## 8. 验证策略

- 纯函数：稳定排序、max-5、coverage unavailable、YIELD/no-action、隐私 sentinel。
- 数据库集成：两课程、多 invocation、多 snapshot、错误 hash/课程诱饵、正常 post-snapshot decision、只读前后表计数不变。
- API：必填锚点、`400/404/409/503`、`Cache-Control: no-store`、无内部错误泄露。
- UI 契约：单一主标题、Brief/Canvas landmark、38/62、移动全屏、Escape/焦点归还。
- 浏览器：1440×1024、1280×720、1024×768、390×844、320×568；控制台零错误，关键按钮可键盘操作。

## 9. 尚未读取或受限制的范围

- 所有凭据、Cookie、token、登录态与认证文件。
- 论坛原始正文、HTML 页面、真实用户名、平台 ID、原始作业与可能含身份的文件名。
- 私有/raw/deidentified 正文、gold workbook、行级 CSV/JSON/JSONL/XLS/XLSX/Parquet。
- SQLite/SQL 数据库、模型原始 attempts、私有 API 结果和外部服务登录态。
- 巨型项目的全部历史版本、retired staging、缓存、构建产物与重复投稿包。
- `LLM在cmooc场景下的性能评估` 和 `自动控制原理_GenAI协作作业评估研究` 的实质内容，因为当前目录为空或未解析。
- 未经新的伦理与产品授权，不把受限资产迁入主产品或普通日志。

## 10. 证据诚实性总结

**事实**：本地资产足以支持一个强的教师/运营者任务入口、精确证据链、课程级支撑感知画像、事件回放、质量守门和安全研究导出。

**推断**：这些能力组合后可能减少跨页查找与证据核对成本，但当前没有用户研究证明节省了多少时间，也没有证据证明它提高学习成效。

**建议**：先以 Slice 1 验证“教师能否在 30 秒内找到今天最值得核验的一项，并在不丢失证据锚点的情况下交给学伴继续”；再用任务完成率、首次有效判断时间、跨页次数、误读边界率、恢复成功率和人工撤回原因决定是否扩展到画像、互动结构和 72h 想法收件箱。
