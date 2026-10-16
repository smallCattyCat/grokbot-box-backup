# P4C-1 deny-by-default 能力网关与只读控制入口

## 1. 检查点范围

P4C-1 建立第一个可运行的能力控制纵向切片：

```text
CapabilityRequestV1
  → deny-by-default CapabilityGateway
  → ControlApplicationService
  → ForumAdapterRegistry
  → manifest / status / adapter doctor
```

该切片复用 P4A 的 `CapabilityRequestV1` 和 P4B 的
`ForumAdapterRegistry`。既有 operator 目录只作为兼容摘要，不复制动作定义，
也不改变旧发布内核。该安全底座现已冻结；stdio/MCP、第二客户端及更多控制命令
不再作为独立的下一阶段，只有产品黄金路径出现真实消费者或已复现缺口时才扩展。

## 2. 能力策略

能力类别固定为 `read`、`local_mutation` 和 `external_write`。策略默认拒绝，
未知能力、未知字段、非法 principal 和命令参数均 fail closed。

`local_ui`、`local_cli` 和 `agent_client` 当前获得规划中列出的十项非外部写
能力。`forum.execute_authorized` 虽保留在目录中供协议识别，但 P4C-1 对所有
principal 均拒绝：

| 项目 | P4C-1 值 |
|---|---:|
| capability 数 | 11 |
| external-write capability 数 | 1 |
| external-write grant 数 | 0 |
| 智能体 external-write grant 数 | 0 |
| `realPublishEnabled` | `false` |

请求参数不能引入未声明字段。因此 `realPublishEnabled`、任意 publish 标志或
正文参数都会使整个调用成为 `INVALID_CONTROL_INVOCATION`，不会降级执行或进入
adapter。

## 3. 统一 application service

`ControlApplicationService.invoke()` 是 P4C-1 唯一业务入口。输入只接受：

```ts
{
  principal: {
    type: "local_ui" | "local_cli" | "agent_client";
    ref: string;
  };
  operation: "manifest" | "status" | "adapter.doctor";
  adapterId?: string;
  correlationId?: string;
}
```

每个成功或失败结果都使用 `cmooc.control-result.v1`，并包含：

- `ok`；
- `correlationId`；
- `operation` 与所需 `capability`；
- `policyVersion`；
- `data` 或受控 `error`；
- `containsForumText=false`。

`manifest` 返回能力目录、principal 授权计数、当前 registry 快照、adapter
manifest 和 operator 兼容摘要。`status` 返回 P4 阶段、安全边界和研究时钟契约；
其中继续冻结固定真实时钟、逐行 as-of、2024 开发、2025 时间留出和非因果表述。
`adapter.doctor` 只调用 `inspectAuth()`，不调用 `listThreads()`、
`observeThread()`、`bindTarget()`、`preflight()` 或 `executeAuthorized()`。

## 4. 本地命令

```powershell
npm run cmoocctl -- manifest --json
npm run cmoocctl -- status
npm run cmoocctl -- adapter doctor --adapter cmooc
```

三个命令均输出结构化 JSON。`cmooc` 是 `cmooc.api` 的 CLI 别名。本地 doctor
只读取环境变量是否配置及 `playwright/auth-state.json` 的 cookie 元数据，不请求
论坛认证端点，不输出 token、Cookie 值或论坛正文。它即使发现本地认证配置，也只
报告 `canExecuteAuthorized=false` 和 `realPublishEnabled=false`。

CLI 运行时只注册真实平台只读 `cmooc.api` 实例。P4B 的四类 adapter 能力仍由
P4B conformance suite 和 adapter 审计证明；不为仅执行 manifest/status 而创建
额外假平台、智能体或审批层。

## 5. 验收证据

定向验收：

```powershell
npm run type-check
npm run test:p4-capability
npm run p4:capability:audit
```

审计使用固定时钟和 poison 论坛读取依赖，只输出聚合计数。通过条件为：

- 三类 principal 的外部写决策全部拒绝；
- gateway 与 adapter 的真实外部写授权数均为 0；
- manifest、status、doctor 均返回关联 ID 和结构化结果；
- doctor 只调用一次合成认证摘要；
- 论坛读取或网络依赖调用数为 0；
- 参数升级尝试被严格字段校验拒绝；
- 全部产物 `containsForumText=false`。

## 6. 与研究问题的关系

本检查点提供客户端无关的安全调用基础：能力请求、策略判定和 adapter 调用不把
权限交给具体客户端。当前只实际验收了本地 CLI，因而不构成跨客户端比较证据，
也不单独回答 RQ3。RQ3 的实施链可追溯证据现已由 P4D-1 补足，预声明合成情境
中的规则级实施保真证据现已由 P4F-lite 产生。

P4C-1 不新增 RQ1 或 RQ2 的研究结论，只在状态契约中保留 P3A 的时点证据边界。
RQ4 仍明确留给未来随机分配，当前控制入口不产生真实论坛干预。

## 7. 冻结与后续触发条件

当前不单独开发 P4C-2。P4D-1 产品黄金路径和 P4F-lite 情境验证均已完成，并复用
这里已有的安全服务。只有出现真实第二客户端，或现有入口无法表达新的已复现研究
需求时，才恢复 stdio/MCP 或 UI/API 接线；“以后可能需要”不构成扩建理由。
当前统一状态见
[产品机理与当前完成状态](PRODUCT_MECHANISM_AND_CURRENT_STATUS.md)。
