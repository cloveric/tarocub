#!/usr/bin/env bash
set -euo pipefail

PROMPT="${1:-reply with exactly OK and nothing else}"

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found on PATH." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH." >&2
  exit 1
fi

echo "[1/3] Checking Claude auth status..."
STATUS_JSON="$(claude auth status)"
printf '%s' "$STATUS_JSON" | node -e '
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    raw += chunk;
  });
  process.stdin.on("end", () => {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.loggedIn === true) {
        process.exit(0);
      }
    } catch {}
    process.exit(1);
  });
' || {
  echo "Claude auth status does not report loggedIn=true." >&2
  exit 1
}

echo "[2/3] Checking current shell Claude prompt..."
claude -p "$PROMPT" >/tmp/cc-telegram-bridge-claude-shell-smoke.txt
if [[ ! -s /tmp/cc-telegram-bridge-claude-shell-smoke.txt ]]; then
  echo "Foreground Claude smoke returned empty output." >&2
  exit 1
fi

echo "[3/3] Checking minimal bot-style environment..."
BOT_ENV=("HOME=$HOME" "PATH=$PATH")
if [[ -n "${USER:-}" ]]; then
  BOT_ENV+=("USER=$USER")
fi
if [[ -n "${CODEX_HOME:-}" ]]; then
  BOT_ENV+=("CODEX_HOME=$CODEX_HOME")
fi
if [[ -n "${CLAUDE_CONFIG_DIR:-}" ]]; then
  BOT_ENV+=("CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR")
fi

env -i "${BOT_ENV[@]}" claude -p "$PROMPT" >/tmp/cc-telegram-bridge-claude-bot-smoke.txt
if [[ ! -s /tmp/cc-telegram-bridge-claude-bot-smoke.txt ]]; then
  echo "Minimal bot-style Claude smoke returned empty output." >&2
  exit 1
fi

echo "Claude auth smoke passed."
