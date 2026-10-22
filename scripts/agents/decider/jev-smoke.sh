#!/usr/bin/env bash
# Live check of the Jev adapter (verify_integration of T-33; it calls the TypeSafe API, so it needs TYPESAFE_API_KEY
# and the user's approval): the two live tests of jev-smoke.test.mjs. Without TYPESAFE_API_KEY in the environment it
# loads AUTOPILOT_SECRETS (default ~/.config/autopilot/secrets.sh), like the orchestrator; it never prints the key. Exit 0 = the adapter, the API
# contract and the key work.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  secrets=${AUTOPILOT_SECRETS:-${XDG_CONFIG_HOME:-$HOME/.config}/autopilot/secrets.sh}
  # shellcheck source=/dev/null
  if [ -r "$secrets" ]; then . "$secrets"; fi
fi
[ -n "${TYPESAFE_API_KEY:-}" ] || { echo "jev-smoke: no TYPESAFE_API_KEY (environment or $secrets)" >&2; exit 1; }
export TYPESAFE_API_KEY   # only to the decider below
node --test "$ROOT/scripts/agents/decider/jev-smoke.test.mjs"
