# Restore guide — Grok Bot box backup

Snapshot: **Tier A + screenshots** (2026-10-16).  
Repo layout mirrors the box: `workspace/` ↔ `/workspace`, `home-box/reference/` ↔ `/home/box/reference`.

## What this backup contains

- `workspace/pelican-bakeoff/` — bakeoff scripts, results, shots
- `workspace/cmooc/` — Next.js app source + `screenshots/` (no `payloads/`, no `.env`, no nested `.git`)
- `workspace/grok-course-service-v1/`, `v2/`, `v1-src/` — service source (no `node_modules`, no `.cmooc-service-data`)
- `workspace/cmooc-mcp/` — MCP wrappers/source (no `node_modules`)
- `workspace/cmooc-ledger-mirror/` — `export_slim.py` + `.use-mirror` only (not the DB)
- `workspace/pi-agent/` — README + PATH-only `env.sh`
- `workspace/x-monitor/`, `shot.py`, `uploads/`, `grokbot-backup-plan.md`
- `home-box/reference/` — `app-ui.md`, `debugging-the-box.md`
- `sync.sh` — optional re-sync helper for future pushes

## What cannot be restored from this repo

Do **not** expect these to appear here (by design):

| Missing | Why |
|---------|-----|
| API keys / tokens / passwords | Re-enter out-of-band (Grok Bot secrets, Vercel, OpenCode, GitHub PAT, …) |
| Browser cookies / Chrome profile | Re-login in the box browser |
| Chat / agent transcripts | Private history; not backed up |
| `managed-skills` / Cursor platform state | Managed by the product; not portable |
| `cmooc/payloads/` | Skipped in this Tier A+screenshots snapshot |
| `ledger-slim.db` | Rebuild via `export_slim.py` against live ledger, or restore from a later Tier B backup |
| `node_modules` | Reinstall with npm (below) |
| `.cmooc-service-data` | Runtime data; recreate on first run |

## Quick restore on a fresh box

```bash
# 1. Clone
git clone https://github.com/smallCattyCat/grokbot-box-backup.git
cd grokbot-box-backup

# 2. Copy into place (adjust destinations if your layout differs)
cp -a workspace/. /workspace/
mkdir -p /home/box/reference
cp -a home-box/reference/. /home/box/reference/

# 3. Re-enter secrets out-of-band (never commit them)
#    - Copy .env.example → .env in each app and fill values
#    - Set Grok Bot / host secrets for OPENCODE_API_KEY, DB URLs, etc.

cp workspace/cmooc/.env.example /workspace/cmooc/.env
# edit /workspace/cmooc/.env

cp workspace/grok-course-service-v2/.env.example /workspace/grok-course-service-v2/.env.local.run
# edit keys

# 4. Install deps
cd /workspace/cmooc && npm ci
cd /workspace/grok-course-service-v2 && npm ci
cd /workspace/cmooc-mcp && npm ci
# v1 similarly if needed

# 5. Optional: rebuild ledger slim DB
# cd /workspace/cmooc-ledger-mirror && python3 export_slim.py   # needs live access

# 6. Source PATH helper for pi / fnm if present
# source /workspace/pi-agent/env.sh
```

## Daily sync (optional)

After the first push, from a staging checkout or by running `sync.sh` on the box (see script comments). Parent agent may offer a routine; this repo does not schedule one by itself.

## Note on screenshots

`workspace/cmooc/.gitignore` ignores `screenshots/*.png` (upstream project rule). This backup **force-tracks** those PNGs so Tier A + screenshots is complete. After restore, `git status` inside a nested clone of cmooc alone may still ignore new PNGs; the files on disk are present.
