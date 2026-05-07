#!/usr/bin/env bash
#
# One-time bootstrap for the mt-commerce GitHub repository.
#
# What this does:
#   1. Syncs labels from .github/labels.yml (idempotent — safe to re-run)
#   2. Creates the v0.1, v0.2, v0.3 milestones
#
# Prerequisites:
#   - The GitHub repo masyarakat-terbuka/mt-commerce exists
#   - You are authenticated with the gh CLI:    gh auth login
#   - You have run `bun install` at the repo root (so bunx finds the package)
#
# Usage:
#   ./.github/bootstrap.sh
#
# This script does NOT push code, open issues, or change any non-labels/
# non-milestones state on the repo. Re-running is safe.

set -euo pipefail

REPO="masyarakat-terbuka/mt-commerce"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Syncing labels from .github/labels.yml"
bunx github-label-sync \
  --access-token "$(gh auth token)" \
  --labels "$ROOT/.github/labels.yml" \
  "$REPO"

echo
echo "==> Creating milestones (idempotent — existing ones are skipped)"

create_milestone() {
  local title="$1"
  local description="$2"

  if gh api "repos/$REPO/milestones" --jq '.[].title' | grep -Fxq "$title"; then
    echo "    - $title (exists, skipped)"
  else
    gh api "repos/$REPO/milestones" \
      -f title="$title" \
      -f description="$description" \
      -f state=open \
      >/dev/null
    echo "    - $title (created)"
  fi
}

create_milestone "v0.1 Foundation" \
  "First release. A small business can run a real store: catalog, cart, checkout, one payment provider, manual shipping, basic admin."

create_milestone "v0.2 Extensibility" \
  "Plugin SDK, theme system, additional payment and courier integrations, import/export tools, CLI."

create_milestone "v0.3 Operations" \
  "Marketplace synchronization, promotion engine, customer segmentation, basic analytics."

echo
echo "Done. Next steps:"
echo "  - Create a Project board in the GitHub UI and link it to this repo"
echo "  - Open the first batch of issues (use the v0.1 checklist as the source)"
echo "  - Label 20–30 small issues with 'good first issue' for first contributors"
