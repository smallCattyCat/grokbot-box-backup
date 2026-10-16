# Slim ledger sync (Nutstore ↔ box MCP)

Authority for the workbench ledger remains the Nutstore SQLite on TYL
(`…/prisma/dev.db`, ~335MB). Full DB exceeds CopyToBox’s 100MB limit, so the
working mirror is a **slim** export.

## Flow

```
TYL Nutstore authority (dev.db)
        │  python export_slim.py
        ▼
TYL AppData Local cmooc-ledger-slim/ledger-slim.db  (~67MB)
        │  Grok Bot CopyToBox
        ▼
Box /workspace/cmooc-ledger-mirror/ledger-slim.db
        │  MCP / mcp-bridge (CMOOC_LEDGER_DB)
        ▼
  READ:  ledger_sync_status, tape_get_by_post
         → primary DecisionTapeEntry (+ AutonomyDecision when linkable)
         → AgentPatrolLedger only as deprecatedPatrolRows
  WRITE: patrol_begin → ScheduledInvocation lease claim (SHADOW)
         tape_append → DecisionTapeEntry only
         (requires real ScheduledInvocation invocationId;
          same hash-chain rules as lib/autonomy/decision-tape.ts)
         patrol_end → complete/clear patrol lease
        │  optional CopyFromBox when writes must return
        ▼
TYL (merge / replace with Nutstore lock caution)
```

## Cutover (MCP + cmooc助手)

MCP and cmooc助手 read/write the **same DecisionTape chain**. R7 four-state
intents: `DRAFT` / `WAIT` / `YIELD` / `ABSTAIN`.

| Path | Table | Notes |
|------|-------|-------|
| Primary read/write | `DecisionTapeEntry` | Hash-chained on `(invocationId, sequence)` |
| Linked read | `AutonomyDecision` | When invocation/post linkable; `decision` normalized to R7 |
| Deprecated read-compat | `AgentPatrolLedger` | Exposed only as `deprecatedPatrolRows`; **not** a write path |

## Env

| Var | Default |
|-----|---------|
| `CMOOC_LEDGER_DB` | `/workspace/cmooc-ledger-mirror/ledger-slim.db` |
| `CMOOC_DATABASE_URL` | `file:` + same path (for prisma ops that still use it) |

Bridge ledger ops use **python3 + sqlite3** (`scripts/ledger_slim_ops.py`) —
no better-sqlite3 / native deps. Hashing matches
`lib/facilitation-protocol/canonical-hash.ts` + `lib/autonomy/decision-tape.ts`.

## Export (TYL)

Script: `/workspace/cmooc-ledger-mirror/export_slim.py` (also keep a copy next
to the authority DB). Copies DecisionTapeEntry, AutonomyDecision, ForumPost,
ReviewEvent, ScheduledInvocation, and related tables into a fresh slim DB.

```powershell
# on TYL machine Shell
python C:\path\to\export_slim.py
# → %LOCALAPPDATA%\cmooc-ledger-slim\ledger-slim.db
```

Then Bot: `CopyToBox` that file → `/workspace/cmooc-ledger-mirror/ledger-slim.db`.

## Writes / hash-chain rule

`DecisionTapeEntry` is hash-chained on `(invocationId, sequence)`. MCP
**must not** invent orphan `ScheduledInvocation` rows inside `tape_append`.
Browser patrol obtains a real id via `cmooc_patrol_begin` (slim lease claim
mirroring `lib/autonomy/invocation-store.ts` against existing manifest +
schedule), then `tape_append`, then preferably `cmooc_patrol_end`.

`cmooc_patrol_begin` / `patrol_begin`:

- **Requires** `courseAlias` present in `AutonomyCourseManifest` (+ enabled
  `OperationSchedule`)
- Creates `ScheduledInvocation` with `mode=SHADOW`, `status=running`,
  `leaseOwner=grok-patrol:<uuid>`, unique `invocationKey`
- **Fail closed**: unknown alias, missing schedule, `lease_busy` (unexpired
  running lease), detectable `emergencyHalt` on
  `CourseOperationGovernancePolicy`
- Optional `leaseSeconds` (default 900)

`cmooc_patrol_end` / `patrol_end`:

- Marks invocation `completed` + clears lease when still `running`
- Optional `leaseOwner` match; without it only `grok-patrol:*` leases

`cmooc_tape_append` / `tape_append`:

- **Requires** a real `invocationId` present in `ScheduledInvocation`
- Writes **only** `DecisionTapeEntry` with redacted payload (no url/content/cookie/token;
  forbidden forum/raw keys rejected — same as `decision-tape.ts`)
- Accepts: `forumPostId`, `decision` (四态), `kind`
  (`patrol_judgment` \| `publish_receipt` \| `decision_committed`), `reasonCode`,
  `status`, optional extra redacted JSON
- **Fail closed** if invocation missing/unknown — no AgentPatrolLedger fallback

`AgentPatrolLedger` may still exist for older rows; get returns them under
`deprecatedPatrolRows` only.

## MCP tools

- `cmooc_ledger_sync_status` — path / size / mtime / tableCounts (+ cutover note)
- `cmooc_tape_get_by_post` — ForumPost summary + DecisionTapeEntry primary + deprecated patrol
- `cmooc_tape_append` — DecisionTapeEntry append (requires `invocationId`)
- `cmooc_patrol_begin` — claim ScheduledInvocation lease for patrol
- `cmooc_patrol_end` — complete patrol invocation / clear lease
- `cmooc_list_capabilities` — includes cutover summary

Bridge-only helper (not an MCP tool): `ledger_use_mirror`.

## Verify

```bash
cd /workspace/cmooc
npx tsx scripts/mcp-bridge.ts ledger_sync_status
npx tsx scripts/mcp-bridge.ts tape_get_by_post --forumPostId 1945095216292753408
# missing invocation → fail closed
npx tsx scripts/mcp-bridge.ts tape_append --forumPostId 1945095216292753408 --kind patrol_judgment --decision YIELD
# patrol lease → real invocationId → DecisionTapeEntry
npx tsx scripts/mcp-bridge.ts patrol_begin --courseAlias bnu-test
# second begin while lease valid → LEASE_BUSY
npx tsx scripts/mcp-bridge.ts tape_append --invocationId <realScheduledInvocationId> --kind patrol_judgment --decision WAIT --reasonCode mcp_patrol_verify --status recorded --payload '{"slot":"verify"}'
npx tsx scripts/mcp-bridge.ts patrol_end --invocationId <realScheduledInvocationId>
npx tsx scripts/mcp-bridge.ts tape_get_by_post --forumPostId 1945095216292753408
```

## Official course-companion cutover
See [SYNC_CUTOVER.md](./SYNC_CUTOVER.md) for box workbench :3017 + AddMcpServer fields + slim keep notes.
