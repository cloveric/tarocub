#!/usr/bin/env bash
set -euo pipefail

umask 077
base_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="$base_dir/.env.local"
force=0

if [[ ${1:-} == "--force" ]]; then
  force=1
  shift
fi
if [[ $# -ne 0 ]]; then
  printf 'Usage: bash configure_env.sh [--force]\n' >&2
  exit 2
fi
if [[ -s "$env_file" && $force -ne 1 ]]; then
  printf 'Refusing to overwrite existing credentials: %s\n' "$env_file" >&2
  printf 'Rerun with --force only when you intend to replace them.\n' >&2
  exit 2
fi

read_required() {
  local prompt="$1"
  local value=""
  while [[ -z "$value" ]]; do
    read -r -p "$prompt: " value
  done
  printf '%s' "$value"
}

access_key_id="$(read_required "ALIBABA_CLOUD_ACCESS_KEY_ID")"
read -r -s -p "ALIBABA_CLOUD_ACCESS_KEY_SECRET: " access_key_secret
printf '\n'
if [[ -z "$access_key_secret" ]]; then
  printf 'AccessKey Secret must not be empty.\n' >&2
  exit 1
fi
app_key="$(read_required "TINGWU_APP_KEY")"
oss_bucket="$(read_required "OSS_BUCKET")"
read -r -p "OSS_ENDPOINT [https://oss-cn-beijing.aliyuncs.com]: " oss_endpoint
read -r -p "OSS_PREFIX [tingwu-upload/]: " oss_prefix
oss_endpoint="${oss_endpoint:-https://oss-cn-beijing.aliyuncs.com}"
oss_prefix="${oss_prefix:-tingwu-upload/}"

cat > "$env_file" <<EOF
ALIBABA_CLOUD_ACCESS_KEY_ID=$access_key_id
ALIBABA_CLOUD_ACCESS_KEY_SECRET=$access_key_secret
TINGWU_APP_KEY=$app_key
OSS_BUCKET=$oss_bucket
OSS_ENDPOINT=$oss_endpoint
OSS_PREFIX=$oss_prefix
EOF

chmod 600 "$env_file"
printf 'Saved credentials to %s (mode 600).\n' "$env_file"
printf 'Do not copy this file into a TaroCub workspace or Git repository.\n'
