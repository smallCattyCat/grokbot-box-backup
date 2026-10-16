# Grok Bot box — GitHub private backup plan

Inventoried: 2026-10-16 (America/Denver).  
Pattern: rain哥 / xiangxiang103 (private repo + fine-grained token + excludes + sync.sh).  
**This plan only. No push, no repo create, no secrets printed.**

## Raw disk (before exclusions)

| Path | Size | Notes |
|------|------|-------|
| `/workspace` | **2.5 GiB** | Main scratch; dominated by regenerable bulk |
| `/home/box` | **2.5 GiB** | Symlink `agent-data` → `sand-data`; browser + caches |
| `/home/box/agent-data` | ~109 MiB (`sand-data`) | Platform state; many secrets |

### Top folders (largest first)

**`/workspace`**
| Size | Path | Verdict |
|------|------|---------|
| 1.4G | `chatgpt-desktop/` | **EXCLUDE** — `.deb` installers + Codex config/cookie backup |
| 805M | `grok-course-service-v2/` | **PARTIAL** — keep source (~1.7M); drop `node_modules` (797M) + `.cmooc-service-data` |
| 85M | `cmooc/` | **PARTIAL** — keep source; drop `.git` (49M), `.env`, `payloads/*.env` |
| 67M | `cmooc-ledger-mirror/ledger-slim.db` | **OPTIONAL** — operational DB |
| 56M | `cmooc-src.tar` | **EXCLUDE** — redundant tarball of source |
| 28M | `cmooc-mcp/` | **PARTIAL** — keep source (~84K); drop `node_modules` (28M) |
| 4.5M | `grok-course-service-v1/` | **PARTIAL** — same as v2 |
| 2.0M | `grok-course-service-v1-src/` | **INCLUDE** |
| 784K | `pelican-bakeoff/` | **INCLUDE** — bakeoff scripts + results + shots |
| 292K | `uploads/` | **INCLUDE** (small screenshots / notes) |
| tiny | `pi-agent/`, `x-monitor/`, `shot.py` | **INCLUDE** (non-secret bits) |

**`/home/box`**
| Size | Path | Verdict |
|------|------|---------|
| 522M | `chrome-profile/` | **EXCLUDE** — browser login/cookies |
| 482M | `.codex/` | **EXCLUDE** — local DBs/sessions |
| 384M | `.local/` | **EXCLUDE** — tool installs |
| 314M | `.npm/` | **EXCLUDE** — cache |
| 109M | `sand-data/` (= agent-data) | **MOSTLY EXCLUDE** — see below |
| 82M | `.cache/` | **EXCLUDE** |
| 20M | `.cursor/` | **EXCLUDE** — platform; canvas SDK regenerable |
| 1.4M | `agent-data/managed-skills/` | **DO NOT rely on for restore** — Cursor-managed |
| 35M | `agent-data/agent-transcripts/` | **EXCLUDE** — private chat history |
| 4K | `agent-data/workflows/` | **EMPTY** — no user skills on disk |
| 16K | `reference/` | **INCLUDE** — `app-ui.md`, `debugging-the-box.md` |

---

## Recommended INCLUDE (Tier A — core)

Safe, useful, regenerable-deps stripped. **~17 MiB, ~1,080 files.**

- `/workspace/pelican-bakeoff/**` (scripts, SCORECARD, results, HTML, shots)
- `/workspace/cmooc/**` source tree **except** exclusions below (app, lib, scripts, docs, prisma, tests, configs, fixtures, `.env.example`, `.gitignore`, …)
- `/workspace/grok-course-service-v1/**` and `v2/**` source (app, lib, prisma, scripts, configs, deploy, resources, `.env.example`) — **no** `node_modules`, **no** `.cmooc-service-data`, **no** `.env.local.run`
- `/workspace/grok-course-service-v1-src/**`
- `/workspace/cmooc-mcp/**` source only (no `node_modules`)
- `/workspace/cmooc-ledger-mirror/export_slim.py` and `.use-mirror` (scripts only; not the DB)
- `/workspace/pi-agent/README.md` (and `env.sh` only if confirmed PATH-only — currently PATH; still prefer regenerating env locally)
- `/workspace/x-monitor/**`
- `/workspace/shot.py`
- `/workspace/uploads/**`
- `/home/box/reference/**`
- This plan file: `/workspace/grokbot-backup-plan.md`
- Later: `/workspace/RESTORE.md` (how to reinstall deps, redeem keys out-of-band)

### Optional add-ons (Tier A+)

| Add-on | Extra size | Files | When |
|--------|------------|-------|------|
| `cmooc/screenshots/` | ~+17 MiB | ~+124 | Want visual QA history |
| `cmooc/payloads/` **minus** `*.env` | ~+3.5 MiB | ~+777 | Want run history; may hold course IDs / operational JSON |
| `cmooc-ledger-mirror/ledger-slim.db` | ~+66 MiB | +1 | Need ledger offline; else rebuild from live |
| Agent `profile.json` + `memory/profile.md` only | ~negligible | ~6 | Personality notes; **not** full attachments/assets |

**Tier A + screenshots + payloads (no env):** ~**38 MiB / ~1,980 files**.  
**Tier B (above + ledger DB + profiles):** ~**104 MiB / ~1,990 files**.

---

## MUST EXCLUDE

### Secrets / credentials / auth state
- `/home/box/sand-data/host-secrets.json`, `box-secrets.json`, `teach-queue-key.json`
- `/home/box/sand-data/gateway.json` (contains token)
- `/home/box/sand-data/chrome-cookie-seed.json`
- `/home/box/.config/opencode/service.json` (contains password field)
- Any `.env`, `.env.local*`, `payloads/*.env` (e.g. under `cmooc/`)
- `/workspace/cmooc/.env`, `/workspace/grok-course-service-*/.env.local.run`
- Browser profiles & cookies: `/home/box/chrome-profile/`, `.config/google-chrome*`, `.config/Codex/**/Cookies*`, Trust Tokens
- `/workspace/chatgpt-desktop/backup-clear/` (Codex config/cache dump — cookies/login)

### Private / platform / regenerable bulk
- `**/node_modules/`, `**/.git/`, `**/.cache/`, `**/__pycache__/`, `**/.venv/`, `**/venv/`
- `**/.cmooc-service-data/`, `**/.localappdata/`
- `/workspace/cmooc-src.tar`
- `/workspace/chatgpt-desktop/**` (1.4G debs + backups)
- `/home/box/.npm/`, `/home/box/.local/`, `/home/box/.codex/`, `/home/box/.cache/`
- `/home/box/agent-data/agent-transcripts/` (chat history)
- `/home/box/agent-data/plugins/`, `search-index.db*`
- `/home/box/agent-data/managed-skills/` — **Cursor-managed**; reappear after login; backing them up does not restore “your” custom skills
- `/home/box/agent-data/workflows/` — currently **empty**; if user skills appear later, include *those files* only (still exclude secrets)
- `/home/box/.cursor/`, `/home/box/.agents/` (canvas SDK copies — platform)
- Full `/home/box/agent-data/agents/*/attachments|assets` (large, often PII/screenshots; optional later with review)
- Nested git objects under `cmooc/.git`

### Suggested `.gitignore` / rsync filter sketch

```
# deps & caches
node_modules/
.git/
.cache/
__pycache__/
.venv/
venv/
.npm/
.next/
dist/
build/
.cmooc-service-data/
.localappdata/

# secrets
.env
.env.*
!.env.example
**/*.env
**/host-secrets.json
**/box-secrets.json
**/teach-queue-key.json
**/chrome-cookie-seed.json
**/gateway.json
**/service.json
**/Cookies
**/Cookies-journal

# bulky / regenerable
chatgpt-desktop/
cmooc-src.tar
*.deb
ledger-slim.db

# private platform
agent-transcripts/
chrome-profile/
.codex/
managed-skills/
plugins/
search-index.db*
```

---

## Estimated size & file count AFTER exclusions

| Bundle | Approx size | Approx files |
|--------|-------------|--------------|
| **Tier A (recommended)** | **~17 MiB** | **~1,080** |
| Tier A + screenshots | ~34 MiB | ~1,210 |
| Tier A + payloads (no `*.env`) | ~21 MiB | ~1,860 |
| Tier A + shots + payloads | ~38 MiB | ~1,980 |
| Tier B + ledger DB | ~104 MiB | ~1,990 |
| Raw `/workspace` + `/home/box` | ~5 GiB | (not useful) |

Compression (gzip/zstd) may shrink Tier A further (~half for text-heavy trees).

---

## Critical restore gaps (read this)

1. **User skills / workflows:** `/home/box/agent-data/workflows/` is **empty**. Custom “skills” you create in product UI may live as **Cursor-managed** data, not reliably on this disk. `managed-skills/` is platform playbooks (shopping, slides, …) — **do not treat as your backup of custom skills**; they will re-download.
2. **API keys / OpenCode auth:** Must stay **out of git**. Restore = re-enter via secure form / env on the new box. Do **not** commit `service.json` or OPENCODE keys.
3. **Browser logins (MLH, Gmail in Chrome, etc.):** Not backed up (by design). Re-auth after restore.
4. **Grok Bot memory / chat:** Transcripts and most agent memory are platform-side or excluded. File backup ≠ conversation continuity.
5. **`node_modules`:** Reinstall with `npm ci` / `npm install` from lockfiles after clone.
6. **Bot persistent store** (`/cursor/stores/store-05b46e2a-…`, ~857K attachments): optional; mostly agent attachment blobs — low priority vs workspace source.
7. **MCP / connector auth** (Gmail, Vercel, X, …): account-linked in product; not in this filesystem backup.

---

## Proposed next steps (when user approves — not done yet)

1. User creates **empty private** GitHub repo.
2. User creates **fine-grained PAT**: Contents Read/Write, **single repo only**; pass via secure form (never paste in chat).
3. On box: init git in a staging dir OR sync selected paths with `rsync` + excludes → commit → push.
4. Add `sync.sh` + optional daily routine (cron-like) mirroring rain哥 pattern.
5. Write `RESTORE.md` (install Node, `npm i`, where to put keys, what cannot be restored).

## Risks

| Risk | Mitigation |
|------|------------|
| Accidental secret commit | Hard excludes; scan for `.env`/secret filenames before first push; never commit `service.json` / `*-secrets.json` |
| Token leaked in chat | Secure form only; rotate if exposed |
| Repo too large / slow | Stick to Tier A (~17 MiB); leave debs/ledger out |
| False sense of full restore | Document gaps: skills, keys, logins, chats |
| `payloads/` may contain operational IDs | Exclude `*.env`; review before including JSON history |
| Nested `cmooc/.git` | Exclude; backup working tree only |

---

## Summary for decision

- **Yes, backup is worthwhile** for: pelican bakeoff, cmooc/course-service source, small scripts, reference docs.
- **Default bundle: Tier A ≈ 17 MiB / ~1,080 files.**
- **Do not** mirror whole `/workspace` or `/home/box` — ~5 GiB of caches, cookies, and secrets.
- **Waiting on user:** private repo + scoped token via secure form before any push.
