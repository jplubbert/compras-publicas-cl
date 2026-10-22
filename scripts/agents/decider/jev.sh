#!/usr/bin/env bash
# Jev adapter of the port decide (DEC-015, DEC-013): one closed question to TypeSafe's Jev, translated both ways. No
# policy lives here: thresholds, escalation and what the answer means are the core's (scripts/lib/decide.mjs) and the
# orchestrator's.
#
#   scripts/agents/decider/jev.sh < question.json
#
# stdin: {"id", "state", "instructions", "options": {"<name>": "<description>"}}
# stdout: {"answer", "confidence", "probabilities", "usage", "model"}; model is the response's "model", the version
# that answered; any failure exits 1 with the reason on stderr.
# Environment: TYPESAFE_API_KEY (required; from the local configuration, never passed to agents), JEV_MODEL
# (default jev-1.13.0: pinned, DEC-025; it is what jev-latest resolved to on 2026-10-21; move it by hand after
# scripts/agents/decider/jev-smoke.sh), TYPESAFE_API_URL (default https://api.typesafe.ai/v1/systemone).
# API: https://docs.typesafe.ai/api.md (a "choice" question: criteria = the options; the answer has choice, confidence
# and probabilities).
set -euo pipefail

if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  echo "jev: TYPESAFE_API_KEY is not set (local configuration)" >&2
  exit 1
fi
question=$(cat)
body=$(node -e '
  const q = JSON.parse(process.argv[1]);
  console.log(JSON.stringify({ model: process.argv[2], state: q.state,
    questions: { [q.id]: { type: "choice", instructions: q.instructions, criteria: q.options } } }));' "$question" "${JEV_MODEL:-jev-1.13.0}")
# curl prints the body, then the HTTP status on its own line. The key goes in a header read from a file descriptor, so it
# never shows in the process list.
response=$(printf '%s' "$body" | curl -sS --max-time 60 -X POST "${TYPESAFE_API_URL:-https://api.typesafe.ai/v1/systemone}" \
  -H @<(printf 'Authorization: Bearer %s\n' "$TYPESAFE_API_KEY") -H 'Content-Type: application/json' --data-binary @- \
  -w '\n%{http_code}') || {
  echo "jev: the request failed (network)" >&2
  exit 1
}
status=${response##*$'\n'}
payload=${response%$'\n'*}
if [ "$status" != 200 ]; then
  echo "jev: HTTP $status: $(printf '%s' "$payload" | head -c 300)" >&2
  exit 1
fi
node -e '
  const [payload, id] = process.argv.slice(1);
  let r;
  try { r = JSON.parse(payload); } catch { console.error("jev: the answer is not JSON"); process.exit(1); }
  const a = r.answers?.[id];
  if (!a || typeof a.choice !== "string") { console.error(`jev: the answer has no choice for ${id}`); process.exit(1); }
  console.log(JSON.stringify({ answer: a.choice, confidence: a.confidence, probabilities: a.probabilities ?? null, usage: r.usage ?? null,
    model: r.model ?? null }));' \
  "$payload" "$(node -e 'console.log(JSON.parse(process.argv[1]).id)' "$question")"
