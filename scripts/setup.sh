#!/usr/bin/env bash
# First-time local setup for mt-commerce.
#
# Idempotent: safe to re-run. Existing .env files are kept; Docker volumes
# are kept. Use `scripts/reset.sh` if you need a clean slate.
#
# What it does:
#   1. Checks Bun and Docker are available.
#   2. Copies .env files into each workspace where missing.
#   3. bun install (workspace-aware).
#   4. docker compose up -d --wait (Postgres + Redis, waits for healthchecks).
#   5. Applies database migrations.
#   6. Seeds Indonesian regions + demo catalog.

set -euo pipefail

# Colors (only when stdout is a terminal).
if [ -t 1 ]; then
  NC='\033[0m'; BOLD='\033[1m'; G='\033[32m'; Y='\033[33m'; R='\033[31m'
else
  NC=''; BOLD=''; G=''; Y=''; R=''
fi

# Move to repo root regardless of where this script is invoked from.
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

step() { printf "${BOLD}==> %s${NC}\n" "$1"; }
ok()   { printf "${G}✓${NC} %s\n" "$1"; }
warn() { printf "${Y}⚠${NC} %s\n" "$1"; }
err()  { printf "${R}✗${NC} %s\n" "$1" >&2; }

# 1. Prerequisites.
step "Checking prerequisites"

if ! command -v bun >/dev/null 2>&1; then
  err "Bun not found on PATH. Install from https://bun.sh, then re-run."
  exit 1
fi
ok "bun $(bun --version)"

if ! command -v docker >/dev/null 2>&1; then
  err "docker CLI not found on PATH. Install OrbStack or Docker Desktop."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  err "Docker daemon is not running. Start OrbStack or Docker Desktop, then re-run."
  exit 1
fi
ok "docker daemon reachable"

# 2. Copy .env files where missing.
step "Copying .env files where missing"

copy_env() {
  local example="$1"
  local target="$2"
  if [ ! -f "$example" ]; then
    return 0
  fi
  if [ -f "$target" ]; then
    warn "skip: $target exists"
  else
    cp "$example" "$target"
    ok "wrote $target"
  fi
}

copy_env "$ROOT/.env.example"                    "$ROOT/.env"
copy_env "$ROOT/apps/api/.env.example"           "$ROOT/apps/api/.env"
copy_env "$ROOT/apps/storefront/.env.example"    "$ROOT/apps/storefront/.env"

# 3. Install workspace dependencies.
step "Installing workspace dependencies"
bun install
ok "dependencies installed"

# 4. Start Postgres + Redis. --wait blocks until healthchecks pass.
step "Starting Postgres + Redis"
docker compose up -d --wait
ok "postgres + redis up and healthy"

# 5. Migrations.
step "Applying database migrations"
bun --filter '@mt-commerce/api' db:migrate
ok "migrations applied"

# 6. Seed.
step "Seeding regions and demo catalog"
bun --filter '@mt-commerce/api' db:seed
ok "seed loaded"

# 7. Seed a demo staff owner so the admin is sign-in-able out of the box.
#    Defaults are overridable via env vars; the script signs the user up
#    via Better Auth and promotes them to owner in one shot. Both steps
#    are idempotent — re-running is a no-op for an existing demo owner.
DEMO_EMAIL="${MT_COMMERCE_DEMO_EMAIL:-demo@mt-commerce.local}"
DEMO_PASSWORD="${MT_COMMERCE_DEMO_PASSWORD:-DemoOwner1!}"
step "Seeding demo staff owner"
if bun --filter '@mt-commerce/api' seed:demo-owner \
     "$DEMO_EMAIL" "$DEMO_PASSWORD"; then
  ok "demo owner ready: $DEMO_EMAIL"
else
  err "seed:demo-owner failed; see output above."
  exit 1
fi

printf "\n${G}${BOLD}Setup complete.${NC}\n\n"
cat <<NEXT
Sign in to the admin with:
    email:    $DEMO_EMAIL
    password: $DEMO_PASSWORD

Run all three apps in parallel:
    bun dev

Or pick one:
    bun --filter '@mt-commerce/api' dev          # :8000
    bun --filter '@mt-commerce/storefront' dev   # :4321
    bun --filter '@mt-commerce/admin' dev        # :5173

Open in a browser:
    http://localhost:4321         Storefront
    http://localhost:5173/login   Admin
    http://localhost:4322         Docs
    http://localhost:8000/health  API health
    http://localhost:8000/docs    API Swagger UI (dev only)

Stop infrastructure:
    docker compose down           # keep volumes (data preserved)
    bun run reset                 # destructive: wipe volumes + re-setup

NEXT
