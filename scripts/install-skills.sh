#!/usr/bin/env bash
# Install every vendored TaroCub agent skill (skills/*/SKILL.md) into the user-level
# Claude Code and Codex skill dirs, so every bot — including newly-created instances —
# inherits it. Idempotent; safe to re-run.
#
# This copies the skill *docs*. One skill (scrapling) additionally needs runtime
# prerequisites (a Python venv, browser deps, a PATH symlink) — for that one run
# scripts/install-scrapling.sh, which also re-copies its doc.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

shopt -s nullglob
installed=0
for skill_dir in "$REPO_DIR"/skills/*/; do
  [ -f "${skill_dir}SKILL.md" ] || continue
  name="$(basename "$skill_dir")"
  for engine in "$HOME/.claude/skills" "$HOME/.codex/skills"; do
    mkdir -p "$engine/$name"
    cp "${skill_dir}SKILL.md" "$engine/$name/SKILL.md"
  done
  echo "[skills] installed: $name"
  installed=$((installed + 1))
done

echo "[skills] done — $installed skill(s) copied into ~/.claude/skills and ~/.codex/skills."
echo "[skills] note: 'scrapling' also needs runtime deps — run: bash scripts/install-scrapling.sh"
