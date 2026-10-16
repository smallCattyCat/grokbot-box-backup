# cmooc-mcp

stdio MCP wrapper for the cMOOC workbench — control plane + autonomy/operator/workbench ledger helpers for Grok Bot.

**Never** exposes forum publish, authorize-publish, `realPublishEnabled` flips, cookie/satoken export, or unconstrained forum posts.

## Architecture

1. **Control plane** tools spawn `npx tsx scripts/cmoocctl.ts` in `CMOOC_ROOT`.
2. **Everything else** spawns `npx tsx scripts/mcp-bridge.ts <op> [--flags]` — a JSON CLI that prefers direct lib/prisma (works without Next), with HTTP fallback via `CMOOC_APP_ORIGIN` (default `http://127.0.0.1:3000`) for awkward/cross-process cases (e.g. active workbench stop).
3. **Slim ledger** ops (`ledger_sync_status` / `tape_*`) use `CMOOC_LEDGER_DB` + python3 sqlite3 (`scripts/ledger_slim_ops.py`) — see [SYNC.md](./SYNC.md).
4. All tool outputs scrub secret-shaped keys (`password` / `token` / `cookie` / `satoken` / `apiKey` / `authorization` / `credential`).

## Env

| Var | Default |
|-----|---------|
| `CMOOC_ROOT` | `/workspace/cmooc` |
| `LLM_MODE` | `mock` |
| `CMOOC_APP_ORIGIN` | `http://127.0.0.1:3000` |
| `CMOOC_LEDGER_DIR` | `/home/box/agent-data/agents/596f4a8c-5093-4949-b843-6443e71c9dff/memory/cmooc-ledger` |
| `CMOOC_LEDGER_DB` | `/workspace/cmooc-ledger-mirror/ledger-slim.db` |

## Tools (32)

### Control plane (cmoocctl, offline)
- `cmooc_manifest`
- `cmooc_status`
- `cmooc_adapter_doctor`

### Autonomy / health (READ, offline via prisma)
- `cmooc_autonomy_status`
- `cmooc_soak_readiness`
- `cmooc_governance_get` — optional `courseAlias`; omit for list view
- `cmooc_course_graph_status` — requires `courseAlias`
- `cmooc_execution_agents_status`

### Operator / platform (READ)
- `cmooc_operator_manifest`
- `cmooc_operator_status` — optional `detail`, `fresh`
- `cmooc_operator_auth_status`
- `cmooc_platform_readiness` — optional `target` (playwright inspect); meta without target
- `cmooc_platform_live_opportunities` — list/summarize; no forum body spam
- `cmooc_settings_get`

### Workbench (READ + local stop)
- `cmooc_workbench_runtime_get`
- `cmooc_workbench_runs_list`
- `cmooc_workbench_run_get`
- `cmooc_workbench_brief` — `courseAlias` + `invocationId` + `snapshotId`
- `cmooc_workbench_evidence` — same anchors
- `cmooc_workbench_run_stop` — **needs Next** for active in-process runs (HTTP)

### Local maintenance (OK — no forum write)
- `cmooc_maintenance_recover`
- `cmooc_outcomes_reconcile`
- `cmooc_incident_ack` — `id` + `expectedEvidenceHash`
- `cmooc_incident_resolve` — `id` + `expectedEvidenceHash`

### Auth / shadow ledger / meta
- `cmooc_auth_check` — scrubbed; never dumps cookies
- `cmooc_shadow_budget_read` — optional `dir`
- `cmooc_list_capabilities` — which tools need Next vs offline

### Slim Nutstore ledger (python3 sqlite3 via `CMOOC_LEDGER_DB`) — DecisionTape cutover
- `cmooc_ledger_sync_status` — mirror path / size / mtime / tableCounts
- `cmooc_tape_get_by_post` — **primary** `DecisionTapeEntry` (+ `AutonomyDecision` when linkable); exposes R7 `decision` in `{DRAFT,WAIT,YIELD,ABSTAIN}`, `kind`, hashes, `createdAt`. `AgentPatrolLedger` only under `deprecatedPatrolRows`
- `cmooc_tape_append` — write **DecisionTapeEntry only** when real `invocationId` exists (hash-chain rules from `lib/autonomy/decision-tape.ts`). Fields: `invocationId` (required), `forumPostId`, `decision` (四态), `kind`, `reasonCode`, `status`, redacted `payloadJson`. Fail closed — no invented `ScheduledInvocation`, no AgentPatrolLedger writes
- `cmooc_patrol_begin` — claim a real `ScheduledInvocation` lease (SHADOW) on slim DB for browser patrol; args `courseAlias` (required), `leaseSeconds` (default 900). Fail closed: unknown alias / no schedule / lease_busy / governance emergencyHalt. Returns `{ ok, invocationId, courseAlias, mode, leaseOwner, leaseExpiresAt, status }`
- `cmooc_patrol_end` — mark that invocation `completed` (clears lease) when still running; optional `leaseOwner` match
- `cmooc_list_capabilities` — includes cutover note (MCP + cmooc助手 share DecisionTape)

See [SYNC.md](./SYNC.md) for TYL `export_slim.py` → CopyToBox → MCP → optional CopyFromBox.

### Explicitly excluded
- interventions authorize-publish / publish
- save-auth / cookie export
- any tool that sets `realPublishEnabled` true
- unconstrained forum post
- workbench launch / messages / decision (complex brain wiring)

## Bridge CLI

```bash
cd /workspace/cmooc
npx tsx scripts/mcp-bridge.ts list
npx tsx scripts/mcp-bridge.ts list_capabilities
npx tsx scripts/mcp-bridge.ts ledger_sync_status
npx tsx scripts/mcp-bridge.ts tape_get_by_post --forumPostId 1945095216292753408
npx tsx scripts/mcp-bridge.ts patrol_begin --courseAlias bnu-test --leaseSeconds 900
npx tsx scripts/mcp-bridge.ts tape_append --invocationId <realScheduledInvocationId> --forumPostId 1945095216292753408 --kind patrol_judgment --decision WAIT --reasonCode verify --status recorded --payload '{"slot":"verify"}'
npx tsx scripts/mcp-bridge.ts patrol_end --invocationId <realScheduledInvocationId>
```

## Register / AddMcpServer exact fields

```
name: cmooc
command: node
args: ["/workspace/cmooc-mcp/server.mjs"]
env: {"CMOOC_ROOT":"/workspace/cmooc","LLM_MODE":"mock","CMOOC_LEDGER_DB":"/workspace/cmooc-ledger-mirror/ledger-slim.db"}
```

Call AddMcpServer with those fields after user confirms. Do not invent API keys.
Do not call AddMcpServer or RestartMcpServers from automated expand tasks unless asked.
