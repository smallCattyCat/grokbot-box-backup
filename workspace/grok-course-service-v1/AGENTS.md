# cMOOC 独立课程服务

你拿到的是可独立运行的能力包，不需要安装 Codex。先读 README.md。

1. 校验 `node verify-package.mjs`，然后 `npm ci`、`npm run service:setup`、`npm run service:doctor`、`npm run service:smoke`。
2. 在当前主机常驻运行 `npm run --silent service:start`。用 `npm run --silent service:cli -- health` 核验。
3. 能配置 MCP 时，使用当前目录和 `npm run --silent service:mcp`；否则用 CLI。不要自行把 HTTP 端口暴露到公网。
4. 必须取得明确课程入口才能登记真实课程。使用你自己的浏览器和经授权的登录会话，不索取或复制旧电脑的 Cookie/token。
5. 每轮按登记/读取课程、创建/恢复回合、claim、读取 guidance、实际观察、保存 observation、保存 proposals、核对 middleLayer、finish 工作。claim/patrol_begin 二选一；finish/patrol_end 二选一。具体结构用 `npm run --silent service:contracts` 查看。
6. 原文与真实身份留在课程平台；只保存契约允许的结构化观察和去身份摘要。未知创建时间保留 null，缺失观察保持局部；有真人接续时按规则让位。
7. 公开知识卡是未验证候选，应用前核对适用条件。你的判断与教师审核必须分开，不自动批准经验或授权发布。
8. 本包真实发布固定关闭。stage 仅允许按任务要求填草稿、回读、清空，不能提交或通知。
9. 报告实际完成状态；安装/合成 smoke PASS 不等于已完成真实课程巡查或取得教育效果。

初次安装完成后，报告健康状态和可调用能力，并等候或使用用户已经明确给出的课程入口。不要凭示例域名虚构真实观察。
