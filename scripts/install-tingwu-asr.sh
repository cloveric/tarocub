#!/usr/bin/env bash
set -euo pipefail

umask 077
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
source_dir="$repo_root/integrations/tingwu-asr"
target_dir="$HOME/.tarocub-secrets/tingwu_asr"
install_deps=1

usage() {
  cat <<'EOF'
Usage: bash scripts/install-tingwu-asr.sh [--dir <absolute-path>] [--no-deps]

Installs TaroCub's official shared Tingwu adapter. It never copies or
overwrites .env.local credentials.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      target_dir="$2"
      shift 2
      ;;
    --no-deps)
      install_deps=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$target_dir" = /* ]] || {
  printf 'Target must be an absolute path: %s\n' "$target_dir" >&2
  exit 2
}

refuse_workspace_target() {
  case "$1" in
    */.cctb/*/workspace|*/.cctb/*/workspace/*)
      printf 'Refusing to place cloud credentials inside an engine workspace: %s\n' "$1" >&2
      exit 2
      ;;
  esac
}

refuse_workspace_target "$target_dir"

[[ -f "$source_dir/tingwu_transcribe.py" ]] || {
  printf 'Official adapter source is missing: %s\n' "$source_dir" >&2
  exit 1
}

mkdir -p "$target_dir"
target_dir="$(cd "$target_dir" && pwd -P)"
refuse_workspace_target "$target_dir"
[[ "$target_dir" != "$source_dir" ]] || {
  printf 'Refusing to install the shared adapter over its repository source: %s\n' "$target_dir" >&2
  exit 2
}
chmod 700 "$target_dir"
install -m 600 "$source_dir/tingwu_transcribe.py" "$target_dir/tingwu_transcribe.py"
install -m 600 "$source_dir/requirements.txt" "$target_dir/requirements.txt"
install -m 700 "$source_dir/configure_env.sh" "$target_dir/configure_env.sh"
install -m 600 "$source_dir/.env.example" "$target_dir/.env.example"
install -m 600 "$source_dir/README.md" "$target_dir/README.md"
install -m 600 "$source_dir/README.zh-CN.md" "$target_dir/README.zh-CN.md"

if [[ -e "$target_dir/.env.local" ]]; then
  printf 'Preserved existing credential file: %s/.env.local\n' "$target_dir"
  credential_step="Existing .env.local preserved; rerun configure_env.sh --force only to replace it."
else
  printf 'Credential file intentionally not created; run configure_env.sh next.\n'
  credential_step="bash \"$target_dir/configure_env.sh\""
fi

if [[ $install_deps -eq 1 ]]; then
  python3 -m venv "$target_dir/.venv"
  "$target_dir/.venv/bin/python" -m pip install --upgrade pip
  "$target_dir/.venv/bin/python" -m pip install -r "$target_dir/requirements.txt"
fi

cat <<EOF

Tingwu adapter installed: $target_dir
One machine uses this ONE shared directory for all TaroCub bots.

Next:
  1. $credential_step
  2. Add this absolute path to each ~/.cctb/<instance>/lark.env:
     TINGWU_ASR_DIR="$target_dir"
     ASR_CLOUD_THRESHOLD_SECONDS="900"
     ASR_CLOUD_JOB_RETENTION_DAYS="7"
  3. node dist/src/index.js lark doctor
  4. node dist/src/index.js lark service restart --all
EOF
