# Operator 接口（兼容控制面）

- 更新日期：`2026-08-02`
- 状态：`COMPATIBILITY API / NOT AUTONOMY AUTHORITY`

本文件描述旧预演/operator 和 MANUAL 审阅接口。它们仍用于本地回归和兼容，但当前
产品主链是 `autonomy:tick` 与 `/autonomy/*`。当前事实见
[PRODUCT_CURRENT](PRODUCT_CURRENT.md)，文档层级见 [README](README.md)。

## 边界

- 系统默认只监听 `127.0.0.1`；
- operator 只能读取状态、生成预演、刷新旧世界模型和控制旧预演 scheduler；
- operator 不能取得真实论坛写权限；
- 所有本地修改请求必须是可信本机地址上的同源 `application/json`；
- 当前代码硬锁使旧 MANUAL 发布接口也无法产生真实外部写入；
- 远端结果不确定时不得盲重试。

`GET /api/operator/manifest` 是这套兼容 operator 的机器事实来源，不是新自治
schema、Policy/Permit 或 `autonomy:tick` 的完整契约。

## 当前自治入口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/autonomy/status` | 自治运行、World/Graph、决定、incident 和外部效果摘要 |
| POST | `/api/autonomy/maintenance/recover` | 本地恢复 expired/failed 运行状态，不写论坛 |
| POST | `/api/autonomy/outcomes/reconcile` | 预检并只读观察合格 outcome 窗；当前 R24 observed、R72 pending |
| POST | `/api/autonomy/incidents/{id}` | 可信同源 JSON 的异常确认/解决；只写本地去正文治理回执 |

自治页面为 `/autonomy`、`/autonomy/world`、`/autonomy/decisions`、
`/autonomy/runs/[id]`、`/autonomy/outcomes` 和 `/autonomy/policy`。Policy 页目前是
只读视图，没有通过 operator 写入自治策略的捷径。

事故治理路由只接受两个字段：`action` 为 `acknowledge` 或 `resolve`，
`expectedEvidenceHash` 为页面当前记录的完整证据哈希。它使用该哈希做乐观并发核对，
相同目标状态幂等；真实转移追加 `ReviewEvent`，有关联运行时同时追加 Decision Tape。
接口不接受备注正文、身份或平台定位，也不提供发布能力。

L3 使用 `npm run autonomy:l3 -- <command>` 的受控本机一次性入口完成 STAGE、publish
和 relock。它不是远程 operator API，不接受普通客户端布尔值升级权限；真实 mutation
还必须消费签名 STAGE、单动作 policy、Permit 和 scoped write grant。

## 兼容发现与只读接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/operator/manifest` | 旧 operator 机器契约 |
| GET | `/api/operator/api-docs` | 旧契约目录 |
| GET | `/api/operator/status` | 旧预演运行状态 |
| GET | `/api/operator/research?format=digest` | 研究摘要 |
| GET | `/api/operator/auth-status` | 只返回认证能力摘要，不返回敏感值 |
| GET | `/api/auto-intervention/llm-status` | 旧草稿流水线模型状态 |
| GET | `/api/auto-intervention/scheduler` | 旧易失预演 scheduler 状态 |
| GET | `/api/auto-intervention/runs` | 旧预演运行列表 |
| GET | `/api/interventions/{id}/context` | 脱敏 O-I-E 上下文 |

上述状态不能证明新自治 renderer 已启用、外部 schedule 在运行或真实执行获得授权。

## 兼容动作入口

```http
POST /api/operator/actions
Content-Type: application/json

{
  "actionId": "run_preview",
  "input": {
    "maxScanPosts": 10,
    "maxCandidateCount": 5,
    "minScore": 75
  }
}
```

兼容动作包括状态读取、研究摘要、认证摘要、单次预演、旧世界模型刷新和旧预演
scheduler 的 start/once/stop。它们全部满足 `forumWrite=false`。请求中的
`allowRealPublish` 或临时真实模式参数不能扩大权限。

旧 scheduler 使用应用进程内状态，不是 `ScheduledInvocation`、数据库 lease 或
`autonomy:tick` 的替代品；当前产品文档不再用它证明长期自治运行。

## MANUAL 审阅接口

以下路由仍存在：

```text
POST /api/auto-intervention/candidates/{id}/promote
POST /api/auto-intervention/candidates/{id}/skip
POST /api/interventions/{id}/draft
POST /api/interventions/{id}/skip
POST /api/interventions/{id}/authorize-publish
POST /api/interventions/{id}/publish
POST /api/interventions/{id}/reconcile
```

它们实现候选固化、正文/目标指纹绑定、一次性授权、幂等发布尝试和结果不明核对的
旧 MANUAL 状态机。当前硬锁下 authorize/publish 不能执行真实论坛写入；设置页也
不能解除。该链没有自动变成 AutonomyPolicy、ExecutionPermit 或 AUTO Committer。

## 结果不明

旧 MANUAL 状态机在网络超时、连接中断或证据不足时进入
`reconcile_required`，禁止自动重发。人工核对属于兼容恢复能力，不是当前自治
outcome。新自治链未来必须以 Permit、attempt、目标/内容/版本和远端回执重新建立
生产级核对，不能直接复用一个旧状态名宣称完成。
