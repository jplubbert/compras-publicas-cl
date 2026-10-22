#!/usr/bin/env bash
# Runs a command with the project-local toolchain only (R-01): node, npm, terraform, uv and python come from .tools/,
# never from the global PATH.
#
#   scripts/env.sh <command> [args…]
#
# In a git worktree without its own .tools/ (autopilot runs), it uses the .tools/ of the main checkout.
# Exit 1 if no complete .tools/ is found (run scripts/setup.sh), 2 without a command.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[ $# -gt 0 ] || { echo "usage: scripts/env.sh <command> [args...]" >&2; exit 2; }

TOOLS="$ROOT/.tools"
if [ ! -f "$TOOLS/.setup-ok" ] && common=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
  main=$(dirname "$common")
  [ -f "$main/.tools/.setup-ok" ] && TOOLS="$main/.tools"
fi
if [ ! -x "$TOOLS/bin/mise" ] || [ ! -f "$TOOLS/.setup-ok" ]; then
  echo ".tools/ is missing or incomplete; run scripts/setup.sh" >&2
  exit 1
fi

export MISE_DATA_DIR="$TOOLS/mise" MISE_CONFIG_DIR="$TOOLS/mise-config" MISE_CACHE_DIR="$TOOLS/cache/mise"
export MISE_STATE_DIR="$TOOLS/state/mise" MISE_CEILING_PATHS="$(dirname "$ROOT")" MISE_TRUSTED_CONFIG_PATHS="$ROOT"
export MISE_EXEC_AUTO_INSTALL=false MISE_YES=1 MISE_LOCKED=1
export MISE_SYSTEM_DIR="$TOOLS/mise-system" MISE_GLOBAL_CONFIG_FILE="$TOOLS/mise-config/config.toml"
export UV_PYTHON_DOWNLOADS=never UV_PYTHON_PREFERENCE=only-system UV_CACHE_DIR="$TOOLS/cache/uv"
export npm_config_cache="$TOOLS/cache/npm" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
export CHECKPOINT_DISABLE=1 TF_IN_AUTOMATION=1 TF_CLI_CONFIG_FILE="$TOOLS/terraform.rc" TF_PLUGIN_DIR="$TOOLS/providers"
export COMPRAS_TOOLS="$TOOLS" COMPRAS_ENV=1
# Offline unless setup.sh asks otherwise: a verify never downloads (DEC-005).
[ "${COMPRAS_ONLINE:-}" = 1 ] || export UV_OFFLINE=1 npm_config_offline=true
export PATH=/usr/bin:/bin

case "$PWD/" in "$ROOT"/*) ;; *) cd "$ROOT" ;; esac
exec "$TOOLS/bin/mise" exec -- "$@"
