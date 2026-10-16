# CourseWorld Scenario Lab 开发总计划

> 状态：V1_COMPLETE / WP2A_CONFORMANCE_PREVIEW_COMPLETE / WP2B_NATIVE_READY  
> 日期：2026-08-23  
> 交付类型：自主课程促进产品的研究侧纵向切片  
> 首版运行时：`deterministic_p3a_replay_v1`

## 1. 目标

把现有课程事实世界、P3A 时间留出证据和调度回放升级为一个可运行、可复现、可继续接入多智能体引擎的 **CourseWorld Scenario Lab**。首版回答的不是“干预必然造成什么”，而是：在相同冻结课程世界中，不同日预算与调度约束会形成怎样的覆盖、命中、重复触达和公平性权衡。

MiroFish 提供世界编译、GraphRAG 叙事和报告编排启发；OASIS 作为后续社交互动运行时；AgentSociety 2 作为后续实验编排、trace/replay/checkpoint 运行时。现有 cMOOC 自主内核继续拥有事实、候选、决策、许可和发布权威。

## 2. 产品形态

新增独立的 `/scenario-lab` 研究工作面和按需 API。实验数据分为三个不可混写的层：

1. `observed_frozen_aggregate`：2025 时间留出中的冻结观察聚合；
2. `offline_scheduler_replay`：相同证据上的 K=1/3/5 确定性调度回放；
3. `synthetic_sensitivity`：由 OASIS / AgentSociety 适配器产生的合成敏感性实验。

首版实现前两层；WP2A 在第三层新增 `oasis_contract_reference_v1` 的固定种子协议参考
预演，只验证合成 ScenePack、sidecar 与聚合回执能否闭合。它不是原生 OASIS、课程预测
或校准结论。原生运行时仍由 WP2B 负责。

## 3. 技术架构

```text
P3A formal artifacts（只读）
  ├─ manifest + temporal contract + decision snapshots
  └─ benchmark-v2 metrics + replay manifest
          │
          ▼
CourseWorldEvidenceReader
  ├─ 上游审计复用
  ├─ 文件哈希与契约交叉核对
  └─ 仅输出无正文、无身份、无行级键的聚合
          │
          ├─ deterministic_p3a_replay_v1
          │      └─ ScenarioSpec + RunReceipt + ForecastEnvelope
          │             └─ POST /api/scenario-lab/run
          │
          └─ OasisScenePackCompiler
                 └─ bounded JSONL sidecar
                        └─ oasis_contract_reference_v1
                               └─ OasisPreviewReport
                                      └─ POST /api/scenario-lab/oasis-preview
                                                    │
                                                    ▼
                                              /scenario-lab

Runtime Ladder 后续仍保留 oasis_sidecar_v1（WP2B 原生运行时）与
agentsociety2_sidecar_v1（WP3 实验编排）。
```

所有输出都携带输入证据哈希、情景哈希、运行时版本和解释类别。`ForecastEnvelope` 与
`OasisPreviewReport` 只承载研究聚合、权衡和失败模式，不包含 CandidateSet、Resolver、
Permit、Committer 或发布字段。

## 4. 首个纵向切片

- [x] 读取项目规则、当前产品状态与自主产品总计划。
- [x] 复核 P3A 正式工件可用性、固定时钟和 2025 聚合口径。
- [x] 新增版本化 CourseWorld / Scenario Lab 契约。
- [x] 新增受控默认根目录的 P3A 只读证据加载器。
- [x] 校验 manifest、temporal contract、benchmark 文件哈希和 K=1/3/5 完整性。
- [x] 生成确定性 ScenarioSpec、RunReceipt、ForecastEnvelope 和报告哈希。
- [x] 新增只接受精确请求的按需 POST API，响应 `no-store`。
- [x] 新增响应式 Scenario Lab 页面和产品导航入口。
- [x] 覆盖契约、读取、确定性、API 错误边界和 UI 语义测试。
- [x] 完成类型、Lint、构建及桌面/移动端浏览器验收。
- [x] 将已交付能力和 OASIS / AgentSociety 下一工作包写回产品现状。

## 5. 首版数据与时钟契约

- P3A 决策时点：原帖后 `+22h`；
- P3A 观察终点：原帖后 `+86h`；
- 冻结观察窗：`64h`；
- 时间留出：`2025`；
- 2025 总快照：`2702`；
- 决策时点仍无外部回应：`617`；
- 观察窗内自然出现外部回应：`217`；
- 观察终点仍为支持缺口：`400`。

上述数值在运行时从正式 CSV 重算，不作为绕过上游工件的硬编码证据。K=1/3/5 回放指标从 `benchmark-v2` 正式产物读取并交叉核对。

## 6. 风险与控制点

- **证据混层**：类型、API 和界面同时标注 observed / replay / synthetic；禁止以统一“效果”标签展示。
- **文件漂移**：校验上游 manifest、temporal contract、benchmark-v2 的文件哈希和输入哈希；漂移时返回稳定错误码。
- **隐私泄露**：响应只含聚合与哈希；不返回正文、身份、匿名行级键、本机路径或底层错误。
- **产品权威倒置**：Scenario Lab 不写数据库、不进入 Decision Tape、不改变候选、解析器、许可和发布链。
- **运行时锁定**：统一 `ScenarioRuntimeAdapter`；外部 Python/Ray/OASIS 服务通过 sidecar 接入，不侵入 TypeScript 自主内核。
- **实验不可复现**：每次输出包含输入证据哈希、spec hash、runtime version 和 receipt hash。

## 7. 预计影响文件

```text
lib/scenario-lab/*
lib/workbench/scenario-lab-route-handler.ts
lib/workbench/scenario-lab-oasis-preview-route-handler.ts
app/api/scenario-lab/run/route.ts
app/api/scenario-lab/oasis-preview/route.ts
app/scenario-lab/page.tsx
components/scenario-lab/*
scripts/scenario_lab_oasis_sidecar.py
app/layout.tsx（仅追加导航项）
tests/unit/scenario-lab-*.test.ts
scripts/run-workbench-tests.ts
package.json（仅在需要时追加测试入口）
docs/PRODUCT_CURRENT.md
```

不修改 P3/P4 冻结工件，不增加 Prisma 迁移，不触碰真实发布锁。

## 8. 验收证据

1. 相同正式输入与运行时版本得到相同 report/receipt hash；
2. `2702 = 2085 + 617` 且 `617 = 217 + 400`；
3. K=1/3/5 三个回放完整，指标与正式 benchmark 一致；
4. API 拒绝多余字段、未知数据集、未知情景集和不支持运行时；
5. API 与页面响应不出现正文、身份、行级键或本机路径；
6. 页面在桌面和移动端可操作，键盘焦点与选择状态清晰；
7. `test:workbench`、`type-check`、`lint`、`build` 通过；
8. 浏览器桌面/移动端截图经视觉检查通过。

## 9. OASIS 与后续运行时工作包

### WP2A — OASIS 协议参考预演（已完成）

- [x] 从正式 P3A 冻结证据编译 96 个合成 Agent、64 个合成讨论线程的 ScenePack；
- [x] 固定 WAIT/K1/K3/K5 四臂和 16 个种子，形成 64 个 arm-seed run；
- [x] 通过有界 JSONL 子进程协议回传 p10/p50/p90 聚合、能力声明与哈希回执；
- [x] 严格 POST API、取消/超时/错误投影、`no-store` 与 UI 四态闭环；
- [x] 明示 sidecar self-report / `process_contract_only` 不是操作系统沙箱证明；
- [x] 明示本机未安装、未调用原生 OASIS，所有结果仅属 synthetic protocol conformance。

### WP2B — 原生 OASIS 小规模互动 sidecar（下一工作包）

用去身份的课程事件图拓扑、证据约束的课程角色 archetype 和有限动作集编译原生 OASIS
场景；接通原生 action/feed 循环，固定种子、多次运行，并记录 wall-time、资源与成本
回执。先做小规模契约一致性实验，再讨论分布校准；WP2A 参考运行时不替代本工作包。

### WP3 — AgentSociety 2 实验编排 sidecar

把 ScenarioSpec 映射为 AgentSociety Experiment；启用 trace、replay、checkpoint/resume 和 Ray 并行；以同一 ForecastEnvelope 和 RunReceipt 回传，建立跨运行时一致性测试。

### WP4 — 前瞻校准与只读策略提示

只有在形成真实发布后的近端结果、覆盖多课程/多时间窗的校准证据后，才允许 Scenario Lab 以只读 `policy_hint` 进入预算讨论。它仍不能创建目标、改写事实世界或绕过 resolver / permit / committer。

## 10. v1 + WP2A 执行回执

- 正式 P3A 数据：12,627 行通过上游审计；2024 development 9,925，2025 time holdout 2,702；
- 冻结聚合：`2702 = 2085 + 617`，`617 = 217 + 400`；
- constrained replay：K=1/3/5 选择数 `71 / 167 / 238`，缺口覆盖 `10.25% / 24.75% / 35.00%`；
- v1 + WP2A Scenario Lab 聚焦测试：34/34，其中 OASIS 定点测试 20/20；完整 Workbench
  测试：641/641；
- `npm run type-check`、`npm run lint`、`npm run build`：通过；
- 浏览器：桌面与 390、320 宽度通过，K=3→ArrowRight→K=5 通过；WP2A 显式点击后
  展示 96 Agents / 64 Threads / 16 Seeds / 4 Arms，移动端无页面横向溢出，表格在容器内
  横向滚动；
- 网络：`POST /api/scenario-lab/run` 与 `POST /api/scenario-lab/oasis-preview` 返回 200 与
  `Cache-Control: no-store`；相同 WP2A 请求两次 report hash 一致；
- 浏览器控制台：0 error / 0 warning；
- 外部课程写入、数据库迁移、真实发布、通知：均为 0。
