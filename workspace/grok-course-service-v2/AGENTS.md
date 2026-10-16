# cMOOC 独立课程服务

你拿到的是可独立运行的能力包，不需要安装 Codex。先读 README.md。

1. 校验 `node verify-package.mjs`，然后 `npm ci`、`npm run service:setup`、`npm run service:doctor`、`npm run service:smoke`、`npm run service:smoke:r2`、`npm run service:smoke:operations`。
2. 在当前主机运行 `npm run --silent service:manage -- start`，长期守护配置见 README。用 `npm run --silent service:cli -- health` 核验。
3. 能配置 MCP 时，使用当前目录和 `npm run --silent service:mcp`；否则用 CLI。不要自行把 HTTP 端口暴露到公网。
4. 必须取得明确课程入口才能登记真实课程。使用你自己的浏览器和经授权的登录会话，不索取或复制旧电脑的 Cookie/token。
5. 每轮按登记/读取课程、创建/恢复回合、claim、读取 guidance、实际观察、保存 observation、保存 proposals、核对 middleLayer、finish 工作。claim/patrol_begin 二选一；finish/patrol_end 二选一。具体结构用 `npm run --silent service:contracts` 查看。
6. 原文与真实身份留在课程平台；只保存契约允许的结构化观察和去身份摘要。未知创建时间保留 null，缺失观察保持局部；有真人回应时按规则让位，但纯感谢不能记作实质接续；continuation 需要回复引用。共用页面中的各讨论必须提供各自 stableKey，否则仅作观察内身份。
7. 公开知识卡是未验证候选，应用前核对适用条件。你的判断与教师审核必须分开，不自动批准经验或授权发布。
8. 本包真实发布固定关闭。stage 仅允许按任务要求填草稿、回读、清空，不能提交或通知。
9. 报告实际完成状态；安装/合成 smoke PASS 不等于已完成真实课程巡查或取得教育效果。

初次安装完成后，报告健康状态和可调用能力，并等候或使用用户已经明确给出的课程入口。不要凭示例域名虚构真实观察。

主链必须为 course-companion/v2（24 tools）。先调用 get_runtime_identity，再用 get_course_summary 读取现有观察摘要。不同 Bot 使用不同 CMOOC_MCP_SESSION；重启使用原名接续。读取结构化错误字段再重试；finish 响应丢失时沿用原 operationKey 和 summary。私有迁移按 README 单独执行，禁止把迁移文件放进源码包。
