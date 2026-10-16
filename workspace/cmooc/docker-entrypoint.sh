#!/usr/bin/env sh
set -eu

data_dir="${CMOOC_DATA_DIR:-/data}"
mkdir -p "$data_dir/screenshots" "$data_dir/playwright" playwright

export DATABASE_URL="${DATABASE_URL:-file:$data_dir/dev.db}"
export SCREENSHOT_DIR="${SCREENSHOT_DIR:-$data_dir/screenshots}"

# Keep the existing app path while persisting the Playwright storage state on
# the mounted volume, so a redeploy does not discard the authorized session.
rm -f playwright/auth-state.json
ln -s "$data_dir/playwright/auth-state.json" playwright/auth-state.json

npm run prisma:migrate

# The container listens internally; docker-compose exposes it on host loopback
# only. A non-local deployment must put an authenticated reverse proxy in front.
exec ./node_modules/.bin/next start -H 0.0.0.0 -p "${PORT:-3000}"
