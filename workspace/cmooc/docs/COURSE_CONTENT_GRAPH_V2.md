# Course Content Graph v2

- 版本：`cmooc.course-content-graph.v2`
- 日期：`2026-07-31`
- 状态：`IMPLEMENTED / REAL_READ_ONLY_SNAPSHOT_VERIFIED / COVERAGE_LOWER_BOUND`

## 1. 产品目的

Graph v2 为 Community Autopilot 提供两个互补的宏观视角：

1. **课程内容图**：课程由哪些栏目、主题、受控概念和资源构成，讨论发生在哪里；
2. **学习者社会网络**：有明确 learner 角色证据的成员在已观察回复关系中处于什么
   位置，以及哪些连接只能作为覆盖下界。

它服务于课程巡检、候选生成、让位判断、长期异常审核和 PI 观察，不替代
`ObservedEventLedger`，也不把描述性图指标包装成教育效果。

## 2. 数据链

```text
CourseManifest 精确课程绑定
→ API / Chrome 观察与 CoverageReceipt
→ ObservedEventLedger
→ 当前已完成 CourseScanRun 的 CourseStructureFact
→ CourseWorldSnapshot
→ CourseContentGraphSnapshot v2
→ 节点 / 边 / learner 位置投影
→ /autonomy/world 与去正文状态回执
```

只有一个已完成 scan 的事实集合可以生成一个 Graph 快照。正在运行、失败或来自其他
课程的事实不会混入；同一快照再次提交必须是完全相同的 no-op，否则关闭写入。

## 3. 图契约

### 节点

| 类型 | 含义 | 浏览器标签 |
| --- | --- | --- |
| `course` | manifest 绑定的唯一课程根 | `课程` |
| `column` | 课程栏目 | `栏目 C-xx` |
| `thread` | 讨论主题 | `主题 T-xxx` |
| `actor` | 事件参与者或角色名册成员的匿名并集 | `成员 A-xxx` |
| `concept` | 版本化受控词表命中的课程概念 | `概念 K-xx` |
| `resource` | 规范化后按课程 HMAC 的资源引用 | `资源 R-xx` |

### 边

| 类型 | 关系 |
| --- | --- |
| `contains` | course→column、column→thread |
| `authored` | actor→thread |
| `participated_in` | actor→thread |
| `reply_to` | actor→actor |
| `discusses` | thread→concept |
| `references_resource` | thread→resource |

边的稳定身份由 source、target、kind 和 scope 决定；重复证据聚合为整数
`weight` 与 `evidenceCount`。自回复和缺少父节点的伪关系不会进入 actor 网络。

## 4. learner 网络位置

只有服务器角色注册表明确标记为 learner 的匿名节点进入 learner 位置表。系统分别
产生 `rolling_7d`、`rolling_30d` 和 `all_time` 三个窗口，保存：

- 事件、发起主题和回复计数；
- 入向、出向、唯一同伴和双向同伴计数；
- 当前可连接证据的连通分量大小；
- 证据充分时的 k-core 与 PageRank。

计算门槛是：

- 角色注册表完整；
- 图覆盖完整；
- 互动网络达到最小可计算规模。

任一门槛不满足时，位置标记为 `lower_bound` 或 `insufficient_data`，PageRank 与
k-core 为 `null`。`componentSize=1` 只表示在当前身份域和事件前缀中没有可连接的
同伴边，不能被解释为学习者社会孤立、低参与人格或学习困难。

## 5. 隐私与可重放性

- 事实、节点和边都绑定课程 HMAC，不保存明文 courseId；
- actor、主题和资源使用课程域匿名键，资源 URL 在规范化后只保存 HMAC；
- 受控概念只保存词表 ID 和计数，不保存论坛正文；
- 浏览器只接收当前快照内的本地短标签和聚合标量；
- Graph、节点、边和 learner 位置均保存规范状态哈希，读取时重新核验；
- Graph v2 是新 schema sidecar，不改变冻结 P3/P4 契约或既有 World v1 研究证据。

## 6. 真实课程验证

2026-07-31 文档审计沿用的最新已完成真实只读 shadow 快照为：

| 项目 | 回执 |
| --- | ---: |
| 栏目扫描 | 7/7 |
| 主题详情 | 64/64 |
| 去正文事件 | 390 |
| 结构事实 | 334 |
| Graph 节点 / 边 | 252 / 771 |
| 节点构成 | course 1、column 7、thread 64、actor 156、concept 12、resource 12 |
| World 事件参与者 | 93 |
| 角色名册 | 完整，73 个匿名成员 |
| learner 节点 | 71 |
| 当前可连接到事件前缀的 learner | 8 |
| 评论覆盖 | 38 个范围删失 |

93 是事件账本中的参与者，156 是历史参与者与当前名册成员的 Graph actor 并集，
71 是其中有明确 learner 角色证据的子集。三者不能互换。

因此三个 learner 窗口均为 `lower_bound`，没有计算 PageRank 或 k-core。该回执证明
真实课程的结构事实获取、投影、持久化、回放和页面展示可以运行；它不证明任何真实
干预或学习效果。整轮 `publishAttemptCount=0`、`editorWriteCount=0`，
`realPublishEnabled=false`。

## 7. 运行与验证

```powershell
npm run prisma:migrate
npm run autonomy:tick -- --course bnu-test --mode shadow
npm run autonomy:graph-status -- --course bnu-test
npm run dev
```

打开 `http://127.0.0.1:3000/autonomy/world`，可切换课程结构、社区网络和学习者位置。
状态命令只输出聚合计数、覆盖代码和开关，不输出正文、真实身份、平台 ID、URL 或
登录态。

定向测试：

```powershell
npx tsx --test tests/unit/course-content-graph.test.ts
npm run test:integration
npm run type-check
npm run lint
npm run build
```

## 8. 后续产品使用

Graph v2 可以立即用于：

- 识别尚未形成连接的主题与已有真人连接，支持 `DRAFT / YIELD` 的结构证据；
- 让 PI 按栏目、概念和资源查看讨论覆盖；
- 在完整覆盖后计算稳定的网络位置变化，作为近端过程指标；
- 将长期运行中的身份域错配、分页删失和角色注册异常送入审核。

它不能直接用于自动评价学习者、给学习者贴标签、推断心理状态或宣称干预有效。未来
如要学习前瞻策略，必须使用真实、合格 outcome 建立独立
`ProspectiveWorldModel`，不能把当前 Graph 指标重新命名为预测效果。

Graph v2 已是当前代码中较成熟的模块，不应退回旧文档提出的“以后再加入 k-core 等
完整 SNA 指标”。在 38 个评论范围删失解决前，继续增加中心性指标会制造虚假精度；
事件 observation revision 已接入 cutoff 投影并完成本地数据库验证。当前更高优先级
是用更新后真实课程 SHADOW 核验该修订语义、自然四态和只读重读，再处理 companion
完整前缀；不是补算 PageRank/k-core。
