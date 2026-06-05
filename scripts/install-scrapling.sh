#!/usr/bin/env bash
# Install the Scrapling web-scraping skill for TaroCub's Claude + Codex bots.
#
# Scrapling is an anti-bot scraper (Cloudflare/Turnstile bypass, stealth + JS-render
# + spider). It is wired as a CLI SKILL, NOT an MCP: a Python venv, a PATH symlink,
# and a SKILL.md copied into the USER-LEVEL Claude and Codex skill dirs — so every
# bot, including newly-created instances, inherits it with zero per-instance setup.
#
# Idempotent; safe to re-run.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Dir name is historical (it was first set up for an MCP server; we settled on the CLI).
VENV="${SCRAPLING_VENV:-$HOME/projects/scrapling-mcp/venv}"
# Directory on the bots' PATH to symlink `scrapling` into. Honor an explicit override,
# else pick the first existing + writable of: Homebrew (Apple Silicon), /usr/local/bin
# (Intel / older Homebrew), then ~/.local/bin as a no-permission fallback.
BIN_DIR="${SCRAPLING_BIN_DIR:-}"
if [ -z "$BIN_DIR" ]; then
  for candidate in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
    if [ -d "$candidate" ] && [ -w "$candidate" ]; then BIN_DIR="$candidate"; break; fi
  done
  BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
fi

echo "[scrapling] venv: $VENV"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q "scrapling[fetchers]"
# Browser deps (Camoufox for stealth, Playwright for dynamic). Needed by stealthy-fetch / fetch.
"$VENV/bin/scrapling" install || echo "[scrapling] WARN: 'scrapling install' (browser deps) failed — stealth/dynamic fetchers may not work"

echo "[scrapling] symlinking 'scrapling' into $BIN_DIR"
mkdir -p "$BIN_DIR"
ln -sf "$VENV/bin/scrapling" "$BIN_DIR/scrapling"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "[scrapling] NOTE: $BIN_DIR is not on PATH — add it (e.g. in ~/.zshrc) so 'scrapling' resolves" ;;
esac

echo "[scrapling] installing the skill for Claude + Codex"
for dir in "$HOME/.claude/skills/scrapling" "$HOME/.codex/skills/scrapling"; do
  mkdir -p "$dir"
  cp "$REPO_DIR/skills/scrapling/SKILL.md" "$dir/SKILL.md"
done

echo "[scrapling] done. Verify: scrapling extract get https://example.com /tmp/t.md && head /tmp/t.md"
