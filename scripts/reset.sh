#!/usr/bin/env bash
# DESTRUCTIVE: wipes Postgres + Redis volumes, then re-runs setup.
# Use when the local DB is in a weird state and you want a clean slate.
# Does NOT touch .env files (your secrets stay) or node_modules.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -t 0 ]; then
  printf "This will WIPE the Postgres + Redis data volumes. Continue? [y/N] "
  read -r REPLY
  case "$REPLY" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

docker compose down -v
exec ./scripts/setup.sh
