#!/usr/bin/env bash
# Installs the project-local toolchain into .tools/ (R-01, DEC-005). The only step that uses the network; no sudo.
#
#   scripts/setup.sh [--relock]
#
# 1. Downloads mise $MISE_VERSION to .tools/bin/mise and checks its sha256 (never uses a global mise).
# 2. --relock: rewrites mise.lock (4 platforms). Then installs the tools of mise.lock into .tools/mise.
# 3. --relock: rewrites uv.lock, dataform/package-lock.json and the .terraform.lock.hcl of infra/bootstrap and infra/main.
# 4. uv sync (whole workspace, warms the uv cache), npm ci of dataform/ (warms the npm cache), terraform providers mirror
#    into .tools/providers and terraform init -backend=false of both roots. After this, scripts/env.sh works offline.
# Idempotent.
set -euo pipefail

MISE_VERSION=2026.10.17
declare -A MISE_SHA256=(
  [linux-x64]=fe6dd17e68e09682b31d2e7bb7bb755d22636ac1af5d94621e300f2ca9e9fe8a
  [linux-arm64]=e90904144ba4377c5fbe385f429830282c68f3b4f9c690bf6c5a2ae9b74a809b
  [macos-x64]=dac5d6db5e315d8e4f096c6ead9279d342e09fdcb5c373d0df5c7dcce8195746
  [macos-arm64]=9e27709db5eb1e900d83149418d3067309f2a5004d4994d94246ab658ba4a3ce
)
TF_ROOTS=(infra/bootstrap infra/main)

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TOOLS="$ROOT/.tools"
RELOCK=0
case "${1:-}" in --relock) RELOCK=1 ;; "") ;; *) echo "usage: scripts/setup.sh [--relock]" >&2; exit 2 ;; esac
cd "$ROOT"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) PLATFORM=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) PLATFORM=linux-arm64 ;;
  Darwin-x86_64) PLATFORM=macos-x64 ;;
  Darwin-arm64) PLATFORM=macos-arm64 ;;
  *) echo "setup: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

mkdir -p "$TOOLS/bin"
if [ ! -x "$TOOLS/bin/mise" ] || [ "$(sha256 "$TOOLS/bin/mise")" != "${MISE_SHA256[$PLATFORM]}" ]; then
  echo "setup: downloading mise $MISE_VERSION ($PLATFORM)"
  tmp=$(mktemp "$TOOLS/bin/mise.XXXXXX")
  curl -fsSL -o "$tmp" "https://github.com/jdx/mise/releases/download/v$MISE_VERSION/mise-v$MISE_VERSION-$PLATFORM"
  if [ "$(sha256 "$tmp")" != "${MISE_SHA256[$PLATFORM]}" ]; then
    rm -f "$tmp"; echo "setup: sha256 mismatch for mise $MISE_VERSION ($PLATFORM)" >&2; exit 1
  fi
  chmod +x "$tmp"; mv "$tmp" "$TOOLS/bin/mise"
fi

rm -f "$TOOLS/.setup-ok"
export MISE_DATA_DIR="$TOOLS/mise" MISE_CONFIG_DIR="$TOOLS/mise-config" MISE_CACHE_DIR="$TOOLS/cache/mise"
export MISE_STATE_DIR="$TOOLS/state/mise" MISE_CEILING_PATHS="$(dirname "$ROOT")" MISE_TRUSTED_CONFIG_PATHS="$ROOT"
export MISE_YES=1 MISE_SYSTEM_DIR="$TOOLS/mise-system" MISE_GLOBAL_CONFIG_FILE="$TOOLS/mise-config/config.toml"
printf 'provider_installation {\n  filesystem_mirror {\n    path = "%s"\n  }\n}\n' "$TOOLS/providers" >"$TOOLS/terraform.rc"

if [ "$RELOCK" = 1 ]; then
  "$TOOLS/bin/mise" lock --platform linux-x64,linux-arm64,macos-x64,macos-arm64
fi
MISE_LOCKED=1 "$TOOLS/bin/mise" install
touch "$TOOLS/.setup-ok"

env_online() { COMPRAS_ONLINE=1 "$ROOT/scripts/env.sh" "$@"; }
if [ "$RELOCK" = 1 ]; then
  env_online uv lock
  env_online npm install --package-lock-only --prefix dataform
  for r in "${TF_ROOTS[@]}"; do
    env_online env -u TF_CLI_CONFIG_FILE terraform -chdir="$r" providers lock \
      -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_amd64 -platform=darwin_arm64
  done
fi
env_online uv sync --all-packages --locked
env_online npm ci --prefix dataform
for r in "${TF_ROOTS[@]}"; do
  # `providers mirror` needs the local modules resolved first (a fresh clone has no .terraform/modules).
  env_online env -u TF_CLI_CONFIG_FILE terraform -chdir="$r" get >/dev/null
  env_online env -u TF_CLI_CONFIG_FILE terraform -chdir="$r" providers mirror "$TOOLS/providers"
  "$ROOT/scripts/env.sh" terraform -chdir="$r" init -backend=false -input=false -plugin-dir="$TOOLS/providers" >/dev/null
done
"$ROOT/scripts/env.sh" bash -c 'terraform version | head -1; uv --version; python --version; node --version'
echo "setup: ok"
