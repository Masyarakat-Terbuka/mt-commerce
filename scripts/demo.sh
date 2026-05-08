#!/usr/bin/env bash
# One-shot local demo bring-up.
#
# Wraps `scripts/setup.sh` (deps + Postgres + Redis + migrations + seeds)
# and provisions a default staff owner so you can sign in to the admin
# immediately. Idempotent: safe to re-run; existing owner is left alone.
#
# Defaults the demo owner to demo@mt-commerce.local / DemoOwner1!.
# Override either via MT_COMMERCE_DEMO_EMAIL / MT_COMMERCE_DEMO_PASSWORD.
#
# After this runs, `bun run dev` brings the three apps up against a
# populated database.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -t 1 ]; then
  NC='\033[0m'; BOLD='\033[1m'; G='\033[32m'; Y='\033[33m'
else
  NC=''; BOLD=''; G=''; Y=''
fi

step() { printf "${BOLD}==> %s${NC}\n" "$1"; }
ok()   { printf "${G}✓${NC} %s\n" "$1"; }
note() { printf "${Y}•${NC} %s\n" "$1"; }

DEMO_EMAIL="${MT_COMMERCE_DEMO_EMAIL:-demo@mt-commerce.local}"
DEMO_PASSWORD="${MT_COMMERCE_DEMO_PASSWORD:-DemoOwner1!}"

# 1. Run the standard setup (prereqs, .env, deps, docker, migrations, seeds).
./scripts/setup.sh

# 2. Provision the demo staff owner. provision-owner is idempotent in
#    the "happy path" — running it twice with the same email currently
#    errors with "user already exists", so we tolerate that exit code.
step "Provisioning demo owner"
if bun --filter '@mt-commerce/api' provision-owner \
     "$DEMO_EMAIL" "$DEMO_PASSWORD" 2>&1 | tee /tmp/mt-provision.log; then
  ok "owner created: $DEMO_EMAIL"
else
  if grep -q -i "already exists\|duplicate" /tmp/mt-provision.log; then
    note "owner already exists (re-run is a no-op): $DEMO_EMAIL"
  else
    printf "\n\033[31m✗\033[0m provision-owner failed; see output above.\n" >&2
    rm -f /tmp/mt-provision.log
    exit 1
  fi
fi
rm -f /tmp/mt-provision.log

printf "\n${G}${BOLD}Demo bring-up complete.${NC}\n\n"
cat <<NEXT
Sign in to the admin with:

  email:    $DEMO_EMAIL
  password: $DEMO_PASSWORD

Bring up the three apps:

  bun run dev

Open in a browser:

  Storefront: http://localhost:4321
  Admin:      http://localhost:5173/login
  Docs:       http://localhost:4322
  API health: http://localhost:8000/health
  API docs:   http://localhost:8000/docs    (Swagger UI, dev only)

To start over with a clean database (destructive — wipes Postgres volume):

  bun run reset && ./scripts/demo.sh

NEXT
