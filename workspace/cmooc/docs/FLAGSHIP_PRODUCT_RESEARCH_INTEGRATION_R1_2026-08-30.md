# cMOOC 旗舰产品研究整合纲领 R1

- 版本：`R1`
- 日期：`2026-08-30`
- 状态：`CURRENT FLAGSHIP CONTENT DIRECTION / DESIGN READY / NOT IMPLEMENTED`
- 产品实现权威：[自主产品总计划](AUTONOMOUS_PRODUCT_MASTER_PLAN.md)
- 当前事实：[PRODUCT_CURRENT](PRODUCT_CURRENT.md)
- 前瞻研究权威：[课程共同体促进研究纲领 R1](COMMUNITY_FACILITATION_RESEARCH_DIRECTION_R1_2026-08-30.md)
- 跨项目资产基线：[跨项目产品机会地图](CROSS_PROJECT_PRODUCT_OPPORTUNITY_MAP_2026-08-12.md)

本文把近期 cMOOC 系列研究、可教智能体研究和 2026 年的 LLM/agent harness 进展编译为
同一套旗舰产品内容。它新增产品对象、体验主线和实施切片，不倒改已冻结论文、统计结果、
研究样本或现有运行回执。当前真实发布硬锁、课程策略和外部动作授权保持不变。

## 1. 旗舰产品结论

旗舰产品应定位为一套**课程共同体促进操作系统**。它帮助课程及时发现可能被错过的
问题、解释、资源和同伴连接，在恰当时点推进共同活动，并在原作者、同伴或教师已经能够
形成有效接续时主动让位。

系统持续回答五个相连的问题：

1. 此刻课程共同体中哪一件事值得被看见；
2. 它为什么可能产生关系后果；
3. 原作者、同伴、教师与智能学伴中的谁更适合承担回应、连接或推进责任；
4. 如果行动，应采用什么促进功能；如果让位，应为哪种人类活动保留空间；
5. 共同体随后发生了什么，又通过哪些纠正、转向和接续教回系统。

因此，前台主角是一个从发现持续到结果回流的**关系性促进回合**。社会世界模拟器服务于
这个回合的试验，可教式学伴吸收这个回合中的明确判断，研究工作台复现这个回合的证据；
三者共同服务同一条课程活动主线。

面向用户的产品承诺是：

> 让值得推进的解释、资源与连接不被错过，让能够自行接续的共同体保有空间；每次判断都
> 能说明为什么是这个时点、这个对象和这个动作，并从后续人类活动中继续学习。

## 2. 旗舰体验：一条主线、一个 Canvas

### 2.1 今日课程简报

每天最多呈现五个真正需要判断的课程时点。每项先用一句话说明正在发生的活动、可能的
关系后果和当前责任，再给出 `DRAFT / WAIT / ABSTAIN / YIELD`。群体画像、质量瀑布和
Graph 只在解释当前判断时出现，不扩成并列驾驶舱。

### 2.2 关系性促进回合 Canvas

同一 Canvas 贯穿发现、行动和后续：

1. **活动：**学习者此刻正在发起问题、形成解释、互评、连接资源、协作推进还是重返任务；
2. **痕迹：**贡献和 AI 介入的哪些过程对共同体可见，哪种过程痕迹最有助于他人理解和复用；
3. **关系：**当前局部回应、桥接、互惠和注意路径怎样组织；
4. **责任：**原作者、同伴、教师和智能学伴谁更适合承担下一步，有哪些合理替代；
5. **动作：**资源连接、解释推进、认知冲突、同伴邀请、任务重返、教师接管或让位；
6. **后续：**他作者回应、原作者回返、独立回应者、链条延展、功能摄取和明确纠正；
7. **教回系统：**哪一项教师或学习者判断改变了课程本地策略、功能偏好或停止条件。

教师和课程运营者从简报进入这一 Canvas，也可以把同一证据锚点交给学伴继续研判。学习者
仍在原生讨论区参与课程；其明确纠正、转向、停止、继续或重新进入任务成为回合事件。
普通未回应只记录为过程状态。

### 2.3 同一回合的研究模式

Scenario Lab 从当前回合的同一 evidence bundle 进行 replay/fork，比较不同状态表示、
ActionGate、促进功能和让位策略。Research Export 导出同一回合的去标识事件、关系、决定、
结果与版本清单。二者是 Canvas 的“试验”和“导出”动作，不形成独立前台产品。

## 3. 统一产品对象

### 3.1 `RelationalFacilitationEpisodeV1`

关系性促进回合先回答活动、关系、责任和下一步，再绑定实现标识。它包含三部分：

- **机会证据 `RelationalOpportunityEvidenceV1`：**课程活动、公共痕迹、局部关系、
  可见回应资源、可能的关系后果、责任候选与精确证据；
- **促进提议 `FacilitationProposalV1`：**`DRAFT/WAIT/ABSTAIN/YIELD`、功能、对象、
  责任路径、替代行动、成功迹象与撤回条件；
- **回合观察 `EpisodeObservationV1`：**近端人类接续、教师/学习者明确判断、teaching
  delta，以及回合的恢复、让位或关闭。

实现时，机会证据至少绑定
`courseAlias + invocationId + worldSnapshotId + graphSnapshotId + candidateSetId`，并保留
`OBSERVED / INFERRED / UNKNOWN` 与 coverage。它们用于区分“尚未看见”和“确实不存在”，
不取代前面的教育问题。

### 3.2 回合生命周期

```text
OBSERVE
→ QUALIFY
→ PROPOSE
→ DRAFT / WAIT / ABSTAIN / YIELD
→ SHADOW / POLICY-AUTHORIZED ACTION
→ OUTCOME OBSERVATION
→ HUMAN JUDGEMENT / TEACHING DELTA
→ RESUME / YIELD / CLOSE
```

autonomy、Workbench 与 Scenario Lab 继续分别承担课程行动真相、工具执行真相和研究运行
真相。它们以共享 evidence/trace reference 连接，不物理合并账本。

## 4. 四种回合能力如何吸收近期研究

| 回合工作 | 研究提供的发现 | 产品中的共同能力 | 它改变什么 |
| --- | --- | --- | --- |
| **看见并判断资格** | JCAL public trace 揭示 output 与 judgement/verification 可见性不对称；ILE 群体形象揭示 profile 必须与 support、unsupported mass 和 resolution 同看；CommunityWorldBench/MeasureBench 表明 state、transition、evidence、time 与 abstention 是不同能力 | `TraceVisibility + SupportAwarePortrait + QualificationChain` 共同进入机会证据 | 选择当前任务真正需要的过程痕迹，识别哪些课程现象已有支撑，并把模型用于它擅长的子任务 |
| **分配责任并选择行动** | BJET81 揭示单体 initiative 与共同体过程适配之间的落差；Route 2 区分贡献功能与 72h reply receipt；互惠研究显示状态表示 × participation policy 会改变 `WAIT/START/REPLY(target)`；证据交接研究提出具体缺证与教师接管 | `CommunityProcessProfile + ActionGate + ResponsibilityRoute` 共同生成促进提议 | 决定谁应回应、是否等待、面向谁行动以及采用何种促进功能，使关系证据真正改变决定 |
| **追踪接续并形成共同体记忆** | 沉睡想法研究发现部分命题在 day 30 后和跨线程继续发展；实践知识研究显示经验表达距离情境化采用仍有很长链条；共同体记忆研究提供来源谱系、反例与 archive routing 候选 | `IdeaLineage + ContextBridge + CommunityMemory` 共同进入回合后续 | 识别值得重新连接的想法，补足情境、边界和证据，让跨线程、跨活动和跨届接续可被判断 |
| **模拟、竞争解释并改进** | SSCR 表明不同历史表示分别适合不同 downstream inference；CRDH 已形成 phenomenon→null worlds→blind reanalysis→human check 的研究链 | `TaskDeclaredScenario + ResearchPlane` 围绕同一回合运行 | 先声明要保存的教育过程，再 replay/fork 竞争策略，把研究发现转回产品判断而不是追求抽象 realism 分 |

这些研究共同把产品评价单位从“生成了一条怎样的回复”升级为“在一个课程时点，系统如何
看见、判断、承担或让位，以及共同体如何接续”。各论文的精确发现与当前证据状态见附录 A。

## 5. 最新 LLM 与 harness 带来的三项产品后果

2026 年的模型与运行框架已经能够提供更长任务、更强工具编排、结构化结果、多智能体、
任务中断/恢复、checkpoint、tracing 和 eval。对本产品最重要的是三个产品后果。

### 5.1 同一促进回合可以长期恢复

权威状态继续保存在 Course Event World、Graph、CandidateSet、Decision Tape 和 episode
记录中。每次唤醒只加载 `ContextRecoveryPack`：当前事实、开放问题、上次决定、待处理
输入、下一动作和精确哈希。长上下文、reasoning persistence、compaction、provider session
和 checkpoint 用于运行恢复，不承担课程长期记忆。

### 5.2 模型集中处理判断，代码处理确定性工作

Event World/Graph 的过滤、join、去重、聚合、预算、权限、幂等和副作用留在代码中。模型
只返回带 `evidenceRefs + uncertainty + alternativeAction + yieldCondition` 的 typed proposal，
再由确定性策略解析器决定状态。高频观察和抽取使用高性价比模型，困难的关系与教育判断
按固定 eval 升级到更强推理模型。

可并行的 event、relation、function 和 evidence 分析单元保持只读，只返回 typed proposal；
根控制器形成唯一决定。多智能体用于压缩独立分析时间，不形成多个写入者。

### 5.3 教师和学习者可以中断、转向并教回系统

教师策略、学习者明确回应和运营复核作为课程事件进入 episode，触发
`WAIT / REVIEW / RESUME / YIELD / CLOSE`。这种监督方式把人类判断放在真正需要判断的
时点，而不是要求教师逐条批准模型动作。每次模型调用另留去正文 receipt，绑定模型、
schema/tool registry hash、耗时成本、verification 与 fallback，供调试和任务级 eval 使用。

MCP、LangGraph、OpenAI/Anthropic SDK 和未来 A2A 都作为运行适配器。产品先开放只读
`CourseObservation` 与 `GraphQuery` 能力；课程事实、策略、权限、回执和教学判断继续
由本产品持有。

## 6. 第一纵向切片必须交付旗舰价值

下一条候选实施切片定名为：

`FLAGSHIP-R1-RELATIONAL-OPPORTUNITY-EPISODE`

它在 SHADOW 内完成一个真实的判断闭环，不改变外部发布状态：

```text
Course World + Graph
→ RelationalOpportunityEvidenceV1
→ ActionGate + ResponsibilityRoute
→ 与 legacy 决定进行同输入 shadow 对照
→ 至少改变并解释一种 DRAFT/WAIT/YIELD、功能、对象或责任判断
→ Opportunity Canvas 展示改变原因与合理替代
→ R24/R72 与明确 judgement 进入 EpisodeObservationV1
→ 同一 episode 可 replay 和安全导出
```

### 6.1 最小实现范围

1. 新增 `RelationalOpportunityEvidenceV1` 与稳定 hash，由现有 World/Graph 生成局部关系
   sidecar，并由 CandidateSet 引用；
2. 新增 `FacilitationProposalV1`，在现有 Intent/MoveSpec 上补
   `responsibilityRoute`、`alternativeAction`、explanation advancement、peer invitation、
   task re-entry 与 teacher handoff；
3. 让 ActionGate 消费关系性机会证据，在同一候选集上同时生成 legacy 与 flagship shadow
   决定，保存实际 decision delta；
4. 在现有 Canvas 展示活动、关系后果、责任、动作/让位依据、替代行动和 decision delta；
5. 复用 Teachable Episode 与 R24/R72 接口，新增最小 `EpisodeObservationV1`，记录近端
   人类接续和明确 judgement；
6. 让 deterministic Scenario Lab replay 同一 evidence bundle，并由 Research Export v2
   导出重建所需引用与 manifest。

首个切片直接消费的契约只有三个：

- `RelationalOpportunityEvidenceV1`
- `FacilitationProposalV1`
- `EpisodeObservationV1`

`ContextRecoveryPack`、统一 model receipt、MCP task、A2A 或原生多智能体模拟在出现对应
消费者时增量接入，不构成首个切片的开工条件。

### 6.2 验收故事

在同一真实只读 course snapshot 上，教师可以看到：

- 学习者正在进行什么活动，以及哪一种关系后果值得关注；
- legacy 与 flagship 判断是否一致；若不同，究竟改变了责任、功能、对象还是让位；
- Graph 的哪一条局部可见关系与哪一个课程活动证据改变了决定；
- 系统为何选择行动、等待或让位，还有什么合理替代；
- 后续出现了什么人类接续，以及教师或学习者的明确判断如何影响下一回合。

系统必须保持严格 as-of、未来后缀不变性、稳定 hash、UNKNOWN/coverage、单一根决定、
零外部写入和可重建 receipt。这里的边界保证同一旗舰故事可以被可信地观察和比较。

## 7. 旗舰成效框架

| 层次 | 首要问题 | 产品指标示例 |
| --- | --- | --- |
| 判断杠杆 | 新表征是否真正改变了决定 | decision delta；功能/对象/责任变化率；有依据的 WAIT/YIELD；替代行动覆盖 |
| 关系过程 | 行动是否改变了共同体的接续路径 | 他作者回应、原作者回返、独立回应者、回应覆盖、局部延续、跨线程桥接 |
| 公共可检查性 | 贡献是否保留了对当前任务有用的过程痕迹 | judgement/revision、verification 与 context trace 的任务适配可见性 |
| 人类判断 | 教师与学习者如何接受、纠正、转向或停止 | judgement 类型、理由、分歧、teaching delta 与后续复用 |
| 社会世界效度 | 模拟是否保存本次推断需要的过程 | task-specific preservation、continuation bottleneck、null-world 区分 |
| harness 质量 | 长时回合能否可靠恢复与核对 | replay determinism、idempotency、receipt 完整性、恢复成功率、qualified episode 成本 |
| 研究生产力 | 一个产品对象能否支持多种可复现问题 | 重建成功率、跨课/跨时点可比 bundle、竞争解释和人工交接完成度 |

学习结果和因果效果在获得相应前瞻设计时进入独立层次；当前旗舰升级首先使活动、关系、
责任、功能和判断成为可观察、可改变、可复现的产品过程。

## 8. 当前产品取舍

1. **“课程共同体促进操作系统”是唯一前台主故事。** 模拟、可教机制、研究工作台和模型
   评测分别服务同一关系性促进回合。
2. **第一工程对象是会改变判断的关系性机会证据。** 新页面、完整 Graph 大屏和复杂 agent
   team 都不能替代 decision delta。
3. **首个切片在 SHADOW 内交付教育判断价值。** 只读与零发布保证运行范围，但不把产品
   价值推迟到后续阶段。
4. **harness 保持 provider-neutral。** 最新模型和 SDK 提供运行能力，课程状态、证据、
   策略、权限、回执和人类判断构成产品的长期资产。
5. **研究通过改变产品能力进入主叙事。** 每项成熟研究至少改变一种观察、判断、行动、
   结果记录或评测能力；其余材料保留在研究资产层。

## 附录 A：近期研究事实索引

以下数字来自 2026-08-30 恢复的各项目当前 authority/current/handoff；本次没有重新运行
统计、模型或渲染。

1. **JCAL public trace：**184 个 enacted-use contributions 中，output visibility 为 73.37%，
   human judgement/revision 为 51.09%，verification 为 44.57%。它测量公共痕迹可见性。
2. **ILE 群体形象：**10,620 threads、111,704 comments、3,639 trajectories；直接证据覆盖
   8,969 windows / 24,471 comments，长讨论区支持率可低至 1.6%。
3. **BJET81：**124,923 events、6 course-year contexts；24 个 RQ1 comparisons 中 9 个进入
   course-local range，更高 initiative 可伴随更高 open-response demand。
4. **Route 2：**72,555 eligible comments 中，9,008 个获得 72h 他作者首个显式回复；该
   reply receipt 记录公共延续，不等同贡献价值或学习结果。
5. **沉睡想法研究：**33 个 source ideas 中 17 个在 day 30 后首次发展，13 个出现跨作者
   或跨线程 branching；Top-1 为 10/33。
6. **互惠与回应路径：**108 episodes、1,725 valid tasks 的受控模拟显示状态表示与
   participation policy 会改变 `ACT_NOW` 与目标路径；结果属于模拟决策。
7. **SSCR：**360 个 model-cell-world archives 中 345 个恢复 post-return continuation
   bottleneck；B0/B1/B2 分别适合不同 downstream inference。
8. **CommunityWorldBench/MeasureBench：**state、preservation、locality 与 transition
   呈现不同模型强项；`label-correct` 仍需经过 evidence、relation、time、support 和
   abstention 资格链。
9. **实践知识再情境化：**218 branches 中 214 个有 prior expression、206 个有 later
   expression；99 个 source-rich representations 仅 12 个 source→response jointly positive。
10. **共同体记忆候选研究：**已形成 10,917 snapshots 与 36 candidates，主题 silhouette
    约 .025；当前支撑候选结构与谱系设计。
11. **证据边界与教师交接：**已有数据资产和设计，尚未形成教师授权 gold；当前支撑具体
    缺证、请求证据和教师接管接口。
12. **CRDH discovery harness：**已形成 phenomenon card → artifact screen → hypothesis
    freeze → null worlds → blind reanalysis → human/process check 的可执行研究顺序。

## 附录 B：2026 官方 harness 资料

- [GPT-5.6 与当前模型家族](https://openai.com/index/gpt-5-6/)
- [OpenAI 2026 builder guide](https://openai.com/index/builders-guide-to-gpt-5-6/)
- [OpenAI agentic harness 工程说明](https://openai.com/index/gpt-5-6-frontier-intelligence-efficiency/)
- [OpenAI Agents SDK human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)
- [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-python/tracing/)
- [MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP Tasks](https://modelcontextprotocol.io/extensions/tasks/overview)
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [Anthropic real-world agent autonomy study](https://www.anthropic.com/news/measuring-agent-autonomy)
- [Anthropic long-running agent harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

OpenAI 的 2026 builder/harness 文档强调 reasoning continuity、compaction、programmatic
tool calling、multi-agent、deferred tool discovery、受限 tool output 和 append-only 精确
前缀；MCP 与 LangGraph 提供 long-running task、input-required、checkpoint 与恢复原语。
Anthropic 的真实使用研究显示，有经验的用户会同时增加 auto-approve 和 interrupt，更像
课程级策略治理加关键时点纠正，而非逐动作审批。上述发现用于 harness 设计，不直接外推
为 cMOOC 教育效果。
