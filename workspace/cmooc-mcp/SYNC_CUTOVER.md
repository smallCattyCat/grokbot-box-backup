# Official course-companion MCP cutover (box loopback)

## Status (2026-09-06 PT)

- Box workbench CAN start: cd /workspace/cmooc && npx next dev -H 127.0.0.1 -p 3017
- Official course-companion-mcp.ts + browser-course modules synced from TYL Nutstore R9 (LOCALAPPDATA bridge key)
- Keep slim MCP (cmooc/server.mjs) until official server registered and healthy

## Official server registration fields (prefer wrapper)

name: course-companion
command: node
args: ["/workspace/cmooc-mcp/course-companion-wrapper.mjs"]
env: {"CMOOC_WORKBENCH_ORIGIN":"http://127.0.0.1:3017","CMOOC_WORKBENCH_ROOT":"/workspace/cmooc","LOCALAPPDATA":"/workspace/cmooc/.localappdata"}

## Direct alternative

name: course-companion
command: npx
args: ["tsx","/workspace/cmooc/scripts/course-companion-mcp.ts"]
env: same as above

Do not register until 3017 up. This prep does not call register/restart.

## Tools

get_course_workspace, claim_course_run, patrol_begin, read_course_guidance, record_course_observation, save_course_proposals, record_reply_receipt, record_editor_readback, finish_course_run, patrol_end, report_course_attention, mark_course_relogin_required

## Slim keep

name: cmooc
command: node
args: ["/workspace/cmooc-mcp/server.mjs"]
env: {"CMOOC_ROOT":"/workspace/cmooc","LLM_MODE":"mock","CMOOC_LEDGER_DB":"/workspace/cmooc-ledger-mirror/ledger-slim.db"}

Cutover: start 3017 -> register course-companion -> smoke get_course_workspace -> optional drop slim. Keep both until then.

## TYL tunnel alt

On TYL: npm run workbench:start -- --port 3017; SSH -L so
 box has 127.0.0.1:3017. OFFICIAL MCP requires loopback hostname.

## Notes
- No full Nutstore DB copy; browser-course state is .localappdata files.
- Plugin/Edge MCP only for Codex dispatch, not MCP API smoke.
- Verified: next Ready 3017; browser-courses 200; tools/list 12 tools; wrapper fails if workbench down.
- Synced: course-companion-mcp.ts, companion-workbench.ts, course-execution-worker.ts, browser-course-*.ts, companion-context.ts, facilitation-policy.ts, browser-agent/courses routes; deps sdk+zod+playwright-mcp.
