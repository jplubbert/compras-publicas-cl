#!/usr/bin/env bash
# Builds the pull request comment for a `terraform plan` of infra/main (REQ-002). Writes Markdown to stdout; no network.
#
#   scripts/ci/plan-comment.sh <plan-output-file> > comment.md
#
# Exit 2 without an argument or when the file does not exist, 1 when the output has neither a "Plan:" line nor
# "No changes.", otherwise 0.
set -euo pipefail

MAX_CHARS=60000

[ $# -eq 1 ] && [ -f "$1" ] || { echo "usage: scripts/ci/plan-comment.sh <plan-output-file>" >&2; exit 2; }
file=$1

summary=$(grep -m1 -E '^Plan: [0-9]+ to add, [0-9]+ to change, [0-9]+ to destroy\.' "$file" || true)
[ -n "$summary" ] || summary=$(grep -m1 -F 'No changes.' "$file" || true)
[ -n "$summary" ] || { echo "plan-comment: no plan summary found" >&2; exit 1; }
outputs=$(grep -m1 -F 'Changes to Outputs:' "$file" || true)

body=$(cat "$file")
note=""
if [ "${#body}" -gt "$MAX_CHARS" ]; then
  body=${body: -$MAX_CHARS}
  note="(salida recortada)"
fi

echo "<!-- tf-plan:infra/main -->"
echo "### terraform plan · infra/main"
echo
echo "$summary"
[ -z "$outputs" ] || echo "$outputs"
echo
echo "<details><summary>Salida completa</summary>"
echo
[ -z "$note" ] || { echo "$note"; echo; }
echo '```'
echo "$body"
echo '```'
echo
echo "</details>"
