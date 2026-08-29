#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
PREFIX="deepseek-harness-plugin"

usage() {
  cat <<'EOF'
Usage:
  scripts/publish-deepseek-harness-plugin.sh --split-only
  scripts/publish-deepseek-harness-plugin.sh <git-remote-or-url> [branch]

Verifies the canonical plugin, creates a git subtree split, and optionally
pushes that exact split to an explicitly supplied standalone repository.
EOF
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage >&2
  exit 64
fi

if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  echo "Refusing to publish from a dirty worktree." >&2
  exit 1
fi

MODE="$1"
BRANCH="${2:-main}"

npm --prefix "$ROOT/$PREFIX" ci
npm --prefix "$ROOT/$PREFIX" run verify
SPLIT_COMMIT="$(git -C "$ROOT" subtree split --prefix="$PREFIX")"

if [[ "$MODE" == "--split-only" ]]; then
  printf '%s\n' "$SPLIT_COMMIT"
  exit 0
fi

git -C "$ROOT" push "$MODE" "$SPLIT_COMMIT:refs/heads/$BRANCH"
printf 'Published %s to %s (%s).\n' "$SPLIT_COMMIT" "$MODE" "$BRANCH"
