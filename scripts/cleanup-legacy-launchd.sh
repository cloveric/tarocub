#!/usr/bin/env bash
set -euo pipefail

HOME_DIR="${HOME:-${USERPROFILE:-}}"
if [[ -z "${HOME_DIR}" ]]; then
  echo "HOME or USERPROFILE is required." >&2
  exit 1
fi

LAUNCH_AGENTS_DIR="${HOME_DIR}/Library/LaunchAgents"
LABEL_PREFIX="com.cloveric.cc-telegram-bridge."
DOMAIN="gui/$(id -u)"

cleanup_one() {
  local instance="$1"
  local plist="${LAUNCH_AGENTS_DIR}/${LABEL_PREFIX}${instance}.plist"
  launchctl bootout "${DOMAIN}" "${plist}" >/dev/null 2>&1 || true
  rm -f "${plist}"
  echo "Removed legacy launchd plist for instance \"${instance}\"."
}

if [[ "${1:-}" == "--all" ]]; then
  shopt -s nullglob
  found=0
  for plist in "${LAUNCH_AGENTS_DIR}"/${LABEL_PREFIX}*.plist; do
    found=1
    filename="$(basename "${plist}" .plist)"
    instance="${filename#${LABEL_PREFIX}}"
    instance="${instance%.plist}"
    cleanup_one "${instance}"
  done
  if [[ "${found}" -eq 0 ]]; then
    echo "No legacy launchd plists found."
  fi
  exit 0
fi

INSTANCE="${1:-}"
if [[ -z "${INSTANCE}" ]]; then
  echo "Usage: bash scripts/cleanup-legacy-launchd.sh <instance> | --all" >&2
  exit 1
fi

cleanup_one "${INSTANCE}"
