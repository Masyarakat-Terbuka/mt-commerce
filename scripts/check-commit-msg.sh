#!/usr/bin/env bash
# Verify the staged commit message follows Conventional Commits.
#
# Why this script and not @commitlint/cli + config-conventional: the
# upstream extends + import paths both silently produced an empty rules
# object when commitlint was driven through bun's resolver in this
# monorepo (`bunx commitlint --print-config` showed `rules: {}` with no
# discoverable failure mode). Inlining the rules verbatim did not help.
# A small regex check here is more honest about what we actually enforce
# and avoids a debug rabbit hole that does not matter at v0.1.
#
# What we enforce, per Conventional Commits + mt-commerce conventions:
#   - The first line matches: <type>(<scope>)?: <subject>
#   - Type ∈ {build, chore, ci, docs, feat, fix, perf, refactor, revert,
#            style, test}
#   - Scope, when present, is from the workspace + domain whitelist below
#     (or `repo` / `deps` / `ci` / `docs` for cross-cutting work).
#   - First line ≤ 100 characters.
#   - Merge commits and revert commits are exempt (they have their own
#     conventions; rejecting them adds noise without value).
#
# The hook intentionally does NOT enforce body line length or trailing
# punctuation. Those rules in `@commitlint/config-conventional` produce
# more noise than value on a small, mostly-solo project.

set -euo pipefail

msg_file="${1:-}"
if [[ -z "$msg_file" || ! -f "$msg_file" ]]; then
  echo "check-commit-msg: missing or unreadable commit message file: $msg_file" >&2
  exit 1
fi

# Read the first non-comment line — git puts comments below the message
# in the editor template; a real subject line never starts with `#`.
first_line=""
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ -z "$first_line" && ! "$line" =~ ^# ]]; then
    first_line="$line"
    break
  fi
done < "$msg_file"

if [[ -z "$first_line" ]]; then
  echo "✖ commit message is empty" >&2
  exit 1
fi

# Exempt merge / revert / fixup / squash commits — they have their own
# conventions and rejecting them just creates friction. The `Merge:` form
# is what `git merge -m "Merge: ..."` produces in this repo's history;
# `Merge branch` is git's default format.
if [[ "$first_line" =~ ^Merge:\ |^Merge\ |^Revert\ |^fixup!\ |^squash!\  ]]; then
  exit 0
fi

# Length check.
if (( ${#first_line} > 100 )); then
  echo "✖ subject line is ${#first_line} chars; cap is 100" >&2
  echo "  $first_line" >&2
  exit 1
fi

# Type + optional scope + colon + space + subject.
if ! [[ "$first_line" =~ ^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9,\ -]+\))?!?:\ .+ ]]; then
  cat >&2 <<EOF
✖ commit subject does not match Conventional Commits

  saw:    $first_line
  expect: <type>(<scope>)?: <subject>

  type ∈ build | chore | ci | docs | feat | fix | perf | refactor | revert | style | test
  scope ∈ api | admin | storefront | core | sdk | plugins | auth | catalog | cart |
          checkout | customer | notification | orders | payments | shipping | tax |
          audit | settings | repo | deps | ci | docs   (or omitted)

  examples:
    feat(api): add inventory adjust endpoint
    fix(storefront): hero image CLS on mobile
    chore(repo): bump astro to ~5.13
EOF
  exit 1
fi

# Scope check (when present). The regex above admits any [a-z0-9, -]+
# scope; tighten to the whitelist here.
if [[ "$first_line" =~ ^[a-z]+\(([a-z0-9,\ -]+)\)!?: ]]; then
  scope="${BASH_REMATCH[1]}"
  # Multi-scope `(api, core, plugins)` — split on comma and validate each.
  IFS=',' read -ra parts <<< "$scope"
  for raw in "${parts[@]}"; do
    s="${raw// /}"
    case "$s" in
      api|admin|storefront|core|sdk|plugins|auth|catalog|cart|checkout|customer|notification|orders|payments|shipping|tax|audit|settings|repo|deps|ci|docs) ;;
      *)
        echo "✖ scope '$s' is not in the whitelist" >&2
        exit 1
        ;;
    esac
  done
fi

exit 0
