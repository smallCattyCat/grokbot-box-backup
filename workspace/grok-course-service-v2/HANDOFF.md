# 给 Grok Bot 的 cMOOC 课程服务交接说明

这是一个可以在 Linux Node 22 主机独立运行的课程服务源码包。它不依赖 Codex，也不要求启动 Next.js 页面；Grok Bot 通过本机 HTTP 管理接口、CLI 或 stdio MCP 调用课程能力。服务默认只监听 127.0.0.1:3050，同一台云主机上的 Bot 可以直接使用，默认不会把端口暴露到公网。

## 先做一次安装和检查

    node verify-package.mjs
    npm ci
    npm run service:setup
    npm run service:doctor
    npm run service:contracts
    npm run service:smoke
    npm run service:smoke:r2
    npm run service:smoke:operations

service:setup 会在 CMOOC_SERVICE_DATA_DIR 中创建本机数据库并部署 Prisma migrations。默认数据目录是包根目录下的 .cmooc-service-data；生产部署建议通过环境变量改到独立的持久化目录。portable service 不自动加载 .env，直接运行时请先 export CMOOC_SERVICE_DATA_DIR 和 CMOOC_SERVICE_PORT，或把相同变量交给 Docker environment。数据库、登录态和运行日志都不在这个源码包里。

## 启动和调用

    npm run --silent service:start
    npm run --silent service:cli -- health
    npm run --silent service:cli -- workspace
    npm run --silent service:cli -- knowledge --input request.json
    npm run --silent service:mcp

Grok Bot 的 MCP 配置应运行 npm run --silent service:mcp，工作目录设为本目录。--silent 用来避免 npm banner 污染 stdio MCP。MCP 使用 stdio，不需要把 MCP 端口开放到公网。CLI 适合一次性管理动作和脚本化调用；课程观察、回合、租约、公开实践候选检索和恢复状态由服务端持久保存。

knowledge 只检索随包携带的公开实践候选，不自动接纳为课程经验。公开卡片是已有公开链接与自写摘要形成的候选资产，正式使用前仍需课程级审阅。

## 课程和平台连接

课程必须通过显式 manifest 或 CLI 管理动作注册。真实课程登录态、平台 token、浏览器 profile、课程 ID、账号和其他连接器配置由 Grok 所在环境按其权限注入；本包不转移本机登录态，也不包含任何私有正文、身份映射或数据库。

默认运行模式使用 observe（观察与影子提议）；stage 只允许编辑器读回演练且不得提交。真实发布默认关闭。课程平台写入、通知或其他外部副作用需要独立的版本化策略和动作授权。服务只保存去正文事件、回合状态、候选、决定、回执和可恢复游标。

## 给 Bot 的最小操作指令和 JSON

可以把下面这段作为 Grok Bot 的启动指令：

    你是课程共同体促进 Bot。先用 workspace 或 health 了解状态；课程必须通过显式 add 注册后才能 run。每轮按 claim（或 patrol_begin，二选一）、guidance、只读观察、proposals、必要时 stage、finish（或 patrol_end，二选一）运行。观察必须来自当前课程页面，不能凭空补时间、身份或正文。默认使用 observe；公开 knowledge 结果只是待审阅候选，不能自动接纳为经验；真实发布和通知始终保持关闭，遇到登录失效或证据不足就 attention/relogin_required 并保留可恢复状态。

先准备 add-course.json：

    {
      "action": "add",
      "course": {
        "title": "示例课程",
        "entryUrl": "https://example.invalid/course",
        "platformLabel": "示例课程平台",
        "goal": "观察本周讨论并识别适合共同体接续的机会",
        "budget": 1
      }
    }

然后运行：

    npm run --silent service:cli -- add --input add-course.json

把返回对象的 id 写入 run-course.json（requestId 每次新建回合都使用新的 UUID）：

    {
      "action": "run",
      "courseId": "把 add 返回的 course.id 填在这里",
      "requestId": "00000000-0000-4000-8000-000000000001",
      "goal": "完成一轮只读观察并保存影子提议",
      "mode": "observe"
    }

    npm run --silent service:cli -- run --input run-course.json
    npm run --silent service:cli -- claim --input claim.json

claim.json 至少包含返回任务对象的 id：

    {
      "runId": "把 run 返回任务对象的 id 填在这里"
    }

实际观察和 proposals 必须严格遵循 service:contracts 输出的 schema；回合结束使用 finish 或 patrol_end，并把摘要写入对应 JSON 文件。CLI 的 default session 会把租约保存到私有数据目录，后续调用必须沿用同一 session。

## 可选容器运行

Linux 主机可以使用 deploy/grok/compose.yml。该模板使用 host network 和服务的 loopback 绑定，不配置公网端口映射；它适合 Bot 与服务在同一台 Linux 主机上的情况。容器内的桥接密钥保存在 volume 中，因此宿主直接执行 CLI/MCP 不能代替容器内调用。使用：

    docker compose -f deploy/grok/compose.yml up -d
    docker compose -f deploy/grok/compose.yml exec -T cmooc-course-service npm run --silent service:cli -- health
    docker compose -f deploy/grok/compose.yml exec -T cmooc-course-service npm run --silent service:mcp

Docker 不是运行本包的必要条件，直接使用 Node 22 与 npm 即可。

## R2 主链、后台运行与恢复

主链身份是 `course-companion/v2`，MCP 名称 `course-companion-v2`，24 个工具。先运行 `service:cli -- identity`，核对 protocol、namespaceId、instanceId 和 packageDigest。旧 `cmooc` 的 32 个工具不属于本包主链。MCP 启动会拒绝协议不符的服务。

    npm run --silent service:manage -- start
    npm run --silent service:manage -- status
    npm run --silent service:manage -- watchdog
    npm run --silent service:manage -- stop

start 在后台启动服务；watchdog 自身是常驻进程，遇到崩溃按有上限的退避重启，主动 stop 会阻止它再次拉起。主机重启后自动运行可使用 systemd：

    npm run --silent service:manage -- systemd --output /tmp/cmooc-course.service

审阅生成文件后，由主机管理员放入 systemd 服务目录并 enable。此命令只生成文件，不安装系统服务。也可使用上面的 Docker compose，其 restart 策略负责容器恢复。service:start 仍是前台调试入口。

所有 service 入口自动把 LOCALAPPDATA 指向持久化目录内的 private 子目录；不要让数据库和此目录分离。doctor 检查中层环境与身份密钥。已有数据库缺失身份密钥时会明确报错，不会静默创建另一套证据身份。

CLI 使用相同 --session 接续；MCP 使用相同 CMOOC_MCP_SESSION（默认 default）。不同 Bot 必须使用不同名称，同名连接器不能同时占用。owner 和租约保存在私有数据目录，连接器重启可继续原租约；服务重启不会清空它。到期或被明确停止的租约仍需重新 claim。claim/patrol_begin 二选一，finish/patrol_end 二选一。重试沿用 operationKey，创建回合重试沿用 requestId。

完成响应丢失时，以相同 operationKey 和相同 summary 重试 finish，服务只返回已完成回执（completionReadback），不会再执行一次。登录失效仍需新主机浏览器重新登录；relogin_required 保留此前观察，恢复后先重读状态再续跑。

## 摘要、接续和错误

    npm run --silent service:cli -- summary

MCP 的 get_course_summary 可指定 courseId，直接返回覆盖范围、结构回应、接续功能、运行异常和下一步建议，不必让人转述 Tape。摘要只覆盖已有观察，并标明浏览器解释来源。

同一课程入口可以承载多个讨论，但每条讨论应传平台稳定标识 stableKey，例如平台讨论 ID。没有稳定 ID 且没有唯一帖 URL 时，只在本轮观察中识别，不冒充跨轮相同讨论。不要给不同讨论编造相同 stableKey。

观察中的 continuation 用 kind、evidenceRefs、interpretedAt、followup 表达接续功能。纯感谢为 acknowledgement，不计作实质 peer_continuation；澄清、解释推进、纠正、资源使用、同伴连接需要对应回复引用。未知就保留 unknown。结构上已有真人回应仍可触发 YIELD，但不因此宣称探究已推进。公开知识检索始终带 PUBLIC_CANDIDATE / 待审标签；课程经验另带课程范围、审核状态和适用性要求，Bot 不得抹掉这些标签。

失败返回 code、stage、retryable、recoveryAction、operationId、savedProgress。先按这些字段处理租约、输入、中层或 finish 问题；已保存观察/提议不能因后续失败而当作整轮未执行。

## 跨机迁移课程状态

普通源码包仍不包含私有课程状态。需要保留课程登记、队列、数据库和证据身份时，在旧主机停止服务后单独导出：

    npm run --silent service:manage -- stop
    npm run --silent service:state -- export --file /private-backup/course-state.json

此文件是私有数据，必须由你通过受控渠道传到新主机，不能放入源码包、Git、普通日志或发给公共模型。新主机使用空持久化目录：

    npm run --silent service:state -- import --file /private-backup/course-state.json
    npm run service:setup
    npm run service:doctor
    npm run --silent service:manage -- start

import 不覆盖非空目录；迁移保留课程和回合标识、数据库、namespace 及证据密钥，清除旧进程锁和连接器租约，活动回合回队等待重新认领。浏览器登录不迁移，新主机必须重新验证访问。导出时必须没有运行中的服务。

从 v1 升级时，先停止原来的前台/容器服务；旧服务没有 manager 状态时不能用新 manager 代停。把 CMOOC_SERVICE_DATA_DIR 显式设为原持久化目录，再运行 v2 setup；不要误用新目录而以为旧课程消失。修改前先做停服私有备份。不要把运行后的目录当成新的源码交接包发送。

## 能力与当前边界

24 个 MCP 工具涵盖课程登记、回合创建/接手、观察、提议、中层评价、经验读取、公开知识检索、回执和恢复。浏览器由 Grok Bot 提供；服务不会代替 Bot 登录课程或从网络自动采集正文。现有经验可读，正式经验接纳仍需有身份依据的教师审核通道，本包不会把 Bot 自述当作教师批准。

公开资料包含 200 张条件化卡片与 196 个来源。检索使用词项匹配，保留来源链接、许可核验范围、适用与不适用条件；它不是语义搜索，也不代表 cMOOC 效果已验证。

包内没有发布入口、真实平台登录态或旧课程数据库。默认 observe 可以端到端完成影子判断，stage 只记录外部编辑器的回读与清空，均不能发布。HTTP 仅供同机调用；若服务与 Bot 位于两台机器，应另行部署有认证的网关，不能直接把监听地址改为公网。

需要重建交接包时，在原开发仓库运行 handoff:build；本包只提供经过验证的 service:* 运行命令。
