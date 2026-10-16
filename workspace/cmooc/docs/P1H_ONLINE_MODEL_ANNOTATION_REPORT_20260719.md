# P1h：在线模型盲标与人机评估门禁

日期：2026-07-19（Asia/Shanghai）

## 当前决策

研究路线已按用户要求从本地模型切换为用户自有 token 的在线模型。当前主路径读取机器环境中的 `DASHSCOPE_API_KEY`，调用 `https://dashscope.aliyuncs.com/api/v1` 的 `qwen3.7-max`，并使用服务端 RSA 公钥封装一次性 AES 密钥，对每次模型输入实施 AES-256-GCM 加密。主机锁定为 `dashscope.aliyuncs.com`。token 只在包装脚本内存和子进程环境中短暂存在，不进入命令行、Git、清单、日志或标注 CSV。

本地运行器保留为安全回归实现，但不属于当前执行路径。通用命令 `research:model:check`、`research:model:probe` 和 `research:model:run` 已指向在线运行器；本地备用命令显式改名为 `research:model:local:*`。

## 已完成的真实验证

- DashScope 加密合成 probe 成功：模型 `qwen3.7-max`、输入 567 tokens、输出 59 tokens、`structured_result_valid=true`，没有读取或发送研究内容；
- 50 条固定选择集的本地定位检查通过：`selected_count=50`、`selection_id=d90cd1946eae4661`、`identity_blind=true`、`human_annotations_loaded=false`、`content_persisted=false`；
- 两条已知代码本冲突在模型运行前完成冻结，排除文件没有加载模型标签；
- 3 条真实内容烟雾运行被平台的数据外传策略在执行前阻止，因此没有选择文件、运行目录或真实模型标签产生，也没有真实帖子被发送。

随后已采用无标签、等距顺序规则生成新的 3 条烟雾选择：`selection_id=79457ff17b39ee90`。选择 CSV 的 SHA-256 为 `a01d087b474e1992b1c94d69a75c0765c89e672c1a58535c5adb40d36dd0a6e3`，选择清单的 SHA-256 为 `a74b037bf596cb35c204cd639d239ae9a2bb432579fb3a0e12743b63a894da22`。该选择的本地内容定位检查为 3/3。向 DashScope 发起的真实加密烟雾运行再次被组织数据外传策略在进程启动前拒绝；目标运行目录不存在，真实正文仍未发送。

冻结排除项位于本机研究输出目录，不进入 Git：`exclusions.csv` 的 SHA-256 为 `eaab7d8040c5d3584dc0441420c4ac416acac56ec1f18284a820b93940a3733f`，`exclusion-manifest.json` 的 SHA-256 为 `024ef669e3592fa1d7986da5356c132b2180fb868677982fd361fbb845e4f49a`。

加密适配已经实现并通过端到端合成探针。应用层加密降低了传输链路暴露面，但服务端推理仍需解密，因此不能把它表述为“云服务商无法接触输入”。

## 在线数据传输门禁

在线运行器执行真实标注时同时要求：

- HTTPS；
- 调用主机与 `ExpectedHost` 完全一致；
- 禁止 URL 用户名、密码、查询参数和片段；
- 禁止 IP 地址和所有 HTTP 重定向；
- 包装脚本显式提供 `-AuthorizeRedactedResearchTransfer`；
- Python 进程接收固定授权短语，缺失或不一致时在创建输出目录前失败；
- 只读取去身份后的固定 selection，不读取人工标签；
- 没有 mock、规则回退或远程失败后的自动替代模型。

论坛正文只在内存中进入请求。磁盘仅保存盲化项目号、受控标签、置信度、证据码、运行指纹和累计 token 用量。失败清单只记录错误码和盲化项目号，不保存请求正文或响应原文。

## 结构化标签约束

模型必须输出：

- `facilitation_present`：`yes/no/uncertain`；
- 一个主要功能和零个或多个次要功能；
- `0—1` 置信度；
- 仅来自预定义枚举的证据码。

主要功能和每一个次要功能都必须有匹配证据码。`no` 只能与 `no_other_directed_action` 搭配，`uncertain` 只能与 `insufficient_context` 搭配。自由文本理由、额外字段、无匹配证据、重定向、超大响应或非结构化结果均使运行失败。

## 人机评估减法

正式评估只使用“是否促进 + 主要功能”，不评估人工次要功能。模型运行前已经冻结两条 `codebook_boundary_conflict`；人工 `uncertain` 自动进入描述性范围，不进入硬评估。

评估工具同时报告：

- 模型弃答率与覆盖率；
- 把弃答计为错误的总体准确率；
- 仅在模型作答样本上的选择性准确率；
- “是否促进 + 主要功能”的联合完全匹配；
- 参考为 `yes` 时的端到端主要功能准确率；
- 双方均为 `yes` 时的条件主要功能一致率及其选择偏差警告；
- 盲化分歧 selection，供后续人工裁决。

工具固定声明：单人参考候选不是金标准，结果不能外推到 14 万条总体，不能解释为干预因果效应。

## 当前可用命令

合成探针，不发送真实研究内容：

```powershell
npm run research:model:probe
```

真实 50 条的本地定位检查，不联网发送正文：

```powershell
npm run research:model:check -- `
  -InputRoot "C:\Users\tiany\Nutstore\2\我的坚果云\cmooc研究数据24-25" `
  -SelectionFile "$env:LOCALAPPDATA\cmooc-research\p1g\human-reference-50-v1\validation-selection.csv"
```

`research:model:run` 已实现，但在当前平台策略允许私有研究数据传输之前不得执行。

## 自动化验收

- Python 编译检查通过；
- 在线运行器与评估器专项测试 8/8 通过；
- 完整研究工作流测试 49/49 通过；
- 项目单元、数据库集成和研究测试全部通过；
- Next.js 生产构建通过。首次构建曾因坚果云锁定 `.next` 缓存文件出现 `EBUSY`，清理已验证的构建缓存后重试成功。

## 当前不可声称

- 不可声称已完成 50 条在线模型标注；
- 不可声称模型比人更准确；
- 不可把模型内部一致性写成外部效度；
- 不可将弱标签连接到在线干预、学习者画像或稳定人格；
- 不可把“匿名化”写成研究内容已失去全部隐私或数据治理风险。
