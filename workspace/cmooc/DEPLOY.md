# 本地部署与运行边界

- 更新日期：`2026-08-03`
- 状态：`LOCAL DIAGNOSTIC / RC12 GOVERNED SHADOW DEPLOYMENT / NATURAL END-TO-END VALIDATED / AUTOMATION UI DIRECTIVE LIMITATION OPEN`

当前版本是单研究者本机工具，没有多用户认证系统。历史 L3 已在受控本机完成一次
单动作 production Committer；RC9 历史七个 schedule/governance 双绑定的 SHADOW
invocation 均为 0 编辑器写入、0 发布，其中多轮来自真实自动任务。Docker/常规启动
默认只运行真实只读 shadow、
World/Graph 和本地研究/兼容页面，不会获得持续发布能力。当前状态见
[产品当前状态](docs/PRODUCT_CURRENT.md)。

## Docker 启动

1. 复制 `.env.production.example` 为本机 `.env`，只填写任务需要的配置；
2. 执行 `docker compose up -d --build`；
3. 只在运行 Docker 的电脑上打开 `http://127.0.0.1:3000/`。

Compose 默认把端口绑定到宿主机回环地址。SQLite 数据库和本机浏览器诊断状态位于
持久卷；重建镜像不会自动删除。正式运行前应先执行迁移并检查 `/autonomy` 与
`/autonomy/governance` 状态。

开发库的治理策略、生命周期与外键对齐 migrations `20260802130000`、
`20260802140000`、`20260802150000` 已在数据库长度/SHA-256 备份后使用
`npm run prisma:migrate` 应用，当前
18/18 migrations 到位。迁移后 integrity、外键、schema diff、既有 ID 集和部分唯一索引
均通过，先前 `InterventionTask`/`PublishLog` 外键动作 drift 已消除。

## 当前可部署能力

- `/autonomy/*` 的真实只读扫描、World/Graph、决定和治理视图；
- `/autonomy/governance` 与显式 `autonomy:governance` CLI：核对/签发追加式、精确
  Manifest 绑定的 SHADOW 运行上限，并支持 `baseline/pause/resume/revoke/
  emergency-halt/rotate`；默认 preview，只有 `--apply` 写本地治理 DB，页面/API 保持
  只读；它们都不是发布授权；
- 事件修订、瞬时语义、DRAFT-only renderer 和第二次只读重读的本地 shadow 能力；
- `/platform` 与 `/review/live` 的页面诊断/兼容 live-runtime；
- `/review` 的冻结合成研究复现；
- operator/MANUAL 兼容 API 的本地回归；
- L3 单动作执行代码、回执与结果查看；默认硬锁，不能由部署配置自行激活；
- 有界 `autonomy:worker`、结果 ready-only 回流和事故确认/解决治理；
- 唯一 Codex cron 每 30 分钟以 `gpt-5.6-luna`、reasoning `max` 唤醒一次 worker，仅
  失败运行通知。

以下不属于当前可部署的生产能力：

- 常规 `autonomy:tick` 自动接续 STAGE/AUTO；
- 无新授权的第二次真实动作；
- 长期 production soak，以及课程策略生命周期的可选图形编辑控制台；R24/R72 已完成
  去正文、非删失、非因果观察，但不构成教育效果证据；
- 多用户、校园网/公网直接服务；
- 教育效果采集或因果结论。

## 在线模型

仓库保留在线模型配置供兼容草稿/研究路径使用。密钥只放在本机环境变量或未提交的
环境文件中。当前 `autonomy:tick` 只在 DRAFT 上启用 semantic renderer，且没有
在线 generator，默认使用确定性回退并不发送论坛正文。配置在线模型不会自动接入
该主链，也不会扩大课程、目标或发布权限。

## 浏览器状态

合规登录态只应用于本机、明确范围内的只读诊断或未来经授权的测试。不要把浏览器
状态复制进仓库、日志或回复；不要导出普通浏览器 Cookie。认证状态可用也不代表
某个目标已获执行许可。

## 外部效果硬边界

- `realPublishEnabled=false`；
- 设置页的发布开关受代码硬锁限制，不能开启；
- 旧 MANUAL 授权/发布路由会被硬锁拒绝；
- 新自治执行器的真实 transport 只能在签名 scoped grant、已消费 STAGE、有效
  Policy/Permit 和当次明确授权同时成立时运行；
- 2026-07-31 的一次授权已消费，当前 0 active real policy、0 open Permit；
- R24 与 R72 均已形成去正文、非删失、非因果的描述性观察；两者都不是教育效果证据；
- 历史全局 L3 attempt=1 与当前 focal invocation 分开统计；当前 focal editor/publish
  均为 0，页面不会把历史全局计数归给最近运行；
- 先前 1 个 high `tick_failed` 事故已保留原证据并标记为 acknowledged；因没有可验证
  的根因/修复记录，它仍未 resolved。当前 open high/critical 为 0，写锁不变。

任何后续动作必须重新取得课程 Policy、单动作 Permit、写前重读和明确授权，并继续
通过幂等、写后核对、结果不明恢复和紧急停止约束。

## 定时只读 worker

当前只启用一个本机 Codex 定时任务 `cmooc-community-autopilot-shadow`。为避开 Nutstore
对源码依赖的偶发文件锁，它每 30 分钟在经过生产构建验证的版本化本地运行镜像
`C:\Users\tiany\AppData\Local\cmooc-autonomy-runtime\v1-rc12-release` 中以
`gpt-5.6-luna`、reasoning `max` 执行一次；通知策略为 failed-only：

```powershell
npm run autonomy:worker -- --limit 1 --wake-source codex_automation --runtime-version v1-rc12
```

源码目录仍是代码权威；运行镜像不复制本地课程 manifest、浏览器认证状态、`.env`、
凭据或数据库副本，其中的 `.env.local` 只包含项目原开发库与源码课程 manifest 目录的
绝对路径，不含凭据。代码或依赖变化后必须创建新的版本化镜像、完成验证并原子更新
定时任务，不能在周期运行中同步或改写镜像。

开发库清理在带哈希备份后删除了 181 条已知合成记录和 7 条误入的 manifest-only
记录；当前保留 3 个 manifest 与 3 个 schedule，仅真实课程各 1 个 enabled。清理未
改写真实运行、L3、outcome 或事故证据。恢复 fixture 时只能使用显式别名和独立测试
数据库，不能用宽泛前缀更新生产开发库。

任务只允许 `OBSERVE/SHADOW`，在任何运行写入前核验 disk/DB Manifest、当前不可变
CourseOperationGovernancePolicy 与 schedule 绑定；使用数据库 lease、heartbeat、
游标和幂等状态恢复。缺失、漂移、暂停、撤销、过期或 emergency halt 一律 fail
closed。RC12 本地持久化到期槽已完成 `due/executed/failed=1/1/0`；期间旧 RC9 自动
唤醒因课程租约繁忙安全 skip。首条自然 `codex_automation/v1-rc12` worker 虽 completed/
exit 0，其 Codex 外层曾因 300 秒上限误超时；底层进程仍持有有效租约并在约 14 分 47 秒后
完成。将 shell timeout 改为 20 分钟并移除自建 stdout 解析后，随后两轮自然 worker
分别约 13 分 30 秒和 13 分 38 秒 completed/exit 0，外层任务分别约 15 分 51 秒和
15 分 39 秒 completed，并直接保留安全 JSON；单轮
`due/considered/executed/failed=1/1/1/0`。当前 23 条 wake receipt 中 22 条 completed、
1 条 shutdown-abandoned，自动/本地来源为 13/10，累计
`due/considered/executed/skipped/failed=17/17/16/1/0`，恢复租约 1、结果回流 1，
编辑器写入和发布尝试始终为 0。第二轮使用封闭六键 JSON，JSON 本体正确，但 Codex 自动
任务框架仍在其后追加 UI 收件箱指令；课程平台无副作用，应用 notification policy 仍为
failed-only，提示词层无法进一步消除该框架行为。长期 shadow soak 仍未完成。最新
health 为 `healthy`：running/expired/failed=0，pending/overdue outcomes=0，open
incidents=0。

RC8/RC9 的早期运行基线（10 条终态安全回执、累计 `due/executed/failed=7/7/0`，
以及首条自然 `codex_automation/v1-rc9` completed/exit 0）保留为历史证据，不替代
当前 RC12 运行结论。RC11 的关机中断、abandoned wake receipt、3 条 companion 失败和
`COURSE_ID_UNVERIFIED` 根因同样保留为历史；RC12 只对详情绑定竞态做显式等待和一次
有界重试，结构不匹配继续 fail closed。

退出码 0 表示完成，2 表示需要注意，1 表示失败。通知策略为仅失败运行。系统没有
并行的 Windows 计划任务，也不使用应用内 `setTimeout` scheduler 证明长期运行。
RC12 已恢复 38/38 个历史 API 位置漂移范围，可信 companion 均提供稳定 ID、父链闭合、
零分页失败和权威终止证明；当前只剩 2 个空/删除正文 tombstone，因此覆盖保持
`lower_bound`，不计算 PageRank/k-core。没有失败尝试，worker 不通过重试扩大写权限。

最新持久化扫描为 7/7 个栏目、64/64 个主题详情和 1,578 个观察事件；Graph 为
408 个节点、2,103 条边和 72 个明确 learner 角色节点。真实发布硬锁继续开启，编辑器
写入和发布尝试均为 0。

## 远程访问

当前版本不支持直接公网部署。确需远程访问时，必须由部署者在前方增加带身份认证的
HTTPS 反向代理，并设置唯一公开 origin；不能直接暴露容器的 3000 端口。即使加了
反向代理，也只改变访问方式，不会把当前 shadow 工具升级为可真实发布的生产系统。

## 备份

定期备份持久卷中的 SQLite 数据库；迁移前先记录文件长度与 SHA-256，再运行
`prisma migrate deploy`，迁移后核验 `integrity_check`、外键和 migration 数。任何包含
登录态的文件都按凭据处理：隔离保存、不提交 Git、不进入普通日志，不与研究数据包
混放。

`20260802150000_align_intervention_publish_fks` 为安全重建父表会在迁移连接上暂时关闭
SQLite foreign keys。项目迁移命令始终在一次性子进程中执行；失败时连接随子进程销毁，
不会在同一连接继续写入或重试。成功后命令会从新连接自动核验
`PRAGMA foreign_keys=1`、`foreign_key_check`、`integrity_check` 和完整 migration 集合。
