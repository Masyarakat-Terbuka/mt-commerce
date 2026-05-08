#!/usr/bin/env bash
# Nightly Postgres backup for mt-commerce.
#
# Runs pg_dump against the bundled `postgres` service via docker compose,
# writes a gzipped SQL dump to /var/backups/mt-commerce/, and prunes old
# snapshots: keep the last 7 daily + the last 4 weekly (Sunday) dumps.
#
# Intended to be invoked from cron on the host:
#   30 2 * * * cd /home/deploy/mt-commerce && ./scripts/backup-postgres.sh
#
# Reads .env.production for $POSTGRES_USER and $POSTGRES_DB. Assumes the
# script is invoked from the repo root (cron entry `cd`s there).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/mt-commerce}"

if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found at $REPO_ROOT" >&2
    exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${POSTGRES_USER:?POSTGRES_USER must be set in $ENV_FILE}"
: "${POSTGRES_DB:?POSTGRES_DB must be set in $ENV_FILE}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DATE_TAG="$(date -u +%Y-%m-%d)"
DAILY="$BACKUP_DIR/${POSTGRES_DB}-${DATE_TAG}.sql.gz"
LATEST="$BACKUP_DIR/${POSTGRES_DB}-latest.sql.gz"

echo "[$(date -u +%FT%TZ)] starting pg_dump → $DAILY"

# pg_dump --clean --if-exists makes the dump self-contained: restoring it
# into a fresh database produces an exact replica.
docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump --clean --if-exists --quote-all-identifiers \
    -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    | gzip -9 > "$DAILY.tmp"

mv "$DAILY.tmp" "$DAILY"
ln -sf "$(basename "$DAILY")" "$LATEST"

echo "[$(date -u +%FT%TZ)] wrote $(stat -c%s "$DAILY" 2>/dev/null || stat -f%z "$DAILY") bytes"

# ---- Retention --------------------------------------------------------------
# Keep:
#   - last 7 daily dumps
#   - last 4 weekly dumps (Sunday-tagged)
# Anything older than the cutoffs is removed.

# Daily: keep last 7. Sort by name (ISO date sorts chronologically), keep
# the 7 most recent, delete the rest. Skip files tagged as Sunday — those
# are also "weekly" candidates handled below.
find "$BACKUP_DIR" -maxdepth 1 -type f -name "${POSTGRES_DB}-*.sql.gz" \
    -mtime +7 -print0 | while IFS= read -r -d '' f; do
    fname="$(basename "$f")"
    # Pull YYYY-MM-DD out of the filename. macOS BSD date and GNU date diverge
    # here; we shell out to python only if available, otherwise rely on
    # GNU date (the host is Linux).
    date_part="$(echo "$fname" | sed -E "s/^${POSTGRES_DB}-([0-9-]{10}).*/\1/")"
    # Day-of-week 0=Sunday on GNU date.
    if dow=$(date -u -d "$date_part" +%w 2>/dev/null) && [ "$dow" = "0" ]; then
        # It's a Sunday — let weekly retention decide.
        continue
    fi
    echo "[$(date -u +%FT%TZ)] pruning daily $fname"
    rm -f "$f"
done

# Weekly: keep last 4 Sunday dumps (28 days), prune older.
find "$BACKUP_DIR" -maxdepth 1 -type f -name "${POSTGRES_DB}-*.sql.gz" \
    -mtime +28 -print0 | while IFS= read -r -d '' f; do
    fname="$(basename "$f")"
    date_part="$(echo "$fname" | sed -E "s/^${POSTGRES_DB}-([0-9-]{10}).*/\1/")"
    if dow=$(date -u -d "$date_part" +%w 2>/dev/null) && [ "$dow" = "0" ]; then
        echo "[$(date -u +%FT%TZ)] pruning weekly $fname"
        rm -f "$f"
    fi
done

echo "[$(date -u +%FT%TZ)] backup complete (timestamp $TIMESTAMP)"
