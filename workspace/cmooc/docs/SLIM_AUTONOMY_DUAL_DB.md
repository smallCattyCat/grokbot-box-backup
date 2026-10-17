# Slim ledger + autonomy dual-DB (box, 2026-10-16)

## Problem

MCP tools `cmooc_autonomy_status`, `cmooc_soak_readiness`, `cmooc_operator_status`
failed with `BRIDGE_FAILED` when `CMOOC_DATABASE_URL` pointed at the Nutstore
**slim** mirror (`/workspace/cmooc-ledger-mirror/ledger-slim.db`). Slim omitted
tables that prisma autonomy / operator paths query:

| Tool | Missing on slim |
|------|-----------------|
| autonomy_status / soak_readiness | `ForumSetting`, `AutonomyPolicy`, `AutonomyWorkerWakeReceipt` |
| operator_status | `AutoInterventionCandidate`, `AutoInterventionRun`, `AgentRun`, … (workbench) |

## Fix (least-breaking)

1. **Thin schema stubs on slim** (`scripts/ensure_slim_autonomy_tables.py`)
   - `CREATE TABLE IF NOT EXISTS` for the three autonomy tables
   - Seed `ForumSetting` with **`realPublishEnabled=0`** (force-clear if true)
   - Does **not** invent `DecisionTapeEntry` / `ForumPost` authority
   - Self-heals on each autonomy/soak bridge call after a Nutstore refresh

2. **Dual-DB routing for operator_status**
   - `CMOOC_LEDGER_DB` stays on slim (tape / patrol authority)
   - Prisma `DATABASE_URL` for `operator_status` → local `prisma/dev.db`
     via `applyWorkbenchDatabaseEnv()` (`CMOOC_WORKBENCH_DATABASE_URL`)

3. **export_slim.py** WANT list extended so future TYL refreshes carry the
   three stub tables when present on Nutstore authority.

## Non-goals / locks

- Do **not** set `realPublishEnabled=true`
- Do **not** treat slim stubs as publish authority
- TYL / Nutstore offline: stubs are enough; no refresh required for these reads

## Verify

```bash
cd /workspace/cmooc
python3 scripts/ensure_slim_autonomy_tables.py --json
npx tsx scripts/mcp-bridge.ts autonomy_status
npx tsx scripts/mcp-bridge.ts soak_readiness
npx tsx scripts/mcp-bridge.ts operator_status
# tape authority still slim:
npx tsx scripts/mcp-bridge.ts ledger_sync_status
```

Expect `ok: true` and no `BRIDGE_FAILED`. autonomy/soak report
`databaseRouting: "slim+autonomy-stubs"`; operator reports
`databaseRouting: "workbench-local"`.
