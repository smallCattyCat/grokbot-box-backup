# Coding agents on Grok Bot box

## OpenCode CLI (preferred for OpenCode Go free models)
- Binary: `~/.opencode/bin/opencode` (v2.0.29)
- Auth: `OPENCODE_API_KEY` env (already set as box secret)
- Free Go models work through the OpenCode client (not through Pi/raw API)

Prep:
```bash
export PATH="$HOME/.opencode/bin:$PATH"
opencode auth list
opencode models | rg 'opencode-go/.*free'
```

Smoke (non-interactive via local serve HTTP API):
```bash
export OPENCODE_SERVER_PASSWORD=smoke
opencode serve --port 4096 --hostname 127.0.0.1 &
# set model: POST /api/session/:id/model {"model":{"id":"longcat-2.5-preview-free","providerID":"opencode-go"}}
# prompt:   POST /api/session/:id/prompt {"text":"..."}
```

Or TUI: `opencode` then pick `opencode-go/longcat-2.5-preview-free`.

Verified 2026-10-14: `opencode-go/longcat-2.5-preview-free` replied `PONG`.

## Pi Agent
- Binary: `pi` via Node 22 (fnm)
- Same `OPENCODE_API_KEY`, providers `opencode` / `opencode-go`
- Free models return FreeTierError outside OpenCode client; paid models need balance
