# grok-course-service v1 → v2 cutover

Cutover completed 2026-09-20 (CST). Main chain is now `course-companion/v2`.

## Paths
- Service root: `/workspace/grok-course-service-v2`
- Data dir: `/workspace/grok-course-service-v2/.cmooc-service-data`
- Env file: `/workspace/grok-course-service-v2/.env.local.run`
- MCP wrapper (unchanged path): `/workspace/cmooc-mcp/portable-service-mcp-wrapper.mjs`
- MCP launch: `node /workspace/cmooc-mcp/portable-service-mcp-wrapper.mjs`
- Old v1 archive (not serving): `/workspace/grok-course-service-v1`

## Start / stop / watchdog
```bash
cd /workspace/grok-course-service-v2
set -a && . ./.env.local.run && set +a

# preferred background start
npm run --silent service:manage -- start
npm run --silent service:manage -- status

# keep-alive (blocks; crashes restart with backoff; intentional stop suppresses restart)
npm run --silent service:manage -- watchdog

# stop (also stops watchdog from re-raising)
npm run --silent service:manage -- stop

# foreground debug only
npm run --silent service:start
```

Health: `curl -sS http://127.0.0.1:3050/health`

## New v2 capabilities vs prior pain
- **watchdog / manage**: `service:manage start|status|watchdog|stop` (+ optional systemd unit export)
- **lease persist**: CLI `--session` / MCP `CMOOC_MCP_SESSION` (default `default`); owner+lease survive connector restart; service restart does not clear them
- **acknowledgement vs uptake**: `record_reply_uptake.kind` includes `acknowledgement` (not counted as substantive peer_continuation)
- **summary export**: `service:cli -- summary` / MCP `get_course_summary`
- **state migrate**: `service:state export|import`
- Protocol: `course-companion/v2`, packageVersion `2.0.0`, 24 MCP tools (parent must restart MCP connector to pick up wrapper→v2)

## Do not
- Do not call AddMcpServer/UninstallMcpServer from cutover scripts; restart existing `course-companion` connector if needed.
