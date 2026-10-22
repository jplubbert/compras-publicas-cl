#!/usr/bin/env bash
# Plan critique gate for a plan outside an autopilot run (DEC-010 point 8), e.g. the spec cut of /analista:
#
#   scripts/critic-gate.sh plans/<name>.md [--previous ID,…]
#
# Runs only the critic role of scripts/autopilot.sh (same adapter, profile, checks and rules as the plan gate) on that
# plan, which must have the fixed sections of DEC-010 ("# Plan de <name>", Objetivo, Pasos, Archivos, Supuestos,
# Riesgos, Verificación). Round 2: pass with --previous the blocking finding ids of round 1 (the critic gets only the
# ids). Prints the checked verdict as JSON on stdout and a summary on stderr. Exit codes: 0 APROBAR, 1 REVISAR (fix the
# plan and run round 2), 3 ESCALAR (also REVISAR in round 2, or a blocking id repeated: the user decides), 2 error.
# It needs no clean tree and writes nothing outside .autopilot/critique-<date>/.
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/autopilot.sh" --critique "$@"
