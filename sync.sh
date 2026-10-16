#!/usr/bin/env bash
# Re-sync Tier A + screenshots from the live box into this repo and push.
# Requires: GITHUB_BACKUP_TOKEN in env (fine-grained PAT, Contents R/W).
# NEVER echo the token. Run from repo root after first clone, or set BOX_ROOT.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
BOX_WORKSPACE="${BOX_WORKSPACE:-/workspace}"
BOX_REF="${BOX_REF:-/home/box/reference}"

if [[ -z "${GITHUB_BACKUP_TOKEN:-}" ]]; then
  echo "GITHUB_BACKUP_TOKEN not set" >&2
  exit 1
fi

test -n "$GITHUB_BACKUP_TOKEN" && echo "TOKEN_SET=yes"

RSYNC=(rsync -a --delete
  --exclude='node_modules' --exclude='.git' --exclude='.cache'
  --exclude='__pycache__' --exclude='.venv'
  --exclude='.env' --exclude='.env.local' --exclude='.env.local.run'
  --exclude='.env.production' --exclude='.env.development'
  --exclude='.localappdata' --exclude='payloads'
  --exclude='host-secrets' --exclude='box-secrets'
  --exclude='teach-queue-key' --exclude='chrome-cookie-seed'
  --exclude='gateway.json' --exclude='service.json'
  --exclude='.cmooc-service-data' --exclude='ledger-slim.db'
)

mkdir -p "$REPO_ROOT/workspace" "$REPO_ROOT/home-box/reference"

"${RSYNC[@]}" "$BOX_WORKSPACE/pelican-bakeoff/" "$REPO_ROOT/workspace/pelican-bakeoff/"
"${RSYNC[@]}" "$BOX_WORKSPACE/cmooc/" "$REPO_ROOT/workspace/cmooc/"
# ensure examples kept; strip non-example env if any
find "$REPO_ROOT/workspace/cmooc" -maxdepth 1 -name '.env.*' ! -name '*.example' -delete 2>/dev/null || true

"${RSYNC[@]}" "$BOX_WORKSPACE/grok-course-service-v1/" "$REPO_ROOT/workspace/grok-course-service-v1/"
"${RSYNC[@]}" "$BOX_WORKSPACE/grok-course-service-v2/" "$REPO_ROOT/workspace/grok-course-service-v2/"
"${RSYNC[@]}" "$BOX_WORKSPACE/grok-course-service-v1-src/" "$REPO_ROOT/workspace/grok-course-service-v1-src/"
"${RSYNC[@]}" "$BOX_WORKSPACE/cmooc-mcp/" "$REPO_ROOT/workspace/cmooc-mcp/"

mkdir -p "$REPO_ROOT/workspace/cmooc-ledger-mirror"
cp -a "$BOX_WORKSPACE/cmooc-ledger-mirror/export_slim.py" "$REPO_ROOT/workspace/cmooc-ledger-mirror/"
cp -a "$BOX_WORKSPACE/cmooc-ledger-mirror/.use-mirror" "$REPO_ROOT/workspace/cmooc-ledger-mirror/" 2>/dev/null || true

mkdir -p "$REPO_ROOT/workspace/pi-agent"
cp -a "$BOX_WORKSPACE/pi-agent/README.md" "$REPO_ROOT/workspace/pi-agent/"
[[ -f "$BOX_WORKSPACE/pi-agent/env.sh" ]] && cp -a "$BOX_WORKSPACE/pi-agent/env.sh" "$REPO_ROOT/workspace/pi-agent/"

"${RSYNC[@]}" "$BOX_WORKSPACE/x-monitor/" "$REPO_ROOT/workspace/x-monitor/"
cp -a "$BOX_WORKSPACE/shot.py" "$REPO_ROOT/workspace/"
"${RSYNC[@]}" "$BOX_WORKSPACE/uploads/" "$REPO_ROOT/workspace/uploads/"
[[ -f "$BOX_WORKSPACE/grokbot-backup-plan.md" ]] && cp -a "$BOX_WORKSPACE/grokbot-backup-plan.md" "$REPO_ROOT/workspace/"
"${RSYNC[@]}" "$BOX_REF/" "$REPO_ROOT/home-box/reference/"

# Abort if secrets slipped in
HITS=$(find "$REPO_ROOT" -path '*/.git' -prune -o \( \
  -name '.env' -o -name '.env.local.run' -o -name '*secrets*' \
  -o -name 'Cookies' -o -name 'service.json' -o -name 'gateway.json' \
  -o -name 'ledger-slim.db' \) -print 2>/dev/null | grep -v '^$' || true)
# Allow only .env.example paths from the name filter noise — re-check strictly:
BAD=$(find "$REPO_ROOT" -path '*/.git' -prune -o \( \
  -name '.env' -o -name '.env.local' -o -name '.env.local.run' \
  -o -name 'service.json' -o -name 'gateway.json' -o -name 'ledger-slim.db' \
  -o -name 'Cookies' \) -print 2>/dev/null || true)
if [[ -n "${BAD}" ]]; then
  echo "ABORT: secret-like files in tree:" >&2
  echo "$BAD" >&2
  exit 1
fi

cd "$REPO_ROOT"
# screenshots/*.png is ignored by workspace/cmooc/.gitignore; force-include for this backup
git add -A
git add -f workspace/cmooc/screenshots/ 2>/dev/null || true
if git diff --cached --quiet; then
  echo "Nothing to commit"
  exit 0
fi
git commit -m "Sync Tier A + screenshots ($(date +%Y-%m-%d))"

REMOTE_URL="https://x-access-token:${GITHUB_BACKUP_TOKEN}@github.com/smallCattyCat/grokbot-box-backup.git"
git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE_URL"
# Scrub remote URL from config display — use push URL without storing forever if preferred
git push -u origin HEAD:main
git remote set-url origin https://github.com/smallCattyCat/grokbot-box-backup.git
echo "Pushed. Scrubbed remote URL back to public HTTPS."
